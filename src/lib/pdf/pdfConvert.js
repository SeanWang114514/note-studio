// PDF ↔ DOCX 转换客户端：调用本地 Python 转换服务（server/convert_server.py）
// 服务默认 http://127.0.0.1:5198，可通过 VITE_CONVERT_URL 覆盖。
const CONVERT_BASE =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_CONVERT_URL) ||
  'http://127.0.0.1:5198'

/** 健康检查：服务是否在线、依赖是否齐全 */
export async function convertHealth() {
  const r = await fetchWithTimeout(`${CONVERT_BASE}/health`, { method: 'GET' }, 8000)
  if (!r.ok) throw new Error(`转换服务异常 (${r.status})`)
  return r.json()
}

/** 带超时的 fetch：超时抛 AbortError，避免界面无限等待；externalSignal 可外部取消 */
async function fetchWithTimeout(url, init = {}, timeoutMs, externalSignal) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const onExtAbort = () => ctrl.abort()
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort()
    else externalSignal.addEventListener('abort', onExtAbort)
  }
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
    if (externalSignal) externalSignal.removeEventListener('abort', onExtAbort)
  }
}

const jobUid = () =>
  globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `job-${Date.now()}-${Math.random().toString(36).slice(2)}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 轮询转换进度：POST 进行期间并行 GET /api/progress/<job>。
 * 进度对象形如 { percent, stage, done, total }（percent 可为 null = 不确定进度）。
 * 外部取消或主请求结束后会 abort 传入的 signal，循环随之退出。
 */
async function pollProgress(job, onProgress, signal) {
  while (!signal?.aborted) {
    try {
      const r = await fetchWithTimeout(`${CONVERT_BASE}/api/progress/${job}`, {}, 6000, signal)
      if (r.ok) {
        const j = await r.json()
        if (j && typeof j === 'object' && typeof onProgress === 'function') {
          onProgress(j)
          if (j.percent >= 100 || j.error) return
        }
      }
    } catch {
      // 进度查询失败（如连接中断）不影响主请求，继续等
    }
    await sleep(400)
  }
}

async function postBytes(path, bytes, contentType, opts = {}) {
  const { signal } = opts
  let r
  try {
    // 与服务器转换超时（默认 180s）对齐，略长一点以便优先收到服务端错误
    r = await fetchWithTimeout(
      `${CONVERT_BASE}${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: bytes,
      },
      190000,
      signal,
    )
  } catch (err) {
    if (err && err.name === 'AbortError') {
      if (signal?.aborted) throw new Error('转换已取消')
      throw new Error('转换超时（服务长时间无响应），已中断，请重试或检查文件')
    }
    throw new Error(`无法连接转换服务：${err?.message || err}`)
  }
  if (!r.ok) {
    let msg = `转换失败 (${r.status})`
    try {
      const j = await r.json()
      if (j && j.error) msg = j.error
    } catch {
      // 非 JSON 错误体，保留默认消息
    }
    throw new Error(msg)
  }
  return new Uint8Array(await r.arrayBuffer())
}

/**
 * 带进度上报的转换：并发轮询进度 + 主请求。
 * opts: { onProgress(progress), signal }
 */
async function convertWithProgress(path, bytes, contentType, opts = {}) {
  const { onProgress, signal } = opts
  const job = jobUid()
  // 轮询用的控制器：外部 signal 取消时同步中止轮询；主请求结束后也中止轮询
  const pollCtrl = new AbortController()
  const fwd = () => pollCtrl.abort()
  if (signal) {
    if (signal.aborted) pollCtrl.abort()
    else signal.addEventListener('abort', fwd)
  }
  const pollP = onProgress ? pollProgress(job, onProgress, pollCtrl.signal) : null
  try {
    const out = await postBytes(`${path}?job=${job}`, bytes, contentType, {
      signal: pollCtrl.signal,
    })
    if (typeof onProgress === 'function') onProgress({ percent: 100, stage: '转换完成', done: 0, total: 0 })
    return out
  } finally {
    pollCtrl.abort()
    if (signal) signal.removeEventListener('abort', fwd)
    if (pollP) await pollP.catch(() => {})
  }
}

/** PDF 字节 → DOCX 字节（pdf2docx-plus）。opts: { onProgress, signal } */
export async function pdfToDocxBytes(pdfBytes, opts = {}) {
  return convertWithProgress('/api/pdf2docx', pdfBytes, 'application/pdf', opts)
}

/** DOCX 字节 → PDF 字节（docx2pdf，本机 Word）。opts: { onProgress, signal } */
export async function docxToPdfBytes(docxBytes, opts = {}) {
  return convertWithProgress(
    '/api/docx2pdf',
    docxBytes,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    opts,
  )
}
