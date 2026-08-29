// acrobat-edit-persist.mjs — 编辑持久化测试：保存后重开验证 textEdit 回载
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
const OUT_DIR = path.join(os.tmpdir(), 'acrobat-persist-' + Date.now())
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
  const userData = path.join(os.tmpdir(), 'acrobat-persist-profile-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9237', '--user-data-dir=' + userData,
    '--no-first-run', '--disable-gpu', '--disable-extensions', '--window-size=1500,950', 'about:blank',
  ], { stdio: 'ignore' })

  let targets = []
  for (let i = 0; i < 50; i++) {
    try { const res = await fetch('http://127.0.0.1:9237/json/list'); targets = await res.json(); if (targets.length) break } catch {}
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

  // Mock 文件句柄（同文件两次打开）
  const b64 = fs.readFileSync(PDF_PATH).toString('base64')
  const mockExpr = "(() => { const bytes = Uint8Array.from(atob('" + b64 + "'), c => c.charCodeAt(0)); const file = new File([bytes], 'test-text.pdf', { type: 'application/pdf' }); const handle = { kind: 'file', name: 'test-text.pdf', getFile: async () => file, queryPermission: async () => 'granted', requestPermission: async () => 'granted', createWritable: async () => { let buf = null; return { write: async (data) => { buf = data }, close: async () => { window.__savedPdfBytes = buf } } } }; window.showOpenFilePicker = async () => [handle]; return 'ok' })()"
  await cdp.eval(mockExpr)
  await cdp.eval("(() => { const b = [...document.querySelectorAll('button')].find(x => /打开文件/.test(x.textContent||'')); b?.click(); return 'ok' })()")
  await sleep(5000)

  // 1) 编辑第一行：点击中间，插入 "!!"
  const pos = await cdp.eval("(() => { const spans = [...document.querySelectorAll('.pdf-text-layer span[data-page]')].filter(s => s.textContent.trim()); const t = spans[0]; const r = t.getBoundingClientRect(); return { cx: r.left + r.width/2, cy: r.top + r.height/2 } })()")
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.cx, y: pos.cy, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.cx, y: pos.cy, button: 'left', clickCount: 1 })
  await sleep(800)

  const beforeType = await cdp.eval("(() => document.querySelector('.pdf-inline-editor')?.innerText || '')()")
  // 移动到行尾再输入（简单：直接在末尾输入）
  await cdp.eval("(() => { const box = document.querySelector('.pdf-inline-editor'); box.focus(); const sel = window.getSelection(); const range = document.createRange(); range.selectNodeContents(box); range.collapse(false); sel.removeAllRanges(); sel.addRange(range); document.execCommand('insertText', false, '!!'); return box.innerText })()")
  const afterType = await cdp.eval("(() => document.querySelector('.pdf-inline-editor')?.innerText || '')()")
  console.log('编辑:', JSON.stringify({ before: beforeType, after: afterType }))

  // 提交（点空白）
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 60, y: 500, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 60, y: 500, button: 'left', clickCount: 1 })
  await sleep(500)

  // 保存
  await cdp.eval("(() => { const b = [...document.querySelectorAll('.pdf-toolbar .tool-btn')].find(x => /保存到 PDF/.test(x.textContent||'')); b?.click(); return 'ok' })()")
  await sleep(2500)
  console.log('保存字节:', await cdp.eval("(() => window.__savedPdfBytes ? new Uint8Array(window.__savedPdfBytes).length : null)()"))

  // 2) 关闭标签页重开（模拟重开文件）— 用 IndexedDB 持久化的批注
  // 直接关闭再打开同一文件
  await cdp.eval("(() => { const closeBtn = [...document.querySelectorAll('button')].find(b => b.title === '关闭' || b.getAttribute('aria-label') === '关闭'); closeBtn?.click(); return 'closed' })()")
  await sleep(1000)
  // 重新打开
  await cdp.eval("(() => { const b = [...document.querySelectorAll('button')].find(x => /打开文件/.test(x.textContent||'')); b?.click(); return 'reopened' })()")
  await sleep(5000)

  const reopened = await cdp.eval("(() => ({ hasViewer: !!document.querySelector('.pdf-viewer-shell'), editedSpans: document.querySelectorAll('.pdf-text-layer span.edited').length }))()")
  console.log('重开状态:', JSON.stringify(reopened))

  // 点击第一行（应显示上次编辑文本 "Hello PDF Studio!!"）
  const pos2 = await cdp.eval("(() => { const spans = [...document.querySelectorAll('.pdf-text-layer span[data-page]')].filter(s => s.textContent.trim()); if (!spans.length) return { ok: false }; const t = spans[0]; const r = t.getBoundingClientRect(); return { ok: true, cx: r.left + r.width/2, cy: r.top + r.height/2 } })()")
  if (pos2.ok) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos2.cx, y: pos2.cy, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos2.cx, y: pos2.cy, button: 'left', clickCount: 1 })
    await sleep(800)
    const editText = await cdp.eval("(() => document.querySelector('.pdf-inline-editor')?.innerText || '')()")
    console.log('重开后编辑框文本:', JSON.stringify(editText))
  }

  if (errors.length) { console.log('\n=== 异常 ==='); errors.slice(0, 5).forEach(e => console.log(e.slice(0, 300))) }
  console.log('输出目录:', OUT_DIR)
  chrome.kill()
}

main().catch((e) => { console.error('测试失败:', e); process.exit(1) })