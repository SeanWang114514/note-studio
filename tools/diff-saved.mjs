// diff-saved.mjs — 原始 PDF vs 保存后 PDF 同缩放整页逐行像素 diff
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
const PORT = 5315
const OUT = path.join(ROOT, 'tmp', 'diff-saved-' + Date.now())
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
const userData = path.join(os.tmpdir(), 'diffsaved-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9345', '--user-data-dir=' + userData, '--no-first-run', '--disable-gpu', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9345/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open()
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' })
await sleep(5000)

async function openPdfAndHash(pdfPath) {
  const b64 = fs.readFileSync(pdfPath).toString('base64')

  // 每次打开前重置页面，保证 fitWidth 缩放一致
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' })
  await sleep(5000)
  await cdp.eval("(()=>{const bytes=Uint8Array.from(atob('" + b64 + "'),c=>c.charCodeAt(0));const file=new File([bytes],'doc.pdf',{type:'application/pdf'});const handle={kind:'file',name:'doc.pdf',getFile:async()=>file,queryPermission:async()=>'granted',requestPermission:async()=>'granted',createWritable:async()=>{return{write:async(d)=>{},close:async()=>{}}}};window.showOpenFilePicker=async()=>[handle];return 'ok'})()")
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/打开文件/.test(x.textContent||''));b?.click();return 'ok'})()")
  await sleep(8000)
  // 逐行 diff：取 base canvas 内部像素，按行统计差异像素数
  const bands = await cdp.eval("(()=>{const cv=document.querySelector('.pdf-page .pdf-canvas');if(!cv)return null;const w=cv.width,h=cv.height;return{w,h}})()")
  if (!bands) { console.log('no canvas'); return null }
  // 用两次渲染的像素数据直接在页面里比对需要缓存第一次 → 返回每行哈希
  const rowHash = await cdp.eval("(()=>{const cv=document.querySelector('.pdf-page .pdf-canvas');const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;const w=cv.width,h=cv.height;const rows=[];for(let y=0;y<h;y+=2){let s=0;for(let x=0;x<w;x+=4){const i=(y*w+x)*4;s=(s*31+img0(i))|0}function img0(i){return (d[i]&31)+((d[i+1]&31)<<5)+((d[i+2]&31)<<10)}rows.push(s|0)}return rows})()")
  return rowHash
}

const h1 = await openPdfAndHash(process.argv[2])
console.log('orig rows:', h1 ? h1.length : 'fail')
const h2 = await openPdfAndHash(process.argv[3])
console.log('saved rows:', h2 ? h2.length : 'fail')
if (h1 && h2 && h1.length === h2.length) {
  const changed = []
  for (let i = 0; i < h1.length; i++) if (h1[i] !== h2[i]) changed.push(i * 2)
  // 合并连续行
  const bands = []
  for (const y of changed) {
    if (bands.length && y - bands[bands.length - 1][1] <= 4) bands[bands.length - 1][1] = y
    else bands.push([y, y])
  }
  console.log('差异行带(y0-y1, canvas px):', JSON.stringify(bands))
} else {
  console.log('高度不一致或打开失败，无法比较')
}
chrome.kill(); server.close(); await sleep(400); process.exit(0)
