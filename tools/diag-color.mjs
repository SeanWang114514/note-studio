// diag-color.mjs — 区分「颜色采样错误」vs「PNG 管线变灰」+ 测量文字宽度
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
const PORT = 5317
const PDF_PATH = path.join(ROOT, 'public', 'manual.pdf')
const OUT = path.join(ROOT, 'tmp', 'diag-color-' + Date.now())
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
const userData = path.join(os.tmpdir(), 'diagcolor-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9347', '--user-data-dir=' + userData, '--no-first-run', '--disable-gpu', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9347/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open()
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' })
await sleep(5000)
const b64 = fs.readFileSync(PDF_PATH).toString('base64')

await cdp.eval("(()=>{const bytes=Uint8Array.from(atob('" + b64 + "'),c=>c.charCodeAt(0));const file=new File([bytes],'manual.pdf',{type:'application/pdf'});const handle={kind:'file',name:'manual.pdf',getFile:async()=>file,queryPermission:async()=>'granted',requestPermission:async()=>'granted',createWritable:async()=>{let buf=null;return{write:async(d)=>{buf=d},close:async()=>{window.__savedPdfBytes=buf}}}};window.showOpenFilePicker=async()=>[handle];return 'ok'})()")
await cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/打开文件/.test(x.textContent||''));b?.click();return 'ok'})()")
await sleep(7000)

// span 颜色数据
const colorInfo = await cdp.eval("(()=>{const ss=[...document.querySelectorAll('.pdf-text-layer span[data-page=\"1\"]')].filter(s=>s.textContent.trim());const s=ss.find(x=>(x.textContent||'').startsWith('所有同学'));return{pdfColor:s?.dataset?.pdfColor,family:s?.dataset?.pdfFontFamily,actual:s?.dataset?.pdfActualFontName,fs:s?.style?.fontSize}})()")
console.log('span颜色数据:', JSON.stringify(colorInfo))

// 编辑该行并提交
const spanPt = "(()=>{const ss=[...document.querySelectorAll('.pdf-text-layer span[data-page=\"1\"]')].filter(s=>s.textContent.trim());const s=ss.find(x=>(x.textContent||'').startsWith('所有同学'));const r=s.getBoundingClientRect();return{x:r.left+Math.min(r.width/2,26),y:r.top+r.height/2}})()"
const pt = await cdp.eval(spanPt)
await clickAt(cdp, pt.x, pt.y); await sleep(900)
await cdp.send('Input.insertText', { text: '【测试编辑】' }); await sleep(300)
// 记录编辑行的行内样式（提交前的颜色）
const lineStyle = await cdp.eval("(()=>{const lines=[...document.querySelectorAll('.pdf-inline-editor [data-line]')];const l=lines.find(el=>el.textContent.includes('【测试编辑】'));return l?{color:l.style.color,family:l.style.fontFamily,size:l.style.fontSize,scrollW:l.scrollWidth,rectW:l.getBoundingClientRect().width}:null})()")
console.log('编辑行样式:', JSON.stringify(lineStyle))
const margin = await cdp.eval("(()=>{const pg=document.querySelector('.pdf-page');const r=pg.getBoundingClientRect();return{x:r.left+8,y:r.top+120}})()")
await clickAt(cdp, margin.x, margin.y); await sleep(900)

// 屏幕绘制层（editCanvas）band 最暗值
const screen = await cdp.eval("(()=>{const ec=document.querySelector('.pdf-page .pdf-edit-canvas');const ctx=ec.getContext('2d');const w=ec.width;function bandMinLum(y0,y1){const img=ctx.getImageData(0,y0,w,y1-y0).data;let mn=255,cnt=0;for(let i=0;i<img.length;i+=4){const l=0.299*img[i]+0.587*img[i+1]+0.114*img[i+2];if(img[i+3]>10){if(l<mn)mn=l;if(l<100)cnt++}}return{mn:Math.round(mn),darkCnt:cnt}}const b=bandMinLum(130,165);let right=-1;{const img=ctx.getImageData(0,130,w,35).data;for(let y=0;y<35;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;if(img[i+3]>10&&x>right)right=x}}return{...b,inkRight:right,canvasW:w}})()")
console.log('屏幕editCanvas band:', JSON.stringify(screen))

// 保存
await cdp.eval("(()=>{const b=[...document.querySelectorAll('.pdf-toolbar .tool-btn')].find(x=>/保存到 PDF/.test(x.textContent||''));b?.click();return 'ok'})()")
await sleep(3500)
const arr = await cdp.eval("(()=>Array.from(new Uint8Array(window.__savedPdfBytes)))()")
fs.writeFileSync(path.join(OUT, 'saved.pdf'), Buffer.from(arr))
console.log('OUT:', OUT)
chrome.kill(); server.close(); await sleep(400); process.exit(0)
