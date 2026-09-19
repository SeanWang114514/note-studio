// verify-views.mjs — 各文档视图零回归验收（md / docx / epub / xlsx）
// 每个视图：能打开、容器渲染、批注工具条在、能画一笔出墨、无未捕获异常。
// 用法: node tools/verify-views.mjs [chromePath]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5199/'
const SHOT_DIR = path.join(ROOT, 'tmp', 'hig-shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function check(name, cond, extra = '') {
  if (!cond) failures += 1
  console.log(`  ${cond ? '✔' : '✘'} ${name}${cond ? '' : ' ' + extra}`)
}

class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map() }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result)
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
  close() { try { this.ws.close() } catch {} }
}

async function ev(cdp, expression, awaitPromise = false) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (r?.exceptionDetails) return { __error: r.exceptionDetails.text || 'eval error' }
  return r?.result?.value
}

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(data, 'base64'))
  console.log('  ◷ shot:', name)
}

async function drag(cdp, x0, y0, x1, y1, steps = 22) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 })
  await sleep(100)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 })
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps, button: 'left',
    })
    if (i % 6 === 0) await sleep(30)
  }
  await sleep(120)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 })
}

async function waitFor(cdp, expr, ms = 25000, step = 400) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await ev(cdp, expr)
    if (v && v !== 0 && v !== false && !v.__error) return v
    await sleep(step)
  }
  return null
}

const FIXTURES = [
  { file: 'test-edit.md', cont: '.md-body', kind: 'Markdown' },
  { file: 'test-edit.docx', cont: '.docx-doc', kind: 'Word' },
  { file: 'test-edit.epub', cont: '.epub-body', kind: 'EPUB' },
  { file: 'test-edit.xlsx', cont: '.excel-body', kind: 'Excel' },
]

async function main() {
  let alive = false
  for (let i = 0; i < 5; i++) {
    try { const r = await fetch(APP_URL, { signal: AbortSignal.timeout(3000) }); if (r.status < 500) { alive = true; break } } catch {}
    await sleep(1000)
  }
  if (!alive) { console.error('dev 服务未启动: ' + APP_URL); process.exit(1) }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'views-'))
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9239',
    '--user-data-dir=' + userData, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })

  let targets = []
  for (let i = 0; i < 60; i++) {
    try { const res = await fetch('http://127.0.0.1:9239/json/list'); targets = await res.json(); if (targets.length) break } catch {}
    await sleep(250)
  }
  if (!targets.length) { console.error('无法连接 Chrome'); chrome.kill(); process.exit(1) }
  const cdp = new CDP((targets.find((t) => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  const exceptions = []
  cdp.ws.addEventListener('message', (evm) => {
    try {
      const msg = JSON.parse(evm.data)
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails
        exceptions.push(String(d?.exception?.description || d?.text || '').slice(0, 200))
      }
    } catch {}
  })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.navigate', { url: APP_URL })
  await waitFor(cdp, `document.querySelectorAll('.nav-item').length`)
  await sleep(1200)

  for (const fx of FIXTURES) {
    console.log(`\n[${fx.kind}] 打开 ${fx.file}…`)
    const b64 = fs.readFileSync(path.join(ROOT, 'public', fx.file)).toString('base64')
    await ev(cdp, `(() => {
      const bytes = Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0));
      const file = new File([bytes], '${fx.file}', { lastModified: Date.now() });
      const handle = { kind: 'file', name: '${fx.file}', getFile: async () => file,
        queryPermission: async () => 'granted', requestPermission: async () => 'granted',
        createWritable: async () => ({ write: async () => {}, close: async () => {}, seek: async () => {}, truncate: async () => {}, getPosition: async () => 0 }) };
      window.showOpenFilePicker = async () => [handle];
      return 'ok';
    })()`)
    const clicked = await ev(cdp, `(async () => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '打开文件');
      if (!b) return false;
      b.click();
      return true;
    })()`, true)
    check(`「打开文件」按钮可用`, clicked === true)
    const ok = await waitFor(cdp, `document.querySelectorAll('${fx.cont}').length`, 25000)
    const state = await ev(cdp, `(() => ({
      cont: document.querySelectorAll('${fx.cont}').length,
      toolbar: document.querySelectorAll('.doc-toolbar').length,
      toolBtns: document.querySelectorAll('.doc-toolbar .icon-btn').length,
      annotCanvas: document.querySelectorAll('.annot-canvas').length,
      editBar: document.querySelectorAll('.pdf-edit-bar').length,
      textLayer: document.querySelectorAll('.pdf-text-layer').length,
      tabs: document.querySelectorAll('.tab').length,
      error: (document.querySelector('.file-error, .load-error') || {}).textContent || '',
    }))()`)
    console.log('  state:', JSON.stringify(state))
    check(`${fx.kind} 视图已渲染`, (state?.cont || 0) >= 1, JSON.stringify(state))
    check(`${fx.kind} 批注工具条存在`, (state?.toolbar || 0) >= 1)
    check(`${fx.kind} 可绘制画布存在`, (state?.annotCanvas || 0) >= 1)

    // 画一笔
    const pen = await ev(cdp, `(async () => {
      const b = [...document.querySelectorAll('.doc-toolbar .icon-btn')].find((x) => (x.getAttribute('title') || '').startsWith('画笔'));
      if (!b) return 'no-pen';
      b.click();
      await new Promise((r) => setTimeout(r, 400));
      const a = document.querySelector('.doc-toolbar .icon-btn.active');
      return a ? 'pen' : 'none';
    })()`, true)
    const box = await ev(cdp, `(() => {
      const el = document.querySelector('.annot-canvas');
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight };
    })()`)
    let ink = null
    if (box && box.w > 80) {
      const ix0 = Math.max(box.x, 0), iy0 = Math.max(box.y, 0)
      const ix1 = Math.min(box.x + box.w, box.vw - 4), iy1 = Math.min(box.y + box.h, box.vh - 4)
      await drag(cdp, ix0 + (ix1 - ix0) * 0.25, iy0 + (iy1 - iy0) * 0.35, ix0 + (ix1 - ix0) * 0.7, iy0 + (iy1 - iy0) * 0.55)
      await sleep(700)
      ink = await ev(cdp, `(() => {
        const cv = document.querySelector('.annot-canvas');
        const ctx = cv.getContext('2d');
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 8) n++;
        return { painted: n, w: cv.width, h: cv.height };
      })()`)
    }
    check(`${fx.kind} 手绘落笔成功（tool=${pen}）`, (ink?.painted || 0) > 40, JSON.stringify(ink))
    await shot(cdp, `10-view-${fx.file.replace('.', '-')}.png`)
  }

  const fatal = exceptions.filter((e) => !/ResizeObserver|favicon|ERR_CONNECTION_REFUSED/i.test(e))
  check('全程无未捕获异常', fatal.length === 0, fatal.slice(0, 3).join(' | '))

  console.log(`\n结果: ${failures === 0 ? '全部通过' : failures + ' 项失败'}，截图见 tmp/hig-shots/`)
  cdp.close()
  chrome.kill()
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error('verify-views failed:', e); process.exit(2) })
