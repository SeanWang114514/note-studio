// 打开 PDF 截图，观察渲染效果（错位/显示不全）
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9480
const profile = process.env.TEMP + '/chrome-pdf-shot-' + PORT
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

  await send('Runtime.evaluate', { expression: `(async () => {
    const r = await fetch('/repro-test.pdf'); const b = await r.arrayBuffer();
    const f = new File([b], 'repro-test.pdf', { type: 'application/pdf' });
    window.__file = f;
    window.showOpenFilePicker = async () => [{ name:'repro-test.pdf', kind:'file', getFile: async()=>f, queryPermission: async()=> 'granted', requestPermission: async()=> 'granted', createWritable: async()=>({write:async()=>{},close:async()=>{}}) }];
    window.showSaveFilePicker = async () => { window.__pickerCalled = true; throw new Error('should not') };
    return 'ok'
  })()`, awaitPromise: true, returnByValue: true })
  await send('Runtime.evaluate', { expression: `document.querySelector('.folder-btn')?.click()`, returnByValue: true })
  await sleep(12000)

  // 截图整个页面
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const data = shot?.data || shot?.result?.data
  if (data) writeFileSync('D:/VibeCoding/note apps/pdf-shot-1.png', Buffer.from(data, 'base64'))

  // 检查页面尺寸与缩放
  const state = await send('Runtime.evaluate', { expression: `(() => {
    const pages = [...document.querySelectorAll('.pdf-page')]
    const info = pages.map(p => {
      const c = p.querySelector('.pdf-canvas')
      const cc = p.querySelector('.pdf-canvas-container')
      const tl = p.querySelector('.pdf-text-layer')
      const r = p.getBoundingClientRect()
      return { page: p.dataset.page, rectW: Math.round(r.width), rectH: Math.round(r.height), canvasW: c?.width, canvasH: c?.height, ccW: cc?.getBoundingClientRect().width, ccH: cc?.getBoundingClientRect().height, tlW: tl?.getBoundingClientRect().width, tlH: tl?.getBoundingClientRect().height }
    })
    const scroll = document.querySelector('.pdf-scroll')
    return JSON.stringify({ info, scrollW: scroll?.clientWidth, scrollH: scroll?.clientHeight, scrollCw: scroll?.scrollWidth })
  })()`, returnByValue: true })
  console.log('STATE:', state.result?.value)
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
  ws.close(); chrome.kill(); process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
