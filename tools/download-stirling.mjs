import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'vendor', 'stirling-pdf')
mkdirSync(dir, { recursive: true })
const target = join(dir, 'stirling-pdf.jar')
const url = process.argv[2] || 'https://github.com/Stirling-Tools/Stirling-PDF/releases/download/v2.14.3/Stirling-PDF-server.jar'
console.log('Downloading ' + url)
const res = await fetch(url, { headers: { 'User-Agent': 'note-studio', Accept: 'application/octet-stream' }, redirect: 'follow' })
if (!res.ok || !res.body) throw new Error('HTTP ' + res.status)
const total = Number(res.headers.get('content-length')) || 0
let done = 0
const out = createWriteStream(target)
const reader = res.body.getReader()
for (;;) {
  const { done: finished, value } = await reader.read()
  if (finished) break
  out.write(Buffer.from(value))
  done += value.length
  if (total && done % (256 * 1024) === 0) console.log('progress ' + Math.round((done / total) * 100) + '% (' + Math.round(done / 1048576) + ' MB)')
}
await new Promise((resolve2, reject) => out.end((err) => (err ? reject(err) : resolve2())))
console.log('done ' + target + ' ' + Math.round(done / 1048576) + ' MB')
