// 团队工作台 v2 · 需求生命周期（被驳回 → iterate / terminate）与工作流状态共享
//
// 真相位置与工作台一致：团队/状态/项目/<slug>/工作流.json。
// 本模块只增量合并需求行、轮次、阶段与事件，保留工作台写入的其它字段
// （boots / ownerReview / votes / ownerRequests / 自定义审计字段）。
//
// 两条入口：
//   req iterate / req terminate   —— PM 对单条被驳回需求做决定；
//   workflow iterate / terminate  —— 工作台旧协议入口，按项目推进轮次或终止。
import fs from 'node:fs';
import path from 'node:path';
import {
  exists, fail, nowIso, readText, writeJson, truncate, appendEvent,
} from './core.mjs';
import { projectStatePaths, saveTask, listTasks } from './store.mjs';

const TERMINAL = new Set(['accepted', 'terminated']);
const CLOSED = new Set(['accepted', 'terminated', 'iteration']);

export function workflowFilePath(projectName) {
  return path.join(projectStatePaths(projectName).dir, '工作流.json');
}

function emptyWorkflow(projectName) {
  const at = nowIso();
  return {
    schema: 2,
    project: String(projectName || ''),
    round: 1,
    phase: 'requirement',
    requirements: {},
    events: [],
    createdAt: at,
    updatedAt: at,
  };
}

function normalizeRequirements(raw) {
  const rows = {};
  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (!row || typeof row !== 'object') continue;
      const id = String(row.id || '');
      if (id) rows[id] = { ...row, id };
    }
    return rows;
  }
  if (raw && typeof raw === 'object') {
    for (const [key, row] of Object.entries(raw)) {
      if (!row || typeof row !== 'object') continue;
      const id = String(row.id || key || '');
      if (id) rows[id] = { ...row, id };
    }
  }
  return rows;
}

/** 读 工作流.json；不存在时返回空状态（不写盘）。格式坏了拒绝覆盖。 */
export function readWorkflowState(projectName) {
  const file = workflowFilePath(projectName);
  if (!exists(file)) return { file, exists: false, state: emptyWorkflow(projectName) };
  let raw;
  try {
    const text = readText(file, '').replace(/^\uFEFF/, '');
    raw = JSON.parse(text);
  } catch (e) {
    fail('WORKFLOW_CORRUPT', `工作流.json 无法解析：${file}；先备份并修复，不能直接覆盖`, { file, cause: e.message });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('WORKFLOW_CORRUPT', `工作流.json 不是对象：${file}`, { file });
  }
  const state = {
    ...raw,
    schema: Number(raw.schema) || 2,
    project: String(raw.project || projectName || ''),
    round: Math.max(1, Number(raw.round) || 1),
    phase: String(raw.phase || 'requirement'),
    requirements: normalizeRequirements(raw.requirements),
    events: Array.isArray(raw.events) ? raw.events.slice(-300) : [],
  };
  return { file, exists: true, state };
}

export function writeWorkflowState(projectName, state) {
  const file = workflowFilePath(projectName);
  const next = {
    ...(state && typeof state === 'object' ? state : {}),
    schema: 2,
    project: String(projectName || ''),
    round: Math.max(1, Number(state && state.round) || 1),
    phase: String((state && state.phase) || 'requirement'),
    requirements: normalizeRequirements(state && state.requirements),
    events: Array.isArray(state && state.events) ? state.events.slice(-300) : [],
    updatedAt: nowIso(),
  };
  writeJson(file, next);
  return { file, state: next };
}

function ensureRow(state, task) {
  let row = state.requirements[task.id];
  if (!row || typeof row !== 'object') {
    const status = String((task.workflow && task.workflow.requirementStatus) || 'review');
    row = {
      id: task.id,
      status,
      round: Math.max(1, Number(task.workflow && task.workflow.iterationRound) || state.round || 1),
      queued: false,
      history: [],
    };
  }
  row.id = task.id;
  if (!Array.isArray(row.history)) row.history = [];
  state.requirements[task.id] = row;
  return row;
}

function appendRowHistory(row, entry) {
  if (!row || typeof row !== 'object') return;
  row.history = Array.isArray(row.history) ? row.history : [];
  row.history.push(entry);
  if (row.history.length > 100) row.history = row.history.slice(-100);
}

export function findRejectedVote(projectName, requirementId) {
  const dir = projectStatePaths(projectName).votes;
  if (!exists(dir)) return null;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  for (const name of names) {
    if (!/^V-.*\.json$/i.test(name)) continue;
    let vote;
    try { vote = JSON.parse(readText(path.join(dir, name), '').replace(/^\uFEFF/, '')); } catch { continue; }
    if (!vote || typeof vote !== 'object') continue;
    if (String(vote.requirementId || '') === String(requirementId || '')
      && String(vote.result || '') === 'rejected') return vote;
  }
  return null;
}

/**
 * 需求是否已有驳回证据：评审驳回 / 技术评审驳回 / 投票一致驳回 / 已标 rejected /
 * 工作台上已写 rejected 的工作流行（DSH 角色直接投出驳回时，任务文件可能还没有标记）。
 */
export function rejectionEvidence(projectName, task) {
  const hits = [];
  const wf = task && task.workflow && typeof task.workflow === 'object' ? task.workflow : {};
  if (String(wf.requirementStatus || '') === 'rejected') hits.push('workflow');
  if (task && task.review && String(task.review.verdict || '') === 'reject') {
    hits.push(`review:${task.review.id || task.review.ts || ''}`);
  }
  if (task && task.techReview && String(task.techReview.verdict || '') === 'reject') {
    hits.push(`tech:${task.techReview.id || task.techReview.ts || ''}`);
  }
  const read = readWorkflowState(projectName);
  const row = task && read.state.requirements[task.id];
  if (row && String(row.status || '') === 'rejected') hits.push('workflow-row');
  const vote = findRejectedVote(projectName, task && task.id);
  if (vote) hits.push(`vote:${vote.id}`);
  return hits;
}

/**
 * 按需求行状态推导项目相位。只在生命周期动作（iterate / terminate）里用：
 * 有在办需求时按状态优先级取，全部收口/迭代时才写 iteration / terminated / accepted。
 */
export function deriveProjectPhase(state) {
  const rows = Object.values((state && state.requirements) || {});
  if (!rows.length) return '';
  const statuses = new Set(rows.map((row) => String((row && row.status) || 'review')));
  const active = [...statuses].filter((s) => !['accepted', 'terminated', 'iteration'].includes(s));
  if (active.length) {
    if (statuses.has('test_done')) return 'owner_accept';
    if (statuses.has('test')) return 'test';
    if (statuses.has('dev_review')) return 'dev_review';
    if (statuses.has('dev') || statuses.has('dispatched') || statuses.has('dev_done')) return 'dev';
    if (statuses.has('tech_review')) return 'tech_review';
    if (statuses.has('ready')) return 'dispatch';
    if (statuses.has('approved')) return 'owner_review';
    return 'requirement_review';
  }
  if (statuses.has('iteration')) return 'requirement_review';
  if (statuses.has('terminated')) return 'terminated';
  if (statuses.has('accepted')) return 'accepted';
  return '';
}

/** 只改任务内存里的驳回标记；写盘由调用方负责，避免重复 saveTask。 */
export function stampRejected(task, { source = '', role = '', at = nowIso() } = {}) {
  task.workflow = task.workflow && typeof task.workflow === 'object' ? task.workflow : {};
  task.workflow.requirementStatus = 'rejected';
  task.workflow.rejectedAt = at;
  task.workflow.rejectedBy = role;
  task.workflow.rejectionSource = source;
  return task.workflow;
}

/** 把任务状态增量写入 工作流.json；默认不存在不创建（只有驳回/流转才创建）。 */
export function syncWorkflowRow(projectName, task, status, extra = {}, {
  create = false, action = '', by = '', note = '', phase = '', statePatch = null,
  advanceRound = false, phaseAfter = null, event = null,
} = {}) {
  const read = readWorkflowState(projectName);
  if (!read.exists && !create) return { file: read.file, created: false, state: null };
  const state = read.state;
  if (phase) state.phase = String(phase);
  if (statePatch && typeof statePatch === 'object') Object.assign(state, statePatch);
  const row = ensureRow(state, task);
  row.status = String(status || row.status || 'review');
  row.queued = false;
  if (row.status === 'iteration') {
    // 项目级 iterate 才把需求推到下一轮；单条 req iterate 仍留在当前轮返工。
    row.round = advanceRound
      ? Math.max(Number(row.round) || 1, Number(state.round || 1) + 1)
      : Math.max(1, Number(row.round) || Number(state.round) || 1);
  } else if (row.status === 'terminated') {
    row.round = Math.max(1, Number(row.round) || Number(state.round) || 1);
  }
  // 被驳回的需求必须停回需求评审相位，不能把流程页留在“需求”节点。
  if (row.status === 'rejected') state.phase = 'requirement_review';
  row.updatedAt = nowIso();
  for (const [key, value] of Object.entries(extra || {})) {
    if (value !== undefined && value !== null) row[key] = value;
  }
  appendRowHistory(row, {
    at: row.updatedAt,
    action: action || row.status,
    by: by || '',
    note: truncate(note || '', 300),
  });
  if (typeof phaseAfter === 'function') {
    const derived = phaseAfter(state, row);
    if (derived) state.phase = String(derived);
  }
  if (event && typeof event === 'object') {
    state.events = Array.isArray(state.events) ? state.events : [];
    state.events.push({ at: row.updatedAt, project: projectName, ...event });
    if (state.events.length > 300) state.events = state.events.slice(-300);
  }
  const written = writeWorkflowState(projectName, state);
  return { file: written.file, created: !read.exists, state: written.state };
}

function closeChildTasks(projectName, requirementId, reason, role, action, ts) {
  const closed = [];
  for (const child of listTasks(projectName)) {
    if (!child || String(child.id) === String(requirementId)) continue;
    if (String(child.requirementId || '') !== String(requirementId)) continue;
    if (child.status === 'done') continue;
    child.status = 'done';
    child.doneAt = ts;
    child.evidence = truncate(reason || (action === 'iterate' ? '随需求进入下一轮关闭' : '随需求终止关闭'), 500);
    child.workflow = child.workflow && typeof child.workflow === 'object' ? child.workflow : {};
    child.workflow.requirementStatus = action === 'iterate' ? 'iteration' : 'terminated';
    child._by = role;
    child._action = action;
    child._note = `需求 ${requirementId} ${action === 'iterate' ? '进入下一轮' : '终止'}`;
    saveTask(projectName, child);
    closed.push(child.id);
  }
  return closed;
}

/**
 * 单条需求流转：
 * - iterate：仅允许已有驳回证据（或 force），任务重新 open，轮次 +1；
 * - terminate：任务 done，关联子任务一并收口。
 * 返回落盘路径与工作流行，供 CLI JSON 与工作台读取。
 */
export function transitionRequirement({
  project, task, action, role = 'pm', sessionId = '', reason = '', force = false, advanceRound = false,
}) {
  if (!task || task.type !== 'requirement') {
    fail('NOT_REQUIREMENT', `${task && task.id ? task.id : '(空)'} 不是需求，不能做 ${action}`, { id: task && task.id, type: task && task.type });
  }
  if (!['iterate', 'terminate'].includes(action)) fail('BAD_ACTION', `需求流转只支持 iterate / terminate：${action}`);
  const ts = nowIso();
  const wf = task.workflow && typeof task.workflow === 'object' ? { ...task.workflow } : {};
  const current = String(wf.requirementStatus || '');
  if (TERMINAL.has(current)) {
    fail('REQUIREMENT_CLOSED', `需求 ${task.id} 已 ${current}，不能再 ${action}`, { id: task.id, status: current });
  }
  if (action === 'iterate' && current === 'iteration') {
    fail('REQUIREMENT_CLOSED', `需求 ${task.id} 已进入 iteration，不能重复迭代`, { id: task.id, status: current });
  }

  let closedTasks = [];
  if (action === 'iterate') {
    const evidence = rejectionEvidence(project, task);
    if (!force && !evidence.length) {
      fail('NOT_REJECTED', `需求 ${task.id} 还没有被驳回证据（需求评审/技术评审/投票一致驳回）；如确认要重开用 --force`, {
        id: task.id, status: current, evidence,
      });
    }
    // 工作台可能已经把 iterationRound 写在需求行上；取两边较大值再 +1，避免覆盖成 1。
    const currentRow = readWorkflowState(project).state.requirements[task.id];
    const rowRound = Number(currentRow && currentRow.iterationRound) || 0;
    wf.requirementStatus = 'iteration';
    wf.iterationRound = Math.max(Number(wf.iterationRound || 0), rowRound) + 1;
    wf.iterationAt = ts;
    wf.iterationBy = role;
    wf.iterationReason = truncate(reason, 300);
    task.workflow = wf;
    task.status = 'open';
    task.owner = null;
    task.doneAt = null;
    task.evidence = '';
    task.iteration = Number(task.iteration || 0) + 1;
    task.updatedAt = ts;
    task._by = role;
    task._action = 'iterate';
    task._note = truncate(reason || `被驳回后进入第 ${wf.iterationRound} 轮迭代`, 300);
  } else {
    wf.requirementStatus = 'terminated';
    wf.terminatedAt = ts;
    wf.terminatedBy = role;
    wf.terminationReason = truncate(reason, 300);
    task.workflow = wf;
    task.status = 'done';
    task.doneAt = ts;
    task.evidence = truncate(reason || 'PM 终止需求', 500);
    task.updatedAt = ts;
    task._by = role;
    task._action = 'terminate';
    task._note = truncate(reason || '被驳回后终止', 300);
  }

  closedTasks = closeChildTasks(project, task.id, reason, role, action, ts);
  saveTask(project, task);
  const sync = syncWorkflowRow(project, task, wf.requirementStatus, {
    iterationRound: wf.iterationRound,
    iterationAt: wf.iterationAt,
    iterationBy: wf.iterationBy,
    iterationReason: wf.iterationReason,
    terminatedAt: wf.terminatedAt,
    terminatedBy: wf.terminatedBy,
    terminationReason: wf.terminationReason,
  }, {
    create: true,
    action,
    by: role,
    note: truncate(reason || '', 300),
    advanceRound,
    phaseAfter: deriveProjectPhase,
  });
  appendEvent({
    role,
    sessionId,
    action: action === 'iterate' ? 'req_iterate' : 'req_terminate',
    project,
    target: task.id,
    note: truncate(reason || `${task.id} ${action}`, 120),
    data: {
      requirementId: task.id,
      status: wf.requirementStatus,
      iterationRound: wf.iterationRound || null,
      closedTasks,
      workflowFile: sync.file,
    },
  });
  return {
    requirement: task,
    action,
    workflowFile: sync.file,
    workflow: sync.state,
    closedTasks,
  };
}

function recordWorkflowEvent(state, event) {
  state.events = Array.isArray(state.events) ? state.events : [];
  state.events.push(event);
  if (state.events.length > 300) state.events = state.events.slice(-300);
}

/**
 * 项目级工作流：给工作台旧协议 workflow iterate / terminate 用。
 * 兼容工作台的去重口径：事件 note 与它随后写入的一致，避免同一次迭代/终止记两遍。
 */
export function workflowAction({
  project, action, role = 'pm', sessionId = '', opinion = '', requirementId = '', force = false,
}) {
  if (!['iterate', 'terminate'].includes(action)) {
    fail('BAD_ACTION', `workflow 只支持 iterate / terminate：${action}`, { action });
  }
  const before = readWorkflowState(project);
  const state = before.state;
  const ts = nowIso();
  const transitioned = [];
  const closedTasks = [];
  const tasks = listTasks(project).filter((row) => row && row.type === 'requirement');
  const taskById = new Map(tasks.map((row) => [String(row.id), row]));

  if (action === 'iterate') {
    const fromRound = Math.max(1, Number(state.round) || 1);
    const nextRound = fromRound + 1;
    if (requirementId) {
      const task = taskById.get(String(requirementId));
      if (!task) fail('TASK_NOT_FOUND', `需求不存在：${requirementId}`);
      const moved = transitionRequirement({
        project, task, action: 'iterate', role, sessionId, reason: opinion, force, advanceRound: true,
      });
      transitioned.push(task.id);
      closedTasks.push(...moved.closedTasks);
    } else {
      // 被驳回且仍在当前轮的需求，随项目迭代进入下一轮；已 accepted/terminated/iteration 的不动。
      for (const task of tasks) {
        const status = String((task.workflow && task.workflow.requirementStatus) || '');
        if (CLOSED.has(status)) continue;
        const evidence = rejectionEvidence(project, task);
        if (status !== 'rejected' && !evidence.length) continue;
        try {
          const moved = transitionRequirement({
            project, task, action: 'iterate', role, sessionId, reason: opinion, force: true, advanceRound: true,
          });
          transitioned.push(task.id);
          closedTasks.push(...moved.closedTasks);
        } catch (e) {
          if (e.code !== 'REQUIREMENT_CLOSED') throw e;
        }
      }
    }
    const after = readWorkflowState(project);
    const writtenState = after.state;
    writtenState.round = nextRound;
    writtenState.phase = 'iteration';
    writtenState.iterationAt = ts;
    writtenState.iterationBy = role;
    writtenState.iterationOpinion = truncate(opinion, 1000);
    // 只有工作流行、没有团队任务的旧需求也要同步：不能只推进有任务文件的那一半。
    const taskIds = new Set(tasks.map((row) => String(row.id)));
    for (const [id, row] of Object.entries(writtenState.requirements || {})) {
      if (taskIds.has(String(id))) continue;
      if (String((row && row.status) || '') !== 'rejected') continue;
      row.status = 'iteration';
      row.queued = false;
      row.round = nextRound;
      row.iterationRound = Number(row.iterationRound || 0) + 1;
      row.iterationAt = ts;
      row.iterationBy = role;
      row.iterationReason = truncate(opinion, 300);
      row.updatedAt = ts;
      appendRowHistory(row, { at: ts, action: 'iterate', by: role, note: truncate(opinion || '', 300) });
      transitioned.push(String(id));
    }
    recordWorkflowEvent(writtenState, {
      at: ts,
      action: 'iterate',
      role,
      project,
      note: `第 ${fromRound} 轮 → 第 ${nextRound} 轮`,
    });
    const written = writeWorkflowState(project, writtenState);
    appendEvent({
      role, sessionId, action: 'workflow_iterate', project, target: written.file,
      note: `round ${fromRound} → ${nextRound}`, data: { fromRound, round: nextRound, transitioned, closedTasks },
    });
    return {
      ok: true,
      action,
      round: nextRound,
      fromRound,
      nextRound: nextRound,
      transitioned,
      closedTasks,
      workflowFile: written.file,
      workflow: written.state,
    };
  }

  // terminate：本轮所有未收口需求 + 旧任务一起终止；accepted 不再动。
  const ids = new Set();
  for (const [id, row] of Object.entries(state.requirements || {})) {
    if (!TERMINAL.has(String(row.status || ''))) ids.add(String(id));
  }
  for (const task of tasks) {
    const status = String((task.workflow && task.workflow.requirementStatus) || '');
    if (!TERMINAL.has(status) && task.status !== 'done') ids.add(String(task.id));
  }
  for (const id of ids) {
    const task = taskById.get(String(id));
    if (task) {
      try {
        const moved = transitionRequirement({
          project, task, action: 'terminate', role, sessionId, reason: opinion, force: true,
        });
        // 工作台的终止回执把“需求任务本身”也算 closedTasks；一并返回，避免它只收到子任务。
        closedTasks.push(task.id, ...moved.closedTasks);
      } catch (e) {
        if (e.code !== 'REQUIREMENT_CLOSED') throw e;
      }
    } else {
      // 只有 工作流.json 行、没有团队任务的旧需求，也计入 stopped。
    }
  }
  const after = readWorkflowState(project);
  const writtenState = after.state;
  writtenState.phase = 'terminated';
  writtenState.terminatedAt = ts;
  writtenState.terminatedBy = role;
  writtenState.terminationOpinion = truncate(opinion, 1000);
  for (const id of ids) {
    const row = writtenState.requirements[id] || { id, round: Number(writtenState.round) || 1, history: [] };
    if (TERMINAL.has(String(row.status || ''))) continue;
    row.status = 'terminated';
    row.updatedAt = ts;
    row.terminatedAt = ts;
    row.terminatedBy = role;
    appendRowHistory(row, { at: ts, action: 'terminate', by: role, note: truncate(opinion, 300) });
    writtenState.requirements[id] = row;
  }
  recordWorkflowEvent(writtenState, {
    at: ts,
    action: 'terminate',
    role,
    project,
    note: truncate(opinion, 1000),
  });
  const written = writeWorkflowState(project, writtenState);
  appendEvent({
    role, sessionId, action: 'workflow_terminate', project, target: written.file,
    note: truncate(opinion || '终止工作流', 120), data: { stopped: [...ids], closedTasks },
  });
  return {
    ok: true,
    action,
    terminated: true,
    stopped: [...ids],
    closedTasks,
    workflowFile: written.file,
    workflow: written.state,
  };
}
