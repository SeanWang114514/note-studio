// PdfEditorView.jsx — React 原生 PDF 编辑器（Acrobat 级文字编辑）
//
// 交互（对标 Adobe Acrobat「编辑 PDF」）：
// - 编辑模式（默认）：单击左键在文字任意位置定位光标 → 直接插入/删除字符；
// - 光标模式：滑动浏览页面，文字可原生拖拽选择（跨行多选）；
// - 每行编辑单元不是孤立的：相邻行聚合为一个连续段落（Word 风格），
//   段落内的文字连起来，回车在段落内换行，鼠标拖拽可跨行多选；
// - Enter 换行，Esc 取消，Ctrl+S 保存；
// - 保存时把新文字原生写回 PDF（纯 ASCII → 矢量文字；含中文 → PNG 嵌入）。
//
// 视图：连续滚动 + 即时缩放 + 缩略图侧栏 + 底部浮动控制条。
// 引擎复用 src/lib/pdf/：pdfEngine（加载/坐标）、pdfRenderer（分层渲染）、
// pdfViewer（视图编排）、pdfTextEdit（段落聚合/光标定位）、
// FileProcessor（文件/批注持久化唯一入口）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronLeft,
  ChevronRight,
  Italic,
  Maximize2,
  Minus,
  MousePointer2,
  PenLine,
  Plus,
  Rows3,
  Save,
  Underline,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  loadAnnotations,
  openPdf,
  saveAnnotations,
  savePdfBack,
} from '../lib/FileProcessor.js'
import { PdfViewer, FIT_PAGE, FIT_WIDTH, ZOOM_MAX, ZOOM_MIN } from '../lib/pdf/pdfViewer.js'
import { renderPageToCanvas } from '../lib/pdf/pdfRenderer.js'
import { getOriginalBytes } from '../lib/pdf/pdfEngine.js'
import {
  collectParagraphs,
  offsetAtPoint,
  cssFamilyFor,
  blockBoundsInLayer,
  cssBaselineOffset,
} from '../lib/pdf/pdfTextEdit.js'

// ─── 常量 ───────────────────────────────────────────────

const FONTS = [
  { label: 'Helvetica', css: 'Helvetica, Arial, sans-serif' },
  { label: 'Times', css: '"Times New Roman", Times, serif' },
  { label: 'Courier', css: '"Courier New", Courier, monospace' },
  { label: 'Arial', css: 'Arial, Helvetica, sans-serif' },
  { label: '宋体', css: '"SimSun", "宋体", serif' },
  { label: '黑体', css: '"SimHei", "黑体", sans-serif' },
  { label: '微软雅黑', css: '"Microsoft YaHei", "微软雅黑", sans-serif' },
  { label: '楷体', css: '"KaiTi", "楷体", serif' },
  { label: '仿宋', css: '"FangSong", "仿宋", serif' },
]

const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64, 72]

const uid = () =>
  globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : 'id-' + Math.random().toString(36).slice(2)

// ─── 工具函数 ───────────────────────────────────────────

/** 按行绘制编辑文字（支持多行 + 行距），与 pdfSaver 的 PNG 渲染保持一致 */
function paintTextLines(ctx, txt, size, x, y, width, align, underline, lineSpacing) {
  const lines = String(txt || '').split('\n')
  const lh = Math.max(4, lineSpacing || size * 1.35)
  lines.forEach((ln, i) => {
    const ly = y + i * lh
    const m = ctx.measureText(ln)
    let tx = x
    if (align === 'center') tx = x + (width - m.width) / 2
    else if (align === 'right') tx = x + width - m.width
    if (m.width > width) tx = x + (width - m.width) / 2
    if (ln) ctx.fillText(ln, tx, ly, m.width > width ? width : undefined)
    if (underline && ln) {
      ctx.beginPath()
      ctx.moveTo(tx, ly + size + 1.5)
      ctx.lineTo(tx + Math.min(m.width, width), ly + size + 1.5)
      ctx.stroke()
    }
  })
}

// ─── 组件 ───────────────────────────────────────────────

export default function PdfEditorView({ entry, notify }) {
  const [pdf, setPdf] = useState(null)
  const [numPages, setNumPages] = useState(0)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [scale, setScale] = useState(1)
  const [fitMode, setFitMode] = useState(FIT_WIDTH)
  const [activePage, setActivePage] = useState(1)
  const [viewMode, setViewMode] = useState('continuous')
  const [textEdits, setTextEdits] = useState([]) // type:'textEdit' 批注（持久化）
  const [editing, setEditing] = useState(null) // { pageNum, block, bounds, text, format, lineSpacing, caretOffset }
  const [saving, setSaving] = useState(false)
  const [mode, setMode] = useState('edit') // edit: 单击即编辑（Acrobat 风格）；cursor: 浏览/滑动

  const scrollRef = useRef(null)
  const pagesRef = useRef(new Map()) // pageNum -> {cc, canvas, editCanvas, textLayer, linkLayer}
  const viewerRef = useRef(null)
  const pageRefs = useRef(new Map()) // pageNum -> { base, viewport, scale }
  const editRef = useRef(null)
  const editBoxRef = useRef(null)
  const modeRef = useRef('edit')
  const textEditsRef = useRef([])

  textEditsRef.current = textEdits
  modeRef.current = mode

  const getPdf = useCallback(() => pdf, [pdf])
  const getPageCount = useCallback(() => numPages, [numPages])
  const getPages = useCallback(
    () => [...pagesRef.current.values()].sort((a, b) => a.pageNum - b.pageNum),
    [],
  )

  // ── 打开文档 ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setReady(false)
    setFailed(false)
    setTextEdits([])
    pagesRef.current.clear()
    pageRefs.current.clear()
    ;(async () => {
      try {
        const doc = await openPdf(entry.file, entry.id)
        if (cancelled) {
          doc.destroy?.()
          return
        }
        setPdf(doc)
        setNumPages(doc.numPages)
        setReady(true)
        // 载入已保存的 textEdit 批注
        try {
          const ann = await loadAnnotations(entry)
          if (cancelled) return
          const saved = (ann.pdf || []).filter((a) => a.type === 'textEdit')
          setTextEdits(saved)
        } catch {
          /* 批注载入失败不阻塞打开 */
        }
      } catch (err) {
        if (!cancelled) {
          setFailed(true)
          setReady(true)
          notify('PDF 打开失败：' + err.message, 'error')
        }
      }
    })()
    return () => {
      cancelled = true
      viewerRef.current?.destroy()
      viewerRef.current = null
      pdf?.destroy?.()
      setPdf(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id])

  // ── 页面 ref 注册（React 声明式构建每页 DOM）────────────
  const regPage = useCallback(
    (pageNum) => (el) => {
      if (!el) {
        pagesRef.current.delete(pageNum)
        return
      }
      pagesRef.current.set(pageNum, {
        pageNum,
        cc: el.querySelector('.pdf-canvas-container'),
        canvas: el.querySelector('.pdf-canvas'),
        editCanvas: el.querySelector('.pdf-edit-canvas'),
        textLayer: el.querySelector('.pdf-text-layer'),
        linkLayer: el.querySelector('.pdf-link-layer'),
      })
    },
    [],
  )

  // ── 打开段落编辑器（Acrobat 风格：单击定位光标）────────
  const openEditor = useCallback((span, pageNum, clientX, clientY) => {
    if (editRef.current) commitEditRef.current?.()
    const textLayer = span.closest('.pdf-text-layer')
    if (!textLayer) return
    const blocks = collectParagraphs(textLayer, pageNum)
    if (!blocks.length) return
    // 找到包含该 span 的段落
    const block = blocks.find((b) => b.spans.includes(span)) || blocks[0]
    const bounds = block.rect || blockBoundsInLayer(block.spans)
    if (!bounds) return

    const p = pageRefs.current.get(pageNum)
    const vp = p?.viewport
    const scaleAt = p?.scale || 1

    // 若该段已有保存的 textEdit（按 lineIdx 或坐标匹配），用新文字继续编辑
    const lineIdx = block.spans.map((s) => Number(s.dataset?.idx)).filter((v) => Number.isFinite(v))
    const existing = textEditsRef.current.find((t) => {
      if (Number(t.page) !== pageNum) return false
      if ((t.lineIdx || []).length && lineIdx.length) {
        return t.lineIdx.some((i) => lineIdx.includes(i))
      }
      if (vp) {
        return (
          Math.abs((t.x || 0) - bounds.left / vp.width) < 0.01 &&
          Math.abs((t.y || 0) - bounds.top / vp.height) < 0.01
        )
      }
      return false
    })

    const text = existing ? String(existing.text ?? '') : block.lineData.map((l) => l.text).join('\n')
    const pdfFontSize = existing ? existing.size : block.fontSize
    // 优先用 span 的实际渲染高度（含字体度量），保证编辑框文字与原文精确对齐
    const firstLine = block.lineData[0]
    const domSpanRect = firstLine?.spans?.[0]?.getBoundingClientRect?.()
    const spanRenderH = domSpanRect?.height || 0
    const cssSize = Math.max(
      8,
      spanRenderH > 0
        ? spanRenderH
        : Math.round(pdfFontSize * scaleAt),
    )
    const cssFamily = existing
      ? existing.font || cssFamilyFor(block.actualFontName, block.fontFamily)
      : cssFamilyFor(block.actualFontName, block.fontFamily)

    // 采样颜色兜底：若为白色/接近白色（采样落在背景），回退深色默认
    let sampledColor = existing?.color || block.color || '#1f1f1f'
    const isWhite = /^#(f[0-9a-f]{5}|[0-9a-f]{2,2}fffff)/i.test(sampledColor) || sampledColor === '#ffffff' || sampledColor === '#fff'
    if (isWhite) sampledColor = '#1f1f1f'

    const fmt = {
      font: cssFamily,
      size: cssSize,
      color: sampledColor,
      bold: existing ? !!existing.bold : block.isBold,
      italic: existing ? !!existing.italic : block.isItalic,
      underline: existing ? !!existing.underline : false,
      align: existing?.align || 'left',
    }

    // 行距（scale=1 值）→ 当前缩放 px
    const lineSpacing = existing?.lineSpacing
      ? existing.lineSpacing * scaleAt
      : block.lineSpacing * scaleAt

    // 编辑框覆盖段落 bbox；宽度至少 60px
    const boxW = Math.max(bounds.width, 60)
    const lineCount = text.split('\n').length
    // 高度 = 文字行高（精确对齐，不撑大留白）：每行 = span 渲染高度
    const renderH = spanRenderH > 0 ? spanRenderH : Math.max(12, lineSpacing)
    // 多行：首行 renderH，后续行按 lineSpacing 排布
    const boxH = Math.max(bounds.height, (lineCount - 1) * Math.max(12, lineSpacing) + renderH)

    // ── scaleX 修正：让编辑框预加载文字与 PDF 原文宽度一致（无感切换）──
    // 用 canvas measureText 计算编辑框文字自然宽度，与 PDF 原文块宽对比，
    // 得出每行的水平缩放比，应用 transform: scaleX(ratio) 使文字精确重合。
    let lineScaleXs = []
    try {
      const ctx = document.createElement('canvas').getContext('2d')
      ctx.font =
        (fmt.bold ? '700 ' : '') +
        (fmt.italic ? 'italic ' : '') +
        cssSize + 'px ' + cssFamily
      const linesArr = text.split('\n')
      lineScaleXs = block.lineData.map((ld, li) => {
        const lineText = linesArr[li] ?? ''
        if (!lineText) return 1
        // PDF 行宽（span 位置差）
        const lineSpans = ld.spans
        if (lineSpans.length) {
          const rects = lineSpans.map((s) => s.getBoundingClientRect())
          const left = Math.min(...rects.map((r) => r.left))
          const right = Math.max(...rects.map((r) => r.right))
          const pdfLineW = Math.max(1, right - left)
          // 自然文字宽（当前字体字号）
          const naturalW = Math.max(1, ctx.measureText(lineText).width)
          return pdfLineW / naturalW
        }
        return 1
      })
      // 限制极端值，避免严重变形
      lineScaleXs = lineScaleXs.map((r) => Math.min(2.5, Math.max(0.4, r)))
    } catch {
      lineScaleXs = []
    }

    // 计算点击位置 → 段落文本字符偏移（光标定位）
    const layerRect = textLayer.getBoundingClientRect()
    let caretOffset = text.length
    try {
      caretOffset = offsetAtPoint(textLayer, pageNum, clientX - layerRect.left, clientY - layerRect.top, {
        lines: block.lineData.map((l) => ({
          ...l,
          text: l.text,
        })),
        fontSize: block.fontSize,
      })
    } catch {
      caretOffset = text.length
    }

    // 基线偏移：编辑框 top 对齐到文字基线，避免与原文错位
    const baselineOffset = cssBaselineOffset(
      cssFamily,
      Math.max(8, cssSize),
      Math.max(12, lineSpacing),
      fmt.bold,
      fmt.italic,
    )

    const state = {
      pageNum,
      layer: textLayer,
      block,
      bounds: { ...bounds, width: boxW, height: boxH },
      text,
      format: fmt,
      lineSpacing,
      caretOffset,
      scale: scaleAt,
      baselineOffset,
      lineScaleXs,
    }
    editRef.current = state
    setEditing(state)
  }, [])

  // commitEdit 引用（供 openEditor 提前提交上一个编辑）
  const commitEditRef = useRef(null)

  // ── 文字层交互绑定：单击左键进入编辑 ──────────────────
  const attachTextEditLayer = useCallback(
    (pageNum, textLayer) => {
      if (!textLayer) return
      const spans = textLayer.querySelectorAll('span[data-page]')
      spans.forEach((span) => {
        if (span.dataset.editBound === '1') return
        span.dataset.editBound = '1'
        span.addEventListener('mousedown', (e) => {
          if (modeRef.current !== 'edit') return
          if (e.button !== 0) return
          // 已有点击选中：拖拽选择优先（编辑框打开时允许拖拽多选）
          if (editRef.current && span.closest('.pdf-text-layer') === editRef.current.layer) return
          e.stopPropagation()
          e.preventDefault()
          openEditor(span, pageNum, e.clientX, e.clientY)
        })
      })
    },
    [openEditor],
  )

  // ── 编辑格式应用到覆盖编辑框 ──────────────────────────
  const applyFormatToEditor = useCallback((fmt) => {
    const box = editBoxRef.current
    if (!box) return
    box.style.fontFamily = fmt.font
    box.style.fontSize = fmt.size + 'px'
    box.style.color = fmt.color
    box.style.fontWeight = fmt.bold ? '700' : '400'
    box.style.fontStyle = fmt.italic ? 'italic' : 'normal'
    box.style.textDecoration = fmt.underline ? 'underline' : 'none'
    box.style.textAlign = fmt.align
  }, [])

  const updateFormat = useCallback(
    (patch) => {
      const state = editRef.current
      if (!state) return
      state.format = { ...state.format, ...patch }
      setEditing({ ...state })
      applyFormatToEditor(state.format)
    },
    [applyFormatToEditor],
  )

  // ── 烧进 pdf-edit-canvas（文字编辑覆盖层）──────────────
  const paintTextEdits = useCallback((pageNum) => {
    const p = pageRefs.current.get(pageNum)
    const el = pagesRef.current.get(pageNum)?.editCanvas
    if (!p || !el) return
    const dpr = window.devicePixelRatio || 1
    const w = p.viewport.width
    const h = p.viewport.height
    if (el.width !== Math.floor(w * dpr)) el.width = Math.floor(w * dpr)
    if (el.height !== Math.floor(h * dpr)) el.height = Math.floor(h * dpr)
    el.style.width = w + 'px'
    el.style.height = h + 'px'
    const ctx = el.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const edits = textEditsRef.current.filter((t) => Number(t.page) === pageNum)
    for (const t of edits) {
      const x = t.x * w
      const y = t.y * h
      const tw = (t.w || 0.2) * w
      const th = (t.h || 0.06) * h
      // 白底覆盖原文
      ctx.save()
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(x - 1, y - 1, tw + 2, th + 2)
      // 新文字（字号按当前缩放还原：记录的是 scale=1 字号）
      const size = Math.max(4, (t.size || 14) * (p.scale || 1))
      const lh = Math.max(4, (t.lineSpacing || (t.size || 14) * 1.35) * (p.scale || 1))
      ctx.fillStyle = t.color || '#1f1f1f'
      ctx.font =
        (t.bold ? '700 ' : '') + (t.italic ? 'italic ' : '') + size + 'px ' + (t.font || 'Helvetica, Arial, sans-serif')
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      ctx.strokeStyle = t.color || '#1f1f1f'
      ctx.lineWidth = Math.max(1, size / 14)
      paintTextLines(ctx, t.text || '', size, x, y, tw, t.align, !!t.underline, lh)
      ctx.restore()
    }
  }, [])

  /** 文字层重建后（缩放/翻页），按 lineIdx 恢复 .edited 虚线框标记 */
  const restoreEditedMarks = useCallback(
    (pageNum, textLayer) => {
      if (!textLayer) return
      const edits = textEditsRef.current.filter((t) => Number(t.page) === pageNum)
      for (const t of edits) {
        for (const idx of t.lineIdx || []) {
          const span = textLayer.querySelector('span[data-page="' + pageNum + '"][data-idx="' + idx + '"]')
          span?.classList.add('edited')
        }
      }
    },
    [],
  )

  // ── 确认编辑：落盘 textEdit + 重绘 ────────────────────
  const commitEdit = useCallback(() => {
    const state = editRef.current
    if (!state) return
    const box = editBoxRef.current
    // 从多行 div 结构逐行读取（空行 div 无文本节点，innerText 会丢行）
    let newText = state.text || ''
    if (box) {
      const lineEls = [...box.querySelectorAll('[data-line]')]
      if (lineEls.length) {
        newText = lineEls.map((l) => l.textContent || '').join('\n')
      } else {
        newText = box.innerText || state.text || ''
      }
    }
    newText = newText.trim()
    const fmt = state.format
    const effBounds = state.bounds
    const effFmt = {
      ...fmt,
      size: box && parseFloat(box.style.fontSize) ? parseFloat(box.style.fontSize) : fmt.size,
    }

    // 标记原 span 为已编辑（透明 + 虚线框）
    state.block?.spans?.forEach((s) => s.classList.add('edited'))

    // 记录 textEdit 批注（归一化 0~1 坐标 + scale=1 字号/行距）
    const p = pageRefs.current.get(state.pageNum)
    if (p) {
      const vw = p.viewport.width
      const vh = p.viewport.height
      const scaleAtEdit = state.scale || p.scale || 1
      const lineCount = newText ? newText.split('\n').length : 1
      const needH = Math.max(effBounds.height, lineCount * (effFmt.size / scaleAtEdit) * 1.35)
      const record = {
        id: uid(),
        type: 'textEdit',
        page: state.pageNum,
        x: effBounds.left / vw,
        y: effBounds.top / vh,
        w: Math.max(effBounds.width / vw, newText ? 0.02 : 0.01),
        h: needH / vh,
        text: newText,
        font: fmt.font,
        size: Math.max(4, Math.round((effFmt.size / scaleAtEdit) * 100) / 100), // scale=1 字号
        lineSpacing: Math.max(4, Math.round((state.lineSpacing / scaleAtEdit) * 100) / 100),
        color: fmt.color,
        bold: fmt.bold,
        italic: fmt.italic,
        underline: fmt.underline,
        align: fmt.align,
        lineIdx: (state.block?.spans || [])
          .map((s) => Number(s.dataset?.idx))
          .filter((v) => Number.isFinite(v)),
      }
      const next = [
        ...textEditsRef.current.filter((t) => !(t.page === state.pageNum && t.id === record.id)),
        record,
      ]
      setTextEdits(next)
      textEditsRef.current = next
      // 合并保存：只更新 pdf 键，保留 docx/md/excel 等其他类型批注
      loadAnnotations(entry)
        .then((ann) => saveAnnotations(entry, { ...ann, pdf: next }))
        .then(() => notify('文字已修改', 'success'))
        .catch((err) => notify('保存失败：' + err.message, 'error'))
      paintTextEdits(state.pageNum)
    }
    editRef.current = null
    setEditing(null)
  }, [entry, notify, paintTextEdits])

  commitEditRef.current = commitEdit

  const cancelEdit = useCallback(() => {
    editRef.current = null
    setEditing(null)
  }, [])

  // ── 页面渲染完成回调（viewer → App 重绘）────────────────
  const handlePageRendered = useCallback(
    (pageNum, info) => {
      pageRefs.current.set(pageNum, {
        base: info.base,
        viewport: info.viewport,
        scale: info.scale,
      })
      // 附加单击编辑监听（缩放重建文字层后重新附加）
      attachTextEditLayer(pageNum, info.textLayer)
      // 恢复已编辑 span 的虚线框标记（文字层重建后丢失）
      restoreEditedMarks(pageNum, info.textLayer)
      // 重绘已保存的文字编辑覆盖
      paintTextEdits(pageNum)
    },
    [attachTextEditLayer, restoreEditedMarks, paintTextEdits],
  )

  const handleScaleChange = useCallback((s, fm) => {
    setScale(s)
    setFitMode(fm)
  }, [])

  // ── 建立 viewer ───────────────────────────────────────
  useEffect(() => {
    if (!ready || !scrollRef.current || !pdf) return
    const viewer = new PdfViewer({
      scrollEl: scrollRef.current,
      getPdf,
      getPageCount,
      getPages,
      onPageRendered: handlePageRendered,
      onActivePageChange: setActivePage,
      onScaleChange: handleScaleChange,
      onNavigate: (n) => {
        setActivePage(n)
        const p = (getPages() || []).find((x) => x.pageNum === n)
        p?.cc?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      },
    })
    viewerRef.current = viewer

    // Ctrl/⌘ + 滚轮 → 光标锚定缩放
    const scrollEl = scrollRef.current
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      // 编辑中缩放：先提交当前编辑（文字层会重建）
      if (editRef.current) commitEdit()
      const rect = scrollEl.getBoundingClientRect()
      const anchorY = e.clientY - rect.top
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
      viewer.zoomBy(factor, anchorY)
    }
    scrollEl.addEventListener('wheel', onWheel, { passive: false })

    viewer.mount()
    viewer.fitWhenReady()
    return () => {
      scrollEl.removeEventListener('wheel', onWheel)
      viewer.destroy()
      viewerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, pdf])

  // ── 视图模式切换 ──────────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.viewMode = viewMode
    viewer.rendered.clear()
    viewer.setupLazyRender()
    viewer.renderVisible()
  }, [viewMode])

  // ── 保存到 PDF 文件（批注 + 文字编辑原生写回内容流）───
  const handleSavePdf = useCallback(async () => {
    if (!pdf || saving) return
    if (editRef.current) commitEdit()
    setSaving(true)
    try {
      const bytes = getOriginalBytes(entry.id)
      if (!bytes) throw new Error('找不到原始文件字节，请重新打开')
      const ann = await loadAnnotations(entry)
      const others = (ann.pdf || []).filter((a) => a.type !== 'textEdit')
      const edits = textEditsRef.current
      const newBytes = await savePdfBack(entry, pdf, others, edits)
      await saveAnnotations(entry, { ...ann, pdf: others })
      const n = edits.length
      notify(
        n > 0
          ? 'PDF 已保存（' + n + ' 处文字编辑已写入文件，' + newBytes.length + ' 字节）'
          : 'PDF 已保存（' + newBytes.length + ' 字节）',
        'success',
      )
    } catch (err) {
      notify('保存失败：' + err.message, 'error')
    } finally {
      setSaving(false)
    }
  }, [pdf, saving, entry, notify, commitEdit])

  // ── 点击页面其他位置自动保存当前编辑（Word 风格）────────
  useEffect(() => {
    if (mode !== 'edit') return
    const onPointerDown = (e) => {
      if (!editRef.current) return
      const target = e.target
      if (target?.closest?.('.pdf-inline-editor, .pdf-edit-bar')) return
      commitEdit()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [mode, commitEdit])

  // ── 编辑框打开后：聚焦 + 光标定位到点击处 ──────────────
  // 编辑框为多行 div 结构，把全局字符偏移映射到（行号, 行内偏移）
  useEffect(() => {
    if (!editing) return
    const raf = requestAnimationFrame(() => {
      const box = editBoxRef.current
      if (!box) return
      box.focus()
      const sel = window.getSelection()
      const range = document.createRange()
      const linesEls = [...box.querySelectorAll('[data-line]')]
      const targetOffset = Math.min(editing.caretOffset ?? 0, (editing.text || '').length)

      // 全局偏移 → 行号/行内偏移
      let lineIdx = 0
      let lineOffset = targetOffset
      const linesArr = String(editing.text || '').split('\n')
      for (let i = 0; i < linesArr.length; i++) {
        if (lineOffset > linesArr[i].length) {
          lineOffset -= linesArr[i].length + 1
          lineIdx++
        } else break
      }

      try {
        const lineEl = linesEls[lineIdx] || linesEls[linesEls.length - 1] || box
        const textNode = lineEl.firstChild || lineEl
        range.setStart(textNode, Math.min(lineOffset, (textNode.textContent || '').length))
        range.collapse(true)
      } catch {
        range.selectNodeContents(box)
        range.collapse(false)
      }
      sel.removeAllRanges()
      sel.addRange(range)
    })
    return () => cancelAnimationFrame(raf)
  }, [editing])

  // ── 键盘：Enter 换行 / Esc 取消 / Ctrl+S 保存 ──────────
  useEffect(() => {
    const onKey = (e) => {
      if (editRef.current) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          commitEdit()
          handleSavePdf()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancelEdit()
        }
        // Enter 不提交：像 Word 一样在编辑框内换行
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        handleSavePdf()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commitEdit, cancelEdit, handleSavePdf])

  // ── 缩略图 ────────────────────────────────────────────
  const regThumb = useCallback(
    (pageNum) => (el) => {
      if (!el) return
      if (pdf) {
        renderPageToCanvas(pdf, pageNum, el, 0.18)
          .then(() => {})
          .catch(() => {})
      }
    },
    [pdf],
  )

  // ── 编辑覆盖框渲染 ────────────────────────────────────
  const editingOverlay = useMemo(() => {
    if (!editing) return null
    const b = editing.bounds
    const fmt = editing.format
    const linesArr = String(editing.text || '').split('\n')
    // 每行应用 scaleX 修正（与 PDF 原文宽度一致，无感切换）
    const scaleXs = editing.lineScaleXs || []
    return (
      <div
        className="pdf-inline-editor-pos"
        style={{
          left: b.left + 'px',
          top: b.top + 'px',
          width: Math.max(b.width, 60) + 'px',
          height: Math.max(b.height, 18) + 'px',
        }}
      >
        <div
          ref={editBoxRef}
          className="pdf-inline-editor"
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          style={{
            fontFamily: fmt.font,
            fontSize: fmt.size + 'px',
            lineHeight: '1',
            color: fmt.color,
            fontWeight: fmt.bold ? '700' : '400',
            fontStyle: fmt.italic ? 'italic' : 'normal',
            textDecoration: fmt.underline ? 'underline' : 'none',
            textAlign: fmt.align,
            whiteSpace: 'pre-wrap',
            background: '#ffffff',
            transformOrigin: '0 0',
          }}
        >
          {linesArr.map((ln, i) => {
            const sx = scaleXs[i] && scaleXs[i] !== 1 ? scaleXs[i] : null
            return (
              <div
                key={i}
                data-line={i}
                style={{
                  transformOrigin: '0 0',
                  transform: sx ? 'scaleX(' + sx + ')' : undefined,
                  whiteSpace: 'pre',
                  minHeight: fmt.size + 'px',
                }}
              >
                {ln}
              </div>
            )
          })}
        </div>
      </div>
    )
  }, [editing])

  // ── 渲染 ──────────────────────────────────────────────
  const pageNodes = useMemo(() => {
    if (!numPages) return null
    return Array.from({ length: numPages }, (_, i) => {
      const n = i + 1
      const showEditor = editing?.pageNum === n
      return (
        <div key={n} className="pdf-page" ref={regPage(n)} data-page={n}>
          <div className="pdf-canvas-container">
            <canvas className="pdf-canvas" />
            <canvas className="pdf-edit-canvas" />
            <div className="pdf-text-layer" />
            <div className="pdf-link-layer" />
            {/* 编辑框必须放在与 textLayer 同原点的容器内（bounds 是相对它的坐标） */}
            {showEditor && editingOverlay}
          </div>
        </div>
      )
    })
  }, [numPages, regPage, editing, editingOverlay])

  const thumbNodes = useMemo(() => {
    if (!numPages) return null
    return Array.from({ length: numPages }, (_, i) => {
      const n = i + 1
      return (
        <button
          key={n}
          className={'pdf-thumb-item ' + (activePage === n ? 'active' : '')}
          onClick={() => viewerRef.current?.jumpToPage(n)}
        >
          <canvas ref={regThumb(n)} className="pdf-thumb-canvas" width={100} height={140} />
          <span>{n}</span>
        </button>
      )
    })
  }, [numPages, activePage, regThumb])

  const pct = Math.round(scale * 100)

  const switchMode = useCallback(
    (m) => {
      if (m === mode) return
      if (m === 'cursor' && editRef.current) commitEdit()
      setMode(m)
    },
    [mode, commitEdit],
  )

  return (
    <div className={'pdf-viewer-shell' + (mode === 'edit' ? ' edit-mode' : '')}>
      {/* 顶部工具栏 */}
      <div className="pdf-toolbar">
        <div className="tool-group">
          <button
            className={'tool-btn ' + (mode === 'cursor' ? 'active' : '')}
            title="光标（滑动浏览页面，文字可拖拽选择）"
            onClick={() => switchMode('cursor')}
          >
            <MousePointer2 size={15} />
            光标
          </button>
          <button
            className={'tool-btn ' + (mode === 'edit' ? 'active' : '')}
            title="编辑（单击文字任意位置直接编辑）"
            onClick={() => switchMode('edit')}
          >
            <PenLine size={15} />
            编辑
          </button>
        </div>
        <div className="tool-group">
          <button className="tool-btn" title="适合宽度" onClick={() => viewerRef.current?.fitWidth()}>
            <Maximize2 size={15} />
            适合宽度
          </button>
          <button className="tool-btn" title="适合页面" onClick={() => viewerRef.current?.fitPage()}>
            <Rows3 size={15} />
            适合页面
          </button>
          <button className="tool-btn" title="实际大小" onClick={() => viewerRef.current?.actualSize()}>
            100%
          </button>
        </div>
        <div className="tool-group">
          <button
            className="tool-btn"
            title="缩小"
            onClick={() => viewerRef.current?.zoomBy(1 / 1.2)}
            disabled={scale <= ZOOM_MIN}
          >
            <ZoomOut size={15} />
          </button>
          <span className="pdf-zoom-pct" title="点击回到适合宽度">
            {pct}%
          </span>
          <button
            className="tool-btn"
            title="放大"
            onClick={() => viewerRef.current?.zoomBy(1.2)}
            disabled={scale >= ZOOM_MAX}
          >
            <ZoomIn size={15} />
          </button>
        </div>
        <div className="tool-group">
          <button
            className={'tool-btn ' + (viewMode === 'single' ? 'active' : '')}
            title="单页模式"
            onClick={() => setViewMode((m) => (m === 'single' ? 'continuous' : 'single'))}
          >
            {viewMode === 'single' ? '连续模式' : '单页模式'}
          </button>
        </div>
        <div className="tool-group">
          <button className="tool-btn primary" title="保存到 PDF（Ctrl+S）" onClick={handleSavePdf} disabled={saving}>
            <Save size={15} />
            {saving ? '保存中…' : '保存到 PDF'}
          </button>
        </div>
        <div className="toolbar-hint">
          编辑模式：单击文字任意位置直接编辑；可拖拽跨行多选；Enter 换行 / Esc 取消 / Ctrl+S 保存
        </div>
      </div>

      {failed && <div className="file-error">PDF 打开失败，请检查文件是否损坏</div>}

      <div className="pdf-body">
        <div className="pdf-thumbs">
          <div className="pdf-thumbs-title">
            <span>页面</span>
            <span>{numPages}</span>
          </div>
          <div className="pdf-thumbs-list">{thumbNodes}</div>
        </div>

        <div className="pdf-viewer">
          {!ready ? (
            <div className="loading">正在打开 PDF…</div>
          ) : (
            <div className="pdf-scroll" ref={scrollRef}>
              <div className="pdf-pages">{pageNodes}</div>
            </div>
          )}
        </div>
      </div>

      {/* 浮动页码/缩放控制条 */}
      <div className="pdf-page-controls">
        <button
          title="上一页"
          onClick={() => viewerRef.current?.jumpToPage(activePage - 1)}
          disabled={activePage <= 1}
        >
          <ChevronLeft size={14} />
        </button>
        <span className="pdf-page-label">
          {activePage} / {numPages || 1}
        </span>
        <button
          title="下一页"
          onClick={() => viewerRef.current?.jumpToPage(activePage + 1)}
          disabled={activePage >= numPages}
        >
          <ChevronRight size={14} />
        </button>
        <span className="pdf-page-controls-sep" />
        <button title="缩小" onClick={() => viewerRef.current?.zoomBy(1 / 1.2)}>
          <Minus size={13} />
        </button>
        <span className="pdf-page-label">{pct}%</span>
        <button title="放大" onClick={() => viewerRef.current?.zoomBy(1.2)}>
          <Plus size={13} />
        </button>
        <button title="适合宽度" onClick={() => viewerRef.current?.fitWidth()}>
          <Maximize2 size={13} />
        </button>
        <button title="适合页面" onClick={() => viewerRef.current?.fitPage()}>
          <Rows3 size={13} />
        </button>
        <button title="实际大小" onClick={() => viewerRef.current?.actualSize()}>
          100%
        </button>
      </div>

      {/* 编辑格式条（Word 风格：字体/字号/加粗/斜体/下划线/颜色/对齐） */}
      {editing && (
        <div className="pdf-edit-bar">
          <select
            className="pdf-edit-font"
            value={editing.format.font}
            onChange={(e) => updateFormat({ font: e.target.value })}
            title="字体"
          >
            {FONTS.map((f) => (
              <option key={f.css} value={f.css}>
                {f.label}
              </option>
            ))}
          </select>
          <select
            className="pdf-edit-size"
            value={editing.format.size}
            onChange={(e) => updateFormat({ size: Number(e.target.value) || 14 })}
            title="字号"
          >
            {SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <span className="pdf-edit-sep" />
          <button
            className={editing.format.bold ? 'active' : ''}
            title="加粗（Ctrl+B）"
            onClick={() => updateFormat({ bold: !editing.format.bold })}
          >
            <Bold size={14} />
          </button>
          <button
            className={editing.format.italic ? 'active' : ''}
            title="斜体"
            onClick={() => updateFormat({ italic: !editing.format.italic })}
          >
            <Italic size={14} />
          </button>
          <button
            className={editing.format.underline ? 'active' : ''}
            title="下划线"
            onClick={() => updateFormat({ underline: !editing.format.underline })}
          >
            <Underline size={14} />
          </button>
          <span className="pdf-edit-sep" />
          <span
            className="pdf-edit-color"
            title="文字颜色"
            style={{
              background: editing.format.color,
              boxShadow:
                editing.format.color === '#ffffff' ? 'inset 0 0 0 1px #ccc' : undefined,
            }}
          >
            <input
              type="color"
              value={editing.format.color === '#1f1f1f' ? '#1f1f1f' : editing.format.color}
              onChange={(e) => updateFormat({ color: e.target.value })}
            />
          </span>
          <span className="pdf-edit-sep" />
          <button
            className={editing.format.align === 'left' ? 'active' : ''}
            title="左对齐"
            onClick={() => updateFormat({ align: 'left' })}
          >
            <AlignLeft size={14} />
          </button>
          <button
            className={editing.format.align === 'center' ? 'active' : ''}
            title="居中"
            onClick={() => updateFormat({ align: 'center' })}
          >
            <AlignCenter size={14} />
          </button>
          <button
            className={editing.format.align === 'right' ? 'active' : ''}
            title="右对齐"
            onClick={() => updateFormat({ align: 'right' })}
          >
            <AlignRight size={14} />
          </button>
        </div>
      )}
    </div>
  )
}