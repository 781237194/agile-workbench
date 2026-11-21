'use strict';
/**
 * 390a：代管到期时间显示（本机时区）。浏览器全局 + Node 可 require。
 *
 * 规则：今天 →「今天 11:50」；明天 →「明天 09:30」；其它 →「11-22 09:30」。
 * allActive 判定与文案同源：Date.parse(expiresAt) > now。
 */
(function (global) {
  const pad = (n) => String(n).padStart(2, '0');
  function localParts(ms) {
    const d = new Date(ms);
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), H: pad(d.getHours()), M: pad(d.getMinutes()) };
  }
  function dayDiff(fromMs, toMs) {
    const a = new Date(fromMs); a.setHours(0, 0, 0, 0);
    const b = new Date(toMs); b.setHours(0, 0, 0, 0);
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }
  function formatProxyExpiry(expiresAt, nowMs) {
    const ms = Date.parse(String(expiresAt || ''));
    if (!Number.isFinite(ms)) return null;
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const p = localParts(ms);
    const clock = p.H + ':' + p.M;
    const full = `${p.y}-${pad(p.m)}-${pad(p.d)} ${clock}`;
    const diff = dayDiff(now, ms);
    const label = diff === 0 ? '今天 ' + clock : (diff === 1 ? '明天 ' + clock : `${pad(p.m)}-${pad(p.d)} ${clock}`);
    return { clock, full, label, dayDiff: diff, active: ms > now, expiresMs: ms };
  }
  const api = { formatProxyExpiry };
  try { global.AWBProxyExpiry = api; } catch { /* ignore */ }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
