// verify-eraser.mjs — 验收「橡皮擦不留重影」+「侧边栏导航项对齐」
// 1) 画一条粗笔画 → 用像素橡皮沿路径拖动 → 擦除段必须干净，且沿途不能留下橡皮虚线圆圈残影
// 2) 笔画橡皮整条擦除 → 墨迹归零，松手后无残留
// 3) 侧边栏三个导航项（欢迎页/模型设置/设置）图标与文字左右对齐
// 用法: node tools/verify-eraser.mjs [fixture] [chromePath]
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

// 画布上按区域统计墨迹（CSS 像素坐标，相对视口）
const inkStats = (region) => `(() => {
  const cv = document.querySelector('.annot-canvas');
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect();
  const reg = ${JSON.stringify(region)};
  const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let total = 0;
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      if (data[(y * cv.width + x) * 4 + 3] > 12) {
        total++;
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  // 区域统计（用画布内部坐标）
  let inRegion = 0;
  if (reg) {
    const x0 = Math.max(0, Math.round((reg.x0 - r.left) * dpr));
    const x1 = Math.min(cv.width, Math.round((reg.x1 - r.left) * dpr));
    const y0 = Math.max(0, Math.round((reg.y0 - r.top) * dpr));
    const y1 = Math.min(cv.height, Math.round((reg.y1 - r.top) * dpr));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (data[(y * cv.width + x) * 4 + 3] > 12) inRegion++;
  }
  return { total, inRegion, bbox: total ? { minX, minY, maxX, maxY } : null, w: cv.width, h: cv.height };
})()`

async function main() {
  let alive = false
  for (let i = 0; i < 8; i++) {
    try { const r = await fetch(APP_URL, { signal: AbortSignal.timeout(2500) }); if (r.status < 500) { alive = true; break } } catch {}
    await sleep(800)
  }
  if (!alive) { console.error('dev 服务未启动: ' + APP_URL); process.exit(1) }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eraser-'))
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9251', '--user-data-dir=' + userData,
    '--no-first-run', '--no-default-browser-check', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' })
  let targets = []
  for (let i = 0; i < 60; i++) { try { targets = await (await fetch('http://127.0.0.1:9251/json/list')).json(); if (targets.length) break } catch {} await sleep(250) }
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

  console.log('\n[1] 侧边栏导航项对齐（欢迎页 / 设置；模型设置已按需求移除）')
  const navGeo = await ev(cdp, `(() => {
    const items = [...document.querySelectorAll('.sidebar .nav-item')];
    return items.map((el) => {
      const r = el.getBoundingClientRect();
      const icon = el.querySelector('svg');
      const label = el.querySelector('span');
      const ir = icon ? icon.getBoundingClientRect() : null;
      const lr = label ? label.getBoundingClientRect() : null;
      return {
        text: (label ? label.textContent : '').trim(),
        itemLeft: Math.round(r.left), itemRight: Math.round(r.right), itemH: Math.round(r.height),
        iconLeft: ir ? Math.round(ir.left) : null, iconTop: ir ? Math.round(ir.top) : null,
        labelLeft: lr ? Math.round(lr.left) : null, labelTop: lr ? Math.round(lr.top) : null,
      };
    });
  })()`)
  console.log('  导航项:', JSON.stringify(navGeo))
  check('侧边栏有导航项（欢迎页 / 设置）', Array.isArray(navGeo) && navGeo.length === 2 && JSON.stringify(navGeo.map((n) => n.text)) === JSON.stringify(['欢迎页', '设置']), JSON.stringify(navGeo))
  if (Array.isArray(navGeo) && navGeo.length === 2) {
    const lefts = navGeo.map((n) => n.iconLeft)
    const labelLefts = navGeo.map((n) => n.labelLeft)
    const rights = navGeo.map((n) => n.itemRight)
    check('两个导航项左边缘一致（图标对齐）', Math.max(...lefts) - Math.min(...lefts) <= 1 && Math.max(...rights) - Math.min(...rights) <= 1, JSON.stringify({ lefts, rights }))
    check('两个导航项文字左边缘一致', Math.max(...labelLefts) - Math.min(...labelLefts) <= 1, JSON.stringify({ labelLefts }))
    check('两个导航项高度一致', new Set(navGeo.map((n) => n.itemH)).size === 1, JSON.stringify(navGeo.map((n) => n.itemH)))
  }
  await shot(cdp, '60-sidebar-nav-aligned.png')

  console.log('\n[2] 像素橡皮不留残影')
  // 打开 PDF
  const b64 = fs.readFileSync(path.join(ROOT, 'public', FILE)).toString('base64')
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

  const box = await ev(cdp, `(() => { const cv = document.querySelector('.annot-canvas'); const r = cv.getBoundingClientRect(); const sc = (() => { let n = cv.parentElement; while (n && n !== document.body) { const st = getComputedStyle(n); if (/(auto|scroll|overlay)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 4) return n; n = n.parentElement } return null })(); const sr = sc ? sc.getBoundingClientRect() : r; return { left: Math.round(r.left), top: Math.round(sr.top + 220), y: Math.round(sr.top + 220) } })()`)
  const y = box.y
  const x0 = 420
  // 画笔：粗一点便于观察
  await ev(cdp, `(async () => {
    const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith('画笔'));
    b.click();
    await new Promise((r) => setTimeout(r, 200));
    b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 350));
    const pop = document.querySelector('.pen-popover:not(.shape-popover):not(.eraser-popover)');
    const range = pop.querySelector('input[type="range"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(range, '8');
    range.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    document.querySelector('.popover-backdrop').click();
    await new Promise((r) => setTimeout(r, 200));
    return true;
  })()`, true)
  const drawLine = async (fromX, toX, yy) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y: yy })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: yy, button: 'left', clickCount: 1 })
    const steps = 30
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX + ((toX - fromX) * i) / steps, y: yy, button: 'left' })
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: yy, button: 'left', clickCount: 1 })
    await sleep(600)
  }
  await drawLine(x0, x0 + 320, y)
  const afterDraw = await ev(cdp, inkStats({ x0: x0 - 20, x1: x0 + 340, y0: y - 40, y1: y + 40 }))
  console.log('  画完:', JSON.stringify(afterDraw))
  check('笔画已画出', (afterDraw?.total || 0) > 500, JSON.stringify(afterDraw))
  await shot(cdp, '61-eraser-before.png')

  // 橡皮擦：像素模式，尺寸放到 30 便于观察残影
  await ev(cdp, `(async () => {
    const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith('橡皮擦'));
    b.click();
    await new Promise((r) => setTimeout(r, 200));
    b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 350));
    const pop = document.querySelector('.eraser-popover');
    pop.querySelectorAll('.seg-btn')[0].click(); // 像素橡皮
    const range = pop.querySelector('input[type="range"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(range, '30');
    range.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    document.querySelector('.popover-backdrop').click();
    await new Promise((r) => setTimeout(r, 200));
    return true;
  })()`, true)
  // 沿笔画中部拖动擦除（分多个点，模拟快速拖动）
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + 120, y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0 + 120, y, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + 120 + i * 8, y, button: 'left' })
    await sleep(25)
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 + 216, y, button: 'left', clickCount: 1 })
  await sleep(800)
  const afterErase = await ev(cdp, inkStats({ x0: x0 - 20, x1: x0 + 340, y0: y - 40, y1: y + 40 }))
  const erasedRegion = await ev(cdp, inkStats({ x0: x0 + 130, x1: x0 + 205, y0: y - 30, y1: y + 30 }))
  const aboveLine = await ev(cdp, inkStats({ x0: x0 - 20, x1: x0 + 340, y0: y - 90, y1: y - 45 }))
  console.log('  擦完:', JSON.stringify(afterErase), ' 擦除段:', JSON.stringify(erasedRegion), ' 笔画上方:', JSON.stringify(aboveLine))
  check('擦除后总墨迹减少', (afterErase?.total || 0) < (afterDraw?.total || 0) * 0.85, JSON.stringify({ before: afterDraw?.total, after: afterErase?.total }))
  check('擦除段基本干净（无重影）', (erasedRegion?.inRegion || 0) <= 40, JSON.stringify(erasedRegion))
  check('笔画上方无残留（橡皮圆圈不留在画布上）', (aboveLine?.inRegion || 0) <= 20, JSON.stringify(aboveLine))
  const cursorLeft = await ev(cdp, `(() => { const el = document.querySelector('.eraser-cursor-preview'); return el ? getComputedStyle(el).opacity : 'missing' })()`)
  check('松手后橡皮光标预览已隐藏', cursorLeft === '0', String(cursorLeft))
  await shot(cdp, '62-eraser-after.png')

  console.log('\n[3] 笔画橡皮整条擦除（新画一笔，避免与上一步拆分出的碎片混淆）')
  await ev(cdp, `(() => { const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').includes('清除全部批注')); b && b.click(); return true })()`)
  await sleep(500)
  // 重新选画笔并画一条新笔画
  await ev(cdp, `(async () => {
    const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith('画笔'));
    b.click();
    await new Promise((r) => setTimeout(r, 250));
    return true;
  })()`, true)
  await drawLine(x0, x0 + 200, y)
  const fresh = await ev(cdp, inkStats({ x0: x0 - 20, x1: x0 + 340, y0: y - 60, y1: y + 60 }))
  check('新笔画已画出', (fresh?.total || 0) > 500, JSON.stringify(fresh))
  await ev(cdp, `(async () => {
    const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith('橡皮擦'));
    b.click();
    await new Promise((r) => setTimeout(r, 200));
    b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 350));
    const pop = document.querySelector('.eraser-popover');
    pop.querySelectorAll('.seg-btn')[1].click(); // 笔画橡皮
    await new Promise((r) => setTimeout(r, 150));
    document.querySelector('.popover-backdrop').click();
    await new Promise((r) => setTimeout(r, 200));
    return true;
  })()`, true)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + 20, y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0 + 20, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + 60, y, button: 'left' })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 + 60, y, button: 'left', clickCount: 1 })
  await sleep(800)
  const strokeErase = await ev(cdp, inkStats({ x0: x0 - 20, x1: x0 + 340, y0: y - 60, y1: y + 60 }))
  console.log('  笔画橡皮后:', JSON.stringify(strokeErase))
  check('笔画橡皮擦干净整条笔画', (strokeErase?.total || 0) === 0, JSON.stringify(strokeErase))
  await shot(cdp, '63-eraser-stroke-mode.png')

  console.log('\n[4] 荧光笔叠加：第二道画在第一道上面，不得出现矩形接缝/边缘被裁')
  {
    // 选荧光笔，粗 9（线宽约 20px，最容易暴露脏矩形裁切接缝）
    await ev(cdp, `(async () => {
      const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith('荧光笔'));
      b.click();
      await new Promise((r) => setTimeout(r, 200));
      b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 350));
      const pop = document.querySelector('.pen-popover:not(.shape-popover):not(.eraser-popover)');
      const range = pop.querySelector('input[type="range"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(range, '9');
      range.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      document.querySelector('.popover-backdrop').click();
      await new Promise((r) => setTimeout(r, 200));
      return true;
    })()`, true)
    // 第一道 A：[x0, x0+260]；第二道 B：[x0+180, x0+340]，重叠 80px
    await drawLine(x0, x0 + 260, y)
    await drawLine(x0 + 180, x0 + 340, y)
    await sleep(800)
    const alphaAt = (viewX) => ev(cdp, `(() => {
      const cv = document.querySelector('.annot-canvas');
      const r = cv.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const cx = Math.round(((${viewX}) - r.left) * dpr);
      const cy = Math.round((${y} - r.top) * dpr);
      if (cx < 0 || cy < 0 || cx >= cv.width || cy >= cv.height) return -1;
      return cv.getContext('2d').getImageData(cx, cy, 1, 1).data[3] / 255;
    })()`)
    const aOnly1 = await alphaAt(x0 + 130)
    const aOnly2 = await alphaAt(x0 + 165) // 靠近 B 起点：A 的纯色区，不应被 B 的脏矩形裁出一段
    const overlap = await alphaAt(x0 + 230)
    console.log('  alpha: A纯色(x0+130)=', aOnly1, ' A纯色(x0+165)=', aOnly2, ' 重叠(x0+230)=', overlap)
    const uniform = Math.abs(aOnly1 - aOnly2) < 0.1 && aOnly1 > 0.2
    check('第一道荧光笔在靠近第二道起点处仍保持均匀（无矩形接缝）', uniform, JSON.stringify({ aOnly1, aOnly2 }))
    // 覆盖书写不应累加变深：第二道盖在第一道上的重叠区 alpha 应保持接近单道（≈0.35），而非叠加到 0.6+
    check('两道重叠处保持均匀（覆盖书写不加深，alpha≈0.35，不再出现暗矩形）', overlap > 0.25 && overlap < 0.42, JSON.stringify({ overlap }))
    await shot(cdp, '64-highlighter-overlap.png')
  }

  const fatal = errors.filter((e) => !/ResizeObserver|favicon/i.test(e))
  check('全程无未捕获异常', fatal.length === 0, fatal.slice(0, 3).join(' | '))

  console.log(`\n结果: ${failures === 0 ? '全部通过' : failures + ' 项失败'}，截图见 tmp/hig-shots/`)
  cdp.close(); chrome.kill()
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error('verify-eraser failed:', e); process.exit(2) })
