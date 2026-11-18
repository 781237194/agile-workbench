/**
 * dispatch-check.mjs —— 派单前置检查（程序门）· T-20261118-091644-6e53
 *
 * Owner 2026-11-18 09:15 明确要求：派单流程不能靠 PM 自觉，必须**程序级闭环**——
 * 换一个 PM 也必须先看目标角色的会话状态（排队数 / 已思考时长 / 停滞 / 唤醒失败）再发；skill 同步更新。
 *
 * 本模块做两件事：
 *   ① `team.mjs dispatch-check --to <role>`：聚合五源 → 给 verdict（go / go_degraded / queue / wait / wake_first / blocked）
 *      + reasons[] + 原始数字；每次调用 append 一行审计 `团队/状态/项目/<P>/派单前置检查.jsonl`。
 *   ② `assertDispatchPrecheck()`：PM 的 `send --ack`（派单）写盘前的程序门——
 *      最近 10 分钟内没有 to=该角色 且 verdict∈{go,go_degraded} 的检查 → DISPATCH_PRECHECK_REQUIRED（零写入）；
 *      最新检查 verdict ∈ {queue,wait,wake_first,blocked} → DISPATCH_BLOCKED_BY_STATE（带原因与数字）；
 *      `--force --reason "…"` 放行并在审计行记 `forced:true`（无 reason 拒：DISPATCH_FORCE_REASON_REQUIRED）。
 *
 * 五源（缺一项就显式 degraded，绝不当 0）：
 *   ① 团队/状态/会话排队.json（插件快照；staleMs 默认 120000）——known/queued/byPlacement + c9ac v2 的
 *      running/pendingInput/runningSince；v2 字段缺失 → degraded:true（不得当 0）
 *   ② presence（未读 / 未回执 / 停滞分钟 / 唤醒失败）——复用 ops.presenceFor（只读）
 *   ③ 该角色名下 working/open 任务
 *   ④ 派单锁（指向该角色 = blocked）
 *   ⑤ 最近唤醒时间（团队/状态/项目/<P>/唤醒.jsonl，项目路径优先、顶层回退）
 *
 * 判据（写死，评审/夹具按这份）：
 *   - 派单锁指向该角色 / 目标未 boot        → blocked
 *   - queued>0 或 pendingInput 非空          → queue
 *   - running 且 thinkSec<600                → wait
 *   - running 且 thinkSec≥600（可能卡住）    → wake_first
 *   - 最近活动 >15 分钟且任务/产出 mtime 无变化 → wake_first
 *   - 快照 stale/缺字段 → 降级到 presence：presence 也空闲且任务空 → go_degraded（并给原因）；
 *     否则（有未读/未回执/有任务/停滞>15 分钟）→ wake_first，**绝不给 go**
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  PATHS, fail, nowIso, readJson, exists, ensureDir, appendLine, jsonOut, textOut, truncate,
} from './core.mjs';
import { loadProject, projectStatePaths, listTasks, loadTeam, activeMembers, requireBoot } from './store.mjs';
import { ROLE_DIRS, ROLE_NAMES } from './roles.mjs';

/* ── 常量（口径写死，评审按这里核） ───────────────────────────────────── */
export const SNAPSHOT_FILE = '会话排队.json';
export const SNAPSHOT_STALE_MS = 120000;
export const AUDIT_NAME = '派单前置检查.jsonl';
export const PRECHECK_TTL_MS = 10 * 60 * 1000;      // 程序门：只认最近 10 分钟内的检查
export const THINK_WAIT_SEC = 600;                   // running 且已思考 <600 秒 → wait
export const IDLE_WAKE_MIN = 15;                     // 15 分钟无活动且无产出变化 → wake_first
export const VERDICTS = ['go', 'go_degraded', 'queue', 'wait', 'wake_first', 'blocked'];
export const GO_VERDICTS = ['go', 'go_degraded'];

/* ── 路径 ─────────────────────────────────────────────────────────────── */
export function snapshotPath() { return path.join(PATHS.state, SNAPSHOT_FILE); }
export function auditPathFor(projectName) { return path.join(projectStatePaths(projectName).dir, AUDIT_NAME); }
function dispatchLockFile(projectName) { return path.join(projectStatePaths(projectName).dir, '派单锁.json'); }
function projectWakeLedger(projectName) { return path.join(projectStatePaths(projectName).dir, '唤醒.jsonl'); }
function teamWakeLedger() { return path.join(PATHS.state, '唤醒.jsonl'); }

function readJsonlTail(file, cap = 400) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-cap).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function msOf(v) { const n = Date.parse(String(v || '')); return Number.isFinite(n) ? n : null; }

/* ── ① 会话排队快照 ───────────────────────────────────────────────────── */
/**
 * 读 `团队/状态/会话排队.json`（只读）。返回 { exists, at, staleMs, fileAgeMs, stale, degraded, row, roleCount }。
 * 字段缺失 ≠ 0：v2 字段（running/pendingInput/runningSince）缺失时 `degraded` 写明原因。
 */
export function readQueueSnapshot({ projectName = '', now = Date.now() } = {}) {
  const file = snapshotPath();
  const out = { file, exists: false, at: '', staleMs: SNAPSHOT_STALE_MS, fileAgeMs: null, stale: false, degraded: '', row: null, rowKnown: false, v2: false };
  if (!exists(file)) { out.degraded = `${SNAPSHOT_FILE} 缺失（DSH 插件未上报）`; return out; }
  const data = readJson(file, null);
  if (!data || typeof data !== 'object') { out.degraded = `${SNAPSHOT_FILE} 不可解析`; return out; }
  out.exists = true;
  out.at = String(data.at || '');
  const staleMs = Number(data.staleMs);
  out.staleMs = Number.isFinite(staleMs) && staleMs > 0 ? staleMs : SNAPSHOT_STALE_MS;
  const atMs = msOf(out.at);
  out.fileAgeMs = atMs === null ? null : Math.max(0, now - atMs);
  out.stale = atMs === null || out.fileAgeMs >= out.staleMs;
  const rows = Array.isArray(data.roles) ? data.roles : [];
  if (projectName && data.project && String(data.project) !== String(projectName)) {
    out.degraded = `快照属于项目 ${data.project}，不是 ${projectName}`;
  }
  return { ...out, rows, roleCount: rows.length };
}

/** 取某角色的快照行 + v2 字段可用性。 */
export function snapshotRowOf(snapshot, role) {
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
  const row = rows.find((r) => r && String(r.role) === String(role)) || null;
  if (!row) return { row: null, known: false, v2: false, reason: '快照里没有该角色行' };
  const hasV2 = Object.prototype.hasOwnProperty.call(row, 'running')
    && Object.prototype.hasOwnProperty.call(row, 'pendingInput')
    && Object.prototype.hasOwnProperty.call(row, 'runningSince');
  return { row, known: row.known !== false, v2: hasV2, reason: hasV2 ? '' : '快照缺 c9ac v2 字段（running/pendingInput/runningSince）' };
}

/* ── ④ 派单锁 ─────────────────────────────────────────────────────────── */
export function readDispatchLockState(projectName, now = Date.now()) {
  const file = dispatchLockFile(projectName);
  if (!exists(file)) return { exists: false, active: false, lockBy: '', lock: null, expired: false };
  const lock = readJson(file, null);
  if (!lock || typeof lock !== 'object') return { exists: true, active: false, lockBy: '', lock: null, expired: true };
  const exp = msOf(lock.expiresAt);
  const expired = exp !== null && exp <= now;
  return { exists: true, active: !expired, lockBy: expired ? '' : String(lock.to || ''), lock, expired };
}

/* ── ⑤ 最近唤醒 ───────────────────────────────────────────────────────── */
export function latestWakeOf(projectName, role, cap = 400) {
  const rows = readJsonlTail(projectWakeLedger(projectName), cap);
  const fallback = rows.length ? [] : readJsonlTail(teamWakeLedger(), cap);
  const all = rows.length ? rows : fallback;
  let best = null;
  for (const r of all) {
    if (!r || String(r.to || '') !== String(role)) continue;
    const at = String(r.at || r.time || '');
    const ms = msOf(at);
    if (ms === null) continue;
    if (!best || ms > best.ms) best = { at, ms, ok: r.ok !== false, skipped: String(r.skipped || ''), reason: String(r.reason || ''), source: rows.length ? '项目' : '顶层' };
  }
  return best || { at: '', ms: null, ok: null, skipped: '', reason: '', source: '' };
}

/* ── ② presence（复用 ops.presenceFor，只读；动态 import 避免循环依赖） ── */
export async function presenceOf(projectName, role) {
  try {
    const ops = await import('./ops.mjs');
    const rows = ops.presenceFor(projectName, { roles: [role] });
    return (rows && rows[0]) || null;
  } catch (e) {
    return { role, unread: null, ackPending: null, stalledMin: null, wakeFailed: null, why: String((e && e.message) || e) };
  }
}

/* ── ③ 任务 + 产出 mtime ──────────────────────────────────────────────── */
export function roleTaskStats(projectName, role) {
  const tasks = (() => { try { return listTasks(projectName) || []; } catch { return []; } })();
  const mine = tasks.filter((t) => t && String(t.owner || '') === String(role));
  const working = mine.filter((t) => String(t.status || '') === 'working');
  const open = mine.filter((t) => String(t.status || '') === 'open');
  const stamps = mine
    .map((t) => msOf(t.updatedAt || t.claimedAt || t.createdAt || ''))
    .filter((n) => Number.isFinite(n));
  return {
    working: working.map((t) => t.id),
    open: open.map((t) => t.id),
    count: working.length + open.length,
    lastTaskAtMs: stamps.length ? Math.max(...stamps) : null,
  };
}

export function latestOutputMtime(projectName, role) {
  try {
    const project = loadProject(projectName);
    const dir = path.join(project.path, ROLE_DIRS[role] || role, '产出');
    if (!exists(dir)) return null;
    let max = 0;
    let n = 0;
    for (const name of fs.readdirSync(dir)) {
      if (n >= 300) break;
      const abs = path.join(dir, name);
      try {
        const st = fs.statSync(abs);
        if (st.isFile()) { n += 1; if (st.mtimeMs > max) max = st.mtimeMs; }
      } catch { /* 单个文件 stat 失败忽略 */ }
    }
    return max || null;
  } catch { return null; }
}

/** 目标是否已 boot（有有效启动令牌）。动态 import 避免与 ops/auto-boot 形成静态环。 */
export async function bootStateOf(projectName, role) {
  try {
    const ab = await import('./auto-boot.mjs');
    const tok = ab.findValidBootToken(projectName, role, '');
    return { booted: Boolean(tok), tokenId: tok ? String(tok.tokenId || '').slice(0, 8) : '', sessionId: tok ? String(tok.sessionId || '') : '', why: '' };
  } catch (e) {
    return { booted: null, tokenId: '', sessionId: '', why: String((e && e.message) || e) };
  }
}

/* ── 判定本体（纯逻辑，夹具可直接调） ─────────────────────────────────── */
/**
 * @returns {{verdict, reasons, numbers, degraded, snapshotAt, snapshotStale, inputs}}
 */
export function decideVerdict(input) {
  const {
    role, now, snapshot, snapRow, lock, boot, presence, tasks, wake, outMtime,
  } = input;
  const reasons = [];
  const numbers = {
    queued: null, thinkSec: null, lastAt: wake && wake.at ? wake.at : '', lastAtMs: wake ? wake.ms : null,
    staleMs: snapshot.staleMs, snapshotAgeSec: snapshot.fileAgeMs === null ? null : Math.round(snapshot.fileAgeMs / 1000),
    lockBy: lock.lockBy || '', booted: boot.booted === true, pendingInputCount: null, workingTasks: tasks.working.length, openTasks: tasks.open.length,
    unread: presence ? presence.unread : null, ackPending: presence ? presence.ackPending : null, stalledMin: presence ? presence.stalledMin : null,
  };
  // 降级原因（结构性问题，先收集，不改变 blocked 判定）
  const degradedReasons = [];
  if (snapshot.degraded) degradedReasons.push(snapshot.degraded);
  if (snapshot.stale) degradedReasons.push(`快照过期：at=${snapshot.at || '(空)'}，距现在 ${numbers.snapshotAgeSec === null ? '未知' : numbers.snapshotAgeSec + 's'} ≥ ${Math.round(snapshot.staleMs / 1000)}s`);
  if (!snapRow.known) degradedReasons.push(snapRow.reason || '快照无该角色行');
  else if (!snapRow.v2) degradedReasons.push(snapRow.reason);
  const degraded = degradedReasons.length ? degradedReasons.join('；') : '';

  // 数字（能用就用，缺就 null——绝不当 0）
  const row = snapRow.row || {};
  const queued = Number.isFinite(Number(row.queued)) ? Number(row.queued) : null;
  numbers.queued = queued;
  if (row.byPlacement && typeof row.byPlacement === 'object') numbers.byPlacement = row.byPlacement;
  const pendingInput = Array.isArray(row.pendingInput) ? row.pendingInput : null;
  numbers.pendingInputCount = pendingInput ? pendingInput.length : null;
  const running = typeof row.running === 'boolean' ? row.running : null;
  const runningSinceMs = msOf(row.runningSince);
  const thinkSec = running && runningSinceMs !== null ? Math.max(0, Math.round((now - runningSinceMs) / 1000)) : null;
  numbers.thinkSec = thinkSec;
  numbers.running = running;
  numbers.pendingInput = pendingInput;

  // ① blocked：派单锁 / 未 boot
  if (lock.active && String(lock.lockBy) === String(role)) {
    reasons.push(`派单锁在 ${ROLE_NAMES[role] || role}：${String((lock.lock || {}).messageId || '(未记 id)')}（${truncate(String((lock.lock || {}).subject || ''), 40)}）未回执，先等回执或清理锁`);
    return { verdict: 'blocked', reasons, numbers, degraded, snapshotAt: snapshot.at, snapshotStale: snapshot.stale };
  }
  if (boot.booted === false) {
    reasons.push(`目标未 boot（没有有效启动令牌）：先 node 团队\\工具\\team.mjs boot --role ${role}，或让 auto-boot 拉起`);
    return { verdict: 'blocked', reasons, numbers, degraded, snapshotAt: snapshot.at, snapshotStale: snapshot.stale };
  }
  if (boot.booted === null) {
    reasons.push(`无法判定 boot 状态（${boot.why || '未知'}）：按 blocked 处理，不冒险派单`);
    return { verdict: 'blocked', reasons, numbers, degraded, snapshotAt: snapshot.at, snapshotStale: snapshot.stale };
  }

  // ② queue：排队 / 等审批
  if (queued !== null && queued > 0) {
    reasons.push(`会话排队 ${queued} 条（byPlacement=${JSON.stringify(row.byPlacement || {})}）：先等队列消化再派`);
    return { verdict: 'queue', reasons, numbers, degraded, snapshotAt: snapshot.at, snapshotStale: snapshot.stale };
  }
  if (pendingInput && pendingInput.length) {
    reasons.push(`目标有未处理输入（pendingInput=${pendingInput.join('/')}）：它正卡在审批/提问，派单会被叠在后面`);
    return { verdict: 'queue', reasons, numbers, degraded, snapshotAt: snapshot.at, snapshotStale: snapshot.stale };
  }

  // ③ wait / wake_first：正在思考
  if (running === true) {
    if (thinkSec === null) {
      reasons.push('running=true 但缺 runningSince，无法算已思考时长：按 wait 处理（可先看 presence 再决定）');
      return { verdict: 'wait', reasons, numbers, degraded, snapshotAt: snapshot.at, snapshotStale: snapshot.stale };
    }
    if (thinkSec < THINK_WAIT_SEC) {
      reasons.push(`running=true，已思考 ${thinkSec}s < ${THINK_WAIT_SEC}s：等它把这一轮跑完再派`);
      return { verdict: 'wait', reasons, numbers, degraded, snapshotAt: snapshot.at, snapshotStale: snapshot.stale };
    }
    reasons.push(`running=true，已思考 ${thinkSec}s ≥ ${THINK_WAIT_SEC}s：可能卡住，先唤醒/确认再派`);
    return { verdict: 'wake_first', reasons, numbers, degraded, snapshotAt: snapshot.at, snapshotStale: snapshot.stale };
  }

  // 降级/未知：用 presence 兜底，绝不直接 go
  const idleSignals = presence && presence.unread === 0 && presence.ackPending === 0 && presence.wakeFailed !== true;
  const hasWork = tasks.count > 0;
  if (degraded) {
    if (presence && (presence.unread > 0 || presence.ackPending > 0)) {
      reasons.push(`快照不可用（${degraded}），presence 有未读 ${presence.unread} / 未回执 ${presence.ackPending}：先唤醒清消息`);
      return { verdict: 'wake_first', reasons, numbers, degraded, snapshotAt: snapshot.at, snapshotStale: snapshot.stale };
    }
    if (hasWork) {
      reasons.push(`快照不可用（${degraded}），但该角色名下仍有 ${tasks.count} 条未完成（working ${tasks.working.length} / open ${tasks.open.length}）：先确认在办状态`);
      return { verdict: 'wake_first', reasons, numbers, degraded, snapshotAt: snapshot.at, snapshotStale: snapshot.stale };
    }
    if (idleSignals) {
      reasons.push(`快照不可用（${degraded}），但 presence 无未读/未回执且任务为空：按空闲放行（降级判定）`);
      return { verdict: 'go_degraded', reasons, numbers, degraded, snapshotAt: snapshot.at, snapshotStale: snapshot.stale };
    }
    reasons.push(`快照不可用（${degraded}），presence 不足以证明空闲：先看一次 presence / 唤醒再派`);
    return { verdict: 'wake_first', reasons, numbers, degraded, snapshotAt: snapshot.at, snapshotStale: snapshot.stale };
  }

  // ④ wake_first：长时间无活动且任务/产出都没动
  const lastMs = Math.max(
    Number.isFinite(wake.ms) ? wake.ms : 0,
    msOf(presence && presence.lastActivityAt) || 0,
    tasks.lastTaskAtMs || 0,
    outMtime || 0,
  );
  numbers.lastActivityAt = lastMs ? new Date(lastMs).toISOString() : '';
  numbers.outputMtime = outMtime ? new Date(outMtime).toISOString() : '';
  if (Number.isFinite(wake.ms) && wake.ms) {
    const idleMin = Math.round((now - Math.max(wake.ms, tasks.lastTaskAtMs || 0, outMtime || 0)) / 60000);
    if (idleMin > IDLE_WAKE_MIN) {
      reasons.push(`最近唤醒 ${wake.at}（${wake.ok ? '成功' : '失败'}）距今 ${idleMin} 分钟，期间任务/产出 mtime 无变化：先唤醒确认它还在，再派`);
      return { verdict: 'wake_first', reasons, numbers, degraded, snapshotAt: snapshot.at, snapshotStale: snapshot.stale };
    }
  }
  if (presence && presence.wakeFailed) {
    reasons.push(`该角色有唤醒失败记录（${presence.wakeFailedReason || presence.wakeFailedAt || '未知'}）：先修唤醒通道再派`);
    return { verdict: 'wake_first', reasons, numbers, degraded, snapshotAt: snapshot.at, snapshotStale: snapshot.stale };
  }
  reasons.push('快照新鲜、排队 0、pendingInput 空、未在 running、无派单锁、已 boot：可以派单');
  return { verdict: 'go', reasons, numbers, degraded, snapshotAt: snapshot.at, snapshotStale: snapshot.stale };
}

/** 聚合五源 + 判定（异步：presence/boot 需要动态 import）。 */
export async function buildDispatchCheck({ projectName, to, now = Date.now() } = {}) {
  const name = String(projectName || '');
  const role = String(to || '');
  if (!name) fail('NO_PROJECT', '需要项目名');
  if (!role) fail('BAD_TO', '需要 --to <角色>');
  const snapshot = readQueueSnapshot({ projectName: name, now });
  const snapRow = snapshotRowOf(snapshot, role);
  const lock = readDispatchLockState(name, now);
  const presence = await presenceOf(name, role);
  const tasks = roleTaskStats(name, role);
  const wake = latestWakeOf(name, role);
  const outMtime = latestOutputMtime(name, role);
  const boot = await bootStateOf(name, role);
  const decided = decideVerdict({ role, now, snapshot, snapRow, lock, boot, presence, tasks, wake, outMtime });
  return {
    ok: true, project: name, to: role, name: ROLE_NAMES[role] || role,
    at: nowIso(), ...decided,
    inputs: {
      snapshot: { file: snapshot.file, exists: snapshot.exists, at: snapshot.at, staleMs: snapshot.staleMs, stale: snapshot.stale, degraded: snapshot.degraded },
      snapshotRow: snapRow.row ? { known: snapRow.row.known, queued: snapRow.row.queued, byPlacement: snapRow.row.byPlacement, running: snapRow.row.running, pendingInput: snapRow.row.pendingInput, runningSince: snapRow.row.runningSince, stale: snapRow.row.stale, lastOkAt: snapRow.row.lastOkAt } : null,
      lock: { exists: lock.exists, active: lock.active, lockBy: lock.lockBy, messageId: (lock.lock || {}).messageId || '', subject: (lock.lock || {}).subject || '', expired: lock.expired },
      boot: { booted: boot.booted, tokenId: boot.tokenId, sessionId: boot.sessionId, why: boot.why },
      presence,
      tasks: { working: tasks.working, open: tasks.open, count: tasks.count, lastTaskAt: tasks.lastTaskAtMs ? new Date(tasks.lastTaskAtMs).toISOString() : '' },
      wake,
      outputMtime: outMtime ? new Date(outMtime).toISOString() : '',
    },
  };
}

/* ── 审计 + 程序门 ────────────────────────────────────────────────────── */
export function recordDispatchCheck(row, { forced = false } = {}) {
  const at = row.at || nowIso();
  const line = {
    at, event: 'dispatch_precheck', by: row.by || '', to: row.to, project: row.project,
    verdict: row.verdict, reasons: row.reasons || [],
    snapshotAt: row.snapshotAt || '', snapshotStale: Boolean(row.snapshotStale),
    degraded: row.degraded || '', queued: row.numbers ? row.numbers.queued : null,
    thinkSec: row.numbers ? row.numbers.thinkSec : null, lockBy: row.numbers ? row.numbers.lockBy : '',
    ...(forced ? { forced: true, forcedReason: String(row.forceReason || '').slice(0, 200) } : {}),
  };
  try {
    const file = auditPathFor(row.project);
    ensureDir(path.dirname(file));
    appendLine(file, JSON.stringify(line));
  } catch { /* 审计写失败不阻断判定本身（但下面程序门会再提示） */ }
  return line;
}

/** 最近一次检查（只看 to 匹配且 withinMs 内）。 */
export function latestCheckFor(projectName, to, { withinMs = PRECHECK_TTL_MS, now = Date.now() } = {}) {
  const rows = readJsonlTail(auditPathFor(projectName), 600)
    .filter((r) => r && String(r.to || '') === String(to));
  let best = null;
  for (const r of rows) {
    const ms = msOf(r.at);
    if (ms === null) continue;
    if (now - ms > withinMs) continue;
    if (!best || ms > best.ms) best = { ...r, ms };
  }
  return best;
}

/** 沙盘豁免：TEAM_SELFTEST=1 默认不强制；门禁本体用 TEAM_DISPATCH_PRECHECK_ENFORCE=1 强制（与既有门套路一致）。 */
export function precheckExempt() {
  return String(process.env.TEAM_SELFTEST || '') === '1' && String(process.env.TEAM_DISPATCH_PRECHECK_ENFORCE || '') !== '1';
}

/**
 * 程序门（PM send --ack 专用）：不通过直接 fail（**零写入**——本函数只读+追加审计）。
 * 返回 { skipped?, forced?, check? }。
 */
export function assertDispatchPrecheck({ projectName, to, force = false, reason = '', by = 'pm' } = {}) {
  if (precheckExempt()) return { skipped: 'SELFTEST' };
  const name = String(projectName || '');
  const role = String(to || '');
  const latest = latestCheckFor(name, role);
  const hint = `node 团队\\工具\\team.mjs dispatch-check --boot <PM令牌> --project "${name}" --to ${role}`;
  if (!latest) {
    fail('DISPATCH_PRECHECK_REQUIRED',
      `派单前必须先跑派单前置检查（最近 10 分钟内没有 to=${role} 的检查记录）：${hint}；verdict=go 才发；确需强制加 --force --reason "…"`,
      { to: role, project: name, wrote: false, ttlMs: PRECHECK_TTL_MS, hint });
  }
  if (GO_VERDICTS.includes(String(latest.verdict || ''))) {
    return { check: latest };
  }
  if (force) {
    if (!String(reason || '').trim()) {
      fail('DISPATCH_FORCE_REASON_REQUIRED',
        `--force 必须带 --reason "为什么在 ${latest.verdict} 状态下仍要派"（会记 forced:true 审计）`,
        { to: role, verdict: latest.verdict, wrote: false });
    }
    const line = recordDispatchCheck({ ...latest, at: nowIso(), by, project: name, to: role, forceReason: reason }, { forced: true });
    return { forced: true, check: latest, audit: line };
  }
  fail('DISPATCH_BLOCKED_BY_STATE',
    `派单前置检查判 ${latest.verdict}，不允许直接派：${(latest.reasons || []).join('；')}。先按提示处置（等队列/等这一轮/先唤醒/清锁），或 --force --reason "…" 强制并留痕`,
    {
      to: role, project: name, wrote: false, verdict: latest.verdict, reasons: latest.reasons || [],
      numbers: { queued: latest.queued, thinkSec: latest.thinkSec, lockBy: latest.lockBy },
      snapshotAt: latest.snapshotAt, snapshotStale: latest.snapshotStale, degraded: latest.degraded,
      checkedAt: latest.at, hint,
    });
}

/* ── CLI：team.mjs dispatch-check --to <role> [--json] [--require] ─────── */
export async function cmdDispatchCheck(args) {
  const boot = requireBoot(String(args.boot || ''));
  const projectName = String(args.project || boot.project || '');
  if (!projectName) fail('NO_PROJECT', '需要 --project（或先 boot 到某个项目）');
  const to = String(args.to || '');
  if (!to) fail('BAD_TO', '需要 --to <角色>（例如 --to programmer2）');
  const roleIds = (() => { try { return activeMembers(loadTeam()).map((m) => m.role); } catch { return []; } })();
  if (roleIds.length && !roleIds.includes(to)) {
    fail('BAD_ROLE', `团队里没有角色 ${to}（现有：${roleIds.join(' / ')}）`, { to, roles: roleIds });
  }
  const row = await buildDispatchCheck({ projectName, to });
  row.by = String(boot.role || '');
  const audit = recordDispatchCheck(row);
  const human = [
    `派单前置检查 · ${projectName} → ${ROLE_NAMES[to] || to}`,
    `verdict：${row.verdict}${row.verdict === 'go' || row.verdict === 'go_degraded' ? '（可以派）' : '（先别派）'}`,
    `数字：排队 ${row.numbers.queued === null ? '未知' : row.numbers.queued} ｜ 已思考 ${row.numbers.thinkSec === null ? '—' : row.numbers.thinkSec + 's'} ｜ 最近唤醒 ${row.numbers.lastAt || '无'} ｜ 快照龄 ${row.numbers.snapshotAgeSec === null ? '未知' : row.numbers.snapshotAgeSec + 's'}/${Math.round(row.numbers.staleMs / 1000)}s ｜ 派单锁 ${row.numbers.lockBy || '无'}`,
    row.degraded ? `降级：${row.degraded}` : '降级：无',
    ...row.reasons.map((r) => `· ${r}`),
    `审计：${auditPathFor(projectName)}`,
  ].join('\n');
  if (args.require && !GO_VERDICTS.includes(row.verdict)) {
    if (args.json) jsonOut({ ...row, audit });
    else textOut(human);
    fail('DISPATCH_CHECK_NOT_GO', `派单前置检查判 ${row.verdict}：${row.reasons.join('；')}`, { verdict: row.verdict, reasons: row.reasons, numbers: row.numbers, degraded: row.degraded });
  }
  if (args.json) jsonOut({ ...row, audit });
  else textOut(human);
  return row;
}

export default { buildDispatchCheck, decideVerdict, assertDispatchPrecheck, latestCheckFor, cmdDispatchCheck };
