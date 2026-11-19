'use strict';
/**
 * R-20261119-140657-a1eb（T-20261119-141958-16dd，壳层侧）：名册变化 → **一次**推送。
 *
 * 背景（为什么需要这个模块）：
 *  - 工具层批量换人（`session rotate --batch`）契约是「一次事务写名册 → 一次广播 → N 条 BQ」；
 *  - 壳层侧旧实现**根本没有名册 watch**：六角色面板/会话映射只能等 5 秒轮询（app.js ROSTER_WATCH_MS），
 *    换一批人之后界面要等下一拍，而且拍内各自重画，做不到「换一批只刷新一次」；
 *  - 直接把 fs.watch 事件直连推送又会“按事件数推送”（原子写 tmp+rename、工具层多次落盘都算一次），
 *    于是界面被刷 N 次 —— 与契约「只刷新一次」相反。
 *
 * 口径（写死，来自需求 §6.1）：名册签名只含 角色 / 会话 / 状态 三字段
 *   `sha256(JSON(members.map(m => ({role, sessionId, status}))))`
 *   —— 昵称、备注、bootedAt 等变化不触发；签名相同的事件一律丢弃（skippedUnchanged）。
 *
 * 合并窗口：静默 quietMs（默认 250ms）内的事件合成一次 flush；最迟 maxWaitMs（默认 1200ms）必 flush，
 * 保证「一直在写」也不会把推送无限推迟。
 *
 * 纯 Node、无 Electron 依赖：main.js 只负责接线，单测见 scripts/test-a1eb-shell-roster-push.cjs。
 */

const crypto = require('node:crypto');

const DEFAULT_QUIET_MS = 250;
const DEFAULT_MAX_WAIT_MS = 1200;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 名册三字段归一（唯一口径）；缺 status 视为 active。 */
function rosterRows(team) {
  const members = team && Array.isArray(team.members) ? team.members : [];
  return members.map((m) => ({
    role: String((m && m.role) || ''),
    sessionId: String((m && m.sessionId) || ''),
    status: String((m && m.status) || 'active'),
  }));
}

/** 名册签名（= 需求 §6.1 的 rosterVersion 定义；壳层只用来做「变了没有」判定，不冒充令牌字段）。 */
function rosterSignature(team) {
  const payload = rosterRows(team).map((row) => ({ role: row.role, sessionId: row.sessionId, status: row.status }));
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** 两次名册之间真正变了的角色（新增/删除/会话或状态变化都算）。 */
function changedRoles(beforeRows, afterRows) {
  const before = new Map((Array.isArray(beforeRows) ? beforeRows : []).map((row) => [String(row.role || ''), `${row.sessionId}\u0000${row.status}`]));
  const after = new Map((Array.isArray(afterRows) ? afterRows : []).map((row) => [String(row.role || ''), `${row.sessionId}\u0000${row.status}`]));
  const roles = [];
  for (const [role, sig] of after) {
    if (!before.has(role) || before.get(role) !== sig) roles.push(role);
  }
  for (const role of before.keys()) {
    if (!after.has(role)) roles.push(role);
  }
  return roles.filter(Boolean);
}

/**
 * 名册推送合并器。
 * @param {object} options
 * @param {Function} options.readTeam 读当前名册对象（同步；抛错=读失败，不推）
 * @param {Function} options.emit 推送回调（只在签名真变化时调用一次）
 * @param {number} [options.quietMs] 静默窗口
 * @param {number} [options.maxWaitMs] 最长等待（保证持续写入也会 flush）
 * @param {Function} [options.now] 可注入时钟（单测）
 * @param {Function} [options.setTimeout] / [options.clearTimeout] 可注入定时器（单测）
 * @param {Function} [options.onError] 读失败/推送异常回调（只留痕，不抛出）
 */
function createRosterPushController(options = {}) {
  const quietMs = Math.max(0, Math.min(5000, num(options.quietMs, DEFAULT_QUIET_MS)));
  const maxWaitMs = Math.max(quietMs, Math.min(30000, num(options.maxWaitMs, DEFAULT_MAX_WAIT_MS)));
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const setT = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearT = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const readTeam = typeof options.readTeam === 'function' ? options.readTeam : () => null;
  const emit = typeof options.emit === 'function' ? options.emit : () => {};
  const onError = typeof options.onError === 'function' ? options.onError : () => {};

  const stats = {
    fileEvents: 0,
    collapsedEvents: 0,
    flush: 0,
    broadcast: 0,
    skippedUnchanged: 0,
    readFailed: 0,
    lastAt: '',
    lastRoles: [],
    quietMs,
    maxWaitMs,
  };
  let timer = null;
  let firstEventAt = 0;
  let lastSignature = '';
  let lastRows = [];
  let disposed = false;

  function cancel() {
    if (timer) { try { clearT(timer); } catch { /* ignore */ } timer = null; }
    firstEventAt = 0;
  }

  /** 以盘上当前名册做基线（启动/建 watch 时调用），之后只有真变化才推。 */
  function seed(team) {
    if (!team || typeof team !== 'object') return { ok: false, code: 'SEED_EMPTY' };
    lastSignature = rosterSignature(team);
    lastRows = rosterRows(team);
    return { ok: true, signature: lastSignature, rows: lastRows.length };
  }

  /** 立即结算（单测/关停用）：不受窗口影响。 */
  function flush() {
    if (timer) { try { clearT(timer); } catch { /* ignore */ } }
    timer = null;
    firstEventAt = 0;
    stats.flush += 1;
    let team = null;
    try {
      team = readTeam();
    } catch (error) {
      stats.readFailed += 1;
      onError(error);
      return { ok: false, code: 'ROSTER_READ_FAILED', message: String((error && error.message) || error).slice(0, 200) };
    }
    if (!team || typeof team !== 'object') {
      stats.readFailed += 1;
      onError(new Error('名册读不到（团队/状态/团队.json 缺失或不是对象）'));
      return { ok: false, code: 'ROSTER_EMPTY' };
    }
    const signature = rosterSignature(team);
    const rows = rosterRows(team);
    if (signature === lastSignature) {
      // 关键口径：内容没变的事件不算一次变更（原子写的 tmp/rename、重复落盘都会走到这里）。
      stats.skippedUnchanged += 1;
      return { ok: true, code: 'ROSTER_UNCHANGED', signature };
    }
    const roles = changedRoles(lastRows, rows);
    lastSignature = signature;
    lastRows = rows;
    stats.broadcast += 1;
    stats.lastAt = new Date(now()).toISOString();
    stats.lastRoles = roles;
    const info = { signature, roles, at: stats.lastAt, stats: { ...stats } };
    try {
      emit(info);
    } catch (error) {
      onError(error);
    }
    return { ok: true, code: 'ROSTER_BROADCAST', ...info };
  }

  /** 每次 fs 事件调用：合并到窗口里，只 flush 一次。 */
  function poke() {
    if (disposed) return { ok: false, code: 'DISPOSED' };
    stats.fileEvents += 1;
    if (timer) {
      stats.collapsedEvents += 1;
      try { clearT(timer); } catch { /* ignore */ }
      timer = null;
    }
    if (!firstEventAt) firstEventAt = now();
    const elapsed = Math.max(0, now() - firstEventAt);
    const wait = Math.max(0, Math.min(quietMs, maxWaitMs - elapsed));
    timer = setT(() => { flush(); }, wait);
    return { ok: true, code: 'ROSTER_POKE', wait };
  }

  function dispose() {
    disposed = true;
    cancel();
  }

  return {
    seed,
    poke,
    flush,
    dispose,
    stats: () => ({ ...stats, lastRoles: [...stats.lastRoles] }),
    signature: () => lastSignature,
    rows: () => lastRows.map((row) => ({ ...row })),
    pending: () => Boolean(timer),
  };
}

module.exports = {
  DEFAULT_QUIET_MS,
  DEFAULT_MAX_WAIT_MS,
  rosterRows,
  rosterSignature,
  changedRoles,
  createRosterPushController,
};
