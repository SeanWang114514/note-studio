// 决定性测试：窄窗口（模拟用户截图里页面被截断的环境）下打开 PDF，检查 span 与画布错位
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9492
const profile = process.env.TEMP + '/chrome-decisive-' + PORT
// 用户截图里页面右侧被截断 → 窗口较窄
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--window-size=900,800', '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT, 'about:blank'], { stdio: 'ignore' })
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

  // 关键检查：页面是否超出容器、span 与画布是否错位
  const dump = await send('Runtime.evaluate', { expression: `(() => {
    const page = document.querySelector('.pdf-page')
    const scroll = document.querySelector('.pdf-scroll')
    const canvas = page.querySelector('.pdf-canvas')
    const pr = page.getBoundingClientRect()
    const sr = scroll.getBoundingClientRect()
    const cr = canvas.getBoundingClientRect()
    const tl = page.querySelector('.pdf-text-layer')
    const tr = tl.getBoundingClientRect()
    // span "生登录" 位置
    const span = [...tl.querySelectorAll('span[data-page="1"]')].find(s => (s.textContent || '').includes('生登录'))
    const spr = span.getBoundingClientRect()
    // 画布在 span 中心列的暗带
    const ctx = canvas.getContext('2d')
    const dpr = canvas.width / cr.width
    const sx = Math.round((spr.left - pr.left + spr.width / 2) * dpr)
    const img = ctx.getImageData(Math.max(0, Math.min(canvas.width - 1, sx)), 0, 1, canvas.height).data
    const bands = []
    let inBand = false, start = 0
    for (let y = 0; y < canvas.height; y++) {
      const i = y * 4
      const lum = (img[i] + img[i+1] + img[i+2]) / 3
      if (lum < 150 && !inBand) { inBand = true; start = y }
      if (lum >= 150 && inBand) { inBand = false; if (y - start > 3) bands.push(Math.round((start + y) / 2 / dpr)) }
    }
    return JSON.stringify({
      viewport: innerWidth + 'x' + innerHeight,
      scroll: { clientW: scroll.clientWidth, scrollW: scroll.scrollWidth, left: Math.round(sr.left), right: Math.round(sr.right) },
      page: { left: Math.round(pr.left), right: Math.round(pr.right), w: Math.round(pr.width) },
      pageInside: pr.right <= sr.right + 1 && pr.left >= sr.left - 1,
      canvas: { w: Math.round(cr.width), h: Math.round(cr.height) },
      textLayer: { w: Math.round(tr.width), h: Math.round(tr.height), left: Math.round(tr.left - pr.left), top: Math.round(tr.top - pr.top) },
      span: { text: span.textContent.slice(0, 12), top: Math.round((spr.top - pr.top) * 10) / 10, bottom: Math.round((spr.bottom - pr.top) * 10) / 10 },
      canvasBandsAtSpanCol: bands.slice(0, 6),
      status: [...document.querySelectorAll('.status-bar span')].map(e => e.textContent).join('|')
    })
  })()`, returnByValue: true })
  console.log('DECISIVE:', dump.result?.value)

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const data = shot?.data || shot?.result?.data
  if (data) writeFileSync('D:/VibeCoding/note apps/pdf-narrow-shot.png', Buffer.from(data, 'base64'))
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
  ws.close(); chrome.kill(); process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
