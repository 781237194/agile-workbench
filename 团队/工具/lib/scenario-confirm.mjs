// R-43ad F-43ad-4 / AC3（T-20261115-014633 之外由 T-f203 承接）：场景缺陷「场景确认」超时口径。
//
// 规则（需求正文写死，可注入）：
//   ① 场景缺陷开单 → 产品（full）/ 分析师（fast）确认「是不是场景缺陷」，正常 10 分钟内给结论；
//   ② 超时默认按 bug 先行（不卡开发），同时给 PM 一条 escalation 告警（code=SCENARIO_CONFIRM_TIMEOUT）；
//   ③ 超时可注入 TEAM_SCENARIO_CONFIRM_TIMEOUT_MS（默认 600000=10 分钟，测试可设 1000）；
//   ④ 确认「是」→ 保持 scenario-bug；确认「不是」→ 改判 bug（或关单写理由），场景字段保留；
//   ⑤ type 与 bugClass 并存，互不覆盖。
//
// 本模块只做纯计算与状态补写，不做消息发送（发送由调用方/守护负责）。

export const SCENARIO_CONFIRM_STATUSES = Object.freeze(['pending', 'confirmed', 'rejected', 'timeout']);

/** 超时毫秒：TEAM_SCENARIO_CONFIRM_TIMEOUT_MS 注入，默认 10 分钟；非法值回落默认。 */
export function scenarioTimeoutMs(env = process.env) {
  const raw = Number((env && env.TEAM_SCENARIO_CONFIRM_TIMEOUT_MS) || 0);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 600000;
}

/** 确认人角色：full=产品、fast=分析师（与评审人同口径）。 */
export function scenarioConfirmerFor(mode) {
  return String(mode || '') === 'fast' ? 'analyst' : 'product';
}

/** 开单时补的初始状态（createTask 调用）。 */
export function initialScenarioConfirm({ now = Date.now(), mode = 'full', env = process.env } = {}) {
  const timeoutMs = scenarioTimeoutMs(env);
  return {
    status: 'pending',
    requestedAt: new Date(now).toISOString(),
    dueAt: new Date(now + timeoutMs).toISOString(),
    timeoutMs,
    confirmer: scenarioConfirmerFor(mode),
    by: '',
    at: '',
    reason: '',
    treatAs: '',
    escalatedAt: '',
  };
}

/**
 * 判定当前状态：{status, pending, timedOut, dueAt, timeoutMs, confirmer}
 * 老数据没有 scenarioConfirm 字段时，按「pending，从 createdAt 起算」兜底（不写盘）。
 */
export function scenarioConfirmState(task, { now = Date.now(), env = process.env, mode = 'full' } = {}) {
  const source = task && typeof task === 'object' ? task : {};
  if (String(source.type || '') !== 'scenario-bug') return { status: 'n/a', pending: false, timedOut: false };
  const timeoutMs = scenarioTimeoutMs(env);
  const base = (source.scenarioConfirm && typeof source.scenarioConfirm === 'object') ? source.scenarioConfirm : {};
  const requestedAt = String(base.requestedAt || source.createdAt || '') || new Date(now).toISOString();
  const dueAtMs = Date.parse(String(base.dueAt || '')) || (Date.parse(requestedAt) + timeoutMs);
  const status = String(base.status || 'pending');
  const pending = status === 'pending';
  const timedOut = pending && now >= dueAtMs;
  return {
    status: timedOut ? 'timeout' : status,
    pending,
    timedOut,
    requestedAt,
    dueAt: new Date(dueAtMs).toISOString(),
    timeoutMs,
    confirmer: String(base.confirmer || scenarioConfirmerFor(mode)),
    treatAs: String(base.treatAs || ''),
    escalatedAt: String(base.escalatedAt || ''),
  };
}

/**
 * 到点超时：改 status=timeout + treatAs=bug（按 bug 先行），返回新对象（不改入参）。
 * 已确认/已改判的单不动。
 */
export function applyScenarioTimeout(task, { now = Date.now(), env = process.env, mode = 'full' } = {}) {
  const state = scenarioConfirmState(task, { now, env, mode });
  if (!state.timedOut) return { changed: false, state, task };
  const next = {
    ...task,
    scenarioConfirm: {
      ...(task.scenarioConfirm || {}),
      status: 'timeout',
      treatAs: 'bug',
      timedOutAt: new Date(now).toISOString(),
      confirmer: state.confirmer,
      timeoutMs: state.timeoutMs,
    },
  };
  return { changed: true, state: scenarioConfirmState(next, { now, env, mode }), task: next };
}
