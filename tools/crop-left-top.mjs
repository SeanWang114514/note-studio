// crop-left-top.mjs — 像素分析用户截图
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SRC = 'C:/Users/Administrator/AppData/Local/Temp/modlens-dsh-paste/p-30OBKv/paste.png'
class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map() }
  async open() { await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej }); this.ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) } } }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text }; return r.result?.value }
  close() { try { this.ws.close() } catch {} }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userData = path.join(os.tmpdir(), 'crop-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9258', '--user-data-dir=' + userData, '--no-first-run', '--disable-gpu', '--window-size=800,600', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9258/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open(); await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
const b64 = fs.readFileSync(SRC).toString('base64')
// 把 b64 传进浏览器分析
const analysis = await cdp.eval('(async () => {
  const img = new Image()
  img.src = "data:image/png;base64," + window.__B64
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej })
  const c = document.createElement("canvas")
  c.width = img.width; c.height = img.height
  const ctx = c.getContext("2d")
  ctx.drawImage(img, 0, 0)
  const out = { w: img.width, h: img.height }
  // 蓝色像素分析
  const data = ctx.getImageData(0, 0, img.width, img.height).data
  const bluePixels = []
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const i = (y * img.width + x) * 4
      const b = data[i+2], r = data[i], g = data[i+1]
      if (b > 150 && b > r + 60 && b > g + 40) bluePixels.push({ x, y })
    }
  }
  out.blueCount = bluePixels.length
  if (bluePixels.length) {
    out.blueMinX = Math.min(...bluePixels.map(p => p.x))
    out.blueMinY = Math.min(...bluePixels.map(p => p.y))
    out.blueMaxX = Math.max(...bluePixels.map(p => p.x))
    out.blueMaxY = Math.max(...bluePixels.map(p => p.y))
  }
  // 找蓝色框内黑色文字起始：在 blueMinX+5 到 blueMinX+80 之间扫描黑色像素
  if (out.blueMinX !== undefined) {
    const bx = out.blueMinX, by = out.blueMinY
    const darkCols = []
    for (let x = bx + 2; x < bx + 100; x++) {
      let dark = 0
      for (let y = by; y < by + 40; y++) {
        const i = (y * img.width + x) * 4
        if (data[i] < 80 && data[i+1] < 80 && data[i+2] < 80) dark++
      }
      if (dark > 2) darkCols.push(x)
    }
    out.darkCols = darkCols
    if (darkCols.length) {
      out.firstDarkX = Math.min(...darkCols)
      out.darkRuns = []
      let runStart = darkCols[0], prev = darkCols[0]
      for (let i = 1; i <= darkCols.length; i++) {
        if (i === darkCols.length || darkCols[i] > prev + 3) {
          out.darkRuns.push([runStart, prev])
          runStart = darkCols[i]
        }
        prev = darkCols[i]
      }
    }
  }
  return out
})()')
// 设置 __B64 再运行
await cdp.eval('window.__B64 = "' + b64 + '"')
const result = await cdp.eval(analysis)
console.log('ANALYSIS:', JSON.stringify(result, null, 1))
cdp.close(); chrome.kill(); await sleep(800)
try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch {}
process.exit(0)
