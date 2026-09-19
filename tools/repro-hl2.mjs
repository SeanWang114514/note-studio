// repro-hl2.mjs — 精确复现荧光笔覆盖：同一路径第二道盖在第一道上，导出画布像素检查矩形框/明暗
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
const OUT = path.resolve(ROOT, 'tmp', 'hl2')
fs.mkdirSync(OUT, { recursive: true })
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
async function waitFor(cdp, expr, ms = 25000, step = 300) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await ev(cdp, expr); if (v && !v.__error) return v; await sleep(step) } return null }

// 导出整个覆盖画布为 PNG（含条带），便于精确查看墨迹
async function exportCanvas(cdp, tag) {
  const dataUrl = await ev(cdp, `(() => {
    const cv = document.querySelector('.annot-canvas'); if (!cv) return null;
    return cv.toDataURL('image/png');
  })()`)
  if (!dataUrl) return null
  const b = dataUrl.split(',')[1]
  const p = path.join(OUT, `canvas-${tag}.png`)
  fs.writeFileSync(p, Buffer.from(b, 'base64'))
  console.log('  ◷ exported canvas →', p, 'bytes=', Buffer.byteLength(b))
  return p
}

// 在画布某行采样 alpha 分布（用画布内部 DPR 坐标，直接读 getImageData）
async function rowProfile(cdp, canvasYpx) {
  return ev(cdp, `(() => {
    const cv = document.querySelector('.annot-canvas'); const dpr = window.devicePixelRatio || 1;
    const r = cv.getBoundingClientRect(); const cy = Math.round((${canvasYpx} - r.top) * dpr);
    const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height;
    if (cy < 0 || cy >= H) return { y: ${canvasYpx}, skip: true };
    const data = ctx.getImageData(0, 0, W, H).data;
    // 在画布横向，找墨迹区间，输出每个墨迹像素的 alpha，并按相邻步长取样
    const segs = []; let cur = null;
    for (let cx = 0; cx < W; cx++) { const a = data[(cy * W + cx) * 4 + 3] / 255; if (a > 0.03) { if (!cur) cur = { x0: cx, x1: cx, alphas: [] }; cur.x1 = cx; cur.alphas.push(Math.round(a * 100) / 100); } else if (cur) { segs.push(cur); cur = null; } }
    if (cur) segs.push(cur);
    return { y: ${canvasYpx}, cy, segs: segs.map((s) => ({ x0: Math.round((s.x0 / dpr) + r.left), x1: Math.round((s.x1 / dpr) + r.left), n: s.alphas.length, min: Math.min(...s.alphas), max: Math.max(...s.alphas), edge: [s.alphas[0], s.alphas[1], s.alphas[2]], edgeEnd: [s.alphas[s.alphas.length-1], s.alphas[s.alphas.length-2], s.alphas[s.alphas.length-3]] })) };
  })()`)
}

async function main() {
  let alive = false
  for (let i = 0; i < 8; i++) { try { const r = await fetch(APP_URL, { signal: AbortSignal.timeout(2500) }); if (r.status < 500) { alive = true; break } } catch {} await sleep(800) }
  if (!alive) { console.error('dev 未启动: ' + APP_URL); process.exit(1) }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hl2-'))
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9292', '--user-data-dir=' + userData, '--no-first-run', '--no-default-browser-check', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' })
  let targets = []; for (let i = 0; i < 60; i++) { try { targets = await (await fetch('http://127.0.0.1:9292/json/list')).json(); if (targets.length) break } catch {} await sleep(250) }
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

  // 荧光笔 粗 9（与 verify-eraser 相同可靠设置）
  await ev(cdp, `(async () => { const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith('荧光笔')); b.click(); await new Promise((r) => setTimeout(r, 200)); b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 })); await new Promise((r) => setTimeout(r, 350)); const pop = document.querySelector('.pen-popover:not(.shape-popover):not(.eraser-popover)'); const range = pop.querySelector('input[type="range"]'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(range, '9'); range.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => setTimeout(r, 150)); document.querySelector('.popover-backdrop').click(); await new Promise((r) => setTimeout(r, 200)); return true })()`, true)

  // 可靠 y：跟 verify-eraser 一致（sc.top + 220）
  const y = await ev(cdp, `(() => { const cv = document.querySelector('.annot-canvas'); const sc = (() => { let n = cv.parentElement; while (n && n !== document.body) { const st = getComputedStyle(n); if (/(auto|scroll|overlay)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 4) return n; n = n.parentElement } return null })(); const sr = sc ? sc.getBoundingClientRect() : cv.getBoundingClientRect(); return Math.round(sr.top + 220) })()`)
  console.log('绘制 y =', y)

  const stroke = async (fx, fy, tx, ty, steps = 45) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fx, y: fy })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fx, y: fy, button: 'left', clickCount: 1 })
    await sleep(60)
    for (let i = 1; i <= steps; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fx + ((tx - fx) * i) / steps, y: fy + ((ty - fy) * i) / steps, button: 'left' }) }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', clickCount: 1 })
    await sleep(800)
  }

  // 场景 A：第一道 [380, 700]；第二道 [380, 700] 完全相同 => 重叠区 = 全长
  console.log('\n[场景 A] 两遍完全相同的路径（覆盖书写）')
  await stroke(380, y, 700, y)
  await exportCanvas(cdp, 'A-pass1')
  await stroke(380, y, 700, y)
  await exportCanvas(cdp, 'A-pass2')
  // 扫描几行
  for (const dy of [0, 2, 4]) {
    const prof = await rowProfile(cdp, y + dy)
    const seg = prof.segs && prof.segs.length ? prof.segs.map((s) => ({ x0: s.x0, x1: s.x1, min: s.min, max: s.max, e0: s.edge, eN: s.edgeEnd })) : prof
    console.log(`  行 y+${dy}:`, JSON.stringify(seg))
  }

  // 场景 B：第一道 [380,800]，第二道 [380,800] 部分重画，但第二道起点略早 [360,780]（不同范围）
  console.log('\n[场景 B] 不同范围叠加（第二道 [360,760] 盖第一道 [380,800] 中段）')
  await ev(cdp, `(() => { const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith('清除全部批注')); b && b.click(); return true })()`); await sleep(600)
  await stroke(380, y, 800, y)
  await stroke(360, y, 760, y)
  await exportCanvas(cdp, 'B-overlap')
  for (const dy of [0, 2, 4]) {
    const prof = await rowProfile(cdp, y + dy)
    const seg = prof.segs && prof.segs.length ? prof.segs.map((s) => ({ x0: s.x0, x1: s.x1, min: s.min, max: s.max, e0: s.edge, eN: s.edgeEnd })) : prof
    console.log(`  行 y+${dy}:`, JSON.stringify(seg))
  }

  cdp.close(); chrome.kill()
  console.log('\n完成; 画布PNG见', OUT)
}
main().catch((e) => { console.error('failed:', e); process.exit(2) })
