// real-rich.mjs
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
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text }; return r.result && r.result.value }
  close() { try { this.ws.close() } catch {} }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userData = path.join(os.tmpdir(), 'real-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9266', '--user-data-dir=' + userData, '--no-first-run', '--disable-gpu', '--disable-extensions', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9266/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open(); await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Page.navigate', { url: APP_URL }); await sleep(3000)
const b64 = fs.readFileSync(path.join(ROOT, 'public', PDF)).toString('base64')
await cdp.eval('(() => { const bytes = Uint8Array.from(atob("' + b64 + '"), c => c.charCodeAt(0)); const file = new File([bytes], "' + PDF + '", { type: "application/pdf" }); const handle = { kind: "file", name: "' + PDF + '", getFile: async () => file, queryPermission: async () => "granted", requestPermission: async () => "granted", createWritable: async () => ({ write: async () => {}, close: async () => {} }) }; window.showOpenFilePicker = async () => [handle]; return "ok" })()')
await cdp.eval('(() => { const b = [...document.querySelectorAll("button")].find(x => /打开文件/.test(x.textContent||"")); b && b.click(); return "ok" })()')
await sleep(7000)
const dbg = await cdp.eval('(function() { return { pageCount: document.querySelectorAll(".pdf-page").length, spanCount: document.querySelectorAll("span[data-page]").length, title: document.title } })()')
console.log("DBG:", JSON.stringify(dbg))
if (!dbg || dbg.pageCount === 0) { console.log("PDF not loaded"); cdp.close(); chrome.kill(); process.exit(0) }
const info = await cdp.eval('(function() { var spans = document.querySelectorAll("span[data-page]"); for (var i = 0; i < spans.length; i++) { var s = spans[i]; var t = s.textContent || ""; if (t.length > 5 && /[\u4e00-\u9fff]/.test(t)) { var r = s.getBoundingClientRect(); if (r.width > 5 && r.height > 5) { return { found: true, text: t.slice(0,20), click: { x: r.left + r.width/2, y: r.top + r.height/2 }, bold: s.dataset.pdfBold, italic: s.dataset.pdfItalic, color: s.dataset.pdfColor } } } } return { found: false } })()')
console.log("INFO:", JSON.stringify(info))
if (!info.found) { cdp.close(); chrome.kill(); process.exit(0) }
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.click.x, y: info.click.y, button: 'left', clickCount: 1 })
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.click.x, y: info.click.y, button: 'left', clickCount: 1 })
await sleep(800)
const dump = await cdp.eval('(function() { var box = document.querySelector(".pdf-inline-editor"); if (!box) return { editorOpen: false }; var lines = box.querySelectorAll("[data-line]"); var out = { editorOpen: true, lineCount: lines.length, lines: [] }; for (var i = 0; i < lines.length; i++) { var d = lines[i]; var spans = d.querySelectorAll("span"); var lineInfo = { i: i, text: d.textContent, spanCount: spans.length, spans: [] }; for (var j = 0; j < spans.length; j++) { var s = spans[j]; var cs = getComputedStyle(s); lineInfo.spans.push({ text: s.textContent, color: cs.color, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle }) } out.lines.push(lineInfo) } return out })()')
console.log("RICH:", JSON.stringify(dump, null, 1))
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(path.join(ROOT, 'tmp', 'real-rich.png'), Buffer.from(shot.data, 'base64'))
console.log("screenshot: tmp/real-rich.png")
cdp.close(); chrome.kill(); await sleep(800)
try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch {}
process.exit(0)
