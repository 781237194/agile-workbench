'use strict';
/**
 * R-20261118-170937-b34a（PM 2026-11-18 17:34 裁定 A 案）：慢操作日志 + IPC 计时的**唯一实现**（R3，B 负责）。
 *
 * 契约（需求 §6.4，字段写死）：
 *   {at, kind:'ipc'|'read'|'render'|'watch'|'build', name, ms, bytes?, path?, slow:true}
 *   阈值：IPC/读盘 ≥100ms；渲染长任务/单次 parse ≥50ms（调用方传 kind='render' 时自动用 50）。
 *   目录：<TEAM_ROOT>/状态/项目/<项目>/；当前天写 性能.jsonl，跨天自动改名 性能-YYYYMMDD.jsonl（分片 ≤5MB/片，保留 7 天）。
 *   写失败只 stderr 留痕，绝不影响业务返回。
 *
 * 公共 API（A 的 src/perf-cache.js 批2 请改薄委托到这里，避免两套实现）：
 *   record(projectName, {kind, name, ms, bytes?, path?, atMs?}) -> boolean   别名 logSlow / logSlowOp
 *   recent(projectName, limit=20) -> row[]（新的在前）                       别名 readPerfRecent / read
 *   pruneShards(projectName, atMs=Date.now()) -> removed                   别名 prunePerfShards
 *   fileOf(projectName) / shardDir(projectName) / dayKey(ms) / FAILED
 *   timedHandler(handler, {channel, projectNameOf}) -> async handler（给 ipcMain.handle 用）
 *   wrapIpcHandle(ipcMain, projectNameOf) -> boolean（所有 handle 统一计时，不改语义/异常）
 *   registerPerfIpc(ipcMain, projectNameOf) -> boolean（只读 IPC 'perf:recent' → {ok, project, items}）
 *
 * 约束：本模块不读业务文件、不改任何业务状态；只 append 慢日志。
 */
const fs = require('node:fs');
const path = require('node:path');

const SLOW_IPC_MS = 100;
const SLOW_RENDER_MS = 50;
const SHARD_MAX_BYTES = 5 * 1024 * 1024;
const KEEP_DAYS = 7;
const FILE = '性能.jsonl';

function dayKey(ms) {
  return new Date(Number(ms) + 8 * 3600 * 1000).toISOString().slice(0, 10); // 上海本地日期
}
function shardDir(projectName) {
  const root = String(process.env.TEAM_ROOT || path.join(process.cwd(), '团队'));
  return path.join(root, '状态', '项目', String(projectName || '').trim());
}
function fileOf(projectName) {
  return path.join(shardDir(projectName), FILE);
}
function shardNameFor(day) {
  return `性能-${String(day || '').replace(/-/g, '')}.jsonl`;
}
let lastPruneKey = '';
/** 跨天：把当前 性能.jsonl 改名为 性能-YYYYMMDD.jsonl（按文件 mtime 所在天）。 */
function rotateIfNeeded(dir, nowMs) {
  const cur = path.join(dir, FILE);
  try {
    const st = fs.statSync(cur);
    const fileDay = dayKey(st.mtimeMs);
    if (fileDay !== dayKey(nowMs)) {
      try { fs.renameSync(cur, path.join(dir, shardNameFor(fileDay))); } catch { /* 改名失败继续写当前文件 */ }
    }
  } catch { /* 不存在：首条时创建 */ }
}
/** 清理 7 天前的分片（同项目同天只做一次）。 */
function pruneShards(projectName, atMs = Date.now()) {
  const name = String(projectName || '').trim();
  const dir = shardDir(name);
  const day = dayKey(atMs);
  const key = `${dir}|${day}`;
  if (lastPruneKey === key) return 0;
  lastPruneKey = key;
  const cutoff = Number(atMs) - KEEP_DAYS * 24 * 3600 * 1000;
  let removed = 0;
  try {
    for (const n of fs.readdirSync(dir)) {
      const m = /^性能-(\d{4})(\d{2})(\d{2})(?:-\d+)?\.jsonl$/.exec(n);
      if (!m) continue;
      const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (t < cutoff) { try { fs.unlinkSync(path.join(dir, n)); removed += 1; } catch { /* ignore */ } }
    }
  } catch { /* 目录不存在 */ }
  return removed;
}
/**
 * 记一条慢操作；低于阈值静默丢弃。
 * @returns {boolean} 是否写入
 */
function record(projectName, entry = {}) {
  const name = String(projectName || '').trim();
  if (!name) return false;
  const kind = String(entry.kind || 'ipc');
  const ms = Number(entry.ms);
  const threshold = kind === 'render' ? SLOW_RENDER_MS : SLOW_IPC_MS;
  if (!Number.isFinite(ms) || ms < threshold) return false;
  const dir = shardDir(name);
  const atMs = Number.isFinite(Number(entry.atMs)) ? Number(entry.atMs) : Date.now();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* append 失败会兜底 */ }
  rotateIfNeeded(dir, atMs);
  pruneShards(name, atMs);
  const line = {
    at: new Date(atMs).toISOString(),
    kind,
    name: String(entry.name || ''),
    ms: Math.round(ms * 10) / 10,
    ...(entry.bytes !== undefined ? { bytes: Number(entry.bytes) } : {}),
    ...(entry.path ? { path: String(entry.path) } : {}),
    slow: true,
  };
  try {
    const cur = fileOf(name);
    // 单片≤5MB：超过就把当前文件改名成当天 -N 分片，重新开一份（保留策略仍按天）
    try {
      const st = fs.statSync(cur);
      if (st.size >= SHARD_MAX_BYTES) {
        let i = 2;
        while (fs.existsSync(path.join(dir, `性能-${String(dayKey(atMs)).replace(/-/g, '')}-${i}.jsonl`))) i += 1;
        fs.renameSync(cur, path.join(dir, `性能-${String(dayKey(atMs)).replace(/-/g, '')}-${i}.jsonl`));
      }
    } catch { /* 不存在则直接 append */ }
    fs.appendFileSync(cur, JSON.stringify(line) + '\n', 'utf8');
    return true;
  } catch (e) {
    try { console.warn('PERF_LOG_WRITE_FAILED ' + JSON.stringify({ project: name, why: String((e && e.message) || e) })); } catch { /* ignore */ }
    return false;
  }
}
/** 最近 N 条（新的在前；当前文件 + 分片，凑够即停；坏行跳过）。 */
function recent(projectName, limit = 20) {
  const name = String(projectName || '').trim();
  const max = Math.max(1, Math.min(200, Number(limit) || 20));
  if (!name) return [];
  const dir = shardDir(name);
  const files = [];
  try {
    const cur = path.join(dir, FILE);
    if (fs.existsSync(cur)) files.push(cur);
    for (const n of fs.readdirSync(dir).filter((x) => /^性能-\d{8}(?:-\d+)?\.jsonl$/.test(x)).sort().reverse()) files.push(path.join(dir, n));
  } catch { return []; }
  const rows = [];
  for (const file of files) {
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); } catch { continue; }
    for (let i = lines.length - 1; i >= 0 && rows.length < max; i -= 1) {
      try { rows.push(JSON.parse(lines[i])); } catch { /* 坏行跳过 */ }
    }
    if (rows.length >= max) break;
  }
  rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return rows.slice(0, max);
}
/** 单 handler 计时（导出便于夹具直测；不改返回值/异常）。 */
function timedHandler(handler, { channel, projectNameOf } = {}) {
  return async function timed(...args) {
    const t0 = process.hrtime.bigint();
    try {
      return await handler.apply(this, args);
    } finally {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (ms >= SLOW_IPC_MS) {
        let project = '';
        try { project = String(projectNameOf ? projectNameOf(args[args.length - 1]) : '') || ''; } catch { project = ''; }
        if (project) record(project, { kind: 'ipc', name: String(channel || ''), ms });
      }
    }
  };
}
/** 给 ipcMain.handle 全部加计时（必须在业务注册前调用；重复调用返回 false）。 */
function wrapIpcHandle(ipcMain, projectNameOf) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') return false;
  if (ipcMain.__awbPerfLogWrapped) return false;
  const orig = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => orig(channel, timedHandler(handler, { channel, projectNameOf }));
  try { Object.defineProperty(ipcMain, '__awbPerfLogWrapped', { value: true, enumerable: false }); } catch { ipcMain.__awbPerfLogWrapped = true; }
  return true;
}
/** 只读 IPC：perf:recent（面板最近 20 条）。 */
function registerPerfIpc(ipcMain, projectNameOf) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') return false;
  try {
    ipcMain.handle('perf:recent', async (_e, payload) => {
      let project = '';
      try { project = String(projectNameOf ? projectNameOf(payload) : '') || ''; } catch { project = ''; }
      return { ok: true, project, items: recent(project, payload && payload.limit ? payload.limit : 20) };
    });
    return true;
  } catch (e) {
    try { console.warn('PERF_IPC_REGISTER_FAILED ' + String((e && e.message) || e)); } catch { /* ignore */ }
    return false;
  }
}

module.exports = {
  SLOW_IPC_MS, SLOW_RENDER_MS, SHARD_MAX_BYTES, KEEP_DAYS, FILE,
  dayKey, shardDir, fileOf, shardNameFor,
  record, logSlow: record, logSlowOp: record,
  recent, readPerfRecent: recent, read: recent,
  pruneShards, prunePerfShards: pruneShards,
  rotateIfNeeded, timedHandler, wrapIpcHandle, registerPerfIpc,
};
