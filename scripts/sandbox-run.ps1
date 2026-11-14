# 沙盘运行 wrapper（B-3c03 教训：唤醒按角色名找 DSH 会话，清 sessionId 不够，只有 TEAM_SELFTEST=1 有效）
#
# 用法（一次设置、整个子进程树继承）：
#   pwsh -File scripts\sandbox-run.ps1 -TeamRoot "D:\deepseek\agile-workbench\_tmp\xxx\团队" `
#        -DataDir "D:\deepseek\agile-workbench\_tmp\xxx\data" `
#        -Command "node 项目\工作台改造修复\程序员A\产出\证据-53ff\fix-verify.cjs"
#
# 规则：
#   1. 必须显式给 -TeamRoot 与 -DataDir（指向 _tmp 沙盘），拒绝在真实 团队/ 上运行；
#   2. 强制 TEAM_SELFTEST=1（子进程继承；每条命令都生效，不依赖会话级设置）；
#   3. 调用前把沙盘名册的 members[].sessionId 清空（第二道保险）；
#   4. 有任何一项不满足就 throw，不降级、不继续。
param(
  [Parameter(Mandatory = $true)][string]$TeamRoot,
  [Parameter(Mandatory = $true)][string]$DataDir,
  [Parameter(Mandatory = $true)][string]$Command,
  [string]$ProjectsRoot = ""
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$teamAbs = [System.IO.Path]::GetFullPath($TeamRoot)
$dataAbs = [System.IO.Path]::GetFullPath($DataDir)

if (-not (Test-Path $teamAbs)) { throw "沙盘团队目录不存在：$teamAbs" }
if ($teamAbs -notmatch '_tmp[\\/]') { throw "拒绝运行：-TeamRoot 必须位于 _tmp 沙盘内（收到 $teamAbs）" }
if ($dataAbs -notmatch '_tmp[\\/]') { throw "拒绝运行：-DataDir 必须位于 _tmp 沙盘内（收到 $dataAbs）" }

# 名册 sessionId 清空（第二道保险；第一道是 TEAM_SELFTEST=1）
$teamJson = Join-Path $teamAbs '状态\团队.json'
if (-not (Test-Path $teamJson)) { throw "沙盘名册不存在：$teamJson" }
$backup = "$teamJson.bak-sandbox-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $teamJson $backup -Force
$team = Get-Content $teamJson -Raw -Encoding UTF8 | ConvertFrom-Json
if ($team.PSObject.Properties.Name -contains 'members') {
  foreach ($m in $team.members) { if ($m.PSObject.Properties.Name -contains 'sessionId') { $m.sessionId = '' } }
}
$team | ConvertTo-Json -Depth 12 | Set-Content $teamJson -Encoding UTF8

$env:TEAM_SELFTEST = '1'
$env:TEAM_ROOT = $teamAbs
$env:AWB_DATA_DIR = $dataAbs
if ($ProjectsRoot) { $env:TEAM_PROJECTS_ROOT = [System.IO.Path]::GetFullPath($ProjectsRoot) }

Write-Host "[sandbox-run] TEAM_SELFTEST=1 TEAM_ROOT=$env:TEAM_ROOT AWB_DATA_DIR=$env:AWB_DATA_DIR" -ForegroundColor Yellow
& ([scriptblock]::Create($Command))
exit $LASTEXITCODE
