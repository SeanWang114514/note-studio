# -*- coding: utf-8 -*-
"""诊断 PDF->DOCX 图片丢失问题：对比源 PDF 图片数 与 转换后 docx 内嵌图片数"""
import os, sys, json, zipfile, tempfile, shutil
import pymupdf  # fitz
import pdf2docx_plus

SRC = r"D:\VibeCoding\note apps\note-studio\public\manual.pdf"
OUT = r"D:\VibeCoding\note apps\note-studio\logs\manual_out.docx"

# 1) 源 PDF 图片统计
doc = pymupdf.open(SRC)
pdf_images = {}  # xref -> info
for pno in range(len(doc)):
    for img in doc.get_page_images(pno, full=True):
        xref = img[0]
        pdf_images.setdefault(xref, {"page": pno, "size": img[2:4], "bpc": img[5], "cs": img[6], "filter": img[7]})
print("=== 源 PDF ===")
print("页数:", len(doc))
print("图片 XObject 总数(xref):", len(pdf_images))
for xref, info in sorted(pdf_images.items()):
    print(f"  xref={xref} page={info['page']} size={info['size']} bpc={info['bpc']} cs={info['cs']} filter={info['filter']}")
doc.close()

# 2) 转换
print("\n=== 转换中 ... ===")
res = pdf2docx_plus.convert(SRC, OUT, profile="fidelity")
print("转换结果:", res)

# 3) docx 内嵌图片统计
print("\n=== 转换后 DOCX ===")
with zipfile.ZipFile(OUT) as z:
    media = [n for n in z.namelist() if n.startswith("word/media/")]
    print("word/media 文件数:", len(media))
    for n in sorted(media):
        print(f"  {n}  {z.getinfo(n).file_size} bytes")
    # 文档里 image 关系数
    rels = z.read("word/_rels/document.xml.rels").decode("utf-8", "ignore")
    print("document.xml.rels 中 image 关系数:", rels.count('image'))
