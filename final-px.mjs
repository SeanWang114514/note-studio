// 最终验证：DPR=1.25 下直接采样 canvas 像素，对比 span 中心位置的画布内容
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9510
const profile = process.env.TEMP + '/chrome-final-px-' + PORT
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

  // 关键：采样 canvas 上标题行和"生登录"行的实际暗像素 y 范围
  const dump = await send('Runtime.evaluate', { expression: `(() => {
    const page = document.querySelector('.pdf-page')
    const canvas = page.querySelector('.pdf-canvas')
    const tl = page.querySelector('.pdf-text-layer')
    const pr = page.getBoundingClientRect()
    const dpr = window.devicePixelRatio
    const ctx = canvas.getContext('2d')
    const W = canvas.width, H = canvas.height
    // 在页面中心 x 处扫描暗像素带（避开标题/正文都可能经过的列）
    const centerBufX = Math.round(W / 2)
    const img = ctx.getImageData(centerBufX, 0, 1, H).data
    const bands = []
    let inBand = false, start = 0
    for (let y = 0; y < H; y++) {
      const i = y * 4
      const lum = (img[i] + img[i+1] + img[i+2]) / 3
      if (lum < 150 && !inBand) { inBand = true; start = y }
      if (lum >= 150 && inBand) { inBand = false; if (y - start > 2) bands.push({ start: (start / dpr).toFixed(1), end: (y / dpr).toFixed(1) }) }
    }
    // span 位置（标题、生登录、★行）
    const grab = (t) => { const s = [...tl.querySelectorAll('span[data-page="1"]')].find(x => (x.textContent || '').includes(t)); if (!s) return null; const r = s.getBoundingClientRect(); return { top: (r.top - pr.top).toFixed(1), bottom: (r.bottom - pr.top).toFixed(1) } }
    return JSON.stringify({
      dpr, W, H,
      canvasCSSW: canvas.getBoundingClientRect().width,
      scaleFactor: tl.style.getPropertyValue('--scale-factor'),
      centerColBands: bands.slice(0, 10),
      spanTitle: grab('研究性'),
      spanSheng: grab('生登录'),
      spanStar: grab('★'),
    })
  })()`, returnByValue: true })
  console.log('PX:', dump.result?.value)
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
  ws.close(); chrome.kill(); process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
