// 对比 DPR=1 vs DPR=1.25：canvas 渲染文字位置 vs span 位置
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

async function run(dpr) {
  const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  const PORT = 9513 + Math.round(dpr * 100)
  const profile = process.env.TEMP + '/chrome-cmp-' + PORT
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1548,547', '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT, 'about:blank']
  if (dpr !== 1) args.splice(3, 0, '--force-device-scale-factor=' + dpr)
  const chrome = spawn(CHROME, args, { stdio: 'ignore' })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let target
  for (let i = 0; i < 40; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find(t => t.type === 'page'); if (p) { target = p; break } } catch {}
    await sleep(300)
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
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
    const dpr = window.devicePixelRatio
    const grab = (t) => { const s = [...tl.querySelectorAll('span[data-page="1"]')].find(x => (x.textContent || '').includes(t)); if (!s) return null; const r = s.getBoundingClientRect(); return Math.round((r.top - pr.top + r.height / 2) * 10) / 10 }
    const spans = { title: grab('研究性'), line1: grab('所有同学'), sheng: grab('生登录'), star: grab('★') }
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
    const canvasLines = bands.map(b => Math.round((b.start + b.end) / 2)).slice(0, 8)
    return JSON.stringify({ dpr, scaleFactor: tl.style.getPropertyValue('--scale-factor'), spans, canvasLines, status: [...document.querySelectorAll('.status-bar span')].map(e => e.textContent).join('|') })
  })()`, returnByValue: true })
  const out = dump.result?.value
  console.log('DPR=' + dpr + ':', out)
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
  ws.close(); chrome.kill()
  return out
}

run(1).then(async (r1) => {
  await new Promise(r => setTimeout(r, 1000))
  return run(1.25)
}).catch(e => { console.error('ERR', e.message); process.exit(1) })
