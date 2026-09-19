// pdf-editor-diag.mjs — 诊断：双击编辑为何未触发
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const APP_URL = 'http://127.0.0.1:5199/'
const PDF_PATH = path.join(ROOT, 'public', 'test-text.pdf')

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.listeners = new Map()
  }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      } else if (msg.method) {
        ;(this.listeners.get(msg.method) || []).forEach((fn) => fn(msg.params))
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
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(fn)
  }
}

async function main() {
  const userData = path.join(ROOT, 'tmp', 'diag-profile-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9224', '--user-data-dir=' + userData,
    '--no-first-run', '--disable-gpu', '--disable-extensions', '--window-size=1400,900', 'about:blank',
  ], { stdio: 'ignore' })

  let targets = []
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9224/json/list')
      targets = await res.json()
      if (targets.length) break
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  const cdp = new CDP((targets.find((t) => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  // 捕获 console 与异常
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const txt = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
    console.log('[console]', txt)
  })
  cdp.on('Runtime.exceptionThrown', (p) => {
    console.log('[exception]', p.exceptionDetails?.text, p.exceptionDetails?.exception?.description || '')
  })

  await cdp.send('Page.navigate', { url: APP_URL })
  await new Promise((r) => setTimeout(r, 3000))

  const pdfBytes = fs.readFileSync(PDF_PATH)
  const b64 = pdfBytes.toString('base64')
  const mock = `
    (() => {
      const bytes = Uint8Array.from(atob('${b64}'), c => c.charCodeAt(0));
      const file = new File([bytes], 'test-text.pdf', { type: 'application/pdf' });
      const handle = {
        kind: 'file', name: 'test-text.pdf',
        getFile: async () => file,
        queryPermission: async () => 'granted',
        requestPermission: async () => 'granted',
        createWritable: async () => ({ write: async () => {}, close: async () => {} }),
      };
      window.showOpenFilePicker = async () => [handle];
      return 'ok';
    })()
  `
  await cdp.send('Runtime.evaluate', { expression: mock })
  await cdp.send('Runtime.evaluate', {
    expression: `(() => { const b = [...document.querySelectorAll('button')].find(x => /打开文件/.test(x.textContent||'')); b && b.click(); return 'clicked'; })()`,
  })
  await new Promise((r) => setTimeout(r, 7000))

  // 诊断 1: span 与 onDblClick
  const d1 = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const spans = [...document.querySelectorAll('.pdf-text-layer span[data-page]')];
      return {
        spanCount: spans.length,
        firstHasDbl: spans.length ? typeof spans[0].onDblClick === 'function' : null,
        firstText: spans.length ? spans[0].textContent : null,
        pageCount: document.querySelectorAll('.pdf-page').length,
        shell: !!document.querySelector('.pdf-viewer-shell'),
      };
    })()`,
    returnByValue: true,
  })
  console.log('诊断1 span 状态:', JSON.stringify(d1.result.value))

  // 诊断 2: 直接调用 onDblClick（如果存在）
  const d2 = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const span = document.querySelector('.pdf-text-layer span[data-page]');
      if (!span || typeof span.onDblClick !== 'function') return { ok: false, reason: 'no handler' };
      const r = span.getBoundingClientRect();
      span.onDblClick({ preventDefault: () => {}, stopPropagation: () => {}, clientX: r.left + r.width/2, clientY: r.top + r.height/2 });
      return { ok: true };
    })()`,
    returnByValue: true,
  })
  console.log('诊断2 直接调用 onDblClick:', JSON.stringify(d2.result.value))
  await new Promise((r) => setTimeout(r, 1000))

  const d3 = await cdp.send('Runtime.evaluate', {
    expression: `(() => ({
      editor: !!document.querySelector('.pdf-inline-editor'),
      bar: !!document.querySelector('.pdf-edit-bar'),
      bodyHasInline: document.body.innerHTML.includes('pdf-inline-editor'),
    }))()`,
    returnByValue: true,
  })
  console.log('诊断3 编辑框状态:', JSON.stringify(d3.result.value))

  cdp.close()
  chrome.kill()
  await new Promise((r) => setTimeout(r, 500))
  fs.rmSync(userData, { recursive: true, force: true }).catch?.(() => {})
  process.exit(0)
}

main().catch((err) => { console.error(err); process.exit(1) })
