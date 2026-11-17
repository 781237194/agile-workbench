#!/usr/bin/env node
'use strict';
/**
 * test-owner-redecide.cjs —— 缺陷 B-20261117-090155-9b2a 自检（决定失效后 Owner 能「重落决定」）
 *
 * 现象：正文更新后旧决定失效，评审弹窗既看不到这一档、也点不了（通过按钮被同状态锁死），
 *       Owner 报「等你决定=0、无法重落」。
 * 口径（本单实现）：
 *   ① 决定绑旧正文（decidedOnlyOnStaleVersion=true）时，即使 status 已到 dev_done/test，
 *      也要浮回【等你决定】（stalePendingOf=true）——之前被 PM 12:02 收窄挡在外面；
 *   ② 决定绑**当前**正文时，dev_done/test 仍然不浮（不让 Owner 白点）；
 *   ③ 终态（accepted/terminated/rejected）即使 stale 也不浮；
 *   ④ 按钮解锁判据 = decidedOnlyOnStaleVersion（owner-review.js 用它决定同状态按钮是否禁用，
 *      并打 data-or-redecide="1"）；徽标文案统一「正文已更新，需重新通过」。
 *
 * 纯逻辑 + 静态断言；运行：node scripts/test-owner-redecide.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const S = require(path.join(ROOT, 'src', 'renderer', 'owner-review-state.js'));

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 320)}`);
}

const row = (patch) => ({
  id: 'R-FIXTURE-redecide',
  status: 'dev_done',
  requirementHash: 'CUR_SHA',
  requirementReview: { requirementHash: 'CUR_SHA' },
  ...patch,
});
const decision = (sha) => ({ status: 'approved', at: '2026-11-17T08:00:00.000Z', basis: { requirement: { sha256: sha } } });

// ── S1 dev_done + 旧正文决定 → 浮回等你决定
const staleDevDone = row({ decisions: [decision('OLD_SHA')] });
check('S1 dev_done + 决定绑旧正文 → stalePendingOf=true（Owner 能看到并重落）',
  S.stalePendingOf(staleDevDone) === true && S.decidedOnlyOnStaleVersion(staleDevDone) === true,
  { stalePending: S.stalePendingOf(staleDevDone), onlyStale: S.decidedOnlyOnStaleVersion(staleDevDone) });

// ── S2 dev_done + 当前正文决定 → 不浮（不白点）
const freshDevDone = row({ decisions: [decision('CUR_SHA')] });
check('S2 dev_done + 决定绑当前正文 → stalePendingOf=false（不把已批准的活再翻出来）',
  S.stalePendingOf(freshDevDone) === false && S.decidedOnlyOnStaleVersion(freshDevDone) === false,
  { stalePending: S.stalePendingOf(freshDevDone), onlyStale: S.decidedOnlyOnStaleVersion(freshDevDone) });

// ── S3 test（测试阶段）同理
const staleTest = row({ status: 'test', decisions: [decision('OLD_SHA')] });
const freshTest = row({ status: 'test', decisions: [decision('CUR_SHA')] });
check('S3 test 阶段：旧决定浮出、当前决定不浮',
  S.stalePendingOf(staleTest) === true && S.stalePendingOf(freshTest) === false,
  { stale: S.stalePendingOf(staleTest), fresh: S.stalePendingOf(freshTest) });

// ── S4 终态即使 stale 也不浮
for (const status of ['accepted', 'terminated', 'rejected']) {
  const r = row({ status, decisions: [decision('OLD_SHA')] });
  check(`S4 终态 ${status} + 旧决定 → 不浮回等你决定`, S.stalePendingOf(r) === false, { status, stalePending: S.stalePendingOf(r) });
}

// ── S5 没有决定 → 不因「stale」浮出（走原有 isPending 判定，不新增噪音）
const noDecision = row({ status: 'dev_done', decisions: [] });
check('S5 无决定 → stalePendingOf=false（交给 isPending 的原有口径）', S.stalePendingOf(noDecision) === false, S.stalePendingOf(noDecision));

// ── S6 静态：按钮解锁判据 + 徽标文案 + 阶段清单都落实了
const reviewSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'owner-review.js'), 'utf8');
const stateSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'owner-review-state.js'), 'utf8');
check('S6① owner-review.js 用 decidedOnlyOnStaleVersion 解锁同状态按钮（打 data-or-redecide=1）',
  /const staleDecision = Boolean\(OR_STATE[^\n]*decidedOnlyOnStaleVersion/.test(reviewSrc) && /data-or-redecide', staleDecision \? '1' : '0'/.test(reviewSrc));
check('S6② 徽标文案＝「正文已更新，需重新通过」', /const STALE_BADGE_TEXT = '正文已更新，需重新通过'/.test(reviewSrc), true);
check('S6③ stale 待决阶段含 dev_done 与 test（原来只有 ready/approved/…/iteration）',
  /const STALE_PENDING_STATUSES = \[[^\]]*'dev_done'[^\]]*'test'[^\]]*\]/.test(stateSrc), stateSrc.match(/const STALE_PENDING_STATUSES = [^\n]*/)?.[0]);

console.log(`\n决定失效可重落自检：${passed}/${passed + failures.length} PASS`);
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
process.exit(0);
