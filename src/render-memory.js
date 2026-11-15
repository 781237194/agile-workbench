'use strict';
/**
 * render-memory.js —— R-c1ed F-1（渲染内存采样分片 / 保留 / 取数通道）的纯逻辑 + 落盘
 *
 * 口径来源：需求/R-20261115-140436-c1ed（正文 14030B/42a3ba8d）+ 需求/增补卷-c1ed-1.md（9278B/0051d99e）
 *   §2.1 水位采样 `渲染内存-YYYYMMDD.jsonl`，同日溢出切 `-2`/`-3`…；崩溃归档 `渲染崩溃/<ts>/`；保留审计 `渲染保留.jsonl`
 *   §2.2 单分片 5242880B；采样保留 7 天；崩溃归档 30 天且 ≤50 目录；单行不得跨分片
 *   §2.4 只删白名单内路径（渲染内存-*.jsonl / 渲染崩溃/<ts>/），不删当天/近 7 天/正在写的分片
 *   §3.1 readRenderMemoryWindow(projectPath,{atCrash,windowSec=300}) 末分片倒读 + 续读上一分片；只读
 *   §3.2 行字段 {at,pid,type,guestUrl,workingSetMB,cause}；首行 kind:'boot'；降级补 {cause:'interval',intervalMs:5000}
 *   §3.3 R1 连续性 / R2 null 占比 ≤10% / R3 coverageSec ≥295
 *
 * 设计：只依赖 node:fs / node:path；不读不写白名单以外的任何文件。
 */

const fs = require('node:fs');
const path = require('node:path');

const SHARD_MAX_BYTES = 5242880;
const SAMPLE_RETENTION_DAYS = 7;
const CRASH_RETENTION_DAYS = 30;
const CRASH_MAX_DIRS = 50;
const SHARD_RE = /^渲染内存-(\d{8})(?:-(\d+))?\.jsonl$/;
const SAMPLE_FIELDS = ['at', 'pid', 'type', 'guestUrl', 'workingSetMB', 'cause'];

function dateKeyOf(date) {
  const d = date instanceof Date ? date : new Date(date === undefined ? Date.now() : date);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function shardNameOf(dateKey, index) {
  const n = Number(index) || 1;
  return n <= 1 ? `渲染内存-${dateKey}.jsonl` : `渲染内存-${dateKey}-${n}.jsonl`;
}

/** 列出某项目下的采样分片（只认白名单命名），按日期、再按 N 升序。 */
function listShards(projectPath) {
  const dir = String(projectPath || '');
  if (!dir) return [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const rows = [];
  for (const name of names) {
    const m = SHARD_RE.exec(name);
    if (!m) continue;
    rows.push({ name, rel: name, dateKey: m[1], index: Number(m[2] || 1), path: path.join(dir, name) });
  }
  rows.sort((a, b) => (a.dateKey === b.dateKey ? a.index - b.index : a.dateKey.localeCompare(b.dateKey)));
  return rows;
}

function fileBytes(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/** 采样行归一（只留 §3.2 固定字段；kind 可选且不替代 cause）。 */
function normalizeSampleLine(row) {
  const src = row && typeof row === 'object' ? row : {};
  const out = {};
  for (const key of SAMPLE_FIELDS) out[key] = src[key] === undefined ? null : src[key];
  out.at = String(src.at || new Date().toISOString());
  out.pid = src.pid === undefined || src.pid === null ? null : Number(src.pid);
  out.type = String(src.type || 'renderer');
  out.guestUrl = src.guestUrl === undefined ? null : src.guestUrl;
  out.workingSetMB = src.workingSetMB === undefined || src.workingSetMB === null ? null : Number(src.workingSetMB);
  out.cause = String(src.cause || 'sample');
  // §3.2 降级频率变更点必须带 intervalMs（缺了就没法复算 interval）
  if (src.intervalMs !== undefined && src.intervalMs !== null && Number.isFinite(Number(src.intervalMs))) out.intervalMs = Number(src.intervalMs);
  if (src.kind) out.kind = String(src.kind);
  // PM 2026-11-15 15:36 裁决（方案2）：1s 行、每 5 拍真取 metrics、中间行复用上一值并标 sampledFrom（真实采样时刻 ISO）。
  // 判据用法：斜率只用「有真值」的行（无 sampledFrom 或 sampledFrom===at），R1/R2/R3 用全行。
  if (src.sampledFrom !== undefined && src.sampledFrom !== null) out.sampledFrom = String(src.sampledFrom);
  if (src.carried === true) out.carried = true;
  return out;
}

/** 当前分片缓存（dir|dateKey → {path,index,dateKey}）：避免每拍都 readdir+stat 全目录（实测那是 11ms 级开销）。 */
const shardCache = new Map();

function cachedShards(dir, dateKey) {
  const key = `${dir}|${dateKey}`;
  const hit = shardCache.get(key);
  if (hit && Array.isArray(hit.list)) return hit.list;
  return null;
}

/**
 * 追加一行采样：预判「当前分片字节 + 本行字节 > 5242880」→ 切下一个分片；单行不跨分片。
 * 返回 {file, created, bytes}；写盘失败抛错由调用方降级（fail-open）。
 */
function appendSample(projectPath, row, options = {}) {
  const dir = String(projectPath || '');
  if (!dir) throw new Error('PROJECT_PATH_REQUIRED');
  const dateKey = String(options.dateKey || dateKeyOf(options.at || row && row.at));
  const line = JSON.stringify(normalizeSampleLine(row)) + '\n';
  const lineBytes = Buffer.byteLength(line, 'utf8');
  if (lineBytes > SHARD_MAX_BYTES) throw new Error('SAMPLE_LINE_TOO_LARGE');
  fs.mkdirSync(dir, { recursive: true });
  const cacheKey = `${dir}|${dateKey}`;
  let cached = shardCache.get(cacheKey);
  if (!cached) {
    const shards = listShards(dir).filter((item) => item.dateKey === dateKey);
    const last = shards.length ? shards[shards.length - 1] : null;
    cached = { path: last ? last.path : '', index: last ? last.index : 0, bytes: last ? fileBytes(last.path) : 0 };
    shardCache.set(cacheKey, cached);
  }
  let created = false;
  if (!cached.path || cached.bytes + lineBytes > SHARD_MAX_BYTES) {
    const nextIndex = cached.index ? cached.index + 1 : 1;
    const name = shardNameOf(dateKey, nextIndex);
    cached = { path: path.join(dir, name), index: nextIndex, bytes: fileBytes(path.join(dir, name)) };
    shardCache.set(cacheKey, cached);
    created = true;
  }
  fs.appendFileSync(cached.path, line, 'utf8');
  cached.bytes += lineBytes;
  return { file: cached.path, created, bytes: cached.bytes, lineBytes };
}

/** 测试/清理用：清空分片缓存（外部删了分片后要清，否则会写回旧路径）。 */
function resetShardCache() {
  shardCache.clear();
}

/** 读一个分片（容错：坏行跳过并记 read_failed）。 */
function readShardRows(shard) {
  const out = [];
  let text = '';
  try { text = fs.readFileSync(shard.path, 'utf8'); } catch { return { rows: out, readFailed: true }; }
  let failed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { failed += 1; }
  }
  return { rows: out, readFailed: failed > 0 };
}

/** §3.1 唯一取数通道：从末分片末尾倒读，不足续读上一分片，直到凑够 windowSec 或耗尽。 */
function readRenderMemoryWindow(projectPath, options = {}) {
  const windowSec = Number(options.windowSec) > 0 ? Number(options.windowSec) : 300;
  const atCrashMs = Date.parse(String(options.atCrash || ''));
  const cutoff = Number.isFinite(atCrashMs) ? atCrashMs - windowSec * 1000 : NaN;
  const shards = listShards(projectPath);
  const lines = [];
  const daysRead = [];
  let insufficient = false;
  const enough = () => {
    if (!lines.length) return false;
    const first = Date.parse(String(lines[0].at || ''));
    if (!Number.isFinite(first)) return false;
    return Number.isFinite(cutoff) ? first <= cutoff : true;
  };
  const byDay = [...new Set(shards.map((s) => s.dateKey))].sort().reverse();
  for (const day of byDay) {
    daysRead.push(day);
    const dayShards = shards.filter((s) => s.dateKey === day).sort((a, b) => b.index - a.index);
    const chunk = [];
    for (const shard of dayShards) {
      const { rows } = readShardRows(shard);
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        const at = Date.parse(String(row && row.at || ''));
        if (Number.isFinite(at) && Number.isFinite(atCrashMs) && at > atCrashMs) continue;
        if (Number.isFinite(at) && Number.isFinite(cutoff) && at < cutoff) continue;
        chunk.push(row);
      }
      const merged = chunk.slice().reverse();
      if (merged.length && Number.isFinite(cutoff)) {
        const firstMs = Date.parse(String(merged[0] && merged[0].at || ''));
        if (Number.isFinite(firstMs) && firstMs <= cutoff) break;
      }
    }
    const ordered = chunk.slice().reverse();
    lines.unshift(...ordered);
    if (enough()) break;
  }
  if (!lines.length) insufficient = true;
  const firstAt = lines.length ? String(lines[0].at || '') : '';
  const lastAt = lines.length ? String(lines[lines.length - 1].at || '') : '';
  const firstMs = Date.parse(firstAt);
  const lastMs = Date.parse(lastAt);
  const coverageSec = Number.isFinite(firstMs) && Number.isFinite(lastMs) ? Math.max(0, Math.round((lastMs - firstMs) / 1000)) : 0;
  const gaps = [];
  for (let i = 1; i < lines.length; i += 1) {
    const prev = Date.parse(String(lines[i - 1].at || ''));
    const cur = Date.parse(String(lines[i].at || ''));
    if (Number.isFinite(prev) && Number.isFinite(cur)) {
      const delta = Math.round((cur - prev) / 1000);
      if (delta > 10) gaps.push({ at: String(lines[i].at || ''), gapSec: delta });
    }
  }
  if (coverageSec + 1 < windowSec) insufficient = true;
  return { lines, firstAt, lastAt, coverageSec, gaps, insufficient, windowSec, shardsRead: daysRead };
}

/** §3.3 可复原三判据：R1 连续性（相邻差 ≤2×interval、单缺口≤10s、累计缺口≤3）、R2 null 占比 ≤10%、R3 coverageSec ≥295。 */
function evaluateRecoverable(win, options = {}) {
  const window = win && typeof win === 'object' ? win : {};
  const lines = Array.isArray(window.lines) ? window.lines : [];
  const windowSec = Number(options.windowSec) > 0 ? Number(options.windowSec) : (Number(window.windowSec) || 300);
  const defaultIntervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 1000;
  const intervalAt = (index) => {
    for (let i = index; i >= 0; i -= 1) {
      const row = lines[i] || {};
      if (String(row.cause || '') === 'interval' && Number(row.intervalMs) > 0) return Number(row.intervalMs);
    }
    return defaultIntervalMs;
  };
  const gapRows = [];
  let cumulative = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const prev = Date.parse(String(lines[i - 1].at || ''));
    const cur = Date.parse(String(lines[i].at || ''));
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) continue;
    const delta = cur - prev;
    const allowed = 2 * intervalAt(i);
    if (delta > allowed || delta > 10 * 1000) {
      gapRows.push({ at: String(lines[i].at || ''), deltaMs: delta, allowedMs: allowed });
      cumulative += 1;
    }
  }
  const r1 = gapRows.length <= 3 && gapRows.every((gap) => gap.deltaMs <= 12000 + gap.allowedMs);
  const total = lines.length;
  const nullCount = lines.filter((row) => row && (row.workingSetMB === null || row.workingSetMB === undefined)).length;
  const nullRatio = total ? nullCount / total : 1;
  const r2 = total > 0 && nullRatio <= 0.1;
  const coverageSec = Number(window.coverageSec) || 0;
  const r3 = coverageSec >= Math.min(295, Math.max(0, windowSec - 5));
  return {
    recoverable: r1 && r2 && r3,
    R1: r1,
    R2: r2,
    R3: r3,
    gaps: gapRows,
    nullRatio,
    coverageSec,
    code: r1 && r2 && r3 ? 'OK' : (window.insufficient ? 'SAMPLING_WINDOW_INSUFFICIENT' : 'SAMPLING_WINDOW_BROKEN')
  };
}

/**
 * §2.2/§2.4 保留清理：算「该删什么」，不直接删（调用方执行并写 渲染保留.jsonl 审计）。
 * 白名单：采样只认 渲染内存-*.jsonl；崩溃只认 渲染崩溃/<ts>/ 目录。当天分片、近 7 天分片一律保留。
 */
function planRetention(projectPath, options = {}) {
  const dir = String(projectPath || '');
  const nowMs = Number(options.nowMs) > 0 ? Number(options.nowMs) : Date.now();
  const sampleKeepDays = Number(options.sampleKeepDays) >= 0 ? Number(options.sampleKeepDays) : SAMPLE_RETENTION_DAYS;
  const crashKeepDays = Number(options.crashKeepDays) >= 0 ? Number(options.crashKeepDays) : CRASH_RETENTION_DAYS;
  const crashMaxDirs = Number(options.crashMaxDirs) > 0 ? Number(options.crashMaxDirs) : CRASH_MAX_DIRS;
  const todayKey = dateKeyOf(new Date(nowMs));
  const removed = [];
  const kept = [];
  for (const shard of listShards(dir)) {
    if (shard.dateKey === todayKey) { kept.push(shard.rel); continue; }
    const shardMs = Date.parse(`${shard.dateKey.slice(0, 4)}-${shard.dateKey.slice(4, 6)}-${shard.dateKey.slice(6, 8)}T00:00:00`);
    if (!Number.isFinite(shardMs)) { kept.push(shard.rel); continue; }
    const ageDays = Math.floor((nowMs - shardMs) / 86400000);
    if (ageDays >= sampleKeepDays) removed.push(shard.rel);
    else kept.push(shard.rel);
  }
  const crashRoot = path.join(dir, '渲染崩溃');
  let crashDirs = [];
  try {
    crashDirs = fs.readdirSync(crashRoot, { withFileTypes: true })
      .filter((ent) => ent.isDirectory() && /^\d{8}T\d{6}Z?$/.test(ent.name))
      .map((ent) => {
        const ms = Date.parse(`${ent.name.slice(0, 4)}-${ent.name.slice(4, 6)}-${ent.name.slice(6, 8)}T${ent.name.slice(9, 11)}:${ent.name.slice(11, 13)}:${ent.name.slice(13, 15)}Z`);
        return { rel: path.posix.join('渲染崩溃', ent.name), name: ent.name, ms: Number.isFinite(ms) ? ms : 0, path: path.join(crashRoot, ent.name) };
      })
      .sort((a, b) => b.ms - a.ms);
  } catch { crashDirs = []; }
  const crashRemoved = [];
  crashDirs.forEach((item, index) => {
    const ageDays = item.ms ? Math.floor((nowMs - item.ms) / 86400000) : crashKeepDays + 1;
    if (ageDays >= crashKeepDays || index >= crashMaxDirs) crashRemoved.push(item.rel);
  });
  return { removed, crashRemoved, kept, todayKey, sampleKeepDays, crashKeepDays, crashMaxDirs };
}

const api = {
  SHARD_MAX_BYTES,
  SAMPLE_RETENTION_DAYS,
  CRASH_RETENTION_DAYS,
  CRASH_MAX_DIRS,
  SAMPLE_FIELDS,
  dateKeyOf,
  shardNameOf,
  listShards,
  normalizeSampleLine,
  appendSample,
  resetShardCache,
  readShardRows,
  readRenderMemoryWindow,
  evaluateRecoverable,
  planRetention
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.RenderMemory = api;
