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
import { PATHS, WORKSPACE, appendLine } from './core.mjs';
import { loadTeam, saveTeam, projectStatePaths, sendMessage } from './store.mjs';
import { ROUNDS_MAX } from './session-archive.mjs';
// B-20261117-212500-a837：换人必须真建会话（复用 session.mjs 的唯一出口），禁止在调度层自造 session id。
import { createTeamSession } from './session.mjs';

/* ── 常量（阈值与 session.mjs 同源：warn 30 万 / force 50 万；轮次沿用归档建议 20 轮） ── */
export const DEFAULT_TOKEN_WARN = 300000;
export const DEFAULT_TOKEN_FORCE = 500000;
// T-20261117-211833-7a30（R-a4c7 AC3①）：到线口径单源——默认 8，且必须 ≤ session-archive 的 ROUNDS_MAX(10)，
// 避免「归档归零线 10 < 换人触发线 20」这种永不归零的矛盾。调度建议（sched-advice.mjs）用同一个默认值。
export const DEFAULT_ROUNDS_LIMIT = 8;
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
/** 指定上海时间的当天 08:00（用于「昨夜入队 → 今日 08:00」的比较）。 */
export function morningAt(ms, hour = NIGHT_END_HOUR) {
  const p = shanghaiParts(ms);
  const localMidnight = Date.UTC(p.y, p.m - 1, p.day);
  return localMidnight + hour * 3600000 - SHANGHAI_OFFSET_MS;
}
/** 次日 08:00（上海）对应的时间戳（夜间入队用：23:30 → 明日 08:00；02:00 → 今日 08:00）。 */
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

/* ── rotate：建会话（唯一出口 createTeamSession，禁自造 id）+ 写名册 + 写壳 store + 审计 + 广播 ── */
async function rotateSession({ projectName, role, now, reason, auditFile, dryRun }) {
  const team = loadTeam();
  const member = (team.members || []).find((m) => m && m.role === role);
  const oldId = String((member && member.sessionId) || '');
  // 沙盘/自检可用 __AR_NEW_SESSION 指定新会话 id（= 手建登记：mode=manual / created=false）；
  // 未指定时一律走 createTeamSession：生产 DshClient.create，沙盘（TEAM_SELFTEST=1）用注入 factory 模拟。
  const injectedNewSessionId = String(process.env.__AR_NEW_SESSION || '').trim();
  const selftest = process.env.TEAM_SELFTEST === '1';
  const failInjected = selftest && String(process.env.__AR_CREATE_FAIL || '') === '1';
  let newId = '';
  let created = false;
  let mode = 'auto';
  if (dryRun) {
    newId = injectedNewSessionId || '(dry-run)';
    mode = 'dry-run';
  } else if (injectedNewSessionId) {
    newId = injectedNewSessionId;
    mode = 'manual';
  } else {
    try {
      const info = await createTeamSession({
        projectName,
        role,
        oldId,
        reason,
        createSession: selftest ? async ({ role: r }) => {
          if (failInjected) throw new Error('注入失败：createSession 不可用（__AR_CREATE_FAIL=1）');
          return { sessionId: `session-fake-${r}-${Date.now().toString(36)}` };
        } : null,
      });
      newId = String(info.sessionId || '');
      created = Boolean(info.created);
      mode = String(info.mode || 'auto');
    } catch (e) {
      const code = String((e && e.code) || 'ROTATE_CREATE_FAILED');
      const details = (e && e.details) || {};
      const command = String(details.command || '');
      // 失败必须留痕且可操作：不写名册、不广播，审计行带手建降级命令。
      if (!dryRun) {
        appendAudit(auditFile, {
          at: iso(now), stage: 'rotate_failed', code, result: 'fail', role, project: projectName,
          note: `自动建会话失败（${code}）：本轮不换人${command ? `；手建降级命令：${command}` : ''}`,
          reason: String(reason || 'context-full'),
          evidence: { mode: 'manual', created: false, code, manualCommand: command, oldSessionId: oldId, why: String((e && e.message) || e) },
        });
      }
      return { oldId, newId: '', others: [], failed: true, code, manualCommand: command };
    }
  }
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
  // T-f35b（AC5 四测）：换人必须留「会话轮换记录 from/to/at/reason」+「归档或 archiveDeferred」。
  // 记录 append-only 落 团队/状态/项目/<项目>/会话轮换.jsonl；有未闭环任务时不强行归档，写 archiveDeferred。
  const openTasks = (() => {
    try { return workingTasksOf(projectName, role).slice(0, 20); } catch { return []; }
  })();
  const archiveDeferred = openTasks.length
    ? { code: 'ARCHIVE_DEFERRED', tasks: openTasks, note: '有未闭环任务：先闭环再归档（归档是建议不是硬门）' }
    : null;
  if (!dryRun) {
    try {
      appendLine(path.join(projectStatePaths(projectName).dir, '会话轮换.jsonl'), JSON.stringify({
        at: iso(now), project: projectName, role, from: oldId, to: newId,
        reason: String(reason || 'context-full'), by: 'auto-rotate', mode, created, archiveDeferred,
      }));
    } catch { /* 记录失败不影响换人；审计行仍带 from/to */ }
  }
  // 行级 mode/created 同时放在**顶层**（审查/验收脚本按 rot.mode / rot.created 读）与 evidence 内（明细），两处同值。
  const rotateRow = { at: iso(now), stage: 'rotate', code: 'ROTATED', result: 'ok', role, project: projectName, mode, created, note: `已换人：${oldId || '未记录'} → ${newId}（${reason || 'context-full'}｜${mode}${created ? '/created' : ''}）`, evidence: { mode, created, oldSessionId: oldId, newSessionId: newId, reason: String(reason || 'context-full'), from: oldId, to: newId, rotatedAt: iso(now), ...(archiveDeferred ? { archiveDeferred } : { archive: 'pending-daily' }) } };
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
  return { oldId, newId, others: others.map((m) => m.role), mode, created };
}

/* ── AC3（红线）：在办任务不换人 ─────────────────────────────────────── */
/** 该角色名下 status=working 的任务（镜像需求行不算「在办」，与 gates.isRequirementMirrorTask 同口径）。 */
export function workingTasksOf(projectName, role) {
  const dir = projectStatePaths(projectName).tasks;
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const file of names) {
    if (!file.endsWith('.json')) continue;
    const task = readJsonSafe(path.join(dir, file), null);
    if (!task || !task.id) continue;
    if (String(task.status || '') !== 'working') continue;
    if (String(task.owner || '') !== String(role || '')) continue;
    if (String(task.type || '') === 'requirement' || String(task.id) === String(task.requirementId || '')) continue;
    out.push(String(task.id));
  }
  return out;
}

/* ── AC6②③：换人后的 boot 校验（boot_verified / boot_timeout） ───────── */
/** 新会话是否已 boot：读 阅读.jsonl 里 kind=boot 且 sessionId 命中（或 boots[role].at 晚于换人时刻）。 */
export function bootObserved({ projectName, role, newSessionId, sinceMs }) {
  const reads = path.join(PATHS.state, '阅读.jsonl');
  try {
    if (fs.existsSync(reads)) {
      for (const line of fs.readFileSync(reads, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        let row = null;
        try { row = JSON.parse(line); } catch { continue; }
        if (!row || String(row.kind || '') !== 'boot') continue;
        if (String(row.sessionId || '') !== String(newSessionId || '')) continue;
        const at = Date.parse(String(row.at || ''));
        if (!Number.isFinite(at) || at >= sinceMs - 1000) return { observed: true, at: row.at || '' };
      }
    }
  } catch { /* 读不到当未观察到，超时后按 boot_timeout 处理 */ }
  // 兜底：工作流 boots[role]（部分角色走 CLI-only 回退，也可能落在 boots 上）
  try {
    const wf = readJsonSafe(path.join(projectStatePaths(projectName).dir, '工作流.json'), {});
    const boot = wf && wf.boots && wf.boots[role];
    const at = Date.parse(String((boot && boot.at) || ''));
    if (Number.isFinite(at) && at >= sinceMs - 1000) return { observed: true, at: boot.at };
  } catch { /* ignore */ }
  return { observed: false, at: '' };
}

/* ── AC1 反例 / AC2：用量与轮次的可用性 ─────────────────────────────── */
function usageRolesOf(usage) {
  const out = {};
  for (const [role, raw] of Object.entries(usage || {})) {
    const row = raw && typeof raw === 'object' ? raw : {};
    const tokens = Number(row.tokens);
    out[role] = { usable: Number.isFinite(tokens) && tokens > 0, tokens: Number.isFinite(tokens) ? tokens : null };
  }
  return out;
}

/* ── AC7：交接请求正文六段行序（触发原因 / 目标文件 / 需写内容 / 死线 / 回执要求 / 模板） ── */
export function handoverRequestBody({ role, level, kind, tokens, rounds, deadlineIso, projectName }) {
  const reason = kind === 'rounds'
    ? `轮数已达 ${rounds} 轮（阈值 ${DEFAULT_ROUNDS_LIMIT} 轮），需要换新会话`
    : `上下文用量 ${tokens}（${level === 'force' ? '强制档' : '预警档'}：force ${DEFAULT_TOKEN_FORCE} / warn ${DEFAULT_TOKEN_WARN}），需要换新会话`;
  return [
    '一、触发原因：' + reason,
    `二、目标文件：${ROLE_DIRS[role] || role}/产出/交接-最新.md（整份覆盖写，写最新的在办状态）`,
    '三、需写内容：在办任务 id 与当前进度、下一步动作、未决问题与卡点、关键文件路径、本会话约定与临时口径',
    `四、死线：${deadlineIso} 前完成（逾期不换人，只升级 PM 催办）`,
    '五、回执要求：交接文件写完后回执 PM 一条，主题含「交接完成」，正文写「交接已完成 + 文件路径」（系统据此校验并执行换人）',
    '六、模板：\n# 交接-最新（<角色> · <时间>）\n## 在办\n## 下一步\n## 卡点\n## 关键文件\n## 口径与约定',
  ].join('\n');
}

/* ── ⑤ 接线：团队配置 + 周期 tick（route-daemon 调用） ───────────────── */
export const DEFAULT_INTERVAL_MS = 300000;   // 5 分钟

/**
 * 团队配置 autoRotate={enabled,intervalMs,rotateRounds}；缺省 enabled=true / 300000 / 8。
 * 0 或 false = 关。PM 2026-11-17 21:36 最终口径：rotateRounds 默认 8、**上限 10**；
 * 配置 >10 必须 fail fast（AUTO_ROTATE_CONFIG_INVALID）——静默回落会让「永不触发」被当成正常。
 */
export const ROUNDS_CONFIG_MAX = 10;
export function autoRotateConfigOf(team) {
  const raw = (team && team.config && team.config.autoRotate) || {};
  const enabledRaw = raw.enabled === undefined ? true : raw.enabled;
  const enabled = !(enabledRaw === false || enabledRaw === 0 || String(enabledRaw) === '0' || String(enabledRaw) === 'false');
  const interval = Number(raw.intervalMs);
  const roundsRaw = raw.rotateRounds;
  const rounds = Number(roundsRaw);
  if (Number.isFinite(rounds) && rounds > ROUNDS_CONFIG_MAX) {
    const err = new Error(`AUTO_ROTATE_CONFIG_INVALID：autoRotate.rotateRounds=${rounds} 超过上限 ${ROUNDS_CONFIG_MAX}（默认 8；上限 10；>10 视为配置错误，不静默回落）`);
    err.code = 'AUTO_ROTATE_CONFIG_INVALID';
    err.details = { rotateRounds: rounds, max: ROUNDS_CONFIG_MAX, default: DEFAULT_ROUNDS_LIMIT };
    throw err;
  }
  return {
    enabled,
    intervalMs: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL_MS,
    rotateRounds: Number.isFinite(rounds) && rounds > 0 ? rounds : DEFAULT_ROUNDS_LIMIT,
  };
}

/** 昨夜入队（deferredUntil = 今日 08:00）的角色；优先 stage=enqueue，旧数据回退 NIGHT_SILENT 行。 */
export function queuedForToday({ rows, todayDefer }) {
  const target = String(todayDefer || '');
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const ev = row && row.evidence ? row.evidence : {};
    if (String(ev.deferredUntil || '') !== target) continue;
    const role = String(row.role || '');
    if (!role || seen.has(role)) continue;
    const stage = String(row.stage || '');
    const code = String(row.code || '');
    const isQueueRow = stage === 'enqueue' || String(row.event || '') === 'enqueue' || (stage === 'skipped' && code === 'NIGHT_SILENT');
    if (!isQueueRow) continue;
    seen.add(role);
    out.push({ role, level: String(ev.level || (ev.forced ? 'force' : 'rounds')), kind: String(ev.kind || ''), tokens: ev.tokens, rounds: ev.rounds, forced: Boolean(ev.forced), order: Number(ev.order || 0), deferredUntil: target });
  }
  return out;
}

/**
 * 今日已换过的角色（B-20261117-212500-a837 ①｜严格队列口径，三源取并）：
 *   ① 自动换人.jsonl 的 rotate 行（本调度器自己换的）；
 *   ② 团队/状态/项目/<P>/会话轮换.jsonl（append-only 轮换记录）；
 *   ③ 团队/状态/项目/<P>/会话轮换/<角色>.json（session.mjs rotate 的权威记录，覆盖 CLI / PM 手建降级换人）。
 * 只看 ≥ 今日 08:00 的记录；失败行（result=fail）不算换过。
 */
function rotatedTodayRoles({ projectName, rows, todayDefer }) {
  const since = Date.parse(String(todayDefer || ''));
  const cut = Number.isFinite(since) ? since : 0;
  const out = new Set();
  for (const row of rows || []) {
    if (String(row.stage) !== 'rotate') continue;
    if (String(row.result || '') === 'fail') continue;
    const at = Date.parse(String(row.at || ''));
    if (Number.isFinite(at) && at >= cut) out.add(String(row.role || ''));
  }
  const takeRecord = (rec) => {
    if (!rec || typeof rec !== 'object') return;
    const role = String(rec.role || '');
    const at = Date.parse(String(rec.at || rec.rotatedAt || ''));
    if (role && Number.isFinite(at) && at >= cut) out.add(role);
  };
  const dir = projectStatePaths(projectName).dir;
  try {
    const jsonl = path.join(dir, '会话轮换.jsonl');
    if (fs.existsSync(jsonl)) {
      for (const line of fs.readFileSync(jsonl, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { takeRecord(JSON.parse(line)); } catch { /* 坏行忽略，不影响判断 */ }
      }
    }
  } catch { /* 无 jsonl 不阻断 */ }
  try {
    const rdir = path.join(dir, '会话轮换');
    if (fs.existsSync(rdir)) {
      for (const name of fs.readdirSync(rdir)) {
        if (!name.endsWith('.json')) continue;
        try { takeRecord(readJsonSafe(path.join(rdir, name), null)); } catch { /* 坏记录忽略 */ }
      }
    }
  } catch { /* 无目录不阻断 */ }
  return out;
}

/**
 * 跑一拍（带配置门禁）——route-daemon 循环里直接调它：
 *   · enabled=false / 0 → 跳过；距上次不足 intervalMs → 跳过（不重入）；
 *   · 同一进程内用传入的 state 记上次执行时间（不落盘，重启后重算）。
 * 返回 { ok, skipped?: 'disabled'|'interval', result? }。
 */
export function runAutoRotateBeat(projectName, { now, state, source = 'route-daemon' } = {}) {
  const box = state && typeof state === 'object' ? state : {};
  let cfg;
  try {
    cfg = autoRotateConfigOf(loadTeam());
  } catch (e) {
    if (e && e.code === 'AUTO_ROTATE_CONFIG_INVALID') return { ok: false, code: 'AUTO_ROTATE_CONFIG_INVALID', message: String((e && e.message) || e), details: e.details || null };
    return { ok: false, code: 'TEAM_UNREADABLE', message: String((e && e.message) || e) };
  }
  if (!cfg.enabled) return { ok: true, skipped: 'disabled', config: cfg };
  const at = resolveNow(now);
  const last = Number(box.lastAt || 0);
  if (last && at - last < cfg.intervalMs) return { ok: true, skipped: 'interval', config: cfg, nextAt: iso(last + cfg.intervalMs) };
  if (box.busy) return { ok: true, skipped: 'busy', config: cfg };
  box.lastAt = at;
  box.busy = true;
  try {
    const result = runAutoRotateCycle(projectName, { now: at, dryRun: false, source });
    return { ok: true, config: cfg, result };
  } catch (e) {
    return { ok: false, code: 'AUTO_ROTATE_FAILED', message: String((e && e.message) || e).slice(0, 300), config: cfg };
  } finally {
    box.busy = false;
  }
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
  let cfg;
  try {
    cfg = autoRotateConfigOf(team);
  } catch (e) {
    if (e && e.code === 'AUTO_ROTATE_CONFIG_INVALID') {
      return { ok: false, code: 'AUTO_ROTATE_CONFIG_INVALID', message: String((e && e.message) || e), details: e.details || null, project: name, at: iso(now) };
    }
    throw e;
  }
  const rawAutoRotate = (team && team.config && team.config.autoRotate) || null;
  const configFallback = !(rawAutoRotate && typeof rawAutoRotate === 'object');
  // 不可读 = 文件缺失 或 形状不对（没有任何 <role>.roundsSinceArchive 数字）；两种都不按 0 轮静默。
  // T-f35b：轮次源「不可用」包括**形状不对**（如 {roles:{...}} 包了一层）——不能当成 0 轮静默。
  const roundsKeys = Object.keys(rounds || {});
  const roundsShapeOk = roundsKeys.length === 0 ? false : roundsKeys.some((key) => {
    const row = rounds[key];
    return row && typeof row === 'object' && Number.isFinite(Number(row.roundsSinceArchive));
  });
  const roundsUnreadable = !fs.existsSync(roundsFileOf(name)) || !roundsShapeOk;
  const usageRoles = usageRolesOf(usage);
  const usageUnavailableRoles = memberRoles.filter((role) => !(usageRoles[role] && usageRoles[role].usable));
  const workingByRole = {};
  for (const role of memberRoles) workingByRole[role] = workingTasksOf(name, role);
  const candidates = collectCandidates({ now, usage, rounds, memberRoles, roundsLimit: cfg.rotateRounds });
  const rows = readAudit(auditFile);
  const actions = [];
  const night = isNight(now);
  const nextDayWindow = isNextDayWindow(now);
  const nightKey = nightKeyOf(now);
  const nowIso = iso(now);

  // ③ 审计补 stage=cycle（每拍一行，便于面板 [data-ar-audit-tail] 与「今日 N 次」统计）
  if (!dryRun) {
    appendAudit(auditFile, {
      // T-f35b①：调度层事件不进「换人流水线 stage 枚举」——改用 event=cycle（kind=schedule）；历史行不回改。
      at: nowIso, event: 'cycle', kind: 'schedule', code: 'CYCLE', result: 'ok', role: '', project: name,
      note: `一拍：${night ? '夜间' : nextDayWindow ? '次日窗口' : '白天'} · 候选 ${candidates.length} 个 · 源 ${source}`,
      evidence: { mode: night ? 'night' : nextDayWindow ? 'next-day' : 'day', candidates: candidates.map((c) => `${c.role}:${c.level}`), source, config: cfg, configFallback },
    });
    // AC8：配置缺省回落要留痕（每天首拍记一行，避免每拍刷屏）
    if (configFallback) {
      const todayKey = new Date(now + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
      const already = rows.some((r) => String(r.code) === 'CONFIG_FALLBACK' && String(r.at || '').slice(0, 10) === todayKey);
      if (!already) appendAudit(auditFile, { at: nowIso, stage: 'skipped', code: 'CONFIG_FALLBACK', result: 'ok', role: '', project: name, note: `团队配置没有 autoRotate → 回落默认值（enabled=true / intervalMs=${DEFAULT_INTERVAL_MS} / rotateRounds=${DEFAULT_ROUNDS_LIMIT}）`, evidence: { config: cfg } });
    }
    // AC2：轮次源不可读要显式留痕（不许静默当 0 轮）
    if (roundsUnreadable) {
      appendAudit(auditFile, { at: nowIso, stage: 'skipped', code: 'ROUNDS_UNREADABLE', result: 'ok', role: '', project: name, note: '会话轮次.json 缺失或不可解析：本轮不做轮数触发（不按 0 轮处理）', evidence: { file: roundsFileOf(name) } });
    }
    // AC1 反例：用量不可用（缺失/超 24h）要留痕
    for (const role of usageUnavailableRoles) {
      appendAudit(auditFile, { at: nowIso, stage: 'skipped', code: 'USAGE_UNAVAILABLE', result: 'ok', role, project: name, note: `${role} 的会话用量缺失或超 24h：本轮不按 token 触发（未知不等于 0）`, evidence: { usageFile: usageFileOf(name) } });
    }
  }

  // AC6②③：换人后的 boot 校验（每拍补一次；15 分钟未 boot → boot_timeout + @PM）
  const BOOT_TIMEOUT_MS = 15 * 60 * 1000;
  for (const row of rows) {
    if (String(row.stage) !== 'rotate' || !row.evidence || !row.evidence.newSessionId) continue;
    const newSessionId = String(row.evidence.newSessionId);
    const since = Date.parse(String(row.at || '')) || now;
    if (now - since > 24 * 3600 * 1000) continue;
    const settled = rows.some((r) => (String(r.code) === 'boot_verified' || String(r.code) === 'boot_timeout')
      && String((r.evidence || {}).newSessionId || '') === newSessionId);
    if (settled) continue;
    const seen = bootObserved({ projectName: name, role: String(row.role || ''), newSessionId, sinceMs: since });
    if (seen.observed) {
      if (!dryRun) appendAudit(auditFile, { at: nowIso, stage: 'boot_check', code: 'boot_verified', result: 'ok', role: String(row.role || ''), project: name, note: `${row.role} 新会话已 boot（${seen.at}）`, evidence: { newSessionId, bootedAt: seen.at } });
      actions.push({ stage: 'boot_check', code: 'boot_verified', role: row.role });
    } else if (now - since > BOOT_TIMEOUT_MS) {
      if (!dryRun) {
        appendAudit(auditFile, { at: nowIso, stage: 'boot_check', code: 'boot_timeout', result: 'ok', role: String(row.role || ''), project: name, note: `${row.role} 换人后 15 分钟仍未 boot：已提示 PM`, evidence: { newSessionId, waitedMs: now - since } });
        try {
          sendMessage({ from: 'system', to: 'pm', project: name, type: 'escalation', subject: `boot_timeout：${row.role} 换人后未 boot`, body: `${row.role} 已于 ${row.at} 换到新会话 ${newSessionId}，15 分钟内没有观察到 boot。\n请确认新会话是否需要手动拉起；名册已更新，旧会话不再接该角色派单。` });
        } catch { /* 审计已留痕 */ }
      }
      actions.push({ stage: 'boot_check', code: 'boot_timeout', role: row.role });
    }
  }

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
        reason: '夜间静默（22–08）未换人：只记账，次日 08:00 起按队列入队执行',
        evidence: {
          threshold: { level: item.level, kind: item.kind, tokens: item.tokens === undefined ? null : item.tokens, rounds: item.rounds === undefined ? null : item.rounds, warn: DEFAULT_TOKEN_WARN, force: DEFAULT_TOKEN_FORCE, roundsLimit: cfg.rotateRounds },
          forced: item.level === 'force',
          deferredUntil, nightKey, source,
        },
      };
      if (!dryRun) {
        appendAudit(auditFile, row);
        // ③ 审计补 stage=enqueue：把「入队」与「跳过」分开两类，次日队列直接按 enqueue 行取（对旧数据回退到 NIGHT_SILENT 行）。
        appendAudit(auditFile, {
          // T-f35b①：入队同样是调度层事件（event=enqueue / kind=schedule），不占用换人 stage 枚举。
        at: nowIso, event: 'enqueue', kind: 'schedule', code: 'NIGHT_QUEUED', result: 'ok', role: item.role, project: name,
          note: `已入队：${item.level} 档，次日 08:00 执行（deferredUntil=${deferredUntil}）`,
          evidence: { level: item.level, kind: item.kind, tokens: item.tokens === undefined ? null : item.tokens, rounds: item.rounds === undefined ? null : item.rounds, forced: item.level === 'force', deferredUntil, nightKey: nightKey, order: item.atMs },
        });
      }
      recorded.push(item.role);
      actions.push({ stage: 'skipped', code: 'NIGHT_SILENT', role: item.role, deferredUntil });
    }
    return { ok: true, project: name, at: nowIso, mode: 'night', nightKey, candidates: candidates.map((c) => `${c.role}:${c.level}`), recorded, actions, dryRun, source };
  }

  /* ② 次日 08:00–08:30 执行窗口：**严格按昨夜入队记账**执行，每次只换一个角色
       （PM 2026-11-17 19:52 裁定：昨夜无入队 → 本窗口不执行任何阈值命中） */
  if (nextDayWindow) {
    const todayDefer = iso(morningAt(now));   // 今日 08:00
    const queuedAll = queuedForToday({ rows, todayDefer });
    // 今日已换过的角色不再入队（严格队列：每拍只换 1 个，且一个角色一天只换一次）
    // 去重源=审计 rotate 行 + 会话轮换.jsonl + 会话轮换/<角色>.json（含 CLI/PM 手建降级换人）。
    const rotatedRoles = rotatedTodayRoles({ projectName: name, rows, todayDefer });
    const queued = queuedAll.filter((q) => !rotatedRoles.has(q.role));
    if (!queued.length) {
      return { ok: true, project: name, at: nowIso, mode: 'next-day', queued: [], actions, dryRun, source, note: '昨夜无入队记账：本窗口不执行任何命中（严格队列口径）' };
    }
    const order = (x) => (x.level === 'force' ? 0 : x.level === 'rounds' ? 1 : 2);
    queued.sort((a, b) => {
      if (order(a) !== order(b)) return order(a) - order(b);
      const ra = Number(a.rounds || 0); const rb = Number(b.rounds || 0);
      if (rb !== ra) return rb - ra;
      return Number(a.order || 0) - Number(b.order || 0);
    });
    // AC3（红线）：在办任务不换人——昨夜入队了也一样，先跳过并留痕
    const eligible = [];
    for (const q of queued) {
      const working = workingByRole[q.role] || [];
      if (working.length) {
        if (!dryRun) appendAudit(auditFile, { at: nowIso, stage: 'skipped', code: 'SKIPPED_BY_WORKING_TASK', result: 'ok', role: q.role, project: name, note: `${q.role} 有在办任务（${working.slice(0, 3).join(',')}）：本轮不换人（红线）`, evidence: { workingTasks: working } });
        actions.push({ stage: 'skipped', code: 'SKIPPED_BY_WORKING_TASK', role: q.role });
        continue;
      }
      eligible.push(q);
    }
    if (!eligible.length) {
      return { ok: true, project: name, at: nowIso, mode: 'next-day', queued: queued.map((q) => q.role), actions, dryRun, source, note: '昨夜入队的角色都有在办任务：本轮不换（AC3 红线）' };
    }
    const head = eligible[0];
    const rotated = await rotateSession({ projectName: name, role: head.role, now, reason: `next-day-queue-${head.level}`, auditFile, dryRun });
    if (rotated.failed) {
      actions.push({ stage: 'rotate', role: head.role, code: rotated.code, result: 'fail' });
      return { ok: false, code: rotated.code, project: name, at: nowIso, mode: 'next-day', queued: queued.map((q) => q.role), rotated: [], actions, dryRun, source, manualCommand: rotated.manualCommand, note: `自动建会话失败（${rotated.code}）：本轮不换人，已留手建降级命令` };
    }
    actions.push({ stage: 'rotate', role: head.role, oldSessionId: rotated.oldId, newSessionId: rotated.newId, mode: 'next-day', createMode: rotated.mode, created: rotated.created });
    actions.push({ stage: 'broadcast_reboot', role: head.role, roles: rotated.others });
    return { ok: true, project: name, at: nowIso, mode: 'next-day', queued: queued.map((q) => q.role), rotated: [head.role], actions, dryRun, source, note: '每拍只换一个：本拍换 ' + head.role };
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
    // AC3（红线）：角色有在办任务 → 一律不换人、不发交接请求，只留痕
    const working = workingByRole[item.role] || [];
    if (working.length) {
      if (!dryRun) appendAudit(auditFile, { at: nowIso, stage: 'skipped', code: 'SKIPPED_BY_WORKING_TASK', result: 'ok', role: item.role, project: name, note: `${item.role} 有在办任务（${working.slice(0, 3).join(',')}）：不换人（AC3 红线）`, evidence: { workingTasks: working, level: item.level } });
      actions.push({ stage: 'skipped', code: 'SKIPPED_BY_WORKING_TASK', role: item.role });
      continue;
    }
    // AC1 反例：warn 档只提醒，不发交接请求、不换人
    if (item.level === 'warn') {
      const recentWarn = rows.some((r) => String(r.code) === 'WARN_ONLY' && String(r.role) === item.role
        && Math.abs(now - Date.parse(String(r.at || ''))) < TRIGGER_DEDUPE_MS);
      if (!dryRun && !recentWarn) {
        appendAudit(auditFile, { at: nowIso, stage: 'skipped', code: 'WARN_ONLY', result: 'ok', role: item.role, project: name, note: `${item.role} 到预警档（${item.tokens} / warn ${DEFAULT_TOKEN_WARN}）：只提醒不换人`, evidence: { level: 'warn', tokens: item.tokens, warn: DEFAULT_TOKEN_WARN } });
        try {
          sendMessage({ from: 'system', to: item.role, project: name, type: 'session_rotate_warn', subject: `用量预警（只提醒不换人）：${item.tokens} ≥ ${DEFAULT_TOKEN_WARN}`, body: `${item.role} 本次会话用量 ${item.tokens}（预警档 ${DEFAULT_TOKEN_WARN} / 强制档 ${DEFAULT_TOKEN_FORCE}）。\n按口径：预警档只提醒、不自动换人；到强制档才会走交接流程。建议先把在办状态写进 <角色目录>/产出/交接-最新.md 备着。` });
        } catch { /* 审计已留痕 */ }
      }
      actions.push({ stage: 'skipped', code: 'WARN_ONLY', role: item.role });
      continue;
    }
    const pending = pendingOf(item.role);
    if (pending) {
      const done = handoverDone({ projectDir, role: item.role, mailDir, sinceMs: pending.at });
      if (done.done) {
        const rotated = await rotateSession({ projectName: name, role: item.role, now, reason: `handover:${done.source}`, auditFile, dryRun });
        if (rotated.failed) {
          actions.push({ stage: 'rotate', role: item.role, code: rotated.code, result: 'fail' });
          return { ok: false, code: rotated.code, project: name, at: nowIso, mode: 'day', actions, dryRun, source, manualCommand: rotated.manualCommand, note: `自动建会话失败（${rotated.code}）：本轮不换人，已留手建降级命令` };
        }
        actions.push({ stage: 'rotate', role: item.role, oldSessionId: rotated.oldId, newSessionId: rotated.newId, mode: 'handover', createMode: rotated.mode, created: rotated.created });
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
      // T-f35b③：已有在途交接请求（等回执阶段）→ 记 ALREADY_IN_FLIGHT（不重复发、不阻断）。
      if (!dryRun) {
        const already = rows.some((r) => String(r.code) === 'ALREADY_IN_FLIGHT' && String(r.role) === item.role
          && Math.abs(now - Date.parse(String(r.at || ''))) < TRIGGER_DEDUPE_MS);
        if (!already) {
          appendAudit(auditFile, { at: nowIso, stage: 'skipped', code: 'ALREADY_IN_FLIGHT', result: 'ok', role: item.role, project: name, note: `${item.role} 的交接请求仍在途（自 ${pending.atIso}）：不重复发（ALREADY_IN_FLIGHT）`, evidence: { requestedAt: pending.atIso, dedupeMs: TRIGGER_DEDUPE_MS } });
        }
      }
      actions.push({ stage: 'skipped', code: 'ALREADY_IN_FLIGHT', role: item.role, requestedAt: pending.atIso });
      continue;
    }
    // 无在途请求：命中阈值 → 只发 1 条交接请求（60 秒内不重复）
    const recentTrigger = rows.some((r) => String(r.stage) === 'trigger' && String(r.role) === item.role
      && Math.abs(now - Date.parse(String(r.at || ''))) < TRIGGER_DEDUPE_MS);
    if (recentTrigger) {
      // T-f35b③：重复请求的显式码（不阻断；冷却逻辑不变，只是把「为什么不发」写清楚）。
      if (!dryRun) {
        appendAudit(auditFile, { at: nowIso, stage: 'skipped', code: 'ALREADY_IN_FLIGHT', result: 'ok', role: item.role, project: name, note: `${item.role} 的交接请求已在途（60 秒去重窗口内）：不重复发（ALREADY_IN_FLIGHT）`, evidence: { dedupeMs: TRIGGER_DEDUPE_MS, level: item.level } });
      }
      actions.push({ stage: 'skipped', code: 'ALREADY_IN_FLIGHT', role: item.role });
      continue;
    }
    const row = {
      at: nowIso, stage: 'trigger', code: 'HANDOVER_REQUESTED', result: 'ok', role: item.role, project: name,
      // PM 2026-11-17 21:36 最终口径：轮次触发审计写「本轮 N/10（归零即归档）」（计数器语义不变）
      note: item.kind === 'rounds'
        ? `阈值命中（${item.level}）：轮次 ${item.rounds}/${ROUNDS_MAX}（归零即归档）——已发 1 条交接请求，等回执（触发码 rotate_rounds）`
        : `阈值命中（${item.level}）：已发 1 条交接请求，等回执（触发码 rotate_tokens）`,
      trigger: { kind: item.kind, level: item.level, tokens: item.tokens === undefined ? null : item.tokens, rounds: item.rounds === undefined ? null : item.rounds, force: DEFAULT_TOKEN_FORCE, warn: DEFAULT_TOKEN_WARN, forced: item.level === 'force', code: item.kind === 'rounds' ? 'rotate_rounds' : 'rotate_tokens' },
      evidence: { level: item.level, kind: item.kind, tokens: item.tokens === undefined ? null : item.tokens, rounds: item.rounds === undefined ? null : item.rounds, force: DEFAULT_TOKEN_FORCE, warn: DEFAULT_TOKEN_WARN, forced: item.level === 'force', code: item.kind === 'rounds' ? 'rotate_rounds' : 'rotate_tokens' },
    };
    if (!dryRun) {
      appendAudit(auditFile, row);
      try {
        // AC7：交接请求正文六段固定行序
        sendMessage({
          from: 'system', to: item.role, project: name, type: 'session_rotate_warn',
          subject: `请先交接（${item.kind === 'rounds' ? `轮数 ${item.rounds}` : `${item.level === 'force' ? '强制档' : '预警档'} ${item.tokens}`}）`,
          body: handoverRequestBody({ role: item.role, level: item.level, kind: item.kind, tokens: item.tokens, rounds: item.rounds, deadlineIso: iso(now + HANDOVER_TIMEOUT_MS), projectName: name }),
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
