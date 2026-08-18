# Note Studio（笔记工作台）

一个基于 Vite + React 的本地文档转换与 PDF 编辑工具。

## 功能

- 文档格式转换：Word（docx）、PDF、Markdown、Excel（xlsx）、EPUB 等
- PDF 查看与标注编辑（基于 pdfjs-dist + pdf-lib）
- 手写 / 图片文字识别（右上角「文字识别」按钮 → 手写画板，可选 PP-OCRv5_mobile 或 PP-OCRv6，本地推理）
- 语音识别（右上角「语音识别」按钮 → 小弹窗，麦克风 + 音量频率可视化，可选 Vosk 浏览器本地或 Qwen3-ASR 本地服务，识别文字插入到光标位置）
- 本地 Python 转换服务（`server/`）

## 文字识别（OCR）

点击右上角「文字识别」按钮弹出画板：

- 在画板上手写（鼠标 / 触屏 / 数位板），或 **Ctrl+V 粘贴截图** / 上传图片识别印刷文字；
- 下方下拉框选择模型：**PP-OCRv5_mobile**（轻量通用）或 **PP-OCRv6 small**（精度更高）；
- 识别在**本机浏览器本地执行**（PaddleOCR.js + ONNX Runtime Web），图片不上传；
- 首次使用需联网下载 Paddle 官方模型（约 20~40MB/套，自动缓存），WASM 运行库在 dev 下由 `src/ort/` 本地提供；
- 「重新书写、撤销/重做（重做为右箭头，恢复刚撤销的一步）、像素橡皮（拖动擦除墨迹）、笔画橡皮（点击删除整条笔画）」清空画板并回收本次产生的图片对象 URL 缓存。

### 插入到文档

在文档视图（DOCX / PDF转DOCX / EPUB / Markdown / 纯文本 / Excel）里点「文字识别」会**自动进入编辑模式**，
识别完成后点 **「插入到文档」**，识别文字会**完整插入到打开弹窗前光标所在的位置**（未选择光标则插到文末）；
Excel 则写入当前选中的单元格。纯文本视图直接按光标位置插入并自动保存。

识别结果还提供两个格式选项（对显示 / 复制 / 插入同时生效）：

- **整理为一行（合并换行）**：把识别出的多行文字合并成一行；
- **去除空格**：去掉文字中的空格。

手写识别对书写工整度敏感：请写大一些、笔画清晰，效果更佳。

## 语音识别（ASR）

点击右上角（或文档工具栏）的 **「语音识别」** 按钮弹出小窗口（打开文件时点击会**自动进入编辑模式**）：

- **可视化**：中间是麦克风按钮（点击开始 / 再次点击停止），下方一排**竖向滚动条**实时显示音量与频率分布（AnalyserNode 频谱）；
- **自动识别**：停止说话约 1.6 秒（或主动点击麦克风 / 达到 60 秒上限）自动结束录音并输出识别结果；
- **结果可编辑**：识别文字直接显示在弹窗里，**点击文字即可直接修改**（不需要额外编辑按钮）；
- **两个模型（本地识别，音频不出本机）**：

| 模型 | 说明 | 准备 |
|---|---|---|
| **Vosk**（默认） | vosk-browser（WebAssembly + Kaldi），浏览器内离线识别，流式出中间结果 | **已内置**：`public/models/vosk-model-small-cn-0.22.tar.gz`（约 42MB），开箱即用；也可在弹窗里填其他 .tar.gz 地址或选本地文件 |
| **Qwen3-ASR** | 官方 `qwen-asr` Python 包 + FastAPI 服务（OpenAI 兼容 `/v1/audio/transcriptions`），精度更高 | 见下方「Qwen3-ASR 服务」 |

- **发送**：点击「发送」把识别文字**完整插入到打开弹窗前光标所在位置**（未选择位置则插到文末；Excel 写入当前单元格；纯文本按光标插入并自动保存）；
- **缓存清理**：每次重新录音 / 识别结束 / 关闭弹窗都会清除 PCM 缓冲、WAV 对象 URL、Analyser 数据与 Vosk 识别器；关闭弹窗时同时释放 Vosk 模型内存。

### Vosk 模型（已内置，无需准备）

项目已内置 **Vosk 中文小模型**（`public/models/vosk-model-small-cn-0.22.tar.gz`，约 42MB），默认即可离线识别，无需任何下载。

如需换用其他 Vosk 模型，用转换脚本生成 .tar.gz 放到 `public/models/`（可选）：

```bash
python scripts/vosk_model_to_targz.py https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip
```

脚本会解压 → 定位模型根目录 → **自动补上 vosk-browser 必需的 `conf/model.conf`** → 生成 `public/models/vosk-model-small-cn-0.22.tar.gz`。

### 量化模型下载管理（GGUF Q4_K_M / MLX 4bit）

Vosk 已内置；此外提供两个 **Qwen3-ASR-0.6B 量化模型**可选下载（识别精度更高，供本地推理工具使用）：

| 模型 | 大小 | 说明 |
|---|---|---|
| GGUF Q4_K_M | 约 562 MB | `handy-computer/Qwen3-ASR-0.6B-gguf`，transcribe.cpp / llama.cpp 可加载，CPU 可跑 |
| MLX 4bit | 约 679 MB | `aitytech/Qwen3-ASR-0.6B-MLX-4bit`，Apple Silicon 的 MLX 框架使用 |

- **首次打开**应用时会检测本地模型状态，若量化模型未下载且本地服务在线，自动弹出「是否下载」提示（可稍后下载，不会重复打扰）；
- **随时管理**：侧边栏「模型设置」，或语音识别弹窗右下角「模型管理」按钮，可查看状态 / 下载 / 删除；
- 下载由本地服务（`server/qwen3_asr_server.py`）后台执行到 `server/models/`，前端实时显示进度；下载源默认 `hf-mirror.com`（国内可直连），可用环境变量切换：
  `QWEN_HF_MIRROR=https://huggingface.co python server/qwen3_asr_server.py ...`；
- 服务端接口：`GET /models`（清单+状态）、`POST /models/download`（开始下载）、`DELETE /models/{id}`（删除）。

### Qwen3-ASR 服务（精度更高）

```bash
pip install -U qwen-asr fastapi "uvicorn[standard]" python-multipart

# CPU（无需 GPU，速度较慢）
python server/qwen3_asr_server.py --device cpu --port 8000

# GPU（推荐，bfloat16；首次启动会下载模型权重）
python server/qwen3_asr_server.py --device cuda:0 --port 8000
```

然后在弹窗中把模型切换为 **Qwen3-ASR（本地服务）**，默认地址 `http://127.0.0.1:8000/v1/audio/transcriptions` 即开即用；语言留空自动检测，或填 `Chinese` / `English`。

> 提示：`qwen-asr` 也支持 vLLM 后端（`pip install -U "qwen-asr[vllm]"`，`qwen-asr-serve` 命令），需要流式/更高吞吐时可自行扩展。

## Windows `.exe` 打包

本项目使用 Electron + electron-builder 打包 Windows portable 可执行文件。

```bash
npm install
npm run dist:win
```

生成文件位于 `release/Note-Studio-0.1.0-Windows.exe`。如果本机无法下载 Electron 构建运行时，可在 GitHub Actions 中手动运行 **Build Windows executable**，或推送 `v*` 标签后自动构建，并从 Actions Artifacts 下载 `.exe`。

## 技术栈

- 前端：React 18 + Vite 6
- 文档解析：pdfjs-dist、pdf-lib、mammoth、docx、xlsx、marked
- 文字识别：PaddleOCR 官方浏览器 SDK `@paddleocr/paddleocr-js`（PP-OCRv5_mobile / PP-OCRv6，ONNX Runtime Web 本地推理）
- 语音识别：`vosk-browser`（Kaldi WASM 本地离线）+ Qwen3-ASR（`qwen-asr` Python 包 + FastAPI 本地服务，OpenAI 兼容接口）
- 后端：Python（`server/convert_server.py`）

## 快速开始

```bash
# 安装依赖
npm install

# 启动前端开发服务器
npm run dev

# 启动文档转换服务（可选，用于部分格式转换）
python server/convert_server.py --port 5198
```

## 目录结构

```
src/                React 源码
  lib/pdf/          PDF 引擎、渲染、标注、保存
  lib/FileProcessor.js
  lib/speech.js          语音识别引擎（录音 / VAD / Vosk / Qwen3-ASR）
  lib/modelManager.js    模型下载/删除管理（本地服务 /models 接口）
  components/SpeechModal.jsx        语音识别小弹窗
  components/ModelSettingsModal.jsx 模型管理弹窗（下载/删除量化模型）
scripts/            vosk 模型 zip→tar.gz 转换脚本
server/             Python 服务（qwen3_asr_server.py 本地识别 / convert_server.py 转换）
public/models/      内置 Vosk 中文小模型（vosk-model-small-cn-0.22.tar.gz，约 42MB）
```

## License

本项目代码仅供个人学习使用。

## OCR 模型内置

模型已内置到 `public/models/`（PP-OCRv5_mobile + PP-OCRv6_small，约 50MB），无需联网下载。PP-OCRv5_mobile 适合手写，PP-OCRv6 small 适合印刷体。
