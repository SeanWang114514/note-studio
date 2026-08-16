// DPR=1.25 下截图 + 像素级验证 span 与画布是否错位
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9506
const profile = process.env.TEMP + '/chrome-dpr-shot-' + PORT
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

  // 进入编辑模式 + 点击"生登录" span
  await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.ribbon-btn')].find(b => (b.title || '').includes('编辑 PDF 文字'))?.click()`, returnByValue: true })
  await sleep(400)
  const info = await send('Runtime.evaluate', { expression: `(() => {
    const span = [...document.querySelectorAll('.pdf-text-layer span[data-page="1"]')].find(s => (s.textContent || '').includes('生登录'))
    if (!span) return 'NO'
    const r = span.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`, returnByValue: true })
  const tp = JSON.parse(info.result?.value || 'null')
  if (tp) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tp.x, y: tp.y, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tp.x, y: tp.y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(800)
  }

  // 截图
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const data = shot?.data || shot?.result?.data
  if (data) writeFileSync('D:/VibeCoding/note apps/pdf-dpr125-edit.png', Buffer.from(data, 'base64'))

  // span 与画布像素对比
  const cmp = await send('Runtime.evaluate', { expression: `(() => {
    const page = document.querySelector('.pdf-page')
    const canvas = page.querySelector('.pdf-canvas')
    const tl = page.querySelector('.pdf-text-layer')
    const pr = page.getBoundingClientRect()
    const dpr = canvas.width / canvas.getBoundingClientRect().width
    const span = [...tl.querySelectorAll('span[data-page="1"]')].find(s => (s.textContent || '').includes('生登录'))
    const sr = span.getBoundingClientRect()
    const ctx = canvas.getContext('2d')
    const sx = Math.round((sr.left - pr.left + sr.width / 2) * dpr)
    const img = ctx.getImageData(Math.max(0, Math.min(canvas.width - 1, sx)), 0, 1, canvas.height).data
    const rawBands = []
    let inBand = false, start = 0
    for (let y = 0; y < canvas.height; y++) {
      const i = y * 4
      const lum = (img[i] + img[i+1] + img[i+2]) / 3
      if (lum < 160 && !inBand) { inBand = true; start = y }
      if (lum >= 160 && inBand) { inBand = false; if (y - start > 2) rawBands.push({ start: (start / dpr).toFixed(1), end: (y / dpr).toFixed(1) }) }
    }
    return JSON.stringify({
      dpr, scaleFactor: tl.style.getPropertyValue('--scale-factor'),
      span: { top: (sr.top - pr.top).toFixed(1), bottom: (sr.bottom - pr.top).toFixed(1), text: span.textContent.slice(0, 12), editing: span.classList.contains('editing') },
      canvasBandsAtSpanCol: rawBands.slice(0, 6),
    })
  })()`, returnByValue: true })
  console.log('DPR125-SHOT:', cmp.result?.value)
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
  ws.close(); chrome.kill(); process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
