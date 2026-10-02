/* fileCache.js — 文件内容本地缓存
 *
 * 为什么需要：安卓 APK 走 <input type=file> 打开文件，拿不到 FileSystemFileHandle，
 * 句柄持久化那条路在 APK 里等于没有 —— 点「最近文件」必定报「找不到该文件，请重新打开」。
 * 所以这里把打开过的文件内容存一份到 IndexedDB，最近文件直接从缓存重开。
 *
 * 分两张表（重要）：
 *   - file-blobs      ：只有实体 {key, blob}
 *   - file-blob-meta  ：只有元数据 {key, id, name, type, size, lastModified, savedAt}
 *   统计用量、LRU 淘汰、存在性检查都只碰元数据表。如果混在一张表里，
 *   getAll() 会把上百 MB 的 blob 实体全部读出来 —— 而每次写入都要跑一次淘汰，
 *   手机上直接卡死；保存后的「缓存是否存在」检查也会白读一遍大文件。
 *
 * 约束：
 *   - 单文件超过 BLOB_MAX_FILE 不缓存（避免手机存储被一个大 PDF 塞满）；
 *   - 总量超过 BLOB_MAX_TOTAL 时按「最近使用」淘汰最旧的；
 *   - 所有写操作失败都静默 —— 缓存只是加分项，绝不能影响打开/保存本身；
 *   - 清缓存只清这两张表，不动批注（ann-data）、句柄（handles）与已保存到下载目录的文件。
 */

import { BLOB_META_STORE, BLOB_STORE, idbRequest } from './idb.js'

/** 单个文件超过这个大小就不缓存 */
export const BLOB_MAX_FILE = 64 * 1024 * 1024
/** 缓存总量上限，超出后按最近使用时间淘汰最旧的 */
export const BLOB_MAX_TOTAL = 256 * 1024 * 1024

const blobKey = (id) => `blob:${id}`
const metaKey = (id) => `meta:${id}`

/** 只有实体、没有元数据（或反过来）的残留记录，读的时候顺手清掉。 */
async function dropEntry(id) {
  await idbRequest(BLOB_STORE, 'readwrite', (s) => s.delete(blobKey(id)))
  await idbRequest(BLOB_META_STORE, 'readwrite', (s) => s.delete(metaKey(id)))
}

/** 淘汰最久未使用的缓存，直到总量回到上限内（只读元数据表）。 */
export async function evictBlobCache() {
  const metas = await idbRequest(BLOB_META_STORE, 'readonly', (s) => s.getAll())
  let total = metas.reduce((sum, m) => sum + (m?.size || 0), 0)
  if (total <= BLOB_MAX_TOTAL) return 0
  let removed = 0
  const oldestFirst = metas.slice().sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0))
  for (const meta of oldestFirst) {
    if (total <= BLOB_MAX_TOTAL) break
    await dropEntry(meta.id)
    total -= meta.size || 0
    removed += 1
  }
  return removed
}

/**
 * 把文件内容写入本地缓存。仅用于没有句柄的条目（APK / 浏览器 input 路径）。
 * 返回是否写入成功；失败不抛错。
 */
export async function putFileBlob(id, file, name) {
  try {
    if (!file || typeof file.size !== 'number') return false
    if (file.size > BLOB_MAX_FILE) {
      // 太大：清掉同名旧缓存，避免留下过期内容被当成最新版重开
      await dropEntry(id)
      return false
    }
    const meta = {
      key: metaKey(id),
      id,
      name: name || file.name || '未命名',
      type: file.type || 'application/octet-stream',
      size: file.size,
      lastModified: file.lastModified || Date.now(),
      savedAt: Date.now(),
    }
    await idbRequest(BLOB_STORE, 'readwrite', (s) => s.put({ key: blobKey(id), blob: file }))
    await idbRequest(BLOB_META_STORE, 'readwrite', (s) => s.put(meta))
    await evictBlobCache()
    return true
  } catch {
    return false
  }
}

/** 该 id 有没有缓存（只读元数据，不碰实体）。 */
export async function hasFileBlob(id) {
  try {
    const meta = await idbRequest(BLOB_META_STORE, 'readonly', (s) => s.get(metaKey(id)))
    return Boolean(meta)
  } catch {
    return false
  }
}

/**
 * 从「已经在内存里的字节」写缓存。
 *
 * 为什么必须走这个入口而不是 putFileBlob(id, file)：
 * 安卓里 <input type=file> 选中的文件是 content:// URI 支撑的 blob，**不是随便重读的**。
 * 打开文件时应用正拿同一个 File 去 file.arrayBuffer() 喂 pdf.js，如果这时并发地把
 * 同一个 blob 写进 IndexedDB，两次读会互相卡住 —— 表现就是空白页一直显示
 * 「正在打开 PDF…」，不报错也不结束（这正是 v0.1.16 引入的回归）。
 *
 * 所以：缓存只吃调用方已经读出来的字节，绝不再去碰原始 File。
 */
export async function putFileBlobBytes(id, name, bytes, type) {
  try {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    if (!buf.byteLength) return false
    if (buf.byteLength > BLOB_MAX_FILE) {
      await dropEntry(id)
      return false
    }
    // 原样存字节副本（Blob 由 IndexedDB 自己落盘，不再持有源 File）
    const blob = new Blob([buf], { type: type || 'application/octet-stream' })
    const meta = {
      key: metaKey(id),
      id,
      name: name || '未命名',
      type: type || 'application/octet-stream',
      size: buf.byteLength,
      lastModified: Date.now(),
      savedAt: Date.now(),
    }
    await idbRequest(BLOB_STORE, 'readwrite', (s) => s.put({ key: blobKey(id), blob }))
    await idbRequest(BLOB_META_STORE, 'readwrite', (s) => s.put(meta))
    await evictBlobCache()
    return true
  } catch {
    return false
  }
}

/**
 * 串行化的「打开后再缓存」队列。
 *
 * 打开文件时把字节排进队列（调用方已经读过这些字节，这里只是复制一份进 IDB）；
 * 队列保证同一时间只有一次写入，避免大文件同时落盘把 WebView 卡住。
 */
let cacheQueue = Promise.resolve()
const queuedIds = new Set()

/** 把任意异步任务排进串行队列（同一时间只跑一个，失败不打断后续）。 */
export function queueJob(fn) {
  cacheQueue = cacheQueue.then(fn).catch(() => false)
  return cacheQueue
}

export function queueFileBlobBytes(id, name, bytes, type) {
  if (!id || !bytes || queuedIds.has(id)) return cacheQueue
  queuedIds.add(id)
  return queueJob(() => putFileBlobBytes(id, name, bytes, type)).then((ok) => {
    queuedIds.delete(id)
    return ok
  })
}

/** 等待队列里排着的缓存写完（测试/退出前用）。 */
export function flushFileBlobQueue() {
  return cacheQueue
}

/** 读回缓存内容：返回 {blob, name, type, lastModified, size}，没有则 null。 */
export async function getFileBlob(id) {
  try {
    const meta = await idbRequest(BLOB_META_STORE, 'readonly', (s) => s.get(metaKey(id)))
    if (!meta) return null
    const payload = await idbRequest(BLOB_STORE, 'readonly', (s) => s.get(blobKey(id)))
    if (!payload?.blob) {
      // 实体丢了（写入中断/被系统清理）：清掉元数据，免得留下假缓存
      await idbRequest(BLOB_META_STORE, 'readwrite', (s) => s.delete(metaKey(id)))
      return null
    }
    // 顺带刷新使用时间（写的是元数据，代价很小），让淘汰按「最近打开」算
    idbRequest(BLOB_META_STORE, 'readwrite', (s) =>
      s.put({ ...meta, savedAt: Date.now() }),
    ).catch(() => {})
    return { ...meta, blob: payload.blob }
  } catch {
    return null
  }
}

/** 缓存用量：{count, bytes}（只读元数据表）。 */
export async function fileCacheStats() {
  try {
    const metas = await idbRequest(BLOB_META_STORE, 'readonly', (s) => s.getAll())
    return {
      count: metas.length,
      bytes: metas.reduce((sum, m) => sum + (m?.size || 0), 0),
    }
  } catch {
    return { count: 0, bytes: 0 }
  }
}

/** 清空文件内容缓存，返回释放的 {removed, bytes}。 */
export async function clearFileCache() {
  const before = await fileCacheStats()
  await idbRequest(BLOB_STORE, 'readwrite', (s) => s.clear())
  await idbRequest(BLOB_META_STORE, 'readwrite', (s) => s.clear())
  return { removed: before.count, bytes: before.bytes }
}
