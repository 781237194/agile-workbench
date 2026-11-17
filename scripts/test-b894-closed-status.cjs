#!/usr/bin/env node
'use strict';
/**
 * B-20261117-091007-b894 回归：任务闭环状态口径 done|accepted|cancelled|terminated
 *
 * 现场：62b9 的 B-6029 是 accepted、T-a588 是 cancelled，旧实现只认 done，
 * → accept-prereq.js:82 判「还有 2 条测试任务没 done」→ Owner 点不了【通过】。
 *
 * 断言：
 *   ① 单源：accept-prereq.js 的 CLOSED_TASK_STATUSES 与 gates.mjs 逐项相等（四项，含 terminated）
 *   ② acceptGate(ui)：1 done + 1 accepted + 1 cancelled 测试任务 → canAccept=true
 *   ③ acceptGate(ui)：再加 1 条 open → canAccept=false，原因说「没闭环」并点名该任务
 *   ④ acceptGate(ui)：1 done + 1 terminated → canAccept=true
 *   ⑤ acceptGate(proxy)：证据两件齐全时才 canProxy=true（口径未被动过）
 *   ⑥ 沙盘：3 条开发任务 done/accepted/cancelled → task recompute-advance 推 dev_done
 *
 * 跑法：node scripts/test-b894-closed-status.cjs ｜ 沙盘：mkTempSandbox('b894')
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : String(JSON.stringify(detail)).slice(0, 400) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 400)}`);
  if (!ok) process.exitCode = 1;
}

(async () => {
  // ① 单源一致（gates.mjs 是 ESM，用动态 import）
  const gates = await import('file:///' + path.join(ROOT, '团队', '工具', 'lib', 'gates.mjs').replace(/\\/g, '/'));
  const prereq = require(path.join(ROOT, 'src', 'renderer', 'accept-prereq.js'));
  const a = Array.from(gates.CLOSED_TASK_STATUSES || []);
  const b = Array.from(prereq.CLOSED_TASK_STATUSES || []);
  check('① 闭环状态单源：gates.CLOSED_TASK_STATUSES === accept-prereq.CLOSED_TASK_STATUSES',
    a.length === b.length && a.every((v, i) => v === b[i]) && a.includes('terminated'),
    { gates: a, prereq: b });
  check('① statusIsClosed 认四种、不认 open/working',
    ['done', 'accepted', 'cancelled', 'terminated'].every((s) => gates.statusIsClosed(s))
    && !gates.statusIsClosed('open') && !gates.statusIsClosed('working') && !gates.statusIsClosed('blocked'),
    { open: gates.statusIsClosed('open'), working: gates.statusIsClosed('working') });

  const row = {
    id: 'R-20991111-111111-b894',
    status: 'test_done',
    ownerReview: { status: 'approved', by: 'Owner', actor: 'owner' },
    decisions: [{ status: 'approved', by: 'Owner', actor: 'owner' }],
  };
  const tasks = (statuses) => statuses.map((status, i) => ({
    id: `T-20991111-111111-b89${i}`, project: 'B894沙盘', type: 'task',
    requirementId: row.id, owner: 'tester', status, title: `测试任务${i}`,
    evidence: '测试人员/产出/测试报告-v1.md',
  }));

  // ② 现场复现：accepted + cancelled 不再被当成「没 done」
  const gate2 = prereq.acceptGate(row, tasks(['done', 'accepted', 'cancelled']), { tier: prereq.TIER_OWNER });
  check('② 1 done + 1 accepted + 1 cancelled → Owner 可点【通过】', gate2.canAccept === true, {
    canAccept: gate2.canAccept, missing: gate2.missing.map((m) => m.reason),
  });

  // ③ 真有未闭环任务时仍要拦
  const gate3 = prereq.acceptGate(row, tasks(['done', 'accepted', 'open']), { tier: prereq.TIER_OWNER });
  check('③ 含 1 条 open → 仍拦，且原因说「没闭环」并点名任务',
    gate3.canAccept === false
    && gate3.missing.some((m) => /没闭环/.test(String(m.reason)) && /T-20991111-111111-b892/.test(String(m.reason))),
    { canAccept: gate3.canAccept, missing: gate3.missing.map((m) => m.reason) });

  // ④ terminated 也算闭环
  const gate4 = prereq.acceptGate(row, tasks(['done', 'terminated']), { tier: prereq.TIER_OWNER });
  check('④ 1 done + 1 terminated → 可点【通过】', gate4.canAccept === true, { canAccept: gate4.canAccept });

  // ⑤ proxy 档证据门没被动过
  const gate5 = prereq.acceptGate(row, tasks(['done', 'accepted']), { tier: prereq.TIER_PROXY });
  check('⑤ proxy 档：没有报告/截图时 canProxy=false（证据门不变）', gate5.canProxy === false, {
    canProxy: gate5.canProxy, code: gate5.code,
  });

  // ⑥ 沙盘 advance：3 条开发任务 done/accepted/cancelled → dev_done
  const SB = mkTempSandbox('b894');
  const TEAM_ROOT = path.join(SB, '团队');
  const PROJECTS = path.join(SB, '项目');
  const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
  const PROJECT = 'B894沙盘';
  const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1', TEAM_WORKBENCH_JSON: path.join(SB, 'data', 'userdata', 'workbench.json') };
  fs.mkdirSync(path.join(SB, 'data', 'userdata'), { recursive: true });
  fs.mkdirSync(PROJECTS, { recursive: true });
  fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
  const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
  const teamData = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  (teamData.members || []).forEach((m) => { m.sessionId = ''; });
  delete teamData.activeProject;
  fs.writeFileSync(teamFile, JSON.stringify(teamData, null, 2) + '\n', 'utf8');
  const run = (args) => {
    const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    const text = String(out).trim();
    return JSON.parse(text.slice(text.indexOf('{')));
  };
  run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
  const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-b894-pm', '--json']);
  const req = run(['req', 'create', '--boot', pm.token, '--title', 'B894 闭环推进用例', '--priority', 'P1', '--acceptance', 'accepted/cancelled 不再挡推进', '--json']);
  const reqId = req.requirement && req.requirement.id;
  check('⑥ 夹具：需求已创建', Boolean(reqId), req);
  const statuses = ['done', 'accepted', 'cancelled'];
  const taskIds = [];
  statuses.forEach((st, i) => {
    const t = run(['task', 'create', '--boot', pm.token, '--title', `开发任务${i}`, '--priority', 'P1', '--owner', 'programmer1', '--requirement', reqId, '--json']);
    taskIds.push(t.task.id);
    const file = path.join(TEAM_ROOT, '状态', '项目', PROJECT, '任务', `${t.task.id}.json`);
    const row2 = JSON.parse(fs.readFileSync(file, 'utf8'));
    row2.status = st;
    row2.claimedAt = new Date().toISOString();
    row2.doneAt = new Date().toISOString();
    row2.evidence = 'B894 夹具';
    fs.writeFileSync(file, JSON.stringify(row2, null, 2) + '\n', 'utf8');
  });
  // 需求行置开发阶段（recompute-advance 用它挑触发器/阶段）
  const wfFile = path.join(TEAM_ROOT, '状态', '项目', PROJECT, '工作流.json');
  const wf = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
  wf.requirements = (wf.requirements && typeof wf.requirements === 'object') ? wf.requirements : {};
  wf.requirements[reqId] = { ...(wf.requirements[reqId] || {}), id: reqId, status: 'dev' };
  fs.writeFileSync(wfFile, JSON.stringify(wf, null, 2) + '\n', 'utf8');
  const adv = run(['task', 'recompute-advance', '--boot', pm.token, '--requirement', reqId, '--json']);
  const afterRow = JSON.parse(fs.readFileSync(wfFile, 'utf8')).requirements[reqId];
  check('⑥ 3 条开发任务 done/accepted/cancelled → 需求推到 dev_done',
    String(afterRow && afterRow.status) === 'dev_done', { after: afterRow && afterRow.status, adv });

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nB-894 闭环状态断言：${passed}/${results.length} PASS`);
  const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-b894');
  fs.mkdirSync(evDir, { recursive: true });
  fs.writeFileSync(path.join(evDir, 'run-b894.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, passed, results }, null, 2) + '\n', 'utf8');
})();
