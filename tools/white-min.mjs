import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const APP_URL = 'http://127.0.0.1:5173/'
class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map() }
  async open() { await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej }); this.ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) } } }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r && r.exceptionDetails) return { __exception: r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text }; return r && r.result && r.result.value }
  close() { try { this.ws.close() } catch {} }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userData = path.join(os.tmpdir(), 'min-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9285', '--user-data-dir=' + userData, '--no-first-run', '--disable-gpu', '--disable-extensions', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9285/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open()
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')
// 先打开页面
await cdp.send('Page.navigate', { url: APP_URL })
await sleep(6000)
// 测试 main.jsx 能否执行
const test = await cdp.eval('(function(){try{var React=window.React;var createRoot=window.ReactDOM?.createRoot;var root=document.getElementById("root");return{React:!!React,createRoot:!!createRoot,rootEmpty:root?root.children.length===0:false,appMounted:!!document.querySelector(".app-container, .app, [class*=app]")||!!document.querySelector("header, nav, main")}}catch(e){return{err:e.message}}})()')
console.log('TEST:', JSON.stringify(test))
// 直接检查脚本标签
const scripts = await cdp.eval('(function(){var s=document.querySelectorAll("script[type=module]");return{count:s.length,srcs:[].slice.call(s).map(function(x){return x.src})}})()')
console.log('SCRIPTS:', JSON.stringify(scripts))
// 手动触发 main.jsx
const manual = await cdp.eval('(function(){try{var mod=document.querySelector("script[type=module]");if(mod){var ev=new Event("load");window.dispatchEvent(ev);return"dispatched"}return"no script"}catch(e){return{err:e.message}}})()')
console.log('MANUAL:', JSON.stringify(manual))
await sleep(1000)
const after = await cdp.eval('(function(){var r=document.getElementById("root");return{innerHTML:r?r.innerHTML.slice(0,200):"no root",children:r?r.children.length:0}})()')
console.log('AFTER:', JSON.stringify(after))
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(path.join(ROOT, 'tmp', 'white-min.png'), Buffer.from(shot.data, 'base64'))
console.log('screenshot: tmp/white-min.png')
cdp.close(); chrome.kill(); await sleep(800)
try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
process.exit(0)
