/**
 * auto-rotate.mjs —— R-fa0e（T-20261117-183920-4ea3）自动换人：一拍循环（A 案入口）
 *
 * 需求：R-20261117-180740-fa0e-角色上下文到顶自动换人.md（v3 / RR-34ba）
 * 契约：项目/工作台改造修复/项目经理/产出/fa0e-接线契约-20261117.md（A 案，本文件即入口）
 *
 * 五步流水线：触发（阈值）→ 只发 1 条交接请求 → 等回执 → rotate + 新会话 boot + 广播其余角色重 boot → 审计。
 * 硬规则（Owner 2026-11-17 定）：
 *   · 夜间 22:00–08:00 **一律不换人（含 force）**，只入队记账：stage=skipped / code=NIGHT_SILENT / deferredUntil=次日 08:00；
 *     同一夜同一角色只 1 行（幂等，按「夜键」= 以 08:00 为界的前一日）；
 *   · 次日 08:00–08:30 执行窗口：**force 档优先**，其余按轮次降序 → 触发时间早者，直接 rotate（夜间已入队，不再等回执）；
 *   · 阈值命中只发 1 条交接请求（同角色 60 秒内不重复发）；
 *   · 交接回执 15 分钟未到 → **不换人，只升级 PM**（skipped/HANDOVER_TIMEOUT）；
 *   · 全程 append-only 审计写 `团队/状态/项目/<项目>/自动换人.jsonl`。
 *
 * 时间可注入：`AWB_NOW`（带时区偏移，如 `2026-11-17T08:05:00+08:00`；非法值回落系统时间）——
 * 与 团队/工具/lib/lessons.mjs 的 AWB_NOW 先例同口径，自检/复验不需要改系统时钟。
 *
 * 沙箱安全：所有路径都经 core.mjs 的 PATHS / projectStatePaths（由 TEAM_ROOT / TEAM_PROJECTS_ROOT 决定），
 * 壳的 store 走 TEAM_WORKBENCH_JSON；沙箱运行（TEAM_SELFTEST=1）不写真实状态。
 *
 * 导出：runAutoRotateCycle(projectName, { now, dryRun, source }) → JSON（审计/名册/邮箱是判据）
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, WORKSPACE } from './core.mjs';
import { loadTeam, saveTeam, projectStatePaths, sendMessage } from './store.mjs';

/* ── 常量（阈值与 session.mjs 同源：warn 30 万 / force 50 万；轮次沿用归档建议 20 轮） ── */
export const DEFAULT_TOKEN_WARN = 300000;
export const DEFAULT_TOKEN_FORCE = 500000;
export const DEFAULT_ROUNDS_LIMIT = 20;
export const HANDOVER_TIMEOUT_MS = 15 * 60 * 1000;
export const TRIGGER_DEDUPE_MS = 60 * 1000;
export const ROTATE_COOLDOWN_MS = 60 * 60 * 1000;
export const NIGHT_START_HOUR = 22;
export const NIGHT_END_HOUR = 8;
export const NEXTDAY_WINDOW_MINUTES = 30;
export const AUDIT_NAME = '自动换人.jsonl';
export const ROLE_DIRS = { pm: '项目经理', product: '产品', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' };

const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;

/* ── 小工具 ─────────────────────────────────────────────────────────── */
function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function iso(ms) { return new Date(Number(ms)).toISOString(); }
/** 上海本地时间（不依赖宿主时区，AWB_NOW 一律按 +08:00 解释）。 */
function shanghaiParts(ms) {
  const d = new Date(Number(ms) + SHANGHAI_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay() };
}
/** 注入时间解析：opts.now（数字/Date/ISO）> AWB_NOW > 系统时间。 */
export function resolveNow(input) {
  if (input instanceof Date && Number.isFinite(input.getTime())) return input.getTime();
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input === 'string' && input.trim()) {
    const ms = Date.parse(input.trim());
    if (Number.isFinite(ms)) return ms;
  }
  const raw = String(process.env.AWB_NOW || '').trim();
  if (raw) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now();
}
export function isNight(ms) {
  const { hour } = shanghaiParts(ms);
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}
export function isNextDayWindow(ms) {
  const { hour, minute } = shanghaiParts(ms);
  return hour === NIGHT_END_HOUR && minute < NEXTDAY_WINDOW_MINUTES;
}
/** 夜键：22:00–次日 08:00 属同一夜（08:00 前算前一日）。 */
export function nightKeyOf(ms) {
  const p = shanghaiParts(ms);
  const localMidnight = Date.UTC(p.y, p.m - 1, p.day);
  const dayMs = p.hour < NIGHT_END_HOUR ? localMidnight - 86400000 : localMidnight;
  return new Date(dayMs).toISOString().slice(0, 10);
}
/** 次日 08:00（上海）对应的时间戳。 */
export function nextMorningAt(ms, hour = NIGHT_END_HOUR) {
  const p = shanghaiParts(ms);
  const localMidnight = Date.UTC(p.y, p.m - 1, p.day);
  const base = p.hour < hour ? localMidnight : localMidnight + 86400000;
  return base + hour * 3600000 - SHANGHAI_OFFSET_MS;
}
function appendAudit(file, row) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
}
function readAudit(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

/* ── 数据源 ─────────────────────────────────────────────────────────── */
function usageFileOf(projectName) { return path.join(projectStatePaths(projectName).dir, '会话用量.json'); }
function roundsFileOf(projectName) { return path.join(projectStatePaths(projectName).dir, '会话轮次.json'); }
function auditFileOf(projectName) { return path.join(projectStatePaths(projectName).dir, AUDIT_NAME); }
function workbenchFileOf() {
  const env = String(process.env.TEAM_WORKBENCH_JSON || '').trim();
  if (env) return path.resolve(env);
  return path.join(WORKSPACE, 'data', 'userdata', 'workbench.json');
}
function projectDirOf(projectName) {
  const cfg = readJsonSafe(projectStatePaths(projectName).config, null);
  if (cfg && cfg.path) return path.resolve(cfg.path);
  return path.join(PATHS.projectState, projectName);
}

/** 候选：token 水位（force / warn）+ 轮次。同角色取最高优先级，force 在前。 */
export function collectCandidates({ now, usage, rounds, memberRoles, warnThreshold = DEFAULT_TOKEN_WARN, forceThreshold = DEFAULT_TOKEN_FORCE, roundsLimit = DEFAULT_ROUNDS_LIMIT }) {
  const roles = new Set(memberRoles || []);
  const byRole = new Map();
  const put = (item) => {
    const prev = byRole.get(item.role);
    if (!prev) { byRole.set(item.role, item); return; }
    const rank = (x) => (x.level === 'force' ? 3 : x.level === 'rounds' ? 2 : 1);
    if (rank(item) > rank(prev)) byRole.set(item.role, item);
  };
  for (const [role, raw] of Object.entries(usage || {})) {
    if (!roles.has(role)) continue;
    const row = raw && typeof raw === 'object' ? raw : {};
    const tokens = Number(row.tokens);
    if (!Number.isFinite(tokens) || tokens <= 0) continue;
    const atMs = Date.parse(String(row.at || ''));
    if (Number.isFinite(atMs) && now - atMs > 24 * 3600 * 1000) continue;   // 超 24h 视为用量过期
    const level = tokens >= Number(forceThreshold) ? 'force' : (tokens >= Number(warnThreshold) ? 'warn' : '');
    if (!level) continue;
    put({ role, kind: 'usage', level, tokens, atMs: Number.isFinite(atMs) ? atMs : now, usageAt: String(row.at || ''), sessionId: String(row.sessionId || '') });
  }
  for (const [role, raw] of Object.entries(rounds || {})) {
    if (!roles.has(role)) continue;
    const row = raw && typeof raw === 'object' ? raw : {};
    const n = Number(row.roundsSinceArchive);
    if (!Number.isFinite(n) || n < Number(roundsLimit)) continue;
    put({ role, kind: 'rounds', level: 'rounds', rounds: n, atMs: Number(row.updatedAt ? Date.parse(String(row.updatedAt)) : now) || now, usageAt: '' });
  }
  return Array.from(byRole.values()).sort((a, b) => {
    const rank = (x) => (x.level === 'force' ? 0 : x.level === 'rounds' ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const ra = Number(a.rounds || 0); const rb = Number(b.rounds || 0);
    if (rb !== ra) return rb - ra;
    return a.atMs - b.atMs;
  });
}

/* ── 回执检测：交接-最新.md 新于请求，或该角色的「交接」回执消息 ──────── */
function handoverDone({ projectDir, role, mailDir, sinceMs }) {
  const file = path.join(projectDir, ROLE_DIRS[role] || role, '产出', '交接-最新.md');
  try {
    const st = fs.statSync(file);
    if (st.mtimeMs >= sinceMs - 1000) return { done: true, source: '交接-最新.md' };
  } catch { /* 没有文件不是错误 */ }
  const boxes = [role, 'pm'];
  for (const boxOwner of boxes) {
    const dir = path.join(mailDir, boxOwner, 'new');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const msg = readJsonSafe(path.join(dir, name), null);
      if (!msg || String(msg.from || '') !== role) continue;
      const text = `${msg.type || ''} ${msg.subject || ''} ${msg.body || ''}`;
      if (!/交接|handover/i.test(text)) continue;
      const ts = Date.parse(String(msg.ts || msg.deliveredAt || ''));
      if (Number.isFinite(ts) && ts >= sinceMs - 1000) return { done: true, source: `邮件 ${msg.id || name}` };
    }
  }
  return { done: false, source: '' };
}

/* ── rotate：写名册 + 写壳 store + 审计 + 广播 ───────────────────────── */
function rotateSession({ projectName, role, now, reason, auditFile, dryRun }) {
  const team = loadTeam();
  const member = (team.members || []).find((m) => m && m.role === role);
  const oldId = String((member && member.sessionId) || '');
  const newId = `session-auto-${role}-${now.toString(36)}`;
  const wbFile = workbenchFileOf();
  const store = readJsonSafe(wbFile, null);
  if (!dryRun) {
    if (member) {
      member.sessionId = newId;
      member.rotatedAt = iso(now);
      member.rotateReason = String(reason || 'context-full');
      saveTeam(team);
    }
    if (store && Array.isArray(store.projects)) {
      const project = store.projects.find((p) => p && String(p.teamName || p.name || '') === projectName) || store.projects[0];
      if (project) {
        project.sessions = { ...(project.sessions || {}), [role]: newId };
        if (project.workspace && Array.isArray(project.workspace.sessionIds)) {
          project.workspace.sessionIds = project.workspace.sessionIds.map((id) => (id === oldId ? newId : id));
        }
        fs.writeFileSync(wbFile, JSON.stringify(store, null, 2) + '\n', 'utf8');
      }
    }
  }
  const rotateRow = { at: iso(now), stage: 'rotate', code: 'ROTATED', result: 'ok', role, project: projectName, note: `已换人：${oldId || '未记录'} → ${newId}（${reason || 'context-full'}）`, evidence: { oldSessionId: oldId, newSessionId: newId, reason: String(reason || 'context-full') } };
  if (!dryRun) appendAudit(auditFile, rotateRow);

  // 新会话 boot 指令（给本人）+ 其余角色重 boot 广播（名册变更=全员旧令牌失效）
  const others = (team.members || []).filter((m) => m && m.role !== role && (!m.status || m.status === 'active'));
  if (!dryRun) {
    try {
      sendMessage({
        from: 'system', to: role, project: projectName, type: 'notice',
        subject: `已换人：请在新会话 boot（${role}）`,
        body: `本角色会话已轮换：${oldId || '未记录'} → ${newId}。\n请在新会话执行：node 团队\\工具\\team.mjs boot --role ${role} --project ${projectName} --session ${newId}\n原因：${reason || 'context-full'}。`,
      });
    } catch { /* 消息失败不影响换人本身，下面审计带出 */ }
    for (const m of others) {
      try {
        sendMessage({
          from: 'system', to: m.role, project: projectName, type: 'notice',
          subject: '名册变更：请重 boot（换人后旧令牌已失效）',
          body: `${role} 已换人（${oldId || '未记录'} → ${newId}），团队名册变更使全员旧令牌失效。\n请执行：node 团队\\工具\\team.mjs boot --role ${m.role} --project ${projectName}`,
        });
      } catch { /* 单个失败不阻断其他广播 */ }
    }
    appendAudit(auditFile, { at: iso(now), stage: 'broadcast_reboot', code: 'REBOOT_BROADCAST', result: 'ok', role, project: projectName, note: `已广播 ${others.length} 个角色重 boot`, evidence: { newSessionId: newId, roles: others.map((m) => m.role) } });
  }
  return { oldId, newId, others: others.map((m) => m.role) };
}

/* ── 主循环 ─────────────────────────────────────────────────────────── */
export async function runAutoRotateCycle(projectName, options = {}) {
  const name = String(projectName || process.env.__AR_PROJECT || '').trim();
  if (!name) return { ok: false, code: 'PROJECT_REQUIRED', message: '需要项目名' };
  const now = resolveNow(options.now !== undefined ? options.now : (process.env.__AR_NOW ? Number(process.env.__AR_NOW) : undefined));
  const dryRun = options.dryRun === true;
  const source = String(options.source || 'auto-rotate');
  const auditFile = auditFileOf(name);
  const usage = readJsonSafe(usageFileOf(name), {}) || {};
  const rounds = readJsonSafe(roundsFileOf(name), {}) || {};
  const team = loadTeam();
  const members = (team.members || []).filter((m) => m && (!m.status || m.status === 'active'));
  const memberRoles = members.map((m) => m.role);
  const projectDir = projectDirOf(name);
  const mailDir = PATHS.mail;
  const candidates = collectCandidates({ now, usage, rounds, memberRoles });
  const rows = readAudit(auditFile);
  const actions = [];
  const night = isNight(now);
  const nextDayWindow = isNextDayWindow(now);
  const nightKey = nightKeyOf(now);
  const nowIso = iso(now);

  /* ① 夜间：只记账不换人（含 force），同夜同角色只 1 行 */
  if (night) {
    const recorded = [];
    for (const item of candidates) {
      const dup = rows.some((r) => String(r.stage) === 'skipped' && String(r.code) === 'NIGHT_SILENT'
        && String(r.role) === item.role && String((r.evidence || {}).nightKey || '') === nightKey);
      if (dup) { actions.push({ stage: 'skipped', code: 'NIGHT_SILENT', role: item.role, dedupe: true }); continue; }
      const deferredUntil = iso(nextMorningAt(now));
      const row = {
        at: nowIso, stage: 'skipped', code: 'NIGHT_SILENT', result: 'ok', role: item.role, project: name,
        note: '夜间 22:00–08:00 一律不换人（含 force），已入队次日 08:00 执行',
        reason: '夜间静默：22:00–08:00 不换人（含 force），只记账',
        evidence: {
          threshold: { level: item.level, kind: item.kind, tokens: item.tokens === undefined ? null : item.tokens, rounds: item.rounds === undefined ? null : item.rounds, warn: DEFAULT_TOKEN_WARN, force: DEFAULT_TOKEN_FORCE, roundsLimit: DEFAULT_ROUNDS_LIMIT },
          forced: item.level === 'force',
          deferredUntil, nightKey, source,
        },
      };
      if (!dryRun) appendAudit(auditFile, row);
      recorded.push(item.role);
      actions.push({ stage: 'skipped', code: 'NIGHT_SILENT', role: item.role, deferredUntil });
    }
    return { ok: true, project: name, at: nowIso, mode: 'night', nightKey, candidates: candidates.map((c) => `${c.role}:${c.level}`), recorded, actions, dryRun, source };
  }

  /* ② 次日 08:00–08:30 执行窗口：force 优先，直接 rotate（夜间已入队，不再等回执） */
  if (nextDayWindow) {
    for (const item of candidates) {
      const recent = rows.some((r) => String(r.stage) === 'rotate' && String(r.role) === item.role
        && Math.abs(Date.parse(String(r.at || '')) - now) < ROTATE_COOLDOWN_MS);
      if (recent) { actions.push({ stage: 'rotate', role: item.role, skipped: 'ROTATE_COOLDOWN' }); continue; }
      const rotated = rotateSession({ projectName: name, role: item.role, now, reason: `next-day-${item.level}`, auditFile, dryRun });
      actions.push({ stage: 'rotate', role: item.role, oldSessionId: rotated.oldId, newSessionId: rotated.newId, mode: 'next-day' });
      actions.push({ stage: 'broadcast_reboot', role: item.role, roles: rotated.others });
      rows.push({ at: nowIso, stage: 'rotate', role: item.role, evidence: { usageAt: item.usageAt } });
    }
    return { ok: true, project: name, at: nowIso, mode: 'next-day', candidates: candidates.map((c) => `${c.role}:${c.level}`), actions, dryRun, source };
  }

  /* ③ 白天常规流水线 */
  const pendingOf = (role) => {
    const reqs = rows.filter((r) => String(r.stage) === 'trigger' && String(r.role) === role);
    if (!reqs.length) return null;
    const last = reqs[reqs.length - 1];
    const lastAt = Date.parse(String(last.at || ''));
    const closed = rows.some((r) => String(r.role) === role
      && (String(r.stage) === 'rotate' || (String(r.stage) === 'skipped' && String(r.code) === 'HANDOVER_TIMEOUT'))
      && Date.parse(String(r.at || '')) >= lastAt);
    return closed ? null : { at: lastAt, atIso: String(last.at || ''), evidence: last.evidence || {} };
  };

  for (const item of candidates) {
    const pending = pendingOf(item.role);
    if (pending) {
      const done = handoverDone({ projectDir, role: item.role, mailDir, sinceMs: pending.at });
      if (done.done) {
        const rotated = rotateSession({ projectName: name, role: item.role, now, reason: `handover:${done.source}`, auditFile, dryRun });
        actions.push({ stage: 'rotate', role: item.role, oldSessionId: rotated.oldId, newSessionId: rotated.newId, mode: 'handover' });
        actions.push({ stage: 'broadcast_reboot', role: item.role, roles: rotated.others });
        continue;
      }
      const waited = now - pending.at;
      if (waited > HANDOVER_TIMEOUT_MS) {
        const row = {
          at: nowIso, stage: 'skipped', code: 'HANDOVER_TIMEOUT', result: 'ok', role: item.role, project: name,
          note: `交接回执超时（${Math.round(waited / 60000)} 分钟 > 15 分钟）：不换人，只升级 PM`,
          evidence: { requestedAt: pending.atIso, waitedMs: waited, timeoutMs: HANDOVER_TIMEOUT_MS },
        };
        if (!dryRun) {
          appendAudit(auditFile, row);
          try {
            sendMessage({ from: 'system', to: 'pm', project: name, type: 'escalation', subject: `交接超时：${item.role} 未回执（不换人，请催办）`, body: `${item.role} 的交接请求自 ${pending.atIso} 起超 15 分钟未回执。按 Owner 口径：不自动换人，只升级 PM。\n请催办该角色补交接；补到后再跑一拍即会换人。` });
          } catch { /* 审计已留痕 */ }
        }
        actions.push({ stage: 'skipped', code: 'HANDOVER_TIMEOUT', role: item.role });
        continue;
      }
      actions.push({ stage: 'wait_handover', role: item.role, requestedAt: pending.atIso });
      continue;
    }
    // 无在途请求：命中阈值 → 只发 1 条交接请求（60 秒内不重复）
    const recentTrigger = rows.some((r) => String(r.stage) === 'trigger' && String(r.role) === item.role
      && Math.abs(now - Date.parse(String(r.at || ''))) < TRIGGER_DEDUPE_MS);
    if (recentTrigger) { actions.push({ stage: 'trigger', role: item.role, dedupe: true }); continue; }
    const row = {
      at: nowIso, stage: 'trigger', code: 'HANDOVER_REQUESTED', result: 'ok', role: item.role, project: name,
      note: `阈值命中（${item.level}）：已发 1 条交接请求，等回执`,
      trigger: { kind: item.kind, level: item.level, tokens: item.tokens === undefined ? null : item.tokens, rounds: item.rounds === undefined ? null : item.rounds, force: DEFAULT_TOKEN_FORCE, warn: DEFAULT_TOKEN_WARN, forced: item.level === 'force' },
      evidence: { level: item.level, kind: item.kind, tokens: item.tokens === undefined ? null : item.tokens, rounds: item.rounds === undefined ? null : item.rounds, force: DEFAULT_TOKEN_FORCE, warn: DEFAULT_TOKEN_WARN, forced: item.level === 'force' },
    };
    if (!dryRun) {
      appendAudit(auditFile, row);
      try {
        sendMessage({
          from: 'system', to: item.role, project: name, type: 'session_rotate_warn',
          subject: `请先交接（${item.level === 'force' ? '上下文到强制档' : '上下文到预警档'}）`,
          body: `${item.role}：${item.kind === 'rounds' ? `轮次已 ${item.rounds} 轮（阈值 ${DEFAULT_ROUNDS_LIMIT}）` : `会话用量 ${item.tokens}（强制档 ${DEFAULT_TOKEN_FORCE} / 预警档 ${DEFAULT_TOKEN_WARN}）`}。\n请把在办状态写进 <角色目录>/产出/交接-最新.md 并回执 PM；15 分钟内未回执不换人、只升级 PM。`,
        });
      } catch { /* 审计已留痕 */ }
    }
    actions.push({ stage: 'trigger', role: item.role, level: item.level });
  }

  return { ok: true, project: name, at: nowIso, mode: 'day', candidates: candidates.map((c) => `${c.role}:${c.level}`), actions, dryRun, source, auditFile };
}

/** 别名：契约允许 runAutoRotateTick / autoRotateCycle。 */
export const runAutoRotateTick = runAutoRotateCycle;
export const autoRotateCycle = runAutoRotateCycle;
export default runAutoRotateCycle;
