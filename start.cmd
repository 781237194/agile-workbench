@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title PM工作台

rem Clear inherited ELECTRON_RUN_AS_NODE; Electron must not run as Node.
rem npm entry does the same in scripts\run-electron.cjs.
set "AWB_INHERITED_RUN_AS_NODE="
if defined ELECTRON_RUN_AS_NODE (
  set "AWB_INHERITED_RUN_AS_NODE=1"
  set "ELECTRON_RUN_AS_NODE="
)

set "ELECTRON_EXE=node_modules\electron\dist\electron.exe"

if /i "%~1"=="--help" goto :help
if /i "%~1"=="--check" goto :check

if not exist "%ELECTRON_EXE%" goto :missing

rem Pass through arguments: --selftest / --user-data-dir=...
"%ELECTRON_EXE%" . %*
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" exit /b 0

echo.
echo [失败] PM工作台启动失败，退出码 %RC%
echo 排查建议：
echo   1. 确认依赖已安装：npm install
echo   2. 确认没有另一个实例占用同一数据目录
echo   3. 改用 npm start 启动（会显示完整报错）
echo   4. 只做启动前检查：start.cmd --check
if not defined AWB_NO_PAUSE pause
exit /b %RC%

:missing
echo [失败] 没有找到 Electron：%CD%\%ELECTRON_EXE%
echo 请先在当前目录安装依赖：
echo     npm install
if not defined AWB_NO_PAUSE pause
exit /b 1

:check
echo [检查] 工作目录：%CD%
if defined AWB_INHERITED_RUN_AS_NODE (
  echo [检查] ELECTRON_RUN_AS_NODE：已清除（继承值原本存在）
) else (
  echo [检查] ELECTRON_RUN_AS_NODE：已清除（未继承到该变量）
)
echo [检查] 命令行参数：%*
if not exist "%ELECTRON_EXE%" (
  echo [失败] 没有找到 Electron：%CD%\%ELECTRON_EXE%
  echo 请先在当前目录安装依赖：
  echo     npm install
  if not defined AWB_NO_PAUSE pause
  exit /b 1
)
echo [检查] Electron：%CD%\%ELECTRON_EXE%
rem --version must print Electron, not Node.
"%ELECTRON_EXE%" --version
if errorlevel 1 (
  echo [失败] Electron --version 执行失败，退出码 %ERRORLEVEL%
  if not defined AWB_NO_PAUSE pause
  exit /b 1
)
echo [检查] 通过：启动PM工作台请直接运行 start.cmd，或 npm start。
exit /b 0

:help
echo 用法：start.cmd [Electron 参数...]
echo.
echo   start.cmd                                    启动PM工作台
echo   start.cmd --selftest                         运行自检
echo   start.cmd --check                            只做启动前检查，不打开窗口
echo   start.cmd --user-data-dir=D:\path\userdata   透传 Electron 参数
echo.
echo 脚本会先清除继承的 ELECTRON_RUN_AS_NODE，再启动 Electron。
echo 失败时打印退出码并暂停；自动化场景可设 AWB_NO_PAUSE=1 跳过暂停。
exit /b 0
