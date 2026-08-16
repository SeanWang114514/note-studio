// 全页对比：画布所有暗带位置 vs 文字层所有 span 位置
import { spawn } from 'node:child_process'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9489
const profile = process.env.TEMP + '/chrome-full-compare-' + PORT
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

  const cmp = await send('Runtime.evaluate', { expression: `(() => {
    const page = document.querySelector('.pdf-page')
    const canvas = page.querySelector('.pdf-canvas')
    const pr = page.getBoundingClientRect()
    const dpr = canvas.width / canvas.getBoundingClientRect().width
    // 扫描多条竖线（x = 40%, 50%, 60% 页面宽），统计暗色 y 带
    const ctx = canvas.getContext('2d')
    const W = canvas.width, H = canvas.height
    const xPcts = [0.3, 0.5, 0.7]
    const allBands = new Set()
    for (const pct of xPcts) {
      const sx = Math.round(W * pct)
      const img = ctx.getImageData(sx, 0, 1, H).data
      let inBand = false, start = 0
      for (let y = 0; y < H; y++) {
        const i = y * 4
        const lum = (img[i] + img[i+1] + img[i+2]) / 3
        if (lum < 160 && !inBand) { inBand = true; start = y }
        if (lum >= 160 && inBand) { inBand = false; if (y - start > 4) allBands.add(Math.round((start + y) / 2 / dpr)) }
      }
    }
    const bands = [...allBands].sort((a, b) => a - b)
    // span 位置
    const spans = [...document.querySelectorAll('.pdf-text-layer span[data-page="1"]')].map(s => {
      const r = s.getBoundingClientRect()
      return { idx: s.dataset.idx, text: (s.textContent || '').slice(0, 12), y: Math.round((r.top - pr.top + r.height / 2) * 10) / 10 }
    }).filter(s => s.text && s.text.trim())
    return JSON.stringify({ dpr, canvasCSSW: canvas.getBoundingClientRect().width, bands, spans: spans.slice(0, 20) })
  })()`, returnByValue: true })
  console.log('FULL:', cmp.result?.value)
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
  ws.close(); chrome.kill(); process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
