// pdfEngine.js — PDF 加载编排（套用 open-pdf-studio 的 loader.js 逻辑）
//
// 核心规则（来自 open-pdf-studio CLAUDE.md 的 Critical Rules）：
// 1. 传给 PDF.js 的字节必须 `.slice()` 副本 —— PDF.js 会把 ArrayBuffer 转移
//    给 worker，转移后原 Uint8Array 会被 detach（长度变 0），导致后续保存
//    静默失败。
// 2. originalBytesCache 持有原始 PDF 字节作为唯一数据源，后续若要接入
//    pdf-lib 写回（保存批注进 PDF）时从这里取字节，绝不重新读盘。
// 3. 每个 await 之后都要检查文档是否已关闭/切换（loadId 代数），防止旧
//    文档的异步渲染覆盖新文档。

import * as pdfjsLib from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'

pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker()

/** 原始字节缓存：entryId -> Uint8Array（唯一数据源，供未来 pdf-lib 写回） */
const originalBytesCache = new Map()

/** 文档级关闭标记，用于跨 await 的竞态防护 */
let loadSeq = 0

export function getOriginalBytes(key) {
  return originalBytesCache.get(key)
}

export function setOriginalBytes(key, bytes) {
  originalBytesCache.set(key, bytes.slice())
}

export function clearOriginalBytes(key) {
  originalBytesCache.delete(key)
}

export function clearAllOriginalBytes() {
  originalBytesCache.clear()
}

/**
 * pdf.js 的报错名 → 用户能看懂的中文。
 * 以前这里把 err.message 原样抛给界面，加密的 PDF 只会显示 pdf.js 的
 * 「No password given」，而界面还固定写着「请检查文件是否损坏」——
 * 明明是加密，却让人以为文件坏了，只能反复重开。
 */
export function describePdfError(err) {
  const name = err?.name || ''
  if (name === 'PasswordException') return '这个 PDF 有密码保护，需要密码才能打开'
  if (name === 'InvalidPDFException') return '文件不是有效的 PDF，或者已经损坏'
  if (name === 'MissingPDFException') return 'PDF 内容为空，找不到可读的页面数据'
  if (name === 'UnexpectedResponseException') return 'PDF 数据读取异常，请重新打开文件'
  return err?.message || '未知错误'
}

/**
 * 加密 PDF 的取密码回调（pdf.js 通过 onPassword 索要）。
 * 返回 null 表示用户取消 —— 注意取消的处理不在这里，见 openDocument 的说明。
 * @param {boolean} retry 是否是「密码不对，再来一次」
 */
function promptPdfPassword(retry) {
  if (typeof window === 'undefined' || typeof window.prompt !== 'function') return null
  const text = retry
    ? '密码不对，请重新输入这个 PDF 的打开密码：'
    : '这个 PDF 有密码保护，请输入打开密码：'
  return window.prompt(text)
}

/** getDocument 的公共参数 */
function pdfOpenParams(bytes) {
  return { data: bytes.slice() }
}

/**
 * 本会话里已经解锁过的加密 PDF：entry.id -> 密码。
 * 开发模式下 StrictMode 会把 effect 跑两遍（同一个文件被开两次），
 * 不记住密码的话，用户会被连问两次；点「重试」也会再问一次。
 */
const pdfPasswordCache = new Map()

/**
 * 统一的开文档入口，负责加密 PDF 的取密码。
 *
 * 坑 1（pdf.js 4.x）：`onPassword` 写在 getDocument 的参数里会被**静默忽略** ——
 * 不报错，直接抛 `PasswordException: No password given`。表现就是「有密码的 PDF
 * 永远打不开」，而界面还提示「请检查文件是否损坏」。必须挂在返回的 loadingTask 上。
 *
 * 坑 2：用户取消时**不能**回 `cb(null)`。pdf.js 收到 null 不会 reject，而是再要一次
 * 密码，于是密码框会没完没了地弹。取消得自己 `destroy()` 任务，此时 promise 会以
 * `PasswordException` 拒绝，正好落到我们要给的那句中文提示上。
 */
function openDocument(bytes, askPassword, cacheKey) {
  // 只建任务，不 await：重试时要能整段重来（onPassword 必须挂在新任务上）
  const start = () => {
    const task = pdfjsLib.getDocument(pdfOpenParams(bytes))
    if (!askPassword) return task.promise
    task.onPassword = (cb, reason) => {
      // reason: 1 = 需要密码，2 = 上次输错了（PasswordResponses）
      if (reason !== 2 && cacheKey) {
        const known = pdfPasswordCache.get(cacheKey)
        if (known) {
          cb(known)
          return
        }
      }
      if (reason === 2 && cacheKey) pdfPasswordCache.delete(cacheKey) // 记住的那个不对了
      const pwd = promptPdfPassword(reason === 2)
      if (pwd == null || pwd === '') {
        task.destroy()
        return
      }
      if (cacheKey) pdfPasswordCache.set(cacheKey, pwd)
      cb(pwd)
    }
    return task.promise
  }

  /**
   * 坑 3：销毁上一个文档（doc.destroy()）之后，pdf.js 的共享 worker 是**异步**重建的。
   * 紧接着再开一个文档就会撞上 `PDFWorker.fromPort - the worker is being destroyed`。
   * 这不是字节坏了 —— 等一拍重开就好。以前没有这层重试，上层（PdfEditorView）会把
   * 它当成「缓存字节坏了」，退回原始文件重读，于是刚新建的那一页（只存在于字节缓存里）
   * 被文件内容覆盖掉：现象是「新建一页 → 删除新建页 → 再新建一页，页数不涨」。
   */
  const workerGone = (err) => /worker is being destroyed/i.test(err?.message || '')
  const retryDelays = [120, 300, 700]
  // Promise.resolve().then(start)：getDocument 撞上「worker 正在销毁」时是**同步**抛的，
  // 直接 start().catch(...) 根本接不住（异常会同步冒出去，重试就成了摆设）。
  const attempt = (i) =>
    Promise.resolve()
      .then(start)
      .catch(async (err) => {
        if (!workerGone(err) || i >= retryDelays.length) throw err
        await new Promise((r) => setTimeout(r, retryDelays[i]))
        return attempt(i + 1)
      })
  return attempt(0)
}

/**
 * 打开 PDF 文档。
 * @param {File} file - 用户选择的文件
 * @param {string} [key] - 缓存键（entry.id），用于 originalBytesCache 与密码记忆
 * @param {{askPassword?: boolean}} [options] - askPassword: 加密时是否弹框要密码
 *   （缩略图那种后台渲染不要弹，传 false）
 * @returns {Promise<{pdf: object, numPages: number}>}
 */
export async function openPdf(file, key = null, options = {}) {
  const data = await file.arrayBuffer()
  const bytes = new Uint8Array(data)
  if (key) originalBytesCache.set(key, bytes.slice())

  // CRITICAL: 必须传 .slice() 副本 —— worker 会 detach 缓冲区
  const pdf = await openDocument(bytes, options.askPassword, key)
  return { pdf, numPages: pdf.numPages }
}

/**
 * 打开 PDF 文档（从缓存字节，例如恢复会话）。
 * @param {Uint8Array|ArrayBuffer} data
 * @param {string} [key]
 * @param {{askPassword?: boolean}} [options]
 */
export async function openPdfFromBytes(data, key = null, options = {}) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (key) originalBytesCache.set(key, bytes.slice())
  const pdf = await openDocument(bytes, options.askPassword, key)
  return { pdf, numPages: pdf.numPages }
}

/**
 * 取页面 scale=1 的基础尺寸与旋转（用于连续模式的即时缩放基准）。
 * @returns {Promise<{widthPt: number, heightPt: number, rotation: number}>}
 */
export async function getPageBaseDims(pdf, pageNum) {
  const page = await pdf.getPage(pageNum)
  const vp = page.getViewport({ scale: 1 })
  return { widthPt: vp.width, heightPt: vp.height, rotation: page.rotate || 0 }
}

/**
 * 取页面 CropBox（可见区域，PDF 坐标，原点左下）。
 * @returns {Promise<{x: number, y: number, width: number, height: number}>}
 */
export async function getPageCropBox(pdf, pageNum) {
  const page = await pdf.getPage(pageNum)
  const [x, y, w, h] = page.view
  return { x, y, width: w - x, height: h - y }
}

/**
 * 关闭文档并清理缓存。
 */
export function closePdf(key = null) {
  loadSeq += 1
  if (key) clearOriginalBytes(key)
}

/** 当前加载代数（供组件检测异步竞态） */
export function nextLoadSeq() {
  loadSeq += 1
  return loadSeq
}

export function currentLoadSeq() {
  return loadSeq
}

// ─── 坐标系统转换（套用 open-pdf-studio 的三套坐标系统逻辑）───
// 三套坐标：PDF 坐标（原点左下、point）、视口坐标（原点左上、缩放后 CSS px）、
// 应用批注坐标（原点左上、归一化 0~1）。归一化坐标与缩放无关，也便于未来
// 写回 PDF（pdfY = cropBox.y + cropBox.height - appY）。

/** 归一化(0~1) -> 视口坐标 */
export function normToViewport(nx, ny, vw, vh) {
  return { x: nx * vw, y: ny * vh }
}

/** 视口坐标 -> 归一化(0~1) */
export function viewportToNorm(x, y, vw, vh) {
  if (!vw || !vh) return { x: 0, y: 0 }
  return { x: Math.min(1, Math.max(0, x / vw)), y: Math.min(1, Math.max(0, y / vh)) }
}

/**
 * 归一化坐标 -> PDF 坐标（原点左下，基于 CropBox）。
 * @param {number} nx - 0~1
 * @param {number} ny - 0~1
 * @param {{x:number,y:number,width:number,height:number}} cropBox
 */
export function normToPdf(nx, ny, cropBox) {
  const px = cropBox.x + nx * cropBox.width
  // Y 轴翻转：应用左上原点 -> PDF 左下原点
  const py = cropBox.y + cropBox.height - ny * cropBox.height
  return { x: px, y: py }
}

/**
 * PDF 坐标 -> 归一化坐标（基于 CropBox）。
 */
export function pdfToNorm(px, py, cropBox) {
  const nx = (px - cropBox.x) / cropBox.width
  const ny = 1 - (py - cropBox.y) / cropBox.height
  return {
    x: Math.min(1, Math.max(0, nx)),
    y: Math.min(1, Math.max(0, ny)),
  }
}

/** 把 PDF.js viewport 的矩形（CSS px，左上原点）转成归一化矩形 */
export function viewportRectToNorm(x0, y0, x1, y1, vw, vh) {
  const a = viewportToNorm(Math.min(x0, x1), Math.min(y0, y1), vw, vh)
  const b = viewportToNorm(Math.max(x0, x1), Math.max(y0, y1), vw, vh)
  return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y }
}

export { pdfjsLib }
