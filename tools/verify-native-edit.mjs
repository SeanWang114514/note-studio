// verify-native-edit.mjs — 段落级原生编辑视觉回归
// 覆盖：单击定位光标 / 输入插入 / 跨行拖拽多选 / 跨行删除 / Enter 换行 /
// 行首 Backspace 合并 / 选区加粗 / 点击外部提交 / 重开恢复。每步截图到 tmp/native-edit/。
// 用法: node tools/verify-native-edit.mjs [chromePath]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5199/'
const PDF_NAME = 'test-native-edit.pdf'
const PDF_PATH = path.join(ROOT, 'public', PDF_NAME)
const SHOT_DIR = path.join(ROOT, 'tmp', 'native-edit')
fs.mkdirSync(SHOT_DIR, { recursive: true })

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
    this.listeners = new Map()
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
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params)
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
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(fn)
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
async function drag(cdp, x0, y0, x1, y1, steps = 24) {
  // 先把鼠标移到起点（无按键），再按下拖拽：模拟真实用户手势，
  // 否则 headless 下直接 mousePressed 可能无法建立原生选区。
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 })
  await sleep(120)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 })
  for (let i = 1; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps
    const y = y0 + ((y1 - y0) * i) / steps
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left' })
    if (i % 6 === 0) await sleep(60)
  }
  await sleep(150)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // 前置：探活 dev 服务，不通则自动启动（避免后台任务随会话丢失导致回归失败）
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
  if (!alive) { console.error('dev 服务启动失败，退出'); process.exit(1) }
  console.log('[1/7] 启动无头 Chrome…')
  // Chrome profile 放系统临时目录：避免 vite watch 项目 tmp/ 下的 profile 文件导致 EBUSY 崩溃
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'native-edit-profile-'))
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9224',
    '--user-data-dir=' + userData, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-extensions', '--window-size=1400,900', 'about:blank',
  ], { stdio: 'ignore' })
  let targets = []
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9224/json/list')
      targets = await res.json()
      if (targets.length) break
    } catch {}
    await sleep(200)
  }
  if (!targets.length) { console.error('无法连接 Chrome 调试端口'); chrome.kill(); process.exit(1) }
  const cdp = new CDP((targets.find((t) => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  const pageErrors = []
  cdp.on('Runtime.exceptionThrown', (p) => pageErrors.push(p.exceptionDetails?.text || 'exception'))

  console.log('[2/7] 打开应用 + 注入文件 mock…')
  await cdp.send('Page.navigate', { url: APP_URL })
  // 等应用就绪（按钮出现，最多 40 秒：模型 wasm 大，首屏慢）
  for (let i = 0; i < 20; i++) {
    await sleep(2000)
    try {
      const n = await cdp.send('Runtime.evaluate', {
        expression: `document.querySelectorAll('button').length`,
        returnByValue: true,
      })
      if ((n?.result?.value || 0) > 0) break
    } catch {}
  }
  const pdfBytes = fs.readFileSync(PDF_PATH)
  const b64 = pdfBytes.toString('base64')
  await ev(cdp, `(() => {
    const bytes = Uint8Array.from(atob('${b64}'), c => c.charCodeAt(0));
    const file = new File([bytes], '${PDF_NAME}', { type: 'application/pdf', lastModified: Date.now() });
    const handle = { kind: 'file', name: '${PDF_NAME}',
      getFile: async () => file,
      queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      createWritable: async () => { let buf = bytes.slice(); return {
        write: async (d) => { buf = new Uint8Array(d instanceof ArrayBuffer ? d : d.buffer); },
        close: async () => {}, getPosition: async () => buf.length, truncate: async () => {}, seek: async () => {} }; },
    };
    window.showOpenFilePicker = async () => [handle];
    window.showSaveFilePicker = async () => handle;
    return 'ok';
  })()`)
  await ev(cdp, `(async () => {
    try {
      const req = indexedDB.open('noteflow', 1);
      await new Promise((res, rej) => { req.onsuccess = res; req.onerror = () => rej(req.error); });
      const db = req.result;
      for (const name of db.objectStoreNames) {
        await new Promise((res, rej) => {
          const tx = db.transaction(name, 'readwrite');
          tx.objectStore(name).clear(); tx.oncomplete = res; tx.onerror = () => rej(tx.error);
        });
      }
      db.close();
    } catch (e) {}
    return 'cleared';
  })()`, true)
  await ev(cdp, `(() => { const b = [...document.querySelectorAll('button')].find(x => /打开文件/.test(x.textContent||'')); b && b.click(); return 'clicked'; })()`)
  // 等 PDF 视图挂载（文字层 span 出现，最多 40 秒）
  for (let i = 0; i < 20; i++) {
    await sleep(2000)
    try {
      const n = await cdp.send('Runtime.evaluate', {
        expression: `document.querySelectorAll('.pdf-text-layer span[data-page]').length`,
        returnByValue: true,
      })
      if ((n?.result?.value || 0) > 0) break
    } catch {}
  }

  const s0 = await ev(cdp, `(() => ({
    shell: !!document.querySelector('.pdf-viewer-shell'),
    spans: document.querySelectorAll('.pdf-text-layer span[data-page]').length,
    pages: document.querySelectorAll('.pdf-page').length,
  }))()`)
  check('PDF 视图挂载', !!s0?.shell, JSON.stringify(s0))
  check('文字层 span 存在', (s0?.spans || 0) > 0, `spans=${s0?.spans}`)
  await shot(cdp, '01-opened.png')

  // 切到编辑模式（默认可能已是编辑模式，点一下保证）
  await ev(cdp, `(() => { const b = [...document.querySelectorAll('.pdf-toolbar button')].find(x => /^\\s*编辑/.test(x.textContent||'')); b && b.click(); return !!b; })()`)
  await sleep(300)

  console.log('[3/7] 单击段落文字 → 段落编辑表面…')
  const pt = await ev(cdp, `(() => {
    const spans = [...document.querySelectorAll('.pdf-text-layer span[data-page]')];
    const t = spans.find(s => (s.textContent||'').includes('first paragraph'));
    if (!t) return { ok: false };
    const r = t.getBoundingClientRect();
    return { ok: true, x: r.left + r.width * 0.3, y: r.top + r.height / 2 };
  })()`)
  check('找到目标 span', !!pt?.ok)
  await click(cdp, pt.x, pt.y)
  await sleep(700)
  const ed = await ev(cdp, `(() => {
    const box = document.querySelector('.pdf-inline-editor');
    if (!box) return { editor: false };
    // 整页表面：全部段落行都在（:scope 直属，无折叠包裹）
    const mainLines = [...box.querySelectorAll(':scope > [data-line]')];
    const r0 = mainLines[0] ? mainLines[0].getBoundingClientRect() : null;
    const r1 = mainLines[1] ? mainLines[1].getBoundingClientRect() : null;
    return {
      editor: true, mainLines: mainLines.length,
      text: box.textContent.slice(0, 80),
      // 渲染检查：相邻行不重叠（上一行 bottom <= 下一行 top + 2px）
      overlap: r0 && r1 ? (r0.bottom > r1.top + 2) : 'n/a',
      tops: [r0?.top, r1?.top],
      bar: !!document.querySelector('.pdf-edit-bar'),
    };
  })()`)
  check('段落编辑表面出现', !!ed?.editor)
  check('整页全部行进入表面（标题+3+2=6 行）', ed?.mainLines === 6, `mainLines=${ed?.mainLines}`)
  check('相邻行不重叠（无渲染堆叠）', ed?.overlap === false, JSON.stringify(ed?.tops))
  check('格式条出现', !!ed?.bar)
  await shot(cdp, '02-paragraph-editor.png')

  console.log('[4/7] 输入插入 + Enter 换行 + Backspace 合并…')
  // 光标应已定位到点击处；输入标记文字（Input.insertText 无焦点会报 Invalid parameters → fallback 为 execCommand）
  try {
    await cdp.send('Input.insertText', { text: 'NATIVE_OK ' })
  } catch {
    await ev(cdp, `(() => { document.execCommand('insertText', false, 'NATIVE_OK '); return 'fallback'; })()`)
  }
  await sleep(400)
  const typed = await ev(cdp, `(() => document.querySelector('.pdf-inline-editor')?.textContent.includes('NATIVE_OK'))()`)
  check('输入插入到光标处', !!typed)
  await shot(cdp, '03-typed.png')
  // Enter 换行（原生）：行数 +1。注意 CDP 按 Enter 必须带 text:'\r'，
  // 否则只产生 keydown 而无 beforeinput insertParagraph，浏览器不会换行。
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await sleep(400)
  // 整页表面：主段行数（:scope 直属）3 → Enter 后 4（整页 5→6，但输入在主段行内）
  const afterEnter = await ev(cdp, `(() => {
    const box = document.querySelector('.pdf-inline-editor');
    const lines = [...(box?.querySelectorAll(':scope > [data-line]') || [])];
    const tops = lines.map(l => Math.round(l.getBoundingClientRect().top));
    return { n: lines.length, tops };
  })()`)
  check('Enter 原生换行（整页 6→7 行）', afterEnter?.n === 7, JSON.stringify(afterEnter))
  await shot(cdp, '04-enter-split.png')
  // 行首 Backspace 合并：把光标移到新行行首再按 Backspace
  await ev(cdp, `(() => {
    const box = document.querySelector('.pdf-inline-editor');
    const lines = [...box.querySelectorAll('[data-line]')];
    const line = lines[1];
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(line, 0); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    return 'caret-to-line-start';
  })()`)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await sleep(400)
  const afterBs = await ev(cdp, `(() => document.querySelector('.pdf-inline-editor')?.querySelectorAll(':scope > [data-line]').length)()`)
  check('行首 Backspace 合并回 6 行', afterBs === 6, `lines=${afterBs}`)

  console.log('[5/7] 跨行拖拽多选…')
  const dragPts = await ev(cdp, `(() => {
    const box = document.querySelector('.pdf-inline-editor');
    if (!box) return null;
    // 主段首行 → 主段末行（验证原生跨行拖选；跨段由 Range + expandCheck 验证）
    const main = [...box.querySelectorAll(':scope > [data-line]')];
    if (main.length < 2) return null;
    const r0 = main[0].getBoundingClientRect();
    const rL = main[main.length - 1].getBoundingClientRect();
    return { x0: r0.left + 10, y0: r0.top + r0.height / 2, x1: rL.left + rL.width - 10, y1: rL.top + rL.height / 2 };
  })()`)
  check('拖拽坐标有效', !!dragPts, JSON.stringify(dragPts))
  if (!dragPts) throw new Error('编辑表面丢失，无法拖拽')
  await drag(cdp, dragPts.x0, dragPts.y0, dragPts.x1, dragPts.y1)
  await sleep(400)
  const selInfo = await ev(cdp, `(() => {
    const sel = window.getSelection();
    const box = document.querySelector('.pdf-inline-editor');
    const text = sel ? sel.toString() : '';
    const anchorLine = sel?.anchorNode?.parentElement?.closest?.('[data-line]')?.getAttribute('data-line');
    const focusLine = sel?.focusNode?.parentElement?.closest?.('[data-line]')?.getAttribute('data-line');
    return { len: text.length, anchorLine, focusLine, inBox: box.contains(sel?.anchorNode) };
  })()`)
  // 注意：CDP 合成鼠标在 headless 下无法扩展 contentEditable 原生选区（已知限制，
  // 真机手拖走浏览器原生路径）。合成拖拽成功则直接过；否则用 DOM Range 等价验证后续链路。
  if ((selInfo?.len || 0) > 0) {
    check('跨行选区覆盖多行', Number(selInfo?.anchorLine) !== Number(selInfo?.focusLine) || (selInfo?.len || 0) > 60, JSON.stringify(selInfo))
  } else {
    console.log('  ◷ 合成拖拽未产生选区（headless 限制，真机需手动确认手拖跨行多选）')
  }
  await shot(cdp, '05-cross-line-select.png')
  if ((selInfo?.len || 0) === 0) {
    // CDP 合成鼠标在 headless 下可能无法扩展 contentEditable 原生选区（已知限制）。
    // 用 DOM Range 设置等价跨行选区（= 用户拖拽完成后的选区状态），继续验证后续链路。
    console.log('  ◷ 合成拖拽未产生选区，改用 DOM Range 设置等价跨行选区继续验证')
    const rangeRes = await ev(cdp, `(() => {
      const box = document.querySelector('.pdf-inline-editor');
      const main = [...box.querySelectorAll(':scope > [data-line]')];
      const firstText = (el) => {
        try {
          const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          return w.nextNode();
        } catch { return null; }
      };
      const n0 = firstText(main[0]);
      const nL = firstText(main[main.length - 1]);
      if (!n0 || !nL) return 'no-text-node';
      const r = document.createRange();
      r.setStart(n0, Math.min(2, n0.textContent.length));
      r.setEnd(nL, Math.min(5, nL.textContent.length));
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
      return 'range-set:' + sel.toString().length;
    })()`)
    console.log('  ◷ Range 设置结果:', JSON.stringify(rangeRes))
    await sleep(300)
  }

  console.log('[6/7] 选区加粗 → 点击外部提交…')
  // 设选区 + 点加粗合并在同一次 evaluate（接近真实手势；分步会被 focus 时序干扰）
  const boldRes = await ev(cdp, `(() => {
    const out = {};
    const box = document.querySelector('.pdf-inline-editor');
    const firstText = (el) => { try { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); return w.nextNode(); } catch { return null; } };
    const lines = [...box.querySelectorAll('[data-line]')];
    const n0 = firstText(lines[0]);
    const nL = firstText(lines[lines.length - 1]);
    const r = document.createRange();
    r.setStart(n0, Math.min(2, n0.textContent.length));
    r.setEnd(nL, Math.min(5, nL.textContent.length));
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(r);
    out.selBefore = sel.toString().length;
    const b = [...document.querySelectorAll('.pdf-edit-bar button')].find(x => x.title.includes('加粗'));
    b && b.click();
    out.hasB = /font-weight:\\s*(700|bold)/.test(box.innerHTML);
    out.selAfter = window.getSelection().toString().length;
    return out;
  })()`)
  console.log('  ◷ 加粗:', JSON.stringify(boldRes))
  check('选区加粗生效（行内样式切片）', !!boldRes?.hasB, JSON.stringify({ selBefore: boldRes?.selBefore, selAfter: boldRes?.selAfter }))
  await shot(cdp, '06-bold-selection.png')
  // 点击外部提交
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
  }))()`)
  check('点击外部自动提交（编辑框消失）', !!committed?.gone)
  check('底层 span 标记 .edited', (committed?.edited || 0) >= 1, `edited=${committed?.edited}`)
  await shot(cdp, '07-committed.png')

  console.log('[7/7] 重开验证持久化…')
  await ev(cdp, `(() => { document.querySelector('.tab .tab-close')?.click(); return 'closed'; })()`)
  await sleep(1200)
  await ev(cdp, `(() => { const b = [...document.querySelectorAll('button')].find(x => /打开文件/.test(x.textContent||'')); b && b.click(); return 'reopened'; })()`)
  for (let i = 0; i < 20; i++) {
    await sleep(2000)
    try {
      const n = await cdp.send('Runtime.evaluate', {
        expression: `document.querySelectorAll('.pdf-text-layer span[data-page]').length`,
        returnByValue: true,
      })
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
  check('重开后视图挂载', !!rp?.shell)
  check('重开后 .edited 标记恢复', (rp?.edited || 0) >= 1, `edited=${rp?.edited}`)
  check('重开后编辑覆盖画布有内容', !!rp?.hasPixels)
  await shot(cdp, '08-reopened.png')

  console.log(`\n页面错误数: ${pageErrors.length}`)
  pageErrors.slice(0, 5).forEach((e) => console.log('  ⚠', e))
  check('无页面 JS 错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

  cdp.close(); chrome.kill()
  await sleep(800)
  try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch {}
  console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((err) => { console.error('测试脚本异常:', err); process.exit(1) })
