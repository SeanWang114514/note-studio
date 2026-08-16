// E2E：阻断转换服务 → 强制文字视图 → 检查图片是否显示
import { spawn } from 'node:child_process'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9461
const profile = process.env.TEMP + '/chrome-textview-' + PORT
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1280,900', '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT, 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find(t => t.type === 'page'); if (p) return p } catch {}
    await sleep(300)
  }
  throw new Error('no target')
}

async function main() {
  const t = await getTarget()
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  let id = 0; const pending = new Map(); const errors = []
  const send = (m, p = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method: m, params: p })) })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Runtime.exceptionThrown') errors.push('EXC: ' + (msg.params.exceptionDetails?.exception?.description || '').slice(0, 300))
    if (msg.id && pending.has(msg.id)) { const q = pending.get(msg.id); pending.delete(msg.id); msg.error ? q.rej(new Error(msg.error.message)) : q.res(msg.result) }
  }
  await new Promise(r => (ws.onopen = r))
  await send('Page.enable'); await send('Runtime.enable')

  await send('Page.navigate', { url: 'http://127.0.0.1:5173/' })
  await sleep(5000)

  // mock 文件选择器 + 阻断 5198 请求（强制走文字视图）
  await send('Runtime.evaluate', { expression: `(async () => {
    const origFetch = window.fetch.bind(window);
    window.fetch = (url, opts) => { if (String(url).includes('5198')) return Promise.reject(new Error('convert blocked for test')); return origFetch(url, opts) };
    const r = await origFetch('/manual.pdf'); const b = await r.arrayBuffer();
    const f = new File([b], 'manual.pdf', { type: 'application/pdf' });
    window.showOpenFilePicker = async () => [{ name:'manual.pdf', kind:'file', getFile: async()=>f, queryPermission: async()=> 'granted', requestPermission: async()=> 'granted' }];
    return 'mock-ok'
  })()`, awaitPromise: true, returnByValue: true })

  await send('Runtime.evaluate', { expression: `document.querySelector('.folder-btn')?.click(); 'clicked'`, returnByValue: true })
  await sleep(25000)

  const insp = await send('Runtime.evaluate', { expression: `(() => {
    const docxDoc = document.querySelector('.docx-doc')
    const pdfText = document.querySelector('.pdf-text-doc')
    const imgs = [...document.querySelectorAll('.pdf-text-doc img, .docx-doc img')]
    const toasts = [...document.querySelectorAll('.toast, .status-toast, .toolbar-hint')].map(e => e.textContent).filter(Boolean).slice(-5)
    return JSON.stringify({
      hasDocxDoc: !!docxDoc,
      hasPdfText: !!pdfText,
      imgCount: imgs.length,
      firstImgSrc: imgs[0] ? imgs[0].src.slice(0, 50) : '',
      imgSizes: imgs.slice(0, 3).map(i => i.naturalWidth + 'x' + i.naturalHeight),
      toasts,
      bodyText: (pdfText || document.body).innerText.slice(0, 150)
    })
  })()`, returnByValue: true })
  console.log('===== 文字视图 DOM =====')
  console.log(JSON.stringify(JSON.parse(insp.result?.value || '{}'), null, 2))
  console.log('===== console errors =====')
  console.log(errors.length ? errors.join('\n') : '(none)')
  ws.close(); chrome.kill()
}
main().catch(e => { console.error('FATAL', e); chrome.kill(); process.exit(1) })
