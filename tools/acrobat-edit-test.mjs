// acrobat-edit-test.mjs — CDP 端到端测试：Acrobat 级文字编辑
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const APP_URL = 'http://127.0.0.1:5199/'
const PDF_PATH = path.join(ROOT, 'public', 'test-text.pdf')
const OUT_DIR = path.join(os.tmpdir(), 'acrobat-test-' + Date.now())
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
  const userData = path.join(os.tmpdir(), 'acrobat-profile-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9231', '--user-data-dir=' + userData,
    '--no-first-run', '--disable-gpu', '--disable-extensions', '--window-size=1500,950', 'about:blank',
  ], { stdio: 'ignore' })

  let targets = []
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9231/json/list')
      targets = await res.json()
      if (targets.length) break
    } catch { /* retry */ }
    await sleep(200)
  }
  if (!targets.length) { console.error('Chrome CDP 未就绪'); process.exit(1) }
  const cdp = new CDP((targets.find((t) => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  const errors = []
  cdp.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text))
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const txt = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
    if (/error/i.test(txt)) console.log('[console]', txt.slice(0, 400))
  })

  await cdp.send('Page.navigate', { url: APP_URL })
  await sleep(4000)

  const home = await cdp.eval("(() => ({ title: document.title, hasOpenBtn: !!([...document.querySelectorAll('button')].find(b => /打开文件/.test(b.textContent||''))) }))()")
  console.log('首页:', JSON.stringify(home))

  // Mock showOpenFilePicker（字节保存在 window，落盘在 Node 侧）
  const pdfBytes = fs.readFileSync(PDF_PATH)
  const b64 = pdfBytes.toString('base64')
  await cdp.eval("(() => { const bytes = Uint8Array.from(atob('" + b64 + "'), c => c.charCodeAt(0)); const file = new File([bytes], 'test-text.pdf', { type: 'application/pdf' }); const handle = { kind: 'file', name: 'test-text.pdf', getFile: async () => file, queryPermission: async () => 'granted', requestPermission: async () => 'granted', createWritable: async () => { let buf = null; return { write: async (data) => { buf = data }, close: async () => { window.__savedPdfBytes = buf } } } }; window.showOpenFilePicker = async () => [handle]; return 'mock-ok' })()")

  await cdp.eval("(() => { const b = [...document.querySelectorAll('button')].find(x => /打开文件/.test(x.textContent||'')); if (b) { b.click(); return 'clicked' } return 'not-found' })()")
  await sleep(5000)

  const state = await cdp.eval("(() => ({ hasViewer: !!document.querySelector('.pdf-viewer-shell'), pages: document.querySelectorAll('.pdf-page').length, spans: [...document.querySelectorAll('.pdf-text-layer span[data-page]')].map(s => s.textContent).filter(t => t.trim()) }))()")
  console.log('打开后:', JSON.stringify(state, null, 1))

  const shot0 = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT_DIR, '0-opened.png'), Buffer.from(shot0.data, 'base64'))

  if (!state.hasViewer) {
    console.log('PDF 未打开')
    if (errors.length) errors.slice(0, 5).forEach(e => console.log('[异常]', e.slice(0, 300)))
    chrome.kill()
    process.exit(0)
  }

  // 单击文字 → 编辑框 + 光标定位
  const clickInfo = await cdp.eval("(() => { const spans = [...document.querySelectorAll('.pdf-text-layer span[data-page]')].filter(s => s.textContent.trim()); if (!spans.length) return { ok: false }; const t = spans[0]; const r = t.getBoundingClientRect(); return { ok: true, cx: r.left + r.width/2, cy: r.top + r.height/2, text: t.textContent } })()")
  console.log('点击目标:', JSON.stringify(clickInfo))
  if (!clickInfo.ok) { chrome.kill(); process.exit(0) }

  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickInfo.cx, y: clickInfo.cy, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickInfo.cx, y: clickInfo.cy, button: 'left', clickCount: 1 })
  await sleep(800)

  const editState = await cdp.eval("(() => { const box = document.querySelector('.pdf-inline-editor'); return { editorOpen: !!box, editorText: box?.innerText || '', caretOffset: (() => { const s = window.getSelection(); return s ? s.anchorOffset : -1 })(), activeEl: document.activeElement?.className || '' } })()")
  console.log('编辑框:', JSON.stringify(editState, null, 1))

  if (!editState.editorOpen) {
    console.log('编辑框未打开！')
    if (errors.length) errors.slice(0, 5).forEach(e => console.log('[异常]', e.slice(0, 300)))
    chrome.kill()
    process.exit(0)
  }

  // 输入 "!!" 测试插入
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '!', code: 'Digit1', text: '!' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '!', code: 'Digit1' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '!', code: 'Digit1', text: '!' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '!', code: 'Digit1' })
  await sleep(400)

  const afterType = await cdp.eval("(() => ({ editorText: document.querySelector('.pdf-inline-editor')?.innerText || '' }))()")
  console.log('输入后:', JSON.stringify(afterType))

  const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT_DIR, '1-editing.png'), Buffer.from(shot1.data, 'base64'))

  // 点击空白处提交（Word 风格自动保存）
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 80, y: 350, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 80, y: 350, button: 'left', clickCount: 1 })
  await sleep(600)

  const committed = await cdp.eval("(() => ({ editorClosed: !document.querySelector('.pdf-inline-editor'), editedSpans: document.querySelectorAll('.pdf-text-layer span.edited').length }))()")
  console.log('提交后:', JSON.stringify(committed))

  const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT_DIR, '2-committed.png'), Buffer.from(shot2.data, 'base64'))

  // 跨行多选测试：切到光标模式，从第一行拖到第二行
  await cdp.eval("(() => { const btns = [...document.querySelectorAll('.pdf-toolbar .tool-btn')]; const b = btns.find(x => /光标/.test(x.textContent||'')); b?.click(); return 'ok' })()")
  await sleep(400)
  const selInfo = await cdp.eval("(() => { const spans = [...document.querySelectorAll('.pdf-text-layer span[data-page]')].filter(s => s.textContent.trim()); if (spans.length < 2) return { ok: false }; const r1 = spans[0].getBoundingClientRect(); const r2 = spans[spans.length-1].getBoundingClientRect(); return { ok: true, x1: r1.left + 2, y1: r1.top + r1.height/2, x2: r2.right - 2, y2: r2.top + r2.height/2 } })()")
  if (selInfo.ok) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: selInfo.x1, y: selInfo.y1, button: 'left', clickCount: 1 })
    for (let i = 1; i <= 10; i++) {
      const x = selInfo.x1 + (selInfo.x2 - selInfo.x1) * i / 10
      const y = selInfo.y1 + (selInfo.y2 - selInfo.y1) * i / 10
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
      await sleep(30)
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: selInfo.x2, y: selInfo.y2, button: 'left' })
    await sleep(400)
    const selResult = await cdp.eval("(() => { const s = window.getSelection(); return { text: s?.toString() || '', collapsed: s?.isCollapsed ?? true } })()")
    console.log('跨行多选:', JSON.stringify(selResult))
    const shot3 = await cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT_DIR, '3-multiselect.png'), Buffer.from(shot3.data, 'base64'))
  }

  // 保存到 PDF
  await cdp.eval("(() => { const b = [...document.querySelectorAll('.pdf-toolbar .tool-btn')].find(x => /保存到 PDF/.test(x.textContent||'')); b?.click(); return 'ok' })()")
  await sleep(2500)

  const savedBytes = await cdp.eval("(() => window.__savedPdfBytes ? new Uint8Array(window.__savedPdfBytes).length : null)()")
  console.log('保存字节数:', savedBytes)
  if (savedBytes) {
    const arr = await cdp.eval("(() => Array.from(new Uint8Array(window.__savedPdfBytes)))()")
    const savedFile = path.join(OUT_DIR, 'saved.pdf')
    fs.writeFileSync(savedFile, Buffer.from(arr))
    console.log('saved.pdf 已写入:', fs.statSync(savedFile).size, 'bytes')
  }

  if (errors.length) {
    console.log('\n=== 页面异常 ===')
    errors.slice(0, 5).forEach(e => console.log(e.slice(0, 300)))
  }

  console.log('输出目录:', OUT_DIR)
  chrome.kill()
}

main().catch((e) => { console.error('测试失败:', e); process.exit(1) })
