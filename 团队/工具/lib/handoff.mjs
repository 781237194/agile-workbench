/**
 * R-8f68 v3：角色直连流转（团队工具侧，批 1）。
 *
 * 原则：
 * - 直连只写「任务行 + 直连队列 + 事件」，**不自己唤醒**（唤醒统一交 b5fc 路由守护，防双唤醒）；
 * - G0 只读前置判定：流程边表外 / 跳步 / 伪造 from / 目标角色不合法 → HANDOFF_FORBIDDEN（why 写清，零写入）；
 * - 下游接收确认：`handoff accept` 写任务 status=working + `handoff_ack` 事件（或角色自己 claim 成 working）；
 * - 铁律 5 例外（常规回执豁免）**未获 Owner 批准前不生效**；批准状态存 `规则例外.json`，只读查询。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  PATHS, fail, nowIso, exists, ensureDir, readJson, writeJson, appendLine, truncate,
  appendEvent, withLock,
} from './core.mjs';
import { projectStatePaths, loadProject, projectTeamMode, loadTeam, listTasks, loadTask, saveTask, sendMessage } from './store.mjs';
import { requirementReviewer, ROLE_NAMES, rolesForMode } from './roles.mjs';
import { readWorkflowState } from './lifecycle.mjs';

/** 需求行（只读）；读不到返回 null（不猜状态）。 */
function workflowRowFor(projectName, requirementId) {
  try {
    const { state } = readWorkflowState(projectName);
    return state && state.requirements ? (state.requirements[String(requirementId)] || null) : null;
  } catch { return null; }
}

export const HANDOFF_QUEUE_FILE = '直连队列.json';
export const RULE_EXCEPTION_FILE = '规则例外.json';
export const HANDOFF_ACTIONS = ['review', 'develop', 'test', 'fix', 'accept'];
export const DEFAULT_QUEUE_MAX = 20;
const ACTIONS_BY_FROM = {
  analyst: ['review'],
  product: ['develop'],
  programmer1: ['test'],
  programmer2: ['test'],
  tester: ['fix', 'accept'],
};

export function handoffQueuePath(projectName) {
  return path.join(projectStatePaths(String(projectName || '').trim()).dir, HANDOFF_QUEUE_FILE);
}
export function ruleExceptionPath(projectName) {
  return path.join(projectStatePaths(String(projectName || '').trim()).dir, RULE_EXCEPTION_FILE);
}

function queueMax() {
  const raw = Number(process.env.TEAM_QUEUE_MAX);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_QUEUE_MAX;
}

export function readHandoffQueue(projectName) {
  const file = handoffQueuePath(projectName);
  const raw = exists(file) ? readJson(file, null) : null;
  const items = raw && Array.isArray(raw.items) ? raw.items.filter((row) => row && row.taskId) : [];
  return { file, items, updatedAt: String((raw && raw.updatedAt) || '') };
}

const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
function sortQueue(items) {
  return items.slice().sort((a, b) => (Number(PRIORITY_RANK[String(a.priority || 'P1')] ?? 9) - Number(PRIORITY_RANK[String(b.priority || 'P1')] ?? 9))
    || String(a.due || '9999-99-99').localeCompare(String(b.due || '9999-99-99'))
    || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

function writeHandoffQueue(projectName, items) {
  const file = handoffQueuePath(projectName);
  writeJson(file, { schema: 1, project: String(projectName || ''), items: sortQueue(items), updatedAt: nowIso() });
  return file;
}

/** Owner 审批状态（F-8f68-4 批 2 开关）：只读；文件不存在 → pending。 */
export function ruleExceptionStatus(projectName) {
  const file = ruleExceptionPath(projectName);
  const raw = exists(file) ? readJson(file, null) : null;
  const list = raw && Array.isArray(raw.exceptions) ? raw.exceptions : [];
  const row = list.find((it) => String(it.rule) === 'iron5_receipt_exemption') || null;
  return {
    file, project: String(projectName || ''),
    exemption: row || { rule: 'iron5_receipt_exemption', status: 'pending', approvedBy: '', approvedAt: '', note: '' },
    batch: row && String(row.status) === 'approved' && String(row.approvedBy) === 'owner' && String(row.approvedAt || '') ? 'batch2' : 'batch1',
  };
}

/** Owner 书面批准（只有 owner 身份通道能写；这里只提供写入口，调用方负责确认码）。 */
export function approveRuleException(projectName, { approvedBy = 'owner', note = '' } = {}) {
  if (String(approvedBy) !== 'owner') fail('PERMISSION_DENIED', '只有 Owner 能批准铁律 5 例外', { approvedBy });
  const file = ruleExceptionPath(projectName);
  const raw = exists(file) ? readJson(file, null) : null;
  const list = raw && Array.isArray(raw.exceptions) ? raw.exceptions.slice() : [];
  const next = {
    rule: 'iron5_receipt_exemption', status: 'approved', approvedBy: 'owner', approvedAt: nowIso(), note: truncate(String(note || ''), 200),
  };
  const idx = list.findIndex((it) => String(it.rule) === next.rule);
  if (idx >= 0) list[idx] = next; else list.push(next);
  writeJson(file, { schema: 1, project: String(projectName || ''), exceptions: list, updatedAt: nowIso() });
  appendEvent({ role: 'owner', sessionId: '', action: 'rule_exception_approved', project: projectName, target: next.rule, note: next.note });
  return ruleExceptionStatus(projectName);
}

/**
 * G0 只读前置判定（不写任何文件）。
 * 返回 { ok:true } 或 { ok:false, why }；错误码由调用方转 HANDOFF_FORBIDDEN。
 */
export function gateHandoff(projectName, { from, to, action, task }) {
  const fromRole = String(from || '').trim();
  const toRole = String(to || '').trim();
  const act = String(action || '').trim().toLowerCase();
  if (!HANDOFF_ACTIONS.includes(act)) return { ok: false, why: `action_not_in_table(${act || '-'})` };
  if (!ACTIONS_BY_FROM[fromRole] || !ACTIONS_BY_FROM[fromRole].includes(act)) return { ok: false, why: `from_not_allowed(${fromRole}:${act})` };
  const project = loadProject(projectName);
  const mode = projectTeamMode(project);
  const allowedRoles = rolesForMode(mode);
  if (!allowedRoles.includes(toRole)) return { ok: false, why: `to_not_in_mode(${toRole})` };
  if (fromRole === toRole) return { ok: false, why: `self_handoff(${toRole})` };
  if (!task) return { ok: false, why: 'task_missing' };
  const requirementId = String(task.requirementId || '');
  const row = requirementId ? (workflowRowFor(projectName, requirementId) || {}) : {};
  const status = String(row.status || '');
  if (act === 'review') {
    if (toRole !== requirementReviewer(mode)) return { ok: false, why: `review_target_not_reviewer(${toRole})` };
    return { ok: true };
  }
  if (!requirementId && act !== 'fix') return { ok: false, why: 'requirement_missing' };
  if (act === 'develop') {
    if (!['approved', 'ready', 'dispatched', 'dev', 'dev_review'].includes(status)) return { ok: false, why: `stage_not_develop(${status || '-'})` };
    if (!['programmer1', 'programmer2'].includes(toRole)) return { ok: false, why: `develop_target_not_dev(${toRole})` };
    return { ok: true };
  }
  if (act === 'test') {
    if (!['dev_done', 'test'].includes(status) && String(task.status || '') !== 'done') return { ok: false, why: `stage_not_test(${status || '-'})` };
    if (toRole !== 'tester') return { ok: false, why: `test_target_not_tester(${toRole})` };
    // 开发把任务交给测试：任务 owner 必须是投递方（否则像伪造）
    if (String(task.owner || '') && String(task.owner) !== fromRole) return { ok: false, why: `task_owner_mismatch(${task.owner})` };
    return { ok: true };
  }
  if (act === 'fix') {
    if (!['programmer1', 'programmer2'].includes(toRole)) return { ok: false, why: `fix_target_not_dev(${toRole})` };
    // 缺陷任务独立于需求阶段（B-* 打回）；普通任务要求已 dev_done/test 或已 done。
    if (String(task.type || '') !== 'bug' && !['dev_done', 'test', 'test_done'].includes(status) && String(task.status || '') !== 'done') {
      return { ok: false, why: `stage_not_fix(${status || '-'})` };
    }
    return { ok: true };
  }
  if (act === 'accept') {
    if (toRole !== 'pm') return { ok: false, why: `accept_target_not_pm(${toRole})` };
    if (status !== 'test_done') return { ok: false, why: `stage_not_accept(${status || '-'})` };
    if (String(task.owner || '') && String(task.owner) !== fromRole) return { ok: false, why: `task_owner_mismatch(${task.owner})` };
    return { ok: true };
  }
  return { ok: false, why: 'unmapped' };
}

/**
 * 直连投递（只写任务行 + 队列 + 事件，不唤醒）：
 * - 成功：任务 owner 改目标角色、history 记 handoff(accepted)、事件 role_handoff、队列插入（排序+上限）；
 * - 队列写失败（TEAM_QUEUE_WRITE_FAIL=1）：回退给 PM 一条 escalation 卡点消息 + 事件 handoff_fallback；
 * - 失败（G0/上限/越权）：抛 HANDOFF_FORBIDDEN / QUEUE_FULL，history 记 rejected（零队列写入）。
 */
export function sendHandoff(projectName, { from, to, taskId, action, why = '', note = '' } = {}) {
  const name = String(projectName || '').trim();
  if (!name) fail('BAD_PROJECT', '需要项目名');
  const fromRole = String(from || '').trim();
  const toRole = String(to || '').trim();
  const act = String(action || '').trim().toLowerCase();
  const id = String(taskId || '').trim();
  if (!id) fail('BAD_ARGS', '需要 --task T-...');
  const task = loadTask(name, id);
  const gate = gateHandoff(name, { from: fromRole, to: toRole, action: act, task });
  const at = nowIso();
  if (!gate.ok) {
    // 越权/跳步：只留 history+事件（result=rejected），不写队列、不改 owner
    task.history = Array.isArray(task.history) ? task.history : [];
    task.history.push({ at, action: 'handoff', from: fromRole, to: toRole, by: fromRole, result: 'rejected', why: gate.why, note: truncate(note, 120) });
    saveTask(name, task);
    appendEvent({
      role: fromRole, sessionId: '', action: 'role_handoff', project: name, target: id,
      note: `from=${fromRole} to=${toRole} action=${act} result=rejected why=${gate.why}`,
      data: { event: 'role_handoff', from: fromRole, to: toRole, taskId: id, requirementId: String(task.requirementId || ''), action: act, result: 'rejected', why: gate.why, at },
    });
    fail('HANDOFF_FORBIDDEN', `直连被拒：${gate.why}`, { taskId: id, from: fromRole, to: toRole, action: act, why: gate.why });
  }
  const queue = readHandoffQueue(name);
  const roleItems = queue.items.filter((row) => String(row.to) === toRole && !row.done);
  if (roleItems.length >= queueMax()) {
    fail('QUEUE_FULL', `目标角色 ${toRole} 的直连队列已满（${roleItems.length}/${queueMax()}），拒绝硬塞`, { to: toRole, count: roleItems.length, max: queueMax() });
  }
  // 任务行：owner 改为目标角色；fix 记得 reopenCount+1；状态保持（接收时改 working）
  task.owner = toRole;
  if (act === 'fix') {
    task.reopenCount = Number(task.reopenCount || 0) + 1;
    task.status = 'done' === String(task.status || '') ? 'working' : task.status;
  }
  task.updatedAt = at;
  task.history = Array.isArray(task.history) ? task.history : [];
  task.history.push({ at, action: 'handoff', from: fromRole, to: toRole, by: fromRole, result: 'accepted', why: truncate(why || '', 200), note: truncate(note || '', 120) });
  saveTask(name, task);
  const queueItem = {
    taskId: id, requirementId: String(task.requirementId || ''), from: fromRole, to: toRole,
    action: act, priority: String(task.priority || 'P1'), due: String(task.due || ''),
    createdAt: at, status: 'queued', note: truncate(note || '', 120),
  };
  let queuePos = 0;
  let fallback = null;
  try {
    if (process.env.TEAM_QUEUE_WRITE_FAIL === '1') fail('HANDOFF_QUEUE_WRITE_FAILED', '队列写入被测试注入为失败（TEAM_QUEUE_WRITE_FAIL=1）');
    const nextItems = queue.items.filter((row) => String(row.taskId) !== id || String(row.to) !== toRole).concat([queueItem]);
    writeHandoffQueue(name, nextItems);
    queuePos = sortQueue(nextItems).findIndex((row) => String(row.taskId) === id && String(row.to) === toRole) + 1;
  } catch (e) {
    // 回退 PM 卡点（已登记类型 escalation，不新造）
    const msg = sendMessage({
      from: 'system', to: 'pm', type: 'escalation', project: name,
      subject: `直连写队列失败：${id} → ${ROLE_NAMES[toRole] || toRole}`,
      body: `code=HANDOFF_QUEUE_WRITE_FAILED\n任务 ${id} 直连给 ${toRole} 失败：${String((e && e.message) || e)}\n请 PM 手动安排（任务 owner 已改为 ${toRole}，历史已留痕）。`,
      ackRequired: true,
    });
    appendEvent({
      role: 'system', sessionId: '', action: 'handoff_fallback', project: name, target: id,
      note: `why=queue_write_failed to=${toRole} message=${msg.id}`,
      data: { event: 'handoff_fallback', why: 'queue_write_failed', taskId: id, to: toRole, at },
    });
    fallback = { messageId: msg.id, code: 'HANDOFF_QUEUE_WRITE_FAILED' };
  }
  appendEvent({
    role: fromRole, sessionId: '', action: 'role_handoff', project: name, target: id,
    note: `from=${fromRole} to=${toRole} action=${act} result=accepted${fallback ? ' fallback=1' : ` queuePos=${queuePos}`}`,
    data: {
      event: 'role_handoff', from: fromRole, to: toRole, taskId: id, requirementId: String(task.requirementId || ''),
      action: act, queuePos, result: 'accepted', why: truncate(why || '', 200), at,
    },
  });
  return { ok: true, taskId: id, from: fromRole, to: toRole, action: act, queuePos, fallback, woke: false, task };
}

/** 下游接收确认（F-8f68-4b）：任务 status=working + `handoff_ack` 事件 {taskId,to,at}。 */
export function acceptHandoff(projectName, { taskId, role } = {}) {
  const name = String(projectName || '').trim();
  const id = String(taskId || '').trim();
  const roleId = String(role || '').trim();
  if (!id) fail('BAD_ARGS', '需要 --task T-...');
  const task = loadTask(name, id);
  if (String(task.owner || '') !== roleId) fail('NOT_OWNER', `任务 ${id} 的 owner 是 ${task.owner || '(无)'}，${roleId} 不能接收`, { taskId: id, owner: task.owner, role: roleId });
  const at = nowIso();
  task.status = 'working';
  task.updatedAt = at;
  task.history = Array.isArray(task.history) ? task.history : [];
  task.history.push({ at, action: 'handoff_accept', from: '', to: roleId, by: roleId, result: 'accepted', why: '' });
  saveTask(name, task);
  appendEvent({
    role: roleId, sessionId: '', action: 'handoff_ack', project: name, target: id,
    note: `taskId=${id} to=${roleId}`,
    data: { event: 'handoff_ack', taskId: id, to: roleId, at },
  });
  return { ok: true, taskId: id, to: roleId, at, status: task.status };
}

/** 直连队列（只读；排序=优先级→截止→创建）。 */
export function listHandoffQueue(projectName, { role = '', all = false } = {}) {
  const queue = readHandoffQueue(projectName);
  const items = sortQueue(queue.items.filter((row) => !row.done && (all || !role || String(row.to) === String(role))));
  return { ok: true, project: String(projectName || ''), items, count: items.length, max: queueMax(), file: queue.file };
}

/** PM 插队或改优先级（只有 PM；只改队列顺序/priority，不改真相）。 */
export function prioritizeHandoff(projectName, { taskId, to, priority, by } = {}) {
  if (String(by) !== 'pm') fail('DECISION_HANDOFF_FORBIDDEN', '只有 PM 能插队/改队列优先级', { by });
  const queue = readHandoffQueue(projectName);
  const hit = queue.items.find((row) => String(row.taskId) === String(taskId) && (!to || String(row.to) === String(to)));
  if (!hit) fail('HANDOFF_NOT_FOUND', `直连队列里没有 ${taskId} → ${to || '*'}`, { taskId, to });
  if (priority) hit.priority = String(priority).toUpperCase();
  hit.prioritizedAt = nowIso();
  hit.prioritizedBy = 'pm';
  writeHandoffQueue(projectName, queue.items);
  const items = sortQueue(queue.items);
  return { ok: true, item: hit, position: items.findIndex((row) => row === hit) + 1, count: items.length };
}

/** 队列项完成（角色接单并收口后，从直连队列移除）。 */
export function completeHandoff(projectName, { taskId, role } = {}) {
  const queue = readHandoffQueue(projectName);
  const hit = queue.items.find((row) => String(row.taskId) === String(taskId) && (!role || String(row.to) === String(role)) && !row.done);
  if (!hit) return { ok: true, removed: false };
  hit.done = true;
  hit.doneAt = nowIso();
  writeHandoffQueue(projectName, queue.items);
  return { ok: true, removed: true, taskId, to: hit.to };
}
