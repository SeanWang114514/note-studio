// 临时可视化验证：打开 PDF → 切到编辑模式 → 单击文字 → 截图
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
  }
  async open() {
    await new Promise((res, rej) => {
      this.ws.onopen = res
      this.ws.onerror = rej
    })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
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
  close() {
    try { this.ws.close() } catch { /* ignore */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true })
  return r?.result?.value
}

async function main() {
  const userData = path.join(ROOT, 'tmp', 'capture-profile-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9224', '--user-data-dir=' + userData,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1400,900', 'about:blank',
  ], { stdio: 'ignore' })

  let targets = []
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9224/json/list')
      targets = await res.json()
      if (targets.length) break
    } catch { /* retry */ }
    await sleep(200)
  }
  if (!targets.length) {
    console.error('无法连接 Chrome 调试端口')
    chrome.kill()
    process.exit(1)
  }
  const pageTarget = targets.find((t) => t.type === 'page') || targets[0]
  const cdp = new CDP(pageTarget.webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  await cdp.send('Page.navigate', { url: APP_URL })
  await sleep(3000)

  const pdfBytes = fs.readFileSync(PDF_PATH)
  const b64 = pdfBytes.toString('base64')
  await evalJs(cdp, `
    (() => {
      const bytes = Uint8Array.from(atob('${b64}'), c => c.charCodeAt(0));
      const file = new File([bytes], 'test-text.pdf', { type: 'application/pdf', lastModified: Date.now() });
      const handle = {
        kind: 'file', name: 'test-text.pdf',
        getFile: async () => file,
        queryPermission: async () => 'granted',
        requestPermission: async () => 'granted',
        createWritable: async () => ({ write: async () => {}, close: async () => {} }),
      };
      window.showOpenFilePicker = async () => [handle];
      window.showSaveFilePicker = async () => handle;
      return 'ok';
    })()
  `)

  await evalJs(cdp, `(() => { const b = [...document.querySelectorAll('button')].find(x => /打开文件/.test(x.textContent||'')); b && b.click(); return 1; })()`)
  await sleep(6000)
  await evalJs(cdp, `(() => { const b = [...document.querySelectorAll('.pdf-toolbar button')].find(x => /^\\s*编辑/.test(x.textContent||'')); b && b.click(); return 1; })()`)
  await sleep(300)

  const sp = await evalJs(cdp, `(() => {
    const span = document.querySelector('.pdf-text-layer span[data-page]');
    if (!span) return null;
    const r = span.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  if (sp) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sp.x, y: sp.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sp.x, y: sp.y, button: 'left', clickCount: 1 })
  }
  await sleep(900)

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(ROOT, 'tmp', 'pdf-edit-mode.png'), Buffer.from(shot.data, 'base64'))
  console.log('screenshot saved: tmp/pdf-edit-mode.png')

  cdp.close()
  chrome.kill()
  await sleep(800)
  try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch { /* ignore */ }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
