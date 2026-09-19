// verify-tools.mjs — 验收「画笔/荧光笔/橡皮擦 双击设置」原有功能
// 覆盖：双击打开设置面板、类型/颜色/粗细/自定义颜色、橡皮擦模式与大小、设置是否真正生效（像素级验证）、遮罩关闭
// 用法: node tools/verify-tools.mjs [fixture] [chromePath]
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

async function clickButtonByTitle(cdp, prefixes, { double = false } = {}) {
  return ev(cdp, `(async () => {
    const list = ${JSON.stringify(prefixes)};
    const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => list.some((p) => (x.getAttribute('title') || '').startsWith(p)));
    if (!b) return 'not-found';
    const r = b.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window, detail: ${double ? 2 : 1} };
    b.dispatchEvent(new MouseEvent('click', opts));
    if (${double}) {
      b.dispatchEvent(new MouseEvent('dblclick', opts));
    }
    await new Promise((r2) => setTimeout(r2, 400));
    return 'ok';
  })()`, true)
}

// 在覆盖层上画一条水平短线，返回墨迹统计（颜色/厚度）
async function drawAndSample(cdp, x0, y0, len) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 - 40, y: y0 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0 - 40, y: y0, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 20; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 - 40 + (len * i) / 20, y: y0, button: 'left' })
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 - 40 + len, y: y0, button: 'left', clickCount: 1 })
  await sleep(700)
  return ev(cdp, `(() => {
    const cv = document.querySelector('.annot-canvas');
    const ctx = cv.getContext('2d');
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0, sr = 0, sg = 0, sb = 0, minY = 1e9, maxY = -1, minX = 1e9, maxX = -1;
    for (let y = 0; y < cv.height; y++) {
      for (let x = 0; x < cv.width; x++) {
        const i = (y * cv.width + x) * 4;
        if (d[i + 3] > 12) {
          n++; sr += d[i]; sg += d[i + 1]; sb += d[i + 2];
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
        }
      }
    }
    const dpr = window.devicePixelRatio || 1;
    return n ? { n, r: Math.round(sr / n), g: Math.round(sg / n), b: Math.round(sb / n), cssThickness: Math.round(((maxY - minY + 1) / dpr) * 10) / 10, cssLen: Math.round(((maxX - minX + 1) / dpr) * 10) / 10 } : { n: 0 };
  })()`)
}

async function clearAll(cdp) {
  await ev(cdp, `(() => { const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').includes('清除全部批注')); b && b.click(); return true })()`)
  await sleep(500)
}

async function main() {
  let alive = false
  for (let i = 0; i < 8; i++) {
    try { const r = await fetch(APP_URL, { signal: AbortSignal.timeout(2500) }); if (r.status < 500) { alive = true; break } } catch {}
    await sleep(800)
  }
  if (!alive) { console.error('dev 服务未启动: ' + APP_URL); process.exit(1) }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'))
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9247', '--user-data-dir=' + userData,
    '--no-first-run', '--no-default-browser-check', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' })
  let targets = []
  for (let i = 0; i < 60; i++) { try { targets = await (await fetch('http://127.0.0.1:9247/json/list')).json(); if (targets.length) break } catch {} await sleep(250) }
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

  console.log('\n[0] 真实鼠标双击（mousedown/up × 2，非合成 dblclick）→ 面板应保持打开')
  const penBtn = await ev(cdp, `(() => {
    const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith('画笔'));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`)
  check('找到画笔按钮', Boolean(penBtn), JSON.stringify(penBtn))
  if (penBtn) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: penBtn.x, y: penBtn.y })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: penBtn.x, y: penBtn.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: penBtn.x, y: penBtn.y, button: 'left', clickCount: 1 })
    await sleep(60)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: penBtn.x, y: penBtn.y, button: 'left', clickCount: 2 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: penBtn.x, y: penBtn.y, button: 'left', clickCount: 2 })
    await sleep(700)
    const afterReal = await ev(cdp, `(() => { const p = document.querySelector('.pen-popover'); if (!p) return 'closed'; const r = p.getBoundingClientRect(); return r.width > 0 ? 'open' : 'zero-size' })()`)
    console.log('  real double-click →', afterReal)
    check('真实双击后设置面板仍打开', afterReal === 'open', String(afterReal))
    if (afterReal !== 'open') {
      // 记录现场，便于定位（例如第二次点击落到遮罩上把面板关掉了）
      const trace = await ev(cdp, `(() => {
        const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith('画笔'));
        const r = b.getBoundingClientRect();
        const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        return { hit: el ? String(el.className || el.tagName) : null, hasBackdrop: Boolean(document.querySelector('.popover-backdrop')) };
      })()`)
      console.log('  现场:', JSON.stringify(trace))
    }
    await ev(cdp, `(() => { const b = document.querySelector('.popover-backdrop'); b && b.click(); return true })()`)
    await sleep(300)
  }

  console.log('\n[1] 双击画笔 → 设置面板')
  await clickButtonByTitle(cdp, ['画笔'], { double: true })
  const penPopover = await ev(cdp, `(() => {
    const pop = document.querySelector('.pen-popover');
    if (!pop) return null;
    const r = pop.getBoundingClientRect();
    const cs = getComputedStyle(pop);
    return {
      w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left),
      zIndex: cs.zIndex, opts: { minWidth: cs.minWidth, width: cs.width },
      visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
      inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
      title: (pop.querySelector('.pop-title') || {}).textContent || '',
      segs: [...pop.querySelectorAll('.seg-btn')].map((b) => (b.textContent || '').trim()),
      swatches: pop.querySelectorAll('.swatch').length,
      customColor: Boolean(pop.querySelector('input[type="color"]')),
      ranges: [...pop.querySelectorAll('input[type="range"]')].map((r2) => ({ min: r2.min, max: r2.max, value: r2.value })),
      backdrop: Boolean(document.querySelector('.popover-backdrop')),
    };
  })()`)
  console.log('  pen popover:', JSON.stringify(penPopover))
  check('双击画笔可打开设置面板', Boolean(penPopover?.visible), JSON.stringify(penPopover))
  check('面板不超出窗口且层级正常', Boolean(penPopover?.inViewport) && Number(penPopover?.zIndex) >= 20, JSON.stringify({ inViewport: penPopover?.inViewport, z: penPopover?.zIndex }))
  check('包含颜色/自定义色/粗细', (penPopover?.swatches || 0) >= 5 && penPopover?.customColor === true && (penPopover?.ranges?.length || 0) >= 1, JSON.stringify(penPopover))
  check('画笔设置已不含图形类型（图形已独立成工具栏按钮）', (penPopover?.segs?.length || 0) === 0, JSON.stringify(penPopover?.segs))
  await shot(cdp, '40-pen-settings.png')

  console.log('\n[1b] 「连续点击两次」→ 打开设置；再点一次 → 收起；右键 / Esc 同样可用')
  const penPos = await ev(cdp, `(() => {
    const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith('画笔'));
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`)
  const realClick = async (x, y, clickCount = 1, waitMs = 320) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount })
    await sleep(waitMs)
  }
  const popState = () => ev(cdp, `(() => { const p = document.querySelector('.pen-popover'); if (!p) return 'closed'; return p.getBoundingClientRect().width > 0 ? 'open' : 'zero' })()`)
  await ev(cdp, `(() => { const b = document.querySelector('.popover-backdrop'); b && b.click(); return true })()`)
  await sleep(300)
  // 显式切到「选择文字」，保证画笔不是当前工具 → 第一次点击是「选中」
  await ev(cdp, `(() => { const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith('选择文字')); b && b.click(); return true })()`)
  await sleep(300)
  await realClick(penPos.x, penPos.y)
  const afterFirst = await popState()
  await realClick(penPos.x, penPos.y)
  const afterSecond = await popState()
  console.log('  第一次点击:', afterFirst, '第二次点击:', afterSecond)
  check('选中画笔时第一次点击不弹设置', afterFirst === 'closed', String(afterFirst))
  check('连续点击两次打开画笔设置', afterSecond === 'open', String(afterSecond))
  // 第三下要等过浏览器的双击判定窗口（~500ms）+ 350ms 保护窗口，否则会被当成双击的一部分
  await sleep(300)
  await realClick(penPos.x, penPos.y, 1, 800)
  const afterThird = await popState()
  check('再点一次收起设置', afterThird === 'closed', String(afterThird))
  // 右键
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: penPos.x, y: penPos.y, button: 'right', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: penPos.x, y: penPos.y, button: 'right', clickCount: 1 })
  await sleep(400)
  const afterRight = await popState()
  check('右键也可打开设置', afterRight === 'open', String(afterRight))
  // Esc 关闭
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(350)
  const afterEsc = await popState()
  check('Esc 关闭设置面板', afterEsc === 'closed', String(afterEsc))
  // 角标提示
  const dot = await ev(cdp, `document.querySelectorAll('.doc-toolbar .icon-btn.has-settings .tool-settings-dot').length`)
  check('有设置的工具有角标提示（画笔/图形/荧光笔/橡皮擦）', dot === 4, String(dot))

  console.log('\n[1c] 工具已选中时双击（真实鼠标）→ 设置面板必须仍然打开')
  // 用户实际最常用的手势：画笔已是当前工具，连点/双击打开设置。
  // 曾经的 bug：第一次点击弹出面板后遮罩层盖住按钮，第二次按下落在遮罩上 →
  // 浏览器不再向按钮派发 dblclick → 表现为「双击无法显示」。
  {
    await ev(cdp, `(() => { const b = document.querySelector('.popover-backdrop'); b && b.click(); return true })()`)
    await sleep(250)
    const pos = await ev(cdp, `(() => {
      const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith('画笔'));
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`)
    const clickAt = async (count) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: count })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: count })
    }
    await clickAt(1) // 先让画笔成为当前工具
    await sleep(300)
    await ev(cdp, `(() => { const b = document.querySelector('.popover-backdrop'); b && b.click(); return true })()`)
    await sleep(250)
    await clickAt(1) // 已选中状态下的第一下：打开面板
    await clickAt(2) // 第二下（双击）
    await sleep(500)
    const stillOpen = await ev(cdp, `(() => { const p = document.querySelector('.pen-popover:not(.shape-popover)'); return p && p.getBoundingClientRect().width > 0 ? 'open' : 'closed' })()`)
    console.log('  已选中工具时双击 →', stillOpen)
    check('已选中工具时双击仍能打开设置（不被遮罩吃掉）', stillOpen === 'open', String(stillOpen))
    const backdropPE = await ev(cdp, `(() => { const b = document.querySelector('.popover-backdrop'); return b ? getComputedStyle(b).pointerEvents : 'none-element' })()`)
    check('遮罩层不接收指针事件（pointer-events: none）', backdropPE === 'none', String(backdropPE))
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 720 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 720, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 700, y: 720, button: 'left', clickCount: 1 })
    await sleep(350)
    const closedOutside = await ev(cdp, `(() => { const p = document.querySelector('.pen-popover:not(.shape-popover)'); return p ? 'open' : 'closed' })()`)
    check('点击工具栏以外处可关闭设置', closedOutside === 'closed', String(closedOutside))
  }

  console.log('\n[1d] 四个工具（画笔/图形/荧光笔/橡皮擦）在「已选中」状态下双击都要能打开设置')
  for (const [label, titlePrefix, popSel, expectTitle] of [
    ['画笔', '画笔', '.pen-popover:not(.shape-popover):not(.eraser-popover)', '画笔设置'],
    ['图形', '图形', '.shape-popover', '图形设置'],
    ['荧光笔', '荧光笔', '.pen-popover:not(.shape-popover):not(.eraser-popover)', '荧光笔设置'],
    ['橡皮擦', '橡皮擦', '.eraser-popover', '橡皮擦设置'],
  ]) {
    await ev(cdp, `(() => { const b = document.querySelector('.popover-backdrop'); b && b.click(); return true })()`)
    await sleep(200)
    const p = await ev(cdp, `(() => {
      const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith(${JSON.stringify(titlePrefix)}));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`)
    if (!p) { check(`${label}：找到按钮`, false, 'button not found'); continue }
    const clickAt = async (count) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: count })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: count })
      await sleep(90)
    }
    await clickAt(1) // 选中工具
    await sleep(300)
    await ev(cdp, `(() => { const b = document.querySelector('.popover-backdrop'); b && b.click(); return true })()`)
    await sleep(200)
    // 已选中状态下快速双击
    await clickAt(1)
    await clickAt(2)
    await sleep(500)
    const state = await ev(cdp, `(() => { const el = document.querySelector('${popSel}'); if (!el) return 'closed'; const t = el.querySelector('.pop-title'); return (el.getBoundingClientRect().width > 0 ? 'open' : 'zero') + '|' + (t ? t.textContent : '') })()`)
    console.log(`  ${label} 双击 →`, state)
    check(`${label}：已选中时双击可打开设置`, String(state).startsWith('open') && String(state).includes(expectTitle), String(state))
  }
  // 设置面板里的控件必须真的可操作（拖动粗细滑块 / 点色板）
  await ev(cdp, `(() => { const b = document.querySelector('.popover-backdrop'); b && b.click(); return true })()`)
  await sleep(200)
  const adjust = await ev(cdp, `(async () => {
    const penBtn = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith('画笔'));
    const r = penBtn.getBoundingClientRect();
    penBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 3, clientY: r.top + 3 }));
    await new Promise((res) => setTimeout(res, 120));
    penBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 3, clientY: r.top + 3 }));
    await new Promise((res) => setTimeout(res, 350));
    const pop = document.querySelector('.pen-popover:not(.shape-popover):not(.eraser-popover)');
    if (!pop) return { error: 'popover missing' };
    const range = pop.querySelector('input[type="range"]');
    const swatches = pop.querySelectorAll('.swatch');
    const before = range.value;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(range, '7');
    range.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((res) => setTimeout(res, 150));
    swatches[3].click();
    await new Promise((res) => setTimeout(res, 150));
    const labelText = (pop.querySelector('.pop-label b') || {}).textContent || '';
    const activeSwatch = pop.querySelector('.swatch.active');
    return { before, after: range.value, labelText, activeSwatch: activeSwatch ? activeSwatch.getAttribute('title') : null, stillOpen: pop.getBoundingClientRect().width > 0, swatchCount: swatches.length };
  })()`, true)
  console.log('  面板控件:', JSON.stringify(adjust))
  check('双击打开后可直接拖动粗细、点选颜色（面板不被关掉）', adjust?.stillOpen === true && adjust?.after === '7' && adjust?.labelText === '7' && Boolean(adjust?.activeSwatch), JSON.stringify(adjust))

  console.log('\n[2] 设置生效：换颜色 + 换粗细 → 画出的墨迹应一致')
  // 先确保面板是关的（上一步可能留着打开状态）：Esc 关闭
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(300)
  // 用「再点一次」打开画笔设置
  await realClick(penPos.x, penPos.y)
  const openedForApply = await popState()
  check('可再次打开画笔设置', openedForApply === 'open', String(openedForApply))
  const applyRes = await ev(cdp, `(async () => {
    const pop = document.querySelector('.pen-popover');
    if (!pop) return 'no-popover';
    // 选第 3 个色板（避开默认红）
    const sw = pop.querySelectorAll('.swatch');
    sw[2].click();
    await new Promise((r) => setTimeout(r, 120));
    const range = pop.querySelector('input[type="range"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(range, '9');
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    return { color: getComputedStyle(sw[2]).backgroundColor, size: range.value, label: (pop.querySelector('.pop-label b') || {}).textContent || '' };
  })()`, true)
  console.log('  applied:', JSON.stringify(applyRes))
  // 关掉面板，开始画
  await ev(cdp, `(() => { const b = document.querySelector('.popover-backdrop'); b && b.click(); return true })()`)
  await sleep(400)
  await clearAll(cdp)
  const box = await ev(cdp, `(() => { const cv = document.querySelector('.annot-canvas'); const r = cv.getBoundingClientRect(); const sc = (() => { let n = cv.parentElement; while (n && n !== document.body) { const st = getComputedStyle(n); if (/(auto|scroll|overlay)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 4) return n; n = n.parentElement } return null })(); const sr = sc ? sc.getBoundingClientRect() : r; return { x: Math.round(r.left + 80), y: Math.round(sr.top + 240), vw: innerWidth, vh: innerHeight } })()`)
  const ink = await drawAndSample(cdp, box.x, box.y, 260)
  console.log('  ink:', JSON.stringify(ink))
  const expect = { r: 0x00, g: 0x7a, b: 0xff } // PEN_COLORS[2] = systemBlue #007aff
  check('画笔墨迹已生成', (ink?.n || 0) > 200, JSON.stringify(ink))
  check('墨迹颜色 = 面板所选颜色（systemBlue）', Math.abs(ink.r - expect.r) < 48 && Math.abs(ink.g - expect.g) < 48 && Math.abs(ink.b - expect.b) < 48, JSON.stringify({ ink, expect }))
  check('粗细生效（size=9 → 线宽≈9px）', Math.abs((ink?.cssThickness || 0) - 9) <= 3.5, JSON.stringify({ thickness: ink?.cssThickness }))

  console.log('\n[2b] 自定义颜色输入框可改色')
  await clearAll(cdp)
  await clickButtonByTitle(cdp, ['画笔'], { double: true })
  await ev(cdp, `(async () => {
    const inp = document.querySelector('.pen-popover input[type="color"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '#8e44ad');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    return true;
  })()`, true)
  await ev(cdp, `(() => { const b = document.querySelector('.popover-backdrop'); b && b.click(); return true })()`)
  await sleep(350)
  const customInk = await drawAndSample(cdp, box.x, box.y + 200, 200)
  console.log('  custom color ink:', JSON.stringify(customInk))
  check('自定义颜色生效（#8e44ad 紫）', (customInk?.n || 0) > 150 && Math.abs(customInk.r - 0x8e) < 48 && Math.abs(customInk.g - 0x44) < 48 && Math.abs(customInk.b - 0xad) < 48, JSON.stringify(customInk))

  console.log('\n[3] 双击荧光笔 → 颜色/粗细，落笔为半透明荧光')
  await clearAll(cdp)
  await clickButtonByTitle(cdp, ['荧光笔'], { double: true })
  const hlPop = await ev(cdp, `(() => { const p = document.querySelector('.pen-popover'); if (!p) return null; return { title: (p.querySelector('.pop-title') || {}).textContent, swatches: p.querySelectorAll('.swatch').length, ranges: p.querySelectorAll('input[type="range"]').length } })()`)
  console.log('  highlighter popover:', JSON.stringify(hlPop))
  check('双击荧光笔可打开设置面板', hlPop?.title === '荧光笔设置' && hlPop.swatches >= 5, JSON.stringify(hlPop))
  await ev(cdp, `(async () => {
    const p = document.querySelector('.pen-popover');
    const sw = p.querySelectorAll('.swatch');
    sw[3].click();
    const range = p.querySelector('input[type="range"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(range, '8');
    range.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    return true;
  })()`, true)
  await ev(cdp, `(() => { const b = document.querySelector('.popover-backdrop'); b && b.click(); return true })()`)
  await sleep(400)
  const hlInk = await drawAndSample(cdp, box.x, box.y + 120, 260)
  console.log('  highlighter ink:', JSON.stringify(hlInk))
  check('荧光笔墨迹已生成且明显更粗', (hlInk?.n || 0) > 300 && (hlInk?.cssThickness || 0) > 10, JSON.stringify(hlInk))

  console.log('\n[4] 双击橡皮擦 → 笔画橡皮/大小，可擦掉刚画的批注')
  await clickButtonByTitle(cdp, ['橡皮擦'], { double: true })
  const erPop = await ev(cdp, `(() => { const p = document.querySelector('.eraser-popover'); if (!p) return null; return { title: (p.querySelector('.pop-title') || {}).textContent, modes: [...p.querySelectorAll('.seg-btn')].map((b) => (b.textContent || '').trim()), ranges: [...p.querySelectorAll('input[type="range"]')].map((r) => ({ min: r.min, max: r.max, value: r.value })) } })()`)
  console.log('  eraser popover:', JSON.stringify(erPop))
  check('双击橡皮擦可打开设置面板', erPop?.title === '橡皮擦设置' && (erPop?.modes?.length || 0) === 2, JSON.stringify(erPop))
  // 预览不在弹层里了：改成屏幕中央的 .size-preview-hud（按下大小滑杆时出现，
  // 见 styles.css 里「擦除范围预览已移到 .size-preview-hud」那段）。所以这里改成
  // 真的按下滑杆、断言 HUD 出现，而不是找一个早已删掉的 .eraser-size-preview。
  check('含擦除方式/大小滑杆', erPop?.modes?.join('/') === '像素橡皮/笔画橡皮' && (erPop?.ranges?.length || 0) >= 1, JSON.stringify(erPop))
  {
    const rp = await ev(cdp, `(() => { const r = document.querySelector('.eraser-popover input[type="range"]'); if (!r) return null; const b = r.getBoundingClientRect(); return { x: Math.round(b.left + b.width/2), y: Math.round(b.top + b.height/2) } })()`)
    let hud = false
    if (rp) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rp.x, y: rp.y })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rp.x, y: rp.y, button: 'left', clickCount: 1 })
      await sleep(200)
      hud = Boolean(await ev(cdp, `(() => { const h = document.querySelector('.size-preview-hud'); if (!h) return false; return h.getBoundingClientRect().width > 0 })()`))
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rp.x, y: rp.y, button: 'left', clickCount: 1 })
      await sleep(150)
    }
    check('按下大小滑杆会出现屏幕中央的范围预览 HUD', hud)
  }
  const defaultActive = await ev(cdp, `(() => { const p = document.querySelector('.eraser-popover'); const a = p && p.querySelector('.seg-btn.active'); return a ? (a.textContent || '').trim() : 'none' })()`)
  console.log('  橡皮默认模式:', defaultActive)
  check('橡皮默认模式为「像素橡皮」', defaultActive === '像素橡皮', String(defaultActive))
  const strokeMode = await ev(cdp, `(async () => {
    const p = document.querySelector('.eraser-popover');
    p.querySelectorAll('.seg-btn')[1].click();
    const range = p.querySelector('input[type="range"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(range, '40');
    range.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    return { active: (p.querySelector('.seg-btn.active') || {}).textContent || '', size: range.value };
  })()`, true)
  console.log('  stroke eraser:', JSON.stringify(strokeMode))
  await ev(cdp, `(() => { const b = document.querySelector('.popover-backdrop'); b && b.click(); return true })()`)
  await sleep(400)
  const beforeErase = await ev(cdp, `(() => { const cv = document.querySelector('.annot-canvas'); const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 12) n++; return n })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x + 100, y: box.y + 120, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + 160, y: box.y + 120, button: 'left' })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 160, y: box.y + 120, button: 'left', clickCount: 1 })
  await sleep(800)
  const afterErase = await ev(cdp, `(() => { const cv = document.querySelector('.annot-canvas'); const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 12) n++; return n })()`)
  console.log('  ink pixels before/after erase:', beforeErase, afterErase)
  check('笔画橡皮可擦除批注', beforeErase > 0 && afterErase < beforeErase * 0.8, JSON.stringify({ beforeErase, afterErase }))
  await shot(cdp, '41-eraser-settings.png')

  const fatal = errors.filter((e) => !/ResizeObserver|favicon/i.test(e))
  check('全程无未捕获异常', fatal.length === 0, fatal.slice(0, 3).join(' | '))

  console.log(`\n结果: ${failures === 0 ? '全部通过' : failures + ' 项失败'}，截图见 tmp/hig-shots/`)
  cdp.close(); chrome.kill()
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error('verify-tools failed:', e); process.exit(2) })
