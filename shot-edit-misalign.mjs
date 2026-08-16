// 复现：PDF 文字编辑错位 —— 打开 PDF → 切文字编辑工具 → 点击文字 → 截图
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9482
const profile = process.env.TEMP + '/chrome-edit-misalign-' + PORT
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
    const r = await fetch('/repro-test.pdf'); const b = await r.arrayBuffer();
    const f = new File([b], 'repro-test.pdf', { type: 'application/pdf' });
    window.__file = f;
    window.showOpenFilePicker = async () => [{ name:'repro-test.pdf', kind:'file', getFile: async()=>f, queryPermission: async()=> 'granted', requestPermission: async()=> 'granted', createWritable: async()=>({write:async()=>{},close:async()=>{}}) }];
    window.showSaveFilePicker = async () => { window.__pickerCalled = true; throw new Error('should not') };
    return 'ok'
  })()`, awaitPromise: true, returnByValue: true })
  await send('Runtime.evaluate', { expression: `document.querySelector('.folder-btn')?.click()`, returnByValue: true })
  await sleep(12000)

  // 检查文字层 span 与画布的对齐
  const align = await send('Runtime.evaluate', { expression: `(() => {
    const page = document.querySelector('.pdf-page')
    const canvas = page.querySelector('.pdf-canvas')
    const tl = page.querySelector('.pdf-text-layer')
    const spans = [...tl.querySelectorAll('span[data-page]')]
    const canvasRect = canvas.getBoundingClientRect()
    const tlRect = tl.getBoundingClientRect()
    const pr = page.getBoundingClientRect()
    const spanInfo = spans.slice(0, 6).map(s => {
      const r = s.getBoundingClientRect()
      return { idx: s.dataset.idx, text: s.textContent.slice(0, 20), left: Math.round((r.left - pr.left) * 100) / 100, top: Math.round((r.top - pr.top) * 100) / 100, w: Math.round(r.width), h: Math.round(r.height), fontSize: s.style.fontSize }
    })
    return JSON.stringify({
      pageRect: { w: Math.round(pr.width), h: Math.round(pr.height) },
      canvasRect: { x: Math.round(canvasRect.left - pr.left), y: Math.round(canvasRect.top - pr.top), w: Math.round(canvasRect.width), h: Math.round(canvasRect.height) },
      tlRect: { x: Math.round(tlRect.left - pr.left), y: Math.round(tlRect.top - pr.top), w: Math.round(tlRect.width), h: Math.round(tlRect.height) },
      scaleFactor: tl.style.getPropertyValue('--scale-factor'),
      totalScaleFactor: tl.style.getPropertyValue('--total-scale-factor'),
      spans: spanInfo
    })
  })()`, returnByValue: true })
  console.log('ALIGN:', align.result?.value)

  // 切到文字编辑工具
  await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.ribbon-btn, .tool-btn, .icon-btn')].find(b => (b.title || '').includes('文字编辑') || (b.textContent || '').includes('文字'))?.click()`, returnByValue: true })
  await sleep(500)
  // 尝试点击第一个 span（进入编辑态）
  const click = await send('Runtime.evaluate', { expression: `(() => {
    const span = document.querySelector('.pdf-text-layer span[data-page="1"][data-idx="1"]')
    if (!span) return 'NO SPAN'
    const r = span.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    return JSON.stringify({ x: Math.round(x), y: Math.round(y) })
  })()`, returnByValue: true })
  const cp = JSON.parse(click.result?.value || '{}')
  if (cp.x) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cp.x, y: cp.y, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cp.x, y: cp.y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(800)
  }
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const data = shot?.data || shot?.result?.data
  if (data) writeFileSync('D:/VibeCoding/note apps/pdf-shot-edit.png', Buffer.from(data, 'base64'))
  console.log('shot saved')
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
  ws.close(); chrome.kill(); process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
