// R-9fbe（T-20261115-063059-09e9）：账本分叉判定的唯一口径（工具侧）。
//
// 背景：面板（app.js:5071-5106）原先只比「工作流 status × 任务 status」，
// 缺「重开时间」维度——需求被 req reopen 过（如 R-20261114-132024-43ad：
// 任务 08:16 done、需求 17:34 重开、补单 T-f203 在办）时，旧判据会把
// 「任务 done 但工作流还停在 dev」当成账本分叉，永远显示红项。
//
// 本模块只做判定，不改状态（处置必须走 team.mjs 协议命令 + 审计）：
//   ① reopenedAt = row.lastReopenAt → history 里最后一条 req_reopen/reopen → row.gateInvalidatedAt
//   ② 任务集合里取「非 requirement 类型、requirementId 命中」的行
//   ③ 判定：
//      - 还有在办任务（working/open/…）        → inFlight:task_in_progress（不是分叉）
//      - 全部任务已 done/closed，但 taskDoneAt < reopenedAt → inFlight:rework_in_flight（返工在途，不是分叉）
//      - 全部任务已 done/closed，且没有更晚的重开      → fork:ledger_behind_workflow（真分叉）
//   ④ 收口状态（accepted/done/terminated/iteration/rejected）一律不判分叉
//
// 口径与 src/team-tools.js 的同名实现必须一致（断言脚本会对比两边 id 集合）。

/** 需求收口状态：这些状态下不再谈分叉。 */
export const LEDGER_CLOSED_STATUSES = Object.freeze(['accepted', 'done', 'terminated', 'iteration', 'rejected']);
/** 仍算「开发/测试在途」的状态：只有这些状态才可能判账本分叉。 */
export const LEDGER_OPEN_STAGES = Object.freeze([
  'review', 'approved', 'tech_review', 'ready', 'dispatched', 'dev', 'dev_review', 'dev_done', 'test', 'test_done', 'owner_accept',
]);
/** 任务视为「已收口」的状态（done 之外，terminated/cancelled 也不该算在办）。 */
export const LEDGER_TASK_CLOSED = Object.freeze(['done', 'terminated', 'cancelled']);
/** 「开发还没完工」的阶段：这些阶段里开发任务全 done 才算账本超前（dev_done 起是正常过渡）。 */
export const DEV_STAGE_BEFORE_DONE = Object.freeze(['review', 'approved', 'tech_review', 'ready', 'dispatched', 'dev']);

/** 重开时间：lastReopenAt 优先，其次 history 里最后一条 req_reopen/reopen，最后 gateInvalidatedAt。 */
export function reopenedAtOf(row) {
  const source = row && typeof row === 'object' ? row : {};
  const direct = String(source.lastReopenAt || source.reopenedAt || '').trim();
  if (direct) return direct;
  const history = Array.isArray(source.history) ? source.history : [];
  let latest = '';
  for (const item of history) {
    if (!item || typeof item !== 'object') continue;
    const action = String(item.action || '');
    if (action !== 'req_reopen' && action !== 'reopen') continue;
    const at = String(item.at || '');
    if (at && (!latest || Date.parse(at) >= Date.parse(latest))) latest = at;
  }
  if (latest) return latest;
  return String(source.gateInvalidatedAt || '').trim();
}

/** 某需求下的非需求类任务。 */
export function tasksOfRequirement(requirementId, tasks) {
  const id = String(requirementId || '').trim();
  if (!id) return [];
  return (Array.isArray(tasks) ? tasks : []).filter((task) => task
    && String(task.type || '') !== 'requirement'
    && String(task.requirementId || '') === id);
}

/**
 * 单需求账本视图：
 * {requirementId, status, reopenedAt, taskDoneAt, liveTasks, closedTasks, inFlight, fork}
 * inFlight: '' | 'task_in_progress' | 'rework_in_flight'
 * fork: null | {kind, taskId, taskDoneAt, reopenedAt}
 *
 * 判据要点（别按「任务全 done 就分叉」一刀切，test_done/owner_accept 本来就是任务全 done）：
 *   - 有在办任务 → 不是分叉（task_in_progress）
 *   - 全部收口但 taskDoneAt < reopenedAt → 返工在途（rework_in_flight，43ad 就是这种）
 *   - 开发任务全 done 而工作流仍停在开发前/开发中（ready/approved/tech_review/dispatched/dev）
 *     → fork:dev_ledger_ahead（账本已完工，工作流没往前走）
 *   - 测试任务全 done 而工作流停在 dev_done/test → fork:test_ledger_ahead
 *   - test_done / owner_accept（等验收）永远不算分叉
 */
export function requirementLedger(row, tasks) {
  const source = row && typeof row === 'object' ? row : {};
  const id = String(source.id || '').trim();
  const status = String(source.status || '');
  const reopenedAt = reopenedAtOf(source);
  const list = tasksOfRequirement(id, tasks);
  const liveTasks = list.filter((task) => !LEDGER_TASK_CLOSED.includes(String(task.status || '')));
  const closedTasks = list.filter((task) => LEDGER_TASK_CLOSED.includes(String(task.status || '')));
  let taskDoneAt = '';
  for (const task of closedTasks) {
    const at = String(task.doneAt || task.updatedAt || '');
    if (at && (!taskDoneAt || Date.parse(at) >= Date.parse(taskDoneAt))) taskDoneAt = at;
  }
  const view = { requirementId: id, status, reopenedAt, taskDoneAt, liveTasks: liveTasks.length, closedTasks: closedTasks.length, inFlight: '', fork: null };
  if (!list.length) return view;                                   // 没任务：不算分叉（缺任务另有判据）
  if (LEDGER_CLOSED_STATUSES.includes(status)) return view;        // 已收口：不判分叉
  if (!LEDGER_OPEN_STAGES.includes(status)) return view;           // 表外状态：不猜
  if (['test_done', 'owner_accept'].includes(status)) return view; // 等验收：任务全 done 是正常态
  if (liveTasks.length) { view.inFlight = 'task_in_progress'; return view; }
  // 任务全完：看有没有「更晚的重开」——有就是返工在途（等补单），不是分叉。
  if (reopenedAt && taskDoneAt && Date.parse(taskDoneAt) < Date.parse(reopenedAt)) {
    view.inFlight = 'rework_in_flight';
    return view;
  }
  const devTasks = list.filter((task) => ['programmer1', 'programmer2'].includes(String(task.owner || '')));
  const testTasks = list.filter((task) => String(task.owner || '') === 'tester');
  const allClosed = (rows) => rows.length > 0 && rows.every((task) => LEDGER_TASK_CLOSED.includes(String(task.status || '')));
  const latest = (rows) => rows.slice().sort((a, b) => Date.parse(String(b.doneAt || b.updatedAt || '0')) - Date.parse(String(a.doneAt || a.updatedAt || '0')))[0] || null;
  if (allClosed(devTasks) && DEV_STAGE_BEFORE_DONE.includes(status)) {
    view.fork = { kind: 'dev_ledger_ahead', taskId: String((latest(devTasks) || {}).id || ''), taskDoneAt, reopenedAt };
    return view;
  }
  if (allClosed(testTasks) && ['dev_done', 'test'].includes(status)) {
    view.fork = { kind: 'test_ledger_ahead', taskId: String((latest(testTasks) || {}).id || ''), taskDoneAt, reopenedAt };
    return view;
  }
  return view;
}

/**
 * 全量判定：requirements 支持 {id: row} 或 row[]；tasks 为任务数组。
 * 返回 {forks, inFlight, summary}
 *   forks:    [{requirementId, kind, taskId, taskDoneAt, reopenedAt, status}]
 *   inFlight: [{requirementId, kind:'task_in_progress'|'rework_in_flight', status, reopenedAt, taskDoneAt}]
 */
export function detectLedgerForks({ requirements = {}, tasks = [] } = {}) {
  const rows = Array.isArray(requirements)
    ? requirements.map((row) => ({ ...(row || {}), id: String((row && row.id) || '') }))
    : Object.entries(requirements || {}).map(([key, row]) => ({ ...(row || {}), id: String((row && row.id) || key) }));
  const forks = [];
  const inFlight = [];
  for (const row of rows) {
    const view = requirementLedger(row, tasks);
    if (view.fork) forks.push({ requirementId: view.requirementId, status: view.status, ...view.fork });
    else if (view.inFlight) inFlight.push({ requirementId: view.requirementId, kind: view.inFlight, status: view.status, reopenedAt: view.reopenedAt, taskDoneAt: view.taskDoneAt });
  }
  return { forks, inFlight, summary: { forks: forks.length, inFlight: inFlight.length, requirements: rows.length } };
}
