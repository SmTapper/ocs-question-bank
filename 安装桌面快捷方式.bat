@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 安装桌面快捷方式

echo.
echo  ============================================
echo    OCS 本地 AI 题库 - 桌面快捷方式安装
echo  ============================================

powershell -NoProfile -ExecutionPolicy Bypass -File "tools\安装快捷方式.ps1"
if errorlevel 1 (
  echo.
  echo   安装失败，请把上面的错误信息截图反馈。
  pause
  exit /b 1
)

pause
