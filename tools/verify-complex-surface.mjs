// verify-complex-surface.mjs — 复杂版式整页表面验证（作者/邮箱/边注/标题）
// 1. 打开 test-complex.pdf → 原文截图
// 2. 单击作者行 → 整页表面（多片段行按槽位还原）→ 编辑态截图
// 3. 逐行逐段像素对比（编辑 seg vs 原文 span：dx/dy/dw）
// 4. 真实拖拽跨段全选 → 加粗 → 提交 → 重开
// 用法: node tools/verify-complex-surface.mjs [chromePath]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5199/'
const PDF_NAME = 'test-complex.pdf'
const SHOT_DIR = path.join(ROOT, 'tmp', 'complex-surface')
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

  console.log('[1/5] 打开复杂版式 PDF…')
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'complexsurf-'))
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9231',
    '--user-data-dir=' + userData, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' })
  let targets = []
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9231/json/list')
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
  await shot(cdp, '01-before.png')

  console.log('[2/5] 单击作者行 → 整页表面（多片段槽位）…')
  const pt = await ev(cdp, `(() => {
    const t = [...document.querySelectorAll('.pdf-text-layer span[data-page]')].find(s => (s.textContent||'').includes('Lukasz Kaiser'));
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: r.left + r.width * 0.5, y: r.top + r.height / 2 };
  })()`)
  check('找到作者 span', !!pt)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(900)

  // 逐段像素对比：表面行内每个 .pdf-edit-seg vs 原文 span（按 x 最近匹配）
  const cmp = await ev(cdp, `(() => {
    const box = document.querySelector('.pdf-inline-editor');
    if (!box) return { editor: false };
    const out = { editor: true, rows: [], segs: [] };
    const spans = [...document.querySelectorAll('.pdf-text-layer span.editing')];
    out.nSpans = spans.length;
    const divs = [...box.querySelectorAll(':scope > [data-line]')];
    out.nDivs = divs.length;
    out.segRows = box.querySelectorAll('.pdf-edit-seg').length;
    // 每个 span 按文字内容配对 seg（同文字的 seg 取位置最近者），记录偏差
    for (const s of spans) {
      const sr = s.getBoundingClientRect();
      const st = (s.textContent || '').trim();
      let best = null, bestD = Infinity;
      for (const g of box.querySelectorAll('.pdf-edit-seg')) {
        const gt = (g.textContent || '').trim();
        if (gt !== st) continue;
        const gr = g.getBoundingClientRect();
        const dx = Math.abs(gr.left - sr.left), dy = Math.abs(gr.top - sr.top);
        const d = dx + dy;
        if (d < bestD) { bestD = d; best = { dx, dy, dw: Math.abs(gr.width - sr.width), segText: gt.slice(0,16) }; }
      }
      if (!best) {
        // 整行 div 与 span 同文字也认（非多片段行）
        for (const g of divs) {
          const gt = (g.textContent || '').trim();
          if (gt !== st) continue;
          const gr = g.getBoundingClientRect();
          const dx = Math.abs(gr.left - sr.left), dy = Math.abs(gr.top - sr.top);
          best = { dx, dy, dw: Math.abs(gr.width - sr.width), segText: gt.slice(0,16) };
          break;
        }
      }
      if (!best) {
        out.missList = (out.missList || []).concat([st.slice(0, 30)])
      }
      out.segs.push(best || { dx: 999, dy: 999, dw: 999, spanText: st.slice(0,16) });
    }
    return out;
  })()`)
  check('编辑表面出现', !!cmp?.editor, JSON.stringify(cmp).slice(0, 120))
  check('整页行装入（≥12 行）', (cmp?.nDivs || 0) >= 12, `divs=${cmp?.nDivs}`)
  check('多片段行拆槽（作者/邮箱行为多 seg）', (cmp?.segRows || 0) >= 2, `segs=${cmp?.segRows} divs=${cmp?.nDivs}`)
  let maxDx = 0, maxDy = 0, maxDw = 0, miss = 0
  for (const s of cmp?.segs || []) {
    if (!best1(s)) { miss++; continue }
    maxDx = Math.max(maxDx, s.dx || 0)
    maxDy = Math.max(maxDy, s.dy || 0)
    maxDw = Math.max(maxDw, s.dw || 0)
  }
  function best1(s) { return s && (s.dx !== undefined) && s.dx < 100 }
  const worst = (cmp?.segs || []).filter((s) => best1(s)).sort((a, b) => b.dy - a.dy).slice(0, 4)
  console.log('  ◷ 垂直偏差最大:', JSON.stringify(worst))
  console.log('  ◷ 未命中列表:', JSON.stringify(cmp?.missList || []))
  // 诊断 dy 最大的行：span vs seg 的 top 原始值
  const diag = await ev(cdp, `(() => {
    const box = document.querySelector('.pdf-inline-editor');
    const spans = [...document.querySelectorAll('.pdf-text-layer span.editing')];
    const target = spans.find(s => (s.textContent || '').trim() === 'has been');
    if (!target) return { found: false };
    const sr = target.getBoundingClientRect();
    let segRect = null, lineRect = null, lineStyle = null;
    for (const g of box.querySelectorAll('.pdf-edit-seg, [data-line]')) {
      if ((g.textContent || '').trim() === 'has been') {
        const gr = g.getBoundingClientRect();
        if (!segRect) segRect = { top: +gr.top.toFixed(2), left: +gr.left.toFixed(2), h: +gr.height.toFixed(2) };
        const line = g.closest('[data-line]');
        if (line) {
          const lr = line.getBoundingClientRect();
          lineRect = { top: +lr.top.toFixed(2), left: +lr.left.toFixed(2), h: +lr.height.toFixed(2) };
          lineStyle = { cssTop: line.style.top, cssLeft: line.style.left, cssH: line.style.height, cssLH: line.style.lineHeight };
        }
        break;
      }
    }
    const spanCs = getComputedStyle(target);
    return { found: true, span: { top: +sr.top.toFixed(2), h: +sr.height.toFixed(2), fs: spanCs.fontSize, lh: spanCs.lineHeight }, segRect, lineRect, lineStyle };
  })()`)
  console.log('  ◷ has-been 诊断:', JSON.stringify(diag))
  console.log(`  ◷ ${cmp?.nSpans} 个原文 span 匹配 seg：未命中=${miss} 最大偏差 dx=${maxDx.toFixed(1)} dy=${maxDy.toFixed(1)} dw=${maxDw.toFixed(1)} px`)
  check('全部 span 命中 seg', miss === 0, `miss=${miss}`)
  check('水平零偏差（dx≤2px）', maxDx <= 2, `dx=${maxDx.toFixed(1)}`)
  check('垂直零偏差（dy≤3px）', maxDy <= 3, `dy=${maxDy.toFixed(1)}`)
  check('宽度零偏差（dw≤4px）', maxDw <= 4, `dw=${maxDw.toFixed(1)}`)
  await shot(cdp, '02-editing.png')

  console.log('[3/5] 真实拖拽：作者行 → 正文末行（跨段全选）…')
  const pts = await ev(cdp, `(() => {
    const spans = [...document.querySelectorAll('.pdf-text-layer span[data-page]')].sort((a, b) => Number(a.dataset.idx) - Number(b.dataset.idx));
    const first = spans.find(s => (s.textContent||'').includes('Aidan'));
    const last = spans.filter(s => (s.textContent||'').includes('parallelizable')).pop();
    if (!first || !last) return null;
    const r0 = first.getBoundingClientRect();
    const r1 = last.getBoundingClientRect();
    return { x0: r0.left + 4, y0: r0.top + r0.height / 2, x1: r1.left + r1.width - 4, y1: r1.top + r1.height - 2 };
  })()`)
  check('拖拽端点有效', !!pts)
  if (pts) {
    await drag(cdp, pts.x0, pts.y0, pts.x1, pts.y1)
    await sleep(500)
    const selInfo = await ev(cdp, `(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString() : '';
      return { len: text.length, nLines: text ? text.split('\\n').length : 0, hasAuthor: text.includes('Aidan'), hasBody: text.includes('parallelizable') };
    })()`)
    console.log('  ◷ 拖拽选区:', JSON.stringify(selInfo))
    check('拖拽产生跨段选区', (selInfo?.len || 0) > 100 && !!selInfo?.hasAuthor && !!selInfo?.hasBody, JSON.stringify(selInfo))
  }
  await shot(cdp, '03-drag-selected.png')

  console.log('[4/5] Esc 取消 → 单击邮箱行编辑 → 提交…')
  await ev(cdp, `(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return 'esc';
  })()`)
  await sleep(500)
  const pt2 = await ev(cdp, `(() => {
    const t = [...document.querySelectorAll('.pdf-text-layer span[data-page]')].find(s => (s.textContent||'').includes('aidan@cs.toronto.edu'));
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: r.left + r.width * 0.5, y: r.top + r.height / 2 };
  })()`)
  check('找到邮箱 span', !!pt2)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt2.x, y: pt2.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt2.x, y: pt2.y, button: 'left', clickCount: 1 })
  await sleep(800)
  try {
    await cdp.send('Input.insertText', { text: 'EDITED_OK ' })
  } catch {
    await ev(cdp, `(() => { document.execCommand('insertText', false, 'EDITED_OK '); return 'fb'; })()`)
  }
  await sleep(300)
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
  check('提交后编辑框消失', !!committed?.gone)
  check('邮箱行 .edited 标记', (committed?.edited || 0) >= 1, `edited=${committed?.edited}`)
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
