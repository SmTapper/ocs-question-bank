@echo off
setlocal
cd /d "%~dp0"
title OCS 本地 AI 题库 - 关闭此窗口即停止

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 没有检测到 Node.js
  echo.
  echo   请先安装 Node.js 后再运行：https://nodejs.org
  echo.
  pause
  exit /b 1
)

%SystemRoot%\System32\netstat.exe -ano | findstr /c:":7788 " | findstr /c:"LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo.
  echo   ============================================================
  echo    服务已经在运行中了，不需要重复启动
  echo.
  echo    正在帮你打开管理后台...
  echo.
  echo    要停止服务：找到之前打开的那个黑色窗口，关掉它
  echo    本窗口 10 秒后自动关闭，关掉它不影响正在运行的服务
  echo   ============================================================
  echo.
  start "" "http://127.0.0.1:7788"
  %SystemRoot%\System32\PING.EXE -n 11 127.0.0.1 >nul
  exit /b 0
)

echo.
echo   正在启动 OCS 题库服务...
echo.
echo   窗口开着 = 服务在跑，关掉窗口 = 服务停止
echo.

set OPEN_BROWSER=1
node server.js
set EXITCODE=%errorlevel%

echo.
if not "%EXITCODE%"=="0" (
  echo   [服务异常退出] 错误码 %EXITCODE%
  echo.
  echo   请把上面的错误信息截图反馈。
  echo.
  pause
  exit /b %EXITCODE%
)

echo   服务已停止。
%SystemRoot%\System32\PING.EXE -n 4 127.0.0.1 >nul
