// nativeSave.js — APK 内把字节写进手机「下载」目录（Capacitor 本地插件 SaveToDownloads）。
//
// 为什么不用 @capacitor/filesystem：它没有 Directory.Downloads，Android 11+ 也写不了
// 公共下载目录；WebView 又不认 <a download>。保存必须走原生 MediaStore（见
// android/.../SaveToDownloadsPlugin.java：API 29+ MediaStore，23~28 传统文件路径）。
//
// 协议是「分块写入」：begin → write* → end，避免把几十 MB 的 PDF 一次性塞进单次桥调用。
// 每块独立 base64（JS 分块编码、Java 分块解码后顺序追加），块长不必对齐。
import { Capacitor, registerPlugin } from '@capacitor/core'

const SaveToDownloads = registerPlugin('SaveToDownloads')

/** 是否在原生 Android 壳里（决定保存走原生插件还是 <a download> 兜底） */
export function isNativeSaveAvailable() {
  try {
    return Boolean(
      Capacitor.isNativePlatform && Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android',
    )
  } catch {
    return false
  }
}

/** 每块 192KB（3 的倍数，分块 base64 干净） */
const CHUNK_BYTES = 3 * 64 * 1024

/** Uint8Array → base64（按 32KB 切片拼字符串，避免 String.fromCharCode 参数爆栈） */
function bytesToBase64(bytes) {
  let bin = ''
  const SLICE = 0x8000
  for (let i = 0; i < bytes.length; i += SLICE) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + SLICE, bytes.length)))
  }
  return btoa(bin)
}

/** 任意保存入参 → Uint8Array（文本 / Blob / TypedArray 统一入口） */
async function toBytes(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data)
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  return new Uint8Array(data)
}

/**
 * 写进手机下载目录（Download/Note Studio/，同名截断覆盖，不产生「副本(1)」）。
 * @param {string} name 文件名（含扩展名）
 * @param {string|Uint8Array|ArrayBuffer|Blob} data 内容
 * @returns {Promise<string>} 展示用相对路径，如 Download/Note Studio/笔记.md
 */
export async function saveToDownloads(name, data) {
  const bytes = await toBytes(data)
  const { id } = await SaveToDownloads.begin({ name })
  try {
    for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
      await SaveToDownloads.write({ id, data: bytesToBase64(bytes.subarray(i, i + CHUNK_BYTES)) })
    }
    const res = await SaveToDownloads.end({ id })
    return res.path
  } catch (err) {
    await SaveToDownloads.cancel({ id }).catch(() => {})
    throw err
  }
}
