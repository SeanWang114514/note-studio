// pdf-editor-smoke.mjs — 冒烟测试：验证 PdfEditorView（React 原生 PDF 编辑器）
// 1. 打开应用首页，mock showOpenFilePicker 返回 test-text.pdf
// 2. 点击打开文件 → PdfView 渲染 PdfEditorView
// 3. 验证页面画布/文字层出现
// 4. 验证顶栏「光标 / 编辑」模式按钮；光标模式单击文字不编辑
// 5. 编辑模式单击文字 → 直接编辑整段（无选择框/控制点/确认按钮）
// 6. Enter 换行不提交；点击编辑区外部自动保存；重开验证持久化
// 用法: node tools/pdf-editor-smoke.mjs [chromePath]

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5199/'
const PDF_NAME = 'test-text.pdf'
const PDF_PATH = path.join(ROOT, 'public', PDF_NAME)

let failures = 0
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✔ ${name}`)
  } else {
    failures += 1
    console.log(`  ✘ ${name} ${extra}`)
  }
}

// ── 简易 CDP 客户端 ──────────────────────────────
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.events = []
    this.listeners = new Map()
  }
  async open() {
    await new Promise((res, rej) => {
      this.ws.onopen = res
      this.ws.onerror = rej
    })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      } else if (msg.method) {
        const ls = this.listeners.get(msg.method) || []
        for (const fn of ls) fn(msg.params)
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
  close() {
    try { this.ws.close() } catch { /* ignore */ }
  }
}

async function main() {
  console.log(`[1/6] 启动无头 Chrome（${CHROME}）…`)
  // Chrome profile 放系统临时目录：避免 vite watch 项目 tmp/ 下的 profile 文件导致 EBUSY 崩溃
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-profile-'))
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=9223',
    '--user-data-dir=' + userData,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--window-size=1400,900',
    'about:blank',
  ], { stdio: 'ignore' })

  // 等待调试端口就绪
  let targets = []
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9223/json/list')
      targets = await res.json()
      if (targets.length) break
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  if (!targets.length) {
    console.error('无法连接 Chrome 调试端口')
    chrome.kill()
    process.exit(1)
  }

  const pageTarget = targets.find((t) => t.type === 'page') || targets[0]
  const cdp = new CDP(pageTarget.webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')

  // 收集页面错误（排除无害项：favicon 404、Stirling-PDF 服务未启动的连接拒绝）
  const pageErrors = []
  cdp.on('Runtime.exceptionThrown', (p) => {
    pageErrors.push(p.exceptionDetails?.text || 'exception')
  })
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry?.level !== 'error') return
    const text = p.entry.text || ''
    const url = p.entry.url || ''
    if (/favicon\.ico/i.test(text + ' ' + url)) return
    if (/ERR_CONNECTION_REFUSED/.test(text)) return
    pageErrors.push(text + (url ? ' [' + url + ']' : ''))
  })

  console.log(`[2/6] 打开应用 ${APP_URL}`)
  await cdp.send('Page.navigate', { url: APP_URL })
  await new Promise((r) => setTimeout(r, 3000))

  // 注入 mock：showOpenFilePicker 返回 test-text.pdf 的 FileSystemFileHandle
  console.log('[3/6] 注入 showOpenFilePicker mock…')
  const pdfBytes = fs.readFileSync(PDF_PATH)
  const b64 = pdfBytes.toString('base64')
  const mock = `
    (() => {
      const bytes = Uint8Array.from(atob('${b64}'), c => c.charCodeAt(0));
      const file = new File([bytes], '${PDF_NAME}', { type: 'application/pdf', lastModified: Date.now() });
      const handle = {
        kind: 'file', name: '${PDF_NAME}',
        getFile: async () => file,
        queryPermission: async () => 'granted',
        requestPermission: async () => 'granted',
        createWritable: async () => {
          let buf = bytes.slice();
          return {
            write: async (data) => { buf = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer); },
            close: async () => {},
            getPosition: async () => buf.length,
            truncate: async () => {},
            seek: async () => {},
          };
        },
      };
      window.__mockHandle = handle;
      window.showOpenFilePicker = async () => [handle];
      window.showSaveFilePicker = async () => handle;
      return 'mock injected';
    })()
  `
  const injectRes = await cdp.send('Runtime.evaluate', { expression: mock, returnByValue: true })
  check('mock 注入成功', injectRes?.result?.value === 'mock injected', JSON.stringify(injectRes?.result))

  // 清空 IndexedDB 批注缓存，保证测试可重复（上次运行保存的 textEdit 不残留）
  await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      try {
        const req = indexedDB.open('noteflow', 1);
        await new Promise((res, rej) => { req.onsuccess = res; req.onerror = () => rej(req.error); });
        const db = req.result;
        for (const name of db.objectStoreNames) {
          await new Promise((res, rej) => {
            const tx = db.transaction(name, 'readwrite');
            tx.objectStore(name).clear();
            tx.oncomplete = res; tx.onerror = () => rej(tx.error);
          });
        }
        db.close();
      } catch (e) { /* 无该库则忽略 */ }
      return 'cleared';
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })

  // 点击“打开文件”按钮
  console.log('[4/6] 点击打开文件…')
  const clickOpen = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('button')];
      const b = btns.find(x => /打开文件/.test(x.textContent || ''));
      if (b) { b.click(); return 'clicked'; }
      return 'not-found';
    })()`,
    returnByValue: true,
  })
  check('找到并点击「打开文件」', clickOpen?.result?.value === 'clicked', clickOpen?.result?.value)
  await new Promise((r) => setTimeout(r, 6000))

  // 验证 PdfEditorView 渲染
  console.log('[5/6] 验证 PDF 视图…')
  const state = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const shell = document.querySelector('.pdf-viewer-shell');
      const pages = document.querySelectorAll('.pdf-page');
      const canvases = document.querySelectorAll('.pdf-canvas');
      const textLayers = document.querySelectorAll('.pdf-text-layer');
      const spans = document.querySelectorAll('.pdf-text-layer span[data-page]');
      const editBars = document.querySelectorAll('.pdf-edit-bar');
      const pageControls = document.querySelectorAll('.pdf-page-controls');
      return {
        shell: !!shell,
        pages: pages.length,
        canvases: canvases.length,
        textLayers: textLayers.length,
        spans: spans.length,
        editBars: editBars.length,
        pageControls: pageControls.length,
        bodyText: document.body.innerText.slice(0, 200),
      };
    })()`,
    returnByValue: true,
  })
  const s = state?.result?.value || {}
  check('PdfEditorView 挂载（.pdf-viewer-shell）', !!s.shell)
  check('页面 canvas 渲染', s.pages >= 1 && s.canvases >= 1, JSON.stringify({ pages: s.pages, canvases: s.canvases }))
  check('文字层生成 span（可编辑文字）', s.spans > 0, `spans=${s.spans}`)
  check('浮动页码/缩放控制条存在', s.pageControls >= 1)

  // ── 工具栏模式切换按钮 ──
  console.log('[6.1] 验证顶栏「光标 / 编辑」模式按钮…')
  const modeBtns = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('.pdf-toolbar button')];
      const cursor = btns.find(b => /^\\s*光标/.test(b.textContent || ''));
      const edit = btns.find(b => /^\\s*编辑/.test(b.textContent || ''));
      const active = btns.find(b => b.classList.contains('active'));
      return { cursor: !!cursor, edit: !!edit, active: active ? active.textContent.trim() : '' };
    })()`,
    returnByValue: true,
  })
  const mb = modeBtns?.result?.value || {}
  check('顶栏有「光标」按钮', !!mb.cursor)
  check('顶栏有「编辑」按钮', !!mb.edit)

  // 单击第一个文字 span（CDP 真实鼠标事件）
  // 注意：默认即编辑模式（mode='edit'），单击直接进入段落编辑
  const spanInfo = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const span = document.querySelector('.pdf-text-layer span[data-page]');
      if (!span) return { ok: false, reason: 'no span' };
      const r = span.getBoundingClientRect();
      return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
    returnByValue: true,
  })
  const sp = spanInfo?.result?.value || {}
  check('找到文字 span', !!sp.ok, sp.reason || '')
  if (sp.ok) {
    const { x, y } = sp
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  await new Promise((r) => setTimeout(r, 500))
  const cursorClick = await cdp.send('Runtime.evaluate', {
    expression: `(() => ({
      editor: !!document.querySelector('.pdf-inline-editor'),
      selectBox: !!document.querySelector('.pdf-select-box'),
      modeActive: [...document.querySelectorAll('.pdf-toolbar button.active')].map(b => b.textContent.trim()),
    }))()`,
    returnByValue: true,
  })
  const cc = cursorClick?.result?.value || {}
  check('编辑模式默认激活', (cc.modeActive || []).some((t) => t.includes('编辑')), JSON.stringify(cc.modeActive))
  check('编辑模式单击文字直接出现编辑框', !!cc.editor)
  check('无选择框', !cc.selectBox)

  // 切到光标模式：单击文字不再编辑
  console.log('[6.1b] 光标模式：单击文字不编辑…')
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const btn = [...document.querySelectorAll('.pdf-toolbar button')].find(b => /^\\s*光标/.test(b.textContent || ''));
      if (btn) btn.click();
      return !!btn;
    })()`,
    returnByValue: true,
  })
  await new Promise((r) => setTimeout(r, 400))
  if (sp.ok) {
    const { x, y } = sp
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  await new Promise((r) => setTimeout(r, 500))
  const cursorMode = await cdp.send('Runtime.evaluate', {
    expression: `(() => ({
      editor: !!document.querySelector('.pdf-inline-editor'),
      modeActive: [...document.querySelectorAll('.pdf-toolbar button.active')].map(b => b.textContent.trim()),
    }))()`,
    returnByValue: true,
  })
  const cm = cursorMode?.result?.value || {}
  check('光标模式激活', (cm.modeActive || []).some((t) => t.includes('光标')), JSON.stringify(cm.modeActive))
  check('光标模式单击文字不出现编辑框', !cm.editor)

  // 切到编辑模式，再单击文字 → 直接进入编辑
  console.log('[6.2] 编辑模式：单击文字直接编辑段落…')
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const btn = [...document.querySelectorAll('.pdf-toolbar button')].find(b => /^\\s*编辑/.test(b.textContent || ''));
      if (btn) btn.click();
      return !!btn;
    })()`,
    returnByValue: true,
  })
  await new Promise((r) => setTimeout(r, 200))
  if (sp.ok) {
    const { x, y } = sp
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  await new Promise((r) => setTimeout(r, 800))
  const editState = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const editor = document.querySelector('.pdf-inline-editor');
      const actions = document.querySelectorAll('.pdf-inline-actions button');
      const bar = document.querySelector('.pdf-edit-bar');
      const barBtns = bar ? bar.querySelectorAll('button').length : 0;
      const barSelects = bar ? bar.querySelectorAll('select').length : 0;
      return {
        editor: !!editor,
        editorText: editor ? editor.textContent : null,
        actions: actions.length,
        bar: !!bar, barBtns, barSelects,
        selectBox: !!document.querySelector('.pdf-select-box'),
        handles: document.querySelectorAll('.pdf-handle').length,
      };
    })()`,
    returnByValue: true,
  })
  const es = editState?.result?.value || {}
  check('单击文字直接出现编辑框', !!es.editor)
  check('编辑框含整段原文', !!es.editorText && es.editorText.length > 0, `text=${JSON.stringify(es.editorText)}`)
  check('无 Acrobat 选择框', !es.selectBox)
  check('无 8 个控制点', es.handles === 0, 'handles=' + es.handles)
  check('无确认/取消/删除按钮', es.actions === 0, 'actions=' + es.actions)
  check('格式条出现（Word 风格）', !!es.bar && es.barSelects >= 2 && es.barBtns >= 4, JSON.stringify({ barBtns: es.barBtns, barSelects: es.barSelects }))

  // 修改文字：Enter 只换行，不提交
  if (es.editor) {
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const editor = document.querySelector('.pdf-inline-editor');
        editor.textContent = 'SMOKE_EDITED_123\\n第二行';
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'SMOKE_EDITED_123\\n第二行' }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        return 'typed';
      })()`,
      returnByValue: true,
    })
    await new Promise((r) => setTimeout(r, 600))
    const enterState = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const editor = document.querySelector('.pdf-inline-editor');
        return {
          editorExists: !!editor,
          editorText: editor ? editor.textContent : null,
          editedCount: document.querySelectorAll('.pdf-text-layer span.edited').length,
        };
      })()`,
      returnByValue: true,
    })
    const et = enterState?.result?.value || {}
    check('Enter 不提交（编辑框仍在）', !!et.editorExists)
    check('Enter 保留换行内容', !!(et.editorText || '').includes('第二行'), JSON.stringify(et.editorText))
    check('Enter 未落盘（无 .edited 标记）', et.editedCount === 0, `edited=${et.editedCount}`)

    // 点击编辑区外部（缩略图区域）→ 自动保存
    console.log('[6.3] 点击编辑区外部自动保存…')
    const outside = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const thumb = document.querySelector('.pdf-thumbs');
        if (!thumb) return { ok: false, reason: 'no .pdf-thumbs' };
        const r = thumb.getBoundingClientRect();
        return { ok: true, x: r.left + 20, y: r.top + Math.min(60, r.height / 2) };
      })()`,
      returnByValue: true,
    })
    const os = outside?.result?.value || {}
    check('找到外部点击位置', !!os.ok, os.reason || '')
    if (os.ok) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: os.x, y: os.y, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: os.x, y: os.y, button: 'left', clickCount: 1 })
    }
    await new Promise((r) => setTimeout(r, 900))
    const after = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const edited = document.querySelectorAll('.pdf-text-layer span.edited');
        const editorGone = !document.querySelector('.pdf-inline-editor');
        return { editedCount: edited.length, editorGone };
      })()`,
      returnByValue: true,
    })
    const a = after?.result?.value || {}
    check('点击外部后编辑框消失（自动保存）', !!a.editorGone)
    check('原文字 span 标记 .edited', a.editedCount >= 1, `edited=${a.editedCount}`)

    console.log('\n[7/7] 重开文件验证编辑持久化…')
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const closeBtn = [...document.querySelectorAll('button')].find(x => x.title === '关闭标签' || (x.closest('.tab') && x.querySelector('[data-close]')));
        const tab = document.querySelector('.tab');
        if (tab) { tab.querySelector('.tab-close')?.click(); return 'tab-closed'; }
        return 'no-tab';
      })()`,
      returnByValue: true,
    })
    await new Promise((r) => setTimeout(r, 1200))
    // 重新打开同一 PDF
    await cdp.send('Runtime.evaluate', {
      expression: `(() => { const b = [...document.querySelectorAll('button')].find(x => /打开文件/.test(x.textContent||'')); b && b.click(); return 'reopened'; })()`,
      returnByValue: true,
    })
    await new Promise((r) => setTimeout(r, 6000))
    const reopen = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const edited = document.querySelectorAll('.pdf-text-layer span.edited');
        const shell = !!document.querySelector('.pdf-viewer-shell');
        // editCanvas 上应有文字覆盖（非空白）
        const ec = document.querySelector('.pdf-edit-canvas');
        let hasPixels = false;
        if (ec && ec.width > 0) {
          try {
            const ctx = ec.getContext('2d');
            const data = ctx.getImageData(0, 0, ec.width, ec.height).data;
            for (let i = 3; i < data.length; i += 4) { if (data[i] > 0) { hasPixels = true; break; } }
          } catch (e) { /* ignore */ }
        }
        return { shell, editedCount: edited.length, hasPixels };
      })()`,
      returnByValue: true,
    })
    const rp = reopen?.result?.value || {}
    check('重开后 PdfEditorView 重新挂载', !!rp.shell)
    check('重开后 .edited 标记恢复（持久化生效）', rp.editedCount >= 1, `edited=${rp.editedCount}`)
    check('重开后编辑覆盖画布有内容', !!rp.hasPixels)
  }

  console.log(`\n页面错误数: ${pageErrors.length}`)
  if (pageErrors.length) {
    pageErrors.slice(0, 8).forEach((e) => console.log('  ⚠', String(e).slice(0, 800)))
  }
  check('无页面 JS 错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

  cdp.close()
  chrome.kill()
  // Chrome 退出需要时间释放 profile 文件，稍等再清理；失败不致命
  await new Promise((r) => setTimeout(r, 800))
  try {
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch {
    /* profile 清理失败不影响测试结果 */
  }

  console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('测试脚本异常:', err)
  process.exit(1)
})
