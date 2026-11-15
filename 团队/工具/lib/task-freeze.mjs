/**
 * R-75ec：任务层 Owner 门禁的**设备效果层**——冻结 / 解冻 / 落账即生效。
 *
 * 口径（主正文 §五 AC3/AC8/AC9 + 增补卷 §三/§四/§六）：
 *   - Owner 决定落账的同一写路径立即调用 `applyOwnerDecisionEffects()`：
 *     rejected/iteration/terminated → 冻结该需求全部未完成任务（blocked + beforeStatus）
 *     approved/skipped/accepted   → 解冻（回 beforeStatus，缺省 open）
 *   - 冻结时逐条给任务 owner 发停手通知，失败落 `blockedNotify` + 需求行 events；
 *     PM 只收 1 条汇总（带 notifyFailed[]）。
 *   - 审计沿用 `闸门审计.jsonl` 11 键：action=task_freeze|task_unfreeze，
 *     code=OWNER_REJECTED|OWNER_ITERATION|OWNER_TERMINATED|OWNER_GATE_PASSED。
 *   - 重复冻结/解冻 NOOP（不写审计）；done 任务不动。
 */
import { listTasks, loadTask, saveTask, sendMessage } from './store.mjs';
import { auditGate } from './gates.mjs';

const FREEZE_CODES = { rejected: 'OWNER_REJECTED', iteration: 'OWNER_ITERATION', terminated: 'OWNER_TERMINATED' };
const PASS_STATUSES = ['approved', 'skipped', 'accepted'];
const FREEZE_CAUSES = ['rejected', 'iteration', 'terminated'];

/** 判定该需求行当前应冻结还是解冻：返回 {mode:'freeze'|'unfreeze'|'noop', cause, code}。 */
export function decisionEffect(row = null, decisionStatus = '') {
  const rowStatus = String((row && row.status) || '');
  const status = String(decisionStatus || '');
  if (FREEZE_CAUSES.includes(status)) return { mode: 'freeze', cause: status, code: FREEZE_CODES[status] };
  if (FREEZE_CAUSES.includes(rowStatus)) return { mode: 'freeze', cause: rowStatus, code: FREEZE_CODES[rowStatus] };
  if (PASS_STATUSES.includes(status)) return { mode: 'unfreeze', cause: '', code: 'OWNER_GATE_PASSED' };
  return { mode: 'noop', cause: '', code: '' };
}

function tasksOfRequirement(project, requirementId) {
  const id = String(requirementId || '');
  return listTasks(project).filter((task) => String(task.requirementId || '') === id);
}

/**
 * 冻结一个需求下所有未完成任务。
 * @returns {{frozen:string[], skipped:string[], notifyFailed:string[]}}
 */
export function freezeTasksOfRequirement(project, requirementId, { cause = 'rejected', code = '', by = 'system', source = 'cli', reason = '' } = {}) {
  const freezeCode = code || FREEZE_CODES[cause] || 'OWNER_REJECTED';
  const frozen = [];
  const skipped = [];
  const notifyFailed = [];
  for (const row of tasksOfRequirement(project, requirementId)) {
    const task = loadTask(project, row.id);
    const status = String(task.status || '');
    if (status === 'blocked' || status === 'done') { skipped.push(row.id); continue; }
    const beforeStatus = status || 'open';
    task.beforeStatus = beforeStatus;
    task.status = 'blocked';
    task.blockedAt = new Date().toISOString();
    task.blockedCause = cause;
    task.blockedBy = by;
    task.blockedReason = String(reason || '');
    task._by = by;
    task._action = 'freeze';
    // 停手通知：逐条发给任务 owner（失败落 blockedNotify + events，不影响冻结本身）
    const owner = String(task.owner || '');
    if (owner) {
      try {
        sendMessage({
          project, to: owner, from: 'system', type: 'notice',
          subject: `停手：${task.id} 因需求被${cause === 'rejected' ? '打回' : (cause === 'iteration' ? '退回迭代' : '终止')}冻结`,
          body: `需求 ${requirementId} 已被 Owner ${cause === 'rejected' ? '打回' : (cause === 'iteration' ? '退回迭代' : '终止')}（${freezeCode}）。任务「${String(task.title || '').slice(0, 40)}」（${task.id}）已冻结为 blocked（原状态 ${beforeStatus}），立即停手，不要再提交产出；等需求重新过门会自动解冻。`,
        });
        task.blockedNotify = { status: 'sent', at: new Date().toISOString() };
      } catch (error) {
        notifyFailed.push(task.id);
        task.blockedNotify = { status: 'failed', at: new Date().toISOString(), error: String((error && error.message) || error).slice(0, 200) };
      }
    }
    saveTask(project, task);
    auditGate(project, {
      role: by, source, action: 'task_freeze', gate: 'G3', code: freezeCode,
      missing: [`需求 ${requirementId} 状态 ${cause}`], requirementId, taskId: task.id,
      attempted: 'task_freeze', next: '等需求重新过 Owner 门后自动解冻',
    });
    frozen.push(task.id);
  }
  return { frozen, skipped, notifyFailed };
}

/** 解冻一个需求下所有 blocked 任务（回 beforeStatus，缺省 open）。重复解冻 NOOP。 */
export function unfreezeTasksOfRequirement(project, requirementId, { by = 'system', source = 'cli' } = {}) {
  const unfrozen = [];
  const skipped = [];
  for (const row of tasksOfRequirement(project, requirementId)) {
    const task = loadTask(project, row.id);
    if (String(task.status || '') !== 'blocked') { skipped.push(row.id); continue; }
    const back = String(task.beforeStatus || 'open');
    task.status = back === 'blocked' ? 'open' : back;
    delete task.beforeStatus;
    delete task.blockedAt;
    delete task.blockedCause;
    delete task.blockedBy;
    delete task.blockedReason;
    delete task.blockedNotify;
    task._by = by;
    task._action = 'unfreeze';
    saveTask(project, task);
    auditGate(project, {
      role: by, source, action: 'task_unfreeze', gate: 'G3', code: 'OWNER_GATE_PASSED',
      missing: [], requirementId, taskId: task.id, attempted: 'task_unfreeze',
      next: `已恢复为 ${task.status}`,
    });
    unfrozen.push(task.id);
  }
  return { unfrozen, skipped };
}

/**
 * Owner 决定落账后立即生效（owner:decide / owner proxy decide / req terminate / req iterate 共用）。
 * PM 汇总只发 1 条（含 notifyFailed）。
 */
export function applyOwnerDecisionEffects(project, requirementId, decisionStatus, { row = null, by = 'system', source = 'cli', reason = '' } = {}) {
  const effect = decisionEffect(row, decisionStatus);
  if (effect.mode === 'noop') return { mode: 'noop', frozen: [], unfrozen: [], notifyFailed: [] };
  if (effect.mode === 'freeze') {
    const result = freezeTasksOfRequirement(project, requirementId, { cause: effect.cause, code: effect.code, by, source, reason });
    if (result.frozen.length) {
      try {
        sendMessage({
          project, to: 'pm', from: 'system', type: 'notice',
          subject: `汇总：需求 ${requirementId} ${effect.cause} → 冻结 ${result.frozen.length} 条任务`,
          body: [
            `需求 ${requirementId} 因 Owner ${effect.cause}（${effect.code}）冻结了 ${result.frozen.length} 条未完成任务：`,
            result.frozen.join('、'),
            result.skipped.length ? `跳过（已 done/已 blocked）：${result.skipped.join('、')}` : '',
            result.notifyFailed.length ? `停手通知失败：${result.notifyFailed.join('、')}（已补发一次）` : '',
            '解冻条件：需求重新过 Owner 门（approved/skipped/accepted）后自动恢复。',
          ].filter(Boolean).join('\n'),
        });
      } catch { /* PM 汇总失败不影响冻结 */ }
    }
    return { mode: 'freeze', ...result };
  }
  const result = unfreezeTasksOfRequirement(project, requirementId, { by, source });
  return { mode: 'unfreeze', frozen: [], unfrozen: result.unfrozen, note: result.skipped, notifyFailed: [] };
}
