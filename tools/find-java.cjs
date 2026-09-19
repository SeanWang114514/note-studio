const { execSync } = require('child_process')
const fs = require('fs')
const dirs = ['C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Microsoft', 'C:\\Program Files\\Android', 'C:\\Program Files\\JetBrains']
const found = []
for (const d of dirs) {
  try { for (const e of fs.readdirSync(d)) { const full = d + '\\' + e; try { if (fs.statSync(full).isDirectory()) found.push(full) } catch {} } } catch {}
}
console.log(found.join('\n') || 'none')
