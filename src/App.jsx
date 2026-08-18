import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BookOpen,
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
  Plus,
  Presentation,
  Redo2,
  Save,
  ScanText,
  SlidersHorizontal,
  TextCursor,
  Trash2,
  Type,
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
  renderMarkdownHtml,
  renderPdfPage,
  saveAnnotations,
  saveEpubBook,
  saveEpubFromHtml,
  saveExcelChanges,
  saveFileBytes,
  saveTextFile,
} from './lib/FileProcessor.js'
import OcrModal from './components/OcrModal.jsx'
import SpeechModal from './components/SpeechModal.jsx'
import ModelSettingsModal from './components/ModelSettingsModal.jsx'
import SettingsModal from './components/SettingsModal.jsx'
import { fetchModelStatus, hasPromptedDownload } from './lib/modelManager.js'
import { captureEditableSelection, captureTextareaSelection, insertAtRange } from './lib/caretInsert.js'
import { extractPdfMarkdown } from './lib/pdf/pdfTextExtract.js'
import { docxToPdfBytes, pdfToDocxBytes } from './lib/pdf/pdfConvert.js'
const uid = () =>
  globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}`

const TYPE_META = {
  pdf: { label: 'PDF 文档', icon: FileText, color: '#e5484d' },
  docx: { label: 'Word 文档', icon: FileText, color: '#2563eb' },
  markdown: { label: 'Markdown', icon: FileCode2, color: '#0d9488' },
  text: { label: '纯文本', icon: TextCursor, color: '#6b7280' },
  ppt: { label: 'PPT 演示', icon: Presentation, color: '#ea580c' },
  excel: { label: 'Excel 表格', icon: FileSpreadsheet, color: '#16a34a' },
  epub: { label: 'EPUB 电子书', icon: BookOpen, color: '#7c3aed' },
  caj: { label: 'CAJ 文献', icon: FileWarning, color: '#dc2626' },
  unknown: { label: '文件', icon: FileIcon, color: '#6b7280' },
}

const PEN_PRESETS = [
  { type: 'brush', label: '画笔', icon: Pencil },
  { type: 'line', label: '直线', icon: Minus },
  { type: 'rect', label: '矩形', icon: Square },
  { type: 'ellipse', label: '圆形', icon: Circle },
]

const PEN_COLORS = ['#e5484d', '#1f1f1f', '#2383e2', '#2f9e44', '#f5c518']

const clamp01 = (v) => Math.min(1, Math.max(0, v))


const SLASH_ITEMS = [
  { type: 'h1', label: '标题 1' },
  { type: 'h2', label: '标题 2' },
  { type: 'h3', label: '标题 3' },
  { type: 'todo', label: '待办事项' },
  { type: 'quote', label: '引用' },
  { type: 'code', label: '代码块' },
]

const BLOCK_PLACEHOLDER = {
  p: '输入文字，输入 / 插入块',
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
  // 草稿对象用 start/end，正式批注用 x0/y0/x1/y1，统一取点
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
  // 拖动中的预览：直线/矩形/椭圆用虚线 + 端点手柄，松手后实线定型
  if (isDraft && a.type !== 'brush' && a.type !== 'highlighter') ctx.setLineDash([6, 4])
  if ((a.type === 'brush' || a.type === 'highlighter') && a.points && a.points.length >= 2) {
    ctx.globalAlpha = a.type === 'highlighter' ? 0.35 : 1
    ctx.beginPath()
    ctx.moveTo(a.points[0].x * w, a.points[0].y * h)
    for (let i = 1; i < a.points.length; i++) {
      ctx.lineTo(a.points[i].x * w, a.points[i].y * h)
    }
    ctx.stroke()
    ctx.globalAlpha = 1
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
    // 椭圆：内切于拖拽矩形；Shift 时外接正方形 → 正圆
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

function drawShapeSelection(ctx, a, w, h) {
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
  ctx.strokeStyle = '#2383e2'
  ctx.lineWidth = 2
  ctx.globalAlpha = 0.95
  const pad = 6
  ctx.strokeRect(x - pad, y - pad, rw + pad * 2, rh + pad * 2)
  ctx.setLineDash([])
  const hs = 8
  const corners = [
    [x - pad, y - pad],
    [x + rw + pad, y - pad],
    [x - pad, y + rh + pad],
    [x + rw + pad, y + rh + pad],
  ]
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = '#2383e2'
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
  if (a.type === 'line') {
    return (
      distToSegment(px, py, (a.x0 ?? 0) * w, (a.y0 ?? 0) * h, (a.x1 ?? 0) * w, (a.y1 ?? 0) * h) <= 10
    )
  }
  if (a.type === 'rect') {
    const x = Math.min(a.x0 ?? 0, a.x1 ?? 0) * w
    const y = Math.min(a.y0 ?? 0, a.y1 ?? 0) * h
    const rw = Math.abs((a.x1 ?? 0) - (a.x0 ?? 0)) * w
    const rh = Math.abs((a.y1 ?? 0) - (a.y0 ?? 0)) * h
    const nearX = px >= x - 8 && px <= x + rw + 8
    const nearY = py >= y - 8 && py <= y + rh + 8
    if (!nearX || !nearY) return false
    const inside = px >= x && px <= x + rw && py >= y && py <= y + rh
    if (inside) return false
    return (
      Math.abs(py - y) <= 10 ||
      Math.abs(py - (y + rh)) <= 10 ||
      Math.abs(px - x) <= 10 ||
      Math.abs(px - (x + rw)) <= 10
    )
  }
  if (a.type === 'ellipse') {
    const x = Math.min(a.x0 ?? 0, a.x1 ?? 0) * w
    const y = Math.min(a.y0 ?? 0, a.y1 ?? 0) * h
    const rw = Math.abs((a.x1 ?? 0) - (a.x0 ?? 0)) * w
    const rh = Math.abs((a.y1 ?? 0) - (a.y0 ?? 0)) * h
    const cx = x + rw / 2
    const cy = y + rh / 2
    const rx = Math.max(0.5, rw / 2)
    const ry = Math.max(0.5, rh / 2)
    const d = ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2
    return d >= 0.75 && d <= 1.25
  }
  if ((a.type === 'brush' || a.type === 'highlighter') && a.points && a.points.length >= 2) {
    for (let i = 1; i < a.points.length; i++) {
      if (
        distToSegment(
          px,
          py,
          a.points[i - 1].x * w,
          a.points[i - 1].y * h,
          a.points[i].x * w,
          a.points[i].y * h,
        ) <= 12 + extraTolerance
      )
        return true
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
    const x0 = p0.x * w
    const y0 = p0.y * h
    const x1 = p1.x * w
    const y1 = p1.y * h
    const distance = Math.hypot(x1 - x0, y1 - y0)
    const steps = Math.max(1, Math.ceil(distance / 4))
    for (let step = 0; step <= steps; step++) {
      if (i > 1 && step === 0) continue
      const t = step / steps
      const point = { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t }
      const d = Math.hypot(point.x * w - px, point.y * h - py)
      if (d <= radius + thickness) {
        erased = true
        flush()
      } else {
        current.push(point)
      }
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
  // 就地拆分：把段内文字用 <mark> 包住，不抽取/重插 DOM → 不会导致文本换行
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
  const [modelModalOpen, setModelModalOpen] = useState(false) // 首次打开：量化模型下载提示
  const toastTimer = useRef(null)
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const notify = useCallback((message, type = 'info') => {
    setToast({ message, type })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 3200)
  }, [])

  // 首次打开：若本地有未下载的量化模型（GGUF / MLX）且未提示过，弹出下载提示
  useEffect(() => {
    if (hasPromptedDownload()) return
    let cancelled = false
    fetchModelStatus()
      .then((status) => {
        if (cancelled) return
        const missing = (status.models || []).filter((m) => !m.downloaded)
        if (missing.length > 0) setModelModalOpen(true)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
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
      for (const entry of entries) {
        try {
          await putFileHandle(entry)
        } catch {
          // 句柄持久化失败时仍可在本次会话打开
        }
        setRecent(addRecent(entry))
        addTab(entry)
      }
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

  return (
    <div className="app">
      <aside className={`sidebar ${mobileMenuOpen ? 'mobile-open' : ''}`}>
        <div className="sidebar-brand">
          <button className="mobile-menu-button icon-btn" onClick={() => setMobileMenuOpen(false)} aria-label="关闭菜单"><X size={18} /></button>
          <PenLine size={17} color="#2383e2" />
          <span>笔记工作台</span>
          <em>Web MVP</em>
        </div>
        <button className="folder-btn" onClick={handlePickFiles} disabled={picking}>
          <FilePlus2 size={16} />
          <span>{picking ? '选择中…' : '打开文件'}</span>
        </button>
        <nav className="side-nav">
          <button
            className={`nav-item ${activeTab.kind === 'home' ? 'active' : ''}`}
            onClick={() => { selectTab('home'); setMobileMenuOpen(false) }}
          >
            <Home size={16} />
            <span>欢迎页</span>
          </button>
        </nav>
        <button
          className="nav-item"
          onClick={() => setModelSettingsOpen(true)}
          title="模型管理：下载/删除 Vosk、GGUF、MLX 语音模型"
        >
          <Settings size={16} />
          <span>模型设置</span>
        </button>
        <button
          className="nav-item"
          onClick={() => setSettingsOpen(true)}
          title="设置：语音/手写识别模型切换、转换缓存管理"
        >
          <SlidersHorizontal size={16} />
          <span>设置</span>
        </button>
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
      <main className="main">
        <TabBar tabs={tabs} activeId={activeTabId} onSelect={selectTab} onClose={closeTab} onMenu={() => setMobileMenuOpen(true)} />
        <div className="content">
          {activeTab.kind === 'home' ? (
            <HomeView recent={recent} onOpenRecent={openRecent} onPickFiles={handlePickFiles} />
          ) : (
            <FileView key={activeTab.id} entry={activeTab.entry} notify={notify} />
          )}
        </div>
      </main>
      <ModelSettingsModal
        open={modelModalOpen || modelSettingsOpen}
        initialPrompt={modelModalOpen}
        onClose={() => {
          setModelModalOpen(false)
          setModelSettingsOpen(false)
        }}
      />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} notify={notify} />
      <StatusToast toast={toast} />
    </div>
  )
}

function TabBar({ tabs, activeId, onSelect, onClose, onMenu }) {
  return (
    <div className="tabbar">
      <button className="mobile-menu-button icon-btn" onClick={onMenu} aria-label="打开菜单"><SlidersHorizontal size={18} /></button>
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
  const [ocrOpen, setOcrOpen] = useState(false)
  const [speechOpen, setSpeechOpen] = useState(false)
  return (
    <div className="home">
      <header className="home-header home-header-row">
        <div>
          <h1>欢迎页</h1>
          <p>最近打开的 5 个文件，点击即可打开</p>
        </div>
        <div className="home-header-actions">
          <button
            className="tool-btn ocr-btn"
            title="语音识别（Vosk 本地 / Qwen3-ASR 本地服务），识别文字可复制或插入文档"
            onClick={() => setSpeechOpen(true)}
          >
            <Mic size={15} />
            语音识别
          </button>
          <button
            className="tool-btn ocr-btn"
            title="打开手写画板 / 图片文字识别（本地 PaddleOCR 推理）"
            onClick={() => setOcrOpen(true)}
          >
            <ScanText size={15} />
            文字识别
          </button>
        </div>
      </header>
      {recent.length === 0 ? (
        <div className="home-empty">
          <FilePlus2 size={42} color="#9b9a97" />
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
        最近文件可跨会话重新打开；批注 JSON 会在首次保存时选择保存位置。
      </div>
      <OcrModal open={ocrOpen} onClose={() => setOcrOpen(false)} />
      <SpeechModal open={speechOpen} onClose={() => setSpeechOpen(false)} />
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

function ToolButton({ active, title, icon: Icon, color, onClick, onDoubleClick, btnRef, disabled }) {
  return (
    <button
      ref={btnRef}
      className={`icon-btn ${active ? 'active' : ''}`}
      title={title}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      disabled={disabled}
    >
      <Icon size={16} style={color ? { color } : undefined} />
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
  const style = {
    left: `${ann.x * 100}%`,
    top: `${ann.y * 100}%`,
    width: `${ann.w * 100}%`,
    height: `${ann.h * 100}%`,
    color: ann.color || '#1f1f1f',
    fontSize: ann.fontSize || 16,
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
      const w = Math.max(0.05, clamp01(d.origW + dx))
      const h = Math.max(0.03, clamp01(d.origH + dy))
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

function CommentPanel({ comments, selectedId, editingId, onSelect, onEdit, onCommit, onDelete }) {
  return (
    <aside className="ann-panel">
      <div className="ann-panel-title">
        批注
        <span>{comments.length}</span>
      </div>
      {comments.length === 0 ? (
        <div className="ann-panel-empty">暂无批注</div>
      ) : (
        comments.map((c) => (
          <div
            key={c.id}
            data-panel-id={c.id}
            className={`ann-panel-item ${selectedId === c.id ? 'active' : ''}`}
            onClick={() => onSelect(c.id)}
            onDoubleClick={() => onEdit(c.id)}
          >
            <div className="ann-panel-head">
              <MessageSquareText size={13} />
              <span>{c.page ? `第 ${c.page} 页` : '批注'}</span>
              <button
                className="panel-del"
                title="删除批注"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(c.id)
                }}
              >
                <X size={12} />
              </button>
            </div>
            {editingId === c.id ? (
              <textarea
                className="ann-panel-input"
                autoFocus
                defaultValue={c.text}
                placeholder="输入批注…"
                onBlur={(e) => onCommit(c.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') e.currentTarget.blur()
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <div className="ann-panel-text">{c.text || '空批注'}</div>
            )}
          </div>
        ))
      )}
    </aside>
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
              {progress > 0 ? `正在提取 PDF 文字与图片… ${progress}%` : '正在提取 PDF 文字与图片…'}
            </div>
          ) : failed ? (
            <div className="file-error">PDF 文字提取失败，请重试或检查文件</div>
          ) : !markdown.trim() ? (
            <div className="docx-doc pdf-text-doc annot-surface">
              <div className="pdf-text-empty">
                未提取到文字（可能为扫描件/纯图片 PDF），可在下方空白区域使用批注工具。
              </div>
              <AnnotOverlay t={tools} />
            </div>
          ) : (
            <div className="docx-doc pdf-text-doc annot-surface">
              <div className="md-body pdf-text-body" dangerouslySetInnerHTML={{ __html: html }} />
              <AnnotOverlay t={tools} />
            </div>
          )}
        </div>
        <CommentPanel
          comments={tools.list.filter((a) => a.type === 'comment')}
          selectedId={tools.selectedId}
          editingId={tools.editingId}
          onSelect={tools.selectComment}
          onEdit={(id) => tools.setEditingId(id)}
          onCommit={tools.commitComment}
          onDelete={tools.deleteAnn}
        />
      </CommentConnector>
    </div>
  )
}

/** 平滑进度：display 缓慢逼近 target（服务器进度是粗粒度跳变时显得更顺滑） */
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

/** 转换进度条：percent 为 null 时显示不确定进度（条纹滑动动画） */
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
      // 2) 书内章节链接（如 TOC 的 xxx.html#锚）：找到对应章节的分隔标记（epub 合并后全书同文档）
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
 * PDF → DOCX 编辑视图：pdf2docx-plus 服务把 PDF 转成 DOCX，
 * 直接复用 docx 的编辑逻辑（mammoth 渲染 + 内容编辑 + 批注）；
 * 保存时用 docx2pdf 把编辑后的 DOCX 转回 PDF 写回原文件。
 */
function PdfDocxEditor({ entry, docxFile, notify }) {
  const [html, setHtml] = useState('')
  const [ready, setReady] = useState(false)
  const [editing, setEditing] = useState(false) // 内容编辑模式
  const [contentSaving, setContentSaving] = useState(false)
  const [saveProgress, setSaveProgress] = useState(null)
  const docRef = useRef(null)
  const tools = useAnnotTools({ annKey: 'pdf', entry, notify })
  const smoothSavePct = useSmoothProgress(saveProgress?.percent)
  // OCR 插入：进入编辑模式并记录光标位置
  const ocrRangeRef = useRef(null)
  const enterOcrEdit = useCallback(() => {
    const doc = docRef.current
    if (doc) ocrRangeRef.current = captureEditableSelection(doc)
    setEditing(true)
    requestAnimationFrame(() => {
      const el = docRef.current
      if (!el) return
      el.focus()
      const range = ocrRangeRef.current?.range
      if (range) {
        const sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
      }
    })
  }, [])
  const insertOcrText = useCallback(
    (text) => {
      const doc = docRef.current
      if (!doc) return false
      const sel = window.getSelection()
      let range = ocrRangeRef.current?.range
      if (!range) {
        range = document.createRange()
        range.selectNodeContents(doc)
        range.collapse(false)
      }
      sel.removeAllRanges()
      sel.addRange(range)
      const ok = insertAtRange(range, text)
      ocrRangeRef.current = null
      doc.focus()
      return ok
    },
    [],
  )
  const handleDocClick = useDocLinkGuard(docRef, notify)

  // 打开：mammoth 渲染转换得到的 docx
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const htmlText = await renderDocxHtml(docxFile)
        if (cancelled) return
        setHtml(htmlText)
        setReady(true)
      } catch (err) {
        if (!cancelled) notify(`PDF 转 DOCX 渲染失败：${err.message}`, 'error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [docxFile, notify])

  const highlights = useMemo(
    () => tools.list.filter((a) => a.type === 'highlight'),
    [tools.list],
  )
  const [selInHighlight, setSelInHighlight] = useState(false)

  useEffect(() => {
    if (!ready || !docRef.current) return
    docRef.current.innerHTML = html
    applyDocxHighlights(docRef.current, highlights)
  }, [ready, html, highlights])

  // 单独切换编辑态：不重建 DOM，避免 OCR 插入时已保存的光标位置失效
  useEffect(() => {
    if (!ready || !docRef.current) return
    docRef.current.contentEditable = editing ? 'true' : 'false'
  }, [ready, editing])

  // 选中高亮文字 → “高亮选中文字”按钮呈选中态；未选中高亮 → 取消选中态
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

  // 高亮切换：选中高亮文字时点击 → 删除选中部分高亮；否则 → 添加高亮
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

  // 内容编辑 → 保存回 PDF：HTML → docx（buildDocxFromHtml）→ docx2pdf → 写回原 PDF
  const saveContent = async () => {
    if (!docRef.current) return
    setContentSaving(true)
    setSaveProgress(null)
    try {
      const bytes = await buildDocxFromHtml(docRef.current.innerHTML)
      const pdfBytes = await docxToPdfBytes(bytes, {
        onProgress: (p) => setSaveProgress(p),
      })
      await saveFileBytes(entry, pdfBytes)
      // 批注存缓存（IndexedDB），不再写回文件 → 不弹权限窗
      await saveAnnotations(entry, tools.annRef.current)
      setEditing(false)
      notify('已保存回 PDF（docx2pdf 转换完成）', 'success')
    } catch (err) {
      notify(`保存失败：${err.message}`, 'error')
    } finally {
      setContentSaving(false)
      setSaveProgress(null)
    }
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
        {editing && (
          <button className="tool-btn primary" onClick={saveContent} disabled={contentSaving}>
            <Save size={15} />
            {contentSaving ? '转换保存中…' : '保存并转回 PDF'}
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
      <AnnotToolbar t={tools} extra={extraToolbar} onOcrOpen={enterOcrEdit} onOcrInsert={insertOcrText} />
      {contentSaving && (
        <div className="convert-progress-row">
          <ConversionProgress
            compact
            percent={saveProgress ? smoothSavePct : null}
            stage={saveProgress?.stage || '正在保存…'}
          />
        </div>
      )}
      <CommentConnector
        comments={tools.list.filter((a) => a.type === 'comment')}
        selectedId={tools.selectedId}
      >
        <div className="docx-scroll">
          {!ready ? (
            <div className="loading">正在渲染 PDF 转 DOCX 内容…</div>
          ) : (
            <div className={`docx-doc annot-surface ${editing ? 'content-editing' : ''}`}>
              <div className="docx-body" ref={docRef} onClick={handleDocClick} />
              {!editing && <AnnotOverlay t={tools} />}
            </div>
          )}
        </div>
        <CommentPanel
          comments={tools.list.filter((a) => a.type === 'comment')}
          selectedId={tools.selectedId}
          editingId={tools.editingId}
          onSelect={tools.selectComment}
          onEdit={(id) => tools.setEditingId(id)}
          onCommit={tools.commitComment}
          onDelete={tools.deleteAnn}
        />
      </CommentConnector>
    </div>
  )
}

/** PDF 视图：优先 pdf2docx-plus 转 DOCX 用 docx 逻辑编辑；转换服务不可用时回退文字视图（备份逻辑） */
function PdfView({ entry, notify }) {
  const [mode, setMode] = useState('loading') // loading | docx | text
  const [docxBytes, setDocxBytes] = useState(null)
  const [convProgress, setConvProgress] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // 取最新字节（内容保存后 entry.file 快照会过期，句柄可拿到最新）
        const src =
          entry.handle && typeof entry.handle.getFile === 'function'
            ? await entry.handle.getFile()
            : entry.file
        const bytes = new Uint8Array(await src.arrayBuffer())
        if (cancelled) return
        const out = await pdfToDocxBytes(bytes, {
          onProgress: (p) => {
            if (!cancelled) setConvProgress(p)
          },
        })
        if (cancelled) return
        setDocxBytes(out)
        setMode('docx')
      } catch (err) {
        if (cancelled) return
        setMode('text')
        notify(`PDF 转换服务不可用（${err.message}），已回退为文字视图`, 'info')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [entry, notify])

  if (mode === 'docx' && docxBytes) {
    const base = (entry.name || 'document.pdf').replace(/\.pdf$/i, '')
    const docxFile = new File([docxBytes], `${base}-converted.docx`, {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    return <PdfDocxEditor entry={entry} docxFile={docxFile} notify={notify} />
  }
  if (mode === 'text') return <PdfTextView entry={entry} notify={notify} />
  return (
    <div className="doc-view">
      <div className="docx-scroll">
        <div className="loading convert-loading">
          <div className="convert-loading-title">正在转换 PDF → DOCX…</div>
          <ConversionProgress percent={convProgress?.percent ?? null} stage={convProgress?.stage} />
        </div>
      </div>
    </div>
  )
}


function snapPoint(point, start) {
  const dx = point.x - start.x
  const dy = point.y - start.y
  if (Math.abs(dx) >= Math.abs(dy)) return { x: point.x, y: start.y }
  return { x: start.x, y: point.y }
}

// 把拖拽约束为正形（矩形→正方形、椭圆→正圆）。
// 批注坐标是归一化 0~1，要在像素上成正形必须按页面宽高比换算：
// 水平像素距离 = |dx| × aspect（aspect = 页面宽/高）。
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

/** 通用批注工具 hook：画笔/直线/矩形/圆形/荧光笔/文本框/批注，持久化到旁车 JSON 的 annKey 键 */
function useAnnotTools({ annKey, entry, notify }) {
  const [annotations, setAnnotations] = useState(ANN_EMPTY)
  const [tool, setTool] = useState('select')
  const [pen, setPen] = useState({ type: 'brush', color: '#e5484d', size: 3 })
  const [penOpen, setPenOpen] = useState(false)
  const [highlighter, setHighlighter] = useState({ color: '#f5c518', size: 5 })
  const [highlighterOpen, setHighlighterOpen] = useState(false)
  const [eraser, setEraser] = useState({ type: 'pixel', size: 16 })
  const [eraserOpen, setEraserOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [needsSaveFile, setNeedsSaveFile] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [textDraft, setTextDraft] = useState(null)
  const [draftFits, setDraftFits] = useState(false)
  const [shapeDraft, setShapeDraft] = useState(null)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const overlayRef = useRef(null)
  const annRef = useRef(ANN_EMPTY)
  const undoStackRef = useRef([]) // 撤销栈：保存历史列表快照
  const redoStackRef = useRef([]) // 重做栈：保存被撤销的列表快照
  const drawingRef = useRef(null)
  const eraserSessionRef = useRef(null)
  const eraserFrameRef = useRef(null)
  const eraserPendingPointRef = useRef(null)
  const eraserCursorRef = useRef(null)
  const drawFrameRef = useRef(null)
  const textDragRef = useRef(null)
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

  // 绘制：覆盖层 canvas 重绘全部批注 + 草稿 + 选中框
  const paint = useCallback(() => {
    const el = overlayRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const dpr = window.devicePixelRatio || 1
    if (el.width !== Math.floor(rect.width * dpr)) el.width = Math.floor(rect.width * dpr)
    if (el.height !== Math.floor(rect.height * dpr)) el.height = Math.floor(rect.height * dpr)
    const ctx = el.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, rect.width, rect.height)
    for (const a of annRef.current[annKey] || []) {
      drawAnnotation(ctx, a, rect.width, rect.height)
      if (selectedId && a.id === selectedId) {
        drawShapeSelection(ctx, a, rect.width, rect.height)
      }
    }
    if (drawingRef.current?.type === 'eraser' && drawingRef.current.point) {
      const p = drawingRef.current.point
      ctx.save()
      ctx.beginPath()
      ctx.arc(p.x * rect.width, p.y * rect.height, Math.max(2, drawingRef.current.size || 16), 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.22)'
      ctx.fill()
      ctx.strokeStyle = '#2383e2'
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 3])
      ctx.stroke()
      ctx.restore()
    } else if (drawingRef.current) {
      drawAnnotation(ctx, drawingRef.current, rect.width, rect.height, true)
    }
  }, [annKey, selectedId])

  useEffect(() => {
    paint()
  }, [list, tool, selectedId, paint])

  const getPoint = useCallback((e) => {
    const el = overlayRef.current
    if (!el) return { x: 0, y: 0 }
    if (e.currentTarget === el && Number.isFinite(e.offsetX) && Number.isFinite(e.offsetY)) {
      const width = el.clientWidth || 1
      const height = el.clientHeight || 1
      return { x: e.offsetX / width, y: e.offsetY / height }
    }
    const rect = e.currentTarget?.getBoundingClientRect?.() || el.getBoundingClientRect()
    if (!rect.width || !rect.height) return { x: 0, y: 0 }
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height }
  }, [])

  const scheduleDrawFrame = useCallback(() => {
    if (drawFrameRef.current) return
    drawFrameRef.current = requestAnimationFrame(() => {
      drawFrameRef.current = null
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
      paint()
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
      // 记录撤销历史（最多保留 100 步），新操作清空重做栈
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

  // 直接应用列表（不记录历史），供 undo/redo 回放用
  const applyList = useCallback(
    (newList) => {
      annRef.current = { ...annRef.current, [annKey]: newList }
      setAnnotations(annRef.current)
      scheduleSave()
    },
    [annKey, scheduleSave],
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

  const deleteAnn = useCallback(
    (id) => {
      commit((annRef.current[annKey] || []).filter((a) => a.id !== id))
      setSelectedId(null)
      setEditingId(null)
    },
    [commit, annKey],
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

  // 画布绘制（画笔/荧光笔/选择批注）
  const handleOverlayDown = useCallback(
    (e) => {
      if (tool === 'eraser') {
        const point = getPoint(e)
        const el = overlayRef.current
        const rect = el?.getBoundingClientRect()
        if (!rect) return
        e.currentTarget.setPointerCapture(e.pointerId)
        eraserSessionRef.current = { before: annRef.current[annKey] || [], changed: false }
        drawingRef.current = { type: 'eraser', point, size: eraser.size }
        if (eraserCursorRef.current) {
          eraserCursorRef.current.style.left = `${point.x * 100}%`
          eraserCursorRef.current.style.top = `${point.y * 100}%`
          eraserCursorRef.current.style.width = `${eraser.size}px`
          eraserCursorRef.current.style.height = `${eraser.size}px`
          eraserCursorRef.current.style.opacity = '1'
        }
        const result = eraseAnnotationsAtPoint(annRef.current[annKey] || [], point, rect.width, rect.height, eraser.type, eraser.size)
        if (result.changed) {
          eraserSessionRef.current.changed = true
          annRef.current = { ...annRef.current, [annKey]: result.list }
          setAnnotations(annRef.current)
        }
        return
      }
      if (tool === 'selectAnnot') {
        const point = getPoint(e)
        const el = overlayRef.current
        const rect = el?.getBoundingClientRect()
        if (!rect) return
        const anns = annRef.current[annKey] || []
        let hit = null
        for (let i = anns.length - 1; i >= 0; i--) {
          if (hitTestAnnotation(anns[i], point.x * rect.width, point.y * rect.height, rect.width, rect.height)) {
            hit = anns[i]
            break
          }
        }
        setSelectedId(hit ? hit.id : null)
        if (hit) {
          e.stopPropagation()
          if (e.cancelable) e.preventDefault()
        }
        return
      }
      if (tool !== 'pen' && tool !== 'highlighter') return
      setSelectedId(null)
      const meta =
        tool === 'highlighter'
          ? { type: 'highlighter', color: highlighter.color, thickness: highlighter.size }
          : { type: pen.type, color: pen.color, thickness: pen.size }
      const point = getPoint(e)
      const canvasRect = e.currentTarget.getBoundingClientRect()
      e.currentTarget.setPointerCapture(e.pointerId)
      drawingRef.current = {
        ...meta,
        start: point,
        end: point,
        points: [point],
        canvasWidth: canvasRect.width,
        canvasHeight: canvasRect.height,
        aspect: canvasRect.width && canvasRect.height ? canvasRect.width / canvasRect.height : 1,
      }
      if (tool === 'pen') {
        const label = (PEN_PRESETS.find((p) => p.type === meta.type) || {}).label || meta.type
        setShapeDraft({ x0: point.x, y0: point.y, x1: point.x, y1: point.y, label, sizeText: '' })
      }
      paint()
    },
    [tool, pen, highlighter, eraser, getPoint, annKey, paint],
  )

  const handleOverlayMove = useCallback(
    (e) => {
      const d = drawingRef.current
      const point = getPoint(e)
      if (!d) {
        if (tool === 'eraser' && eraserCursorRef.current) {
          eraserCursorRef.current.style.left = `${point.x * 100}%`
          eraserCursorRef.current.style.top = `${point.y * 100}%`
          eraserCursorRef.current.style.width = `${eraser.size}px`
          eraserCursorRef.current.style.height = `${eraser.size}px`
          eraserCursorRef.current.style.opacity = '1'
        }
        return
      }
      if (d.type === 'eraser') {
        d.point = point
        eraserPendingPointRef.current = point
        if (eraserCursorRef.current) {
          eraserCursorRef.current.style.left = `${point.x * 100}%`
          eraserCursorRef.current.style.top = `${point.y * 100}%`
          eraserCursorRef.current.style.width = `${eraser.size}px`
          eraserCursorRef.current.style.height = `${eraser.size}px`
          eraserCursorRef.current.style.opacity = '1'
        }
        if (!eraserFrameRef.current) {
          eraserFrameRef.current = requestAnimationFrame(() => {
            eraserFrameRef.current = null
            const next = eraserPendingPointRef.current
            eraserPendingPointRef.current = null
            const rect = overlayRef.current?.getBoundingClientRect()
            if (!next || !rect || !drawingRef.current || drawingRef.current.type !== 'eraser') return
            const result = eraseAnnotationsAtPoint(annRef.current[annKey] || [], next, rect.width, rect.height, eraser.type, eraser.size)
            if (result.changed) {
              eraserSessionRef.current.changed = true
              annRef.current = { ...annRef.current, [annKey]: result.list }
              setAnnotations(annRef.current)
            }
          })
        }
        return
      }
      if (d.type === 'brush' || d.type === 'highlighter') {
        const last = d.points[d.points.length - 1]
        if (Math.abs(point.x - last.x) > 0.002 || Math.abs(point.y - last.y) > 0.002) {
          d.points.push(point)
        }
      } else if (d.type === 'line') {
        d.end = e.shiftKey ? snapPoint(point, d.start) : point
      } else if (d.type === 'rect' || d.type === 'ellipse') {
        d.end = e.shiftKey ? constrainCircle(point, d.start, d.aspect || 1) : point
      }
      scheduleDrawFrame()
    },
    [getPoint, paint, scheduleDrawFrame, annKey, eraser, tool],
  )

  const handleOverlayLeave = useCallback(() => {
    if (!drawingRef.current && eraserCursorRef.current) {
      eraserCursorRef.current.style.opacity = '0'
    }
  }, [])

  const handleOverlayUp = useCallback(() => {
    const d = drawingRef.current
    if (!d) return
    if (d.type === 'eraser') {
      const pending = eraserPendingPointRef.current
      const rect = overlayRef.current?.getBoundingClientRect()
      if (pending && rect) {
        const result = eraseAnnotationsAtPoint(annRef.current[annKey] || [], pending, rect.width, rect.height, eraser.type, eraser.size)
        if (result.changed) {
          eraserSessionRef.current.changed = true
          annRef.current = { ...annRef.current, [annKey]: result.list }
          setAnnotations(annRef.current)
        }
      }
      const session = eraserSessionRef.current
      if (session?.changed) commit(annRef.current[annKey] || [], session.before)
      drawingRef.current = null
      eraserSessionRef.current = null
      eraserPendingPointRef.current = null
      if (eraserFrameRef.current) {
        cancelAnimationFrame(eraserFrameRef.current)
        eraserFrameRef.current = null
      }
      if (eraserCursorRef.current) eraserCursorRef.current.style.opacity = '0'
      paint()
      return
    }
    const base = { id: uid(), color: d.color, thickness: d.thickness }
    const ann =
      d.type === 'brush' || d.type === 'highlighter'
        ? { ...base, type: d.type, points: d.points }
        : { ...base, type: d.type, x0: d.start.x, y0: d.start.y, x1: d.end.x, y1: d.end.y }
    commit([...(annRef.current[annKey] || []), ann])
    drawingRef.current = null
    setShapeDraft(null)
  }, [commit, annKey, paint, eraser])

  // DOM 批注（文本框/批注标记）
  const handleDomDown = useCallback(
    (e) => {
      if (e.target.closest('.ann-comment, .ann-comment-pop, .ann-text, .ann-text-editor')) return
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

  const handleDomUp = useCallback(
    (e) => {
      if (cancelEditRef.current) {
        cancelEditRef.current = false
        setSelectedId(null)
        setEditingId(null)
        return
      }
      const d = textDragRef.current
      if (!d || d.mode !== 'create') return
      textDragRef.current = null
      setTextDraft(null)
      const p = getPoint(e)
      const w = Math.abs(p.x - d.start.x)
      const h = Math.abs(p.y - d.start.y)
      if (w < 0.05 || h < 0.03) {
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
        color: '#1f1f1f',
        fontSize: 16,
      }
      commit([...(annRef.current[annKey] || []), ann])
      setSelectedId(ann.id)
      setEditingId(ann.id)
    },
    [getPoint, commit, annKey],
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

  // Delete 键删除选中的批注
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault()
        deleteAnn(selectedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, deleteAnn])

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
    tool,
    setTool,
    pen,
    setPen,
    penOpen,
    setPenOpen,
    highlighter,
    setHighlighter,
    highlighterOpen,
    setHighlighterOpen,
    eraser,
    setEraser,
    eraserOpen,
    setEraserOpen,
    saving,
    needsSaveFile,
    editingId,
    setEditingId,
    selectedId,
    setSelectedId,
    textDraft,
    draftFits,
    shapeDraft,
    overlayRef,
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
    updateAnn,
    selectComment,
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
  // 画布只在「画笔/荧光笔/选择批注」时接收事件；默认「选择文字」模式不拦截，文字可选中
  const canvasActive = t.tool === 'pen' || t.tool === 'highlighter' || t.tool === 'eraser' || t.tool === 'selectAnnot'
  const domActive = t.tool === 'text' || t.tool === 'comment'
  return (
    <>
      <div ref={t.eraserCursorRef} className="eraser-cursor-preview" aria-hidden="true" />
      <canvas
        ref={t.overlayRef}
        className={`annot-canvas ${t.tool === 'select' ? 'select-mode' : ''} ${t.tool === 'eraser' ? 'eraser-mode' : ''}`}
        style={{ pointerEvents: canvasActive ? 'auto' : 'none' }}
        onPointerDown={canvasActive ? t.handleOverlayDown : undefined}
        onPointerMove={canvasActive ? t.handleOverlayMove : undefined}
        onPointerLeave={canvasActive ? t.handleOverlayLeave : undefined}
        onPointerUp={canvasActive ? t.handleOverlayUp : undefined}
      />
      <div
        className={`ann-dom ${domActive ? 'active' : ''}`}
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
        {t.list
          .filter((a) => a.type === 'text')
          .map((a) => (
            <TextBox
              key={a.id}
              ann={a}
              editing={t.editingId === a.id}
              selected={t.selectedId === a.id}
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
              selected={t.selectedId === a.id}
              onSelect={() => t.setSelectedId(a.id)}
              onEdit={() => t.setEditingId(a.id)}
            />
          ))}
      </div>
    </>
  )
}

/** 批注工具栏：工具按钮 + 画笔/荧光笔设置 + 撤销/清除/保存 + 显示大小 */
function AnnotToolbar({ t, extra, onOcrOpen, onOcrInsert }) {
  const penRef = useRef(null)
  const hlRef = useRef(null)
  const eraserRef = useRef(null)
  const tbRef = useRef(null)
  const [penLeft, setPenLeft] = useState(0)
  const [hlLeft, setHlLeft] = useState(0)
  const [eraserLeft, setEraserLeft] = useState(0)
  const [zoom, setZoom] = useState(100)
  const [ocrOpen, setOcrOpen] = useState(false)
  const [speechOpen, setSpeechOpen] = useState(false)

  // 显示大小：把 zoom 写到所在 .doc-view 的 CSS 变量，内容纸张（.docx-doc/.md-body/.epub-body）统一缩放
  useEffect(() => {
    const view = tbRef.current?.closest('.doc-view')
    if (!view) return
    view.style.setProperty('--doc-zoom', String(zoom / 100))
    return () => view.style.removeProperty('--doc-zoom')
  }, [zoom])

  // 弹窗锚定到对应图标正下方（offsetLeft 相对 .doc-toolbar 定位上下文），窄窗口防溢出
  const anchorLeft = (btn, fallback) => {
    if (!btn) return fallback
    const tb = btn.closest('.doc-toolbar')
    const w = tb ? tb.clientWidth : 600
    return Math.max(0, Math.min(btn.offsetLeft, w - 272))
  }
  const openPen = () => {
    setPenLeft(anchorLeft(penRef.current, 60))
    t.setPenOpen(true)
  }
  const openHighlighter = () => {
    setHlLeft(anchorLeft(hlRef.current, 60))
    t.setHighlighterOpen(true)
  }
  const openEraser = () => {
    setEraserLeft(anchorLeft(eraserRef.current, 60))
    t.setEraserOpen(true)
  }

  return (
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
          title="文本编辑（拖动放置文本框后输入文字）"
          icon={Type}
          onClick={() => t.setTool('text')}
        />
        <ToolButton
          active={t.tool === 'pen'}
          title="画笔（双击打开设置）"
          icon={Pencil}
          onClick={() => t.setTool('pen')}
          onDoubleClick={openPen}
          btnRef={penRef}
        />
        <ToolButton
          active={t.tool === 'highlighter'}
          title="荧光笔（双击打开设置）"
          icon={Highlighter}
          onClick={() => t.setTool('highlighter')}
          onDoubleClick={openHighlighter}
          btnRef={hlRef}
        />
        <ToolButton
          active={t.tool === 'eraser'}
          title="橡皮擦（双击设置擦除方式和大小）"
          icon={Eraser}
          onClick={() => t.setTool('eraser')}
          onDoubleClick={openEraser}
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
      <div className="tool-group">
        <ToolButton title="撤销上一步 (Ctrl+Z)" icon={Undo2} onClick={t.undo} disabled={!t.canUndo} />
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
      <div className="tool-group">
        <button
          className="tool-btn ocr-btn"
          title="语音识别（Vosk 本地 / Qwen3-ASR 本地服务），识别后自动进入编辑模式，可插入到光标位置"
          onClick={() => {
            onOcrOpen?.()
            setSpeechOpen(true)
          }}
        >
          <Mic size={15} />
          语音识别
        </button>
        <button
          className="tool-btn ocr-btn"
          title="打开手写画板 / 图片文字识别（本地 PaddleOCR 推理）"
          onClick={() => {
            onOcrOpen?.()
            setOcrOpen(true)
          }}
        >
          <ScanText size={15} />
          文字识别
        </button>
      </div>
      <div className="tool-group zoom-group">
        <button className="icon-btn" title="缩小显示" onClick={() => setZoom((z) => Math.max(60, z - 10))}>
          <ZoomOut size={16} />
        </button>
        <span className="zoom-value">{zoom}%</span>
        <button className="icon-btn" title="放大显示" onClick={() => setZoom((z) => Math.min(200, z + 10))}>
          <ZoomIn size={16} />
        </button>
      </div>
      {t.penOpen && (
        <>
          <div className="popover-backdrop" onClick={() => t.setPenOpen(false)} />
          <div className="pen-popover" style={{ left: penLeft }}>
            <div className="pop-title">画笔设置</div>
            <div className="pop-label">类型</div>
            <div className="seg-group">
              {PEN_PRESETS.map((p) => (
                <button
                  key={p.type}
                  className={`seg-btn shape-seg-btn ${t.pen.type === p.type ? 'active' : ''}`}
                  onClick={() => t.setPen((prev) => ({ ...prev, type: p.type }))}
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
                  className={`swatch ${t.pen.color === c ? 'active' : ''}`}
                  style={{ background: c }}
                  onClick={() => t.setPen((prev) => ({ ...prev, color: c }))}
                  title={c}
                />
              ))}
              <label className="custom-color" title="自定义颜色">
                <input
                  type="color"
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
              min={1}
              max={10}
              value={t.pen.size}
              onChange={(e) => t.setPen((prev) => ({ ...prev, size: Number(e.target.value) }))}
            />
          </div>
        </>
      )}
      {t.eraserOpen && (
        <>
          <div className="popover-backdrop" onClick={() => t.setEraserOpen(false)} />
          <div className="pen-popover eraser-popover" style={{ left: eraserLeft }}>
            <div className="pop-title">橡皮擦设置</div>
            <div className="pop-label">擦除方式</div>
            <div className="seg-group eraser-mode-group">
              <button
                className={`seg-btn ${t.eraser.type === 'pixel' ? 'active' : ''}`}
                onClick={() => t.setEraser((prev) => ({ ...prev, type: 'pixel' }))}
              >
                <span className="eraser-option-icon pixel-eraser-icon" />
                <span>像素橡皮</span>
              </button>
              <button
                className={`seg-btn ${t.eraser.type === 'stroke' ? 'active' : ''}`}
                onClick={() => t.setEraser((prev) => ({ ...prev, type: 'stroke' }))}
              >
                <span className="eraser-option-icon stroke-eraser-icon" />
                <span>笔画橡皮</span>
              </button>
            </div>
            <div className="pop-label">大小 <b>{t.eraser.size}px</b></div>
            <input
              type="range"
              className="size-range"
              min={4}
              max={60}
              value={t.eraser.size}
              onChange={(e) => t.setEraser((prev) => ({ ...prev, size: Number(e.target.value) }))}
            />
            <div className="eraser-size-preview">
              <span style={{ width: t.eraser.size, height: t.eraser.size }} />
              <small>拖动调整擦除范围</small>
            </div>
          </div>
        </>
      )}
      {t.highlighterOpen && (
        <>
          <div className="popover-backdrop" onClick={() => t.setHighlighterOpen(false)} />
          <div className="pen-popover" style={{ left: hlLeft }}>
            <div className="pop-title">荧光笔设置</div>
            <div className="pop-label">颜色</div>
            <div className="color-row">
              {PEN_COLORS.map((c) => (
                <button
                  key={c}
                  className={`swatch ${t.highlighter.color === c ? 'active' : ''}`}
                  style={{ background: c }}
                  onClick={() => t.setHighlighter((prev) => ({ ...prev, color: c }))}
                  title={c}
                />
              ))}
              <label className="custom-color" title="自定义颜色">
                <input
                  type="color"
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
              min={1}
              max={10}
              value={t.highlighter.size}
              onChange={(e) => t.setHighlighter((prev) => ({ ...prev, size: Number(e.target.value) }))}
            />
          </div>
        </>
      )}
      <OcrModal open={ocrOpen} onClose={() => setOcrOpen(false)} onInsert={onOcrInsert} />
      <SpeechModal open={speechOpen} onClose={() => setSpeechOpen(false)} onInsert={onOcrInsert} />
    </div>
  )
}

function DocxView({ entry, notify }) {
  const [html, setHtml] = useState('')
  const [ready, setReady] = useState(false)
  const [editing, setEditing] = useState(false) // 内容编辑模式
  const [contentSaving, setContentSaving] = useState(false)
  const docRef = useRef(null)
  const tools = useAnnotTools({ annKey: 'docx', entry, notify })
  // OCR 插入：进入编辑模式并记录光标位置
  const ocrRangeRef = useRef(null)
  const enterOcrEdit = useCallback(() => {
    const doc = docRef.current
    if (doc) ocrRangeRef.current = captureEditableSelection(doc)
    setEditing(true)
    requestAnimationFrame(() => {
      const el = docRef.current
      if (!el) return
      el.focus()
      const range = ocrRangeRef.current?.range
      if (range) {
        const sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
      }
    })
  }, [])
  const insertOcrText = useCallback(
    (text) => {
      const doc = docRef.current
      if (!doc) return false
      const sel = window.getSelection()
      let range = ocrRangeRef.current?.range
      if (!range) {
        range = document.createRange()
        range.selectNodeContents(doc)
        range.collapse(false)
      }
      sel.removeAllRanges()
      sel.addRange(range)
      const ok = insertAtRange(range, text)
      ocrRangeRef.current = null
      doc.focus()
      return ok
    },
    [],
  )
  const handleDocClick = useDocLinkGuard(docRef, notify)

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
    docRef.current.innerHTML = html
    applyDocxHighlights(docRef.current, highlights)
  }, [ready, html, highlights])

  // 单独切换编辑态：不重建 DOM，避免 OCR 插入时已保存的光标位置失效
  useEffect(() => {
    if (!ready || !docRef.current) return
    docRef.current.contentEditable = editing ? 'true' : 'false'
  }, [ready, editing])

  // 选中高亮文字 → “高亮选中文字”按钮呈选中态；未选中高亮 → 取消选中态
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

  // 高亮切换：选中高亮文字时点击 → 删除选中部分高亮；否则 → 添加高亮
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

  // 内容编辑 → 保存回 .docx
  const saveContent = async () => {
    if (!docRef.current) return
    setContentSaving(true)
    try {
      const bytes = await buildDocxFromHtml(docRef.current.innerHTML)
      await saveFileBytes(entry, bytes)
      // 批注存缓存（IndexedDB），不再写回文件 → 不弹权限窗
      await saveAnnotations(entry, tools.annRef.current)
      setEditing(false)
      notify('文档内容已保存回 .docx', 'success')
    } catch (err) {
      notify(`内容保存失败：${err.message}`, 'error')
    } finally {
      setContentSaving(false)
    }
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
        {editing && (
          <button className="tool-btn primary" onClick={saveContent} disabled={contentSaving}>
            <Save size={15} />
            {contentSaving ? '保存中…' : '保存内容到 .docx'}
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
      <AnnotToolbar t={tools} extra={extraToolbar} onOcrOpen={enterOcrEdit} onOcrInsert={insertOcrText} />
      <CommentConnector
        comments={tools.list.filter((a) => a.type === 'comment')}
        selectedId={tools.selectedId}
      >
        <div className="docx-scroll">
          <div className={`docx-doc annot-surface ${editing ? 'content-editing' : ''}`}>
            <div className="docx-body" ref={docRef} onClick={handleDocClick} />
            {!editing && <AnnotOverlay t={tools} />}
          </div>
        </div>
        <CommentPanel
          comments={tools.list.filter((a) => a.type === 'comment')}
          selectedId={tools.selectedId}
          editingId={tools.editingId}
          onSelect={tools.selectComment}
          onEdit={(id) => tools.setEditingId(id)}
          onCommit={tools.commitComment}
          onDelete={tools.deleteAnn}
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
  const tools = useAnnotTools({ annKey: 'md', entry, notify })
  // OCR 插入：记录光标所在块，识别文字插入到该块（代码块为 textarea 走 setRangeText）
  const ocrRangeRef = useRef(null)
  const mdBlocks = () => [...document.querySelectorAll('.md-editor .block')]
  const enterOcrEdit = useCallback(() => {
    const active = document.activeElement
    let el = active?.closest?.('.block') || null
    if (!el) el = mdBlocks().pop() || null
    const sel = window.getSelection()
    if (el && sel?.rangeCount && el.contains(sel.anchorNode)) {
      ocrRangeRef.current = sel.getRangeAt(0).cloneRange()
    } else if (el) {
      const r = document.createRange()
      r.selectNodeContents(el)
      r.collapse(false)
      ocrRangeRef.current = r
    }
    requestAnimationFrame(() => {
      try {
        el?.focus()
      } catch {
        /* ignore */
      }
    })
  }, [])
  const insertOcrText = useCallback((text) => {
    const active = document.activeElement
    if (active?.tagName === 'TEXTAREA' && active.classList.contains('block-code')) {
      const start = active.selectionStart ?? active.value.length
      const end = active.selectionEnd ?? start
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(active, active.value.slice(0, start) + text + active.value.slice(end))
      active.dispatchEvent(new Event('input', { bubbles: true }))
      const pos = start + text.length
      active.selectionStart = active.selectionEnd = pos
      active.focus()
      ocrRangeRef.current = null
      return true
    }
    const blocks = mdBlocks()
    let el = active?.closest?.('.block') || null
    if (!el && ocrRangeRef.current) {
      el = blocks.find((b) => b.contains(ocrRangeRef.current.startContainer)) || null
    }
    if (!el) el = blocks[blocks.length - 1] || null
    if (!el) return false
    const sel = window.getSelection()
    let range = ocrRangeRef.current
    if (!range) {
      range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
    }
    sel.removeAllRanges()
    sel.addRange(range)
    insertAtRange(range, text)
    ocrRangeRef.current = null
    try {
      el.focus()
    } catch {
      /* ignore */
    }
    return true
  }, [])
  blocksRef.current = blocks
  slashIdRef.current = slashId

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
    if (el) elRef.current[id] = el
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
          {saving ? '保存中…' : dirty ? '未保存' : savedAt ? `已保存 ${savedAt}` : '实时预览'}
        </span>
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
      <AnnotToolbar t={tools} onOcrOpen={enterOcrEdit} onOcrInsert={insertOcrText} />
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
                registerEl={registerEl}
                initText={initBlockText}
              />
            ))}
          </div>
          <div className="md-pane md-preview">
            <div className="md-preview-surface annot-surface">
              <div
                className="md-body"
                dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(markdown) }}
              />
              <AnnotOverlay t={tools} />
            </div>
          </div>
        </div>
        <CommentPanel
          comments={tools.list.filter((a) => a.type === 'comment')}
          selectedId={tools.selectedId}
          editingId={tools.editingId}
          onSelect={tools.selectComment}
          onEdit={(id) => tools.setEditingId(id)}
          onCommit={tools.commitComment}
          onDelete={tools.deleteAnn}
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
  registerEl,
  initText,
}) {
  const refCb = (el) => {
    registerEl(block.id, el)
    initText(block.id, el)
  }
  const common = {
    onInput: (e) => onInput(block.id, e.currentTarget.innerText),
    onKeyDown: (e) => onKeyDown(e, block.id),
    ref: refCb,
    'data-placeholder': BLOCK_PLACEHOLDER[block.type] || '输入文字',
  }
  let element
  if (block.type === 'code') {
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

/** EPUB 阅读 + 内容编辑 + 批注（zip 内 HTML 重打包保存回） */
function EpubView({ entry, notify }) {
  const [html, setHtml] = useState('')
  const [epubBook, setEpubBook] = useState(null) // { files, getImageBlob, imageSrcs }
  const [ready, setReady] = useState(false)
  const [editing, setEditing] = useState(false)
  const [contentSaving, setContentSaving] = useState(false)
  const docRef = useRef(null)
  const tools = useAnnotTools({ annKey: 'epub', entry, notify })
  // OCR 插入：进入编辑模式并记录光标位置
  const ocrRangeRef = useRef(null)
  const enterOcrEdit = useCallback(() => {
    const doc = docRef.current
    if (doc) ocrRangeRef.current = captureEditableSelection(doc)
    setEditing(true)
    requestAnimationFrame(() => {
      const el = docRef.current
      if (!el) return
      el.focus()
      const range = ocrRangeRef.current?.range
      if (range) {
        const sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
      }
    })
  }, [])
  const insertOcrText = useCallback(
    (text) => {
      const doc = docRef.current
      if (!doc) return false
      const sel = window.getSelection()
      let range = ocrRangeRef.current?.range
      if (!range) {
        range = document.createRange()
        range.selectNodeContents(doc)
        range.collapse(false)
      }
      sel.removeAllRanges()
      sel.addRange(range)
      const ok = insertAtRange(range, text)
      ocrRangeRef.current = null
      doc.focus()
      return ok
    },
    [],
  )
  // src → 显示用 Blob URL（保存时换回原路径）
  const imageMapRef = useRef(new Map())
  const handleDocClick = useDocLinkGuard(docRef, notify)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // 按 spine 顺序合并全书正文（旧版只读第一个文件，导致"只显示第一面"）
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

  // 渲染 + 惰性加载资源：先把正文 DOM 放进页面（很快），再分批把相对资源引用换成
  // Blob URL。覆盖 <img>、svg <image>(xlink:href/href/src)、srcset、内联 style url()、
  // <style> url() —— 参考 readest/foliate-js 的 Loader：相对路径必须相对所在章解析。
  // 大书（几百章/上千图）不会因一次性 base64 内联而卡死。
  useEffect(() => {
    if (!ready || !docRef.current || !epubBook) return
    const root = docRef.current
    root.innerHTML = html
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

    // 占位图：避免几千次相对路径 404 请求和裂图闪烁（保存时经 data-nf-* 还原）
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
    // 把 style/<style> 里的 data-nf-res:// 令牌换成 blob URL（令牌期间浏览器忽略该声明）
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

  // 单独切换编辑态：不重建 DOM，避免 OCR 插入时已保存的光标位置失效
  useEffect(() => {
    if (!ready || !docRef.current) return
    docRef.current.contentEditable = editing ? 'true' : 'false'
  }, [ready, editing])

  const saveContent = async () => {
    if (!docRef.current || !epubBook) return
    setContentSaving(true)
    try {
      const root = docRef.current
      // 统一还原为原始相对引用：占位图（未完成懒加载）和已换 blob 的都经 data-nf-*
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
      // 按章间标记拆回各章，逐文件写回（保留每章 head/命名空间）
      await saveEpubBook(entry, epubBook.files, root)
      // 保存后视图同步为已保存内容（含还原后的原始引用，重新渲染时再次惰性换 Blob）
      setHtml(root.innerHTML)
      // 重新内嵌批注（zip 重打包会覆盖此前内嵌的批注数据）
      if ((tools.annRef.current.epub || []).length) {
        await saveAnnotations(entry, tools.annRef.current)
      }
      setEditing(false)
      notify(`EPUB 内容已保存（${epubBook.files.length} 章）`, 'success')
    } catch (err) {
      notify(`EPUB 保存失败：${err.message}`, 'error')
    } finally {
      setContentSaving(false)
    }
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
      {editing && (
        <button className="tool-btn primary" onClick={saveContent} disabled={contentSaving}>
          <Save size={15} />
          {contentSaving ? '保存中…' : '保存到 EPUB'}
        </button>
      )}
    </div>
  )

  return (
    <div className="doc-view">
      <AnnotToolbar t={tools} extra={extraToolbar} onOcrOpen={enterOcrEdit} onOcrInsert={insertOcrText} />
      <CommentConnector
        comments={tools.list.filter((a) => a.type === 'comment')}
        selectedId={tools.selectedId}
      >
        <div className="docx-scroll">
          {!ready ? (
            <div className="loading">正在加载 EPUB 全书…</div>
          ) : (
            <div className={`docx-doc epub-doc annot-surface ${editing ? 'content-editing' : ''}`}>
              <div className="epub-body" ref={docRef} onClick={handleDocClick} />
              {!editing && <AnnotOverlay t={tools} />}
            </div>
          )}
        </div>
        <CommentPanel
          comments={tools.list.filter((a) => a.type === 'comment')}
          selectedId={tools.selectedId}
          editingId={tools.editingId}
          onSelect={tools.selectComment}
          onEdit={(id) => tools.setEditingId(id)}
          onCommit={tools.commitComment}
          onDelete={tools.deleteAnn}
        />
      </CommentConnector>
    </div>
  )
}

/** Excel 表格渲染（SheetJS）+ 内容编辑：单元格可直接编辑，保存时写回 xlsx 原文件 */
// ─── Excel 网格编辑器（openpyxl 服务端修改 + 前端网格 UI）────────────────

/** 表格单元格显示文本（只读展示） */
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

/** 把编辑输入解析为 (值, 类型)：空→清空；=开头→公式字符串；数字/布尔→对应类型；否则字符串 */
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

/** 新旧单元格值是否等效（空字符串与 null 视为一致） */
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
  // OCR 插入：进入编辑模式，识别文字写入当前选中单元格
  const enterOcrEdit = useCallback(() => {
    setEditing(true)
    requestAnimationFrame(() => gridRef.current?.focus())
  }, [])
  const insertOcrText = useCallback(
    (text) => {
      setEditing(true)
      const { r, c } = sel
      pushOp({ op: 'set', r, c, v: text, t: 's' })
      gridRef.current?.focus()
      return true
    },
    [sel, pushOp],
  )

  const active = sheets[sheetIdx] || null

  const mutateSheet = useCallback((idx, fn) => {
    setSheets((prev) => prev.map((s, i) => (i === idx ? fn(s) : s)))
  }, [])

  // 解析文件 → sheets 状态
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

  // 合并区域索引：anchor → {r1,c1,r2,c2}，covered → 被合并覆盖的格子
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
    if (n) notify(`已清空 ${n} 个单元格`, 'info')
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
    // 已取消（Escape）或已提交（Enter 后卸载触发 blur）时不再重复提交
    if (!editingCellRef.current) return
    commitEdit()
  }

  // ─── 工作表管理 ───
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
      values: [],
      merges: [],
      ops: [],
      baseValues: [],
      baseMerges: [],
    }
    setSheets((prev) => [...prev, s])
    setSheetIdx(sheets.length)
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
        {editing && (
          <button className="tool-btn primary" onClick={saveContent} disabled={saving}>
            <Save size={15} />
            {saving ? '保存中…' : '保存回 Excel'}
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
              title="清空选中单元格内容 (Del)"
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
          重命名
        </button>
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
        // 被合并覆盖的格子跳过（锚点格保留，负责 colspan/rowspan）
        if (mergeMap.covered.has(key) && !m) continue
        tds.push(renderCell(r, c, m))
      }
      rows.push(
        <tr key={r}>
          <th className="row-head" title={`选中第 ${r + 1} 行`} onClick={() => selectRow(r)}>
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
      <AnnotToolbar t={tools} extra={extraToolbar} onOcrOpen={enterOcrEdit} onOcrInsert={insertOcrText} />
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
        <CommentPanel
          comments={tools.list.filter((a) => a.type === 'comment')}
          selectedId={tools.selectedId}
          editingId={tools.editingId}
          onSelect={tools.selectComment}
          onEdit={(id) => tools.setEditingId(id)}
          onCommit={tools.commitComment}
          onDelete={tools.deleteAnn}
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
  const [ocrOpen, setOcrOpen] = useState(false)
  const [speechOpen, setSpeechOpen] = useState(false)
  const textareaRef = useRef(null)
  const ocrSelRef = useRef(null)

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

  // OCR 插入：记录光标位置，识别文字插入到光标处
  const enterOcrEdit = useCallback(() => {
    const ta = textareaRef.current
    ocrSelRef.current = captureTextareaSelection(ta, textRef.current.length)
    requestAnimationFrame(() => ta?.focus())
  }, [])
  const insertOcrText = useCallback(
    (text) => {
      const cur = textRef.current
      const sel = ocrSelRef.current || { start: cur.length, end: cur.length }
      const next = cur.slice(0, sel.start) + text + cur.slice(sel.end)
      textRef.current = next
      setText(next)
      setDirty(true)
      scheduleSave()
      ocrSelRef.current = null
      requestAnimationFrame(() => {
        const ta = textareaRef.current
        if (ta) {
          const pos = sel.start + text.length
          ta.selectionStart = ta.selectionEnd = pos
          ta.focus()
        }
      })
      return true
    },
    [scheduleSave],
  )

  const handleChange = useCallback(
    (e) => {
      textRef.current = e.target.value
      setText(e.target.value)
      setDirty(true)
      scheduleSave()
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

  return (
    <div className="text-view">
      <div className="doc-toolbar">
        <span className="toolbar-title">纯文本编辑</span>
        <span className={`dirty-dot ${dirty ? 'on' : ''}`} />
        <span className="toolbar-hint">
          {saving ? '保存中…' : dirty ? '未保存' : savedAt ? `已保存 ${savedAt}` : '自动保存'}
        </span>
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
        <button
          className="tool-btn ocr-btn"
          title="语音识别（Vosk 本地 / Qwen3-ASR 本地服务），识别后可插入到光标位置"
          onClick={() => {
            enterOcrEdit()
            setSpeechOpen(true)
          }}
        >
          <Mic size={15} />
          语音识别
        </button>
        <button
          className="tool-btn ocr-btn"
          title="打开手写画板 / 图片文字识别（本地 PaddleOCR 推理），识别后可插入到光标位置"
          onClick={() => {
            enterOcrEdit()
            setOcrOpen(true)
          }}
        >
          <ScanText size={15} />
          文字识别
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
      <OcrModal open={ocrOpen} onClose={() => setOcrOpen(false)} onInsert={insertOcrText} />
      <SpeechModal open={speechOpen} onClose={() => setSpeechOpen(false)} onInsert={insertOcrText} />
    </div>
  )
}

function OfficeView({ entry, notify }) {
  const meta = TYPE_META[entry.type] || TYPE_META.unknown
  const Icon = meta.icon
  const tools = useAnnotTools({ annKey: entry.type, entry, notify })
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
          <div className="docx-doc office-doc annot-surface">
            <div className="office-placeholder">
              <Icon size={40} color={meta.color} strokeWidth={1.4} />
              <p className="office-name">{entry.name}</p>
              <p className="office-hint">
                {meta.label} 无法在浏览器内嵌预览，可在下方白板区域批注；或用本地 Office / WPS 打开。
              </p>
            </div>
            <AnnotOverlay t={tools} />
          </div>
        </div>
        <CommentPanel
          comments={tools.list.filter((a) => a.type === 'comment')}
          selectedId={tools.selectedId}
          editingId={tools.editingId}
          onSelect={tools.selectComment}
          onEdit={(id) => tools.setEditingId(id)}
          onCommit={tools.commitComment}
          onDelete={tools.deleteAnn}
        />
      </CommentConnector>
    </div>
  )
}

/** CAJ 占位 + 批注（专有格式无法解析） */
function CajView({ entry, notify }) {
  const tools = useAnnotTools({ annKey: 'caj', entry, notify })
  return (
    <div className="doc-view">
      <AnnotToolbar t={tools} />
      <CommentConnector
        comments={tools.list.filter((a) => a.type === 'comment')}
        selectedId={tools.selectedId}
      >
        <div className="docx-scroll">
          <div className="docx-doc office-doc annot-surface">
            <div className="office-placeholder">
              <FileWarning size={40} color="#dc2626" strokeWidth={1.4} />
              <p className="office-name">{entry.name}</p>
              <p className="office-hint">
                CAJ 为知网专有格式，浏览器无法解析。需转换为 PDF 后才能在应用中预览；可在下方白板区域批注。
              </p>
            </div>
            <AnnotOverlay t={tools} />
          </div>
        </div>
        <CommentPanel
          comments={tools.list.filter((a) => a.type === 'comment')}
          selectedId={tools.selectedId}
          editingId={tools.editingId}
          onSelect={tools.selectComment}
          onEdit={(id) => tools.setEditingId(id)}
          onCommit={tools.commitComment}
          onDelete={tools.deleteAnn}
        />
      </CommentConnector>
    </div>
  )
}

function StatusToast({ toast }) {
  if (!toast) return null
  return <div className={`toast ${toast.type}`}>{toast.message}</div>
}
