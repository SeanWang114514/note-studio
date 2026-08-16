// 复现3：模拟用户已有 v1 数据库（handles store），升级到 v2（ann-data store），再打开 PDF
import { spawn } from 'node:child_process'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9472
const profile = process.env.TEMP + '/chrome-pdf-v1v2-' + PORT
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

  // PHASE 0：在空页面上创建 v1 数据库（只有 handles store，模拟旧版本）
  await send('Page.navigate', { url: 'http://127.0.0.1:5199/' })
  await sleep(2000)
  await send('Runtime.evaluate', { expression: `(async () => {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('noteflow-store', 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('handles')) {
          req.result.createObjectStore('handles', { keyPath: 'key' })
        }
      }
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    // 写入一个旧 handles 记录（模拟旧版存过文件句柄——但真实句柄无法在测试中克隆，用普通对象代替）
    await new Promise((res, rej) => {
      const tx = db.transaction('handles', 'readwrite')
      tx.objectStore('handles').put({ key: 'file:test', handle: { kind: 'file', name: 'old' } })
      tx.oncomplete = () => res()
      tx.onerror = () => rej(tx.error)
    })
    db.close()
    return 'created v1'
  })()`, awaitPromise: true, returnByValue: true })
  console.log('PHASE0: v1 db created')

  // PHASE 1：真实打开 PDF（触发 app 代码 openDb(DB_VERSION=2) 升级）
  await send('Page.navigate', { url: 'http://127.0.0.1:5199/?t=pdf' })
  await sleep(4000)
  await send('Runtime.evaluate', { expression: `(async () => {
    const r = await fetch('/test-text.pdf'); const b = await r.arrayBuffer();
    const f = new File([b], 'test-text.pdf', { type: 'application/pdf' });
    window.__log = [];
    window.addEventListener('error', e => window.__log.push('window.onerror: ' + e.message));
    window.addEventListener('unhandledrejection', e => window.__log.push('unhandledrejection: ' + (e.reason?.stack || e.reason?.message || String(e.reason)).slice(0, 400)));
    window.showOpenFilePicker = async () => [{ name:'test-text.pdf', kind:'file', getFile: async()=>f, queryPermission: async()=> 'granted', requestPermission: async()=> 'granted', createWritable: async()=>({write:async()=>{},close:async()=>{}}) }];
    window.showSaveFilePicker = async () => { window.__pickerCalled = true; throw new Error('should not') };
    return 'ok'
  })()`, awaitPromise: true, returnByValue: true })
  await send('Runtime.evaluate', { expression: `document.querySelector('.folder-btn')?.click()`, returnByValue: true })
  await sleep(12000)

  const state = await send('Runtime.evaluate', { expression: `(async () => {
    const loading = document.querySelector('.loading')
    const hint = [...document.querySelectorAll('.toolbar-hint, .status-bar span')].map(e => e.textContent).join(' | ')
    const pages = document.querySelectorAll('.pdf-page').length
    // 检查数据库状态
    let dbInfo = 'none'
    try {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('noteflow-store'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      dbInfo = db.version + ' stores=' + [...db.objectStoreNames].join(',')
      db.close()
    } catch (e) { dbInfo = 'err ' + e.message }
    return JSON.stringify({ loading: loading?.textContent || null, hint, pages, log: window.__log || [], dbInfo })
  })()`, awaitPromise: true, returnByValue: true })
  console.log('STATE:', state.result?.value)
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
  ws.close(); chrome.kill(); process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
