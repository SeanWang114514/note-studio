// pdfViewer.js — PDF 阅读视图编排（套用 open-pdf-studio 的 renderer.js 连续视图逻辑）
//
// 职责：
// - 连续滚动模式：为每页建立尺寸精确的 wrapper（scale-1 基准 + 即时缩放），
//   IntersectionObserver 惰性渲染可见页；先画低清预览再补全清。
// - 缩放：即时拉伸所有已渲染画布（锚定光标位置），130ms 防抖后重渲染清晰版；
//   支持适合宽度 / 适合页面 / 实际大小 / 百分比。
// - 单页模式：只渲染当前页，翻页时重建。
// - 滚动同步：滚动中检测距视口中心最近的页 → 回调 onActivePageChange。
// - 竞态防护：渲染代数 + 文档切换检测，防止快速缩放/翻页时旧渲染覆盖新结果。
//
// 页面 DOM 由 React 侧（App.jsx）声明式构建，本模块通过 getPages() 拿到
// {pageNum, cc, canvas, editCanvas, overlay, textLayer, linkLayer} 结构，
// 只负责尺寸、渲染与分层 —— 批注绘制仍由 App 通过 onPageRendered 回调完成。

import {
  startPageRender,
  renderLowResPreview,
  renderTextLayer,
  renderLinkLayer,
  getCanvasDPR,
} from './pdfRenderer.js'
import { getPageBaseDims } from './pdfEngine.js'

export const ZOOM_MIN = 0.05
export const ZOOM_MAX = 24
export const FIT_NONE = 'custom'
export const FIT_WIDTH = 'fit-width'
export const FIT_PAGE = 'fit-page'

const PREVIEW_SCALE = 0.5
const RERENDER_DEBOUNCE = 130
const OBSERVER_MARGIN = 200

export class PdfViewer {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.scrollEl - 滚动容器
   * @param {() => object} opts.getPdf - 返回 PDF.js 文档
   * @param {() => number} opts.getPageCount
   * @param {() => Array<object>} opts.getPages - 返回页面元素结构数组
   * @param {(pageNum: number, info: object) => void} opts.onPageRendered - 页面渲染完成回调（App 重绘批注）
   * @param {(pageNum: number) => void} opts.onActivePageChange - 滚动同步
   * @param {(pageNum: number) => void} opts.onNavigate - 内部链接跳转
   * @param {(scale: number, fitMode: string) => void} opts.onScaleChange - 缩放变化回调
   */
  constructor(opts) {
    this.opts = opts
    this.scale = 1
    this.fitMode = FIT_NONE
    this.viewMode = 'continuous'
    this.currentPage = 1
    this.baseDims = new Map() // pageNum -> {widthPt, heightPt, rotation}
    this.lowResCache = new Map() // pageNum -> canvas
    this.rendered = new Set()
    this.rendering = new Set()
    this.observer = null
    this.renderGen = 0
    this.pageSeq = new Map() // pageNum -> 渲染代数（防旧渲染覆盖新渲染）
    this.renderTasks = new Map() // pageNum -> pdf.js RenderTask（新渲染前取消旧任务）
    this.rerenderTimer = null
    this.lowResTimer = null
    this.destroyed = false
    this._onScroll = null
    // 布局代数 + 页码偏移缓存（见 rebuildPageOffsets）：滚动期间不再读布局
    this.layoutStamp = 0
    this.pageOffsets = null
    this.pageOffsetsStamp = -1
  }

  /** 取滚动容器宽度（用于适合宽度计算） */
  getScrollWidth() {
    const el = this.opts.scrollEl
    if (!el) return 800
    // 减去 padding：页面容器自带 padding，用 clientWidth 更稳妥
    return Math.max(200, el.clientWidth - 32)
  }

  getScrollHeight() {
    const el = this.opts.scrollEl
    return el ? Math.max(200, el.clientHeight - 32) : 600
  }

  async ensureBaseDims(pageNum) {
    if (this.baseDims.has(pageNum)) return this.baseDims.get(pageNum)
    const pdf = this.opts.getPdf()
    if (!pdf) return { widthPt: 600, heightPt: 800, rotation: 0 }
    const dims = await getPageBaseDims(pdf, pageNum)
    this.baseDims.set(pageNum, dims)
    return dims
  }

  /** 页面逻辑尺寸 = base × scale */
  pageSize(pageNum) {
    const d = this.baseDims.get(pageNum) || { widthPt: 600, heightPt: 800, rotation: 0 }
    return { width: d.widthPt * this.scale, height: d.heightPt * this.scale }
  }

  /** 立即按当前 scale 同步页面容器与画布尺寸（即时缩放，不做重渲染）。
   *  只拉伸画布类元素；文字层/链接层由防抖重渲染重建（同 open-pdf-studio）。 */
  applyInstantResize(anchorY = null) {
    const scrollEl = this.opts.scrollEl
    if (!scrollEl) return
    const pages = this.opts.getPages() || []
    for (const p of pages) {
      const { width, height } = this.pageSize(p.pageNum)
      if (p.cc) {
        p.cc.style.width = `${width}px`
        p.cc.style.height = `${height}px`
      }
      // 拉伸已渲染的位图（canvas），文字/链接层由重渲染重建
      for (const key of ['canvas', 'editCanvas', 'overlay']) {
        const el = p[key]
        if (el) {
          el.style.width = `${width}px`
          el.style.height = `${height}px`
        }
      }
        // 即时缩放阶段先隐藏文字/链接层，避免旧坐标与新尺寸错位；
        // 清晰重渲染完成后由 renderPage 恢复。
        if (p.textLayer) p.textLayer.style.opacity = '0'
        if (p.linkLayer) p.linkLayer.style.opacity = '0'
    }
    if (anchorY != null && this._prevScale) {
      scrollEl.scrollTop = Math.max(
        0,
        (scrollEl.scrollTop + anchorY) * (this.scale / this._prevScale) - anchorY,
      )
    }
    // 页面尺寸变了 → 页码偏移缓存作废
    this.layoutStamp += 1
  }

  /**
   * 缩放并保持锚点（光标位置）不动。
   * @param {number} newScale
   * @param {number|null} anchorY - 视口内锚点 Y（CSS px）
   * @param {boolean} instant - 立即应用（否则仅更新状态等待调度）
   */
  zoomTo(newScale, anchorY = null, instant = true) {
    if (this.destroyed) return
    newScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(newScale * 1000) / 1000))
    if (newScale === this.scale) return
    this._prevScale = this.scale
    this.scale = newScale
    this.fitMode = FIT_NONE
    if (instant) this.applyInstantResize(anchorY)
    this.opts.onScaleChange?.(this.scale, this.fitMode)
    this.scheduleCrispRerender()
  }

  /** 相对缩放 */
  zoomBy(factor, anchorY = null) {
    this.zoomTo(this.scale * factor, anchorY)
  }

  /** 适合宽度 / 适合页面 / 实际大小 */
  fitWidth() {
    const pdf = this.opts.getPdf()
    if (!pdf) return
    // 以「当前所在页」为基准：不同尺寸的页面混排时，跟随你正在看的那一页更合理
    const firstPage = this.currentPage || 1
    const d = this.baseDims.get(firstPage)
    if (!d) return
    const newScale = Math.min(ZOOM_MAX, (this.getScrollWidth() / d.widthPt) * 0.98)
    this.fitMode = FIT_WIDTH
    this._setFitScale(newScale)
  }
  fitPage() {
    const pdf = this.opts.getPdf()
    if (!pdf) return
    const firstPage = this.currentPage || 1
    const d = this.baseDims.get(firstPage)
    if (!d) return
    const s = Math.min(
      this.getScrollWidth() / d.widthPt,
      this.getScrollHeight() / d.heightPt,
    )
    this.fitMode = FIT_PAGE
    this._setFitScale(Math.min(ZOOM_MAX, s * 0.98))
  }

  /**
   * 单页 / 连续模式。
   *
   * 单页：整页适配窗口（一屏正好一页）+ 滚动吸附到页首（CSS 在 .pdf-scroll--single 上），
   *       只渲染当前页（可见页列表在 visiblePageNums 里收窄），翻页靠滚轮（PdfEditorView
   *       的 wheel 处理）/ 底部上下页按钮 / 吸附滚动。
   * 连续：恢复自由滚动。
   *
   * 之前这里只是一个「写了没人读」的字段（this.viewMode = …），按钮点下去除了自己的
   * 文案和图标翻转之外什么都没发生 —— 用户看到的就是「单页模式和连续模式看不出来区别」。
   */
  setViewMode(mode) {
    const next = mode === 'single' ? 'single' : 'continuous'
    if (this.viewMode === next) return
    this.viewMode = next
    const scrollEl = this.opts.scrollEl
    if (scrollEl) scrollEl.classList.toggle('pdf-scroll--single', next === 'single')
    // 页间距/内边距都变了，偏移缓存与已渲染标记全部作废
    this.invalidatePageOffsets()
    this.rendered.clear()
    this.setupLazyRender()
    if (next === 'single') {
      // 一屏一页：整页放进窗口，再把当前页的页首对齐到容器顶部。
      // 页面尺寸可能还没就绪（启动时就记得是单页模式时，setViewMode 会先于首次渲染调用），
      // 所以要等 ensureBaseDims 回来再算 fit —— 否则 fitPage() 直接 return，
      // 单页模式会停留在上次的「适合宽度」缩放上，一页装不进窗口。
      this.ensureBaseDims(this.currentPage)
        .then(() => {
          if (this.destroyed || this.viewMode !== 'single') return
          this.fitPage()
          this.jumpToPage(this.currentPage)
        })
        .catch(() => {})
    } else {
      this.renderVisible()
    }
  }

  actualSize() {
    this.fitMode = FIT_NONE
    this.zoomTo(1, null)
  }

  _setFitScale(newScale) {
    newScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(newScale * 1000) / 1000))
    if (newScale === this.scale) return
    this._prevScale = this.scale
    this.scale = newScale
    this.applyInstantResize()
    this.opts.onScaleChange?.(this.scale, this.fitMode)
    this.scheduleCrispRerender()
  }

  scheduleCrispRerender() {
    clearTimeout(this.rerenderTimer)
    this.rerenderTimer = setTimeout(() => {
      this.rerenderTimer = null
      if (this.destroyed) return
      this.renderVisible()
    }, RERENDER_DEBOUNCE)
  }

  /**
   * 建立视图：预取所有页面基准尺寸，按当前 scale 构建/更新 DOM 尺寸，
   * 启动滚动同步与惰性渲染。
   */
  async mount() {
    if (this.destroyed) return
    const pageCount = this.opts.getPageCount()
    // 预取 base dims（连续模式的即时缩放基准）
    const dimsPromises = []
    for (let i = 1; i <= pageCount; i++) {
      dimsPromises.push(
        this.ensureBaseDims(i).catch(() => null),
      )
    }
    await Promise.all(dimsPromises)
    if (this.destroyed) return

    // 先按当前 scale 同步尺寸（已有 DOM 时）
    this.applyInstantResize()

    // 滚动同步
    this.bindScrollSync()

    // 容器宽度变化自动适配（侧栏/批注栏开合、窗口拖动）
    this.watchContainerSize()

    // 惰性渲染：IntersectionObserver + 兜底显式渲染
    this.setupLazyRender()

    // 后台低清预览预渲染（快速滚动体验）
    this.preloadLowRes(pageCount)
  }

  bindScrollSync() {
    const scrollEl = this.opts.scrollEl
    if (!scrollEl || this._onScroll) return
    let pending = null
    this._onScroll = () => {
      if (pending) return
      pending = setTimeout(() => {
        pending = null
        this.syncActivePageFromScroll()
      }, 80)
    }
    scrollEl.addEventListener('scroll', this._onScroll, { passive: true })
  }

  /**
   * 重建「页码 → 文档内偏移」缓存。
   * 滚动时判断当前页如果按页去 getBoundingClientRect（45 页 = 45 次强制布局），
   * 主线程会被读布局占满；布局只有在缩放/尺寸变化时才会变，所以在这里一次性量好，
   * 滚动期间只用 scrollTop 做纯计算。
   */
  rebuildPageOffsets() {
    const scrollEl = this.opts.scrollEl
    const pages = this.opts.getPages() || []
    if (!scrollEl || !pages.length) {
      this.pageOffsets = []
      return
    }
    const scrollRect = scrollEl.getBoundingClientRect()
    const base = scrollRect.top - scrollEl.scrollTop
    const offsets = []
    for (const p of pages) {
      if (!p.cc) continue
      const r = p.cc.getBoundingClientRect()
      if (r.height === 0) continue
      offsets.push({ pageNum: p.pageNum, top: r.top - base, height: r.height })
    }
    offsets.sort((a, b) => a.top - b.top)
    this.pageOffsets = offsets
    this.pageOffsetsStamp = this.layoutStamp
  }

  /** 布局变化时让偏移缓存失效（缩放、重排、容器尺寸变化都会走到这里） */
  invalidatePageOffsets() {
    this.pageOffsets = null
  }

  /**
   * 根据滚动位置求当前页（无需读布局）：
   * 取视口中线落在哪一页；落在页间空隙时取最近的一页。
   */
  syncActivePageFromScroll() {
    const scrollEl = this.opts.scrollEl
    if (!scrollEl) return
    if (!this.pageOffsets || this.pageOffsetsStamp !== this.layoutStamp) this.rebuildPageOffsets()
    const offsets = this.pageOffsets || []
    const mid = scrollEl.scrollTop + scrollEl.clientHeight / 2
    let best = null
    let bestDist = Infinity
    for (const o of offsets) {
      if (mid >= o.top && mid <= o.top + o.height) {
        best = o.pageNum
        break
      }
      const d = mid < o.top ? o.top - mid : mid - (o.top + o.height)
      if (d < bestDist) {
        bestDist = d
        best = o.pageNum
      }
    }
    if (best && best !== this.currentPage) {
      this.currentPage = best
      this.opts.onActivePageChange?.(best)
    }
  }

  setupLazyRender() {
    const scrollEl = this.opts.scrollEl
    const pages = this.opts.getPages() || []
    if (this.observer) this.observer.disconnect()
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const pageNum = Number(entry.target.dataset.page)
            if (pageNum && !this.rendered.has(pageNum)) this.renderPage(pageNum)
          }
        }
      },
      { root: scrollEl, rootMargin: `${OBSERVER_MARGIN}px 0px` },
    )
    for (const p of pages) {
      if (p.cc) this.observer.observe(p.cc)
    }
    // 兜底：观察者首帧可能错过（布局未定型时），显式渲染可见页
    const doRenderVisible = () => {
      if (this.destroyed) return
      const contRect = scrollEl.getBoundingClientRect()
      if (contRect.height === 0) return
      for (const p of this.opts.getPages() || []) {
        if (!p.cc || this.rendered.has(p.pageNum)) continue
        const r = p.cc.getBoundingClientRect()
        if (r.bottom >= contRect.top - OBSERVER_MARGIN && r.top <= contRect.bottom + OBSERVER_MARGIN) {
          this.renderPage(p.pageNum)
        }
      }
    }
    requestAnimationFrame(doRenderVisible)
    setTimeout(doRenderVisible, 150)
  }

  /** 可见页列表（连续模式 = 全部，单页模式 = 当前页） */
  visiblePageNums() {
    if (this.viewMode === 'single') return [this.currentPage]
    const pageCount = this.opts.getPageCount()
    return Array.from({ length: pageCount }, (_, i) => i + 1)
  }

  /** 重渲染所有可见页（缩放防抖后调用） */
  async renderVisible() {
    const gen = ++this.renderGen
    for (const pageNum of this.visiblePageNums()) {
      if (gen !== this.renderGen) return
      await this.renderPage(pageNum)
    }
  }

  /** 渲染单页：低清预览 → 全清画布 + 文字层 + 链接层 */
  async renderPage(pageNum) {
    if (this.destroyed) return
    const pdf = this.opts.getPdf()
    if (!pdf) return
    const p = (this.opts.getPages() || []).find((x) => x.pageNum === pageNum)
    if (!p || !p.canvas) return

    // 同页渲染互斥：已有渲染在跑则跳过本次请求（下一次请求会接管）。
    // 避免同一画布上的并发 render() 冲突（pdf.js 会抛错）。
    if (this.rendering.has(pageNum)) return

    // 页面级渲染代数：新渲染启动即让旧渲染作废（旧渲染在下一个 await
    // 后检测到代数变化自行退出，不会覆盖新结果）。
    const mySeq = (this.pageSeq.get(pageNum) || 0) + 1
    this.pageSeq.set(pageNum, mySeq)
    const isStale = () =>
      this.destroyed || this.pageSeq.get(pageNum) !== mySeq
    const finish = () => this.rendering.delete(pageNum)

    this.rendering.add(pageNum)
    // 在任何异步步骤之前先把旧的叠加层移出屏幕并清空内容。
    // 否则缩放/容器重排期间，旧文字层会和新文字层同时可见，形成严重重影。
    this.rendered.delete(pageNum)
    if (p.textLayer) {
      p.textLayer.style.opacity = '0'
      p.textLayer.replaceChildren()
    }
    if (p.linkLayer) {
      p.linkLayer.style.opacity = '0'
      p.linkLayer.replaceChildren()
    }
    if (p.editCanvas) {
      const editCtx = p.editCanvas.getContext('2d')
      editCtx?.setTransform(1, 0, 0, 1, 0, 0)
      editCtx?.clearRect(0, 0, p.editCanvas.width, p.editCanvas.height)
    }
    try {
      // 低清预览立即展示（若缓存命中）
      const lowRes = this.lowResCache.get(pageNum)
      if (lowRes && !this.rendered.has(pageNum)) {
        const ctx = p.canvas.getContext('2d')
        const size = this.pageSize(pageNum)
        const dpr = getCanvasDPR(size.width, size.height)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.drawImage(lowRes, 0, 0, size.width, size.height)
      }

      const { task, viewport, page } = await startPageRender(pdf, pageNum, p.canvas, this.scale)
      // 同一画布不能并行 render：取消该页上一次未完成的渲染任务
      const prevTask = this.renderTasks.get(pageNum)
      if (prevTask && prevTask !== task) {
        try {
          prevTask.cancel()
        } catch {
          // 任务已结束，忽略
        }
      }
      this.renderTasks.set(pageNum, task)
      try {
        await task.promise
      } catch (err) {
        // 被取消的渲染（新任务接管）不是错误
        if (!String(err?.name || err).toLowerCase().includes('cancel')) {
          console.error(`[pdf] render page ${pageNum} failed:`, err)
        }
        finish()
        return
      }
      if (isStale()) { finish(); return }

      // 保存 base 位图（文字编辑"烧进画布"重绘需要）
      let base = null
      try {
        base = await createImageBitmap(p.canvas)
      } catch {
        base = null
      }
      if (isStale()) {
        if (base?.close) base.close()
        finish()
        return
      }

      // 文字层（重建：容器先清空）
      let textLayerResult = null
      if (p.textLayer) {
        p.textLayer.replaceChildren()
        p.textLayer.style.setProperty('--scale-factor', String(viewport.scale))
        p.textLayer.style.setProperty('--total-scale-factor', String(viewport.scale))
        textLayerResult = await renderTextLayer(page, viewport, p.textLayer, pageNum, (div, idx) => {
          div.dataset.page = String(pageNum)
          div.dataset.idx = String(idx)
        })
      }
      if (isStale()) { finish(); return }

      // 链接层（重建）
      if (p.linkLayer) {
        p.linkLayer.replaceChildren()
        await renderLinkLayer(page, viewport, p.linkLayer, pageNum, (n) => this.jumpToPage(n))
      }
      if (isStale()) { finish(); return }

        // 文字层永远保持视觉透明：它只提供点击/选择命中区域。
        // PDF 主画布负责原文显示，编辑覆盖层负责修改后的文字显示。
        if (p.textLayer) p.textLayer.style.opacity = '0'
        if (p.linkLayer) p.linkLayer.style.opacity = '1'

      this.rendered.add(pageNum)
      finish()

      this.opts.onPageRendered?.(pageNum, {
        canvas: p.canvas,
        editCanvas: p.editCanvas,
        overlay: p.overlay,
        textLayer: p.textLayer,
        cc: p.cc,
        page,
        viewport,
        base,
        scale: this.scale,
        pageNum,
        texts: textLayerResult?.texts || [],
      })
    } catch (err) {
      finish()
      console.error(`[pdf] render page ${pageNum} failed:`, err)
    }
  }

  /** 后台预渲染低清预览（每 5 页让出主线程） */
  async preloadLowRes(pageCount) {
    clearTimeout(this.lowResTimer)
    const run = async () => {
      for (let p = 1; p <= Math.min(pageCount, 300); p++) {
        if (this.lowResCache.has(p)) continue
        const canvas = await renderLowResPreview(this.opts.getPdf(), p, PREVIEW_SCALE)
        if (canvas) this.lowResCache.set(p, canvas)
        if (p % 5 === 0) await new Promise((r) => setTimeout(r, 0))
        if (this.destroyed) return
      }
    }
    this.lowResTimer = setTimeout(run, 60)
  }

  /** 跳转到页 */
  jumpToPage(pageNum) {
    const max = this.opts.getPageCount()
    const n = Math.min(max, Math.max(1, pageNum))
    this.currentPage = n
    this.opts.onActivePageChange?.(n)
    const p = (this.opts.getPages() || []).find((x) => x.pageNum === n)
    if (p?.cc) {
      p.cc.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  /** 容器尺寸变化（窗口缩放 / 侧栏开合）：fit 模式重算，否则重渲染文字层 */
  refresh() {
    if (this.fitMode === FIT_WIDTH) this.fitWidth()
    else if (this.fitMode === FIT_PAGE) this.fitPage()
    else this.renderVisible()
  }

  /** 容器宽度变化（侧栏/批注栏开合、窗口拖动等不触发 window resize 的情况）自动适配 */
  watchContainerSize() {
    const scrollEl = this.opts.scrollEl
    if (!scrollEl || this._resizeObserver) return
    if (typeof ResizeObserver === 'undefined') return
    this._resizeObserver = new ResizeObserver(() => {
      if (this.destroyed) return
      clearTimeout(this._resizeTimer)
      this._resizeTimer = setTimeout(() => {
        if (this.destroyed) return
        this.layoutStamp += 1 // 容器尺寸变化 → 页码偏移缓存作废
        if (this.fitMode === FIT_WIDTH) this.fitWidth()
        else if (this.fitMode === FIT_PAGE) this.fitPage()
        else this.renderVisible()
      }, 150)
    })
    this._resizeObserver.observe(scrollEl)
  }

  /**
   * 等待容器宽度稳定后执行 fit（mount 时容器可能尚未布局完成，
   * fitWidth 用 0 宽度算出极小/极大 scale 导致页面超宽被截断）。
   * 最多等待数帧，宽度稳定后立即 fit。
   */
  fitWhenReady(attempts = 0) {
    if (this.destroyed) return
    const scrollEl = this.opts.scrollEl
    const w = scrollEl?.clientWidth || 0
    // 单页模式下车一到就绪就是「整页适配窗口」，不能又被 fitWidth 覆盖回适合宽度
    const initialFit = () => {
      if (this.viewMode === 'single') {
        this.fitMode = FIT_PAGE
        this.fitPage()
      } else {
        this.fitWidth()
      }
    }
    if ((w > 0 && attempts > 0) || attempts >= 10) {
      initialFit()
      this.renderVisible()
      return
    }
    clearTimeout(this._fitReadyTimer)
    this._fitReadyTimer = setTimeout(() => this.fitWhenReady(attempts + 1), 60)
  }

  /** 销毁：断开观察者、清理定时器、取消在途渲染与缓存 */
  destroy() {
    this.destroyed = true
    if (this.observer) this.observer.disconnect()
    this.observer = null
    if (this._resizeObserver) {
      this._resizeObserver.disconnect()
      this._resizeObserver = null
    }
    clearTimeout(this._resizeTimer)
    clearTimeout(this._fitReadyTimer)
    if (this._onScroll && this.opts.scrollEl) {
      this.opts.scrollEl.removeEventListener('scroll', this._onScroll)
      this._onScroll = null
    }
    clearTimeout(this.rerenderTimer)
    clearTimeout(this.lowResTimer)
    for (const task of this.renderTasks.values()) {
      try {
        task.cancel()
      } catch {
        // 忽略
      }
    }
    this.renderTasks.clear()
    this.lowResCache.clear()
    this.baseDims.clear()
    this.rendered.clear()
    this.rendering.clear()
    this.pageSeq.clear()
  }
}
