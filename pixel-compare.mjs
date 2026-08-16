// 精确对比：画布文字像素位置 vs 文字层 span 位置（找第一行正文）
import { spawn } from 'node:child_process'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9488
const profile = process.env.TEMP + '/chrome-pixel-compare-' + PORT
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
    window.showOpenFilePicker = async () => [{ name:'manual.pdf', kind:'file', getFile: async()=>f, queryPermission: async()=> 'granted', requestPermission: async()=> 'granted', createWritable: async()=>({write:async()=>{},close:async()=>{}}) }];
    window.showSaveFilePicker = async () => { window.__pickerCalled = true; throw new Error('should not') };
    return 'ok'
  })()`, awaitPromise: true, returnByValue: true })
  await send('Runtime.evaluate', { expression: `document.querySelector('.folder-btn')?.click()`, returnByValue: true })
  await sleep(15000)

  // 进入文字编辑模式 + 点中 "所有同学" span，然后对比 span 位置与画布像素
  const info = await send('Runtime.evaluate', { expression: `(() => {
    const span = [...document.querySelectorAll('.pdf-text-layer span[data-page="1"]')].find(s => s.textContent.includes('所有同学'))
    if (!span) return 'NO'
    const r = span.getBoundingClientRect()
    return JSON.stringify({ idx: span.dataset.idx, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`, returnByValue: true })
  const tp = JSON.parse(info.result?.value || 'null')
  if (tp) {
    await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.ribbon-btn')].find(b => (b.title || '').includes('编辑 PDF 文字'))?.click()`, returnByValue: true })
    await sleep(400)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tp.x, y: tp.y, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tp.x, y: tp.y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(800)
  }

  // 对比：span 边框 vs 画布上该行文字的像素（找 y 方向最深色带的中心）
  const cmp = await send('Runtime.evaluate', { expression: `(() => {
    const page = document.querySelector('.pdf-page')
    const canvas = page.querySelector('.pdf-canvas')
    const span = [...document.querySelectorAll('.pdf-text-layer span[data-page="1"]')].find(s => s.textContent.includes('所有同学'))
    const pr = page.getBoundingClientRect()
    const sr = span.getBoundingClientRect()
    // 画布像素：找 x=span中心 这一列的暗色带（文字行）
    const ctx = canvas.getContext('2d')
    const dpr = canvas.width / canvas.getBoundingClientRect().width
    const sx = Math.round((sr.left - pr.left + sr.width / 2) * dpr)
    const img = ctx.getImageData(sx, 0, 1, canvas.height).data
    const bands = []
    let inBand = false, start = 0
    for (let y = 0; y < canvas.height; y++) {
      const i = y * 4
      const lum = (img[i] + img[i+1] + img[i+2]) / 3
      const dark = lum < 150
      if (dark && !inBand) { inBand = true; start = y }
      if (!dark && inBand) { inBand = false; if (y - start > 3) bands.push({ start: start / dpr, end: y / dpr }) }
    }
    const centerBand = bands.find(b => Math.abs((b.start + b.end) / 2 - (sr.top - pr.top + sr.height / 2)) < 20) || bands[0]
    return JSON.stringify({
      spanTop: Math.round((sr.top - pr.top) * 10) / 10,
      spanBottom: Math.round((sr.bottom - pr.top) * 10) / 10,
      canvasBands: bands.slice(0, 8),
      nearestBand: centerBand ? { start: Math.round(centerBand.start * 10) / 10, end: Math.round(centerBand.end * 10) / 10 } : null,
      editing: span.classList.contains('editing'),
      hasBar: !!document.querySelector('.pdf-edit-bar')
    })
  })()`, returnByValue: true })
  console.log('COMPARE:', cmp.result?.value)
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
  ws.close(); chrome.kill(); process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
