// debug-enter.mjs — 定位 Enter 追加行时编辑器关闭的原因
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 5312
const PDF_PATH = path.join(ROOT, 'public', 'manual.pdf')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.pdf': 'application/pdf', '.png': 'image/png', '.wasm': 'application/wasm', '.json': 'application/json' }
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'
  const f = path.join(DIST, p)
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' })
  fs.createReadStream(f).pipe(res)
})
await new Promise(r => server.listen(PORT, r))
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
const userData = path.join(os.tmpdir(), 'dbgenter-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9342', '--user-data-dir=' + userData, '--no-first-run', '--disable-gpu', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9342/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open()
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
const errors = []
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' })
await sleep(5000)
const b64 = fs.readFileSync(PDF_PATH).toString('base64')

await cdp.eval("(()=>{const bytes=Uint8Array.from(atob('" + b64 + "'),c=>c.charCodeAt(0));const file=new File([bytes],'manual.pdf',{type:'application/pdf'});const handle={kind:'file',name:'manual.pdf',getFile:async()=>file,queryPermission:async()=>'granted',requestPermission:async()=>'granted',createWritable:async()=>{return{write:async(d)=>{},close:async()=>{}}}};window.showOpenFilePicker=async()=>[handle];return 'ok'})()")
await cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/打开文件/.test(x.textContent||''));b?.click();return 'ok'})()")
await sleep(7000)

const spanPt = "((sel)=>{const ss=[...document.querySelectorAll('.pdf-text-layer span[data-page=\"1\"]')].filter(s=>s.textContent.trim());const s=typeof sel==='number'?ss[sel]:ss.find(x=>(x.textContent||'').replace(/^\\s+/,'').startsWith(sel));if(!s)return null;const r=s.getBoundingClientRect();return{x:r.left+Math.min(r.width/2,26),y:r.top+r.height/2,t:s.textContent.slice(0,20)}})"

// 打开编辑器（点标题）
const p1 = await cdp.eval(spanPt + "(0)")
await clickAt(cdp, p1.x, p1.y); await sleep(900)
console.log('opened:', await cdp.eval("(()=>({open:!!document.querySelector('.pdf-inline-editor'),n:document.querySelectorAll('.pdf-inline-editor [data-line]').length}))()"))

// 在「所有同学」行插入文字 → 提交
const p4 = await cdp.eval(spanPt + "(\"所有同学\")")
await clickAt(cdp, p4.x, p4.y); await sleep(900)
await cdp.send('Input.insertText', { text: '【测试编辑】' }); await sleep(300)
const margin = await cdp.eval("(()=>{const pg=document.querySelector('.pdf-page');const r=pg.getBoundingClientRect();return{x:r.left+8,y:r.top+120}})()")
await clickAt(cdp, margin.x, margin.y); await sleep(900)
console.log('committed:', await cdp.eval("(()=>({closed:!document.querySelector('.pdf-inline-editor')}))()"))

// 重开（点★）
const p6 = await cdp.eval(spanPt + "(\"★\")")
await clickAt(cdp, p6.x, p6.y); await sleep(900)
const st = await cdp.eval("(()=>{const box=document.querySelector('.pdf-inline-editor');if(!box)return{open:false};const lines=[...box.querySelectorAll('[data-line]')];const l=lines.map((el,i)=>({el,i,t:el.textContent})).find(x=>x.t.includes('【测试编辑】'));if(!l)return{open:true,noLine:true};const r=l.el.getBoundingClientRect();const pos=document.querySelector('.pdf-inline-editor-pos').getBoundingClientRect();return{open:true,idx:l.i,rect:{l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)},pos:{l:Math.round(pos.left),t:Math.round(pos.top),w:Math.round(pos.width),h:Math.round(pos.height)},atPoint:document.elementFromPoint(r.left+r.width-8,r.top+r.height/2)?.className}})()")
console.log('reopen state:', JSON.stringify(st))
if (!st.open || st.noLine || !st.rect) { console.log('errors:', errors.slice(0,3)); process.exit(0) }

// 点击该行尾部（钳制在 pos 盒与视口内，避免点到页面外触发提交）
const cx = Math.min(st.rect.l + st.rect.w, st.pos.l + st.pos.w) - 10, cy = st.rect.t + st.rect.h / 2
console.log('click at', cx, cy, 'element:', await cdp.eval("document.elementFromPoint(" + cx + "," + cy + ")?.className || 'null'"))
await clickAt(cdp, cx, cy); await sleep(400)
console.log('after click open:', await cdp.eval("(()=>({open:!!document.querySelector('.pdf-inline-editor'),n:document.querySelectorAll('.pdf-inline-editor [data-line]').length,active:document.activeElement?.className}))()"))
// Enter
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r' })
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' })
await sleep(400)
console.log('after Enter:', await cdp.eval("(()=>{const ls=[...document.querySelectorAll('.pdf-inline-editor [data-line]')];return{open:!!document.querySelector('.pdf-inline-editor'),n:ls.length,last:ls.length?ls[ls.length-1].textContent.slice(0,12):null}})()"))
await cdp.send('Input.insertText', { text: '追加的新行' }); await sleep(300)
console.log('after type:', await cdp.eval("(()=>{const ls=[...document.querySelectorAll('.pdf-inline-editor [data-line]')];return{open:!!document.querySelector('.pdf-inline-editor'),n:ls.length,appended:ls.some(l=>l.textContent.includes('追加的新行'))}})()"))
console.log('page errors:', errors.length ? errors.slice(0, 4) : 'none')
chrome.kill(); server.close(); await sleep(400); process.exit(0)
