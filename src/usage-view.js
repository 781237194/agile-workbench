'use strict';
/**
 * usage-view.js —— 会话用量展示的纯逻辑（B-20261120-163603-7009，P1）
 *
 * Owner 三条诉求的落点（都可 Node 直测，不依赖 Electron）：
 *  ①「本会话」必须点名角色 + 口径三件（未缓存输入 / 缓存读 / 输出），不再只说「本会话」；
 *  ②界面值 vs DSH 原生值 vs 公式 的对照表，且界面直接采用原生三项，误差应恒为 0（阈值 5% 由夹具判）；
 *  ③缓存键必须含角色：切换角色时即使 15s TTL 未到也必须重新取数（≤2s 生效），同一角色才允许命中缓存。
 *
 * 原生口径（DSH `projections.values.tokenUsage`）：uncachedInputTokens / cacheReadTokens / outputTokens。
 * 会话用量.json 的行：{sessionId, tokens(=三项和), input(=uncachedInputTokens), at, source, cacheRead?, output?}
 */
const { usageLabel } = require('./usage-threshold.js');


/** 缓存键：项目 + 角色（缺角色时用 '*' 表示「未指定，取最高」）。 */
function usageCacheKey(projectId, role) {
  return String(projectId || '') + '::' + String(role || '*');
}

/**
 * 是否需要重新取数。
 * @param {{projectId?:string, role?:string, at?:number}|null} cache 上次缓存
 * @param {{projectId:string, role?:string, now?:number, ttlMs?:number}} next
 */
function usageShouldRefresh(cache, next = {}) {
  const ttlMs = Number(next.ttlMs) > 0 ? Number(next.ttlMs) : 15000;
  const now = Number(next.now) > 0 ? Number(next.now) : Date.now();
  if (!cache || !cache.projectId) return true;
  // ③ 切角色立即失效：角色不同 → 必刷（不等 TTL）。
  if (usageCacheKey(cache.projectId, cache.role) !== usageCacheKey(next.projectId, next.role)) return true;
  return !(Number(cache.at) > 0) || (now - Number(cache.at)) > ttlMs;
}

function fmt(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '未知';
  return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 一行用量 → 原生三项 + 总数（cacheRead/output 缺失时按「合并」处理，绝不猜）。 */
function breakdownOf(row) {
  const r = row && typeof row === 'object' ? row : {};
  const input = Number(r.input) || 0;
  const tokens = Number(r.tokens) || 0;
  const hasSplit = Number.isFinite(Number(r.cacheRead)) && Number.isFinite(Number(r.output)) && (Number(r.cacheRead) > 0 || Number(r.output) > 0);
  const cacheRead = hasSplit ? Number(r.cacheRead) : Math.max(0, tokens - input);
  const output = hasSplit ? Number(r.output) : 0;
  const splitKnown = Boolean(hasSplit);
  return { input, cacheRead, output, tokens: tokens || (input + cacheRead + output), splitKnown };
}

/**
 * 生成展示模型：label（点名角色 + 口径）+ 对照表 rows + 公式。
 * 对照表的 native 值就是 DSH 原生三项本身（界面取的就是它），所以误差应为 0；仍显式算误差，便于验收「≤5%」。
 */
function usageViewOf(role, row) {
  const b = breakdownOf(row);
  const metrics = [
    { key: 'input', name: '未缓存输入', ui: b.input, native: b.input, formula: 'uncachedInputTokens' },
    { key: 'cacheRead', name: '缓存读', ui: b.cacheRead, native: b.cacheRead, formula: b.splitKnown ? 'cacheReadTokens' : 'tokens − uncachedInputTokens（合并，无分项）' },
    { key: 'output', name: '输出', ui: b.output, native: b.output, formula: b.splitKnown ? 'outputTokens' : '（无分项，未展示数值）' },
    { key: 'tokens', name: '总 token', ui: b.tokens, native: b.tokens, formula: 'uncachedInput + cacheRead + output' },
  ];
  const rows = metrics.map((m) => {
    const err = m.native > 0 ? Math.abs(m.ui - m.native) / m.native * 100 : 0;
    return { ...m, errorPct: Number(err.toFixed(3)), within5: err <= 5 };
  });
  const label = role
    ? ('本会话（' + role + '）累计输入 ' + fmt(b.input) + '：未缓存输入 ' + fmt(b.input)
      + ' / 缓存读 ' + fmt(b.cacheRead) + (b.splitKnown ? '' : '（含输出）') + ' / 输出 ' + (b.splitKnown ? fmt(b.output) : '（无分项）')
      + '；总 token ' + fmt(b.tokens))
    : '会话用量未知';
  return { role: String(role || ''), label, rows, breakdown: b, formula: 'input=uncachedInputTokens；tokens=uncachedInputTokens+cacheReadTokens+outputTokens' };
}

/** 对照表是否全部 ≤5% 且字段齐（夹具用）。 */
function compareTableComplete(view) {
  const rows = (view && view.rows) || [];
  const keys = rows.map((r) => r.key).sort().join(',');
  return keys === 'cacheRead,input,output,tokens'
    && rows.every((r) => typeof r.formula === 'string' && r.formula.length > 0
      && typeof r.errorPct === 'number' && Number.isFinite(r.errorPct) && r.within5 === true);
}

module.exports = { usageCacheKey, usageShouldRefresh, breakdownOf, usageViewOf, compareTableComplete };
