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

const api = { GROUPS, STATUS_GROUP, FIELD_LABEL, groupOf, overdueOf, unreadOf, updatedAtOf, sortRows, groupRows, acItemsOf, takePointsOf, copyBlocksOf, copyMissingAttr };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.ReviewListCore = api;
