/**
 * 模型管理（Vosk / GGUF / MLX 量化 ASR 模型）
 * ==================================================
 * 通过本地 server（默认 http://127.0.0.1:8000）的 /models 接口管理：
 *   GET  /models          -> 模型清单 + 状态（已下载 / 下载中 / 错误）
 *   POST /models/download -> 开始下载（body: { id }）
 *   DELETE /models/{id}   -> 停止下载并删除
 *
 * 首次打开时自动检测 vosk 模型状态，弹出下载提示。
 * 状态通过 localStorage 持久化，跨会话记忆「已提示」状态。
 */

const SERVER_BASE = 'http://127.0.0.1:8000'
const STORAGE_KEY = 'noteStudio.modelPrompted.v1'
const SETTINGS_KEY = 'noteStudio.speechSettings.v1'

export const MODEL_KINDS = {
  vosk: 'vosk',
  gguf: 'gguf',
  mlx: 'mlx',
}

/** 拉取服务器模型清单 */
export async function fetchModelStatus() {
  try {
    const res = await fetch(SERVER_BASE + '/models', { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.json()
  } catch {
    return { models: [], vosk: { builtin: false, sizeBytes: 0 } }
  }
}

/** 开始下载模型（后台线程） */
export async function downloadModel(modelId) {
  const res = await fetch(SERVER_BASE + '/models/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: modelId }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error('下载失败：' + text)
  }
  return res.json()
}

/** 停止下载并删除模型 */
export async function deleteModel(modelId) {
  const res = await fetch(SERVER_BASE + '/models/' + modelId, { method: 'DELETE' })
  if (!res.ok) {
    const text = await res.text()
    throw new Error('删除失败：' + text)
  }
  return res.json()
}

/** 判断是否已弹窗提示过首次下载（localStorage） */
export function hasPromptedDownload() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** 标记已弹窗（首次提示后调用，避免重复） */
export function markPrompted() {
  try {
    localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    /* ignore */
  }
}

/**
 * 检查 Vosk 模型可用性：
 *  1. 本地 public/models/ 已有 → builtin=true，无需下载
 *  2. 服务器有但本地没有 → 需要下载
 *  3. 服务器不可达 → 依赖本地文件
 */
export function checkVoskAvailability(serverStatus) {
  const localModel = findLocalVoskModel()
  if (localModel) return { available: true, source: 'local', sizeBytes: localModel.sizeBytes }
  const srvVosk = serverStatus?.vosk
  if (srvVosk?.builtin) return { available: true, source: 'server', sizeBytes: srvVosk.sizeBytes }
  return { available: false, source: null, sizeBytes: 0 }
}

/** 扫描 public/models/ 找已有的 .tar.gz 模型（注意：Vite 开发服务器无法直接读文件系统） */
function findLocalVoskModel() {
  // 浏览器无法直接读文件系统，通过 HTTP 探测
  // 如果 /models/vosk-model-small-cn-0.22.tar.gz 可访问，则认为已内置
  return null // 改由 fetch 探测
}

/** 通过 HTTP 探测本地模型是否可访问 */
export async function probeLocalVosk() {
  try {
    const res = await fetch('/models/vosk-model-small-cn-0.22.tar.gz', { method: 'HEAD', signal: AbortSignal.timeout(3000) })
    if (res.ok) {
      return { available: true, sizeBytes: parseInt(res.headers.get('content-length') || '0', 10) }
    }
  } catch {
    /* ignore */
  }
  return { available: false, sizeBytes: 0 }
}

/**
 * 首次打开检测：返回 { needPrompt: boolean, modelInfo: {...} }
 * needPrompt=true 时前端弹出「是否下载 Vosk 模型」提示
 */
export async function checkFirstOpen() {
  const server = await fetchModelStatus().catch(() => ({ models: [], vosk: { builtin: false } }))
  const hasPrompted = hasPromptedDownload()
  // 只提示「量化模型」：Vosk 中文小模型已内置，GGUF / MLX 为可选下载
  const missing = (server.models || []).filter((m) => !m.downloaded && !m.downloading)
  const voskBuiltin = !!server.vosk?.builtin

  return {
    hasPrompted,
    voskBuiltin,
    missing,
    needPrompt: !hasPrompted && missing.length > 0,
    server,
  }
}

/** 更新 speech settings 中的 voskModelUrl */
export function updateVoskModelUrl(url) {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    const settings = raw ? { ...JSON.parse(raw) } : {}
    settings.voskModelUrl = url
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    return true
  } catch {
    return false
  }
}

/** 获取当前 Vosk 模型 URL */
export function getVoskModelUrl() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return '/models/vosk-model-small-cn-0.22.tar.gz'
    const s = JSON.parse(raw)
    return s.voskModelUrl || '/models/vosk-model-small-cn-0.22.tar.gz'
  } catch {
    return '/models/vosk-model-small-cn-0.22.tar.gz'
  }
}

/** 格式化文件大小 */
export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i]
}
