# -*- coding: utf-8 -*-
"""构造复现"PDF转Word掉图片"的测试 PDF：
  page1-4: 同一图片通过 Form XObject 在每页复用（logo 场景，触发 get_image_rects 为空）
  page1:   正常直接放置的 JPEG
  page4:   带 alpha 的 PNG（SMask）
  page5:   纯矢量图形（填充圆/矩形/线条组成的"图表"，无栅格图）
"""
import pymupdf

OUT = r"D:\VibeCoding\note apps\note-studio\logs\repro-formxobject.pdf"
TMP = r"D:\VibeCoding\note apps\note-studio\logs\_repro_tmp"

import os
os.makedirs(TMP, exist_ok=True)

# ---- 生成素材 ----
# logo：100x100 纯色块 + 文字（简单即可）
logo_path = os.path.join(TMP, "logo.png")
pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 100, 100))
pix.clear_with(0x2266CC)  # 蓝色块
pix.save(logo_path)
pix = None

# 红色大图（直接放置，JPEG）
red_path = os.path.join(TMP, "red.png")
pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 200, 120))
pix.clear_with(0xCC4422)
pix.save(red_path)
pix = None

# 带 alpha 的 PNG（中心不透明、边缘透明）
from PIL import Image, ImageDraw
alpha_path = os.path.join(TMP, "alpha.png")
aimg = Image.new("RGBA", (120, 120), (0, 0, 0, 0))
d = ImageDraw.Draw(aimg)
d.ellipse([5, 5, 115, 115], fill=(51, 170, 85, 255))
aimg.save(alpha_path)

# ---- 构造 PDF ----
a = pymupdf.open()          # 源：page0 放 logo
pa = a.new_page(width=612, height=792)
pa.insert_image(pymupdf.Rect(50, 50, 250, 250), filename=logo_path)

b = pymupdf.open()          # 目标：4 页，每页通过 Form XObject 复用 logo
for i in range(4):
    pb = b.new_page(width=612, height=792)
    if i == 0:
        # page1 直接放一张 JPEG 大图 + 直接放 logo（验证普通路径正常）
        pb.insert_image(pymupdf.Rect(50, 300, 450, 420), filename=red_path)
        pb.insert_image(pymupdf.Rect(300, 50, 500, 250), filename=logo_path)
    # 通过 Form XObject 放置 logo（复用同一图片对象）
    pb.show_pdf_page(pymupdf.Rect(400, 650, 580, 780), a, 0)
    pb.insert_text((60, 700), f"page {i+1} (logo via Form XObject)", fontsize=10)
    if i == 3:
        pb.insert_image(pymupdf.Rect(60, 400, 260, 560), filename=alpha_path)
        pb.insert_text((60, 380), "alpha png (SMask)", fontsize=10)

# page5：纯矢量图表
p5 = b.new_page(width=612, height=792)
p5.draw_rect(pymupdf.Rect(80, 300, 500, 620), color=(0, 0, 0), width=1.2)
for k, (x0, y0, x1, y1, col) in enumerate([
    (100, 540, 180, 600, (0.2, 0.4, 0.9)),
    (200, 500, 280, 600, (0.9, 0.3, 0.2)),
    (300, 460, 380, 600, (0.2, 0.8, 0.3)),
    (400, 420, 480, 600, (0.9, 0.7, 0.1)),
    (100, 420, 180, 480, (0.6, 0.2, 0.7)),
]):
    p5.draw_rect(pymupdf.Rect(x0, y0, x1, y1), color=None, fill=col)
p5.draw_oval(pymupdf.Rect(150, 330, 220, 400), color=None, fill=(0.1, 0.1, 0.1))
p5.draw_oval(pymupdf.Rect(240, 330, 310, 400), color=None, fill=(0.5, 0.5, 0.5))
p5.draw_oval(pymupdf.Rect(330, 330, 400, 400), color=None, fill=(0.8, 0.8, 0.8))
p5.draw_oval(pymupdf.Rect(420, 330, 490, 400), color=None, fill=(0.2, 0.2, 0.8))
p5.insert_text((80, 300), "vector chart (no raster)", fontsize=10)

b.save(OUT)
b.close()
a.close()
print("生成:", OUT)

# ---- 自检：图片/矢量结构 ----
d = pymupdf.open(OUT)
for pno in range(len(d)):
    page = d[pno]
    imgs = page.get_images(full=True)
    rects_total = 0
    for im in imgs:
        rects_total += len(page.get_image_rects(im[0]))
    draws = len(page.get_drawings())
    print(f"page {pno+1}: images={len(imgs)} rects={rects_total} drawings={draws}")
d.close()
