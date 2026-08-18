import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Loader2, Trash2, X, Check } from 'lucide-react'
import {
  fetchModelStatus,
  downloadModel,
  deleteModel,
  formatBytes,
  hasPromptedDownload,
  markPrompted,
  probeLocalVosk,
  updateVoskModelUrl,
} from '../lib/modelManager.js'

/**
 * 模型设置弹窗：
 * - 展示所有可下载模型（Vosk 中文 / GGUF Q4_K_M / MLX 4bit）
 * - 显示已下载 / 下载中 / 错误状态
 * - 支持下载和删除操作
 * - 首次打开时可选作为 modal 弹出（needPrompt=true）
 */
export default function ModelSettingsModal({
  open,
  onClose,
  initialPrompt = false,
  onPromptHandled,
}) {
  const [models, setModels] = useState([])
  const [voskBuiltin, setVoskBuiltin] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [promptShown, setPromptShown] = useState(false)
  const mountedRef = useRef(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [data, probe] = await Promise.all([
        fetchModelStatus(),
        probeLocalVosk(),
      ])
      if (!mountedRef.current) return
      setModels(data.models || [])
      setVoskBuiltin(data.vosk?.builtin || probe.available)
    } catch (err) {
      if (!mountedRef.current) return
      // Server unreachable — still try local probe
      try {
        const probe = await probeLocalVosk()
        if (mountedRef.current) setVoskBuiltin(probe.available)
      } catch {}
      setError('无法连接模型管理服务（server/qwen3_asr_server.py）')
      setModels([])
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    if (open) {
      refresh()
      if (initialPrompt && !hasPromptedDownload()) {
        setPromptShown(true)
      }
    }
    return () => { mountedRef.current = false }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // 有模型下载中：自动轮询刷新进度
  useEffect(() => {
    if (!open) return
    const hasDownloading = models.some((m) => m.downloading)
    if (!hasDownloading) return
    const timer = setInterval(() => refresh(), 2000)
    return () => clearInterval(timer)
  }, [open, models, refresh])

  const handleDownload = useCallback(async (modelId) => {
    setError('')
    try {
      await downloadModel(modelId)
      await refresh()
    } catch (err) {
      setError(String(err.message || err))
    }
  }, [refresh])

  const handleDelete = useCallback(async (modelId) => {
    if (!window.confirm('确定删除该模型？删除后需重新下载。')) return
    setError('')
    try {
      await deleteModel(modelId)
      await refresh()
    } catch (err) {
      setError(String(err.message || err))
    }
  }, [refresh])

  const handlePromptAction = useCallback(async (download) => {
    markPrompted()
    setPromptShown(false)
    if (onPromptHandled) onPromptHandled(download)
    if (download) {
      // Vosk 已内置无需下载；下载所有尚未下载的量化模型（GGUF / MLX）
      const targets = models.filter((m) => !m.downloaded && !m.downloading)
      setError('')
      for (const m of targets) {
        try {
          await downloadModel(m.id)
          await refresh()
        } catch (err) {
          setError('下载失败：' + (err.message || err))
          break
        }
      }
    }
  }, [models, refresh, onPromptHandled])

  const voskModel = models.find(m => m.id === 'vosk-cn-small')
  const qwenGgufModel = models.find(m => m.id === 'gguf_q4km')
  const qwenMlxModel = models.find(m => m.id === 'mlx_4bit')

  if (!open) return null

  return (
    <div className="model-modal-overlay" onKeyDown={e => e.key === 'Escape' && onClose()} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="model-modal" role="dialog" aria-modal="true" aria-label="模型管理">
        {/* Header */}
        <div className="model-modal-header">
          <div className="ocr-title">
            <Download size={17} color="#2383e2" />
            <span>模型管理</span>
          </div>
          <button className="icon-btn" title="关闭 (Esc)" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="model-modal-body">
          {/* 首次下载提示 */}
          {promptShown && (
            <div className="model-prompt-box">
              <div className="model-prompt-icon">🎙️</div>
              <div className="model-prompt-text">
                <strong>发现可下载的量化模型</strong>
                <p>
                  Vosk 中文小模型已内置（开箱即用）。Qwen3-ASR 量化模型
                  （GGUF Q4_K_M 约 562 MB / MLX 4bit 约 679 MB）可选下载，用于本机更高精度的离线识别。
                </p>
              </div>
              <div className="model-prompt-actions">
                <button className="tool-btn" onClick={() => handlePromptAction(false)}>
                  稍后下载
                </button>
                <button className="tool-btn primary" onClick={() => handlePromptAction(true)}>
                  <Download size={14} />
                  立即下载
                </button>
              </div>
            </div>
          )}

          {/* 状态摘要 */}
          <div className="model-summary">
            <span className={voskBuiltin ? 'status-ok' : 'status-warn'}>
              {voskBuiltin ? '✓ 内置 Vosk 模型（public/models/）' : '○ Vosk 模型未内置'}
            </span>
            <span className="model-server-hint">
              模型通过本地 server 管理，需启动 server/qwen3_asr_server.py
            </span>
          </div>

          {loading && (
            <div className="model-loading">
              <Loader2 size={14} className="speech-spin" />
              加载中…
            </div>
          )}

          {error && <div className="ocr-error">{error}</div>}

          {/* 模型列表 */}
          {!loading && (
            <div className="model-list">
              {renderModelItem('vosk-cn-small', voskModel, 'Vosk 中文小模型', 'vosk', '浏览器本地离线识别，约 42 MB', handleDownload, handleDelete)}
              {renderModelItem('gguf_q4km', qwenGgufModel, 'Qwen3-ASR-0.6B', 'gguf', 'GGUF Q4_K_M 量化，transcribe.cpp / llama.cpp 离线识别', handleDownload, handleDelete)}
              {renderModelItem('mlx_4bit', qwenMlxModel, 'Qwen3-ASR-0.6B', 'mlx', 'MLX 4bit 量化，Apple Silicon 离线识别', handleDownload, handleDelete)}
            </div>
          )}

          {!loading && models.length === 0 && !error && (
            <div className="model-empty">
              <p>未检测到模型管理服务</p>
              <p className="model-empty-hint">请启动 server/qwen3_asr_server.py 后刷新</p>
              <button className="tool-btn" onClick={refresh}>
                <Check size={14} />
                重试
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function renderModelItem(id, model, label, kind, desc, onDownload, onDelete) {
  if (!model) return null
  const downloaded = model.downloaded
  const downloading = model.downloading
  const err = model.error
  const progress = model.progress
  const pct = progress?.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <div className={'model-card' + (downloaded ? ' model-card-ok' : downloading ? ' model-card-downloading' : err ? ' model-card-error' : '')}>
      <div className="model-card-info">
        <div className="model-card-label">
          <span className={'model-kind-tag model-kind-' + kind}>{kind.toUpperCase()}</span>
          <span className="model-card-name">{label}</span>
        </div>
        <div className="model-card-desc">{desc}</div>
        {progress?.total > 0 && (
          <div className="model-progress-bar">
            <div className="model-progress-fill" style={{ width: pct + '%' }} />
            <span className="model-progress-text">{formatBytes(progress.done)} / {formatBytes(progress.total)} ({pct}%)</span>
          </div>
        )}
        {err && <div className="ocr-error" style={{fontSize:11,marginTop:4}}>{err}</div>}
      </div>
      <div className="model-card-actions">
        {downloaded ? (
          <button className="tool-btn" title="已下载" disabled>
            <Check size={14} color="#2f9e44" />
            已下载
          </button>
        ) : downloading ? (
          <button className="tool-btn" disabled title="下载中…">
            <Loader2 size={14} className="speech-spin" />
            下载中 {pct}%
          </button>
        ) : (
          <button
            className="tool-btn primary"
            onClick={() => onDownload(id)}
            title="从 HuggingFace 下载"
          >
            <Download size={14} />
            下载
          </button>
        )}
        {downloaded && (
          <button
            className="tool-btn"
            onClick={() => onDelete(id)}
            title="删除本地模型文件"
          >
            <Trash2 size={14} />
            删除
          </button>
        )}
      </div>
    </div>
  )
}
