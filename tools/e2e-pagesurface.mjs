// e2e-pagesurface.mjs — 整页连续编辑表面端到端测试
// 流程：打开 manual.pdf → 点标题行打开编辑器（应含整页所有行）
//   → 跨行拖拽选择 → Esc → 点正文行输入文字 → 提交（点击页边）
//   → 验证 editCanvas 只覆盖被编辑行（像素 bbox）→ 点下方★行验证仍可编辑
//   → 行尾 Enter 追加行 → 提交 → 验证追加行绘制
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 5311
const PDF_PATH = path.join(ROOT, 'public', 'manual.pdf')
const OUT = path.join(ROOT, 'tmp', 'e2e-surface-' + Date.now())
fs.mkdirSync(OUT, { recursive: true })

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.pdf': 'application/pdf', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2' }
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0])
  if (p === '/') p = '/index.html'
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
async function shot(cdp, name) { const s = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(s.data, 'base64')); console.log('shot:', name) }
async function clickAt(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

const userData = path.join(os.tmpdir(), 'e2esurface-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9341', '--user-data-dir=' + userData, '--no-first-run', '--disable-gpu', '--disable-extensions', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9341/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open()
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' })
await sleep(5000)

const pdfBytes = fs.readFileSync(PDF_PATH)
const b64 = pdfBytes.toString('base64')

await cdp.eval("(()=>{const bytes=Uint8Array.from(atob('" + b64 + "'),c=>c.charCodeAt(0));const file=new File([bytes],'manual.pdf',{type:'application/pdf'});const handle={kind:'file',name:'manual.pdf',getFile:async()=>file,queryPermission:async()=>'granted',requestPermission:async()=>'granted',createWritable:async()=>{let buf=null;return{write:async(d)=>{buf=d},close:async()=>{window.__savedPdfBytes=buf}}}};window.showOpenFilePicker=async()=>[handle];return 'ok'})()")
await cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/打开文件/.test(x.textContent||''));b?.click();return 'ok'})()")
await sleep(7000)

// ── 工具：页内求 span/行框
const spanPt = "((sel)=>{const ss=[...document.querySelectorAll('.pdf-text-layer span[data-page=\"1\"]')].filter(s=>s.textContent.trim());const s=typeof sel==='number'?ss[sel]:ss.find(x=>(x.textContent||'').replace(/^\\s+/,'').startsWith(sel));if(!s)return null;const r=s.getBoundingClientRect();return{x:r.left+Math.min(r.width/2,26),y:r.top+r.height/2,t:s.textContent.slice(0,20),n:ss.length}})"

// ── Step 1: 点标题行（span 0）→ 编辑器应覆盖整页文字
const p1 = await cdp.eval(spanPt + "(0)")
console.log('title span:', JSON.stringify(p1))
await clickAt(cdp, p1.x, p1.y)
await sleep(900)
const st1 = await cdp.eval("(()=>{const pos=document.querySelector('.pdf-inline-editor-pos');if(!pos)return{open:false};const box=document.querySelector('.pdf-inline-editor');const lines=[...box.querySelectorAll('[data-line]')];const pr=pos.getBoundingClientRect();return{open:true,lineCount:lines.length,firstText:lines[0]?.textContent?.slice(0,14),lastText:lines[lines.length-1]?.textContent?.slice(0,10),posH:Math.round(pr.height),posW:Math.round(pr.width)}})()")
console.log('编辑器打开(点标题):', JSON.stringify(st1))
await shot(cdp, '1-editor-open.png')

// ── Step 2: 跨行拖拽选择（从第2行到第4行）
const drag = await cdp.eval("(()=>{const lines=[...document.querySelectorAll('.pdf-inline-editor [data-line]')];if(lines.length<4)return null;const a=lines[1].getBoundingClientRect();const b=lines[3].getBoundingClientRect();return{x1:a.left+3,y1:a.top+a.height/2,x2:b.right-6,y2:b.top+b.height/2}})()")
if (drag) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: drag.x1, y: drag.y1, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drag.x1 + (drag.x2 - drag.x1) * i / 12, y: drag.y1 + (drag.y2 - drag.y1) * i / 12, button: 'left', buttons: 1 })
    await sleep(25)
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drag.x2, y: drag.y2, button: 'left' })
  await sleep(400)
  const sel = await cdp.eval("(()=>{const s=window.getSelection();return{text:s?s.toString():'',len:s?s.toString().length:0}})()")
  console.log('跨行选择长度:', sel.len, JSON.stringify(sel.text.slice(0, 60)))
}
await shot(cdp, '2-cross-select.png')

// ── Step 3: Esc 取消
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
await sleep(400)

// ── Step 4: 点正文行「所有同学」→ 输入替换文字
const p4 = await cdp.eval(spanPt + "(\"所有同学\")")
console.log('body span:', JSON.stringify(p4))
await clickAt(cdp, p4.x, p4.y)
await sleep(900)
await cdp.send('Input.insertText', { text: '【测试编辑】' })
await sleep(300)
await shot(cdp, '3-editing-line.png')

// ── Step 5: 点击页边空白提交
const margin = await cdp.eval("(()=>{const pg=document.querySelector('.pdf-page');const r=pg.getBoundingClientRect();return{x:r.left+8,y:r.top+120}})()")
await clickAt(cdp, margin.x, margin.y)
await sleep(900)
const st5 = await cdp.eval("(()=>{const closed=!document.querySelector('.pdf-inline-editor');const ec=document.querySelector('.pdf-page .pdf-edit-canvas');let bbox=null;if(ec){const w=ec.width,h=ec.height,d=ec.getContext('2d').getImageData(0,0,w,h).data;let minX=1e9,minY=1e9,maxX=-1,maxY=-1;for(let y=0;y<h;y+=2)for(let x=0;x<w;x+=2){if(d[(y*w+x)*4+3]>10){if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y}}if(maxX>=0)bbox={minX,minY,maxX,maxY}}const edited=[...document.querySelectorAll('.pdf-text-layer span.edited')].map(s=>s.textContent.slice(0,8));return{closed,bbox,editedCount:edited.length,edited}})()")
console.log('提交后:', JSON.stringify(st5))
await shot(cdp, '4-committed.png')

// ── Step 6: 点下方★行 → 仍可编辑，且编辑器内该行为原文
const p6 = await cdp.eval(spanPt + "(\"★\")")
console.log('star span:', JSON.stringify(p6))
await clickAt(cdp, p6.x, p6.y)
await sleep(900)
const st6 = await cdp.eval("(()=>{const box=document.querySelector('.pdf-inline-editor');if(!box)return{open:false};const lines=[...box.querySelectorAll('[data-line]')];const hit=lines.map(l=>l.textContent).find(t=>t.includes('个人课题'));const edited=lines.map(l=>l.textContent).find(t=>t.includes('【测试编辑】'));return{open:true,lineCount:lines.length,starLine:hit?hit.slice(0,20):null,editedLineShown:!!edited}})()")
console.log('重开编辑器(★行):', JSON.stringify(st6))
await shot(cdp, '5-reopen-below.png')

// ── Step 7: 在「所有同学」行尾按 Enter 追加一行并输入
const endPt = await cdp.eval("(()=>{const lines=[...document.querySelectorAll('.pdf-inline-editor [data-line]')];const l=lines.map((el,i)=>({el,i,t:el.textContent})).find(x=>x.t.includes('【测试编辑】'));if(!l)return null;const r=l.el.getBoundingClientRect();const pos=document.querySelector('.pdf-inline-editor-pos').getBoundingClientRect();return{x:Math.min(r.right,pos.right)-12,y:r.top+r.height/2,i:l.i}})()")
if (endPt) {
  await clickAt(cdp, endPt.x, endPt.y)
  await sleep(300)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' })
  await sleep(300)
  await cdp.send('Input.insertText', { text: '追加的新行' })
  await sleep(300)
  const st7 = await cdp.eval("(()=>{const lines=[...document.querySelectorAll('.pdf-inline-editor [data-line]')];return{lineCount:lines.length,appended:lines.map(l=>l.textContent).find(t=>t.includes('追加的新行'))?true:false}})()")
  console.log('Enter 追加行:', JSON.stringify(st7))
  await shot(cdp, '6-appended-line.png')
  const margin2 = await cdp.eval("(()=>{const pg=document.querySelector('.pdf-page');const r=pg.getBoundingClientRect();return{x:r.left+8,y:r.top+120}})()")
  await clickAt(cdp, margin2.x, margin2.y)
  await sleep(900)
  const st8 = await cdp.eval("(()=>{const ec=document.querySelector('.pdf-page .pdf-edit-canvas');let bbox=null;if(ec){const w=ec.width,h=ec.height,d=ec.getContext('2d').getImageData(0,0,w,h).data;let minX=1e9,minY=1e9,maxX=-1,maxY=-1;for(let y=0;y<h;y+=2)for(let x=0;x<w;x+=2){if(d[(y*w+x)*4+3]>10){if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y}}if(maxX>=0)bbox={minX,minY,maxX,maxY}}const cnt=[...document.querySelectorAll('.pdf-text-layer span.edited')].length;return{closed:!document.querySelector('.pdf-inline-editor'),bbox,editedSpans:cnt}})()")
  console.log('二次提交后:', JSON.stringify(st8))
  await shot(cdp, '7-final.png')
}

console.log('OUT:', OUT)
chrome.kill(); server.close()
await sleep(500)
process.exit(0)
