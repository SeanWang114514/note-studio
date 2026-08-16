// 下载 open-pdf-studio 源码 vendor 到工作区副本（Node 版，更可靠）
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const BASE = 'D:/VibeCoding/note apps/note-studio/vendor/open-pdf-studio'
const API = 'https://api.github.com/repos/OpenAEC-Foundation/open-pdf-studio/git/trees/main?recursive=1'
const RAW = 'https://raw.githubusercontent.com/OpenAEC-Foundation/open-pdf-studio/main'

const tree = await (await fetch(API, { headers: { 'User-Agent': 'dsh' } })).json()
if (!tree.tree) throw new Error('tree fetch failed: ' + JSON.stringify(tree).slice(0, 300))

const files = tree.tree.filter((f) =>
  f.type === 'blob' &&
  f.path.startsWith('open-pdf-studio/') &&
  !f.path.startsWith('open-pdf-studio/public/') &&
  !f.path.includes('/node_modules/') &&
  f.size < 2000000,
)
console.log('TOTAL FILES TO VENDOR:', files.length)

let ok = 0, fail = 0
for (const f of files) {
  const rel = f.path.replace(/^open-pdf-studio\//, '')
  const dest = join(BASE, rel)
  if (existsSync(dest) && statSync(dest).size > 0) { continue }
  mkdirSync(dirname(dest), { recursive: true })
  try {
    const res = await fetch(`${RAW}/${f.path}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(dest, buf)
    ok++
  } catch (e) {
    fail++
    console.log('FAIL', f.path, e.message)
  }
  if ((ok + fail) % 50 === 0) console.log(`progress: ${ok + fail}/${files.length}`)
}
console.log(`DOWNLOADED=${ok} FAILED=${fail}`)
console.log('VENDOR SIZE MB:', Math.round(statSync(BASE).size / 1048576 * 100) / 100)
