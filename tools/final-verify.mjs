import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const APP_URL = 'http://127.0.0.1:5199/'
const PDF = 'manual.pdf'
class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map() }
  async open() { await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej }); this.ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) } } }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r && r.exceptionDetails) return { __exception: r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text }; return r && r.result && r.result.value }
  close() { try { this.ws.close() } catch {} }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userData = path.join(os.tmpdir(), 'final-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9308', '--user-data-dir=' + userData, '--no-first-run', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--window-size=1600,1200', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9308/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open();
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url: APP_URL });
await sleep(4000)
const b64 = fs.readFileSync(path.join(ROOT, 'public', PDF)).toString('base64')
await cdp.eval('(() => { const bytes = Uint8Array.from(atob("' + b64 + '"), c => c.charCodeAt(0)); const file = new File([bytes], "' + PDF + '", { type: "application/pdf" }); const handle = { kind: "file", name: "' + PDF + '", getFile: async () => file, queryPermission: async () => "granted", requestPermission: async () => "granted", createWritable: async () => ({ write: async () => {}, close: async () => {} }) }; window.showOpenFilePicker = async () => [handle]; return "ok" })()')
await cdp.eval('(() => { const b = [...document.querySelectorAll("button")].find(x => /打开文件/.test(x.textContent||"")); b?.click(); return "ok" })()')
let pagesLoaded = 0;
for (let i = 0; i < 25; i++) { const cnt = await cdp.eval('document.querySelectorAll(".pdf-page").length'); if (typeof cnt === "number" && cnt >= 9) { pagesLoaded = cnt; break } await sleep(1000) }
console.log('PAGES:', pagesLoaded)
// 点击'所有同学'行
const info = await cdp.eval('(function(){ var spans = document.querySelectorAll(".pdf-text-layer span[data-page]"); for (var i=0;i<spans.length;i++){ var s = spans[i]; var t = s.textContent || ""; if (t.indexOf("所有同学") >= 0 && t.length < 40) { var r = s.getBoundingClientRect(); return { found: true, click: { x: r.left + r.width/2, y: r.top + r.height/2 } } } } return { found: false } })()')
console.log('TARGET:', JSON.stringify(info))
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.click.x, y: info.click.y, button: 'left', clickCount: 1 })
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.click.x, y: info.click.y, button: 'left', clickCount: 1 })
await sleep(800)
// 修改文字：把 URL 改短（模拟用户编辑）
await cdp.eval('(function(){ var box = document.querySelector(".pdf-inline-editor"); if (!box) return "no box"; box.focus(); var sel = window.getSelection(); sel.selectAllChildren(box); document.execCommand("insertText", false, "1.所有同学登录网站测试URL"); return "done" })()')
await sleep(300)
// 提交（点击页面空白）
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 50, y: 1000, button: 'left', clickCount: 1 })
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 50, y: 1000, button: 'left', clickCount: 1 })
await sleep(1000)
// 检查 edit-canvas 绘制：白底是否精确覆盖原文字位置
const result = await cdp.eval('(function(){ var page = [...document.querySelectorAll(".pdf-page")].find(x => x.dataset.page === "1"); if (!page) return null; var ec = page.querySelector(".pdf-edit-canvas"); var layer = page.querySelector(".pdf-text-layer"); var ecr = ec.getBoundingClientRect(); var lr = layer.getBoundingClientRect(); var span = [...layer.querySelectorAll("span[data-page]" )].find(function(s){ return (s.textContent||"").indexOf("所有同学") >= 0 }); var sr = span ? span.getBoundingClientRect() : null; return { canvasCss: { w: ecr.width, h: ecr.height }, layerCss: { w: lr.width, h: lr.height }, spanRect: sr ? { left: sr.left, top: sr.top, w: sr.width, h: sr.height } : null, spanText: span ? span.textContent.slice(0, 20) : null, editedSpans: layer.querySelectorAll("span.edited").length } })()')
console.log('RESULT:', JSON.stringify(result, null, 1))
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(path.join(ROOT, 'tmp', 'final-verify.png'), Buffer.from(shot.data, 'base64'))
console.log('screenshot: tmp/final-verify.png')
cdp.close(); chrome.kill(); await sleep(800)
try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
process.exit(0)
