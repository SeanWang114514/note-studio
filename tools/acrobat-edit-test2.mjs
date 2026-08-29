// acrobat-edit-test2.mjs — 综合测试：多行段落聚合 + 编辑框内跨行多选 + 回车换行
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const APP_URL = 'http://127.0.0.1:5199/'
const PDF_PATH = path.join(ROOT, 'public', 'test-multiline.pdf')
const OUT_DIR = path.join(os.tmpdir(), 'acrobat-test2-' + Date.now())
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
  const userData = path.join(os.tmpdir(), 'acrobat-profile2-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9233', '--user-data-dir=' + userData,
    '--no-first-run', '--disable-gpu', '--disable-extensions', '--window-size=1500,950', 'about:blank',
  ], { stdio: 'ignore' })

  let targets = []
  for (let i = 0; i < 50; i++) {
    try { const res = await fetch('http://127.0.0.1:9233/json/list'); targets = await res.json(); if (targets.length) break } catch {}
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

  const pdfBytes = fs.readFileSync(PDF_PATH)
  const b64 = pdfBytes.toString('base64')
  await cdp.eval("(() => { const bytes = Uint8Array.from(atob('" + b64 + "'), c => c.charCodeAt(0)); const file = new File([bytes], 'test-multiline.pdf', { type: 'application/pdf' }); const handle = { kind: 'file', name: 'test-multiline.pdf', getFile: async () => file, queryPermission: async () => 'granted', requestPermission: async () => 'granted', createWritable: async () => { let buf = null; return { write: async (data) => { buf = data }, close: async () => { window.__savedPdfBytes = buf } } } }; window.showOpenFilePicker = async () => [handle]; return 'ok' })()")
  await cdp.eval("(() => { const b = [...document.querySelectorAll('button')].find(x => /打开文件/.test(x.textContent||'')); b?.click(); return 'ok' })()")
  await sleep(5000)

  // 检查打开后：应该有 4 行 span
  const state = await cdp.eval("(() => ({ pages: document.querySelectorAll('.pdf-page').length, spans: [...document.querySelectorAll('.pdf-text-layer span[data-page]')].map(s => s.textContent).filter(t => t.trim()) }))()")
  console.log('打开后 spans:', JSON.stringify(state.spans))

  // 编辑模式默认：单击第一行
  const firstSpan = await cdp.eval("(() => { const spans = [...document.querySelectorAll('.pdf-text-layer span[data-page]')].filter(s => s.textContent.trim()); const t = spans[0]; const r = t.getBoundingClientRect(); return { cx: r.left + r.width/2, cy: r.top + r.height/2, text: t.textContent } })()")
  console.log('单击第一行:', JSON.stringify(firstSpan))
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: firstSpan.cx, y: firstSpan.cy, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: firstSpan.cx, y: firstSpan.cy, button: 'left', clickCount: 1 })
  await sleep(800)

  // 编辑框应包含所有 4 行（段落聚合）
  const editState = await cdp.eval("(() => { const box = document.querySelector('.pdf-inline-editor'); return { open: !!box, text: box?.innerText || '', rect: box ? (() => { const r = box.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height } })() : null } })()")
  console.log('编辑框:', JSON.stringify(editState, null, 1))

  if (!editState.open) { console.log('编辑框未打开！'); if (errors.length) errors.slice(0,3).forEach(e=>console.log(e.slice(0,200))); chrome.kill(); process.exit(0) }

  // 截图：段落聚合的编辑框
  const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT_DIR, '1-block-editor.png'), Buffer.from(shot1.data, 'base64'))

  // 在编辑框内拖拽多选：从第一行开头拖到第四行末尾
  const boxRect = editState.rect
  // 编辑器内容文本行高
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: boxRect.l + 5, y: boxRect.t + 4, button: 'left', clickCount: 1 })
  // 拖到框右下角（4行都选中）
  for (let i = 1; i <= 10; i++) {
    const x = boxRect.l + 5 + (boxRect.w - 10) * i / 10
    const y = boxRect.t + 4 + (boxRect.h - 8) * i / 10
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    await sleep(30)
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: boxRect.l + boxRect.w - 5, y: boxRect.t + boxRect.h - 4, button: 'left' })
  await sleep(400)

  const sel = await cdp.eval("(() => { const s = window.getSelection(); return { text: s?.toString() || '', collapsed: s?.isCollapsed ?? true, inEditor: !!document.activeElement?.classList?.contains('pdf-inline-editor') } })()")
  console.log('编辑框内多选:', JSON.stringify(sel, null, 1))

  const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT_DIR, '2-in-editor-select.png'), Buffer.from(shot2.data, 'base64'))

  // 回车换行测试：点击第一行行尾，按 Enter
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: boxRect.l + boxRect.w - 10, y: boxRect.t + 6, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: boxRect.l + boxRect.w - 10, y: boxRect.t + 6, button: 'left', clickCount: 1 })
  await sleep(200)
  // 按 Home 到行首再回车 → 新行
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' })
  await sleep(300)
  const afterEnter = await cdp.eval("(() => ({ text: document.querySelector('.pdf-inline-editor')?.innerText || '' }))()")
  console.log('回车后文本行数:', JSON.stringify(afterEnter))

  const shot3 = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT_DIR, '3-after-enter.png'), Buffer.from(shot3.data, 'base64'))

  // 提交（点击空白）
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 60, y: 500, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 60, y: 500, button: 'left', clickCount: 1 })
  await sleep(500)
  const committed = await cdp.eval("(() => ({ closed: !document.querySelector('.pdf-inline-editor'), edited: document.querySelectorAll('.pdf-text-layer span.edited').length }))()")
  console.log('提交:', JSON.stringify(committed))

  // 保存
  await cdp.eval("(() => { const b = [...document.querySelectorAll('.pdf-toolbar .tool-btn')].find(x => /保存到 PDF/.test(x.textContent||'')); b?.click(); return 'ok' })()")
  await sleep(2500)
  const savedBytes = await cdp.eval("(() => window.__savedPdfBytes ? new Uint8Array(window.__savedPdfBytes).length : null)()")
  console.log('保存字节数:', savedBytes)
  if (savedBytes) {
    const arr = await cdp.eval("(() => Array.from(new Uint8Array(window.__savedPdfBytes)))()")
    const savedFile = path.join(OUT_DIR, 'saved2.pdf')
    fs.writeFileSync(savedFile, Buffer.from(arr))
    console.log('saved2.pdf:', fs.statSync(savedFile).size, 'bytes')
  }

  if (errors.length) { console.log('\n=== 异常 ==='); errors.slice(0, 5).forEach(e => console.log(e.slice(0, 300))) }
  console.log('输出目录:', OUT_DIR)
  chrome.kill()
}

main().catch((e) => { console.error('测试失败:', e); process.exit(1) })
