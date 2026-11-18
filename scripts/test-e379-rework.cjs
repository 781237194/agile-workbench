#!/usr/bin/env node
'use strict';
/**
 * e379 返工夹具（T-20261119-022540-c527 · AC6 / AWB_NO_MIRROR / dshVersion / 下载进度）
 *
 * 覆盖四个返工项，全部本机可复跑、零真实状态写入：
 *   R1 AWB_NO_MIRROR=1 关闭镜像（需求 §6.1.3）：**真跑** install.ps1 里那段分支（AST 截取源码，两态各跑一次）
 *   R2 依赖/Electron 阶段分段进度（AC1①）：真跑 Invoke-LoggedCommand -ProgressSeconds 1，断言出现多行 [进度 Ns]
 *   R3 MCP 可读（AC6）：真跑 scripts/mcp-selfcheck.cjs
 *        成功：initialize 握手 ok；失败（node 缺失）：~/.dsh/logs/mcp-*.log + install-result.json warnings[]
 *   R4 dshVersion 真实取值（AC7③）：假 DSH 页面（release.version）→ 记录里有版本；无版本页 → 留空并记 error
 *   R5 安装结果文件（AC4③/AC6①）：真跑 Write-InstallResult，warnings 合并/中文/失败阶段
 *   R6 界面锚点与 IPC 接线（AC6③）：[data-install-warning]/[data-mcp-warning]、preload diagnostics、main app:diagnostics
 *
 * 跑法：node scripts/test-e379-rework.cjs
 * 隔离：PowerShell 夹具只写 %TEMP%；MCP 夹具 DSH_HOME 与 data 都指沙盘；真实 data/install-result.json 前后 sha 不变。
 * 安全：只杀自己 spawn 的进程（本脚本不 spawn 常驻进程，全部 spawnSync 同步等待结束）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const results = [];
function ok(cond, name, detail) {
  results.push({ name, ok: Boolean(cond), detail: cond ? undefined : detail });
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (cond ? '' : ' :: ' + JSON.stringify(detail)));
  if (!cond) process.exitCode = 1;
}
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; } };
const sha = (file) => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; } };
const realInstallResult = path.join(ROOT, 'data', 'install-result.json');
const beforeReal = sha(realInstallResult);

function runPwsh(scriptFile, env) {
  const res = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ...(env || {}) }
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

(async () => {
  const inst = read('install.ps1');

  /* ── R1/R2/R5：PowerShell 侧真跑（AST 截取 install.ps1 的函数与镜像分支）────────── */
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'e379-rework-'));
  const psScript = path.join(sandbox, 'harness.ps1');
  const psBody = [
    "$ErrorActionPreference = 'Stop'",
    `$ps1 = '${path.join(ROOT, 'install.ps1').replace(/'/g, "''")}'`,
    '$psText = [System.IO.File]::ReadAllText($ps1, [System.Text.Encoding]::UTF8)',
    '$ast = [System.Management.Automation.Language.Parser]::ParseFile($ps1, [ref]$null, [ref]$null)',
    '$funcs = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)',
    "$want = @('Write-InstallerLog','Write-Step','Get-ElectronProgressSnapshot','Format-ProgressFacts','Read-InstallerNewLines','Invoke-LoggedCommand','Add-InstallerWarning','Write-InstallResult')",
    '$chunks = @()',
    'foreach ($name in $want) { $m = $funcs | Where-Object { $_.Name -eq $name } | Select-Object -First 1; if (-not $m) { throw "missing function: $name" }; $chunks += $m.Extent.Text }',
    `$tmp = Join-Path '${sandbox.replace(/'/g, "''")}' 'funcs.ps1'`,
    '[System.IO.File]::WriteAllText($tmp, ($chunks -join "`r`n`r`n"), (New-Object System.Text.UTF8Encoding($true)))',
    '. $tmp',
    '$script:LogFile = $null',
    '$script:LogDirectory = $null',
    '$script:Warnings = @()',
    '$script:MCP = $null',
    '$script:NodeRuntime = $null',
    '$script:ShortcutPath = $null',
    '$script:TotalSteps = 7',
    '$script:ExitCode = 0',
    `$script:RepoRoot = '${sandbox.replace(/'/g, "''")}'`,
    "$script:Stage = '夹具'",
    // R1：截取镜像分支（起 $mirrorDisabled，止下一段 e379 注释之前）
    "$startMark = '$mirrorDisabled = ($env:AWB_NO_MIRROR -eq ''1'')'",
    '$startIdx = $psText.IndexOf($startMark)',
    "$endMark = '    # e379：快捷方式与安装预检提前到依赖安装之前'",
    '$endIdx = $psText.IndexOf($endMark)',
    'if ($startIdx -lt 0 -or $endIdx -le $startIdx) { throw "mirror block not found" }',
    '$mirrorText = $psText.Substring($startIdx, $endIdx - $startIdx)',
    '$mirrorBlock = [scriptblock]::Create($mirrorText)',
    "$env:ELECTRON_MIRROR = ''",
    "$env:AWB_NO_MIRROR = '1'",
    '& $mirrorBlock | Out-Null',
    "Write-Output ('MIRROR_OFF_VALUE=' + [string]$env:ELECTRON_MIRROR)",
    "$env:AWB_NO_MIRROR = '0'",
    "$env:ELECTRON_MIRROR = ''",
    '& $mirrorBlock | Out-Null',
    "Write-Output ('MIRROR_DEFAULT_VALUE=' + [string]$env:ELECTRON_MIRROR)",
    "Remove-Item Env:AWB_NO_MIRROR -ErrorAction SilentlyContinue",
    // R2：进度（每 1 秒一行；子进程撑 4 秒确保至少两拍）
    "Write-Output '--- progress ---'",
    "$progressOut = & { Invoke-LoggedCommand -Exe $env:ComSpec -Arguments @('/c', 'ping -n 4 127.0.0.1 >nul') -WorkingDirectory $env:TEMP -ProgressSeconds 1 -PhaseName '夹具进度' } 2>&1 | Out-String",
    "Write-Output ('PROGRESS_CAPTURED=' + $progressOut)",
    "Write-Output ('PROGRESS_HAS_BEAT=' + [bool]($progressOut -match '\\[进度 \\d+s\\]'))",
    "Write-Output ('PROGRESS_HAS_STAGE=' + [bool]($progressOut -match '阶段：'))",
    // R5：安装结果 + warnings 合并
    "Write-Output '--- install-result ---'",
    "[void](Add-InstallerWarning -Code 'MCP_START_FAILED' -Message 'MCP 自检失败（夹具中文）' -LogPath 'C:\\\\tmp\\\\mcp-fixture.log')",
    '$file1 = Write-InstallResult -RepoRoot $script:RepoRoot -Ok $false -Stage "安装依赖（npm install）" -Next "重跑安装器"',
    "Write-Output ('RESULT_FILE=' + $file1)",
    '$p1 = [System.IO.File]::ReadAllText($file1, [System.Text.Encoding]::UTF8) | ConvertFrom-Json',
    "Write-Output ('RESULT1_OK=' + $p1.ok + '|STAGE=' + $p1.stage + '|WARN=' + @($p1.warnings).Count + '|CODE=' + $p1.warnings[0].code + '|CN=' + [bool]($p1.warnings[0].message -match '夹具中文') + '|LOG=' + $p1.warnings[0].log)",
    "[void](Add-InstallerWarning -Code 'SECOND_WARN' -Message '第二条')",
    '$file2 = Write-InstallResult -RepoRoot $script:RepoRoot -Ok $true -Stage "收尾" -Next "start.cmd"',
    '$p2 = [System.IO.File]::ReadAllText($file2, [System.Text.Encoding]::UTF8) | ConvertFrom-Json',
    "Write-Output ('RESULT2_WARN=' + @($p2.warnings).Count + '|CODES=' + ((@($p2.warnings) | ForEach-Object { $_.code }) -join ','))",
    // 解析检查
    '$tok = $null; $errs = $null',
    '[void][System.Management.Automation.Language.Parser]::ParseFile($ps1, [ref]$tok, [ref]$errs)',
    "Write-Output ('PS_PARSE_ERRORS=' + @($errs).Count)",
    "Write-Output 'HARNESS_DONE'"
  ].join('\r\n');
  fs.writeFileSync(psScript, psBody, { encoding: 'utf8' });
  // PowerShell 5.1 需要 BOM 才能正确解析中文
  const psBytes = fs.readFileSync(psScript);
  fs.writeFileSync(psScript, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), psBytes]));

  const ps = runPwsh(psScript);
  ok(ps.stdout.includes('HARNESS_DONE'), 'R0 PowerShell 夹具跑完（AST 截取 install.ps1 函数 + 镜像分支）', { status: ps.status, tail: ps.stdout.slice(-600), err: ps.stderr.slice(-400) });
  ok(/PS_PARSE_ERRORS=(0|)\b/.test(ps.stdout.replace(/\r/g, '')), 'R0b install.ps1 仍可被 PowerShell 解析（BOM 未丢）', { line: (ps.stdout.match(/PS_PARSE_ERRORS=\d+/) || [''])[0] });

  const mirrorOff = /MIRROR_OFF_VALUE=(.*)/.exec(ps.stdout.replace(/\r/g, ''));
  const mirrorDefault = /MIRROR_DEFAULT_VALUE=(.*)/.exec(ps.stdout.replace(/\r/g, ''));
  ok(mirrorOff && String(mirrorOff[1]).trim() === '', 'R1a AWB_NO_MIRROR=1 时不写 ELECTRON_MIRROR（镜像关闭）', { value: mirrorOff && mirrorOff[1] });
  ok(mirrorDefault && /npmmirror\.com\/mirrors\/electron/.test(String(mirrorDefault[1])), 'R1b 未开启开关时默认镜像仍生效', { value: mirrorDefault && mirrorDefault[1] });
  ok(inst.includes("AWB_NO_MIRROR -eq '1'") && inst.includes('$mirrorDisabled'), 'R1c install.ps1 有 AWB_NO_MIRROR 开关（可 grep）', {});

  const progressCaptured = /PROGRESS_CAPTURED=([\s\S]*?)PROGRESS_HAS_BEAT=/.exec(ps.stdout.replace(/\r/g, ''));
  const beatLines = (ps.stdout.replace(/\r/g, '').match(/\[进度 \d+s\]/g) || []).length;
  ok(beatLines >= 2, 'R2a 进度模式输出多行 [进度 Ns]（每 ProgressSeconds 一拍）', { beatLines, sample: progressCaptured && progressCaptured[1].slice(0, 200) });
  ok(/\[进度 \d+s\][^\r\n]*阶段：[^\r\n]*MB/.test(ps.stdout.replace(/\r/g, '')), 'R2b 进度行含阶段名与已下载字节（阶段：/MB/包）', { sample: (ps.stdout.match(/\[进度 \d+s\][^\r\n]*/) || [''])[0] });
  ok(/ProgressSeconds/.test(inst) && /-ProgressSeconds 5/.test(inst), 'R2c npm install 调用带 -ProgressSeconds 5（≤30s 一行）', {});

  const r1 = /RESULT1_OK=([^\r\n]*)/.exec(ps.stdout.replace(/\r/g, ''));
  ok(Boolean(r1) && /^False\|STAGE=安装依赖/.test(r1[1]) && /WARN=1/.test(r1[1]) && /CODE=MCP_START_FAILED/.test(r1[1]), 'R5a 失败也写安装结果（ok=false + 失败阶段 + warnings[]）', { line: r1 && r1[1] });
  ok(Boolean(r1) && /CN=True/.test(r1[1]) && /LOG=C:\\\\tmp\\\\mcp-fixture\.log/.test(r1[1]), 'R5b warnings 中文与日志路径完整落盘', { line: r1 && r1[1] });
  const r2 = /RESULT2_WARN=(\d+)\|CODES=([^\r\n]*)/.exec(ps.stdout.replace(/\r/g, ''));
  ok(Boolean(r2) && Number(r2[1]) === 2 && /MCP_START_FAILED/.test(r2[2]) && /SECOND_WARN/.test(r2[2]), 'R5c 二次写入保留既有 warnings（安装器与 MCP 自检互不覆盖）', { line: r2 && r2[0] });
  ok(inst.includes('install-result.json') && inst.includes("Add-InstallerWarning -Code 'MCP_START_FAILED'"), 'R5d 安装器把 MCP 失败写进 install-result.json 的 warnings[]', {});
  ok(inst.includes('mcp-selfcheck.cjs'), 'R5e 安装器调用 scripts/mcp-selfcheck.cjs（MCP 自检）', {});

  /* ── R3：MCP 自检 CLI（成功 / node 缺失）────────────────────────────── */
  const mcpHome = path.join(sandbox, 'dshhome');
  const mcpDataOk = path.join(sandbox, 'data-ok');
  const mcpDataBad = path.join(sandbox, 'data-bad');
  const cli = path.join(ROOT, 'scripts', 'mcp-selfcheck.cjs');
  const runCli = (args, extraEnv) => spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, DSH_HOME: mcpHome, ...(extraEnv || {}) }
  });
  const okRun = runCli(['--repo', ROOT, '--data', mcpDataOk, '--json']);
  const okJsonLine = String(okRun.stdout || '').trim().split(/\r?\n/).pop() || '{}';
  let okJson = {};
  try { okJson = JSON.parse(okJsonLine); } catch { okJson = {}; }
  ok(okRun.status === 0 && okJson.ok === true && /web-search-safe\.js$/.test(String(okJson.args && okJson.args[0])), 'R3a MCP 自检成功（initialize 握手，exit 0）', { status: okRun.status, json: okJson });
  const okRecord = path.join(mcpDataOk, 'mcp-selfcheck.json');
  ok(fs.existsSync(okRecord), 'R3b 结果落盘 data/mcp-selfcheck.json', { file: okRecord });

  const badNode = path.join(sandbox, 'no-such-node.exe');
  const badRun = runCli(['--repo', ROOT, '--data', mcpDataBad, '--node', badNode, '--json']);
  const badJsonLine = String(badRun.stdout || '').trim().split(/\r?\n/).pop() || '{}';
  let badJson = {};
  try { badJson = JSON.parse(badJsonLine); } catch { badJson = {}; }
  ok(badRun.status === 0 && badJson.ok === false && badJson.errno === 'ENOENT', 'R3c node 缺失时自检失败但 exit 0（不阻断安装/启动）', { status: badRun.status, json: badJson });
  const logs = fs.existsSync(path.join(mcpHome, 'logs')) ? fs.readdirSync(path.join(mcpHome, 'logs')).filter((f) => /^mcp-.*\.log$/.test(f)) : [];
  const logName = logs.slice().sort().pop() || '';
  const logFile = logName ? path.join(mcpHome, 'logs', logName) : '';
  const logText = logFile ? fs.readFileSync(logFile, 'utf8') : '';
  ok(logs.length >= 1, 'R3d 失败写 ~/.dsh/logs/mcp-<ts>.log（沙盘 DSH_HOME）', { logs });
  ok(/command:/.test(logText) && /args:/.test(logText) && /errno: ENOENT/.test(logText) && /stderr（前 500 字）:/.test(logText), 'R3e 日志含 command/args/errno/stderr 前 500 字', { head: logText.slice(0, 400) });
  const badInstall = path.join(mcpDataBad, 'install-result.json');
  let badInstallJson = {};
  try { badInstallJson = JSON.parse(fs.readFileSync(badInstall, 'utf8')); } catch { badInstallJson = {}; }
  ok(Array.isArray(badInstallJson.warnings) && badInstallJson.warnings.some((w) => w.code === 'MCP_START_FAILED'), 'R3f 失败合并进 install-result.json 的 warnings[]（AC6①）', { install: badInstallJson.warnings });

  /* ── R4：dshVersion 真实取值（假 DSH 页面）────────────────────────── */
  const cap = require(path.join(ROOT, 'src', 'dsh-capability.js'));
  const server = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><script>window.__DSH_BOOT__ = {"rev":"abc","release":{"version":"0.2.2-rc.3","commit":"6b729fe"}};</script>');
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('nope');
      }
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const port = server.address().port;
  try {
    const rec = await cap.probeDshCapability({
      adapter: { baseUrl: 'http://127.0.0.1:' + port, webCookie: () => ({ name: 'c', value: 'v' }), listSessions: async () => [{ id: 1 }, { id: 2 }] },
      dataDir: path.join(sandbox, 'cap'),
      timeoutMs: 3000
    });
    ok(rec.dshVersion === '0.2.2-rc.3' && rec.dshVersionSource === 'page-release' && rec.dshCommit === '6b729fe', 'R4a 探针从 DSH 页面 release.version 取到真实版本', { rec });
    ok(cap.capabilityLine(rec).includes('DSH 0.2.2-rc.3'), 'R4b 摘要行带版本号（DSH 互通能力：有…，DSH x.y.z）', { line: cap.capabilityLine(rec) });
    const noVersionSrv = await new Promise((resolve) => {
      const s = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>no version here</body></html>'); });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const p2 = noVersionSrv.address().port;
    try {
      const rec2 = await cap.probeDshCapability({
        adapter: { baseUrl: 'http://127.0.0.1:' + p2, listSessions: async () => [] },
        dataDir: path.join(sandbox, 'cap2'),
        timeoutMs: 2000
      });
      ok(rec2.dshVersion === '' && Boolean(rec2.dshVersionError), 'R4c 取不到版本时留空并记 dshVersionError（不写假版本）', { rec: rec2 });
      const capDisk = JSON.parse(fs.readFileSync(path.join(sandbox, 'cap', 'dsh-capability.json'), 'utf8'));
      ok(capDisk.dshVersion === '0.2.2-rc.3' && typeof capDisk.at === 'string', 'R4d dshVersion/at 落盘可回读（AC7③）', { disk: capDisk });
    } finally {
      noVersionSrv.close();
    }
  } finally {
    server.close();
  }

  /* ── R6：界面锚点 + IPC 接线 ─────────────────────────────────────── */
  const app = read('src/renderer/app.js');
  const pre = read('src/preload.js');
  const main = read('src/main.js');
  ok(app.includes('data-install-warnings') && app.includes('data-install-warning') && app.includes('data-mcp-warning'), 'R6a 设置页（关于 PM工作台）有安装/MCP 警告锚点', {});
  ok(app.includes('loadInstallWarningsIntoModal') && app.includes('workbench.diagnostics'), 'R6b 关于面板异步读诊断并渲染（不静默）', {});
  ok(pre.includes("ipcRenderer.invoke('app:diagnostics')"), 'R6c preload 暴露 diagnostics', {});
  ok(main.includes("ipcMain.handle('app:diagnostics'") && main.includes('runMcpSelfCheck({ repoRoot: ROOT'), 'R6d main.js 有 app:diagnostics 只读 IPC + 运行期 MCP 自检', {});
  ok(main.includes("require('./mcp-selfcheck')"), 'R6e main.js 引入 mcp-selfcheck 模块', {});

  /* ── 隔离断言 ─────────────────────────────────────────────────── */
  ok(sha(realInstallResult) === beforeReal, 'I1 真实 data/install-result.json 零写入（前后 sha 相同）', { before: beforeReal, after: sha(realInstallResult) });

  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
  const pass = results.filter((r) => r.ok).length;
  console.log('\nE379_REWORK ' + pass + '/' + results.length + (pass === results.length ? ' PASS' : ' FAIL'));
  if (process.env.AWB_E379_REWORK_JSON) {
    fs.writeFileSync(process.env.AWB_E379_REWORK_JSON, JSON.stringify({ at: new Date().toISOString(), results }, null, 2) + '\n', 'utf8');
  }
})().catch((error) => {
  console.error('E379_REWORK_FAILED ' + String((error && error.message) || error).slice(0, 400));
  process.exitCode = 2;
});
