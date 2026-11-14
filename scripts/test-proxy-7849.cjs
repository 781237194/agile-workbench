'use strict';
/**
 * R-7849 一键代管 · 团队工具侧回归（7 条）。
 * 跑法：node scripts/test-proxy-7849.cjs
 * 隔离：复制 团队/ 到 _tmp/proxy-7849-test，TEAM_ROOT/TEAM_PROJECTS_ROOT 指向沙盘，TEAM_SELFTEST=1。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'proxy-7849-test');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TEAM_TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '代管沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 300)}`);
  if (!ok) process.exitCode = 1;
}
function run(args, { allowFail = false, extraEnv = {} } = {}) {
  try {
    const out = execFileSync(process.execPath, [TEAM_TOOL, ...args], { cwd: SB, env: { ...env, ...extraEnv }, encoding: 'utf8' });
    const text = String(out).trim();
    return JSON.parse(text.slice(text.indexOf('{')));
  } catch (e) {
    const text = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    if (allowFail) { try { return JSON.parse(text.slice(text.indexOf('{'))); } catch { return { ok: false, raw: text.slice(0, 300) }; } }
    throw e;
  }
}
const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

// ---------- 沙盘 ----------
fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true });
const addRes = run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const projectPath = addRes.project.path;
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'sbx-pm', '--json']);
const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
const workflowFile = path.join(stateDir, '工作流.json');
const taskDir = path.join(stateDir, '任务');
const mk = (title) => run(['req', 'create', '--boot', pm.token, '--project', PROJECT, '--title', title, '--priority', 'P0', '--acceptance', 'AC1', '--json']).requirement.id;
const idA = mk('代管需求A');
const idB = mk('代管需求B');
const idC = mk('代管需求C');
const idD = mk('代管需求D');
const now = new Date().toISOString();
const setReq = (id, status, trq) => {
  const wf = fs.existsSync(workflowFile)
    ? JSON.parse(fs.readFileSync(workflowFile, 'utf8'))
    : { schema: 2, project: PROJECT, round: 1, phase: 'dev', requirements: {}, events: [] };
  wf.requirements = wf.requirements || {};
  wf.requirements[id] = { ...(wf.requirements[id] || {}), id, status, ...(trq ? { trq: { verdict: trq } } : {}) };
  wf.updatedAt = now;
  fs.writeFileSync(workflowFile, JSON.stringify(wf, null, 2) + '\n', 'utf8');
  const tf = path.join(taskDir, `${id}.json`);
  const t = JSON.parse(fs.readFileSync(tf, 'utf8'));
  t.status = status;
  t.workflow = t.workflow || {};
  t.workflow.status = status;
  if (trq) { t.workflow.trq = { ...(t.workflow.trq || {}), verdict: trq }; t.trq = { verdict: trq }; }
  fs.writeFileSync(tf, JSON.stringify(t, null, 2) + '\n', 'utf8');
};
setReq(idA, 'test_done', 'testable');
setReq(idB, 'ready');
setReq(idC, 'dev');
setReq(idD, 'accepted');
// 给 A 建一条已完成的测试任务（过「测试 done 才能 Owner 验收」的门）
{
  const mkTask = run(['task', 'create', '--boot', pm.token, '--project', PROJECT, '--title', '代管沙盘测试任务', '--priority', 'P0', '--type', 'task', '--owner', 'tester', '--requirement', idA, '--json'], { allowFail: true });
  const tid = mkTask.task && mkTask.task.id;
  if (tid) {
    const tf = path.join(taskDir, `${tid}.json`);
    const t = JSON.parse(fs.readFileSync(tf, 'utf8'));
    t.status = 'done';
    t.doneAt = now;
    fs.writeFileSync(tf, JSON.stringify(t, null, 2) + '\n', 'utf8');
  }
}
// 过需求评审/技术评审闸门（full 模式：需求评审=产品，技术评审=产品/程序员A）
const prod = run(['boot', '--role', 'product', '--project', PROJECT, '--session', 'sbx-prod', '--json']);
const dev1 = run(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 'sbx-dev1', '--json']);
for (const id of [idA, idB]) {
  run(['req', 'review', '--boot', prod.token, '--project', PROJECT, '--id', id, '--verdict', 'approve', '--kind', 'requirement', '--comments', '沙盘', '--json'], { allowFail: true });
  run(['req', 'review', '--boot', dev1.token, '--project', PROJECT, '--id', id, '--verdict', 'approve', '--kind', 'tech', '--comments', '沙盘', '--json'], { allowFail: true });
}
const reportFile = path.join(projectPath, '测试人员', '产出', '测试报告-v1.md');const shotFile = path.join(projectPath, '测试人员', '产出', 'shot-v1.png');
fs.mkdirSync(path.dirname(reportFile), { recursive: true });
fs.writeFileSync(reportFile, '# 测试报告\nPASS\n', 'utf8');
fs.writeFileSync(shotFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
console.log(`沙盘就绪：${SB}（需求 ${idA} / ${idB} / ${idC} / ${idD}）`);

// ① scope=all + 幂等 + expiresAt + 授权原文
const start1 = run(['owner', 'proxy', 'start', '--project', PROJECT, '--scope', 'all', '--authorization', 'Owner 13:42 原文：全部交给 PM 代管', '--json'], { allowFail: true });
check('① scope=all 开启成功', start1.ok === true && start1.record && start1.record.scope === 'all', start1);
check('① 记录带 expiresAt（默认 8h）', Boolean(start1.record && start1.record.expiresAt), start1.record && start1.record.expiresAt);
check('① 记录保留 Owner 授权原文', Boolean(start1.record && String(start1.record.authorization).includes('全部交给 PM 代管')), start1.record && start1.record.authorization);
const start2 = run(['owner', 'proxy', 'start', '--project', PROJECT, '--scope', 'all', '--authorization', 'x', '--json'], { allowFail: true });
check('① 重复 start 幂等', start2.ok === true && start2.idempotent === true, start2);

// ④ 过期 → PROXY_EXPIRED
const expiredAt = new Date(Date.parse(start1.record.expiresAt) + 1000).toISOString();
const expired = run(['owner', 'proxy', 'decide', '--project', PROJECT, '--requirement', idB, '--decision', 'approved', '--opinion', '代记', '--json'], { allowFail: true, extraEnv: { TEAM_PROXY_NOW: expiredAt } });
check('④ 过期后落账 → PROXY_EXPIRED', expired.ok === false && expired.code === 'PROXY_EXPIRED', expired);

// ② 四门槛：无证据 → report/screenshot 缺失
const noEvidence = run(['owner', 'proxy', 'decide', '--project', PROJECT, '--requirement', idA, '--decision', 'accepted', '--action', 'accept', '--opinion', '代验收', '--json'], { allowFail: true });
check('② 无证据代验收 → PM_ACCEPT_EVIDENCE_REQUIRED', noEvidence.ok === false && noEvidence.code === 'PM_ACCEPT_EVIDENCE_REQUIRED', noEvidence);
const missKinds = ((noEvidence.details && noEvidence.details.missing) || []).map((m) => m.kind);
check('② missing 含 report 与 screenshot', missKinds.includes('report') && missKinds.includes('screenshot'), missKinds);

// ②b trq/status 门槛（函数级：直接喂 validateAcceptGates）
const { validateAcceptGates } = require(path.join(ROOT, '团队', '工具', 'lib', 'pm-accept-evidence.mjs'));
const gateRes = validateAcceptGates({ evidence: [{ kind: 'report', path: 'a.md' }], trqVerdict: 'not_testable', requirementStatus: 'dev' });
const gateKinds = gateRes.missing.map((m) => m.kind);
check('② trq/status 门槛生效', gateRes.ok === false && gateKinds.includes('trq') && gateKinds.includes('status'), { gateKinds });

// ③ 项目外路径
const outside = path.join(ROOT, '_tmp', 'outside-7849', 'x.png');
fs.mkdirSync(path.dirname(outside), { recursive: true });
fs.writeFileSync(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
const outRes = run(['owner', 'proxy', 'decide', '--project', PROJECT, '--requirement', idA, '--decision', 'accepted', '--action', 'accept', '--evidence', `${outside}:screenshot`, '--opinion', '代验收', '--json'], { allowFail: true });
check('③ 项目外路径 → EVIDENCE_OUTSIDE_PROJECT', outRes.ok === false && outRes.code === 'EVIDENCE_OUTSIDE_PROJECT', { code: outRes.code });

// ⑥ 正常代验收（四门槛齐）
const okAccept = run(['owner', 'proxy', 'decide', '--project', PROJECT, '--requirement', idA, '--decision', 'accepted', '--action', 'accept',
  '--evidence', `${path.relative(projectPath, reportFile)}:report`, '--evidence', `${path.relative(projectPath, shotFile)}:screenshot`, '--opinion', '代验收通过', '--json'], { allowFail: true });
check('⑥ 四门槛齐 → 代验收通过', okAccept.ok === true, okAccept);
const wfAfter = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));
const rowA = wfAfter.requirements[idA] || {};
const taskA = JSON.parse(fs.readFileSync(path.join(taskDir, `${idA}.json`), 'utf8'));
const acceptance = rowA.acceptanceRecord || (taskA.workflow && taskA.workflow.acceptanceRecord) || null;
check('⑥ acceptanceRecord.by=pm 且 channel=proxy（不是 owner）', Boolean(acceptance) && acceptance.by === 'pm' && acceptance.channel === 'proxy', acceptance);
check('⑥ basis.proxy 带 scope/startedAt/authorization', Boolean(acceptance && acceptance.basis && acceptance.basis.proxy && acceptance.basis.proxy.authorization), acceptance && acceptance.basis);
const proxyState = JSON.parse(fs.readFileSync(path.join(stateDir, '评审代管.json'), 'utf8'));
const endedRecords = proxyState.records.filter((row) => row.endedAt && row.endedBy === 'system' && row.endedReason === 'requirement_closed');
check('⑥ 需求收口 → 自动结束代管', endedRecords.length >= 1, endedRecords.length);

// ⑤ 结束代管后代验收 → PROXY_ACCEPT_FORBIDDEN；已落账 sha 不变
const before = sha({ acceptanceRecord: acceptance, decisions: rowA.decisions || taskA.workflow.decisions || [] });
run(['owner', 'proxy', 'end', '--project', PROJECT, '--json'], { allowFail: true });
const afterEnd = run(['owner', 'proxy', 'decide', '--project', PROJECT, '--requirement', idA, '--decision', 'accepted', '--action', 'accept', '--evidence', `${path.relative(projectPath, reportFile)}:report`, '--opinion', '再验收', '--json'], { allowFail: true });
check('⑤ 结束后代验收 → PROXY_ACCEPT_FORBIDDEN', afterEnd.ok === false && afterEnd.code === 'PROXY_ACCEPT_FORBIDDEN', afterEnd.code);
const wfEnd = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));
const rowEnd = wfEnd.requirements[idA] || {};
const taskEnd = JSON.parse(fs.readFileSync(path.join(taskDir, `${idA}.json`), 'utf8'));
const acceptanceEnd = rowEnd.acceptanceRecord || (taskEnd.workflow && taskEnd.workflow.acceptanceRecord) || null;
check('⑤ 结束代管不回溯已落账（sha 不变）', sha({ acceptanceRecord: acceptanceEnd, decisions: rowEnd.decisions || taskEnd.workflow.decisions || [] }) === before, '');

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\nR-7849 代管断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
fs.writeFileSync(path.join(SB, 'run-proxy-7849.json'), JSON.stringify({ at: now, passed, failed, results }, null, 2) + '\n', 'utf8');
if (failed) process.exitCode = 1;
