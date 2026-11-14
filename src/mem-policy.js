'use strict';

// 内存回收策略（2026-11-13 T-461d）：把“什么时候该自动回收”抽成纯函数，主进程只负责采样与执行。
// 目标：大项目内存自然更大，固定 1229MB 阈值会频繁重载；改成「按启动基线自适应 + 增长速率 + 冷却」。
// 约束（PM 派单正文）：①阈值=max(1.8GB, 基线×2.5)，硬上限 3GB；②速率>200MB/min 且距上次回收>10 分钟；
// ③手动不受限；④回收后 60 秒不重复；⑤日志记原因与 before/after；⑥AWB_MEM_RECYCLE_MB 保留用于测试。

const MB = 1024;
const MIN_THRESHOLD_MB = Math.round(1.8 * MB); // 1843MB
const MAX_THRESHOLD_MB = 3 * MB;               // 3072MB
const BASELINE_WARMUP_MS = 10 * 60 * 1000;     // 启动后先观察 10 分钟
const BASELINE_WINDOW_MS = 2 * 60 * 1000;      // 取最后 2 分钟样本的中位数当基线
const RATE_WINDOW_MS = 60 * 1000;              // 增长速率按最近 1 分钟算
const AUTO_RATE_MB_PER_MIN = 200;              // 每分钟涨 200MB 才算“在涨”
const AUTO_COOLDOWN_MS = 10 * 60 * 1000;       // 两次自动回收间至少 10 分钟
const REPEAT_GUARD_MS = 60 * 1000;             // 任何一次回收完成后 60 秒内不再自动触发
const SAMPLE_KEEP_MS = 15 * 60 * 1000;         // 主进程只留最近 15 分钟样本

function median(values) {
  const list = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!list.length) return null;
  return list[Math.floor(list.length / 2)];
}

/**
 * 稳定基线：启动满 10 分钟后，取最后 2 分钟采样样本的中位数。
 * 不满 10 分钟返回 null（此时阈值走下限 1.8GB，避免启动波动误触发）。
 */
function baselineMB(samples, now) {
  if (!Array.isArray(samples) || !samples.length) return null;
  const first = Number(samples[0] && samples[0].at);
  if (!Number.isFinite(first) || now - first < BASELINE_WARMUP_MS) return null;
  const window = samples.filter((s) => s && now - Number(s.at) <= BASELINE_WINDOW_MS);
  const pick = window.length ? window : samples.slice(-24);
  return median(pick.map((s) => Number(s && s.mb)));
}

/** 阈值 = max(1.8GB, 基线×2.5)，硬上限 3GB；基线无效时取下限。 */
function adaptiveThresholdMB(baseline) {
  if (!Number.isFinite(baseline) || baseline <= 0) return MIN_THRESHOLD_MB;
  return Math.min(MAX_THRESHOLD_MB, Math.max(MIN_THRESHOLD_MB, Math.round(baseline * 2.5)));
}

/** 最近 1 分钟的线性增长速率（MB/分钟）；样本不足 1 秒返回 null。 */
function growthRateMBPerMin(samples, now) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const recent = samples
    .filter((s) => Number.isFinite(Number(s && s.mb)) && now - Number(s.at) <= RATE_WINDOW_MS)
    .sort((a, b) => Number(a.at) - Number(b.at));
  if (recent.length < 2) return null;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const span = Number(last.at) - Number(first.at);
  if (!Number.isFinite(span) || span < 1000) return null;
  return Math.round(((Number(last.mb) - Number(first.mb)) / span) * 60000);
}

/**
 * 自动回收判定。
 * - fixedThresholdMB>0（AWB_MEM_RECYCLE_MB）：测试模式，只看固定阈值，便于复现自动回收。
 * - 自适应模式：必须同时满足 超过阈值 + 速率>200MB/min + 距上次自动回收>10分钟 + 距上次回收完成>60秒。
 * 手动回收不经过这里（界面「立即回收」直接执行，不受阈值/冷却限制）。
 */
function shouldAutoRecycle(input) {
  const it = input || {};
  const mb = Number(it.mb);
  const now = Number(it.now);
  if (!Number.isFinite(mb) || mb <= 0) return { auto: false, why: 'no-sample' };
  if (Number.isFinite(it.lastRecycleFinishedAt) && Number.isFinite(now) && now - it.lastRecycleFinishedAt < REPEAT_GUARD_MS) {
    return { auto: false, why: 'repeat-guard' };
  }
  const fixed = Number(it.fixedThresholdMB);
  if (Number.isFinite(fixed) && fixed > 0) {
    if (mb >= fixed) return { auto: true, why: 'fixed-threshold', cause: '阈值' };
    return { auto: false, why: 'below-fixed-threshold' };
  }
  const threshold = Number(it.thresholdMB);
  if (!Number.isFinite(threshold) || mb < threshold) return { auto: false, why: 'below-threshold' };
  const rate = Number(it.rateMBPerMin);
  if (!Number.isFinite(rate) || rate <= AUTO_RATE_MB_PER_MIN) return { auto: false, why: 'rate-not-high', cause: '速率' };
  if (Number.isFinite(it.lastAutoAt) && Number.isFinite(now) && now - it.lastAutoAt < AUTO_COOLDOWN_MS) {
    return { auto: false, why: 'cooldown', cause: '冷却' };
  }
  return { auto: true, why: 'threshold+rate', cause: '阈值+速率' };
}

module.exports = {
  MB,
  MIN_THRESHOLD_MB,
  MAX_THRESHOLD_MB,
  BASELINE_WARMUP_MS,
  BASELINE_WINDOW_MS,
  RATE_WINDOW_MS,
  AUTO_RATE_MB_PER_MIN,
  AUTO_COOLDOWN_MS,
  REPEAT_GUARD_MS,
  SAMPLE_KEEP_MS,
  median,
  baselineMB,
  adaptiveThresholdMB,
  growthRateMBPerMin,
  shouldAutoRecycle,
};
