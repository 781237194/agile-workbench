'use strict';
/**
 * usage-threshold.js —— 会话用量阈值判定的**纯函数**（B-20261120-020530-0823）
 *
 * 为什么抽出来：原先 `src/main.js → ipcMain.handle('session:usage')` 里把
 * `warnThreshold = 300000 / forceThreshold = 500000` 写死，导致 pm（该 60/100 万）被按 30 万判
 * force、项目 项目.json → sessionLimits 覆盖也不生效。Owner 2026-11-20 02:0x 截图
 * 「会话用量 375.7 万 / 阈值 30 万」即此。
 *
 * 现在判定全部走这里，阈值只由调用方从**单源** `session.mjs → sessionLimitsOf(name).of(role)` 取；
 * 本模块不持有任何默认阈值，拿不到就返回 unknown（绝不静默回落写死值——那正是原 bug 的成因）。
 */

/**
 * @param {object} input
 * @param {number} input.tokens  该角色累计 tokens
 * @param {boolean} input.missing 会话用量.json 缺失
 * @param {boolean} input.stale   该行 at 超过 24h 或不可解析
 * @param {{warn:number|null, force:number|null, source:string}} input.limits 该角色的阈值（可能为空）
 * @returns {{level:'ok'|'warn'|'force'|'unknown', why:string}}
 */
function classifyUsage({ tokens, missing, stale, limits }) {
  const t = Number(tokens) || 0;
  if (missing) return { level: 'unknown', why: 'USAGE_FILE_MISSING' };
  if (stale) return { level: 'unknown', why: 'USAGE_STALE' };
  const warn = Number(limits && limits.warn);
  const force = Number(limits && limits.force);
  if (!Number.isFinite(warn) || warn <= 0 || !Number.isFinite(force) || force <= 0) {
    return { level: 'unknown', why: 'LIMITS_UNAVAILABLE' };
  }
  if (t >= force) return { level: 'force', why: 'TOKENS_GE_FORCE' };
  if (t >= warn) return { level: 'warn', why: 'TOKENS_GE_WARN' };
  return { level: 'ok', why: 'TOKENS_LT_WARN' };
}

/**
 * 一句话文案：说清「最高是谁 + 它的阈值 + 超几倍」。禁止跨角色混排（0823 AC③）。
 * @param {{role:string,tokens:number,warn:number|null,level:string}|null} top
 * @param {(n:number)=>string} fmtTokens
 */
function usageLabel(top, fmtTokens) {
  const fmt = typeof fmtTokens === 'function' ? fmtTokens : (n) => String(n);
  if (!top) return '会话用量未知';
  const warn = Number(top.warn) || 0;
  const ratio = warn > 0 ? Number(top.tokens) / warn : 0;
  const head = `会话用量最高：${top.role} ${fmt(top.tokens)}（其阈值 ${fmt(warn)}）`;
  if (top.level === 'force') return `${head}，已超 ${ratio ? ratio.toFixed(1) : '?'} 倍 → 需换人`;
  if (top.level === 'warn') return `${head}，已超 ${ratio ? ratio.toFixed(1) : '?'} 倍 → 接近上限`;
  if (top.level === 'unknown') return `${head}，阈值未知（不可判定）`;
  return `${head}，未超阈值`;
}

/** 多角色里最严重的档位：force > warn > ok > unknown（全员 unknown 才报 unknown）。 */
function severityOf(levels) {
  const list = Array.isArray(levels) ? levels : [];
  if (list.includes('force')) return 'force';
  if (list.includes('warn')) return 'warn';
  if (list.includes('ok')) return 'ok';
  return 'unknown';
}

module.exports = { classifyUsage, usageLabel, severityOf };
