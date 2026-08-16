// pdfSaver.js — PDF 批注真实写回 + 回载（移植自 open-pdf-studio 的 saver.js / annotation-converter 逻辑）
//
// 与「烧进内容流」不同，本版把批注写成**真实的 PDF 注释对象**（/Annots）：
// - brush(画笔)   → /Ink  + 外观流 AP
// - line(直线)    → /Line（无 AP，查看器原生渲染，同 open-pdf-studio）
// - rect(矩形)    → /Square + AP
// - ellipse(圆形) → /Circle + AP
// - highlighter   → /Ink + CA 半透明 + OPS_Subtype 私有键回载
// - text(文本框)  → /FreeText（Contents + DA，原生渲染）
// - comment(批注) → /Text 便签注释
//
// 写回时保留页上「非本应用管理」的注释（链接/表单等），替换本应用管理的子类型
// （handledSubtypes）——应用批注列表是唯一数据源（同 open-pdf-studio）。
// 打开 PDF 时用 loadPdfAnnotationsFromBytes 把页上注释读回应用模型，实现跨会话可编辑。
//
// 坐标：应用侧为归一化 0~1（相对旋转后视口），经 pdf.js viewport.convertToPdfPoint
// 转到 PDF 用户空间（原点左下，含旋转/CropBox/Y 翻转处理）；读回用
// convertToViewportPoint 逆变换。文字仍受 Helvetica(WinAnsi) 限制：中文被过滤。

import { PDFDocument, PDFName, PDFString, PDFArray, PDFRef } from 'pdf-lib'

/** 本应用接管（会替换）的注释子类型 */
const HANDLED_SUBTYPES = new Set([
  '/Square', '/Circle', '/Line', '/Ink', '/Highlight', '/FreeText', '/Text',
])

// ─── 通用工具 ───────────────────────────────────────────────

/** #rrggbb → [r,g,b] 0~1 */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))
  if (!m) return [0, 0, 0]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** 归一化点（0~1）→ PDF 用户空间点 */
function normPointToPdf(viewport, p) {
  const vx = (p?.x ?? 0) * viewport.width
  const vy = (p?.y ?? 0) * viewport.height
  const [px, py] = viewport.convertToPdfPoint(vx, vy)
  return { x: px, y: py }
}

/** 点的 bbox → 注释 /Rect [x1,y1,x2,y2]，带 padding */
function pdfRect(points, pad = 0) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
  }
  if (!isFinite(minX)) return [0, 0, 1, 1]
  return [minX - pad, minY - pad, maxX + pad, maxY + pad]
}

/** 线宽：与 App.jsx on-screen 公式一致（页面宽 × thickness/800） */
function strokeWidth(refW, thickness, factor = 1) {
  return Math.max(0.5, (refW * (Number(thickness) || 3)) / 800 * factor)
}

/** 厚度 → 应用 thickness 值（strokeWidth 的逆运算） */
function thicknessFromWidth(refW, bw, factor = 1) {
  const t = (Number(bw) || 2) / refW * 800 / factor
  return Math.max(1, Math.min(24, Math.round(t) || 3))
}

function buildBorderStyle(context, width, style = 'solid') {
  const dashMap = { dashed: [8, 4], dotted: [2, 2] }
  const dash = dashMap[style] || null
  const bs = { Type: 'Border', W: width, S: dash ? 'D' : 'S' }
  if (dash) bs.D = dash
  return context.obj(bs)
}

function r2(n) {
  return Math.round(n * 100) / 100
}

// ─── 外观流（AP）生成 ──────────────────────────────────────
// 移植 generateAppearanceStream：Square/Circle/Ink 生成 AP；Line/FreeText 跳过（原生渲染）

function appearanceFor(context, a, type, rect, colorArr, lw, viewport) {
  try {
    const [x1, y1, x2, y2] = rect
    const w = Math.max(0.1, x2 - x1)
    const h = Math.max(0.1, y2 - y1)
    const [r, g, b] = colorArr
    let s = ''
    if (type === 'rect') {
      s = `${lw} w\n${r} ${g} ${b} RG\n0 0 ${w} ${h} re S\n`
    } else if (type === 'ellipse') {
      const cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2
      const k = 0.5522847498
      s = `${lw} w\n${r} ${g} ${b} RG\n`
      s += `${r2(cx)} ${r2(cy + ry)} m\n`
      s += `${r2(cx + k * rx)} ${r2(cy + ry)} ${r2(cx + rx)} ${r2(cy + k * ry)} ${r2(cx + rx)} ${r2(cy)} c\n`
      s += `${r2(cx + rx)} ${r2(cy - k * ry)} ${r2(cx + k * rx)} ${r2(cy - ry)} ${r2(cx)} ${r2(cy - ry)} c\n`
      s += `${r2(cx - k * rx)} ${r2(cy - ry)} ${r2(cx - rx)} ${r2(cy - k * ry)} ${r2(cx - rx)} ${r2(cy)} c\n`
      s += `${r2(cx - rx)} ${r2(cy + k * ry)} ${r2(cx - k * rx)} ${r2(cy + ry)} ${r2(cx)} ${r2(cy + ry)} c\nS\n`
    } else if (type === 'ink') {
      const pts = (a.points || []).map((p) => {
        const pp = normPointToPdf(viewport, p)
        return { x: pp.x - x1, y: pp.y - y1 }
      })
      if (pts.length < 2) return null
      s = `${lw} w\n${r} ${g} ${b} RG\n`
      s += `${r2(pts[0].x)} ${r2(pts[0].y)} m\n`
      for (let i = 1; i < pts.length; i++) s += `${r2(pts[i].x)} ${r2(pts[i].y)} l\n`
      s += 'S\n'
    } else {
      return null
    }
    return context.stream(s, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, w, h],
    })
  } catch (e) {
    console.warn('[pdf-saver] AP generation failed:', e)
    return null
  }
}

// ─── 批注字典构建 ──────────────────────────────────────────

function buildAnnotationDict(pdf, viewport, a, refW) {
  const context = pdf.context
  const colorArr = hexToRgb(a.color)
  const opacity = a.type === 'highlighter' ? 0.35 : 1
  const lw = a.type === 'highlighter'
    ? Math.max(8, (refW * (Number(a.thickness) || 5)) / 350)
    : strokeWidth(refW, a.thickness, a.type === 'rect' || a.type === 'ellipse' ? 0.5 : 1)

  const base = {
    Type: 'Annot',
    C: colorArr,
    CA: opacity,
    T: PDFString.of('User'),
    Contents: PDFString.of(''),
    M: PDFString.of(new Date().toISOString()),
    F: 4, // Print
  }

  switch (a.type) {
    case 'brush':
    case 'highlighter': {
      const pts = (a.points || []).map((p) => normPointToPdf(viewport, p))
      if (pts.length < 2) return null
      const rect = pdfRect(pts, lw)
      const inkList = []
      for (const p of pts) inkList.push(p.x, p.y)
      const dict = context.obj({
        ...base,
        Subtype: 'Ink',
        Rect: rect,
        InkList: [inkList],
        BS: buildBorderStyle(context, lw),
      })
      // 荧光笔回载：私有键（open-pdf-studio 同款 OPS_Subtype 约定）
      if (a.type === 'highlighter') {
        dict.set(PDFName.of('OPS_Subtype'), PDFString.of('highlighter'))
      }
      return dict
    }
    case 'line': {
      const s = normPointToPdf(viewport, { x: a.x0, y: a.y0 })
      const e = normPointToPdf(viewport, { x: a.x1, y: a.y1 })
      const pad = Math.max(lw, 6)
      return context.obj({
        ...base,
        Subtype: 'Line',
        Rect: pdfRect([s, e], pad),
        L: [s.x, s.y, e.x, e.y],
        BS: buildBorderStyle(context, lw),
      })
    }
    case 'rect': {
      const p0 = normPointToPdf(viewport, { x: a.x0, y: a.y0 })
      const p1 = normPointToPdf(viewport, { x: a.x1, y: a.y1 })
      return context.obj({
        ...base,
        Subtype: 'Square',
        Rect: pdfRect([p0, p1]),
        BS: buildBorderStyle(context, lw),
      })
    }
    case 'ellipse': {
      const p0 = normPointToPdf(viewport, { x: a.x0, y: a.y0 })
      const p1 = normPointToPdf(viewport, { x: a.x1, y: a.y1 })
      return context.obj({
        ...base,
        Subtype: 'Circle',
        Rect: pdfRect([p0, p1]),
        BS: buildBorderStyle(context, lw),
      })
    }
    case 'text': {
      // 文本框 → FreeText（Contents + DA，原生渲染，同 open-pdf-studio）
      const [r, g, b] = colorArr
      const size = Math.max(6, (Number(a.fontSize) || 16) * 0.75)
      const p0 = normPointToPdf(viewport, { x: a.x, y: a.y })
      const p1 = normPointToPdf(viewport, { x: a.x + (a.w || 0.2), y: a.y + (a.h || 0.06) })
      const rect = pdfRect([p0, p1])
      const da = `${r2(r)} ${r2(g)} ${r2(b)} rg /Helv ${size} Tf`
      ensureFreeTextFont(pdf)
      return context.obj({
        ...base,
        Subtype: 'FreeText',
        Rect: rect,
        Contents: PDFString.of(String(a.text || '')),
        DA: PDFString.of(da),
        BS: buildBorderStyle(context, 0.5),
        Q: 0,
      })
    }
    case 'comment': {
      const p = normPointToPdf(viewport, { x: a.x, y: a.y })
      return context.obj({
        ...base,
        Subtype: 'Text',
        Rect: [p.x - 12, p.y - 12, p.x + 12, p.y + 12],
        Contents: PDFString.of(String(a.text || '')),
        C: [1, 0.8, 0.1],
        Name: 'Comment',
        Open: false,
      })
    }
    default:
      return null
  }
}

/** 保证 AcroForm /DR 里有 /Helv，FreeText 的 DA 才能被查看器解析（同 open-pdf-studio ensureAcroFormFonts） */
function ensureFreeTextFont(pdf) {
  try {
    const context = pdf.context
    const catalog = context.lookup(context.trailerInfo.Root)
    if (!catalog) return
    let acroFormRef = catalog.get(PDFName.of('AcroForm'))
    let acroForm = acroFormRef ? context.lookup(acroFormRef) : null
    if (!acroForm) {
      acroForm = context.obj({ Fields: [] })
      acroFormRef = context.register(acroForm)
      catalog.set(PDFName.of('AcroForm'), acroFormRef)
    }
    let drRef = acroForm.get(PDFName.of('DR'))
    let dr = drRef ? context.lookup(drRef) : null
    if (!dr) {
      dr = context.obj({})
      acroForm.set(PDFName.of('DR'), dr)
    }
    let fontDictRef = dr.get(PDFName.of('Font'))
    let fontDict = fontDictRef ? context.lookup(fontDictRef) : null
    if (!fontDict) {
      fontDict = context.obj({})
      dr.set(PDFName.of('Font'), fontDict)
    }
    if (!fontDict.get(PDFName.of('Helv'))) {
      fontDict.set(PDFName.of('Helv'), context.obj({
        Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding',
      }))
    }
  } catch (e) {
    console.warn('[pdf-saver] ensureAcroFormFonts failed:', e)
  }
}

// ─── 写回主入口 ────────────────────────────────────────────

/**
 * 把批注写成真实 PDF 注释（替换本应用管理的子类型，保留其它注释）。
 * @param {object} pdfJsDoc - pdf.js 文档（坐标换算用）
 * @param {Uint8Array|ArrayBuffer} sourceBytes - 原始字节
 * @param {Array<object>} annotations - 待写回批注（非 textEdit）
 * @returns {Promise<Uint8Array>}
 */
export async function writeAnnotationsToPdf(pdfJsDoc, sourceBytes, annotations) {
  const pdf = await PDFDocument.load(sourceBytes)
  const context = pdf.context

  const byPage = new Map()
  for (const a of annotations || []) {
    if (!a || a.type === 'textEdit') continue
    const p = Number(a.page) || 1
    if (!byPage.has(p)) byPage.set(p, [])
    byPage.get(p).push(a)
  }

  const pageCount = pdf.getPageCount()
  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const pageAnns = byPage.get(pageNum) || []
    const pdfPage = pdf.getPage(pageNum - 1)
    const node = pdfPage.node
    const annotsRef = node.get(PDFName.of('Annots'))
    if (pageAnns.length === 0 && !annotsRef) continue

    const jsPage = await pdfJsDoc.getPage(pageNum).catch(() => null)
    if (!jsPage) continue
    const viewport = jsPage.getViewport({ scale: 1 })
    const refW = viewport.width

    // 保留非本应用管理的注释
    const annotsArray = []
    if (annotsRef) {
      const lookedUp = context.lookup(annotsRef)
      if (lookedUp instanceof PDFArray) {
        for (const ref of lookedUp.asArray()) {
          const d = context.lookup(ref)
          const st = d?.get?.(PDFName.of('Subtype'))?.toString?.()
          if (!st || !HANDLED_SUBTYPES.has(st)) annotsArray.push(ref)
        }
      }
    }

    for (const a of pageAnns) {
      const dict = buildAnnotationDict(pdf, viewport, a, refW)
      if (!dict) continue
      // 外观流（Line/FreeText/Text 跳过，查看器原生渲染）
      if (!dict.get(PDFName.of('AP'))) {
        const subtype = dict.get(PDFName.of('Subtype'))?.toString?.() || ''
        const type = subtype === '/Square' ? 'rect' : subtype === '/Circle' ? 'ellipse' : subtype === '/Ink' ? 'ink' : null
        if (type) {
          const colorArr = hexToRgb(a.color)
          const lw = a.type === 'highlighter'
            ? Math.max(8, (refW * (Number(a.thickness) || 5)) / 350)
            : strokeWidth(refW, a.thickness, a.type === 'rect' || a.type === 'ellipse' ? 0.5 : 1)
          let rect
          if (type === 'ink') {
            const pts = (a.points || []).map((p) => normPointToPdf(viewport, p))
            rect = pdfRect(pts, lw)
          } else {
            const p0 = normPointToPdf(viewport, { x: a.x0, y: a.y0 })
            const p1 = normPointToPdf(viewport, { x: a.x1, y: a.y1 })
            rect = pdfRect([p0, p1])
          }
          const ap = appearanceFor(context, a, type, rect, colorArr, lw, viewport)
          if (ap) dict.set(PDFName.of('AP'), context.obj({ N: context.register(ap) }))
        }
      }
      annotsArray.push(context.register(dict))
    }

    node.set(PDFName.of('Annots'), context.obj(annotsArray))
  }

  return pdf.save()
}

// ─── 读取回载：PDF 注释 → 应用批注模型 ──────────────────────

/** 把 PDFArray（数字数组）转成 JS number[]（元素可能是 PDFNumber 或 ref） */
function arrayToNumbers(arr, context) {
  if (!(arr instanceof PDFArray)) return null
  const out = []
  for (const el of arr.asArray()) {
    const v = el instanceof PDFRef ? context.lookup(el) : el
    if (typeof v?.asNumber === 'function') out.push(v.asNumber())
    else if (typeof v === 'number') out.push(v)
    else return null
  }
  return out
}

function lookupArray(dict, name) {
  try {
    const v = dict.lookup(PDFName.of(name))
    return v instanceof PDFArray ? arrayToNumbers(v, dict.context) : null
  } catch {
    return null
  }
}

function strVal(dict, name) {
  try {
    const v = dict.lookup(PDFName.of(name))
    if (v == null) return ''
    if (typeof v.decodeText === 'function') return v.decodeText()
    if (typeof v.toString === 'function') return v.toString()
    return String(v)
  } catch {
    return ''
  }
}

function subtypeOf(dict) {
  const st = dict.get(PDFName.of('Subtype'))
  return st?.toString?.() || ''
}

/**
 * 从 PDF 字节读回本应用管理的注释 → 应用批注模型（归一化 0~1）。
 * @param {object} pdfJsDoc - pdf.js 文档（viewport 换算用）
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {number} pageCount
 * @returns {Promise<Array<object>>}
 */
export async function loadPdfAnnotationsFromBytes(pdfJsDoc, bytes, pageCount) {
  let pdf
  try {
    pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false })
  } catch {
    return []
  }
  const context = pdf.context
  const result = []

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const jsPage = await pdfJsDoc.getPage(pageNum).catch(() => null)
    if (!jsPage) continue
    const viewport = jsPage.getViewport({ scale: 1 })

    const node = pdf.getPage(pageNum - 1).node
    const annotsRef = node.get(PDFName.of('Annots'))
    if (!annotsRef) continue
    const lookedUp = context.lookup(annotsRef)
    if (!(lookedUp instanceof PDFArray)) continue

    for (const ref of lookedUp.asArray()) {
      let dict
      try {
        dict = context.lookup(ref)
      } catch {
        continue
      }
      if (!dict || typeof dict.get !== 'function') continue
      const st = subtypeOf(dict)
      if (!HANDLED_SUBTYPES.has(st)) continue

      const rect = lookupArray(dict, 'Rect')
      if (!rect || rect.length < 4) continue
      const vr = viewport.convertToViewportRectangle(rect)
      const nx = vr[0] / viewport.width
      const ny = vr[1] / viewport.height
      const nw = Math.abs(vr[2] - vr[0]) / viewport.width
      const nh = Math.abs(vr[3] - vr[1]) / viewport.height
      const color = rgbToHex(lookupArray(dict, 'C') || [0, 0, 0])
      const contents = strVal(dict, 'Contents')
      const bw = (() => {
        try {
          const bs = dict.lookup(PDFName.of('BS'))
          return bs?.get?.(PDFName.of('W')) ?? 2
        } catch {
          return 2
        }
      })()

      switch (st) {
        case '/Ink': {
          const inkList = dict.lookup(PDFName.of('InkList'))
          const strokes = inkList instanceof PDFArray ? inkList.asArray() : []
          if (!strokes.length) break
          const first = strokes[0] instanceof PDFRef ? context.lookup(strokes[0]) : strokes[0]
          const flat = first instanceof PDFArray ? arrayToNumbers(first, context) : null
          if (!flat || flat.length < 4) break
          const points = []
          for (let i = 0; i < flat.length; i += 2) {
            const vp = viewport.convertToViewportPoint(flat[i], flat[i + 1])
            points.push({ x: vp[0] / viewport.width, y: vp[1] / viewport.height })
          }
          const isHighlighter = strVal(dict, 'OPS_Subtype') === 'highlighter'
          result.push({
            id: uid(), page: pageNum,
            type: isHighlighter ? 'highlighter' : 'brush',
            color: isHighlighter && color === '#000000' ? '#f5c518' : color,
            // 荧光笔写用 refW*thickness/350，读回按同公式
            thickness: isHighlighter
              ? Math.max(5, Math.round((Number(bw) || 8) / viewport.width * 350) || 5)
              : thicknessFromWidth(viewport.width, bw),
            points,
          })
          break
        }
        case '/Line': {
          const l = lookupArray(dict, 'L')
          if (!l || l.length < 4) break
          const p0 = viewport.convertToViewportPoint(l[0], l[1])
          const p1 = viewport.convertToViewportPoint(l[2], l[3])
          result.push({
            id: uid(), page: pageNum, type: 'line', color,
            thickness: thicknessFromWidth(viewport.width, bw),
            x0: p0[0] / viewport.width, y0: p0[1] / viewport.height,
            x1: p1[0] / viewport.width, y1: p1[1] / viewport.height,
          })
          break
        }
        case '/Square':
          result.push({
            id: uid(), page: pageNum, type: 'rect', color,
            thickness: thicknessFromWidth(viewport.width, bw, 0.5),
            x0: nx, y0: ny, x1: nx + nw, y1: ny + nh,
          })
          break
        case '/Circle':
          result.push({
            id: uid(), page: pageNum, type: 'ellipse', color,
            thickness: thicknessFromWidth(viewport.width, bw, 0.5),
            x0: nx, y0: ny, x1: nx + nw, y1: ny + nh,
          })
          break
        case '/FreeText': {
          const da = strVal(dict, 'DA')
          const sizeM = /([\d.]+)\s*Tf/.exec(da)
          const colM = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da)
          const fontSize = sizeM ? Math.round(Number(sizeM[1]) / 0.75) || 16 : 16
          const textColor = colM
            ? `#${[colM[1], colM[2], colM[3]].map((v) => Math.round(Number(v) * 255).toString(16).padStart(2, '0')).join('')}`
            : color
          result.push({
            id: uid(), page: pageNum, type: 'text',
            x: nx, y: ny, w: nw, h: nh,
            text: contents, color: textColor, fontSize,
          })
          break
        }
        case '/Text':
          result.push({
            id: uid(), page: pageNum, type: 'comment',
            x: nx + nw / 2, y: ny + nh / 2, text: contents, color: '#f5c518',
          })
          break
        case '/Highlight': {
          // 其它工具的高亮注释 → 荧光笔（四边形带）
          const qp = lookupArray(dict, 'QuadPoints')
          if (!qp || qp.length < 8) break
          const idx = [0, 1, 2, 3, 6, 7, 4, 5] // TL→TR→BR→BL 围成矩形带
          const pts = []
          for (const i of idx) {
            if (i >= qp.length) continue
            const vp = viewport.convertToViewportPoint(qp[i], qp[i + 1])
            pts.push({ x: vp[0] / viewport.width, y: vp[1] / viewport.height })
          }
          if (pts.length < 2) break
          result.push({
            id: uid(), page: pageNum, type: 'highlighter',
            color: color === '#000000' ? '#f5c518' : color, thickness: 5, points: pts,
          })
          break
        }
        default:
          break
      }
    }
  }
  return result
}

function rgbToHex(arr) {
  if (!arr || arr.length < 3) return '#1f1f1f'
  return `#${arr.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(Number(v) * 255))).toString(16).padStart(2, '0')).join('')}`
}

let _uidCounter = 0
function uid() {
  _uidCounter += 1
  return `pdf-${Date.now().toString(36)}-${_uidCounter}-${Math.random().toString(36).slice(2, 7)}`
}
