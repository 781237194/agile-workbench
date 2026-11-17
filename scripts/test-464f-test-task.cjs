'use strict';
const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/** R-464f 回归：dev_done 无当前轮测试任务 → 先建再叫（needTestTask + ensureTestTask 幂等）。 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'route-464f');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const PROJECT = '守护沙盘';
process.env.TEAM_ROOT = TEAM_ROOT;
process.env.TEAM_PROJECTS_ROOT = PROJECTS;
process.env.TEAM_SELFTEST = '1';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 260)}`);
  if (!ok) process.exitCode = 1;
}
const run = (args) => {
  const out = execFileSync(process.execPath, [path.join(TEAM_ROOT, '工具', 'team.mjs'), ...args], { cwd: SB, env: process.env, encoding: 'utf8' });
  const t = String(out).trim();
  return JSON.parse(t.slice(t.indexOf('{')));
};

rmSandbox(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true });
run(['project', 'add', '--name', PROJECT, '--team-mode', 'fast', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm', '--json']);
const req = run(['req', 'create', '--boot', pm.token, '--project', PROJECT, '--title', '464f 需求', '--priority', 'P0', '--acceptance', 'AC', '--json']).requirement;

(async () => {
  const mod = await import(pathToFileURL(path.join(TEAM_ROOT, '工具', 'lib', 'route-daemon.mjs')).href);
  const { planForRow, ensureTestTask } = mod;
  const row = { id: req.id, status: 'dev_done', deliveryRound: 2, title: '464f 需求', priority: 'P0', acceptance: 'AC' };
  const devTask = { id: 'T-dev', type: 'task', owner: 'programmer1', status: 'done', requirementId: req.id, workflow: { round: 2 } };

  // ① 无测试任务 → needTestTask
  const p1 = planForRow(row, { tasks: [devTask], projectPath: path.join(PROJECTS, PROJECT), mode: 'fast' });
  check('① dev_done + 无当前轮测试任务 → needTestTask=true', p1.needTestTask === true && p1.role === 'tester', p1);

  // ② 有当前轮测试任务 → 不再建
  const testTask = { id: 'T-test', type: 'task', owner: 'tester', status: 'open', requirementId: req.id, workflow: { round: 2 } };
  const p2 = planForRow(row, { tasks: [devTask, testTask], projectPath: path.join(PROJECTS, PROJECT), mode: 'fast' });
  check('② 有当前轮测试任务 → needTestTask 不出现', !p2.needTestTask && p2.role === 'tester', p2);

  // ③ 旧轮测试任务不算（按当前轮建新任务）
  const oldTest = { id: 'T-old', type: 'task', owner: 'tester', status: 'done', requirementId: req.id, workflow: { round: 1 } };
  const p3 = planForRow(row, { tasks: [devTask, oldTest], projectPath: path.join(PROJECTS, PROJECT), mode: 'fast' });
  check('③ 旧轮测试任务不算已有 → needTestTask=true', p3.needTestTask === true, p3);

  // ④ ensureTestTask 真建任务且带当前轮
  const made = ensureTestTask(PROJECT, row, [devTask]);
  check('④ ensureTestTask 建出 tester 任务', made.ok === true && made.reused === false && made.task && made.task.owner === 'tester', made);
  const file = path.join(TEAM_ROOT, '状态', '项目', PROJECT, '任务', `${made.task ? made.task.id : 'x'}.json`);
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  check('④ 新任务带当前轮 round=2 且绑需求', Number(saved.workflow && saved.workflow.round) === 2 && String(saved.requirementId) === String(req.id), { round: saved.workflow && saved.workflow.round, req: saved.requirementId });

  // ⑤ 幂等：再调一次复用，不重复建
  const again = ensureTestTask(PROJECT, row, [devTask, made.task]);
  check('⑤ 再调一次复用不重复建', again.ok === true && again.reused === true, again);


  // ⑥ 补单 T-eeff ①②③：新任务 status=open、createdBy=route-daemon、detail 带报告/证据要求
  check('⑥ 新任务 status=open', String(saved.status) === 'open', saved.status);
  check('⑥ createdBy=route-daemon', String(saved.createdBy) === 'route-daemon', saved.createdBy);
  check('⑥ detail 含测试报告与 EVIDENCE 口径', /测试报告/.test(String(saved.detail)) && /EVIDENCE_/.test(String(saved.detail)), String(saved.detail).slice(0, 80));

  // ⑦ 补单 T-eeff ④：第二次调用留痕 test_task_skipped_existing
  const logFile = path.join(TEAM_ROOT, '状态', '项目', PROJECT, '路由守护.jsonl');
  const logs = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  check('⑦ 复用时有 test_task_skipped_existing 事件', logs.some((l) => l.event === 'test_task_skipped_existing'), logs.filter((l) => l.event === 'test_task_skipped_existing').length);

  // ⑧ 补单 T-eeff ⑥：失败注入钩子
  process.env.TEAM_TASK_CREATE_FAIL = '1';
  const injected = ensureTestTask(PROJECT, { ...row, id: req.id }, []);
  delete process.env.TEAM_TASK_CREATE_FAIL;
  check('⑧ TEAM_TASK_CREATE_FAIL 注入 → ok=false', injected.ok === false && /TEAM_TASK_CREATE_FAIL/.test(String(injected.why)), injected);

  // ⑨ 补单 T-eeff ⑤：roleIds 无 tester → noTesterRole，不建
  const noRole = ensureTestTask(PROJECT, { ...row, id: req.id, roleIds: ['pm', 'analyst', 'programmer1'] }, []);
  check('⑨ 无 tester 角色 → noTesterRole 且不建', noRole.ok === false && noRole.noTesterRole === true, noRole);

  // ⑩ 补单 T-eeff ④b：当前轮测试任务被 terminated → 不再叫 tester
  const terminated = { id: 'T-term', type: 'task', owner: 'tester', status: 'terminated', requirementId: req.id, workflow: { round: 2 } };
  const p10 = planForRow(row, { tasks: [devTask, terminated], projectPath: path.join(PROJECTS, PROJECT), mode: 'fast' });
  check('⑩ 测试任务全 terminated → skip:test_task_terminated', p10.skip === 'test_task_terminated' && p10.alertPm === true, p10);
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nR-464f 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
  fs.writeFileSync(path.join(SB, 'run-464f.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
})();
