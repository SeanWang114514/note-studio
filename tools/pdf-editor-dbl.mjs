// pdf-editor-dbl.mjs — 实验：真实双击事件是否到达 span
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
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.listeners = new Map()
  }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      } else if (msg.method) { (this.listeners.get(msg.method) || []).forEach((fn) => fn(msg.params)) }
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
}

async function main() {
  const userData = path.join(ROOT, 'tmp', 'dbl-profile-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9225', '--user-data-dir=' + userData,
    '--no-first-run', '--disable-gpu', '--disable-extensions', '--window-size=1400,900', 'about:blank',
  ], { stdio: 'ignore' })

  let targets = []
  for (let i = 0; i < 50; i++) {
    try { const res = await fetch('http://127.0.0.1:9225/json/list'); targets = await res.json(); if (targets.length) break } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  const cdp = new CDP((targets.find((t) => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  cdp.on('Runtime.consoleAPICalled', (p) => console.log('[console]', (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ')))

  await cdp.send('Page.navigate', { url: APP_URL })
  await new Promise((r) => setTimeout(r, 3000))

  const b64 = fs.readFileSync(PDF_PATH).toString('base64')
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const bytes = Uint8Array.from(atob('${b64}'), c => c.charCodeAt(0));
      const file = new File([bytes], 'test-text.pdf', { type: 'application/pdf' });
      const handle = { kind: 'file', name: 'test-text.pdf', getFile: async () => file, queryPermission: async () => 'granted', requestPermission: async () => 'granted', createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
      window.showOpenFilePicker = async () => [handle];
      // 全局捕获 dblclick（捕获阶段），看事件是否产生及目标
      window.__dblLog = [];
      document.addEventListener('dblclick', (e) => {
        window.__dblLog.push({ target: e.target.className || e.target.tagName, time: Date.now() });
      }, true);
      return 'ok';
    })()`,
  })
  await cdp.send('Runtime.evaluate', {
    expression: `(() => { const b = [...document.querySelectorAll('button')].find(x => /打开文件/.test(x.textContent||'')); b && b.click(); return 'clicked'; })()`,
  })
  await new Promise((r) => setTimeout(r, 7000))

  const info = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const span = document.querySelector('.pdf-text-layer span[data-page]');
      const r = span.getBoundingClientRect();
      const layer = span.closest('.pdf-text-layer');
      const lr = layer.getBoundingClientRect();
      const cs = getComputedStyle(layer);
      const spanCs = getComputedStyle(span);
      return {
        x: r.left + r.width / 2, y: r.top + r.height / 2,
        layerPE: cs.pointerEvents, spanPE: spanCs.pointerEvents,
        spanText: span.textContent,
        spanOnDbl: typeof span.onDblClick === 'function',
        layerRect: { l: lr.left, t: lr.top, w: lr.width, h: lr.height },
        spanRect: { l: r.left, t: r.top, w: r.width, h: r.height },
      };
    })()`,
    returnByValue: true,
  })
  const v = info.result.value
  console.log('span/layer 状态:', JSON.stringify(v))

  // 发送真实双击
  for (let i = 0; i < 2; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: v.x, y: v.y, button: 'left', clickCount: i + 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: v.x, y: v.y, button: 'left', clickCount: i + 1 })
  }
  await new Promise((r) => setTimeout(r, 600))

  const after = await cdp.send('Runtime.evaluate', {
    expression: `(() => ({
      dblLog: window.__dblLog,
      editor: !!document.querySelector('.pdf-inline-editor'),
      bar: !!document.querySelector('.pdf-edit-bar'),
    }))()`,
    returnByValue: true,
  })
  console.log('双击后:', JSON.stringify(after.result.value, null, 2))

  cdp.close()
  chrome.kill()
  await new Promise((r) => setTimeout(r, 800))
  try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch { /* ignore */ }
  process.exit(0)
}

main().catch((err) => { console.error(err); process.exit(1) })
