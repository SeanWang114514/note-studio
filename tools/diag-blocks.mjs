// diag-blocks.mjs — 诊断段落聚合结构：点击不同行，看编辑框覆盖范围
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
const PORT = 5310
const PDF_PATH = path.join(ROOT, 'public', 'manual.pdf')
const OUT_DIR = path.join(os.tmpdir(), 'diag-blocks-' + Date.now())
fs.mkdirSync(OUT_DIR, { recursive: true })

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

const userData = path.join(os.tmpdir(), 'diagblocks-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9331', '--user-data-dir=' + userData, '--no-first-run', '--disable-gpu', '--disable-extensions', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9331/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
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

const spans = await cdp.eval("(()=>{const ss=[...document.querySelectorAll('.pdf-text-layer span[data-page=\"1\"]')].filter(s=>s.textContent.trim());return ss.slice(0,30).map((s,i)=>{const r=s.getBoundingClientRect();return{i,y:Math.round(r.top),h:Math.round(r.height),x:Math.round(r.left),t:s.textContent.slice(0,24)}})})()")
console.log('=== spans (page1, first 30) ===')
for (const s of spans) console.log(JSON.stringify(s))

async function clickSpan(idx) {
  const st = await cdp.eval("((idx)=>{const ss=[...document.querySelectorAll('.pdf-text-layer span[data-page=\"1\"]')].filter(s=>s.textContent.trim());const s=ss[idx];if(!s)return null;const r=s.getBoundingClientRect();return{x:r.left+Math.min(r.width/2,30),y:r.top+r.height/2}})(" + idx + ")")
  if (!st) { console.log('span#' + idx + ' missing'); return }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: st.x, y: st.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: st.x, y: st.y, button: 'left', clickCount: 1 })
  await sleep(900)
  const ed = await cdp.eval("(()=>{const pos=document.querySelector('.pdf-inline-editor-pos');const box=document.querySelector('.pdf-inline-editor');if(!pos)return{open:false};const pr=pos.getBoundingClientRect();const page=document.querySelector('.pdf-page');const prPage=page.getBoundingClientRect();return{open:true,boxText:(box?.innerText||'').slice(0,90).replace(/\n/g,'|'),boxLines:(box?.innerText||'').split('\n').length,posInPage:{l:Math.round(pr.left-prPage.left),t:Math.round(pr.top-prPage.top),w:Math.round(pr.width),h:Math.round(pr.height)},pageH:Math.round(prPage.height)}})()")
  console.log('click span#' + idx + ' →', JSON.stringify(ed))
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT_DIR, 'click-' + idx + '.png'), Buffer.from(shot.data, 'base64'))
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
  await sleep(400)
}

await clickSpan(0)
await clickSpan(Math.floor(spans.length / 2))
await clickSpan(spans.length - 1)
console.log('OUT_DIR:', OUT_DIR)
cdp.close(); chrome.kill(); server.close()
await sleep(500)
process.exit(0)
