// wait-rich.mjs — 脚本层循环等待，eval 只做查询
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const APP_URL = 'http://127.0.0.1:5199/'
const PDF = 'manual.pdf'
class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map() }
  async open() { await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej }); this.ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) } } }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text }; return r.result?.value }
  close() { try { this.ws.close() } catch {} }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userData = path.join(os.tmpdir(), 'rich-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9265', '--user-data-dir=' + userData, '--no-first-run', '--disable-gpu', '--disable-extensions', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9265/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open(); await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Page.navigate', { url: APP_URL }); await sleep(3000)
const b64 = fs.readFileSync(path.join(ROOT, 'public', PDF)).toString('base64')
await cdp.eval('(() => { const bytes = Uint8Array.from(atob("' + b64 + '"), c => c.charCodeAt(0)); const file = new File([bytes], "' + PDF + '", { type: "application/pdf" }); const handle = { kind: "file", name: "' + PDF + '", getFile: async () => file, queryPermission: async () => "granted", requestPermission: async () => "granted", createWritable: async () => ({ write: async () => {}, close: async () => {} }) }; window.showOpenFilePicker = async () => [handle]; return "ok" })()')
await cdp.eval('(() => { const b = [...document.querySelectorAll("button")].find(x => /打开文件/.test(x.textContent||"")); b?.click(); return "ok" })()')
// 脚本层循环等待 PDF 加载
let pagesLoaded = 0;
for (let i = 0; i < 30; i++) {
  const cnt = await cdp.eval('document.querySelectorAll(".pdf-page").length')
  if (typeof cnt === 'number' && cnt >= 9) { pagesLoaded = cnt; break; }
  await sleep(1000)
}
console.log('PAGES:', pagesLoaded)
// 滚到页3
await cdp.eval('(() => { const p3 = [...document.querySelectorAll(".pdf-page")].find(x => x.dataset.page === "3"); if (p3) p3.scrollIntoView({block:"start"}); return p3 ? "ok" : "not found" })()')
await sleep(2000)
// 找页3正文
const info = await cdp.eval('(() => { const spans = [...document.querySelectorAll("span[data-page=\"3\"]")]; for (const s of spans) { const t = s.textContent||""; if (t.includes("第一步") || t.includes("填写相应") || t.includes("相应内容")) { const r = s.getBoundingClientRect(); if (r.width > 5 && r.height > 5) return { found: true, text: t.slice(0,30), click: { x: r.left + r.width/2, y: r.top + r.height/2 } } } } return { found: false } })()')
console.log('TARGET:', JSON.stringify(info))
if (!info.found) { cdp.close(); chrome.kill(); await sleep(800); try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch {}; process.exit(0) }
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.click.x, y: info.click.y, button: 'left', clickCount: 1 })
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.click.x, y: info.click.y, button: 'left', clickCount: 1 })
await sleep(800)
const dump = await cdp.eval('(async () => { const box = document.querySelector(".pdf-inline-editor"); if (!box) return { editorOpen: false }; const lines = [...box.querySelectorAll("[data-line]")]; return { editorOpen: true, lineCount: lines.length, lines: lines.map((d, i) => { const spans = [...d.querySelectorAll("span")]; return { i, text: d.textContent, spans: spans.map(s => ({ text: s.textContent, color: getComputedStyle(s).color, fontWeight: getComputedStyle(s).fontWeight, fontStyle: getComputedStyle(s).fontStyle })) } }) })()')
console.log('RICH:', JSON.stringify(dump, null, 1))
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(path.join(ROOT, 'tmp', 'wait-rich.png'), Buffer.from(shot.data, 'base64'))
console.log('screenshot: tmp/wait-rich.png')
cdp.close(); chrome.kill(); await sleep(800)
try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch {}
process.exit(0)
