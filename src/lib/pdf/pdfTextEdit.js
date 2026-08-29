// pdfTextEdit.js — Acrobat 级 PDF 文字编辑核心
//
// 设计目标（对标 Adobe Acrobat 的「编辑 PDF」体验）：
// - 单击左键在文字任意位置定位光标，直接插入/删除字符（所见即所得）；
// - 鼠标拖拽跨行多选（从第一行到最后一行），选区内文字可整体删除/替换；
// - 每行编辑单元不是孤立的：相邻行按 字号/行距/左对齐 合并成一个连续段落，
//   段落内的文字是「连起来」的（Word 风格），回车在段落内换行；
// - 编辑数据持久化为 textEdit 记录，保存时写回 PDF 文件本身。
//
// 数据结构：span(PDF.js 文字层) → 行(line) → 段落(block)
// 所有分组逻辑用 PDF 用户空间坐标（transform[4..5]），DOM 尺寸仅用于编辑器定位。

// ─── 常量 ───────────────────────────────────────────────

/** 同一行内 span 的 pdfY 容差（按字号比例） */
const LINE_TOL_RATIO = 0.35

/** 相邻行归入同一段落的字号比下限 */
const FONT_RATIO_MIN = 0.88

/** 相邻行基线距下限（倍字号） */
const BASELINE_GAP_MIN = 0.45
/** 相邻行基线距上限（倍字号）——放宽以支持 1.5 倍行距文档（Acrobat 可编辑） */
const BASELINE_GAP_MAX = 2.6

/** 行首对齐容差（倍字号） */
const LEFT_ALIGN_TOL = 1.6

/** 列边界检测：同一行内水平间隙超过该倍字号视为不同列 */
const COLUMN_GAP_RATIO = 3

// ─── 工具 ───────────────────────────────────────────────

/** 取 span 的 PDF 变换（transform[4]=x, transform[5]=y，PDF 用户空间，原点左下） */
export function spanPdfTransform(span) {
  if (!span?.dataset?.pdfTransform) return null
  try {
    const t = JSON.parse(span.dataset.pdfTransform)
    return Array.isArray(t) && t.length >= 6 ? t : null
  } catch {
    return null
  }
}

/** 取 span 字号（PDF 单位，从变换矩阵 a/d 分量） */
export function spanFontSize(span) {
  const t = spanPdfTransform(span)
  if (!t) return parseFloat(span.style.fontSize) || 14
  return Math.sqrt(t[2] * t[2] + t[3] * t[3]) || 14
}

/** 取 span 文字宽度（PDF 单位） */
export function spanPdfWidth(span) {
  return parseFloat(span.dataset?.pdfWidth) || 0
}

/** span 在 textLayer 容器内的 DOM 位置（相对左上） */
export function spanRectInLayer(span) {
  const layer = span.closest('.pdf-text-layer')
  const layerRect = layer?.getBoundingClientRect()
  if (!layerRect) return null
  const r = span.getBoundingClientRect()
  return {
    left: r.left - layerRect.left,
    top: r.top - layerRect.top,
    width: r.width,
    height: r.height,
    right: r.right - layerRect.left,
    bottom: r.bottom - layerRect.top,
  }
}

/** 段落 bbox（相对 textLayer 容器，DOM px） */
export function blockBoundsInLayer(spans) {
  const layer = spans[0]?.closest('.pdf-text-layer')
  const layerRect = layer?.getBoundingClientRect()
  if (!layerRect) return null
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const s of spans) {
    const r = s.getBoundingClientRect()
    if (!r.width && !r.height) continue
    left = Math.min(left, r.left - layerRect.left)
    top = Math.min(top, r.top - layerRect.top)
    right = Math.max(right, r.right - layerRect.left)
    bottom = Math.max(bottom, r.bottom - layerRect.top)
  }
  if (!isFinite(left)) return null
  return { left, top, width: right - left, height: bottom - top }
}

/**
 * 段落聚合：页面文字层 span → 行 → 段落。
 *
 * 步骤：
 * 1. 按 PDF 坐标 pdfY 分组为行（同基线容差按字号缩放），行内按 pdfX 排序；
 * 2. 同一行内水平间隙 > 3×字号 → 拆为不同列（避免跨栏合并）；
 * 3. 相邻行满足 字号相近(>0.88) + 基线距合理(0.45~1.9×字号) + 左对齐(≤1.2×字号)
 *    → 合并为同一段落。段落内的文字在编辑时是连起来的。
 *
 * @param {HTMLElement} textLayer - .pdf-text-layer 容器
 * @param {number} pageNum
 * @returns {Array<{spans: HTMLElement[], lines: Array<{text: string, spans: HTMLElement[], pdfX: number, pdfY: number, pdfWidth: number, fontSize: number}>, lineSpacing: number, rect: {left, top, width, height}, fontSize: number, fontFamily: string, color: string, isBold: boolean, isItalic: boolean}>}
 */
export function collectParagraphs(textLayer, pageNum) {
  if (!textLayer) return []
  const spans = Array.from(textLayer.querySelectorAll('span[data-page]')).filter(
    (s) =>
      String(s.dataset.page) === String(pageNum) &&
      String(s.textContent || '').trim().length > 0,
  )
  if (spans.length === 0) return []

  // ── Step 1: span → 行（按 PDF 坐标 pdfY 分组）──
  const items = spans
    .map((span) => {
      const t = spanPdfTransform(span)
      const r = spanRectInLayer(span)
      if (!t || !r || !r.width) return null
      return {
        span,
        pdfX: t[4],
        pdfY: t[5],
        pdfWidth: spanPdfWidth(span) || r.width,
        fontSize: spanFontSize(span),
        domLeft: r.left,
        domTop: r.top,
        domRight: r.right,
        domBottom: r.bottom,
      }
    })
    .filter(Boolean)

  // 按 pdfY 降序（阅读顺序：上→下），同 Y 按 pdfX 升序
  items.sort((a, b) => b.pdfY - a.pdfY || a.pdfX - b.pdfX)

  const rawLines = []
  let curLine = [items[0]]
  for (let i = 1; i < items.length; i++) {
    const tol = Math.max(curLine[0].fontSize * LINE_TOL_RATIO, 1)
    if (Math.abs(items[i].pdfY - curLine[0].pdfY) <= tol) {
      curLine.push(items[i])
    } else {
      rawLines.push(curLine)
      curLine = [items[i]]
    }
  }
  rawLines.push(curLine)
  for (const line of rawLines) line.sort((a, b) => a.pdfX - b.pdfX)

  // ── Step 1b: 同一行按大间隙拆列 ──
  const splitLines = []
  for (const line of rawLines) {
    let segment = [line[0]]
    for (let j = 1; j < line.length; j++) {
      const prev = segment[segment.length - 1]
      const curr = line[j]
      const gap = curr.pdfX - (prev.pdfX + prev.pdfWidth)
      const avgFs = (prev.fontSize + curr.fontSize) / 2
      if (gap > avgFs * COLUMN_GAP_RATIO) {
        splitLines.push(segment)
        segment = [curr]
      } else {
        segment.push(curr)
      }
    }
    splitLines.push(segment)
  }

  // ── Step 2: 行 → 段落 ──
  const blocks = []
  let curBlock = [splitLines[0]]
  for (let i = 1; i < splitLines.length; i++) {
    const prevLine = curBlock[curBlock.length - 1]
    const nextLine = splitLines[i]
    const prevFs = prevLine[0].fontSize
    const nextFs = nextLine[0].fontSize
    const fontRatio = Math.min(prevFs, nextFs) / Math.max(prevFs, nextFs)
    const baselineGap = prevLine[0].pdfY - nextLine[0].pdfY
    const avgFs = (prevFs + nextFs) / 2
    const prevLeft = Math.min(...prevLine.map((it) => it.pdfX))
    const nextLeft = Math.min(...nextLine.map((it) => it.pdfX))

    const sameBlock =
      fontRatio > FONT_RATIO_MIN &&
      baselineGap > avgFs * BASELINE_GAP_MIN &&
      baselineGap < avgFs * BASELINE_GAP_MAX &&
      Math.abs(nextLeft - prevLeft) < avgFs * LEFT_ALIGN_TOL

    if (sameBlock) curBlock.push(nextLine)
    else {
      blocks.push(curBlock)
      curBlock = [nextLine]
    }
  }
  blocks.push(curBlock)

  // ── 构建段落对象 ──
  return blocks.map((block) => {
    const allItems = block.flat()
    const allSpans = allItems.map((it) => it.span)

    const lineData = block.map((lineItems) => {
      const first = lineItems[0]
      return {
        text: lineItems.map((it) => it.span.textContent || '').join(''),
        spans: lineItems.map((it) => it.span),
        pdfX: first.pdfX,
        pdfY: first.pdfY,
        pdfWidth: lineItems.reduce((s, it) => s + it.pdfWidth, 0),
        fontSize: first.fontSize,
        domTop: Math.min(...lineItems.map((it) => it.domTop)),
        domBottom: Math.max(...lineItems.map((it) => it.domBottom)),
        domLeft: Math.min(...lineItems.map((it) => it.domLeft)),
        domRight: Math.max(...lineItems.map((it) => it.domRight)),
      }
    })

    // 行距：多行时取相邻行 pdfY 差的均值
    let lineSpacing = lineData[0].fontSize * 1.2
    if (lineData.length > 1) {
      let total = 0
      for (let i = 1; i < lineData.length; i++) total += lineData[i - 1].pdfY - lineData[i].pdfY
      lineSpacing = total / (lineData.length - 1)
    }

    const firstSpan = allSpans[0]
    const actualName = (firstSpan.dataset?.pdfActualFontName || '').toLowerCase()
    const fontFamily = firstSpan.dataset?.pdfFontFamily || 'sans-serif'

    // 颜色采样（从画布取 span 中心像素）
    const color = sampleTextColor(firstSpan)

    return {
      spans: allSpans,
      lineData,
      lineSpacing,
      rect: blockBoundsInLayer(allSpans),
      fontSize: lineData[0].fontSize,
      fontFamily,
      actualFontName: actualName,
      isBold: firstSpan.dataset?.pdfBold === 'true',
      isItalic: firstSpan.dataset?.pdfItalic === 'true',
      color,
    }
  })
}

/** 从 span 的 canvas 上采样文字颜色（span 中心像素） */
function sampleTextColor(span) {
  try {
    const layer = span.closest('.pdf-text-layer')
    const canvas = layer?.parentElement?.querySelector('.pdf-canvas')
    if (!canvas || !canvas.getContext) return '#1f1f1f'
    const ctx = canvas.getContext('2d')
    const r = span.getBoundingClientRect()
    const cr = canvas.getBoundingClientRect()
    if (!r.width || !cr.width) return '#1f1f1f'
    const sx = (px) =>
      Math.min(canvas.width - 2, Math.max(1, ((px - cr.left) / cr.width) * canvas.width))
    const sy = (py) =>
      Math.min(canvas.height - 2, Math.max(1, ((py - cr.top) / cr.height) * canvas.height))

    // 在 span 区域内采样多点（3×3 网格 + 垂直中线），取「非白中最暗」的颜色。
    // 只采中心一点会落在文字间隙/白色背景上 → 误判为白色 → 编辑框文字不可见。
    let best = null // { lum, hex }
    const sample = (px, py) => {
      const d = ctx.getImageData(Math.floor(sx(px)), Math.floor(sy(py)), 1, 1).data
      if (d[3] < 60) return // 透明像素跳过
      // 亮度：接近白色的像素跳过（背景）
      const lum = 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2]
      if (lum > 235) return
      const hex = ((1 << 24) + (d[0] << 16) + (d[1] << 8) + d[2]).toString(16).slice(1)
      if (!best || lum < best.lum) best = { lum, hex }
    }

    // 3×3 网格
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        const px = r.left + (r.width * (gx + 0.5)) / 3
        const py = r.top + (r.height * (gy + 0.5)) / 3
        sample(px, py)
      }
    }
    // 垂直中线多点（密集采样提高命中文字笔画的概率）
    for (let i = 0; i < 7; i++) {
      sample(r.left + r.width / 2, r.top + (r.height * (i + 0.5)) / 7)
    }
    // 水平中线多点
    for (let i = 0; i < 7; i++) {
      sample(r.left + (r.width * (i + 0.5)) / 7, r.top + r.height / 2)
    }

    return best ? '#' + best.hex : '#1f1f1f'
  } catch {
    return '#1f1f1f'
  }
}

/** PDF 字体名 → CSS 字体族（用于编辑器与合成 span 的视觉还原） */
export function cssFamilyFor(actualFontName, pdfFontFamily) {
  const an = (actualFontName || '').toLowerCase()
  const ff = (pdfFontFamily || '').toLowerCase()

  // 中文常见字体（PDF 内嵌宋体/黑体/楷体/仿宋/雅黑 → 本地同名字体）
  if (an.includes('simsun') || an.includes('songti') || an.includes('song') || an.includes('norrw') || an.includes('sun-ext')) {
    return '"SimSun", "宋体", serif'
  }
  if (an.includes('simhei') || an.includes('heit') || an.includes('heiti') || an.includes('yahei')) {
    return '"Microsoft YaHei", "微软雅黑", "SimHei", "黑体", sans-serif'
  }
  if (an.includes('kaiti') || an.includes('kai')) {
    return '"KaiTi", "楷体", serif'
  }
  if (an.includes('fangsong') || an.includes('fang')) {
    return '"FangSong", "仿宋", serif'
  }
  if (an.includes('msyh') || an.includes('microsoft yahei')) {
    return '"Microsoft YaHei", "微软雅黑", sans-serif'
  }

  if (an.includes('courier') || an.includes('consolas') || an.includes('mono') || ff === 'monospace') {
    return '"Courier New", Courier, monospace'
  }
  if (
    an.includes('times') ||
    an.includes('garamond') ||
    an.includes('georgia') ||
    an.includes('palatino') ||
    an.includes('cambria') ||
    an.includes('bookman') ||
    ff === 'serif'
  ) {
    return '"Times New Roman", Times, serif'
  }
  return 'Helvetica, Arial, sans-serif'
}
/** PDF 字体名 + 粗斜体 → pdf-lib StandardFont 名（保存用） */
export function toStandardFontName(actualFontName, pdfFontFamily, isBold, isItalic) {
  const an = (actualFontName || '').toLowerCase()
  const ff = (pdfFontFamily || '').toLowerCase()
  if (an.includes('courier') || an.includes('consolas') || an.includes('mono') || ff === 'monospace') {
    return isBold && isItalic ? 'Courier-BoldOblique' : isBold ? 'Courier-Bold' : isItalic ? 'Courier-Oblique' : 'Courier'
  }
  if (
    an.includes('times') ||
    an.includes('garamond') ||
    an.includes('georgia') ||
    an.includes('palatino') ||
    an.includes('cambria') ||
    an.includes('bookman') ||
    ff === 'serif'
  ) {
    return isBold && isItalic
      ? 'TimesRoman-BoldItalic'
      : isBold
        ? 'TimesRoman-Bold'
        : isItalic
          ? 'TimesRoman-Italic'
          : 'TimesRoman'
  }
  return isBold && isItalic ? 'Helvetica-BoldOblique' : isBold ? 'Helvetica-Bold' : isItalic ? 'Helvetica-Oblique' : 'Helvetica'
}

// ─── 光标定位 ───────────────────────────────────────────

/**
 * 把点击位置映射到段落文本中的字符偏移。
 * 遍历段落每行，用 canvas measureText 计算字符宽度，找到点击处最近的字符边界。
 * @param {HTMLElement} layer - 文字层容器
 * @param {number} pageNum
 * @param {number} clickX - 相对 layer 的 x
 * @param {number} clickY - 相对 layer 的 y
 * @param {object} block - collectParagraphs 返回的段落对象
 * @returns {number} 段落文本中的字符偏移（0 ~ text.length）
 */
export function offsetAtPoint(layer, pageNum, clickX, clickY, block) {
  const text = block.lines.map((l) => l.text).join('\n')
  if (!text) return 0

  // 找点击的行：按 DOM top 排序
  const lines = block.lines
  let lineIdx = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (clickY >= l.domTop && clickY <= l.domBottom) {
      lineIdx = i
      break
    }
    // 点击在两行之间 → 就近
    if (i < lines.length - 1) {
      const mid = (l.domBottom + lines[i + 1].domTop) / 2
      if (clickY < mid) {
        lineIdx = i
        break
      }
    }
  }

  // 计算该行内字符偏移
  const line = lines[lineIdx]
  const ctx = measureCtx()
  const size = line.fontSize * (layerScale(layer) || 1)
  ctx.font = cssFontFor(line.spans[0], size)
  const lineText = line.text

  if (clickX <= line.domLeft) return offsetOfLine(text, lineIdx, 0)
  if (clickX >= line.domRight) return offsetOfLine(text, lineIdx, lineText.length)

  let bestIdx = lineText.length
  let bestDist = Infinity
  let acc = 0
  for (let i = 0; i <= lineText.length; i++) {
    const charX = line.domLeft + (i === 0 ? 0 : ctx.measureText(lineText.slice(0, i)).width)
    const dist = Math.abs(charX - clickX)
    if (dist < bestDist) {
      bestDist = dist
      bestIdx = i
    }
    void acc
  }
  return offsetOfLine(text, lineIdx, bestIdx)
}

/** 行索引 + 行内偏移 → 段落文本全局偏移 */
function offsetOfLine(text, lineIdx, colIdx) {
  let offset = 0
  for (let i = 0; i < lineIdx; i++) {
    offset += text.split('\n')[i].length + 1
  }
  return offset + colIdx
}

/** 段落文本全局偏移 → {lineIdx, colIdx} */
export function offsetToLineCol(text, offset) {
  let lineIdx = 0
  let col = 0
  for (let i = 0; i < offset; i++) {
    if (text[i] === '\n') {
      lineIdx++
      col = 0
    } else col++
  }
  return { lineIdx, col }
}

let _measureCtx = null
function measureCtx() {
  if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d')
  return _measureCtx
}

function cssFontFor(span, sizePx) {
  const bold = span.dataset?.pdfBold === 'true'
  const italic = span.dataset?.pdfItalic === 'true'
  const family = cssFamilyFor(span.dataset?.pdfActualFontName, span.dataset?.pdfFontFamily)
  return (italic ? 'italic ' : '') + (bold ? 'bold ' : '') + sizePx + 'px ' + family
}

function layerScale(layer) {
  const v = parseFloat(layer?.style?.getPropertyValue('--scale-factor'))
  return v && v > 0 ? v : 1
}

// ─── 文本行拆分（Word 风格换行计算）─────────────────────

/**
 * 计算一段文本换行后的行位置（用于把编辑框里的多行文本精确映射回 PDF 行）。
 * 简单模型：按现有行结构，第 i 个 \n 对应段落第 i+1 行的开头。
 */
export function textToLines(text) {
  return String(text || '').split('\n')
}


// ─── 编辑框基线对齐（open-pdf-studio cssBaselineOffset 思路）───

let _fontMetricsCtx = null
function fontMetricsCtx() {
  if (!_fontMetricsCtx) _fontMetricsCtx = document.createElement('canvas').getContext('2d')
  return _fontMetricsCtx
}

/**
 * 计算 CSS 行盒内文字的基线偏移量。
 * Canvas 与 CSS 使用同一字体度量，把编辑框 top 对齐到基线可让
 * 编辑框内文字与 PDF 原文精确叠合（避免基线错位）。
 * @returns {number} 基线距行盒顶部的距离（px）
 */
export function cssBaselineOffset(fontFamily, fontSize, lineHeight, isBold = false, isItalic = false) {
  try {
    const ctx = fontMetricsCtx()
    const fw = isBold ? '700 ' : ''
    const fs = isItalic ? 'italic ' : ''
    ctx.font = fs + fw + fontSize + 'px ' + fontFamily
    const m = ctx.measureText('Mg')
    const ascent = Number.isFinite(m.fontBoundingBoxAscent)
      ? m.fontBoundingBoxAscent
      : (m.actualBoundingBoxAscent || fontSize * 0.8)
    const descent = Number.isFinite(m.fontBoundingBoxDescent)
      ? m.fontBoundingBoxDescent
      : (m.actualBoundingBoxDescent || fontSize * 0.2)
    return ascent + (lineHeight - ascent - descent) / 2
  } catch {
    return fontSize * 0.8 + (lineHeight - fontSize) / 2
  }
}

export default {
  collectParagraphs,
  offsetAtPoint,
  cssFamilyFor,
  toStandardFontName,
  spanPdfTransform,
  spanFontSize,
  spanRectInLayer,
  blockBoundsInLayer,
  textToLines,
  offsetToLineCol,
  cssBaselineOffset,
}