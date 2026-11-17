#!/usr/bin/env node
'use strict';
/**
 * test-decision-version.cjs —— B-20261116-105609-2893 自检
 *
 * 覆盖「点通过报已决定了」的三条判据：
 *  1) 旧决定（无 basis / hash 不等）不得被当成重复：renderer isDecisionCurrent=false、
 *     backend decisionVersionMatches=false，同轮同状态去重不拦；
 *  2) 决定绑当前版本时才算重复：二次点击必须被拦（renderer + backend 两处同判据）；
 *  3) ownerActionLockOf 不再把「只有旧决定」的行锁成 OWNER_ALREADY_DECIDED。
 *
 * 用真实工作流行（550f / 0b77）+ 合成夹具，只读，不写任何状态文件。
 * 运行：node scripts/test-decision-version.cjs   退出码 0=全过
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const STATE = path.join(ROOT, '团队', '状态', '项目', '工作台改造修复', '工作流.json');
const OR_STATE = require(path.join(ROOT, 'src', 'renderer', 'owner-review-state.js'));
const TT = require(path.join(ROOT, 'src', 'team-tools.js'));

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 300)}`);
}

const rowsById = {};
if (fs.existsSync(STATE)) {
  const j = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const reqs = j.requirements || {};
  for (const [key, row] of Object.entries(reqs)) rowsById[String((row && row.id) || key)] = row;
}

// ── S1 真实两条：渲染层与后端对「同一笔决定是否绑当前版本」必须给出**同一结论**
//     （方向会随真实数据漂移：Owner 重落一笔后它就变 current，所以这里只断言一致性与版本可取，
//      具体 stale/current 的方向由 S2/S3/S4 的夹具覆盖）
for (const id of ['R-20261114-144138-550f', 'R-20261115-132235-0b77']) {
  const row = rowsById[id];
  if (!row) { check(`S1 ${id} 存在于工作流`, false, '缺行'); continue; }
  const latest = OR_STATE.latestOwnerDecision(row);
  const rendererCurrent = OR_STATE.isDecisionCurrent(latest, row);
  const rowVersion = TT.rowRequirementVersion(row);
  const backendCurrent = TT.decisionVersionMatches(latest, row);
  check(`S1 ${id}：渲染层与后端对末条决定判 current/stale 结论一致、且行版本可从 requirementReview.requirementHash 回退取得`,
    rendererCurrent === backendCurrent && Boolean(rowVersion.sha256 || rowVersion.contentHash),
    { rendererCurrent, backendCurrent, rowVersion, decidedStatus: latest && (latest.status || latest.decision) });
}

// ── S2 合成夹具：决定绑当前版本 → 两处都判 current（二次点击必须被拦）
const rowCurrent = { id: 'R-FIXTURE-current', status: 'approved', requirementHash: 'HASH_CUR_1', decisions: [{ status: 'approved', round: 1, at: new Date().toISOString(), basis: { requirement: { sha256: 'HASH_CUR_1' } } }] };
check('S2 决定绑当前版本 → renderer isDecisionCurrent=true、backend decisionVersionMatches=true',
  OR_STATE.isDecisionCurrent(rowCurrent.decisions[0], rowCurrent) === true
  && TT.decisionVersionMatches(rowCurrent.decisions[0], rowCurrent) === true,
  OR_STATE.latestOwnerDecision(rowCurrent));

// ── S3 合成夹具：hash 不等 → 不拦
const rowMoved = { id: 'R-FIXTURE-moved', status: 'approved', requirementHash: 'HASH_CUR_2', decisions: [{ status: 'approved', round: 1, at: new Date().toISOString(), basis: { requirement: { sha256: 'HASH_OLD_1' } } }] };
check('S3 正文改版后（hash 不等）→ 两处都判 stale，不拦新决定',
  OR_STATE.isDecisionCurrent(rowMoved.decisions[0], rowMoved) === false
  && TT.decisionVersionMatches(rowMoved.decisions[0], rowMoved) === false,
  rowMoved.decisions[0]);

// ── S4 旧决定 + 无 basis：decidedOnlyOnStaleVersion=true（ownerActionLockOf 因此不锁）
const rowLegacy = { id: 'R-FIXTURE-legacy', status: 'approved', ownerReview: { status: 'pending' }, requirementHash: 'HASH_CUR_3', decisions: [{ status: 'approved', round: 1, at: new Date().toISOString() }] };
check('S4 无 basis 的旧决定 → decidedOnlyOnStaleVersion=true（锁态不生效）',
  OR_STATE.decidedOnlyOnStaleVersion(rowLegacy) === true
  && OR_STATE.decidedOnlyOnStaleVersion(rowCurrent) === false
  && OR_STATE.decidedOnlyOnStaleVersion({ id: 'x', status: 'approved' }) === false,
  { legacy: OR_STATE.decidedOnlyOnStaleVersion(rowLegacy), current: OR_STATE.decidedOnlyOnStaleVersion(rowCurrent) });

// ── S5 新决定写 basis：rowRequirementVersion 与落账 basis 同源
const writtenBasis = TT.rowRequirementVersion(rowCurrent);
check('S5 落账用 rowRequirementVersion() 写 basis（与判重同一取数源）',
  writtenBasis.sha256 === 'HASH_CUR_1' && TT.decisionVersionMatches({ basis: { requirement: writtenBasis } }, rowCurrent) === true,
  writtenBasis);

// ── S6 同轮同状态去重复算：旧决定放行、当前版本决定拦住（「真重复第二次仍被拦」）
function duplicateByBackend(row, status) {
  const round = Number(row.round || 1);
  const list = Array.isArray(row.decisions) ? row.decisions : [];
  return list.some((d) => d && String(d.status || d.decision || '') === status
    && Number(d.round || round) === round
    && TT.decisionVersionMatches(d, row));
}
check('S6 去重复算：旧版本决定放行、当前版本同状态决定拦住',
  duplicateByBackend(rowLegacy, 'approved') === false
  && duplicateByBackend(rowMoved, 'approved') === false
  && duplicateByBackend(rowCurrent, 'approved') === true,
  { legacy: duplicateByBackend(rowLegacy, 'approved'), moved: duplicateByBackend(rowMoved, 'approved'), current: duplicateByBackend(rowCurrent, 'approved') });

// ── S7 renderer 判重条件（submit 的判据）：只有「current 且同状态」才拦
function submitBlocks(row, status) {
  const latest = OR_STATE.latestOwnerDecision(row);
  const latestStatus = String((latest && (latest.status || latest.decision)) || ((row.ownerReview || {}).status) || '');
  return Boolean(latest && OR_STATE.isDecisionCurrent(latest, row) && latestStatus === status);
}
check('S7 submit 判据：旧决定不拦、当前版本同状态拦、改版后不拦',
  submitBlocks(rowLegacy, 'approved') === false
  && submitBlocks(rowMoved, 'approved') === false
  && submitBlocks(rowCurrent, 'approved') === true,
  null);

// ── S8 decidedStatusOf 必须带版本校验（P0 B-20261116-115903，与后端 gates.mjs 的
//      decisionIsCurrent 同源）：旧版本决定 → 空 + isPending=true；当前版本 → approved。
const rowStaleApproved = {
  id: 'R-FIXTURE-stale-approved', status: 'approved',
  ownerReview: { status: 'approved' },
  requirementHash: 'HASH_CUR_S8',
  decisions: [{ status: 'approved', at: '2026-11-15T02:47:35Z', basis: { requirement: { sha256: 'HASH_OLD_S8' } } }]
};
const rowCurrentApproved = {
  id: 'R-FIXTURE-current-approved', status: 'approved',
  ownerReview: { status: 'pending' },
  requirementHash: 'HASH_CUR_S8',
  decisions: [{ status: 'approved', at: '2026-11-16T01:00:00Z', basis: { requirement: { sha256: 'HASH_CUR_S8' } } }]
};
check('S8 旧版本决定 → decidedStatusOf 为空 且 isPending=true（不再被当已决定）',
  OR_STATE.decidedStatusOf(rowStaleApproved) === ''
  && OR_STATE.isPending(rowStaleApproved) === true,
  { decided: OR_STATE.decidedStatusOf(rowStaleApproved), pending: OR_STATE.isPending(rowStaleApproved) });
check('S9 当前版本决定 → decidedStatusOf=approved 且 isPending=false；无决定旧数据仍回退 ownerReview',
  OR_STATE.decidedStatusOf(rowCurrentApproved) === 'approved'
  && OR_STATE.isPending(rowCurrentApproved) === false
  && OR_STATE.decidedStatusOf({ id: 'R-FIXTURE-legacy-only', status: 'approved', ownerReview: { status: 'approved' } }) === 'approved',
  {
    current: OR_STATE.decidedStatusOf(rowCurrentApproved),
    currentPending: OR_STATE.isPending(rowCurrentApproved),
    legacyOnly: OR_STATE.decidedStatusOf({ id: 'x', status: 'approved', ownerReview: { status: 'approved' } })
  });

// ── S10 isPending 必须让「决定过期 + 非终态」的行浮出（P1 B-20261116-120118-2760，4657 就卡这）
const rowDevStale = {
  id: 'R-FIXTURE-dev-stale', status: 'dev',
  ownerReview: { status: 'approved' }, requirementHash: 'HASH_CUR_S10',
  decisions: [{ status: 'approved', at: '2026-11-15T02:47:35Z', basis: { requirement: { sha256: 'HASH_OLD_S10' } } }]
};
const rowDevCurrent = {
  id: 'R-FIXTURE-dev-current', status: 'dev',
  requirementHash: 'HASH_CUR_S10',
  decisions: [{ status: 'approved', at: '2026-11-16T01:00:00Z', basis: { requirement: { sha256: 'HASH_CUR_S10' } } }]
};
const rowDevNoDecision = { id: 'R-FIXTURE-dev-none', status: 'dev', ownerReview: { status: 'pending' } };
const rowClosedStale = { ...rowDevStale, id: 'R-FIXTURE-closed-stale', status: 'accepted' };
// 范围收窄（PM 2026-11-16 12:02）：dev_done / test_done 之后活已干完，旧批准过期不再挡事，不浮出。
// **2026-11-17 覆写（B-20261117-090155-9b2a，Owner 报「无法重落」）**：决定绑旧正文时，这两阶段
// 正是 Owner 需要重新通过的地方 → 恢复浮出；决定绑当前正文的行依旧不浮（S10 的 devCurrent 用例）。
const rowDevDoneStale = { ...rowDevStale, id: 'R-FIXTURE-dev-done-stale', status: 'dev_done' };
const rowTestDoneStale = { ...rowDevStale, id: 'R-FIXTURE-test-done-stale', status: 'test_done' };
check('S10 dev 阶段 + 决定过期 → isPending=true；当前版本/无决定/终态不列；dev_done/test_done 的**过期**决定也列（9b2a 覆写 12:02 收窄）',
  OR_STATE.isPending(rowDevStale) === true
  && OR_STATE.isPending(rowDevCurrent) === false
  && OR_STATE.isPending(rowDevNoDecision) === false
  && OR_STATE.isPending(rowClosedStale) === false
  && OR_STATE.isPending(rowDevDoneStale) === true
  && OR_STATE.isPending(rowTestDoneStale) === true,
  {
    devStale: OR_STATE.isPending(rowDevStale),
    devCurrent: OR_STATE.isPending(rowDevCurrent),
    devNone: OR_STATE.isPending(rowDevNoDecision),
    closedStale: OR_STATE.isPending(rowClosedStale),
    devDoneStale: OR_STATE.isPending(rowDevDoneStale),
    testDoneStale: OR_STATE.isPending(rowTestDoneStale)
  });
check('S11 行徽标依据：dev+过期 → decidedOnlyOnStaleVersion=true；当前版本=false',
  OR_STATE.decidedOnlyOnStaleVersion(rowDevStale) === true
  && OR_STATE.decidedOnlyOnStaleVersion(rowDevCurrent) === false,
  { stale: OR_STATE.decidedOnlyOnStaleVersion(rowDevStale), current: OR_STATE.decidedOnlyOnStaleVersion(rowDevCurrent) });

// ── S12 行上没有版本信息时不得判「过期」（P0 B-20261116-122422-8487：视图未导出版本字段时，
//      刚落账的决定会被判旧版本 → 行永远留在「等你决定」、再点报 DUPLICATE_DECISION）
const rowNoVersionInfo = {
  id: 'R-FIXTURE-no-version', status: 'approved',
  decisions: [{ status: 'approved', at: '2026-11-16T04:17:24.000Z', basis: { requirement: { sha256: 'HASH_ONLY_ON_DECISION' } } }]
};
check('S12 行无版本信息 → isDecisionCurrent=true（无法证明是旧版本时按当前处理），不再把刚落账的决定判过期',
  OR_STATE.isDecisionCurrent(rowNoVersionInfo.decisions[0], rowNoVersionInfo) === true
  && OR_STATE.decidedStatusOf(rowNoVersionInfo) === 'approved'
  && OR_STATE.isPending(rowNoVersionInfo) === false,
  {
    current: OR_STATE.isDecisionCurrent(rowNoVersionInfo.decisions[0], rowNoVersionInfo),
    decided: OR_STATE.decidedStatusOf(rowNoVersionInfo),
    pending: OR_STATE.isPending(rowNoVersionInfo)
  });

console.log(`\n决定-版本绑定自检：${passed}/${passed + failures.length} PASS`);
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
process.exit(0);
