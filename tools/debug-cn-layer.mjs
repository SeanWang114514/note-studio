// debug-cn-layer.mjs — 检查中文 PDF 文字层 DOM
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const APP_URL = 'http://127.0.0.1:5199/'

class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map() }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      }
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return r.result?.value
  }
}

const userData = path.join(os.tmpdir(), 'cn-layer-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9236', '--user-data-dir=' + userData,
  '--no-first-run', '--disable-gpu', '--disable-extensions', '--window-size=1500,950', 'about:blank',
], { stdio: 'ignore' })

let targets = []
for (let i = 0; i < 50; i++) {
  try { const res = await fetch('http://127.0.0.1:9236/json/list'); targets = await res.json(); if (targets.length) break } catch {}
  await new Promise(r => setTimeout(r, 200))
}
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open()
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Page.navigate', { url: APP_URL })
await new Promise(r => setTimeout(r, 4000))

const b64 = fs.readFileSync(path.join(ROOT, 'public', 'test-chinese.pdf')).toString('base64')
await cdp.eval("(() => { const bytes = Uint8Array.from(atob('" + b64 + "'), c => c.charCodeAt(0)); const file = new File([bytes], 'test-chinese.pdf', { type: 'application/pdf' }); const handle = { kind: 'file', name: 'test-chinese.pdf', getFile: async () => file, queryPermission: async () => 'granted', requestPermission: async () => 'granted', createWritable: async () => ({ write: async () => {}, close: async () => {} }) }; window.showOpenFilePicker = async () => [handle]; return 'ok' })()")
await cdp.eval("(() => { const b = [...document.querySelectorAll('button')].find(x => /打开文件/.test(x.textContent||'')); b?.click(); return 'ok' })()")
await new Promise(r => setTimeout(r, 5000))

const info = await cdp.eval("(() => {
  const layer = document.querySelector('.pdf-text-layer')
  if (!layer) return { layer: null }
  const spans = [...layer.querySelectorAll('span')]
  return {
    layerClass: layer.className,
    spanCount: spans.length,
    spanTexts: spans.map(s => s.textContent).slice(0, 10),
    hasMarkedContent: layer.querySelectorAll('.markedContent').length,
    html: layer.innerHTML.slice(0, 500),
  }
})()")
console.log('文字层:', JSON.stringify(info, null, 1))
chrome.kill()
process.exit(0)
