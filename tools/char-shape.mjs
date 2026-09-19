// char-shape.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SRC = 'C:/Users/Administrator/AppData/Local/Temp/modlens-dsh-paste/p-30OBKv/paste.png'
class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map() }
  async open() { await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej }); this.ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) } } }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text }; return r.result?.value }
  close() { try { this.ws.close() } catch {} }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userData = path.join(os.tmpdir(), 'charshape-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9260', '--user-data-dir=' + userData, '--no-first-run', '--disable-gpu', '--window-size=900,700', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:9260/json/list'); targets = await res.json(); if (targets.length) break } catch {}; await sleep(200) }
const cdp = new CDP((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
await cdp.open(); await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
const b64 = fs.readFileSync(SRC).toString('base64')
await cdp.eval('window.__B64 = "' + b64 + '"')
const result = await cdp.eval(Buffer.from('KGFzeW5jICgpID0+IHsKIGNvbnN0IGltZyA9IG5ldyBJbWFnZSgpOyBpbWcuc3JjID0gJ2RhdGE6aW1hZ2UvcG5nO2Jhc2U2NCwnICsgd2luZG93Ll9fQjY0OwogYXdhaXQgbmV3IFByb21pc2UoKHJlcywgcmVqKSA9PiB7IGltZy5vbmxvYWQgPSByZXM7IGltZy5vbmVycm9yID0gcmVqIH0pOwogY29uc3QgYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2NhbnZhcycpOyBjLndpZHRoID0gaW1nLndpZHRoOyBjLmhlaWdodCA9IGltZy5oZWlnaHQ7CiBjb25zdCBjdHggPSBjLmdldENvbnRleHQoJzJkJyk7IGN0eC5kcmF3SW1hZ2UoaW1nLCAwLCAwKTsKIGNvbnN0IGRhdGEgPSBjdHguZ2V0SW1hZ2VEYXRhKDAsIDAsIGltZy53aWR0aCwgaW1nLmhlaWdodCkuZGF0YTsKIGNvbnN0IFcgPSBpbWcud2lkdGgsIEggPSBpbWcuaGVpZ2h0OwogY29uc3QgYmx1ZSA9IFtdOwogZm9yIChsZXQgeSA9IDA7IHkgPCBIOyB5KyspIHsgZm9yIChsZXQgeCA9IDA7IHggPCBXOyB4KyspIHsgY29uc3QgaSA9ICh5ICogVyArIHgpICogNDsgY29uc3QgYiA9IGRhdGFbaSsyXSwgciA9IGRhdGFbaV0sIGcgPSBkYXRhW2krMV07IGlmIChiID4gOTAgJiYgYiA+IHIgKyAxNSAmJiBiID4gZyArIDEwKSBibHVlLnB1c2goe3gseX0pIH0gfQogY29uc3Qgb3V0ID0geyBXLCBILCBibHVlQ291bnQ6IGJsdWUubGVuZ3RoIH07CiBpZiAoIWJsdWUubGVuZ3RoKSByZXR1cm4geyAuLi5vdXQsIGVycm9yOiAnbm8gYmx1ZScgfTsKIGNvbnN0IG1pblggPSBNYXRoLm1pbiguLi5ibHVlLm1hcChwPT5wLngpKSwgbWluWSA9IE1hdGgubWluKC4uLmJsdWUubWFwKHA9PnAueSkpOwogY29uc3QgbWF4WCA9IE1hdGgubWF4KC4uLmJsdWUubWFwKHA9PnAueCkpLCBtYXhZID0gTWF0aC5tYXgoLi4uYmx1ZS5tYXAocD0+cC55KSk7CiBvdXQuYmx1ZUJveCA9IHsgbWluWCwgbWluWSwgbWF4WCwgbWF4WSB9OwogY29uc3QgZGFya0NvbHMgPSBbXTsKIGZvciAobGV0IHggPSBtaW5YICsgMzsgeCA8IG1pblggKyAxMjAgJiYgeCA8IFc7IHgrKykgewogICBsZXQgZGFya0NvdW50ID0gMDsKICAgZm9yIChsZXQgeSA9IG1pblk7IHkgPD0gbWF4WTsgeSsrKSB7CiAgICAgY29uc3QgaSA9ICh5ICogVyArIHgpICogNDsKICAgICBpZiAoZGF0YVtpXSA8IDkwICYmIGRhdGFbaSsxXSA8IDkwICYmIGRhdGFbaSsyXSA8IDkwKSBkYXJrQ291bnQrKzsKICAgfQogICBpZiAoZGFya0NvdW50ID4gMykgZGFya0NvbHMucHVzaCh4KTsKIH0KIG91dC5kYXJrQ29scyA9IGRhcmtDb2xzOwogY29uc3QgcnVucyA9IFtdOwogaWYgKGRhcmtDb2xzLmxlbmd0aCkgewogICBsZXQgcyA9IGRhcmtDb2xzWzBdLCBwID0gZGFya0NvbHNbMF07CiAgIGZvciAobGV0IGkgPSAxOyBpIDw9IGRhcmtDb2xzLmxlbmd0aDsgaSsrKSB7CiAgICAgaWYgKGkgPT09IGRhcmtDb2xzLmxlbmd0aCB8fCBkYXJrQ29sc1tpXSA+IHAgKyA0KSB7IHJ1bnMucHVzaChbcywgcF0pOyBzID0gZGFya0NvbHNbaV07IH0KICAgICBwID0gZGFya0NvbHNbaV07CiAgIH0KIH0KIG91dC5jaGFyUnVucyA9IHJ1bnM7CiBjb25zdCBjaGFyU2hhcGVzID0gcnVucy5zbGljZSgwLCA4KS5tYXAocnVuID0+IHsKICAgY29uc3QgW3MsIGVdID0gcnVuOwogICBjb25zdCByb3dzID0gW107CiAgIGZvciAobGV0IHkgPSBtaW5ZOyB5IDw9IG1heFk7IHkrKykgewogICAgIGxldCBjbnQgPSAwOwogICAgIGZvciAobGV0IHggPSBzOyB4IDw9IGU7IHgrKykgewogICAgICAgY29uc3QgaSA9ICh5ICogVyArIHgpICogNDsKICAgICAgIGlmIChkYXRhW2ldIDwgOTAgJiYgZGF0YVtpKzFdIDwgOTAgJiYgZGF0YVtpKzJdIDwgOTApIGNudCsrOwogICAgIH0KICAgICBpZiAoY250ID4gMCkgcm93cy5wdXNoKHsgeTogeSAtIG1pblksIGNudCB9KTsKICAgfQogICByZXR1cm4geyBzLCBlLCB3OiBlIC0gcyArIDEsIGg6IHJvd3MubGVuZ3RoID8gcm93c1tyb3dzLmxlbmd0aC0xXS55IC0gcm93c1swXS55ICsgMSA6IDAsIHJvd3MgfTsKIH0pCiBvdXQuY2hhclNoYXBlcyA9IGNoYXJTaGFwZXM7CiByZXR1cm4gb3V0Owp9KSgp', 'base64').toString('utf8'))
console.log(JSON.stringify(result, null, 1))
cdp.close(); chrome.kill(); await sleep(800)
try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch {}
process.exit(0)
