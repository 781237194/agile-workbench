'use strict';
/**
 * rolecard-shell-hook.js —— R-fefa（T-20261119-185311-66b4）壳层补充（A 侧命中两处未覆盖）
 *
 * ① 压缩信号：壳层在检测到上下文压缩时写 `团队/状态/角色卡重读/compact.signal`（JSON：{at,role,source,sha12}），
 *    CLI（lib/rolecard-digest.mjs → consumeCompactSignal）读到即删并注入一次摘要。
 *    - DSH 目前没有公开压缩事件：本模块对 `session/list` 的会话对象做**多字段探测**（compactionCount /
 *      lastCompactionAt / compactedAt …），命中且计数/时间前进才写信号；探测不到时**不写**（不造假）。
 *    - 可注入：`TEAM_SELFTEST=1` 或 `AWB_COMPACT_SIGNAL_ENABLE=1` 时主进程注册 `team:compact-signal` IPC，
 *      夹具/排障可直接写一次信号（需求 §6.2「须可注入降级」）。
 * ② usage tokens：把 `session/list` 的 `projections.values.tokenUsage` 按角色写进
 *    `团队/状态/项目/<slug>/会话用量.json`（schema 与 session.mjs 一致：{sessionId,tokens,input,at,source}），
 *    供 CLI 的 usage 闩锁（rolecard-digest.usageOfRole → readSessionUsageTrack）读到，不再「需调用方传 tokens 但没人传」。
 *
 * 纯 Node、无 Electron 依赖：main.js 只接线，单测见 scripts/test-fefa-shell-hook.cjs。
 */
const fs = require('node:fs');
const path = require('node:path');

const SIGNAL_REL = Object.freeze(['状态', '角色卡重读', 'compact.signal']);
const USAGE_FILE = '会话用量.json';
const USAGE_SOURCE = 'workbench-shell';
const USAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function compactSignalFile(teamRoot) {
  return path.join(String(teamRoot || ''), ...SIGNAL_REL);
}

/** 压缩信号体：payload 里只认可控字段，时间戳统一 ISO。 */
function buildCompactSignal(input = {}) {
  const at = String(input.at || new Date().toISOString());
  return {
    at,
    role: String(input.role || ''),
    source: String(input.source || 'shell'),
    ...(input.sha12 ? { sha12: String(input.sha12) } : {}),
  };
}

/** 写一次压缩信号（原子：tmp + rename；目录不存在就建）。返回 {ok,file,written}。 */
function writeCompactSignal(teamRoot, input = {}) {
  const file = compactSignalFile(teamRoot);
  if (!teamRoot) return { ok: false, code: 'TEAM_ROOT_REQUIRED', file: '' };
  const payload = buildCompactSignal(input);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, written: true, file, payload };
  } catch (error) {
    return { ok: false, code: 'COMPACT_SIGNAL_WRITE_FAILED', file, message: String((error && error.message) || error).slice(0, 200) };
  }
}

function readCompactSignal(teamRoot) {
  const file = compactSignalFile(teamRoot);
  try {
    return { ok: true, file, payload: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { ok: false, file, payload: null };
  }
}

/**
 * 从 DSH `session/list` 的一条会话里探测压缩标记（多字段容错）。
 * 返回 `{count, at}`：count 取得到则用数字比较，否则用 at 比较；都取不到 → null（=探测不到）。
 */
function compactMarkerOfSession(session) {
  if (!session || typeof session !== 'object') return null;
  const proj = (session.projections && session.projections.values) || {};
  const candidates = [
    ['compactionCount', proj.compactionCount],
    ['compactionCount', session.compactionCount],
    ['compactCount', proj.compactCount],
    ['compactCount', session.compactCount],
    ['compactions', proj.compactions],
  ];
  for (const [key, value] of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return { kind: 'count', key, count: n, at: '' };
  }
  const atCandidates = [
    ['lastCompactionAt', proj.lastCompactionAt],
    ['lastCompactionAt', session.lastCompactionAt],
    ['compactedAt', proj.compactedAt],
    ['compactedAt', session.compactedAt],
    ['compactAt', proj.compactAt],
    ['compactAt', session.compactAt],
  ];
  for (const [key, value] of atCandidates) {
    const text = String(value || '').trim();
    const ms = Date.parse(text);
    if (text && Number.isFinite(ms)) return { kind: 'at', key, count: null, at: text, ms };
  }
  return null;
}

/** before/after 两个标记 → 是否「新发生了一次压缩」。任一侧为空都不算（首个样本只记基线）。 */
function detectCompactDelta(before, after) {
  if (!before || !after) return false;
  if (before.kind === 'count' && after.kind === 'count') return Number(after.count) > Number(before.count);
  if (before.kind === 'at' && after.kind === 'at') return Number(after.ms) > Number(before.ms);
  return false;
}

/** 单条会话的 usage（口径与 session.mjs → usageOfSession 一致：input=uncachedInputTokens）。 */
function usageOfSessionInfo(session) {
  const tu = session && session.projections && session.projections.values && session.projections.values.tokenUsage;
  if (!tu || typeof tu !== 'object') return null;
  const uncached = Number(tu.uncachedInputTokens || 0);
  const cacheRead = Number(tu.cacheReadTokens || 0);
  const output = Number(tu.outputTokens || 0);
  if (!Number.isFinite(uncached) || uncached < 0) return null;
  return { input: uncached, cacheRead, output, tokens: uncached + cacheRead + output };
}

/**
 * 由会话列表 + 名册映射生成 `会话用量.json` 条目（只写有映射且能读到 tokenUsage 的角色）。
 * @param {{sessions:Array, sessionsByRole:Object, at?:string}} input
 */
function usageEntriesOfSessions(input = {}) {
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const byId = new Map(sessions.map((s) => [String((s && s.sessionId) || ''), s]));
  const mapping = input.sessionsByRole && typeof input.sessionsByRole === 'object' ? input.sessionsByRole : {};
  const at = String(input.at || new Date().toISOString());
  const out = {};
  for (const [role, sessionId] of Object.entries(mapping)) {
    const sid = String(sessionId || '');
    if (!role || !sid) continue;
    const session = byId.get(sid);
    const usage = usageOfSessionInfo(session);
    if (!usage) continue;
    // B-7009：原生三项都落盘（input=uncachedInputTokens / cacheRead / output），界面才能给「界面值 vs 原生值」对照表。
    out[role] = {
      sessionId: sid, tokens: usage.tokens, input: usage.input,
      cacheRead: usage.cacheRead, output: usage.output,
      at, source: USAGE_SOURCE,
    };
  }
  return out;
}

/** 读旧 会话用量.json（坏文件按空处理，不阻断）。 */
function readUsageTrack(projectStateDir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(String(projectStateDir || ''), USAGE_FILE), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

/** 合并写入 会话用量.json（tmp+rename；只覆盖本次有值的角色，其它角色原有条目保留）。 */
function writeUsageTrack(projectStateDir, entries = {}, { at = new Date().toISOString() } = {}) {
  if (!projectStateDir) return { ok: false, code: 'PROJECT_STATE_DIR_REQUIRED' };
  const file = path.join(projectStateDir, USAGE_FILE);
  const rows = entries && typeof entries === 'object' ? entries : {};
  if (!Object.keys(rows).length) return { ok: true, written: false, file, entries: 0 };
  try {
    const old = readUsageTrack(projectStateDir);
    const next = { ...old };
    for (const [role, row] of Object.entries(rows)) {
      next[role] = { ...(old[role] || {}), ...row, at: String(row.at || at) };
    }
    fs.mkdirSync(projectStateDir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, written: true, file, entries: Object.keys(rows).length };
  } catch (error) {
    return { ok: false, code: 'USAGE_TRACK_WRITE_FAILED', file, message: String((error && error.message) || error).slice(0, 200) };
  }
}

/** 旧条目超过 24h 视为「用量未知」，不参与闩锁（写入方覆盖即可，这里只读判断）。 */
function usageFresh(entry, now = Date.now()) {
  const at = Date.parse(String((entry && entry.at) || ''));
  return Number.isFinite(at) && now - at <= USAGE_MAX_AGE_MS;
}

/**
 * 一次会话列表扫描的副作用（usage 写盘 + 压缩检测）。纯逻辑 + 文件写，不联网。
 * @returns {{usage:{ok,wrote,entries}, compacts:[{role,sessionId,marker}], signals:[{ok,file}]}}
 */
function syncSessionSideEffects(options = {}) {
  const teamRoot = String(options.teamRoot || '');
  const projectStateDir = String(options.projectStateDir || '');
  const sessions = Array.isArray(options.sessions) ? options.sessions : [];
  const sessionsByRole = options.sessionsByRole || {};
  const seen = options.compactSeen instanceof Map ? options.compactSeen : new Map();
  const now = String(options.at || new Date().toISOString());
  const result = { usage: { ok: true, wrote: false, entries: 0 }, compacts: [], signals: [] };
  if (options.skipUsage !== true) {
    try {
      const entries = usageEntriesOfSessions({ sessions, sessionsByRole, at: now });
      if (Object.keys(entries).length) {
        const written = writeUsageTrack(projectStateDir, entries, { at: now });
        result.usage = { ok: Boolean(written.ok), wrote: Boolean(written.written), entries: written.entries || 0, file: written.file || '' };
      }
    } catch (error) {
      result.usage = { ok: false, wrote: false, entries: 0, message: String((error && error.message) || error).slice(0, 200) };
    }
  }
  if (options.detectCompact !== false) {
    for (const [role, sessionIdRaw] of Object.entries(sessionsByRole)) {
      const sessionId = String(sessionIdRaw || '');
      if (!role || !sessionId) continue;
      const session = sessions.find((s) => s && String(s.sessionId || '') === sessionId);
      const marker = compactMarkerOfSession(session);
      if (!marker) continue;
      const before = seen.get(sessionId) || null;
      seen.set(sessionId, marker);
      if (!detectCompactDelta(before, marker)) continue;
      result.compacts.push({ role, sessionId, marker });
      const signal = writeCompactSignal(teamRoot, { role, source: 'dsh-session-list', at: now });
      result.signals.push({ ok: Boolean(signal.ok), file: signal.file || '', code: signal.code || '' });
    }
  }
  return result;
}

module.exports = {
  SIGNAL_REL,
  USAGE_FILE,
  USAGE_SOURCE,
  USAGE_MAX_AGE_MS,
  compactSignalFile,
  buildCompactSignal,
  writeCompactSignal,
  readCompactSignal,
  compactMarkerOfSession,
  detectCompactDelta,
  usageOfSessionInfo,
  usageEntriesOfSessions,
  readUsageTrack,
  writeUsageTrack,
  usageFresh,
  syncSessionSideEffects,
};
