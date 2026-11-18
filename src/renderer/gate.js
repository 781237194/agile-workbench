'use strict';
/**
 * R-b34a R4/R6/R5：渲染层「可见性 + 交互态」门、15s 合并调度、骨架屏、列表差量（无依赖、可 Node 直测）。
 *
 * 背景（R4 已交付，本文件在 R5/R6 增量）：
 *   · 不可见/后台不轮询（R4）；交互期（打字/滚动/拖拽）暂停非必要定时器与重绘（R6）；
 *   · 同频刷新合并（15s 调度器），避免多个 tick 同时打 IPC/重绘（R6）；
 *   · 面板打开先渲染骨架（≤200ms 感知），数据到达后填充（R5）；
 *   · 大列表差量：reconcileReplace 复用既有行节点（不整块 innerHTML），保留锚点/选中/滚动（R5）。
 *
 * 设计：纯函数/小对象，不依赖具体业务；顶部挂 window.AWBGate，Node 可 require（createGate 注入 hidden/interacting 便于夹具）。
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
    const stats = { gatedCalls: 0, skippedHidden: 0, skippedInteraction: 0, coalesced: 0, scheduledRuns: 0, skeletonPaints: 0, reconciled: 0 };
    /** 交互态：外部 installInteraction 后自动维护；createGate 可注入 interacting 便于测试。 */
    const interaction = { until: 0, quietMs: 900 };
    const interactingOf = typeof opts.interacting === 'function' ? opts.interacting : () => Date.now() < interaction.until;
    function bumpInteraction(extraMs = 0) {
      interaction.until = Math.max(interaction.until, Date.now() + Math.max(0, Number(interaction.quietMs) || 900) + Number(extraMs || 0));
    }
    function installInteraction(target, opts2) {
      const t = target || (typeof window !== 'undefined' ? window : null);
      if (!t || typeof t.addEventListener !== 'function') return false;
      const o = opts2 && typeof opts2 === 'object' ? opts2 : {};
      if (Number.isFinite(Number(o.quietMs)) && Number(o.quietMs) > 0) interaction.quietMs = Number(o.quietMs);
      if (t.__awbInteractionInstalled) return false;
      const bump = () => bumpInteraction();
      // 打字/滚动/拖拽/触摸都算交互；passive 保证不拖慢输入
      for (const evt of ['keydown', 'wheel', 'pointerdown', 'touchstart', 'scroll']) {
        try { t.addEventListener(evt, bump, { passive: true }); } catch { /* 老环境忽略 */ }
      }
      try { Object.defineProperty(t, '__awbInteractionInstalled', { value: true, enumerable: false }); } catch { t.__awbInteractionInstalled = true; }
      return true;
    }
    /** 门：隐藏或交互期 → 直接 return（不执行），并分别计数。 */
    function gate(fn) {
      return function gated(...args) {
        stats.gatedCalls += 1;
        if (hiddenOf()) { stats.skippedHidden += 1; return undefined; }
        if (interactingOf()) { stats.skippedInteraction += 1; return undefined; }
        return fn.apply(this, args);
      };
    }
    function interval(fn, ms) {
      return setInterval(gate(fn), ms);
    }
    /** 同 key 合并：在途复用同一 Promise；完成后窗口内（默认 0）可选复用结果。 */
    function coalesce(fn, windowMs, key = 'default') {
      const ms = Number.isFinite(Number(windowMs)) && Number(windowMs) >= 0 ? Number(windowMs) : 300;
      const boxes = new Map();
      const HIDDEN = Symbol('awb-hidden');
      return function coalesced(...args) {
        const now = Date.now();
        const box = boxes.get(key);
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
    /**
     * R6：15s 合并调度器——同一 key 在窗口内只执行一次；交互期/隐藏期自动延后（硬上限 windowMs）。
     * 返回可 await 的 Promise（复用同一 Promise，不会重复触发）。
     */
    function schedule(fn, key = 'default', options2 = {}) {
      const o = options2 && typeof options2 === 'object' ? options2 : {};
      const windowMs = Number.isFinite(Number(o.windowMs)) ? Number(o.windowMs) : 15000;
      const boxes = schedule[`__boxes_${key}`] || new Map();
      if (!schedule[`__boxes_${key}`]) schedule[`__boxes_${key}`] = boxes;
      let box = boxes.get(key);
      const now = Date.now();
      if (box && box.pending) return box.pending;
      if (box && box.hasLast && windowMs > 0 && now - box.at < windowMs) return Promise.resolve(box.last);
      const entry = { at: now, pending: null, hasLast: false, last: undefined, timer: null };
      const run = () => {
        entry.timer = null;
        if (hiddenOf() || interactingOf()) {
          // 延后到安静或硬上限
          const wait = Math.max(50, Math.min(1000, windowMs));
          entry.timer = setTimeout(run, wait);
          return;
        }
        stats.scheduledRuns += 1;
        Promise.resolve().then(fn).then((value) => {
          entry.last = value; entry.hasLast = true; entry.at = Date.now();
        }).finally(() => { entry.pending = null; });
      };
      const pending = new Promise((resolve) => {
        const start = () => { if (hiddenOf() || interactingOf()) { entry.timer = setTimeout(start, 250); return; } run(); resolve(); };
        entry.timer = setTimeout(start, Math.min(50, windowMs)); // 下一拍起跑，给同帧其它调用留合并窗口
      });
      entry.pending = pending;
      boxes.set(key, entry);
      return pending;
    }
    /* ---------- R5：骨架屏 ---------- */
    function skeleton(container, options3 = {}) {
      if (!container || typeof container.appendChild !== 'function') return null;
      const o = options3 && typeof options3 === 'object' ? options3 : {};
      const rows = Math.max(1, Math.min(20, Number(o.rows) || 6));
      const doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
      if (!doc) return null;
      clearSkeleton(container);
      const box = doc.createElement('div');
      box.className = 'awb-skeleton';
      box.setAttribute('data-skeleton', '1');
      box.setAttribute('aria-busy', 'true');
      const label = String(o.label || '加载中…');
      const head = doc.createElement('span');
      head.className = 'awb-skeleton-label';
      head.setAttribute('data-skeleton-label', '1');
      head.textContent = label;
      box.appendChild(head);
      for (let i = 0; i < rows; i += 1) {
        const row = doc.createElement('div');
        row.className = 'awb-skeleton-row';
        row.setAttribute('data-skeleton-row', '1');
        box.appendChild(row);
      }
      container.appendChild(box);
      stats.skeletonPaints += 1;
      return box;
    }
    function clearSkeleton(container) {
      if (!container || typeof container.querySelectorAll !== 'function') return 0;
      const nodes = Array.from(container.querySelectorAll('[data-skeleton]'));
      for (const n of nodes) { try { n.remove(); } catch { /* ignore */ } }
      return nodes.length;
    }
    /**
     * R5：列表差量——复用既有行节点（key 相同则不重建），只替换其子节点/属性；容器不清空。
     * build(item) 返回一个新建元素（用于首次或内容替换）；keep 行保留原节点（选中/搜索/滚动不丢）。
     */
    function reconcileReplace(container, items, options4 = {}) {
      if (!container || !Array.isArray(items)) return { kept: 0, created: 0, removed: 0 };
      const o = options4 && typeof options4 === 'object' ? options4 : {};
      const keyOf = typeof o.keyOf === 'function' ? o.keyOf : (it) => String(it && (it.id || it.key) || '');
      const build = typeof o.build === 'function' ? o.build : null;
      if (!build) return { kept: 0, created: 0, removed: 0 };
      const existing = new Map();
      for (const child of Array.from(container.children || [])) {
        const k = child.getAttribute ? child.getAttribute('data-reconcile-key') : '';
        if (k) existing.set(k, child);
      }
      let kept = 0; let created = 0;
      const used = new Set();
      for (const item of items) {
        const key = String(keyOf(item) || '');
        if (!key) continue;
        used.add(key);
        const fresh = build(item);
        if (!fresh) continue;
        const old = existing.get(key);
        if (old) {
          // 保留节点：同步属性 + 子节点（移动而非 innerHTML 重建）
          for (const attr of Array.from(fresh.attributes || [])) {
            try { old.setAttribute(attr.name, attr.value); } catch { /* ignore */ }
          }
          try { old.replaceChildren(...Array.from(fresh.childNodes)); } catch { /* 老环境 */ }
          old.setAttribute('data-reconcile-key', key);
          container.appendChild(old); // 移到当前顺序位置（已有节点，不丢状态）
          kept += 1;
        } else {
          fresh.setAttribute('data-reconcile-key', key);
          container.appendChild(fresh);
          created += 1;
        }
      }
      let removed = 0;
      for (const [k, node] of existing) {
        if (used.has(k)) continue;
        try { node.remove(); removed += 1; } catch { /* ignore */ }
      }
      stats.reconciled += 1;
      return { kept, created, removed };
    }
    return {
      hidden: hiddenOf, interacting: interactingOf, bumpInteraction, installInteraction,
      gate, interval, coalesce, schedule, skeleton, clearSkeleton, reconcileReplace, stats,
      createGate,
    };
  }
  return Object.assign(createGate(), { createGate });
});
