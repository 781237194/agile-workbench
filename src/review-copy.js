'use strict';
/**
 * review-copy.js —— R-dba4 数据层：评审界面「大白话」持久化（T-20261115-131639-3999）
 *
 * 背景（需求 §〇 基线核对）：评审卡片的 what/how/impact/advice 一直是**渲染期现算**
 * （`src/renderer/ac-parse.js:165 boardFieldsOf` + `owner-review.js:931` 取数），
 * 正文一改、重启一次就没了，Owner 说「说明又没了」。
 *
 * 本模块只做纯逻辑（无 fs / 无 DOM），由 src/main.js 的 IPC 落盘到壳层 store
 * （`workbench.json → projects[].reviewCopy.rows[需求id]`），渲染层按「有 copy 用 copy、
 * 缺哪块用正文兜底并在 DOM 标 data-copy-missing」渲染。
 *
 * 口径（任务 detail 五条）：
 *   ① copy = { what, how, impact, advice, at, by, source: 'author'|'derived' }
 *   ② derived = **写入时快照**：首次生成或显式「刷新草案」才写；之后正文改动不重算
 *   ③ copyHistory[] 保留历史（重评 / 重启不清空，上限 HISTORY_LIMIT 条，先进先出）
 *   ④ 缺字段时由渲染层兜底，**数据层不伪造**（这里只如实标注缺了哪几块）
 *   ⑤ 作者写（source='author'）优先于派生写；派生写不得覆盖作者写（除非显式 refresh 且来源仍是 author）
 */

const FIELDS = ['what', 'how', 'impact', 'advice'];
const SOURCES = ['author', 'derived'];
const HISTORY_LIMIT = 20;
const MAX_FIELD_LEN = 400;

function textOf(value) {
  return value === null || value === undefined ? '' : String(value);
}

function clip(value, limit) {
  const text = textOf(value).replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

/** 归一化一条 copy：只留四个白名单字段 + 元信息；缺的字段写空串（不伪造）。 */
function normalizeCopy(input, meta = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const source = SOURCES.includes(textOf(meta.source || src.source)) ? textOf(meta.source || src.source) : 'derived';
  const copy = {};
  for (const field of FIELDS) copy[field] = clip(src[field], MAX_FIELD_LEN);
  copy.at = textOf(meta.at || src.at) || '';
  copy.by = textOf(meta.by || src.by) || '';
  copy.source = source;
  return copy;
}

/** 缺了哪几块（渲染层据此标 data-copy-missing，数据层不补造）。 */
function missingFields(copy, fallback = {}) {
  const src = copy && typeof copy === 'object' ? copy : {};
  const fb = fallback && typeof fallback === 'object' ? fallback : {};
  const missing = [];
  for (const field of FIELDS) {
    const own = textOf(src[field]).trim();
    const back = textOf(fb[field]).trim();
    if (!own && back) missing.push({ field, filledBy: 'fallback', value: back });
    else if (!own && !back) missing.push({ field, filledBy: 'none', value: '' });
  }
  return missing;
}

/** 某需求的 copy 记录（不存在时给空壳，不写盘）。 */
function recordOf(projectEntry, requirementId) {
  const rows = (projectEntry && projectEntry.reviewCopy && projectEntry.reviewCopy.rows) || {};
  const row = rows[textOf(requirementId)] || null;
  return {
    copy: row && row.copy ? normalizeCopy(row.copy) : null,
    copyHistory: row && Array.isArray(row.copyHistory) ? row.copyHistory.slice() : [],
    updatedAt: row ? textOf(row.updatedAt) || '' : ''
  };
}

/**
 * 写入决策（纯函数，返回新记录 + 是否变化 + 原因）。
 * @param {object|null} existing 现有记录 {copy, copyHistory}
 * @param {object} incoming 本次要写的 copy（未归一）
 * @param {object} opts { refresh?:boolean, at?:ISO, by?:string }
 * @returns {{record:{copy,copyHistory,updatedAt}, changed:boolean, reason:string}}
 */
function decideSave(existing, incoming, opts = {}) {
  const prev = existing && typeof existing === 'object' ? existing : {};
  const prevCopy = prev.copy ? normalizeCopy(prev.copy) : null;
  const prevHistory = Array.isArray(prev.copyHistory) ? prev.copyHistory.slice() : [];
  const at = textOf(opts.at) || new Date().toISOString();
  const by = textOf(opts.by) || '';
  const rawSource = textOf((incoming && incoming.source) || 'derived');
  const nextCopy = normalizeCopy(incoming, { at, by, source: rawSource });
  const hasContent = FIELDS.some((field) => textOf(nextCopy[field]).trim());
  if (!hasContent) return { record: { copy: prevCopy, copyHistory: prevHistory, updatedAt: textOf(prev.updatedAt) }, changed: false, reason: 'EMPTY_COPY' };

  // ①首次：直接落（来源按传入；derived 视为「写入时快照」）
  if (!prevCopy) return { record: { copy: nextCopy, copyHistory: prevHistory, updatedAt: at }, changed: true, reason: 'FIRST_SNAPSHOT' };

  // ②同一份内容再写：幂等（不重复进历史）
  const same = FIELDS.every((field) => textOf(prevCopy[field]) === textOf(nextCopy[field]));
  if (same && textOf(prevCopy.source) === textOf(nextCopy.source)) {
    return { record: { copy: prevCopy, copyHistory: prevHistory, updatedAt: textOf(prev.updatedAt) }, changed: false, reason: 'IDEMPOTENT' };
  }

  // ③作者写优先：author 可以覆盖任何来源；derived 不得覆盖已有 author（除非显式 refresh 且这次仍是 author）
  if (textOf(nextCopy.source) === 'derived' && textOf(prevCopy.source) === 'author' && opts.refresh !== true) {
    return { record: { copy: prevCopy, copyHistory: prevHistory, updatedAt: textOf(prev.updatedAt) }, changed: false, reason: 'AUTHOR_WINS' };
  }
  // ④派生写：只有显式 refresh（点「刷新草案」）才重算；否则正文改了也不动 —— 这就是「写入时快照」
  if (textOf(nextCopy.source) === 'derived' && opts.refresh !== true) {
    return { record: { copy: prevCopy, copyHistory: prevHistory, updatedAt: textOf(prev.updatedAt) }, changed: false, reason: 'SNAPSHOT_FROZEN' };
  }

  const history = prevHistory.concat([{ ...prevCopy, replacedAt: at }]).slice(-HISTORY_LIMIT);
  return { record: { copy: nextCopy, copyHistory: history, updatedAt: at }, changed: true, reason: textOf(nextCopy.source) === 'author' ? 'AUTHOR_UPDATE' : 'REFRESH_DERIVED' };
}

/** 把一次保存结果写回项目条目（就地修改；调用方负责 writeStore）。 */
function applySave(projectEntry, requirementId, decision, at) {
  const entry = projectEntry && typeof projectEntry === 'object' ? projectEntry : null;
  if (!entry) return false;
  entry.reviewCopy = (entry.reviewCopy && typeof entry.reviewCopy === 'object') ? entry.reviewCopy : { version: 1, rows: {} };
  entry.reviewCopy.version = 2;
  entry.reviewCopy.rows = (entry.reviewCopy.rows && typeof entry.reviewCopy.rows === 'object') ? entry.reviewCopy.rows : {};
  entry.reviewCopy.rows[textOf(requirementId)] = { ...decision.record, updatedAt: textOf(decision.record.updatedAt) || textOf(at) };
  entry.reviewCopy.updatedAt = textOf(at);
  return true;
}

const api = {
  FIELDS,
  SOURCES,
  HISTORY_LIMIT,
  MAX_FIELD_LEN,
  normalizeCopy,
  missingFields,
  recordOf,
  decideSave,
  applySave
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.ReviewCopy = api;
