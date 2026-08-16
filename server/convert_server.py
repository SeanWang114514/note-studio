# -*- coding: utf-8 -*-
"""
笔记工作台 本地转换服务
======================
把浏览器里做不了的 PDF<->DOCX 转换放到本地 Python 进程：
  * POST /api/pdf2docx   PDF 字节  -> DOCX 字节   （pdf2docx-plus）
  * POST /api/docx2pdf   DOCX 字节 -> PDF 字节    （docx2pdf，走本机 Word）
  * GET  /health         健康检查 / 版本信息

启动：python server/convert_server.py [--port 5198]
默认监听 127.0.0.1:5198，带 CORS，供 http://127.0.0.1:5199 的页面直接调用。
"""
import argparse
import io
import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

warnings.filterwarnings("ignore", category=DeprecationWarning)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("convert-server")

try:
    import pdf2docx_plus  # noqa: F401  (仅用于版本/可用性检测；转换在 convert_worker.py 子进程执行)
except Exception as e:  # noqa: BLE001
    PDF2DOCX_OK_IMPORT = False
else:
    PDF2DOCX_OK_IMPORT = True

# PDF->DOCX 图片保真开关（默认开启，可用环境变量关闭）：
#   NF_RECOVER_MISSING_IMAGES=0   关闭"缺失图片恢复"（修复复用图片对象被丢图，如每页重复 logo）
#   NF_RASTERIZE_VECTORS=0        关闭"矢量图形栅格化"（修复图表/图示等矢量图整块消失）
def _env_flag(name, default=True):
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() not in ("0", "false", "no", "off")

_RECOVER_MISSING_IMAGES = _env_flag("NF_RECOVER_MISSING_IMAGES", True)
_RASTERIZE_VECTORS = _env_flag("NF_RASTERIZE_VECTORS", True)

try:
    import docx2pdf  # noqa: F401  (转换时使用)
except Exception as e:  # noqa: BLE001
    DOCX2PDF_OK_IMPORT = False
else:
    DOCX2PDF_OK_IMPORT = True

try:
    from importlib.metadata import version as _pkg_ver
    PDF2DOCX_VER = _pkg_ver("pdf2docx-plus")
except Exception as e:  # noqa: BLE001
    PDF2DOCX_VER = f"missing ({e})"
PDF2DOCX_OK = PDF2DOCX_OK_IMPORT and not PDF2DOCX_VER.startswith("missing")

try:
    from importlib.metadata import version as _pkg_ver2
    DOCX2PDF_VER = _pkg_ver2("docx2pdf")
except Exception as e:  # noqa: BLE001
    DOCX2PDF_VER = f"missing ({e})"
DOCX2PDF_OK = DOCX2PDF_OK_IMPORT and not DOCX2PDF_VER.startswith("missing")

try:
    import win32com.client  # noqa: F401  (docx2pdf 在 Windows 上依赖 pywin32)
    WIN32_OK = True
except Exception:  # noqa: BLE001
    WIN32_OK = False

_MAX_BODY = 256 * 1024 * 1024  # 256MB 上限
_docx2pdf_lock = threading.Lock()
# 转换在独立子进程(convert_worker.py)中执行：进程级隔离，卡死可整体 kill，
# 不会像线程那样留下孤儿线程把服务器进程拖死；并发请求各自独立互不阻塞。
_WORKER_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "convert_worker.py")
_PDF2DOCX_TIMEOUT_S = float(os.environ.get("NF_PDF2DOCX_TIMEOUT_S", "180"))  # 单次转换超时上限

# ---- 转换进度（job 维度）----
# 每个转换请求带一个 job id（?job=xxx），worker/服务端把进度写成 JSON 文件，
# 浏览器在 POST 进行期间并行轮询 GET /api/progress/<job> 拿百分比与阶段文字。
_PROGRESS_DIR = os.path.join(tempfile.gettempdir(), "nf-convert-progress")


def _progress_path(job_id):
    return os.path.join(_PROGRESS_DIR, f"{job_id}.json")


def _write_progress(job_id, payload):
    try:
        os.makedirs(_PROGRESS_DIR, exist_ok=True)
        tmp = _progress_path(job_id) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp, _progress_path(job_id))
    except Exception:  # noqa: BLE001
        pass


def _read_progress(job_id):
    try:
        with open(_progress_path(job_id), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return None


def _cleanup_progress(job_id):
    try:
        os.remove(_progress_path(job_id))
    except Exception:  # noqa: BLE001
        pass


def _sweep_stale_progress(max_age_s=7200):
    """清理长时间没被删的进度文件（进程崩溃残留）。"""
    try:
        if not os.path.isdir(_PROGRESS_DIR):
            return
        now = time.time()
        for name in os.listdir(_PROGRESS_DIR):
            p = os.path.join(_PROGRESS_DIR, name)
            try:
                if now - os.path.getmtime(p) > max_age_s:
                    os.remove(p)
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        pass


class Handler(BaseHTTPRequestHandler):
    server_version = "note-studio-convert/1.0"

    # ---- CORS ----
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, code, ctype, data):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > _MAX_BODY:
            raise ValueError(f"非法请求体长度: {length}")
        return self.rfile.read(length)

    @staticmethod
    def _is_broken_conn(e):
        # 客户端在中途断开（关标签页/刷新/取消请求），属正常现象，不必当错误上报
        return isinstance(e, (ConnectionAbortedError, ConnectionResetError, BrokenPipeError))

    @staticmethod
    def _job_id_from_path(path):
        """从查询串里取 ?job=xxx（无则 None，调用方再随机生成）。"""
        q = path.split("?", 1)
        if len(q) < 2:
            return None
        for part in q[1].split("&"):
            k, _, v = part.partition("=")
            if k == "job" and v:
                return v[:64]
        return None

    def log_message(self, fmt, *args):  # 安静一点
        log.info("%s %s", self.address_string(), fmt % args)

    # ---- 路由 ----
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/health":
            self._send_json(200, {
                "ok": True,
                "pdf2docx": PDF2DOCX_VER,
                "docx2pdf": DOCX2PDF_VER,
                "win32": WIN32_OK,
                "word": _word_available(),
            })
        elif path.startswith("/api/progress/"):
            job = path[len("/api/progress/"):]
            data = _read_progress(job)
            if data is None:
                self._send_json(404, {"error": "no progress for job"})
            else:
                self._send_json(200, {"ok": True, **data})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            if path == "/api/pdf2docx":
                self._handle_pdf2docx()
            elif path == "/api/docx2pdf":
                self._handle_docx2pdf()
            else:
                self._send_json(404, {"error": "not found"})
        except Exception as e:  # noqa: BLE001
            if self._is_broken_conn(e):
                log.debug("客户端中断连接: %s", e)
                return
            log.error("处理失败: %s\n%s", e, traceback.format_exc())
            try:
                self._send_json(500, {"error": str(e)[:500]})
            except Exception:  # noqa: BLE001
                pass

    def _handle_pdf2docx(self):
        if not PDF2DOCX_OK:
            self._send_json(500, {"error": "pdf2docx-plus 未安装：pip install pdf2docx-plus"})
            return
        job = self._job_id_from_path(self.path) or uuid.uuid4().hex
        data = self._read_body()
        with tempfile.TemporaryDirectory(prefix="nf-pdf2docx-") as td:
            pdf_path = os.path.join(td, "input.pdf")
            docx_path = os.path.join(td, "output.docx")
            with open(pdf_path, "wb") as f:
                f.write(data)
            timeout_s = _PDF2DOCX_TIMEOUT_S
            worker_err = os.path.join(
                os.path.dirname(_WORKER_PY), "..", "logs", "convert-worker.err.log"
            )
            os.makedirs(os.path.dirname(worker_err), exist_ok=True)
            progress_file = _progress_path(job)
            _write_progress(job, {"percent": 1, "stage": "准备转换…", "done": 0, "total": 0})
            try:
                with open(worker_err, "ab") as errf:
                    proc = subprocess.Popen(
                        [sys.executable, _WORKER_PY, pdf_path, docx_path,
                         "1" if _RECOVER_MISSING_IMAGES else "0",
                         "1" if _RASTERIZE_VECTORS else "0",
                         progress_file],
                        stdout=subprocess.DEVNULL,
                        stderr=errf,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                        cwd=os.path.dirname(_WORKER_PY),
                    )
                    try:
                        rc = proc.wait(timeout=timeout_s)
                    except subprocess.TimeoutExpired:
                        try:
                            proc.kill()
                            proc.wait(timeout=10)
                        except Exception:  # noqa: BLE001
                            pass
                        raise RuntimeError(f"转换超时（>{int(timeout_s)}s），已终止。文件可能过大或结构异常，请重试")
                if rc != 0 or not os.path.exists(docx_path) or os.path.getsize(docx_path) == 0:
                    raise RuntimeError(f"pdf2docx 转换失败（退出码 {rc}）")
                with open(docx_path, "rb") as f:
                    out = f.read()
            finally:
                _cleanup_progress(job)
        log.info("pdf2docx: %d -> %d bytes", len(data), len(out))
        self._send_bytes(200, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", out)

    def _handle_docx2pdf(self):
        if not DOCX2PDF_OK:
            self._send_json(500, {"error": "docx2pdf 未安装：pip install docx2pdf（需本机安装 Word）"})
            return
        job = self._job_id_from_path(self.path) or uuid.uuid4().hex
        data = self._read_body()
        _write_progress(job, {"percent": 5, "stage": "正在准备…", "done": 0, "total": 0})
        try:
            with _docx2pdf_lock:
                # ThreadingHTTPServer 每个请求在新线程，Word COM 必须先 CoInitialize
                try:
                    import pythoncom
                    pythoncom.CoInitialize()
                except Exception:  # noqa: BLE001
                    pass
                try:
                    _write_progress(job, {"percent": 18, "stage": "正在启动 Word…", "done": 0, "total": 0})
                    with tempfile.TemporaryDirectory(prefix="nf-docx2pdf-") as td:
                        docx_path = os.path.join(td, "input.docx")
                        pdf_path = os.path.join(td, "output.pdf")
                        with open(docx_path, "wb") as f:
                            f.write(data)
                        _write_progress(job, {"percent": 40, "stage": "正在用 Word 生成 PDF…", "done": 0, "total": 0})
                        docx2pdf.convert(docx_path, pdf_path)
                        if not os.path.exists(pdf_path) or os.path.getsize(pdf_path) == 0:
                            raise RuntimeError("docx2pdf 转换失败：未生成 PDF（请确认已安装 Microsoft Word）")
                        _write_progress(job, {"percent": 90, "stage": "正在写出 PDF…", "done": 0, "total": 0})
                        with open(pdf_path, "rb") as f:
                            out = f.read()
                finally:
                    try:
                        import pythoncom
                        pythoncom.CoUninitialize()
                    except Exception:  # noqa: BLE001
                        pass
        finally:
            _cleanup_progress(job)
        log.info("docx2pdf: %d -> %d bytes", len(data), len(out))
        self._send_bytes(200, "application/pdf", out)


def _word_available():
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, r"Word.Application\CurVer"):
            return True
    except Exception:  # noqa: BLE001
        return False


def main():
    ap = argparse.ArgumentParser(description="PDF<->DOCX 本地转换服务")
    ap.add_argument("--port", type=int, default=5198)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    _sweep_stale_progress()
    log.info("pdf2docx-plus=%s docx2pdf=%s win32=%s word=%s",
             PDF2DOCX_VER, DOCX2PDF_VER, WIN32_OK, _word_available())
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    log.info("转换服务已启动: http://%s:%d  (Ctrl+C 停止)", args.host, args.port)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
