'use strict';
/**
 * mem-sampler-decide.js —— R-c1ed 采样 forced 判定（可单测的纯函数，M-20261115-171118-f08c77）
 *
 * 背景：`pidGraceSkips / forcedThrottled / forced` 三个计数器此前只有声明没有自增点，
 * 自检表字段恒 0 = 假观测。把「要不要强制真采样」抽成纯函数后，构造场景可直接断言。
 *
 * 口径（PM 裁 M-20261115-161228-23177f 硬要求②）：
 *   · 启动后 30s 内的 pid 变化不算真实变化（只记 pidGraceSkips）；
 *   · 30s 后真实变化必须立即真采样（forced）；
 *   · 两次 forced 之间至少 5s，只用于挡抖动（被挡的记 forcedThrottled）。
 *
 * 返回 { forced: boolean, reason: 'none'|'pid_grace'|'forced_throttled'|'forced' }
 */
const PID_GRACE_MS = 30000;
const FORCED_MIN_INTERVAL_MS = 5000;

function decideForceSample(input) {
  const opts = input && typeof input === 'object' ? input : {};
  const nowMs = Number(opts.nowMs) || 0;
  const bootAtMs = Number(opts.bootAtMs) || 0;
  const lastForcedAtMs = Number(opts.lastForcedAtMs) || 0;
  const changed = opts.changed === true;
  if (!changed) return { forced: false, reason: 'none' };
  if (nowMs - bootAtMs < PID_GRACE_MS) return { forced: false, reason: 'pid_grace' };
  if (nowMs - lastForcedAtMs < FORCED_MIN_INTERVAL_MS) return { forced: false, reason: 'forced_throttled' };
  return { forced: true, reason: 'forced' };
}

module.exports = { decideForceSample, PID_GRACE_MS, FORCED_MIN_INTERVAL_MS };
