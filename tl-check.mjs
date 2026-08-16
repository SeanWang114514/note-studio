// 决定性：DPR=1.25 下对比 textLayer 容器 vs canvas 位置 + span 实际像素
import { spawn } from 'node:child_process'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9509
const profile = process.env.TEMP + '/chrome-tl-check-' + PORT
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--force-device-scale-factor=1.25', '--window-size=1548,547', '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT, 'about:blank'], { stdio: 'ignore' })
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
    window.showOpenFilePicker = async () => [{ name:'manual.pdf', kind:'file', getFile: async()=>f, queryPermission: async()=> 'granted', requestPermission: async()=> 'granted', createWritable: async()=>({write:async()=>{},close:async()=>{}}) }];
    window.showSaveFilePicker = async () => { window.__pickerCalled = true; throw new Error('should not') };
    return 'ok'
  })()`, awaitPromise: true, returnByValue: true })
  await send('Runtime.evaluate', { expression: `document.querySelector('.folder-btn')?.click()`, returnByValue: true })
  await sleep(15000)

  const dump = await send('Runtime.evaluate', { expression: `(() => {
    const page = document.querySelector('.pdf-page')
    const cc = page.querySelector('.pdf-canvas-container')
    const canvas = page.querySelector('.pdf-canvas')
    const tl = page.querySelector('.pdf-text-layer')
    const pr = page.getBoundingClientRect()
    const ccr = cc.getBoundingClientRect()
    const cr = canvas.getBoundingClientRect()
    const tr = tl.getBoundingClientRect()
    // 找标题 span（idx0）和"生登录" span
    const spanTitle = tl.querySelector('span[data-page="1"][data-idx="0"]')
    const spanEdit = [...tl.querySelectorAll('span[data-page="1"]')].find(s => (s.textContent || '').includes('生登录'))
    const st = spanTitle.getBoundingClientRect()
    const se = spanEdit.getBoundingClientRect()
    return JSON.stringify({
      dpr: window.devicePixelRatio,
      status: [...document.querySelectorAll('.status-bar span')].map(e => e.textContent).join('|'),
      scaleFactor: tl.style.getPropertyValue('--scale-factor'),
      rel: {
        cc: { x: Math.round((ccr.left - pr.left) * 10) / 10, y: Math.round((ccr.top - pr.top) * 10) / 10, w: Math.round(ccr.width), h: Math.round(ccr.height) },
        canvas: { x: Math.round((cr.left - pr.left) * 10) / 10, y: Math.round((cr.top - pr.top) * 10) / 10, w: Math.round(cr.width), h: Math.round(cr.height) },
        textLayer: { x: Math.round((tr.left - pr.left) * 10) / 10, y: Math.round((tr.top - pr.top) * 10) / 10, w: Math.round(tr.width), h: Math.round(tr.height) },
      },
      title: { top: Math.round((st.top - pr.top) * 10) / 10, inlineTop: spanTitle.style.top },
      edit: { top: Math.round((se.top - pr.top) * 10) / 10, inlineTop: spanEdit.style.top },
    })
  })()`, returnByValue: true })
  console.log('TL-CHECK:', dump.result?.value)
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
  ws.close(); chrome.kill(); process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
