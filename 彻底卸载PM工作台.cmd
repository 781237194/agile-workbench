@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo ============================================================
echo   PM工作台 · 彻底卸载
echo ============================================================
echo 危险：会删除安装目录（含 data 与程序），并清理系统级残留。
echo 默认会先备份 项目\ + 团队\产出\ + 团队\状态\ 到安装目录外同级
echo   ^<安装目录^>-maint-backup\PM工作台-卸载-^<时间^>\
echo 执行时必须逐字输入确认短语：彻底卸载
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Uninstall -Yes
echo.
pause
