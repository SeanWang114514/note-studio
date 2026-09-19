import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const APP_URL = 'http://127.0.0.1:5200/'
class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map() }
  async open() { await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej }); this.ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) } } }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r && r.exceptionDetails) return { __exception: r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text }; return r && r.result && r.result.value }
  close() { try { this.ws.close() } catch {} }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userData = path.join(os.tmpdir(), 'chk2-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9311', '--user-data-dir=' + userData, '--no-first-run', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--window-size=1600,1200', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9311/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open();
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url: APP_URL });
await sleep(6000)
// 检查 root 是否渲染
const rootCheck = await cdp.eval('(function(){ var root = document.getElementById("root"); return { children: root ? root.children.length : -1, html: root ? root.innerHTML.slice(0, 100) : "no root" } })()')
console.log('ROOT:', JSON.stringify(rootCheck))
// mock File System Access
const b64 = fs.readFileSync(path.join(ROOT, 'public', 'manual.pdf')).toString('base64')
const openRes = await cdp.eval('(() => { const bytes = Uint8Array.from(atob("' + b64 + '"), c => c.charCodeAt(0)); const file = new File([bytes], "manual.pdf", { type: "application/pdf" }); const handle = { kind: "file", name: "manual.pdf", getFile: async () => file, queryPermission: async () => "granted", requestPermission: async () => "granted", createWritable: async () => ({ write: async () => {}, close: async () => {} }) }; window.showOpenFilePicker = async () => [handle]; return "ok" })()')
console.log('MOCK:', openRes)
// 点击打开文件
const clickRes = await cdp.eval('(function(){ var bs = document.querySelectorAll("button"); for (var i=0;i<bs.length;i++){ if (/打开文件/.test(bs[i].textContent||"")) { bs[i].click(); return "clicked:" + bs[i].textContent } } return "not found" })()')
console.log('CLICK:', clickRes)
await sleep(10000)
// 检查 PDF 页面
const pdfCheck = await cdp.eval('(function(){ return { pages: document.querySelectorAll(".pdf-page").length, spans: document.querySelectorAll("span[data-page]").length, layers: document.querySelectorAll(".pdf-text-layer").length } })()')
console.log('PDF:', JSON.stringify(pdfCheck))
cdp.close(); chrome.kill(); await sleep(800)
try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
process.exit(0)
