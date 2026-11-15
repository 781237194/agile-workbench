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
  running: ['ready', 'dispatched', 'dev', 'dev_review', 'dev_done', 'test', 'iteration_open'],
  test_done: ['test_done'],
  closed: ['accepted', 'done', 'terminated', 'iteration', 'rejected']
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
 * 来源优先级：ac-parse 已解析的 acs[]（有 id/title）→ 正文 detail/acceptance 里逐行识别 → 兜底整段一条。
 * 返回 [{ id, kind:'AC'|'功能点'|'边界', text, raw }]
 */
function acItemsOf(row, parsed) {
  const items = [];
  const seen = new Set();
  const push = (item) => {
    const id = trimText(item.id);
    const text = textOf(item.text).trim();
    if (!id || !text || seen.has(id)) return;
    seen.add(id);
    items.push({ id, kind: item.kind || 'AC', text, raw: text });
  };
  const acs = parsed && Array.isArray(parsed.acs) ? parsed.acs : [];
  for (const ac of acs) {
    push({ id: ac.id, kind: 'AC', text: [ac.id && `${ac.id}`, ac.title || ''].filter(Boolean).join('：') + (ac.what ? '' : '') });
  }
  // 正文逐行：ACx / 功能点 F-x / 边界六类
  const body = [textOf(row && row.detail), textOf(row && row.acceptance), textOf(row && row.story)].join('\n');
  for (const line of body.split(/\r?\n/)) {
    const text = trimText(line);
    if (!text) continue;
    // 顺序要紧：功能点 F-x 先认（否则会被通用 `[A-Z]-` 当成 AC），边界六类再认，最后才是 AC。
    const fp = text.match(/^(F-[\w.-]+)[：:、.\s]\s*(.+)$/);
    if (fp) { push({ id: trimText(fp[1]), kind: '功能点', text: `${trimText(fp[1])}：${fp[2]}` }); continue; }
    const bd = text.match(BOUNDARY_RE);
    if (bd) { push({ id: `边界-${bd[1]}`, kind: '边界', text: `${bd[1]}：${bd[2]}` }); continue; }
    const ac = text.match(/^(AC\s*\d+)[：:、.\s]\s*(.+)$/);
    if (ac) { push({ id: trimText(ac[1]).replace(/\s+/g, ''), kind: 'AC', text: `${trimText(ac[1])}：${ac[2]}` }); continue; }
  }
  if (!items.length) {
    const whole = trimText(body);
    if (whole) items.push({ id: 'AC-未编号', kind: 'AC', text: whole, raw: whole });
  }
  return items;
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

const api = { GROUPS, STATUS_GROUP, FIELD_LABEL, groupOf, overdueOf, unreadOf, updatedAtOf, sortRows, groupRows, acItemsOf, copyBlocksOf, copyMissingAttr };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.ReviewListCore = api;
