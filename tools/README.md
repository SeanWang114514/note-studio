# tools/ 脚本说明

## 当前维护中的验收 / 基准脚本

这些是「改完 UI 或手写引擎后必须跑」的脚本，全部用 headless Chrome + CDP，
需要 `danger-full-access` 才能启动浏览器进程；每个脚本都会把截图写到 `tmp/hig-shots/`。

| 脚本 | 用途 | 覆盖点 |
| --- | --- | --- |
| `verify-hig.mjs` | 外观与零回归主验收（34 项） | Apple 令牌、明暗两套、侧边栏/标签栏/工具栏尺寸、PDF 只读（点/双击页面不出现任何编辑入口、页面位图不被改写）、批注工具条、手写落笔、设置弹窗几何与控件尺寸、**语音识别/手写识别模型已整体移除**（无按钮/无弹窗/无模型设置入口）、无未捕获异常 |
| `verify-views.mjs` | 各文档视图零回归 | md / docx / epub / xlsx：容器渲染、`.doc-toolbar`、`.annot-canvas`、手绘落笔、无编辑条残留 |
| `verify-panels.mjs` | 栏目自由缩放 + 折叠 | 侧边栏/缩略图栏/批注栏：拖拽改宽、min/max 夹取、方向键微调、⌘B 折叠、**折叠细栏 40px + 28×28 带边框展开按钮（右上角）**、**三个侧栏的折叠按钮都钉在各自右上角**、工具栏按钮折叠恢复、刷新后备记忆、五视图的批注栏一致、**内容区不横向 bleed、分隔条不被内容遮挡** |
| `verify-band.mjs` | 视口条带批注画布 | 后备缓冲上限（长文档不再分配几百 MB）、落笔精度 ±14px、滚动随动（文档锚定）、滚出条带消失并原样复现、页码指示器跟随、点击缩略图跳页 |
| `verify-tools.mjs` | 画笔/荧光笔/橡皮擦设置 | 真实鼠标双击 / 连点两次 / 右键三种打开手势、**工具已选中时双击仍能打开（遮罩层不吃指针事件）**、点击工具栏以外关闭、Esc 关闭、角标提示、色板与自定义色、粗细 1–10 生效（像素级）、荧光笔半透明、橡皮擦两种模式与擦除生效 |
| `verify-shape.mjs` | 图形工具（已独立成上栏图标）+ 工具栏布局 | 独立图形按钮与角标、三种手势打开「图形设置」（直线/矩形/圆形 + 颜色 + 粗细）、画出的直线/矩形/圆形几何正确（矩形内部空心、四角有墨；圆形内部空心、四角无墨）、图形批注持久化往返、**批注工具栏与查看工具栏在 1600/1440/1280/1120px 下均单行不换行不溢出不压缩按钮**、md/docx/epub/xlsx 四视图工具栏同样合规、图形面板不被窗口裁切 |
| `verify-eraser.mjs` | 橡皮擦不留重影 + 侧边栏导航对齐 | 像素橡皮沿路径拖动后：擦除段干净（无墨）、笔画上方无残留虚线圆圈、总墨迹下降、松手后光标预览隐藏；笔画橡皮整条擦干净；侧边栏三个导航项（欢迎页/模型设置/设置）图标与文字左右边缘一致、高度一致 |
| `perf-probe.mjs` | 性能基准（诊断用） | 打开耗时、`Performance.getMetrics` 增量（Task/Script/Layout）、rAF 帧间隔分布、`--scroll` 滚动 A/B（含毛玻璃元素审计）、`--seed=N` 预置批注、画布微观基准 |

`perf-probe.mjs` 用法示例：

```powershell
# 长文档基准（夹具放 public/ 或 tmp/ 均可）
node tools/perf-probe.mjs --file=long-45p.pdf --dpr=2
# 滚动性能 A/B（会先热身，避免首次栅格化污染结果）
node tools/perf-probe.mjs --file=long-45p.pdf --dpr=2 --scroll
```

> 测量陷阱（踩过）：`Input.dispatchMouseEvent` 用的是视口坐标，落在视口外的元素上事件会**静默失效**；
> 惰性渲染的页面位图会在第一次滚动时生成，不热身就做 A/B 会得出「关掉毛玻璃快 15 倍」这类假结论。

## 夹具与生成器

| 文件 | 说明 |
| --- | --- |
| `make-complex-pdf.mjs` / `make-centered-pdf.mjs` / `make-native-edit-pdf.mjs` | 生成 `public/test-complex.pdf` 等测试 PDF |
| `../tmp/make-long-pdf.cjs` | 由 `public/manual.pdf` 拼接长文档（默认 45 页）用于长文档基准，产物放 `tmp/`，避免进入构建产物 |
| `../tmp/serve-dist.cjs` | 把 `dist/` 挂在 5200 端口，用于「生产构建 vs dev 服务器」对比 |

## 遗留脚本（历史诊断，已过期）

`tools/` 下其余脚本（`pdf-editor-*.mjs`、`acrobat-edit-*.mjs`、`diag-*.mjs`、`debug-*.mjs`、`white-screen*.mjs`、
`probe-5173-*.mjs`、`verify-pixel-match.mjs`、`verify-native-edit.mjs`、`verify-keep-in-place.mjs`、
`verify-pixels.mjs`、`verify-saved.mjs`、`diff-saved.mjs`、`crop-*.mjs`、`dump-spans.mjs` 等）
都是排查 **已删除的 PDF 文字编辑功能**时留下的临时脚本，依赖当时的 DOM 结构（`.pdf-text-layer`、
`.pdf-inline-editor`、`.pdf-edit-bar` 等），现在跑起来只会失败——保留仅作历史参考，可以安全删除。

`download-*.mjs` / `start-stirling.mjs` / `restart-vite.mjs` 是环境辅助脚本，与 UI 无关。
