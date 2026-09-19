Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$src = 'D:\VibeCoding\note apps\note-studio\dart-pdf-editor-web\build\web'
$dst = 'D:\VibeCoding\note apps\note-studio\public\dart-pdf-editor'
if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Recurse -Force }
New-Item -ItemType Directory -Path $dst -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $src '*') -Destination $dst -Recurse -Force
$js = Join-Path $dst 'main.dart.js'
if (!(Test-Path -LiteralPath $js)) { throw 'Deployed main.dart.js missing' }
$text = [IO.File]::ReadAllText($js)
$hasApp = $text.Length -gt 100000 -and ($text -match 'dart_pdf_editor|Pdf|pdf')
$hasFirstFrame = $text.Contains('FLUTTER-FIRST-FRAME')
Write-Output ('VERIFY main.dart.js bytes=' + (Get-Item -LiteralPath $js).Length + ' compiledApp=' + $hasApp + ' FLUTTER-FIRST-FRAME=' + $hasFirstFrame)
if (!$hasApp -or $hasFirstFrame) { throw 'Deployment verification failed' }
