#!/usr/bin/env node
// T-461d 内存回收自适应校验（程序员B）：策略纯函数 + 主进程接线 + 界面文案三层断言。
// 覆盖：阈值=max(1.8GB,基线×2.5)上限3GB、速率>200MB/min、冷却10分钟、回收后60秒防抖、
//       手动不受限、固定阈值环境变量保留、日志字段、界面不再写死 1.2GB。
// 用法：node scripts/test-mem-policy.cjs [--json]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const policy = require('../src/mem-policy');

const ROOT = path.resolve(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');

const checks = [];
const push = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });

// ── 一、策略常量 ─────────────────────────────────────────────
push('下限阈值 1.8GB=1843MB', policy.MIN_THRESHOLD_MB === 1843, policy.MIN_THRESHOLD_MB);
push('上限阈值 3GB=3072MB', policy.MAX_THRESHOLD_MB === 3072, policy.MAX_THRESHOLD_MB);
push('速率门槛 200MB/min', policy.AUTO_RATE_MB_PER_MIN === 200, policy.AUTO_RATE_MB_PER_MIN);
push('自动回收冷却 10 分钟', policy.AUTO_COOLDOWN_MS === 10 * 60 * 1000, policy.AUTO_COOLDOWN_MS);
push('回收后防抖 60 秒', policy.REPEAT_GUARD_MS === 60 * 1000, policy.REPEAT_GUARD_MS);

// ── 二、基线 ─────────────────────────────────────────────────
const now = 20 * 60 * 1000;
const early = [];
for (let i = 0; i < 60; i++) early.push({ at: i * 10000, mb: 600 });
push('启动不满 10 分钟不给基线', policy.baselineMB(early, 9 * 60 * 1000) === null);

const full = [];
for (let i = 0; i < 120; i++) full.push({ at: i * 10000, mb: i < 108 ? 500 : 900 });
push('稳定基线取最后 2 分钟中位数', policy.baselineMB(full, now) === 900, policy.baselineMB(full, now));

// ── 三、自适应阈值 ───────────────────────────────────────────
push('基线 500 → 阈值取下限 1843', policy.adaptiveThresholdMB(500) === 1843, policy.adaptiveThresholdMB(500));
push('基线 1000 → 阈值 2500', policy.adaptiveThresholdMB(1000) === 2500, policy.adaptiveThresholdMB(1000));
push('基线 2000 → 阈值上限 3072', policy.adaptiveThresholdMB(2000) === 3072, policy.adaptiveThresholdMB(2000));
push('无基线 → 阈值 1843', policy.adaptiveThresholdMB(null) === 1843, policy.adaptiveThresholdMB(null));

// ── 四、增长速率 ─────────────────────────────────────────────
const rising = [];
for (let i = 0; i <= 6; i++) rising.push({ at: i * 10000, mb: 1000 + i * 40 });
push('一分钟涨 240MB → 速率 240', policy.growthRateMBPerMin(rising, 60000) === 240, policy.growthRateMBPerMin(rising, 60000));
const flat = [];
for (let i = 0; i <= 6; i++) flat.push({ at: i * 10000, mb: 1000 + i * 10 });
push('一分钟涨 60MB → 速率 60', policy.growthRateMBPerMin(flat, 60000) === 60, policy.growthRateMBPerMin(flat, 60000));
push('样本不足 → 速率 null', policy.growthRateMBPerMin([{ at: 0, mb: 100 }], 1000) === null);

// ── 五、自动回收判定 ─────────────────────────────────────────
const base = { now, lastAutoAt: null, lastRecycleFinishedAt: null };
const below = policy.shouldAutoRecycle({ ...base, mb: 2000, thresholdMB: 2500, rateMBPerMin: 300 });
push('未到阈值不回收', below.auto === false && below.why === 'below-threshold', below.why);
const slow = policy.shouldAutoRecycle({ ...base, mb: 2600, thresholdMB: 2500, rateMBPerMin: 150 });
push('超阈值但涨得慢不回收', slow.auto === false && slow.why === 'rate-not-high', slow.why);
const hot = policy.shouldAutoRecycle({ ...base, mb: 2600, thresholdMB: 2500, rateMBPerMin: 300 });
push('超阈值且涨得快 → 回收', hot.auto === true && hot.cause === '阈值+速率', hot.cause);
const cooling = policy.shouldAutoRecycle({ now, mb: 2600, thresholdMB: 2500, rateMBPerMin: 300, lastAutoAt: now - 5 * 60 * 1000, lastRecycleFinishedAt: null });
push('距上次自动回收不足 10 分钟不回收', cooling.auto === false && cooling.why === 'cooldown', cooling.why);
const guarded = policy.shouldAutoRecycle({ now, mb: 2600, thresholdMB: 2500, rateMBPerMin: 300, lastAutoAt: null, lastRecycleFinishedAt: now - 30 * 1000 });
push('回收完成 30 秒内不重复触发', guarded.auto === false && guarded.why === 'repeat-guard', guarded.why);
const afterGuard = policy.shouldAutoRecycle({ now, mb: 2600, thresholdMB: 2500, rateMBPerMin: 300, lastAutoAt: null, lastRecycleFinishedAt: now - 61 * 1000 });
push('回收完成超过 60 秒可再触发', afterGuard.auto === true, afterGuard.why);

// ── 六、固定阈值（测试环境变量）──────────────────────────────
const fixedHit = policy.shouldAutoRecycle({ now, mb: 450, thresholdMB: 9999, rateMBPerMin: 0, lastAutoAt: null, lastRecycleFinishedAt: null, fixedThresholdMB: 400 });
push('固定阈值模式：只看阈值即触发', fixedHit.auto === true && fixedHit.why === 'fixed-threshold', fixedHit.why);
const fixedMiss = policy.shouldAutoRecycle({ now, mb: 399, thresholdMB: 9999, rateMBPerMin: 0, lastAutoAt: null, lastRecycleFinishedAt: null, fixedThresholdMB: 400 });
push('固定阈值模式：不到阈值不触发', fixedMiss.auto === false, fixedMiss.why);

// ── 七、主进程接线 ───────────────────────────────────────────
push('主进程引用 mem-policy 模块', /const memPolicy = require\('\.\/mem-policy'\)/.test(mainSrc));
push('主进程用 shouldAutoRecycle 判定', /memPolicy\.shouldAutoRecycle\(/.test(mainSrc));
push('主进程用 memThresholdMB() 取阈值', /function memThresholdMB\(\)/.test(mainSrc) && /const thresholdMB = memThresholdMB\(\)/.test(mainSrc));
push('主进程保留 AWB_MEM_RECYCLE_MB 测试阈值', /AWB_MEM_RECYCLE_MB/.test(mainSrc) && /MEM_FIXED_MB/.test(mainSrc));
push('手动回收直接执行（不受阈值/冷却限制）', /ipcMain\.handle\('mem:recycle', async \(\) => recycleRenderer\('Owner\/PM 手动点击「立即回收」', 'manual'/.test(mainSrc));
push('回收日志记 cause/baselineMB/rateMBPerMin', /cause: extraInfo\.cause/.test(mainSrc) && /baselineMB: memState\.baselineMB/.test(mainSrc) && /rateMBPerMin: Number\.isFinite\(extraInfo\.rateMBPerMin\)/.test(mainSrc));
push('回收完成写 lastRecycleFinishedAt（60 秒防抖）', /memState\.lastRecycleFinishedAt = Date\.now\(\)/.test(mainSrc));
push('自动回收后写 lastAutoAt（10 分钟冷却）', /memState\.lastAutoAt = now/.test(mainSrc));
push('mem:stats 带自适应阈值/基线/速率', /thresholdMB, baselineMB: memState\.baselineMB, rateMBPerMin/.test(mainSrc));

// ── 八、界面文案 ─────────────────────────────────────────────
push('界面不再写死 1.2GB 阈值', !/1229/.test(appSrc));
push('内存徽标提示自适应阈值', /基线×2\.5，最低 1\.8GB、上限 3GB/.test(appSrc));
push('index.html 徽标提示自适应', /阈值按启动 10 分钟后的基线自适应/.test(htmlSrc));

const failed = checks.filter((c) => !c.ok);
const report = { file: 'src/mem-policy.js', checks: checks.length, failed: failed.length, failures: failed, ok: failed.length === 0 };
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  for (const c of checks) console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.name + (c.detail ? ' · ' + c.detail : ''));
  console.log(report.ok ? 'MEM_POLICY_OK' : 'MEM_POLICY_FAIL');
}
process.exitCode = report.ok ? 0 : 1;
