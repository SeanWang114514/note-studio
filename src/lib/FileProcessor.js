import mammoth from 'mammoth'
import { marked } from 'marked'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  HeadingLevel,
  AlignmentType,
} from 'docx'
import { openPdf as engineOpenPdf, getOriginalBytes, setOriginalBytes } from './pdf/pdfEngine.js'
import { renderPageToCanvas, renderTextLayer } from './pdf/pdfRenderer.js'
import { writeAnnotationsToPdf, loadPdfAnnotationsFromBytes } from './pdf/pdfSaver.js'

export const FILE_TYPES = {
  PDF: 'pdf',
  DOCX: 'docx',
  MARKDOWN: 'markdown',
  PPT: 'ppt',
  EXCEL: 'excel',
  EPUB: 'epub',
  CAJ: 'caj',
  UNKNOWN: 'unknown',
}

const EXT_TO_TYPE = {
  pdf: FILE_TYPES.PDF,
  docx: FILE_TYPES.DOCX,
  doc: FILE_TYPES.DOCX,
  md: FILE_TYPES.MARKDOWN,
  markdown: FILE_TYPES.MARKDOWN,
  mdx: FILE_TYPES.MARKDOWN,
  txt: FILE_TYPES.MARKDOWN,
  ppt: FILE_TYPES.PPT,
  pptx: FILE_TYPES.PPT,
  xls: FILE_TYPES.EXCEL,
  xlsx: FILE_TYPES.EXCEL,
  epub: FILE_TYPES.EPUB,
  caj: FILE_TYPES.CAJ,
}

const RECENT_KEY = 'noteflow.recent.v1'
const DB_NAME = 'noteflow-store'
const DB_VERSION = 2
const HANDLE_STORE = 'handles'
const ANNOT_DATA_STORE = 'ann-data'

// 批注内嵌进 zip 容器（docx/epub/pptx/xlsx）的隐藏条目
const EMBED_ENTRY = 'noteflow/annotations.json'
const EMBED_CT = 'application/json'

export function detectType(name) {
  const ext = (name.split('.').pop() || '').toLowerCase()
  return EXT_TO_TYPE[ext] || FILE_TYPES.UNKNOWN
}

export async function pickFiles() {
  if (!('showOpenFilePicker' in window)) {
    throw new Error('当前浏览器不支持文件选择，请使用最新版 Chrome 或 Edge')
  }
  const handles = await window.showOpenFilePicker({
    multiple: true,
    excludeAcceptAllOption: false,
    types: [
      {
        description: '支持的文档',
        accept: {
          'application/pdf': ['.pdf'],
          'application/msword': ['.doc'],
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
          'text/markdown': ['.md', '.markdown'],
          'text/plain': ['.txt', '.md'],
          'application/vnd.ms-powerpoint': ['.ppt'],
          'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
          'application/vnd.ms-excel': ['.xls'],
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
          'application/epub+zip': ['.epub'],
        },
      },
    ],
  })
  const entries = []
  for (const handle of handles) {
    const file = await handle.getFile()
    entries.push({
      id: `file-${file.name}-${file.size}-${file.lastModified}`,
      name: file.name,
      kind: 'file',
      type: detectType(file.name),
      size: file.size,
      lastModified: file.lastModified,
      handle,
      file,
    })
  }
  return entries
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(HANDLE_STORE)) {
        req.result.createObjectStore(HANDLE_STORE, { keyPath: 'key' })
      }
      if (!req.result.objectStoreNames.contains(ANNOT_DATA_STORE)) {
        req.result.createObjectStore(ANNOT_DATA_STORE, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbRequest(storeName, mode, fn) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode)
    const store = tx.objectStore(storeName)
    const req = fn(store)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function putFileHandle(entry) {
  await idbRequest(HANDLE_STORE, 'readwrite', (s) =>
    s.put({ key: `file:${entry.id}`, handle: entry.handle }),
  )
}

export async function getFileHandle(id) {
  const row = await idbRequest(HANDLE_STORE, 'readonly', (s) => s.get(`file:${id}`))
  return row?.handle
}

export async function putAnnotationHandle(id, handle) {
  await idbRequest(HANDLE_STORE, 'readwrite', (s) =>
    s.put({ key: `ann:${id}`, handle }),
  )
}

export async function getAnnotationHandle(id) {
  const row = await idbRequest(HANDLE_STORE, 'readonly', (s) => s.get(`ann:${id}`))
  return row?.handle
}

export async function ensurePermission(handle, mode = 'readwrite') {
  try {
    if (!handle || typeof handle.queryPermission !== 'function') return false
    if ((await handle.queryPermission({ mode })) === 'granted') return true
    if (typeof handle.requestPermission === 'function') {
      return (await handle.requestPermission({ mode })) === 'granted'
    }
    return false
  } catch {
    return false
  }
}

export async function readText(file) {
  return file.text()
}

export async function saveTextFile(entry, content) {
  if (!(await ensurePermission(entry.handle))) {
    throw new Error('文件权限已失效，请重新打开文件后再保存')
  }
  const writable = await entry.handle.createWritable()
  await writable.write(content)
  await writable.close()
}

/** 通用：把字节写回原文件句柄（docx/epub 等编辑保存回用） */
export async function saveFileBytes(entry, bytes) {
  if (!(await ensurePermission(entry.handle, 'readwrite'))) {
    throw new Error('文件写入权限已失效，请重新打开文件后再保存')
  }
  const writable = await entry.handle.createWritable()
  await writable.write(bytes)
  await writable.close()
}

// ─── docx 编辑保存回（编辑后 HTML → .docx）──────────────────

/** HTML → docx 段落转换（保留标题/段落/列表/加粗/斜体/下划线/颜色/内嵌图片） */
export async function buildDocxFromHtml(html) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html || '', 'text/html')
  const children = []

  // 预读内嵌图片真实尺寸（data URL → Image），供 ImageRun 使用，避免比例失真
  const imgSizes = new Map()
  await Promise.all(
    [...doc.querySelectorAll('img')].map(
      (img) =>
        new Promise((resolve) => {
          const src = img.getAttribute('src') || ''
          if (!/^data:image\//i.test(src)) return resolve()
          const im = new Image()
          im.onload = () => {
            imgSizes.set(img, { w: im.naturalWidth, h: im.naturalHeight })
            resolve()
          }
          im.onerror = () => resolve()
          im.src = src
        }),
    ),
  )

  // 递归收集块级元素 → Paragraph
  const collectBlocks = (root) => {
    const out = []
    for (const el of root.children) {
      if (!el) continue
      const tag = el.tagName.toLowerCase()
      const runs = []
      const effectiveFormat = (textNode) => {
        let bold = false, italics = false, underline = false, color = null
        let node = textNode.parentNode
        while (node && node !== el) {
          const t = node.tagName.toLowerCase()
          if (t === 'strong' || t === 'b') bold = true
          if (t === 'em' || t === 'i') italics = true
          if (t === 'u' || t === 'ins') underline = true
          const style = node.getAttribute && node.getAttribute('style') || ''
          const m = /color:\s*(#[0-9a-fA-F]{3,8})/.exec(style)
          if (m) color = m[1]
          node = node.parentNode
        }
        return { bold, italics, underline, color }
      }
      const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          if (node.textContent) {
            runs.push(new TextRun({ text: node.textContent, ...effectiveFormat(node) }))
          }
          return
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return
        const ntag = node.tagName.toLowerCase()
        if (ntag === 'br') {
          runs.push(new TextRun({ break: 1 }))
          return
        }
        if (ntag === 'img') {
          // 内嵌图片（mammoth 渲染的 data URL）→ docx ImageRun，保留图片不再丢失
          const src = node.getAttribute('src') || ''
          const m = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,([A-Za-z0-9+/=]+)$/i.exec(src)
          if (m) {
            try {
              const type = m[1].toLowerCase().replace('jpeg', 'jpg')
              const bin = atob(m[2])
              const data = new Uint8Array(bin.length)
              for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i)
              const sz = imgSizes.get(node)
              const w = sz?.w || parseInt(node.getAttribute('width'), 10) || 300
              const h = sz?.h || parseInt(node.getAttribute('height'), 10) || 200
              runs.push(new ImageRun({ type, data, transformation: { width: w, height: h } }))
            } catch {
              // 图片解码失败则跳过该图
            }
          }
          return
        }
        for (const c of node.childNodes) walk(c)
      }
      walk(el)
      if (tag === 'h1') out.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: runs }))
      else if (tag === 'h2') out.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: runs }))
      else if (tag === 'h3') out.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: runs }))
      else if (tag === 'li') out.push(new Paragraph({ bullet: { level: 0 }, children: runs }))
      else if (tag === 'blockquote') out.push(new Paragraph({ children: runs, indent: { left: 720 } }))
      else if (tag === 'hr') out.push(new Paragraph({ text: '————————————', alignment: AlignmentType.CENTER }))
      else if (tag === 'ul' || tag === 'ol') out.push(...collectBlocks(el))
      else if (tag === 'table') out.push(new Paragraph({ children: [new TextRun('[表格内容以纯文本显示]')] }))
      else out.push(new Paragraph({ children: runs }))
    }
    return out
  }

  for (const p of collectBlocks(doc.body)) children.push(p)
  if (!children.length) children.push(new Paragraph({ text: '' }))

  const pdfDoc = new Document({ sections: [{ children }] })
  const blob = await Packer.toBlob(pdfDoc)
  return new Uint8Array(await blob.arrayBuffer())
}

// ─── epub 编辑保存回（zip 内 HTML 重打包）───────────────────

/** 解 epub：取第一个正文 HTML 文件 */
export async function readEpubHtml(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  const names = Object.keys(zip.files).filter(
    (n) => /\.(xhtml|html)$/i.test(n) && !/toc|nav/i.test(n) && !zip.files[n].dir,
  )
  names.sort()
  const path = names[0]
  if (!path) throw new Error('EPUB 中未找到正文 HTML')
  const html = await zip.files[path].async('string')
  return { path, html }
}

/** 把编辑后的 HTML 写回 epub（zip 重打包，基于文件最新字节，避免覆盖批注内嵌/上次编辑） */
export async function saveEpubFromHtml(entry, path, html) {
  const zip = await JSZip.loadAsync(await readEntryBytes(entry))
  zip.file(path, html)
  const blob = await generateEpubZip(zip)
  await saveFileBytes(entry, new Uint8Array(await blob.arrayBuffer()))
}

// ─── epub 全书读写（多文件合并显示 + 逐文件保存回）───────────────────
// 真实电子书把整本书拆成几十上百个 xhtml；旧 readEpubHtml 只渲染第一个文件。
// 这里按 spine 阅读顺序合并全部正文为一段可编辑 HTML，章间用
// <hr class="nf-epub-split" data-nf-epub="路径"> 标记分隔；保存时按标记把
// 编辑后的 DOM 拆回各章，逐文件写回（保留每章原有 head/命名空间）。

const EPUB_MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
}

export function resolveZipPath(baseDir, rel) {
  const segs = (baseDir + rel).split('/')
  const out = []
  for (const s of segs) {
    if (!s || s === '.') continue
    if (s === '..') {
      out.pop()
      continue
    }
    out.push(s)
  }
  try {
    return decodeURIComponent(out.join('/'))
  } catch {
    return out.join('/')
  }
}

// 把相对资源引用解析为 zip 内路径（参考 foliate-js 的 resolveURL/decodeURIPath）：
// - 外部引用（data:/http:/blob:/cid:/file:/#锚点）返回 null
// - 剥离 fragment、解码 HTML 实体
// - zip.file 区分大小写，部分书引用与条目大小写不一致，做一次不区分大小写兜底
function resolveAssetPath(zip, dir, ref) {
  if (!ref) return null
  const r = ref.trim().split('#')[0].replace(/&amp;/g, '&')
  if (!r || /^(data:|https?:|blob:|cid:|file:|#)/i.test(r)) return null
  const p = resolveZipPath(dir, r)
  if (!p) return null
  const f = zip.file(p)
  if (f && !f.dir) return p
  const lower = p.toLowerCase()
  for (const n of Object.keys(zip.files)) {
    if (!zip.files[n].dir && n.toLowerCase() === lower) return n
  }
  return null
}

/** 读 epub 全书：按 spine 顺序合并所有正文 HTML（图片保留原始 src，渲染后惰性换 Blob URL），返回可编辑整书 */
export async function readEpubBook(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer())

  // 阅读顺序：container.xml → OPF → spine(itemref) → manifest(href)；取不到则按文件名排序
  let order = []
  let baseDir = ''
  try {
    const container = zip.file('META-INF/container.xml')
    if (container) {
      const c = await container.async('string')
      const opfRel = (c.match(/full-path="([^"]+)"/) || [])[1]
      if (opfRel) {
        baseDir = opfRel.replace(/[^/]*$/, '')
        const opfFile = zip.file(opfRel)
        if (opfFile) {
          const opf = await opfFile.async('string')
          const idrefs = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => m[1])
          const manifest = {}
          // 属性顺序不固定（href 可能在 id 前），逐标签分别提取
          for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
            const tag = m[0]
            const id = (tag.match(/\bid="([^"]+)"/) || [])[1]
            const href = (tag.match(/\bhref="([^"]+)"/) || [])[1]
            if (id && href) manifest[id] = href
          }
          order = idrefs
            .map((id) => manifest[id])
            .filter(Boolean)
            .filter((p) => !/toc|nav|ncx/i.test(p)) // 目录/导航页不渲染
            .map((p) => resolveZipPath(baseDir, p))
        }
      }
    }
  } catch {
    // 无 container/opf 时回退
  }
  if (!order.length) {
    order = Object.keys(zip.files)
      .filter(
        (n) =>
          /\.(xhtml|html)$/i.test(n) &&
          !/toc|nav|ncx/i.test(n) &&
          !zip.files[n].dir,
      )
      .sort()
  }

  const items = []
  const seen = new Set()
  for (const path of order) {
    if (seen.has(path)) continue
    seen.add(path)
    if (!/\.(xhtml|html)$/i.test(path)) continue // 只处理正文 html（防混入图片等）
    const f = zip.file(path)
    if (!f || f.dir) continue
    const raw = await f.async('string')
    // 拆出 body 与外围（head/命名空间等保存时原样写回；保留 <body ...> 与 </body> 标签，
    // 否则保存后的 xhtml 缺 body 标签，严格阅读器会解析失败）
    const bodyMatch = raw.match(/(<body[^>]*>)([\s\S]*?)(<\/body>)/i)
    let before = raw
    let after = ''
    let body = raw
    if (bodyMatch) {
      before = raw.slice(0, bodyMatch.index) + bodyMatch[1]
      body = bodyMatch[2]
      after = bodyMatch[3] + raw.slice(bodyMatch.index + bodyMatch[0].length)
    }
    items.push({ path, before, after, body })
  }
  if (!items.length) throw new Error('EPUB 中未找到正文 HTML')

  // 收集唯一资源引用（不读取字节）：渲染后惰性换 Blob URL，避免大书 HTML 膨胀/加载卡死。
  // 覆盖 img / svg <image>(xlink:href|href|src) / srcset / 内联 style url() / <style> url()；
  // 按「解析后的 zip 路径」去重（同路径不同章引用同一文件；同引用不同章目录则各自解析，
  // 参考 foliate-js：相对路径必须相对所在章解析）。
  const imageSrcs = new Map() // 解析后的 zip 路径 → mime
  const addAsset = (p) => {
    if (!p || imageSrcs.has(p)) return
    const ext = (p.split('.').pop() || '').toLowerCase()
    imageSrcs.set(p, EPUB_MIME[ext] || 'application/octet-stream')
  }
  for (const it of items) {
    const dir = it.path.replace(/[^/]*$/, '')
    // <img src>
    for (const m of it.body.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
      addAsset(resolveAssetPath(zip, dir, m[1]))
    }
    // svg <image xlink:href|href|src>
    for (const m of it.body.matchAll(/<(?:svg:)?image\b[^>]*>/gi)) {
      const tag = m[0]
      const ref =
        (tag.match(/\bxlink:href\s*=\s*["']([^"']+)["']/i) || [])[1] ||
        (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1] ||
        (tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1]
      addAsset(ref ? resolveAssetPath(zip, dir, ref) : null)
    }
    // srcset（img / picture > source）
    for (const m of it.body.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
      for (const cand of m[1].split(',')) {
        const url = (cand.trim().match(/^(\S+)/) || [])[1]
        addAsset(url ? resolveAssetPath(zip, dir, url) : null)
      }
    }
    // CSS url()（内联 style / <style>）
    for (const m of it.body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      addAsset(resolveAssetPath(zip, dir, m[1].trim()))
    }
  }
  const blobCache = new Map()
  const getImageBlob = async (path) => {
    if (blobCache.has(path)) return blobCache.get(path)
    const mime = imageSrcs.get(path)
    if (!mime) return null
    try {
      const u8 = await zip.file(path).async('uint8array')
      const blob = new Blob([u8], { type: mime })
      blobCache.set(path, blob)
      return blob
    } catch {
      return null
    }
  }

  const html = items
    .map(
      (it, i) =>
        (i
          ? `<hr class="nf-epub-split" data-nf-epub="${it.path.replace(/"/g, '&quot;')}">`
          : '') + it.body,
    )
    .join('')
  return { html, files: items, count: items.length, imageSrcs, getImageBlob }
}

/** 按章间 hr 标记把编辑后的 DOM 拆回各章内容（顺序与 files 对应） */
function splitEpubBody(root) {
  const parts = []
  let cur = ''
  for (const child of root.childNodes) {
    if (child.nodeType === 1 && child.classList && child.classList.contains('nf-epub-split')) {
      parts.push(cur)
      cur = ''
    } else {
      cur += child.nodeType === 1 ? child.outerHTML : child.textContent || ''
    }
  }
  parts.push(cur)
  return parts
}

/** 把编辑后的整书逐章写回 epub（zip 重打包，基于文件最新字节）。
 *  图片还原由调用方负责（保存前已把显示用 URL 换回原始相对路径）。 */
export async function saveEpubBook(entry, files, rootEl) {
  const parts = splitEpubBody(rootEl)
  const zip = await JSZip.loadAsync(await readEntryBytes(entry))
  files.forEach((it, i) => {
    const body = parts[i] ?? ''
    zip.file(it.path, it.before + body + it.after)
  })
  const blob = await generateEpubZip(zip)
  await saveFileBytes(entry, new Uint8Array(await blob.arrayBuffer()))
}

/**
 * 生成 epub zip：JSZip generateAsync 默认 STORE（不压缩），必须显式 DEFLATE 防体积膨胀；
 * 且 EPUB 规范要求 mimetype 条目必须 STORE 且是第一个条目。
 */
async function generateEpubZip(zip) {
  const mt = zip.file('mimetype')
  if (mt) {
    const mtStr = await mt.async('string')
    zip.file('mimetype', mtStr, { compression: 'STORE' })
  }
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
  })
}

// ─── excel 表格渲染（SheetJS 只读）──────────────────────────

/** xlsx → 第一个工作表 HTML 表格 */
export async function renderExcelHtml(file) {
  const data = await file.arrayBuffer()
  const wb = XLSX.read(data, { type: 'array' })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const html = XLSX.utils.sheet_to_html(sheet, { id: 'sheet-table' })
  return { html, sheetNames: wb.SheetNames }
}

export function emptyAnnotations(fileName = '') {
  return {
    version: 1,
    file: fileName,
    updatedAt: null,
    pdf: [],
    docx: [],
    md: [],
    excel: [],
    epub: [],
    ppt: [],
    caj: [],
  }
}

export async function loadAnnotations(entry) {
  const empty = emptyAnnotations(entry.name)
  // 1) IndexedDB 缓存优先（批注统一存缓存，不再写回文件 → 不再触发浏览器“将能够修改文件”权限弹窗）
  try {
    const idb = await getAnnotationsData(entry.id)
    if (idb) return { ...empty, ...idb }
  } catch {
    // IndexedDB 不可用时继续尝试旧数据源
  }
  // 2) 兼容旧版：zip 容器（docx/epub/pptx/xlsx）内嵌批注（用打开时的 File 快照，不碰句柄，避免 OneDrive/云盘句柄挂起）
  if (isZipType(entry)) {
    try {
      const bytes = new Uint8Array(await entry.file.arrayBuffer())
      if (isZipBytes(bytes)) {
        const zip = await JSZip.loadAsync(bytes)
        const f = zip.file(EMBED_ENTRY)
        if (f) {
          const parsed = JSON.parse(await f.async('string'))
          return { ...empty, ...parsed }
        }
      }
    } catch {
      // 内嵌读取失败则继续尝试其它来源
    }
  }
  // 3) 兼容旧版磁盘旁车 .annotations.json（优先保留旧数据）
  try {
    const handle = await getAnnotationHandle(entry.id)
    if (handle) {
      try {
        if (await ensurePermission(handle)) {
          const file = await handle.getFile()
          const parsed = JSON.parse(await file.text())
          return { ...empty, ...parsed }
        }
      } catch {
        // 旧旁车不可读则忽略
      }
    }
  } catch {
    // IndexedDB 不可用时忽略旧旁车
  }
  return empty
}

export async function saveAnnotations(entry, annotations) {
  const data = { ...annotations, updatedAt: new Date().toISOString() }
  // 批注一律存 IndexedDB 缓存（含 docx/epub/xlsx 等 zip 类型），不再内嵌写回文件
  // → 不会触发浏览器“http://… 将能够修改 xxx”权限弹窗（修改已保存在缓存里）
  await putAnnotationsData(entry.id, data)
}

/** 备份（默认不调用）：把批注内嵌进 zip 文件本身并写回原句柄 —— 会触发浏览器文件写入权限弹窗 */
export async function saveAnnotationsEmbedded(entry, annotations) {
  const data = { ...annotations, updatedAt: new Date().toISOString() }
  if (isZipType(entry)) {
    const bytes = await readEntryBytes(entry)
    if (isZipBytes(bytes)) {
      const out = await embedAnnotationsInZip(bytes, data)
      await saveFileBytes(entry, out)
      return
    }
  }
  await putAnnotationsData(entry.id, data)
}

/** 仅 zip 容器扩展名（docx/epub/xlsx/pptx）——老格式 .doc/.xls/.ppt 不是 zip，走 IndexedDB */
function isZipType(entry) {
  return /\.(docx|epub|xlsx|pptx)$/i.test(entry?.name || '')
}

/** 取文件当前字节：优先原句柄（内容编辑保存回后 entry.file 会过期），失败退回 entry.file */
async function readEntryBytes(entry) {
  try {
    if (entry.handle && typeof entry.handle.getFile === 'function') {
      const fresh = await entry.handle.getFile()
      return new Uint8Array(await fresh.arrayBuffer())
    }
  } catch {
    // 句柄不可用则退回 entry.file
  }
  return new Uint8Array(await entry.file.arrayBuffer())
}

/** 判断字节是否为 zip 容器（PK 魔数） */
function isZipBytes(bytes) {
  return (
    bytes.length > 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  )
}

/**
 * 把批注 JSON 内嵌进 zip 容器：
 * 1) 写入 noteflow/annotations.json 隐藏条目
 * 2) OOXML（docx/xlsx/pptx）在 [Content_Types].xml 声明该 part，避免 Word/Excel/PowerPoint 报文件损坏
 * 3) EPUB 在 OPF manifest 声明该 item
 * 生成时保持 mimetype 等条目原样（默认 STORE 压缩，EPUB 兼容）
 */
async function embedAnnotationsInZip(bytes, data) {
  const zip = await JSZip.loadAsync(bytes)
  zip.file(EMBED_ENTRY, JSON.stringify(data, null, 2))

  const ct = zip.file('[Content_Types].xml')
  if (ct) {
    let xml = await ct.async('string')
    if (!xml.includes(`PartName="/${EMBED_ENTRY}"`)) {
      xml = xml.replace(
        '</Types>',
        `<Override PartName="/${EMBED_ENTRY}" ContentType="${EMBED_CT}"/></Types>`,
      )
      zip.file('[Content_Types].xml', xml)
    }
  }

  const opfName = Object.keys(zip.files).find((n) => /\.opf$/i.test(n))
  if (opfName) {
    let xml = await zip.files[opfName].async('string')
    if (!xml.includes(EMBED_ENTRY)) {
      xml = xml.replace(
        '</manifest>',
        `<item id="noteflow-annotations" href="${EMBED_ENTRY}" media-type="${EMBED_CT}"/></manifest>`,
      )
      zip.file(opfName, xml)
    }
  }

  // 默认 STORE 压缩：保留 mimetype 等条目的原始存储方式，EPUB/OOXML 均可正常打开
  return await zip.generateAsync({ type: 'uint8array' })
}

export async function putAnnotationsData(id, data) {
  await idbRequest(ANNOT_DATA_STORE, 'readwrite', (s) => s.put({ key: id, data }))
}

export async function getAnnotationsData(id) {
  const row = await idbRequest(ANNOT_DATA_STORE, 'readonly', (s) => s.get(id))
  return row?.data
}

/**
 * 把 PDF 批注真正写回 PDF 文件本身（open-pdf-studio saver.js 逻辑）。
 * 从 originalBytesCache 取原始字节作为唯一数据源 → pdf-lib 烧写批注 →
 * 写回原文件句柄 → 更新缓存为新字节。
 *
 * @param {object} entry - 文件条目（含 id / name / handle / file）
 * @param {object} pdfDoc - pdf.js 文档（坐标换算用）
 * @param {Array<object>} annotations - 待写回的批注（非 textEdit）
 * @returns {Promise<Uint8Array>} 写回后的新字节
 */
export async function savePdfBack(entry, pdfDoc, annotations) {
  let bytes = getOriginalBytes(entry.id)
  if (!bytes) {
    const buf = await entry.file.arrayBuffer()
    bytes = new Uint8Array(buf)
  }
  // .slice() 副本：避免 pdf-lib 解析时意外改动缓存字节
  const newBytes = await writeAnnotationsToPdf(pdfDoc, bytes.slice(), annotations)

  if (!(await ensurePermission(entry.handle, 'readwrite'))) {
    throw new Error('文件写入权限已失效，请重新打开文件后再保存')
  }
  const writable = await entry.handle.createWritable()
  await writable.write(newBytes)
  await writable.close()

  setOriginalBytes(entry.id, newBytes)
  return newBytes
}

/**
 * 从 PDF 文件读回本应用管理的注释（真实 /Annots → 应用批注模型）。
 * @param {object} entry - 文件条目
 * @param {object} pdfDoc - pdf.js 文档
 * @returns {Promise<Array<object>>}
 */
export async function loadPdfAnnotations(entry, pdfDoc) {
  let bytes = getOriginalBytes(entry.id)
  if (!bytes) {
    const buf = await entry.file.arrayBuffer()
    bytes = new Uint8Array(buf)
  }
  return loadPdfAnnotationsFromBytes(pdfDoc, bytes.slice(), pdfDoc.numPages)
}

export async function openPdf(file, key = null) {
  const { pdf } = await engineOpenPdf(file, key)
  return pdf
}

export async function renderPdfPage(pdf, pageNumber, canvas, scale = 1.5) {
  const { viewport } = await renderPageToCanvas(pdf, pageNumber, canvas, scale)
  return { width: viewport.width, height: viewport.height, pageNumber }
}

export async function renderPdfPages(pdf, canvases, scale = 1.5) {
  const results = []
  for (let i = 0; i < canvases.length; i++) {
    results.push(await renderPdfPage(pdf, i + 1, canvases[i], scale))
  }
  return results
}

export async function renderPdfTextLayer(page, container, viewport, cssScale) {
  const result = await renderTextLayer(page, viewport, container, 0)
  return { layer: result.layer, divs: result.divs, texts: result.texts }
}

export async function renderDocxHtml(file) {
  const arrayBuffer = await file.arrayBuffer()
  const result = await mammoth.convertToHtml({ arrayBuffer })
  return result.value || '<p>（无法解析该文档）</p>'
}

export function renderMarkdownHtml(text) {
  marked.setOptions({ gfm: true, breaks: true })
  return marked.parse(text || '')
}

export function getRecent() {
  try {
    return (JSON.parse(localStorage.getItem(RECENT_KEY)) || []).filter((item) => item.id)
  } catch {
    return []
  }
}

export function addRecent(entry) {
  const list = getRecent().filter((item) => item.id !== entry.id)
  const next = [
    {
      id: entry.id,
      name: entry.name,
      type: entry.type,
      size: entry.size,
      lastModified: entry.lastModified,
    },
    ...list,
  ].slice(0, 5)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // localStorage 不可用时忽略持久化
  }
  return next
}

export function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '未知'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function formatDate(ts) {
  if (!ts) return '未知时间'
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
