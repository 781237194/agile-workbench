#!/usr/bin/env node
'use strict';
/**
 * test-owner-review-projection.cjs —— 缺陷 B-20261117-012404-17af 自检（ownerReview 单源收敛）
 *
 * 口径：ownerReview 只保留一份投影 ownerReviewProjection(base, patch)，字段集固定；
 *   ① 三处写入者（recordOwnerDecision / applyOwnerDecisionToRequirement / 验收）落出来的键集合必须完全一致；
 *   ② 未决定（pending/optional/空）不得写 by/actor/at/opinion —— 否则界面/审计把「待办」当成 Owner 记录；
 *   ③ 已决定时 by 默认 Owner、actor 默认 owner，channel/recordedBy 原样保留（代管来源可追溯）；
 *   ④ 摘要里不允许出现 decisions（append-only 的真值在需求行 decisions[]）；
 *   ⑤ 未知新键要保留（不能因为收敛把后来加的字段丢掉）。
 *
 * 纯函数 + 静态接线断言，只读；运行：node scripts/test-owner-review-projection.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TT = require(path.join(ROOT, 'src', 'team-tools.js'));

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 320)}`);
}

const P = TT.ownerReviewProjection;
check('S0 导出 ownerReviewProjection', typeof P === 'function');

// ── S1 三处写入者（按各自真实入参形状）产出的键集合必须一致
const auth = { channel: 'ui', actor: 'owner', by: 'Owner', recordedBy: '', at: '2026-11-17T07:00:00.000Z' };
const w1 = P({ status: 'rejected', at: '2026-11-16T00:00:00.000Z', opinion: '旧意见' }, {
  ...auth, status: 'approved', by: 'Owner', actor: 'owner', at: '2026-11-17T07:00:00.000Z', opinion: '同意',
  source: 'team.mjs owner', command: 'owner'
});
const w2 = P({ status: 'pending', at: null, opinion: '' }, {
  ...auth, status: 'approved', source: 'workbench-dialog', command: 'owner'
});
const w3 = P({ status: 'approved', by: 'Owner', kind: 'requirement' }, {
  ...auth, required: true, status: 'approved', kind: 'acceptance', by: 'Owner', actor: 'owner',
  at: '2026-11-17T07:00:00.000Z', opinion: ''
});
const keys = (obj) => Object.keys(obj).sort().join(',');
const CANON = ['actor', 'at', 'basis', 'by', 'channel', 'command', 'kind', 'opinion', 'recordedBy', 'source', 'status'];
const extraOf = (obj) => Object.keys(obj).filter((k) => !CANON.includes(k)).sort();
check('S1 三处写入者都带齐固定字段（canonical 11 键），差异只允许验收段的 required',
  CANON.every((k) => k in w1) && CANON.every((k) => k in w2) && CANON.every((k) => k in w3)
  && JSON.stringify(extraOf(w1)) === '[]' && JSON.stringify(extraOf(w2)) === '[]'
  && JSON.stringify(extraOf(w3)) === '["required"]',
  { w1: keys(w1), w2: keys(w2), w3: keys(w3), extra1: extraOf(w1), extra3: extraOf(w3) });
check('S1b 固定字段全都存在（status/at/opinion/by/actor/channel/recordedBy/source/command/kind/basis）',
  ['status', 'at', 'opinion', 'by', 'actor', 'channel', 'recordedBy', 'source', 'command', 'kind', 'basis'].every((k) => k in w1),
  Object.keys(w1));

// ── S2 未决定不得写 Owner 痕迹
for (const st of ['pending', 'optional', '']) {
  const out = P({ by: 'Owner', actor: 'owner', at: '2026-11-16T00:00:00.000Z', opinion: '旧' }, { status: st });
  check(`S2 未决定（status="${st}"）→ by/actor 空、at=null、opinion 空`,
    out.by === '' && out.actor === '' && out.at === null && out.opinion === '',
    { by: out.by, actor: out.actor, at: out.at, opinion: out.opinion });
}

// ── S3 已决定：默认身份 + 代管来源保留
const proxy = P({}, { status: 'approved', at: '2026-11-17T07:00:00.000Z', channel: 'proxy', recordedBy: 'pm' });
check('S3 已决定 → by=Owner、actor=owner；channel=proxy、recordedBy=pm 原样保留',
  proxy.by === 'Owner' && proxy.actor === 'owner' && proxy.channel === 'proxy' && proxy.recordedBy === 'pm', proxy);

// ── S4 摘要不得带 decisions（真值在行上 decisions[]）
const withDecisions = P({ decisions: [{ status: 'approved' }], status: 'approved' }, { status: 'approved' });
check('S4 投影里不出现 decisions（base 带也会被剥掉）',
  !('decisions' in withDecisions), Object.keys(withDecisions));

// ── S5 未知新键保留（收敛不等于丢字段）
const extra = P({ status: 'approved', futureField: 'keep-me' }, { status: 'approved' });
check('S5 未知字段保留（futureField 不丢）', extra.futureField === 'keep-me', extra.futureField);

// ── S6 静态接线：三处写入者都走统一投影，且没有残留的手搓对象
const src = fs.readFileSync(path.join(ROOT, 'src', 'team-tools.js'), 'utf8');
const callCount = (src.match(/=\s*ownerReviewProjection\(/g) || []).length;
check('S6① 三处写入者都调用 ownerReviewProjection（>=3 处）', callCount >= 3, { callCount });
check('S6② 验收段不再手搓 state.ownerReview = {（改走投影）',
  !/state\.ownerReview = \{\s*\n\s*\.\.\.mergedOwnerReview/.test(src));
check('S6③ 产品评审段仍保留「决定新鲜不抹回 pending」的投影标记（与 f2c0 同源）',
  src.includes('product_review_keep_owner_decision'));

console.log(`\nownerReview 单源投影自检：${passed}/${passed + failures.length} PASS`);
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
process.exit(0);
