# 项目交接提示词

复制以下内容给下一个 Agent，即可从本项目当前状态继续工作：

---

你正在接手一个「跨平台笔记软件 Web MVP」项目，位于 `D:\onedrive\文档\ChatGPT\笔记软件`。这是一个 Vite + React 18 中文界面应用，UI 仿 Notion（左侧目录树 + 右侧内容区 + 文件标签页），面向 Web / 后续 Electron(.exe) / Capacitor(.apk) 三端。

## 项目状态
- 代码已完成并通过 `npm run build`；开发服务器可用 `npm run dev`（默认 http://127.0.0.1:5173/）。
- 核心交付物：`src/App.jsx`（全部 UI 与状态）、`src/lib/FileProcessor.js`（文件系统/解析/批注持久化唯一入口）、`src/lib/pdf/`（PDF 渲染引擎，见下）、`src/styles.css`。
- 已提交为 Git 仓库（分支 `main`），并上传至 GitHub 私有仓库：https://github.com/SeanWang114514/note-studio-mvp 。

## PDF 渲染/阅读架构（2025 年重构，套用 open-pdf-studio 的逻辑）
参考仓库：https://github.com/OpenAEC-Foundation/open-pdf-studio （已完整克隆学习，关键规则见其 CLAUDE.md）。

### 引擎模块（src/lib/pdf/）
| 文件 | 职责 |
|---|---|
| `pdfEngine.js` | 文档加载编排。**铁律：传给 PDF.js 的字节必须 `.slice()` 副本**（worker 会 detach 缓冲区）；`originalBytesCache` 持有原始字节作为唯一数据源（未来接入 pdf-lib 写回时从这里取）；`nextLoadSeq()` 供竞态防护 |
| `pdfRenderer.js` | 渲染层。`setupCanvasHiDPI`（后备缓冲 = 逻辑尺寸 × devicePixelRatio）；`renderPageToCanvas` 用 **`annotationMode: 0`**（PDF.js 不画注释，应用自己画）；`renderTextLayer`（PDF.js TextLayer，容器须设 `--scale-factor`/`--total-scale-factor`，类名含 `textLayer`）；`renderLinkLayer`（Link 注释 → 可点击覆盖层，内部跳转解析为页码回调） |
| `pdfViewer.js` | 视图编排（核心）。`PdfViewer` 类：连续滚动（每页 wrapper 精确 px 尺寸，`dataset.baseW/baseH` 存 scale-1 基准）；IntersectionObserver（200px 余量）惰性渲染 + 兜底显式渲染；低清预览（0.5 倍）先展示再补全清；**即时缩放**（先按比例拉伸所有已渲染画布、锚定光标位置，130ms 防抖后重渲染清晰版）；缩放范围 0.05~24，支持适合宽度/适合页面/实际大小/百分比；滚动同步（距视口中心最近的页 → onActivePageChange）；页面级渲染代数 `pageSeq` 防旧渲染覆盖新渲染 |
| `pdfCoords.js` | 三套坐标转换：PDF 坐标（左下原点，CropBox + Y 翻转）/ 视口坐标 / 归一化 0~1 批注坐标 |

### App.jsx PdfView 接入方式
- React 声明式构建每页 DOM（`.pdf-page` > `.pdf-canvas-container` > 三个 canvas + `.pdf-text-layer` + `.pdf-link-layer` + `.ann-dom`），ref 回调 `regPage(i, key)` 注册到 `pageElsRef`，`PdfViewer.getPages()` 读取。
- `handlePageRendered` 回调：注册 `pageRefs`（含 base 位图）、`attachTextEditLayer`（附加编辑文字监听）、重绘批注（`paintPage` + `paintTextEdits`）。
- **查看器外观（同 open-pdf-studio）**：滚动区浅灰背景，页面为白色卡片（`box-shadow: 0 4px 12px rgba(0,0,0,0.3)`），连续列居中、间距 20px；**浮动页码/缩放控制条**（`.pdf-page-controls`，深色胶囊固定底部居中：上一页/下一页/页码、缩放 -/百分比/+、适合宽度/适合页面/实际大小）。
- 缩放：浮动控制条按钮 + **Ctrl/滚轮锚定缩放**（原生 `wheel` 监听 `{passive:false}`，仅 ctrlKey/metaKey 时接管）+ 窗口 resize 时 `viewer.refresh()`（fit 模式重算）。
- 键盘快捷键：Ctrl+= / Ctrl+- 缩放、Ctrl+0 实际大小、Ctrl+1 适合宽度、Ctrl+2 适合页面、PageUp/PageDown 翻页。
- 视图模式：`viewMode` state（continuous/single），切换时 `viewer.rendered.clear()` + `setupLazyRender()` + `renderVisible()`。
- 缩略图侧栏（PdfThumbs）：IntersectionObserver 惰性渲染，只渲染进入视口的页。
- 批注持久化仍是**旁车 JSON**（`.annotations.json`，归一化 0~1 坐标），未改为写回 PDF。

### 关键技术约束（改代码前必读）
- `FileProcessor.js` 是文件系统/解析唯一入口；PDF 函数已委托给 `src/lib/pdf/*`，不要绕开引擎直接用 pdfjsLib。
- **对齐铁律**：文字层容器 `--scale-factor` 必须 = `viewport.scale`（pdfjs-dist 4.10 的 TextLayer 内部会乘以 devicePixelRatio，容器尺寸由 `calc(var(--scale-factor) * pageWidth)` 决定）；**渲染时不要传 rotation**（省略即默认 page.rotate，传 0 会覆盖旋转导致错位）；`applyInstantResize` 只拉伸画布类元素，文字/链接层由 130ms 防抖重渲染重建。
- 文字编辑"烧进画布"逻辑在 `paintTextEdits`（App.jsx），依赖 `pageRefs.current[i]` 的 `base`（viewer 渲染完成后提供的位图）与独立 `pdf-edit-canvas` 覆盖层；宽度用 `origPdfWidth × 当前缩放`（不是固定 1.6）。
- 文字层 span 编辑态样式：透明文字 + 淡蓝虚线框（`.pdf-text-layer span.edited`）。
- 缩放后 viewer 会重建文字层/链接层（旧 span 被 replaceChildren 清空），编辑监听在 `attachTextEditLayer` 重新附加。
- UI 全部中文，浅色 Notion 风格；不使用 Tailwind；图标用 `lucide-react`。

## 已实现功能（不要删除）
1. 主屏幕：欢迎页 + 最近打开 5 个文件缩略图卡片；文件以标签页叠加打开。
2. 文件打开：`showOpenFilePicker` + IndexedDB 句柄持久化 + 断线权限重校验。
3. 格式支持：PDF（新引擎渲染 + 缩放 + 连续/单页视图 + 批注 + 文字编辑 + 链接层）、docx（mammoth 只读 + 高亮）、markdown（块编辑器 + 实时预览 + 防抖保存）、PPT/Excel/EPUB（浏览器直开）、CAJ（占位）。
4. PDF 批注工具：阅读/选择（拖动平移带惯性）、**画笔（双击图标打开设置，含 4 种类型：画笔/直线/矩形/圆形，可调颜色/粗细；直线 Shift 吸附水平垂直、矩形 Shift 正方形、圆形 Shift 正圆；拖动中显示虚线框 + 尺寸标签实时预览，直线显示长度 px、其他显示 宽×高 px，松手后消失）**、文本框、批注侧栏 + 连线、左侧页面概略图（点击跳页）、撤销/清除/保存。
5. PDF 文字编辑：点击文字直接修改；确认后由 `paintTextEdits` 把新文字画进独立 `pdf-edit-canvas` 覆盖层（白色矩形覆盖原文 + 绘制新文字），文字层 span 保持透明并显示淡蓝虚线框；数据存入批注 JSON（`type: 'textEdit'`）。
6. 批注统一保存为同目录 `<文件名>.annotations.json`，结构 `{ version, file, updatedAt, pdf: [], docx: [] }`。

## 验证方法
- `npm run build` 必须通过；dev server 必须 200。
- PDF 回归：打开 PDF → 默认适合宽度 → Ctrl+滚轮缩放（光标处锚定）→ 连续/单页切换 → 缩略图点击跳页 → 批注/文字编辑后重开文件仍生效。
- 文字层对齐：缩放后文字位置与画布一致（--scale-factor 同步）。
- 引擎自测（无头 Chrome）：`public/` 放测试 PDF + 测试页，用 CDP 脚本验证渲染（本项目开发时用 `pdf-cdp-test.mjs` 模式）。

## 下一步（可选）
- 按 open-pdf-studio 的 saver.js 逻辑接入 pdf-lib，把批注**写回 PDF 文件本身**（`originalBytesCache` 已就绪；需注意 `.slice()`、CropBox 坐标、Y 翻转）。
- 按 `FileProcessor.js` 存储适配层接入 Electron 打包 `.exe`；再接入 Capacitor 打包 `.apk`。

请先阅读 `src/App.jsx`、`src/lib/pdf/*.js`、`src/lib/FileProcessor.js`、`src/styles.css`，再按上述约束继续任务。
