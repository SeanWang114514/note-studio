import { spawn } from 'node:child_process'
const p = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5173', '--host', '127.0.0.1'], {
  cwd: 'D:/VibeCoding/note apps/note-studio',
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
  windowsHide: true,
})
p.unref()
p.stdout.on('data', d => process.stdout.write(d))
p.stderr.on('data', d => process.stderr.write(d))
console.log('vite started pid', p.pid)
setTimeout(() => process.exit(0), 5000)