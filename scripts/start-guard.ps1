param(
  [Parameter(Mandatory = $true)][string]$AppDir,
  [switch]$Kill
)
# T-ece6：启动前检查「本工作台的 electron 主进程」（不带 --type 的那个）。
# 只按 ExecutablePath 前缀判断，不看命令行里的相对路径——白天的僵尸锁就是相对路径启动、命令行没有全路径导致的。
$ErrorActionPreference = 'Stop'
$prefix = $AppDir.TrimEnd('\') + '\'
$procs = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine -notmatch '--type=' })
if (-not $procs.Count) { exit 0 }
if ($Kill) {
  foreach ($p in $procs) {
    Write-Host ("[清理] 结束残留主进程 PID " + $p.ProcessId)
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 1500
  exit 0
}
foreach ($p in $procs) { Write-Host $p.ProcessId }
exit 3
