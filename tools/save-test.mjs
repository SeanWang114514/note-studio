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
const userData = path.join(os.tmpdir(), 'savetest-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9297', '--user-data-dir=' + userData, '--no-first-run', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--window-size=1600,1200', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9297/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
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
// 检查编辑框尺寸（应只有一行高）
const ed = await cdp.eval('(function(){ var box = document.querySelector(".pdf-inline-editor"); if (!box) return null; var r = box.getBoundingClientRect(); return { width: r.width, height: r.height, lineCount: box.querySelectorAll("[data-line]").length, text: box.textContent.slice(0, 30) } })()')
console.log('EDITOR SIZE:', JSON.stringify(ed))
// 修改文字：在开头插入'修改后'
const mod = await cdp.eval('(function(){ var box = document.querySelector(".pdf-inline-editor"); if (!box) return "no box"; box.focus(); var sel = window.getSelection(); sel.selectAllChildren(box); document.execCommand("insertText", false, "修改后测试"); return "done" })()')
console.log('MODIFY:', mod)
await sleep(500)
// 提交编辑（点击其他位置或 Ctrl+S）
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 's', code: 'KeyS', modifiers: 2 })
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', modifiers: 2 })
await sleep(2000)
// 检查 textEdits 是否保存
const saved = await cdp.eval('(function(){ return window.__lastSaveInfo || "no save info" })()')
console.log('SAVED:', JSON.stringify(saved))
// 截图看效果
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(path.join(ROOT, 'tmp', 'save-test.png'), Buffer.from(shot.data, 'base64'))
console.log('screenshot: tmp/save-test.png')
cdp.close(); chrome.kill(); await sleep(800)
try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
process.exit(0)
