param(
  [Parameter(Mandatory = $true)][string]$AppDir,
  [switch]$Kill,
  # B-20261116-134117-bd2e: 测试夹具入口（传 JSON 数组时不再读真实进程）
  [string]$ProcJson = ''
)
# T-ece6：启动前检查「本工作台的 electron 主进程」（不带 --type 的那个）。
# B-20261116-134117-bd2e：只有「默认数据目录的交互实例」才算已有实例；沙箱/长跑/自检实例与守护进程一律不计入。
$ErrorActionPreference = 'Stop'
$prefix = $AppDir.TrimEnd('\') + '\'

$sandboxFlagPattern = '--user-data-dir=|--remote-debugging-port|--theme-shots|--layout-check|--selftest|--b55c-check|--e29f-check|--owner-check|--queue-check|--menu-probe|--ui-check'
$helperPattern = 'route-daemon-host\.cjs'

$fixtureMode = [bool]($ProcJson -and (Test-Path $ProcJson))
if ($fixtureMode) {
  $raw = Get-Content -LiteralPath $ProcJson -Raw -Encoding UTF8 | ConvertFrom-Json
  $procs = @($raw)
} else {
  # B-4fdd（P0 启动 >10s）：默认实例只认 main.js 写的 main.pid 标记（O(1)）。
  # 这条替掉了每次冷启动都跑 Get-CimInstance（实测 3.5-4.3s）的固定开销。
  $marker = Join-Path $AppDir 'data\userdata\main.pid'
  $markerPid = 0
  if (Test-Path -LiteralPath $marker) {
    try { $m = Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json; $markerPid = [int]$m.pid } catch { $markerPid = 0 }
  }
  if ($markerPid -gt 0) {
    $alive = $false
    try {
      $proc = Get-Process -Id $markerPid -ErrorAction Stop
      if ($proc.Path -and $proc.Path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { $alive = $true }
    } catch { $alive = $false }
    if ($alive) {
      Write-Host ('[信息] 默认实例：运行中（PID ' + $markerPid + '，来自 main.pid 标记）')
      if ($Kill) {
        Write-Host ('[清理] 结束残留主进程 PID ' + $markerPid)
        Stop-Process -Id $markerPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 1500
        Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
        exit 0
      }
      Write-Host ('[实例] 默认实例 PID ' + $markerPid)
      exit 3
    }
    # 僵尸标记（进程已不在）：删掉再走兜底
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  }
  # 过渡兜底：老版本/异常退出没有标记时，才做一次昂贵探测（正常冷启动不会走到这里）。
  $fastProcs = @(Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and $_.Path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) } catch { $false }
  })
  if ($fastProcs.Count -eq 0) {
    $procs = @()
  } else {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine -notmatch '--type=' })
  }
}

$defaultIds = @()
$sandboxIds = @()
$helperIds = @()
foreach ($p in $procs) {
  $cmd = [string]$p.CommandLine
  if ($cmd -match $helperPattern) { $helperIds += $p.ProcessId; continue }
  if ($cmd -match $sandboxFlagPattern) { $sandboxIds += $p.ProcessId; continue }
  $defaultIds += $p.ProcessId
}

if ($defaultIds.Count -gt 0) {
  Write-Host ('[信息] 默认实例：运行中（PID ' + ($defaultIds -join ',') + '）')
} else {
  Write-Host '[信息] 默认实例：无'
}
if ($sandboxIds.Count -gt 0) {
  Write-Host ('[信息] 沙箱实例：运行中（PID ' + ($sandboxIds -join ',') + '，不计入已有实例）')
} else {
  Write-Host '[信息] 沙箱实例：无'
}
if ($helperIds.Count -gt 0) {
  Write-Host ('[信息] 守护进程：PID ' + ($helperIds -join ',') + '（不计入已有实例）')
}

if ($Kill) {
  if ($defaultIds.Count -eq 0) {
    Write-Host '[清理] 没有默认实例需要清理（沙箱/守护进程一律不动）'
    exit 0
  }
  foreach ($id in $defaultIds) {
    if ($fixtureMode) {
      Write-Host ('[清理][夹具] 只模拟：不会结束真实进程 PID ' + $id)
    } else {
      Write-Host ('[清理] 结束残留主进程 PID ' + $id)
      Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Milliseconds 1500
  exit 0
}

if ($defaultIds.Count -eq 0) { exit 0 }
foreach ($id in $defaultIds) { Write-Host ('[实例] 默认实例 PID ' + $id) }
exit 3
