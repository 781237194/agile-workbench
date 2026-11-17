'use strict';
const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/** B-37ea 回归：req iterate 后与 reopen 同口径（写 gateInvalidatedAt + 推进 deliveryRound，旧 rejected 不挡验收/不判重复）。 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
// B-20261116-055303-07b6：沙盘统一入口（唯一临时目录 + 退出清理）
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
const SB = mkTempSandbox('b-37ea');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '迭代返工沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 260)}`);
  if (!ok) process.exitCode = 1;
}
function run(args, allowFail = false) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
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
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
run(['project', 'add', '--name', PROJECT, '--team-mode', 'fast', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm', '--json']);
// 沙盘级联：pm 未读登记册会让 req create 撞 LESSONS_UNREAD（门禁按角色记）
run(['lessons', 'read', '--boot', pm.token, '--project', PROJECT, '--json']);
const reqId = run(['req', 'create', '--boot', pm.token, '--project', PROJECT, '--title', '迭代返工需求', '--priority', 'P0', '--acceptance', 'AC', '--json']).requirement.id;
const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
const wfFile = path.join(stateDir, '工作流.json');
const readWf = () => (fs.existsSync(wfFile) ? JSON.parse(fs.readFileSync(wfFile, 'utf8')) : { schema: 2, project: PROJECT, round: 1, phase: 'dev', requirements: {}, events: [] });
const rowOf = (id) => (readWf().requirements || {})[id] || {};

// 造成：已被打回（rejected 决定 + 旧 rejected 状态）
const wf0 = readWf();
wf0.requirements = wf0.requirements || {};
wf0.requirements[reqId] = {
  ...(wf0.requirements[reqId] || {}), id: reqId, status: 'rejected',
  decisions: [{ status: 'rejected', channel: 'ui', by: 'Owner', at: '2026-11-14T01:00:00.000Z', opinion: '旧打回' }],
  trq: { verdict: 'testable' },
};
fs.writeFileSync(wfFile, JSON.stringify(wf0, null, 2) + '\n', 'utf8');
const taskFile = path.join(stateDir, '任务', `${reqId}.json`);
const t0 = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
t0.status = 'rejected';
t0.workflow = { ...(t0.workflow || {}), status: 'rejected', decisions: wf0.requirements[reqId].decisions };
fs.writeFileSync(taskFile, JSON.stringify(t0, null, 2) + '\n', 'utf8');

// ① req iterate 成功，且写 gateInvalidatedAt / 推进 deliveryRound
const it = run(['req', 'iterate', '--boot', pm.token, '--project', PROJECT, '--id', reqId, '--reason', '线上阻塞返工', '--json'], true);
const row1 = rowOf(reqId);
check('① req iterate 成功', it.ok === true, { ok: it.ok, code: it.code });
check('① 写入 gateInvalidatedAt/By=iterate', Boolean(row1.gateInvalidatedAt) && row1.gateInvalidatedBy === 'iterate', { at: row1.gateInvalidatedAt, by: row1.gateInvalidatedBy });
check('① deliveryRound 与 iterationRound 对齐（>= 轮次）', Number(row1.deliveryRound) >= Number(row1.iterationRound || 1), { deliveryRound: row1.deliveryRound, iterationRound: row1.iterationRound });
check('① TR-Q 旧结论标 stale', Boolean(row1.trq && row1.trq.verdictStale === true), row1.trq);

(async () => {
  const mod = await import('file:///' + path.join(TEAM_ROOT, '工具', 'lib', 'lifecycle.mjs').replace(/\\/g, '/'));
  const { latestValidOwnerDecision, currentDeliveryRound } = mod;
  const row = rowOf(reqId);

  // ② 旧 rejected 早于失效标记 → 不再作为“当前有效决定”，不挡验收
  const latest = latestValidOwnerDecision(row);
  check('② 迭代后旧 rejected 不再算有效决定（不挡验收）', !latest || String(latest.status) !== 'rejected', latest);

  // ③ 轮次口径：iterationRound 参与取大
  check('③ currentDeliveryRound 取 deliveryRound/iterationRound 较大值', currentDeliveryRound(row) >= Math.max(Number(row.deliveryRound || 1), Number(row.iterationRound || 1)), { cur: currentDeliveryRound(row), row: { deliveryRound: row.deliveryRound, iterationRound: row.iterationRound } });

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nB-37ea 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
  fs.writeFileSync(path.join(SB, 'run-b-37ea.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
})();
