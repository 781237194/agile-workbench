'use strict';
/**
 * B-20261115-184535-c98e 沙盘断言：ownerTestGate 增加「名下遗留任务」门。
 *
 * 三态：
 *  ① 测试任务未 done → TEST_NOT_DONE（原语义不变）
 *  ② 测试全 done + 一个开发任务 open → REQ_HAS_OPEN_TASKS（message 必须列 id+标题，零副作用）
 *  ③ 全部 done → 放行（ok:true）
 *
 * 隔离：复制真实 团队/ 到 _tmp/c98e，替换 团队/工具/lib/ops.mjs 为提案暂存版（不碰工作树）。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
// B-20261116-055303-07b6：沙盘改**唯一临时目录**（固定 _tmp/ 目录并发跑会互相 rm/重建 → EPERM/ENOTEMPTY/MODULE_NOT_FOUND）。
// 每次运行一个新目录 + 退出清理；报告件路径不动。
fs.mkdirSync(path.join(ROOT, '_tmp'), { recursive: true });
const SB = fs.mkdtempSync(path.join(ROOT, '_tmp', 'c98e-'));
process.on('exit', () => { try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ } });
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM, '工具', 'team.mjs');
const STAGED = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '提案暂存-c98e', 'ops.mjs');
const PROJECT = 'c98e验收门沙盘';
const env = { ...process.env, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 300)}`);
  if (!ok) process.exitCode = 1;
}
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

fs.rmSync(SB, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
// 沙盘用提案暂存版 ops.mjs（不碰工作树）
fs.copyFileSync(STAGED, path.join(TEAM, '工具', 'lib', 'ops.mjs'));
check('沙盘使用暂存版 ops.mjs（sha 与暂存一致）', sha(path.join(TEAM, '工具', 'lib', 'ops.mjs')) === sha(STAGED), { staged: sha(STAGED).slice(0, 16) });

const teamFile = path.join(TEAM, '状态', '团队.json');
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
for (const m of team.members || []) m.sessionId = '';
team.activeProject = PROJECT;
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
execFileSync(process.execPath, [TOOL, 'project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json'], { cwd: SB, env, encoding: 'utf8' });

const stateDir = path.join(TEAM, '状态', '项目', PROJECT);
const taskDir = path.join(stateDir, '任务');
const wfFile = path.join(stateDir, '工作流.json');
fs.mkdirSync(taskDir, { recursive: true });
const REQ = 'R-20261115-190001-c98e';
const nowIso = new Date().toISOString();
fs.writeFileSync(wfFile, JSON.stringify({
  schema: 2, round: 1, updatedAt: nowIso,
  requirements: { [REQ]: { id: REQ, title: 'c98e 夹具需求', status: 'test_done', priority: 'P0', createdAt: nowIso } },
}, null, 2) + '\n', 'utf8');

function writeTask(id, { owner, status, title = `夹具 ${id}` }) {
  const row = {
    id, project: PROJECT, type: 'task', requirementId: REQ, title, detail: '夹具', acceptance: 'AC',
    priority: 'P0', priorityBy: 'pm', priorityReason: '', owner, status,
    createdBy: 'pm', createdAt: nowIso, claimedAt: nowIso, due: '', doneAt: status === 'done' ? nowIso : null,
    evidence: '', rev: 0, history: [], workflow: { round: 1 },
  };
  fs.writeFileSync(path.join(taskDir, `${id}.json`), JSON.stringify(row, null, 2) + '\n', 'utf8');
  return path.join(taskDir, `${id}.json`);
}

process.env.TEAM_ROOT = TEAM;
process.env.TEAM_PROJECTS_ROOT = PROJECTS;
process.env.TEAM_SELFTEST = '1';

(async () => {
  const mod = await import(pathToFileURL(path.join(TEAM, '工具', 'lib', 'ops.mjs')).href);
  const gate = mod.ownerTestGate;
  check('暂存版导出 ownerTestGate（可单测）', typeof gate === 'function', typeof gate);

  const tTest = 'T-20261115-190002-test';
  const tDev = 'T-20261115-190003-dev';
  const tDone = 'T-20261115-190004-done';
  const fDev = writeTask(tDev, { owner: 'programmer1', status: 'open', title: '报告门否定句修复' });
  const fTest = writeTask(tTest, { owner: 'tester', status: 'open', title: '测试复验' });
  writeTask(tDone, { owner: 'programmer1', status: 'done', title: '已完成的开发' });
  const before = { dev: sha(fDev), test: sha(fTest) };

  // ① 测试未 done → TEST_NOT_DONE（原语义不变；测试任务优先报）
  const r1 = gate(PROJECT, REQ);
  check('① 测试未 done → TEST_NOT_DONE（原有语义不变）', Boolean(r1) && r1.ok === false && r1.code === 'TEST_NOT_DONE', r1);

  // ② 测试 done + 开发 open → REQ_HAS_OPEN_TASKS，message 列 id+标题
  const tDoneRow = JSON.parse(fs.readFileSync(path.join(taskDir, `${tTest}.json`), 'utf8'));
  tDoneRow.status = 'done'; tDoneRow.doneAt = nowIso;
  fs.writeFileSync(path.join(taskDir, `${tTest}.json`), JSON.stringify(tDoneRow, null, 2) + '\n', 'utf8');
  const r2 = gate(PROJECT, REQ);
  check('② 测试全 done + 开发任务 open → REQ_HAS_OPEN_TASKS', Boolean(r2) && r2.ok === false && r2.code === 'REQ_HAS_OPEN_TASKS', r2);
  check('② message 列出未完成任务 id 与标题', Boolean(r2 && r2.message && r2.message.includes(tDev) && r2.message.includes('报告门否定句修复')), r2 && r2.message);
  check('② open 数组含该任务 id', Boolean(r2 && Array.isArray(r2.open) && r2.open.includes(tDev)), r2 && r2.open);
  check('② 拒收零副作用（任务文件 sha 不变）', sha(fDev) === before.dev && sha(path.join(taskDir, `${tTest}.json`)) !== before.test, { dev: sha(fDev) === before.dev });

  // ③ 全部 done → 放行
  const devRow = JSON.parse(fs.readFileSync(fDev, 'utf8'));
  devRow.status = 'done'; devRow.doneAt = nowIso;
  fs.writeFileSync(fDev, JSON.stringify(devRow, null, 2) + '\n', 'utf8');
  const r3 = gate(PROJECT, REQ);
  check('③ 全部 done → 放行（ok:true）', Boolean(r3) && r3.ok === true, r3);
  check('③ 放行返回值仍含 mode/taskIds（兼容旧调用方）', Boolean(r3 && r3.mode === 'tasks' && Array.isArray(r3.taskIds)), r3);

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\nB-c98e 验收门断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
  const evidDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-c98e');
  fs.mkdirSync(evidDir, { recursive: true });
  fs.writeFileSync(path.join(evidDir, 'run-c98e.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
  // 沙盘默认清理（tester 反映残留 EPERM 无法复跑）；要保留设 AWB_KEEP_SANDBOX=1。
  if (!process.env.AWB_KEEP_SANDBOX) {
    try { fs.rmSync(SB, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch { /* 清理失败不改变断言结论 */ }
  }
})().catch((error) => {
  console.error('RUN_FAILED', (error && error.stack) || error);
  process.exitCode = 1;
});
