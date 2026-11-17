/**
 * T-20261117-183920-5d98（R-fd42）第一步夹具：PM 身份对齐纯核判定。
 *
 * 覆盖：
 *   S1 名册 PM 会话已在工作区 → no_change（不写盘、不写审计，幂等）
 *   S2 名册 PM 会话不在工作区 → aligned，目标集合=原集合 ∪ PM 会话（保留其它会话，不删）
 *   S3 再跑一次（用已对齐的 workbench）→ no_change（幂等，第二拍不重复写）
 *   S4 workbench 坏 JSON → WB_UNREADABLE，且 apply 不改写（changed=false）
 *   S5 名册无 PM → ROSTER_NO_PM；名册 PM 无 sessionId → ROSTER_PM_NO_SESSION
 *   S6 项目/工作区缺失 → WB_NO_PROJECT / WB_NO_WORKSPACE
 *   S7 审计行恰好 7 键（at/action/project/role/fromSessionId/toSessionId/result），多余键被 validateAuditRow 拒
 *   S8 apply 不改入参（纯函数）、目标集合去重且保持原顺序在前
 *   S9 名册换人（PM sessionId 变了）→ 新会话被补入，旧会话仍保留（只补不删，交后续 e29f 清理口径）
 *
 * 跑法：node scripts/test-5d98-pm-identity.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = (() => {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, '团队', '工具', 'team.mjs'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('找不到仓库根');
})();

const core = require(path.join(ROOT, 'src', 'pm-identity-sync.js'));
const PM_SID = 'session-' + 'a'.repeat(8);
const OLD_PM = 'session-' + 'b'.repeat(8);
const OTHER = 'session-' + 'c'.repeat(8);

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, error: String((e && e.message) || e) });
    console.log(`FAIL  ${name}\n      ${String((e && e.message) || e).split('\n')[0]}`);
  }
}

const teamWith = (sessionId) => ({ members: [{ role: 'pm', name: '项目经理', sessionId }, { role: 'tester', sessionId: OTHER }] });
const wbWith = (sessionIds, extra = {}) => ({
  version: 1,
  activeProjectId: 'p1',
  projects: [{ id: 'p1', name: '工作台改造修复', workspace: { sessionIds, ...extra } }],
});

// S1
check('S1 工作区已含名册 PM 会话 → no_change（零写盘、零审计）', () => {
  const plan = core.planPmIdentitySync({ team: teamWith(PM_SID), workbench: wbWith([OTHER, PM_SID]), projectId: 'p1' });
  assert.strictEqual(plan.status, 'no_change');
  assert.strictEqual(plan.audit, null);
  return 'no_change / audit=null / status=' + plan.status;
});

// S2
check('S2 缺 PM 会话 → aligned，目标=原集合 ∪ PM 会话（保留其它会话）', () => {
  const plan = core.planPmIdentitySync({ team: teamWith(PM_SID), workbench: wbWith([OTHER]), projectId: 'p1' });
  assert.strictEqual(plan.status, 'aligned');
  assert.deepStrictEqual(plan.targetSessionIds, [OTHER, PM_SID]);
  return 'aligned / +' + PM_SID.slice(0, 12);
});

// S3
check('S3 幂等：对齐后再跑 → no_change（第二拍不重复写）', () => {
  const first = core.planPmIdentitySync({ team: teamWith(PM_SID), workbench: wbWith([OTHER]), projectId: 'p1' });
  const applied = core.applyPmIdentitySync(wbWith([OTHER]), first, { projectId: 'p1' });
  assert.strictEqual(applied.changed, true);
  const plan2 = core.planPmIdentitySync({ team: teamWith(PM_SID), workbench: applied.workbench, projectId: 'p1' });
  assert.strictEqual(plan2.status, 'no_change');
  return '第二拍 no_change';
});

// S4
check('S4 workbench 坏 JSON → WB_UNREADABLE，且 apply 不改写', () => {
  const plan = core.planPmIdentitySync({ team: teamWith(PM_SID), workbench: '{"projects": [', projectId: 'p1' });
  assert.strictEqual(plan.status, 'unreadable');
  assert.strictEqual(plan.code, 'WB_UNREADABLE');
  const applied = core.applyPmIdentitySync('{"projects": [', plan, { projectId: 'p1' });
  assert.strictEqual(applied.changed, false);
  return 'WB_UNREADABLE / changed=false';
});

// S5
check('S5 名册缺 PM / PM 无 sessionId → 各自错误码，不改写', () => {
  const noPm = core.planPmIdentitySync({ team: { members: [{ role: 'tester', sessionId: OTHER }] }, workbench: wbWith([OTHER]), projectId: 'p1' });
  assert.strictEqual(noPm.code, 'ROSTER_NO_PM');
  const noSid = core.planPmIdentitySync({ team: teamWith(''), workbench: wbWith([OTHER]), projectId: 'p1' });
  assert.strictEqual(noSid.code, 'ROSTER_PM_NO_SESSION');
  return noPm.code + ' / ' + noSid.code;
});

// S6
check('S6 项目/工作区缺失 → WB_NO_PROJECT / WB_NO_WORKSPACE', () => {
  const noProj = core.planPmIdentitySync({ team: teamWith(PM_SID), workbench: wbWith([OTHER]), projectId: 'nope' });
  assert.strictEqual(noProj.code, 'WB_NO_PROJECT');
  const noWs = core.planPmIdentitySync({ team: teamWith(PM_SID), workbench: { projects: [{ id: 'p1', name: 'x' }] }, projectId: 'p1' });
  assert.strictEqual(noWs.code, 'WB_NO_WORKSPACE');
  return noProj.code + ' / ' + noWs.code;
});

// S7
check('S7 审计行恰好 7 键且 action=pm_identity_sync；多一个键被拒', () => {
  const plan = core.planPmIdentitySync({ team: teamWith(PM_SID), workbench: wbWith([OTHER]), projectId: 'p1', at: '2026-11-17T11:00:00.000Z' });
  assert.deepStrictEqual(Object.keys(plan.audit).sort(), core.PM_IDENTITY_AUDIT_KEYS.slice().sort());
  assert.strictEqual(core.validateAuditRow(plan.audit).ok, true);
  const bad = { ...plan.audit, extra: 1 };
  assert.strictEqual(core.validateAuditRow(bad).ok, false);
  assert.strictEqual(core.validateAuditRow({ ...plan.audit, action: 'other' }).ok, false);
  return '7 键 + action 校验';
});

// S8
check('S8 apply 纯函数：不改入参、目标集合去重且原顺序在前', () => {
  const wb = wbWith([OTHER, OTHER]);
  const snapshot = JSON.stringify(wb);
  const plan = core.planPmIdentitySync({ team: teamWith(PM_SID), workbench: wb, projectId: 'p1' });
  assert.deepStrictEqual(plan.targetSessionIds, [OTHER, PM_SID]);
  const applied = core.applyPmIdentitySync(wb, plan, { projectId: 'p1' });
  assert.strictEqual(JSON.stringify(wb), snapshot, '入参被修改了');
  assert.deepStrictEqual(applied.workbench.projects[0].workspace.sessionIds, [OTHER, PM_SID]);
  assert.ok(applied.workbench.projects[0].workspace.updatedAt);
  return '入参不变 + 去重 + updatedAt';
});

// S9
check('S9 名册换人（PM 会话变了）→ 新会话补入、旧会话保留（只补不删）', () => {
  const plan = core.planPmIdentitySync({ team: teamWith(PM_SID), workbench: wbWith([OLD_PM, OTHER]), projectId: 'p1' });
  assert.strictEqual(plan.status, 'aligned');
  assert.deepStrictEqual(plan.targetSessionIds, [OLD_PM, OTHER, PM_SID]);
  return '旧会话保留 + 新会话补入';
});

const pass = results.filter((r) => r.ok).length;
console.log(`\nPM_IDENTITY ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
if (pass !== results.length) process.exit(1);
