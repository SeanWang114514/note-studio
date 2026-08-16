// 终极验证：读取 canvas 物理像素，找"生登录"行文字的实际 buffer y 位置
import { spawn } from 'node:child_process'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9514
const profile = process.env.TEMP + '/chrome-buffer-' + PORT
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
    if (msg.method === 'Runtime.exceptionThrown') errors.push('EXC: ' + (msg.params.exceptionDetails?.exception?.description || '').slice(0, 300))
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
    const canvas = page.querySelector('.pdf-canvas')
    const tl = page.querySelector('.pdf-text-layer')
    const pr = page.getBoundingClientRect()
    const cr = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio
    const span = [...tl.querySelectorAll('span[data-page="1"]')].find(s => (s.textContent || '').includes('生登录'))
    const sr = span.getBoundingClientRect()
    // span 的 CSS top（相对 page）与 buffer 期望位置
    const cssTop = sr.top - pr.top
    const bufTopExpected = cssTop * dpr
    // 在 span 中心列扫描 buffer 暗带（物理像素）
    const ctx = canvas.getContext('2d')
    const sx = Math.round((sr.left - pr.left + sr.width / 2) * dpr)
    const img = ctx.getImageData(Math.max(0, Math.min(canvas.width - 1, sx)), 0, 1, canvas.height).data
    const bands = []
    let inBand = false, start = 0
    for (let y = 0; y < canvas.height; y++) {
      const i = y * 4
      const lum = (img[i] + img[i+1] + img[i+2]) / 3
      if (lum < 160 && !inBand) { inBand = true; start = y }
      if (lum >= 160 && inBand) { inBand = false; if (y - start > 2) bands.push({ start, end: y }) }
    }
    return JSON.stringify({
      dpr,
      spanCSS: { top: cssTop.toFixed(1), bottom: (sr.bottom - pr.top).toFixed(1) },
      bufTopExpected: bufTopExpected.toFixed(1),
      canvasBuf: { w: canvas.width, h: canvas.height },
      canvasCSS: { w: cr.width.toFixed(0), h: cr.height.toFixed(0) },
      bufferBandsAtSpanCol: bands.slice(0, 6),
    })
  })()`, returnByValue: true })
  console.log('BUFFER:', dump.result?.value)
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
  ws.close(); chrome.kill(); process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
