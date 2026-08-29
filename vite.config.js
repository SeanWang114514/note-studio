import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
    watch: {
      // Windows 下编辑器临时文件（.tmpdir）会触发 EBUSY 崩溃，忽略之
      ignored: ['.tmpdir/**', '**/.tmpdir/**', 'tmp/**', '**/node_modules/**'],
    },
    proxy: {
      '/stirling': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/stirling/, ''),
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 2500,
  },
})
