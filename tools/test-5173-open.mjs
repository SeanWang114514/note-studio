// test-5173-open.mjs — 在 5173 (vite dev) 上实测打开 PDF 是否卡住
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PDF_PATH = path.join(ROOT, 'public', 'manual.pdf')
const OUT = path.join(ROOT, 'tmp', 't5173-' + Date.now())
fs.mkdirSync(OUT, { recursive: true })
class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map() }
  async open() { await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej }); this.ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) } } }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('PAGE_ERR: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result?.value }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const userData = path.join(os.tmpdir(), 't5173-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9349', '--user-data-dir=' + userData, '--no-first-run', '--disable-gpu', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9349/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open()
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
const errors = []
cdp.ws.onmessage = (() => { const orig = cdp.ws.onmessage; return (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text); if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') errors.push(m.params.entry.text); if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + (m.params.args||[]).map(a=>a.value||a.description||'').join(' ').slice(0,200)); orig && orig(ev) } })()
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:5173/' })
await sleep(9000)
const mount = await cdp.eval("(()=>{const r=document.getElementById('root');return{children:r?r.children.length:-1,html:(r?.innerHTML||'').slice(0,120)}})()")
console.log('React挂载:', JSON.stringify(mount))
const b64 = fs.readFileSync(PDF_PATH).toString('base64')

await cdp.eval("(()=>{const bytes=Uint8Array.from(atob('" + b64 + "'),c=>c.charCodeAt(0));const file=new File([bytes],'manual.pdf',{type:'application/pdf'});const handle={kind:'file',name:'manual.pdf',getFile:async()=>file,queryPermission:async()=>'granted',requestPermission:async()=>'granted',createWritable:async()=>{return{write:async(d)=>{},close:async()=>{}}}};window.showOpenFilePicker=async()=>[handle];return 'ok'})()")
await cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/打开文件/.test(x.textContent||''));b?.click();return 'ok'})()")
// 轮询等待页面渲染（最多 25s）
let opened = null
for (let i = 0; i < 25; i++) {
  await sleep(1000)
  opened = await cdp.eval("(()=>({pages:document.querySelectorAll('.pdf-page').length,loading:!!document.querySelector('.loading'),spans:document.querySelectorAll('.pdf-text-layer span[data-page]').length}))()")
  if (opened.pages > 0 && opened.spans > 0) break
}
console.log('打开结果:', JSON.stringify(opened))
console.log('页面错误:', errors.length ? errors.slice(0, 6) : 'none')
const s = await cdp.send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(path.join(OUT, '5173-open.png'), Buffer.from(s.data, 'base64'))
console.log('OUT:', OUT)
chrome.kill(); await sleep(400); process.exit(0)
