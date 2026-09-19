// perf-probe.mjs — 定位「打开文件 / 画笔极其卡顿」的真实瓶颈
// 度量：Performance.getMetrics 增量（Task/Script/Layout/RecalcStyle）+ rAF 帧间隔 + 笔画总耗时；
// 变量：devicePixelRatio、目标文件、预置批注数量、A/B 关闭毛玻璃/阴影/图层提升。
// 用法: node tools/perf-probe.mjs [--file=NAME] [--dpr=2] [--seed=50] [--ab] [--chrome=PATH]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]
}))
const CHROME = argv.chrome || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const FILE = argv.file || 'test-complex.pdf'
const DPR = Number(argv.dpr || 1)
const SEED = Number(argv.seed || 0)
const DO_AB = Boolean(argv.ab)
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5199/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

async function metrics(cdp) {
  const { metrics: list } = await cdp.send('Performance.getMetrics')
  const m = {}
  for (const x of list) m[x.name] = x.value
  return m
}
const KEYS = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount']
const diff = (a, b) => Object.fromEntries(KEYS.map((k) => [k, Math.round(((b[k] || 0) - (a[k] || 0)) * 1000) / 1000]))

// 画布微观基准：把「旧实现每帧做的全幅 clearRect」与「新实现的局部清理/绘制」分开计时
async function canvasBench(cdp) {
  return ev(cdp, `(() => {
    const el = document.querySelector('.annot-canvas');
    if (!el || el.width < 200) return { error: 'canvas not sized', w: el && el.width, h: el && el.height };
    const ctx = el.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const time = (fn, n) => { const t0 = performance.now(); for (let i = 0; i < n; i++) fn(); return Math.round(((performance.now() - t0) / n) * 1000) / 1000 };
    const fullClear = time(() => { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, el.width, el.height) }, 5);
    const localClear = time(() => { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(100, 100, 260, 260) }, 50);
    const localStroke = time(() => { ctx.beginPath(); ctx.moveTo(100, 100); ctx.lineTo(360, 360); ctx.stroke() }, 50);
    const layoutRead = time(() => el.getBoundingClientRect(), 50);
    return { w: el.width, h: el.height, megapixels: Math.round((el.width * el.height) / 1e6 * 10) / 10, fullClearMs: fullClear, localClearMs: localClear, localStrokeMs: localStroke, layoutReadMs: layoutRead };
  })()`)
}

async function dispatch(cdp, type, x, y, extra = {}) {
  await cdp.send('Input.dispatchMouseEvent', { type, x, y, ...extra })
}

async function drawStroke(cdp, n, box, startFrac = 0.15, pauseMs = 500) {
  await ev(cdp, `(() => {
    window.__perf = { frames: [], raf: 0 };
    let last = performance.now();
    const tick = (t) => { window.__perf.frames.push(t - last); last = t; window.__perf.raf = requestAnimationFrame(tick) };
    window.__perf.raf = requestAnimationFrame(tick);
    return true;
  })()`)
  // 坐标必须落在视口内：长文档的画布 rect 可能整体在视口之外（否则事件静默失效，测出来是假数据）
  const vx0 = Math.max(box.x, 0), vy0 = Math.max(box.y, 0)
  const vx1 = Math.min(box.x + box.w, box.vw || 1440), vy1 = Math.min(box.y + box.h, (box.vh || 900) - 4)
  const vw = Math.max(1, vx1 - vx0), vh = Math.max(1, vy1 - vy0)
  const x0 = vx0 + vw * startFrac, y0 = vy0 + vh * 0.25
  const x1 = vx0 + vw * Math.min(0.95, startFrac + 0.3), y1 = vy0 + vh * 0.6
  const t0 = Date.now()
  await dispatch(cdp, 'mouseMoved', x0, y0)
  await dispatch(cdp, 'mousePressed', x0, y0, { button: 'left', clickCount: 1 })
  for (let i = 1; i <= n; i++) {
    const t = i / n
    await dispatch(cdp, 'mouseMoved', x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + Math.sin(t * 12) * box.h * 0.03, { button: 'left' })
  }
  await dispatch(cdp, 'mouseReleased', x1, y1, { button: 'left', clickCount: 1 })
  const wall = Date.now() - t0
  await sleep(pauseMs)
  const frames = await ev(cdp, `(() => { cancelAnimationFrame(window.__perf.raf); const f = window.__perf.frames.slice(1).sort((a,b)=>a-b); return { n: f.length, p50: Math.round(f[Math.floor(f.length*0.5)]||0), p95: Math.round(f[Math.floor(f.length*0.95)]||0), max: Math.round(f[f.length-1]||0) } })()`)
  return { wall, frames, perMove: Math.round(((wall / n) * 100)) / 100 }
}

// 单帧重绘成本：按住笔在小范围抖动，每个 move 都会触发一次 paint（脏矩形重绘）
async function runPaintCost(cdp, box, n = 48) {
  const m0 = await metrics(cdp)
  const x = Math.max(box.x, 0) + Math.min(box.w, (box.vw || 1440) - Math.max(box.x, 0)) * 0.55
  const y = Math.max(box.y, 0) + Math.min(box.h, (box.vh || 900) - Math.max(box.y, 0)) * 0.8
  await dispatch(cdp, 'mouseMoved', x, y)
  await dispatch(cdp, 'mousePressed', x, y, { button: 'left', clickCount: 1 })
  const t0 = Date.now()
  for (let i = 0; i < n; i++) await dispatch(cdp, 'mouseMoved', x + (i % 3) * 0.6, y + (i % 2) * 0.6, { button: 'left' })
  await dispatch(cdp, 'mouseReleased', x, y, { button: 'left', clickCount: 1 })
  const wall = Date.now() - t0
  const m1 = await metrics(cdp)
  await sleep(300)
  const d = diff(m0, m1)
  return {
    moves: n,
    wall,
    perFrameTaskMs: Math.round((d.TaskDuration * 1000 * 100) / n) / 100,
    perFrameScriptMs: Math.round((d.ScriptDuration * 1000 * 100) / n) / 100,
    layoutCount: d.LayoutCount,
    totalTaskMs: Math.round(d.TaskDuration * 1000),
  }
}

async function openFixture(cdp, file) {
  // 夹具优先取 public/（dev 服务可直接访问），否则取 tmp/（大文件不进入构建产物）
  const resolved = [path.join(ROOT, 'public', file), path.join(ROOT, 'tmp', file), file].find((p) => fs.existsSync(p))
  if (!resolved) throw new Error('fixture not found: ' + file)
  const b64 = fs.readFileSync(resolved).toString('base64')
  await ev(cdp, `(() => {
    const bytes = Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0));
    const f = new File([bytes], '${file}', { lastModified: Date.now() });
    const handle = { kind: 'file', name: '${file}', getFile: async () => f,
      queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      createWritable: async () => ({ write: async () => {}, close: async () => {}, seek: async () => {}, truncate: async () => {}, getPosition: async () => 0 }) };
    window.showOpenFilePicker = async () => [handle];
    return 'ok';
  })()`)
  const t0 = Date.now()
  await ev(cdp, `(async () => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '打开文件'); if (!b) return false; b.click(); return true })()`, true)
  let ready = false
  for (let i = 0; i < 80; i++) {
    ready = await ev(cdp, `(() => { const cv = document.querySelector('.pdf-canvas'); return Boolean(cv && cv.width > 100) })()`)
    if (ready) break
    await sleep(250)
  }
  const openMs = Date.now() - t0
  const info = await ev(cdp, `(() => ({
    canvases: document.querySelectorAll('.pdf-canvas').length,
    pages: document.querySelectorAll('.pdf-page').length,
    thumbs: document.querySelectorAll('.pdf-thumbs canvas, .thumb-canvas, .pdf-thumb canvas').length,
    annot: document.querySelectorAll('.annot-canvas').length,
    tabs: document.querySelectorAll('.tab').length,
    loading: (document.querySelector('.loading, .file-error') || {}).textContent || '',
  }))()`)
  return { openMs, ready, info }
}

async function setStyle(cdp, css, id) {
  await ev(cdp, `(() => { let s = document.getElementById('${id}'); if (!s) { s = document.createElement('style'); s.id = '${id}'; document.head.appendChild(s) } s.textContent = ${JSON.stringify(css)}; return true })()`)
  await sleep(250)
}

// 滚动性能：长文档滚动时毛玻璃（backdrop-filter）会随背景变化逐帧重算，
// 这是「打开/阅读很卡」的典型来源，这里做 A/B 定量。
async function measureScroll(cdp, steps = 60, dy = 140) {
  const target = await ev(cdp, `(() => {
    const el = document.querySelector('.pdf-viewer') || document.querySelector('.pdf-scroll');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), h: Math.round(r.height) };
  })()`)
  if (!target) return { error: 'no scroller' }
  await ev(cdp, `(() => {
    window.__perf = { frames: [], raf: 0, long: [] };
    let last = performance.now();
    const tick = (t) => { window.__perf.frames.push(t - last); last = t; window.__perf.raf = requestAnimationFrame(tick) };
    window.__perf.raf = requestAnimationFrame(tick);
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__perf.long.push(Math.round(e.duration)) }).observe({ entryTypes: ['longtask'] });
    } catch {}
    return true;
  })()`)
  const m0 = await metrics(cdp)
  const t0 = Date.now()
  for (let i = 0; i < steps; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: target.cx, y: target.cy, deltaX: 0, deltaY: dy })
    await sleep(16)
  }
  const wall = Date.now() - t0
  const m1 = await metrics(cdp)
  await sleep(300)
  const frames = await ev(cdp, `(() => { cancelAnimationFrame(window.__perf.raf); const f = window.__perf.frames.slice(1).sort((a,b)=>a-b); return { n: f.length, p50: Math.round(f[Math.floor(f.length*0.5)]||0), p95: Math.round(f[Math.floor(f.length*0.95)]||0), max: Math.round(f[f.length-1]||0), longtasks: window.__perf.long.slice(0, 8), longCount: window.__perf.long.length } })()`)
  const d = diff(m0, m1)
  return { wall, steps, frames, taskMs: Math.round(d.TaskDuration * 1000), scriptMs: Math.round(d.ScriptDuration * 1000), layoutMs: Math.round(d.LayoutDuration * 1000), layoutCount: d.LayoutCount }
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-'))
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9241', '--user-data-dir=' + userData,
    '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })
  let targets = []
  for (let i = 0; i < 60; i++) { try { targets = await (await fetch('http://127.0.0.1:9241/json/list')).json(); if (targets.length) break } catch {} await sleep(250) }
  const cdp = new CDP((targets.find((t) => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Performance.enable')
  const errors = []
  cdp.ws.addEventListener('message', (e) => {
    try {
      const m = JSON.parse(e.data)
      if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || '').slice(0, 160))
      if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') errors.push('console: ' + (m.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 160))
    } catch {}
  })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: DPR, mobile: false })
  await cdp.send('Page.navigate', { url: APP_URL })
  await sleep(2500)

  console.log(`\n=== file=${FILE} dpr=${DPR} seed=${SEED} ===`)
  const opened = await openFixture(cdp, FILE)
  console.log(`  打开: ${opened.openMs} ms  ready=${opened.ready}`, JSON.stringify(opened.info))
  if (errors.length) console.log('  页面错误:', errors.slice(0, 3).join(' | '))

  const box = await ev(cdp, `(() => { const el = document.querySelector('.annot-canvas'); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, bw: el.width, bh: el.height } })()`)
  if (!box) { console.log('  未找到 .annot-canvas，终止'); fs.writeFileSync(path.join(ROOT, 'tmp', 'perf-report.json'), JSON.stringify({ FILE, DPR, SEED, opened, errors }, null, 2)); cdp.close(); chrome.kill(); process.exit(0) }
  console.log(`  画布: css=${Math.round(box.w)}x${Math.round(box.h)} backing=${box.bw}x${box.bh}`)

  await ev(cdp, `(async () => { const b = [...document.querySelectorAll('.doc-toolbar .icon-btn')].find((x) => (x.getAttribute('title') || '').startsWith('画笔')); b && b.click(); await new Promise(r=>setTimeout(r,300)); return true })()`, true)

  const scrolls = []
  if (argv.scroll) {
    // 先热身：把整篇滚一遍让惰性渲染的页面位图全部生成并缓存，
    // 否则「第一次滚动」会混入页面栅格化成本，A/B 结果会被顺序污染。
    console.log('  滚动预热（生成全部页位图）…')
    const warm0 = Date.now()
    await measureScroll(cdp, 90, 260)
    await measureScroll(cdp, 90, -260)
    await ev(cdp, `(() => { const el = document.querySelector('.pdf-scroll'); if (el) el.scrollTop = 0; return true })()`)
    await sleep(1800)
    console.log(`  预热完成 ${Date.now() - warm0} ms`)

    const line = (s) => `rAF p50=${s.frames?.p50} p95=${s.frames?.p95} max=${s.frames?.max} long=${s.frames?.longCount} Task=${s.taskMs}ms Script=${s.scriptMs}ms Layout=${s.layoutMs}ms(${s.layoutCount})`
    const variants = [
      ['A 基线', ''],
      ['B 全部去毛玻璃', '*{backdrop-filter:none !important;-webkit-backdrop-filter:none !important}'],
      ['C 基线（重复，校验噪声）', ''],
      ['D 全部去毛玻璃（重复）', '*{backdrop-filter:none !important;-webkit-backdrop-filter:none !important}'],
    ]
    for (const [label, css] of variants) {
      await setStyle(cdp, css, 'perf-noblur')
      const s = await measureScroll(cdp)
      scrolls.push({ label, ...s })
      console.log(`  [滚动 ${label}] ${s.wall}ms/60 步  ${line(s)}`)
    }    await setStyle(cdp, '', 'perf-noblur')
  }

  // 审计：当前页面上还带着 backdrop-filter 的元素（用于确认性能开关是否命中）
  const blurs = await ev(cdp, `(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const bf = cs.backdropFilter || cs.webkitBackdropFilter;
      if (bf && bf !== 'none') {
        const r = el.getBoundingClientRect();
        out.push({ cls: String(el.className || el.tagName).slice(0, 42), bf, area: Math.round(r.width * r.height) });
      }
    }
    return out.slice(0, 20);
  })()`)
  console.log('  毛玻璃元素:', JSON.stringify(blurs))

  const runs = []
  async function run(label, n = 120) {
    const m0 = await metrics(cdp)
    const res = await drawStroke(cdp, n, box, 0.1 + (runs.length % 4) * 0.18)
    const m1 = await metrics(cdp)
    const d = diff(m0, m1)
    runs.push({ label, n, ...res, metrics: d })
    console.log(`  [${label}] ${n} 点: 总 ${res.wall} ms (${res.perMove} ms/点)  rAF p50=${res.frames.p50} p95=${res.frames.p95} max=${res.frames.max} 帧数=${res.frames.n}`)
    console.log(`      主线程: Task=${Math.round(d.TaskDuration * 1000)}ms Script=${Math.round(d.ScriptDuration * 1000)}ms Layout=${Math.round(d.LayoutDuration * 1000)}ms Recalc=${Math.round(d.RecalcStyleDuration * 1000)}ms`)
    return res
  }

  // 预置批注：连续画 seed 条短笔画（无停顿）
  const paintCosts = []
  const bench = await canvasBench(cdp)
  console.log('  画布基准:', JSON.stringify(bench))
  const pc0 = await runPaintCost(cdp, box)
  paintCosts.push({ phase: '0 条批注', ...pc0 })
  console.log(`  单帧重绘成本（0 条批注）: Task ${pc0.perFrameTaskMs} ms/帧  Script ${pc0.perFrameScriptMs} ms/帧  LayoutCount=${pc0.layoutCount}`)

  if (SEED > 0) {
    console.log(`  预置 ${SEED} 条批注…`)
    const t0 = Date.now()
    for (let i = 0; i < SEED; i++) await drawStroke(cdp, 12, box, 0.05 + (i % 8) * 0.1, 0)
    console.log(`  预置完成 ${Date.now() - t0} ms，工具条文本:`, await ev(cdp, `(document.querySelector('.doc-toolbar') || {}).textContent || ''`))
    const pc1 = await runPaintCost(cdp, box)
    paintCosts.push({ phase: `${SEED} 条批注`, ...pc1 })
    console.log(`  单帧重绘成本（${SEED} 条批注）: Task ${pc1.perFrameTaskMs} ms/帧  Script ${pc1.perFrameScriptMs} ms/帧  LayoutCount=${pc1.layoutCount}`)
  }

  await run('基线', 120)
  if (DO_AB) {
    await setStyle(cdp, '*{backdrop-filter:none !important;-webkit-backdrop-filter:none !important}', 'perf-noblur')
    await run('关毛玻璃', 120)
    await setStyle(cdp, '*{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;box-shadow:none !important;filter:none !important}', 'perf-noshadow')
    await run('关毛玻璃+阴影', 120)
    await setStyle(cdp, '.annot-canvas{will-change:transform;contain:paint}', 'perf-promote')
    await run('画布图层提升', 120)
  }
  const stats = await ev(cdp, `(() => { const s = window.__annStats || null; return s })()`)
  const out = { FILE, DPR, SEED, opened, box, bench, scrolls, paintCosts, runs, stats, errors: errors.slice(0, 6) }
  fs.writeFileSync(path.join(ROOT, 'tmp', `perf-report-${FILE.replace(/\W+/g, '_')}-dpr${DPR}-seed${SEED}.json`), JSON.stringify(out, null, 2))
  console.log('\n报告已写入 tmp/perf-report-*.json')
  cdp.close(); chrome.kill()
}

main().catch((e) => { console.error('perf-probe failed:', e); process.exit(2) })
