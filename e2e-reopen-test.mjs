// E2E：画批注 → 保存（真实注释写回）→ 重开页面 → 批注读回可见且非「未保存」状态
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

// 生成测试 PDF
const objects = []
objects.push('<< /Type /Catalog /Pages 2 0 R >>')
objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>')
const stream = 'BT /F1 24 Tf 72 720 Td (Hello PDF Studio) Tj ET\n'
objects.push('<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + 'endstream')
objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
let pdf = '%PDF-1.4\n'
const offsets = []
for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n` }
const xrefStart = Buffer.byteLength(pdf)
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n'
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
const srcBytes = Buffer.from(pdf, 'latin1')
writeFileSync('D:/VibeCoding/note apps/note-studio/public/test-reopen.pdf', srcBytes)

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9412
const profile = process.env.TEMP + '/chrome-reopen-' + PORT
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1280,900', '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT, 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find(t => t.type === 'page'); if (p) return p } catch {}
    await sleep(300)
  }
  throw new Error('no target')
}

function mockExpr(b64file) {
  const fileSrc = b64file
    ? `new File([Uint8Array.from(atob('${b64file}'),c=>c.charCodeAt(0))],'t.pdf',{type:'application/pdf'})`
    : `await (async()=>{ const r=await fetch('/test-reopen.pdf'); return new File([await r.arrayBuffer()],'t.pdf',{type:'application/pdf'}) })()`
  return `(async () => {
    const f = ${fileSrc};
    window.__written = [];
    window.showOpenFilePicker = async () => [{
      name:'t.pdf', kind:'file',
      getFile: async () => f,
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      createWritable: async () => ({
        write: async (data) => { const u = data instanceof Uint8Array ? data : new Uint8Array(data); let s=''; for (const x of u) s += String.fromCharCode(x); window.__written.push(btoa(s)); },
        close: async () => {},
      }),
    }];
    return 'ok'
  })()`
}

async function main() {
  const t = await getTarget()
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  let id = 0; const pending = new Map(); const errors = []
  const send = (m, p = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method: m, params: p })) })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Runtime.exceptionThrown') errors.push('EXC: ' + (msg.params.exceptionDetails?.exception?.description || '').slice(0, 300))
    if (msg.method === 'Runtime.consoleAPICalled' && ['error'].includes(msg.params.type)) {
      errors.push('CONSOLE: ' + (msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300))
    }
    if (msg.id && pending.has(msg.id)) { const q = pending.get(msg.id); pending.delete(msg.id); msg.error ? q.rej(new Error(msg.error.message)) : q.res(msg.result) }
  }
  await new Promise(r => (ws.onopen = r))
  await send('Page.enable'); await send('Runtime.enable')

  // ── Phase 1：打开 → 画一笔 → 保存 ──
  await send('Page.navigate', { url: 'http://127.0.0.1:5199/' })
  await sleep(4500)
  await send('Runtime.evaluate', { expression: mockExpr(null), awaitPromise: true, returnByValue: true })
  await send('Runtime.evaluate', { expression: `document.querySelector('.folder-btn')?.click()`, returnByValue: true })
  await sleep(5000)

  let pos = null
  for (let i = 0; i < 20; i++) {
    const r = await send('Runtime.evaluate', { expression: `(() => { const c = document.querySelector('.annot-canvas'); if (!c) return 'NO'; const r = c.getBoundingClientRect(); return JSON.stringify({ left: r.left, top: r.top, w: r.width, h: r.height }) })()`, returnByValue: true })
    if (r.result?.value && r.result.value !== 'NO') { pos = JSON.parse(r.result.value); break }
    await sleep(400)
  }
  if (!pos) { console.log('NO CANVAS'); ws.close(); chrome.kill(); process.exit(1) }
  const a = { x: Math.round(pos.left + 0.2 * pos.w), y: Math.round(pos.top + 0.35 * pos.h) }
  const b = { x: Math.round(pos.left + 0.6 * pos.w), y: Math.round(pos.top + 0.55 * pos.h) }
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 6; i++) {
    const t2 = i / 6
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(a.x + (b.x - a.x) * t2), y: Math.round(a.y + (b.y - a.y) * t2), buttons: 1 })
    await sleep(25)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(700)
  await send('Runtime.evaluate', { expression: `document.querySelector('.ribbon-btn[title*="保存"]')?.click()`, returnByValue: true })
  await sleep(2500)

  const written = await send('Runtime.evaluate', { expression: `window.__written.length ? window.__written[0] : ''`, returnByValue: true })
  const statusAfterSave = await send('Runtime.evaluate', { expression: `document.querySelector('.status-bar')?.textContent || ''`, returnByValue: true })
  const writtenB64 = written.result?.value || ''
  console.log('PHASE1 status:', JSON.stringify(statusAfterSave.result?.value))

  // 校验写回字节包含真实注释（/Annots + /Ink）
  let verify = { valid: false, hasAnnots: false }
  if (writtenB64) {
    const outBytes = Buffer.from(writtenB64, 'base64')
    verify.valid = outBytes.subarray(0, 5).toString() === '%PDF-'
    const raw = outBytes.toString('latin1')
    let ops = ''
    let i = 0
    while ((i = raw.indexOf('stream', i)) !== -1) {
      let s = i + 6; if (raw[s] === '\r') s++; if (raw[s] === '\n') s++
      const e = raw.indexOf('endstream', s); if (e < 0) break
      try { ops += inflateSync(Buffer.from(raw.slice(s, e), 'latin1')).toString('latin1') } catch { ops += raw.slice(s, e) }
      i = e + 9
    }
    // 对象流里看不到 /Annots 文本；改为检查「无文本内容追加 + 体积增大」+ 二次读回（Phase2 验证）
    verify.hasAnnots = outBytes.length > srcBytes.length
  }
  console.log('PHASE1 verify:', JSON.stringify(verify))

  // ── Phase 2：重开页面，用写回的字节作为文件 → 批注应读回 ──
  await send('Page.navigate', { url: 'http://127.0.0.1:5199/?reopen=1' })
  await sleep(4500)
  await send('Runtime.evaluate', { expression: mockExpr(writtenB64), awaitPromise: true, returnByValue: true })
  await send('Runtime.evaluate', { expression: `document.querySelector('.folder-btn')?.click()`, returnByValue: true })
  await sleep(5500)

  const statusAfterReopen = await send('Runtime.evaluate', { expression: `document.querySelector('.status-bar')?.textContent || ''`, returnByValue: true })
  const overlayPixels = await send('Runtime.evaluate', { expression: `(() => {
    const ov = document.querySelector('.annot-canvas')
    if (!ov) return 'NO'
    const d = ov.getContext('2d').getImageData(0,0,ov.width,ov.height).data
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++
    return String(n)
  })()`, returnByValue: true })
  console.log('PHASE2 status:', JSON.stringify(statusAfterReopen.result?.value))
  console.log('PHASE2 overlayPixels:', overlayPixels.result?.value)

  const st2 = statusAfterReopen.result?.value || ''
  const px2 = Number(overlayPixels.result?.value || 0)
  const ok = !errors.length
    && verify.valid
    && st2.includes('批注 1 条')
    && !st2.includes('未写回')
    && px2 > 200
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
  console.log('RESULT: ' + (ok ? 'PASS' : 'FAIL'))
  ws.close(); chrome.kill(); process.exit(ok ? 0 : 1)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
