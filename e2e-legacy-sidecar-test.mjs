// E2E：旧版磁盘旁车兼容 —— IndexedDB 预置 ann handle（返回旧旁车 JSON），loadAnnotations 应回退读取
import { spawn } from 'node:child_process'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9450
const profile = process.env.TEMP + '/chrome-legacy-' + PORT
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

  await send('Page.navigate', { url: 'http://127.0.0.1:5199/?t=md' })
  await sleep(4000)
  // 取文件真实大小，构造可预测 entry.id：file-test-edit.md-{size}-1234567890
  const size = (await send('Runtime.evaluate', { expression: `fetch('/test-edit.md').then(r=>r.arrayBuffer()).then(b=>b.byteLength)`, awaitPromise: true, returnByValue: true })).result?.value
  const annKey = `ann:file-test-edit.md-${size}-1234567890`
  console.log('expected ann key:', annKey)
  // 假 IndexedDB，预置 ann handle（旧旁车 JSON 里有 1 条画笔批注）
  await send('Runtime.evaluate', { expression: `(() => {
    const store = {
      '${annKey}': { key: '${annKey}', handle: { name:'a.json', getFile: async()=>new File([JSON.stringify({ md: [{ id:'old1', type:'brush', color:'#000', thickness:3, points:[{x:0.1,y:0.1},{x:0.2,y:0.2}] }] })], 'a.json'), queryPermission: async()=> 'granted', requestPermission: async()=> 'granted' } },
    };
    const mkReq = (result) => { const req = { result, onsuccess:null, onerror:null }; setTimeout(()=>{ req.onsuccess && req.onsuccess({target:req}) },0); return req };
    const fakeStore = { get: (k) => mkReq(store[k]), put: (v) => { store[v.key] = v; return mkReq(v.key) } };
    Object.defineProperty(window, 'indexedDB', { value: { open: () => { const req = { onupgradeneeded:null, onsuccess:null, onerror:null, result: { objectStoreNames:{ contains:()=>true }, createObjectStore:()=>{}, transaction:()=>({ objectStore:()=>fakeStore }) } }; setTimeout(()=>{ req.onsuccess && req.onsuccess({target:req}) },0); return req } }, configurable: true });
  })()`, returnByValue: true })
  await send('Runtime.evaluate', { expression: `(async () => {
    const r = await fetch('/test-edit.md'); const b = await r.arrayBuffer();
    const f = new File([b], 'test-edit.md', { lastModified: 1234567890 });
    window.showOpenFilePicker = async () => [{ name:'test-edit.md', kind:'file', getFile: async()=>f, queryPermission: async()=> 'granted', requestPermission: async()=> 'granted', createWritable: async()=>({write:async()=>{},close:async()=>{}}) }];
    window.showSaveFilePicker = async () => { window.__pickerCalled = true; throw new Error('should not') };
    return 'ok'
  })()`, awaitPromise: true, returnByValue: true })
  await send('Runtime.evaluate', { expression: `document.querySelector('.folder-btn')?.click()`, returnByValue: true })
  await sleep(8000)
  const res = await send('Runtime.evaluate', { expression: `(() => {
    const hints = [...document.querySelectorAll('.toolbar-hint')]
    const hint = hints.length ? hints[hints.length - 1].textContent : ''
    const ov = document.querySelector('.annot-canvas')
    let px = 0
    if (ov) { const d = ov.getContext('2d').getImageData(0,0,ov.width,ov.height).data; for (let i=3;i<d.length;i+=4) if (d[i]>40) px++ }
    return JSON.stringify({ hint, px, pickerCalled: !!window.__pickerCalled })
  })()`, returnByValue: true })
  const v = JSON.parse(res.result?.value || '{}')
  console.log('legacy:', JSON.stringify(v))
  // 旧旁车 1 条画笔批注应被读回 → hint 显示 1 条批注且画布有像素，且不弹保存框
  const ok = v.hint.includes('1 条批注') && v.px > 100 && !v.pickerCalled
  console.log('RESULT: ' + (ok ? 'PASS' : 'FAIL'))
  ws.close(); chrome.kill(); process.exit(ok ? 0 : 1)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
