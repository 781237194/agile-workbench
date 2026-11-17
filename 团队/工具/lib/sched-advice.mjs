/**
 * T-20261117-211833-7a30（R-20261117-204110-a4c7）：调度建议聚合**纯函数**。
 *
 * 入参＝三源原始数据（不读盘、无副作用），出参＝逐角色建议。
 * 优先级固定：UNAVAILABLE > HANDOVER_FIRST > STALL_ALERT > BUSY_HOLD > IDLE_DISPATCH > STANDBY。
 * 口径复用：在办=!statusIsClosed(status)；用量=usageLevelOf()（与 auto-rotate/warn 同源）；
 * 新鲜度只看快照 at/lastAt 与 staleMs（默认 120s），**禁文件 mtime**。
 */
import { usageLevelOf } from './session.mjs';
import { statusIsClosed } from './gates.mjs';

export const SCHED_DECISIONS = ['UNAVAILABLE', 'HANDOVER_FIRST', 'STALL_ALERT', 'BUSY_HOLD', 'IDLE_DISPATCH', 'STANDBY'];
export const SCHED_ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
export const SCHED_STALE_MS = 120000;
export const SCHED_QUEUE_STALL_MS = 300000;
export const SCHED_CLAIM_WARN_MS = 10 * 60 * 1000;
export const SCHED_ROTATE_ROUNDS_DEFAULT = 8;

const NEXT_ACTION = {
  UNAVAILABLE: '任务源不可用：先恢复 任务/ 目录，别派单',
  HANDOVER_FIRST: '先交接/换人，再由 PM 派新单',
  STALL_ALERT: '先核对认领人：催办或收回重派（不要自动换人）',
  BUSY_HOLD: '忙：不派、入队，等其队列/在办收敛',
  IDLE_DISPATCH: '空闲：可以从待派清单里挑单派',
  STANDBY: '空闲但无可派：待命',
};

function parseMs(v) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

/** 纯函数：三源原始数据 → 建议数组。 */
export function buildSchedAdvice(input) {
  const now = Number.isFinite(input && input.now) ? input.now : Date.now();
  const staleMs = Number(input && input.staleMs) > 0 ? Number(input.staleMs) : SCHED_STALE_MS;
  const rotateRounds = Number(input && input.rotateRounds) > 0 ? Number(input.rotateRounds) : SCHED_ROTATE_ROUNDS_DEFAULT;
  const queue = (input && input.queue) || null;
  const roundsMap = (input && input.rounds) || null;
  const usageMap = (input && input.usage) || null;
  const tasks = Array.isArray(input && input.tasks) ? input.tasks : null;
  const roleQueues = (input && input.roleQueues) || null;
  const roles = Array.isArray(input && input.roles) && input.roles.length ? input.roles : SCHED_ROLES;

  const taskSourceAvailable = Boolean(tasks) && (input.taskSourceAvailable !== false);
  const snapshotAtMs = queue ? parseMs(queue.at) : null;
  const snapshotStale = !queue || snapshotAtMs === null || (now - snapshotAtMs > staleMs);
  const queueDegraded = Boolean(queue && queue.degraded);
  const out = [];
  for (const role of roles) {
    const qRow = queue && queue.roles && queue.roles[role] ? queue.roles[role] : null;
    const rowAtMs = qRow ? parseMs(qRow.at || qRow.lastAt) : null;
    const rowStale = Boolean(qRow && qRow.stale) || (qRow && rowAtMs !== null && now - rowAtMs > staleMs);
    const state = String((qRow && qRow.state) || '');
    const queued = Number(qRow && qRow.queued) > 0 ? Math.floor(Number(qRow.queued)) : 0;
    const running = Boolean(qRow && (qRow.running === true || state === 'running'));
    const roundsRaw = roundsMap && roundsMap[role] ? Number(roundsMap[role].roundsSinceArchive) : NaN;
    const rounds = Number.isFinite(roundsRaw) ? roundsRaw : null;
    const usageRow = usageMap && usageMap[role] ? usageMap[role] : null;
    const usageInput = usageRow ? Number(usageRow.inputTokens || usageRow.totalTokens || 0) : 0;
    const usageLevel = usageRow ? String(usageRow.level || usageLevelOf(usageInput)) : '';
    const openTasks = taskSourceAvailable
      ? tasks.filter((t) => String(t.owner || '') === role && !statusIsClosed(String(t.status || '')))
      : [];
    const queueItems = roleQueues && roleQueues[role] && Array.isArray(roleQueues[role].queue) ? roleQueues[role].queue : [];

    const reasons = [];
    let decision = 'STANDBY';

    // 认领超时（10/30 分钟）；队列滞留（staleMs=300000）
    const claimedStalled = openTasks.filter((t) => {
      const claimedMs = parseMs(t.claimedAt);
      return claimedMs !== null && now - claimedMs >= SCHED_CLAIM_WARN_MS;
    });
    const queueStalled = queueItems.filter((it) => {
      const since = parseMs(it.since || it.at || (it.item && it.item.since));
      return since !== null && now - since >= SCHED_QUEUE_STALL_MS;
    });

    if (!taskSourceAvailable) {
      decision = 'UNAVAILABLE';
      reasons.push('任务源缺失/不可用');
    } else if (rounds !== null && rounds >= rotateRounds) {
      decision = 'HANDOVER_FIRST';
      reasons.push(`轮次 ${rounds} ≥ ${rotateRounds}（先交接）`);
    } else if (usageLevel === 'warn' || usageLevel === 'force') {
      decision = 'HANDOVER_FIRST';
      reasons.push(`用量档 ${usageLevel}（先交接）`);
    } else if (claimedStalled.length) {
      decision = 'STALL_ALERT';
      const worst = Math.max(...claimedStalled.map((t) => Math.round((now - parseMs(t.claimedAt)) / 60000)));
      reasons.push(`认领超时：${claimedStalled.map((t) => t.id).slice(0, 3).join('、')}（最长 ${worst} 分钟）`);
    } else if (queueStalled.length) {
      decision = 'STALL_ALERT';
      reasons.push(`队列滞留 ${queueStalled.length} 条（≥5 分钟）`);
    } else if (queued > 0 || running || openTasks.length > 0) {
      decision = 'BUSY_HOLD';
      if (running) reasons.push('会话 running');
      if (queued > 0) reasons.push(`排队 ${queued} 条`);
      if (openTasks.length) reasons.push(`在办 ${openTasks.length} 条：${openTasks.slice(0, 3).map((t) => t.id).join('、')}`);
    } else if (snapshotStale || queueDegraded || rowStale) {
      // 快照不新鲜/降级/行级 stale：queued=0 不得单独当空闲证据
      decision = 'STANDBY';
      reasons.push(snapshotStale ? '排队快照缺失或过期（不得判空闲）' : queueDegraded ? '排队快照 degraded（不得判空闲）' : '行级 stale（不得判空闲）');
    } else if (state === 'ok' && queued === 0) {
      decision = 'IDLE_DISPATCH';
      reasons.push('快照新鲜、state=ok、queued=0、无在办');
    } else {
      decision = 'STANDBY';
      reasons.push(state ? `状态 ${state} 不足以判空闲` : '无排队行（不得判空闲）');
    }

    const level = ['UNAVAILABLE', 'HANDOVER_FIRST', 'STALL_ALERT'].includes(decision) ? 'bad' : decision === 'BUSY_HOLD' ? 'warn' : 'ok';
    out.push({
      role,
      decision,
      reasons,
      level,
      nextAction: NEXT_ACTION[decision],
      sources: {
        queue: queue ? (snapshotStale ? 'stale' : 'file') : 'missing',
        rounds: rounds === null ? 'missing' : 'file',
        usage: usageRow ? 'file' : 'missing',
        tasks: taskSourceAvailable ? 'file' : 'missing',
        roleQueue: roleQueues ? 'file' : 'missing',
      },
      facts: { queued, running, state, rounds, usageLevel: usageLevel || null, openTasks: openTasks.length, snapshotStale, rowStale },
    });
  }
  // 顺序稳定性：输出恒按优先级降序 + 角色原序，便于 CLI/面板直接渲染
  out.sort((a, b) => SCHED_DECISIONS.indexOf(a.decision) - SCHED_DECISIONS.indexOf(b.decision));
  return {
    ok: true,
    at: new Date(now).toISOString(),
    project: String((input && input.project) || ''),
    degraded: snapshotStale || queueDegraded,
    roles: out,
    sourceNote: '只读建议：不派单、不换人；写盘仅调度建议.jsonl（append-only）',
  };
}
