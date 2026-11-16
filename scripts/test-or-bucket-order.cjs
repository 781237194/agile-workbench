'use strict';
/**
 * P0（2026-11-16 Owner 截图 77/14）：断言「我的评审 · 全部需求」分组顺序正确。
 * 被修的问题：owner-review.js `listBucketOf()` 先判「有 Owner 决定 → 进行中」，
 * 再判 closed 状态 → 凡被 Owner 批过、随后验收通过/终止的需求全被塞进「进行中」。
 *
 * 本脚本**直接抽取 owner-review.js 里的真实函数**（latestOwnerDecision / decidedStatusOf /
 * isUnregisteredOf / isPending / listBucketOf）来跑，不复制一份实现——复制实现等于自测自己。
 * 断言分两类：
 *   U*：夹具行（含本 bug 的关键形态：status=accepted + decisions 末条 approved）
 *   R*：真实工作流.json 的不变量（凡 status ∈ 已收口集合 的行，必须落在「已收口」组）
 * 另加 S*：源码顺序断言（closed 判定必须早于 decided 判定），防以后被改回旧顺序。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC_FILE = path.join(ROOT, 'src', 'renderer', 'owner-review.js');
const WF_FILE = path.join(ROOT, '团队', '状态', '项目', '工作台改造修复', '工作流.json');

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ${JSON.stringify(detail).slice(0, 400)}`); process.exitCode = 1; }
}

const src = fs.readFileSync(SRC_FILE, 'utf8');

/** 从源码里按名字切出一个函数（含 body），花括号配平；跳过 // 行注释。 */
function extractFunction(name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(([^)]*)\\)\\s*\\{`).exec(src);
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

const FN_NAMES = ['latestOwnerDecision', 'decidedStatusOf', 'isUnregisteredOf', 'isPending', 'listBucketOf'];
const parts = FN_NAMES.map((n) => extractFunction(n));
ok('S1 五个真实函数都从源码里切出来了', parts.every(Boolean), FN_NAMES.filter((n, i) => !parts[i]));

let api = null;
try {
  // OR_STATE=null（未加载 owner-review-state.js 时的分支）、RLC=null（未加载 review-list-core.js 时的兜底分支）
  // eslint-disable-next-line no-new-func
  const factory = new Function('OR_STATE', 'RLC', `
    const CLOSED_REQ_STATUSES = ['accepted', 'done', 'terminated', 'iteration', 'rejected'];
    ${parts.join('\n')}
    return { listBucketOf, isPending, decidedStatusOf, latestOwnerDecision };
  `);
  api = factory(null, null);
} catch (e) {
  ok('S2 抽出的函数能被求值', false, String(e && e.message || e));
}
ok('S2 抽出的函数能被求值', Boolean(api && typeof api.listBucketOf === 'function'));

if (!api) {
  console.log(`\n分组顺序断言：${pass} 通过 / ${fail} 失败（函数抽取失败，后续跳过）`);
  process.exit(1);
}

const bucket = (row) => api.listBucketOf(row);
const row = (status, extra = {}) => ({ id: 'R-x', status, ...extra });
const decided = (status) => ({ decisions: [{ status, at: '2026-11-16T00:00:00.000Z' }] });

// ── U：夹具行 ─────────────────────────────────────────────────────────────
ok('U1 【本 bug】status=accepted + Owner 已通过 → 已收口（不是进行中）', bucket(row('accepted', decided('approved'))) === 'closed', bucket(row('accepted', decided('approved'))));
ok('U2 status=terminated + Owner 已通过 → 已收口', bucket(row('terminated', decided('approved'))) === 'closed', bucket(row('terminated', decided('approved'))));
ok('U3 status=iteration + Owner 已打回 → 已收口', bucket(row('iteration', decided('rejected'))) === 'closed', bucket(row('iteration', decided('rejected'))));
ok('U4 status=accepted 且无任何决定 → 已收口', bucket(row('accepted')) === 'closed', bucket(row('accepted')));
ok('U5 status=rejected + decisions 末条 rejected → 已收口', bucket(row('rejected', decided('rejected'))) === 'closed', bucket(row('rejected', decided('rejected'))));
ok('U6 【B-dfe6 不回退】status=test_done + Owner 已通过 → 进行中（不进等你决定）', bucket(row('test_done', decided('approved'))) === 'running', bucket(row('test_done', decided('approved'))));
ok('U7 status=dev_done + Owner 已跳过 → 进行中', bucket(row('dev_done', decided('skipped'))) === 'running', bucket(row('dev_done', decided('skipped'))));
ok('U8 status=owner_review 且无决定 → 等你决定', bucket(row('owner_review')) === 'pending', bucket(row('owner_review')));
ok('U9 status=approved 且无决定 → 等你决定', bucket(row('approved')) === 'pending', bucket(row('approved')));
ok('U10 status=test_done 无决定 → 待验收', bucket(row('test_done')) === 'test_done', bucket(row('test_done')));
ok('U11 未登记行（task-only）→ 进行中（不混进等你决定）', bucket(row('accepted', { source: 'task-only' })) === 'running', bucket(row('accepted', { source: 'task-only' })));
ok('U12 未知状态不丢行（无 RLC 兜底 → 进行中）', bucket(row('some_new_status')) === 'running', bucket(row('some_new_status')));

// ── S：源码顺序（防改回旧顺序）────────────────────────────────────────────
const idxClosed = src.indexOf("if (CLOSED_REQ_STATUSES.includes(status)) return 'closed'");
const idxDecided = src.indexOf("if (decided === 'approved' || decided === 'skipped') return 'running'");
ok('S3 源码里「已收口」判定早于「已通过→进行中」', idxClosed > 0 && idxDecided > 0 && idxClosed < idxDecided, { idxClosed, idxDecided });

// ── R：真实工作流不变量 ───────────────────────────────────────────────────
const CLOSED_KEYS = ['accepted', 'done', 'terminated', 'iteration', 'rejected'];
let realRows = [];
try { realRows = Object.values(JSON.parse(fs.readFileSync(WF_FILE, 'utf8')).requirements || {}); } catch { realRows = []; }
ok('R0 读到真实工作流需求行', realRows.length > 50, { rows: realRows.length });

if (realRows.length) {
  const summary = { pending: 0, running: 0, test_done: 0, closed: 0 };
  for (const r of realRows) summary[bucket(r)] = (summary[bucket(r)] || 0) + 1;
  console.log(`      真实数据分组：${JSON.stringify(summary)}（共 ${realRows.length} 行）`);

  const closedButNotClosed = realRows.filter((r) => CLOSED_KEYS.includes(String(r.status || '')) && bucket(r) !== 'closed');
  ok('R1 不变量：凡 status ∈ 已收口集合 的行都落在「已收口」', closedButNotClosed.length === 0, closedButNotClosed.slice(0, 5).map((r) => ({ id: r.id, status: r.status, got: bucket(r) })));

  const decidedApprovedInPending = realRows.filter((r) => {
    const o = api.decidedStatusOf(r);
    return (o === 'approved' || o === 'skipped') && bucket(r) === 'pending';
  });
  ok('R2 【B-dfe6】真实数据里没有任何「Owner 已通过/已跳过」的行落进等你决定', decidedApprovedInPending.length === 0, decidedApprovedInPending.slice(0, 5).map((r) => r.id));

  // 期望值（PM 口径：已收口约 80、进行中约 8、等你决定 0–3）；用宽松区间防真实数据每次新增需求就红。
  ok('R3 已收口 ≥ 75（修复前只有 14）', summary.closed >= 75, summary);
  ok('R4 进行中 ≤ 15（修复前 76）', summary.running <= 15, summary);
  ok('R5 等你决定 0–3', summary.pending <= 3, summary);
}

// ── W：带真实伴随模块（owner-review-state.js / review-list-core.js）再跑一遍 ──
// 真实界面里这两个模块一定加载，listBucketOf 会走 OR_STATE.isPending 与 RLC.groupOf 分支；
// 只测裸兜底分支等于漏掉线上真实路径。
let OR_STATE = null;
let RLC = null;
try { OR_STATE = require(path.join(ROOT, 'src', 'renderer', 'owner-review-state.js')); } catch { OR_STATE = null; }
try { RLC = require(path.join(ROOT, 'src', 'renderer', 'review-list-core.js')); } catch { RLC = null; }
ok('W1 真实伴随模块可加载（owner-review-state / review-list-core）', Boolean(OR_STATE && RLC), { OR_STATE: Boolean(OR_STATE), RLC: Boolean(RLC) });

let apiReal = null;
if (OR_STATE && RLC) {
  // eslint-disable-next-line no-new-func
  const factoryReal = new Function('OR_STATE', 'RLC', `
    const CLOSED_REQ_STATUSES = ['accepted', 'done', 'terminated', 'iteration', 'rejected'];
    ${parts.join('\n')}
    return { listBucketOf, isPending, decidedStatusOf };
  `);
  apiReal = factoryReal(OR_STATE, RLC);
}
if (apiReal) {
  const b2 = (r) => apiReal.listBucketOf(r);
  ok('W2 （线上分支）status=accepted + Owner 已通过 → 已收口', b2(row('accepted', decided('approved'))) === 'closed', b2(row('accepted', decided('approved'))));
  ok('W3 （线上分支）B-dfe6 不回退：test_done + Owner 已通过 → 进行中', b2(row('test_done', decided('approved'))) === 'running', b2(row('test_done', decided('approved'))));
  ok('W4 （线上分支）owner_review 无决定 → 等你决定', b2(row('owner_review')) === 'pending', b2(row('owner_review')));
  if (realRows.length) {
    const s2 = { pending: 0, running: 0, test_done: 0, closed: 0 };
    for (const r of realRows) s2[b2(r)] = (s2[b2(r)] || 0) + 1;
    console.log(`      真实数据分组（线上分支）：${JSON.stringify(s2)}（共 ${realRows.length} 行）`);
    const bad2 = realRows.filter((r) => CLOSED_KEYS.includes(String(r.status || '')) && b2(r) !== 'closed');
    ok('W5 （线上分支）真实数据：已收口行全部落在「已收口」', bad2.length === 0, bad2.slice(0, 5).map((r) => ({ id: r.id, status: r.status, got: b2(r) })));
    ok('W6 （线上分支）真实数据：已收口 ≥75 且 进行中 ≤15', s2.closed >= 75 && s2.running <= 15, s2);
  }
}

console.log(`\n分组顺序断言：${pass} 通过 / ${fail} 失败`);

const evidDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-ororder');
fs.mkdirSync(evidDir, { recursive: true });
fs.writeFileSync(path.join(evidDir, 'run-ororder.log'), `pass=${pass} fail=${fail} exit=${process.exitCode || 0}\nrows=${realRows.length}\n`, 'utf8');
