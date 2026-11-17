#!/usr/bin/env node
'use strict';
/**
 * B-20261116-094215-2ff6 / B-20261116-095320-410e / B-20261116-100905-1211 自检
 *
 * 覆盖（对应派单三条硬目标）：
 *   ① 三处口径同源：评审界面 / 需求缺陷池 / 流程面板 的「需求条数」全部等于 工作流.json 的需求行数
 *      （用真实数据只读复算；快照兜底行单列、不计入口径）；
 *   ② review-list-core.groupOf() 对 status=approved + ownerReview=approved + decisions 有的行不返回 pending；
 *   ③ pool-core.poolBucket() 对 status=done 但 acceptanceRecord 缺/未 accepted 的缺陷不是 accepted
 *      （真实数据「已验收」条数前后对比 + 只认 acceptanceRecord.status=accepted）；
 *   ④ 评审界面新增「产品评审中」档：status=review + requirementReview 空 的行落该档（不进等你决定）；
 *   ⑤ 已作废/已终态的行不出现「可派单」（流程面板 statusText / dispatchable 双判据）。
 *
 * 真实数据只读：跑完断言 工作流.json 的 sha256+mtime 与 任务/ 文件数不变。
 * 跑法：node scripts/test-ui3-consistency.cjs   （退出码 0=全绿，1=有失败；不启动窗口）
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = '工作台改造修复';
const PROJECT_PATH = path.join(ROOT, '项目', PROJECT);
const WF_FILE = path.join(ROOT, '团队', '状态', '项目', PROJECT, '工作流.json');
const TASK_DIR = path.join(ROOT, '团队', '状态', '项目', PROJECT, '任务');
const APP_FILE = path.join(ROOT, 'src', 'renderer', 'app.js');

const teamTools = require(path.join(ROOT, 'src', 'team-tools.js'));
const RLC = require(path.join(ROOT, 'src', 'renderer', 'review-list-core.js'));
const POOL = require(path.join(ROOT, 'src', 'renderer', 'pool-core.js'));

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('PASS  ' + name); return; }
  failures.push({ name, detail });
  console.log('FAIL  ' + name + (detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 500)));
}

/** 只读取证：文件 sha256 + mtime + 大小。 */
function statOf(file) {
  try {
    const st = fs.statSync(file);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    return { sha256: sha, mtimeMs: st.mtimeMs, bytes: st.size };
  } catch { return null; }
}
function countTasks() {
  try { return fs.readdirSync(TASK_DIR).filter((f) => f.endsWith('.json')).length; } catch { return -1; }
}

/** 从源码里按名字切出一个函数（含 body），花括号配平；跳过 // 行注释。 */
function extractFunction(src, name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(([^)]*)\\)\\s*\\{').exec(src);
  if (!m) return null;
  const start = m.index;
  let i = m.index + m[0].length - 1;
  let depth = 0;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/* ── 0. 真实数据只读快照（同一时刻、同一个数据源） ───────────────────────── */
const beforeWf = statOf(WF_FILE);
const beforeTasks = countTasks();
check('0-01 工作流.json 可读（真实数据）', Boolean(beforeWf && beforeWf.bytes > 0), beforeWf);
let rawWorkflow = null;
try { rawWorkflow = JSON.parse(fs.readFileSync(WF_FILE, 'utf8')); } catch { rawWorkflow = null; }
check('0-02 工作流.json 是合法 JSON', Boolean(rawWorkflow && rawWorkflow.requirements), rawWorkflow ? Object.keys(rawWorkflow).slice(0, 8) : null);

const snap = teamTools.readWorkflowSnapshot(PROJECT, PROJECT_PATH);
check('0-03 团队工具快照读取成功（真实读盘）', Boolean(snap && snap.ok), snap && { ok: snap.ok, code: snap.code });
const reqs = (snap && Array.isArray(snap.requirements)) ? snap.requirements : [];
const tasks = (snap && Array.isArray(snap.tasks)) ? snap.tasks : [];
check('0-04 快照带读盘时刻 readAt（数据新鲜度证据）', Boolean(snap && snap.readAt && Number.isFinite(Date.parse(snap.readAt))), snap && snap.readAt);

/* ── ① 三处口径同源（评审界面 / 需求池 / 流程面板 vs 工作流.json） ──────────── */
const workflowRows = Object.keys((rawWorkflow && rawWorkflow.requirements) || {}).length;
const reviewSet = RLC.UI3_requirementSet(reqs);
const poolRows = POOL.preparePoolRows(snap);
const poolScope = POOL.poolScopeCounts(poolRows);

// 流程面板数据函数直接从 app.js 里切出来跑（不复制实现）。
const appSrc = fs.readFileSync(APP_FILE, 'utf8');
const flowParts = ['flowV4Data', 'flowUi3'].map((name) => extractFunction(appSrc, name));
check('1-00 从 app.js 切出流程面板真实函数 flowV4Data / flowUi3', flowParts.every(Boolean), {});
let flowApi = null;
try {
  // eslint-disable-next-line no-new-func
  const factory = new Function('legacyWorkflow', 'flowLiveState', 'FLOW_STALE_AFTER_MS', 'window', `
    const FLOW_CLOSED_STATUSES = ['accepted', 'done', 'terminated', 'iteration', 'rejected'];
    ${flowParts.join('\n')}
    return { flowV4Data };
  `);
  flowApi = factory(
    () => ({ round: Number((rawWorkflow && rawWorkflow.round) || 1), requirements: reqs }),
    { refreshedAt: Date.now(), lastError: null },
    60000,
    { ReviewListCore: RLC }
  );
} catch (error) {
  check('1-00 流程面板函数可求值', false, String((error && error.message) || error).slice(0, 300));
}
const flowData = flowApi && typeof flowApi.flowV4Data === 'function' ? flowApi.flowV4Data() : null;
check('1-01 流程面板数据可算（不启动窗口）', Boolean(flowData && Array.isArray(flowData.items)), flowData && { total: flowData.total });

console.log(`      真实数据：工作流.json 需求行 = ${workflowRows}；评审界面 registered = ${reviewSet.registered}（兜底 ${reviewSet.fallback}）；`
  + `需求池 registered = ${poolScope.registered}（需求行 ${poolScope.requirement}、兜底 ${poolScope.fallback}、缺陷 ${poolScope.defect}）；`
  + `流程面板 total = ${flowData ? flowData.registered : 'n/a'}（兜底 ${flowData ? flowData.fallbackCount : 'n/a'}、未收口 ${flowData ? flowData.open : 'n/a'}、已收口 ${flowData ? flowData.closed : 'n/a'}）`);
check('1-02 评审界面需求条数 = 工作流.json 需求行数', reviewSet.registered === workflowRows, { review: reviewSet.registered, workflowRows });
check('1-03 需求缺陷池需求条数 = 工作流.json 需求行数', poolScope.registered === workflowRows, { pool: poolScope.registered, workflowRows });
check('1-04 流程面板需求条数 = 工作流.json 需求行数', Boolean(flowData) && flowData.registered === workflowRows, { flow: flowData && flowData.registered, workflowRows });
check('1-05 三处需求条数彼此相等（同源）', reviewSet.registered === poolScope.registered && (!flowData || flowData.registered === poolScope.registered),
  { review: reviewSet.registered, pool: poolScope.registered, flow: flowData && flowData.registered });
check('1-06 快照兜底行单列：三处 fallback 计数一致且不计入口径',
  reviewSet.fallback === poolScope.fallback && (!flowData || flowData.fallbackCount === poolScope.fallback),
  { review: reviewSet.fallback, pool: poolScope.fallback, flow: flowData && flowData.fallbackCount });
// 允许的差异白名单：口径 = 工作流行；差异只允许「兜底行」这一项，且必须三处一致（上面 1-06 已断言）。
check('1-07 差额白名单只有「快照兜底行」一类（无其它未知差异）',
  (reqs.length - reviewSet.registered) === reviewSet.fallback && (reviewSet.fallback >= 0), { rows: reqs.length, registered: reviewSet.registered, fallback: reviewSet.fallback });
// 流程面板的未收口/已收口与 UI3 六档计数自洽
const ui3Counts = RLC.UI3_groupCounts(reqs);
check('1-08 流程面板 open/closed 与 UI3 六档计数自洽',
  Boolean(flowData) && flowData.closed === ui3Counts.counts.closed && flowData.open === (flowData.registered - flowData.closed),
  flowData && { open: flowData.open, closed: flowData.closed, ui3Closed: ui3Counts.counts.closed });
check('1-09 流程面板带 refreshedAt + stale（>60 秒未刷新要能提示可能过期）',
  Boolean(flowData) && typeof flowData.refreshedAt === 'string' && flowData.stale === false
  && flowData.refreshedAt === new Date(Date.parse(flowData.refreshedAt)).toISOString(),
  flowData && { refreshedAt: flowData.refreshedAt, stale: flowData.stale });
check('1-10 三处数据源都是同一份实时工作流（app.js 不再读 workflowMirror 当真相）',
  /refreshFlowLive[\s\S]{0,4000}workflowState\(/.test(appSrc)
  && /activeTab !== 'flow'/.test(appSrc)
  && !/p\.workflowMirror\.requirements/.test(appSrc),
  { hasLiveRead: /refreshFlowLive[\s\S]{0,4000}workflowState\(/.test(appSrc), flowTabRefresh: /activeTab !== 'flow'/.test(appSrc) });

/* ── ② groupOf：已通过（decisions 有效）不得返回 pending ───────────────────── */
const CUR_HASH = 'd'.repeat(64);
const decidedRow = (status, extra) => ({
  id: 'R-ui3-' + status, status, requirementHash: CUR_HASH,
  decisions: [{ status: 'approved', at: '2026-11-16T00:00:00.000Z', basis: { requirement: { sha256: CUR_HASH } } }],
  ownerReview: { status: 'approved', channel: 'ui', actor: 'owner' },
  ...(extra || {})
});
check('2-01 夹具：approved + ownerReview=approved + decisions 有效 → groupOf 不是 pending',
  RLC.groupOf(decidedRow('approved')).group !== 'pending', RLC.groupOf(decidedRow('approved')));
check('2-02 夹具：approved + ownerReview=approved + decisions 无 basis（旧决定）→ 仍按等你决定（不误放行）',
  RLC.groupOf({ id: 'R-old', status: 'approved', ownerReview: { status: 'approved' }, decisions: [{ status: 'approved', at: '2026-11-15T00:00:00.000Z' }] }).group === 'pending');
check('2-03 夹具：approved 无任何决定 → 等你决定（G-01 既有口径不变）',
  RLC.groupOf({ id: 'R-undecided', status: 'approved' }).group === 'pending');
const realApprovedDecided = reqs.filter((r) => String(r.status) === 'approved'
  && String((r.ownerReview && r.ownerReview.status) || '') === 'approved'
  && Array.isArray(r.decisions) && r.decisions.length);
const realApprovedDecidedPending = realApprovedDecided.filter((r) => RLC.groupOf(r).group === 'pending');
check('2-04 真实数据：approved + ownerReview=approved + decisions 有 的行全部不落 pending',
  realApprovedDecidedPending.length === 0,
  { rows: realApprovedDecided.length, pending: realApprovedDecidedPending.map((r) => r.id) });
// 已通过的进「进行中」（或等同已通过档），不许 pending
check('2-05 真实数据：这些行落在「进行中」档（UI3）',
  realApprovedDecided.every((r) => ['running'].includes(RLC.UI3_bucketOf(r).key)),
  realApprovedDecided.map((r) => ({ id: r.id, group: RLC.groupOf(r).group, ui3: RLC.UI3_bucketOf(r).key })));

/* ── ③ poolBucket：done 未验收不得算 accepted（真实数据前后对比） ───────────── */
/** 旧实现（复制 fix 前的分支）——只用于「前后条数对比」的证据，不参与产品逻辑。 */
function legacyPoolBucket(row) {
  if (POOL.poolTypeGroup(row) === 'requirement') return POOL.poolBucket(row);
  if (POOL.acceptanceAccepted(row)) return 'accepted';
  const status = String((row && row.status) || '').toLowerCase();
  if (status === 'working' || status === 'dev_done' || status === 'test_done') return 'active';
  if (status === 'done' || status === 'accepted') return 'accepted';
  return 'pending';
}
const bugRows = poolRows.filter((row) => POOL.poolTypeGroup(row) !== 'requirement');
const doneUnaccepted = bugRows.filter((row) => String(row.status) === 'done' && !POOL.acceptanceAccepted(row));
const oldAccepted = bugRows.filter((row) => legacyPoolBucket(row) === 'accepted').length;
const newAccepted = bugRows.filter((row) => POOL.poolBucket(row) === 'accepted').length;
console.log(`      缺陷池「已验收」：修复前 ${oldAccepted} 条 → 修复后 ${newAccepted} 条；其中 done 但无 accepted 验收记录 ${doneUnaccepted.length} 条（单独计数 ${poolScope.unaccepted}）`);
check('3-01 缺陷行「已验收」只认 acceptanceRecord.status=accepted',
  bugRows.filter((row) => POOL.poolBucket(row) === 'accepted').every((row) => POOL.acceptanceAccepted(row)), { newAccepted });
check('3-02 真实数据：done 且 acceptanceRecord 缺/未 accepted 的缺陷一条都不是 accepted',
  doneUnaccepted.every((row) => POOL.poolBucket(row) !== 'accepted'),
  doneUnaccepted.map((row) => ({ id: row.id, bucket: POOL.poolBucket(row), label: row.statusLabel })));
check('3-03 前后对比：修复后「已验收」少了恰好 done 未验收的那些（不误伤真验收）',
  oldAccepted - newAccepted === doneUnaccepted.length && newAccepted === bugRows.filter((row) => POOL.acceptanceAccepted(row)).length,
  { oldAccepted, newAccepted, doneUnaccepted: doneUnaccepted.length });
check('3-04 done 未验收的行显示「已完成·未验收」并单独计数（不进已验收筛选）',
  doneUnaccepted.every((row) => row.statusLabel === '已完成·未验收' && POOL.poolBucket(row) === 'unaccepted')
  && poolScope.unaccepted === doneUnaccepted.length,
  { labels: [...new Set(doneUnaccepted.map((row) => row.statusLabel))], unaccepted: poolScope.unaccepted });
check('3-05 夹具：done + acceptanceRecord.status=rejected → 不是 accepted；accepted 记录才 accepted',
  POOL.poolBucket({ id: 'B-x', type: 'bug', status: 'done', acceptanceRecord: { status: 'rejected' } }) === 'unaccepted'
  && POOL.poolBucket({ id: 'B-y', type: 'bug', status: 'done', acceptanceRecord: { status: 'accepted' } }) === 'accepted');

/* ── ④ 「产品评审中」档：status=review + requirementReview 空 → 该档 ───────── */
const groupKeys = RLC.UI3_GROUPS.map((g) => g.key);
check('4-01 六档齐全（新建/正文中 · 产品评审中 · 等你决定 · 进行中 · 待验收 · 已收口）',
  groupKeys.join(',') === 'draft,product_review,pending,running,test_done,closed', groupKeys);
check('4-02 夹具：status=review + requirementReview 空 → 产品评审中（不是等你决定）',
  RLC.UI3_bucketOf({ id: 'R-6383', status: 'review' }).key === 'product_review'
  && RLC.UI3_statusTextOf('review') === '产品评审中');
check('4-03 夹具：review + RR verdict=reject（产品未通过）→ 仍是产品评审中',
  RLC.UI3_bucketOf({ id: 'R-rej', status: 'review', requirementReview: { verdict: 'reject' } }).key === 'product_review');
check('4-04 夹具：review + RR verdict=approve（产品已通过、等流程推进）→ 不在产品评审中',
  RLC.UI3_bucketOf({ id: 'R-ok', status: 'review', requirementReview: { verdict: 'approve' } }).key !== 'product_review');
check('4-05 夹具：approved 未决定 → 等你决定；accepted → 已收口（不回退既有口径）',
  RLC.UI3_bucketOf({ id: 'R-wait', status: 'approved' }).key === 'pending'
  && RLC.UI3_bucketOf({ id: 'R-closed', status: 'accepted' }).key === 'closed');
const realProductReview = reqs.filter((r) => ['review', 'requirement_review', 'product_review'].includes(String(r.status || '').toLowerCase()));
const realProductReviewEmpty = realProductReview.filter((r) => !(r.requirementReview && String(r.requirementReview.verdict || '').toLowerCase() === 'approve'));
const misbucketed = realProductReviewEmpty.filter((r) => RLC.UI3_bucketOf(r).key !== 'product_review');
check('4-06 真实数据：status=review 且 requirementReview 未通过 的行全部落「产品评审中」',
  misbucketed.length === 0, { rows: realProductReviewEmpty.length, bad: misbucketed.map((r) => ({ id: r.id, key: RLC.UI3_bucketOf(r).key })) });
// 评审弹窗的六档渲染口径与 UI3 一致（源码断言：档位列表来自 UI3_GROUPS 同一顺序）
check('4-07 评审弹窗 LIST_BUCKETS 含六档且顺序与 UI3 一致',
  (() => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'owner-review.js'), 'utf8');
    const keys = [...src.matchAll(/\{ key: '([a-z_]+)', label: '[^']+' \}/g)].map((m) => m[1]);
    return ['draft', 'product_review', 'pending', 'running', 'test_done', 'closed'].every((key, i) => keys[i] === key);
  })(), {});

/* ── ⑤ 已作废 / 已终态：不出现「可派单」──────────────────────────────────── */
check('5-01 夹具：status=ready 但已作废 → 不可派单（不显示可派单）',
  RLC.UI3_isDispatchable({ id: 'R-v', status: 'ready', voided: true }) === false
  && RLC.UI3_isDispatchable({ id: 'R-r', status: 'ready' }) === true
  && RLC.UI3_isDispatchable({ id: 'R-t', status: 'terminated' }) === false);
check('5-02 夹具：已终态既不是可派单，也不落「进行中/等你决定」',
  ['accepted', 'terminated', 'rejected', 'done'].every((status) => RLC.UI3_bucketOf({ id: 'R-' + status, status }).key === 'closed'
    && RLC.UI3_isDispatchable({ id: 'R-' + status, status }) === false));
const closedReal = reqs.filter((r) => ['accepted', 'done', 'terminated', 'rejected'].includes(String(r.status || '')));
const closedDispatchable = closedReal.filter((r) => RLC.UI3_isDispatchable(r));
check('5-03 真实数据：已收口/已终止行没有一条被判「可派单」', closedDispatchable.length === 0,
  closedDispatchable.map((r) => ({ id: r.id, status: r.status })));
const flowBadRows = flowData ? flowData.items.filter((it) => (it.closed || it.voided === true || ['accepted', 'done', 'terminated', 'rejected'].includes(it.status))
  && (it.statusText === '可派单' || it.dispatchable === true)) : [];
check('5-04 流程面板数据：已收口/已作废行的 statusText 不是「可派单」且 dispatchable=false',
  Boolean(flowData) && flowBadRows.length === 0, flowBadRows.slice(0, 5).map((it) => ({ id: it.id, status: it.status, text: it.statusText })));
const flowTerminatedTexts = flowData ? [...new Set(flowData.items.filter((it) => it.status === 'terminated').map((it) => it.statusText))] : [];
check('5-05 流程面板：terminated 行状态文案是「已终止」（可断言，不是英文/可派单）',
  Boolean(flowData) && flowTerminatedTexts.length > 0 && flowTerminatedTexts.every((t) => t === '已终止'), flowTerminatedTexts);
check('5-06 夹具：流程面板数据里 status=ready+voided 的行文案不是「可派单」',
  (() => {
    if (!flowApi) return false;
    // 用夹具行替换父级别的真实数据来源，验证同一函数对「作废但仍写 ready」的防御（历史脏数据形态）
    const fixture = { round: 1, requirements: [{ id: 'R-void-ready', status: 'ready', voided: true, priority: 'P1' }] };
    // eslint-disable-next-line no-new-func
    const factory = new Function('legacyWorkflow', 'flowLiveState', 'FLOW_STALE_AFTER_MS', 'window', `
      const FLOW_CLOSED_STATUSES = ['accepted', 'done', 'terminated', 'iteration', 'rejected'];
      ${flowParts.join('\n')}
      return { flowV4Data };
    `);
    const api = factory(() => fixture, { refreshedAt: Date.now(), lastError: null }, 60000, { ReviewListCore: RLC });
    const data = api.flowV4Data();
    const row = (data.items || []).find((it) => it.id === 'R-void-ready');
    return Boolean(row) && row.statusText !== '可派单' && row.dispatchable === false;
  })(), {});

/* ── ⑥ 新鲜度契约（AC3：超 60 秒未刷新要提示数据可能过期）──────────────────── */
const fresh = RLC.UI3_flowFreshness(new Date().toISOString(), Date.now(), 60000);
const stale = RLC.UI3_flowFreshness(new Date(Date.now() - 120000).toISOString(), Date.now(), 60000);
const never = RLC.UI3_flowFreshness(0, Date.now(), 60000);
check('6-01 刚刷新（now）→ stale=false 且有 refreshedAt', fresh.stale === false && fresh.refreshedAt);
check('6-02 120 秒前刷新 → stale=true（超过 60 秒）', stale.stale === true && stale.ageMs >= 120000);
check('6-03 从未刷新（0/空）→ stale=true 且 reason=NEVER_REFRESHED', never.stale === true && never.reason === 'NEVER_REFRESHED');
check('6-04 流程面板渲染出数据时间戳与过期提醒的锚点（data-flow-refreshed-at / data-flow-stale）',
  appSrc.includes('data-flow-refreshed-at') && appSrc.includes('data-flow-stale') && appSrc.includes('数据可能过期'));

/* ── ⑦ 只读取证：真实数据没被自检写坏 ─────────────────────────────────────── */
const afterWf = statOf(WF_FILE);
const afterTasks = countTasks();
check('7-01 自检只读：工作流.json sha256+mtime 未变', Boolean(beforeWf && afterWf) && beforeWf.sha256 === afterWf.sha256 && beforeWf.mtimeMs === afterWf.mtimeMs,
  { before: beforeWf && beforeWf.sha256.slice(0, 12), after: afterWf && afterWf.sha256.slice(0, 12) });
check('7-02 自检只读：任务/ 文件数未变', beforeTasks === afterTasks, { beforeTasks, afterTasks });

console.log(`\nUI3 三处口径自检：${pass}/${pass + failures.length} PASS`);
if (failures.length) {
  console.log(JSON.stringify(failures.slice(0, 12), null, 2));
  process.exitCode = 1;
} else {
  console.log('UI3_CONSISTENCY_OK');
}
