// 生成复杂版式测试 PDF：同行多段文字（作者/邮箱）、居中标题、正文、左右边注
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

async function main() {
  const pdf = await PDFDocument.create()
  const helv = await pdf.embedFont(StandardFonts.Helvetica)
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const courier = await pdf.embedFont(StandardFonts.Courier)
  const page = pdf.addPage([595, 842])
  const black = rgb(0, 0, 0)
  const blue = rgb(0.1, 0.1, 0.6)
  const W = 595

  // 作者行：三个名字分散同行（不同 x）
  const authors = [
    { t: 'Aidan N. Gomez', x: 200 },
    { t: 'Lukasz Kaiser', x: 380 },
  ]
  for (const a of authors) page.drawText(a.t, { x: a.x, y: 770, size: 12, font: helv, color: black })
  // 机构行（同行两段）
  page.drawText('Google Research', { x: 130, y: 752, size: 11, font: helv, color: black })
  page.drawText('Google Brain', { x: 400, y: 752, size: 11, font: helv, color: black })
  // 邮箱行（三段，Courier）
  page.drawText('llion@google.com', { x: 90, y: 730, size: 10, font: courier, color: black })
  page.drawText('aidan@cs.toronto.edu', { x: 220, y: 730, size: 10, font: courier, color: black })
  page.drawText('lukaszkaiser@google.com', { x: 390, y: 730, size: 10, font: courier, color: black })

  // 分隔线 + 居中标题
  page.drawLine({ start: { x: 72, y: 715 }, end: { x: 523, y: 715 }, thickness: 1, color: black })
  const title = 'Attention Is All You Need'
  const tw = helvBold.widthOfTextAtSize(title, 17)
  page.drawText(title, { x: (W - tw) / 2, y: 690, size: 17, font: helvBold, color: black })
  page.drawLine({ start: { x: 72, y: 680 }, end: { x: 523, y: 680 }, thickness: 1, color: black })

  // Abstract 居中 + 正文（右侧留白模拟边注区）
  page.drawText('Abstract', { x: (W - helvBold.widthOfTextAtSize('Abstract', 11)) / 2, y: 660, size: 11, font: helvBold, color: black })
  const body = [
    'The dominant sequence transduction models are based on complex',
    'recurrent or convolutional neural networks that include an encoder',
    'and a decoder. The best performing models also connect the encoder',
    'and decoder through an attention mechanism. We propose a new',
    'simple network architecture, the Transformer, based solely on',
    'attention mechanisms, dispensing with recurrence and convolutions',
    'entirely. Experiments on two machine translation tasks show that',
    'these models are superior in quality while being more parallelizable',
  ]
  let y = 640
  for (const line of body) {
    page.drawText(line, { x: 108, y, size: 10, font: helv, color: black })
    y -= 15
  }

  // 左边注（多行小字）
  const margin = ['*Equal', 'the effort', 'has been', 'attention a', 'detail. Nil', 'tensor2ten', 'efficient in', 'implemen']
  y = 620
  for (const m of margin) {
    page.drawText(m, { x: 60, y, size: 7, font: helv, color: blue })
    y -= 20
  }
  // 右边注
  const marginR = ['models and', 'ly every', 'phase and', 'base, and', 'arts of our', 'iterating']
  y = 620
  for (const m of marginR) {
    page.drawText(m, { x: 505, y, size: 7, font: helv, color: blue })
    y -= 20
  }

  const bytes = await pdf.save()
  fs.writeFileSync(path.join(ROOT, 'public', 'test-complex.pdf'), bytes)
  console.log('wrote public/test-complex.pdf', bytes.length, 'bytes')
}
main()
