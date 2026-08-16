// pdfRenderer.js — PDF 渲染层（套用 open-pdf-studio 的 renderer.js / text-layer.js / link-layer.js 逻辑）
//
// 关键设计：
// - HiDPI：canvas 后备缓冲 = 逻辑尺寸 × devicePixelRatio，CSS 尺寸 = 逻辑尺寸。
// - annotationMode: 0 —— PDF.js 不绘制注释，批注全部由应用自己的覆盖层绘制。
// - 分层：渲染画布 / 文字层(textLayer) / 链接层(linkLayer) / 批注覆盖层相互独立。
// - 文字层 CSS 变量 --scale-factor（pdfjs-dist v4）必须与画布实际缩放一致，
//   否则文字与画面错位。

import { TextLayer } from 'pdfjs-dist'
import { pdfjsLib } from './pdfEngine.js'

export function getCanvasDPR() {
  return window.devicePixelRatio || 1
}

/**
 * HiDPI 画布尺寸设置（open-pdf-studio setupCanvasHiDPI）。
 * @param {HTMLCanvasElement} canvas
 * @param {number} width  - 逻辑宽度（CSS px）
 * @param {number} height - 逻辑高度（CSS px）
 */
export function setupCanvasHiDPI(canvas, width, height) {
  const dpr = getCanvasDPR()
  canvas.width = Math.floor(width * dpr)
  canvas.height = Math.floor(height * dpr)
  canvas.style.width = Math.floor(width) + 'px'
  canvas.style.height = Math.floor(height) + 'px'
}

/**
 * 开始渲染单页（不等待完成，返回 RenderTask 供调用方取消/等待）。
 * annotationMode: 0 —— 注释由应用自己画。
 *
 * HiDPI 处理（关键，与官方 pdf.js viewer 一致）：
 * - canvas buffer = viewport.width × dpr（物理像素），CSS 尺寸 = viewport.width
 * - ctx 保持单位变换，把 dpr 通过 render 的 transform 参数传入。
 *   不要在此 ctx.setTransform(dpr)：pdf.js 渲染内部会叠加 viewport.transform，
 *   预先 setTransform(dpr) 会导致最终缩放 = dpr × scale（双重放大），
 *   在 DPR≠1（Windows 125%/150% 缩放）时 canvas 与文字层 span 错位约一行。
 * @returns {Promise<{task: object, viewport: object, page: object}>}
 */
export async function startPageRender(pdf, pageNum, canvas, scale) {
  const page = await pdf.getPage(pageNum)
  const viewport = page.getViewport({ scale })
  setupCanvasHiDPI(canvas, viewport.width, viewport.height)
  const ctx = canvas.getContext('2d')
  const dpr = getCanvasDPR()
  // 单位变换 + transform 参数携带 dpr（官方 OutputScale 方案）
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, viewport.width * dpr, viewport.height * dpr)
  const task = page.render({
    canvasContext: ctx,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    annotationMode: 0, // PDF.js 不绘制注释，应用自己画
  })
  return { task, viewport, page }
}

/**
 * 渲染单页到画布并等待完成（简单场景：缩略图/单页渲染）。
 * @param {object} pdf - PDF.js 文档
 * @param {number} pageNum - 1-based 页码
 * @param {HTMLCanvasElement} canvas
 * @param {number} scale - 缩放系数
 * @returns {Promise<{viewport: object, page: object}>}
 */
export async function renderPageToCanvas(pdf, pageNum, canvas, scale) {
  const { task, viewport, page } = await startPageRender(pdf, pageNum, canvas, scale)
  await task.promise
  return { viewport, page }
}

/**
 * 渲染低清预览到离屏画布（连续滚动时先展示，全清渲染后替换）。
 * @returns {Promise<HTMLCanvasElement|null>}
 */
export async function renderLowResPreview(pdf, pageNum, scale = 0.5) {
  try {
    const page = await pdf.getPage(pageNum)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport, annotationMode: 0 }).promise
    return canvas
  } catch {
    return null
  }
}

/**
 * 创建文字层（open-pdf-studio createTextLayer）。
 * 直接把传入的 container 当作文字层容器（调用方负责定位样式），
 * 设置 --scale-factor / --total-scale-factor，再用 PDF.js TextLayer
 * 生成绝对定位的透明 span，保证文字可选中、可编辑且与画布精确对齐。
 * @param {object} page - PDF.js 页面对象
 * @param {object} viewport - PDF.js viewport（当前缩放）
 * @param {HTMLElement} container - 文字层容器（class 含 textLayer）
 * @param {number} pageNum
 * @param {(span, index) => void} [onSpanReady] - 每个 span 生成后的回调
 * @returns {Promise<{layer, divs, texts, element}>}
 */
export async function renderTextLayer(page, viewport, container, pageNum, onSpanReady) {
  container.style.setProperty('--scale-factor', String(viewport.scale))
  container.style.setProperty('--total-scale-factor', String(viewport.scale))
  container.style.width = `${viewport.width}px`
  container.style.height = `${viewport.height}px`
  container.classList.add('textLayer')

  let layer
  try {
    layer = new TextLayer({
      textContentSource: page.streamTextContent({
        includeMarkedContent: true,
        disableNormalization: true,
      }),
      container,
      viewport,
    })
    await layer.render()
  } catch (err) {
    // 文字层失败不影响页面渲染，保留空层
    console.warn(`[pdf] text layer page ${pageNum} failed:`, err)
    return { layer: null, divs: [], texts: [], element: container }
  }

  const divs = layer.textDivs || []
  const texts = layer.textContentItemsStr || []
  divs.forEach((div, idx) => {
    div.dataset.page = String(pageNum)
    div.dataset.idx = String(idx)
    onSpanReady?.(div, idx, texts[idx])
  })
  return { layer, divs, texts, element: container }
}

/**
 * 创建链接层（open-pdf-studio createLinkLayer）。
 * 把 PDF 的 Link 注释转成可点击的覆盖元素：外部 URL 用 window.open，
 * 内部跳转交给 onNavigate(pageNum)。
 * @param {object} page - PDF.js 页面对象
 * @param {object} viewport
 * @param {HTMLElement} container
 * @param {number} pageNum
 * @param {(pageNum: number) => void} [onNavigate] - 内部链接跳转回调
 * @returns {Promise<HTMLElement|null>}
 */
export async function renderLinkLayer(page, viewport, container, pageNum, onNavigate) {
  let annotations
  try {
    annotations = await page.getAnnotations({ intent: 'display' })
  } catch {
    annotations = []
  }
  const linkAnnotations = annotations.filter((a) => a.subtype === 'Link')
  if (linkAnnotations.length === 0) return null

  const layer = document.createElement('div')
  layer.className = 'linkLayer'
  layer.dataset.page = pageNum
  layer.style.width = `${viewport.width}px`
  layer.style.height = `${viewport.height}px`

  for (const ann of linkAnnotations) {
    if (!ann.rect || ann.rect.length < 4) continue
    const rect = viewport.convertToViewportRectangle(ann.rect)
    const left = Math.min(rect[0], rect[2])
    const top = Math.min(rect[1], rect[3])
    const width = Math.abs(rect[2] - rect[0])
    const height = Math.abs(rect[3] - rect[1])

    const el = document.createElement('a')
    el.className = 'pdf-link'
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    el.style.width = `${width}px`
    el.style.height = `${height}px`
    el.style.pointerEvents = 'auto'
    el.style.cursor = 'pointer'

    const url = ann.url || ann.action?.uri
    if (url) {
      el.title = url
      el.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        window.open(url, '_blank', 'noopener')
      })
      layer.appendChild(el)
    } else if (ann.dest || ann.action?.dest) {
      const dest = ann.dest || ann.action.dest
      el.href = '#'
      el.title = '跳转到链接页面'
      el.addEventListener('click', async (e) => {
        e.preventDefault()
        e.stopPropagation()
        const pageNumTarget = await resolveDestination(page, dest)
        if (pageNumTarget != null) onNavigate?.(pageNumTarget)
      })
      layer.appendChild(el)
    }
  }

  if (layer.childElementCount === 0) return null
  container.appendChild(layer)
  return layer
}

/**
 * 解析 PDF 内部跳转目标为 1-based 页码（open-pdf-studio handleInternalLink）。
 * @param {object} page - 当前页面对象（用于取 pdfDocument）
 * @param {string|Array} dest
 * @returns {Promise<number|null>}
 */
async function resolveDestination(page, dest) {
  try {
    const pdf = page.pdfDocument
    if (!pdf) return null
    let ref
    if (typeof dest === 'string') {
      const destination = await pdf.getDestination(dest)
      if (destination) ref = destination[0]
    } else if (Array.isArray(dest)) {
      ref = dest[0]
    }
    if (ref == null) return null
    if (typeof ref === 'number') return ref + 1
    if (typeof ref === 'object' && ref !== null) {
      const index = await pdf.getPageIndex(ref)
      if (index != null) return index + 1
    }
    return null
  } catch {
    return null
  }
}
