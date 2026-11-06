@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>&1
title PM工作台 安装
cd /d "%~dp0"

rem 告诉 install.ps1：暂停由本脚本负责，避免失败时出现两次“按回车”。
set "AWB_INSTALLER_FROM_CMD=1"

echo.
echo ============================================================
echo   PM工作台 - Windows 一键安装
echo ============================================================
echo.

if not exist "%~dp0install.ps1" (
  echo [失败] 没有找到 install.ps1。
  echo        请确认下载的是完整仓库：install.ps1 必须与本文件在同一目录。
  echo        仓库地址：https://github.com/781237194/agile-workbench
  echo.
  if not defined AWB_NO_PAUSE pause
  exit /b 1
)

rem 用 Windows 自带的 PowerShell 5.1；Bypass 只影响这一次进程。
rem 用绝对路径，避免 PATH 被改坏或被同名程序顶替。
set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" set "PS_EXE=powershell.exe"

"%PS_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo [提示] 安装没有完成，退出码 %RC%。
  echo        窗口保留，方便查看上面的报错和日志路径。
  if not defined AWB_NO_PAUSE pause
)

exit /b %RC%
