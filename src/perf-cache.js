#!/usr/bin/env node
'use strict';
/**
 * R-20261118-170937-b34a（P1，T-e2d8 R1+R2）—— 主进程「读盘缓存 + 慢操作日志」实现（CJS 单源）。
 *
 * 需求契约（正文 §6.2 / §6.4）：
 *   · 缓存形状：`getJsonFile(file)` → `{ value, mtimeMs, size, source: 'cache'|'read'|'missing', rebuilt }`
 *     命中判据＝ mtimeMs 与 size **都**未变 → 直接返回内存值（不读盘）；任一变化 → 重读重解析；
 *     文件被截断（size 变小）→ 丢弃重建并置 rebuilt=1；单值 >8MB 不缓存（记 cached:false）。
 *   · 写后失效：写路径（writeStore / json-atomic）成功后调 `invalidate(file)`（同时按 mtime/size 双保险兜底）。
 *   · 慢操作日志：`团队/状态/项目/<项目>/性能-YYYYMMDD.jsonl`（append-only，按天分片，单片 ≤5MB，
 *     保留 7 天），字段 `{at, kind, name, ms, bytes?, path?, slow, source?}`；
 *     阈值：IPC/读盘 ≥100ms、parse/长任务 ≥50ms。
 *   · 只写派生文件（性能日志），**不写** 工作流.json / 任务 / 需求；沙盘各用各的根。
 *
 * 为什么放 CJS：壳层主进程是 CJS（Electron 33 / Node 20 不支持 require(ESM)），与 json-atomic.cjs 同一套路。
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_CACHE_BYTES = 8 * 1024 * 1024; // §6.2 单值 ≤8MB 才缓存
const SLOW_IPC_MS = 100;                  // §6.4 IPC/读盘 ≥100ms
const SLOW_TASK_MS = 50;                  // §6.4 长任务/parse ≥50ms
const SHARD_MAX_BYTES = 5 * 1024 * 1024;  // 单片 ≤5MB
const KEEP_DAYS = 7;                      // 保留 7 天

/* ── 读盘缓存 ─────────────────────────────────────────────────────────── */

const jsonCache = new Map();   // file → { mtimeMs, size, value }
const textCache = new Map();   // file → { mtimeMs, size, value }
const stats = { hits: 0, reads: 0, misses: 0, rebuilt: 0, skipped: 0 };

function statOf(file) {
  try {
    const st = fs.statSync(file);
    return { mtimeMs: st.mtimeMs, size: st.size, isFile: st.isFile() };
  } catch { return null; }
}

/** 取 JSON（缓存命中不读盘）。返回 { value, mtimeMs, size, source, rebuilt, cached, path }。 */
function getJsonFile(file, options = {}) {
  const target = String(file || '');
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_CACHE_BYTES;
  const st = statOf(target);
  if (!st || !st.isFile) {
    jsonCache.delete(target);
    stats.misses += 1;
    return { value: null, mtimeMs: 0, size: 0, source: 'missing', rebuilt: 0, cached: false, path: target };
  }
  const hit = jsonCache.get(target);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    stats.hits += 1;
    return { value: hit.value, mtimeMs: st.mtimeMs, size: st.size, source: 'cache', rebuilt: 0, cached: true, path: target };
  }
  if (st.size > maxBytes) {
    stats.skipped += 1;
    let value = null;
    try { value = JSON.parse(fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '')); } catch { value = null; }
    jsonCache.delete(target);
    return { value, mtimeMs: st.mtimeMs, size: st.size, source: 'read', rebuilt: 0, cached: false, path: target };
  }
  let value = null;
  try {
    value = JSON.parse(fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    // §八·异常：解析失败保留上一份缓存（不清空），返回旧值 + parseError 标记
    stats.misses += 1;
    if (hit) return { value: hit.value, mtimeMs: hit.mtimeMs, size: hit.size, source: 'cache', rebuilt: 0, cached: true, path: target, parseError: true };
    return { value: null, mtimeMs: st.mtimeMs, size: st.size, source: 'read', rebuilt: 0, cached: false, path: target, parseError: true };
  }
  const truncated = Boolean(hit && st.size < hit.size);
  if (truncated) stats.rebuilt += 1;
  stats.reads += 1;
  jsonCache.set(target, { mtimeMs: st.mtimeMs, size: st.size, value });
  return { value, mtimeMs: st.mtimeMs, size: st.size, source: truncated ? 'rebuilt' : 'read', rebuilt: truncated ? 1 : 0, cached: true, path: target };
}

/** 取文本（行数组按需切分，用于唤醒.jsonl 这类大日志：只缓存原文，切片由调用方决定）。 */
function getTextFile(file, options = {}) {
  const target = String(file || '');
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_CACHE_BYTES;
  const st = statOf(target);
  if (!st || !st.isFile) {
    textCache.delete(target);
    stats.misses += 1;
    return { value: '', mtimeMs: 0, size: 0, source: 'missing', rebuilt: 0, cached: false, path: target };
  }
  const hit = textCache.get(target);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    stats.hits += 1;
    return { value: hit.value, mtimeMs: st.mtimeMs, size: st.size, source: 'cache', rebuilt: 0, cached: true, path: target };
  }
  if (st.size > maxBytes) {
    stats.skipped += 1;
    const value = fs.readFileSync(target, 'utf8');
    textCache.delete(target);
    return { value, mtimeMs: st.mtimeMs, size: st.size, source: 'read', rebuilt: 0, cached: false, path: target };
  }
  const value = fs.readFileSync(target, 'utf8');
  const truncated = Boolean(hit && st.size < hit.size);
  if (truncated) stats.rebuilt += 1;
  stats.reads += 1;
  textCache.set(target, { mtimeMs: st.mtimeMs, size: st.size, value });
  return { value, mtimeMs: st.mtimeMs, size: st.size, source: truncated ? 'rebuilt' : 'read', rebuilt: truncated ? 1 : 0, cached: true, path: target };
}

/** 写后失效（写路径成功即调；mtime/size 双保险是第二道防线，防「同一毫秒写两次同长度内容」）。 */
function invalidate(file) {
  const target = String(file || '');
  let removed = 0;
  if (jsonCache.delete(target)) removed += 1;
  if (textCache.delete(target)) removed += 1;
  return removed;
}
function invalidateAll() { const n = jsonCache.size + textCache.size; jsonCache.clear(); textCache.clear(); return n; }
function cacheStats() {
  return { ...stats, jsonKeys: jsonCache.size, textKeys: textCache.size };
}
function cacheSizes() {
  const out = [];
  for (const [file, row] of jsonCache) out.push({ file, kind: 'json', size: Buffer.byteLength(JSON.stringify(row.value || null), 'utf8') });
  for (const [file, row] of textCache) out.push({ file, kind: 'text', size: Buffer.byteLength(String(row.value || ''), 'utf8') });
  return out.sort((a, b) => b.size - a.size);
}
/** 内存超预算时清最旧 key（§AC5⑤：清最旧 → 再全部，功能不降级）。 */
function evictOldest(n = 1) {
  const entries = [...jsonCache.entries()].map(([file, row]) => ({ file, kind: 'json', mtimeMs: row.mtimeMs }))
    .concat([...textCache.entries()].map(([file, row]) => ({ file, kind: 'text', mtimeMs: row.mtimeMs })))
    .sort((a, b) => a.mtimeMs - b.mtimeMs).slice(0, Math.max(1, n));
  for (const e of entries) { if (e.kind === 'json') jsonCache.delete(e.file); else textCache.delete(e.file); }
  return entries.map((e) => e.file);
}

/* ── 慢操作日志（性能.jsonl 派生文件） ───────────────────────────────── */

function projectPerfDir(teamRoot, projectName) {
  return path.join(String(teamRoot || ''), '状态', '项目', String(projectName || ''));
}
function perfShardPath(teamRoot, projectName, at = new Date()) {
  const ymd = `${at.getFullYear()}${String(at.getMonth() + 1).padStart(2, '0')}${String(at.getDate()).padStart(2, '0')}`;
  return path.join(projectPerfDir(teamRoot, projectName), `性能-${ymd}.jsonl`);
}

/**
 * 记一条慢操作（append-only）。只在慢/有计量价值时调用（调用方判阈值），返回 { ok, file }。
 * 写失败 → stderr 留痕（§八·异常：日志写失败 stderr + 内存计数），不抛给业务。
 */
function recordPerf({ teamRoot, projectName, kind = 'ipc', name = '', ms = 0, bytes = 0, file = '', slow, source = '' }) {
  if (!teamRoot || !projectName) return { ok: false, why: 'no_project' };
  const at = new Date();
  const row = {
    at: at.toISOString(),
    kind: String(kind || 'ipc'),
    name: String(name || ''),
    ms: Math.max(0, Math.round(Number(ms) || 0)),
    ...(bytes ? { bytes: Number(bytes) } : {}),
    ...(file ? { path: String(file) } : {}),
    slow: slow === undefined ? true : Boolean(slow),
    ...(source ? { source: String(source) } : {}),
  };
  try {
    const target = perfShardPath(teamRoot, projectName, at);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 单片 ≤5MB：超了直接滚到 -2/-3（按天分片是主口径，这是兜底）
    let outFile = target;
    try {
      if (fs.statSync(outFile).size > SHARD_MAX_BYTES) {
        let i = 2;
        while (fs.existsSync(outFile.replace(/\.jsonl$/, `-${i}.jsonl`))) i += 1;
        outFile = outFile.replace(/\.jsonl$/, `-${i}.jsonl`);
      }
    } catch { /* 文件还不存在 */ }
    fs.appendFileSync(outFile, `${JSON.stringify(row)}\n`, 'utf8');
    prunePerfShards(teamRoot, projectName, at);
    return { ok: true, file: outFile, row };
  } catch (e) {
    perfWriteFailures += 1;
    try { process.stderr.write(`[perf] 写慢日志失败：${String((e && e.message) || e)}\n`); } catch { /* ignore */ }
    return { ok: false, why: String((e && e.message) || e) };
  }
}
let perfWriteFailures = 0;
function perfStats() { return { writeFailures: perfWriteFailures }; }

/** 保留 7 天：按文件名日期删过期分片（同一天只做一次，避免每写一条都 readdir）。 */
let lastPruneDay = '';
function prunePerfShards(teamRoot, projectName, at) {
  const day = at.toISOString().slice(0, 10);
  if (lastPruneDay === `${teamRoot}|${projectName}|${day}`) return 0;
  lastPruneDay = `${teamRoot}|${projectName}|${day}`;
  const dir = projectPerfDir(teamRoot, projectName);
  let removed = 0;
  try {
    const cutoff = at.getTime() - KEEP_DAYS * 24 * 3600 * 1000;
    for (const name of fs.readdirSync(dir)) {
      const m = /^性能-(\d{4})(\d{2})(\d{2})(?:-\d+)?\.jsonl$/.exec(name);
      if (!m) continue;
      const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (t < cutoff) { try { fs.unlinkSync(path.join(dir, name)); removed += 1; } catch { /* ignore */ } }
    }
  } catch { /* 目录不存在 */ }
  return removed;
}

/** 读最近 N 条慢操作（面板用：只读，不写）。按天分片倒序读，凑够 N 条即停。 */
function readPerfRecent(teamRoot, projectName, limit = 20) {
  const max = Number(limit) > 0 ? Math.floor(Number(limit)) : 20;
  const dir = projectPerfDir(teamRoot, projectName);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((n) => /^性能-\d{8}(?:-\d+)?\.jsonl$/.test(n)).sort().reverse();
  } catch { return { rows: [], files: [], truncated: false }; }
  const rows = [];
  for (const name of files) {
    const file = path.join(dir, name);
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && rows.length < max; i -= 1) {
      try { rows.push(JSON.parse(lines[i])); } catch { /* 坏行跳过 */ }
    }
    if (rows.length >= max) break;
  }
  rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return { rows: rows.slice(0, max), files, truncated: rows.length >= max };
}

/* ── IPC 计时包装（R2：慢调用可观测） ─────────────────────────────────── */

/**
 * 包一个 ipcMain.handle 的 handler：计时；同步重活（>50ms）或总耗时 ≥100ms 记一条慢日志。
 * 不改 handler 语义/返回值，异常照常向上抛。
 * @param {(name:string)=>string} projectNameOf 取当前项目名（拿不到就跳过日志，不影响业务）
 */
function withIpcTiming(name, handler, { projectNameOf, teamRootOf, thresholdMs = SLOW_IPC_MS } = {}) {
  return async function timedIpcHandler(...args) {
    const started = process.hrtime.bigint();
    try {
      const result = await handler.apply(this, args);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (ms >= thresholdMs || ms >= SLOW_TASK_MS) {
        try {
          const projectName = typeof projectNameOf === 'function' ? String(projectNameOf() || '') : '';
          const teamRoot = typeof teamRootOf === 'function' ? String(teamRootOf() || '') : '';
          if (projectName && teamRoot) {
            recordPerf({ teamRoot, projectName, kind: 'ipc', name, ms, slow: ms >= thresholdMs });
          }
        } catch { /* 日志失败不影响业务 */ }
      }
      return result;
    } catch (e) {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      try {
        const projectName = typeof projectNameOf === 'function' ? String(projectNameOf() || '') : '';
        const teamRoot = typeof teamRootOf === 'function' ? String(teamRootOf() || '') : '';
        if (projectName && teamRoot) recordPerf({ teamRoot, projectName, kind: 'ipc', name, ms, slow: true, source: 'throw' });
      } catch { /* ignore */ }
      throw e;
    }
  };
}

/** 同步重活计时（读盘/parse/build）：返回结果，超阈值时记一条。 */
function timeSync({ teamRoot, projectName, kind = 'read', name = '', file = '', bytes = 0, thresholdMs = SLOW_TASK_MS }, fn) {
  const started = process.hrtime.bigint();
  const value = fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (ms >= thresholdMs) {
    try { recordPerf({ teamRoot, projectName, kind, name, ms, bytes, file, slow: true }); } catch { /* ignore */ }
  }
  return { value, ms };
}

module.exports = {
  MAX_CACHE_BYTES,
  SLOW_IPC_MS,
  SLOW_TASK_MS,
  getJsonFile,
  getTextFile,
  invalidate,
  invalidateAll,
  cacheStats,
  cacheSizes,
  evictOldest,
  recordPerf,
  readPerfRecent,
  perfShardPath,
  perfStats,
  withIpcTiming,
  timeSync,
};
