/* fileCache.js — 文件内容本地缓存
 *
 * 为什么需要：安卓 APK 走 <input type=file> 打开文件，拿不到 FileSystemFileHandle，
 * 句柄持久化那条路在 APK 里等于没有 —— 点「最近文件」必定报「找不到该文件，请重新打开」。
 * 所以这里把打开过的文件内容存一份到 IndexedDB，最近文件直接从缓存重开。
 *
 * 约束：
 *   - 单文件超过 BLOB_MAX_FILE 不缓存（避免手机存储被一个大 PDF 塞满）；
 *   - 总量超过 BLOB_MAX_TOTAL 时按「最近使用」淘汰最旧的；
 *   - 所有写操作失败都静默 —— 缓存只是加分项，绝不能影响打开/保存本身；
 *   - 清缓存只清这一份副本，不动批注（ann-data）、句柄（handles）与已保存到下载目录的文件。
 */

import { BLOB_STORE, idbRequest } from './idb.js'

/** 单个文件超过这个大小就不缓存 */
export const BLOB_MAX_FILE = 64 * 1024 * 1024
/** 缓存总量上限，超出后按最近使用时间淘汰最旧的 */
export const BLOB_MAX_TOTAL = 256 * 1024 * 1024

function fileToBlobRecord(id, file, name) {
  return {
    key: `blob:${id}`,
    id,
    name: name || file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    lastModified: file.lastModified || Date.now(),
    blob: file,
    savedAt: Date.now(),
  }
}

/** 淘汰最久未使用的缓存，直到总量回到上限内。 */
export async function evictBlobCache() {
  const rows = await idbRequest(BLOB_STORE, 'readonly', (s) => s.getAll())
  let total = rows.reduce((sum, r) => sum + (r?.size || 0), 0)
  if (total <= BLOB_MAX_TOTAL) return 0
  let removed = 0
  const oldestFirst = rows.slice().sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0))
  for (const row of oldestFirst) {
    if (total <= BLOB_MAX_TOTAL) break
    await idbRequest(BLOB_STORE, 'readwrite', (s) => s.delete(row.key))
    total -= row.size || 0
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
      await idbRequest(BLOB_STORE, 'readwrite', (s) => s.delete(`blob:${id}`))
      return false
    }
    await idbRequest(BLOB_STORE, 'readwrite', (s) => s.put(fileToBlobRecord(id, file, name)))
    await evictBlobCache()
    return true
  } catch {
    return false
  }
}

/** 读回缓存内容：返回可直接构造 File 的记录，没有则 null。 */
export async function getFileBlob(id) {
  try {
    const row = await idbRequest(BLOB_STORE, 'readonly', (s) => s.get(`blob:${id}`))
    if (!row?.blob) return null
    // 顺带刷新使用时间，让淘汰按「最近打开」而不是「最近写入」来算
    idbRequest(BLOB_STORE, 'readwrite', (s) => s.put({ ...row, savedAt: Date.now() })).catch(
      () => {},
    )
    return row
  } catch {
    return null
  }
}

/** 缓存用量：{count, bytes}。 */
export async function fileCacheStats() {
  try {
    const rows = await idbRequest(BLOB_STORE, 'readonly', (s) => s.getAll())
    return {
      count: rows.length,
      bytes: rows.reduce((sum, r) => sum + (r?.size || 0), 0),
    }
  } catch {
    return { count: 0, bytes: 0 }
  }
}

/** 清空文件内容缓存，返回释放的 {removed, bytes}。 */
export async function clearFileCache() {
  const before = await fileCacheStats()
  await idbRequest(BLOB_STORE, 'readwrite', (s) => s.clear())
  return { removed: before.count, bytes: before.bytes }
}
