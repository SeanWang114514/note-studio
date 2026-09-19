// verify-band.mjs — 验收「视口条带批注画布」的正确性与收益
// 1) 画布后备缓冲只覆盖视口条带（长文档不再分配几百 MB）
// 2) 落笔位置精确：画在屏幕某点 → 画布墨迹能换算回同一屏幕点
// 3) 文档锚定：条带内滚动时墨迹随内容移动（不是钉在屏幕上）
// 4) 条带外滚动后墨迹正确消失/回滚复现
// 用法: node tools/verify-band.mjs [fixture] [chromePath]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const FILE = process.argv[2] || 'long-45p.pdf'
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

// 画布上墨迹（非透明像素）的包围盒，单位：画布设备像素
const inkExpr = `(() => {
  const cv = document.querySelector('.annot-canvas');
  if (!cv) return null;
  const ctx = cv.getContext('2d');
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, n = 0;
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      if (d[(y * cv.width + x) * 4 + 3] > 8) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
    }
  }
  return n ? { n, minX, minY, maxX, maxY, w: cv.width, h: cv.height } : { n: 0, w: cv.width, h: cv.height };
})()`

const overlayInfoExpr = `(() => {
  const cv = document.querySelector('.annot-canvas');
  if (!cv) return null;
  const box = cv.parentElement;
  const sc = (() => { let n = cv.parentElement; while (n && n !== document.body) { const st = getComputedStyle(n); if (/(auto|scroll|overlay)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 4) return n; n = n.parentElement } return null })();
  const r = cv.getBoundingClientRect();
  const br = box.getBoundingClientRect();
  const sr = sc ? sc.getBoundingClientRect() : { top: 0, height: innerHeight };
  return {
    canvasPx: { w: cv.width, h: cv.height },
    canvasCss: { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) },
    bandTop: Math.round(r.top - br.top),
    docH: box.clientHeight, docW: box.clientWidth,
    scrollTop: sc ? Math.round(sc.scrollTop) : 0,
    scrollerTop: Math.round(sr.top), scrollerH: Math.round(sr.height),
    hasScroller: Boolean(sc),
  };
})()`

async function main() {
  let alive = false
  for (let i = 0; i < 8; i++) {
    try { const r = await fetch(APP_URL, { signal: AbortSignal.timeout(2500) }); if (r.status < 500) { alive = true; break } } catch {}
    await sleep(800)
  }
  if (!alive) { console.error('dev 服务未启动: ' + APP_URL); process.exit(1) }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'band-'))
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9245', '--user-data-dir=' + userData,
    '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })
  let targets = []
  for (let i = 0; i < 60; i++) { try { targets = await (await fetch('http://127.0.0.1:9245/json/list')).json(); if (targets.length) break } catch {} await sleep(250) }
  const cdp = new CDP((targets.find((t) => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  const errors = []
  cdp.ws.addEventListener('message', (e) => {
    try { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params?.exceptionDetails?.exception?.description || '').slice(0, 160)) } catch {}
  })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false })
  await cdp.send('Page.navigate', { url: APP_URL })
  await waitFor(cdp, `document.querySelectorAll('.nav-item').length`)
  await sleep(1000)

  const resolved = [path.join(ROOT, 'public', FILE), path.join(ROOT, 'tmp', FILE)].find((p) => fs.existsSync(p))
  if (!resolved) { console.error('fixture not found: ' + FILE); process.exit(1) }
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
  await waitFor(cdp, `document.querySelectorAll('.pdf-canvas').length`, 30000)
  await sleep(1500)

  console.log(`\n[1] 条带画布尺寸（${FILE}，dpr2）`)
  const info0 = await ev(cdp, overlayInfoExpr)
  console.log('  overlay:', JSON.stringify(info0))
  const mp = info0 ? (info0.canvasPx.w * info0.canvasPx.h) / 1e6 : 0
  check('存在滚动容器', Boolean(info0?.hasScroller), JSON.stringify(info0))
  check('画布只覆盖视口条带（≤12MP，而非整篇文档）', mp > 0 && mp <= 12, `mp=${mp.toFixed(1)} doc ${info0?.docW}x${info0?.docH}`)
  check('画布高度接近视口高度（不是整篇高度）', info0 && info0.canvasCss.h < info0.scrollerH * 3, JSON.stringify(info0?.canvasCss))

  console.log('\n[2] 落笔位置精度：画在屏幕某点 → 墨迹能换算回同一屏幕点')
  await ev(cdp, `(async () => { const b = [...document.querySelectorAll('.doc-toolbar .icon-btn')].find((x) => (x.getAttribute('title') || '').startsWith('画笔')); b && b.click(); await new Promise(r => setTimeout(r, 400)); return true })()`, true)
  const px = 720
  const py = 470
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px - 60, y: py })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px - 60, y: py, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 24; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px - 60 + i * 5, y: py + Math.sin(i / 4) * 6, button: 'left' })
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px + 60, y: py, button: 'left', clickCount: 1 })
  await sleep(900)
  const info1 = await ev(cdp, overlayInfoExpr)
  const ink1 = await ev(cdp, inkExpr)
  const dpr = 2
  // 屏幕坐标 = 滚动容器顶部 + (画布设备像素 → 条带内 CSS 像素) - 当前滚动量
  const inkViewportOf = (info, ink) => (ink && ink.n && info ? {
    x: info.canvasCss.left + ink.minX / dpr,
    y: info.scrollerTop + (ink.minY / dpr - info.bandTop) - info.scrollTop,
    x2: info.canvasCss.left + ink.maxX / dpr,
    y2: info.scrollerTop + (ink.maxY / dpr - info.bandTop) - info.scrollTop,
  } : null)
  const inkViewport = inkViewportOf(info1, ink1)
  console.log('  ink:', JSON.stringify(ink1), '→ viewport', JSON.stringify(inkViewport))
  check('落笔后画布出现墨迹', (ink1?.n || 0) > 40, JSON.stringify(ink1))
  check(
    '墨迹落在屏幕落笔点附近（±14px）',
    Boolean(inkViewport) && Math.abs(inkViewport.x - (px - 60)) <= 14 && Math.abs(inkViewport.y - py) <= 14,
    JSON.stringify({ inkViewport, expected: { x: px - 60, y: py } }),
  )
  await shot(cdp, '30-band-stroke.png')

  console.log('\n[3] 条带内滚动：墨迹应随内容移动（文档锚定）')
  const dy = 200
  await ev(cdp, `(() => { const cv = document.querySelector('.annot-canvas'); let n = cv.parentElement; while (n && n !== document.body) { const st = getComputedStyle(n); if (/(auto|scroll|overlay)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 4) { n.scrollTop += ${dy}; return true } n = n.parentElement } return false })()`)
  await sleep(900)
  const info2 = await ev(cdp, overlayInfoExpr)
  const ink2 = await ev(cdp, inkExpr)
  const ink2Viewport = inkViewportOf(info2, ink2)
  console.log('  after scroll dy=' + dy + ':', JSON.stringify({ bandTop: info2.bandTop, scrollTop: info2.scrollTop, inkY: ink2Viewport?.y, ink: ink2?.n }))
  check(
    '滚动后墨迹跟着内容上移（位移≈滚动量）',
    Boolean(ink2Viewport) && Math.abs((inkViewport.y - ink2Viewport.y) - (info2.scrollTop - info1.scrollTop)) <= 8,
    JSON.stringify({ before: inkViewport?.y, after: ink2Viewport?.y, scrolled: info2.scrollTop - info1.scrollTop }),
  )

  console.log('\n[4] 滚出条带再滚回：墨迹应消失后原样复现')
  const scrollTo = async (top) => {
    await ev(cdp, `(() => { const cv = document.querySelector('.annot-canvas'); let n = cv.parentElement; while (n && n !== document.body) { const st = getComputedStyle(n); if (/(auto|scroll|overlay)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 4) { n.scrollTop = ${top}; return true } n = n.parentElement } return false })()`)
    await sleep(1000)
    const info = await ev(cdp, overlayInfoExpr)
    const ink = await ev(cdp, inkExpr)
    return { info, ink }
  }
  const s3 = await scrollTo(6000)
  console.log('  scrollTop=6000:', JSON.stringify({ bandTop: s3.info.bandTop, bandH: s3.info.canvasCss.h, scrollTop: s3.info.scrollTop, ink: s3.ink.n }))
  check('滚出条带后条带位置已更新', s3.info.scrollTop > 5000 && s3.info.bandTop > 3000, JSON.stringify({ bandTop: s3.info.bandTop, scrollTop: s3.info.scrollTop }))
  check('条带外的墨迹不再绘制（画布已换区域）', (s3.ink?.n || 0) === 0, JSON.stringify(s3.ink))

  // 页码指示器：从 scrollTop 纯计算得出，滚动时应跟随（不再逐页读布局）
  const pageLabel = await ev(cdp, `(() => { const el = document.querySelector('.pdf-page-controls .pdf-page-label'); return el ? (el.textContent || '').trim() : null })()`)
  const pageNum = Number((pageLabel || '').split('/')[0].trim())
  console.log('  页码指示器:', pageLabel)
  check('滚动后页码指示器跟随（6000px ≈ 第 5-9 页）', pageNum >= 4 && pageNum <= 10, String(pageLabel))

  // 点击缩略图跳页
  const jumped = await ev(cdp, `(async () => {
    const items = [...document.querySelectorAll('.pdf-thumb-item')];
    if (items.length < 12) return 'too-few-thumbs:' + items.length;
    items[11].click();
    await new Promise((r) => setTimeout(r, 1200));
    const el = document.querySelector('.pdf-page-controls .pdf-page-label');
    return el ? (el.textContent || '').trim() : 'no-label';
  })()`, true)
  console.log('  点击第 12 个缩略图后:', jumped)
  check('点击缩略图可跳页且指示器更新', String(jumped).startsWith('12'), String(jumped))

  const s4 = await scrollTo(0)
  const ink4Viewport = inkViewportOf(s4.info, s4.ink)
  console.log('  回到顶部 ink:', JSON.stringify(s4.ink), '→', JSON.stringify(ink4Viewport))
  check(
    '滚回顶部后墨迹在原位置复现（±14px）',
    Boolean(ink4Viewport) && Math.abs(ink4Viewport.x - (px - 60)) <= 14 && Math.abs(ink4Viewport.y - py) <= 14,
    JSON.stringify({ ink4Viewport, expected: { x: px - 60, y: py } }),
  )
  await shot(cdp, '31-band-after-scroll.png')

  const fatal = errors.filter((e) => !/ResizeObserver|favicon/i.test(e))
  check('全程无未捕获异常', fatal.length === 0, fatal.slice(0, 3).join(' | '))

  console.log(`\n结果: ${failures === 0 ? '全部通过' : failures + ' 项失败'}，截图见 tmp/hig-shots/`)
  cdp.close(); chrome.kill()
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error('verify-band failed:', e); process.exit(2) })
