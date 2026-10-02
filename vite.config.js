import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// pdfjs 的 worker 跑在独立线程里，主线程的补丁到不了它，而 worker 产物里同样
// 调用了 Promise.withResolvers 等新 API（一调用就抛 TypeError，整条 PDF 加载
// 链路失败）。这里把同一份 src/lib/polyfills.js 原样前置进 worker 产物。
function pdfWorkerPolyfills() {
  let source = ''
  return {
    name: 'pdf-worker-polyfills',
    apply: 'build',
    generateBundle(_options, bundle) {
      if (!source) {
        try {
          source = readFileSync(
            fileURLToPath(new URL('./src/lib/polyfills.js', import.meta.url)),
            'utf8',
          )
        } catch {
          this.warn('读不到 src/lib/polyfills.js，pdf worker 未注入兼容补丁')
          return
        }
      }
      for (const output of Object.values(bundle)) {
        if (!/pdf[.-]?worker/i.test(output.fileName || '')) continue
        if (output.type === 'chunk') {
          output.code = `${source}\n${output.code}`
        } else if (typeof output.source === 'string') {
          output.source = `${source}\n${output.source}`
        }
      }
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), pdfWorkerPolyfills()],
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
