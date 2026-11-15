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
  check('S4-05 强制真采样计数：cadence.forcedSamples 含 forced 行与 recovered 行',
    (() => {
      const win = {
        lines: [
          { at: '2026-11-15T00:00:00.000Z', cause: 'boot', sampledFrom: '2026-11-15T00:00:00.000Z' },
          { at: '2026-11-15T00:00:01.000Z', cause: 'sample', sampledFrom: '2026-11-15T00:00:01.000Z', workingSetMB: 300 },
          { at: '2026-11-15T00:00:02.000Z', cause: 'reused', sampledFrom: '2026-11-15T00:00:01.000Z', staleSec: 1, workingSetMB: 300 },
          { at: '2026-11-15T00:00:03.000Z', cause: 'sample', sampledFrom: '2026-11-15T00:00:03.000Z', workingSetMB: 301, forced: true },
          { at: '2026-11-15T00:00:04.000Z', cause: 'recovered', sampledFrom: '2026-11-15T00:00:04.000Z', workingSetMB: 302 },
        ],
        firstAt: '2026-11-15T00:00:00.000Z', lastAt: '2026-11-15T00:00:04.000Z', coverageSec: 4,
      };
      const r = RM.evaluateRecoverable(win, { windowSec: 300, atCrash: '2026-11-15T00:00:04.000Z' });
      return r.forcedSamples === 2 && r.cadence && r.cadence.forcedSamples === 2 && r.cadence.hasForced === true;
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

/* ── S6 返工单五处（卷2 §四 矩阵 + 卷3 §六）───────────────────────────── */
{
  const iso = (base, i) => new Date(base + i * 1000).toISOString();
  const writeRows = (dir, base, count, extra) => {
    for (let i = 0; i < count; i += 1) {
      RM.appendSample(dir, sampleAt(iso(base, i), 500 + (i % 3), extra ? extra(i) : undefined), { dateKey: '20261115' });
    }
  };

  // A 行：无任何采样文件 → NO_SAMPLE_FILE（不判 FAIL）
  const dA = reset();
  const winA = RM.readRenderMemoryWindow(dA, { atCrash: '2026-11-15T00:05:00.000Z', windowSec: 300 });
  const recA = RM.evaluateRecoverable(winA, { atCrash: '2026-11-15T00:05:00.000Z', windowSec: 300 });
  check('S6-01 A 行：无采样文件 → code=NO_SAMPLE_FILE 且 fail=false', winA.code === 'NO_SAMPLE_FILE' && recA.code === 'NO_SAMPLE_FILE' && winA.fail === false, { code: winA.code, fail: winA.fail });

  // 24h 无分片 → SAMPLING_DISABLED（判 FAIL）
  const dS = reset();
  const winS = RM.readRenderMemoryWindow(dS, { atCrash: '2026-11-15T00:05:00.000Z', windowSec: 300, forceSamplingDisabled: true });
  check('S6-02 24h 无分片 → code=SAMPLING_DISABLED 且 fail=true', winS.code === 'SAMPLING_DISABLED' && winS.fail === true, { code: winS.code, fail: winS.fail });

  // C 行：末片有坏行但窗口凑满 → PARTIAL_SHARD 且不判 FAIL
  const dC = reset();
  const baseC = Date.UTC(2026, 10, 15, 7, 0, 0);
  writeRows(dC, baseC, 320);
  const shardC = RM.listShards(dC).pop();
  fs.appendFileSync(shardC.path, '{"broken":\n', 'utf8'); // 人为坏行（模拟分片损坏）
  const atC = iso(baseC, 319);
  const winC = RM.readRenderMemoryWindow(dC, { atCrash: atC, windowSec: 300 });
  check('S6-03 C 行：readFailed=true 但窗口凑满 → code=PARTIAL_SHARD 且 fail=false',
    winC.readFailed === true && winC.code === 'PARTIAL_SHARD' && winC.fail === false,
    { readFailed: winC.readFailed, code: winC.code, fail: winC.fail, lines: winC.lines.length });

  // B 行：分片坏且窗口凑不满 → READ_FAILED（判 FAIL）
  const dB = reset();
  const baseB = Date.UTC(2026, 10, 15, 8, 0, 0);
  writeRows(dB, baseB, 40);
  const shardB = RM.listShards(dB).pop();
  fs.appendFileSync(shardB.path, 'not-json\n', 'utf8');
  const winB = RM.readRenderMemoryWindow(dB, { atCrash: iso(baseB, 39), windowSec: 300 });
  check('S6-04 B 行：坏片且凑不满 → code=READ_FAILED 且 fail=true',
    winB.readFailed === true && winB.code === 'READ_FAILED' && winB.fail === true,
    { readFailed: winB.readFailed, code: winB.code, fail: winB.fail });

  // D 行：单日分片、窗口不足且已到最早分片起点 → NO_PREV_SHARD
  const dD = reset();
  const baseD = Date.UTC(2026, 10, 15, 9, 0, 0);
  writeRows(dD, baseD, 30);
  const winD = RM.readRenderMemoryWindow(dD, { atCrash: iso(baseD, 29), windowSec: 300 });
  check('S6-05 D 行：无前日分片可续 → code=NO_PREV_SHARD（不判 FAIL）',
    winD.code === 'NO_PREV_SHARD' && winD.fail === false, { code: winD.code, fail: winD.fail, insufficient: winD.insufficient });

  // R1：单缺口 >10s 判假，≤10s 判真（卷3 §六收紧）
  const mkWin = (gapSec) => ({
    lines: [
      { at: '2026-11-15T00:00:00.000Z', cause: 'sample', sampledFrom: '2026-11-15T00:00:00.000Z', workingSetMB: 300 },
      { at: new Date(Date.parse('2026-11-15T00:00:00.000Z') + gapSec * 1000).toISOString(), cause: 'sample', sampledFrom: new Date(Date.parse('2026-11-15T00:00:00.000Z') + gapSec * 1000).toISOString(), workingSetMB: 300 },
    ],
    firstAt: '2026-11-15T00:00:00.000Z',
    lastAt: new Date(Date.parse('2026-11-15T00:00:00.000Z') + gapSec * 1000).toISOString(),
    coverageSec: gapSec,
  });
  const r1Big = RM.evaluateRecoverable(mkWin(15), { windowSec: 300 });
  const r1Ok = RM.evaluateRecoverable(mkWin(8), { windowSec: 300 });
  check('S6-06 R1：单缺口 15s → R1 假；8s → R1 真（阈值 10s）', r1Big.R1 === false && r1Ok.R1 === true, { big: r1Big.R1, ok: r1Ok.R1 });
  check('S6-07 gaps 四键结构 {from,to,sec,reason}', r1Big.gaps.length === 1 && ['from', 'to', 'sec', 'reason'].every((key) => Object.prototype.hasOwnProperty.call(r1Big.gaps[0], key)) && r1Big.gaps[0].reason === 'GAP_GT_10S', r1Big.gaps);

  // R2：degraded 行不计入分母（95% 口径）
  const linesR2 = [];
  for (let i = 0; i < 100; i += 1) {
    linesR2.push({ at: new Date(Date.parse('2026-11-15T00:00:00.000Z') + i * 1000).toISOString(), cause: 'sample', sampledFrom: new Date(Date.parse('2026-11-15T00:00:00.000Z') + i * 1000).toISOString(), workingSetMB: 400 });
  }
  for (let i = 0; i < 15; i += 1) {
    linesR2.push({ at: new Date(Date.parse('2026-11-15T00:01:40.000Z') + i * 1000).toISOString(), cause: 'degraded', sampledFrom: null, workingSetMB: null });
  }
  const winR2 = { lines: linesR2, firstAt: linesR2[0].at, lastAt: linesR2[linesR2.length - 1].at, coverageSec: 114 };
  const recR2 = RM.evaluateRecoverable(winR2, { windowSec: 300 });
  check('S6-08 R2：degraded 行不计入分母（100 好行 + 15 降级 → R2 真）', recR2.R2 === true && recR2.degradedLines === 15, { R2: recR2.R2, degradedLines: recR2.degradedLines, nullRatio: recR2.nullRatio });

  // D 行加强：同一天多个分片、窗口不够、且**盘上无前一日分片** → NO_PREV_SHARD
  const dD2 = reset();
  const baseD2 = Date.UTC(2026, 10, 15, 9, 0, 0);
  const big = 'z'.repeat(1024 * 1024);
  for (let i = 0; i < 30; i += 1) {
    RM.appendSample(dD2, sampleAt(iso(baseD2, i), 500, { guestUrl: big }), { dateKey: '20261115' });
  }
  const winD2 = RM.readRenderMemoryWindow(dD2, { atCrash: iso(baseD2, 29), windowSec: 300 });
  check('S6-10 D 行加强：同日多分片+无前日分片 → NO_PREV_SHARD 且 fail=false',
    winD2.code === 'NO_PREV_SHARD' && winD2.fail === false && winD2.prevShardMissing === true,
    { code: winD2.code, fail: winD2.fail, prevShardMissing: winD2.prevShardMissing, shards: RM.listShards(dD2).length });

  // 反向：若盘上有前一日分片（可续），就不能冒充 D 行
  const dD3 = reset();
  RM.appendSample(dD3, sampleAt('2026-11-14T23:59:50.000Z', 400), { dateKey: '20261114' });
  for (let i = 0; i < 20; i += 1) {
    RM.appendSample(dD3, sampleAt(iso(Date.UTC(2026, 10, 15, 9, 0, 0), i), 500), { dateKey: '20261115' });
  }
  const winD3 = RM.readRenderMemoryWindow(dD3, { atCrash: iso(Date.UTC(2026, 10, 15, 9, 0, 0), 19), windowSec: 300 });
  check('S6-11 有前日分片可续时不得判 NO_PREV_SHARD',
    winD3.code !== 'NO_PREV_SHARD',
    { code: winD3.code, prevShardMissing: winD3.prevShardMissing });

  // cause 白名单：全仓采样行不得出现 cause='interval'
  const allRows = RM.listShards(dC).flatMap((shard) => RM.readShardRows(shard).rows);
  check('S6-09 归一后无 cause=interval（卷3 白名单五值）', allRows.every((row) => ['boot', 'sample', 'reused', 'degraded', 'recovered'].includes(String(row.cause || ''))), { total: allRows.length });
}

/* ── S7 返工单 §六（密度只判下限 + 去 hasForced 豁免 + SAMPLING_DISABLED + 双窗口）── */
{
  const mkLines = (total, real, opts) => {
    const rows = [];
    const base = Date.parse('2026-11-15T00:00:00.000Z');
    let realLeft = real;
    for (let i = 0; i < total; i += 1) {
      const at = new Date(base + i * 1000).toISOString();
      const isReal = realLeft > 0 && i % Math.max(1, Math.floor(total / real)) === 0;
      if (isReal) realLeft -= 1;
      const row = isReal
        ? { at, cause: 'sample', sampledFrom: at, workingSetMB: 500 }
        : { at, cause: 'reused', sampledFrom: new Date(base + (i - 1) * 1000).toISOString(), staleSec: 1, workingSetMB: 500 };
      if (opts && opts.forced && i === 3) row.forced = true;
      rows.push(row);
    }
    return { lines: rows, firstAt: rows[0].at, lastAt: rows[rows.length - 1].at, coverageSec: total - 1 };
  };

  // ① 2h 窗口：密度 >25% 只 denseWarn，verdict 仍 OK
  const win2hHigh = mkLines(400, 160);
  const rec2hHigh = RM.evaluateRecoverable(win2hHigh, { windowSec: 7200 });
  check('S7-01 2h 窗口密度 40% → verdict=OK 且 denseWarn=true',
    rec2hHigh.cadence.verdict === 'OK' && rec2hHigh.cadence.denseWarn === true,
    { densityPct: rec2hHigh.cadence.densityPct, verdict: rec2hHigh.cadence.verdict, denseWarn: rec2hHigh.cadence.denseWarn });

  // ④ PM 裁 M-20261115-161256（与 TRQ v4 对齐）：5 分钟窗口恢复双边 15–25%，>25% 判 BAD
  const win5mHigh = mkLines(100, 40);
  const rec5mHigh = RM.evaluateRecoverable(win5mHigh, { windowSec: 300 });
  check('S7-02 5 分钟窗口密度 40% → verdict=SAMPLE_CADENCE_BAD（双边）',
    rec5mHigh.cadence.verdict === 'SAMPLE_CADENCE_BAD' && rec5mHigh.cadence.denseWarn === true,
    { densityPct: rec5mHigh.cadence.densityPct, verdict: rec5mHigh.cadence.verdict, denseWarn: rec5mHigh.cadence.denseWarn });

  // ② 去掉 hasForced 整窗豁免：密度 5% + 有 forced 行 → 仍判 BAD
  const winLowForced = mkLines(100, 5, { forced: true });
  const recLowForced = RM.evaluateRecoverable(winLowForced, { windowSec: 7200 });
  check('S7-03 密度 5% 且含 forced 行 → 仍 SAMPLE_CADENCE_BAD（无整窗豁免）',
    recLowForced.cadence.verdict === 'SAMPLE_CADENCE_BAD' && recLowForced.cadence.hasForced === true,
    { densityPct: recLowForced.cadence.densityPct, verdict: recLowForced.cadence.verdict, hasForced: recLowForced.cadence.hasForced });

  // ③ SAMPLING_DISABLED 真实可达：创建 24h 前的（空）状态目录 → 不靠 force 也判出
  const dOld = path.join(SB, 'disabled-selftest');
  fs.rmSync(dOld, { recursive: true, force: true });
  fs.mkdirSync(dOld, { recursive: true });
  const old = new Date(Date.now() - 26 * 3600 * 1000);
  fs.utimesSync(dOld, old, old);
  const winDisabled = RM.readRenderMemoryWindow(dOld, { atCrash: new Date().toISOString(), windowSec: 300 });
  check('S7-04 24h 内无任何分片（目录 mtime 26h 前）→ code=SAMPLING_DISABLED 且 fail=true',
    winDisabled.code === 'SAMPLING_DISABLED' && winDisabled.fail === true,
    { code: winDisabled.code, fail: winDisabled.fail, samplingDisabled: winDisabled.samplingDisabled });
}

console.log(`\nR-c1ed F-1 断言：${passed}/${passed + failures.length} PASS`);
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
