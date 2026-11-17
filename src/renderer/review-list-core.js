'use strict';
/**
 * review-list-core.js —— R-dba4 渲染层纯逻辑（T-20261115-131640-3957）
 *
 * 需求 §一 第 3/4/5 条：
 *   ③ 每个 AC / 功能点 / 边界条目独立 <li data-ac-id="AC1">，保留编号、不合并、不截断；
 *   ④ 四块大白话（what/how/impact/advice）取持久化 copy，缺哪块用正文兜底并标 data-copy-missing；
 *   ⑤ 弹窗四组（待决定 / 进行中 / 待验收 / 已收口）+ 组内排序（逾期 > 未读 > updatedAt 倒序 > id 字典序），
 *      未列状态落「待决定」并标 data-status-unknown。
 *
 * 这里只做纯函数（无 DOM / 无 IPC），owner-review.js 负责渲染，scripts/test-review-list.cjs 直接断言。
 */

const GROUPS = [
  { key: 'pending', label: '等你决定' },
  { key: 'running', label: '进行中' },
  { key: 'test_done', label: '待验收' },
  { key: 'closed', label: '已收口' }
];
/** 已收口/进行中/待验收的**全部**状态映射（不在表里的状态 → 待决定 + unknown 标记，不许丢行）。 */
const STATUS_GROUP = {
  pending: ['pending', 'owner_review', 'approved', 'review', 'requirement_review', 'tech_review', 'product_review'],
  running: ['ready', 'dispatched', 'dev', 'dev_review', 'dev_done', 'test', 'iteration_open', 'iteration'],
  test_done: ['test_done'],
  // B-4226：iteration 是「返工轮进行中」，不是已收口——放 closed 会让 Owner 在「等你决定」看不到它，
  // 重评通过、Owner 重批后也仍被当收口态。
  closed: ['accepted', 'done', 'terminated', 'rejected']
};
const CLOSED = new Set(STATUS_GROUP.closed);
const FIELD_LABEL = { what: '这是什么', how: '怎么做', impact: '影响谁', advice: '建议你拍板' };
const BOUNDARY_RE = /^(?:[-*·]\s*)?(?:边界[-－—-]?)?(空值|异常|权限|并发|降级|模式)[：:]\s*(.+)$/;

function textOf(value) { return value === null || value === undefined ? '' : String(value); }
function trimText(value) { return textOf(value).replace(/\s+/g, ' ').trim(); }

/** 需求 → 四组之一；返回 { group, statusUnknown }。 */
function groupOf(row) {
  const status = trimText(row && row.status).toLowerCase();
  if (!status) return { group: 'pending', statusUnknown: true };
  // B-20261116-094215-2ff6①：已有 Owner 决定（decisions 末条 approved/skipped，且绑当前正文版本）的行，
  // 不得再按「approved / owner_review 状态」归到等你决定——这是「Owner 已经批过、界面还在等他」的根因。
  // 无决定的行仍走下面的状态映射（approved 且未决定 → 等你决定，test-review-list G-01 口径不变）。
  if (!CLOSED.has(status)) {
    const decided = UI3_ownerDecisionOf(row);
    if (decided === 'approved' || decided === 'skipped') return { group: 'running', statusUnknown: false };
  }
  for (const item of GROUPS) {
    if (STATUS_GROUP[item.key].includes(status)) return { group: item.key, statusUnknown: false };
  }
  // 未列状态：落待决定并打标（以前这些行会因为「不在任何分组」而消失）
  return { group: CLOSED.has(status) ? 'closed' : 'pending', statusUnknown: true };
}

/** 是否逾期：行上 due/逾期标记优先；缺 due 视为不逾期（不猜）。 */
function overdueOf(row, nowMs) {
  if (row && (row.overdue === true || row.overdueAt)) return true;
  const due = Date.parse(trimText(row && row.due));
  if (!Number.isFinite(due)) return false;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return due < now;
}
function unreadOf(row) {
  if (row && row.readAt) return false;
  if (row && row.unread === false) return false;
  return row && (row.unread === true || row.needAck === true || !row.readAt);
}
function updatedAtOf(row) {
  const ms = Date.parse(trimText(row && (row.updatedAt || row.at)));
  return Number.isFinite(ms) ? ms : 0;
}

/** 组内排序：逾期 > 未读 > updatedAt 倒序 > id 字典序（稳定、可复算）。 */
function sortRows(rows, nowMs) {
  return (Array.isArray(rows) ? rows.slice() : []).sort((a, b) => {
    const oa = overdueOf(a, nowMs) ? 1 : 0; const ob = overdueOf(b, nowMs) ? 1 : 0;
    if (oa !== ob) return ob - oa;
    const ua = unreadOf(a) ? 1 : 0; const ub = unreadOf(b) ? 1 : 0;
    if (ua !== ub) return ub - ua;
    const ta = updatedAtOf(a); const tb = updatedAtOf(b);
    if (ta !== tb) return tb - ta;
    return trimText(a && a.id).localeCompare(trimText(b && b.id));
  });
}

/** 整体分组：{ groups:[{key,label,count,rows}], unknownCount } —— 四组恒定存在（空组也给）。 */
function groupRows(rows, nowMs) {
  const list = Array.isArray(rows) ? rows : [];
  const buckets = { pending: [], running: [], test_done: [], closed: [] };
  let unknownCount = 0;
  for (const row of list) {
    const info = groupOf(row);
    if (info.statusUnknown) unknownCount += 1;
    buckets[info.group].push(row);
  }
  return {
    groups: GROUPS.map((item) => ({ ...item, rows: sortRows(buckets[item.key], nowMs), count: buckets[item.key].length })),
    unknownCount
  };
}

/**
 * AC / 功能点 / 边界 → 独立条目（保编号、不合并、不截断）。
 * 来源优先级（R-0dbb F2 扩充）：
 *   ① ac-parse 已解析的 block acs[]（`### ACn`）→ data-ac-source=block；
 *   ② ac-parse 解析的 v2 行内 acs（`- **ACn（…）**`，block 存在时不混排）→ data-ac-source=inline；
 *   ③ 正文（docText + detail + acceptance + story）里逐行识别 AC / 功能点 / 边界 → AC 记 fallback；
 *   ④ 兜底整段一条 `AC-未编号`（source=fallback，不出人话位，AC7）。
 * 返回 [{ id, kind, text, raw, source, plain, plainMissing }]
 *   - kind='功能点'/'边界' 属合成项：source 固定 synthetic（渲染层不写 data-ac-source，AC2）；
 *   - plain 只在正文写了人话时存在（值必是正文原文子串，AC6）；plainMissing 表示「该出人话位但正文没写」。
 */
function acItemsOf(row, parsed) {
  const items = [];
  const seen = new Set();
  const push = (item) => {
    const id = trimText(item.id);
    const text = textOf(item.text).trim();
    if (!id || !text || seen.has(id)) return;
    seen.add(id);
    const kind = item.kind || 'AC';
    const isAc = kind === 'AC';
    const plain = isAc ? textOf(item.plain).trim() : '';
    items.push({
      id,
      kind,
      text,
      raw: text,
      // 合成项固定 synthetic（不是 block/inline/fallback 三态之一），渲染层据此不写 data-ac-source。
      source: isAc ? (item.source || 'fallback') : 'synthetic',
      plain,
      // 兜底项（AC-未编号）与合成项/行扫描项不出人话位；block/inline 没写人话才标 missing。
      plainMissing: isAc && ['block', 'inline'].includes(item.source || 'fallback') && !plain
    });
  };
  const acs = parsed && Array.isArray(parsed.acs) ? parsed.acs : [];
  for (const ac of acs) {
    push({ id: ac.id, kind: 'AC', source: 'block', plainMissing: true, text: [ac.id && `${ac.id}`, ac.title || ''].filter(Boolean).join('：') + (ac.what ? '' : '') });
  }
  // R-0dbb F2：block 优先（AC8 不混排），否则吃行内解析结果。
  const inlineAcs = (!acs.length && parsed && Array.isArray(parsed.inlineAcs)) ? parsed.inlineAcs : [];
  for (const ac of inlineAcs) {
    push({ id: ac.id, kind: 'AC', source: 'inline', plain: ac.plain, plainMissing: !ac.plain, text: ac.text || `${ac.id}：${ac.title || ''}` });
  }
  // 正文逐行：ACx / 功能点 F-x / 边界六类（R-0dbb F2：AC 逐行识别补 row.docText；F-/边界沿用旧口径 detail 系，
  // 不因正文里的边界表格行给老正文造条目——AC7 要求老正文仍是一条 AC-未编号、不逐条报缺）。
  const detailBody = [textOf(row && row.detail), textOf(row && row.acceptance), textOf(row && row.story)].join('\n');
  const body = [textOf(row && row.docText), detailBody].join('\n');
  for (const line of detailBody.split(/\r?\n/)) {
    const text = trimText(line);
    if (!text) continue;
    // 顺序要紧：功能点 F-x 先认（否则会被通用 `[A-Z]-` 当成 AC），边界六类再认，最后才是 AC。
    const fp = text.match(/^(F-[\w.-]+)[：:、.\s]\s*(.+)$/);
    if (fp) { push({ id: trimText(fp[1]), kind: '功能点', text: `${trimText(fp[1])}：${fp[2]}` }); continue; }
    const bd = text.match(BOUNDARY_RE);
    if (bd) { push({ id: `边界-${bd[1]}`, kind: '边界', text: `${bd[1]}：${bd[2]}` }); continue; }
    const ac = text.match(/^(AC\s*\d+)[：:、.\s]\s*(.+)$/);
    if (ac) { push({ id: trimText(ac[1]).replace(/\s+/g, ''), kind: 'AC', source: 'fallback', text: `${trimText(ac[1])}：${ac[2]}` }); continue; }
  }
  // 正文里的行首 AC（`AC1：…` 老写法）也要认，但不与上面重复（seen 已按 id 去重）。
  for (const line of body.split(/\r?\n/)) {
    const text = trimText(line);
    if (!text) continue;
    const ac = text.match(/^(AC\s*\d+)[：:、.\s]\s*(.+)$/);
    if (ac) push({ id: trimText(ac[1]).replace(/\s+/g, ''), kind: 'AC', source: 'fallback', text: `${trimText(ac[1])}：${ac[2]}` });
  }
  // 一条 AC 都没识别到 → 整段兜底一条（AC7：老正文不逐条报缺、也不空着）。
  if (!items.some((item) => item.kind === 'AC')) {
    const whole = trimText(body);
    if (whole) items.push({ id: 'AC-未编号', kind: 'AC', text: whole, raw: whole, source: 'fallback', plain: '', plainMissing: false });
  }
  return items;
}

/** R-0dbb F4：取舍点小节标题关键词。 */
const TAKE_HEAD_RE = /(待确认|取舍|二选一|选项)/;
/** R-0dbb F4：变更/历史类小节不参与取舍抽取（避免「AC1 改为…」这类历史行冒充待拍板点）。 */
const TAKE_SKIP_HEAD_RE = /(变更|历史|记录|附录|关联|基线|影响面|状态)/;
const TAKE_SENTENCE_SPLIT_RE = /[\n。；;]/;

function takeCandidateText(raw) {
  let text = trimText(raw)
    .replace(/^[-*+·]\s+/, '')
    .replace(/^\*\*[^*]{1,20}\*\*\s*[：:]?\s*/, '')
    .replace(/^[（(]?\d+[）).、]\s*/, '');
  if (!text) return '';
  if (text.length < 4) return '';
  if (/^(见|参考|引用|同上)/.test(text)) return '';
  return text.length > 40 ? text.slice(0, 40) : text;
}

/**
 * R-0dbb F4：取舍点提取（给「建议你定：」用）。
 * 取数对象＝row.docText（正文）；无 docText 回退 row.detail（现状 :787 跑的是 detail，很多行是 0 字）。
 * 来源：①小节标题含「待确认/取舍/二选一/选项」的段落；②正文里「A 还是 B」「二选一」「A 案/B 案」句式；③「改为」句式（最弱，排最后）。
 * 返回 { points:[≤40 字，最多 3 条], total, extra, source } —— extra = 超出条数（渲染「另有 N 条取舍」）。
 * 只抽取/截断，不生成语义（AC6）。
 */
function takePointsOf(row) {
  const doc = textOf(row && row.docText);
  const detail = textOf(row && row.detail);
  const text = doc.trim() ? doc : detail;
  const source = doc.trim() ? 'doc' : (detail.trim() ? 'detail' : 'none');
  if (!text.trim()) return { points: [], total: 0, extra: 0, source };
  const lines = text.split(/\r?\n/);
  const fromSections = [];
  const fromStrong = [];
  const fromCase = [];
  const fromLabel = [];
  const fromWeak = [];
  const skip = new Set();
  // ① 小节：标题命中关键词 → 收该小节内的条目行；变更/历史类小节整段跳过。
  let inTake = false;
  let inSkip = false;
  for (const line of lines) {
    const head = /^(#{2,4})\s+(.*)$/.exec(line.trim());
    if (head) {
      const title = head[2];
      inSkip = TAKE_SKIP_HEAD_RE.test(title) && !TAKE_HEAD_RE.test(title);
      inTake = TAKE_HEAD_RE.test(title) && !inSkip;
      continue;
    }
    if (inSkip) { skip.add(line); continue; }
    if (!inTake) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const candidate = takeCandidateText(trimmed);
    if (candidate) fromSections.push(candidate);
  }
  // ② 句式：按句读切，跳过变更/历史小节的行，避免历史叙述冒充取舍。
  for (const line of lines) {
    if (skip.has(line)) continue;
    if (/^(#{1,6})\s+/.test(line.trim())) continue;
    for (const piece of line.split(TAKE_SENTENCE_SPLIT_RE)) {
      const candidate = takeCandidateText(piece);
      if (!candidate) continue;
      if (/还是|二选一/.test(candidate)) fromStrong.push(candidate);
      else if (/[ABab]\s*案/.test(candidate)) fromCase.push(candidate);
      else {
        const label = /(?:待确认|风险|取舍|建议)\s*[：:]\s*(.+)$/.exec(candidate);
        if (label) {
          const text = takeCandidateText(label[1]);
          if (text) fromLabel.push(text);
        } else if (/改为/.test(candidate)) fromWeak.push(candidate);
      }
    }
  }
  const ordered = [];
  const seen = new Set();
  for (const bucket of [fromSections, fromStrong, fromCase, fromLabel, fromWeak]) {
    for (const candidate of bucket) {
      const key = candidate.replace(/\s+/g, '').replace(/[，,、：:。（）()]/g, '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      ordered.push(candidate);
    }
  }
  const total = ordered.length;
  const points = ordered.slice(0, 3);
  return { points, total, extra: Math.max(0, total - points.length), source };
}



/**
 * 四块大白话：持久化 copy 优先；缺的块用正文摘要兜底，并标 missing（渲染层据此写 data-copy-missing）。
 * 返回 [{ key, label, text, missing:boolean, filledBy:'copy'|'fallback'|'none' }]
 */
function copyBlocksOf(row, storedCopy) {
  const stored = storedCopy && typeof storedCopy === 'object' ? storedCopy : {};
  const derived = {
    what: trimText(row && (row.title || row.summary)),
    how: trimText(row && (row.howText || row.detail)),
    impact: trimText(row && (row.impact || row.ownerRole || row.owner)),
    advice: trimText(row && (row.advice || row.suggestion))
  };
  const blocks = [];
  for (const key of ['what', 'how', 'impact', 'advice']) {
    const own = trimText(stored[key]);
    if (own) { blocks.push({ key, label: FIELD_LABEL[key], text: own, missing: false, filledBy: 'copy' }); continue; }
    const back = derived[key];
    if (back) { blocks.push({ key, label: FIELD_LABEL[key], text: back, missing: true, filledBy: 'fallback' }); continue; }
    blocks.push({ key, label: FIELD_LABEL[key], text: `（正文缺：${FIELD_LABEL[key]}）`, missing: true, filledBy: 'none' });
  }
  return blocks;
}

/** 渲染层用的 data-copy-missing 值（只列缺的块，空串表示四块齐全）。 */
function copyMissingAttr(blocks) {
  return (Array.isArray(blocks) ? blocks : []).filter((b) => b.missing).map((b) => b.key).join(',');
}

/* ════════════════════════════════════════════════════════════════════════
 * UI3：三处「需求口径」的唯一判定（B-20261116-094215-2ff6 / B-20261116-095320-410e /
 * B-20261116-100905-1211）
 *
 * 口径定义（写死，三处必须同源）：
 *   - 口径数字 = 工作流.json 里的需求行（registered），当前 100 行；
 *   - 快照兜底行（task-only / legacy-doc，unregistered=true）单列说明，**不计入**口径数字；
 *   - 评审弹窗六档：新建/正文中 → 产品评审中 → 等你决定 → 进行中 → 待验收 → 已收口。
 *
 * 命名：渲染层多个 <script> 共用全局词法作用域（2026-11-16 曾因跨文件顶层 const 撞名整份脚
 * 本 SyntaxError），本块所有顶层标识符一律带 UI3_ 前缀，只能新增、不能顶掉既有名字。
 * ════════════════════════════════════════════════════════════════════════ */

/** 已收口（与 app.js FLOW_CLOSED_STATUSES / flow-v4.js CLOSED 同口径）。 */
const UI3_CLOSED_STATUSES = ['accepted', 'done', 'terminated', 'rejected'];
/** 产品评审阶段的状态（产品还没通过、还不该 Owner 看）。 */
const UI3_PRODUCT_REVIEW_STATUSES = ['review', 'requirement_review', 'product_review'];
/** 新建 / 正文中（还没进产品评审）。 */
const UI3_DRAFT_STATUSES = ['new', 'draft', 'drafting', 'writing', 'created', 'open', 'requirement', 'pending'];
/** 进行中（产品已通过之后的实现链）。 */
const UI3_RUNNING_STATUSES = ['ready', 'dispatched', 'dev', 'dev_review', 'dev_done', 'test', 'iteration', 'iteration_open', 'tech_review'];
/** 六档（顺序 = 评审弹窗展示顺序）。 */
const UI3_GROUPS = [
  { key: 'draft', label: '新建/正文中' },
  { key: 'product_review', label: '产品评审中' },
  { key: 'pending', label: '等你决定' },
  { key: 'running', label: '进行中' },
  { key: 'test_done', label: '待验收' },
  { key: 'closed', label: '已收口' }
];
/** 需求状态 → 人话（流程面板 / 池 / 评审共用同一张表；不再各写一份）。 */
const UI3_STATUS_TEXT = {
  new: '新建/正文中', draft: '新建/正文中', drafting: '新建/正文中', writing: '新建/正文中',
  created: '新建/正文中', open: '新建/正文中', requirement: '新建/正文中', pending: '新建/正文中',
  review: '产品评审中', requirement_review: '产品评审中', product_review: '产品评审中',
  approved: '等你决定', owner_review: '等你决定',
  tech_review: '技术评审', ready: '可派单', dispatched: '已派单', dev: '开发中', dev_review: '开发互审',
  dev_done: '开发完成', test: '测试中', test_done: '待验收',
  accepted: '已验收', done: '已完成', terminated: '已终止', rejected: '已驳回', iteration: '迭代中', iteration_open: '迭代中'
};

function UI3_statusOf(row) { return trimText(row && row.status).toLowerCase(); }

/** 快照兜底行：工作流里没有行、由任务镜像 / 需求正文兜底出来的行（不计入口径数字）。 */
function UI3_isFallbackRow(row) {
  if (!row || typeof row !== 'object') return false;
  return row.unregistered === true || row.registered === false
    || row.source === 'task-only' || row.source === 'legacy-doc';
}

/**
 * Owner 决定派生（与 owner-review-state.js 的 decidedStatusOf 同判据）：
 * decisions[] 末条优先 → ownerReview.status；末条决定若绑的是旧正文版本（无 basis / hash 不等）
 * 视为没有决定（那是上一版的决定，当前版本仍等重新决定）。
 * 浏览器里优先用已加载的 OwnerReviewState（唯一实现），Node 单测/脚本缺失时用本文件同一套兜底。
 */
function UI3_ownerDecisionOf(row) {
  const state = (typeof globalThis !== 'undefined' && globalThis.OwnerReviewState) ? globalThis.OwnerReviewState : null;
  if (state && typeof state.decidedStatusOf === 'function') return trimText(state.decidedStatusOf(row)).toLowerCase();
  const owner = (row && row.ownerReview && typeof row.ownerReview === 'object') ? row.ownerReview : {};
  const top = Array.isArray(row && row.decisions) ? row.decisions.filter(Boolean) : [];
  const legacy = Array.isArray(owner.decisions) ? owner.decisions.filter(Boolean) : [];
  const latest = top.length ? top[top.length - 1] : (legacy.length ? legacy[legacy.length - 1] : null);
  const pick = (value) => {
    const text = trimText(value).toLowerCase();
    return ['approved', 'rejected', 'skipped'].includes(text) ? text : '';
  };
  if (!latest) return pick(owner.status);
  const from = pick(latest.status || latest.decision);
  if (!from) return pick(owner.status);
  // 版本校验（与 owner-review-state.js isDecisionCurrent 同口径）
  const basis = (latest.basis && typeof latest.basis === 'object' && latest.basis.requirement) ? latest.basis.requirement : {};
  const decidedSha = trimText(basis.sha256);
  const decidedContent = trimText(basis.contentHash);
  if (!decidedSha && !decidedContent) return ''; // 旧决定（无版本凭据）→ 过期
  const rr = (row && row.requirementReview && typeof row.requirementReview === 'object') ? row.requirementReview : {};
  const currentSha = trimText(row && (row.requirementHash || row.docHash)) || trimText(rr.requirementHash);
  const currentContent = trimText(rr.contentHash) || trimText(row && row.contentHash);
  if (!currentSha && !currentContent) return from; // 行上没有版本信息 → 无法证明过期，按当前算
  if (decidedSha && currentSha && decidedSha === currentSha) return from;
  if (decidedContent && currentContent && decidedContent === currentContent) return from;
  return '';
}

/** 产品评审结论（requirementReview 优先，其次 productReview；无记录返回空串）。 */
function UI3_productVerdictOf(row) {
  const rr = (row && row.requirementReview && typeof row.requirementReview === 'object') ? row.requirementReview : {};
  const pr = (row && row.productReview && typeof row.productReview === 'object') ? row.productReview : {};
  return trimText(rr.verdict || pr.verdict || '').toLowerCase();
}

/** 这一行当前能不能「派单」（ready 且未作废、未收口）；流程面板的「可派单」只认它。 */
function UI3_isDispatchable(row) {
  const status = UI3_statusOf(row);
  if (status !== 'ready') return false;
  if (row && row.voided === true) return false;
  return !UI3_CLOSED_STATUSES.includes(status);
}

/**
 * 六档判定（唯一实现）：返回 { key, statusUnknown }。
 * 顺序写死：已收口 > 已决定（已通过/已跳过 → 进行中）> 产品评审中 > 等你决定 > 待验收 > 进行中 > 新建。
 * 注：评审弹窗的「等你决定」仍先走 owner-review.js 的 isPending（现有口径不变，含打回后复审、
 * 决定绑旧版浮出），本函数只负责 isPending 之外的档；模块缺失时 owner-review.js 有同口径兜底。
 */
function UI3_bucketOf(row) {
  const status = UI3_statusOf(row);
  if (!status) return { key: 'draft', statusUnknown: true };
  if (UI3_CLOSED_STATUSES.includes(status)) return { key: 'closed', statusUnknown: false };
  const decided = UI3_ownerDecisionOf(row);
  if (decided === 'approved' || decided === 'skipped') return { key: 'running', statusUnknown: false };
  if (UI3_PRODUCT_REVIEW_STATUSES.includes(status)) {
    // 产品已通过（RR approve）但状态没推进：交给流程/派单链，不再混进「产品评审中」，也不塞给 Owner。
    return { key: UI3_productVerdictOf(row) === 'approve' ? 'running' : 'product_review', statusUnknown: false };
  }
  if (status === 'approved' || status === 'owner_review') return { key: 'pending', statusUnknown: false };
  if (decided === 'rejected') return { key: 'pending', statusUnknown: false }; // 打回后已改：重新等 Owner 复审
  if (status === 'test_done') return { key: 'test_done', statusUnknown: false };
  if (UI3_RUNNING_STATUSES.includes(status)) return { key: 'running', statusUnknown: false };
  if (UI3_DRAFT_STATUSES.includes(status)) return { key: 'draft', statusUnknown: false };
  // 未列状态：不丢行、落等决定并打标（与 groupOf 同口径）。
  return { key: 'pending', statusUnknown: true };
}

/** 状态人话；流程面板的 statusText 与池标签都从这里取，避免各写一份。 */
function UI3_statusTextOf(rowOrStatus) {
  const raw = (rowOrStatus && typeof rowOrStatus === 'object') ? rowOrStatus.status : rowOrStatus;
  const status = trimText(raw).toLowerCase();
  return UI3_STATUS_TEXT[status] || trimText(raw) || '—';
}

/** 需求行集合口径：{ all, registered, fallback }（fallback = 快照兜底行，不计入口径数字）。 */
function UI3_requirementSet(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let fallback = 0;
  for (const row of list) if (UI3_isFallbackRow(row)) fallback += 1;
  return { all: list.length, registered: list.length - fallback, fallback };
}

/** 六档计数 + 口径数字（三处共用；没有行的档给 0，不省略）。 */
function UI3_groupCounts(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const counts = { draft: 0, product_review: 0, pending: 0, running: 0, test_done: 0, closed: 0 };
  let unknown = 0;
  for (const row of list) {
    const info = UI3_bucketOf(row);
    if (Object.prototype.hasOwnProperty.call(counts, info.key)) counts[info.key] += 1;
    if (info.statusUnknown) unknown += 1;
  }
  const set = UI3_requirementSet(list);
  return {
    all: list.length,
    registered: set.registered,
    fallback: set.fallback,
    unknown,
    counts,
    groups: UI3_GROUPS.map((item) => ({ key: item.key, label: item.label, count: counts[item.key] || 0 })),
    open: list.length - counts.closed,
    closed: counts.closed
  };
}

/** 已收口（工作流口径）= accepted/done/terminated/rejected，供池/流程复用。 */
function UI3_isClosedRow(row) { return UI3_CLOSED_STATUSES.includes(UI3_statusOf(row)); }

/**
 * 流程面板数据新鲜度：refreshedAt 是「最后一次成功读到工作流」的时刻（ISO 或毫秒）。
 * 超过 staleAfterMs（默认 60 秒）没刷新 → stale=true，界面必须写「数据可能过期」，不许静默停在旧数字。
 */
function UI3_flowFreshness(refreshedAt, nowMs, staleAfterMs) {
  const raw = refreshedAt === null || refreshedAt === undefined ? '' : refreshedAt;
  const atMs = typeof raw === 'number' ? (raw > 0 ? raw : NaN) : Date.parse(trimText(raw));
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const limit = Number.isFinite(staleAfterMs) && staleAfterMs > 0 ? staleAfterMs : 60000;
  if (!Number.isFinite(atMs)) return { refreshedAt: '', ageMs: null, stale: true, reason: 'NEVER_REFRESHED', limitMs: limit };
  const ageMs = Math.max(0, now - atMs);
  return {
    refreshedAt: new Date(atMs).toISOString(),
    ageMs,
    stale: ageMs > limit,
    reason: ageMs > limit ? 'STALE' : 'FRESH',
    limitMs: limit
  };
}

/**
 * B-20261117-190649-d113：评审弹窗「验收点」逐条换行。
 *
 * 需求验收标准常被写成「①…；②…；③…」一整串，塞进一行后 Owner 无法逐条核对。
 * 这里只做**拆行**：不裁切、不改写、不排序，`lines.join('')` 与原文（去掉空行与 \n）逐字相等。
 * 三个分支（按优先级）：
 *   ① `\n`：显式换行一律拆（空行剔除）；
 *   ② 条目前缀：①-⑳ / ⒈-⒛ / ⑴-⒇ / 1) / 1） / (1) / 1. —— 只认落在「；;。！？!?、，,」之后的（段首的那个由 0 位天然保留），
 *      避免把「共 3 步」「1.5 倍」这类正文数字误当条目头；
 *   ③ 无编号但「；」分隔 ≥3 段：按「；」拆，分隔符留在行尾（同样零丢失）。
 * 纯函数（无 DOM / 无 IPC），scripts/test-review-list.cjs 直接断言。
 */
const ACCEPT_ITEM_HEAD_RE = /[①-⑳⒈-⒛⑴-⒇]|[（(]\s*\d{1,2}\s*[)）]|\d{1,2}\s*[)）]|\d{1,2}\s*[.．](?![\d.．])/g;
const ACCEPT_SEP_BEFORE_RE = /[；;。！？!?、，,]/;

function acceptBoundaryAt(text, at) {
  let i = at - 1;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  if (i < 0) return false;
  return ACCEPT_SEP_BEFORE_RE.test(text[i]);
}

function splitAcceptanceOneLine(value) {
  const text = textOf(value);
  if (!text) return [];
  const cuts = [];
  ACCEPT_ITEM_HEAD_RE.lastIndex = 0;
  let m = ACCEPT_ITEM_HEAD_RE.exec(text);
  while (m) {
    const at = m.index;
    // 段首（at<=0）本来就该留在这行；只有「分隔符之后」的前缀才算新条目。
    if (at > 0 && acceptBoundaryAt(text, at)) cuts.push(at);
    m = ACCEPT_ITEM_HEAD_RE.exec(text);
  }
  if (cuts.length) {
    const lines = [];
    let prev = 0;
    for (const at of cuts) { lines.push(text.slice(prev, at)); prev = at; }
    lines.push(text.slice(prev));
    return lines.filter((line) => line.trim());
  }
  // ③ 无编号：「；」分隔 ≥3 段才拆（2 段属于同一句，拆了反而碎）。
  const parts = text.split(/(?<=[；;])/).filter((p) => p.trim());
  if (parts.length >= 3) return parts;
  return [text];
}

/** 验收点原文 → string[]；空输入给 []（渲染层负责「未记录」兜底）。 */
function splitAcceptanceLines(value) {
  const raw = textOf(value);
  if (!raw.trim()) return [];
  const lines = [];
  for (const piece of raw.split(/\r?\n/)) {
    if (!piece.trim()) continue;
    for (const line of splitAcceptanceOneLine(piece)) lines.push(line);
  }
  return lines.length ? lines : [raw];
}

const api = { GROUPS, STATUS_GROUP, FIELD_LABEL, groupOf, overdueOf, unreadOf, updatedAtOf, sortRows, groupRows, acItemsOf, takePointsOf, copyBlocksOf, copyMissingAttr,
  // B-20261117-190649-d113：验收点逐条换行（owner-review.js 渲染 [data-or-accept-line]）
  splitAcceptanceLines,
  // B-2ff6 / B-410e / B-1211：三处同源口径（UI3 前缀，见上方注释）
  UI3_GROUPS, UI3_CLOSED_STATUSES, UI3_STATUS_TEXT,
  UI3_statusOf, UI3_isFallbackRow, UI3_ownerDecisionOf, UI3_productVerdictOf, UI3_isDispatchable,
  UI3_bucketOf, UI3_statusTextOf, UI3_requirementSet, UI3_groupCounts, UI3_isClosedRow, UI3_flowFreshness };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.ReviewListCore = api;
