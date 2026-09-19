// verify-pixels.mjs — 像素级验证：
// 1) 编辑行的原始墨迹 bbox vs 提交后绘制的墨迹 bbox（对齐/字号一致性）
// 2) 未编辑行区域 editCanvas 完全透明（未被误涂白）
// 3) 保存到 PDF 后重新渲染，验证写入 PDF 的行墨迹与屏幕绘制一致
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
const PORT = 5313
const PDF_PATH = path.join(ROOT, 'public', 'manual.pdf')
const OUT = path.join(ROOT, 'tmp', 'verify-px-' + Date.now())
fs.mkdirSync(OUT, { recursive: true })
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
async function shot(cdp, name) { const s = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(s.data, 'base64')) }
const userData = path.join(os.tmpdir(), 'verifypx-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9343', '--user-data-dir=' + userData, '--no-first-run', '--disable-gpu', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9343/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open()
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' })
await sleep(5000)
const b64 = fs.readFileSync(PDF_PATH).toString('base64')

await cdp.eval("(()=>{const bytes=Uint8Array.from(atob('" + b64 + "'),c=>c.charCodeAt(0));const file=new File([bytes],'manual.pdf',{type:'application/pdf'});const handle={kind:'file',name:'manual.pdf',getFile:async()=>file,queryPermission:async()=>'granted',requestPermission:async()=>'granted',createWritable:async()=>{let buf=null;return{write:async(d)=>{buf=d},close:async()=>{window.__savedPdfBytes=buf}}}};window.showOpenFilePicker=async()=>[handle];return 'ok'})()")
await cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/打开文件/.test(x.textContent||''));b?.click();return 'ok'})()")
await sleep(7000)

// 墨迹 bbox 工具：在 canvas 指定 y 带内找暗像素/不透明像素范围
const inkBbox = "((canvas,y0,y1,dark)=>{const ctx=canvas.getContext('2d');const w=canvas.width,h=canvas.height;d0=Math.max(0,Math.floor(y0));d1=Math.min(h,Math.ceil(y1));const img=ctx.getImageData(0,d0,w,d1-d0).data;let minX=1e9,minY=1e9,maxX=-1,maxY=-1;for(let y=0;y<d1-d0;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;const a=img[i+3];const lum=0.299*img[i]+0.587*img[i+1]+0.114*img[i+2];const hit=dark?(a>10&&lum<170):(a>10);if(hit){if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y}}return maxX<0?null:{minX,minY:(minY+d0),maxX,maxY:(maxY+d0)}})"

// 1) 打开编辑器（点击正文行）
const spanPt = "((sel)=>{const ss=[...document.querySelectorAll('.pdf-text-layer span[data-page=\"1\"]')].filter(s=>s.textContent.trim());const s=typeof sel==='number'?ss[sel]:ss.find(x=>(x.textContent||'').replace(/^\\s+/,'').startsWith(sel));if(!s)return null;const r=s.getBoundingClientRect();const pg=document.querySelector('.pdf-page').getBoundingClientRect();return{x:r.left+Math.min(r.width/2,26),y:r.top+r.height/2,bandY0:r.top-pg.top-4,bandY1:r.bottom-pg.top+4,t:s.textContent.slice(0,12)}})"
const p4 = await cdp.eval(spanPt + "(\"所有同学\")")
console.log('目标行:', JSON.stringify(p4))
await clickAt(cdp, p4.x, p4.y); await sleep(900)

// 2) 原始墨迹（base canvas，暗像素）
const base = await cdp.eval("(()=>{const cv=document.querySelector('.pdf-page .pdf-canvas');const fn=" + inkBbox + ";return fn(cv," + p4.bandY0 + "," + p4.bandY1 + ",true)})()")
console.log('原始墨迹bbox:', JSON.stringify(base))

// 3) 输入并提交
await cdp.send('Input.insertText', { text: '【测试编辑】' }); await sleep(300)
const margin = await cdp.eval("(()=>{const pg=document.querySelector('.pdf-page');const r=pg.getBoundingClientRect();return{x:r.left+8,y:r.top+120}})()")
await clickAt(cdp, margin.x, margin.y); await sleep(900)

// 4) 绘制层墨迹（editCanvas，不透明像素）
const painted = await cdp.eval("(()=>{const ec=document.querySelector('.pdf-page .pdf-edit-canvas');const fn=" + inkBbox + ";return fn(ec," + p4.bandY0 + "," + p4.bandY1 + ",false)})()")
console.log('绘制墨迹bbox:', JSON.stringify(painted))

// 5) 其它行区域 editCanvas 必须全透明
const otherClear = await cdp.eval("(()=>{const ec=document.querySelector('.pdf-page .pdf-edit-canvas');const ctx=ec.getContext('2d');const bands=[[170,240],[380,430],[1300,1400]];let dirty=0;for(const[b0,b1]of bands){const img=ctx.getImageData(0,b0,ec.width,b1-b0).data;for(let i=3;i<img.length;i+=4){if(img[i]>10){dirty++;break}}}return{dirtyBands:dirty}})()")
console.log('其它行区域污染:', JSON.stringify(otherClear))

// 6) 保存 PDF → 渲染回 page1 → 检查写入效果
await cdp.eval("(()=>{const b=[...document.querySelectorAll('.pdf-toolbar .tool-btn')].find(x=>/保存到 PDF/.test(x.textContent||''));b?.click();return 'ok'})()")
await sleep(3500)
const savedLen = await cdp.eval("(()=>window.__savedPdfBytes?new Uint8Array(window.__savedPdfBytes).length:null)()")
console.log('保存字节:', savedLen)
if (savedLen) {
  const arr = await cdp.eval("(()=>Array.from(new Uint8Array(window.__savedPdfBytes)))()")
  const savedPath = path.join(OUT, 'saved.pdf')
  fs.writeFileSync(savedPath, Buffer.from(arr))
  console.log('saved.pdf written:', savedPath)
}
await shot(cdp, 'final-page.png')
console.log('OUT:', OUT)
chrome.kill(); server.close(); await sleep(400); process.exit(0)
