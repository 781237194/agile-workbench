#!/usr/bin/env node
'use strict';
/**
 * test-mem-sampler-decide.cjs —— R-c1ed 长跑前必修断言（M-20261115-171118-f08c77）
 *
 * 复核意见：`forced / pidGraceSkips / forcedThrottled` 三个计数器此前只有声明、**没有自增点**，
 * 自检表字段恒 0 = 假观测。本脚本用纯函数 `decideForceSample()` 构造三种场景，断言
 * ①三个计数在构造场景下**会变**（不是恒 0）；②判定口径符合 PM 硬要求②
 * （30s 宽限 / 30s 后立即真采样 / 两次 forced 至少隔 5s）。
 *
 * 用法：node scripts/test-mem-sampler-decide.cjs
 * 退出码：0 全过 / 1 有断言失败
 */
const path = require('node:path');

const MOD = path.join(__dirname, '..', 'src', 'mem-sampler-decide.js');
const { decideForceSample, PID_GRACE_MS, FORCED_MIN_INTERVAL_MS } = require(MOD);

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail)}`);
}

check('常量口径：30s 宽限 / 5s 限流', PID_GRACE_MS === 30000 && FORCED_MIN_INTERVAL_MS === 5000, { PID_GRACE_MS, FORCED_MIN_INTERVAL_MS });

// 场景一：启动 10s 内 pid 变化 → 只记 pidGraceSkips，不 forced
const boot = 1_000_000;
const grace = decideForceSample({ nowMs: boot + 10_000, bootAtMs: boot, lastForcedAtMs: 0, changed: true });
check('S1 启动 10s 内 pid 变化 → reason=pid_grace（计入 pidGraceSkips）', grace.forced === false && grace.reason === 'pid_grace', grace);

// 场景二：启动 60s 后第一次变化 → forced
const first = decideForceSample({ nowMs: boot + 60_000, bootAtMs: boot, lastForcedAtMs: 0, changed: true });
check('S2 启动 60s 后首次变化 → forced', first.forced === true && first.reason === 'forced', first);

// 场景三：forced 后 2s 再次变化 → 被 5s 限流挡下（计入 forcedThrottled）
const throttled = decideForceSample({ nowMs: boot + 62_000, bootAtMs: boot, lastForcedAtMs: boot + 60_000, changed: true });
check('S3 forced 后 2s 再变化 → reason=forced_throttled（计入 forcedThrottled）', throttled.forced === false && throttled.reason === 'forced_throttled', throttled);

// 场景四：forced 后 6s 再变化 → 允许（限流只挡抖动，不挡真实变化）
const again = decideForceSample({ nowMs: boot + 66_000, bootAtMs: boot, lastForcedAtMs: boot + 60_000, changed: true });
check('S4 forced 后 6s 再变化 → 仍 forced（真实变化不被吃）', again.forced === true && again.reason === 'forced', again);

// 场景五：无变化 → 永远不 forced
const none = decideForceSample({ nowMs: boot + 120_000, bootAtMs: boot, lastForcedAtMs: 0, changed: false });
check('S5 无变化 → reason=none（不污染任何计数器）', none.forced === false && none.reason === 'none', none);

// 场景六：完整模拟 120s 的 tick 序列，断言三个计数器都会增长（这就是「构造场景下会变」）
const counters = { forced: 0, pidGraceSkips: 0, forcedThrottled: 0 };
let lastForcedAtMs = 0;
const timeline = [
  { t: 5_000, changed: true },   // 宽限内
  { t: 20_000, changed: true },  // 宽限内
  { t: 40_000, changed: true },  // 首次 forced
  { t: 42_000, changed: true },  // 限流
  { t: 50_000, changed: true },  // forced（间隔 10s）
  { t: 51_000, changed: true },  // 限流
  { t: 52_000, changed: false }, // 无变化
];
for (const step of timeline) {
  const d = decideForceSample({ nowMs: boot + step.t, bootAtMs: boot, lastForcedAtMs, changed: step.changed });
  if (d.reason === 'pid_grace') counters.pidGraceSkips += 1;
  if (d.reason === 'forced_throttled') counters.forcedThrottled += 1;
  if (d.forced) { counters.forced += 1; lastForcedAtMs = boot + step.t; }
}
check('S6 模拟 Tick 序列：三计数器均 >0 且合计=有变化的 6 拍',
  counters.forced === 2 && counters.pidGraceSkips === 2 && counters.forcedThrottled === 2,
  counters);

console.log(`\nmem-sampler-decide 断言：${passed}/${passed + failures.length} PASS`);
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
process.exit(0);
