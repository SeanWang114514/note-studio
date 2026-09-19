# Note Studio（笔记工作台）

一个基于 Vite + React 的本地文档转换与 PDF 编辑工具。

## 功能

- 文档格式转换：Word（docx）、PDF、Markdown、Excel（xlsx）、EPUB 等
- PDF 查看与标注编辑（基于 pdfjs-dist + pdf-lib）
- 手写 / 图片文字识别（右上角「文字识别」按钮 → 手写画板，可选 PP-OCRv5_mobile 或 PP-OCRv6，本地推理）
- 语音识别（右上角「语音识别」按钮 → 小弹窗，麦克风 + 音量频率可视化，可选 Vosk 浏览器本地或 Qwen3-ASR 本地服务，识别文字插入到光标位置）
- 本地 Python 转换服务（`server/`），包含离线 Stirling-PDF 兼容定稿接口（`http://127.0.0.1:5198`）
- **Acrobat 级 PDF 文字编辑**（单击定位光标 / 跨行多选 / 段落连编辑，见下方「PDF 文字编辑」）
- **批注文本框的 Word 式格式栏**（字体 / 字号 / 粗体 / 斜体 / 下划线 / 对齐 / 颜色，见下方「批注文本框样式」）
- **移动端（Android APK）触屏适配**（单指滑动翻页 + 松手惯性、按屏幕分辨率自动适合宽度，见下方「移动端触屏」）

## 移动端触屏（Android APK）

打包成 APK 后（`npm run android:build` → `android/app/build/outputs/apk/debug/app-debug.apk`），触屏环境会自动启用下面这套行为；**桌面端（鼠标 + 键盘）完全不受影响**：

- **单指滑动就是滚屏**：用工具栏第一个工具「选择文字」时，单指在文档上滑动即可翻页；松手按滑动速度继续惯性滑行，自然减速停下，撞到顶/底就立刻停住（`src/lib/momentumScroll.js`）。
  双指滑动依然是滚动（原来的行为），慢拖松手不会触发惯性。
- **轻点切换选择**：轻点文本框 / 批注即选中，点空白处取消选择；单指拖拽仍然可以挪动批注。
  移动端单指腾给了滚动，所以框选多选只在桌面端可用。
- **按屏幕分辨率自动缩放**：打开文档即自动「适合宽度」，横竖屏切换后自动重新适配；批注栏在手机上默认折叠收起，把整屏宽度让给文档。
- 判定逻辑在 `src/lib/mobile.js`：`data-mobile="1"` 写在 `<html>` 上，调试时可用 `?mobile=1` 或 `window.__NOTE_FORCE_MOBILE__ = true` 在桌面浏览器里强制打开。

## 批注文本框样式（Word 式格式栏）

点上方工具栏的「文本框」按钮后，工具条会**自动多出一行文字格式栏**：

- 字体（无衬线 / 宋体 / 楷体 / 等宽，下拉框里用自己的字体渲染）、字号（9–72 预设刻度）、
  加粗 / 斜体 / 下划线、左中右对齐、5 个色块 + 自定义颜色；
- **选中某个文本框时**，这里改的样式直接作用到那个框（同 Word 改选区）；
  **没选中时**只改「新建文本框的默认样式」，栏首会写明当前是哪一种；
- 栏是常驻的：点画布、点别处都不会把它关掉，所以不需要去猜隐藏手势。
  （历史教训：这排控件最早藏在「再点一次工具按钮 / 双击 / 右键」后面，
  用户完全找不到，反馈就是「没有 Word 那样能选字体字号的界面」。）

> 关键实现点：
> 1. 样式单一来源是 `src/lib/textStyle.js`（屏幕用 CSS 字体栈，导出 PDF 用 base-14 字体名）；
> 2. 格式栏渲染在 `.doc-toolbar` 内部（不是浮层），靠给工具条加 `has-text-bar`
>    把 `flex-wrap` 从 `nowrap` 改成 `wrap` 才拿到独立一行 ——
>    **如果只是给栏加 `flex-basis:100%` 而不打开换行，它会横向溢出窗口、
>    颜色色块跑到屏幕右边点不到**（两个验收脚本都为此加了护栏检查）；
> 3. 导出的 PDF 用 `/FreeText` 的 `DA`（字体 + 字号 + 颜色）和 `/Q`（对齐）承载样式，
>    下划线在 `DA` 里无法表达，只能靠阅读器；中文字符串必须写成 UTF-16BE 十六进制
>    （`PDFString` 会按低 8 位截断，中文会变乱码）。

## PDF 文字编辑（Acrobat 级）

打开 PDF 后进入「编辑」模式（默认），体验对标 Adobe Acrobat 的「编辑 PDF」：

- **单击左键**在文字任意位置定位光标，直接输入插入 / 退格删除（所见即所得）；
- **鼠标拖拽跨行多选**：从第一行一直拖到最后一行（编辑框内 / 光标模式均可），
  选中的文字可整体删除 / 替换；
- **每行编辑模块连成整体**（Word 风格）：相邻行按字号 / 行距 / 对齐自动聚合为
  一个连续段落，段落内文字是连起来的，回车在段落内换行，不会出现「每行一个
  独立编辑框」的割裂感；
- 格式工具栏：字体 / 字号 / 加粗 / 斜体 / 下划线 / 颜色 / 左中右对齐；
- Enter 换行，Esc 取消，Ctrl+S 保存，点击页面其他位置自动提交（Word 风格）；
- **保存写回 PDF 文件本身**：纯 ASCII 文字用矢量字体写入，中文 / 任意系统字体
  用高清 PNG 嵌入（白底覆盖原文），任何阅读器打开都能看到编辑结果；
- 编辑数据持久化为旁车批注，重开文件后点击文字继续编辑上次的内容。

> 技术实现：文字层 span 附加 PDF 坐标 / 字体数据 → 段落聚合（pdfTextEdit.js）→
> 内联 contentEditable 编辑框（精确字号 / 行距对齐）→ pdfSaver 原生写回。

## 文字识别（OCR）

点击右上角「文字识别」按钮弹出画板：

- 在画板上手写（鼠标 / 触屏 / 数位板），或 **Ctrl+V 粘贴截图** / 上传图片识别印刷文字；
- 下方下拉框选择模型：**PP-OCRv5_mobile**（轻量通用）或 **PP-OCRv6 small**（精度更高）；
- 识别在**本机浏览器本地执行**（PaddleOCR.js + ONNX Runtime Web），图片不上传；
- 首次使用需联网下载 Paddle 官方模型（约 20~40MB/套，自动缓存），WASM 运行库在 dev 下由 `src/ort/` 本地提供；
- 「重新书写、撤销/重做（重做为右箭头，恢复刚撤销的一步）、像素橡皮（拖动擦除墨迹）、笔画橡皮（点击删除整条笔画）」清空画板并回收本次产生的图片对象 URL 缓存。

### 插入到文档

在文档视图（DOCX / EPUB / Markdown / 纯文本 / Excel）里点「文字识别」会**自动进入编辑模式**，
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

### 启动速度（改动打包配置前请先读这段）

portable 是「自解压」形态：**每次双击 exe 都会把整包解压到临时目录再启动，退出后再删掉**，所以启动耗时几乎等于「解压耗时 + Electron 启动耗时」。当前配置专门为此做了优化，实测（本机 NVMe SSD）：

| 形态 | 启动到窗口可见 |
| --- | --- |
| `release/Note-Studio-0.1.0-Windows.exe`（单人便携版） | **2.2 ~ 2.6 s** |
| `release/win-unpacked/Note Studio.exe`（免解压目录版） | **1.2 ~ 1.5 s** |

四个关键点，改动任意一条都会明显变慢：

1. `compression: "store"` —— 不压缩载荷，省掉每次启动的 LZMA 解压（LZMA 约 3 MB/s，压缩后启动要 30 s+）。
2. `portable.useZip: true` —— 走 NSIS 自带的 `File /r` 写文件，而不是 7z 插件解压（实测解压 1.87 s → 0.1~0.6 s）。该选项在 electron-builder 里标了 `@private`，但它只改变封装容器、不改变解压出来的内容。
3. `electronLanguages: ["zh-CN","en-US"]` —— 只保留两种语言包。
4. `files` 里的排除项 —— 渲染层依赖已由 Vite 打进 `dist/`，`node_modules` 不需要进包；另外排掉了 `dist/dart-pdf-editor.staging`（未被引用的旧构建）、`dist/open-pdf-studio`（未被引用的第三方副本）、`*.symbols`（Flutter 调试符号）等。**注意 `dist/dart-pdf-editor` 必须保留**，`OpenPdfStudioView.jsx` 用 iframe 加载它。

> 打包前先关掉正在运行的程序，否则 `release/win-unpacked/Note Studio.exe` 被占用会导致打包失败。
>
> 全新构建出来的 exe 第一次运行时，Windows Defender 会先对新文件做一次扫描，可能耗时十几秒；从第二次起就是上表的 2.2~2.6 s。想彻底避免这次「首次扫描」，需要对 exe 做代码签名。

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

## 未入库的运行时目录

下面两个第三方 PDF 编辑器的构建产物合计约 115MB，已写进 `.gitignore`，仓库里没有：

| 目录 | 用途 | 怎么补 |
| --- | --- | --- |
| `public/dart-pdf-editor/` | `components/OpenPdfStudioView.jsx` 用 iframe 加载 `/dart-pdf-editor/index.html` | 源码在 `dart-pdf-editor-web/`（Flutter 项目，已入库），`flutter build web` 后把产物拷到 `public/dart-pdf-editor/` |
| `public/open-pdf-studio/` | 第三方 PDF 编辑器参考副本（研究/对比用） | 从上游项目获取，本地放着即可，缺失不影响主流程 |

缺这两个目录不影响 `npm run build` 与主流程；只有「用 Dart PDF 编辑器打开」这个入口会加载失败。

## License

本项目代码仅供个人学习使用。

## OCR 模型内置

模型已内置到 `public/models/`（PP-OCRv5_mobile + PP-OCRv6_small，约 50MB），无需联网下载。PP-OCRv5_mobile 适合手写，PP-OCRv6 small 适合印刷体。