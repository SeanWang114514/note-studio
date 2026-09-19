// 生成保位/跨段回归测试 PDF：红色居中声明（多行）+ 黑线 + 居中黑标题
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
  const page = pdf.addPage([595, 842])

  const red = rgb(1, 0, 0)
  const black = rgb(0, 0, 0)
  const notice = [
    'Provided proper attribution is provided, Google hereby grants permission to',
    'reproduce the tables and figures in this paper solely for use in journalistic or',
    'scholarly works.',
  ]
  let y = 740
  for (const line of notice) {
    const w = helv.widthOfTextAtSize(line, 11)
    page.drawText(line, { x: (595 - w) / 2, y, size: 11, font: helv, color: red })
    y -= 16
  }
  y -= 10
  page.drawLine({ start: { x: 72, y }, end: { x: 523, y }, thickness: 3, color: black })
  y -= 34
  const title = 'Attention Is All You Need'
  const tw = helvBold.widthOfTextAtSize(title, 20)
  page.drawText(title, { x: (595 - tw) / 2, y, size: 20, font: helvBold, color: black })
  y -= 12
  page.drawLine({ start: { x: 72, y }, end: { x: 523, y }, thickness: 1, color: black })

  const bytes = await pdf.save()
  fs.writeFileSync(path.join(ROOT, 'public', 'test-centered.pdf'), bytes)
  console.log('wrote public/test-centered.pdf', bytes.length, 'bytes')
}
main()
