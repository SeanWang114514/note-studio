// verify-shape.mjs — 验收「图形工具已独立成上栏图标 + 工具栏不换行/不溢出」
// 覆盖：图形按钮存在且图标随类型变化、三种打开手势、图形设置面板内容（直线/矩形/圆形 + 颜色 + 粗细）、
//       画出的图形是正确的几何形状（矩形只有边框、直线是直的、圆形是闭合弧）、
//       画笔设置里不再有图形类型、工具栏在 4 种窗口宽度下都是单行且无溢出/无裁剪。
// 用法: node tools/verify-shape.mjs [fixture] [chromePath]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const FILE = process.argv[2] || 'test-complex.pdf'
const CHROME = process.argv[3] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
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

async function waitFor(cdp, expr, ms = 25000, step = 300) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await ev(cdp, expr)
    if (v && !v.__error) return v
    await sleep(step)
  }
  return null
}

const btnPos = (cdp, prefix) => ev(cdp, `(() => {
  const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith(${JSON.stringify(prefix)}));
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), title: b.getAttribute('title') || '', cls: b.className };
})()`)

async function realClick(cdp, x, y, clickCount = 1) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount })
  await sleep(320)
}

// 画一个图形并返回画布墨迹的几何特征
async function drawShape(cdp, x0, y0, x1, y1) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 })
  const steps = 16
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps, button: 'left' })
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 })
  await sleep(700)
  return ev(cdp, `(() => {
    const cv = document.querySelector('.annot-canvas');
    const ctx = cv.getContext('2d');
    const g = ctx.getImageData(0, 0, cv.width, cv.height);
    const d = g.data;
    let n = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
      if (d[(y * cv.width + x) * 4 + 3] > 12) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
    }
    if (!n) return { n: 0 };
    const dpr = window.devicePixelRatio || 1;
    // 中心 1/4 区域是否为空（矩形/圆形只有轮廓，内部应为空；画笔实心/直线会穿过中心）
    const cx0 = Math.round(minX + (maxX - minX) * 0.375), cx1 = Math.round(minX + (maxX - minX) * 0.625);
    const cy0 = Math.round(minY + (maxY - minY) * 0.375), cy1 = Math.round(minY + (maxY - minY) * 0.625);
    let innerInk = 0, innerTotal = 0;
    for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) {
      innerTotal++; if (d[(y * cv.width + x) * 4 + 3] > 12) innerInk++;
    }
    // 四角是否有墨迹（矩形有角；圆形没有角；直线只在两端）
    const probe = (px, py) => { let hit = 0; for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) { const x = px + dx, y = py + dy; if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) continue; if (d[(y * cv.width + x) * 4 + 3] > 12) hit++ } return hit };
    return {
      n, cssW: Math.round(((maxX - minX + 1) / dpr) * 10) / 10, cssH: Math.round(((maxY - minY + 1) / dpr) * 10) / 10,
      innerFillRatio: innerTotal ? Math.round((innerInk / innerTotal) * 1000) / 1000 : 0,
      cornerTL: probe(minX + 3, minY + 3), cornerTR: probe(maxX - 3, minY + 3),
      cornerBL: probe(minX + 3, maxY - 3), cornerBR: probe(maxX - 3, maxY - 3),
      midTop: probe(Math.round((minX + maxX) / 2), minY + 2),
      center: probe(Math.round((minX + maxX) / 2), Math.round((minY + maxY) / 2)),
    };
  })()`)
}

async function clearAll(cdp) {
  await ev(cdp, `(() => { const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').includes('清除全部批注')); b && b.click(); return true })()`)
  await sleep(450)
}

async function main() {
  let alive = false
  for (let i = 0; i < 8; i++) {
    try { const r = await fetch(APP_URL, { signal: AbortSignal.timeout(2500) }); if (r.status < 500) { alive = true; break } } catch {}
    await sleep(800)
  }
  if (!alive) { console.error('dev 服务未启动: ' + APP_URL); process.exit(1) }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'shape-'))
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9249', '--user-data-dir=' + userData,
    '--no-first-run', '--no-default-browser-check', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' })
  let targets = []
  for (let i = 0; i < 60; i++) { try { targets = await (await fetch('http://127.0.0.1:9249/json/list')).json(); if (targets.length) break } catch {} await sleep(250) }
  const cdp = new CDP((targets.find((t) => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  const errors = []
  cdp.ws.addEventListener('message', (e) => {
    try { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params?.exceptionDetails?.exception?.description || '').slice(0, 160)) } catch {}
  })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 2, mobile: false })
  await cdp.send('Page.navigate', { url: APP_URL })
  await waitFor(cdp, `document.querySelectorAll('.nav-item').length`)
  await sleep(1000)

  const resolved = [path.join(ROOT, 'public', FILE), path.join(ROOT, 'tmp', FILE)].find((p) => fs.existsSync(p))
  const b64 = fs.readFileSync(resolved).toString('base64')
  await ev(cdp, `(() => {
    const bytes = Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0));
    const f = new File([bytes], '${FILE}', { lastModified: 1700000000000 });
    const handle = { kind: 'file', name: '${FILE}', getFile: async () => f,
      queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      createWritable: async () => ({ write: async () => {}, close: async () => {}, seek: async () => {}, truncate: async () => {}, getPosition: async () => 0 }) };
    window.showOpenFilePicker = async () => [handle];
    return 'ok';
  })()`)
  await ev(cdp, `(async () => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '打开文件'); b && b.click(); return true })()`, true)
  await waitFor(cdp, `document.querySelectorAll('.annot-canvas').length`, 25000)
  await sleep(1500)

  console.log('\n[1] 上栏有独立的图形按钮')
  const shapeBtn = await btnPos(cdp, '图形')
  console.log('  shape button:', JSON.stringify(shapeBtn))
  check('工具栏存在独立图形按钮（title 以「图形」开头）', Boolean(shapeBtn?.title?.startsWith('图形')), JSON.stringify(shapeBtn))
  check('图形按钮带设置角标', String(shapeBtn?.cls || '').includes('has-settings'), String(shapeBtn?.cls))
  const order = await ev(cdp, `(() => [...document.querySelectorAll('.doc-toolbar .tool-group')][0].querySelectorAll('button').length)()`)
  check('图形按钮已并入工具栏第一组', order >= 7, String(order))

  console.log('\n[2] 三种手势都能打开图形设置')
  await realClick(cdp, shapeBtn.x, shapeBtn.y)
  const t1 = await ev(cdp, `(() => { const p = document.querySelector('.shape-popover'); return p ? { title: (p.querySelector('.pop-title') || {}).textContent, segs: [...p.querySelectorAll('.seg-btn')].map((b) => (b.textContent || '').trim()), swatches: p.querySelectorAll('.swatch').length, ranges: p.querySelectorAll('input[type="range"]').length } : null })()`)
  console.log('  shape popover (第 1 次点击后):', JSON.stringify(t1))
  check('第一次点击只选中工具（不弹面板）', t1 === null, JSON.stringify(t1))
  await realClick(cdp, shapeBtn.x, shapeBtn.y)
  const t2 = await ev(cdp, `(() => { const p = document.querySelector('.shape-popover'); if (!p) return null; const r = p.getBoundingClientRect(); return { title: (p.querySelector('.pop-title') || {}).textContent, segs: [...p.querySelectorAll('.seg-btn')].map((b) => (b.textContent || '').trim()), swatches: p.querySelectorAll('.swatch').length, ranges: p.querySelectorAll('input[type="range"]').length, inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1, backdrop: Boolean(document.querySelector('.popover-backdrop')) } })()`)
  console.log('  shape popover (第 2 次点击后):', JSON.stringify(t2))
  check('连点两次打开图形设置面板', t2?.title === '图形设置', JSON.stringify(t2))
  check('面板含 直线/矩形/圆形', JSON.stringify(t2?.segs) === JSON.stringify(['直线', '矩形', '圆形']), JSON.stringify(t2?.segs))
  check('面板含色板 + 自定义色 + 粗细（在视口内）', (t2?.swatches || 0) >= 5 && (t2?.ranges || 0) >= 1 && t2?.inViewport === true, JSON.stringify(t2))
  await shot(cdp, '50-shape-settings.png')
  const afterRight = await (async () => {
    await ev(cdp, `(() => { const b = document.querySelector('.popover-backdrop'); b && b.click(); return true })()`)
    await sleep(300)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: shapeBtn.x, y: shapeBtn.y, button: 'right', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: shapeBtn.x, y: shapeBtn.y, button: 'right', clickCount: 1 })
    await sleep(400)
    return ev(cdp, `Boolean(document.querySelector('.shape-popover'))`)
  })()
  check('右键也可打开图形设置', afterRight === true, String(afterRight))

  console.log('\n[3] 画笔设置里不再有图形类型（已独立）')
  const penPopover = await ev(cdp, `(() => { const b = document.querySelector('.popover-backdrop'); b && b.click(); return true })()`)
  await sleep(250)
  const penBtn = await btnPos(cdp, '画笔')
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: penBtn.x, y: penBtn.y, button: 'left', clickCount: 2 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: penBtn.x, y: penBtn.y, button: 'left', clickCount: 2 })
  await sleep(500)
  const penInfo = await ev(cdp, `(() => { const p = document.querySelector('.pen-popover:not(.shape-popover)'); if (!p) return null; return { title: (p.querySelector('.pop-title') || {}).textContent, segs: [...p.querySelectorAll('.seg-btn')].map((b) => (b.textContent || '').trim()), swatches: p.querySelectorAll('.swatch').length, ranges: p.querySelectorAll('input[type="range"]').length } })()`)
  console.log('  pen popover:', JSON.stringify(penInfo), penPopover)
  check('画笔设置只剩颜色/粗细（无图形类型）', penInfo?.title === '画笔设置' && (penInfo?.segs?.length || 0) === 0 && (penInfo?.swatches || 0) >= 5 && (penInfo?.ranges || 0) === 1, JSON.stringify(penInfo))
  await ev(cdp, `(() => { const b = document.querySelector('.popover-backdrop'); b && b.click(); return true })()`)
  await sleep(300)

  console.log('\n[4] 画出的是真正的几何图形')
  const box = await ev(cdp, `(() => { const cv = document.querySelector('.annot-canvas'); const r = cv.getBoundingClientRect(); const sc = (() => { let n = cv.parentElement; while (n && n !== document.body) { const st = getComputedStyle(n); if (/(auto|scroll|overlay)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 4) return n; n = n.parentElement } return null })(); const sr = sc ? sc.getBoundingClientRect() : r; return { x: Math.round(r.left + 100), y: Math.round(sr.top + 220) } })()`)
  // 直线
  await clearAll(cdp)
  const line = await drawShape(cdp, box.x, box.y, box.x + 240, box.y + 120)
  console.log('  直线:', JSON.stringify(line))
  check('直线：两点间呈线状（长宽比≈2:1）', line?.n > 100 && Math.abs(line.cssW / Math.max(1, line.cssH) - 2) < 0.8, JSON.stringify(line))
  // 矩形
  await clearAll(cdp)
  await ev(cdp, `(async () => {
    const b = document.querySelector('.popover-backdrop'); b && b.click();
    const btn = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith('图形'));
    const r = btn.getBoundingClientRect();
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 2, clientY: r.top + 2 }));
    await new Promise((res) => setTimeout(res, 250));
    btn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 2, clientY: r.top + 2 }));
    await new Promise((res) => setTimeout(res, 350));
    const p = document.querySelector('.shape-popover');
    p.querySelectorAll('.seg-btn')[1].click();
    await new Promise((res) => setTimeout(res, 200));
    document.querySelector('.popover-backdrop').click();
    await new Promise((res) => setTimeout(res, 250));
    return true;
  })()`, true)
  const rect = await drawShape(cdp, box.x, box.y, box.x + 260, box.y + 160)
  console.log('  矩形:', JSON.stringify(rect))
  check('矩形：只有边框（内部空心）', rect?.n > 100 && rect.innerFillRatio < 0.06, JSON.stringify({ innerFillRatio: rect?.innerFillRatio, n: rect?.n }))
  check('矩形：四个角都有墨迹', (rect?.cornerTL || 0) > 0 && (rect?.cornerTR || 0) > 0 && (rect?.cornerBL || 0) > 0 && (rect?.cornerBR || 0) > 0, JSON.stringify(rect))
  // 圆形
  await clearAll(cdp)
  await ev(cdp, `(async () => {
    const btn = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith('图形'));
    if (!document.querySelector('.shape-popover')) {
      const r = btn.getBoundingClientRect();
      btn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 2, clientY: r.top + 2 }));
      await new Promise((res) => setTimeout(res, 350));
    }
    const p = document.querySelector('.shape-popover');
    p.querySelectorAll('.seg-btn')[2].click();
    await new Promise((res) => setTimeout(res, 200));
    document.querySelector('.popover-backdrop').click();
    await new Promise((res) => setTimeout(res, 250));
    return true;
  })()`, true)
  const ellipse = await drawShape(cdp, box.x, box.y, box.x + 240, box.y + 240)
  console.log('  圆形:', JSON.stringify(ellipse))
  check('圆形：闭合轮廓 + 内部空心 + 四角无墨迹', ellipse?.n > 100 && ellipse.innerFillRatio < 0.06 && (ellipse.cornerTL + ellipse.cornerTR + ellipse.cornerBL + ellipse.cornerBR) === 0, JSON.stringify({ inner: ellipse?.innerFillRatio, corners: [ellipse?.cornerTL, ellipse?.cornerTR, ellipse?.cornerBL, ellipse?.cornerBR] }))
  check('圆形：轮廓经过正上/正下（midTop 有墨）', (ellipse?.midTop || 0) > 0, JSON.stringify({ midTop: ellipse?.midTop }))
  await shot(cdp, '51-shape-drawn.png')

  console.log('\n[5] 工具栏在多种窗口宽度下都不换行、不溢出')
  const layoutOf = (sel) => `(() => {
    const tb = document.querySelector(${JSON.stringify(sel)});
    if (!tb) return null;
    const r = tb.getBoundingClientRect();
    const kids = [...tb.children].filter((el) => getComputedStyle(el).display !== 'none');
    // 行聚类：中心线相差 3px 以内视为同一行（不同组高度差 1px 很常见）
    const centers = kids.map((el) => { const r = el.getBoundingClientRect(); return Math.round(r.top + r.height / 2) });
    const rows = [];
    for (const c of centers) {
      const hit = rows.find((r) => Math.abs(r - c) <= 3);
      if (hit == null) rows.push(c);
    }
    const overflow = kids.filter((el) => el.getBoundingClientRect().right > r.right + 0.5).map((el) => String(el.className).slice(0, 30));
    let btns = 0, btnsHidden = 0, minBtnW = 999;
    for (const b of tb.querySelectorAll('button')) {
      if (getComputedStyle(b).display === 'none') { btnsHidden++; continue }
      btns++; minBtnW = Math.min(minBtnW, Math.round(b.getBoundingClientRect().width));
    }
    return { h: Math.round(r.height), rows, overflow, btns, btnsHidden, minBtnW, scrollW: tb.scrollWidth, clientW: tb.clientWidth };
  })()`

  const widthCases = [1600, 1440, 1280, 1120]
  for (const w of widthCases) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 950, deviceScaleFactor: 2, mobile: false })
    await sleep(500)
    for (const [label, sel] of [['批注工具栏', '.doc-toolbar'], ['查看工具栏', '.pdf-toolbar']]) {
      const geo = await ev(cdp, layoutOf(sel))
      console.log(`  ${w}px ${label}:`, JSON.stringify(geo))
      check(`${w}px：${label}单行（无换行）`, (geo?.rows?.length || 9) === 1, JSON.stringify(geo?.rows))
      check(`${w}px：${label}不溢出/不裁剪`, (geo?.overflow?.length || 0) === 0 && (geo?.scrollW || 0) <= (geo?.clientW || 0) + 1, JSON.stringify({ overflow: geo?.overflow, sw: geo?.scrollW, cw: geo?.clientW }))
      check(`${w}px：${label}保持单行高度且按钮未被压缩`, (geo?.h || 999) <= 56 && (geo?.minBtnW || 0) >= 22, JSON.stringify({ h: geo?.h, minBtnW: geo?.minBtnW }))
    }
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 950, deviceScaleFactor: 2, mobile: false })
  await sleep(400)
  await shot(cdp, '52-toolbar-1280.png')

  console.log('\n[5b] 其他文档视图（md/docx/epub/xlsx）的工具栏同样单行不溢出')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 950, deviceScaleFactor: 2, mobile: false })
  for (const [file, cont] of [['test-edit.md', '.md-body'], ['test-edit.docx', '.docx-doc'], ['test-edit.epub', '.epub-body'], ['test-edit.xlsx', '.excel-body']]) {
    const raw = fs.readFileSync(path.join(ROOT, 'public', file)).toString('base64')
    await ev(cdp, `(() => {
      const bytes = Uint8Array.from(atob('${raw}'), (c) => c.charCodeAt(0));
      const f = new File([bytes], '${file}', { lastModified: 1700000000000 });
      const handle = { kind: 'file', name: '${file}', getFile: async () => f,
        queryPermission: async () => 'granted', requestPermission: async () => 'granted',
        createWritable: async () => ({ write: async () => {}, close: async () => {}, seek: async () => {}, truncate: async () => {}, getPosition: async () => 0 }) };
      window.showOpenFilePicker = async () => [handle];
      return 'ok';
    })()`)
    await ev(cdp, `(async () => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '打开文件'); b && b.click(); return true })()`, true)
    const rendered = await waitFor(cdp, `document.querySelectorAll('${cont}').length`, 25000)
    await sleep(700)
    const geo = await ev(cdp, layoutOf('.doc-toolbar'))
    console.log(`  ${file}:`, JSON.stringify(geo))
    check(`${file}：工具栏单行不溢出`, Boolean(rendered) && (geo?.rows?.length || 9) === 1 && (geo?.overflow?.length || 0) === 0 && (geo?.scrollW || 0) <= (geo?.clientW || 0) + 1, JSON.stringify(geo))
  }

  console.log('\n[5c] 图形批注可跨标签页重载（持久化往返）')
  const reopened = await ev(cdp, `(async () => {
    // 切回 PDF 标签页
    const tabs = [...document.querySelectorAll('.tab')];
    const pdfTab = tabs.find((t) => (t.textContent || '').includes('${FILE}'));
    if (!pdfTab) return 'no-pdf-tab';
    pdfTab.click();
    await new Promise((r) => setTimeout(r, 1500));
    const cv = document.querySelector('.annot-canvas');
    if (!cv) return 'no-canvas';
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 12) n++;
    return n;
  })()`, true)
  console.log('  重载后墨迹像素:', reopened)
  check('切走再切回后图形批注仍在（已持久化）', typeof reopened === 'number' && reopened > 300, String(reopened))

  console.log('\n[6] 窄屏时图形设置面板仍在视口内')
  const narrow = await ev(cdp, `(async () => {
    const b = document.querySelector('.popover-backdrop'); b && b.click();
    const btn = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith('图形'));
    const r = btn.getBoundingClientRect();
    btn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 2, clientY: r.top + 2 }));
    await new Promise((res) => setTimeout(res, 400));
    const p = document.querySelector('.shape-popover');
    if (!p) return null;
    const pr = p.getBoundingClientRect();
    return { left: Math.round(pr.left), right: Math.round(pr.right), top: Math.round(pr.top), vw: innerWidth, inViewport: pr.left >= 0 && pr.right <= innerWidth + 1 };
  })()`, true)
  console.log('  1280px 下图形面板:', JSON.stringify(narrow))
  check('图形设置面板不超出窗口', narrow?.inViewport === true, JSON.stringify(narrow))

  const fatal = errors.filter((e) => !/ResizeObserver|favicon/i.test(e))
  check('全程无未捕获异常', fatal.length === 0, fatal.slice(0, 3).join(' | '))

  console.log(`\n结果: ${failures === 0 ? '全部通过' : failures + ' 项失败'}，截图见 tmp/hig-shots/`)
  cdp.close(); chrome.kill()
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error('verify-shape failed:', e); process.exit(2) })
