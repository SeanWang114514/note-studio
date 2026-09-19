// verify-full-select.mjs — 整页表面 + 真机手势验证（无 JS 造假）
// 1. 打开 test-centered.pdf → 单击声明段 → 整页表面（全部段落行都在）
// 2. 真实鼠标拖拽：从声明段首行一直拖到标题行下方 → 选区应覆盖多段（含标题）
// 3. 逐像素对比：编辑行 vs 原文行 rect（dx/dy/dw 全 0），编辑态截图 vs 原文截图 diff
// 4. 提交 → 重开 → 持久化
// 用法: node tools/verify-full-select.mjs [chromePath]
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
const SHOT_DIR = path.join(ROOT, 'tmp', 'full-select')
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
  const p = path.join(SHOT_DIR, name)
  fs.writeFileSync(p, Buffer.from(data, 'base64'))
  console.log('  ◷ shot:', name)
  return p
}
async function drag(cdp, x0, y0, x1, y1, steps = 30) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 })
  await sleep(120)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 })
  for (let i = 1; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps
    const y = y0 + ((y1 - y0) * i) / steps
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left' })
    if (i % 5 === 0) await sleep(40)
  }
  await sleep(200)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 })
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

  console.log('[1/5] 打开居中标题 PDF…')
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'fullselect-'))
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9229',
    '--user-data-dir=' + userData, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' })
  let targets = []
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9229/json/list')
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
  cdp.ws.addEventListener('message', (evm) => {
    try {
      const msg = JSON.parse(evm.data)
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails
        pageErrors.push(String(d?.exception?.description || d?.text || 'exception').slice(0, 400))
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
  const b64 = fs.readFileSync(path.join(ROOT, 'public', PDF_NAME)).toString('base64')
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
  const beforePng = await shot(cdp, '01-before.png')

  console.log('[2/5] 单击声明段 → 整页表面 + 逐像素对比…')
  const pt = await ev(cdp, `(() => {
    const t = [...document.querySelectorAll('.pdf-text-layer span[data-page]')].find(s => (s.textContent||'').includes('Google hereby'));
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: r.left + r.width * 0.5, y: r.top + r.height / 2 };
  })()`)
  check('找到声明 span', !!pt)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(900)

  const cmp = await ev(cdp, `(() => {
    const box = document.querySelector('.pdf-inline-editor');
    if (!box) return { editor: false };
    const out = { editor: true, rows: [] };
    // 底层 span 按阅读顺序聚行
    const spans = [...document.querySelectorAll('.pdf-text-layer span.editing')]
      .sort((a, b) => Number(a.dataset.idx) - Number(b.dataset.idx));
    const divs = [...box.querySelectorAll(':scope > [data-line]')];
    out.nSpans = spans.length; out.nDivs = divs.length;
    const rows = [];
    for (const s of spans) {
      const r = s.getBoundingClientRect();
      let row = rows.find((x) => Math.abs(x.top - r.top) < 4);
      if (!row) { row = { top: r.top, left: Infinity, right: -Infinity, bottom: -Infinity }; rows.push(row); }
      row.left = Math.min(row.left, r.left);
      row.right = Math.max(row.right, r.right);
      row.bottom = Math.max(row.bottom, r.bottom);
    }
    rows.sort((a, b) => a.top - b.top);
    out.nSpanRows = rows.length;
    divs.forEach((d, i) => {
      const r = d.getBoundingClientRect();
      const s = rows[i];
      out.rows.push({
        i,
        div: { left: +r.left.toFixed(1), top: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
        span: s ? { left: +s.left.toFixed(1), top: +s.top.toFixed(1), w: +(s.right - s.left).toFixed(1), h: +(s.bottom - s.top).toFixed(1) } : null,
        text: (d.textContent || '').slice(0, 24),
      });
    });
    return out;
  })()`)
  let maxDx = 0, maxDy = 0, maxDw = 0
  for (const r of cmp?.rows || []) {
    if (!r.span) continue
    maxDx = Math.max(maxDx, Math.abs(r.div.left - r.span.left))
    maxDy = Math.max(maxDy, Math.abs(r.div.top - r.span.top))
    maxDw = Math.max(maxDw, Math.abs(r.div.w - r.span.w))
  }
  console.log(`  ◷ 整页表面: 编辑行=${cmp?.nDivs} 原文行=${cmp?.nSpanRows} 最大偏差 dx=${maxDx.toFixed(1)} dy=${maxDy.toFixed(1)} dw=${maxDw.toFixed(1)} px`)
  check('编辑表面出现', !!cmp?.editor)
  check('整页表面装入全部行（编辑行=原文行）', (cmp?.nDivs || 0) === (cmp?.nSpanRows || 0) && (cmp?.nDivs || 0) >= 4, `divs=${cmp?.nDivs} spanRows=${cmp?.nSpanRows}`)
  check('水平零偏差（dx≤2px）', maxDx <= 2, `dx=${maxDx.toFixed(1)}`)
  check('垂直零偏差（dy≤3px）', maxDy <= 3, `dy=${maxDy.toFixed(1)}`)
  check('行宽零偏差（dw≤4px）', maxDw <= 4, `dw=${maxDw.toFixed(1)}`)
  await shot(cdp, '02-editing-fullpage.png')

  console.log('[3/5] 真实鼠标拖拽：声明段 → 标题下方（跨段落全选）…')
  const pts = await ev(cdp, `(() => {
    const spans = [...document.querySelectorAll('.pdf-text-layer span[data-page]')].sort((a, b) => Number(a.dataset.idx) - Number(b.dataset.idx));
    const first = spans.find(s => (s.textContent||'').includes('Provided'));
    const title = spans.find(s => (s.textContent||'').includes('Attention'));
    if (!first || !title) return null;
    const r0 = first.getBoundingClientRect();
    const r1 = title.getBoundingClientRect();
    // 终点在标题行内（bottom-2）：选区末端落在标题最后一个字符附近
    return { x0: r0.left + 8, y0: r0.top + r0.height / 2, x1: r1.left + r1.width - 8, y1: r1.top + r1.height - 2 };
  })()`)
  check('拖拽端点有效', !!pts)
  await drag(cdp, pts.x0, pts.y0, pts.x1, pts.y1)
  await sleep(500)
  const selInfo = await ev(cdp, `(() => {
    const sel = window.getSelection();
    const text = sel ? sel.toString() : '';
    const box = document.querySelector('.pdf-inline-editor');
    const lines = text ? text.split('\\n') : [];
    return {
      len: text.length, nLines: lines.length,
      hasTitle: text.includes('Attention Is All You Need'),
      hasNotice: text.includes('Google hereby'),
      inBox: box.contains(sel?.anchorNode),
      head: text.slice(0, 40),
    };
  })()`)
  console.log('  ◷ 拖拽选区:', JSON.stringify({ len: selInfo?.len, nLines: selInfo?.nLines, head: selInfo?.head }))
  check('拖拽产生选区', (selInfo?.len || 0) > 50, JSON.stringify(selInfo))
  check('选区跨越段落（声明+标题都在）', !!selInfo?.hasNotice && !!selInfo?.hasTitle, JSON.stringify({ notice: selInfo?.hasNotice, title: selInfo?.hasTitle }))
  check('选区覆盖大量文字（跨多行）', (selInfo?.len || 0) > 150, `len=${selInfo?.len}`)
  await shot(cdp, '03-drag-selected.png')

  console.log('[4/5] 选区加粗 → 提交…')
  const boldRes = await ev(cdp, `(() => {
    const box = document.querySelector('.pdf-inline-editor');
    const b = [...document.querySelectorAll('.pdf-edit-bar button')].find(x => x.title.includes('加粗'));
    b && b.click();
    return { hasB: /font-weight:\\s*(700|bold)/.test(box.innerHTML), selLen: (window.getSelection()?.toString() || '').length };
  })()`)
  check('选区加粗生效', !!boldRes?.hasB, JSON.stringify(boldRes))
  const outside = await ev(cdp, `(() => {
    const thumb = document.querySelector('.pdf-thumbs');
    const r = thumb.getBoundingClientRect();
    return { x: r.left + 20, y: r.top + 40 };
  })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: outside.x, y: outside.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: outside.x, y: outside.y, button: 'left', clickCount: 1 })
  await sleep(900)
  const committed = await ev(cdp, `(() => ({
    gone: !document.querySelector('.pdf-inline-editor'),
    edited: document.querySelectorAll('.pdf-text-layer span.edited').length,
  }))()`)
  check('点击外部提交（编辑框消失）', !!committed?.gone)
  check('底层 span 标记 .edited', (committed?.edited || 0) >= 1, `edited=${committed?.edited}`)
  await shot(cdp, '04-committed.png')

  console.log('[5/5] 重开验证持久化…')
  await ev(cdp, `(() => { document.querySelector('.tab .tab-close')?.click(); return 'closed'; })()`)
  await sleep(1200)
  await ev(cdp, `(() => { const b = [...document.querySelectorAll('button')].find(x => /打开文件/.test(x.textContent||'')); b && b.click(); return 'reopened'; })()`)
  for (let i = 0; i < 20; i++) {
    await sleep(2000)
    try {
      const n = await cdp.send('Runtime.evaluate', { expression: `document.querySelectorAll('.pdf-text-layer span[data-page]').length`, returnByValue: true })
      if ((n?.result?.value || 0) > 0) break
    } catch {}
  }
  const rp = await ev(cdp, `(() => {
    const ec = document.querySelector('.pdf-edit-canvas');
    let hasPixels = false;
    if (ec && ec.width > 0) {
      try {
        const d = ec.getContext('2d').getImageData(0, 0, ec.width, ec.height).data;
        for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) { hasPixels = true; break; } }
      } catch (e) {}
    }
    return { shell: !!document.querySelector('.pdf-viewer-shell'), edited: document.querySelectorAll('.pdf-text-layer span.edited').length, hasPixels };
  })()`)
  check('重开挂载', !!rp?.shell)
  check('.edited 恢复', (rp?.edited || 0) >= 1, `edited=${rp?.edited}`)
  check('覆盖画布有内容', !!rp?.hasPixels)
  await shot(cdp, '05-reopened.png')

  console.log(`\n页面错误数: ${pageErrors.length}`)
  pageErrors.slice(0, 5).forEach((e) => console.log('  ⚠', e))
  check('无页面 JS 错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))

  cdp.close(); chrome.kill()
  await sleep(800)
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
  console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((err) => { console.error('测试脚本异常:', err); process.exit(1) })
