// 单测：真实 PDF 注释写回 + 回载往返（mock pdf.js viewport）
import { writeAnnotationsToPdf, loadPdfAnnotationsFromBytes } from './src/lib/pdf/pdfSaver.js'
import { PDFDocument, PDFName, PDFArray } from 'pdf-lib'

function mockPdfJsDoc(W = 612, H = 792, pageCount = 1) {
  return {
    numPages: pageCount,
    getPage: async () => ({
      getViewport: ({ scale }) => ({
        width: W * scale,
        height: H * scale,
        convertToPdfPoint: (vx, vy) => [vx, H - vy],
        convertToViewportPoint: (x, y) => [x, H - y],
        convertToViewportRectangle: (r) => [r[0], H - r[3], r[2], H - r[1]],
      }),
    }),
  }
}

const anns = [
  { id: 'b1', page: 1, type: 'brush', color: '#e5484d', thickness: 3, points: [{ x: 0.1, y: 0.8 }, { x: 0.2, y: 0.82 }, { x: 0.3, y: 0.79 }] },
  { id: 'l1', page: 1, type: 'line', color: '#2383e2', thickness: 3, x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.3 },
  { id: 'r1', page: 1, type: 'rect', color: '#2f9e44', thickness: 3, x0: 0.2, y0: 0.4, x1: 0.6, y1: 0.7 },
  { id: 'e1', page: 1, type: 'ellipse', color: '#f5c518', thickness: 3, x0: 0.6, y0: 0.1, x1: 0.9, y1: 0.3 },
  { id: 'h1', page: 1, type: 'highlighter', color: '#f5c518', thickness: 5, points: [{ x: 0.1, y: 0.9 }, { x: 0.4, y: 0.91 }] },
  { id: 't1', page: 1, type: 'text', color: '#1f1f1f', fontSize: 16, x: 0.2, y: 0.2, w: 0.3, h: 0.1, text: 'Hello PDF' },
  { id: 'c1', page: 1, type: 'comment', x: 0.5, y: 0.5, text: 'note 123' },
  // textEdit 不应写回
  { id: 'te1', page: 1, type: 'textEdit', text: 'nope' },
]

const doc = await PDFDocument.create()
doc.addPage([612, 792])
const src = await doc.save()
const mockDoc = mockPdfJsDoc()

const out = await writeAnnotationsToPdf(mockDoc, src, anns)
const reloaded = await PDFDocument.load(out)
const annotsRef = reloaded.getPage(0).node.get(PDFName.of('Annots'))
const annotsArr = reloaded.context.lookup(annotsRef)
const subtypes = annotsArr.asArray().map((ref) => reloaded.context.lookup(ref).get(PDFName.of('Subtype')).toString())
console.log('SUBtypes:', subtypes.join(', '))

const loaded = await loadPdfAnnotationsFromBytes(mockDoc, out, 1)
console.log('LOADED:', loaded.map((a) => a.type).join(', '))
console.log('LOADED detail:', JSON.stringify(loaded, null, 0).slice(0, 1200))

const expect = ['/Ink', '/Line', '/Square', '/Circle', '/Ink', '/FreeText', '/Text']
const typeOk = JSON.stringify(subtypes) === JSON.stringify(expect)
const loadedTypes = loaded.map((a) => a.type).sort().join(',')
const expectLoaded = ['brush', 'comment', 'ellipse', 'highlighter', 'line', 'rect', 'text'].sort().join(',')
const roundOk = loadedTypes === expectLoaded && loaded.length === 7
const textOk = loaded.find((a) => a.type === 'text')?.text === 'Hello PDF'
const commentOk = loaded.find((a) => a.type === 'comment')?.text === 'note 123'
const hlOk = loaded.find((a) => a.type === 'highlighter')?.points?.length >= 2
console.log('RESULT:', typeOk && roundOk && textOk && commentOk && hlOk ? 'PASS' : 'FAIL')
process.exit(typeOk && roundOk && textOk && commentOk && hlOk ? 0 : 1)
