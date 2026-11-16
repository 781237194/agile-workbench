// 认领门（T-20261116-124658-303e）：把「PM 靠自觉催认领」换成程序门。
// 职责三件：
//   1) 派单时给任务写 dispatchedAt + claimRequired（谁派的、什么时候派的、必须认领）；
//   2) 60 秒 tick 扫「已派单但未认领」：≥10 分钟标 claimOverdue（审计 + 看板红标），≥30 分钟标 claimStalled（升级）；
//   3) 同角色有未清的 claimOverdue 时，新派单一律硬拒 DISPATCH_CLAIM_OVERDUE，零写入。
// 判定只用任务自身时间戳（dispatchedAt/claimedAt），不看邮箱、不看会话状态——状态文件是唯一真相。
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, nowIso } from './core.mjs';
import { listTasks, saveTask } from './store.mjs';

export const CLAIM_OVERDUE_MIN = Number(process.env.TEAM_CLAIM_OVERDUE_MIN || 10);
export const CLAIM_STALLED_MIN = Number(process.env.TEAM_CLAIM_STALLED_MIN || 30);
export const CLAIM_AUDIT_FILE = '认领升级.jsonl';

const OPEN_STATES = new Set(['open', 'claimed', 'working', 'blocked']);
const ms = (v) => {
  const t = Date.parse(String(v || ''));
  return Number.isNaN(t) ? null : t;
};
const nowMs = (now) => {
  if (typeof now === 'number') return now;
  const t = ms(now);
  return t === null ? Date.now() : t;
};

function projectStateDir(project) {
  return path.join(PATHS.state, '项目', String(project || ''));
}

// 任务是否还在「等认领」的窗口里：有 owner（已派给谁）、没 claimedAt（从没认领过）、状态未终态。
export function needsClaim(task) {
  if (!task || !task.id) return false;
  // 需求镜像行（type=requirement / id 以 R- 开头）不是派单：它是需求行的投影，天然没有 claimedAt，
  // 不参与认领门，否则每条在途需求都会被误判成「派单超时」。
  if (String(task.type || '') === 'requirement') return false;
  if (/^R-\d{8}-/.test(String(task.id))) return false;
  const status = String(task.status || 'open');
  if (!OPEN_STATES.has(status)) return false;
  if (!String(task.owner || '').trim()) return false;
  if (task.claimedAt) return false;
  if (task.claimRequired === false) return false;
  return true;
}

// 派单基准时间：优先 dispatchedAt（本次派单），退化到 createdAt/updatedAt（老任务没有派单字段）。
export function dispatchedAtOf(task) {
  return task && (task.dispatchedAt || task.createdAt || task.updatedAt || task.at) || '';
}

export function claimStateOf(task, now) {
  if (!task || !task.id) return { state: 'none', ageMin: null };
  if (task.claimedAt) return { state: 'claimed', ageMin: null };
  if (!needsClaim(task)) return { state: 'none', ageMin: null };
  const base = ms(dispatchedAtOf(task));
  if (base === null) return { state: 'pending', ageMin: 0 };
  const ageMin = Math.floor((nowMs(now) - base) / 60000);
  if (ageMin >= CLAIM_STALLED_MIN) return { state: 'stalled', ageMin };
  if (ageMin >= CLAIM_OVERDUE_MIN) return { state: 'overdue', ageMin };
  return { state: 'pending', ageMin: Math.max(0, ageMin) };
}

// 扫一遍（可写）：超时/升级就地打标并写审计行；同级重复扫不重复写（幂等）。
export function scanClaims(project, { now = Date.now(), write = true } = {}) {
  const at = nowIso();
  const out = { at, scanned: 0, pending: 0, overdue: [], stalled: [], written: [], audit: path.join(projectStateDir(project), CLAIM_AUDIT_FILE) };
  let tasks = [];
  try { tasks = listTasks(project) || []; } catch { tasks = []; }
  for (const task of tasks) {
    const st = claimStateOf(task, now);
    if (st.state === 'none' || st.state === 'claimed') continue;
    out.scanned += 1;
    if (st.state === 'pending') { out.pending += 1; continue; }
    const level = st.state; // overdue | stalled
    const row = { id: String(task.id), owner: String(task.owner || ''), level, ageMin: st.ageMin };
    (level === 'stalled' ? out.stalled : out.overdue).push(row);
    const already = String(task.claimLevel || '');
    if (!write || already === level) continue;
    task.claimLevel = level;
    task.claimOverdue = true;
    task.claimOverdueAt = task.claimOverdueAt || at;
    task.claimOverdueMin = st.ageMin;
    if (level === 'stalled') { task.claimStalled = true; task.claimStalledAt = at; }
    saveTask(project, task);
    out.written.push(row);
  }
  if (write && out.written.length) {
    try {
      fs.mkdirSync(projectStateDir(project), { recursive: true });
      fs.appendFileSync(out.audit, out.written.map((w) => JSON.stringify({
        at, taskId: w.id, owner: w.owner, level: w.level, ageMin: w.ageMin,
        rule: w.level === 'stalled' ? `>=${CLAIM_STALLED_MIN}min` : `>=${CLAIM_OVERDUE_MIN}min`,
        action: w.level === 'stalled' ? 'escalate_stalled' : 'mark_overdue',
      })).join('\n') + '\n', 'utf8');
    } catch { /* 审计失败不阻断打标：打标已在任务行落盘 */ }
  }
  return out;
}

// 派单硬门：同角色名下有未清的 claimOverdue（或 stalled）任务 → 拒派。
export function dispatchGateFor(project, role, now = Date.now()) {
  const target = String(role || '').trim();
  if (!target) return { ok: true };
  let tasks = [];
  try { tasks = listTasks(project) || []; } catch { tasks = []; }
  for (const task of tasks) {
    if (String(task.owner || '') !== target) continue;
    // 已认领（claimedAt 落了）就一律放行：历史打标不再拦新单，避免认领后还被追着罚。
    if (task.claimedAt) continue;
    const st = claimStateOf(task, now);
    const flagged = task.claimOverdue === true || st.state === 'overdue' || st.state === 'stalled';
    if (!flagged) continue;
    if (!OPEN_STATES.has(String(task.status || 'open'))) continue;
    const ageMin = st.ageMin === null ? Number(task.claimOverdueMin || 0) : st.ageMin;
    return {
      ok: false, code: 'DISPATCH_CLAIM_OVERDUE', taskId: String(task.id), owner: target, ageMin,
      level: st.state === 'stalled' || task.claimStalled === true ? 'stalled' : 'overdue',
      message: `${target} 名下 ${task.id} 已派单 ${ageMin} 分钟未认领（超过 ${ageMin >= CLAIM_STALLED_MIN ? '升级线' : '超时线'}），先认领或请 PM 撤单再派新单`,
    };
  }
  return { ok: true };
}

// status 里的一行汇总（固定格式，便于 grep 与断言）。
export function claimSummary(project, now = Date.now()) {
  const s = scanClaims(project, { now, write: false });
  return `认领门：待认领 ${s.pending} · 超时 ${s.overdue.length} · 升级 ${s.stalled.length}`;
}
