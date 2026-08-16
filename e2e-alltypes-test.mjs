// E2E：docx/epub/xlsx/md 视图渲染 + 批注工具（画一笔 → 批注数 +1，保存去向验证）
import { spawn } from 'node:child_process'
import JSZip from 'jszip'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9420
const profile = process.env.TEMP + '/chrome-alltypes-' + PORT
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1280,900', '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT, 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find(t => t.type === 'page'); if (p) return p } catch {}
    await sleep(300)
  }
  throw new Error('no target')
}

const TYPES = [
  { key: 'docx', name: 'test-edit.docx', bodySel: '.docx-body', urlParam: 't=1' },
  { key: 'epub', name: 'test-edit.epub', bodySel: '.epub-body', urlParam: 't=2' },
  { key: 'excel', name: 'test-edit.xlsx', bodySel: '.excel-body table', urlParam: 't=3' },
  { key: 'md', name: 'test-edit.md', bodySel: '.md-body', urlParam: 't=4' },
]

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

  let allOk = true
  for (const tc of TYPES) {
    // 重新导航（干净页面）
    await send('Page.navigate', { url: `http://127.0.0.1:5199/?t=${tc.key}` })
    await sleep(4000)
    // mock 文件选择器 + 写回捕获 + 假 IndexedDB（原生句柄不可 mock，用内存 store）
    await send('Runtime.evaluate', { expression: `(()=>{
      const store = {};
      window.__idbStore = store;
      const mkReq = (result) => { const req = { result, onsuccess:null, onerror:null }; setTimeout(()=>{ req.onsuccess && req.onsuccess({target:req}) },0); return req };
      const fakeStore = { get: (k) => mkReq(store[k]), put: (v) => { store[v.key] = v; return mkReq(v.key) } };
      Object.defineProperty(window, 'indexedDB', { value: { open: () => { const req = { onupgradeneeded:null, onsuccess:null, onerror:null, result: { objectStoreNames:{ contains:()=>true }, createObjectStore:()=>{}, transaction:()=>({ objectStore:()=>fakeStore }) } }; setTimeout(()=>{ req.onsuccess && req.onsuccess({target:req}) },0); return req } }, configurable: true });
    })()`, returnByValue: true })
    await send('Runtime.evaluate', { expression: `(async () => {
      const r = await fetch('/${tc.name}'); const b = await r.arrayBuffer();
      const f = new File([b], '${tc.name}', { type: 'application/octet-stream' });
      window.__savedBytes = null;
      window.__savedAnn = '';
      window.__pickerCalled = false;
      window.showOpenFilePicker = async () => [{ name:'${tc.name}', kind:'file', getFile: async()=>f, queryPermission: async()=> 'granted', requestPermission: async()=> 'granted', createWritable: async()=>({write:async(data)=>{ window.__savedBytes = data instanceof Uint8Array ? data : new Uint8Array(0); },close:async()=>{}}) }];
      window.showSaveFilePicker = async () => { window.__pickerCalled = true; throw new Error('save picker should not be called') };
      return 'ok'
    })()`, awaitPromise: true, returnByValue: true })
    await send('Runtime.evaluate', { expression: `document.querySelector('.folder-btn')?.click()`, returnByValue: true })
    await sleep(8000)

    // 渲染检查
    const render = await send('Runtime.evaluate', { expression: `(() => {
      const body = document.querySelector('${tc.bodySel}')
      const canvas = document.querySelector('.annot-canvas')
      const hints = [...document.querySelectorAll('.toolbar-hint')]
      return JSON.stringify({ bodyLen: body?.innerHTML?.length || 0, canvas: !!canvas, status: hints.length ? hints[hints.length - 1].textContent : '' })
    })()`, returnByValue: true })
    const rv = JSON.parse(render.result?.value || '{}')
    console.log(`[${tc.key}] render: bodyLen=${rv.bodyLen} canvas=${rv.canvas} status=${rv.status}`)

    // 画一笔（brush）
    let pos = null
    for (let i = 0; i < 20; i++) {
      const r = await send('Runtime.evaluate', { expression: `(() => { const c = document.querySelector('.annot-canvas'); if (!c) return 'NO'; const r = c.getBoundingClientRect(); return JSON.stringify({ left: r.left, top: r.top, w: r.width, h: r.height }) })()`, returnByValue: true })
      if (r.result?.value && r.result.value !== 'NO') { pos = JSON.parse(r.result.value); break }
      await sleep(300)
    }
    if (!pos) { console.log(`[${tc.key}] NO CANVAS`); allOk = false; continue }
    // 切到画笔工具
    await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.tool-btn, .icon-btn')].find(b => b.title && b.title.includes('画笔'))?.click()`, returnByValue: true })
    await sleep(200)
    const a = { x: Math.round(pos.left + 0.3 * pos.w), y: Math.round(pos.top + 0.4 * pos.h) }
    const b = { x: Math.round(pos.left + 0.6 * pos.w), y: Math.round(pos.top + 0.55 * pos.h) }
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 })
    for (let i = 1; i <= 5; i++) {
      const t2 = i / 5
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(a.x + (b.x - a.x) * t2), y: Math.round(a.y + (b.y - a.y) * t2), buttons: 1 })
      await sleep(20)
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(1500)

    const after = await send('Runtime.evaluate', { expression: `(async () => {
      const hints = [...document.querySelectorAll('.toolbar-hint')]
      const hint = hints.length ? hints[hints.length - 1].textContent : ''
      const ov = document.querySelector('.annot-canvas')
      let px = 0
      if (ov) { const d = ov.getContext('2d').getImageData(0,0,ov.width,ov.height).data; for (let i=3;i<d.length;i+=4) if (d[i]>40) px++ }
      // 校验保存去向：
      //   zip 类 → __savedBytes 内嵌 noteflow/annotations.json；md → 假 IndexedDB 里有批注数据
      let embed = null, idb = null, b64 = ''
      if (window.__savedBytes && window.__savedBytes.length) {
        const text = new TextDecoder().decode(window.__savedBytes)
        embed = text.includes('noteflow/annotations.json')
        b64 = btoa(String.fromCharCode(...window.__savedBytes))
      }
      idb = !!window.__idbStore && Object.values(window.__idbStore).some(v => v && v.data && JSON.stringify(v.data).includes('"type":"brush"'))
      return JSON.stringify({ hint, px, savedLen: (window.__savedBytes||[]).length, pickerCalled: !!window.__pickerCalled, embed, idb, b64 })
    })()`, awaitPromise: true, returnByValue: true })
    const av = JSON.parse(after.result?.value || '{}')
    console.log(`[${tc.key}] after: hint=${av.hint} px=${av.px} savedLen=${av.savedLen} pickerCalled=${av.pickerCalled} embed=${av.embed} idb=${av.idb}`)
    const isZip = tc.key === 'docx' || tc.key === 'epub' || tc.key === 'excel'
    let embedJson = false
    if (isZip && av.b64) {
      // 深验证：内嵌 JSON 可解析且含画笔批注
      try {
        const buf = Buffer.from(av.b64, 'base64')
        const zip = await JSZip.loadAsync(buf)
        const f = zip.file('noteflow/annotations.json')
        if (f) {
          const parsed = JSON.parse(await f.async('string'))
          embedJson = (parsed[tc.key] || []).some((a) => a.type === 'brush')
        }
      } catch {}
    }
    console.log(`[${tc.key}] embedJson=${embedJson}`)
    const savedOk = isZip ? (av.savedLen > 0 && av.embed && embedJson) : av.idb
    const ok = rv.bodyLen > 0 && rv.canvas && av.px > 100 && av.hint.includes('1 条批注') && savedOk && !av.pickerCalled
    if (!ok) allOk = false
    console.log(`[${tc.key}] ${ok ? 'PASS' : 'FAIL'}`)
  }

  console.log('ERRORS:', errors.length ? errors.join('\n').slice(0, 1000) : 'none')
  console.log('RESULT: ' + (allOk ? 'PASS' : 'FAIL'))
  ws.close(); chrome.kill(); process.exit(allOk ? 0 : 1)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
