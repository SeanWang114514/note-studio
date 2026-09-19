# -*- coding: utf-8 -*-
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4

c = canvas.Canvas('public/test-chinese.pdf', pagesize=A4)
c.setFont('STSong-Light', 16)
c.drawString(72, 720, '你好世界，这是中文测试')
c.drawString(72, 690, '第二行中文内容')
c.drawString(72, 660, '第三行测试文字')
c.save()
print('ok')
