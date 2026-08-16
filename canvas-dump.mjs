// 保存画布为图片 + 检测文字行亮度剖面，确认画布文字实际位置
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9490
const profile = process.env.TEMP + '/chrome-canvas-dump-' + PORT
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

  // 保存画布图片
  const saved = await send('Runtime.evaluate', { expression: `(() => {
    const canvas = document.querySelector('.pdf-canvas')
    const dataUrl = canvas.toDataURL('image/png')
    return dataUrl
  })()`, returnByValue: true })
  const b64 = saved.result?.value || ''
  if (b64) writeFileSync('D:/VibeCoding/note apps/pdf-canvas-only.png', Buffer.from(b64.split(',')[1], 'base64'))
  console.log('canvas saved, len:', b64.length)

  // 逐行亮度剖面（每 2px 采样一行平均暗度，定位文字行）
  const profile2 = await send('Runtime.evaluate', { expression: `(() => {
    const canvas = document.querySelector('.pdf-canvas')
    const ctx = canvas.getContext('2d')
    const W = canvas.width, H = canvas.height
    const rows = []
    for (let y = 0; y < H; y += 2) {
      const img = ctx.getImageData(0, y, W, 1).data
      let dark = 0, total = 0
      for (let x = 0; x < W; x += 4) {
        const i = x * 4
        const lum = (img[i] + img[i+1] + img[i+2]) / 3
        if (lum < 150) dark++
        total++
      }
      if (dark / total > 0.01) rows.push({ y, ratio: Math.round(dark / total * 1000) / 1000 })
    }
    // 聚合成带
    const bands = []
    let cur = null
    for (const r of rows) {
      if (!cur || r.y - cur.end > 3) { cur = { start: r.y, end: r.y }; bands.push(cur) }
      else cur.end = r.y
    }
    return JSON.stringify(bands.map(b => ({ start: b.start, end: b.end, center: Math.round((b.start + b.end) / 2) })))
  })()`, returnByValue: true })
  console.log('CANVAS TEXT BANDS:', profile2.result?.value)
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
  ws.close(); chrome.kill(); process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
