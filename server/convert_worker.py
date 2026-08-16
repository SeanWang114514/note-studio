# -*- coding: utf-8 -*-
"""
pdf2docx 转换 worker（独立子进程执行）
======================================
由 convert_server.py 为每个 /api/pdf2docx 请求拉起，
进程级隔离：转换卡死/异常只影响本 worker，服务端可整个 kill 掉，
不会像进程内线程那样污染服务器进程（孤儿线程/死循环）。

用法：
    python convert_worker.py <input.pdf> <output.docx> <recover:0|1> <rasterize:0|1> [progress.json]

可选第 5 参 progress.json：worker 把转换进度写成 JSON 文件，
服务端 GET /api/progress/<job> 读取它，供浏览器轮询显示进度。
进度文件形如 {"percent": 45, "stage": "正在转换第 3/10 页…", "done": 3, "total": 10}，
percent 为 null 表示不确定进度（拿不到总页数时）。

成功：退出码 0 并生成 output.docx；失败/超时：非零退出码。
stdout/stderr 留给调用方（服务端重定向到日志）。
"""
import json
import os
import re
import sys

RECOVER = sys.argv[3] == "1"
RASTERIZE = sys.argv[4] == "1"
PROGRESS_FILE = sys.argv[5] if len(sys.argv) > 5 else ""


def _install_safe_get_images():
    """循环安全版 get_images(full=True)。

    某些 PDF（资源字典存在共享/循环引用，如部分 LaTeX/绘图工具生成的
    矢量图页面）会让 PyMuPDF 的 JM_scan_resources 对同一子资源树反复
    完整重扫，指数级递归直至挂死（实测 attention 论文第 13 页 30 次
    调用后彻底卡死）。这里按 xref 深度优先 + visited 集合去重，复刻
    full=True 语义且必然终止；输出格式与原始完全一致：
    (xref, smask, w, h, bpc, colorspace, altcs, name, filter, referencer)。
    """
    import pymupdf as _fitz  # noqa: PLC0415

    if getattr(_fitz, "_NF_SAFE_GET_IMAGES", False):
        return
    _orig = _fitz.Page.get_images

    def _to_xref(key_tuple):
        t, v = key_tuple
        if t in ("xref", "stream"):
            try:
                return int(v.split()[0])
            except Exception:  # noqa: BLE001
                return None
        return None  # dict/int/name 等内联值

    def _image_item(doc, xref, name):
        def _int(key, default=0):
            try:
                return int(doc.xref_get_key(xref, key)[1])
            except Exception:  # noqa: BLE001
                return default

        def _str(key):
            try:
                return doc.xref_get_key(xref, key)[1].lstrip("/")
            except Exception:  # noqa: BLE001
                return ""

        smask = _to_xref(doc.xref_get_key(xref, "SMask")) or 0
        return (xref, smask, _int("Width"), _int("Height"), _int("BitsPerComponent"),
                _str("ColorSpace"), "", name, _str("Filter"), 0)

    def _scan(doc, rsrc_key, out, v_rsrc, v_forms, v_imgs):
        rx = _to_xref(rsrc_key)
        if rx is None or rx in v_rsrc:
            return
        v_rsrc.add(rx)
        xobj_key = doc.xref_get_key(rx, "XObject")
        entries = []  # [(name, xref)]
        if xobj_key[0] in ("xref", "stream"):
            xobj_xref = _to_xref(xobj_key)
            if xobj_xref is None:
                return
            try:
                for name in doc.xref_get_keys(xobj_xref):
                    x = _to_xref(doc.xref_get_key(xobj_xref, name))
                    if x is not None:
                        entries.append((name, x))
            except Exception:  # noqa: BLE001
                return
        elif xobj_key[0] == "dict":
            # 内联 XObject 字典（极少见）：正则抓 /Name N 0 R
            for m in re.finditer(r"/([A-Za-z0-9._-]+)\s+(\d+)\s+0\s+R", xobj_key[1]):
                entries.append((m.group(1), int(m.group(2))))
        for name, x in entries:
            try:
                subtype = doc.xref_get_key(x, "Subtype")[1]
            except Exception:  # noqa: BLE001
                continue
            if subtype == "/Image":
                if x in v_imgs:
                    continue
                v_imgs.add(x)
                out.append(_image_item(doc, x, name))
            elif subtype == "/Form":
                if x in v_forms:
                    continue
                v_forms.add(x)
                _scan(doc, doc.xref_get_key(x, "Resources"), out, v_rsrc, v_forms, v_imgs)

    def _page_resources_inherit(doc, page_xref):
        seen = set()
        xref = page_xref
        while xref and xref not in seen:
            seen.add(xref)
            k = doc.xref_get_key(xref, "Resources")
            if k[0] in ("dict", "xref", "stream"):
                return k
            xref = _to_xref(doc.xref_get_key(xref, "Parent"))
        return ("null", "")

    def _safe_get_images(self, full=False, **kwargs):
        if not full:
            return _orig(self, full=False, **kwargs)
        doc = self.parent
        if doc is None or getattr(doc, "is_closed", False):
            return _orig(self, full=True, **kwargs)
        try:
            rsrc = _page_resources_inherit(doc, doc.page_xref(self.number))
        except Exception:  # noqa: BLE001
            return _orig(self, full=True, **kwargs)
        out = []
        try:
            _scan(doc, rsrc, out, set(), set(), set())
        except Exception:  # noqa: BLE001
            return _orig(self, full=True, **kwargs)
        return out

    _fitz.Page.get_images = _safe_get_images
    _fitz._NF_SAFE_GET_IMAGES = True


_install_safe_get_images()

in_pdf = sys.argv[1]
out_docx = sys.argv[2]


def write_progress(payload):
    """原子写进度 JSON（先写 tmp 再 replace），失败不影响转换本身。"""
    if not PROGRESS_FILE:
        return
    try:
        os.makedirs(os.path.dirname(PROGRESS_FILE), exist_ok=True)
        tmp = PROGRESS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp, PROGRESS_FILE)
    except Exception:  # noqa: BLE001
        pass


# 总页数（用于百分比；拿不到也不影响转换）
TOTAL = 0
try:
    import pymupdf

    with pymupdf.open(in_pdf) as doc:
        TOTAL = doc.page_count
except Exception:  # noqa: BLE001
    try:
        import fitz

        with fitz.open(in_pdf) as doc:
            TOTAL = doc.page_count
    except Exception:  # noqa: BLE001
        pass

write_progress({"percent": 2, "stage": "正在分析 PDF 文档…", "done": 0, "total": TOTAL})

try:
    from pdf2docx_plus import Converter as _Converter
    from pdf2docx_plus.plugins import PluginRegistry
except Exception as e:  # noqa: BLE001
    print(f"pdf2docx-plus 不可用: {e}", file=sys.stderr)
    sys.exit(2)

_parsed = {"n": 0}


def _on_page_parsed(page):  # noqa: ARG001  pdf2docx-plus 插件钩子：每解析完一页调用一次
    _parsed["n"] += 1
    n = _parsed["n"]
    if TOTAL > 0:
        pct = min(95, 58 + round(n * 37 / TOTAL))  # 页面解析占 58%→95%（前段 3%→58% 是分析阶段）
        write_progress(
            {"percent": pct, "stage": f"正在转换第 {min(n, TOTAL)}/{TOTAL} 页…", "done": n, "total": TOTAL}
        )
    else:
        write_progress({"percent": None, "stage": f"正在转换第 {n} 页…", "done": n, "total": 0})


_reg = PluginRegistry()
_reg.on_page_parsed(_on_page_parsed)

# 分析阶段（parse_document → Pages.parse → RawPage.restore）逐页进度：
# 该阶段对大文件可能耗时几十秒，逐页上报避免长时间停在 2%。
# RawPage.restore 只被 Pages.parse 调用（其余 .restore 属其他类），patch 安全。
try:
    from pdf2docx_plus._vendored.pdf2docx.page.RawPage import RawPage as _RawPage

    _restored = {"n": 0}
    _orig_restore = _RawPage.restore

    def _restore_with_progress(self, **settings):
        _restored["n"] += 1
        n = _restored["n"]
        if TOTAL > 0:
            pct = min(58, 3 + round(n * 55 / TOTAL))
            write_progress(
                {"percent": pct, "stage": f"正在分析第 {min(n, TOTAL)}/{TOTAL} 页…", "done": n, "total": TOTAL}
            )
        else:
            write_progress({"percent": None, "stage": f"正在分析第 {n} 页…", "done": n, "total": 0})
        return _orig_restore(self, **settings)

    _RawPage.restore = _restore_with_progress
except Exception:  # noqa: BLE001  分析进度是锦上添花，patch 失败不影响转换
    pass

try:
    with _Converter(in_pdf, plugins=_reg) as cv:
        result = cv.convert(
            out_docx,
            profile="fidelity",
            recover_missing_images=RECOVER,
            rasterize_vector_graphics=RASTERIZE,
        )
    if not os.path.exists(out_docx) or os.path.getsize(out_docx) == 0:
        print("转换未生成输出文件", file=sys.stderr)
        sys.exit(3)
    write_progress({"percent": 100, "stage": "转换完成", "done": TOTAL, "total": TOTAL})
    print(
        f"OK missing_rasters={getattr(result, 'missing_rasters_recovered', 0)} "
        f"vector_regions={getattr(result, 'vector_regions_rasterized', 0)} "
        f"pages={getattr(result, 'pages_ok', 0)}/{getattr(result, 'pages_total', 0)}",
        file=sys.stderr,
    )
    sys.exit(0)
except Exception as e:  # noqa: BLE001
    print(f"转换失败: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)
