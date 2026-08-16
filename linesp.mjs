// 核心验证：DPR=1.25 时 canvas 渲染的实际行距 vs span 行距
import { spawn } from 'node:child_process'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9511
const profile = process.env.TEMP + '/chrome-linesp-' + PORT
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

  // 用一行文字的跨度（标题 y 与 ★行 y 之间）对比 span 与画布的比例
  const dump = await send('Runtime.evaluate', { expression: `(() => {
    const page = document.querySelector('.pdf-page')
    const canvas = page.querySelector('.pdf-canvas')
    const tl = page.querySelector('.pdf-text-layer')
    const pr = page.getBoundingClientRect()
    const dpr = window.devicePixelRatio
    // 画布全宽扫描：找所有文字行
    const ctx = canvas.getContext('2d')
    const W = canvas.width, H = canvas.height
    const rowDark = []
    for (let y = 0; y < H; y += 2) {
      const img = ctx.getImageData(0, y, W, 1).data
      let dark = 0
      for (let x = 0; x < W; x += 4) { const i = x * 4; if ((img[i] + img[i+1] + img[i+2]) / 3 < 150) dark++ }
      if (dark > 5) rowDark.push(y / dpr)
    }
    const bands = []
    let cur = null
    for (const y of rowDark) { if (!cur || y - cur.end > 8) { cur = { start: y, end: y }; bands.push(cur) } else cur.end = y }
    const canvasBands = bands.map(b => ({ start: Math.round(b.start), end: Math.round(b.end), center: Math.round((b.start + b.end) / 2) }))
    // span 行（标题、1.、生登录、★）
    const grab = (t) => { const s = [...tl.querySelectorAll('span[data-page="1"]')].find(x => (x.textContent || '').includes(t)); if (!s) return null; const r = s.getBoundingClientRect(); return Math.round((r.top - pr.top + r.height / 2) * 10) / 10 }
    const spanLines = [grab('研究性'), grab('所有同学'), grab('生登录'), grab('★')]
    return JSON.stringify({ dpr, scaleFactor: tl.style.getPropertyValue('--scale-factor'), canvasBands: canvasBands.slice(0, 10), spanLines })
  })()`, returnByValue: true })
  console.log('LINE-SPACING:', dump.result?.value)
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
  ws.close(); chrome.kill(); process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
