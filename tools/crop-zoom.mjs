// crop-zoom.mjs — 裁剪截图左上角放大 4x 保存
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SRC = process.argv[2] || 'C:/Users/Administrator/AppData/Local/Temp/modlens-dsh-paste/p-30OBKv/paste.png'
const OUT = process.argv[3] || path.join(ROOT, 'tmp', 'zoom-left-top.png')
class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map() }
  async open() { await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej }); this.ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) } } }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return r.result?.value }
  close() { try { this.ws.close() } catch {} }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userData = path.join(os.tmpdir(), 'cropzoom-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9259', '--user-data-dir=' + userData, '--no-first-run', '--disable-gpu', '--window-size=900,700', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9259/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open(); await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
const b64 = fs.readFileSync(SRC).toString('base64')
const expr = '(async () => {'
  + ' const img = new Image(); img.src = "data:image/png;base64," + window.__B64;'
  + ' await new Promise((res, rej) => { img.onload = res; img.onerror = rej });'
  + ' const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;'
  + ' const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);'
  + ' const data = ctx.getImageData(0, 0, img.width, img.height).data;'
  + ' const blue = [];'
  + ' for (let y = 0; y < img.height; y += 2) { for (let x = 0; x < img.width; x += 2) { const i = (y * img.width + x) * 4; const b = data[i+2], r = data[i], g = data[i+1]; if (b > 100 && b > r + 20 && b > g + 15) blue.push({x,y}) } }'
  + ' const out = { w: img.width, h: img.height, blueCount: blue.length };'
  + ' if (blue.length) { out.minX = Math.min(...blue.map(p=>p.x)); out.minY = Math.min(...blue.map(p=>p.y)); out.maxX = Math.max(...blue.map(p=>p.x)); out.maxY = Math.max(...blue.map(p=>p.y));'
  + ' const cropX = Math.max(0, out.minX - 10), cropY = Math.max(0, out.minY - 10), cropW = Math.min(500, out.maxX - cropX + 10), cropH = Math.min(220, out.maxY - cropY + 10);'
  + ' const z = document.createElement("canvas"); z.width = cropW * 4; z.height = cropH * 4;'
  + ' const zc = z.getContext("2d"); zc.imageSmoothingEnabled = false; zc.drawImage(c, cropX, cropY, cropW, cropH, 0, 0, cropW*4, cropH*4);'
  + ' out.crop = { x: cropX, y: cropY, w: cropW, h: cropH };'
  + ' out.zoomedDataUrl = z.toDataURL("image/png");'
  + ' } return out'
  + '})()'
await cdp.eval('window.__B64 = "' + b64 + '"')
const result = await cdp.eval(expr)
if (result && result.zoomedDataUrl) {
  const b = Buffer.from(result.zoomedDataUrl.split(',')[1], 'base64')
  fs.writeFileSync(OUT, b)
  console.log('ZOOMED:', JSON.stringify({ out: OUT, w: result.w, h: result.h, blueCount: result.blueCount, crop: result.crop }))
} else {
  console.log('RESULT:', JSON.stringify(result))
}
cdp.close(); chrome.kill(); await sleep(800)
try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch {}
process.exit(0)
