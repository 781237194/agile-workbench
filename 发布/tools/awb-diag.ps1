# awb-diag.ps1 —— 工作台（PM工作台 / agile-workbench）只读诊断包
# 用法（在出问题的那台笔记本上）：右键「使用 PowerShell 运行」，或：
#   powershell -ExecutionPolicy Bypass -File awb-diag.ps1
# 产物：桌面\awb-diag-<时间>\  以及同名 .zip（把这个 zip 发回来即可）
# 安全：只读。不杀进程、不改配置、不读账号密码/令牌、不上传网络。
# 2026-11-19 PM 版：针对「首开粒子特效 / boot 引导 / 幽灵团队·恢复项目 / 在线升级按钮」四项取证。

param(
    [switch]$VerifyClean,
    [string]$Mode,
    [string]$Root,
    [string]$DshHome,
    [string]$LocalAppDataDir,
    [string]$TempDir,
    [string]$ShortcutDir,
    [switch]$Json
)

# ── R-2de7 §6.5：维护后的「干净」判定（只读；A–H 八类）────────────────────────
#   A 安装目录与运行态 / B 快捷方式 / C env / D AppData / E DSH profile /
#   F 计划任务+自启 / G hosts 标记段 / H 进程（命令行含 Root）
#   判定行：重置且 A 类运行态全 CLEAN →「重置判定：干净」；卸载且 A–H 全 CLEAN（KEPT 算残留）→「卸载判定：干净」；
#   机器行：VERDICT: CLEAN|RESIDUE / RESIDUE_COUNT: n；退出码 0 干净 / 2 有残留 / 1 参数或内部错。
if ($VerifyClean) {
    try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
    $ErrorActionPreference = 'SilentlyContinue'
    $items = @()
    function Add-CleanItem([string]$Kind, [string]$Category, [string]$Path, [string]$Reason = '') {
        $item = [ordered]@{ kind = $Kind; category = $Category; path = $Path; reason = $Reason }
        $script:CleanItems += $item
    }
    $script:CleanItems = @()
    $rootPath = $Root
    if (-not $rootPath) {
        $cwdNow = (Get-Location).Path
        foreach ($cand in @($cwdNow, (Split-Path -Parent $PSCommandPath), (Split-Path -Parent (Split-Path -Parent $PSCommandPath)))) {
            if ($cand -and (Test-Path (Join-Path $cand 'package.json')) -and (Test-Path (Join-Path $cand 'start.cmd'))) { $rootPath = $cand; break }
        }
    }
    $modeNow = $Mode
    if (-not $modeNow) { $modeNow = if ($rootPath -and (Test-Path -LiteralPath $rootPath)) { 'reset' } else { 'uninstall' } }
    if ($modeNow -notin @('reset', 'uninstall')) {
        Write-Host '参数错误：-Mode 只能是 reset 或 uninstall'
        exit 1
    }

    # A 安装目录与运行态
    if ($rootPath -and (Test-Path -LiteralPath $rootPath)) {
        $runtimeRels = @('data\userdata', 'data\tmp')
        foreach ($rel in $runtimeRels) { if (Test-Path (Join-Path $rootPath $rel)) { Add-CleanItem 'RESIDUE' 'A' (Join-Path $rootPath $rel) '运行态目录' } }
        foreach ($name in @('dsh.json', 'dsh-capability.json', 'dsh-endpoint.jsonl', 'fx.jsonl', 'mcp-selfcheck.json')) {
            $p = Join-Path (Join-Path $rootPath 'data') $name
            if (Test-Path $p) { Add-CleanItem 'RESIDUE' 'A' $p '运行态文件' }
        }
        foreach ($rel in @('团队\状态', '团队\日志', '_tmp', '.selftest-data', '.sandbox')) {
            if (Test-Path (Join-Path $rootPath $rel)) { Add-CleanItem 'RESIDUE' 'A' (Join-Path $rootPath $rel) '重置应删项' }
        }
        foreach ($f in @(Get-ChildItem -LiteralPath (Join-Path $rootPath '团队') -Filter '看板.*' -File)) { Add-CleanItem 'RESIDUE' 'A' $f.FullName '派生看板' }
        foreach ($d in @(Get-ChildItem -LiteralPath $rootPath -Directory -Filter '*-check-data')) { Add-CleanItem 'RESIDUE' 'A' $d.FullName '自检目录' }
    } elseif ($modeNow -eq 'uninstall' -and $rootPath) {
        Add-CleanItem 'CLEAN' 'A' $rootPath '安装目录已不存在'
    }

    # B 快捷方式
    $shortcutDirs = @()
    if ($ShortcutDir) { $shortcutDirs += $ShortcutDir } else { $shortcutDirs += [Environment]::GetFolderPath('Desktop') }
    foreach ($dir in $shortcutDirs) {
        if (-not $dir) { continue }
        $lnk = Join-Path $dir 'PM工作台.lnk'
        if (Test-Path $lnk) {
            $pointsHere = $false
            try {
                $shell = New-Object -ComObject WScript.Shell
                $sc = $shell.CreateShortcut($lnk)
                $pointsHere = ([string]$sc.Arguments -match '(?i)launch\.vbs') -and ([string]$sc.TargetPath -match '(?i)wscript\.exe$')
            } catch { }
            if ($pointsHere) { Add-CleanItem 'RESIDUE' 'B' $lnk '桌面快捷方式仍在' } else { Add-CleanItem 'KEPT' 'B' $lnk '快捷方式指向别处' }
        }
    }

    # C env
    foreach ($name in @('AWB_TEAM_ROOT', 'PM_WORKBENCH_HOME')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'User')
        if (-not $value) { continue }
        if ($rootPath -and ($value.TrimEnd('\').ToLower() -eq $rootPath.TrimEnd('\').ToLower() -or $value.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase))) {
            Add-CleanItem 'RESIDUE' 'C' $name ('User env=' + $value)
        } else {
            Add-CleanItem 'KEPT' 'C' $name ('User env=' + $value)
        }
    }

    # D AppData / 临时
    $localAppData = if ($LocalAppDataDir) { $LocalAppDataDir } else { $env:LOCALAPPDATA }
    $tempNow = if ($TempDir) { $TempDir } else { [System.IO.Path]::GetTempPath() }
    foreach ($p in @((Join-Path $localAppData 'PMWorkbench'), (Join-Path $localAppData 'electron\Cache'))) {
        if (Test-Path $p) { Add-CleanItem 'RESIDUE' 'D' $p 'AppData 缓存仍在' }
    }
    foreach ($pattern in @('pm-workbench-*', 'PMWorkbench-*')) {
        foreach ($d in @(Get-ChildItem -LiteralPath $tempNow -Directory -Filter $pattern)) { Add-CleanItem 'RESIDUE' 'D' $d.FullName '临时目录仍在' }
    }

    # E DSH profile 注册
    $dshRoot = if ($DshHome) { $DshHome } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh' }
    $profilesDir = Join-Path $dshRoot 'profiles'
    foreach ($pkg in @(Get-ChildItem -LiteralPath $profilesDir -Directory)) {
        $pkgFile = Join-Path $pkg.FullName 'package.json'
        if (-not (Test-Path $pkgFile)) { continue }
        $text = [System.IO.File]::ReadAllText($pkgFile, [System.Text.Encoding]::UTF8)
        if ($text -match 'pm-workbench-dsh|dsh-agile-workbench') { Add-CleanItem 'RESIDUE' 'E' $pkgFile 'DSH profile 仍注册本插件' }
    }

    # F 计划任务 + 自启
    foreach ($task in @(Get-ScheduledTask | Where-Object { $_.TaskName -match '^(PM工作台|PMWorkbench|AgileWorkbench)' })) {
        Add-CleanItem 'RESIDUE' 'F' ('task:' + $task.TaskName) '计划任务仍在'
    }
    $runKey = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    if ($runKey) {
        foreach ($prop in @($runKey.PSObject.Properties)) {
            if ($prop.Name -match '^(PM工作台|PMWorkbench|AgileWorkbench)' -and $prop.Name -ne 'PSPath' -and $prop.Name -ne 'PSParentPath' -and $prop.Name -ne 'PSChildName' -and $prop.Name -ne 'PSDrive' -and $prop.Name -ne 'PSProvider') {
                Add-CleanItem 'RESIDUE' 'F' ('run:' + $prop.Name) 'HKCU Run 仍有自启项'
            }
        }
    }
    $startupDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'Startup'
    foreach ($lnk in @(Get-ChildItem -LiteralPath $startupDir -Filter '*.lnk')) {
        if ($lnk.Name -match '^(PM工作台|PMWorkbench|AgileWorkbench)') { Add-CleanItem 'RESIDUE' 'F' $lnk.FullName '启动夹仍有快捷方式' }
    }

    # G hosts 标记段
    $hostsFile = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
    if ($env:AWB_GITHUBFIX_HOSTS_PATH) { $hostsFile = $env:AWB_GITHUBFIX_HOSTS_PATH }
    if (Test-Path $hostsFile) {
        try {
            if (([System.IO.File]::ReadAllText($hostsFile, [System.Text.Encoding]::UTF8)) -match '>>> PMWorkbench GitHubFix >>>') {
                Add-CleanItem 'RESIDUE' 'G' $hostsFile 'hosts 仍有 GitHubFix 标记段'
            }
        } catch { }
    }

    # H 进程（命令行含 Root）
    if ($rootPath) {
        foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'")) {
            $cmd = [string]$p.CommandLine
            if ($cmd -and $cmd.IndexOf($rootPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                Add-CleanItem 'RESIDUE' 'H' ('pid:' + $p.ProcessId) '本安装的 Electron 仍在运行'
            }
        }
    }

    # 判定：reset 只看 A 类；uninstall 看 A–H（KEPT 算残留）
    $scope = if ($modeNow -eq 'reset') { @('A') } else { @('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H') }
    $relevant = @($script:CleanItems | Where-Object { $_.category -in $scope })
    $residue = @($relevant | Where-Object { $_.kind -eq 'RESIDUE' })
    $kept = @($relevant | Where-Object { $_.kind -eq 'KEPT' })
    $residueCount = if ($modeNow -eq 'reset') { $residue.Count } else { $residue.Count + $kept.Count }
    $verdict = if ($residueCount -eq 0) { 'CLEAN' } else { 'RESIDUE' }

    if ($Json) {
        [ordered]@{ mode = $modeNow; root = $rootPath; verdict = $verdict; residueCount = $residueCount; items = $script:CleanItems } | ConvertTo-Json -Depth 6
    } else {
        Write-Host ''
        Write-Host ('===== PM工作台 · 干净判定（' + $modeNow + '）=====') -ForegroundColor Cyan
        Write-Host ('  Root: ' + ($rootPath | ForEach-Object { $_ } | Out-String).Trim())
        foreach ($it in $script:CleanItems) {
            $label = if ($it.kind -eq 'RESIDUE') { '残留' } elseif ($it.kind -eq 'KEPT') { '保留' } else { '干净' }
            Write-Host ('  [' + $it.category + '] [' + $label + '] ' + $it.path + ' ' + $it.reason)
        }
        foreach ($it in $residue) { Write-Host ('  残留项：' + $it.category + ' ' + $it.path + '（' + $it.reason + '）') -ForegroundColor Yellow }
        if ($residueCount -eq 0) {
            if ($modeNow -eq 'reset') { Write-Host '重置判定：干净' -ForegroundColor Green } else { Write-Host '卸载判定：干净' -ForegroundColor Green }
        } else {
            Write-Host ('判定：有残留（' + $residueCount + ' 项）') -ForegroundColor Yellow
        }
        Write-Host ('VERDICT: ' + $verdict)
        Write-Host ('RESIDUE_COUNT: ' + $residueCount)
    }
    if ($verdict -eq 'CLEAN') { exit 0 }
    exit 2
}

$ErrorActionPreference = 'SilentlyContinue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$desktop = [Environment]::GetFolderPath('Desktop')
$out = Join-Path $desktop "awb-diag-$stamp"
New-Item -ItemType Directory -Path $out -Force | Out-Null

function W($name, $value) {
  $p = Join-Path $out $name
  if ($value -is [array]) { $value | Out-File -FilePath $p -Encoding utf8 }
  else { [string]$value | Out-File -FilePath $p -Encoding utf8 }
}
function Section($t) { "`n===== $t =====" }

# ---------- 1. 机器与系统 ----------
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
W '01-system.txt' @(
  (Section '系统'),
  "时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')",
  "主机名: $env:COMPUTERNAME  用户: $env:USERNAME",
  "OS: $($os.Caption) $($os.Version) build $($os.BuildNumber)",
  "内存: $([math]::Round($cs.TotalPhysicalMemory/1GB,1)) GB  可用: $([math]::Round($os.FreePhysicalMemory/1MB,1)) GB",
  "PowerShell: $($PSVersionTable.PSVersion)",
  (Section '磁盘'),
  (Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{n='UsedGB';e={[math]::Round($_.Used/1GB,1)}}, @{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}} | Format-Table -AutoSize | Out-String)
)

# ---------- 2. 安装位置与版本 ----------
$candidates = @()
$unins = @()
foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
                    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
                    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
  $unins += Get-ItemProperty $root | Where-Object { $_.DisplayName -match '工作台|Workbench|agile' } |
            Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString
}
$unins | Format-List | Out-String | Out-File (Join-Path $out '02-uninstall-entries.txt') -Encoding utf8

foreach ($u in $unins) { if ($u.InstallLocation) { $candidates += $u.InstallLocation } }
$candidates += @(
  "$env:LOCALAPPDATA\Programs\pm-workbench",
  "$env:LOCALAPPDATA\Programs\agile-workbench",
  "$env:ProgramFiles\pm-workbench",
  'D:\deepseek\agile-workbench'
) | Select-Object -Unique

$found = @()
foreach ($c in $candidates) {
  if ($c -and (Test-Path $c)) {
    $pkg = Join-Path $c 'package.json'
    $ver = ''
    if (Test-Path $pkg) { try { $ver = (Get-Content $pkg -Raw -Encoding utf8 | ConvertFrom-Json).version } catch {} }
    $found += [pscustomobject]@{
      Path = $c
      Version = $ver
      HasNodeModules = Test-Path (Join-Path $c 'node_modules')
      HasElectron = Test-Path (Join-Path $c 'node_modules\electron\dist\electron.exe')
      HasMainJs = Test-Path (Join-Path $c 'src\main.js')
      HasDataDir = Test-Path (Join-Path $c 'data\userdata')
      HasProjects = Test-Path (Join-Path $c '项目')
      LastWrite = (Get-Item $c).LastWriteTime
    }
  }
}
$found | Format-Table -AutoSize | Out-String -Width 400 | Out-File (Join-Path $out '03-install-candidates.txt') -Encoding utf8

# ---------- 3. 运行中进程（只读，不杀） ----------
$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(electron|pm-workbench|node)\.exe$' }
W '04-processes.txt' @(
  (Section 'electron/node 进程（只读快照）'),
  ($procs | Select-Object ProcessId, ParentProcessId, Name, @{n='Cmd';e={ $_.CommandLine }} | Format-Table -AutoSize -Wrap | Out-String -Width 400)
)

# ---------- 4. 各安装点的日志 ----------
$logDir = Join-Path $out '05-logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
foreach ($f in $found) {
  $base = $f.Path
  $logs = @()
  $logs += Get-ChildItem $base -Filter '*.log' -File
  $logs += Get-ChildItem (Join-Path $base 'logs') -Filter '*.log' -File
  $logs += Get-ChildItem (Join-Path $base 'data\userdata') -Filter '*.log' -File
  foreach ($l in ($logs | Where-Object { $_ } | Sort-Object LastWriteTime -Descending | Select-Object -First 12)) {
    $tag = ($f.Path -replace '[\\/:*?"<>|]', '_')
    $dest = Join-Path $logDir ("{0}__{1}" -f $tag, $l.Name)
    Get-Content $l.FullName -Tail 400 | Out-File $dest -Encoding utf8
  }
}
"日志拷贝完成 $(Get-Date -Format 'HH:mm:ss')" | Out-File (Join-Path $logDir '_done.txt') -Encoding utf8

# ---------- 5. 工作台自身数据（脱敏：只取结构，不取令牌） ----------
$probe = @()
foreach ($f in $found) {
  $wb = Join-Path $f.Path 'data\userdata\workbench.json'
  if (Test-Path $wb) {
    try {
      $j = Get-Content $wb -Raw -Encoding utf8 | ConvertFrom-Json
      $probe += [pscustomobject]@{
        Root = $f.Path
        WorkbenchBytes = (Get-Item $wb).Length
        EffectLevel = $j.ui.effectLevel
        ReduceMotion = $j.ui.reduceMotion
        Projects = @($j.projects).Count
        ProjectNames = (@($j.projects) | ForEach-Object { $_.name }) -join ' | '
        ActiveProject = $j.activeProject
        SessionIdsFilled = (@($j.projects) | ForEach-Object { if ($_.sessions) { (@($_.sessions.PSObject.Properties).Count) } else { 0 } }) -join ','
      }
    } catch { $probe += [pscustomobject]@{ Root = $f.Path; Error = "workbench.json 解析失败: $($_.Exception.Message)" } }
  }
}
$probe | Format-List | Out-String | Out-File (Join-Path $out '06-workbench-state.txt') -Encoding utf8

# ---------- 6. 升级链路取证（在线升级按钮） ----------
$verSources = @()
foreach ($f in $found) {
  foreach ($rel in @('发布\版本信息.json', 'resources\发布\版本信息.json', 'version.json')) {
    $p = Join-Path $f.Path $rel
    if (Test-Path $p) { $verSources += [pscustomobject]@{ File = $p; Body = (Get-Content $p -Raw -Encoding utf8) } }
  }
}
W '07-upgrade-feed-local.txt' @(
  (Section '本地版本信息文件'),
  ($verSources | ForEach-Object { "--- $($_.File)"; $_.Body } )
)
$feed = @()
try {
  $r = Invoke-WebRequest -Uri 'https://cdn.jsdelivr.net/gh/781237194/agile-workbench@main/%E5%8F%91%E5%B8%83/%E7%89%88%E6%9C%AC%E4%BF%A1%E6%81%AF.json' -TimeoutSec 15 -UseBasicParsing
  $feed += "HTTP $($r.StatusCode)"
  $feed += $r.Content
} catch { $feed += "请求失败: $($_.Exception.Message)" }
W '08-upgrade-feed-remote.txt' $feed

# ---------- 7. 四项功能的现场探测 ----------
$probe2 = @()
$probe2 += Section 'A. 首开粒子特效 / 特效等级'
foreach ($f in $found) {
  $wb = Join-Path $f.Path 'data\userdata\workbench.json'
  if (Test-Path $wb) {
    $probe2 += "$($f.Path): ui.effectLevel=$(try{ (Get-Content $wb -Raw -Encoding utf8 | ConvertFrom-Json).ui.effectLevel }catch{'读取失败'})"
  }
  $css = Join-Path $f.Path 'src\renderer\style.css'
  if (Test-Path $css) {
    $hit = Select-String -Path $css -Pattern 'awb-particle|particle|effect-particle' -SimpleMatch -AllMatches
    $probe2 += "  style.css 粒子相关命中: $(@($hit).Count)"
  }
}
$probe2 += Section 'B. boot 引导（引导页/简报）'
foreach ($f in $found) {
  foreach ($n in @('src\renderer\boot-guide.js','src\renderer\boot-*.js','src\boot-guide.js','src\renderer\app.js')) {
    $p = Join-Path $f.Path $n
    if (Test-Path $p) { $probe2 += "  存在: $p  ($([math]::Round((Get-Item $p).Length/1KB,1)) KB, $(Get-Item $p).LastWriteTime)" }
  }
}
$probe2 += Section 'C. 幽灵团队 / 恢复项目'
foreach ($f in $found) {
  $team = Join-Path $f.Path '团队\状态\团队.json'
  if (Test-Path $team) {
    try {
      $t = Get-Content $team -Raw -Encoding utf8 | ConvertFrom-Json
      $probe2 += "  团队.json: activeProject=$($t.activeProject)  成员数=$(@($t.members).Count)  带 sessionId 成员数=$(@($t.members | Where-Object { $_.sessionId }).Count)"
    } catch { $probe2 += "  团队.json 解析失败" }
  } else { $probe2 += "  团队.json 不存在: $team" }
  $wsp = Join-Path $f.Path '项目'
  if (Test-Path $wsp) { $probe2 += "  项目目录数: $(@(Get-ChildItem $wsp -Directory).Count): $((Get-ChildItem $wsp -Directory | Select-Object -First 12 -ExpandProperty Name) -join ' | ')" }
}
$probe2 += Section 'D. 在线升级按钮'
foreach ($f in $found) {
  $main = Join-Path $f.Path 'src\main.js'
  if (Test-Path $main) {
    $hit = Select-String -Path $main -Pattern 'upgrade-start|upgrade:' -AllMatches
    $probe2 += "  main.js 升级相关命中: $(@($hit).Count) 行"
  }
  $inst = Join-Path $f.Path 'install.ps1'
  if (Test-Path $inst) { $probe2 += "  install.ps1: $([math]::Round((Get-Item $inst).Length/1KB,1)) KB, $(Get-Item $inst).LastWriteTime" }
}
W '09-feature-probe.txt' $probe2

# ---------- 8. 打包 ----------
$zip = "$out.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $out '*') -DestinationPath $zip -CompressionLevel Optimal

Write-Host ''
Write-Host '诊断完成（全程只读）。' -ForegroundColor Green
Write-Host "结果目录: $out"
Write-Host "请把这个 zip 发回给 PM: $zip" -ForegroundColor Yellow
Write-Host ''
Start-Process explorer.exe $desktop
