# -*- coding: utf-8 -*-
"""
笔记工作台 本地转换服务
======================
把浏览器里做不了的文档转换放到本地 Python 进程：
  * POST /api/docx2pdf   DOCX 字节 -> PDF 字节    （docx2pdf，走本机 Word）
  * POST /api/excel-edit xlsx 字节 + 单元格数据 -> xlsx 字节（openpyxl 修改）
  * POST /api/v1/misc/flatten  Stirling-PDF 兼容的本地 PDF 定稿接口
  * GET  /health         健康检查 / 版本信息

启动：python server/convert_server.py [--port 5198]
默认监听 127.0.0.1:5198，带 CORS，供本地 Web 页面直接调用。
"""
import argparse
import base64
import io
import json
import logging
import os
import sys
import tempfile
import threading
import time
import traceback
import uuid
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import fitz  # PyMuPDF：本地 PDF 定稿/扁平化
    FITZ_VER = getattr(fitz, "__doc__", "").splitlines()[0] if getattr(fitz, "__doc__", None) else "installed"
except Exception as e:  # noqa: BLE001
    fitz = None
    FITZ_VER = f"missing ({e})"

warnings.filterwarnings("ignore", category=DeprecationWarning)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("convert-server")

try:
    import docx2pdf  # noqa: F401  (转换时使用)
except Exception as e:  # noqa: BLE001
    DOCX2PDF_OK_IMPORT = False
else:
    DOCX2PDF_OK_IMPORT = True

try:
    from importlib.metadata import version as _pkg_ver2
    DOCX2PDF_VER = _pkg_ver2("docx2pdf")
except Exception as e:  # noqa: BLE001
    DOCX2PDF_VER = f"missing ({e})"
DOCX2PDF_OK = DOCX2PDF_OK_IMPORT and not DOCX2PDF_VER.startswith("missing")

try:
    import openpyxl  # noqa: F401  (xlsx 单元格编辑)
    OPENPYXL_VER = openpyxl.__version__
    OPENPYXL_OK = True
except Exception as e:  # noqa: BLE001
    OPENPYXL_VER = f"missing ({e})"
    OPENPYXL_OK = False

try:
    import win32com.client  # noqa: F401  (docx2pdf 在 Windows 上依赖 pywin32)
    WIN32_OK = True
except Exception:  # noqa: BLE001
    WIN32_OK = False

_MAX_BODY = 256 * 1024 * 1024  # 256MB 上限
_docx2pdf_lock = threading.Lock()

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
        self.send_header("Access-Control-Expose-Headers", "X-NF-Cache-Hit")
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
                "docx2pdf": DOCX2PDF_VER,
                "openpyxl": OPENPYXL_VER,
                "win32": WIN32_OK,
                "word": _word_available(),
                "pymupdf": FITZ_VER,
                "stirling": {"local": True, "flatten": fitz is not None},
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
            if path == "/api/docx2pdf":
                self._handle_docx2pdf()
            elif path == "/api/excel-edit":
                self._handle_excel_edit()
            elif path == "/api/v1/misc/flatten":
                self._handle_stirling_flatten()
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

    def _handle_stirling_flatten(self):
        """Stirling-PDF 兼容的本地 /api/v1/misc/flatten：扁平化批注/表单后返回 PDF。"""
        if fitz is None:
            self._send_json(500, {"error": "本地 PDF 引擎不可用：请安装 PyMuPDF（pip install pymupdf）"})
            return
        raw = self._read_body()
        data = raw
        content_type = self.headers.get("Content-Type", "")
        if content_type.lower().startswith("multipart/form-data"):
            try:
                from email.parser import BytesParser
                from email.policy import default as email_policy
                envelope = (f"Content-Type: {content_type}\r\nContent-Length: {len(raw)}\r\n\r\n").encode("utf-8") + raw
                message = BytesParser(policy=email_policy).parsebytes(envelope)
                parts = message.get_payload() if message.is_multipart() else []
                for part in parts:
                    candidate = part.get_payload(decode=True)
                    if candidate and (part.get_param("name", header="content-disposition") == "fileInput" or candidate.startswith(b"%PDF")):
                        data = candidate
                        break
            except Exception as e:
                raise ValueError(f"multipart 文件解析失败: {e}")
        try:
            doc = fitz.open(stream=data, filetype="pdf")
            try:
                doc.bake(annots=True, widgets=True)
                out = doc.tobytes(garbage=4, deflate=True)
            finally:
                doc.close()
        except Exception as e:
            self._send_json(400, {"error": f"PDF 扁平化失败: {str(e)[:500]}"})
            return
        log.info("stirling-local flatten: %d -> %d bytes", len(data), len(out))
        self._send_bytes(200, "application/pdf", out)

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

    def _handle_excel_edit(self):
        """用 openpyxl 修改 xlsx 并写回（只动被编辑的单元格，保留未编辑内容/格式/多 sheet）。

        请求格式（JSON body）：
          {
            "xlsx": "<base64 原始 xlsx 字节>",
            # 方案 A（兼容旧版）：整体替换第一个工作表
            "rows": [["张三", 95], ...],
            "sheetIndex": 0,
            # 方案 B（编辑操作流，推荐）：逐格/逐行列/工作表级操作
            "wbOps": [
                {"op": "renameSheet", "sheetIndex": 0, "name": "新名字"},
                {"op": "deleteSheet", "sheetIndex": 1},
            ],
            "sheets": [
                {"sheetIndex": 0, "ops": [ {"op": "set", "r": 0, "c": 0, "v": 123, "t": "n"}, ... ]},
                {"sheetIndex": -1, "name": "新建表", "ops": [...]},   # -1 = 新建工作表
            ]
          }
        单元格操作 ops（r/c 均为 0 基）：
          set        {"op":"set","r":0,"c":0,"v":123,"t":"n"}    t: n|b|s|d|e
          insertRow  {"op":"insertRow","at":1,"amount":1}
          deleteRow  {"op":"deleteRow","at":1,"amount":1}
          insertCol  {"op":"insertCol","at":0,"amount":1}
          deleteCol  {"op":"deleteCol","at":0,"amount":1}
          merge      {"op":"merge","r1":0,"c1":0,"r2":1,"c2":1}
          unmerge    {"op":"unmerge","r1":0,"c1":0,"r2":1,"c2":1}
        响应：修改后的 xlsx 字节（二进制）。
        """
        if not OPENPYXL_OK:
            self._send_json(500, {"error": "openpyxl 未安装：pip install openpyxl"})
            return
        try:
            payload = json.loads(self._read_body().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._send_json(400, {"error": f"请求体解析失败: {e}"})
            return
        try:
            data = base64.b64decode(payload.get("xlsx") or "")
        except Exception as e:  # noqa: BLE001
            self._send_json(400, {"error": f"xlsx base64 解码失败: {e}"})
            return
        if not data:
            self._send_json(400, {"error": "缺少 xlsx 字节"})
            return
        try:
            wb = openpyxl.load_workbook(io.BytesIO(data), data_only=False)
        except Exception as e:  # noqa: BLE001
            self._send_json(400, {"error": f"xlsx 解析失败（仅支持 .xlsx 格式）: {e}"})
            return

        # ---- 方案 A：整体替换（兼容旧版）----
        rows = payload.get("rows")
        if rows is not None:
            if not isinstance(rows, list):
                self._send_json(400, {"error": "rows 必须是数组"})
                return
            try:
                sheet_index = int(payload.get("sheetIndex") or 0)
                ws = wb.worksheets[sheet_index] if sheet_index < len(wb.worksheets) else wb.active
            except Exception:  # noqa: BLE001
                ws = wb.active
            for row in ws.iter_rows(min_row=1, max_row=ws.max_row, max_col=max(ws.max_column, 1)):
                for cell in row:
                    cell.value = None
            for r, row in enumerate(rows, start=1):
                for c, value in enumerate(row, start=1):
                    ws.cell(row=r, column=c, value=value)
            buf = io.BytesIO()
            wb.save(buf)
            out = buf.getvalue()
            log.info("excel-edit: %d -> %d bytes (rows=%d)", len(data), len(out), len(rows))
            self._send_bytes(
                200, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", out
            )
            return

        # ---- 方案 B：编辑操作流 ----
        wb_ops = payload.get("wbOps") or []
        sheets = payload.get("sheets") or []
        if not isinstance(wb_ops, list) or not isinstance(sheets, list):
            self._send_json(400, {"error": "wbOps/sheets 必须是数组"})
            return
        try:
            original_count = len(wb.worksheets)
            deleted = set()
            survivors = list(range(original_count))
            for op in wb_ops:
                kind = op.get("op")
                if kind == "renameSheet":
                    idx = int(op.get("sheetIndex") or 0)
                    if idx not in survivors:
                        raise ValueError(f"工作表 {idx} 不存在或已被删除")
                    ws = wb.worksheets[survivors.index(idx)]
                    ws.title = _unique_sheet_title(wb, op.get("name") or "", exclude=idx)
                elif kind == "deleteSheet":
                    idx = int(op.get("sheetIndex") or 0)
                    if idx not in survivors:
                        raise ValueError(f"工作表 {idx} 不存在或已被删除")
                    if len(wb.worksheets) <= 1:
                        raise ValueError("至少保留一个工作表")
                    pos = survivors.index(idx)
                    deleted.add(idx)
                    wb.remove(wb.worksheets[pos])
                    survivors.pop(pos)
                else:
                    raise ValueError(f"未知工作簿操作: {kind}")
            for sheet in sheets:
                idx = sheet.get("sheetIndex")
                ops = sheet.get("ops") or []
                if not isinstance(ops, list):
                    raise ValueError("ops 必须是数组")
                if idx == -1:
                    # 新建工作表：名称由前端保证唯一，服务端再兜底
                    ws = wb.create_sheet(title=_unique_sheet_title(wb, sheet.get("name") or ""))
                else:
                    idx = int(idx or 0)
                    if idx not in survivors:
                        raise ValueError(f"工作表 {idx} 不存在或已被删除")
                    ws = wb.worksheets[survivors.index(idx)]
                for op in ops:
                    _apply_sheet_op(ws, op)
        except Exception as e:  # noqa: BLE001
            self._send_json(400, {"error": str(e)[:500]})
            return
        buf = io.BytesIO()
        wb.save(buf)
        out = buf.getvalue()
        n_ops = sum(len(s.get("ops") or []) for s in sheets)
        log.info("excel-edit: %d -> %d bytes (wbOps=%d sheetOps=%d)",
                 len(data), len(out), len(wb_ops), n_ops)
        self._send_bytes(
            200, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", out
        )


def _clean_sheet_title(title):
    """去掉 Excel 工作表名非法字符并截断（Excel 限制：<=31 字符，不能含 []:*?/\\）。"""
    t = (title or "").strip()
    for ch in r'[]:*?/\\':
        t = t.replace(ch, "")
    return t[:31].strip() or "Sheet"


def _unique_sheet_title(wb, title, exclude=None):
    """在现有工作表名中取唯一名称（同名自动追加数字）。exclude 为原索引，跳过自身。"""
    base = _clean_sheet_title(title)
    names = {ws.title for i, ws in enumerate(wb.worksheets) if i != exclude}
    if base not in names:
        return base
    i = 1
    while "{0}{1}".format(base, i) in names:
        i += 1
    return "{0}{1}".format(base, i)


def _apply_sheet_op(ws, op):
    """把一条单元格/行列操作应用到 openpyxl 工作表（r/c 均为 0 基）。"""
    kind = op.get("op")

    def target(r, c):
        return ws.cell(row=r + 1, column=c + 1)

    if kind == "set":
        r = int(op.get("r") or 0)
        c = int(op.get("c") or 0)
        v = op.get("v")
        t = op.get("t") or "s"
        if t == "e" or v is None:
            target(r, c).value = None
        elif t == "n":
            try:
                fv = float(v)
                target(r, c).value = int(fv) if fv.is_integer() else fv
            except Exception:  # noqa: BLE001
                target(r, c).value = str(v)
        elif t == "b":
            target(r, c).value = bool(v)
        elif t == "d":
            try:
                from datetime import datetime
                target(r, c).value = datetime.fromisoformat(str(v))
            except Exception:  # noqa: BLE001
                target(r, c).value = str(v)
        else:
            # 字符串；以 '=' 开头会被 openpyxl 当作公式
            target(r, c).value = str(v)
    elif kind == "insertRow":
        ws.insert_rows(int(op.get("at") or 0) + 1, max(1, int(op.get("amount") or 1)))
    elif kind == "deleteRow":
        ws.delete_rows(int(op.get("at") or 0) + 1, max(1, int(op.get("amount") or 1)))
    elif kind == "insertCol":
        ws.insert_cols(int(op.get("at") or 0) + 1, max(1, int(op.get("amount") or 1)))
    elif kind == "deleteCol":
        ws.delete_cols(int(op.get("at") or 0) + 1, max(1, int(op.get("amount") or 1)))
    elif kind == "merge":
        ws.merge_cells(
            start_row=int(op["r1"]) + 1, start_column=int(op["c1"]) + 1,
            end_row=int(op["r2"]) + 1, end_column=int(op["c2"]) + 1,
        )
    elif kind == "unmerge":
        ws.unmerge_cells(
            start_row=int(op["r1"]) + 1, start_column=int(op["c1"]) + 1,
            end_row=int(op["r2"]) + 1, end_column=int(op["c2"]) + 1,
        )
    else:
        raise ValueError("未知单元格操作: {0}".format(kind))


def _word_available():
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, r"Word.Application\CurVer"):
            return True
    except Exception:  # noqa: BLE001
        return False


def main():
    ap = argparse.ArgumentParser(description="本地文档转换服务")
    ap.add_argument("--port", type=int, default=5198)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    _sweep_stale_progress()
    log.info("docx2pdf=%s openpyxl=%s win32=%s word=%s",
             DOCX2PDF_VER, OPENPYXL_VER, WIN32_OK, _word_available())
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    log.info("转换服务已启动: http://%s:%d  (Ctrl+C 停止)", args.host, args.port)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
