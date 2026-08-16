# ============================================================
#  note-studio 自启动计划任务安装脚本
# ------------------------------------------------------------
#  注册计划任务 NoteStudio-AutoStart：
#    * 触发器：当前用户登录时（开机登录即自动拉起）
#    * 动作：wscript 无窗口运行 start-studio-hidden.vbs -> watchdog.ps1
#    * 设置：无执行时限、失败每分钟重试、不重复启动多实例、隐藏任务
#  重复运行本脚本会先删旧任务再重建（幂等）。
#  用法：powershell -ExecutionPolicy Bypass -File install-autostart.ps1
# ============================================================

$ErrorActionPreference = 'Stop'

$TaskName = 'NoteStudio-AutoStart'
$StudioDir = 'D:\VibeCoding\note apps\note-studio'
$VbsPath = Join-Path $StudioDir 'start-studio-hidden.vbs'

if (-not (Test-Path $VbsPath)) {
    throw "找不到启动器：$VbsPath"
}

# 删除旧任务（幂等）
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "已删除旧任务 $TaskName"
}

$Action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}"' -f $VbsPath)
$Trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -Hidden

Register-ScheduledTask -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description 'note-studio 网页应用(5173)与转换服务(5198) 登录自启 + 守护' | Out-Null

Write-Host "已注册计划任务：$TaskName"
Write-Host "  触发器：$env:USERNAME 登录时"
Write-Host "  动作：wscript `"$VbsPath`""

# 立即触发一次，验证能拉起服务
Start-ScheduledTask -TaskName $TaskName
Write-Host '已触发任务（服务应在本机 5173/5198 端口就绪）'
