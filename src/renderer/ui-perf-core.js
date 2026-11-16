/* R-c72a F1/F3/F6：交互预算的取数与判定核心（纯函数，零 DOM、零写盘）。
 * 渲染层 __uiPerf 与 scripts/test-ui-perf-core.cjs 共用这一份，避免两套判定漂移。
 * 顶层标识符统一 UIPERF_ / uiPerfCore 前缀（P0 教训：渲染层多脚本共用全局作用域）。 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.uiPerfCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // nearest-rank：升序 sorted，返回 sorted[ceil(q*N)-1]（N<1 时 null）
  function UIPERF_nearestRank(sorted, q) {
    const arr = Array.isArray(sorted) ? sorted.slice().sort((a, b) => a - b) : [];
    if (!arr.length) return null;
    const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil(Number(q) * arr.length) - 1));
    return arr[idx];
  }
  const UIPERF_BUDGETS = Object.freeze({ click: 100, list: 100, modal: 300, scrollFrame: 20 });
  const UIPERF_MIN_SAMPLES = 30;
  // 汇总：返回 {case,samples,p50,p95,p99,verdict}；verdict ∈ OK|BUDGET_EXCEEDED|INSUFFICIENT_SAMPLES
  function UIPERF_summarize(caseName, samples, opts) {
    const name = String(caseName || '');
    const list = Array.isArray(samples) ? samples.map(Number).filter((n) => Number.isFinite(n) && n >= 0) : [];
    const budget = Number((opts && opts.budget) || UIPERF_BUDGETS[name] || 0);
    if (list.length < UIPERF_MIN_SAMPLES) {
      return { case: name, samples: list.length, p50: null, p95: null, p99: null, budget, verdict: 'INSUFFICIENT_SAMPLES' };
    }
    const sorted = list.slice().sort((a, b) => a - b);
    const p50 = UIPERF_nearestRank(sorted, 0.5);
    const p95 = UIPERF_nearestRank(sorted, 0.95);
    const p99 = UIPERF_nearestRank(sorted, 0.99);
    const verdict = budget > 0 && p95 > budget ? 'BUDGET_EXCEEDED' : 'OK';
    return { case: name, samples: sorted.length, p50, p95, p99, budget, verdict };
  }
  return { nearestRank: UIPERF_nearestRank, summarize: UIPERF_summarize, BUDGETS: UIPERF_BUDGETS, MIN_SAMPLES: UIPERF_MIN_SAMPLES };
});
