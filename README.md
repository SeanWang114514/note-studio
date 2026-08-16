# Note Studio（笔记工作台）

一个基于 Vite + React 的本地文档转换与 PDF 编辑工具。

## 功能

- 文档格式转换：Word（docx）、PDF、Markdown、Excel（xlsx）、EPUB 等
- PDF 查看与标注编辑（基于 pdfjs-dist + pdf-lib）
- 本地 Python 转换服务（`server/`）

## 技术栈

- 前端：React 18 + Vite 6
- 文档解析：pdfjs-dist、pdf-lib、mammoth、docx、xlsx、marked
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
server/             Python 转换服务
public/             静态资源与测试样例
```

## License

本项目代码仅供个人学习使用。
