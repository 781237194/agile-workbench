#!/usr/bin/env node
'use strict';
/**
 * test-d83d2-upgrade-deploy.cjs —— Owner 2026-11-19 追加验收：自动升级必须**真的把新代码部署到位**
 * （更新新版文件、删掉新版已不存在的旧文件、失败自动回滚），不能只是“下载/校验成功”。
 *
 * 通过 install.ps1 的夹具入口 -TestUpgradeApply（对沙盘目录调用生产函数 Invoke-UpgradeApplyTree /
 * Invoke-UpgradeVerifyInstall / Restore-UpgradeBackup，不下载、不碰真实安装目录）：
 *   v1: package.json 1.0.0 / src/main.js “OLD” / src/removed.js（v2 已删）
 *   v2: package.json 2.0.0 / src/main.js “NEW” / src/new-file.js（新增）
 * 断言：应用后新代码落盘、陈旧文件删除、部署校验通过；注入 apply 失败 → 自动回滚恢复 v1；真实仓库零改动。
 * 用法：node scripts/test-d83d2-upgrade-deploy.cjs [--out <dir>]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-d83d'); })();
const rows = [];
function check(name, ok, detail) { rows.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' :: ' + String(JSON.stringify(detail)).slice(0, 500))); }
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const read = (f) => fs.readFileSync(f, 'utf8');
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t, 'utf8'); };
function ps(args, timeoutMs = 120000) { return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, cwd: ROOT }); }
function runApply(sb, tag, opts = {}) {
  const install = path.join(sb, `install-${tag}`);
  const staging = path.join(sb, `staging-${tag}`);
  const backup = path.join(sb, `backup-${tag}`);
  write(path.join(install, 'package.json'), JSON.stringify({ name: 'pm-workbench', version: '1.0.0' }, null, 2));
  write(path.join(install, 'start.cmd'), '@echo off\r\necho APP_DIR=%CD%\r\nexit /b 0\r\n');
  write(path.join(install, 'src', 'main.js'), "'use strict';\n// OLD MAIN v1\nmodule.exports = { v: 1 };\n");
  write(path.join(install, 'src', 'preload.js'), "'use strict';\n// OLD PRELOAD v1\n");
  write(path.join(install, 'src', 'renderer', 'index.html'), '<html><!-- OLD v1 --></html>\n');
  write(path.join(install, 'src', 'removed.js'), '// 只在 v1 存在，v2 已删除——升级后必须消失\n');
  write(path.join(install, 'README.md'), '# v1\n');
  write(path.join(staging, 'package.json'), JSON.stringify({ name: 'pm-workbench', version: '2.0.0' }, null, 2));
  write(path.join(staging, 'start.cmd'), '@echo off\r\necho APP_DIR=%CD%\r\nexit /b 0\r\n');
  write(path.join(staging, 'src', 'main.js'), "'use strict';\n// NEW MAIN v2\nmodule.exports = { v: 2 };\n");
  write(path.join(staging, 'src', 'preload.js'), "'use strict';\n// NEW PRELOAD v2\n");
  write(path.join(staging, 'src', 'renderer', 'index.html'), '<html><!-- NEW v2 --></html>\n');
  write(path.join(staging, 'src', 'new-file.js'), '// v2 新增文件——升级后必须存在\n');
  write(path.join(staging, 'README.md'), '# v2\n');
  fs.mkdirSync(backup, { recursive: true });
  const cfgFile = path.join(sb, `apply-${tag}.json`);
  write(cfgFile, JSON.stringify({ installDir: install, stagingDir: staging, backupDir: backup, targetVersion: '2.0.0', failApply: Boolean(opts.failApply), autoRollback: Boolean(opts.autoRollback) }));
  const run = ps(['-File', path.join(ROOT, 'install.ps1'), '-TestUpgradeApply', cfgFile], 120000);
  const log = String(run.stdout || '') + String(run.stderr || '');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `d83d2-apply-${tag}.log`), log, 'utf8');
  let payload = {};
  const m = /UPGRADE_APPLY_JSON (\{.*\})/.exec(log);
  if (m) { try { payload = JSON.parse(m[1]); } catch { payload = {}; } }
  return { run, payload, install, staging, backup, log };
}
(async () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'd83d2-'));
  const repoMain = path.join(ROOT, 'src', 'main.js');
  const repoHashBefore = sha(repoMain);
  try {
    // ── A：正常应用 → 新代码落盘、陈旧文件删除、部署校验通过 ──
    const a = runApply(sb, 'ok');
    check('D1 应用退出码=0 且 ok=true', a.run.status === 0 && a.payload.ok === true, { status: a.run.status, payload: a.payload, tail: a.log.slice(-600) });
    check('D2 部署校验 installedVersion=2.0.0 且 verifiedFiles≥3', String(a.payload.installedVersion) === '2.0.0' && Number(a.payload.verifiedFiles) >= 3, a.payload);
    check('D3 新版代码已落盘（src/main.js == NEW v2）', read(path.join(a.install, 'src', 'main.js')).includes('NEW MAIN v2'), read(path.join(a.install, 'src', 'main.js')).slice(0, 120));
    check('D4 v2 新增文件已出现（src/new-file.js）', fs.existsSync(path.join(a.install, 'src', 'new-file.js')), null);
    check('D5 v2 已删除的旧文件被清理（src/removed.js 不存在）', !fs.existsSync(path.join(a.install, 'src', 'removed.js')), null);
    check('D6 安装目录 package.json 版本=2.0.0', String(JSON.parse(read(path.join(a.install, 'package.json'))).version) === '2.0.0', null);
    check('D7 备份保留旧版（src/main.js 含 OLD v1、removed.js 在备份）', read(path.join(a.backup, 'src', 'main.js')).includes('OLD MAIN v1') && fs.existsSync(path.join(a.backup, 'src', 'removed.js')), null);
    check('D8 真实仓库 src/main.js 零改动', sha(repoMain) === repoHashBefore, null);

    // ── B：应用阶段失败 → 自动回滚恢复 v1 ──
    const b = runApply(sb, 'fail', { failApply: true, autoRollback: true });
    check('D9 注入 apply 失败：ok=false、rollback=true、错误可读', b.payload.ok === false && b.payload.rollback === true && /注入|injected|部署校验失败/.test(String(b.payload.error || '')), b.payload);
    check('D10 回滚后 v1 恢复（main.js OLD、removed.js 回来、package.json 1.0.0）', read(path.join(b.install, 'src', 'main.js')).includes('OLD MAIN v1') && fs.existsSync(path.join(b.install, 'src', 'removed.js')) && String(JSON.parse(read(path.join(b.install, 'package.json'))).version) === '1.0.0', null);
    check('D11 回滚后 v2 新增文件不在（new-file.js 消失）', !fs.existsSync(path.join(b.install, 'src', 'new-file.js')), null);

    // ── C：install.ps1 仍可解析（BOM/PS5.1）──────────
    const parse = ps(['-Command', `$null = [ScriptBlock]::Create((Get-Content -Raw -LiteralPath '${path.join(ROOT, 'install.ps1')}')); 'PARSE_OK'`]);
    check('D12 install.ps1 PowerShell 解析通过', String(parse.stdout || '').includes('PARSE_OK') && parse.status === 0, { status: parse.status, err: String(parse.stderr || '').slice(0, 300) });
  } catch (e) {
    check('运行未抛错', false, String((e && e.stack) || e).slice(0, 600));
  } finally {
    try { fs.rmSync(sb, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'd83d2-upgrade-deploy-run.json'), JSON.stringify({ at: new Date().toISOString(), checks: rows }, null, 2) + '\n', 'utf8');
  const failed = rows.filter((r) => !r.ok);
  console.log('\nD83D2-UPGRADE-DEPLOY ' + (failed.length ? 'FAIL' : 'OK') + ' ' + JSON.stringify({ total: rows.length, pass: rows.length - failed.length, red: failed.length }));
  console.log('证据：' + path.join(OUT, 'd83d2-upgrade-deploy-run.json'));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('D83D2 ERROR ' + String((e && e.stack) || e)); process.exit(1); });
