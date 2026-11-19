#!/usr/bin/env node
'use strict';
/**
 * test-248a-githubfix.cjs —— P0 B-20261119-102117-248a 夹具：内嵌 GitHubFix（install.ps1）。
 *
 * 覆盖：
 *   A) apply：hosts 副本写入标记段（github.com / codeload / api / raw），原内容保留；重复 apply 只有一段；
 *   B) restore：标记段清零、与初始内容逐字一致（零残留）；再次 restore 幂等；
 *   C) -NoGitHubFix：下载失败不写 hosts（applied=false），仍重试 3 次；
 *   D) 修复后仍失败：自动恢复 hosts 原文（restored=true、无标记段），错误列出候选 IP；
 *   E) 不可写目标：可读失败（exit 2 + error），不产生半写；
 *   F) 静态：安装路径与 -Upgrade 路径都走 Invoke-GitHubFixedDownload；install-result/升级记录含 githubFix；
 *      真实 hosts 全程零改动（bytes/sha256/mtime 三项）。
 *
 * 跑法：node scripts/test-248a-githubfix.cjs
 * 注意：只写沙盘 hosts 副本（-GitHubFixHostsPath），绝不写真实 hosts。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const INSTALLER = path.join(ROOT, 'install.ps1');
const SYSTEM_ROOT = process.env.SystemRoot || process.env.windir || path.parse(process.execPath).root;
const REAL_HOSTS = path.join(SYSTEM_ROOT, 'System32', 'drivers', 'etc', 'hosts');
const ROWS = [];
const check = (name, ok, detail) => {
  ROWS.push({ name, ok: Boolean(ok) });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 500)));
  if (!ok) process.exitCode = 1;
};
const sha = (file) => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; } };
const statOf = (file) => { try { const s = fs.statSync(file); return { size: s.size, mtime: s.mtimeMs, sha: sha(file) }; } catch { return null; } };
const norm = (t) => String(t || '').replace(/\r\n/g, '\n').replace(/\s+$/, '');

const realBefore = statOf(REAL_HOSTS);

function runInstaller(args, envExtra) {
  const env = { ...process.env, ...envExtra };
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INSTALLER, ...args], {
    encoding: 'utf8', timeout: 180000, env, windowsHide: true,
  });
  const out = String(r.stdout || '');
  const err = String(r.stderr || '');
  const line = out.split(/\r?\n/).reverse().find((x) => x.trim().startsWith('GITHUBFIX_TEST_JSON'));
  let json = null;
  if (line) { try { json = JSON.parse(line.trim().slice('GITHUBFIX_TEST_JSON'.length).trim()); } catch { json = null; } }
  return { code: r.status, out, err, json };
}

const SB = fs.mkdtempSync(path.join(os.tmpdir(), '248a-githubfix-'));
const seedLines = [
  '# Copyright (c) 1993-2009 Microsoft Corp.',
  '# local test hosts copy',
  '127.0.0.1 localhost',
  '# 192.168.1.10 old-dev',
  '',
];
const seedText = seedLines.join('\r\n');
const hosts = path.join(SB, 'hosts');
const writeHosts = (text) => fs.writeFileSync(hosts, text, 'utf8');
const readHosts = () => fs.readFileSync(hosts, 'utf8');
const countMarker = (t, m) => (t.split(m).length - 1);

const FAKE_IP = '20.27.177.113';
try {
  // A) apply
  writeHosts(seedText);
  const a1 = runInstaller(['-GitHubFixTest', 'apply', '-GitHubFixHostsPath', hosts], { AWB_TEST_GITHUBFIX_FAKE_IP: FAKE_IP, AWB_TEST_GITHUBFIX_SKIP_FLUSH: '1', AWB_TEST_GITHUBFIX_FAIL_DOWNLOAD: '1' });
  const t1 = readHosts();
  check('A1 apply 退出 0 且输出 JSON', a1.code === 0 && a1.json && a1.json.state && a1.json.state.applied === true, { code: a1.code, json: a1.json, out: a1.out.slice(-400) });
  check('A2 已选 IP 与注入一致（' + FAKE_IP + '）', Boolean(a1.json && a1.json.state.chosenIp === FAKE_IP), a1.json && a1.json.state);
  check('A3 标记段 START/END 各 1 处', countMarker(t1, '# ==== GitHub Fix START ====') === 1 && countMarker(t1, '# ==== GitHub Fix END ====') === 1, t1);
  check('A4 映射含 github.com 与 codeload.github.com', /github\.com/.test(t1) && /codeload\.github\.com/.test(t1), t1);
  check('A5 原有 hosts 行保留', seedLines.filter((l) => l.trim()).every((l) => t1.includes(l)), { t1 });

  // A6 幂等：再 apply 不重复
  const a2 = runInstaller(['-GitHubFixTest', 'apply', '-GitHubFixHostsPath', hosts], { AWB_TEST_GITHUBFIX_FAKE_IP: FAKE_IP, AWB_TEST_GITHUBFIX_SKIP_FLUSH: '1', AWB_TEST_GITHUBFIX_FAIL_DOWNLOAD: '1' });
  const t2 = readHosts();
  check('A6 重复 apply 幂等（仍只有一段）', a2.code === 0 && countMarker(t2, '# ==== GitHub Fix START ====') === 1 && countMarker(t2, '# ==== GitHub Fix END ====') === 1, t2);

  // B) restore → 零残留
  const b1 = runInstaller(['-GitHubFixRestore', '-GitHubFixHostsPath', hosts], { AWB_TEST_GITHUBFIX_SKIP_FLUSH: '1', AWB_TEST_GITHUBFIX_FAIL_DOWNLOAD: '1' });
  const t3 = readHosts();
  check('B1 restore 退出 0', b1.code === 0, { code: b1.code, out: b1.out.slice(-300), err: b1.err.slice(-300) });
  check('B2 restore 后标记段清零', countMarker(t3, '# ==== GitHub Fix START ====') === 0 && countMarker(t3, '# ==== GitHub Fix END ====') === 0, t3);
  check('B3 restore 后与初始内容逐字一致（零残留）', norm(t3) === norm(seedText), { now: t3, seed: seedText });
  const b2 = runInstaller(['-GitHubFixRestore', '-GitHubFixHostsPath', hosts], { AWB_TEST_GITHUBFIX_SKIP_FLUSH: '1', AWB_TEST_GITHUBFIX_FAIL_DOWNLOAD: '1' });
  check('B4 无标记段时 restore 幂等且退出 0', b2.code === 0 && norm(readHosts()) === norm(seedText), { code: b2.code, text: readHosts() });

  // C) -NoGitHubFix：下载失败不写 hosts
  writeHosts(seedText);
  const c1 = runInstaller(['-GitHubFixTest', 'download', '-NoGitHubFix', '-GitHubFixHostsPath', hosts, '-ZipUrl', 'https://github.com/example/example/archive/refs/heads/main.zip'], { AWB_TEST_GITHUBFIX_FAKE_IP: FAKE_IP, AWB_TEST_GITHUBFIX_SKIP_FLUSH: '1', AWB_TEST_GITHUBFIX_FAIL_DOWNLOAD: '1' });
  check('C1 -NoGitHubFix 下载失败但退出非 0', c1.code !== 0, { code: c1.code });
  check('C2 -NoGitHubFix 不写 hosts（无标记段、原文不变）', countMarker(readHosts(), '# ==== GitHub Fix START ====') === 0 && norm(readHosts()) === norm(seedText), readHosts());
  check('C3 仍重试 3 次', Boolean(c1.json && c1.json.state && Number(c1.json.state.attempts) === 3), c1.json && c1.json.state);

  // D) 修复后仍失败 → 自动恢复原文
  writeHosts(seedText);
  const d1 = runInstaller(['-GitHubFixTest', 'download', '-GitHubFixHostsPath', hosts, '-ZipUrl', 'https://github.com/example/example/archive/refs/heads/main.zip'], { AWB_TEST_GITHUBFIX_FAKE_IP: FAKE_IP, AWB_TEST_GITHUBFIX_SKIP_FLUSH: '1', AWB_TEST_GITHUBFIX_FAIL_DOWNLOAD: '1' });
  check('D1 下载失败退出非 0', d1.code !== 0, { code: d1.code });
  check('D2 曾应用修复（applied=true）', Boolean(d1.json && d1.json.state && d1.json.state.applied === true), d1.json && d1.json.state);
  check('D3 失败后已恢复（restored=true 且无标记段）', Boolean(d1.json && d1.json.state && d1.json.state.restored === true) && countMarker(readHosts(), '# ==== GitHub Fix START ====') === 0, { state: d1.json && d1.json.state, text: readHosts() });
  check('D4 错误信息列出候选 IP', Boolean(d1.json && /候选 IP/.test(String(d1.json.state.error || d1.json.error || ''))), d1.json && (d1.json.state || {}).error);

  // E) 不可写目标 → 可读失败
  const badTarget = path.join(SB, 'a-directory');
  fs.mkdirSync(badTarget, { recursive: true });
  const e1 = runInstaller(['-GitHubFixTest', 'apply', '-GitHubFixHostsPath', badTarget], { AWB_TEST_GITHUBFIX_FAKE_IP: FAKE_IP, AWB_TEST_GITHUBFIX_SKIP_FLUSH: '1', AWB_TEST_GITHUBFIX_FAIL_DOWNLOAD: '1' });
  check('E1 目标不可写 → 退出非 0 且 error 可读', e1.code !== 0 && Boolean(e1.json && (e1.json.error || (e1.json.state || {}).error)), { code: e1.code, json: e1.json });

  // E2 非管理员 + 真实 hosts：提权按注入跳过 → 可读失败且不写 hosts
  const e2 = runInstaller(['-GitHubFixTest', 'apply'], { AWB_TEST_GITHUBFIX_FAKE_IP: FAKE_IP, AWB_TEST_GITHUBFIX_SKIP_FLUSH: '1', AWB_TEST_GITHUBFIX_NO_RUNAS: '1', AWB_TEST_GITHUBFIX_ELEVATED: '' });
  const e2msg = String((e2.json && (e2.json.error || (e2.json.state || {}).error)) || '');
  check('E2 非管理员提权失败 → 可读错误（含管理员/提权）且不写真实 hosts', e2.code !== 0 && /管理员|提权/.test(e2msg) && countMarker(readHosts(), '# ==== GitHub Fix START ====') === 0, { code: e2.code, msg: e2msg, json: e2.json });
  // F) 静态接线
  const src = fs.readFileSync(INSTALLER, 'utf8');
  check('F1 安装路径与升级路径都走 Invoke-GitHubFixedDownload', (src.match(/Invoke-GitHubFixedDownload/g) || []).length >= 3, {});
  check('F2 install-result 与升级记录都带 githubFix', src.includes('githubFix   = $script:GitHubFix') && src.includes('githubFix') && /Add-Member -NotePropertyName githubFix/.test(src), {});
  check('F3 四个域名候选齐全（github/api/raw/codeload）', /codeload\.github\.com/.test(src) && /api\.github\.com/.test(src) && /raw\.githubusercontent\.com/.test(src) && /github\.com/.test(src), {});
  check('F4 三个开关与两个隐藏测试入口存在', src.includes('[switch]$NoGitHubFix') && src.includes('[string]$GitHubFixHostsPath') && src.includes('[switch]$GitHubFixRestore') && src.includes('[string]$GitHubFixTest'), {});
} finally {
  fs.rmSync(SB, { recursive: true, force: true });
}

// 真实 hosts 全程零改动
const realAfter = statOf(REAL_HOSTS);
check('G1 真实 hosts 未被触碰（bytes/sha256/mtime 全同）',
  JSON.stringify(realBefore) === JSON.stringify(realAfter),
  { before: realBefore, after: realAfter });

const failed = ROWS.filter((r) => !r.ok);
console.log('');
console.log('248a-GITHUBFIX ' + (ROWS.length - failed.length) + '/' + ROWS.length + (failed.length ? ' FAIL' : ' PASS'));
process.exit(failed.length ? 1 : 0);
