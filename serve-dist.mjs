import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
const DIST = 'D:/VibeCoding/note apps/note-studio/dist'
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
  '.ico': 'image/x-icon', '.txt': 'text/plain',
}
createServer((req, res) => {
  let fp = join(DIST, req.url === '/' ? 'index.html' : req.url.split('?')[0])
  const ext = extname(fp)
  try {
    const data = readFileSync(fp)
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' })
    res.end(data)
  } catch {
    // SPA fallback
    try { const data = readFileSync(join(DIST, 'index.html')); res.writeHead(200, {'Content-Type':'text/html'}); res.end(data) } catch { res.writeHead(404); res.end('Not found') }
  }
}).listen(5200, '127.0.0.1', () => console.log('serve dist on 5200'))
setTimeout(() => process.exit(0), 120000)