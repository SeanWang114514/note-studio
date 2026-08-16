// 复现：打开 PDF 卡在「正在渲染 PDF…」
import { spawn } from 'node:child_process'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9470
const profile = process.env.TEMP + '/chrome-pdf-stuck-' + PORT
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

  // 假 IndexedDB（避免真实句柄克隆问题；但保留真实对象存储语义）
  await send('Runtime.evaluate', { expression: `(()=>{
    const store = {};
    window.__idbStore = store;
    const mkReq = (result) => { const req = { result, onsuccess:null, onerror:null }; setTimeout(()=>{ req.onsuccess && req.onsuccess({target:req}) },0); return req };
    const fakeStore = { get: (k) => mkReq(store[k]), put: (v) => { store[v.key] = v; return mkReq(v.key) } };
    Object.defineProperty(window, 'indexedDB', { value: { open: () => { const req = { onupgradeneeded:null, onsuccess:null, onerror:null, result: { objectStoreNames:{ contains:()=>true }, createObjectStore:()=>{}, transaction:()=>({ objectStore:()=>fakeStore }) } }; setTimeout(()=>{ req.onsuccess && req.onsuccess({target:req}) },0); return req } }, configurable: true });
  })()`, returnByValue: true })

  // 拦截 openPdf / loadAnnotations 调用链，观察哪一步失败
  await send('Runtime.evaluate', { expression: `(async () => {
    const r = await fetch('/test-text.pdf'); const b = await r.arrayBuffer();
    const f = new File([b], 'test-text.pdf', { type: 'application/pdf' });
    window.__file = f;
    window.showOpenFilePicker = async () => [{ name:'test-text.pdf', kind:'file', getFile: async()=>f, queryPermission: async()=> 'granted', requestPermission: async()=> 'granted', createWritable: async()=>({write:async()=>{},close:async()=>{}}) }];
    window.showSaveFilePicker = async () => { window.__pickerCalled = true; throw new Error('should not') };
    return 'ok'
  })()`, awaitPromise: true, returnByValue: true })
  await send('Runtime.evaluate', { expression: `document.querySelector('.folder-btn')?.click()`, returnByValue: true })
  await sleep(10000)

  const state = await send('Runtime.evaluate', { expression: `(() => {
    const loading = document.querySelector('.loading')
    const hint = [...document.querySelectorAll('.toolbar-hint, .status-bar span')].map(e => e.textContent).join(' | ')
    const pages = document.querySelectorAll('.pdf-page').length
    const tabs = [...document.querySelectorAll('.tab')].map(e => e.textContent).join(', ')
    return JSON.stringify({ loading: loading?.textContent || null, hint, pages, tabs })
  })()`, returnByValue: true })
  console.log('STATE:', state.result?.value)
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
  ws.close(); chrome.kill(); process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
