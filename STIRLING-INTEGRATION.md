# Stirling-PDF 离线集成（已就绪）

统一入口：**http://127.0.0.1:5199/**

打开后即可使用 Note Studio；Stirling-PDF 的完整 Web UI 也在同一入口：

- Note Studio 应用：http://127.0.0.1:5199/
- Stirling-PDF 完整工具界面：http://127.0.0.1:5199/stirling/app
- Stirling API 健康检查：http://127.0.0.1:5199/stirling/api/v1/info/status

## 运行方式

双击 `start-web.cmd` 或 `npm run dev`：

1. `tools/start-stirling.mjs` 检测 8080：已有服务则复用；否则用项目内置 JDK 25 启动 `vendor/stirling-pdf/stirling-pdf.jar`
2. Vite 启动 Note Studio（127.0.0.1:5199），并将 `/stirling/*` 同源代理到 Stirling-PDF（127.0.0.1:8080），浏览器无跨域

## 离线运行时（已随项目提供）

- `vendor/stirling-pdf/stirling-pdf.jar` — Stirling-PDF v2.14.3 server JAR（234 MB）
- `vendor/jdk25/jdk-25.0.4+7/` — Temurin JDK 25 LTS（Stirling v2.14.x 需要 Java 25）

系统自带 Java 17 无法运行新版 Stirling（class file 69.0），因此项目内置 JDK 25，完全离线自包含。

## 配置

| 环境变量 | 用途 | 默认 |
|---|---|---|
| `STIRLING_JAR` | 指定 Stirling JAR 路径 | `vendor/stirling-pdf/stirling-pdf.jar` |
| `VITE_STIRLING_URL` | 前端 Stirling 基地址 | `/stirling`（同源代理） |
| `VITE_STIRLING_API_KEY` | API Key（启用安全模式时） | 空 |

## 命令

- `npm run stirling:status` — 查看服务状态
- `npm run stirling:start` — 启动（复用已运行实例）
- `npm run stirling:stop` — 停止由本项目启动的实例
- `npm run dev` — Stirling + Note Studio 一起启动

## 已验证

- GET /stirling/ → 200（前端健康检查）
- GET /stirling/api/v1/info/status → {"version":"2.14.3","status":"UP"}
- POST /stirling/api/v1/misc/flatten（fileInput 字段）→ 200 返回合法 PDF
- GET /stirling/app → 200（Stirling 完整 Web UI）

> 注：旧的 Python 转换服务（5198 / pdf2docx）已不再是 PDF 主流程；Stirling 为新的 PDF 处理后端。
