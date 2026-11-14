#!/usr/bin/env node
'use strict';
/**
 * R-7841 独立测试环境沙盘 · 断言（T-20261115-031917-1145）
 * 覆盖：seed 清 sessionId/二次校验、run 注入四类隔离环境变量+TEAM_SELFTEST=1、路径越界拒绝、
 *       verify 生产零改动（SANDBOX_OK）与篡改检测（SANDBOX_LEAK）、clean 只删沙盘内目录。
 * 跑法：node scripts\test-sandbox-7841.cjs
 * 沙盘根固定在 .sandbox/sb-test-7841（跑完删除），不写真实团队/数据。
 */
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'sandbox', 'run.cjs');
const SBROOT = path.join(ROOT, '.sandbox', 'sb-test-7841');
const TRACK = path.join(ROOT, '.sandbox', 'sb-test-track.txt');

let total = 0;
let failed = 0;
const rows = [];
function check(name, ok, detail) {
  total += 1;
  if (!ok) failed += 1;
  rows.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 300)));
}
function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  let json = null;
  try { json = JSON.parse(String(r.stdout || '').trim()); } catch { json = null; }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

fs.mkdirSync(path.dirname(SBROOT), { recursive: true });
fs.rmSync(SBROOT, { recursive: true, force: true });
fs.writeFileSync(TRACK, 'baseline\n', 'utf8');

/* 1) seed：复制团队、清 sessionId、二次校验、记录基线 */
const seed = run(['seed', '--root', SBROOT, '--track', TRACK]);
check('seed 成功并返回 SANDBOX_SEEDED', seed.status === 0 && seed.json && seed.json.code === 'SANDBOX_SEEDED', seed.json || seed.stdout.slice(0, 200));
check('seed 报告 sessionIdsCleared=true', Boolean(seed.json && seed.json.sessionIdsCleared === true));
const teamJson = path.join(SBROOT, '团队', '状态', '团队.json');
const roster = JSON.parse(fs.readFileSync(teamJson, 'utf8'));
check('沙盘名册 members[].sessionId 全为空', (roster.members || []).every((m) => !String(m.sessionId || '').trim()), (roster.members || []).slice(0, 6).map((m) => m.role + ':' + (m.sessionId || '空')));
const meta = JSON.parse(fs.readFileSync(path.join(SBROOT, 'sandbox.json'), 'utf8'));
check('sandbox.json 记录四类隔离根 + TEAM_SELFTEST=1', meta.env && /sb-test-7841/.test(meta.env.TEAM_ROOT) && /sb-test-7841/.test(meta.env.AWB_DATA_DIR) && /sb-test-7841/.test(meta.env.DSH_HOME) && meta.env.TEAM_SELFTEST === '1', meta.env);
check('sandbox.json 记录真实文件基线（含 workbench.json 与团队.json）', Array.isArray(meta.baseline) && meta.baseline.some((row) => /workbench\.json$/.test(row.file)) && meta.baseline.some((row) => /团队\.json$/.test(row.file)), (meta.baseline || []).map((row) => path.relative(ROOT, row.file)));

/* 2) run：注入环境变量、命令输出可见 */
const probe = run(['run', '--root', SBROOT, '--', process.execPath, '-e',
  'console.log(JSON.stringify({selftest:process.env.TEAM_SELFTEST,team:process.env.TEAM_ROOT,data:process.env.AWB_DATA_DIR,dsh:process.env.DSH_HOME}))']);
let envs = null;
try { envs = JSON.parse(String(probe.stdout || '').trim().split(/\r?\n/).pop()); } catch { envs = null; }
check('run 把 TEAM_SELFTEST=1 注入子进程', probe.status === 0 && envs && envs.selftest === '1', envs);
check('run 注入的 TEAM_ROOT/AWB_DATA_DIR/DSH_HOME 全在沙盘内', Boolean(envs) && [envs.team, envs.data, envs.dsh].every((p) => String(p || '').toLowerCase().startsWith(SBROOT.toLowerCase())), envs);

/* 3) 路径守卫：--root 不在 .sandbox 下 → 退出码 3 */
const outside = run(['seed', '--root', path.join(ROOT, '_tmp', 'sb-outside')]);
check('路径越界被拒（退出码 3 / SANDBOX_PATH_OUTSIDE）', outside.status === 3 && /SANDBOX_PATH_OUTSIDE/.test(outside.stderr + outside.stdout), { status: outside.status });

/* 4) verify：生产零改动 → SANDBOX_OK */
const okVerify = run(['verify', '--root', SBROOT]);
check('verify 在无改动时返回 SANDBOX_OK', okVerify.status === 0 && okVerify.json && okVerify.json.code === 'SANDBOX_OK', okVerify.json);

/* 5) verify：篡改被跟踪文件 → SANDBOX_LEAK（退出码 4） */
fs.writeFileSync(TRACK, 'leaked-' + Date.now() + '\n', 'utf8');
const leak = run(['verify', '--root', SBROOT]);
check('篡改被跟踪文件后 verify 返回 SANDBOX_LEAK', leak.status === 4 && leak.json && leak.json.code === 'SANDBOX_LEAK' && Array.isArray(leak.json.leaked) && leak.json.leaked.length >= 1, leak.json);
check('泄漏报告带 before/after sha256 前缀', Boolean(leak.json && leak.json.leaked && leak.json.leaked[0].before && leak.json.leaked[0].after && leak.json.leaked[0].after.sha256.length >= 8));

/* 6) clean：只删沙盘内目录 */
const clean = run(['clean', '--root', SBROOT]);
check('clean 删除沙盘目录', clean.status === 0 && clean.json && clean.json.code === 'SANDBOX_CLEANED' && !fs.existsSync(SBROOT), clean.json);
const cleanOutside = run(['clean', '--root', path.join(ROOT, '团队')]);
check('clean 拒绝删除真实团队目录（退出码 3）', cleanOutside.status === 3, { status: cleanOutside.status });
check('真实 团队/状态/团队.json 仍存在', fs.existsSync(path.join(ROOT, '团队', '状态', '团队.json')));

fs.rmSync(TRACK, { force: true });
fs.rmSync(SBROOT, { recursive: true, force: true });

const outDir = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-7841');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ at: new Date().toISOString(), total, failed, results: rows }, null, 2) + '\n', 'utf8');
console.log('\n合计 ' + total + ' 项，失败 ' + failed + ' 项');
if (!failed) console.log('SANDBOX_7841_OK');
process.exit(failed ? 1 : 0);
