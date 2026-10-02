/* idb.js — IndexedDB 底座
 *
 * 从 FileProcessor.js 拆出来，好处：
 *   1. 文件内容缓存（fileCache.js）与句柄/批注存储共用同一套 DB 与请求封装；
 *   2. 缓存逻辑可以在 Node 里用 IDB mock 单测（FileProcessor.js 因为 import 了
 *      `pdfjs-dist/build/pdf.worker.min.mjs?worker` 这种 Vite 专有写法，Node 加载不了）。
 *
 * 注意：新增 store 时必须同时把 DB_VERSION 加一（openDb 里的 onupgradeneeded 才会触发）。
 */

export const DB_NAME = 'noteflow-store'
export const DB_VERSION = 4
export const HANDLE_STORE = 'handles'
export const ANNOT_DATA_STORE = 'ann-data'
/** APK / 无 File System Access API 时缓存文件内容，供「最近文件」跨会话重开 */
export const BLOB_STORE = 'file-blobs'

export function openDb() {
  return new Promise((resolve, reject) => {
    // 强制升级版本以确保所有 store 存在（解决 "object store not found" 错误：
    // 旧 DB 在同一版本中可能缺少新增的 store，onupgradeneeded 不会触发）
    const DB_VER_MAX = Math.max(DB_VERSION, 4)
    const req = indexedDB.open(DB_NAME, DB_VER_MAX)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE, { keyPath: 'key' })
      }
      if (!db.objectStoreNames.contains(ANNOT_DATA_STORE)) {
        db.createObjectStore(ANNOT_DATA_STORE, { keyPath: 'key' })
      }
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        db.createObjectStore(BLOB_STORE, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function idbRequest(storeName, mode, fn) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode)
    const store = tx.objectStore(storeName)
    const req = fn(store)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
