import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const state = join(root, 'tmp', 'stirling')
const pidFile = join(state, 'stirling.pid')
const base = 'http://127.0.0.1:8080'
const jars = [process.env.STIRLING_JAR, join(root, 'vendor', 'stirling-pdf', 'stirling-pdf.jar'), join(root, 'vendor', 'stirling-pdf', 'Stirling-PDF-server.jar'), join(root, 'vendor', 'stirling-pdf', 'Stirling-PDF.jar')].filter(Boolean)
function bundledJava() {
  try {
    const jdkDir = join(root, 'vendor', 'jdk25')
    for (const entry of readdirSync(jdkDir)) {
      const java = join(jdkDir, entry, 'bin', 'java.exe')
      if (entry.startsWith('jdk-') && existsSync(java)) return java
    }
  } catch {}
  return null
}
async function healthy() { try { const r = await fetch(base, { signal: AbortSignal.timeout(1500) }); return r.status < 500 } catch { return false } }
function readPid() { try { return Number.parseInt(readFileSync(pidFile, 'utf8'), 10) || 0 } catch { return 0 } }
async function main() {
  if (process.argv.includes('--stop')) { const p = readPid(); if (p) { try { process.kill(p) } catch {} }; try { unlinkSync(pidFile) } catch {}; console.log('Stirling-PDF stopped'); return }
  if (await healthy()) { console.log('Stirling-PDF already available at ' + base); return }
  if (process.argv.includes('--status')) { console.log('Stirling-PDF unavailable at ' + base); return }
  const jar = jars.find(existsSync)
  if (!jar) { console.warn('Stirling-PDF JAR not found. Put it at vendor/stirling-pdf/stirling-pdf.jar.'); return }
  const java = bundledJava() || 'java'
  mkdirSync(state, { recursive: true })
  const child = spawn(java, ['-jar', jar, '--server.port=8080'], { cwd: dirname(jar), detached: true, stdio: 'ignore', windowsHide: true })
  child.unref(); writeFileSync(pidFile, String(child.pid)); console.log('Starting Stirling-PDF with ' + java + ', PID ' + child.pid)
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
