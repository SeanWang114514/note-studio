// verify-pixel-match.mjs — 编辑态 vs 原文逐像素一致验证
// 打开 test-centered.pdf，单击声明段，对比每行编辑 div 与底层 span 的
// left/top/width/height（≤2px 通过），截图编辑态与原文并排比对。
// 用法: node tools/verify-pixel-match.mjs [chromePath]
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
const SHOT_DIR = path.join(ROOT, 'tmp', 'pixel-match')
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

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelmatch-'))
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9228',
    '--user-data-dir=' + userData, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' })
  let targets = []
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9228/json/list')
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
        pageErrors.push(String(d?.exception?.description || d?.text || 'exception').slice(0, 300))
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

  // 原文截图（未编辑）
  const { data: before } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(SHOT_DIR, 'before.png'), Buffer.from(before, 'base64'))

  // 单击声明段
  const pt = await ev(cdp, `(() => {
    const t = [...document.querySelectorAll('.pdf-text-layer span[data-page]')].find(s => (s.textContent||'').includes('Google hereby'));
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: r.left + r.width * 0.5, y: r.top + r.height / 2 };
  })()`)
  check('找到声明 span', !!pt)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(800)

  // 逐行对比：编辑 div vs 底层 span（data-li 对应 stateLines 顺序 vs span 在段落内顺序）
  const cmp = await ev(cdp, `(() => {
    const out = { rows: [] };
    const box = document.querySelector('.pdf-inline-editor');
    if (!box) return { editor: false };
    out.editor = true;
    // 底层 span 按 data-idx 排序（段落内阅读顺序）
    const spans = [...document.querySelectorAll('.pdf-text-layer span.editing')]
      .sort((a, b) => Number(a.dataset.idx) - Number(b.dataset.idx));
    const divs = [...box.querySelectorAll(':scope > [data-line]')];
    out.nSpans = spans.length; out.nDivs = divs.length;
    // span 按行聚类（top 接近为同一行）
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
      });
    });
    return out;
  })()`)
  console.log(JSON.stringify(cmp, null, 1))
  let maxDx = 0, maxDy = 0, maxDw = 0
  for (const r of cmp?.rows || []) {
    if (!r.span) continue
    maxDx = Math.max(maxDx, Math.abs(r.div.left - r.span.left))
    maxDy = Math.max(maxDy, Math.abs(r.div.top - r.span.top))
    maxDw = Math.max(maxDw, Math.abs(r.div.w - r.span.w))
  }
  console.log(`  ◷ 最大偏差: dx=${maxDx.toFixed(1)} dy=${maxDy.toFixed(1)} dw=${maxDw.toFixed(1)} px`)
  check('编辑表面出现', !!cmp?.editor)
  check('行数一致（编辑行=原文行）', (cmp?.nDivs || 0) === (cmp?.nSpanRows || 0), `divs=${cmp?.nDivs} spanRows=${cmp?.nSpanRows}`)
  check('水平位置一致（dx≤2px）', maxDx <= 2, `dx=${maxDx.toFixed(1)}`)
  check('垂直位置一致（dy≤3px）', maxDy <= 3, `dy=${maxDy.toFixed(1)}`)
  check('行宽一致（dw≤4px）', maxDw <= 4, `dw=${maxDw.toFixed(1)}`)

  const { data: after } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(SHOT_DIR, 'editing.png'), Buffer.from(after, 'base64'))
  console.log('  ◷ shots: before.png / editing.png')

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
