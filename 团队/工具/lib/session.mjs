// 角色会话轮换与上下文回收（R-20261112-155311-c0a6）
//
// 命令（team.mjs session）：
//   session usage    [--project P] [--role R] [--threshold 500000] [--json]
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
  jsonOut, textOut, truncate, stamp, listLocks, randomHex,
} from './core.mjs';
import {
  loadTeam, mutateTeam, getMember, loadProject, projectStatePaths, listTasks, saveTask,
  projectTeamMode, projectRoleIds, sendMessage,
} from './store.mjs';
import { ROLE_DIRS, ROLE_NAMES, rolesForMode, normalizeTeamMode } from './roles.mjs';
import { DshClient } from './dsh-session.mjs';
import { roundsQuery, exportTranscriptToProject, auditOutput, archiveSession, firstTurnUsage, writeBackRotated, listArchives } from './session-archive.mjs';
import { requireBoot } from './store.mjs';

// R-2e6b AC18.4：双档水位——30 万预警（提示准备归档/换人）、50 万强制归档/换人（与 c0a6 口径一致）。
export const DEFAULT_TOKEN_WARN = 300000;
export const DEFAULT_TOKEN_FORCE = 500000;
// R-20261114-001011-703f F-1：30 万是“提醒”阈值（可配），只提醒不强制换人；硬上限由 Owner 另定。
export const DEFAULT_SESSION_TOKEN_LIMIT = 300000;
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

function writeWorkbench(data) {
  const file = workbenchPath();
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

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

function listDshSessions() {
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
    const engine = process.env.DSH_WEB_URL || '';
    if (!engine) { resolve({ ok: false, why: '没有 DSH_WEB_URL' }); return; }
    const client = new DshClient(engine);
    client.list().then((r) => resolve({ ok: true, items: r.items || [] })).catch((e) => resolve({ ok: false, why: e.message }));
  });
}

/**
 * token 水位双档（AC18.4）：force=强制归档/换人，warn=预警，ok=正常，unknown=取不到数值（不按 0）。
 * 阈值可配；默认 30 万预警 / 50 万强制（与 c0a6 的 50 万口径一致）。
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
  const track = readSessionUsageTrack(name);
  const team = loadTeam();
  const members = Array.isArray(team.members) ? team.members : [];
  const rows = [];
  let changed = false;
  for (const [role, raw] of Object.entries(track.roles)) {
    if (!ROLE_NAMES[role]) continue;
    const row = raw && typeof raw === 'object' ? raw : {};
    const tokens = Number(row.tokens);
    const atMs = Date.parse(String(row.at || ''));
    const member = members.find((m) => m && m.role === role && m.status === 'active');
    const item = {
      role, name: ROLE_NAMES[role] || role,
      tokens: Number.isFinite(tokens) ? tokens : null,
      at: row.at || '', source: row.source || '', sessionId: row.sessionId || '',
      level: usageLevelOf(tokens, threshold, DEFAULT_TOKEN_FORCE),
      warned: false, reason: ''
    };
    if (!Number.isFinite(tokens)) { item.reason = '用量未知'; rows.push(item); continue; }
    if (!Number.isFinite(atMs) || Date.now() - atMs > USAGE_MAX_AGE_MS) { item.reason = '用量过期（at 超 24h）'; rows.push(item); continue; }
    if (tokens < threshold) { item.reason = '未到提醒阈值'; rows.push(item); continue; }
    if (!member) { item.reason = '角色不在队'; rows.push(item); continue; }
    const dedupe = `${role}:${tokens}:${row.sessionId || ''}`;
    if (String(row.warnedFor || '') === dedupe) { item.reason = '同一用量已提醒过'; rows.push(item); continue; }
    const sessionId = String(row.sessionId || member.sessionId || '');
    const subject = `会话用量提醒：${ROLE_NAMES[role] || role} ${tokens} ≥ ${threshold}`;
    const body = [
      `${ROLE_NAMES[role] || role} 当前会话用量 ${tokens} / 提醒阈值 ${threshold}（只提醒，不自动换人）。`,
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
      appendEvent({ role: 'system', sessionId: '', action: 'session_rotate_warn', project: name, note: `${role} tokens=${tokens} limit=${threshold} source=${source}` });
    }
    rows.push(item);
  }
  if (changed) writeJson(track.file, track.roles);
  return { project: name, threshold, warnOnly: true, file: track.file, rows, warned: rows.filter((r) => r.warned).map((r) => r.role) };
}

export async function sessionUsage({
  projectName, role = '',
  warnThreshold = DEFAULT_TOKEN_WARN, forceThreshold = DEFAULT_TOKEN_FORCE,
}) {
  const name = String(projectName || '');
  if (!name) fail('NO_PROJECT', '需要 --project');
  const warn = Number(warnThreshold);
  const force = Number(forceThreshold);
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
    const level = usageLevelOf(usage ? usage.inputTokens : null, warn, force);
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
      note: level === 'force'
        ? `input ${usage.inputTokens} ≥ 强制阈值 ${force}：先 session archive 再 session rotate（未归档 rotate 会被 ARCHIVE_REQUIRED 拒）`
        : level === 'warn'
          ? `input ${usage.inputTokens} ≥ 预警阈值 ${warn}：建议准备 archive/rotate，避免到 ${force} 被动换人`
          : (usage ? '' : '未知（不按 0）'),
    });
  }
  return { project: name, warnThreshold: warn, forceThreshold: force, threshold: force, dshOk: list.ok, dshWhy: list.ok ? '' : list.why, rows };
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
  return `【会话启动】你是 ${ROLE_NAMES[role] || role} 的新会话（项目：${project}），还没有 boot。\n`
    + `先执行：node "${teamTool}" boot --role ${role} --project "${project}"，再按启动简报读 inbox/任务。\n`
    + `这是一条系统启动提示，不是新派单；boot 之后照常处理派单。只回一行：已上线 + 会话 id。`;
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

function sortedSnapshot(map) {
  return {
    team: JSON.stringify(map.team, null, 2) + '\n',
    manifest: map.manifestRaw ? JSON.stringify(map.manifestRaw, null, 2) + '\n' : null,
    workbench: map.wb ? JSON.stringify(map.wb, null, 2) + '\n' : null,
  };
}

function atomicWriteRaw(file, raw) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, raw, 'utf8');
  fs.renameSync(tmp, file);
}

function restoreSnapshot(projectName, snap) {
  const project = loadProject(projectName);
  // 原子写（tmp+rename）：回滚中途断电不会留下半截文件（复核 P2-6）。
  if (snap.team) atomicWriteRaw(PATHS.team, snap.team);
  if (snap.manifest) atomicWriteRaw(path.join(project.path, '团队会话.json'), snap.manifest);
  if (snap.workbench) atomicWriteRaw(workbenchPath(), snap.workbench);
}

function applyMaps({ projectName, role, oldId, newId, map, failAt }) {
  const project = loadProject(projectName);
  const team = loadTeam();
  // 团队.json 是全局名册（单一 activeProject 镜像）：非活跃项目轮换不写它，避免污染当前项目映射。
  const activeProject = String(team.activeProject || '') === projectName;
  let teamRoster = activeProject ? 'updated' : 'skipped（非活跃项目，团队.json 是当前项目镜像）';
  if (activeProject) {
    const member = getMember(team, role);
    if (!member) fail('BAD_ROLE', `团队名册没有角色：${role}`);
    member.sessionId = newId;
    if (failAt === 'afterTeam') fail('ROTATE_INJECTED_FAIL', '注入失败：团队.json 写入前');
    atomicWriteJson(PATHS.team, team);
  }

  const manifest = map.manifestRaw || { project: projectName, teamMode: projectTeamMode(project), workspace: project.path, roles: [] };
  manifest.roles = Array.isArray(manifest.roles) ? manifest.roles : [];
  let row = manifest.roles.find((r) => r && r.role === role);
  if (!row) {
    row = { role, name: ROLE_NAMES[role] || role, title: `团队·${ROLE_NAMES[role] || role}`, sessionId: newId, reused: false, model: '' };
    manifest.roles.push(row);
  } else row.sessionId = newId;
  manifest.generatedAt = nowIso();
  if (failAt === 'afterManifest') fail('ROTATE_INJECTED_FAIL', '注入失败：团队会话.json 写入前');
  atomicWriteJson(path.join(project.path, '团队会话.json'), manifest);

  const wb = map.wb || { version: 1, activeProjectId: null, projects: [] };
  wb.projects = Array.isArray(wb.projects) ? wb.projects : [];
  let wp = wb.projects.find((p) => p && (p.name === projectName || p.path === project.path));
  if (!wp) {
    wp = { name: projectName, path: project.path, sessions: {}, workspace: { sessionIds: [] } };
    wb.projects.push(wp);
  }
  wp.sessions = (wp.sessions && typeof wp.sessions === 'object') ? wp.sessions : {};
  wp.sessions[role] = newId;
  wp.workspace = (wp.workspace && typeof wp.workspace === 'object') ? wp.workspace : {};
  wp.workspace.sessionIds = Array.isArray(wp.workspace.sessionIds) ? wp.workspace.sessionIds.map(String) : [];
  if (oldId) wp.workspace.sessionIds = wp.workspace.sessionIds.filter((sid) => sid !== oldId);
  if (!wp.workspace.sessionIds.includes(newId)) wp.workspace.sessionIds.push(newId);
  wp.sessionMeta = (wp.sessionMeta && typeof wp.sessionMeta === 'object') ? wp.sessionMeta : {};
  wp.sessionMeta[role] = { ...(wp.sessionMeta[role] || {}), updatedAt: nowIso() };
  if (failAt === 'afterWorkbench') fail('ROTATE_INJECTED_FAIL', '注入失败：workbench.json 写入前');
  writeWorkbench(wb);
  return { teamRoster };
}

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
    .filter((t) => String(t.owner || '') === String(role) && String(t.status) !== 'done')
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
  failAt = '', sessionTitle = '', windowMinutes = 30, dryRun = false,
}) {
  const name = String(projectName || '');
  if (!name) fail('NO_PROJECT', '需要 --project');
  const project = loadProject(name);
  const roleIds = projectRoleIds(project);
  if (!roleIds.includes(role)) fail('BAD_ROLE', `角色 ${role} 不在项目 ${name} 的模式内（${roleIds.join('/')}）`);
  const map = sessionOfRole(name);
  const oldId = String(map.members[role] || map.manifest[role] || map.wbSessions[role] || '');
  // R-2e6b：rotate 前置归档门（默认硬门；在途任务/锁走 ARCHIVE_DEFERRED 例外）。
  const gate = archiveGate(name, role, oldId);
  // 注入失败只用于沙盘自测，生产环境忽略，防止误用造半状态。
  if (failAt && !process.env.TEAM_SELFTEST) failAt = '';
  const list = await listDshSessions();
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
    if (offlineMode) fail('BAD_SESSION', '离线轮换必须用 --session 指定一个可用会话 id');
    if (!list.ok) {
      const command = `node 团队\\工具\\team.mjs session rotate --role ${role} --project "${name}" --session <新会话id> --reason "${reason || '手建降级'}"`;
      // AC2b：能自动建会话就建；不能就"手建降级"——不是 500 式失败，而是给出可复制的下一步。
      fail('ROTATE_MANUAL_REQUIRED', `DSH 不可达（${list.why}），无法自动建会话：请手建一个会话后执行下面命令登记（mode=manual）：${command}`, {
        why: list.why, role, project: name, from: oldId, mode: 'manual', command,
        step: 'owner-create-session-then-rotate-with-session', downgradedFrom: 'auto-create'
      });
    }
    const client = new DshClient(process.env.DSH_WEB_URL);
    const body = project.dshWorkspaceId ? { workspaceId: project.dshWorkspaceId } : { cwd: project.path };
    let createdRes = null;
    try {
      createdRes = await client.create(body);
    } catch (e) {
      // R-703f AC2b：自动建会话失败必须降级成“可复制的 handler 指令”，不能把 Owner 卡在报错里。
      const command = `node 团队\\工具\\team.mjs session rotate --role ${role} --project "${name}" --session <新会话id> --reason "${reason || '手建降级'}"`;
      fail('ROTATE_CREATE_FAILED', `自动建会话失败（${String((e && e.message) || e)}）：请先手建一个会话，再执行下面命令登记（mode=manual）：${command}`, {
        role, project: name, from: oldId, mode: 'manual', command, why: String((e && e.message) || e), step: 'owner-create-session-then-rotate-with-session'
      });
    }
    newId = createdRes.sessionId;
    created = true;
    const title = sessionTitle || `团队·${ROLE_NAMES[role] || role}`;
    try { await client.rename({ sessionId: newId, title }); } catch { /* 标题失败不阻断 */ }
  } else {
    if (!/^session-[A-Za-z0-9-]+$/.test(newId)) fail('BAD_SESSION', `会话 id 格式不对：${newId}`);
    if (!offlineMode) {
      if (list.ok) {
        const info = (list.items || []).find((s) => s.sessionId === newId);
        if (!info) fail('SESSION_NOT_FOUND', `指定会话不存在：${newId}；可先 session usage 或 DSH 会话列表确认`, { sessionId: newId });
      } else {
        fail('DSH_UNAVAILABLE', `无法校验指定会话：DSH 不可达（${list.why}）`);
      }
    }
  }
  if (newId === oldId) fail('SESSION_SAME', `新旧会话相同：${newId}`);

  const snap = sortedSnapshot(map);
  const at = nowIso();
  const recordId = `S-${stamp()}`;
  let archived = null;
  // 事务外先声明：catch 里要按“写入前原文”恢复邮件/任务/锁，不能只恢复四处映射（复核 P0-2）。
  let mailOriginals = [];
  let taskResult = { changed: [], originals: [] };
  let dispatchLock = { cleared: false, messageId: '' };
  try {
    const mapResult = applyMaps({ projectName: name, role, oldId, newId, map, failAt });
    const mailPlan = collectMailChanges({ role, oldId, newId, projectName: name });
    mailOriginals = applyMailArchive(mailPlan, oldId, newId);
    if (failAt === 'afterMail') fail('ROTATE_INJECTED_FAIL', '注入失败：邮件归档之后');
    taskResult = stampTasks(name, role, oldId, newId);
    dispatchLock = clearDispatchLockForRole(name, role);
    const maps = { teamRoster: mapResult.teamRoster };
    // 归档旧会话（只读保留）；失败只记，不回滚映射
    if (oldId && !offlineMode && list.ok) {
      try {
        const client = new DshClient(process.env.DSH_WEB_URL);
        await client.workspaceArchiveSession({ sessionId: oldId, stopActivity: true });
        archived = { ok: true, sessionId: oldId };
      } catch (e) {
        archived = { ok: false, sessionId: oldId, why: e.message };
      }
    }
    // R-703f F-5 / AC4：一真相三派生——写记录前先算一致性；不满足就按 F-6 回滚并判 ROTATE_MAPPING_MISMATCH，
    // 错误里写明哪一角色/哪一字段不一致（catch 里 restoreSnapshot 会把映射/邮件/任务/锁全部恢复）。
    const consistencyNow = checkSessionMap(name);
    const fullRatio = `${roleIds.length}/${roleIds.length}`;
    // 判「不一致」而不是「没绑全」：沙盘/新项目其它角色可能本来就没绑定（四路皆空）；
    // 目标角色行必须一致；任何角色只要出现过 id 但相互不同（fields 含「会话 id 不一致」）就算冲突。
    const targetRow = (consistencyNow.rows || []).find((row) => row && row.role === role) || null;
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
      fail('ROTATE_MAPPING_MISMATCH', `轮换后四处映射不一致（${detail}）；已按 F-6 回滚到旧会话 ${oldId || '(无)'}，本轮不换人`, {
        role, project: name, from: oldId, to: newId, consistency: consistencyNow, expectedRatio: fullRatio,
      });
    }
    const record = {
      id: recordId, project: name, role, from: oldId, to: newId, at, by, reason,
      // R-703f F-2/F-4：status=这条记录是不是当前绑定；mode=自动建会话还是 Owner 手建后登记（沿用 from/to）。
      status: 'active', mode: created ? 'auto' : 'manual', retiredAt: null,
      force: Boolean(force), created, archived,
      archiveGate: { archived: gate.archived, archiveId: gate.archive ? gate.archive.id : null },
      archiveDeferred,
      mailArchived: mailPlan.changes.length,
      mailArchivedIds: mailPlan.changes.map((c) => c.id),
      mailSkipped: mailPlan.skipped.length,
      mailSkippedReasons: mailPlan.skipped.slice(0, 20),
      tasks: taskResult.changed,
      dispatchLock, teamRoster: maps.teamRoster,
      consistency: consistencyNow,
      // 沙盘/未绑定 workbench 项目时不判硬门（可一致性前提不存在），但如实标注。
      consistencyEnforced: consistencyNow.workbenchAvailable === true,
    };
    // B-405f ③：rotate 后自动拉起一次（写待启动队列 + 尝试推送启动提示），失败只记、不阻断轮换。
    try {
      record.bootPending = await queueBootForRole({
        projectName: name, role, sessionId: newId,
        reason: `session_rotate:${reason || '未写原因'}`, offline: offlineMode,
      });
    } catch (e) {
      record.bootPending = { queued: false, why: String((e && e.message) || e) };
    }
    // R-703f F-7：上一份同角色记录标 retired（历史记录文件保留可查），当前角色文件=active 新记录。
    const roleFile = path.join(rotateDir(name), `${role}.json`);
    const previous = (() => { try { return readJson(roleFile); } catch { return null; } })();
    if (previous && previous.id && previous.id !== recordId) {
      record.previous = { id: previous.id, from: previous.from || '', to: previous.to || '', status: 'retired', retiredAt: at };
      try {
        const prevHistory = path.join(rotateDir(name), `${previous.id}.json`);
        const prevRow = readJson(prevHistory);
        if (prevRow) atomicWriteJson(prevHistory, { ...prevRow, status: 'retired', retiredAt: at });
      } catch { /* 历史文件缺失不阻断轮换 */ }
    }
    atomicWriteJson(roleFile, record);
    atomicWriteJson(path.join(rotateDir(name), `${recordId}.json`), record);
    appendEvent({
      role: by, sessionId: newId, action: 'session_rotate', project: name, target: role,
      note: `${oldId || '(无)'} → ${newId}（${reason || '未写原因'}）`,
      data: { from: oldId, to: newId, force: Boolean(force), mailArchived: mailPlan.changes.length, mailSkipped: mailPlan.skipped.length, tasks: taskResult.changed, archived, archiveDeferred: Boolean(archiveDeferred) },
    });
    return record;
  } catch (e) {
    // 回滚：四处映射 + 邮件 + 任务 + 派单锁全部恢复到轮换前，再归档本次创建的新会话。
    const rollback = { maps: false, mail: 0, tasks: 0, dispatchLock: false, newSessionArchived: false, errors: [] };
    try { restoreSnapshot(name, snap); rollback.maps = true; } catch (err) { rollback.errors.push(`映射恢复失败：${err.message}`); }
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
      try {
        await new DshClient(process.env.DSH_WEB_URL).workspaceArchiveSession({ sessionId: newId, stopActivity: true });
        rollback.newSessionArchived = true;
      } catch { rollback.errors.push('新会话归档失败'); }
    }
    appendEvent({
      role: by, sessionId: newId, action: 'rotate_failed', project: name, target: role,
      note: `失败回滚：${e.message}`, data: { from: oldId, to: newId, code: e.code || '', failAt, rollback, legacyAction: 'session_rotate_failed' },
    });
    if (e instanceof TeamError) throw e;
    fail('ROTATE_FAILED', `轮换失败已回滚到旧会话：${e.message}`, { from: oldId, to: newId, code: e.code || '', rollback });
  }
}

// ---------- 接任包 ----------

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
  if (rot && (!sessionId || rot.to === sessionId)) {
    lines.push(`轮换：${rot.from || '(无)'} → ${rot.to}（${rot.at}，${rot.reason || '未写原因'}）`);
    if (rot.archiveDeferred) {
      const d = rot.archiveDeferred;
      lines.push(`归档：ARCHIVE_DEFERRED（未归档；在途任务 ${(d.tasks || []).length} 个${(d.locks || []).length ? `、锁 ${d.locks.length} 个` : ''}；旧会话未冻结，新会话先闭环再归档）`);
    }
  } else if (sessionId) {
    lines.push(`轮换：当前会话 ${sessionId}（未找到对应轮换记录）`);
  }
  lines.push(`项目：${name}（${mode}）｜ 目录：${project.path}`);
  lines.push(`未完成任务（${tasks.length}）：${tasks.length ? tasks.slice(0, 5).map((t) => `${t.id} ${t.status}${t.owner ? '/' + t.owner : ''} ${truncate(t.title, 30)}`).join('；') : '无'}`);
  lines.push(`锁：${locks.length ? locks.map((l) => l.key).join('、') : '无'}`);
  lines.push(`最近决定（${decisions.length}）：${decisions.length ? decisions.map((d) => `[${d.at || '-'}/${d.channel || '-'}] ${d.opinion}（来源：${d.source}）`).join('；') : '无（工作流.json 与 决策日志.md 均无记录）'}`);
  lines.push(`必读：${mustRead.join('、')}`);
  lines.push('纪律：先读必读再开工；ack=已回执 ≠ 已完成；完成要完成回执 + task done --evidence。');
  let text = lines.join('\n');
  if (Buffer.byteLength(text, 'utf8') > HANDOVER_MAX) {
    text = text.slice(0, HANDOVER_MAX - 30).replace(/\n[^\n]*$/, '') + '\n…（接任包超 2KB，已截断）';
  }
  return { text, bytes: Buffer.byteLength(text, 'utf8'), tasks: tasks.map((t) => t.id), locks: locks.map((l) => l.key), decisions: decisions.length, from: rot ? rot.from : '', to: rot ? rot.to : '' };
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
    const human = `轮次 · ${r.role}：${r.roundsSinceArchive}/${r.max}${r.lastArchiveAt ? ' ｜ 上次归档 ' + r.lastArchiveAt : ''}`;
    out(args, human, r);
    return;
  }
  if (action === 'transcript') {
    const r = exportTranscriptToProject({ projectName, sessionId: String(args.session || ''), role: String(args.role || '') });
    const human = r.transcript === 'ok'
      ? `转录 ${r.session}：${r.turns.length} 轮${r.file ? '（已落 ' + r.file + '）' : ''}`
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
    const boot = requireBoot(String(args.boot || ''));
    if (!['pm', 'owner'].includes(String(boot.role || ''))) fail('PERMISSION_DENIED', `只有 PM/Owner 能归档会话（当前 ${boot.role}）`);
    const self = Boolean(args.self);
    if (!self && !args.confirm) fail('CONFIRM_REQUIRED', '归档需显式 --confirm（或 PM --self 后 owner confirm --archive）');
    if (self && String(args.role || '') !== 'pm') fail('BAD_ARGS', '--self 只用于 PM 自归档');
    const r = archiveSession({ projectName, role: String(args.role || ''), reason: String(args.reason || ''), self, force: Boolean(args.force), operator: String(boot.role) });
    const human = `已归档 ${r.record.id}（${r.record.role}，rounds=${r.record.rounds}，nextSessionId=null，rotate 后回写）\n记录：${r.file}${r.decisionLog ? '\n决策日志：' + r.decisionLog + '（待 Owner confirm）' : ''}`;
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
      out(args, `首轮 token 采样 · ${r.role || '-'} ｜ session ${r.session}：${r.firstTurnInputTokens === null ? '未知' : r.firstTurnInputTokens}（${r.transcript}，sampledAt ${r.sampledAt}）`, { ok: true, ...r });
      return;
    }
    // 兼容：--threshold 旧语义=预警阈值；--warn 同义；--force 设强制阈值（默认 50 万）。
    const warnThreshold = Number(args.warn || args.threshold || DEFAULT_TOKEN_WARN);
    const forceThreshold = Number(args.force || DEFAULT_TOKEN_FORCE);
    const r = await sessionUsage({ projectName, role: String(args.role || ''), warnThreshold, forceThreshold });
    const lines = [`会话 token 用量 · ${projectName} ｜ DSH ${r.dshOk ? '可用' : '不可达（' + r.dshWhy + '）'} ｜ 预警 input ≥ ${r.warnThreshold} · 强制 input ≥ ${r.forceThreshold}`];
    lines.push('角色         会话                          未缓存输入    缓存读       output      total      状态');
    for (const row of r.rows) {
      const id = row.sessionId || '(无)';
      const fmt = (v) => (v === null ? '未知' : String(v));
      const state = row.force ? '⛔ 强制归档/换人' : (row.level === 'warn' ? '⚠ 预警' : (row.inputTokens === null ? '未知' : '正常'));
      lines.push(`${row.name.padEnd(10)} ${id.padEnd(30)} ${fmt(row.uncachedInputTokens).padStart(10)} ${fmt(row.cacheReadTokens).padStart(11)} ${fmt(row.outputTokens).padStart(11)} ${fmt(row.totalTokens).padStart(11)} ${state}`);
    }
    for (const row of r.rows.filter((x) => x.note && x.level !== 'unknown')) lines.push(`提示 · ${row.name}：${row.note}`);
    if (r.rows.some((x) => x.inputTokens === null)) lines.push('说明：无 DSH tokenUsage 时标“未知”，不按 0；input=uncachedInputTokens（未缓存输入），cacheRead 单列不计入预警。');
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
  if (action === 'handover') {
    const role = String(args.role || '');
    if (!role) fail('BAD_ROLE', '需要 --role');
    const r = buildHandover({ projectName, role, sessionId: String(args.session || '') });
    out(args, r.text, { ok: true, ...r });
    return;
  }
  if (action === 'rotate') {
    const role = String(args.role || '');
    if (!role) fail('BAD_ROLE', '需要 --role');
    const dryRun = Boolean(args['dry-run']);
    const record = await rotateSession({
      projectName,
      role,
      sessionId: String(args.session || ''),
      force: Boolean(args.force),
      offline: Boolean(args.offline),
      reason: String(args.reason || ''),
      by: String(args.by || 'owner'),
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
    out(args, lines.join('\n'), { ok: true, ...record, archiveWriteBack });
    return;
  }
  fail('BAD_ACTION', `会话命令只支持 usage | check | rotate | handover（收到 ${action || '(空)'}）`);
}
