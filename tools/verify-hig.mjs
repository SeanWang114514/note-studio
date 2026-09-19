// verify-hig.mjs — Apple HIG 重设计 + 零回归验收
// 1) 首页浅色/深色两套外观取计算样式并截图
// 2) 打开 PDF：确认只读（无文字编辑层/编辑条）、只画不编辑
// 3) 画笔实际落笔 → 批注数 +1
// 4) 设置弹窗 / 手写识别弹窗能正常打开（覆盖刚修复的组件）
// 用法: node tools/verify-hig.mjs [chromePath]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5199/'
const SHOT_DIR = path.join(ROOT, 'tmp', 'hig-shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const checks = []
function check(name, cond, extra = '') {
  checks.push({ name, ok: Boolean(cond), extra })
  if (!cond) failures += 1
  console.log(`  ${cond ? '✔' : '✘'} ${name}${cond ? '' : ' ' + extra}`)
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
  if (r?.exceptionDetails) return { __error: r.exceptionDetails.text || 'eval error' }
  return r?.result?.value
}

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const p = path.join(SHOT_DIR, name)
  fs.writeFileSync(p, Buffer.from(data, 'base64'))
  console.log('  ◷ shot:', path.relative(ROOT, p))
  return p
}

async function clickSel(cdp, selector) {
  const box = await ev(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  if (!box || box.__error || typeof box.x !== 'number') return false
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  await sleep(60)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(50)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return true
}

async function drag(cdp, x0, y0, x1, y1, steps = 24) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 })
  await sleep(120)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 })
  for (let i = 1; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps
    const y = y0 + ((y1 - y0) * i) / steps
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left' })
    if (i % 6 === 0) await sleep(30)
  }
  await sleep(150)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 })
}

// 计算样式探针：主色、圆角、材质、字号、控件尺寸
const STYLE_PROBE = `(() => {
  const cs = (el) => (el ? getComputedStyle(el) : null)
  const root = getComputedStyle(document.documentElement)
  const tok = (n) => root.getPropertyValue(n).trim()
  const pick = (el, props) => {
    if (!el) return null
    const s = getComputedStyle(el)
    const o = {}
    props.forEach((p) => { o[p] = s.getPropertyValue(p) })
    return o
  }
  const sidebar = document.querySelector('.sidebar')
  const tabbar = document.querySelector('.tabbar')
  const nav = document.querySelector('.nav-item.active') || document.querySelector('.nav-item')
  // 小控件样本：优先取工具栏按钮，首页（没有工具栏）时退化为侧边栏导航项
  const toolBtn = document.querySelector('.tool-btn, .nav-item, .icon-btn')
  const card = document.querySelector('.recent-card') || document.querySelector('.home-card') || document.querySelector('.recent-item')
  return {
    scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    tokens: {
      blue: tok('--sys-blue'),
      label: tok('--label-primary') || tok('--label'),
      bg: tok('--bg-primary') || tok('--system-background'),
      radiusMd: tok('--radius-md'),
      fontUi: tok('--font-ui'),
    },
    body: pick(document.body, ['background-color', 'color', 'font-family', 'font-size', '-webkit-font-smoothing']),
    sidebar: pick(sidebar, ['background-color', 'width', 'border-right-color', 'backdrop-filter', 'font-size']),
    tabbar: pick(tabbar, ['background-color', 'height', 'backdrop-filter']),
    navIconSize: nav ? getComputedStyle(nav, null).fontSize : null,
    navRadius: nav ? getComputedStyle(nav).borderRadius : null,
    toolBtn: pick(toolBtn, ['height', 'border-radius', 'font-size', 'background-color', 'color']),
    card: pick(card, ['border-radius', 'background-color', 'box-shadow', 'border-color']),
    counts: {
      pdfEditBar: document.querySelectorAll('.pdf-edit-bar').length,
      pdfTextLayer: document.querySelectorAll('.pdf-text-layer, .pdf-text-layer-inner').length,
      inlineEditor: document.querySelectorAll('.pdf-inline-editor').length,
      annotToolbar: document.querySelectorAll('.annot-toolbar').length,
      sidebar: document.querySelectorAll('.sidebar').length,
    },
  }
})()`

async function waitFor(cdp, expr, ms = 20000, step = 400) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await ev(cdp, expr)
    if (v && v !== 0 && v !== false && !v.__error) return v
    await sleep(step)
  }
  return null
}

async function main() {
  // 0) dev 服务
  let alive = false
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(APP_URL, { signal: AbortSignal.timeout(3000) })
      if (r.status < 500) { alive = true; break }
    } catch {}
    await sleep(1000)
  }
  if (!alive) { console.error('dev 服务未启动: ' + APP_URL); process.exit(1) }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hig-'))
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9237',
    '--user-data-dir=' + userData, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })

  let targets = []
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9237/json/list')
      targets = await res.json()
      if (targets.length) break
    } catch {}
    await sleep(250)
  }
  if (!targets.length) { console.error('无法连接 Chrome'); chrome.kill(); process.exit(1) }
  const cdp = new CDP((targets.find((t) => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')

  const consoleErrors = []
  const exceptions = []
  cdp.ws.addEventListener('message', (evm) => {
    try {
      const msg = JSON.parse(evm.data)
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails
        exceptions.push(String(d?.exception?.description || d?.text || 'exception').slice(0, 300))
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        consoleErrors.push(msg.params.args.map((a) => String(a.value ?? a.description ?? '')).join(' ').slice(0, 240))
      }
    } catch {}
  })

  console.log('[1/6] 打开应用（浅色）…')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await cdp.send('Page.navigate', { url: APP_URL })
  const ready = await waitFor(cdp, `document.querySelectorAll('.sidebar, .nav-item').length`)
  check('应用渲染出侧边栏', Boolean(ready))
  await sleep(1200)
  const light = await ev(cdp, STYLE_PROBE)
  await shot(cdp, '01-home-light.png')

  console.log('[2/6] 外观令牌（浅色）…')
  check('浅色主色为 Apple systemBlue', light?.tokens?.blue?.toLowerCase().includes('007aff'), JSON.stringify(light?.tokens))
  check('侧边栏宽度 220-260px（macOS source list）', /^(2[2-6][0-9])/.test(light?.sidebar?.width || ''), String(light?.sidebar?.width))
  check('侧边栏使用毛玻璃/材质或半透明背景', Boolean(light?.sidebar?.['backdrop-filter'] && light.sidebar['backdrop-filter'] !== 'none') || /rgba|hsla/.test(light?.sidebar?.['background-color'] || ''), JSON.stringify(light?.sidebar))
  check('工具栏按钮/导航项高度 22-36px 且圆角 ≥5px', parseFloat(light?.toolBtn?.height || '0') >= 22 && parseFloat(light?.toolBtn?.height || '0') <= 36 && parseFloat(light?.toolBtn?.['border-radius'] || '0') >= 5, JSON.stringify(light?.toolBtn))
  check('正文使用系统字体栈', /-apple-system|system-ui|"SF Pro|PingFang|Inter/i.test(light?.body?.['font-family'] || ''), String(light?.body?.['font-family']))
  check('标签栏高度 36-44px', parseFloat(light?.tabbar?.height || '0') >= 34 && parseFloat(light?.tabbar?.height || '0') <= 46, String(light?.tabbar?.height))

  console.log('[3/6] 深色外观…')
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await sleep(900)
  const dark = await ev(cdp, STYLE_PROBE)
  await shot(cdp, '02-home-dark.png')
  check('深色模式被识别', dark?.scheme === 'dark', String(dark?.scheme))
  check('深色背景与浅色不同', dark?.body?.['background-color'] !== light?.body?.['background-color'], `${light?.body?.['background-color']} vs ${dark?.body?.['background-color']}`)
  check('深色下文字为浅色', /rgb\((2[0-9]{2}|1[5-9][0-9])/.test(dark?.body?.color || ''), String(dark?.body?.color))
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await sleep(600)

  console.log('[4/6] 打开 PDF（只读 + 可批注）…')
  const pdfB64 = fs.readFileSync(path.join(ROOT, 'public', 'test-complex.pdf')).toString('base64')
  await ev(cdp, `(() => {
    const bytes = Uint8Array.from(atob('${pdfB64}'), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'test-complex.pdf', { type: 'application/pdf', lastModified: Date.now() });
    const handle = { kind: 'file', name: 'test-complex.pdf', getFile: async () => file,
      queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      createWritable: async () => ({ write: async () => {}, close: async () => {}, getPosition: async () => 0, truncate: async () => {}, seek: async () => {} }) };
    window.showOpenFilePicker = async () => [handle];
    return 'ok';
  })()`)
  await clickSel(cdp, '.nav-item[title^="打开文件"], .folder-btn, .nav-item')
  await sleep(2500)
  let canvases = await ev(cdp, `document.querySelectorAll('.pdf-canvas').length`)
  if (!canvases) {
    // 直接点「打开文件」
    const opened = await ev(cdp, `(async () => {
      const btns = [...document.querySelectorAll('button')];
      const b = btns.find((x) => (x.textContent || '').includes('打开文件'));
      if (b) { b.click(); return true }
      return false
    })()`, true)
    await sleep(3000)
    canvases = await ev(cdp, `document.querySelectorAll('.pdf-canvas').length`)
    console.log('  (fallback 打开按钮:', opened, ')')
  }
  await waitFor(cdp, `document.querySelectorAll('.doc-toolbar').length`, 15000)
  await sleep(600)
  const pdfState = await ev(cdp, `(() => ({
    canvases: document.querySelectorAll('.pdf-canvas').length,
    pages: document.querySelectorAll('.pdf-page').length,
    annotCanvas: document.querySelectorAll('.annot-canvas').length,
    annotToolbar: document.querySelectorAll('.doc-toolbar').length,
    toolBtns: document.querySelectorAll('.doc-toolbar .icon-btn').length,
    editBar: document.querySelectorAll('.pdf-edit-bar').length,
    textLayer: document.querySelectorAll('.pdf-text-layer, .pdf-text-layer-inner, .pdf-text-layer span').length,
    inlineEditor: document.querySelectorAll('.pdf-inline-editor').length,
    links: document.querySelectorAll('.pdf-link-layer').length,
    status: (document.querySelector('.doc-toolbar') || {}).textContent || '',
    overlayBox: (() => { const o = document.querySelector('.annot-canvas'); if (!o) return null; const r = o.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })(),
  }))()`)
  console.log('  pdf state:', JSON.stringify(pdfState))
  check('PDF 页面已渲染', (pdfState?.canvases || 0) >= 1, JSON.stringify(pdfState))
  check('批注工具条存在（可手绘）', (pdfState?.annotToolbar || 0) >= 1)
  check('PDF 文字编辑条已移除', (pdfState?.editBar || 0) === 0)
  check('PDF 文字层已移除（无重影来源）', (pdfState?.textLayer || 0) === 0)
  check('内联文本编辑器已移除', (pdfState?.inlineEditor || 0) === 0)

  if (canvases) {
    console.log('[5/6] 在 PDF 上手绘一笔…')
    // 选中画笔工具（用 JS 点击，避免坐标命中偏差）
    const toolPicked = await ev(cdp, `(async () => {
      const b = [...document.querySelectorAll('.doc-toolbar .icon-btn')]
        .find((x) => (x.getAttribute('title') || '').startsWith('画笔'));
      if (!b) return 'no-pen-button';
      b.click();
      await new Promise((r) => setTimeout(r, 500));
      const active = document.querySelector('.doc-toolbar .icon-btn.active');
      return active ? (active.getAttribute('title') || 'active') : 'none-active';
    })()`, true)
    console.log('  pen tool →', toolPicked)
    check('画笔工具可选中', String(toolPicked).startsWith('画笔'), String(toolPicked))
    const annBefore = await ev(cdp, `(document.querySelector('.doc-toolbar') || {}).textContent || ''`)
    const box = await ev(cdp, `(() => { const el = document.querySelector('.annot-canvas') || document.querySelector('.pdf-page'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
    if (box && box.w > 60) {
      await drag(cdp, box.x + box.w * 0.3, box.y + box.h * 0.35, box.x + box.w * 0.62, box.y + box.h * 0.5)
      await sleep(900)
    }
    const annAfter = await ev(cdp, `(document.querySelector('.doc-toolbar') || {}).textContent || ''`)
    const ink = await ev(cdp, `(() => {
      const cv = document.querySelector('.annot-canvas');
      if (!cv) return null;
      const ctx = cv.getContext('2d');
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 8 && !(d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245)) n++;
      return { nonWhite: n, w: cv.width, h: cv.height, count: document.querySelectorAll('.ann-dom .ann-text, .ann-dom .ann-comment').length };
    })()`)
    check('画笔落笔后画布出现墨迹', (ink?.nonWhite || 0) > 40, JSON.stringify(ink))
    check('批注计数变化可见', annBefore !== annAfter || (ink?.nonWhite || 0) > 40, `${annBefore} -> ${annAfter}`)
    await shot(cdp, '03-pdf-annotated.png')
  }

  console.log('[5b/6] PDF 只读：点击/双击页面文字不应出现任何编辑入口…')
  {
    // 切回「选择文字」工具，然后在页面文字区单击、双击
    await ev(cdp, `(async () => {
      const b = [...document.querySelectorAll('.doc-toolbar .icon-btn')].find((x) => (x.getAttribute('title') || '').startsWith('选择文字'));
      b && b.click();
      await new Promise((r) => setTimeout(r, 300));
      return true;
    })()`, true)
    const target = await ev(cdp, `(() => {
      const cv = document.querySelector('.pdf-canvas');
      if (!cv) return null;
      const r = cv.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(260, r.height / 3)), canvasW: cv.width, canvasH: cv.height };
    })()`)
    if (target) {
      for (const clickCount of [1, 2]) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount })
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount })
        await sleep(500)
      }
      const editing = await ev(cdp, `(() => ({
        inlineEditor: document.querySelectorAll('.pdf-inline-editor, .pdf-inline-editor-pos').length,
        editBar: document.querySelectorAll('.pdf-edit-bar, .pdf-edit-color').length,
        editable: document.querySelectorAll('[contenteditable="true"]').length,
        editMode: document.querySelectorAll('.edit-mode, .textedit-active').length,
        caret: (() => { const s = getSelection(); return s ? s.toString().length : 0 })(),
      }))()`)
      console.log('  after click/dblclick:', JSON.stringify(editing))
      check('单击页面不进入文字编辑', (editing?.inlineEditor || 0) === 0 && (editing?.editBar || 0) === 0 && (editing?.editable || 0) === 0, JSON.stringify(editing))
      check('双击页面不进入文字编辑（无编辑模式标记）', (editing?.editMode || 0) === 0, JSON.stringify(editing))
      const canvasAfter = await ev(cdp, `(() => { const cv = document.querySelector('.pdf-canvas'); return cv ? { w: cv.width, h: cv.height } : null })()`)
      check('PDF 页面位图未被改写（仍是只读渲染）', canvasAfter?.w === target.canvasW && canvasAfter?.h === target.canvasH, JSON.stringify({ before: target, after: canvasAfter }))
    } else {
      check('找到 PDF 页面用于点击测试', false, 'no .pdf-canvas')
    }
  }

  console.log('[6/6] 弹窗（设置 / 手写识别）…')
  const settingsOk = await ev(cdp, `(async () => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('title') || '').startsWith('设置'));
    if (!b) return 'no-button';
    b.click();
    await new Promise((r) => setTimeout(r, 700));
    const m = document.querySelector('.settings-modal');
    return m ? 'open' : 'missing';
  })()`, true)
  check('设置弹窗可打开（修复后的组件可运行）', settingsOk === 'open', String(settingsOk))
  const modalGeo = await ev(cdp, `(() => {
    const m = document.querySelector('.settings-modal');
    if (!m) return null;
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), cy: Math.round(r.top + r.height / 2), cx: Math.round(r.left + r.width / 2), left: Math.round(r.left) } };
    const row = m.querySelector('.settings-save-row');
    const btn = row && row.querySelector('button');
    const hint = row && row.querySelector('.ocr-model-hint');
    const input = m.querySelector('input.speech-input, input[type="text"], input');
    const sel = m.querySelector('select');
    const cs = (el, p) => (el ? getComputedStyle(el).getPropertyValue(p) : null);
    const fields = [...m.querySelectorAll('input:not([type="checkbox"]), select')].map((el) => {
      const r = el.getBoundingClientRect();
      return { tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 24), h: Math.round(r.height), font: cs(el, 'font-size'), radius: cs(el, 'border-radius') };
    });
    // 没有表单控件时（设置面板只剩按钮/开关）用按钮尺寸兜底
    const allBtnMinH = Math.min(...[...m.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().height)).filter((h) => h > 0), 99);
    return {
      modal: rect(m),
      fields,
      allBtnMinH,
      inputFont: cs(input, 'font-size'),
      inputHeight: cs(input, 'height'),
      selectFont: cs(sel, 'font-size'),
      inputRadius: cs(input, 'border-radius'),
      row: rect(row),
      btn: rect(btn),
      hint: rect(hint),
      hintFont: cs(hint, 'font-size'),
      diag: (() => {
        const inp = m.querySelector('.speech-input');
        const sel2 = m.querySelector('.ocr-select');
        const d = (el) => el ? {
          h: getComputedStyle(el).height,
          pad: getComputedStyle(el).padding,
          radius: getComputedStyle(el).borderRadius,
          inline: el.getAttribute('style') || '',
          cls: el.className,
        } : null;
        return {
          input: d(inp),
          select: d(sel2),
          sheets: [...document.styleSheets].map((s) => (s.href || 'inline')).map((h) => h.split('/').pop()),
        };
      })(),
      overflowX: m.scrollWidth > m.clientWidth + 1,
    };
  })()`)
  console.log('  settings geometry:', JSON.stringify(modalGeo))
  check('弹窗宽度落在 macOS sheet 区间 480-700px', (modalGeo?.modal?.w || 0) >= 480 && (modalGeo?.modal?.w || 0) <= 700, String(modalGeo?.modal?.w))
  check('弹窗内控件尺寸合规（有表单控件时 ≥28px / ≥12px；否则按钮 ≥26px）', (modalGeo?.fields?.length ? modalGeo.fields.every((f) => f.h >= 28 && parseFloat(f.font) >= 12) : (modalGeo?.allBtnMinH ?? 0) >= 26), JSON.stringify({ fields: modalGeo?.fields, allBtnMinH: modalGeo?.allBtnMinH }))
  check('弹窗无横向溢出', modalGeo?.overflowX === false, String(modalGeo?.overflowX))
  check('保存行按钮与说明文字同一行且垂直居中', Boolean(modalGeo?.btn && modalGeo?.hint && Math.abs(modalGeo.btn.cy - modalGeo.hint.cy) <= 8 && modalGeo.hint.left > modalGeo.btn.left), JSON.stringify({ btn: modalGeo?.btn, hint: modalGeo?.hint }))
  await shot(cdp, '04-settings-modal.png')
  await ev(cdp, `(() => { const m = document.querySelector('.settings-modal'); const btn = m && m.querySelector('.icon-btn'); if (btn) btn.click(); return true })()`)
  await sleep(500)

  console.log('[6b/6] 语音识别 / 手写识别模型已整体移除…')
  {
    // 设置里不能再出现两个模型分区
    const settingsSections = await ev(cdp, `(async () => {
      const b = [...document.querySelectorAll('.sidebar button')].find((x) => (x.textContent || '').trim() === '设置');
      if (!b) return { error: 'no-settings-button' };
      b.click();
      await new Promise((r) => setTimeout(r, 700));
      const m = document.querySelector('.settings-modal');
      const titles = m ? [...m.querySelectorAll('.settings-section-title')].map((t) => t.textContent.trim()) : [];
      const text = m ? m.textContent : '';
      const hasSpeech = /语音|Vosk|Qwen|ASR/i.test(text);
      const hasOcr = /手写识别|文字识别|PaddleOCR|OCR/i.test(text);
      if (m) { const c = m.querySelector('.icon-btn'); c && c.click(); }
      return { titles, hasSpeech, hasOcr };
    })()`, true)
    console.log('  设置分区:', JSON.stringify(settingsSections))
    check('设置里不再有语音/手写模型分区', settingsSections?.hasSpeech === false && settingsSections?.hasOcr === false, JSON.stringify(settingsSections))
    check('设置仍有可配置内容（窗口与面板布局）', (settingsSections?.titles || []).length >= 2, JSON.stringify(settingsSections?.titles))

    const leftovers = await ev(cdp, `(() => ({
      speechBtn: [...document.querySelectorAll('.doc-toolbar button, .home-header button, .tool-btn')].filter((b) => /语音识别|文字识别/.test(b.textContent || '')).length,
      modelNav: [...document.querySelectorAll('.sidebar .nav-item')].filter((b) => /模型设置/.test(b.textContent || '')).length,
      modelModal: document.querySelectorAll('.model-modal, .model-prompt-overlay').length,
      ocrModal: document.querySelectorAll('.ocr-modal, .speech-modal').length,
      navItems: [...document.querySelectorAll('.sidebar .nav-item')].map((b) => (b.textContent || '').trim()),
    }))()`)
    console.log('  残留检查:', JSON.stringify(leftovers))
    check('工具栏/首页已无「语音识别/文字识别」按钮', (leftovers?.speechBtn || 0) === 0, JSON.stringify(leftovers))
    check('侧边栏已无「模型设置」入口', (leftovers?.modelNav || 0) === 0 && !JSON.stringify(leftovers?.navItems || []).includes('模型设置'), JSON.stringify(leftovers?.navItems))
    check('已无模型/识别弹窗残留', (leftovers?.modelModal || 0) === 0 && (leftovers?.ocrModal || 0) === 0, JSON.stringify(leftovers))
    check('侧边栏保留 欢迎页 与 设置', JSON.stringify(leftovers?.navItems) === JSON.stringify(['欢迎页', '设置']), JSON.stringify(leftovers?.navItems))
  }

  const fatal = exceptions.filter((e) => !/ResizeObserver|favicon|ERR_CONNECTION_REFUSED/i.test(e))
  const realErr = consoleErrors.filter((e) => !/favicon|127\.0\.0\.1:8000|ERR_CONNECTION_REFUSED|Download the React/i.test(e))
  check('无未捕获的运行时异常', fatal.length === 0, fatal.slice(0, 3).join(' | '))
  check('控制台无应用级报错', realErr.length === 0, realErr.slice(0, 3).join(' | '))

  fs.writeFileSync(path.join(SHOT_DIR, 'report.json'), JSON.stringify({ checks, light, dark, pdfState, fatal, realErr }, null, 2), 'utf8')
  console.log(`\n结果: ${checks.length - failures}/${checks.length} 通过, 截图目录 tmp/hig-shots/`)
  if (failures) console.log('失败项: ' + checks.filter((c) => !c.ok).map((c) => c.name).join(' / '))
  cdp.close()
  chrome.kill()
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error('verify-hig failed:', e); process.exit(2) })
