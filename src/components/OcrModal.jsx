import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  Copy,
  Eraser,
  Image as ImageIcon,
  Pencil,
  Redo2,
  RefreshCw,
  ScanText,
  Undo2,
  Upload,
  X,
} from 'lucide-react'
import { OCR_MODELS, recognizeImage } from '../lib/ocr.js'
import { loadOcrModel } from './SettingsModal.jsx'

const CANVAS_W = 900
const CANVAS_H = 420

function drawPadBackground(ctx) {
  // 纯白背景，无任何辅助线，保证导出图片不携带干扰元素
  ctx.save()
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
  ctx.restore()
}

function canvasPoint(e, canvas) {
  const rect = canvas.getBoundingClientRect()
  return {
    x: ((e.clientX - rect.left) * (canvas.width / rect.width)),
    y: ((e.clientY - rect.top) * (canvas.height / rect.height)),
  }
}

/** 复制文本到剪贴板（localhost 下 navigator.clipboard 可用，失败则回退）。 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

/**
 * 文字识别弹窗：手写画板 + 模型选择 + 本地识别。
 * 也支持粘贴/上传图片直接识别印刷文字。
 */
export default function OcrModal({ open, onClose, onInsert }) {
  const canvasRef = useRef(null)
  const drawingRef = useRef(false)
  const urlCacheRef = useRef([]) // 本次书写产生的图片对象 URL 缓存，重写/关闭时全部回收
  const [hasInk, setHasInk] = useState(false)
  const [modelId, setModelId] = useState(() => loadOcrModel())
  const [status, setStatus] = useState('idle') // idle | loading | done | error
  const [stageText, setStageText] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [inserted, setInserted] = useState(false)
  const [reformat, setReformat] = useState(false) // 整理为一行（合并换行）
  const [removeSpaces, setRemoveSpaces] = useState(false) // 去除空格
  const [externalImage, setExternalImage] = useState(null) // { blob, url }
  const fileInputRef = useRef(null)
  const [tool, setTool] = useState('pen') // pen | pixel-eraser | stroke-eraser
  const [undoable, setUndoable] = useState(false)
  const [redoable, setRedoable] = useState(false)
  const historyRef = useRef([]) // 绘画历史：pen / pixel-erase 命令
  const redoRef = useRef([]) // 撤销栈：被撤销的命令，可重做
  const currentStrokeRef = useRef(null) // 正在绘制的命令
  const nextStrokeIdRef = useRef(1)

  const addUrl = useCallback((url) => {
    urlCacheRef.current.push(url)
    return url
  }, [])

  const clearUrlCache = useCallback(() => {
    for (const u of urlCacheRef.current) {
      try {
        URL.revokeObjectURL(u)
      } catch {
        /* ignore */
      }
    }
    urlCacheRef.current = []
  }, [])

  // 按历史重绘画板（背景 + 全部命令）
  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    drawPadBackground(ctx)
    for (const cmd of historyRef.current) {
      if (cmd.type === 'pen') {
        ctx.strokeStyle = cmd.color
        ctx.fillStyle = cmd.color
        ctx.lineWidth = cmd.width
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.beginPath()
        cmd.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
        if (cmd.points.length === 1) {
          ctx.beginPath()
          ctx.arc(cmd.points[0].x, cmd.points[0].y, cmd.width / 2, 0, Math.PI * 2)
          ctx.fill()
        } else {
          ctx.stroke()
        }
      } else if (cmd.type === 'pixel-erase') {
        ctx.save()
        ctx.globalCompositeOperation = 'destination-out'
        ctx.strokeStyle = '#000'
        ctx.fillStyle = '#000'
        ctx.lineWidth = cmd.radius * 2
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.beginPath()
        cmd.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
        if (cmd.points.length === 1) {
          ctx.beginPath()
          ctx.arc(cmd.points[0].x, cmd.points[0].y, cmd.radius, 0, Math.PI * 2)
          ctx.fill()
        } else {
          ctx.stroke()
        }
        ctx.restore()
      }
    }
    setHasInk(historyRef.current.some((c) => c.type === 'pen'))
    setUndoable(historyRef.current.length > 0)
    setRedoable(redoRef.current.length > 0)
  }, [])

  // 初始化画板
  useEffect(() => {
    if (!open || !canvasRef.current) return
    const ctx = canvasRef.current.getContext('2d')
    canvasRef.current.width = CANVAS_W
    canvasRef.current.height = CANVAS_H
    historyRef.current = []
    redoRef.current = []
    currentStrokeRef.current = null
    nextStrokeIdRef.current = 1
    setTool('pen')
    drawPadBackground(ctx)
    setHasInk(false)
    setUndoable(false)
    setRedoable(false)
  }, [open])

  // 关闭时回收所有图片缓存（含外部图片 URL）
  useEffect(() => {
    if (!open) return
    return () => {
      clearUrlCache()
    }
  }, [open, clearUrlCache])

  // Escape 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // 粘贴图片 → 直接识别印刷文字
  const handlePaste = useCallback(
    (e) => {
      const items = e.clipboardData?.items || []
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            e.preventDefault()
            setExternalImage((prev) => {
              if (prev?.url) {
                try {
                  URL.revokeObjectURL(prev.url)
                } catch {
                  /* ignore */
                }
              }
              return { blob: file, url: addUrl(URL.createObjectURL(file)) }
            })
            setResult(null)
            setError('')
            setStatus('idle')
            return
          }
        }
      }
    },
    [addUrl],
  )

  // 上传图片
  const handleFile = useCallback(
    (e) => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (!file) return
      setExternalImage((prev) => {
        if (prev?.url) {
          try {
            URL.revokeObjectURL(prev.url)
          } catch {
            /* ignore */
          }
        }
        return { blob: file, url: addUrl(URL.createObjectURL(file)) }
      })
      setResult(null)
      setError('')
      setStatus('idle')
    },
    [addUrl],
  )

  // 重新书写：清空画板 + 清除图片缓存 + 清除结果
  const handleRewrite = useCallback(() => {
    const canvas = canvasRef.current
    if (canvas) {
      const ctx = canvas.getContext('2d')
      historyRef.current = []
      redoRef.current = []
      currentStrokeRef.current = null
      nextStrokeIdRef.current = 1
      drawPadBackground(ctx)
      setHasInk(false)
      setUndoable(false)
      setRedoable(false)
    }
    clearUrlCache()
    setExternalImage(null)
    setResult(null)
    setError('')
    setStatus('idle')
    setStageText('')
    setCopied(false)
    setInserted(false)
  }, [clearUrlCache, redraw])

  // 撤销上一步（画笔笔画 / 像素擦除 / 笔画擦除都算一步）
  const handleUndo = useCallback(() => {
    if (historyRef.current.length === 0) return
    const cmd = historyRef.current.pop()
    redoRef.current.push(cmd)
    redraw()
  }, [redraw])

  // 重做：取消撤销，恢复刚被撤销的那一步
  const handleRedo = useCallback(() => {
    if (redoRef.current.length === 0) return
    const cmd = redoRef.current.pop()
    historyRef.current.push(cmd)
    redraw()
  }, [redraw])

  // 点到线段的距离（命中检测用，支持折线上的任意位置）
  const segDist = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
    t = Math.max(0, Math.min(1, t))
    const cx = ax + t * dx
    const cy = ay + t * dy
    return Math.hypot(px - cx, py - cy)
  }

  // 笔画橡皮：命中检测 —— 点到笔画折线（含线段）的最短距离
  const hitTestStroke = useCallback(
    (p) => {
      const history = historyRef.current
      let bestIdx = null
      let bestDist = Infinity
      for (let i = history.length - 1; i >= 0; i--) {
        const cmd = history[i]
        if (cmd.type !== 'pen') continue
        const pts = cmd.points
        if (pts.length === 0) continue
        let d = Math.hypot(pts[0].x - p.x, pts[0].y - p.y)
        for (let j = 0; j < pts.length - 1; j++) {
          const dd = segDist(p.x, p.y, pts[j].x, pts[j].y, pts[j + 1].x, pts[j + 1].y)
          if (dd < d) d = dd
        }
        if (d < bestDist) {
          bestDist = d
          bestIdx = i
        }
      }
      // 线宽 6 的一半(3) + 容差（调大判定面积，点到笔画附近即可删除整条）
      return bestDist <= 24 ? bestIdx : null
    },
    [],
  )

  // 导出画板为 PNG Blob（新 Blob 不产生对象 URL，仅用于推理）。
  // 背景已是纯白，导出时再把浅色像素抹白，清除抗锯齿残留，只留墨迹。
  const exportCanvasBlob = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return Promise.reject(new Error('画板未就绪'))
    const temp = document.createElement('canvas')
    temp.width = canvas.width
    temp.height = canvas.height
    const tctx = temp.getContext('2d')
    tctx.fillStyle = '#ffffff'
    tctx.fillRect(0, 0, temp.width, temp.height)
    tctx.drawImage(canvas, 0, 0)
    try {
      const img = tctx.getImageData(0, 0, temp.width, temp.height)
      const d = img.data
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2]
        if (r > 190 && g > 190 && b > 190) {
          d[i] = 255
          d[i + 1] = 255
          d[i + 2] = 255
        }
      }
      tctx.putImageData(img, 0, 0)
    } catch {
      /* 保底：直接导出原图 */
    }
    return new Promise((resolve, reject) => {
      temp.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('导出画板图片失败'))
      }, 'image/png')
    })
  }, [])

  const handleRecognize = useCallback(async () => {
    if (status === 'loading') return
    setStatus('loading')
    setError('')
    setResult(null)
    setCopied(false)
    setInserted(false)
    setStageText('正在准备图片…')
    try {
      const source = externalImage ? externalImage.blob : await exportCanvasBlob()
      setStageText('正在加载内置模型并本地识别（模型已内置，无需联网下载）…')
      const res = await recognizeImage(modelId, source)
      setResult(res)
      setStatus('done')
    } catch (err) {
      setError(err?.message || '识别失败')
      setStatus('error')
    } finally {
      setStageText('')
    }
  }, [status, externalImage, exportCanvasBlob, modelId])

  // 按格式选项整理识别文本：换行合并 / 去空格
  const formattedText = useMemo(() => {
    let t = result?.text || ''
    if (reformat) t = t.replace(/\s*\r?\n+\s*/g, '')
    if (removeSpaces) t = t.replace(/[ \t\u00A0\u3000]+/g, '')
    return t
  }, [result, reformat, removeSpaces])

  const handleCopy = useCallback(async () => {
    if (!formattedText) return
    const ok = await copyText(formattedText)
    setCopied(ok)
    setTimeout(() => setCopied(false), 1600)
  }, [formattedText])

  const handleInsert = useCallback(() => {
    if (!formattedText || typeof onInsert !== 'function') return
    try {
      const ok = onInsert(formattedText)
      if (ok !== false) {
        setInserted(true)
        // 插入成功后自动关闭弹窗
        onClose()
      }
    } catch (err) {
      setError(`插入失败：${err?.message || err}`)
      setStatus('error')
    }
  }, [formattedText, onInsert, onClose])

  if (!open) return null

  const canRecognize = !!(externalImage || hasInk)

  const pointerDown = (e) => {
    const canvas = canvasRef.current
    if (!canvas) return
    e.preventDefault()
    const p = canvasPoint(e, canvas)
    const ctx = canvas.getContext('2d')

    // 笔画橡皮：点击命中即整条删除
    if (tool === 'stroke-eraser') {
      const idx = hitTestStroke(p)
      if (idx !== null) {
        historyRef.current.splice(idx, 1)
        redraw()
      }
      return
    }

    canvas.setPointerCapture(e.pointerId)
    drawingRef.current = true
    if (tool === 'pixel-eraser') {
      currentStrokeRef.current = { type: 'pixel-erase', points: [p], radius: 12 }
      ctx.save()
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = '#000'
      ctx.beginPath()
      ctx.arc(p.x, p.y, 12, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    } else {
      currentStrokeRef.current = {
        type: 'pen',
        points: [p],
        color: '#111111',
        width: 6,
        id: nextStrokeIdRef.current++,
      }
      ctx.strokeStyle = '#111111'
      ctx.fillStyle = '#111111'
      ctx.lineWidth = 6
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
      ctx.lineTo(p.x + 0.01, p.y + 0.01)
      ctx.stroke()
    }
  }

  const pointerMove = (e) => {
    if (!drawingRef.current) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const p = canvasPoint(e, canvas)
    const cmd = currentStrokeRef.current
    if (!cmd) return
    cmd.points.push(p)
    if (cmd.type === 'pixel-erase') {
      ctx.save()
      ctx.globalCompositeOperation = 'destination-out'
      ctx.strokeStyle = '#000'
      ctx.lineWidth = 24
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      ctx.moveTo(cmd.points[cmd.points.length - 2].x, cmd.points[cmd.points.length - 2].y)
      ctx.lineTo(p.x, p.y)
      ctx.stroke()
      ctx.restore()
    } else {
      ctx.lineTo(p.x, p.y)
      ctx.stroke()
    }
  }

  const pointerEnd = (e) => {
    if (!drawingRef.current) return
    drawingRef.current = false
    if (currentStrokeRef.current) {
      historyRef.current.push(currentStrokeRef.current)
      currentStrokeRef.current = null
      // 新操作会清除重做栈（重做只对撤销后的步骤有效）
      redoRef.current = []
      setHasInk(historyRef.current.some((c) => c.type === 'pen'))
      setUndoable(true)
      setRedoable(false)
    }
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  const activeModel = OCR_MODELS.find((m) => m.id === modelId) || OCR_MODELS[0]

  return (
    <div
      className="ocr-overlay"
      onPaste={handlePaste}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="ocr-modal" role="dialog" aria-modal="true" aria-label="文字识别">
        <div className="ocr-modal-header">
          <div className="ocr-title">
            <ScanText size={17} color="#2383e2" />
            <span>文字识别</span>
          </div>
          <button className="icon-btn" title="关闭 (Esc)" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="ocr-body">
          {/* 画板 / 外部图片预览 */}
          {externalImage ? (
            <div className="ocr-image-preview">
              <img src={externalImage.url} alt="待识别图片" />
              <button className="ocr-link-btn" onClick={handleRewrite}>
                <Eraser size={13} />
                清除图片，返回手写
              </button>
            </div>
          ) : (
            <div className="ocr-canvas-wrap">
              <canvas
                ref={canvasRef}
                className={`ocr-canvas ${tool === 'pixel-eraser' ? 'ocr-cursor-erase' : tool === 'stroke-eraser' ? 'ocr-cursor-stroke' : ''}`}
                onPointerDown={pointerDown}
                onPointerMove={pointerMove}
                onPointerUp={pointerEnd}
                onPointerCancel={pointerEnd}
              />
              <div className="ocr-draw-tools">
                <button
                  className={`tool-btn ocr-draw-tool ${tool === 'pen' ? 'on' : ''}`}
                  title="画笔：手写笔画"
                  onClick={() => setTool('pen')}
                  disabled={status === 'loading'}
                >
                  <Pencil size={14} />
                  画笔
                </button>
                <button
                  className={`tool-btn ocr-draw-tool ${tool === 'pixel-eraser' ? 'on' : ''}`}
                  title="像素橡皮：按住拖动擦除墨迹像素"
                  onClick={() => setTool('pixel-eraser')}
                  disabled={status === 'loading'}
                >
                  <Eraser size={14} />
                  像素橡皮
                </button>
                <button
                  className={`tool-btn ocr-draw-tool ${tool === 'stroke-eraser' ? 'on' : ''}`}
                  title="笔画橡皮：点击一条笔画将其整条删除"
                  onClick={() => setTool('stroke-eraser')}
                  disabled={status === 'loading'}
                >
                  <Eraser size={14} />
                  笔画橡皮
                </button>
                <span className="ocr-draw-sep" />
                <button
                  className="tool-btn ocr-undo-btn"
                  title="撤销上一步（笔画 / 像素擦除 / 笔画擦除）"
                  onClick={handleUndo}
                  disabled={!undoable || status === 'loading'}
                >
                  <Undo2 size={14} />
                  撤销
                </button>
                <button
                  className="tool-btn ocr-redo-btn"
                  title="重做：取消撤销（恢复刚撤销的那一步）"
                  onClick={handleRedo}
                  disabled={!redoable || status === 'loading'}
                >
                  <Redo2 size={14} />
                  重做
                </button>
              </div>
              <div className="ocr-canvas-hint">
                {tool === 'pixel-eraser'
                  ? '按住拖动擦除墨迹像素，擦除可被「撤销」恢复'
                  : tool === 'stroke-eraser'
                    ? '点击某一条笔画，将其整条删除'
                    : '在空白处手写文字（支持鼠标 / 触屏 / 数位板）'}
              </div>
            </div>
          )}

          {/* 模型选择 + 操作 */}
          <div className="ocr-controls">
            <label className="ocr-model-box">
              <span className="ocr-model-label">识别模型</span>
              <select
                className="ocr-select"
                value={modelId}
                onChange={(e) => {
                  setModelId(e.target.value)
                  setResult(null)
                  setError('')
                  setStatus('idle')
                }}
                disabled={status === 'loading'}
              >
                {OCR_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <span className="ocr-model-hint">{activeModel.hint}</span>
            </label>
            <div className="ocr-actions">
              <button
                className="tool-btn"
                title="上传图片直接识别（印刷文字）"
                onClick={() => fileInputRef.current?.click()}
                disabled={status === 'loading'}
              >
                <Upload size={15} />
                上传图片
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handleFile}
              />
              <button
                className="tool-btn"
                title="清空画板 / 清除图片，重新书写"
                onClick={handleRewrite}
                disabled={status === 'loading'}
              >
                <RefreshCw size={15} />
                重新书写
              </button>
              <button
                className="tool-btn primary ocr-run"
                onClick={handleRecognize}
                disabled={!canRecognize || status === 'loading'}
              >
                <ScanText size={15} />
                {status === 'loading' ? '识别中…' : '开始识别'}
              </button>
            </div>
          </div>

          {/* 状态 / 结果 */}
          {status === 'loading' && (
            <div className="ocr-status">
              <span className="ocr-spinner" />
              {stageText || '正在识别…'}
            </div>
          )}
          {status === 'error' && <div className="ocr-error">{error}</div>}
          {status === 'done' && result && (
            <div className="ocr-result">
              <div className="ocr-result-head">
                <span>
                  识别完成 · 共 {result.lines.length} 行 · 耗时 {result.elapsedMs} ms
                </span>
                <div className="ocr-result-actions">
                  {typeof onInsert === 'function' && (
                    <button className="tool-btn ocr-insert-btn" onClick={handleInsert}>
                      {inserted ? <Check size={14} /> : <ScanText size={14} />}
                      {inserted ? '已插入' : '插入到文档'}
                    </button>
                  )}
                  <button className="tool-btn" onClick={handleCopy}>
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? '已复制' : '复制结果'}
                  </button>
                </div>
              </div>
              {formattedText && (
                <div className="ocr-format-opts">
                  <label className={`ocr-opt ${reformat ? 'on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={reformat}
                      onChange={(e) => {
                        setReformat(e.target.checked)
                        setInserted(false)
                      }}
                    />
                    整理为一行（合并换行）
                  </label>
                  <label className={`ocr-opt ${removeSpaces ? 'on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={removeSpaces}
                      onChange={(e) => {
                        setRemoveSpaces(e.target.checked)
                        setInserted(false)
                      }}
                    />
                    去除空格
                  </label>
                  {typeof onInsert === 'function' && (
                    <span className="ocr-opt-hint">插入/复制时使用以上格式</span>
                  )}
                </div>
              )}
              <div className="ocr-result-text">
                {formattedText ? (
                  <pre>{formattedText}</pre>
                ) : (
                  <span className="ocr-empty-text">
                    {modelId === 'ppocr-v6'
                      ? '未识别到文字：PP-OCRv6 对细笔画手写不敏感，建议切换「PP-OCRv5_mobile」或写得更粗更大'
                      : '未识别到文字，请写得更大更工整后重试'}
                  </span>
                )}
              </div>
              {result.lines.length > 0 && (
                <div className="ocr-lines">
                  {result.lines.map((l, i) => (
                    <div className="ocr-line" key={i}>
                      <span className="ocr-line-idx">{i + 1}</span>
                      <span className="ocr-line-text">{l.text}</span>
                      <span className="ocr-line-score">{Math.round((l.score || 0) * 100)}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {status === 'idle' && !externalImage && (
            <div className="ocr-tip">
              <ImageIcon size={13} />
              也可以 <b>Ctrl+V 粘贴截图</b> 或点击「上传图片」识别印刷文字
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
