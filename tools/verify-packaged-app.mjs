// verify-packaged-app.mjs — 真机验收「打包出来的 exe」（不是 dev server！）
//
// 要验的三件事：
//   1) 打出来的包里，主程序真的能从 app:// 协议跑起来（Electron 启动链路没坏）
//   2) 排掉 node_modules 之后，PDF 打开 / 批注 / 保存 这些核心流程还能用
//      （即：渲染层确实自带依赖，没有偷偷 require 打包时被排除的 node_modules）
//   3) 新增的文本框样式（字体/字号/粗斜/下划线/对齐/颜色）能写进 PDF 再读回来
//      —— 保存成 /FreeText 的 DA + Q，重开同一个 PDF 时样式还在
//
// 用法：
//   1) 先带调试端口启动打包好的程序：
//        & "release\win-unpacked\Note Studio.exe" --remote-debugging-port=9401
//      （或者单人 exe： & "release\Note-Studio-0.1.0-Windows.exe" --remote-debugging-port=9401）
//   2) node tools/verify-packaged-app.mjs
// 环境变量：CDP_URL 默认 http://127.0.0.1:9401
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

// 把 PDF 里所有 FlateDecode 流解压后拼成一份可搜索文本：
// pdf-lib 默认会把对象压进对象流，不解压就搜不到 /FreeText、DA、/Q 这些键。
function pdfHaystack(buf) {
  const raw = buf.toString('latin1')
  const parts = [raw]
  let i = 0
  for (;;) {
    const a = raw.indexOf('stream', i)
    if (a < 0) break
    let b = a + 'stream'.length
    if (raw[b] === '\r') b += 1
    if (raw[b] === '\n') b += 1
    const e = raw.indexOf('endstream', b)
    if (e < 0) break
    try { parts.push(zlib.inflateSync(buf.subarray(b, e)).toString('latin1')) } catch { /* 不是 Flate 流就跳过 */ }
    i = e + 'endstream'.length
  }
  return parts.join('\n')
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9401'
const SHOT_DIR = path.join(ROOT, 'tmp', 'hig-shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function check(name, cond, extra = '') {
  if (!cond) failures += 1
  console.log(`  ${cond ? '✔' : '✘'} ${name}${cond ? '' : '  ' + extra}`)
}

class CDP {
  constructor(ws) { this.ws = new WebSocket(ws); this.id = 0; this.pending = new Map() }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id)
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
      }
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  close() { try { this.ws.close() } catch {} }
}

async function ev(cdp, expression, awaitPromise = false) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (r?.exceptionDetails) return { __error: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 300) }
  return r?.result?.value
}
async function waitFor(cdp, expr, ms = 20000, step = 250) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const v = await ev(cdp, expr); if (v && !v.__error) return v; await sleep(step) }
  return null
}
async function clickAt(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(150)
}
async function clickToolByTitle(cdp, prefix) {
  const p = await ev(cdp, `(() => { const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith(${JSON.stringify(prefix)})); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
  if (!p) return false
  await clickAt(cdp, p.x, p.y); return true
}
// 文字格式栏是「自动出现的一整行」，不需要任何隐藏手势；点一下文本框工具就该看到它
async function openTextFormatBar(cdp) {
  await clickToolByTitle(cdp, '文本框')
  return Boolean(await waitFor(cdp, `(() => { const b = document.querySelector('.text-format-bar'); return b && b.getBoundingClientRect().width > 0 })()`, 5000))
}
async function setSelect(cdp, sel, value) {
  return ev(cdp, `(() => { const s = document.querySelector(${JSON.stringify(sel)}); if (!s) return null; s.value = ${JSON.stringify(String(value))}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value })()`)
}
async function clickInBar(cdp, sel) {
  const p = await ev(cdp, `(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) } })()`)
  if (!p) return false
  await clickAt(cdp, p.x, p.y)
  return true
}
// 打包版用的是持久化 profile，反复跑测试会累积旧批注；所以这里：
//  - 优先看「当前选中的」那个框（刚提交的文本框是选中态）；
//  - 需要判断「存在一个带目标样式的框」时用 some() 扫全部，避免被旧批注误导。
const textBoxStyles = (cdp) => ev(cdp, `(() => [...document.querySelectorAll('.ann-text')].map((el) => {
  const cs = getComputedStyle(el);
  return { selected: el.classList.contains('selected'), fontFamily: cs.fontFamily, fontSize: cs.fontSize,
    fontWeight: cs.fontWeight, fontStyle: cs.fontStyle, align: cs.textAlign, color: cs.color,
    text: (el.querySelector('.ann-text-content') || {}).textContent || '' };
}))()`)
async function textBoxStyle(cdp) {
  const all = await textBoxStyles(cdp)
  if (!all || !all.length) return null
  return all.find((b) => b.selected) || all[all.length - 1]
}
const matchesStyle = (b, k, { font, size, color }) =>
  Boolean(b) && (b.text || '').includes('打包版') &&
  new RegExp(font, 'i').test(b.fontFamily) &&
  b.fontSize === `${Math.round(size * k)}px` &&
  b.fontWeight === '700' && b.fontStyle === 'italic' && b.align === 'center' && b.color === color
const annScale = async (cdp) => { const raw = await ev(cdp, `(() => { const el = document.querySelector('.ann-dom'); return el ? getComputedStyle(el).getPropertyValue('--ann-scale').trim() : '1' })()`); const n = Number(raw); return Number.isFinite(n) && n > 0 ? n : 1 }

// 把某个 PDF 装成「用户选了文件」，并根据 name 决定旁车缓存键（换名字就能绕开旁车，强制走 PDF 内嵌注释）
const installFixture = (cdp, bytesExpr, name) => ev(cdp, `(() => {
  const bytes = ${bytesExpr};
  const f = new File([bytes], ${JSON.stringify(name)}, { lastModified: 1700000000000 });
  const handle = { kind: 'file', name: ${JSON.stringify(name)}, getFile: async () => f,
    queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    createWritable: async () => ({ write: async (c) => { window.__savedBytes = c; }, close: async () => {}, seek: async () => {}, truncate: async () => {}, getPosition: async () => 0 }) };
  window.showOpenFilePicker = async () => [handle];
  window.showSaveFilePicker = async () => handle;
  return true;
})()`, true)

async function clickButtonByText(cdp, text) {
  const p = await ev(cdp, `(() => { const b = [...document.querySelectorAll('button')].find((x) => ((x.textContent||'') + ' ' + (x.getAttribute('title')||'')).includes(${JSON.stringify(text)})); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
  if (!p) return false
  await clickAt(cdp, p.x, p.y); return true
}

async function main() {
  let list = []
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${CDP_URL}/json/list`, { signal: AbortSignal.timeout(2000) }); list = await r.json(); if (list.some((t) => t.type === 'page')) break } catch {}
    await sleep(500)
  }
  const page = list.find((t) => t.type === 'page' && String(t.url).startsWith('app://')) || list.find((t) => t.type === 'page')
  if (!page) { console.error('没连上打包程序的调试端口。请先带 --remote-debugging-port=9401 启动 exe'); process.exit(1) }
  console.log('已连接: ' + page.url)
  const cdp = new CDP(page.webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Runtime.enable')
  const errors = []
  cdp.ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params?.exceptionDetails?.exception?.description || '').slice(0, 200))
  })

  try {
    console.log('\n【1】打包程序自身')
    check('页面走 app:// 自定义协议（确认是打包版而非 dev server）', page.url.startsWith('app://'), page.url)
    check('React 应用已挂载', Boolean(await waitFor(cdp, `document.querySelectorAll('.nav-item').length`, 20000)))
    const proto = await ev(cdp, `({ proto: location.protocol, href: location.href })`)
    console.log('  ' + JSON.stringify(proto))

    // 打包裁剪校验：该留的留着，排掉的确实没了
    const resources = await ev(cdp, `(async () => {
      const probe = async (u) => { try { const r = await fetch(u); return r.ok ? r.status : 'http:' + r.status } catch (e) { return 'err' } };
      return { dart: await probe('/dart-pdf-editor/index.html'), opds: await probe('/open-pdf-studio/index.html'), fixture: await probe('/test-text.pdf'), main: await probe('/index.html') };
    })()`, true)
    console.log('  资源探测: ' + JSON.stringify(resources))
    check('dart PDF 编辑器资源在包里（该留的留着）', resources && String(resources.dart) === '200', JSON.stringify(resources))
    check('已排除的 open-pdf-studio 副本确实不在包里', resources && String(resources.opds) !== '200', JSON.stringify(resources))

    console.log('\n【2】核心流程：打开 PDF → 建带样式的文本框 → 保存 → 重开')
    const b64 = fs.readFileSync(path.join(ROOT, 'public', 'test-text.pdf')).toString('base64')
    await installFixture(cdp, `Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0))`, 'test-text.pdf')
    await ev(cdp, `(async () => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '打开文件'); b && b.click(); return true })()`, true)
    check('PDF 打开并出现批注画布', Boolean(await waitFor(cdp, `document.querySelectorAll('.annot-canvas').length`, 25000)))
    await sleep(700)

    check('点一下「文本框」工具，文字格式栏自动出现（无需隐藏手势）', await openTextFormatBar(cdp))
    const barInfo = await ev(cdp, `(() => { const b = document.querySelector('.text-format-bar'); if (!b) return null; const r = b.getBoundingClientRect();
      return { w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right), win: innerWidth,
        outside: [...b.querySelectorAll('button, select, input')].filter((el) => { const q = el.getBoundingClientRect();
          return q.width > 0 && (q.left < 0 || q.right > innerWidth || q.top < 0 || q.bottom > innerHeight) }).map((el) => el.getAttribute('aria-label') || el.className),
        context: (b.querySelector('.tfb-context')||{}).textContent,
        fonts: [...b.querySelectorAll('.text-font-select option')].map((o) => o.textContent),
        sizeOptions: b.querySelectorAll('.text-size-select option').length,
        styleBtns: [...b.querySelectorAll('.text-style-group .seg-btn')].map((x) => x.getAttribute('aria-label')),
        alignBtns: [...b.querySelectorAll('.text-align-group .seg-btn')].map((x) => x.getAttribute('aria-label')),
        swatches: b.querySelectorAll('.swatch').length } })()`)
    console.log('  格式栏: ' + JSON.stringify(barInfo))
    // 回归护栏：.doc-toolbar 默认 nowrap，格式栏一旦被撑出容器，色块会落在窗口右边点不到
    check('格式栏全部控件都在窗口内（不会被撑出屏幕）', Boolean(barInfo) && barInfo.outside.length === 0 && barInfo.right <= barInfo.win, JSON.stringify(barInfo && barInfo.outside))
    check('格式栏控件齐全（字体/字号/BIU/对齐/色板）',
      Boolean(barInfo) && barInfo.fonts.length === 4 && barInfo.sizeOptions >= 14 && barInfo.styleBtns.length === 3 && barInfo.alignBtns.length === 3 && barInfo.swatches >= 5,
      JSON.stringify(barInfo))

    await setSelect(cdp, '.text-format-bar .text-font-select', 'serif')
    await setSelect(cdp, '.text-format-bar .text-size-select', '24')
    for (const label of ['加粗', '倾斜', '下划线']) await clickInBar(cdp, `.text-format-bar .text-style-group .seg-btn[aria-label="${label}"]`)
    await clickInBar(cdp, '.text-format-bar .text-align-group .seg-btn[aria-label="居中"]')
    await clickInBar(cdp, '.text-format-bar .swatch[aria-label="文字颜色 #007aff"]')
    await sleep(200)

    const box = await ev(cdp, `(() => { const cv = document.querySelector('.annot-canvas'); const r = cv.getBoundingClientRect(); return { x: Math.round(r.left + 140), y: Math.round(Math.max(r.top + 80, 180)) } })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + (220*i)/8, y: box.y + (70*i)/8, button: 'left' }); await sleep(15) }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 220, y: box.y + 70, button: 'left', clickCount: 1 })
    await sleep(400)
    check('出现页面内文字编辑器', Boolean(await waitFor(cdp, `document.querySelectorAll('.ann-text-editor').length`, 5000)))
    await cdp.send('Input.insertText', { text: '打包版样式回环' })
    await sleep(200)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(500)

    const k = await annScale(cdp)
    const allBoxes = await textBoxStyles(cdp)
    const st = await textBoxStyle(cdp)
    console.log(`  缩放=${k}  框数=${(allBoxes || []).length}  本次（选中态）: ` + JSON.stringify(st))
    if ((allBoxes || []).length > 1) console.log('  全部文本框颜色: ' + JSON.stringify(allBoxes.map((b) => `${b.selected ? '*' : ''}${b.color}`)))
    check('文本框建成且样式正确（宋体/24/粗斜/居中/蓝）', matchesStyle(st, k, { font: 'Songti|SimSun|serif', size: 24, color: 'rgb(0, 122, 255)' }), JSON.stringify(st))

    await cdp.send('Page.captureScreenshot', { format: 'png' }).then(({ data }) => fs.writeFileSync(path.join(SHOT_DIR, 'packaged-app-text-style.png'), Buffer.from(data, 'base64')))

    // 保存批注到 PDF（写出的字节被抓到 window.__savedBytes）
    await ev(cdp, `(() => { window.__savedBytes = null; return true })()`)
    const saved = await clickButtonByText(cdp, '保存批注到 PDF')
    check('找到并点击「保存批注到 PDF」', saved)
    const hasBytes = Boolean(await waitFor(cdp, `window.__savedBytes && window.__savedBytes.byteLength > 600 ? window.__savedBytes.byteLength : null`, 30000))
    check('确实写回了 PDF 字节', hasBytes, '未捕获到写入内容')

    if (hasBytes) {
      // 把写回的字节搬回 Node，逐字节检查样式到底有没有进 PDF（这是别的阅读器能不能看到样式的唯一依据）
      const b64out = await ev(cdp, `(() => { let s = ''; const b = window.__savedBytes; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s) })()`)
      const outBytes = Buffer.from(b64out, 'base64')
      const outPath = path.join(ROOT, 'tmp', 'packaged-saved.pdf')
      fs.writeFileSync(outPath, outBytes)
      console.log(`  写回 PDF: ${outBytes.length} 字节（原文件 ${fs.statSync(path.join(ROOT, 'public', 'test-text.pdf')).size} 字节） -> tmp/packaged-saved.pdf`)

      // 对象可能被 pdf-lib 塞进 FlateDecode 对象流，所以把流解压后一起搜。
      // 注意：同一个 PDF 反复跑测试会累积多条 /FreeText，所以「某一个注释」满足即可（some），
      // 不能只看第一个 /DA —— 那可能是上一轮留下的。
      const hay = pdfHaystack(outBytes)
      const das = [...hay.matchAll(/DA\s*\(([^)]*)\)/g)].map((m) => m[1])
      const da = das.find((d) => d.includes('/TiBI')) || das[0] || ''
      const qs = [...hay.matchAll(/\/Q\s+(\d+)/g)].map((m) => m[1])
      console.log(`  /DA 共 ${das.length} 条，其中带 /TiBI 的: ` + JSON.stringify(da) + `   /Q: ` + JSON.stringify(qs))
      check('PDF 里有 /FreeText 文本框注释', hay.includes('/FreeText'))
      // 宋体 + 粗体 + 斜体 → Times-BoldItalic(/TiBI)；24pt 屏幕字号 × 0.75 = 18
      check('DA 里带上了字体（宋体+粗+斜 → /TiBI）', das.some((d) => d.includes('/TiBI')), JSON.stringify(das))
      check('DA 里带上了字号（24 × 0.75 = 18 Tf）', das.some((d) => /18(\.0+)?\s*Tf/.test(d)), JSON.stringify(das))
      check('DA 里带上了颜色（#007aff 蓝，两位小数 0 0.48 1 rg）', das.some((d) => /0(\.0+)?\s+0\.4[78]\w*\s+1(\.0+)?\s+rg/.test(d)), JSON.stringify(das))
      check('对齐写进了 /Q（居中=1）', qs.includes('1'), JSON.stringify(qs))
      check('/DR /Font 里登记了 Times-BoldItalic（阅读器才认这个 /TiBI）', hay.includes('Times-BoldItalic'))
      // 中文必须按规范写成 UTF-16BE 十六进制串（FEFF 开头），否则 pdf-lib 的 PDFString 会截成低 8 位变乱码
      const utf16hex = 'FEFF' + Buffer.from('打包版样式回环', 'utf16le').swap16().toString('hex').toUpperCase()
      check('中文内容按 UTF-16BE 写进 PDF（不再被截成乱码）', hay.toUpperCase().includes(utf16hex), utf16hex)

      // 应用内持久化：批注模型存在 IndexedDB，重开同一个文件应恢复样式
      console.log('\n【3】应用内重开（走 IndexedDB 批注模型）')
      await cdp.send('Page.reload', { ignoreCache: false })
      await waitFor(cdp, `document.querySelectorAll('.nav-item').length`, 25000)
      await sleep(800)
      await installFixture(cdp, `Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0))`, 'test-text.pdf')
      await ev(cdp, `(async () => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '打开文件'); b && b.click(); return true })()`, true)
      check('重开后再次进入 PDF 编辑', Boolean(await waitFor(cdp, `document.querySelectorAll('.annot-canvas').length`, 25000)))
      await sleep(1500)
      const k3 = await annScale(cdp)
      const allBoxes3 = (await textBoxStyles(cdp)) || []
      const st3 = await textBoxStyle(cdp)
      console.log(`  重开后缩放=${k3}  框数=${allBoxes3.length}  样式: ` + JSON.stringify(st3))
      const persisted = allBoxes3.some((b) => matchesStyle(b, k3, { font: 'Songti|SimSun|serif', size: 24, color: 'rgb(0, 122, 255)' }))
      check('重开同一个文件后，文本框样式（宋体/24/粗斜/居中/蓝）仍在', persisted, JSON.stringify(allBoxes3.map((b) => `${b.fontSize} ${b.fontWeight} ${b.color}`)))
    }

    check('打包程序运行期无未捕获异常', errors.length === 0, errors.join(' | '))
    console.log('\n截图: tmp/hig-shots/packaged-app-text-style.png')
    console.log(failures === 0 ? '\n打包版验收全部通过 ✅' : `\n失败 ${failures} 项 ❌`)
  } finally {
    cdp.close()
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error('脚本异常:', e); process.exit(1) })
