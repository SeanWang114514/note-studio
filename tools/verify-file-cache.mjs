// 验证 src/lib/fileCache.js：用最小 IndexedDB mock 跑缓存写入 / 上限淘汰 / 清除。
// 运行：npm run verify:file-cache
//
// （FileProcessor.js 里 import 了 `pdfjs-dist/...?worker` 这种 Vite 专有写法，
//   在 Node 里加载不了，所以缓存逻辑拆到 fileCache.js + idb.js 才能这样单测。）
import assert from 'node:assert/strict'

// ─── 最小 IndexedDB mock（同一 name+version 复用同一个「数据库」以保留数据）──
class FakeRequest {
  constructor() {
    this.onsuccess = null
    this.onerror = null
    this.onupgradeneeded = null
    this.result = undefined
  }
}

function settle(req, result) {
  queueMicrotask(() => {
    req.result = result
    req.onsuccess?.({ target: req })
  })
  return req
}

class FakeStore {
  constructor(map, keyPath) {
    this.map = map
    this.keyPath = keyPath
  }
  put(value) {
    this.map.set(value[this.keyPath], value)
    return settle(new FakeRequest(), undefined)
  }
  get(key) {
    return settle(new FakeRequest(), this.map.get(key))
  }
  getAll() {
    return settle(new FakeRequest(), [...this.map.values()])
  }
  delete(key) {
    this.map.delete(key)
    return settle(new FakeRequest(), undefined)
  }
  clear() {
    this.map.clear()
    return settle(new FakeRequest(), undefined)
  }
}

class FakeDB {
  constructor() {
    this.stores = new Map()
    this.keyPaths = new Map()
    this.objectStoreNames = { contains: (name) => this.stores.has(name) }
  }
  createObjectStore(name, opts) {
    this.stores.set(name, new Map())
    this.keyPaths.set(name, opts?.keyPath)
  }
  transaction(name) {
    const map = this.stores.get(name)
    if (!map) throw new Error(`object store not found: ${name}`)
    return { objectStore: () => new FakeStore(map, this.keyPaths.get(name)) }
  }
}

const fakeDbs = new Map()
globalThis.indexedDB = {
  open(name, version) {
    const req = new FakeRequest()
    const key = `${name}@${version}`
    queueMicrotask(() => {
      let db = fakeDbs.get(key)
      const isNew = !db
      if (isNew) {
        db = new FakeDB()
        fakeDbs.set(key, db)
      }
      req.result = db
      if (isNew) req.onupgradeneeded?.()
      req.onsuccess?.()
    })
    return req
  },
}

const { BLOB_MAX_FILE, BLOB_MAX_TOTAL, clearFileCache, fileCacheStats, flushFileBlobQueue, getFileBlob, hasFileBlob, putFileBlob, putFileBlobBytes, queueFileBlobBytes } =
  await import('../src/lib/fileCache.js')
const { BLOB_META_STORE, BLOB_STORE, DB_NAME, DB_VERSION } = await import('../src/lib/idb.js')

/** 直接看底层两张表，验证「元数据与实体分表」这个设计约束。 */
const rawStore = (storeName) => fakeDbs.get(`${DB_NAME}@${Math.max(DB_VERSION, 5)}`).stores.get(storeName)

const MB = 1024 * 1024
const fakeFile = (name, sizeMB) => ({
  name,
  type: 'application/pdf',
  size: Math.round(sizeMB * MB),
  lastModified: 1700000000000,
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 1. 基本写入 / 读取 / 统计 ──────────────────────────────────────────
assert.equal(await putFileBlob('file-a', fakeFile('a.pdf', 2)), true)
assert.equal(await putFileBlob('file-b', fakeFile('b.pdf', 3)), true)
let stats = await fileCacheStats()
assert.equal(stats.count, 2)
assert.equal(stats.bytes, 5 * MB)

const row = await getFileBlob('file-a')
assert.ok(row, '应能读回缓存')
assert.equal(row.name, 'a.pdf')
assert.equal(row.size, 2 * MB)
assert.equal(row.key, 'meta:file-a')
assert.ok(row.blob, '应带 blob 供构造 File')
assert.equal(await hasFileBlob('file-a'), true)
console.log('✓ 写入 / 读取 / 统计 / hasFileBlob')

// ── 2. 元数据与实体分表（这是性能设计约束，不是实现细节）──────────────
const blobStore = rawStore(BLOB_STORE)
const metaStore = rawStore(BLOB_META_STORE)
assert.equal(blobStore.size, 2, 'blob 表应只有实体记录')
assert.equal(metaStore.size, 2, 'meta 表应只有元数据记录')
for (const rec of blobStore.values()) {
  assert.deepEqual(Object.keys(rec).sort(), ['blob', 'key'], 'blob 表不得混入元数据')
}
for (const rec of metaStore.values()) {
  assert.ok(!('blob' in rec), 'meta 表不得混入实体')
  assert.ok('savedAt' in rec && 'size' in rec)
}
console.log('✓ 元数据与实体分表（统计/淘汰只碰元数据表）')

// ── 3. 未缓存的 id ────────────────────────────────────────────────────
assert.equal(await getFileBlob('file-nope'), null)
assert.equal(await hasFileBlob('file-nope'), false)
console.log('✓ 未命中返回 null / false')

// ── 4. 超大文件不缓存（并清掉同名旧缓存）──────────────────────────────
assert.equal(BLOB_MAX_FILE, 64 * MB)
assert.equal(await putFileBlob('file-huge', fakeFile('huge.pdf', 65)), false)
assert.equal(await getFileBlob('file-huge'), null)
assert.equal(await putFileBlob('file-big', fakeFile('big.pdf', 1)), true)
assert.ok(await getFileBlob('file-big'))
assert.equal(await putFileBlob('file-big', fakeFile('big.pdf', 100)), false)
assert.equal(await getFileBlob('file-big'), null, '超大文件应清掉同名旧缓存')
assert.equal(await hasFileBlob('file-big'), false)
assert.equal(blobStore.size, metaStore.size, '两表记录数应始终一致（不留孤儿实体）')
console.log('✓ 超大文件跳过 + 清理同名旧缓存（两表同步）')

// ── 5. 实体丢失时清掉假缓存 ──────────────────────────────────────────
await putFileBlob('file-ghost', fakeFile('ghost.pdf', 2))
blobStore.delete('blob:file-ghost') // 模拟写入中断 / 被系统清理
assert.equal(await getFileBlob('file-ghost'), null, '实体没了就不该报命中')
assert.equal(await hasFileBlob('file-ghost'), false, '元数据也应被清掉')
console.log('✓ 实体丢失时清理元数据（不产生假缓存）')

// ── 6. 读取刷新 savedAt（淘汰按「最近打开」算）───────────────────────
const before = (await getFileBlob('file-a')).savedAt
await sleep(8)
await getFileBlob('file-a')
const after = (await getFileBlob('file-a')).savedAt
assert.ok(after > before, 'savedAt 应被刷新')
console.log('✓ 读取刷新 savedAt')

// ── 7. 总量上限淘汰（最久未用的先走）─────────────────────────────────
assert.equal(BLOB_MAX_TOTAL, 256 * MB)
await clearFileCache()
const names = ['c1', 'c2', 'c3', 'c4', 'c5']
for (const n of names) {
  await sleep(6)
  assert.equal(await putFileBlob(`file-${n}`, fakeFile(`${n}.pdf`, 60)), true)
}
stats = await fileCacheStats()
assert.ok(stats.bytes <= BLOB_MAX_TOTAL, `总量应回到上限内，实际 ${stats.bytes / MB}MB`)
assert.equal(stats.count, 4, '300MB 写入后应淘汰到 4 个（240MB）')
assert.equal(await getFileBlob('file-c1'), null, '最久未用的 c1 应先被淘汰')
assert.ok(await getFileBlob('file-c2'), '较新的 c2 应保留')
assert.ok(await getFileBlob('file-c5'), '最新的 c5 应保留')
assert.equal(blobStore.size, metaStore.size, '淘汰后两表仍应一致')
console.log('✓ 总量上限淘汰（最久未用优先，两表一致）')

// ── 8. 最近打开的不会被淘汰 ──────────────────────────────────────────
await sleep(6)
await getFileBlob('file-c2') // 刷新 c2 的使用时间
await sleep(6)
await putFileBlob('file-c6', fakeFile('c6.pdf', 60))
assert.ok(await getFileBlob('file-c2'), '刚打开过的 c2 不应被淘汰')
console.log('✓ 最近打开的优先保留')

// ── 9. 清除缓存 ──────────────────────────────────────────────────────
const statsBefore = await fileCacheStats()
const cleared = await clearFileCache()
assert.equal(cleared.removed, statsBefore.count)
assert.equal(cleared.bytes, statsBefore.bytes)
assert.deepEqual(await fileCacheStats(), { count: 0, bytes: 0 })
assert.equal(await getFileBlob('file-c2'), null)
assert.equal(blobStore.size, 0)
assert.equal(metaStore.size, 0)
console.log('✓ 清除缓存（返回释放量 + 两表清空）')

// ── 10. 非法输入不抛错 ───────────────────────────────────────────────
assert.equal(await putFileBlob('file-x', null), false)
assert.equal(await putFileBlob('file-x', {}), false)
assert.deepEqual(await clearFileCache(), { removed: 0, bytes: 0 })
console.log('✓ 非法输入静默返回')

// ── 11. 字节入口（打开之后才缓存，避免和源文件读取抢流）──────────────
// 这是修「永远停在正在打开 PDF…」的关键：缓存只吃调用方已读出的字节，
// 绝不再去读那个 content:// 源文件。
const bytes = new Uint8Array([1, 2, 3, 4, 5])
assert.equal(await putFileBlobBytes('file-b1', 'b1.pdf', bytes, 'application/pdf'), true)
const b1 = await getFileBlob('file-b1')
assert.ok(b1, '字节入口应能写进缓存')
assert.equal(b1.size, 5)
assert.equal(b1.name, 'b1.pdf')
assert.equal(b1.type, 'application/pdf')
assert.equal(b1.blob.size, 5, 'blob 大小应与字节一致')
assert.equal(rawStore(BLOB_STORE).get('blob:file-b1').blob instanceof Blob, true)
// 超大字节同样跳过
assert.equal(await putFileBlobBytes('file-b2', 'b2.pdf', new Uint8Array(BLOB_MAX_FILE + 1)), false)
assert.equal(await getFileBlob('file-b2'), null)
assert.equal(await putFileBlobBytes('file-b3', 'b3.pdf', new Uint8Array(0)), false, '空字节不入缓存')
console.log('✓ 字节入口写入 / 大小上限 / 空字节')

// ── 12. 串行队列：按序落盘、同一 id 不重复排队、可等待收尾 ────────────
await clearFileCache()
for (const i of [1, 2, 3]) {
  queueFileBlobBytes(`file-q${i}`, `q${i}.pdf`, new Uint8Array([i, i, i]))
}
queueFileBlobBytes('file-q1', 'q1.pdf', new Uint8Array([9])) // 同一 id 重复排队应被忽略
await flushFileBlobQueue()
assert.deepEqual(await fileCacheStats(), { count: 3, bytes: 9 })
const q1 = await getFileBlob('file-q1')
assert.equal(q1.size, 3, '同一 id 的第二次排队不应覆盖/追加')
assert.equal(blobStore.size, metaStore.size)
console.log('✓ 串行队列（去重 + 可等待 + 两表一致）')

// ── 13. 回归护栏：选文件时不得并发写源文件 ───────────────────────────
// v0.1.16 的 bug：pickFiles 里顺手 putFileBlob(id, file)，而应用紧接着要拿同一个
// content:// blob 去 arrayBuffer() 喂 pdf.js —— 两次读互相卡住，界面永远停在
// 「正在打开 PDF…」，不报错也不结束。这条断言把「打开路径不许读源 blob」钉死。
const fs = await import('node:fs')
const path = await import('node:path')
const root = path.resolve(import.meta.dirname, '..')
const pickerSource = fs.readFileSync(path.join(root, 'src/lib/FileProcessor.js'), 'utf8')
const pickFilesBody = pickerSource.slice(
  pickerSource.indexOf('export async function pickFiles'),
  pickerSource.indexOf('export async function putFileHandle'),
)
assert.ok(!pickerSource.includes('putFileBlob(entry.id, file)'), '选文件路径不得把源 blob 写进缓存')
assert.ok(
  !/putFileBlob\w*\(\s*entry\.id\s*,\s*(file|entry\.file)\s*[,)]/.test(pickFilesBody),
  'pickFiles 里不得把源 File 交给缓存（会和 pdf.js 的读取抢同一个 content:// 流）',
)
assert.ok(
  pickerSource.includes('cacheAfterOpenDeferred'),
  '非 PDF 的读取路径应走「打开之后再缓存」',
)
const pdfView = fs.readFileSync(path.join(root, 'src/components/PdfEditorView.jsx'), 'utf8')
assert.ok(
  pdfView.includes('cacheAfterOpen(entry, openedBytes'),
  'PDF 视图应在打开成功后用已读出的字节缓存',
)
console.log('✓ 回归护栏：打开路径不读源 blob（缓存只在打开之后）')

console.log('\n全部断言通过 ✅')
