@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo ============================================================
echo   PM工作台 · 卸载（干跑）
echo ============================================================
echo 本脚本只出「将删除什么」的清单，不会删除任何文件。
echo 真正卸载请用「彻底卸载PM工作台.cmd」并按要求输入确认短语。
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Uninstall -DryRun
echo.
pause
