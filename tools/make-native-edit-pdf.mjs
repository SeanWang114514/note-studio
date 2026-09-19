// 生成段落级编辑回归测试 PDF（英文多行段落 + 中文段落 + 短段落）
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

  const para1 = [
    'This is the first paragraph used for native editing regression testing.',
    'It spans multiple lines so that cross-line drag selection can be verified.',
    'Clicking any word should place the caret exactly at that character.',
  ]
  const para2 = [
    'Second paragraph stays independent from the first one.',
    'Editing here must not touch the text above.',
  ]
  let y = 780
  page.drawText('Native Editing Regression', { x: 72, y, size: 20, font: helvBold, color: rgb(0, 0, 0) })
  y -= 36
  for (const line of para1) {
    page.drawText(line, { x: 72, y, size: 13, font: helv, color: rgb(0.1, 0.1, 0.1) })
    y -= 20
  }
  y -= 16
  for (const line of para2) {
    page.drawText(line, { x: 72, y, size: 13, font: helv, color: rgb(0.1, 0.1, 0.1) })
    y -= 20
  }
  const bytes = await pdf.save()
  fs.writeFileSync(path.join(ROOT, 'public', 'test-native-edit.pdf'), bytes)
  console.log('wrote public/test-native-edit.pdf', bytes.length, 'bytes')
}
main()
