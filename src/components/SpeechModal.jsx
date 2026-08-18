import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  Database,
  Download,
  FileAudio,
  Loader2,
  Mic,
  RefreshCw,
  Send,
  X,
} from 'lucide-react'
import {
  SPEECH_MODELS,
  SpeechController,
  cleanSpeechText,
  loadSpeechSettings,
  saveSpeechSettings,
} from '../lib/speech.js'
import { checkFirstOpen, formatBytes, markPrompted } from '../lib/modelManager.js'
import ModelSettingsModal from './ModelSettingsModal.jsx'

const BAR_COUNT = 28

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
 * 语音识别弹窗（小窗）：
 * - 麦克风按钮 + 竖向多根频率条可视化（音量/音调）
 * - 点击麦克风开始录音；再次点击或静音一段时间自动结束并识别
 * - 下方选择模型（Vosk 浏览器本地 / Qwen3-ASR 本地服务）
 * - 识别结果直接显示在弹窗内，点击文字即可编辑（无额外按钮）
 * - 「重新录音」清空本次缓存并重录；「发送」把文字插入到打开弹窗前光标位置
 */
export default function SpeechModal({ open, onClose, onInsert }) {
  const [settings, setSettings] = useState(() => loadSpeechSettings())
  const [status, setStatus] = useState('idle') // idle | loading-model | listening | recognizing | done | error
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [bars, setBars] = useState(() => new Array(BAR_COUNT).fill(0))
  const [copied, setCopied] = useState(false)
  const [localModel, setLocalModel] = useState(null)
  const [promptOpen, setPromptOpen] = useState(false) // 首次下载提示
  const [settingsOpen, setSettingsOpen] = useState(false) // 模型管理弹窗
  const [missingModels, setMissingModels] = useState([]) // 首次提示中的未下载模型
  const localModelRef = useRef(null)
  const ctrlRef = useRef(null)
  const resultRef = useRef(null)
  const resultFocusedRef = useRef(false)
  const busyRef = useRef(false)
  const fileInputRef = useRef(null)

  const getCtrl = useCallback(() => {
    if (!ctrlRef.current) {
      ctrlRef.current = new SpeechController({
        onLevels: (bins) => setBars([...bins]),
        onPartial: (text) => {
          if (!resultFocusedRef.current) setResult(text)
        },
        onFinal: (text) => {
          setResult(text || '')
          setStatus('done')
        },
        onError: (msg) => {
          setError(msg)
          setStatus('error')
        },
        onStatus: (s) => setStatus(s),
      })
    }
    return ctrlRef.current
  }, [])

  // 打开弹窗：重置所有缓存与状态
  useEffect(() => {
    if (!open) return
    if (ctrlRef.current) ctrlRef.current.cancel().catch(() => {})
    setResult('')
    setError('')
    setStatus('idle')
    setBars(new Array(BAR_COUNT).fill(0))
    setCopied(false)
    resultFocusedRef.current = false
    busyRef.current = false
  }, [open])

  // 首次打开：检测是否有可下载的量化模型（GGUF / MLX），弹出下载提示
  useEffect(() => {
    if (!open) return
    let cancelled = false
    checkFirstOpen()
      .then(({ needPrompt, missing = [] }) => {
        if (cancelled) return
        if (needPrompt && missing.length) {
          setMissingModels(missing)
          setPromptOpen(true)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // 组件卸载（如切换标签页）时也要彻底释放录音与模型，避免麦克风占用
  useEffect(
    () => () => {
      if (ctrlRef.current) ctrlRef.current.dispose().catch(() => {})
      ctrlRef.current = null
      const u = localModelRef.current?.url
      if (u) {
        try {
          URL.revokeObjectURL(u)
        } catch {
          /* ignore */
        }
      }
      localModelRef.current = null
    },
    [],
  )

  // 关闭弹窗：彻底释放（含 Vosk 模型内存、本地模型对象 URL）
  useEffect(() => {
    if (open) return undefined
    if (ctrlRef.current) ctrlRef.current.dispose().catch(() => {})
    ctrlRef.current = null
    const u = localModelRef.current?.url
    if (u) {
      try {
        URL.revokeObjectURL(u)
      } catch {
        /* ignore */
      }
    }
    localModelRef.current = null
    setLocalModel(null)
  }, [open])

  // 设置持久化到 localStorage
  useEffect(() => {
    if (open) saveSpeechSettings(settings)
  }, [settings, open])

  // 把识别结果同步进可编辑区（用户正在编辑时不动）
  useEffect(() => {
    const el = resultRef.current
    if (!el) return
    if (document.activeElement === el) return
    if (el.textContent !== result) el.textContent = result
  }, [result])

  const patch = useCallback((p) => setSettings((s) => ({ ...s, ...p })), [])

  const startRecord = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setError('')
    setResult('')
    resultFocusedRef.current = false
    try {
      const ctrl = getCtrl()
      await ctrl.start({
        ...settings,
        voskModelUrl: localModelRef.current?.url || settings.voskModelUrl,
      })
      setStatus('listening')
    } catch (err) {
      setError(err?.message || '无法开始录音')
      setStatus('error')
    } finally {
      busyRef.current = false
    }
  }, [getCtrl, settings])

  const stopRecognize = useCallback(async () => {
    const ctrl = ctrlRef.current
    if (!ctrl || busyRef.current) return
    busyRef.current = true
    setStatus('recognizing')
    try {
      await ctrl.stop()
      // 成功时 onFinal 回调已把状态置为 done
    } catch (err) {
      setError(err?.message || '识别失败')
      setStatus('error')
    } finally {
      busyRef.current = false
    }
  }, [])

  const toggleMic = useCallback(() => {
    if (status === 'listening') stopRecognize()
    else startRecord()
  }, [status, startRecord, stopRecognize])

  // 重新录音：清空本次缓存与结果，直接开始新一段
  const reRecord = useCallback(async () => {
    if (busyRef.current) return
    const ctrl = ctrlRef.current
    if (ctrl) await ctrl.cancel().catch(() => {})
    await startRecord()
  }, [startRecord])

  const handleSend = useCallback(() => {
    const text = (result || '').trim()
    if (!text) {
      setError('请先录音识别出文字（也可以直接在上方输入文字）')
      return
    }
    if (typeof onInsert === 'function') {
      try {
        const ok = onInsert(text)
        if (ok !== false) onClose()
      } catch (err) {
        setError(`插入失败：${err?.message || err}`)
      }
    } else {
      // 未打开文件：退化为复制到剪贴板
      copyText(text).then((ok) => {
        setCopied(ok)
        setTimeout(() => setCopied(false), 1600)
      })
    }
  }, [result, onInsert, onClose])

  const handleModelFile = useCallback((e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const prev = localModelRef.current?.url
    if (prev) {
      try {
        URL.revokeObjectURL(prev)
      } catch {
        /* ignore */
      }
    }
    const url = URL.createObjectURL(file)
    localModelRef.current = { url, name: file.name }
    setLocalModel({ url, name: file.name })
    setError('')
  }, [])

  const switchModel = useCallback(
    (e) => {
      const id = e.target.value
      if (id === settings.modelId) return
      const ctrl = ctrlRef.current
      if (ctrl) ctrl.cancel().catch(() => {})
      setResult('')
      setError('')
      setStatus('idle')
      setBars(new Array(BAR_COUNT).fill(0))
      patch({ modelId: id })
    },
    [settings.modelId, patch],
  )

  const syncResult = useCallback(() => {
    const el = resultRef.current
    if (el) setResult(el.textContent || '')
  }, [])

  const activeModel = SPEECH_MODELS.find((m) => m.id === settings.modelId) || SPEECH_MODELS[0]
  const isRecording = status === 'listening'
  const busy = status === 'recognizing' || status === 'loading-model'

  const statusText = {
    idle: '点击麦克风开始录音',
    'loading-model': '正在加载模型…（首次使用需下载，请稍候）',
    listening: '录音中… 点击麦克风停止，或停止说话约 1.6 秒后自动识别',
    recognizing: '正在识别…',
    done: '识别完成，点击上方文字可直接修改',
    error: '识别失败，请查看下方提示',
  }[status]

  if (!open) return null

  return (
    <div
      className="speech-overlay"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="speech-modal" role="dialog" aria-modal="true" aria-label="语音识别">
        <div className="speech-modal-header">
          <div className="ocr-title">
            <Mic size={17} color="#2383e2" />
            <span>语音识别</span>
          </div>
          <button className="icon-btn" title="关闭 (Esc)" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="speech-body">
          {/* 麦克风 + 频率条可视化 */}
          <div className="speech-visualizer">
            <button
              className={`speech-mic-btn ${isRecording ? 'recording' : ''}`}
              onClick={toggleMic}
              disabled={busy}
              title={isRecording ? '停止并识别' : '开始录音'}
            >
              {busy ? <Loader2 size={26} className="speech-spin" /> : <Mic size={26} />}
            </button>
            <div className={`speech-bars ${isRecording ? 'live' : 'idle'}`}>
              {bars.map((h, i) => (
                <div
                  key={i}
                  className="speech-bar"
                  style={{ height: `${Math.max(6, Math.min(100, h))}%` }}
                />
              ))}
            </div>
            <div className="speech-status">{statusText}</div>
          </div>

          {/* 识别结果：点击文字即可直接编辑（无额外编辑按钮） */}
          <div className="speech-result-box">
            <div
              ref={resultRef}
              className="speech-result"
              contentEditable
              suppressContentEditableWarning
              data-placeholder="识别结果将显示在这里，点击可直接编辑"
              onInput={syncResult}
              onBlur={syncResult}
              onFocus={() => {
                resultFocusedRef.current = true
              }}
            />
          </div>

          <label className="speech-space-option">
            <input
              type="checkbox"
              checked={Boolean(settings.removeSpeechSpaces)}
              disabled={busy || isRecording}
              onChange={(e) => {
                const checked = e.target.checked
                patch({ removeSpeechSpaces: checked })
                setResult(cleanSpeechText(result, checked))
              }}
            />
            <span>去除中文文字间的空格</span>
            <small>英文单词之间的空格始终保留</small>
          </label>

          {error && <div className="ocr-error">{error}</div>}

          {/* 模型选择 + 配置 */}
          <div className="speech-model-area">
            <label className="ocr-model-box">
              <span className="ocr-model-label">识别模型</span>
              <select
                className="ocr-select"
                value={settings.modelId}
                onChange={switchModel}
                disabled={busy}
              >
                {SPEECH_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <span className="ocr-model-hint">{activeModel.hint}</span>
            </label>

            {settings.modelId === 'vosk' && (
              <div className="speech-config">
                <label className="ocr-model-box">
                  <span className="ocr-model-label">Vosk 模型文件（.tar.gz URL）</span>
                  <div className="speech-url-row">
                    <input
                      className="speech-input"
                      value={settings.voskModelUrl}
                      onChange={(e) => patch({ voskModelUrl: e.target.value })}
                      placeholder="/models/vosk-model-small-cn-0.22.tar.gz"
                      spellCheck={false}
                    />
                    <button
                      className="tool-btn"
                      type="button"
                      title="选择本地 .tar.gz 模型文件"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <FileAudio size={14} />
                      选择文件
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".tar.gz,.tgz"
                      hidden
                      onChange={handleModelFile}
                    />
                  </div>
                  <span className="ocr-model-hint">
                    {localModel
                      ? `已选择本地文件：${localModel.name}`
                      : '模型需通过 HTTP 提供（放 public/models/ 或运行 scripts/vosk_model_to_targz.py 生成）'}
                  </span>
                </label>
              </div>
            )}

            {settings.modelId === 'qwen3-asr' && (
              <div className="speech-config">
                <label className="ocr-model-box">
                  <span className="ocr-model-label">
                    服务地址（OpenAI 兼容 /v1/audio/transcriptions）
                  </span>
                  <input
                    className="speech-input"
                    value={settings.qwenEndpoint}
                    onChange={(e) => patch({ qwenEndpoint: e.target.value })}
                    placeholder="http://127.0.0.1:8000/v1/audio/transcriptions"
                    spellCheck={false}
                  />
                </label>
                <div className="speech-config-row">
                  <label className="ocr-model-box">
                    <span className="ocr-model-label">模型</span>
                    <select
                      className="ocr-select"
                      value={settings.qwenModel}
                      onChange={(e) => patch({ qwenModel: e.target.value })}
                    >
                      <option value="Qwen3-ASR-1.7B">Qwen3-ASR-1.7B（精度更高）</option>
                      <option value="Qwen3-ASR-0.6B">Qwen3-ASR-0.6B（更快）</option>
                    </select>
                  </label>
                  <label className="ocr-model-box">
                    <span className="ocr-model-label">语言（留空自动检测）</span>
                    <input
                      className="speech-input"
                      value={settings.language}
                      onChange={(e) => patch({ language: e.target.value })}
                      placeholder="如 Chinese / English"
                      spellCheck={false}
                    />
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* 操作：模型管理 / 重新录音 / 发送 */}
          <div className="speech-actions">
            <button
              className="tool-btn"
              onClick={() => setSettingsOpen(true)}
              title="下载 / 删除本地 ASR 量化模型"
            >
              <Database size={15} />
              模型管理
            </button>
            <button
              className="tool-btn"
              onClick={reRecord}
              disabled={busy}
              title="清空本次录音缓存并重新录音"
            >
              <RefreshCw size={15} />
              重新录音
            </button>
            <button
              className="tool-btn primary"
              onClick={handleSend}
              disabled={busy}
              title={onInsert ? '把识别文字插入到打开弹窗前光标所在位置' : '复制到剪贴板'}
            >
              {copied ? <Check size={15} /> : <Send size={15} />}
              {copied ? '已复制' : '发送'}
            </button>
          </div>
          {!onInsert && <div className="speech-hint">未打开文件：点击「发送」会把识别文字复制到剪贴板</div>}
        </div>
      </div>

      {promptOpen && (
        <div className="speech-prompt-overlay" onClick={() => setPromptOpen(false)}>
          <div className="speech-prompt-box" onClick={e => e.stopPropagation()}>
            <div className="speech-prompt-icon">🎙️</div>
            <div className="speech-prompt-title">检测到可下载的量化模型</div>
            <div className="speech-prompt-desc">
              Vosk 中文小模型已内置，开箱即用。以下 Qwen3-ASR 量化模型可提升识别效果，
              需要时再下载（存储在本机，不会上传到任何服务器）：
              <ul className="speech-prompt-models">
                {missingModels.map((m) => (
                  <li key={m.id}>
                    {m.name} · {formatBytes(m.sizeBytes)}
                  </li>
                ))}
              </ul>
            </div>
            <div className="speech-prompt-actions">
              <button
                className="tool-btn"
                onClick={() => {
                  markPrompted()
                  setPromptOpen(false)
                }}
              >
                暂不需要
              </button>
              <button
                className="tool-btn primary"
                onClick={() => {
                  markPrompted()
                  setPromptOpen(false)
                  setSettingsOpen(true)
                }}
              >
                <Download size={14} />
                去下载
              </button>
            </div>
          </div>
        </div>
      )}

      <ModelSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
