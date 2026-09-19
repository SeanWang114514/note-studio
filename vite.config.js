import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    // pdfjs 的「主线程 API」与「worker」必须是同一份副本，否则 getDocument 抛
    //   The API version "x" does not match the Worker version "y"
    // 导致所有 PDF 都打不开。dedupe 强制从本仓库根 node_modules 解析。
    dedupe: ['pdfjs-dist'],
  },
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
    watch: {
      // Windows 下编辑器临时文件（.tmpdir）会触发 EBUSY 崩溃，忽略之
      // 模式：<file>.<pid>.<uuid>.tmpdir/ 目录及其内容
      ignored: [
        '**/*.tmpdir/**',
        '**/.*.tmpdir/**',
        '**/.tmpdir/**',
        'tmp/**',
        '**/node_modules/**',
      ],
    },
    proxy: {
      '/stirling': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/stirling/, ''),
      },
    },
  },
  optimizeDeps: {
    // 只扫描应用自己的入口。Vite 默认会爬项目根下所有 *.html，于是把 vendor/
    // 里的第三方参考项目（open-pdf-studio）也扫了进来；它自带 pdfjs-dist@5.4.624，
    // 会把裸导入 `pdfjs-dist` 预构建成那一份副本，而 worker 仍来自本仓库的
    // 4.10.38，造成版本错配 → 所有 PDF 打开失败。
    entries: ['index.html'],
    // 保持原样：vendor 的 mupdf 用了 top-level await，默认目标环境 chrome87 不支持。
    // （限制 entries 后它已不会被扫到，留着作为兜底。）
    exclude: ['mupdf'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
})
