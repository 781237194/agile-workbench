#!/usr/bin/env node
'use strict';
/**
 * B-20261114-133448-d100 · 打回的需求修改后重新进入评审列表（复审）断言
 *
 * 被测：src/renderer/owner-review-state.js（纯逻辑，Node 可 require）+ owner-review.js/index.html 接线。
 * 复跑：node scripts/test-owner-rework.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MODULE = path.join(ROOT, 'src', 'renderer', 'owner-review-state.js');
const REVIEW = path.join(ROOT, 'src', 'renderer', 'owner-review.js');
const HTML = path.join(ROOT, 'src', 'renderer', 'index.html');
const CSS = path.join(ROOT, 'src', 'renderer', 'style.css');
const S = require(MODULE);

let total = 0;
let failed = 0;
const rows = [];
function check(name, ok, detail) {
  total += 1;
  if (!ok) failed += 1;
  rows.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' · ' + JSON.stringify(detail)));
}

const T = (iso) => iso;
function reworkCase(extra) {
  return {
    id: 'R-20261114-000001-aaaa',
    status: 'approved',
    updatedAt: '2026-11-14T14:00:00Z',
    ownerReview: { status: 'rejected', at: '2026-11-14T13:00:00Z' },
    decisions: [
      { status: 'approved', decision: 'approved', channel: 'ui', at: '2026-11-14T10:00:00Z' },
      { status: 'rejected', decision: 'rejected', channel: 'ui', at: '2026-11-14T13:00:00Z', opinion: '新手引导不通过' }
    ],
    ...extra
  };
}

/* ── 一、核心：打回 → 改完 → 重新进待评审（带复审标记）──────────────────────── */
const rw = reworkCase();
check('打回后已修改（status=approved 且 updatedAt 晚于打回）→ 重新算待评审', S.isPending(rw) === true, S.isPending(rw));
check('复审判定 isRework=true 且带「已修改待复审」文案', S.reworkInfo(rw).isRework === true && S.reworkInfo(rw).label === '已修改待复审', S.reworkInfo(rw).label);
check('复审原因可读（写明「打回后有修改」）', /打回后/.test(S.reworkInfo(rw).reason), S.reworkInfo(rw).reason);

/* ── 二、没改完 / 还停在打回态 → 不进队列 ──────────────────────────────── */
const notChanged = reworkCase({ updatedAt: '2026-11-14T12:00:00Z' });
check('打回后没有改动（updatedAt 早于打回）→ 不进待评审', S.isPending(notChanged) === false && S.reworkInfo(notChanged).isRework === false, S.reworkInfo(notChanged).reason);
const stillRejected = reworkCase({ status: 'rejected' });
check('仍停在 rejected（没重新提交）→ 不进待评审', S.isPending(stillRejected) === false, S.isPending(stillRejected));

/* ── 三、收口态一律不进队列 ───────────────────────────────────────────── */
for (const status of ['accepted', 'terminated', 'iteration']) {
  check('收口态 ' + status + ' → 不进待评审（即使上次是打回）', S.isPending(reworkCase({ status })) === false);
}

/* ── 四、首次评审 / 已通过 / 已跳过 / 待决定 的既有口径不回归 ────────────────── */
const firstReview = { id: 'R-1', status: 'approved', updatedAt: T('2026-11-14T10:00:00Z') };
check('首次评审（无任何决定）→ 待评审，且不是复审', S.isPending(firstReview) === true && S.reworkInfo(firstReview).isRework === false, S.reworkInfo(firstReview).reason);
const approved = { id: 'R-2', status: 'approved', ownerReview: { status: 'approved', at: '2026-11-14T10:00:00Z' }, decisions: [{ status: 'approved', at: '2026-11-14T10:00:00Z' }] };
check('Owner 已通过 → 不进待评审', S.isPending(approved) === false);
const skipped = { id: 'R-3', status: 'approved', decisions: [{ status: 'skipped', at: '2026-11-14T10:00:00Z' }] };
check('Owner 已先跳过 → 不进待评审', S.isPending(skipped) === false);
const ownerReviewStatus = { id: 'R-4', status: 'owner_review' };
check('状态 owner_review → 待评审', S.isPending(ownerReviewStatus) === true && S.reworkInfo(ownerReviewStatus).isRework === false);
const testDone = { id: 'R-5', status: 'test_done' };
check('测试完成等待验收（test_done）→ 不算评审待决定，也不是复审', S.isPending(testDone) === false && S.reworkInfo(testDone).isRework === false);

/* ── 五、旧数据（只有 ownerReview 对象、没有 decisions[]）也要能复审 ──────────── */
const legacy = {
  id: 'R-6',
  status: 'approved',
  updatedAt: '2026-11-14T15:00:00Z',
  ownerReview: { status: 'rejected', at: '2026-11-14T13:00:00Z' }
};
check('旧数据（仅 ownerReview.status=rejected）→ 也能判复审', S.isPending(legacy) === true && S.reworkInfo(legacy).isRework === true);
const legacyNoTime = { id: 'R-7', status: 'approved', ownerReview: { status: 'rejected' } };
check('旧数据完全没有时间 → 按「已重新提交」算复审（不默默隐藏）', S.isPending(legacyNoTime) === true && S.reworkInfo(legacyNoTime).isRework === true, S.reworkInfo(legacyNoTime).reason);

/* ── 六、决定取最后一笔：打回后又被通过 → 不再算待评审 ──────────────────────── */
const reapproved = reworkCase({
  decisions: [
    { status: 'rejected', at: '2026-11-14T13:00:00Z' },
    { status: 'approved', at: '2026-11-14T16:00:00Z' }
  ]
});
check('最后一笔决定是「通过」→ 不进待评审（不被旧打回卡住）', S.isPending(reapproved) === false && S.reworkInfo(reapproved).isRework === false);
check('顶层 decisions 优先于 ownerReview.status', S.decidedStatusOf(reapproved) === 'approved', S.decidedStatusOf(reapproved));

/* ── 七、接线静态断言（防止只改纯逻辑、界面没接上）────────────────────────── */
// B-11ce：scope=all 覆盖条数口径（无 status / 收口行不计入）
check('proxyCoveredRows：无 status 行不计入', S.proxyCoveredRows([{ id: 'R-x' }, { id: 'R-y', status: '' }]).length === 0);
check('proxyCoveredRows：收口行（accepted/terminated/rejected）不计入', S.proxyCoveredRows([
  { id: 'R-1', status: 'accepted' }, { id: 'R-2', status: 'terminated' }, { id: 'R-3', status: 'rejected' },
]).length === 0);
check('proxyCoveredRows：非终态行计入（approved/dev/test_done）', S.proxyCoveredRows([
  { id: 'R-1', status: 'approved' }, { id: 'R-2', status: 'dev' }, { id: 'R-3', status: 'test_done' }, { id: 'R-4', status: 'accepted' }, { id: 'R-5' },
]).length === 3, S.proxyCoveredRows([{ id: 'R-1', status: 'approved' }, { id: 'R-2', status: 'dev' }, { id: 'R-3', status: 'test_done' }, { id: 'R-4', status: 'accepted' }, { id: 'R-5' }]).map((row) => row.id));
check('owner-review.js：一键代管覆盖条数走 proxyCoveredRows（不再直接按 status 过滤）', /OR_STATE\.proxyCoveredRows\(rows\)/.test(fs.readFileSync(REVIEW, 'utf8')));

const reviewSrc = fs.readFileSync(REVIEW, 'utf8');
check('owner-review.js：isPending 已交给 owner-review-state（OR_STATE.isPending）', /if \(OR_STATE\) return OR_STATE\.isPending\(req\)/.test(reviewSrc));
check('owner-review.js：复审标记渲染函数存在且带 data-or-rework', /function reworkChipHtml[\s\S]{0,260}data-or-rework/.test(reviewSrc));
check('owner-review.js：全部需求列表行挂 data-or-rework', /item\.setAttribute\('data-or-rework', '1'\)/.test(reviewSrc));
check('owner-review.js：「需要你评估」条目也带复审标记', /item\.setAttribute\('data-or-rework', '1'\)[\s\S]{0,200}data-owner-eval-item|data-owner-eval-item[\s\S]{0,400}data-or-rework/.test(reviewSrc));

const htmlSrc = fs.readFileSync(HTML, 'utf8');
const iState = htmlSrc.indexOf('<script src="owner-review-state.js">');
const iReview = htmlSrc.indexOf('<script src="owner-review.js">');
check('index.html：owner-review-state.js 在 owner-review.js 之前引入', iState > 0 && iReview > 0 && iState < iReview, { iState, iReview });

const cssSrc = fs.readFileSync(CSS, 'utf8');
check('style.css：有 .or-rework 标记样式', /\.or-rework\s*\{/.test(cssSrc));

const summary = { at: new Date().toISOString(), total, failed, results: rows };
const outDir = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-d100');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log('\n合计 ' + total + ' 项，失败 ' + failed + ' 项');
if (!failed) console.log('OWNER_REVIEW_REWORK_OK');
process.exit(failed ? 1 : 0);
