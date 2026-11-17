#!/usr/bin/env node
/**
 * T-20261117-203758-8c27：PM 调度器（只读）——会话排队 + 轮次 + 任务清单 → 每角色决策。
 *
 * 用法：
 *   node scripts/pm-scheduler.cjs --project <项目> [--root <仓库根>] [--now <ISO>] [--json]
 *
 * 输入（全部只读，缺文件按「未接入」处理，不静默当成空闲）：
 *   - 团队/状态/项目/<项目>/会话排队.json   DSH 插件 host half 写的排队快照（可有 queued/state/lastAt）；
 *   - 团队/状态/项目/<项目>/会话轮次.json   每角色 {roundsSinceArchive, lastArchiveAt, lastTaskIds}；
 *   - 团队/状态/项目/<项目>/会话用量.json   可选，token 用量（warn/force 档）——与 session usage 同源；
 *   - 团队/状态/项目/<项目>/任务/*.json     任务清单（owner/status）。
 *
 * 决策枚举（每角色一条）：
 *   rotate_first  轮次 ≥ rotateRounds(默认20) 或用量 level ∈ {warn,force}（先交接/换人，再谈派单）
 *   hold          忙：DSH running 或 queued>0 或名下有 working/open 在办任务
 *   stale_alert   running 但排队快照 lastAt 超过 staleMs(默认15分钟) 未更新（疑似卡死）
 *   dispatchable  空闲（queued=0、无在办任务）且有候选任务可派（未被人认领的 open 任务 / 有 owner 但没在办）
 *   standby       空闲且没有可派任务（待命）
 *
 * **只读**：本脚本不写任何文件、不派单、不改状态；--json 时 stdout 恰好一行 JSON。
 * 退出码：0 正常；2 参数错误（缺 --project）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const ROOT = path.resolve(argOf('root', path.resolve(__dirname, '..')));
const PROJECT = String(argOf('project', '')).trim();
const JSON_OUT = argv.includes('--json');
const NOW_MS = (() => {
  const injected = String(argOf('now', '')).trim();
  if (injected) {
    const ms = Date.parse(injected);
    if (Number.isFinite(ms)) return ms;
  }
  const envMs = Number(process.env.AWB_NOW_MS || 0);
  return Number.isFinite(envMs) && envMs > 0 ? envMs : Date.now();
})();
const ROTATE_ROUNDS = (() => {
  const n = Number(argOf('rotate-rounds', process.env.PM_SCHED_ROTATE_ROUNDS || 20));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
})();
const STALE_MS = (() => {
  const n = Number(argOf('stale-ms', process.env.PM_SCHED_STALE_MS || 15 * 60 * 1000));
  return Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000;
})();
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const CLOSED = new Set(['done', 'accepted', 'cancelled', 'terminated']);

if (!PROJECT) {
  process.stderr.write('PM_SCHEDULER_USAGE：需要 --project <项目>\n');
  process.exit(2);
}

const STATE_DIR = path.join(ROOT, '团队', '状态', '项目', PROJECT);
const readJson = (file, dflt) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; } };
const readJsonl = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};

// ── 1) 排队快照（容忍多种形状；缺文件=未接入）──
const queueRaw = readJson(path.join(STATE_DIR, '会话排队.json'), null);
const queueInfo = (role) => {
  const out = { source: queueRaw ? 'file' : 'missing', state: 'none', queued: 0, running: false, lastAt: '' };
  if (!queueRaw || typeof queueRaw !== 'object') return out;
  const byRole = (queueRaw.roles && typeof queueRaw.roles === 'object' && queueRaw.roles[role])
    || (queueRaw[role] && typeof queueRaw[role] === 'object' ? queueRaw[role] : null);
  const row = byRole || queueRaw;
  if (row && typeof row === 'object') {
    const st = String(row.state || row.status || '');
    if (st) out.state = st;
    out.running = st === 'running' || row.running === true;
    const queued = row.queued !== undefined ? Number(row.queued) : Number(row.queue || row.pending || 0);
    out.queued = Number.isFinite(queued) && queued > 0 ? Math.floor(queued) : 0;
    out.lastAt = String(row.lastAt || row.updatedAt || row.at || '');
  }
  return out;
};

// ── 2) 轮次 + 用量 ──
const roundsRaw = readJson(path.join(STATE_DIR, '会话轮次.json'), {});
const usageRaw = readJson(path.join(STATE_DIR, '会话用量.json'), null);
const roundsOf = (role) => {
  const row = roundsRaw && (roundsRaw[role] || (Array.isArray(roundsRaw.roles) ? roundsRaw.roles.find((r) => r && r.role === role) : null));
  return row ? Number(row.roundsSinceArchive || 0) : 0;
};
const usageOf = (role) => {
  if (!usageRaw) return { level: '', source: 'missing' };
  const row = (usageRaw.roles && usageRaw.roles[role]) || usageRaw[role] || (Array.isArray(usageRaw.rows) ? usageRaw.rows.find((r) => r && r.role === role) : null) || {};
  return { level: String(row.level || ''), source: 'file' };
};

// ── 3) 任务清单 ──
const taskDir = path.join(STATE_DIR, '任务');
const tasks = (() => {
  try {
    return fs.readdirSync(taskDir).filter((n) => n.endsWith('.json')).map((n) => readJson(path.join(taskDir, n), null)).filter(Boolean);
  } catch { return []; }
})();
const openTasksOf = (role) => tasks.filter((t) => String(t.owner || '') === role && !CLOSED.has(String(t.status || '')));
const unclaimedWork = tasks.filter((t) => !t.owner && !CLOSED.has(String(t.status || '')) && String(t.type || '') !== 'requirement');

// ── 4) 每角色决策 ──
const roles = {};
for (const role of ROLES) {
  const q = queueInfo(role);
  const rounds = roundsOf(role);
  const usage = usageOf(role);
  const openTasks = openTasksOf(role);
  const reasons = [];
  let decision = 'standby';

  const usageHot = ['warn', 'force'].includes(usage.level);
  const roundsHot = rounds >= ROTATE_ROUNDS;
  if (roundsHot || usageHot) {
    decision = 'rotate_first';
    if (roundsHot) reasons.push(`轮次 ${rounds} ≥ ${ROTATE_ROUNDS}（先交接/换人）`);
    if (usageHot) reasons.push(`用量档 ${usage.level}（先交接/换人）`);
  } else if (q.queued > 0 || q.running || openTasks.length > 0) {
    decision = 'hold';
    if (q.running) reasons.push('DSH running');
    if (q.queued > 0) reasons.push(`排队 ${q.queued} 条`);
    if (openTasks.length) reasons.push(`在办 ${openTasks.length} 条：${openTasks.slice(0, 3).map((t) => t.id).join('、')}`);
    // 停滞：running 但快照 lastAt 过旧
    const lastMs = q.lastAt ? Date.parse(q.lastAt) : NaN;
    if (q.running && Number.isFinite(lastMs) && NOW_MS - lastMs > STALE_MS) {
      decision = 'stale_alert';
      reasons.push(`running 但快照 ${Math.round((NOW_MS - lastMs) / 60000)} 分钟未更新（疑似卡死）`);
    }
  } else if (unclaimedWork.length > 0) {
    decision = 'dispatchable';
    reasons.push(`空闲且有 ${unclaimedWork.length} 条未认领任务待派`);
  } else {
    decision = 'standby';
    reasons.push('空闲且没有可派任务（待命）');
  }
  roles[role] = {
    role, decision, reasons,
    queued: q.queued, running: q.running, queueState: q.state, queueSource: q.source, lastAt: q.lastAt,
    rounds, roundsSinceArchive: rounds, usageLevel: usage.level || '', usageSource: usage.source,
    openTasks: openTasks.map((t) => ({ id: String(t.id), status: String(t.status || ''), priority: String(t.priority || '') })),
  };
}

const summary = {
  total: ROLES.length,
  busy: ROLES.filter((r) => ['hold', 'stale_alert'].includes(roles[r].decision)).length,
  dispatchable: ROLES.filter((r) => roles[r].decision === 'dispatchable').length,
  standby: ROLES.filter((r) => roles[r].decision === 'standby').length,
  rotateFirst: ROLES.filter((r) => roles[r].decision === 'rotate_first').length,
  staleAlert: ROLES.filter((r) => roles[r].decision === 'stale_alert').length,
};
const payload = {
  at: new Date(NOW_MS).toISOString(),
  project: PROJECT,
  root: ROOT,
  sources: {
    queue: queueRaw ? 'file' : 'missing',
    rounds: fs.existsSync(path.join(STATE_DIR, '会话轮次.json')) ? 'file' : 'missing',
    usage: usageRaw ? 'file' : 'missing',
    tasks: tasks.length,
  },
  thresholds: { rotateRounds: ROTATE_ROUNDS, staleMs: STALE_MS },
  unclaimedTasks: unclaimedWork.length,
  roles,
  summary,
  note: '只读调度建议：不自动派单、不写任何文件；派单仍由 PM 走 send --task/--ack。',
};

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(payload) + '\n');
} else {
  console.log(`PM 调度建议（${PROJECT}，${payload.at}）｜ 忙 ${summary.busy} · 可派 ${summary.dispatchable} · 待命 ${summary.standby} · 先换人 ${summary.rotateFirst}`);
  for (const role of ROLES) {
    const r = roles[role];
    console.log(`- ${role}: ${r.decision}（${r.reasons.join('；')}）`);
  }
}
process.exit(0);
