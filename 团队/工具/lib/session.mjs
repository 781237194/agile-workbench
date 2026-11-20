// 角色会话轮换与上下文回收（R-20261112-155311-c0a6）
//
// 命令（team.mjs session）：
//   session usage    [--project P] [--role R] [--warn 5000000] [--force 10000000] [--json]
//   session check    [--project P] [--json]
//   session rotate   --role R [--session S] [--reason "..."] [--force] [--offline] [--json]
//   session handover --role R [--project P] [--json]
//
// 四处映射（壳层唤醒以 workbench.json 为准，CLI 唤醒以 团队.json 为准，轮换必须四处同改）：
//   1) 团队/状态/团队.json          members[].sessionId
//   2) <项目>/团队会话.json          roles[].sessionId
//   3) data/userdata/workbench.json projects[].sessions[role]
//   4) data/userdata/workbench.json projects[].workspace.sessionIds[]
//
// 设计原则：先建后换、四处原子写、失败整体回滚、旧会话归档只读、只告警不自动换。
import fs from 'node:fs';
import path from 'node:path';
import {
  PATHS, TeamError, fail, nowIso, exists, ensureDir, readJson, writeJson, appendEvent,
  jsonOut, textOut, truncate, stamp, listLocks, randomHex, hashFile,
} from './core.mjs';
import {
  loadTeam, mutateTeam, getMember, activeMembers, loadProject, projectStatePaths, listTasks, saveTask,
  projectTeamMode, projectRoleIds, sendMessage,
} from './store.mjs';
import { ROLE_DIRS, ROLE_NAMES, rolesForMode, normalizeTeamMode } from './roles.mjs';
import { statusIsClosed, isRequirementMirrorTask } from './gates.mjs';
import { DshClient } from './dsh-session.mjs';
import { roundsQuery, exportTranscriptToProject, auditOutput, archiveSession, firstTurnUsage, writeBackRotated, listArchives, archiveRotatedSession } from './session-archive.mjs';
import { requireBoot } from './store.mjs';
import { resolveDshBaseUrl, dshUrlMissingHint } from './dsh-url.mjs';
// B-20261118-083150-4b2f（fa0e 补丁 A）：名册写入（四处映射 / 轮换记录 / BQ / 广播 / 事件）收归唯一入口，
// session rotate 与 auto-rotate 都只调它；本文件不再直接写 members[].sessionId。
import { rotateRoster, rotateRosterBatch, checkRotateHandover } from './roster-writer.mjs';

// ─── B-usage-semantics（Owner 2026-11-20 11:2x）：阈值口径＝**本会话累计未缓存输入**，不是单次上下文预算 ───
// 判定值取自 DSH 的 uncachedInputTokens（会话用量.json 的 input 字段）：本会话从开工到现在的**累计**，换人
// （session rotate）归零。它天然随会话寿命线性涨，活过一天的会话就是几百万——所以默认阈值必须按
// 「单会话累计预算」量级定；按 30/50 万（那是「单次上下文预算」的量级）判，pm 累计 455 万就成「超 15.2 倍」。
export const SESSION_CUMULATIVE_WARN_DEFAULT = 5_000_000;   // 累计未缓存输入 500 万 → 预警（建议准备交接/换人）
export const SESSION_CUMULATIVE_FORCE_DEFAULT = 10_000_000; // 累计未缓存输入 1000 万 → 建议换人

// R-2e6b AC18.4：双档水位——warn=预警、force=强制档。
// ⚠ 这两个常量**只是 `usageLevelOf()` 的缺省形参**（纯函数边界刻度：selftest / 0823 夹具按 30/50 万固化
// 「>= 即到档」的边界语义），**不是**生产生效阈值。生产生效阈值唯一来源 = `sessionLimitsOf().of(role)`
// （默认 500 万/1000 万，项目 `项目.json → sessionLimits` 可覆盖）。别拿这两个缺省值去判长会话。
export const DEFAULT_TOKEN_WARN = 300000;
export const DEFAULT_TOKEN_FORCE = 500000;
// R-20261114-001011-703f F-1：会话用量“提醒”阈值（可配），只提醒不强制换人；硬上限由 Owner 另定。
// B-usage-semantics：提醒与判定同口径（累计预算），否则正常长会话会被提醒刷成噪声。
export const DEFAULT_SESSION_TOKEN_LIMIT = SESSION_CUMULATIVE_WARN_DEFAULT;

/**
 * 会话阈值的**唯一来源**（单源）：`session usage` / `session_rotate_warn` / auto-rotate 候选 /
 * 壳层 `session:usage` 面板都必须用这里的结果，禁止第二套阈值。
 *
 * B-usage-semantics（Owner 2026-11-20 11:2x）：默认值＝**单会话累计预算**，六个角色统一
 * `warn 500 万 / force 1000 万`（= SESSION_CUMULATIVE_*）。历史包袱：2026-11-18 08:00 的
 * 「PM 2 倍放宽」（60/100 万）已按 Owner 2026-11-19 口径撤销，不要再加回来。
 *
 * 覆盖机制（**保持不变，优先级最高**）：项目状态 `项目.json` 的 `sessionLimits`
 * （项目状态不进 rulesHash，改它不会让全员令牌失效）：
 *   { "sessionLimits": { "pm": { "warn": 1000000, "force": 2000000 } } }
 */
export const ROLE_SESSION_LIMIT_DEFAULTS = Object.freeze(Object.fromEntries(
  Object.keys(ROLE_NAMES).map((role) => [role, Object.freeze({
    warn: SESSION_CUMULATIVE_WARN_DEFAULT,
    force: SESSION_CUMULATIVE_FORCE_DEFAULT,
  })]),
));
export function sessionLimitsOf(projectName) {
  let cfg = null;
  try { cfg = readJson(projectStatePaths(String(projectName || '')).config); } catch { cfg = null; }
  const per = (cfg && cfg.sessionLimits && typeof cfg.sessionLimits === 'object' && !Array.isArray(cfg.sessionLimits))
    ? cfg.sessionLimits : {};
  const num = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt);
  const builtinRoom = (role) => (ROLE_SESSION_LIMIT_DEFAULTS[String(role || '')] || null);
  const of = (role) => {
    const builtin = builtinRoom(role) || {};
    const row = (per[String(role || '')] && typeof per[String(role || '')] === 'object') ? per[String(role || '')] : {};
    return {
      // 优先级：项目 项目.json → sessionLimits（row）> 内置默认（builtin = 累计预算）> 累计预算常量。
      warn: num(row.warn, num(builtin.warn, SESSION_CUMULATIVE_WARN_DEFAULT)),
      force: num(row.force, num(builtin.force, SESSION_CUMULATIVE_FORCE_DEFAULT)),
    };
  };
  const overrides = { ...ROLE_SESSION_LIMIT_DEFAULTS, ...per };
  return { defaults: { warn: SESSION_CUMULATIVE_WARN_DEFAULT, force: SESSION_CUMULATIVE_FORCE_DEFAULT }, overrides, configOverrides: per, of };
}
const USAGE_FILE_NAME = '会话用量.json';
const USAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const HANDOVER_MAX = 2048;
const ROTATE_DIR = '会话轮换';

// ---------- 通用 ----------

function workbenchPath() {
  if (process.env.TEAM_WORKBENCH_JSON) return path.resolve(process.env.TEAM_WORKBENCH_JSON);
  return path.join(PATHS.workspace, 'data', 'userdata', 'workbench.json');
}

function readWorkbench() {
  try { return readJson(workbenchPath()); } catch { return null; }
}

// B-20261118-083150-4b2f：workbench 的写入口已收归 roster-writer（json-atomic 锁内读改写），
// 这里不再保留 `writeWorkbench`（裸 tmp+rename）——避免有人再拿它写 workbench。

function atomicWriteJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function sessionOfRole(projectName) {
  const project = loadProject(projectName);
  const team = loadTeam();
  const members = {};
  for (const m of team.members) members[m.role] = m.sessionId || '';
  let manifest = {};
  let manifestRaw = null;
  try {
    manifestRaw = readJson(path.join(project.path, '团队会话.json'));
    for (const r of manifestRaw.roles || []) manifest[r.role] = r.sessionId || '';
  } catch { /* 还没建团队会话 */ }
  const wb = readWorkbench();
  const wbProject = wb ? (wb.projects || []).find((p) => p && (p.name === projectName || p.path === project.path)) : null;
  const wbSessions = (wbProject && wbProject.sessions) || {};
  const wbIds = (wbProject && wbProject.workspace && Array.isArray(wbProject.workspace.sessionIds))
    ? wbProject.workspace.sessionIds.map(String) : [];
  return { project, team, members, manifest, manifestRaw, wb, wbProject, wbSessions, wbIds };
}

function rotateDir(projectName) {
  const dir = path.join(projectStatePaths(projectName).dir, ROTATE_DIR);
  ensureDir(dir);
  return dir;
}

function latestRotation(projectName, role) {
  try {
    return readJson(path.join(rotateDir(projectName), `${role}.json`));
  } catch { return null; }
}

/**
 * 自动建会话（B-20261117-212500-a837 的唯一出口｜禁止调用方自造 session id）。
 * · 生产：必须走 `DshClient.create`；DSH 不可达 → ROTATE_MANUAL_REQUIRED（带可复制的手建降级命令），
 *   建会话抛错/无 id → ROTATE_CREATE_FAILED（同样带手建降级命令）。
 * · 沙盘（TEAM_SELFTEST=1）：允许传入 `createSession` 注入工厂（返回 `{ sessionId }`）模拟 DSH create；
 *   未注入时行为与生产一致（不伪造会话）。
 * 返回 `{ sessionId, created:true, mode:'auto', injected }`。
 */
export async function createTeamSession({
  projectName = '', role = '', reason = '', oldId = '', sessionTitle = '',
  createSession = null, list = null, project = null, engineUrl = '',
} = {}) {
  const name = String(projectName || '');
  const command = `node 团队\\工具\\team.mjs session rotate --role ${role} --project "${name}" --session <新会话id> --reason "${reason || '手建降级'}"`;
  const inject = process.env.TEAM_SELFTEST === '1' && typeof createSession === 'function' ? createSession : null;
  if (inject) {
    let res = null;
    try {
      res = await inject({ projectName: name, role, reason });
    } catch (e) {
      fail('ROTATE_CREATE_FAILED', `自动建会话失败（${String((e && e.message) || e)}）：请先手建一个会话，再执行下面命令登记（mode=manual）：${command}`, {
        role, project: name, from: oldId, mode: 'manual', command, why: String((e && e.message) || e),
        step: 'owner-create-session-then-rotate-with-session', injected: true,
      });
    }
    const sid = String((res && (res.sessionId || res.id)) || '');
    if (!sid) {
      fail('ROTATE_CREATE_FAILED', `自动建会话失败（注入工厂未返回会话 id）：请先手建一个会话，再执行下面命令登记（mode=manual）：${command}`, {
        role, project: name, from: oldId, mode: 'manual', command,
        step: 'owner-create-session-then-rotate-with-session', injected: true,
      });
    }
    return { sessionId: sid, created: true, mode: 'auto', injected: true };
  }
  const engine = resolveDshBaseUrl({ override: engineUrl }).baseUrl;
  if (!engine) {
    fail('ROTATE_MANUAL_REQUIRED', `${dshUrlMissingHint()}，无法自动建会话：请手建一个会话后执行下面命令登记（mode=manual）：${command}`, {
      role, project: name, from: oldId, mode: 'manual', command,
      step: 'owner-create-session-then-rotate-with-session', downgradedFrom: 'auto-create',
    });
  }
  const info = list || await listDshSessions(engine);
  if (!info.ok) {
    // AC2b：能自动建会话就建；不能就"手建降级"——不是 500 式失败，而是给出可复制的下一步。
    fail('ROTATE_MANUAL_REQUIRED', `DSH 不可达（${info.why}），无法自动建会话：请手建一个会话后执行下面命令登记（mode=manual）：${command}`, {
      why: info.why, role, project: name, from: oldId, mode: 'manual', command,
      step: 'owner-create-session-then-rotate-with-session', downgradedFrom: 'auto-create',
    });
  }
  const proj = project || loadProject(name);
  const client = new DshClient(engine);
  const body = proj.dshWorkspaceId ? { workspaceId: proj.dshWorkspaceId } : { cwd: proj.path };
  let createdRes = null;
  try {
    createdRes = await client.create(body);
  } catch (e) {
    // R-703f AC2b：自动建会话失败必须降级成“可复制的 handler 指令”，不能把 Owner 卡在报错里。
    fail('ROTATE_CREATE_FAILED', `自动建会话失败（${String((e && e.message) || e)}）：请先手建一个会话，再执行下面命令登记（mode=manual）：${command}`, {
      role, project: name, from: oldId, mode: 'manual', command, why: String((e && e.message) || e),
      step: 'owner-create-session-then-rotate-with-session',
    });
  }
  const sid = String((createdRes && createdRes.sessionId) || '');
  if (!sid) {
    fail('ROTATE_CREATE_FAILED', `自动建会话失败（DSH 未返回会话 id）：请先手建一个会话，再执行下面命令登记（mode=manual）：${command}`, {
      role, project: name, from: oldId, mode: 'manual', command, step: 'owner-create-session-then-rotate-with-session',
    });
  }
  const title = sessionTitle || `团队·${ROLE_NAMES[role] || role}`;
  try { await client.rename({ sessionId: sid, title }); } catch { /* 标题失败不阻断 */ }
  return { sessionId: sid, created: true, mode: 'auto', injected: false, engine };
}

/** 四处映射一致性：每个角色四处取值必须相同；返回 6/6（fast 4/4）判定与不一致字段。 */
export function checkSessionMap(projectName) {
  const name = String(projectName || '');
  if (!name) fail('NO_PROJECT', '需要 --project 或已在项目上下文');
  const project = loadProject(name);
  const roleIds = projectRoleIds(project);
  const map = sessionOfRole(name);
  const wbAvailable = Boolean(map.wbProject && map.wbProject.sessions && typeof map.wbProject.sessions === 'object');
  // 团队.json 是当前项目（activeProject）的全局名册镜像：非活跃项目不参与该校验，避免跨项目串号。
  const teamApplicable = String(map.team.activeProject || '') === name;
  const rows = [];
  for (const role of roleIds) {
    const teamId = String(map.members[role] || '');
    const manifestId = String(map.manifest[role] || '');
    const wbId = String(map.wbSessions[role] || '');
    const inIds = Boolean(wbId && map.wbIds.includes(wbId));
    const fields = [];
    if (teamApplicable && !teamId) fields.push('团队.json 缺 sessionId');
    if (!manifestId) fields.push('团队会话.json 缺 sessionId');
    if (!wbId) fields.push('workbench.json.sessions 缺 sessionId');
    if (!inIds) fields.push('workbench.json.workspace.sessionIds 未含该会话');
    // 标签与取值成对构造再过滤：缺值时不会把下一处错标成上一处（复核 P2-5）。
    const pairs = [];
    if (teamApplicable) pairs.push(['团队.json', teamId]);
    pairs.push(['团队会话.json', manifestId]);
    pairs.push(['workbench.sessions', wbId]);
    const present = pairs.filter((p) => p[1]);
    const ids = present.map((p) => p[1]);
    const consistent = fields.length === 0 && new Set(ids).size === 1;
    if (!consistent && new Set(ids).size > 1) {
      fields.push(`会话 id 不一致：${present.map((p) => `${p[0]}=${p[1]}`).join(' / ')}`);
    }
    rows.push({ role, name: ROLE_NAMES[role] || role, teamId, manifestId, wbId, inSessionIds: inIds, consistent, fields });
  }
  const okCount = rows.filter((r) => r.consistent).length;
  return {
    ok: okCount === rows.length,
    project: name,
    consistent: okCount,
    total: rows.length,
    ratio: `${okCount}/${rows.length}`,
    teamApplicable,
    teamRosterNote: teamApplicable ? '团队.json 参与校验' : '非活跃项目：团队.json 是当前项目镜像，不参与校验',
    workbenchAvailable: wbAvailable,
    workbenchFile: workbenchPath(),
    rows,
  };
}

/** 一致性闸门：不一致即拒绝派单/唤醒（AC17.11）。workbench.json 尚无该项目时降级跳过并标注。 */
export function assertSessionMapConsistent(projectName, purpose = '派单/唤醒') {
  const r = checkSessionMap(projectName);
  if (!r.workbenchAvailable) return { ...r, skipped: true, why: 'workbench.json 尚无该项目条目，跳过四处校验' };
  if (r.ok) return r;
  const bad = r.rows.filter((x) => !x.consistent);
  fail('SESSION_MAP_INCONSISTENT', `${purpose}前四处会话映射不一致（${r.ratio}）：${bad.map((b) => `${b.role}（${b.fields.join('；')}）`).join(' / ')}；以 团队.json + 团队会话.json + workbench.json 一致为准，先跑 session check 再修正`, {
    project: projectName, ratio: r.ratio, inconsistent: bad,
    hint: 'node 团队\\工具\\team.mjs session check --project "<项目>"',
  });
  return r;
}

// ---------- token 用量 ----------

function usageOfSession(info) {
  const tu = info && info.projections && info.projections.values && info.projections.values.tokenUsage;
  if (!tu || typeof tu !== 'object') return null;
  const uncached = Number(tu.uncachedInputTokens || 0);
  const cacheRead = Number(tu.cacheReadTokens || 0);
  const output = Number(tu.outputTokens || 0);
  // input 口径=DSH 的 uncachedInputTokens（未缓存输入，真实进上下文的量）；
  // cacheRead 单列，避免“缓存读累计”把每个会话都推到阈值以上；total=三者之和。
  const input = uncached;
  return { uncachedInputTokens: uncached, cacheReadTokens: cacheRead, outputTokens: output, inputTokens: input, totalTokens: input + cacheRead + output };
}

export function listDshSessions(engineOverride = '') {
  // B-405f 用例注入：沙盘里没有真 DSH，用 TEAM_DSH_FAKE 提供会话列表（只允许 TEAM_SELFTEST=1 时生效）。
  const fake = process.env.TEAM_SELFTEST === '1' ? String(process.env.TEAM_DSH_FAKE || '') : '';
  if (fake) {
    try {
      const rows = JSON.parse(fake);
      const items = (Array.isArray(rows) ? rows : []).map((r) => ({
        sessionId: String(r.sessionId || r.id || ''),
        projections: {
          values: {
            tokenUsage: {
              uncachedInputTokens: Number(r.inputTokens || r.uncachedInputTokens || 0),
              cacheReadTokens: Number(r.cacheReadTokens || 0),
              outputTokens: Number(r.outputTokens || 0),
            },
          },
        },
      }));
      return Promise.resolve({ ok: true, items, fake: true });
    } catch (e) {
      return Promise.resolve({ ok: false, why: `TEAM_DSH_FAKE 解析失败：${e.message}` });
    }
  }
  return new Promise((resolve) => {
    // B-20261117-212500-a837：地址不再只认 env——按 dsh-url.mjs 的统一解析链（env → dsh.json → 当前工作区.json），
    // 这样在 route-daemon 里跑（没有 DSH_WEB_URL）也能连上真实 DSH。
    const engine = resolveDshBaseUrl({ override: engineOverride }).baseUrl;
    if (!engine) { resolve({ ok: false, why: dshUrlMissingHint() }); return; }
    const client = new DshClient(engine);
    client.list().then((r) => resolve({ ok: true, items: r.items || [] })).catch((e) => resolve({ ok: false, why: e.message }));
  });
}

/**
 * token 水位双档（AC18.4）：force= 建议换人，warn= 预警，ok= 正常，unknown= 取不到数值（不按 0）。
 * 边界语义 `>=`：tokens===force 即 force、force−1 判 warn、warn−1 判 ok。
 * B-usage-semantics：入参 `inputTokens` 是**本会话累计未缓存输入**（换人归零），阈值由调用方从
 * `sessionLimitsOf().of(role)` 传入（默认 500 万/1000 万）；此处缺省形参 30/50 万只是纯函数刻度，
 * 生产调用一律显式传阈值（生产判档见 sessionUsage / auto-rotate collectCandidates / 壳层 session:usage）。
 */
export function usageLevelOf(inputTokens, warnThreshold = DEFAULT_TOKEN_WARN, forceThreshold = DEFAULT_TOKEN_FORCE) {
  if (inputTokens === null || inputTokens === undefined || !Number.isFinite(Number(inputTokens))) return 'unknown';
  const n = Number(inputTokens);
  if (n >= Number(forceThreshold)) return 'force';
  if (n >= Number(warnThreshold)) return 'warn';
  return 'ok';
}

// ---------- R-703f F-1：会话用量数据源（只提醒，不自动换人） ----------
//
// 数据源固定为 团队/状态/项目/<项目>/会话用量.json，schema：
//   {"<role>":{"sessionId":"session-…","tokens":300001,"input":280000,"at":"ISO-8601","source":"usage-hook|team.mjs session usage|manual"}}
// 文件缺失或 at 超过 24h → 不提醒并显示“用量未知”，不凭空估算。
export function usageFilePath(projectName) {
  return path.join(projectStatePaths(projectName).dir, USAGE_FILE_NAME);
}

export function readSessionUsageTrack(projectName) {
  const file = usageFilePath(projectName);
  const all = readJson(file, {}) || {};
  return { file, roles: all && typeof all === 'object' && !Array.isArray(all) ? all : {} };
}

export function writeSessionUsageTrack(projectName, role, entry = {}) {
  const file = usageFilePath(projectName);
  const all = readJson(file, {}) || {};
  const key = String(role || '');
  all[key] = { ...(all[key] || {}), ...entry };
  writeJson(file, all);
  return { file, role: key, entry: all[key] };
}

/**
 * 阈值提醒（F-1）：读「会话用量.json」，到提醒阈值的角色收到一条 type=session_rotate_warn 消息，
 * PM 同时收一版。同一角色+同一 token 数值只提醒一次（warnedFor 落盘去重）；只提醒、不自动换、不强制。
 */
export async function checkSessionRotateWarn({ projectName, limit = DEFAULT_SESSION_TOKEN_LIMIT, source = 'check' } = {}) {
  const name = String(projectName || '');
  if (!name) fail('NO_PROJECT', '需要 --project');
  const threshold = Number(limit) > 0 ? Number(limit) : DEFAULT_SESSION_TOKEN_LIMIT;
  // B-usage-semantics：默认阈值＝单会话累计预算（500 万/1000 万），显式 --warn/--threshold 可临时改预警档；
  // 项目 项目.json → sessionLimits 覆盖仍最优先。判定口径与 `session usage`、壳层面板一致（见下方 judged）。
  const limits = sessionLimitsOf(name);
  const track = readSessionUsageTrack(name);
  const team = loadTeam();
  const members = Array.isArray(team.members) ? team.members : [];
  const rows = [];
  let changed = false;
  for (const [role, raw] of Object.entries(track.roles)) {
    if (!ROLE_NAMES[role]) continue;
    const row = raw && typeof raw === 'object' ? raw : {};
    const tokens = Number(row.tokens);
    // B-usage-semantics：判定值＝**本会话累计未缓存输入**（row.input，换人归零），与 `session usage` / 壳层面板
    // 同口径；row.tokens 是累计含缓存读（pm 实测 12.6 亿），拿它比阈值只会在长会话上刷噪声（4104.6 倍那类）。
    const inputTokens = Number(row.input);
    const judged = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : tokens;
    const atMs = Date.parse(String(row.at || ''));
    const member = members.find((m) => m && m.role === role && m.status === 'active');
    const lim = limits.of(role);
    // 优先级：项目 项目.json → sessionLimits 覆盖 > 显式 --warn/--threshold > 单源默认（累计预算 500 万）。
    const warnThreshold = limits.configOverrides[role] ? lim.warn : (Number(limit) > 0 ? Number(limit) : lim.warn);
    const forceThreshold = lim.force;
    const item = {
      role, name: ROLE_NAMES[role] || role,
      tokens: Number.isFinite(tokens) ? tokens : null,
      judged: Number.isFinite(judged) ? judged : null,
      at: row.at || '', source: row.source || '', sessionId: row.sessionId || '',
      warnThreshold, forceThreshold,
      level: usageLevelOf(judged, warnThreshold, forceThreshold),
      warned: false, reason: ''
    };
    if (!Number.isFinite(judged)) { item.reason = '用量未知'; rows.push(item); continue; }
    if (!Number.isFinite(atMs) || Date.now() - atMs > USAGE_MAX_AGE_MS) { item.reason = '用量过期（at 超 24h）'; rows.push(item); continue; }
    if (judged < warnThreshold) { item.reason = '未到提醒阈值'; rows.push(item); continue; }
    if (!member) { item.reason = '角色不在队'; rows.push(item); continue; }
    const dedupe = `${role}:${judged}:${row.sessionId || ''}`;
    if (String(row.warnedFor || '') === dedupe) { item.reason = '同一用量已提醒过'; rows.push(item); continue; }
    const sessionId = String(row.sessionId || member.sessionId || '');
    const subject = `会话用量提醒：${ROLE_NAMES[role] || role} ${judged} ≥ ${warnThreshold}`;
    const body = [
      `${ROLE_NAMES[role] || role} 本会话累计未缓存输入 ${judged} / 预警阈值 ${warnThreshold}（强制阈值 ${forceThreshold}；只提醒，不自动换人）。`,
      `口径：本会话累计、换人归零；累计含缓存读 ${tokens}（仅参考，不参与判定）。`,
      `会话：${sessionId || '未记录'}`,
      `建议：先准备 archive，再 session rotate --role ${role} --reason "上下文到阈值"；硬上限由 Owner 定，未定前不强制。`,
      `数据来源：${USAGE_FILE_NAME}（${row.source || source}，${row.at || '未写时间'}）`,
    ].join('\n');
    const recipients = role === 'pm' ? ['pm'] : ['pm', role];
    for (const to of recipients) {
      try {
        sendMessage({ from: 'system', to, subject, body, project: name, type: 'session_rotate_warn' });
        item.warned = true;
      } catch (e) {
        item.reason = `发送失败：${String((e && e.message) || e)}`;
      }
    }
    if (item.warned) {
      track.roles[role].warnedFor = dedupe;
      changed = true;
      appendEvent({ role: 'system', sessionId: '', action: 'session_rotate_warn', project: name, note: `${role} judged=${judged} tokens=${tokens} limit=${threshold} source=${source}` });
    }
    rows.push(item);
  }
  if (changed) writeJson(track.file, track.roles);
  return { project: name, threshold, warnOnly: true, file: track.file, rows, warned: rows.filter((r) => r.warned).map((r) => r.role) };
}

export async function sessionUsage({
  projectName, role = '',
  warnThreshold = 0, forceThreshold = 0,
}) {
  const name = String(projectName || '');
  if (!name) fail('NO_PROJECT', '需要 --project');
  // B-usage-semantics：判定值＝**本会话累计未缓存输入**（usageOfSession().inputTokens＝uncachedInputTokens，换人归零）。
  // 阈值缺省走单源累计预算（500 万/1000 万，见 sessionLimitsOf）；显式 --warn/--threshold/--force 仍可临时收紧，
  // 项目 项目.json → sessionLimits 覆盖优先级最高。
  const limits = sessionLimitsOf(name);
  const explicitWarn = Number(warnThreshold) > 0 ? Number(warnThreshold) : 0;
  const explicitForce = Number(forceThreshold) > 0 ? Number(forceThreshold) : 0;
  const warn = explicitWarn || limits.defaults.warn;
  const force = explicitForce || limits.defaults.force;
  const project = loadProject(name);
  const roleIds = projectRoleIds(project);
  const map = sessionOfRole(name);
  const list = await listDshSessions();
  const byId = new Map((list.items || []).map((s) => [s.sessionId, s]));
  const rows = [];
  for (const r of roleIds) {
    if (role && r !== role) continue;
    const sessionId = String(map.members[r] || map.manifest[r] || map.wbSessions[r] || '');
    let usage = null;
    let source = 'DSH session/projections';
    if (!sessionId) { source = '无会话映射'; }
    else if (!list.ok) { source = `DSH 不可达（${list.why}）`; }
    else {
      const info = byId.get(sessionId);
      usage = usageOfSession(info);
      if (!usage) source = 'DSH 无 tokenUsage 字段';
    }
    const lim = limits.of(r);
    // 项目覆盖 > 显式传入 > 单源默认（累计预算）。lim 已含项目覆盖后的最终值。
    const rowWarn = limits.configOverrides[r] ? lim.warn : (explicitWarn || lim.warn);
    const rowForce = limits.configOverrides[r] ? lim.force : (explicitForce || lim.force);
    const level = usageLevelOf(usage ? usage.inputTokens : null, rowWarn, rowForce);
    rows.push({
      role: r, name: ROLE_NAMES[r] || r, sessionId,
      inputTokens: usage ? usage.inputTokens : null,
      outputTokens: usage ? usage.outputTokens : null,
      totalTokens: usage ? usage.totalTokens : null,
      uncachedInputTokens: usage ? usage.uncachedInputTokens : null,
      cacheReadTokens: usage ? usage.cacheReadTokens : null,
      warn: level === 'warn' || level === 'force',
      force: level === 'force',
      level, source,
      warnThreshold: rowWarn, forceThreshold: rowForce,
      thresholdSource: limits.configOverrides[r] ? 'project.sessionLimits' : ((explicitWarn || explicitForce) ? 'explicit' : 'builtin:cumulative'),
      thresholds: { warn: rowWarn, force: rowForce },
      note: level === 'force'
        ? `本会话累计未缓存输入 ${usage.inputTokens}（换人归零）≥ 建议换人阈值 ${rowForce}：先 session archive 再 session rotate（未归档 rotate 会被 ARCHIVE_REQUIRED 拒）`
        : level === 'warn'
          ? `本会话累计未缓存输入 ${usage.inputTokens}（换人归零）≥ 预警阈值 ${rowWarn}：建议准备 archive/rotate，避免到 ${rowForce} 被动换人`
          : (usage ? '' : '未知（不按 0）'),
    });
  }
  return {
    project: name, warnThreshold: warn, forceThreshold: force, threshold: force,
    // B-usage-semantics：每角色实际生效阈值（单源 sessionLimitsOf）——人类输出与 --json 都从这里取；
    // defaults＝本次生效的默认档（缺省＝单会话累计预算 500 万/1000 万，显式传入则以传入值为准）。
    thresholds: { defaults: { warn, force }, overrides: limits.overrides },
    dshOk: list.ok, dshWhy: list.ok ? '' : list.why, rows,
  };
}

// ---------- 会话活性与自动拉起（B-20261113-061008-405f） ----------
//
// 背景：rotate 换进来的新会话 usage=0、从未 boot；PM 派单被记 pending，锁不释放 → 全队锁死（06:00 锁在 programmer1）。
// 规则：
//   ① 派单前先探活（usage>0 或 DSH 会话存在）；冷会话先发启动提示并唤醒，拉不起来就明确失败、不占锁；
//   ② pending 锁 5 分钟仍无活性（会话不存在/0 使用）→ 自动释放并记事件；
//   ③ rotate 成功后写「待启动队列」并尝试拉起一次；目标角色 boot 时消费该队列。

const BOOT_QUEUE_FILE = '待启动队列.json';

export function bootQueuePath(projectName) {
  return path.join(projectStatePaths(projectName).dir, BOOT_QUEUE_FILE);
}

function readBootQueue(projectName) {
  try {
    const data = readJson(bootQueuePath(projectName));
    return data && Array.isArray(data.items) ? data : { items: [] };
  } catch {
    return { items: [] };
  }
}

function writeBootQueue(projectName, items) {
  const file = bootQueuePath(projectName);
  ensureDir(path.dirname(file));
  writeJson(file, { items: Array.isArray(items) ? items : [], updatedAt: nowIso() });
}

/**
 * 目标会话活性：active=用过（usage>0）；cold=会话存在但从未使用；missing=DSH 列表里没有；
 * no_session=没有会话映射；unknown=DSH 不可达（不按 0 判死，留痕继续）。
 */
export async function probeRoleSession(projectName, role) {
  const name = String(projectName || '');
  if (!name) fail('NO_PROJECT', '需要 --project');
  const map = sessionOfRole(name);
  const sessionId = String(map.members[role] || map.manifest[role] || map.wbSessions[role] || '');
  const base = { role, sessionId, at: nowIso() };
  if (!sessionId) return { ...base, state: 'no_session', usage: null, source: '无会话映射' };
  const list = await listDshSessions();
  if (!list.ok) return { ...base, state: 'unknown', usage: null, dshOk: false, why: list.why };
  const info = (list.items || []).find((s) => String(s.sessionId) === sessionId);
  if (!info) return { ...base, state: 'missing', usage: null, dshOk: true };
  const usage = usageOfSession(info);
  const total = usage ? Number(usage.totalTokens || 0) : 0;
  return { ...base, state: total > 0 ? 'active' : 'cold', usage, dshOk: true };
}

/** 冷启动提示词：一句话说清“先 boot 再干活”，避免新会话空转、派单没人接。 */
export function buildBootNudgePrompt({ role, project, teamTool }) {
  const roleDir = ROLE_DIRS[role] || role;
  return `【会话启动】你是 ${ROLE_NAMES[role] || role} 的新会话（项目：${project}），还没有 boot。\n`
    + `先执行：node "${teamTool}" boot --role ${role} --project "${project}"，再按启动简报读 inbox/任务。\n`
    + `然后**必须读前任交接**：项目/${project}/${roleDir}/产出/交接-最新.md（存在就必读，读完在回执里说一句「已读交接」；不存在就在回执里写「无前任交接」）。\n`
    + `这是一条系统启动提示，不是新派单；boot 之后照常处理派单。只回一行：已上线 + 会话 id + 是否读到交接。`;
}

/**
 * 直接给目标会话推一条启动提示（不走 30 秒去抖队列，保证“先拉起、再派单”）。
 * 沙盘（TEAM_SELFTEST=1）只返回 skipped，不真发；TEAM_WAKE_TEST_FAIL=1 用于失败注入。
 */
export async function nudgeRoleBoot({ projectName, role, sessionId = '', reason = '', engineUrl = '' }) {
  const name = String(projectName || '');
  loadProject(name); // 项目不存在就按原错误码失败
  let sid = String(sessionId || '');
  if (!sid) {
    const map = sessionOfRole(name);
    sid = String(map.members[role] || map.manifest[role] || map.wbSessions[role] || '');
  }
  if (!sid) return { ok: false, code: 'NO_SESSION', why: `角色 ${role} 没有会话映射`, role, sessionId: '' };
  if (process.env.TEAM_WAKE_TEST_FAIL === '1') {
    return { ok: false, code: 'WAKE_TEST_FAIL', why: 'TEAM_WAKE_TEST_FAIL（测试注入）', role, sessionId: sid };
  }
  if (process.env.TEAM_SELFTEST) return { ok: true, skipped: 'SELFTEST', role, sessionId: sid, reason };
  let engine = String(engineUrl || '') || process.env.DSH_WEB_URL || '';
  if (!engine) {
    try { engine = readJson(path.join(PATHS.state, '当前工作区.json')).engineUrl || ''; } catch { /* none */ }
  }
  if (!engine) return { ok: false, code: 'NO_ENGINE', why: '没有 engineUrl；无法唤醒目标会话', role, sessionId: sid };
  try {
    const client = new DshClient(engine);
    await client.prompt({
      sessionId: sid,
      text: buildBootNudgePrompt({ role, project: name, teamTool: path.join(PATHS.teamRoot, '工具', 'team.mjs') }),
      mode: 'queue',
    });
    return { ok: true, role, sessionId: sid, reason };
  } catch (e) {
    return { ok: false, code: e.code || 'NUDGE_FAILED', why: String((e && e.message) || e), role, sessionId: sid };
  }
}

/**
 * rotate 后登记待启动项并尝试拉起一次（失败只记，不阻断轮换）。
 * 队列按角色唯一，避免连续轮换堆叠多条。
 */
export async function queueBootForRole({ projectName, role, sessionId, reason = 'session_rotate', offline = false }) {
  const name = String(projectName || '');
  const entry = {
    id: `BQ-${stamp()}-${randomHex(2)}`,
    role: String(role || ''),
    sessionId: String(sessionId || ''),
    reason: String(reason || ''),
    state: 'pending',
    at: nowIso(),
  };
  try {
    const queue = readBootQueue(name);
    const items = (queue.items || []).filter((it) => String(it.role) !== String(role));
    items.push(entry);
    writeBootQueue(name, items);
    appendEvent({
      role: 'system', action: 'session_boot_pending', project: name, target: entry.sessionId,
      note: `role=${role} id=${entry.id} reason=${reason}`,
    });
    let wake = null;
    if (!offline) {
      wake = await nudgeRoleBoot({ projectName: name, role, sessionId: entry.sessionId, reason });
      entry.state = wake && wake.ok ? (wake.skipped ? 'queued' : 'woken') : 'wake_failed';
      entry.wake = wake ? { ok: Boolean(wake.ok), skipped: wake.skipped || '', why: wake.why || '' } : null;
      const queue2 = readBootQueue(name);
      writeBootQueue(name, (queue2.items || []).map((it) => (String(it.id) === String(entry.id) ? entry : it)));
    }
    return { queued: true, entry, wake };
  } catch (e) {
    return { queued: false, why: String((e && e.message) || e), entry };
  }
}

/** 目标角色 boot 时消费自己的待启动项（谁被拉起，谁自己销账）。 */
export function consumeBootQueue(projectName, role, sessionId = '') {
  const name = String(projectName || '');
  const queue = readBootQueue(name);
  const items = Array.isArray(queue.items) ? queue.items : [];
  const hit = items.filter((it) => String(it.role) === String(role));
  if (!hit.length) return { consumed: 0, items: [] };
  writeBootQueue(name, items.filter((it) => String(it.role) !== String(role)));
  appendEvent({
    role, sessionId: String(sessionId || ''), action: 'session_boot_consumed', project: name, target: role,
    note: `consumed=${hit.length} ids=${hit.map((it) => it.id).join(',')}`,
  });
  return { consumed: hit.length, items: hit };
}

// ---------- 轮换 ----------

/**
 * 邮件归档的“计划”阶段（只读）：按项目 + 旧会话圈定要归档的消息。
 * 作用域规则（复核 P0-2）：
 *   1) 消息带 project 且不是本项目 → 一律不动（R-c0a6 边界：按项目隔离，不做跨项目会话共享）；
 *   2) 已归档过 → 不动；
 *   3) recipientSessionId 明确指向新会话 → 不动；
 *   4) 带本项目 project 的：recipientSessionId 为空或等于旧会话 → 归档（AC17.6 旧消息可读不可执行）；
 *      指向其他会话 → 跳过并记录（不猜归属）；
 *   5) 无 project 字段的老消息：只有 recipientSessionId === 旧会话 才归档，否则跳过并记录。
 */
function collectMailChanges({ role, oldId, newId, projectName }) {
  const changes = [];
  const skipped = [];
  if (!oldId) return { changes, skipped };
  for (const box of ['new', 'cur']) {
    const dir = path.join(PATHS.mail, role, box);
    if (!exists(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      let msg = null;
      try { msg = readJson(file); } catch { continue; }
      if (!msg || !msg.id) continue;
      if (msg.archivedSession) continue;
      const recv = String(msg.recipientSessionId || '');
      if (recv && recv === newId) continue;
      const msgProject = String(msg.project || '');
      if (msgProject && msgProject !== projectName) {
        skipped.push({ box, id: msg.id, why: `属于项目 ${msgProject}` });
        continue;
      }
      const belongs = msgProject ? (recv === '' || recv === oldId) : (recv === oldId);
      if (!belongs) {
        skipped.push({ box, id: msg.id, why: recv ? `recipientSessionId=${recv}` : '无 project 且 recipientSessionId 为空' });
        continue;
      }
      changes.push({ box, id: msg.id, file, msg });
    }
  }
  return { changes, skipped };
}

/** 执行归档：逐文件写入，中途失败按写入前原文恢复，不留半状态。 */
function applyMailArchive(plan, oldId, newId) {
  const originals = [];
  try {
    for (const c of plan.changes) {
      originals.push({ file: c.file, raw: fs.readFileSync(c.file, 'utf8') });
      const msg = { ...c.msg, archivedSession: oldId, archivedAt: nowIso(), replacedBySessionId: newId };
      atomicWriteJson(c.file, msg);
    }
  } catch (e) {
    for (const o of originals) { try { fs.writeFileSync(o.file, o.raw, 'utf8'); } catch { /* ignore */ } }
    throw e;
  }
  return originals;
}

/** 轮换后清理指向该角色旧派单的派单锁，否则旧派单被归档无法回执、PM 会被锁死（AC17.6）。 */
function clearDispatchLockForRole(projectName, role) {
  const file = path.join(projectStatePaths(projectName).dir, '派单锁.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const lock = JSON.parse(raw);
    if (lock && lock.to === role) {
      fs.rmSync(file, { force: true });
      return { cleared: true, messageId: lock.messageId || '', file, raw };
    }
  } catch { /* 没有锁 */ }
  return { cleared: false, messageId: '' };
}

function stampTasks(projectName, role, oldId, newId) {
  const changed = [];
  const originals = [];
  const taskDir = projectStatePaths(projectName).tasks;
  for (const task of listTasks(projectName)) {
    if (task.status === 'done') continue;
    if (task.owner !== role) continue;
    const file = path.join(taskDir, `${task.id}.json`);
    try { originals.push({ file, raw: fs.readFileSync(file, 'utf8') }); } catch { /* 原文件读不到则回滚时按无原文处理 */ }
    task.ownerSessionId = newId;
    if (!Array.isArray(task.history)) task.history = [];
    task.history.push({ ts: nowIso(), by: 'system', action: 'session_rotate', note: `${oldId || '(无)'} → ${newId}` });
    saveTask(projectName, task);
    changed.push(task.id);
  }
  return { changed, originals };
}

/**
 * R-2e6b PM 决策（2026-11-12）：rotate 前必须 archive（ARCHIVE_REQUIRED 硬门默认开）。
 * 在途例外：角色仍有未闭环任务/活动锁时，archive 必被 TASK_OPEN/ROLE_BUSY 拒绝；
 * 为不违背 AC18.8（在途任务可换人），允许带警告继续，记录 ARCHIVE_DEFERRED 并在接任包标注。
 */
function archiveGate(projectName, role, oldId) {
  const pending = listArchives(projectName)
    .filter((a) => String(a.role || '') === String(role) && !a.nextSessionId)
    .filter((a) => !a.sessionId || String(a.sessionId) === String(oldId || ''));
  const openTasks = (listTasks(projectName) || [])
    // B-da51：与 session-archive 同口径——镜像任务不算「未闭环的活」，终态用 statusIsClosed。
    .filter((t) => String(t.owner || '') === String(role) && !isRequirementMirrorTask(t) && !statusIsClosed(String(t.status || 'done')))
    .map((t) => t.id);
  const locks = (listLocks() || [])
    .filter((l) => String(l.role || '') === String(role) && !l.stale)
    .map((l) => l.key);
  const archive = pending.length ? pending[pending.length - 1] : null;
  return {
    archived: Boolean(archive),
    archive: archive ? { id: archive.id, sessionId: archive.sessionId || null, at: archive.at || null } : null,
    inFlight: openTasks.length > 0 || locks.length > 0,
    tasks: openTasks,
    locks,
  };
}

export async function rotateSession({
  projectName, role, sessionId = '', force = false, offline = false, reason = '', by = 'owner',
  failAt = '', sessionTitle = '', windowMinutes = 30, dryRun = false, createSession = null, engineUrl = '',
  audit = null,
}) {
  const name = String(projectName || '');
  if (!name) fail('NO_PROJECT', '需要 --project');
  const project = loadProject(name);
  const roleIds = projectRoleIds(project);
  if (!roleIds.includes(role)) fail('BAD_ROLE', `角色 ${role} 不在项目 ${name} 的模式内（${roleIds.join('/')}）`);
  const map = sessionOfRole(name);
  // P3-2 复核：团队.json 是「当前项目」的镜像——非活跃项目拿 map.members 当旧会话会写成别的项目的 id。
  // 口径：活跃项目按「名册 → 清单 → workbench」，非活跃项目按「清单 → workbench → 名册兜底」。
  const teamIsActive = String((map.team && map.team.activeProject) || '') === name;
  const oldId = String((teamIsActive ? map.members[role] : '')
    || map.manifest[role] || map.wbSessions[role] || map.members[role] || '');
  // R-2e6b：rotate 前置归档门（默认硬门；在途任务/锁走 ARCHIVE_DEFERRED 例外）。
  const gate = archiveGate(name, role, oldId);
  // 注入失败只用于沙盘自测，生产环境忽略，防止误用造半状态。
  if (failAt && !process.env.TEAM_SELFTEST) failAt = '';
  // B-20261117-212500-a837：地址统一解析（env → dsh.json → 当前工作区.json；也可由调用方传 engineUrl）。
  const engine = resolveDshBaseUrl({ override: engineUrl }).baseUrl;
  const list = await listDshSessions(engine);
  // 双活跃窗口期：最近一次轮换换进来的会话仍是当前映射 → 视为双开风险，拒绝（--force 留痕）。
  // 首次轮换（无记录）不拦：rotate 本来就是替换当前会话。
  const latest = latestRotation(name, role);
  const windowMs = Math.max(1, Number(windowMinutes) || 30) * 60000;
  let recentActive = false;
  if (oldId && latest && latest.to === oldId && latest.at) {
    const age = Date.now() - Date.parse(latest.at);
    if (Number.isFinite(age) && age >= 0 && age < windowMs) recentActive = true;
  }
  if (!list.ok && oldId && latest && latest.to === oldId) recentActive = true;
  if (recentActive && !force) {
    fail('SESSION_ALREADY_ACTIVE', `角色 ${role} 在轮换窗口期（${Math.round(windowMs / 60000)} 分钟内）已有活跃会话 ${oldId}；先确认旧会话已归档，或指定 --session 替代，或 --force 留痕强制轮换`, {
      role, oldSessionId: oldId, project: name, windowMinutes: Math.round(windowMs / 60000),
      hint: 'node 团队\\工具\\team.mjs session rotate --role <角色> --force --reason "原因"',
    });
  }

  // --dry-run：只读预演，打印将写的四处、将归档的邮件、将改的任务与锁，零写入（复核 P1-4）。
  if (dryRun) {
    const target = String(sessionId || '') || '(将新建会话)';
    const mailPlan = collectMailChanges({ role, oldId, newId: String(sessionId || ''), projectName: name });
    const pendingTasks = listTasks(name).filter((t) => t.status !== 'done' && t.owner === role);
    let lockPlan = { cleared: false, messageId: '' };
    try {
      const lock = readJson(path.join(projectStatePaths(name).dir, '派单锁.json'));
      if (lock && lock.to === role) lockPlan = { cleared: true, messageId: lock.messageId || '' };
    } catch { /* 没有锁 */ }
    return {
      dryRun: true, project: name, role, from: oldId, to: target,
      consistencyNow: checkSessionMap(name).ratio,
      wouldWrite: ['团队.json', '团队会话.json', 'workbench.json.projects[].sessions', 'workbench.json.workspace.sessionIds', '会话轮换/<角色>.json（轮换记录）'],
      mailArchive: mailPlan.changes.map((c) => ({ box: c.box, id: c.id })),
      mailSkipped: mailPlan.skipped,
      tasks: pendingTasks.map((t) => t.id),
      dispatchLock: lockPlan,
      archivedOldSession: Boolean(oldId),
      archiveGate: gate,
      reason,
    };
  }

  let archiveDeferred = null;
  if (!gate.archived) {
    // Owner 2026-11-14 01:53 裁决：归档是**建议**不是硬门（ARCHIVE_REQUIRED 不再拦 rotate）。
    // 有在途任务/锁也照常换人：记录里写 archiveDeferred（在途清单），接任包标注「未冻结先闭环」。
    // 硬门回归会被测试判 FAIL，禁止再加回去。
    archiveDeferred = {
      required: true,
      code: 'ARCHIVE_DEFERRED',
      policy: 'advice-not-blocker',
      tasks: gate.tasks,
      locks: gate.locks,
      at: nowIso(),
      note: '归档建议：旧会话未归档也允许轮换；接任包会标「未冻结先闭环」，事后可 session archive 补冻结'
    };
  }
  let newId = String(sessionId || '');
  let created = false;
  const offlineMode = offline || Boolean(process.env.TEAM_SELFTEST);
  if (!newId) {
    // 离线（沙盘）模式：只有注入 createSession 工厂时才允许自动建会话；否则要求 --session（原行为不变）。
    if (offlineMode && typeof createSession !== 'function') fail('BAD_SESSION', '离线轮换必须用 --session 指定一个可用会话 id');
    const info = await createTeamSession({ projectName: name, role, reason, oldId, sessionTitle, createSession, list, project, engineUrl: engine });
    newId = info.sessionId;
    created = true;
  } else {
    // B-20261118-083150-4b2f：格式 / 旧副本形态 / DSH 存在性统一由 roster-writer 的写前校验判定
    //（旧实现在这里自造 SESSION_NOT_FOUND，形成与单写入口两套判据；AC-W2 统一成 SESSION_NOT_IN_DSH，且零写入）。
  }
  if (newId === oldId) fail('SESSION_SAME', `新旧会话相同：${newId}`);

  const at = nowIso();
  let archived = null;
  // 事务外先声明：catch 里要按“写入前原文”恢复邮件/任务/锁；四处映射由 roster-writer 自己回滚（复核 P0-2）。
  let mailOriginals = [];
  let taskResult = { changed: [], originals: [] };
  let dispatchLock = { cleared: false, messageId: '' };
  try {
    const result = await rotateRoster({
      projectName: name, role, newSessionId: newId,
      mode: created ? 'auto' : 'manual', created, reason, by,
      source: 'session-rotate', expectedOldId: oldId,
      offline: offlineMode, dshList: list, engineUrl: engine, failAt, now: at,
      // P3-N9：created 通道要对账——把 createTeamSession 真正返回的 id 交给唯一写入口校验
      createdSessionId: created ? newId : '',
      recordExtra: {
        force: Boolean(force),
        archiveGate: { archived: gate.archived, archiveId: gate.archive ? gate.archive.id : null },
        archiveDeferred,
        // R-20261118-143558-eba2：审计——谁换的（令牌角色）、交接回执与交接文件 sha。
        ...(audit && typeof audit === 'object' ? audit : {}),
      },
      // 其余事务步骤（邮件归档 / 任务会话指向 / 派单锁 / 旧会话归档 / 一致性闸门）在映射写完之后、
      // 记账之前执行；抛错即由 roster-writer 回滚映射，本文件的 catch 再恢复邮件/任务/锁。
      beforeFinalize: async ({ oldId: actualOld, newId: nextId, mapResult }) => {
        const mailPlan = collectMailChanges({ role, oldId: actualOld, newId: nextId, projectName: name });
        mailOriginals = applyMailArchive(mailPlan, actualOld, nextId);
        if (failAt === 'afterMail') fail('ROTATE_INJECTED_FAIL', '注入失败：邮件归档之后');
        taskResult = stampTasks(name, role, actualOld, nextId);
        dispatchLock = clearDispatchLockForRole(name, role);
        // 归档旧会话（只读保留）；失败只记，不回滚映射
        if (actualOld && !offlineMode && list.ok) {
          try {
            const client = new DshClient(engine);
            await client.workspaceArchiveSession({ sessionId: actualOld, stopActivity: true });
            archived = { ok: true, sessionId: actualOld };
          } catch (e) {
            archived = { ok: false, sessionId: actualOld, why: e.message };
          }
        }
        // R-703f F-5 / AC4：一真相三派生——写记录前先算一致性；不满足就按 F-6 回滚并判 ROTATE_MAPPING_MISMATCH，
        // 错误里写明哪一角色/哪一字段不一致（roster-writer 回滚映射、catch 再恢复邮件/任务/锁）。
        const consistencyNow = checkSessionMap(name);
        const fullRatio = `${roleIds.length}/${roleIds.length}`;
        // 判「不一致」而不是「没绑全」：沙盘/新项目其它角色可能本来就没绑定（四路皆空）；
        // 目标角色行必须一致；任何角色只要出现过 id 但相互不同（fields 含「会话 id 不一致」）就算冲突。
        const badRows = (consistencyNow.rows || []).filter((row) => {
          if (!row || row.consistent !== false) return false;
          const fields = Array.isArray(row.fields) ? row.fields : [];
          if (fields.some((text) => String(text).includes('不一致'))) return true;
          const anyBound = Boolean(row.teamId || row.manifestId || row.wbId);
          return row.role === role && anyBound;
        });
        const consistencyEnforceable = consistencyNow.workbenchAvailable === true;
        if (consistencyEnforceable && badRows.length) {
          const detail = badRows.length
            ? badRows.map((row) => `${row.role}:${(row.fields || row.mismatched || []).join('/') || '不一致'}`).join('，')
            : `ratio=${consistencyNow.ratio}（应为 ${fullRatio}），ok=${consistencyNow.ok}`;
          fail('ROTATE_MAPPING_MISMATCH', `轮换后四处映射不一致（${detail}）；本轮不换人（按 F-6 回滚，结果见 details.rollback）`, {
            role, project: name, from: actualOld, to: nextId, consistency: consistencyNow, expectedRatio: fullRatio,
          });
        }
        return {
          recordExtra: {
            archived,
            mailArchived: mailPlan.changes.length,
            mailArchivedIds: mailPlan.changes.map((c) => c.id),
            mailSkipped: mailPlan.skipped.length,
            mailSkippedReasons: mailPlan.skipped.slice(0, 20),
            tasks: taskResult.changed,
            dispatchLock,
            teamRoster: mapResult ? mapResult.teamRoster : 'updated',
            consistency: consistencyNow,
            // 沙盘/未绑定 workbench 项目时不判硬门（可一致性前提不存在），但如实标注。
            consistencyEnforced: consistencyNow.workbenchAvailable === true,
          },
          eventExtra: {
            force: Boolean(force), mailArchived: mailPlan.changes.length, mailSkipped: mailPlan.skipped.length,
            tasks: taskResult.changed, archived, archiveDeferred: Boolean(archiveDeferred),
          },
        };
      },
    });
    // 记录（含 bootPending / broadcastTo / 会话轮换两份文件）由 roster-writer 落盘；对外返回结构保持不变。
    // R-20261118-131107-28b8：换人**成功后**用「被替换下来的旧 sessionId」自动归档——只记结果，失败不回滚换人。
    const archiveOutcome = (() => {
      try {
        return archiveRotatedSession({
          projectName: name,
          role,
          oldSessionId: String((result.record && result.record.from) || result.oldId || oldId || ''),
          newSessionId: String((result.record && result.record.to) || result.newId || newId || ''),
          reason: 'rotate-auto',
          source: 'session-rotate',
          auto: true,
          now: at,
        });
      } catch (e) {
        // 归档链路自身抛错也不许影响已成功的换人：记一行 failed 的等价结构返回给调用方。
        return { ok: false, result: 'failed', reason: String((e && e.code) || 'archive_threw'), error: String((e && e.message) || e), at };
      }
    })();
    if (result.record) {
      result.record.archive = {
        result: archiveOutcome.result,
        at: archiveOutcome.at || at,
        ...(archiveOutcome.archiveId ? { archiveId: archiveOutcome.archiveId } : {}),
        ...(archiveOutcome.reason ? { reason: archiveOutcome.reason } : {}),
        ...(archiveOutcome.attempts !== undefined ? { attempts: archiveOutcome.attempts } : {}),
      };
      result.record.archiveOutcome = archiveOutcome;
    }
    return result.record;
  } catch (e) {
    // 回滚：邮件 + 任务 + 派单锁恢复到轮换前（映射已由 roster-writer 回滚），再归档本次创建的新会话。
    // P1-2 复核：rollback.maps 只能是布尔（旧写法 Boolean(details.rollback) 对对象恒真，会把「部分回滚」报成「已回滚」）。
    const mapRollback = (e && e.details && e.details.rollback) || null;
    const rollback = {
      maps: Boolean(mapRollback && mapRollback.full === true),
      mapsPartial: Boolean(mapRollback && mapRollback.full === false),
      mapsDetail: mapRollback,
      mail: 0, tasks: 0, dispatchLock: false, newSessionArchived: false, errors: [],
    };
    for (const o of mailOriginals) {
      try { fs.writeFileSync(o.file, o.raw, 'utf8'); rollback.mail++; } catch (err) { rollback.errors.push(`邮件恢复失败：${path.basename(o.file)}`); }
    }
    for (const o of taskResult.originals) {
      try { fs.writeFileSync(o.file, o.raw, 'utf8'); rollback.tasks++; } catch (err) { rollback.errors.push(`任务恢复失败：${path.basename(o.file)}`); }
    }
    if (dispatchLock && dispatchLock.cleared && dispatchLock.raw !== undefined) {
      try { fs.writeFileSync(dispatchLock.file, dispatchLock.raw, 'utf8'); rollback.dispatchLock = true; } catch (err) { rollback.errors.push('派单锁恢复失败'); }
    }
    if (created) {
      if (process.env.TEAM_SELFTEST === '1') {
        rollback.newSessionArchiveSkipped = 'SELFTEST（沙盘不联网，无真实 DSH 可调）';
      } else {
        try {
          await new DshClient(engine || undefined).workspaceArchiveSession({ sessionId: newId, stopActivity: true });
          rollback.newSessionArchived = true;
        } catch { rollback.errors.push('新会话归档失败'); }
      }
    }
    appendEvent({
      role: by, sessionId: newId, action: 'rotate_failed', project: name, target: role,
      note: `失败回滚：${e.message}`, data: { from: oldId, to: newId, code: e.code || '', failAt, rollback, legacyAction: 'session_rotate_failed' },
    });
    // N1 复核：TeamError（最现实是 ROTATE_MAPPING_MISMATCH）会在这里原样抛出，
    // 而它的文案里常写「已按 F-6 回滚」——部分回滚时必须先把它改诚实，再抛。
    if (e instanceof TeamError) {
      if (rollback.mapsPartial) {
        const keys = (mapRollback.skipped || []).map((x) => x.key).join('/') || '未知';
        // N1 复核：原文可能还留着「已回滚」类断言（例如映射不一致时在回滚前就 fail），先改诚实再前置前缀。
        const honest = String(e.message || '').replace(/已(?:按 F-6 )?回滚到旧会话[^，；。]*/g, '回滚不完整（见 details.rollback）');
        e.message = `【部分回滚】四处映射未完全恢复（${keys}），请先跑 session check 再继续：${honest}`;
        e.details = { ...(e.details || {}), rollback, partialRollback: true, hint: 'node 团队\\工具\\team.mjs session check --project "<项目>"' };
      } else {
        e.details = { ...(e.details || {}), rollback };
      }
      throw e;
    }
    // 部分回滚不许说「已回滚」：文案按实际结论给，并提示先跑 session check（P1-2/P3-4 复核）
    const tailMsg = rollback.mapsPartial
      ? `轮换失败：四处映射**仅部分回滚**（${(mapRollback.skipped || []).map((x) => x.key).join('/') || '未知'}），请先跑 session check 确认再操作：${e.message}`
      : `轮换失败已回滚到旧会话：${e.message}`;
    fail('ROTATE_FAILED', tailMsg, { from: oldId, to: newId, code: e.code || '', rollback, hint: rollback.mapsPartial ? 'node 团队\\工具\\team.mjs session check --project "<项目>"' : '' });
  }
}

/**
 * R-a1eb §6.4：**批量换人**（一次事务写名册 → N 条 BQ → 一次广播 → N 条记录 → 整批回滚）。
 *
 * 与单角色 rotateSession 的关系：
 *   · 建会话/交接校验/邮件归档/任务会话指向/派单锁/旧会话归档都沿用同一套函数；
 *   · 唯一差别是「写名册 + 广播」合并成一次（走 roster-writer.rotateRosterBatch），
 *     所以其余角色的旧令牌不会失效（rulesHash 已移除名册）。
 *
 * 失败语义：任一角色写失败 → **整批回滚**（映射字段级 CAS + 邮件/任务/锁恢复 + 新建会话归档）。
 */
export async function rotateSessionBatch({
  projectName, roles = [], sessionIds = {}, all = false, force = false, offline = false, reason = '', by = 'owner',
  failAt = '', sessionTitle = '', windowMinutes = 30, dryRun = false, createSession = null, engineUrl = '', audit = null,
}) {
  const name = String(projectName || '');
  if (!name) fail('NO_PROJECT', '需要 --project');
  const project = loadProject(name);
  const roleIds = projectRoleIds(project);
  const team = loadTeam();
  let targets = Array.isArray(roles) ? roles.map((r) => String(r || '').trim()).filter(Boolean) : [];
  if (all) {
    targets = activeMembers(team).map((m) => String(m.role || '')).filter((r) => roleIds.includes(r));
  }
  if (!targets.length) fail('BAD_ARGS', '批量换人需要 --roles a,b,c 或 --all（当前一个角色都没有）', { project: name });
  targets = [...new Set(targets)];
  const badRoles = targets.filter((r) => !roleIds.includes(r));
  if (badRoles.length) {
    fail('BAD_ROLE', `角色不在项目 ${name} 的模式内（${roleIds.join('/')}）：${badRoles.join(',')}`, { roles: badRoles, modeRoles: roleIds });
  }
  const actorRole = String(by || '');
  // §八：批量换人只 PM/Owner；沙盘（TEAM_SELFTEST=1 且未强制）沿用与单角色 rotate 同一豁免口径。
  const sandboxExempt = String(process.env.TEAM_SELFTEST || '') === '1' && String(process.env.TEAM_BOOT_ENFORCE || '') !== '1';
  if (!sandboxExempt) {
    const denied = targets.filter((r) => !rotateAllowed(actorRole, r));
    if (denied.length) {
      fail('PERMISSION_DENIED', `只有 PM/Owner 能批量轮换会话；产品只能给 PM 换人（当前令牌角色 ${actorRole || '-'} → 目标 ${denied.join(',')}）`, {
        roles: denied, project: name, tokenRole: actorRole,
      });
    }
  }
  const mapNow = sessionOfRole(name);
  const teamIsActive = String((mapNow.team && mapNow.team.activeProject) || '') === name;
  const oldIds = {};
  for (const r of targets) {
    oldIds[r] = String((teamIsActive ? mapNow.members[r] : '') || mapNow.manifest[r] || mapNow.wbSessions[r] || mapNow.members[r] || '');
  }
  // 幂等（§6.4）：名册已是目标会话的角色 → already_rotated 跳过；全部跳过 → BATCH_NOOP。
  const alreadyRotated = [];
  const pending = [];
  for (const r of targets) {
    const want = String((sessionIds || {})[r] || '');
    if (want && oldIds[r] && want === oldIds[r]) alreadyRotated.push(r);
    else pending.push(r);
  }
  if (!pending.length) {
    fail('BATCH_NOOP', `批量换人无改动：${alreadyRotated.join(',')} 名册已是这些会话（零写入）`, { roles: alreadyRotated, project: name });
  }
  // ① 交接回执整批校验（缺一份 → 列全缺项、零写入）。沙盘默认豁免，门禁本体用 TEAM_HANDOVER_ENFORCE=1。
  const bootSandbox = String(process.env.TEAM_SELFTEST || '') === '1';
  const handoverEnforce = String(process.env.TEAM_HANDOVER_ENFORCE || '') === '1';
  let handoverAudit = { actorRole, batch: true };
  const receiptMissing = [];
  if (!bootSandbox || handoverEnforce) {
    for (const r of pending) {
      const rc = checkHandoverReceipt(name, r);
      if (!rc.ok) receiptMissing.push({ role: r, reason: rc.reason });
    }
    if (receiptMissing.length) {
      fail('HANDOVER_MISSING', `批量换人前必须为每个角色落交接回执（缺 ${receiptMissing.length} 份）；先 session handover receipt --role <角色>`, {
        project: name, missing: receiptMissing, roles: pending,
      });
    }
    handoverAudit = { actorRole, batch: true, receipts: pending.map((r) => { const rc = checkHandoverReceipt(name, r); return { role: r, receiptId: rc.receipt ? rc.receipt.id : '', sha256: rc.sha256 }; }) };
  }
  // ② 接任包整批校验（4 个必填【】小节）：任一缺失 → 一次列全
  const handoverBad = [];
  for (const r of pending) {
    try {
      const v = await checkRotateHandover({ projectName: name, role: r, sessionId: String((sessionIds || {})[r] || '') });
      if (v.code === 'HANDOVER_INCOMPLETE' || (v.code === '' && !v.ok)) {
        handoverBad.push({ role: r, missing: (v.missingRequired || []).concat(v.emptyRequired || []), redFlags: v.redFlags || [] });
      }
    } catch { /* 其它失败不阻 rotate（与单角色同口径） */ }
  }
  if (handoverBad.length) {
    fail('HANDOVER_INCOMPLETE', `批量换人：接任包缺必填小节（${handoverBad.map((x) => `${x.role}:${x.missing.join('/')}`).join('；')}）`, { project: name, bad: handoverBad });
  }
  // ③ 注入失败只在沙盘生效（防误用造半状态）
  const effectiveFailAt = (failAt && process.env.TEAM_SELFTEST) ? failAt : '';
  const engine = resolveDshBaseUrl({ override: engineUrl }).baseUrl;
  const offlineMode = offline || Boolean(process.env.TEAM_SELFTEST);
  const list = await listDshSessions(engine);
  // ④ 预算新会话（指定的 or 自动建）
  const planned = [];
  const createdIds = {};
  for (const r of pending) {
    let newId = String((sessionIds || {})[r] || '');
    let created = false;
    if (!newId) {
      if (offlineMode && typeof createSession !== 'function') {
        fail('BAD_SESSION', '离线批量轮换必须用 --sessions "role=id,…" 指定可用会话 id', { roles: pending, project: name });
      }
      const info = await createTeamSession({
        projectName: name, role: r, reason, oldId: oldIds[r], sessionTitle: sessionTitle || `团队·${ROLE_NAMES[r] || r}`,
        createSession, list, project, engineUrl: engine,
      });
      newId = info.sessionId;
      created = true;
      createdIds[r] = newId;
    }
    planned.push({ role: r, newSessionId: newId, oldId: oldIds[r], created });
  }
  const entries = planned.map((p) => ({ role: p.role, from: p.oldId, to: p.newSessionId, newSessionId: p.newSessionId, oldId: p.oldId, created: p.created }));
  if (dryRun) {
    return {
      batch: true, dryRun: true, project: name, roles: pending,
      entries, alreadyRotated,
      consistencyNow: checkSessionMap(name).ratio,
      wouldWrite: ['团队.json（一次事务写 N 个 sessionId）', '团队会话.json', 'workbench.projects[].sessions', 'workbench.workspace.sessionIds', '会话轮换/<角色>.json × N', '名册变更.jsonl（N 行 + 1 行 batch 汇总）'],
      broadcast: 1, bootPending: pending.length,
      reason,
    };
  }
  // ⑤ 事务：一次写名册 → 每角色事务步骤 → 收尾（N 条 BQ + 1 次广播）
  const rollbackState = { mails: [], tasks: [], locks: [] };
  let archivedOutcomes = [];
  try {
    const result = await rotateRosterBatch({
      projectName: name,
      entries: planned.map((p) => ({ role: p.role, newSessionId: p.newSessionId, oldId: p.oldId })),
      mode: planned.some((p) => p.created) ? 'auto' : 'manual',
      created: planned.every((p) => p.created),
      reason, by: actorRole, source: 'session-rotate',
      offline: offlineMode, dshList: list, engineUrl: engine,
      createdIds,
      failAt: effectiveFailAt, now: nowIso(),
      recordExtra: {
        force: Boolean(force),
        batch: true,
        ...(audit && typeof audit === 'object' ? audit : {}),
      },
      beforeFinalize: async ({ entries: finalEntries }) => {
        const details = [];
        for (const e of finalEntries) {
          const mailPlan = collectMailChanges({ role: e.role, oldId: e.from, newId: e.to, projectName: name });
          const originals = applyMailArchive(mailPlan, e.from, e.to);
          rollbackState.mails.push(...originals);
          if (effectiveFailAt === 'afterMail') fail('ROTATE_INJECTED_FAIL', '注入失败：邮件归档之后');
          const t = stampTasks(name, e.role, e.from, e.to);
          rollbackState.tasks.push(...(t.originals || []));
          const lock = clearDispatchLockForRole(name, e.role);
          if (lock && lock.cleared) rollbackState.locks.push(lock);
          // 归档旧会话（只读保留）；失败只记，不回滚映射
          let archived = null;
          if (e.from && !offlineMode && list.ok) {
            try {
              const client = new DshClient(engine);
              await client.workspaceArchiveSession({ sessionId: e.from, stopActivity: true });
              archived = { ok: true, sessionId: e.from };
            } catch (err) {
              archived = { ok: false, sessionId: e.from, why: err.message };
            }
          }
          details.push({
            role: e.role, from: e.from, to: e.to, archived,
            mailArchived: mailPlan.changes.length, mailArchivedIds: mailPlan.changes.map((c) => c.id),
            mailSkipped: mailPlan.skipped.length, tasks: t.changed, dispatchLock: lock,
          });
        }
        // 一致性闸门：批量换完，所有被换角色的四处映射必须一致（workbench 可用时硬判）
        const consistencyNow = checkSessionMap(name);
        const badRows = (consistencyNow.rows || []).filter((row) => {
          if (!row || row.consistent !== false) return false;
          const fields = Array.isArray(row.fields) ? row.fields : [];
          if (fields.some((text) => String(text).includes('不一致'))) return true;
          const anyBound = Boolean(row.teamId || row.manifestId || row.wbId);
          return pending.includes(row.role) && anyBound;
        });
        if (consistencyNow.workbenchAvailable === true && badRows.length) {
          fail('ROTATE_MAPPING_MISMATCH', `批量换人后四处映射不一致（${badRows.map((r) => `${r.role}:${(r.fields || []).join('/')}`).join('，')}）；整批回滚`, {
            project: name, roles: pending, consistency: consistencyNow,
          });
        }
        return {
          recordExtra: {
            batchDetails: details,
            consistency: consistencyNow,
            consistencyEnforced: consistencyNow.workbenchAvailable === true,
            teamRoster: 'updated',
          },
          eventExtra: { batch: true, roles: pending, mailArchived: details.reduce((n, d) => n + d.mailArchived, 0) },
        };
      },
    });
    // 成功后的旧会话自动归档（只记结果，失败不回滚换人）
    for (const e of entries) {
      try {
        const outcome = archiveRotatedSession({
          projectName: name, role: e.role, oldSessionId: e.from || '', newSessionId: e.to || '',
          reason: 'rotate-auto-batch', source: 'session-rotate', auto: true, now: nowIso(),
        });
        archivedOutcomes.push({ role: e.role, ...outcome });
      } catch (err) {
        archivedOutcomes.push({ role: e.role, ok: false, result: 'failed', reason: String((err && err.code) || 'archive_threw') });
      }
    }
    return {
      ...result,
      batch: true,
      alreadyRotated,
      archivedOutcomes,
      consistency: checkSessionMap(name),
    };
  } catch (e) {
    // 回滚：邮件/任务/派单锁恢复到换人前（映射由 roster-writer 整批回滚）
    const mapRollback = (e && e.details && e.details.rollback) || null;
    const rollback = {
      maps: Boolean(mapRollback && mapRollback.full === true),
      mapsPartial: Boolean(mapRollback && mapRollback.full === false),
      mapsDetail: mapRollback,
      mail: 0, tasks: 0, dispatchLock: 0, newSessionsArchived: 0, errors: [],
    };
    for (const o of rollbackState.mails) {
      try { fs.writeFileSync(o.file, o.raw, 'utf8'); rollback.mail += 1; } catch { rollback.errors.push(`邮件恢复失败：${path.basename(o.file)}`); }
    }
    for (const o of rollbackState.tasks) {
      try { fs.writeFileSync(o.file, o.raw, 'utf8'); rollback.tasks += 1; } catch { rollback.errors.push(`任务恢复失败：${path.basename(o.file)}`); }
    }
    for (const l of rollbackState.locks) {
      try { if (l.raw !== undefined) { fs.writeFileSync(l.file, l.raw, 'utf8'); rollback.dispatchLock += 1; } } catch { rollback.errors.push('派单锁恢复失败'); }
    }
    for (const p of planned.filter((x) => x.created)) {
      if (process.env.TEAM_SELFTEST === '1') { rollback.newSessionArchiveSkipped = 'SELFTEST'; break; }
      try {
        await new DshClient(engine || undefined).workspaceArchiveSession({ sessionId: p.newSessionId, stopActivity: true });
        rollback.newSessionsArchived += 1;
      } catch { rollback.errors.push(`新会话归档失败：${p.role}`); }
    }
    try {
      appendEvent({
        role: actorRole, sessionId: planned.map((p) => p.newSessionId).join(','), action: 'rotate_batch_failed', project: name,
        target: pending.join(','),
        note: `批量换人失败回滚：${e.message}`,
        data: { roles: pending, code: e.code || '', failAt: effectiveFailAt, rollback },
      });
    } catch { /* 事件失败不掩盖错误 */ }
    if (e instanceof TeamError) {
      if (rollback.mapsPartial) {
        const keys = (mapRollback.skipped || []).map((x) => x.key).join('/') || '未知';
        const honest = String(e.message || '').replace(/已(?:按 F-6 )?回滚到旧会话[^，；。]*/g, '回滚不完整（见 details.rollback）');
        e.message = `【部分回滚】批量换人四处映射未完全恢复（${keys}），请先跑 session check 再继续：${honest}`;
      }
      e.details = { ...(e.details || {}), rollback };
      throw e;
    }
    fail('ROTATE_FAILED', `批量换人失败${rollback.mapsPartial ? '（映射仅部分回滚，请先 session check）' : '已整批回滚'}：${e.message}`, {
      roles: pending, code: e.code || '', rollback,
    });
  }
}


function recentDecisions(projectName) {
  const stateDir = projectStatePaths(projectName).dir;
  const rows = [];
  try {
    const wf = readJson(path.join(stateDir, '工作流.json'));
    const decisions = (wf && wf.ownerReview && Array.isArray(wf.ownerReview.decisions)) ? wf.ownerReview.decisions : [];
    for (const d of decisions.slice(-3)) {
      rows.push({ at: d.at || '', channel: d.channel || '', opinion: truncate(String(d.opinion || ''), 80), source: '工作流.json.ownerReview.decisions' });
    }
  } catch { /* 没有工作流 */ }
  if (!rows.length) {
    try {
      const log = path.join(loadProject(projectName).path, '项目经理', '决策日志.md');
      const lines = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).slice(-3);
      for (const line of lines) rows.push({ at: '', channel: '', opinion: truncate(line.trim(), 80), source: '项目经理/决策日志.md' });
    } catch { /* 没有决策日志 */ }
  }
  return rows;
}

export function buildHandover({ projectName, role, sessionId = '' }) {
  const name = String(projectName || '');
  if (!name) fail('NO_PROJECT', '需要 --project');
  const project = loadProject(name);
  const mode = normalizeTeamMode(projectTeamMode(project));
  const tasks = listTasks(name).filter((t) => t.status !== 'done' && (!t.owner || t.owner === role));
  const locks = (() => { try { return requireLocks().filter((l) => l.role === role); } catch { return []; } })();
  const decisions = recentDecisions(name);
  const roleDir = ROLE_DIRS[role] || role;
  const mustRead = ['项目铁律.md', '项目信息.md', '项目索引.md', `${roleDir}/角色卡.md`, `${roleDir}/文件索引.md`];
  const rot = latestRotation(name, role);
  const lines = [];
  lines.push(`=== 接任包 · ${ROLE_NAMES[role] || role} · ${name} ===`);
  // B-3f02（设计口径 v1）：6 小节按标题机械检查——在途任务/未闭环事项/最近决策/建议下一步 缺失即拒 rotate；
  // 遗留问题与坑缺失只标红（文末须写「无已知坑」）；总长 ≤2KB。
  const handoffReason = {
    kind: rot ? 'rotate' : 'manual',
    by: rot ? String(rot.startedBy || rot.by || 'owner') : 'owner',
    at: rot ? String(rot.at || '') : nowIso(),
    note: truncate(rot ? String(rot.reason || '常规轮换') : '手工初始化（无轮换记录）', 60),
  };
  const proxyActive = (() => {
    try {
      const file = path.join(projectStatePaths(name).dir, '评审代管.json');
      const records = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).records || [];
      return records.filter((r) => !r.endedAt && (!r.expiresAt || Date.parse(r.expiresAt) > Date.now()));
    } catch { return []; }
  })();
  const proxyText = proxyActive.length
    ? `active（${proxyActive.length} 条：${proxyActive.slice(0, 2).map((r) => `${r.requirementId}/${r.scope}`).join('、')}）`
    : '未开启';
  const whyOf = (t) => {
    const st = String(t.requirementStatus || '');
    if (['test_done', 'dev_done'].includes(st) && !(t.requirementDecisions || []).length) return { why: 'owner_gate', blockedBy: 'Owner 决定', score: 0, dueMs: Infinity, prio: 0 };
    if (String(t.status || '') === 'working') return { why: 'chain_block', blockedBy: '等回执/等测试', score: 1, dueMs: Infinity, prio: 2 };
    const dueMs = Date.parse(String(t.due || ''));
    const prio = ({ P0: 0, P1: 1, P2: 2, P3: 3 })[String(t.priority || 'P2')] ?? 2;
    if (Number.isFinite(dueMs)) return { why: 'due', blockedBy: '', score: 2, dueMs, prio };
    return { why: 'priority', blockedBy: '', score: 3, dueMs: Infinity, prio };
  };
  const ordered = [...tasks].sort((a, b) => {
    const ra = whyOf(a); const rb = whyOf(b);
    return ra.score - rb.score || ra.dueMs - rb.dueMs || ra.prio - rb.prio || String(a.id).localeCompare(String(b.id));
  });
  const top1 = ordered[0];
  lines.push(`=== 接任包 · ${ROLE_NAMES[role] || role} · ${name} ===`);
  lines.push(`【20秒摘要】你是${ROLE_NAMES[role] || role}（${name}，${mode}）；最急：${top1 ? `${top1.id} ${truncate(top1.title, 20)}（${whyOf(top1).why}）` : '无在办任务'}；第一句话：先 boot 再读交接包，别立刻派单。`);
  lines.push(`【你是谁】${ROLE_NAMES[role] || role} ｜ 项目 ${name}（${mode}）｜ 代管：${proxyText} ｜ 换人原因：${handoffReason.kind}/${handoffReason.by}/${handoffReason.at}（${handoffReason.note}）`);
  const pending = ordered.slice(0, 5);
  lines.push(`【在途任务】${pending.length ? pending.map((t) => { const r = whyOf(t); return `${t.id} ${t.status}${t.owner ? '/' + t.owner : ''} ${truncate(t.title, 18)}（why=${r.why}${r.blockedBy ? '，blockedBy=' + r.blockedBy : ''}）`; }).join('；') : '无'}${tasks.length > 5 ? `（另有 ${tasks.length - 5} 条见工作流）` : ''}`);
  lines.push(`【未闭环事项】锁：${locks.length ? locks.map((l) => l.key).join('、') : '无'}`);
  lines.push(`【最近决策】${decisions.length ? decisions.slice(0, 3).map((d) => `[${d.at || '-'}/${d.channel || '-'}] ${truncate(d.opinion, 22)}`).join('；') : '无'}`);
  const nextSteps = pending.filter((t) => t.owner === role || !t.owner).slice(0, 3);
  lines.push(`【建议下一步】${nextSteps.length ? nextSteps.map((t) => `${t.id} ${truncate(t.title, 22)}`).join('；') : '按项目索引挑下一件，或等 PM 派单'}`);
  if (rot && rot.archiveDeferred) {
    const d = rot.archiveDeferred;
    lines.push(`【遗留问题与坑】ARCHIVE_DEFERRED：旧会话未冻结（在途任务 ${(d.tasks || []).length} 个${(d.locks || []).length ? `、锁 ${d.locks.length} 个` : ''}）；先闭环再归档。`);
  } else {
    lines.push('【遗留问题与坑】无已知坑');
  }
  const hashed = mustRead.map((rel) => {
    try {
      const abs = path.join(project.path, rel);
      const h = hashFile(abs).slice(0, 12);
      return `${rel}#${h}`;
    } catch { return rel; }
  });
  lines.push(`【必读】${hashed.join('、')}`);
  lines.push('【纪律】第一件事先 boot 再读交接包，别立刻派单；ack=已回执 ≠ 已完成；完成要完成回执 + task done --evidence。');
  let text = lines.join('\n');
  if (Buffer.byteLength(text, 'utf8') > HANDOVER_MAX) {
    text = text.slice(0, HANDOVER_MAX - 30).replace(/\n[^\n]*$/, '') + '\n…（接任包超 2KB，已截断）';
  }
  return { text, bytes: Buffer.byteLength(text, 'utf8'), tasks: tasks.map((t) => t.id), locks: locks.map((l) => l.key), decisions: decisions.length, handoffReason, proxyActive: proxyActive.length, from: rot ? rot.from : '', to: rot ? rot.to : '' };
}

function requireLocks() {
  // 延迟 import 避免与 core 的循环依赖问题：锁列表只读。
  try {
    const raw = fs.readdirSync(PATHS.locks);
    const out = [];
    for (const name of raw) {
      if (!name.endsWith('.json')) continue;
      try {
        const l = readJson(path.join(PATHS.locks, name));
        const stale = l.expiresAt && Date.parse(l.expiresAt) < Date.now();
        if (!stale) out.push(l);
      } catch { /* skip */ }
    }
    return out;
  } catch { return []; }
}

/** boot 时若当前会话正是最近轮换进来的新会话，返回接任包（否则 null）。 */
export function handoverForBoot(projectName, role, sessionId) {
  const rot = latestRotation(projectName, role);
  if (!rot || !sessionId || rot.to !== sessionId) return null;
  return buildHandover({ projectName, role, sessionId });
}

const HANDOVER_REQUIRED = ['在途任务', '未闭环事项', '最近决策', '建议下一步'];

/** B-3f02：接任包机械检查——4 必填小节缺失即拒 rotate；遗留问题与坑缺失只标红。 */
export function validateHandover(text) {
  const t = String(text || '');
  const missingRequired = HANDOVER_REQUIRED.filter((k) => !new RegExp('【' + k + '】').test(t));
  const emptyRequired = HANDOVER_REQUIRED.filter((k) => {
    const m = t.match(new RegExp('【' + k + '】([^\\n]*)'));
    return !m || !String(m[1] || '').trim();
  });
  const redFlags = [];
  if (!/【遗留问题与坑】/.test(t)) redFlags.push('缺少【遗留问题与坑】小节');
  if (!/无已知坑/.test(t)) redFlags.push('未写「无已知坑」');
  return { ok: missingRequired.length === 0 && emptyRequired.length === 0, missingRequired, emptyRequired, redFlags };
}

// R-20261118-143558-eba2：交接回执（append-only）——换人前必须证明「回执针对的就是当前这份交接文件」。
// 设计：本人写 交接-最新.md → session handover receipt --role <自己> 落回执（bytes+sha256）→ rotate 前校验 sha==磁盘。
const HANDOVER_RECEIPT_FILE = '交接回执.jsonl';

/** 角色交接文件路径：<项目>/<角色目录>/产出/交接-最新.md（与 PM 交接模板同路径）。 */
export function handoverDocPath(projectName, role) {
  const project = loadProject(String(projectName || ''));
  const dir = ROLE_DIRS[String(role || '')] || String(role || '');
  return path.join(project.path, dir, '产出', '交接-最新.md');
}

/** 交接回执账本：团队/状态/项目/<项目>/交接回执.jsonl（append-only）。 */
export function handoverReceiptFile(projectName) {
  return path.join(projectStatePaths(String(projectName || '')).dir, HANDOVER_RECEIPT_FILE);
}

/** 读交接文件信息（不存在/空 → ok:false，供回执与 rotate 共用）。 */
export function readHandoverDoc(projectName, role) {
  const project = loadProject(String(projectName || ''));
  const file = handoverDocPath(projectName, role);
  if (!exists(file)) return { ok: false, code: 'HANDOVER_FILE_MISSING', file };
  const bytes = fs.statSync(file).size;
  if (!bytes) return { ok: false, code: 'HANDOVER_FILE_EMPTY', file };
  return {
    ok: true, file, bytes,
    rel: path.relative(project.path, file).replace(/\\/g, '/'),
    sha256: hashFile(file),
    mtime: fs.statSync(file).mtime.toISOString(),
  };
}

/** 读全部回执行（坏行跳过，不中断）。 */
export function listHandoverReceipts(projectName) {
  const file = handoverReceiptFile(projectName);
  if (!exists(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (row && row.role && row.sha256) rows.push(row);
    } catch { /* 坏行跳过 */ }
  }
  return rows;
}

/** 某角色最新一条回执（append-only 的最后一行）。 */
export function latestHandoverReceipt(projectName, role) {
  const rows = listHandoverReceipts(projectName).filter((r) => String(r.role) === String(role));
  return rows.length ? rows[rows.length - 1] : null;
}

/** 落一条交接回执：计算磁盘 bytes+sha256 并 append（by 取令牌角色，不取调用方自报）。 */
export function recordHandoverReceipt(projectName, role, { by = '', messageId = '' } = {}) {
  const doc = readHandoverDoc(projectName, role);
  if (!doc.ok) {
    fail(doc.code, doc.code === 'HANDOVER_FILE_MISSING' ? `交接文件不存在：${doc.file}` : `交接文件为空：${doc.file}`, { role, file: doc.file });
  }
  const at = nowIso();
  const row = {
    id: `H-${stamp()}-${role}`, at, role,
    path: doc.rel, bytes: doc.bytes, sha256: doc.sha256,
    by: String(by || ''), messageId: String(messageId || ''),
  };
  ensureDir(path.dirname(handoverReceiptFile(projectName)));
  fs.appendFileSync(handoverReceiptFile(projectName), JSON.stringify(row) + '\n', 'utf8');
  return { ok: true, receipt: row, file: handoverReceiptFile(projectName) };
}

/** rotate 前置校验：最新回执存在且 sha/bytes 与磁盘一致（只读，失败零副作用）。 */
export function checkHandoverReceipt(projectName, role) {
  const latest = latestHandoverReceipt(projectName, role);
  if (!latest) return { ok: false, code: 'HANDOVER_RECEIPT_REQUIRED', reason: 'no_receipt' };
  const doc = readHandoverDoc(projectName, role);
  if (!doc.ok) return { ok: false, code: 'HANDOVER_RECEIPT_REQUIRED', reason: 'file_missing', receipt: latest, file: doc.file };
  if (String(latest.sha256) !== String(doc.sha256) || Number(latest.bytes) !== Number(doc.bytes)) {
    return {
      ok: false, code: 'HANDOVER_RECEIPT_REQUIRED', reason: 'sha_mismatch',
      receipt: latest, file: doc.rel, expected: doc.sha256, got: latest.sha256, expectedBytes: doc.bytes, gotBytes: latest.bytes,
    };
  }
  return { ok: true, receipt: latest, file: doc.rel, sha256: doc.sha256, bytes: doc.bytes };
}

/**
 * R-20261118-143558-eba2：rotate 权限（A 案）。
 * owner：任意角色；pm：除 pm 自己（PM 自换由产品执行）；product：仅 pm；其余拒绝。
 */
export function rotateAllowed(tokenRole, targetRole) {
  const t = String(tokenRole || '');
  const target = String(targetRole || '');
  if (t === 'owner') return true;
  if (t === 'pm') return target !== 'pm';
  if (t === 'product') return target === 'pm';
  return false;
}
/**
 * B-20261119-204845-8d91：PM 换人的「双方闲时」判定（唯一实现）。
 *
 * 四项均需满足才算闲：①近 minutes 分钟内无新消息（邮箱 new+cur 的 ts/at 最大值）；
 * ②无 running 会话（团队/状态/会话排队.json 里该角色 running/thinking 为真）；
 * ③名下无 working 任务；④无在途派单锁（非过期）。
 * 返回 { ok, minutes, configValue, roles: { <role>: { idle, reasons[], lastActivityAt, remainingMin } } }。
 * remainingMin = 距离「最近一次活动 + minutes」还差多少分钟（0 表示已闲够）。
 */
export function pmRotateIdleState(projectName, { minutes = null, roles = ['pm', 'product'], now = Date.now() } = {}) {
  const team = (() => { try { return loadTeam(); } catch { return {}; } })();
  const cfgRaw = team && team.config ? team.config.pmRotateIdleMin : null;
  const cfgMin = Number(cfgRaw);
  const mins = Number.isFinite(minutes) && minutes > 0 ? Number(minutes) : (Number.isFinite(cfgMin) && cfgMin > 0 ? cfgMin : 15);
  const windowMs = mins * 60 * 1000;
  const tasks = (() => { try { return listTasks(projectName) || []; } catch { return []; } })();
  const locks = (() => { try { return requireLocks() || []; } catch { return []; } })();
  const queue = (() => { try { return readJson(path.join(PATHS.state, '会话排队.json'), {}) || {}; } catch { return {}; } })();
  const out = {};
  for (const role of roles) {
    const reasons = [];
    let lastMs = 0;
    // ① 本角色**发出**的消息（扫全队邮箱，只看 from===role；收到的一律不算活跃）
    // B-20261120-121345-f25d（PM 2026-11-20 12:13 实测）：旧口径把「收到的消息」也算活跃——PM 收到
    // 别人的 ack/回执就重置 15 分钟倒计时，而 ack 只是「收到」不是 PM 在干活；叠加 from=system 噪声
    // （B-6c35）后 pm 结构上几乎换不掉。口径定为：**只有本人发出的消息算活跃**；
    // running 会话 / working 任务 / 在途派单锁三条硬判据不变。
    const tsOfMailName = (name) => {
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(String(name || ''));
      return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN;
    };
    const lookbackMs = windowMs + 10 * 60 * 1000;   // 文件名预筛：窗口 + 10 分钟缓冲，其余历史不解析
    let boxOwners = [];
    try { boxOwners = fs.readdirSync(PATHS.mail, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { boxOwners = []; }
    for (const boxOwner of boxOwners) {
      for (const box of ['new', 'cur']) {
        const dir = path.join(PATHS.mail, boxOwner, box);
        let names = [];
        try { names = fs.readdirSync(dir); } catch { names = []; }
        for (const n of names) {
          if (!n.endsWith('.json')) continue;
          const nameMs = tsOfMailName(n);
          if (Number.isFinite(nameMs) && now - nameMs > lookbackMs) continue;   // 历史消息按文件名预筛掉
          let row = null; try { row = readJson(path.join(dir, n), null); } catch { row = null; } // 破损文件不许让门崩（降级）
          if (!row) continue;
          if (String(row.from || '') !== String(role)) continue;   // 只认本人发出；收到的与他人消息都不算
          const ms = Date.parse(String(row.ts || row.at || row.deliveredAt || ''));
          if (Number.isFinite(ms) && ms > lastMs) lastMs = ms;
        }
      }
    }
    if (lastMs && now - lastMs < windowMs) reasons.push(`近 ${mins} 分钟本人发出过消息（最近 ${new Date(lastMs).toISOString()}；收到的消息与系统自动通知不计）`);
    // ② running 会话（B-20261120-123332-f174：会话排队.json 已是 schema:2、roles 是**数组**；
    // 旧代码 `queue.roles[role]` 按对象取 → 恒 undefined，这条硬判据形同虚设。数组/对象两种形态都兼容。）
    const qRoles = queue ? queue.roles : null;
    const qRow = (() => {
      if (Array.isArray(qRoles)) return qRoles.find((r) => r && String(r.role || '') === String(role)) || null;
      return (queue && (queue[role] || (qRoles && qRoles[role]))) || null;
    })();
    if (qRow && (qRow.running === true || qRow.thinking === true || Number(qRow.thinkSec || 0) > 0)) reasons.push(`有正在跑的会话（running=${qRow.running === true} / thinkSec=${Number(qRow.thinkSec || 0)}）`);
    // ③ working 任务
    const mine = tasks.filter((t) => String(t.owner || '') === String(role) && String(t.status || '') === 'working');
    if (mine.length) reasons.push(`名下有 ${mine.length} 个 working 任务（${mine.slice(0, 3).map((t) => t.id).join('、')}）`);
    // ④ 在途派单锁
    const myLocks = locks.filter((l) => String(l.role || '') === String(role) && !l.stale);
    if (myLocks.length) reasons.push(`持有 ${myLocks.length} 个在途派单锁`);
    const idle = reasons.length === 0;
    const remainingMin = idle ? 0 : Math.max(0, Math.ceil((lastMs + windowMs - now) / 60000));
    out[role] = { idle, reasons, lastActivityAt: lastMs ? new Date(lastMs).toISOString() : '', remainingMin };
  }
  const ok = Object.values(out).every((r) => r && r.idle);
  return { ok, minutes: mins, configValue: Number.isFinite(cfgMin) && cfgMin > 0 ? cfgMin : 15, roles: out };
}


/** B-3f02：换人优先级（档位 产品/需求0、测试1、开发2、PM3）× 接手状态 → 建议列表，只给建议。 */
export function rotationPriority(projectName) {
  const project = loadProject(projectName);
  const roleIds = (() => { try { return projectRoleIds(project); } catch { return []; } })();
  const tierOf = (role) => ({ product: 0, analyst: 0, tester: 1, programmer1: 2, programmer2: 2, pm: 3 })[role] ?? 9;
  // B-da51：镜像任务不算在办；终态用 statusIsClosed（accepted/cancelled/terminated）。
  const tasks = listTasks(projectName).filter((t) => !isRequirementMirrorTask(t) && !statusIsClosed(String(t.status || 'done')));
  const locks = (() => { try { return requireLocks(); } catch { return []; } })();
  const rows = roleIds.map((role) => {
    const mine = tasks.filter((t) => String(t.owner || '') === role);
    const roleLocks = locks.filter((l) => String(l.role || '') === role);
    const lastActivity = [].concat(
      mine.map((t) => String(t.doneAt || t.updatedAt || t.claimedAt || t.createdAt || '')),
      roleLocks.map((l) => String(l.heartbeatAt || l.acquiredAt || '')),
    ).filter(Boolean).sort().slice(-1)[0] || '';
    const state = roleLocks.length ? '阻塞' : (mine.length ? '可交接' : '空闲');
    const needPrep = mine.length > 3 || roleLocks.length > 0;
    return { role, tier: tierOf(role), state, inflight: mine.length, lastActivity, needPrep, locks: roleLocks.map((l) => l.key) };
  });
  const stateRank = { 空闲: 0, 可交接: 1, 阻塞: 2 };
  rows.sort((a, b) => a.tier - b.tier
    || stateRank[a.state] - stateRank[b.state]
    || a.inflight - b.inflight
    || String(b.lastActivity).localeCompare(String(a.lastActivity)));
  return rows.map((r, i) => ({ ...r, suggestOrder: i + 1, note: r.needPrep ? '需准备（在途>3 或阻塞）：只给建议，必须逐个确认' : '可直接交接' }));
}
// ---------- CLI ----------

function out(args, human, json) {
  if (args.json) jsonOut(json);
  else textOut(human);
}

export async function cmdSession(args) {
  const action = String(args._[1] || '').toLowerCase();
  const team = loadTeam();
  const projectName = String(args.project || team.activeProject || '');
  if (!projectName) fail('NO_PROJECT', '没有当前项目；先 project use / --project');
  if (action === 'rounds') {
    const r = roundsQuery(projectName, String(args.role || ''));
    const human = `阶段 · ${r.role}：${r.roundsSinceArchive}/${r.max}${r.lastArchiveAt ? ' ｜ 上次归档 ' + r.lastArchiveAt : ''}`;
    out(args, human, r);
    return;
  }
  if (action === 'transcript') {
    const r = exportTranscriptToProject({ projectName, sessionId: String(args.session || ''), role: String(args.role || '') });
    const human = r.transcript === 'ok'
      ? `转录 ${r.session}：${r.turns.length} 段${r.file ? '（已落 ' + r.file + '）' : ''}`
      : `转录 ${r.session}：${r.transcript}（不伪造、不报错）`;
    out(args, human, { ok: r.transcript === 'ok', ...r });
    return;
  }
  if (action === 'audit') {
    const r = auditOutput({ projectName, role: String(args.role || ''), relFile: String(args.file || '') });
    const human = r.violation
      ? `违规：${r.record.file}（${r.record.kind}，${r.record.escalated ? `已升级 ${r.record.escalatedTo}` : '已退回重写'}）`
      : `合规：${r.file}（未发现连续 3 行英文叙述）`;
    out(args, human, r);
    return;
  }
  if (action === 'archive') {
    // R-a1eb §6.3：归档是写命令 → 硬校验（旧会话 → SESSION_REPLACED，零写入）
    const boot = requireBoot(String(args.boot || ''), { write: true });
    if (!['pm', 'owner'].includes(String(boot.role || ''))) fail('PERMISSION_DENIED', `只有 PM/Owner 能归档会话（当前 ${boot.role}）`);
    const self = Boolean(args.self);
    if (!self && !args.confirm) fail('CONFIRM_REQUIRED', '归档需显式 --confirm（或 PM --self 后 owner confirm --archive）');
    if (self && String(args.role || '') !== 'pm') fail('BAD_ARGS', '--self 只用于 PM 自归档');
    const r = archiveSession({ projectName, role: String(args.role || ''), reason: String(args.reason || ''), self, force: Boolean(args.force), replacementSessionId: String(args.replacement || ''), operator: String(boot.role), sessionId: String(args['archive-session'] || '') });
    const human = `已归档 ${r.record.id}（${r.record.role}，会话 ${r.record.sessionId || '(无)'}，rounds=${r.record.rounds}，nextSessionId=null，rotate 后回写）\n记录：${r.file}${r.decisionLog ? '\n决策日志：' + r.decisionLog + '（待 Owner confirm）' : ''}`;
    out(args, human, { ok: true, ...r });
    return;
  }
  if (action === 'usage') {
    // R-703f F-1：--set 造数（写 会话用量.json，来源 manual/usage-hook），--check 手动跑一次提醒判定。
    if (args.set) {
      const role = String(args.role || '');
      if (!ROLE_NAMES[role]) fail('BAD_ROLE', `--set 需要 --role（${Object.keys(ROLE_NAMES).join('/')}）`);
      const tokens = Number(args.tokens);
      if (!Number.isFinite(tokens) || tokens < 0) fail('BAD_ARGS', '--set 需要 --tokens <非负整数>');
      const written = writeSessionUsageTrack(projectName, role, {
        role, sessionId: String(args.session || ''), tokens,
        at: nowIso(), source: String(args.source || 'manual')
      });
      const check = await checkSessionRotateWarn({ projectName, limit: Number(args.warn || args.threshold || DEFAULT_SESSION_TOKEN_LIMIT), source: 'usage --set' });
      out(args, `会话用量已写入 ${written.file}：${role} ${tokens} ｜ 提醒判定 ${check.warned.length ? '已发 ' + check.warned.join('/') : '未触发'}`, { ok: true, ...written, check });
      return;
    }
    if (args.check) {
      const check = await checkSessionRotateWarn({ projectName, limit: Number(args.warn || args.threshold || DEFAULT_SESSION_TOKEN_LIMIT), source: 'manual' });
      out(args, `会话用量提醒检查：阈值 ${check.threshold}（只提醒不强制）｜ ${check.rows.length} 个角色有记录 ｜ 本次提醒 ${check.warned.length}`, { ok: true, ...check });
      return;
    }
    if (args.session || args['first-turn']) {
      const r = firstTurnUsage({ projectName, sessionId: String(args.session || ''), role: String(args.role || '') });
      out(args, `首次 token 采样 · ${r.role || '-'} ｜ session ${r.session}：${r.firstTurnInputTokens === null ? '未知' : r.firstTurnInputTokens}（${r.transcript}，sampledAt ${r.sampledAt}）`, { ok: true, ...r });
      return;
    }
    // 兼容：--threshold 旧语义=预警阈值；--warn 同义；--force 设强制阈值。
    // B-usage-semantics：都不传 → 全走 sessionLimitsOf 单源默认（本会话累计 500 万/1000 万，项目可覆盖）。
    const warnThreshold = Number(args.warn || args.threshold || 0) || 0;
    const forceThreshold = Number(args.force || 0) || 0;
    const r = await sessionUsage({ projectName, role: String(args.role || ''), warnThreshold, forceThreshold });
    const lines = [`会话 token 用量 · ${projectName} ｜ DSH ${r.dshOk ? '可用' : '不可达（' + r.dshWhy + '）'} ｜ 默认：预警 本会话累计输入 ≥ ${r.warnThreshold} · 强制 ≥ ${r.forceThreshold}（换人归零）`];
    lines.push('角色         会话                          未缓存输入    缓存读       output      total      状态   预警/强制');
    for (const row of r.rows) {
      const id = row.sessionId || '(无)';
      const fmt = (v) => (v === null ? '未知' : String(v));
      const state = row.force ? '⛔ 建议换人' : (row.level === 'warn' ? '⚠ 预警' : (row.inputTokens === null ? '未知' : '正常'));
      // B-usage-semantics：人类输出也给出**该角色实际生效**的 warn/force 及其来源（项目覆盖 / 显式 / 内置累计预算）
      const thr = `${row.warnThreshold == null ? r.warnThreshold : row.warnThreshold}/${row.forceThreshold == null ? r.forceThreshold : row.forceThreshold}${row.thresholdSource === 'project.sessionLimits' ? '（项目覆盖）' : ''}`;
      lines.push(`${row.name.padEnd(10)} ${id.padEnd(30)} ${fmt(row.uncachedInputTokens).padStart(10)} ${fmt(row.cacheReadTokens).padStart(11)} ${fmt(row.outputTokens).padStart(11)} ${fmt(row.totalTokens).padStart(11)} ${state} ${thr}`);
    }
    for (const row of r.rows.filter((x) => x.note && x.level !== 'unknown')) lines.push(`提示 · ${row.name}：${row.note}`);
    if (r.rows.some((x) => x.inputTokens === null)) lines.push('说明：无 DSH tokenUsage 时标“未知”，不按 0；input=uncachedInputTokens（本会话累计未缓存输入，换人归零），cacheRead 单列不计入预警。');
    out(args, lines.join('\n'), { ok: true, ...r });
    return;
  }
  if (action === 'check') {
    const r = checkSessionMap(projectName);
    const lines = [`会话映射一致性 · ${projectName} ｜ ${r.ratio} ${r.ok ? 'PASS' : 'FAIL'}${r.teamApplicable ? '' : '（非活跃项目：团队.json 是当前项目镜像，不参与校验）'}`];
    for (const row of r.rows) lines.push(`${row.consistent ? 'PASS' : 'FAIL'}  ${row.role.padEnd(10)} team=${row.teamId || '-'} manifest=${row.manifestId || '-'} wb=${row.wbId || '-'} inIds=${row.inSessionIds ? 'Y' : 'N'}${row.fields.length ? '  ' + row.fields.join('；') : ''}`);
    out(args, lines.join('\n'), { ok: r.ok, ...r });
    return;
  }
  if (action === 'priority') {
    const rows = rotationPriority(projectName);
    const human = ['换人优先级建议 · ' + projectName + '（只给建议，必须逐个确认）',
      ...rows.map((r) => `${r.suggestOrder}. ${ROLE_NAMES[r.role] || r.role}（档位${r.tier}）｜${r.state}｜在途 ${r.inflight}${r.needPrep ? '｜需准备' : ''}`),
    ].join('\n');
    out(args, human, { ok: true, project: projectName, rows });
    return;
  }
  if (action === 'handover') {
    const role = String(args.role || '');
    if (!role) fail('BAD_ROLE', '需要 --role');
    // R-20261118-143558-eba2：session handover receipt --role <角色> 落交接回执（换人前置）。
    if (String(args._[2] || '').toLowerCase() === 'receipt') {
      const sandbox = String(process.env.TEAM_SELFTEST || '') === '1';
      const enforce = String(process.env.TEAM_BOOT_ENFORCE || '') === '1';
      // B-20261118-163400-3ad1（B 交叉审计 P1-1）：本分支与 rotate（下方 :1397 起同一套路）口径必须一致——
      // 沙盘且未 enforce → 与 rotate 一样**显式豁免**（by 记 sandbox，审计可查），不再因为
      // tokenRole 被写成 selftest 而恒 PERMISSION_DENIED（旧实现：receipt 沙盘必拒 / rotate 沙盘全放）。
      const sandboxExempt = sandbox && !enforce;
      let tokenRole = 'selftest';
      if (!sandboxExempt) {
        const token = String(args.boot || '').trim();
        if (!token) fail('BOOT_REQUIRED', '落交接回执必须带 --boot 启动令牌', { role, project: projectName });
        // R-a1eb §6.3：落交接回执是写命令 → 走 write 校验（沙盘豁免分支不变）
        tokenRole = String(requireBoot(token, { write: true }).role || '');
        const allowed = tokenRole === role
          || ['pm', 'owner'].includes(tokenRole)
          || (tokenRole === 'product' && role === 'pm');
        if (!allowed) {
          fail('PERMISSION_DENIED', `只有本人/PM/Owner（产品仅可为 PM）能落交接回执（当前令牌角色 ${tokenRole}）`, { role, project: projectName, tokenRole });
        }
      }
      const byRole = sandboxExempt ? 'sandbox' : tokenRole;
      const rec = recordHandoverReceipt(projectName, role, { by: byRole, messageId: String(args['message-id'] || '') });
      // B-a6d1：PM 的交接回执落账后，换人执行人是产品——给产品发一条可执行提醒（否则流程靠产品自觉）。
      if (String(role) === 'pm') {
        try {
          sendMessage({
            from: 'system', to: 'product', project: projectName, type: 'notice',
            subject: 'PM 交接回执已到：可由产品执行换人',
            body: `PM 的交接回执 ${rec.receipt.id} 已落（sha256 ${String(rec.receipt.sha256).slice(0, 12)}…，${rec.receipt.bytes}B）。\n按口径（Owner 2026-11-18）：PM 自己的换人只能由产品执行。\n步骤：①核对 PM 交接八节齐；②执行：node 团队\\工具\\team.mjs session rotate --role pm --project "${projectName}"；③换人后广播其余角色重 boot（旧令牌会失效）。`,
          });
        } catch { /* 提醒失败不影响回执落账 */ }
      }
      out(args,
        `交接回执已记录：${rec.receipt.id} ｜ ${role} ｜ ${rec.receipt.path} ｜ ${rec.receipt.bytes}B ｜ sha256 ${rec.receipt.sha256.slice(0, 12)}…${sandboxExempt ? `（沙盘豁免：by=sandbox，未校验令牌；设 TEAM_BOOT_ENFORCE=1 可验门禁本体）` : ''}\n记录：${rec.file}\n下一步：PM 核对后 session rotate --role ${role}（rotate 会自动校验该回执 sha）`,
        { ok: true, ...rec });
      return;
    }
    const r = buildHandover({ projectName, role, sessionId: String(args.session || '') });
    out(args, r.text, { ok: true, ...r });
    return;
  }
  if (action === 'rotate') {
    // R-a1eb §6.4：批量入口优先（--batch / --roles a,b / --all），一次写名册 + 一次广播。
    const batchFlag = Boolean(args.batch) || Boolean(args.roles) || Boolean(args.all) || Boolean(args.sessions);
    if (batchFlag) {
      const batchSandbox = String(process.env.TEAM_SELFTEST || '') === '1';
      const batchEnforce = String(process.env.TEAM_BOOT_ENFORCE || '') === '1';
      let batchActor = 'selftest';
      if (!batchSandbox || batchEnforce) {
        const bootToken = String(args.boot || '').trim();
        if (!bootToken) fail('BOOT_REQUIRED', '批量换人必须带 --boot 启动令牌（PM/Owner）', { project: projectName });
        // R-a1eb §6.3：写命令硬校验「令牌会话 == 名册 current」（零写入）
        const info = requireBoot(bootToken, { write: true });
        batchActor = String(info.role || '');
      }
      const batchRoles = String(args.roles || '').split(/[,\s，]/).map((x) => x.trim()).filter(Boolean);
      const sessionMap = {};
      for (const part of String(args.sessions || '').split(/[,\s，]/).map((x) => x.trim()).filter(Boolean)) {
        const idx = part.indexOf('=');
        if (idx <= 0) continue;
        const r = part.slice(0, idx).trim();
        const id = part.slice(idx + 1).trim();
        if (r && id) sessionMap[r] = id;
      }
      if (args.session && batchRoles.length === 1) sessionMap[batchRoles[0]] = String(args.session);
      const record = await rotateSessionBatch({
        projectName,
        roles: batchRoles,
        sessionIds: sessionMap,
        all: Boolean(args.all),
        force: Boolean(args.force),
        offline: Boolean(args.offline),
        reason: String(args.reason || ''),
        by: batchActor,
        failAt: String(args['fail-at'] || ''),
        sessionTitle: String(args.title || ''),
        windowMinutes: Number(args.window || 30),
        dryRun: Boolean(args['dry-run']),
        audit: { actorRole: batchActor, batch: true },
      });
      if (record.dryRun) {
        const lines = [
          `批量轮换预演（dry-run，零写入）· ${projectName} ｜ ${record.roles.length} 个角色：${record.roles.join(',')}`,
          ...record.entries.map((e, i) => `  ${i + 1}. ${e.role}: ${e.from || '(无)'} → ${e.to}`),
          `当前四处一致性：${record.consistencyNow}`,
          `将写：${record.wouldWrite.join('、')}`,
          `广播：1 条（全体 active，含被换角色名）｜ 待启动队列：${record.bootPending} 条`,
          '未写入任何文件；确认后去掉 --dry-run 执行。',
        ];
        out(args, lines.join('\n'), { ok: true, ...record });
        return;
      }
      const lines = [
        `已批量轮换 ${record.roles.length} 个角色：${record.roles.join(',')}`,
        ...record.entries.map((e, i) => `  ${i + 1}. ${e.role}: ${e.from || '(无)'} → ${e.to}`),
        record.alreadyRotated && record.alreadyRotated.length ? `已换过（跳过）：${record.alreadyRotated.join(',')}` : '',
        `名册写入：一次事务（batchId ${record.batchId}）`,
        `四处映射一致性：${record.consistency ? record.consistency.ratio + ' ' + (record.consistency.ok ? 'PASS' : 'FAIL') : '-'}`,
        `广播：${record.broadcast} 条（收件人 ${(record.broadcastDetail && record.broadcastDetail.recipients || []).length}：${(record.broadcastDetail && record.broadcastDetail.recipients || []).join(',')}）`,
        `待启动队列（BQ）：${record.bootPending} 条`,
        `名册版本：${String(record.rosterVersionBefore || '').slice(0, 12) || '-'} → ${String(record.rosterVersionAfter || '').slice(0, 12) || '-'}`,
        `轮换记录：${record.roles.map((r) => `会话轮换/${r}.json`).join('、')}`,
        '注：其余角色令牌不受影响（名册已移出 rulesHash），无需重 boot。',
      ].filter(Boolean);
      out(args, lines.join('\n'), { ok: true, ...record });
      return;
    }
    const role = String(args.role || '');
    if (!role) fail('BAD_ROLE', '需要 --role（批量用 --batch --roles a,b 或 --all）');
    // B-20261118-001244-cdd0：rotate 会改四处会话映射（团队.json / 项目会话映射 / workbench），属敏感操作，
    // 必须带有效启动令牌且限定 PM/Owner——原实现只有 archive 分支调 requireBoot，rotate 空令牌也能换人。
    // 沙盘（TEAM_SELFTEST=1）默认豁免以保持既有 selftest/夹具可用；门禁本体用 TEAM_BOOT_ENFORCE=1 强制（cdd0 夹具即此）。
    // 校验放在接任包检查之前（起手第一件事）：失败零副作用，不写任何映射/记录/归档。
    const bootSandbox = String(process.env.TEAM_SELFTEST || '') === '1';
    const bootEnforce = String(process.env.TEAM_BOOT_ENFORCE || '') === '1';
    let actorRole = 'selftest';
    if (!bootSandbox || bootEnforce) {
      const bootToken = String(args.boot || '').trim();
      if (!bootToken) fail('BOOT_REQUIRED', '会话轮换必须带 --boot 启动令牌（PM/Owner，或产品换 PM）', { role, project: projectName });
      const bootInfo = requireBoot(bootToken, { write: true });
      actorRole = String(bootInfo.role || '');
      if (!rotateAllowed(actorRole, role)) {
        fail('PERMISSION_DENIED', `只有 PM/Owner 能轮换会话；产品只能给 PM 换人、PM 不能给自己换人（当前令牌角色 ${actorRole || '-'} → 目标 ${role}）`, { role, project: projectName, tokenRole: actorRole });
      }
    }
    // B-20261119-204845-8d91（Owner 直接指令）：**PM 换人必须先满足「双方闲时」**——
    // 产品不能在 PM 忙碌、或自己正跑任务时直接换人。四项：近 N 分钟无新消息 / 无 running 会话 /
    // 无名下 working 任务 / 无在途派单锁；N 取 团队.json → config.pmRotateIdleMin（默认 15）。
    // 不满足 → WAIT_BOTH_IDLE 拒绝（在任何写盘之前 → 零副作用），并输出缺哪一方、还差多少分钟。
    if (role === 'pm') {
      const idleGate = pmRotateIdleState(projectName, { now: Date.now() });
      if (!idleGate.ok) {
        const busy = Object.entries(idleGate.roles).filter(([, r]) => !r.idle);
        const detail = busy.map(([roleName, r]) => `${roleName}：${r.reasons.join('；')}${r.remainingMin ? `（约还差 ${r.remainingMin} 分钟）` : ''}`).join(' / ');
        fail('WAIT_BOTH_IDLE', `PM 换人要求 PM 与产品双方闲时 ≥ ${idleGate.minutes} 分钟（team.json → config.pmRotateIdleMin，默认 15）：${detail}。请等双方都静下来再换人（或由 Owner 直接指令换人）`, {
          role, project: projectName, minutes: idleGate.minutes,
          busy: busy.map(([roleName, r]) => ({ role: roleName, reasons: r.reasons, remainingMin: r.remainingMin, lastActivityAt: r.lastActivityAt })),
          next: '等 PM 与产品都空闲（无新消息/无 running/无 working 任务/无派单锁）后再执行；Owner 通道不设此门',
        });
      }
    }
    // R-20261118-143558-eba2：换人前必须有人落交接回执，且回执 sha 与磁盘一致。
    // 沙盘默认豁免（既有 selftest 的 4 处 rotate 无回执），门禁本体用 TEAM_HANDOVER_ENFORCE=1 强制。
    const handoverEnforce = String(process.env.TEAM_HANDOVER_ENFORCE || '') === '1';
    let handoverAudit = { actorRole };
    if (!bootSandbox || handoverEnforce) {
      const rc = checkHandoverReceipt(projectName, role);
      if (!rc.ok) {
        fail('HANDOVER_RECEIPT_REQUIRED', `换人前必须落交接回执且 sha 与磁盘一致（${rc.reason}）；先 session handover receipt --role ${role}`, {
          role, project: projectName, reason: rc.reason,
          receiptId: rc.receipt ? rc.receipt.id : null,
          expected: rc.expected || null, got: rc.got || null,
        });
      }
      handoverAudit = {
        actorRole,
        handoverSha256: rc.sha256, handoverBytes: rc.bytes, handoverPath: rc.file,
        receiptId: rc.receipt.id, receiptAt: rc.receipt.at,
      };
    }
    // B-3f02 / B-20261118-083150-4b2f：rotate 前机械检查接任包小节；4 个必填【】小节缺失 → 拒 rotate（零副作用）。
    // 交接判据统一走 roster-writer.checkRotateHandover（内部固定 validateHandover），auto-rotate 用同一函数 → 两路径同判。
    try {
      const v = await checkRotateHandover({ projectName, role, sessionId: String(args.session || '') });
      if (v.code === 'HANDOVER_INCOMPLETE' || (v.code === '' && !v.ok)) {
        const missing = (v.missingRequired || []).concat(v.emptyRequired || []);
        fail('HANDOVER_INCOMPLETE', `接任包缺必填小节：${missing.join('、')}；补齐后再 rotate`, { role, missing, redFlags: v.redFlags, source: v.source });
      }
    } catch (e) { if (e && e.code === 'HANDOVER_INCOMPLETE') throw e; /* 其它失败不阻 rotate（与原实现同口径） */ }
    const dryRun = Boolean(args['dry-run']);
    const record = await rotateSession({
      projectName,
      role,
      sessionId: String(args.session || ''),
      force: Boolean(args.force),
      offline: Boolean(args.offline),
      reason: String(args.reason || ''),
      by: actorRole,
      audit: handoverAudit,
      failAt: String(args['fail-at'] || ''),
      sessionTitle: String(args.title || ''),
      windowMinutes: Number(args.window || 30),
      dryRun,
    });
    if (dryRun) {
      const lines = [
        `轮换预演（dry-run，零写入）· ${projectName} ｜ ${role}：${record.from || '(无)'} → ${record.to}`,
        `当前四处一致性：${record.consistencyNow}`,
        `将写：${record.wouldWrite.join('、')}`,
        `将归档旧消息：${record.mailArchive.length} 条${record.mailArchive.length ? '（' + record.mailArchive.slice(0, 5).map((x) => x.id).join('、') + (record.mailArchive.length > 5 ? ' …' : '') + '）' : ''}`,
        `跳过不归档：${record.mailSkipped.length} 条${record.mailSkipped.length ? '（如 ' + record.mailSkipped.slice(0, 3).map((x) => `${x.id}：${x.why}`).join('；') + '）' : ''}`,
        `将改任务：${record.tasks.length ? record.tasks.join('、') : '无'}`,
        `将清派单锁：${record.dispatchLock.cleared ? '是（' + (record.dispatchLock.messageId || '无单号') + '）' : '无'}`,
        `归档门：${record.archiveGate.archived ? '已归档（可 rotate）' : (record.archiveGate.inFlight ? '未归档，有在途任务/锁 → 将按 ARCHIVE_DEFERRED 放行' : '未归档且无在途任务 → 将拒绝 ARCHIVE_REQUIRED')}`,
        '未写入任何文件；确认后去掉 --dry-run 执行。',
      ];
      out(args, lines.join('\n'), { ok: true, ...record });
      return;
    }
    const lines = [
      `已轮换 ${role}：${record.from || '(无)'} → ${record.to}`,
      `四处映射一致性：${record.consistency.ratio} ${record.consistency.ok ? 'PASS' : 'FAIL'}${record.consistency.teamApplicable ? '' : '（非活跃项目，团队.json 未改）'}`,
      `团队.json 名册：${record.teamRoster || 'updated'}`,
      `旧会话归档：${record.archived ? (record.archived.ok ? '已归档只读' : '归档失败（映射已切换）：' + record.archived.why) : '无旧会话/离线跳过'}`,
      record.archiveDeferred
        ? `归档门：⚠ ARCHIVE_DEFERRED（在途任务 ${record.archiveDeferred.tasks.length} 个${record.archiveDeferred.locks.length ? `、锁 ${record.archiveDeferred.locks.length} 个` : ''}；旧会话未冻结，新会话先闭环再归档）`
        : `归档门：已归档（rotate 前 archive 成功${record.archiveGate.archiveId ? '，' + record.archiveGate.archiveId : ''}）`,
      // R-28b8：换人成功后的「旧会话自动归档」五态（archived/already/deferred/failed/skipped/stubbed）
      (() => {
        const a = record.archiveOutcome || record.archive || null;
        if (!a || !a.result) return '旧会话自动归档：未执行';
        const tail = a.result === 'archived' ? `（${a.archiveId || '-'}）`
          : a.result === 'deferred' ? `（在途任务 ${(a.tasks || []).length} 个，${a.deferredUntil || '-'} 起每拍补归档，最多 3 次）`
            : a.result === 'already' ? `（${a.archiveId || '已归档过'}）`
              : a.result === 'failed' ? `（${a.reason || a.error || '失败'}；已通知 PM，不阻断换人）`
                : `（${a.reason || '-'}）`;
        return `旧会话自动归档：${a.result}${tail}`;
      })(),
      `收件箱归档消息：${record.mailArchived} 条；任务会话指向：${record.tasks.length} 个`,
      record.bootPending && record.bootPending.queued
        ? `待启动队列：已登记 ${record.bootPending.entry.id}（${record.bootPending.wake && record.bootPending.wake.ok
          ? (record.bootPending.wake.skipped === 'SELFTEST' ? '沙盘跳过推送' : '已推送启动提示')
          : '推送失败：' + ((record.bootPending.wake && record.bootPending.wake.why) || '-')}）`
        : `待启动队列：未登记${record.bootPending && record.bootPending.why ? '（' + record.bootPending.why + '）' : ''}`,
      `记录：${path.join(rotateDir(projectName), `${role}.json`)}`,
    ];
    // R-2e6b：rotate 成功后回写归档记录的 nextSessionId / rotatedAt（archive 时留 null）。
    let archiveWriteBack = null;
    try { archiveWriteBack = writeBackRotated({ projectName, role, oldSessionId: record.from || '', newSessionId: record.to || '' }); } catch { /* 回写失败不阻断轮换 */ }
    if (archiveWriteBack) lines.push(`归档回写：${archiveWriteBack.record.id} nextSessionId=${archiveWriteBack.record.nextSessionId} rotatedAt=${archiveWriteBack.record.rotatedAt}`);
    // B-bbf6 ③：换人后旧队列项要么改投新会话、要么作废并留审计——不许静默悬挂在派单队列里。
    let queueReconcile = null;
    try {
      const opsMod = await import('./ops.mjs');
      queueReconcile = opsMod.reconcileDispatchQueueSessions(projectName, { reason: `rotate:${role}`, by: 'system' });
      if (queueReconcile && queueReconcile.changed) {
        lines.push(`派单队列对齐：改投新会话 ${queueReconcile.rebased.length} 条，作废 ${queueReconcile.discarded.length} 条（已留审计）`);
      }
    } catch (e) { queueReconcile = { ok: false, why: String((e && e.message) || e) }; }
    out(args, lines.join('\n'), { ok: true, ...record, archiveWriteBack, queueReconcile });
    return;
  }
  fail('BAD_ACTION', `会话命令只支持 usage | check | rotate | handover（收到 ${action || '(空)'}）`);
}
