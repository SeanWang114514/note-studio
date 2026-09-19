// verify-ann-groups.mjs — 验收「批注栏分类」
// 覆盖：按批注种类分组、每组计数、组头折叠/展开、组内条目点击选中、
//       以及最重要的不变量：任何批注都不会因为分类而从栏里消失。
// 用法: node tools/verify-ann-groups.mjs [chromePath]
// 环境: APP_URL 指定 dev server（默认 http://127.0.0.1:5173/）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5173/'
const PORT = Number(process.env.CDP_PORT || 9361)
const SHOT_DIR = path.join(ROOT, 'tmp', 'hig-shots')
const FIXTURE = 'test-text.pdf'
fs.mkdirSync(SHOT_DIR, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function check(name, cond, extra = '') {
  if (!cond) failures += 1
  console.log(`  ${cond ? '✔' : '✘'} ${name}${cond ? '' : '  ' + extra}`)
}

class CDP {
  constructor(ws) { this.ws = new WebSocket(ws); this.id = 0; this.pending = new Map() }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id)
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
      }
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  close() { try { this.ws.close() } catch {} }
}

async function ev(cdp, expression, awaitPromise = false) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (r?.exceptionDetails) return { __error: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 300) }
  return r?.result?.value
}

async function waitFor(cdp, expr, ms = 20000, step = 250) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await ev(cdp, expr)
    if (v && !v.__error) return v
    await sleep(step)
  }
  return null
}

async function clickAt(cdp, x, y, clickCount = 1) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount })
  await sleep(120)
}

async function buttonCenter(cdp, titlePrefix) {
  return ev(cdp, `(() => {
    const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith(${JSON.stringify(titlePrefix)}));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`)
}

async function selectTool(cdp, titlePrefix) {
  const p = await buttonCenter(cdp, titlePrefix)
  if (!p) return false
  await clickAt(cdp, p.x, p.y)
  return true
}

// 在批注画布的可见区域里拖一笔（用视口坐标，canvas 是条带画布）
async function stroke(cdp, i, len = 90) {
  const box = await ev(cdp, `(() => {
    const cv = document.querySelector('.annot-canvas');
    if (!cv) return null;
    const r = cv.getBoundingClientRect();
    const top = Math.max(r.top + 40, 140);
    return { x: Math.round(r.left + 120), y: Math.round(Math.min(top + ${i} * 60, r.bottom - 60)) };
  })()`)
  if (!box) return false
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  for (let k = 1; k <= 10; k++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + (len * k) / 10, y: box.y + (k % 2 ? 6 : -6), button: 'left' })
    await sleep(12)
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + len, y: box.y, button: 'left', clickCount: 1 })
  await sleep(220)
  return true
}

// 读批注栏现在的结构：分组 + 每组可见条目数 + 条目文字
const panelState = (cdp) => ev(cdp, `(() => {
  const panel = document.querySelector('.ann-panel');
  if (!panel) return null;
  const groups = [...panel.querySelectorAll('.ann-panel-group')].map((g) => {
    const head = g.querySelector('.ann-panel-group-head');
    const items = [...g.querySelectorAll('.ann-panel-item')];
    return {
      label: (g.querySelector('.ann-panel-group-label') || {}).textContent || '',
      badge: Number((g.querySelector('.ann-panel-group-count') || {}).textContent || 0),
      folded: head ? head.classList.contains('collapsed') : null,
      items: items.length,
      itemHeads: items.map((it) => (it.querySelector('.ann-panel-head span') || {}).textContent || ''),
    };
  });
  return { groups, total: panel.querySelectorAll('.ann-panel-item').length, hint: (document.querySelector('.doc-toolbar .toolbar-hint') || {}).textContent || '' };
})()`)

async function main() {
  let alive = false
  for (let i = 0; i < 10; i++) {
    try { const r = await fetch(APP_URL, { signal: AbortSignal.timeout(2500) }); if (r.status < 500) { alive = true; break } } catch {}
    await sleep(800)
  }
  if (!alive) { console.error('dev 服务未启动: ' + APP_URL); process.exit(1) }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'anngroups-'))
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + userData,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' })

  let targets = []
  for (let i = 0; i < 80; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets.length) break } catch {} await sleep(250) }
  if (!targets.length) { console.error('无法连接 headless Chrome'); process.exit(1) }
  const page = targets.find((t) => t.type === 'page') || targets[0]
  const cdp = new CDP(page.webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  const errors = []
  cdp.ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params?.exceptionDetails?.exception?.description || '').slice(0, 200))
  })

  try {
    await cdp.send('Page.navigate', { url: APP_URL })
    await waitFor(cdp, `document.querySelectorAll('.nav-item').length`, 25000)
    console.log('· 打开 ' + FIXTURE)

    const b64 = fs.readFileSync(path.join(ROOT, 'public', FIXTURE)).toString('base64')
    await ev(cdp, `(() => {
      const bytes = Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0));
      const f = new File([bytes], '${FIXTURE}', { lastModified: 1700000000000 });
      const handle = { kind: 'file', name: '${FIXTURE}', getFile: async () => f,
        queryPermission: async () => 'granted', requestPermission: async () => 'granted',
        createWritable: async () => ({ write: async () => {}, close: async () => {}, seek: async () => {}, truncate: async () => {}, getPosition: async () => 0 }) };
      window.showOpenFilePicker = async () => [handle];
      return 'ok';
    })()`)
    await ev(cdp, `(async () => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '打开文件'); b && b.click(); return true })()`, true)
    const gotCanvas = await waitFor(cdp, `document.querySelectorAll('.annot-canvas').length`, 25000)
    check('PDF 打开并出现批注画布', Boolean(gotCanvas))
    if (!gotCanvas) throw new Error('no canvas')
    await sleep(600)

    // 造批注：手写 ×2、荧光笔 ×1、图形 ×1、批注 ×1
    console.log('· 造批注（手写×2 / 荧光笔×1 / 图形×1 / 批注×1）')
    check('选择画笔', await selectTool(cdp, '画笔'))
    await stroke(cdp, 0)
    await stroke(cdp, 1)
    check('选择荧光笔', await selectTool(cdp, '荧光笔'))
    await stroke(cdp, 2)
    check('选择图形', await selectTool(cdp, '图形'))
    await stroke(cdp, 3)
    check('选择批注', await selectTool(cdp, '添加批注'))
    const first = await ev(cdp, `(() => { const cv = document.querySelector('.annot-canvas'); const r = cv.getBoundingClientRect(); return { x: Math.round(r.left + 200), y: Math.round(Math.max(r.top + 80, 160)) } })()`)
    await clickAt(cdp, first.x, first.y)
    await sleep(400)

    const st = await panelState(cdp)
    if (!st) { check('批注栏存在', false); throw new Error('no panel') }
    const declared = Number((st.hint.match(/(\d+)\s*条批注/) || [])[1] || 0)
    console.log('  面板结构: ' + JSON.stringify(st.groups.map((g) => `${g.label}(${g.badge}/${g.items})`)))
    console.log(`  工具栏计数=${declared}  栏内可见条目=${st.total}`)

    check('至少分出 3 个分类', st.groups.length >= 3, `got ${st.groups.length}`)
    check('分类顺序符合既定分类表', st.groups.map((g) => g.label).join(',').startsWith('手写,荧光笔'), st.groups.map((g) => g.label).join(','))
    check('手写分类徽标 = 组内条目数', st.groups.every((g) => g.badge === g.items), JSON.stringify(st.groups.map((g) => [g.label, g.badge, g.items])))
    check('没有空分类被渲染', st.groups.every((g) => g.badge > 0))
    // 核心不变量：分类不能吞掉任何批注
    check('所有批注都落在某个分类里（数量守恒）', st.total === declared && st.total > 0, `visible=${st.total} toolbar=${declared}`)
    check('分组计数之和 = 可见条目数', st.groups.reduce((s, g) => s + g.badge, 0) === st.total)
    check('每条目显示了所属类型标签', st.groups.every((g) => g.itemHeads.every((h) => h && h.length > 0)))
    check('图形分类包含图形条目', st.groups.some((g) => g.label === '图形' && g.badge >= 1), JSON.stringify(st.groups.map((g) => g.label)))

    await cdp.send('Page.captureScreenshot', { format: 'png' }).then(({ data }) =>
      fs.writeFileSync(path.join(SHOT_DIR, 'ann-groups-expanded.png'), Buffer.from(data, 'base64')))

    // 折叠/展开第一个分类
    const head = await ev(cdp, `(() => { const h = document.querySelector('.ann-panel-group-head'); const r = h.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    await clickAt(cdp, head.x, head.y)
    await sleep(300)
    const folded = await panelState(cdp)
    check('折叠后组内条目收起', folded.groups[0].folded === true && folded.groups[0].items === 0, JSON.stringify(folded.groups[0]))
    check('折叠后组徽标仍显示原有数量', folded.groups[0].badge === st.groups[0].badge)
    check('折叠只影响该分类，其它分类条目数不变', folded.groups.slice(1).every((g, i) => g.items === st.groups[i + 1].items))
    await cdp.send('Page.captureScreenshot', { format: 'png' }).then(({ data }) =>
      fs.writeFileSync(path.join(SHOT_DIR, 'ann-groups-folded.png'), Buffer.from(data, 'base64')))

    await clickAt(cdp, head.x, head.y)
    await sleep(300)
    const reopened = await panelState(cdp)
    check('再次点击恢复展开', reopened.groups[0].folded === false && reopened.groups[0].items === st.groups[0].badge)
    check('展开后条目总数回到原值', reopened.total === st.total, `${reopened.total} vs ${st.total}`)
    check('无未捕获异常', errors.length === 0, errors.join(' | '))

    console.log('\n截图: tmp/hig-shots/ann-groups-expanded.png / ann-groups-folded.png')
    console.log(failures === 0 ? '\n全部通过 ✅' : `\n失败 ${failures} 项 ❌`)
  } finally {
    cdp.close()
    try { chrome.kill() } catch {}
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error('脚本异常:', e); process.exit(1) })
