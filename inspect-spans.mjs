// 检查真实 PDF 文字层 span 的内联/计算样式，找出错位根因
import { spawn } from 'node:child_process'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9485
const profile = process.env.TEMP + '/chrome-span-inspect-' + PORT
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

  const dump = await send('Runtime.evaluate', { expression: `(() => {
    const tl = document.querySelector('.pdf-text-layer')
    const spans = [...tl.querySelectorAll('span[data-page]')]
    const out = spans.slice(0, 12).map(s => {
      const cs = getComputedStyle(s)
      const pr = s.closest('.pdf-page').getBoundingClientRect()
      const r = s.getBoundingClientRect()
      return {
        idx: s.dataset.idx,
        text: (s.textContent || '').slice(0, 20),
        inline: { left: s.style.left, top: s.style.top, fontSize: s.style.fontSize, transform: s.style.transform, width: s.style.width, height: s.style.height },
        computed: { left: cs.left, top: cs.top, fontSize: cs.fontSize, transform: cs.transform, position: cs.position, display: cs.display, height: cs.height },
        pos: { left: Math.round((r.left - pr.left) * 10) / 10, top: Math.round((r.top - pr.top) * 10) / 10, w: Math.round(r.width), h: Math.round(r.height) },
      }
    })
    // 画布上第一行文字的实际渲染位置（无法直接读，但可通过 canvas 像素找文字行）
    return JSON.stringify(out)
  })()`, returnByValue: true })
  console.log('SPANS:', dump.result?.value)
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
  ws.close(); chrome.kill(); process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
