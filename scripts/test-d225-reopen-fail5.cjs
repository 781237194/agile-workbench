'use strict';
const { rmSandbox, uniqueSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * R-d225 补单 T-3ba2 断言：五处 FAIL 逐条覆盖（权限 / 错误码 / 旧报告时间 / 门禁消费 / 二次返工）。
 *
 * 沙盘：_tmp/d225-fail5（TEAM_ROOT + TEAM_PROJECTS_ROOT 双隔离 + TEAM_SELFTEST=1）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SB = uniqueSandbox('d225-fail5'); // B-07b6 B：唯一沙盘（并发安全）
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = 'd225五处沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 300)}`);
  if (!ok) process.exitCode = 1;
}
function run(args, allowFail = false) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    const t = String(out).trim();
    return JSON.parse(t.slice(t.indexOf('{')));
  } catch (e) {
    const text = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    if (allowFail) { try { return JSON.parse(text.slice(text.indexOf('{'))); } catch { return { ok: false, raw: text.slice(0, 300) }; } }
    throw e;
  }
}
process.env.TEAM_ROOT = TEAM_ROOT;
process.env.TEAM_PROJECTS_ROOT = PROJECTS;
process.env.TEAM_SELFTEST = '1';

rmSandbox(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|\$)/.test(src) });
const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
for (const m of team.members || []) m.sessionId = '';
team.activeProject = PROJECT;
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm', '--json']);
const analyst = run(['boot', '--role', 'analyst', '--project', PROJECT, '--session', 's-an', '--json']);
const tester = run(['boot', '--role', 'tester', '--project', PROJECT, '--session', 's-te', '--json']);
const dev1 = run(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-p1', '--json']);

const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
const wfFile = path.join(stateDir, '工作流.json');
const taskDir = path.join(stateDir, '任务');
const projectDir = path.join(PROJECTS, PROJECT);
const outDir = path.join(projectDir, '测试人员', '产出');
fs.mkdirSync(outDir, { recursive: true });
const readWf = () => (fs.existsSync(wfFile) ? JSON.parse(fs.readFileSync(wfFile, 'utf8')) : { schema: 2, project: PROJECT, round: 1, phase: 'dev', requirements: {}, events: [] });
const rowOf = (id) => (readWf().requirements || {})[id] || {};
const iso = (ms) => new Date(ms).toISOString();

function createReq(title) {
  const r = run(['req', 'create', '--boot', pm.token, '--project', PROJECT, '--title', title, '--priority', 'P0', '--acceptance', 'AC', '--json']);
  return r.requirement.id;
}
function setStatus(id, status, extra = {}) {
  const wf = readWf();
  wf.requirements = wf.requirements || {};
  wf.requirements[id] = {
    ...(wf.requirements[id] || {}),
    id, status, deliveryRound: 1, trq: { verdict: 'testable' },
    decisions: [{ status: 'approved', channel: 'ui', at: '2026-11-15T00:00:00.000Z' }],
    ...extra,
  };
  fs.writeFileSync(wfFile, JSON.stringify(wf, null, 2) + '\n', 'utf8');
  const tf = path.join(taskDir, `${id}.json`);
  if (fs.existsSync(tf)) {
    const t = JSON.parse(fs.readFileSync(tf, 'utf8'));
    t.workflow = { ...(t.workflow || {}), status, decisions: wf.requirements[id].decisions };
    fs.writeFileSync(tf, JSON.stringify(t, null, 2) + '\n', 'utf8');
  }
  return wf.requirements[id];
}
function mkTask(title, reqId, { owner = 'programmer1' } = {}) {
  const r = run(['task', 'create', '--boot', pm.token, '--project', PROJECT, '--title', title, '--priority', 'P0', '--type', 'task', '--owner', owner, '--requirement', reqId, '--json'], true);
  return r.task && r.task.id;
}
function writeReport(name, reqId, verdict = 'PASS') {
  const f = path.join(outDir, name);
  fs.writeFileSync(f, `# 测试报告 ${name}\n\n## ${reqId}\n\n结论：${verdict}（1/1）\n\n证据：见本文件\n`, 'utf8');
  return f;
}

// ① 权限：analyst 执行 reopen → PERMISSION_DENIED（PM 可）
const reqA = createReq('权限需求');
mkTask('权限需求开发', reqA);
setStatus(reqA, 'dev_done');
const anaTry = run(['req', 'reopen', '--boot', analyst.token, '--project', PROJECT, '--requirement', reqA, '--reason', 'analyst 尝试', '--json'], true);
check('① analyst replay：PERMISSION_DENIED', anaTry.ok === false && anaTry.code === 'PERMISSION_DENIED', anaTry);
const pmTry = run(['req', 'reopen', '--boot', pm.token, '--project', PROJECT, '--requirement', reqA, '--reason', 'PM 返工', '--json'], true);
check('① PM 可 reopen（对照）', pmTry.ok === true, pmTry);

// ② 错误码：rejected / accepted / terminated
const reqB = createReq('打回需求');
mkTask('打回需求开发', reqB);
setStatus(reqB, 'rejected');
const rejTry = run(['req', 'reopen', '--boot', pm.token, '--project', PROJECT, '--requirement', reqB, '--reason', 'x', '--json'], true);
check('② rejected → REOPEN_USE_ITERATE', rejTry.ok === false && rejTry.code === 'REOPEN_USE_ITERATE', rejTry);

const reqC = createReq('验收需求');
mkTask('验收需求开发', reqC);
setStatus(reqC, 'accepted');
const accTry = run(['req', 'reopen', '--boot', pm.token, '--project', PROJECT, '--requirement', reqC, '--reason', 'x', '--json'], true);
check('② accepted → REQUIREMENT_CLOSED', accTry.ok === false && accTry.code === 'REQUIREMENT_CLOSED', accTry);

const reqD = createReq('终止需求');
mkTask('终止需求开发', reqD);
setStatus(reqD, 'terminated');
const termTry = run(['req', 'reopen', '--boot', pm.token, '--project', PROJECT, '--requirement', reqD, '--reason', 'x', '--json'], true);
check('② terminated → REQUIREMENT_CLOSED', termTry.ok === false && termTry.code === 'REQUIREMENT_CLOSED', termTry);

// ③ 旧报告时间：task done 落 testReportGeneratedAt；旧报告不计本轮（跳过推进）
const reqE = createReq('报告时间需求');
const testE = mkTask('报告时间测试', reqE, { owner: 'tester' });
setStatus(reqE, 'dev_done');
const reportE = writeReport('测试报告-v901.md', reqE, 'PASS');
run(['task', 'claim', '--boot', tester.token, '--id', testE, '--json'], true);
const doneE = run(['task', 'done', '--boot', tester.token, '--id', testE, '--evidence', path.relative(projectDir, reportE).replace(/\\/g, '/'), '--json'], true);
const taskE = JSON.parse(fs.readFileSync(path.join(taskDir, `${testE}.json`), 'utf8'));
const genE = taskE.acceptanceRecord && taskE.acceptanceRecord.testReportGeneratedAt;
check('③ 测试任务 done 落 acceptanceRecord.testReportGeneratedAt（ISO UTC）', doneE.ok === true && Boolean(genE) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(genE)), { ok: doneE.ok, rec: taskE.acceptanceRecord, code: doneE.code });
check('③ 无返工时 stale=false', taskE.acceptanceRecord && taskE.acceptanceRecord.stale === false, taskE.acceptanceRecord);

const reqF = createReq('旧报告需求');
const testF = mkTask('旧报告测试', reqF, { owner: 'tester' });
setStatus(reqF, 'dev_done', { lastReopenAt: iso(Date.now() + 60 * 1000) });
const reportF = writeReport('测试报告-v902.md', reqF, 'PASS');
run(['task', 'claim', '--boot', tester.token, '--id', testF, '--json'], true);
const doneF = run(['task', 'done', '--boot', tester.token, '--id', testF, '--evidence', path.relative(projectDir, reportF).replace(/\\/g, '/'), '--json'], true);
const taskF = JSON.parse(fs.readFileSync(path.join(taskDir, `${testF}.json`), 'utf8'));
check('③ 报告早于返工时间 → acceptanceRecord.stale=true', doneF.ok === true && taskF.acceptanceRecord && taskF.acceptanceRecord.stale === true, { ok: doneF.ok, rec: taskF.acceptanceRecord, code: doneF.code });
check('③ 旧报告不计本轮：需求不推进（仍 dev_done）', rowOf(reqF).status === 'dev_done', rowOf(reqF).status);
const evidFile = path.join(TEAM_ROOT, '状态', '事件.jsonl');
const events = fs.existsSync(evidFile) ? fs.readFileSync(evidFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
check('③ 跳过推进留审计 requirement_advance_skipped', events.some((e) => e.action === 'requirement_advance_skipped' && String(e.target) === reqF), events.filter((e) => e.action === 'requirement_advance_skipped').slice(-1));

// ④ 门禁消费：G2 看见返工标记必须重判；G2.5 看见 verdictStale 必须重判
(async () => {
  const gates = await import(pathToFileURL(path.join(TEAM_ROOT, '工具', 'lib', 'gates.mjs')).href);
  const rowG2 = {
    id: reqA, status: 'dev', lastReopenAt: iso(Date.now() + 1000),
    requirementReview: { verdict: 'approve', ts: iso(Date.now() - 60000), requirementHash: '' },
    decisions: [],
  };
  const g2 = gates.gateRequirementReview(rowG2, { id: reqA }, projectDir);
  check('④ G2：返工标记 → REQ_REVIEW_REQUIRED(reason=reopened)', Boolean(g2) && g2.code === 'REQ_REVIEW_REQUIRED' && g2.reason === 'reopened', g2);
  const rowTrq = { id: reqA, priority: 'P0', trq: { verdict: 'testable', verdictStale: true } };
  const g25 = gates.gateTestability({ projectPath: projectDir, task: { id: reqA, priority: 'P0' }, row: rowTrq });
  check('④ G2.5：verdictStale → TESTABILITY_REVIEW_REQUIRED(reason=stale)', Boolean(g25) && g25.code === 'TESTABILITY_REVIEW_REQUIRED' && g25.reason === 'stale', g25);

  // ⑤ 二次返工：reopen → 推进回 dev_done → 再 reopen（轮次累加、历史不变）
  const reqG = createReq('二次返工需求');
  setStatus(reqG, 'dev_done', { deliveryRound: 1 });
  const first = run(['req', 'reopen', '--boot', pm.token, '--project', PROJECT, '--requirement', reqG, '--reason', '第一次返工', '--json'], true);
  check('⑤ 第一次 reopen：round 1 → 2', first.ok === true && Number(rowOf(reqG).deliveryRound) === 2, { ok: first.ok, round: rowOf(reqG).deliveryRound, code: first.code });
  const gTask = mkTask('二次返工开发', reqG);
  run(['task', 'claim', '--boot', dev1.token, '--id', gTask, '--json'], true);
  run(['task', 'done', '--boot', dev1.token, '--id', gTask, '--evidence', '二次返工开发证据', '--json'], true);
  run(['task', 'recompute-advance', '--boot', pm.token, '--requirement', reqG, '--json'], true);
  check('⑤ 推进回 dev_done 后再返工（前置）', rowOf(reqG).status === 'dev_done', rowOf(reqG).status);
  // 3 秒幂等窗口：等过窗口，第二次 reopen 才是真实第二次
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3200);
  const back = rowOf(reqG);
  const beforeSecond = JSON.stringify({ decisions: back.decisions, trq: back.trq });
  const second = run(['req', 'reopen', '--boot', pm.token, '--project', PROJECT, '--requirement', reqG, '--reason', '第二次返工', '--json'], true);
  const after = rowOf(reqG);
  const afterSecond = JSON.stringify({ decisions: after.decisions, trq: after.trq });
  check('⑤ 第二次 reopen：round 2 → 3、reopenCount=2', second.ok === true && Number(after.deliveryRound) === 3 && Number(after.reopenCount) === 2, { ok: second.ok, round: after.deliveryRound, count: after.reopenCount, code: second.code });
  check('⑤ 二次返工历史 decisions/trq 内容不变（只追加）', beforeSecond === afterSecond, { beforeSecond, afterSecond });
  const evs = fs.existsSync(evidFile) ? fs.readFileSync(evidFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const reopenedEvts = evs.filter((e) => e.action === 'requirement_reopened' && String(e.target) === reqG);
  check('⑤ 审计 2 条 requirement_reopened（次数可查）', reopenedEvts.length === 2, reopenedEvts.length);

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\nR-d225 五处 FAIL 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
  fs.writeFileSync(path.join(SB, 'run-d225-fail5.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
})().catch((e) => {
  console.error('RUN_FAILED', (e && e.stack) || e);
  process.exitCode = 1;
});
