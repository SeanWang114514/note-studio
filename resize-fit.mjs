// 测试：打开 PDF 后容器宽度变化（如侧栏/批注栏展开），fit-width 是否重算、页面是否被截断
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9503
const profile = process.env.TEMP + '/chrome-resize-fit-' + PORT
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

  const snap = () => send('Runtime.evaluate', { expression: `(() => {
    const page = document.querySelector('.pdf-page')
    const scroll = document.querySelector('.pdf-scroll')
    const pr = page?.getBoundingClientRect()
    const sr = scroll?.getBoundingClientRect()
    const sidebar = document.querySelector('.sidebar')
    const thumbs = document.querySelector('.pdf-thumbs')
    return JSON.stringify({
      status: [...document.querySelectorAll('.status-bar span')].map(e => e.textContent).join('|'),
      scrollClientW: scroll?.clientWidth,
      scrollLeft: sr ? Math.round(sr.left) : null, scrollRight: sr ? Math.round(sr.right) : null,
      pageW: pr ? Math.round(pr.width) : null,
      pageLeft: pr ? Math.round(pr.left) : null, pageRight: pr ? Math.round(pr.right) : null,
      pageInside: pr && sr ? pr.right <= sr.right + 1 : null,
      sidebarW: sidebar?.getBoundingClientRect().width,
      thumbsW: thumbs?.getBoundingClientRect().width,
      panelW: document.querySelector('.comment-panel, .side-panel')?.getBoundingClientRect().width || null,
    })
  })()`, returnByValue: true })

  console.log('S1:', (await snap()).result?.value)
  // 模拟容器变窄：给 pdf-scroll 加宽度限制（模拟侧栏展开）
  await send('Runtime.evaluate', { expression: `document.querySelector('.pdf-scroll').style.maxWidth = '400px'`, returnByValue: true })
  await sleep(2000)
  console.log('S2(after narrow):', (await snap()).result?.value)
  await send('Runtime.evaluate', { expression: `document.querySelector('.pdf-scroll').style.maxWidth = ''`, returnByValue: true })
  await sleep(2000)
  console.log('S3(restored):', (await snap()).result?.value)
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
  ws.close(); chrome.kill(); process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
