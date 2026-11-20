'use strict';
/**
 * a514：工作流「重量级副作用」后台队列（可单测，纯 Node，不依赖 Electron）。
 *
 * 语义：
 *  - schedule(ctx)：同 projectId 的请求合并；debounceMs 内多次只跑一次；
 *  - 运行中再来的请求标记 pending，本轮跑完再跑一次（合并）；
 *  - 失败按 retries 退避重试；用尽后 emit({ok:false,...}) 让界面可见并可手动重试；
 *  - 每次尝试都 audit（成功/失败），便于「为什么没生效」回查；
 *  - status() 返回队列快照（running/pending/attempts/reason）。
 */
function createWorkflowSideEffects({ run, audit = () => {}, emit = () => {}, debounceMs = 250, retries = 2, retryDelayMs = 800 } = {}) {
  if (typeof run !== 'function') throw new Error('createWorkflowSideEffects 需要 run 函数');
  const queues = new Map(); // projectId -> state

  const stateOf = (projectId) => {
    let state = queues.get(projectId);
    if (!state) {
      state = { timer: null, retryTimer: null, running: false, pending: false, attempts: 0, ctx: null, lastResult: null };
      queues.set(projectId, state);
    }
    return state;
  };

  const attempt = async (state) => {
    const ctx = state.ctx;
    const started = Date.now();
    try {
      const value = await run(ctx);
      const payload = { ok: true, projectId: ctx.projectId, reason: ctx.reason, ms: Date.now() - started, at: new Date().toISOString(), value: value === undefined ? null : value };
      state.lastResult = payload;
      audit({ kind: 'side_effect', ...payload });
      emit(payload);
      return payload;
    } catch (error) {
      const payload = { ok: false, projectId: ctx.projectId, reason: ctx.reason, ms: Date.now() - started, at: new Date().toISOString(), message: String((error && error.message) || error).slice(0, 300) };
      state.lastResult = payload;
      audit({ kind: 'side_effect_failed', attempt: state.attempts + 1, ...payload });
      if (state.attempts < retries) {
        state.attempts += 1;
        state.retryTimer = setTimeout(() => {
          state.retryTimer = null;
          // 重试必须重新入队（drain 只处理 pending 项，否则失败后永远不会再尝试）。
          state.pending = true;
          void drain(state);
        }, retryDelayMs * state.attempts);
        if (state.retryTimer && typeof state.retryTimer.unref === 'function') state.retryTimer.unref();
      } else {
        emit(payload);
      }
      return payload;
    }
  };

  const drain = async (state) => {
    if (!state || state.running) return;
    state.running = true;
    try {
      while (state.pending) {
        state.pending = false;
        await attempt(state);
      }
    } finally {
      state.running = false;
    }
  };

  function schedule(ctx = {}) {
    const projectId = String(ctx.projectId || '').trim();
    if (!projectId) return { queued: false, message: '缺少 projectId，未排队' };
    const state = stateOf(projectId);
    state.ctx = { ...ctx, projectId, reason: String(ctx.reason || 'side-effect') };
    state.pending = true;
    state.attempts = 0;
    if (state.timer || state.retryTimer || state.running) return { queued: true, merged: true, debounceMs };
    state.timer = setTimeout(() => { state.timer = null; void drain(state); }, debounceMs);
    if (state.timer && typeof state.timer.unref === 'function') state.timer.unref();
    return { queued: true, merged: false, debounceMs };
  }

  function status() {
    const rows = [];
    for (const [projectId, state] of queues.entries()) {
      rows.push({
        projectId,
        running: Boolean(state.running),
        pending: Boolean(state.pending),
        attempts: state.attempts,
        reason: state.ctx ? state.ctx.reason : '',
        lastResult: state.lastResult,
      });
    }
    return { ok: true, queue: rows, at: new Date().toISOString() };
  }

  function dispose() {
    for (const state of queues.values()) {
      if (state.timer) clearTimeout(state.timer);
      if (state.retryTimer) clearTimeout(state.retryTimer);
    }
    queues.clear();
  }

  return { schedule, status, dispose, _queues: queues };
}

module.exports = { createWorkflowSideEffects };
