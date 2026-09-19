// mini-dispatch-test.html — 最小化测试：onDblClick 属性 vs addEventListener
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.listeners = new Map()
  }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      } else if (msg.method) { (this.listeners.get(msg.method) || []).forEach((fn) => fn(msg.params)) }
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
}

async function main() {
  const userData = path.join(__dirname, 'mini-profile-' + Date.now())
  const fs = await import('node:fs')
  fs.mkdirSync(userData, { recursive: true })
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9227', '--user-data-dir=' + userData,
    '--no-first-run', '--disable-gpu', '--window-size=800,600', 'about:blank',
  ], { stdio: 'ignore' })

  let targets = []
  for (let i = 0; i < 50; i++) {
    try { const res = await fetch('http://127.0.0.1:9227/json/list'); targets = await res.json(); if (targets.length) break } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  const cdp = new CDP((targets.find((t) => t.type === 'page') || targets[0]).webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  const html = `data:text/html,<html><body>
    <div id="a" style="width:100px;height:100px;background:red">A</div>
    <script>
      window.__log = [];
      const a = document.getElementById('a');
      // 1) 属性处理器
      a.onDblClick = function(e) { window.__log.push('prop:' + (e && e.type)); };
      // 2) addEventListener
      a.addEventListener('dblclick', function(e) { window.__log.push('listener:' + (e && e.type)); });
      // 3) dispatchEvent 原生事件
      const ev = new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 });
      const dispatched = a.dispatchEvent(ev);
      window.__dispatched = dispatched;
    </script>
  </body></html>`

  await cdp.send('Page.navigate', { url: html })
  await new Promise((r) => setTimeout(r, 1500))
  const res = await cdp.send('Runtime.evaluate', {
    expression: `({ log: window.__log, dispatched: window.__dispatched })`,
    returnByValue: true,
  })
  console.log('最小化测试结果:', JSON.stringify(res.result.value))

  cdp.close()
  chrome.kill()
  await new Promise((r) => setTimeout(r, 800))
  try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch { /* ignore */ }
  process.exit(0)
}

main().catch((err) => { console.error(err); process.exit(1) })
