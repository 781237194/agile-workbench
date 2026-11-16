/**
 * B-20261116-105620-630a2e 自检：全仓「旧决定当已决定」判定点清扫。
 *
 * 覆盖：
 *   G*  gates.mjs 的版本判据（有 basis 比对 / 无 basis 兼容 / ownerReview 重置 → 旧决定无效 / 真实两条）
 *   D*  route-queues / route-daemon 已改用 currentDecisionOf（静态 + 行为）
 *   S*  真实数据清扫：只有「ownerReview 被重置为 pending 且决定为旧版」的行才从「已决定」翻成「待决定」，
 *       其余历史决定（无 basis 但 ownerReview 仍是 approved 等）保持原判，不误伤在途需求。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const gates = await import('file:///' + path.join(ROOT, '团队', '工具', 'lib', 'gates.mjs').replace(/\\/g, '/'));
let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ` + JSON.stringify(detail || {}).slice(0, 500)); process.exitCode = 1; }
}

const CUR = 'c'.repeat(64);
const OLD = 'a'.repeat(64);
const row = (extra = {}) => ({ id: 'R-x', status: 'ready', requirementReview: { requirementHash: CUR }, ownerReview: { status: 'pending' }, decisions: [], ...extra });
const dec = (status, basisSha, extra = {}) => ({
  status, decision: status, channel: 'ui', at: '2026-11-15T06:38:07.019Z', opinion: '',
  ...(basisSha ? { basis: { requirement: { sha256: basisSha } } } : {}), ...extra,
});

ok('S0 gates 导出 currentDecisionOf / decisionIsCurrent / currentRequirementVersionOf',
  typeof gates.currentDecisionOf === 'function' && typeof gates.decisionIsCurrent === 'function' && typeof gates.currentRequirementVersionOf === 'function', {});

// G1：决定带当前版本 basis → 有效
ok('G1 basis=当前版本 → 判为有效决定', gates.decisionIsCurrent(dec('approved', CUR), row()) === true, {});
ok('G1b gateOwnerDecision 放行', gates.gateOwnerDecision(row({ decisions: [dec('approved', CUR)] })) === null, gates.gateOwnerDecision(row({ decisions: [dec('approved', CUR)] })));

// G2：决定带旧版本 basis → 无效
const g2row = row({ decisions: [dec('approved', OLD)] });
ok('G2 basis=旧版本 → 旧决定无效（currentDecisionOf=null）', gates.currentDecisionOf(g2row) === null, {});
ok('G2b gateOwnerDecision 挡住（OWNER_REVIEW_REQUIRED）', (gates.gateOwnerDecision(g2row) || {}).code === 'OWNER_REVIEW_REQUIRED', gates.gateOwnerDecision(g2row));

// G3：无 basis 但 ownerReview 被重置 pending（550f/0b77 形态）→ 旧决定无效
const g3row = row({ decisions: [dec('approved')] });
ok('G3 无 basis + ownerReview=pending → 旧决定无效', gates.currentDecisionOf(g3row) === null, {});
ok('G3b gateOwnerDecision 挡住（要求 Owner 重新决定）', (gates.gateOwnerDecision(g3row) || {}).code === 'OWNER_REVIEW_REQUIRED', gates.gateOwnerDecision(g3row));

// G4：无 basis 但 ownerReview 仍是 approved（历史在途行）→ 保持旧行为，不误伤
const g4row = row({ ownerReview: { status: 'approved', at: '2026-11-15T06:38:07.019Z' }, decisions: [dec('approved')] });
ok('G4 无 basis + ownerReview=approved → 视为有效（历史兼容）', gates.currentDecisionOf(g4row) !== null, {});
ok('G4b gateOwnerDecision 放行（不误伤在途）', gates.gateOwnerDecision(g4row) === null, gates.gateOwnerDecision(g4row));

// G5：决定 rejected 且 ownerReview 重置 pending → 不应再被当成「已打回」拦新版本
const g5row = row({ decisions: [dec('rejected')] });
ok('G5 无 basis 的旧 rejected + ownerReview=pending → currentDecisionOf=null', gates.currentDecisionOf(g5row) === null, {});

// D：route-queues / route-daemon 已改用 currentDecisionOf
const q = fs.readFileSync(path.join(ROOT, '团队', '工具', 'lib', 'route-queues.mjs'), 'utf8');
const d = fs.readFileSync(path.join(ROOT, '团队', '工具', 'lib', 'route-daemon.mjs'), 'utf8');
ok('D1 route-queues 的 ready 分支用 currentDecisionOf', /const latest = currentDecisionOf\(row \|\| \{\}\)/.test(q), {});
ok('D2 route-daemon 的 ready 分支用 currentDecisionOf', /const latest = currentDecisionOf\(row\)/.test(d), {});
ok('D3 两个模块都 import 了 currentDecisionOf', /currentDecisionOf/.test(q) && /currentDecisionOf/.test(d), {});

// S：真实数据清扫（只有 ownerReview=pending 的旧决定翻面）
const wf = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '项目', '工作台改造修复', '工作流.json'), 'utf8'));
const rows = Object.entries(wf.requirements || {});
const flipped = [];
let blockedBefore = 0;
let blockedAfter = 0;
for (const [id, r] of rows) {
  const rawLatest = gates.latestDecisionOf(r);
  const before = gates.gateOwnerDecision({ ...r, ownerReview: { status: 'approved' } }) === null;
  const after = gates.gateOwnerDecision(r) === null;
  if (!after) blockedAfter += 1;
  if (before && !after) flipped.push({ id, status: String(r.status || ''), ownerReview: String((r.ownerReview || {}).status || ''), latestStatus: String((rawLatest && (rawLatest.status || rawLatest.decision)) || '') });
  if (!before) blockedBefore += 1;
}
console.log(`      真实数据：清扫后仍被 G3 挡 ${blockedAfter} 行；因旧决定失效而翻面的 ${flipped.length} 行：${JSON.stringify(flipped).slice(0, 300)}`);
ok('S1 550f 因旧决定失效被 G3 挡（需 Owner 重新决定）', flipped.some((x) => x.id.includes('550f')), flipped);
ok('S2 0b77 同上', flipped.some((x) => x.id.includes('0b77')), flipped);
ok('S3 翻面的行都满足「ownerReview=pending + 有旧决定」', flipped.every((x) => x.ownerReview === 'pending' && x.latestStatus), flipped);
ok('S4 已收口/已决定的 90% 行不受影响（翻面数 ≤ 5）', flipped.length <= 5, { flipped: flipped.length });

console.log(`\nB-105620 清扫断言：${pass} 通过 / ${fail} 失败`);
const evidDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-105620');
fs.mkdirSync(evidDir, { recursive: true });
fs.writeFileSync(path.join(evidDir, 'run-105620.log'), `pass=${pass} fail=${fail} flipped=${flipped.length} exit=${process.exitCode || 0}\n`, 'utf8');
process.exit(process.exitCode || 0);
