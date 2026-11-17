'use strict';
const { rmSandbox, uniqueSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * T-20261115-110400-7ac3 沙盘断言：task reap（僵尸任务逻辑删除 + 审计 + NOOP + purge 护栏）。
 *
 * 沙盘：复制 团队/ 到 _tmp/7ac3，替换 lib/ops.mjs 为提案暂存版；直接造 3 条僵尸 + 1 条活任务。
 *  ①--filter legacy 只动 T-20261112-*；活任务不动；审计 2 行
 *  ②--ids 补清 mirror；审计累计 3 行
 *  ③重复 reap 同一 --ids → NOOP，审计不再增行（幂等）
 *  ④task list --cancelled 能查到 3 条
 *  ⑤--purge 无 --confirm → CONFIRM_REQUIRED 且零副作用
 *  ⑥--purge --confirm 活任务（父需求未收口/无父）→ PURGE_REFUSED 且文件仍在
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = uniqueSandbox('7ac3');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM, '工具', 'team.mjs');
// T-20261117-161410-593c：旧「提案暂存版」ops.mjs 已与现行 team.mjs 不匹配（缺 cmdClaim 导出），
// 改用 HEAD 现行实现（只复制不修改）；本脚本仍只验证 reap 行为，不评价实现版本。
const STAGED = path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs');
const PROJECT = '7ac3清理沙盘';
const env = { ...process.env, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 300)}`);
  if (!ok) process.exitCode = 1;
}
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function run(args, allowFail = false) {
  try {
    return { ok: true, out: execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' }) };
  } catch (e) {
    if (!allowFail) throw e;
    return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}

rmSandbox(SB, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
fs.copyFileSync(STAGED, path.join(TEAM, '工具', 'lib', 'ops.mjs'));
check('沙盘 ops.mjs = HEAD 现行实现（不再用旧提案暂存版）', sha(path.join(TEAM, '工具', 'lib', 'ops.mjs')) === sha(STAGED), { staged: sha(STAGED).slice(0, 16) });
const teamFile = path.join(TEAM, '状态', '团队.json');
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
for (const m of team.members || []) m.sessionId = '';
team.activeProject = PROJECT;
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);

const stateDir = path.join(TEAM, '状态', '项目', PROJECT);
const taskDir = path.join(stateDir, '任务');
fs.mkdirSync(taskDir, { recursive: true });
const now = new Date().toISOString();
function writeTask(id, { type = 'task', status = 'open', owner = '', requirementId = '', title = id, evidence = '' } = {}) {
  const row = {
    id, project: PROJECT, type, requirementId, title, detail: '沙盘', acceptance: 'AC', priority: 'P2',
    priorityBy: 'pm', priorityReason: '', owner, status, createdBy: 'pm', createdAt: now, claimedAt: '', due: '',
    doneAt: status === 'done' ? now : null, evidence, rev: 0, history: [], workflow: { round: 1 },
  };
  fs.writeFileSync(path.join(taskDir, `${id}.json`), JSON.stringify(row, null, 2) + '\n', 'utf8');
  return path.join(taskDir, `${id}.json`);
}
const Z1 = 'T-20261112-aaaa';
const Z2 = 'T-20261112-bbbb';
const MIR = 'R-20261115-9999';
const LIVE = 'T-20261116-cccc';
writeTask(Z1, { status: 'open' });
writeTask(Z2, { status: 'done' });
writeTask(MIR, { type: 'requirement', status: 'open', title: '镜像需求行' });
writeTask(LIVE, { status: 'working', owner: 'programmer1', title: '活任务' });
const auditFile = path.join(stateDir, '任务清理.jsonl');
const boot = JSON.parse(run(['boot', '--role', 'programmer2', '--project', PROJECT, '--json']).out);
const token = boot.token || (boot.boot && boot.boot.token);
check('沙盘 boot 拿到令牌', Boolean(token), boot);

// ① legacy filter
const r1 = run(['task', 'reap', '--boot', token, '--project', PROJECT, '--filter', 'legacy', '--reason', '沙盘：11-12 历史僵尸', '--json']);
const r1j = JSON.parse(r1.out);
check('① filter=legacy 只处理 2 条 T-20261112-*', r1j.rows && r1j.rows.filter((r) => r.action === 'cancelled').length === 2, r1j.rows);
const readTask = (id) => JSON.parse(fs.readFileSync(path.join(taskDir, `${id}.json`), 'utf8'));
check('① 僵尸状态→cancelled 且带 reason/by', readTask(Z1).status === 'cancelled' && readTask(Z2).status === 'cancelled' && readTask(Z1).cancelReason && readTask(Z1).cancelledBy === 'programmer2', { z1: readTask(Z1).status, by: readTask(Z1).cancelledBy });
check('① 活任务未被动（仍 working）', readTask(LIVE).status === 'working', readTask(LIVE).status);
check('① 审计 2 行', fs.existsSync(auditFile) && fs.readFileSync(auditFile, 'utf8').trim().split(/\r?\n/).length === 2, fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8') : 'missing');

// ② ids 补清 mirror
run(['task', 'reap', '--boot', token, '--project', PROJECT, '--ids', MIR, '--reason', '沙盘：镜像行', '--json']);
check('② ids 清掉镜像 + 审计累计 3 行', readTask(MIR).status === 'cancelled' && fs.readFileSync(auditFile, 'utf8').trim().split(/\r?\n/).length === 3, { mir: readTask(MIR).status });

// ③ 幂等 NOOP
const before = fs.readFileSync(auditFile, 'utf8');
const r3 = run(['task', 'reap', '--boot', token, '--project', PROJECT, '--ids', MIR, '--reason', '沙盘：重复', '--json']);
const r3j = JSON.parse(r3.out);
check('③ 重复 reap → NOOP（action=noop 且无新审计行）', fs.readFileSync(auditFile, 'utf8') === before && Array.isArray(r3j.rows) && r3j.rows.length === 1 && r3j.rows[0].action === 'noop', r3j.rows);

// ④ list --cancelled
const listOut = run(['task', 'list', '--boot', token, '--project', PROJECT, '--cancelled', '--all', '--json']).out;
const listJ = JSON.parse(listOut);
check('④ task list --cancelled 能查到 3 条', Array.isArray(listJ.tasks) && listJ.tasks.filter((t) => t.status === 'cancelled').length === 3, listJ.tasks && listJ.tasks.length);

// ⑤ purge 无 confirm
const r5 = run(['task', 'reap', '--boot', token, '--project', PROJECT, '--ids', LIVE, '--purge', '--reason', '沙盘', '--json'], true);
check('⑤ --purge 无 --confirm → CONFIRM_REQUIRED 且文件仍在', !r5.ok && /CONFIRM_REQUIRED/.test(r5.err + r5.out) && fs.existsSync(path.join(taskDir, `${LIVE}.json`)), r5.err || r5.out);

// ⑥ purge 活任务父需求未收口 → 拒
const r6 = run(['task', 'reap', '--boot', token, '--project', PROJECT, '--ids', LIVE, '--purge', '--confirm', '--reason', '沙盘', '--json'], true);
check('⑥ purge 未收口需求的任务 → PURGE_REFUSED 且文件仍在', !r6.ok && /PURGE_REFUSED/.test(r6.err + r6.out) && fs.existsSync(path.join(taskDir, `${LIVE}.json`)), r6.err || r6.out);

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\nT-7ac3 task reap 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
const evid = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-7ac3');
fs.mkdirSync(evid, { recursive: true });
fs.writeFileSync(path.join(evid, 'run-7ac3.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
if (!process.env.AWB_KEEP_SANDBOX) {
  try { rmSandbox(SB, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch { /* 清理失败不影响结论 */ }
}
