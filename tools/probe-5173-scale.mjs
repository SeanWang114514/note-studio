// probe-5173-scale.mjs — 观察缩放状态随时间变化
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PDF_PATH = path.join(ROOT, 'public', 'manual.pdf')
class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map() }
  async open() { await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej }); this.ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) } } }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('PAGE_ERR: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result?.value }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const userData = path.join(os.tmpdir(), 'p5173s-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9353', '--user-data-dir=' + userData, '--no-first-run', '--disable-gpu', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9353/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open()
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:5173/' })
await sleep(8000)
const b64 = fs.readFileSync(PDF_PATH).toString('base64')

await cdp.eval("(()=>{const bytes=Uint8Array.from(atob('" + b64 + "'),c=>c.charCodeAt(0));const file=new File([bytes],'manual.pdf',{type:'application/pdf'});const handle={kind:'file',name:'manual.pdf',getFile:async()=>file,queryPermission:async()=>'granted',requestPermission:async()=>'granted',createWritable:async()=>{return{write:async(d)=>{},close:async()=>{}}}};window.showOpenFilePicker=async()=>[handle];return 'ok'})()")
await cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/打开文件/.test(x.textContent||''));b?.click();return 'ok'})()")
const snap = "(()=>{const cv=document.querySelector('.pdf-page .pdf-canvas');if(!cv)return null;const cr=cv.getBoundingClientRect();const tl=document.querySelector('.pdf-page .pdf-text-layer');const tlr=tl.getBoundingClientRect();const sf=getComputedStyle(tl).getPropertyValue('--scale-factor');return{int:cv.width+'x'+cv.height,css:Math.round(cr.width)+'x'+Math.round(cr.height),layer:Math.round(tlr.width)+'x'+Math.round(tlr.height),scaleVar:sf.trim(),zoomPct:document.querySelector('.pdf-zoom-pct')?.textContent}})()"
for (const wait of [2, 4, 6, 10, 15]) {
  await sleep(wait === 2 ? 2000 : (wait === 4 ? 2000 : (wait === 6 ? 2000 : (wait === 10 ? 4000 : 5000))))
  console.log('t≈' + wait + 's:', JSON.stringify(await cdp.eval(snap)))
}
chrome.kill(); await sleep(400); process.exit(0)
