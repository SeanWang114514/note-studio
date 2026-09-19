// diag-edit-mismatch.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const APP_URL = 'http://127.0.0.1:5199/'
const PDF = 'test-realistic.pdf'
class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map() }
  async open() { await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej }); this.ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) } } }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text }; return r.result?.value }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userData = path.join(os.tmpdir(), 'diag-edit-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9251', '--user-data-dir=' + userData, '--no-first-run', '--disable-gpu', '--disable-extensions', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9251/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open(); await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Page.navigate', { url: APP_URL }); await sleep(4000)
const b64 = fs.readFileSync(path.join(ROOT, 'public', PDF)).toString('base64')
await cdp.eval('(() => { const bytes = Uint8Array.from(atob("' + b64 + '"), c => c.charCodeAt(0)); const file = new File([bytes], "' + PDF + '", { type: "application/pdf" }); const handle = { kind: "file", name: "' + PDF + '", getFile: async () => file, queryPermission: async () => "granted", requestPermission: async () => "granted", createWritable: async () => ({ write: async () => {}, close: async () => {} }) }; window.showOpenFilePicker = async () => [handle]; return "ok" })()')
await cdp.eval('(() => { const b = [...document.querySelectorAll("button")].find(x => /打开文件/.test(x.textContent||"")); b?.click(); return "ok" })()')
await sleep(7000)
const info = await cdp.eval('(() => { const layers = [...document.querySelectorAll(".pdf-text-layer")]; let target = null, targetLayer = null; for (const layer of layers) { const spans = [...layer.querySelectorAll("span[data-page]")]; const s = spans.find(x => (x.textContent||"").includes("填写相应内容")); if (s) { target = s; targetLayer = layer; break } }; if (!target) { for (const layer of layers) { const spans = [...layer.querySelectorAll("span[data-page]")]; const s = spans.find(x => /[\u4e00-\u9fff]/.test(x.textContent||"")); if (s) { target = s; targetLayer = layer; break } } }; if (!target) return { found: false, layerCount: layers.length }; const r = target.getBoundingClientRect(); const layerR = targetLayer.getBoundingClientRect(); return { found: true, page: target.dataset.page, text: target.textContent, spanRect: { left: r.left, top: r.top, width: r.width, height: r.height }, click: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, layerRect: { left: layerR.left, top: layerR.top, width: layerR.width, height: layerR.height } } })()')
console.log('TARGET:', JSON.stringify(info, null, 1))
if (!info.found) { chrome.kill(); process.exit(0) }
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.click.x, y: info.click.y, button: 'left', clickCount: 1 })
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.click.x, y: info.click.y, button: 'left', clickCount: 1 })
await sleep(800)
const dump = await cdp.eval('(async () => { const out = {}; const pos = document.querySelector(".pdf-inline-editor-pos"); const box = document.querySelector(".pdf-inline-editor"); if (!box) return { editorOpen: false }; out.editorOpen = true; const pr = pos.getBoundingClientRect(); const br = box.getBoundingClientRect(); out.posRect = { left: pr.left, top: pr.top, width: pr.width, height: pr.height }; out.boxRect = { left: br.left, top: br.top, width: br.width, height: br.height }; out.boxStyle = { fontFamily: box.style.fontFamily, fontSize: box.style.fontSize, lineHeight: box.style.lineHeight, whiteSpace: box.style.whiteSpace, background: box.style.backgroundColor, color: box.style.color }; out.lines = [...box.querySelectorAll("[data-line]")].map((d, i) => { const r = d.getBoundingClientRect(); const cs = getComputedStyle(d); return { i, text: d.textContent, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, transform: cs.transform, whiteSpace: cs.whiteSpace, minHeight: cs.minHeight, lineHeight: cs.lineHeight, fontSize: cs.fontSize } }); out.boxText = box.textContent; try { const mod = await import("/src/lib/pdf/pdfTextEdit.js"); const layer = pos.closest(".pdf-text-layer"); const page = pos.closest(".pdf-page")?.dataset.page; const blocks = mod.collectParagraphs(layer, Number(page)); out.blocks = blocks.map(b => ({ lineCount: b.lineData.length, lineTexts: b.lineData.map(l => l.text), linePdfY: b.lineData.map(l => l.pdfY), lineSpacing: b.lineSpacing, fontSize: b.fontSize, actualFontName: b.actualFontName, fontFamily: b.fontFamily, color: b.color })) } catch (e) { out.aggregateError = String(e && e.message || e) }; return out })()')
console.log('EDITOR DUMP:', JSON.stringify(dump, null, 1))
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(path.join(ROOT, 'tmp', 'diag-edit-mismatch.png'), Buffer.from(shot.data, 'base64'))
console.log('screenshot: tmp/diag-edit-mismatch.png')
cdp.close(); chrome.kill(); await sleep(800)
try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch {}
process.exit(0)
