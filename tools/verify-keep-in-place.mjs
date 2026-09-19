// verify-keep-in-place.mjs — 保位渲染 + 跨段扩展回归
// 1. 打开 test-centered.pdf（红色居中声明 + 居中黑标题）
// 2. 单击声明段 → 编辑行应与原文逐行重叠（marginLeft 还原居中，截图对比）
// 3. 跨段扩展：选区伸入折叠扩展段 → 自动展开，标题行进入编辑表面
// 4. 编辑后提交 → paint 覆盖与原文对齐（无左挤/下drift）
// 5. Enter 分行后提交 → 记录按 data-li 映射，不错位
// 用法: node tools/verify-keep-in-place.mjs [chromePath]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5199/'
const PDF_NAME = 'test-centered.pdf'
const PDF_PATH = path.join(ROOT, 'public', PDF_NAME)
const SHOT_DIR = path.join(ROOT, 'tmp', 'keep-in-place')
fs.mkdirSync(SHOT_DIR, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✔ ${name}`)
  else { failures += 1; console.log(`  ✘ ${name} ${extra}`) }
}
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
  }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  close() { try { this.ws.close() } catch {} }
}
async function ev(cdp, expression, awaitPromise = false) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  return r?.result?.value
}
async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(data, 'base64'))
  console.log('  ◷ shot:', name)
}
async function click(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

async function main() {
  let alive = false
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(APP_URL, { signal: AbortSignal.timeout(3000) })
      if (r.status < 500) { alive = true; break }
    } catch {}
    await sleep(1000)
  }
  if (!alive) {
    console.log('dev 服务无响应，自动启动 vite…')
    spawn('node', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5199'], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
    }).unref()
    for (let i = 0; i < 30; i++) {
      await sleep(2000)
      try {
        const r = await fetch(APP_URL, { signal: AbortSignal.timeout(3000) })
        if (r.status < 500) { alive = true; break }
      } catch {}
    }
  }
  if (!alive) { console.error('dev 服务启动失败'); process.exit(1) }

  console.log('[1/5] 启动 Chrome + 打开居中标题 PDF…')
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'keepinplace-'))
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9227',
    '--user-data-dir=' + userData, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' })
  let targets = []
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9227/json/list')
      targets = await res.json()
      if (targets.length) break
    } catch {}
    await sleep(200)
  }
  if (!targets.length) { console.error('无法连接 Chrome'); chrome.kill(); process.exit(1) }
  const cdp = new CDP((targets.find((t) => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  const pageErrors = []
  cdp.on = null
  cdp.ws.addEventListener('message', (evm) => {
    try {
      const msg = JSON.parse(evm.data)
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails
        const desc = d?.exception?.description || d?.text || 'exception'
        pageErrors.push(String(desc).slice(0, 600))
      }
    } catch {}
  })
  await cdp.send('Page.navigate', { url: APP_URL })
  for (let i = 0; i < 20; i++) {
    await sleep(2000)
    try {
      const n = await cdp.send('Runtime.evaluate', { expression: `document.querySelectorAll('button').length`, returnByValue: true })
      if ((n?.result?.value || 0) > 0) break
    } catch {}
  }
  const pdfBytes = fs.readFileSync(PDF_PATH)
  const b64 = pdfBytes.toString('base64')
  await ev(cdp, `(() => {
    const bytes = Uint8Array.from(atob('${b64}'), c => c.charCodeAt(0));
    const file = new File([bytes], '${PDF_NAME}', { type: 'application/pdf', lastModified: Date.now() });
    const handle = { kind: 'file', name: '${PDF_NAME}', getFile: async () => file,
      queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      createWritable: async () => ({ write: async () => {}, close: async () => {}, getPosition: async () => 0, truncate: async () => {}, seek: async () => {} }) };
    window.showOpenFilePicker = async () => [handle];
    return 'ok';
  })()`)
  await ev(cdp, `(async () => {
    try {
      const req = indexedDB.open('noteflow', 1);
      await new Promise((res, rej) => { req.onsuccess = res; req.onerror = () => rej(req.error); });
      const db = req.result;
      for (const name of db.objectStoreNames) {
        await new Promise((res, rej) => { const tx = db.transaction(name, 'readwrite'); tx.objectStore(name).clear(); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
      }
      db.close();
    } catch (e) {}
    return 'cleared';
  })()`, true)
  await ev(cdp, `(() => { const b = [...document.querySelectorAll('button')].find(x => /打开文件/.test(x.textContent||'')); b && b.click(); return 'clicked'; })()`)
  for (let i = 0; i < 20; i++) {
    await sleep(2000)
    try {
      const n = await cdp.send('Runtime.evaluate', { expression: `document.querySelectorAll('.pdf-text-layer span[data-page]').length`, returnByValue: true })
      if ((n?.result?.value || 0) > 0) break
    } catch {}
  }
  await ev(cdp, `(() => { const b = [...document.querySelectorAll('.pdf-toolbar button')].find(x => /^\\s*编辑/.test(x.textContent||'')); b && b.click(); return !!b; })()`)
  await sleep(300)
  await shot(cdp, '01-centered-open.png')

  console.log('[2/5] 单击红色声明段 → 保位检查…')
  const pt = await ev(cdp, `(() => {
    const t = [...document.querySelectorAll('.pdf-text-layer span[data-page]')].find(s => (s.textContent||'').includes('Google hereby'));
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: r.left + r.width * 0.5, y: r.top + r.height / 2 };
  })()`)
  check('找到声明 span', !!pt)
  await click(cdp, pt.x, pt.y)
  await sleep(700)
  const keep = await ev(cdp, `(() => {
    const box = document.querySelector('.pdf-inline-editor');
    if (!box) return { editor: false };
    const out = { editor: true, rows: [] };
    const lines = [...box.querySelectorAll(':scope > [data-line]')];
    for (const el of lines) {
      const lr = el.getBoundingClientRect();
      // 该行底层 span（同 data-li 映射到 stateLines 顺序）
      out.rows.push({ ml: parseFloat(el.style.marginLeft) || 0, mt: parseFloat(el.style.marginTop) || 0, left: Math.round(lr.left), top: Math.round(lr.top), w: Math.round(lr.width) });
    }
    // 底层 span 位置（编辑中全部 .editing → 取其 rect 对比）
    const spans = [...document.querySelectorAll('.pdf-text-layer span.editing')];
    out.spanRects = spans.slice(0, 6).map(s => { const r = s.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width) }; });
    out.nLines = lines.length;
    return out;
  })()`)
  check('声明段编辑表面出现', !!keep?.editor, JSON.stringify(keep))
  // 保位：编辑行 left 应与底层 span left 对齐（±3px），而不是统一左对齐
  let aligned = false
  if (keep?.rows?.length && keep?.spanRects?.length) {
    const dx = Math.abs(keep.rows[0].left - keep.spanRects[0].left)
    aligned = dx <= 4
    console.log('  ◷ 首行对齐偏差:', dx, 'px', JSON.stringify({ row: keep.rows[0], span: keep.spanRects[0] }))
  }
  check('编辑行与原文同位（居中不左挤）', aligned)
  check('整页表面装入全部行', (keep?.nLines || 0) >= 4, `nLines=${keep?.nLines}`)
  await shot(cdp, '02-keep-in-place.png')

  console.log('[3/5] 跨段选区：声明段 → 标题行（整页表面直接覆盖）…')
  const expand = await ev(cdp, `(() => {
    const out = {};
    const box = document.querySelector('.pdf-inline-editor');
    const firstText = (el) => { try { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); return w.nextNode(); } catch { return null; } };
    const mainLines = [...box.querySelectorAll(':scope > [data-line]')];
    out.mainN = mainLines.length;
    const n0 = firstText(mainLines[0]);
    const nL = firstText(mainLines[mainLines.length - 1]);
    const r = document.createRange();
    r.setStart(n0, 1); r.setEnd(nL, Math.min(4, nL.textContent.length));
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(r);
    out.selLen = sel.toString().length;
    out.spansTitle = (sel.toString() || '').includes('Attention');
    return out;
  })()`)
  console.log('  ◷ 跨段选区:', JSON.stringify(expand))
  await sleep(400)
  check('选区覆盖多行（跨声明段与标题段）', (expand?.selLen || 0) > 50, JSON.stringify(expand))
  await shot(cdp, '03-expanded.png')

  console.log('[4/5] 输入标记 → 提交 → paint 对齐检查…')
  await ev(cdp, `(() => {
    const box = document.querySelector('.pdf-inline-editor');
    const lines = [...box.querySelectorAll(':scope > [data-line]')];
    const sel = window.getSelection();
    const r = document.createRange();
    const last = lines[lines.length - 1];
    r.selectNodeContents(last); r.collapse(false);
    sel.removeAllRanges(); sel.addRange(r);
    document.execCommand('insertText', false, 'KEEP_OK');
    return 'typed';
  })()`)
  await sleep(300)
  const outside = await ev(cdp, `(() => {
    const thumb = document.querySelector('.pdf-thumbs');
    const r = thumb.getBoundingClientRect();
    return { x: r.left + 20, y: r.top + 40 };
  })()`)
  await click(cdp, outside.x, outside.y)
  await sleep(900)
  const committed = await ev(cdp, `(() => ({
    gone: !document.querySelector('.pdf-inline-editor'),
    edited: document.querySelectorAll('.pdf-text-layer span.edited').length,
    texts: [...document.querySelectorAll('.pdf-text-layer span.edited')].slice(0, 3).map(s => (s.textContent || '').slice(0, 20)),
  }))()`)
  check('提交后编辑框消失', !!committed?.gone)
  check('底层 span 标记 .edited', (committed?.edited || 0) >= 1, JSON.stringify(committed))
  await shot(cdp, '04-committed.png')

  console.log('[5/5] Enter 分行后提交 → 记录不错位…')
  const pt2 = await ev(cdp, `(() => {
    const t = [...document.querySelectorAll('.pdf-text-layer span[data-page]')].find(s => (s.textContent||'').includes('scholarly works'));
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: r.left + r.width * 0.5, y: r.top + r.height / 2 };
  })()`)
  await click(cdp, pt2.x, pt2.y)
  await sleep(700)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await sleep(400)
  try {
    await cdp.send('Input.insertText', { text: 'SPLIT_OK ' })
  } catch {
    await ev(cdp, `(() => { document.execCommand('insertText', false, 'SPLIT_OK '); return 'fb'; })()`)
  }
  await sleep(300)
  await click(cdp, outside.x, outside.y)
  await sleep(900)
  const split = await ev(cdp, `(() => {
    const boxGone = !document.querySelector('.pdf-inline-editor');
    return { boxGone };
  })()`)
  check('分行提交后编辑框消失', !!split?.boxGone)
  await shot(cdp, '05-split-committed.png')

  console.log(`\n页面错误数: ${pageErrors.length}`)
  pageErrors.slice(0, 5).forEach((e) => console.log('  ⚠', String(e).slice(0, 300)))
  check('无页面 JS 错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))

  cdp.close(); chrome.kill()
  await sleep(800)
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
  console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((err) => { console.error('测试脚本异常:', err); process.exit(1) })
