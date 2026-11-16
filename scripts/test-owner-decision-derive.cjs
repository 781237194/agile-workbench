#!/usr/bin/env node
'use strict';
/**
 * B-20261115-131951-dee4 · Owner 决定派生 + 池可见性 断言（纯 Node，无 DOM）
 *
 * 口径：decisions[] 末条优先 → 其次 ownerReview.status，且「渲染与过滤统一用派生值」。
 *   AC1 已批准待开发（status=approved/ready/owner_review…）且 decisions 有 Owner approved 的行，
 *       必须在「等你决定」或「进行中」其一可见 —— 本脚本断言 isPending=false（→ 落进行中）且池内可见。
 *   AC2 需求/缺陷池按 status 全量可见：approved / ready / dev / dev_done / test_done 都进池。
 *   AC3 派生唯一口径：decisions 末条优先，ownerReview 只在没有 decisions 时兜底。
 *   AC4 真窗口断言见 程序员A/产出/证据-dee4/dee4-verify.cjs（CDP，隔离实例）。
 *
 * 跑法：node scripts/test-owner-decision-derive.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ORS_PATH = path.join(ROOT, 'src', 'renderer', 'owner-review-state.js');
const POOL_PATH = path.join(ROOT, 'src', 'renderer', 'pool-core.js');

let passed = 0;
const failures = [];
function check(id, name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${id}  ${name}`); return; }
  failures.push({ id, name, detail });
  console.log(`FAIL  ${id}  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 400)}`);
}

const ORS = require(ORS_PATH);
const POOL = require(POOL_PATH);

/**
 * 5c19 同态：Owner 04:09 点过通过（decisions），产品 04:13 复审把 ownerReview 重置回 pending。
 *
 * 2026-11-17 夹具补充（断言按现状为基准）：渲染侧 B-20261116-103007-56fe 起，决定必须**绑当前正文版本**
 * 才算有效（`isDecisionCurrent`：无 basis 的旧决定判过期 → 行回到「等你决定」重新复审）。
 * 所以这里给行与决定补一对**相同的版本凭据**，让这条夹具继续表达它原本要表达的语义
 * ——「已决定的行不能落进等你决定」，而不是把「无凭据=过期」当成被测行为。
 */
const FIXTURE_SHA = 'a'.repeat(64);
function row5c19(overrides) {
  return {
    id: 'R-20261115-120113-5c19',
    title: '前端 5 套原型',
    status: 'approved',
    round: 1,
    requirementHash: FIXTURE_SHA,
    ownerReview: { status: 'pending', at: null, opinion: '' },
    decisions: [{
      status: 'approved', decision: 'approved', channel: 'ui', decidedBy: 'owner',
      actor: 'owner', by: 'Owner', at: '2026-11-15T04:09:47.620Z', round: 1, opinion: '',
      basis: { requirement: { sha256: FIXTURE_SHA, contentHash: '' } }
    }],
    ...(overrides || {})
  };
}

/* ── AC3：decisionOf 单一派生口径 ───────────────────────────────────────── */
{
  const info = ORS.decisionOf(row5c19());
  check('AC3-01', 'decisionOf：decisions 末条优先（source=decisions，status=approved）',
    info.status === 'approved' && info.source === 'decisions' && info.at === '2026-11-15T04:09:47.620Z', info);
  check('AC3-02', 'decisionOf：带出 channel/actor 供「来源」显示',
    info.channel === 'ui' && (info.latest || {}).actor === 'owner', info);
  const fallback = ORS.decisionOf({ status: 'approved', ownerReview: { status: 'skipped', at: '2026-11-15T05:00:00.000Z', channel: 'ui' }, decisions: [] });
  check('AC3-03', 'decisionOf：没有 decisions 时回退 ownerReview（source=ownerReview）',
    fallback.status === 'skipped' && fallback.source === 'ownerReview', fallback);
  const legacyNested = ORS.decisionOf({ status: 'approved', requirementHash: FIXTURE_SHA, ownerReview: { status: 'pending', decisions: [{ status: 'rejected', at: '2026-11-15T05:00:00.000Z', basis: { requirement: { sha256: FIXTURE_SHA } } }] }, decisions: [] });
  check('AC3-04', 'decisionOf：旧数据 ownerReview.decisions[] 也认（末条 rejected 胜 pending）',
    legacyNested.status === 'rejected' && legacyNested.source === 'decisions', legacyNested);
  const empty = ORS.decisionOf({ status: 'review', ownerReview: { status: 'pending' } });
  check('AC3-05', 'decisionOf：未决定返回 status="" / source=none',
    empty.status === '' && empty.source === 'none', empty);
  check('AC3-06', 'decidedStatusOf 与 decisionOf 同源', ORS.decidedStatusOf(row5c19()) === ORS.decisionOf(row5c19()).status);
}

/* ── AC1：已决定的行不能落进「等你决定」 ─────────────────────────────────── */
{
  const row = row5c19();
  check('AC1-01', '5c19 同态行 isPending=false（→ 落「进行中」，不会两边都没有）',
    ORS.isPending(row) === false, { isPending: ORS.isPending(row), decided: ORS.decidedStatusOf(row) });
  check('AC1-02', '5c19 同态行不算「打回后复审」（不误报复审标签）',
    ORS.reworkInfo(row).isRework === false, ORS.reworkInfo(row));
  const resetAfterApprove = row5c19({ status: 'owner_review' });
  check('AC1-03', 'ownerReview 被重置且 status=owner_review，仍按 decisions 判已决定（不进等你决定）',
    ORS.isPending(resetAfterApprove) === false, { isPending: ORS.isPending(resetAfterApprove) });
}

/* ── AC2：池按 status 全量可见 ───────────────────────────────────────────── */
{
  const matrix = [
    ['approved', 'approved', '已通过'],
    ['ready', 'approved', '已通过'],
    ['dev', 'active', '进行中'],
    ['dev_done', 'active', '进行中'],
    ['test_done', 'active', '进行中'],
    ['accepted', 'accepted', '已验收']
  ];
  for (const [status, bucket, label] of matrix) {
    const row = POOL.normalizePoolRow(row5c19({ status }), 'requirement', {});
    check(`AC2-${status}`, `status=${status} 在池里且桶=「${label}」（${bucket}）`,
      POOL.poolEntered(row) === true && POOL.poolBucket(row) === bucket && POOL.poolStatusLabel(row) === label,
      { bucket: POOL.poolBucket(row), label: POOL.poolStatusLabel(row), entered: POOL.poolEntered(row) });
  }
  const decisionsOnly = POOL.normalizePoolRow(row5c19({ status: 'tech_review' }), 'requirement', {});
  check('AC2-decided', 'status=tech_review 但 Owner 已通过 → 仍进池并按「已通过」显示（不因 pending 丢行）',
    POOL.poolEntered(decisionsOnly) === true && POOL.poolBucket(decisionsOnly) === 'approved' && POOL.poolStatusLabel(decisionsOnly) === '已通过',
    { bucket: POOL.poolBucket(decisionsOnly), label: POOL.poolStatusLabel(decisionsOnly) });
  const undecided = POOL.normalizePoolRow(row5c19({ status: 'tech_review', decisions: [], ownerReview: { status: 'pending' } }), 'requirement', {});
  check('AC2-undecided', '未决定且没评审时间 → 不进池（保持「评审通过自动入池」原口径）',
    POOL.poolEntered(undecided) === false, { bucket: POOL.poolBucket(undecided), entered: POOL.poolEntered(undecided) });
  const rows = POOL.preparePoolRows({ requirements: [row5c19(), row5c19({ id: 'R-2', status: 'dev_done' })], tasks: [] });
  check('AC2-prepare', 'preparePoolRows 不再丢 approved / dev_done 行', rows.length === 2, rows.map((r) => [r.id, r.bucket]));
}

/* ── AC3：pool 与 owner-review 同口径 ───────────────────────────────────── */
{
  const prev = global.OwnerReviewState;
  global.OwnerReviewState = ORS;
  try {
    const row = row5c19();
    check('AC3-pool', 'pool.ownerDecisionStatusOf 与 owner-review-state.decidedStatusOf 一致',
      POOL.ownerDecisionStatusOf(row) === ORS.decidedStatusOf(row), { pool: POOL.ownerDecisionStatusOf(row), or: ORS.decidedStatusOf(row) });
  } finally {
    global.OwnerReviewState = prev;
  }
  const noOrs = POOL.ownerDecisionStatusOf(row5c19());
  check('AC3-fallback', 'pool 在 OwnerReviewState 缺失时用同口径兜底（decisions 末条优先）', noOrs === 'approved', { status: noOrs });
}

/* ── 结构断言：渲染侧必须走派生（防回退）─────────────────────────────────── */
{
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const review = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'owner-review.js'), 'utf8');
  check('AC3-src-01', 'app.js 定义 legacyOwnerDecisionOf 并委托 OwnerReviewState.decisionOf',
    /function legacyOwnerDecisionOf\(/.test(app) && /state\.decisionOf\(req\)/.test(app));
  check('AC3-src-02', 'legacyReqOwnerView 走派生值', /function legacyReqOwnerView\(req\)[\s\S]{0,400}legacyOwnerDecisionOf\(req\)/.test(app));
  check('AC3-src-03', 'ownerDecisionRows 优先需求行顶层 decisions[]',
    /function ownerDecisionRows\(req\)[\s\S]{0,400}req\.decisions/.test(app));
  check('AC3-src-04', 'Owner 评审记录（真实 actor 列表）走派生值', /const ownerDecided = legacyOwnerDecisionOf\(req\)/.test(app));
  check('AC3-src-05', 'owner-review.js 的「一键代管覆盖范围」走 decidedStatusOf',
    /function rowsAwaitingOwner\(\)[\s\S]{0,700}const owner = decidedStatusOf\(row\)/.test(review));
  check('AC3-src-06', 'owner-review.js 弹窗按钮禁用判定走 decisionOf',
    /const decidedInfo = req && OR_STATE && typeof OR_STATE\.decisionOf === 'function'/.test(review));
}

console.log(`\nB-dee4 断言：${passed}/${passed + failures.length} PASS`);
if (failures.length) {
  console.log(JSON.stringify(failures, null, 2));
  process.exit(1);
}
