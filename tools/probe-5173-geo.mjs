// probe-5173-geo.mjs — 5173 上编辑提交后的几何与截图
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PDF_PATH = path.join(ROOT, 'public', 'manual.pdf')
const OUT = path.join(ROOT, 'tmp', 'p5173geo-' + Date.now())
fs.mkdirSync(OUT, { recursive: true })
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
const userData = path.join(os.tmpdir(), 'p5173geo-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9352', '--user-data-dir=' + userData, '--no-first-run', '--disable-gpu', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9352/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open()
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:5173/' })
await sleep(9000)
const b64 = fs.readFileSync(PDF_PATH).toString('base64')

await cdp.eval("(()=>{const bytes=Uint8Array.from(atob('" + b64 + "'),c=>c.charCodeAt(0));const file=new File([bytes],'manual.pdf',{type:'application/pdf'});const handle={kind:'file',name:'manual.pdf',getFile:async()=>file,queryPermission:async()=>'granted',requestPermission:async()=>'granted',createWritable:async()=>{return{write:async(d)=>{},close:async()=>{}}}};window.showOpenFilePicker=async()=>[handle];return 'ok'})()")
await cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/打开文件/.test(x.textContent||''));b?.click();return 'ok'})()")
let opened = null
for (let i = 0; i < 25; i++) { await sleep(1000); opened = await cdp.eval("(()=>({pages:document.querySelectorAll('.pdf-page').length,spans:document.querySelectorAll('.pdf-text-layer span[data-page]').length}))()"); if (opened.pages > 0 && opened.spans > 0) break }
// 关键几何：页面矩形、文字层矩形、目标 span 矩形、canvas 内部/CSS 尺寸、dpr
const geo = await cdp.eval("(()=>{const pg=document.querySelector('.pdf-page');const pr=pg.getBoundingClientRect();const tl=document.querySelector('.pdf-page .pdf-text-layer');const tlr=tl.getBoundingClientRect();const s=[...document.querySelectorAll('.pdf-text-layer span[data-page=\"1\"]')].find(x=>(x.textContent||'').startsWith('所有同学'));const sr=s.getBoundingClientRect();const cv=document.querySelector('.pdf-page .pdf-canvas');const cr=cv.getBoundingClientRect();return{dpr:window.devicePixelRatio,page:{l:pr.left,t:pr.top,w:pr.width,h:pr.height},layer:{l:tlr.left,t:tlr.top,w:tlr.width,h:tlr.height},span:{l:sr.left,t:sr.top,w:sr.width,h:sr.height,text:s.textContent.slice(0,10)},canvasCSS:{w:cr.width,h:cr.height},canvasInt:{w:cv.width,h:cv.height},canvasStyleW:getComputedStyle(cv).width,scrollY:document.querySelector('.pdf-scroll').scrollTop}})()")
console.log('几何:', JSON.stringify(geo, null, 1))
const pt = { x: geo.span.l + 20, y: geo.span.t + geo.span.h / 2 }
await clickAt(cdp, pt.x, pt.y); await sleep(900)
await cdp.send('Input.insertText', { text: '【验证】' }); await sleep(300)
const margin = { x: geo.page.l + 8, y: geo.page.t + 120 }
await clickAt(cdp, margin.x, margin.y); await sleep(900)
const probe = await cdp.eval("(()=>{const ec=document.querySelector('.pdf-page .pdf-edit-canvas');const w=ec.width,h=ec.height;const d=ec.getContext('2d').getImageData(0,0,w,h).data;let minX=1e9,minY=1e9,maxX=-1,maxY=-1;for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;if(d[i+3]>10){if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y}}}return maxX<0?{painted:false}:{painted:true,bbox:{minX,minY,maxX,maxY}}})()")
console.log('绘制bbox:', JSON.stringify(probe))
const s = await cdp.send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(path.join(OUT, 'after-commit.png'), Buffer.from(s.data, 'base64'))
console.log('OUT:', OUT)
chrome.kill(); await sleep(400); process.exit(0)
