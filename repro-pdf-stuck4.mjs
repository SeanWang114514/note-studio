// 复现4：模拟真实环境句柄 getFile 挂起（OneDrive 云盘）→ PDF 应仍能打开
import { spawn } from 'node:child_process'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9473
const profile = process.env.TEMP + '/chrome-pdf-hang-' + PORT
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

  // 真实 IndexedDB + 句柄 getFile 永不 resolve（模拟 OneDrive 云盘挂起）
  await send('Runtime.evaluate', { expression: `(async () => {
    const r = await fetch('/test-text.pdf'); const b = await r.arrayBuffer();
    const f = new File([b], 'test-text.pdf', { type: 'application/pdf' });
    window.__log = [];
    window.addEventListener('error', e => window.__log.push('window.onerror: ' + e.message));
    window.addEventListener('unhandledrejection', e => window.__log.push('unhandledrejection: ' + (e.reason?.stack || e.reason?.message || String(e.reason)).slice(0, 300)));
    window.__hangGetFile = 0;
    let calls = 0;
    window.showOpenFilePicker = async () => [{ name:'test-text.pdf', kind:'file', getFile: async () => { calls++; if (calls === 1) return f; window.__hangGetFile++; return await new Promise(() => {}); }, queryPermission: async()=> 'granted', requestPermission: async()=> 'granted', createWritable: async()=>({write:async()=>{},close:async()=>{}}) }];
    window.showSaveFilePicker = async () => { window.__pickerCalled = true; throw new Error('should not') };
    return 'ok'
  })()`, awaitPromise: true, returnByValue: true })
  await send('Runtime.evaluate', { expression: `document.querySelector('.folder-btn')?.click()`, returnByValue: true })
  await sleep(10000)

  const state = await send('Runtime.evaluate', { expression: `(() => {
    const loading = document.querySelector('.loading')
    const hint = [...document.querySelectorAll('.toolbar-hint, .status-bar span')].map(e => e.textContent).join(' | ')
    const pages = document.querySelectorAll('.pdf-page').length
    return JSON.stringify({ loading: loading?.textContent || null, hint, pages, hangGetFile: window.__hangGetFile || 0 })
  })()`, returnByValue: true })
  console.log('STATE:', state.result?.value)
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
  const v = JSON.parse(state.result?.value || '{}')
  const ok = v.loading === null && v.pages > 0 && v.hint.includes('1 / 1')
  console.log('RESULT: ' + (ok ? 'PASS' : 'FAIL'))
  ws.close(); chrome.kill(); process.exit(ok ? 0 : 1)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
