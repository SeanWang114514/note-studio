// pdfTextExtract.js — PDF 文字视图：把 PDF 提取为 Markdown 文字 + 内嵌图片
//
// 用途：替代原来的「页面图像渲染」。打开 PDF 后逐页提取：
// - 文字：page.getTextContent()（带位置/字号），按基线分组为行、
//   按行距分组为段落，按字号相对正文中位数识别标题（#/##/###）。
// - 图片：page.getOperatorList() 里找 paintImageXObject /
//   paintInlineImageXObject / paintImageXObjectRepeat / paintInlineImageXObjectGroup，
//   通过 page.objs 拿位图转 data URL；用算子流里的 CTM 追踪图片位置，
//   与文字行按 Y 坐标合并排序，得到「图片直接贴在上面」的自然阅读流。
// - 输出 markdown：标题/段落/图片，页与页之间用 --- 分隔。
//
// 依赖 pdfEngine.js 提供的 pdfjsLib（含 worker）。

import { pdfjsLib } from './pdfEngine.js'

const OPS = pdfjsLib.OPS

/** 判断字符是否 CJK（中日韩统一表意文字等） */
function isCJK(ch) {
  return /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/.test(ch)
}

/** 2D 仿射矩阵乘法（6 元组 [a,b,c,d,e,f]），返回 m1 ∘ m2 */
function mulMatrix(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a2, b2, c2, d2, e2, f2] = m2
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ]
}

/**
 * 文本项 → 行。
 * @param {Array} items - page.getTextContent().items
 * @param {object} viewport - page.getViewport({scale:1})
 * @returns {Array<{y:number,size:number,text:string}>} 按阅读顺序排列
 */
function itemsToLines(items, viewport) {
  const mapped = []
  for (const it of items) {
    const str = String(it.str || '').replace(/\u00a0/g, ' ')
    if (!str.trim()) continue
    const [x, y] = viewport.convertToViewportPoint(it.transform[4], it.transform[5])
    const size = Math.abs(it.transform[3]) || it.height || 10
    mapped.push({
      str,
      x,
      y,
      size,
      width: it.width != null ? it.width : str.length * size * 0.5,
    })
  }
  mapped.sort((a, b) => a.y - b.y || a.x - b.x)

  const lines = []
  for (const m of mapped) {
    const last = lines[lines.length - 1]
    const tol = last ? Math.max(2, last.size * 0.5) : 0
    if (last && Math.abs(m.y - last.y) <= tol) {
      last.items.push(m)
      last.size = Math.max(last.size, m.size)
    } else {
      lines.push({ y: m.y, size: m.size, items: [m] })
    }
  }

  const out = []
  for (const ln of lines) {
    ln.items.sort((a, b) => a.x - b.x)
    let text = ''
    let prevRight = null
    for (const m of ln.items) {
      if (prevRight != null) {
        const gap = m.x - prevRight
        const needSpace = gap > m.size * 0.25
        const cjkGap = isCJK(m.str[0]) && isCJK(text[text.length - 1])
        if (needSpace && !cjkGap) text += ' '
      }
      text += m.str
      prevRight = m.x + m.width
    }
    text = text.replace(/\s+/g, ' ').trim()
    if (text) out.push({ y: ln.y, size: ln.size, text })
  }
  return out
}

/** 把位图数据转成 data URL（RGBA/RGB/Grayscale1bpp/JPEG） */
async function imageToDataUrl(img) {
  try {
    if (!img || !img.width || !img.height) return null
    const { width, height } = img
    if (width * height > 4096 * 4096) return null // 超大图跳过，避免卡顿

    // JPEG：data 是原始 JPEG 字节（ArrayBuffer）
    if (img.data instanceof ArrayBuffer) {
      const u8 = new Uint8Array(img.data)
      if (u8.length > 4 && u8[0] === 0xff && u8[1] === 0xd8) {
        const blob = new Blob([u8], { type: 'image/jpeg' })
        return await new Promise((resolve) => {
          const fr = new FileReader()
          fr.onload = () => resolve(fr.result)
          fr.onerror = () => resolve(null)
          fr.readAsDataURL(blob)
        })
      }
    }

    const kind = img.kind ?? 2 // 默认 RGB
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (img.bitmap) {
      ctx.drawImage(img.bitmap, 0, 0)
      return canvas.toDataURL('image/png')
    }
    const src = img.data
    if (!src) return null
    const imageData = ctx.createImageData(width, height)
    const px = imageData.data
    if (kind === 3) {
      // RGBA_32BPP
      px.set(src.subarray(0, width * height * 4))
    } else if (kind === 2) {
      // RGB_24BPP
      for (let i = 0, j = 0; i < width * height * 4; i += 4, j += 3) {
        px[i] = src[j]
        px[i + 1] = src[j + 1]
        px[i + 2] = src[j + 2]
        px[i + 3] = 255
      }
    } else if (kind === 1) {
      // GRAYSCALE_1BPP（每像素 1 bit）
      for (let p = 0; p < width * height; p++) {
        const byte = src[p >> 3]
        const bit = 7 - (p & 7)
        const v = (byte >> bit) & 1 ? 255 : 0
        px[p * 4] = v
        px[p * 4 + 1] = v
        px[p * 4 + 2] = v
        px[p * 4 + 3] = 255
      }
    } else {
      return null
    }
    ctx.putImageData(imageData, 0, 0)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

/**
 * 提取单页图片（带 Y 位置，用于与文字行合并排序）。
 * 通过算子流追踪 CTM（save/restore/transform/translate/rotate/scale），
 * 在 paint 图片类算子处取 CTM 平移量 e,f（PDF 用户空间，原点左下）
 * 转成视口坐标（原点左上）得到 y。
 */
async function extractPageImages(page, viewport) {
  let opList
  try {
    opList = await page.getOperatorList()
  } catch {
    return []
  }
  const fnArray = opList.fnArray || []
  const argsArray = opList.argsArray || []
  const out = []
  const seen = new Set()
  let ctm = [1, 0, 0, 1, 0, 0]
  const stack = []

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    const args = argsArray[i] || []
    if (fn === OPS.save) {
      stack.push(ctm)
      continue
    }
    if (fn === OPS.restore) {
      ctm = stack.pop() || ctm
      continue
    }
    if (fn === OPS.transform) {
      ctm = mulMatrix(ctm, args)
      continue
    }
    if (fn === OPS.translate) {
      ctm = mulMatrix(ctm, [1, 0, 0, 1, args[0] || 0, args[1] || 0])
      continue
    }
    if (fn === OPS.rotate) {
      const a = args[0] || 0
      const c = Math.cos(a)
      const s = Math.sin(a)
      ctm = mulMatrix(ctm, [c, s, -s, c, 0, 0])
      continue
    }
    if (fn === OPS.scale) {
      ctm = mulMatrix(ctm, [args[0] || 1, 0, 0, args[1] || 1, 0, 0])
      continue
    }

    let img = null
    if (fn === OPS.paintImageXObject) {
      const name = args[0]
      try {
        if (page.objs.has(name)) img = page.objs.get(name)
      } catch {
        img = null
      }
    } else if (fn === OPS.paintInlineImageXObject) {
      img = args[0]
    } else if (fn === OPS.paintImageXObjectRepeat) {
      const name = args[0]
      try {
        if (page.objs.has(name)) img = page.objs.get(name)
      } catch {
        img = null
      }
    } else if (fn === OPS.paintInlineImageXObjectGroup) {
      img = args[0]
    }
    if (!img) continue

    const url = await imageToDataUrl(img)
    if (!url || seen.has(url)) continue
    seen.add(url)
    const [, y] = viewport.convertToViewportPoint(ctm[4], ctm[5])
    out.push({ y, url })
  }
  return out
}

/**
 * 单页 → markdown。文字行与图片按 Y 合并排序；
 * 行距超过阈值分段；字号相对正文中位数识别标题。
 */
function pageToMarkdown(lines, images, bodySize) {
  const items = [
    ...lines.map((l) => ({ y: l.y, kind: 'line', size: l.size, text: l.text })),
    ...images.map((im) => ({ y: im.y, kind: 'img', url: im.url })),
  ].sort((a, b) => a.y - b.y || (a.kind === b.kind ? 0 : a.kind === 'img' ? 1 : -1))

  const blocks = []
  let para = []
  let lastLine = null
  const flushPara = () => {
    if (para.length) {
      blocks.push(para.join(' '))
      para = []
    }
  }

  for (const it of items) {
    if (it.kind === 'img') {
      flushPara()
      blocks.push(`![图片](${it.url})`)
      lastLine = null
      continue
    }
    const ratio = bodySize ? it.size / bodySize : 1
    let prefix = ''
    if (ratio >= 1.8) prefix = '# '
    else if (ratio >= 1.35) prefix = '## '
    else if (ratio >= 1.15) prefix = '### '
    if (prefix) {
      flushPara()
      blocks.push(prefix + it.text)
      lastLine = it
      continue
    }
    if (lastLine && it.y - (lastLine.y + lastLine.size) > Math.max(lastLine.size * 1.5, 6)) {
      flushPara()
    }
    para.push(it.text)
    lastLine = it
  }
  flushPara()
  return blocks.join('\n\n')
}

/**
 * 提取整份 PDF 为 Markdown。
 * @param {object} pdf - pdf.js 文档（openPdf 返回值）
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<string>}
 */
export async function extractPdfMarkdown(pdf, onProgress) {
  const total = pdf.numPages
  const allSizes = []
  const pages = []
  for (let p = 1; p <= total; p++) {
    onProgress?.(p, total)
    let page
    try {
      page = await pdf.getPage(p)
    } catch {
      continue
    }
    const viewport = page.getViewport({ scale: 1 })
    let lines = []
    let images = []
    try {
      const content = await page.getTextContent()
      lines = itemsToLines(content.items || [], viewport)
    } catch {
      lines = []
    }
    for (const l of lines) allSizes.push(l.size)
    try {
      images = await extractPageImages(page, viewport)
    } catch {
      images = []
    }
    pages.push({ lines, images })
    await new Promise((r) => setTimeout(r, 0)) // 让出主线程
  }

  allSizes.sort((a, b) => a - b)
  const bodySize = allSizes.length ? allSizes[Math.floor(allSizes.length / 2)] : 12

  const parts = []
  for (let i = 0; i < pages.length; i++) {
    const md = pageToMarkdown(pages[i].lines, pages[i].images, bodySize)
    if (md.trim()) parts.push(md)
  }
  return parts.join('\n\n---\n\n')
}
