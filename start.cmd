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

rem T-ece6: always absolute paths derived from %~dp0.
rem Relative launch is what left an unkillable zombie main process holding the single-instance lock today.
set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
set "ELECTRON_EXE=%APP_DIR%\node_modules\electron\dist\electron.exe"
set "GUARD_PS1=%APP_DIR%\scripts\start-guard.ps1"

if /i "%~1"=="--help" goto :help
if /i "%~1"=="--check" goto :check

if not exist "%ELECTRON_EXE%" goto :missing

rem T-ece6: detect leftover main processes for THIS app dir. Never kill by default.
powershell -NoProfile -ExecutionPolicy Bypass -File "%GUARD_PS1%" -AppDir "%APP_DIR%"
set "GUARD_RC=%ERRORLEVEL%"

if /i "%~1"=="--kill-orphans" goto :kill_orphans
if "%START_KILL_ORPHANS%"=="1" goto :kill_orphans

if "%GUARD_RC%"=="3" (
  echo [提示] 本工作台已有 electron 主进程在运行（PID 见上）。
  echo   任务栏有窗口就切过去，不用重复启动。
  echo   没有窗口却起不来（黑屏/秒退）说明是残留进程占着单实例锁，执行： start.cmd --kill-orphans
  exit /b 2
)

:launch
"%ELECTRON_EXE%" "%APP_DIR%" %*
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" exit /b 0

echo.
if "%RC%"=="1" (
  echo [失败] 启动被拒（退出码 1）。最常见：另一个实例占着单实例锁。
  echo   查日志关键字 SINGLE_INSTANCE_LOCK_DENIED
  echo   确认没有窗口后执行： start.cmd --kill-orphans
) else (
  echo [失败] PM工作台启动失败，退出码 %RC%
)
echo 排查建议：
echo   1. 确认依赖已安装：npm install
echo   2. 确认没有另一个实例占用同一数据目录
echo   3. 改用 npm start 启动（会显示完整报错）
echo   4. 只做启动前检查：start.cmd --check
if not defined AWB_NO_PAUSE pause
exit /b %RC%

:kill_orphans
echo [清理] 结束本工作台残留 electron 主进程...
powershell -NoProfile -ExecutionPolicy Bypass -File "%GUARD_PS1%" -AppDir "%APP_DIR%" -Kill
goto :launch

:check
echo [检查] APP_DIR=%APP_DIR%
echo [检查] electron=%ELECTRON_EXE%
if exist "%ELECTRON_EXE%" (echo [检查] electron 存在) else (echo [检查] electron 缺失，请先 npm install)
powershell -NoProfile -ExecutionPolicy Bypass -File "%GUARD_PS1%" -AppDir "%APP_DIR%"
if errorlevel 3 (echo [检查] 结论：有残留主进程，启动前建议 start.cmd --kill-orphans) else (echo [检查] 结论：没有残留主进程)
exit /b 0

:missing
echo [失败] 没有找到 Electron：%ELECTRON_EXE%
echo 请先在当前目录安装依赖：
echo     npm install
if not defined AWB_NO_PAUSE pause
exit /b 1

:help
echo PM工作台启动脚本（T-ece6 加固版）
echo   start.cmd                 正常启动（有残留主进程时只提示、不启动）
echo   start.cmd --check         只做启动前检查（路径 / electron / 残留主进程）
echo   start.cmd --kill-orphans  先清掉本工作台残留主进程再启动
echo   start.cmd --selftest ...  透传参数给 Electron
echo 路径全部由 %~dp0 派生为绝对路径；锁冲突会写 SINGLE_INSTANCE_LOCK_DENIED 并弹人话提示。
exit /b 0
