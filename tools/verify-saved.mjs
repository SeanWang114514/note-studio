// verify-saved.mjs — 打开保存后的 saved.pdf，验证写入内容在渲染层面的墨迹对齐
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
const PORT = 5314
const PDF_PATH = path.join(process.argv[2] || '')
const OUT = path.join(ROOT, 'tmp', 'verify-saved-' + Date.now())
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
const userData = path.join(os.tmpdir(), 'verifysaved-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9344', '--user-data-dir=' + userData, '--no-first-run', '--disable-gpu', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9344/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open()
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' })
await sleep(5000)
const b64 = fs.readFileSync(PDF_PATH).toString('base64')

await cdp.eval("(()=>{const bytes=Uint8Array.from(atob('" + b64 + "'),c=>c.charCodeAt(0));const file=new File([bytes],'saved.pdf',{type:'application/pdf'});const handle={kind:'file',name:'saved.pdf',getFile:async()=>file,queryPermission:async()=>'granted',requestPermission:async()=>'granted',createWritable:async()=>{return{write:async(d)=>{},close:async()=>{}}}};window.showOpenFilePicker=async()=>[handle];return 'ok'})()")
await cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/打开文件/.test(x.textContent||''));b?.click();return 'ok'})()")
await sleep(8000)
// 正文第一行 band 的暗像素墨迹（编辑后的行）
const ink = await cdp.eval("(()=>{const cv=document.querySelector('.pdf-page .pdf-canvas');const ctx=cv.getContext('2d');const y0=128,y1=166,w=cv.width;const img=ctx.getImageData(0,y0,w,y1-y0).data;let minX=1e9,minY=1e9,maxX=-1,maxY=-1;for(let y=0;y<y1-y0;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;const lum=0.299*img[i]+0.587*img[i+1]+0.114*img[i+2];if(img[i+3]>10&&lum<170){if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y}}return maxX<0?null:{minX,minY:minY+y0,maxX,maxY:maxY+y0}})()")
console.log('saved.pdf 编辑行墨迹bbox:', JSON.stringify(ink))
// 编辑行是否含插入文字（宽点：与原 846 比）
const s = await cdp.send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(path.join(OUT, 'saved-page1.png'), Buffer.from(s.data, 'base64'))
console.log('OUT:', OUT)
chrome.kill(); server.close(); await sleep(400); process.exit(0)
