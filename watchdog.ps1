# ============================================================
#  note-studio 自启动守护脚本（watchdog）
# ------------------------------------------------------------
#  由计划任务 NoteStudio-AutoStart（登录时）经 start-studio-hidden.vbs
#  无窗口启动。职责：
#    * 保证 5173（Vite dev server）与 5198（Python 转换服务）常驻；
#    * 任一服务端口失守（进程退出/崩溃）时自动重新拉起；
#    * 运行日志写入 logs\watchdog.log，子进程输出写入 logs\*.log。
#  用法：可直接双击运行，也可由计划任务调用（推荐）。
# ============================================================

$ErrorActionPreference = 'Continue'

$StudioDir = 'D:\VibeCoding\note apps\note-studio'
$LogDir    = Join-Path $StudioDir 'logs'
$WatchLog  = Join-Path $LogDir 'watchdog.log'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# ---- 工具函数 ----
function Write-WatchLog([string]$msg) {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    try { Add-Content -Path $WatchLog -Value $line -Encoding UTF8 } catch { }
    # 日志超过 2MB 只保留末尾 2000 行，防止无限膨胀
    try {
        if ((Get-Item $WatchLog -ErrorAction SilentlyContinue).Length -gt 2MB) {
            Get-Content $WatchLog -Tail 2000 | Set-Content $WatchLog -Encoding UTF8
        }
    } catch { }
}

function Test-PortListening([int]$port) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

# ---- 单实例保护：已存在守护实例则退出 ----
try {
    $self = $PID
    $dup = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessId -ne $self -and $_.CommandLine -match 'watchdog\.ps1' }
    if ($dup) {
        Add-Content -Path $WatchLog -Value ("{0}  已存在守护实例 PID={1}，本实例退出" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), ($dup | Select-Object -First 1 -ExpandProperty ProcessId)) -Encoding UTF8 -ErrorAction SilentlyContinue
        exit 0
    }
} catch { }

# ---- 解析 python / node 可执行路径（优先 PATH，其次绝对路径兜底） ----
$Python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
$Node   = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $Python) { $Python = 'C:\Users\Administrator\AppData\Local\Programs\Python\Python314\python.exe' }
if (-not $Node)   { $Node   = 'D:\软件\Node\node.exe' }

# ---- 确保某服务在运行（端口未监听则拉起） ----
function Ensure-Service([string]$name, [int]$port, [string]$exe, [string]$cmdArgs, [string]$stdout, [string]$stderr) {
    if (Test-PortListening $port) {
        return   # 已在运行，无需处理
    }
    try {
        $p = Start-Process -FilePath $exe -ArgumentList $cmdArgs `
             -WorkingDirectory $StudioDir -WindowStyle Hidden `
             -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
        Write-WatchLog ("已启动 {0}（PID={1}，端口 {2}）" -f $name, $p.Id, $port)
    } catch {
        Write-WatchLog ("启动 {0} 失败：{1}" -f $name, $_.Exception.Message)
    }
}

Write-WatchLog '=== note-studio 守护进程启动 ==='

# ---- 主循环：每 10 秒巡检一次 ----
while ($true) {
    Ensure-Service '转换服务(5198)' 5198 $Python 'server/convert_server.py --port 5198' `
        (Join-Path $LogDir 'convert.out.log') (Join-Path $LogDir 'convert.err.log')
    Ensure-Service 'Vite dev(5173)' 5173 $Node 'node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173' `
        (Join-Path $LogDir 'vite.out.log') (Join-Path $LogDir 'vite.err.log')
    Start-Sleep -Seconds 10
}
