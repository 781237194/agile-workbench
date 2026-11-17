#!/usr/bin/env node
'use strict';
/**
 * B-20261117-214907-6f23 夹具：返工期（iteration）不再冻结任务 / 旧冻结会被解冻。
 *
 * 判据：
 *   ① Owner 打回（rejected）→ 该需求未完成任务冻结 blocked（blockedCause=rejected），审计 code=OWNER_REJECTED；
 *   ② PM req iterate（decisionStatus=iteration 或 行 status=iteration）→ **解冻**回原状态，审计 code=OWNER_ITERATION，
 *      不再出现「blocked 死锁、claim 先判门禁 → 解不开」；
 *   ③ 已经在 iteration 的干净需求再跑 iterate → NOOP（不冻结、不动任务）；
 *   ④ terminate 仍冻结（blockedCause=terminated）——收紧与回归；
 *   ⑤ decisionEffect 矩阵：rejected/terminated 冻结，iteration/approved 解冻，其他 noop。
 *
 * 隔离：TEAM_ROOT/TEAM_PROJECTS_ROOT/TEAM_SELFTEST=1 + 唯一 _tmp 沙盘。
 * 跑法：node scripts/test-6f23-iteration-freeze.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const { mkTempSandbox, rmSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
const PROJECT = '6f23-freeze-sandbox';
const ROLES = { pm: '项目经理', product: '产品', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 800)}`);
  if (!ok) process.exitCode = 1;
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };

const root = mkTempSandbox('6f23');
const TEAM = path.join(root, '团队');
const STATE = path.join(TEAM, '状态');
const PROJ_STATE = path.join(STATE, '项目', PROJECT);
const realRoster = readJson(path.join(ROOT, '团队', '状态', '团队.json'), { members: [] });
const members = (realRoster.members || []).filter((m) => m && ROLES[m.role]).map((m) => ({ ...m, sessionId: `sess-6f23-${m.role}`, status: 'active' }));
writeJson(path.join(STATE, '团队.json'), { version: 1, activeProject: PROJECT, members });
writeJson(path.join(PROJ_STATE, '项目.json'), { name: PROJECT, path: root, teamMode: 'full', roleIds: Object.keys(ROLES) });
writeJson(path.join(PROJ_STATE, '工作流.json'), { schema: 2, project: PROJECT, round: 1, requirements: {}, boots: {} });
fs.mkdirSync(path.join(PROJ_STATE, '任务'), { recursive: true });

const env = {
  ...process.env,
  TEAM_ROOT: TEAM,
  TEAM_PROJECTS_ROOT: path.join(STATE, '项目'),
  TEAM_WORKBENCH_JSON: path.join(root, 'workbench.json'),
  TEAM_SELFTEST: '1',
  __PROJECT: PROJECT,
  __STORE: path.join(ROOT, '团队', '工具', 'lib', 'store.mjs'),
  __FREEZE: path.join(ROOT, '团队', '工具', 'lib', 'task-freeze.mjs'),
};
const child = `
const { pathToFileURL } = require('node:url');
(async () => {
  const store = await import(pathToFileURL(process.env.__STORE).href);
  const freeze = await import(pathToFileURL(process.env.__FREEZE).href);
  const P = process.env.__PROJECT;
  const out = { tasks: {}, audits: [], effects: {} };
  const mk = (title, reqId) => store.createTask({ project: P, title, priority: 'P2', priorityBy: 'pm', createdBy: 'pm', owner: 'programmer1', type: 'task', requirementId: reqId });
  const t1 = mk('返工用例任务一', 'R-TEST-6F23');
  const t2 = mk('返工用例任务二', 'R-TEST-6F23');
  const t3 = mk('干净迭代任务', 'R-TEST-6F23-B');
  const snap = (id) => { const t = store.loadTask(P, id); return { id, status: t.status, beforeStatus: t.beforeStatus || '', blockedCause: t.blockedCause || '' }; };
  // ① rejected 冻结
  out.effects.rejected = freeze.applyOwnerDecisionEffects(P, 'R-TEST-6F23', 'rejected', { row: { status: 'rejected' }, by: 'owner', source: 'cli' });
  out.tasks.afterRejected = [snap(t1.id), snap(t2.id)];
  // ② iterate 解冻
  out.effects.iteration = freeze.applyOwnerDecisionEffects(P, 'R-TEST-6F23', 'iteration', { row: { status: 'iteration' }, by: 'pm', source: 'cli' });
  out.tasks.afterIterate = [snap(t1.id), snap(t2.id)];
  // ③ 干净 iteration 再 iterate → noop
  out.effects.iterateClean = freeze.applyOwnerDecisionEffects(P, 'R-TEST-6F23-B', 'iteration', { row: { status: 'iteration' }, by: 'pm', source: 'cli' });
  out.tasks.clean = [snap(t3.id)];
  // ④ terminate 仍冻结
  out.effects.terminated = freeze.applyOwnerDecisionEffects(P, 'R-TEST-6F23-B', 'terminated', { row: { status: 'terminated' }, by: 'owner', source: 'cli' });
  out.tasks.afterTerminate = [snap(t3.id)];
  // ⑤ decisionEffect 矩阵
  out.effects.matrix = [
    ['status=rejected', freeze.decisionEffect({ status: 'x' }, 'rejected')],
    ['status=terminated', freeze.decisionEffect(null, 'terminated')],
    ['status=iteration', freeze.decisionEffect({ status: 'iteration' }, 'iteration')],
    ['row=iteration', freeze.decisionEffect({ status: 'iteration' }, '')],
    ['status=approved', freeze.decisionEffect({ status: 'iteration' }, 'approved')],
    ['row=rejected', freeze.decisionEffect({ status: 'rejected' }, '')],
    ['none', freeze.decisionEffect({ status: 'dev' }, '')],
  ];
  const auditFile = require('node:fs').readFileSync(require('node:path').join(process.env.TEAM_ROOT, '状态', '项目', P, '闸门审计.jsonl'), 'utf8').split(/\\r?\\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  out.audits = auditFile.map((r) => ({ action: r.action, code: r.code, taskId: r.taskId, requirementId: r.requirementId }));
  console.log('@@6F23@@' + JSON.stringify(out));
})().catch((e) => console.log('@@6F23@@' + JSON.stringify({ fatal: String((e && e.stack) || e) })));
`;
const r = spawnSync(process.execPath, ['-e', child], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env });
const line = String(r.stdout || '').split(/\r?\n/).find((x) => x.includes('@@6F23@@'));
let out = null;
try { out = line ? JSON.parse(line.split('@@6F23@@')[1]) : null; } catch { out = null; }
const tasks = (out && out.tasks) || {};
const effects = (out && out.effects) || {};
const audits = (out && out.audits) || [];

check('F0 沙盘：rejected 冻结两条任务为 blocked（blockedCause=rejected，保留 beforeStatus=working）',
  (tasks.afterRejected || []).length === 2 && tasks.afterRejected.every((t) => t.status === 'blocked' && t.blockedCause === 'rejected' && t.beforeStatus === 'working'),
  { afterRejected: tasks.afterRejected, fatal: out && out.fatal, stderr: String(r.stderr || '').slice(0, 300) });
check('F1 PM iterate → 两条任务**解冻**回 working（不再 blocked 死锁）',
  (tasks.afterIterate || []).length === 2 && tasks.afterIterate.every((t) => t.status === 'working' && !t.blockedCause && !t.beforeStatus)
    && effects.iteration && effects.iteration.mode === 'unfreeze' && (effects.iteration.unfrozen || []).length === 2,
  { afterIterate: tasks.afterIterate, iteration: effects.iteration });
check('F2 审计：冻结 OWNER_REJECTED、解冻 OWNER_ITERATION（action=task_freeze/task_unfreeze）',
  audits.some((a) => a.action === 'task_freeze' && a.code === 'OWNER_REJECTED') && audits.some((a) => a.action === 'task_unfreeze' && a.code === 'OWNER_ITERATION'),
  { audits });
check('F3 干净需求（任务本就 working）再要求 iteration → NOOP，任务不动、无新增冻结',
  tasks.clean && tasks.clean[0] && tasks.clean[0].status === 'working' && effects.iterateClean && effects.iterateClean.mode === 'unfreeze'
    && (effects.iterateClean.unfrozen || []).length === 0,
  { clean: tasks.clean, iterateClean: effects.iterateClean });
check('F4 terminate 仍冻结（blockedCause=terminated），审计 OWNER_TERMINATED',
  tasks.afterTerminate && tasks.afterTerminate[0] && tasks.afterTerminate[0].status === 'blocked' && tasks.afterTerminate[0].blockedCause === 'terminated'
    && audits.some((a) => a.action === 'task_freeze' && a.code === 'OWNER_TERMINATED'),
  { afterTerminate: tasks.afterTerminate, audits });
const matrix = Object.fromEntries(((effects.matrix) || []).map((x) => [x[0], x[1]]));
check('F5 decisionEffect 矩阵：rejected/terminated→freeze，iteration/approved→unfreeze（iteration code=OWNER_ITERATION），其他 noop',
  matrix['status=rejected'].mode === 'freeze' && matrix['status=terminated'].mode === 'freeze'
  && matrix['status=iteration'].mode === 'unfreeze' && matrix['status=iteration'].code === 'OWNER_ITERATION'
  && matrix['row=iteration'].mode === 'unfreeze' && matrix['status=approved'].mode === 'unfreeze'
  && matrix['row=rejected'].mode === 'freeze' && matrix['none'].mode === 'noop',
  { matrix });

const total = results.length;
const pass = results.filter((x) => x.ok).length;
const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-6f23');
fs.mkdirSync(evDir, { recursive: true });
const evFile = path.join(evDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${total - pass === 0 ? 'green' : 'red'}.json`);
fs.writeFileSync(evFile, JSON.stringify({ task: 'B-20261117-214907-6f23', at: new Date().toISOString(), total, pass, red: total - pass, results, raw: out }, null, 2) + '\n', 'utf8');
console.log(`\n6F23_${total - pass === 0 ? 'OK' : 'RED'} ${JSON.stringify({ total, pass, red: total - pass })}`);
console.log(`证据：${evFile}`);
if (process.env.AWB_KEEP_SANDBOX !== '1') { try { rmSandbox(root); } catch { /* ignore */ } }
