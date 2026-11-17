'use strict';
const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * R-9fbe / T-20261115-063059-09e9 断言：账本分叉判定（带「重开时间」维度）。
 *
 * AC 覆盖：
 *   AC2 重开维度：taskDoneAt < reopenedAt → 返工在途，不算分叉（43ad 那种）
 *   AC3 req sync 收紧：作废三向 PASS 之外，账本分叉也算违规（R6_LEDGER_FORK）
 *   AC4 夹具：真分叉 → 1 行（每个夹具 1 条违规）；处置后（task release / req reopen 走 team.mjs）→ 0 分叉
 *   另：壳层（team-tools 快照）与工具（req sync）同源判据一致
 *
 * 沙盘：_tmp/9fbe-ledger（TEAM_ROOT + TEAM_PROJECTS_ROOT 双隔离 + TEAM_SELFTEST=1 + 清空 sessionId）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', '9fbe-ledger');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '账本分叉沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };
process.env.TEAM_ROOT = TEAM_ROOT;
process.env.TEAM_PROJECTS_ROOT = PROJECTS;
process.env.TEAM_SELFTEST = '1';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 340)}`);
  if (!ok) process.exitCode = 1;
}
function run(args, allowFail = false) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    const text = String(out).trim();
    return JSON.parse(text.slice(text.indexOf('{')));
  } catch (e) {
    const text = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    if (!allowFail) throw new Error(text.slice(0, 600));
    try { return JSON.parse(text.slice(text.indexOf('{'))); } catch { return { ok: false, raw: text.slice(0, 300) }; }
  }
}

rmSandbox(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
for (const member of team.members || []) member.sessionId = '';
team.activeProject = PROJECT;
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');

run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-9fbe', '--json']);
const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
const taskDir = path.join(stateDir, '任务');
const wfFile = path.join(stateDir, '工作流.json');
fs.mkdirSync(taskDir, { recursive: true });

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// ── 夹具 ────────────────────────────────────────────────────────────────
const R_FORK = 'R-20261115-200001-f001';      // dev + 开发任务已 done、没重开 → 真分叉（dev_ledger_ahead）
const R_TASKFORK = 'R-20261115-200002-f002';  // dev_done + 测试任务已 done、没重开 → 真分叉（test_ledger_ahead）
const R_REWORK = 'R-20261115-200003-f003';    // dev + 任务 done 后重开 + 补单在办 → 返工在途（不算分叉）
const R_REWORK2 = 'R-20261115-200004-f004';   // dev + 任务 done 后重开、补单还没派 → 返工在途（不算分叉）
const R_DEVDONE = 'R-20261115-200005-f005';   // dev_done + 开发任务全 done → 正常过渡（不算分叉）
const R_TESTDONE = 'R-20261115-200006-f006';  // test_done + 全部任务 done → 等验收（不算分叉）
const R_ACCEPTED = 'R-20261115-200007-f007';  // accepted → 收口（不算分叉）

const wf = {
  schema: 2, round: 1, updatedAt: iso(NOW),
  requirements: {
    [R_FORK]: { id: R_FORK, title: '真分叉夹具', status: 'dev', priority: 'P1', createdAt: iso(NOW - 86400000), history: [{ at: iso(NOW - 80000000), action: 'req_review', by: 'product', note: 'v1' }] },
    [R_TASKFORK]: { id: R_TASKFORK, title: '测试账本超前夹具', status: 'dev_done', priority: 'P1', createdAt: iso(NOW - 86400000) },
    [R_REWORK]: { id: R_REWORK, title: '返工在途夹具（有补单）', status: 'dev', priority: 'P1', createdAt: iso(NOW - 86400000), lastReopenAt: iso(NOW - 3600000), reopenCount: 1, gateInvalidatedAt: iso(NOW - 3600000) },
    [R_REWORK2]: { id: R_REWORK2, title: '返工在途夹具（无补单，靠 history）', status: 'dev', priority: 'P1', createdAt: iso(NOW - 86400000), history: [{ at: iso(NOW - 7200000), action: 'req_reopen', by: 'pm', note: '测试 FAIL 返工' }] },
    [R_DEVDONE]: { id: R_DEVDONE, title: '开发完成夹具', status: 'dev_done', priority: 'P1', createdAt: iso(NOW - 86400000) },
    [R_TESTDONE]: { id: R_TESTDONE, title: '待验收夹具', status: 'test_done', priority: 'P1', createdAt: iso(NOW - 86400000) },
    [R_ACCEPTED]: { id: R_ACCEPTED, title: '已验收夹具', status: 'accepted', priority: 'P1', createdAt: iso(NOW - 86400000) },
  },
};
fs.writeFileSync(wfFile, JSON.stringify(wf, null, 2) + '\n', 'utf8');

function task(id, { type = 'task', status, owner, requirementId, doneAt, title }) {
  const row = {
    id, project: PROJECT, type, requirementId, title: title || `夹具任务 ${id}`,
    detail: '夹具', acceptance: 'AC', repro: type === 'bug' ? '复现' : '', priority: 'P1', priorityBy: 'pm', priorityReason: '',
    owner, status, createdBy: 'pm', createdAt: iso(NOW - 9000000), claimedAt: iso(NOW - 8000000),
    due: '', doneAt: doneAt ? iso(doneAt) : null, evidence: doneAt ? '夹具证据' : '', rev: 0, history: [], workflow: {},
  };
  fs.writeFileSync(path.join(taskDir, `${id}.json`), JSON.stringify(row, null, 2) + '\n', 'utf8');
  return row;
}
const T_FORK = 'T-20261115-210001-0001';
const T_TASKFORK = 'T-20261115-210002-0002';
const T_REWORK_OLD = 'T-20261115-210003-0003';
const T_REWORK_NEW = 'T-20261115-210004-0004';
const T_REWORK2_OLD = 'T-20261115-210005-0005';
const T_DEVDONE = 'T-20261115-210006-0006';
const T_TESTDONE = 'T-20261115-210007-0007';
task(T_FORK, { status: 'done', owner: 'programmer1', requirementId: R_FORK, doneAt: NOW - 7200000 });
task(T_TASKFORK, { status: 'done', owner: 'tester', requirementId: R_TASKFORK, doneAt: NOW - 3600000 });
task(T_REWORK_OLD, { status: 'done', owner: 'programmer1', requirementId: R_REWORK, doneAt: NOW - 7200000 });
task(T_REWORK_NEW, { status: 'working', owner: 'programmer1', requirementId: R_REWORK });
task(T_REWORK2_OLD, { status: 'done', owner: 'programmer1', requirementId: R_REWORK2, doneAt: NOW - 9000000 });
task(T_DEVDONE, { status: 'done', owner: 'programmer1', requirementId: R_DEVDONE, doneAt: NOW - 1800000 });
task(T_TESTDONE, { status: 'done', owner: 'tester', requirementId: R_TESTDONE, doneAt: NOW - 1800000 });

(async () => {
  const ledger = await import(require('node:url').pathToFileURL(path.join(TEAM_ROOT, '工具', 'lib', 'ledger.mjs')).href);
  const tasks = fs.readdirSync(taskDir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fs.readFileSync(path.join(taskDir, n), 'utf8')));
  const rows = JSON.parse(fs.readFileSync(wfFile, 'utf8')).requirements;
  const detection = ledger.detectLedgerForks({ requirements: rows, tasks });
  const forkIds = detection.forks.map((f) => f.requirementId).sort();
  check('① 真分叉夹具 2 条被识别（dev 账本超前 + 测试账本超前）',
    JSON.stringify(forkIds) === JSON.stringify([R_FORK, R_TASKFORK].sort()), forkIds);
  const kinds = Object.fromEntries(detection.forks.map((f) => [f.requirementId, f.kind]));
  check('① 分叉类型正确（dev_ledger_ahead / test_ledger_ahead）',
    kinds[R_FORK] === 'dev_ledger_ahead' && kinds[R_TASKFORK] === 'test_ledger_ahead', kinds);
  const inflight = Object.fromEntries(detection.inFlight.map((f) => [f.requirementId, f.kind]));
  check('② 重开后任务 done → 返工在途（有补单=task_in_progress，无补单=rework_in_flight）',
    inflight[R_REWORK] === 'task_in_progress' && inflight[R_REWORK2] === 'rework_in_flight', inflight);
  check('② 43ad 型（done < reopenedAt）不判分叉', !forkIds.includes(R_REWORK) && !forkIds.includes(R_REWORK2), forkIds);
  check('① dev_done / test_done / accepted 都不判分叉',
    ![R_DEVDONE, R_TESTDONE, R_ACCEPTED].some((id) => forkIds.includes(id)), forkIds);
  const view43 = ledger.requirementLedger({ ...rows[R_REWORK], id: R_REWORK }, tasks);
  check('② reopenedAt 来源优先级（lastReopenAt 优先于 history/gateInvalidatedAt）',
    view43.reopenedAt === String(rows[R_REWORK].lastReopenAt), view43.reopenedAt);
  const viewHistory = ledger.requirementLedger({ ...rows[R_REWORK2], id: R_REWORK2 }, tasks);
  check('② 没有 lastReopenAt 时从 history 的 req_reopen 取',
    viewHistory.reopenedAt === String(rows[R_REWORK2].history[0].at), viewHistory.reopenedAt);

  // ── AC3：team.mjs req sync 收紧判据（作废三向 PASS ≠ 无分叉）──
  const sync1 = run(['req', 'sync', '--boot', pm.token, '--project', PROJECT, '--json'], true);
  const r6 = (sync1.violations || []).filter((v) => v.rule === 'R6_LEDGER_FORK');
  check('③ req sync 把账本分叉算违规（R6_LEDGER_FORK，2 条）', r6.length === 2 && sync1.ok === false, r6.map((v) => v.id));
  check('③ 作废三向本身没问题（违规全部来自 R6，不是 R0–R5）',
    (sync1.violations || []).every((v) => v.rule === 'R6_LEDGER_FORK'), sync1.violations.map((v) => v.rule));
  check('③ 返工在途进警告而不是违规',
    (sync1.warnings || []).some((w) => w.rule === 'W2_REWORK_IN_FLIGHT') && !r6.some((v) => v.id === R_REWORK), (sync1.warnings || []).map((w) => w.rule));

  // ── 壳层同源：team-tools 快照的 forks 与工具一致 ──
  const tools = require(path.join(ROOT, 'src', 'team-tools.js')).create({ teamRoot: TEAM_ROOT });
  const snap = tools.readWorkflowSnapshot(PROJECT, path.join(PROJECTS, PROJECT));
  const shellForks = (snap.ledger && snap.ledger.forks || []).map((f) => f.requirementId).sort();
  check('④ 壳层快照与工具判据同源（forks id 集合一致）',
    JSON.stringify(shellForks) === JSON.stringify(forkIds), { shell: shellForks, tool: forkIds });
  const rowFork = (snap.requirements || []).find((r) => r.id === R_FORK) || null;
  const row43 = (snap.requirements || []).find((r) => r.id === R_REWORK) || null;
  check('④ 需求行带 reopenedAt / ledgerFork / ledgerInFlight（给面板与 A 的字段）',
    Boolean(rowFork) && rowFork.ledgerFork && rowFork.ledgerFork.kind === 'dev_ledger_ahead'
    && Boolean(row43) && row43.reopenedAt && row43.ledgerInFlight === 'task_in_progress' && row43.ledgerFork === null,
    { fork: rowFork && rowFork.ledgerFork, rework: row43 && { reopenedAt: row43.reopenedAt, inFlight: row43.ledgerInFlight } });
  check('④ counts.ledgerForks / ledgerInFlight 可给面板直接用',
    Number(snap.counts.ledgerForks) === 2 && Number(snap.counts.ledgerInFlight) === 2,
    { forks: snap.counts.ledgerForks, inFlight: snap.counts.ledgerInFlight });

  // ── AC4：两个处置入口（都走 team.mjs + 审计），处置后分叉=0 ──
  const released = run(['task', 'release', '--boot', pm.token, '--project', PROJECT, '--id', T_FORK, '--reason', '分叉处置：任务退回在办', '--json'], true);
  check('④ 处置入口 A：task release 成功（走 team.mjs，有事件审计）',
    released.ok === true && String((released.task || {}).status) === 'open', released.code || released.task);
  const reopened = run(['req', 'reopen', '--boot', pm.token, '--project', PROJECT, '--requirement', R_TASKFORK, '--reason', '分叉处置：测试账本超前，正式返工', '--json'], true);
  check('④ 处置入口 B：req reopen 成功（写 lastReopenAt + gateInvalidatedAt）',
    reopened.ok === true && String(reopened.toStatus) === 'dev', reopened.code || reopened.toStatus);
  const sync2 = run(['req', 'sync', '--boot', pm.token, '--project', PROJECT, '--json'], true);
  check('④ 处置后 req sync 分叉=0（ok=true）',
    sync2.ok === true && (sync2.ledger.forks || []).length === 0,
    { ok: sync2.ok, forks: (sync2.ledger.forks || []).map((f) => f.requirementId), violations: (sync2.violations || []).map((v) => v.rule + ':' + v.id) });

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\nR-9fbe 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
  fs.writeFileSync(path.join(SB, 'run-9fbe.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
})().catch((error) => {
  console.error('断言脚本失败：', (error && error.stack) || error);
  process.exit(2);
});
