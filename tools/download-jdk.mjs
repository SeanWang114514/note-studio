import { createWriteStream, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'vendor', 'jdk25')
mkdirSync(dir, { recursive: true })
const target = join(dir, 'jdk.zip')
const url = process.argv[2] || 'https://api.adoptium.net/v3/binary/latest/25/ga/windows/x64/jdk/hotspot/normal/eclipse'
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
  if (total && done % (512 * 1024) === 0) console.log('progress ' + Math.round((done / total) * 100) + '% (' + Math.round(done / 1048576) + ' MB)')
}
await new Promise((resolve2, reject) => out.end((err) => (err ? reject(err) : resolve2())))
console.log('done ' + target + ' ' + Math.round(done / 1048576) + ' MB')
