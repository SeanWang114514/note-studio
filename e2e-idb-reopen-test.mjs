// E2E：md 批注存 IndexedDB → 跨导航读回（真实 IndexedDB，不 mock）
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9460
const profile = process.env.TEMP + '/chrome-idb-reopen-' + PORT
rmSync(profile, { recursive: true, force: true })
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

  const openMock = `(async () => {
    const r = await fetch('/test-edit.md'); const b = await r.arrayBuffer();
    const f = new File([b], 'test-edit.md', { lastModified: 1234567890 });
    window.showOpenFilePicker = async () => [{ name:'test-edit.md', kind:'file', getFile: async()=>f, queryPermission: async()=> 'granted', requestPermission: async()=> 'granted', createWritable: async()=>({write:async()=>{},close:async()=>{}}) }];
    window.showSaveFilePicker = async () => { window.__pickerCalled = true; throw new Error('should not') };
    return 'ok'
  })()`

  // PHASE 1：打开 md → 画一笔 → 批注自动存真实 IndexedDB
  await send('Page.navigate', { url: 'http://127.0.0.1:5199/?t=md' })
  await sleep(4000)
  await send('Runtime.evaluate', { expression: openMock, awaitPromise: true, returnByValue: true })
  await send('Runtime.evaluate', { expression: `document.querySelector('.folder-btn')?.click()`, returnByValue: true })
  await sleep(8000)
  let pos = null
  for (let i = 0; i < 20; i++) {
    const r = await send('Runtime.evaluate', { expression: `(() => { const c = document.querySelector('.annot-canvas'); if (!c) return 'NO'; const r = c.getBoundingClientRect(); return JSON.stringify({ left: r.left, top: r.top, w: r.width, h: r.height }) })()`, returnByValue: true })
    if (r.result?.value && r.result.value !== 'NO') { pos = JSON.parse(r.result.value); break }
    await sleep(300)
  }
  if (!pos) { console.log('PHASE1 NO CANVAS'); process.exit(1) }
  await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.tool-btn, .icon-btn')].find(b => b.title && b.title.includes('画笔'))?.click()`, returnByValue: true })
  await sleep(200)
  const a = { x: Math.round(pos.left + 0.3 * pos.w), y: Math.round(pos.top + 0.4 * pos.h) }
  const b = { x: Math.round(pos.left + 0.6 * pos.w), y: Math.round(pos.top + 0.55 * pos.h) }
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 5; i++) { const t2 = i / 5; await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(a.x + (b.x - a.x) * t2), y: Math.round(a.y + (b.y - a.y) * t2), buttons: 1 }); await sleep(20) }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(2000)
  const p1 = await send('Runtime.evaluate', { expression: `(() => {
    const hints = [...document.querySelectorAll('.toolbar-hint')]
    return JSON.stringify({ hint: hints.length ? hints[hints.length - 1].textContent : '', pickerCalled: !!window.__pickerCalled })
  })()`, returnByValue: true })
  const v1 = JSON.parse(p1.result?.value || '{}')
  console.log('PHASE1:', JSON.stringify(v1))

  // PHASE 2：重新导航 → 打开同一文件（同 lastModified）→ IndexedDB 批注应读回
  await send('Page.navigate', { url: 'http://127.0.0.1:5199/?t=md' })
  await sleep(4000)
  await send('Runtime.evaluate', { expression: openMock, awaitPromise: true, returnByValue: true })
  await send('Runtime.evaluate', { expression: `document.querySelector('.folder-btn')?.click()`, returnByValue: true })
  await sleep(8000)
  const p2 = await send('Runtime.evaluate', { expression: `(() => {
    const hints = [...document.querySelectorAll('.toolbar-hint')]
    const hint = hints.length ? hints[hints.length - 1].textContent : ''
    const ov = document.querySelector('.annot-canvas')
    let px = 0
    if (ov) { const d = ov.getContext('2d').getImageData(0,0,ov.width,ov.height).data; for (let i=3;i<d.length;i+=4) if (d[i]>40) px++ }
    return JSON.stringify({ hint, px })
  })()`, returnByValue: true })
  const v2 = JSON.parse(p2.result?.value || '{}')
  console.log('PHASE2:', JSON.stringify(v2))

  const ok = v1.hint.includes('1 条批注') && !v1.pickerCalled && v2.hint.includes('1 条批注') && v2.px > 100
  console.log('ERRORS:', errors.length ? errors.join('\n').slice(0, 500) : 'none')
  console.log('RESULT: ' + (ok ? 'PASS' : 'FAIL'))
  ws.close(); chrome.kill(); process.exit(ok ? 0 : 1)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
