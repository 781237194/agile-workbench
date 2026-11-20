'use strict';
/**
 * a514 输入延迟（打字）统计 —— 浏览器全局 + Node 可 require（同一份实现）。
 *
 * 判据（PM 040227）：连续输入 20 字符，`keydown → 下一帧可见` 的 p95 ≤ 50ms；期间不得有 >100ms 的 longtask。
 */
(function (global) {
  function percentile(values, p) {
    const nums = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v)).map(Number).sort((a, b) => a - b);
    if (!nums.length) return null;
    const ratio = Math.min(1, Math.max(0, Number(p) / 100)) || 0;
    const index = Math.min(nums.length - 1, Math.max(0, Math.ceil(ratio * nums.length) - 1));
    return nums[index];
  }

  function summarizeInputLatency(samples) {
    const nums = (Array.isArray(samples) ? samples : []).filter((v) => Number.isFinite(v));
    return {
      count: nums.length,
      p50: percentile(nums, 50),
      p95: percentile(nums, 95),
      max: nums.length ? Math.max(...nums) : null,
      samples: nums.slice(),
    };
  }

  function summarizeLongTasks(durations) {
    const nums = (Array.isArray(durations) ? durations : []).filter((v) => Number.isFinite(v));
    const over100 = nums.filter((v) => v > 100);
    return {
      count: nums.length,
      maxMs: nums.length ? Math.max(...nums) : null,
      totalMs: nums.reduce((acc, v) => acc + v, 0),
      over100: over100.length,
      over100ms: over100.slice(0, 10),
    };
  }

  function typingVerdict(input) {
    const { latencies, longTasks, gateSkipped = null } = input || {};
    const latency = summarizeInputLatency(latencies);
    const longtask = summarizeLongTasks(longTasks);
    const ok = latency.count > 0 && latency.p95 !== null && latency.p95 <= 50 && longtask.over100 === 0;
    return {
      ok,
      latency,
      longtask,
      gateSkipped,
      thresholds: { p95MaxMs: 50, longtaskMaxMs: 100 },
      reason: ok ? '' : (latency.count === 0 ? 'no_samples' : (latency.p95 > 50 ? 'p95_over_50ms' : 'longtask_over_100ms')),
    };
  }

  const api = { percentile, summarizeInputLatency, summarizeLongTasks, typingVerdict };
  try { global.AWBInputLatency = api; } catch { /* ignore */ }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
