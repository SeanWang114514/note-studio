# -*- coding: utf-8 -*-
"""对比：默认转换 vs 开启图片恢复开关"""
import zipfile, os
import pdf2docx_plus
from pdf2docx_plus import Converter

SRC = r"D:\VibeCoding\note apps\note-studio\logs\repro-formxobject.pdf"
OUT_A = r"D:\VibeCoding\note apps\note-studio\logs\repro_default.docx"
OUT_B = r"D:\VibeCoding\note apps\note-studio\logs\repro_recover.docx"

def count_media(docx):
    with zipfile.ZipFile(docx) as z:
        media = [n for n in z.namelist() if n.startswith("word/media/")]
        return len(media), media

def run(tag, out, **kw):
    for f in (out,):
        if os.path.exists(f):
            os.remove(f)
    res = pdf2docx_plus.convert(SRC, out, profile="fidelity", **kw)
    n, media = count_media(out)
    print(f"[{tag}] media={n}")
    for m in sorted(media):
        print(f"    {m}")
    print(f"    missing_rasters_recovered={res.missing_rasters_recovered} vector_regions_rasterized={res.vector_regions_rasterized}")
    print(f"    pages_ok={res.pages_ok}/{res.pages_total}")

# A: 当前服务端调用方式（模块级 convert，无恢复开关）
run("A 默认(当前服务端)", OUT_A)

# B: Converter + 恢复开关
with Converter(SRC) as cv:
    res = cv.convert(OUT_B, profile="fidelity", recover_missing_images=True, rasterize_vector_graphics=True)
n, media = count_media(OUT_B)
print(f"[B 恢复开关] media={n}")
for m in sorted(media):
    print(f"    {m}")
print(f"    missing_rasters_recovered={res.missing_rasters_recovered} vector_regions_rasterized={res.vector_regions_rasterized}")
print(f"    pages_ok={res.pages_ok}/{res.pages_total}")
