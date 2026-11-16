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

// ── S1 真实两条：旧决定必须判 stale（否则 Owner 仍被拦）
for (const id of ['R-20261114-144138-550f', 'R-20261115-132235-0b77']) {
  const row = rowsById[id];
  if (!row) { check(`S1 ${id} 存在于工作流`, false, '缺行'); continue; }
  const latest = OR_STATE.latestOwnerDecision(row);
  const stale = OR_STATE.isDecisionCurrent(latest, row);
  const rowVersion = TT.rowRequirementVersion(row);
  const backendMatch = TT.decisionVersionMatches(latest, row);
  check(`S1 ${id}：末条旧决定判 stale（renderer+backend 一致）、且行版本可从 RR hash 回退取得`,
    stale === false && backendMatch === false && Boolean(rowVersion.sha256 || rowVersion.contentHash),
    { stale, backendMatch, rowVersion, decidedStatus: latest && (latest.status || latest.decision) });
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
check('S6 去重复算：550f 旧决定放行；当前版本同状态决定拦住',
  duplicateByBackend(rowsById['R-20261114-144138-550f'] || { decisions: [] }, 'approved') === false
  && duplicateByBackend(rowsById['R-20261115-132235-0b77'] || { decisions: [] }, 'approved') === false
  && duplicateByBackend(rowCurrent, 'approved') === true
  && duplicateByBackend(rowMoved, 'approved') === false,
  { legacy550f: duplicateByBackend(rowsById['R-20261114-144138-550f'] || { decisions: [] }, 'approved'), current: duplicateByBackend(rowCurrent, 'approved') });

// ── S7 renderer 判重条件（submit 的判据）：只有「current 且同状态」才拦
function submitBlocks(row, status) {
  const latest = OR_STATE.latestOwnerDecision(row);
  const latestStatus = String((latest && (latest.status || latest.decision)) || ((row.ownerReview || {}).status) || '');
  return Boolean(latest && OR_STATE.isDecisionCurrent(latest, row) && latestStatus === status);
}
check('S7 submit 判据：旧决定不拦（550f/0b77），当前版本同状态拦，改版后不拦',
  submitBlocks(rowsById['R-20261114-144138-550f'] || { decisions: [] }, 'approved') === false
  && submitBlocks(rowsById['R-20261115-132235-0b77'] || { decisions: [] }, 'approved') === false
  && submitBlocks(rowCurrent, 'approved') === true
  && submitBlocks(rowMoved, 'approved') === false,
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

console.log(`\n决定-版本绑定自检：${passed}/${passed + failures.length} PASS`);
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
process.exit(0);
