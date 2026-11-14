/**
 * R-b5fc F-2/F-3/F-3b/F-4/F-6：看板驱动的路由守护（只读真相 + 只读前置判定 + 幂等 + 心跳）。
 *
 * 硬约束（写进代码，不做例外）：
 * - 只读 `工作流.json` 与 `任务/*.json`；本模块**从不写**它们，也不替角色过门禁。
 * - 只写派生与留痕：`role_queues.json`（F-1 导出）、`路由守护.jsonl`（F-6 日志）、
 *   `守护状态.json`（F-6 心跳）、`路由快照.json`（守护自己的续跑快照，不冒充真相）。
 * - 唤醒只带 `taskId + action`（见 buildRouteWakeText），不带需求正文。
 * - 幂等键 `requirementId|toStatus|action|taskId`，窗口 TEAM_ROUTE_IDEMPOTENT_HOURS（默认 24 小时）。
 * - 单实例锁 `路由守护-<项目>`（TTL 30 秒，每拍续期）；后启动者只读并告警。
 *
 * 事件源（F-3b，只认这四类，表外一律 skip）：
 *   status     requirements[<id>].status 变化
 *   trq        requirements[<id>].trq.verdict 变化
 *   decisions  requirements[<id>].decisions[] 长度 +1
 *   task       任务 status / reopenCount 变化（只路由 B-* 缺陷任务）
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  PATHS, fail, nowIso, exists, ensureDir, readJson, writeJson, appendLine,
  readJsonlTolerant, sha256,
  acquireLock, heartbeatLock, releaseLock, lockInfo,
} from './core.mjs';
import {
  loadProject, projectTeamMode, projectStatePaths, loadTeam, getMember, sendMessage, listTasks,
} from './store.mjs';
import {
  gateRequirementReview, gateOwnerDecision, gateTestability, ownerDecisionsOf,
} from './gates.mjs';
import { requirementReviewer } from './roles.mjs';
import { activeProxyFor } from './owner-proxy.mjs';
import { addDecision } from './decision-box.mjs';
import { ROLE_QUEUE_FILE, buildRoleQueues, writeRoleQueues } from './route-queues.mjs';
import { DshClient } from './dsh-session.mjs';

// ---------- 文件名与常量（三个新文件在此处集中声明，便于产品登记字段表） ----------
export const ROUTE_LOG_FILE = '路由守护.jsonl';
export const ROUTE_STATUS_FILE = '守护状态.json';
export const ROUTE_SNAPSHOT_FILE = '路由快照.json';
export const ROUTE_SCHEMA = 1;
export const ROUTE_DAEMON_VERSION = 'b5fc-route-1';
export const ROUTE_LOCK_KEY_PREFIX = '路由守护-';
/** 事件类型：与需求 F-6 的日志枚举一致，不另造。 */
export const ROUTE_EVENTS = Object.freeze(['state_change', 'wake', 'skip', 'wake_failed', 'gate_blocked']);
/** 事件源：F-3b 四类，表外不存在。 */
export const ROUTE_SOURCES = Object.freeze(['status', 'trq', 'decisions', 'task']);

const DEFAULT_TICK_MS = 30 * 1000;
const DEFAULT_IDEMPOTENT_HOURS = 24;
const DEFAULT_FOLLOWUP_MS = 30 * 1000;
const DEFAULT_BEAT_MS = 30 * 1000;
const STALE_BEATS = 3;
const STALE_DEDUPE_MS = 10 * 60 * 1000;
/** B-e7b6：同一缺陷的升级告警只发一次，窗口按 bug 任务 id 去重（10 分钟）。 */
const ESCALATION_DEDUPE_MS = 10 * 60 * 1000;
/** 铁律 29：角色手上任务 10 分钟内刚开工 → 视为忙，不补唤醒、不占 3 次预算。 */
const ROLE_BUSY_WINDOW_MS = 10 * 60 * 1000;
const LOCK_TTL_MS = 30 * 1000;
const QUEUE_ERROR_DEDUPE_MS = 60 * 60 * 1000;

function envMs(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}
function envNumber(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** 三次重试节奏，沿用 c651 口径（5/15/30 秒）；TEAM_WAKE_RETRY_MS 可覆盖（测试注入）。 */
function retryStages() {
  const list = String(process.env.TEAM_WAKE_RETRY_MS || '5000,15000,30000')
    .split(',').map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 0);
  return list.length ? list : [5000, 15000, 30000];
}
/** 退避再唤醒的三档（30/60/120 秒），基数可注入（测试用 TEAM_ROUTE_FOLLOWUP_MS）。 */
function followUpStagesMs() {
  const base = envMs('TEAM_ROUTE_FOLLOWUP_MS', DEFAULT_FOLLOWUP_MS);
  // Owner 2026-11-14 09:10：路由补催最多 1 次（followup:1 之后不再催）。
  return [base];
}
export function routeTickMs() {
  return envMs('TEAM_ROUTE_TICK_MS', DEFAULT_TICK_MS);
}
export function daemonBeatMs() {
  return envMs('TEAM_DAEMON_BEAT_MS', DEFAULT_BEAT_MS);
}
export function idempotentWindowMs() {
  const hours = envNumber('TEAM_ROUTE_IDEMPOTENT_HOURS', DEFAULT_IDEMPOTENT_HOURS);
  return hours * 60 * 60 * 1000;
}

export function routePaths(projectName) {
  const dir = projectStatePaths(String(projectName || '').trim()).dir;
  return {
    dir,
    log: path.join(dir, ROUTE_LOG_FILE),
    status: path.join(dir, ROUTE_STATUS_FILE),
    snapshot: path.join(dir, ROUTE_SNAPSHOT_FILE),
    queue: path.join(dir, ROLE_QUEUE_FILE),
    workflow: path.join(dir, '工作流.json'),
    tasks: path.join(dir, '任务'),
  };
}

// ---------- 读真相（只读） ----------

/** 读 工作流.json 原始字节：sha 用原始字节算（BOM 不影响），坏了不猜、不覆盖。 */
export function readWorkflowRaw(projectName) {
  const file = routePaths(projectName).workflow;
  if (!exists(file)) return { file, exists: false, sha256: '', wf: {}, corrupt: '' };
  const raw = fs.readFileSync(file);
  const hash = sha256(raw);
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    return { file, exists: true, sha256: hash, wf: null, corrupt: String((e && e.message) || e) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { file, exists: true, sha256: hash, wf: null, corrupt: '工作流.json 不是对象' };
  }
  return { file, exists: true, sha256: hash, wf: parsed, corrupt: '' };
}

/** requirements 兼容对象/数组两式（与 lifecycle.normalizeRequirements 同口径，但不写盘）。 */
export function normalizeRows(raw) {
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

function taskListOf(projectName) {
  const dir = routePaths(projectName).tasks;
  if (!exists(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const row = readJson(path.join(dir, name), null);
    if (row && typeof row === 'object' && row.id) out.push(row);
  }
  return out;
}

/** 任务指纹：守护要能感知任务状态/reopenCount 变化，而它们不改 工作流.json 的 sha。 */
function tasksFingerprint(tasks) {
  const lines = tasks
    .map((t) => `${t.id}:${t.status || ''}:${Number(t.reopenCount || 0)}:${t.owner || ''}`)
    .sort();
  return sha256(lines.join('\n'));
}

/** 快照 = 守护自己的续跑基线（派生品，删了只影响“能否补发历史”，不影响真相）。 */
export function buildSnapshot(projectName) {
  const wfRaw = readWorkflowRaw(projectName);
  if (wfRaw.corrupt) {
    fail('WORKFLOW_CORRUPT', `工作流.json 无法解析，路由守护拒绝猜测状态：${wfRaw.corrupt}`, { file: wfRaw.file });
  }
  const rows = normalizeRows(wfRaw.wf.requirements);
  const tasks = taskListOf(projectName);
  const requirements = {};
  for (const [id, row] of Object.entries(rows)) {
    requirements[id] = {
      status: String(row.status || ''),
      decisions: ownerDecisionsOf(row).length,
      trqVerdict: String((row.trq && row.trq.verdict) || ''),
      updatedAt: String(row.updatedAt || ''),
    };
  }
  const taskMap = {};
  for (const task of tasks) {
    taskMap[String(task.id)] = {
      status: String(task.status || ''),
      reopenCount: Number(task.reopenCount || 0),
      owner: String(task.owner || ''),
      requirementId: String(task.requirementId || ''),
    };
  }
  return {
    schema: ROUTE_SCHEMA,
    daemon: ROUTE_DAEMON_VERSION,
    at: nowIso(),
    sha256: wfRaw.sha256,
    taskFingerprint: tasksFingerprint(tasks),
    requirements,
    tasks: taskMap,
  };
}

/** 读快照：不存在/损坏都返回 ok:false（由调用方决定重建与告警）。 */
export function readSnapshot(projectName) {
  const file = routePaths(projectName).snapshot;
  if (!exists(file)) return { ok: false, reason: 'missing', file, snapshot: null };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, reason: 'corrupt', file, snapshot: null, error: String((e && e.message) || e) };
  }
  if (!data || typeof data !== 'object' || !data.requirements || typeof data.requirements !== 'object') {
    return { ok: false, reason: 'corrupt', file, snapshot: null, error: '快照格式不对（缺 requirements）' };
  }
  return { ok: true, file, snapshot: data };
}

export function writeSnapshot(projectName, snapshot) {
  const file = routePaths(projectName).snapshot;
  writeJson(file, snapshot);
  return file;
}

// ---------- 事件派生（纯函数，便于沙盘断言） ----------

/**
 * 对比上一快照与当前真值，产出事件流（F-3b 四类事件源）。
 * 返回的每条事件只描述“发生了什么”，**不代表要不要唤醒**（那是 planEvent 的事）。
 */
export function diffSnapshot(prev, curr) {
  const events = [];
  const prevRows = (prev && prev.requirements) || {};
  const prevTasks = (prev && prev.tasks) || {};
  for (const [id, row] of Object.entries((curr && curr.requirements) || {})) {
    const before = prevRows[id];
    const status = String(row.status || 'open');
    if (!before) {
      events.push({ source: 'status', requirementId: id, fromStatus: '', toStatus: status, triggerChange: '', newRequirement: true });
      continue;
    }
    if (String(before.status || '') !== status) {
      events.push({ source: 'status', requirementId: id, fromStatus: String(before.status || ''), toStatus: status, triggerChange: '' });
    }
    if (String(before.trqVerdict || '') !== String(row.trqVerdict || '')) {
      events.push({
        source: 'trq', requirementId: id, fromStatus: status, toStatus: status,
        triggerChange: 'trq.verdict', value: String(row.trqVerdict || ''),
      });
    }
    if (Number(before.decisions || 0) !== Number(row.decisions || 0)) {
      events.push({
        source: 'decisions', requirementId: id, fromStatus: status, toStatus: status,
        triggerChange: 'decisions.length', value: Number(row.decisions || 0),
      });
    }
  }
  // 任务事件只路由 B-* 缺陷任务：普通任务的状态变化由 requirements.status 覆盖，避免刷屏。
  for (const [id, task] of Object.entries((curr && curr.tasks) || {})) {
    if (!id.startsWith('B-')) continue;
    const before = prevTasks[id];
    if (!before) {
      events.push({
        source: 'task', taskId: id, requirementId: String(task.requirementId || ''),
        triggerChange: 'task.status', taskFromStatus: '', taskToStatus: String(task.status || ''),
      });
      continue;
    }
    if (String(before.status || '') !== String(task.status || '')) {
      events.push({
        source: 'task', taskId: id, requirementId: String(task.requirementId || ''),
        triggerChange: 'task.status', taskFromStatus: String(before.status || ''), taskToStatus: String(task.status || ''),
      });
    } else if (Number(before.reopenCount || 0) !== Number(task.reopenCount || 0)) {
      events.push({
        source: 'task', taskId: id, requirementId: String(task.requirementId || ''),
        triggerChange: 'task.reopenCount', taskToStatus: String(task.status || ''),
        reopenCount: Number(task.reopenCount || 0),
      });
    }
  }
  return events;
}

// ---------- 规则表（F-3 写死）+ 只读前置判定（F-2） ----------

/** 承载该需求的最新开发任务 owner（程序员A/B）；没有就空字符串（不猜）。 */
export function carrierOf(requirementId, tasks) {
  const hit = tasks
    .filter((t) => String(t.requirementId || '') === String(requirementId || '')
      && ['programmer1', 'programmer2'].includes(String(t.owner || '')))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
  return hit ? String(hit.owner) : '';
}

function taskForRequirement(requirementId, tasks) {
  return tasks.find((t) => String(t.id) === String(requirementId)) || null;
}

function tasksOf(requirementId, tasks, pred) {
  return tasks.filter((t) => String(t.requirementId || '') === String(requirementId || '') && pred(t));
}

/**
 * 由“当前真值”推出下一步该谁做什么（不依赖事件从哪来）。
 * 返回 { role, action, gate } 或 { skip: why } 或 { gateBlocked: {code,gate,message} }。
 */
export function planForRow(row, ctx) {
  const { tasks = [], projectPath = '', mode = 'full' } = ctx;
  const id = String(row.id || '');
  const status = String(row.status || 'open');
  const reviewer = requirementReviewer(mode);
  if (status === 'open') {
    const review = row.productReview || row.requirementReview || null;
    if (review && String(review.verdict || '') === 'approve') return { skip: 'open_already_reviewed' };
    return { role: reviewer, action: 'review', gate: null };
  }
  if (status === 'ready') {
    const verdict = String((row.trq && row.trq.verdict) || '');
    if (verdict === 'not_testable') return { skip: 'trq_not_testable' };
    if (verdict !== 'testable') return { role: 'tester', action: 'trq', gate: null };
    const decisions = ownerDecisionsOf(row);
    const latest = decisions.length ? decisions[decisions.length - 1] : null;
    if (!latest) {
      const gate = gateTestability({ projectPath, task: taskForRequirement(id, tasks), row });
      return gate ? { gateBlocked: gate } : { role: 'pm', action: 'decide', gate: 'G2.5', ownerGate: true };
    }
    const decided = String(latest.status || latest.decision || '');
    if (decided === 'rejected') {
      return { role: carrierOf(id, tasks) || 'analyst', action: 'rework', gate: null };
    }
    // 已落过 Owner 决定却还停在 ready：历史漂移，不重复叫（PM 兜底推进状态，守护不改真相）。
    return { skip: 'already_decided' };
  }
  if (status === 'approved') {
    const gate = gateOwnerDecision(row);
    if (gate) return { gateBlocked: gate };
    const role = carrierOf(id, tasks);
    if (!role) return { skip: 'no_carrier_task', alertPm: true };
    return { role, action: 'develop', gate: 'G3' };
  }
  if (status === 'dev_done') {
    const devs = tasksOf(id, tasks, (t) => ['programmer1', 'programmer2'].includes(String(t.owner || '')));
    if (!devs.length) return { skip: 'no_dev_task' };
    const undone = devs.filter((t) => String(t.status || '') !== 'done');
    if (undone.length) {
      return { gateBlocked: { code: 'DEV_TASKS_UNDONE', gate: 'DEV', message: `${undone.length} 个开发任务未完成：${undone.map((t) => t.id).slice(0, 3).join(',')}` } };
    }
    return { role: 'tester', action: 'test' };
  }
  if (status === 'test_done') {
    const tests = tasksOf(id, tasks, (t) => String(t.owner || '') === 'tester');
    if (!tests.length) return { skip: 'no_test_task', alertPm: true };
    const undone = tests.filter((t) => String(t.status || '') !== 'done');
    if (undone.length) {
      return { gateBlocked: { code: 'TEST_TASKS_UNDONE', gate: 'TEST', message: `${undone.length} 个测试任务未完成：${undone.map((t) => t.id).slice(0, 3).join(',')}` } };
    }
    return { role: 'pm', action: 'accept' };
  }
  if (status === 'rejected') return { role: carrierOf(id, tasks) || 'analyst', action: 'rework', gate: null };
  if (status === 'iteration') return { skip: 'iteration_parked' };
  if (['accepted', 'done', 'terminated'].includes(status)) return { skip: 'closed' };
  return { skip: 'unmapped_status' };
}

/**
 * 状态迁移上的前置门禁（只读判定，绝不代角色过门禁）：
 * - → ready：G2 需求评审通过（针对当前正文）；
 * - → approved：G3 Owner 决定（与 planForRow 同一判据，这里显式给出 gate_blocked 归因）；
 * - 其它迁移：无门禁。
 */
export function transitionGate(event, row, ctx) {
  const { tasks = [], projectPath = '' } = ctx;
  if (!event || event.source !== 'status') return null;
  const to = String(event.toStatus || '');
  const task = taskForRequirement(String(row.id || ''), tasks);
  if (to === 'ready') return gateRequirementReview(row, task, projectPath);
  if (to === 'approved') return gateOwnerDecision(row);
  return null;
}

/** B-* 缺陷任务的旁路计划（F-4）：working → 开发 fix；done → 测试 verify。 */
export function planForBugTask(task) {
  const status = String(task.status || '');
  const owner = String(task.owner || '');
  if (status === 'done') return { role: 'tester', action: 'verify', gate: null };
  if (status === 'working' || status === 'open') {
    if (!owner) return { skip: 'bug_without_owner', alertPm: true };
    return { role: owner, action: 'fix', gate: null };
  }
  return { skip: 'bug_status_unmapped' };
}

// ---------- 幂等键 ----------

export function routeKey({ requirementId = '', toStatus = '', action = '', taskId = '' } = {}) {
  return `${requirementId || '-'}|${toStatus || '-'}|${action || '-'}|${taskId || '-'}`;
}

function withinWindow(lastAtIso, windowMs, nowMs) {
  if (!windowMs) return false;
  const t = Date.parse(String(lastAtIso || ''));
  if (Number.isNaN(t)) return false;
  return nowMs - t < windowMs;
}

// ---------- 日志 / 状态文件 ----------

const LOG_FIELDS = ['at', 'event', 'source', 'requirementId', 'fromStatus', 'toStatus', 'role', 'action', 'taskId', 'gate', 'ok', 'why', 'wakeRef', 'triggerChange'];

/** 写一行路由日志（只允许 F-6 字段 + 幂等键 key，不自由加字段）。 */
export function appendRouteLog(projectName, row) {
  const base = { at: nowIso() };
  for (const f of LOG_FIELDS) {
    if (f === 'at') continue;
    base[f] = row[f] === undefined || row[f] === null ? '' : row[f];
  }
  if (row.key) base.key = String(row.key);
  if (row.gateResult) base.gateResult = String(row.gateResult);
  appendLine(routePaths(projectName).log, JSON.stringify(base));
  return base;
}

export function readRouteLog(projectName, { tail = 0 } = {}) {
  const { items } = readJsonlTolerant(routePaths(projectName).log);
  return tail > 0 ? items.slice(-tail) : items;
}

function emptyStatus(projectName) {
  return {
    schema: ROUTE_SCHEMA,
    version: ROUTE_DAEMON_VERSION,
    project: String(projectName || ''),
    alive: false,
    lastBeatAt: '',
    pid: 0,
    host: '',
    lastSourceSha: '',
    startedAt: '',
    ticks: 0,
    wakes: {},
    retries: {},
    followUps: {},
    wakeFailedSent: {},
    staleAlertAt: '',
    queueErrorAt: '',
    queueError: '',
  };
}

export function readDaemonStatus(projectName) {
  const file = routePaths(projectName).status;
  const raw = exists(file) ? readJson(file, null) : null;
  if (!raw || typeof raw !== 'object') return { ...emptyStatus(projectName), file };
  return {
    ...emptyStatus(projectName),
    ...raw,
    wakes: raw.wakes && typeof raw.wakes === 'object' ? raw.wakes : {},
    retries: raw.retries && typeof raw.retries === 'object' ? raw.retries : {},
    followUps: raw.followUps && typeof raw.followUps === 'object' ? raw.followUps : {},
    wakeFailedSent: raw.wakeFailedSent && typeof raw.wakeFailedSent === 'object' ? raw.wakeFailedSent : {},
    file,
  };
}

function writeDaemonStatus(projectName, status) {
  const next = { ...status };
  delete next.file;
  writeJson(routePaths(projectName).status, next);
  return next;
}

/** 状态文件丢了但日志还在：用日志里的 wake 行重建幂等索引（重启不重复唤醒）。 */
function rebuildWakesFromLog(projectName, status) {
  if (Object.keys(status.wakes || {}).length) return status;
  const rows = readRouteLog(projectName);
  for (const row of rows) {
    if (String(row.event) !== 'wake' || !row.key) continue;
    status.wakes[row.key] = {
      at: String(row.at || ''),
      lastWakeAt: String(row.at || ''),
      role: String(row.role || ''),
      action: String(row.action || ''),
      requirementId: String(row.requirementId || ''),
      taskId: String(row.taskId || ''),
    };
  }
  return status;
}

// ---------- 唤醒（只带 taskId + action） ----------

/** 唤醒正文：只带 taskId + action（+ 定位用的需求/任务 id 与状态），绝不含需求正文。 */
export function buildRouteWakeText({ role = '', action = '', requirementId = '', taskId = '', project = '', fromStatus = '', toStatus = '' } = {}) {
  const locator = [
    requirementId ? `需求 ${requirementId}` : '',
    taskId ? `任务 ${taskId}` : '',
  ].filter(Boolean).join(' ｜ ');
  return [
    `【看板路由唤醒】action=${action}`,
    `项目：${project}${locator ? ` ｜ ${locator}` : ''}`,
    fromStatus || toStatus ? `状态：${fromStatus || '-'} → ${toStatus || '-'}` : '',
    '这条唤醒只带 taskId+action：需要做什么由你的角色卡与任务/需求文件决定，正文不在这里。',
    '没有启动令牌就先 boot，再执行；完成后回执 + task done --evidence。',
  ].filter(Boolean).join('\n');
}

function engineUrlOf(override) {
  let engine = String(override || '') || String(process.env.DSH_WEB_URL || '');
  if (!engine) {
    try { engine = String(readJson(path.join(PATHS.state, '当前工作区.json'), {}).engineUrl || ''); } catch { /* 没有工作区文件 */ }
  }
  return engine;
}

/**
 * 真正推一条路由唤醒。沙盘（TEAM_SELFTEST=1）或 TEAM_ROUTE_WAKE=off 时不发网络请求，
 * 返回 {ok:true, skipped:'SELFTEST'}，让沙盘能验“该唤醒谁、叫什么”而不骚扰真实会话。
 */
export async function deliverRouteWake(projectName, { role, text, engineUrl = '' } = {}) {
  if (process.env.TEAM_SELFTEST === '1' || String(process.env.TEAM_ROUTE_WAKE || '') === 'off') {
    return { ok: true, skipped: 'SELFTEST', role };
  }
  let member = null;
  try { member = getMember(loadTeam(), role); } catch (e) { return { ok: false, why: String((e && e.message) || e) }; }
  const sessionId = String((member && member.sessionId) || '');
  if (!sessionId) return { ok: false, why: `角色 ${role} 还没有 DSH 会话` };
  const engine = engineUrlOf(engineUrl);
  if (!engine) return { ok: false, why: '没有 engineUrl；无法唤醒目标会话' };
  try {
    await new DshClient(engine).prompt({ sessionId, text, mode: 'queue' });
    return { ok: true, role, sessionId };
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e), code: String((e && e.code) || '') };
  }
}

function alertPm(projectName, { type = 'wake_failed', subject = '', body = '', key = '' } = {}) {
  const status = readDaemonStatus(projectName);
  const dedupeKey = String(key || subject || 'alert');
  if (status.wakeFailedSent[dedupeKey]) return { ok: true, skipped: 'DEDUPED', messageId: status.wakeFailedSent[dedupeKey].messageId };
  let msg = null;
  try {
    msg = sendMessage({ from: 'system', to: 'pm', type, project: projectName, subject, body, ackRequired: false });
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e) };
  }
  status.wakeFailedSent[dedupeKey] = { at: nowIso(), messageId: msg.id, type };
  writeDaemonStatus(projectName, status);
  return { ok: true, messageId: msg.id };
}

// ---------- 单拍执行 ----------

function acquireDaemonLock(projectName) {
  const key = `${ROUTE_LOCK_KEY_PREFIX}${projectName}`;
  try {
    acquireLock(key, { role: 'system', sessionId: 'route-daemon', ttlMs: LOCK_TTL_MS, waitMs: 0, reason: '路由守护' });
    return { ok: true, key };
  } catch (e) {
    return { ok: false, key, why: String((e && e.message) || e), code: String((e && e.code) || '') };
  }
}

function holdDaemonLock(projectName, key) {
  try {
    heartbeatLock(key, { role: 'system', ttlMs: LOCK_TTL_MS });
    return true;
  } catch {
    // 锁被别人按 TTL 收走了（例如进程被挂起）：重新抢一次，抢不到就退出本拍。
    const again = acquireDaemonLock(projectName);
    return again.ok;
  }
}

function requirementRowsOf(wfRaw) {
  return normalizeRows(wfRaw && wfRaw.wf ? wfRaw.wf.requirements : null);
}

function isBugTask(taskId) {
  return String(taskId || '').startsWith('B-');
}

/** 队列里该角色是否还有该需求（F-2 ⑤ 判“回执完就停”的本地证据）。 */
function queueStillHas(projectName, role, requirementId, tasks) {
  if (!requirementId) return false;
  let payload = null;
  try { payload = buildRoleQueues(projectName); } catch { payload = null; }
  const list = (payload && payload.roles && payload.roles[role] && payload.roles[role].queue) || [];
  if (list.some((item) => String(item.requirementId || '') === String(requirementId))) return true;
  // 队列口径可能漏（比如状态刚变），再用任务证据兜一层：该角色名下该需求有未完成任务也算没做完。
  return tasks.some((t) => String(t.requirementId || '') === String(requirementId)
    && String(t.owner || '') === String(role)
    && String(t.status || '') !== 'done');
}

/**
 * 路由一拍：读真相 → 比对快照 → 逐事件过只读门禁 → 幂等 → 唤醒 → 留痕 → 心跳。
 * 不写 工作流.json / 任务/*.json；任何失败只留痕与告警，不阻断下一拍。
 */
export async function routeTick(projectName, { engineUrl = '', now = Date.now(), lockKey = '', releaseAtEnd = true } = {}) {
  const name = String(projectName || '').trim();
  if (!name) fail('BAD_PROJECT', '需要项目名');
  const project = loadProject(name); // 项目不存在按原错误码失败
  const mode = projectTeamMode(project);
  const paths = routePaths(name);
  ensureDir(paths.dir);

  const lock = lockKey ? { ok: true, key: lockKey } : acquireDaemonLock(name);
  if (!lock.ok) {
    appendRouteLog(name, { event: 'skip', source: 'status', why: `daemon_lock_busy: ${lock.why}`, ok: false });
    alertPm(name, {
      type: 'wake_failed',
      subject: `路由守护未启动：锁被占用（${name}）`,
      body: `单实例锁 ${lock.key} 被占用，本拍没有路由任何事件。\n原因：${lock.why}\n后启动者只读、不抢锁；等当前守护退出或锁 TTL（30 秒）过期。`,
      key: `lock_busy|${name}|${Math.floor(now / (10 * 60 * 1000))}`,
    });
    return { ok: true, skipped: 'DAEMON_LOCK_BUSY', lock };
  }

  const status = rebuildWakesFromLog(name, readDaemonStatus(name));
  status.alive = true;
  status.lastBeatAt = nowIso();
  status.pid = process.pid;
  status.host = String(process.env.COMPUTERNAME || '');
  status.version = ROUTE_DAEMON_VERSION;
  status.ticks = Number(status.ticks || 0) + 1;
  if (!status.startedAt) status.startedAt = nowIso();

  const out = { ok: true, project: name, mode, ticks: status.ticks, events: [], wakes: [], skips: [], gateBlocked: [], followUps: [], retries: [], baseline: false, changed: false };

  /** 每拍收尾：续租锁 → 落心跳 → （一次性调用才释放锁）。 */
  const finishTick = (extra = {}) => {
    status.alive = true;
    status.lastBeatAt = nowIso();
    holdDaemonLock(name, lock.key);
    writeDaemonStatus(name, status);
    if (releaseAtEnd && !lockKey) {
      try { releaseLock(lock.key, { role: 'system' }); } catch { /* 锁已被 TTL 收走 */ }
    }
    return extra;
  };

  /** 派生队列刷新（每拍都刷，含基线拍；写失败保留上一版并告警，绝不删旧文件）。 */
  const refreshQueue = () => {
    try {
      const exported = writeRoleQueues(name);
      if (!exported.ok) {
        const last = Date.parse(String(status.queueErrorAt || ''));
        if (!last || now - last > QUEUE_ERROR_DEDUPE_MS) {
          status.queueErrorAt = nowIso();
          status.queueError = String(exported.error || exported.code || '');
          alertPm(name, {
            type: 'wake_failed',
            subject: `角色队列导出失败（${name}）`,
            body: `role_queues.json 写入失败：${status.queueError}\n已保留上一版，守护继续按真相路由。`,
            key: `queue_export_failed|${name}|${Math.floor(now / (60 * 60 * 1000))}`,
          });
        }
      } else {
        status.queueErrorAt = '';
        status.queueError = '';
      }
    } catch (e) {
      status.queueError = String((e && e.message) || e);
    }
  };

  const wfRaw = readWorkflowRaw(name);
  if (wfRaw.corrupt) {
    appendRouteLog(name, { event: 'skip', source: 'status', why: 'workflow_corrupt', ok: false, fromStatus: '', toStatus: '' });
    alertPm(name, {
      type: 'wake_failed',
      subject: `路由守护跳过：工作流.json 损坏（${name}）`,
      body: `无法解析：${wfRaw.corrupt}\n守护不猜状态、不改文件；请先备份并修复 工作流.json，再重启守护。`,
      key: `workflow_corrupt|${name}|${Math.floor(now / (60 * 60 * 1000))}`,
    });
    return finishTick({ ...out, ok: false, skipped: 'WORKFLOW_CORRUPT' });
  }

  const snap = buildSnapshot(name);
  status.lastSourceSha = snap.sha256;
  const prevRead = readSnapshot(name);
  if (!prevRead.ok) {
    // 首次启动 / 快照损坏：只建基线，不补发历史唤醒（AC5）。
    if (prevRead.reason === 'corrupt') {
      try { fs.copyFileSync(prevRead.file, `${prevRead.file}.bak-${Date.now()}`); } catch { /* 备份失败不阻断重建 */ }
    }
    writeSnapshot(name, snap);
    const why = prevRead.reason === 'corrupt' ? 'snapshot_rebuilt' : 'snapshot_baseline';
    appendRouteLog(name, { event: 'skip', source: 'status', why, ok: true, fromStatus: '', toStatus: '' });
    if (prevRead.reason === 'corrupt') {
      alertPm(name, {
        type: 'wake_failed',
        subject: `路由守护快照损坏已重建（${name}）`,
        body: `快照 ${ROUTE_SNAPSHOT_FILE} 损坏，已备份并重建基线；本次不补发历史唤醒。`,
        key: `snapshot_rebuilt|${name}|${Math.floor(now / (60 * 60 * 1000))}`,
      });
    }
    out.baseline = true;
    refreshQueue();
    return finishTick(out);
  }

  const events = (prevRead.snapshot.sha256 === snap.sha256
    && prevRead.snapshot.taskFingerprint === snap.taskFingerprint)
    ? []
    : diffSnapshot(prevRead.snapshot, snap);
  out.changed = events.length > 0;

  const rows = requirementRowsOf(wfRaw);
  const tasks = taskListOf(name);
  const ctx = { tasks, projectPath: project.path, mode };
  const windowMs = idempotentWindowMs();

  for (const event of events) {
    const row = event.requirementId ? rows[event.requirementId] : null;
    const currentStatus = String((row && row.status) || '');
    const base = {
      source: event.source,
      requirementId: event.requirementId || '',
      fromStatus: event.source === 'status' ? String(event.fromStatus || '') : currentStatus,
      toStatus: event.source === 'status' ? String(event.toStatus || '') : currentStatus,
      triggerChange: String(event.triggerChange || ''),
      taskId: event.taskId || '',
    };
    appendRouteLog(name, { ...base, event: 'state_change', ok: true, why: '' });
    out.events.push({ ...base, value: event.value });

    // 任务事件：只处理 B-* 缺陷旁路 + 重开升级，其余任务状态变化不触发路由。
    if (event.source === 'task') {
      if (!isBugTask(event.taskId)) continue;
      const task = tasks.find((t) => String(t.id) === String(event.taskId));
      if (!task) { appendRouteLog(name, { ...base, event: 'skip', why: 'task_missing', ok: false }); out.skips.push({ ...base, why: 'task_missing' }); continue; }
      const bugPlan = planForBugTask(task);
      if (bugPlan.skip) {
        appendRouteLog(name, { ...base, event: 'skip', why: bugPlan.skip, ok: false });
        out.skips.push({ ...base, why: bugPlan.skip });
      } else {
        // 缺陷旁路的键要带“第几轮重开”，否则同一 bug 第 2 次打回会被 24 小时幂等窗口吞掉（AC4）。
        const bugKeyStatus = `task:${task.status || ''}#r${Number(task.reopenCount || 0)}`;
        const result = await wakeRoute(name, {
          role: bugPlan.role, action: bugPlan.action, requirementId: event.requirementId || '',
          taskId: event.taskId, fromStatus: base.fromStatus, toStatus: base.toStatus,
          key: routeKey({ requirementId: event.requirementId || '', toStatus: bugKeyStatus, action: bugPlan.action, taskId: event.taskId }),
          status, windowMs, now, engineUrl, source: 'task', triggerChange: base.triggerChange,
        });
        recordWake(out, result, base, bugPlan.action, bugPlan.role);
      }
      // F-4：重开次数 ≥2 → 升级 PM（type=bug_escalation，已登记 WAKE_KIND_LABEL）。
      // B-e7b6：去重键只认 bug 任务 id（10 分钟窗口），不再随任务状态/reopenCount 变化重复告警。
      const reopen = Number(task.reopenCount || 0);
      if (reopen >= 2) {
        const escKey = `bug_escalation|${event.taskId}`;
        const lastEsc = status.wakes[escKey];
        if (lastEsc && withinWindow(lastEsc.lastWakeAt, ESCALATION_DEDUPE_MS, now)) {
          appendRouteLog(name, { ...base, event: 'skip', why: 'duplicate', action: 'bug_escalation', key: escKey, ok: true });
          out.skips.push({ ...base, why: 'duplicate', action: 'bug_escalation' });
        } else {
          const alert = alertPm(name, {
            type: 'bug_escalation',
            subject: `缺陷重开 ${reopen} 次：${event.taskId}`,
            body: `任务 ${event.taskId}（需求 ${event.requirementId || '-'}）第 ${reopen} 次被打回，超过 2 次阈值。\n当前 owner=${task.owner || '-'} status=${task.status || '-'}。\n请 PM 判断是否需调整需求/换人或停手。`,
            key: escKey,
          });
          // 写盘给 PM 必须同时唤醒（只写邮箱＝没人知道）：邮件带详情，唤醒只带 taskId+action。
          const escText = buildRouteWakeText({
            role: 'pm', action: 'bug_escalation', requirementId: event.requirementId || '',
            taskId: event.taskId, project: name, fromStatus: base.fromStatus, toStatus: base.toStatus,
          });
          const escWake = await deliverRouteWake(name, { role: 'pm', text: escText, engineUrl });
          status.wakes[escKey] = { at: nowIso(), lastWakeAt: nowIso(), role: 'pm', action: 'bug_escalation', requirementId: event.requirementId || '', taskId: event.taskId };
          if (escWake.ok) {
            appendRouteLog(name, {
              ...base, event: 'wake', role: 'pm', action: 'bug_escalation', key: escKey, ok: true,
              why: `reopenCount=${reopen}`, wakeRef: String(alert.messageId || escWake.sessionId || escWake.skipped || ''),
            });
            out.wakes.push({ ...base, role: 'pm', action: 'bug_escalation', key: escKey });
          } else {
            appendRouteLog(name, {
              ...base, event: 'wake_failed', role: 'pm', action: 'bug_escalation', key: escKey, ok: false,
              why: `reopenCount=${reopen} ${String(escWake.why || '').slice(0, 160)}`, wakeRef: String(alert.messageId || ''),
            });
            out.skips.push({ ...base, role: 'pm', action: 'bug_escalation', why: 'escalation_wake_failed' });
          }
        }
      }
      continue;
    }

    if (!row) {
      appendRouteLog(name, { ...base, event: 'skip', why: 'requirement_missing', ok: false });
      out.skips.push({ ...base, why: 'requirement_missing' });
      continue;
    }
    // accepted→* 视为异常：状态回退不自动唤醒（边界：状态回退）。
    const before = event.source === 'status' ? String(event.fromStatus || '') : '';
    if (before === 'accepted' || before === 'terminated') {
      appendRouteLog(name, { ...base, event: 'gate_blocked', gate: 'STATUS_REGRESSION', why: 'closed_status_regression', ok: false });
      out.gateBlocked.push({ ...base, gate: 'STATUS_REGRESSION' });
      continue;
    }
    const gate = transitionGate(event, row, ctx);
    if (gate) {
      appendRouteLog(name, {
        ...base, event: 'gate_blocked', gate: String(gate.gate || ''), gateResult: String(gate.code || ''),
        why: String(gate.message || gate.code || 'gate_blocked').slice(0, 240), ok: false,
      });
      out.gateBlocked.push({ ...base, gate: String(gate.gate || ''), code: String(gate.code || '') });
      continue;
    }
    const plan = planForRow({ ...row, id: event.requirementId }, ctx);
    if (plan.skip) {
      appendRouteLog(name, { ...base, event: 'skip', why: plan.skip, ok: plan.skip !== 'closed' });
      out.skips.push({ ...base, why: plan.skip });
      if (plan.alertPm) {
        // 2026-11-14 修正：告警带原因码 + requirementId + stage；同需求同原因 10 分钟内不重复报。
        const codeMap = {
          no_carrier_task: 'NO_CARRIER_TASK',
          no_dev_task: 'NO_DEV_TASK',
          no_test_task: 'NO_TEST_TASK',
          no_task_owner: 'NO_TASK_OWNER',
        };
        const code = codeMap[plan.skip] || 'NO_DISPATCHABLE_TASK';
        const stage = currentStatus || 'unknown';
        const alarmKey = `no_task|${event.requirementId}|${code}`;
        const lastAlarm = Date.parse(String((status.noTaskAlerts || {})[alarmKey] || ''));
        if (!Number.isNaN(lastAlarm) && now - lastAlarm < 10 * 60 * 1000) {
          appendRouteLog(name, { ...base, event: 'skip', why: `alert_deduped(${code})`, ok: true });
          out.skips.push({ ...base, why: `alert_deduped(${code})` });
          continue;
        }
        status.noTaskAlerts = { ...(status.noTaskAlerts || {}), [alarmKey]: nowIso() };
        alertPm(name, {
          type: 'escalation',
          subject: `路由无法继续：${event.requirementId}（${code}）`,
          body: `code=${code}\nrequirementId=${event.requirementId}\nstage=${stage}\nrole=${plan.role || plan.requirementRole || '-'}\n为什么没派：${plan.skip || 'no_dispatchable_task'}\n守护不派、不猜；请 PM 补任务/指派 owner，或按原因处理。`,
          key: alarmKey,
        });
      }
      continue;
    }
    if (plan.gateBlocked) {
      appendRouteLog(name, {
        ...base, event: 'gate_blocked', gate: String(plan.gateBlocked.gate || ''), gateResult: String(plan.gateBlocked.code || ''),
        why: String(plan.gateBlocked.message || plan.gateBlocked.code || '').slice(0, 240), ok: false,
      });
      out.gateBlocked.push({ ...base, gate: String(plan.gateBlocked.gate || ''), code: String(plan.gateBlocked.code || '') });
      continue;
    }
    // Owner 09:10：需要 Owner 决策的（含验收）进 Owner 决策箱，不靠唤醒（首唤一次即止也不做）。
    if (['accept', 'decide'].includes(String(plan.action || ''))) {
      try {
        const boxed = addDecision(name, {
          title: `待 Owner 决策：${event.requirementId}`.slice(0, 40),
          summary: `${currentStatus} 阶段需要 Owner 拍板（${plan.action}）`.slice(0, 120),
          question: `需求 ${event.requirementId} 当前 ${currentStatus}，是否${plan.action === 'accept' ? '验收通过' : '放行'}？`.slice(0, 200),
          options: ['通过', '打回', '其他'],
          source: { kind: 'requirement', ref: event.requirementId },
          by: 'system',
        });
        appendRouteLog(name, { ...base, event: 'skip', why: 'owner_decision_box', role: 'pm', action: plan.action, ok: true, wakeRef: boxed.item.id });
        out.skips.push({ ...base, why: 'owner_decision_box', action: plan.action });
      } catch (e) {
        appendRouteLog(name, { ...base, event: 'skip', why: `owner_box:${String((e && e.code) || 'error')}`, role: 'pm', action: plan.action, ok: false });
        out.skips.push({ ...base, why: `owner_box:${String((e && e.code) || 'error')}`, action: plan.action });
      }
      continue;
    }
    const key = routeKey({ requirementId: event.requirementId, toStatus: base.toStatus, action: plan.action, taskId: event.taskId });
    const result = await wakeRoute(name, {
      role: plan.role, action: plan.action, requirementId: event.requirementId, taskId: event.taskId || '',
      fromStatus: base.fromStatus, toStatus: base.toStatus, key, status, windowMs, now, engineUrl,
      source: event.source, triggerChange: base.triggerChange,
    });
    recordWake(out, result, base, plan.action, plan.role);
  }

  // F-2 ⑤：唤醒后角色会话 idle 但队列里还有它的活 → 退避再唤醒（30/60/120 秒，最多 3 次）。
  out.followUps = await runFollowUps(name, { status, tasks, now, engineUrl, project });

  // 唤醒失败的重试（5/15/30 秒，共 3 次；仍失败 → PM 收 wake_failed）。
  out.retries = await runWakeRetries(name, { status, now, engineUrl, project });

  // 派生队列：每拍刷新（写失败保留上一版并告警，绝不删旧文件）。
  refreshQueue();

  if (out.changed) writeSnapshot(name, snap);
  return finishTick({ ...out, status: { lastBeatAt: status.lastBeatAt, lastSourceSha: status.lastSourceSha } });
}

function recordWake(out, result, base, action, role) {
  if (result && result.wake) {
    out.wakes.push({ ...base, role, action, key: result.key });
  } else if (result && result.skipped) {
    out.skips.push({ ...base, role, action, why: result.why || result.skipped, key: result.key });
  } else if (result && result.scheduled) {
    out.retries.push({ ...base, role, action, attempt: result.attempt, dueAt: result.dueAt });
  } else {
    out.skips.push({ ...base, role, action, why: (result && result.why) || 'wake_not_sent' });
  }
}

/** 单次路由唤醒：幂等 → 发 → 记日志 → 排 followUp / 重试。 */
async function wakeRoute(projectName, opts) {
  const {
    role, action, requirementId, taskId, fromStatus, toStatus, key, status, windowMs, now, engineUrl,
    source = 'status', triggerChange = '',
  } = opts;
  const base = { source, requirementId: requirementId || '', fromStatus: fromStatus || '', toStatus: toStatus || '', role, action, taskId: taskId || '', triggerChange, key };
  const last = status.wakes[key];
  if (last && withinWindow(last.lastWakeAt, windowMs, now)) {
    appendRouteLog(projectName, { ...base, event: 'skip', why: 'duplicate', ok: true });
    return { skipped: 'duplicate', why: 'duplicate', key };
  }
  const text = buildRouteWakeText({ role, action, requirementId, taskId, project: projectName, fromStatus, toStatus });
  const result = await deliverRouteWake(projectName, { role, text, engineUrl });
  if (result.ok) {
    const at = nowIso();
    status.wakes[key] = { at, lastWakeAt: at, role, action, requirementId: requirementId || '', taskId: taskId || '' };
    // 沙盘默认不排复查（否则每次验收跑都会拖出几百条 followup）；TEAM_ROUTE_SELFTEST_FOLLOWUP=1 时才排，
    // 让 AC/沙盘也能验「回执完就停」的退避再唤醒。
    const allowSelftestFollowUp = String(process.env.TEAM_ROUTE_SELFTEST_FOLLOWUP || '') === '1';
    // Owner 09:10：验收/决定类（accept/decide）完全不补催，首唤一次即止。
    const ownerGateAction = ['accept', 'decide'].includes(String(action || ''));
    if (!ownerGateAction && (result.skipped !== 'SELFTEST' || allowSelftestFollowUp)) {
      const stages = followUpStagesMs();
      status.followUps[key] = {
        role, action, requirementId: requirementId || '', taskId: taskId || '',
        fromStatus: fromStatus || '', toStatus: toStatus || '',
        attempts: 0, dueAt: Date.now() + stages[0], at,
      };
    }
    appendRouteLog(projectName, {
      ...base, event: 'wake', ok: true, why: '',
      wakeRef: String(result.sessionId || result.skipped || ''),
    });
    return { wake: true, key, wakeRef: result.sessionId || result.skipped || '' };
  }
  const stages = retryStages();
  const why = String(result.why || 'wake_failed');
  // Owner 09:10：验收/决定类不反复重试，首唤一次即止（失败只留痕）。
  if (['accept', 'decide'].includes(String(action || ''))) {
    appendRouteLog(projectName, { ...base, event: 'wake_failed', ok: false, why: why.slice(0, 240), wakeRef: 'no_retry_owner_gate' });
    return { scheduled: false, key, why, noRetry: true };
  }
  status.retries[key] = {
    role, action, requirementId: requirementId || '', taskId: taskId || '',
    fromStatus: fromStatus || '', toStatus: toStatus || '', source, triggerChange,
    attempt: 1, dueAt: Date.now() + stages[0], why, at: nowIso(),
  };
  appendRouteLog(projectName, {
    ...base, event: 'wake_failed', ok: false, why: why.slice(0, 240), wakeRef: `retry:1`,
  });
  return { scheduled: true, key, attempt: 1, dueAt: status.retries[key].dueAt, why };
}

/**
 * 铁律 29「不打断正在跑的任务」：角色手上刚开工（10 分钟内）的 working 任务还在，就当他忙，不补唤醒。
 * 只看本地任务字段（claimedAt/updatedAt），不猜 DSH 会话状态。
 */
function roleLooksBusy(tasks, role, now) {
  return tasks.some((task) => String(task.owner || '') === String(role)
    && String(task.status || '') === 'working'
    && (now - Date.parse(String(task.updatedAt || task.claimedAt || task.createdAt || ''))) < ROLE_BUSY_WINDOW_MS);
}

/** F-2 ⑤：到点的 followUp 检查“角色是否还停在队列里”，是就再唤醒一次（最多 3 次）。 */
async function runFollowUps(projectName, { status, tasks, now, engineUrl }) {
  const done = [];
  const stages = followUpStagesMs();
  for (const [key, item] of Object.entries(status.followUps || {})) {
    if (!item || Number(item.dueAt || 0) > now) continue;
    const role = String(item.role || '');
    const requirementId = String(item.requirementId || '');
    // 2026-11-14 修正③：补催前先校验任务状态——done/cancelled 立即停，别再催。
    if (item.taskId) {
      const hitTask = tasks.find((t) => String(t.id) === String(item.taskId));
      if (hitTask && ['done', 'cancelled'].includes(String(hitTask.status || ''))) {
        delete status.followUps[key];
        appendRouteLog(projectName, {
          event: 'skip', source: 'status', requirementId, role, action: String(item.action || ''), taskId: String(item.taskId),
          fromStatus: String(item.fromStatus || ''), toStatus: String(item.toStatus || ''),
          why: 'followup_stopped_task_closed', ok: true, key,
        });
        done.push({ key, role, action: item.action, why: 'followup_stopped_task_closed' });
        continue;
      }
    }
    const still = queueStillHas(projectName, role, requirementId, tasks) || Boolean(item.taskId && tasks.some((t) => String(t.id) === String(item.taskId) && String(t.status || '') !== 'done'));
    if (!still) {
      delete status.followUps[key];
      appendRouteLog(projectName, {
        event: 'skip', source: 'status', requirementId, role, action: String(item.action || ''), taskId: String(item.taskId || ''),
        fromStatus: String(item.fromStatus || ''), toStatus: String(item.toStatus || ''),
        why: 'followup_completed', ok: true, key,
      });
      done.push({ key, role, action: item.action, why: 'followup_completed' });
      continue;
    }
    const attempts = Number(item.attempts || 0);
    // 铁律 29：角色手上刚开工的任务还没交，就先别催（不占 3 次预算，只顺延一拍）。
    if (roleLooksBusy(tasks, role, now)) {
      const busySkips = Number(item.busySkips || 0) + 1;
      if (busySkips > 20) {
        delete status.followUps[key];
        appendRouteLog(projectName, {
          event: 'skip', source: 'status', requirementId, role, action: String(item.action || ''), taskId: String(item.taskId || ''),
          fromStatus: String(item.fromStatus || ''), toStatus: String(item.toStatus || ''),
          why: 'followup_busy_gave_up', ok: true, key,
        });
        done.push({ key, role, action: item.action, why: 'followup_busy_gave_up' });
        continue;
      }
      item.busySkips = busySkips;
      item.dueAt = now + stages[Math.min(attempts, stages.length - 1)];
      status.followUps[key] = item;
      appendRouteLog(projectName, {
        event: 'skip', source: 'status', requirementId, role, action: String(item.action || ''), taskId: String(item.taskId || ''),
        fromStatus: String(item.fromStatus || ''), toStatus: String(item.toStatus || ''),
        why: `role_busy:${busySkips}`, ok: true, key,
      });
      done.push({ key, role, action: item.action, why: `role_busy:${busySkips}` });
      continue;
    }
    if (attempts >= stages.length) {
      delete status.followUps[key];
      appendRouteLog(projectName, {
        event: 'skip', source: 'status', requirementId, role, action: String(item.action || ''), taskId: String(item.taskId || ''),
        fromStatus: String(item.fromStatus || ''), toStatus: String(item.toStatus || ''),
        why: `followup_gave_up:${attempts}`, ok: false, key,
      });
      // 2026-11-14 修正②：验收/决定类补催，PM 无代管时转“待 Owner 决策”提醒，不算唤醒失败。
      const ownerGate = ['accept', 'decide'].includes(String(item.action || ''));
      let hasProxy = null;
      if (ownerGate) {
        try { hasProxy = activeProxyFor(projectName, requirementId); } catch { hasProxy = null; }
      }
      if (ownerGate && !hasProxy) {
        alertPm(projectName, {
          type: 'escalation',
          subject: `待 Owner 决策：${requirementId || '-'}（补催已停）`,
          body: `requirementId=${requirementId || '-'}\nrole=${role}\naction=${item.action}\n状态：在等 Owner 决策，当前没有代管，PM 不能代落账。\n请提醒 Owner 到评审弹窗/评审入口处理；本条不计入 wake_failed。`,
          key: `owner_pending|${key}`,
        });
      } else {
        alertPm(projectName, {
          type: 'wake_failed',
          subject: `唤醒 ${attempts} 次仍无进展：${role}（${requirementId || item.taskId || '-'}）`,
          body: `角色 ${role} 在 ${requirementId || '-'} 上已按 30/60/120 秒退避唤醒 ${attempts} 次，队列里该活仍未动。\n再叫也不会自己动，请 PM 兜底（换人/拆任务/确认是否卡在门禁）。`,
          key: `followup_gave_up|${key}`,
        });
      }
      done.push({ key, role, action: item.action, why: 'followup_gave_up' });
      continue;
    }
    const text = buildRouteWakeText({
      role, action: item.action, requirementId, taskId: String(item.taskId || ''),
      project: projectName, fromStatus: String(item.fromStatus || ''), toStatus: String(item.toStatus || ''),
    });
    const result = await deliverRouteWake(projectName, { role, text, engineUrl });
    const nextAttempt = attempts + 1;
    if (result.ok) {
      item.attempts = nextAttempt;
      item.at = nowIso();
      item.dueAt = now + stages[Math.min(nextAttempt, stages.length - 1)];
      status.followUps[key] = item;
      appendRouteLog(projectName, {
        event: 'wake', source: 'status', requirementId, role, action: String(item.action || ''), taskId: String(item.taskId || ''),
        fromStatus: String(item.fromStatus || ''), toStatus: String(item.toStatus || ''),
        ok: true, why: `followup:${nextAttempt}`, wakeRef: String(result.sessionId || result.skipped || ''), key,
      });
      done.push({ key, role, action: item.action, attempt: nextAttempt, why: `followup:${nextAttempt}` });
    } else {
      delete status.followUps[key];
      appendRouteLog(projectName, {
        event: 'wake_failed', source: 'status', requirementId, role, action: String(item.action || ''), taskId: String(item.taskId || ''),
        fromStatus: String(item.fromStatus || ''), toStatus: String(item.toStatus || ''),
        ok: false, why: String(result.why || '').slice(0, 240), wakeRef: `followup:${nextAttempt}`, key,
      });
      done.push({ key, role, action: item.action, attempt: nextAttempt, why: 'followup_failed' });
    }
  }
  return done;
}

/** 唤醒失败重试：5/15/30 秒；3 次仍失败 → PM 收 wake_failed（type 不另造）。 */
async function runWakeRetries(projectName, { status, now, engineUrl }) {
  const out = [];
  const stages = retryStages();
  for (const [key, item] of Object.entries(status.retries || {})) {
    if (!item || Number(item.dueAt || 0) > now) continue;
    const role = String(item.role || '');
    const attempt = Number(item.attempt || 1);
    const text = buildRouteWakeText({
      role, action: item.action, requirementId: String(item.requirementId || ''), taskId: String(item.taskId || ''),
      project: projectName, fromStatus: String(item.fromStatus || ''), toStatus: String(item.toStatus || ''),
    });
    const result = await deliverRouteWake(projectName, { role, text, engineUrl });
    if (result.ok) {
      delete status.retries[key];
      status.wakes[key] = { at: nowIso(), lastWakeAt: nowIso(), role, action: String(item.action || ''), requirementId: String(item.requirementId || ''), taskId: String(item.taskId || '') };
      appendRouteLog(projectName, {
        event: 'wake', source: String(item.source || 'status'), requirementId: String(item.requirementId || ''), role,
        action: String(item.action || ''), taskId: String(item.taskId || ''), fromStatus: String(item.fromStatus || ''),
        toStatus: String(item.toStatus || ''), ok: true, why: `retry:${attempt}`, wakeRef: String(result.sessionId || result.skipped || ''), key,
      });
      out.push({ key, role, attempt, why: 'retry_ok' });
      continue;
    }
    if (attempt >= stages.length) {
      delete status.retries[key];
      appendRouteLog(projectName, {
        event: 'wake_failed', source: String(item.source || 'status'), requirementId: String(item.requirementId || ''), role,
        action: String(item.action || ''), taskId: String(item.taskId || ''), fromStatus: String(item.fromStatus || ''),
        toStatus: String(item.toStatus || ''), ok: false, why: String(result.why || '').slice(0, 240), wakeRef: `retry:${attempt}`, key,
      });
      alertPm(projectName, {
        type: 'wake_failed',
        subject: `路由唤醒失败：${role}（${key}）`,
        body: `重试 ${stages.length} 次仍失败。\n角色：${role}\n动作：${item.action || '-'}\n需求/任务：${item.requirementId || '-'} / ${item.taskId || '-'}\n原因：${String(result.why || '未知').slice(0, 200)}`,
        key: `route_wake_failed|${key}`,
      });
      out.push({ key, role, attempt, why: 'gave_up' });
      continue;
    }
    const nextAttempt = attempt + 1;
    item.attempt = nextAttempt;
    item.dueAt = now + stages[Math.min(nextAttempt - 1, stages.length - 1)];
    item.why = String(result.why || '');
    status.retries[key] = item;
    appendRouteLog(projectName, {
      event: 'wake_failed', source: String(item.source || 'status'), requirementId: String(item.requirementId || ''), role,
      action: String(item.action || ''), taskId: String(item.taskId || ''), fromStatus: String(item.fromStatus || ''),
      toStatus: String(item.toStatus || ''), ok: false, why: String(result.why || '').slice(0, 240), wakeRef: `retry:${nextAttempt}`, key,
    });
    out.push({ key, role, attempt: nextAttempt, why: 'retry_scheduled' });
  }
  return out;
}

// ---------- 读取入口（界面/CLI 只读） ----------

/** 只读预演：算出“这一拍会唤醒谁”，零写入（不建快照、不写日志）。 */
export function planRoutes(projectName, { now = Date.now() } = {}) {
  const name = String(projectName || '').trim();
  const project = loadProject(name);
  const mode = projectTeamMode(project);
  const wfRaw = readWorkflowRaw(name);
  if (wfRaw.corrupt) return { ok: false, code: 'WORKFLOW_CORRUPT', project: name, rows: [] };
  const snap = buildSnapshot(name);
  const prev = readSnapshot(name);
  const events = !prev.ok
    ? []
    : (prev.snapshot.sha256 === snap.sha256 && prev.snapshot.taskFingerprint === snap.taskFingerprint)
      ? []
      : diffSnapshot(prev.snapshot, snap);
  const rows = requirementRowsOf(wfRaw);
  const tasks = taskListOf(name);
  const ctx = { tasks, projectPath: project.path, mode };
  const status = readDaemonStatus(name);
  const windowMs = idempotentWindowMs();
  const planned = [];
  for (const event of events) {
    const row = event.requirementId ? rows[event.requirementId] : null;
    const currentStatus = String((row && row.status) || '');
    const base = {
      source: event.source,
      requirementId: event.requirementId || '',
      fromStatus: event.source === 'status' ? String(event.fromStatus || '') : currentStatus,
      toStatus: event.source === 'status' ? String(event.toStatus || '') : currentStatus,
      triggerChange: String(event.triggerChange || ''),
      taskId: event.taskId || '',
    };
    if (event.source === 'task') {
      const task = tasks.find((t) => String(t.id) === String(event.taskId));
      if (!task) { planned.push({ ...base, decision: 'skip', why: 'task_missing' }); continue; }
      const p = planForBugTask(task);
      if (p.skip) { planned.push({ ...base, decision: 'skip', why: p.skip }); continue; }
      const key = routeKey({ requirementId: event.requirementId || '', toStatus: base.toStatus, action: p.action, taskId: event.taskId });
      const dup = status.wakes[key] && withinWindow(status.wakes[key].lastWakeAt, windowMs, now);
      planned.push({
        ...base, decision: dup ? 'skip' : 'wake', why: dup ? 'duplicate' : '', role: p.role, action: p.action, key,
        text: buildRouteWakeText({ role: p.role, action: p.action, requirementId: event.requirementId || '', taskId: event.taskId, project: name, fromStatus: base.fromStatus, toStatus: base.toStatus }),
        reopenCount: Number(task.reopenCount || 0),
      });
      continue;
    }
    if (!row) { planned.push({ ...base, decision: 'skip', why: 'requirement_missing' }); continue; }
    const gate = transitionGate(event, row, ctx);
    if (gate) { planned.push({ ...base, decision: 'gate_blocked', gate: String(gate.gate || ''), why: String(gate.message || gate.code || '') }); continue; }
    const p = planForRow({ ...row, id: event.requirementId }, ctx);
    if (p.skip) { planned.push({ ...base, decision: 'skip', why: p.skip }); continue; }
    if (p.gateBlocked) { planned.push({ ...base, decision: 'gate_blocked', gate: String(p.gateBlocked.gate || ''), why: String(p.gateBlocked.message || '') }); continue; }
    const key = routeKey({ requirementId: event.requirementId, toStatus: base.toStatus, action: p.action, taskId: event.taskId || '' });
    const dup = status.wakes[key] && withinWindow(status.wakes[key].lastWakeAt, windowMs, now);
    planned.push({
      ...base, decision: dup ? 'skip' : 'wake', why: dup ? 'duplicate' : '', role: p.role, action: p.action, key,
      text: buildRouteWakeText({ role: p.role, action: p.action, requirementId: event.requirementId, project: name, fromStatus: base.fromStatus, toStatus: base.toStatus }),
    });
  }
  return { ok: true, project: name, mode, baseline: !prev.ok, events: events.length, rows: planned };
}

/** 守护状态（只读）：心跳、是否停滞、锁、日志计数。 */
export function routeDaemonStatus(projectName, { now = Date.now() } = {}) {
  const name = String(projectName || '').trim();
  const paths = routePaths(name);
  const status = readDaemonStatus(name);
  const beatMs = daemonBeatMs();
  const lastBeat = Date.parse(String(status.lastBeatAt || ''));
  const ageMs = Number.isNaN(lastBeat) ? null : Math.max(0, now - lastBeat);
  const stale = ageMs === null ? null : ageMs > beatMs * STALE_BEATS;
  // lockInfo 在锁目录不存在时会抛 ENOENT（core 的 readJson 只对 ENOENT+fallback 兜底）；
  // 只读查询不能因此失败，没锁就是没锁。
  let lock = null;
  try { lock = lockInfo(`${ROUTE_LOCK_KEY_PREFIX}${name}`); } catch { lock = null; }
  const rows = readRouteLog(name);
  const counts = {};
  for (const row of rows) counts[String(row.event || 'unknown')] = (counts[String(row.event || 'unknown')] || 0) + 1;
  return {
    project: name,
    files: { log: paths.log, status: paths.status, snapshot: paths.snapshot, queue: paths.queue },
    alive: Boolean(status.alive),
    lastBeatAt: String(status.lastBeatAt || ''),
    beatAgeMs: ageMs,
    beatMs,
    stale,
    pid: Number(status.pid || 0),
    version: String(status.version || ''),
    lastSourceSha: String(status.lastSourceSha || ''),
    startedAt: String(status.startedAt || ''),
    ticks: Number(status.ticks || 0),
    pendingWakes: Object.keys(status.retries || {}).length,
    followUps: Object.keys(status.followUps || {}).length,
    lock,
    log: { rows: rows.length, counts, tail: rows.slice(-10) },
    hasSnapshot: exists(paths.snapshot),
  };
}

/**
 * 守护停滞告警（F-6 AC6）：心跳超 3 个周期 → 给 PM 发 wake_failed（why=daemon_stale），10 分钟去重。
 * 由 team.mjs queue pump（壳层 60 秒定时器）调用，因此守护挂掉也会被发现。
 */
export function routeStaleCheck(projectName, { now = Date.now() } = {}) {
  const name = String(projectName || '').trim();
  const paths = routePaths(name);
  if (!exists(paths.status)) return { ok: true, skipped: 'NO_DAEMON' };
  const status = readDaemonStatus(name);
  const beatMs = daemonBeatMs();
  const lastBeat = Date.parse(String(status.lastBeatAt || ''));
  if (!Number.isNaN(lastBeat) && now - lastBeat <= beatMs * STALE_BEATS) {
    return { ok: true, alive: true, beatAgeMs: now - lastBeat };
  }
  const lastAlert = Date.parse(String(status.staleAlertAt || ''));
  if (!Number.isNaN(lastAlert) && now - lastAlert < STALE_DEDUPE_MS) {
    return { ok: true, alive: false, stale: true, skipped: 'DEDUPED', beatAgeMs: Number.isNaN(lastBeat) ? null : now - lastBeat };
  }
  const ageText = Number.isNaN(lastBeat) ? '心跳字段缺失' : `${Math.round((now - lastBeat) / 1000)} 秒未更新`;
  let msg = null;
  try {
    msg = sendMessage({
      from: 'system', to: 'pm', type: 'wake_failed', project: name,
      subject: `路由守护疑似已停（${name}）`,
      body: `守护状态.json 的 lastBeatAt ${ageText}，超过 ${STALE_BEATS} 个心跳周期（${Math.round((beatMs * STALE_BEATS) / 1000)} 秒）。\nwhy=daemon_stale\n重启：node 团队\\工具\\team.mjs route daemon --project "${name}" --boot <T>`,
      ackRequired: false,
    });
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e) };
  }
  status.staleAlertAt = nowIso();
  status.staleAlertMessageId = msg.id;
  writeDaemonStatus(name, status);
  return { ok: true, alive: false, stale: true, messageId: msg.id, beatAgeMs: Number.isNaN(lastBeat) ? null : now - lastBeat };
}

// ---------- 常驻循环 ----------

/** 等待用 Promise（不用 Atomics.wait：常驻进程要能响应 SIGINT 退出）。 */
function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/**
 * 守护主循环：每拍（默认 30 秒）走一次 routeTick。
 * --once / maxTicks 用于沙盘与一次性验证；正式运行由 PM 启动并常驻。
 */
export async function runDaemon(projectName, { intervalMs = null, once = false, maxTicks = 0, engineUrl = '' } = {}) {
  const name = String(projectName || '').trim();
  if (!name) fail('BAD_PROJECT', '需要项目名');
  loadProject(name);
  const tick = Number(intervalMs) > 0 ? Number(intervalMs) : routeTickMs();
  const limit = once ? 1 : (Number(maxTicks) > 0 ? Number(maxTicks) : Infinity);
  const ticks = [];
  let index = 0;
  let stopped = false;
  const onSignal = () => { stopped = true; };
  try {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  } catch { /* 某些运行环境没有信号 */ }
  // 单实例锁：常驻进程整段持有（每拍由 routeTick 续期），后启动者进不来（边界：两个守护同时跑）。
  const lock = acquireDaemonLock(name);
  if (!lock.ok) {
    appendRouteLog(name, { event: 'skip', source: 'status', why: `daemon_lock_busy: ${lock.why}`, ok: false });
    return { ok: false, code: 'DAEMON_LOCK_BUSY', project: name, lock, ticks: 0, results: [] };
  }
  try {
    while (!stopped && index < limit) {
      const result = await routeTick(name, { engineUrl, lockKey: lock.key, releaseAtEnd: false });
      ticks.push(result);
      index += 1;
      if (index >= limit || stopped) break;
      await waitMs(tick);
    }
  } finally {
    try { releaseLock(lock.key, { role: 'system' }); } catch { /* 锁已过期 */ }
    const status = readDaemonStatus(name);
    if (status.pid === process.pid) {
      status.alive = false;
      status.stoppedAt = nowIso();
      writeDaemonStatus(name, status);
    }
  }
  return { ok: true, project: name, ticks: ticks.length, results: ticks };
}
