// verify-text-style.mjs — 验收「文本框的 Word 式样式栏：字体 / 字号 / 粗体 / 斜体 / 下划线 / 对齐 / 颜色」
//
// 用户反馈过「没有 Word 那样的可视化界面、选不了字体字号」，所以本脚本最重要的检查是：
//   1) 点了「文本框」工具按钮后，格式栏【自动】出现 —— 不需要任何隐藏手势
//      （以前要猜「再点一次 / 双击 / 右键」，等于功能藏起来了）
//   2) 格式栏常驻：点画布、点文本框都不会把它关掉（编辑文字时改字号不会被挡）
//   3) 控件齐全：字体下拉、字号下拉、粗体/斜体/下划线、三种对齐、色板 + 自定义颜色
//   4) 新建的文本框真的带上所选样式（字体栈 / 字号×缩放 / 700 / italic / underline / 居中 / 颜色）
//   5) Word 式行为：选中已有文本框时改样式 = 直接改那个框；没选中则只改「新建默认」
//   6) 离开文本框上下文（切到画笔）格式栏消失
//
// 用法: node tools/verify-text-style.mjs
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
const PORT = Number(process.env.CDP_PORT || 9363)
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
  while (Date.now() - t0 < ms) { const v = await ev(cdp, expr); if (v && !v.__error) return v; await sleep(step) }
  return null
}
async function clickAt(cdp, x, y, clickCount = 1) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount })
  await sleep(150)
}
async function clickToolByTitle(cdp, prefix) {
  const p = await ev(cdp, `(() => { const b = [...document.querySelectorAll('.doc-toolbar button')].find((x) => (x.getAttribute('title') || '').startsWith(${JSON.stringify(prefix)})); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
  if (!p) return false
  await clickAt(cdp, p.x, p.y)
  return true
}
// 格式栏是否可见（有尺寸才算可见）+ 所有控件是否真的落在窗口内
// （.doc-toolbar 默认 nowrap，一旦格式栏被撑出容器，色块会跑到窗口右边点不到 —— 这条就是防它回归）
const barState = (cdp) => ev(cdp, `(() => {
  const b = document.querySelector('.text-format-bar');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  const outside = [...b.querySelectorAll('button, select, input')].filter((el) => {
    const q = el.getBoundingClientRect();
    return q.width > 0 && (q.left < 0 || q.right > innerWidth || q.top < 0 || q.bottom > innerHeight);
  }).map((el) => el.getAttribute('aria-label') || el.className);
  return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left),
    right: Math.round(r.right), win: innerWidth, outside,
    context: (b.querySelector('.tfb-context') || {}).textContent || '' };
})()`)
const setSelect = (cdp, sel, value) => ev(cdp, `(() => {
  const s = document.querySelector(${JSON.stringify(sel)}); if (!s) return null;
  s.value = ${JSON.stringify(String(value))};
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return s.value;
})()`)
const clickInBar = async (cdp, sel) => {
  const p = await ev(cdp, `(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) } })()`)
  if (!p) return false
  await clickAt(cdp, p.x, p.y)
  return true
}
// 取最后一个文本框（批注模型存在 IndexedDB，重复跑时旧批注还在）
const textBoxStyle = (cdp) => ev(cdp, `(() => {
  const all = document.querySelectorAll('.ann-text'); const el = all[all.length - 1];
  if (!el) return null; const cs = getComputedStyle(el);
  return { fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle,
    textDecoration: cs.textDecorationLine || cs.textDecoration, textAlign: cs.textAlign, color: cs.color,
    text: (el.querySelector('.ann-text-content') || {}).textContent || '' };
})()`)
const annScale = async (cdp) => { const raw = await ev(cdp, `(() => { const el = document.querySelector('.ann-dom'); return el ? getComputedStyle(el).getPropertyValue('--ann-scale').trim() : '1' })()`); const n = Number(raw); return Number.isFinite(n) && n > 0 ? n : 1 }

async function dragTextBox(cdp) {
  const box = await ev(cdp, `(() => { const cv = document.querySelector('.annot-canvas'); const r = cv.getBoundingClientRect(); return { x: Math.round(r.left + 140), y: Math.round(Math.max(r.top + 80, 180)) } })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + (220*i)/8, y: box.y + (70*i)/8, button: 'left' }); await sleep(15) }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 220, y: box.y + 70, button: 'left', clickCount: 1 })
  await sleep(400)
}

async function main() {
  let alive = false
  for (let i = 0; i < 10; i++) {
    try { const r = await fetch(APP_URL, { signal: AbortSignal.timeout(2500) }); if (r.status < 500) { alive = true; break } } catch {}
    await sleep(800)
  }
  if (!alive) { console.error('dev 服务未启动: ' + APP_URL); process.exit(1) }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'textstyle-'))
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
    check('PDF 打开并出现批注画布', Boolean(await waitFor(cdp, `document.querySelectorAll('.annot-canvas').length`, 25000)))
    await sleep(700)

    console.log('· 核心：点一下「文本框」工具，格式栏就该自动出现（没有任何隐藏手势）')
    check('格式栏在未点工具前是不显示的', (await barState(cdp)) === null)
    check('点击「文本框」工具', await clickToolByTitle(cdp, '文本框'))
    const barVisible = await waitFor(cdp, `(() => { const b = document.querySelector('.text-format-bar'); if (!b) return null; const r = b.getBoundingClientRect(); return r.width > 0 ? true : null })()`, 4000)
    check('【自动出现】格式栏无需任何额外手势就显示出来了', Boolean(barVisible))
    const bar = await barState(cdp)
    console.log('  格式栏: ' + JSON.stringify(bar))
    check('格式栏全部控件都在窗口内（不会被撑出屏幕点不到）', Boolean(bar) && bar.outside.length === 0, JSON.stringify(bar && bar.outside))
    check('格式栏宽度不超出窗口', Boolean(bar) && bar.right <= bar.win, JSON.stringify(bar))

    const ctrl = await ev(cdp, `(() => {
      const b = document.querySelector('.text-format-bar'); if (!b) return null;
      return {
        hasFontSelect: Boolean(b.querySelector('.text-font-select')),
        fontOptions: [...b.querySelectorAll('.text-font-select option')].map((o) => o.textContent),
        sizeOptions: b.querySelectorAll('.text-size-select option').length,
        sizeValue: (b.querySelector('.text-size-select') || {}).value,
        styleBtns: [...b.querySelectorAll('.text-style-group .seg-btn')].map((x) => x.getAttribute('aria-label')),
        alignBtns: [...b.querySelectorAll('.text-align-group .seg-btn')].map((x) => x.getAttribute('aria-label')),
        swatches: b.querySelectorAll('.swatch').length,
        customColor: Boolean(b.querySelector('input[type="color"]')),
      };
    })()`)
    console.log('  控件: ' + JSON.stringify(ctrl))
    check('字体是下拉框且 4 种字体可选', ctrl && ctrl.hasFontSelect && ctrl.fontOptions.join(',') === '无衬线,宋体,楷体,等宽', JSON.stringify(ctrl && ctrl.fontOptions))
    check('字号下拉有预设刻度', ctrl && ctrl.sizeOptions >= 14)
    check('粗体/斜体/下划线三个开关', ctrl && ctrl.styleBtns.join(',') === '加粗,倾斜,下划线')
    check('三种对齐按钮', ctrl && ctrl.alignBtns.join(',') === '左对齐,居中,右对齐')
    check('色板 + 自定义颜色', ctrl && ctrl.swatches >= 5 && ctrl.customColor === true)

    console.log('· 在格式栏里选：宋体 / 24 / 粗体 / 斜体 / 下划线 / 居中 / 蓝')
    check('选字体=宋体', (await setSelect(cdp, '.text-format-bar .text-font-select', 'serif')) === 'serif')
    check('选字号=24', (await setSelect(cdp, '.text-format-bar .text-size-select', '24')) === '24')
    for (const label of ['加粗', '倾斜', '下划线']) {
      check(`点「${label}」`, await clickInBar(cdp, `.text-format-bar .text-style-group .seg-btn[aria-label="${label}"]`))
    }
    check('点「居中」', await clickInBar(cdp, '.text-format-bar .text-align-group .seg-btn[aria-label="居中"]'))
    check('点蓝色色块', await clickInBar(cdp, '.text-format-bar .swatch[aria-label="文字颜色 #007aff"]'))
    const chosen = await ev(cdp, `(() => { const b = document.querySelector('.text-format-bar'); return {
      font: (b.querySelector('.text-font-select')||{}).value, size: (b.querySelector('.text-size-select')||{}).value,
      active: [...b.querySelectorAll('.seg-btn.active')].map((x) => x.getAttribute('aria-label')),
      color: [...b.querySelectorAll('.swatch.active')].map((x) => x.getAttribute('aria-label')) } })()`)
    check('格式栏回显所选样式', chosen.font === 'serif' && chosen.size === '24' && chosen.active.includes('加粗') && chosen.active.includes('倾斜') && chosen.active.includes('下划线') && chosen.active.includes('居中') && chosen.color.length === 1, JSON.stringify(chosen))

    console.log('· 拖出文本框并输入文字')
    await dragTextBox(cdp)
    check('出现页面内文字编辑器', Boolean(await waitFor(cdp, `document.querySelectorAll('.ann-text-editor').length`, 5000)))
    await cdp.send('Input.insertText', { text: 'Word 式格式栏' })
    await sleep(200)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(500)

    const k = await annScale(cdp)
    const st = await textBoxStyle(cdp)
    console.log(`  缩放=${k}  计算样式: ` + JSON.stringify(st))
    check('文本框已生成且有文字', Boolean(st) && st.text.includes('Word'))
    check('字体=宋体（字体栈生效）', st && /Songti|SimSun|serif/i.test(st.fontFamily), st && st.fontFamily)
    check(`字号 = 24 × 缩放(${k}) = ${Math.round(24 * k)}px`, st && st.fontSize === `${Math.round(24 * k)}px`, st && st.fontSize)
    check('加粗=700', st && st.fontWeight === '700', st && st.fontWeight)
    check('斜体=italic', st && st.fontStyle === 'italic', st && st.fontStyle)
    check('下划线=underline', st && st.textDecoration.includes('underline'), st && st.textDecoration)
    check('对齐=center', st && st.textAlign === 'center', st && st.textAlign)
    check('颜色=rgb(0, 122, 255)', st && st.color === 'rgb(0, 122, 255)', st && st.color)

    const barAfterCreate = await barState(cdp)
    check('格式栏在画完文本框后依然在（没有被关掉，可以直接改样式）', Boolean(barAfterCreate), JSON.stringify(barAfterCreate))
    check('格式栏已切到「正在编辑文本框」', Boolean(barAfterCreate) && barAfterCreate.context.includes('正在编辑文本框'), barAfterCreate && barAfterCreate.context)
    check('格式栏没有被文本框遮挡（在画布上方）', Boolean(barAfterCreate) && barAfterCreate.top < 200, JSON.stringify(barAfterCreate))

    await cdp.send('Page.captureScreenshot', { format: 'png' }).then(({ data }) =>
      fs.writeFileSync(path.join(SHOT_DIR, 'text-format-bar.png'), Buffer.from(data, 'base64')))

    // Word 式行为：选中已有文本框 → 改样式直接作用到它
    console.log('· Word 式行为：选中已有文本框后改字体')
    const boxPos = await ev(cdp, `(() => { const all = document.querySelectorAll('.ann-text'); const el = all[all.length-1]; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + 12) } })()`)
    await clickAt(cdp, boxPos.x, boxPos.y)
    await sleep(300)
    await setSelect(cdp, '.text-format-bar .text-font-select', 'mono')
    await sleep(300)
    const st2 = await textBoxStyle(cdp)
    check('改字体立刻作用到已有文本框', st2 && /Cascadia|Consolas|Courier|monospace/i.test(st2.fontFamily), st2 && st2.fontFamily)
    check('其它样式不受影响（字号/粗体保持）', st2 && st2.fontSize === `${Math.round(24 * k)}px` && st2.fontWeight === '700', st2 && `${st2.fontSize}/${st2.fontWeight}`)

    // 取消选中后：格式栏仍在（工具还是文本框），但改样式只影响新建默认
    console.log('· 取消选中后改样式：只改新建默认')
    const blank = await ev(cdp, `(() => { const cv = document.querySelector('.annot-canvas'); const r = cv.getBoundingClientRect(); return { x: Math.round(r.left + 30), y: Math.round(Math.max(r.top, 120) + 20) } })()`)
    await clickAt(cdp, blank.x, blank.y)
    await sleep(350)
    check('点击空白处已取消选中', (await ev(cdp, `document.querySelectorAll('.ann-text.selected').length`)) === 0)
    const barDeselect = await barState(cdp)
    check('取消选中后格式栏还在（工具仍是文本框，随时能改新建默认）', Boolean(barDeselect), JSON.stringify(barDeselect))
    check('提示切回「新建文本框默认样式」', Boolean(barDeselect) && barDeselect.context.includes('新建文本框默认'), barDeselect && barDeselect.context)
    await setSelect(cdp, '.text-format-bar .text-font-select', 'serif')
    await sleep(300)
    const st3 = await textBoxStyle(cdp)
    check('未选中时改字体不会动已有文本框', st3 && /Cascadia|Consolas|Courier|monospace/i.test(st3.fontFamily), st3 && st3.fontFamily)

    // 离开文本框上下文 → 格式栏消失
    console.log('· 切到画笔工具后格式栏应消失')
    check('点「画笔」工具', await clickToolByTitle(cdp, '画笔'))
    await sleep(400)
    check('离开文本框上下文后格式栏隐藏（不占地方）', (await barState(cdp)) === null)

    // 另一条路径：点中页面上的文本框（不用先切文本框工具）也该自动出现格式栏
    console.log('· 点中页面上的文本框 → 格式栏也应自动出现')
    const boxPos2 = await ev(cdp, `(() => { const all = document.querySelectorAll('.ann-text'); if (!all.length) return null; const r = all[all.length-1].getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + 12) } })()`)
    if (boxPos2) await clickAt(cdp, boxPos2.x, boxPos2.y)
    await sleep(400)
    const barSel = await barState(cdp)
    check('点中文框后格式栏自动出现（无需先点文本框工具）', Boolean(barSel), JSON.stringify(barSel))
    check('格式栏控件同样都在窗口内', Boolean(barSel) && barSel.outside.length === 0, JSON.stringify(barSel && barSel.outside))
    // 取消选中 → 当前工具不是文本框，格式栏应消失
    const blank2 = await ev(cdp, `(() => { const cv = document.querySelector('.annot-canvas'); const r = cv.getBoundingClientRect(); return { x: Math.round(r.left + 24), y: Math.round(Math.max(r.top, 120) + 18) } })()`)
    await clickAt(cdp, blank2.x, blank2.y)
    await sleep(400)
    check('取消选中后格式栏隐藏（当前工具不是文本框就不该占地方）', (await barState(cdp)) === null)

    check('无未捕获异常', errors.length === 0, errors.join(' | '))
    console.log('\n截图: tmp/hig-shots/text-format-bar.png')
    console.log(failures === 0 ? '\n全部通过 ✅' : `\n失败 ${failures} 项 ❌`)
  } finally {
    cdp.close()
    try { chrome.kill() } catch {}
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error('脚本异常:', e); process.exit(1) })
