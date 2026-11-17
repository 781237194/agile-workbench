'use strict';
/**
 * B-20261117-133419-6543：看板后台重建（去抖 + 同项目合并），把「验收落账后同步等 generateBoard」
 * 从 IPC 主链路里拿出去。
 *
 * 口径：
 *   ① 同一项目在 debounce 窗口内多次触发 → **只重建一次**（coalesced 计数留痕）；
 *   ② schedule() 立即返回，不等 generateBoard（IPC 不再被 3.4s 拖住）；
 *   ③ 重建成功/失败都回调 onDone（主进程据此写审计 + 广播 board:rebuilt，失败不静默）；
 *   ④ 纯逻辑：generateBoard / 定时器 / 时钟全部注入，Node 可直接测（见 scripts/test-board-rebuild.cjs）。
 */

function projectNameOf(project) {
  if (!project) return '';
  if (typeof project === 'string') return project.trim();
  return String(project.teamName || project.name || '').trim();
}

function createBoardRebuild(options = {}) {
  const generateBoard = typeof options.generateBoard === 'function' ? options.generateBoard : null;
  const debounceMs = Number.isFinite(Number(options.debounceMs)) && Number(options.debounceMs) >= 0
    ? Number(options.debounceMs) : 600;
  const onDone = typeof options.onDone === 'function' ? options.onDone : () => {};
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;
  const pending = new Map(); // name -> { project, reason, coalesced, queuedAt, timer }
  const stats = { scheduled: 0, coalesced: 0, runs: 0, ok: 0, failed: 0, lastRunMs: 0 };

  function schedule(project, reason) {
    const name = projectNameOf(project);
    if (!name) return { queued: false, code: 'NO_PROJECT', message: '没有项目名，无法排队重建看板' };
    if (!generateBoard) return { queued: false, code: 'NO_GENERATOR', message: '没有 generateBoard 实现' };
    const existing = pending.get(name);
    if (existing) {
      existing.reason = String(reason || existing.reason || 'accept');
      existing.coalesced += 1;
      stats.coalesced += 1;
      return { queued: true, coalesced: true, project: name, debounceMs, coalescedCount: existing.coalesced };
    }
    const entry = { project, reason: String(reason || 'accept'), coalesced: 0, queuedAt: now(), timer: null };
    entry.timer = setTimer(() => { void run(name); }, debounceMs);
    if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
    pending.set(name, entry);
    stats.scheduled += 1;
    return { queued: true, coalesced: false, project: name, debounceMs };
  }

  async function run(name) {
    const key = projectNameOf(name);
    const entry = pending.get(key);
    if (!entry) return null;
    pending.delete(key);
    if (entry.timer) { try { clearTimer(entry.timer); } catch { /* 已触发时忽略 */ } }
    const started = now();
    let payload;
    try {
      const result = await generateBoard(entry.project);
      payload = {
        ok: !(result && result.ok === false),
        project: key,
        reason: entry.reason,
        coalesced: entry.coalesced,
        ms: Math.max(0, now() - started),
        at: new Date(now()).toISOString(),
        path: String((result && (result.boardPath || result.path)) || ''),
        message: result && result.ok === false ? String(result.message || result.why || '看板重建失败') : '',
      };
    } catch (error) {
      payload = {
        ok: false,
        project: key,
        reason: entry.reason,
        coalesced: entry.coalesced,
        ms: Math.max(0, now() - started),
        at: new Date(now()).toISOString(),
        path: '',
        message: String((error && error.message) || error).slice(0, 300),
      };
    }
    stats.runs += 1;
    stats.lastRunMs = payload.ms;
    if (payload.ok) stats.ok += 1; else stats.failed += 1;
    try { onDone(payload); } catch { /* 回调失败不影响主流程 */ }
    return payload;
  }

  function pendingNames() { return [...pending.keys()]; }
  function statsSnapshot() { return { ...stats, pending: pending.size, debounceMs }; }

  return { schedule, run, pendingNames, stats: statsSnapshot, debounceMs };
}

module.exports = { createBoardRebuild, projectNameOf };
