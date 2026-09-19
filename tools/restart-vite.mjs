import { spawn, execSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, createWriteStream } from 'node:fs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
async function killPort(port) {
  const ps = new URL('file:///C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
  try {
    const script = '(Get-NetTCPConnection -LocalPort ' + port + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)'
    const out = execSync('powershell -NoProfile -Command "' + script + '"').toString().trim()
    for (const pid of out.split(/\s+/).filter(Boolean)) {
      console.log('kill ' + pid)
      try { execSync('taskkill /PID ' + pid + ' /F /T') } catch (e) { console.log('taskkill fail ' + e.message) }
    }
  } catch (e) { console.log('no listener: ' + e.message.slice(0, 80)) }
}
await killPort(5199)
await new Promise((r) => setTimeout(r, 1500))
mkdirSync(join(root, 'tmp'), { recursive: true })
const child = spawn('node', [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5199'], {
  cwd: root, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
})
const outLog = createWriteStream(join(root, 'tmp', 'vite-5199.log'), { flags: 'a' })
const errLog = createWriteStream(join(root, 'tmp', 'vite-5199-err.log'), { flags: 'a' })
child.stdout.pipe(outLog); child.stderr.pipe(errLog)
child.unref()
console.log('vite PID ' + child.pid)
