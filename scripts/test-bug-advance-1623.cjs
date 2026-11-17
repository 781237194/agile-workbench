'use strict';
const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * R-1623 回归：bug 同权推进（AC1/AC1b/owner_gate/四组保护/legacy 默认不计入/AC6）。
 * 跑法：node scripts/test-bug-advance-1623.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'bug-advance-1623');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TEAM_TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = 'bug推进沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 300)}`);
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

rmSandbox(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true });
// 沙盘从“无 advanceRule”起步（真实 团队.json 已被 PM 配了 legacyBugBefore，会改变初始行为）
{
  const tf0 = path.join(TEAM_ROOT, '状态', '团队.json');
  const t0 = JSON.parse(fs.readFileSync(tf0, 'utf8'));
  if (t0.config) delete t0.config.advanceRule;
  fs.writeFileSync(tf0, JSON.stringify(t0, null, 2) + '\n', 'utf8');
}run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
const workflowFile = path.join(stateDir, '工作流.json');
const taskDir = path.join(stateDir, '任务');
const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
let pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'sbx-pm', '--json']);
let dev = run(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 'sbx-p1', '--json']);

function mkReq(title) {
  return run(['req', 'create', '--boot', pm.token, '--project', PROJECT, '--title', title, '--priority', 'P0', '--acceptance', 'AC', '--json']).requirement.id;
}
function setStatus(id, status, decisions = []) {
  const wf = fs.existsSync(workflowFile) ? JSON.parse(fs.readFileSync(workflowFile, 'utf8')) : { schema: 2, project: PROJECT, round: 1, phase: 'dev', requirements: {}, events: [] };
  wf.requirements = wf.requirements || {};
  wf.requirements[id] = { ...(wf.requirements[id] || {}), id, status, ...(decisions.length ? { decisions } : {}) };
  fs.writeFileSync(workflowFile, JSON.stringify(wf, null, 2) + '\n', 'utf8');
  const tf = path.join(taskDir, `${id}.json`);
  const t = JSON.parse(fs.readFileSync(tf, 'utf8'));
  t.status = status; t.workflow = t.workflow || {}; t.workflow.status = status;
  if (decisions.length) { t.workflow.decisions = decisions; t.decisions = decisions; }
  fs.writeFileSync(tf, JSON.stringify(t, null, 2) + '\n', 'utf8');
}
function mkTask(title, reqId, { type = 'bug', owner = 'programmer1' } = {}) {
  const extra = (type === 'bug' || type === 'scenario-bug') ? ['--acceptance', '修好验收', '--repro', 'selftest 复现'] : [];
  const r = run(['task', 'create', '--boot', pm.token, '--project', PROJECT, '--title', title, '--priority', 'P0', '--type', type, '--owner', owner, ...extra, ...(reqId ? ['--requirement', reqId] : []), '--json'], true);
  return r.task && r.task.id;
}
const reqStatus = (id) => {
  const wf = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));
  return String((wf.requirements[id] || {}).status || '');
};
const decision = [{ status: 'approved', channel: 'ui', by: 'Owner', at: new Date().toISOString() }];

// F-1623-5 默认：advanceRule.legacyBugBefore 缺失 → bug 全部不计入
const r0 = mkReq('缺配置需求');
setStatus(r0, 'dev', decision);
const b0 = mkTask('bug-缺配置', r0);
run(['task', 'done', '--boot', dev.token, '--id', b0, '--evidence', '证据0', '--json'], true);
check('缺 legacyBugBefore 时 bug 不计入（停在 dev）', reqStatus(r0) === 'dev', reqStatus(r0));

// 写入 advanceRule（会改 rulesHash → 重新 boot）
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
team.config.advanceRule = { legacyBugBefore: '2000-01-01T00:00:00.000Z' };
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'sbx-pm2', '--json']);
dev = run(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 'sbx-p1b', '--json']);

// AC1：dev + bug 绑定 + 有证据 → dev_done
const r1 = mkReq('AC1 需求');
setStatus(r1, 'dev', decision);
const b1 = mkTask('修 bug 1', r1);
run(['task', 'done', '--boot', dev.token, '--id', b1, '--evidence', '修复说明 证据', '--json'], true);
check('AC1 bug 同权 → 需求推 dev_done', reqStatus(r1) === 'dev_done', reqStatus(r1));

// AC1b：approved（有 Owner 决定）也算开发阶段
const r2 = mkReq('AC1b 需求');
setStatus(r2, 'approved', decision);
const b2 = mkTask('修 bug 2', r2);
run(['task', 'done', '--boot', dev.token, '--id', b2, '--evidence', '证据2', '--json'], true);
check('AC1b approved 也推 dev_done', reqStatus(r2) === 'dev_done', reqStatus(r2));

// owner_gate 优先：approved + decisions=[] → 不推
const r3 = mkReq('owner_gate 需求');
setStatus(r3, 'approved', []);
const b3 = mkTask('修 bug 3', r3);
run(['task', 'done', '--boot', dev.token, '--id', b3, '--evidence', '证据3', '--json'], true);
check('owner_gate 优先：approved+无决定 → 停在 approved', reqStatus(r3) === 'approved', reqStatus(r3));

// no_requirement_binding
const b4 = mkTask('无绑定 bug', '');
run(['task', 'done', '--boot', dev.token, '--id', b4, '--evidence', '证据4', '--json'], true);
check('保护 no_requirement_binding：无绑定 bug done 不报错、不推需求', true, '');

// status_not_dev：test_done 需求不被拉回
const r5 = mkReq('status_not_dev 需求');
setStatus(r5, 'test_done', decision);
const b5 = mkTask('修 bug 5', r5);
run(['task', 'done', '--boot', dev.token, '--id', b5, '--evidence', '证据5', '--json'], true);
check('保护 status_not_dev：test_done 不被 bug 拉回', reqStatus(r5) === 'test_done', reqStatus(r5));

// no_evidence：无证据 bug done 不推
const r6 = mkReq('no_evidence 需求');
setStatus(r6, 'dev', decision);
const b6 = mkTask('修 bug 6', r6);
run(['task', 'done', '--boot', dev.token, '--id', b6, '--json'], true);
check('保护 no_evidence：无证据 bug done 不推', reqStatus(r6) === 'dev', reqStatus(r6));

// AC6：chore 仍不推进
const r8 = mkReq('chore 需求');
setStatus(r8, 'dev', decision);
const c8 = mkTask('杂活', r8, { type: 'chore' });
run(['task', 'done', '--boot', dev.token, '--id', c8, '--evidence', '证据8', '--json'], true);
check('AC6 chore 仍不推进', reqStatus(r8) === 'dev', reqStatus(r8));

// AC5b（e7e8）：recompute 的候选 kids 必须收 bug——把需求手动退回 dev，再 recompute 应能凭已 done 的 bug 推回 dev_done
const r9 = mkReq('recompute 需求');
setStatus(r9, 'dev', decision);
const b9 = mkTask('recompute bug', r9);
run(['task', 'done', '--boot', dev.token, '--id', b9, '--evidence', '证据9', '--json'], true);
setStatus(r9, 'dev', decision);
run(['task', 'recompute-advance', '--boot', pm.token, '--requirement', r9, '--json'], true);
check('e7e8 recompute 按 kids 含 bug 重算 → dev_done', reqStatus(r9) === 'dev_done', reqStatus(r9));
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\nR-1623 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
fs.writeFileSync(path.join(SB, 'run-bug-advance.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
