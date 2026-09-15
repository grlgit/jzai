# -----------------------------------------------------------------------------
# diagnose.ps1 - Diagnostic Script
#
# Helps identify why CoWorker is failing to start
# -----------------------------------------------------------------------------

Write-Host "========================================"  -ForegroundColor Cyan
Write-Host "  见智 CoWorker 诊断工具"  -ForegroundColor Cyan
Write-Host "========================================"  -ForegroundColor Cyan
Write-Host ""

# 1. Check for running instances
Write-Host "[1] 检查运行中的进程..." -ForegroundColor Yellow
$processes = Get-Process | Where-Object {
    $_.ProcessName -like "*JZAI*" -or
    $_.ProcessName -like "*coworker*" -or
    $_.MainWindowTitle -like "*见智*"
}

if ($processes) {
    Write-Host "发现以下相关进程:" -ForegroundColor Red
    $processes | ForEach-Object {
        Write-Host "  - PID:$($_.Id) $($_.ProcessName) $($_.MainWindowTitle)" -ForegroundColor DarkGray
        Write-Host "    路径: $($_.Path)" -ForegroundColor DarkGray
    }
    Write-Host ""
    Write-Host "建议: 结束上述进程后重试" -ForegroundColor Yellow
    Write-Host "按任意键尝试结束所有 CoWorker 进程..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    $processes | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Host "进程已结束" -ForegroundColor Green
} else {
    Write-Host "未发现相关进程" -ForegroundColor Green
}
Write-Host ""

# 2. Check log files
Write-Host "[2] 检查日志文件..." -ForegroundColor Yellow
$logDir = "$env:LOCALAPPDATA\JZAI-CoWorker\logs"
if (Test-Path $logDir) {
    $latestLog = Get-ChildItem $logDir -Filter "main-*.log" |
                 Sort-Object LastWriteTime -Descending |
                 Select-Object -First 1

    if ($latestLog) {
        Write-Host "最新日志文件: $($latestLog.Name)" -ForegroundColor DarkGray
        Write-Host "最后修改时间: $($latestLog.LastWriteTime)" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "最后 20 行日志:" -ForegroundColor Cyan
        Get-Content $latestLog.FullName -Tail 20 | ForEach-Object {
            if ($_ -match "\[error\]") {
                Write-Host $_  -ForegroundColor Red
            } elseif ($_ -match "\[warn\]") {
                Write-Host $_  -ForegroundColor Yellow
            } else {
                Write-Host $_  -ForegroundColor DarkGray
            }
        }
    }
} else {
    Write-Host "未找到日志目录" -ForegroundColor Yellow
}
Write-Host ""

# 3. Check for locks
Write-Host "[3] 检查单实例锁..." -ForegroundColor Yellow
$lockFile = "$env:APPDATA\..\Local\JZAI-CoWorker\single-instance.lock"
if (Test-Path $lockFile) {
    Write-Host "发现锁文件: $lockFile" -ForegroundColor Red
    Write-Host "建议: 删除此文件后重试"
    Write-Host "按任意键删除锁文件..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    Remove-Item $lockFile -Force
    Write-Host "锁文件已删除" -ForegroundColor Green
} else {
    Write-Host "未发现锁文件" -ForegroundColor Green
}
Write-Host ""

# 4. Summary
Write-Host "========================================"  -ForegroundColor Cyan
Write-Host "诊断完成"  -ForegroundColor Cyan
Write-Host "========================================"  -ForegroundColor Cyan
Write-Host ""
Write-Host "下一步建议:" -ForegroundColor Yellow
Write-Host "1. 如果仍有进程运行，请手动在任务管理器中结束" -ForegroundColor DarkGray
Write-Host "2. 运行 .\run-multi-instance.bat 绕过单实例锁" -ForegroundColor DarkGray
Write-Host "3. 或重新运行 .\build.ps1 构建最新版本" -ForegroundColor DarkGray
Write-Host ""
