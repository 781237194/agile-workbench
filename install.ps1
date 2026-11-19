<#
.SYNOPSIS
  PM工作台 Windows 一键安装器。

.DESCRIPTION
  面向从 GitHub 获取本项目的朋友：
    1. 检查 Git（可选）与系统 Node.js 20+。系统已有 20+ 就直接使用；
       没有就自动下载 Windows x64 便携 Node.js LTS 到 <安装目录>\.runtime\node，
       只给本安装器与 npm 使用，不写系统 PATH、不修改系统环境、不需要管理员权限；
       官方 nodejs.org 下载失败时自动改用 npmmirror 镜像；
    2. 当前目录就是仓库时直接复用；否则下载 GitHub main 分支 zip 到 D:\PM工作台
       （没有 D 盘则 %USERPROFILE%\PM工作台），解压后使用；
    3. 执行 npm install；
    4. 创建桌面快捷方式 PM工作台.lnk，指向 start.cmd，图标 assets\pm-workbench.ico；
    5. 可选 -Launch 立即启动。

  便携 Node 只在安装阶段使用；start.cmd 直接启动 Electron，运行时不需要 Node。
  下载的 zip 会校验非空、zip 文件头、官方 SHA-256 以及 node.exe / npm 能否运行。

  幂等：重复执行只补依赖，不覆盖 data\、项目\、团队\状态\ 等已有内容；
  目标目录已有非本项目文件时停止并提示，绝不删除。

  错误不会关闭窗口：安装器打印原因与日志路径；由 安装PM工作台.cmd 启动时，
  失败后窗口保持并等待回车。

.PARAMETER InstallDir
  安装目录。默认 D:\PM工作台；没有 D 盘时用 %USERPROFILE%\PM工作台。

.PARAMETER Launch
  安装完成后立即启动 PM工作台。

.PARAMETER NoShortcut
  不创建桌面快捷方式。

.PARAMETER ZipPath
  使用本地 zip，而不是联网下载。适合离线或 GitHub 下载慢时手动下载。

.PARAMETER ZipUrl
  自定义下载地址，默认 GitHub main 分支 zip。

.PARAMETER ShortcutDir
  快捷方式输出目录，默认当前用户桌面（自动化测试可改）。

.PARAMETER LogDir
  日志目录。默认：仓库内 <仓库>\_tmp\install-logs；全新下载时用
  %LOCALAPPDATA%\PMWorkbench\install-logs。

.PARAMETER NonInteractive
  不暂停、不等待输入，适合自动化。也可设环境变量 AWB_NO_PAUSE=1。

.PARAMETER Help
  显示帮助。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
  .\install.ps1 -InstallDir "E:\PM工作台" -Launch

.NOTES
  退出码：0 成功；1 安装失败；2 参数错误。
  本脚本不会执行 git push、npm publish，也不会删除已有项目或数据。
#>
[CmdletBinding()]
param(
    [Alias('Root')]
    [string]$InstallDir,
    [string]$ShortcutDir,
    [string]$ZipPath,
    [string]$ZipUrl = 'https://codeload.github.com/781237194/agile-workbench/zip/refs/heads/main',
    [string]$LogDir,
    [switch]$Launch,
    [switch]$NoShortcut,
    [switch]$NonInteractive,
    [switch]$Help,
    # ── e610 在线升级（安装器侧，T-20261119-021320-2b3a）──────────────────────────
    [switch]$Upgrade,
    [string]$UpgradeFeed,
    [string]$UpgradeVersion,
    [string]$UpgradeSha256,
    [string]$UpgradeUrl,
    [string]$UpgradeDataDir,
    [switch]$UpgradeDryRun,
    [switch]$UpgradeForce,
    [string]$UpgradeReason,
    [string]$UpgradeRollback,
    # ── 248a GitHub 连接修复（内嵌 GitHubFix；T-20261119-102117-248a）────────────────
    [switch]$NoGitHubFix,
    [string]$GitHubFixHostsPath,
    [switch]$GitHubFixRestore,
    # ── R-2de7 一键重置 / 彻底卸载（T-20261119-212641-33a8）──────────────────────
    [switch]$Reset,
    [switch]$Uninstall,
    [switch]$Purge,
    [switch]$KeepData,
    [switch]$KeepBackups,
    [switch]$DryRun,
    [switch]$Yes,
    [string]$Confirm,
    [string]$BackupTo,
    [switch]$BackupProjects,
    [switch]$NoBackup,
    [switch]$NoLaunch,
    [switch]$Json,
    [switch]$Sandbox,
    [switch]$KillOwn,
    [switch]$Force,
    [string]$DshHome,
    [string]$LocalAppDataDir,
    [string]$TempDir,
    # 夹具专用隐藏开关：apply / restore / download（只跑对应动作并输出 JSON）
    [string]$GitHubFixTest,
    # 提权子进程内部入口（父进程 Start-Process -Verb RunAs 调用，不对外）
    [switch]$GitHubFixApplyElevated,
    [string]$GitHubFixElevatedResult,
    # 夹具专用：electron 自愈 / Move 重试自检（只跑对应函数并输出 JSON）
    [string]$TestElectronHeal,
    [string]$TestElectronCacheDir,
    [string]$TestMoveRetrySrc,
    [string]$TestMoveRetryDst,
    # B-d83d2：升级应用/部署校验/回滚的夹具入口（只读沙盘目录，输出 UPGRADE_APPLY_JSON）
    [string]$TestUpgradeApply
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# e610：被壳层/夹具以子进程方式调用时，中文输出按 UTF-8 走管道（否则父进程按默认代码页解码会乱码）。
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { /* 控制台不支持时保持默认，不影响安装 */ }

$script:ExitCode = 0
$script:LogFile = $null
$script:LogDirectory = $null
$script:RepoRoot = $null
$script:TargetPath = $null
$script:ShortcutPath = $null
$script:CreatedTarget = $false
$script:RepoReady = $false
$script:InstallMode = ''
$script:TotalSteps = 7
$script:NodeRuntime = $null
$script:IsFileInvocation = -not [string]::IsNullOrEmpty($PSCommandPath)
$script:KeepNodeZip = $false
# e379 返工：安装期告警收集（AC6 MCP 等不阻断项），最后写 data/install-result.json 并给界面读。
$script:Warnings = @()
$script:MCP = $null
$script:Stage = '初始化'
$script:DefaultRepoZipUrl = 'https://github.com/781237194/agile-workbench/archive/refs/heads/main.zip'

# e379：从「右键运行/双击」进来时执行策略可能是 Restricted —— 先给出可直接复制的命令，
# 避免用户只看到红字不知道怎么办。
try {
    $policy = (Get-ExecutionPolicy -Scope Process) -as [string]
    if ($policy -eq 'Restricted' -or $policy -eq 'AllSigned') {
        Write-Host ''
        Write-Host '当前 PowerShell 执行策略不允许直接运行脚本，请改用这一行命令：' -ForegroundColor Yellow
        Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1' -ForegroundColor Yellow
        Write-Host ''
    }
} catch { /* 执行策略读不到不影响安装主流程 */ }

$script:HelpText = @'
PM工作台 Windows 一键安装器

用法：
  双击 安装PM工作台.cmd
  或： powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 [参数]

参数：
  -InstallDir <目录>   安装到指定目录（默认 D:\PM工作台；没有 D 盘则 %USERPROFILE%\PM工作台）
  -Launch              安装完成后立即启动
  -NoShortcut          不创建桌面快捷方式
  -ZipPath <zip>       使用本地 zip，不联网下载
  -ZipUrl <url>        自定义下载地址（默认 GitHub main 分支 zip）
  -NoGitHubFix          不自动修复 GitHub 连接（默认自动探测并在不可达时修 hosts）
  -GitHubFixHostsPath   指定 hosts 副本（测试用；绝不写真实 hosts）
  -GitHubFixRestore     按标记段恢复 hosts（清掉 GitHub Fix 段落）
  -ShortcutDir <目录>  快捷方式输出目录（默认当前用户桌面）
  -LogDir <目录>       日志目录
  -NonInteractive      不暂停，适合自动化（也可设 AWB_NO_PAUSE=1）
  -Help                显示本帮助

Node.js 不需要预装：优先使用系统 Node.js 20+；没有时自动下载 Windows x64
便携版到 <安装目录>\.runtime\node，不写系统 PATH，也不需要管理员权限。

退出码：0 成功；1 安装失败；2 参数错误。

示例：
  .\install.ps1
  .\install.ps1 -InstallDir "E:\PM工作台" -Launch
  .\install.ps1 -ZipPath "C:\Download\agile-workbench-main.zip"
'@

function Write-InstallerLog {
    param(
        [ValidateSet('INFO', 'OK', 'WARN', 'FAIL', 'RUN')]
        [string]$Level,
        [string]$Message
    )
    $stamp = Get-Date -Format 'HH:mm:ss'
    $line = "[$stamp] $Level  $Message"
    switch ($Level) {
        'OK' { Write-Host $line -ForegroundColor Green }
        'WARN' { Write-Host $line -ForegroundColor Yellow }
        'FAIL' { Write-Host $line -ForegroundColor Red }
        'RUN' { Write-Host $line -ForegroundColor Cyan }
        default { Write-Host $line }
    }
    if ($script:LogFile) {
        try {
            Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8
        } catch {
            # 日志写不进去不能影响安装本身。
        }
    }
}

function Write-Step {
    param([int]$Number, [string]$Title)
    Write-Host ''
    Write-Host ("[{0}/{1}] {2}" -f $Number, $script:TotalSteps, $Title) -ForegroundColor Cyan
    Write-InstallerLog 'INFO' ("步骤 {0}/{1}：{2}" -f $Number, $script:TotalSteps, $Title)
    # e379 返工：记住当前阶段，失败时 data/install-result.json 要写「失败阶段」（AC4③）。
    $script:Stage = $Title
}

function Write-InstallerNote {
    param([string]$Text = '')
    Write-Host $Text
    if ($script:LogFile) {
        try {
            Add-Content -LiteralPath $script:LogFile -Value $Text -Encoding UTF8
        } catch {
            # 日志失败不阻断安装。
        }
    }
}

function Get-ExecutablePath {
    param([string]$Name)
    $command = Get-Command -Name $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { return $null }
    if ($command.Path) { return $command.Path }
    if ($command.Source) { return $command.Source }
    return $null
}

function Invoke-ToolVersion {
    param(
        [Parameter(Mandatory = $true)][string]$ExePath,
        [string[]]$Arguments = @()
    )
    $previousErrorAction = $ErrorActionPreference
    try {
        # 原生程序往 stderr 写警告是正常的（git / npm 都会），Stop 模式会把
        # NativeCommandError 当成终止错误，必须临时降为 Continue。
        $ErrorActionPreference = 'Continue'
        $output = & $ExePath @Arguments 2>&1
        $code = $LASTEXITCODE
        if ($code -ne 0) { return $null }
        foreach ($item in @($output)) {
            $text = ([string]$item).Trim()
            if ($text) { return $text }
        }
        return $null
    } catch {
        return $null
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
}

function Get-MajorVersion {
    param([string]$Version)
    $match = [regex]::Match([string]$Version, '(\d+)\.')
    if ($match.Success) { return [int]$match.Groups[1].Value }
    return -1
}

function Test-RepoRoot {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
    } catch {
        return $false
    }
    $packageJson = Join-Path $Path 'package.json'
    $startCmd = Join-Path $Path 'start.cmd'
    $mainJs = Join-Path $Path 'src\main.js'
    if (-not (Test-Path -LiteralPath $packageJson)) { return $false }
    if (-not (Test-Path -LiteralPath $startCmd)) { return $false }
    if (-not (Test-Path -LiteralPath $mainJs)) { return $false }
    try {
        $json = Get-Content -LiteralPath $packageJson -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $false
    }
    if ($json.name -eq 'pm-workbench') { return $true }
    if ($json.scripts -and $json.scripts.start -and ([string]$json.scripts.start -match 'run-electron\.cjs')) { return $true }
    return $false
}

function Test-DirectoryWritable {
    param([string]$Directory)
    $probe = Join-Path $Directory ('.pm-workbench-write-test-' + [Guid]::NewGuid().ToString('N'))
    try {
        [System.IO.File]::WriteAllText($probe, 'ok')
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return $true
    } catch {
        return $false
    }
}

function Start-InstallerLog {
    param([string]$Directory)
    if ([string]::IsNullOrWhiteSpace($Directory)) { return }
    try {
        New-Item -ItemType Directory -Force -Path $Directory -ErrorAction Stop | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $file = Join-Path $Directory ("install-$stamp.log")
        $suffix = 1
        while (Test-Path -LiteralPath $file) {
            $file = Join-Path $Directory ("install-$stamp-$suffix.log")
            $suffix += 1
        }
        $utf8WithBom = New-Object System.Text.UTF8Encoding($true)
        [System.IO.File]::WriteAllText($file, '', $utf8WithBom)
        $script:LogFile = $file
        $script:LogDirectory = $Directory
    } catch {
        $script:LogFile = $null
        Write-Host "[提示] 无法创建日志目录：$Directory" -ForegroundColor Yellow
        Write-Host "       $($_.Exception.Message)" -ForegroundColor DarkYellow
    }
}

function Show-NodeAutoInstallHelp {
    param([string]$Detail)
    Write-InstallerNote ''
    if ($Detail) {
        Write-InstallerNote "  [Node.js 自动安装失败] $Detail"
    }
    Write-InstallerNote '  安装器优先使用系统 Node.js 20+；没有时自动下载 Windows x64 便携版。'
    Write-InstallerNote '  也可以手动安装 Node.js LTS（20 或更高，自带 npm）后重跑：'
    Write-InstallerNote '    https://nodejs.org/zh-cn/download'
    Write-InstallerNote '  国内镜像：'
    Write-InstallerNote '    https://npmmirror.com/mirrors/node/'
    Write-InstallerNote '  手动安装不会覆盖已有项目和数据；下次运行会优先使用系统 Node。'
}

function Show-GitOptionalHelp {
    Write-InstallerNote ''
    Write-InstallerNote '  [提示] 没有检测到 Git（可选，不影响本次安装）'
    Write-InstallerNote '  一键安装使用 GitHub 的 zip 包，不需要 Git；'
    Write-InstallerNote '  只有之后想用 git clone / git pull 更新时才需要。'
    Write-InstallerNote '  下载地址：https://git-scm.com/download/win'
    Write-InstallerNote '  继续安装。'
}

function Test-NodeRuntime {
    param(
        [Parameter(Mandatory = $true)][string]$NodeExe,
        [string[]]$NpmCandidates = @()
    )
    $result = [pscustomobject]@{
        Ok          = $false
        NodeExe     = $NodeExe
        NpmExe      = $null
        NodeVersion = $null
        NpmVersion  = $null
        Reason      = ''
    }
    if ([string]::IsNullOrWhiteSpace($NodeExe) -or -not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
        $result.Reason = '没有找到 node.exe'
        return $result
    }
    $nodeVersion = Invoke-ToolVersion -ExePath $NodeExe -Arguments @('--version')
    if (-not $nodeVersion) {
        $result.Reason = "node 无法运行：$NodeExe"
        return $result
    }
    if ((Get-MajorVersion $nodeVersion) -lt 20) {
        $result.Reason = "版本过低（$nodeVersion，要求 20 或更高）"
        return $result
    }

    $nodeDir = Split-Path -Parent $NodeExe
    $candidates = @()
    if ($NpmCandidates) { $candidates += $NpmCandidates }
    $candidates += (Join-Path $nodeDir 'npm.cmd')
    $candidates += (Join-Path $nodeDir 'npm')
    $pathNpm = Get-ExecutablePath 'npm.cmd'
    if (-not $pathNpm) { $pathNpm = Get-ExecutablePath 'npm' }
    if ($pathNpm) { $candidates += $pathNpm }

    $seen = @{}
    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $key = $candidate.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $npmVersion = Invoke-ToolVersion -ExePath $candidate -Arguments @('--version')
        if (-not $npmVersion) { continue }
        $result.Ok = $true
        $result.NpmExe = $candidate
        $result.NodeVersion = $nodeVersion
        $result.NpmVersion = $npmVersion
        return $result
    }
    $result.Reason = '缺少可运行的 npm'
    return $result
}

function Get-SystemNodeRuntime {
    $candidates = New-Object System.Collections.Generic.List[string]
    $nodeCommand = Get-Command -Name 'node' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($nodeCommand) {
        if ($nodeCommand.Path) { $candidates.Add([string]$nodeCommand.Path) }
        elseif ($nodeCommand.Source) { $candidates.Add([string]$nodeCommand.Source) }
    }
    $roots = @()
    if ($env:ProgramFiles) { $roots += $env:ProgramFiles }
    if (${env:ProgramFiles(x86)}) { $roots += ${env:ProgramFiles(x86)} }
    if ($env:LOCALAPPDATA) { $roots += (Join-Path $env:LOCALAPPDATA 'Programs') }
    foreach ($root in $roots) {
        if ($root) { $candidates.Add((Join-Path $root 'nodejs\node.exe')) }
    }

    $reasons = @()
    $seen = @{}
    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        if ($candidate -like '*\WindowsApps\*') { continue }
        $fullPath = $null
        try {
            $fullPath = [System.IO.Path]::GetFullPath($candidate)
        } catch {
            continue
        }
        $key = $fullPath.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { continue }
        $runtime = Test-NodeRuntime -NodeExe $fullPath
        if ($runtime.Ok) { return $runtime }
        $reasons += ("{0}（{1}）" -f $fullPath, $runtime.Reason)
    }

    $reason = '未检测到 node'
    if ($reasons.Count -gt 0) { $reason = ($reasons -join '；') }
    return [pscustomobject]@{
        Ok          = $false
        NodeExe     = $null
        NpmExe      = $null
        NodeVersion = $null
        NpmVersion  = $null
        Reason      = $reason
    }
}

function Get-NodeLtsRelease {
    $sources = @(
        [pscustomobject]@{
            Name     = 'nodejs.org 官方'
            IndexUrl = 'https://nodejs.org/dist/index.json'
            BaseUrl  = 'https://nodejs.org/dist'
        },
        [pscustomobject]@{
            Name     = 'npmmirror 镜像'
            IndexUrl = 'https://npmmirror.com/mirrors/node/index.json'
            BaseUrl  = 'https://npmmirror.com/mirrors/node'
        }
    )

    $errors = @()
    foreach ($source in $sources) {
        try {
            Write-InstallerLog 'RUN' "读取 Node.js LTS 版本列表：$($source.Name)"
            $response = Invoke-WebRequest -UseBasicParsing -Uri $source.IndexUrl -TimeoutSec 60 -Headers @{ 'User-Agent' = 'PMWorkbench-Installer/1.0' }
            $content = $response.Content
            if ($content -is [byte[]]) { $content = [System.Text.Encoding]::UTF8.GetString($content) }
            # PowerShell 5.1 的 ConvertFrom-Json 把根数组当成一个对象输出；
            # 这里直接赋值，后面的管道会正常逐条枚举。
            $entries = ConvertFrom-Json -InputObject $content
            $ltsEntries = @($entries | Where-Object {
                $_.lts -and
                ([string]$_.version -match '^v\d+\.\d+\.\d+$') -and
                ($_.files -contains 'win-x64-zip')
            })
            if ($ltsEntries.Count -eq 0) {
                throw '版本列表里没有带 win-x64-zip 的 LTS 版本'
            }
            $best = $ltsEntries |
                Sort-Object -Property @{ Expression = { [version](([string]$_.version).Substring(1)) } } -Descending |
                Select-Object -First 1
            $release = [pscustomobject]@{
                Version = [string]$best.version
                BaseUrl = [string]$source.BaseUrl
                Source  = [string]$source.Name
                Npm     = [string]$best.npm
            }
            Write-InstallerLog 'OK' "Node.js LTS：$($release.Version)（来自 $($release.Source)）"
            return $release
        } catch {
            $message = $_.Exception.Message
            $errors += ("{0}：{1}" -f $source.Name, $message)
            Write-InstallerLog 'WARN' "读取失败（$($source.Name)）：$message"
        }
    }
    throw (($errors -join [Environment]::NewLine))
}

function Get-NodeChecksum {
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][string]$FileName
    )
    $url = "$BaseUrl/$Version/SHASUMS256.txt"
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 60 -Headers @{ 'User-Agent' = 'PMWorkbench-Installer/1.0' }
        $text = $response.Content
        if ($text -is [byte[]]) { $text = [System.Text.Encoding]::UTF8.GetString($text) }
        foreach ($line in ($text -split "`r?`n")) {
            $match = [regex]::Match($line, '^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$')
            if ($match.Success -and $match.Groups[2].Value -eq $FileName) {
                return $match.Groups[1].Value.ToLowerInvariant()
            }
        }
        Write-InstallerLog 'WARN' "校验文件里没有 $FileName，改为只校验 zip 可运行性"
        return $null
    } catch {
        Write-InstallerLog 'WARN' "无法获取 SHA-256 校验文件（$url）：$($_.Exception.Message)"
        return $null
    }
}

function Test-ZipFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $stream = $null
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        $first = $stream.ReadByte()
        $second = $stream.ReadByte()
        return ($first -eq 0x50 -and $second -eq 0x4B)
    } catch {
        return $false
    } finally {
        if ($stream) { $stream.Dispose() }
    }
}

function Save-NodeDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Destination,
        [long]$MinimumBytes = 1048576,
        [string]$ExpectedSha256,
        [int]$MaxAttempts = 2
    )
    if ($MaxAttempts -lt 1) { $MaxAttempts = 1 }
    try {
        $currentProtocol = [System.Net.ServicePointManager]::SecurityProtocol
        [System.Net.ServicePointManager]::SecurityProtocol = $currentProtocol -bor [System.Net.SecurityProtocolType]::Tls12
    } catch {
        # 老系统上 TLS 设置失败时仍尝试下载。
    }

    $lastError = $null
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            Write-InstallerLog 'RUN' "下载 Node.js 第 $attempt/$MaxAttempts 次：$Url"
            if (Test-Path -LiteralPath $Destination) {
                Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
            }
            Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination -TimeoutSec 600 -Headers @{ 'User-Agent' = 'PMWorkbench-Installer/1.0' }
            if (-not (Test-Path -LiteralPath $Destination -PathType Leaf)) {
                throw '下载命令结束了，但没有生成文件'
            }
            $length = (Get-Item -LiteralPath $Destination).Length
            if ($length -lt $MinimumBytes) {
                throw "下载文件太小（$length 字节），可能不是 Node.js 压缩包"
            }
            if (-not (Test-ZipFile -Path $Destination)) {
                throw '下载文件不是有效的 zip（文件头不是 PK），可能下载到了错误页面'
            }
            if ($ExpectedSha256) {
                $actual = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
                if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
                    throw "SHA-256 校验失败：期望 $($ExpectedSha256.ToLowerInvariant())，实际 $actual"
                }
                Write-InstallerLog 'OK' 'SHA-256 校验通过'
            } else {
                Write-InstallerLog 'WARN' '没有拿到官方校验值，已用 zip 文件头与可运行性校验兜底'
            }
            Write-InstallerLog 'OK' ("下载完成：{0:N1} MB" -f ($length / 1MB))
            return $Destination
        } catch {
            $lastError = $_
            if (Test-Path -LiteralPath $Destination) {
                Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
            }
            Write-InstallerLog 'WARN' "下载失败：$($_.Exception.Message)"
            if ($attempt -lt $MaxAttempts) { Start-Sleep -Seconds 2 }
        }
    }
    throw $lastError
}

function Find-NodeExtractRoot {
    param([Parameter(Mandatory = $true)][string]$Root)
    if (Test-Path -LiteralPath (Join-Path $Root 'node.exe') -PathType Leaf) { return $Root }
    foreach ($dir in @(Get-ChildItem -LiteralPath $Root -Directory -Force)) {
        if (Test-Path -LiteralPath (Join-Path $dir.FullName 'node.exe') -PathType Leaf) {
            return $dir.FullName
        }
    }
    return $null
}

function Install-PortableNode {
    param(
        [Parameter(Mandatory = $true)][string]$RuntimeRoot,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    if (Test-Path -LiteralPath $Destination) {
        throw "便携 Node 目录已存在，安装器不会覆盖：$Destination"
    }
    New-Item -ItemType Directory -Force -Path $RuntimeRoot -ErrorAction Stop | Out-Null
    if (-not (Test-DirectoryWritable -Directory $RuntimeRoot)) {
        throw "运行时目录不可写：$RuntimeRoot"
    }

    $freeSpaceBytes = $null
    try {
        $rootPath = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($RuntimeRoot))
        if ($rootPath) {
            $driveInfo = New-Object System.IO.DriveInfo($rootPath)
            $freeSpaceBytes = [long]$driveInfo.AvailableFreeSpace
        }
    } catch {
        $freeSpaceBytes = $null
    }
    if (($null -ne $freeSpaceBytes) -and ($freeSpaceBytes -lt 536870912)) {
        throw ("安装目录所在磁盘剩余空间不足：{0:N0} MB，至少需要约 512 MB。" -f ($freeSpaceBytes / 1MB))
    }

    try {
        $release = Get-NodeLtsRelease
    } catch {
        throw ((@(
            '无法获取 Node.js LTS 下载信息。'
            "  $($_.Exception.Message)"
            '请检查网络或代理后重试。'
        )) -join [Environment]::NewLine)
    }

    $fileName = "node-$($release.Version)-win-x64.zip"
    $mirrorBaseUrl = 'https://npmmirror.com/mirrors/node'
    $downloadCandidates = @(
        [pscustomobject]@{
            Label   = [string]$release.Source
            BaseUrl = [string]$release.BaseUrl
            Url     = "$($release.BaseUrl)/$($release.Version)/$fileName"
        }
    )
    if ($release.BaseUrl -ne $mirrorBaseUrl) {
        $downloadCandidates += [pscustomobject]@{
            Label   = 'npmmirror 镜像'
            BaseUrl = $mirrorBaseUrl
            Url     = "$mirrorBaseUrl/$($release.Version)/$fileName"
        }
    }
    Write-InstallerLog 'INFO' "将下载 $($release.Source) 的 Node.js $($release.Version)（Windows x64 便携版）"
    foreach ($candidate in $downloadCandidates) {
        Write-InstallerLog 'INFO' "下载地址：$($candidate.Url)"
    }

    $expectedSha256 = $null
    foreach ($candidate in $downloadCandidates) {
        $expectedSha256 = Get-NodeChecksum -BaseUrl $candidate.BaseUrl -Version $release.Version -FileName $fileName
        if ($expectedSha256) { break }
    }

    $downloadDir = Join-Path $RuntimeRoot 'downloads'
    New-Item -ItemType Directory -Force -Path $downloadDir -ErrorAction Stop | Out-Null
    # Expand-Archive（PowerShell 5.1）按扩展名识别压缩包，临时文件名必须以 .zip 结尾。
    $zipBase = [System.IO.Path]::GetFileNameWithoutExtension($fileName)
    $zipPath = Join-Path $downloadDir ($zipBase + '.' + [Guid]::NewGuid().ToString('N') + '.zip')
    $staging = Join-Path $RuntimeRoot ('node-staging-' + [Guid]::NewGuid().ToString('N'))
    $moved = $false

    try {
        $downloaded = $false
        $lastDownloadError = $null
        $attemptsPerUrl = 1
        if ($downloadCandidates.Count -eq 1) { $attemptsPerUrl = 2 }
        for ($index = 0; $index -lt $downloadCandidates.Count; $index++) {
            $candidate = $downloadCandidates[$index]
            try {
                Write-InstallerLog 'RUN' "下载源 $($index + 1)/$($downloadCandidates.Count)：$($candidate.Label)"
                $null = Save-NodeDownload -Url $candidate.Url -Destination $zipPath -MinimumBytes 1048576 -ExpectedSha256 $expectedSha256 -MaxAttempts $attemptsPerUrl
                $downloaded = $true
                break
            } catch {
                $lastDownloadError = $_
                if ($index -lt ($downloadCandidates.Count - 1)) {
                    Write-InstallerLog 'WARN' "该下载源失败，自动换下一个源：$($_.Exception.Message)"
                }
            }
        }
        if (-not $downloaded) { throw $lastDownloadError }

        Write-InstallerLog 'RUN' '解压便携 Node.js（首次会多花一点时间）'
        New-Item -ItemType Directory -Force -Path $staging -ErrorAction Stop | Out-Null
        try {
            Expand-Archive -LiteralPath $zipPath -DestinationPath $staging -Force -ErrorAction Stop
        } catch {
            throw "解压 Node.js 压缩包失败：$($_.Exception.Message)"
        }

        $source = Find-NodeExtractRoot -Root $staging
        if (-not $source) {
            throw '解压后没有找到 node.exe，压缩包可能不完整。'
        }
        $check = Test-NodeRuntime -NodeExe (Join-Path $source 'node.exe')
        if (-not $check.Ok) {
            throw "解压出的 Node.js 不可用：$($check.Reason)"
        }
        if ([string]$check.NodeVersion -ne [string]$release.Version) {
            throw "Node.js 版本不符：期望 $($release.Version)，实际 $($check.NodeVersion)"
        }

        if (Test-Path -LiteralPath $Destination) {
            throw "便携 Node 目录在安装过程中被创建，停止覆盖：$Destination"
        }
        # P2-7（B-20261119-123400-c437）：Move/解压失败按「占用 / 权限」分类，退避重试 3 次，仍失败复制兜底；
        # 失败时把目录状态写进 install-result.json，便于事后判断。
        $move = Move-DirectoryWithRetry -Source $source -Destination $Destination -Attempts 3
        if (-not $move.ok) {
            $script:KeepNodeZip = $true
            $script:NodeDirState = [pscustomobject]@{
                destination = $Destination
                exists      = (Test-Path -LiteralPath $Destination)
                fileCount   = (try { @(Get-ChildItem -LiteralPath $Destination -Recurse -File -ErrorAction SilentlyContinue).Count } catch { 0 })
                nodeExe     = (Test-Path -LiteralPath (Join-Path $Destination 'node.exe'))
                errorClass  = [string]$move.errorClass
                message     = [string]$move.message
            }
            throw ("便携 Node.js 落盘失败（{0}：{1}）。下载包已保留，可重跑安装器：{2}" -f $move.errorClass, $move.message, $zipPath)
        }
        $moved = $true
        if ($move.mode -eq 'copy') { Write-InstallerLog 'WARN' 'Directory.Move 不可用，已改用复制方式落到最终目录' }

        $final = Test-NodeRuntime -NodeExe (Join-Path $Destination 'node.exe')
        if (-not $final.Ok) {
            throw "便携 Node.js 移动后无法运行：$($final.Reason)"
        }
        Write-InstallerLog 'OK' "便携 Node.js 已就位：$Destination（$($final.NodeVersion)，npm $($final.NpmVersion)）"
        return $final
    } catch {
        if ($moved -and (Test-Path -LiteralPath $Destination)) {
            try {
                Remove-Item -LiteralPath $Destination -Recurse -Force -ErrorAction Stop
                Write-InstallerLog 'WARN' "已清理刚解压但不完整的便携 Node：$Destination"
            } catch {
                Write-InstallerLog 'WARN' "未能清理不完整的便携 Node，请手动删除：$Destination"
            }
        }
        throw
    } finally {
        if (Test-Path -LiteralPath $staging) {
            Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        }
        # e379：失败时保留下载包（供重试），成功才清理。
        if ((Test-Path -LiteralPath $zipPath) -and -not $script:KeepNodeZip) {
            Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $downloadDir) {
            $left = @(Get-ChildItem -LiteralPath $downloadDir -Force -ErrorAction SilentlyContinue)
            if ($left.Count -eq 0) {
                Remove-Item -LiteralPath $downloadDir -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

function Initialize-NodeRuntime {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        $SystemNode
    )
    if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
        throw '内部错误：仓库目录为空，无法准备 Node.js。'
    }

    if ($SystemNode -and $SystemNode.Ok) {
        Write-InstallerLog 'OK' "使用系统 Node.js $($SystemNode.NodeVersion)（npm $($SystemNode.NpmVersion)），不下载便携版"
        return [pscustomobject]@{
            Ok          = $true
            Source      = 'system'
            Root        = (Split-Path -Parent $SystemNode.NodeExe)
            NodeExe     = $SystemNode.NodeExe
            NpmExe      = $SystemNode.NpmExe
            NodeVersion = $SystemNode.NodeVersion
            NpmVersion  = $SystemNode.NpmVersion
        }
    }

    $runtimeRoot = Join-Path $RepoRoot '.runtime'
    $portableRoot = Join-Path $runtimeRoot 'node'
    if (Test-Path -LiteralPath $portableRoot) {
        $existing = Test-NodeRuntime -NodeExe (Join-Path $portableRoot 'node.exe')
        if ($existing.Ok) {
            Write-InstallerLog 'OK' "使用已有的便携 Node.js $($existing.NodeVersion)（$portableRoot），不重复下载"
            return [pscustomobject]@{
                Ok          = $true
                Source      = 'portable-existing'
                Root        = $portableRoot
                NodeExe     = $existing.NodeExe
                NpmExe      = $existing.NpmExe
                NodeVersion = $existing.NodeVersion
                NpmVersion  = $existing.NpmVersion
            }
        }
        throw ((@(
            "已有便携 Node 目录不可用，安装器不会覆盖它：$portableRoot"
            "  原因：$($existing.Reason)"
            '如需重装，请先手动把该目录移走（例如改名为 node.broken），再重跑安装器。'
        )) -join [Environment]::NewLine)
    }

    try {
        $portable = Install-PortableNode -RuntimeRoot $runtimeRoot -Destination $portableRoot
    } catch {
        $detail = $_.Exception.Message
        Show-NodeAutoInstallHelp -Detail $detail
        throw ((@(
            '自动准备 Node.js 失败（没有修改系统环境，也没有覆盖已有 Node）。'
            "  $detail"
            '可以手动安装 Node.js 20+ 后重跑，安装器会优先使用系统 Node；'
            '或检查网络 / 代理后重跑。'
        )) -join [Environment]::NewLine)
    }

    return [pscustomobject]@{
        Ok          = $true
        Source      = 'portable'
        Root        = $portableRoot
        NodeExe     = $portable.NodeExe
        NpmExe      = $portable.NpmExe
        NodeVersion = $portable.NodeVersion
        NpmVersion  = $portable.NpmVersion
    }
}

function Test-Prerequisites {
    $tools = @{
        SystemNode  = $null
        NodeExe     = $null
        NpmExe      = $null
        NodeSource  = ''
        GitExe      = $null
        NodeVersion = $null
        NpmVersion  = $null
        GitVersion  = $null
    }

    Write-InstallerLog 'INFO' ("系统：{0}；PowerShell {1}" -f [Environment]::OSVersion.VersionString, $PSVersionTable.PSVersion)

    $systemNode = $null
    try {
        $systemNode = Get-SystemNodeRuntime
    } catch {
        $systemNode = [pscustomobject]@{
            Ok          = $false
            NodeExe     = $null
            NpmExe      = $null
            NodeVersion = $null
            NpmVersion  = $null
            Reason      = $_.Exception.Message
        }
    }
    if ($systemNode.Ok) {
        $tools.SystemNode = $systemNode
        Write-InstallerLog 'OK' "系统 Node.js $($systemNode.NodeVersion)（npm $($systemNode.NpmVersion)）：$($systemNode.NodeExe)"
    } else {
        Write-InstallerLog 'WARN' "没有可用的系统 Node.js 20+：$($systemNode.Reason)"
        Write-InstallerLog 'INFO' '安装时会自动下载 Windows x64 便携 Node.js LTS，不写系统 PATH。'
    }

    $gitExe = Get-ExecutablePath 'git'
    if ($gitExe) {
        $gitVersion = Invoke-ToolVersion -ExePath $gitExe -Arguments @('--version')
        if ($gitVersion) {
            $tools.GitExe = $gitExe
            $tools.GitVersion = $gitVersion
            Write-InstallerLog 'OK' ("Git {0}（可选）" -f ($gitVersion -replace '^git version\s+', ''))
        } else {
            Show-GitOptionalHelp
            Write-InstallerLog 'WARN' "Git 存在但无法运行：$gitExe"
        }
    } else {
        Show-GitOptionalHelp
        Write-InstallerLog 'WARN' '未检测到 Git（可选，zip 安装不需要）'
    }

    return $tools
}

function Save-Download {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    try {
        $currentProtocol = [System.Net.ServicePointManager]::SecurityProtocol
        [System.Net.ServicePointManager]::SecurityProtocol = $currentProtocol -bor [System.Net.SecurityProtocolType]::Tls12
    } catch {
        # 老系统上 TLS 设置失败时仍尝试下载，失败会给出清晰提示。
    }

    $lastError = $null
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        try {
            Write-InstallerLog 'RUN' "下载第 $attempt/2 次：$Url"
            # 夹具专用：不联网即模拟下载失败（配合 GitHub 域 URL 验证修复/恢复链路）
    if ($env:AWB_TEST_GITHUBFIX_FAIL_DOWNLOAD -eq '1') { throw 'injected download failure（测试注入）' }
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination -TimeoutSec 300 -Headers @{ 'User-Agent' = 'PMWorkbench-Installer/1.0' }
            $length = (Get-Item -LiteralPath $Destination).Length
            if ($length -lt 10240) {
                throw "下载文件太小（$length 字节），可能不是有效的 zip"
            }
            Write-InstallerLog 'OK' ("下载完成：{0:N1} MB" -f ($length / 1MB))
            return
        } catch {
            $lastError = $_
            Write-InstallerLog 'WARN' "下载失败：$($_.Exception.Message)"
            if ($attempt -lt 2) { Start-Sleep -Seconds 3 }
        }
    }
    throw $lastError
}

function Expand-RepoZip {
    param(
        [Parameter(Mandatory = $true)][string]$ZipFile,
        [Parameter(Mandatory = $true)][string]$Target
    )
    $temp = Join-Path ([System.IO.Path]::GetTempPath()) ('pm-workbench-extract-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $temp -ErrorAction Stop | Out-Null
    try {
        Write-InstallerLog 'INFO' "解压：$ZipFile"
        Expand-Archive -LiteralPath $ZipFile -DestinationPath $temp -Force

        $candidates = @()
        if (Test-Path -LiteralPath (Join-Path $temp 'package.json')) {
            $candidates += $temp
        } else {
            foreach ($dir in @(Get-ChildItem -LiteralPath $temp -Directory -Force)) {
                if (Test-Path -LiteralPath (Join-Path $dir.FullName 'package.json')) {
                    $candidates += $dir.FullName
                }
            }
        }
        if ($candidates.Count -eq 0) {
            throw '压缩包里没有 package.json，可能下载到了错误页面。'
        }
        if ($candidates.Count -gt 1) {
            throw ('压缩包里有多个项目根目录，无法判断：' + ($candidates -join '；'))
        }

        $source = $candidates[0]
        if (-not (Test-RepoRoot $source)) {
            throw '压缩包内容不是 PM工作台（缺少 start.cmd 或 src\main.js）。'
        }

        foreach ($item in @(Get-ChildItem -LiteralPath $source -Force)) {
            Copy-Item -LiteralPath $item.FullName -Destination $Target -Recurse -Force
        }
        Write-InstallerLog 'OK' '源码已解压到目标目录'
    } finally {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ── e379 返工④：依赖/Electron 阶段的分段进度（AC1①「每 ≤30s 至少一行进度」）────────────
function Get-ElectronProgressSnapshot {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    $cacheBytes = 0
    $distBytes = 0
    $packageCount = 0
    $cacheDir = Join-Path $env:LOCALAPPDATA 'electron\Cache'
    if (Test-Path -LiteralPath $cacheDir) {
        try {
            $sum = (Get-ChildItem -LiteralPath $cacheDir -File -Recurse -Force -ErrorAction SilentlyContinue |
                Measure-Object -Property Length -Sum).Sum
            if ($sum) { $cacheBytes = [double]$sum }
        } catch { }
    }
    $distDir = Join-Path $RepoRoot 'node_modules\electron\dist'
    if (Test-Path -LiteralPath $distDir) {
        try {
            $sum = (Get-ChildItem -LiteralPath $distDir -File -Recurse -Force -ErrorAction SilentlyContinue |
                Measure-Object -Property Length -Sum).Sum
            if ($sum) { $distBytes = [double]$sum }
        } catch { }
    }
    $modulesDir = Join-Path $RepoRoot 'node_modules'
    if (Test-Path -LiteralPath $modulesDir) {
        try {
            $packageCount = @(Get-ChildItem -LiteralPath $modulesDir -Directory -Force -ErrorAction SilentlyContinue).Count
        } catch { $packageCount = 0 }
    }
    return [pscustomobject]@{
        CacheMB  = [Math]::Round($cacheBytes / 1MB, 1)
        DistMB   = [Math]::Round($distBytes / 1MB, 1)
        Packages = $packageCount
    }
}

function Format-ProgressFacts {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    $snap = Get-ElectronProgressSnapshot -RepoRoot $RepoRoot
    $stage = '解析依赖'
    if ($snap.CacheMB -gt 0 -and $snap.DistMB -le 0) { $stage = '下载 Electron' }
    if ($snap.DistMB -gt 0) { $stage = '解压 Electron' }
    return ("阶段：{0}；electron 缓存 {1} MB｜dist {2} MB｜node_modules {3} 个包" -f $stage, $snap.CacheMB, $snap.DistMB, $snap.Packages)
}

# 增量读取子进程重定向文件（共享读写，可以在子进程还在写的时候读）。
function Read-InstallerNewLines {
    param([string]$Path, [ref]$Offset)
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    $lines = @()
    try {
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            if ($stream.Length -le $Offset.Value) { return @() }
            $stream.Position = [int64]$Offset.Value
            $remaining = [int64]($stream.Length - $Offset.Value)
            $take = [int]([Math]::Min([int64]1048576, $remaining))
            $buffer = New-Object byte[] $take
            $read = $stream.Read($buffer, 0, $take)
            $Offset.Value = [int64]$stream.Position
            $text = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
            if ($text.Length -gt 0) {
                $lines = @($text -split "`r?`n" | Where-Object { $_.Trim().Length -gt 0 })
            }
        } finally {
            $stream.Dispose()
        }
    } catch { return @() }
    return $lines
}

function Invoke-LoggedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        # >0 时进入「分段进度」模式：每 N 秒打印一行进度（含已下载字节/阶段名），避免整段静默 >30s。
        [int]$ProgressSeconds = 0,
        [string]$PhaseName = '依赖安装'
    )
    Write-InstallerLog 'RUN' ("{0} {1}" -f (Split-Path -Leaf $Exe), ($Arguments -join ' '))
    $exit = 1
    if ($ProgressSeconds -le 0) {
        $previousErrorAction = $ErrorActionPreference
        Push-Location -LiteralPath $WorkingDirectory
        try {
            # npm 会把 warning 写到 stderr；Stop 模式下 2>&1 会中止安装，这里必须 Continue。
            $ErrorActionPreference = 'Continue'
            & $Exe @Arguments 2>&1 | ForEach-Object {
                $text = [string]$_
                if ($null -ne $text) {
                    Write-Host "    $text"
                    if ($script:LogFile) {
                        try {
                            Add-Content -LiteralPath $script:LogFile -Value $text -Encoding UTF8
                        } catch {
                            # 日志失败不阻断安装。
                        }
                    }
                }
            }
            $exit = [int]$LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorAction
            Pop-Location
        }
        if ($exit -eq 0) {
            Write-InstallerLog 'OK' ("{0} 执行完成" -f (Split-Path -Leaf $Exe))
        } else {
            Write-InstallerLog 'FAIL' ("{0} 退出码 {1}" -f (Split-Path -Leaf $Exe), $exit)
        }
        return $exit
    }

    # ── 分段进度模式（e379 返工④）────────────────────────────────────────────
    $outFile = Join-Path ([System.IO.Path]::GetTempPath()) ('awb-install-' + [guid]::NewGuid().ToString('n') + '.out')
    $errFile = $outFile + '.err'
    $proc = $null
    $previousErrorAction = $ErrorActionPreference
    Push-Location -LiteralPath $WorkingDirectory
    try {
        $ErrorActionPreference = 'Continue'
        $argLine = ($Arguments | ForEach-Object {
            $arg = [string]$_
            if ($arg -match '[\s"]') { '"' + ($arg -replace '"', '\"') + '"' } else { $arg }
        }) -join ' '
        $proc = Start-Process -FilePath $Exe -ArgumentList $argLine -WorkingDirectory $WorkingDirectory `
            -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        $startedAt = Get-Date
        $lastBeat = $startedAt
        [int64]$posOut = 0
        [int64]$posErr = 0
        $startLine = "    [进度 0s] {0} 已启动；{1}" -f $PhaseName, (Format-ProgressFacts -RepoRoot $WorkingDirectory)
        Write-Host $startLine
        if ($script:LogFile) { try { Add-Content -LiteralPath $script:LogFile -Value $startLine -Encoding UTF8 } catch { } }
        while ($true) {
            Start-Sleep -Milliseconds 700
            foreach ($line in (Read-InstallerNewLines -Path $outFile -Offset ([ref]$posOut))) {
                Write-Host "    $line"
                if ($script:LogFile) { try { Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8 } catch { } }
            }
            foreach ($line in (Read-InstallerNewLines -Path $errFile -Offset ([ref]$posErr))) {
                Write-Host "    $line"
                if ($script:LogFile) { try { Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8 } catch { } }
            }
            $proc.Refresh()
            if ($proc.HasExited) { break }
            $now = Get-Date
            if (($now - $lastBeat).TotalSeconds -ge $ProgressSeconds) {
                $lastBeat = $now
                $elapsed = [int]($now - $startedAt).TotalSeconds
                $beat = "    [进度 {0}s] {1} 进行中；{2}" -f $elapsed, $PhaseName, (Format-ProgressFacts -RepoRoot $WorkingDirectory)
                Write-Host $beat
                if ($script:LogFile) { try { Add-Content -LiteralPath $script:LogFile -Value $beat -Encoding UTF8 } catch { } }
            }
        }
        $proc.WaitForExit()
        # 收尾再抽一次，避免最后几行还没读到就结束。
        foreach ($line in (Read-InstallerNewLines -Path $outFile -Offset ([ref]$posOut))) {
            Write-Host "    $line"
            if ($script:LogFile) { try { Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8 } catch { } }
        }
        foreach ($line in (Read-InstallerNewLines -Path $errFile -Offset ([ref]$posErr))) {
            Write-Host "    $line"
            if ($script:LogFile) { try { Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8 } catch { } }
        }
        $exit = [int]$proc.ExitCode
    } catch {
        Write-InstallerLog 'WARN' ("分段进度模式执行失败：{0}" -f $_.Exception.Message)
        $exit = 1
    } finally {
        $ErrorActionPreference = $previousErrorAction
        Pop-Location
        foreach ($tempFile in @($outFile, $errFile)) {
            try {
                if ($tempFile -and (Test-Path -LiteralPath $tempFile)) {
                    Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
                }
            } catch { }
        }
    }
    if ($exit -eq 0) {
        Write-InstallerLog 'OK' ("{0} 执行完成" -f (Split-Path -Leaf $Exe))
    } else {
        Write-InstallerLog 'FAIL' ("{0} 退出码 {1}" -f (Split-Path -Leaf $Exe), $exit)
    }
    return $exit
}

function Remove-IncompleteTarget {
    if (-not $script:CreatedTarget -or $script:RepoReady) { return }
    if (-not $script:TargetPath) { return }
    if (-not (Test-Path -LiteralPath $script:TargetPath)) { return }
    try {
        Remove-Item -LiteralPath $script:TargetPath -Recurse -Force -ErrorAction Stop
        Write-InstallerLog 'INFO' "已清理未完成的目录：$($script:TargetPath)"
    } catch {
        Write-InstallerLog 'WARN' "未能自动清理目录，可手动删除：$($script:TargetPath)"
    }
}

# ── e379 返工①：安装期告警 + 安装结果文件（AC6①「安装结果 warnings[]」/AC4③「摘要文件」）──
function Add-InstallerWarning {
    param(
        [Parameter(Mandatory = $true)][string]$Code,
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$LogPath = '',
        $Detail = $null
    )
    $entry = [pscustomobject]@{
        code    = $Code
        message = $Message
        at      = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        log     = $LogPath
        detail  = $Detail
    }
    $script:Warnings += $entry
    Write-InstallerLog 'WARN' ("[{0}] {1}" -f $Code, $Message)
    return $entry
}

function Write-InstallResult {
    param(
        [string]$RepoRoot,
        [bool]$Ok = $false,
        [string]$Stage = '',
        [string]$Next = ''
    )
    if (-not $RepoRoot) { return $null }
    $dataDir = Join-Path $RepoRoot 'data'
    try {
        New-Item -ItemType Directory -Force -Path $dataDir -ErrorAction Stop | Out-Null
    } catch {
        return $null
    }
    $target = Join-Path $dataDir 'install-result.json'
    # 合并既有 warnings（MCP 自检 CLI / 上一次安装写过的），不要互相覆盖。
    $existingWarnings = @()
    if (Test-Path -LiteralPath $target) {
        try {
            $rawText = [System.IO.File]::ReadAllText($target, [System.Text.Encoding]::UTF8)
            $parsed = $rawText | ConvertFrom-Json
            if ($parsed -and $parsed.warnings) { $existingWarnings = @($parsed.warnings) }
        } catch { $existingWarnings = @() }
    }
    $merged = New-Object System.Collections.ArrayList
    $seen = @{}
    foreach ($row in @($existingWarnings + $script:Warnings)) {
        if ($null -eq $row) { continue }
        $code = [string]$row.code
        if (-not $code) { continue }
        $at = [string]$row.at
        $key = $code + '@' + $at
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        [void]$merged.Add([pscustomobject]@{
            code    = $code
            message = [string]$row.message
            at      = $at
            log     = [string]$row.log
            detail  = $row.detail
        })
    }
    $payload = [pscustomobject]@{
        ok          = $Ok
        at          = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        stage       = $Stage
        next        = $Next
        repoRoot    = $RepoRoot
        logFile     = [string]$script:LogFile
        warnings    = @($merged)
        mcp         = $script:MCP
        githubFix   = $script:GitHubFix
        electron    = [pscustomobject]@{
            exe           = (Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe')
            pathTxt       = (Join-Path $RepoRoot 'node_modules\electron\path.txt')
            missingReason = [string]$(if ($script:ElectronState) { $script:ElectronState.missingReason } else { '' })
            healed        = [bool]$(if ($script:ElectronState) { $script:ElectronState.healed } else { $false })
            healReason    = [string]$(if ($script:ElectronState) { $script:ElectronState.healReason } else { '' })
            distFileCount = [int]$(if ($script:ElectronState) { $script:ElectronState.distFileCount } else { 0 })
            pathTxtValue  = [string]$(if ($script:ElectronState) { $script:ElectronState.pathTxt } else { '' })
            dirState      = (Get-ElectronDirState -RepoRoot $RepoRoot)
        }
        installerDefaults = [pscustomobject]@{
            workbenchHome      = [string]$script:TargetPath
            teamRoot           = [string](Join-Path $RepoRoot '团队')
            dshRestartRequired = $true
        }
        nodeRuntime = $script:NodeRuntime
        shortcut    = [string]$script:ShortcutPath
    }
    try {
        $json = $payload | ConvertTo-Json -Depth 8
        [System.IO.File]::WriteAllText($target, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
        return $target
    } catch {
        Write-InstallerLog 'WARN' ("写安装结果失败：{0}" -f $_.Exception.Message)
        return $null
    }
}

function Show-Summary {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [string]$ShortcutPath,
        $NodeRuntime
    )
    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Green
    Write-Host '  安装完成' -ForegroundColor Green
    Write-Host '============================================================' -ForegroundColor Green
    Write-Host "  项目目录：$RepoRoot"
    if ($ShortcutPath) {
        Write-Host "  桌面快捷方式：$ShortcutPath"
    } else {
        Write-Host '  桌面快捷方式：已跳过（-NoShortcut）'
    }
    if ($NodeRuntime) {
        if ($NodeRuntime.Source -eq 'system') {
            Write-Host "  Node.js：$($NodeRuntime.NodeVersion)（系统 Node，未下载）"
        } else {
            Write-Host "  Node.js：$($NodeRuntime.NodeVersion)（便携版 $($NodeRuntime.Root)，不写系统 PATH）"
        }
    }
    Write-Host '  启动方式：双击桌面「PM工作台」，或运行：'
    Write-Host "    $(Join-Path $RepoRoot 'start.cmd')"
    Write-Host '  运行时不需要 Node.js：start.cmd 直接启动 Electron。'
    Write-Host ''
    if ($script:MCP) {
        if ($script:MCP.ok) {
            Write-Host '  MCP 安全搜索：自检通过（initialize 成功）' -ForegroundColor DarkGray
        } else {
            Write-Host ("  MCP 安全搜索：自检失败（{0}）；不影响启动，详情见上面的日志" -f ([string]$script:MCP.reason)) -ForegroundColor Yellow
        }
    }
    if (@($script:Warnings).Count -gt 0) {
        Write-Host ''
        Write-Host ("  警告（不阻断，共 {0} 条）：" -f @($script:Warnings).Count) -ForegroundColor Yellow
        foreach ($w in $script:Warnings) {
            Write-Host ("    · [{0}] {1}" -f $w.code, $w.message) -ForegroundColor Yellow
            if ($w.log) { Write-Host ("      日志：{0}" -f $w.log) -ForegroundColor DarkGray }
        }
        Write-Host '    界面查看：更多菜单 → 关于 PM工作台 → 安装 / MCP 警告' -ForegroundColor DarkGray
    } else {
        Write-Host '  警告：无' -ForegroundColor DarkGray
    }
    Write-Host '  首次启动后：左下角配置 DSH 地址 → 新建或恢复项目。'
    Write-Host '  数据位置：<仓库>\data（重跑安装器不会覆盖项目与数据）'
    Write-Host '  安装结果文件：<仓库>\data\install-result.json（含 warnings[]，界面「关于」可看）'
    Write-InstallerLog 'OK' "安装完成：$RepoRoot"
}

# ── e610 在线升级（安装器侧）：真实下载 + sha256 校验 + 备份 + 失败回滚 + 重启提示 ──
# 字段与壳层 IPC（src/main.js app:upgrade-start）对齐：
#   入参：version/latest、sha256、url、force、reason、dryRun、source
#   落账：<data>/升级记录.jsonl 一行 {ts,from,to,sha256,steps{backup,download,apply,selfcheck},ok,
#         force,reason,dryRun,restartHint,source:'installer',...}
#   退出码：0 成功；1 升级失败（已回滚或已停在可回滚态）；2 参数/校验错误（零副作用）
function Get-RepoPackageInfo {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    $pkg = Join-Path $RepoRoot 'package.json'
    $info = [pscustomobject]@{ version = '0.0.0'; name = 'pm-workbench' }
    if (-not (Test-Path -LiteralPath $pkg)) { return $info }
    try {
        $text = [System.IO.File]::ReadAllText($pkg, [System.Text.Encoding]::UTF8)
        $json = $text | ConvertFrom-Json
        if ($json) {
            $info.version = [string]($json.version)
            $info.name = [string]($json.name)
        }
    } catch { }
    if (-not $info.version) { $info.version = '0.0.0' }
    return $info
}

function Compare-UpgradeVersion {
    param([string]$Left, [string]$Right)
    $split = {
        param($v)
        $clean = ([string]$v).Trim().TrimStart('v', 'V')
        $parts = $clean.Split('.')
        $out = @()
        foreach ($p in $parts) {
            $num = [regex]::Match($p, '^\d+')
            if ($num.Success) { $out += [int]$num.Value } else { $out += 0 }
        }
        while ($out.Count -lt 3) { $out += 0 }
        return $out
    }
    $a = & $split $Left
    $b = & $split $Right
    for ($i = 0; $i -lt 3; $i++) {
        $x = if ($i -lt $a.Count) { $a[$i] } else { 0 }
        $y = if ($i -lt $b.Count) { $b[$i] } else { 0 }
        if ($x -ne $y) { return ($x - $y) }
    }
    return 0
}

function Test-Sha256Hex {
    param([string]$Value)
    return [bool]($Value -and ($Value -match '^[0-9a-fA-F]{64}$'))
}

function Read-UpgradeFeed {
    param([Parameter(Mandatory = $true)][string]$Feed)
    if ($Feed -match '^https?://') {
        Write-Host "  读取版本源：$Feed"
        $resp = Invoke-WebRequest -Uri $Feed -UseBasicParsing -TimeoutSec 10
        $text = [string]$resp.Content
    } else {
        if (-not (Test-Path -LiteralPath $Feed)) { throw "版本源文件不存在：$Feed" }
        $resolved = (Resolve-Path -LiteralPath $Feed).Path
        Write-Host "  读取版本源：$resolved"
        $text = [System.IO.File]::ReadAllText($resolved, [System.Text.Encoding]::UTF8)
    }
    return ($text | ConvertFrom-Json)
}

function Get-UpgradeStamp {
    $now = Get-Date
    return $now.ToString('yyyyMMdd-HHmmss') + '-' + ([guid]::NewGuid().ToString('n').Substring(0, 6))
}

function Write-UpgradeRecord {
    param([string]$DataDir, $Row)
    if (-not $DataDir) { return $false }
    try {
        New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
        $file = Join-Path $DataDir '升级记录.jsonl'
        # 248a：把 GitHubFix 状态并入本次升级记录（一次升级一行，不另写文件）
        try {
            $hasFixProp = $false
            if ($Row -and $Row.PSObject -and $Row.PSObject.Properties) {
                $hasFixProp = @($Row.PSObject.Properties | Where-Object { $_.Name -eq 'githubFix' }).Count -gt 0
            }
            if (-not $hasFixProp -and $script:GitHubFix) {
                $Row | Add-Member -NotePropertyName githubFix -NotePropertyValue $script:GitHubFix -Force
            }
        } catch { }
        $json = ($Row | ConvertTo-Json -Depth 8 -Compress)
        $enc = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::AppendAllText($file, $json + [Environment]::NewLine, $enc)
        return $true
    } catch {
        Write-Host ("  [警告] 写升级记录失败：" + $_.Exception.Message)
        return $false
    }
}

function Invoke-UpgradeSelfCheck {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    $startCmd = Join-Path $RepoRoot 'start.cmd'
    if (-not (Test-Path -LiteralPath $startCmd)) { return $false }
    try {
        Write-Host '  自检：start.cmd --check'
        $output = & cmd.exe /c ('"' + $startCmd + '" --check') 2>&1
        $exitCode = [int]$LASTEXITCODE
        $text = ($output | Out-String)
        foreach ($line in @($output)) {
            if ([string]$line -and ([string]$line).Trim().Length -gt 0) { Write-Host ('    ' + [string]$line) }
        }
        # 只看 ASCII 锚点：`start.cmd --check` 会打印 [检查] APP_DIR=… / electron …；
        # 中文在 cmd → PowerShell 之间可能按控制台代码页解码成乱码，不能拿中文当判据。
        $hasAppDir = [bool]($text -match 'APP_DIR=')
        $hasElectron = [bool]($text -match '(?i)electron')
        $electronExe = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'
        $electronOk = $hasElectron -or (Test-Path -LiteralPath $electronExe)
        return [bool]($exitCode -eq 0 -and $hasAppDir -and $electronOk)
    } catch {
        Write-Host ("  自检执行失败：" + $_.Exception.Message)
        return $false
    }
}

# 用「先移动到备份、再复制新内容」的方式替换程序文件：备份 = 可回滚实体，且不复制整棵树。
function Invoke-UpgradeApplyTree {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$StagingRoot,
        [Parameter(Mandatory = $true)][string]$BackupDir
    )
    # P0 B-20261119-194157-2e6d：升级包必须带「团队/」里的代码与规则（工具/模板/角色/协议/skill +
    # 宪法/流程/项目铁律），否则一键升级后团队工具层仍是首装版、与 git pull 永久不等价。
    # 用户数据（团队/状态、团队/日志、团队/产出、团队/项目、团队/看板.*、项目/、data/）一律不进白名单。
    # 清单唯一来源：scripts/upgrade-package-manifest.cjs（夹具 scripts/test-2e6d-team-upgrade.cjs 逐项比对）。
    $relatives = @(
        'src', 'scripts', 'dsh-plugin', 'assets', 'docs',
        '团队/工具', '团队/模板', '团队/角色', '团队/协议', '团队/skill',
        'package.json', 'package-lock.json', 'install.ps1', 'start.cmd', 'launch.vbs',
        'README.md', 'CHANGELOG.md', 'NOTICE.md', 'LICENSE', '发版记录.md', '安装PM工作台.cmd',
        '卸载PM工作台.cmd', '彻底卸载PM工作台.cmd',
        '团队/团队宪法.md', '团队/流程.md', '团队/项目铁律.md'
    )
    # 双保险：即使以后有人把用户数据目录写进白名单，这里也直接跳过（永不覆盖）。
    $userDataPrefixes = @('团队/状态', '团队/日志', '团队/产出', '团队/项目', '团队/看板', '项目', 'data', 'node_modules', '_tmp')
    $isUserData = {
        param([string]$Rel)
        $p = ($Rel -replace '\\', '/').TrimStart('.', '/')
        foreach ($prefix in $userDataPrefixes) {
            if ($p -eq $prefix -or $p.StartsWith($prefix + '/')) { return $true }
        }
        return $false
    }
    $plan = @()
    foreach ($rel in $relatives) {
        if (& $isUserData $rel) { continue }
        $src = Join-Path $StagingRoot $rel
        if (-not (Test-Path -LiteralPath $src)) { continue }
        $dst = Join-Path $RepoRoot $rel
        $plan += [pscustomobject]@{ rel = $rel; existed = (Test-Path -LiteralPath $dst) }
    }
    # P0 B-20261120-013826-38ce：**必需规则文件**不允许「包里没有就静默跳过」——
    # 团队根三份（宪法/流程/项目铁律）与团队工具入口 team.mjs 是 boot 的硬依赖，缺一份装完就会 MISSING_DOC。
    $requiredRelatives = @('团队/团队宪法.md', '团队/流程.md', '团队/项目铁律.md', '团队/工具/team.mjs')
    $missingRequired = @()
    foreach ($req in $requiredRelatives) {
        if (-not (Test-Path -LiteralPath (Join-Path $StagingRoot $req))) { $missingRequired += $req }
    }
    if ($missingRequired.Count -gt 0) {
        throw ('升级包不完整：缺少必需规则文件 ' + ($missingRequired -join '、') + '（禁止应用；可跑 team.mjs init 兜底生成后再升级）')
    }
    if ($plan.Count -eq 0) { throw '升级包里没有可应用的程序文件（src/package.json 等缺失）' }
    # 1) 备份：把将被替换的条目移动到 _backup/upgrade-<ts>/
    foreach ($entry in $plan) {
        $dst = Join-Path $RepoRoot $entry.rel
        if (-not $entry.existed) { continue }
        $backupPath = Join-Path $BackupDir $entry.rel
        $parent = Split-Path -Parent $backupPath
        if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        Move-Item -LiteralPath $dst -Destination $backupPath -Force
    }
    $manifestFile = Join-Path $BackupDir 'manifest.json'
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($manifestFile, (($plan | ConvertTo-Json -Depth 4) + [Environment]::NewLine), $enc)
    # 夹具注入口：模拟「应用阶段失败」（备份与 manifest 已就绪，尚未复制新文件）。
    if ($env:AWB_UPGRADE_FAIL_APPLY -eq '1') {
        throw 'injected apply failure (AWB_UPGRADE_FAIL_APPLY=1)'
    }
    # 2) 应用：复制新内容
    foreach ($entry in $plan) {
        $src = Join-Path $StagingRoot $entry.rel
        $dst = Join-Path $RepoRoot $entry.rel
        if ((Get-Item -LiteralPath $src).PSIsContainer) {
            Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
        } else {
            Copy-Item -LiteralPath $src -Destination $dst -Force
        }
    }
    return [pscustomobject]@{ manifest = $plan; manifestFile = $manifestFile }
}

# B-d83d2（Owner 2026-11-19：升级不能只“下载成功”，必须确认新代码真的部署到位）：
# 应用后立即校验——①安装目录 package.json.version == 目标版本；②关键入口文件存在；
# ③升级包内 src/** 逐文件与安装目录哈希一致。任一不符即抛错，由上层 catch 回滚。
function Invoke-UpgradeVerifyInstall {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$StagingRoot,
        [string]$TargetVersion
    )
    $problems = @()
    $pkgFile = Join-Path $RepoRoot 'package.json'
    if (-not (Test-Path -LiteralPath $pkgFile)) { throw '部署校验失败：安装目录缺 package.json' }
    $installedVersion = ''
    try { $installedVersion = [string]((Get-Content -LiteralPath $pkgFile -Raw -Encoding UTF8) | ConvertFrom-Json).version } catch { $installedVersion = '' }
    if ($TargetVersion -and ($installedVersion -ne [string]$TargetVersion)) {
        $problems += ("版本号不符：安装目录 {0} ≠ 目标 {1}" -f $installedVersion, $TargetVersion)
    }
    # 关键入口：src\main.js 必须落盘；start.cmd 若升级包里有则必须落盘（不强制要求包里没有的东西，避免误伤合法发布包）。
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'src\main.js'))) { $problems += '缺少关键文件：src\main.js' }
    if ((Test-Path -LiteralPath (Join-Path $StagingRoot 'start.cmd')) -and -not (Test-Path -LiteralPath (Join-Path $RepoRoot 'start.cmd'))) {
        $problems += '缺少关键文件：start.cmd'
    }
    $checked = 0
    $stagingSrc = Join-Path $StagingRoot 'src'
    if (Test-Path -LiteralPath $stagingSrc) {
        $baseLen = (Join-Path $StagingRoot '').Length
        foreach ($f in @(Get-ChildItem -LiteralPath $stagingSrc -Recurse -File -ErrorAction SilentlyContinue)) {
            $rel = $f.FullName.Substring($baseLen).TrimStart('\', '/')
            $dst = Join-Path $RepoRoot $rel
            $checked += 1
            if (-not (Test-Path -LiteralPath $dst)) { $problems += ("未部署：{0}" -f $rel); continue }
            $h1 = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
            $h2 = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
            if ($h1 -ne $h2) { $problems += ("内容不一致：{0}" -f $rel) }
        }
    }
    # P0 B-20261119-194157-2e6d：团队/ 的代码与规则（工具/模板/角色/协议/skill + 宪法/流程/铁律）也要逐个校验落地，
    # 否则「下载成功、应用却漏了团队/」这类缺陷会静默通过。用户数据目录不在 staging 里，自然不会出现在校验集合。
    $stagingTeam = Join-Path $StagingRoot '团队'
    if (Test-Path -LiteralPath $stagingTeam) {
        $baseLen = (Join-Path $StagingRoot '').Length
        $teamChecked = 0
        $userDataPrefixes = @('团队/状态', '团队/日志', '团队/产出', '团队/项目', '团队/看板')
        foreach ($f in @(Get-ChildItem -LiteralPath $stagingTeam -Recurse -File -ErrorAction SilentlyContinue)) {
            $rel = $f.FullName.Substring($baseLen).TrimStart('\', '/') -replace '\\', '/'
            if ([bool]($userDataPrefixes | Where-Object { $rel -eq $_ -or $rel.StartsWith($_ + '/') })) { continue }
            $dst = Join-Path $RepoRoot ($rel -replace '/', '\')
            $checked += 1
            $teamChecked += 1
            if (-not (Test-Path -LiteralPath $dst)) { $problems += ("未部署：{0}" -f $rel); continue }
            $h1 = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
            $h2 = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
            if ($h1 -ne $h2) { $problems += ("内容不一致：{0}" -f $rel) }
            if ($problems.Count -ge 20) { break }
        }
        if ($teamChecked -eq 0) { $problems += '升级包含 团队/ 目录但没有任何团队文件被校验（包结构异常）' }
    }
    # P0 B-20261120-013826-38ce：**团队根三份 + 团队工具入口**必须显式校验（存在 + sha256 == 包内）。
    # 上面那条「团队/ 递归校验」覆盖不到「包里根本没有这个文件」的情况（staging 里没有就不会被遍历）。
    $requiredRelatives = @('团队/团队宪法.md', '团队/流程.md', '团队/项目铁律.md', '团队/工具/team.mjs')
    $missingRequired = @()
    foreach ($req in $requiredRelatives) {
        $rel = $req -replace '/', '\'
        $srcFile = Join-Path $StagingRoot $rel
        $dstFile = Join-Path $RepoRoot $rel
        if (-not (Test-Path -LiteralPath $srcFile)) { $missingRequired += ($req + '（升级包里没有）'); continue }
        if (-not (Test-Path -LiteralPath $dstFile)) { $missingRequired += ($req + '（安装目录里没有）'); continue }
        $hr1 = (Get-FileHash -LiteralPath $srcFile -Algorithm SHA256).Hash
        $hr2 = (Get-FileHash -LiteralPath $dstFile -Algorithm SHA256).Hash
        if ($hr1 -ne $hr2) { $missingRequired += ($req + '（内容与包内不一致）') }
    }
    if ($missingRequired.Count -gt 0) {
        throw ('部署校验失败：必需规则文件缺失/不一致 —— ' + ($missingRequired -join '；') + '；本次升级将回滚到升级前状态；若规则文件已被误删，可跑 node 团队\工具\team.mjs init --role pm 重建后再升级')
    }
    if ($problems.Count -gt 0) {
        throw ('部署校验失败：' + (($problems | Select-Object -First 5) -join '；'))
    }
    return [pscustomobject]@{ installedVersion = $installedVersion; checkedFiles = $checked }
}

function Restore-UpgradeBackup {
    param([Parameter(Mandatory = $true)][string]$RepoRoot, [Parameter(Mandatory = $true)][string]$BackupDir)
    $manifestFile = Join-Path $BackupDir 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestFile)) { throw "备份清单不存在：$manifestFile" }
    $enc = New-Object System.Text.UTF8Encoding($false)
    $text = [System.IO.File]::ReadAllText($manifestFile, [System.Text.Encoding]::UTF8)
    $parsed = $text | ConvertFrom-Json
    # PS 5.1 的 ConvertFrom-Json 对 JSON 数组会返回 Object[]：不能再套 @()，否则只会迭代到「一个数组元素」。
    $entries = @()
    if ($parsed -is [System.Array]) { $entries = $parsed } elseif ($null -ne $parsed) { $entries = @($parsed) }
    $restored = 0
    foreach ($entry in $entries) {
        $rel = [string]$entry.rel
        if (-not $rel) { continue }
        $dst = Join-Path $RepoRoot $rel
        if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Recurse -Force -ErrorAction SilentlyContinue }
        $src = Join-Path $BackupDir $rel
        if ($entry.existed -and (Test-Path -LiteralPath $src)) {
            $parent = Split-Path -Parent $dst
            if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
            Move-Item -LiteralPath $src -Destination $dst -Force
            $restored += 1
        }
    }
    return $restored
}

function Invoke-UpgradeMode {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [string]$DataDir,
        [string]$Feed,
        [string]$Version,
        [string]$Sha256,
        [string]$Url,
        [bool]$DryRun,
        [bool]$Force,
        [string]$Reason
    )
    $stamp = Get-UpgradeStamp
    $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $targetVersion = [string]$Version
    $targetSha = [string]$Sha256
    $targetUrl = [string]$Url
    $restartHint = '请重启后生效'
    $fromVersion = (Get-RepoPackageInfo -RepoRoot $RepoRoot).version
    $steps = @{ backup = $false; download = $false; apply = $false; selfcheck = $false }
    $baseRow = [ordered]@{
        ts          = $ts
        from        = $fromVersion
        to          = $targetVersion
        sha256      = $targetSha
        steps       = $steps
        ok          = $false
        force       = [bool]$Force
        reason      = [string]$Reason
        dryRun      = [bool]$DryRun
        source      = 'installer'
        restartHint = $restartHint
    }

    Write-Host ''
    Write-Host '============================================================' -ForegroundColor DarkCyan
    Write-Host '  PM工作台 · 在线升级（安装器侧）' -ForegroundColor Cyan
    Write-Host '============================================================' -ForegroundColor DarkCyan
    Write-Host "  安装目录：$RepoRoot"
    Write-Host "  当前版本：$fromVersion"
    if ($DataDir) { Write-Host "  数据目录：$DataDir" }

    # 1) 强制升级必须给原因（零副作用）
    if ($Force -and -not $Reason) {
        Write-Host ''
        Write-Host '  [升级被拒] UPGRADE_FORCE_REASON_REQUIRED：强制升级必须填写原因（-UpgradeReason）' -ForegroundColor Red
        return 2
    }

    # 2) 版本源：缺字段就从 feed 补
    if (-not $targetVersion -or -not $targetSha -or -not $targetUrl) {
        if ($Feed) {
            try {
                $feedJson = Read-UpgradeFeed -Feed $Feed
            } catch {
                Write-Host ('  [升级失败] UPGRADE_FEED_UNREACHABLE：' + $_.Exception.Message) -ForegroundColor Red
                return 2
            }
            if ($feedJson) {
                if (-not $targetVersion) { $targetVersion = [string]($feedJson.version); if (-not $targetVersion) { $targetVersion = [string]($feedJson.latest) }; if (-not $targetVersion) { $targetVersion = [string]($feedJson.tag) } }
                if (-not $targetSha) { $targetSha = [string]($feedJson.sha256); if (-not $targetSha) { $targetSha = [string]($feedJson.sha) } }
                if (-not $targetUrl) { $targetUrl = [string]($feedJson.url); if (-not $targetUrl) { $targetUrl = [string]($feedJson.download) } }
            }
        }
    }
    $baseRow.to = $targetVersion
    $baseRow.sha256 = $targetSha

    if (-not $targetVersion) {
        Write-Host '  [升级被拒] UPGRADE_VERSION_REQUIRED：缺少目标版本（-UpgradeVersion 或版本源里没有 version）' -ForegroundColor Red
        return 2
    }
    # 3) 缺 sha256 → 不下载、零副作用（需求 §6.1 / AC3①）
    if (-not (Test-Sha256Hex -Value $targetSha)) {
        Write-Host '  [升级被拒] UPGRADE_SHA_MISSING：源缺少校验值，暂不可升级' -ForegroundColor Red
        return 2
    }
    if (-not $targetUrl) {
        Write-Host '  [升级被拒] UPGRADE_URL_REQUIRED：缺少下载地址（-UpgradeUrl 或版本源里没有 url）' -ForegroundColor Red
        return 2
    }
    $targetSha = $targetSha.ToLower()
    $baseRow.sha256 = $targetSha

    $cmp = Compare-UpgradeVersion -Left $targetVersion -Right $fromVersion
    if ($cmp -le 0) {
        Write-Host ("  提示：目标版本 $targetVersion 不高于当前 $fromVersion（按强制升级流程继续）") -ForegroundColor Yellow
    }

    # 4) dry-run：只校验参数并落一条 dryRun 记录（供 tester mock，不下载/不改文件）
    if ($DryRun) {
        $steps.backup = $true
        $steps.download = $true
        $steps.apply = $true
        $steps.selfcheck = $true
        $baseRow.steps = $steps
        $baseRow.ok = $true
        $baseRow.dryRun = $true
        $baseRow.message = 'dry-run：只校验版本源与参数，不下载、不修改文件'
        [void](Write-UpgradeRecord -DataDir $DataDir -Row $baseRow)
        Write-Host ''
        Write-Host ("  [dry-run 通过] $fromVersion → $targetVersion；sha256=$targetSha") -ForegroundColor Green
        Write-Host "  未下载、未修改任何文件；已写升级记录（dryRun=true）"
        Write-Host "  重启提示：$restartHint"
        return 0
    }

    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'package.json'))) {
        Write-Host '  [升级失败] UPGRADE_NOT_INSTALLED：没有找到 package.json，请在安装目录运行' -ForegroundColor Red
        return 2
    }

    # 5) 备份目录（只备份将被替换的条目）
    $backupDir = Join-Path $RepoRoot (Join-Path '_backup' ("upgrade-$stamp"))
    try {
        New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    } catch {
        Write-Host ('  [升级失败] UPGRADE_BACKUP_FAILED：' + $_.Exception.Message) -ForegroundColor Red
        return 1
    }
    $baseRow.backupDir = $backupDir
    $steps.backup = $true
    $baseRow.steps = $steps
    Write-Host "  备份目录：$backupDir"

    # 6) 下载 + sha256 校验
    $zipDir = Join-Path $RepoRoot (Join-Path '_tmp' 'upgrade')
    $zipPath = Join-Path $zipDir ("upgrade-$targetVersion-$stamp.zip")
    try {
        New-Item -ItemType Directory -Force -Path $zipDir | Out-Null
        Write-Host "  下载：$targetUrl"
        $downloadStarted = Get-Date
        [void](Invoke-GitHubFixedDownload -Url $targetUrl -Destination $zipPath -Attempts 3 -Label '升级 zip' -MinBytes 1)
        $sizeMb = [Math]::Round(((Get-Item -LiteralPath $zipPath).Length / 1MB), 2)
        $secs = [int]((Get-Date) - $downloadStarted).TotalSeconds
        Write-Host ("  下载完成：{0} MB，{1}s → {2}" -f $sizeMb, $secs, $zipPath)
    } catch {
        $steps.download = $false
        $baseRow.steps = $steps
        $baseRow.code = 'UPGRADE_DOWNLOAD_FAILED'
        $baseRow.message = [string]$_.Exception.Message
        [void](Write-UpgradeRecord -DataDir $DataDir -Row $baseRow)
        Write-Host ('  [升级失败] UPGRADE_DOWNLOAD_FAILED：' + $_.Exception.Message) -ForegroundColor Red
        return 1
    }
    $actualSha = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLower()
    if ($actualSha -ne $targetSha) {
        $steps.download = $false
        $baseRow.steps = $steps
        $baseRow.code = 'UPGRADE_SHA_MISMATCH'
        $baseRow.message = "SHA_MISMATCH：期望 $targetSha，实际 $actualSha"
        $baseRow.rolledBack = $false
        [void](Write-UpgradeRecord -DataDir $DataDir -Row $baseRow)
        Write-Host ("  [升级中止] UPGRADE_SHA_MISMATCH：下载文件校验失败（版本不变，已保留 zip 供排查：$zipPath）") -ForegroundColor Red
        return 1
    }
    $steps.download = $true
    $baseRow.steps = $steps

    # 7) 应用（失败即回滚）
    $staging = Join-Path $zipDir ("staging-$stamp")
    $applied = $null
    try {
        Write-Host '  解压升级包…'
        Expand-Archive -LiteralPath $zipPath -DestinationPath $staging -Force
        $stagingRoot = $staging
        $children = @(Get-ChildItem -LiteralPath $staging)
        $dirs = @($children | Where-Object { $_.PSIsContainer })
        if ($dirs.Count -eq 1 -and (Test-Path -LiteralPath (Join-Path $dirs[0].FullName 'package.json'))) {
            $stagingRoot = $dirs[0].FullName
        }
        if (-not (Test-Path -LiteralPath (Join-Path $stagingRoot 'package.json'))) {
            throw '升级包里没有 package.json（不是 PM工作台 发布包）'
        }
        if (-not ((Test-Path -LiteralPath (Join-Path $stagingRoot 'src\main.js')) -or (Test-Path -LiteralPath (Join-Path $stagingRoot 'install.ps1')))) {
            throw '升级包里没有 src\main.js / install.ps1（不是完整的 PM工作台 发布包）'
        }
        $applied = Invoke-UpgradeApplyTree -RepoRoot $RepoRoot -StagingRoot $stagingRoot -BackupDir $backupDir
        # B-d83d2：应用后立刻校验「新代码真的部署到位」；不符即抛错 → 上面的 catch 自动回滚。
        $verify = Invoke-UpgradeVerifyInstall -RepoRoot $RepoRoot -StagingRoot $stagingRoot -TargetVersion $targetVersion
        $baseRow.installedVersion = $verify.installedVersion
        $baseRow.verifiedFiles = $verify.checkedFiles
        Write-Host ("  部署校验通过：版本 {0}，逐文件哈希比对 {1} 个" -f $verify.installedVersion, $verify.checkedFiles)
        $steps.apply = $true
        $baseRow.steps = $steps
        Write-Host ("  已应用：{0} 个条目（备份清单 {1}）" -f $applied.manifest.Count, $applied.manifestFile)
    } catch {
        $steps.apply = $false
        $baseRow.steps = $steps
        $rolledBack = $false
        try {
            if (Test-Path -LiteralPath (Join-Path $backupDir 'manifest.json')) {
                [void](Restore-UpgradeBackup -RepoRoot $RepoRoot -BackupDir $backupDir)
                $rolledBack = $true
            }
        } catch {
            Write-Host ('  [严重] 回滚失败：' + $_.Exception.Message) -ForegroundColor Red
        }
        $baseRow.code = 'UPGRADE_APPLY_FAILED'
        $baseRow.message = [string]$_.Exception.Message
        $baseRow.rolledBack = $rolledBack
        [void](Write-UpgradeRecord -DataDir $DataDir -Row $baseRow)
        if ($rolledBack) {
            Write-Host ('  [升级失败已回滚] UPGRADE_APPLY_FAILED：' + $_.Exception.Message) -ForegroundColor Red
        } else {
            Write-Host ('  [升级失败] UPGRADE_APPLY_FAILED（回滚未执行）：' + $_.Exception.Message) -ForegroundColor Red
        }
        return 1
    }

    # 8) 自检（start.cmd --check；失败不自动回滚，给一键回滚命令）
    $steps.selfcheck = Invoke-UpgradeSelfCheck -RepoRoot $RepoRoot
    $baseRow.steps = $steps
    if (-not $steps.selfcheck) {
        $baseRow.ok = $false
        $baseRow.code = 'UPGRADE_SELFCHECK_FAILED'
        $baseRow.rolledBack = $false
        $baseRow.message = '已升级但自检未通过（start.cmd --check）'
        [void](Write-UpgradeRecord -DataDir $DataDir -Row $baseRow)
        Write-Host '  [升级未完成] 已升级但自检未通过；可回滚：' -ForegroundColor Red
        Write-Host ("    powershell -NoProfile -ExecutionPolicy Bypass -File `"$RepoRoot\install.ps1`" -UpgradeRollback `"$backupDir`"") -ForegroundColor Yellow
        return 1
    }

    # 9) 落账
    $baseRow.ok = $true
    $baseRow.restartHint = $restartHint
    [void](Write-UpgradeRecord -DataDir $DataDir -Row $baseRow)
    $afterVersion = (Get-RepoPackageInfo -RepoRoot $RepoRoot).version
    Write-Host ''
    Write-Host ("  [升级成功] {0} → {1}（sha256 {2}）" -f $fromVersion, $afterVersion, $targetSha.Substring(0, 12)) -ForegroundColor Green
    Write-Host ("  备份：{0}" -f $backupDir)
    Write-Host ("  重启提示：{0}（先退出工作台再运行 start.cmd）" -f $restartHint)
    return 0
}

function Invoke-UpgradeRollbackMode {
    param([Parameter(Mandatory = $true)][string]$RepoRoot, [Parameter(Mandatory = $true)][string]$BackupDir, [string]$DataDir)
    Write-Host ''
    Write-Host '============================================================' -ForegroundColor DarkCyan
    Write-Host '  PM工作台 · 升级回滚' -ForegroundColor Cyan
    Write-Host '============================================================' -ForegroundColor DarkCyan
    Write-Host "  安装目录：$RepoRoot"
    Write-Host "  备份目录：$BackupDir"
    try {
        $restored = Restore-UpgradeBackup -RepoRoot $RepoRoot -BackupDir $BackupDir
    } catch {
        Write-Host ('  [回滚失败] ' + $_.Exception.Message) -ForegroundColor Red
        return 1
    }
    $row = [ordered]@{
        ts          = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        from        = ''
        to          = ''
        sha256      = ''
        steps       = @{ backup = $true; download = $true; apply = $true; selfcheck = $true }
        ok          = $true
        rolledBack  = $true
        source      = 'installer'
        backupDir   = $BackupDir
        restartHint = '请重启后生效'
        message     = "手动回滚完成：恢复 $restored 个条目"
    }
    [void](Write-UpgradeRecord -DataDir $DataDir -Row $row)
    Write-Host ("  [回滚完成] 已恢复 $restored 个条目；请重启后生效（先退出工作台再运行 start.cmd）") -ForegroundColor Green
    return 0
}

# ── 248a：内嵌 GitHub 连接修复（GitHubFix，T-20261119-102117-248a）────────────────
# 自包含：不依赖 D:\deepseek\GitHub连接工具\GitHubFix.ps1；能力按原工具逻辑并入本安装器。
$script:GitHubFix = $null
$script:GitHubFixState = [ordered]@{
    applied   = $false
    chosenIp  = ''
    restored  = $false
    hostsPath = ''
    attempts  = 0
    notes     = @()
    error     = ''
}
$script:GitHubFixMarkerStart = '# ==== GitHub Fix START ===='
$script:GitHubFixMarkerEnd = '# ==== GitHub Fix END ===='
$script:GitHubFixHostCandidates = @(
    '20.27.177.113', '20.205.243.166', '20.233.83.145', '20.200.245.247',
    '20.26.156.215', '20.175.192.147', '140.82.112.3', '140.82.113.3',
    '4.237.22.38'
)
$script:GitHubFixApiCandidates = @('20.205.243.168', '140.82.116.6', '140.82.112.6', '140.82.113.6')
$script:GitHubFixRawCandidates = @('185.199.111.133', '185.199.110.133', '185.199.109.133', '185.199.108.133')

function Get-GitHubFixHostsPath {
    if ($GitHubFixHostsPath) {
        try { return [System.IO.Path]::GetFullPath($GitHubFixHostsPath) } catch { return $GitHubFixHostsPath }
    }
    return (Join-Path $env:SystemRoot 'System32\drivers\etc\hosts')
}

function Test-GitHubFixIsAdmin {
    try {
        $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $p = New-Object System.Security.Principal.WindowsPrincipal($id)
        return $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

function Test-GitHubFixTcp443 {
    param([string]$Ip, [int]$TimeoutMs = 2500)
    $tcp = $null
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $ar = $tcp.BeginConnect($Ip, 443, $null, $null)
        if (-not $ar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $tcp.EndConnect($ar)
        return [bool]$tcp.Connected
    } catch { return $false }
    finally { if ($tcp) { try { $tcp.Close() } catch { } } }
}

function Test-GitHubFixTls {
    param([string]$Ip, [string]$Sni, [int]$TimeoutMs = 3000)
    $tcp = $null
    $ssl = $null
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $tcp.NoDelay = $true
        $ar = $tcp.BeginConnect($Ip, 443, $null, $null)
        if (-not $ar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $null }
        $tcp.EndConnect($ar)
        $cb = [System.Net.Security.RemoteCertificateValidationCallback] { param($a, $b, $c, $d) $true }
        $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, $cb)
        $ssl.ReadTimeout = $TimeoutMs
        $ssl.WriteTimeout = $TimeoutMs
        $ssl.AuthenticateAsClient($Sni, $null, [System.Security.Authentication.SslProtocols]::Tls12, $false)
        return $true
    } catch { return $null }
    finally {
        if ($ssl) { try { $ssl.Dispose() } catch { } }
        if ($tcp) { try { $tcp.Close() } catch { } }
    }
}

function Test-GitHubFixEndpoint {
    param([string]$Ip, [string]$Sni, [int]$TimeoutMs = 3000)
    # 夹具专用：不碰网络的两种注入（FAKE_IP=指定 IP 直接视为可达；FORCE_UNREACHABLE=一律不可达）
    if ($env:AWB_TEST_GITHUBFIX_FAKE_IP -and $Ip -eq $env:AWB_TEST_GITHUBFIX_FAKE_IP) { return $true }
    if ($env:AWB_TEST_GITHUBFIX_FORCE_UNREACHABLE -eq '1') { return $false }
    $tls = Test-GitHubFixTls -Ip $Ip -Sni $Sni -TimeoutMs $TimeoutMs
    if ($null -ne $tls) { return [bool]$tls }
    # 本机 TLS 不可用（受限环境/Schannel 无凭据）→ 退化为 TCP 443 连通性判断
    return (Test-GitHubFixTcp443 -Ip $Ip -TimeoutMs $TimeoutMs)
}

function Select-GitHubFixIp {
    param([string[]]$Candidates, [string]$Sni, [int]$MaxTry = 5)
    $tried = 0
    foreach ($ip in $Candidates) {
        if ($tried -ge $MaxTry) { break }
        $tried++
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        if (Test-GitHubFixEndpoint -Ip $ip -Sni $Sni) {
            $sw.Stop()
            return [pscustomobject]@{ Ip = $ip; Ms = [int]$sw.ElapsedMilliseconds }
        }
    }
    return $null
}

function Read-GitHubFixHostsText {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{ Text = ''; Bytes = $null } }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $text = ''
    if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
        $text = [System.Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
    } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF) {
        $text = [System.Text.Encoding]::BigEndianUnicode.GetString($bytes, 2, $bytes.Length - 2)
    } else {
        $skip = 0
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { $skip = 3 }
        $text = [System.Text.Encoding]::UTF8.GetString($bytes, $skip, $bytes.Length - $skip)
    }
    return [pscustomobject]@{ Text = $text; Bytes = $bytes }
}

function Write-GitHubFixHostsText {
    param([string]$Path, [string]$Text)
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

function Get-GitHubFixStrippedText {
    param([string]$Text)
    $lines = @($Text -split "`r?`n")
    $out = New-Object System.Collections.ArrayList
    $inside = $false
    foreach ($line in $lines) {
        $trim = $line.Trim()
        if ($trim -eq $script:GitHubFixMarkerStart) { $inside = $true; continue }
        if ($trim -eq $script:GitHubFixMarkerEnd) { $inside = $false; continue }
        if ($inside) { continue }
        [void]$out.Add($line)
    }
    return (@($out) -join "`r`n")
}

function Invoke-GitHubFixFlushDns {
    if ($env:AWB_TEST_GITHUBFIX_SKIP_FLUSH -eq '1') { return }
    try { & ipconfig.exe /flushdns | Out-Null } catch { }
}

function Invoke-GitHubFixRestore {
    param([string]$Path, [switch]$Quiet)
    $target = if ($Path) { $Path } else { Get-GitHubFixHostsPath }
    try {
        $read = Read-GitHubFixHostsText -Path $target
        $clean = Get-GitHubFixStrippedText -Text ([string]$read.Text)
        $before = [string]$read.Text
        if ($clean.TrimEnd() -ne $before.TrimEnd()) {
            Write-GitHubFixHostsText -Path $target -Text ($clean.TrimEnd() + "`r`n")
            $script:GitHubFixState.restored = $true
            if (-not $Quiet) { Write-Host "  已按标记段恢复 hosts：$target" -ForegroundColor Green }
        } else {
            $script:GitHubFixState.restored = $true
            if (-not $Quiet) { Write-Host "  hosts 无 GitHub Fix 标记段，无需恢复：$target" }
        }
        Invoke-GitHubFixFlushDns
        $script:GitHubFixState.hostsPath = $target
        return [pscustomobject]@{ ok = $true; restored = $true; hostsPath = $target }
    } catch {
        Write-Host ("  [GitHubFix] 恢复 hosts 失败：" + $_.Exception.Message) -ForegroundColor Red
        return [pscustomobject]@{ ok = $false; code = 'GITHUB_FIX_RESTORE_FAILED'; message = [string]$_.Exception.Message; hostsPath = $target }
    }
}

function Invoke-GitHubFixApply {
    param([string]$Path)
    $target = if ($Path) { $Path } else { Get-GitHubFixHostsPath }
    $isElevatedChild = ($env:AWB_GITHUBFIX_ELEVATED -eq '1')
    $isCustomHosts = -not [string]::IsNullOrWhiteSpace($GitHubFixHostsPath)
    if (-not (Test-GitHubFixIsAdmin) -and -not $isCustomHosts -and -not $isElevatedChild) {
        # 非管理员 + 真实 hosts：按需求尝试 RunAs 提权一次；失败/被拒 → 可读提示（不阻断安装）
        if ($env:AWB_TEST_GITHUBFIX_NO_RUNAS -eq '1') {
            $msg = '需要管理员权限才能修改 hosts（自动提权已按测试注入跳过）。请以管理员身份重跑安装器，或稍后重试。'
            $script:GitHubFixState.error = $msg
            throw $msg
        }
        $elevatedResult = Join-Path ([System.IO.Path]::GetTempPath()) ('githubfix-elevated-' + [Guid]::NewGuid().ToString('N') + '.json')
        try {
            Write-Host '  [GitHubFix] 需要管理员权限，尝试提权修复 hosts（可能弹出 UAC）…' -ForegroundColor Yellow
            $argList = @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'),
                '-GitHubFixApplyElevated', '-GitHubFixHostsPath', ('"' + $target + '"'),
                '-GitHubFixElevatedResult', ('"' + $elevatedResult + '"')
            )
            $proc = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList -WindowStyle Hidden -PassThru -Wait
            $payload = $null
            if (Test-Path -LiteralPath $elevatedResult) {
                try { $payload = [System.IO.File]::ReadAllText($elevatedResult, [System.Text.Encoding]::UTF8) | ConvertFrom-Json } catch { $payload = $null }
            }
            try { if (Test-Path -LiteralPath $elevatedResult) { Remove-Item -LiteralPath $elevatedResult -Force } } catch { }
            if ($payload -and $payload.ok) {
                $script:GitHubFixState.applied = $true
                $script:GitHubFixState.chosenIp = [string]$payload.chosenIp
                $script:GitHubFixState.hostsPath = [string]$payload.hostsPath
                Write-Host ('  [GitHubFix] 提权修复成功：' + $script:GitHubFixState.chosenIp) -ForegroundColor Green
                return [pscustomobject]@{ ok = $true; applied = $true; chosenIp = [string]$payload.chosenIp; hostsPath = [string]$payload.hostsPath; elevated = $true }
            }
            $msg = '提权修复 hosts 失败（' + [string]($payload.message) + '）；请以管理员身份重跑安装器，或手动执行 -GitHubFixRestore 清理。'
            $script:GitHubFixState.error = $msg
            throw $msg
        } catch {
            $msg = '需要管理员权限才能修改 hosts：' + $_.Exception.Message
            $script:GitHubFixState.error = $msg
            throw $msg
        }
    }
    Write-Host '  [GitHubFix] 探测 GitHub 候选 IP（github.com / api / raw）…'
    $chosen = Select-GitHubFixIp -Candidates $script:GitHubFixHostCandidates -Sni 'github.com'
    if (-not $chosen) {
        $tried = (@($script:GitHubFixHostCandidates | Select-Object -First 5) -join ', ')
        $msg = "所有候选 IP 都不可达（已试：$tried）。改 hosts 无效，请换网络或稍后重试。"
        $script:GitHubFixState.error = $msg
        throw $msg
    }
    $api = Select-GitHubFixIp -Candidates $script:GitHubFixApiCandidates -Sni 'api.github.com' -MaxTry 4
    $raw = Select-GitHubFixIp -Candidates $script:GitHubFixRawCandidates -Sni 'raw.githubusercontent.com' -MaxTry 4
    $read = Read-GitHubFixHostsText -Path $target
    $clean = Get-GitHubFixStrippedText -Text ([string]$read.Text)
    $lines = @("$($chosen.Ip) github.com", "$($chosen.Ip) codeload.github.com")
    if ($api) { $lines += "$($api.Ip) api.github.com" }
    if ($raw) { $lines += "$($raw.Ip) raw.githubusercontent.com" }
    $block = $script:GitHubFixMarkerStart + "`r`n" + ($lines -join "`r`n") + "`r`n" + $script:GitHubFixMarkerEnd
    $newText = $clean.TrimEnd() + "`r`n" + $block + "`r`n"
    try {
        Write-GitHubFixHostsText -Path $target -Text $newText
    } catch {
        try { if ($read.Bytes) { [System.IO.File]::WriteAllBytes($target, $read.Bytes) } } catch { }
        $msg = '写 hosts 失败：' + $_.Exception.Message
        $script:GitHubFixState.error = $msg
        throw $msg
    }
    Invoke-GitHubFixFlushDns
    $script:GitHubFixState.applied = $true
    $script:GitHubFixState.chosenIp = [string]$chosen.Ip
    $script:GitHubFixState.hostsPath = $target
    Write-Host ("  [GitHubFix] 已写入 hosts 标记段：$($chosen.Ip)（github.com / codeload）；api=$(if ($api) { $api.Ip } else { '未选到' }) raw=$(if ($raw) { $raw.Ip } else { '未选到' })") -ForegroundColor Green
    return [pscustomobject]@{ ok = $true; applied = $true; chosenIp = [string]$chosen.Ip; hostsPath = $target }
}
function Invoke-GitHubFixEnsure {
    if ($NoGitHubFix) { return [pscustomobject]@{ ok = $true; applied = $false; skipped = $true; reason = 'NO_GITHUBFIX' } }
    if ($script:GitHubFixState.applied) { return [pscustomobject]@{ ok = $true; applied = $true; chosenIp = $script:GitHubFixState.chosenIp } }
    try {
        $r = Invoke-GitHubFixApply -Path $GitHubFixHostsPath
        $script:GitHubFix = [pscustomobject]@{
            applied   = [bool]$r.applied
            chosenIp  = [string]$r.chosenIp
            restored  = [bool]$script:GitHubFixState.restored
            hostsPath = [string]$r.hostsPath
        }
        return $r
    } catch {
        Add-InstallerWarning -Code 'GITHUB_FIX_FAILED' -Message ('GitHub 连接自动修复失败：' + $_.Exception.Message)
        $script:GitHubFix = [pscustomobject]@{
            applied   = [bool]$script:GitHubFixState.applied
            chosenIp  = [string]$script:GitHubFixState.chosenIp
            restored  = [bool]$script:GitHubFixState.restored
            hostsPath = [string]$script:GitHubFixState.hostsPath
            error     = [string]$_.Exception.Message
        }
        return [pscustomobject]@{ ok = $false; applied = $false; code = 'GITHUB_FIX_FAILED'; message = [string]$_.Exception.Message }
    }
}

function Invoke-GitHubFixDownloadOnce {
    param([string]$Url, [string]$Destination, [int]$MinBytes = 10240)
    try {
        $currentProtocol = [System.Net.ServicePointManager]::SecurityProtocol
        [System.Net.ServicePointManager]::SecurityProtocol = $currentProtocol -bor [System.Net.SecurityProtocolType]::Tls12
    } catch { }
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination -TimeoutSec 300 -Headers @{ 'User-Agent' = 'PMWorkbench-Installer/1.0' }
    $length = (Get-Item -LiteralPath $Destination).Length
    if ($length -lt $MinBytes) { throw "下载文件太小（$length 字节），可能不是有效的 zip" }
    return $length
}

# 下载仓库 zip / 升级 zip 的统一入口：先预检 → 不可达则自动修 hosts → 失败重试 3 次退避。
function Invoke-GitHubFixedDownload {
    param([string]$Url, [string]$Destination, [int]$Attempts = 3, [string]$Label = '下载', [int]$MinBytes = 10240)
    $delays = @(0, 2, 5, 10)
    $lastError = $null
    # 只有下载地址是 GitHub 域时才做连接修复（本地/镜像源不受影响，也不做无谓探测）
    $needFix = -not $NoGitHubFix
    try {
        $uri = [System.Uri]$Url
        if (-not ($uri.Host -match '(^|\.)(github\.com|githubusercontent\.com)$')) { $needFix = $false }
    } catch { $needFix = $false }
    if ($needFix) {
        $probe = Test-GitHubFixEndpoint -Ip $script:GitHubFixHostCandidates[0] -Sni 'github.com' -TimeoutMs 2500
        if (-not $probe) {
            Write-Host '  [GitHubFix] 预检 github.com 不可达，自动应用 hosts 修复…' -ForegroundColor Yellow
            [void](Invoke-GitHubFixEnsure)
        }
    }
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        $script:GitHubFixState.attempts = $attempt
        try {
            if ($attempt -gt 1) { Start-Sleep -Seconds $delays[[Math]::Min($attempt, $delays.Count - 1)] }
            Write-InstallerLog 'RUN' ("{0} 第 {1}/{2} 次：{3}" -f $Label, $attempt, $Attempts, $Url)
            $len = Invoke-GitHubFixDownloadOnce -Url $Url -Destination $Destination -MinBytes $MinBytes
            Write-InstallerLog 'OK' ("{0}完成：{1:N1} MB" -f $Label, ($len / 1MB))
            if ($script:GitHubFixState.applied) {
                $script:GitHubFix = [pscustomobject]@{
                    applied   = $true
                    chosenIp  = [string]$script:GitHubFixState.chosenIp
                    restored  = $false
                    hostsPath = [string]$script:GitHubFixState.hostsPath
                }
            }
            return $len
        } catch {
            $lastError = $_
            Write-InstallerLog 'WARN' ("{0}失败（第 {1} 次）：{2}" -f $Label, $attempt, $_.Exception.Message)
            if ($needFix -and $attempt -eq 1) {
                $ensure = Invoke-GitHubFixEnsure
                if ($ensure -and $ensure.applied) { Write-Host ('  [GitHubFix] 已应用修复（' + $script:GitHubFixState.chosenIp + '），重试下载…') -ForegroundColor Green }
            }
        }
    }
    # 修复后仍失败：把 hosts 恢复到运行前原文（零残留）并抛可读错误
    if ($script:GitHubFixState.applied) {
        Write-Host '  [GitHubFix] 修复后仍下载失败，恢复 hosts 原文（不留标记段）…' -ForegroundColor Yellow
        [void](Invoke-GitHubFixRestore -Path (Get-GitHubFixHostsPath) -Quiet)
    }
    $tried = (@($script:GitHubFixHostCandidates | Select-Object -First 5) -join ', ')
    $msg = "下载失败（已试 $Attempts 次）；尝试过的候选 IP：$tried；最后错误：$($lastError.Exception.Message)"
    $script:GitHubFixState.error = $msg
    if ($script:GitHubFix) {
        $script:GitHubFix = [pscustomobject]@{
            applied   = $false
            chosenIp  = [string]$script:GitHubFixState.chosenIp
            restored  = [bool]$script:GitHubFixState.restored
            hostsPath = [string]$script:GitHubFixState.hostsPath
            error     = $msg
        }
    }
    throw $msg
}

function Invoke-GitHubFixTestMode {
    param([string]$Mode)
    $state = $null
    try {
        if ($Mode -eq 'apply') {
            $state = Invoke-GitHubFixApply -Path $GitHubFixHostsPath
        } elseif ($Mode -eq 'restore') {
            $state = Invoke-GitHubFixRestore -Path $GitHubFixHostsPath
        } elseif ($Mode -eq 'download') {
            $url = $ZipUrl
            $dest = Join-Path ([System.IO.Path]::GetTempPath()) ('githubfix-test-' + [Guid]::NewGuid().ToString('N') + '.zip')
            try { [void](Invoke-GitHubFixedDownload -Url $url -Destination $dest -Attempts 3 -Label '测试下载') }
            catch { $state = [pscustomobject]@{ ok = $false; code = 'DOWNLOAD_FAILED'; message = [string]$_.Exception.Message } }
            finally { try { if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force } } catch { } }
        } else {
            throw "未知的 -GitHubFixTest 模式：$Mode（支持 apply/restore/download）"
        }
        $payload = [pscustomobject]@{
            ok        = [bool]($state -and $state.ok)
            mode      = $Mode
            state     = $script:GitHubFixState
            githubFix = $script:GitHubFix
        }
        Write-Host ('GITHUBFIX_TEST_JSON ' + ($payload | ConvertTo-Json -Depth 6 -Compress))
        if ($state -and $state.ok) { return 0 }
        return 1
    } catch {
        $payload = [pscustomobject]@{ ok = $false; mode = $Mode; error = [string]$_.Exception.Message; state = $script:GitHubFixState }
        Write-Host ('GITHUBFIX_TEST_JSON ' + ($payload | ConvertTo-Json -Depth 6 -Compress))
        return 2
    }
}

# ── P0-1 / P2-7（B-20261119-123400-c437）：electron 自愈 + 目录状态 + Move 退避重试 ─────────
function Get-ElectronDirState {
    param([string]$RepoRoot)
    $dist = Join-Path $RepoRoot 'node_modules\electron\dist'
    $pathTxt = Join-Path $RepoRoot 'node_modules\electron\path.txt'
    $count = 0
    try { if (Test-Path -LiteralPath $dist) { $count = @(Get-ChildItem -LiteralPath $dist -Force -Recurse -File -ErrorAction SilentlyContinue).Count } } catch { $count = 0 }
    $txt = ''
    try { if (Test-Path -LiteralPath $pathTxt) { $txt = [System.IO.File]::ReadAllText($pathTxt, [System.Text.Encoding]::UTF8).Trim() } } catch { $txt = '' }
    return [pscustomobject]@{
        distExists = (Test-Path -LiteralPath $dist)
        exeExists  = (Test-Path -LiteralPath (Join-Path $dist 'electron.exe'))
        fileCount  = [int]$count
        pathTxt    = $txt
    }
}

function Get-MoveFailureClass {
    param($ErrorRecord)
    try {
        $msg = [string]$ErrorRecord.Exception.Message
        if ($msg -match 'denied|拒绝访问|权限') {
            # Access denied 时区分「占用」（文件正在被读写）与「真没权限」：尝试在目标父目录建临时文件。
            return 'permission-or-locked'
        }
        if ($msg -match '因为另一个进程|being used by another process|占用|sharing violation') { return 'in-use' }
        return 'other'
    } catch { return 'other' }
}

function Move-DirectoryWithRetry {
    param([string]$Source, [string]$Destination, [int]$Attempts = 3)
    $failTimes = 0
    try { $failTimes = [int]($env:AWB_TEST_MOVE_FAIL_TIMES) } catch { $failTimes = 0 }
    $lastError = $null
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            if ($attempt -le $failTimes) { throw (New-Object System.IO.IOException ('模拟占用（测试注入，第 ' + $attempt + ' 次）：Access is denied.')) }
            if ($attempt -gt 1) { Start-Sleep -Milliseconds (250 * $attempt) }
            [System.IO.Directory]::Move($Source, $Destination)
            return [pscustomobject]@{ ok = $true; attempts = $attempt; mode = 'move'; errorClass = ''; message = '' }
        } catch {
            $lastError = $_
            Write-InstallerLog 'WARN' ("目录移动失败（第 {0}/{1} 次，{2}）：{3}" -f $attempt, $Attempts, (Get-MoveFailureClass $_), $_.Exception.Message)
        }
    }
    # 复制兜底：Move 一直被占用/跨卷时，复制成功后再删源目录。
    if ($env:AWB_TEST_MOVE_COPY_FAIL -eq '1') {
        return [pscustomobject]@{ ok = $false; attempts = ($Attempts + 1); mode = ''; errorClass = 'permission-or-locked'; message = '复制兜底也失败（测试注入）' }
    }
    try {
        New-Item -ItemType Directory -Force -Path $Destination | Out-Null
        Copy-Item -LiteralPath (Join-Path $Source '*') -Destination $Destination -Recurse -Force -ErrorAction Stop
        return [pscustomobject]@{ ok = $true; attempts = $Attempts + 1; mode = 'copy'; errorClass = ''; message = '' }
    } catch {
        $cls = Get-MoveFailureClass $_
        return [pscustomobject]@{ ok = $false; attempts = $Attempts + 1; mode = ''; errorClass = $cls; message = [string]$_.Exception.Message }
    }
}

function Invoke-ElectronHeal {
    param([string]$RepoRoot, [string]$CacheDir)
    $dist = Join-Path $RepoRoot 'node_modules\electron\dist'
    $pathTxt = Join-Path $RepoRoot 'node_modules\electron\path.txt'
    if (Test-Path -LiteralPath (Join-Path $dist 'electron.exe')) {
        try { [System.IO.File]::WriteAllText($pathTxt, 'electron.exe', (New-Object System.Text.UTF8Encoding($false))) } catch { }
        return [pscustomobject]@{ ok = $true; reason = 'already-present'; cacheZip = ''; attempts = 0 }
    }
    $cache = $CacheDir
    if (-not $cache) { $cache = Join-Path $env:LOCALAPPDATA 'electron\Cache' }
    $zip = $null
    if (Test-Path -LiteralPath $cache) {
        $zip = Get-ChildItem -LiteralPath $cache -Recurse -Filter 'electron-v*-win32-x64.zip' -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $zip) {
            $zip = Get-ChildItem -LiteralPath $cache -Recurse -Filter 'electron-v*.zip' -File -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
        }
    }
    if (-not $zip) { return [pscustomobject]@{ ok = $false; reason = 'no-cache-zip'; cacheZip = ''; attempts = 0 } }
    $lastError = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            if ($attempt -gt 1) { Start-Sleep -Milliseconds (300 * $attempt) }
            New-Item -ItemType Directory -Force -Path $dist | Out-Null
            Expand-Archive -LiteralPath $zip.FullName -DestinationPath $dist -Force -ErrorAction Stop
            if (-not (Test-Path -LiteralPath (Join-Path $dist 'electron.exe'))) { throw '解压完成但 electron.exe 仍缺失' }
            [System.IO.File]::WriteAllText($pathTxt, 'electron.exe', (New-Object System.Text.UTF8Encoding($false)))
            Write-InstallerLog 'OK' ("Electron postinstall 未生效，已从缓存 zip 自愈：{0}（第 {1} 次）" -f $zip.FullName, $attempt)
            return [pscustomobject]@{ ok = $true; reason = 'cache-zip'; cacheZip = $zip.FullName; attempts = $attempt }
        } catch {
            $lastError = $_
            Write-InstallerLog 'WARN' ("Electron 缓存自愈失败（第 {0}/3 次，{1}）：{2}" -f $attempt, (Get-MoveFailureClass $_), $_.Exception.Message)
        }
    }
    return [pscustomobject]@{ ok = $false; reason = ('extract-failed: ' + [string]$lastError.Exception.Message); cacheZip = $zip.FullName; attempts = 3 }
}

function Show-Help {
    Write-Host $script:HelpText
}

# ── 主流程 ────────────────────────────────────────────────────────────────

# 248a：GitHubFix 的独立入口（恢复 / 夹具测试模式），先于安装与升级处理
if ($GitHubFixRestore) {
    $restoreResult = Invoke-GitHubFixRestore -Path $GitHubFixHostsPath
    if ($restoreResult.ok) { exit 0 }
    exit 1
}
if (-not [string]::IsNullOrWhiteSpace($GitHubFixTest)) {
    exit (Invoke-GitHubFixTestMode -Mode $GitHubFixTest)
}
if ($GitHubFixApplyElevated) {
    # 提权子进程：只做 hosts 修复并把结果写到 -GitHubFixElevatedResult（父进程读取）
    $env:AWB_GITHUBFIX_ELEVATED = '1'
    $code = 1
    $payload = [ordered]@{ ok = $false; applied = $false; chosenIp = ''; hostsPath = ''; error = '' }
    try {
        $r = Invoke-GitHubFixApply -Path $GitHubFixHostsPath
        $payload.ok = [bool]$r.ok
        $payload.applied = [bool]$r.applied
        $payload.chosenIp = [string]$r.chosenIp
        $payload.hostsPath = [string]$r.hostsPath
        if ($r.ok) { $code = 0 }
    } catch {
        $payload.error = [string]$_.Exception.Message
    }
    try {
        if ($GitHubFixElevatedResult) {
            [System.IO.File]::WriteAllText($GitHubFixElevatedResult, ($payload | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
        }
    } catch { }
    exit $code
}
# P0-1 / P2-7（B-20261119-123400-c437）：夹具自检入口（只跑对应函数并输出 JSON）
if ($TestElectronHeal) {
    $healResult = Invoke-ElectronHeal -RepoRoot $TestElectronHeal -CacheDir $TestElectronCacheDir
    $payload = [pscustomobject]@{
        ok        = [bool]$healResult.ok
        reason    = [string]$healResult.reason
        cacheZip  = [string]$healResult.cacheZip
        attempts  = [int]$healResult.attempts
        dirState  = (Get-ElectronDirState -RepoRoot $TestElectronHeal)
    }
    Write-Host ('ELECTRON_HEAL_JSON ' + ($payload | ConvertTo-Json -Depth 6 -Compress))
    if ($healResult.ok) { exit 0 }
    exit 1
}
if ($TestMoveRetrySrc -and $TestMoveRetryDst) {
    $moveResult = Move-DirectoryWithRetry -Source $TestMoveRetrySrc -Destination $TestMoveRetryDst -Attempts 3
    $payload = [pscustomobject]@{
        ok         = [bool]$moveResult.ok
        attempts   = [int]$moveResult.attempts
        mode       = [string]$moveResult.mode
        errorClass = [string]$moveResult.errorClass
        message    = [string]$moveResult.message
    }
    Write-Host ('MOVE_RETRY_JSON ' + ($payload | ConvertTo-Json -Depth 5 -Compress))
    if ($moveResult.ok) { exit 0 }
    exit 1
}
# B-d83d2（Owner 2026-11-19：升级必须真部署新代码）：夹具入口——对沙盘目录跑
# 「应用 → 部署校验 → （可选）失败自动回滚 → （可选）验证回滚结果」，输出单行 JSON 供夹具断言。
if (-not [string]::IsNullOrWhiteSpace($TestUpgradeApply)) {
    $payload = [ordered]@{
        ok = $false; mode = 'apply'; error = '';
        installedVersion = ''; verifiedFiles = 0; manifestCount = 0;
        rollback = $false; restoredVersion = '';
    }
    try {
        $cfg = [System.IO.File]::ReadAllText($TestUpgradeApply, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        $applyInstall = [string]$cfg.installDir
        $applyStaging = [string]$cfg.stagingDir
        $applyBackup = [string]$cfg.backupDir
        $applyTarget = [string]$cfg.targetVersion
        if ([bool]$cfg.failApply) { $env:AWB_UPGRADE_FAIL_APPLY = '1' }
        try {
            $applied = Invoke-UpgradeApplyTree -RepoRoot $applyInstall -StagingRoot $applyStaging -BackupDir $applyBackup
            $payload.manifestCount = @($applied.manifest).Count
            $verify = Invoke-UpgradeVerifyInstall -RepoRoot $applyInstall -StagingRoot $applyStaging -TargetVersion $applyTarget
            $payload.installedVersion = [string]$verify.installedVersion
            $payload.verifiedFiles = [int]$verify.checkedFiles
            $payload.ok = $true
        } catch {
            $payload.error = [string]$_.Exception.Message
            if ([bool]$cfg.autoRollback) {
                try {
                    [void](Restore-UpgradeBackup -RepoRoot $applyInstall -BackupDir $applyBackup)
                    $payload.rollback = $true
                    $pkgFile = Join-Path $applyInstall 'package.json'
                    if (Test-Path -LiteralPath $pkgFile) {
                        try { $payload.restoredVersion = [string]((Get-Content -LiteralPath $pkgFile -Raw -Encoding UTF8) | ConvertFrom-Json).version } catch { }
                    }
                } catch { $payload.error = $payload.error + '；回滚失败：' + [string]$_.Exception.Message }
            }
        } finally {
            Remove-Item Env:\AWB_UPGRADE_FAIL_APPLY -ErrorAction SilentlyContinue
        }
        if ([bool]$cfg.verifyRollback) {
            try {
                [void](Restore-UpgradeBackup -RepoRoot $applyInstall -BackupDir $applyBackup)
                $payload.rollback = $true
            } catch { $payload.error = $payload.error + '；回滚失败：' + [string]$_.Exception.Message }
        }
    } catch {
        $payload.error = [string]$_.Exception.Message
    }
    Write-Host ('UPGRADE_APPLY_JSON ' + ($payload | ConvertTo-Json -Depth 5 -Compress))
    if ($payload.ok) { exit 0 }
    exit 1
}
if ($Help) {
    Show-Help
    $script:ExitCode = 0
    return
}

$cwd = $null
try {
    $cwd = (Get-Location).ProviderPath
} catch {
    try { $cwd = (Get-Location).Path } catch { $cwd = $null }
}
$cwdIsRepo = $false
if ($cwd) { $cwdIsRepo = Test-RepoRoot $cwd }

if ($LogDir) {
    Start-InstallerLog -Directory $LogDir
} elseif ($cwdIsRepo) {
    Start-InstallerLog -Directory (Join-Path $cwd '_tmp\install-logs')
} else {
    $localAppData = $env:LOCALAPPDATA
    if (-not $localAppData) { $localAppData = [System.IO.Path]::GetTempPath() }
    Start-InstallerLog -Directory (Join-Path $localAppData 'PMWorkbench\install-logs')
}
if (-not $script:LogFile) {
    Start-InstallerLog -Directory (Join-Path ([System.IO.Path]::GetTempPath()) 'PMWorkbench-install-logs')
}

# ── R-2de7 一键重置 / 彻底卸载（T-20261119-212641-33a8）──────────────────────
# 设计要点（需求正文 v3 / RR-20261119-212109-e489）：
#   ① -BackupTo 缺省：-Sandbox 时 <Root>-maint-backup\<ts>\（Root 外同级；卸载删 Root 后备份仍在），非沙盘才桌面；
#   ② 四道闸：dry-run 清单 → 逐字确认短语 → 备份成功才动 → 路径白名单（越界 PATH_NOT_ALLOWED 零删除）；
#   ③ 占用不删（APP_RUNNING/APP_DATA_LOCKED+PID），-KillOwn 只按 PID 结束本安装实例（禁按名批量杀）；
#   ④ 系统级六类 CAS，-Sandbox 只出计划并标 SKIPPED_SANDBOX（真实状态零写入）；
#   ⑤ 并发 .awb-maint.lock，第二进程 LOCK_HELD 零删除；清单 JSON 落备份目录。

function Write-MaintLine {
    param([string]$Text, [string]$Color = 'Gray')
    if ($script:MaintJsonMode) { return }
    if ($Text) { Write-Host $Text -ForegroundColor $Color }
}

function Resolve-MaintRoot {
    param([string]$InstallDir)
    if ($InstallDir -and (Test-Path -LiteralPath $InstallDir)) { return (Resolve-Path -LiteralPath $InstallDir).Path }
    if ($PSCommandPath) {
        $scriptRoot = Split-Path -Parent $PSCommandPath
        if (Test-RepoRoot $scriptRoot) { return (Resolve-Path -LiteralPath $scriptRoot).Path }
    }
    $cwdNow = (Get-Location).Path
    if (Test-RepoRoot $cwdNow) { return $cwdNow }
    return ''
}

function Get-MaintDefaultBackupRoot {
    param([string]$Root, [bool]$Sandbox, [string]$BackupTo)
    if ($BackupTo) { return $BackupTo }
    if ($Sandbox) { return ($Root.TrimEnd('\') + '-maint-backup') }
    $desktop = [Environment]::GetFolderPath('Desktop')
    if (-not $desktop) { $desktop = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Desktop' }
    return $desktop
}

function Test-MaintAllowedPath {
    param([string]$Path, [string[]]$AllowedRoots)
    if (-not $Path) { return $false }
    try { $full = [System.IO.Path]::GetFullPath($Path) } catch { return $false }
    foreach ($root in $AllowedRoots) {
        if (-not $root) { continue }
        $r = ''
        try { $r = [System.IO.Path]::GetFullPath($root).TrimEnd('\') } catch { continue }
        if (-not $r) { continue }
        if ($full.Equals($r, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
        if ($full.StartsWith($r + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Get-MaintSha12 {
    param([string]$Path)
    try {
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.Substring(0, 12).ToLower()
        }
    } catch { }
    return ''
}

function Get-MaintBytes {
    param([string]$Path)
    try { return (Get-Item -LiteralPath $Path -Force -ErrorAction Stop).Length } catch { return 0 }
}

function New-MaintItem {
    param([string]$Category, [string]$Action, [string]$Path, [string]$Result = 'pending', [string]$Reason = '', [string]$Code = '')
    $existed = Test-Path -LiteralPath $Path
    $item = [ordered]@{
        category = $Category
        action   = $Action
        path     = $Path
        existed  = [bool]$existed
        bytes    = $(if ($existed) { (Get-MaintBytes $Path) } else { 0 })
        sha256_12 = $(if ($existed -and (Test-Path -LiteralPath $Path -PathType Leaf)) { (Get-MaintSha12 $Path) } else { '' })
        result   = $Result
    }
    if ($Reason) { $item.reason = $Reason }
    if ($Code) { $item.code = $Code }
    return $item
}

function Get-MaintResetItems {
    param([string]$Root, [switch]$KeepBackups)
    $items = @()
    $dataDir = Join-Path $Root 'data'
    # §6.2：_backup\ 默认留；仅在显式传 -KeepBackups（正文「关掉才删」）时删
    if ($KeepBackups) { $items += New-MaintItem 'backup' 'delete' (Join-Path $Root '_backup') }
    foreach ($rel in @('data\userdata', 'data\tmp')) {
        $items += New-MaintItem 'data' 'delete' (Join-Path $Root $rel)
    }
    foreach ($name in @('dsh.json', 'dsh-capability.json', 'dsh-endpoint.jsonl', 'fx.jsonl', 'mcp-selfcheck.json')) {
        $items += New-MaintItem 'data' 'delete' (Join-Path $dataDir $name)
    }
    foreach ($rel in @('团队\状态', '团队\日志')) {
        $items += New-MaintItem 'team' 'delete' (Join-Path $Root $rel)
    }
    $teamDir = Join-Path $Root '团队'
    if (Test-Path -LiteralPath $teamDir) {
        foreach ($f in @(Get-ChildItem -LiteralPath $teamDir -Filter '看板.*' -File -ErrorAction SilentlyContinue)) {
            $items += New-MaintItem 'team' 'delete' $f.FullName
        }
    }
    foreach ($rel in @('_tmp', '.selftest-data', '.sandbox')) {
        $items += New-MaintItem 'selfcheck' 'delete' (Join-Path $Root $rel)
    }
    foreach ($d in @(Get-ChildItem -LiteralPath $Root -Directory -Filter '*-check-data' -ErrorAction SilentlyContinue)) {
        $items += New-MaintItem 'selfcheck' 'delete' $d.FullName
    }
    # 「留」项：只入清单供核对（action=keep），不动
    foreach ($rel in @('项目', '团队\产出', '团队\项目')) {
        $items += New-MaintItem 'keep' 'keep' (Join-Path $Root $rel) 'kept'
    }
    return $items
}

function Get-MaintUninstallProgramItems {
    param([string]$Root, [bool]$KeepData, [switch]$KeepBackups)
    $items = @()
    # §6.3：默认档整删 Root（_backup 随之消失）；-KeepData 档 Root 保留，只有 -KeepBackups 才单独删 _backup
    if ($KeepBackups) { $items += New-MaintItem 'backup' 'delete' (Join-Path $Root '_backup') }
    $programRels = @('src', 'scripts', 'dsh-plugin', 'assets', 'docs', 'node_modules', '.runtime',
        'package.json', 'package-lock.json', 'install.ps1', 'start.cmd', 'launch.vbs', 'README.md',
        'CHANGELOG.md', 'NOTICE.md', 'LICENSE', '发版记录.md', '安装PM工作台.cmd',
        '卸载PM工作台.cmd', '彻底卸载PM工作台.cmd')
    foreach ($rel in $programRels) { $items += New-MaintItem 'program' 'delete' (Join-Path $Root $rel) }
    $items += New-MaintItem 'data' 'delete' (Join-Path $Root 'data')
    $items += New-MaintItem 'data' 'delete' (Join-Path $Root '_tmp')
    $items += New-MaintItem 'selfcheck' 'delete' (Join-Path $Root '.selftest-data')
    $items += New-MaintItem 'selfcheck' 'delete' (Join-Path $Root '.sandbox')
    $teamDir = Join-Path $Root '团队'
    if (Test-Path -LiteralPath $teamDir) {
        foreach ($f in @(Get-ChildItem -LiteralPath $teamDir -Filter '看板.*' -File -ErrorAction SilentlyContinue)) {
            $items += New-MaintItem 'team' 'delete' $f.FullName
        }
    }
    foreach ($d in @(Get-ChildItem -LiteralPath $Root -Directory -Filter '*-check-data' -ErrorAction SilentlyContinue)) {
        $items += New-MaintItem 'selfcheck' 'delete' $d.FullName
    }
    if ($KeepData) {
        foreach ($rel in @('项目', '团队\产出', '团队\项目', '团队\状态')) {
            $items += New-MaintItem 'keep' 'keep' (Join-Path $Root $rel) 'kept'
        }
    }
    return $items
}

function Get-MaintOwnProcesses {
    param([string]$Root)
    $out = @()
    try {
        foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue)) {
            $cmd = [string]$p.CommandLine
            if ($cmd -and $cmd.IndexOf($Root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                $out += [pscustomobject]@{ pid = [int]$p.ProcessId; commandLine = $cmd }
            }
        }
    } catch { }
    return $out
}

function Get-MaintLockPath {
    param([string]$Root)
    $parent = Split-Path -Parent $Root
    if (-not $parent) { $parent = $Root }
    $candidate = Join-Path $Root '.awb-maint.lock'
    # 卸载会删 Root：锁放 Root 外同级，保证卸载期间不会被自己删掉
    if (-not (Test-Path -LiteralPath $Root)) { return (Join-Path $parent ('.awb-maint-' + [System.IO.Path]::GetFileName($Root.TrimEnd('\')) + '.lock')) }
    return $candidate
}

function Enter-MaintLock {
    param([string]$Root)
    $lockFile = Get-MaintLockPath $Root
    # B-5cce：记下「锁文件是否本次新建」，供 Exit-MaintLock 决定要不要删（别人持有的锁绝不删）
    $existedBefore = $false
    try { $existedBefore = Test-Path -LiteralPath $lockFile } catch { $existedBefore = $false }
    try {
        $stream = [System.IO.File]::Open($lockFile, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        $script:MaintLockStream = $stream
        $script:MaintLockFile = $lockFile
        $script:MaintLockNewlyCreated = (-not $existedBefore)
        return $true
    } catch {
        return $false
    }
}

function Exit-MaintLock {
    if ($script:MaintLockStream) {
        try { $script:MaintLockStream.Dispose() } catch { }
        $script:MaintLockStream = $null
    }
    # B-5cce：失败路径也不留 .awb-maint.lock —— 只有「本次自己新建的」才删，别人持有的锁绝不删。
    if ($script:MaintLockNewlyCreated -and $script:MaintLockFile) {
        try { if (Test-Path -LiteralPath $script:MaintLockFile) { Remove-Item -LiteralPath $script:MaintLockFile -Force -ErrorAction SilentlyContinue } } catch { }
    }
    $script:MaintLockNewlyCreated = $false
}

function Invoke-MaintBackup {
    param([string]$Mode, [string]$Root, [string]$BackupDir, [bool]$IncludeProjects, [switch]$NoBackup)
    if ($NoBackup) { return [pscustomobject]@{ ok = $true; zip = $null; dir = $BackupDir; note = 'no-backup' } }
    $src = @()
    if ($Mode -eq 'reset') {
        $src += (Join-Path $Root '团队\状态')
        $src += @(Get-ChildItem -LiteralPath (Join-Path $Root '团队') -Filter '看板.*' -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
        $src += (Join-Path $Root 'data\userdata\workbench.json')
        if ($IncludeProjects) { $src += (Join-Path $Root '项目') }
    } else {
        $src += (Join-Path $Root '项目')
        $src += (Join-Path $Root '团队\产出')
        $src += (Join-Path $Root '团队\状态')
    }
    $existing = @($src | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
    if (-not $existing.Count) { return [pscustomobject]@{ ok = $true; zip = $null; dir = $BackupDir; note = 'no-user-data' } }
    try {
        New-Item -ItemType Directory -Force -Path $BackupDir -ErrorAction Stop | Out-Null
        $tag = if ($Mode -eq 'reset') { 'PM工作台-维护' } else { 'PM工作台-卸载' }
        $zip = Join-Path $BackupDir ($tag + '-' + (Get-UpgradeStamp) + '.zip')
        # 用 staging 保持 zip 内相对路径可读（避免整盘绝对路径进包）
        $staging = Join-Path $BackupDir 'staging'
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
        New-Item -ItemType Directory -Force -Path $staging | Out-Null
        foreach ($p in $existing) {
            $rel = $p.Substring($Root.TrimEnd('\').Length).TrimStart('\')
            $target = Join-Path $staging $rel
            $parent = Split-Path -Parent $target
            if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
            if (Test-Path -LiteralPath $p -PathType Container) {
                Join-Path $staging $rel | Out-Null
                Copy-Item -LiteralPath $p -Destination $target -Recurse -Force -ErrorAction Stop
            } else {
                Copy-Item -LiteralPath $p -Destination $target -Force -ErrorAction Stop
            }
        }
        Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -Force -ErrorAction Stop
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        return [pscustomobject]@{ ok = $true; zip = $zip; dir = $BackupDir; note = 'ok' }
    } catch {
        return [pscustomobject]@{ ok = $false; zip = $null; dir = $BackupDir; note = [string]$_.Exception.Message }
    }
}

function Remove-MaintTarget {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{ result = 'already'; reason = 'not-found' } }
    try {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
        return [pscustomobject]@{ result = 'deleted'; reason = '' }
    } catch {
        return [pscustomobject]@{ result = 'failed'; reason = [string]$_.Exception.Message }
    }
}

function Get-MaintSystemItems {
    param([string]$Root, [string]$ShortcutDir, [string]$LocalAppDataDir, [string]$TempDir, [string]$DshHome, [string]$GitHubFixHostsPath, [bool]$Sandbox)
    $items = @()
    # B 快捷方式：桌面 + 开始菜单，仅当指向本安装的 launch.vbs
    $shortcutDirs = @()
    if ($ShortcutDir) { $shortcutDirs += $ShortcutDir } else { $shortcutDirs += [Environment]::GetFolderPath('Desktop') }
    $startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'PM工作台.lnk'
    foreach ($dir in $shortcutDirs) {
        if (-not $dir) { continue }
        $lnk = Join-Path $dir 'PM工作台.lnk'
        $item = New-MaintItem 'shortcut' 'delete' $lnk
        if ($item.existed) {
            $targetOk = $false
            try {
                $shell = New-Object -ComObject WScript.Shell
                $sc = $shell.CreateShortcut($lnk)
                $targetOk = ([string]$sc.TargetPath -match '(?i)wscript\.exe$') -and ([string]$sc.Arguments -match '(?i)launch\.vbs')
                $item.reason = if ($targetOk) { 'points-to-this-install' } else { 'SHORTCUT_OTHER_INSTALL' }
            } catch { $item.reason = 'SHORTCUT_UNREADABLE' }
            if (-not $targetOk) { $item.code = 'SHORTCUT_OTHER_INSTALL'; $item.result = 'skipped' }
        }
        $items += $item
    }
    if (Test-Path -LiteralPath $startMenu) { $items += (New-MaintItem 'shortcut' 'delete' $startMenu) }
    # C env（User 级；沙盘只计划）
    foreach ($name in @('AWB_TEAM_ROOT', 'PM_WORKBENCH_HOME')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'User')
        $item = [ordered]@{ category = 'env'; action = 'delete'; path = $name; existed = [bool]$value; bytes = 0; sha256_12 = ''; result = 'pending'; value = [string]$value }
        if ($value) {
            if ($value.TrimEnd('\').ToLower() -eq $Root.TrimEnd('\').ToLower() -or $value.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
                $item.reason = 'points-to-this-install'
            } else {
                $item.code = 'ENV_POINTS_OTHER_INSTALL'; $item.result = 'skipped'; $item.reason = 'points-elsewhere'
            }
        }
        $items += $item
    }
    # D AppData / 临时（-LocalAppDataDir / -TempDir 可指沙盘）
    $localAppData = if ($LocalAppDataDir) { $LocalAppDataDir } else { $env:LOCALAPPDATA }
    $tempNow = if ($TempDir) { $TempDir } else { [System.IO.Path]::GetTempPath() }
    foreach ($p in @((Join-Path $localAppData 'PMWorkbench'), (Join-Path $localAppData 'electron\Cache'))) {
        $items += (New-MaintItem 'appdata' 'delete' $p)
    }
    foreach ($pattern in @('pm-workbench-*', 'PMWorkbench-*')) {
        foreach ($d in @(Get-ChildItem -LiteralPath $tempNow -Directory -Filter $pattern -ErrorAction SilentlyContinue)) {
            $items += (New-MaintItem 'appdata' 'delete' $d.FullName)
        }
    }
    # G hosts 标记段（-GitHubFixHostsPath 可指副本）
    $hosts = if ($GitHubFixHostsPath) { $GitHubFixHostsPath } else { Join-Path $env:SystemRoot 'System32\drivers\etc\hosts' }
    $hostsHas = $false
    try { $hostsHas = [bool](([System.IO.File]::ReadAllText($hosts, [System.Text.Encoding]::UTF8)) -match '>>> PMWorkbench GitHubFix >>>') } catch { }
    $items += [ordered]@{ category = 'hosts'; action = 'delete'; path = $hosts; existed = $hostsHas; bytes = (Get-MaintBytes $hosts); sha256_12 = (Get-MaintSha12 $hosts); result = 'pending' }
    # F 计划任务 + HKCU Run + 启动夹
    foreach ($name in @('PM工作台-自检', 'PMWorkbench-自检')) {
        $taskExists = $false
        try { $taskExists = [bool](Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) } catch { }
        $items += [ordered]@{ category = 'task'; action = 'delete'; path = $name; existed = $taskExists; bytes = 0; sha256_12 = ''; result = 'pending' }
    }
    $items += [ordered]@{ category = 'startup'; action = 'delete'; path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run\PM工作台'; existed = $false; bytes = 0; sha256_12 = ''; result = 'pending' }
    # E DSH 注册（-DshHome 可指沙盘）
    $dshRoot = if ($DshHome) { $DshHome } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh' }
    $profilesDir = Join-Path $dshRoot 'profiles'
    foreach ($pkg in @(Get-ChildItem -LiteralPath $profilesDir -Directory -ErrorAction SilentlyContinue)) {
        $pkgFile = Join-Path $pkg.FullName 'package.json'
        if (-not (Test-Path -LiteralPath $pkgFile)) { continue }
        $has = $false
        try {
            $text = [System.IO.File]::ReadAllText($pkgFile, [System.Text.Encoding]::UTF8)
            $has = ($text -match 'pm-workbench-dsh') -or ($text -match 'dsh-agile-workbench')
        } catch { }
        $items += [ordered]@{ category = 'dsh'; action = 'delete'; path = $pkgFile; existed = $has; bytes = (Get-MaintBytes $pkgFile); sha256_12 = (Get-MaintSha12 $pkgFile); result = 'pending' }
    }
    if ($Sandbox) {
        foreach ($item in $items) {
            if ($item.category -in @('shortcut', 'env', 'hosts', 'task', 'startup', 'dsh')) {
                $item.result = 'skipped_sandbox'
                $item.code = 'SKIPPED_SANDBOX'
            }
        }
    }
    return $items
}

function Invoke-MaintMode {
    param(
        [bool]$DoReset, [bool]$DoUninstall, [bool]$Purge, [bool]$KeepData, [bool]$KeepBackups,
        [bool]$DryRun, [bool]$Yes, [string]$Confirm, [string]$BackupTo, [bool]$IncludeProjects,
        [bool]$NoBackup, [bool]$NoLaunch, [bool]$Json, [bool]$Sandbox, [bool]$KillOwn, [bool]$Force,
        [string]$DshHome, [string]$LocalAppDataDir, [string]$TempDir, [string]$ShortcutDir,
        [string]$InstallDir, [string]$GitHubFixHostsPath
    )
    $mode = if ($DoReset) { 'reset' } else { 'uninstall' }
    $script:MaintJsonMode = [bool]$Json
    $result = [ordered]@{
        mode = $mode; at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ');
        root = ''; dryRun = [bool]$DryRun; sandbox = [bool]$Sandbox; confirmOk = $false;
        backupZip = $null; backupDir = ''; items = @(); verdict = 'RESIDUE';
        partial = $false; code = ''; message = ''; userDataDeleted = $false; needsDshRestart = $false
    }
    $root = Resolve-MaintRoot $InstallDir
    if (-not $root) {
        $result.code = 'ROOT_NOT_FOUND'; $result.message = '当前目录不是 PM工作台（缺 package.json/start.cmd/src\main.js）'
        Write-MaintLine ('  [维护被拒] ROOT_NOT_FOUND：' + $result.message) 'Red'
        if ($Json) { Write-Host ('AWB_MAINT_JSON:' + ($result | ConvertTo-Json -Depth 6 -Compress)) }
        return 2
    }
    $script:MaintRoot = $root
    $result.root = $root
    $backupRoot = Get-MaintDefaultBackupRoot -Root $root -Sandbox $Sandbox -BackupTo $BackupTo
    $stamp = Get-UpgradeStamp
    $backupTag = $(if ($mode -eq 'reset') { '维护' } else { '卸载' })
    $backupDir = Join-Path $backupRoot ('PM工作台-' + $backupTag + '-' + $stamp)
    $result.backupDir = $backupDir

    $phrase = if ($mode -eq 'reset') { '重置' } else { '彻底卸载' }
    if ($NoBackup -or $Purge) { $phrase = $phrase + '-无备份' }
    $result.confirmExpected = $phrase
    if ($DryRun) { $result.dryRun = $true }
    $result.confirmOk = ($Confirm -eq $phrase)

    Write-MaintLine ''
    $modeTitle = $(if ($mode -eq 'reset') { '一键重置' } else { '彻底卸载' })
    Write-MaintLine ('==================== PM工作台 · ' + $modeTitle + ' ====================') 'Cyan'
    Write-MaintLine ('  安装目录：' + $root)
    Write-MaintLine ('  备份目录：' + $backupDir)
    Write-MaintLine ('  模式：' + $mode + '（dryRun=' + [bool]$DryRun + '，sandbox=' + [bool]$Sandbox + '）')

    if (($DoReset -and $DoUninstall) -or ($KeepData -and $Purge) -or ($KeepData -and $DoReset) -or ($Purge -and $DoReset)) {
        $result.code = 'BAD_ARGS'; $result.message = '-Reset/-Uninstall、-KeepData/-Purge 互斥'
        Write-MaintLine ('  [维护被拒] BAD_ARGS：' + $result.message) 'Red'
        if ($Json) { Write-Host ('AWB_MAINT_JSON:' + ($result | ConvertTo-Json -Depth 6 -Compress)) }
        return 2
    }

    if (-not (Enter-MaintLock $root)) {
        Exit-MaintLock
        $result.code = 'LOCK_HELD'; $result.message = '另一个维护进程正在执行（.awb-maint.lock）'
        Write-MaintLine ('  [维护被拒] LOCK_HELD：' + $result.message) 'Red'
        if ($Json) { Write-Host ('AWB_MAINT_JSON:' + ($result | ConvertTo-Json -Depth 6 -Compress)) }
        return 2
    }

    try {
        # ① 只读扫描清单
        $items = @()
        if ($mode -eq 'reset') {
            $items = Get-MaintResetItems -Root $root -KeepBackups:([bool]$KeepBackups)
        } elseif ($KeepData) {
            $items = Get-MaintUninstallProgramItems -Root $root -KeepData $true -KeepBackups:([bool]$KeepBackups)
        } else {
            $items = Get-MaintUninstallProgramItems -Root $root -KeepData $false -KeepBackups:([bool]$KeepBackups)
            if (-not $Purge) {
                $items += New-MaintItem 'root' 'delete' $root
            } else {
                $items += New-MaintItem 'root' 'delete' $root
            }
        }
        if ($env:AWB_MAINT_TEST_BAD_PATH) { $items += New-MaintItem 'data' 'delete' ([string]$env:AWB_MAINT_TEST_BAD_PATH) }
        $items += Get-MaintSystemItems -Root $root -ShortcutDir $ShortcutDir -LocalAppDataDir $LocalAppDataDir -TempDir $TempDir -DshHome $DshHome -GitHubFixHostsPath $GitHubFixHostsPath -Sandbox $Sandbox

        # 路径白名单
        $allowed = @($root, ($root.TrimEnd('\') + '-maint-backup'), $backupRoot, $TempDir, $LocalAppDataDir, $ShortcutDir, $DshHome, $GitHubFixHostsPath)
        $allowed += (Join-Path $env:SystemRoot 'System32\drivers\etc\hosts')
        if (-not $TempDir) { $allowed += [System.IO.Path]::GetTempPath() }
        if (-not $LocalAppDataDir) { $allowed += $env:LOCALAPPDATA }
        if (-not $DshHome) { $allowed += (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh') }
        $bad = @()
        foreach ($item in $items) {
            if ($item.action -ne 'delete') { continue }
            if ($item.category -in @('env', 'task', 'startup')) { continue }
            if ($item.path -eq $root) { continue }
            if (-not (Test-MaintAllowedPath -Path $item.path -AllowedRoots $allowed)) {
                $item.result = 'failed'; $item.code = 'PATH_NOT_ALLOWED'; $bad += $item.path
            }
        }
        if ($bad.Count) {
            $result.items = $items; $result.code = 'PATH_NOT_ALLOWED'; $result.message = '越界路径：' + (($bad | Select-Object -First 3) -join '；')
            $result.dryRun = $true
            Write-MaintLine ('  [维护被拒] PATH_NOT_ALLOWED：' + $result.message) 'Red'
            if ($Json) { Write-Host ('AWB_MAINT_JSON:' + ($result | ConvertTo-Json -Depth 6 -Compress)) }
            return 2
        }

        # ② dry-run / 确认短语
        $deletable = @($items | Where-Object { $_.action -eq 'delete' })
        $deleteCount = @($deletable | Where-Object { $_.existed }).Count
        Write-MaintLine ('  清单：' + $items.Count + ' 项（待删 ' + $deleteCount + ' 项，保留 ' + (@($items | Where-Object { $_.action -eq 'keep' }).Count) + ' 项）') 'DarkGray'
        foreach ($item in $deletable) {
            $mark = if ($item.existed) { '存在' } else { '已无' }
            Write-MaintLine ('    [' + $item.category + '] ' + $item.action + ' ' + $item.path + '（' + $mark + '）') 'DarkGray'
        }
        if ($DryRun -or -not $Yes) {
            $result.dryRun = $true
            $result.items = $items
            $result.code = ''
            $result.message = 'dry-run：仅清单，未删除任何文件；确认短语：' + $phrase
            if ($Json) { Write-Host ('AWB_MAINT_JSON:' + ($result | ConvertTo-Json -Depth 6 -Compress)) }
            Write-MaintLine ''
            Write-MaintLine ('  [干跑] 未删除任何文件。确认执行请加 -Yes -Confirm "' + $phrase + '"') 'Yellow'
            return 0
        }
        if (-not $result.confirmOk) {
            $result.items = $items; $result.code = 'CONFIRM_MISMATCH'; $result.message = '确认短语不符（需要：' + $phrase + '）'
            Write-MaintLine ('  [维护被拒] CONFIRM_MISMATCH：' + $result.message) 'Red'
            if ($Json) { Write-Host ('AWB_MAINT_JSON:' + ($result | ConvertTo-Json -Depth 6 -Compress)) }
            return 2
        }

        # ③ 备份（重置：状态/看板/workbench；卸载：项目/团队产出/团队状态）
        if (-not ($DryRun)) {
            $backup = Invoke-MaintBackup -Mode $mode -Root $root -BackupDir $backupDir -IncludeProjects ([bool]$IncludeProjects) -NoBackup:([bool]$NoBackup -or [bool]$Purge)
            if (-not $backup.ok) {
                $result.items = $items; $result.code = 'BACKUP_FAILED'; $result.message = '备份失败（未删除任何文件）：' + $backup.note
                Write-MaintLine ('  [维护被拒] BACKUP_FAILED：' + $backup.note) 'Red'
                if ($Json) { Write-Host ('AWB_MAINT_JSON:' + ($result | ConvertTo-Json -Depth 6 -Compress)) }
                return 2
            }
            $result.backupZip = $backup.zip
        }

        # ④ 占用检测（只认命令行含本安装目录的 electron）
        $running = Get-MaintOwnProcesses -Root $root
        if ($running.Count -and -not $KillOwn) {
            $result.code = 'APP_RUNNING'; $result.message = ('检测到本安装的 Electron 在运行（PID ' + (($running | ForEach-Object { $_.pid }) -join ',') + '）；先退出或加 -KillOwn')
            $result.items = $items
            Write-MaintLine ('  [维护被拒] APP_RUNNING：' + $result.message) 'Red'
            if ($Json) { Write-Host ('AWB_MAINT_JSON:' + ($result | ConvertTo-Json -Depth 6 -Compress)) }
            return 2
        }
        if ($running.Count -and $KillOwn) {
            foreach ($proc in $running) {
                try { taskkill /PID ([string]$proc.pid) /T /F | Out-Null; $result.items += [ordered]@{ category = 'process'; action = 'kill'; path = [string]$proc.pid; existed = $true; bytes = 0; sha256_12 = ''; result = 'killed' } } catch { }
            }
        }

        # ⑤ 执行删除（单项失败不中断）
        $failed = @()
        foreach ($item in $items) {
            if ($item.action -eq 'keep') { continue }
            if ($item.result -eq 'skipped_sandbox') { continue }
            if ($item.result -eq 'failed') { $failed += $item; continue }
            if ($item.action -eq 'delete' -and $item.category -in @('env', 'task', 'startup', 'hosts', 'dsh', 'shortcut')) {
                # 系统级 CAS 留给下面的专用处理
                continue
            }
            # APP_DATA_LOCKED：目标目录被进程占用（命令行含目录）→ 不删、记 failed+code+PID
            if ($item.category -in @('data', 'appdata', 'team', 'selfcheck', 'backup') -and (Test-Path -LiteralPath $item.path -PathType Container)) {
                $holders = Test-MaintDirLocked -Path $item.path
                if ($holders) {
                    $item.result = 'failed'
                    $item.code = 'APP_DATA_LOCKED'
                    $item.reason = '目标目录被占用（PID ' + (($holders | ForEach-Object { $_.pid }) -join ',') + '）；退出占用进程后重跑，或手动删除'
                    $failed += $item
                    continue
                }
            }
            $r = Remove-MaintTarget -Path $item.path
            $item.result = $r.result
            if ($r.reason) { $item.reason = $r.reason }
            if ($r.result -eq 'failed') { $failed += $item }
        }
        # 团队/看板 与 program/data 项已在上面循环处理；Root 整删放最后
        $rootItem = $items | Where-Object { $_.category -eq 'root' } | Select-Object -First 1
        if ($rootItem) {
            # 锁文件在 Root 内且以 FileShare.None 打开，Windows 会拒绝删除整个目录 → 先释放
            Exit-MaintLock
            $r = Remove-MaintTarget -Path $rootItem.path
            $rootItem.result = $r.result
            if ($r.reason) { $rootItem.reason = $r.reason }
            if ($r.result -eq 'failed') { $failed += $rootItem }
        }

        # ⑥ 系统级六类（沙盘只计划）
        if (-not $Sandbox) {
            $failed += Invoke-MaintSystemApply -Items $items
        } else {
            $result.needsDshRestart = $false
        }

        # ⑦ 判定
        $remaining = @($items | Where-Object { $_.action -eq 'delete' -and $_.result -notin @('deleted', 'already', 'skipped', 'skipped_sandbox') })
        $result.items = $items
        $result.partial = ($failed.Count -gt 0)
        $result.verdict = if ($remaining.Count -eq 0) { 'CLEAN' } else { 'RESIDUE' }
        $result.userDataDeleted = [bool]($Purge -or (-not $KeepData -and $mode -eq 'uninstall'))
        $result.code = if ($result.partial) { 'PARTIAL' } else { 'OK' }
        $result.message = if ($result.verdict -eq 'CLEAN') { '完成（判定：干净）' } else { ('完成但仍有残留 ' + $remaining.Count + ' 项') }

        # ⑧ 清单落盘
        try {
            New-Item -ItemType Directory -Force -Path $backupDir -ErrorAction Stop | Out-Null
            $manifestFile = Join-Path $backupDir 'maint.json'
            [System.IO.File]::WriteAllText($manifestFile, ($result | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
            $result.manifestFile = $manifestFile
        } catch { }

        if ($Json) { Write-Host ('AWB_MAINT_JSON:' + ($result | ConvertTo-Json -Depth 8 -Compress)) }
        Write-MaintLine ''
        $resultColor = $(if ($result.verdict -eq 'CLEAN') { 'Green' } else { 'Yellow' })
        Write-MaintLine ('  结果：' + $result.message) $resultColor
        Write-MaintLine ('  判定：' + $result.verdict + '；清单：' + $backupDir) 'DarkGray'
        return $(if ($result.verdict -eq 'CLEAN') { 0 } else { 2 })
    } finally {
        Exit-MaintLock
    }
}

# B-20261119-221506-3a6dbe：APP_DATA_LOCKED —— 目标目录若被进程占用（判定=进程命令行含该目录，与 electron 同口径），
# 不执行删除并记 failed+code+PID；调用方据此判 RESIDUE（不静默跳过）。
function Get-MaintPathHolders {
    param([string]$Path)
    $out = @()
    try {
        foreach ($pr in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
            $cmd = [string]$pr.CommandLine
            if ($cmd -and $cmd.IndexOf($Path, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                $out += [pscustomobject]@{ pid = [int]$pr.ProcessId; name = [string]$pr.Name }
            }
        }
    } catch { }
    return $out
}

function Test-MaintDirLocked {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $null }
    $holders = @(Get-MaintPathHolders -Path $Path)
    if (-not $holders.Count) { return $null }
    return $holders
}

# 系统级六类：CAS 检查后再删（沙盘不进这里）
function Invoke-MaintSystemApply {
    param($Items)
    $failed = @()
    foreach ($item in $Items) {
        if ($item.action -ne 'delete' -or $item.category -notin @('shortcut', 'env', 'hosts', 'task', 'startup', 'dsh', 'appdata')) { continue }
        if ($item.result -eq 'skipped_sandbox' -or $item.result -eq 'skipped') { continue }
        try {
            switch ($item.category) {
                'shortcut' { if (Test-Path -LiteralPath $item.path) { Remove-Item -LiteralPath $item.path -Force; $item.result = 'deleted' } else { $item.result = 'already' } }
                'env' {
                    if ($item.existed) {
                        $userValue = [Environment]::GetEnvironmentVariable($item.path, 'User')
                        if ($userValue -and ($userValue.TrimEnd('\').ToLower() -eq $script:MaintRoot.TrimEnd('\').ToLower() -or $userValue.StartsWith($script:MaintRoot, [System.StringComparison]::OrdinalIgnoreCase))) {
                            [Environment]::SetEnvironmentVariable($item.path, $null, 'User'); $item.result = 'deleted'
                        } else { $item.result = 'skipped'; $item.code = 'ENV_POINTS_OTHER_INSTALL' }
                    } else { $item.result = 'already' }
                }
                'appdata' { $r = Remove-MaintTarget -Path $item.path; $item.result = $r.result }
                'hosts' {
                    if (-not $item.existed) { $item.result = 'already' }
                    else {
                        $isAdmin = $false
                        try { $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { }
                        if (-not $isAdmin -and -not $env:AWB_MAINT_ALLOW_HOSTS) {
                            # 非管理员：明确给 HOSTS_NEED_ADMIN + 提权指引（不尝试写，避免误报 SYS_ITEM_FAILED）
                            $item.result = 'failed'; $item.code = 'HOSTS_NEED_ADMIN'
                            $item.reason = '需要管理员权限：请用「以管理员身份运行」重跑，或手动删除 hosts 中 # >>> PMWorkbench GitHubFix >>> 段'
                            Write-MaintLine ('  [需权限] HOSTS_NEED_ADMIN：' + $item.reason) 'Yellow'
                            continue
                        }
                        $hostsFile = $item.path
                        $text = [System.IO.File]::ReadAllText($hostsFile, [System.Text.Encoding]::UTF8)
                        $pat = '(?ms)^# >>> PMWorkbench GitHubFix >>>.*?^# <<< PMWorkbench GitHubFix <<<[^\r\n]*\r?\n?'
                        $new = [regex]::Replace($text, $pat, '')
                        $bak = $hostsFile + '.bak-' + (Get-UpgradeStamp)
                        Copy-Item -LiteralPath $hostsFile -Destination $bak -Force
                        [System.IO.File]::WriteAllText($hostsFile, $new, (New-Object System.Text.UTF8Encoding($false)))
                        $item.result = 'deleted'
                    }
                }
                'task' {
                    if ($item.existed) {
                        try { Unregister-ScheduledTask -TaskName $item.path -Confirm:$false -ErrorAction Stop; $item.result = 'deleted' }
                        catch { $item.result = 'failed'; $item.code = 'TASK_NEED_ADMIN' }
                    } else { $item.result = 'already' }
                }
                'startup' {
                    try {
                        Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'PM工作台' -ErrorAction SilentlyContinue
                        $item.result = 'deleted'
                    } catch { $item.result = 'failed'; $item.code = 'ENV_WRITE_DENIED' }
                }
                'dsh' {
                    if (-not $item.existed) { $item.result = 'already' }
                    else {
                        $pkgFile = $item.path
                        $text = [System.IO.File]::ReadAllText($pkgFile, [System.Text.Encoding]::UTF8)
                        $obj = $text | ConvertFrom-Json
                        $changed = $false
                        if ($obj.bundles) {
                            $keep = @($obj.bundles | Where-Object { [string]$_ -notmatch 'pm-workbench-dsh|dsh-agile-workbench' })
                            if ($keep.Count -ne @($obj.bundles).Count) { $obj.bundles = $keep; $changed = $true }
                        }
                        if ($obj.dependencies) {
                            foreach ($name in @($obj.dependencies.PSObject.Properties.Name)) {
                                if ($name -match 'pm-workbench-dsh|dsh-agile-workbench') { $obj.dependencies.PSObject.Properties.Remove($name); $changed = $true }
                            }
                        }
                        if ($changed) {
                            $bak = $pkgFile + '.bak-uninstall-' + (Get-UpgradeStamp)
                            Copy-Item -LiteralPath $pkgFile -Destination $bak -Force
                            [System.IO.File]::WriteAllText($pkgFile, ($obj | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
                            $item.result = 'deleted'
                        } else { $item.result = 'already'; $item.code = 'DSH_NOT_REGISTERED' }
                    }
                }
            }
        } catch {
            $item.result = 'failed'
            if (-not $item.code) { $item.code = 'SYS_ITEM_FAILED' }
        }
        if ($item.result -eq 'failed') { $failed += $item }
    }
    return $failed
}


# ── R-2de7：-Reset / -Uninstall 走维护分支（不进安装主流程）────────────────────
if ($Reset -or $Uninstall) {
    $maintExit = Invoke-MaintMode -DoReset ([bool]$Reset) -DoUninstall ([bool]$Uninstall) -Purge ([bool]$Purge) -KeepData ([bool]$KeepData) -KeepBackups ([bool]$KeepBackups) -DryRun ([bool]$DryRun) -Yes ([bool]$Yes) -Confirm $Confirm -BackupTo $BackupTo -IncludeProjects ([bool]$BackupProjects) -NoBackup ([bool]$NoBackup) -NoLaunch ([bool]$NoLaunch) -Json ([bool]$Json) -Sandbox ([bool]$Sandbox) -KillOwn ([bool]$KillOwn) -Force ([bool]$Force) -DshHome $DshHome -LocalAppDataDir $LocalAppDataDir -TempDir $TempDir -ShortcutDir $ShortcutDir -InstallDir $InstallDir -GitHubFixHostsPath $GitHubFixHostsPath
    if ($script:LogFile) { Write-Host "日志：$($script:LogFile)" -ForegroundColor DarkGray }
    exit $maintExit
}

# ── e610：-Upgrade / -UpgradeRollback 走独立分支（不进安装主流程）─────────────
if ($Upgrade -or $UpgradeRollback) {
    # 目标目录优先级：-InstallDir > 本脚本所在目录 > 当前目录。
    # （只信 cwd 会误伤：从别的目录调用沙盘里的 install.ps1 时会把「当前仓库」当成升级目标。）
    $upgradeRepo = $null
    $scriptRoot = $null
    if ($PSCommandPath) { $scriptRoot = Split-Path -Parent $PSCommandPath }
    if ($InstallDir -and (Test-Path -LiteralPath $InstallDir) -and (Test-RepoRoot $InstallDir)) {
        $upgradeRepo = (Resolve-Path -LiteralPath $InstallDir).Path
    } elseif ($scriptRoot -and (Test-RepoRoot $scriptRoot)) {
        $upgradeRepo = $scriptRoot
    } elseif ($cwdIsRepo) {
        $upgradeRepo = $cwd
    }
    if (-not $upgradeRepo) {
        Write-Host ''
        Write-Host '  [升级失败] UPGRADE_NOT_INSTALLED：当前目录不是 PM工作台（缺 package.json/start.cmd/src\main.js）' -ForegroundColor Red
        Write-Host '  请在安装目录运行，或加 -InstallDir "E:\PM工作台"' -ForegroundColor Yellow
        if ($script:LogFile) { Write-Host "日志：$($script:LogFile)" -ForegroundColor DarkGray }
        exit 2
    }
    $upgradeData = $UpgradeDataDir
    if (-not $upgradeData) {
        if ($env:AWB_DATA_DIR) { $upgradeData = $env:AWB_DATA_DIR } else { $upgradeData = Join-Path $upgradeRepo 'data' }
    }
    $upgradeExit = 0
    if ($UpgradeRollback) {
        $upgradeExit = Invoke-UpgradeRollbackMode -RepoRoot $upgradeRepo -BackupDir $UpgradeRollback -DataDir $upgradeData
    } else {
        $upgradeExit = Invoke-UpgradeMode -RepoRoot $upgradeRepo -DataDir $upgradeData -Feed $UpgradeFeed -Version $UpgradeVersion -Sha256 $UpgradeSha256 -Url $UpgradeUrl -DryRun ([bool]$UpgradeDryRun) -Force ([bool]$UpgradeForce) -Reason $UpgradeReason
    }
    if ($script:LogFile) { Write-Host "日志：$($script:LogFile)" -ForegroundColor DarkGray }
    exit $upgradeExit
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor DarkCyan
Write-Host '  PM工作台 · Windows 一键安装' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor DarkCyan
if ($PSCommandPath) {
    Write-Host "  安装器：$PSCommandPath"
} else {
    Write-Host '  安装器：GitHub 一行命令'
}
Write-Host "  系统：$([Environment]::OSVersion.VersionString)；PowerShell $($PSVersionTable.PSVersion)"
if ($script:LogFile) {
    Write-Host "  日志：$($script:LogFile)" -ForegroundColor DarkGray
} else {
    Write-Host '  日志：未能写入（请保留本窗口输出）' -ForegroundColor Yellow
}

try {
    Write-Step 1 '定位 PM工作台 目录'
    if ($cwdIsRepo) {
        $script:RepoRoot = $cwd
        $script:RepoReady = $true
        $script:InstallMode = 'existing'
        Write-Host "  当前目录就是仓库，直接使用：$cwd"
        Write-Host '  不下载、不覆盖已有文件。'
        if ($InstallDir) {
            Write-InstallerLog 'WARN' "当前目录已是仓库，已忽略 -InstallDir：$InstallDir"
        }
    } else {
        if ($InstallDir) {
            $target = [System.IO.Path]::GetFullPath($InstallDir)
        } else {
            $target = $null
            if (Test-Path -LiteralPath 'D:\') {
                # 已经装过 D:\PM工作台 就直接复用；否则先确认 D 盘根目录可写。
                if ((Test-Path -LiteralPath 'D:\PM工作台') -or (Test-DirectoryWritable -Directory 'D:\')) {
                    $target = 'D:\PM工作台'
                } else {
                    Write-InstallerLog 'WARN' 'D 盘不可写，改用用户目录。'
                }
            }
            if (-not $target) {
                $userProfileDir = [Environment]::GetFolderPath('UserProfile')
                if (-not $userProfileDir) { $userProfileDir = $env:USERPROFILE }
                if (-not $userProfileDir) {
                    throw '无法确定用户目录，请用 -InstallDir 指定安装位置。'
                }
                $target = Join-Path $userProfileDir 'PM工作台'
            }
        }

        $script:TargetPath = $target
        Write-Host "  目标目录：$target"

        if (Test-Path -LiteralPath $target) {
            if (-not (Test-Path -LiteralPath $target -PathType Container)) {
                throw "目标路径已存在且不是目录：$target"
            }
            if (Test-RepoRoot $target) {
                $script:RepoRoot = $target
                $script:RepoReady = $true
                $script:InstallMode = 'reuse'
                Write-InstallerLog 'OK' "目标目录已是 PM工作台，直接复用：$target"
            } else {
                $existingItems = @(Get-ChildItem -LiteralPath $target -Force)
                if ($existingItems.Count -gt 0) {
                    throw ((@(
                        '目标目录已存在且不是 PM工作台，安装停止，绝不覆盖已有文件：'
                        "  $target"
                        '请换一个安装位置，例如：'
                        '  安装PM工作台.cmd -InstallDir "E:\PM工作台"'
                        '或先手动备份/移走该目录再重试。'
                    ) -join [Environment]::NewLine))
                }
                Write-InstallerLog 'INFO' "目标目录已存在但为空，继续安装：$target"
            }
        } else {
            try {
                New-Item -ItemType Directory -Force -Path $target -ErrorAction Stop | Out-Null
            } catch {
                throw ((@(
                    "无法创建安装目录：$target"
                    "  $($_.Exception.Message)"
                    '可换一个你有写权限的位置：'
                    '  安装PM工作台.cmd -InstallDir "E:\PM工作台"'
                ) -join [Environment]::NewLine))
            }
            $script:CreatedTarget = $true
            $script:InstallMode = 'download'
            Write-InstallerLog 'OK' "已创建安装目录：$target"
        }

        $script:TargetPath = $target
        if (-not (Test-DirectoryWritable -Directory $target)) {
            throw ((@(
                "安装目录不可写：$target"
                '请换一个你有写权限的位置，例如：'
                '  安装PM工作台.cmd -InstallDir "E:\PM工作台"'
            ) -join [Environment]::NewLine))
        }
    }

    Write-Step 2 '检查系统环境'
    $tools = Test-Prerequisites

    Write-Step 3 '准备源码'
    if ($script:RepoRoot) {
        Write-Host '  已就绪：使用现有的 PM工作台 仓库，不重新下载。'
    } else {
        $tempZip = $null
        $zipFile = $null
        try {
            if ($ZipPath) {
                $resolved = Resolve-Path -LiteralPath $ZipPath -ErrorAction Stop
                $zipFile = $resolved.Path
                if (-not (Test-Path -LiteralPath $zipFile -PathType Leaf)) {
                    throw "本地压缩包不是文件：$zipFile"
                }
                Write-InstallerLog 'OK' "使用本地压缩包：$zipFile"
            } else {
                $tempZip = Join-Path ([System.IO.Path]::GetTempPath()) ('pm-workbench-main-' + [Guid]::NewGuid().ToString('N') + '.zip')
                try {
                    [void](Invoke-GitHubFixedDownload -Url $ZipUrl -Destination $tempZip -Attempts 3 -Label '仓库 zip')
                } catch {
                    throw ((@(
                        '下载 GitHub 压缩包失败：'
                        "  $($_.Exception.Message)"
                        '请检查网络后重试，或手动下载后使用本地 zip：'
                        "  $($script:DefaultRepoZipUrl)"
                        '  安装PM工作台.cmd -ZipPath "C:\Download\agile-workbench-main.zip"'
                    ) -join [Environment]::NewLine))
                }
                $zipFile = $tempZip
            }

            Write-Host "  正在解压到：$($script:TargetPath)"
            Expand-RepoZip -ZipFile $zipFile -Target $script:TargetPath
            if (-not (Test-RepoRoot $script:TargetPath)) {
                throw '解压完成，但没有找到完整的仓库文件（package.json / start.cmd / src\main.js）。'
            }
            $script:RepoRoot = $script:TargetPath
            $script:RepoReady = $true
            Write-InstallerLog 'OK' "源码就绪：$($script:RepoRoot)"
        } finally {
            if ($tempZip -and (Test-Path -LiteralPath $tempZip)) {
                Remove-Item -LiteralPath $tempZip -Force -ErrorAction SilentlyContinue
            }
        }
    }

    Write-Step 4 '准备 Node.js 运行时'
    $nodeRuntime = Initialize-NodeRuntime -RepoRoot $script:RepoRoot -SystemNode $tools.SystemNode
    $script:NodeRuntime = $nodeRuntime
    $tools.NodeExe = $nodeRuntime.NodeExe
    $tools.NpmExe = $nodeRuntime.NpmExe
    $tools.NodeVersion = $nodeRuntime.NodeVersion
    $tools.NpmVersion = $nodeRuntime.NpmVersion
    $tools.NodeSource = $nodeRuntime.Source
    if ($nodeRuntime.Source -eq 'system') {
        Write-Host "  Node.js：$($nodeRuntime.NodeVersion)（使用系统 Node，不下载）"
    } else {
        Write-Host "  Node.js：$($nodeRuntime.NodeVersion)（便携版：$($nodeRuntime.Root)）"
        Write-Host '  只在本次安装进程内临时加入 PATH，不写系统 PATH、不改系统环境。'
    }

    # e379：把团队目录写进用户环境变量，供 DSH 套装插件解析 teamRoot（bundle 里不再写死作者机器路径）。
    try {
        $teamRootForDsh = Join-Path $repoRoot '团队'
        if (Test-Path -LiteralPath $teamRootForDsh) {
            [Environment]::SetEnvironmentVariable('AWB_TEAM_ROOT', $teamRootForDsh, 'User')
            Write-InstallerLog 'OK' "已写用户环境变量 AWB_TEAM_ROOT=$teamRootForDsh（供 DSH 套装解析团队目录）"
        } else {
            Write-InstallerLog 'WARN' "团队目录不存在，未写 AWB_TEAM_ROOT：$teamRootForDsh"
        }
    } catch {
        Write-InstallerLog 'WARN' "写 AWB_TEAM_ROOT 失败（不影响工作台本体）：$($_.Exception.Message)"
    }
    # P1-3（B-20261119-123400-c437）：把安装目录写进用户环境变量，启动器优先用它定位本体（与安装器默认对齐）。
    try {
        [Environment]::SetEnvironmentVariable('PM_WORKBENCH_HOME', $repoRoot, 'User')
        Write-InstallerLog 'OK' "已写用户环境变量 PM_WORKBENCH_HOME=$repoRoot（启动器优先使用；运行期解析，无需重启 DSH 记录）"
    } catch {
        Write-InstallerLog 'WARN' "写 PM_WORKBENCH_HOME 失败（不影响启动器从默认目录发现本体）：$($_.Exception.Message)"
    }

    Write-Step 5 '安装依赖（npm install）'
    $repoRoot = $script:RepoRoot
    # e379：Electron 二进制默认从 GitHub 下载，国内网络常 10 分钟以上无任何输出。
    # 默认走 npmmirror 镜像（可用 ELECTRON_MIRROR 覆盖）；失败再用 GitHub 重试一次。
    $mirrorDisabled = ($env:AWB_NO_MIRROR -eq '1')
    if ($mirrorDisabled) {
        # e379 返工②：AWB_NO_MIRROR=1 关闭镜像（需求 §6.1.3）——不再默认写 ELECTRON_MIRROR，直连 GitHub。
        Write-InstallerLog 'INFO' 'AWB_NO_MIRROR=1：已关闭 Electron 下载镜像（默认不写 ELECTRON_MIRROR）'
        if ($env:ELECTRON_MIRROR) {
            Write-Host "  Electron 下载镜像：已按 AWB_NO_MIRROR=1 关闭（显式 ELECTRON_MIRROR 仍生效：$env:ELECTRON_MIRROR）"
        } else {
            Write-Host '  Electron 下载镜像：已按 AWB_NO_MIRROR=1 关闭（直连 GitHub，可能较慢）'
        }
    } elseif (-not $env:ELECTRON_MIRROR) {
        $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
        Write-Host '  Electron 下载镜像：npmmirror（设置 ELECTRON_MIRROR 可覆盖；AWB_NO_MIRROR=1 关闭镜像）'
    } else {
        Write-Host "  Electron 下载镜像：$env:ELECTRON_MIRROR"
    }
    # e379：快捷方式与安装预检提前到依赖安装之前——Electron 下载失败时用户也能看到入口并重跑安装器。
    if (-not $NoShortcut) {
        try {
            $earlyDesktop = $ShortcutDir
            if (-not $earlyDesktop) { $earlyDesktop = [Environment]::GetFolderPath('Desktop') }
            if ($earlyDesktop) {
                $earlyLaunch = Join-Path $repoRoot 'launch.vbs'
                $earlyWscript = Join-Path $env:WINDIR 'System32\wscript.exe'
                if ((Test-Path -LiteralPath $earlyLaunch) -and (Test-Path -LiteralPath $earlyWscript)) {
                    $earlyFile = Join-Path $earlyDesktop 'PM工作台.lnk'
                    $earlyShell = New-Object -ComObject WScript.Shell
                    try {
                        $earlySc = $earlyShell.CreateShortcut($earlyFile)
                        $earlySc.TargetPath = $earlyWscript
                        $earlySc.Arguments = '"' + $earlyLaunch + '"'
                        $earlySc.WorkingDirectory = $repoRoot
                        $earlySc.Description = 'PM工作台（PM Workbench）'
                        $earlyIcon = Join-Path $repoRoot 'assets\pm-workbench.ico'
                        if (Test-Path -LiteralPath $earlyIcon) { $earlySc.IconLocation = "$earlyIcon,0" }
                        $earlySc.Save()
                        $script:ShortcutPath = $earlyFile
                        Write-InstallerLog 'OK' '已在安装依赖前提前创建桌面快捷方式（失败也可用 start.cmd 启动）'
                    } finally {
                        if ($earlySc) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($earlySc) }
                        if ($earlyShell) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($earlyShell) }
                    }
                }
            }
        } catch { Write-InstallerLog 'WARN' "提前创建快捷方式失败（不阻断安装）：$($_.Exception.Message)" }
    }
    try {
        $checkCmd = Join-Path $repoRoot 'start.cmd'
        if (Test-Path -LiteralPath $checkCmd) {
            Write-Host '  预检：start.cmd --check（依赖未装完时提示缺失属正常，装完会再验证一次）'
            $checkText = (& cmd.exe /c ('"' + $checkCmd + '" --check')) 2>&1
            ($checkText | Select-Object -Last 6) | ForEach-Object { Write-Host "    $_" }
        }
    } catch { Write-InstallerLog 'WARN' "安装预检失败（不阻断安装）：$($_.Exception.Message)" }
    $repoRoot = $script:RepoRoot
    Write-Host "  目录：$repoRoot"
    Write-Host '  首次安装会下载 Electron，可能需要几分钟，请保持网络畅通。'
    $previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
    $previousNoColor = $env:NO_COLOR
    $previousPath = $env:PATH
    $nodeRuntimeDir = Split-Path -Parent $tools.NodeExe
    $npmExit = 1
    try {
        Remove-Item -Path Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        $env:NO_COLOR = '1'
        if ($previousPath) {
            $env:PATH = "$nodeRuntimeDir;$previousPath"
        } else {
            $env:PATH = $nodeRuntimeDir
        }
        # P0-1（B-20261119-123400-c437）：npm 11+ 默认不执行 electron 的 postinstall，先显式授权；
        # 旧 npm 没有 install-scripts 子命令，失败只记 WARN 不阻断。
        try {
            $approveOut = & $tools.NpmExe 'install-scripts' 'approve' 'electron' '-a' 2>&1
            $approveText = [string]($approveOut | Out-String)
            if ($approveText -match 'Not a valid npm|Unknown command|ERR!') {
                Write-InstallerLog 'WARN' '当前 npm 不支持 install-scripts approve（旧版本，忽略）'
            } else {
                Write-InstallerLog 'OK' 'npm 11 install-scripts：已授权 electron postinstall'
            }
        } catch {
            Write-InstallerLog 'WARN' "npm install-scripts approve 失败（忽略，继续安装）：$($_.Exception.Message)"
        }
        $npmExit = Invoke-LoggedCommand -Exe $tools.NpmExe -Arguments @('install', '--no-audit', '--no-fund', '--no-color') -WorkingDirectory $repoRoot -ProgressSeconds 5 -PhaseName 'npm install（依赖 + Electron）'
        if ($npmExit -ne 0 -and -not $mirrorDisabled -and $env:ELECTRON_MIRROR -like '*npmmirror*') {
            # e379：镜像不可用时回退官方源再试一次，避免一次网络抖动就整机装败。
            Write-InstallerLog 'WARN' "镜像源安装失败（退出码 $npmExit），改用官方源重试一次"
            $env:ELECTRON_MIRROR = ''
            $npmExit = Invoke-LoggedCommand -Exe $tools.NpmExe -Arguments @('install', '--no-audit', '--no-fund', '--no-color') -WorkingDirectory $repoRoot -ProgressSeconds 5 -PhaseName 'npm install（官方源重试）'
        }
    } finally {
        if ($null -ne $previousRunAsNode) {
            $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode
        } else {
            Remove-Item -Path Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        }
        if ($null -ne $previousNoColor) {
            $env:NO_COLOR = $previousNoColor
        } else {
            Remove-Item -Path Env:NO_COLOR -ErrorAction SilentlyContinue
        }
        if ($null -ne $previousPath) {
            $env:PATH = $previousPath
        } else {
            Remove-Item -Path Env:PATH -ErrorAction SilentlyContinue
        }
    }
    if ($npmExit -ne 0) {
        throw ((@(
            "npm install 失败（退出码 $npmExit）。"
            '常见原因：网络不通、代理/镜像未配置、Node.js 版本不匹配、目录没有写权限。'
            '可手动重试：'
            "  cd `"$repoRoot`""
            '  npm install --verbose'
        ) -join [Environment]::NewLine))
    }
    Write-InstallerLog 'OK' 'npm install 完成'

    $electronExe = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
    $electronPathTxt = Join-Path $repoRoot 'node_modules\electron\path.txt'
    $script:ElectronState = [ordered]@{
        missingReason = ''
        healed        = $false
        healReason    = ''
        cacheZip      = ''
        attempts      = 0
        distFileCount = 0
        pathTxt       = ''
    }
    $electronState = Get-ElectronDirState -RepoRoot $repoRoot
    $script:ElectronState.distFileCount = [int]$electronState.fileCount
    $script:ElectronState.pathTxt = [string]$electronState.pathTxt
    if ((Test-Path -LiteralPath $electronExe) -and (Test-Path -LiteralPath $electronPathTxt)) {
        Write-InstallerLog 'OK' 'Electron 已就位（electron.exe + path.txt 都在）'
    } else {
        # P0-1：npm 11 拦下 postinstall 时 dist 里只有 LICENSES；先判断是不是 install-scripts 拦截，
        # 再从缓存 zip 自愈（不联网、不重新下载），自愈失败才按真实原因报错。
        Write-InstallerLog 'WARN' "Electron 不完整：exe=$electronExe pathTxt=$electronPathTxt"
        $scriptsBlocked = $false
        try {
            $lsOut = & $tools.NpmExe 'install-scripts' 'ls' 2>&1 | Out-String
            if ($lsOut -match 'electron') { $scriptsBlocked = $true }
        } catch { $scriptsBlocked = $false }
        $heal = Invoke-ElectronHeal -RepoRoot $repoRoot -CacheDir (Join-Path $env:LOCALAPPDATA 'electron\Cache')
        $script:ElectronState.healed = [bool]$heal.ok
        $script:ElectronState.healReason = [string]$heal.reason
        $script:ElectronState.cacheZip = [string]$heal.cacheZip
        $script:ElectronState.attempts = [int]$heal.attempts
        if ($heal.ok) {
            $electronState = Get-ElectronDirState -RepoRoot $repoRoot
            $script:ElectronState.distFileCount = [int]$electronState.fileCount
            $script:ElectronState.pathTxt = [string]$electronState.pathTxt
            Write-InstallerLog 'OK' ("Electron 已自愈：{0} 个文件，path.txt={1}" -f $electronState.fileCount, $electronState.pathTxt)
        } else {
            $script:ElectronState.missingReason = if ($scriptsBlocked) { 'install-scripts-blocked' } else { 'download-failed' }
            $script:ExitCode = 1
            $electronHint = @(
                'Electron 二进制没有就位，安装未完成（但其余步骤已装好）。'
                ("  原因码：{0}（npm 11 install-scripts 拦截 / 下载失败）" -f $script:ElectronState.missingReason)
                ("  自愈失败原因：{0}" -f $script:ElectronState.healReason)
                ("  目录状态：dist 存在={0}，文件数={1}，path.txt={2}" -f $electronState.distExists, $electronState.fileCount, $electronState.pathTxt)
                "  期望文件：$electronExe"
                '  可手动重试（在安装目录执行）：'
                '    npm install-scripts approve electron -a'
                '    npm install --no-audit --no-fund'
                '  或重跑 安装PM工作台.cmd（会复用本地缓存）。'
            ) -join [Environment]::NewLine
            throw $electronHint
        }
    }

    # ── e379 返工①：MCP 安全搜索自检（AC6）──────────────────────────────────
    # 失败只记 warning + 可读日志（~/.dsh/logs/mcp-<ts>.log），不阻断安装、不阻断启动。
    Write-Host ''
    Write-Host '  MCP 安全搜索自检（web-search-safe；失败只记 warning，不阻断安装）'
    $mcpSelfCheck = Join-Path $repoRoot 'scripts\mcp-selfcheck.cjs'
    $mcpDataDir = Join-Path $repoRoot 'data'
    try {
        if ((Test-Path -LiteralPath $mcpSelfCheck) -and (Test-Path -LiteralPath $tools.NodeExe)) {
            $mcpArgs = @($mcpSelfCheck, '--repo', $repoRoot, '--data', $mcpDataDir, '--timeout', '5000')
            $previousMcpEap = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                $mcpOut = & $tools.NodeExe @mcpArgs 2>&1
            } finally {
                $ErrorActionPreference = $previousMcpEap
            }
            foreach ($line in @($mcpOut)) {
                if ([string]$line -and ([string]$line).Trim().Length -gt 0) { Write-Host ('    ' + [string]$line) }
            }
            $mcpRecordFile = Join-Path $mcpDataDir 'mcp-selfcheck.json'
            if (Test-Path -LiteralPath $mcpRecordFile) {
                try {
                    $mcpRecord = [System.IO.File]::ReadAllText($mcpRecordFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
                    $script:MCP = $mcpRecord
                } catch {
                    $script:MCP = $null
                }
            }
            if ($script:MCP -and -not $script:MCP.ok) {
                Add-InstallerWarning -Code 'MCP_START_FAILED' -Message ("MCP 安全搜索自检失败（{0}）；搜索工具可能不可用，详见日志" -f ([string]$script:MCP.reason)) -LogPath ([string]$script:MCP.logPath)
            } elseif ($script:MCP -and $script:MCP.ok) {
                Write-InstallerLog 'OK' 'MCP 安全搜索自检通过（initialize 成功）'
            } else {
                Add-InstallerWarning -Code 'MCP_SELFCHECK_UNREADABLE' -Message 'MCP 自检没有产出结果文件；搜索工具可能不可用（不阻断安装）'
            }
        } else {
            Add-InstallerWarning -Code 'MCP_SELFCHECK_UNAVAILABLE' -Message '缺少 scripts/mcp-selfcheck.cjs 或 Node 运行时，未做 MCP 自检；搜索工具可能不可用（不阻断安装）'
        }
    } catch {
        Add-InstallerWarning -Code 'MCP_SELFCHECK_FAILED' -Message ("MCP 自检异常：{0}（不阻断安装）" -f $_.Exception.Message)
    }

    Write-Step 6 '创建桌面快捷方式'
    if ($NoShortcut) {
        Write-InstallerLog 'WARN' '已按 -NoShortcut 跳过桌面快捷方式'
    } else {
        $desktop = $ShortcutDir
        if (-not $desktop) { $desktop = [Environment]::GetFolderPath('Desktop') }
        if (-not $desktop) {
            $userProfileDir = [Environment]::GetFolderPath('UserProfile')
            if ($userProfileDir) { $desktop = Join-Path $userProfileDir 'Desktop' }
        }
        if (-not $desktop) {
            throw '无法确定桌面目录。可加参数 -ShortcutDir "D:\某个目录" 指定快捷方式位置。'
        }
        if (-not (Test-Path -LiteralPath $desktop -PathType Container)) {
            try {
                New-Item -ItemType Directory -Force -Path $desktop -ErrorAction Stop | Out-Null
            } catch {
                throw "无法创建快捷方式目录：$desktop（$($_.Exception.Message)）"
            }
        }

        $shortcutFile = Join-Path $desktop 'PM工作台.lnk'
        $launchScript = Join-Path $repoRoot 'launch.vbs'
        $wscriptExe = Join-Path $env:WINDIR 'System32\wscript.exe'
        $iconFile = Join-Path $repoRoot 'assets\pm-workbench.ico'
        if (-not (Test-Path -LiteralPath $launchScript)) { throw "找不到隐藏启动器：$launchScript" }
        if (-not (Test-Path -LiteralPath $wscriptExe)) { throw "找不到 wscript.exe：$wscriptExe" }

        $shell = New-Object -ComObject WScript.Shell
        try {
            $shortcut = $shell.CreateShortcut($shortcutFile)
            $shortcut.TargetPath = $wscriptExe
            $shortcut.Arguments = '"' + $launchScript + '"'
            $shortcut.WorkingDirectory = $repoRoot
            $shortcut.Description = 'PM工作台（PM Workbench）'
            if (Test-Path -LiteralPath $iconFile) {
                $shortcut.IconLocation = "$iconFile,0"
            } else {
                Write-InstallerLog 'WARN' "图标文件缺失，快捷方式将使用默认图标：$iconFile"
            }
            $shortcut.WindowStyle = 1
            $shortcut.Save()
        } finally {
            if ($shortcut) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) }
            if ($shell) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
        }

        $verifyShell = New-Object -ComObject WScript.Shell
        try {
            $verified = $verifyShell.CreateShortcut($shortcutFile)
            $actualTarget = [System.IO.Path]::GetFullPath($verified.TargetPath)
            $expectedTarget = [System.IO.Path]::GetFullPath($wscriptExe)
            if ($actualTarget -ne $expectedTarget) {
                throw "快捷方式目标不正确：$($verified.TargetPath)"
            }
            if ($verified.Arguments -notmatch [regex]::Escape($launchScript)) {
                throw "快捷方式参数不正确：$($verified.Arguments)"
            }
        } finally {
            if ($verified) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($verified) }
            [void][Runtime.InteropServices.Marshal]::ReleaseComObject($verifyShell)
        }

        $script:ShortcutPath = $shortcutFile
        Write-InstallerLog 'OK' "已创建快捷方式：$shortcutFile"
    }

    if ($Launch) {
        Write-Step 7 '启动 PM工作台'
        $launchScript = Join-Path $repoRoot 'launch.vbs'
        $wscriptExe = Join-Path $env:WINDIR 'System32\wscript.exe'
        try {
            if (-not (Test-Path -LiteralPath $launchScript)) { throw "找不到隐藏启动器：$launchScript" }
            Start-Process -FilePath $wscriptExe -ArgumentList ('"' + $launchScript + '"') -WorkingDirectory $repoRoot -WindowStyle Hidden -ErrorAction Stop
            Write-InstallerLog 'OK' '已通过隐藏启动器启动 PM工作台'
        } catch {
            $script:ExitCode = 1
            Write-InstallerLog 'FAIL' "自动启动失败：$($_.Exception.Message)"
            Write-Host '  安装已完成，但自动启动失败；请双击桌面快捷方式或手动运行 start.cmd。'
        }
    } else {
        Write-Step 7 '收尾'
    }

    # e379 返工①：安装结果文件（含 warnings[]），界面「关于 PM工作台」读它显示。
    $installResultFile = Write-InstallResult -RepoRoot $repoRoot -Ok ($script:ExitCode -eq 0) -Stage $script:Stage -Next '双击桌面「PM工作台」，或运行 start.cmd'
    if ($installResultFile) { Write-InstallerLog 'OK' ("安装结果已写：{0}" -f $installResultFile) }
    Write-Host ''
    Write-Host '  DSH 连接提示：teamRoot / PM_WORKBENCH_HOME 由插件在运行期解析；若 DSH 正在运行，请重启 DSH 后再点「打开 PM工作台」。' -ForegroundColor Yellow
    Show-Summary -RepoRoot $repoRoot -ShortcutPath $script:ShortcutPath -NodeRuntime $script:NodeRuntime
} catch {
    $script:ExitCode = 1
    $reason = $_.Exception.Message
    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Red
    Write-Host '  安装未完成' -ForegroundColor Red
    Write-Host '============================================================' -ForegroundColor Red
    Write-Host "  原因：$reason"
    Write-Host ''
    Write-Host '  怎么处理：'
    Write-Host '    1. 如果是 Node.js：检查网络/代理；也可以手动安装 Node.js 20+ 后重跑'
    Write-Host '       （安装器下次会优先使用系统 Node，不会重复下载）'
    Write-Host '    2. 如果是 npm install：检查网络，或按上面提示在仓库目录手动执行 npm install'
    Write-Host '    3. 直接重跑本安装器；已完成的步骤会自动复用'
    Write-Host '    4. 目标目录已有别的文件时，换一个位置：-InstallDir "E:\PM工作台"'
    Write-Host '    5. 把下面的日志发给作者/朋友排查'
    if ($script:LogFile) {
        Write-Host "       $($script:LogFile)" -ForegroundColor Yellow
    } else {
        Write-Host '       （日志未能写入，请截图本窗口）' -ForegroundColor Yellow
    }
    Write-InstallerLog 'FAIL' $reason
    # e379 返工①：失败也要写安装结果（含失败阶段 / 下一步 / warnings），供界面与复验读取（AC4③）。
    if ($script:RepoRoot) {
        [void](Write-InstallResult -RepoRoot $script:RepoRoot -Ok $false -Stage $script:Stage -Next '按上面的提示处理后重跑安装器（已下载产物会复用）')
    }
    Remove-IncompleteTarget
} finally {
    Write-Host ''
    if ($script:LogFile) {
        Write-Host "日志：$($script:LogFile)" -ForegroundColor DarkGray
    } else {
        Write-Host '日志：未能写入（请截图本窗口）' -ForegroundColor Yellow
    }

    $shouldPause = ($script:ExitCode -ne 0) -and
        $script:IsFileInvocation -and
        (-not $NonInteractive) -and
        (-not $env:AWB_NO_PAUSE) -and
        (-not $env:AWB_INSTALLER_FROM_CMD)
    if ($shouldPause) {
        Write-Host ''
        [void](Read-Host '按回车键关闭窗口')
    }
}

if ($script:IsFileInvocation) {
    exit $script:ExitCode
}
