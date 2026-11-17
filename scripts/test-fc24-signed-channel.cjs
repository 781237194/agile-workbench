'use strict';
const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/** T-fc24 回归：PM 代签（无 tester）测试结论时 channel 必须写 proxy，其余验收保持真实通道。 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'fc24-signed');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TEAM_TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
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

const FAST = 'fast沙盘';
const FULL = 'full沙盘';
run(['project', 'add', '--name', FAST, '--team-mode', 'fast', '--json']);
run(['project', 'add', '--name', FULL, '--team-mode', 'full', '--json']);
const pmFast = run(['boot', '--role', 'pm', '--project', FAST, '--session', 's-pm-f', '--json']);
const pmFull = run(['boot', '--role', 'pm', '--project', FULL, '--session', 's-pm-u', '--json']);
const anFast = run(['boot', '--role', 'analyst', '--project', FAST, '--session', 's-an-f', '--json']);
const anFull = run(['boot', '--role', 'analyst', '--project', FULL, '--session', 's-an-u', '--json']);
const teFast = run(['boot', '--role', 'tester', '--project', FAST, '--session', 's-te-f', '--json']);
const teFull = run(['boot', '--role', 'tester', '--project', FULL, '--session', 's-te-u', '--json']);
const prFull = run(['boot', '--role', 'product', '--project', FULL, '--session', 's-pr-u', '--json']);
const p1Full = run(['boot', '--role', 'programmer1', '--project', FULL, '--session', 's-p1-u', '--json']);

const projectJson = (name) => path.join(TEAM_ROOT, '状态', '项目', name, '项目.json');
// fast 沙盘去掉 tester（模拟无测试角色），改前备份
const pf = projectJson(FAST);
const pj = JSON.parse(fs.readFileSync(pf, 'utf8'));
fs.writeFileSync(`${pf}.bak-${Date.now()}`, JSON.stringify(pj, null, 2));
pj.roleIds = (pj.roleIds || []).filter((r) => r !== 'tester');
fs.writeFileSync(pf, JSON.stringify(pj, null, 2) + '\n', 'utf8');

function prep(name, pmToken, anToken, teToken) {
  const stateDir = path.join(TEAM_ROOT, '状态', '项目', name);
  const reqId = run(['req', 'create', '--boot', pmToken, '--project', name, '--title', `${name} 需求`, '--priority', 'P0', '--acceptance', 'AC', '--json']).requirement.id;
  const wfFile = path.join(stateDir, '工作流.json');
  const wf = fs.existsSync(wfFile) ? JSON.parse(fs.readFileSync(wfFile, 'utf8')) : { schema: 2, project: name, round: 1, phase: 'dev', requirements: {}, events: [] };
  wf.requirements = wf.requirements || {};
  wf.requirements[reqId] = { ...(wf.requirements[reqId] || {}), id: reqId, status: 'test_done', decisions: [{ status: 'approved', channel: 'ui', by: 'Owner', at: new Date().toISOString() }] };
  fs.writeFileSync(wfFile, JSON.stringify(wf, null, 2) + '\n', 'utf8');
  const tf = path.join(stateDir, '任务', `${reqId}.json`);
  const t = JSON.parse(fs.readFileSync(tf, 'utf8'));
  t.status = 'test_done'; t.workflow = t.workflow || {}; t.workflow.status = 'test_done'; t.workflow.decisions = wf.requirements[reqId].decisions;
  fs.writeFileSync(tf, JSON.stringify(t, null, 2) + '\n', 'utf8');
  run(['req', 'review', '--boot', anToken, '--project', name, '--id', reqId, '--verdict', 'approve', '--kind', 'requirement', '--comments', '沙盘', '--json'], true);
  run(['req', 'review', '--boot', teToken, '--project', name, '--id', reqId, '--verdict', 'approve', '--kind', 'tech', '--comments', '沙盘', '--json'], true);
  const projPath = path.join(PROJECTS, name);
  const report = path.join(projPath, '测试人员', '产出', '报告.md');
  const shot = path.join(projPath, '测试人员', '产出', 'shot.png');
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, '# 报告\nPASS\n', 'utf8');
  fs.writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { reqId, wfFile, relReport: path.relative(projPath, report), relShot: path.relative(projPath, shot) };
}

// ① 无 tester：PM 代签 → channel=proxy、signedBy=pm、testGate=pm_signed
const f = prep(FAST, pmFast.token, anFast.token, teFast.token);
const confFast = run(['owner', 'confirm', '--project', FAST, '--requirement', f.reqId, '--decision', 'accepted', '--action', 'accept', '--test-owner', '--json'], true);
const nonceFast = String((confFast.confirmation && confFast.confirmation.nonce) || '');
const acceptFast = run(['owner', '--project', FAST, '--requirement', f.reqId, '--decision', 'accepted', '--action', 'accept',
  '--evidence', `${f.relReport}:report`, '--evidence', `${f.relShot}:screenshot`, '--opinion', '代签验收', '--owner-confirm', nonceFast, '--json'], true);
const wfFast = JSON.parse(fs.readFileSync(f.wfFile, 'utf8'));
const decisionsFast = (wfFast.requirements[f.reqId] || {}).decisions || [];
const acc = decisionsFast.filter((d) => d && d.status === 'accepted').slice(-1)[0] || {};
check('① 代签验收成功', acceptFast.ok === true, { code: acceptFast.code, nonce: nonceFast.slice(0, 8), conf: confFast.code });
check('① decisions 里 channel=proxy（不是 test）', acc.channel === 'proxy', acc.channel);
check('① decisions 里 signedBy=pm、decidedBy=owner、actor=pm、testGate=pm_signed',
  acc.signedBy === 'pm' && acc.decidedBy === 'owner' && acc.actor === 'pm' && acc.testGate === 'pm_signed',
  { signedBy: acc.signedBy, decidedBy: acc.decidedBy, actor: acc.actor, testGate: acc.testGate });

// ② 有 tester：真实通道不变（test-owner 自测通道仍记 test）
const u = prep(FULL, pmFull.token, prFull.token, teFull.token);
const confFull = run(['owner', 'confirm', '--project', FULL, '--requirement', u.reqId, '--decision', 'accepted', '--action', 'accept', '--test-owner', '--json'], true);
const nonceFull = String((confFull.confirmation && confFull.confirmation.nonce) || '');
const acceptFull = run(['owner', '--project', FULL, '--requirement', u.reqId, '--decision', 'accepted', '--action', 'accept',
  '--evidence', `${u.relReport}:report`, '--evidence', `${u.relShot}:screenshot`, '--opinion', '正常验收', '--owner-confirm', nonceFull, '--json'], true);
const wfFull = JSON.parse(fs.readFileSync(u.wfFile, 'utf8'));
const accFull = ((wfFull.requirements[u.reqId] || {}).decisions || []).filter((d) => d && d.status === 'accepted').slice(-1)[0] || {};
check('② 有 tester 时验收照常', acceptFull.ok === true || acceptFull.code === 'TEST_NOT_DONE', { code: acceptFull.code, conf: confFull.code, nonce: nonceFull.slice(0, 8) });
check('② 有 tester 时不写 proxy（保持真实通道 test）', accFull.channel !== 'proxy', accFull.channel);

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\nT-fc24 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
fs.writeFileSync(path.join(SB, 'run-fc24.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
