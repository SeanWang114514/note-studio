// E2E：docx/epub 内容编辑 → 保存回文件（校验写回字节是有效 docx/epub 且含新文本）
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import mammoth from 'mammoth'
import JSZip from 'jszip'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9430
const profile = process.env.TEMP + '/chrome-editback-' + PORT
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
    if (msg.method === 'Runtime.consoleAPICalled' && ['error'].includes(msg.params.type)) errors.push('CONSOLE: ' + (msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300))
    if (msg.id && pending.has(msg.id)) { const q = pending.get(msg.id); pending.delete(msg.id); msg.error ? q.rej(new Error(msg.error.message)) : q.res(msg.result) }
  }
  await new Promise(r => (ws.onopen = r))
  await send('Page.enable'); await send('Runtime.enable')

  const baseMock = (name, capExpr) => `(async () => {
    window.__fileBytes = '';
    const r = await fetch('/${name}'); const b = await r.arrayBuffer();
    const f = new File([b], '${name}', {});
    window.showOpenFilePicker = async () => [{ name:'${name}', kind:'file', getFile: async()=>f, queryPermission: async()=> 'granted', requestPermission: async()=> 'granted', createWritable: async()=>({ write: async(data)=>{ ${capExpr} }, close: async()=>{} }) }];
    window.showSaveFilePicker = async () => ({ name:'a.json', kind:'file', getFile: async()=>new File(['{}'],'a.json'), queryPermission: async()=> 'granted', requestPermission: async()=> 'granted', createWritable: async()=>({ write: async()=>{}, close: async()=>{} }) });
    return 'ok'
  })()`

  // ── docx 内容编辑保存回 ──
  await send('Page.navigate', { url: 'http://127.0.0.1:5199/?t=docx' })
  await sleep(4000)
  await send('Runtime.evaluate', { expression: `(()=>{ const store={}; const mkReq=(result)=>{const req={result,onsuccess:null,onerror:null};setTimeout(()=>{req.onsuccess&&req.onsuccess({target:req})},0);return req}; const fs={get:(k)=>mkReq(store[k]),put:(v)=>{store[v.key]=v;return mkReq(v.key)}}; Object.defineProperty(window,'indexedDB',{value:{open:()=>{const req={onupgradeneeded:null,onsuccess:null,onerror:null,result:{objectStoreNames:{contains:()=>true},createObjectStore:()=>{},transaction:()=>({objectStore:()=>fs})}};setTimeout(()=>{req.onsuccess&&req.onsuccess({target:req})},0);return req}},configurable:true}); })()`, returnByValue: true })
  await send('Runtime.evaluate', { expression: baseMock('test-edit.docx', `window.__fileBytes = typeof data==='string' ? data : btoa(String.fromCharCode(...new Uint8Array(data)))`), awaitPromise: true, returnByValue: true })
  await send('Runtime.evaluate', { expression: `document.querySelector('.folder-btn')?.click()`, returnByValue: true })
  await sleep(6000)
  // 进入内容编辑模式 + 修改文本
  await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.tool-btn')].find(b=>b.textContent.includes('编辑内容'))?.click()`, returnByValue: true })
  await sleep(500)
  await send('Runtime.evaluate', { expression: `(()=>{ const body=document.querySelector('.docx-body'); const p=body.querySelector('p'); p.textContent = '已被修改的内容。'; body.querySelector('h1').textContent = '修改后标题'; return body.textContent })()`, returnByValue: true })
  await sleep(300)
  const editState = await send('Runtime.evaluate', { expression: `document.querySelector('.docx-body')?.contentEditable`, returnByValue: true })
  console.log('docx contentEditable:', editState.result?.value)
  await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.tool-btn')].find(b=>b.textContent.includes('保存内容到 .docx'))?.click()`, returnByValue: true })
  await sleep(3000)
  const docxBytesB64 = (await send('Runtime.evaluate', { expression: `window.__fileBytes`, returnByValue: true })).result?.value || ''
  let docxOk = false
  if (docxBytesB64) {
    const buf = Buffer.from(docxBytesB64, 'base64')
    writeFileSync('D:/VibeCoding/note apps/note-studio/out-edit.docx', buf)
    const isZip = buf.subarray(0, 2).toString() === 'PK'
    const mm = await mammoth.convertToHtml({ buffer: buf })
    docxOk = isZip && mm.value.includes('修改后标题') && mm.value.includes('已被修改的内容')
    console.log('docx saved:', buf.length, 'bytes, isZip:', isZip, 'contains edits:', mm.value.includes('修改后标题'))
  }
  console.log('[docx-edit]', docxOk ? 'PASS' : 'FAIL')

  // ── epub 内容编辑保存回 ──
  await send('Page.navigate', { url: 'http://127.0.0.1:5199/?t=epub' })
  await sleep(4000)
  await send('Runtime.evaluate', { expression: `(()=>{ const store={}; const mkReq=(result)=>{const req={result,onsuccess:null,onerror:null};setTimeout(()=>{req.onsuccess&&req.onsuccess({target:req})},0);return req}; const fs={get:(k)=>mkReq(store[k]),put:(v)=>{store[v.key]=v;return mkReq(v.key)}}; Object.defineProperty(window,'indexedDB',{value:{open:()=>{const req={onupgradeneeded:null,onsuccess:null,onerror:null,result:{objectStoreNames:{contains:()=>true},createObjectStore:()=>{},transaction:()=>({objectStore:()=>fs})}};setTimeout(()=>{req.onsuccess&&req.onsuccess({target:req})},0);return req}},configurable:true}); })()`, returnByValue: true })
  await send('Runtime.evaluate', { expression: baseMock('test-edit.epub', `window.__fileBytes = btoa(String.fromCharCode(...new Uint8Array(data)))`), awaitPromise: true, returnByValue: true })
  await send('Runtime.evaluate', { expression: `document.querySelector('.folder-btn')?.click()`, returnByValue: true })
  await sleep(6000)
  await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.tool-btn')].find(b=>b.textContent.includes('编辑内容'))?.click()`, returnByValue: true })
  await sleep(500)
  await send('Runtime.evaluate', { expression: `(()=>{ const body=document.querySelector('.epub-body'); const p=body.querySelector('p'); if (p) p.textContent = 'EPUB 修改后的内容。'; return body.textContent })()`, returnByValue: true })
  await sleep(300)
  await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.tool-btn')].find(b=>b.textContent.includes('保存到 EPUB'))?.click()`, returnByValue: true })
  await sleep(3000)
  const epubBytesB64 = (await send('Runtime.evaluate', { expression: `window.__fileBytes`, returnByValue: true })).result?.value || ''
  let epubOk = false
  if (epubBytesB64) {
    const buf = Buffer.from(epubBytesB64, 'base64')
    const zip = await JSZip.loadAsync(buf)
    const names = Object.keys(zip.files).filter(n => /\.(xhtml|html)$/i.test(n))
    const content = await zip.files[names[0]].async('string')
    epubOk = names.length > 0 && content.includes('EPUB 修改后的内容')
    console.log('epub saved:', buf.length, 'bytes, content contains edit:', content.includes('EPUB 修改后的内容'))
  }
  console.log('[epub-edit]', epubOk ? 'PASS' : 'FAIL')

  console.log('ERRORS:', errors.length ? errors.join('\n').slice(0, 500) : 'none')
  const ok = docxOk && epubOk
  console.log('RESULT: ' + (ok ? 'PASS' : 'FAIL'))
  ws.close(); chrome.kill(); process.exit(ok ? 0 : 1)
}
main().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1) })
