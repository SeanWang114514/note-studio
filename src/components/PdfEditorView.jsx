// PdfEditorView.jsx — PDF 阅读 + 批注视图（React 原生渲染）
//
// 定位：
// - 只做「看 + 画」：连续滚动渲染、缩放、缩略图、单页/连续模式；
// - 不做任何 PDF 文字编辑：没有单击编辑、没有内联编辑框、没有格式条、
//   没有 textEdit 记录、没有文字写回 PDF 的内容流改写；
// - 手绘/批注（画笔、荧光笔、图形、文本框、批注、橡皮擦、撤销/重做）由
//   App 侧的 useAnnotTools + AnnotToolbar + AnnotOverlay 提供，通过
//   overlay / toolbar 两个 prop 注入，本组件只负责给出「画布表面」。
//
// 分层（z-index 见 styles.css 中 .pdf-viewer-shell 段）：
//   pdf-canvas（PDF 位图） < annot-canvas（批注画布） < pdf-link-layer（链接）
//   < ann-dom（DOM 批注/文本框）
// 批注画布在绘制工具激活时才接收指针事件，其余时候不挡滚动与链接点击。

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  FilePlus2,
  Maximize2,
  Minus,
  PanelLeft,
  Plus,
  Rows2,
  Rows3,
  Save,
  Square,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  appendBlankPdfPage,
  loadAnnotations,
  openPdf,
  saveAnnotations,
  savePdfBack,
} from '../lib/FileProcessor.js'
import { PdfViewer, FIT_PAGE, FIT_WIDTH, ZOOM_MAX, ZOOM_MIN } from '../lib/pdf/pdfViewer.js'
import { renderPageToCanvas } from '../lib/pdf/pdfRenderer.js'
import { PanelSplitter } from './PanelSplitter.jsx'
import { usePanel } from '../lib/panelLayout.js'
import { getOriginalBytes, openPdfFromBytes } from '../lib/pdf/pdfEngine.js'
import { useSurfaceRescale } from '../lib/surfaceRescale.js'

/** 批注画布高度上限（CSS px）：超过浏览器 canvas 上限会导致画布分配失败 */
// 覆盖层改为「视口条带」画布后不再需要文档高度上限（旧实现整篇挂一块画布，超限会分配失败）

// 单页/连续模式是「看图偏好」，跟具体文档无关，存在 localStorage 里；换文档、刷新后保持
const VIEW_MODE_KEY = 'note-studio.pdf-view-mode.v1'

function readStoredViewMode() {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === 'single' ? 'single' : 'continuous'
  } catch {
    return 'continuous'
  }
}

function storeViewMode(mode) {
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode === 'single' ? 'single' : 'continuous')
  } catch {
    /* 隐私模式等写不进去就算了，不影响功能 */
  }
}

// 缩略图单项：memo 化后，滚动时「当前页」变化只会重渲染相邻的两项，
// 而不是每次滚动都把几十个 canvas 节点重新 diff 一遍。
const PdfThumbItem = memo(function PdfThumbItem({ n, active, onJump, register }) {
  const ref = useMemo(() => register(n), [register, n])
  return (
    <button
      className={'pdf-thumb-item ' + (active ? 'active' : '')}
      onClick={() => onJump(n)}
      aria-current={active ? 'page' : undefined}
    >
      <canvas ref={ref} className="pdf-thumb-canvas" width={100} height={140} />
      <span>{n}</span>
    </button>
  )
})

export default function PdfEditorView({ entry, notify, overlay = null, onViewerScale, onSurfaceResized }) {
  // 缩略图栏：宽度可拖拽调整、可折叠（布局持久化在 localStorage）
  const thumbs = usePanel('pdfThumbs')
  const [pdf, setPdf] = useState(null)
  const [numPages, setNumPages] = useState(0)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [scale, setScale] = useState(1)
  const [fitMode, setFitMode] = useState(FIT_WIDTH)
  const [activePage, setActivePage] = useState(1)
  const [viewMode, setViewMode] = useState(readStoredViewMode)
  const [saving, setSaving] = useState(false)
  const [pagesHeight, setPagesHeight] = useState(0)
  // 新建一页后自增：让打开文档的 effect 从「缓存里的新字节」重开一次
  const [reloadKey, setReloadKey] = useState(0)
  const [inserting, setInserting] = useState(false)

  const scrollRef = useRef(null)
  const pagesBoxRef = useRef(null)
  const pagesRef = useRef(new Map()) // pageNum -> {cc, canvas, linkLayer}
  const viewerRef = useRef(null)
  const pdfDocRef = useRef(null) // 当前 pdf.js 文档：重载/卸载时负责销毁，避免换文档泄漏
  // 滚轮处理器是在挂载时一次性注册的（依赖 [ready, pdf]），读 ref 才能拿到最新模式
  const viewModeRef = useRef(viewMode)
  viewModeRef.current = viewMode
  // 加页后文档表面变高 → 把既有批注按「旧高/新高」重标定，墨迹留在原地
  const markSurfaceHeight = useSurfaceRescale(pagesBoxRef, (ratio) => onSurfaceResized?.(ratio))

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
    pagesRef.current.clear()
    ;(async () => {
      try {
        // 新建一页只改字节缓存（磁盘文件等「保存批注到 PDF」时才写），
        // 所以重载要从缓存字节开文档；首次打开仍从 entry.file 走。
        const cached = reloadKey > 0 ? getOriginalBytes(entry.id) : null
        const doc = cached
          ? (await openPdfFromBytes(cached, entry.id)).pdf
          : await openPdf(entry.file, entry.id)
        if (cancelled) {
          doc.destroy?.()
          return
        }
        pdfDocRef.current?.destroy?.()
        pdfDocRef.current = doc
        setPdf(doc)
        setNumPages(doc.numPages)
        setReady(true)
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
      pdfDocRef.current?.destroy?.()
      pdfDocRef.current = null
      setPdf(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, reloadKey])

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
        linkLayer: el.querySelector('.pdf-link-layer'),
      })
    },
    [],
  )

  const handleScaleChange = useCallback((s, fm) => {
    setScale(s)
    setFitMode(fm)
    // 批注层的字号/标记要跟随页面缩放：把查看器缩放倍数透传上去（App 需要无 hover 时的
    // 即时值，不能等 React 状态）
    onViewerScale?.(s)
  }, [onViewerScale])

  // ── 建立 viewer ───────────────────────────────────────
  useEffect(() => {
    if (!ready || !scrollRef.current || !pdf) return
    const viewer = new PdfViewer({
      scrollEl: scrollRef.current,
      getPdf,
      getPageCount,
      getPages,
      onActivePageChange: setActivePage,
      onScaleChange: handleScaleChange,
      onNavigate: (n) => {
        setActivePage(n)
        const p = (getPages() || []).find((x) => x.pageNum === n)
        p?.cc?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      },
    })
    viewerRef.current = viewer

    // Ctrl/⌘ + 滚轮 → 光标锚定缩放；单页模式下的普通滚轮 → 上一页 / 下一页
    const scrollEl = scrollRef.current
    let wheelAcc = 0
    let wheelResetTimer = null
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const rect = scrollEl.getBoundingClientRect()
        const anchorY = e.clientY - rect.top
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
        viewer.zoomBy(factor, anchorY)
        return
      }
      if (viewModeRef.current !== 'single') return
      // 单页模式：一屏一页，滚一下就翻一页。用「当前页是否装得下视口」来判断：
      // 装得下（setViewMode 里 fitPage 后的常态）→ 直接翻页；
      // 装不下（用户又放大了）→ 先做页内滚动，滚到头才翻页。
      const cur = (getPages() || []).find((p) => p.pageNum === viewer.currentPage)
      const pageH = cur?.cc ? cur.cc.getBoundingClientRect().height : 0
      const fits = pageH > 0 && pageH <= scrollEl.clientHeight + 8
      if (!fits) {
        const atTop = scrollEl.scrollTop <= 1
        const atBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 1
        if ((e.deltaY > 0 && !atBottom) || (e.deltaY < 0 && !atTop)) return
      }
      e.preventDefault()
      wheelAcc += e.deltaY
      clearTimeout(wheelResetTimer)
      wheelResetTimer = setTimeout(() => {
        wheelAcc = 0
      }, 240)
      if (Math.abs(wheelAcc) < 30) return
      const dir = wheelAcc > 0 ? 1 : -1
      wheelAcc = 0
      const max = getPageCount()
      const next = Math.min(max, Math.max(1, viewer.currentPage + dir))
      if (next !== viewer.currentPage) viewer.jumpToPage(next)
    }
    scrollEl.addEventListener('wheel', onWheel, { passive: false })

    viewer.mount()
    viewer.fitWhenReady()
    return () => {
      scrollEl.removeEventListener('wheel', onWheel)
      clearTimeout(wheelResetTimer)
      viewer.destroy()
      viewerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, pdf])

  // ── 视图模式切换（单页 / 连续）────────────────────────
  // 依赖里必须带 ready：首帧渲染时 viewer 还没创建（那时 effect 会空转返回），
  // 如果只依赖 viewMode，等 PDF 就绪、viewer 建好之后这个 effect 不会重跑，
  // 「上次记住的单页模式」就会失效 —— 按钮显示单页、页面却还是连续滚动。
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.setViewMode(viewMode)
    viewer.rendered.clear()
    viewer.setupLazyRender()
    viewer.renderVisible()
  }, [viewMode, ready])

  // 记住「看图偏好」，下次打开文档 / 刷新页面还是这个模式
  useEffect(() => {
    storeViewMode(viewMode)
  }, [viewMode])

  // PageUp / PageDown：单页模式翻一页，连续模式翻一屏。
  // 滚动容器本身不可聚焦，浏览器默认的翻页键在这里什么都不会做，所以自己接。
  useEffect(() => {
    if (!ready) return undefined
    const onKey = (e) => {
      if (e.key !== 'PageDown' && e.key !== 'PageUp') return
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const el = e.target
      const tag = el?.tagName
      // 正在输入框里写字（文本框/批注/搜索）时不要抢键
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return
      const viewer = viewerRef.current
      const sc = scrollRef.current
      if (!viewer || !sc) return
      e.preventDefault()
      const dir = e.key === 'PageDown' ? 1 : -1
      if (viewModeRef.current === 'single') {
        viewer.jumpToPage(viewer.currentPage + dir)
      } else {
        sc.scrollBy({ top: dir * Math.round(sc.clientHeight * 0.9), behavior: 'smooth' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ready])

  // ── 批注表面高度（决定是否挂载批注画布）──────────────
  useEffect(() => {
    const el = pagesBoxRef.current
    if (!el) return
    const measure = () => setPagesHeight(el.clientHeight || 0)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ready, numPages, scale, viewMode])

  // ── 保存批注到 PDF 文件（不做任何文字写回）────────────
  const handleSavePdf = useCallback(async () => {
    if (!pdf || saving) return
    setSaving(true)
    try {
      const bytes = getOriginalBytes(entry.id)
      if (!bytes) throw new Error('找不到原始文件字节，请重新打开')
      const ann = await loadAnnotations(entry)
      const anns = (ann.pdf || []).filter((a) => a.type !== 'textEdit')
      const newBytes = await savePdfBack(entry, pdf, anns)
      await saveAnnotations(entry, { ...ann, pdf: anns })
      notify('批注已写入 PDF（' + newBytes.length + ' 字节）', 'success')
    } catch (err) {
      notify('保存失败：' + err.message, 'error')
    } finally {
      setSaving(false)
    }
  }, [pdf, saving, entry, notify])

  // Ctrl/⌘ + S 保存批注到 PDF
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return
      e.preventDefault()
      handleSavePdf()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleSavePdf])

  // ── 新建一页：末尾追加空白页 ───────────────────────────
  const handleNewPage = useCallback(async () => {
    if (inserting || !ready) return
    setInserting(true)
    try {
      // 先记下加页前的表面高度（结算时按 旧高/新高 重标定批注）
      markSurfaceHeight()
      const { pageCount } = await appendBlankPdfPage(entry)
      setReloadKey((k) => k + 1)
      notify(
        `已在末尾新增第 ${pageCount} 页空白页，点击「保存批注到 PDF」写入文件`,
        'success',
      )
    } catch (err) {
      notify('新建页面失败：' + err.message, 'error')
    } finally {
      setInserting(false)
    }
  }, [inserting, ready, markSurfaceHeight, entry, notify])

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

  // ── 渲染 ──────────────────────────────────────────────
  const pageNodes = useMemo(() => {
    if (!numPages) return null
    return Array.from({ length: numPages }, (_, i) => {
      const n = i + 1
      return (
        <div key={n} className="pdf-page" ref={regPage(n)} data-page={n}>
          <div className="pdf-canvas-container">
            <canvas className="pdf-canvas" />
            <div className="pdf-link-layer" />
          </div>
        </div>
      )
    })
  }, [numPages, regPage])

  const thumbNodes = useMemo(() => {
    if (!numPages) return null
    const jump = (n) => viewerRef.current?.jumpToPage(n)
    return Array.from({ length: numPages }, (_, i) => {
      const n = i + 1
      return <PdfThumbItem key={n} n={n} active={activePage === n} onJump={jump} register={regThumb} />
    })
  }, [numPages, activePage, regThumb])

  const pct = Math.round(scale * 100)
  // 批注覆盖层按「视口条带」绘制（画布只覆盖当前可见范围 + 半屏余量），
  // 所以不再受整篇文档高度限制：几百页的连续滚动文档也能正常手写批注。
  const overlayEnabled = Boolean(overlay) && pagesHeight > 0

  return (
    <div className="pdf-viewer-shell">
      {/* 视图工具栏（缩放/翻页/保存批注；不再有任何文字编辑入口） */}
      <div className="pdf-toolbar">
        <div className="tool-group">
          <button className="tool-btn" title="适合宽度" onClick={() => viewerRef.current?.fitWidth()}>
            <Maximize2 size={15} />
            <span className="btn-text">适合宽度</span>
          </button>
          <button className="tool-btn" title="适合页面" onClick={() => viewerRef.current?.fitPage()}>
            <Rows3 size={15} />
            <span className="btn-text">适合页面</span>
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
            title={
              viewMode === 'single'
                ? '单页模式：一屏一页（滚轮 / PageDown 翻页）—— 点击切回连续滚动'
                : '连续模式：自由滚动 —— 点击切到单页模式（一屏一页）'
            }
            aria-pressed={viewMode === 'single'}
            onClick={() => setViewMode((m) => (m === 'single' ? 'continuous' : 'single'))}
          >
            {viewMode === 'single' ? <Rows2 size={15} /> : <Square size={15} />}
            <span className="btn-text">{viewMode === 'single' ? '连续模式' : '单页模式'}</span>
          </button>
        </div>
        <div className="tool-group">
          <button
            className="tool-btn new-page-btn"
            title="在文档末尾追加一页空白页（保存批注到 PDF 时一起写入文件）"
            onClick={handleNewPage}
            disabled={inserting || !ready}
          >
            <FilePlus2 size={15} />
            <span className="btn-text">{inserting ? '新增中…' : '新建一页'}</span>
          </button>
        </div>
        <div className="tool-group">
          <button
            className="tool-btn primary"
            title="把批注写入 PDF 文件（Ctrl+S）"
            onClick={handleSavePdf}
            disabled={saving}
          >
            <Save size={15} />
            <span className="btn-text">{saving ? '保存中…' : '保存批注到 PDF'}</span>
          </button>
        </div>
        <div className="toolbar-hint">
          阅读 + 批注模式：用上方画笔/荧光笔在页面上手绘，批注自动保存到旁车文件
        </div>
      </div>

      {failed && <div className="file-error">PDF 打开失败，请检查文件是否损坏</div>}

      <div className="pdf-body">
        {thumbs.collapsed ? (
          <div className="panel-rail thumbs-rail" aria-label="缩略图栏已折叠">
            <button
              className="panel-rail-btn icon-btn"
              title="展开页面缩略图栏"
              aria-label="展开页面缩略图栏"
              aria-expanded="false"
              onClick={() => thumbs.setCollapsed(false)}
            >
              <PanelLeft size={16} />
            </button>
          </div>
        ) : (
          <>
            <div
              className="pdf-thumbs"
              style={{ width: `${thumbs.width}px`, minWidth: `${thumbs.min}px`, maxWidth: `${thumbs.max}px` }}
            >
              <div className="pdf-thumbs-title">
                <span>页面</span>
                <span>{numPages}</span>
                <button
                  className="pdf-thumbs-collapse panel-collapse-btn icon-btn"
                  title="折叠缩略图栏"
                  aria-label="折叠缩略图栏"
                  aria-expanded="true"
                  onClick={() => thumbs.setCollapsed(true)}
                >
                  <PanelLeft size={16} />
                </button>
              </div>
              <div className="pdf-thumbs-list">{thumbNodes}</div>
            </div>
            <PanelSplitter panel="pdfThumbs" edge="right" title="拖动调整缩略图栏宽度（双击恢复默认，回车折叠）" />
          </>
        )}

        <div className="pdf-viewer">
          {!ready ? (
            <div className="loading">正在打开 PDF…</div>
          ) : (
            <div className="pdf-scroll" ref={scrollRef}>
              <div className="pdf-pages annot-surface" ref={pagesBoxRef}>
                {pageNodes}
                {overlayEnabled ? overlay : null}
              </div>
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
    </div>
  )
}
