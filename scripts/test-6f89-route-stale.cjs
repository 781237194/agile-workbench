'use strict';
const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * B-20261115-055749-6f89 断言：需求收口后不得再对已 done 任务发 fix 唤醒（陈旧队列唤醒）。
 *
 * AC1 需求行 accepted/terminated/rejected → 不再发 action=fix 唤醒（含已完成前排队的陈旧项）；
 * AC2 同一任务的 fix 唤醒在 task done 后 30 秒内不得再发；
 * AC3 断言覆盖：造「done 任务 + 需求 accepted + 队列里有陈旧 fix」→ 不唤醒、记 skip 原因；
 * AC4 审计：路由守护.jsonl 记 skip 原因（stale_task_done / req_closed），不影响正常 verify 唤醒。
 *
 * 沙盘：_tmp/6f89-route（TEAM_ROOT + TEAM_PROJECTS_ROOT 双隔离 + TEAM_SELFTEST=1 + 清空 sessionId）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', '6f89-route');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '陈旧唤醒沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 320)}`);
  if (!ok) process.exitCode = 1;
}
function run(args) {
  const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
  const text = String(out).trim();
  return JSON.parse(text.slice(text.indexOf('{')));
}
// route-daemon.mjs 是 ESM（core.mjs 在加载时读 TEAM_ROOT），所以必须：
// ① 先设进程级 TEAM_ROOT/TEAM_PROJECTS_ROOT，② 用动态 import 而不是 require。
process.env.TEAM_ROOT = TEAM_ROOT;
process.env.TEAM_PROJECTS_ROOT = PROJECTS;
process.env.TEAM_SELFTEST = '1';

rmSandbox(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
for (const member of team.members || []) member.sessionId = '';
team.activeProject = PROJECT;
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');

run(['project', 'add', '--name', PROJECT, '--team-mode', 'fast', '--json']);
const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
const taskDir = path.join(stateDir, '任务');
const wfFile = path.join(stateDir, '工作流.json');
fs.mkdirSync(taskDir, { recursive: true });

const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.now();

// ── 夹具：三条需求 + 四个缺陷任务 ────────────────────────────────────────
const REQ_CLOSED = 'R-20261115-100001-aaaa';   // accepted（已收口）
const REQ_TERM = 'R-20261115-100002-bbbb';     // terminated
const REQ_DEV = 'R-20261115-100003-cccc';      // dev_done（正常 verify 路径，不能误伤）
const T_DONE = 'B-20261115-200001-dddd';       // 任务已 done（需求已收口）
const T_DONE_FRESH = 'B-20261115-200002-eeee'; // 任务 done 10 秒前（需求未收口）
const T_DONE_OLD = 'B-20261115-200003-ffff';   // 任务 done 40 秒前（需求未收口）
const T_VERIFY = 'B-20261115-200004-9999';     // 需求 dev_done，正常 verify
const T_WORKING_CLOSED = 'B-20261115-200005-8888'; // 仍在 working，但需求已收口（陈旧队列的真凶形态）

const wf = {
  schema: 2,
  round: 1,
  updatedAt: iso(NOW),
  requirements: {
    [REQ_CLOSED]: { id: REQ_CLOSED, title: '已收口需求', status: 'accepted', priority: 'P1', createdAt: iso(NOW - 86400000) },
    [REQ_TERM]: { id: REQ_TERM, title: '已终止需求', status: 'terminated', priority: 'P2', createdAt: iso(NOW - 86400000) },
    [REQ_DEV]: { id: REQ_DEV, title: '开发完待测需求', status: 'dev_done', priority: 'P1', createdAt: iso(NOW - 86400000) },
  },
};
fs.writeFileSync(wfFile, JSON.stringify(wf, null, 2) + '\n', 'utf8');

function bugTask(id, { status, doneAt, requirementId, owner = 'programmer1' }) {
  const row = {
    id, project: PROJECT, type: 'bug', requirementId, title: `缺陷夹具 ${id}`,
    detail: '夹具', acceptance: 'AC', repro: '复现', priority: 'P1', priorityBy: 'pm', priorityReason: '',
    owner, status, createdBy: 'pm', createdAt: iso(NOW - 3600000), claimedAt: iso(NOW - 3000000),
    due: '', doneAt: doneAt ? iso(doneAt) : null, evidence: '', rev: 0, history: [],
    workflow: { requirementStatus: 'dev_done' },
  };
  fs.writeFileSync(path.join(taskDir, `${id}.json`), JSON.stringify(row, null, 2) + '\n', 'utf8');
  return row;
}
const tDone = bugTask(T_DONE, { status: 'done', doneAt: NOW - 120000, requirementId: REQ_CLOSED });
const tFresh = bugTask(T_DONE_FRESH, { status: 'done', doneAt: NOW - 10000, requirementId: REQ_DEV });
const tOld = bugTask(T_DONE_OLD, { status: 'done', doneAt: NOW - 40000, requirementId: REQ_DEV });
const tVerify = bugTask(T_VERIFY, { status: 'done', doneAt: NOW - 5000, requirementId: REQ_DEV });
const tWorkingClosed = bugTask(T_WORKING_CLOSED, { status: 'working', doneAt: null, requirementId: REQ_CLOSED });

// ── ① 守卫单元断言（AC1/AC2/AC4）────────────────────────────────────────
(async () => {
const daemon = await import(require('node:url').pathToFileURL(path.join(TEAM_ROOT, '工具', 'lib', 'route-daemon.mjs')).href);
const rows = { [REQ_CLOSED]: { id: REQ_CLOSED, status: 'accepted' }, [REQ_TERM]: { id: REQ_TERM, status: 'terminated' }, [REQ_DEV]: { id: REQ_DEV, status: 'dev_done' } };
const g1 = daemon.staleWakeGuard({ projectName: PROJECT, action: 'fix', task: tDone, row: rows[REQ_CLOSED], now: NOW });
check('① 已收口需求 + done 任务 → req_closed', g1 && g1.skip === 'req_closed', g1);
const g2 = daemon.staleWakeGuard({ projectName: PROJECT, action: 'fix', task: tDone, row: rows[REQ_TERM], now: NOW });
check('① 已终止需求 + done 任务 → req_closed', g2 && g2.skip === 'req_closed', g2);
const g3 = daemon.staleWakeGuard({ projectName: PROJECT, action: 'fix', task: tDone, row: rows[REQ_DEV], now: NOW });
check('① 需求未收口但任务已 done → stale_task_done', g3 && g3.skip === 'stale_task_done', g3);
const g3b = daemon.staleWakeGuard({ projectName: PROJECT, action: 'fix', task: { ...tOld, status: 'working', doneAt: iso(NOW - 10000) }, row: rows[REQ_DEV], now: NOW });
check('② done 后 10 秒内（状态还是旧值 working）→ stale_task_done', g3b && g3b.skip === 'stale_task_done', g3b);
const g3c = daemon.staleWakeGuard({ projectName: PROJECT, action: 'fix', task: { ...tOld, status: 'working', doneAt: iso(NOW - 40000) }, row: rows[REQ_DEV], now: NOW });
check('② done 后 40 秒（超过 30 秒窗口）→ 放行（不误伤真正没做完的）', g3c === null, g3c);
const g4 = daemon.staleWakeGuard({ projectName: PROJECT, action: 'verify', task: tVerify, row: rows[REQ_DEV], now: NOW });
check('④ 需求 dev_done 的 verify 唤醒不受影响', g4 === null, g4);

// ── ② 队列陈旧项（AC1/AC3/AC4）：tick 不唤醒、记 skip 原因 ─────────────
const token = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-6f89', '--json']).token;
  await daemon.routeTick(PROJECT, { now: NOW });                    // 第一拍：建基线（不补发历史）
  const statusFile = path.join(stateDir, '守护状态.json');
  const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  const staleKey = `stale|${T_DONE}|fix`;
  status.followUps = {
    ...(status.followUps || {}),
    [staleKey]: {
      role: 'programmer1', action: 'fix', requirementId: REQ_CLOSED, taskId: T_DONE,
      fromStatus: 'working', toStatus: 'done', attempts: 0, busySkips: 0, dueAt: 0, at: iso(NOW - 5000),
    },
  };
  status.retries = {
    ...(status.retries || {}),
    [`retry|${T_DONE}`]: {
      role: 'programmer1', action: 'fix', requirementId: REQ_CLOSED, taskId: T_DONE,
      fromStatus: 'working', toStatus: 'done', attempt: 1, dueAt: 0, source: 'task',
    },
  };
  fs.writeFileSync(statusFile, JSON.stringify(status, null, 2) + '\n', 'utf8');

  const before = daemon.readRouteLog(PROJECT).length;
  const tick = await daemon.routeTick(PROJECT, { now: NOW + 1000 });
  const logRows = daemon.readRouteLog(PROJECT).slice(before);
  const skipRows = logRows.filter((row) => String(row.event) === 'skip' && /req_closed|stale_task_done/.test(String(row.why || '')));
  const wakeRows = logRows.filter((row) => String(row.event) === 'wake' && (String(row.taskId) === T_DONE || String(row.action) === 'fix'));
  check('③ 队列陈旧 fix → 记 skip（req_closed / stale_task_done）', skipRows.length >= 2, skipRows.map((r) => `${r.why}@${r.key || ''}`));
  check('③ 队列陈旧 fix → 没有任何 wake', wakeRows.length === 0, wakeRows.map((r) => `${r.event}/${r.action}/${r.taskId}`));
  const after = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  check('③ 陈旧项已从队列摘除（followUps/retries 清理）',
    !(after.followUps || {})[staleKey] && !(after.retries || {})[`retry|${T_DONE}`],
    { followUps: Object.keys(after.followUps || {}), retries: Object.keys(after.retries || {}) });
  check('④ 审计行带 why 与 taskId（可对账）',
    skipRows.every((row) => String(row.why || '') && String(row.event) === 'skip') && skipRows.some((row) => String(row.taskId) === T_DONE),
    skipRows.map((row) => ({ why: row.why, taskId: row.taskId })));

  // ── ③ 正常路径不受影响：dev_done 需求仍会叫 tester ─────────────────────
  const plan = daemon.planRoutes(PROJECT, { now: NOW + 2000 });
  const devRow = (plan.rows || []).find((row) => String(row.requirementId) === REQ_DEV);
  check('④ dev_done 需求的计划仍是正常唤醒（不是 req_closed 误杀）',
    !plan.rows || !devRow || devRow.why !== 'req_closed', devRow && { decision: devRow.decision, action: devRow.action, why: devRow.why });

  // ── ④ 角色队列（role_queues.json）也不得挂已收口需求的 fix（AC1「陈旧队列」）──
  const queues = await import(require('node:url').pathToFileURL(path.join(TEAM_ROOT, '工具', 'lib', 'route-queues.mjs')).href);
  const payload = queues.buildRoleQueues(PROJECT);
  const allItems = Object.values(payload.roles || {}).flatMap((role) => role.queue || []);
  const closedClean = allItems.filter((item) => item.action === 'fix'
    && [REQ_CLOSED, REQ_TERM].includes(String(item.requirementId || '')));
  check('① 角色队列里没有已收口需求的 fix 项', closedClean.length === 0, closedClean.map((item) => `${item.taskId}@${item.requirementId}`));
  const workingClosedInQueue = allItems.filter((item) => String(item.taskId) === T_WORKING_CLOSED);
  check('① 需求已收口但任务还在 working → 也不进角色队列（陈旧 fix 的真凶形态）',
    workingClosedInQueue.length === 0, workingClosedInQueue.map((item) => `${item.taskId}/${item.action}`));
  const g5 = daemon.staleWakeGuard({ projectName: PROJECT, action: 'fix', task: tWorkingClosed, row: rows[REQ_CLOSED], now: NOW });
  check('① 同上：守卫命中 req_closed（不是等任务变 done 才拦）', g5 && g5.skip === 'req_closed', g5);
  const doneTaskInQueue = allItems.filter((item) => String(item.taskId) === T_DONE);
  check('① 已 done 任务不进角色队列', doneTaskInQueue.length === 0, doneTaskInQueue);

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\nB-6f89 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
  fs.writeFileSync(path.join(SB, 'run-6f89.json'), JSON.stringify({ passed, failed, results, tokenPresent: Boolean(token) }, null, 2) + '\n', 'utf8');
})().catch((error) => {
  console.error('断言脚本失败：', (error && error.stack) || error);
  process.exit(2);
});
