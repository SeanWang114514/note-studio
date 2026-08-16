// 生成 docx/epub/xlsx/md 测试文件 → public/
import { writeFileSync } from 'node:fs'
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'

// docx
const doc = new Document({
  sections: [{
    children: [
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('编辑测试文档')] }),
      new Paragraph({ children: [new TextRun('这是第一段可编辑内容。'), new TextRun({ text: '加粗文字', bold: true })] }),
      new Paragraph({ children: [new TextRun('第二段普通内容。')] }),
    ],
  }],
})
const docxBytes = await Packer.toBuffer(doc)
writeFileSync('D:/VibeCoding/note apps/note-studio/public/test-edit.docx', docxBytes)
console.log('docx:', docxBytes.length, 'bytes')

// epub
const zip = new JSZip()
zip.file('mimetype', 'application/epub+zip')
zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
zip.file('OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Test</dc:title></metadata><manifest><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>')
zip.file('OEBPS/chapter1.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 1</title></head><body><h1>第一章</h1><p>这是 EPUB 的可编辑正文内容。</p><p>第二段。</p></body></html>')
const epubBytes = await zip.generateAsync({ type: 'nodebuffer' })
writeFileSync('D:/VibeCoding/note apps/note-studio/public/test-edit.epub', epubBytes)
console.log('epub:', epubBytes.length, 'bytes')

// xlsx
const wb = XLSX.utils.book_new()
const ws = XLSX.utils.aoa_to_sheet([
  ['姓名', '分数', '备注'],
  ['张三', 95, '优秀'],
  ['李四', 88, '良好'],
  ['王五', 76, '合格'],
])
XLSX.utils.book_append_sheet(wb, ws, '成绩')
const xlsxBytes = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
writeFileSync('D:/VibeCoding/note apps/note-studio/public/test-edit.xlsx', xlsxBytes)
console.log('xlsx:', xlsxBytes.length, 'bytes')

// md
writeFileSync('D:/VibeCoding/note apps/note-studio/public/test-edit.md', '# Markdown 测试\n\n这是 markdown 正文。\n\n- 列表一\n- 列表二\n')
console.log('md written')
