import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  Database,
  FileText,
  RefreshCw,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
import { OCR_MODELS, getDefaultOcrModel } from '../lib/ocr.js'
import {
  DEFAULT_SETTINGS as DEFAULT_SPEECH_SETTINGS,
  SPEECH_MODELS,
  loadSpeechSettings,
  saveSpeechSettings,
} from '../lib/speech.js'
import { deleteCacheFiles, listCacheFiles } from '../lib/pdf/pdfConvert.js'
import { formatBytes } from '../lib/FileProcessor.js'

/** 手写识别默认模型的 localStorage 键（OcrModal 打开时读取） */
export const OCR_MODEL_STORAGE_KEY = 'noteStudio.ocrModel.v1'

export function loadOcrModel() {
  try {
    return localStorage.getItem(OCR_MODEL_STORAGE_KEY) || getDefaultOcrModel()
  } catch {
    return getDefaultOcrModel()
  }
}

export function saveOcrModel(id) {
  try {
    localStorage.setItem(OCR_MODEL_STORAGE_KEY, id)
  } catch {
    /* ignore */
  }
}

/**
 * 设置弹窗：语音识别模型 / 手写识别模型切换 + 转换缓存文件显示与多选删除。
 */
export default function SettingsModal({ open, onClose, notify }) {
  const [speech, setSpeech] = useState(() => loadSpeechSettings())
  const [ocrModel, setOcrModel] = useState(() => loadOcrModel())
  const [files, setFiles] = useState([])
  const [selected, setSelected] = useState([]) // 多选删除：hash 列表
  const [cacheLoading, setCacheLoading] = useState(false)
  const [cacheError, setCacheError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [done, setDone] = useState(false) // 模型已保存提示
  const shownRef = useRef(false)

  const patchSpeech = useCallback((p) => setSpeech((s) => ({ ...s, ...p })), [])

  // 打开弹窗时刷新缓存列表 + 重置多选
  useEffect(() => {
    if (!open) return
    setSelected([])
    setDone(false)
    setCacheError('')
    let cancelled = false
    setCacheLoading(true)
    listCacheFiles()
      .then((list) => {
        if (!cancelled) setFiles(list)
      })
      .catch((err) => {
        if (!cancelled) setCacheError(err?.message || '读取缓存失败')
      })
      .finally(() => {
        if (!cancelled) setCacheLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // 保存模型设置：语音 + 手写，一并落 localStorage
  const saveModels = () => {
    saveSpeechSettings(speech)
    saveOcrModel(ocrModel)
    setDone(true)
    setTimeout(() => setDone(false), 1800)
    notify?.('模型设置已保存', 'success')
  }

  // 手动刷新缓存列表
  const refreshCache = useCallback(() => {
    setRefreshing(true)
    setCacheError('')
    listCacheFiles()
      .then(setFiles)
      .catch((err) => setCacheError(err?.message || '读取缓存失败'))
      .finally(() => setRefreshing(false))
  }, [])

  // 多选删除缓存
  const handleDelete = async () => {
    if (!selected.length || deleting) return
    setDeleting(true)
    setCacheError('')
    try {
      const n = await deleteCacheFiles(selected)
      setFiles((prev) => prev.filter((f) => !selected.includes(f.key)))
      setSelected([])
      notify?.(`已删除 ${n} 个缓存文件`, 'success')
    } catch (err) {
      setCacheError(err?.message || '删除失败')
    } finally {
      setDeleting(false)
    }
  }

  // 全选 / 反选
  const toggleAll = () => {
    setSelected((prev) => (prev.length === files.length ? [] : files.map((f) => f.key)))
  }

  const toggleOne = (key) => {
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }

  if (!open) return null

  const activeSpeech = SPEECH_MODELS.find((m) => m.id === speech.modelId) || SPEECH_MODELS[0]
  const activeOcr = OCR_MODELS.find((m) => m.id === ocrModel) || OCR_MODELS[0]
  const totalCacheBytes = files.reduce((s, f) => s + (f.size || 0), 0)

  return (
    <div
      className="ocr-overlay"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="settings-modal" role="dialog" aria-modal="true" aria-label="设置">
        <div className="ocr-modal-header">
          <div className="ocr-title">
            <Settings size={17} color="#2383e2" />
            <span>设置</span>
          </div>
          <button className="icon-btn" title="关闭 (Esc)" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="settings-body">
          {/* ── 语音识别模型 ── */}
          <section className="settings-section">
            <h3 className="settings-section-title">语音识别模型</h3>
            <label className="ocr-model-box">
              <span className="ocr-model-label">识别引擎</span>
              <select
                className="ocr-select"
                value={speech.modelId}
                onChange={(e) => patchSpeech({ modelId: e.target.value })}
              >
                {SPEECH_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <span className="ocr-model-hint">{activeSpeech.hint}</span>
            </label>

            {speech.modelId === 'vosk' && (
              <label className="ocr-model-box">
                <span className="ocr-model-label">Vosk 模型文件（.tar.gz URL）</span>
                <input
                  className="speech-input"
                  value={speech.voskModelUrl}
                  onChange={(e) => patchSpeech({ voskModelUrl: e.target.value })}
                  placeholder="/models/vosk-model-small-cn-0.22.tar.gz"
                  spellCheck={false}
                />
              </label>
            )}

            <label className="speech-space-option settings-speech-space-option">
              <input
                type="checkbox"
                checked={Boolean(speech.removeSpeechSpaces)}
                onChange={(e) => patchSpeech({ removeSpeechSpaces: e.target.checked })}
              />
              <span>去除中文文字间的空格</span>
              <small>英文单词之间的空格始终保留</small>
            </label>

            {speech.modelId === 'qwen3-asr' && (
              <>
                <label className="ocr-model-box">
                  <span className="ocr-model-label">服务地址（OpenAI 兼容）</span>
                  <input
                    className="speech-input"
                    value={speech.qwenEndpoint}
                    onChange={(e) => patchSpeech({ qwenEndpoint: e.target.value })}
                    placeholder="http://127.0.0.1:8000/v1/audio/transcriptions"
                    spellCheck={false}
                  />
                </label>
                <div className="speech-config-row">
                  <label className="ocr-model-box">
                    <span className="ocr-model-label">模型</span>
                    <select
                      className="ocr-select"
                      value={speech.qwenModel}
                      onChange={(e) => patchSpeech({ qwenModel: e.target.value })}
                    >
                      <option value="Qwen3-ASR-1.7B">Qwen3-ASR-1.7B（精度更高）</option>
                      <option value="Qwen3-ASR-0.6B">Qwen3-ASR-0.6B（更快）</option>
                    </select>
                  </label>
                  <label className="ocr-model-box">
                    <span className="ocr-model-label">语言（留空自动检测）</span>
                    <input
                      className="speech-input"
                      value={speech.language}
                      onChange={(e) => patchSpeech({ language: e.target.value })}
                      placeholder="如 Chinese / English"
                      spellCheck={false}
                    />
                  </label>
                </div>
              </>
            )}
          </section>

          {/* ── 手写识别模型 ── */}
          <section className="settings-section">
            <h3 className="settings-section-title">手写识别模型</h3>
            <label className="ocr-model-box">
              <span className="ocr-model-label">识别模型</span>
              <select
                className="ocr-select"
                value={ocrModel}
                onChange={(e) => setOcrModel(e.target.value)}
              >
                {OCR_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <span className="ocr-model-hint">{activeOcr.hint}</span>
            </label>
          </section>

          <div className="settings-save-row">
            <button className="tool-btn primary" onClick={saveModels}>
              {done ? <Check size={15} /> : <Database size={15} />}
              {done ? '已保存' : '保存模型设置'}
            </button>
            <span className="ocr-model-hint">
              手写识别默认模型保存在本机（OcrModal 打开时自动生效）
            </span>
          </div>

          {/* ── 转换缓存管理 ── */}
          <section className="settings-section">
            <h3 className="settings-section-title">
              转换缓存（PDF→Word 结果，共 {files.length} 个 · {formatBytes(totalCacheBytes)}）
            </h3>
            <div className="cache-toolbar">
              <button className="tool-btn" onClick={refreshCache} disabled={refreshing}>
                <RefreshCw size={14} className={refreshing ? 'settings-spin' : ''} />
                刷新
              </button>
              <button
                className="tool-btn"
                onClick={toggleAll}
                disabled={!files.length}
                title={selected.length === files.length ? '取消全选' : '全选'}
              >
                {selected.length === files.length && files.length ? '取消全选' : '全选'}
              </button>
              <button
                className="tool-btn danger"
                onClick={handleDelete}
                disabled={!selected.length || deleting}
              >
                <Trash2 size={14} />
                {deleting ? '删除中…' : `删除选中 (${selected.length})`}
              </button>
            </div>
            {cacheError && <div className="ocr-error">{cacheError}</div>}
            <div className="cache-list">
              {cacheLoading ? (
                <div className="cache-empty">
                  <span className="ocr-spinner" />
                  正在读取缓存…
                </div>
              ) : files.length === 0 ? (
                <div className="cache-empty">
                  <FileText size={14} />
                  暂无转换缓存。打开 PDF 转换一次后，docx 会保存在这里，下次直接复用。
                </div>
              ) : (
                files.map((f) => (
                  <label key={f.key} className={`cache-row ${selected.includes(f.key) ? 'on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={selected.includes(f.key)}
                      onChange={() => toggleOne(f.key)}
                    />
                    <FileText size={14} className="cache-row-icon" />
                    <span className="cache-row-key" title={f.key}>
                      {f.key.slice(0, 12)}…{f.key.slice(-6)}
                    </span>
                    <span className="cache-row-size">{formatBytes(f.size)}</span>
                    <span className="cache-row-time">{formatDate(f.mtime)}</span>
                  </label>
                ))
              )}
            </div>
            <span className="ocr-model-hint">
              缓存位于服务端 cache/ 目录，删除后再次打开对应 PDF 会重新转换
            </span>
          </section>
        </div>
      </div>
    </div>
  )
}

function formatDate(ts) {
  if (!ts) return '未知时间'
  const d = new Date(ts * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
