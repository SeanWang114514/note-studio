import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  BookOpen,
  ChevronDown,
  Delete,
  ExternalLink,
  File as FileIcon,
  FileCode2,
  FilePlus2,
  FileSpreadsheet,
  FileText,
  FileWarning,
  Highlighter,
  Home,
  Italic,
  Merge,
  Circle,
  Eraser,
  Minus,
  Square,
  Mic,
  MessageSquareText,
  MousePointer2,
  Pencil,
  PenLine,
  PanelLeft,
  PanelRight,
  Plus,
  Presentation,
  Redo2,
  Save,
  ScanText,
  Shapes,
  SlidersHorizontal,
  TextCursor,
  Trash2,
  Type,
  Underline,
  Undo2,
  Settings,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  addRecent,
  applyGridOp,
  buildDocxFromHtml,
  detectType,
  ensurePermission,
  FILE_TYPES,
  formatBytes,
  formatDate,
  getFileHandle,
  getRecent,
  loadAnnotations,
  openPdf,
  pickFiles,
  putFileHandle,
  readEpubBook,
  readEpubHtml,
  readExcelGrid,
  readText,
  resolveZipPath,
  renderDocxHtml,
  DOCX_PAGE_BREAK_HTML,
  makeEpubChapter,
  renderMarkdownHtml,
  renderPdfPage,
  saveAnnotations,
  saveEpubBook,
  saveEpubFromHtml,
  saveExcelChanges,
  saveFileBytes,
  saveTextFile,
} from './lib/FileProcessor.js'
import SettingsModal from './components/SettingsModal.jsx'
import { captureEditableSelection, captureTextareaSelection, insertAtRange } from './lib/caretInsert.js'
import { extractPdfMarkdown } from './lib/pdf/pdfTextExtract.js'
import OpenPdfStudioView from './components/OpenPdfStudioView.jsx'
import PdfEditorView from './components/PdfEditorView.jsx'
import { PanelSplitter } from './components/PanelSplitter.jsx'
import { usePanel } from './lib/panelLayout.js'
import { makeSurfaceRescaleSettler, useSurfaceRescale } from './lib/surfaceRescale.js'
import {
  DEFAULT_TEXT_STYLE,
  TEXT_ALIGNS,
  TEXT_FONTS,
  TEXT_SIZES,
  normalizeTextStyle,
  textFontOf,
  textStyleToCss,
} from './lib/textStyle.js'
const uid = () =>
  globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}`

// 文件类型标识色取 Apple 系统色（systemRed/Blue/Green/Orange/Purple…）
const TYPE_META = {
  pdf: { label: 'PDF 文档', icon: FileText, color: '#ff3b30' },
  docx: { label: 'Word 文档', icon: FileText, color: '#007aff' },
  markdown: { label: 'Markdown', icon: FileCode2, color: '#5ac8fa' },
  text: { label: '纯文本', icon: TextCursor, color: '#8e8e93' },
  ppt: { label: 'PPT 演示', icon: Presentation, color: '#ff9500' },
  excel: { label: 'Excel 表格', icon: FileSpreadsheet, color: '#34c759' },
  epub: { label: 'EPUB 电子书', icon: BookOpen, color: '#af52de' },
  caj: { label: 'CAJ 文献', icon: FileWarning, color: '#ff2d55' },
  unknown: { label: '文件', icon: FileIcon, color: '#8e8e93' },
}

// 图形工具（从画笔设置里独立出来的直线/矩形/圆形）
const SHAPE_PRESETS = [
  { type: 'line', label: '直线', icon: Minus },
  { type: 'rect', label: '矩形', icon: Square },
  { type: 'ellipse', label: '圆形', icon: Circle },
]

// 画笔预设：仅保留自由笔（图形已独立成单独工具）
const PEN_PRESETS = [{ type: 'brush', label: '画笔', icon: Pencil }]

// 画笔色板：墨黑 + Apple 系统色（红/蓝/绿）+ 荧光黄
const PEN_COLORS = ['#ff3b30', '#1c1c1e', '#007aff', '#34c759', '#ffd60a']

const clamp01 = (v) => Math.min(1, Math.max(0, v))

// ─── 「新建一页」在各格式里的落地方式 ───────────────────────────────
// 「页」的概念各格式不同，所以同一个动作落到各处是不同实现：
//   PDF → pdf-lib 追加一页真实空白页；Word → 分页符；Markdown → \pagebreak 标记；
//   纯文本 → 换页符 ^L；Excel → 新工作表；EPUB → 新章节；PPT/CAJ/未知 → 白板追加空白页。
// 共同点是：都从工具条进、都不额外弹窗，保存仍走各视图原有流程。

/** Word 的分页标记（HTML）：界面上是一条可见的分页线，保存 docx 时写成 Word 原生分页符 */
// 定义在 FileProcessor 里：读取时要把文件里的分页符还原成同一个标记（见 renderDocxHtml）
const PAGE_BREAK_HTML = DOCX_PAGE_BREAK_HTML

/** Markdown 的分页标记：沿用 Pandoc/LaTeX 习惯的 \pagebreak 独立行，纯文本、可 round-trip */
const MD_PAGE_BREAK = '\\pagebreak'

/** 纯文本的换页符（^L / form feed）：多数编辑器与打印链路都认它 */
const TEXT_PAGE_BREAK = '\f'

/**
 * 「新建一页」按钮：外观与位置统一（都在工具条里），具体行为由各视图传入。
 */
function NewPageButton({ onClick, title, label = '新建一页', disabled, primary = false }) {
  return (
    <button
      className={`tool-btn new-page-btn ${primary ? 'primary' : ''}`}
      title={title || label}
      onClick={onClick}
      disabled={disabled}
    >
      <FilePlus2 size={15} />
      {/* 文字标签包一层 .btn-text：窄屏由媒体查询收起，只留图标 + title（与 pdf-toolbar 的按钮同一约定） */}
      <span className="btn-text">{label}</span>
    </button>
  )
}


const SLASH_ITEMS = [
  { type: 'h1', label: '标题 1' },
  { type: 'h2', label: '标题 2' },
  { type: 'h3', label: '标题 3' },
  { type: 'todo', label: '待办事项' },
  { type: 'quote', label: '引用' },
  { type: 'code', label: '代码块' },
  { type: 'pagebreak', label: '新页（分页）' },
]

const BLOCK_PLACEHOLDER = {
  p: '输入文字，输入/ 插入块',
  h1: '标题 1',
  h2: '标题 2',
  h3: '标题 3',
  todo: '待办事项',
  quote: '引用内容',
  code: '输入代码…',
}

function drawAnnotation(ctx, a, w, h, isDraft = false) {
  ctx.save()
  ctx.strokeStyle = a.color
  ctx.fillStyle = a.color
  // 草稿对象用start/end，正式批注用 x0/y0/x1/y1，统一取点
  const x0 = a.x0 ?? a.start?.x ?? 0
  const y0 = a.y0 ?? a.start?.y ?? 0
  const x1 = a.x1 ?? a.end?.x ?? 0
  const y1 = a.y1 ?? a.end?.y ?? 0
  const thickness = (a.thickness || 3) / 800
  ctx.lineWidth =
    a.type === 'highlighter'
      ? Math.max(5, w * ((a.thickness || 5) / 350))
      : a.type === 'rect' || a.type === 'ellipse'
        ? Math.max(1.5, w * thickness * 0.5)
        : Math.max(1.5, w * thickness)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  // 拖动中的预览：直线/矩形/椭圆用虚线+ 端点手柄，松手后实线定型
  if (isDraft && a.type !== 'brush' && a.type !== 'highlighter') ctx.setLineDash([6, 4])
  if ((a.type === 'brush' || a.type === 'highlighter') && a.points && a.points.length >= 2) {
    const trace = () => {
      ctx.beginPath()
      ctx.moveTo(a.points[0].x * w, a.points[0].y * h)
      for (let i = 1; i < a.points.length; i++) {
        ctx.lineTo(a.points[i].x * w, a.points[i].y * h)
      }
      ctx.stroke()
    }
    if (a.type === 'highlighter') {
      // 荧光笔是半透明覆盖层。若用默认 source-over 逐条绘制，第二道盖在同一路径上会叠加 alpha
      // （0.35+0.35≈0.58），在覆盖处形成一块比单道更暗的矩形，出现用户反馈的「矩形框 / 一深一浅」。
      // 修复：先沿本路径把既有墨迹整个 destination-out 抹掉，再以 0.35 半透明重画一次，
      // 这样覆盖书写保持均匀（颜色与单道一致），不会累加变深。
      ctx.save()
      ctx.globalCompositeOperation = 'destination-out'
      trace()
      ctx.restore()
      ctx.globalAlpha = 0.35
      trace()
      ctx.globalAlpha = 1
    } else {
      trace()
    }
  } else if (a.type === 'line') {
    const px0 = x0 * w
    const py0 = y0 * h
    const px1 = x1 * w
    const py1 = y1 * h
    ctx.beginPath()
    ctx.moveTo(px0, py0)
    ctx.lineTo(px1, py1)
    ctx.stroke()
    if (isDraft) {
      // 端点手柄：预览时显示起止点小方块
      ctx.setLineDash([])
      ctx.globalAlpha = 0.9
      const hs = Math.max(5, ctx.lineWidth * 1.8)
      ctx.fillRect(px0 - hs / 2, py0 - hs / 2, hs, hs)
      ctx.fillRect(px1 - hs / 2, py1 - hs / 2, hs, hs)
    }
  } else if (a.type === 'rect') {
    const x = Math.min(x0, x1) * w
    const y = Math.min(y0, y1) * h
    const rw = Math.abs(x1 - x0) * w
    const rh = Math.abs(y1 - y0) * h
    ctx.globalAlpha = isDraft ? 0.9 : 1
    ctx.strokeRect(x, y, rw, rh)
    ctx.setLineDash([])
  } else if (a.type === 'ellipse') {
    // 椭圆：内切于拖拽矩形；Shift 时外接正方形 →正圆
    const x = Math.min(x0, x1) * w
    const y = Math.min(y0, y1) * h
    const rw = Math.abs(x1 - x0) * w
    const rh = Math.abs(y1 - y0) * h
    ctx.globalAlpha = isDraft ? 0.9 : 1
    ctx.beginPath()
    ctx.ellipse(x + rw / 2, y + rh / 2, Math.max(0.5, rw / 2), Math.max(0.5, rh / 2), 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
  }
  ctx.restore()
}

function annotationBounds(a) {
  if (a.type === 'line' || a.type === 'rect' || a.type === 'ellipse') {
    return {
      x: Math.min(a.x0 ?? 0, a.x1 ?? 0),
      y: Math.min(a.y0 ?? 0, a.y1 ?? 0),
      w: Math.abs((a.x1 ?? 0) - (a.x0 ?? 0)),
      h: Math.abs((a.y1 ?? 0) - (a.y0 ?? 0)),
    }
  }
  if (a.points?.length) {
    const xs = a.points.map((p) => p.x)
    const ys = a.points.map((p) => p.y)
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
  }
  return null
}

// 框选用的包围盒：在画布包围盒之外，额外覆盖文本框与批注标记（它们是 DOM 批注，没有墨迹包围盒）
function selectBounds(a) {
  if (a.type === 'text') return { x: a.x ?? 0, y: a.y ?? 0, w: a.w ?? 0, h: a.h ?? 0 }
  if (a.type === 'comment') {
    const r = 0.012
    return { x: (a.x ?? 0) - r, y: (a.y ?? 0) - r, w: r * 2, h: r * 2 }
  }
  return annotationBounds(a)
}

// 框选命中：包围盒与选框相交即算选中（细线/笔画只需被框边扫到，不要求完整包住）
function rectsIntersect(a, b) {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
}

// 整组拖动的位移：按类型直接平移（笔画/图形走点或端点，文本框/标记改 x/y）
function translateAnnotation(a, dx, dy) {
  if (a.type === 'text') {
    return {
      ...a,
      x: Math.max(0, Math.min(1 - (a.w ?? 0), (a.x ?? 0) + dx)),
      y: Math.max(0, Math.min(1 - (a.h ?? 0), (a.y ?? 0) + dy)),
    }
  }
  if (a.type === 'comment') {
    return {
      ...a,
      x: Math.max(0, Math.min(1, (a.x ?? 0) + dx)),
      y: Math.max(0, Math.min(1, (a.y ?? 0) + dy)),
    }
  }
  if (a.points?.length) return { ...a, points: a.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
  if (a.x0 == null && a.x1 == null) return a
  return { ...a, x0: (a.x0 ?? 0) + dx, y0: (a.y0 ?? 0) + dy, x1: (a.x1 ?? 0) + dx, y1: (a.y1 ?? 0) + dy }
}

// 两个矩形（CSS px）的并集，用于合并同一帧内的脏区
function rectUnion(a, b) {
  if (!a) return b
  if (!b) return a
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  }
}

// 笔画/图形在画布上的「实际墨迹半径」（CSS px）：线宽的一半 + 圆角帽 + 反锯齿余量。
// 半透明荧光笔的线宽可以是 15-20px 且带圆端，比 points 包围盒大得多；
// 脏矩形重绘若按 points+border 小余量裁剪，会把已存在笔画靠边的笔画边缘清掉却没重绘出来
// → 露出明显的矩形接缝（用户看到的「方形图层」+ 上层更暗）。
function inkPadPx(a, docW) {
  const t = Number(a?.thickness) || 3
  const base =
    a.type === 'highlighter'
      ? Math.max(5, docW * (t / 350))
      : a.type === 'line' || a.type === 'rect' || a.type === 'ellipse'
        ? Math.max(1.5, docW * (t / 800) * 0.5)
        : Math.max(1.5, docW * (t / 800))
  return Math.max(8, Math.ceil(base / 2 + 8))
}

function transformAnnotation(a, original, dx, dy, handle) {
  const minSize = 0.015
  let x = original.bounds.x
  let y = original.bounds.y
  let right = x + original.bounds.w
  let bottom = y + original.bounds.h
  if (handle === 'move') {
    const moveX = Math.max(-x, Math.min(1 - right, dx))
    const moveY = Math.max(-y, Math.min(1 - bottom, dy))
    x += moveX
    y += moveY
    right += moveX
    bottom += moveY
  } else {
    if (handle.includes('l')) x = Math.max(0, Math.min(right - minSize, x + dx))
    if (handle.includes('r')) right = Math.min(1, Math.max(x + minSize, right + dx))
    if (handle.includes('t')) y = Math.max(0, Math.min(bottom - minSize, y + dy))
    if (handle.includes('b')) bottom = Math.min(1, Math.max(y + minSize, bottom + dy))
  }
  const oldW = Math.max(minSize, original.bounds.w)
  const oldH = Math.max(minSize, original.bounds.h)
  const sx = (right - x) / oldW
  const sy = (bottom - y) / oldH
  const map = (p) => ({ x: x + (p.x - original.bounds.x) * sx, y: y + (p.y - original.bounds.y) * sy })
  if (a.points) return { ...a, points: original.points.map(map) }
  return { ...a, x0: map({ x: original.a.x0 ?? 0, y: original.a.y0 ?? 0 }).x, y0: map({ x: original.a.x0 ?? 0, y: original.a.y0 ?? 0 }).y, x1: map({ x: original.a.x1 ?? 0, y: original.a.y1 ?? 0 }).x, y1: map({ x: original.a.x1 ?? 0, y: original.a.y1 ?? 0 }).y }
}

function drawShapeSelection(ctx, a, w, h, withHandles = true) {
  const pts = []
  if (a.type === 'line' || a.type === 'rect' || a.type === 'ellipse') {
    pts.push({ x: (a.x0 ?? 0) * w, y: (a.y0 ?? 0) * h })
    pts.push({ x: (a.x1 ?? 0) * w, y: (a.y1 ?? 0) * h })
  } else if (a.points && a.points.length) {
    for (const p of a.points) pts.push({ x: p.x * w, y: p.y * h })
  }
  if (!pts.length) return
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  const rw = Math.max(...xs) - x
  const rh = Math.max(...ys) - y
  ctx.save()
  ctx.setLineDash([6, 4])
  ctx.strokeStyle = '#007aff'
  ctx.lineWidth = 2
  ctx.globalAlpha = 0.95
  const pad = 6
  ctx.strokeRect(x - pad, y - pad, rw + pad * 2, rh + pad * 2)
  ctx.setLineDash([])
  // 多选时每个批注只画虚线框，不画四角手柄（否则一屏手柄会糊成一片）
  if (!withHandles) {
    ctx.restore()
    return
  }
  const hs = 8
  const corners = [
    [x - pad, y - pad],
    [x + rw + pad, y - pad],
    [x - pad, y + rh + pad],
    [x + rw + pad, y + rh + pad],
  ]
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = '#007aff'
  for (const [cx, cy] of corners) {
    ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs)
    ctx.strokeRect(cx - hs / 2, cy - hs / 2, hs, hs)
  }
  ctx.restore()
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

function hitTestAnnotation(a, px, py, w, h, extraTolerance = 0) {
  const tolerance = Math.max(12, Number(extraTolerance) || 0)
  if (a.type === 'line') {
    return distToSegment(px, py, (a.x0 ?? 0) * w, (a.y0 ?? 0) * h, (a.x1 ?? 0) * w, (a.y1 ?? 0) * h) <= tolerance
  }
  if (a.type === 'rect' || a.type === 'ellipse') {
    const x = Math.min(a.x0 ?? 0, a.x1 ?? 0) * w
    const y = Math.min(a.y0 ?? 0, a.y1 ?? 0) * h
    const rw = Math.abs((a.x1 ?? 0) - (a.x0 ?? 0)) * w
    const rh = Math.abs((a.y1 ?? 0) - (a.y0 ?? 0)) * h
    // Shapes intentionally use a generous hit box: touch/clicking inside a shape selects it.
    return px >= x - tolerance && px <= x + rw + tolerance && py >= y - tolerance && py <= y + rh + tolerance
  }
  if ((a.type === 'brush' || a.type === 'highlighter') && a.points && a.points.length >= 2) {
    for (let i = 1; i < a.points.length; i++) {
      if (distToSegment(px, py, a.points[i - 1].x * w, a.points[i - 1].y * h, a.points[i].x * w, a.points[i].y * h) <= tolerance) return true
    }
  }
  return false
}
function eraseStrokeAtPoint(a, px, py, w, h, radius) {
  if (!(a.type === 'brush' || a.type === 'highlighter') || !a.points || a.points.length < 2) return [a]
  const thickness = Math.max(1, Number(a.thickness) || 3) / 2
  const pieces = []
  let current = []
  let erased = false
  const flush = () => {
    if (current.length >= 2) pieces.push(current)
    current = []
  }
  for (let i = 1; i < a.points.length; i++) {
    const p0 = a.points[i - 1]
    const p1 = a.points[i]
    // One segment-distance check is enough here; dense interpolation per pointer event
    // made pixel erasing disproportionately expensive on long strokes.
    const hit = distToSegment(px, py, p0.x * w, p0.y * h, p1.x * w, p1.y * h) <= radius + thickness
    if (hit) {
      erased = true
      flush()
    } else {
      if (!current.length) current.push(p0)
      current.push(p1)
    }
  }
  flush()
  if (!erased) return [a]
  return pieces.map((points) => ({ ...a, id: uid(), points }))
}

function eraseAnnotationsAtPoint(list, point, w, h, mode, size) {
  const px = point.x * w
  const py = point.y * h
  const radius = Math.max(2, Number(size) || 16)
  let changed = false
  const next = []
  for (const a of list) {
    if (!(a.type === 'brush' || a.type === 'highlighter')) {
      next.push(a)
      continue
    }
    if (mode === 'stroke') {
      if (hitTestAnnotation(a, px, py, w, h, radius)) changed = true
      else next.push(a)
      continue
    }
    const pieces = eraseStrokeAtPoint(a, px, py, w, h, radius)
    if (pieces.length !== 1 || pieces[0] !== a) changed = true
    next.push(...pieces)
  }
  return { list: changed ? next : list, changed }
}

function textToBlocks(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i += 1
      continue
    }
    // 分页标记：单独成块的「新页」，不是可编辑文字（老文件里的 HTML 注释写法也认）
    if (line.trim() === MD_PAGE_BREAK || line.trim() === '<!-- pagebreak -->') {
      blocks.push({ id: uid(), type: 'pagebreak', text: '' })
      i += 1
      continue
    }
    if (line.trim().startsWith('```')) {
      const code = []
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        code.push(lines[i])
        i += 1
      }
      i += 1
      blocks.push({ id: uid(), type: 'code', text: code.join('\n') })
      continue
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/)
    if (heading) {
      blocks.push({ id: uid(), type: `h${heading[1].length}`, text: heading[2] })
      i += 1
      continue
    }
    const todo = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/)
    if (todo) {
      blocks.push({
        id: uid(),
        type: 'todo',
        checked: todo[1].toLowerCase() === 'x',
        text: todo[2],
      })
      i += 1
      continue
    }
    if (line.startsWith('>')) {
      const quote = []
      while (i < lines.length && lines[i].startsWith('>')) {
        quote.push(lines[i].replace(/^>\s?/, ''))
        i += 1
      }
      blocks.push({ id: uid(), type: 'quote', text: quote.join('\n') })
      continue
    }
    const paragraph = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      lines[i].trim() !== MD_PAGE_BREAK &&
      !/^(#{1,3})\s/.test(lines[i]) &&
      !/^[-*]\s+\[[ xX]\]/.test(lines[i]) &&
      !lines[i].startsWith('>') &&
      !lines[i].trim().startsWith('```')
    ) {
      paragraph.push(lines[i])
      i += 1
    }
    blocks.push({ id: uid(), type: 'p', text: paragraph.join('\n') })
  }
  if (blocks.length === 0) blocks.push({ id: uid(), type: 'p', text: '' })
  return blocks
}

function blocksToMarkdown(blocks, texts) {
  return blocks
    .map((block) => {
      // 分页块本身没有文字：直接落成 \pagebreak 行，读回时仍是一个分页块
      if (block.type === 'pagebreak') return MD_PAGE_BREAK
      const text = (texts?.[block.id] ?? block.text ?? '').trimEnd()
      if (block.type === 'h1') return `# ${text}`
      if (block.type === 'h2') return `## ${text}`
      if (block.type === 'h3') return `### ${text}`
      if (block.type === 'todo') return `- [${block.checked ? 'x' : ' '}] ${text}`
      if (block.type === 'quote') return text.split('\n').map((l) => `> ${l}`).join('\n')
      if (block.type === 'code') return '```\n' + text + '\n```'
      return text
    })
    .filter((line) => line !== '')
    .join('\n\n')
}

function markdownForPreview(md) {
  let inFence = false
  return String(md || '')
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      // 代码块里的同名行不动，避免把示例代码渲染成分页线
      if (!inFence && line.trim() === MD_PAGE_BREAK) {
        return '<div class="md-page-break">新页</div>'
      }
      return line
    })
    .join('\n')
}

function placeCaretAtEnd(el) {
  if (!el) return
  if (el.tagName === 'TEXTAREA') {
    el.selectionStart = el.selectionEnd = el.value.length
    return
  }
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
}

function isCaretAtStart(el) {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return false
  const range = sel.getRangeAt(0)
  if (!el.contains(range.startContainer)) return false
  const pre = document.createRange()
  pre.selectNodeContents(el)
  pre.setEnd(range.startContainer, range.startOffset)
  return pre.toString().length === 0
}

function getRangeOffsets(root, range) {
  const pre = document.createRange()
  pre.selectNodeContents(root)
  pre.setEnd(range.startContainer, range.startOffset)
  return {
    start: pre.toString().length,
    end: pre.toString().length + range.toString().length,
    text: range.toString(),
  }
}

function createRangeByOffsets(root, start, end) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let offset = 0
  let startNode = null
  let startOff = 0
  let endNode = null
  let endOff = 0
  let node
  while ((node = walker.nextNode())) {
    const len = node.textContent.length
    if (startNode === null && offset + len >= start) {
      startNode = node
      startOff = start - offset
    }
    if (offset + len >= end) {
      endNode = node
      endOff = end - offset
      break
    }
    offset += len
  }
  if (!startNode || !endNode) return null
  const range = document.createRange()
  range.setStart(startNode, Math.min(startOff, startNode.textContent.length))
  range.setEnd(endNode, Math.min(endOff, endNode.textContent.length))
  return range
}

function applyDocxHighlights(root, highlights) {
  // 先移除旧 mark（保留文本内容）
  root.querySelectorAll('mark[data-ann]').forEach((mark) => {
    mark.replaceWith(...mark.childNodes)
  })
  // 收集每个文本节点上需要高亮的 [localStart, localEnd) 段（基于原始文本偏移）
  const segsByNode = new Map()
  for (const h of highlights) {
    if (!h || h.end <= h.start) continue
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let offset = 0
    let node
    while ((node = walker.nextNode())) {
      const len = node.textContent.length
      const segStart = Math.max(h.start, offset)
      const segEnd = Math.min(h.end, offset + len)
      if (segEnd > segStart) {
        const list = segsByNode.get(node) || []
        list.push({ s: segStart - offset, e: segEnd - offset, color: h.color || '#ffe58f' })
        segsByNode.set(node, list)
      }
      offset += len
      if (offset >= h.end) break
    }
  }
  // 就地拆分：把段内文字用<mark> 包住，不抽取/重插 DOM →不会导致文本换行
  for (const [origNode, segs] of segsByNode) {
    segs.sort((a, b) => a.s - b.s)
    let node = origNode
    for (let i = segs.length - 1; i >= 0; i--) {
      const { s, e, color } = segs[i]
      const text = node.textContent
      if (s < 0 || e > text.length || e <= s) continue
      const before = text.slice(0, s)
      const mid = text.slice(s, e)
      const after = text.slice(e)
      const mark = document.createElement('mark')
      mark.dataset.ann = '1'
      mark.style.backgroundColor = color
      mark.style.borderRadius = '2px'
      mark.textContent = mid
      const frag = document.createDocumentFragment()
      if (before) frag.appendChild(document.createTextNode(before))
      frag.appendChild(mark)
      if (after) frag.appendChild(document.createTextNode(after))
      node.parentNode.replaceChild(frag, node)
      node = before ? frag.firstChild : null
      if (!node) break
    }
  }
}

export default function App() {
  const [recent, setRecent] = useState(() => getRecent())
  const [tabs, setTabs] = useState([{ id: 'home', kind: 'home', title: '主屏幕' }])
  const [activeTabId, setActiveTabId] = useState('home')
  const [toast, setToast] = useState(null)
  const [picking, setPicking] = useState(false)
  const toastTimer = useRef(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const notify = useCallback((message, type = 'info') => {
    setToast({ message, type })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 3200)
  }, [])

  const addTab = useCallback((entry) => {
    const tab = {
      id: `tab-${entry.id}`,
      kind: 'file',
      title: entry.name,
      type: entry.type,
      entry,
    }
    setTabs((prev) => (prev.some((t) => t.id === tab.id) ? prev : [...prev, tab]))
    setActiveTabId(tab.id)
  }, [])

  const handlePickFiles = useCallback(async () => {
    setPicking(true)
    try {
      const entries = await pickFiles()
      if (entries.length === 0) return
      let lastPdfId = null
      for (const entry of entries) {
        try {
          await putFileHandle(entry)
        } catch {
          // 句柄持久化失败时仍可在本次会话打开
        }
        setRecent(addRecent(entry))
        addTab(entry)
        if (entry.type === FILE_TYPES.PDF) lastPdfId = entry.id
      }
      // 选择 PDF 后直接把焦点放到 Open PDF Studio。
      if (lastPdfId) setActiveTabId('tab-' + lastPdfId)
      notify(`已打开 ${entries.length} 个文件`, 'success')
    } catch (err) {
      if (err?.name !== 'AbortError') {
        notify(err?.message || '打开文件失败', 'error')
      }
    } finally {
      setPicking(false)
    }
  }, [addTab, notify])

  const openRecent = useCallback(
    async (item) => {
      try {
        const handle = await getFileHandle(item.id)
        if (!handle) {
          notify('找不到该文件，请重新打开', 'error')
          return
        }
        if (!(await ensurePermission(handle))) {
          notify('文件权限已失效，请重新打开文件', 'error')
          return
        }
        const file = await handle.getFile()
        // 用扩展名重新检测类型：旧会话中 txt 曾被归为 markdown，此处修正为纯文本
        const entry = { ...item, type: detectType(item.name), file, handle }
        await putFileHandle(entry)
        setRecent(addRecent(entry))
        addTab(entry)
      } catch (err) {
        notify(`打开文件失败：${err.message}`, 'error')
      }
    },
    [addTab, notify],
  )

  const selectTab = useCallback((id) => setActiveTabId(id), [])

  const closeTab = useCallback(
    (id) => {
      const idx = tabs.findIndex((t) => t.id === id)
      if (idx === -1 || tabs[idx].kind === 'home') return
      const next = tabs.filter((t) => t.id !== id)
      setTabs(next)
      if (activeTabId === id) {
        const fallback = next[Math.max(0, idx - 1)]
        setActiveTabId(fallback ? fallback.id : 'home')
      }
    },
    [tabs, activeTabId],
  )

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0]
  const sidebar = usePanel('sidebar')

  // ⌘/Ctrl+B：折叠/展开侧边栏（与 macOS 习惯一致）
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        sidebar.toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sidebar])

  return (
    <div className="app">
      <aside
        className={`sidebar ${mobileMenuOpen ? 'mobile-open' : ''} ${sidebar.collapsed ? 'collapsed' : ''}`}
        style={sidebar.collapsed ? undefined : { width: `${sidebar.width}px`, minWidth: `${sidebar.min}px`, maxWidth: `${sidebar.max}px` }}
      >
        <div className="sidebar-brand">
          <button className="mobile-menu-button icon-btn" onClick={() => setMobileMenuOpen(false)} aria-label="关闭菜单"><X size={18} /></button>
          <PenLine size={17} color="currentColor" />
          <span>笔记工作台</span>
          <em>Web MVP</em>
          {/* 折叠开关固定在侧边栏右上角（与其他侧栏一致） */}
          <button
            className="panel-collapse-btn sidebar-collapse icon-btn"
            title="折叠侧边栏（⌘B）"
            aria-label="折叠侧边栏"
            aria-expanded="true"
            onClick={() => sidebar.setCollapsed(true)}
          >
            <PanelLeft size={16} />
          </button>
        </div>
        <button className="folder-btn" onClick={handlePickFiles} disabled={picking}>
          <FilePlus2 size={16} />
          <span>{picking ? '选择中…' : '打开文件'}</span>
        </button>
        {/* 导航项放在同一容器里，保证图标与文字左右对齐 */}
        <nav className="side-nav">
          <button
            className={`nav-item ${activeTab.kind === 'home' ? 'active' : ''}`}
            onClick={() => { selectTab('home'); setMobileMenuOpen(false) }}
          >
            <Home size={16} />
            <span>欢迎页</span>
          </button>
          <button
            className="nav-item"
            onClick={() => setSettingsOpen(true)}
            title="设置：窗口与面板布局"
          >
            <SlidersHorizontal size={16} />
            <span>设置</span>
          </button>
        </nav>
        <div className="tree-title">最近打开</div>
        <div className="tree-scroll">
          {recent.length === 0 ? (
            <div className="tree-empty">打开文件后显示最近记录</div>
          ) : (
            recent.map((item) => {
              const meta = TYPE_META[item.type] || TYPE_META.unknown
              const Icon = meta.icon
              return (
                <button key={item.id} className="tree-row" onClick={() => openRecent(item)}>
                  <Icon size={14} color={meta.color} />
                  <span className="tree-label">{item.name}</span>
                </button>
              )
            })
          )}
        </div>
      </aside>
      {sidebar.collapsed && (
        <div className="panel-rail sidebar-rail" aria-label="侧边栏已折叠">
          <button
            className="panel-rail-btn icon-btn"
            title="展开侧边栏（⌘B）"
            aria-label="展开侧边栏"
            aria-expanded="false"
            onClick={() => sidebar.setCollapsed(false)}
          >
            <PanelLeft size={16} />
          </button>
        </div>
      )}
      {!sidebar.collapsed && <PanelSplitter panel="sidebar" edge="right" title="拖动调整侧边栏宽度（双击恢复默认，回车折叠，⌘B）" />}
      <main className="main">
        <TabBar
          tabs={tabs}
          activeId={activeTabId}
          onSelect={selectTab}
          onClose={closeTab}
          onMenu={() => setMobileMenuOpen(true)}
          sidebarCollapsed={sidebar.collapsed}
          onToggleSidebar={() => sidebar.toggle()}
        />
        <div className="content">
          {activeTab.kind === 'home' ? (
            <HomeView recent={recent} onOpenRecent={openRecent} onPickFiles={handlePickFiles} />
          ) : (
            <FileView key={activeTab.id} entry={activeTab.entry} notify={notify} />
          )}
        </div>
      </main>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} notify={notify} />
      <StatusToast toast={toast} />
    </div>
  )
}

function TabBar({ tabs, activeId, onSelect, onClose, onMenu, sidebarCollapsed, onToggleSidebar }) {
  return (
    <div className="tabbar">
      <button className="mobile-menu-button icon-btn" onClick={onMenu} aria-label="打开菜单"><SlidersHorizontal size={18} /></button>
      {onToggleSidebar && (
        <button
          className={`icon-btn tabbar-panel-toggle ${sidebarCollapsed ? '' : 'active'}`}
          onClick={onToggleSidebar}
          title={sidebarCollapsed ? '展开侧边栏（⌘B）' : '折叠侧边栏（⌘B）'}
          aria-label={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
          aria-pressed={!sidebarCollapsed}
        >
          <PanelLeft size={16} />
        </button>
      )}
      {tabs.map((tab) => {
        const meta = tab.kind === 'file' ? TYPE_META[tab.type] : null
        const Icon = tab.kind === 'home' ? Home : meta?.icon || FileIcon
        return (
          <div
            key={tab.id}
            className={`tab ${activeId === tab.id ? 'active' : ''}`}
            onClick={() => onSelect(tab.id)}
          >
            <Icon size={14} style={meta ? { color: meta.color } : undefined} />
            <span className="tab-title">{tab.title}</span>
            {tab.kind !== 'home' && (
              <button
                className="tab-close"
                title="关闭标签页"
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(tab.id)
                }}
              >
                <X size={13} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

function HomeView({ recent, onOpenRecent, onPickFiles }) {
  return (
    <div className="home">
      <header className="home-header home-header-row">
        <div>
          <h1>欢迎页</h1>
          <p>最近打开的5 个文件，点击即可打开</p>
        </div>
      </header>
      {recent.length === 0 ? (
        <div className="home-empty">
          <FilePlus2 size={42} color="currentColor" />
          <p>还没有最近文件</p>
          <button className="primary-btn" onClick={onPickFiles}>
            <FilePlus2 size={15} />
            打开文件
          </button>
        </div>
      ) : (
        <div className="recent-grid">
          {recent.slice(0, 5).map((item) => (
            <RecentCard key={item.id} item={item} onClick={() => onOpenRecent(item)} />
          ))}
        </div>
      )}
      <div className="home-hint">
        最近文件可跨会话重新打开；批注JSON 会在首次保存时选择保存位置。      </div>
    </div>
  )
}

function RecentCard({ item, onClick }) {
  const meta = TYPE_META[item.type] || TYPE_META.unknown
  const Icon = meta.icon
  const canvasRef = useRef(null)
  const [snippet, setSnippet] = useState('')
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const handle = await getFileHandle(item.id)
        if (!handle) {
          if (!cancelled) setMissing(true)
          return
        }
        const file = await handle.getFile()
        if (item.type === FILE_TYPES.PDF && canvasRef.current) {
          const pdf = await openPdf(file)
          await renderPdfPage(pdf, 1, canvasRef.current, 0.5)
        } else if (item.type === FILE_TYPES.MARKDOWN) {
          const text = await readText(file)
          if (!cancelled) setSnippet(text.trim().slice(0, 160) || '（空文件）')
        }
      } catch {
        // 缩略图失败时保留图标占位
      }
    })()
    return () => {
      cancelled = true
    }
  }, [item.id, item.type])

  return (
    <div
      className="recent-card"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick()
      }}
    >
      <div className="card-thumb">
        {item.type === FILE_TYPES.PDF ? (
          <canvas ref={canvasRef} className="thumb-canvas" />
        ) : item.type === FILE_TYPES.MARKDOWN ? (
          <div className="thumb-snippet">{snippet || '加载预览中…'}</div>
        ) : (
          <Icon size={44} color={meta.color} strokeWidth={1.4} />
        )}
        {missing && <span className="card-badge">需重新打开</span>}
      </div>
      <div className="card-info">
        <div className="card-name" title={item.name}>
          {item.name}
        </div>
        <div className="card-meta">
          <span>{meta.label}</span>
          <span>{formatBytes(item.size)}</span>
          <span>{formatDate(item.lastModified)}</span>
        </div>
      </div>
    </div>
  )
}

function FileView({ entry, notify }) {
  if (entry.type === FILE_TYPES.PDF) {
    return <PdfView entry={entry} notify={notify} />
  }
  if (entry.type === FILE_TYPES.DOCX) {
    return <DocxView entry={entry} notify={notify} />
  }
  if (entry.type === FILE_TYPES.MARKDOWN) {
    return <MarkdownView entry={entry} notify={notify} />
  }
  if (entry.type === FILE_TYPES.TEXT) {
    return <TextView entry={entry} notify={notify} />
  }
  if (entry.type === FILE_TYPES.EXCEL) {
    return <ExcelView entry={entry} notify={notify} />
  }
  if (entry.type === FILE_TYPES.EPUB) {
    return <EpubView entry={entry} notify={notify} />
  }
  if (entry.type === FILE_TYPES.CAJ) {
    return <CajView entry={entry} notify={notify} />
  }
  return <OfficeView entry={entry} notify={notify} />
}

function ToolButton({ active, title, icon: Icon, color, onClick, onDoubleClick, onContextMenu, btnRef, disabled, hasSettings = false }) {
  return (
    <button
      ref={btnRef}
      className={`icon-btn ${active ? 'active' : ''} ${hasSettings ? 'has-settings' : ''}`}
      title={title}
      // 工具按钮是切换按钮：读屏需要知道「选中/未选中」。
      // active 为 undefined 时（撤销/保存等纯动作按钮）不输出 aria-pressed，避免被当成开关。
      aria-pressed={active === undefined ? undefined : Boolean(active)}
      aria-label={title}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault()
              onContextMenu()
            }
          : undefined
      }
      disabled={disabled}
    >
      <Icon size={16} style={color ? { color } : undefined} />
      {/* 有设置的工具有个小角标，提示「再点一次/双击/右键」可打开设置 */}
      {hasSettings && <span className="tool-settings-dot" aria-hidden="true" />}
    </button>
  )
}

// ribbon 大按钮：图标在上、标签在下（open-pdf-studio 风格）
function RibbonBtn({ active, title, icon: Icon, color, label, onClick, onDoubleClick }) {
  return (
    <button
      className={`ribbon-btn ${active ? 'active' : ''}`}
      title={title}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <span className="ribbon-btn-icon" style={color ? { color } : undefined}>
        <Icon size={20} />
      </span>
      <span className="ribbon-btn-label">{label}</span>
    </button>
  )
}

// ribbon 文本小按钮
function RibbonTextBtn({ active, title, label, onClick }) {
  return (
    <button
      className={`ribbon-text-btn ${active ? 'active' : ''}`}
      title={title}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function TextBox({
  ann,
  scale = 1,
  editing,
  selected,
  onSelect,
  onStartEdit,
  onCommit,
  onMove,
  onResize,
  onDelete,
}) {
  const boxRef = useRef(null)
  const dragRef = useRef(null)
  // 字号要跟随页面缩放：框的宽高是「文档宽度百分比」，会自动缩放；字号是固定 px，
  // 必须乘上查看器缩放倍数，否则放大页面后文字还是原样大小，看着像没贴住页面。
  // 字体/粗斜/下划线/对齐/颜色同样从批注上读，所以「编辑时」和「编辑完」长得一模一样（WYSIWYG）。
  const style = {
    left: `${ann.x * 100}%`,
    top: `${ann.y * 100}%`,
    width: `${ann.w * 100}%`,
    height: `${ann.h * 100}%`,
    ...textStyleToCss(ann, scale),
    pointerEvents: 'auto',
  }

  const updateFromPointer = (e) => {
    const d = dragRef.current
    if (!d || !boxRef.current) return
    const rect = boxRef.current.parentElement.getBoundingClientRect()
    const dx = (e.clientX - d.startX) / rect.width
    const dy = (e.clientY - d.startY) / rect.height
    if (Math.abs(dx) > 0.002 || Math.abs(dy) > 0.002) d.moved = true
    if (d.mode === 'move') {
      onMove(ann.id, clamp01(d.origX + dx), clamp01(d.origY + dy))
    } else if (d.mode === 'resize') {
      // 最小尺寸用屏幕像素折算成归一化值：和新建文本一样，不能直接写死 0.05/0.03 这种
      // 「相对整篇文档」的比例 —— 几十页的 PDF 里 0.03 就是一千多像素，框根本缩不进去。
      // rect 是 .ann-dom（覆盖整篇文档）的尺寸，所以 12/rect.height 就是「不小于 12 屏幕像素」。
      const minW = 24 / rect.width
      const minH = 12 / rect.height
      const w = Math.max(minW, clamp01(d.origW + dx))
      const h = Math.max(minH, clamp01(d.origH + dy))
      onResize(ann.id, d.origX, d.origY, w, h)
    }
  }

  const handlePointerDown = (e) => {
    if (
      editing ||
      e.target.classList.contains('text-resize') ||
      e.target.classList.contains('ann-del')
    ) {
      return
    }
    e.preventDefault()
    e.stopPropagation()
    boxRef.current.setPointerCapture(e.pointerId)
    dragRef.current = {
      mode: 'move',
      startX: e.clientX,
      startY: e.clientY,
      origX: ann.x,
      origY: ann.y,
      moved: false,
    }
  }

  const handlePointerMove = (e) => {
    if (!dragRef.current) return
    e.preventDefault()
    updateFromPointer(e)
  }

  const handlePointerUp = () => {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null
    if (d.mode === 'move' && !d.moved) onSelect()
  }

  const handleResizeDown = (e) => {
    e.preventDefault()
    e.stopPropagation()
    boxRef.current.setPointerCapture(e.pointerId)
    dragRef.current = {
      mode: 'resize',
      startX: e.clientX,
      startY: e.clientY,
      origX: ann.x,
      origY: ann.y,
      origW: ann.w,
      origH: ann.h,
      moved: false,
    }
  }

  if (editing) {
    return (
      <textarea
        ref={boxRef}
        className="ann-text-editor"
        data-ann-id={ann.id}
        style={style}
        autoFocus
        defaultValue={ann.text}
        placeholder="输入文字"
        onBlur={(e) => onCommit(ann.id, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') e.currentTarget.blur()
        }}
        onPointerDown={(e) => e.stopPropagation()}
      />
    )
  }

  return (
    <div
      ref={boxRef}
      className={`ann-text ${selected ? 'selected' : ''}`}
      data-ann-id={ann.id}
      style={style}
      title={ann.text || '单击选中，双击编辑'}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onStartEdit()
      }}
    >
      <span className="ann-text-content">{ann.text || ''}</span>
      {selected && (
        <>
          <button
            className="ann-del"
            title="删除"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
          >
            <X size={12} />
          </button>
          <span className="text-resize" onPointerDown={handleResizeDown} />
        </>
      )}
    </div>
  )
}

function CommentMarker({ ann, selected, onSelect, onEdit }) {
  const style = { left: `${ann.x * 100}%`, top: `${ann.y * 100}%`, pointerEvents: 'auto' }
  return (
    <button
      data-ann-id={ann.id}
      className={`ann-comment ${selected ? 'selected' : ''}`}
      style={style}
      title={ann.text || '单击选中，双击编辑'}
      onClick={(e) => {
        e.stopPropagation()
        onSelect()
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onEdit()
      }}
    >
      <MessageSquareText size={15} />
    </button>
  )
}

// 批注栏条目：每种批注类型一个图标 + 名称（列表覆盖全部批注，不再只有批注标记）
const ANN_ITEM_META = {
  brush: { label: '手写', Icon: PenLine },
  highlighter: { label: '荧光笔', Icon: Highlighter },
  line: { label: '直线', Icon: Minus },
  rect: { label: '矩形', Icon: Square },
  ellipse: { label: '椭圆', Icon: Circle },
  text: { label: '文本框', Icon: Type },
  comment: { label: '批注', Icon: MessageSquareText },
  highlight: { label: '文字高亮', Icon: Highlighter },
}

// 批注栏「分类」：按批注种类分组，组头可折叠。
// 数组顺序 = 栏内展示顺序；types 决定归属，没列进任何分类的类型会落到末尾的「其他」，
// 所以任何批注都不会因为分类而看不见。
const ANN_ITEM_GROUPS = [
  { key: 'brush', label: '手写', Icon: PenLine, types: ['brush'] },
  { key: 'highlighter', label: '荧光笔', Icon: Highlighter, types: ['highlighter'] },
  { key: 'mark', label: '文字高亮', Icon: Highlighter, types: ['highlight'] },
  { key: 'shape', label: '图形', Icon: Shapes, types: ['line', 'rect', 'ellipse'] },
  { key: 'text', label: '文本框', Icon: Type, types: ['text'] },
  { key: 'comment', label: '批注', Icon: MessageSquareText, types: ['comment'] },
]

// 条目摘要：文本框/批注显示文字内容（可双击编辑），手写与图形显示笔点与粗细
function annItemSummary(a) {
  if (a.type === 'text') return a.text || '空文本框'
  if (a.type === 'comment') return a.text || '空批注'
  if (a.type === 'highlight') return a.text || '已高亮文字'
  if (a.type === 'brush' || a.type === 'highlighter') {
    return `${(a.points || []).length} 个笔点 · 粗细 ${a.thickness ?? 3}`
  }
  return `粗细 ${a.thickness ?? 3}`
}

/**
 * 批注栏：列出当前文档的全部批注（手写 / 荧光笔 / 图形 / 文本框 / 批注标记 / 文字高亮）。
 * 单击选中并定位（Ctrl/Cmd/Shift+单击 = 加选，与画布框选的多选共用同一份 selection），
 * 双击文本框 → 滚到该文本框并在页面上原地编辑；双击批注 → 在栏内编辑。多选时标题栏出现「删除选中」。
 */
function AnnPanel({ items, selectedIds, selectIds, focusAnn, editingId, onEdit, onCommit, onDelete, onDeleteMany }) {
  const panel = usePanel('annPanel')
  const list = items || []
  // 折叠的分类（按 group.key 记）。注意：Hook 必须无条件调用，
  // 所以要放在下面「折叠成细栏」的提前 return 之前。
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set())
  const groups = useMemo(() => {
    const buckets = new Map(ANN_ITEM_GROUPS.map((g) => [g.key, []]))
    const other = []
    for (const a of list) {
      const group = ANN_ITEM_GROUPS.find((g) => g.types.includes(a.type))
      // 没归入任何分类的类型（例如以后新增的批注类型）落到「其他」，绝不让批注从栏里消失
      if (group) buckets.get(group.key).push(a)
      else other.push(a)
    }
    const out = ANN_ITEM_GROUPS.map((g) => ({ ...g, items: buckets.get(g.key) })).filter(
      (g) => g.items.length > 0,
    )
    if (other.length) out.push({ key: 'other', label: '其他', Icon: Square, items: other })
    return out
  }, [list])
  if (panel.collapsed) {
    // 折叠后留一条细栏，展开按钮放在右上角（与工具栏开关等效，就地即可恢复）
    return (
      <div className="panel-rail ann-rail" aria-label="批注栏已折叠">
        <button
          className="panel-rail-btn icon-btn"
          title="展开批注栏"
          aria-label="展开批注栏"
          aria-expanded="false"
          onClick={() => panel.setCollapsed(false)}
        >
          <PanelRight size={16} />
        </button>
      </div>
    )
  }
  const selCount = selectedIds?.size || 0
  const pick = (id, additive) => {
    if (additive && selectIds) {
      const next = new Set(selectedIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      selectIds(next)
    } else if (selectIds) {
      selectIds([id])
    }
    focusAnn?.(id)
  }
  return (
    <>
      <PanelSplitter panel="annPanel" edge="left" title="拖动调整批注栏宽度（双击恢复默认，回车折叠）" />
      <aside
        className="ann-panel"
        style={{ width: `${panel.width}px`, minWidth: `${panel.min}px`, maxWidth: `${panel.max}px` }}
      >
      <div className="ann-panel-title">
        <span>批注</span>
        <span>{list.length}</span>
        {selCount > 1 && (
          <button
            className="ann-panel-bulk-del panel-del"
            title={`删除选中的 ${selCount} 个批注`}
            aria-label={`删除选中的 ${selCount} 个批注`}
            onClick={() => (onDeleteMany || onDelete)([...selectedIds])}
          >
            <Trash2 size={12} />
          </button>
        )}
        <button
          className="ann-panel-collapse panel-collapse-btn icon-btn"
          title="折叠批注栏"
          aria-label="折叠批注栏"
          aria-expanded="true"
          onClick={() => panel.setCollapsed(true)}
        >
          <PanelRight size={16} />
        </button>
      </div>
      {list.length === 0 ? (
        <div className="ann-panel-empty">暂无批注</div>
      ) : (
        groups.map((group) => {
          const GroupIcon = group.Icon
          const folded = collapsedGroups.has(group.key)
          return (
            <section className="ann-panel-group" key={group.key}>
              <button
                type="button"
                className={`ann-panel-group-head ${folded ? 'collapsed' : ''}`}
                aria-expanded={!folded}
                title={folded ? `展开「${group.label}」` : `收起「${group.label}」`}
                onClick={() =>
                  setCollapsedGroups((prev) => {
                    const next = new Set(prev)
                    if (next.has(group.key)) next.delete(group.key)
                    else next.add(group.key)
                    return next
                  })
                }
              >
                <ChevronDown size={13} className="ann-panel-group-caret" aria-hidden="true" />
                <GroupIcon size={13} aria-hidden="true" />
                <span className="ann-panel-group-label">{group.label}</span>
                <span className="ann-panel-group-count">{group.items.length}</span>
              </button>
              {folded
                ? null
                : group.items.map((a) => (
                    <AnnPanelItem
                      key={a.id}
                      a={a}
                      active={Boolean(selectedIds?.has(a.id))}
                      editingId={editingId}
                      pick={pick}
                      focusAnn={focusAnn}
                      onEdit={onEdit}
                      onCommit={onCommit}
                      onDelete={onDelete}
                    />
                  ))}
            </section>
          )
        })
      )}
      </aside>
    </>
  )
}

/**
 * 批注栏里的一行。抽成独立组件是为了让「按分类分组」的渲染保持可读，
 * 行为与之前完全一致（单击选中/Ctrl 加选、双击编辑、行内删除）。
 */
function AnnPanelItem({ a, active, editingId, pick, focusAnn, onEdit, onCommit, onDelete }) {
  const meta = ANN_ITEM_META[a.type] || { label: a.type, Icon: PenLine }
  const Icon = meta.Icon
  // 文本框在「页面上原地编辑」（.ann-text-editor 是它唯一的输入框），批注才在栏内编辑。
  // 注意别给文本框这一行也渲染 autoFocus 输入框：拖出新文本框时页面编辑器先拿到焦点，
  // 栏内编辑器随后挂载又把焦点抢走 → 页面编辑器立刻 blur → onBlur 提交空文本 →
  // 文本框刚出现就被关掉，表现为「文字插入无法使用」。
  const isComment = a.type === 'comment'
  const pageEditable = a.type === 'text'
  return (
    <div
      data-panel-id={a.id}
      className={`ann-panel-item ${active ? 'active' : ''}`}
      onClick={(e) => pick(a.id, e.shiftKey || e.ctrlKey || e.metaKey)}
      onDoubleClick={() => {
        if (pageEditable) {
          // 先滚到那个文本框，再进入编辑：页面上的编辑器会自动聚焦
          focusAnn?.(a.id)
          onEdit(a.id)
        } else if (isComment) {
          onEdit(a.id)
        }
      }}
      title={
        pageEditable
          ? '单击选中并定位，双击在页面上编辑文字'
          : isComment
            ? '单击选中，双击编辑批注'
            : '单击选中并定位，Ctrl/⌘+单击加选'
      }
    >
      <div className="ann-panel-head">
        <Icon size={13} />
        {a.color ? <i className="ann-panel-dot" style={{ background: a.color }} /> : null}
        <span>{a.page ? `第${a.page} 页 · ${meta.label}` : meta.label}</span>
        <button
          className="panel-del"
          title={`删除这个${meta.label}`}
          aria-label={`删除这个${meta.label}`}
          onClick={(e) => {
            e.stopPropagation()
            onDelete(a.id)
          }}
        >
          <X size={12} />
        </button>
      </div>
      {isComment && editingId === a.id ? (
        <textarea
          className="ann-panel-input"
          autoFocus
          defaultValue={a.text}
          placeholder="输入批注…"
          onBlur={(e) => onCommit(a.id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') e.currentTarget.blur()
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="ann-panel-text">{annItemSummary(a)}</div>
      )}
    </div>
  )
}

function CommentConnector({ comments, selectedId, children }) {
  const rowRef = useRef(null)
  const [lines, setLines] = useState([])

  useEffect(() => {
    const update = () => {
      const row = rowRef.current
      if (!row) return
      const rowRect = row.getBoundingClientRect()
      const next = []
      for (const c of comments) {
        const marker = row.querySelector(`[data-ann-id="${c.id}"]`)
        const item = row.querySelector(`[data-panel-id="${c.id}"]`)
        if (!marker || !item) continue
        const mRect = marker.getBoundingClientRect()
        const iRect = item.getBoundingClientRect()
        if (mRect.bottom < rowRect.top || mRect.top > rowRect.bottom) continue
        if (iRect.bottom < rowRect.top || iRect.top > rowRect.bottom) continue
        next.push({
          id: c.id,
          x1: mRect.right - rowRect.left,
          y1: (mRect.top + mRect.bottom) / 2 - rowRect.top,
          x2: iRect.left - rowRect.left,
          y2: (iRect.top + iRect.bottom) / 2 - rowRect.top,
        })
      }
      setLines(next)
    }
    update()
    const row = rowRef.current
    if (!row) return
    const ro = new ResizeObserver(update)
    ro.observe(row)
    const scrollEls = row.querySelectorAll('.pdf-scroll, .docx-scroll, .ann-panel')
    scrollEls.forEach((el) => el.addEventListener('scroll', update, { passive: true }))
    window.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      scrollEls.forEach((el) => el.removeEventListener('scroll', update))
      window.removeEventListener('resize', update)
    }
  }, [comments])

  return (
    <div className="doc-body-row comment-connector" ref={rowRef}>
      {children}
      <svg className="connector-svg" width="100%" height="100%" preserveAspectRatio="none">
        {lines.map((l) => (
          <path
            key={l.id}
            className={`connector-line ${selectedId === l.id ? 'selected' : ''}`}
            d={`M ${l.x1} ${l.y1} C ${l.x1 + 36} ${l.y1}, ${l.x2 - 36} ${l.y2}, ${l.x2} ${l.y2}`}
          />
        ))}
      </svg>
    </div>
  )
}

/** PDF 文字视图（备份/回退）：提取文字（Markdown）+ 图片内嵌，不再渲染原 PDF 页面 */
function PdfTextView({ entry, notify }) {
  const [markdown, setMarkdown] = useState('')
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [progress, setProgress] = useState(0)
  const tools = useAnnotTools({ annKey: 'pdf', entry, notify })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const pdf = await openPdf(entry.file, entry.id)
        if (cancelled) return
        const md = await extractPdfMarkdown(pdf, (done, total) => {
          if (!cancelled && total) setProgress(Math.round((done / total) * 100))
        })
        if (cancelled) return
        setMarkdown(md)
        setReady(true)
      } catch (err) {
        if (!cancelled) {
          setFailed(true)
          setReady(true)
          notify(`PDF 提取失败：${err.message}`, 'error')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [entry, notify])

  const html = useMemo(() => renderMarkdownHtml(markdown), [markdown])

  return (
    <div className="doc-view">
      <AnnotToolbar t={tools} />
      <CommentConnector
        comments={tools.list.filter((a) => a.type === 'comment')}
        selectedId={tools.selectedId}
      >
        <div className="docx-scroll">
          {!ready ? (
            <div className="loading">
              {progress > 0 ? `正在提取 PDF 文字与图片…${progress}%` : '正在提取 PDF 文字与图片…'}
            </div>
          ) : failed ? (
            <div className="file-error">PDF 文字提取失败，请重试或检查文件</div>
          ) : !markdown.trim() ? (
            <div className="docx-doc pdf-text-doc annot-surface">
              <div className="pdf-text-empty">
                未提取到文字（可能为扫描件/纯图片PDF），可在下方空白区域使用批注工具。              </div>
              <AnnotOverlay t={tools} />
            </div>
          ) : (
            <div className="docx-doc pdf-text-doc annot-surface">
              <div className="md-body pdf-text-body" dangerouslySetInnerHTML={{ __html: html }} />
              <AnnotOverlay t={tools} />
            </div>
          )}
        </div>
        <AnnPanel
          items={tools.list}
          selectedIds={tools.selectedIds}
          selectIds={tools.selectIds}
          focusAnn={tools.focusAnn}
          editingId={tools.editingId}
          onEdit={(id) => tools.setEditingId(id)}
          onCommit={tools.commitComment}
          onDelete={tools.deleteAnn}
          onDeleteMany={tools.deleteAnns}
        />
      </CommentConnector>
    </div>
  )
}

/** 平滑进度：display 缓慢逼近 target（服务器进度是粗粒度跳变时显得更顺滑）*/
function useSmoothProgress(target) {
  const [display, setDisplay] = useState(0)
  const ref = useRef(0)
  useEffect(() => {
    if (typeof target !== 'number' || Number.isNaN(target)) return
    // 新任务：目标回落，直接对齐
    if (target < ref.current) {
      ref.current = target
      setDisplay(target)
      return
    }
    let raf = 0
    const tick = () => {
      if (ref.current >= target) return
      const next = Math.min(
        target,
        ref.current + Math.max(1, Math.round((target - ref.current) * 0.18)),
      )
      ref.current = next
      setDisplay(next)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target])
  return display
}

/** 转换进度条：percent 为null 时显示不确定进度（条纹滑动动画） */
function ConversionProgress({ percent, stage, compact = false }) {
  const determinate = typeof percent === 'number' && percent >= 0
  return (
    <div className={`convert-progress ${compact ? 'compact' : ''}`}>
      <div className="convert-progress-track">
        <div
          className={`convert-progress-fill ${determinate ? '' : 'indeterminate'}`}
          style={determinate ? { width: `${Math.min(100, Math.max(0, percent))}%` } : undefined}
        />
      </div>
      <div className="convert-progress-meta">
        <span className="convert-progress-stage">{stage || '正在转换…'}</span>
        {determinate && <span className="convert-progress-pct">{Math.round(percent)}%</span>}
      </div>
    </div>
  )
}

/** 文档内链接守卫：锚点/书内章节链接滚动到目标；其余链接阻止跳转，避免点击后离开页面 */
function useDocLinkGuard(docRef, notify) {
  return useCallback(
    (e) => {
      const a = e.target?.closest?.('a[href]')
      if (!a) return
      const href = a.getAttribute('href') || ''
      e.preventDefault()
      const hashIdx = href.indexOf('#')
      const frag = hashIdx >= 0 ? href.slice(hashIdx + 1) : ''
      const filePart = hashIdx >= 0 ? href.slice(0, hashIdx) : href
      let target = null
      // 1) 页内锚点（#id）
      if (frag) {
        try {
          target = docRef.current?.querySelector('#' + CSS.escape(frag))
        } catch {
          // 非法选择器忽略
        }
      }
      // 2) 书内章节链接（如 TOC 的xxx.html#锚）：找到对应章节的分隔标记（epub 合并后全书同文档）
      if (!target && filePart && !/^(https?:|kindle:|mailto:|tel:|blob:|data:|cid:)/i.test(filePart)) {
        const wanted = (() => {
          try {
            return decodeURIComponent(filePart)
          } catch {
            return filePart
          }
        })()
        const marker = [...(docRef.current?.querySelectorAll('.nf-epub-split') || [])].find((hr) => {
          const p = hr.dataset?.nfEpub || ''
          return p === wanted || p.endsWith('/' + wanted.split('/').pop())
        })
        if (marker) target = marker
      }
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      } else {
        notify('文档内链接无法定位目标，已阻止跳转', 'info')
      }
    },
    [notify],
  )
}

/**
 * PDF 阅读 + 批注视图：React 原生页面渲染（只读，不可编辑文字）。
 * 手绘/批注能力与 docx/md/epub 等视图完全一致，复用同一套 useAnnotTools
 * （旁车 JSON 的 pdf 键），由 AnnotToolbar 提供工具条、AnnotOverlay 提供画布。
 */
function PdfView({ entry, notify }) {
  const tools = useAnnotTools({ annKey: 'pdf', entry, notify })
  const comments = tools.list.filter((a) => a.type === 'comment')
  // 「新建一页」在末尾追加了真实空白页 → 整篇变高。批注坐标相对整篇归一化，
  // 必须按「旧高/新高」重标定一次，否则既有手写墨迹会整体往下滑离开原页。
  const handleSurfaceResized = useCallback(
    makeSurfaceRescaleSettler(tools),
    [tools],
  )
  return (
    <div className="doc-view">
      <AnnotToolbar t={tools} showThumbsToggle />
      <CommentConnector comments={comments} selectedId={tools.selectedId}>
        <div className="pdf-annot-host">
          <PdfEditorView
            entry={entry}
            notify={notify}
            onViewerScale={tools.setScaleK}
            onSurfaceResized={handleSurfaceResized}
            overlay={<AnnotOverlay t={tools} />}
          />
        </div>
        <AnnPanel
          items={tools.list}
          selectedIds={tools.selectedIds}
          selectIds={tools.selectIds}
          focusAnn={tools.focusAnn}
          editingId={tools.editingId}
          onEdit={(id) => tools.setEditingId(id)}
          onCommit={tools.commitComment}
          onDelete={tools.deleteAnn}
          onDeleteMany={tools.deleteAnns}
        />
      </CommentConnector>
    </div>
  )
}

/* Legacy PDF view disabled: Open PDF Studio is now the only PDF editor.
function LegacyPdfView({ entry, notify }) {
  const [stirlingReady, setStirlingReady] = useState(null) // null=检测中
  const lastRef = useRef(null)
  // 周期性探测 Stirling：服务随时可能启动 / 停止，不依赖单次挂载检查
  useEffect(() => {
    let cancelled = false
    let timer = 0
    const check = async () => {
      const result = await stirlingHealth(3000)
      if (cancelled) return
      setStirlingReady(Boolean(result.ok))
      const prev = lastRef.current
      if (prev !== null && prev !== Boolean(result.ok)) {
        notify(
          result.ok
            ? `Stirling-PDF 已连接：${stirlingUrl()}${stirlingUrl().startsWith('/') ? '（同源代理）' : ''}`
            : `Stirling-PDF 连接中断：${stirlingUrl()}`,
          result.ok ? 'success' : 'error',
        )
      }
      lastRef.current = Boolean(result.ok)
      timer = setTimeout(check, 5000)
    }
    check()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [notify])
  return (
    <div className="pdf-direct-shell">
      <div className={`pdf-service-banner ${stirlingReady === false ? 'offline' : 'connected'}`}>
        <span>
          {stirlingReady === null
            ? `正在检测 PDF 服务（${stirlingUrl()}）…`
            : stirlingReady
              ? `Stirling-PDF 已连接：${stirlingUrl()}`
              : `Stirling-PDF 未连接：${stirlingUrl()}`}
        </span>
        {stirlingReady && (
          <a className="pdf-service-link" href="/stirling/app" target="_blank" rel="noreferrer">
            打开 Stirling-PDF 工具
          </a>
        )}
      </div>
      <PdfTextView entry={entry} notify={notify} />
    </div>
  )
}


*/

function snapPoint(point, start) {
  const dx = point.x - start.x
  const dy = point.y - start.y
  if (Math.abs(dx) >= Math.abs(dy)) return { x: point.x, y: start.y }
  return { x: start.x, y: point.y }
}

// 把拖拽约束为正形（矩形→正方形、椭圆→正圆）。
// 批注坐标是归一化0~1，要在像素上成正形必须按页面宽高比换算：
// 水平像素距离 = |dx| × aspect（aspect = 页面宽/高）
function constrainCircle(point, start, aspect = 1) {
  const dx = point.x - start.x
  const dy = point.y - start.y
  const wPx = Math.abs(dx) * aspect
  const hPx = Math.abs(dy)
  const size = Math.max(wPx, hPx)
  return {
    x: start.x + (dx < 0 ? -1 : 1) * (size / aspect),
    y: start.y + (dy < 0 ? -1 : 1) * size,
  }
}

// ─── 统一批注层：所有文档视图共享的批注工具（PDF 同款）─────────────────

const ANN_EMPTY = { pdf: [], docx: [], md: [], excel: [], epub: [], ppt: [], caj: [] }

// 空选择集合：单选与多选共用同一个「唯一真源」，复用同一个空 Set 避免每次新建对象
const SEL_EMPTY = new Set()

// 覆盖层画布像素上限（约 2400 万像素 ≈ 96MB）。长文档（连续模式几十页）会远超这个量，
// 超出时按比例降低覆盖层 dpr：手写只略软，但内存与每帧栅格化成本保持可控。
const MAX_OVERLAY_PIXELS = 24e6

/** 通用批注工具 hook：画笔/直线/矩形/圆形/荧光笔/文本框、批注，持久化到旁车JSON 的annKey 键*/
function useAnnotTools({ annKey, entry, notify }) {
  const [annotations, setAnnotations] = useState(ANN_EMPTY)
  const [tool, setTool] = useState('select')
  const [pen, setPen] = useState({ type: 'brush', color: '#e5484d', size: 3 })
  const [penOpen, setPenOpen] = useState(false)
  // 图形工具（直线/矩形/圆形）：已从画笔设置里独立成单独的上栏工具
  const [shape, setShape] = useState({ type: 'line', color: '#007aff', size: 3 })
  const [shapeOpen, setShapeOpen] = useState(false)
  const [highlighter, setHighlighter] = useState({ color: '#f5c518', size: 5 })
  const [highlighterOpen, setHighlighterOpen] = useState(false)
  const [eraser, setEraser] = useState({ type: 'pixel', size: 16 })
  const [eraserOpen, setEraserOpen] = useState(false)
  // 文本框样式（字体/字号/粗斜/下划线/对齐/颜色）：既是「新建文本框的默认样式」，
  // 也是「选中某个文本框时直接改它的样式」——类似 Word 里改字体作用到选区。
  // 对应的「文字格式栏」不是弹层、也没有开关：只要文本框工具处于活动状态、
  // 或正选中/正在编辑某个文本框，它就自动出现在工具条下方（见 AnnotToolbar）。
  // 这样用户不需要去猜「再点一次工具按钮」这类隐藏手势，一眼就能看到字体/字号在哪改。
  const [textStyle, setTextStyle] = useState(DEFAULT_TEXT_STYLE)
  const [saving, setSaving] = useState(false)
  const [needsSaveFile, setNeedsSaveFile] = useState(false)
  const [editingId, setEditingId] = useState(null)
  // 选择：selectedIds 是唯一真源（鼠标框选可以一次选中一批），
  // selectedId 只在「恰好选中一个」时给出 —— 这样浮动手柄 / 文本框 / 批注标记 /
  // 快捷键这些原有单选调用点不用改语义，多选时它们自然不出现。
  const [selectedIds, setSelectedIds] = useState(SEL_EMPTY)
  const selectedId = selectedIds.size === 1 ? [...selectedIds][0] : null
  const setSelectedId = useCallback((id) => {
    setSelectedIds(id == null ? SEL_EMPTY : new Set([id]))
  }, [])
  const selectIds = useCallback((ids) => {
    const next = new Set(ids || [])
    setSelectedIds(next.size ? next : SEL_EMPTY)
  }, [])
  // 框选中的虚线选框（归一化文档坐标）；null = 没有在框选
  const [marquee, setMarquee] = useState(null)
  const [textDraft, setTextDraft] = useState(null)
  const [draftFits, setDraftFits] = useState(false)
  const [shapeDraft, setShapeDraft] = useState(null)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const overlayRef = useRef(null)
  const annDomRef = useRef(null) // .ann-dom 覆盖层（DOM 批注容器），与画布共用同一套几何
  // 当前查看器缩放倍数：文字/标记这些「固定 px」的 DOM 批注要乘以它，跟随页面一起缩放
  const [scaleK, setScaleK] = useState(1)
  const annRef = useRef(ANN_EMPTY)
  const undoStackRef = useRef([]) // 撤销栈：保存历史列表快照
  const redoStackRef = useRef([]) // 重做栈：保存被撤销的列表快照
  const drawingRef = useRef(null)
  const eraserSessionRef = useRef(null)
  const eraserFrameRef = useRef(null)
  const eraserPendingPointRef = useRef(null)
  const eraserCursorBoundsRef = useRef(null) // 上一帧橡皮光标的 bbox（用于清掉残影）
  const eraserCursorRef = useRef(null)
  const drawFrameRef = useRef(null)
  const pendingRegionRef = useRef(null) // 同一帧内累积的脏矩形
  const paintedRef = useRef(null) // 画布上当前可信的区域；null 表示「需要全量」
  const scrollerRef = useRef(null) // 覆盖层所在滚动容器（寻找一次并缓存）
  // overlayLeft：画布相对父容器左侧的偏移（PDF 视图里页面比容器窄、且居中）。
  // 供「和画布同坐标系」的浮层（橡皮光标）换算像素位置用。
  const geomRef = useRef({ docW: 0, docH: 0, dpr: 1, bandTop: 0, bandH: 0, overlayLeft: 0 }) // 文档尺寸 + 当前视口条带
  const roRef = useRef(null) // 观察容器尺寸变化（PDF 解析完成 / 栏宽变化 / 窗口缩放）
  const overlayBoxRef = useRef(null)
  const refreshBandRef = useRef(null) // 稳定引用，供回调 ref / ResizeObserver 调用最新实现
  const textDragRef = useRef(null)
  const transformRef = useRef(null)
  const marqueeRef = useRef(null) // 框选会话：起点 / 是否加选 / 拖动前已选中的集合
  const moveGroupRef = useRef(null) // 整组拖动会话：ids + 起始点 + 起始快照
  const touchRef = useRef(new Map()) // 触摸中的 pointerId -> 最新位置
  const panRef = useRef(null) // 双指滚动会话（画布是 touch-action:none，浏览器不会替我们滚）
  const cancelEditRef = useRef(false)
  const saveTimer = useRef(null)
  const draftRef = useRef(null)

  const list = annotations[annKey] || []

  // 加载旁车批注
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const ann = await loadAnnotations(entry)
        if (cancelled) return
        annRef.current = { ...ANN_EMPTY, ...ann }
        undoStackRef.current = []
        redoStackRef.current = []
        setCanUndo(false)
        setCanRedo(false)
        setAnnotations(annRef.current)
      } catch (err) {
        if (!cancelled) notify(`批注加载失败：${err.message}`, 'error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [entry, notify])

  // 覆盖层所在的可滚动祖先（PDF / Word / Markdown / EPUB / Excel 各自的滚动容器）
  const findScroller = useCallback((el) => {
    let node = el?.parentElement || null
    while (node && node !== document.body) {
      const st = getComputedStyle(node)
      if (/(auto|scroll|overlay)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 4) return node
      node = node.parentElement
    }
    return null
  }, [])

  // 画布几何：只覆盖「视口所在的横向条带」，而不是整篇文档。
  // 这是手写流畅度的关键——文档级画布（45 页 ≈ 626×38300 像素）每次更新都要重传整块纹理，
  // 实测每帧主线程 ~40ms（≈24fps）；改成视口条带后纹理只有几百 KB，滚动/落笔都不掉帧。
  // 顶部/底部各多留半屏（pad），条带内滚动无需重绘，且内容始终按文档坐标绘制，不会错位。
  //
  // 宽度基准必须是「页面在缩放后的实际宽度」，不能拿滚动容器宽度当 docW：
  // 滚动容器宽度不随缩放变化（fit-width 时页面 777px、容器却有 825px），
  // 拿它做归一化基准 -> 批注的 x/w 全部按固定宽度换算，放大页面时涂鸦和文本框
  // 宽度纹丝不动、只有高度跟着长（高度基准是容器内容高 = 会随缩放变）。
  const syncCanvasGeometry = useCallback(() => {
    const el = overlayRef.current
    if (!el) return null
    const box = el.parentElement
    if (!box) return null
    // 以首个页面元素为准（PDF 的 .pdf-page）：它躺在缩放后的实际宽度上。
    // 非 PDF 文档没有 .pdf-page 时回落回容器宽度（原行为）。
    const pageEl = box.querySelector('.pdf-page')
    const boxRect = box.getBoundingClientRect()
    const pageRect = pageEl ? pageEl.getBoundingClientRect() : null
    const docW = pageRect ? (pageEl.clientWidth || box.clientWidth) : box.clientWidth
    const docH = box.clientHeight
    if (!docW || !docH) return null
    const scroller = scrollerRef.current || findScroller(el)
    scrollerRef.current = scroller
    const viewTop = scroller ? scroller.getBoundingClientRect().top : 0
    const viewH = scroller ? scroller.clientHeight : window.innerHeight
    const pad = Math.max(120, Math.round(viewH * 0.5))
    const bandTop = Math.max(0, Math.min(docH, viewTop - boxRect.top) - pad)
    const bandH = Math.max(1, Math.min(docH - bandTop, viewH + pad * 2))
    // 曲面（画布 + .ann-dom）横向跟随页面：left = 页面相对容器左侧的偏移，不再固定铺满容器
    const overlayLeft = pageRect ? pageRect.left - boxRect.left : 0
    const prev = geomRef.current
    const bandChanged = prev.bandTop !== bandTop || prev.bandH !== bandH || prev.docW !== docW || prev.docH !== docH
    // 条带仍然给像素上限兜底（极端窗口尺寸下不至于分配过大后备缓冲）
    const dpr = Math.min(
      window.devicePixelRatio || 1,
      Math.max(0.5, Math.sqrt(MAX_OVERLAY_PIXELS / (docW * bandH))),
    )
    const bw = Math.max(1, Math.round(docW * dpr))
    const bh = Math.max(1, Math.round(bandH * dpr))
    let resized = false
    if (el.width !== bw || el.height !== bh) {
      el.width = bw // 改尺寸会清空画布，必须重绘
      el.height = bh
      resized = true
    }
    if (bandChanged) {
      el.style.top = `${Math.round(bandTop)}px`
      el.style.bottom = 'auto'
      el.style.height = `${Math.round(bandH)}px`
      el.style.left = `${Math.round(overlayLeft)}px`
      el.style.width = `${Math.round(docW)}px`
      const dom = annDomRef.current
      if (dom) {
        dom.style.left = `${Math.round(overlayLeft)}px`
        dom.style.width = `${Math.round(docW)}px`
      }
    }
    if (resized || bandChanged) paintedRef.current = null
    geomRef.current = { docW, docH, dpr, bandTop, bandH, overlayLeft }
    return { ...geomRef.current, resized, bandChanged }
  }, [findScroller])

  const paint = useCallback((region = null) => {
    const el = overlayRef.current
    if (!el) return
    const g = syncCanvasGeometry()
    if (!g) return
    const { docW, docH, dpr, bandTop, bandH } = g
    const bandArea = { x: 0, y: bandTop, w: docW, h: bandH }
    let area
    if (!region || g.resized || g.bandChanged) {
      area = bandArea
    } else {
      const x = Math.max(0, Math.min(docW, region.x))
      const y = Math.max(bandTop, Math.min(bandTop + bandH, region.y))
      area = {
        x,
        y,
        w: Math.min(docW, region.x + region.w) - x,
        h: Math.min(bandTop + bandH, region.y + region.h) - y,
      }
      if (area.w <= 0 || area.h <= 0) return
    }
    const ctx = el.getContext('2d')
    // 平移 -bandTop：之后所有绘制都用「文档坐标」，与批注的归一化坐标直接对应
    ctx.setTransform(dpr, 0, 0, dpr, 0, -bandTop * dpr)
    ctx.clearRect(area.x, area.y, area.w, area.h)
    const fullBand = area.x === 0 && area.y === bandTop && area.w === docW && area.h === bandH
    const inArea = (a) => {
      if (fullBand) return true
      const b = annotationBounds(a)
      if (!b) return selectedIds.has(a.id) // 文本框/标记等 DOM 批注：仅选中框需要
      const pad = inkPadPx(a, docW)
      const ax = b.x * docW - pad
      const ay = b.y * docH - pad
      const aw = b.w * docW + pad * 2
      const ah = b.h * docH + pad * 2
      return ax < area.x + area.w && area.x < ax + aw && ay < area.y + area.h && area.y < ay + ah
    }
    const drawDraft = () => {
      // 橡皮光标只在 DOM 层画一次（.eraser-cursor-preview，见 placeEraserCursor）。
      // 这里以前还会在画布上再画一个虚线圆（半径 = size），和 DOM 圆同时出现：
      // 两个圆一个按百分比定位、一个按文档坐标绘制，缩放后就会明显错位，
      // 用户看到的就是「两个橡皮圈 + 和鼠标对不上」。现在保留 DOM 这一个（无残影、位置与真实擦除范围一致），
      // 画布上不再画第二个圆；下面的 eraserCursorBoundsRef 仍照常清理旧区域（无害，且保留局部重绘语义）。
      if (drawingRef.current?.type === 'eraser') {
        // 橡皮没有需要绘制的草稿：擦除结果直接落到批注列表上（由 listDiffRegion 重绘）。
      } else if (drawingRef.current) {
        drawAnnotation(ctx, drawingRef.current, docW, docH, true)
      }
    }
    for (const a of annRef.current[annKey] || []) {
      if (!inArea(a)) continue
      drawAnnotation(ctx, a, docW, docH)
      if (selectedIds.has(a.id)) {
        drawShapeSelection(ctx, a, docW, docH, selectedIds.size === 1)
      }
    }
    drawDraft()
    // 记下「画布上可信的区域」：条带重绘后整条都可信，局部重绘则并入脏矩形
    paintedRef.current = fullBand ? { ...bandArea } : rectUnion(paintedRef.current, area)
  }, [annKey, selectedIds, syncCanvasGeometry])

  // 批注列表 / 工具 / 选中变化：只清理「旧列表范围 ∪ 新列表范围 ∪ 草稿」的并集
  const paintAll = useCallback(() => {
    const el = overlayRef.current
    if (!el) return
    const g = syncCanvasGeometry()
    if (!g) return
    const { docW, docH } = g
    let region = paintedRef.current
    for (const a of annRef.current[annKey] || []) {
      const b = annotationBounds(a)
      if (!b) continue
      const pad = inkPadPx(a, docW)
      region = rectUnion(region, { x: b.x * docW - pad, y: b.y * docH - pad, w: b.w * docW + pad * 2, h: b.h * docH + pad * 2 })
    }
    const d = drawingRef.current
    if (d?.bounds) region = rectUnion(region, d.bounds)
    if (region && selectedIds.size) {
      // DOM 批注（文本框/标记）的选中框不在画布上，命中就整体重绘一次，代价一次性
      const hasDomSelection = (annRef.current[annKey] || []).some(
        (a) => selectedIds.has(a.id) && !annotationBounds(a),
      )
      if (hasDomSelection) region = null
    }
    paint(region)
  }, [annKey, paint, selectedIds, syncCanvasGeometry])

  useEffect(() => {
    paintAll()
  }, [list, tool, selectedIds, paintAll])

  // 滚动 / 窗口变化 / 覆盖层挂载：条带位置变了才整条重绘（条带只有一屏多，代价很低）
  const refreshBand = useCallback(() => {
    const g = syncCanvasGeometry()
    if (g && (g.bandChanged || g.resized)) paint(null)
  }, [paint, syncCanvasGeometry])
  refreshBandRef.current = refreshBand

  useEffect(() => {
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        refreshBand()
      })
    }
    // scroll 不冒泡，但捕获阶段能在 document 上收到所有后代的滚动（PDF/Word/MD/EPUB/Excel 各容器通用）
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('resize', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [refreshBand])

  // 覆盖层 canvas 的挂载回调：PDF 视图要等页面解析完才挂画布，此时容器才有尺寸，
  // 所以在这里重新找滚动容器、订阅尺寸变化，并做一次首绘。
  const setOverlayNode = useCallback(
    (node) => {
      overlayRef.current = node
      scrollerRef.current = null
      if (overlayBoxRef.current) {
        overlayBoxRef.current = null
      }
      if (roRef.current) {
        roRef.current.disconnect()
        roRef.current = null
      }
      if (!node) return
      const box = node.parentElement
      if (box && typeof ResizeObserver !== 'undefined') {
        roRef.current = new ResizeObserver(() => {
          requestAnimationFrame(() => refreshBandRef.current?.())
        })
        roRef.current.observe(box)
      }
      requestAnimationFrame(() => refreshBandRef.current?.())
    },
    [],
  )

  // 草稿（画笔/荧光笔/形状/橡皮光标）的像素包围盒（文档坐标）
  const draftBounds = useCallback((d) => {
    const { docW: w, docH: h } = geomRef.current
    if (!w || !h || !d) return null
    if (d.type === 'eraser') {
      const p = d.point || d.start
      if (!p) return null
      const r = Math.max(2, Number(d.size) || 16) + 6
      return { x: p.x * w - r, y: p.y * h - r, w: r * 2, h: r * 2 }
    }
    const pad = inkPadPx(d, w)
    let x0
    let y0
    let x1
    let y1
    if (d.type === 'brush' || d.type === 'highlighter') {
      const pts = d.points || []
      if (!pts.length) return null
      x0 = Infinity
      y0 = Infinity
      x1 = -Infinity
      y1 = -Infinity
      for (const p of pts) {
        if (p.x < x0) x0 = p.x
        if (p.y < y0) y0 = p.y
        if (p.x > x1) x1 = p.x
        if (p.y > y1) y1 = p.y
      }
    } else {
      if (!d.start || !d.end) return null
      x0 = Math.min(d.start.x, d.end.x)
      x1 = Math.max(d.start.x, d.end.x)
      y0 = Math.min(d.start.y, d.end.y)
      y1 = Math.max(d.start.y, d.end.y)
    }
    return { x: x0 * w - pad, y: y0 * h - pad, w: (x1 - x0) * w + pad * 2, h: (y1 - y0) * h + pad * 2 }
  }, [])

  // 单条批注的像素包围盒（可加额外余量，例如选中框手柄）
  const annotRegion = useCallback((a, extraPad = 0) => {
    const { docW: w, docH: h } = geomRef.current
    if (!a || !w || !h) return null
    const b = annotationBounds(a)
    if (!b) return null
    const pad = Math.max(inkPadPx(a, w), 10) + extraPad
    return { x: b.x * w - pad, y: b.y * h - pad, w: b.w * w + pad * 2, h: b.h * h + pad * 2 }
  }, [])

  // 擦除前后列表差异的像素包围盒：被删除/被拆分的旧笔画范围必须清掉旧像素
  const listDiffRegion = useCallback((before, after) => {
    if (!geomRef.current.docW) return null
    const afterIds = new Set(after.map((a) => a.id))
    const beforeIds = new Set(before.map((a) => a.id))
    let region = null
    for (const a of before) if (!afterIds.has(a.id)) region = rectUnion(region, annotRegion(a))
    for (const a of after) if (!beforeIds.has(a.id)) region = rectUnion(region, annotRegion(a))
    return region
  }, [annotRegion])

  // 指针 → 文档归一化坐标。画布只覆盖视口条带，所以 y 要加上条带顶部偏移。
  const getPoint = useCallback((e) => {
    const el = overlayRef.current
    if (!el) return { x: 0, y: 0 }
    const { docW, docH, bandTop } = geomRef.current
    const width = docW || el.clientWidth || 1
    const height = docH || el.clientHeight || 1
    if (e.currentTarget === el && Number.isFinite(e.offsetX) && Number.isFinite(e.offsetY)) {
      return { x: e.offsetX / width, y: (bandTop + e.offsetY) / height }
    }
    const rect = e.currentTarget?.getBoundingClientRect?.() || el.getBoundingClientRect()
    if (!rect.width || !rect.height) return { x: 0, y: 0 }
    return { x: (e.clientX - rect.left) / rect.width, y: (bandTop + (e.clientY - rect.top)) / height }
  }, [])

  // 橡皮光标预览必须落在「和画布同一个坐标系」里，否则显示与鼠标实际位置错位。
  //
  // 画布是绝对定位的视口条带：left = overlayLeft、top = bandTop，尺寸 docW × bandH，
  // 且内部用 translate(0, -bandTop) 把绘制统一到文档坐标。所以「文档坐标 → 父容器像素」是：
  //   left = overlayLeft + x * docW        （x 来自 getPoint，已按 docW 归一化）
  //   top  = y * docH                      （y 已含 bandTop，无需再加）
  //
  // 之前这里写的是 left/top 百分比，而百分比是相对「父容器的内边距盒」解算的：
  // 在 PDF 视图里 .pdf-pages 比页面宽（fit-width 时容器 825px、页面 777px）且页面居中，
  // 于是光标横向被按容器宽度缩放、又缺了 overlayLeft，缩放后就会出现「鼠标在左、圆圈在右」的偏移。
  //
  // 入参 radiusPx 就是给 eraseAnnotationsAtPoint 的同一个数值（橡皮的「半径」）。
  // 引擎的擦除范围是「半径 = size」（见 eraseAnnotationsAtPoint 的 radius），
  // 所以圆环直径必须是 2 × radiusPx —— 直接把半径换算成直径，显示与真实擦除范围就永远一致，
  // 不会再出现「圆环比实际能擦到的范围小一半」。
  const placeEraserCursor = useCallback((point, radiusPx) => {
    const el = eraserCursorRef.current
    if (!el || !point) return
    let { docW, docH, overlayLeft } = geomRef.current
    if (!docW || !docH) {
      // 还没画过（首帧前）就先同步一次几何；同步不了就放弃，避免用错基准算出偏移位置
      const g = syncCanvasGeometry()
      if (!g) return
      docW = g.docW
      docH = g.docH
      overlayLeft = g.overlayLeft
    }
    const diameter = Math.max(2, Number(radiusPx) || 16) * 2
    el.style.left = `${overlayLeft + point.x * docW}px`
    el.style.top = `${point.y * docH}px`
    el.style.width = `${diameter}px`
    el.style.height = `${diameter}px`
    el.style.opacity = '1'
  }, [syncCanvasGeometry])

  const scheduleDrawFrame = useCallback((region = null) => {
    if (region) pendingRegionRef.current = rectUnion(pendingRegionRef.current, region)
    if (drawFrameRef.current) return
    drawFrameRef.current = requestAnimationFrame(() => {
      drawFrameRef.current = null
      const dirty = pendingRegionRef.current
      pendingRegionRef.current = null
      const d = drawingRef.current
      if (d && d.type !== 'brush' && d.type !== 'highlighter' && d.type !== 'eraser') {
        const width = d.canvasWidth || overlayRef.current?.clientWidth || 0
        const height = d.canvasHeight || overlayRef.current?.clientHeight || 0
        const dxPx = Math.abs(d.end.x - d.start.x) * width
        const dyPx = Math.abs(d.end.y - d.start.y) * height
        setShapeDraft({
          x0: d.start.x,
          y0: d.start.y,
          x1: d.end.x,
          y1: d.end.y,
          label: (PEN_PRESETS.find((p) => p.type === d.type) || {}).label || d.type,
          sizeText: d.type === 'line' ? `${Math.round(Math.hypot(dxPx, dyPx))}px` : `${Math.round(dxPx)}×${Math.round(dyPx)}px`,
        })
      }
      paint(dirty)
    })
  }, [paint])

  const scheduleSave = useCallback(() => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveAnnotations(entry, annRef.current)
        .then(() => setNeedsSaveFile(false))
        .catch((err) => {
          if (['AbortError', 'SecurityError', 'NotAllowedError'].includes(err?.name)) {
            setNeedsSaveFile(true)
          } else {
            notify(`批注保存失败：${err.message}`, 'error')
          }
        })
    }, 500)
  }, [entry, notify])

  const commit = useCallback(
    (newList, historyBase = null) => {
      // 记录撤销历史（最多保留100 步），新操作清空重做栈
      const cur = historyBase ?? annRef.current[annKey] ?? []
      undoStackRef.current.push(cur)
      if (undoStackRef.current.length > 100) undoStackRef.current.shift()
      redoStackRef.current = []
      setCanUndo(true)
      setCanRedo(false)
      annRef.current = { ...annRef.current, [annKey]: newList }
      setAnnotations(annRef.current)
      scheduleSave()
    },
    [annKey, scheduleSave],
  )

  // 直接应用列表（不记录历史），供undo/redo 回放用
  const applyList = useCallback(
    (newList) => {
      annRef.current = { ...annRef.current, [annKey]: newList }
      setAnnotations(annRef.current)
      scheduleSave()
    },
    [annKey, scheduleSave],
  )

  /**
   * 写「页面级元数据」（和白板批注存在同一份旁车数据里）。
   * 目前只用于白板分页数：坐标是相对整块白板归一化的，页数决定白板高度，
   * 所以它必须跟着批注一起落盘，重开文件时白板高度才对得上、墨迹才不跑位。
   */
  const setDocMeta = useCallback(
    (patch) => {
      annRef.current = { ...annRef.current, ...patch }
      setAnnotations(annRef.current)
      scheduleSave()
    },
    [scheduleSave],
  )

  const undo = useCallback(() => {
    const prev = undoStackRef.current.pop()
    if (prev === undefined) {
      notify('没有可撤销的操作', 'info')
      return
    }
    const cur = annRef.current[annKey] || []
    redoStackRef.current.push(cur)
    if (redoStackRef.current.length > 100) redoStackRef.current.shift()
    setCanRedo(true)
    setCanUndo(undoStackRef.current.length > 0)
    applyList(prev)
    setSelectedId(null)
    setEditingId(null)
  }, [annKey, applyList, notify])

  const redo = useCallback(() => {
    const next = redoStackRef.current.pop()
    if (next === undefined) {
      notify('没有可重做的操作', 'info')
      return
    }
    const cur = annRef.current[annKey] || []
    undoStackRef.current.push(cur)
    if (undoStackRef.current.length > 100) undoStackRef.current.shift()
    setCanUndo(true)
    setCanRedo(redoStackRef.current.length > 0)
    applyList(next)
    setSelectedId(null)
    setEditingId(null)
  }, [annKey, applyList, notify])

  const updateAnn = useCallback(
    (id, patch) => {
      commit((annRef.current[annKey] || []).map((a) => (a.id === id ? { ...a, ...patch } : a)))
    },
    [commit, annKey],
  )

  // 当前选中的文本框（恰好选中一个且是文本框时才有）
  const selectedTextAnn = useMemo(() => {
    if (selectedIds.size !== 1) return null
    const id = [...selectedIds][0]
    return (annRef.current[annKey] || []).find((a) => a.id === id && a.type === 'text') || null
  }, [selectedIds, annKey, annotations])

  // 改文本框样式：选中了文本框就改那个框（像 Word 里改字体作用到选区），
  // 没选中就只改「新建文本框的默认样式」。
  const applyTextStyle = useCallback(
    (patch) => {
      setTextStyle((prev) => ({ ...prev, ...patch }))
      if (selectedTextAnn) updateAnn(selectedTextAnn.id, patch)
    },
    [selectedTextAnn, updateAnn],
  )

  // 设置面板回显的样式：优先显示选中文本框的实际样式（可能是老批注、字段不全），
  // 否则显示新建用的默认样式。normalizeTextStyle 会把缺失字段补全。
  const activeTextStyle = useMemo(
    () => normalizeTextStyle(selectedTextAnn || textStyle),
    [selectedTextAnn, textStyle],
  )

  const previewTransform = useCallback(
    (id, original, dx, dy, handle) => {
      const list = annRef.current[annKey] || []
      const prevAnn = list.find((a) => a.id === id)
      const nextAnn = prevAnn ? transformAnnotation(prevAnn, original, dx, dy, handle) : null
      const next = list.map((a) => (a.id === id ? nextAnn : a))
      annRef.current = { ...annRef.current, [annKey]: next }
      setAnnotations(annRef.current)
      // 拖动变换时只重绘「旧位置 ∪ 新位置 + 手柄余量」，长文档上避免每帧整幅清屏
      paint(rectUnion(annotRegion(prevAnn, 20), annotRegion(nextAnn, 20)))
    },
    [annKey, paint, annotRegion],
  )

  const finishTransform = useCallback(() => {
    const session = transformRef.current
    if (!session) return
    transformRef.current = null
    if (session.changed) commit(annRef.current[annKey] || [], session.before)
  }, [annKey, commit])

  const deleteAnn = useCallback(
    (id) => {
      commit((annRef.current[annKey] || []).filter((a) => a.id !== id))
      setSelectedId(null)
      setEditingId(null)
    },
    [commit, annKey],
  )

  // 批量删除（框选或批注栏多选）：只写一条撤销记录，避免「删 8 个 = 8 步撤销」
  const deleteAnns = useCallback(
    (ids) => {
      const set = new Set(ids || [])
      if (!set.size) return
      commit((annRef.current[annKey] || []).filter((a) => !set.has(a.id)))
      setSelectedIds(SEL_EMPTY)
      setEditingId(null)
      if (set.size > 1) notify(`已删除 ${set.size} 个批注`, 'info')
    },
    [commit, annKey, notify],
  )

  // 从批注栏点条目：选中并把该批注滚到视口中间。
  // 文本框/批注标记有 DOM 节点，直接 scrollIntoView；手写笔画与图形没有节点，
  // 只能按归一化坐标换算出它在滚动容器里的位置再滚过去。
  const focusAnn = useCallback(
    (id) => {
      const a = (annRef.current[annKey] || []).find((x) => x.id === id)
      if (!a) return
      const dom = document.querySelector(`[data-ann-id="${id}"]`)
      if (dom) {
        dom.scrollIntoView({ block: 'center', behavior: 'smooth' })
        return
      }
      const scroller = scrollerRef.current || findScroller(overlayRef.current)
      const box = overlayRef.current?.parentElement
      const b = annotationBounds(a)
      if (!scroller || !box || !b || !box.clientHeight) return
      const scRect = scroller.getBoundingClientRect()
      const boxRect = box.getBoundingClientRect()
      const docTopInScroll = scroller.scrollTop + (boxRect.top - scRect.top)
      const target = docTopInScroll + (b.y + b.h / 2) * box.clientHeight
      scroller.scrollTo({ top: Math.max(0, target - scroller.clientHeight / 2), behavior: 'smooth' })
    },
    [annKey, findScroller],
  )

  const clearAll = useCallback(() => {
    if (!(annRef.current[annKey] || []).length) return
    commit([])
    setSelectedId(null)
    setEditingId(null)
    notify('已清除全部批注', 'info')
  }, [commit, annKey, notify])

  const saveNow = useCallback(() => {
    clearTimeout(saveTimer.current)
    setSaving(true)
    saveAnnotations(entry, annRef.current)
      .then(() => {
        setNeedsSaveFile(false)
        notify('批注已保存', 'success')
      })
      .catch((err) => {
        if (['AbortError', 'SecurityError', 'NotAllowedError'].includes(err?.name)) {
          notify('批注保存被浏览器拦截，请重试', 'error')
        } else {
          notify(`批注保存失败：${err.message}`, 'error')
        }
      })
      .finally(() => setSaving(false))
  }, [entry, notify])

  // 画布绘制（画笔、荧光笔 / 选择批注）
  const handleOverlayDown = useCallback(
    (e) => {
      if (tool === 'eraser') {
        const point = getPoint(e)
        const { docW, docH } = geomRef.current
        if (!docW || !docH) return
        e.currentTarget.setPointerCapture(e.pointerId)
        eraserSessionRef.current = { before: annRef.current[annKey] || [], changed: false }
        drawingRef.current = { type: 'eraser', point, size: eraser.size }
        placeEraserCursor(point, eraser.size)
        const before = annRef.current[annKey] || []
        const result = eraseAnnotationsAtPoint(before, point, docW, docH, eraser.type, eraser.size)
        if (result.changed) {
          eraserSessionRef.current.changed = true
          annRef.current = { ...annRef.current, [annKey]: result.list }
        }
        const cursorNow = draftBounds(drawingRef.current)
        eraserCursorBoundsRef.current = cursorNow
        paint(rectUnion(cursorNow, result.changed ? listDiffRegion(before, result.list) : null))
        return
      }
      if (tool === 'select' || tool === 'selectAnnot') {
        // 触摸：第二根手指进来 = 想滚动文档（单指仍然是框选）。
        // 画布是 touch-action:none（画笔必须），浏览器不会替我们滚动，所以这里自己实现双指滚动，
        // 否则手机上默认工具就是「选择」，手指怎么划都滚不动文档。
        if (e.pointerType === 'touch') {
          touchRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
          if (touchRef.current.size >= 2) {
            marqueeRef.current = null
            moveGroupRef.current = null
            setMarquee(null)
            const scroller = scrollerRef.current || findScroller(overlayRef.current)
            const pts = [...touchRef.current.values()]
            panRef.current = scroller && {
              scroller,
              startX: (pts[0].x + pts[1].x) / 2,
              startY: (pts[0].y + pts[1].y) / 2,
              top: scroller.scrollTop,
              left: scroller.scrollLeft,
            }
            e.currentTarget.setPointerCapture(e.pointerId)
            return
          }
        }
        const point = getPoint(e)
        const { docW, docH } = geomRef.current
        if (!docW || !docH) return
        const anns = annRef.current[annKey] || []
        let hit = null
        for (let i = anns.length - 1; i >= 0; i--) {
          if (hitTestAnnotation(anns[i], point.x * docW, point.y * docH, docW, docH)) {
            hit = anns[i]
            break
          }
        }
        if (hit) {
          e.stopPropagation()
          if (e.cancelable) e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          if (e.shiftKey) {
            // Shift + 点：加选 / 取消加选
            const next = new Set(selectedIds)
            if (next.has(hit.id)) next.delete(hit.id)
            else next.add(hit.id)
            selectIds(next)
            return
          }
          // 点已选中的批注 = 拖动整组；点未选中的 = 先改成只选它，再拖动
          const ids = selectedIds.has(hit.id) ? [...selectedIds] : [hit.id]
          if (!selectedIds.has(hit.id)) selectIds(ids)
          const snapshot = new Map()
          for (const a of anns) if (ids.includes(a.id)) snapshot.set(a.id, a)
          moveGroupRef.current = { ids, before: anns, start: point, snapshot, changed: false }
          return
        }
        // 空白处按下：开始框选（Shift = 在已有选择上累加），拖动前先清掉旧选择
        e.currentTarget.setPointerCapture(e.pointerId)
        marqueeRef.current = { start: point, base: e.shiftKey ? [...selectedIds] : [] }
        if (!e.shiftKey) setSelectedIds(SEL_EMPTY)
        setMarquee({ x0: point.x, y0: point.y, x1: point.x, y1: point.y })
        return
      }
      if (tool !== 'pen' && tool !== 'highlighter' && tool !== 'shape') return
      setSelectedId(null)
      const meta =
        tool === 'highlighter'
          ? { type: 'highlighter', color: highlighter.color, thickness: highlighter.size }
          : tool === 'shape'
            ? { type: shape.type, color: shape.color, thickness: shape.size }
            : { type: 'brush', color: pen.color, thickness: pen.size }
      const point = getPoint(e)
      // 画布只覆盖视口条带，形状预览的像素换算必须用「文档尺寸」而不是画布尺寸
      const { docW: canvasW, docH: canvasH } = geomRef.current
      e.currentTarget.setPointerCapture(e.pointerId)
      drawingRef.current = {
        ...meta,
        start: point,
        end: point,
        points: [point],
        canvasWidth: canvasW,
        canvasHeight: canvasH,
        aspect: canvasW && canvasH ? canvasW / canvasH : 1,
      }
      if (tool === 'shape') {
        const label = (SHAPE_PRESETS.find((p) => p.type === meta.type) || {}).label || meta.type
        setShapeDraft({ x0: point.x, y0: point.y, x1: point.x, y1: point.y, label, sizeText: '' })
      } else if (tool === 'pen') {
        setShapeDraft({ x0: point.x, y0: point.y, x1: point.x, y1: point.y, label: '画笔', sizeText: '' })
      }
      paint(draftBounds(drawingRef.current))
    },
    [tool, pen, shape, highlighter, eraser, getPoint, placeEraserCursor, annKey, paint, draftBounds, listDiffRegion, selectedIds, selectIds],
  )

  const handleOverlayMove = useCallback(
    (e) => {
      const d = drawingRef.current
      const point = getPoint(e)
      // 触摸：记录位置；双指会话中则按两指中点位移滚动文档
      if (e.pointerType === 'touch' && touchRef.current.has(e.pointerId)) {
        touchRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
        const pan = panRef.current
        if (pan) {
          const pts = [...touchRef.current.values()]
          if (pts.length >= 2) {
            if (e.cancelable) e.preventDefault()
            const mx = (pts[0].x + pts[1].x) / 2
            const my = (pts[0].y + pts[1].y) / 2
            pan.scroller.scrollTop = pan.top - (my - pan.startY)
            pan.scroller.scrollLeft = pan.left - (mx - pan.startX)
          }
          return
        }
      }
      // 框选：只更新虚线选框，不落任何批注
      if (marqueeRef.current) {
        setMarquee({ x0: marqueeRef.current.start.x, y0: marqueeRef.current.start.y, x1: point.x, y1: point.y })
        return
      }
      // 整组拖动（单选也走这条）：位移相对「按下时的快照」计算，避免累积漂移
      const group = moveGroupRef.current
      if (group) {
        let dx = point.x - group.start.x
        let dy = point.y - group.start.y
        let minX = 1
        let minY = 1
        let maxX = 0
        let maxY = 0
        for (const a of group.snapshot.values()) {
          const b = selectBounds(a)
          if (!b) continue
          minX = Math.min(minX, b.x)
          minY = Math.min(minY, b.y)
          maxX = Math.max(maxX, b.x + b.w)
          maxY = Math.max(maxY, b.y + b.h)
        }
        if (minX <= maxX) {
          dx = Math.max(-minX, Math.min(1 - maxX, dx))
          dy = Math.max(-minY, Math.min(1 - maxY, dy))
        }
        if (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4) group.changed = true
        const list = annRef.current[annKey] || []
        const next = list.map((a) =>
          group.snapshot.has(a.id) ? translateAnnotation(group.snapshot.get(a.id), dx, dy) : a,
        )
        const movedPrev = list.filter((a) => group.snapshot.has(a.id))
        const movedNext = next.filter((a) => group.snapshot.has(a.id))
        annRef.current = { ...annRef.current, [annKey]: next }
        setAnnotations(annRef.current)
        const { docW: gw, docH: gh } = geomRef.current
        let region = null
        for (const a of [...movedPrev, ...movedNext]) {
          const b = annotationBounds(a)
          if (!b) continue
          const pad = inkPadPx(a, gw)
          region = rectUnion(region, {
            x: b.x * gw - pad,
            y: b.y * gh - pad,
            w: b.w * gw + pad * 2,
            h: b.h * gh + pad * 2,
          })
        }
        if (region) paint(region)
        return
      }
      if (!d) {
        if (tool === 'eraser') placeEraserCursor(point, eraser.size)
        return
      }
      if (d.type === 'eraser') {
        // 记录上一帧橡皮光标的位置：它是一块「画在画布上的」半透明圆，
        // 拖动时必须把它一并清理掉，否则快速拖动会沿路径留下虚线圆圈残影（用户看到的「重影」）。
        const prevCursor = eraserCursorBoundsRef.current
        d.point = point
        eraserPendingPointRef.current = point
        placeEraserCursor(point, eraser.size)
        if (!eraserFrameRef.current) {
          eraserFrameRef.current = requestAnimationFrame(() => {
            eraserFrameRef.current = null
            const next = eraserPendingPointRef.current
            eraserPendingPointRef.current = null
            const { docW, docH } = geomRef.current
            if (!next || !docW || !docH || !drawingRef.current || drawingRef.current.type !== 'eraser') return
            const before = annRef.current[annKey] || []
            const result = eraseAnnotationsAtPoint(before, next, docW, docH, eraser.type, eraser.size)
            if (result.changed) {
              eraserSessionRef.current.changed = true
              annRef.current = { ...annRef.current, [annKey]: result.list }
            }
            // 拖动路径不进入 React 渲染循环，直接局部重绘画布
            const cursorNow = draftBounds(drawingRef.current)
            eraserCursorBoundsRef.current = cursorNow
            paint(
              rectUnion(
                rectUnion(prevCursor, cursorNow),
                result.changed ? listDiffRegion(before, result.list) : null,
              ),
            )
          })
        }
        return
      }
      const prevDraft = draftBounds(d)
      if (d.type === 'brush' || d.type === 'highlighter') {
        const last = d.points[d.points.length - 1]
        // 以 CSS 像素为阈值（长文档上按归一化阈值会丢掉大量点，笔画变折线）
        const { docW: w, docH: h } = geomRef.current
        const minX = 1.1 / Math.max(1, w)
        const minY = 1.1 / Math.max(1, h)
        if (Math.abs(point.x - last.x) > minX || Math.abs(point.y - last.y) > minY) {
          d.points.push(point)
        } else {
          return // 该点被合并，草稿没有变化，不必重绘
        }
      } else if (d.type === 'line') {
        d.end = e.shiftKey ? snapPoint(point, d.start) : point
      } else if (d.type === 'rect' || d.type === 'ellipse') {
        d.end = e.shiftKey ? constrainCircle(point, d.start, d.aspect || 1) : point
      }
      scheduleDrawFrame(rectUnion(prevDraft, draftBounds(d)))
    },
    [getPoint, placeEraserCursor, scheduleDrawFrame, annKey, eraser, tool, paint, draftBounds, listDiffRegion, snapPoint, constrainCircle],
  )

  const handleOverlayLeave = useCallback((e) => {
    if (e?.pointerType === 'touch') {
      touchRef.current.delete(e.pointerId)
      if (touchRef.current.size < 2) panRef.current = null
    }
    if (!drawingRef.current && eraserCursorRef.current) {
      eraserCursorRef.current.style.opacity = '0'
    }
  }, [])

  // 框选 / 整组拖动的收尾。返回 true 表示这次抬起已经被消费掉（不再走画笔落笔那套逻辑）
  const endPointerSession = useCallback(
    (e) => {
      const group = moveGroupRef.current
      if (group) {
        moveGroupRef.current = null
        // 只在与按下时真的不同才写进撤销栈
        if (group.changed) commit(annRef.current[annKey] || [], group.before)
        return true
      }
      const mq = marqueeRef.current
      if (mq) {
        marqueeRef.current = null
        setMarquee(null)
        const { docW, docH } = geomRef.current
        const p = getPoint(e)
        const r = {
          x: Math.min(mq.start.x, p.x),
          y: Math.min(mq.start.y, p.y),
          w: Math.abs(p.x - mq.start.x),
          h: Math.abs(p.y - mq.start.y),
        }
        // 拖动距离太小（误触 / 单击空白）不当作框选，保持「点空白清空选择」
        if (docW && docH && r.w * docW >= 4 && r.h * docH >= 4) {
          const hits = (annRef.current[annKey] || [])
            .filter((a) => {
              const b = selectBounds(a)
              return b && rectsIntersect(b, r)
            })
            .map((a) => a.id)
          const ids = [...new Set([...mq.base, ...hits])]
          selectIds(ids)
          if (ids.length > 1) notify(`已框选 ${ids.length} 个批注`, 'info')
        }
        return true
      }
      return false
    },
    [commit, annKey, getPoint, selectIds, notify],
  )

  const handleOverlayUp = useCallback(
    (e) => {
    // 触摸收尾：清掉手指记录；两指不足时结束滚动会话
    if (e?.pointerType === 'touch') {
      touchRef.current.delete(e.pointerId)
      if (touchRef.current.size < 2) panRef.current = null
    }
    if (endPointerSession(e)) return
    const d = drawingRef.current
    if (!d) return
    if (d.type === 'eraser') {
      const pending = eraserPendingPointRef.current
      const { docW, docH } = geomRef.current
      const cursorRegion = draftBounds(d)
      let region = cursorRegion
      if (pending && docW && docH) {
        const before = annRef.current[annKey] || []
        const result = eraseAnnotationsAtPoint(before, pending, docW, docH, eraser.type, eraser.size)
        if (result.changed) {
          eraserSessionRef.current.changed = true
          annRef.current = { ...annRef.current, [annKey]: result.list }
          setAnnotations(annRef.current)
          region = rectUnion(region, listDiffRegion(before, result.list))
        }
      }
      const side = eraserSessionRef.current
      if (side?.changed) commit(annRef.current[annKey] || [], side.before)
      drawingRef.current = null
      eraserSessionRef.current = null
      eraserPendingPointRef.current = null
      if (eraserFrameRef.current) {
        cancelAnimationFrame(eraserFrameRef.current)
        eraserFrameRef.current = null
      }
      if (eraserCursorRef.current) eraserCursorRef.current.style.opacity = '0'
      // 抬起时也要把「上一帧光标」清掉，避免松手后留下一个虚线圆圈
      paint(rectUnion(region, eraserCursorBoundsRef.current))
      eraserCursorBoundsRef.current = null
      return
    }
    const base = { id: uid(), color: d.color, thickness: d.thickness }
    const ann =
      d.type === 'brush' || d.type === 'highlighter'
        ? { ...base, type: d.type, points: d.points }
        : { ...base, type: d.type, x0: d.start.x, y0: d.start.y, x1: d.end.x, y1: d.end.y }
    const draftRegion = draftBounds(d)
    commit([...(annRef.current[annKey] || []), ann])
    drawingRef.current = null
    setShapeDraft(null)
    // 草稿的虚线/手柄要清掉，落笔区域重绘成实线
    paint(draftRegion)
  }, [commit, annKey, paint, eraser, draftBounds, listDiffRegion, endPointerSession])

  // DOM 批注（文本框 / 批注标记）
  const handleDomDown = useCallback(
    (e) => {
      if (e.target.closest('.ann-comment, .ann-comment-pop, .ann-text, .ann-text-editor')) return
      // 取消 pointerdown 的默认行为：浏览器就不会再补发兼容 mousedown，
      // 也就不会执行「mousedown 把焦点移到点击目标」这个默认动作。
      // 批注标记是在 pointerdown 里创建并立刻让栏内输入框 autoFocus 的，
      // 紧接着到达的兼容 mousedown 会把焦点抢走（focusout → null）→ 输入框 onBlur
      // → 提交空文本并关闭，表现为「点完加批注却没法打字」。
      // click / dblclick 不是兼容鼠标事件，不受影响，标记的单击/双击照旧。
      e.preventDefault()
      cancelEditRef.current = false
      const p = getPoint(e)
      if (tool === 'text') {
        e.currentTarget.setPointerCapture(e.pointerId)
        textDragRef.current = { start: p, end: p, mode: 'create' }
        setTextDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
      } else if (tool === 'comment') {
        e.currentTarget.setPointerCapture(e.pointerId)
        if (selectedId || editingId) {
          cancelEditRef.current = true
          return
        }
        const ann = { id: uid(), type: 'comment', x: p.x, y: p.y, text: '' }
        commit([...(annRef.current[annKey] || []), ann])
        setSelectedId(ann.id)
        setEditingId(ann.id)
      }
    },
    [tool, getPoint, commit, annKey, selectedId, editingId],
  )

  const handleDomMove = useCallback(
    (e) => {
      const d = textDragRef.current
      if (!d || d.mode !== 'create') return
      const p = getPoint(e)
      d.end = p
      setTextDraft({ x0: d.start.x, y0: d.start.y, x1: p.x, y1: p.y })
    },
    [getPoint],
  )

  useEffect(() => {
    const el = draftRef.current
    if (!el) return
    setDraftFits(el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)
  }, [textDraft])

  // 退出编辑态之前，先把正在输入的编辑器 blur 掉：文本框/批注的输入框用的是
  // defaultValue（不受控），一旦被卸载，刚敲进去的字就没了。blur 会走它们自己的
  // onBlur → onCommit 提交内容，所以这里只要触发 blur 然后返回即可。
  const blurActiveEditor = useCallback(() => {
    const ae = typeof document !== 'undefined' ? document.activeElement : null
    if (ae && ae.classList && (ae.classList.contains('ann-text-editor') || ae.classList.contains('ann-panel-input'))) {
      ae.blur()
      return true
    }
    return false
  }, [])

  const handleDomUp = useCallback(
    (e) => {
      if (cancelEditRef.current) {
        cancelEditRef.current = false
        if (blurActiveEditor()) return
        setSelectedId(null)
        setEditingId(null)
        return
      }
      const d = textDragRef.current
      if (!d || d.mode !== 'create') return
      textDragRef.current = null
      setTextDraft(null)
      const p = getPoint(e)
      // 判「拖出了框 vs 只是点了一下」要用屏幕像素，不能用文档归一化坐标：
      // 页面坐标是相对整篇文档归一化的，45 页的 PDF 里 docH 有 5 万像素，
      // 一个肉眼正常的 56px 高的框只占 0.001 的文档高度，旧阈值（h<0.03）会把它当单击丢掉，
      // 表现为「文字插不进去」。阈值取 24×12 屏幕像素，任何文档下都成立。
      const { docW, docH } = geomRef.current
      const w = Math.abs(p.x - d.start.x)
      const h = Math.abs(p.y - d.start.y)
      const wPx = w * (docW || 1)
      const hPx = h * (docH || 1)
      if (wPx < 24 || hPx < 12) {
        // 单击（没拖出足够大的框）：先把正在编辑的文本框提交掉再退出，否则输入内容会丢
        if (blurActiveEditor()) return
        setSelectedId(null)
        setEditingId(null)
        return
      }
      const ann = {
        id: uid(),
        type: 'text',
        x: Math.min(d.start.x, p.x),
        y: Math.min(d.start.y, p.y),
        w,
        h,
        text: '',
        // 新文本框带上工具栏里选的字体/字号/粗斜/下划线/对齐/颜色
        ...normalizeTextStyle(textStyle),
      }
      commit([...(annRef.current[annKey] || []), ann])
      setSelectedId(ann.id)
      setEditingId(ann.id)
    },
    [getPoint, commit, annKey, blurActiveEditor, textStyle],
  )

  const commitText = useCallback(
    (id, text) => {
      updateAnn(id, { text })
      if (cancelEditRef.current) {
        cancelEditRef.current = false
        setSelectedId(null)
        setEditingId(null)
        return
      }
      setSelectedId(id)
      setEditingId(null)
    },
    [updateAnn],
  )
  const commitComment = commitText

  const selectComment = useCallback((id) => {
    setSelectedId(id)
    setEditingId(null)
    document
      .querySelector(`[data-ann-id="${id}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [])

  // Delete 键删除选中的批注（框选多个时整组删除）
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size) {
        e.preventDefault()
        if (selectedIds.size === 1) {
          deleteAnn([...selectedIds][0])
        } else {
          deleteAnns([...selectedIds])
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedIds, deleteAnn, deleteAnns])

  // Ctrl+Z 撤销 / Ctrl+Y、Ctrl+Shift+Z 重做（批注层快捷键）
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (k === 'y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  return {
    annotations,
    list,
    setList: commit,
    annRef,
    annKey,
    tool,
    setTool,
    pen,
    setPen,
    penOpen,
    setPenOpen,
    shape,
    setShape,
    shapeOpen,
    setShapeOpen,
    highlighter,
    setHighlighter,
    highlighterOpen,
    setHighlighterOpen,
    eraser,
    setEraser,
    eraserOpen,
    setEraserOpen,
    textStyle,
    setTextStyle,
    applyTextStyle,
    activeTextStyle,
    selectedTextAnn,
    saving,
    needsSaveFile,
    editingId,
    setEditingId,
    selectedId,
    setSelectedId,
    selectedIds,
    selectIds,
    marquee,
    textDraft,
    draftFits,
    shapeDraft,
    overlayRef,
    annDomRef,
    setOverlayNode,
    scaleK,
    setScaleK,
    eraserCursorRef,
    draftRef,
    undo,
    redo,
    canUndo,
    canRedo,
    clearAll,
    saveNow,
    commitText,
    commitComment,
    deleteAnn,
    deleteAnns,
    focusAnn,
    updateAnn,
    // 直接应用列表（不记撤销历史）：供 undo/redo 回放、以及「加页」这类几何补偿使用
    applyList,
    // 写页面级元数据（白板分页数）：和批注同一份旁车数据一起落盘
    setDocMeta,
    previewTransform,
    finishTransform,
    transformRef,
    selectComment,
    // 当前文档宽度（CSS px）：笔画预览要按真实比例显示「实际笔迹宽度」
    getDocWidth: () => geomRef.current.docW || 0,
    handleOverlayDown,
    handleOverlayMove,
    handleOverlayLeave,
    handleOverlayUp,
    handleDomDown,
    handleDomMove,
    handleDomUp,
  }
}

/** 批注覆盖层：画布 + DOM 批注（文本框/批注标记/草稿），放在内容容器上方 */
function AnnotOverlay({ t }) {
  // 画布只在「画笔/荧光笔/图形/橡皮擦/选择批注」时接收事件；默认「选择文字」模式不拦截，文字可选中
  const canvasActive =
    t.tool === 'pen' ||
    t.tool === 'highlighter' ||
    t.tool === 'eraser' ||
    t.tool === 'shape' ||
    t.tool === 'select' ||
    t.tool === 'selectAnnot'
  const domActive = t.tool === 'text' || t.tool === 'comment'
  return (
    <>
      <div ref={t.eraserCursorRef} className="eraser-cursor-preview" aria-hidden="true" />
      <canvas
        ref={t.setOverlayNode}
        className={`annot-canvas ${t.tool === 'select' ? 'select-mode' : ''} ${t.tool === 'eraser' ? 'eraser-mode' : ''}`}
        style={{ pointerEvents: canvasActive ? 'auto' : 'none' }}
        onPointerDown={canvasActive ? t.handleOverlayDown : undefined}
        onPointerMove={canvasActive ? t.handleOverlayMove : undefined}
        onPointerLeave={canvasActive ? t.handleOverlayLeave : undefined}
        onPointerUp={canvasActive ? t.handleOverlayUp : undefined}
        onPointerCancel={canvasActive ? t.handleOverlayUp : undefined}
      />
      <div
        ref={t.annDomRef}
        className={`ann-dom ${domActive ? 'active' : ''}`}
        style={{ '--ann-scale': t.scaleK || 1 }}
        onPointerDown={domActive ? t.handleDomDown : undefined}
        onPointerMove={domActive ? t.handleDomMove : undefined}
        onPointerUp={domActive ? t.handleDomUp : undefined}
      >
        {t.textDraft && (
          <div
            ref={t.draftRef}
            className={`text-draft ${t.draftFits ? 'fit' : ''}`}
            style={{
              left: `${Math.min(t.textDraft.x0, t.textDraft.x1) * 100}%`,
              top: `${Math.min(t.textDraft.y0, t.textDraft.y1) * 100}%`,
              width: `${Math.abs(t.textDraft.x1 - t.textDraft.x0) * 100}%`,
              height: `${Math.abs(t.textDraft.y1 - t.textDraft.y0) * 100}%`,
            }}
          >
            文本
          </div>
        )}
        {t.shapeDraft && (
          <div
            className="shape-draft"
            style={{
              left: `${Math.min(t.shapeDraft.x0, t.shapeDraft.x1) * 100}%`,
              top: `${Math.min(t.shapeDraft.y0, t.shapeDraft.y1) * 100}%`,
              width: `${Math.abs(t.shapeDraft.x1 - t.shapeDraft.x0) * 100}%`,
              height: `${Math.abs(t.shapeDraft.y1 - t.shapeDraft.y0) * 100}%`,
            }}
          >
            <span className="shape-draft-label">
              {t.shapeDraft.label}
              {t.shapeDraft.sizeText ? ` · ${t.shapeDraft.sizeText}` : ''}
            </span>
          </div>
        )}
        {t.marquee && (
          <div
            className="ann-marquee"
            aria-hidden="true"
            style={{
              left: `${Math.min(t.marquee.x0, t.marquee.x1) * 100}%`,
              top: `${Math.min(t.marquee.y0, t.marquee.y1) * 100}%`,
              width: `${Math.abs(t.marquee.x1 - t.marquee.x0) * 100}%`,
              height: `${Math.abs(t.marquee.y1 - t.marquee.y0) * 100}%`,
            }}
          />
        )}
        {t.selectedId && t.list
          .filter((a) => a.id === t.selectedId && a.type !== 'text' && a.type !== 'comment')
          .map((a) => {
            const b = annotationBounds(a)
            if (!b) return null
            const beginTransform = (e, handle) => {
              e.stopPropagation()
              e.preventDefault()
              e.currentTarget.setPointerCapture(e.pointerId)
              const original = { a, bounds: b, points: a.points?.map((p) => ({ ...p })) }
              t.transformRef.current = { id: a.id, before: t.annRef.current[t.annKey] || [], original, startX: e.clientX, startY: e.clientY, handle, changed: false }
            }
            const moveTransform = (e) => {
              const s = t.transformRef.current
              if (!s || s.id !== a.id) return
              const rect = e.currentTarget.parentElement.getBoundingClientRect()
              const dx = (e.clientX - s.startX) / rect.width
              const dy = (e.clientY - s.startY) / rect.height
              if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) s.changed = true
              t.previewTransform(a.id, s.original, dx, dy, s.handle)
            }
            const endTransform = () => t.finishTransform()
            return (
              <div key={"shape-controls-" + a.id} className="shape-controls">
                <div
                  className="shape-move-area"
                  title="拖动移动图形"
                  style={{ left: b.x * 100 + '%', top: b.y * 100 + '%', width: b.w * 100 + '%', height: b.h * 100 + '%' }}
                  onPointerDown={(e) => beginTransform(e, 'move')}
                  onPointerMove={moveTransform}
                  onPointerUp={endTransform}
                />
                {['tl', 'tr', 'bl', 'br'].map((handle) => (
                  <button
                    key={handle}
                    className={'shape-handle shape-handle-' + handle}
                    title="拖动缩放图形"
                    onPointerDown={(e) => beginTransform(e, handle)}
                    onPointerMove={moveTransform}
                    onPointerUp={endTransform}
                  />
                ))}
                <button
                  className="shape-delete"
                  title="删除图形"
                  style={{ left: (b.x + b.w) * 100 + '%', top: b.y * 100 + '%' }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); t.deleteAnn(a.id) }}
                >
                  <X size={14} />
                </button>
              </div>
            )
          })}
        {t.list
          .filter((a) => a.type === 'text')
          .map((a) => (
            <TextBox
              key={a.id}
              ann={a}
              scale={t.scaleK || 1}
              editing={t.editingId === a.id}
              selected={t.selectedIds.has(a.id)}
              onSelect={() => t.setSelectedId(a.id)}
              onStartEdit={() => t.setEditingId(a.id)}
              onCommit={t.commitText}
              onMove={(id, x, y) => t.updateAnn(id, { x, y })}
              onResize={(id, x, y, w, h) => t.updateAnn(id, { x, y, w, h })}
              onDelete={() => t.deleteAnn(a.id)}
            />
          ))}
        {t.list
          .filter((a) => a.type === 'comment')
          .map((a) => (
            <CommentMarker
              key={a.id}
              ann={a}
              scale={t.scaleK || 1}
              selected={t.selectedIds.has(a.id)}
              onSelect={() => t.setSelectedId(a.id)}
              onEdit={() => t.setEditingId(a.id)}
            />
          ))}
      </div>
    </>
  )
}

/** 批注工具栏：工具按钮 + 画笔/荧光笔设置+ 撤销/清除/保存 + 显示大小 */
// 设置弹层（画笔 / 图形 / 橡皮 / 荧光笔共用）：portal 到 body 渲染。
//
// 为什么必须 portal 出去：HIG 给 .doc-toolbar 加了 backdrop-filter: var(--blur)，
// 按 CSS 规范这会让工具栏同时成为两个东西：
//   (a) 层叠上下文 —— 弹层那点 z-index 被困在工具栏内部，会被后面的文档内容
//       （.annot-canvas / .pdf-thumbs）盖住，鼠标点不到里面的色块和滑杆，
//       表现为「双击打开了设置框，却改不了笔画」；
//   (b) position:fixed 后代的包含块 —— 遮罩的 inset:0 会相对工具栏解析，
//       于是整页压暗变成只有工具栏那一栏半透明。
// 挂到 body 下即可同时摆脱这两条约束（遮罩 z-index 40 < 弹层 50）。
function Popover({ open, left, top, onClose, className = '', children }) {
  if (!open) return null
  return createPortal(
    <>
      <div className="popover-backdrop" onClick={onClose} />
      <div className={('pen-popover ' + className).trim()} style={{ left, top }}>
        {children}
      </div>
    </>,
    document.body,
  )
}

// 笔画 / 擦除范围预览：拖动「粗细」「大小」滑杆时显示在屏幕正中。
// 同样 portal 到 body —— 挂在工具栏里会被 .doc-toolbar 的 backdrop-filter 变成 fixed 包含块。
// 用浅色卡片而不是深色 HUD：笔迹颜色多是深色（黑/深红/深蓝），深底上看不见。
function SizePreviewHud({ preview }) {
  if (!preview) return null
  const { kind, color, px, text, hint } = preview
  return createPortal(
    <div className="size-preview-hud" role="status" aria-live="polite">
      <div className="size-preview-stage">
        {kind === 'ring' ? (
          <span className="size-preview-ring" style={{ width: px, height: px }} />
        ) : (
          <span
            className="size-preview-stroke"
            style={{
              width: 150,
              height: Math.max(1, px),
              background: color,
              opacity: kind === 'highlighter' ? 0.35 : 1,
            }}
          />
        )}
      </div>
      <div className="size-preview-caption">{text}</div>
      {hint ? <small className="size-preview-hint">{hint}</small> : null}
    </div>,
    document.body,
  )
}

/**
 * 文字格式栏（Word 式）：字体 / 字号 / 粗体 / 斜体 / 下划线 / 对齐 / 颜色。
 *
 * 关键点：它不是弹层、也没有开关。只要「文本框工具处于活动状态」或「正选中/正在编辑
 * 某个文本框」，AnnotToolbar 就把它常驻显示在工具条下方 —— 用户一眼就能看到字体字号在哪改，
 * 不需要猜「再点一次工具按钮 / 双击 / 右键」这类隐藏手势。
 *
 * target 为 null 时改的是「新建文本框的默认样式」；选中了文本框则直接改那个框（同 Word 改选区）。
 */
function TextFormatBar({ t, target }) {
  const s = t.activeTextStyle
  const activeFont = TEXT_FONTS.find((f) => f.key === s.fontFamily) || TEXT_FONTS[0]
  return (
    <div className="text-format-bar" role="toolbar" aria-label="文字格式">
      <span
        className="tfb-context"
        title={target ? '改动会直接作用到这个文本框' : '改动只影响之后新建的文本框'}
      >
        {target ? (t.editingId === target.id ? '正在编辑文本框' : '正在设置文本框样式') : '新建文本框默认样式'}
      </span>
      <span className="tfb-sep" />

      <label className="tfb-field">
        <span className="tfb-label">字体</span>
        <select
          className="text-font-select"
          aria-label="字体"
          value={s.fontFamily}
          style={{ fontFamily: activeFont.css }}
          onChange={(e) => t.applyTextStyle({ fontFamily: e.target.value })}
        >
          {TEXT_FONTS.map((f) => (
            <option key={f.key} value={f.key} style={{ fontFamily: f.css }}>
              {f.label}
            </option>
          ))}
        </select>
      </label>

      <label className="tfb-field">
        <span className="tfb-label">字号</span>
        <select
          className="text-size-select"
          aria-label="字号"
          value={s.fontSize}
          onChange={(e) => t.applyTextStyle({ fontSize: Number(e.target.value) })}
        >
          {/* 当前字号可能不在预设刻度里（老批注），补一项进去，否则 select 会显示成别的字号 */}
          {!TEXT_SIZES.includes(s.fontSize) && <option value={s.fontSize}>{s.fontSize}</option>}
          {TEXT_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>

      <span className="tfb-sep" />
      <div className="seg-group text-style-group">
        <button
          className={`seg-btn ${s.bold ? 'active' : ''}`}
          aria-pressed={s.bold}
          aria-label="加粗"
          title="加粗"
          onClick={() => t.applyTextStyle({ bold: !s.bold })}
        >
          <Bold size={15} />
        </button>
        <button
          className={`seg-btn ${s.italic ? 'active' : ''}`}
          aria-pressed={s.italic}
          aria-label="倾斜"
          title="倾斜"
          onClick={() => t.applyTextStyle({ italic: !s.italic })}
        >
          <Italic size={15} />
        </button>
        <button
          className={`seg-btn ${s.underline ? 'active' : ''}`}
          aria-pressed={s.underline}
          aria-label="下划线"
          title="下划线（导出 PDF 时是否显示由阅读器决定）"
          onClick={() => t.applyTextStyle({ underline: !s.underline })}
        >
          <Underline size={15} />
        </button>
      </div>

      <span className="tfb-sep" />
      <div className="seg-group text-align-group">
        {[
          { key: 'left', label: '左对齐', Icon: AlignLeft },
          { key: 'center', label: '居中', Icon: AlignCenter },
          { key: 'right', label: '右对齐', Icon: AlignRight },
        ].map(({ key, label, Icon }) => (
          <button
            key={key}
            className={`seg-btn ${s.align === key ? 'active' : ''}`}
            aria-pressed={s.align === key}
            aria-label={label}
            title={label}
            onClick={() => t.applyTextStyle({ align: key })}
          >
            <Icon size={15} />
          </button>
        ))}
      </div>

      <span className="tfb-sep" />
      <span className="tfb-label">颜色</span>
      <div className="color-row">
        {PEN_COLORS.map((c) => (
          <button
            key={c}
            className={`swatch ${s.color === c ? 'active' : ''}`}
            style={{ background: c }}
            aria-label={`文字颜色 ${c}`}
            aria-pressed={s.color === c}
            onClick={() => t.applyTextStyle({ color: c })}
            title={c}
          />
        ))}
        <label className="custom-color" title="自定义颜色">
          <input
            type="color"
            aria-label="文字自定义颜色"
            value={s.color}
            onChange={(e) => t.applyTextStyle({ color: e.target.value })}
          />
        </label>
      </div>
    </div>
  )
}

/**
 * 浮动文字格式栏：把「字体/字号/粗斜下划线/对齐/颜色」这排控件锚在
 * **正在编辑或选中的那个文本框** 的下沿之外（下方放不下就翻到上方），
 * 既不遮挡文本框本体，也不再占工具条的一整行。
 *
 * 为什么必须浮起来：以前它作为工具条里的第二行出现（.doc-toolbar.has-text-bar），
 * 一进入文本框上下文就把整条工具栏撑高 → 文档整体向下平移、并伴随一次重排
 * （用户反馈的「突兀弹出 / 文档下移 / 像缩放了一下」）。浮层不参与文档排版，
 * 出现与消失都不会推挤内容。
 *
 * 必须 portal 到 body：.doc-toolbar 上有 backdrop-filter，按 CSS 规范它会成为
 * position:fixed 后代的包含块，挂在工具栏里浮层会相对工具栏定位并且被内容盖住
 * （与设置弹层 Popover 同一个坑）。
 */
function FloatingTextFormatBar({ t, target, fallbackRef, onHoverChange }) {
  const barRef = useRef(null)
  const [pos, setPos] = useState(null) // { left, top, placement }
  const keyRef = useRef('')
  const anchorId = target?.id || null

  // 浮层被卸载（退出编辑、文本框被删、切走视图）时清掉「鼠标停在浮层上」的状态，
  // 否则残留的 true 会让它在下一次选中文本框时自己冒出来。
  useEffect(() => () => onHoverChange?.(false), [onHoverChange])

  useEffect(() => {
    let raf = 0
    const anchorEl = () => {
      if (anchorId) {
        try {
          const el = document.querySelector(`[data-ann-id="${CSS.escape(anchorId)}"]`)
          if (el) return el
        } catch {
          // 选择器异常时退回工具按钮
        }
      }
      return fallbackRef?.current || null
    }
    const measure = () => {
      raf = 0
      const bar = barRef.current
      const el = anchorEl()
      if (!bar || !el) return
      const a = el.getBoundingClientRect()
      const b = bar.getBoundingClientRect()
      if (!b.height || !b.width) return
      const gap = 10
      const vw = window.innerWidth
      const vh = window.innerHeight
      // 优先贴在文本框下方；下方空间不够且上方放得下就翻到上方 —— 两种位置都不压住文本框
      let placement = 'below'
      let top = a.bottom + gap
      if (top + b.height > vh - 8 && a.top - gap - b.height >= 8) {
        placement = 'above'
        top = a.top - gap - b.height
      }
      top = Math.max(8, Math.min(vh - b.height - 8, top))
      // 水平方向与文本框居中对齐，再收敛进视口（色块/颜色选择不能跑到窗口外）
      let left = a.left + (a.width - b.width) / 2
      left = Math.max(8, Math.min(vw - b.width - 8, left))
      const key = `${Math.round(left)},${Math.round(top)},${placement}`
      if (key === keyRef.current) return
      keyRef.current = key
      // 箭头对准文本框中心（再收敛进浮层内），视觉上明确「这排控件属于哪个文本框」
      const arrowLeft = Math.max(14, Math.min(b.width - 14, a.left + a.width / 2 - left))
      setPos({
        left: Math.round(left),
        top: Math.round(top),
        placement,
        arrowLeft: Math.round(arrowLeft),
      })
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    schedule()
    // 文本框会被拖动/缩放（pointermove）、页面会滚动、窗口会变化 → 每次都跟着重新定位
    window.addEventListener('resize', schedule)
    document.addEventListener('scroll', schedule, { capture: true, passive: true })
    document.addEventListener('pointermove', schedule, { passive: true })
    let ro = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(schedule)
      const el = anchorEl()
      if (el) ro.observe(el)
      if (barRef.current) ro.observe(barRef.current)
    }
    return () => {
      window.removeEventListener('resize', schedule)
      document.removeEventListener('scroll', schedule, { capture: true })
      document.removeEventListener('pointermove', schedule)
      ro?.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [anchorId, fallbackRef])

  return createPortal(
    <div
      ref={barRef}
      className={`text-format-float ${pos?.placement === 'above' ? 'above' : 'below'}`}
      style={{
        left: `${pos?.left ?? -9999}px`,
        top: `${pos?.top ?? -9999}px`,
        visibility: pos ? 'visible' : 'hidden',
        '--tfb-arrow-left': `${pos?.arrowLeft ?? 24}px`,
      }}
      role="group"
      aria-label="文字格式（浮层）"
      onPointerEnter={() => onHoverChange?.(true)}
      onPointerLeave={() => onHoverChange?.(false)}
      // 点按钮时不要把焦点从输入框抢走：失焦会立刻提交文本并结束编辑态，而编辑态一结束
      // 浮层就该隐藏 —— 按钮还没收到 click 就被卸载，等于点了没反应。
      // select / input 例外：它们要靠默认行为才能聚焦、展开原生下拉（这类控件会短暂接管
      // 编辑态，靠 onPointerEnter 的「悬停续命」让浮层留在原地）。
      onMouseDown={(e) => {
        if (e.target.closest('select, input')) return
        e.preventDefault()
      }}
    >
      <TextFormatBar t={t} target={target} />
      <span className="tfb-arrow" aria-hidden="true" />
    </div>,
    document.body,
  )
}

function AnnotToolbar({ t, extra, showThumbsToggle = false }) {
  const penRef = useRef(null)
  const hlRef = useRef(null)
  const eraserRef = useRef(null)
  const shapeRef = useRef(null)
  const textBtnRef = useRef(null)
  const tbRef = useRef(null)
  const thumbs = usePanel('pdfThumbs')
  const annPanel = usePanel('annPanel')
  const [penPos, setPenPos] = useState({ left: 0, top: 0 })
  const [hlPos, setHlPos] = useState({ left: 0, top: 0 })
  const [eraserPos, setEraserPos] = useState({ left: 0, top: 0 })
  const [shapePos, setShapePos] = useState({ left: 0, top: 0 })
  const [zoom, setZoom] = useState(100)
  // 笔画大小预览（屏幕正中）：拖滑杆时出现，最后一次改动后 900ms 淡出
  const [sizePreview, setSizePreview] = useState(null)
  const previewTimerRef = useRef(null)
  const showSizePreview = useCallback((payload) => {
    setSizePreview(payload)
    clearTimeout(previewTimerRef.current)
    previewTimerRef.current = setTimeout(() => setSizePreview(null), 900)
  }, [])
  useEffect(() => () => clearTimeout(previewTimerRef.current), [])

  // 滑杆上的「级数」→ 画布上真实笔迹宽度（CSS px）。公式与 drawAnnotation / eraser-cursor 保持一致，
  // 这样屏幕中央显示的粗细就是落笔后的实际粗细。
  const docW = (t.getDocWidth && t.getDocWidth()) || 850
  // 每个预览带一个 owner：它属于哪个设置弹层。弹层一关（或换成另一个弹层）就立刻收起，
  // 不会出现「关掉画笔设置、中间还挂着画笔粗细预览」这种情况（见下面的 owner 清理 effect）。
  const penPreview = (size) => {
    const px = Math.max(1.5, docW * (size / 800))
    return { owner: 'pen', kind: 'stroke', color: t.pen.color, px, text: `画笔 · 粗细 ${size}`, hint: `实际笔迹宽约 ${px.toFixed(1)} px` }
  }
  const highlighterPreview = (size) => {
    const px = Math.max(5, docW * (size / 350))
    return { owner: 'highlighter', kind: 'highlighter', color: t.highlighter.color, px, text: `荧光笔 · 粗细 ${size}`, hint: `实际笔迹宽约 ${px.toFixed(1)} px` }
  }
  const shapePreview = (size) => {
    const px =
      t.shape.type === 'line'
        ? Math.max(1.5, docW * (size / 800))
        : Math.max(1.5, docW * (size / 800) * 0.5)
    return { owner: 'shape', kind: 'stroke', color: t.shape.color, px, text: `图形 · 粗细 ${size}`, hint: `实际线宽约 ${px.toFixed(1)} px` }
  }
  // 橡皮：滑杆数值是「半径」（引擎 eraseAnnotationsAtPoint 的 radius），
  // 所以预览环直径 = 2 × 数值，和画布上的橡皮光标、真实擦除范围三者一致。
  const eraserPreview = (size) => ({
    owner: 'eraser',
    kind: 'ring',
    px: Math.max(2, Number(size) || 16) * 2,
    text: `橡皮擦 · 擦除直径 ${Math.max(2, Number(size) || 16) * 2}px`,
    hint: `半径 ${Math.max(2, Number(size) || 16)}px，拖动滑块调整擦除范围`,
  })

  // 显示大小：把 zoom 写到所在.doc-view 的CSS 变量，内容纸张（.docx-doc/.md-body/.epub-body）统一缩放
  useEffect(() => {
    const view = tbRef.current?.closest('.doc-view')
    if (!view) return
    view.style.setProperty('--doc-zoom', String(zoom / 100))
    return () => view.style.removeProperty('--doc-zoom')
  }, [zoom])

  // 弹窗锚定到对应图标正下方（用视口坐标，因为弹层 portal 到 body 后是 position: fixed）。
  // 右侧防溢出：留出弹层宽度 260 + 12 间距；下方放不下就翻到按钮上方 ——
  // 否则矮窗口 / 横屏手机上弹层会被窗口底边裁掉（原来只处理了 left）。
  const anchor = (btn, fallbackLeft = 60, estHeight = 180) => {
    if (!btn) return { left: fallbackLeft, top: 96 }
    const r = btn.getBoundingClientRect()
    const maxLeft = Math.max(8, window.innerWidth - 272)
    const left = Math.max(8, Math.min(r.left, maxLeft))
    const below = r.bottom + 8
    if (below + estHeight > window.innerHeight - 8 && r.top - 8 - estHeight > 8) {
      return { left, top: r.top - 8 - estHeight }
    }
    return { left, top: Math.min(below, Math.max(8, window.innerHeight - estHeight - 8)) }
  }
  // 记录「刚打开设置」的时刻，用于把双击的第二下识别为同一次手势
  const lastOpenAtRef = useRef(0)
  const markOpened = () => {
    lastOpenAtRef.current = Date.now()
  }
  const openPen = () => {
    setPenPos(anchor(penRef.current, 60, 172))
    markOpened()
    t.setPenOpen(true)
  }
  const openHighlighter = () => {
    setHlPos(anchor(hlRef.current, 60, 172))
    markOpened()
    t.setHighlighterOpen(true)
  }
  const openEraser = () => {
    setEraserPos(anchor(eraserRef.current, 60, 226))
    markOpened()
    t.setEraserOpen(true)
  }
  const openShape = () => {
    setShapePos(anchor(shapeRef.current, 60, 284))
    markOpened()
    t.setShapeOpen(true)
  }
  // 工具有三种打开设置的方式（用户习惯不同，全都支持）：
  // 1) 已经是当前工具时再点一次；2) 双击；3) 右键。
  // 关键：双击的第二下若落在 350ms 内，视为同一次手势 —— 只保证面板打开，绝不在这一下把它关掉，
  // 否则「连点两次」会出现「打开又立刻关闭」的观感（用户反馈的「双击没用」）。
  const clickTool = (name, open, close, opened) => () => {
    if (t.tool === name) {
      if (opened) {
        if (Date.now() - lastOpenAtRef.current < 350) return // 双击的第二下：保持打开
        close(false)
        return
      }
      markOpened()
      open()
      return
    }
    closeAllPopsRef.current?.()
    t.setTool(name)
  }
  const closeAllPops = () => {
    t.setPenOpen(false)
    t.setHighlighterOpen(false)
    t.setEraserOpen(false)
    t.setShapeOpen(false)
  }
  const closeAllPopsRef = useRef(closeAllPops)
  closeAllPopsRef.current = closeAllPops
  const anyPopOpen = t.penOpen || t.highlighterOpen || t.eraserOpen || t.shapeOpen

  // 预览只属于「产生它的那个设置弹层」：这个弹层一关（Esc / 点外面 / 再点工具按钮 / 换成别的弹层），
  // 屏幕中央的预览立刻收起。不主动清掉的话，它要等 900ms 自动隐藏计时走完才淡出 ——
  // 用户看到的就是「把双击打开的设置窗口关掉后，中间那个预览还挂着不走」。
  const previewOwner = sizePreview?.owner
  useEffect(() => {
    if (!previewOwner) return
    const ownerOpen = { pen: t.penOpen, highlighter: t.highlighterOpen, eraser: t.eraserOpen, shape: t.shapeOpen }[previewOwner]
    if (ownerOpen) return
    clearTimeout(previewTimerRef.current)
    previewTimerRef.current = null
    setSizePreview(null)
  }, [previewOwner, t.penOpen, t.highlighterOpen, t.eraserOpen, t.shapeOpen])

  // ── 文字格式栏（Word 式）：可见性完全由「上下文」推导，不是开关 ──
  // 只要文本框工具处于活动状态，或者正选中/正在编辑某个文本框，就把它显示出来。
  // 用户抱怨的就是「功能藏起来了」：以前必须猜到「再点一次工具按钮 / 双击 / 右键」才看得到字体字号。
  const editingTextAnn = useMemo(() => {
    if (!t.editingId) return null
    // 注意：t.annotations 是「按文档类型分键」的对象（annotations[annKey]），t.list 才是当前文档的批注数组
    return (t.list || []).find((a) => a.id === t.editingId && a.type === 'text') || null
  }, [t.editingId, t.list])
  /**
   * 格式栏只在「正在编辑这个文本框」时出现：
   *  - 单击选中文本框（只是选中，没在编辑）→ 不显示，免得挡视线、也免得让人以为在改样式
   *  - 双击文本框进入编辑（或拖出新框自动进入编辑）→ 贴着它下方浮出
   *  - 输入框失焦 / 点空白处 / 按 Esc 退出编辑 → 立刻隐藏
   * 例外：鼠标正停在浮层上时保持显示。因为点字号 / 颜色下拉会让输入框失焦并提交，
   * 编辑态当场结束；若据此立刻隐藏，用户刚拉开的原生下拉会连浮层一起消失。
   */
  const [barHover, setBarHover] = useState(false)
  const textTarget = editingTextAnn || (barHover ? t.selectedTextAnn : null)
  const showTextBar = Boolean(textTarget)

  // Esc 关闭设置面板；点击工具栏以外的地方也关闭。
  // 注意：这里不能依赖遮罩层接收点击——遮罩会在双击的第二下盖住工具按钮，
  // 导致浏览器不再向按钮派发 dblclick（用户看到的就是「双击没反应」）。
  // 所以遮罩只做视觉压暗（pointer-events: none），关闭逻辑用文档级捕获监听实现。
  useEffect(() => {
    if (!anyPopOpen) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') closeAllPops()
    }
    const onPointerDown = (e) => {
      // 设置弹层与文字格式浮层都已 portal 到 body，不再是 .doc-toolbar 的后代，
      // 三条都要放行，否则在弹层里按下（拖粗细滑杆、点色块、改字号）会先被这里关掉面板。
      if (e.target?.closest?.('.doc-toolbar, .pen-popover, .text-format-float')) return
      closeAllPops()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyPopOpen])

  return (
    // 文字格式栏已改成浮层（见 FloatingTextFormatBar），不再占工具条第二行，
    // 所以这里不再需要 has-text-bar 换行开关，出现格式栏也不会推挤文档。
    <div className="doc-toolbar" ref={tbRef}>
      <div className="tool-group">
        <ToolButton
          active={t.tool === 'select'}
          title="选择文字（浏览/选中文字后可高亮）"
          icon={MousePointer2}
          onClick={() => t.setTool('select')}
        />
        <ToolButton
          active={t.tool === 'text'}
          title="文本框：拖动放置后输入文字（格式栏会浮在文本框下方，可改字体、字号、粗斜下划线、对齐、颜色）"
          icon={Type}
          onClick={() => t.setTool('text')}
          btnRef={textBtnRef}
        />
        <ToolButton
          active={t.tool === 'pen'}
          title="画笔（再点一次 / 双击 / 右键打开设置：颜色、粗细）"
          icon={Pencil}
          hasSettings
          onClick={clickTool('pen', openPen, t.setPenOpen, t.penOpen)}
          onDoubleClick={openPen}
          onContextMenu={openPen}
          btnRef={penRef}
        />
        <ToolButton
          active={t.tool === 'shape'}
          title={`图形：${
            (SHAPE_PRESETS.find((p) => p.type === t.shape?.type) || SHAPE_PRESETS[0]).label
          }（再点一次 / 双击 / 右键切换图形、颜色、粗细）`}
          icon={(SHAPE_PRESETS.find((p) => p.type === t.shape?.type) || SHAPE_PRESETS[0]).icon}
          hasSettings
          onClick={clickTool('shape', openShape, t.setShapeOpen, t.shapeOpen)}
          onDoubleClick={openShape}
          onContextMenu={openShape}
          btnRef={shapeRef}
        />
        <ToolButton
          active={t.tool === 'highlighter'}
          title="荧光笔（再点一次 / 双击 / 右键打开设置：颜色、粗细）"
          icon={Highlighter}
          hasSettings
          onClick={clickTool('highlighter', openHighlighter, t.setHighlighterOpen, t.highlighterOpen)}
          onDoubleClick={openHighlighter}
          onContextMenu={openHighlighter}
          btnRef={hlRef}
        />
        <ToolButton
          active={t.tool === 'eraser'}
          title="橡皮擦（再点一次 / 双击 / 右键设置擦除方式和大小）"
          icon={Eraser}
          hasSettings
          onClick={clickTool('eraser', openEraser, t.setEraserOpen, t.eraserOpen)}
          onDoubleClick={openEraser}
          onContextMenu={openEraser}
          btnRef={eraserRef}
        />
        <ToolButton
          active={t.tool === 'comment'}
          title="添加批注"
          icon={MessageSquareText}
          onClick={() => t.setTool('comment')}
        />
      </div>
      {extra}
      <div className="tool-group panel-toggle-group">
        {showThumbsToggle && (
          <ToolButton
            active={!thumbs.collapsed}
            title={thumbs.collapsed ? '显示页面缩略图栏' : '隐藏页面缩略图栏'}
            icon={PanelLeft}
            onClick={thumbs.toggle}
          />
        )}
        <ToolButton
          active={!annPanel.collapsed}
          title={annPanel.collapsed ? '显示批注栏' : '隐藏批注栏'}
          icon={PanelRight}
          onClick={annPanel.toggle}
        />
      </div>
      <div className="tool-group">
        <ToolButton title="撤销上一步(Ctrl+Z)" icon={Undo2} onClick={t.undo} disabled={!t.canUndo} />
        <ToolButton title="重做（取消撤销，Ctrl+Y）" icon={Redo2} onClick={t.redo} disabled={!t.canRedo} />
        <ToolButton title="清除全部批注" icon={Trash2} onClick={t.clearAll} />
        <ToolButton title="保存批注" icon={Save} onClick={t.saveNow} />
      </div>
      <span className="toolbar-hint">
        {t.needsSaveFile
          ? '批注保存失败，请重试'
          : t.saving
            ? '保存中…'
            : `${t.list.length} 条批注`}
      </span>
      <div className="tool-group zoom-group">
        <button className="icon-btn" title="缩小显示" onClick={() => setZoom((z) => Math.max(60, z - 10))}>
          <ZoomOut size={16} />
        </button>
        <span className="zoom-value">{zoom}%</span>
        <button className="icon-btn" title="放大显示" onClick={() => setZoom((z) => Math.min(200, z + 10))}>
          <ZoomIn size={16} />
        </button>
      </div>
      <Popover open={t.penOpen} left={penPos.left} top={penPos.top} onClose={() => t.setPenOpen(false)}>
            <div className="pop-title">画笔设置</div>
            <div className="pop-label">颜色</div>
            <div className="color-row">
              {PEN_COLORS.map((c) => (
                <button
                  key={c}
                  className={`swatch ${t.pen.color === c ? 'active' : ''}`}
                  style={{ background: c }}
                  aria-label={`画笔颜色 ${c}`}
                  aria-pressed={t.pen.color === c}
                  onClick={() => t.setPen((prev) => ({ ...prev, color: c }))}
                  title={c}
                />
              ))}
              <label className="custom-color" title="自定义颜色">
                <input
                  type="color"
                  aria-label="画笔自定义颜色"
                  value={t.pen.color}
                  onChange={(e) => t.setPen((prev) => ({ ...prev, color: e.target.value }))}
                />
              </label>
            </div>
            <div className="pop-label">
              粗细 <b>{t.pen.size}</b>
            </div>
            <input
              type="range"
              className="size-range"
              aria-label="画笔粗细"
              min={1}
              max={10}
              value={t.pen.size}
              onPointerDown={() => showSizePreview(penPreview(t.pen.size))}
              onChange={(e) => {
                const size = Number(e.target.value)
                t.setPen((prev) => ({ ...prev, size }))
                showSizePreview(penPreview(size))
              }}
            />
      </Popover>
      <Popover open={t.shapeOpen} left={shapePos.left} top={shapePos.top} onClose={() => t.setShapeOpen(false)} className="shape-popover">
            <div className="pop-title">图形设置</div>
            <div className="pop-label">图形</div>
            <div className="seg-group shape-seg-group">
              {SHAPE_PRESETS.map((p) => (
                <button
                  key={p.type}
                  className={`seg-btn shape-seg-btn ${t.shape.type === p.type ? 'active' : ''}`}
                  aria-pressed={t.shape.type === p.type}
                  onClick={() => {
                    t.setShape((prev) => ({ ...prev, type: p.type }))
                    t.setTool('shape')
                  }}
                >
                  <p.icon size={16} strokeWidth={2} />
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
            <div className="pop-label">颜色</div>
            <div className="color-row">
              {PEN_COLORS.map((c) => (
                <button
                  key={c}
                  className={`swatch ${t.shape.color === c ? 'active' : ''}`}
                  style={{ background: c }}
                  aria-label={`图形颜色 ${c}`}
                  aria-pressed={t.shape.color === c}
                  onClick={() => t.setShape((prev) => ({ ...prev, color: c }))}
                  title={c}
                />
              ))}
              <label className="custom-color" title="自定义颜色">
                <input
                  type="color"
                  aria-label="图形自定义颜色"
                  value={t.shape.color}
                  onChange={(e) => t.setShape((prev) => ({ ...prev, color: e.target.value }))}
                />
              </label>
            </div>
            <div className="pop-label">
              粗细 <b>{t.shape.size}</b>
            </div>
            <input
              type="range"
              className="size-range"
              aria-label="图形线条粗细"
              min={1}
              max={10}
              value={t.shape.size}
              onPointerDown={() => showSizePreview(shapePreview(t.shape.size))}
              onChange={(e) => {
                const size = Number(e.target.value)
                t.setShape((prev) => ({ ...prev, size }))
                showSizePreview(shapePreview(size))
              }}
            />
            <small className="pop-hint">按住 Shift 可画正圆 / 水平垂直直线</small>
      </Popover>
      {/* 文字格式栏：只在「正在编辑文本框」时浮在该文本框下方过（浮层，不占工具条行高、
          不遮挡文本框、不推挤文档）。父组件已保证 textTarget 非空。 */}
      {showTextBar && (
        <FloatingTextFormatBar
          t={t}
          target={textTarget}
          fallbackRef={textBtnRef}
          onHoverChange={setBarHover}
        />
      )}
      <Popover open={t.eraserOpen} left={eraserPos.left} top={eraserPos.top} onClose={() => t.setEraserOpen(false)} className="eraser-popover">
            <div className="pop-title">橡皮擦设置</div>
            <div className="pop-label">擦除方式</div>
            <div className="seg-group eraser-mode-group">
              <button
                className={`seg-btn ${t.eraser.type === 'pixel' ? 'active' : ''}`}
                aria-pressed={t.eraser.type === 'pixel'}
                onClick={() => t.setEraser((prev) => ({ ...prev, type: 'pixel' }))}
              >
                <span className="eraser-option-icon pixel-eraser-icon" />
                <span>像素橡皮</span>
              </button>
              <button
                className={`seg-btn ${t.eraser.type === 'stroke' ? 'active' : ''}`}
                aria-pressed={t.eraser.type === 'stroke'}
                onClick={() => t.setEraser((prev) => ({ ...prev, type: 'stroke' }))}
              >
                <span className="eraser-option-icon stroke-eraser-icon" />
                <span>笔画橡皮</span>
              </button>
            </div>
            <div className="pop-label">擦除直径 <b>{t.eraser.size * 2}px</b></div>
            <input
              type="range"
              className="size-range"
              aria-label="橡皮擦大小"
              min={4}
              max={60}
              value={t.eraser.size}
              onPointerDown={() => showSizePreview(eraserPreview(t.eraser.size))}
              onChange={(e) => {
                const size = Number(e.target.value)
                t.setEraser((prev) => ({ ...prev, size }))
                showSizePreview(eraserPreview(size))
              }}
            />
            <small className="pop-hint">拖动时屏幕中央显示擦除范围预览</small>
      </Popover>
      <Popover open={t.highlighterOpen} left={hlPos.left} top={hlPos.top} onClose={() => t.setHighlighterOpen(false)}>
            <div className="pop-title">荧光笔设置</div>
            <div className="pop-label">颜色</div>
            <div className="color-row">
              {PEN_COLORS.map((c) => (
                <button
                  key={c}
                  className={`swatch ${t.highlighter.color === c ? 'active' : ''}`}
                  style={{ background: c }}
                  aria-label={`荧光笔颜色 ${c}`}
                  aria-pressed={t.highlighter.color === c}
                  onClick={() => t.setHighlighter((prev) => ({ ...prev, color: c }))}
                  title={c}
                />
              ))}
              <label className="custom-color" title="自定义颜色">
                <input
                  type="color"
                  aria-label="荧光笔自定义颜色"
                  value={t.highlighter.color}
                  onChange={(e) => t.setHighlighter((prev) => ({ ...prev, color: e.target.value }))}
                />
              </label>
            </div>
            <div className="pop-label">
              粗细 <b>{t.highlighter.size}</b>
            </div>
            <input
              type="range"
              className="size-range"
              aria-label="荧光笔粗细"
              min={1}
              max={10}
              value={t.highlighter.size}
              onPointerDown={() => showSizePreview(highlighterPreview(t.highlighter.size))}
              onChange={(e) => {
                const size = Number(e.target.value)
                t.setHighlighter((prev) => ({ ...prev, size }))
                showSizePreview(highlighterPreview(size))
              }}
            />
      </Popover>
      <SizePreviewHud preview={sizePreview} />
    </div>
  )
}

function DocxView({ entry, notify }) {
  const [html, setHtml] = useState('')
  const [ready, setReady] = useState(false)
  const [editing, setEditing] = useState(false) // 内容编辑模式
  const [contentSaving, setContentSaving] = useState(false)
  const [pageDirty, setPageDirty] = useState(false) // 新建了一页、还没写回 .docx
  const docRef = useRef(null)
  const surfaceRef = useRef(null)
  const tools = useAnnotTools({ annKey: 'docx', entry, notify })
  const handleDocClick = useDocLinkGuard(docRef, notify)
  // 编辑态下正文 DOM 才是唯一真源（用户正在打字、可能刚插入分页标记），
  // 用 ref 读最新值：下面那个按 html state 重建 DOM 的 effect 必须避开编辑态
  const editingRef = useRef(false)
  editingRef.current = editing
  // 分页会把文档撑高 → 既有批注按「旧高/新高」重标定，墨迹停在原来那一页
  const markSurfaceHeight = useSurfaceRescale(surfaceRef, makeSurfaceRescaleSettler(tools))

  // 打开：mammoth 渲染
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const htmlText = await renderDocxHtml(entry.file)
        if (cancelled) return
        setHtml(htmlText)
        setReady(true)
      } catch (err) {
        if (!cancelled) notify(`文档解析失败：${err.message}`, 'error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [entry, notify])

  const highlights = useMemo(
    () => tools.list.filter((a) => a.type === 'highlight'),
    [tools.list],
  )
  const [selInHighlight, setSelInHighlight] = useState(false)

  useEffect(() => {
    if (!ready || !docRef.current) return
    // 编辑态跳过：html state 是「进入编辑前的内容」，按它重建 DOM 会把用户刚打的字
    // 和「新建一页」插进去的分页标记一起冲掉（保存走的是 DOM，本来也不需要重建）。
    if (editingRef.current) return
    docRef.current.innerHTML = html
    applyDocxHighlights(docRef.current, highlights)
  }, [ready, html, highlights])

  // 单独切换编辑态：不重建DOM，避免OCR 插入时已保存的光标位置失效
  useEffect(() => {
    if (!ready || !docRef.current) return
    docRef.current.contentEditable = editing ? 'true' : 'false'
  }, [ready, editing])

  // 选中高亮文字 →“高亮选中文字”按钮呈选中态；未选中高亮 →取消选中态
  useEffect(() => {
    const update = () => {
      const sel = window.getSelection()
      if (
        !sel ||
        sel.rangeCount === 0 ||
        sel.isCollapsed ||
        !docRef.current ||
        !docRef.current.contains(sel.anchorNode)
      ) {
        setSelInHighlight(false)
        return
      }
      const { start, end } = getRangeOffsets(docRef.current, sel.getRangeAt(0))
      setSelInHighlight(highlights.some((h) => h.start < end && h.end > start))
    }
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [highlights])

  // 高亮切换：选中高亮文字时点击「删除选中部分高亮」；否则「添加高亮」
  const toggleHighlight = () => {
    const sel = window.getSelection()
    if (
      !sel ||
      sel.rangeCount === 0 ||
      sel.isCollapsed ||
      !docRef.current ||
      !docRef.current.contains(sel.anchorNode)
    ) {
      notify('请先选中要高亮的文字', 'error')
      return
    }
    const { start, end, text } = getRangeOffsets(docRef.current, sel.getRangeAt(0))
    if (start >= end) return
    // 先去掉与新选区重叠的旧高亮（也避免重复高亮叠加）
    const rest = tools.list.filter(
      (a) => a.type !== 'highlight' || !(a.start < end && a.end > start),
    )
    if (selInHighlight) {
      tools.setList(rest)
    } else {
      tools.setList([
        ...rest,
        { id: uid(), type: 'highlight', color: '#ffe58f', start, end, text: text.slice(0, 200) },
      ])
    }
  }

  // 内容编辑 →保存回.docx
  const saveContent = async () => {
    if (!docRef.current) return
    setContentSaving(true)
    try {
      const bytes = await buildDocxFromHtml(docRef.current.innerHTML)
      await saveFileBytes(entry, bytes)
      // 批注存缓存（IndexedDB），不再写回文件 →不弹权限窗
      await saveAnnotations(entry, tools.annRef.current)
      setEditing(false)
      setPageDirty(false)
      notify('文档内容已保存回 .docx', 'success')
    } catch (err) {
      notify(`内容保存失败：${err.message}`, 'error')
    } finally {
      setContentSaving(false)
    }
  }

  /**
   * 新建一页：文末插入分页标记，保存到 .docx 时写成 Word 原生分页符。
   * 编辑态下只动 DOM —— 此时 html state 还是旧的（没包含用户正在打的字），
   * 若改 state 会触发重建 DOM，把未保存的编辑冲掉。
   */
  const addPage = () => {
    markSurfaceHeight()
    if (editing && docRef.current) {
      docRef.current.insertAdjacentHTML('beforeend', PAGE_BREAK_HTML)
    } else {
      setHtml((prev) => prev + PAGE_BREAK_HTML)
    }
    setPageDirty(true)
    notify(
      editing
        ? '已新增一页：点「保存内容到.docx」写入分页符'
        : '已新增一页：点「保存内容到.docx」写入分页符（点「编辑内容」可继续改正文）',
      'success',
    )
  }

  const extraToolbar = (
    <>
      <div className="tool-group">
        <button
          className={`tool-btn ${editing ? 'active' : ''}`}
          title={editing ? '退出内容编辑模式' : '进入内容编辑模式（可修改正文）'}
          onClick={() => setEditing(!editing)}
        >
          <TextCursor size={15} />
          {editing ? '退出编辑' : '编辑内容'}
        </button>
        <NewPageButton
          onClick={addPage}
          title="在文末新增一页：写入 Word 分页符（下次保存内容到 .docx 时落盘）"
        />
        {(editing || pageDirty) && (
          <button className="tool-btn primary" onClick={saveContent} disabled={contentSaving}>
            <Save size={15} />
            {contentSaving ? '保存中…' : '保存内容到.docx'}
          </button>
        )}
      </div>
      <div className="tool-group">
        <button
          className={`tool-btn ${selInHighlight ? 'active' : ''}`}
          title={selInHighlight ? '已选中高亮文字：点击取消该部分高亮' : '选中文字后点击添加高亮'}
          onClick={toggleHighlight}
          onMouseDown={(e) => e.preventDefault()}
        >
          <Highlighter size={15} />
          高亮选中文字
        </button>
      </div>
    </>
  )

  return (
    <div className="doc-view">
      <AnnotToolbar t={tools} extra={extraToolbar} />
      <CommentConnector
        comments={tools.list.filter((a) => a.type === 'comment')}
        selectedId={tools.selectedId}
      >
        <div className="docx-scroll">
          <div
            className={`docx-doc annot-surface ${editing ? 'content-editing' : ''}`}
            ref={surfaceRef}
          >
            <div className="docx-body" ref={docRef} onClick={handleDocClick} />
            {!editing && <AnnotOverlay t={tools} />}
          </div>
        </div>
        <AnnPanel
          items={tools.list}
          selectedIds={tools.selectedIds}
          selectIds={tools.selectIds}
          focusAnn={tools.focusAnn}
          editingId={tools.editingId}
          onEdit={(id) => tools.setEditingId(id)}
          onCommit={tools.commitComment}
          onDelete={tools.deleteAnn}
          onDeleteMany={tools.deleteAnns}
        />
      </CommentConnector>
    </div>
  )
}

function MarkdownView({ entry, notify }) {
  const [blocks, setBlocks] = useState(() => textToBlocks(''))
  const [tick, setTick] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState('')
  const [slashId, setSlashId] = useState(null)
  const [saving, setSaving] = useState(false)
  const blocksRef = useRef(blocks)
  const textRef = useRef({})
  const elRef = useRef({})
  const slashIdRef = useRef(null)
  const saveTimer = useRef(null)
  const previewSurfaceRef = useRef(null)
  const tools = useAnnotTools({ annKey: 'md', entry, notify })
  blocksRef.current = blocks
  slashIdRef.current = slashId
  // 分页会把预览面撑高 → 既有批注按「旧高/新高」重标定，墨迹停在原来的位置
  const markSurfaceHeight = useSurfaceRescale(previewSurfaceRef, makeSurfaceRescaleSettler(tools))

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const text = await readText(entry.file)
        if (cancelled) return
        textRef.current = {}
        setBlocks(textToBlocks(text))
        setDirty(false)
      } catch (err) {
        if (!cancelled) notify(`Markdown 读取失败：${err.message}`, 'error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [entry, notify])

  const saveNow = useCallback(async () => {
    const md = blocksToMarkdown(blocksRef.current, textRef.current)
    setSaving(true)
    try {
      await saveTextFile(entry, md)
      setDirty(false)
      setSavedAt(
        new Date().toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      )
      notify('已保存', 'success')
    } catch (err) {
      notify(`保存失败：${err.message}`, 'error')
    } finally {
      setSaving(false)
    }
  }, [entry, notify])

  const scheduleSave = useCallback(() => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(saveNow, 800)
  }, [saveNow])

  const registerEl = useCallback((id, el) => {
    // el 为 null = 该块（例如分页块）没有可编辑元素，顺手把旧节点摘掉
    if (el) elRef.current[id] = el
    else delete elRef.current[id]
  }, [])

  const initBlockText = useCallback((id, el) => {
    if (!el || el.dataset.inited === '1') return
    el.dataset.inited = '1'
    const text = blocksRef.current.find((b) => b.id === id)?.text || ''
    if (el.tagName === 'TEXTAREA') {
      el.value = text
      el.defaultValue = text
    } else {
      el.innerText = text
    }
    textRef.current[id] = text
  }, [])

  const handleInput = useCallback(
    (id, text) => {
      textRef.current[id] = text
      setDirty(true)
      setTick((t) => t + 1)
      if (text === '/') setSlashId(id)
      else if (slashIdRef.current === id) setSlashId(null)
      scheduleSave()
    },
    [scheduleSave],
  )

  const insertAfter = useCallback(
    (afterId, block) => {
      const idx = blocksRef.current.findIndex((b) => b.id === afterId)
      const next = [...blocksRef.current]
      next.splice(idx + 1, 0, block)
      setBlocks(next)
      setDirty(true)
      setTick((t) => t + 1)
      scheduleSave()
      return block.id
    },
    [scheduleSave],
  )

  const handleKeyDown = useCallback(
    (e, id) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const newId = insertAfter(id, { id: uid(), type: 'p', text: '' })
        requestAnimationFrame(() => {
          const el = elRef.current[newId]
          if (el) {
            el.focus()
            placeCaretAtEnd(el)
          }
        })
        return
      }
      if (e.key === 'Backspace') {
        const text = textRef.current[id] || ''
        const atStart =
          e.target.tagName === 'TEXTAREA'
            ? e.target.selectionStart === 0
            : isCaretAtStart(e.currentTarget)
        if (text === '' || atStart) {
          const idx = blocksRef.current.findIndex((b) => b.id === id)
          if (idx > 0) {
            e.preventDefault()
            const prevId = blocksRef.current[idx - 1].id
            setBlocks(blocksRef.current.filter((b) => b.id !== id))
            setDirty(true)
            setTick((t) => t + 1)
            scheduleSave()
            requestAnimationFrame(() => {
              const el = elRef.current[prevId]
              if (el) {
                el.focus()
                placeCaretAtEnd(el)
              }
            })
          }
        }
      }
      if (e.key === 'Escape') setSlashId(null)
    },
    [insertAfter, scheduleSave],
  )

  const toggleTodo = useCallback(
    (id) => {
      setBlocks((prev) =>
        prev.map((b) => (b.id === id ? { ...b, checked: !b.checked } : b)),
      )
      setDirty(true)
      setTick((t) => t + 1)
      scheduleSave()
    },
    [scheduleSave],
  )

  // 删除块（目前用于分页块上的「×」）
  const removeBlock = useCallback(
    (id) => {
      setBlocks((prev) => prev.filter((b) => b.id !== id))
      delete textRef.current[id]
      delete elRef.current[id]
      setDirty(true)
      setTick((t) => t + 1)
      scheduleSave()
    },
    [scheduleSave],
  )

  // 新建一页：往文末追加一个分页标记块 + 一个空段落（光标落到新页上直接可写）
  const addPage = useCallback(() => {
    markSurfaceHeight()
    const breakBlock = { id: uid(), type: 'pagebreak', text: '' }
    const blankBlock = { id: uid(), type: 'p', text: '' }
    setBlocks([...blocksRef.current, breakBlock, blankBlock])
    setDirty(true)
    setTick((t) => t + 1)
    scheduleSave()
    requestAnimationFrame(() => {
      const el = elRef.current[blankBlock.id]
      if (el) {
        el.focus()
        placeCaretAtEnd(el)
      }
    })
    notify('已新增一页（\\pagebreak 分页标记），已自动保存', 'success')
  }, [markSurfaceHeight, notify, scheduleSave])

  const applySlash = useCallback(
    (id, item) => {
      const el = elRef.current[id]
      if (el) {
        el.dataset.inited = '1'
        if (el.tagName === 'TEXTAREA') el.value = ''
        else el.innerText = ''
      }
      textRef.current[id] = ''
      setBlocks((prev) =>
        prev.map((b) => (b.id === id ? { ...b, type: item.type, text: '' } : b)),
      )
      setSlashId(null)
      setDirty(true)
      setTick((t) => t + 1)
      scheduleSave()
      requestAnimationFrame(() => {
        const nextEl = elRef.current[id]
        if (nextEl) nextEl.focus()
      })
    },
    [scheduleSave],
  )

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        clearTimeout(saveTimer.current)
        saveNow()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saveNow])

  const markdown = blocksToMarkdown(blocksRef.current, textRef.current)

  return (
    <div className="md-view">
      <div className="doc-toolbar">
        <span className="toolbar-title">Markdown 编辑</span>
        <span className={`dirty-dot ${dirty ? 'on' : ''}`} />
        <span className="toolbar-hint">
          {saving ? '保存中…' : dirty ? '未保存' : savedAt ? `已保存${savedAt}` : '实时预览'}
        </span>
        <NewPageButton
          onClick={addPage}
          title="在文末新增一页：写入 \pagebreak 分页标记（Markdown 自动保存）"
        />
        <button
          className="tool-btn"
          onClick={() => {
            clearTimeout(saveTimer.current)
            saveNow()
          }}
        >
          <Save size={15} />
          保存
        </button>
      </div>
      <AnnotToolbar t={tools} />
      <CommentConnector
        comments={tools.list.filter((a) => a.type === 'comment')}
        selectedId={tools.selectedId}
      >
        <div className="md-split">
          <div className="md-pane md-editor">
            {blocks.map((block) => (
              <BlockItem
                key={block.id}
                block={block}
                slashOpen={slashId === block.id}
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                onToggleTodo={toggleTodo}
                onApplySlash={applySlash}
                onDelete={removeBlock}
                registerEl={registerEl}
                initText={initBlockText}
              />
            ))}
          </div>
          <div className="md-pane md-preview">
            <div className="md-preview-surface annot-surface" ref={previewSurfaceRef}>
              <div
                className="md-body"
                dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(markdownForPreview(markdown)) }}
              />
              <AnnotOverlay t={tools} />
            </div>
          </div>
        </div>
        <AnnPanel
          items={tools.list}
          selectedIds={tools.selectedIds}
          selectIds={tools.selectIds}
          focusAnn={tools.focusAnn}
          editingId={tools.editingId}
          onEdit={(id) => tools.setEditingId(id)}
          onCommit={tools.commitComment}
          onDelete={tools.deleteAnn}
          onDeleteMany={tools.deleteAnns}
        />
      </CommentConnector>
    </div>
  )
}

const BlockItem = memo(function BlockItem({
  block,
  slashOpen,
  onInput,
  onKeyDown,
  onToggleTodo,
  onApplySlash,
  onDelete,
  registerEl,
  initText,
}) {
  const refCb = (el) => {
    registerEl(block.id, el)
    initText(block.id, el)
  }
  // 分页块没有输入框，注册时把旧节点摘掉，别让 elRef 里留着已卸载的元素
  const untrack = useCallback(() => registerEl(block.id, null), [registerEl, block.id])
  const common = {
    onInput: (e) => onInput(block.id, e.currentTarget.innerText),
    onKeyDown: (e) => onKeyDown(e, block.id),
    ref: refCb,
    'data-placeholder': BLOCK_PLACEHOLDER[block.type] || '输入文字',
  }
  let element
  if (block.type === 'pagebreak') {
    // 分页块：整块就是一条分页线（不可输入文字），与预览里的分页线一一对应
    element = (
      <div className="block-page-break" role="separator" aria-label="分页（新页）" ref={untrack}>
        <span>新页</span>
        <button
          type="button"
          className="block-page-break-del"
          title="删除这个分页"
          aria-label="删除这个分页"
          onClick={() => onDelete(block.id)}
        >
          <X size={12} />
        </button>
      </div>
    )
  } else if (block.type === 'code') {
    element = (
      <textarea
        className="block block-code"
        defaultValue={block.text}
        rows={3}
        spellCheck={false}
        placeholder={BLOCK_PLACEHOLDER.code}
        onInput={(e) => onInput(block.id, e.target.value)}
        onKeyDown={(e) => onKeyDown(e, block.id)}
        ref={refCb}
      />
    )
  } else if (block.type === 'todo') {
    element = (
      <div className="block-row">
        <input
          type="checkbox"
          className="todo-check"
          checked={!!block.checked}
          onChange={() => onToggleTodo(block.id)}
        />
        <div
          className="block block-todo"
          contentEditable
          suppressContentEditableWarning
          {...common}
        />
      </div>
    )
  } else if (['h1', 'h2', 'h3'].includes(block.type)) {
    const Tag = block.type
    element = (
      <Tag
        className={`block block-${block.type}`}
        contentEditable
        suppressContentEditableWarning
        {...common}
      />
    )
  } else if (block.type === 'quote') {
    element = (
      <blockquote
        className="block block-quote"
        contentEditable
        suppressContentEditableWarning
        {...common}
      />
    )
  } else {
    element = (
      <div
        className="block block-p"
        contentEditable
        suppressContentEditableWarning
        {...common}
      />
    )
  }
  return (
    <div className="block-wrap">
      {element}
      {slashOpen && (
        <div className="slash-menu">
          {SLASH_ITEMS.map((item) => (
            <button
              key={item.type}
              className="slash-item"
              onClick={() => onApplySlash(block.id, item)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
})

/** EPUB 阅读 + 内容编辑 + 批注（zip 内HTML 重打包保存回）*/
function EpubView({ entry, notify }) {
  const [html, setHtml] = useState('')
  const [epubBook, setEpubBook] = useState(null) // { files, getImageBlob, imageSrcs, baseDir, opfPath }
  const [ready, setReady] = useState(false)
  const [editing, setEditing] = useState(false)
  const [contentSaving, setContentSaving] = useState(false)
  const [pageDirty, setPageDirty] = useState(false) // 新建了章节、还没写回 epub
  const docRef = useRef(null)
  const surfaceRef = useRef(null)
  const tools = useAnnotTools({ annKey: 'epub', entry, notify })
  // src →显示用Blob URL（保存时换回原路径）
  const imageMapRef = useRef(new Map())
  const handleDocClick = useDocLinkGuard(docRef, notify)
  // 新章节会把书撑高 → 既有批注按「旧高/新高」重标定，墨迹停在原来那一章
  const markSurfaceHeight = useSurfaceRescale(surfaceRef, makeSurfaceRescaleSettler(tools))

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // 按spine 顺序合并全书正文（旧版只读第一个文件，导致「只显示第一章」）
        const book = await readEpubBook(entry.file)
        if (cancelled) return
        setEpubBook(book)
        setHtml(book.html)
        setReady(true)
      } catch (err) {
        if (!cancelled) notify(`EPUB 解析失败：${err.message}`, 'error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [entry, notify])

  // 正文 DOM 只在 html 变化时重建（声明在资源加载 effect 之前 → 先建 DOM，再挂资源）。
  // 「新建一页」只动 epubBook（追加章节），不会重建 DOM，正在编辑的内容不会被冲掉。
  useEffect(() => {
    if (!ready || !docRef.current) return
    docRef.current.innerHTML = html
  }, [ready, html])

  // 渲染 + 惰性加载资源：先把正文 DOM 放进页面（很快），再分批把相对资源引用换成
  // Blob URL。覆盖<img>、svg <image>(xlink:href/href/src)、srcset、内联style url()、
  // <style> url() ——参考readest/foliate-js 的Loader：相对路径必须相对所在章解析。
  // 大书（几百章/上千图）不会因一次性base64 内联而卡死。
  useEffect(() => {
    if (!ready || !docRef.current || !epubBook) return
    const root = docRef.current
    const { getImageBlob, imageSrcs } = epubBook
    const map = imageMapRef.current
    const chapterDirs = epubBook.files.map((f) => f.path.replace(/[^/]*$/, ''))

    // 元素所在章的目录：向上找到 epub-body 的直接子元素，数前面 nf-epub-split 标记
    const chapterDirOf = (el) => {
      let node = el
      while (node.parentElement && !node.parentElement.classList.contains('epub-body')) {
        node = node.parentElement
      }
      let idx = 0
      let sib = node
      while (sib) {
        if (sib.classList && sib.classList.contains('nf-epub-split')) idx++
        sib = sib.previousElementSibling
      }
      return chapterDirs[idx] ?? ''
    }

    // 占位图：避免几千次相对路径404 请求和裂图闪烁（保存时经 data-nf-* 还原）
    const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    const isExternal = (s) => /^(blob:|data:|https?:|cid:|#)/i.test(s || '')
    const jobs = []

    const tagImg = (el) => {
      const orig = el.getAttribute('src')
      if (!orig || isExternal(orig) || el.dataset.nfRes) return
      const p = resolveZipPath(chapterDirOf(el), orig)
      if (!p || !imageSrcs.has(p)) return
      el.dataset.nfRes = encodeURIComponent(p)
      el.dataset.nfSrc = orig
      el.src = PLACEHOLDER
      jobs.push({ el, kind: 'img', path: p })
    }
    const tagImage = (el) => {
      const attr = el.hasAttribute('xlink:href')
        ? 'xlink:href'
        : el.hasAttribute('href')
          ? 'href'
          : el.hasAttribute('src')
            ? 'src'
            : null
      if (!attr || el.dataset.nfRes) return
      const orig = el.getAttribute(attr)
      if (!orig || isExternal(orig)) return
      const p = resolveZipPath(chapterDirOf(el), orig)
      if (!p || !imageSrcs.has(p)) return
      el.dataset.nfRes = encodeURIComponent(p)
      el.dataset.nfHref = orig
      el.setAttribute(attr, PLACEHOLDER)
      jobs.push({ el, kind: 'image', attr, path: p })
    }
    const tagSrcset = (el) => {
      if (el.dataset.nfSrcset) return
      const orig = el.getAttribute('srcset')
      if (!orig) return
      const cands = orig.split(',')
      const paths = []
      const out = []
      for (const cand of cands) {
        const mm = cand.trim().match(/^(\S+)([\s\S]*)$/)
        if (!mm) {
          paths.push('')
          out.push(cand)
          continue
        }
        const p = resolveZipPath(chapterDirOf(el), mm[1])
        if (!p || !imageSrcs.has(p)) {
          paths.push('')
          out.push(cand)
          continue
        }
        paths.push(p)
        out.push(`data-nf-res://${encodeURIComponent(p)}${mm[2] ? ' ' + mm[2].trim() : ''}`)
      }
      if (!paths.some(Boolean)) return
      el.dataset.nfSrcset = orig
      el.dataset.nfSrcsetPaths = JSON.stringify(paths)
      el.dataset.nfRes = encodeURIComponent(paths.find(Boolean))
      el.setAttribute('srcset', out.join(', '))
      jobs.push({ el, kind: 'srcset' })
    }
    const tagStyle = (el) => {
      if (el.dataset.nfStyle) return
      const style = el.getAttribute('style')
      if (!style || !/url\(/i.test(style)) return
      let changed = false
      const newStyle = style.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (mm, q, url) => {
        const p = resolveZipPath(chapterDirOf(el), url.trim())
        if (!p || !imageSrcs.has(p)) return mm
        changed = true
        return `url("data-nf-res://${encodeURIComponent(p)}")`
      })
      if (!changed) return
      el.dataset.nfStyle = style
      el.setAttribute('style', newStyle)
      jobs.push({ el, kind: 'style' })
    }
    const tagStyleTag = (el) => {
      if (el.dataset.nfCss) return
      const css = el.textContent
      if (!css || !/url\(/i.test(css)) return
      let changed = false
      const newCss = css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (mm, q, url) => {
        const p = resolveZipPath(chapterDirOf(el), url.trim())
        if (!p || !imageSrcs.has(p)) return mm
        changed = true
        return `url("data-nf-res://${encodeURIComponent(p)}")`
      })
      if (!changed) return
      el.dataset.nfCss = css
      el.textContent = newCss
      jobs.push({ el, kind: 'styleTag' })
    }

    for (const el of root.querySelectorAll('img')) tagImg(el)
    for (const el of root.querySelectorAll('image')) tagImage(el)
    for (const el of root.querySelectorAll('[srcset]')) tagSrcset(el)
    for (const el of root.querySelectorAll('[style]')) tagStyle(el)
    for (const el of root.querySelectorAll('style')) tagStyleTag(el)

    let i = 0
    let stopped = false
    const blobFor = async (path) => {
      if (map.has(path)) return map.get(path)
      const blob = await getImageBlob(path)
      if (!blob) return null
      const url = URL.createObjectURL(blob)
      map.set(path, url)
      return url
    }
    // 把style/<style> 里的 data-nf-res:// 令牌换成 blob URL（令牌期间浏览器忽略该声明）
    const swapStyleText = async (text) => {
      const tokens = []
      text.replace(/url\(\s*["']?data-nf-res:\/\/([^"')]+)["']?\s*\)/gi, (mm, enc) => {
        tokens.push({ mm, enc })
        return mm
      })
      let out = text
      for (const { mm, enc } of tokens) {
        const url = await blobFor(decodeURIComponent(enc))
        out = out.split(mm).join(url ? `url("${url}")` : mm)
      }
      return out
    }
    const step = async () => {
      if (stopped) return
      const batch = jobs.slice(i, i + 24)
      i += batch.length
      await Promise.all(
        batch.map(async ({ el, kind, attr, path }) => {
          try {
            if (kind === 'img') {
              const url = await blobFor(path)
              if (url) el.src = url
            } else if (kind === 'image') {
              const url = await blobFor(path)
              if (url) el.setAttribute(attr, url)
            } else if (kind === 'srcset') {
              const cands = (el.dataset.nfSrcset || '').split(',')
              let paths = []
              try {
                paths = JSON.parse(el.dataset.nfSrcsetPaths || '[]')
              } catch {
                // 忽略损坏的映射
              }
              const out = []
              for (let c = 0; c < cands.length; c++) {
                const cand = cands[c]
                const mm = cand.trim().match(/^(\S+)([\s\S]*)$/)
                if (!mm || !paths[c]) {
                  out.push(cand)
                  continue
                }
                const url = await blobFor(paths[c])
                out.push(url ? url + (mm[2] ? ' ' + mm[2].trim() : '') : cand)
              }
              el.setAttribute('srcset', out.join(', '))
            } else if (kind === 'style') {
              el.setAttribute('style', await swapStyleText(el.getAttribute('style') || ''))
            } else if (kind === 'styleTag') {
              el.textContent = await swapStyleText(el.textContent || '')
            }
          } catch {
            // 单个资源失败不影响其他
          }
        }),
      )
      if (i < jobs.length && !stopped) setTimeout(step, 25)
    }
    step()
    return () => {
      stopped = true
    }
  }, [ready, html, epubBook])

  // 单独切换编辑态：不重建DOM，避免OCR 插入时已保存的光标位置失效
  useEffect(() => {
    if (!ready || !docRef.current) return
    docRef.current.contentEditable = editing ? 'true' : 'false'
  }, [ready, editing])

  const saveContent = async () => {
    if (!docRef.current || !epubBook) return
    setContentSaving(true)
    try {
      const root = docRef.current
      // 统一还原为原始相对引用：占位图（未完成懒加载）和已换 blob 的都经data-nf-*
      // 还原，避免把透明 GIF/blob URL/data-nf 标记写进 epub，也避免字符串替换遗漏
      for (const el of root.querySelectorAll('img[data-nf-src]')) {
        el.setAttribute('src', el.dataset.nfSrc)
        el.removeAttribute('data-nf-src')
      }
      for (const el of root.querySelectorAll('image[data-nf-href]')) {
        const attr = el.hasAttribute('xlink:href')
          ? 'xlink:href'
          : el.hasAttribute('href')
            ? 'href'
            : 'src'
        el.setAttribute(attr, el.dataset.nfHref)
        el.removeAttribute('data-nf-href')
      }
      for (const el of root.querySelectorAll('[data-nf-srcset]')) {
        el.setAttribute('srcset', el.dataset.nfSrcset)
        el.removeAttribute('data-nf-srcset')
        el.removeAttribute('data-nf-srcset-paths')
      }
      for (const el of root.querySelectorAll('[data-nf-style]')) {
        el.setAttribute('style', el.dataset.nfStyle)
        el.removeAttribute('data-nf-style')
      }
      for (const el of root.querySelectorAll('style[data-nf-css]')) {
        el.textContent = el.dataset.nfCss
        el.removeAttribute('data-nf-css')
      }
      // 清除剩余 data-nf-* 标记（不写进 epub）
      for (const el of root.querySelectorAll('[data-nf-res]')) {
        el.removeAttribute('data-nf-res')
      }
      // 按章间标记拆回各章，逐文件写回（保留每章 head/命名空间）；
      // 「新建一页」追加的章节不在原 zip 里，saveEpubBook 会创建文件并登记进 OPF
      await saveEpubBook(entry, epubBook.files, root, { opfPath: epubBook.opfPath })
      // 保存后视图同步为已保存内容（含还原后的原始引用，重新渲染时再次惰性换 Blob）
      setHtml(root.innerHTML)
      // 重新内嵌批注（zip 重打包会覆盖此前内嵌的批注数据）
      if ((tools.annRef.current.epub || []).length) {
        await saveAnnotations(entry, tools.annRef.current)
      }
      setEditing(false)
      setPageDirty(false)
      notify(`EPUB 内容已保存（${epubBook.files.length} 章）`, 'success')
    } catch (err) {
      notify(`EPUB 保存失败：${err.message}`, 'error')
    } finally {
      setContentSaving(false)
    }
  }

  /**
   * 新建一页：EPUB 里「一页」就是一章——在书末追加一个空白章节（xhtml）。
   * 合并视图里用与 readEpubBook 相同的章间标记 <hr class="nf-epub-split"> 分隔，
   * 保存时 saveEpubBook 拆回各章、创建新文件并写进 OPF 的 manifest/spine。
   */
  const addPage = () => {
    if (!epubBook) return
    markSurfaceHeight()
    let index = (epubBook.files.length || 0) + 1
    let chapter = makeEpubChapter(epubBook.baseDir || '', index)
    // 路径不能撞已有条目（书里可能本来就有同名文件）
    while (epubBook.files.some((f) => f.path === chapter.path)) {
      index += 1
      chapter = makeEpubChapter(epubBook.baseDir || '', index)
    }
    setEpubBook((prev) =>
      prev
        ? { ...prev, files: [...prev.files, chapter], count: prev.files.length + 1 }
        : prev,
    )
    const markup = `<hr class="nf-epub-split" data-nf-epub="${chapter.path}">${chapter.body}`
    // 编辑态下只动 DOM：html state 还是编辑前的内容，改它会触发按 state 重建 DOM，
    // 把用户正在改的正文冲掉（保存读的是 DOM，本来就够用）。
    if (editing && docRef.current) docRef.current.insertAdjacentHTML('beforeend', markup)
    else setHtml((prev) => prev + markup)
    setPageDirty(true)
    notify(`已新增一页「新页 ${index}」（新章节），点「保存到 EPUB」写入书末`, 'success')
  }

  const extraToolbar = (
    <div className="tool-group">
      <button
        className={`tool-btn ${editing ? 'active' : ''}`}
        title="进入内容编辑模式（可修改正文）"
        onClick={() => setEditing(!editing)}
      >
        <TextCursor size={15} />
        {editing ? '退出编辑' : '编辑内容'}
      </button>
      <NewPageButton
        onClick={addPage}
        title="在书末新增一页：追加一个空白章节（写进 OPF 的阅读顺序）"
        disabled={!ready}
      />
      {(editing || pageDirty) && (
        <button className="tool-btn primary" onClick={saveContent} disabled={contentSaving}>
          <Save size={15} />
          {contentSaving ? '保存中…' : '保存到EPUB'}
        </button>
      )}
    </div>
  )

  return (
    <div className="doc-view">
      <AnnotToolbar t={tools} extra={extraToolbar} />
      <CommentConnector
        comments={tools.list.filter((a) => a.type === 'comment')}
        selectedId={tools.selectedId}
      >
        <div className="docx-scroll">
          {!ready ? (
            <div className="loading">正在加载 EPUB 全书…</div>
          ) : (
            <div
              className={`docx-doc epub-doc annot-surface ${editing ? 'content-editing' : ''}`}
              ref={surfaceRef}
            >
              <div className="epub-body" ref={docRef} onClick={handleDocClick} />
              {!editing && <AnnotOverlay t={tools} />}
            </div>
          )}
        </div>
        <AnnPanel
          items={tools.list}
          selectedIds={tools.selectedIds}
          selectIds={tools.selectIds}
          focusAnn={tools.focusAnn}
          editingId={tools.editingId}
          onEdit={(id) => tools.setEditingId(id)}
          onCommit={tools.commitComment}
          onDelete={tools.deleteAnn}
          onDeleteMany={tools.deleteAnns}
        />
      </CommentConnector>
    </div>
  )
}

/** Excel 表格渲染（SheetJS）+ 内容编辑：单元格可直接编辑，保存时写回xlsx 原文件*/
// ─── Excel 网格编辑器（openpyxl 服务端修改+ 前端网格 UI）────────────────

/** 表格单元格显示文本（只读展示）*/
function cellDisplay(v) {
  if (v === null || v === undefined || v === '') return ''
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (v instanceof Date) return v.toLocaleDateString('zh-CN')
  if (typeof v === 'number') return v.toLocaleString('zh-CN')
  return String(v)
}

/** 单元格编辑框里的原始文本 */
function cellRaw(v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

/** 把编辑输入解析为 (值, 类型)：空→清空；=开头→公式字符串；数字/布尔→对应类型；否则字符串*/
function parseCellInput(text) {
  const t = (text ?? '').trim()
  if (t === '') return { v: null, t: 'e' }
  if (t.startsWith('=')) return { v: t, t: 's' }
  if (/^[+-]?(\d[\d,]*)(\.\d+)?$/.test(t)) {
    const n = Number(t.replace(/,/g, ''))
    if (Number.isFinite(n)) return { v: n, t: 'n' }
  }
  if (/^(true|false)$/i.test(t)) return { v: /^true$/i.test(t), t: 'b' }
  return { v: t, t: 's' }
}

/** 新旧单元格值是否等效（空字符串与null 视为一致） */
function sameCellValue(a, b) {
  if (a === b) return true
  if (a == null && (b == null || b === '')) return true
  if (b == null && (a == null || a === '')) return true
  return false
}

/** 列字母标号：0→A, 25→Z, 26→AA */
function colLabel(i) {
  let s = ''
  let n = i + 1
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** 深拷贝网格（撤销重放用） */
function cloneGrid(values) {
  return (values || []).map((row) => (Array.isArray(row) ? row.slice() : []))
}

/** 新工作表默认给一页空白格的行列数 */
const EXCEL_BLANK_ROWS = 16
const EXCEL_BLANK_COLS = 6

/**
 * 空白页网格（全是 null）。
 * 用它的原因：Excel 视图的行列数是按 values 推导的 —— values 是空数组时只能渲染出 1×1，
 * 「新建一页」看着像没建出来：点不到别的格子、方向键也一步都走不动。
 * 值都是 null 不影响保存：保存走 ops（服务端忽略 values），新工作表在文件里仍是空工作表。
 */
function blankExcelGrid() {
  return Array.from({ length: EXCEL_BLANK_ROWS }, () =>
    Array.from({ length: EXCEL_BLANK_COLS }, () => null),
  )
}

function ExcelView({ entry, notify }) {
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [editing, setEditing] = useState(false)
  const [sheets, setSheets] = useState([])
  const [sheetIdx, setSheetIdx] = useState(0)
  const [sel, setSel] = useState({ r: 0, c: 0, r2: 0, c2: 0 })
  const [editingCell, setEditingCell] = useState(null)
  const [cellText, setCellText] = useState('')
  const [saving, setSaving] = useState(false)
  const [wbOps, setWbOps] = useState([])
  const gridRef = useRef(null)
  const dragRef = useRef(null)
  const editingCellRef = useRef(null)
  const editingSheetRef = useRef(0)
  const cellTextRef = useRef('')
  const redoOpsRef = useRef([]) // 重做栈：撤销时被移除的 op（{ idx, op }）
  const tools = useAnnotTools({ annKey: 'excel', entry, notify })

  // 记录一条编辑操作：应用到指定表的网格 + 追加 ops（服务端按顺序重放）
  const pushOpTo = useCallback((idx, op) => {
    redoOpsRef.current = [] // 新操作打断重做链
    setSheets((prev) =>
      prev.map((s, i) => {
        if (i !== idx) return s
        applyGridOp(s.values, s.merges, op)
        return { ...s, ops: [...s.ops, op] }
      }),
    )
  }, [])

  const pushOp = useCallback((op) => pushOpTo(sheetIdx, op), [pushOpTo, sheetIdx])

  const active = sheets[sheetIdx] || null

  const mutateSheet = useCallback((idx, fn) => {
    setSheets((prev) => prev.map((s, i) => (i === idx ? fn(s) : s)))
  }, [])

  // 解析文件 →sheets 状态
  const load = useCallback(async () => {
    const src =
      entry.handle && typeof entry.handle.getFile === 'function'
        ? await entry.handle.getFile()
        : entry.file
    const { sheets: parsed } = await readExcelGrid(src)
    setSheets(
      parsed.map((s) => ({
        ...s,
        id: uid(),
        ops: [],
        baseValues: cloneGrid(s.values),
        baseMerges: (s.merges || []).slice(),
      })),
    )
    setSheetIdx(0)
    setSel({ r: 0, c: 0, r2: 0, c2: 0 })
    setWbOps([])
    redoOpsRef.current = []
    setReady(true)
  }, [entry])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await load()
      } catch (err) {
        if (!cancelled) {
          setLoadError(err.message)
          setReady(true)
          notify(`表格解析失败：${err.message}`, 'error')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [load, notify])

  // 编辑模式下，鼠标松开结束拖拽框选
  useEffect(() => {
    if (!editing) return
    const up = () => {
      dragRef.current = null
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [editing])

  // 进入编辑模式时聚焦网格，让键盘快捷键生效
  useEffect(() => {
    if (editing) gridRef.current?.focus()
  }, [editing])

  useEffect(() => {
    editingCellRef.current = editingCell
  }, [editingCell])
  useEffect(() => {
    cellTextRef.current = cellText
  }, [cellText])

  // 合并区域索引：anchor →{r1,c1,r2,c2}，covered →被合并覆盖的格子
  const mergeMap = useMemo(() => {
    const map = new Map()
    const covered = new Set()
    for (const m of active?.merges || []) {
      for (let r = m.r1; r <= m.r2; r++) {
        for (let c = m.c1; c <= m.c2; c++) covered.add(`${r},${c}`)
      }
      map.set(`${m.r1},${m.c1}`, m)
    }
    return { map, covered }
  }, [sheets, sheetIdx]) // 依赖 sheets：合并是原地变更，需在每次操作后重建

  const undo = () => {
    const cur = sheets[sheetIdx]
    if (!cur || !cur.ops.length) {
      notify('没有可撤销的操作', 'info')
      return
    }
    redoOpsRef.current.push({ idx: sheetIdx, op: cur.ops[cur.ops.length - 1] })
    const ops = cur.ops.slice(0, -1)
    const values = cloneGrid(cur.baseValues)
    const merges = (cur.baseMerges || []).slice()
    for (const op of ops) applyGridOp(values, merges, op)
    mutateSheet(sheetIdx, (s) => ({ ...s, ops, values, merges }))
  }

  const redo = () => {
    const item = redoOpsRef.current.pop()
    if (!item || item.idx !== sheetIdx) {
      notify('没有可重做的操作', 'info')
      return
    }
    const cur = sheets[sheetIdx]
    const ops = [...cur.ops, item.op]
    const values = cloneGrid(cur.baseValues)
    const merges = (cur.baseMerges || []).slice()
    for (const op of ops) applyGridOp(values, merges, op)
    mutateSheet(sheetIdx, (s) => ({ ...s, ops, values, merges }))
  }

  const insertRows = (above) => {
    const { r, r2 } = sel
    const at = above ? r : r2 + 1
    const amount = r2 - r + 1
    pushOp({ op: 'insertRow', at, amount })
    setSel({ r: at, c: sel.c, r2: at + amount - 1, c2: sel.c2 })
  }

  const insertCols = (left) => {
    const { c, c2 } = sel
    const at = left ? c : c2 + 1
    const amount = c2 - c + 1
    pushOp({ op: 'insertCol', at, amount })
    setSel({ r: sel.r, c: at, r2: sel.r2, c2: at + amount - 1 })
  }

  const deleteRows = () => {
    const { r, r2 } = sel
    pushOp({ op: 'deleteRow', at: r, amount: r2 - r + 1 })
    const rows = Math.max(1, (active?.values || []).length)
    const nr = Math.min(r, Math.max(0, rows - 1))
    setSel({ r: nr, c: sel.c, r2: nr, c2: sel.c2 })
  }

  const deleteCols = () => {
    const { c, c2 } = sel
    pushOp({ op: 'deleteCol', at: c, amount: c2 - c + 1 })
    const cols = Math.max(1, (active?.values || []).reduce((m, row) => Math.max(m, row.length), 0))
    const nc = Math.min(c, Math.max(0, cols - 1))
    setSel({ r: sel.r, c: nc, r2: sel.r2, c2: nc })
  }

  const clearCells = () => {
    const { r, r2, c, c2 } = sel
    let n = 0
    for (let i = r; i <= r2; i++) {
      for (let j = c; j <= c2; j++) {
        pushOp({ op: 'set', r: i, c: j, v: null, t: 'e' })
        n++
      }
    }
    if (n) notify(`已清空${n} 个单元格`, 'info')
  }

  const toggleMerge = () => {
    const { r, r2, c, c2 } = sel
    if (r === r2 && c === c2) {
      notify('请先框选要合并的单元格区域', 'error')
      return
    }
    const merged = (active?.merges || []).some(
      (m) => m.r1 === r && m.c1 === c && m.r2 === r2 && m.c2 === c2,
    )
    pushOp(merged ? { op: 'unmerge', r1: r, c1: c, r2, c2 } : { op: 'merge', r1: r, c1: c, r2, c2 })
  }

  const selectCell = (r, c) => {
    const m = mergeMap.map.get(`${r},${c}`)
    if (m) setSel({ r: m.r1, c: m.c1, r2: m.r2, c2: m.c2 })
    else setSel({ r, c, r2: r, c2: c })
  }

  const selectRow = (r) => {
    const cols = Math.max(1, (active?.values || []).reduce((m, row) => Math.max(m, row.length), 0))
    setSel({ r, c: 0, r2: r, c2: cols - 1 })
  }

  const selectCol = (c) => {
    const rows = Math.max(1, (active?.values || []).length)
    setSel({ r: 0, c, r2: rows - 1, c2: c })
  }

  const startEdit = (r, c) => {
    if (!editing) return
    if (editingCellRef.current) commitEdit()
    editingSheetRef.current = sheetIdx
    setEditingCell({ r, c })
    setCellText(cellRaw(active?.values?.[r]?.[c]))
    setSel({ r, c, r2: r, c2: c })
  }

  const commitEdit = () => {
    const ec = editingCellRef.current
    if (!ec) return
    const sheet = sheets[editingSheetRef.current]
    const old = sheet?.values?.[ec.r]?.[ec.c] ?? null
    const parsed = parseCellInput(cellTextRef.current)
    if (!sameCellValue(old, parsed.v)) {
      pushOpTo(editingSheetRef.current, { op: 'set', r: ec.r, c: ec.c, v: parsed.v, t: parsed.t })
    }
    editingCellRef.current = null
    setEditingCell(null)
    gridRef.current?.focus()
  }

  const cancelEdit = () => {
    editingCellRef.current = null
    setEditingCell(null)
    gridRef.current?.focus()
  }

  const keyMove = (e, dr, dc) => {
    const rows = Math.max(1, (active?.values || []).length)
    const cols = Math.max(1, (active?.values || []).reduce((m, row) => Math.max(m, row.length), 0))
    if (e.shiftKey) {
      setSel((prev) => ({
        r: prev.r,
        c: prev.c,
        r2: Math.min(rows - 1, Math.max(prev.r, prev.r2 + dr)),
        c2: Math.min(cols - 1, Math.max(prev.c, prev.c2 + dc)),
      }))
    } else {
      const r = Math.min(rows - 1, Math.max(0, sel.r + dr))
      const c = Math.min(cols - 1, Math.max(0, sel.c + dc))
      setSel({ r, c, r2: r, c2: c })
    }
  }

  const onCellMouseDown = (e, r, c) => {
    if (!editing) return
    if (e.target.closest && e.target.closest('.cell-editor')) return
    e.preventDefault() // 防拖选文字，同时保持网格容器焦点
    gridRef.current?.focus()
    if (e.shiftKey) {
      setSel((prev) => ({ r: prev.r, c: prev.c, r2: r, c2: c }))
      return
    }
    dragRef.current = { anchor: { r, c } }
    selectCell(r, c)
  }

  const onCellMouseEnter = (r, c) => {
    const d = dragRef.current
    if (!d) return
    setSel({
      r: Math.min(d.anchor.r, r),
      c: Math.min(d.anchor.c, c),
      r2: Math.max(d.anchor.r, r),
      c2: Math.max(d.anchor.c, c),
    })
  }

  const handleKeyDown = (e) => {
    if (!editing || editingCell) return
    const isCtrlAlt =
      e.ctrlKey && e.altKey && !(e.getModifierState && e.getModifierState('AltGraph'))
    if (e.key.startsWith('Arrow')) {
      if (isCtrlAlt) {
        e.preventDefault()
        if (e.key === 'ArrowUp') insertRows(true)
        else if (e.key === 'ArrowDown') insertRows(false)
        else if (e.key === 'ArrowLeft') insertCols(true)
        else if (e.key === 'ArrowRight') insertCols(false)
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      e.preventDefault()
      if (e.key === 'ArrowUp') keyMove(e, -1, 0)
      else if (e.key === 'ArrowDown') keyMove(e, 1, 0)
      else if (e.key === 'ArrowLeft') keyMove(e, 0, -1)
      else if (e.key === 'ArrowRight') keyMove(e, 0, 1)
      return
    }
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault()
      startEdit(sel.r, sel.c)
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      keyMove(e, 0, e.shiftKey ? -1 : 1)
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      clearCells()
      return
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      undo()
      return
    }
    if (
      ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'y') ||
      ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z')
    ) {
      e.preventDefault()
      redo()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'm') {
      e.preventDefault()
      toggleMerge()
      return
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key.length === 1) {
      e.preventDefault()
      startEdit(sel.r, sel.c)
      setCellText(e.key)
    }
  }

  const onCellEditorKeyDown = (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      commitEdit()
      keyMove(e, e.shiftKey ? -1 : 1, 0)
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      commitEdit()
      keyMove(e, 0, e.shiftKey ? -1 : 1)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    }
  }

  const onCellEditorBlur = () => {
    // 已取消（Escape）或已提交（Enter 后卸载触发blur）时不再重复提交
    if (!editingCellRef.current) return
    commitEdit()
  }

  // ─── 工作表管理───
  const uniqueSheetName = (base) => {
    const names = new Set(sheets.map((s) => s.name))
    let n = (base || 'Sheet').replace(/[\\/?*[\]:]/g, '').slice(0, 31).trim() || 'Sheet'
    let i = 1
    while (names.has(n)) {
      const prefix = n.slice(0, 28)
      n = `${prefix}${i}`
      i++
    }
    return n
  }

  const addSheet = () => {
    const s = {
      id: uid(),
      name: uniqueSheetName(`Sheet${sheets.length + 1}`),
      origIndex: -1,
      // 新工作表给一块空白页网格：界面上的行列数是按 values 推导的，空数组只能渲染出 1×1 ——
      // 「新建一页」看着像没建出来，方向键一步都走不动，也没法在旁边格子写字。
      // 值都是 null，不会影响保存结果：保存走 ops（服务端忽略 values），空工作表就是空工作表。
      values: blankExcelGrid(),
      merges: [],
      ops: [],
      baseValues: blankExcelGrid(),
      baseMerges: [],
    }
    setSheets((prev) => [...prev, s])
    setSheetIdx(sheets.length)
    return s
  }

  /** 新建一页：Excel 里「一页」= 一张工作表（工具栏入口，不必先手动进编辑模式）*/
  const addPage = () => {
    if (!editing) setEditing(true)
    const s = addSheet()
    notify(`已新建工作表「${s.name}」：点「保存回Excel」写入文件`, 'success')
  }

  const renameSheet = () => {
    const cur = active
    if (!cur) return
    const input = window.prompt('新工作表名称：', cur.name)
    if (input === null || input === undefined) return
    const name = uniqueSheetName(input)
    if (cur.origIndex >= 0) {
      setWbOps((prev) => [...prev, { op: 'renameSheet', sheetIndex: cur.origIndex, name }])
    }
    mutateSheet(sheetIdx, (s) => ({ ...s, name }))
  }

  const deleteSheet = (i) => {
    const s = sheets[i]
    if (!s) return
    if (sheets.length <= 1) {
      notify('至少保留一个工作表', 'error')
      return
    }
    if (!window.confirm(`删除工作表「${s.name}」？该操作不可撤销。`)) return
    if (s.origIndex >= 0) {
      setWbOps((prev) => [...prev, { op: 'deleteSheet', sheetIndex: s.origIndex }])
    }
    const next = sheets.filter((_, idx) => idx !== i)
    setSheets(next)
    setSheetIdx((idx) => Math.min(idx, next.length - 1))
  }

  const toggleEditing = () => {
    if (editing && editingCellRef.current) commitEdit()
    setEditing(!editing)
  }

  const saveContent = async () => {
    if (editingCellRef.current) commitEdit()
    setSaving(true)
    try {
      const payload = {
        wbOps,
        sheets: sheets.map((s) => ({
          sheetIndex: s.origIndex,
          name: s.name,
          ops: s.ops,
          values: s.values,
          merges: s.merges,
        })),
      }
      await saveExcelChanges(entry, payload)
      await load()
      notify('已保存回 Excel 文件（openpyxl 修改）', 'success')
    } catch (err) {
      notify(`保存失败：${err.message}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const extraToolbar = (
    <>
      <div className="tool-group">
        <button
          className={`tool-btn ${editing ? 'active' : ''}`}
          title={editing ? '退出编辑模式' : '进入编辑模式（修改单元格 / 插入行列 / 合并 / 工作表）'}
          onClick={toggleEditing}
        >
          <TextCursor size={15} />
          {editing ? '退出编辑' : '编辑内容'}
        </button>
        <NewPageButton
          onClick={addPage}
          title="新建一页：Excel 里一页就是一张工作表（自动进入编辑模式）"
        />
        {(editing || wbOps.length > 0 || sheets.some((s) => s.ops.length > 0)) && (
          <button className="tool-btn primary" onClick={saveContent} disabled={saving}>
            <Save size={15} />
            {saving ? '保存中…' : '保存回Excel'}
          </button>
        )}
      </div>
      {editing && (
        <>
          <div className="tool-group" title="插入 / 删除行与列">
            <ToolButton
              title="在上方插入行 (Ctrl+Alt+↑)"
              icon={ArrowUp}
              onClick={() => {
                insertRows(true)
                gridRef.current?.focus()
              }}
            />
            <ToolButton
              title="在下方插入行 (Ctrl+Alt+↓)"
              icon={ArrowDown}
              onClick={() => {
                insertRows(false)
                gridRef.current?.focus()
              }}
            />
            <ToolButton
              title="删除选中行"
              icon={Trash2}
              onClick={() => {
                deleteRows()
                gridRef.current?.focus()
              }}
            />
            <ToolButton
              title="在左侧插入列 (Ctrl+Alt+←)"
              icon={ArrowLeft}
              onClick={() => {
                insertCols(true)
                gridRef.current?.focus()
              }}
            />
            <ToolButton
              title="在右侧插入列 (Ctrl+Alt+→)"
              icon={ArrowRight}
              onClick={() => {
                insertCols(false)
                gridRef.current?.focus()
              }}
            />
            <ToolButton
              title="删除选中列"
              icon={Delete}
              onClick={() => {
                deleteCols()
                gridRef.current?.focus()
              }}
            />
          </div>
          <div className="tool-group">
            <ToolButton
              title="清空选中单元格内容(Del)"
              icon={X}
              onClick={() => {
                clearCells()
                gridRef.current?.focus()
              }}
            />
            <ToolButton
              title="合并 / 取消合并选中区域 (Ctrl+Shift+M)"
              icon={Merge}
              onClick={() => {
                toggleMerge()
                gridRef.current?.focus()
              }}
            />
            <ToolButton
              title="撤销 (Ctrl+Z)"
              icon={Undo2}
              onClick={() => {
                undo()
                gridRef.current?.focus()
              }}
            />
            <ToolButton
              title="重做 (Ctrl+Y)"
              icon={Redo2}
              onClick={() => {
                redo()
                gridRef.current?.focus()
              }}
            />
          </div>
        </>
      )}
    </>
  )

  const sheetBar = (
    <div className="sheet-tabs">
      {sheets.map((s, i) => (
        <button
          key={s.id}
          className={`sheet-tab ${i === sheetIdx ? 'active' : ''}`}
          title={s.name}
          onClick={() => setSheetIdx(i)}
        >
          {s.name}
          {s.ops.length > 0 && <span className="sheet-dirty" title="有未保存的修改" />}
          {editing && sheets.length > 1 && (
            <span
              className="sheet-close"
              title="删除工作表"
              onClick={(e) => {
                e.stopPropagation()
                deleteSheet(i)
              }}
            >
              ×
            </span>
          )}
        </button>
      ))}
      {editing && (
        <button className="sheet-add" title="新建工作表" onClick={addSheet}>
          <Plus size={12} />
        </button>
      )}
      {editing && active && (
        <button className="sheet-rename" title="重命名当前工作表" onClick={renameSheet}>
          重命名        </button>
      )}
    </div>
  )

  const renderCell = (r, c, m) => {
    const inRange = r >= sel.r && r <= sel.r2 && c >= sel.c && c <= sel.c2
    const isAnchor = r === sel.r && c === sel.c && !editingCell
    const v = active?.values?.[r]?.[c]
    const editingHere = editingCell && editingCell.r === r && editingCell.c === c
    return (
      <td
        key={`${r},${c}`}
        rowSpan={m ? m.r2 - m.r1 + 1 : undefined}
        colSpan={m ? m.c2 - m.c1 + 1 : undefined}
        className={`cell${inRange ? ' in-range' : ''}${isAnchor ? ' anchor' : ''}${m ? ' merged' : ''}`}
        onMouseDown={(e) => onCellMouseDown(e, r, c)}
        onMouseEnter={() => onCellMouseEnter(r, c)}
        onClick={() => {
          if (!editingCell) selectCell(r, c)
        }}
        onDoubleClick={() => {
          if (editing) startEdit(r, c)
        }}
        title={v == null || v === '' ? '' : cellDisplay(v)}
      >
        {editingHere ? (
          <input
            className="cell-editor"
            autoFocus
            value={cellText}
            onChange={(e) => setCellText(e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={onCellEditorKeyDown}
            onBlur={onCellEditorBlur}
            onMouseDown={(e) => e.stopPropagation()}
          />
        ) : (
          cellDisplay(v)
        )}
      </td>
    )
  }

  const renderGrid = () => {
    if (!active) return null
    const rowCount = Math.max(1, active.values.length)
    const colCount = Math.max(1, active.values.reduce((m, row) => Math.max(m, row.length), 0))
    const rows = []
    for (let r = 0; r < rowCount; r++) {
      const tds = []
      for (let c = 0; c < colCount; c++) {
        const key = `${r},${c}`
        const m = mergeMap.map.get(key)
        // 被合并覆盖的格子跳过（锚点格保留，负责colspan/rowspan）
        if (mergeMap.covered.has(key) && !m) continue
        tds.push(renderCell(r, c, m))
      }
      rows.push(
        <tr key={r}>
          <th className="row-head" title={`选中第${r + 1} 行`} onClick={() => selectRow(r)}>
            {r + 1}
          </th>
          {tds}
        </tr>,
      )
    }
    return (
      <table className="excel-grid">
        <thead>
          <tr>
            <th className="corner" />
            {Array.from({ length: colCount }, (_, c) => (
              <th
                key={c}
                className="col-head"
                title={`选中 ${colLabel(c)} 列`}
                onClick={() => selectCol(c)}
              >
                {colLabel(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    )
  }

  return (
    <div className="doc-view">
      <AnnotToolbar t={tools} extra={extraToolbar} />
      {ready && sheets.length > 0 && sheetBar}
      <CommentConnector
        comments={tools.list.filter((a) => a.type === 'comment')}
        selectedId={tools.selectedId}
      >
        <div className="docx-scroll excel-scroll">
          {!ready ? (
            <div className="loading">正在解析表格…</div>
          ) : loadError ? (
            <div className="file-error">表格解析失败：{loadError}</div>
          ) : (
            <div className={`docx-doc excel-doc annot-surface ${editing ? 'content-editing' : ''}`}>
              <div
                className={`excel-body ${editing ? 'editing' : ''}`}
                ref={gridRef}
                tabIndex={0}
                onKeyDown={handleKeyDown}
                onMouseDown={(e) => {
                  if (editing && !e.target.closest('.cell-editor')) gridRef.current?.focus()
                }}
              >
                {renderGrid()}
              </div>
              {!editing && <AnnotOverlay t={tools} />}
            </div>
          )}
        </div>
        <AnnPanel
          items={tools.list}
          selectedIds={tools.selectedIds}
          selectIds={tools.selectIds}
          focusAnn={tools.focusAnn}
          editingId={tools.editingId}
          onEdit={(id) => tools.setEditingId(id)}
          onCommit={tools.commitComment}
          onDelete={tools.deleteAnn}
          onDeleteMany={tools.deleteAnns}
        />
      </CommentConnector>
    </div>
  )
}

/** PPT 等浏览器无法内嵌预览的类型：占位白板 + 批注 + 浏览器直开 */
function TextView({ entry, notify }) {
  const [text, setText] = useState('')
  const [ready, setReady] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState('')
  const [saving, setSaving] = useState(false)
  const textRef = useRef('')
  const saveTimer = useRef(null)
  const textareaRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const t = await readText(entry.file)
        if (cancelled) return
        textRef.current = t
        setText(t)
        setReady(true)
        setDirty(false)
      } catch (err) {
        if (!cancelled) notify(`文本读取失败：${err.message}`, 'error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [entry, notify])

  const saveNow = useCallback(async () => {
    setSaving(true)
    try {
      await saveTextFile(entry, textRef.current)
      setDirty(false)
      setSavedAt(
        new Date().toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      )
      notify('已保存', 'success')
    } catch (err) {
      notify(`保存失败：${err.message}`, 'error')
    } finally {
      setSaving(false)
    }
  }, [entry, notify])

  const scheduleSave = useCallback(() => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(saveNow, 800)
  }, [saveNow])

  const handleChange = useCallback(
    (e) => {
      textRef.current = e.target.value
      setText(e.target.value)
      setDirty(true)
      scheduleSave()
    },
    [scheduleSave],
  )

  // 页数按换页符数：纯文本没有真正的分页，^L 是通用的分页约定
  const pageCount = useMemo(
    () => text.split(TEXT_PAGE_BREAK).length,
    [text],
  )

  /**
   * 新建一页：在光标处（没聚焦时在文末）插入换页符 ^L（form feed）。
   * 换页符独占一行，方便记事本/打印链路把它当分页处理。
   */
  const addPage = useCallback(() => {
    const el = textareaRef.current
    const value = textRef.current
    const focused = el && document.activeElement === el
    const at = focused && typeof el.selectionStart === 'number' ? el.selectionStart : value.length
    const before = value.slice(0, at)
    const needsLeadingBreak = before.length > 0 && !before.endsWith('\n')
    const insert = `${needsLeadingBreak ? '\n' : ''}${TEXT_PAGE_BREAK}\n`
    const next = before + insert + value.slice(at)
    textRef.current = next
    setText(next)
    setDirty(true)
    scheduleSave()
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      const caret = at + insert.length
      node.focus()
      node.setSelectionRange(caret, caret)
    })
    notify(`已新增一页（换页符 ^L）：共 ${next.split(TEXT_PAGE_BREAK).length} 页`, 'success')
  }, [notify, scheduleSave])

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        clearTimeout(saveTimer.current)
        saveNow()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saveNow])

  return (
    <div className="text-view">
      <div className="doc-toolbar">
        <span className="toolbar-title">纯文本编辑</span>
        <span className={`dirty-dot ${dirty ? 'on' : ''}`} />
        <span className="toolbar-hint">
          {saving ? '保存中…' : dirty ? '未保存' : savedAt ? `已保存${savedAt}` : '自动保存'}
        </span>
        <span className="toolbar-hint" title="按换页符（^L）计数">
          共 {pageCount} 页
        </span>
        <NewPageButton
          onClick={addPage}
          title="在光标处插入换页符 ^L（新一页），纯文本自动保存"
          disabled={!ready}
        />
        <button
          className="tool-btn"
          onClick={() => {
            clearTimeout(saveTimer.current)
            saveNow()
          }}
          disabled={saving}
        >
          <Save size={15} />
          保存
        </button>
      </div>
      {!ready ? (
        <div className="loading">正在加载文本…</div>
      ) : (
        <textarea
          ref={textareaRef}
          className="text-editor"
          value={text}
          onChange={handleChange}
          spellCheck={false}
          placeholder="在此输入文本…"
        />
      )}
    </div>
  )
}

/**
 * 白板分页：PPT / CAJ / 未知格式这类浏览器解析不了的文件，视图本身就是一块可批注白板。
 * 「新建一页」= 在白板下面再接一块空白页；批注层覆盖整块白板（坐标相对整篇归一化），
 * 新页天然可批注。加页后把既有批注按「旧高/新高」重标定一次，墨迹留在原来那一页。
 */
function useWhiteboardPages(tools) {
  // 存档里的页数（旁车 whiteboardPages[annKey]）—— 批注坐标是相对整块白板归一化的，
  // 页数决定白板高度，所以重开文件必须先把页数恢复出来，墨迹才落在原来那一页。
  const storedPages = () => {
    const n = Number(tools.annRef.current?.whiteboardPages?.[tools.annKey])
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1
  }
  // null = 还没动过，跟随存档；用户加过页后以本地值为准（写盘是同步发生的）
  const [localPages, setLocalPages] = useState(null)
  const pages = localPages ?? storedPages()
  const surfaceRef = useRef(null)
  const markSurfaceHeight = useSurfaceRescale(surfaceRef, makeSurfaceRescaleSettler(tools))
  const addPage = useCallback(() => {
    markSurfaceHeight()
    const next = storedPages() + 1
    setLocalPages(next)
    tools.setDocMeta({
      whiteboardPages: { ...(tools.annRef.current?.whiteboardPages || {}), [tools.annKey]: next },
    })
  }, [markSurfaceHeight, tools])
  return { pages, addPage, surfaceRef }
}

/** 白板分页渲染：第 1 页是文件本身的占位说明，其后每页都是空白可批注页 */
function WhiteboardPages({ pages, children }) {
  return (
    <>
      <div className="office-page">{children}</div>
      {Array.from({ length: Math.max(0, pages - 1) }, (_, i) => (
        <div className="office-page office-page-blank" key={`blank-${i}`}>
          <span className="office-page-label">第 {i + 2} 页 · 空白页</span>
        </div>
      ))}
    </>
  )
}

function OfficeView({ entry, notify }) {
  const meta = TYPE_META[entry.type] || TYPE_META.unknown
  const Icon = meta.icon
  const tools = useAnnotTools({ annKey: entry.type, entry, notify })
  const { pages, addPage, surfaceRef } = useWhiteboardPages(tools)
  const openNative = () => {
    try {
      const url = URL.createObjectURL(entry.file)
      window.open(url, '_blank')
    } catch (err) {
      window.alert(`无法打开文件：${err.message}`)
    }
  }
  return (
    <div className="doc-view">
      <AnnotToolbar
        t={tools}
        extra={
          <div className="tool-group">
            <NewPageButton
              onClick={addPage}
              title="在白板后面新增一页空白页（可继续手写批注）"
            />
            <button className="tool-btn" onClick={openNative}>
              <ExternalLink size={15} />
              浏览器直开
            </button>
          </div>
        }
      />
      <CommentConnector
        comments={tools.list.filter((a) => a.type === 'comment')}
        selectedId={tools.selectedId}
      >
        <div className="docx-scroll">
          <div
            className={`docx-doc office-doc annot-surface ${pages > 1 ? 'paged' : ''}`}
            ref={surfaceRef}
          >
            <WhiteboardPages pages={pages}>
              <div className="office-placeholder">
                <Icon size={40} color={meta.color} strokeWidth={1.4} />
                <p className="office-name">{entry.name}</p>
                <p className="office-hint">
                  {meta.label} 无法在浏览器内嵌预览，可在下方白板区域批注；或用本地 Office / WPS 打开。              </p>
              </div>
            </WhiteboardPages>
            <AnnotOverlay t={tools} />
          </div>
        </div>
        <AnnPanel
          items={tools.list}
          selectedIds={tools.selectedIds}
          selectIds={tools.selectIds}
          focusAnn={tools.focusAnn}
          editingId={tools.editingId}
          onEdit={(id) => tools.setEditingId(id)}
          onCommit={tools.commitComment}
          onDelete={tools.deleteAnn}
          onDeleteMany={tools.deleteAnns}
        />
      </CommentConnector>
    </div>
  )
}

/** CAJ 占位 + 批注（专有格式无法解析） */
function CajView({ entry, notify }) {
  const tools = useAnnotTools({ annKey: 'caj', entry, notify })
  const { pages, addPage, surfaceRef } = useWhiteboardPages(tools)
  return (
    <div className="doc-view">
      <AnnotToolbar
        t={tools}
        extra={
          <div className="tool-group">
            <NewPageButton
              onClick={addPage}
              title="在白板后面新增一页空白页（可继续手写批注）"
            />
          </div>
        }
      />
      <CommentConnector
        comments={tools.list.filter((a) => a.type === 'comment')}
        selectedId={tools.selectedId}
      >
        <div className="docx-scroll">
          <div
            className={`docx-doc office-doc annot-surface ${pages > 1 ? 'paged' : ''}`}
            ref={surfaceRef}
          >
            <WhiteboardPages pages={pages}>
              <div className="office-placeholder">
                <FileWarning size={40} color="currentColor" strokeWidth={1.4} />
                <p className="office-name">{entry.name}</p>
                <p className="office-hint">
                  CAJ 为知网专有格式，浏览器无法解析。需转换为PDF 后才能在应用中预览；可在下方白板区域批注。              </p>
              </div>
            </WhiteboardPages>
            <AnnotOverlay t={tools} />
          </div>
        </div>
        <AnnPanel
          items={tools.list}
          selectedIds={tools.selectedIds}
          selectIds={tools.selectIds}
          focusAnn={tools.focusAnn}
          editingId={tools.editingId}
          onEdit={(id) => tools.setEditingId(id)}
          onCommit={tools.commitComment}
          onDelete={tools.deleteAnn}
          onDeleteMany={tools.deleteAnns}
        />
      </CommentConnector>
    </div>
  )
}

function StatusToast({ toast }) {
  if (!toast) return null
  return <div className={`toast ${toast.type}`}>{toast.message}</div>
}
