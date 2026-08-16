// E2E：验证应用打开 manual.pdf 后是否显示图片（docx 视图 vs 文字视图）
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9460
const profile = process.env.TEMP + '/chrome-imgcheck-' + PORT
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
    if (msg.method === 'Runtime.consoleAPICalled' && ['error'].includes(msg.params.type)) errors.push('CONSOLE: ' + (msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300))
    if (msg.id && pending.has(msg.id)) { const q = pending.get(msg.id); pending.delete(msg.id); msg.error ? q.rej(new Error(msg.error.message)) : q.res(msg.result) }
  }
  await new Promise(r => (ws.onopen = r))
  await send('Page.enable'); await send('Runtime.enable')

  // 1) 打开应用
  await send('Page.navigate', { url: 'http://127.0.0.1:5173/' })
  await sleep(5000)

  // 2) mock 文件选择器：返回 public/manual.pdf
  await send('Runtime.evaluate', { expression: `(async () => {
    const r = await fetch('/manual.pdf'); const b = await r.arrayBuffer();
    const f = new File([b], 'manual.pdf', { type: 'application/pdf' });
    window.showOpenFilePicker = async () => [{ name:'manual.pdf', kind:'file', getFile: async()=>f, queryPermission: async()=> 'granted', requestPermission: async()=> 'granted' }];
    return 'mock-ok'
  })()`, awaitPromise: true, returnByValue: true })

  // 3) 点击打开
  await send('Runtime.evaluate', { expression: `document.querySelector('.folder-btn')?.click(); 'clicked'`, returnByValue: true })
  await sleep(20000) // 等转换 + 渲染

  // 4) 检查 DOM
  const insp = await send('Runtime.evaluate', { expression: `(() => {
    const docxDoc = document.querySelector('.docx-doc')
    const pdfText = document.querySelector('.pdf-text-doc')
    const imgs = [...document.querySelectorAll('.docx-doc img, .pdf-text-doc img, .md-body img')]
    const toasts = [...document.querySelectorAll('.toast, .status-toast, .toolbar-hint')].map(e => e.textContent).filter(Boolean).slice(-5)
    const loading = document.querySelector('.loading')
    return JSON.stringify({
      hasDocxDoc: !!docxDoc,
      hasPdfText: !!pdfText,
      hasLoading: !!loading,
      loadingText: loading?.textContent || '',
      imgCount: imgs.length,
      firstImgSrc: imgs[0] ? imgs[0].src.slice(0, 60) : '',
      imgSizes: imgs.slice(0, 5).map(i => i.naturalWidth + 'x' + i.naturalHeight),
      toasts,
      bodyText: (docxDoc || pdfText || document.body).innerText.slice(0, 200)
    })
  })()`, returnByValue: true })
  const rv = JSON.parse(insp.result?.value || '{}')
  console.log('===== DOM 检查 =====')
  console.log(JSON.stringify(rv, null, 2))

  // 5) 截图
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) writeFileSync('logs/browser-check.png', Buffer.from(shot.result.data, 'base64'))
  console.log('screenshot saved: logs/browser-check.png')
  console.log('===== console errors =====')
  console.log(errors.length ? errors.join('\n') : '(none)')

  ws.close(); chrome.kill()
}
main().catch(e => { console.error('FATAL', e); chrome.kill(); process.exit(1) })
