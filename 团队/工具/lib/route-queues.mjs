/**
 * R-b5fc F-1：角色队列导出（role_queues.json 的唯一生成器）。
 *
 * 真相只有两份：`团队/状态/项目/<项目>/工作流.json` 的 requirements[].status/ownerReview/trq/decisions/updatedAt，
 * 与 `任务/*.json` 的 id/title/owner/status/requirementId/priority/due/createdAt。
 * 本模块**只读真相、只写派生**（role_queues.json），不改工作流状态、不替角色过门禁（F-1 + 硬约束）。
 *
 * 队列数据形如：
 *   { generatedAt, source: { path, sha256 },
 *     roles: { <role>: { queue: [{ taskId, requirementId, action, priority, status, due, createdAt, evidencePath? }] } },
 *     meta: { schema: 1, teamMode: 'full'|'fast' } }
 *
 * 行为约定：
 * - 每角色一列，按「优先级(P0>P1>P2) → 截止 → 创建时间」排序；
 * - `evidencePath` 只在有产出/证据时出现；
 * - 导出失败**不删旧文件**（保留上一版并告警，见 writeRoleQueues）；
 * - fast 模式只列 pm / analyst / programmer1 / tester 四个角色（无产品、无程序员B）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS, readJson, writeJson } from './core.mjs';
import { projectStatePaths, loadProject, projectTeamMode } from './store.mjs';
import { ownerDecisionsOf } from './gates.mjs';

export const ROLE_QUEUE_SCHEMA = 1;
export const ROLE_QUEUE_FILE = 'role_queues.json';
const ALL_ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const FAST_ROLES = ['pm', 'analyst', 'programmer1', 'tester'];
const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2 };
const RANK_PRIORITY = (value) => (value in PRIORITY_RANK ? PRIORITY_RANK[value] : 9);

/** 该需求最近一条任务（requirementId 命中、createdAt 最新）的 owner；无任务回退需求行 owner → analyser。 */
function carrierOf(requirementId, tasks) {
  const hit = tasks
    .filter((task) => String(task.requirementId || '') === String(requirementId))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
  return hit ? String(hit.owner || '') : '';
}

/** 规则表里「该状态该谁做」的 action（F-3 的写死映射，表外返回 null → 不猜）。 */
function actionForStatus(status, row) {
  const s = String(status || '');
  if (s === 'open') return { role: 'product', action: 'review' };
  if (s === 'ready') {
    // ready 上有三种真实情形，队列必须与路由守护（route-daemon.planForRow）同口径，否则队列会一辈子喊 tester：
    // ① trq 未做 → tester trq；② trq=not_testable → tester 重做 TR-Q；③ trq=testable → 看 Owner 决定：
    //   没落账 → pm 列 decide（Owner 门）；已落账 → 不出队列（等状态推进，PM 兜底）。
    const verdict = String((row && row.trq && row.trq.verdict) || '');
    if (verdict === 'not_testable') return { role: 'tester', action: 'trq' };
    if (verdict !== 'testable') return { role: 'tester', action: 'trq' };
    const decisions = ownerDecisionsOf(row || {});
    if (!decisions.length) return { role: 'owner', action: 'decide' };
    const latest = decisions[decisions.length - 1];
    const decided = String(latest.status || latest.decision || '');
    if (decided === 'rejected') return { role: 'carrier', action: 'rework' };
    return null;
  }
  if (s === 'approved') return { role: 'developer', action: 'develop' };
  if (s === 'dev_done') return { role: 'tester', action: 'test' };
  if (s === 'test_done') return { role: 'owner', action: 'accept' };
  if (s === 'rejected') return { role: 'carrier', action: 'rework' };
  if (s === 'accepted' || s === 'done' || s === 'terminated') return null;
  return null;
}

function inFastMode(projectName) {
  try {
    const project = loadProject(projectName);
    return String(projectTeamMode(project) || '') === 'fast';
  } catch {
    return false;
  }
}

/** 读真相 → 生成队列对象（纯函数，不写盘）。 */
export function buildRoleQueues(projectName) {
  const name = String(projectName || '').trim();
  if (!name) throw new Error('buildRoleQueues 需要项目名');
  const paths = projectStatePaths(name);
  const wfFile = path.join(paths.dir, '工作流.json');
  const raw = fs.existsSync(wfFile) ? fs.readFileSync(wfFile) : Buffer.from('{}');
  const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
  const wf = (() => { try { return JSON.parse(raw.toString('utf8')) || {}; } catch { return {}; } })();
  const rows = (wf && wf.requirements && typeof wf.requirements === 'object') ? wf.requirements : {};
  const tasksDir = path.join(paths.dir, '任务');
  const tasks = fs.existsSync(tasksDir)
    ? fs.readdirSync(tasksDir).filter((n) => n.endsWith('.json')).map((n) => readJson(path.join(tasksDir, n), null)).filter(Boolean)
    : [];
  const teamMode = inFastMode(name) ? 'fast' : 'full';
  const roles = Object.fromEntries((teamMode === 'fast' ? FAST_ROLES : ALL_ROLES).map((role) => [role, { queue: [] }]));
  const push = (role, item) => {
    if (!roles[role]) return;
    roles[role].queue.push(item);
  };
  for (const [requirementId, row] of Object.entries(rows)) {
    if (!row || typeof row !== 'object') continue;
    if (row.terminatedAt) continue;
    const status = String(row.status || '');
    const mapped = actionForStatus(status, row);
    if (mapped) {
      const carrier = carrierOf(requirementId, tasks);
      let role = mapped.role;
      if (role === 'developer') role = carrier || 'programmer1';
      if (role === 'carrier') role = carrier || 'analyst';
      if (role === 'owner') role = 'pm'; // Owner 门在砂盘/CLI 侧由 PM 代读，唤醒对象仍是 owner；队列列挂在 pm 便于 PM 兜底
      push(role, {
        taskId: requirementId,
        requirementId,
        action: mapped.action,
        priority: String(row.priority || 'P1'),
        status: 'pending',
        due: String(row.due || ''),
        createdAt: String(row.createdAt || row.updatedAt || ''),
        evidencePath: String(row.bodyPath || row.evidencePath || '') || undefined,
      });
    }
  }
  // 任务级队列：bug 旁路（B-*）与已认领但未完成的任务
  for (const task of tasks) {
    const id = String(task.id || '');
    if (!id) continue;
    const owner = String(task.owner || '');
    const status = String(task.status || '');
    if (status === 'done') continue;
    if (!roles[owner]) continue;
    if (id.startsWith('B-')) {
      const reopen = Number(task.reopenCount || 0);
      push(owner, {
        taskId: id, requirementId: String(task.requirementId || ''), action: status === 'test_done' ? 'verify' : 'fix',
        priority: String(task.priority || 'P1'), status: 'pending', due: String(task.due || ''),
        createdAt: String(task.createdAt || ''), evidencePath: String(task.evidence || '') || undefined,
        reopenCount: reopen,
      });
    }
  }
  for (const role of Object.keys(roles)) {
    roles[role].queue.sort((a, b) => (RANK_PRIORITY(a.priority) - RANK_PRIORITY(b.priority))
      || String(a.due || '9999').localeCompare(String(b.due || '9999'))
      || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  }
  return {
    generatedAt: new Date().toISOString(),
    source: { path: wfFile, sha256 },
    roles,
    meta: { schema: ROLE_QUEUE_SCHEMA, teamMode },
  };
}

/** 原子写 role_queues.json（tmp+rename）；失败**不删旧文件**，返回 {ok:false, code, error}。 */
export function writeRoleQueues(projectName) {
  const name = String(projectName || '').trim();
  const payload = buildRoleQueues(name);
  const file = path.join(projectStatePaths(name).dir, ROLE_QUEUE_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, file, payload };
  } catch (error) {
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return { ok: false, code: 'QUEUE_EXPORT_FAILED', error: String((error && error.message) || error), file };
  }
}

/** 读回（界面/CLI 用）；不存在返回 null（可重建）。 */
export function readRoleQueues(projectName) {
  const file = path.join(projectStatePaths(String(projectName || '').trim()).dir, ROLE_QUEUE_FILE);
  return readJson(file, null);
}
