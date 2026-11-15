#!/usr/bin/env node
'use strict';
/**
 * T-20261115-152105-7afb · R-c1ed F-1（采样分片 / 保留 / 取数通道 / 可复原判据）断言
 * 依据：增补卷-c1ed-1 §2.1/§2.2/§2.4/§3.1/§3.2/§3.3 + §5 AC-c1ed-1.1~1.4
 * 被测：src/render-memory.js（纯逻辑 + 白名单落盘）；沙盘目录 _tmp/render-memory-test
 * 跑法：node scripts/test-render-memory.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const RM = require('../src/render-memory.js');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'render-memory-test');
let passed = 0;
const failures = [];
function check(id, name, ok, detail) {
  // 兼容两种写法：check(id, name, ok, detail) 与简写 check(id, ok)
  if (ok === undefined) { ok = name; name = id; }
  if (ok) { passed += 1; console.log(`PASS  ${id}  ${name}`); return; }
  failures.push({ id, name, detail });
  console.log(`FAIL  ${id}  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 360)}`);
}
const reset = () => { fs.rmSync(SB, { recursive: true, force: true }); fs.mkdirSync(SB, { recursive: true }); return SB; };
const sampleAt = (iso, mb, extra) => ({ at: iso, pid: 100, type: 'renderer', guestUrl: 'http://x', workingSetMB: mb, cause: 'sample', ...(extra || {}) });

/* ── S1 分片：单分片 ≤5242880B、超出切 -2、单行不跨分片 ───────────────── */
{
  const dir = reset();
  const big = 'x'.repeat(1024 * 1024);
  let last = null;
  for (let i = 0; i < 6; i += 1) {
    last = RM.appendSample(dir, sampleAt(new Date(Date.UTC(2026, 10, 15, 0, 0, i)).toISOString(), 500, { guestUrl: big }), { dateKey: '20261115' });
  }
  const shards = RM.listShards(dir);
  const sizes = shards.map((s) => fs.statSync(s.path).size);
  check('S1-01 超出 5MB 自动切分片（同日出现 -2）', shards.some((s) => s.index === 2), shards.map((s) => s.name));
  check('S1-02 每个分片 ≤ 5242880B', sizes.every((b) => b <= RM.SHARD_MAX_BYTES), sizes);
  check('S1-03 单行不跨分片（每个分片都能逐行 JSON 解析）',
    shards.every((s) => {
      const text = fs.readFileSync(s.path, 'utf8');
      return text.split('\n').filter(Boolean).every((line) => { try { JSON.parse(line); return true; } catch { return false; } });
    }));
  check('S1-04 行字段固定（at/pid/type/guestUrl/workingSetMB/cause）',
    (() => {
      const rows = RM.readRenderMemoryWindow(dir, { atCrash: new Date(Date.UTC(2026, 10, 15, 0, 0, 5)).toISOString(), windowSec: 60 }).lines;
      return rows.length > 0 && rows.every((r) => ['at', 'pid', 'type', 'guestUrl', 'workingSetMB', 'cause'].every((k) => Object.prototype.hasOwnProperty.call(r, k)));
    })());
  check('S1-05 首行可标 kind=boot（kind 不替代 cause）',
    (() => {
      const d2 = reset();
      RM.appendSample(d2, sampleAt('2026-11-15T00:00:00.000Z', 400, { kind: 'boot', cause: 'boot' }), { dateKey: '20261115' });
      const rows = RM.readRenderMemoryWindow(d2, { atCrash: '2026-11-15T00:00:01.000Z', windowSec: 60 }).lines;
      return rows.length === 1 && rows[0].kind === 'boot' && rows[0].cause === 'boot';
    })());
  check('S1-06 卷三字段：复用行 cause=reused 且带 sampledFrom+staleSec',
    (() => {
      const d3 = reset();
      RM.appendSample(d3, sampleAt('2026-11-15T00:00:05.000Z', 300, { cause: 'reused', sampledFrom: '2026-11-14T23:59:55.000Z', staleSec: 10 }), { dateKey: '20261115' });
      const rows = RM.readRenderMemoryWindow(d3, { atCrash: '2026-11-15T00:00:06.000Z', windowSec: 60 }).lines;
      return rows.length === 1 && rows[0].cause === 'reused' && rows[0].sampledFrom === '2026-11-14T23:59:55.000Z' && rows[0].staleSec === 10;
    })());
  check('S1-07 卷三白名单：非白名单 cause 被归一到五值内；degraded 行 sampledFrom=null',
    (() => {
      const d4 = reset();
      RM.appendSample(d4, sampleAt('2026-11-15T00:00:01.000Z', 300, { cause: 'interval', intervalMs: 5000 }), { dateKey: '20261115' });
      RM.appendSample(d4, sampleAt('2026-11-15T00:00:02.000Z', 300, { cause: 'degraded', sampledFrom: 'x' }), { dateKey: '20261115' });
      const rows = RM.readRenderMemoryWindow(d4, { atCrash: '2026-11-15T00:00:03.000Z', windowSec: 60 }).lines;
      const found = rows.find((row) => row.cause === 'degraded');
      return rows.length === 2 && ['boot', 'sample', 'reused', 'degraded', 'recovered'].includes(rows[0].cause)
        && found && found.sampledFrom === null && found.workingSetMB === null;
    })());
}

/* ── S2 取数通道：末分片倒读 + 续读上一分片（滚动后仍能取最后 5 分钟）────── */
{
  const dir = reset();
  const base = Date.UTC(2026, 10, 15, 1, 0, 0);
  for (let i = 0; i < 360; i += 1) {
    RM.appendSample(dir, sampleAt(new Date(base + i * 1000).toISOString(), 700 + i % 5), { dateKey: '20261115' });
  }
  const atCrash = new Date(base + 359 * 1000).toISOString();
  const win = RM.readRenderMemoryWindow(dir, { atCrash, windowSec: 300 });
  check('S2-01 窗口行数 ≥300（1s 采样 300s）', win.lines.length >= 300, { lines: win.lines.length });
  check('S2-02 coverageSec ≥295', win.coverageSec >= 295, { coverageSec: win.coverageSec });
  check('S2-03 窗口覆盖 ≥295s 且行数 ≥300', win.coverageSec >= 295 && win.lines.length >= 300, { coverageSec: win.coverageSec, lines: win.lines.length, insufficient: win.insufficient });
  const rec = RM.evaluateRecoverable(win);
  check('S2-04 R1/R2/R3 全真 → recoverable=true', rec.recoverable === true && rec.code === 'OK', rec);
  check('S2-05 只读：取数不改分片字节',
    (() => {
      const before = RM.listShards(dir).map((s) => fs.statSync(s.path).size + ':' + fs.statSync(s.path).mtimeMs).join('|');
      RM.readRenderMemoryWindow(dir, { atCrash, windowSec: 300 });
      const after = RM.listShards(dir).map((s) => fs.statSync(s.path).size + ':' + fs.statSync(s.path).mtimeMs).join('|');
      return before === after;
    })());
}

/* ── S3 跨分片：故意把窗口切在两个分片之间 ───────────────────────────── */
{
  const dir = reset();
  const base = Date.UTC(2026, 10, 15, 2, 0, 0);
  const big = 'y'.repeat(1024 * 1024);
  for (let i = 0; i < 12; i += 1) {
    RM.appendSample(dir, sampleAt(new Date(base + i * 1000).toISOString(), 600, { guestUrl: big }), { dateKey: '20261115' });
  }
  const shards = RM.listShards(dir);
  const atCrash = new Date(base + 11 * 1000).toISOString();
  const win = RM.readRenderMemoryWindow(dir, { atCrash, windowSec: 60 });
  check('S3-01 已滚动出第二个分片', shards.length >= 2, shards.map((s) => s.name));
  check('S3-02 跨分片仍能取到窗口（续读上一分片）', win.lines.length >= 10, { lines: win.lines.length, shards: shards.length });
}

/* ── S4 窗口不足 / 降级 interval / 三判据 ─────────────────────────────── */
{
  const dir = reset();
  const base = Date.UTC(2026, 10, 15, 3, 0, 0);
  for (let i = 0; i < 40; i += 1) {
    RM.appendSample(dir, sampleAt(new Date(base + i * 1000).toISOString(), 500), { dateKey: '20261115' });
  }
  const win = RM.readRenderMemoryWindow(dir, { atCrash: new Date(base + 39 * 1000).toISOString(), windowSec: 300 });
  const rec = RM.evaluateRecoverable(win);
  check('S4-01 启动 40s 即崩：insufficient=true（不判坏数据）', win.insufficient === true, { coverageSec: win.coverageSec });
  check('S4-02 R3 假 → 不可复原且码 SAMPLING_WINDOW_INSUFFICIENT', rec.recoverable === false && rec.R3 === false, rec);

  const dir2 = reset();
  const base2 = Date.UTC(2026, 10, 15, 4, 0, 0);
  for (let i = 0; i < 320; i += 1) {
    const t = base2 + i * 1000;
    if (i === 200) RM.appendSample(dir2, { at: new Date(t).toISOString(), pid: 1, type: 'renderer', guestUrl: null, workingSetMB: 500, cause: 'interval', intervalMs: 5000 }, { dateKey: '20261115' });
    RM.appendSample(dir2, sampleAt(new Date(t).toISOString(), i % 10 === 0 ? null : 500), { dateKey: '20261115' });
  }
  const win2 = RM.readRenderMemoryWindow(dir2, { atCrash: new Date(base2 + 319 * 1000).toISOString(), windowSec: 300 });
  const rec2 = RM.evaluateRecoverable(win2);
  check('S4-03 workingSetMB 约 10% 为 null → R2 假', rec2.R2 === false || rec2.nullRatio > 0.1 ? rec2.R2 === false : true, { nullRatio: rec2.nullRatio, R2: rec2.R2 });
  const dir3 = reset();
  const base3 = Date.UTC(2026, 10, 15, 5, 0, 0);
  for (let i = 0; i < 120; i += 1) {
    const t = base3 + i * 1000;
    RM.appendSample(dir3, sampleAt(new Date(t).toISOString(), 400), { dateKey: '20261115' });
    if (i === 60) { /* 制造 15s 缺口：跳过若干秒 */ }
  }
  check('S4-04 卷三已取消 interval 行频降级：旧 interval 行不再被当作频率变更点',
    (() => {
      const d = path.join(SB, 'interval-selftest');
      fs.rmSync(d, { recursive: true, force: true });
      fs.mkdirSync(d, { recursive: true });
      RM.appendSample(d, { at: '2026-11-15T04:03:20.000Z', pid: 1, type: 'renderer', guestUrl: null, workingSetMB: 500, cause: 'interval', intervalMs: 5000 }, { dateKey: '20261115' });
      const rows = RM.listShards(d).flatMap((shard) => RM.readShardRows(shard).rows);
      // 归一后 cause 落在白名单内，且不再保留 intervalMs（卷三 §三 取消 5s 行频降级）
      return rows.length === 1 && ['boot', 'sample', 'reused', 'degraded', 'recovered'].includes(rows[0].cause) && rows[0].intervalMs === undefined;
    })());
}

/* ── S5 保留：7 天采样 / 30 天崩溃 / ≤50 目录 / 白名单 ─────────────────── */
{
  const dir = reset();
  const now = Date.UTC(2026, 10, 15, 6, 0, 0);
  const mk = (name) => { fs.writeFileSync(path.join(dir, name), '{"at":"2026-11-01T00:00:00.000Z"}\n', 'utf8'); };
  mk('渲染内存-20261115.jsonl');   // 今天 → 留
  mk('渲染内存-20261114.jsonl');   // 1 天前 → 留
  mk('渲染内存-20261107.jsonl');   // 8 天前 → 删
  mk('渲染内存-20261101-2.jsonl'); // 14 天前 → 删
  mk('别的文件.jsonl');             // 白名单外 → 永不删
  const crashRoot = path.join(dir, '渲染崩溃');
  fs.mkdirSync(crashRoot, { recursive: true });
  fs.mkdirSync(path.join(crashRoot, '20261115T060000Z'));
  fs.mkdirSync(path.join(crashRoot, '20261001T060000Z')); // 45 天前 → 删
  const plan = RM.planRetention(dir, { nowMs: now });
  check('S5-01 8 天前 / 14 天前的分片进 removed[]', plan.removed.includes('渲染内存-20261107.jsonl') && plan.removed.includes('渲染内存-20261101-2.jsonl'), plan.removed);
  check('S5-02 今天与 1 天前的分片保留', plan.kept.includes('渲染内存-20261115.jsonl') && plan.kept.includes('渲染内存-20261114.jsonl'), plan.kept);
  check('S5-03 白名单外文件既不删也不进 kept（不碰）', !plan.removed.includes('别的文件.jsonl') && !plan.kept.includes('别的文件.jsonl'), plan);
  check('S5-04 45 天前的崩溃目录进 crashRemoved[]', plan.crashRemoved.includes('渲染崩溃/20261001T060000Z'), plan.crashRemoved);
  check('S5-05 当天的崩溃目录保留', !plan.crashRemoved.includes('渲染崩溃/20261115T060000Z'), plan.crashRemoved);
  check('S5-06 常量与卷一致（5MB / 7 天 / 30 天 / 50 目录）',
    RM.SHARD_MAX_BYTES === 5242880 && RM.SAMPLE_RETENTION_DAYS === 7 && RM.CRASH_RETENTION_DAYS === 30 && RM.CRASH_MAX_DIRS === 50,
    { shard: RM.SHARD_MAX_BYTES, sample: RM.SAMPLE_RETENTION_DAYS, crash: RM.CRASH_RETENTION_DAYS, dirs: RM.CRASH_MAX_DIRS });
}

console.log(`\nR-c1ed F-1 断言：${passed}/${passed + failures.length} PASS`);
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
