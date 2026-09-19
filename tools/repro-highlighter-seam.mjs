// repro-highlighter-seam.mjs — 复现用户反馈的荧光笔叠加「矩形接缝 + 明暗不均」
// 用真实鼠标画多条交叉/偏移的高亮线，逐像素分析是否存在矩形接缝与深浅不均。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const FILE = process.argv[2] || 'test-complex.pdf'
const CHROME = process.argv[3] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5199/'
const SHOT_DIR = path.join(ROOT, 'tmp', 'hl-seam')
fs.mkdirSync(SHOT_DIR, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class CDP {
  constructor(ws) { this.ws = new WebSocket(ws); this.id = 0; this.pending = new Map() }
  async open() { await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej }); this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) } } }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  close() { try { this.ws.close() } catch {} }
}
async function ev(cdp, expression, awaitPromise = false) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (r?.exceptionDetails) return { __error: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 200) }
  return r?.result?.value
}
async function shot(cdp, name) { const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(data, 'base64')); console.log('  ◷ shot:', name) }
async function waitFor(cdp, expr, ms = 25000, step = 300) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await ev(cdp, expr); if (v && !v.__error) return v; await sleep(step) } return null }

async function main() {
  let alive = false
  for (let i = 0; i < 8; i++) { try { const r = await fetch(APP_URL, { signal: AbortSignal.timeout(2500) }); if (r.status < 500) { alive = true; break } } catch {} await sleep(800) }
  if (!alive) { console.error('dev 服务未启动: ' + APP_URL); process.exit(1) }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hlseam-'))
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9290', '--user-data-dir=' + userData,
    '--no-first-run', '--no-default-browser-check', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' })
  let targets = []
  for (let i = 0; i < 60; i++) { try { targets = await (await fetch('http://127.0.0.1:9290/json/list')).json(); if (targets.length) break } catch {} await sleep(250) }
  const cdp = new CDP((targets.find((t) => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
  await cdp.open(); await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 2, mobile: false })
  await cdp.send('Page.navigate', { url: APP_URL })
  await waitFor(cdp, `document.querySelectorAll('.nav-item').length`); await sleep(1000)

  const resolved = [path.join(ROOT, 'public', FILE), path.join(ROOT, 'tmp', FILE)].find((p) => fs.existsSync(p))
  const b64 = fs.readFileSync(resolved).toString('base64')
  await ev(cdp, `(() => { const bytes = Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0)); const f = new File([bytes], '${FILE}', { lastModified: 1700000000000 }); const handle = { kind: 'file', name: '${FILE}', getFile: async () => f, queryPermission: async () => 'granted', requestPermission: async () => 'granted', createWritable: async () => ({ write: async () => {}, close: async () => {}, seek: async () => {}, truncate: async () => {}, getPosition: async () => 0 }) }; window.showOpenFilePicker = async () => [handle]; return 'ok' })()`)
  await ev(cdp, `(async () => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '打开文件'); b && b.click(); return true })()`, true)
  await waitFor(cdp, `document.querySelectorAll('.annot-canvas').length`, 25000); await sleep(1500)

  // 荧光笔，粗 9
  await ev(cdp, `(async () => { const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith('荧光笔')); b.click(); await new Promise((r) => setTimeout(r, 200)); b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 })); await new Promise((r) => setTimeout(r, 350)); const pop = document.querySelector('.pen-popover:not(.shape-popover):not(.eraser-popover)'); const range = pop.querySelector('input[type="range"]'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(range, '9'); range.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => setTimeout(r, 150)); document.querySelector('.popover-backdrop').click(); await new Promise((r) => setTimeout(r, 200)); return true })()`, true)

  const baseY = await ev(cdp, `(() => { const cv = document.querySelector('.annot-canvas'); const sc = (() => { let n = cv.parentElement; while (n && n !== document.body) { const st = getComputedStyle(n); if (/(auto|scroll|overlay)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 4) return n; n = n.parentElement } return null })(); const sr = sc ? sc.getBoundingClientRect() : cv.getBoundingClientRect(); return Math.round(sr.top + 260) })()`)

  const stroke = async (fx, fy, tx, ty, steps = 40) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fx, y: fy })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fx, y: fy, button: 'left', clickCount: 1 })
    await sleep(60)
    for (let i = 1; i <= steps; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fx + ((tx - fx) * i) / steps, y: fy + ((ty - fy) * i) / steps, button: 'left' }) }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', clickCount: 1 })
    await sleep(700)
  }

  // 场景: 两条交叉线（倾斜），第二条画在第一条上面
  console.log('\n[1] 两条交叉高亮（第一条水平，第二条倾斜叠加）')
  await stroke(360, baseY, 900, baseY)
  await shot(cdp, '1-first-horizontal.png')
  await ev(cdp, `(() => { const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith('清除全部批注')); b && b.click(); return true })()`); await sleep(500)

  // 场景更贴近用户: 同一区域多次来回描（同一条路径画 2 次，真正重叠）
  console.log('\n[2] 同一条路径画两遍（第一遍 A，第二遍 B 完全盖在 A 上面）')
  await stroke(320, baseY, 900, baseY)
  await stroke(320, baseY, 900, baseY) // 完全相同路径再画一遍 => 重叠区域应变暗
  await shot(cdp, '2-overlap-exact.png')

  // 场景3: 第二遍略错开（偏移 8px）——最贴近"覆盖书写"手势
  console.log('\n[2b] 第二遍向下偏移 8px（覆盖书写）')
  await ev(cdp, `(() => { const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith('清除全部批注')); b && b.click(); return true })()`); await sleep(500)
  await stroke(320, baseY + 20, 900, baseY + 20)
  await stroke(300, baseY + 28, 880, baseY + 28) // 偏移 8px，大部分覆盖第一遍
  await shot(cdp, '2b-offset8-overlap.png')

  // 场景4: 十字交叉（一条横 + 一条竖交叉）
  console.log('\n[2c] 十字交叉')
  await ev(cdp, `(() => { const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith('清除全部批注')); b && b.click(); return true })()`); await sleep(500)
  await stroke(320, baseY, 900, baseY)
  await stroke(610, baseY - 80, 610, baseY + 80)
  await shot(cdp, '2c-cross.png')

  // 逐行扫描: 在重叠区域检查颜色突变（接缝=突然变浅/变深）
  const scan = await ev(cdp, `(() => {
    const cv = document.querySelector('.annot-canvas'); const r = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1; const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height;
    const data = ctx.getImageData(0, 0, W, H).data;
    const base = ${baseY}; const rows = [];
    for (let vy = base - 40; vy <= base + 80; vy += 6) rows.push(vy);
    const out = [];
    for (const vy of rows) {
      const cy = Math.round((vy - r.top) * dpr);
      if (cy < 0 || cy >= H) { out.push({ y: vy, skip: true }); continue; }
      // alpha 落在几个关键区间的像素计数 + 极值
      let lo = 0, mid = 0, hi = 0, on = 0, minA = 1, maxA = 0;
      for (let cx = 20; cx < W - 20; cx += 1) {
        const a = data[(cy * W + cx) * 4 + 3] / 255;
        if (a <= 0.02) continue;
        on++;
        if (a < 0.2) lo++; else if (a > 0.75) hi++; else mid++;
        if (a < minA) minA = a; if (a > maxA) maxA = a;
      }
      // 找最大相邻突变（同一行的 alpha 从暗到亮的跳变）
      let maxJump = 0; let prev = -1;
      for (let cx = 20; cx < W - 20; cx++) {
        const a = data[(cy * W + cx) * 4 + 3] / 255;
        if (a <= 0.02) { prev = -1; continue; }
        if (prev >= 0) { const d = Math.abs(a - prev); if (d > maxJump) maxJump = d; }
        prev = a;
      }
      out.push({ y: vy, on, lo, mid, hi, minA: Math.round(minA * 100) / 100, maxA: Math.round(maxA * 100) / 100, maxJump: Math.round(maxJump * 100) / 100 });
    }
    return out;
  })()`)
  console.log('  扫描结果:', JSON.stringify(scan))
  await shot(cdp, '3-seam-check.png')

  console.log('\n[3] 双击荧光笔换颜色/粗细（真实鼠标双击）')
  const btn = await ev(cdp, `(() => { const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith('荧光笔')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
  await sleep(70)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 2 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 2 })
  await sleep(700)
  const dbl = await ev(cdp, `(() => { const p = document.querySelector('.pen-popover:not(.shape-popover):not(.eraser-popover)'); if (!p) return 'closed'; const r = p.getBoundingClientRect(); return r.width > 0 ? 'open' : 'zero' })()`)
  console.log('  真实双击 →', dbl)
  await shot(cdp, '4-dblclick.png')

  cdp.close(); chrome.kill()
  console.log('\n完成; 截图见', SHOT_DIR)
}
main().catch((e) => { console.error('failed:', e); process.exit(2) })
