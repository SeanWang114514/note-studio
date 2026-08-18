/**
 * 本地文字识别引擎（PaddleOCR.js 浏览器端推理）
 * ==================================================
 * 基于 PaddleOCR 官方浏览器 SDK @paddleocr/paddleocr-js：
 *   - PP-OCRv5  → PP-OCRv5_mobile_det / PP-OCRv5_mobile_rec
 *   - PP-OCRv6  → PP-OCRv6_small_det  / PP-OCRv6_small_rec
 * 模型已内置到项目 public/models/（约 50MB，随应用一起打包），
 * 打开工作台 / 识别时无需联网下载，推理全程在本机浏览器本地执行。
 *
 * WASM 运行库：dev 下由 src/ort/ 本地提供（Vite 按模块服务）；
 * build 下由 Rollup 自动把 onnxruntime-web 引用的 wasm 打进 assets。
 */

let sdkPromise = null

/** 按需加载 SDK（动态 import，避免拖慢应用首屏）。 */
function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = import('@paddleocr/paddleocr-js').catch((err) => {
      sdkPromise = null
      throw new Error(`PaddleOCR SDK 加载失败：${err?.message || err}`)
    })
  }
  return sdkPromise
}

let ortOptionsCache = null
function ortOptions() {
  if (!ortOptionsCache) {
    ortOptionsCache = {
      backend: 'wasm',
      // dev：从 src/ort/ 本地提供 ORT 的 wasm/mjs（Vite 按模块服务，MIME 正确）；
      // build：不指定 wasmPaths，让 Rollup 把 onnxruntime-web 引用的 wasm 打进 assets。
      wasmPaths: import.meta.env.DEV ? '/src/ort/' : undefined,
      // 本机非跨源隔离环境，单线程最稳；SIMD 加速
      numThreads: 1,
      simd: true,
    }
  }
  return ortOptionsCache
}

/** 可选模型列表（弹窗下拉框使用）。 */
export const OCR_MODELS = [
  {
    id: 'ppocr-v5-mobile',
    label: 'PP-OCRv5_mobile（手写推荐）',
    hint: '移动端轻量模型，对细笔画手写最友好，印刷文字也可用',
  },
  {
    id: 'ppocr-v6',
    label: 'PP-OCRv6 small（印刷精度更高）',
    hint: '新版小模型，印刷/清晰文字识别更准；对细笔画手写不敏感',
  },
]

/** 本地模型资源表：直接指向项目内置的 public/models/ 下的 tar 包。 */
function modelAssetUrl(file) {
  return new URL('/models/' + file, window.location.href).href
}

const MODEL_ASSETS = {
  'ppocr-v5-mobile': {
    textDetectionModelName: 'PP-OCRv5_mobile_det',
    textDetectionModelAsset: { url: modelAssetUrl('PP-OCRv5_mobile_det_onnx_infer.tar') },
    textRecognitionModelName: 'PP-OCRv5_mobile_rec',
    textRecognitionModelAsset: { url: modelAssetUrl('PP-OCRv5_mobile_rec_onnx_infer.tar') },
  },
  'ppocr-v6': {
    textDetectionModelName: 'PP-OCRv6_small_det',
    textDetectionModelAsset: { url: modelAssetUrl('PP-OCRv6_small_det_onnx_infer.tar') },
    textRecognitionModelName: 'PP-OCRv6_small_rec',
    textRecognitionModelAsset: { url: modelAssetUrl('PP-OCRv6_small_rec_onnx_infer.tar') },
  },
}

/** 各模型识别参数：v6_small 检测对细笔画手写不敏感，单独放宽阈值。 */
const PREDICT_PARAMS = {
  'ppocr-v5-mobile': {
    textRecScoreThresh: 0.3,
    textDetThresh: 0.2,
    textDetBoxThresh: 0.3,
    textDetUnclipRatio: 1.8,
    textDetLimitSideLen: 960,
  },
  // v6_small 检测对细笔画手写不敏感（模型特性），印刷/清晰文字识别更准
  'ppocr-v6': {
    textRecScoreThresh: 0.25,
    textDetThresh: 0.15,
    textDetBoxThresh: 0.25,
    textDetUnclipRatio: 2.2,
    textDetLimitSideLen: 960,
  },
}

const engineCache = new Map()

async function getEngine(modelId) {
  const cached = engineCache.get(modelId)
  if (cached) return cached

  const { PaddleOCR } = await loadSdk()
  const assets = MODEL_ASSETS[modelId] || MODEL_ASSETS['ppocr-v5-mobile']
  const opts = {
    lang: 'ch',
    ortOptions: ortOptions(),
    ...assets,
  }
  try {
    const ocr = await PaddleOCR.create(opts)
    engineCache.set(modelId, ocr)
    return ocr
  } catch (err) {
    engineCache.delete(modelId)
    const msg = String(err?.message || err)
    if (/fetch|network|404|timeout|Failed to fetch/i.test(msg)) {
      throw new Error(
        '模型加载失败：内置模型文件缺失（应位于 public/models/ 目录，约 50MB），请确认项目文件完整。' +
          (msg ? `（${msg.slice(0, 500)}）` : ''),
      )
    }
    throw new Error(`模型加载失败：${msg.slice(0, 500)}`)
  }
}

/**
 * 识别一张图片（Blob / File / canvas.toBlob 结果）。
 * @param {string} modelId  OCR_MODELS 中的 id
 * @param {Blob} imageBlob  图片字节
 * @returns {Promise<{text: string, lines: Array<{text:string,score:number}>, elapsedMs: number, modelId: string}>}
 */
export async function recognizeImage(modelId, imageBlob) {
  if (!imageBlob) throw new Error('没有可识别的图片')
  const engine = await getEngine(modelId)
  const started = performance.now()
  let results
  try {
    results = await engine.predict(imageBlob, {
      // 手写笔画较淡/不规范：放宽检测阈值，提高检出率
      ...(PREDICT_PARAMS[modelId] || PREDICT_PARAMS['ppocr-v5-mobile']),
    })
  } catch (err) {
    throw new Error(`识别失败：${err?.message || err}`)
  }
  const elapsedMs = Math.round(performance.now() - started)
  const first = Array.isArray(results) ? results[0] : results
  const items = (first?.items || [])
    .map((it) => ({ text: String(it?.text ?? ''), score: Number(it?.score ?? 0) }))
    .filter((it) => it.text.length > 0)
  return {
    text: items.map((it) => it.text).join('\n'),
    lines: items,
    elapsedMs,
    modelId,
  }
}

/** 预加载某个模型（可选：点开弹窗后后台预热，减少首次点击等待）。 */
export async function warmupModel(modelId) {
  try {
    await getEngine(modelId)
    return true
  } catch {
    return false
  }
}
