// acrobat-edit-chinese.mjs — 中文 PDF 编辑测试
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const APP_URL = 'http://127.0.0.1:5199/'
const PDF_PATH = path.join(ROOT, 'public', 'test-chinese.pdf')
const OUT_DIR = path.join(os.tmpdir(), 'acrobat-cn-' + Date.now())
fs.mkdirSync(OUT_DIR, { recursive: true })

class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.listeners = new Map() }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      } else if (msg.method) {
        (this.listeners.get(msg.method) || []).forEach((fn) => fn(msg.params))
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
  on(method, fn) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(fn) }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result?.value
  }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  const userData = path.join(os.tmpdir(), 'acrobat-cn-profile-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9235', '--user-data-dir=' + userData,
    '--no-first-run', '--disable-gpu', '--disable-extensions', '--window-size=1500,950', 'about:blank',
  ], { stdio: 'ignore' })

  let targets = []
  for (let i = 0; i < 50; i++) {
    try { const res = await fetch('http://127.0.0.1:9235/json/list'); targets = await res.json(); if (targets.length) break } catch {}
    await sleep(200)
  }
  const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  const errors = []
  cdp.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text))

  await cdp.send('Page.navigate', { url: APP_URL })
  await sleep(4000)

  const b64 = fs.readFileSync(PDF_PATH).toString('base64')
  await cdp.eval("(() => { const bytes = Uint8Array.from(atob('" + b64 + "'), c => c.charCodeAt(0)); const file = new File([bytes], 'test-chinese.pdf', { type: 'application/pdf' }); const handle = { kind: 'file', name: 'test-chinese.pdf', getFile: async () => file, queryPermission: async () => 'granted', requestPermission: async () => 'granted', createWritable: async () => { let buf = null; return { write: async (data) => { buf = data }, close: async () => { window.__savedPdfBytes = buf } } } }; window.showOpenFilePicker = async () => [handle]; return 'ok' })()")
  const clickResult = await cdp.eval("(() => { const b = [...document.querySelectorAll('button')].find(x => /打开文件/.test(x.textContent||'')); if (!b) return 'no-button'; b.click(); return 'clicked' })()")
  console.log('点击打开文件:', clickResult)
  await sleep(6000)

  const state = await cdp.eval("(() => ({ hasViewer: !!document.querySelector('.pdf-viewer-shell'), pages: document.querySelectorAll('.pdf-page').length, canvases: document.querySelectorAll('.pdf-canvas').length, textLayers: document.querySelectorAll('.pdf-text-layer').length, errText: document.querySelector('.file-error')?.textContent || '', spans: [...document.querySelectorAll('.pdf-text-layer span[data-page]')].map(s => s.textContent).filter(t => t.trim()) }))()")
  console.log('打开状态:', JSON.stringify(state, null, 1))
  if (!state.spans.length) {
    const dump = await cdp.eval("(() => { const layer = document.querySelector('.pdf-text-layer'); return { hasLayer: !!layer, layerHtml: layer ? layer.innerHTML.slice(0, 800) : 'none', allSpans: layer ? [...layer.querySelectorAll('span')].length : 0 } })()")
    console.log('文字层 DOM:', JSON.stringify(dump, null, 1))
  }

  const pos = await cdp.eval("(() => { const spans = [...document.querySelectorAll('.pdf-text-layer span[data-page]')].filter(s => s.textContent.trim()); if (!spans.length) return { ok: false }; const t = spans[0]; const r = t.getBoundingClientRect(); return { ok: true, cx: r.left + r.width/2, cy: r.top + r.height/2, text: t.textContent } })()")
  console.log('点击第一行:', JSON.stringify(pos))
  if (!pos.ok) { chrome.kill(); process.exit(0) }

  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.cx, y: pos.cy, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.cx, y: pos.cy, button: 'left', clickCount: 1 })
  await sleep(800)

  const editState = await cdp.eval("(() => { const box = document.querySelector('.pdf-inline-editor'); return { open: !!box, text: box?.innerText || '', fontSize: box ? getComputedStyle(box).fontSize : '' } })()")
  console.log('中文编辑框:', JSON.stringify(editState, null, 1))

  const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT_DIR, '1-cn-editing.png'), Buffer.from(shot1.data, 'base64'))

  if (!editState.open) {
    console.log('编辑框未打开！')
    if (errors.length) errors.slice(0, 3).forEach(e => console.log('[异常]', e.slice(0, 300)))
    chrome.kill(); process.exit(0)
  }

  // 在光标位置输入中文（模拟 IME 提交）
  const insertText = await cdp.eval("(() => { const box = document.querySelector('.pdf-inline-editor'); box.focus(); const sel = window.getSelection(); const range = document.createRange(); range.selectNodeContents(box); range.collapse(false); sel.removeAllRanges(); sel.addRange(range); document.execCommand('insertText', false, '【新增】'); return box.innerText })()")
  console.log('插入中文后:', JSON.stringify({ text: insertText }))

  const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT_DIR, '2-cn-inserted.png'), Buffer.from(shot2.data, 'base64'))

  // 提交并保存
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 60, y: 500, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 60, y: 500, button: 'left', clickCount: 1 })
  await sleep(500)
  await cdp.eval("(() => { const b = [...document.querySelectorAll('.pdf-toolbar .tool-btn')].find(x => /保存到 PDF/.test(x.textContent||'')); b?.click(); return 'ok' })()")
  await sleep(2500)

  const savedBytes = await cdp.eval("(() => window.__savedPdfBytes ? new Uint8Array(window.__savedPdfBytes).length : null)()")
  console.log('保存字节数:', savedBytes)
  if (savedBytes) {
    const arr = await cdp.eval("(() => Array.from(new Uint8Array(window.__savedPdfBytes)))()")
    const savedFile = path.join(OUT_DIR, 'saved-cn.pdf')
    fs.writeFileSync(savedFile, Buffer.from(arr))
    console.log('saved-cn.pdf:', fs.statSync(savedFile).size, 'bytes')
  }

  if (errors.length) { console.log('\n=== 异常 ==='); errors.slice(0, 5).forEach(e => console.log(e.slice(0, 300))) }
  console.log('输出目录:', OUT_DIR)
  chrome.kill()
}

main().catch((e) => { console.error('测试失败:', e); process.exit(1) })