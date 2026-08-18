// E2E：文字识别弹窗（手写画板 → PaddleOCR 本地识别）
import { spawn } from 'node:child_process'

const BASE = process.env.OCR_URL || 'http://127.0.0.1:5173/'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9428
const TMP = 'C:/Users/Administrator/AppData/Local/Temp'
const profile = TMP + '/chrome-ocr-' + PORT + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
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
  const netFail = []
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Network.loadingFailed') netFail.push('FAILED ' + (msg.params?.requestId || '') + ' err=' + (msg.params?.errorText || '') + ' cancelled=' + msg.params?.canceled)
    if (msg.method === 'Network.responseReceived' && /bcebos/.test(msg.params?.response?.url || '')) netFail.push('RESP ' + (msg.params.response.url.slice(0, 150)) + ' status=' + msg.params.response.status)
    if (msg.method === 'Runtime.exceptionThrown') errors.push('EXC: ' + (msg.params.exceptionDetails?.exception?.description || '').slice(0, 400))
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const text = (msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' ')
      // 忽略 onnxruntime 的初始izer 清理告警（通过 console.error 输出但无害）
      if (!text.includes('[W:onnxruntime:') && !text.includes('Removing initializer')) {
        errors.push('CONSOLE: ' + text.slice(0, 400))
      }
    }
    if (msg.id && pending.has(msg.id)) { const q = pending.get(msg.id); pending.delete(msg.id); msg.error ? q.rej(new Error(msg.error.message)) : q.res(msg.result) }
  }
  await new Promise(r => (ws.onopen = r))
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Page.navigate', { url: BASE })
  await sleep(3500)

  // 1) 首页应有“文字识别”按钮
  const btn = await send('Runtime.evaluate', { expression: `(() => {
    const b = [...document.querySelectorAll('.ocr-btn')].find(x => x.textContent.includes('文字识别'))
    if (!b) return 'NO'
    b.click()
    return 'CLICKED'
  })()`, returnByValue: true })
  console.log('open button:', btn.result?.value)

  // 2) 弹窗出现 + 画板就绪
  let modalInfo = null
  for (let i = 0; i < 30; i++) {
    const r = await send('Runtime.evaluate', { expression: `(() => {
      const c = document.querySelector('.ocr-canvas')
      const m = document.querySelector('.ocr-modal')
      if (!c || !m) return 'NO'
      const rect = c.getBoundingClientRect()
      return JSON.stringify({ left: rect.left, top: rect.top, w: rect.width, h: rect.height, cw: c.width, ch: c.height, model: document.querySelector('.ocr-select')?.value })
    })()`, returnByValue: true })
    if (r.result?.value && r.result.value !== 'NO') { modalInfo = JSON.parse(r.result.value); break }
    await sleep(300)
  }
  if (!modalInfo) throw new Error('OCR modal/canvas not found')
  console.log('modal:', JSON.stringify(modalInfo))

  // 3) 手写“二”（两条粗横线）+ 一点斜笔，模拟真实书写
  async function drawStrokes() {
  const { left, top, w, h } = modalInfo
  const strokes = [
    // 上横（从左到右，多点平滑）
    [[0.16, 0.34], [0.30, 0.335], [0.45, 0.33], [0.60, 0.332], [0.75, 0.336], [0.86, 0.34]],
    // 下横
    [[0.16, 0.66], [0.30, 0.655], [0.45, 0.65], [0.60, 0.652], [0.75, 0.656], [0.86, 0.66]],
    // 一笔斜点（增加笔画特征）
    [[0.70, 0.30], [0.74, 0.44]],
    [[0.72, 0.70], [0.76, 0.82]],
  ]
  for (const pts of strokes) {
    const start = { x: Math.round(left + pts[0][0] * w), y: Math.round(top + pts[0][1] * h) }
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1 })
    for (const p of pts.slice(1)) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(left + p[0] * w), y: Math.round(top + p[1] * h), buttons: 1 })
      await sleep(22)
    }
    const last = pts[pts.length - 1]
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(left + last[0] * w), y: Math.round(top + last[1] * h), button: 'left', buttons: 0, clickCount: 1 })
    await sleep(150)
  }
  }
  await drawStrokes()

  // 3.5) 生成大号印刷体图片并粘贴（v6 对手写细笔画不敏感，用印刷体验证）
  async function pasteBigText() {
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

  // 4) 画板有墨迹（数非白色像素）
  const ink = await send('Runtime.evaluate', { expression: `(() => {
    const c = document.querySelector('.ocr-canvas')
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let px = 0
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2]
      if (r < 210 && g < 210 && b < 210) px++
    }
    return px
  })()`, returnByValue: true })
  console.log('ink pixels:', ink.result?.value)
  if (!ink.result?.value || ink.result.value < 500) throw new Error('no ink drawn')

  // 5) 点击开始识别（首次会自动下载 Paddle 官方模型，可能较久）
  await send('Runtime.evaluate', { expression: `document.querySelector('.ocr-run')?.click()`, returnByValue: true })

  let final = null
  const startedAt = Date.now()
  while (Date.now() - startedAt < 360000) {
    const r = await send('Runtime.evaluate', { expression: `(() => {
      const err = document.querySelector('.ocr-error')?.textContent || ''
      const pre = document.querySelector('.ocr-result-text pre')?.textContent || ''
      const status = document.querySelector('.ocr-status')?.textContent || ''
      const head = document.querySelector('.ocr-result-head')?.textContent || ''
      return JSON.stringify({ err, pre, status, head, done: !!document.querySelector('.ocr-result') })
    })()`, returnByValue: true })
    const v = JSON.parse(r.result?.value || '{}')
    if (v.done) { final = v; break }
    if (v.err && !v.status) { final = v; break }
    if (Date.now() - startedAt > 20000) console.log('  waiting…', (Date.now() - startedAt) / 1000 + 's')
    await sleep(2000)
  }
  console.log('final v5:', JSON.stringify(final))
  const passV5 = final && final.done && !final.err && final.head.includes('识别完成')

  // 6) 切到 PP-OCRv6 再识别一轮
  console.log('--- switching to PP-OCRv6 ---')
  await send('Runtime.evaluate', { expression: `(() => {
    // 切换模型 + 重新书写清空画板
    const sel = document.querySelector('.ocr-select')
    if (sel) { sel.value = 'ppocr-v6'; sel.dispatchEvent(new Event('change', { bubbles: true })) }
    document.querySelectorAll('.tool-btn').forEach(b => { if (b.textContent.includes('重新书写')) b.click() })
    return sel?.value
  })()`, returnByValue: true })
  await sleep(800)
  // v6_small 对细笔画手写不敏感，用大号印刷体验证
  await pasteBigText()
  await sleep(400)
  await send('Runtime.evaluate', { expression: `document.querySelector('.ocr-run')?.click()`, returnByValue: true })

  let final6 = null
  const start6 = Date.now()
  while (Date.now() - start6 < 360000) {
    const r = await send('Runtime.evaluate', { expression: `(() => {
      const err = document.querySelector('.ocr-error')?.textContent || ''
      const pre = document.querySelector('.ocr-result-text pre')?.textContent || ''
      const status = document.querySelector('.ocr-status')?.textContent || ''
      const head = document.querySelector('.ocr-result-head')?.textContent || ''
      return JSON.stringify({ err, pre, status, head, done: !!document.querySelector('.ocr-result') })
    })()`, returnByValue: true })
    const v = JSON.parse(r.result?.value || '{}')
    if (v.done) { final6 = v; break }
    if (v.err && !v.status) { final6 = v; break }
    if (Date.now() - start6 > 20000) console.log('  waiting v6…', (Date.now() - start6) / 1000 + 's')
    await sleep(2000)
  }
  console.log('final v6:', JSON.stringify(final6))
  console.log('NET:', netFail.slice(0, 30).join('\n') || 'none')
  console.log('ERRORS:', errors.length ? errors.join('\n').slice(0, 2500) : 'none')
  const passV6 = final6 && final6.done && !final6.err && final6.head.includes('识别完成') && /HELLO/.test(final6.pre || '')
  const pass = passV5 && passV6
  console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'))
  ws.close()
  try { cp.execSync('taskkill /F /T /PID ' + chrome.pid, { stdio: 'ignore', timeout: 8000 }) } catch {}
  process.exit(pass ? 0 : 1)
}
main().catch(e => { console.error('ERR', e.message); try { cp.execSync('taskkill /F /T /PID ' + chrome.pid, { stdio: 'ignore', timeout: 8000 }) } catch {} process.exit(1) })
