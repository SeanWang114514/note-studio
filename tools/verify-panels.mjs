// verify-panels.mjs — 验收「侧栏类栏目自由缩放 + 折叠收起」
// 覆盖：左侧边栏 / PDF 缩略图栏 / 右侧批注栏（PDF+md+docx+epub+xlsx）
// 断言：拖拽改宽、键盘微调、折叠/恢复、刷新后记忆、无未捕获异常。
// 用法: node tools/verify-panels.mjs [chromePath]
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
function check(name, cond, extra = '') {
  if (!cond) failures += 1
  console.log(`  ${cond ? '✔' : '✘'} ${name}${cond ? '' : '  ' + extra}`)
}

class CDP {
  constructor(ws) { this.ws = new WebSocket(ws); this.id = 0; this.pending = new Map() }
  async open() { await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej }); this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) } } }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  close() { try { this.ws.close() } catch {} }
}

async function ev(cdp, expression, awaitPromise = false) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (r?.exceptionDetails) return { __error: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 200) }
  return r?.result?.value
}

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(data, 'base64'))
  console.log('  ◷ shot:', name)
}

async function waitFor(cdp, expr, ms = 20000, step = 300) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await ev(cdp, expr)
    if (v && !v.__error) return v
    await sleep(step)
  }
  return null
}

// 拖拽分隔条：delta 为正 = 向右拖
async function dragSplitter(cdp, panel, delta, steps = 14) {
  const info = await ev(cdp, `(() => {
    const sp = document.querySelectorAll('.panel-splitter');
    const list = [...sp].map((el) => {
      const r = el.getBoundingClientRect();
      const prev = el.previousElementSibling, next = el.nextElementSibling;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width),
        prevCls: prev ? String(prev.className).slice(0, 40) : '', nextCls: next ? String(next.className).slice(0, 40) : '' };
    });
    return list;
  })()`)
  const target = chooseSplitter(info, panel)
  if (!target) return { error: 'splitter not found', info }
  const x0 = target.x
  const y0 = target.y
  // 诊断：确认该点上真正接收指针的是分隔条本身（被别的元素盖住会导致拖动无声失效）
  const hit = await ev(cdp, `(() => {
    const el = document.elementFromPoint(${x0}, ${y0});
    const stack = document.elementsFromPoint(${x0}, ${y0}).slice(0, 5).map((n) => String(n.className || n.tagName).slice(0, 34));
    const sp = document.elementFromPoint(${x0}, ${y0});
    const splitters = [...document.querySelectorAll('.panel-splitter')].map((s) => { const r = s.getBoundingClientRect(); return { cls: String(s.nextElementSibling?.className || s.previousElementSibling?.className || '').slice(0, 20), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } });
    const cv = document.querySelector('.annot-canvas');
    const chain = [];
    let n = cv;
    while (n && chain.length < 8) { const cs = getComputedStyle(n); const r = n.getBoundingClientRect(); chain.push({ cls: String(n.className || n.tagName).slice(0, 26), ox: cs.overflowX, oy: cs.overflowY, pos: cs.position, x: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }); n = n.parentElement }
    return { tag: el ? el.tagName : null, cls: el ? String(el.className).slice(0, 40) : null, stack, splitters, chain };
  })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 })
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (delta * i) / steps, y: y0, button: 'left' })
    await sleep(16)
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 + delta, y: y0, button: 'left', clickCount: 1 })
  await sleep(200)
  return { ok: true, hit, start: { x: x0, y: y0 }, delta }
}

function chooseSplitter(list, panel) {
  if (!list) return null
  if (panel === 'sidebar') return list.find((s) => s.prevCls.startsWith('sidebar')) || list[0]
  if (panel === 'pdfThumbs') return list.find((s) => s.prevCls.startsWith('pdf-thumbs'))
  if (panel === 'annPanel') return list.find((s) => s.nextCls.startsWith('ann-panel'))
  return null
}

const widthOf = (cdp, sel) => ev(cdp, `(() => { const el = document.querySelector('${sel}'); return el ? Math.round(el.getBoundingClientRect().width) : null })()`)

async function openFixture(cdp, file) {
  const b64 = fs.readFileSync(path.join(ROOT, 'public', file)).toString('base64')
  await ev(cdp, `(() => {
    const bytes = Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0));
    const f = new File([bytes], '${file}', { lastModified: 1700000000000 });
    const handle = { kind: 'file', name: '${file}', getFile: async () => f,
      queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      createWritable: async () => ({ write: async () => {}, close: async () => {}, seek: async () => {}, truncate: async () => {}, getPosition: async () => 0 }) };
    window.showOpenFilePicker = async () => [handle];
    return 'ok';
  })()`)
  await ev(cdp, `(async () => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '打开文件'); b && b.click(); return true })()`, true)
  await sleep(400)
}

async function main() {
  let alive = false
  for (let i = 0; i < 8; i++) {
    try { const r = await fetch(APP_URL, { signal: AbortSignal.timeout(2500) }); if (r.status < 500) { alive = true; break } } catch {}
    await sleep(800)
  }
  if (!alive) { console.error('dev 服务未启动: ' + APP_URL); process.exit(1) }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'panels-'))
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9243', '--user-data-dir=' + userData,
    '--no-first-run', '--no-default-browser-check', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' })
  let targets = []
  for (let i = 0; i < 60; i++) { try { targets = await (await fetch('http://127.0.0.1:9243/json/list')).json(); if (targets.length) break } catch {} await sleep(250) }
  const cdp = new CDP((targets.find((t) => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  const errors = []
  cdp.ws.addEventListener('message', (e) => {
    try {
      const m = JSON.parse(e.data)
      if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || '').slice(0, 160))
    } catch {}
  })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.navigate', { url: APP_URL })
  await waitFor(cdp, `document.querySelectorAll('.nav-item').length`)
  await sleep(1200)

  console.log('\n[1] 左侧边栏：拖拽缩放 + 折叠 + 记忆')
  const w0 = await widthOf(cdp, '.sidebar')
  check('侧边栏有默认宽度', w0 >= 180 && w0 <= 460, String(w0))
  const d1 = await dragSplitter(cdp, 'sidebar', 120)
  const w1 = await widthOf(cdp, '.sidebar')
  check('拖动分隔条后侧边栏变宽', d1.ok && w1 > w0 + 60, JSON.stringify({ d1, w0, w1 }))
  const d2 = await dragSplitter(cdp, 'sidebar', -400)
  const w2 = await widthOf(cdp, '.sidebar')
  check('向左拖过头时被最小宽度夹住', w2 >= 180 && w2 <= 260, String(w2))
  await dragSplitter(cdp, 'sidebar', 220)
  const w3 = await widthOf(cdp, '.sidebar')
  // 键盘：聚焦分隔条后方向键微调
  await ev(cdp, `(() => { const s = [...document.querySelectorAll('.panel-splitter')].find((el) => String(el.previousElementSibling?.className || '').startsWith('sidebar')); s && s.focus(); return true })()`)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  await sleep(200)
  const w4 = await widthOf(cdp, '.sidebar')
  check('方向键可微调宽度', w4 > w3, JSON.stringify({ w3, w4 }))
  await shot(cdp, '20-panel-sidebar-resized.png')

  // ⌘B 折叠
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b', code: 'KeyB', modifiers: 2, windowsVirtualKeyCode: 66 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'b', code: 'KeyB', modifiers: 2, windowsVirtualKeyCode: 66 })
  await sleep(400)
  const collapsed = await ev(cdp, `(() => { const el = document.querySelector('.sidebar'); if (!el) return 'missing'; const r = el.getBoundingClientRect(); return r.width < 2 ? 'collapsed' : 'visible:' + Math.round(r.width) })()`)
  check('⌘B 可折叠侧边栏', collapsed === 'collapsed', String(collapsed))
  // 折叠后细栏：展开按钮在右上角，尺寸与栏头图标协调
  const rail = await ev(cdp, `(() => {
    const r = document.querySelector('.sidebar-rail');
    if (!r) return null;
    const b = r.querySelector('.panel-rail-btn');
    const rb = r.getBoundingClientRect();
    const bb = b ? b.getBoundingClientRect() : null;
    const icon = b ? b.querySelector('svg') : null;
    return {
      railW: Math.round(rb.width), railRight: Math.round(rb.right),
      btnW: bb ? Math.round(bb.width) : null, btnH: bb ? Math.round(bb.height) : null,
      btnTopOffset: bb ? Math.round(bb.top - rb.top) : null, btnRightGap: bb ? Math.round(rb.right - bb.right) : null,
      hasIcon: Boolean(icon), iconSize: icon ? Math.round(icon.getBoundingClientRect().width) : null,
      title: b ? b.getAttribute('title') : null,
    };
  })()`)
  console.log('  侧边栏细栏:', JSON.stringify(rail))
  check('折叠后出现细栏且展开按钮在右上角', Boolean(rail?.hasIcon) && rail.btnTopOffset <= 20 && rail.btnRightGap <= 8, JSON.stringify(rail))
  await shot(cdp, '23-panel-sidebar-rail.png')
  check('细栏尺寸足够好点（栏 36-56px / 按钮 24-34px / 图标 14-20px）', rail?.railW >= 36 && rail?.railW <= 56 && rail?.btnW >= 24 && rail?.btnW <= 34 && rail?.iconSize >= 14 && rail?.iconSize <= 20, JSON.stringify(rail))
  const restoreBtn = await ev(cdp, `(() => { const b = document.querySelector('.sidebar-rail .panel-rail-btn'); if (!b) return false; b.click(); return true })()`)
  await sleep(400)
  const w5 = await widthOf(cdp, '.sidebar')
  check('细栏按钮可恢复侧边栏且宽度被记住', restoreBtn === true && Math.abs(w5 - w4) <= 2, JSON.stringify({ w4, w5 }))
  // 标签栏开关同样可用（两种入口都能恢复）
  const tabbarToggle = await ev(cdp, `(() => { const b = [...document.querySelectorAll('.tabbar button')].find((x) => (x.getAttribute('title') || '').includes('折叠侧边栏')); if (!b) return false; b.click(); return true })()`)
  await sleep(400)
  const collapsed2 = await ev(cdp, `(() => { const el = document.querySelector('.sidebar'); return el && el.getBoundingClientRect().width < 2 })()`)
  check('标签栏按钮仍可折叠侧边栏', tabbarToggle === true && collapsed2 === true, JSON.stringify({ tabbarToggle, collapsed2 }))
  await ev(cdp, `(() => { const b = document.querySelector('.sidebar-rail .panel-rail-btn'); b && b.click(); return true })()`)
  await sleep(400)

  console.log('\n[2] 刷新后布局记忆')
  await cdp.send('Page.navigate', { url: APP_URL })
  await waitFor(cdp, `document.querySelectorAll('.nav-item').length`)
  await sleep(900)
  const w6 = await widthOf(cdp, '.sidebar')
  check('刷新后侧边栏宽度保持', Math.abs(w6 - w4) <= 2, JSON.stringify({ w4, w6 }))

  console.log('\n[3] PDF 视图：缩略图栏 + 批注栏')
  await openFixture(cdp, 'test-complex.pdf')
  const okPdf = await waitFor(cdp, `document.querySelectorAll('.pdf-canvas').length`, 25000)
  check('PDF 已打开', Boolean(okPdf))
  const t0 = await widthOf(cdp, '.pdf-thumbs')
  check('缩略图栏默认宽度 76-300', t0 >= 76 && t0 <= 300, String(t0))
  const td = await dragSplitter(cdp, 'pdfThumbs', 80)
  const t1 = await widthOf(cdp, '.pdf-thumbs')
  check('缩略图栏可拖宽', td.ok && t1 > t0 + 40, JSON.stringify({ t0, t1, td }))
  const a0 = await widthOf(cdp, '.ann-panel')
  check('批注栏默认宽度 200-520', a0 >= 200 && a0 <= 520, String(a0))
  const ad = await dragSplitter(cdp, 'annPanel', -90)
  const a1 = await widthOf(cdp, '.ann-panel')
  check('批注栏向左拖可变宽', ad.ok && a1 > a0 + 40, JSON.stringify({ a0, a1, ad }))

  // 回归防护：内容区不得溢出到批注栏下面（曾导致分隔条被 PDF 画布盖住、拖不动）
  const overflowCheck = await ev(cdp, `(() => {
    const host = document.querySelector('.pdf-annot-host');
    const shell = document.querySelector('.pdf-viewer-shell');
    const splitter = [...document.querySelectorAll('.panel-splitter')].find((s) => String(s.nextElementSibling?.className || '').startsWith('ann-panel'));
    if (!host || !shell || !splitter) return null;
    const hr = host.getBoundingClientRect(), sr = shell.getBoundingClientRect(), pr = splitter.getBoundingClientRect();
    const cx = Math.round(pr.left + pr.width / 2), cy = Math.round(pr.top + pr.height / 2);
    const top = document.elementFromPoint(cx, cy);
    return {
      hostRight: Math.round(hr.right), shellRight: Math.round(sr.right),
      bleed: Math.round(sr.right - hr.right),
      splitterHit: top ? String(top.className || top.tagName).slice(0, 30) : null,
    };
  })()`)
  console.log('  溢出检查:', JSON.stringify(overflowCheck))
  check('PDF 内容区不溢出到批注栏下（无横向 bleed）', (overflowCheck?.bleed ?? 99) <= 1, JSON.stringify(overflowCheck))
  check('批注栏分隔条未被内容遮挡（可命中）', String(overflowCheck?.splitterHit || '').includes('panel-splitter'), JSON.stringify(overflowCheck))
  await shot(cdp, '21-panel-pdf-panels-resized.png')

  // 工具栏按钮折叠/恢复 + 折叠后细栏
  const hideThumbs = await ev(cdp, `(() => { const b = [...document.querySelectorAll('.doc-toolbar .icon-btn')].find((x) => (x.getAttribute('title') || '').includes('隐藏页面缩略图栏')); if (!b) return false; b.click(); return true })()`)
  await sleep(400)
  const thumbsGone = await ev(cdp, `document.querySelectorAll('.pdf-thumbs').length`)
  const thumbsRail = await ev(cdp, `(() => {
    const r = document.querySelector('.thumbs-rail');
    if (!r) return null;
    const b = r.querySelector('.panel-rail-btn');
    const rb = r.getBoundingClientRect(), bb = b.getBoundingClientRect();
    return { railW: Math.round(rb.width), railTop: Math.round(rb.top), railRight: Math.round(rb.right), btnTopOffset: Math.round(bb.top - rb.top), btnRightGap: Math.round(rb.right - bb.right), btnW: Math.round(bb.width), hasIcon: Boolean(b.querySelector('svg')) };
  })()`)
  console.log('  缩略图细栏:', JSON.stringify(thumbsRail))
  check('缩略图栏折叠后出现细栏（按钮在右上角）', Boolean(thumbsRail?.hasIcon) && thumbsRail.btnTopOffset <= 20 && thumbsRail.btnRightGap <= 8, JSON.stringify(thumbsRail))
  await shot(cdp, '24-panel-thumbs-rail.png')
  check('缩略图细栏尺寸足够好点', thumbsRail?.railW >= 36 && thumbsRail?.railW <= 56 && thumbsRail?.btnW >= 24 && thumbsRail?.btnW <= 34, JSON.stringify(thumbsRail))
  const showThumbs = await ev(cdp, `(() => { const b = document.querySelector('.thumbs-rail .panel-rail-btn'); if (!b) return false; b.click(); return true })()`)
  await sleep(400)
  const thumbsBack = await widthOf(cdp, '.pdf-thumbs')
  check('细栏按钮可恢复缩略图栏（宽度记忆）', hideThumbs === true && thumbsGone === 0 && showThumbs === true && Math.abs(thumbsBack - t1) <= 2, JSON.stringify({ hideThumbs, thumbsGone, showThumbs, thumbsBack, t1 }))

  const hideAnn = await ev(cdp, `(() => { const b = [...document.querySelectorAll('.doc-toolbar .icon-btn')].find((x) => (x.getAttribute('title') || '').includes('隐藏批注栏')); if (!b) return false; b.click(); return true })()`)
  await sleep(400)
  const annGone = await ev(cdp, `document.querySelectorAll('.ann-panel').length`)
  const annRail = await ev(cdp, `(() => {
    const r = document.querySelector('.ann-rail');
    if (!r) return null;
    const b = r.querySelector('.panel-rail-btn');
    const rb = r.getBoundingClientRect(), bb = b.getBoundingClientRect();
    return { railW: Math.round(rb.width), railTop: Math.round(rb.top), railRight: Math.round(rb.right), btnTopOffset: Math.round(bb.top - rb.top), btnRightGap: Math.round(rb.right - bb.right), btnW: Math.round(bb.width), hasIcon: Boolean(b.querySelector('svg')) };
  })()`)
  console.log('  批注栏细栏:', JSON.stringify(annRail))
  check('批注栏折叠后出现细栏（按钮在右上角）', Boolean(annRail?.hasIcon) && annRail.btnTopOffset <= 20 && annRail.btnRightGap <= 8, JSON.stringify(annRail))

  console.log('\n[3c] 三个侧栏的折叠按钮都钉在右上角')
  const snapshotCollapseBtns = () => ev(cdp, `(() => {
    const out = {};
    for (const [name, sel] of [['sidebar', '.sidebar-brand .sidebar-collapse'], ['thumbs', '.pdf-thumbs .panel-collapse-btn'], ['annPanel', '.ann-panel .panel-collapse-btn']]) {
      const b = document.querySelector(sel);
      if (!b) { out[name] = null; continue }
      const host = name === 'sidebar'
        ? document.querySelector('.sidebar')
        : b.closest('.pdf-thumbs-title, .ann-panel-title');
      const parent = b.closest('.sidebar-brand, .pdf-thumbs-title, .ann-panel-title');
      const hr = host ? host.getBoundingClientRect() : null;
      const br = b.getBoundingClientRect();
      out[name] = {
        visible: br.width > 0,
        gapRight: hr ? Math.round(hr.right - br.right) : null,
        gapTop: hr ? Math.round(br.top - hr.top) : null,
        hostPos: host ? getComputedStyle(host).position : null,
        headerSticky: parent ? getComputedStyle(parent).position : null,
      };
    }
    return out;
  })()`)
  console.log('\n[3b] 折叠细栏与工具栏开关')
  const showAnn = await ev(cdp, `(() => { const b = document.querySelector('.ann-rail .panel-rail-btn'); if (!b) return false; b.click(); return true })()`)
  await sleep(400)
  const annBack = await widthOf(cdp, '.ann-panel')
  check('批注栏细栏按钮可恢复（宽度记忆）', hideAnn === true && annGone === 0 && showAnn === true && Math.abs(annBack - a1) <= 2, JSON.stringify({ hideAnn, annGone, showAnn, annBack, a1 }))
  await shot(cdp, '22-panel-pdf-collapsed-restored.png')

  // 三个面板都处于展开态时才快照折叠按钮位置
  const collapseBtns = await snapshotCollapseBtns()
  console.log('  折叠按钮位置:', JSON.stringify(collapseBtns))
  for (const [name, label] of [['sidebar', '左侧边栏'], ['thumbs', '缩略图栏'], ['annPanel', '批注栏']]) {
    const b = collapseBtns?.[name]
    const pinned = name === 'sidebar' ? b?.hostPos === 'relative' : b?.headerSticky === 'sticky'
    check(`${label}的折叠按钮钉在右上角`, Boolean(b?.visible) && b.gapTop <= 16 && b.gapRight <= 16 && pinned, JSON.stringify(b))
  }
  await shot(cdp, '25-panel-collapse-buttons.png')
  await shot(cdp, '25-panel-collapse-buttons.png')

  console.log('\n[4] 其他视图的批注栏同样可缩放/折叠')
  for (const [file, cont] of [['test-edit.md', '.md-body'], ['test-edit.docx', '.docx-doc'], ['test-edit.epub', '.epub-body'], ['test-edit.xlsx', '.excel-body']]) {
    await openFixture(cdp, file)
    const rendered = await waitFor(cdp, `document.querySelectorAll('${cont}').length`, 25000)
    // 先双击分隔条复位到默认宽度，避免上一轮的宽度累积到上限导致「拖不动」的假失败
    const sp = await ev(cdp, `(() => { const s = [...document.querySelectorAll('.panel-splitter')].find((el) => String(el.nextElementSibling?.className || '').startsWith('ann-panel')); if (!s) return null; const r = s.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    if (sp) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sp.x, y: sp.y, button: 'left', clickCount: 2 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sp.x, y: sp.y, button: 'left', clickCount: 2 })
      await sleep(250)
    }
    const w = await widthOf(cdp, '.ann-panel')
    const dr = await dragSplitter(cdp, 'annPanel', -60)
    const w2 = await widthOf(cdp, '.ann-panel')
    const toggleOk = await ev(cdp, `(() => { const b = [...document.querySelectorAll('.doc-toolbar .icon-btn')].find((x) => (x.getAttribute('title') || '').includes('隐藏批注栏')); if (!b) return false; b.click(); return true })()`)
    await sleep(300)
    const gone = await ev(cdp, `document.querySelectorAll('.ann-panel').length`)
    const railOk = await ev(cdp, `(() => { const r = document.querySelector('.ann-rail'); return Boolean(r && r.querySelector('.panel-rail-btn svg')) })()`)
    await ev(cdp, `(() => { const b = document.querySelector('.ann-rail .panel-rail-btn'); b && b.click(); return true })()`)
    await sleep(300)
    check(`${file}：批注栏可渲染/缩放/折叠（含细栏恢复）`, Boolean(rendered) && w >= 200 && dr.ok && w2 > w && toggleOk === true && gone === 0 && railOk === true, JSON.stringify({ rendered, w, w2, toggleOk, gone, railOk }))
  }

  const fatal = errors.filter((e) => !/ResizeObserver|favicon/i.test(e))
  check('全程无未捕获异常', fatal.length === 0, fatal.slice(0, 3).join(' | '))

  console.log(`\n结果: ${failures === 0 ? '全部通过' : failures + ' 项失败'}，截图见 tmp/hig-shots/`)
  cdp.close(); chrome.kill()
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error('verify-panels failed:', e); process.exit(2) })
