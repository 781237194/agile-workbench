/**
 * R-b5fc F-2/F-4b/F-6：路由守护与队列的 CLI 入口（只做入口与权限，逻辑都在 route-daemon / route-queues）。
 *
 * 命令：
 *   route daemon --project P --boot T [--interval ms] [--max-ticks n] [--once] [--engine-url URL]
 *   route once   --project P --boot T [--engine-url URL]
 *   route plan   --project P [--json]                 # 只读预演：算出这一拍会唤醒谁，零写入
 *   route status --project P [--json]                 # 只读：心跳/是否停滞/锁/日志计数
 *   route log    --project P [--tail 20] [--json]
 *   route stale-check --project P [--json]            # 守护停滞告警（queue pump 也会调）
 *
 *   queues --project P --boot T --role R [--json]     # 本人读自己的队列
 *   queues --project P --boot T --all [--json]        # 只有 PM 能读全量
 *   queues export --project P --boot T [--json]       # 刷新派生 role_queues.json（不动真相）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fail, jsonOut, textOut, nowIso, exists, sha256 } from './core.mjs';
import { requireBoot, loadProject, projectTeamMode, projectStatePaths } from './store.mjs';
import { ROLE_NAMES } from './roles.mjs';
import { ROLE_QUEUE_FILE, buildRoleQueues, readRoleQueues, writeRoleQueues } from './route-queues.mjs';
import {
  ROUTE_LOG_FILE, ROUTE_STATUS_FILE, ROUTE_SNAPSHOT_FILE,
  planRoutes, readRouteLog, routeDaemonStatus, routePaths, routeStaleCheck, runDaemon,
} from './route-daemon.mjs';

function out(args, human, json) {
  if (args.json) jsonOut(json);
  else textOut(human);
}

function needProject(args) {
  const name = String(args.project || '').trim();
  if (!name) fail('BAD_PROJECT', '需要 --project');
  return name;
}

/** 令牌 → {role, project, sessionId}；写操作一律要令牌（项目协议：没有启动令牌不执行）。 */
function bootOf(args, action) {
  if (!args.boot) fail('BOOT_REQUIRED', `需要 --boot <启动令牌>；先运行 boot（${action}）`);
  const b = requireBoot(String(args.boot), {});
  if (args.project && String(args.project) !== String(b.project || '')) {
    fail('BOOT_PROJECT_MISMATCH', `令牌项目 ${b.project} ≠ --project ${args.project}`);
  }
  return b;
}

// ---------- 队列读权限（F-4b） ----------

function queueSnapshot(projectName) {
  const parsed = loadProject(projectName);
  const mode = projectTeamMode(parsed);
  const wfFile = path.join(projectStatePaths(projectName).dir, '工作流.json');
  const currentSha = exists(wfFile) ? sha256(fs.readFileSync(wfFile)) : '';
  const row = readRoleQueues(projectName);
  if (!row || typeof row !== 'object' || !row.roles) {
    return { exported: false, payload: buildRoleQueues(projectName), currentSha, sourceSha: '', fresh: false, mode };
  }
  const sourceSha = String((row.source && row.source.sha256) || '');
  return { exported: true, payload: row, currentSha, sourceSha, fresh: Boolean(sourceSha) && sourceSha === currentSha, mode };
}

function queueView(projectName, role) {
  const snap = queueSnapshot(projectName);
  const list = (snap.payload.roles[role] || { queue: [] }).queue || [];
  return { snap, role, list };
}

export function cmdQueues(args) {
  const sub = String((args._ && args._[1]) || '').toLowerCase();
  const project = needProject(args);
  if (sub === 'export') {
    const b = bootOf(args, 'queues export');
    const r = writeRoleQueues(project);
    if (!r.ok) {
      fail(String(r.code || 'QUEUE_EXPORT_FAILED'), `role_queues.json 写失败：${r.error || r.code}（已保留上一版，不删旧文件）`, { file: r.file, project });
    }
    const roles = Object.entries(r.payload.roles || {}).map(([role, v]) => `${ROLE_NAMES[role] || role}:${(v.queue || []).length}`);
    out(args, `已导出 ${ROLE_QUEUE_FILE}（${project}，teamMode=${r.payload.meta.teamMode}）：${roles.join(' ')}`,
      { ok: true, project, by: b.role, file: r.file, teamMode: r.payload.meta.teamMode, counts: Object.fromEntries(Object.entries(r.payload.roles || {}).map(([k, v]) => [k, (v.queue || []).length])) });
    return;
  }
  const b = bootOf(args, 'queues');
  const all = Boolean(args.all);
  const want = String(args.role || '').trim();
  if (!all && !want) fail('BAD_ARGS', '需要 --role <角色>（读自己的队列）或 --all（仅 PM 读全量）');
  if (all && b.role !== 'pm') {
    fail('QUEUE_FORBIDDEN', `只有 PM 能用 queues --all；当前令牌角色是 ${b.role}`, { role: b.role, action: 'queues --all', project });
  }
  if (!all && want !== b.role) {
    fail('QUEUE_FORBIDDEN', `只能读自己的队列：令牌角色 ${b.role} ≠ --role ${want}；PM 请用 queues --all`, {
      role: b.role, requested: want, action: 'queues --role', project,
    });
  }
  if (all) {
    const snap = queueSnapshot(project);
    const rows = [];
    for (const [role, v] of Object.entries(snap.payload.roles || {})) {
      for (const item of v.queue || []) rows.push({ role, ...item });
    }
    const human = [
      `角色队列全量（${project}，teamMode=${snap.mode}，导出=${snap.exported ? '是' : '否（内存生成）'}，新鲜=${snap.fresh ? '是' : '否'}）`,
      ...Object.entries(snap.payload.roles || {}).map(([role, v]) => `${ROLE_NAMES[role] || role}：${(v.queue || []).length} 条`),
      ...rows.slice(0, 20).map((r) => `- [${r.priority || 'P?'}] ${r.taskId || '-'} ${r.action || ''} → ${r.role}`),
    ].join('\n');
    out(args, human, { ok: true, project, teamMode: snap.mode, exported: snap.exported, fresh: snap.fresh, sourceSha: snap.sourceSha, currentSha: snap.currentSha, rows, counts: Object.fromEntries(Object.entries(snap.payload.roles || {}).map(([k, v]) => [k, (v.queue || []).length])) });
    return;
  }
  const { snap, role, list } = queueView(project, want);
  const human = [
    `${ROLE_NAMES[role] || role} 的队列（${project}，${list.length} 条；导出=${snap.exported ? '是' : '否（内存生成）'}，新鲜=${snap.fresh ? '是' : '否'}）`,
    ...list.map((item) => `- [${item.priority || 'P?'}] ${item.taskId || '-'} ${item.action || ''}${item.due ? ` 截止 ${item.due}` : ''}`),
  ].join('\n');
  out(args, human, { ok: true, project, role, teamMode: snap.mode, exported: snap.exported, fresh: snap.fresh, sourceSha: snap.sourceSha, currentSha: snap.currentSha, queue: list });
}

// ---------- 路由守护 ----------

function humanRouteRow(row) {
  const who = row.role ? `${ROLE_NAMES[row.role] || row.role}` : '-';
  return `- [${row.decision || row.event}] ${row.requirementId || row.taskId || '-'} ${row.fromStatus || ''}${row.toStatus ? '→' + row.toStatus : ''} ${row.action || ''} → ${who}${row.why ? `（${row.why}）` : ''}`;
}

export async function cmdRoute(args) {
  const sub = String((args._ && args._[1]) || 'status').toLowerCase();
  const project = needProject(args);

  if (sub === 'plan') {
    const r = planRoutes(project);
    if (!r.ok) fail(String(r.code || 'ROUTE_PLAN_FAILED'), '工作流.json 无法解析，无法预演路由', { project });
    const wakes = r.rows.filter((row) => row.decision === 'wake');
    const human = [
      `路由预演（${project}，teamMode=${r.mode}，基线=${r.baseline ? '未建立（首拍只建基线）' : '已存在'}，事件 ${r.events} 条，将唤醒 ${wakes.length} 条）`,
      ...r.rows.map(humanRouteRow),
    ].join('\n');
    out(args, human, { ok: true, ...r });
    return;
  }

  if (sub === 'status') {
    const s = routeDaemonStatus(project);
    const human = [
      `路由守护（${project}）：${s.alive ? '曾心跳' : '未启动'} ｜ 最近心跳 ${s.lastBeatAt || '-'}${s.beatAgeMs === null ? '' : `（${Math.round(s.beatAgeMs / 1000)} 秒前）`}${s.stale ? ' ｜ ⚠ 疑似已停' : ''}`,
      `锁：${s.lock ? `被 ${s.lock.owner || s.lock.role || 'unknown'} 持有${s.lock.stale ? '（已过期）' : ''}` : '无'}`,
      `快照：${s.hasSnapshot ? '有' : '无'} ｜ 日志 ${s.log.rows} 行（${Object.entries(s.log.counts).map(([k, v]) => `${k}=${v}`).join(' ') || '空'}）`,
      `待重试 ${s.pendingWakes} ｜ 待复查 ${s.followUps} ｜ 版本 ${s.version || '-'} ｜ pid ${s.pid || '-'} ｜ 拍数 ${s.ticks}`,
    ].join('\n');
    out(args, human, { ok: true, ...s });
    return;
  }

  if (sub === 'log') {
    const tail = Number(args.tail || 20);
    const rows = readRouteLog(project, { tail: Number.isFinite(tail) && tail > 0 ? tail : 20 });
    out(args, rows.map((row) => `- ${row.at} [${row.event}] ${row.source} ${row.requirementId || row.taskId || '-'} ${row.fromStatus || ''}→${row.toStatus || ''} ${row.role || ''} ${row.action || ''}${row.why ? `（${row.why}）` : ''}`).join('\n') || '（暂无路由日志）',
      { ok: true, project, file: ROUTE_LOG_FILE, rows });
    return;
  }

  if (sub === 'stale-check') {
    const r = routeStaleCheck(project);
    out(args, r.skipped === 'NO_DAEMON'
      ? `路由守护从未启动过（${project}）：没有 ${ROUTE_STATUS_FILE}，不发停滞告警`
      : r.skipped === 'DEDUPED'
        ? `守护心跳已停，但 10 分钟内已告警过（${project}）`
        : r.alive
          ? `守护心跳正常（${project}，${Math.round(Number(r.beatAgeMs || 0) / 1000)} 秒前）`
          : `已给 PM 发 wake_failed（why=daemon_stale，${project}，${r.messageId || ''}）`,
      { ok: true, ...r });
    return;
  }

  if (sub === 'daemon' || sub === 'once') {
    const b = bootOf(args, `route ${sub}`);
    if (sub === 'once') {
      const r = await runDaemon(project, { once: true, engineUrl: String(args['engine-url'] || '') });
      const tick = (r.results && r.results[0]) || {};
      const human = [
        `路由一拍（${project}，by ${b.role}）：${r.ok ? '完成' : `未执行（${r.code || ''}）`}`,
        `事件 ${(tick.events || []).length} ｜ 唤醒 ${(tick.wakes || []).length} ｜ 跳过 ${(tick.skips || []).length} ｜ 门禁拦截 ${(tick.gateBlocked || []).length} ｜ 基线 ${tick.baseline ? '新建' : '已存在'}`,
        ...(tick.wakes || []).map((row) => `- 唤醒 ${row.role} ${row.action} ${row.requirementId || row.taskId || ''}`),
        ...(tick.gateBlocked || []).map((row) => `- 拦截 ${row.gate} ${row.requirementId || ''} ${row.code || ''}`),
      ].join('\n');
      out(args, human, { ok: r.ok, project, by: b.role, ...r });
      return;
    }
    const interval = Number(args.interval || 0);
    textOut(`路由守护启动（${project}，by ${b.role}）｜ 每拍 ${interval > 0 ? interval : '默认'} ms ｜ 单实例锁 30 秒续期 ｜ Ctrl+C 退出`);
    const r = await runDaemon(project, {
      intervalMs: interval > 0 ? interval : null,
      maxTicks: Number(args['max-ticks'] || 0),
      engineUrl: String(args['engine-url'] || ''),
    });
    out(args, r.ok ? `路由守护已退出（${project}，共 ${r.ticks} 拍）` : `路由守护未启动（${project}）：${r.code || ''}`,
      { ok: r.ok, project, by: b.role, ticks: r.ticks, results: r.results });
    if (!r.ok) fail(String(r.code || 'ROUTE_DAEMON_FAILED'), '守护未能启动：单实例锁被占用（后启动者只读）', { project, lock: r.lock });
    return;
  }

  fail('BAD_ARGS', `未知的 route 子命令：${sub}（用法：route daemon|once|plan|status|log|stale-check --project P）`);
}

/** 供 queue pump 调用：守护停滞告警（F-6）；失败不阻断泵。 */
export function routeStaleCheckSafe(projectName) {
  try {
    return routeStaleCheck(projectName);
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e) };
  }
}

export { ROUTE_LOG_FILE, ROUTE_STATUS_FILE, ROUTE_SNAPSHOT_FILE, routePaths, nowIso };
