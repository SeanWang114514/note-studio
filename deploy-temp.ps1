Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$src = 'D:\VibeCoding\note apps\note-studio\dart-pdf-editor-web\build\web'
$dst = 'D:\VibeCoding\note apps\note-studio\public\dart-pdf-editor'
if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Recurse -Force }
New-Item -ItemType Directory -Path $dst -Force | Out-Null
Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force
Write-Output 'DEPLOY_OK'
