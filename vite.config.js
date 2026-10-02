import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// pdfjs 的 worker 跑在独立线程里，主线程的补丁到不了它，而 worker 产物里同样
// 调用了 Promise.withResolvers 等新 API（一调用就抛 TypeError，整条 PDF 加载
// 链路失败）。这里把同一份 src/lib/polyfills.js 原样前置进 worker 产物。
//
// ⚠️ 拼接必须留分号（ASI 陷阱，v0.1.15~v0.1.17 的 APK 打开 PDF 全部卡死的真凶）：
//    polyfills.js 结尾是 `})()`，而压缩后的 worker 产物开头是 `(function(){...`,
//    JS 的自动分号插入**不会**在 `(` 前补分号，两段于是被粘成
//    `})(...)(function(){...})` —— worker 一加载就抛
//    「(intermediate value)(...) is not a function」，只往 console 打一行错，
//    pdf.js 永远等不到 worker 的 ready 消息，于是页面停在「正在打开 PDF…」
//    既不 resolve 也不 reject，也不给用户任何提示。
//    所以这里显式补 `\n;\n`，不依赖源码文件自身的结尾写法。
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
        // 见文件头注释：`\n;\n` 是硬性要求，缺了它 worker 会静默死掉。
        const injected = `${source}\n;\n`
        if (output.type === 'chunk') {
          output.code = `${injected}${output.code}`
        } else if (typeof output.source === 'string') {
          output.source = `${injected}${output.source}`
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
