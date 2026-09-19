/** Local offline Stirling-PDF-compatible adapter. The Python service owns the PDF engine. */
const STIRLING_BASE = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_STIRLING_URL) || '/stirling'
const STIRLING_API_KEY = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_STIRLING_API_KEY) || ''

function headers() {
  return STIRLING_API_KEY ? { 'X-API-KEY': STIRLING_API_KEY } : {}
}

export async function stirlingHealth(timeoutMs = 4000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(STIRLING_BASE, { signal: ctrl.signal, headers: headers() })
    return { ok: r.ok, url: STIRLING_BASE }
  } catch (error) {
    return { ok: false, url: STIRLING_BASE, error }
  } finally { clearTimeout(timer) }
}

/** Finalize an already edited PDF through Stirling-PDF flattening. */
export async function finalizeWithStirling(pdfBytes, { signal } = {}) {
  const form = new FormData()
  form.append('fileInput', new Blob([pdfBytes], { type: 'application/pdf' }), 'document.pdf')
  const r = await fetch(STIRLING_BASE + '/api/v1/misc/flatten', { method: 'POST', body: form, headers: headers(), signal })
  if (!r.ok) {
    let detail = ''
    try { detail = (await r.json())?.error || '' } catch { /* non-json response */ }
    throw new Error(detail || ('Stirling-PDF 保存失败（HTTP ' + r.status + '）'))
  }
  return new Uint8Array(await r.arrayBuffer())
}

export function stirlingUrl() { return STIRLING_BASE }
