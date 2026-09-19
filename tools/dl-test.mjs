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
  async open() { await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej }); this.ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) } else if (msg.method === 'Page.downloadWillBegin') { console.log('DOWNLOAD:', JSON.stringify(msg.params)) } else if (msg.method === 'Page.downloadProgress') { console.log('DL PROG:', JSON.stringify(msg.params.state), msg.params.receivedBytes) } } }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r && r.exceptionDetails) return { __exception: r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text }; return r && r.result && r.result.value }
  close() { try { this.ws.close() } catch {} }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userData = path.join(os.tmpdir(), 'dl-' + Date.now())
const dlDir = path.join(os.tmpdir(), 'dls-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(dlDir, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9298', '--user-data-dir=' + userData, '--no-first-run', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--window-size=1600,1200', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9298/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open();
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
// 设置下载路径
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true })
await cdp.send('Page.navigate', { url: APP_URL });
await sleep(4000)
const b64 = fs.readFileSync(path.join(ROOT, 'public', PDF)).toString('base64')
await cdp.eval('(() => { const bytes = Uint8Array.from(atob("' + b64 + '"), c => c.charCodeAt(0)); const file = new File([bytes], "' + PDF + '", { type: "application/pdf" }); const handle = { kind: "file", name: "' + PDF + '", getFile: async () => file, queryPermission: async () => "granted", requestPermission: async () => "granted", createWritable: async () => ({ write: async () => {}, close: async () => {} }) }; window.showOpenFilePicker = async () => [handle]; return "ok" })()')
await cdp.eval('(() => { const b = [...document.querySelectorAll("button")].find(x => /打开文件/.test(x.textContent||"")); b?.click(); return "ok" })()')
let pagesLoaded = 0;
for (let i = 0; i < 25; i++) { const cnt = await cdp.eval('document.querySelectorAll(".pdf-page").length'); if (typeof cnt === "number" && cnt >= 9) { pagesLoaded = cnt; break } await sleep(1000) }
console.log('PAGES:', pagesLoaded)
if (!pagesLoaded) { cdp.close(); chrome.kill(); process.exit(0) }
await cdp.eval('(() => { const p1 = [...document.querySelectorAll(".pdf-page")].find(x => x.dataset.page === "1"); if (p1) p1.scrollIntoView({block:"start"}); return "ok" })()')
await sleep(1500)
// 点击'所有同学'
const info = await cdp.eval('(function(){ var spans = document.querySelectorAll(".pdf-text-layer span[data-page]"); for (var i=0;i<spans.length;i++){ var s = spans[i]; var t = s.textContent || ""; if (t.indexOf("所有同学") >= 0 && t.length < 40) { var r = s.getBoundingClientRect(); return { found: true, text: t.slice(0,30), click: { x: r.left + r.width/2, y: r.top + r.height/2 } } } } return { found: false } })()')
console.log('TARGET:', JSON.stringify(info))
if (!info.found) { cdp.close(); chrome.kill(); process.exit(0) }
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.click.x, y: info.click.y, button: 'left', clickCount: 1 })
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.click.x, y: info.click.y, button: 'left', clickCount: 1 })
await sleep(1000)
// 修改文字
await cdp.eval('(function(){ var box = document.querySelector(".pdf-inline-editor"); if (!box) return "no box"; box.focus(); var sel = window.getSelection(); sel.selectAllChildren(box); document.execCommand("insertText", false, "修改后测试"); return "done" })()')
await sleep(300)
// 找'保存到 PDF'按钮点击
const saveBtn = await cdp.eval('(function(){ var b = [...document.querySelectorAll("button")].find(x => (x.textContent||"").indexOf("保存到") >= 0 && (x.textContent||"").indexOf("PDF") >= 0); if (!b) return { found: false }; b.click(); return { found: true, text: b.textContent } })()')
console.log('SAVE BTN:', JSON.stringify(saveBtn))
await sleep(5000)
// 检查下载目录
const files = fs.readdirSync(dlDir).filter(f => f.endsWith('.pdf'))
console.log('DOWNLOADED:', JSON.stringify(files))
if (files.length) {
  const dlFile = path.join(dlDir, files[0])
  const dlBytes = fs.readFileSync(dlFile)
  console.log('SIZE:', dlBytes.length)
  // 复制到项目目录检查
  fs.writeFileSync(path.join(ROOT, 'tmp', 'saved-check.pdf'), dlBytes)
  console.log('copied to tmp/saved-check.pdf')
}
cdp.close(); chrome.kill(); await sleep(800)
try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
process.exit(0)
