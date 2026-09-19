import { useCallback, useEffect, useRef, useState } from 'react'
import { saveFileBytes } from '../lib/FileProcessor.js'
import { setOriginalBytes } from '../lib/pdf/pdfEngine.js'

const EDITOR_URL = '/dart-pdf-editor/index.html'

export default function OpenPdfStudioView({ entry, notify }) {
  const frameRef = useRef(null)
  const [ready, setReady] = useState(false)
  const [opening, setOpening] = useState(true)
  const [error, setError] = useState('')
  const sentRef = useRef(false)
  const frameLoadedRef = useRef(false)
  const saveSeqRef = useRef(0)
  const loadSeqRef = useRef(0)
  const retryTimerRef = useRef(null)

  const sendDocument = useCallback(async () => {
    if (!frameRef.current || !frameLoadedRef.current || sentRef.current) return false
    const loadSeq = ++loadSeqRef.current
    try {
      const bytes = new Uint8Array(await entry.file.arrayBuffer())
      if (loadSeq !== loadSeqRef.current || !frameRef.current) return false
      frameRef.current.contentWindow?.postMessage({ type: 'dart-pdf-editor:open', name: entry.name, bytes: Array.from(bytes) }, window.location.origin)
      sentRef.current = true
      setOpening(false)
      return true
    } catch (err) {
      setError(err?.message || '读取 PDF 失败')
      setOpening(false)
      return false
    }
  }, [entry])

  useEffect(() => {
    sentRef.current = false
    frameLoadedRef.current = false
    setReady(false)
    setOpening(true)
    setError('')
    const onMessage = async (event) => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== window.location.origin) return
      const msg = event.data || {}
      if (msg.type === 'dart-pdf-editor:ready') {
        setReady(true)
        frameLoadedRef.current = true
        await sendDocument()
        return
      }
      if (msg.type === 'dart-pdf-editor:error') {
        setError(msg.message || 'dart_pdf_editor 无法打开该 PDF')
        setOpening(false)
        return
      }
      if (msg.type !== 'dart-pdf-editor:saved' || !msg.bytes) return
      try {
        const bytes = msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(msg.bytes)
        if (bytes.length < 4 || bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) throw new Error('编辑器返回的不是有效 PDF')
        if (!entry.handle) throw new Error('当前 PDF 没有可写文件句柄，请重新打开')
        const saveSeq = ++saveSeqRef.current
        await saveFileBytes(entry, bytes)
        if (saveSeq !== saveSeqRef.current) return
        setOriginalBytes(entry.id, bytes)
        notify('PDF 已由 dart_pdf_editor 保存', 'success')
      } catch (err) { notify('PDF 保存失败：' + (err?.message || err), 'error') }
    }
    window.addEventListener('message', onMessage)
    const retry = () => {
      if (sentRef.current) return
      frameRef.current?.contentWindow?.postMessage({ type: 'dart-pdf-editor:ping' }, window.location.origin)
    }
    retryTimerRef.current = window.setInterval(retry, 700)
    return () => {
      loadSeqRef.current += 1
      if (retryTimerRef.current) window.clearInterval(retryTimerRef.current)
      retryTimerRef.current = null
      window.removeEventListener('message', onMessage)
    }
  }, [entry, notify, sendDocument])

  return (
    <div className="open-pdf-studio-shell">
      <div className="open-pdf-studio-status">
        <span className="open-pdf-studio-brand">dart_pdf_editor</span>
        <span>{error ? error : opening ? '正在打开 PDF…' : ready ? 'PDF 编辑器已就绪' : '正在加载编辑器…'}</span>
        <span className="open-pdf-studio-hint">渲染、批注、文字编辑与保存均由项目内置编辑器处理</span>
      </div>
      {error && <div className="file-error">{error}</div>}
      <iframe ref={frameRef} className="open-pdf-studio-frame" title={'dart_pdf_editor — ' + entry.name} src={EDITOR_URL} onLoad={() => frameRef.current?.contentWindow?.postMessage({ type: 'dart-pdf-editor:ping' }, window.location.origin)} allow="clipboard-read; clipboard-write" />
    </div>
  )
}
