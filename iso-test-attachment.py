# -*- coding: utf-8 -*-
"""隔离测试：附件一 PDF 的结构 + 不同开关组合下的转换耗时"""
import os, sys, time, io, zipfile
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
import pymupdf
import pdf2docx_plus
from pdf2docx_plus import Converter

SRC = r'D:\onedrive\Desktop\【附件一】研究性学习专题报告系统填写操作手册.pdf'
OUT = r'D:\VibeCoding\note apps\note-studio\logs\_iso_test.docx'

print('文件大小(bytes):', os.path.getsize(SRC))

# 1) 结构
d = pymupdf.open(SRC)
print('页数:', len(d))
for i, p in enumerate(d):
    imgs = p.get_images(full=True)
    draws = p.get_drawings()
    print(f'  page{i+1}: images={len(imgs)} drawings={len(draws)} text_chars={len(p.get_text())}')
    for im in imgs:
        print(f'      img xref={im[0]} filter={im[7]}')
d.close()

def run(tag, **kw):
    if os.path.exists(OUT): os.remove(OUT)
    t0 = time.time()
    try:
        with Converter(SRC) as cv:
            r = cv.convert(OUT, profile='fidelity', timeout_s=60, **kw)
        dt = time.time() - t0
        n = 0
        if os.path.exists(OUT):
            with zipfile.ZipFile(OUT) as z:
                n = len([x for x in z.namelist() if x.startswith('word/media/')])
        print(f'[{tag}] OK {dt:.1f}s media={n} missing={r.missing_rasters_recovered} vector={r.vector_regions_rasterized}')
    except Exception as e:
        dt = time.time() - t0
        print(f'[{tag}] 失败/超时 {dt:.1f}s: {type(e).__name__}: {str(e)[:200]}')

# 2) 开恢复开关（当前服务端配置）
run('开恢复开关', recover_missing_images=True, rasterize_vector_graphics=True)
# 3) 只开缺失图片恢复
run('只开缺失恢复', recover_missing_images=True, rasterize_vector_graphics=False)
# 4) 全关（老行为）
run('全关', recover_missing_images=False, rasterize_vector_graphics=False)
