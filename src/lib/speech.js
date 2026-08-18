/**
 * 语音识别引擎
 * ==================================================
 * 两个后端：
 *   1. Vosk（vosk-browser，WebAssembly 本地推理）
 *      - 模型必须为 .tar.gz（vosk-browser 要求，官方 alphacephei 模型是 .zip，
 *        用 scripts/vosk_model_to_targz.py 转换后再放到 public/models/ 下通过 HTTP 提供）
 *      - 音频全程在浏览器本地处理，不离开本机
 *   2. Qwen3-ASR（本地 HTTP 服务，官方 qwen-asr Python 包）
 *      - 浏览器把录音编码成 16kHz 16bit WAV，POST 到 OpenAI 兼容接口
 *        /v1/audio/transcriptions（server/qwen3_asr_server.py 已实现）
 *      - 识别在本机运行（GPU 可选），音频不上传公网
 *
 * 每次识别产生的缓存（PCM 缓冲、WAV Blob URL、Analyser 数据、Vosk 识别器）
 * 都会在重新录音 / 停止 / 关闭弹窗时被清除；Vosk 模型在关闭弹窗时一并释放内存。
 */

import { getVoskModelUrl } from './modelManager.js'

export const SPEECH_MODELS = [
  {
    id: 'vosk',
    label: 'Vosk（浏览器本地离线）',
    hint: '模型为 .tar.gz（推荐 vosk-model-small-cn-0.22，约 40MB），首次加载较慢；用 scripts/vosk_model_to_targz.py 转换官方 zip',
    defaultModelUrl: '/models/vosk-model-small-cn-0.22.tar.gz',
  },
  {
    id: 'qwen3-asr',
    label: 'Qwen3-ASR（本地服务）',
    hint: '先启动 server/qwen3_asr_server.py（OpenAI 兼容接口，默认 http://127.0.0.1:8000/v1/audio/transcriptions）',
    defaultEndpoint: 'http://127.0.0.1:8000/v1/audio/transcriptions',
  },
]

export const DEFAULT_SETTINGS = {
  modelId: 'vosk',
  voskModelUrl: getVoskModelUrl(),
  qwenEndpoint: 'http://127.0.0.1:8000/v1/audio/transcriptions',
  qwenModel: 'Qwen3-ASR-1.7B',
  language: '', // 留空 = 自动检测
  silenceMs: 1600, // 停止说话多久后自动结束录音并识别
  maxDurationMs: 60000, // 单次录音上限（防无限录音）
  silenceThreshold: 0.012, // RMS 静音阈值
  removeSpeechSpaces: false, // 是否去除中文文字之间的空格，英文单词间空格始终保留
}

/** 清理语音识别文本：去掉中文词语之间的空格，保留英文单词之间的空格。 */
export function cleanSpeechText(value, removeSpeechSpaces = false) {
  let text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!removeSpeechSpaces) return text
  // 只去除中文字符之间的空格，英文单词之间及中英文之间的空格保留。
  while (/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/.test(text)) {
    text = text.replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1')
  }
  return text
}

const STORAGE_KEY = 'noteStudio.speechSettings.v1'

export function loadSpeechSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSpeechSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}

/** 把 16kHz 单声道 Float32 PCM 编码为 16bit WAV Blob（Qwen3-ASR 服务用）。 */
export function encodeWav(pcm, sampleRate = 16000) {
  const bytes = pcm.length * 2
  const buffer = new ArrayBuffer(44 + bytes)
  const view = new DataView(buffer)
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + bytes, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, bytes, true)
  let o = 44
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    o += 2
  }
  return new Blob([view], { type: 'audio/wav' })
}

function resample(src, srcRate, dstRate) {
  if (srcRate === dstRate || srcRate <= 0 || dstRate <= 0) return src
  const ratio = srcRate / dstRate
  const out = new Float32Array(Math.max(1, Math.round(src.length / ratio)))
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, src.length - 1)
    const f = pos - i0
    out[i] = src[i0] * (1 - f) + src[i1] * f
  }
  return out
}

function rmsOf(chunk) {
  if (!chunk || !chunk.length) return 0
  let s = 0
  for (let i = 0; i < chunk.length; i++) s += chunk[i] * chunk[i]
  return Math.sqrt(s / chunk.length)
}

/**
 * 录音 + 识别控制器。
 * 回调：
 *   onLevels(bins)  频率可视化数据（28 根竖条 0~100）
 *   onPartial(text) Vosk 流式中间结果
 *   onFinal(text)   最终识别文本（自动结束后触发一次）
 *   onError(msg)    错误
 *   onStatus(status) loading-model | recognizing 等状态提示
 */
export class SpeechController {
  constructor({ onLevels, onPartial, onFinal, onError, onStatus } = {}) {
    this.onLevels = onLevels || (() => {})
    this.onPartial = onPartial || (() => {})
    this.onFinal = onFinal || (() => {})
    this.onError = onError || (() => {})
    this.onStatus = onStatus || (() => {})

    this.stream = null
    this.audioCtx = null
    this.source = null
    this.analyser = null
    this.processor = null
    this.freqData = null

    this.pcmChunks = []
    this.recordedMs = 0
    this.lastVoiceAt = 0
    this.finishing = false
    this.recognizing = false
    this.stopped = true

    this.silenceMs = DEFAULT_SETTINGS.silenceMs
    this.maxDurationMs = DEFAULT_SETTINGS.maxDurationMs
    this.silenceThreshold = DEFAULT_SETTINGS.silenceThreshold
    this.removeSpeechSpaces = DEFAULT_SETTINGS.removeSpeechSpaces
    this.settings = null

    // Vosk 相关（模型跨多次录音缓存，弹窗关闭时 terminate 释放）
    this.voskModel = null
    this.voskUrl = null
    this.voskRecognizer = null
    this.accumText = ''

    this.abortCtrl = null
    this.wavUrl = null
  }

  /* ---------------- Vosk 模型 ---------------- */

  async ensureVoskModel(url) {
    if (!url) throw new Error('未设置 Vosk 模型地址（.tar.gz）')
    if (this.voskModel && this.voskUrl === url) return this.voskModel
    if (this.voskModel) {
      try {
        this.voskModel.terminate()
      } catch {
        /* ignore */
      }
      this.voskModel = null
      this.voskUrl = null
    }
    this.onStatus('loading-model')
    let mod
    try {
      mod = await import('vosk-browser')
    } catch (err) {
      throw new Error(`vosk-browser 加载失败：${err?.message || err}（请先执行 npm install）`)
    }
    const createModelFn = mod.createModel || mod.default?.createModel || mod.default
    if (typeof createModelFn !== 'function') {
      throw new Error('vosk-browser 接口异常：找不到 createModel')
    }
    const model = await Promise.race([
      createModelFn(url, -1),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('Vosk 模型加载超时（模型较大或地址不可达）')), 180000),
      ),
    ]).catch((err) => {
      const msg = String(err?.message || err)
      if (/fetch|network|404|CORS|加载/i.test(msg)) {
        throw new Error(
          `Vosk 模型加载失败：${msg.slice(0, 300)}。模型必须是 .tar.gz 且需通过 HTTP 提供（放 public/models/ 或本地起 HTTP 服务，注意 CORS）`,
        )
      }
      throw new Error(`Vosk 模型加载失败：${msg.slice(0, 300)}`)
    })
    this.voskModel = model
    this.voskUrl = url
    return model
  }

  /* ---------------- 录音 ---------------- */

  async start(settings) {
    await this.cancel({ keepModel: true })
    this.settings = { ...DEFAULT_SETTINGS, ...settings }
    this.silenceMs = this.settings.silenceMs
    this.maxDurationMs = this.settings.maxDurationMs
    this.silenceThreshold = this.settings.silenceThreshold
    this.removeSpeechSpaces = Boolean(this.settings.removeSpeechSpaces)
    this.stopped = false
    this.finishing = false
    this.recognizing = false
    this.pcmChunks = []
    this.recordedMs = 0
    this.lastVoiceAt = 0
    this.accumText = ''
    this.abortCtrl = new AbortController()

    // Vosk：先加载模型并创建流式识别器（实时出中间结果）
    if (this.settings.modelId === 'vosk') {
      const model = await this.ensureVoskModel(this.settings.voskModelUrl)
      const rec = new model.KaldiRecognizer(16000)
      // 注意：vosk-browser 的 addEventListener 回调收到的是 Event 对象（result 在 event.detail 里），
      // 必须用 rec.on()（listener 直接收到 message detail）或 m.detail.result，否则识别文本永远为空。
      rec.on?.('partialresult', (detail) => {
        if (!this.stopped && !this.recognizing) {
          this.onPartial(cleanSpeechText(detail?.result?.partial || '', this.removeSpeechSpaces))
        }
      })
      rec.on?.('result', (detail) => {
        const t = cleanSpeechText(detail?.result?.text || '', this.removeSpeechSpaces)
        if (t) this.accumText = this.accumText ? `${this.accumText} ${t}` : t
        if (!this.stopped && !this.recognizing) {
          this.onPartial(cleanSpeechText(this.accumText, this.removeSpeechSpaces))
        }
      })
      rec.on?.('error', (detail) => this.onError(`Vosk 识别错误：${detail?.error || ''}`))
      this.voskRecognizer = rec
    }

    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
    } catch (err) {
      const name = err?.name || ''
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        throw new Error('麦克风权限被拒绝：请在浏览器地址栏允许使用麦克风后重试')
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        throw new Error('未找到可用的麦克风设备，请检查系统录音设备')
      }
      throw new Error(`无法访问麦克风：${err?.message || err}`)
    } finally {
      // 麦克风失败时清理已创建的 Vosk 识别器，避免残留
      if (!stream) this.removeVoskRecognizer()
    }
    this.stream = stream

    const AudioCtx = window.AudioContext || window.webkitAudioContext
    const audioCtx = new AudioCtx({ sampleRate: 16000 })
    this.audioCtx = audioCtx
    const source = audioCtx.createMediaStreamSource(stream)
    this.source = source
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.72
    this.analyser = analyser
    this.freqData = new Uint8Array(analyser.frequencyBinCount)
    source.connect(analyser)

    const processor = audioCtx.createScriptProcessor(4096, 1, 1)
    processor.onaudioprocess = (e) => this.handleAudio(e.inputBuffer.getChannelData(0), audioCtx.sampleRate)
    this.processor = processor
    source.connect(processor)
    processor.connect(audioCtx.destination) // 保持处理节点活跃（输出为静音，不会回放）
  }

  handleAudio(chunk, srcRate) {
    if (this.stopped || this.finishing || this.recognizing) return
    const pcm = resample(chunk, srcRate, 16000)
    this.pcmChunks.push(pcm)
    this.recordedMs += (pcm.length / 16000) * 1000

    if (this.voskRecognizer) {
      try {
        this.voskRecognizer.acceptWaveformFloat(pcm, 16000)
      } catch {
        /* 单帧失败不中断 */
      }
    }

    if (this.analyser && this.freqData) {
      this.analyser.getByteFrequencyData(this.freqData)
      this.onLevels(this.binLevels())
    }

    const now = performance.now()
    if (rmsOf(pcm) >= this.silenceThreshold) this.lastVoiceAt = now
    const hadVoice = this.lastVoiceAt > 0
    const silentFor = now - (this.lastVoiceAt || now)
    if (
      (hadVoice && silentFor >= this.silenceMs) ||
      this.recordedMs >= this.maxDurationMs ||
      (!hadVoice && this.recordedMs >= 5000) // 全程无声 5 秒也自动结束
    ) {
      this.autoStop()
    }
  }

  binLevels(count = 28) {
    const n = this.freqData.length
    const out = new Array(count).fill(0)
    for (let i = 0; i < count; i++) {
      const start = Math.floor(Math.pow(i / count, 1.7) * n)
      const end = Math.max(start + 1, Math.floor(Math.pow((i + 1) / count, 1.7) * n))
      let sum = 0
      for (let j = start; j < end && j < n; j++) sum += this.freqData[j]
      out[i] = Math.min(100, sum / (end - start) / 2.55)
    }
    return out
  }

  autoStop() {
    if (this.finishing) return
    this.finishing = true
    this.stop().catch((err) => this.onError(`识别失败：${err?.message || err}`))
  }

  /* ---------------- 停止 / 识别 ---------------- */

  /** 停止录音并立即开始识别（自动静音结束 / 用户点击麦克风都走这里）。 */
  async stop() {
    if (this.recognizing) return
    this.recognizing = true
    this.stopped = true
    this.finishing = true
    await this.releaseCapture()
    this.onStatus('recognizing')
    const settings = this.settings || DEFAULT_SETTINGS
    try {
      let text = ''
      if (settings.modelId === 'vosk') {
        text = await this.voskFinalize()
      } else {
        this.onStatus('recognizing')
        text = await this.qwenRecognize(settings)
      }
      this.removeVoskRecognizer()
      this.onFinal(cleanSpeechText(text, this.removeSpeechSpaces))
    } finally {
      this.recognizing = false
      this.clearAudioCache()
    }
  }

  /** 取消录音，不识别（重新录音 / 关闭时用）。 */
  async cancel() {
    this.stopped = true
    this.finishing = true
    this.recognizing = false
    if (this.abortCtrl) {
      try {
        this.abortCtrl.abort()
      } catch {
        /* ignore */
      }
      this.abortCtrl = null
    }
    await this.releaseCapture()
    this.removeVoskRecognizer()
    this.clearAudioCache()
    return true
  }

  /** 彻底释放：停止录音 + 终止 Vosk 模型（释放几十 MB 内存）。 */
  async dispose() {
    await this.cancel()
    if (this.voskModel) {
      try {
        this.voskModel.terminate()
      } catch {
        /* ignore */
      }
      this.voskModel = null
      this.voskUrl = null
    }
  }

  async releaseCapture() {
    if (this.processor) {
      try {
        this.processor.disconnect()
      } catch {
        /* ignore */
      }
      this.processor.onaudioprocess = null
      this.processor = null
    }
    if (this.source) {
      try {
        this.source.disconnect()
      } catch {
        /* ignore */
      }
      this.source = null
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop())
      this.stream = null
    }
    if (this.audioCtx) {
      try {
        await this.audioCtx.close()
      } catch {
        /* ignore */
      }
      this.audioCtx = null
    }
    this.analyser = null
    this.freqData = null
  }

  removeVoskRecognizer() {
    if (this.voskRecognizer) {
      try {
        this.voskRecognizer.remove()
      } catch {
        /* ignore */
      }
      this.voskRecognizer = null
    }
  }

  /* ---------------- 识别后端 ---------------- */

  /** Vosk：等待流式识别 flush 出最终结果，同时合并多次中间 result。 */
  async voskFinalize() {
    const rec = this.voskRecognizer
    const acc = cleanSpeechText(this.accumText, this.removeSpeechSpaces)
    if (!rec) return acc
    return new Promise((resolve) => {
      let settled = false
      const finish = (t) => {
        if (settled) return
        settled = true
        try {
          rec.removeEventListener?.('result', onResult)
          rec.removeEventListener?.('error', onError)
        } catch {
          /* ignore */
        }
        clearTimeout(timer)
        const t2 = (t || '').trim()
        if (!t2) return resolve(acc)
        resolve(acc && acc.includes(t2) ? acc : acc ? `${acc} ${t2}` : t2)
      }
      const onResult = (detail) => finish(cleanSpeechText(detail?.result?.text || '', this.removeSpeechSpaces))
      const onError = () => finish(acc)
      try {
        rec.on?.('result', onResult)
        rec.on?.('error', onError)
      } catch {
        return resolve(acc)
      }
      const timer = setTimeout(() => finish(acc), 1500) // 保底
      try {
        rec.retrieveFinalResult()
      } catch {
        finish(acc)
      }
    })
  }

  /** Qwen3-ASR：把录音转 WAV 后 POST 到本地 OpenAI 兼容接口。 */
  async qwenRecognize(settings) {
    const pcm = this.concatPcm()
    if (!pcm.length) return ''
    const blob = encodeWav(pcm, 16000)
    const form = new FormData()
    form.append('file', blob, 'speech.wav')
    form.append('model', settings.qwenModel || 'Qwen3-ASR-1.7B')
    if (settings.language) form.append('language', settings.language)
    let res
    try {
      res = await fetch(settings.qwenEndpoint, {
        method: 'POST',
        body: form,
        signal: this.abortCtrl?.signal,
      })
    } catch (err) {
      if (err?.name === 'AbortError') return ''
      throw new Error(
        `无法连接 Qwen3-ASR 服务（${settings.qwenEndpoint}）：${err?.message || err}。请先运行 server/qwen3_asr_server.py`,
      )
    }
    if (!res.ok) {
      let detail = ''
      try {
        const j = await res.json()
        detail = j?.detail || j?.message || j?.error || ''
      } catch {
        /* ignore */
      }
      throw new Error(`Qwen3-ASR 服务返回 ${res.status}：${String(detail).slice(0, 300) || res.statusText}`)
    }
    const data = await res.json()
    if (Array.isArray(data)) return cleanSpeechText(data[0]?.text || '', settings.removeSpeechSpaces)
    return cleanSpeechText(data?.text || '', settings.removeSpeechSpaces)
  }

  concatPcm() {
    let len = 0
    for (const c of this.pcmChunks) len += c.length
    if (!len) return null
    const out = new Float32Array(len)
    let o = 0
    for (const c of this.pcmChunks) {
      out.set(c, o)
      o += c.length
    }
    return out
  }

  /* ---------------- 缓存清理 ---------------- */

  /** 每次识别产生的缓存全部清除：PCM 缓冲、WAV URL、识别器文本等。 */
  clearAudioCache() {
    this.pcmChunks = []
    this.recordedMs = 0
    this.lastVoiceAt = 0
    this.accumText = ''
    if (this.wavUrl) {
      try {
        URL.revokeObjectURL(this.wavUrl)
      } catch {
        /* ignore */
      }
      this.wavUrl = null
    }
  }
}
/* ---------------- 模型下载管理 ---------------- */

/** 可下载的本地量化模型（Qwen3-ASR-0.6B），由本地 Python 服务下载到磁盘（server/models/<id>/）。 */
export const DOWNLOADABLE_MODELS = [
  {
    id: 'gguf_q4km',
    name: 'Qwen3-ASR-0.6B（GGUF Q4_K_M）',
    kind: 'gguf',
    desc: 'transcribe.cpp / llama.cpp 可加载的 4bit 量化 GGUF，CPU 即可离线识别',
    repo: 'handy-computer/Qwen3-ASR-0.6B-gguf',
    sizeBytes: 589560480,
  },
  {
    id: 'mlx_4bit',
    name: 'Qwen3-ASR-0.6B（MLX 4bit）',
    kind: 'mlx',
    desc: 'Apple Silicon（macOS）MLX 框架 4bit 量化，含 tokenizer 整仓',
    repo: 'aitytech/Qwen3-ASR-0.6B-MLX-4bit',
    sizeBytes: 712038978,
  },
]

const MODELS_PROMPT_KEY = 'noteStudio.speech.modelsPrompt.v1'

/** 从 OpenAI 兼容 endpoint 推导模型管理服务地址（http://host:port）。 */
export function modelServerBase(endpoint = DEFAULT_SETTINGS.qwenEndpoint) {
  try {
    const u = new URL(endpoint)
    return `${u.protocol}//${u.host}`
  } catch {
    return 'http://127.0.0.1:8000'
  }
}

/** 查询模型目录与下载状态：{ models: [...], vosk: {...} }。 */
export async function fetchModelCatalog(base) {
  const res = await fetch(`${base}/models`)
  if (!res.ok) throw new Error(`模型服务返回 ${res.status}`)
  return res.json()
}

/** 请求后台开始下载指定模型。 */
export async function startModelDownload(base, id) {
  const res = await fetch(`${base}/models/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!res.ok) {
    let msg = ''
    try {
      const j = await res.json()
      msg = j?.detail || ''
    } catch {
      /* ignore */
    }
    throw new Error(msg || `下载请求失败（${res.status}）`)
  }
  return res.json()
}

/** 停止下载并删除本地模型文件。 */
export async function deleteModelFile(base, id) {
  const res = await fetch(`${base}/models/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) {
    let msg = ''
    try {
      const j = await res.json()
      msg = j?.detail || ''
    } catch {
      /* ignore */
    }
    throw new Error(msg || `删除失败（${res.status}）`)
  }
  return res.json()
}

/** 首次下载提示是否已处理（localStorage）。 */
export function isModelsPromptSeen() {
  try {
    return localStorage.getItem(MODELS_PROMPT_KEY) === '1'
  } catch {
    return true
  }
}

export function markModelsPromptSeen() {
  try {
    localStorage.setItem(MODELS_PROMPT_KEY, '1')
  } catch {
    /* ignore */
  }
}

export function resetModelsPrompt() {
  try {
    localStorage.removeItem(MODELS_PROMPT_KEY)
  } catch {
    /* ignore */
  }
}
