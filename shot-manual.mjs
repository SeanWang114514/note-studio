// 用用户实际 PDF（manual.pdf）复现渲染/错位问题
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9483
const profile = process.env.TEMP + '/chrome-manual-' + PORT
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
    const r = await fetch('/manual.pdf'); const b = await r.arrayBuffer();
    const f = new File([b], 'manual.pdf', { type: 'application/pdf' });
    window.__file = f;
    window.showOpenFilePicker = async () => [{ name:'manual.pdf', kind:'file', getFile: async()=>f, queryPermission: async()=> 'granted', requestPermission: async()=> 'granted', createWritable: async()=>({write:async()=>{},close:async()=>{}}) }];
    window.showSaveFilePicker = async () => { window.__pickerCalled = true; throw new Error('should not') };
    return 'ok'
  })()`, awaitPromise: true, returnByValue: true })
  await send('Runtime.evaluate', { expression: `document.querySelector('.folder-btn')?.click()`, returnByValue: true })
  await sleep(15000)

  // 页面与文字层对齐检查
  const align = await send('Runtime.evaluate', { expression: `(() => {
    const page = document.querySelector('.pdf-page')
    const canvas = page.querySelector('.pdf-canvas')
    const tl = page.querySelector('.pdf-text-layer')
    const pr = page.getBoundingClientRect()
    const cr = canvas.getBoundingClientRect()
    const tr = tl.getBoundingClientRect()
    const spans = [...tl.querySelectorAll('span[data-page]')].slice(0, 8).map(s => {
      const r = s.getBoundingClientRect()
      return { idx: s.dataset.idx, text: (s.textContent || '').slice(0, 25), left: Math.round((r.left - pr.left) * 10) / 10, top: Math.round((r.top - pr.top) * 10) / 10, w: Math.round(r.width), h: Math.round(r.height), fs: s.style.fontSize }
    })
    const scroll = document.querySelector('.pdf-scroll')
    return JSON.stringify({
      page: { w: Math.round(pr.width), h: Math.round(pr.height) },
      canvas: { x: Math.round(cr.left - pr.left), y: Math.round(cr.top - pr.top), w: Math.round(cr.width), h: Math.round(cr.height) },
      textLayer: { x: Math.round(tr.left - pr.left), y: Math.round(tr.top - pr.top), w: Math.round(tr.width), h: Math.round(tr.height) },
      scaleFactor: tl.style.getPropertyValue('--scale-factor'),
      scrollClientW: scroll?.clientWidth, scrollScrollW: scroll?.scrollWidth,
      spans,
      pageCount: document.querySelectorAll('.pdf-page').length,
      status: [...document.querySelectorAll('.status-bar span')].map(e => e.textContent).join('|')
    })
  })()`, returnByValue: true })
  console.log('ALIGN:', align.result?.value)

  // 截图第一页
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const data = shot?.data || shot?.result?.data
  if (data) writeFileSync('D:/VibeCoding/note apps/pdf-manual-1.png', Buffer.from(data, 'base64'))
  console.log('shot saved')
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
  ws.close(); chrome.kill(); process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
