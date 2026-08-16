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
 * 打开 PDF 文档。
 * @param {File} file - 用户选择的文件
 * @param {string} [key] - 缓存键（entry.id），用于 originalBytesCache
 * @returns {Promise<{pdf: object, numPages: number}>}
 */
export async function openPdf(file, key = null) {
  const data = await file.arrayBuffer()
  const bytes = new Uint8Array(data)
  if (key) originalBytesCache.set(key, bytes.slice())

  // CRITICAL: 必须传 .slice() 副本 —— worker 会 detach 缓冲区
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
  return { pdf, numPages: pdf.numPages }
}

/**
 * 打开 PDF 文档（从缓存字节，例如恢复会话）。
 * @param {Uint8Array|ArrayBuffer} data
 * @param {string} [key]
 */
export async function openPdfFromBytes(data, key = null) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (key) originalBytesCache.set(key, bytes.slice())
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
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
