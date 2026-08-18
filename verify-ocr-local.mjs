// E2E: 内置模型本地加载（零外网请求）—— v5 手写识别 + v6 印刷体识别
import { spawn } from 'node:child_process'
const BASE = process.env.OCR_URL || 'http://127.0.0.1:5173/'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9441
const TMP = 'C:/Users/Administrator/AppData/Local/Temp'
const profile = TMP + '/chrome-ocr-local-' + PORT + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
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
  const remoteReqs = []; const modelReqs = []
  const send = (m, p = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method: m, params: p })) })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Network.requestWillBeSent') {
      const u = msg.params?.request?.url || ''
      if (/bcebos\.com|^https?:\/\/(?!127\.0\.0\.1|localhost)/i.test(u)) remoteReqs.push(u.slice(0, 160))
      if (/\/models\//.test(u)) modelReqs.push(u.split('/').pop())
    }
    if (msg.method === 'Runtime.exceptionThrown') errors.push('EXC: ' + (msg.params.exceptionDetails?.exception?.description || '').slice(0, 400))
    if (msg.id && pending.has(msg.id)) { const q = pending.get(msg.id); pending.delete(msg.id); msg.error ? q.rej(new Error(msg.error.message)) : q.res(msg.result) }
  }
  await new Promise(r => (ws.onopen = r))
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Page.navigate', { url: BASE })
  await sleep(6000)
  await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.ocr-btn')].find(x => x.textContent.includes('文字识别'))?.click()`, returnByValue: true })
  await sleep(1200)
  let info = null
  for (let i = 0; i < 30; i++) {
    const r = await send('Runtime.evaluate', { expression: `(() => {
      const c = document.querySelector('.ocr-canvas'); const m = document.querySelector('.ocr-modal')
      if (!c || !m) return 'NO'
      const rect = c.getBoundingClientRect()
      return JSON.stringify({ left: rect.left, top: rect.top, w: rect.width, h: rect.height })
    })()`, returnByValue: true })
    if (r.result?.value && r.result.value !== 'NO') { info = JSON.parse(r.result.value); break }
    await sleep(300)
  }
  if (!info) throw new Error('modal not found')
  const { left, top, w, h } = info
  const strokes = [
    [[0.16, 0.34], [0.30, 0.335], [0.45, 0.33], [0.60, 0.332], [0.75, 0.336], [0.86, 0.34]],
    [[0.16, 0.66], [0.30, 0.655], [0.45, 0.65], [0.60, 0.652], [0.75, 0.656], [0.86, 0.66]],
    [[0.70, 0.30], [0.74, 0.44]],
    [[0.72, 0.70], [0.76, 0.82]],
  ]
  async function draw(pts) {
    const sx = left + pts[0][0] * w, sy = top + pts[0][1] * h
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(sx), y: Math.round(sy), button: 'left', buttons: 1, clickCount: 1 })
    for (const p of pts.slice(1)) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(left + p[0] * w), y: Math.round(top + p[1] * h), buttons: 1 }); await sleep(20) }
    const lx = pts[pts.length - 1]
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(left + lx[0] * w), y: Math.round(top + lx[1] * h), button: 'left', buttons: 0, clickCount: 1 })
    await sleep(120)
  }
  const setModel = async (id) => {
    await send('Runtime.evaluate', { expression: `(() => {
      const sel = document.querySelector('.ocr-select')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
      setter.call(sel, '${id}')
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })()`, returnByValue: true })
    await sleep(400)
  }
  const pasteBigText = async () => {
    await send('Runtime.evaluate', { expression: `(async () => {
      const c = document.createElement('canvas')
      c.width = 1000; c.height = 400
      const ctx = c.getContext('2d')
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 1000, 400)
      ctx.fillStyle = '#000000'
      ctx.font = 'bold 90px sans-serif'
      ctx.fillText('HELLO', 120, 150)
      ctx.fillText('WORLD', 120, 300)
      const blob = await new Promise(r => c.toBlob(r, 'image/png'))
      const dt = new DataTransfer()
      dt.items.add(new File([blob], 'bigtext.png', { type: 'image/png' }))
      document.querySelector('.ocr-canvas')?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      return true
    })()`, returnByValue: true, awaitPromise: true })
    await sleep(800)
  }
  const runAndWait = async (label) => {
    await send('Runtime.evaluate', { expression: `document.querySelector('.ocr-run')?.click()`, returnByValue: true })
    const startedAt = Date.now()
    while (Date.now() - startedAt < 150000) {
      const r = await send('Runtime.evaluate', { expression: `(() => {
        const pre = document.querySelector('.ocr-result-text pre')?.textContent || ''
        const err = document.querySelector('.ocr-error')?.textContent || ''
        return JSON.stringify({ done: !!document.querySelector('.ocr-result'), pre, err })
      })()`, returnByValue: true })
      const v = JSON.parse(r.result?.value || '{}')
      if (v.err) throw new Error(label + ' error: ' + v.err)
      if (v.done) { console.log(label + ': text=' + JSON.stringify(v.pre.slice(0, 60))); return v.pre }
      await sleep(500)
    }
    throw new Error(label + ' timeout')
  }

  for (const s of strokes) await draw(s)
  const t1 = await runAndWait('v5 手写')

  await setModel('ppocr-v6')
  await pasteBigText()
  const t2 = await runAndWait('v6 印刷体')

  console.log('remote requests:', remoteReqs.length ? remoteReqs : 'NONE')
  console.log('local model requests:', modelReqs)
  if (remoteReqs.length) throw new Error('不应有外部请求！')
  for (const f of ['PP-OCRv5_mobile_det_onnx_infer.tar', 'PP-OCRv5_mobile_rec_onnx_infer.tar', 'PP-OCRv6_small_det_onnx_infer.tar', 'PP-OCRv6_small_rec_onnx_infer.tar']) {
    if (!modelReqs.includes(f)) throw new Error('未从本地加载：' + f)
  }
  if (!t1.trim()) throw new Error('v5 手写未识别到文字')
  if (!/HELLO/.test(t2)) throw new Error('v6 印刷体识别异常：' + t2)
  const ex = errors.length ? '\nJS ERRORS: ' + errors.slice(0, 3).join('\n') : ''
  console.log('RESULT: PASS' + ex)
  ws.close()
}
main().catch(e => { console.error('RESULT: FAIL -', e.message); process.exitCode = 1 })
  .finally(async () => {
    await sleep(300)
    try { process.kill(chrome.pid) } catch {}
    try { spawn('taskkill', ['/F', '/T', '/PID', String(chrome.pid)], { stdio: 'ignore' }) } catch {}
  })
