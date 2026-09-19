// debug-5173.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map() }
  async open() { await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej }); this.ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) } } else if (msg.method) { console.log('WS MSG:', msg.method) } } }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r && r.exceptionDetails) return null; return r && r.result && r.result.value }
  close() { try { this.ws.close() } catch {} }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userData = path.join(os.tmpdir(), 'dbg5173-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9291', '--user-data-dir=' + userData, '--no-first-run', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9291/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open()
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:5173/' })
await sleep(10000)
// 检查 WS 连接状态
const wsStatus = await cdp.eval('(function(){try{var s=document.querySelector("script[type=module]");if(!s)return"no script";return"script found"}catch(e){return"err:"+e.message}})()')
console.log("WS STATUS:", wsStatus)
const root = await cdp.eval('(function(){var r=document.getElementById("root");return{innerHTML:r?r.innerHTML.slice(0,200):"no root",children:r?r.children.length:0}})()')
console.log("ROOT:", JSON.stringify(root))
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(path.join(ROOT, 'tmp', 'dbg5173.png'), Buffer.from(shot.data, 'base64'))
console.log('screenshot: tmp/dbg5173.png')
cdp.close(); chrome.kill(); await sleep(800)
try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
process.exit(0)
