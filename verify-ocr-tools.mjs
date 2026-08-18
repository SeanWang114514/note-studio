// E2E: OCR 画板 撤销 / 像素橡皮 / 笔画橡皮
import { spawn } from 'node:child_process'
const BASE = process.env.OCR_URL || 'http://127.0.0.1:5173/'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9431
const TMP = 'C:/Users/Administrator/AppData/Local/Temp'
const profile = TMP + '/chrome-ocr-tools-' + PORT + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
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
    if (msg.method === 'Runtime.exceptionThrown') errors.push('EXC: ' + (msg.params.exceptionDetails?.exception?.description || '').slice(0, 300))
    if (msg.id && pending.has(msg.id)) { const q = pending.get(msg.id); pending.delete(msg.id); msg.error ? q.rej(new Error(msg.error.message)) : q.res(msg.result) }
  }
  await new Promise(r => (ws.onopen = r))
  await send('Page.enable'); await send('Runtime.enable')
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

  const inkPixels = async () => {
    const r = await send('Runtime.evaluate', { expression: `(() => {
      const c = document.querySelector('.ocr-canvas')
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      let px = 0
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 0 && d[i] < 210 && d[i + 1] < 210 && d[i + 2] < 210) px++
      }
      return px
    })()`, returnByValue: true })
    return r.result?.value || 0
  }
  const clickBtn = async (selectorText) => {
    await send('Runtime.evaluate', { expression: `(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('${selectorText}'))
      if (b) b.click()
      return !!b
    })()`, returnByValue: true })
    await sleep(250)
  }
  const mouse = async (type, x, y, btn = 'left') =>
    send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: btn, buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })

  const { left, top, w, h } = info
  const strokes = [
    [[0.16, 0.34], [0.30, 0.335], [0.45, 0.33], [0.60, 0.332], [0.75, 0.336], [0.86, 0.34]],
    [[0.16, 0.66], [0.30, 0.655], [0.45, 0.65], [0.60, 0.652], [0.75, 0.656], [0.86, 0.66]],
    [[0.70, 0.30], [0.74, 0.44]],
    [[0.72, 0.70], [0.76, 0.82]],
  ]
  async function draw(pts) {
    const sx = left + pts[0][0] * w, sy = top + pts[0][1] * h
    await mouse('mousePressed', sx, sy)
    for (const p of pts.slice(1)) { await mouse('mouseMoved', left + p[0] * w, top + p[1] * h); await sleep(20) }
    const lx = pts[pts.length - 1]
    await mouse('mouseReleased', left + lx[0] * w, top + lx[1] * h)
    await sleep(120)
  }
  const toolButtons = await send('Runtime.evaluate', { expression: `(() => {
    const names = [...document.querySelectorAll('.ocr-draw-tool')].map(b => b.textContent.trim())
    const undo = !!document.querySelector('.ocr-undo-btn')
    return JSON.stringify({ names, undo })
  })()`, returnByValue: true })
  console.log('toolbar:', toolButtons.result?.value)

  for (const s of strokes) await draw(s)
  const ink0 = await inkPixels()
  console.log('ink after 4 strokes:', ink0)
  if (ink0 < 800) throw new Error('drawing failed, ink=' + ink0)

  // 撤销：删掉最后一条笔画
  await clickBtn('撤销')
  const ink1 = await inkPixels()
  console.log('ink after undo:', ink1)
  if (!(ink1 < ink0)) throw new Error('undo did not remove pixels: ' + ink0 + ' -> ' + ink1)

  // 笔画橡皮：点击第一条横线中部，整条删除
  await clickBtn('笔画橡皮')
  await mouse('mousePressed', left + 0.5 * w, top + 0.335 * h)
  await mouse('mouseReleased', left + 0.5 * w, top + 0.335 * h)
  await sleep(200)
  const ink2 = await inkPixels()
  console.log('ink after stroke-eraser:', ink2)
  if (!(ink2 < ink1)) throw new Error('stroke eraser did not remove stroke: ' + ink1 + ' -> ' + ink2)

  // 像素橡皮：沿第二条横线拖动
  await clickBtn('像素橡皮')
  await mouse('mousePressed', left + 0.18 * w, top + 0.66 * h)
  for (let x = 0.22; x <= 0.82; x += 0.06) { await mouse('mouseMoved', left + x * w, top + 0.66 * h); await sleep(15) }
  await mouse('mouseReleased', left + 0.82 * w, top + 0.66 * h)
  await sleep(200)
  const ink3 = await inkPixels()
  console.log('ink after pixel-eraser:', ink3)
  if (!(ink3 < ink2)) throw new Error('pixel eraser did not erase: ' + ink2 + ' -> ' + ink3)

  // 撤销再试一次：像素擦除可被撤销
  await clickBtn('撤销')
  const ink4 = await inkPixels()
  console.log('ink after undo of pixel-erase:', ink4)
  if (!(ink4 > ink3)) throw new Error('undo of pixel erase failed: ' + ink3 + ' -> ' + ink4)

  // 重做：恢复刚才撤销的像素擦除
  await clickBtn('重做')
  const ink5 = await inkPixels()
  console.log('ink after redo:', ink5)
  if (ink5 !== ink3) throw new Error('redo did not restore erased pixels: ' + ink3 + ' -> ' + ink5)

  // 再撤销一次 → 重做可用（右箭头亮起）；随后画新笔画 → 重做栈被清空（重做按钮变灰）
  await clickBtn('撤销')
  const ink6 = await inkPixels()
  if (ink6 !== ink4) throw new Error('second undo failed: ' + ink4 + ' -> ' + ink6)
  const redoEnabled = await send('Runtime.evaluate', { expression: `(() => {
    const u = [...document.querySelectorAll('button')].find(b => b.textContent.includes('重做'))
    return u ? u.disabled : 'NO-BTN'
  })()`, returnByValue: true })
  console.log('redo enabled after second undo:', redoEnabled.result?.value)
  if (redoEnabled.result?.value !== false) throw new Error('redo should be enabled after undo')
  await clickBtn('画笔')
  await draw([[0.2, 0.5], [0.4, 0.52]])
  const redoDisabled = await send('Runtime.evaluate', { expression: `(() => {
    const u = [...document.querySelectorAll('button')].find(b => b.textContent.includes('重做'))
    return u ? u.disabled : 'NO-BTN'
  })()`, returnByValue: true })
  console.log('redo disabled after new stroke:', redoDisabled.result?.value)
  if (redoDisabled.result?.value !== true) throw new Error('new stroke should clear redo stack')

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
