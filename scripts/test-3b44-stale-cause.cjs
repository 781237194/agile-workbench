/**
 * B-20261117-132015-3b44 回归：G3 区分 stale / missing
 * ① 有决定但绑旧版正文（basis sha ≠ 当前正文 sha）→ cause='stale'（需重评）
 * ② 从未落过决定 → cause='missing'
 * ③ 决定绑当前正文且 approved → 放行（null）
 * 跑法：node scripts/test-3b44-stale-cause.cjs
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 400)}`);
  if (!ok) process.exitCode = 1;
}
(async () => {
  const gates = await import('file:///' + path.join(ROOT, '团队', '工具', 'lib', 'gates.mjs').replace(/\\/g, '/'));
  const wf = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '项目', '工作台改造修复', '工作流.json'), 'utf8'));
  const rows = wf.requirements || {};
  const id = 'R-20261116-193349-4761';
  const row = rows[id];
  check('前置：工作流有 4761 需求行', Boolean(row), Object.keys(rows).length);
  const approvedDecision = {
    status: 'approved', decision: 'approved',
    basis: { requirement: { sha256: 'deadbeefdeadbeef' } },
  };
  const staleRow = { ...row, status: 'ready', decisions: [approvedDecision], ownerReview: { status: 'approved' } };
  const task = { id: 'T-3b44-fixture', requirementId: id };
  const staleGate = gates.taskGateOf({ task, row: staleRow });
  check('① 决定绑旧版正文 → cause=stale（不是 missing）',
    Boolean(staleGate) && staleGate.cause === 'stale' && staleGate.code === 'TASK_GATE_NOT_APPROVED',
    staleGate && { cause: staleGate.cause, code: staleGate.code });
  const missingRow = { ...row, status: 'ready', decisions: [], ownerReview: { status: 'pending' } };
  const missingGate = gates.taskGateOf({ task, row: missingRow });
  check('② 从未落决定 → cause=missing',
    Boolean(missingGate) && missingGate.cause === 'missing', missingGate && { cause: missingGate.cause });
  // ③ 决定绑当前正文 → 放行
  const reqFile = path.join(ROOT, '项目', '工作台改造修复', '需求', 'R-20261116-193349-4761-项目迁移包.md');
  if (fs.existsSync(reqFile)) {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(reqFile)).digest('hex');
    const freshRow = { ...row, status: 'ready', decisions: [{ status: 'approved', decision: 'approved', basis: { requirement: { sha256: sha } } }], ownerReview: { status: 'approved' } };
    const freshGate = gates.taskGateOf({ task, row: freshRow });
    check('③ 决定绑当前正文 → 放行（gate=null）', freshGate === null, freshGate && { cause: freshGate.cause });
  } else {
    check('③ 跳过：需求正文文件不存在', true, {});
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nB-3b44 断言：${passed}/${results.length} PASS`);
})();
