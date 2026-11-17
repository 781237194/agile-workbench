#!/usr/bin/env node
/**
 * 30d8 静态自检：所有会拉起工作台/DSH 的测试脚本必须隔离 DSH_HOME
 *
 * 判据（写死）：
 *   ① `scripts/**` 中通过 `scripts/run-electron.cjs` 启动的测试 → 由启动器集中注入沙盘 DSH_HOME
 *      （run-electron.cjs 必须含 DSH_HOME 逻辑）→ 通过；
 *   ② 脚本自己 spawn 的 env 里显式带 `DSH_HOME` → 通过（双保险，允许个别脚本自定义沙盘根）；
 *   ③ 直接 spawn electron / node_modules/electron 可执行文件、绕过 run-electron.cjs → 判红；
 *   ④ `scripts/clean-workspaces.cjs` 必须存在且含 dry-run 默认、写前备份、_tmp 判定 → 判红条件同左。
 *
 * 用法：node scripts/check-test-dsh-home.cjs [--json]
 * 退出码：0=全过；1=发现违规。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const jsonOut = process.argv.includes('--json');
const violations = [];
const rows = [];

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (/node_modules|_tmp|_backup/.test(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, acc);
    else if (/\.(cjs|mjs)$/.test(e.name)) acc.push(abs);
  }
  return acc;
}
const files = walk(SCRIPTS);
const runElectron = fs.readFileSync(path.join(SCRIPTS, 'run-electron.cjs'), 'utf8');
const launcherIsolates = /DSH_HOME/.test(runElectron) && /dsh-home/.test(runElectron);
rows.push({ file: 'scripts/run-electron.cjs', kind: '启动器集中隔离', ok: launcherIsolates, detail: launcherIsolates ? '含 DSH_HOME 沙盘注入' : '缺 DSH_HOME 沙盘注入' });
if (!launcherIsolates) violations.push('scripts/run-electron.cjs 未集中注入沙盘 DSH_HOME');

for (const abs of files) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  if (rel === 'scripts/run-electron.cjs' || rel === 'scripts/check-test-dsh-home.cjs') continue;
  const src = fs.readFileSync(abs, 'utf8');
  const spawnsShell = /run-electron\.cjs/.test(src) && /spawn|execFile|execSync/.test(src);
  // 只认「真的 spawn electron 可执行文件」：spawn/exec* 的第一个参数含 electron 字面量，
  // 或变量名是 EXE/ELECTRON/electronBin/electronPath 且文件里确实引用了 node_modules/electron/dist。
  const spawnCalls = [...src.matchAll(/(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*([A-Za-z_$][\w$]*|'[^']*'|"[^"]*"|`[^`]*`)/g)].map((m) => m[1]);
  const hasElectronPath = /node_modules[\\/]['"]?electron|electron\.exe/i.test(src);
  const spawnsElectronDirect = hasElectronPath && spawnCalls.some((arg) => /electron/i.test(arg) || /^(EXE|ELECTRON|electronBin|electronPath)$/i.test(arg));
  const selfIsolates = /DSH_HOME/.test(src);
  if (!spawnsShell && !spawnsElectronDirect) continue;
  let ok = true;
  let detail = '经 run-electron.cjs（启动器集中隔离）';
  if (spawnsElectronDirect) {
    ok = false;
    detail = '直接 spawn electron 可执行文件，绕过 run-electron.cjs（必须改走启动器）';
  } else if (!launcherIsolates && !selfIsolates) {
    ok = false;
    detail = '启动器未隔离且本脚本未设 DSH_HOME';
  } else if (selfIsolates) {
    detail = '本脚本显式设置 DSH_HOME（双保险）';
  }
  rows.push({ file: rel, kind: 'spawn 工作台/DSH', ok, detail });
  if (!ok) violations.push(`${rel}: ${detail}`);
}

// clean-workspaces.cjs 契约
const cleanPath = path.join(SCRIPTS, 'clean-workspaces.cjs');
const cleanOk = fs.existsSync(cleanPath);
if (!cleanOk) {
  violations.push('scripts/clean-workspaces.cjs 缺失');
  rows.push({ file: 'scripts/clean-workspaces.cjs', kind: '清理入口', ok: false, detail: '缺失' });
} else {
  const clean = fs.readFileSync(cleanPath, 'utf8');
  const hasDryRun = /dryRun/.test(clean) && /--yes/.test(clean);
  const hasBackup = /backup/i.test(clean) && /copyFileSync/.test(clean);
  const hasTmpRule = /_tmp/.test(clean) && /existsSync/.test(clean);
  const ok = hasDryRun && hasBackup && hasTmpRule;
  rows.push({ file: 'scripts/clean-workspaces.cjs', kind: '清理入口', ok, detail: { hasDryRun, hasBackup, hasTmpRule } });
  if (!ok) violations.push(`scripts/clean-workspaces.cjs 契约不全：dryRun=${hasDryRun} backup=${hasBackup} tmpRule=${hasTmpRule}`);
}

const payload = { ok: violations.length === 0, checked: rows.length, violations, rows };
if (jsonOut) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
else {
  for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.file} · ${r.kind} · ${typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)}`);
  console.log(`\nTEST_DSH_HOME ${violations.length === 0 ? 'OK' : 'VIOLATION'} {"checked":${rows.length},"violations":${violations.length}}`);
}
process.exit(violations.length === 0 ? 0 : 1);
