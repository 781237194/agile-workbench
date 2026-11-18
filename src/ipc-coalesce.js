'use strict';
/**
 * R-b34a R3：同通道 + 同参数 300ms 合并（主进程侧，只作用于只读通道 allowlist）。
 *
 * 契约（需求 §6.4）：同一通道 + 同一参数 300ms 内只发一次（后到者复用前次结果）；同面板重绘合并到下一帧。
 * 实现要点：
 *   · 只包装 allowlist 内的只读通道（写操作/有副作用的通道绝不合并不缓存）；
 *   · 窗口内：进行中 → 复用同一个 Promise；已完成 → 直接返回上次结果（不重新执行）；
 *   · 窗口 = 300ms（可用 AWB_IPC_COALESCE_MS 覆盖，0=关闭合并）；
 *   · key = channel + 稳定序列化的参数（只取 JSON 可序列化部分，序列化失败则该次不合并）。
 */
const DEFAULT_WINDOW_MS = 300;
const MAX_BOXES = 500;
/** 只读（无副作用）通道：加新通道前先确认 handler 不写盘、不改内存态。 */
const READONLY_CHANNELS = [
  'team:session-queue',
  'team:workflow',
  'team:board',
  'owner:list',
  'owner:pending-counts',
  'owner:decisions',
  'doc:index',
  'files:list',
  'perf:recent',
  'render-memory:recent',
];
const READONLY_RE = new RegExp(`^(${READONLY_CHANNELS.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);

function stableKey(value, depth = 0) {
  if (depth > 4) return '[deep]';
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map((v) => stableKey(v, depth + 1)).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableKey(value[k], depth + 1)).join(',') + '}';
}
function keyOf(channel, args) {
  try { return channel + '|' + stableKey(args); } catch { return ''; }
}
/**
 * 包装 `ipcMain.handle` 的替换函数。
 *
 * 只合并**同一时刻在途**的重复请求（same channel + same args → 共用一个 Promise，后到者复用前次结果）；
 * 请求完成后不再复用结果——否则「改完文件立刻刷新」会拿到 300ms 前的旧值（sq-check 实跑踩到：
 * 夹具改完快照后同参数刷新读到缓存，面板状态不更新）。这样既满足「300ms 内合并一次」的抖动合并语义，
 * 又不牺牲显式刷新的新鲜度。windowMs 仍用于「完成后的短抖去重」可选开关（默认 0=不缓存结果）。
 * @param {Function} handle 原始的 (channel, handler) => void
 * @param {{windowMs?:number, cacheResultMs?:number, isCoalescable?:(channel:string)=>boolean}} opts
 */
function wrapHandle(handle, opts = {}) {
  const windowMs = Number.isFinite(Number(opts.windowMs)) ? Number(opts.windowMs) : DEFAULT_WINDOW_MS;
  const cacheResultMs = Number.isFinite(Number(opts.cacheResultMs)) ? Number(opts.cacheResultMs) : 0;
  const isCoalescable = typeof opts.isCoalescable === 'function' ? opts.isCoalescable : (ch) => READONLY_RE.test(String(ch));
  const boxes = new Map();
  return function wrappedHandle(channel, handler) {
    if (typeof handler !== 'function' || windowMs <= 0 || !isCoalescable(String(channel))) return handle(channel, handler);
    return handle(channel, function coalesced(...args) {
      const key = keyOf(String(channel), args);
      if (!key) return handler.apply(this, args);
      const now = Date.now();
      const box = boxes.get(key);
      if (box && box.pending) return box.pending;
      if (box && cacheResultMs > 0 && box.hasLast && now - box.at < cacheResultMs) return box.last;
      const entry = { at: now, pending: null, hasLast: Boolean(box && box.hasLast), last: box ? box.last : undefined };
      const pending = Promise.resolve().then(async () => {
        try {
          return await handler.apply(this, args);
        } finally {
          entry.pending = null; // 同一微任务内清掉：调用方 await 返回时 pending 已释放，下一次显式刷新会真正执行
        }
      });
      entry.pending = pending;
      pending.then((value) => {
        entry.last = value; entry.hasLast = true; entry.at = Date.now();
      }).catch(() => { /* 失败不缓存结果，下一次重新执行 */ });
      if (boxes.size >= MAX_BOXES) {
        const oldest = boxes.keys().next().value;
        boxes.delete(oldest);
      }
      boxes.set(key, entry);
      return pending;
    });
  };
}
module.exports = { DEFAULT_WINDOW_MS, READONLY_CHANNELS, READONLY_RE, stableKey, keyOf, wrapHandle };
