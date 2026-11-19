#!/usr/bin/env node
'use strict';
/**
 * test-c437-install-heal.cjs —— P0 B-20261119-123400-c437 夹具：
 *   §P0-1 npm11 拦 electron postinstall → 安装器从缓存 zip 自愈（自包含函数 + 目录状态 + 原因码）
 *   §P2-7 Move 退避重试 3 次 + 失败分类（占用/权限）
 *   §P1-3 启动器默认目录含安装器默认 <盘符>\PM工作台（沙盘盘符注入，不碰真实目录）+ 安装器写 PM_WORKBENCH_HOME
 *   §P2-6 teamRoot 调用期解析（env 改了立即生效；workbench.json 上溯）
 *   §P3-9/P3-10 README 显著警告 + Desktop 插件路径
 *
 * 全部在 %TEMP% 沙盘：hosts / 真实安装目录零改动。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const INSTALLER = path.join(ROOT, 'install.ps1');
const PLUGIN = path.join(ROOT, 'dsh-plugin', 'pm-workbench-dsh', 'index.js');
const ROOT_README = path.join(ROOT, 'README.md');
const PLUGIN_README = path.join(ROOT, 'dsh-plugin', 'README.md');
const SYSTEM_ROOT = process.env.SystemRoot || process.env.windir || path.parse(process.execPath).root;
const REAL_HOSTS = path.join(SYSTEM_ROOT, 'System32', 'drivers', 'etc', 'hosts');
const REAL_INSTALL = path.join(path.parse(process.execPath).root, 'PM工作台');

const ROWS = [];
const check = (name, ok, detail) => {
  ROWS.push({ name, ok: Boolean(ok) });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 500)));
  if (!ok) process.exitCode = 1;
};
const sha = (file) => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; } };
const statOf = (p) => { try { const s = fs.statSync(p); return { size: s.size, mtime: s.mtimeMs, dir: s.isDirectory() }; } catch { return null; } };
const OUT = path.join(ROOT, '_tmp', 'c437-evidence');

function runPs(args, envExtra) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INSTALLER, ...args], {
    encoding: 'utf8', timeout: 180000, env: { ...process.env, ...envExtra }, windowsHide: true,
  });
  const out = String(r.stdout || '');
  const tag = out.split(/\r?\n/).reverse().find((x) => /JSON\s*\{/.test(x));
  let json = null;
  if (tag) { try { json = JSON.parse(tag.slice(tag.search(/\{/))); } catch { json = null; } }
  return { code: r.status, out, err: String(r.stderr || ''), json };
}

const hostsBefore = statOf(REAL_HOSTS);
const installDirBefore = statOf(REAL_INSTALL);
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'c437-'));

try {
  // ── A) electron 自愈：dist 只有 LICENSES，缓存有 zip → 自愈成功 ─────────────
  const app = path.join(SB, 'app');
  const distDir = path.join(app, 'node_modules', 'electron', 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'LICENSES.chromium.html'), 'only-license\n');
  const pkgDir = path.join(SB, 'zip-src');
  fs.mkdirSync(path.join(pkgDir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'electron.exe'), 'fake-electron-binary');
  fs.writeFileSync(path.join(pkgDir, 'resources', 'app.asar'), 'fake-asar');
  const cacheDir = path.join(SB, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const zipPath = path.join(cacheDir, 'electron-v33.4.11-win32-x64.zip');
  const zip = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path "${pkgDir}\\*" -DestinationPath "${zipPath}" -Force`], { encoding: 'utf8', timeout: 120000 });
  check('A0 夹具准备：缓存 zip 已生成', zip.status === 0 && fs.existsSync(zipPath), { status: zip.status, err: String(zip.stderr || '').slice(0, 200) });
  const a1 = runPs(['-TestElectronHeal', app, '-TestElectronCacheDir', cacheDir], {});
  const pathTxtFile = path.join(app, 'node_modules', 'electron', 'path.txt');
  check('A1 自愈退出 0 且 JSON ok', a1.code === 0 && a1.json && a1.json.ok === true, { code: a1.code, json: a1.json, err: a1.err.slice(0, 300) });
  check('A2 自愈来源=缓存 zip', Boolean(a1.json && a1.json.reason === 'cache-zip'), a1.json && a1.json.reason);
  check('A3 electron.exe 已就位、path.txt=electron.exe', fs.existsSync(path.join(distDir, 'electron.exe')) && fs.readFileSync(pathTxtFile, 'utf8').trim() === 'electron.exe', { files: fs.existsSync(path.join(distDir, 'electron.exe')), txt: (() => { try { return fs.readFileSync(pathTxtFile, 'utf8'); } catch { return ''; } })() });
  check('A4 目录状态文件数 ≥2（含资源文件）', Boolean(a1.json && a1.json.dirState && a1.json.dirState.fileCount >= 2), a1.json && a1.json.dirState);

  // ── B) 无缓存 zip → 可读失败（reason=no-cache-zip） ─────────────────────────
  const app2 = path.join(SB, 'app2');
  fs.mkdirSync(path.join(app2, 'node_modules', 'electron', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(app2, 'node_modules', 'electron', 'dist', 'LICENSES.chromium.html'), 'x');
  const emptyCache = path.join(SB, 'empty-cache');
  fs.mkdirSync(emptyCache, { recursive: true });
  const b1 = runPs(['-TestElectronHeal', app2, '-TestElectronCacheDir', emptyCache], {});
  check('B1 无缓存 zip → 退出非 0 且 reason=no-cache-zip', b1.code !== 0 && Boolean(b1.json && b1.json.reason === 'no-cache-zip'), { code: b1.code, json: b1.json });
  check('B2 失败时仍回报目录状态（可用后排查）', Boolean(b1.json && b1.json.dirState && typeof b1.json.dirState.fileCount === 'number'), b1.json && b1.json.dirState);

  // ── C) Move 退避重试：前 2 次失败 → 第 3 次成功 ─────────────────────────────
  const srcA = path.join(SB, 'move-src');
  const dstA = path.join(SB, 'move-dst');
  fs.mkdirSync(srcA, { recursive: true });
  fs.writeFileSync(path.join(srcA, 'node.exe'), 'fake-node');
  const c1 = runPs(['-TestMoveRetrySrc', srcA, '-TestMoveRetryDst', dstA], { AWB_TEST_MOVE_FAIL_TIMES: '2' });
  check('C1 前 2 次失败 → 第 3 次成功（attempts=3, mode=move）', c1.code === 0 && c1.json && c1.json.ok === true && c1.json.attempts === 3 && c1.json.mode === 'move', { code: c1.code, json: c1.json });
  check('C2 目标目录已落盘（node.exe 存在）', fs.existsSync(path.join(dstA, 'node.exe')), {});

  // ── D) Move 一直失败 → 分类可读（占用/权限） ───────────────────────────────
  const srcB = path.join(SB, 'move-src2');
  const dstB = path.join(SB, 'move-dst2');
  fs.mkdirSync(srcB, { recursive: true });
  fs.writeFileSync(path.join(srcB, 'node.exe'), 'fake-node');
  const d1 = runPs(['-TestMoveRetrySrc', srcB, '-TestMoveRetryDst', dstB], { AWB_TEST_MOVE_FAIL_TIMES: '99', AWB_TEST_MOVE_COPY_FAIL: '1' });
  check('D1 一直失败 → 退出非 0 且带失败分类', d1.code !== 0 && Boolean(d1.json && d1.json.ok === false && d1.json.errorClass), { code: d1.code, json: d1.json });

  // ── E) 启动器：默认目录含 <盘符>\PM工作台（沙盘盘符注入）；teamRoot 调用期解析 ──
  const driveD = path.join(SB, 'driveD');
  fs.mkdirSync(path.join(driveD, 'PM工作台'), { recursive: true });
  fs.writeFileSync(path.join(driveD, 'PM工作台', 'start.cmd'), '@echo off\r\nexit /b 0\r\n');
  const teamA = path.join(SB, 'teamA');
  const teamB = path.join(SB, 'teamB');
  const projRoot = path.join(SB, 'proj');
  for (const t of [teamA, teamB, path.join(projRoot, '团队')]) fs.mkdirSync(path.join(t, '状态'), { recursive: true });
  const storeFile = path.join(SB, 'workbench.json');
  fs.writeFileSync(storeFile, JSON.stringify({ projects: [{ id: 'P1', name: 'p', path: path.join(projRoot, 'deep') }] }, null, 2) + '\n');
  const probe = path.join(SB, 'probe.mjs');
  const pluginUrl = 'file:///' + PLUGIN.replace(/\\/g, '/');
  fs.writeFileSync(probe, [
    `import { getDefaultWorkbenchDirs, resolveTeamRoot } from ${JSON.stringify(pluginUrl)};`,
    'const out = {};',
    'out.dirs = getDefaultWorkbenchDirs();',
    'process.env.AWB_TEAM_ROOT = ' + JSON.stringify(teamA) + ';',
    'out.teamA = resolveTeamRoot();',
    'process.env.AWB_TEAM_ROOT = ' + JSON.stringify(teamB) + ';',
    'out.teamB = resolveTeamRoot();',
    'delete process.env.AWB_TEAM_ROOT; delete process.env.TEAM_ROOT;',
    'out.storeTeam = resolveTeamRoot();',
    "console.log('PROBE_JSON ' + JSON.stringify(out));",
  ].join('\n'), 'utf8');
  const probeEnv = { ...process.env, AWB_TEST_DRIVES: driveD, AWB_STORE: storeFile };
  for (const k of ['PM_WORKBENCH_HOME', 'AWB_WORKBENCH_DIR', 'PM_WORKBENCH_DIR', 'AWB_TEAM_ROOT', 'TEAM_ROOT', 'DSH_PROFILE_DIR']) delete probeEnv[k];
  const p1 = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 120000, env: probeEnv });
  const probeLine = String(p1.stdout || '').split(/\r?\n/).reverse().find((x) => x.startsWith('PROBE_JSON '));
  let probeJson = null;
  if (probeLine) { try { probeJson = JSON.parse(probeLine.slice('PROBE_JSON '.length)); } catch { probeJson = null; } }
  const expectDrive = path.join(driveD, 'PM工作台');
  check('E1 启动器默认目录含 <沙盘盘符>\\PM工作台（无 PM_WORKBENCH_HOME）', Boolean(probeJson && Array.isArray(probeJson.dirs) && probeJson.dirs.some((d) => path.resolve(d).toLowerCase() === path.resolve(expectDrive).toLowerCase())), { dirs: probeJson && probeJson.dirs, err: String(p1.stderr || '').slice(0, 300) });
  check('E2 teamRoot 调用期读 env（A→B 不重启即生效）', Boolean(probeJson && probeJson.teamA && probeJson.teamA.teamRoot && path.resolve(probeJson.teamA.teamRoot).toLowerCase() === path.resolve(teamA).toLowerCase() && probeJson.teamB && path.resolve(probeJson.teamB.teamRoot).toLowerCase() === path.resolve(teamB).toLowerCase()), { a: probeJson && probeJson.teamA, b: probeJson && probeJson.teamB });
  check('E3 无 env 时从 workbench.json 的 projects[].path 上溯到 <repo>/团队', Boolean(probeJson && probeJson.storeTeam && probeJson.storeTeam.source === 'workbench-store' && path.resolve(probeJson.storeTeam.teamRoot).toLowerCase() === path.resolve(path.join(projRoot, '团队')).toLowerCase()), { store: probeJson && probeJson.storeTeam });

  // ── F) 静态接线 ─────────────────────────────────────────────────────────
  const ps = fs.readFileSync(INSTALLER, 'utf8');
  check('F1 安装器：npm11 授权 + 缓存自愈 + 原因码 + 目录状态', ps.includes("'install-scripts' 'approve'") && ps.includes('Invoke-ElectronHeal') && ps.includes('install-scripts-blocked') && ps.includes('download-failed') && ps.includes('Get-ElectronDirState'), {});
  check('F2 安装器：Move 退避重试走统一函数（失败分类）', ps.includes('function Move-DirectoryWithRetry') && ps.includes('Move-DirectoryWithRetry -Source $source') && ps.includes('errorClass'), {});
  check('F3 安装器：写 PM_WORKBENCH_HOME 用户变量 + 重启 DSH 提示', ps.includes("'PM_WORKBENCH_HOME'") && /重启 DSH/.test(ps), {});
  const pluginSrc = fs.readFileSync(PLUGIN, 'utf8');
  check('F4 启动器：默认目录含 <盘符>\\PM工作台 且调用期解析', pluginSrc.includes("listWorkbenchDriveCandidates") && pluginSrc.includes("AWB_TEST_DRIVES") && pluginSrc.includes("export function getDefaultWorkbenchDirs") && !/const DEFAULT_DIRS = \(\(\) =>/.test(pluginSrc), {});
  const rootReadme = fs.readFileSync(ROOT_README, 'utf8');
  const pluginReadme = fs.readFileSync(PLUGIN_README, 'utf8');
  check('F5 README：整段替换警告 + Desktop 插件路径', /整段替换/.test(rootReadme) && /plugin_manager/.test(rootReadme) && /整段替换/.test(pluginReadme) && /plugin_manager/.test(pluginReadme), {});
} finally {
  try { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'run-c437.json'), JSON.stringify({ at: new Date().toISOString(), checks: ROWS }, null, 2) + '\n'); } catch { }
  fs.rmSync(SB, { recursive: true, force: true });
}

const hostsAfter = statOf(REAL_HOSTS);
const installAfter = statOf(REAL_INSTALL);
check('G1 真实 hosts 零改动（size/mtime/sha 全同）', Boolean(hostsBefore) && JSON.stringify(hostsBefore) === JSON.stringify(hostsAfter), { before: hostsBefore, after: hostsAfter });
check('G2 真实安装目录零改动', JSON.stringify(installDirBefore) === JSON.stringify(installAfter), { before: installDirBefore, after: installAfter });

const failed = ROWS.filter((r) => !r.ok);
console.log('');
console.log('C437-INSTALL-HEAL ' + (ROWS.length - failed.length) + '/' + ROWS.length + (failed.length ? ' FAIL' : ' PASS'));
process.exit(failed.length ? 1 : 0);
