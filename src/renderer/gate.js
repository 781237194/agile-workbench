'use strict';
/**
 * R-b34a R4：渲染层「可见性驱动」小工具（无依赖、可 Node 直测）。
 *
 * 背景：渲染层多处 setInterval 在「面板不可见 / 窗口切后台」时仍照常跑，白耗 IPC 与主进程 CPU。
 * 本模块只做三件事（不改任何业务逻辑）：
 *   · hidden()      —— 当前是否不可见（document.visibilityState==='hidden'；非浏览器环境视为可见）；
 *   · gate(fn)      —— 包一层：不可见时直接 return（不执行），可见时原样调用；
 *   · interval(fn,ms) —— setInterval(gate(fn), ms)；返回句柄，语义与 setInterval 一致（可 clearInterval）。
 *   · coalesce(fn, windowMs) —— 同 key 在窗口内重复触发只执行一次（后到者复用前次 Promise 结果）。
 *
 * 为可测性：createGate({ hidden }) 可注入 hidden 判定；顶部同时挂 window.AWBGate（浏览器）与
 * module.exports（Node 夹具）。不注入任何轮询、不修改业务状态。
 */
(function initAWBGate(root, factory) {
  const api = factory();
  if (root && typeof root === 'object') root.AWBGate = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null, function factory() {
  function createGate(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const hiddenOf = typeof opts.hidden === 'function'
      ? opts.hidden
      : () => {
        try { return typeof document !== 'undefined' && document.visibilityState === 'hidden'; } catch { return false; }
      };
    const stats = { gatedCalls: 0, skippedHidden: 0, coalesced: 0 };
    function gate(fn) {
      return function gated(...args) {
        stats.gatedCalls += 1;
        if (hiddenOf()) { stats.skippedHidden += 1; return undefined; }
        return fn.apply(this, args);
      };
    }
    function interval(fn, ms) {
      return setInterval(gate(fn), ms);
    }
    function coalesce(fn, windowMs, key = 'default') {
      const ms = Number.isFinite(Number(windowMs)) && Number(windowMs) >= 0 ? Number(windowMs) : 300;
      const boxes = new Map();
      const HIDDEN = Symbol('awb-hidden');
      return function coalesced(...args) {
        const now = Date.now();
        let box = boxes.get(key);
        if (box && box.pending) { stats.coalesced += 1; return box.pending; }
        if (box && box.hasLast && ms > 0 && now - box.at < ms) { stats.coalesced += 1; return box.last; }
        const entry = { at: now, pending: null, hasLast: Boolean(box && box.hasLast), last: box ? box.last : undefined };
        const pending = Promise.resolve()
          .then(() => {
            if (hiddenOf()) { stats.skippedHidden += 1; return HIDDEN; }
            return fn.apply(this, args);
          })
          .then((value) => {
            if (value === HIDDEN) { entry.at = 0; entry.hasLast = false; entry.last = undefined; return undefined; }
            entry.at = Date.now(); entry.hasLast = true; entry.last = value;
            return value;
          })
          .finally(() => { entry.pending = null; });
        entry.pending = pending;
        boxes.set(key, entry);
        return pending;
      };
    }
    return { hidden: hiddenOf, gate, interval, coalesce, stats };
  }
  return Object.assign(createGate(), { createGate });
});
