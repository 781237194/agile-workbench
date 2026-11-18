'use strict';
/**
 * R-b34a（T-20261118-195239-0d3b AC8③）：界面「慢 IPC 可查」锚点 `data-perf-log`。
 *
 * 只读：通过 preload 暴露的 `perf:recent`（最近慢 IPC 记录，来自 性能-YYYYMMDD.jsonl）取数，
 * 把条数与最近一条摘要写进 `[data-perf-log]` 元素（默认 hidden，不占布局）。任何失败都静默降级，
 * 不影响主界面；由 AWBGate 可见性门控（有则用、没有就直接跑），30 秒一次。
 *
 * 可测锚点：
 *   [data-perf-log]                    容器（hidden，含 textContent 摘要）
 *   [data-perf-log-count]              条数
 *   [data-perf-log-last]               最近一条（channel · ms · at）
 */
(function initPerfLogAnchor() {
  if (typeof document === 'undefined') return;
  const container = document.querySelector('[data-perf-log]');
  if (!container) return;
  const api = (window.workbench && typeof window.workbench.perfRecent === 'function')
    ? window.workbench.perfRecent
    : (window.workbench && typeof window.workbench.perf === 'function' ? window.workbench.perf : null);
  if (!api) { container.setAttribute('data-perf-log-state', 'unavailable'); return; }

  const countEl = () => container.querySelector('[data-perf-log-count]');
  const lastEl = () => container.querySelector('[data-perf-log-last]');

  function paint(items) {
    const list = Array.isArray(items) ? items : [];
    container.setAttribute('data-perf-log-state', 'ok');
    container.setAttribute('data-perf-log-total', String(list.length));
    const c = countEl();
    if (c) c.textContent = String(list.length);
    const last = list[0] || null;
    const l = lastEl();
    if (l) {
      l.textContent = last
        ? `${String(last.name || last.channel || '?')} · ${Number(last.ms) || 0}ms · ${String(last.at || last.atMs || '')}`
        : '最近 24 小时没有慢 IPC 记录';
    }
    container.textContent = `慢 IPC ${list.length} 条${last ? `；最近 ${String(last.name || last.channel || '?')} ${Number(last.ms) || 0}ms` : ''}`;
  }

  async function refresh() {
    try {
      const res = await api({ limit: 50 });
      const items = res && Array.isArray(res.items) ? res.items : (Array.isArray(res) ? res : []);
      paint(items);
    } catch (e) {
      container.setAttribute('data-perf-log-state', 'error');
      try { container.title = 'perf:recent 失败：' + String((e && e.message) || e).slice(0, 120); } catch { /* ignore */ }
    }
  }

  const run = () => refresh();
  const gate = window.AWBGate;
  if (gate && typeof gate.interval === 'function') {
    try { gate.interval(run, 30000); } catch { run(); setInterval(run, 30000); }
  } else {
    run();
    setInterval(run, 30000);
  }
})();
