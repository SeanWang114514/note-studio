# 下载 open-pdf-studio 源码（open-pdf-studio/ 子目录）vendor 到工作区副本
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$base = 'D:/VibeCoding/note apps/note-studio/vendor/open-pdf-studio'
$tmpTree = "$env:TEMP/ops-tree.json"
New-Item -ItemType Directory -Force -Path $base | Out-Null

# 1. 取完整文件树
if (-not (Test-Path $tmpTree)) {
  Invoke-RestMethod -Uri 'https://api.github.com/repos/OpenAEC-Foundation/open-pdf-studio/git/trees/main?recursive=1' -Headers @{ 'User-Agent' = 'dsh' } -TimeoutSec 90 | ConvertTo-Json -Depth 4 | Set-Content $tmpTree
}
$tree = (Get-Content $tmpTree -Raw | ConvertFrom-Json).tree

# 2. 筛选：open-pdf-studio/ 下、非 APK、非 public/pdfjs（内置 pdfjs 副本）、大小 < 2MB
$files = $tree | Where-Object {
  $_.type -eq 'blob' -and
  $_.path -like 'open-pdf-studio/*' -and
  $_.path -notlike 'open-pdf-studio/public/*' -and
  $_.path -notlike '*/node_modules/*' -and
  $_.size -lt 2000000
}
Write-Output "TOTAL FILES TO VENDOR: $($files.Count)"
$ok = 0; $fail = 0; $skip = 0
foreach ($f in $files) {
  $rel = $f.path -replace '^open-pdf-studio/',''
  $dest = Join-Path $base $rel
  if (Test-Path $dest) { $skip++; continue }
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  curl.exe -s -L "https://raw.githubusercontent.com/OpenAEC-Foundation/open-pdf-studio/main/$($f.path)" -o $dest --max-time 60
  if ((Get-Item $dest -ErrorAction SilentlyContinue).Length -gt 0) { $ok++ } else { $fail++ }
}
Write-Output "DOWNLOADED=$ok SKIPPED=$skip FAILED=$fail"
$total = (Get-ChildItem $base -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
Write-Output "TOTAL VENDOR SIZE: $([math]::Round($total/1MB,2)) MB, FILES: $((Get-ChildItem $base -Recurse -File).Count)"
