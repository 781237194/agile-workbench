#!/usr/bin/env node
'use strict';
const { rmSandbox, uniqueSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A/B：清理助手 + 唯一沙盘
/**
 * R-62b9 AC6/AC7 · task accept 沙盘断言（T-3999/E2 工具侧，维修模式·PM 授权范围内）
 *
 * 覆盖：
 *   E2-1 测试令牌 task accept --as tester → acceptanceRecord.by='tester'、channel='test'、task.status='accepted'
 *   E2-2 PM 令牌 task accept --as pm（**无任何代管记录**）→ by='pm'、channel='pm'（不再 PROXY_UNAUTHORIZED）
 *   E2-3 --as 与 boot 令牌不一致 → ACCEPT_ROLE_MISMATCH（零副作用）
 *   E2-4 证据门保留：缺测试报告 → PM_ACCEPT_EVIDENCE_REQUIRED
 *   E2-5 非缺陷任务 → ACCEPT_NOT_DEFECT
 *
 * 隔离：复制 团队/ 到 _tmp/task-accept-62b9/团队（清 members[].sessionId），
 *       TEAM_ROOT + TEAM_PROJECTS_ROOT 指向沙盘；不设唤醒，不碰真实邮箱。
 * 跑法：node scripts/test-task-accept-62b9.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const REAL_TEAM = path.join(ROOT, '团队');
const SB = uniqueSandbox('task-accept-62b9'); // B-07b6 B：唯一沙盘（并发安全）
const SB_TEAM = path.join(SB, '团队');
const SB_PROJECTS = path.join(SB, '项目');
const PROJECT = '沙盘62b9';
const TEAM_MJS = path.join(REAL_TEAM, '工具', 'team.mjs');

let passed = 0;
const failures = [];
function check(id, name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${id}  ${name}`); return; }
  failures.push({ id, name, detail });
  console.log(`FAIL  ${id}  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 400)}`);
}
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (/[\\/]锁([\\/]|$)/.test(s) || /[\\/]邮箱[\\/]/.test(s)) continue;
    if (ent.isDirectory()) copyDir(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}
function env() {
  const e = { ...process.env, TEAM_ROOT: SB_TEAM, TEAM_PROJECTS_ROOT: SB_PROJECTS, TEAM_SELFTEST: '1' };
  delete e.ELECTRON_RUN_AS_NODE;
  return e;
}
function run(args, { allowFail = false } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [TEAM_MJS, ...args], { cwd: ROOT, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stdout };
  } catch (error) {
    const out = String((error && error.stdout) || '') + String((error && error.stderr) || '');
    if (allowFail) return { ok: false, out };
    throw new Error(`命令失败：${args.join(' ')}\n${out.slice(0, 600)}`);
  }
}
function tokenOf(stdout) {
  const m = /令牌[:：]\s*([0-9a-f]{20,})/.exec(String(stdout || ''));
  return m ? m[1] : '';
}
function readTask(taskId) {
  const file = path.join(SB_TEAM, '状态', '项目', PROJECT, '任务', taskId + '.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/* ── 沙盘准备 ─────────────────────────────────────────────────────────── */
rmSandbox(SB, { recursive: true, force: true });
fs.mkdirSync(SB_PROJECTS, { recursive: true });
copyDir(REAL_TEAM, SB_TEAM);
const teamFile = path.join(SB_TEAM, '状态', '团队.json');
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
for (const m of team.members || []) m.sessionId = '';
team.activeProject = '';
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');

const sandboxProject = path.join(SB_PROJECTS, PROJECT);
fs.mkdirSync(sandboxProject, { recursive: true });
run(['project', 'add', '--name', PROJECT, '--path', sandboxProject, '--team-mode', 'full'], { allowFail: true });

const pmTok = tokenOf(run(['boot', '--role', 'pm', '--project', PROJECT]).stdout);
check('E2-0a 沙盘 PM boot 成功', Boolean(pmTok), { pmTok: pmTok.slice(0, 6) });

// 证据两件套（报告 + 截图占位）
const evDir = path.join(SB, '证据');
fs.mkdirSync(evDir, { recursive: true });
const reportPath = path.join(evDir, '测试报告-PASS.md');
const shotPath = path.join(evDir, '截图1.png');
fs.writeFileSync(reportPath, '# 测试报告\n\nPASS 缺陷已修复（沙盘断言用）\n', 'utf8');
fs.writeFileSync(shotPath, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f6d0000000049454e44ae426082', 'hex'));

function createBug(title) {
  const out = run(['task', 'create', '--boot', pmTok, '--project', PROJECT, '--title', title, '--detail', '沙盘缺陷（E2 断言用）', '--type', 'bug', '--priority', 'P2', '--acceptance', '复现→修复→验证', '--repro', '1) 打开沙盘 2) 触发缺陷 3) 观察到报错', '--expected', '不报错', '--actual', '报错']).stdout;
  const m = /(B-\d{8}-\d{6}-\w{4})/.exec(out);
  return m ? m[1] : '';
}
const bugA = createBug('沙盘缺陷A-测试直验');
const bugB = createBug('沙盘缺陷B-PM直验');
check('E2-0b 沙盘建出两张缺陷单', Boolean(bugA && bugB), { bugA, bugB });

/* ── E2-1 测试令牌直验（AC6）────────────────────────────────────────── */
const testerTok = tokenOf(run(['boot', '--role', 'tester', '--project', PROJECT]).stdout);
const acceptA = run(['task', 'accept', '--boot', testerTok, '--project', PROJECT, '--task', bugA, '--as', 'tester', '--decision', 'accepted', '--opinion', '沙盘：测试直验通过', '--evidence', `${reportPath}:report`, '--evidence', `${shotPath}:screenshot`], { allowFail: true });
const taskA = acceptA.ok ? readTask(bugA) : null;
check('E2-1 [AC6] 测试令牌 task accept 成功（by=tester / channel=test / status=accepted）',
  Boolean(acceptA.ok && taskA && taskA.acceptanceRecord && taskA.acceptanceRecord.by === 'tester'
    && taskA.acceptanceRecord.channel === 'test' && taskA.status === 'accepted'),
  { ok: acceptA.ok, out: String(acceptA.out || '').slice(0, 200), record: taskA && taskA.acceptanceRecord });

/* ── E2-2 PM 令牌直验（无代管，AC7）────────────────────────────────── */
const acceptB = run(['task', 'accept', '--boot', pmTok, '--project', PROJECT, '--task', bugB, '--as', 'pm', '--decision', 'accepted', '--opinion', '沙盘：PM 直接验收（无代管）', '--evidence', `${reportPath}:report`, '--evidence', `${shotPath}:screenshot`], { allowFail: true });
const taskB = acceptB.ok ? readTask(bugB) : null;
check('E2-2 [AC7] PM 令牌在无代管下 task accept 成功（by=pm / channel=pm，不再 PROXY_UNAUTHORIZED）',
  Boolean(acceptB.ok && taskB && taskB.acceptanceRecord && taskB.acceptanceRecord.by === 'pm'
    && taskB.acceptanceRecord.channel === 'pm'),
  { ok: acceptB.ok, out: String(acceptB.out || '').slice(0, 240), record: taskB && taskB.acceptanceRecord });

/* ── E2-3 角色不一致 ───────────────────────────────────────────────── */
const bugC = createBug('沙盘缺陷C-角色不一致');
const mismatch = run(['task', 'accept', '--boot', testerTok, '--project', PROJECT, '--task', bugC, '--as', 'pm', '--decision', 'accepted', '--opinion', 'x', '--evidence', `${reportPath}:report`, '--evidence', `${shotPath}:screenshot`], { allowFail: true });
const taskC = readTask(bugC);
check('E2-3 --as 与 boot 角色不一致 → ACCEPT_ROLE_MISMATCH 且零副作用',
  Boolean(!mismatch.ok && /ACCEPT_ROLE_MISMATCH/.test(mismatch.out) && !taskC.acceptanceRecord),
  { out: String(mismatch.out || '').slice(0, 200) });

/* ── E2-4 证据门保留 ───────────────────────────────────────────────── */
const bugD = createBug('沙盘缺陷D-缺报告');
const noReport = run(['task', 'accept', '--boot', testerTok, '--project', PROJECT, '--task', bugD, '--as', 'tester', '--decision', 'accepted', '--opinion', 'x', '--evidence', `${shotPath}:screenshot`], { allowFail: true });
check('E2-4 缺测试报告仍被证据门挡（PM_ACCEPT_EVIDENCE_REQUIRED）',
  Boolean(!noReport.ok && /PM_ACCEPT_EVIDENCE_REQUIRED/.test(noReport.out)),
  { out: String(noReport.out || '').slice(0, 200) });

/* ── E2-5 非缺陷单拒绝 ─────────────────────────────────────────────── */
const normalTaskOut = run(['task', 'create', '--boot', pmTok, '--project', PROJECT, '--title', '普通开发任务', '--detail', '不是缺陷', '--type', 'task', '--priority', 'P2']).stdout;
const normalId = (/(T-\d{8}-\d{6}-\w{4})/.exec(normalTaskOut) || [])[1] || '';
const notDefect = normalId
  ? run(['task', 'accept', '--boot', testerTok, '--project', PROJECT, '--task', normalId, '--as', 'tester', '--decision', 'accepted', '--opinion', 'x', '--evidence', `${reportPath}:report`, '--evidence', `${shotPath}:screenshot`], { allowFail: true })
  : { ok: false, out: '' };
check('E2-5 非缺陷单（type=task）拒绝：ACCEPT_NOT_DEFECT',
  Boolean(!notDefect.ok && /ACCEPT_NOT_DEFECT/.test(notDefect.out)), { normalId, out: String(notDefect.out || '').slice(0, 160) });

const outDir = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-62b9-e2');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ at: new Date().toISOString(), sandbox: SB, passed, failed: failures.length, failures }, null, 2) + '\n', 'utf8');
console.log(`\nR-62b9 E2 沙盘断言：${passed}/${passed + failures.length} PASS`);
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
process.exit(0);
