'use strict';
/**
 * R-464f 补单 T-e13e 断言（真实守护路径）：routeTick 两拍/terminated/建失败 三个事件口径。
 *
 * 走真实守护：直接 import route-daemon.mjs 的 routeTick（与 team.mjs route once 同一函数），
 * 用「工作流.json 状态迁移 + 快照 diff」造事件，不直接调 ensureTestTask 造数。
 *
 * 断言：
 * ① 第一拍（dev → dev_done）→ 建 tester 任务，事件 test_task_created
 * ② 第二拍（再触发一次同需求）→ 不重复建，事件 test_task_skipped_existing(reason=existing)
 * ③ 测试任务 terminated → 不新建，事件 test_task_skipped_existing(reason=terminated)
 * ④ 注入 TEAM_TASK_CREATE_FAIL=1 → 事件 test_task_create_failed，且无 action=test 唤醒行（不空唤醒）
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
// B-20261116-055303-07b6：沙盘统一入口（唯一临时目录 + 退出清理）
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
const SB = mkTempSandbox('464f-route-events');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const PROJECT = '464f事件沙盘';
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 360)}`);
  if (!ok) process.exitCode = 1;
}
function run(args) {
  const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
  const text = String(out).trim();
  return JSON.parse(text.slice(text.indexOf('{')));
}
process.env.TEAM_ROOT = TEAM_ROOT;
process.env.TEAM_PROJECTS_ROOT = PROJECTS;
process.env.TEAM_SELFTEST = '1';

fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|\$)/.test(src) });
const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
for (const m of team.members || []) m.sessionId = '';
team.activeProject = PROJECT;
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');

run(['project', 'add', '--name', PROJECT, '--team-mode', 'fast', '--json']);
const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
const taskDir = path.join(stateDir, '任务');
const wfFile = path.join(stateDir, '工作流.json');
const logFile = path.join(stateDir, '路由守护.jsonl');
fs.mkdirSync(taskDir, { recursive: true });

const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.now();
const REQ = 'R-20261115-180001-464f';
const T_DEV = 'T-20261115-180002-dev1';
const round = 2;

const wfOf = (status) => ({
  schema: 2, round: 1, updatedAt: iso(NOW),
  requirements: {
    [REQ]: { id: REQ, title: '464f 事件沙盘需求', status, priority: 'P0', deliveryRound: round, createdAt: iso(NOW - 86400000) },
  },
});
fs.writeFileSync(wfFile, JSON.stringify(wfOf('dev'), null, 2) + '\n', 'utf8');

function writeTask(id, { owner, status, requirementId = REQ, type = 'task', doneAt = null, extra = {} }) {
  const row = {
    id, project: PROJECT, type, requirementId, title: `夹具 ${id}`, detail: '夹具', acceptance: 'AC',
    priority: 'P0', priorityBy: 'pm', priorityReason: '', owner, status,
    createdBy: 'pm', createdAt: iso(NOW - 3600000), claimedAt: iso(NOW - 3000000), due: '',
    doneAt: doneAt ? iso(doneAt) : null, evidence: '', rev: 0, history: [], workflow: { round }, ...extra,
  };
  fs.writeFileSync(path.join(taskDir, `${id}.json`), JSON.stringify(row, null, 2) + '\n', 'utf8');
  return row;
}
const logRows = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);

(async () => {
  const daemon = await import(pathToFileURL(path.join(TEAM_ROOT, '工具', 'lib', 'route-daemon.mjs')).href);
  let tickNo = 0;
  const tick = async () => daemon.routeTick(PROJECT, { now: NOW + (++tickNo) * 1000 });
  /** 真实迁移：先回 dev 再回 dev_done，产生 status 事件（与真实返工/推进同形态），让守护处理一轮。 */
  async function redispatch() {
    fs.writeFileSync(wfFile, JSON.stringify(wfOf('dev'), null, 2) + '\n', 'utf8');
    await tick();
    fs.writeFileSync(wfFile, JSON.stringify(wfOf('dev_done'), null, 2) + '\n', 'utf8');
    return tick();
  }

  writeTask(T_DEV, { owner: 'programmer1', status: 'done', doneAt: NOW - 60000 });
  await tick(); // 基线

  // ① dev → dev_done：建测试任务
  const b1 = logRows().length;
  let t = await redispatch();
  let rows = logRows().slice(b1);
  const created = rows.filter((r) => r.event === 'test_task_created' && String(r.requirementId) === REQ);
  check('① 真实拍：dev_done 建 tester 任务（test_task_created）', created.length >= 1, { events: t.events, rows: rows.map((r) => r.event) });
  const testerFiles = fs.readdirSync(taskDir).filter((f) => {
    try { const j = JSON.parse(fs.readFileSync(path.join(taskDir, f), 'utf8')); return j.owner === 'tester' && String(j.requirementId) === REQ; } catch { return false; }
  });
  const testerRows = testerFiles.map((f) => JSON.parse(fs.readFileSync(path.join(taskDir, f), 'utf8')));
  check('① 只有 1 条 tester 任务，round=2/status=open/owner=tester', testerRows.length === 1
    && Number(testerRows[0].workflow && testerRows[0].workflow.round) === round
    && testerRows[0].status === 'open' && testerRows[0].owner === 'tester',
  testerRows.map((r) => ({ id: r.id, status: r.status, round: r.workflow && r.workflow.round })));

  // ② 第二拍：不重复建，记 skipped_existing(reason=existing)
  const b2 = logRows().length;
  t = await redispatch();
  rows = logRows().slice(b2);
  const existingEvt = rows.filter((r) => r.event === 'test_task_skipped_existing' && r.reason === 'existing' && String(r.requirementId) === REQ);
  const createdAgain = rows.filter((r) => r.event === 'test_task_created');
  check('② 第二拍：记 test_task_skipped_existing(reason=existing)', existingEvt.length >= 1, { events: t.events, rows: rows.map((r) => ({ e: r.event, reason: r.reason, why: r.why })) });
  check('② 第二拍：不重复建（任务数仍 1、无 test_task_created）', createdAgain.length === 0
    && fs.readdirSync(taskDir).filter((f) => { try { const j = JSON.parse(fs.readFileSync(path.join(taskDir, f), 'utf8')); return j.owner === 'tester' && String(j.requirementId) === REQ; } catch { return false; } }).length === 1,
  createdAgain);

  // ③ terminated：不新建，记 skipped_existing(reason=terminated)
  writeTask(testerRows[0].id, { owner: 'tester', status: 'terminated' });
  const b3 = logRows().length;
  t = await redispatch();
  rows = logRows().slice(b3);
  const termEvt = rows.filter((r) => r.event === 'test_task_skipped_existing' && r.reason === 'terminated' && String(r.requirementId) === REQ);
  const createdAfterTerm = rows.filter((r) => r.event === 'test_task_created');
  check('③ terminated：记 test_task_skipped_existing(reason=terminated)', termEvt.length >= 1, { events: t.events, rows: rows.map((r) => ({ e: r.event, reason: r.reason, why: r.why })) });
  check('③ terminated：不新建（任务数仍 1、无 test_task_created）', createdAfterTerm.length === 0
    && fs.readdirSync(taskDir).filter((f) => { try { const j = JSON.parse(fs.readFileSync(path.join(taskDir, f), 'utf8')); return j.owner === 'tester' && String(j.requirementId) === REQ; } catch { return false; } }).length === 1,
  createdAfterTerm);

  // ④ 建失败注入：事件 test_task_create_failed，且无 action=test 唤醒行
  fs.rmSync(path.join(taskDir, `${testerRows[0].id}.json`), { force: true });
  process.env.TEAM_TASK_CREATE_FAIL = '1';
  const b4 = logRows().length;
  t = await redispatch();
  delete process.env.TEAM_TASK_CREATE_FAIL;
  rows = logRows().slice(b4);
  const failEvt = rows.filter((r) => r.event === 'test_task_create_failed' && String(r.requirementId) === REQ);
  const wakeRows = rows.filter((r) => r.event === 'wake' && String(r.action) === 'test');
  check('④ 建失败：事件名 test_task_create_failed', failEvt.length >= 1, { events: t.events, rows: rows.map((r) => ({ e: r.event, why: r.why })) });
  check('④ 建失败：不空唤醒（无 action=test 的 wake 行）', wakeRows.length === 0, wakeRows);

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\nR-464f 事件口径断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
  fs.writeFileSync(path.join(SB, 'run-464f-events.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
})().catch((e) => {
  console.error('RUN_FAILED', e && e.stack || e);
  process.exitCode = 1;
});
