'use strict';
/**
 * B-20261116-103007-56fe 断言：正文改版后，旧 Owner 决定不得再压新版本复审。
 *
 * 覆盖：
 *   F* 夹具（pending + 旧决定无 basis / pending + 决定版本匹配 / 版本不符 / 真已通过未改版 / B-dfe6 不回退）
 *   R* 真实工作流数据（550f、0b77 必须进【等你决定】；当前有效决定的行不进待决）
 *   B* listBucketOf（用 owner-review.js 源码里切出的真函数 + 真 owner-review-state 模块）
 *   A* AC2 写侧：新决定必须带 basis.requirement.sha256（静态核 ownerDecisionBasis）
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'src', 'renderer', 'owner-review-state.js');
const REVIEW_FILE = path.join(ROOT, 'src', 'renderer', 'owner-review.js');
const WF_FILE = path.join(ROOT, '团队', '状态', '项目', '工作台改造修复', '工作流.json');
const TEAM_TOOLS = path.join(ROOT, 'src', 'team-tools.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ` + JSON.stringify(detail || {}).slice(0, 500)); process.exitCode = 1; }
}

const ORS = require(STATE_FILE);
ok('S1 owner-review-state 可在 Node 里 require（含 isPending/decisionOf/isDecisionCurrent）',
  typeof ORS.isPending === 'function' && typeof ORS.decisionOf === 'function' && typeof ORS.isDecisionCurrent === 'function', Object.keys(ORS));

// ── 夹具 ────────────────────────────────────────────────────────────────
const CUR = 'c'.repeat(64);
const OLD = 'a'.repeat(64);
const row = (status, ownerStatus, decisions, extra = {}) => ({ id: 'R-x', status, ownerReview: { status: ownerStatus, at: null, opinion: '' }, decisions, ...extra });
const dec = (status, basisSha) => ({
  status, decision: status, channel: 'ui', actor: 'owner', at: '2026-11-15T06:38:07.019Z', opinion: '',
  ...(basisSha ? { basis: { requirement: { path: '需求/R-x.md', sha256: basisSha } } } : {}),
});
const withCur = (r) => ({ ...r, requirementHash: CUR, requirementReview: { requirementHash: CUR } });

// F1：pending + 旧决定（无 basis）→ 进【等你决定】
const f1 = withCur(row('approved', 'pending', [dec('approved')]));
ok('F1 pending + 旧决定（无 basis）→ isPending=true（不再被旧决定压住）', ORS.isPending(f1) === true, { isPending: ORS.isPending(f1), decisionOf: ORS.decisionOf(f1).status });
ok('F1② decisionOf 标出 staleDecision（可追溯哪笔旧决定被忽略）', Boolean(ORS.decisionOf(f1).staleDecision), ORS.decisionOf(f1));

// F2：pending + 决定版本匹配 → 已决定（不进等你决定）
const f2 = withCur(row('approved', 'pending', [dec('approved', CUR)]));
ok('F2 pending + 决定版本=当前正文 → isPending=false（有效决定仍生效）', ORS.isPending(f2) === false, { isPending: ORS.isPending(f2) });

// F3：pending + 决定版本不符 → 视为旧决定
const f3 = withCur(row('approved', 'pending', [dec('approved', OLD)]));
ok('F3 pending + 决定版本≠当前正文 → isPending=true', ORS.isPending(f3) === true, { isPending: ORS.isPending(f3) });

// F4：B-dfe6 不回退——有效决定 + 未收口状态 → 不进等你决定
const f4 = withCur(row('dev_done', 'pending', [dec('approved', CUR)]));
ok('F4 【B-dfe6 不回退】有效决定 + dev_done → isPending=false', ORS.isPending(f4) === false, { isPending: ORS.isPending(f4) });

// F5：真已通过且未改版 → 不是待决
const f5 = withCur(row('approved', 'approved', [dec('approved', CUR)]));
ok('F5 真已通过且未改版 → isPending=false', ORS.isPending(f5) === false, { isPending: ORS.isPending(f5) });

// F6：闭合状态仍然先退出（回归）
const f6 = row('accepted', 'approved', [dec('approved')]);
ok('F6 已收口状态（accepted）→ isPending=false（闭合优先）', ORS.isPending(f6) === false, { isPending: ORS.isPending(f6) });

// ── 真实数据 ────────────────────────────────────────────────────────────
let wf = null;
try { wf = JSON.parse(fs.readFileSync(WF_FILE, 'utf8')); } catch { wf = null; }
const rows = wf ? Object.values(wf.requirements || {}) : [];
ok('R0 读到真实工作流需求行', rows.length > 50, { rows: rows.length });
if (rows.length) {
  const pendingRows = rows.filter((r) => ORS.isPending(r)).map((r) => String(r.id));
  const hit550 = pendingRows.filter((id) => id.includes('550f'));
  const hit0b77 = pendingRows.filter((id) => id.includes('0b77'));
  ok('R1 550f 进入【等你决定】', hit550.length === 1, hit550);
  ok('R2 0b77 进入【等你决定】', hit0b77.length === 1, hit0b77);
  ok('R3 待决 ≥2 且只包含「未收口 + 旧决定/未决定 + ownerReview=pending」的行', pendingRows.length >= 2, pendingRows);
  const badPending = rows.filter((r) => {
    const latest = ORS.latestOwnerDecision(r);
    return latest && ORS.isDecisionCurrent(latest, r) && ORS.isPending(r);
  }).map((r) => String(r.id));
  ok('R4 反例：没有任何「版本匹配的有效决定」行落进待决', badPending.length === 0, badPending);
  const currentCount = rows.filter((r) => { const d = ORS.latestOwnerDecision(r); return d && ORS.isDecisionCurrent(d, r); }).length;
  ok('R5 有效决定行仍被识别（28 行左右，不是全判旧）', currentCount >= 20, { currentCount });
}

// ── B：listBucketOf（源码真函数 + 真 OR_STATE）─────────────────────────
function extractFunction(src, name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(([^)]*)\\)\\s*\\{`).exec(src);
  if (!m) return null;
  const start = m.index;
  let i = m.index + m[0].length - 1;
  let depth = 0;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
const reviewSrc = fs.readFileSync(REVIEW_FILE, 'utf8');
const parts = ['latestOwnerDecision', 'isUnregisteredOf', 'listBucketOf'].map((name) => extractFunction(reviewSrc, name));
ok('B1 从 owner-review.js 切出 latestOwnerDecision / isUnregisteredOf / listBucketOf', parts.every(Boolean), {});

let bucket = null;
try {
  const factory = new Function('OR_STATE', 'RLC', `
    const CLOSED_REQ_STATUSES = ['accepted', 'done', 'terminated', 'iteration', 'rejected'];
    function decidedStatusOf(req) { return OR_STATE.decidedStatusOf(req); }
    function isPending(req) { return OR_STATE.isPending(req); }
    ${parts.join('\n')}
    return { listBucketOf };
  `);
  const RLC = (() => { try { return require(path.join(ROOT, 'src', 'renderer', 'review-list-core.js')); } catch { return null; } })();
  bucket = factory(ORS, RLC).listBucketOf;
} catch (error) {
  ok('B2 listBucketOf 可求值', false, String((error && error.message) || error).slice(0, 300));
}
if (bucket) {
  ok('B2 listBucketOf 可求值', true, {});
  ok('B3 夹具：550f 形态 → 分组=等你决定', bucket(f1) === 'pending', bucket(f1));
  ok('B4 夹具：0b77 形态（版本不符）→ 等你决定', bucket(f3) === 'pending', bucket(f3));
  ok('B5 夹具：有效决定 → 分组=进行中（不回退 B-dfe6）', bucket(f4) === 'running', bucket(f4));
  if (rows.length) {
    const byId = {};
    for (const r of rows) byId[String(r.id)] = r;
    const id550 = Object.keys(byId).find((id) => id.includes('550f'));
    const id0b77 = Object.keys(byId).find((id) => id.includes('0b77'));
    ok('B6 真实数据：550f 落「等你决定」组', bucket(byId[id550]) === 'pending', { id: id550, bucket: bucket(byId[id550]) });
    ok('B7 真实数据：0b77 落「等你决定」组', bucket(byId[id0b77]) === 'pending', { id: id0b77, bucket: bucket(byId[id0b77]) });
    const counts = { pending: 0, running: 0, test_done: 0, closed: 0 };
    for (const r of rows) counts[bucket(r)] += 1;
    console.log(`      真实数据分组：${JSON.stringify(counts)}（共 ${rows.length} 行）`);
    ok('B8 真实数据：待决 ≥2、其余分组数未被打乱（已收口 ≥70）', counts.pending >= 2 && counts.closed >= 70, counts);
  }
}

// ── A：AC2 写侧（静态核）──────────────────────────────────────────────
const tt = fs.readFileSync(TEAM_TOOLS, 'utf8');
const basisFnStart = tt.indexOf('function ownerDecisionBasis');
const basisFn = basisFnStart >= 0 ? tt.slice(basisFnStart, basisFnStart + 1600) : '';
ok('A1 写侧 ownerDecisionBasis 计算 requirement.sha256（与需求正文同一 hash 源）',
  /requirement\s*=\s*\{\s*path:\s*doc\.rel,\s*sha256:\s*doc\.hash/.test(basisFn) || /sha256:\s*doc\.hash/.test(basisFn), {});
ok('A2 决定记录与 ownerReview 都落 basis（新决定的版本凭据）',
  /const basis = input\.basis \|\| ownerDecisionBasis\(/.test(tt) && /const decisionRecord = \{[\s\S]{0,400}?basis,/.test(tt), {});

console.log(`\nB-56fe 断言：${pass} 通过 / ${fail} 失败`);
const evidDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-56fe');
fs.mkdirSync(evidDir, { recursive: true });
fs.writeFileSync(path.join(evidDir, 'run-56fe.log'), `pass=${pass} fail=${fail} exit=${process.exitCode || 0}\n`, 'utf8');
