// inspect-band.mjs — 渲染 saved.pdf 第一页，放大导出编辑行 band + 量化墨迹浓度
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
const PORT = 5316
const OUT = path.join(ROOT, 'tmp', 'inspect-band-' + Date.now())
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
const userData = path.join(os.tmpdir(), 'inspectband-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9346', '--user-data-dir=' + userData, '--no-first-run', '--disable-gpu', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9346/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open()
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' })
await sleep(5000)
const b64 = fs.readFileSync(process.argv[2]).toString('base64')

await cdp.eval("(()=>{const bytes=Uint8Array.from(atob('" + b64 + "'),c=>c.charCodeAt(0));const file=new File([bytes],'saved.pdf',{type:'application/pdf'});const handle={kind:'file',name:'saved.pdf',getFile:async()=>file,queryPermission:async()=>'granted',requestPermission:async()=>'granted',createWritable:async()=>{return{write:async(d)=>{},close:async()=>{}}}};window.showOpenFilePicker=async()=>[handle];return 'ok'})()")
await cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/打开文件/.test(x.textContent||''));b?.click();return 'ok'})()")
await sleep(8000)
// 量化：编辑行 band vs 下一行 band 的最暗墨迹（0-255）
const lum = await cdp.eval("(()=>{const cv=document.querySelector('.pdf-page .pdf-canvas');const ctx=cv.getContext('2d');const w=cv.width;function bandMinLum(y0,y1){const img=ctx.getImageData(0,y0,w,y1-y0).data;let mn=255;for(let i=0;i<img.length;i+=4){const l=0.299*img[i]+0.587*img[i+1]+0.114*img[i+2];if(img[i+3]>10&&l<mn)mn=l}return Math.round(mn)}function bandInkRight(y0,y1){const img=ctx.getImageData(0,y0,w,y1-y0).data;let mx=-1;for(let y=0;y<y1-y0;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;const l=0.299*img[i]+0.587*img[i+1]+0.114*img[i+2];if(img[i+3]>10&&l<150&&x>mx)mx=x}return mx}return{editBandMinLum:bandMinLum(130,162),nextBandMinLum:bandMinLum(168,200),editInkRight:bandInkRight(130,162),canvasW:w,canvasH:cv.height}})()")
console.log('量化:', JSON.stringify(lum))
// 放大导出编辑行 band（3 倍）
const shotData = await cdp.eval("(()=>{const cv=document.querySelector('.pdf-page .pdf-canvas');const w=cv.width;const band=document.createElement('canvas');band.width=w*2;band.height=64;const bctx=band.getContext('2d');bctx.imageSmoothingEnabled=false;bctx.drawImage(cv,0,128,w,34,0,0,w*2,68);return band.toDataURL('image/png')})()")
fs.writeFileSync(path.join(OUT, 'edit-band-2x.png'), Buffer.from(shotData.split(',')[1], 'base64'))
// 导出下一行 band 对照
const shotData2 = await cdp.eval("(()=>{const cv=document.querySelector('.pdf-page .pdf-canvas');const w=cv.width;const band=document.createElement('canvas');band.width=w*2;band.height=64;const bctx=band.getContext('2d');bctx.imageSmoothingEnabled=false;bctx.drawImage(cv,0,168,w,34,0,0,w*2,68);return band.toDataURL('image/png')})()")
fs.writeFileSync(path.join(OUT, 'next-band-2x.png'), Buffer.from(shotData2.split(',')[1], 'base64'))
console.log('OUT:', OUT)
chrome.kill(); server.close(); await sleep(400); process.exit(0)
