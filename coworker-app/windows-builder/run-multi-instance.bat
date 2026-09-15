@echo off
REM 见智 CoWorker 多实例启动脚本
REM 用于调试：绕过单实例锁检查

echo ========================================
echo   见智 CoWorker - 多实例启动模式
echo ========================================
echo.
echo 此脚本将以 --multi-instance 模式启动应用
echo 允许多个实例同时运行（用于调试）
echo.

set APP_DIR=%~dp0..\dist

if not exist "%APP_DIR%\JZAI-CoWorker.exe" (
    echo 错误: 找不到 JZAI-CoWorker.exe
    echo 请先运行 build.ps1 构建应用
    echo.
    pause
    exit /b 1
)

echo 启动应用: %APP_DIR%\JZAI-CoWorker.exe
echo 参数: --multi-instance
echo.

"%APP_DIR%\JZAI-CoWorker.exe" --multi-instance

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo 应用退出，错误码: %ERRORLEVEL%
    pause
)
