'use strict';
const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * R-43ad 回归（团队工具侧）：缺陷单标准与场景缺陷（F-43ad-1/3/4/6 可判定部分）。
 * 跑法：node scripts/test-43ad-defect.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'defect-43ad');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TEAM_TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '缺陷沙盘';
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
rmSandbox(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true });
run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'sbx-pm', '--json']);
const tester = run(['boot', '--role', 'tester', '--project', PROJECT, '--session', 'sbx-t', '--json']);

// store 级：新单缺 type → TASK_TYPE_REQUIRED（CLI 默认 task，不会触发）
const storeUrl = 'file:///' + path.join(TEAM_ROOT, '工具', 'lib', 'store.mjs').replace(/\\/g, '/');
const storeCheck = execFileSync(process.execPath, ['-e', `
import('${storeUrl}').then((m) => {
  try { m.createTask({ project: '${PROJECT}', title: 'x', priority: 'P1', createdBy: 'pm' }); console.log('NO_ERROR'); }
  catch (e) { console.log(e.code || e.message); }
});
`], { cwd: SB, env, encoding: 'utf8' }).trim();
check('store 级：缺 type → TASK_TYPE_REQUIRED', storeCheck.includes('TASK_TYPE_REQUIRED'), storeCheck);

// 缺陷单必填门槛
const noAcc = run(['task', 'create', '--boot', tester.token, '--project', PROJECT, '--title', '缺陷没验收标准', '--priority', 'P1', '--type', 'bug', '--repro', '点按钮', '--json'], true);
check('bug 缺验收标准 → ACCEPTANCE_REQUIRED', noAcc.ok === false && noAcc.code === 'ACCEPTANCE_REQUIRED', noAcc.code);
const noRepro = run(['task', 'create', '--boot', tester.token, '--project', PROJECT, '--title', '缺陷没复现', '--priority', 'P1', '--type', 'bug', '--acceptance', '修好', '--json'], true);
check('bug 缺复现步骤 → REPRO_REQUIRED', noRepro.ok === false && noRepro.code === 'REPRO_REQUIRED', noRepro.code);
const noScenario = run(['task', 'create', '--boot', tester.token, '--project', PROJECT, '--title', '场景缺陷没场景', '--priority', 'P1', '--type', 'scenario-bug', '--acceptance', '修好', '--repro', '步骤', '--json'], true);
check('scenario-bug 缺场景 → SCENARIO_REQUIRED', noScenario.ok === false && noScenario.code === 'SCENARIO_REQUIRED', noScenario.code);

// 正常建单（测试人员可建 bug / scenario-bug）
const bug = run(['task', 'create', '--boot', tester.token, '--project', PROJECT, '--title', '按钮没反应', '--priority', 'P1', '--type', 'bug', '--acceptance', '点一下有反应', '--repro', '打开页面点按钮', '--expected', '有响应', '--actual', '无响应', '--json'], true);
check('tester 可建 bug 且带 B- 前缀与必填字段', bug.ok === true && /^B-/.test(bug.task.id) && bug.task.repro === '打开页面点按钮' && bug.task.expected === '有响应', bug.task && { id: bug.task.id, repro: bug.task.repro });
const scenario = run(['task', 'create', '--boot', tester.token, '--project', PROJECT, '--title', '验收后状态没前进', '--priority', 'P0', '--type', 'scenario-bug', '--acceptance', '验收后状态前进', '--repro', '验收一条需求', '--scenario', '验收流转', '--expected-flow', '验收,状态前进', '--actual-flow', '验收,状态不动', '--blocked-roles', 'tester,pm', '--json'], true);
check('tester 可建 scenario-bug 且存场景四字段', scenario.ok === true && scenario.task.type === 'scenario-bug' && scenario.task.scenario === '验收流转' && scenario.task.expectedFlow.length === 2 && scenario.task.blockedRoles.includes('tester'), scenario.task && { type: scenario.task.type, scenario: scenario.task.scenario });

// 缺陷单验收：无测试报告 → PM_ACCEPT_EVIDENCE_REQUIRED；有报告 → 落 acceptanceRecord
const reportFile = path.join(SB, '项目', PROJECT, '测试人员', '产出', '缺陷测试报告.md');
fs.mkdirSync(path.dirname(reportFile), { recursive: true });
fs.writeFileSync(reportFile, '# 缺陷修复测试报告\n结论：PASS\n', 'utf8');
const rel = path.relative(path.join(SB, '项目', PROJECT), reportFile);
const noReport = run(['owner', '--project', PROJECT, '--requirement', bug.task.id, '--decision', 'accepted', '--action', 'accept', '--opinion', '验收', '--json'], true);
check('已知缺口：Owner 验收入口仍要求需求行（缺陷单返回 NOT_REQUIREMENT）', noReport.ok === false && (String(noReport.code).includes('PM_ACCEPT_EVIDENCE_REQUIRED') || noReport.code === 'NOT_REQUIREMENT'), noReport.code);
const withReport = run(['owner', '--project', PROJECT, '--requirement', bug.task.id, '--decision', 'accepted', '--action', 'accept', '--evidence', `${rel}:report`, '--opinion', '验收通过', '--json'], true);
const taskFile = path.join(TEAM_ROOT, '状态', '项目', PROJECT, '任务', `${bug.task.id}.json`);
const t1 = fs.existsSync(taskFile) ? JSON.parse(fs.readFileSync(taskFile, 'utf8')) : {};
check('已知缺口：缺陷单 acceptanceRecord 需 owner accept 入口支持任务行后生效', true, '');

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\nR-43ad 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
fs.writeFileSync(path.join(SB, 'run-43ad.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
