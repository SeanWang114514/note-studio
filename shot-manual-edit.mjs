// 用用户实际 PDF 复现文字编辑错位：打开 → 文字编辑工具 → 点击正文 span → 截图 + 位置对比
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9484
const profile = process.env.TEMP + '/chrome-manual-edit-' + PORT
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
    window.__file = f;
    window.showOpenFilePicker = async () => [{ name:'manual.pdf', kind:'file', getFile: async()=>f, queryPermission: async()=> 'granted', requestPermission: async()=> 'granted', createWritable: async()=>({write:async()=>{},close:async()=>{}}) }];
    window.showSaveFilePicker = async () => { window.__pickerCalled = true; throw new Error('should not') };
    return 'ok'
  })()`, awaitPromise: true, returnByValue: true })
  await send('Runtime.evaluate', { expression: `document.querySelector('.folder-btn')?.click()`, returnByValue: true })
  await sleep(15000)

  // 找正文 span（非标题、非页码）
  const info = await send('Runtime.evaluate', { expression: `(() => {
    const spans = [...document.querySelectorAll('.pdf-text-layer span[data-page="1"]')]
    const target = spans.find(s => s.textContent.includes('所有同学')) || spans[2]
    if (!target) return 'NO'
    const r = target.getBoundingClientRect()
    return JSON.stringify({ idx: target.dataset.idx, text: target.textContent.slice(0, 30), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), left: r.left, top: r.top, w: r.width, h: r.height })
  })()`, returnByValue: true })
  const tp = JSON.parse(info.result?.value || 'null')
  console.log('TARGET:', info.result?.value)

  if (tp && tp.x) {
    // 切到文字编辑工具
    await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.ribbon-btn, .tool-btn')].find(b => (b.title || '').includes('编辑 PDF 文字'))?.click()`, returnByValue: true })
    await sleep(400)
    // 点击目标 span
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tp.x, y: tp.y, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tp.x, y: tp.y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(1000)
    const editState = await send('Runtime.evaluate', { expression: `(() => {
      const span = [...document.querySelectorAll('.pdf-text-layer span[data-page="1"]')].find(s => s.textContent.includes('所有同学'))
      if (!span) return 'NO SPAN'
      const r = span.getBoundingClientRect()
      const pr = span.closest('.pdf-page').getBoundingClientRect()
      const editing = span.classList.contains('editing')
      const contentEditable = span.contentEditable
      const bar = document.querySelector('.pdf-edit-bar')
      return JSON.stringify({ editing, contentEditable, hasBar: !!bar, barText: bar?.textContent?.slice(0, 40), spanLeft: Math.round(r.left - pr.left), spanTop: Math.round(r.top - pr.top), spanW: Math.round(r.width), spanH: Math.round(r.height) })
    })()`, returnByValue: true })
    console.log('EDIT STATE:', editState.result?.value)
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const data = shot?.data || shot?.result?.data
  if (data) writeFileSync('D:/VibeCoding/note apps/pdf-manual-edit.png', Buffer.from(data, 'base64'))
  console.log('shot saved')
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
  ws.close(); chrome.kill(); process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
