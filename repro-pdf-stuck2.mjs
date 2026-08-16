// 复现2：真实 IndexedDB 环境下打开 PDF
import { spawn } from 'node:child_process'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9471
const profile = process.env.TEMP + '/chrome-pdf-stuck2-' + PORT
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
    if (msg.method === 'Runtime.exceptionThrown') errors.push('EXC: ' + (msg.params.exceptionDetails?.exception?.description || '').slice(0, 500))
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) errors.push(msg.params.type.toUpperCase() + ': ' + (msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 500))
    if (msg.id && pending.has(msg.id)) { const q = pending.get(msg.id); pending.delete(msg.id); msg.error ? q.rej(new Error(msg.error.message)) : q.res(msg.result) }
  }
  await new Promise(r => (ws.onopen = r))
  await send('Page.enable'); await send('Runtime.enable')
  await send('Page.navigate', { url: 'http://127.0.0.1:5199/?t=pdf' })
  await sleep(4000)

  // 真实 IndexedDB（不 mock）。真实 handle 无法存储，但本次只测打开 PDF 的 loadAnnotations 路径：
  // loadAnnotations → getAnnotationsData(entry.id) → idbRequest(ann-data) → openDb
  await send('Runtime.evaluate', { expression: `(async () => {
    const r = await fetch('/test-text.pdf'); const b = await r.arrayBuffer();
    const f = new File([b], 'test-text.pdf', { type: 'application/pdf' });
    window.__file = f;
    window.showOpenFilePicker = async () => [{ name:'test-text.pdf', kind:'file', getFile: async()=>f, queryPermission: async()=> 'granted', requestPermission: async()=> 'granted', createWritable: async()=>({write:async()=>{},close:async()=>{}}) }];
    window.showSaveFilePicker = async () => { window.__pickerCalled = true; throw new Error('should not') };
    return 'ok'
  })()`, awaitPromise: true, returnByValue: true })

  // 监听全局错误 + 打点 loadAnnotations 内部
  await send('Runtime.evaluate', { expression: `(() => {
    window.__log = [];
    window.addEventListener('error', e => window.__log.push('window.onerror: ' + e.message));
    window.addEventListener('unhandledrejection', e => window.__log.push('unhandledrejection: ' + (e.reason?.stack || e.reason?.message || String(e.reason)).slice(0, 400)));
  })()`, returnByValue: true })
  await send('Runtime.evaluate', { expression: `document.querySelector('.folder-btn')?.click()`, returnByValue: true })
  await sleep(12000)

  const state = await send('Runtime.evaluate', { expression: `(() => {
    const loading = document.querySelector('.loading')
    const hint = [...document.querySelectorAll('.toolbar-hint, .status-bar span')].map(e => e.textContent).join(' | ')
    const pages = document.querySelectorAll('.pdf-page').length
    return JSON.stringify({ loading: loading?.textContent || null, hint, pages, log: window.__log || [] })
  })()`, returnByValue: true })
  console.log('STATE:', state.result?.value)
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
  ws.close(); chrome.kill(); process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
