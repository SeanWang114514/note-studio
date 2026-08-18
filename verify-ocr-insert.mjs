// E2E：OCR 插入到文档（打开 DOCX → 点文字识别自动进编辑模式 → 识别 → 格式化 → 插入光标处）
import { spawn } from 'node:child_process'

const BASE = process.env.OCR_URL || 'http://127.0.0.1:5173/'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9437
const TMP = 'C:/Users/Administrator/AppData/Local/Temp'
const profile = TMP + '/chrome-ocr-insert-' + PORT + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1400,950', '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT, 'about:blank'], { stdio: 'ignore' })
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
    if (msg.method === 'Runtime.exceptionThrown') errors.push('EXC: ' + (msg.params.exceptionDetails?.exception?.description || '').slice(0, 400))
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const text = (msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' ')
      if (!text.includes('[W:onnxruntime:') && !text.includes('Removing initializer')) errors.push('CONSOLE: ' + text.slice(0, 400))
    }
    if (msg.id && pending.has(msg.id)) { const q = pending.get(msg.id); pending.delete(msg.id); msg.error ? q.rej(new Error(msg.error.message)) : q.res(msg.result) }
  }
  await new Promise(r => (ws.onopen = r))
  await send('Page.enable'); await send('Runtime.enable')
  await send('Page.navigate', { url: BASE })
  await sleep(3500)

  // mock IndexedDB + 文件选择器（返回 public/test-edit.docx）
  await send('Runtime.evaluate', { expression: `(() => {
    const store = {};
    window.__idbStore = store;
    const mkReq = (result) => { const req = { result, onsuccess:null, onerror:null }; setTimeout(()=>{ req.onsuccess && req.onsuccess({target:req}) },0); return req };
    const fakeStore = { get: (k) => mkReq(store[k]), put: (v) => { store[v.key] = v; return mkReq(v.key) } };
    Object.defineProperty(window, 'indexedDB', { value: { open: () => { const req = { onupgradeneeded:null, onsuccess:null, onerror:null, result: { objectStoreNames:{ contains:()=>true }, createObjectStore:()=>{}, transaction:()=>({ objectStore:()=>fakeStore }) } }; setTimeout(()=>{ req.onsuccess && req.onsuccess({target:req}) },0); return req } }, configurable: true });
    return 'idb-mocked'
  })()`, returnByValue: true })
  await send('Runtime.evaluate', { expression: `(async () => {
    const r = await fetch('/test-edit.docx'); const b = await r.arrayBuffer();
    const f = new File([b], 'test-edit.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    window.showOpenFilePicker = async () => [{ name:'test-edit.docx', kind:'file', getFile: async()=>f, queryPermission: async()=> 'granted', requestPermission: async()=> 'granted', createWritable: async()=>({write:async()=>{},close:async()=>{}}) }];
    return 'picker-mocked'
  })()`, awaitPromise: true, returnByValue: true })
  await send('Runtime.evaluate', { expression: `document.querySelector('.folder-btn')?.click()`, returnByValue: true })
  await sleep(8000)

  // 1) DOCX 打开
  let bodyReady = false
  for (let i = 0; i < 30; i++) {
    const r = await send('Runtime.evaluate', { expression: `(() => { const b = document.querySelector('.docx-body'); return b ? (b.textContent.length + ':' + b.childElementCount) : 'NO' })()`, returnByValue: true })
    if (r.result?.value && r.result.value !== 'NO') { bodyReady = true; break }
    await sleep(400)
  }
  if (!bodyReady) throw new Error('docx body not loaded')
  console.log('docx opened')

  // 2) 点击工具栏文字识别 → 默认进编辑模式
  await send('Runtime.evaluate', { expression: `(() => {
    const b = [...document.querySelectorAll('.ocr-btn')].find(x => x.textContent.includes('文字识别'))
    if (!b) return 'NO-BTN'
    b.click()
    return 'clicked'
  })()`, returnByValue: true })
  await sleep(1500)
  const editState = await send('Runtime.evaluate', { expression: `(() => {
    const body = document.querySelector('.docx-body')
    const exitBtn = [...document.querySelectorAll('.tool-btn')].some(b => b.textContent.includes('退出编辑'))
    const modal = !!document.querySelector('.ocr-modal')
    return JSON.stringify({ editable: body?.contentEditable, exitBtn, modal })
  })()`, returnByValue: true })
  console.log('edit state:', editState.result?.value)
  const es = JSON.parse(editState.result?.value || '{}')
  if (es.editable !== 'true' || !es.modal) throw new Error('OCR 未自动打开编辑模式')

  // 3) 粘贴一张程序生成的“测试123”印刷图
  await send('Runtime.evaluate', { expression: `(async () => {
    const c = document.createElement('canvas'); c.width = 900; c.height = 220;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 900, 220);
    x.fillStyle = '#000'; x.font = 'bold 100px Arial'; x.fillText('Hello 123', 40, 150);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const file = new File([blob], 'text.png', { type: 'image/png' });
    const dt = new DataTransfer(); dt.items.add(file);
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: dt });
    document.querySelector('.ocr-overlay').dispatchEvent(ev);
    return 'pasted'
  })()`, awaitPromise: true, returnByValue: true })
  await sleep(800)
  const imgState = await send('Runtime.evaluate', { expression: `(() => { const img = document.querySelector('.ocr-image-preview img'); const run = document.querySelector('.ocr-run'); return JSON.stringify({ img: !!img, disabled: run?.disabled }) })()`, returnByValue: true })
  console.log('pasted image:', imgState.result?.value)

  // 4) 识别
  await send('Runtime.evaluate', { expression: `document.querySelector('.ocr-run')?.click()`, returnByValue: true })
  let final = null
  const startedAt = Date.now()
  while (Date.now() - startedAt < 360000) {
    const r = await send('Runtime.evaluate', { expression: `(() => {
      const err = document.querySelector('.ocr-error')?.textContent || ''
      const pre = document.querySelector('.ocr-result-text pre')?.textContent || ''
      const head = document.querySelector('.ocr-result-head')?.textContent || ''
      return JSON.stringify({ err, pre, head, done: !!document.querySelector('.ocr-result') })
    })()`, returnByValue: true })
    const v = JSON.parse(r.result?.value || '{}')
    if (v.done) { final = v; break }
    if (v.err && !v.head) { final = v; break }
    if (Date.now() - startedAt > 15000) console.log('  waiting…', ((Date.now() - startedAt) / 1000).toFixed(0) + 's')
    await sleep(2000)
  }
  console.log('recognized:', JSON.stringify(final).slice(0, 400))
  if (!final || !final.done || final.err) throw new Error('识别失败: ' + JSON.stringify(final))

  // 5) 格式选项：整理为一行 + 去除空格
  await send('Runtime.evaluate', { expression: `(() => {
    const opts = [...document.querySelectorAll('.ocr-opt')]
    const row = opts.find(l => l.textContent.includes('整理为一行'))
    const sp = opts.find(l => l.textContent.includes('去除空格'))
    row?.click(); sp?.click()
    return JSON.stringify({ row: !!row, sp: !!sp })
  })()`, returnByValue: true })
  await sleep(500)
  const fmt = await send('Runtime.evaluate', { expression: `document.querySelector('.ocr-result-text pre')?.textContent || ''`, returnByValue: true })
  console.log('formatted text:', JSON.stringify(fmt.result?.value))
  if (!fmt.result?.value || !fmt.result.value.trim()) throw new Error('格式化后文本为空: ' + JSON.stringify(fmt.result?.value))
  if (/\s/.test(fmt.result.value)) throw new Error('格式化后仍有空白: ' + JSON.stringify(fmt.result.value))

  // 6) 插入到文档
  const insertBtn = await send('Runtime.evaluate', { expression: `(() => {
    const b = [...document.querySelectorAll('.tool-btn')].find(x => x.textContent.includes('插入到文档'))
    if (!b) return 'NO-BTN'
    b.click()
    return 'clicked'
  })()`, returnByValue: true })
  console.log('insert click:', insertBtn.result?.value)
  await sleep(1200)
  const docState = await send('Runtime.evaluate', { expression: `(() => {
    const body = document.querySelector('.docx-body')
    const inserted = document.querySelector('.ocr-insert-btn')?.textContent || ''
    return JSON.stringify({ text: body?.textContent || '', len: body?.textContent?.length || 0, insertBtnText: inserted })
  })()`, returnByValue: true })
  const ds = JSON.parse(docState.result?.value || '{}')
  console.log('doc after insert:', JSON.stringify(ds).slice(0, 500))
  const okInsert = ds.text && fmt.result.value && ds.text.includes(fmt.result.value) && ds.text.trim().endsWith(fmt.result.value)

  console.log('ERRORS:', errors.length ? errors.join('\n').slice(0, 2000) : 'none')
  const pass = okInsert
  console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'))
  ws.close()
  try { cp.execSync('taskkill /F /T /PID ' + chrome.pid, { stdio: 'ignore', timeout: 8000 }) } catch {}
  process.exit(pass ? 0 : 1)
}
main().catch(e => { console.error('ERR', e.message); try { cp.execSync('taskkill /F /T /PID ' + chrome.pid, { stdio: 'ignore', timeout: 8000 }) } catch {} process.exit(1) })
