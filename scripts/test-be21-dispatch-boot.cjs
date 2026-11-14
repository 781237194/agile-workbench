'use strict';
/** T-be21 回归：派单前自动 boot 接线（先 boot 后投递）。 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'be21-dispatch');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TEAM_TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '接线沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 260)}`);
  if (!ok) process.exitCode = 1;
}
function run(args) {
  const out = execFileSync(process.execPath, [TEAM_TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
  const t = String(out).trim();
  return JSON.parse(t.slice(t.indexOf('{')));
}
const audit = () => {
  const f = path.join(TEAM_ROOT, '状态', '项目', PROJECT, '自动boot.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};

fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true });
run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'sbx-pm', '--json']);
const task = run(['task', 'create', '--boot', pm.token, '--project', PROJECT, '--title', '接线用任务', '--priority', 'P1', '--type', 'task', '--json']).task;

// ① 目标角色没有有效令牌 → 派单前自动 boot
const before = audit().length;
const sent = run(['send', '--boot', pm.token, '--to', 'programmer1', '--subject', '派单', '--body', '做这个', '--task', task.id, '--ack', '--json']);
const rows = audit().filter((row) => row.role === 'programmer1');
check('① 派单触发自动 boot（审计新增 leader 记录）', rows.length >= 1 && rows.slice(-1)[0].singleFlight === 'leader', rows.slice(-1)[0]);
check('① 审计 trigger 为 stale/create 且 ok=true', ['stale', 'create', 'rotate', 'rules_changed'].includes(rows.slice(-1)[0].trigger) && rows.slice(-1)[0].ok === true, rows.slice(-1)[0]);
check('① 投递成功且没有 pendingBoot', sent.ok === true && !sent.pendingBoot, { ok: sent.ok, pendingBoot: sent.pendingBoot });

// ② 第二次派单复用令牌，不重复 boot
const before2 = audit().filter((row) => row.role === 'programmer1').length;
run(['send', '--boot', pm.token, '--to', 'programmer1', '--subject', '派单2', '--body', '继续', '--task', task.id, '--ack', '--queue', '--json']);
const after2 = audit().filter((row) => row.role === 'programmer1').length;
check('② 已有令牌时不再新增自动 boot 记录', after2 === before2, { before2, after2 });

// ③ 目标角色从未 boot（令牌缺失）→ 派单前自动 boot（用 programmer2，避开 pending 锁）
const before3 = audit().filter((row) => row.role === 'programmer2').length;
const sent3 = run(['send', '--boot', pm.token, '--to', 'programmer2', '--subject', '派单3', '--body', '再派', '--task', task.id, '--ack', '--queue', '--json']);
const after3 = audit().filter((row) => row.role === 'programmer2').length;
check('③ 令牌缺失的接收方 → 派单前自动 boot', after3 > before3 && sent3.ok === true, { before3, after3, ok: sent3.ok });
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\nT-be21 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
fs.writeFileSync(path.join(SB, 'run-be21.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
