// test-5173-edit.mjs — 5173 上点击行打开编辑器 + 提交，确认 dev 环境全链路
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
async function clickAt(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
const userData = path.join(os.tmpdir(), 't5173edit-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9350', '--user-data-dir=' + userData, '--no-first-run', '--disable-gpu', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9350/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open()
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:5173/' })
await sleep(9000)
const b64 = fs.readFileSync(PDF_PATH).toString('base64')

await cdp.eval("(()=>{const bytes=Uint8Array.from(atob('" + b64 + "'),c=>c.charCodeAt(0));const file=new File([bytes],'manual.pdf',{type:'application/pdf'});const handle={kind:'file',name:'manual.pdf',getFile:async()=>file,queryPermission:async()=>'granted',requestPermission:async()=>'granted',createWritable:async()=>{let buf=null;return{write:async(d)=>{buf=d},close:async()=>{window.__savedPdfBytes=buf}}}};window.showOpenFilePicker=async()=>[handle];return 'ok'})()")
await cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/打开文件/.test(x.textContent||''));b?.click();return 'ok'})()")
let opened = null
for (let i = 0; i < 25; i++) { await sleep(1000); opened = await cdp.eval("(()=>({pages:document.querySelectorAll('.pdf-page').length,spans:document.querySelectorAll('.pdf-text-layer span[data-page]').length}))()"); if (opened.pages > 0 && opened.spans > 0) break }
console.log('打开:', JSON.stringify(opened))
// 点正文行 → 编辑器 → 输入 → 提交
const pt = await cdp.eval("(()=>{const s=[...document.querySelectorAll('.pdf-text-layer span[data-page=\"1\"]')].find(x=>(x.textContent||'').startsWith('所有同学'));const r=s.getBoundingClientRect();return{x:r.left+20,y:r.top+r.height/2}})()")
await clickAt(cdp, pt.x, pt.y); await sleep(900)
const ed = await cdp.eval("(()=>{const box=document.querySelector('.pdf-inline-editor');return{open:!!box,lines:box?box.querySelectorAll('[data-line]').length:0}})()")
console.log('编辑器:', JSON.stringify(ed))
await cdp.send('Input.insertText', { text: '【5173验证】' }); await sleep(300)
const margin = await cdp.eval("(()=>{const pg=document.querySelector('.pdf-page');const r=pg.getBoundingClientRect();return{x:r.left+8,y:r.top+120}})()")
await clickAt(cdp, margin.x, margin.y); await sleep(900)
const st = await cdp.eval("(()=>{const ec=document.querySelector('.pdf-page .pdf-edit-canvas');const ctx=ec.getContext('2d');const img=ctx.getImageData(0,130,ec.width,35).data;let mn=255;for(let i=0;i<img.length;i+=4){if(img[i+3]>10){const l=0.299*img[i]+0.587*img[i+1]+0.114*img[i+2];if(l<mn)mn=l}}return{closed:!document.querySelector('.pdf-inline-editor'),paintedMinLum:Math.round(mn)}})()")
console.log('提交后:', JSON.stringify(st))
// 保存
await cdp.eval("(()=>{const b=[...document.querySelectorAll('.pdf-toolbar .tool-btn')].find(x=>/保存到 PDF/.test(x.textContent||''));b?.click();return 'ok'})()")
await sleep(3500)
const savedLen = await cdp.eval("(()=>window.__savedPdfBytes?new Uint8Array(window.__savedPdfBytes).length:null)()")
console.log('保存字节:', savedLen)
chrome.kill(); await sleep(400); process.exit(0)
