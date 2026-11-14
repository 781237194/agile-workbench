'use strict';
/** R-d225 回归：req reopen（状态映射/轮次+1/门禁失效标记/任务继承 round/旧轮不推回/不适用状态）。 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'd225-reopen');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TEAM_TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '返工沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 260)}`);
  if (!ok) process.exitCode = 1;
}
function run(args, allowFail = false) {
  try {
    const out = execFileSync(process.execPath, [TEAM_TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    const t = String(out).trim();
    return JSON.parse(t.slice(t.indexOf('{')));
  } catch (e) {
    const text = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    if (allowFail) { try { return JSON.parse(text.slice(text.indexOf('{'))); } catch { return { ok: false, raw: text.slice(0, 200) }; } }
    throw e;
  }
}
fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true });
run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm', '--json']);
const dev1 = run(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-p1', '--json']);
const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
const wfFile = path.join(stateDir, '工作流.json');
const taskDir = path.join(stateDir, '任务');
const readWf = () => JSON.parse(fs.readFileSync(wfFile, 'utf8'));
const rowOf = (id) => (readWf().requirements || {})[id] || {};

function setReqStatus(id, status, extra = {}) {
  const wf = fs.existsSync(wfFile) ? readWf() : { schema: 2, project: PROJECT, round: 1, phase: 'dev', requirements: {}, events: [] };
  wf.requirements = wf.requirements || {};
  wf.requirements[id] = { ...(wf.requirements[id] || {}), id, status, decisions: [{ status: 'approved', channel: 'ui', at: '2026-11-15T00:00:00.000Z' }], ...extra };
  fs.writeFileSync(wfFile, JSON.stringify(wf, null, 2) + '\n', 'utf8');
  const tf = path.join(taskDir, `${id}.json`);
  const t = JSON.parse(fs.readFileSync(tf, 'utf8'));
  t.status = status; t.workflow = t.workflow || {}; t.workflow.status = status; t.workflow.decisions = wf.requirements[id].decisions;
  fs.writeFileSync(tf, JSON.stringify(t, null, 2) + '\n', 'utf8');
  return wf.requirements[id];
}
function mkTask(title, reqId, { owner = 'programmer1', round = 1 } = {}) {
  const r = run(['task', 'create', '--boot', pm.token, '--project', PROJECT, '--title', title, '--priority', 'P0', '--type', 'task', '--owner', owner, '--requirement', reqId, '--json'], true);
  const id = r.task && r.task.id;
  if (id && round !== null) {
    const tf = path.join(taskDir, `${id}.json`);
    const t = JSON.parse(fs.readFileSync(tf, 'utf8'));
    t.workflow = { ...(t.workflow || {}), round };
    fs.writeFileSync(tf, JSON.stringify(t, null, 2) + '\n', 'utf8');
  }
  return id;
}

// 需求 A：dev_done + 旧轮 done 开发任务
const reqId = run(['req', 'create', '--boot', pm.token, '--project', PROJECT, '--title', '返工需求', '--priority', 'P0', '--acceptance', 'AC', '--json']).requirement.id;
const oldTask = mkTask('旧轮开发', reqId, { round: 1 });
run(['task', 'done', '--boot', dev1.token, '--id', oldTask, '--evidence', '旧轮证据', '--json'], true);
setReqStatus(reqId, 'dev_done', { deliveryRound: 1, trq: { verdict: 'testable' } });

// ① reason 必填
const noReason = run(['req', 'reopen', '--boot', pm.token, '--project', PROJECT, '--requirement', reqId, '--json'], true);
check('① 缺 --reason → REASON_REQUIRED', noReason.ok === false && noReason.code === 'REASON_REQUIRED', noReason.code);

// ② reopen：dev_done → dev、deliveryRound+1、门禁失效标记
const reopened = run(['req', 'reopen', '--boot', pm.token, '--project', PROJECT, '--requirement', reqId, '--reason', 'UI 侧未实现', '--json'], true);
const row1 = rowOf(reqId);
check('② reopen 成功：dev_done → dev', reopened.ok === true && row1.status === 'dev', { ok: reopened.ok, status: row1.status, code: reopened.code });
check('② deliveryRound 1 → 2', Number(row1.deliveryRound) === 2, row1.deliveryRound);
check('② 写 gateInvalidatedAt/By 且 TR-Q 标 stale', Boolean(row1.gateInvalidatedAt) && row1.gateInvalidatedBy === 'reopen' && row1.trq && row1.trq.verdictStale === true, { at: row1.gateInvalidatedAt, by: row1.gateInvalidatedBy, trq: row1.trq });

// ③ 旧轮 done 不把需求推回 dev_done
run(['task', 'recompute-advance', '--boot', pm.token, '--requirement', reqId, '--json'], true);
check('③ 旧轮任务 done 不推回 dev_done', rowOf(reqId).status === 'dev', rowOf(reqId).status);

// ④ 新任务自动继承 round=2；手填 round 被忽略
const newTask = mkTask('本轮开发', reqId, { round: null });
const newTaskFile = path.join(taskDir, `${newTask}.json`);
const savedNew = JSON.parse(fs.readFileSync(newTaskFile, 'utf8'));
check('④ 新任务自动继承 round=2', Number(savedNew.workflow && savedNew.workflow.round) === 2, savedNew.workflow);
const handRound = run(['task', 'create', '--boot', pm.token, '--project', PROJECT, '--title', '手填轮次', '--priority', 'P1', '--type', 'task', '--owner', 'programmer1', '--requirement', reqId, '--round', '1', '--json'], true);
const handFile = path.join(taskDir, `${(handRound.task || {}).id}.json`);
const handSaved = fs.existsSync(handFile) ? JSON.parse(fs.readFileSync(handFile, 'utf8')) : {};
check('④ 手填 --round 1 被忽略，仍按需求 round=2', Number(handSaved.workflow && handSaved.workflow.round) === 2, handSaved.workflow);
// 手填轮次那条也收口，避免它挡本轮的推进判定（它同样是当前轮任务）。
run(['task', 'done', '--boot', dev1.token, '--id', (handRound.task || {}).id, '--evidence', '手填轮次证据', '--json'], true);

// ⑤ 当前轮任务 done → 才推 dev_done
run(['task', 'done', '--boot', dev1.token, '--id', newTask, '--evidence', '本轮证据', '--json'], true);
check('⑤ 当前轮任务 done → 推回 dev_done', rowOf(reqId).status === 'dev_done', rowOf(reqId).status);

// ⑥ 不适用状态：dev 上 reopen → REOPEN_NOT_APPLICABLE
setReqStatus(reqId, 'dev', { deliveryRound: 2 });
const notApplicable = run(['req', 'reopen', '--boot', pm.token, '--project', PROJECT, '--requirement', reqId, '--reason', 'x', '--json'], true);
check('⑥ dev 上 reopen → REOPEN_NOT_APPLICABLE', notApplicable.ok === false && notApplicable.code === 'REOPEN_NOT_APPLICABLE', notApplicable.code);

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\nR-d225 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
fs.writeFileSync(path.join(SB, 'run-d225.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
