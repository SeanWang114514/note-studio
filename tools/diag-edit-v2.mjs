// diag-edit-v2.mjs — 点击正文段落，dump 编辑框与聚合结构
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const APP_URL = 'http://127.0.0.1:5199/'
const PDF = 'test-realistic.pdf'
class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map() }
  async open() { await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej }); this.ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) } } }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text }; return r.result?.value }
  close() { try { this.ws.close() } catch {} }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userData = path.join(os.tmpdir(), 'diag-v2-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9252', '--user-data-dir=' + userData, '--no-first-run', '--disable-gpu', '--disable-extensions', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9252/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open(); await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Page.navigate', { url: APP_URL }); await sleep(4000)
const b64 = fs.readFileSync(path.join(ROOT, 'public', PDF)).toString('base64')
await cdp.eval('(() => { const bytes = Uint8Array.from(atob("' + b64 + '"), c => c.charCodeAt(0)); const file = new File([bytes], "' + PDF + '", { type: "application/pdf" }); const handle = { kind: "file", name: "' + PDF + '", getFile: async () => file, queryPermission: async () => "granted", requestPermission: async () => "granted", createWritable: async () => ({ write: async () => {}, close: async () => {} }) }; window.showOpenFilePicker = async () => [handle]; return "ok" })()')
await cdp.eval('(() => { const b = [...document.querySelectorAll("button")].find(x => /打开文件/.test(x.textContent||"")); b?.click(); return "ok" })()')
await sleep(7000)
const info = await cdp.eval('(() => { const layers = [...document.querySelectorAll(".pdf-text-layer")]; const cands = []; for (const layer of layers) { const spans = [...layer.querySelectorAll("span[data-page]")]; const bodySpans = spans.filter(x => /[\u4e00-\u9fff]/.test(x.textContent||"") && /[。，、；：？！]/.test(x.textContent||"")); if (bodySpans.length) { cands.push({ layer, spans: bodySpans, page: bodySpans[0].dataset.page }) } }; if (!cands.length) return { found: false }; const { layer, spans, page } = cands[0]; const target = spans[0]; const r = target.getBoundingClientRect(); const layerR = layer.getBoundingClientRect(); return { found: true, page, text: target.textContent, click: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, spanRect: { left: r.left, top: r.top, width: r.width, height: r.height }, bodySpanCount: spans.length, layerRect: { left: layerR.left, top: layerR.top, width: layerR.width, height: layerR.height } } })()')
console.log('TARGET:', JSON.stringify(info, null, 1))
if (!info.found) { console.log('no body span found'); chrome.kill(); process.exit(0) }
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.click.x, y: info.click.y, button: 'left', clickCount: 1 })
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.click.x, y: info.click.y, button: 'left', clickCount: 1 })
await sleep(800)
const dump = await cdp.eval(Buffer.from('KGFzeW5jICgpID0+IHsKICBjb25zdCBvdXQgPSB7fQogIGNvbnN0IHBvcyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoIi5wZGYtaW5saW5lLWVkaXRvci1wb3MiKQogIGNvbnN0IGJveCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoIi5wZGYtaW5saW5lLWVkaXRvciIpCiAgaWYgKCFib3gpIHJldHVybiB7IGVkaXRvck9wZW46IGZhbHNlIH0KICBvdXQuZWRpdG9yT3BlbiA9IHRydWUKICBjb25zdCBwciA9IHBvcy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsgY29uc3QgYnIgPSBib3guZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkKICBvdXQucG9zUmVjdCA9IHsgbGVmdDogcHIubGVmdCwgdG9wOiBwci50b3AsIHdpZHRoOiBwci53aWR0aCwgaGVpZ2h0OiBwci5oZWlnaHQgfQogIG91dC5ib3hSZWN0ID0geyBsZWZ0OiBici5sZWZ0LCB0b3A6IGJyLnRvcCwgd2lkdGg6IGJyLndpZHRoLCBoZWlnaHQ6IGJyLmhlaWdodCB9CiAgb3V0LmJveFRleHQgPSBib3gudGV4dENvbnRlbnQKICBvdXQubGluZUNvdW50ID0gYm94LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWxpbmVdIikubGVuZ3RoCiAgb3V0LmxpbmVzID0gWy4uLmJveC5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1saW5lXSIpXS5tYXAoKGQsIGkpID0+IHsKICAgIGNvbnN0IHIgPSBkLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOyBjb25zdCBjcyA9IGdldENvbXB1dGVkU3R5bGUoZCkKICAgIHJldHVybiB7IGksIHRleHQ6IGQudGV4dENvbnRlbnQsIHJlY3Q6IHsgbGVmdDogci5sZWZ0LCB0b3A6IHIudG9wLCB3aWR0aDogci53aWR0aCwgaGVpZ2h0OiByLmhlaWdodCB9LCB0cmFuc2Zvcm06IGNzLnRyYW5zZm9ybSwgd2hpdGVTcGFjZTogY3Mud2hpdGVTcGFjZSB9CiAgfSkKICBjb25zdCBjb250YWluZXIgPSBwb3MucGFyZW50RWxlbWVudAogIGNvbnN0IGxheWVyID0gY29udGFpbmVyICYmIGNvbnRhaW5lci5xdWVyeVNlbGVjdG9yKCIucGRmLXRleHQtbGF5ZXIiKQogIGNvbnN0IHBhZ2UgPSBwb3MuY2xvc2VzdCgiLnBkZi1wYWdlIikgPyBwb3MuY2xvc2VzdCgiLnBkZi1wYWdlIikuZGF0YXNldC5wYWdlIDogbnVsbAogIHRyeSB7CiAgICBjb25zdCBtb2QgPSBhd2FpdCBpbXBvcnQoIi9zcmMvbGliL3BkZi9wZGZUZXh0RWRpdC5qcyIpCiAgICBjb25zdCBibG9ja3MgPSBtb2QuY29sbGVjdFBhcmFncmFwaHMobGF5ZXIsIE51bWJlcihwYWdlKSkKICAgIG91dC5ibG9ja0NvdW50ID0gYmxvY2tzLmxlbmd0aAogICAgb3V0LmJsb2NrcyA9IGJsb2Nrcy5tYXAoKGIsIGJpKSA9PiAoewogICAgICBiaSwKICAgICAgbGluZUNvdW50OiBiLmxpbmVEYXRhLmxlbmd0aCwKICAgICAgbGluZVRleHRzOiBiLmxpbmVEYXRhLm1hcChsID0+IGwudGV4dCksCiAgICAgIGxpbmVQZGZZOiBiLmxpbmVEYXRhLm1hcChsID0+IGwucGRmWSksCiAgICAgIGxpbmVTcGFjaW5nOiBiLmxpbmVTcGFjaW5nLAogICAgICBmb250U2l6ZTogYi5mb250U2l6ZSwKICAgICAgYWN0dWFsRm9udE5hbWU6IGIuYWN0dWFsRm9udE5hbWUsCiAgICAgIGZvbnRGYW1pbHk6IGIuZm9udEZhbWlseSwKICAgICAgY29sb3I6IGIuY29sb3IsCiAgICAgIHJlY3Q6IGIucmVjdCA/IHsgbGVmdDogYi5yZWN0LmxlZnQsIHRvcDogYi5yZWN0LnRvcCwgd2lkdGg6IGIucmVjdC53aWR0aCwgaGVpZ2h0OiBiLnJlY3QuaGVpZ2h0IH0gOiBudWxsLAogICAgfSkpCiAgICBjb25zdCBzcGFucyA9IFsuLi5sYXllci5xdWVyeVNlbGVjdG9yQWxsKCJzcGFuW2RhdGEtcGFnZT0nIiArIHBhZ2UgKyAiJ10iKV0KICAgIG91dC5zcGFuU2FtcGxlID0gc3BhbnMuc2xpY2UoMCwgMTUpLm1hcChzID0+ICh7CiAgICAgIHRleHQ6IHMudGV4dENvbnRlbnQsCiAgICAgIGlkeDogcy5kYXRhc2V0LmlkeCwKICAgICAgcGRmWTogcy5kYXRhc2V0LnBkZlRyYW5zZm9ybSA/IEpTT04ucGFyc2Uocy5kYXRhc2V0LnBkZlRyYW5zZm9ybSlbNV0gOiBudWxsLAogICAgICBwZGZYOiBzLmRhdGFzZXQucGRmVHJhbnNmb3JtID8gSlNPTi5wYXJzZShzLmRhdGFzZXQucGRmVHJhbnNmb3JtKVs0XSA6IG51bGwsCiAgICB9KSkKICB9IGNhdGNoIChlKSB7IG91dC5hZ2dyZWdhdGVFcnJvciA9IFN0cmluZyhlICYmIGUubWVzc2FnZSB8fCBlKSB9CiAgcmV0dXJuIG91dAp9KSgp', 'base64').toString('utf8'))
console.log('EDITOR DUMP:', JSON.stringify(dump, null, 1))
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(path.join(ROOT, 'tmp', 'diag-edit-v2.png'), Buffer.from(shot.data, 'base64'))
console.log('screenshot: tmp/diag-edit-v2.png')
cdp.close(); chrome.kill(); await sleep(800)
try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch {}
process.exit(0)
