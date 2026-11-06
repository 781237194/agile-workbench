<#
.SYNOPSIS
  PM工作台 Windows 一键安装器。

.DESCRIPTION
  面向从 GitHub 获取本项目的朋友：
    1. 检查 Git / Node.js / npm，缺 Node.js 或 npm 时给出下载地址并停下，不静默安装系统软件；
    2. 当前目录就是仓库时直接复用；否则下载 GitHub main 分支 zip 到 D:\PM工作台
       （没有 D 盘则 %USERPROFILE%\PM工作台），解压后使用；
    3. 执行 npm install；
    4. 创建桌面快捷方式 PM工作台.lnk，指向 start.cmd，图标 assets\pm-workbench.ico；
    5. 可选 -Launch 立即启动。

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
    [string]$InstallDir,
    [string]$ShortcutDir,
    [string]$ZipPath,
    [string]$ZipUrl = 'https://codeload.github.com/781237194/agile-workbench/zip/refs/heads/main',
    [string]$LogDir,
    [switch]$Launch,
    [switch]$NoShortcut,
    [switch]$NonInteractive,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:ExitCode = 0
$script:LogFile = $null
$script:LogDirectory = $null
$script:RepoRoot = $null
$script:TargetPath = $null
$script:ShortcutPath = $null
$script:CreatedTarget = $false
$script:RepoReady = $false
$script:InstallMode = ''
$script:TotalSteps = 6
$script:IsFileInvocation = -not [string]::IsNullOrEmpty($PSCommandPath)
$script:DefaultRepoZipUrl = 'https://github.com/781237194/agile-workbench/archive/refs/heads/main.zip'

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
  -ShortcutDir <目录>  快捷方式输出目录（默认当前用户桌面）
  -LogDir <目录>       日志目录
  -NonInteractive      不暂停，适合自动化（也可设 AWB_NO_PAUSE=1）
  -Help                显示本帮助

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

function Show-NodeHelp {
    Write-InstallerNote ''
    Write-InstallerNote '  [缺少] Node.js（必须）'
    Write-InstallerNote '  PM工作台由 Node.js + Electron 运行，要求 Node.js 20 或更高版本（安装包自带 npm）。'
    Write-InstallerNote '  下载地址（LTS，选 Windows Installer）：'
    Write-InstallerNote '    https://nodejs.org/zh-cn/download'
    Write-InstallerNote '  国内镜像：'
    Write-InstallerNote '    https://npmmirror.com/mirrors/node/'
    Write-InstallerNote '  安装时请勾选 Add to PATH，装完后重新打开本窗口再运行。'
    Write-InstallerNote '  本安装器不会自动安装任何系统软件。'
}

function Show-NodeVersionHelp {
    param([string]$Version)
    Write-InstallerNote ''
    Write-InstallerNote "  [版本过低] 当前 Node.js：$Version，要求 20 或更高。"
    Write-InstallerNote '  请安装新版 Node.js LTS（会自带 npm）：'
    Write-InstallerNote '    https://nodejs.org/zh-cn/download'
    Write-InstallerNote '  国内镜像：'
    Write-InstallerNote '    https://npmmirror.com/mirrors/node/'
    Write-InstallerNote '  装完重新打开本窗口再运行，本安装器不会自动升级系统软件。'
}

function Show-NpmHelp {
    Write-InstallerNote ''
    Write-InstallerNote '  [缺少] npm（必须，随 Node.js 一起安装）'
    Write-InstallerNote '  如果已经装了 Node.js 但仍找不到 npm：'
    Write-InstallerNote '    1. 重新运行 Node.js 安装包，确认勾选 npm；'
    Write-InstallerNote '    2. 检查 PATH 是否包含 Node.js 安装目录（默认 C:\Program Files\nodejs）；'
    Write-InstallerNote '    3. 重新打开本窗口后再运行。'
    Write-InstallerNote '  本安装器不会自动安装任何系统软件。'
}

function Show-GitOptionalHelp {
    Write-InstallerNote ''
    Write-InstallerNote '  [提示] 没有检测到 Git（可选，不影响本次安装）'
    Write-InstallerNote '  一键安装使用 GitHub 的 zip 包，不需要 Git；'
    Write-InstallerNote '  只有之后想用 git clone / git pull 更新时才需要。'
    Write-InstallerNote '  下载地址：https://git-scm.com/download/win'
    Write-InstallerNote '  继续安装。'
}

function Test-Prerequisites {
    $tools = @{
        NodeExe     = $null
        NpmExe      = $null
        GitExe      = $null
        NodeVersion = $null
        NpmVersion  = $null
        GitVersion  = $null
    }

    Write-InstallerLog 'INFO' ("系统：{0}；PowerShell {1}" -f [Environment]::OSVersion.VersionString, $PSVersionTable.PSVersion)

    $nodeExe = Get-ExecutablePath 'node'
    if (-not $nodeExe) {
        Show-NodeHelp
        Write-InstallerLog 'FAIL' '未检测到 Node.js'
        throw '缺少 Node.js（要求 20 或更高版本）'
    }
    $nodeVersion = Invoke-ToolVersion -ExePath $nodeExe -Arguments @('--version')
    if (-not $nodeVersion) {
        Show-NodeHelp
        Write-InstallerLog 'FAIL' "Node.js 无法运行：$nodeExe"
        throw "Node.js 无法运行：$nodeExe"
    }
    $nodeMajor = Get-MajorVersion $nodeVersion
    if ($nodeMajor -lt 20) {
        Show-NodeVersionHelp -Version $nodeVersion
        Write-InstallerLog 'FAIL' "Node.js 版本过低：$nodeVersion"
        throw "Node.js 版本过低：$nodeVersion（要求 20 或更高）"
    }
    $tools.NodeExe = $nodeExe
    $tools.NodeVersion = $nodeVersion
    Write-InstallerLog 'OK' "Node.js $nodeVersion（要求 20+）"

    $npmExe = Get-ExecutablePath 'npm.cmd'
    if (-not $npmExe) { $npmExe = Get-ExecutablePath 'npm' }
    if (-not $npmExe) {
        Show-NpmHelp
        Write-InstallerLog 'FAIL' '未检测到 npm'
        throw '缺少 npm（要求随 Node.js 一起安装）'
    }
    $npmVersion = Invoke-ToolVersion -ExePath $npmExe -Arguments @('--version')
    if (-not $npmVersion) {
        Show-NpmHelp
        Write-InstallerLog 'FAIL' "npm 无法运行：$npmExe"
        throw "npm 无法运行：$npmExe"
    }
    $tools.NpmExe = $npmExe
    $tools.NpmVersion = $npmVersion
    Write-InstallerLog 'OK' "npm $npmVersion"

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

function Invoke-LoggedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )
    Write-InstallerLog 'RUN' ("{0} {1}" -f (Split-Path -Leaf $Exe), ($Arguments -join ' '))
    $exit = 1
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

function Show-Summary {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [string]$ShortcutPath
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
    Write-Host '  启动方式：双击桌面「PM工作台」，或运行：'
    Write-Host "    $(Join-Path $RepoRoot 'start.cmd')"
    Write-Host ''
    Write-Host '  首次启动后：左下角配置 DSH 地址 → 新建或恢复项目。'
    Write-Host '  数据位置：<仓库>\data（重跑安装器不会覆盖项目与数据）'
    Write-InstallerLog 'OK' "安装完成：$RepoRoot"
}

function Show-Help {
    Write-Host $script:HelpText
}

# ── 主流程 ────────────────────────────────────────────────────────────────

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
    Write-Step 1 '检查运行环境'
    $tools = Test-Prerequisites

    Write-Step 2 '定位 PM工作台 目录'
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
                    Save-Download -Url $ZipUrl -Destination $tempZip
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

    Write-Step 4 '安装依赖（npm install）'
    $repoRoot = $script:RepoRoot
    Write-Host "  目录：$repoRoot"
    Write-Host '  首次安装会下载 Electron，可能需要几分钟，请保持网络畅通。'
    $previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
    $previousNoColor = $env:NO_COLOR
    $npmExit = 1
    try {
        Remove-Item -Path Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        $env:NO_COLOR = '1'
        $npmExit = Invoke-LoggedCommand -Exe $tools.NpmExe -Arguments @('install', '--no-audit', '--no-fund', '--no-color') -WorkingDirectory $repoRoot
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
    if (Test-Path -LiteralPath $electronExe) {
        Write-InstallerLog 'OK' 'Electron 已就位'
    } else {
        Write-InstallerLog 'WARN' "没有找到 Electron：$electronExe"
        Write-Host '  启动可能失败。可以先手动运行 npm install，或检查网络后重跑安装器。'
    }

    Write-Step 5 '创建桌面快捷方式'
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
        $startTarget = Join-Path $repoRoot 'start.cmd'
        $iconFile = Join-Path $repoRoot 'assets\pm-workbench.ico'

        $shell = New-Object -ComObject WScript.Shell
        try {
            $shortcut = $shell.CreateShortcut($shortcutFile)
            $shortcut.TargetPath = $startTarget
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
            if ([System.IO.Path]::GetFullPath($verified.TargetPath) -ne [System.IO.Path]::GetFullPath($startTarget)) {
                throw "快捷方式目标不正确：$($verified.TargetPath)"
            }
        } finally {
            if ($verified) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($verified) }
            [void][Runtime.InteropServices.Marshal]::ReleaseComObject($verifyShell)
        }

        $script:ShortcutPath = $shortcutFile
        Write-InstallerLog 'OK' "已创建快捷方式：$shortcutFile"
    }

    if ($Launch) {
        Write-Step 6 '启动 PM工作台'
        $startCmd = Join-Path $repoRoot 'start.cmd'
        try {
            Start-Process -FilePath $startCmd -WorkingDirectory $repoRoot -ErrorAction Stop
            Write-InstallerLog 'OK' '已启动 start.cmd（新窗口）'
        } catch {
            $script:ExitCode = 1
            Write-InstallerLog 'FAIL' "自动启动失败：$($_.Exception.Message)"
            Write-Host '  安装已完成，但自动启动失败；请双击桌面快捷方式或手动运行 start.cmd。'
        }
    } else {
        Write-Step 6 '收尾'
    }

    Show-Summary -RepoRoot $repoRoot -ShortcutPath $script:ShortcutPath
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
    Write-Host '    1. 按上面的提示补装 Node.js（20+，含 npm）或检查网络'
    Write-Host '    2. 直接重跑本安装器；已完成的步骤会自动复用'
    Write-Host '    3. 目标目录已有别的文件时，换一个位置：-InstallDir "E:\PM工作台"'
    Write-Host '    4. 把下面的日志发给作者/朋友排查'
    if ($script:LogFile) {
        Write-Host "       $($script:LogFile)" -ForegroundColor Yellow
    } else {
        Write-Host '       （日志未能写入，请截图本窗口）' -ForegroundColor Yellow
    }
    Write-InstallerLog 'FAIL' $reason
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
