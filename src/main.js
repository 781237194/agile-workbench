'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, session, screen, webContents } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const APP_ICON = path.join(ROOT, 'assets', 'pm-workbench.ico');
const APP_NAME = 'PM工作台';
const IS_SELFTEST = process.argv.includes('--selftest');
// 自测沙盘根：默认 .selftest-data；AWB_SELFTEST_ROOT 可让并行验证/CI 各自隔离，绝不碰真实状态。
const SELFTEST_ROOT = process.env.AWB_SELFTEST_ROOT
  ? path.resolve(process.env.AWB_SELFTEST_ROOT)
  : path.join(ROOT, '.selftest-data');
const LOCAL_DATA = process.env.AWB_DATA_DIR ? path.resolve(process.env.AWB_DATA_DIR) : path.join(ROOT, 'data');
// 默认数据与 Chromium 缓存都放在仓库内，不再落到 C:\Users\...\AppData。
// 自测时 Chromium/状态也进沙盘根，避免两个自测实例抢同一份 userdata。
const DATA_ROOT = IS_SELFTEST ? SELFTEST_ROOT : LOCAL_DATA;
const USER_DATA = path.join(DATA_ROOT, 'userdata');
const TEMP_ROOT = path.join(DATA_ROOT, 'tmp');
// DSH 地址持久化在仓库数据目录（D 盘），不写 C 盘、不写项目目录。
const DSH_CONFIG_FILE = path.join(DATA_ROOT, 'dsh.json');
fs.mkdirSync(LOCAL_DATA, { recursive: true });
fs.mkdirSync(USER_DATA, { recursive: true });
fs.mkdirSync(TEMP_ROOT, { recursive: true });

function normalizeDshBaseUrl(raw) {
  let text = String(raw == null ? '' : raw).trim();
  if (!text) {
    const error = new Error('DSH 地址不能为空');
    error.code = 'DSH_URL_REQUIRED';
    throw error;
  }
  if (!/^https?:\/\//i.test(text)) text = 'http://' + text;
  let url;
  try {
    url = new URL(text);
  } catch {
    const error = new Error('DSH 地址无效：' + String(raw).slice(0, 120));
    error.code = 'DSH_URL_INVALID';
    throw error;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    const error = new Error('DSH 地址必须是 http(s) 地址：' + String(raw).slice(0, 120));
    error.code = 'DSH_URL_INVALID';
    throw error;
  }
  return url.origin;
}

function readDshConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(DSH_CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
    if (!data || !data.baseUrl) return null;
    try {
      return { ...data, baseUrl: normalizeDshBaseUrl(data.baseUrl) };
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

function persistDshConfig(baseUrl) {
  const tmp = DSH_CONFIG_FILE + '.awb-tmp-' + process.pid + '-' + crypto.randomUUID().slice(0, 8);
  const body = JSON.stringify({ version: 1, baseUrl: String(baseUrl), updatedAt: new Date().toISOString() }, null, 2) + '\n';
  fs.mkdirSync(path.dirname(DSH_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    fs.renameSync(tmp, DSH_CONFIG_FILE);
  } catch {
    fs.copyFileSync(tmp, DSH_CONFIG_FILE);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
  return DSH_CONFIG_FILE;
}

const SAVED_DSH_URL = (() => {
  try { return readDshConfig()?.baseUrl || ''; } catch { return ''; }
})();
app.setPath('userData', USER_DATA);
app.setPath('sessionData', USER_DATA);
app.setPath('temp', TEMP_ROOT);
// 自测隔离：store 和团队状态都落在沙盘根，不碰真实团队状态与用户项目。
if (IS_SELFTEST) {
  process.env.AWB_STORE = path.join(SELFTEST_ROOT, 'workbench.json');
  process.env.TEAM_ROOT = path.join(SELFTEST_ROOT, '团队');
}

const { DshAdapter, discoverDshWeb } = require('./dsh-adapter');
// 自测会把 teamTools 换成一个带 mock 旧协议命令的实例；生产始终保持默认工具。
let teamTools = require('./team-tools');
const APP_VERSION = require(path.join(ROOT, 'package.json')).version;

async function syncTeamProject(project, options = {}) {
  try {
    // engineUrl 只用于把 workspace.json 的 engineUrl 写成同一个 DSH；ensure 本身不依赖 DSH。
    const engineUrl = String(options.engineUrl || dsh.baseUrl || '').trim();
    // 状态库已确定的团队名显式传给工具，禁止 ensure 因旧登记冲突静默改名。
    const ensuredOptions = { name: String(project.teamName || project.name || '') };
    if (engineUrl) ensuredOptions.engineUrl = engineUrl;
    // 项目创建/恢复/启动统一走 ensureProjectReady：旧 workspace ensure + 六角色目录 +
    // 项目信息/铁律/协作准则/项目索引；缺一项就返回结构化失败，不能把半成品项目当成功。
    const result = await teamTools.ensureProjectReady(project, ensuredOptions);
    return result.ok ? result : { ...result, ok: false, why: result.why || result.message };
  } catch (e) {
    return { ok: false, code: 'TEAM_INTERNAL', why: String(e && e.message || e).slice(0, 500) };
  }
}

/** 旧版 team:launch / team:restore 的回填：把本次真实创建的会话记回状态库（dry-run 不写）。 */
function persistTeamLaunch(projectId, result) {
  if (!projectId || !result) return;
  const sessions = Array.isArray(result.sessions) ? result.sessions : [];
  if (!sessions.length) return;
  persistSessionMapping(projectId, sessions, {
    workspaceId: result.workspaceId,
    workspacePath: result.workspace,
    teamName: result.name,
    sessionIds: sessions.map((session) => session.sessionId).filter(Boolean),
    event: `${result.restore ? '恢复' : '启动'}团队会话：${sessions.length} 个${result.ok ? '' : '（有错误）'}`
  });
  if (result.workspace && result.workspaceId) {
    teamTools.recordWorkspaceBinding(result.workspace, { workspaceId: result.workspaceId, engineUrl: result.engineUrl });
  }
}
const ROLES = [
  { id: 'pm', name: '项目经理', dir: '项目经理', scope: '项目根 + 项目经理/', color: '#d8a84e' },
  { id: 'product', name: '产品设计师', dir: '产品', scope: '产品/', color: '#7eb6ff' },
  { id: 'analyst', name: '需求分析师', dir: '需求分析师', scope: '需求分析师/', color: '#9d8cff' },
  { id: 'programmer1', name: '高级程序员 A', dir: '程序员A', scope: 'src/ + 程序员A/', color: '#64d7b0' },
  { id: 'programmer2', name: '高级程序员 B', dir: '程序员B', scope: 'src/ + 程序员B/', color: '#58c7c9' },
  { id: 'tester', name: '测试人员', dir: '测试人员', scope: '测试人员/', color: '#e39b8e' }
];
// 团队模式：project.teamMode='full'|'fast'，默认 full。
// Fast 只有 pm/analyst/programmer1/tester：不建 product/programmer2 会话与目录，
// 需求由 analyst 评审，Owner 之后增加 programmer1 的开发技术评审。
const TEAM_MODES = [
  {
    id: 'full',
    label: '完整模式',
    roleIds: ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester']
  },
  {
    id: 'fast',
    label: '快速模式',
    roleIds: ['pm', 'analyst', 'programmer1', 'tester']
  }
];
const DEFAULT_TEAM_MODE = 'full';
const TEAM_MODE_BY_ID = new Map(TEAM_MODES.map((mode) => [mode.id, mode]));

function normalizeTeamMode(value) {
  const raw = typeof value === 'string'
    ? value
    : (value && typeof value === 'object' ? (value.teamMode || value.mode) : '');
  return String(raw || '').toLowerCase() === 'fast' ? 'fast' : DEFAULT_TEAM_MODE;
}

/** 只读团队模式原值：有效 fast/full 返回值，缺失/非法返回空串（供优先级回退）。 */
function readTeamModeValue(value) {
  const raw = typeof value === 'string'
    ? value
    : (value && typeof value === 'object' ? (value.teamMode || value.mode) : '');
  const text = String(raw == null ? '' : raw).trim().toLowerCase();
  return text === 'fast' || text === 'full' ? text : '';
}

/**
 * Owner 决定/验收、workflow iterate/terminate 都可能由壳层收口：
 * 旧 team.mjs 把 owner / workflow 标成 NOT_IMPLEMENTED。Fast 早就是壳层收口，
 * Full 也不能因为同两条命令缺失把整条 Owner 评审/验收/迭代/终止链卡死。
 *
 * 如实区分两件事，不伪造旧命令存在：
 *   - 动作可用 → shellOwnedActions（UI 的能力闸门只认这里和 caps.commands）；
 *   - 旧命令存在 → commands.* / commandImplemented / legacyCommandAvailable 保持真实探测值。
 */
function capabilitiesWithShellOwnedCloseout(caps, teamMode) {
  if (!caps) return caps;
  const mode = normalizeTeamMode(teamMode);
  const commands = { ...(caps.commands || {}) };
  const ownerCommand = commands.owner === true;
  const workflowCommand = commands.workflow === true;
  // Fast 的 Owner 一直是壳层收口（历史契约）；Full 只在旧 owner 命令真缺失时收口。
  const shellOwner = mode === 'fast' ? true : !ownerCommand;
  // 迭代/终止：两种模式同一条规则——旧 workflow 命令缺失就由壳层推进。
  const shellWorkflow = !workflowCommand;
  if (!shellOwner && !shellWorkflow) return caps;
  const shellOwned = new Set(Array.isArray(caps.shellOwned) ? caps.shellOwned : []);
  const shellOwnedActions = new Set(Array.isArray(caps.shellOwnedActions) ? caps.shellOwnedActions : []);
  const actionSource = { ...(caps.actionSource || {}) };
  const commandSource = { ...(caps.commandSource || {}) };
  const legacyCommandAvailable = { ...(caps.legacyCommandAvailable || {}) };
  if (shellOwner) {
    commands.owner = true;
    shellOwned.add('owner');
    for (const action of ['owner-review', 'owner-accept']) {
      shellOwnedActions.add(action);
      actionSource[action] = `workbench-${mode}-owner`;
    }
    commandSource.owner = `workbench-${mode}-owner`;
    legacyCommandAvailable.owner = false;
  }
  if (shellWorkflow) {
    for (const action of ['iterate', 'terminate']) {
      shellOwnedActions.add(action);
      actionSource[action] = `workbench-${mode}-workflow`;
    }
    legacyCommandAvailable.workflow = false;
  }
  return {
    ...caps,
    commands,
    missing: (Array.isArray(caps.missing) ? caps.missing : []).filter((name) => !(shellOwner && name === 'owner')),
    optionalMissing: (Array.isArray(caps.optionalMissing) ? caps.optionalMissing : []).filter((name) => !(shellOwner && name === 'owner')),
    shellOwned: [...shellOwned],
    shellOwnedCommands: shellOwner
      ? [...new Set([...(Array.isArray(caps.shellOwnedCommands) ? caps.shellOwnedCommands : []), 'owner'])]
      : [...(caps.shellOwnedCommands || [])],
    shellOwnedActions: [...shellOwnedActions],
    actionSource,
    commandSource,
    legacyCommandAvailable
  };
}

function applyShellOwnedCapsToSnapshot(snapshot, teamMode) {
  if (!snapshot || !snapshot.legacy) return snapshot;
  const caps = capabilitiesWithShellOwnedCloseout(snapshot.legacy.capabilities, teamMode);
  if (caps === snapshot.legacy.capabilities) return snapshot;
  return {
    ...snapshot,
    legacy: {
      ...snapshot.legacy,
      capabilities: caps,
      missingCommands: caps.missing,
      optionalMissing: caps.optionalMissing,
      shellOwned: caps.shellOwned
    }
  };
}

function roleIdsForTeamMode(value) {
  return (TEAM_MODE_BY_ID.get(normalizeTeamMode(value)) || TEAM_MODE_BY_ID.get(DEFAULT_TEAM_MODE)).roleIds.slice();
}

function roleIdsForProject(project) {
  return roleIdsForTeamMode(project && project.teamMode);
}
// 六会话通信链：一条派单必须能回答 delivered / wake / read / ack 四段状态。
// read/ack 的“角色自己执行”只能由旧协议现场（邮箱 new→cur、回执.jsonl 新增）证明。
const COMM_PARTS = ['delivered', 'wake', 'read', 'ack'];
const COMM_WAKE_STEPS = ['boot', 'inbox', 'read', 'ack'];
const COMM_DONE_STATES = { delivered: 'delivered', wake: 'sent', read: 'read', ack: 'acked' };
const COMM_RECONCILE_CACHE_MS = 1000;
const LEGACY_REVIEW_ACTIONS = ['propose', 'show', 'review', 'sign', 'apply'];
const STAGES = [
  { id: 'intake', label: '接单' },
  { id: 'requirement', label: '需求' },
  { id: 'review', label: '产品评审' },
  { id: 'owner', label: 'Owner 评审' },
  { id: 'dispatch', label: '派发' },
  { id: 'dev', label: '开发' },
  { id: 'test', label: '测试' },
  { id: 'close', label: '收口' }
];
const ACK_TTL_MS = 10 * 60 * 1000;
const TASK_STATUSES = ['todo', 'doing', 'review', 'done'];

// ==========================================================================
// 项目 ↔ DSH workspace ↔ 角色会话 映射
//
// 单一真相在状态库 workbench.json（data/userdata/workbench.json）：
//   project.workspace = { id, path, name, bound, pending, boundAt, lastError }
//   project.sessions  = { roleId: sessionId }（兼容旧字段）
//   project.sessionMeta = { roleId: { title, reused, seeded, updatedAt } }
// 旧工具侧镜像：<项目目录>/workspace.json（dshWorkspaceId）、团队会话.json，
// 以及 <团队>/状态/当前工作区.json（只做“现在在哪个项目”的指针）。
// 不新增独立映射文件，避免出现第二份真相。
// ==========================================================================
const ROLE_BY_ID = new Map(ROLES.map((role) => [role.id, role]));
const SESSION_TITLE_PREFIX = '团队·';

function roleTitle(roleId) {
  const role = ROLE_BY_ID.get(roleId);
  return SESSION_TITLE_PREFIX + ((role && role.name) || roleId);
}

function workspaceOf(project) {
  const raw = project && project.workspace && typeof project.workspace === 'object' ? project.workspace : {};
  const id = raw.id || (project && project.dshWorkspaceId) || null;
  const lastError = raw.lastError && typeof raw.lastError === 'object' ? raw.lastError : null;
  return {
    id: id ? String(id) : null,
    path: raw.path || (project && project.workspacePath) || (project && project.path) || null,
    name: raw.name || (project && project.teamName) || (project && project.name) || null,
    engineUrl: raw.engineUrl || null,
    bound: Boolean(id),
    pending: Boolean(raw.pending),
    created: raw.created === undefined ? null : Boolean(raw.created),
    boundAt: raw.boundAt || null,
    // 上次 workspace/create 返回的成员会话快照；team-status 只读核对时用它做“是否仍在工作区”。
    sessionIds: Array.isArray(raw.sessionIds) ? raw.sessionIds.map(String) : [],
    lastError: lastError ? {
      code: String(lastError.code || ''),
      message: String(lastError.message || '').slice(0, 300),
      at: lastError.at || null
    } : null
  };
}

/** 完整的 项目 → 工作区 → 六角色会话 映射（只读视图，随 app:state 返回）。 */
function publicMapping(project) {
  if (!project) return null;
  const workspace = workspaceOf(project);
  const meta = project.sessionMeta && typeof project.sessionMeta === 'object' ? project.sessionMeta : {};
  const teamMode = normalizeTeamMode(project.teamMode);
  // 映射只暴露当前团队模式的角色：Fast 不把 product/programmer2 算进完成度。
  const roleIds = roleIdsForTeamMode(teamMode);
  const sessions = roleIds.map((roleId) => {
    const role = ROLE_BY_ID.get(roleId) || { id: roleId, name: roleId };
    const sessionId = project.sessions && project.sessions[roleId] ? String(project.sessions[roleId]) : null;
    const info = meta[roleId] && typeof meta[roleId] === 'object' ? meta[roleId] : null;
    return {
      role: roleId,
      name: role.name,
      // 会话标题统一 团队·角色；不信任旧记录里的“项目 · 角色”缓存。
      title: sessionId ? roleTitle(roleId) : ((info && info.title) || ''),
      sessionId,
      bound: Boolean(sessionId),
      reused: info ? Boolean(info.reused) : null,
      updatedAt: (info && info.updatedAt) || null
    };
  });
  return {
    projectId: project.id || null,
    projectName: project.name || '',
    projectPath: project.path || '',
    teamName: project.teamName || null,
    teamMode,
    roleIds,
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    workspaceBound: workspace.bound,
    workspacePending: workspace.pending,
    workspaceError: workspace.lastError,
    sessionCount: sessions.filter((session) => session.sessionId).length,
    roleCount: roleIds.length,
    complete: sessions.every((session) => Boolean(session.sessionId)),
    sessions
  };
}

/** 只写映射相关字段；重新读库合并，避免并发 launch/provision 互相覆盖。 */
function persistProjectWorkspace(projectId, workspace, extra = {}) {
  if (!projectId) return null;
  const fresh = readStore();
  const current = fresh.projects.find((project) => project.id === projectId);
  if (!current) return null;
  current.workspace = {
    ...(current.workspace && typeof current.workspace === 'object' ? current.workspace : {}),
    ...(workspace || {})
  };
  if (current.workspace.id) {
    current.dshWorkspaceId = String(current.workspace.id);
    current.workspacePath = current.workspace.path || current.path;
  }
  if (extra.engineUrl) current.workspace.engineUrl = String(extra.engineUrl);
  if (current.workspace.name) current.teamName = current.teamName || String(current.workspace.name);
  if (current.workspace.bound && !current.workspace.pending) {
    addEvent(current, `${current.workspace.created ? '新建并绑定' : '绑定'} DSH 工作区：${current.workspace.id}`);
  } else if (current.workspace.pending) {
    addEvent(current, `DSH 工作区绑定待重试：${(current.workspace.lastError && current.workspace.lastError.code) || 'DSH_OFFLINE'}`);
  }
  writeStore(fresh);
  return current;
}

/**
 * 切换项目团队模式（full/fast）。
 * 只改 project.teamMode，不删除已有 DSH 会话/目录；后续建团队/恢复按新 roleIds 执行。
 * 模式真相还要落到旧工具：workspace.mjs ensure --team-mode 会写 项目.json + workspace.json。
 * 返回最新项目记录；项目不存在返回 null。
 */
async function setProjectTeamMode(projectId, teamMode) {
  if (!projectId) return null;
  const mode = normalizeTeamMode(teamMode);
  const fresh = readStore();
  const current = fresh.projects.find((project) => project.id === projectId);
  if (!current) return null;
  if (normalizeTeamMode(current.teamMode) === mode) return current;
  const previous = normalizeTeamMode(current.teamMode);
  current.teamMode = mode;
  // Fast 切换后旧的 product/programmer2 会话映射不再属于当前团队；清映射但不动 DSH 会话。
  if (mode === 'fast') {
    const allowed = new Set(roleIdsForTeamMode(mode));
    for (const key of Object.keys(current.sessions || {})) {
      if (!allowed.has(key)) delete current.sessions[key];
    }
    for (const key of Object.keys(current.sessionMeta || {})) {
      if (!allowed.has(key)) delete current.sessionMeta[key];
    }
  }
  addEvent(current, `团队模式切换：${previous} → ${mode}`);
  writeStore(fresh);
  syncTeamRosterSessions(current.sessions || {}, { projectName: current.teamName || current.name, teamMode: mode });
  // 切模式也要通过旧工具现有接口落 项目.json/workspace.json；失败不阻断本地切换，
  // 但必须回写事件，下一次建团队/恢复会再 ensure 一次。
  let legacySync = null;
  try {
    legacySync = await teamTools.ensureProjectReady(
      { ...current, teamMode: mode },
      { name: current.teamName || current.name, engineUrl: dsh.baseUrl, teamMode: mode }
    );
  } catch (error) {
    legacySync = { ok: false, code: (error && error.code) || 'TEAM_MODE_SYNC_FAILED', message: String((error && error.message) || error).slice(0, 300) };
  }
  const after = readStore();
  const row = after.projects.find((project) => project.id === projectId) || current;
  if (legacySync && legacySync.ok) {
    if (legacySync.name) row.teamName = legacySync.name;
    addEvent(row, `团队模式已同步旧工具：${mode}`);
  } else {
    addEvent(row, `团队模式同步旧工具失败：${(legacySync && legacySync.code) || 'TEAM_MODE_SYNC_FAILED'}`);
  }
  if (after.projects.some((project) => project.id === projectId)) writeStore(after);
  return row;
}

function syncTeamRosterSessions(sessions, options = {}) {
  try {
    const teamRoot = (teamTools && teamTools.layout && teamTools.layout.teamRoot) || process.env.TEAM_ROOT || path.join(ROOT, '团队');
    const teamFile = path.join(teamRoot, '状态', '团队.json');
    if (!fs.existsSync(teamFile) || !sessions) return;
    const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
    if (!Array.isArray(team.members)) return;
    const current = sessions && typeof sessions === 'object' ? sessions : {};
    const projectName = String(options.projectName || options.teamName || '').trim();
    const roleIds = roleIdsForTeamMode(options.teamMode);
    const roleSet = new Set(roleIds);
    let changed = false;
    // 名册是“当前项目”的快照：本项目没有的角色必须清空 sessionId。
    // 旧实现只改有值角色，切到没建团队的项目 B 时会把 A 的会话留在名册里。
    if (projectName && team.activeProject !== projectName) {
      team.activeProject = projectName;
      changed = true;
    }
    for (const member of team.members) {
      const id = roleSet.has(member.role) && current[member.role] ? String(current[member.role]) : '';
      if (String(member.sessionId || '') !== id) {
        member.sessionId = id;
        changed = true;
      }
    }
    for (const role of roleIds) {
      if (!current[role] || team.members.some((member) => member.role === role)) continue;
      const roleInfo = ROLE_BY_ID.get(role) || { name: role };
      team.members.push({ role, name: roleInfo.name, status: 'active', joinedAt: now(), sessionId: String(current[role]) });
      changed = true;
    }
    if (changed) fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
    return { ok: true, changed, activeProject: team.activeProject || null };
  } catch { /* 名册同步失败不阻断会话映射 */ }
}

function persistSessionMapping(projectId, sessions, extra = {}) {
  if (!projectId || !Array.isArray(sessions)) return null;
  const fresh = readStore();
  const current = fresh.projects.find((project) => project.id === projectId);
  if (!current) return null;
  current.sessions = { ...(current.sessions || {}) };
  current.sessionMeta = { ...(current.sessionMeta || {}) };
  let changed = 0;
  for (const session of sessions) {
    if (!session || !session.role || !session.sessionId) continue;
    if (current.sessions[session.role] !== session.sessionId) changed += 1;
    current.sessions[session.role] = String(session.sessionId);
    current.sessionMeta[session.role] = {
      // 标题真相固定为 团队·角色；不改写工具返回的 title 字段做展示缓存。
      title: roleTitle(session.role),
      reused: Boolean(session.reused),
      seeded: Boolean(session.seeded),
      updatedAt: now()
    };
  }
  // 映射只允许当前团队模式的角色，防止把“额外会话”悄悄写进项目。
  // Fast 模式会清掉 product/programmer2 的旧映射（不删除 DSH 会话本身）。
  const modeRoleIds = new Set(roleIdsForProject(current));
  for (const key of Object.keys(current.sessions)) if (!modeRoleIds.has(key)) delete current.sessions[key];
  for (const key of Object.keys(current.sessionMeta)) if (!modeRoleIds.has(key)) delete current.sessionMeta[key];
  // workspace 绑定只接受“属于当前项目目录”的候选；旧 团队会话.json 可能把
  // A 项目的 workspaceId 带进来，路径不一致时宁可不绑，等 DSH 按 path 重新核验。
  const projectPathForBinding = current.path ? path.resolve(String(current.path)) : '';
  const candidateWorkspacePath = extra.workspacePath ? path.resolve(String(extra.workspacePath)) : projectPathForBinding;
  const existingWorkspacePath = current.workspace && current.workspace.path ? path.resolve(String(current.workspace.path)) : '';
  const workspacePathTrusted = Boolean(projectPathForBinding)
    && sameResolvedPath(candidateWorkspacePath, projectPathForBinding)
    && (!existingWorkspacePath || sameResolvedPath(existingWorkspacePath, projectPathForBinding));
  const acceptedWorkspaceId = workspacePathTrusted && extra.workspaceId ? String(extra.workspaceId) : '';
  if ((extra.workspaceId || extra.workspacePath || extra.teamName)) {
    current.workspace = {
      ...(current.workspace && typeof current.workspace === 'object' ? current.workspace : {}),
      ...(acceptedWorkspaceId ? { id: acceptedWorkspaceId } : {}),
      ...(extra.workspacePath && workspacePathTrusted ? { path: String(extra.workspacePath) } : {}),
      ...(extra.teamName ? { name: String(extra.teamName) } : {}),
      ...(Array.isArray(extra.sessionIds) ? { sessionIds: extra.sessionIds.map(String) } : {})
    };
    if (acceptedWorkspaceId) {
      current.dshWorkspaceId = acceptedWorkspaceId;
      current.workspacePath = current.workspace.path || current.path;
      current.workspace.bound = true;
      current.workspace.pending = false;
      current.workspace.boundAt = now();
      current.workspace.lastError = null;
    } else if (extra.workspaceId || extra.workspacePath) {
      addEvent(current, '忽略与项目路径不一致的 workspace 绑定（跨项目清单污染已拦截）');
    }
  }
  if (extra.teamName) current.teamName = String(extra.teamName);
  if (extra.event) addEvent(current, extra.event);
  else if (changed) addEvent(current, `角色会话映射更新：${changed} 个`);
  writeStore(fresh);
  syncTeamRosterSessions(current.sessions, { projectName: current.teamName || current.name, teamMode: current.teamMode });
  return current;
}

/**
 * 绑定/创建 DSH 工作区（workspace/create 按目录幂等）。
 * DSH 离线/超时不会拦住项目创建：记成 pending，切项目/启动团队时自动重试；
 * 错误码原样保留（DSH_OFFLINE / DSH_TIMEOUT / DSH_NOT_CONFIGURED / DSH_AUTH_MISSING ...）。
 */
async function bindProjectWorkspace(project, options = {}) {
  const engineUrl = String(options.engineUrl || dsh.baseUrl || '').trim();
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 6000;
  const projectPath = path.resolve(String(project.path || ''));
  const current = workspaceOf(project);
  // 旧记录/旧清单可能把 workspace 绑到别的目录：即使 bound=true 也必须核对 path。
  const currentPath = current.path ? path.resolve(String(current.path)) : '';
  const pathMatches = Boolean(currentPath) && sameResolvedPath(currentPath, projectPath);
  const rebind = Boolean(current.id) && !pathMatches;
  if (!options.force && current.bound && !current.pending && pathMatches) {
    return { ok: true, code: 'WORKSPACE_ALREADY_BOUND', workspaceId: current.id, sessionIds: [], created: false, workspace: current, engineUrl, pathMatches };
  }
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    return { ok: false, code: 'PROJECT_DIR_MISSING', message: '项目目录不存在：' + projectPath, workspace: current, engineUrl, pathMatches, rebind };
  }
  try {
    const value = await dsh.ensureWorkspace(projectPath, { timeoutMs });
    const workspace = {
      id: String(value.workspaceId),
      path: projectPath,
      name: project.teamName || project.name,
      engineUrl: engineUrl || null,
      bound: true,
      pending: false,
      created: Boolean(value.created),
      boundAt: now(),
      sessionIds: Array.isArray(value.sessionIds) ? value.sessionIds.map(String) : [],
      lastError: null
    };
    persistProjectWorkspace(project.id, workspace, { engineUrl });
    const meta = teamTools.recordWorkspaceBinding(projectPath, { workspaceId: workspace.id, engineUrl });
    return {
      ok: true,
      code: 'OK',
      workspaceId: workspace.id,
      sessionIds: value.sessionIds,
      created: Boolean(value.created),
      workspace,
      engineUrl,
      meta,
      rebind,
      previousWorkspaceId: rebind ? current.id : null,
      pathMatches: true
    };
  } catch (error) {
    const code = String((error && error.code) || 'DSH_WORKSPACE_FAILED');
    const message = String((error && error.message) || error).slice(0, 300);
    const workspace = { ...current, path: path.resolve(projectPath), bound: false, pending: true, lastError: { code, message, at: now() } };
    persistProjectWorkspace(project.id, workspace, { engineUrl });
    return { ok: false, code, message, workspace, engineUrl, pathMatches, rebind };
  }
}

/**
 * 会话归属核对：本地记录的 sessionId 不是真相。
 * 工作区会话集合来自 workspace/create 的 sessionIds；不在集合里、但 cwd 一致的旧会话仍可让
 * launch.mjs 按标题复用，所以这里只做“已验证/待补建”分类，不删任何 DSH 会话。
 */
function sessionWorkspaceId(session) {
  if (!session || typeof session !== 'object') return '';
  return String(session.workspaceId || (session.workspace && session.workspace.workspaceId) || '');
}

function sessionTitleOf(session) {
  return String((session && session.projections && session.projections.values && session.projections.values.title) || '');
}

/**
 * 只读核对六个角色会话，并返回可用于修复的分类：
 *   reused    记录里的 sessionId 真实存在且属于本工作区（或旧项目没有成员快照时 cwd 一致）
 *   missing   没有记录/记录失效，需要补建或按标题接管
 *   blank     存在但从未产生对话，需要补 seed
 *   stale     记录失效（DSH 里没有、或已不在本工作区）
 *   ghost     记录存在但已不属于本工作区（工作区重建/手动移动）
 *   duplicates 同一工作区里出现多条 团队·角色 会话
 * 工作区成员以 workspace/create 返回的 sessionIds 快照为准；cwd 只报疑似，不冒充成员。
 */
async function inspectProjectSessions(project, binding = {}) {
  const workspacePath = path.resolve(String((binding.workspace && binding.workspace.path) || project.path || ''));
  // 只核对当前团队模式的角色：Fast 不能因为“缺产品/程序员B”去补建会话。
  const roleIds = roleIdsForProject(project);
  const remote = await dsh.listSessions({ timeoutMs: 8000 });
  const byId = new Map(remote.map((session) => [String(session.sessionId), session]));
  const recordedMembership = (project.workspace && Array.isArray(project.workspace.sessionIds)) ? project.workspace.sessionIds.map(String) : [];
  const inWorkspace = new Set([...(binding.sessionIds || []).map(String), ...recordedMembership]);
  const recordedWorkspaceId = String((binding.workspace && binding.workspace.id) || (project.workspace && project.workspace.id) || '');
  const membershipKnown = inWorkspace.size > 0;
  const scoped = (session) => {
    if (!session) return false;
    const sid = String(session.sessionId);
    if (inWorkspace.has(sid)) return true;
    const wsid = sessionWorkspaceId(session);
    if (wsid && recordedWorkspaceId) return wsid === recordedWorkspaceId;
    return false;
  };
  const cwdSame = (session) => {
    const cwd = session && session.cwd ? path.resolve(String(session.cwd)) : '';
    return Boolean(cwd) && cwd.toLowerCase() === workspacePath.toLowerCase();
  };
  const reused = [];
  const missing = [];
  const blank = [];
  const stale = [];
  const ghost = [];
  const renamed = [];
  const duplicates = [];
  for (const roleId of roleIds) {
    const sessionId = project.sessions && project.sessions[roleId] ? String(project.sessions[roleId]) : '';
    const remoteSession = sessionId ? byId.get(sessionId) : null;
    const here = Boolean(remoteSession) && !remoteSession.archived
      && (scoped(remoteSession) || (!membershipKnown && cwdSame(remoteSession)));
    if (!sessionId || !remoteSession || !here) {
      if (sessionId && remoteSession && !here) ghost.push({ role: roleId, sessionId });
      else if (sessionId) stale.push({ role: roleId, sessionId });
      missing.push(roleId);
      continue;
    }
    if (remoteSession.blank) blank.push(roleId);
    const title = roleTitle(roleId);
    const current = sessionTitleOf(remoteSession);
    if (current !== title) {
      try {
        await dsh.rename(sessionId, title);
        renamed.push({ role: roleId, sessionId, from: current, to: title });
      } catch { /* 标题失败不阻断复用判断 */ }
    }
    reused.push(roleId);
  }
  // 同一工作区里同名的 团队·角色 会话：保留映射（或最早一条），其余列为重复。
  for (const roleId of roleIds) {
    const expected = roleTitle(roleId);
    const candidates = remote.filter((session) => {
      if (session.archived || sessionTitleOf(session) !== expected) return false;
      if (scoped(session)) return true;
      return !membershipKnown && cwdSame(session);
    });
    if (candidates.length <= 1) continue;
    const recorded = project.sessions && project.sessions[roleId] ? String(project.sessions[roleId]) : '';
    const keep = candidates.find((session) => String(session.sessionId) === recorded) || candidates[0];
    const extras = candidates.filter((session) => String(session.sessionId) !== String(keep.sessionId));
    duplicates.push({
      role: roleId,
      title: expected,
      keep: String(keep.sessionId),
      extras: extras.map((session) => ({ sessionId: String(session.sessionId), blank: Boolean(session.blank), archived: Boolean(session.archived) }))
    });
  }
  return {
    remoteCount: remote.length,
    remote,
    reused,
    missing,
    blank,
    stale,
    ghost,
    duplicates,
    renamed,
    workspacePath,
    inWorkspace,
    membershipKnown,
    cwdMatches: remote.filter((session) => cwdSame(session)).map((session) => String(session.sessionId)),
  };
}

/**
 * 修复：把同角色重复/幽灵会话归档，只保留一条本工作区内的 团队·角色 会话。
 * 只碰标题严格等于 团队·角色 的会话；用户自建“临时会话”、其它标题一律不动。
 */
async function repairRoleSessionDuplicates(project, inspection) {
  const actions = [];
  const archived = [];
  const seen = new Set();
  for (const duplicate of inspection.duplicates || []) {
    for (const extra of duplicate.extras) {
      if (!extra.sessionId || seen.has(extra.sessionId)) continue;
      seen.add(extra.sessionId);
      try {
        await dsh.archiveSession(extra.sessionId);
        archived.push(extra.sessionId);
        actions.push({ role: duplicate.role, sessionId: extra.sessionId, action: 'archived_duplicate', keep: duplicate.keep });
      } catch (error) {
        actions.push({ role: duplicate.role, sessionId: extra.sessionId, action: 'archive_failed', why: String(error && error.message || error).slice(0, 160) });
      }
    }
  }
  // 记录里指向“已不在本工作区”的旧会话：如果已经能按标题接管/补建，旧会话归档，避免永久幽灵。
  for (const ghost of inspection.ghost || []) {
    if (!ghost.sessionId || archived.includes(ghost.sessionId) || seen.has(ghost.sessionId)) continue;
    const remoteSession = (inspection.remote || []).find((session) => String(session.sessionId) === String(ghost.sessionId));
    const title = sessionTitleOf(remoteSession);
    // 只归档确实是角色会话的幽灵；用户在别的工作区的普通会话不碰。
    if (!title.startsWith(SESSION_TITLE_PREFIX)) continue;
    seen.add(ghost.sessionId);
    try {
      await dsh.archiveSession(ghost.sessionId);
      archived.push(ghost.sessionId);
      actions.push({ role: ghost.role, sessionId: ghost.sessionId, action: 'archived_ghost' });
    } catch (error) {
      actions.push({ role: ghost.role, sessionId: ghost.sessionId, action: 'archive_failed', why: String(error && error.message || error).slice(0, 160) });
    }
  }
  if (archived.length && project.id) {
    try {
      const fresh = readStore();
      const current = fresh.projects.find((item) => item.id === project.id);
      if (current && current.workspace && Array.isArray(current.workspace.sessionIds)) {
        current.workspace.sessionIds = current.workspace.sessionIds.filter((sid) => !archived.includes(String(sid)));
        addEvent(current, `归档重复/幽灵角色会话：${archived.length} 个`);
        writeStore(fresh);
      }
    } catch { /* 快照清理失败不阻断会话修复 */ }
  }
  return { archived, actions };
}

/**
 * 切换项目 = 切换工作区：
 *   1) 必要时补团队登记；2) 绑定/重试 DSH workspace；3) 旧协议 project use 切当前项目；
 *   4) 写旧协议“当前工作区”指针。任何一步失败都进 warnings，不拦住本地切换。
 */
async function activateWorkspace(project, options = {}) {
  const warnings = [];
  // 旧记录/重新登记的项目：先用团队会话.json 恢复角色→会话线索（启动团队时再向 DSH 核验）。
  if ((!project.sessions || !Object.keys(project.sessions).length) && project.id) {
    const restored = sessionsFromManifest(project.path);
    if (restored.ok) {
      persistSessionMapping(project.id, restored.sessions, {
        workspacePath: restored.workspacePath || project.path,
        event: '从团队会话.json 恢复角色会话映射（workspace 待 DSH 核验）'
      });
      project = requireProject(readStore(), project.id);
    } else if (restored.code === 'MANIFEST_WORKSPACE_MISMATCH') {
      warnings.push({ code: restored.code, message: restored.message });
      // 清单不属于本目录：不写映射，但记录事件方便排障。
      const fresh = readStore();
      const current = fresh.projects.find((item) => item.id === project.id);
      if (current) {
        addEvent(current, '团队会话.json 与项目路径不一致，已拒绝恢复');
        writeStore(fresh);
      }
    }
  }
  let teamName = String(project.teamName || '').trim();
  if (!teamName) {
    const ensured = await syncTeamProject(project, { engineUrl: dsh.baseUrl });
    if (ensured.ok) teamName = String(ensured.name || '');
    else warnings.push({ code: ensured.code || 'TEAM_ENSURE_FAILED', message: ensured.message || ensured.why || '团队项目登记失败' });
  }
  const binding = await bindProjectWorkspace({ ...project, teamName }, { engineUrl: dsh.baseUrl, timeoutMs: options.timeoutMs || 5000 });
  if (!binding.ok) warnings.push({ code: binding.code || 'DSH_WORKSPACE_FAILED', message: binding.message || 'DSH 工作区绑定失败' });
  const name = teamName || project.teamName || project.name;
  if (fs.existsSync(teamTools.layout.teamFile) && name) {
    // 没有 PM 会话时不抢跑旧协议 project use（避免 boot 写 session-unknown）；
    // 建团队成功后会由 provision 用真实 PM sessionId 切换当前项目。
    const pmSession = project.sessions && project.sessions.pm ? String(project.sessions.pm) : '';
    if (pmSession) {
      const activated = await teamTools.activateProject(name, pmSession);
      if (!activated.ok) warnings.push({ code: activated.code || 'TEAM_ACTIVATE_FAILED', message: activated.message || '切换团队当前项目失败' });
    }
  }
  const workspace = workspaceOf({ ...project, teamName: name, workspace: binding.workspace });
  const record = {
    version: 1,
    name: project.name,
    path: path.resolve(String(project.path)),
    projectId: project.id || null,
    teamName: name || null,
    dshWorkspaceId: workspace.id,
    engineUrl: dsh.baseUrl || null,
    bound: Boolean(workspace.id) && !workspace.pending,
    updatedAt: now()
  };
  const wrote = teamTools.setCurrentWorkspace(record);
  if (!wrote.ok) warnings.push({ code: wrote.code || 'CURRENT_WORKSPACE_WRITE_FAILED', message: wrote.message || '写当前工作区失败' });
  if (teamName && teamName !== project.teamName) {
    const fresh = readStore();
    const current = fresh.projects.find((item) => item.id === project.id);
    if (current) {
      current.teamName = teamName;
      writeStore(fresh);
    }
  }
  // ensureProject/activate 都可能移动旧协议 activeProject；名册 sessionId 跟着当前项目走。
  try {
    const current = requireProject(readStore(), project.id);
    if (current.sessions) syncTeamRosterSessions(current.sessions, { projectName: name || current.teamName || current.name, teamMode: current.teamMode });
    else syncTeamRosterSessions({}, { projectName: name || current.teamName || current.name, teamMode: current.teamMode });
  } catch { /* 名册同步失败不阻断切换 */ }
  return { ok: binding.ok, warnings, workspace, teamName: name || null, currentWorkspace: record };
}

/**
 * 旧项目恢复：<项目目录>/团队会话.json 是 launch.mjs 每次建团队写下的角色→会话清单。
 * 只把它当作“待核验线索”灌进映射；真正是否复用由启动团队时的 DSH 核验决定。
 *
 * 跨项目防线：清单里的 workspace 必须 realpath 等于当前项目路径；不一致时整份丢弃，
 * 绝不能用 A 项目的 workspaceId/sessionId 给 B 项目恢复映射。清单里的 workspaceId
 * 也不直接采信（旧文件很容易被复制），绑定统一交给 workspace/create 按 path 幂等核验。
 */
function sessionsFromManifest(projectPath) {
  const dir = String(projectPath || '').trim();
  if (!dir) return { ok: false, code: 'PROJECT_PATH_REQUIRED', message: '缺少项目路径' };
  const manifest = teamTools.readSessionManifest(dir);
  if (!manifest || !Array.isArray(manifest.roles)) {
    return { ok: false, code: 'MANIFEST_MISSING', message: '项目目录没有可用的 团队会话.json' };
  }
  const manifestWorkspace = String(manifest.workspace || '').trim();
  if (!manifestWorkspace || !sameResolvedPath(manifestWorkspace, dir)) {
    return {
      ok: false,
      code: 'MANIFEST_WORKSPACE_MISMATCH',
      message: `团队会话.json 属于另一个目录（${manifestWorkspace || '未记录'}），已拒绝恢复`,
      manifestWorkspace,
      manifestWorkspaceId: manifest.workspaceId || null
    };
  }
  const sessions = manifest.roles
    .filter((row) => row && ROLE_BY_ID.has(String(row.role)) && row.sessionId)
    .map((row) => ({
      role: String(row.role),
      sessionId: String(row.sessionId),
      title: row.title || roleTitle(String(row.role)),
      reused: true
    }));
  if (!sessions.length) {
    return { ok: false, code: 'MANIFEST_EMPTY', message: '团队会话.json 没有六角色会话' };
  }
  return {
    ok: true,
    code: 'OK',
    sessions,
    // 不直接采信清单里的 workspaceId；绑定必须由 DSH workspace/create 按 path 核验。
    workspaceId: null,
    manifestWorkspaceId: manifest.workspaceId || null,
    workspacePath: path.resolve(dir),
    manifestProject: manifest.project || null
  };
}

/**
 * 旧协议用“项目名”定位团队项目；状态库里可能还没记 teamName（旧记录/手工恢复）。
 * 这里补一次 ensure 拿到稳定名字，失败就返回结构化错误，不阻断纯本地回退。
 */
async function ensureTeamName(project) {
  const known = String(project.teamName || '').trim();
  if (known) return { ok: true, teamName: known, ensured: false };
  const ensured = await syncTeamProject(project, { engineUrl: dsh.baseUrl });
  if (ensured.ok && ensured.name) return { ok: true, teamName: String(ensured.name), ensured: true };
  return {
    ok: false,
    teamName: '',
    ensured: true,
    code: ensured.code || 'TEAM_ENSURE_FAILED',
    message: ensured.message || ensured.why || '团队项目登记失败'
  };
}

/** 结构化 IPC 错误：code 必须进 message，渲染层才能按 [CODE] 识别。 */
function codedError(code, message) {
  const text = String(message || code || '未知错误');
  const error = new Error(`[${code || 'TEAM_ERROR'}] ${text}`);
  error.code = code || 'TEAM_ERROR';
  return error;
}

/** await 之后只合并 teamName，不写回旧 store 快照。 */
function persistTeamName(projectId, teamName) {
  const name = String(teamName || '').trim();
  if (!projectId || !name) return null;
  const fresh = readStore();
  const current = fresh.projects.find((item) => item.id === projectId);
  if (!current) return null;
  if (current.teamName !== name) {
    current.teamName = name;
    addEvent(current, `团队项目名已缓存：${name}`);
    writeStore(fresh);
  }
  return current;
}

/**
 * Owner 确认码（challenge/nonce/confirmToken）已废弃（2026-11-06）：
 * owner 决定/验收直接以 role=owner 接受，审计记 actor:'owner'、channel:'workbench'、at。
 * 下面这套内存 challenge 机制不再被任何 IPC 调用；owner:challenge / owner:confirm
 * 两个 IPC 仍保留，但只返回固定占位值并标记 deprecated，仅供旧渲染层兼容。
 * 不要在新代码里调用 requireOwnerConfirmation / issueOwnerChallenge。
 */
const OWNER_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const ownerChallenges = new Map();

function ownerRequirementKey(value) {
  const text = String(value == null ? '' : value).trim();
  const match = text.match(/^R-(\d{8})-(\d{4,8})(?:-|$)/i);
  if (!match) return text.toUpperCase();
  return `R-${match[1]}-${Number(match[2])}`;
}

/** 把界面/调用方的动作名归一成 owner-decision / owner-accept；未知动作原样保留。 */
function normalizeOwnerConfirmationAction(raw) {
  const text = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!text || text === '*' || text === 'any') return '*';
  if (['requirement:owner', 'requirement-owner', 'owner-review', 'owner-review-requirement', 'owner', 'workflow:owner', 'workflow-owner', 'owner:decide', 'owner-decide'].includes(text)) {
    return 'owner-decision';
  }
  if (['owner:accept', 'owner-accept', 'accept', 'acceptance', 'owner-acceptance'].includes(text)) {
    return 'owner-accept';
  }
  return text;
}

function cleanupOwnerChallenges() {
  const now = Date.now();
  for (const [id, row] of ownerChallenges) {
    const expires = Date.parse(String((row && row.expiresAt) || ''));
    if (!Number.isFinite(expires) || expires + 60 * 1000 < now) ownerChallenges.delete(id);
  }
}

function issueOwnerChallenge(payload = {}) {
  cleanupOwnerChallenges();
  const p = payload || {};
  const challengeId = 'OC-' + crypto.randomBytes(8).toString('hex');
  const nonce = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const action = normalizeOwnerConfirmationAction(p.action);
  const requirementId = String(p.requirementId || p.id || '');
  const projectId = String(p.projectId || '');
  const expiresAt = new Date(Date.now() + OWNER_CHALLENGE_TTL_MS).toISOString();
  ownerChallenges.set(challengeId, {
    challengeId,
    nonceHash: sha256(Buffer.from(nonce, 'utf8')),
    action,
    requirementId,
    requirementKey: requirementId ? ownerRequirementKey(requirementId) : '',
    projectId,
    createdAt: new Date().toISOString(),
    expiresAt,
    confirmedAt: null,
    confirmTokenHash: null,
    consumedAt: null
  });
  return {
    ok: true,
    code: 'OWNER_CHALLENGE_ISSUED',
    challengeId,
    nonce,
    action,
    requirementId: requirementId || null,
    projectId: projectId || null,
    expiresAt,
    ttlMs: OWNER_CHALLENGE_TTL_MS,
    challenge: {
      challengeId,
      nonce,
      action,
      requirementId: requirementId || null,
      projectId: projectId || null,
      expiresAt,
      ttlMs: OWNER_CHALLENGE_TTL_MS
    },
    message: `Owner 确认码 ${nonce}（5 分钟内有效，仅本次确认）`
  };
}

/** 从 IPC payload 里取出 challengeId / nonce / confirmToken，兼容多种字段名。 */
function ownerConfirmationInput(payload) {
  const p = payload || {};
  const bags = [p, p.ownerConfirm, p.ownerConfirmation, p.confirm].filter((row) => row && typeof row === 'object');
  let challengeId = '';
  let token = '';
  // 兼容 ownerConfirm: '<nonce>' / confirm: '<token>' 这种直接传字符串的调用方。
  if (typeof p.ownerConfirm === 'string' && !token) token = p.ownerConfirm;
  if (typeof p.ownerConfirmation === 'string' && !token) token = p.ownerConfirmation;
  if (typeof p.confirm === 'string' && !token) token = p.confirm;
  for (const bag of bags) {
    if (!challengeId) challengeId = String(bag.challengeId || bag.ownerChallengeId || bag.ownerChallenge || '');
    if (!token) {
      token = String(bag.confirmToken || bag.ownerConfirmToken || bag.token || bag.ownerToken
        || bag.nonce || bag.ownerNonce || '');
    }
  }
  return { challengeId: challengeId.trim(), token: token.trim() };
}

function validateOwnerConfirmation(payload, expected = {}) {
  const input = ownerConfirmationInput(payload);
  if (!input.token) return { ok: false, code: 'OWNER_CONFIRM_REQUIRED', message: 'Owner 操作未确认：先取确认码并确认，再带 confirmToken/nonce 重试' };
  cleanupOwnerChallenges();
  let challenge = input.challengeId ? ownerChallenges.get(input.challengeId) : null;
  const tokenHash = sha256(Buffer.from(input.token, 'utf8'));
  if (!challenge) {
    for (const row of ownerChallenges.values()) {
      if (!row) continue;
      if (row.confirmTokenHash === tokenHash) { challenge = row; break; }
      if (row.nonceHash === tokenHash) { challenge = row; break; }
    }
  }
  if (!challenge) return { ok: false, code: 'OWNER_CONFIRM_INVALID', message: 'Owner 确认码/令牌无效或已被使用' };
  if (challenge.consumedAt) return { ok: false, code: 'OWNER_CONFIRM_INVALID', message: 'Owner 确认令牌已经使用过' };
  const expires = Date.parse(String(challenge.expiresAt || ''));
  if (!Number.isFinite(expires) || expires < Date.now()) {
    return { ok: false, code: 'OWNER_CONFIRM_EXPIRED', message: 'Owner 确认已过期，请重新获取确认码' };
  }
  // nonce 本身不能直接当业务凭据：必须先 owner:confirm，换出 confirmToken；
  // 但确认后也接受用同一个 nonce 重放本动作（仍然一次性消费）。
  if (!challenge.confirmedAt) {
    return { ok: false, code: 'OWNER_CONFIRM_REQUIRED', message: 'Owner 确认码还没有在 owner:confirm 里确认，不能执行 Owner 操作' };
  }
  if (challenge.confirmTokenHash !== tokenHash && challenge.nonceHash !== tokenHash) {
    return { ok: false, code: 'OWNER_CONFIRM_INVALID', message: 'Owner 确认令牌与本次动作不匹配' };
  }
  const expectedAction = normalizeOwnerConfirmationAction(expected.action);
  if (challenge.action !== '*' && expectedAction !== '*' && challenge.action !== expectedAction) {
    return { ok: false, code: 'OWNER_CONFIRM_SCOPE_MISMATCH', message: `Owner 确认只适用于 ${challenge.action}，不能用于 ${expectedAction}` };
  }
  if (challenge.projectId && expected.projectId && String(challenge.projectId) !== String(expected.projectId)) {
    return { ok: false, code: 'OWNER_CONFIRM_SCOPE_MISMATCH', message: 'Owner 确认不属于当前项目' };
  }
  const expectedKey = expected.requirementId ? ownerRequirementKey(expected.requirementId) : '';
  if (challenge.requirementKey && expectedKey && challenge.requirementKey !== expectedKey) {
    return { ok: false, code: 'OWNER_CONFIRM_SCOPE_MISMATCH', message: 'Owner 确认不属于当前需求' };
  }
  return { ok: true, code: 'OWNER_CONFIRMED', challenge };
}

function consumeOwnerChallenge(challenge) {
  if (!challenge) return;
  challenge.consumedAt = new Date().toISOString();
}

/** Owner 操作前的统一闸门；失败时把本次 challenge 一并带回，UI 可直接展示确认码。 */
function requireOwnerConfirmation(payload, expected = {}) {
  const checked = validateOwnerConfirmation(payload, expected);
  if (checked.ok) return checked;
  if (['OWNER_CONFIRM_REQUIRED', 'OWNER_CONFIRM_INVALID', 'OWNER_CONFIRM_EXPIRED'].includes(checked.code)) {
    const issued = issueOwnerChallenge({
      projectId: expected.projectId || (payload && payload.projectId) || '',
      action: expected.action,
      requirementId: expected.requirementId || (payload && (payload.requirementId || payload.id)) || ''
    });
    return {
      ...checked,
      ok: false,
      challenge: {
        challengeId: issued.challengeId,
        nonce: issued.nonce,
        expiresAt: issued.expiresAt,
        ttlMs: issued.ttlMs,
        action: issued.action,
        requirementId: issued.requirementId,
        projectId: issued.projectId
      }
    };
  }
  return checked;
}

/**
 * 工作流 IPC 的公共上下文：项目 → 团队名（必要时 ensure）→ 旧项目目录。
 * 需求/评审/派单/开发/测试/验收都只认这个 teamName，所有状态写旧团队状态目录。
 */
async function workflowProjectContext(payload) {
  const p = payload || {};
  let project = requireProject(readStore(), p.projectId);
  const ensured = await ensureTeamName(project);
  if (!ensured.ok || !ensured.teamName) {
    throw codedError(ensured.code || 'TEAM_ENSURE_FAILED', ensured.message || '团队项目不可用');
  }
  const teamName = String(ensured.teamName);
  project = persistTeamName(project.id, teamName) || requireProject(readStore(), project.id);
  return { project, teamName, projectPath: path.resolve(String(project.path)) };
}

/**
 * 旧团队状态 → 本地 workbench.json 的只读镜像。
 * 只合并工作流任务（source=legacy-workflow），不动用户手工建的任务；
 * 需求/任务/阶段的真相仍在 团队/状态/项目/<slug>/。
 */
function mirrorWorkflowToStore(projectId, teamName, projectPath) {
  if (!projectId || !teamName) return null;
  let snapshot = null;
  try {
    snapshot = teamTools.readWorkflowSnapshot(teamName, projectPath);
  } catch {
    return null;
  }
  if (!snapshot || !snapshot.ok) return null;
  try {
    const store = readStore();
    const current = store.projects.find((project) => project.id === projectId);
    if (!current) return null;
    current.teamName = teamName;
    current.requirements = Array.isArray(snapshot.requirements) ? snapshot.requirements : [];
    current.votes = Array.isArray(snapshot.votes) ? snapshot.votes : [];
    const previousPhase = current.workflowMirror && current.workflowMirror.phase;
    current.workflowMirror = {
      phase: snapshot.phase,
      round: snapshot.round,
      stage: snapshot.stage,
      mirrorOnly: true,
      truthSource: 'legacy-workflow',
      ownerReview: snapshot.ownerReview,
      boots: snapshot.boots || {},
      nextRound: snapshot.nextRound || [],
      counts: snapshot.counts || null,
      file: snapshot.file,
      legacy: snapshot.legacy || null,
      updatedAt: snapshot.updatedAt || now()
    };
    current.tasks = Array.isArray(current.tasks) ? current.tasks : [];
    for (const task of snapshot.tasks || []) {
      if (!task || !task.id) continue;
      const status = task.status === 'done' ? 'done' : (task.status === 'working' ? 'doing' : 'todo');
      let local = current.tasks.find((row) => row.id === task.id);
      if (!local) {
        local = { id: String(task.id), createdAt: task.createdAt || now() };
        current.tasks.push(local);
      }
      Object.assign(local, {
        title: String(task.title || local.title || task.id).slice(0, 120),
        role: task.owner || local.role || null,
        owner: task.owner || local.owner || null,
        priority: String(task.priority || local.priority || 'P2'),
        status,
        requirementId: String(task.requirementId || ''),
        acceptance: String(task.acceptance || ''),
        story: String(task.story || ''),
        evidence: String(task.evidence || ''),
        source: 'legacy-workflow',
        teamStatus: String(task.status || ''),
        updatedAt: task.updatedAt || now()
      });
    }
    if (snapshot.ownerReview && snapshot.ownerReview.status && snapshot.ownerReview.status !== 'optional') {
      current.ownerReview = {
        status: snapshot.ownerReview.status,
        opinion: String(snapshot.ownerReview.opinion || '').slice(0, 1000),
        at: snapshot.ownerReview.at || null,
        // 只有真实 Owner 决定才写 by/actor；pending 不能在这里补成 'Owner'。
        by: snapshot.ownerReview.by || null,
        actor: snapshot.ownerReview.actor || null,
        roundKey: snapshot.ownerReview.roundKey || null,
        kind: snapshot.ownerReview.kind || null
      };
    }
    if (previousPhase !== snapshot.phase) {
      addEvent(current, `工作流镜像：${previousPhase || '无'} → ${snapshot.phase}（${snapshot.stage}）`);
    }
    writeStore(store);
    return current;
  } catch {
    return null;
  }
}

/** 统一工作流返回：失败也镜像一次，界面/测试能看到旧状态是否已部分落盘。 */
function workflowResponse(projectId, teamName, projectPath, result) {
  const mirrored = mirrorWorkflowToStore(projectId, teamName, projectPath);
  return {
    ...(result || {}),
    projectId,
    teamName,
    mirrored: mirrored ? {
      requirements: (mirrored.requirements || []).length,
      tasks: (mirrored.tasks || []).filter((task) => task.source === 'legacy-workflow').length,
      stage: mirrored.workflowMirror ? mirrored.workflowMirror.stage : null
    } : null,
    state: statePayload()
  };
}

/**
 * 收件箱/已读的公共核验：项目 → 团队名（并持久化）→ 角色当前项目会话 → DSH 归属。
 * 所有 await 结束后返回最新项目快照，调用方不要再用 await 之前的旧对象。
 */
async function resolveProjectTeamRole(payload, role) {
  const p = payload || {};
  const roleId = String(role || '');
  if (!ROLES.some((item) => item.id === roleId)) throw codedError('BAD_ROLE', `角色无效：${roleId}`);
  let project = requireProject(readStore(), p.projectId);
  const ensured = await ensureTeamName(project);
  if (!ensured.ok || !ensured.teamName) {
    throw codedError(ensured.code || 'TEAM_ENSURE_FAILED', ensured.message || '团队项目不可用');
  }
  const teamName = String(ensured.teamName);
  // ensureTeamName 有 await：重新读库，避免返回旧会话映射。
  project = persistTeamName(project.id, teamName) || requireProject(readStore(), project.id);
  const sessionId = String(p.sessionId || (project.sessions && project.sessions[roleId]) || '');
  const verified = await verifyProjectRoleSession(project, roleId, sessionId, { timeoutMs: 6000 });
  if (!verified.ok) throw codedError(verified.code, verified.message);
  // 名册同步成当前项目快照，旧工具 boot 读到的才是本项目会话。
  teamTools.syncRoster(teamName, project.sessions || {});
  return { project, role: roleId, teamName, sessionId: verified.sessionId, verified };
}

/** 旧协议消息镜像进本地库：界面仍按 messages[] / pendingAck 读，但真相在 team.mjs。 */
function pushProjectMessage(project, message) {
  project.messages = Array.isArray(project.messages) ? project.messages : [];
  project.messages.push(message);
  if (project.messages.length > 500) project.messages = project.messages.slice(-500);
  return message;
}

// ==========================================================================
// 六会话通信链：delivered → wake → read → ack
//
// 本地 messages[] 只是镜像，真正的 delivered/read/ack 证据在旧协议现场：
//   delivered = 收件角色邮箱 new/ 出现该消息；
//   read      = 同一条消息从 new/ 移到 cur/（角色自己执行 read）；
//   ack       = 回执.jsonl 新增该 msgId 的回执（角色自己 ack）。
// wake 只有 DSH 适配层能证明，所以由主进程在 prompt 成功后写入。
// 任何一段都不允许“壳猜一个成功”；actor/by 必须写清是角色、壳还是人。
// ==========================================================================
function emptyMessageComm(message = {}) {
  return {
    messageId: String(message.id || ''),
    teamMessageId: message.teamMessageId ? String(message.teamMessageId) : null,
    delivered: { state: 'pending', at: null, by: null, source: null, mailbox: null },
    wake: { state: 'pending', at: null, by: 'workbench-shell', sessionId: null, steps: COMM_WAKE_STEPS.slice(), mode: null },
    read: { state: 'pending', at: null, by: null, source: null, sessionId: null },
    ack: { state: 'pending', at: null, by: null, actor: null, source: null, receiptId: null, sessionId: null },
    selfExecuted: { read: false, ack: false },
    updatedAt: now(),
    checkedAt: null
  };
}

function ensureMessageComm(message) {
  if (!message || typeof message !== 'object') return emptyMessageComm({});
  const existing = message.comm && typeof message.comm === 'object' && !Array.isArray(message.comm) ? message.comm : {};
  const defaults = emptyMessageComm(message);
  // 原地补默认值，保持 message.comm 对象身份稳定；否则 setMessageCommPart 换对象后，
  // 外层拿到的 comm 引用会写不回 message.comm（selfExecuted 就会丢）。
  for (const key of Object.keys(defaults)) {
    if (existing[key] === undefined) existing[key] = defaults[key];
  }
  for (const part of COMM_PARTS) {
    existing[part] = {
      ...defaults[part],
      ...(existing[part] && typeof existing[part] === 'object' && !Array.isArray(existing[part]) ? existing[part] : {})
    };
  }
  existing.selfExecuted = {
    ...defaults.selfExecuted,
    ...(existing.selfExecuted && typeof existing.selfExecuted === 'object' ? existing.selfExecuted : {})
  };
  existing.messageId = String(message.id || existing.messageId || '');
  existing.teamMessageId = message.teamMessageId ? String(message.teamMessageId) : (existing.teamMessageId || null);
  if (!Array.isArray(existing.wake.steps) || !existing.wake.steps.length) existing.wake.steps = COMM_WAKE_STEPS.slice();
  message.comm = existing;
  return existing;
}

function setMessageCommPart(message, part, patch = {}) {
  if (!COMM_PARTS.includes(part)) return null;
  const comm = ensureMessageComm(message);
  comm[part] = { ...comm[part], ...patch };
  comm.updatedAt = now();
  if (part === 'delivered' && comm.delivered.state === 'delivered') message.deliveredAt = comm.delivered.at || message.deliveredAt || null;
  if (part === 'wake' && comm.wake.state === 'sent') message.wakeAt = comm.wake.at || message.wakeAt || null;
  if (part === 'read' && comm.read.state === 'read') message.readAt = comm.read.at || message.readAt || null;
  if (part === 'ack' && comm.ack.state === 'acked') {
    message.ack = true;
    message.ackAt = comm.ack.at || message.ackAt || null;
  }
  return comm[part];
}

/** 发送落库时先写 delivered/wake 的初始状态；wake 在 DSH prompt 之后再补。 */
function buildInitialMessageComm(message, options = {}) {
  const comm = emptyMessageComm(message);
  const fromTeam = options.source === 'team';
  comm.delivered = {
    state: fromTeam ? 'delivered' : 'local-only',
    at: message.createdAt || now(),
    by: 'workbench-shell',
    source: fromTeam ? 'team.mjs send' : 'local-mirror',
    mailbox: fromTeam ? 'new' : null
  };
  comm.wake = {
    state: 'pending',
    at: null,
    by: 'workbench-shell',
    sessionId: options.sessionId ? String(options.sessionId) : null,
    steps: COMM_WAKE_STEPS.slice(),
    mode: 'dsh.prompt'
  };
  message.comm = comm;
  return comm;
}

function publicMessageComm(message) {
  const comm = ensureMessageComm(message);
  const states = {};
  for (const part of COMM_PARTS) states[part] = comm[part] && comm[part].state ? comm[part].state : 'pending';
  return {
    messageId: String(message.id || ''),
    teamMessageId: message.teamMessageId ? String(message.teamMessageId) : null,
    from: message.from || '',
    to: message.to || '',
    subject: message.subject || '',
    ackRequired: message.ackRequired !== false,
    delivered: { ...comm.delivered },
    wake: { ...comm.wake },
    read: { ...comm.read },
    ack: { ...comm.ack },
    selfExecuted: { ...comm.selfExecuted },
    states,
    complete: COMM_PARTS.every((part) => states[part] === COMM_DONE_STATES[part]),
    updatedAt: comm.updatedAt || null,
    checkedAt: comm.checkedAt || null
  };
}

function commSummaryFor(project) {
  const messages = (project && Array.isArray(project.messages) ? project.messages : [])
    .filter((message) => message && (message.source === 'team' || message.comm));
  const summary = {
    total: messages.length,
    delivered: 0,
    wakeSent: 0,
    read: 0,
    acked: 0,
    manual: 0,
    selfExecutedRead: 0,
    selfExecutedAck: 0,
    pendingAck: project && project.pendingAck ? String(project.pendingAck) : null
  };
  for (const message of messages) {
    const comm = ensureMessageComm(message);
    if (comm.delivered.state === 'delivered') summary.delivered += 1;
    if (comm.wake.state === 'sent') summary.wakeSent += 1;
    if (comm.read.state === 'read') summary.read += 1;
    if (comm.ack.state === 'acked') summary.acked += 1;
    if (comm.ack.state === 'manual') summary.manual += 1;
    if (comm.selfExecuted.read) summary.selfExecutedRead += 1;
    if (comm.selfExecuted.ack) summary.selfExecutedAck += 1;
  }
  return summary;
}

/**
 * 对账旧协议通信现场。只读邮箱/回执，再把差异合并进本地镜像；有变化才写库。
 * 返回 changed/checked/changedIds，供 team:comm / team:reconcile 和 selftest 使用。
 */
function reconcileProjectCommStates(store, options = {}) {
  if (!store || !Array.isArray(store.projects)) return { changed: 0, checked: 0, changedIds: [], skipped: 'NO_STORE' };
  const tool = teamTools.toolInfo();
  if (!tool.available) return { changed: 0, checked: 0, changedIds: [], skipped: 'TOOL_UNAVAILABLE' };
  const targets = store.projects.filter((project) => !options.projectId || project.id === options.projectId);
  const roles = new Set();
  for (const project of targets) {
    for (const message of project.messages || []) {
      if (!message || !message.teamMessageId || !message.to) continue;
      roles.add(String(message.to));
    }
  }
  if (!roles.size) return { changed: 0, checked: 0, changedIds: [], skipped: 'NO_TEAM_MESSAGES' };
  const snapshot = teamTools.commSnapshot({ roles: Array.from(roles) });
  if (!snapshot || !snapshot.ok) {
    return { changed: 0, checked: 0, changedIds: [], skipped: (snapshot && snapshot.code) || 'SNAPSHOT_FAILED' };
  }
  let changed = 0;
  let checked = 0;
  const changedIds = [];
  for (const project of targets) {
    for (const message of project.messages || []) {
      if (!message || !message.teamMessageId) continue;
      checked += 1;
      let dirty = false;
      const comm = ensureMessageComm(message);
      const teamMessageId = String(message.teamMessageId);
      const mail = snapshot.mail[teamMessageId] || snapshot.mail[message.id] || null;
      if (mail) {
        if (comm.delivered.state !== 'delivered') {
          setMessageCommPart(message, 'delivered', {
            state: 'delivered',
            at: mail.ts || message.createdAt || now(),
            by: 'workbench-shell',
            source: 'team.mjs send',
            mailbox: 'new',
            file: mail.file
          });
          dirty = true;
        }
        // 角色自己 read 的唯一硬证据：邮件从 new 移到 cur。壳代点的 read 会写 by=workbench-shell。
        if (mail.box === 'cur' && comm.read.state !== 'read') {
          setMessageCommPart(message, 'read', {
            state: 'read',
            at: now(),
            by: 'role',
            source: 'mailbox',
            sessionId: message.recipientSessionId || null,
            box: 'cur',
            file: mail.file,
            detectedAt: now()
          });
          comm.selfExecuted.read = true;
          dirty = true;
        }
      }
      const receipt = snapshot.receipts[teamMessageId] || snapshot.receipts[message.id] || null;
      if (receipt && comm.ack.state !== 'acked') {
        const isLocal = receipt.local === true || receipt.source === 'local';
        const receiptActor = String(receipt.actor || (isLocal ? 'workbench-shell' : 'role-session'));
        const selfExecuted = !isLocal && receiptActor !== 'workbench-shell';
        const previousState = comm.ack.state;
        setMessageCommPart(message, 'ack', {
          state: 'acked',
          at: receipt.ts || now(),
          by: selfExecuted ? 'role' : 'workbench-shell',
          actor: receiptActor,
          source: isLocal ? 'local-receipt' : 'receipt',
          receiptId: receipt.id || null,
          sessionId: receipt.sessionId || null,
          identitySource: receipt.identitySource || null,
          workspaceId: receipt.workspaceId || null,
          allowShellAck: false,
          previousState: previousState !== 'pending' ? previousState : null,
          detectedAt: now()
        });
        comm.selfExecuted.ack = selfExecuted;
        message.ackNote = String(receipt.note || message.ackNote || '').slice(0, 300);
        message.ackId = receipt.id || message.ackId || null;
        message.ackSource = isLocal ? 'local-receipt' : 'team-external';
        message.actor = receiptActor;
        message.executor = selfExecuted ? 'role-session' : 'workbench-shell';
        message.identitySource = receipt.identitySource || (isLocal ? 'local' : 'receipt');
        dirty = true;
      }
      if (dirty) {
        comm.checkedAt = now();
        changed += 1;
        changedIds.push(String(message.id));
        if (message.ack && project.pendingAck && String(project.pendingAck) === String(message.id)) {
          clearPendingAck(project, `检测到${comm.selfExecuted.ack ? '角色自己' : ''}回执 ${message.id}，撤销本机派单锁`);
        }
      }
    }
  }
  if (changed) {
    try { writeStore(store); } catch { /* 对账失败不阻断读取；下一轮会重试 */ }
  }
  return { changed, checked, changedIds, skipped: null, snapshotAt: snapshot.generatedAt };
}

let commReconcileCache = { at: 0, result: null };
function reconcileProjectCommStatesCached(store) {
  const at = Date.now();
  if (commReconcileCache.result && at - commReconcileCache.at < COMM_RECONCILE_CACHE_MS) return commReconcileCache.result;
  const result = reconcileProjectCommStates(store);
  commReconcileCache = { at, result };
  return result;
}

let mainWindow = null;
let teamBoardWindow = null;
let teamBoardProjectId = null;
let teamBoardProjectPath = null;
let teamBoardExpandedBounds = null;
// 优先级：显式环境变量（测试/运维）→ 上次保存的地址 → 旧默认 52711。
let dsh = new DshAdapter(process.env.DSH_WEB_URL || SAVED_DSH_URL || 'http://127.0.0.1:52711');
// DSH 端口自动发现：只在检测到离线且当前地址是本机时触发；15 秒冷却避免轮询时反复探测。
const DSH_DISCOVERY_COOLDOWN_MS = 15000;
const DSH_DISCOVERY_CHECK_TIMEOUT_MS = 4000;
let dshDiscovery = { at: 0, last: null, running: null };
const sessionCreateLocks = new Map();
const provisionLocks = new Map();

async function createSessionOnce(projectId, roleId, options) {
  const key = String(projectId) + ':' + String(roleId);
  if (sessionCreateLocks.has(key)) return sessionCreateLocks.get(key);
  const task = dsh.createSession(options).finally(() => sessionCreateLocks.delete(key));
  sessionCreateLocks.set(key, task);
  return task;
}

/**
 * 直连 DSH 适配层的兜底启动路径（团队工具缺失时才会用到）。
 * 与 launch.mjs 对齐：先绑定 workspace，再按工作区成员/标题复用，只补建缺失角色；
 * 会话一律用 workspaceId 创建（保证 1 项目=1 工作区、1 会话=1 角色、不建额外会话）。
 */
async function provisionDirect(projectId) {
  const project = requireProject(readStore(), projectId);
  const binding = await bindProjectWorkspace(project, { engineUrl: dsh.baseUrl, force: true, timeoutMs: 8000 });
  if (!binding.ok) {
    const error = new Error(`DSH 启动团队失败（${binding.code}）：工作区不可用：${String(binding.message || '').slice(0, 220)}`);
    error.code = binding.code;
    throw error;
  }
  const workspaceId = binding.workspaceId;
  const workspacePath = path.resolve(String(project.path));
  const remote = await dsh.listSessions({ timeoutMs: 8000 });
  const remoteById = new Map(remote.map((item) => [String(item.sessionId), item]));
  const inWorkspace = new Set((binding.sessionIds || []).map(String));
  // 只认“本工作区里的 团队·角色 会话”，绝不跨项目复用。
  const byTitle = new Map();
  for (const session of remote) {
    const title = (session.projections && session.projections.values && session.projections.values.title) || '';
    const cwd = session.cwd ? path.resolve(String(session.cwd)) : '';
    const inThisWorkspace = inWorkspace.size ? inWorkspace.has(String(session.sessionId)) : cwd.toLowerCase() === workspacePath.toLowerCase();
    if (!title || !inThisWorkspace) continue;
    if (!byTitle.has(title)) byTitle.set(title, String(session.sessionId));
  }
  const created = [];
  const adopted = [];
  const sessions = [];
  let failure = null;
  const roleIds = roleIdsForProject(project);
  try {
    for (const roleId of roleIds) {
      const title = roleTitle(roleId);
      const recorded = project.sessions && project.sessions[roleId] ? String(project.sessions[roleId]) : '';
      const recordedInfo = recorded ? remoteById.get(recorded) : null;
      const recordedCwd = recordedInfo && recordedInfo.cwd ? path.resolve(String(recordedInfo.cwd)) : '';
      if (recordedInfo && (inWorkspace.has(recorded) || (recordedCwd && recordedCwd.toLowerCase() === workspacePath.toLowerCase()))) {
        sessions.push({ role: roleId, sessionId: recorded, title, reused: true });
        continue;
      }
      const existing = byTitle.get(title);
      if (existing) {
        adopted.push({ role: roleId, sessionId: existing });
        sessions.push({ role: roleId, sessionId: existing, title, reused: true });
        continue;
      }
      const s = await createSessionOnce(projectId, roleId, { workspaceId, title });
      created.push({ role: roleId, sessionId: s.sessionId });
      sessions.push({ role: roleId, sessionId: s.sessionId, title, reused: false });
    }
  } catch (e) {
    failure = e;
  }
  // 无论成功/中途失败都落库，已建会话保留，重试只补缺口。
  if (sessions.length) {
    persistSessionMapping(projectId, sessions, {
      workspaceId,
      workspacePath: project.path,
      teamName: project.teamName,
      sessionIds: sessions.map((session) => session.sessionId),
      event: failure
        ? `启动 DSH 团队中断（${failure.code || 'DSH_PROVISION_FAILED'}）：已保留 ${sessions.length} 个会话`
        : `启动 DSH 团队：新建 ${created.length} 个会话`
    });
  }
  if (failure) {
    const code = failure.code || 'DSH_PROVISION_FAILED';
    const error = new Error(`DSH 启动团队失败（${code}）：${String(failure.message || failure).slice(0, 260)}${created.length ? `；已保留 ${created.length} 个已建会话，可重试补建` : ''}`);
    error.code = code;
    error.created = created;
    throw error;
  }
  return {
    ok: true,
    created,
    adopted,
    sessions,
    workspaceId,
    workspace: project.path,
    mapping: publicMapping(requireProject(readStore(), projectId)),
    state: statePayload()
  };
}

/**
 * 六角色启动（启动团队 / 补建）：
 *   1) 绑定/创建 DSH 工作区（1 项目 = 1 工作区）；
 *   2) 向 DSH 核验六个角色会话（本地记录不是真相）；
 *   3) 六角色齐 + 名册齐 → 直接复用，不建任何会话；
 *   4) 否则走旧版 launch.mjs：固定模型、团队·角色标题、按标题复用、--add-members 补齐名册、
 *      --seed-visible 让空白会话在 DSH 工作区可见；只创建/补建缺失的六个角色会话。
 * 只有团队工具缺失时才退回直连适配层。
 */
async function provisionTeamSessions(projectId, options = {}) {
  const initial = requireProject(readStore(), projectId);
  if (!dsh.baseUrl) {
    const error = new Error('先在左下角配置 DSH 地址');
    error.code = 'DSH_NOT_CONFIGURED';
    throw error;
  }
  const tool = teamTools.toolInfo();
  if (!tool.available) return provisionDirect(projectId);

  // 建团队/补建只按 project.teamMode 的 roleIds：Fast 不碰 product/programmer2。
  const roleIds = roleIdsForProject(initial);
  const binding = await bindProjectWorkspace(initial, { engineUrl: dsh.baseUrl, force: true, timeoutMs: 8000 });
  if (!binding.ok) {
    const error = new Error(`DSH 启动团队失败（${binding.code}）：DSH 工作区不可用：${String(binding.message || '').slice(0, 220)}`);
    error.code = binding.code;
    throw error;
  }
  const project = requireProject(readStore(), projectId);
  let inspection = await inspectProjectSessions(project, binding);
  let repair = { archived: [], actions: [] };
  // 重复/幽灵会话先修复：否则 launch 的“按标题复用”可能接管到错误的那一条。
  if (options.repair !== false && ((inspection.duplicates || []).length || (inspection.ghost || []).length)) {
    repair = await repairRoleSessionDuplicates(project, inspection);
    if (repair.archived.length) {
      inspection = await inspectProjectSessions(requireProject(readStore(), projectId), binding);
    }
  }
  const roster = teamTools.rosterStatus(roleIds);
  // 名册缺角色 / 名册里的角色没会话 / 会话空白，都算“没建齐”，交给 launch.mjs 一次补齐。
  const missingRoles = new Set([...inspection.missing, ...inspection.blank, ...roster.missing, ...roster.withoutSession]);
  const mappingNow = () => publicMapping(requireProject(readStore(), projectId));
  const currentProject = () => requireProject(readStore(), projectId);
  const activate = async (projectName) => {
    try {
      const result = await teamTools.activateProject(projectName, currentProject().sessions.pm || '');
      return result.ok ? [] : [{ code: result.code || 'TEAM_ACTIVATE_FAILED', message: result.message || '切换团队当前项目失败' }];
    } catch (error) {
      return [{ code: 'TEAM_ACTIVATE_FAILED', message: String(error && error.message || error).slice(0, 200) }];
    }
  };

  if (missingRoles.size === 0) {
    const kept = roleIds.map((roleId) => ({
      role: roleId,
      sessionId: project.sessions[roleId],
      title: roleTitle(roleId),
      reused: true
    }));
    persistSessionMapping(projectId, kept, {
      workspaceId: binding.workspaceId,
      workspacePath: project.path,
      teamName: project.teamName,
      sessionIds: [...new Set([...(binding.sessionIds || []), ...kept.map((row) => row.sessionId)])]
    });
    const warnings = await activate(project.teamName || project.name);
    return {
      ok: true,
      created: [],
      reused: true,
      sessions: kept,
      workspace: path.resolve(String(project.path)),
      workspaceId: binding.workspaceId,
      inspected: inspection,
      repaired: repair,
      roster,
      warnings,
      mapping: mappingNow(),
      state: statePayload()
    };
  }

  const teamName = project.teamName || project.name;
  const result = await teamTools.launchSessions(
    { name: teamName, path: project.path, teamMode: project.teamMode },
    {
      dryRun: false,
      // 按当前模式角色交给 launch：它按 团队·角色 标题复用已存在的会话，只新建缺的；
      // --add-members 同时把本次角色补进名册（旧协议 send/ack 要求名册 active）。
      roles: roleIds,
      teamMode: normalizeTeamMode(project.teamMode),
      prompt: false,
      addMembers: true,
      restore: options.restore === true,
      // 旧版建团队会给空白成员发一句“已就位”，让六角色在 DSH 左侧真正显示；
      // 需要静默时可显式传 seedVisible:false。补建空白会话时必须 seed，否则永远 blank。
      seedVisible: options.seedVisible !== false,
      engineUrl: dsh.baseUrl
    }
  );
  if (Array.isArray(result.sessions) && result.sessions.length) {
    const sessionIds = [...new Set([
      ...(binding.sessionIds || []),
      ...result.sessions.map((session) => session.sessionId)
    ])];
    persistSessionMapping(projectId, result.sessions, {
      workspaceId: result.workspaceId || binding.workspaceId,
      workspacePath: result.workspace || project.path,
      teamName: result.name || teamName,
      sessionIds,
      event: `启动团队：新建 ${(result.sessions || []).filter((session) => !session.reused).length} 个角色会话`
    });
    if (result.workspace && result.workspaceId) {
      teamTools.recordWorkspaceBinding(result.workspace, { workspaceId: result.workspaceId, engineUrl: dsh.baseUrl });
    }
  }
  const created = (result.sessions || []).filter((session) => !session.reused)
    .map((session) => ({ role: session.role, sessionId: session.sessionId }));
  let after = null;
  let blankAfter = [];
  let stillMissing = [];
  try {
    after = await inspectProjectSessions(currentProject(), binding);
    blankAfter = after.blank;
    stillMissing = after.missing;
  } catch { /* 巡检失败时不伪报成功，交给下面的返回状态 */ }
  if (!result.ok && stillMissing.length) {
    const code = result.code || 'DSH_PROVISION_FAILED';
    const detail = (result.errors || []).slice(0, 3)
      .map((item) => `${item.role || '?'}/${item.stage || '?'}: ${String(item.message || '').slice(0, 120)}`)
      .join('；');
    // 工具崩在顶层时 stdout 里不会有 JSON，把 stderr 尾巴带进错误，方便定位而不是只看到 TOOL_EXIT。
    const stderrTail = String(result.stderr || '').replace(/\s+/g, ' ').trim().slice(-200);
    const error = new Error(`DSH 启动团队失败（${code}）：${String(result.message || result.why || '').slice(0, 260)}${detail ? `（${detail}）` : ''}${stderrTail ? `；工具输出：${stderrTail}` : ''}${created.length ? `；已保留 ${created.length} 个已建会话，可重试补建` : ''}`);
    error.code = code;
    error.created = created;
    error.persisted = created.length;
    throw error;
  }
  // 工具报 ok 但六角色没齐（例如只返回了部分会话）：不能静默成功。
  const keptRoles = new Set((result.sessions || []).filter((session) => session.sessionId).map((session) => session.role));
  stillMissing = [...new Set([...(after ? after.missing : []), ...roleIds.filter((role) => !keptRoles.has(role))])];
  if (stillMissing.length) {
    const error = new Error(`启动团队后仍缺少角色会话：${stillMissing.join(', ')}；已保留已有会话，可重试补建`);
    error.code = 'SESSION_PROVISION_INCOMPLETE';
    error.missing = stillMissing;
    error.created = created;
    throw error;
  }
  const warnings = [];
  if (!result.ok) warnings.push(...(result.errors || []));
  if (blankAfter.length) {
    // 不抛异常：第一次建团队可能只差一次 seed，保留已建会话并明确返回可重试状态；
    // 再次调用 dsh:provision 时 missingRoles 会包含 blank，从而重新发“已就位”。
    warnings.push({ code: 'SESSION_BLANK', message: `当前模式角色中仍有空白会话：${blankAfter.join(', ')}；可再次“建团队”补发就位` });
    return {
      ok: false,
      code: 'SESSION_BLANK',
      created,
      reused: created.length === 0,
      sessions: result.sessions || [],
      workspace: result.workspace || path.resolve(String(project.path)),
      workspaceId: result.workspaceId || binding.workspaceId,
      seeds: result.seedResults || [],
      inspected: inspection,
      after: after ? { reused: after.reused, missing: after.missing, blank: after.blank, duplicates: after.duplicates, ghost: after.ghost } : null,
      repaired: repair,
      roster,
      blank: blankAfter,
      warnings,
      mapping: mappingNow(),
      state: statePayload()
    };
  }
  warnings.push(...(await activate(result.name || teamName)));
  return {
    ok: true,
    created,
    reused: created.length === 0,
    sessions: result.sessions || [],
    workspace: result.workspace || path.resolve(String(project.path)),
    workspaceId: result.workspaceId || binding.workspaceId,
    seeds: result.seedResults || [],
    inspected: inspection,
    after: after ? { reused: after.reused, missing: after.missing, blank: after.blank, duplicates: after.duplicates, ghost: after.ghost } : null,
    repaired: repair,
    roster,
    // 会话已齐，但模型/seed/索引等仍有非致命错误：作为警告回传，不阻断“建团队”。
    warnings,
    mapping: mappingNow(),
    state: statePayload()
  };
}

function storeFile() {
  if (process.env.AWB_STORE) return path.resolve(process.env.AWB_STORE);
  return path.join(app.getPath('userData'), 'workbench.json');
}

let storeWarning = null;
let storeFatal = false;

function emptyStore() {
  return { version: 1, activeProjectId: null, projects: [] };
}

function storeStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// 原子落盘：先写同目录临时文件并 fsync，再 rename 覆盖；rename 失败才退化为整文件复制。
// 目标文件在成功 rename 之前不会被截断，崩溃/断电最多留下 .tmp，不会留下半截正式文件。
function writeDurableFile(file, data, tmpFile) {
  const tmp = tmpFile || (file + '.awb-tmp-' + process.pid + '-' + crypto.randomUUID().slice(0, 8));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    return tmp;
  } catch (error) {
    try { if (fd !== undefined) fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
}

function commitDurableFile(tmp, file) {
  try {
    fs.renameSync(tmp, file);
    return;
  } catch { /* Windows 上目标被短暂占用时退化，但仍先写完整临时文件 */ }
  try {
    fs.copyFileSync(tmp, file);
    try {
      const fd = fs.openSync(file, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch { /* fsync 失败不阻塞写入 */ }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function atomicWriteFile(file, data, tmpFile) {
  const tmp = writeDurableFile(file, data, tmpFile);
  try {
    commitDurableFile(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
}

function atomicCopyFile(source, target) {
  const tmp = target + '.awb-tmp-' + process.pid + '-' + crypto.randomUUID().slice(0, 8);
  try {
    fs.copyFileSync(source, tmp);
    try {
      const fd = fs.openSync(tmp, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch { /* fsync 失败不阻塞备份 */ }
    try {
      fs.renameSync(tmp, target);
    } catch {
      fs.copyFileSync(tmp, target);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function readStore() {
  const file = storeFile();
  const parse = (target) => {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, ''));
    if (!parsed || !Array.isArray(parsed.projects)) throw new Error('状态文件缺少 projects 数组');
    return normalizeStore({ ...emptyStore(), ...parsed });
  };
  if (!fs.existsSync(file)) {
    // 正式文件被外部删除但备份还在时，尽量恢复；没有任何文件才是真正的空库。
    const bak = file + '.bak';
    let corruptFiles = [];
    try {
      corruptFiles = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(path.basename(file) + '.corrupt-'));
    } catch { /* ignore */ }
    if (fs.existsSync(bak)) {
      try {
        const restored = parse(bak);
        atomicWriteFile(file, fs.readFileSync(bak), file + '.tmp');
        storeFatal = false;
        storeWarning = {
          code: 'STORE_RESTORED',
          message: '状态文件缺失，已从备份恢复：' + path.basename(bak),
          file: bak,
          backupUsed: path.basename(bak)
        };
        return restored;
      } catch {
        storeFatal = corruptFiles.length > 0;
        storeWarning = {
          code: 'STORE_RESTORE_FAILED',
          message: corruptFiles.length ? '状态文件缺失、备份不可用，且存在损坏副本；写入已阻止' : '状态文件缺失且备份不可用',
          file: corruptFiles.length ? path.join(path.dirname(file), corruptFiles[0]) : bak
        };
        return emptyStore();
      }
    }
    if (corruptFiles.length) {
      storeFatal = true;
      storeWarning = {
        code: 'STORE_RESTORE_FAILED',
        message: '检测到已隔离的损坏状态文件，但没有可用备份；写入已阻止：' + corruptFiles[0],
        file: path.join(path.dirname(file), corruptFiles[0])
      };
      return emptyStore();
    }
    return emptyStore();
  }
  try {
    const ok = parse(file);
    storeFatal = false;
    return ok;
  } catch (e) {
    const corrupt = file + '.corrupt-' + storeStamp();
    let isolated = true;
    try { fs.renameSync(file, corrupt); } catch { isolated = false; /* 保留原文件，仍禁止写入 */ }
    storeWarning = {
      code: 'STORE_CORRUPT',
      message: (isolated ? '状态文件损坏，已隔离为 ' : '状态文件损坏，隔离失败（文件被占用）：') + path.basename(isolated ? corrupt : file),
      file: isolated ? corrupt : file
    };
    const bak = file + '.bak';
    if (fs.existsSync(bak)) {
      try {
        const restored = parse(bak);
        // 恢复也必须原子落盘，避免“恢复过程中再次断电”把主文件写坏。
        atomicWriteFile(file, fs.readFileSync(bak), file + '.tmp');
        storeFatal = false;
        storeWarning.backupUsed = path.basename(bak);
        return restored;
      } catch { /* backup also bad */ }
    }
    storeFatal = true;
    return emptyStore();
  }
}

function writeStore(store) {
  if (storeFatal) throw new Error('状态文件损坏且没有可用备份，已阻止写入；请先处理 workbench.json.corrupt-*');
  const file = storeFile();
  const body = JSON.stringify(store, null, 2) + '\n';
  const tmp = file + '.tmp';
  writeDurableFile(file, body, tmp);
  try {
    // 保留上一版完整备份：复制当前正式文件，复制/落盘失败则中止本次写入，避免无备份覆盖。
    if (fs.existsSync(file)) atomicCopyFile(file, file + '.bak');
    commitDurableFile(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
  storeWarning = null;
}

function now() { return new Date().toISOString(); }
function id(prefix) { return prefix + '-' + crypto.randomUUID().slice(0, 8); }
function cleanName(value) { return String(value || '').trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 60); }

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

/**
 * 旧版提案/提交的字段兼容。
 *
 * 旧记录（上一版工作台写入）是这样的：
 *   提案 {id,title,author,fileRel,fileSize,hash,existed,stagedContent,status,reviews,signature,applied,commitId}
 *   提交 {id,proposalId,fileRel,backupPath,existed,at}
 * 没有 baseHash / contentHash / afterHash / backupHash。这里只在字段缺失时补推导值，
 * 推不出来的就保持 undefined，让 apply/rollback 明确拒绝，而不是静默覆盖文件。
 * 团队工具旧协议的提案还有 files[{target,baseHash,newHash,size}] / rationale / risk / task。
 */
function normalizeVerdict(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'approve' || v === 'approved' || v === 'pass') return 'approve';
  if (v === 'reject' || v === 'rejected' || v === 'fail') return 'reject';
  return v;
}

function normalizeSignature(value) {
  if (!value || typeof value !== 'object') return null;
  const decision = String(value.decision || value.verdict || '').toLowerCase();
  if (!['approve', 'approved', 'reject', 'rejected'].includes(decision)) return null;
  return {
    by: String(value.by || value.role || 'pm'),
    decision: normalizeVerdict(decision) === 'approve' ? 'approved' : 'rejected',
    note: String(value.note ?? value.comment ?? '').slice(0, 500),
    at: value.at || value.ts || null
  };
}

function normalizeReviews(value) {
  const rows = Array.isArray(value)
    ? value
    : (value && typeof value === 'object' ? Object.entries(value).map(([role, row]) => ({ role, ...(row || {}) })) : []);
  return rows.filter((row) => row && typeof row === 'object').map((row) => ({
    role: String(row.role || row.by || ''),
    verdict: normalizeVerdict(row.verdict),
    comment: String(row.comment ?? row.comments ?? '').slice(0, 600),
    at: row.at || row.ts || null
  }));
}

function normalizeProposal(proposal) {
  if (!proposal || typeof proposal !== 'object') return null;
  const files = Array.isArray(proposal.files) ? proposal.files.filter((file) => file && file.target) : [];
  const first = files[0] || null;
  if (!proposal.fileRel && first) proposal.fileRel = String(first.target).replace(/\\/g, '/');
  if (proposal.fileSize === undefined && first && Number.isFinite(Number(first.size))) proposal.fileSize = Number(first.size);
  if (proposal.contentHash === undefined || proposal.contentHash === null) {
    proposal.contentHash = proposal.hash || (first && first.newHash) || null;
  }
  if (proposal.hash === undefined || proposal.hash === null) proposal.hash = proposal.contentHash;
  if (proposal.baseHash === undefined || proposal.baseHash === 'undefined') {
    if (first && first.baseHash !== undefined) proposal.baseHash = first.baseHash === 'absent' ? null : String(first.baseHash);
    else if (proposal.existed === false && proposal.contentHash) proposal.baseHash = null; // 当时文件不存在，base 可确定为 absent
    // 其他情况保持 undefined：apply 会要求重新评审，不猜旧版本。
  } else if (proposal.baseHash === 'absent') {
    proposal.baseHash = null;
  }
  const applied = Boolean(proposal.applied || proposal.status === 'applied' || proposal.appliedAt);
  const statusMap = { proposed: 'review', reviewing: 'review', reviewed: 'review', signing: 'review', stale: 'rejected', applied: 'approved' };
  if (statusMap[proposal.status]) proposal.status = statusMap[proposal.status];
  if (!proposal.status) proposal.status = applied ? 'approved' : 'review';
  proposal.reviews = normalizeReviews(proposal.reviews);
  if (!proposal.signature) {
    if (proposal.signatures && typeof proposal.signatures === 'object') {
      proposal.signature = normalizeSignature(proposal.signatures.pm || Object.values(proposal.signatures).find((row) => row && normalizeSignature(row)));
    } else {
      proposal.signature = normalizeSignature(proposal.signature);
    }
  } else {
    proposal.signature = normalizeSignature(proposal.signature);
  }
  proposal.applied = applied;
  proposal.commitId = proposal.commitId || null;
  if (proposal.risk === undefined) proposal.risk = null;
  if (proposal.rationale === undefined) proposal.rationale = '';
  return proposal;
}

function normalizeCommit(commit, proposalById) {
  if (!commit || typeof commit !== 'object') return null;
  const before = Array.isArray(commit.before) ? commit.before[0] : null;
  const after = Array.isArray(commit.after) ? commit.after[0] : null;
  if (!commit.fileRel) {
    if (commit.target) commit.fileRel = String(commit.target);
    else if (before && before.target) commit.fileRel = String(before.target);
  }
  if (commit.fileRel) commit.fileRel = String(commit.fileRel).replace(/\\/g, '/');
  if (!commit.fileRel) return null; // 没有文件路径的提交无法回滚，直接跳过，避免后续 resolve 抛 TypeError
  if (commit.backupPath === undefined) commit.backupPath = before && before.backup ? String(before.backup) : '';
  if (commit.backupHash === undefined && before && before.hash && before.hash !== 'absent') commit.backupHash = String(before.hash);
  if (commit.baseHash === undefined && before && before.hash) commit.baseHash = before.hash === 'absent' ? null : String(before.hash);
  if (commit.backupHash === undefined || commit.backupHash === null) commit.backupHash = null;
  if (commit.baseHash === undefined) commit.baseHash = null;
  if (commit.afterHash === undefined || commit.afterHash === null) {
    if (after && after.hash) commit.afterHash = String(after.hash);
    else {
      // 旧提交没有 afterHash：用提案里“应用后的内容哈希”补，仍推不出就保持 undefined。
      const proposal = proposalById && proposalById.get(commit.proposalId);
      commit.afterHash = (proposal && (proposal.contentHash || proposal.hash)) || undefined;
    }
  }
  if (commit.existed === undefined) commit.existed = before ? Boolean(before.existed) : false;
  if (commit.at === undefined) commit.at = commit.createdAt || null;
  return commit;
}

/**
 * 旧评审协议（team.mjs）成功后，把 proposal 镜像进本地 proposals[]，供界面/看板读取。
 * 真相仍在 team.mjs 的 提案/评审/签字/提交 文件里；本地行只做只读镜像，
 * 因此 protocol='legacy'，本地 proposal:* 写操作会明确返回 LEGACY_PROTOCOL_REQUIRED。
 */
function mirrorLegacyProposal(projectId, result) {
  const view = result && result.proposal ? result.proposal : null;
  if (!view || !view.id) return null;
  const store = readStore();
  const project = store.projects.find((item) => item.id === projectId);
  if (!project) return null;
  project.proposals = Array.isArray(project.proposals) ? project.proposals : [];
  const reviewRows = (Array.isArray(result.reviews) ? result.reviews : []).map((row) => ({
    role: String(row.role || row.by || ''),
    verdict: normalizeVerdict(row.verdict),
    comment: String(row.comments !== undefined ? row.comments : (row.comment || '')).slice(0, 600),
    at: row.ts || row.at || null
  })).filter((row) => row.role);
  const signatureRows = Array.isArray(result.signatures) ? result.signatures : [];
  const pmSignature = signatureRows.find((row) => String(row.role || row.by || '') === 'pm') || signatureRows[0] || result.signature || null;
  const files = (Array.isArray(view.files) ? view.files : []).map((file) => ({
    target: String(file.target || '').replace(/\\/g, '/'),
    baseHash: file.baseHash === undefined ? null : file.baseHash,
    newHash: file.newHash || null,
    size: Number(file.size || 0),
    staged: file.staged || null
  }));
  const first = files[0] || {};
  const row = {
    id: String(view.id),
    legacyId: String(view.id),
    protocol: 'legacy',
    legacyStatus: String(result.legacyStatus || view.legacyStatus || view.status || ''),
    title: String(view.title || ''),
    author: String(view.author || result.role || ''),
    task: String(view.task || ''),
    rationale: String(view.rationale || ''),
    risk: String(view.risk || 'normal'),
    files,
    fileRel: first.target || '',
    fileSize: first.size || 0,
    hash: String(view.hash || view.proposalHash || first.newHash || ''),
    contentHash: first.newHash || null,
    baseHash: first.baseHash === 'absent' ? null : (first.baseHash === undefined ? null : first.baseHash),
    existed: first.baseHash !== 'absent' && first.baseHash !== null && first.baseHash !== undefined,
    stagedContent: null,
    status: String(result.status || view.status || 'review'),
    stage: String(result.stage || view.stage || ''),
    flow: result.flow || view.flow || null,
    reviews: reviewRows,
    signature: pmSignature ? normalizeSignature({
      ...pmSignature,
      by: pmSignature.role || pmSignature.by || 'pm',
      decision: pmSignature.decision || pmSignature.verdict,
      at: pmSignature.ts || pmSignature.at || null
    }) : null,
    applied: Boolean(view.applied),
    commitId: view.commitId || (result.commit && result.commit.id) || null,
    createdAt: view.createdAt || now(),
    updatedAt: now()
  };
  const existing = project.proposals.find((item) => item.legacyId === row.legacyId || item.id === row.id);
  if (existing) Object.assign(existing, row);
  else project.proposals.push(row);
  addEvent(project, `旧评审协议 ${result.action || 'action'} ${row.id}（${row.legacyStatus} → ${row.status}）`);
  writeStore(store);
  return row;
}

/** 本地 proposal:* 不能改旧协议提案；需要写就走 proposal:legacy。 */
function rejectLocalWriteOnLegacyProposal(proposal, action) {
  if (!proposal || (proposal.protocol !== 'legacy' && !proposal.legacyId)) return;
  throw codedError(
    'LEGACY_PROTOCOL_REQUIRED',
    `提案 ${proposal.id} 由旧评审协议（team.mjs）管理，不能用本地 proposal:${action}；`
    + `请调用 proposal:legacy 的 ${action} 动作（propose→show→review→sign→apply）`
  );
}

function normalizeProjectRecord(project) {
  if (!project || typeof project !== 'object') return project;
  for (const key of ['tasks', 'messages', 'proposals', 'commits', 'events']) {
    if (!Array.isArray(project[key])) project[key] = [];
  }
  project.pendingAck = project.pendingAck || null;
  project.pendingAckAt = project.pendingAckAt || null;
  // 旧项目没有 teamMode：一律按 full 兼容；Fast 项目明确写 fast。
  project.teamMode = normalizeTeamMode(project.teamMode);
  if (!Array.isArray(project.votes)) project.votes = [];
  project.ownerReview = project.ownerReview || { status: 'optional', opinion: '', at: null };
  project.proposals = project.proposals.map(normalizeProposal).filter(Boolean);
  const byId = new Map(project.proposals.map((proposal) => [proposal.id, proposal]));
  project.commits = project.commits.map((commit) => normalizeCommit(commit, byId)).filter(Boolean);
  if (project.sessions !== undefined && (project.sessions === null || typeof project.sessions !== 'object' || Array.isArray(project.sessions))) {
    project.sessions = {};
  }
  // 映射字段：旧记录只有 dshWorkspaceId / 没有 workspace，一律补成统一形状。
  if (project.workspace !== undefined && project.workspace !== null && (typeof project.workspace !== 'object' || Array.isArray(project.workspace))) {
    project.workspace = null;
  }
  if (!project.workspace) {
    const legacyId = project.dshWorkspaceId ? String(project.dshWorkspaceId) : '';
    project.workspace = {
      id: legacyId || null,
      path: project.workspacePath || project.path || null,
      name: project.teamName || project.name || null,
      engineUrl: null,
      bound: Boolean(legacyId),
      pending: false,
      created: null,
      boundAt: null,
      sessionIds: [],
      lastError: null
    };
  }
  if (!Array.isArray(project.workspace.sessionIds)) project.workspace.sessionIds = [];
  if (project.workspace.sessionIds.length) project.workspace.sessionIds = project.workspace.sessionIds.map(String);
  if (project.sessionMeta !== undefined && (project.sessionMeta === null || typeof project.sessionMeta !== 'object' || Array.isArray(project.sessionMeta))) {
    project.sessionMeta = {};
  }
  if (!project.sessionMeta) project.sessionMeta = {};
  return project;
}

function normalizeStore(store) {
  if (store && Array.isArray(store.projects)) store.projects = store.projects.filter(Boolean).map(normalizeProjectRecord);
  return store;
}

function deriveStage(project) {
  const tasks = Array.isArray(project.tasks) ? project.tasks : [];
  if (!tasks.length) return 'intake';
  const owner = project.ownerReview || {};
  if (owner.status === 'rejected') return 'requirement';
  // Owner 闸门先于收口：任务全部完成也不能绕过未决的 Owner。
  if (!['approved', 'skipped'].includes(owner.status)) return 'owner';
  // 旧流程的“产品评审”阶段：Owner 已放行且仍有提案在评审中。
  const proposals = Array.isArray(project.proposals) ? project.proposals : [];
  if (proposals.some((proposal) => proposal.status === 'review')) return 'review';
  const open = tasks.filter((t) => t.status !== 'done');
  if (!open.length) return 'close';
  if (tasks.some((t) => t.role === 'tester' && t.status !== 'done')) return 'test';
  if (tasks.some((t) => ['programmer1', 'programmer2'].includes(t.role) && t.status !== 'done')) return 'dev';
  return 'dispatch';
}

function publicProject(project) {
  project.messages = Array.isArray(project.messages) ? project.messages : [];
  project.proposals = Array.isArray(project.proposals) ? project.proposals : [];
  project.commits = Array.isArray(project.commits) ? project.commits : [];
  project.pendingAck = project.pendingAck || null;
  project.pendingAckAt = project.pendingAckAt || null;
  // 超过 TTL 的派单锁只在展示层视为已释放；下次派单/回执会真正清掉并落盘。
  if (project.pendingAck && pendingAckExpired(project)) {
    project.pendingAck = null;
    project.pendingAckAt = null;
  }
  let exists = false;
  try { exists = fs.statSync(project.path).isDirectory(); } catch { /* 目录被删/移走 */ }
  // 旧协议消费者按 files[] 读提案，这里补一份同形视图（不写库）。
  const proposals = project.proposals.map((proposal) => ({
    ...proposal,
    // 旧记录可能没有 hash：界面会直接 slice，这里保证是字符串。
    hash: proposal.hash || proposal.contentHash || '',
    files: Array.isArray(proposal.files) && proposal.files.length
      ? proposal.files
      : (proposal.fileRel ? [{
        target: proposal.fileRel,
        baseHash: proposal.baseHash === null || proposal.baseHash === undefined ? 'absent' : proposal.baseHash,
        newHash: proposal.contentHash || proposal.hash || null,
        size: proposal.fileSize || 0,
        staged: null
      }] : [])
  }));
  const flow = workflowSnapshot(project);
  return {
    ...project,
    proposals,
    exists,
    // 团队模式与角色清单显式暴露：Fast 只有 4 个角色，界面/测试不按六角色硬编码。
    teamMode: normalizeTeamMode(project.teamMode),
    roleIds: roleIdsForProject(project),
    teamModeLabel: (TEAM_MODE_BY_ID.get(normalizeTeamMode(project.teamMode)) || {}).label || '',
    // 阶段/需求/任务/boot 以旧团队状态为准；本地 tasks 只在未登记团队时兜底。
    stage: flow.stage || deriveStage(project),
    phase: flow.phase || null,
    round: flow.round || 1,
    requirements: Array.isArray(flow.requirements) ? flow.requirements : [],
    nextRound: Array.isArray(flow.nextRound) ? flow.nextRound : [],
    workflow: flow.workflow ? {
      phase: flow.phase,
      round: flow.round,
      ownerReview: flow.ownerReview,
      boots: flow.boots || {},
      nextRound: flow.nextRound || [],
      file: flow.file,
      legacy: flow.legacy || null,
      counts: flow.counts || null,
      updatedAt: flow.updatedAt || null
    } : null,
    ownerReview: flow.ownerReview || project.ownerReview || { status: 'optional', opinion: '', at: null },
    // 映射显式暴露给界面/测试：项目 → 工作区 → 六角色会话。
    workspace: workspaceOf(project),
    mapping: publicMapping(project)
  };
}

function reconcileExternalAck(store, project) {
  if (!project || !project.pendingAck) return false;
  const targetStore = store || readStore();
  const result = reconcileProjectCommStates(targetStore, { projectId: project.id, force: true });
  if (!result.changed) return false;
  const current = targetStore.projects.find((row) => row.id === project.id);
  if (!current) return false;
  const message = (current.messages || []).find((row) => row.id === project.pendingAck);
  return Boolean(message && message.ack);
}

function reconcileExpiredLocks(store) {
  let changed = 0;
  for (const project of store.projects) {
    if (project.pendingAck && pendingAckExpired(project)) {
      const pendingId = project.pendingAck;
      // 超时释放本地锁时同步释放旧 派单锁.json；释放失败就保留本地锁，
      // 不能让“本地清了、旧锁还在”把下一次派单永久卡在 PM_DISPATCH_PENDING。
      const released = releaseOldDispatchLock(project, pendingId);
      if (!released.ok && released.code !== 'NO_LOCK' && released.code !== 'TEAM_TOOL_UNAVAILABLE') {
        const warning = { code: released.code || 'OLD_LOCK_RELEASE_FAILED', message: released.message || '旧派单锁未释放', at: now() };
        const previous = project.pendingAckWarning;
        if (!previous || previous.code !== warning.code || previous.message !== warning.message) {
          project.pendingAckWarning = warning;
          addEvent(project, `旧派单锁未释放：${warning.code}`);
          changed += 1;
        }
        continue;
      }
      clearPendingAck(project, `派单锁超过 ${Math.round(ACK_TTL_MS / 60000)} 分钟，自动释放${released && released.removed ? '（旧派单锁已释放）' : ''}`);
      if (project.pendingAckWarning) delete project.pendingAckWarning;
      changed += 1;
    }
  }
  if (changed) {
    try { writeStore(store); } catch { /* 落盘失败时仍返回投影后的状态 */ }
  }
  return changed;
}

/**
 * 状态投影。默认会顺手对账（过期派单锁 / 旧协议 read-ack），这两步都可能写 workbench.json /
 * 旧派单锁；dry-run 预览必须“只看不写”，所以传 readOnly:true 时跳过全部对账与落盘。
 */
function statePayload(options = {}) {
  const readOnly = options && options.readOnly === true;
  const store = readStore();
  if (!readOnly) {
    reconcileExpiredLocks(store);
    // 每次状态刷新顺带对账一次旧协议现场：角色自己 read/ack 后，界面无需手动点“刷新回执”。
    // 1 秒缓存避免频繁读回执尾部；team:comm / team:reconcile 会强制对账。
    reconcileProjectCommStatesCached(store);
  }
  const active = store.projects.find((p) => p.id === store.activeProjectId) || store.projects[0] || null;
  return {
    version: APP_VERSION,
    roles: ROLES,
    teamModes: TEAM_MODES.map((mode) => ({ ...mode, roleIds: mode.roleIds.slice() })),
    defaultTeamMode: DEFAULT_TEAM_MODE,
    stages: STAGES,
    projects: store.projects.map(publicProject),
    activeProjectId: active ? active.id : null,
    defaultRoot: path.join(ROOT, '项目'),
    dsh: dsh.statusSync(),
    team: teamTools.quickInfo(),
    // 当前项目 ↔ DSH 工作区 ↔ 六角色会话 的映射（只读）。
    mapping: publicMapping(active),
    storeError: storeWarning ? { ...storeWarning, fatal: storeFatal } : null
  };
}

function projectTemplate(name) {
  return `# ${name}\n\n## 目标\n\n（待项目经理填写）\n\n## 交付\n\n- 代码目录：src/\n- 角色文档：各角色目录\n- 临时文件：_tmp/（交付前清理）\n\n## 边界\n\n（待填写）\n`;
}

function isInsidePath(parent, child) {
  const p = path.resolve(parent).toLowerCase();
  const c = path.resolve(child).toLowerCase();
  return c === p || c.startsWith(p + path.sep);
}

/**
 * 路径相等判断：优先 realpath（跟随 junction/symlink），目录不存在时退回 path.resolve。
 * Windows 大小写不敏感，统一转小写比较；绝不把“字符串前缀”当归属证明。
 */
function realPathOf(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const resolved = path.resolve(raw);
  try { return fs.realpathSync.native(resolved).toLowerCase(); } catch { /* 目录不存在/无权限 */ }
  try { return fs.realpathSync(resolved).toLowerCase(); } catch { /* 再退一步 */ }
  return resolved.toLowerCase();
}

function sameResolvedPath(a, b) {
  const left = realPathOf(a);
  const right = realPathOf(b);
  return Boolean(left && right && left === right);
}

// 本地数据目录不能当项目：否则状态库/团队状态会被扫描进项目文件树。
function guardNotDataDir(target) {
  if (isInsidePath(LOCAL_DATA, target)) {
    throw new Error('不能把工作台数据目录设成项目：' + LOCAL_DATA);
  }
}

// ==========================================================================
// 只读文件预览（files:read）与项目/会话身份核验
// ==========================================================================
const FILE_TEXT_MAX_BYTES = 512 * 1024;
const FILE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const FILE_TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdx', '.txt', '.text', '.log', '.json', '.json5', '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.jsx', '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg', '.yml', '.yaml',
  '.toml', '.ini', '.conf', '.cfg', '.csv', '.tsv', '.sql', '.py', '.ps1', '.cmd', '.bat', '.sh',
  '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.vue', '.gitignore', '.env', '.editorconfig'
]);
const FILE_MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);
const FILE_IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp'
};

function fileAccessError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/** 只允许读取项目根目录内的普通文件；符号链接解析后仍必须在根内。 */
function resolveProjectFile(project, rel) {
  const rootCandidate = path.resolve(String((project && project.path) || ''));
  let root;
  try {
    root = fs.realpathSync(rootCandidate);
  } catch {
    throw fileAccessError('PROJECT_DIR_MISSING', '项目目录不存在：' + rootCandidate);
  }
  let requested = String(rel == null ? '' : rel).trim();
  if (!requested) throw fileAccessError('FILE_PATH_REQUIRED', '文件路径不能为空');
  if (requested.includes('\0')) throw fileAccessError('FILE_PATH_INVALID', '文件路径包含非法字符');
  requested = requested.replace(/\\/g, '/');
  const target = path.resolve(root, requested);
  if (!isInsidePath(root, target)) {
    throw fileAccessError('FILE_PATH_OUTSIDE', '路径越界：只能读取当前项目目录内的文件');
  }
  if (!fs.existsSync(target)) throw fileAccessError('FILE_NOT_FOUND', '文件不存在：' + requested);
  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    throw fileAccessError('FILE_NOT_FOUND', '文件不存在：' + requested);
  }
  if (!isInsidePath(root, real)) {
    throw fileAccessError('FILE_PATH_OUTSIDE', '路径越界：符号链接指向项目目录外');
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw fileAccessError('FILE_NOT_FILE', '不是普通文件：' + requested);
  return {
    root,
    target: real,
    rel: path.relative(root, real).replace(/\\/g, '/'),
    stat,
    ext: path.extname(real).toLowerCase()
  };
}

/** 文本/Markdown/图片只读读取；大小超限或二进制内容一律结构化拒绝。 */
function readProjectFile(project, rel, options = {}) {
  const resolved = resolveProjectFile(project, rel);
  const textMax = Number(options.textMaxBytes) > 0 ? Number(options.textMaxBytes) : FILE_TEXT_MAX_BYTES;
  const imageMax = Number(options.imageMaxBytes) > 0 ? Number(options.imageMaxBytes) : FILE_IMAGE_MAX_BYTES;
  const mime = FILE_IMAGE_MIME[resolved.ext];
  if (mime) {
    if (resolved.stat.size > imageMax) {
      throw fileAccessError('FILE_TOO_LARGE', `图片超过安全上限（${resolved.stat.size} > ${imageMax} 字节）`, { size: resolved.stat.size, limit: imageMax });
    }
    const buffer = fs.readFileSync(resolved.target);
    return {
      ok: true,
      kind: 'image',
      rel: resolved.rel,
      name: path.basename(resolved.target),
      size: resolved.stat.size,
      mime,
      dataUrl: 'data:' + mime + ';base64,' + buffer.toString('base64'),
      truncated: false
    };
  }
  if (!FILE_TEXT_EXTENSIONS.has(resolved.ext)) {
    throw fileAccessError('FILE_TYPE_UNSUPPORTED', `不支持预览的文件类型：${resolved.ext || '（无扩展名）'}`, { ext: resolved.ext });
  }
  if (resolved.stat.size > textMax) {
    throw fileAccessError('FILE_TOO_LARGE', `文本超过安全上限（${resolved.stat.size} > ${textMax} 字节）`, { size: resolved.stat.size, limit: textMax });
  }
  const buffer = fs.readFileSync(resolved.target);
  if (buffer.includes(0)) {
    throw fileAccessError('FILE_TYPE_UNSUPPORTED', '检测到二进制内容，不能按文本读取');
  }
  const text = buffer.toString('utf8');
  return {
    ok: true,
    kind: FILE_MARKDOWN_EXTENSIONS.has(resolved.ext) ? 'markdown' : 'text',
    rel: resolved.rel,
    name: path.basename(resolved.target),
    size: resolved.stat.size,
    mime: 'text/plain; charset=utf-8',
    text,
    lines: text ? text.split(/\r?\n/).length : 0,
    truncated: false
  };
}

function sessionInProjectWorkspace(project, session) {
  if (!session) return false;
  const workspace = workspaceOf(project);
  const sessionId = String(session.sessionId || '');
  const projectPath = project.path ? path.resolve(String(project.path)) : '';
  const workspacePath = workspace.path ? path.resolve(String(workspace.path)) : '';
  // workspace 自身绑定的目录必须就是当前项目；否则 workspaceId 命中也不能放行。
  if (projectPath && workspacePath && !sameResolvedPath(workspacePath, projectPath)) return false;
  const sessionWorkspace = sessionWorkspaceId(session);
  const sessionCwd = session.cwd ? path.resolve(String(session.cwd)) : '';
  const cwdMatches = Boolean(sessionCwd && projectPath && sameResolvedPath(sessionCwd, projectPath));
  if (workspace.id && sessionWorkspace) {
    if (sessionWorkspace !== workspace.id) return false;
    // workspaceId 相同还不够：会话 cwd 有值时必须是当前项目目录。
    return sessionCwd ? cwdMatches : true;
  }
  const snapshot = Array.isArray(project.workspace && project.workspace.sessionIds)
    ? project.workspace.sessionIds.map(String)
    : [];
  if (snapshot.includes(sessionId)) return sessionCwd ? cwdMatches : true;
  return cwdMatches;
}

/**
 * send/ack 前的会话身份核验：
 *   1) sessionId 必须等于当前项目 project.sessions[role] 的映射；
 *   2) DSH 里该会话必须存在、未归档；
 *   3) 会话必须属于当前项目的 DSH 工作区（workspaceId / 成员快照 / cwd 三选一）。
 * 核验失败返回结构化 code，由 IPC 直接拒绝，绝不回退到全局名册。
 */
async function verifyProjectRoleSession(project, role, claimedSession = '', options = {}) {
  const workspace = workspaceOf(project);
  // 绑定记录本身可能被旧清单污染：workspace.path 与项目目录不一致时，先拒绝再谈会话。
  if (project.path && workspace.path && !sameResolvedPath(workspace.path, project.path)) {
    return {
      ok: false,
      code: 'WORKSPACE_PATH_MISMATCH',
      message: `项目工作区绑定指向另一个目录（${workspace.path} ≠ ${project.path}），请先重新绑定 DSH 工作区`
    };
  }
  const sessions = project && project.sessions && typeof project.sessions === 'object' ? project.sessions : {};
  const mapped = sessions[role] ? String(sessions[role]) : '';
  const claimed = String(claimedSession || '').trim();
  if (!mapped) {
    return { ok: false, code: 'SESSION_IDENTITY_MISSING', message: `角色「${role}」在当前项目没有真实 DSH 会话，不能写入旧协议` };
  }
  if (claimed && claimed !== mapped) {
    return {
      ok: false,
      code: 'SESSION_IDENTITY_MISMATCH',
      message: `会话 ${claimed} 不是角色「${role}」在当前项目的映射会话 ${mapped}`
    };
  }
  let remote;
  try {
    remote = await dsh.listSessions({ timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 6000 });
  } catch (error) {
    const code = String((error && error.code) || 'DSH_OFFLINE');
    return { ok: false, code, message: '无法向 DSH 核验会话归属：' + String((error && error.message) || error).slice(0, 200) };
  }
  const session = remote.find((item) => String(item.sessionId) === mapped);
  if (!session) {
    return { ok: false, code: 'SESSION_IDENTITY_MISSING', message: `角色「${role}」的映射会话 ${mapped} 在 DSH 里已不存在` };
  }
  if (session.archived) {
    return { ok: false, code: 'SESSION_IDENTITY_ARCHIVED', message: `角色「${role}」的映射会话 ${mapped} 已归档` };
  }
  if (!sessionInProjectWorkspace(project, session)) {
    return {
      ok: false,
      code: 'SESSION_IDENTITY_MISMATCH',
      message: `会话 ${mapped} 不属于当前项目工作区 ${workspace.id || '(未绑定)'}`
    };
  }
  return {
    ok: true,
    code: 'OK',
    sessionId: mapped,
    workspaceId: workspace.id,
    checkedAt: now(),
    title: sessionTitleOf(session)
  };
}

/** 释放某条消息对应的旧协议 派单锁.json；本地锁已空时也可按旧锁自身的 messageId 释放残留锁。 */
function releaseOldDispatchLock(project, messageId) {
  if (!project) return { ok: false, code: 'PROJECT_REQUIRED', message: '缺少项目' };
  const tool = teamTools.toolInfo();
  if (!tool.available) return { ok: false, code: 'TEAM_TOOL_UNAVAILABLE', message: '团队工具缺失，无法释放旧派单锁' };
  const teamName = String(project.teamName || project.name || '').trim();
  if (!teamName) return { ok: false, code: 'PROJECT_REQUIRED', message: '缺少团队项目名' };
  let lock = null;
  try {
    lock = teamTools.readDispatchLockState(teamName);
  } catch (error) {
    return { ok: false, code: 'LOCK_READ_FAILED', message: String((error && error.message) || error).slice(0, 200) };
  }
  if (!lock) return { ok: true, code: 'NO_LOCK', removed: false, pending: null };
  const message = Array.isArray(project.messages) ? project.messages.find((item) => item.id === messageId) : null;
  const expected = message && message.teamMessageId ? String(message.teamMessageId) : '';
  if (expected && String(lock.messageId) !== expected) {
    return {
      ok: false,
      code: 'LOCK_MISMATCH',
      message: `旧派单锁属于 ${lock.messageId}，不能释放 ${expected}`,
      pending: { messageId: lock.messageId, to: lock.to, subject: lock.subject }
    };
  }
  // 没有本地消息可对应时（本地 pendingAck 已丢/被清），按旧锁自身 messageId 释放；只删这一把锁。
  return teamTools.releaseDispatchLock(teamName, expected || String(lock.messageId));
}

/** 删除项目时归档它在 DSH 里的六角色会话；只碰本项目的角色会话，不碰用户临时会话。 */
async function archiveProjectRoleSessions(project) {
  const recorded = new Set(Object.values(project.sessions || {}).filter(Boolean).map(String));
  const snapshot = Array.isArray(project.workspace && project.workspace.sessionIds)
    ? project.workspace.sessionIds.map(String)
    : [];
  const candidates = [...new Set([...recorded, ...snapshot])];
  if (!candidates.length) {
    return { ok: true, code: 'NO_SESSIONS', mode: 'archive', archived: [], skipped: [], failed: [] };
  }
  let remote;
  try {
    remote = await dsh.listSessions({ timeoutMs: 6000 });
  } catch (error) {
    return {
      ok: false,
      code: String((error && error.code) || 'DSH_OFFLINE'),
      mode: 'archive',
      message: 'DSH 不可用，未能归档会话：' + String((error && error.message) || error).slice(0, 200),
      archived: [],
      skipped: [],
      failed: candidates.map((sessionId) => ({ sessionId, code: String((error && error.code) || 'DSH_OFFLINE') }))
    };
  }
  const byId = new Map(remote.map((session) => [String(session.sessionId), session]));
  const archived = [];
  const skipped = [];
  const failed = [];
  for (const sessionId of candidates) {
    const session = byId.get(sessionId);
    if (!session) {
      skipped.push({ sessionId, reason: 'not_found' });
      continue;
    }
    if (session.archived) {
      skipped.push({ sessionId, reason: 'already_archived' });
      continue;
    }
    const title = sessionTitleOf(session);
    if (!title.startsWith(SESSION_TITLE_PREFIX) && !recorded.has(sessionId)) {
      skipped.push({ sessionId, reason: 'not_role_session', title });
      continue;
    }
    try {
      await dsh.archiveSession(sessionId);
      archived.push(sessionId);
    } catch (error) {
      failed.push({ sessionId, code: String((error && error.code) || 'ARCHIVE_FAILED'), message: String((error && error.message) || error).slice(0, 160) });
    }
  }
  return {
    ok: failed.length === 0,
    code: failed.length ? 'SESSION_ARCHIVE_PARTIAL' : 'OK',
    mode: 'archive',
    archived,
    skipped,
    failed
  };
}

function readTeamFileSafe() {
  try {
    return JSON.parse(fs.readFileSync(teamTools.layout.teamFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** 创建前快照：回滚要恢复旧登记/当前项目指针，而不是把旧状态一起删掉。 */
function captureProjectCreateSnapshot(teamName, target) {
  const stateDir = path.join(teamTools.layout.projectsDir, teamTools.teamSlug(teamName, 60));
  const team = readTeamFileSafe();
  const store = readStore();
  let targetEmpty = false;
  try { targetEmpty = fs.existsSync(target) && fs.readdirSync(target).length === 0; } catch { /* ignore */ }
  return {
    targetExisted: fs.existsSync(target),
    targetEmpty,
    stateDirExisted: fs.existsSync(stateDir),
    teamFileExisted: fs.existsSync(teamTools.layout.teamFile),
    teamActiveProject: team && Object.prototype.hasOwnProperty.call(team, 'activeProject') ? team.activeProject : null,
    activeProjectId: store.activeProjectId || null,
    currentWorkspace: teamTools.readCurrentWorkspace()
  };
}

function restoreTeamActiveProject(snapshot) {
  if (!snapshot || !snapshot.teamFileExisted) return;
  try {
    const team = readTeamFileSafe();
    if (!team) return;
    team.activeProject = snapshot.teamActiveProject;
    fs.writeFileSync(teamTools.layout.teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
  } catch { /* 回滚不阻断原始错误 */ }
}

/**
 * 回滚“半成品项目”：本地记录、本次新建的旧团队登记、当前工作区指针、项目目录。
 * 只删本次创建/补齐的东西；用户原有目录和旧登记不动。
 */
function rollbackCreatedProject({ projectId, teamName, target, snapshot, createdDir, repaired }) {
  const report = {
    localRecordRemoved: false,
    registrationRemoved: false,
    currentWorkspaceRestored: false,
    directoryRemoved: false,
    repairedRemoved: []
  };
  try {
    const store = readStore();
    const before = store.projects.length;
    store.projects = store.projects.filter((project) => project.id !== projectId);
    if (store.activeProjectId === projectId) {
      const previous = store.projects.find((project) => project.id === snapshot.activeProjectId);
      store.activeProjectId = previous ? previous.id : (store.projects[0] ? store.projects[0].id : null);
    }
    if (store.projects.length !== before) {
      writeStore(store);
      report.localRecordRemoved = true;
    }
  } catch { /* 继续做文件回滚 */ }
  const stateDir = path.join(teamTools.layout.projectsDir, teamTools.teamSlug(teamName, 60));
  if (!snapshot.stateDirExisted) {
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
      report.registrationRemoved = true;
    } catch { /* ignore */ }
  }
  restoreTeamActiveProject(snapshot);
  try {
    if (snapshot.currentWorkspace) {
      teamTools.setCurrentWorkspace(snapshot.currentWorkspace);
      report.currentWorkspaceRestored = true;
    } else if (fs.existsSync(teamTools.layout.currentWorkspaceFile)) {
      const current = teamTools.readCurrentWorkspace();
      if (current && current.path && path.resolve(String(current.path)).toLowerCase() === path.resolve(target).toLowerCase()) {
        fs.rmSync(teamTools.layout.currentWorkspaceFile, { force: true });
        report.currentWorkspaceRestored = true;
      }
    }
  } catch { /* ignore */ }
  for (const role of ROLES) teamTools.dropBootToken(teamName, role.id);
  if (createdDir) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      report.directoryRemoved = true;
    } catch { /* ignore */ }
  } else if (Array.isArray(repaired) && repaired.length) {
    // 目录原本就存在：只清掉 ensure 本次补出来的文件，再删空的目录。
    for (const rel of [...repaired].reverse()) {
      const abs = path.join(target, String(rel).replace(/\/$/, ''));
      try {
        if (String(rel).endsWith('/')) {
          if (fs.existsSync(abs) && fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
        } else if (fs.existsSync(abs)) {
          fs.unlinkSync(abs);
        }
        report.repairedRemoved.push(rel);
      } catch { /* ignore */ }
    }
  }
  return report;
}

/**
 * 项目创建硬顺序（不再先写本地库）：
 *   1) 建项目目录 → 旧 workspace.mjs ensure 建六角色目录/角色卡/索引/铁律/协作准则/需求总览；
 *   2) 结构校验通过后才写本地 workbench.json 记录（本地只是镜像/索引，不是业务真相）；
 *   3) 最后登记 DSH 工作区；登记失败 → 回滚本次目录、本地记录、旧团队登记、当前项目指针。
 */
async function createProject(payload) {
  const name = cleanName(payload && payload.name);
  if (!name) throw new Error('项目名不能为空');
  // 团队模式默认 full；Fast 只建 4 个角色会话/目录。
  const teamMode = normalizeTeamMode(payload && (payload.teamMode || payload.mode));
  const root = path.resolve(String((payload && payload.root) || path.join(ROOT, '项目')));
  const target = path.resolve(String((payload && payload.path) || path.join(root, name)));
  guardNotDataDir(target);
  const store = readStore();
  if (store.projects.some((p) => p.path.toLowerCase() === target.toLowerCase())) {
    throw new Error('这个目录已经是工作台项目');
  }
  if (store.projects.some((p) => String(p.name || '').toLowerCase() === name.toLowerCase())) {
    throw new Error('已有同名项目：' + name + '；请换一个名字');
  }
  // 团队登记也是“项目身份”的一部分：同名不同目录必须在写入前明确拒绝，
  // 不能交给 ensure 静默哈希成 名字-xxxxxx。
  const registrationByName = findTeamRegistrationByName(name);
  if (registrationByName && registrationByName.path && path.resolve(String(registrationByName.path)).toLowerCase() !== target.toLowerCase()) {
    throw projectNameConflict(name, registrationByName.path);
  }
  const registrationByPath = findTeamRegistrationByPath(target);
  if (registrationByPath && String(registrationByPath.name || '').toLowerCase() !== name.toLowerCase()) {
    throw projectNameConflict(String(registrationByPath.name), target);
  }
  if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) {
    throw new Error('目标路径已存在且不是目录：' + target);
  }
  if (fs.existsSync(target) && fs.readdirSync(target).length) {
    // 删除记录后重建同一目录：目录里已有工作台项目信息时允许重新登记，不覆盖已有文件。
    const reusable = fs.existsSync(path.join(target, '项目信息.md'));
    if (!reusable) throw new Error('目标目录不是空目录，避免覆盖已有文件');
  }
  const teamName = registrationByPath ? String(registrationByPath.name) : name;
  const snapshot = captureProjectCreateSnapshot(teamName, target);
  const createdDir = !snapshot.targetExisted || snapshot.targetEmpty;
  if (!snapshot.targetExisted) fs.mkdirSync(target, { recursive: true });
  let project = null;
  let repaired = [];
  try {
    project = {
      id: id('P'), name, path: target, teamName, teamMode,
      createdAt: now(), updatedAt: now(),
      ownerReview: { status: 'optional', opinion: '', at: null },
      tasks: [], messages: [], proposals: [], commits: [], votes: [], pendingAck: null, pendingAckAt: null,
      events: [{ at: now(), text: `项目创建（${teamMode}）` }]
    };
    // 1) 先建目录/当前模式角色/索引/铁律/需求总览，全部由旧 workspace.mjs ensure 完成。
    const ensured = await teamTools.ensureProjectReady(project, { name: teamName, engineUrl: dsh.baseUrl, teamMode });
    repaired = ensured && ensured.structure && Array.isArray(ensured.structure.repaired)
      ? ensured.structure.repaired.slice()
      : [];
    if (!ensured.ok || !ensured.structure || ensured.structure.ok !== true) {
      throw codedError(
        (ensured && ensured.code) || 'PROJECT_STRUCTURE_INCOMPLETE',
        (ensured && (ensured.message || ensured.why)) || '项目结构未就绪，拒绝登记本地项目'
      );
    }
    project.teamName = String(ensured.name || teamName);
    // 2) 结构校验通过才写本地记录。
    const fresh = readStore();
    if (fresh.projects.some((p) => p.path.toLowerCase() === target.toLowerCase())) {
      throw codedError('PROJECT_EXISTS', '这个目录已经是工作台项目');
    }
    fresh.projects.push(project);
    fresh.activeProjectId = project.id;
    writeStore(fresh);
    // 3) DSH 工作区登记；失败则回滚，绝不留下“本地有项目、DSH 没登记”的半成品。
    const activation = await activateWorkspace(project, { timeoutMs: 6000 });
    if (!activation.ok) {
      const warning = activation.warnings.find((row) => /DSH|WORKSPACE/i.test(String(row.code || ''))) || null;
      const code = (warning && warning.code) || (activation.workspace && activation.workspace.lastError && activation.workspace.lastError.code)
        || 'DSH_WORKSPACE_CREATE_FAILED';
      throw codedError(code, (warning && warning.message) || 'DSH 工作区登记失败');
    }
    if (!IS_SELFTEST || !(payload && payload.placeholderDocs)) {
      seedProjectDocs(target, project.name, String((payload && (payload.description || payload.desc)) || ''));
    }
    const current = requireProject(readStore(), project.id);
    // 自测沙盘默认写真实项目信息/铁律：旧 team.mjs 的 send/boot 会拒绝占位模板。
    // 需要验证“占位必须被拒绝”的用例显式传 placeholderDocs:true，保留模板。
    if (IS_SELFTEST && !(payload && payload.placeholderDocs)) {
      seedSelftestProjectDocs(target, project.name);
    }
    return {
      ok: true,
      project: publicProject(current),
      team: ensured,
      structure: ensured.structure || null,
      structureOk: true,
      workspace: activation.workspace,
      mapping: publicMapping(current),
      warnings: activation.warnings,
      state: statePayload()
    };
  } catch (error) {
    const rollback = rollbackCreatedProject({
      projectId: project && project.id,
      teamName: project && project.teamName ? project.teamName : teamName,
      target,
      snapshot,
      createdDir,
      repaired
    });
    const err = error instanceof Error ? error : new Error(String(error));
    err.rolledBack = true;
    err.rollback = rollback;
    if (!err.code) err.code = 'PROJECT_CREATE_FAILED';
    if (!/^\[[A-Z0-9_]+\]/.test(String(err.message || ''))) {
      err.message = `[${err.code}] ${err.message || '项目创建失败'}`;
    }
    throw err;
  }
}


function requireProject(store, projectId) {
  if (projectId) {
    const exact = store.projects.find((p) => p.id === projectId);
    if (!exact) throw new Error('项目不存在');
    return exact;
  }
  const project = store.projects.find((p) => p.id === store.activeProjectId) || store.projects[0];
  if (!project) throw new Error('还没有项目');
  return project;
}

function pickProject(store, payload) {
  const raw = typeof payload === 'string' ? { projectId: payload } : (payload || {});
  let projectId = raw.projectId || raw.id || '';
  if (!projectId) {
    const name = String(raw.project || raw.name || '').trim();
    if (name) {
      const byName = store.projects.find((p) => String(p.name).toLowerCase() === name.toLowerCase());
      if (!byName) throw new Error('项目不存在：' + name);
      return byName;
    }
    return requireProject(store, null);
  }
  const project = store.projects.find((p) => p.id === projectId);
  if (!project) throw new Error('项目不存在');
  return project;
}

// 团队登记（状态/项目/<名字>/项目.json）。旧版按项目名操作，名字和目录名不一定相同。
function readTeamRegistrations() {
  const dir = teamTools.layout.projectsDir;
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const config = JSON.parse(fs.readFileSync(path.join(dir, entry.name, '项目.json'), 'utf8').replace(/^\uFEFF/, ''));
      if (config && config.name) out.push({ ...config, dir: path.join(dir, entry.name) });
    } catch { /* 跳过坏登记 */ }
  }
  return out;
}

function findTeamRegistrationByName(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  return readTeamRegistrations().find((item) => String(item.name || '').toLowerCase() === key) || null;
}

function findTeamRegistrationByPath(target) {
  const key = path.resolve(String(target || '')).toLowerCase();
  return readTeamRegistrations().find((item) => item.path && path.resolve(String(item.path)).toLowerCase() === key) || null;
}

function projectNameConflict(name, otherPath) {
  const error = new Error(`[PROJECT_NAME_CONFLICT] 项目名「${name}」已对应另一个目录：${otherPath}\n同名项目不能指向两个目录；请改名或先删除旧登记`);
  error.code = 'PROJECT_NAME_CONFLICT';
  error.conflict = { name, path: otherPath };
  return error;
}

/** 按旧版“项目名”找项目：先状态库，再团队登记，再仓库 projects/ 磁盘目录（大小写不敏感）。 */
function findProjectByName(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  const stored = readStore().projects.find((project) => String(project.name).toLowerCase() === key);
  if (stored) return { id: stored.id, name: stored.name, path: stored.path, source: 'store' };
  const registration = readTeamRegistrations().find((item) => String(item.name).toLowerCase() === key);
  if (registration && registration.path) {
    return { id: null, name: registration.name, path: path.resolve(String(registration.path)), source: 'team' };
  }
  try {
    const root = path.join(ROOT, '项目');
    const hit = fs.readdirSync(root, { withFileTypes: true }).find((entry) => entry.isDirectory() && entry.name.toLowerCase() === key);
    if (hit) return { id: null, name: hit.name, path: path.join(root, hit.name), source: 'disk' };
  } catch { /* 没有默认项目根 */ }
  return null;
}

/**
 * 团队启动/看板/恢复同时接受两种入参：
 *   - 新版 {projectId}
 *   - 旧版 {project|name, workspace|path}（项目名 + 目录，允许未登记到状态库）
 */
function pickTeamProject(payload) {
  const raw = typeof payload === 'string' ? { projectId: payload } : (payload || {});
  const store = readStore();
  if (raw.projectId) {
    const stored = store.projects.find((project) => project.id === raw.projectId);
    if (!stored) throw new Error('项目不存在');
    return { project: stored, persisted: true };
  }
  const name = String(raw.project || raw.name || '').trim();
  const dir = String(raw.workspace || raw.path || '').trim();
  if (dir) {
    const abs = path.resolve(dir);
    guardNotDataDir(abs);
    const stored = store.projects.find((project) => path.resolve(project.path).toLowerCase() === abs.toLowerCase());
    if (stored) return { project: stored, persisted: true };
    return { project: { id: null, name: cleanName(name) || path.basename(abs), path: abs }, persisted: false };
  }
  if (name) {
    const hit = findProjectByName(name);
    if (!hit) throw new Error('项目不存在：' + name);
    if (hit.id) {
      const stored = store.projects.find((project) => project.id === hit.id);
      if (stored) return { project: stored, persisted: true };
    }
    return { project: { id: null, name: hit.name, path: hit.path }, persisted: false };
  }
  const active = store.projects.find((project) => project.id === store.activeProjectId) || store.projects[0];
  if (!active) throw new Error('还没有项目');
  return { project: active, persisted: true };
}

function currentWorkspaceRecord() {
  try {
    return JSON.parse(fs.readFileSync(teamTools.layout.currentWorkspaceFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch { return null; }
}

function ownerDecide(project, status, opinion, extra = {}) {
  const allowed = ['approved', 'skipped', 'rejected', 'optional'];
  if (!allowed.includes(status)) throw new Error('Owner 状态无效');
  project.ownerReview = {
    status,
    opinion: String(opinion || '').slice(0, 1000),
    at: now(),
    by: String(extra.by || 'Owner'),
    roundKey: extra.roundKey ? String(extra.roundKey) : null
  };
  addEvent(project, `Owner 评审：${status}`);
}

function countRequirements(project) {
  try {
    return fs.readdirSync(path.join(path.resolve(project.path), '需求')).filter((name) => /^R-.*\.md$/.test(name)).length;
  } catch { return 0; }
}

/**
 * 旧版 workflow:get 的返回形状；阶段名沿用新版，另给旧版 bossreview 别名。
 * 有旧团队登记时，阶段/需求/任务/boot 全部从 <团队>/状态/项目/<slug>/ 读；
 * 本地 tasks 只在还没登记团队项目时兜底，绝不覆盖旧协议真相。
 */
function workflowSnapshot(project) {
  const teamName = String(project.teamName || project.name || '').trim();
  let legacyProbe = null;
  if (teamName) {
    try {
      const legacy = teamTools.readWorkflowSnapshot(teamName, project.path);
      if (legacy && legacy.ok) legacyProbe = applyShellOwnedCapsToSnapshot(legacy, project.teamMode);
      // 旧 shell 只写 ownerReview 的 工作流.json 不接管本地流程阶段；
      // 工作台镜像进 任务/ 的本地任务（source=workbench）也不算旧工作流任务。
      // 只有本闭环管理的 schema>=2 文件、旧需求、或旧 CLI 任务，才以旧状态为准。
      const workflowTasks = (legacy && legacy.tasks ? legacy.tasks : []).filter((task) => task
        && (task.type === 'requirement'
          || !task.source
          || task.source !== 'workbench'
          || (task.workflow && typeof task.workflow === 'object' && Object.keys(task.workflow).length)));
      if (legacy && legacy.ok && (legacy.legacy && legacy.legacy.managed
        || workflowTasks.length
        || (legacy.requirements && legacy.requirements.length))) {
        const legacyView = legacyProbe || legacy;
        return {
          ...legacyView,
          id: project.id,
          workspace: path.resolve(project.path),
          // 旧 工作流.json/任务/需求/提案 是业务真相；本地 requirements/tasks 只是镜像。
          truthSource: 'legacy-workflow',
          mirrorOnly: true,
          // 旧看板/流程浮窗按 counts.tasks 等字段读，保持同形。
          counts: {
            ...legacyView.counts,
            requirements: legacyView.counts.requirements,
            tasks: legacyView.counts.tasks,
            open: legacyView.counts.open,
            done: legacyView.counts.done,
            commits: legacyView.counts.commits
          }
        };
      }
    } catch { /* 旧状态坏了时退回本地只读视图；写操作仍会明确报错 */ }
  }
  const tasks = Array.isArray(project.tasks) ? project.tasks : [];
  const open = tasks.filter((task) => task.status !== 'done');
  const stage = deriveStage(project);
  // 新项目还没有需求和 工作流.json 时，阶段可以走本地投影；但 team.mjs 能力
  // 必须始终返回给界面，否则“新建需求 / boot”会被误判成命令缺失而全部禁用。
  const fallbackCaps = capabilitiesWithShellOwnedCloseout(
    legacyProbe && legacyProbe.legacy && legacyProbe.legacy.capabilities
      ? legacyProbe.legacy.capabilities
      : teamTools.legacyCapabilities(),
    project.teamMode
  );
  const fallbackLegacy = {
    ...(legacyProbe && legacyProbe.legacy
      ? legacyProbe.legacy
      : { source: 'team.mjs 能力探测', file: null, exists: false, managed: false }),
    capabilities: fallbackCaps,
    missingCommands: Array.isArray(fallbackCaps.missing) ? fallbackCaps.missing : [],
    optionalMissing: Array.isArray(fallbackCaps.optionalMissing) ? fallbackCaps.optionalMissing : [],
    fallback: true
  };
  return {
    ok: true,
    project: project.name,
    workspace: path.resolve(project.path),
    stage,
    truthSource: 'local-fallback',
    mirrorOnly: true,
    legacyStage: stage === 'owner' ? 'bossreview' : stage,
    phase: null,
    round: 1,
    requirements: [],
    nextRound: [],
    boots: {},
    workflow: null,
    legacy: fallbackLegacy,
    ownerReview: project.ownerReview || { status: 'optional', opinion: '', at: null },
    roundKey: `${project.id}|${countRequirements(project)}|${tasks.length}|${open.length}`,
    counts: {
      tasks: tasks.length,
      open: open.length,
      done: tasks.length - open.length,
      requirements: countRequirements(project),
      commits: Array.isArray(project.commits) ? project.commits.length : 0
    },
    updatedAt: now()
  };
}

function addEvent(project, text) {
  project.updatedAt = now();
  project.events = Array.isArray(project.events) ? project.events : [];
  project.events.push({ at: now(), text });
  project.events = project.events.slice(-100);
}

/**
 * Owner 决定 → 旧版 工作流.json / PM 系统消息 的结果投影。
 * 写失败必须带 warnings + workflowWrite.ok=false，不能只给 workflowFile:null 让调用方猜。
 */
function ownerTeamOutcome(teamResult, fallbackWarning) {
  const warnings = [];
  if (teamResult) {
    const list = Array.isArray(teamResult.warnings)
      ? teamResult.warnings
      : (teamResult.warning ? [teamResult.warning] : []);
    for (const item of list) {
      if (item && item.code) warnings.push({ code: String(item.code), message: String(item.message || '') });
    }
  } else if (fallbackWarning) {
    warnings.push({
      code: String(fallbackWarning.code || 'OWNER_WORKFLOW_FAILED'),
      message: String(fallbackWarning.message || '旧版 工作流.json 未写入')
    });
  }
  const workflowFile = teamResult ? (String(teamResult.workflowFile || teamResult.file || '') || null) : null;
  const raw = teamResult && teamResult.workflowWrite;
  const workflowWrite = raw && typeof raw === 'object'
    ? {
      ok: raw.ok === true,
      attempted: raw.attempted !== false,
      code: String(raw.code || (raw.ok === true ? 'OK' : 'WORKFLOW_NOT_WRITTEN')),
      message: String(raw.message || '')
    }
    : {
      ok: Boolean(workflowFile),
      attempted: Boolean(teamResult),
      code: workflowFile ? 'OK' : String((warnings[0] && warnings[0].code) || 'WORKFLOW_NOT_WRITTEN'),
      message: workflowFile ? '' : String((warnings[0] && warnings[0].message) || '旧版 工作流.json 未写入')
    };
  if (!workflowWrite.ok && workflowWrite.attempted && !warnings.some((item) => item.code === workflowWrite.code)) {
    warnings.push({ code: workflowWrite.code, message: workflowWrite.message || '旧版 工作流.json 未写入' });
  }
  return {
    workflowFile,
    workflowWrite,
    notified: (teamResult && teamResult.notified) || null,
    warnings
  };
}

/** 旧 工作流.json 写失败时把原因补进项目事件，避免只出现在一次 IPC 返回值里。 */
function noteOwnerWorkflowFailure(projectId, workflowWrite) {
  if (!projectId || !workflowWrite || workflowWrite.ok || workflowWrite.attempted === false) return false;
  try {
    const store = readStore();
    const project = store.projects.find((item) => item.id === projectId);
    if (!project) return false;
    addEvent(project, `Owner 决定已记本地，旧版 工作流.json 未写入：${workflowWrite.code} ${String(workflowWrite.message || '').slice(0, 160)}`);
    writeStore(store);
    return true;
  } catch {
    return false;
  }
}

/**
 * 工作台任务/提案/评审/签字/提交 → 旧版看板数据源（团队/状态/项目/<slug>/...）。
 * 写操作后增量同步一次；team:board 生成前还会全量再同步一次，防止漏项。
 * 团队尚未登记时返回 skipped，不阻断本地业务。
 */
function mirrorToTeamBoard(project) {
  if (!project || typeof project !== 'object') return null;
  const teamName = String(project.teamName || project.name || '').trim();
  if (!teamName) return null;
  try {
    const result = teamTools.syncWorkbenchBoard(project, teamName);
    return result && typeof result === 'object'
      ? { ok: Boolean(result.ok), code: result.code || 'OK', counts: result.counts || null, skipped: Boolean(result.skipped) }
      : null;
  } catch (error) {
    return { ok: false, code: 'BOARD_SYNC_FAILED', message: String(error && error.message || error).slice(0, 200) };
  }
}

function pendingAckExpired(project) {
  if (!project || !project.pendingAck) return false;
  const at = Date.parse(project.pendingAckAt || 0);
  if (!project.pendingAckAt || !Number.isFinite(at)) return true;
  return Date.now() - at > ACK_TTL_MS;
}

function clearPendingAck(project, eventText) {
  if (!project || !project.pendingAck) return false;
  project.pendingAck = null;
  project.pendingAckAt = null;
  if (eventText) addEvent(project, eventText);
  return true;
}

// ==========================================================================
// 旧版看板浮窗：preload 暴露 window.boardWin（control / openFile / selectProject）
// ==========================================================================
function boardWindowAlive() {
  return Boolean(teamBoardWindow && !teamBoardWindow.isDestroyed());
}

function assertBoardSender(event) {
  if (!boardWindowAlive() || !event || !event.sender || event.sender.id !== teamBoardWindow.webContents.id) {
    const error = new Error('只允许看板窗口调用该接口');
    error.code = 'BOARD_WINDOW_REQUIRED';
    throw error;
  }
}

// 看板动作白名单：折叠 / 展开 / 放大 / 切项目 / 刷新 / 关闭。
const BOARD_ACTIONS = ['collapse', 'expand', 'zoom-in', 'zoom-out', 'maximize', 'switch-project', 'refresh', 'reload', 'close'];

function normalizeBoardAction(action) {
  if (typeof action === 'string') return { action: action.trim(), project: '' };
  if (action && typeof action === 'object') {
    return {
      action: String(action.action || action.type || action.command || '').trim(),
      project: String(action.project || action.projectId || action.name || action.target || '').trim()
    };
  }
  return { action: '', project: '' };
}

/**
 * 看板切项目：只认状态库里已登记的项目（id / name / teamName 精确匹配）。
 * 禁止跨项目选择：路径、未登记名、同名多个记录一律拒绝；也不改工作台当前项目。
 */
function resolveBoardProject(raw) {
  const value = raw && typeof raw === 'object'
    ? String(raw.projectId || raw.id || raw.name || '').trim()
    : String(raw == null ? '' : raw).trim();
  if (!value) return { ok: false, code: 'PROJECT_REQUIRED', why: '缺少要切换的项目' };
  if (value.length > 200 || /[\\/\0]/.test(value) || value.includes('..') || /^[a-zA-Z]:/.test(value)) {
    return { ok: false, code: 'PROJECT_INVALID', why: '看板只能切到已登记项目，不接受路径：' + value.slice(0, 120) };
  }
  const matches = readStore().projects.filter((project) =>
    project.id === value || String(project.name) === value || String(project.teamName || '') === value
  );
  if (!matches.length) return { ok: false, code: 'PROJECT_NOT_FOUND', why: '项目不存在：' + value };
  if (matches.length > 1) return { ok: false, code: 'PROJECT_AMBIGUOUS', why: '同名项目有多个记录，请按 id 切换：' + value };
  return { ok: true, project: matches[0] };
}

/** 生成看板并让看板窗口加载；先回 IPC 再导航，避免销毁调用方上下文。 */
async function loadBoardProject(project) {
  if (!project || !project.id) return { ok: false, code: 'PROJECT_REQUIRED', why: '缺少项目' };
  if (!boardWindowAlive()) return { ok: false, code: 'BOARD_WINDOW_MISSING', message: '看板窗口不存在' };
  const result = await teamTools.generateBoard(project);
  if (!result.ok) {
    return { ok: false, code: result.code || 'BOARD_FAILED', why: result.message || result.why || '看板生成失败' };
  }
  teamBoardProjectId = project.id;
  teamBoardProjectPath = path.resolve(String(project.path));
  setTimeout(() => {
    if (boardWindowAlive()) teamBoardWindow.loadFile(result.boardPath).catch(() => {});
  }, 0);
  return { ok: true, code: 'OK', projectId: project.id, project: project.name, path: result.boardPath, scheduled: true };
}

/** 缩放/展开后的窗口不能跑出屏幕。 */
function clampBoardBounds(bounds) {
  const fallback = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  try {
    const area = screen.getDisplayMatching(fallback).workArea;
    const width = Math.max(440, Math.min(fallback.width, area.width));
    const height = Math.max(320, Math.min(fallback.height, area.height));
    return {
      x: Math.min(Math.max(fallback.x, area.x), area.x + Math.max(0, area.width - width)),
      y: Math.min(Math.max(fallback.y, area.y), area.y + Math.max(0, area.height - height)),
      width,
      height
    };
  } catch {
    return fallback;
  }
}

async function boardControl(action) {
  if (!boardWindowAlive()) {
    return { ok: false, code: 'BOARD_WINDOW_MISSING', message: '看板窗口不存在' };
  }
  const win = teamBoardWindow;
  const parsed = normalizeBoardAction(action);
  const normalized = parsed.action;
  if (!BOARD_ACTIONS.includes(normalized)) {
    return {
      ok: false,
      code: 'BOARD_ACTION_UNKNOWN',
      action: normalized,
      message: '未知看板动作：' + normalized,
      actions: BOARD_ACTIONS.slice()
    };
  }
  if (normalized === 'switch-project') {
    const picked = resolveBoardProject(parsed.project);
    if (!picked.ok) return { ...picked, action: normalized };
    return { ...(await loadBoardProject(picked.project)), action: normalized };
  }
  const bounds = win.getBounds();
  // 折叠态 = 标题条高度 + 不可缩放；只有折叠态才拒绝缩放，避免把标题条放大成怪窗口。
  const collapsed = bounds.height <= 56 && !win.isResizable();
  if (normalized === 'collapse') {
    if (win.isMaximized()) win.unmaximize();
    // 已折叠时重复折叠不能把 56 高的标题条当成展开尺寸记下来。
    if (!teamBoardExpandedBounds && bounds.height > 56) {
      teamBoardExpandedBounds = { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y };
    }
    win.setResizable(false);
    win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: 56 });
    return { ok: true, action: normalized, collapsed: true, bounds: win.getBounds() };
  }
  if (normalized === 'expand') {
    if (win.isMaximized()) win.unmaximize();
    if (teamBoardExpandedBounds) {
      win.setBounds(clampBoardBounds(teamBoardExpandedBounds));
      teamBoardExpandedBounds = null;
    }
    win.setResizable(true);
    return { ok: true, action: normalized, collapsed: false, bounds: win.getBounds() };
  }
  if (normalized === 'zoom-in' || normalized === 'zoom-out') {
    if (collapsed) {
      return { ok: false, code: 'BOARD_COLLAPSED', action: normalized, message: '看板已折叠，先展开再缩放' };
    }
    const step = normalized === 'zoom-in' ? 1 : -1;
    win.setBounds(clampBoardBounds({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width + step * 80,
      height: bounds.height + step * 60
    }));
    return { ok: true, action: normalized, bounds: win.getBounds() };
  }
  if (normalized === 'maximize') {
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return { ok: true, action: normalized, maximized: win.isMaximized(), bounds: win.getBounds() };
  }
  if (normalized === 'refresh' || normalized === 'reload') {
    // 先回 IPC 再 reload：页面导航会销毁调用方上下文，直接 await reload 会让 invoke 永远不返回。
    setTimeout(() => {
      if (boardWindowAlive()) teamBoardWindow.webContents.reload();
    }, 0);
    return { ok: true, action: 'refresh', scheduled: true, projectId: teamBoardProjectId || null };
  }
  if (normalized === 'close') {
    setTimeout(() => {
      if (boardWindowAlive()) teamBoardWindow.close();
    }, 0);
    return { ok: true, action: normalized, scheduled: true };
  }
  return { ok: false, code: 'BOARD_ACTION_UNKNOWN', action: normalized, message: '未知看板动作：' + normalized, actions: BOARD_ACTIONS.slice() };
}

/** 看板文件预览：只读、限定在当前看板项目的目录内。 */
function readBoardFile(filePath) {
  if (!teamBoardProjectPath) {
    return { ok: false, code: 'BOARD_PROJECT_MISSING', why: '看板还没有绑定项目' };
  }
  try {
    const result = readProjectFile({ path: teamBoardProjectPath }, filePath, {
      textMaxBytes: 512 * 1024,
      imageMaxBytes: 8 * 1024 * 1024
    });
    return { ...result, why: '' };
  } catch (error) {
    return {
      ok: false,
      code: String((error && error.code) || 'BOARD_FILE_FAILED'),
      why: String((error && error.message) || error).slice(0, 300)
    };
  }
}

function registerIpc() {
  ipcMain.handle('app:state', () => statePayload());
  ipcMain.handle('app:version', () => APP_VERSION);
  ipcMain.handle('files:list', async (_e, projectId) => {
    const store = readStore();
    const project = store.projects.find((p) => p.id === projectId);
    if (!project) throw new Error('项目不存在');
    const root = path.resolve(project.path);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('项目目录不存在：' + root);
    const MAX_DEPTH = 4;
    const MAX_FILES = 600;
    const out = [];
    const walk = (dir, depth) => {
      if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (out.length >= MAX_FILES) return;
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'userdata' || entry.name === '_tmp') continue;
        if (entry.name.includes('.awb-tmp-')) continue; // 原子写临时文件不展示
        const abs = path.join(dir, entry.name);
        const rel = path.relative(root, abs).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          out.push({ rel, name: entry.name, kind: 'dir', size: 0 });
          walk(abs, depth + 1);
        } else {
          let size = 0;
          try { size = fs.statSync(abs).size; } catch { /* ignore */ }
          out.push({ rel, name: entry.name, kind: 'file', size });
        }
      }
    };
    walk(root, 0);
    return { ok: true, root, files: out, count: out.length, truncated: out.length >= MAX_FILES, maxDepth: MAX_DEPTH };
  });
  ipcMain.handle('files:open', async (_e, payload) => {
    const store = readStore();
    const project = store.projects.find((p) => p.id === (payload && payload.projectId));
    if (!project) throw new Error('项目不存在');
    const root = path.resolve(project.path);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('项目目录不存在：' + root);
    const target = path.resolve(root, String((payload && payload.rel) || ''));
    if (!target.toLowerCase().startsWith(root.toLowerCase() + path.sep) && target.toLowerCase() !== root.toLowerCase()) throw new Error('路径越界');
    if (!fs.existsSync(target)) throw new Error('文件不存在：' + path.relative(root, target));
    return shell.openPath(target);
  });
  ipcMain.handle('files:read', async (_e, payload) => {
    const p = payload || {};
    const store = readStore();
    const project = store.projects.find((item) => item.id === p.projectId);
    if (!project) throw new Error('项目不存在');
    return readProjectFile(project, p.rel, {
      textMaxBytes: Number(p.textMaxBytes) || undefined,
      imageMaxBytes: Number(p.imageMaxBytes) || undefined
    });
  });
  ipcMain.handle('system:metrics', async () => {
    const processes = app.getAppMetrics ? app.getAppMetrics() : [];
    const cpu = processes.reduce((sum, p) => sum + (Number(p.cpu?.percentCPUUsage) || 0), 0);
    const memTotal = os.totalmem();
    const memUsed = memTotal - os.freemem();
    let gpu = null;
    try {
      const { execFile } = require('node:child_process');
      const raw = await new Promise((resolve) => {
        execFile('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 1500 }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
      });
      const line = raw.trim().split(/\r?\n/)[0];
      if (line) {
        const [util, used, total] = line.split(',').map((n) => Number(n.trim()));
        if ([util, used, total].every((n) => Number.isFinite(n))) gpu = { util, used, total };
      }
    } catch { /* no nvidia-smi */ }
    return {
      cpu: Math.min(100, Math.max(0, Math.round(cpu))),
      mem: Math.round((memUsed / memTotal) * 100),
      gpu
    };
  });
  ipcMain.handle('app:choose-dir', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('project:create', async (_e, payload) => {
    // createProject 自己完成“目录/六角色/索引/铁律 → 本地记录 → DSH 登记”，
    // DSH 登记失败会回滚并抛带 code 的错误，调用方不会拿到半成品项目。
    return createProject(payload || {});
  });
  ipcMain.handle('project:select', async (_e, projectId) => {
    const store = readStore();
    const project = store.projects.find((p) => p.id === projectId);
    if (!project) throw new Error('项目不存在');
    store.activeProjectId = projectId;
    writeStore(store);
    // 切换项目 = 切换工作区：补/重试 DSH 工作区绑定、切旧协议当前项目、刷新当前工作区指针。
    const activation = await activateWorkspace(requireProject(readStore(), projectId), { timeoutMs: 5000 });
    const current = requireProject(readStore(), projectId);
    syncTeamRosterSessions(current.sessions || {}, { projectName: current.teamName || current.name, teamMode: current.teamMode });
    return {
      ok: true,
      activeProjectId: projectId,
      project: publicProject(current),
      workspace: activation.workspace,
      teamName: activation.teamName,
      mapping: publicMapping(current),
      warnings: activation.warnings,
      state: statePayload()
    };
  });
  ipcMain.handle('project:open', (_e, projectId) => {
    const store = readStore();
    const p = store.projects.find((x) => x.id === projectId);
    if (!p) throw new Error('项目不存在');
    return shell.openPath(p.path);
  });
  ipcMain.handle('project:discover', () => {
    const store = readStore();
    const known = new Set(store.projects.map((p) => path.resolve(p.path).toLowerCase()));
    const root = path.join(ROOT, '项目');
    const found = [];
    const push = (item) => {
      const abs = path.resolve(item.path);
      const key = abs.toLowerCase();
      if (known.has(key)) return;
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return;
      if (!fs.existsSync(path.join(abs, '项目信息.md'))) return;
      known.add(key);
      found.push({ name: item.name || path.basename(abs), path: abs, hasInfo: true, registered: Boolean(item.registered) });
    };
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        push({ name: entry.name, path: path.join(root, entry.name), registered: false });
      }
    } catch { /* no default root */ }
    // 旧版恢复列表还包含团队登记过、但不在状态库里的项目目录。
    for (const registration of readTeamRegistrations()) {
      if (registration.path) push({ name: registration.name, path: registration.path, registered: true });
    }
    return { ok: true, items: found, root };
  });
  ipcMain.handle('project:adopt', async (_e, payload) => {
    const store = readStore();
    const rawPath = String((payload && payload.path) || '').trim();
    if (!rawPath) throw new Error('目录不能为空');
    const abs = path.resolve(rawPath);
    guardNotDataDir(abs);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error('目录不存在');
    let existing = store.projects.find((p) => p.path.toLowerCase() === abs.toLowerCase());
    const registrationByPath = findTeamRegistrationByPath(abs);
    // 恢复/接管时模式真相优先级：显式入参 > 项目.json.teamMode > 状态库 > 默认 full。
    // 旧实现在没有状态库记录时直接 normalizeTeamMode(undefined)=full，会把
    // 团队工具建的 Fast 项目回写成 Full 并补建产品/程序员B目录。
    const requestedMode = readTeamModeValue(payload && (payload.teamMode || payload.mode));
    const registeredMode = readTeamModeValue(registrationByPath && registrationByPath.teamMode);
    const storedMode = readTeamModeValue(existing && existing.teamMode);
    const restoreMode = requestedMode || registeredMode || storedMode || DEFAULT_TEAM_MODE;
    if (existing) {
      // 幂等：同一个目录再次恢复直接返回已有项目，不新建第二条记录。
      if (normalizeTeamMode(existing.teamMode) !== restoreMode) {
        existing = (await setProjectTeamMode(existing.id, restoreMode)) || existing;
      }
      return {
        ok: true, adopted: false, idempotent: true,
        project: publicProject(existing),
        team: { ok: true, name: existing.teamName || existing.name },
        workspace: workspaceOf(existing),
        mapping: publicMapping(existing),
        warnings: [],
        state: statePayload()
      };
    }
    if (!fs.existsSync(path.join(abs, '项目信息.md')) && !registrationByPath) {
      throw new Error('目录里没有 项目信息.md，无法确认是工作台项目');
    }
    // 旧登记名优先于目录名：恢复后也必须和团队/工作区同名。
    const name = registrationByPath && registrationByPath.name
      ? String(registrationByPath.name)
      : cleanName(path.basename(abs)) || path.basename(abs);
    const storedWithName = store.projects.find((p) => String(p.name || '').toLowerCase() === name.toLowerCase());
    if (storedWithName && path.resolve(String(storedWithName.path)).toLowerCase() !== abs.toLowerCase()) {
      throw projectNameConflict(name, storedWithName.path);
    }
    const registrationWithName = findTeamRegistrationByName(name);
    if (registrationWithName && registrationWithName.path && path.resolve(String(registrationWithName.path)).toLowerCase() !== abs.toLowerCase()) {
      throw projectNameConflict(name, registrationWithName.path);
    }
    const teamName = registrationByPath ? String(registrationByPath.name) : name;
    const snapshot = captureProjectCreateSnapshot(teamName, abs);
    let project = null;
    try {
      // 恢复同样是“先骨架、再本地记录、最后 DSH 登记”：结构没齐不登记本地项目。
      const staged = { id: null, name, path: abs, teamName, teamMode: restoreMode };
      const team = await syncTeamProject(staged, { engineUrl: dsh.baseUrl, teamMode: restoreMode });
      if (!team.ok || !team.structure || team.structure.ok !== true) {
        throw codedError(
          (team && team.code) || 'PROJECT_STRUCTURE_INCOMPLETE',
          (team && (team.message || team.why)) || '项目结构未就绪，拒绝登记'
        );
      }
      project = {
        id: id('P'), name, path: abs,
        teamName: String(team.name || teamName),
        teamMode: restoreMode,
        createdAt: now(), updatedAt: now(),
        ownerReview: { status: 'optional', opinion: '', at: null },
        tasks: [], messages: [], proposals: [], commits: [], votes: [], pendingAck: null, pendingAckAt: null,
        events: [{ at: now(), text: `从已有目录恢复（${restoreMode}）` }]
      };
      const fresh = readStore();
      fresh.projects.push(project);
      fresh.activeProjectId = project.id;
      writeStore(fresh);
      // 恢复项目同样必须绑定/复用 DSH 工作区，并切到它。
      const activation = await activateWorkspace(project, { timeoutMs: 6000 });
      if (!activation.ok) {
        const warning = activation.warnings.find((row) => /DSH|WORKSPACE/i.test(String(row.code || ''))) || null;
        throw codedError(
          (warning && warning.code) || 'DSH_WORKSPACE_CREATE_FAILED',
          (warning && warning.message) || 'DSH 工作区登记失败'
        );
      }
      const current = requireProject(readStore(), project.id);
      return {
        ok: true,
        project: publicProject(current),
        team,
        structure: team.structure || null,
        structureOk: true,
        workspace: activation.workspace,
        mapping: publicMapping(current),
        warnings: activation.warnings,
        state: statePayload()
      };
    } catch (error) {
      // 目录是用户原有的，不删；只回滚本次新增的本地记录/登记指针。
      const rollback = rollbackCreatedProject({
        projectId: project && project.id,
        teamName: project && project.teamName ? project.teamName : teamName,
        target: abs,
        snapshot,
        createdDir: false,
        repaired: []
      });
      const err = error instanceof Error ? error : new Error(String(error));
      err.rolledBack = true;
      err.rollback = rollback;
      if (!err.code) err.code = 'PROJECT_ADOPT_FAILED';
      throw err;
    }
  });
  ipcMain.handle('team:workspaces', async (_e, payload) => {
    try {
      const info = await teamTools.listWorkspaces();
      let dshStatus = dsh.statusSync();
      if (payload && payload.probe) {
        try { dshStatus = await dsh.check({ timeoutMs: 4000 }); } catch { /* 保持上次状态 */ }
      }
      // 状态库里的项目也要出现在清单里（可能在默认目录之外），并标记是否本机登记。
      const store = readStore();
      const byPath = new Map(store.projects.map((project) => [path.resolve(project.path).toLowerCase(), project]));
      const projects = info.projects.map((item) => {
        const stored = item.path ? byPath.get(path.resolve(item.path).toLowerCase()) : null;
        return { ...item, inStore: Boolean(stored), projectId: stored ? stored.id : null };
      });
      for (const project of store.projects) {
        const key = path.resolve(project.path).toLowerCase();
        if (projects.some((item) => item.path && path.resolve(item.path).toLowerCase() === key)) continue;
        projects.push({
          name: project.name,
          path: project.path,
          desc: '状态库项目',
          status: 'active',
          registered: false,
          source: 'store',
          inStore: true,
          projectId: project.id,
          exists: fs.existsSync(project.path),
          hasWorkspaceMeta: fs.existsSync(path.join(project.path, 'workspace.json')),
          dshWorkspaceId: project.dshWorkspaceId || null,
          current: false,
          sessions: project.sessions ? { count: Object.keys(project.sessions).length, generatedAt: null, workspaceId: project.dshWorkspaceId || null } : null
        });
      }
      projects.sort((a, b) => (Number(b.current) - Number(a.current)) || a.name.localeCompare(b.name, 'zh-CN'));
      const items = projects.map((item) => ({
        name: item.name,
        path: item.path,
        dshWorkspaceId: item.dshWorkspaceId,
        desc: item.desc,
        current: item.current,
        registered: item.registered,
        exists: item.exists,
        inStore: item.inStore,
        projectId: item.projectId
      }));
      return { ...info, projects, items, current: projects.find((item) => item.current) || null, dsh: dshStatus };
    } catch (e) {
      return {
        ok: false, code: 'TEAM_LIST_FAILED', message: String(e && e.message || e).slice(0, 500),
        initialized: false, projects: [], items: [], current: null, dsh: dsh.statusSync()
      };
    }
  });
  ipcMain.handle('team:status', () => {
    try {
      return { ...teamTools.teamStatus(), dsh: dsh.statusSync() };
    } catch (e) {
      return {
        ok: false, code: 'TEAM_STATUS_FAILED', message: String(e && e.message || e).slice(0, 500),
        team: null, sessions: null, board: null, currentWorkspace: null,
        tools: { team: false, launch: false, workspace: false, boardHtml: false },
        dsh: dsh.statusSync()
      };
    }
  });
  ipcMain.handle('team:members', (_e, payload) => {
    const store = readStore();
    let project = null;
    if (payload && payload.projectId) project = store.projects.find((item) => item.id === payload.projectId) || null;
    const wantedName = String((payload && (payload.project || payload.name)) || '').trim();
    if (!project && wantedName) {
      const hit = findProjectByName(wantedName);
      if (hit && hit.id) project = store.projects.find((item) => item.id === hit.id) || null;
      if (!project && hit) project = { id: null, name: hit.name, path: hit.path };
    }
    if (!project) {
      const current = currentWorkspaceRecord();
      if (current && current.path) project = { id: null, name: current.name || '', path: String(current.path) };
    }
    if (!project) {
      project = store.projects.find((item) => item.id === store.activeProjectId) || store.projects[0] || null;
    }
    const workspacePath = project ? path.resolve(project.path) : String((payload && (payload.workspace || payload.path)) || '');
    const projectName = project ? project.name : wantedName;
    const manifest = teamTools.readSessionManifest(workspacePath);
    const mapped = project && project.sessions ? project.sessions : {};
    // 清单只有在 workspace 与项目目录一致时才可采信；否则视为旧项目复制过来的污染文件。
    const manifestWorkspace = manifest && manifest.workspace ? String(manifest.workspace) : '';
    const manifestTrusted = Boolean(manifest) && Boolean(manifestWorkspace) && sameResolvedPath(manifestWorkspace, workspacePath);
    const manifestRoles = manifestTrusted && Array.isArray(manifest.roles) ? manifest.roles : [];
    const memberRoleIds = roleIdsForProject(project);
    const memberRoleSet = new Set(memberRoleIds);
    // 角色清单以 团队会话.json 为准（旧版兼容）；sessionId 用状态库映射覆盖旧快照。
    // 没有清单时才把状态库里的当前模式角色映射当作成员清单。
    const baseRoles = manifestRoles.length
      ? manifestRoles.filter((row) => row && memberRoleSet.has(String(row.role)) && ROLE_BY_ID.has(String(row.role)))
      : memberRoleIds.filter((roleId) => mapped[roleId]).map((roleId) => ({ role: roleId }));
    const roles = baseRoles.map((row) => {
      const roleId = String(row.role);
      const role = ROLE_BY_ID.get(roleId);
      const sessionId = mapped[roleId] || (row && row.sessionId) || '';
      return {
        role: roleId,
        name: role ? role.name : String(row.name || roleId),
        title: roleTitle(roleId),
        sessionId: sessionId ? String(sessionId) : '',
        reused: row ? Boolean(row.reused) : null,
        model: row ? row.model || '' : '',
        source: mapped[roleId] ? 'store' : (row ? 'manifest' : '')
      };
    });
    if (!roles.length) {
      return {
        ok: false, project: projectName, workspace: workspacePath, roles: [],
        error: '还没有当前模式的角色会话，请先建团队'
      };
    }
    return {
      ok: true,
      project: (manifestTrusted && manifest && manifest.project) || projectName,
      workspace: (manifestTrusted && manifest && manifest.workspace) || workspacePath,
      teamMode: normalizeTeamMode(project && project.teamMode),
      roleIds: memberRoleIds,
      roles,
      count: roles.length,
      // workspaceId 只在“清单记录了 workspace 且与项目目录一致”时采信；否则以状态库绑定为准。
      workspaceId: (manifestTrusted && manifestWorkspace && manifest && manifest.workspaceId)
        || (project && project.workspace && project.workspace.id) || null,
      manifestTrusted,
      generatedAt: (manifestTrusted && manifest && manifest.generatedAt) || null,
      error: ''
    };
  });
  ipcMain.handle('team:ensure-project', async (_e, payload) => {
    try {
      const p = payload || {};
      const picked = pickTeamProject(p);
      let project = picked.project;
      const projectId = project.id;
      const requestedMode = p.teamMode || p.mode ? normalizeTeamMode(p.teamMode || p.mode) : '';
      if (picked.persisted && requestedMode && normalizeTeamMode(project.teamMode) !== requestedMode) {
        project = (await setProjectTeamMode(project.id, requestedMode)) || project;
      }
      const teamMode = normalizeTeamMode(requestedMode || project.teamMode);
      // 显式 ensure 也要补齐当前模式角色目录/项目信息/铁律/索引，不能只登记项目.json。
      const team = await teamTools.ensureProjectReady({ ...project, teamMode }, { engineUrl: dsh.baseUrl, teamMode });
      if (picked.persisted && projectId) {
        const fresh = readStore();
        const current = fresh.projects.find((p) => p.id === projectId);
        if (current) {
          if (team.ok) {
            current.teamName = team.name;
            current.teamSyncedAt = now();
            addEvent(current, `团队项目已同步：${team.name}`);
          } else {
            addEvent(current, `团队项目同步失败：${team.code || 'ERROR'}`);
          }
          writeStore(fresh);
        }
      }
      // 补齐团队项目后立即补/重试 DSH 工作区绑定（离线只记 pending，不阻断）。
      let binding = null;
      if (picked.persisted && projectId && team.ok) {
        binding = await bindProjectWorkspace({ ...project, teamName: team.name, teamMode }, { engineUrl: dsh.baseUrl });
      }
      const currentProject = picked.persisted && projectId ? requireProject(readStore(), projectId) : null;
      const warnings = binding && !binding.ok ? [{ code: binding.code, message: binding.message }] : [];
      if (team.structure && !team.structure.ok) {
        warnings.push({ code: team.structure.code || 'PROJECT_STRUCTURE_INCOMPLETE', message: team.structure.message || '项目结构不完整' });
      }
      return {
        ok: true,
        ensured: Boolean(team.ok),
        teamMode,
        roleIds: roleIdsForTeamMode(teamMode),
        team,
        structure: team.structure || null,
        structureOk: Boolean(team.structure && team.structure.ok),
        workspace: binding ? binding.workspace : null,
        mapping: currentProject ? publicMapping(currentProject) : null,
        warnings,
        state: statePayload()
      };
    } catch (e) {
      return {
        ok: false, ensured: false, code: 'TEAM_ENSURE_FAILED',
        message: String(e && e.message || e).slice(0, 500),
        team: { ok: false, code: 'TEAM_ENSURE_FAILED', message: String(e && e.message || e).slice(0, 500) },
        state: statePayload()
      };
    }
  });
  ipcMain.handle('team:launch', async (_e, payload) => {
    const p = payload || {};
    try {
      const picked = pickTeamProject(p);
      let project = picked.project;
      const requestedMode = (p.teamMode || p.mode) ? normalizeTeamMode(p.teamMode || p.mode) : '';
      if (picked.persisted && requestedMode && normalizeTeamMode(project.teamMode) !== requestedMode) {
        project = (await setProjectTeamMode(project.id, requestedMode)) || project;
      }
      const launchMode = normalizeTeamMode(requestedMode || project.teamMode);
      const options = {
        // 真实启动；测试/预览必须显式传 dryRun:true，避免误建 DSH 会话。
        dryRun: p.dryRun === true,
        // 未显式指定角色时必须按项目模式：Fast=4 角色，Full=6 角色。
        roles: p.roles || roleIdsForTeamMode(launchMode),
        teamMode: launchMode,
        prompt: p.prompt === true,
        promptAll: p.promptAll === true,
        restore: Boolean(p.restore),
        // 六角色要能 boot，默认把本次角色补进 roster；传 addMembers:false 可关闭。
        addMembers: p.addMembers !== false,
        seedVisible: p.seedVisible === true,
        engineUrl: String(p.engineUrl || dsh.baseUrl || '').trim()
      };
      const warnings = [];
      // 真实启动前先把工作区绑定好，并把已存在的角色会话标题规范成“团队·角色”，
      // 这样 launch.mjs 会按标题复用它们，不会因为标题不同再建一份重复会话。
      if (!options.dryRun && picked.persisted) {
        const binding = await bindProjectWorkspace(project, { engineUrl: options.engineUrl });
        if (!binding.ok) warnings.push({ code: binding.code, message: binding.message });
        if (binding.ok) {
          try {
            const inspected = await inspectProjectSessions(requireProject(readStore(), project.id), binding);
            if (inspected.renamed.length) {
              const fresh = readStore();
              const current = fresh.projects.find((x) => x.id === project.id);
              if (current) {
                addEvent(current, `规范角色会话标题：${inspected.renamed.map((row) => row.role).join(', ')}`);
                writeStore(fresh);
              }
            }
          } catch (error) {
            warnings.push({ code: (error && error.code) || 'DSH_INSPECT_FAILED', message: String(error && error.message || error).slice(0, 200) });
          }
        }
      }
      const result = await teamTools.launchSessions(project, options);
      if (!options.dryRun) persistTeamLaunch(picked.persisted ? project.id : null, result);
      const persisted = !options.dryRun && picked.persisted ? requireProject(readStore(), project.id) : null;
      return {
        ...result,
        warnings,
        mapping: persisted ? publicMapping(persisted) : null,
        reload: true,
        state: statePayload()
      };
    } catch (e) {
      return {
        ok: false, code: (e && e.code) || 'TEAM_LAUNCH_FAILED',
        dryRun: Boolean(p.dryRun === true),
        message: String(e && e.message || e).slice(0, 500),
        state: statePayload()
      };
    }
  });
  // 旧版“恢复项目”：按项目名找到目录，用 --restore 复用已有 DSH 会话。
  ipcMain.handle('team:restore', async (_e, payload) => {
    const p = payload || {};
    const input = String(p.name || p.project || '').trim();
    if (!input) return { ok: false, code: 'NAME_REQUIRED', why: '请输入已归档项目名', state: statePayload() };
    if (/[\\/]/.test(input) || input === '.' || input === '..') {
      return { ok: false, code: 'BAD_NAME', why: '只输项目名，不要带路径', state: statePayload() };
    }
    try {
      const hit = findProjectByName(input);
      if (!hit || !hit.path || !fs.existsSync(hit.path)) {
        return {
          ok: false, code: 'PROJECT_FOLDER_NOT_FOUND',
          why: `磁盘上找不到项目文件夹：${hit && hit.path ? hit.path : path.join(ROOT, 'projects', input)}`,
          state: statePayload()
        };
      }
      const projectDir = path.resolve(hit.path);
      if (isInsidePath(LOCAL_DATA, projectDir)) {
        return { ok: false, code: 'PROJECT_DIR_FORBIDDEN', why: '不能把工作台数据目录当成项目', state: statePayload() };
      }
      let stored = readStore().projects.find((project) => path.resolve(project.path).toLowerCase() === projectDir.toLowerCase());
      // 恢复模式同样以 项目.json.teamMode 为优先真相；没有登记/字段才回落状态库/default。
      const registration = findTeamRegistrationByPath(projectDir) || findTeamRegistrationByName(hit.name);
      const requestedMode = readTeamModeValue(p.teamMode || p.mode);
      const registeredMode = readTeamModeValue(registration && registration.teamMode);
      const storedMode = readTeamModeValue(stored && stored.teamMode);
      const restoreMode = requestedMode || registeredMode || storedMode || DEFAULT_TEAM_MODE;
      // dry-run 预览必须在任何写盘之前返回：下面的 setProjectTeamMode 会写 workbench.json、
      // 同步 团队.json 名册，并通过 ensureProjectReady 改 项目.json/workspace.json。
      // dry-run 只跑旧 launch.mjs --dry-run 拿角色计划，一个字节都不落盘。
      if (p.dryRun === true) {
        const preview = await teamTools.launchSessions({ name: hit.name, path: projectDir, teamMode: restoreMode }, {
          dryRun: true,
          roles: p.roles || roleIdsForTeamMode(restoreMode),
          teamMode: restoreMode,
          prompt: p.prompt === true,
          restore: true,
          addMembers: p.addMembers !== false,
          seedVisible: p.seedVisible === true,
          engineUrl: String(p.engineUrl || dsh.baseUrl || '').trim()
        });
        return {
          ...preview,
          restore: true,
          dryRun: true,
          teamMode: restoreMode,
          projectDir,
          project: preview.name || hit.name,
          name: preview.name || hit.name,
          workspace: null,
          warnings: [],
          mapping: null,
          reload: false,
          // 写面如实声明：dry-run 不写项目配置/状态库/名册。
          writes: { projectConfig: false, store: false, roster: false },
          state: statePayload({ readOnly: true })
        };
      }
      if (stored && normalizeTeamMode(stored.teamMode) !== restoreMode) {
        stored = (await setProjectTeamMode(stored.id, restoreMode)) || stored;
      }
      const warnings = [];
      let binding = null;
      if (p.dryRun !== true) {
        binding = await bindProjectWorkspace(
          stored || { id: null, name: hit.name, path: projectDir, teamMode: restoreMode },
          { engineUrl: String(p.engineUrl || dsh.baseUrl || '').trim() }
        );
        if (!binding.ok) warnings.push({ code: binding.code, message: binding.message });
      }
      const result = await teamTools.launchSessions({ name: hit.name, path: projectDir, teamMode: restoreMode }, {
        dryRun: p.dryRun === true,
        roles: p.roles || roleIdsForTeamMode(restoreMode),
        teamMode: restoreMode,
        prompt: p.prompt === true,
        restore: true,
        addMembers: p.addMembers !== false,
        seedVisible: p.seedVisible === true,
        engineUrl: String(p.engineUrl || dsh.baseUrl || '').trim()
      });
      if (p.dryRun !== true) persistTeamLaunch(stored ? stored.id : null, result);
      const persisted = stored && p.dryRun !== true ? requireProject(readStore(), stored.id) : null;
      return {
        ...result,
        restore: true,
        teamMode: restoreMode,
        projectDir,
        project: result.name || hit.name,
        name: result.name || hit.name,
        workspace: binding ? binding.workspace : null,
        warnings,
        mapping: persisted ? publicMapping(persisted) : null,
        reload: true,
        state: statePayload()
      };
    } catch (e) {
      return {
        ok: false, code: (e && e.code) || 'RESTORE_FAILED',
        why: String(e && e.message || e).slice(0, 500),
        state: statePayload()
      };
    }
  });
  // 旧版“打开已有项目文件夹”：任意目录都能直接建团队（不看 项目信息.md）；
  // 同名项目不能指向两个目录，同一目录允许再次打开（恢复会话）。
  ipcMain.handle('team:open-project', async (_e, payload) => {
    const p = payload || {};
    let dir = String(p.path || '').trim();
    if (!dir) {
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: '打开已有项目文件夹',
        properties: ['openDirectory'],
        defaultPath: ROOT
      });
      if (picked.canceled || !picked.filePaths || !picked.filePaths[0]) {
        return { ok: false, code: 'CANCELED', why: '未选择目录', state: statePayload() };
      }
      dir = picked.filePaths[0];
    }
    const abs = path.resolve(dir);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      return { ok: false, code: 'PROJECT_FOLDER_NOT_FOUND', why: '目录不存在：' + abs, state: statePayload() };
    }
    if (isInsidePath(LOCAL_DATA, abs)) {
      return { ok: false, code: 'PROJECT_DIR_FORBIDDEN', why: '不能把工作台数据目录当成项目', state: statePayload() };
    }
    const name = cleanName(path.basename(abs)).replace(/[_-]+$/, '') || path.basename(abs);
    if (!name) return { ok: false, code: 'BAD_NAME', why: '目录名不能作为项目名', state: statePayload() };
    const conflict = readTeamRegistrations().find((item) => item.name === name
      && item.path && path.resolve(item.path).toLowerCase() !== abs.toLowerCase());
    if (conflict) {
      return {
        ok: false, code: 'PROJECT_NAME_CONFLICT',
        why: `项目名「${name}」已对应另一个目录：${conflict.path}\n请先改目录名，或从左侧原有项目恢复。`,
        state: statePayload()
      };
    }
    const openedStore = readStore();
    const storedByName = openedStore.projects.find((project) => String(project.name || '').toLowerCase() === name.toLowerCase()
      && path.resolve(project.path).toLowerCase() !== abs.toLowerCase());
    if (storedByName) {
      return {
        ok: false, code: 'PROJECT_NAME_CONFLICT',
        why: `项目名「${name}」已对应另一个目录：${storedByName.path}\n请先改目录名，或从左侧原有项目恢复。`,
        state: statePayload()
      };
    }
    let stored = openedStore.projects.find((project) => path.resolve(project.path).toLowerCase() === abs.toLowerCase());
    // “打开已有项目文件夹”同样是恢复入口：优先读 项目.json.teamMode，避免把 Fast 打开成 Full。
    const registration = findTeamRegistrationByPath(abs) || findTeamRegistrationByName(name);
    const requestedMode = readTeamModeValue(p.teamMode || p.mode);
    const registeredMode = readTeamModeValue(registration && registration.teamMode);
    const storedMode = readTeamModeValue(stored && stored.teamMode);
    const openMode = requestedMode || registeredMode || storedMode || DEFAULT_TEAM_MODE;
    // 与 team:restore 同一条铁律：dry-run 必须在 setProjectTeamMode 之前返回。
    // 这一步只跑旧 launch.mjs --dry-run 预览角色计划，不写 项目.json/workspace.json/
    // workbench.json/团队.json 名册，避免“只是预览”却改了真实团队模式。
    if (p.dryRun === true) {
      try {
        const preview = await teamTools.launchSessions({ name, path: abs, teamMode: openMode }, {
          dryRun: true,
          roles: p.roles || roleIdsForTeamMode(openMode),
          teamMode: openMode,
          prompt: p.prompt === true,
          addMembers: p.addMembers !== false,
          seedVisible: p.seedVisible === true,
          engineUrl: String(p.engineUrl || dsh.baseUrl || '').trim()
        });
        return {
          ...preview,
          opened: true,
          dryRun: true,
          teamMode: openMode,
          projectDir: abs,
          project: preview.name || name,
          workspace: null,
          warnings: [],
          mapping: null,
          reload: false,
          writes: { projectConfig: false, store: false, roster: false },
          state: statePayload({ readOnly: true })
        };
      } catch (e) {
        return { ok: false, code: 'OPEN_FAILED', why: String(e && e.message || e).slice(0, 500), state: statePayload({ readOnly: true }) };
      }
    }
    if (stored && normalizeTeamMode(stored.teamMode) !== openMode) {
      stored = (await setProjectTeamMode(stored.id, openMode)) || stored;
    }
    try {
      const warnings = [];
      let binding = null;
      if (p.dryRun !== true) {
        binding = await bindProjectWorkspace(
          stored || { id: null, name, path: abs, teamMode: openMode },
          { engineUrl: String(p.engineUrl || dsh.baseUrl || '').trim() }
        );
        if (!binding.ok) warnings.push({ code: binding.code, message: binding.message });
      }
      const result = await teamTools.launchSessions({ name, path: abs, teamMode: openMode }, {
        dryRun: p.dryRun === true,
        roles: p.roles || roleIdsForTeamMode(openMode),
        teamMode: openMode,
        prompt: p.prompt === true,
        addMembers: p.addMembers !== false,
        seedVisible: p.seedVisible === true,
        engineUrl: String(p.engineUrl || dsh.baseUrl || '').trim()
      });
      if (p.dryRun !== true) persistTeamLaunch(stored ? stored.id : null, result);
      const persisted = stored && p.dryRun !== true ? requireProject(readStore(), stored.id) : null;
      return {
        ...result,
        opened: true,
        teamMode: openMode,
        projectDir: abs,
        project: result.name || name,
        workspace: binding ? binding.workspace : null,
        warnings,
        mapping: persisted ? publicMapping(persisted) : null,
        reload: true,
        state: statePayload()
      };
    } catch (e) {
      return { ok: false, code: 'OPEN_FAILED', why: String(e && e.message || e).slice(0, 500), state: statePayload() };
    }
  });
  // 旧版“新建工作区”：建目录 + 六角色骨架 + 登记团队；重名/空目录规则与旧版一致。
  ipcMain.handle('team:workspace:create', async (_e, payload) => {
    const p = payload || {};
    const teamMode = normalizeTeamMode(p.teamMode || p.mode);
    const rawName = String(p.name || '').trim();
    const root = path.resolve(String(p.root || path.join(ROOT, '项目')));
    if (!rawName) return { ok: false, code: 'BAD_NAME', why: '缺少工作区名称', state: statePayload() };
    if (rawName === '.' || rawName === '..' || rawName.length > 40 || /[\\/:*?"<>|]/.test(rawName)) {
      return { ok: false, code: 'BAD_NAME', why: '工作区名须为 1-40 字，且不含 \\ / : * ? " < > |', state: statePayload() };
    }
    const name = cleanName(rawName);
    const target = path.resolve(root, name);
    if (!isInsidePath(root, target) || path.resolve(root) === target) {
      return { ok: false, code: 'BAD_NAME', why: '工作区必须位于根目录之内：' + target, state: statePayload() };
    }
    try {
      guardNotDataDir(target);
    } catch (e) {
      return { ok: false, code: 'WORKSPACE_ROOT_FORBIDDEN', why: String(e.message || e).slice(0, 500), state: statePayload() };
    }
    const store = readStore();
    if (store.projects.some((project) => path.resolve(project.path).toLowerCase() === target.toLowerCase())) {
      return {
        ok: false, code: 'WORKSPACE_EXISTS',
        why: `项目「${name}」已存在：${target}\n一个工作台=一个项目，请直接选「建团队/恢复」，不要重复新建。`,
        state: statePayload()
      };
    }
    if (fs.existsSync(target) && (!fs.statSync(target).isDirectory() || fs.readdirSync(target).length)) {
      return {
        ok: false, code: 'WORKSPACE_EXISTS',
        why: `项目「${name}」已存在：${target}\n一个工作台=一个项目，请直接选「建团队/恢复」，不要重复新建。`,
        state: statePayload()
      };
    }
    const registered = readTeamRegistrations().find((item) => item.name === name && item.path && path.resolve(item.path).toLowerCase() !== target.toLowerCase());
    if (registered) {
      return {
        ok: false, code: 'WORKSPACE_EXISTS',
        why: `项目「${name}」已在团队登记：${registered.path}\n请从「建团队」选择它恢复会话，不要新建同名项目。`,
        state: statePayload()
      };
    }
    if (p.dryRun === true) {
      return {
        ok: true, dryRun: true, name, root, target,
        teamMode,
        exists: fs.existsSync(target),
        roles: roleIdsForTeamMode(teamMode).map((roleId) => {
          const role = ROLE_BY_ID.get(roleId) || { id: roleId, dir: roleId };
          return { role: role.id, dir: role.dir };
        }),
        state: statePayload()
      };
    }
    try {
      // 与 project:create 同一条创建路径：结构先行、本地记录次之、DSH 登记最后；
      // 失败由 createProject 回滚并抛出结构化 code。
      const created = await createProject({ name, root, teamMode });
      const project = requireProject(readStore(), created.project.id);
      return {
        ok: true,
        created: true,
        teamMode: normalizeTeamMode(project.teamMode),
        roleIds: roleIdsForProject(project),
        dryRun: false,
        name: project.name,
        workspace: created.workspace,
        project: publicProject(project),
        structure: created.structure || null,
        structureOk: Boolean(created.structure && created.structure.ok),
        mapping: publicMapping(project),
        currentWorkspace: teamTools.readCurrentWorkspace() || currentWorkspaceRecord(),
        index: created.team && created.team.index ? created.team.index : null,
        warnings: created.warnings || [],
        team: created.team,
        reload: true,
        state: statePayload()
      };
    } catch (e) {
      return {
        ok: false, code: (e && e.code) || 'WORKSPACE_CREATE_FAILED',
        why: String(e && e.message || e).slice(0, 500),
        rolledBack: Boolean(e && e.rolledBack),
        state: statePayload()
      };
    }
  });
  ipcMain.handle('team:board', async (_e, payload) => {
    try {
      const picked = pickTeamProject(payload);
      // 传完整项目对象：generateBoard 会先把工作台任务/提案/提交同步进旧看板数据源。
      const boardProject = {
        ...picked.project,
        name: picked.project.name || (picked.project.teamName || ''),
        path: picked.project.path
      };
      const result = await teamTools.generateBoard(boardProject);
      if (!result.ok) return { ...result, ok: false, state: statePayload() };
      let opened = '';
      let openedOk = null;
      if (!payload || payload.open !== false) {
        opened = await shell.openPath(result.boardPath);
        openedOk = opened === '';
      }
      return { ...result, project: result.name, path: result.boardPath, opened, openedOk, state: statePayload() };
    } catch (e) {
      return {
        ok: false, code: 'TEAM_BOARD_FAILED',
        message: String(e && e.message || e).slice(0, 500),
        state: statePayload()
      };
    }
  });
  // 旧版 team:board-project：按项目名生成看板，不打开窗口。
  ipcMain.handle('team:board-project', async (_e, payload) => {
    const raw = typeof payload === 'string' ? payload : ((payload && (payload.project || payload.name || payload.projectId)) || '');
    const projectId = typeof raw === 'object' && raw ? (raw.id || raw.projectId || '') : (payload && payload.projectId) || '';
    let name = String(typeof raw === 'object' && raw ? (raw.name || '') : raw || '').trim();
    const stored = projectId
      ? readStore().projects.find((project) => project.id === projectId) || null
      : (readStore().projects.find((project) => String(project.name) === name || String(project.teamName || '') === name) || null);
    if (!name && stored) name = stored.name;
    if (!name) return { ok: false, code: 'NO_PROJECT', why: '缺少项目名', state: statePayload() };
    try {
      // 有状态库项目就传完整对象，让工作台任务/提案也能进旧看板；否则退回旧版按名生成。
      const result = await teamTools.generateBoard(stored ? { ...stored, name } : name);
      return { ...result, project: result.name || name, state: statePayload() };
    } catch (e) {
      return { ok: false, code: 'TEAM_BOARD_FAILED', why: String(e && e.message || e).slice(0, 500), state: statePayload() };
    }
  });
  ipcMain.handle('workflow:get', (_e, payload) => {
    try {
      const store = readStore();
      const project = pickProject(store, typeof payload === 'string' ? { projectId: payload } : (payload || {}));
      return { ...workflowSnapshot(project), state: statePayload() };
    } catch (e) {
      return { ok: false, code: 'WORKFLOW_FAILED', why: String(e && e.message || e).slice(0, 500), state: statePayload() };
    }
  });
  // 旧版 workflow:owner：payload 用 {decision, opinion, roundKey}，状态仍是 approved/skipped/rejected。
  ipcMain.handle('workflow:owner', async (_e, payload) => {
    const p = payload || {};
    const decision = String(p.decision || p.status || '');
    if (!['approved', 'skipped', 'rejected'].includes(decision)) {
      return { ok: false, error: 'OWNER_DECISION_INVALID', code: 'OWNER_DECISION_INVALID', state: statePayload() };
    }
    try {
      const store = readStore();
      const project = pickProject(store, p);
      // Owner 确认码已废弃：决定/验收直接以 role=owner 接受，不再要求 challenge/nonce。
      // roundKey 必须在写入决定前取，代表本轮 Owner 闸门；不能写后重新推导成下一轮。
      const roundKey = workflowSnapshot(project).roundKey;
      ownerDecide(project, decision, p.opinion, { roundKey });
      writeStore(store);
      const current = requireProject(readStore(), project.id);
      // 写旧 工作流.json + 给 PM 一条系统消息；只走团队工具，不向任何 DSH 会话发假 prompt。
      let teamResult = null;
      let fallback = null;
      try {
        teamResult = await teamTools.recordOwnerDecision(current, {
          status: decision, opinion: p.opinion, roundKey, by: 'Owner'
        });
      } catch (error) {
        fallback = {
          code: 'OWNER_WORKFLOW_FAILED',
          message: '旧版 工作流.json / PM 系统消息处理失败：' + String((error && error.message) || error).slice(0, 300)
        };
      }
      const outcome = ownerTeamOutcome(teamResult, fallback);
      // 写旧 工作流.json 失败不能只留在返回值里：项目事件也要留痕。
      noteOwnerWorkflowFailure(current.id, outcome.workflowWrite);
      return {
        ...workflowSnapshot(current),
        decision,
        ownerReview: current.ownerReview,
        roundKey,
        workflowFile: outcome.workflowFile,
        workflow: (teamResult && teamResult.workflow) || null,
        workflowWrite: outcome.workflowWrite,
        notified: outcome.notified,
        warnings: outcome.warnings,
        state: statePayload()
      };
    } catch (e) {
      return { ok: false, error: 'OWNER_FAILED', code: 'OWNER_FAILED', why: String(e && e.message || e).slice(0, 500), state: statePayload() };
    }
  });
  // --------------------------------------------------------------------------
  // 旧团队工作流闭环 IPC（需求 → 评审 → 派单 → 开发/互审 → 测试 → Owner 验收）
  // 所有入口只翻译项目/角色/会话，业务状态写 团队/状态/项目/<slug>/，本地库只镜像。
  // --------------------------------------------------------------------------
  const runWorkflowIpc = (handler) => async (_e, payload) => {
    const p = payload || {};
    try {
      const ctx = await workflowProjectContext(p);
      const teamMode = normalizeTeamMode(p.teamMode || p.mode || ctx.project.teamMode);
      // 所有工作流动作都显式带 teamMode：ensureProjectStructure / 评审人 / 派单闸门
      // 才能按 Full/Fast 判断，而不是靠调用方每次记得传。
      const actionPayload = { ...p, teamMode };
      const role = String(actionPayload.role || (actionPayload.actor === 'owner' ? 'owner' : ''));
      const sessionId = String(actionPayload.sessionId || (role && ctx.project.sessions && ctx.project.sessions[role]) || '');
      const result = await handler(ctx, actionPayload, { role, sessionId, teamMode });
      return workflowResponse(ctx.project.id, ctx.teamName, ctx.projectPath, result || { ok: true, code: 'OK' });
    } catch (error) {
      return {
        ok: false,
        code: (error && error.code) || 'WORKFLOW_FAILED',
        message: String((error && error.message) || error).slice(0, 500),
        state: statePayload()
      };
    }
  };

  /**
   * Owner 确认码已废弃：owner 决定/验收直接以 role=owner 接受，不再要求 challenge/nonce。
   * 这两个 IPC 仅为兼容旧界面保留（渲染层仍会走一遍取码/回填），返回固定形状的占位值，
   * 任何调用方都不需要也不应该再依赖确认码本身；后端写 Owner 决定的 IPC 一律不再校验。
   */
  ipcMain.handle('owner:challenge', async (_e, payload) => {
    const p = payload || {};
    const challengeId = 'deprecated-' + crypto.randomBytes(8).toString('hex');
    return {
      ok: true,
      deprecated: true,
      code: 'OWNER_CHALLENGE_DEPRECATED',
      challengeId,
      nonce: '000000',
      action: normalizeOwnerConfirmationAction(p.action),
      requirementId: p.requirementId || p.id || null,
      projectId: p.projectId || null,
      expiresAt: new Date(Date.now() + OWNER_CHALLENGE_TTL_MS).toISOString(),
      ttlMs: OWNER_CHALLENGE_TTL_MS,
      message: 'Owner 确认码已废弃：Owner 决定/验收直接以 role=owner 执行，不再要求 challenge/nonce。本接口仅为兼容旧界面保留。'
    };
  });
  ipcMain.handle('owner:confirm', async (_e, payload) => {
    const p = payload || {};
    const challengeId = String(p.challengeId || p.ownerChallengeId || 'deprecated');
    const confirmToken = 'deprecated-' + crypto.randomBytes(16).toString('hex');
    return {
      ok: true,
      deprecated: true,
      code: 'OWNER_CONFIRM_DEPRECATED',
      challengeId,
      confirmToken,
      token: confirmToken,
      expiresAt: null,
      action: normalizeOwnerConfirmationAction(p.action),
      confirmation: {
        challengeId,
        confirmToken,
        deprecated: true,
        action: normalizeOwnerConfirmationAction(p.action)
      },
      message: 'Owner 确认已废弃：确认令牌不再校验，Owner 决定/验收直接以 role=owner 执行。'
    };
  });

  ipcMain.handle('workflow:state', runWorkflowIpc(async (ctx) => {
    return workflowSnapshot(ctx.project);
  }));
  ipcMain.handle('workflow:boot', runWorkflowIpc(async (ctx, p, meta) => {
    if (!ROLES.some((role) => role.id === meta.role)) throw codedError('BAD_ROLE', `角色无效：${meta.role || '(空)'}`);
    return teamTools.bootRole(ctx.teamName, meta.role, {
      projectPath: ctx.projectPath,
      sessionId: meta.sessionId,
      teamMode: normalizeTeamMode(p.teamMode || ctx.project.teamMode)
    });
  }));
  ipcMain.handle('workflow:briefing', runWorkflowIpc(async (ctx) => {
    return teamTools.briefingStatus(ctx.teamName);
  }));
  ipcMain.handle('workflow:next', runWorkflowIpc(async (ctx) => {
    return teamTools.workflowNext(ctx.teamName, ctx.projectPath);
  }));
  ipcMain.handle('workflow:iterate', runWorkflowIpc(async (ctx, p, meta) => {
    return teamTools.iterateWorkflow({
      ...p,
      projectName: ctx.teamName,
      projectPath: ctx.projectPath,
      role: String(p.role || 'owner'),
      sessionId: meta.sessionId
    });
  }));
  ipcMain.handle('workflow:terminate', runWorkflowIpc(async (ctx, p, meta) => {
    return teamTools.terminateWorkflow({
      ...p,
      projectName: ctx.teamName,
      projectPath: ctx.projectPath,
      role: String(p.role || 'owner'),
      sessionId: meta.sessionId
    });
  }));
  ipcMain.handle('requirement:create', runWorkflowIpc(async (ctx, p, meta) => {
    return teamTools.createRequirement({
      ...p,
      role: String(p.role || ''),
      projectName: ctx.teamName,
      projectPath: ctx.projectPath,
      sessionId: meta.sessionId
    });
  }));
  ipcMain.handle('requirement:owner-create', runWorkflowIpc(async (ctx, p, meta) => {
    return teamTools.createOwnerRequirement({
      ...p,
      projectName: ctx.teamName,
      projectPath: ctx.projectPath,
      sessionId: meta.sessionId
    });
  }));
  ipcMain.handle('requirement:review', runWorkflowIpc(async (ctx, p, meta) => {
    return teamTools.reviewRequirement({
      ...p,
      // 需求评审只允许产品角色；不能因为调用方没传 role 就默认成 product（PM 自审漏洞）。
      role: String(p.role || ''),
      projectName: ctx.teamName,
      projectPath: ctx.projectPath,
      sessionId: meta.sessionId
    });
  }));
  ipcMain.handle('requirement:owner', runWorkflowIpc(async (ctx, p) => {
    const result = await teamTools.ownerRequirementDecision({
      ...p,
      projectName: ctx.teamName,
      projectPath: ctx.projectPath,
      // Owner 决定必须显式带身份；界面入口默认就是 Owner 本人。
      role: String(p.role || 'owner'),
      // Owner 确认码已废弃：不再要求 challenge/nonce；旧工具内部换码由 team-tools 静默完成。
      ownerConfirmed: true
    });
    return result;
  }));
  ipcMain.handle('owner:demand', runWorkflowIpc(async (ctx, p) => {
    return teamTools.ownerDemand({
      ...p,
      projectName: ctx.teamName,
      projectPath: ctx.projectPath
    });
  }));
  // Fast 模式：Owner 之后的开发技术评审（同一 requirement:review 入口传 role=programmer1 也可）。
  ipcMain.handle('requirement:tech-review', runWorkflowIpc(async (ctx, p, meta) => {
    return teamTools.techReviewRequirement({
      ...p,
      role: String(p.role || 'programmer1'),
      projectName: ctx.teamName,
      projectPath: ctx.projectPath,
      sessionId: meta.sessionId
    });
  }));
  // 投票：发起人 analyst；除 PM 外所有角色一致 reject 才驳回 Owner 需求。
  ipcMain.handle('vote:start', runWorkflowIpc(async (ctx, p, meta) => {
    return teamTools.startVote({
      ...p,
      role: String(p.role || 'analyst'),
      projectName: ctx.teamName,
      projectPath: ctx.projectPath,
      sessionId: meta.sessionId
    });
  }));
  ipcMain.handle('vote:cast', runWorkflowIpc(async (ctx, p, meta) => {
    return teamTools.castVote({
      ...p,
      projectName: ctx.teamName,
      projectPath: ctx.projectPath,
      sessionId: meta.sessionId
    });
  }));
  ipcMain.handle('vote:status', runWorkflowIpc(async (ctx, p) => {
    return teamTools.voteStatus({
      ...p,
      projectName: ctx.teamName,
      projectPath: ctx.projectPath
    });
  }));
  ipcMain.handle('requirement:dispatch', runWorkflowIpc(async (ctx, p, meta) => {
    return teamTools.dispatchRequirement({
      ...p,
      role: String(p.role || 'pm'),
      projectName: ctx.teamName,
      projectPath: ctx.projectPath,
      sessionId: meta.sessionId
    });
  }));
  ipcMain.handle('requirement:dispatch-batch', runWorkflowIpc(async (ctx, p, meta) => {
    return teamTools.dispatchRequirementBatch({
      ...p,
      role: String(p.role || 'pm'),
      projectName: ctx.teamName,
      projectPath: ctx.projectPath,
      sessionId: meta.sessionId
    });
  }));
  ipcMain.handle('requirement:dispatchBatch', runWorkflowIpc(async (ctx, p, meta) => {
    return teamTools.dispatchRequirementBatch({
      ...p,
      role: String(p.role || 'pm'),
      projectName: ctx.teamName,
      projectPath: ctx.projectPath,
      sessionId: meta.sessionId
    });
  }));
  ipcMain.handle('task:claim', runWorkflowIpc(async (ctx, p, meta) => {
    return teamTools.claimWorkflowTask({
      ...p,
      role: String(p.role || ''),
      projectName: ctx.teamName,
      projectPath: ctx.projectPath,
      sessionId: meta.sessionId
    });
  }));
  ipcMain.handle('task:done', runWorkflowIpc(async (ctx, p, meta) => {
    return teamTools.doneWorkflowTask({
      ...p,
      role: String(p.role || ''),
      projectName: ctx.teamName,
      projectPath: ctx.projectPath,
      sessionId: meta.sessionId
    });
  }));
  ipcMain.handle('dev:submit', runWorkflowIpc(async (ctx, p, meta) => {
    return teamTools.devSubmit({
      ...p,
      role: String(p.role || ''),
      projectName: ctx.teamName,
      projectPath: ctx.projectPath,
      sessionId: meta.sessionId
    });
  }));
  ipcMain.handle('dev:review', runWorkflowIpc(async (ctx, p, meta) => {
    return teamTools.devReview({
      ...p,
      role: String(p.role || ''),
      projectName: ctx.teamName,
      projectPath: ctx.projectPath,
      sessionId: meta.sessionId
    });
  }));
  ipcMain.handle('dev:apply', runWorkflowIpc(async (ctx, p, meta) => {
    return teamTools.devApply({
      ...p,
      role: String(p.role || 'pm'),
      projectName: ctx.teamName,
      projectPath: ctx.projectPath,
      sessionId: meta.sessionId
    });
  }));
  ipcMain.handle('test:dispatch', runWorkflowIpc(async (ctx, p, meta) => {
    return teamTools.dispatchTest({
      ...p,
      role: String(p.role || 'pm'),
      projectName: ctx.teamName,
      projectPath: ctx.projectPath,
      sessionId: meta.sessionId
    });
  }));
  ipcMain.handle('owner:accept', runWorkflowIpc(async (ctx, p, meta) => {
    const result = await teamTools.ownerAccept({
      ...p,
      projectName: ctx.teamName,
      projectPath: ctx.projectPath,
      role: String(p.role || 'owner'),
      sessionId: meta.sessionId,
      // Owner 确认码已废弃：直接以 role=owner 接受；旧工具内部换码由 team-tools 静默完成。
      ownerConfirmed: true
    });
    return result;
  }));

  ipcMain.handle('team:board-old', async (_e, payload) => {
    const projectId = typeof payload === 'string' ? payload : String((payload && (payload.projectId || payload.id)) || '');
    const store = readStore();
    const project = store.projects.find((p) => p.id === projectId);
    if (!project) throw new Error('项目不存在');
    const result = await teamTools.generateBoard(project);
    if (!result.ok) throw new Error(result.message || result.why || '看板生成失败');
    teamBoardProjectId = project.id;
    teamBoardProjectPath = path.resolve(String(project.path));
    if (boardWindowAlive()) {
      // 复用窗口也必须重新加载：generateBoard 每次都会重写 看板.html，
      // 只 show/focus 会让切项目后的窗口继续显示上一个项目。
      await teamBoardWindow.loadFile(result.boardPath);
      teamBoardWindow.show();
      teamBoardWindow.focus();
      return { ok: true, path: result.boardPath, projectId: project.id, reused: true, reloaded: true };
    }
    teamBoardWindow = new BrowserWindow({
      width: 1120, height: 780, minWidth: 440, minHeight: 320,
      frame: false, alwaysOnTop: true, skipTaskbar: false, resizable: true, show: false,
      backgroundColor: '#0b0c10', opacity: 0.97, parent: mainWindow || undefined,
      title: '团队看板', icon: APP_ICON,
      webPreferences: {
        // 看板窗口复用同一个 preload，通过 --awb-board 只暴露 window.boardWin。
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
        additionalArguments: ['--awb-board'], spellcheck: false
      }
    });
    teamBoardWindow.on('closed', () => {
      teamBoardWindow = null;
      teamBoardProjectId = null;
      teamBoardProjectPath = null;
      teamBoardExpandedBounds = null;
    });
    await teamBoardWindow.loadFile(result.boardPath);
    teamBoardWindow.show();
    return { ok: true, path: result.boardPath, projectId: project.id, reused: false, reloaded: true };
  });
  ipcMain.handle('team:board-control', (event, action) => {
    assertBoardSender(event);
    return boardControl(action);
  });
  ipcMain.handle('team:board-refresh', (event) => {
    assertBoardSender(event);
    if (!boardWindowAlive() || !teamBoardProjectId) return { ok: false, code: 'BOARD_WINDOW_MISSING' };
    setTimeout(() => {
      if (boardWindowAlive()) teamBoardWindow.webContents.reload();
    }, 0);
    return { ok: true, projectId: teamBoardProjectId, scheduled: true };
  });
  ipcMain.handle('team:board-select-project', async (event, nameOrId) => {
    assertBoardSender(event);
    // 与 board-control 的 switch-project 共用同一把尺子：只认状态库已登记项目，拒绝路径。
    const picked = resolveBoardProject(nameOrId);
    if (!picked.ok) return { ok: false, code: picked.code, why: picked.why };
    // 只刷新看板窗口，不改变工作台当前项目（旧版提示：切换项目不会改变工作台当前项目）。
    return loadBoardProject(picked.project);
  });
  ipcMain.handle('team:board-file', (event, payload) => {
    assertBoardSender(event);
    const filePath = typeof payload === 'string'
      ? payload
      : String((payload && (payload.path || payload.abs || payload.rel)) || '');
    return readBoardFile(filePath);
  });
  ipcMain.handle('project:delete-record', async (_e, payload) => {
    const p = typeof payload === 'string' ? { projectId: payload } : (payload || {});
    const targetId = String(p.projectId || p.id || '');
    const store = readStore();
    const project = store.projects.find((x) => x.id === targetId);
    if (!project) throw new Error('项目不存在');
    const removed = { registrations: [], activeProjectCleared: false, currentWorkspaceCleared: false };
    const summary = {
      tasks: Array.isArray(project.tasks) ? project.tasks.length : 0,
      proposals: Array.isArray(project.proposals) ? project.proposals.length : 0,
      commits: Array.isArray(project.commits) ? project.commits.length : 0,
      workspaceId: workspaceOf(project).id
    };
    // 先归档 DSH 六角色会话，再删本地记录；DSH 离线时仍允许摘记录，但把失败原因带回。
    const sessions = p.archiveSessions === false
      ? { ok: true, code: 'SKIPPED', mode: 'none', archived: [], skipped: [], failed: [] }
      : await archiveProjectRoleSessions(project);
    // 默认只摘本机记录，绝不动旧团队账本/任务/提案/回执。purgeTeam 仅供显式迁移工具使用。
    if (p.purgeTeam === true || p.archiveTeam !== false) {
    try {
      const teamRoot = (teamTools && teamTools.layout && teamTools.layout.teamRoot) || process.env.TEAM_ROOT || path.join(ROOT, '团队');
      const projectsDir = path.join(teamRoot, '状态', '项目');
      if (fs.existsSync(projectsDir)) {
        for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const configPath = path.join(projectsDir, entry.name, '项目.json');
          let config = null;
          try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* ignore */ }
          const samePath = config && config.path && path.resolve(String(config.path)).toLowerCase() === path.resolve(project.path).toLowerCase();
          const sameName = config && [project.teamName, project.name].filter(Boolean).map(String).includes(String(config.name));
          if (samePath || sameName) {
            removed.registrations.push({ name: config && config.name || entry.name, path: config && config.path || '' });
            const sourceDir = path.join(projectsDir, entry.name);
            if (p.purgeTeam === true) {
              fs.rmSync(sourceDir, { recursive: true, force: true });
            } else {
              // 归档而不是删除：旧任务/提案/回执/提交仍可从 _deleted 找回。
              const archiveRoot = path.join(projectsDir, '_deleted');
              fs.mkdirSync(archiveRoot, { recursive: true });
              const archiveDir = path.join(archiveRoot, storeStamp() + '-' + entry.name);
              fs.renameSync(sourceDir, archiveDir);
              removed.archivedTo = archiveDir;
            }
          }
        }
      }
      const teamFile = path.join(teamRoot, '状态', '团队.json');
      if (fs.existsSync(teamFile)) {
        const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
        const names = [project.teamName, project.name].filter(Boolean).map(String);
        let teamChanged = false;
        if (team && names.includes(team.activeProject)) {
          team.activeProject = null;
          removed.activeProjectCleared = true;
          teamChanged = true;
        }
        // 名册是全局单例：只清掉“被删项目”的会话，不能把其它项目的当前名册一并清空。
        const doomedSessions = new Set(Object.values(project.sessions || {}).filter(Boolean).map(String));
        for (const member of Array.isArray(team && team.members) ? team.members : []) {
          if (member.sessionId && doomedSessions.has(String(member.sessionId))) {
            member.sessionId = '';
            teamChanged = true;
          }
        }
        if (teamChanged) fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
      }
      const currentFile = path.join(teamRoot, '状态', '当前工作区.json');
      if (fs.existsSync(currentFile)) {
        try {
          const current = JSON.parse(fs.readFileSync(currentFile, 'utf8'));
          if (current && current.path && path.resolve(String(current.path)).toLowerCase() === path.resolve(project.path).toLowerCase()) {
            fs.rmSync(currentFile, { force: true });
            removed.currentWorkspaceCleared = true;
          }
        } catch { /* 坏文件不阻断删除 */ }
      }
    } catch { /* 团队状态清理失败不阻断本地删除 */ }
    }
    // 项目目录里的会话清单/工作区绑定是“同名重建”的隐藏入口：必须清掉旧会话映射；
    // workspace.json 只去掉绑定 id，保留目录仍可在重建时被 DSH 按 path 幂等复用。
    const projectDir = path.resolve(String(project.path || ''));
    if (p.purgeTeam === true || p.archiveTeam !== false) {
    for (const name of ['团队会话.json', '团队会话.md']) {
      try { fs.rmSync(path.join(projectDir, name), { force: true }); } catch { /* ignore */ }
    }
    try {
      const metaFile = path.join(projectDir, 'workspace.json');
      if (fs.existsSync(metaFile)) {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8').replace(/^\uFEFF/, ''));
        if (meta && (meta.dshWorkspaceId || meta.engineUrl)) {
          meta.previousWorkspaceId = meta.dshWorkspaceId || null;
          delete meta.dshWorkspaceId;
          delete meta.engineUrl;
          meta.removedAt = now();
          fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');
        }
      }
    } catch { /* 坏 workspace.json 不阻断删除 */ }
    }
    // await 结束：重新读库合并，避免删除期间其它快照更新被整体回退。
    const fresh = readStore();
    const doomed = fresh.projects.find((x) => x.id === targetId) || project;
    fresh.projects = fresh.projects.filter((x) => x.id !== targetId);
    if (fresh.activeProjectId === targetId) fresh.activeProjectId = fresh.projects[0]?.id || null;
    let pendingCleanup = null;
    if (!sessions.ok && sessions.code !== 'SKIPPED') {
      // DSH 离线/部分归档失败：本地记录可以摘，但必须留下可重试的清理队列，不能假装干净。
      const sessionIds = [...new Set([
        ...Object.values(doomed.sessions || {}).filter(Boolean).map(String),
        ...(doomed.workspace && Array.isArray(doomed.workspace.sessionIds) ? doomed.workspace.sessionIds.map(String) : []),
        ...((sessions.failed || []).map((item) => item && item.sessionId).filter(Boolean).map(String))
      ])];
      pendingCleanup = {
        projectId: targetId,
        name: doomed.name || '',
        teamName: doomed.teamName || '',
        workspaceId: workspaceOf(doomed).id,
        projectPath: doomed.path || '',
        sessionIds,
        code: sessions.code || 'SESSION_ARCHIVE_FAILED',
        message: String(sessions.message || 'DSH 会话未完全归档').slice(0, 300),
        at: now()
      };
      const queue = Array.isArray(fresh.pendingCleanup) ? fresh.pendingCleanup.filter((item) => item && item.projectId !== targetId) : [];
      queue.push(pendingCleanup);
      fresh.pendingCleanup = queue.slice(-50);
    }
    writeStore(fresh);
    // 看板正显示被删项目时一起收起，避免窗口继续展示已归档项目。
    if (boardWindowAlive() && teamBoardProjectId === targetId) {
      try { teamBoardWindow.close(); } catch { /* ignore */ }
    }
    return {
      ok: true,
      projectId: targetId,
      removed,
      summary,
      sessions,
      pendingCleanup: Boolean(pendingCleanup),
      pendingCleanupEntry: pendingCleanup,
      warnings: sessions.ok ? [] : [{ code: sessions.code || 'SESSION_ARCHIVE_FAILED', message: sessions.message || 'DSH 会话未完全归档', pendingCleanup: Boolean(pendingCleanup) }],
      state: statePayload()
    };
  });
  ipcMain.handle('task:create', (_e, payload) => {
    const store = readStore();
    const project = requireProject(store, payload && payload.projectId);
    const title = String((payload && payload.title) || '').trim();
    if (!title) throw new Error('任务标题不能为空');
    const task = {
      id: id('T'), title: title.slice(0, 120), role: String((payload && payload.role) || 'pm'),
      priority: String((payload && payload.priority) || 'P2'), status: 'todo',
      createdAt: now(), updatedAt: now()
    };
    project.tasks.push(task);
    addEvent(project, `新建任务 ${task.id} ${title}`);
    writeStore(store);
    const board = mirrorToTeamBoard(project);
    return { ok: true, task, board, state: statePayload() };
  });
  ipcMain.handle('task:update', (_e, payload) => {
    const store = readStore();
    const project = requireProject(store, payload && payload.projectId);
    const task = project.tasks.find((t) => t.id === payload.taskId);
    if (!task) throw new Error('任务不存在');
    if (payload.status) {
      if (!TASK_STATUSES.includes(payload.status)) throw new Error('任务状态无效');
      task.status = payload.status;
    }
    if (payload.role && ROLES.some((r) => r.id === payload.role)) task.role = payload.role;
    task.updatedAt = now();
    addEvent(project, `任务 ${task.id} → ${task.status}`);
    writeStore(store);
    const board = mirrorToTeamBoard(project);
    return { ok: true, board, state: statePayload() };
  });
  ipcMain.handle('task:delete', (_e, payload) => {
    const store = readStore();
    const project = requireProject(store, payload && payload.projectId);
    project.tasks = project.tasks.filter((t) => t.id !== payload.taskId);
    addEvent(project, `删除任务 ${payload.taskId}`);
    writeStore(store);
    const board = mirrorToTeamBoard(project);
    return { ok: true, board, state: statePayload() };
  });
  ipcMain.handle('proposal:create', (_e, payload) => {
    const p = payload || {};
    const store = readStore();
    const project = requireProject(store, p.projectId);
    // 旧协议提案必须走 team.mjs：多文件/暂存路径/风险/任务/哈希字段本地实现不了，
    // 明确拒绝而不是静默截断成单文件本地提案。
    if (p.legacy === true || p.protocol === 'legacy' || (Array.isArray(p.files) && p.files.some((file) => file && (file.staged || file.stagedPath)))) {
      throw codedError(
        'LEGACY_PROTOCOL_REQUIRED',
        '这条提案带旧评审协议字段（files[].staged / legacy / protocol）：请调用 proposal:legacy 走 propose→show→review→sign→apply'
      );
    }
    const title = String(p.title || '').trim();
    const author = String(p.author || '');
    // 旧协议字段：fileRel | file | files[{target}]；content | stagedContent。
    const legacyFiles = Array.isArray(p.files) ? p.files.filter((file) => file && (file.target || file.fileRel)) : [];
    const rawRel = String(p.fileRel || p.file || (legacyFiles[0] && (legacyFiles[0].target || legacyFiles[0].fileRel)) || '').replace(/\\/g, '/');
    if (!title) throw new Error('提案标题不能为空');
    if (!ROLES.some((r) => r.id === author)) throw new Error('提案作者无效');
    if (!rawRel) throw new Error('提案必须指定文件');
    if (legacyFiles.length > 1) {
      throw codedError('LEGACY_PROTOCOL_REQUIRED', '多文件提案属于旧评审协议（team.mjs propose --file ...）：请调用 proposal:legacy');
    }
    const root = path.resolve(project.path);
    const abs = path.resolve(root, rawRel);
    if (!abs.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new Error('文件不在项目内');
    const fileRel = path.relative(root, abs).replace(/\\/g, '/');
    const hasContent = Object.prototype.hasOwnProperty.call(p, 'content') || Object.prototype.hasOwnProperty.call(p, 'stagedContent');
    const stagedContent = hasContent ? String(p.content !== undefined ? p.content : p.stagedContent) : null;
    if (stagedContent !== null && stagedContent.length > 262144) throw new Error('提案内容不能超过 256KB');
    if (!fs.existsSync(abs) && stagedContent === null) throw new Error('提案文件不存在：' + fileRel);
    if (fs.existsSync(abs) && !fs.statSync(abs).isFile()) throw new Error('提案目标不是文件');
    const existed = fs.existsSync(abs);
    const before = existed ? fs.readFileSync(abs) : Buffer.alloc(0);
    const content = stagedContent === null ? before : Buffer.from(stagedContent, 'utf8');
    const baseHash = existed ? sha256(before) : null;
    // 旧协议要求提案前声明读到的版本：--expect 目标=哈希（absent 表示文件不存在）。
    const expectRaw = p.expect !== undefined ? p.expect : (p.expectBase !== undefined ? p.expectBase : (legacyFiles[0] && legacyFiles[0].expect));
    if (expectRaw !== undefined && expectRaw !== null && String(expectRaw) !== '') {
      const expected = String(expectRaw).trim().toLowerCase();
      const current = existed ? baseHash : 'absent';
      if (expected !== current && expected !== (baseHash || '')) {
        const e = new Error(`读过之后文件变了：${fileRel}`);
        e.code = 'STALE_BASE';
        throw e;
      }
    }
    const contentHash = sha256(content);
    const riskRaw = String(p.risk || '').toLowerCase();
    if (riskRaw && !['normal', 'sensitive', 'critical'].includes(riskRaw)) throw new Error('风险级别必须是 normal/sensitive/critical');
    const proposal = {
      id: id('P'), title: title.slice(0, 100), author, fileRel,
      fileSize: content.length, hash: contentHash, contentHash, baseHash,
      existed, stagedContent,
      // 旧协议字段一并留存，方便旧调用方回读；新界面不依赖它们。
      files: [{ target: fileRel, baseHash: baseHash === null ? 'absent' : baseHash, newHash: contentHash, size: content.length, staged: null }],
      task: String(p.task || ''),
      rationale: String(p.rationale || '').slice(0, 2000),
      risk: riskRaw || null,
      status: 'review', reviews: [], signature: null, applied: false, commitId: null,
      createdAt: now(), updatedAt: now()
    };
    project.proposals.push(proposal);
    addEvent(project, `提案 ${proposal.id} ${title}`);
    writeStore(store);
    const board = mirrorToTeamBoard(project);
    return { ok: true, proposal, board, state: statePayload() };
  });
  ipcMain.handle('proposal:review', (_e, payload) => {
    const p = payload || {};
    const store = readStore();
    const project = requireProject(store, p.projectId);
    const proposal = project.proposals.find((row) => row.id === p.proposalId);
    if (!proposal) throw new Error('提案不存在');
    rejectLocalWriteOnLegacyProposal(proposal, 'review');
    if (proposal.status !== 'review') throw new Error('提案已经结束评审');
    const role = String(p.role || '');
    if (!ROLES.some((r) => r.id === role)) throw new Error('评审角色无效');
    if (role === proposal.author) throw new Error('作者不能评审自己的提案');
    const verdict = normalizeVerdict(p.verdict);
    const comment = String(p.comment !== undefined ? p.comment : p.comments || '').trim();
    if (!['approve', 'reject'].includes(verdict)) throw new Error('评审结论无效');
    if (!comment) throw new Error('评审必须写理由');
    if (proposal.reviews.some((item) => item.role === role)) throw new Error('这个角色已经评审过该提案');
    proposal.reviews.push({ role, verdict, comment: comment.slice(0, 600), at: now(), ts: now() });
    proposal.updatedAt = now();
    if (verdict === 'reject') proposal.status = 'rejected';
    addEvent(project, `评审 ${proposal.id} ${verdict}`);
    writeStore(store);
    const board = mirrorToTeamBoard(project);
    return { ok: true, proposal, board, state: statePayload() };
  });
  ipcMain.handle('proposal:sign', (_e, payload) => {
    const p = payload || {};
    const store = readStore();
    const project = requireProject(store, p.projectId);
    const proposal = project.proposals.find((row) => row.id === p.proposalId);
    if (!proposal) throw new Error('提案不存在');
    rejectLocalWriteOnLegacyProposal(proposal, 'sign');
    if (proposal.applied) throw new Error('已经应用的提案不能再改签字');
    if (proposal.signature) throw new Error('提案已有签字，不能重复签字；如需变更请新建提案');
    if (proposal.status === 'rejected') throw new Error('被拒绝的提案不能签字');
    if (!Array.isArray(proposal.reviews) || !proposal.reviews.length) throw new Error('提案还没有角色评审，不能签字');
    if (!proposal.reviews.some((item) => item.verdict === 'approve')) throw new Error('提案没有评审通过记录，不能签字');
    // 旧协议 decision 用 approve/reject，新版用 approved/rejected；两种都收。
    const rawDecision = String(p.decision || '');
    const decision = normalizeVerdict(rawDecision) === 'approve' ? 'approved'
      : (normalizeVerdict(rawDecision) === 'reject' ? 'rejected' : rawDecision);
    if (!['approved', 'rejected'].includes(decision)) throw new Error('签字决定无效');
    const signer = String(p.by || p.role || 'pm');
    if (signer !== 'pm') throw new Error('只有项目经理可以签字');
    if (!ROLES.some((r) => r.id === signer)) throw new Error('签字角色无效');
    proposal.signature = { by: signer, decision, note: String(p.note || '').slice(0, 500), at: now() };
    proposal.status = decision === 'approved' ? 'approved' : 'rejected';
    proposal.updatedAt = now();
    addEvent(project, `签字 ${proposal.id} ${decision}`);
    writeStore(store);
    const board = mirrorToTeamBoard(project);
    return { ok: true, proposal, board, state: statePayload() };
  });
  ipcMain.handle('proposal:apply', (_e, payload) => {
    const p = payload || {};
    const store = readStore();
    const project = requireProject(store, p.projectId);
    const proposal = project.proposals.find((row) => row.id === p.proposalId);
    if (!proposal) throw new Error('提案不存在');
    rejectLocalWriteOnLegacyProposal(proposal, 'apply');
    if (proposal.status !== 'approved' || !proposal.signature) throw new Error('提案还没有 PM 签字通过');
    if (proposal.applied) throw new Error('提案已经应用');
    if (proposal.stagedContent === null || proposal.stagedContent === undefined) throw new Error('这条提案没有待应用的内容');
    const root = path.resolve(project.path);
    const abs = path.resolve(root, proposal.fileRel);
    if (!abs.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new Error('文件不在项目内');
    // 旧提案没有 baseHash：无法确认评审时的文件版本，明确要求重新评审，不静默覆盖。
    if (proposal.baseHash === undefined) {
      const e = new Error('旧提案缺少 baseHash，无法确认评审时的文件版本；请重新创建提案并评审后再应用');
      e.code = 'LEGACY_PROPOSAL';
      throw e;
    }
    const currentExists = fs.existsSync(abs);
    const currentHash = currentExists ? sha256(fs.readFileSync(abs)) : null;
    if (currentHash !== (proposal.baseHash || null)) {
      const e = new Error('提案绑定的文件在评审后被修改，不能静默覆盖；请重新评审');
      e.code = 'CONFLICT';
      throw e;
    }
    // 同一物理文件只允许一个未回滚的已应用提案：按 resolve 后的绝对路径 + 大小写比较，
    // 避免 ./x.md、X.MD 这类别名绕过。
    const absKey = abs.toLowerCase();
    const sameFileApplied = project.proposals.some((row) => {
      if (row.id === proposal.id || !row.applied || !row.fileRel) return false;
      return path.resolve(root, String(row.fileRel)).toLowerCase() === absKey;
    });
    if (sameFileApplied) {
      const e = new Error('同一文件已有未回滚的已应用提案，请先回滚');
      e.code = 'CONFLICT';
      throw e;
    }
    const commitId = id('C');
    const backupDir = path.join(root, '_backup', 'commits', commitId);
    fs.mkdirSync(backupDir, { recursive: true });
    let backupPath = '';
    let backupHash = null;
    if (currentExists) {
      backupPath = path.join(backupDir, path.basename(abs));
      atomicCopyFile(abs, backupPath);
      backupHash = currentHash;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    atomicWriteFile(abs, Buffer.from(proposal.stagedContent, 'utf8'));
    const afterHash = sha256(fs.readFileSync(abs));
    const commit = {
      id: commitId, proposalId: proposal.id, fileRel: proposal.fileRel,
      backupPath, backupHash, baseHash: proposal.baseHash || null,
      afterHash, existed: currentExists, at: now(),
      log: String(p.log || '').slice(0, 160)
    };
    project.commits.push(commit);
    proposal.applied = true;
    proposal.commitId = commitId;
    proposal.updatedAt = now();
    addEvent(project, `应用提案 ${proposal.id} → ${commitId}`);
    writeStore(store);
    const board = mirrorToTeamBoard(project);
    return { ok: true, commit, proposal, board, state: statePayload() };
  });
  ipcMain.handle('proposal:rollback', (_e, payload) => {
    const store = readStore();
    const project = requireProject(store, payload && payload.projectId);
    const proposal = project.proposals.find((p) => p.id === payload.proposalId);
    if (proposal) rejectLocalWriteOnLegacyProposal(proposal, 'rollback');
    if (!proposal || !proposal.applied || !proposal.commitId) throw new Error('提案没有可回滚的提交');
    const commit = project.commits.find((c) => c.id === proposal.commitId);
    if (!commit) throw new Error('找不到提交记录');
    const root = path.resolve(project.path);
    const abs = path.resolve(root, commit.fileRel);
    if (!abs.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new Error('文件不在项目内');
    if (fs.existsSync(abs)) {
      const nowHash = sha256(fs.readFileSync(abs));
      if (commit.afterHash) {
        if (nowHash !== commit.afterHash) {
          const e = new Error('文件在应用后又被修改，回滚会覆盖新内容，已停止');
          e.code = 'CONFLICT';
          throw e;
        }
      } else if (commit.existed) {
        // 旧提交推不出 afterHash：无法证明文件没被改过，宁可停手也不覆盖。
        const e = new Error('旧提交缺少 afterHash，无法确认文件在应用后是否被改动，已停止；请人工核对后再恢复备份');
        e.code = 'BACKUP_UNVERIFIED';
        throw e;
      } else {
        // 旧提交 + 新文件：文件还在，但内容是否仍是应用时写的无法确认。
        const e = new Error('旧提交缺少 afterHash，无法确认新文件是否被改动，已停止；请人工确认后再删除');
        e.code = 'BACKUP_UNVERIFIED';
        throw e;
      }
    }
    if (commit.existed) {
      if (!commit.backupPath || !fs.existsSync(commit.backupPath)) {
        const e = new Error('回滚备份缺失，未修改文件；请从备份目录恢复');
        e.code = 'BACKUP_MISSING';
        throw e;
      }
      if (commit.backupHash) {
        const bh = sha256(fs.readFileSync(commit.backupPath));
        if (bh !== commit.backupHash) {
          const e = new Error('回滚备份哈希不匹配，未修改文件');
          e.code = 'BACKUP_CORRUPT';
          throw e;
        }
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      atomicWriteFile(abs, fs.readFileSync(commit.backupPath));
    } else if (fs.existsSync(abs)) {
      fs.unlinkSync(abs);
    }
    proposal.applied = false;
    proposal.updatedAt = now();
    addEvent(project, `回滚提案 ${proposal.id} ← ${commit.id}`);
    writeStore(store);
    const board = mirrorToTeamBoard(project);
    return { ok: true, proposal, board, state: statePayload() };
  });
  // 旧评审协议桥：propose → show → review → sign → apply。
  // 只翻译项目/角色/当前项目会话，真正校验、评审、签字、CAS、备份、回滚都在 team.mjs。
  // 工具缺失/旧命令不存在时返回结构化 LEGACY_PROTOCOL_REQUIRED，不假装本地成功。
  const legacyProposalHandler = async (_e, payload) => {
    const p = payload || {};
    const action = String(p.action || p.op || '').trim().toLowerCase();
    if (!LEGACY_REVIEW_ACTIONS.includes(action)) {
      throw codedError('BAD_ACTION', `旧评审协议动作必须是 ${LEGACY_REVIEW_ACTIONS.join('/')}：${action || '(空)'}`);
    }
    let project = requireProject(readStore(), p.projectId);
    const ensured = await ensureTeamName(project);
    if (!ensured.ok || !ensured.teamName) {
      if (!teamTools.toolInfo().available) {
        return {
          ok: false,
          code: 'LEGACY_PROTOCOL_REQUIRED',
          protocol: 'legacy',
          action,
          message: '旧评审协议需要团队工具 team.mjs（propose/show/review/sign/apply），当前不可用',
          state: statePayload()
        };
      }
      throw codedError(ensured.code || 'TEAM_ENSURE_FAILED', ensured.message || '团队项目不可用');
    }
    const teamName = String(ensured.teamName);
    persistTeamName(project.id, teamName);
    project = requireProject(readStore(), project.id);
    const role = String(p.role || p.by || '');
    if (!ROLES.some((row) => row.id === role)) throw codedError('BAD_ROLE', `角色无效：${role || '(空)'}`);
    const sessionId = String(p.sessionId || (project.sessions && project.sessions[role]) || '');
    const verified = await verifyProjectRoleSession(project, role, sessionId, { timeoutMs: 6000 });
    if (!verified.ok) throw codedError(verified.code, verified.message);
    teamTools.syncRoster(teamName, project.sessions || {});
    const result = await teamTools.legacyProposalAction({
      ...p,
      action,
      projectName: teamName,
      role,
      sessionId: verified.sessionId
    });
    if (!result || !result.ok) {
      return {
        ok: false,
        code: (result && result.code) || 'LEGACY_PROPOSAL_FAILED',
        protocol: 'legacy',
        action,
        projectId: project.id,
        teamName,
        message: String((result && result.message) || '旧评审协议执行失败').slice(0, 400),
        details: (result && result.details) || {},
        state: statePayload()
      };
    }
    const mirrored = mirrorLegacyProposal(project.id, result);
    return {
      ...result,
      ok: true,
      projectId: project.id,
      teamName,
      mirrored,
      state: statePayload()
    };
  };
  ipcMain.handle('proposal:legacy', legacyProposalHandler);
  ipcMain.handle('team:proposal-legacy', legacyProposalHandler);
  ipcMain.handle('team:inbox', async (_e, payload) => {
    const p = payload || {};
    const role = String(p.role || 'pm');
    const ctx = await resolveProjectTeamRole(p, role);
    const all = p.all !== false;
    const result = await teamTools.inboxFor({
      projectName: ctx.teamName,
      role,
      all,
      sessionId: ctx.sessionId
    });
    if (!result.ok) {
      throw codedError(result.code || 'TEAM_INBOX_FAILED', result.message || '旧协议收件箱读取失败');
    }
    // 收件箱是只读动作：这里只同步 delivered/read 现场，不替角色写已读水位。
    reconcileProjectCommStates(readStore(), { projectId: ctx.project.id, force: true });
    const current = requireProject(readStore(), ctx.project.id);
    const localMessages = current.messages || [];
    const comm = {};
    for (const row of (Array.isArray(result.messages) ? result.messages : [])) {
      const local = localMessages.find((message) => message.id === row.id || message.teamMessageId === row.id);
      if (local) comm[row.id] = publicMessageComm(local);
    }
    return {
      ok: true,
      code: 'OK',
      role,
      project: ctx.teamName,
      sessionId: result.sessionId,
      all,
      count: result.count || 0,
      unread: result.unread || 0,
      messages: Array.isArray(result.messages) ? result.messages : [],
      comm,
      summary: commSummaryFor(current),
      identity: {
        source: 'verified-session',
        actor: 'workbench-shell',
        sessionId: ctx.sessionId,
        workspaceId: ctx.verified.workspaceId || null,
        checkedAt: ctx.verified.checkedAt || null
      }
    };
  });
  ipcMain.handle('team:read', async (_e, payload) => {
    const p = payload || {};
    const role = String(p.role || 'pm');
    const messageId = String(p.messageId || p.id || '').trim();
    if (!messageId) throw codedError('BAD_ID', '缺少要读取的邮件 id');
    const ctx = await resolveProjectTeamRole(p, role);
    // 先对账：如果角色已经自己把邮件从 new 移到 cur，read 必须记在角色头上，不能算壳。
    reconcileProjectCommStates(readStore(), { projectId: ctx.project.id, force: true });
    const result = await teamTools.readFor({
      projectName: ctx.teamName,
      role,
      messageId,
      sessionId: ctx.sessionId
    });
    if (!result.ok) {
      throw codedError(result.code || 'TEAM_READ_FAILED', result.message || '旧协议邮件读取失败');
    }
    let comm = null;
    try {
      const fresh = readStore();
      const current = fresh.projects.find((project) => project.id === ctx.project.id);
      const local = current ? (current.messages || []).find((message) => message.id === messageId || message.teamMessageId === messageId) : null;
      if (local) {
        const existing = ensureMessageComm(local);
        if (existing.read.state !== 'read') {
          setMessageCommPart(local, 'read', {
            state: 'read',
            at: now(),
            by: 'workbench-shell',
            source: 'team:read',
            sessionId: ctx.sessionId,
            alreadyRead: Boolean(result.alreadyRead),
            box: 'cur'
          });
        }
        writeStore(fresh);
        comm = publicMessageComm(local);
      }
    } catch { /* comm 镜像失败不改变旧协议已读事实 */ }
    return {
      ok: true,
      code: 'OK',
      role,
      project: ctx.teamName,
      messageId,
      message: result.message || null,
      alreadyRead: Boolean(result.alreadyRead),
      sessionId: result.sessionId,
      comm,
      identity: {
        source: 'verified-session',
        actor: 'workbench-shell',
        sessionId: ctx.sessionId,
        workspaceId: ctx.verified.workspaceId || null,
        checkedAt: ctx.verified.checkedAt || null
      }
    };
  });
  // 旧版回执列表（只读）：只读 <团队>/状态/回执.jsonl，支持项目过滤 + 最近 N 条。
  // 不接受调用方路径；不指定项目时默认只看当前项目，显式 all:true 才列全部。
  ipcMain.handle('team:receipts', (_e, payload) => {
    const p = typeof payload === 'string' ? { project: payload } : (payload || {});
    let names = [];
    const projectId = String(p.projectId || p.id || '').trim();
    if (projectId) {
      const stored = readStore().projects.find((item) => item.id === projectId);
      if (!stored) {
        return { ok: false, code: 'PROJECT_NOT_FOUND', message: '项目不存在：' + projectId, project: null, receipts: [] };
      }
      // 旧协议回执的 project 可能写项目名 / 团队名 / 工作区名，同一项目三个名字都算本项目。
      names = [
        stored.teamName,
        stored.name,
        stored.workspace && stored.workspace.name
      ].map((value) => String(value || '').trim()).filter(Boolean);
    } else if (Array.isArray(p.projects)) {
      names = p.projects.map((value) => String(value || '').trim()).filter(Boolean);
    } else {
      const project = String(p.project || p.projectName || p.name || '').trim();
      if (project) names = [project];
      else if (p.all !== true) {
        const store = readStore();
        const active = store.projects.find((item) => item.id === store.activeProjectId) || null;
        if (!active) {
          return { ok: true, code: 'NO_PROJECT', message: '还没有当前项目，未指定项目时不列回执', project: null, count: 0, receipts: [] };
        }
        names = [
          active.teamName,
          active.name,
          active.workspace && active.workspace.name
        ].map((value) => String(value || '').trim()).filter(Boolean);
      }
    }
    names = [...new Set(names)];
    if (names.some((value) => value.length > 120 || /[\\/\0]/.test(value) || value.includes('..') || /^[a-zA-Z]:/.test(value))) {
      return {
        ok: false,
        code: 'PROJECT_INVALID',
        message: '项目名不能是路径：' + String(names.find((value) => /[\\/\0]/.test(value) || value.includes('..')) || '').slice(0, 120),
        project: null,
        receipts: []
      };
    }
    try {
      return teamTools.listReceipts({ projects: names, limit: p.limit, includeUnassigned: p.includeUnassigned === true });
    } catch (error) {
      return {
        ok: false,
        code: 'RECEIPTS_FAILED',
        message: String((error && error.message) || error).slice(0, 300),
        project: names[0] || null,
        receipts: []
      };
    }
  });
  ipcMain.handle('team:send', async (_e, payload) => {
    const p = payload || {};
    let project = requireProject(readStore(), p.projectId);
    const projectId = project.id;
    // 旧协议字段：--to / --body；新界面用 role / body。from 支持任意 active 角色（含角色→PM、角色互发）。
    const role = String(p.role || p.to || p.fromTo || '');
    const from = String(p.from || p.sender || 'pm');
    if (!ROLES.some((r) => r.id === role)) throw new Error('消息收件角色无效');
    if (!ROLES.some((r) => r.id === from)) throw new Error('消息发件角色无效');
    if (from === role) throw new Error('不能给自己发团队消息');
    const body = String(p.body !== undefined ? p.body : (p.text !== undefined ? p.text : '')).trim();
    if (!body) throw new Error('派单内容不能为空');
    const subject = String(p.subject || '任务派单').slice(0, 80);
    const taskId = String(p.taskId || p.task || '');
    const ackRequired = p.ack !== false && p.ackRequired !== false;
    // 旧协议 PM 单派锁只约束 PM→其他角色且要求回执的派单；角色→PM、角色互发不占 PM 锁。
    const pmDispatch = from === 'pm' && role !== 'pm' && ackRequired;
    const warnings = [];
    let teamName = String(project.teamName || '').trim();

    // 1) 先拿团队项目名（await），并把结果缓存回当前项目；后面所有判断都用 await 之后的最新库。
    const teamNameResult = await ensureTeamName(project);
    if (teamNameResult.teamName) teamName = String(teamNameResult.teamName);
    if (!teamNameResult.ok) warnings.push({ code: teamNameResult.code, message: teamNameResult.message });
    if (teamName) persistTeamName(projectId, teamName);
    project = requireProject(readStore(), projectId);

    // 2) 旧版派单锁：同一时间只允许一个待回执派单；角色已自己回执则先撤本机假锁，再判断超时。
    // 对账直接读 回执.jsonl / 邮箱，不再用 await 前的旧消息快照覆盖检测结果。
    if (pmDispatch && project.pendingAck) {
      const detected = reconcileProjectCommStates(readStore(), { projectId, force: true });
      if (detected.changed) project = requireProject(readStore(), projectId);
    }
    if (pmDispatch && project.pendingAck) {
      if (!pendingAckExpired(project)) {
        throw new Error(`还有一条派单未回执，先等回执、撤销，或等 ${Math.round(ACK_TTL_MS / 60000)} 分钟超时`);
      }
      const stale = project.messages.find((m) => m.id === project.pendingAck);
      const canCheckOldLock = teamTools.toolInfo().available && Boolean(teamName);
      let released = null;
      if (canCheckOldLock) {
        // 即使本地消息没有 teamMessageId，也按 派单锁.json 自身 id 释放；不能用旧快照跳过。
        released = releaseOldDispatchLock(project, stale ? stale.id : project.pendingAck);
        if (!released.ok) {
          // 释放失败就保留本地锁，绝不“本地清了、旧锁还在”制造永久 PM_DISPATCH_PENDING。
          throw codedError(released.code || 'OLD_LOCK_RELEASE_FAILED',
            `${released.message || '旧派单锁未释放'}；请先在团队台点「释放旧派单锁」或调用 team:cancel`);
        }
      }
      project = (() => {
        const fresh = readStore();
        const current = fresh.projects.find((item) => item.id === projectId);
        if (!current) throw codedError('PROJECT_MISSING', '项目不存在');
        if (current.pendingAck) {
          clearPendingAck(current, `派单锁超过 ${Math.round(ACK_TTL_MS / 60000)} 分钟，自动释放${released && released.removed ? '（旧派单锁已释放）' : ''}`);
          writeStore(fresh);
        }
        return current;
      })();
    }

    const sessionId = project.sessions && project.sessions[role] ? String(project.sessions[role]) : '';
    const senderSession = project.sessions && project.sessions[from] ? String(project.sessions[from]) : '';
    // 发件人/收件人都必须有“当前项目”的真实会话；B 项目没有会话时必须在这里拒绝，
    // 不能先写旧协议、再让回执阶段报 SESSION_IDENTITY_MISSING 形成死信。
    if (!senderSession) {
      throw codedError('SESSION_ID_REQUIRED', `发件角色「${from}」在当前项目没有真实 DSH 会话，不能发团队消息`);
    }
    if (!sessionId) {
      throw codedError('SESSION_ID_REQUIRED', `收件角色「${role}」在当前项目没有真实 DSH 会话，不能发死信；请先启动团队`);
    }

    let source = 'local';
    let wake = { ok: false, why: '没有 DSH 会话' };
    let sessionIdentity = null;
    let recipientIdentity = null;
    let messageDraft = null;
    let wakeText = '';
    const tool = teamTools.toolInfo();

    if (tool.available && teamName) {
      // send 前核验：发件人和收件人的映射会话都必须仍存在、未归档、属于当前 workspace。
      sessionIdentity = await verifyProjectRoleSession(project, from, senderSession, { timeoutMs: 6000 });
      if (!sessionIdentity.ok) throw codedError(sessionIdentity.code, sessionIdentity.message);
      recipientIdentity = await verifyProjectRoleSession(project, role, sessionId, { timeoutMs: 6000 });
      if (!recipientIdentity.ok) throw codedError(recipientIdentity.code, recipientIdentity.message);
      teamTools.syncRoster(teamName, project.sessions || {});
      // 派单/回执走旧团队工具：team.mjs send（PM 一次只能派一个，由旧协议自己兜）。
      const buildDispatch = () => teamTools.sendDispatch({
        projectName: teamName,
        from,
        to: role,
        subject,
        body,
        task: taskId,
        type: p.type ? String(p.type) : 'note',
        ackRequired,
        sessionId: senderSession
      });
      let teamResult = await buildDispatch();
      // 旧记录可能还没登记团队项目：补一次 ensure 再重试，仍失败才降级本地。
      if (!teamResult.ok && ['NO_TEAM', 'NO_PROJECT', 'BOOT_FAILED', 'MISSING_DOC'].includes(teamResult.code)) {
        const ensured = await syncTeamProject(project, { engineUrl: dsh.baseUrl });
        if (ensured.ok && ensured.name) {
          teamName = String(ensured.name);
          persistTeamName(projectId, teamName);
          teamResult = await buildDispatch();
        }
      }
      if (teamResult.ok) {
        source = 'team';
        wakeText = String(teamResult.wakeText || '');
        messageDraft = {
          id: String(teamResult.message.id),
          teamMessageId: String(teamResult.message.id),
          from,
          to: role,
          subject: String(teamResult.message.subject || subject),
          body: String(teamResult.message.body || body),
          taskId: String(teamResult.message.task || taskId),
          project: String(teamResult.message.project || teamName),
          ackRequired: Boolean(teamResult.message.ackRequired),
          ack: false,
          ackNote: '',
          createdAt: teamResult.message.ts || now(),
          ackAt: null,
          source: 'team',
          senderSessionId: senderSession,
          senderWorkspaceId: sessionIdentity ? sessionIdentity.workspaceId : null,
          recipientSessionId: sessionId,
          recipientWorkspaceId: recipientIdentity ? recipientIdentity.workspaceId : null,
          // 发件/收件会话身份都已核验；执行者仍是工作台壳进程，actor 不冒充角色。
          identitySource: 'verified-session',
          actor: 'workbench-shell',
          tool: 'team.mjs send'
        };
        if (teamResult.truncated) warnings.push({ code: 'MESSAGE_TRUNCATED', message: '消息超过旧协议长度上限，已按旧规则截断' });
      } else if (teamResult.code === 'PM_DISPATCH_PENDING') {
        const pending = teamResult.details && teamResult.details.pending ? teamResult.details.pending : null;
        const detail = pending ? `${pending.messageId} → ${pending.to}（${pending.subject}）` : '';
        throw codedError('PM_DISPATCH_PENDING', `上一条派单还没回执：${detail}。先等回执，确认后再派下一个。`);
      } else if (teamResult.code === 'TEAM_ROLE_NOT_READY' || teamResult.code === 'NO_RECIPIENT' || teamResult.code === 'NO_SENDER') {
        throw codedError('TEAM_ROLE_NOT_READY', `${teamResult.message || '角色还不在团队名册'}；请先点「启动团队」建齐六角色会话`);
      } else if (['TOOL_MISSING', 'TIMEOUT', 'SPAWN_ERROR', 'BAD_JSON', 'TOOL_EXIT', 'NO_TEAM', 'NO_PROJECT', 'BOOT_FAILED', 'MISSING_DOC'].includes(teamResult.code)) {
        // 工具层/旧登记缺失才降级本地；协议层错误（锁、名册、会话身份）必须直接暴露，不能悄悄本地化。
        warnings.push({ code: teamResult.code, message: teamResult.message || '团队工具不可用，已回退本地记录（降级）' });
      } else {
        throw codedError(teamResult.code || 'TEAM_SEND_FAILED', teamResult.message || '旧协议派单失败');
      }
    } else if (!tool.available) {
      warnings.push({ code: 'TEAM_TOOL_UNAVAILABLE', message: '团队工具缺失，派单只写本地镜像（降级）' });
    }

    if (!messageDraft) {
      // 降级路径：保留旧行为（本地消息 + 本地派单锁），显式标记 source/degraded。
      messageDraft = {
        id: id('M'),
        from,
        to: role,
        subject,
        body: body.slice(0, 600),
        taskId,
        project: teamName || project.teamName || project.name,
        ackRequired,
        ack: false,
        ackNote: '',
        createdAt: now(),
        ackAt: null,
        source: 'local',
        degraded: true,
        senderSessionId: senderSession || null,
        recipientSessionId: sessionId || null,
        actor: 'workbench-shell',
        reason: warnings.length ? warnings[warnings.length - 1].code : 'TEAM_TOOL_UNAVAILABLE'
      };
    }
    if (!wakeText) {
      wakeText = teamTools.wakeMessageFor({
        projectName: messageDraft.project || teamName || project.name,
        role,
        from,
        messageId: messageDraft.teamMessageId || messageDraft.id,
        subject: messageDraft.subject,
        task: messageDraft.taskId,
        ackRequired: messageDraft.ackRequired !== false
      }).text;
    }

    // 落库前先写通信链初始态：delivered（旧协议邮箱已写）/ wake= pending。
    // wake 不能预先算成功，必须等 DSH prompt 返回后再补 sent/failed。
    buildInitialMessageComm(messageDraft, { source, sessionId });

    // 3) await 结束后重新读库，只把本次派单合并进当前项目；绝不写回 await 之前的旧快照。
    let lockTaken = false;
    let pendingConflict = null;
    const persisted = (() => {
      const fresh = readStore();
      const current = fresh.projects.find((x) => x.id === projectId);
      if (!current) throw codedError('PROJECT_MISSING', '项目在派单过程中被删除');
      if (taskId) {
        const task = current.tasks.find((x) => x.id === taskId);
        if (task && !task.role) task.role = role;
      }
      const message = pushProjectMessage(current, messageDraft);
      if (sessionId && pmDispatch) {
        const pendingNow = current.pendingAck ? String(current.pendingAck) : '';
        if (!pendingNow || pendingNow === message.id || pendingAckExpired(current)) {
          current.pendingAck = message.id;
          current.pendingAckAt = now();
          lockTaken = true;
        } else {
          pendingConflict = pendingNow;
          warnings.push({ code: 'PENDING_ACK_CONFLICT', message: `派单期间已出现新的待回执 ${pendingNow}，本次未覆盖其本地锁` });
        }
      }
      addEvent(current, sessionId
        ? `${from}→${role} 派单 ${message.id}（${source}${pmDispatch ? (lockTaken ? '，已加锁' : '，锁冲突未加锁') : ''}）`
        : `${from}→${role} 派单 ${message.id}（没有 DSH 会话，未加锁）`);
      writeStore(fresh);
      return { project: current, message };
    })();
    if (pendingConflict && source === 'team' && teamName && messageDraft.teamMessageId) {
      // 本地锁被别人占住：旧协议锁也不能留着，否则下一位被永久卡死。
      const released = teamTools.releaseDispatchLock(teamName, messageDraft.teamMessageId);
      if (!released.ok) warnings.push({ code: released.code, message: released.message });
    }

    let wakePart = null;
    if (sessionId) {
      try {
        // 旧版四步唤醒：boot → inbox --all → read --id → ack --id。
        await dsh.prompt(sessionId, wakeText);
        const at = now();
        wake = {
          ok: true,
          role,
          state: 'sent',
          at,
          sessionId,
          steps: COMM_WAKE_STEPS.slice(),
          mode: 'dsh.prompt',
          messageId: messageDraft.id
        };
        wakePart = { state: 'sent', at, by: 'workbench-shell', sessionId, steps: COMM_WAKE_STEPS.slice(), mode: 'dsh.prompt' };
      } catch (e) {
        const at = now();
        wake = {
          ok: false,
          why: String(e.message || e).slice(0, 160),
          code: (e && e.code) || 'DSH_OFFLINE',
          state: 'failed',
          at,
          sessionId
        };
        wakePart = { state: 'failed', at, by: 'workbench-shell', sessionId, error: wake.why, code: wake.code };
      }
      if (!wake.ok) {
        // 唤醒失败：本地锁和旧协议锁都释放，避免项目被锁死。
        if (source === 'team' && teamName && pmDispatch && messageDraft.teamMessageId) {
          const released = teamTools.releaseDispatchLock(teamName, messageDraft.teamMessageId);
          if (!released.ok) warnings.push({ code: released.code, message: released.message });
        }
        const fresh = readStore();
        const current = fresh.projects.find((x) => x.id === projectId);
        if (current && current.pendingAck === persisted.message.id) {
          clearPendingAck(current, '唤醒失败，派单锁已释放');
          writeStore(fresh);
        }
      }
    } else {
      const at = now();
      wake = { ok: false, why: '没有 DSH 会话', state: 'skipped', at, code: 'NO_SESSION' };
      wakePart = { state: 'skipped', at, by: 'workbench-shell', sessionId: null, reason: 'NO_SESSION' };
      if (source === 'team' && teamName && pmDispatch && messageDraft.teamMessageId) {
        // 没有目标会话时旧版不加锁；旧协议那边已经写了锁，这里立刻释放。
        const released = teamTools.releaseDispatchLock(teamName, messageDraft.teamMessageId);
        if (!released.ok) warnings.push({ code: released.code, message: released.message });
      }
    }
    // 4) wake 结果落回同一条消息；绝不覆盖并发写入的其他任务/消息。
    let currentMessage = persisted.message;
    try {
      const finalStore = readStore();
      const finalProject = finalStore.projects.find((x) => x.id === projectId);
      const stored = finalProject ? (finalProject.messages || []).find((m) => m.id === persisted.message.id) : null;
      if (stored) {
        if (wakePart) setMessageCommPart(stored, 'wake', wakePart);
        setMessageCommPart(stored, 'delivered', {
          state: source === 'team' ? 'delivered' : 'local-only',
          at: stored.createdAt || now(),
          by: 'workbench-shell',
          source: source === 'team' ? 'team.mjs send' : 'local-mirror',
          mailbox: source === 'team' ? 'new' : null
        });
        writeStore(finalStore);
        currentMessage = stored;
      }
    } catch { /* wake 结果落库失败不改变已发送事实；下次对账会补 */ }
    return {
      ok: true,
      message: currentMessage,
      comm: publicMessageComm(currentMessage),
      wake,
      source,
      sessionIdentity,
      recipientIdentity,
      actor: 'workbench-shell',
      lockTaken,
      pendingAckConflict: pendingConflict,
      warnings,
      state: statePayload()
    };
  });
  ipcMain.handle('team:cancel', async (_e, payload) => {
    const p = typeof payload === 'string' ? { projectId: payload } : (payload || {});
    let project = requireProject(readStore(), p.projectId);
    const projectId = project.id;
    const requestedId = String(p.messageId || p.id || '').trim();
    const warnings = [];
    let released = null;
    let lockBefore = null;
    let teamName = String(project.teamName || '').trim();
    // 撤销 = 释放旧协议派单锁。即使本地 pendingAck 已被清空（降级回执/超时/重启），
    // 也要读 派单锁.json 把残留锁释放掉，否则下一次 PM 派单永远 PM_DISPATCH_PENDING。
    if (teamTools.toolInfo().available) {
      const teamNameResult = await ensureTeamName(project);
      if (teamNameResult.ok && teamNameResult.teamName) {
        teamName = String(teamNameResult.teamName);
        persistTeamName(projectId, teamName);
        // ensureTeamName 有 await：重新读库，按最新 pendingAck/消息判断要释放哪把锁。
        project = requireProject(readStore(), projectId);
        const pendingNow = project.pendingAck ? String(project.pendingAck) : '';
        const messageNow = project.messages.find((item) =>
          (requestedId && item.id === requestedId) || (!requestedId && pendingNow && item.id === pendingNow)
        ) || null;
        if (requestedId && !messageNow) {
          const error = new Error('消息不存在，未释放任何派单锁');
          error.code = 'MESSAGE_NOT_FOUND';
          throw error;
        }
        const expected = messageNow && messageNow.teamMessageId ? String(messageNow.teamMessageId) : '';
        lockBefore = teamTools.readDispatchLockState(teamName);
        if (lockBefore) {
          if (expected && String(lockBefore.messageId) !== expected) {
            released = {
              ok: false,
              code: 'LOCK_MISMATCH',
              message: `旧派单锁属于 ${lockBefore.messageId}，不能释放 ${expected}`,
              pending: { messageId: lockBefore.messageId, to: lockBefore.to, subject: lockBefore.subject }
            };
            warnings.push({ code: released.code, message: released.message });
          } else {
            released = teamTools.releaseDispatchLock(teamName, String(lockBefore.messageId));
            if (!released.ok) warnings.push({ code: released.code, message: released.message });
          }
        }
      } else {
        warnings.push({ code: teamNameResult.code, message: teamNameResult.message });
      }
    } else {
      warnings.push({ code: 'TEAM_TOOL_UNAVAILABLE', message: '团队工具缺失，无法释放旧派单锁' });
    }
    // await 结束：重新读库合并，只清“当前仍是这条”的本地锁，不写回旧快照。
    const fresh = readStore();
    const current = fresh.projects.find((item) => item.id === projectId);
    if (!current) {
      return { ok: true, released, lock: lockBefore, cleared: false, warnings, state: statePayload() };
    }
    const pendingNow = current.pendingAck ? String(current.pendingAck) : '';
    const messageNow = current.messages.find((item) =>
      (requestedId && item.id === requestedId) || (!requestedId && pendingNow && item.id === pendingNow)
    ) || null;
    const target = requestedId || (messageNow ? messageNow.id : pendingNow);
    const cleared = Boolean(target && pendingNow === target);
    if (cleared) {
      clearPendingAck(current, `撤销待回执 ${target}${released && released.removed ? '（旧派单锁已释放）' : ''}`);
    } else if (released && released.removed) {
      addEvent(current, `撤销派单${messageNow ? ' ' + messageNow.id : ''}，释放残留旧派单锁`);
    } else {
      addEvent(current, `撤销派单${messageNow ? ' ' + messageNow.id : ''}（没有待回执锁）`);
    }
    writeStore(fresh);
    return { ok: true, released, lock: lockBefore, cleared, warnings, state: statePayload() };
  });
  ipcMain.handle('team:ack', async (_e, payload) => {
    const p = payload || {};
    let project = requireProject(readStore(), p.projectId);
    const projectId = project.id;
    const messageId = String(p.messageId || p.id || '');
    let message = project.messages.find((m) => m.id === messageId);
    if (!message) throw new Error('派单不存在');
    // 先对账旧协议现场：角色自己 ack 后，壳只认领“已存在”，绝不重复 ack。
    reconcileProjectCommStates(readStore(), { projectId, force: true });
    project = requireProject(readStore(), projectId);
    message = project.messages.find((m) => m.id === messageId);
    if (!message) throw new Error('派单不存在');
    if (message.ack) {
      return {
        ok: true,
        already: true,
        message,
        comm: publicMessageComm(message),
        source: message.ackSource || 'team-external',
        actor: message.actor || 'pre-existing',
        executor: message.executor || 'role-session',
        selfExecuted: Boolean(message.comm && message.comm.selfExecuted && message.comm.selfExecuted.ack),
        warnings: [{ code: 'ACK_ALREADY', message: '这条派单已被回执处理（可能正是角色自己执行），本次未重复写库' }],
        state: statePayload()
      };
    }
    const note = String(p.note || '').trim();
    if (!note) throw new Error('回执必须写一句处理结果');
    const ackRole = String(p.role || message.to || '');
    if (ackRole !== message.to) throw new Error('回执角色必须与派单收件人一致');
    let mappedSession = project.sessions && project.sessions[message.to] ? String(project.sessions[message.to]) : '';
    const claimedSession = String(p.sessionId || '').trim();
    const messageTo = String(message.to);
    const messageFrom = String(message.from);
    const messageTeamId = String(message.teamMessageId || '');
    const isPmDispatch = messageFrom === 'pm' && messageTo !== 'pm' && message.ackRequired !== false;
    // 默认不再由壳代跑 ack：必须由收件角色自己的会话执行旧协议 ack。
    // 只有显式 allowShellAck:true（壳代跑，actor=workbench-shell）或 manual:true（人工确认）才允许壳写。
    const allowShellAck = p.allowShellAck === true;

    // 人工确认不是旧协议回执：只记本地，不冒充角色 ack、不清旧协议锁。
    // actor 明确写 workbench-shell/manual，审计时一眼能区分“人点的确认”和“角色自己 ack”。
    if (p.manual === true) {
      const fresh = readStore();
      const current = fresh.projects.find((x) => x.id === projectId);
      if (!current) throw new Error('项目不存在');
      const target = current.messages.find((m) => m.id === messageId);
      if (!target) throw new Error('派单不存在');
      if (target.ack) throw new Error('这条派单已经回执');
      target.manualAck = true;
      target.manualAckNote = note.slice(0, 300);
      target.manualAckAt = now();
      target.ackSource = 'manual';
      target.actor = 'workbench-shell/manual';
      target.executor = 'workbench-shell';
      target.identitySource = 'manual-confirm';
      setMessageCommPart(target, 'ack', {
        state: 'manual',
        at: target.manualAckAt,
        by: 'human',
        actor: 'workbench-shell/manual',
        source: 'manual',
        receiptId: null,
        sessionId: mappedSession || null,
        note: note.slice(0, 300)
      });
      target.comm.selfExecuted.ack = false;
      addEvent(current, `人工确认 ${target.id}（非旧协议回执，未清锁）`);
      writeStore(fresh);
      return {
        ok: true,
        message: target,
        comm: publicMessageComm(target),
        source: 'manual',
        manual: true,
        actor: 'workbench-shell/manual',
        executor: 'workbench-shell',
        warnings: [{ code: 'MANUAL_ACK', message: '已按人工确认记录，actor=workbench-shell/manual；不是角色会话回执，旧协议锁未释放' }],
        state: statePayload()
      };
    }
    if (!mappedSession) {
      throw codedError('SESSION_IDENTITY_MISSING', '这个角色还没有真实 DSH 会话，不能代写旧协议回执');
    }
    if (claimedSession && claimedSession !== mappedSession) {
      throw codedError('SESSION_IDENTITY_MISMATCH', `回执会话 ${claimedSession} 不是该角色的映射会话 ${mappedSession}`);
    }
    if (!allowShellAck) {
      const error = codedError(
        'ROLE_ACK_REQUIRED',
        `回执必须由收件角色「${messageTo}」自己的会话执行旧协议 ack；工作台壳默认不代跑。`
        + '如果确认要由壳代跑，调用方必须显式传 allowShellAck:true，actor 会写成 workbench-shell。'
      );
      Object.assign(error, {
        action: 'role-execute',
        messageId,
        role: messageTo,
        sessionId: mappedSession,
        comm: publicMessageComm(message),
        manualAllowed: true,
        allowShellAckHint: true
      });
      throw error;
    }
    const warnings = [];
    if (isPmDispatch && project.pendingAck && project.pendingAck !== message.id && !pendingAckExpired(project)) {
      throw new Error('回执对象不是当前待回执消息');
    }
    let source = 'local';
    let ackId = message.ackId || '';
    let receiptMessageId = message.receiptMessageId || '';
    let verifiedIdentity = null;
    let lockHeld = false;
    let oldLockReleased = false;
    let ackActor = 'workbench-shell';
    let ackAlready = false;
    const tool = teamTools.toolInfo();
    // 回执走旧协议：先核验会话属于当前项目 workspace，再以派单目标角色身份 ack。
    if (messageTeamId && tool.available) {
      const teamNameResult = await ensureTeamName(project);
      if (teamNameResult.ok && teamNameResult.teamName) {
        const teamName = teamNameResult.teamName;
        persistTeamName(projectId, teamName);
        // ensure/verify 都有 await：重新读库，按最新消息/锁状态合并，绝不写回旧快照。
        project = requireProject(readStore(), projectId);
        message = project.messages.find((m) => m.id === messageId) || message;
        if (message.ack) {
          return {
            ok: true,
            already: true,
            message,
            comm: publicMessageComm(message),
            source: message.ackSource || 'team',
            actor: message.actor || 'pre-existing',
            executor: message.executor || 'role-session',
            selfExecuted: Boolean(message.comm && message.comm.selfExecuted && message.comm.selfExecuted.ack),
            warnings: [{ code: 'ACK_ALREADY', message: '这条派单已被另一路回执处理，本次未重复写库' }],
            state: statePayload()
          };
        }
        // 超时本地锁与当前回执对象不一致：先释放旧锁，再决定是否保留本地锁。
        if (isPmDispatch && project.pendingAck && project.pendingAck !== message.id && pendingAckExpired(project)) {
          const staleStore = readStore();
          const staleProject = staleStore.projects.find((x) => x.id === projectId) || project;
          const stalePending = String(staleProject.pendingAck || '');
          const released = releaseOldDispatchLock(staleProject, stalePending);
          if (released.ok) {
            if (staleProject.pendingAck && staleProject.pendingAck !== message.id) {
              clearPendingAck(staleProject, `派单锁超时，自动释放${released.removed ? '（旧派单锁已释放）' : ''}`);
              writeStore(staleStore);
            }
          } else {
            warnings.push({ code: released.code, message: released.message });
          }
          project = requireProject(readStore(), projectId);
          message = project.messages.find((m) => m.id === messageId) || message;
        }
        verifiedIdentity = await verifyProjectRoleSession(project, message.to, claimedSession, { timeoutMs: 6000 });
        if (!verifiedIdentity.ok) throw codedError(verifiedIdentity.code, verifiedIdentity.message);
        // 名册同步成当前项目快照，避免旧协议 boot 读到另一个项目的 sessionId。
        teamTools.syncRoster(teamName, project.sessions || {});
        const ackSession = project.sessions && project.sessions[message.to] ? String(project.sessions[message.to]) : mappedSession;
        mappedSession = ackSession;
        const result = await teamTools.ackDispatch({
          projectName: teamName,
          role: message.to,
          messageId: messageTeamId,
          note,
          sessionId: ackSession,
          identitySource: 'verified-session',
          workspaceId: verifiedIdentity.workspaceId,
          checkedAt: verifiedIdentity.checkedAt,
          // 壳进程执行 team.mjs ack：actor 必须是 workbench-shell，不能冒充角色。
          actor: 'workbench-shell'
        });
        if (result.ok) {
          ackId = result.ackId || ackId;
          receiptMessageId = result.receiptMessage && result.receiptMessage.id ? result.receiptMessage.id : receiptMessageId;
          source = 'team';
          ackAlready = Boolean(result.already);
          ackActor = result.actor || (ackAlready ? 'pre-existing' : 'workbench-shell');
          if (result.already) warnings.push({ code: 'ACK_ALREADY', message: '旧协议里这条已经回执过（本次壳未执行 ack，actor 不写 workbench-shell）' });
          if (result.identity && result.identity.ok === false) {
            warnings.push({ code: result.identity.code || 'RECEIPT_IDENTITY_FAILED', message: result.identity.message || '回执会话身份未写入 回执.jsonl' });
          }
        } else if (['TEAM_ROLE_NOT_READY', 'NO_TEAM', 'NO_PROJECT', 'TOOL_MISSING', 'MESSAGE_NOT_FOUND', 'BOOT_REQUIRED', 'BOOT_INVALID', 'BOOT_EXPIRED', 'RULES_CHANGED', 'BOOT_FAILED', 'SESSION_ID_REQUIRED'].includes(result.code)) {
          // 旧协议里查不到（团队状态重建/角色不在名册）：退回本地镜像，但必须释放旧 派单锁.json。
          warnings.push({ code: result.code, message: result.message || '旧协议回执失败，已只记本地' });
          source = message.source === 'team' ? 'team-local' : 'local';
          const released = releaseOldDispatchLock(project, message.id);
          if (released.ok) {
            oldLockReleased = Boolean(released.removed);
            if (oldLockReleased) warnings.push({ code: 'OLD_LOCK_RELEASED', message: '降级回执已释放旧 派单锁.json' });
          } else {
            lockHeld = true;
            warnings.push({ code: released.code || 'OLD_LOCK_RELEASE_FAILED', message: released.message || '旧 派单锁.json 未释放，保留本地待回执锁' });
          }
        } else {
          throw codedError(result.code || 'TEAM_ACK_FAILED', result.message || '旧协议回执失败');
        }
      } else {
        warnings.push({ code: teamNameResult.code, message: '团队项目不可用，回执只记本地镜像' });
        source = message.source === 'team' ? 'team-local' : 'local';
        const released = releaseOldDispatchLock(project, message.id);
        if (released.ok) oldLockReleased = Boolean(released.removed);
        else { lockHeld = true; warnings.push({ code: released.code, message: released.message }); }
      }
    } else if (messageTeamId) {
      warnings.push({ code: 'TEAM_TOOL_UNAVAILABLE', message: '团队工具缺失，回执只记本地镜像（降级）' });
      lockHeld = true;
      warnings.push({ code: 'OLD_LOCK_UNRELEASED', message: '团队工具缺失，无法释放旧 派单锁.json' });
    }
    // 所有 await 结束：读最新库，只合并这一条消息与本项目 pendingAck。
    const fresh = readStore();
    const current = fresh.projects.find((x) => x.id === projectId);
    if (!current) throw new Error('项目不存在');
    const currentMessage = current.messages.find((m) => m.id === messageId);
    if (!currentMessage) throw new Error('派单不存在');
    if (currentMessage.ack) {
      return {
        ok: true,
        already: true,
        message: currentMessage,
        comm: publicMessageComm(currentMessage),
        source: currentMessage.ackSource || source,
        actor: currentMessage.actor || 'pre-existing',
        executor: currentMessage.executor || 'role-session',
        selfExecuted: Boolean(currentMessage.comm && currentMessage.comm.selfExecuted && currentMessage.comm.selfExecuted.ack),
        warnings: [{ code: 'ACK_ALREADY', message: '这条派单已被另一路回执处理，本次未重复写库' }],
        state: statePayload()
      };
    }
    currentMessage.ack = true;
    currentMessage.ackNote = note.slice(0, 300);
    currentMessage.ackAt = now();
    currentMessage.receiptMessageId = receiptMessageId || null;
    currentMessage.ackSource = source;
    currentMessage.ackSessionId = verifiedIdentity ? verifiedIdentity.sessionId : (mappedSession || null);
    // 只有真正走通旧协议 ack 才标 verified-session；降级本地只能标 local-mapping，不能冒充角色回执。
    currentMessage.ackWorkspaceId = source === 'team' && verifiedIdentity ? verifiedIdentity.workspaceId : null;
    currentMessage.identitySource = source === 'team' && verifiedIdentity ? 'verified-session' : 'local-mapping';
    currentMessage.oldLockReleased = oldLockReleased;
    // actor 语义：人工=workbench-shell/manual；显式 allowShellAck 的壳代跑=workbench-shell；
    // 旧协议里原本就有的回执=pre-existing，不替角色认领。
    currentMessage.actor = ackActor;
    currentMessage.executor = ackActor === 'workbench-shell' ? 'workbench-shell' : 'unknown';
    const ackWasAlready = Boolean(ackAlready) || ackActor === 'pre-existing';
    setMessageCommPart(currentMessage, 'ack', {
      state: 'acked',
      at: currentMessage.ackAt,
      by: ackWasAlready ? 'role' : 'workbench-shell',
      actor: ackActor,
      source: ackWasAlready ? 'receipt' : (source === 'team' ? 'team:ack' : 'local-receipt'),
      receiptId: ackId || null,
      sessionId: currentMessage.ackSessionId,
      identitySource: currentMessage.identitySource,
      workspaceId: currentMessage.ackWorkspaceId,
      allowShellAck: !ackWasAlready,
      detectedAt: ackWasAlready ? now() : null
    });
    currentMessage.comm.selfExecuted.ack = ackWasAlready;
    if (source !== 'team') {
      // 降级/本地回执也要落看板数据源，但带 source=local/actor=workbench-shell，旧协议消费者能区分。
      const localReceipt = teamTools.appendLocalReceipt({
        id: ackId || id('A-local'),
        msgId: currentMessage.teamMessageId || currentMessage.id,
        from: currentMessage.to,
        role: currentMessage.to,
        to: currentMessage.from,
        project: current.teamName || current.name,
        note,
        sessionId: mappedSession || '',
        actor: 'workbench-shell',
        executor: 'workbench-shell'
      });
      if (localReceipt.ok) {
        ackId = ackId || localReceipt.receipt.id;
        currentMessage.localReceiptId = localReceipt.receipt.id;
      } else {
        warnings.push({ code: localReceipt.code, message: localReceipt.message || '本地回执未写入看板数据源' });
      }
    }
    currentMessage.ackId = ackId || null;
    if (current.pendingAck === currentMessage.id) {
      if (lockHeld) addEvent(current, `回执 ${currentMessage.id} 已记本地，但旧派单锁未释放，保留待回执锁`);
      else clearPendingAck(current);
    }
    addEvent(current, `回执 ${currentMessage.id} ← ${messageTo}（${source === 'team' ? '旧协议 · 已验证会话 ' + mappedSession : '本地镜像'}；actor=${ackActor}）`);
    writeStore(fresh);
    const board = mirrorToTeamBoard(current);
    return {
      ok: true,
      message: currentMessage,
      comm: publicMessageComm(currentMessage),
      source,
      actor: ackActor,
      executor: currentMessage.executor,
      selfExecuted: Boolean(currentMessage.comm && currentMessage.comm.selfExecuted && currentMessage.comm.selfExecuted.ack),
      already: ackAlready,
      sessionId: mappedSession || null,
      identity: verifiedIdentity,
      lockHeld,
      oldLockReleased,
      board,
      warnings,
      state: statePayload()
    };
  });
  // 六会话通信链只读查询：delivered / wake / read / ack 四段状态 + 角色自执行标记。
  // 查询前强制对账旧协议现场，所以角色在 DSH 里自己 read/ack 后，这里立刻可见。
  ipcMain.handle('team:comm', (_e, payload) => {
    const p = payload || {};
    const project = requireProject(readStore(), p.projectId);
    const reconcile = reconcileProjectCommStates(readStore(), { projectId: project.id, force: true });
    commReconcileCache = { at: Date.now(), result: reconcile };
    const fresh = requireProject(readStore(), project.id);
    const messageId = String(p.messageId || p.id || '').trim();
    if (messageId) {
      const message = (fresh.messages || []).find((row) => String(row.id) === messageId || String(row.teamMessageId || '') === messageId);
      if (!message) throw codedError('MESSAGE_NOT_FOUND', '消息不存在：' + messageId);
      return {
        ok: true,
        code: 'OK',
        projectId: fresh.id,
        teamName: fresh.teamName || fresh.name,
        messageId: message.id,
        comm: publicMessageComm(message),
        message,
        reconcile,
        state: statePayload()
      };
    }
    let messages = (fresh.messages || []).filter((message) => message && (message.source === 'team' || message.comm));
    if (p.role) messages = messages.filter((message) => message.to === p.role || message.from === p.role);
    return {
      ok: true,
      code: 'OK',
      projectId: fresh.id,
      teamName: fresh.teamName || fresh.name,
      summary: commSummaryFor(fresh),
      messages: messages.map(publicMessageComm),
      reconcile,
      state: statePayload()
    };
  });
  ipcMain.handle('team:reconcile', (_e, payload) => {
    const p = payload || {};
    const project = requireProject(readStore(), p.projectId);
    const reconcile = reconcileProjectCommStates(readStore(), { projectId: project.id, force: true });
    commReconcileCache = { at: Date.now(), result: reconcile };
    const fresh = requireProject(readStore(), project.id);
    return {
      ok: true,
      code: 'OK',
      projectId: fresh.id,
      teamName: fresh.teamName || fresh.name,
      summary: commSummaryFor(fresh),
      reconcile,
      state: statePayload()
    };
  });
  ipcMain.handle('owner:decide', async (_e, payload) => {
    const p = payload || {};
    const store = readStore();
    const project = requireProject(store, p.projectId);
    // 旧协议 workflow:owner 用 decision，新界面用 status。
    const status = String(p.status || p.decision || '');
    // Owner 确认码已废弃：决定直接以 role=owner 接受，不再校验 confirmToken/nonce。
    const roundKey = workflowSnapshot(project).roundKey;
    ownerDecide(project, status, p.opinion, { roundKey });
    writeStore(store);
    const current = requireProject(readStore(), project.id);
    const finalStatus = ['approved', 'skipped', 'rejected'].includes(status);
    let teamResult = null;
    let fallback = null;
    if (finalStatus) {
      try {
        teamResult = await teamTools.recordOwnerDecision(current, { status, opinion: p.opinion, roundKey, by: 'Owner' });
      } catch (error) {
        fallback = {
          code: 'OWNER_WORKFLOW_FAILED',
          message: '旧版 工作流.json / PM 系统消息处理失败：' + String((error && error.message) || error).slice(0, 300)
        };
      }
    }
    const outcome = finalStatus
      ? ownerTeamOutcome(teamResult, fallback)
      : {
        workflowFile: null,
        workflowWrite: { ok: false, attempted: false, code: 'OWNER_NOT_FINAL', message: 'Owner 状态未到终态，未写旧版 工作流.json' },
        notified: null,
        warnings: []
      };
    if (finalStatus) noteOwnerWorkflowFailure(current.id, outcome.workflowWrite);
    return {
      ok: true,
      projectId: current.id,
      ownerReview: current.ownerReview,
      roundKey,
      stage: deriveStage(current),
      workflowFile: outcome.workflowFile,
      workflow: (teamResult && teamResult.workflow) || null,
      workflowWrite: outcome.workflowWrite,
      notified: outcome.notified,
      warnings: outcome.warnings,
      state: statePayload()
    };
  });
  ipcMain.handle('dsh:status', async () => {
    // DSH 更新后端口会变：检测失败时先尝试从 DSH 进程/监听端口自动发现，
    // 发现成功则持久化并重载 WebView；失败保留原地址，把原因写进 status.message。
    const canDiscover = dshAutoDiscoveryAllowed();
    const status = await dsh.check({ timeoutMs: canDiscover ? DSH_DISCOVERY_CHECK_TIMEOUT_MS : 8000 });
    let finalStatus = status;
    let discovery = null;
    // 凭据问题不是端口问题：换端口解决不了，还会白扫进程；手动 IPC 仍可强制重发现。
    const authFailure = status.code === 'DSH_AUTH_MISSING' || status.code === 'DSH_AUTH_REJECTED';
    if (!status.online && canDiscover && !authFailure) {
      discovery = await maybeAutoDiscoverDsh('status');
      if (discovery && discovery.ok) {
        finalStatus = discovery.status || await dsh.check({ timeoutMs: 6000 });
      } else if (discovery && !discovery.skipped) {
        finalStatus = {
          ...status,
          message: String((status.message || 'DSH 离线') + '；' + discovery.message).slice(0, 400),
          discovery: dshDiscoverySummary(discovery)
        };
      } else if (discovery && discovery.code === 'DSH_DISCOVERY_COOLDOWN'
        && dshDiscovery.last && !dshDiscovery.last.ok) {
        // 冷却期内重复检测也把上一次失败原因带出来，避免只显示 “fetch failed”。
        finalStatus = {
          ...status,
          message: String((status.message || 'DSH 离线') + '；' + dshDiscovery.last.message).slice(0, 400),
          discovery: dshDiscoverySummary(dshDiscovery.last)
        };
      }
    }
    return { ok: true, status: finalStatus, discovery: discovery ? dshDiscoverySummary(discovery) : null };
  });
  // 手动“重新发现”：供设置页/诊断按钮调用；不新增假 UI，返回结构化结果。
  ipcMain.handle('dsh:rediscover', async () => {
    const result = await maybeAutoDiscoverDsh('manual');
    const payload = {
      ok: Boolean(result.ok),
      code: result.code || (result.ok ? 'DSH_DISCOVERED' : 'DSH_NOT_FOUND'),
      message: result.message || '',
      baseUrl: dsh.baseUrl,
      previousBaseUrl: result.previousBaseUrl || null,
      changed: Boolean(result.changed),
      persisted: Boolean(result.persisted),
      configFile: DSH_CONFIG_FILE,
      cookieOk: result.cookieOk,
      webview: result.webview || null,
      warnings: result.warnings || [],
      status: result.status || dsh.statusSync(),
      discovery: {
        ...dshDiscoverySummary(result),
        candidates: Array.isArray(result.candidates) ? result.candidates : [],
        probes: Array.isArray(result.probes) ? result.probes : [],
        process: result.process || null
      }
    };
    return payload;
  });
  ipcMain.handle('dsh:team-status', async (_e, payload) => {
    const projectId = typeof payload === 'string' ? payload : (payload && payload.projectId);
    const store = readStore();
    const project = projectId
      ? store.projects.find((p) => p.id === projectId)
      : (store.projects.find((p) => p.id === store.activeProjectId) || store.projects[0] || null);
    if (!project) throw new Error('项目不存在');
    // 只读：只用 session/list + 已记录的 workspaceId/成员快照，绝不调 workspace/create。
    const sessions = await dsh.listSessions();
    const byId = new Map(sessions.map((s) => [String(s.sessionId), s]));
    const workspacePath = path.resolve(String(project.path));
    const workspace = workspaceOf(project);
    const workspaceId = String(workspace.id || '');
    const membership = new Set((workspace.sessionIds || []).map(String));
    const membershipKnown = membership.size > 0;
    const sessionWsId = (s) => sessionWorkspaceId(s);
    const cwdSame = (s) => {
      const cwd = s && s.cwd ? path.resolve(String(s.cwd)) : '';
      return Boolean(cwd) && cwd.toLowerCase() === workspacePath.toLowerCase();
    };
    // 严格成员：workspaceId 匹配或记录快照命中；只有旧记录完全没有快照时才退回 cwd。
    const inWorkspaceOf = (s, sid) => {
      if (!s) return false;
      if (membership.has(String(sid))) return true;
      const wsid = sessionWsId(s);
      if (wsid && workspaceId) return wsid === workspaceId;
      return !membershipKnown && cwdSame(s);
    };
    // 看板“当前工作区全部会话”的口径更宽：成员/工作区 id/cwd 任一命中，用于找出额外会话。
    const scoped = (s) => inWorkspaceOf(s, s.sessionId) || cwdSame(s);
    const statusRoleIds = roleIdsForProject(project);
    const statusRoles = statusRoleIds.map((roleId) => ROLE_BY_ID.get(roleId) || { id: roleId, name: roleId });
    const items = statusRoles.map((r) => {
      const sid = project.sessions && project.sessions[r.id] ? String(project.sessions[r.id]) : '';
      const s = sid ? byId.get(sid) : null;
      return {
        role: r.id,
        name: r.name,
        title: roleTitle(r.id),
        sessionId: sid || null,
        exists: Boolean(s),
        archived: Boolean(s && s.archived),
        running: Boolean(s && s.running),
        blank: s ? Boolean(s.blank) : null,
        inWorkspace: Boolean(sid) && inWorkspaceOf(s, sid),
        cwdMatches: Boolean(s) && cwdSame(s),
        currentTitle: sessionTitleOf(s),
        titleMismatch: Boolean(s) && sessionTitleOf(s) !== roleTitle(r.id),
        updatedAt: s ? s.updatedAt : null
      };
    });
    const mapped = new Set(items.map((item) => item.sessionId).filter(Boolean));
    // 用户手动归档的历史会话不算“当前工作区额外会话”；仍可在 items 里看到 archived 状态。
    const liveSessions = sessions.filter((s) => !s.archived);
    const unmapped = liveSessions
      .filter((s) => !mapped.has(String(s.sessionId)) && scoped(s))
      .map((s) => {
        const title = sessionTitleOf(s);
        const roleCandidate = statusRoles.find((r) => title === roleTitle(r.id));
        return {
          sessionId: String(s.sessionId),
          title,
          blank: Boolean(s.blank),
          archived: Boolean(s.archived),
          inWorkspace: true, // 能进 extras 就说明它属于当前工作区（成员/工作区 id/cwd 任一命中）
          cwdMatches: cwdSame(s),
          role: roleCandidate ? roleCandidate.id : null,
          duplicateOfRole: Boolean(roleCandidate),
        };
      });
    const archivedExtras = sessions
      .filter((s) => s.archived && !mapped.has(String(s.sessionId)) && scoped(s))
      .map((s) => ({ sessionId: String(s.sessionId), title: sessionTitleOf(s), blank: Boolean(s.blank) }));
    const duplicates = [];
    for (const r of statusRoles) {
      const title = roleTitle(r.id);
      const rows = unmapped.filter((s) => s.title === title);
      if (rows.length) duplicates.push({ role: r.id, title, sessionIds: rows.map((s) => s.sessionId) });
    }
    const missingRoles = items.filter((item) => !item.exists || item.archived).map((item) => item.role);
    const blankRoles = items.filter((item) => item.exists && item.blank).map((item) => item.role);
    const notInWorkspace = items.filter((item) => item.exists && !item.inWorkspace).map((item) => item.role);
    const workspaceSessionCount = liveSessions.filter((s) => scoped(s)).length;
    const ready = items.filter((item) => item.exists && item.inWorkspace && !item.blank && !item.archived).length;
    return {
      ok: true,
      teamMode: normalizeTeamMode(project.teamMode),
      roleIds: statusRoleIds,
      items,
      extras: unmapped,
      unmapped,
      archivedExtras,
      duplicates,
      workspaceSessionCount,
      workspaceSessions: workspaceSessionCount,
      ready,
      missingRoles,
      blankRoles,
      notInWorkspace,
      workspace,
      workspaceId: workspace.id,
      workspaceBound: workspace.bound,
      teamName: project.teamName || null,
      canRepair: missingRoles.length > 0 || blankRoles.length > 0 || notInWorkspace.length > 0 || duplicates.length > 0,
      mapping: publicMapping(requireProject(readStore(), project.id))
    };
  });
  ipcMain.handle('dsh:provision', async (_e, payload) => {
    let initial = requireProject(readStore(), payload && payload.projectId);
    if (payload && (payload.teamMode || payload.mode)
      && normalizeTeamMode(payload.teamMode || payload.mode) !== normalizeTeamMode(initial.teamMode)) {
      initial = (await setProjectTeamMode(initial.id, payload.teamMode || payload.mode)) || initial;
    }
    if (!dsh.baseUrl) {
      const error = new Error('先在左下角配置 DSH 地址');
      error.code = 'DSH_NOT_CONFIGURED';
      throw error;
    }
    const projectId = initial.id;
    // 同一项目并发调用必须串行：后到的先等前一次落库，再只补缺失角色，
    // 否则两边都看到 sessions 为空，会在 DSH 侧各建 6 个会话。
    if (provisionLocks.has(projectId)) {
      try { await provisionLocks.get(projectId); } catch { /* 上一次失败已保留部分会话，这次按缺口补建 */ }
    }
    const task = provisionTeamSessions(projectId, {
      seedVisible: payload && payload.seedVisible,
      restore: payload && payload.restore === true,
      repair: !(payload && payload.repair === false)
    });
    provisionLocks.set(projectId, task);
    try {
      const result = await task;
      return { ...result, teamMode: normalizeTeamMode(initial.teamMode), roleIds: roleIdsForProject(initial) };
    } finally {
      if (provisionLocks.get(projectId) === task) provisionLocks.delete(projectId);
    }
  });
  ipcMain.handle('dsh:prompt', async (_e, payload) => {
    const project = requireProject(readStore(), payload && payload.projectId);
    const projectId = project.id;
    const sessionId = project.sessions && project.sessions[payload.role];
    if (!sessionId) throw new Error('这个角色还没有 DSH 会话');
    const text = String((payload && payload.text) || '').trim();
    if (!text) throw new Error('消息不能为空');
    // 唤醒也必须走同一把会话身份尺子：不能拿别的项目/已归档的会话发 prompt。
    const verified = await verifyProjectRoleSession(project, String(payload.role), String(sessionId), { timeoutMs: 6000 });
    if (!verified.ok) throw codedError(verified.code, verified.message);
    await dsh.prompt(sessionId, text);
    const fresh = readStore();
    const current = fresh.projects.find((p) => p.id === projectId);
    if (current) {
      addEvent(current, `唤醒 ${payload.role}：${text.slice(0, 80)}（会话已核验）`);
      writeStore(fresh);
    }
    return { ok: true, identity: { ...verified, actor: 'workbench-shell' }, state: statePayload() };
  });
  ipcMain.handle('dsh:configure', async (_e, baseUrl) => {
    const rawUrl = baseUrl && typeof baseUrl === 'object' ? (baseUrl.baseUrl || baseUrl.url || '') : baseUrl;
    let normalized;
    try {
      normalized = normalizeDshBaseUrl(rawUrl);
    } catch (error) {
      return {
        ok: false,
        code: error.code || 'DSH_URL_INVALID',
        message: String(error.message || error),
        status: dsh.statusSync()
      };
    }
    dsh = new DshAdapter(normalized);
    // 用户显式改了地址：清掉自动发现冷却，下一次检测失败按新地址重新判断。
    dshDiscovery.at = 0;
    dshDiscovery.last = null;
    let persisted = false;
    let persistError = null;
    try {
      persistDshConfig(normalized);
      persisted = true;
    } catch (error) {
      persistError = { code: 'DSH_CONFIG_WRITE_FAILED', message: String(error && error.message || error).slice(0, 200) };
    }
    const cookieOk = await installDshCookie();
    const warnings = [];
    if (!cookieOk) warnings.push({ code: 'DSH_COOKIE_FAILED', message: 'DSH 登录 cookie 安装失败；页面可能需要重新登录' });
    if (!persisted) warnings.push(persistError);
    return {
      ok: true,
      code: 'OK',
      status: dsh.statusSync(),
      persisted,
      configFile: DSH_CONFIG_FILE,
      cookieOk,
      warnings
    };
  });
  ipcMain.handle('window:control', (_e, action) => {
    if (!mainWindow) return;
    if (action === 'min') mainWindow.minimize();
    else if (action === 'max') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    else if (action === 'close') mainWindow.close();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1100, minHeight: 700,
    frame: false, backgroundColor: '#0a0b0e', show: false,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      webviewTag: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

// 可重复的状态库隔离测试：只在系统临时目录里建库，绝不触碰真实 userData。
// 覆盖：原子写、上一版备份、损坏自动恢复、无备份阻止写入、state.storeError。
function selftestStore() {
  const checks = [];
  const failures = [];
  const expect = (name, condition, detail) => {
    const ok = Boolean(condition);
    checks.push({ name, ok });
    if (!ok) failures.push(name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  };
  const savedEnv = process.env.AWB_STORE;
  const savedFatal = storeFatal;
  const savedWarning = storeWarning;
  fs.mkdirSync(SELFTEST_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SELFTEST_ROOT, 'store-test-'));
  const file = path.join(dir, 'workbench.json');
  process.env.AWB_STORE = file;
  storeFatal = false;
  storeWarning = null;
  const makeProject = (projectId, name) => ({
    id: projectId, name, path: path.join(dir, 'p-' + projectId),
    createdAt: now(), updatedAt: now(),
    ownerReview: { status: 'optional', opinion: '', at: null },
    tasks: [], messages: [], proposals: [], commits: [], pendingAck: null, pendingAckAt: null,
    events: []
  });
  try {
    writeStore({ version: 1, activeProjectId: 'P-1', projects: [makeProject('P-1', '一')] });
    expect('首写不产生备份', !fs.existsSync(file + '.bak'));
    expect('首写不残留 .tmp', !fs.existsSync(file + '.tmp'));

    writeStore({ version: 1, activeProjectId: 'P-2', projects: [makeProject('P-1', '一'), makeProject('P-2', '二')] });
    const backup = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
    expect('第二次写入保留上一版备份', backup.projects.length === 1 && backup.projects[0].id === 'P-1');

    // 带 BOM 的 UTF-8 文件不应被误判为损坏。
    const plain = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '\uFEFF' + plain, 'utf8');
    const bomStore = readStore();
    expect('BOM 状态文件可正常读取', bomStore.projects.length === 2 && storeFatal === false);
    fs.writeFileSync(file, plain, 'utf8');

    // 临时文件路径不可写时，正式文件必须保持原样（证明不是原地截断写）。
    fs.mkdirSync(file + '.tmp');
    let atomicError = null;
    try {
      writeStore({ version: 1, activeProjectId: 'P-3', projects: [makeProject('P-3', '三')] });
    } catch (e) { atomicError = e; }
    expect('临时文件不可写时写入失败', Boolean(atomicError));
    const afterFail = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect('写入失败不改正式文件', afterFail.projects.length === 2 && afterFail.projects.some((p) => p.id === 'P-2'));
    try { fs.rmdirSync(file + '.tmp'); } catch { /* ignore */ }

    const good = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, good.slice(0, Math.floor(good.length / 2)), 'utf8');
    const restored = readStore();
    expect('截断损坏后从备份恢复上一版', restored.projects.length === 1 && restored.projects[0].id === 'P-1');
    expect('损坏后 storeError 非致命', storeWarning && storeWarning.code === 'STORE_CORRUPT' && storeFatal === false);
    expect('损坏文件被隔离保留', fs.readdirSync(dir).some((name) => name.startsWith('workbench.json.corrupt-')));
    expect('恢复后的正式文件可解析', (() => { try { JSON.parse(fs.readFileSync(file, 'utf8')); return true; } catch { return false; } })());
    const recoveredState = statePayload();
    expect('state 返回 storeError', recoveredState.storeError && recoveredState.storeError.code === 'STORE_CORRUPT');
    expect('state 返回备份恢复标记', recoveredState.storeError && recoveredState.storeError.backupUsed === 'workbench.json.bak');

    // 正式文件被外部删除、但备份仍在：应恢复，而不是假装空库。
    fs.unlinkSync(file);
    const missingRestored = readStore();
    expect('正式文件缺失时从备份恢复', missingRestored.projects.length === 1 && missingRestored.projects[0].id === 'P-1');
    expect('缺失恢复写入 storeError', storeWarning && storeWarning.code === 'STORE_RESTORED');
    expect('缺失恢复后正式文件存在', fs.existsSync(file));

    // 无备份：损坏文件被隔离后必须阻止写入，且 state 明确告知致命状态。
    try { fs.unlinkSync(file + '.bak'); } catch { /* ignore */ }
    const good2 = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, good2.slice(0, Math.floor(good2.length / 2)), 'utf8');
    const empty = readStore();
    expect('无备份时返回空库', empty.projects.length === 0);
    expect('无备份时进入致命状态', storeFatal === true);
    const fatalState = statePayload();
    expect('无备份时 state.storeError.fatal=true', fatalState.storeError && fatalState.storeError.fatal === true);
    let blockedError = null;
    try { writeStore({ version: 1, activeProjectId: null, projects: [] }); } catch (e) { blockedError = e; }
    expect('无备份时阻止写入', Boolean(blockedError) && /阻止写入/.test(String(blockedError.message || blockedError)));
    expect('被阻止后正式文件仍不是完整状态', (() => {
      try { const parsed = JSON.parse(fs.readFileSync(file, 'utf8')); return !Array.isArray(parsed.projects); } catch { return true; }
    })());
  } finally {
    if (savedEnv === undefined) delete process.env.AWB_STORE;
    else process.env.AWB_STORE = savedEnv;
    storeFatal = savedFatal;
    storeWarning = savedWarning;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return { checks, failures };
}

/** 清空自测沙盘目录内容（保留正在使用的 Chromium userdata/tmp），返回是否干净。 */
function clearSelftestSandbox(root) {
  if (!fs.existsSync(root)) return { ok: true, removed: [], error: null };
  const keep = new Set(['userdata', 'tmp']);
  const removed = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (error) {
    return { ok: false, removed, error };
  }
  for (const entry of entries) {
    if (keep.has(entry.name)) continue;
    try {
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
      removed.push(entry.name);
    } catch (error) {
      return { ok: false, removed, error };
    }
  }
  return { ok: true, removed, error: null };
}

function selftestTeamSnapshot() {
  const read = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
  };
  return {
    team: read(teamTools.layout.teamFile),
    currentWorkspace: read(teamTools.layout.currentWorkspaceFile)
  };
}

function selftestTeamCleanup(testRoot, before) {
  const layout = teamTools.layout;
  const inside = (parent, child) => {
    const p = path.resolve(parent).toLowerCase();
    const c = path.resolve(child).toLowerCase();
    return c === p || c.startsWith(p + path.sep);
  };
  const removed = new Set();
  const readDirs = () => {
    try {
      return fs.readdirSync(layout.projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(layout.projectsDir, entry.name));
    } catch { return []; }
  };
  for (const dir of readDirs()) {
    let config = null;
    try { config = JSON.parse(fs.readFileSync(path.join(dir, '项目.json'), 'utf8')); } catch { /* skip */ }
    if (!config || !config.path || !inside(testRoot, config.path)) continue;
    removed.add(config.name);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const remaining = new Set();
  for (const dir of readDirs()) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(dir, '项目.json'), 'utf8'));
      if (config && config.name) remaining.add(config.name);
    } catch { /* skip */ }
  }
  try {
    if (fs.existsSync(layout.teamFile)) {
      const team = JSON.parse(fs.readFileSync(layout.teamFile, 'utf8').replace(/^\uFEFF/, ''));
      if (team.activeProject && !remaining.has(team.activeProject)) {
        const previous = before && before.team && before.team.activeProject;
        team.activeProject = previous && remaining.has(previous) ? previous : null;
        fs.writeFileSync(layout.teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
      }
    }
  } catch { /* ignore */ }
  try {
    if (fs.existsSync(layout.currentWorkspaceFile)) {
      const current = JSON.parse(fs.readFileSync(layout.currentWorkspaceFile, 'utf8').replace(/^\uFEFF/, ''));
      if (current && current.path && inside(testRoot, current.path)) {
        if (before && before.currentWorkspace) {
          fs.writeFileSync(layout.currentWorkspaceFile, JSON.stringify(before.currentWorkspace, null, 2) + '\n', 'utf8');
        } else {
          fs.rmSync(layout.currentWorkspaceFile, { force: true });
        }
      }
    }
  } catch { /* ignore */ }
  return { removed: [...removed] };
}

/**
 * 只在自测里用的本地 DSH mock：回包格式与真实服务一致（server-response 信封）。
 * 按目录维护独立 workspaceId + 成员会话，用来验证：
 *   1) 项目创建即绑定工作区；2) 六角色只建 6 个会话、重复启动不新建；
 *   3) 派单/回执走旧协议；4) DSH 离线/超时错误码。
 * 不发真实请求，也不碰真实 DSH。
 */
function startMockDsh() {
  const http = require('node:http');
  const counters = {
    sessionCreate: 0,
    sessionRename: 0,
    sessionPrompt: 0,
    sessionSelectModel: 0,
    workspaceCreate: 0,
    workspaceArchive: 0,
    workspaceArchiveStopped: 0,
    workspaceUnarchive: 0
  };
  const prompts = [];
  const sessions = [];
  const byId = new Map();
  const workspaces = new Map(); // 归一化目录 -> { workspaceId, path, sessionIds }
  const workspacesById = new Map();
  let workspaceSeq = 0;
  const workspaceFor = (workspacePath) => {
    const key = String(workspacePath || '').trim().toLowerCase();
    if (!key) return null;
    const existing = workspaces.get(key);
    if (existing) return { workspace: existing, created: false };
    workspaceSeq += 1;
    const workspace = { workspaceId: 'mock-ws-' + workspaceSeq, path: String(workspacePath), sessionIds: [] };
    workspaces.set(key, workspace);
    workspacesById.set(workspace.workspaceId, workspace);
    return { workspace, created: true };
  };
  const workspaceOfCwd = (cwd) => {
    const key = String(cwd || '').trim().toLowerCase();
    return key ? workspaces.get(key) || null : null;
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let message = {};
      try { message = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      const method = String(message.method || '');
      const args = (message.payload && message.payload.args) || {};
      const request = args.request || {};
      let value = {};
      if (method === 'session/list') {
        value = { items: sessions.map((session) => ({ ...session, projections: { values: { ...session.projections.values } } })) };
      } else if (method === 'session/create') {
        counters.sessionCreate += 1;
        const sessionId = 'mock-session-' + counters.sessionCreate;
        const workspace = request.workspaceId
          ? workspacesById.get(String(request.workspaceId)) || null
          : workspaceOfCwd(request.cwd);
        const cwd = request.cwd || (workspace ? workspace.path : '');
        const session = {
          sessionId,
          cwd,
          workspaceId: workspace ? workspace.workspaceId : '',
          archived: false,
          blank: true,
          running: false,
          updatedAt: new Date().toISOString(),
          projections: { values: { title: '' } }
        };
        sessions.push(session);
        byId.set(sessionId, session);
        if (workspace) workspace.sessionIds.push(sessionId);
        value = { sessionId };
      } else if (method === 'session/rename') {
        counters.sessionRename += 1;
        const session = byId.get(String(request.sessionId));
        if (session) session.projections.values.title = String(request.title || '');
      } else if (method === 'session/selectModel') {
        counters.sessionSelectModel += 1;
      } else if (method === 'session/prompt') {
        counters.sessionPrompt += 1;
        const session = byId.get(String(request.sessionId));
        if (session) session.blank = false;
        const content = Array.isArray(request.content) ? request.content : [];
        prompts.push({
          sessionId: String(request.sessionId || ''),
          text: content.map((part) => String(part && part.text || '')).join('\n')
        });
      } else if (method === 'workspace/create') {
        counters.workspaceCreate += 1;
        const result = workspaceFor(request.path);
        if (!result) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: false, error: { code: 'workspace/input-invalid', message: 'path required' } } }));
          return;
        }
        value = {
          workspaceId: result.workspace.workspaceId,
          workspace: { workspaceId: result.workspace.workspaceId, sessionIds: result.workspace.sessionIds.slice() },
          created: result.created
        };
      } else if (method === 'workspace/archiveSession') {
        counters.workspaceArchive += 1;
        if (request.stopActivity === true) counters.workspaceArchiveStopped += 1;
        const session = byId.get(String(request.sessionId));
        if (session) session.archived = true;
        value = {};
      } else if (method === 'workspace/unarchiveSession') {
        counters.workspaceUnarchive += 1;
        const session = byId.get(String(request.sessionId));
        if (session) session.archived = false;
        value = {};
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      counters,
      sessions,
      prompts,
      workspaces,
      workspaceFor: (workspacePath) => workspaces.get(String(workspacePath || '').trim().toLowerCase()) || null
    }));
  });
}

/** 对照旧版 main.js / 团队工具的兼容与一致性自测（状态库全在 .selftest-data）。 */
async function selftestCompat(win, testRoot) {
  const failures = [];
  const expect = (name, condition, detail) => {
    if (!condition) failures.push(name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  };
  // 1) 旧字段归一（纯函数）
  const legacyExisting = normalizeProposal({
    id: 'P-unit-1', title: 'u', author: 'pm', fileRel: 'u.txt', hash: 'abc',
    existed: true, stagedContent: 'x', status: 'approved', reviews: [], signature: { by: 'pm', decision: 'approve' }
  });
  expect('旧提案 existed=true 时不猜 baseHash', legacyExisting.baseHash === undefined);
  expect('旧签字 approve 归一为 approved', legacyExisting.signature && legacyExisting.signature.decision === 'approved');
  const legacyNewFile = normalizeProposal({
    id: 'P-unit-2', fileRel: 'n.txt', hash: 'abc', existed: false, stagedContent: 'x', status: 'applied',
    reviews: { product: { verdict: 'approve', comments: 'ok' } },
    signatures: { pm: { decision: 'approve', note: 'n' } }
  });
  expect('旧新文件提案 baseHash=null', legacyNewFile.baseHash === null);
  expect('旧 applied 状态归一', legacyNewFile.applied === true && legacyNewFile.status === 'approved');
  expect('旧 reviews 对象转数组', legacyNewFile.reviews.length === 1 && legacyNewFile.reviews[0].comment === 'ok');
  expect('旧签字对象归一', legacyNewFile.signature && legacyNewFile.signature.decision === 'approved');
  const legacyCommit = normalizeCommit({ id: 'C-unit', proposalId: 'P-unit-2', fileRel: 'n.txt', backupPath: '', existed: false }, new Map([['P-unit-2', legacyNewFile]]));
  expect('旧提交 afterHash 从提案内容哈希补', legacyCommit.afterHash === 'abc');

  // 2) 注入旧协议提案/提交，交给真实 IPC 走一遍
  const target = readStore().projects.find((project) => project.name === '验证项目');
  expect('兼容测试能定位验证项目', Boolean(target));
  if (target) {
    const store = readStore();
    const project = store.projects.find((item) => item.id === target.id);
    const knownContent = 'legacy content';
    const knownHash = sha256(Buffer.from(knownContent, 'utf8'));
    project.proposals.push({
      id: 'P-legacy-known', title: '旧新文件提案', author: 'analyst', fileRel: 'legacy/known.txt',
      fileSize: knownContent.length, hash: knownHash, existed: false, stagedContent: knownContent,
      status: 'approved', reviews: [], signature: { by: 'pm', decision: 'approved' }, applied: false, commitId: null,
      createdAt: now(), updatedAt: now()
    });
    project.proposals.push({
      id: 'P-legacy-unknown', title: '旧已存在文件提案', author: 'analyst', fileRel: 'legacy/unknown.txt',
      fileSize: 5, hash: sha256(Buffer.from('xxxxx', 'utf8')), existed: true, stagedContent: 'xxxxx',
      status: 'approved', reviews: [], signature: { by: 'pm', decision: 'approved' }, applied: false, commitId: null,
      createdAt: now(), updatedAt: now()
    });
    fs.mkdirSync(path.join(project.path, 'legacy'), { recursive: true });
    fs.writeFileSync(path.join(project.path, 'legacy', 'guard.txt'), 'current content', 'utf8');
    fs.writeFileSync(path.join(project.path, 'legacy', 'guard2.txt'), 'current content 2', 'utf8');
    project.proposals.push({
      id: 'P-legacy-guard', title: '旧提交可推导', author: 'analyst', fileRel: 'legacy/guard.txt',
      fileSize: 3, hash: sha256(Buffer.from('old', 'utf8')), existed: true, stagedContent: 'old',
      status: 'approved', reviews: [], signature: { by: 'pm', decision: 'approved' }, applied: true, commitId: 'C-legacy-guard',
      createdAt: now(), updatedAt: now()
    });
    project.commits.push({ id: 'C-legacy-guard', proposalId: 'P-legacy-guard', fileRel: 'legacy/guard.txt', backupPath: '', existed: true, at: now() });
    project.proposals.push({
      id: 'P-legacy-guard2', title: '旧提交不可推导', author: 'analyst', fileRel: 'legacy/guard2.txt',
      fileSize: 3, existed: true, stagedContent: 'old2', status: 'approved', reviews: [],
      signature: { by: 'pm', decision: 'approved' }, applied: true, commitId: 'C-legacy-guard2',
      createdAt: now(), updatedAt: now()
    });
    project.commits.push({ id: 'C-legacy-guard2', proposalId: 'P-missing-proposal', fileRel: 'legacy/guard2.txt', backupPath: '', existed: true, at: now() });
    writeStore(store);
    // 旧版 team:members 读的会话清单
    fs.writeFileSync(path.join(project.path, '团队会话.json'), JSON.stringify({
      project: project.name,
      workspace: project.path,
      workspaceId: 'ws-legacy',
      generatedAt: now(),
      roles: [
        { role: 'pm', name: '项目经理', sessionId: 's-pm' },
        { role: 'tester', name: '测试人员', sessionId: 's-test' }
      ]
    }, null, 2) + '\n', 'utf8');
  }

  // 3) 本地 mock DSH + 临时 DSH_HOME（只用于自测）
  const openProjectDir = path.join(testRoot, '外部 项目·打开');
  fs.mkdirSync(openProjectDir, { recursive: true });
  const dshHomeDir = path.join(testRoot, 'dsh-home');
  fs.mkdirSync(dshHomeDir, { recursive: true });
  fs.writeFileSync(path.join(dshHomeDir, '.credentials.yaml'), 'client-connection/browser-session:\n  secret: ' + 'a'.repeat(43) + '\n', 'utf8');
  const savedHome = process.env.DSH_HOME;
  const savedDsh = dsh;
  process.env.DSH_HOME = dshHomeDir;
  const mock = await startMockDsh();
  dsh = new DshAdapter('http://127.0.0.1:' + mock.port);
  const projectId = target ? target.id : '';
  console.log('SELFTEST_COMPAT_TARGET ' + JSON.stringify({
    projectId,
    projects: readStore().projects.map((project) => ({ id: project.id, name: project.name, mode: project.teamMode }))
  }));
  let report = {};
  try {
    const first = JSON.parse(await win.webContents.executeJavaScript(`(async()=>{
      const out = {};
      const projectId = ${JSON.stringify(projectId)};
      const root = ${JSON.stringify(testRoot)};
      const status = await window.workbench.teamStatus();
      out.teamStatus = Boolean(status.ok && status.tools && typeof status.tools.team === 'boolean' && status.teamRoot);
      const members = await window.workbench.teamMembers({ projectId });
      out.members = Boolean(members.ok && (members.roles || []).length === 2);
      const wf = await window.workbench.workflow({ projectId });
      out.workflow = Boolean(wf.ok && wf.stage && wf.legacyStage && wf.counts);
      const ownerChallenge = await window.workbench.ownerChallenge({ projectId, action: 'owner-decision' });
      const ownerConfirm = await window.workbench.ownerConfirm({ challengeId: ownerChallenge.challengeId, nonce: ownerChallenge.nonce });
      const owner = await window.workbench.workflowOwner({ projectId, decision: 'skipped', opinion: '兼容验证', confirmToken: ownerConfirm.confirmToken });
      out.owner = Boolean(owner.ok && owner.ownerReview && owner.ownerReview.status === 'skipped');
      out.ownerChallengeDeprecated = Boolean(ownerChallenge.ok && ownerChallenge.deprecated === true);
      out.ownerConfirmDeprecated = Boolean(ownerConfirm.ok && ownerConfirm.deprecated === true);
      const dry = await window.workbench.teamWorkspaceCreate({ name: '兼容工作区', root, dryRun: true });
      out.wsDry = Boolean(dry.ok && dry.dryRun === true && dry.target);
      const made = await window.workbench.teamWorkspaceCreate({ name: '兼容工作区', root });
      out.wsMade = Boolean(made.ok && made.created === true && made.workspace && made.workspace.path);
      const dup = await window.workbench.teamWorkspaceCreate({ name: '兼容工作区', root });
      out.wsDup = dup.ok === false ? dup.code : '';
      const dryLaunch = await window.workbench.teamLaunch({ project: '兼容工作区', dryRun: true, roles: 'pm,product' });
      out.launchByName = Boolean(dryLaunch.ok && dryLaunch.dryRun === true && (dryLaunch.plan || []).length === 2);
      const offlineLaunch = await window.workbench.teamLaunch({ project: '兼容工作区', engineUrl: 'http://127.0.0.1:9', roles: ['pm'] });
      out.launchOffline = offlineLaunch.code || '';
      const restore = await window.workbench.teamRestore({ name: '兼容工作区', engineUrl: 'http://127.0.0.1:9' });
      out.restoreOffline = Boolean(restore.ok === false && restore.code === 'DSH_OFFLINE' && restore.projectDir);
      const opened = await window.workbench.teamOpenProject({ path: ${JSON.stringify(openProjectDir)}, dryRun: true, roles: ['pm'] });
      out.openProject = Boolean(opened.ok && opened.opened === true && opened.dryRun === true && opened.projectDir && opened.plan.length === 1);
      const openedMissing = await window.workbench.teamOpenProject({ path: ${JSON.stringify(openProjectDir + '-不存在')} });
      out.openProjectMissing = openedMissing.code || '';
      const board = await window.workbench.teamBoardProject({ project: '兼容工作区' });
      out.boardProject = Boolean(board.ok && board.boardPath);
      out.projectsBeforeProposal = (await window.workbench.state()).projects.map((p) => ({ id: p.id, name: p.name }));
      let created = null;
      try {
        created = await window.workbench.proposalCreate({ projectId, title: '旧协议提案', author: 'analyst', file: 'compat/old.txt', content: 'old content', expect: 'absent', risk: 'normal', task: 'T-1', rationale: '兼容' });
      } catch (proposalCreateError) {
        out.proposalCreateError = String((proposalCreateError && proposalCreateError.message) || proposalCreateError);
        return JSON.stringify(out);
      }
      out.legacyFile = created.proposal.fileRel;
      out.legacyBase = created.proposal.baseHash;
      out.legacyFiles = (created.proposal.files || []).length;
      await window.workbench.proposalReview({ projectId, proposalId: created.proposal.id, role: 'product', verdict: 'approve', comments: '同意' });
      const signed = await window.workbench.proposalSign({ projectId, proposalId: created.proposal.id, decision: 'approve' });
      out.legacySign = signed.proposal.status;
      const applied = await window.workbench.proposalApply({ projectId, proposalId: created.proposal.id, log: '兼容应用' });
      out.legacyApply = Boolean(applied.ok && applied.proposal.applied);
      const rolled = await window.workbench.proposalRollback({ projectId, proposalId: created.proposal.id });
      out.legacyRollback = Boolean(rolled.ok && rolled.proposal.applied === false);
      let unknownErr = '';
      try { await window.workbench.proposalApply({ projectId, proposalId: 'P-legacy-unknown' }); } catch (e) { unknownErr = String(e.message || e); }
      out.legacyUnknownBlocked = /baseHash/.test(unknownErr) && /重新/.test(unknownErr);
      const legacyKnown = await window.workbench.proposalApply({ projectId, proposalId: 'P-legacy-known' });
      out.legacyKnownApplied = Boolean(legacyKnown.ok && legacyKnown.proposal.applied);
      const legacyRolled = await window.workbench.proposalRollback({ projectId, proposalId: 'P-legacy-known' });
      out.legacyKnownRolled = Boolean(legacyRolled.ok && legacyRolled.proposal.applied === false);
      let guardErr = '';
      try { await window.workbench.proposalRollback({ projectId, proposalId: 'P-legacy-guard' }); } catch (e) { guardErr = String(e.message || e); }
      out.legacyGuard = /应用后/.test(guardErr);
      let guardErr2 = '';
      try { await window.workbench.proposalRollback({ projectId, proposalId: 'P-legacy-guard2' }); } catch (e) { guardErr2 = String(e.message || e); }
      out.legacyGuardUnknown = /afterHash/.test(guardErr2);
      const dupA = await window.workbench.proposalCreate({ projectId, title: '别名一', author: 'analyst', fileRel: 'dup.txt', content: 'A' });
      await window.workbench.proposalReview({ projectId, proposalId: dupA.proposal.id, role: 'product', verdict: 'approve', comment: '别名测试 A' });
      await window.workbench.proposalSign({ projectId, proposalId: dupA.proposal.id, decision: 'approved' });
      await window.workbench.proposalApply({ projectId, proposalId: dupA.proposal.id });
      const dupB = await window.workbench.proposalCreate({ projectId, title: '别名二', author: 'analyst', fileRel: 'DUP.txt', content: 'B' });
      await window.workbench.proposalReview({ projectId, proposalId: dupB.proposal.id, role: 'product', verdict: 'approve', comment: '别名测试 B' });
      await window.workbench.proposalSign({ projectId, proposalId: dupB.proposal.id, decision: 'approved' });
      let dupErr = '';
      try { await window.workbench.proposalApply({ projectId, proposalId: dupB.proposal.id }); } catch (e) { dupErr = String(e.message || e); }
      out.dupBlocked = /同一文件/.test(dupErr);
      await window.workbench.proposalRollback({ projectId, proposalId: dupA.proposal.id });
      const concurrent = await window.workbench.createProject({ name: '并发项目', root });
      const cid = concurrent.project.id;
      const pair = await Promise.all([
        window.workbench.dshProvision({ projectId: cid }),
        window.workbench.dshProvision({ projectId: cid })
      ]);
      const after = await window.workbench.state();
      const row = after.projects.find(x => x.id === cid);
      out.provisionCreated = (pair[0].created || []).length + (pair[1].created || []).length;
      out.provisionSessions = Object.keys(row.sessions || {}).length;
      out.provisionBothOk = Boolean(pair[0].ok && pair[1].ok);
      out.provisionWarnings = (pair[0].warnings || []).map(x => (x.role || 'system') + '/' + (x.stage || '?') + ': ' + String(x.message || '').slice(0, 200));
      const again = await window.workbench.dshProvision({ projectId: cid });
      out.provisionAgain = (again.created || []).length;
      const send1 = await window.workbench.teamSend({ projectId: cid, to: 'analyst', subject: 'TTL 一', text: '第一条' });
      const s1 = await window.workbench.state();
      out.provId = cid;
      out.send1 = send1.message.id;
      out.wake1 = Boolean(send1.wake && send1.wake.ok);
      out.lock1 = s1.projects.find(x => x.id === cid).pendingAck;
      return JSON.stringify(out);
    })()`));
    report = { ...first };

    expect('team:status 返回旧结构', report.teamStatus === true);
    expect('team:members 读到 团队会话.json', report.members === true);
    expect('workflow:get 返回阶段与计数', report.workflow === true);
    expect('workflow:owner 接受 decision', report.owner === true);
    expect('owner:challenge 已废弃但保持兼容形状', report.ownerChallengeDeprecated === true);
    expect('owner:confirm 已废弃但保持兼容形状', report.ownerConfirmDeprecated === true);
    expect('team:workspace:create dry-run', report.wsDry === true);
    expect('team:workspace:create 创建成功', report.wsMade === true);
    expect('team:workspace:create 重名拦截', report.wsDup === 'WORKSPACE_EXISTS', report.wsDup);
    expect('team:launch 按项目名 dry-run', report.launchByName === true);
    expect('team:launch 离线错误码', report.launchOffline === 'DSH_OFFLINE', report.launchOffline);
    expect('team:restore 离线仍返回目录', report.restoreOffline === true);
    expect('team:open-project 旧版打开目录', report.openProject === true);
    expect('team:open-project 缺目录错误码', report.openProjectMissing === 'PROJECT_FOLDER_NOT_FOUND', report.openProjectMissing);
    expect('team:board-project 生成看板', report.boardProject === true);
    expect('提案旧字段 file/expect 兼容', report.legacyFile === 'compat/old.txt' && report.legacyBase === null && report.legacyFiles === 1);
    expect('提案旧字段 comments/approve 兼容', report.legacySign === 'approved');
    expect('提案旧字段应用/回滚', report.legacyApply === true && report.legacyRollback === true);
    expect('旧提案缺 baseHash 拒绝并提示重新评审', report.legacyUnknownBlocked === true);
    expect('旧提案 existed=false 可安全应用', report.legacyKnownApplied === true && report.legacyKnownRolled === true);
    expect('旧提交可推导 afterHash 时拒绝覆盖已改文件', report.legacyGuard === true);
    expect('旧提交不可推导 afterHash 时拒绝回滚', report.legacyGuardUnknown === true);
    expect('大小写别名不能二次应用同一文件', report.dupBlocked === true);
    expect('并发 provision 只建 6 个会话', report.provisionCreated === 6 && report.provisionSessions === 6 && report.provisionBothOk === true);
    expect('重复 provision 不新建', report.provisionAgain === 0);
    // 六角色必须走 launch.mjs：固定模型 + seed-visible 让空白会话在 DSH 可见。
    expect('六角色经 launch.mjs 选了模型', mock.counters.sessionSelectModel === 6, mock.counters);
    expect('空白会话已发“已就位”', mock.counters.sessionPrompt >= 6, mock.counters);
    expect('派单 1 成功并置锁', report.wake1 === true && report.lock1 === report.send1);
    expect('mock 只收到 6 个 session/create', mock.counters.sessionCreate === 6, mock.counters);
  } finally {
    // 4) TTL / 撤销 / 唤醒失败的一致性（需要主进程改 pendingAckAt / 切离线 adapter）
    try {
      if (report.provId) {
        const store = readStore();
        const project = store.projects.find((item) => item.id === report.provId);
        if (project) {
          project.pendingAckAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
          writeStore(store);
        }
        const second = JSON.parse(await win.webContents.executeJavaScript(`(async()=>{
          const out = {};
          const cid = ${JSON.stringify(report.provId || '')};
          const firstId = ${JSON.stringify(report.send1 || '')};
          const send2 = await window.workbench.teamSend({ projectId: cid, to: 'tester', text: '第二条' });
          const s1 = await window.workbench.state();
          out.send2 = send2.message.id;
          out.lock2 = s1.projects.find(x => x.id === cid).pendingAck;
          let badAck = '';
          try { await window.workbench.teamAck({ projectId: cid, messageId: firstId, note: '旧派单回执', allowShellAck: true }); } catch (e) { badAck = String(e.message || e); }
          const s2 = await window.workbench.state();
          out.badAck = badAck;
          out.lockAfterBadAck = s2.projects.find(x => x.id === cid).pendingAck;
          const ack2 = await window.workbench.teamAck({ projectId: cid, messageId: send2.message.id, note: '第二条回执', allowShellAck: true });
          const s3 = await window.workbench.state();
          out.ack2 = Boolean(ack2.ok);
          out.lockAfterAck2 = s3.projects.find(x => x.id === cid).pendingAck;
          await window.workbench.teamSend({ projectId: cid, to: 'programmer1', text: '第三条' });
          const cancel = await window.workbench.teamCancel({ projectId: cid });
          const s4 = await window.workbench.state();
          out.cancelOk = Boolean(cancel.ok);
          out.lockAfterCancel = s4.projects.find(x => x.id === cid).pendingAck;
          return JSON.stringify(out);
        })()`));
        report = { ...report, ...second };
        expect('TTL 过期后新派单可发', report.lock2 === report.send2);
        expect('旧派单回执被拒', /回执对象/.test(report.badAck));
        expect('旧回执不误清新派单锁', report.lockAfterBadAck === report.send2);
        expect('新派单回执清锁', report.ack2 === true && report.lockAfterAck2 === null);
        expect('撤销后无残留锁', report.cancelOk === true && report.lockAfterCancel === null);
      }
      // 离线唤醒：send 前会话归属核验无法完成时必须拒绝；离线 provision 必须给出 DSH_OFFLINE。
      dsh = new DshAdapter('http://127.0.0.1:9');
      const third = JSON.parse(await win.webContents.executeJavaScript(`(async()=>{
        const out = {};
        const cid = ${JSON.stringify(report.provId || '')};
        try {
          await window.workbench.teamSend({ projectId: cid, to: 'analyst', text: '离线唤醒' });
          out.offlineSendError = '';
        } catch (e) { out.offlineSendError = String(e && e.message || e); }
        out.lock = (await window.workbench.state()).projects.find(x => x.id === cid).pendingAck;
        out.offlineCreateError = '';
        try {
          await window.workbench.createProject({ name: '离线项目', root: ${JSON.stringify(testRoot)} });
        } catch (e) { out.offlineCreateError = String(e && e.message || e); }
        out.offlineProjectRecord = (await window.workbench.state()).projects.some(x => x.name === '离线项目');
        return JSON.stringify(out);
      })()`));
      report = { ...report, ...third };
      expect('离线派单被会话身份核验拒绝', /DSH_OFFLINE|核验/.test(report.offlineSendError) && report.lock === null, report.offlineSendError);
      expect('离线创建项目被拒绝并回滚', /DSH|WORKSPACE/i.test(report.offlineCreateError || '')
        && report.offlineProjectRecord === false
        && !fs.existsSync(path.join(testRoot, '离线项目')), report.offlineCreateError);
    } catch (error) {
      failures.push('兼容/一致性自测异常：' + String(error && error.stack || error).slice(0, 400));
    } finally {
      dsh = savedDsh;
      if (savedHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = savedHome;
      try { if (typeof mock.server.closeAllConnections === 'function') mock.server.closeAllConnections(); } catch { /* ignore */ }
      try { await new Promise((resolve) => mock.server.close(resolve)); } catch { /* ignore */ }
    }
  }
  return { report, failures };
}

/**
 * 工作台模型自测（独立 mock DSH + 隔离团队状态）：
 *   项目 = DSH workspace；会话 = 角色（六角色）；消息/派单/回执 = 旧团队工具。
 * 覆盖：创建即绑定、切项目切工作区、六角色只建 6 个会话、重复启动不新建、
 *       工作区无额外会话、派单/回执/撤销走旧协议并清锁、映射持久化。
 */
async function selftestMapping(win, testRoot) {
  const failures = [];
  const expect = (name, condition, detail) => {
    if (!condition) failures.push(name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  };
  const dshHomeDir = path.join(testRoot, 'dsh-home-model');
  fs.mkdirSync(dshHomeDir, { recursive: true });
  fs.writeFileSync(path.join(dshHomeDir, '.credentials.yaml'), 'client-connection/browser-session:\n  secret: ' + 'b'.repeat(43) + '\n', 'utf8');
  const savedHome = process.env.DSH_HOME;
  const savedDsh = dsh;
  process.env.DSH_HOME = dshHomeDir;
  const mock = await startMockDsh();
  dsh = new DshAdapter('http://127.0.0.1:' + mock.port);
  const report = {};
  try {
    const raw = await win.webContents.executeJavaScript(`(async()=>{
      const out = {};
      const root = ${JSON.stringify(testRoot)};
      const a = await window.workbench.createProject({ name: '映射项目A', root });
      const b = await window.workbench.createProject({ name: '映射项目B', root });
      out.createdA = Boolean(a.ok && a.workspace && a.workspace.id);
      out.createdB = Boolean(b.ok && b.workspace && b.workspace.id);
      out.wsA = (a.workspace && a.workspace.id) || '';
      out.wsB = (b.workspace && b.workspace.id) || '';
      out.diffWs = Boolean(out.wsA && out.wsB && out.wsA !== out.wsB);
      out.mappingEmpty = Boolean(a.mapping && a.mapping.sessionCount === 0 && a.mapping.roleCount === 6);
      const sel = await window.workbench.selectProject(a.project.id);
      out.selectOk = Boolean(sel.ok && sel.activeProjectId === a.project.id);
      out.selectWs = (sel.workspace && sel.workspace.id) || '';
      out.selectTeam = sel.teamName || '';
      out.selectCurrentWs = sel.state && sel.state.mapping ? sel.state.mapping.workspaceId : '';
      const first = await window.workbench.dshProvision({ projectId: a.project.id });
      out.createdSessions = (first.created || []).length;
      out.mapping = first.mapping || null;
      const again = await window.workbench.dshProvision({ projectId: a.project.id });
      out.createdAgain = (again.created || []).length;
      out.againMappingCount = again.mapping ? again.mapping.sessionCount : -1;
      const status = await window.workbench.dshTeamStatus(a.project.id);
      out.statusItems = (status.items || []).length;
      out.statusAllExist = (status.items || []).every((x) => x.exists && x.inWorkspace && x.sessionId);
      out.extras = (status.extras || []).length;
      const send = await window.workbench.teamSend({ projectId: a.project.id, role: 'analyst', subject: '模型自测派单', body: '验证旧协议派单' });
      out.msgId = send.message.id;
      out.msgSource = send.message.source;
      out.msgTeamId = Boolean(send.message.teamMessageId);
      out.teamMessageSame = send.message.id === send.message.teamMessageId;
      const s1 = await window.workbench.state();
      out.lock = s1.projects.find((x) => x.id === a.project.id).pendingAck;
      const ack = await window.workbench.teamAck({ projectId: a.project.id, messageId: send.message.id, note: '模型自测回执', allowShellAck: true });
      out.ackOk = Boolean(ack.ok && ack.message.ack);
      out.ackSource = ack.source;
      const s2 = await window.workbench.state();
      out.lockAfter = s2.projects.find((x) => x.id === a.project.id).pendingAck;
      await window.workbench.teamSend({ projectId: a.project.id, role: 'tester', subject: '模型自测撤销', body: '验证撤销释放派单锁' });
      const cancel = await window.workbench.teamCancel({ projectId: a.project.id });
      out.cancelOk = Boolean(cancel.ok && cancel.released && cancel.released.removed);
      const s3 = await window.workbench.state();
      out.lockAfterCancel = s3.projects.find((x) => x.id === a.project.id).pendingAck;
      await window.workbench.selectProject(b.project.id);
      const s4 = await window.workbench.state();
      out.switchedToB = s4.mapping ? s4.mapping.projectId === b.project.id : false;
      out.switchedWs = s4.mapping ? s4.mapping.workspaceId : '';
      await window.workbench.selectProject(a.project.id);
      const s5 = await window.workbench.state();
      out.backToA = s5.mapping ? s5.mapping.projectId === a.project.id : false;
      out.backWs = s5.mapping ? s5.mapping.workspaceId : '';
      out.projectAName = a.project.name;
      out.projectAId = a.project.id;
      out.projectBId = b.project.id;
      await refresh();
      return JSON.stringify(out);
    })()`);
    Object.assign(report, JSON.parse(raw));

    const store = readStore();
    const projectA = store.projects.find((p) => p.id === report.projectAId);
    // 额外会话：工作区里多一条非 团队· 标题的会话，extras 必须报告 1（不能只看前缀）。
    if (projectA) {
      const ws = mock.workspaceFor(projectA.path);
      const extraSessionId = 'mock-extra-session-1';
      if (ws) ws.sessionIds.push(extraSessionId);
      report.mockWsSessions = ws ? ws.sessionIds.length : -1;
      mock.sessions.push({
        sessionId: extraSessionId,
        cwd: projectA.path,
        blank: false,
        running: false,
        updatedAt: new Date().toISOString(),
        projections: { values: { title: '临时会话' } }
      });
      report.extraSessionId = extraSessionId;
      report.extraStatus = JSON.parse(await win.webContents.executeJavaScript(
        `(async()=>JSON.stringify(await window.workbench.dshTeamStatus(${JSON.stringify(projectA.id)})))()`
      ));
      // 只读核对：workspace 丢失后 team-status 不得再调 workspace/create。
      const beforeRead = mock.counters.workspaceCreate;
      const key = path.resolve(projectA.path).toLowerCase();
      mock.workspaces.delete(key);
      report.readOnlyStatus = JSON.parse(await win.webContents.executeJavaScript(
        `(async()=>JSON.stringify(await window.workbench.dshTeamStatus(${JSON.stringify(projectA.id)})))()`
      ));
      report.readOnlyWorkspaceCreateDelta = mock.counters.workspaceCreate - beforeRead;
    }
    const mappingCount = projectA ? Object.keys(projectA.sessions || {}).length : -1;
    const persistedWs = projectA && projectA.workspace ? projectA.workspace.id : '';
    let wsMeta = null;
    try { wsMeta = JSON.parse(fs.readFileSync(path.join(projectA.path, 'workspace.json'), 'utf8')); } catch { /* ignore */ }
    const lockFile = projectA ? path.join(teamTools.layout.projectsDir, teamTools.teamSlug(report.projectAName, 60), '派单锁.json') : '';
    const receiptsFile = path.join(teamTools.layout.root, '状态', '回执.jsonl');
    const mockWs = projectA ? mock.workspaceFor(projectA.path) : null;
    const roleTitles = mock.sessions.filter((s) => String((s.projections.values.title || '')).startsWith('团队·'));
    let currentWorkspace = null;
    try { currentWorkspace = JSON.parse(fs.readFileSync(teamTools.layout.currentWorkspaceFile, 'utf8')); } catch { /* ignore */ }
    let teamFile = null;
    try { teamFile = JSON.parse(fs.readFileSync(teamTools.layout.teamFile, 'utf8')); } catch { /* ignore */ }
    const receipts = fs.existsSync(receiptsFile)
      ? fs.readFileSync(receiptsFile, 'utf8').split(/\r?\n/).filter(Boolean).length
      : 0;
    console.log('SELFTEST_MAPPING ' + JSON.stringify({
      ...report,
      mappingCount,
      persistedWs,
      wsMetaId: wsMeta ? wsMeta.dshWorkspaceId : null,
      lockFileExists: fs.existsSync(lockFile),
      receipts,
      workspaceSessions: report.mockWsSessions,
      teamTitled: roleTitles.length,
      currentWorkspace: currentWorkspace ? { name: currentWorkspace.name, path: currentWorkspace.path, dshWorkspaceId: currentWorkspace.dshWorkspaceId } : null,
      teamActive: teamFile ? teamFile.activeProject : null,
      roster: teamFile ? (teamFile.members || []).map((m) => m.role + ':' + (m.sessionId || 'none')) : []
    }));

    expect('创建项目即绑定 DSH 工作区', report.createdA === true && report.createdB === true, [report.wsA, report.wsB]);
    expect('1 项目 = 1 独立工作区', report.diffWs === true, [report.wsA, report.wsB]);
    expect('新建项目映射为空（尚未建会话）', report.mappingEmpty === true, report.mapping);
    expect('切项目返回同一工作区', Boolean(report.selectWs) && report.selectCurrentWs === report.selectWs, [report.selectWs, report.selectCurrentWs]);
    expect('切项目同步旧协议当前项目', Boolean(report.selectTeam), report.selectTeam);
    expect('启动团队只建 6 个角色会话', report.createdSessions === 6, report.createdSessions);
    expect('映射含 6 个角色会话', Boolean(report.mapping) && report.mapping.sessionCount === 6 && report.mapping.roleCount === 6, report.mapping && report.mapping.sessionCount);
    expect('重复启动不新建会话', report.createdAgain === 0, report.createdAgain);
    expect('六角色会话存在且在本工作区', report.statusItems === 6 && report.statusAllExist === true, report.statusItems);
    expect('工作区没有额外会话', report.extras === 0, report.extras);
    expect('额外会话按全量差集报告', report.extraStatus && report.extraStatus.extras.length === 1
      && report.extraStatus.extras[0].title === '临时会话'
      && report.extraStatus.workspaceSessionCount === 7, report.extraStatus && report.extraStatus.extras);
    expect('team-status 只读不建 workspace', report.readOnlyWorkspaceCreateDelta === 0, report.readOnlyWorkspaceCreateDelta);
    expect('名册 sessionId 与当前项目映射一致', Boolean(report.mapping) && (teamFile ? (teamFile.members || []).every((m) => String(m.sessionId || '') === String(report.mapping.sessions.find((s) => s.role === m.role)?.sessionId || '')) : false), report.roster);
    expect('派单走旧团队工具', report.msgSource === 'team' && report.msgTeamId === true && report.teamMessageSame === true, report.msgId);
    expect('派单消息 id 来自旧协议', /^M-/.test(String(report.msgId || '')), report.msgId);
    expect('派单置待回执锁', report.lock === report.msgId, [report.lock, report.msgId]);
    expect('回执走旧团队工具', report.ackOk === true && report.ackSource === 'team', report.ackSource);
    expect('回执释放待回执锁', report.lockAfter === null, report.lockAfter);
    expect('撤销释放旧协议派单锁', report.cancelOk === true, report.cancelOk);
    expect('撤销后无残留锁', report.lockAfterCancel === null, report.lockAfterCancel);
    expect('切换项目 = 切换映射工作区', report.switchedToB === true && report.switchedWs === report.wsB, [report.switchedWs, report.wsB]);
    expect('切回项目恢复原工作区', report.backToA === true && report.backWs === report.wsA, [report.backWs, report.wsA]);
    expect('映射持久化到状态库', mappingCount === 6 && persistedWs === report.wsA, [mappingCount, persistedWs]);
    expect('workspace.json 记录 dshWorkspaceId', Boolean(wsMeta) && wsMeta.dshWorkspaceId === report.wsA, wsMeta && wsMeta.dshWorkspaceId);
    expect('旧协议派单锁已清', !fs.existsSync(lockFile), lockFile);
    expect('旧协议回执落盘', receipts > 0, receipts);
    expect('mock 工作区会话数 = 7（六角色 + 额外会话）', report.mockWsSessions === 7, report.mockWsSessions);
    expect('团队·角色标题会话 = 6', roleTitles.length === 6, roleTitles.length);
    expect('当前工作区指针指向 A', Boolean(currentWorkspace) && currentWorkspace.dshWorkspaceId === report.wsA, currentWorkspace && currentWorkspace.dshWorkspaceId);
  } catch (error) {
    failures.push('工作台模型自测异常：' + String(error && error.stack || error).slice(0, 500));
  } finally {
    dsh = savedDsh;
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    try { if (typeof mock.server.closeAllConnections === 'function') mock.server.closeAllConnections(); } catch { /* ignore */ }
    try { await new Promise((resolve) => mock.server.close(resolve)); } catch { /* ignore */ }
  }
  return { report, failures };
}

async function selftestRound5(win, testRoot, mock) {
  const failures = [];
  const expect = (name, condition, detail) => {
    if (!condition) failures.push(name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  };
  const js = (value) => JSON.stringify(value);
  const evaluate = async (label, body) => {
    try {
      const raw = await win.webContents.executeJavaScript(`(async()=>{${body}})()`);
      return raw === undefined ? {} : JSON.parse(raw);
    } catch (error) {
      failures.push(label + ' 执行失败：' + String((error && error.message) || error).slice(0, 400));
      return {};
    }
  };
  const teamRoot = teamTools.layout.root;
  const projectStateDirFor = (name) => path.join(teamTools.layout.projectsDir, teamTools.teamSlug(name, 60));
  const readJsonFile = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
  };
  const mailboxFiles = (role, box = 'new') => {
    const dir = path.join(teamRoot, '状态', '邮箱', role, box);
    try {
      return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => ({ name, file: path.join(dir, name), data: readJsonFile(path.join(dir, name)) }));
    } catch { return []; }
  };
  const lockFileFor = (teamName) => path.join(projectStateDirFor(teamName), '派单锁.json');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // 看板里会触发 loadFile/reload/close 的调用不能 await 页面 Promise：导航会销毁旧上下文。
  const boardEval = async (code, timeoutMs = 2500) => {
    if (!booleanBoardWindow()) return null;
    try {
      return await Promise.race([
        teamBoardWindow.webContents.executeJavaScript(code),
        sleep(timeoutMs).then(() => ({ __timeout: true }))
      ]);
    } catch { return null; }
  };
  const waitBoardTitle = async (text, timeoutMs = 6000) => {
    const end = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < end) {
      const value = await boardEval(`document.querySelector('h1') ? document.querySelector('h1').textContent : ''`);
      if (typeof value === 'string') {
        last = value;
        if (value.includes(text)) return value;
      }
      await sleep(150);
    }
    return last;
  };
  const report = {};
  try {
    // 1) 建 A 项目 + 六角色会话；同时准备文件读取夹具。
    const setup = await evaluate('创建第五轮A', `
      const a = await window.workbench.createProject({ name: '第五轮A', root: ${js(testRoot)} });
      const provision = await window.workbench.dshProvision({ projectId: a.project.id });
      return JSON.stringify({
        ok: Boolean(a.ok), projectId: a.project.id, path: a.project.path,
        workspaceId: (a.workspace && a.workspace.id) || '',
        sessionCount: provision.mapping ? provision.mapping.sessionCount : -1,
        sessions: provision.mapping ? provision.mapping.sessions : []
      });
    `);
    expect('第五轮A创建成功', setup.ok === true, setup);
    expect('第五轮A建齐六个角色会话', setup.sessionCount === 6, setup.sessionCount);
    const aId = setup.projectId;
    const aPath = setup.path;
    if (!aId || !aPath) return { report, failures };
    const productSession = (setup.sessions || []).find((row) => row.role === 'product')?.sessionId || '';
    fs.mkdirSync(path.join(aPath, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(aPath, 'docs', 'hello.md'), '# 第五轮文件读取\n\n只读预览。\n', 'utf8');
    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');
    fs.writeFileSync(path.join(aPath, 'docs', 'tiny.png'), tinyPng);
    fs.writeFileSync(path.join(aPath, 'docs', 'huge.md'), 'x'.repeat(513 * 1024), 'utf8');
    fs.writeFileSync(path.join(testRoot, '第五轮-outside.txt'), 'outside', 'utf8');

    // 2) files:read：文本 / Markdown / 图片 / 越界 / 超限。
    const filesProbe = await evaluate('files:read', `
      const out = { projectId: ${js(aId)} };
      out.md = await window.workbench.filesRead({ projectId: out.projectId, rel: 'docs/hello.md' });
      out.image = await window.workbench.filesRead({ projectId: out.projectId, rel: 'docs/tiny.png' });
      try { out.outside = await window.workbench.filesRead({ projectId: out.projectId, rel: '../第五轮-outside.txt' }); } catch (e) { out.outsideError = String(e && e.message || e); }
      try { out.huge = await window.workbench.filesRead({ projectId: out.projectId, rel: 'docs/huge.md' }); } catch (e) { out.hugeError = String(e && e.message || e); }
      return JSON.stringify(out);
    `);
    expect('files:read 暴露给 preload', typeof filesProbe.md === 'object', filesProbe.md);
    expect('files:read 读 Markdown', filesProbe.md && filesProbe.md.kind === 'markdown' && /只读预览/.test(filesProbe.md.text || ''), filesProbe.md && filesProbe.md.kind);
    expect('files:read 读图片 dataUrl', filesProbe.image && filesProbe.image.kind === 'image' && /^data:image\/png;base64,/.test(filesProbe.image.dataUrl || ''), filesProbe.image && filesProbe.image.kind);
    expect('files:read 拦截路径越界', /路径越界|FILE_PATH_OUTSIDE/.test(String(filesProbe.outsideError || '')), filesProbe.outsideError);
    expect('files:read 拦截超大文本', /安全上限|FILE_TOO_LARGE/.test(String(filesProbe.hugeError || '')), filesProbe.hugeError);

    // 3) 跨项目名册：B 没建团队，不能拿 A 的 product 会话发件。
    const cross = await evaluate('跨项目名册', `
      const b = await window.workbench.createProject({ name: '第五轮B', root: ${js(testRoot)} });
      const bSelected = await window.workbench.selectProject(b.project.id);
      let bSendError = '';
      try {
        await window.workbench.teamSend({ projectId: b.project.id, from: 'product', to: 'pm', subject: '跨项目', body: '不应发出' });
      } catch (e) { bSendError = String(e && e.message || e); }
      const bState = await window.workbench.state();
      const bMapping = bState.projects.find(x => x.id === b.project.id).mapping;
      return JSON.stringify({
        bId: b.project.id, bTeamName: bSelected.teamName || '',
        bSendError, bSessionCount: bMapping ? bMapping.sessionCount : -1
      });
    `);
    expect('B 项目没有角色会话时发件被拒绝', /SESSION_ID_REQUIRED|SESSION_IDENTITY|没有真实 DSH 会话/.test(String(cross.bSendError || '')), cross.bSendError);
    const rosterAfterB = readJsonFile(teamTools.layout.teamFile);
    expect('切到 B 后名册不残留 A 的会话', Boolean(rosterAfterB) && (rosterAfterB.members || []).every((member) => !member.sessionId), rosterAfterB && rosterAfterB.members);
    await evaluate('切回 A', `await window.workbench.selectProject(${js(aId)}); return JSON.stringify({ ok: true });`);
    const rosterAfterA = readJsonFile(teamTools.layout.teamFile);
    expect('切回 A 后名册恢复当前项目会话', Boolean(rosterAfterA) && (rosterAfterA.members || []).some((member) => member.role === 'product' && member.sessionId === productSession), rosterAfterA && rosterAfterA.members);

    console.log('SELFTEST_ROUND5_STEP files');
    // 4) send/ack 身份核验 + 旧派单锁：错误会话拒绝、降级回执释放旧锁、无名册残留也能撤销/超时释放。
    const sent = await evaluate('A 派单', `
      const r = await window.workbench.teamSend({ projectId: ${js(aId)}, role: 'analyst', subject: '身份核验', body: '请回执' });
      return JSON.stringify({ id: r.message.id, source: r.message.source, identity: r.sessionIdentity || null });
    `);
    expect('A 派单走旧协议并核验身份', sent.source === 'team' && sent.identity && sent.identity.ok === true, sent);
    const msgId = sent.id;
    const wrongAck = await evaluate('错误会话回执', `
      let error = '';
      try { await window.workbench.teamAck({ projectId: ${js(aId)}, messageId: ${js(msgId)}, note: '错误会话', sessionId: ${js(productSession)}, allowShellAck: true }); } catch (e) { error = String(e && e.message || e); }
      return JSON.stringify({ error });
    `);
    expect('回执拒绝非收件人会话', /SESSION_IDENTITY_MISMATCH|不是该角色|不是.*映射会话/.test(String(wrongAck.error || '')), wrongAck.error);
    const teamNameA = '第五轮A';
    const lockFile = lockFileFor(teamNameA);
    expect('派单生成旧 派单锁.json', fs.existsSync(lockFile), lockFile);
    // 模拟邮箱消息文件被清理/团队状态重建，让旧协议 ack 返回 MESSAGE_NOT_FOUND。
    for (const item of mailboxFiles('analyst')) {
      if (item.data && String(item.data.id) === String(msgId)) fs.rmSync(item.file, { force: true });
    }
    const fallbackAck = await evaluate('降级回执', `
      const r = await window.workbench.teamAck({ projectId: ${js(aId)}, messageId: ${js(msgId)}, note: '降级回执也释放旧锁', allowShellAck: true });
      return JSON.stringify({ source: r.source, lockHeld: r.lockHeld, oldLockReleased: r.oldLockReleased, warnings: r.warnings, ack: Boolean(r.message && r.message.ack) });
    `);
    expect('旧协议找不到消息时降级回执', fallbackAck.source === 'team-local' && fallbackAck.ack === true, fallbackAck);
    expect('降级回执释放旧 派单锁.json', fallbackAck.oldLockReleased === true && !fs.existsSync(lockFile), { released: fallbackAck.oldLockReleased, exists: fs.existsSync(lockFile) });
    const afterFallbackState = await evaluate('降级回执后状态', `const s = await window.workbench.state(); return JSON.stringify({ pending: s.projects.find(x => x.id === ${js(aId)}).pendingAck });`);
    expect('降级回执后本地待回执锁已清', afterFallbackState.pending === null, afterFallbackState.pending);
    const nextSend = await evaluate('降级后可继续派单', `
      const r = await window.workbench.teamSend({ projectId: ${js(aId)}, role: 'tester', subject: '继续派单', body: '旧锁已释放' });
      const s = await window.workbench.state();
      return JSON.stringify({ ok: Boolean(r.ok), pending: s.projects.find(x => x.id === ${js(aId)}).pendingAck, id: r.message && r.message.id });
    `);
    expect('旧锁释放后 PM 可继续派单', nextSend.ok === true, nextSend);
    await evaluate('撤销测试派单', `await window.workbench.teamCancel({ projectId: ${js(aId)} }); return JSON.stringify({ ok: true });`);
    // 本地 pendingAck 已空、旧锁残留：team:cancel 仍必须按旧锁自身 id 释放。
    fs.mkdirSync(projectStateDirFor(teamNameA), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ messageId: 'M-ORPHAN-ROUND5', to: 'tester', subject: '残留锁', ts: now() }, null, 2) + '\n', 'utf8');
    const orphanCancel = await evaluate('撤销残留锁', `
      const r = await window.workbench.teamCancel({ projectId: ${js(aId)} });
      return JSON.stringify({ ok: r.ok, removed: Boolean(r.released && r.released.removed), released: r.released });
    `);
    expect('pendingAck 为空时 team:cancel 也释放旧锁', orphanCancel.ok === true && orphanCancel.removed === true && !fs.existsSync(lockFile), orphanCancel);
    // 超时：本地锁超 TTL 后 state() 对账，必须同时释放旧锁。
    fs.writeFileSync(lockFile, JSON.stringify({ messageId: 'M-ORPHAN-TIMEOUT', to: 'tester', subject: '超时锁', ts: now() }, null, 2) + '\n', 'utf8');
    const timeoutStore = readStore();
    const timeoutProject = timeoutStore.projects.find((item) => item.id === aId);
    if (timeoutProject) {
      timeoutProject.messages.push({
        id: 'M-timeout-round5', from: 'pm', to: 'tester', subject: '超时锁',
        body: '超时', ackRequired: true, ack: false, source: 'team', teamMessageId: 'M-ORPHAN-TIMEOUT',
        createdAt: now(), ackAt: null
      });
      timeoutProject.pendingAck = 'M-timeout-round5';
      timeoutProject.pendingAckAt = new Date(Date.now() - ACK_TTL_MS - 5000).toISOString();
      writeStore(timeoutStore);
    }
    const timeoutState = await evaluate('超时释放旧锁', `
      const s = await window.workbench.state();
      return JSON.stringify({ pending: s.projects.find(x => x.id === ${js(aId)}).pendingAck });
    `);
    expect('超时对账释放旧 派单锁.json', timeoutState.pending === null && !fs.existsSync(lockFile), { pending: timeoutState.pending, exists: fs.existsSync(lockFile) });

    console.log('SELFTEST_ROUND5_STEP owner');
    // 5) Owner：写旧 工作流.json + PM 系统消息；不向任何 DSH 会话发 prompt。
    const promptBefore = mock.counters.sessionPrompt;
    const owner = await evaluate('Owner 决定', `
      const challenge = await window.workbench.ownerChallenge({ projectId: ${js(aId)}, action: 'owner-decision' });
      const confirmed = await window.workbench.ownerConfirm({ challengeId: challenge.challengeId, nonce: challenge.nonce });
      const r = await window.workbench.ownerDecide({ projectId: ${js(aId)}, status: 'approved', opinion: '第五轮 Owner 通过', confirmToken: confirmed.confirmToken });
      return JSON.stringify({ ok: r.ok, code: r.code || '', notified: r.notified && r.notified.id ? r.notified.id : null, workflowFile: r.workflowFile || null, workflowWrite: r.workflowWrite || null, warnings: r.warnings || [] });
    `);
    const workflowPath = path.join(projectStateDirFor(teamNameA), '工作流.json');
    const workflow = readJsonFile(workflowPath);
    const ownerMessages = mailboxFiles('pm').filter((item) => item.data && item.data.type === 'owner-review');
    expect('Owner 写旧 工作流.json', Boolean(workflow && workflow.ownerReview && workflow.ownerReview.status === 'approved' && /第五轮 Owner 通过/.test(workflow.ownerReview.opinion || '')), workflow);
    expect('Owner 返回 workflowWrite=ok', Boolean(owner.workflowWrite) && owner.workflowWrite.ok === true
      && owner.workflowWrite.attempted === true && owner.workflowFile === workflowPath, owner.workflowWrite);
    expect('Owner 给 PM 写系统消息', ownerMessages.length >= 1 && owner.notified, ownerMessages.map((item) => item.data && item.data.id));
    expect('Owner 决定不伪造 DSH prompt', mock.counters.sessionPrompt === promptBefore, { before: promptBefore, after: mock.counters.sessionPrompt });
    // 写失败不能静默：未登记团队项目时 workflowFile=null，但必须带 workflowWrite/warnings。
    const ownerUnregistered = await teamTools.recordOwnerDecision(
      { name: '第五轮-未登记项目', path: aPath },
      { status: 'approved', opinion: '不应写', roundKey: 'probe' }
    );
    expect('Owner 写失败返回 workflowWrite/warnings', ownerUnregistered.ok === false && ownerUnregistered.workflowFile === null
      && Boolean(ownerUnregistered.workflowWrite) && ownerUnregistered.workflowWrite.ok === false
      && Array.isArray(ownerUnregistered.warnings) && ownerUnregistered.warnings.some((w) => w.code === 'NO_TEAM_PROJECT'),
      ownerUnregistered);
    report.owner = {
      workflowWrite: owner.workflowWrite,
      workflowFile: owner.workflowFile,
      unregisteredCode: ownerUnregistered.code,
      unregisteredWarnings: (ownerUnregistered.warnings || []).map((item) => item.code)
    };

    console.log('SELFTEST_ROUND5_STEP board');
    // 6) 看板浮窗：preload/折叠/缩放/切项目/刷新/文件预览/关闭。
    const boardOpened = await evaluate('打开看板', `
      const r = await window.workbench.teamBoardOld(${js(aId)});
      return JSON.stringify({ ok: r.ok, reused: r.reused, reloaded: r.reloaded });
    `);
    expect('旧版看板窗口能打开', boardOpened.ok === true, boardOpened);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect('看板 BrowserWindow 存在', booleanBoardWindow());
    if (boardWindowAlive()) {
      const boardApi = JSON.parse(await teamBoardWindow.webContents.executeJavaScript(`JSON.stringify({
        has: typeof window.boardWin === 'object' && typeof window.boardWin.control === 'function'
          && typeof window.boardWin.openFile === 'function' && typeof window.boardWin.selectProject === 'function',
        title: document.querySelector('h1') ? document.querySelector('h1').textContent : '',
        project: (document.getElementById('project-select') || {}).value || ''
      })`));
      expect('看板 preload 暴露 window.boardWin', boardApi.has === true, boardApi);
      const boardTitleBefore = await boardEval(`document.querySelector('h1') ? document.querySelector('h1').textContent : ''`);
      expect('看板显示当前项目', /第五轮A/.test(boardTitleBefore || ''), boardTitleBefore);
      const widthBefore = teamBoardWindow.getBounds().width;
      const zoom = await boardEval(`window.boardWin.control('zoom-in')`);
      expect('看板放大改变窗口尺寸', Boolean(zoom && zoom.ok) && teamBoardWindow.getBounds().width > widthBefore, { before: widthBefore, after: teamBoardWindow.getBounds().width });
      const collapsed = await boardEval(`window.boardWin.control('collapse')`);
      expect('看板折叠成标题条', Boolean(collapsed && collapsed.ok) && teamBoardWindow.getBounds().height === 56, teamBoardWindow.getBounds());
      const expanded = await boardEval(`window.boardWin.control('expand')`);
      expect('看板展开恢复尺寸', Boolean(expanded && expanded.ok) && teamBoardWindow.getBounds().height > 56, teamBoardWindow.getBounds());
      const preview = await boardEval(`window.boardWin.openFile(${js(path.join(aPath, 'docs', 'hello.md'))})`);
      expect('看板文件预览只读返回文本', Boolean(preview && preview.ok && preview.kind !== 'image' && /只读预览/.test(preview.text || '')), preview && { ok: preview.ok, kind: preview.kind });
      const outsidePreview = await boardEval(`window.boardWin.openFile(${js(path.join(testRoot, '第五轮-outside.txt'))})`);
      expect('看板文件预览拦截项目目录外路径', Boolean(outsidePreview && outsidePreview.ok === false), outsidePreview);
      // selectProject / refresh / close 都会导航或销毁看板上下文，必须 fire-and-forget 再轮询结果。
      const switchScheduled = await boardEval(`(()=>{ setTimeout(()=>window.boardWin.selectProject('第五轮B'), 0); return 'scheduled'; })()`);
      const boardTitleAfter = await waitBoardTitle('第五轮B');
      const activeAfterSwitch = (await evaluate('看板切项目后工作台状态', `const s = await window.workbench.state(); return JSON.stringify({ active: s.activeProjectId });`)).active;
      expect('看板内切项目刷新为 B', switchScheduled === 'scheduled' && /第五轮B/.test(boardTitleAfter || ''), { switchScheduled, boardTitleAfter });
      expect('看板切项目不改变工作台当前项目', activeAfterSwitch === aId, activeAfterSwitch);
      // 校验后端：未知动作、按路径/未登记项目跨项目选择都必须被拒。
      const unknownAction = await boardEval(`window.boardWin.control('bogus-action')`);
      expect('看板拒绝未知动作', Boolean(unknownAction) && unknownAction.ok === false && unknownAction.code === 'BOARD_ACTION_UNKNOWN'
        && Array.isArray(unknownAction.actions) && unknownAction.actions.includes('switch-project'), unknownAction);
      const pathSelect = await boardEval(`window.boardWin.selectProject(${js(path.join(testRoot, '第五轮B'))})`);
      expect('看板拒绝按路径跨项目选择', Boolean(pathSelect) && pathSelect.ok === false && pathSelect.code === 'PROJECT_INVALID', pathSelect);
      const missingSelect = await boardEval(`window.boardWin.selectProject('不存在的项目')`);
      expect('看板拒绝未登记项目', Boolean(missingSelect) && missingSelect.ok === false && missingSelect.code === 'PROJECT_NOT_FOUND', missingSelect);
      const pathControl = await boardEval(`window.boardWin.control({ action: 'switch-project', project: ${js(path.join(testRoot, '第五轮A'))} })`);
      expect('board-control 拒绝按路径切项目', Boolean(pathControl) && pathControl.ok === false && pathControl.code === 'PROJECT_INVALID', pathControl);
      // switch-project 走 board-control：同样只刷新看板窗口，不改工作台当前项目。
      const switchByControl = await boardEval(`(()=>{ setTimeout(()=>window.boardWin.control({ action: 'switch-project', project: '第五轮A' }), 0); return 'scheduled'; })()`);
      const titleBackA = await waitBoardTitle('第五轮A');
      const activeAfterControlSwitch = (await evaluate('board-control 切项目后状态', `const s = await window.workbench.state(); return JSON.stringify({ active: s.activeProjectId });`)).active;
      expect('board-control 支持切项目', switchByControl === 'scheduled' && /第五轮A/.test(titleBackA || ''), { switchByControl, titleBackA });
      expect('board-control 切项目不改工作台当前项目', activeAfterControlSwitch === aId, activeAfterControlSwitch);
      report.board = {
        unknownAction: unknownAction && unknownAction.code,
        pathSelect: pathSelect && pathSelect.code,
        missingSelect: missingSelect && missingSelect.code,
        pathControl: pathControl && pathControl.code,
        switchByControl,
        titleBackA,
        activeAfterControlSwitch
      };
      const refreshScheduled = await boardEval(`(()=>{ setTimeout(()=>window.boardWin.refresh(), 0); return 'scheduled'; })()`);
      await sleep(800);
      expect('看板刷新 IPC 可用', refreshScheduled === 'scheduled' && booleanBoardWindow(), { refreshScheduled, alive: booleanBoardWindow() });
      const closeScheduled = await boardEval(`(()=>{ setTimeout(()=>window.boardWin.control('close'), 0); return 'scheduled'; })()`);
      await sleep(600);
      expect('看板关闭 IPC 可用', closeScheduled === 'scheduled' && !booleanBoardWindow(), { closeScheduled, alive: booleanBoardWindow() });
    }

    console.log('SELFTEST_ROUND5_STEP delete');
    // 7) 删除项目：归档六会话、清 team/workspace/会话清单，同名重建不产生孤儿。
    const workspacesBeforeDelete = mock.workspaces.size;
    const deleted = await evaluate('删除第五轮A', `
      const r = await window.workbench.deleteProjectRecord(${js(aId)});
      return JSON.stringify({ ok: r.ok, sessions: r.sessions, removed: r.removed, summary: r.summary });
    `);
    expect('删除项目归档六个 DSH 会话', deleted.ok === true && (deleted.sessions && deleted.sessions.archived || []).length === 6, deleted.sessions);
    expect('删除项目清理团队登记', (deleted.removed && deleted.removed.registrations || []).length >= 1, deleted.removed);
    expect('删除项目清掉旧会话清单', !fs.existsSync(path.join(aPath, '团队会话.json')), path.join(aPath, '团队会话.json'));
    const workspaceMetaAfterDelete = readJsonFile(path.join(aPath, 'workspace.json'));
    expect('删除项目清掉 workspace 绑定记录', !workspaceMetaAfterDelete || !workspaceMetaAfterDelete.dshWorkspaceId, workspaceMetaAfterDelete);
    const storeAfterDelete = readStore();
    expect('删除项目移除本地记录', !storeAfterDelete.projects.some((item) => item.id === aId), storeAfterDelete.projects.map((item) => item.id));
    const recreate = await evaluate('同名重建', `
      const r = await window.workbench.createProject({ name: '第五轮A', root: ${js(testRoot)} });
      const provision = await window.workbench.dshProvision({ projectId: r.project.id });
      const status = await window.workbench.dshTeamStatus(r.project.id);
      return JSON.stringify({
        ok: Boolean(r.ok), projectId: r.project.id, workspaceId: (r.workspace && r.workspace.id) || '',
        sessionCount: provision.mapping ? provision.mapping.sessionCount : -1,
        extras: (status.extras || []).length
      });
    `);
    expect('同名重建成功并重新建齐六会话', recreate.ok === true && recreate.sessionCount === 6, recreate);
    expect('同名重建复用原工作区', recreate.workspaceId === setup.workspaceId, { before: setup.workspaceId, after: recreate.workspaceId });
    expect('同名重建工作区没有孤儿会话', recreate.extras === 0, recreate.extras);
    expect('同名重建没有新增 DSH 工作区', mock.workspaces.size === workspacesBeforeDelete, { before: workspacesBeforeDelete, after: mock.workspaces.size });
    report.deleted = { archived: (deleted.sessions && deleted.sessions.archived || []).length, workspace: setup.workspaceId };
    report.recreated = recreate;
  } catch (error) {
    failures.push('第五轮硬问题自测异常：' + String((error && error.stack) || error).slice(0, 600));
  }
  return { report, failures };
}

/**
 * 第六轮硬问题自测（全部走本地 mock DSH 与隔离团队根，不向真实项目发 prompt）：
 *   H7 旧流程闭环：inbox/read IPC + 角色会话核验 + 四步唤醒 + actor 语义；
 *   H4 跨项目清单：A 的 团队会话.json 复制到 B 不得恢复 A 的 workspace/session；
 *   H6 并发：send/ack/cancel 的 await 结束后重读合并，不覆盖并发任务；
 *   M4 旧派单锁：无本地 pending 的孤儿锁、超时锁都能释放；
 *   删除项目：旧团队账本归档保留，项目目录与 D 盘数据不删。
 */
async function selftestRound6(win, testRoot, mock) {
  const failures = [];
  const expect = (name, condition, detail) => {
    if (!condition) failures.push(name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  };
  const js = (value) => JSON.stringify(value);
  const evaluate = async (label, body) => {
    try {
      const raw = await win.webContents.executeJavaScript(`(async()=>{${body}})()`);
      return raw === undefined ? {} : JSON.parse(raw);
    } catch (error) {
      failures.push(label + ' 执行失败：' + String((error && error.message) || error).slice(0, 400));
      return {};
    }
  };
  const teamRoot = teamTools.layout.root;
  const projectStateDirFor = (name) => path.join(teamTools.layout.projectsDir, teamTools.teamSlug(name, 60));
  const lockFileFor = (name) => path.join(projectStateDirFor(name), '派单锁.json');
  const receiptsFile = path.join(teamRoot, '状态', '回执.jsonl');
  const readJsonFile = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
  };
  const readReceipts = () => {
    try {
      const rows = fs.readFileSync(receiptsFile, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      const map = new Map();
      for (const row of rows) {
        const key = String(row.id || '');
        map.set(key, { ...(map.get(key) || {}), ...row });
      }
      return Array.from(map.values());
    } catch { return []; }
  };
  const report = {};
  try {
    // 1) 建 A 项目 + 六角色会话（mock），收件箱初始为空。
    const setup = await evaluate('创建第六轮A', `
      const a = await window.workbench.createProject({ name: '第六轮A', root: ${js(testRoot)} });
      const provision = await window.workbench.dshProvision({ projectId: a.project.id });
      return JSON.stringify({
        ok: Boolean(a.ok), projectId: a.project.id, path: a.project.path,
        workspaceId: (a.workspace && a.workspace.id) || '',
        sessionCount: provision.mapping ? provision.mapping.sessionCount : -1,
        sessions: provision.mapping ? provision.mapping.sessions : []
      });
    `);
    expect('第六轮A创建并建齐六会话', setup.ok === true && setup.sessionCount === 6, setup.sessionCount);
    const aId = setup.projectId;
    const aPath = setup.path;
    if (!aId || !aPath) return { report, failures };
    const analystSession = (setup.sessions || []).find((row) => row.role === 'analyst')?.sessionId || '';
    const productSession = (setup.sessions || []).find((row) => row.role === 'product')?.sessionId || '';
    const pmSession = (setup.sessions || []).find((row) => row.role === 'pm')?.sessionId || '';
    report.analystSession = analystSession;
    report.pmSession = pmSession;

    const inboxBefore = await evaluate('派单前收件箱', `
      const r = await window.workbench.teamInbox({ projectId: ${js(aId)}, role: 'analyst' });
      return JSON.stringify({ ok: r.ok, count: r.count, messages: (r.messages || []).map((m) => m.id), identity: r.identity });
    `);
    expect('inbox IPC 暴露且新项目收件箱为空', inboxBefore.ok === true && inboxBefore.count === 0, inboxBefore);
    expect('inbox 返回角色会话身份核验', inboxBefore.identity && inboxBefore.identity.source === 'verified-session'
      && inboxBefore.identity.sessionId === analystSession, inboxBefore.identity);
    report.inboxBefore = { count: inboxBefore.count, identity: inboxBefore.identity };

    // 2) 派单：唤醒文案必须是旧四步，不是一句“完成后回执”。
    const promptBefore = mock.counters.sessionPrompt;
    const sent = await evaluate('第六轮A派单', `
      const r = await window.workbench.teamSend({ projectId: ${js(aId)}, role: 'analyst', subject: '第六轮四步', body: '验证旧协议四步唤醒' });
      return JSON.stringify({ id: r.message.id, source: r.source, wake: r.wake, lockTaken: r.lockTaken, actor: r.actor });
    `);
    expect('派单走旧协议并占用本地锁', sent.source === 'team' && sent.lockTaken === true, sent);
    const wakePrompts = mock.prompts.slice(promptBefore).filter((row) => String(row.text || '').includes(String(sent.id || '')));
    const wakeText = wakePrompts.length ? String(wakePrompts[0].text) : '';
    report.wakeText = wakeText.slice(0, 1200);
    expect('唤醒文案包含 boot 四步第 1 步', /boot --role analyst --project "第六轮A"/.test(wakeText), wakeText.slice(0, 300));
    expect('唤醒文案包含 inbox --all 第 2 步', /inbox --boot <令牌> --all/.test(wakeText), wakeText.slice(0, 300));
    expect('唤醒文案包含 read --id 第 3 步', new RegExp('read --boot <令牌> --id ' + sent.id).test(wakeText), wakeText.slice(0, 300));
    expect('唤醒文案包含 ack --id 第 4 步', new RegExp('ack --boot <令牌> --id ' + sent.id).test(wakeText), wakeText.slice(0, 600));
    expect('唤醒文案声明工作台不代 ack', /工作台壳不会代你 ack/.test(wakeText), wakeText.slice(-200));

    const inboxAfter = await evaluate('派单后收件箱', `
      const r = await window.workbench.teamInbox({ projectId: ${js(aId)}, role: 'analyst' });
      const row = (r.messages || []).find((m) => m.id === ${js(sent.id)}) || null;
      return JSON.stringify({ ok: r.ok, count: r.count, unread: r.unread, row, identity: r.identity });
    `);
    expect('inbox 读到刚派发的旧协议邮件', inboxAfter.ok === true && inboxAfter.count >= 1 && inboxAfter.row
      && inboxAfter.row.box === 'new' && inboxAfter.row.ackRequired === true, inboxAfter);
    report.inboxAfter = { count: inboxAfter.count, unread: inboxAfter.unread, box: inboxAfter.row && inboxAfter.row.box };
    const wrongInbox = await evaluate('错误会话读收件箱', `
      let error = '';
      try { await window.workbench.teamInbox({ projectId: ${js(aId)}, role: 'analyst', sessionId: ${js(productSession)} }); } catch (e) { error = String(e && e.message || e); }
      return JSON.stringify({ error });
    `);
    expect('inbox 拒绝非该角色的会话', /SESSION_ID_MISMATCH|SESSION_IDENTITY_MISMATCH|不一致/.test(String(wrongInbox.error || '')), wrongInbox.error);

    // 3) read：new → cur，已读水位可见；重复 read 幂等。
    const read1 = await evaluate('第一次 read', `
      const r = await window.workbench.teamRead({ projectId: ${js(aId)}, role: 'analyst', messageId: ${js(sent.id)} });
      return JSON.stringify({ ok: r.ok, alreadyRead: r.alreadyRead, id: r.message && r.message.id, identity: r.identity });
    `);
    expect('team:read 读取旧协议邮件', read1.ok === true && read1.id === sent.id && read1.alreadyRead === false, read1);
    const read2 = await evaluate('第二次 read', `
      const r = await window.workbench.teamRead({ projectId: ${js(aId)}, role: 'analyst', messageId: ${js(sent.id)} });
      return JSON.stringify({ ok: r.ok, alreadyRead: r.alreadyRead });
    `);
    expect('重复 read 返回已读', read2.ok === true && read2.alreadyRead === true, read2);
    report.read = { first: read1.alreadyRead === false, second: read2.alreadyRead === true };
    const inboxAfterRead = await evaluate('已读水位', `
      const all = await window.workbench.teamInbox({ projectId: ${js(aId)}, role: 'analyst', all: true });
      const onlyNew = await window.workbench.teamInbox({ projectId: ${js(aId)}, role: 'analyst', all: false });
      const row = (all.messages || []).find((m) => m.id === ${js(sent.id)}) || null;
      return JSON.stringify({
        box: row && row.box,
        inAll: Boolean(row),
        inNew: (onlyNew.messages || []).some((m) => m.id === ${js(sent.id)})
      });
    `);
    expect('read 后邮件进入 cur（--all 可见）', inboxAfterRead.box === 'cur' && inboxAfterRead.inAll === true, inboxAfterRead);
    expect('read 后 new 不再显示该邮件', inboxAfterRead.inNew === false, inboxAfterRead);

    // 4) 回执 actor：人工确认=workbench-shell/manual；壳代跑=workbench-shell，不冒充角色。
    const manual = await evaluate('人工确认', `
      const r = await window.workbench.teamAck({ projectId: ${js(aId)}, messageId: ${js(sent.id)}, note: '人工确认收到', manual: true });
      const s = await window.workbench.state();
      const m = s.projects.find((x) => x.id === ${js(aId)}).messages.find((x) => x.id === ${js(sent.id)});
      return JSON.stringify({ source: r.source, actor: r.actor, ack: m.ack, manualAck: m.manualAck, actorStored: m.actor, pending: s.projects.find((x) => x.id === ${js(aId)}).pendingAck });
    `);
    expect('人工确认标 actor=workbench-shell/manual', manual.source === 'manual' && manual.actor === 'workbench-shell/manual'
      && manual.actorStored === 'workbench-shell/manual' && manual.ack === false && manual.pending === sent.id, manual);
    report.manualAck = { source: manual.source, actor: manual.actor, ack: manual.ack };
    const acked = await evaluate('角色回执', `
      const r = await window.workbench.teamAck({ projectId: ${js(aId)}, messageId: ${js(sent.id)}, note: '角色会话回执', allowShellAck: true });
      const s = await window.workbench.state();
      const p = s.projects.find((x) => x.id === ${js(aId)});
      const m = p.messages.find((x) => x.id === ${js(sent.id)});
      return JSON.stringify({ source: r.source, actor: r.actor, ackId: m.ackId, ack: m.ack, actorStored: m.actor, executor: m.executor, identitySource: m.identitySource, pending: p.pendingAck });
    `);
    expect('壳代跑回执标 actor=workbench-shell', acked.source === 'team' && acked.actor === 'workbench-shell'
      && acked.actorStored === 'workbench-shell' && acked.executor === 'workbench-shell', acked);
    expect('回执不清空已核验会话身份', acked.identitySource === 'verified-session', acked.identitySource);
    expect('真实回执清掉本地锁', acked.ack === true && acked.pending === null, acked);
    const receiptRow = readReceipts().find((row) => String(row.id || '') === String(acked.ackId || '')) || null;
    expect('回执.jsonl 记录 actor=workbench-shell', Boolean(receiptRow) && receiptRow.actor === 'workbench-shell'
      && receiptRow.identitySource === 'verified-session', receiptRow);
    report.ack = {
      source: acked.source,
      actor: acked.actor,
      identitySource: acked.identitySource,
      receiptActor: receiptRow && receiptRow.actor,
      receiptId: acked.ackId,
      pending: acked.pending
    };

    // 4b) 旧版回执列表：preload 暴露、项目过滤、update 行去重、actor/executor 原样保留、路径拒绝。
    const rawAckRows = readReceipts().filter((row) => String(row.id || '') === String(acked.ackId || '')).length;
    const receiptsProbe = await evaluate('旧回执列表', `
      const scoped = await window.workbench.teamReceipts({ projectId: ${js(aId)}, limit: 20 });
      const all = await window.workbench.teamReceipts({ all: true, limit: 200 });
      const bad = await window.workbench.teamReceipts({ project: '../../etc/passwd' });
      const id = ${js(acked.ackId)};
      const rows = (scoped.receipts || []).filter((row) => row.id === id);
      return JSON.stringify({
        exposed: typeof window.workbench.teamReceipts === 'function',
        ok: scoped.ok, count: scoped.count, total: scoped.total, superseded: scoped.superseded, tailOnly: scoped.tailOnly,
        rows: rows.length,
        actor: rows[0] ? rows[0].actor : null,
        executor: rows[0] ? rows[0].executor : null,
        hasUpdateFlag: Boolean(rows[0] && Object.prototype.hasOwnProperty.call(rows[0], 'update')),
        msgId: rows[0] ? rows[0].msgId : null,
        from: rows[0] ? rows[0].from : null,
        allOk: all.ok === true && all.count >= scoped.count,
        badOk: bad.ok, badCode: bad.code
      });
    `);
    expect('team:receipts 暴露给 preload', receiptsProbe.exposed === true, receiptsProbe.exposed);
    expect('旧回执列表只返回本项目', receiptsProbe.ok === true && receiptsProbe.count >= 1 && receiptsProbe.rows === 1, receiptsProbe);
    expect('旧回执 update 行已去重', receiptsProbe.superseded >= 1 && receiptsProbe.hasUpdateFlag === false, { superseded: receiptsProbe.superseded, rawAckRows });
    expect('旧回执输出去掉 update 标记', receiptsProbe.hasUpdateFlag === false && Boolean(receiptsProbe.msgId) && Boolean(receiptsProbe.from), receiptsProbe);
    expect('旧回执保留 actor/executor', receiptsProbe.actor === 'workbench-shell' && receiptsProbe.executor === 'workbench-shell', receiptsProbe);
    expect('旧回执拒绝路径项目名', receiptsProbe.badOk === false && receiptsProbe.badCode === 'PROJECT_INVALID', receiptsProbe.badCode);
    expect('旧回执 all:true 可列全部', receiptsProbe.allOk === true, receiptsProbe.allOk);
    report.receipts = {
      count: receiptsProbe.count,
      total: receiptsProbe.total,
      superseded: receiptsProbe.superseded,
      rawAckRows,
      actor: receiptsProbe.actor,
      updateFlag: receiptsProbe.hasUpdateFlag
    };

    // 5) H4：B 目录复制 A 的 团队会话.json，不得恢复 A 的 workspace/session。
    const bSetup = await evaluate('创建第六轮B', `
      const b = await window.workbench.createProject({ name: '第六轮B', root: ${js(testRoot)} });
      return JSON.stringify({ projectId: b.project.id, path: b.project.path, workspaceId: (b.workspace && b.workspace.id) || '' });
    `);
    fs.copyFileSync(path.join(aPath, '团队会话.json'), path.join(bSetup.path, '团队会话.json'));
    const bSelect = await evaluate('阅读A清单', `
      const sel = await window.workbench.selectProject(${js(bSetup.projectId)});
      const s = await window.workbench.state();
      const m = s.projects.find((x) => x.id === ${js(bSetup.projectId)}).mapping;
      return JSON.stringify({ sessionCount: m.sessionCount, workspaceId: m.workspaceId, warnings: sel.warnings || [] });
    `);
    expect('B 不恢复 A 的角色会话', bSelect.sessionCount === 0, bSelect);
    expect('B 不被绑定到 A 的 workspace', bSelect.workspaceId === bSetup.workspaceId, [bSelect.workspaceId, bSetup.workspaceId]);
    expect('B 切换时报告清单路径不一致', (bSelect.warnings || []).some((w) => w.code === 'MANIFEST_WORKSPACE_MISMATCH'), bSelect.warnings);
    report.bCopyManifest = { sessionCount: bSelect.sessionCount, workspaceId: bSelect.workspaceId, warnings: bSelect.warnings };
    const forgedManifest = readJsonFile(path.join(aPath, '团队会话.json')) || {};
    fs.writeFileSync(path.join(bSetup.path, '团队会话.json'), JSON.stringify({
      ...forgedManifest,
      project: '第六轮B',
      workspace: bSetup.path,
      workspaceId: setup.workspaceId
    }, null, 2) + '\n', 'utf8');
    const forged = await evaluate('B 用伪造清单发件', `
      await window.workbench.selectProject(${js(bSetup.projectId)});
      let error = '';
      try {
        await window.workbench.teamSend({ projectId: ${js(bSetup.projectId)}, from: 'pm', to: 'analyst', subject: '跨项目', body: '不应发出' });
      } catch (e) { error = String(e && e.message || e); }
      const s = await window.workbench.state();
      const m = s.projects.find((x) => x.id === ${js(bSetup.projectId)}).mapping;
      return JSON.stringify({ error, sessionCount: m.sessionCount, workspaceId: m.workspaceId });
    `);
    expect('伪造清单只恢复会话线索、不绑 A workspace', forged.workspaceId === bSetup.workspaceId, [forged.workspaceId, bSetup.workspaceId]);
    expect('B 不能拿 A 的会话派单', /SESSION_IDENTITY_MISMATCH|不属于当前项目工作区|WORKSPACE_PATH_MISMATCH/.test(String(forged.error || '')), forged.error);
    report.forgedManifest = { sessionCount: forged.sessionCount, workspaceId: forged.workspaceId, error: forged.error };

    // 6) H6：send/ack/cancel 的 await 结束后重读合并，不覆盖并发创建的任务。
    const cSetup = await evaluate('创建第六轮C', `
      const c = await window.workbench.createProject({ name: '第六轮C', root: ${js(testRoot)} });
      const provision = await window.workbench.dshProvision({ projectId: c.project.id });
      return JSON.stringify({ projectId: c.project.id, path: c.project.path, sessionCount: provision.mapping ? provision.mapping.sessionCount : -1 });
    `);
    expect('第六轮C创建并建齐六会话', cSetup.sessionCount === 6, cSetup.sessionCount);
    const cId = cSetup.projectId;
    const cPath = cSetup.path;
    const concSend = await evaluate('并发派单+建任务', `
      const [send, t1, t2] = await Promise.all([
        window.workbench.teamSend({ projectId: ${js(cId)}, role: 'analyst', subject: '并发派单', body: '验证不丢写' }),
        window.workbench.createTask({ projectId: ${js(cId)}, title: '并发任务一', role: 'analyst' }),
        window.workbench.createTask({ projectId: ${js(cId)}, title: '并发任务二', role: 'analyst' })
      ]);
      const s = await window.workbench.state();
      const p = s.projects.find((x) => x.id === ${js(cId)});
      return JSON.stringify({ messageId: send.message.id, taskCount: p.tasks.length, hasMessage: p.messages.some((m) => m.id === send.message.id), pending: p.pendingAck });
    `);
    expect('派单并发建任务不丢任务', concSend.taskCount === 2 && concSend.hasMessage === true, concSend);
    expect('并发派单后锁指向该消息', concSend.pending === concSend.messageId, concSend);
    const concAck = await evaluate('并发回执+建任务', `
      const [ack, t3] = await Promise.all([
        window.workbench.teamAck({ projectId: ${js(cId)}, messageId: ${js(concSend.messageId)}, note: '并发回执', allowShellAck: true }),
        window.workbench.createTask({ projectId: ${js(cId)}, title: '并发任务三', role: 'tester' })
      ]);
      const s = await window.workbench.state();
      const p = s.projects.find((x) => x.id === ${js(cId)});
      return JSON.stringify({ ack: Boolean(ack.message && ack.message.ack), taskCount: p.tasks.length, pending: p.pendingAck });
    `);
    expect('回执并发建任务不丢任务', concAck.ack === true && concAck.taskCount === 3 && concAck.pending === null, concAck);
    const concCancel = await evaluate('并发撤销+建任务', `
      const send = await window.workbench.teamSend({ projectId: ${js(cId)}, role: 'tester', subject: '并发撤销', body: '验证撤销不丢写' });
      const [cancel, t4] = await Promise.all([
        window.workbench.teamCancel({ projectId: ${js(cId)} }),
        window.workbench.createTask({ projectId: ${js(cId)}, title: '并发任务四', role: 'programmer1' })
      ]);
      const s = await window.workbench.state();
      const p = s.projects.find((x) => x.id === ${js(cId)});
      return JSON.stringify({ cancelOk: Boolean(cancel.ok), cleared: cancel.cleared, taskCount: p.tasks.length, pending: p.pendingAck });
    `);
    expect('撤销并发建任务不丢任务', concCancel.cancelOk === true && concCancel.cleared === true
      && concCancel.taskCount === 4 && concCancel.pending === null, concCancel);
    report.concurrency = {
      send: { tasks: concSend.taskCount, pending: concSend.pending },
      ack: { tasks: concAck.taskCount, pending: concAck.pending },
      cancel: { tasks: concCancel.taskCount, pending: concCancel.pending }
    };

    // 7) M4：无本地 pending 的孤儿锁 / 超时锁都能释放，且不写旧快照。
    fs.mkdirSync(projectStateDirFor('第六轮C'), { recursive: true });
    fs.writeFileSync(lockFileFor('第六轮C'), JSON.stringify({ messageId: 'M-ORPHAN-ROUND6', to: 'tester', subject: '孤儿锁', ts: now() }, null, 2) + '\n', 'utf8');
    const orphan = await evaluate('释放孤儿旧锁', `
      const c = await window.workbench.teamCancel({ projectId: ${js(cId)} });
      return JSON.stringify({ ok: c.ok, removed: Boolean(c.released && c.released.removed), cleared: c.cleared });
    `);
    expect('pendingAck 为空时 team:cancel 仍释放旧锁', orphan.ok === true && orphan.removed === true && !fs.existsSync(lockFileFor('第六轮C')), orphan);
    fs.writeFileSync(lockFileFor('第六轮C'), JSON.stringify({ messageId: 'M-ORPHAN-TIMEOUT6', to: 'tester', subject: '超时锁', ts: now() }, null, 2) + '\n', 'utf8');
    const timeoutStore = readStore();
    const timeoutProject = timeoutStore.projects.find((item) => item.id === cId);
    if (timeoutProject) {
      timeoutProject.messages.push({
        id: 'M-timeout-round6', from: 'pm', to: 'tester', subject: '超时锁', body: '超时',
        ackRequired: true, ack: false, source: 'team', teamMessageId: 'M-ORPHAN-TIMEOUT6',
        createdAt: now(), ackAt: null
      });
      timeoutProject.pendingAck = 'M-timeout-round6';
      timeoutProject.pendingAckAt = new Date(Date.now() - ACK_TTL_MS - 5000).toISOString();
      writeStore(timeoutStore);
    }
    const timeoutState = await evaluate('超时释放旧锁', `
      const s = await window.workbench.state();
      const p = s.projects.find((x) => x.id === ${js(cId)});
      return JSON.stringify({ pending: p.pendingAck, tasks: p.tasks.length });
    `);
    expect('超时对账释放旧锁且保留并发任务', timeoutState.pending === null && timeoutState.tasks === 4
      && !fs.existsSync(lockFileFor('第六轮C')), { timeoutState, lockExists: fs.existsSync(lockFileFor('第六轮C')) });

    // 8) 删除项目：归档旧团队账本（任务/项目.json 保留），不删项目目录，不在 D 盘外落数据。
    const archiveStopBefore = mock.counters.workspaceArchiveStopped;
    const deleted = await evaluate('删除第六轮C', `
      const r = await window.workbench.deleteProjectRecord(${js(cId)});
      return JSON.stringify({
        ok: r.ok,
        archived: (r.sessions && r.sessions.archived || []).length,
        archivedTo: r.removed && r.removed.archivedTo || '',
        registrations: (r.removed && r.removed.registrations || []).length,
        pendingCleanup: Boolean(r.pendingCleanup),
        storeHas: (await window.workbench.state()).projects.some((x) => x.id === ${js(cId)})
      });
    `);
    expect('删除项目归档六个角色会话', deleted.ok === true && deleted.archived === 6, deleted);
    expect('删除项目归档旧团队账本而不是删除', Boolean(deleted.archivedTo) && fs.existsSync(deleted.archivedTo), deleted.archivedTo);
    expect('归档仍保留 项目.json/任务', Boolean(deleted.archivedTo)
      && fs.existsSync(path.join(deleted.archivedTo, '项目.json'))
      && fs.existsSync(path.join(deleted.archivedTo, '任务')), deleted.archivedTo && fs.readdirSync(deleted.archivedTo));
    expect('删除项目不删项目目录', fs.existsSync(cPath), cPath);
    expect('删除项目移除本地记录', deleted.storeHas === false, deleted);
    expect('归档会话时 stopActivity=true', mock.counters.workspaceArchiveStopped - archiveStopBefore >= 6,
      { before: archiveStopBefore, after: mock.counters.workspaceArchiveStopped });
    report.deleted = {
      archived: deleted.archived,
      archivedTo: deleted.archivedTo,
      registrations: deleted.registrations,
      pendingCleanup: deleted.pendingCleanup,
      projectDirKept: fs.existsSync(cPath),
      stopActivity: mock.counters.workspaceArchiveStopped - archiveStopBefore
    };
    const expectedRoot = path.parse(ROOT).root.toLowerCase();
    report.drive = path.parse(ROOT).root;
    report.teamRoot = teamRoot;
    report.testRoot = path.resolve(testRoot);
    expect('团队状态在仓库同一个盘', path.parse(teamRoot).root.toLowerCase() === expectedRoot, [teamRoot, ROOT]);
    expect('自测沙盘在仓库同一个盘', path.parse(path.resolve(testRoot)).root.toLowerCase() === expectedRoot, [testRoot, ROOT]);
    expect('A 项目目录删除后仍保留（D 盘数据保持）', fs.existsSync(aPath), aPath);
    report.checks = {
      inbox: true, read: true, wake: true, actor: true, manifest: true, concurrency: true, lock: true, delete: true
    };
  } catch (error) {
    failures.push('第六轮硬问题自测异常：' + String((error && error.stack) || error).slice(0, 600));
  }
  return { report, failures };
}

/**
 * 第九轮硬问题自测（全部走本地 mock DSH 与隔离团队根，不向真实项目发 prompt）：
 *   1. 六会话通信链 delivered/wake/read/ack 四段状态；
 *   2. 角色自己 read/ack（直接跑 team.mjs，不经壳 IPC）能被邮箱/回执现场检测；
 *   3. 壳默认不代跑 ack；无 allowShellAck 必须 ROLE_ACK_REQUIRED，显式 allowShellAck 才写 actor=workbench-shell；
 *   4. 六角色 from→to、PM 收件、角色互发、跨项目 workspace 拒绝；
 *   5. 旧评审协议 propose→show→review→sign→apply 桥接 team.mjs，工具缺失返回 LEGACY_PROTOCOL_REQUIRED。
 */
async function selftestRound9(win, testRoot, mock) {
  const failures = [];
  const expect = (name, condition, detail) => {
    if (!condition) failures.push(name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  };
  const js = (value) => JSON.stringify(value);
  const evaluate = async (label, body) => {
    try {
      const raw = await win.webContents.executeJavaScript(`(async()=>{${body}})()`);
      return raw === undefined ? {} : JSON.parse(raw);
    } catch (error) {
      failures.push(label + ' 执行失败：' + String((error && error.message) || error).slice(0, 500));
      return {};
    }
  };
  const teamRoot = teamTools.layout.root;
  const receiptsFile = path.join(teamRoot, '状态', '回执.jsonl');
  const readReceipts = () => {
    try {
      const rows = fs.readFileSync(receiptsFile, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      const map = new Map();
      for (const row of rows) {
        const key = String(row.id || '');
        map.set(key, { ...(map.get(key) || {}), ...row });
      }
      return Array.from(map.values());
    } catch { return []; }
  };
  const runTool = (args, timeoutMs = 30000) => teamTools._runNode(teamTools.layout.teamTool, args, { timeoutMs });
  const report = {};
  try {
    // 1) 新项目 + 六角色会话（mock）。项目名隔离，避免复用上一轮团队对象。
    const setup = await evaluate('创建第九轮A', `
      const a = await window.workbench.createProject({ name: '第九轮A', root: ${js(testRoot)} });
      const provision = await window.workbench.dshProvision({ projectId: a.project.id });
      const s = await window.workbench.state();
      const p = s.projects.find((x) => x.id === a.project.id);
      return JSON.stringify({
        projectId: a.project.id, path: a.project.path, teamName: p.teamName || a.project.name,
        workspaceId: (a.workspace && a.workspace.id) || '',
        sessionCount: provision.mapping ? provision.mapping.sessionCount : -1,
        sessions: provision.mapping ? provision.mapping.sessions : []
      });
    `);
    expect('第九轮A创建并建齐六会话', setup.projectId && setup.sessionCount === 6, setup);
    const projectId = setup.projectId;
    const projectPath = setup.path;
    const teamName = setup.teamName;
    if (!projectId || !projectPath || !teamName) return { report, failures };
    const sessionOf = (role) => ((setup.sessions || []).find((row) => row.role === role) || {}).sessionId || '';
    const pmSession = sessionOf('pm');
    const analystSession = sessionOf('analyst');
    const testerSession = sessionOf('tester');
    report.sessions = { pm: pmSession, analyst: analystSession, tester: testerSession };

    // 2) 发送后写入 delivered + wake（四步），并验证唤醒文案仍是旧协议四步。
    const promptBefore = mock.counters.sessionPrompt;
    const sent = await evaluate('第九轮派单 analyst', `
      const r = await window.workbench.teamSend({ projectId: ${js(projectId)}, role: 'analyst', subject: '第九轮通信链', body: '验证 delivered/wake/read/ack' });
      return JSON.stringify({ id: r.message.id, source: r.source, comm: r.comm, wake: r.wake, pending: (await window.workbench.state()).projects.find((x) => x.id === ${js(projectId)}).pendingAck });
    `);
    expect('派单走旧协议', sent.source === 'team' && Boolean(sent.id), sent);
    expect('发送后 delivered 已记录', sent.comm && sent.comm.delivered && sent.comm.delivered.state === 'delivered', sent.comm);
    expect('发送后 wake=sent 且带四步', sent.comm && sent.comm.wake && sent.comm.wake.state === 'sent'
      && Array.isArray(sent.comm.wake.steps) && sent.comm.wake.steps.join(',') === 'boot,inbox,read,ack', sent.comm && sent.comm.wake);
    expect('发送后 read/ack 仍是 pending', sent.comm && sent.comm.read.state === 'pending' && sent.comm.ack.state === 'pending', sent.comm);
    expect('PM 派单占用本机待回执锁', sent.pending === sent.id, sent.pending);
    const wakePrompts = mock.prompts.slice(promptBefore).filter((row) => String(row.text || '').includes(String(sent.id || '')));
    report.wakeText = wakePrompts.length ? String(wakePrompts[0].text || '').slice(0, 1200) : '';
    expect('四步唤醒文案仍完整', /boot --role analyst/.test(report.wakeText)
      && /inbox --boot <令牌> --all/.test(report.wakeText)
      && new RegExp('read --boot <令牌> --id ' + sent.id).test(report.wakeText)
      && new RegExp('ack --boot <令牌> --id ' + sent.id).test(report.wakeText)
      && /工作台壳不会代你 ack/.test(report.wakeText), report.wakeText);

    // 3) 角色自己执行 read/ack：直接跑 team.mjs（相当于角色会话里的四步），不经 team:read/team:ack IPC。
    const analystBoot = await teamTools.bootToken(teamName, 'analyst', { sessionId: analystSession, force: true });
    expect('角色自己执行前能拿到 boot 令牌', analystBoot.ok === true, analystBoot.code || analystBoot.message);
    const promptBeforeDirect = mock.counters.sessionPrompt;
    const directRead = analystBoot.ok ? await runTool(['read', '--boot', analystBoot.token, '--id', sent.id, '--json']) : { ok: false, code: 'NO_BOOT' };
    expect('角色自己 read 成功', directRead.ok === true && directRead.value && directRead.value.ok === true, directRead);
    const directAck = analystBoot.ok ? await runTool(['ack', '--boot', analystBoot.token, '--id', sent.id, '--note', '角色自己回执：已收到 + 边界', '--json']) : { ok: false, code: 'NO_BOOT' };
    expect('角色自己 ack 成功', directAck.ok === true && directAck.value && directAck.value.ok === true && Boolean(directAck.value.ack), directAck);
    expect('角色自己执行不触发 DSH prompt', mock.counters.sessionPrompt === promptBeforeDirect, { before: promptBeforeDirect, after: mock.counters.sessionPrompt });
    const selfComm = await evaluate('查询角色自执行状态', `
      const r = await window.workbench.teamComm({ projectId: ${js(projectId)}, messageId: ${js(sent.id)} });
      const s = await window.workbench.state();
      const p = s.projects.find((x) => x.id === ${js(projectId)});
      const m = p.messages.find((x) => x.id === ${js(sent.id)});
      return JSON.stringify({ comm: r.comm, ack: m.ack, ackSource: m.ackSource, actor: m.actor, executor: m.executor, pending: p.pendingAck, reconcile: r.reconcile });
    `);
    expect('邮箱 new→cur 被识别为角色自己 read', selfComm.comm && selfComm.comm.read.state === 'read'
      && selfComm.comm.read.by === 'role' && selfComm.comm.selfExecuted.read === true, selfComm.comm && selfComm.comm.read);
    expect('回执.jsonl 新增被识别为角色自己 ack', selfComm.comm && selfComm.comm.ack.state === 'acked'
      && selfComm.comm.ack.by === 'role' && selfComm.comm.selfExecuted.ack === true, selfComm.comm && selfComm.comm.ack);
    expect('角色自回执后本地消息 ack=true 且锁释放', selfComm.ack === true && selfComm.pending === null, selfComm);
    expect('角色自回执 actor 不冒充 workbench-shell', selfComm.comm && selfComm.comm.ack.actor !== 'workbench-shell'
      && selfComm.comm.ack.actor === 'role-session', selfComm.comm && selfComm.comm.ack);
    const directReceipt = readReceipts().find((row) => String(row.msgId || '') === String(sent.id) && String(row.from || '') === 'analyst') || null;
    expect('角色自回执在 回执.jsonl 里可见', Boolean(directReceipt) && directReceipt.id, directReceipt);
    expect('角色自回执没有被壳写成 workbench-shell', Boolean(directReceipt) && directReceipt.actor !== 'workbench-shell', directReceipt);
    report.selfExecution = {
      read: selfComm.comm && selfComm.comm.read,
      ack: selfComm.comm && selfComm.comm.ack,
      pending: selfComm.pending,
      receiptId: directReceipt && directReceipt.id
    };

    // 4) 壳默认不代跑 ack：无 allowShellAck 必须拒绝；显式 allowShellAck 才写 actor=workbench-shell。
    const sent2 = await evaluate('第九轮派单 tester', `
      const r = await window.workbench.teamSend({ projectId: ${js(projectId)}, role: 'tester', subject: '第九轮壳回执', body: '验证默认不代跑 ack' });
      return JSON.stringify({ id: r.message.id, comm: r.comm, pending: (await window.workbench.state()).projects.find((x) => x.id === ${js(projectId)}).pendingAck });
    `);
    expect('第二条派单成功并置锁', Boolean(sent2.id) && sent2.pending === sent2.id, sent2);
    const refused = await evaluate('默认拒绝壳代跑 ack', `
      let error = '';
      try { await window.workbench.teamAck({ projectId: ${js(projectId)}, messageId: ${js(sent2.id)}, note: '壳默认不应代跑' }); } catch (e) { error = String(e && e.message || e); }
      const s = await window.workbench.state();
      const p = s.projects.find((x) => x.id === ${js(projectId)});
      const m = p.messages.find((x) => x.id === ${js(sent2.id)});
      const c = await window.workbench.teamComm({ projectId: ${js(projectId)}, messageId: ${js(sent2.id)} });
      return JSON.stringify({ error, ack: m.ack, pending: p.pendingAck, comm: c.comm });
    `);
    expect('无 allowShellAck 时返回 ROLE_ACK_REQUIRED', /ROLE_ACK_REQUIRED/.test(String(refused.error || '')), refused.error);
    expect('拒绝后消息仍未 ack、派单锁仍在', refused.ack === false && refused.pending === sent2.id, refused);
    expect('拒绝后 comm.ack 仍是 pending', refused.comm && refused.comm.ack.state === 'pending', refused.comm && refused.comm.ack);
    const shellAck = await evaluate('显式 allowShellAck', `
      const r = await window.workbench.teamAck({ projectId: ${js(projectId)}, messageId: ${js(sent2.id)}, note: '壳显式代跑回执', allowShellAck: true });
      const s = await window.workbench.state();
      const p = s.projects.find((x) => x.id === ${js(projectId)});
      return JSON.stringify({ source: r.source, actor: r.actor, comm: r.comm, pending: p.pendingAck, ack: r.message.ack });
    `);
    expect('显式 allowShellAck 才允许壳代跑', shellAck.source === 'team' && shellAck.ack === true && shellAck.pending === null, shellAck);
    expect('壳代跑 actor=workbench-shell 且 selfExecuted=false', shellAck.actor === 'workbench-shell'
      && shellAck.comm && shellAck.comm.ack.by === 'workbench-shell' && shellAck.comm.selfExecuted.ack === false, shellAck);
    expect('壳代跑回执记录 allowShellAck 授权', shellAck.comm && shellAck.comm.ack.allowShellAck === true, shellAck.comm && shellAck.comm.ack);
    const shellReceipt = readReceipts().find((row) => String(row.msgId || '') === String(sent2.id) && String(row.from || '') === 'tester') || null;
    expect('壳代跑回执 actor=workbench-shell', Boolean(shellReceipt) && shellReceipt.actor === 'workbench-shell', shellReceipt);
    report.shellAck = { refusal: refused.error, actor: shellAck.actor, comm: shellAck.comm && shellAck.comm.ack, receiptActor: shellReceipt && shellReceipt.actor };

    // 4b) 人工确认：actor=workbench-shell/manual，ack 仍为 false，comm.ack=manual。
    const sent3 = await evaluate('第九轮派单 product→pm', `
      const r = await window.workbench.teamSend({ projectId: ${js(projectId)}, from: 'product', to: 'pm', subject: '第九轮人工确认', body: '产品给 PM 的互发消息', ackRequired: true });
      return JSON.stringify({ id: r.message.id, from: r.message.from, to: r.message.to });
    `);
    const manual = await evaluate('人工确认 comm', `
      const r = await window.workbench.teamAck({ projectId: ${js(projectId)}, messageId: ${js(sent3.id)}, note: '人工确认收到', manual: true });
      const s = await window.workbench.state();
      const p = s.projects.find((x) => x.id === ${js(projectId)});
      const m = p.messages.find((x) => x.id === ${js(sent3.id)});
      return JSON.stringify({ source: r.source, actor: r.actor, comm: r.comm, ack: m.ack, manualAck: m.manualAck });
    `);
    expect('人工确认 actor=workbench-shell/manual', manual.source === 'manual' && manual.actor === 'workbench-shell/manual', manual);
    expect('人工确认不清旧协议 ack、不写 ack=true', manual.ack === false && manual.manualAck === true, manual);
    expect('人工确认 comm.ack=manual', manual.comm && manual.comm.ack.state === 'manual' && manual.comm.ack.by === 'human', manual.comm && manual.comm.ack);

    // 5) 六角色 from→to：五个非 PM 角色都能给 PM 发件；PM 收件箱能看到；角色互发保留。
    const matrixRoles = ['product', 'analyst', 'programmer1', 'programmer2', 'tester'];
    const matrix = await evaluate('六角色→PM 矩阵', `
      const out = [];
      for (const role of ${js(matrixRoles)}) {
        const r = await window.workbench.teamSend({ projectId: ${js(projectId)}, from: role, to: 'pm', subject: '矩阵-' + role, body: role + ' 给 PM', ackRequired: false });
        out.push({ role, ok: Boolean(r.ok), from: r.message.from, to: r.message.to, source: r.source, delivered: r.comm && r.comm.delivered.state });
      }
      const inbox = await window.workbench.teamInbox({ projectId: ${js(projectId)}, role: 'pm', all: true });
      const subjects = (inbox.messages || []).map((m) => m.subject);
      return JSON.stringify({ out, inboxCount: inbox.count, subjects });
    `);
    expect('五个非 PM 角色都能给 PM 发件', matrix.out.length === 5 && matrix.out.every((row) => row.ok && row.from === row.role && row.to === 'pm' && row.source === 'team'), matrix.out);
    expect('五条矩阵消息都有 delivered 状态', matrix.out.every((row) => row.delivered === 'delivered'), matrix.out);
    expect('PM 收件箱能读到角色发来的消息', matrix.inboxCount >= 5 && matrixRoles.every((role) => matrix.subjects.includes('矩阵-' + role)), { count: matrix.inboxCount, subjects: matrix.subjects });
    const mutual = await evaluate('角色互发 tester→programmer1', `
      const r = await window.workbench.teamSend({ projectId: ${js(projectId)}, from: 'tester', to: 'programmer1', subject: '互发-测试给程序员A', body: '角色互发保留' });
      const a = await window.workbench.teamAck({ projectId: ${js(projectId)}, messageId: r.message.id, note: '程序员A 已收到', allowShellAck: true });
      return JSON.stringify({ from: r.message.from, to: r.message.to, source: r.source, ackSource: a.source, comm: r.comm });
    `);
    expect('角色互发保留 from→to', mutual.from === 'tester' && mutual.to === 'programmer1' && mutual.source === 'team', mutual);
    expect('角色互发回执可用显式壳代跑', mutual.ackSource === 'team', mutual);

    // 6) 跨项目 workspace：B 项目不能拿 A 的 PM 会话读收件箱 / 执行旧评审协议。
    const bSetup = await evaluate('创建第九轮B', `
      const b = await window.workbench.createProject({ name: '第九轮B', root: ${js(testRoot)} });
      const provision = await window.workbench.dshProvision({ projectId: b.project.id });
      return JSON.stringify({ projectId: b.project.id, path: b.project.path, sessionCount: provision.mapping ? provision.mapping.sessionCount : -1 });
    `);
    expect('第九轮B建齐六会话', bSetup.sessionCount === 6, bSetup.sessionCount);
    const cross = await evaluate('B 用 A 会话', `
      let inboxError = '';
      try { await window.workbench.teamInbox({ projectId: ${js(bSetup.projectId)}, role: 'pm', sessionId: ${js(pmSession)} }); } catch (e) { inboxError = String(e && e.message || e); }
      let legacyError = '';
      try {
        const r = await window.workbench.proposalLegacy({ projectId: ${js(bSetup.projectId)}, action: 'show', role: 'pm', sessionId: ${js(pmSession)}, proposalId: 'P-NOT-EXIST' });
        legacyError = String(r && r.message || r && r.code || '');
      } catch (e) { legacyError = String(e && e.message || e); }
      return JSON.stringify({ inboxError, legacyError });
    `);
    expect('B 项目拒绝 A 的会话读收件箱', /SESSION_IDENTITY_MISMATCH|SESSION_ID|不属于当前项目工作区/.test(String(cross.inboxError || '')), cross.inboxError);
    expect('B 项目拒绝 A 的会话执行旧评审协议', /SESSION_IDENTITY_MISMATCH|SESSION_ID|不属于当前项目工作区/.test(String(cross.legacyError || '')), cross.legacyError);
    report.crossProject = cross;

    // 7) 旧评审协议完整桥：propose→show→review→sign→apply，全部走 team.mjs（无 DSH prompt）。
    // 上一步 B 项目的跨项目拒绝会把全局名册切到 B；正常入口（team:send / proposal:legacy）
    // 会在调用前 syncRoster(A)，这里直接调桥也照同样规则把名册切回 A。
    const rosterA = {};
    for (const row of setup.sessions || []) rosterA[row.role] = String(row.sessionId);
    const rosterSync = teamTools.syncRoster(teamName, rosterA);
    expect('旧评审前把名册切回 A', rosterSync.ok === true, rosterSync);
    const pmBoot = await teamTools.bootToken(teamName, 'pm', { sessionId: pmSession, force: true });
    expect('PM 能拿到旧评审 boot 令牌', pmBoot.ok === true, pmBoot.code || pmBoot.message);
    const taskRun = pmBoot.ok ? await runTool(['task', 'create', '--boot', pmBoot.token, '--title', '第九轮旧评审任务', '--priority', 'P1', '--owner', 'analyst', '--json']) : { ok: false };
    const taskId = taskRun.ok && taskRun.value && taskRun.value.task ? String(taskRun.value.task.id) : '';
    expect('旧评审任务创建成功', Boolean(taskId), taskRun.value || taskRun.message);
    const grantRun = pmBoot.ok ? await runTool(['grant', '--boot', pmBoot.token, '--to', 'analyst', '--actions', 'propose', '--scope', 'legacy/**', '--project', teamName, '--expires', '1d', '--reason', '第九轮旧评审桥自测', '--json']) : { ok: false };
    expect('分析师获得 propose 授权', grantRun.ok === true && grantRun.value && grantRun.value.ok === true, grantRun.value || grantRun.message);
    const stagedPath = path.join(testRoot, '第九轮-旧评审暂存.txt');
    fs.writeFileSync(stagedPath, 'legacy review bridge content\n', 'utf8');
    const legacyInput = {
      projectName: teamName,
      role: 'analyst',
      sessionId: analystSession,
      task: taskId,
      title: '旧评审桥提案',
      rationale: '验证 propose→show→review→sign→apply',
      risk: 'normal',
      files: [{ target: 'legacy/review.txt', staged: stagedPath, expect: 'absent' }]
    };
    const promptsBeforeLegacy = mock.counters.sessionPrompt;
    const propose = await teamTools.legacyProposalAction({ ...legacyInput, action: 'propose' });
    expect('旧评审 propose 桥接成功', propose.ok === true && propose.protocol === 'legacy' && propose.action === 'propose', propose);
    const proposalId = propose.ok && propose.proposal ? String(propose.proposal.id) : '';
    expect('propose 返回旧协议字段', Boolean(proposalId) && Boolean(propose.proposal && propose.proposal.proposalHash)
      && Array.isArray(propose.proposal.files) && propose.proposal.files.length === 1, propose.proposal);
    expect('propose 状态/下一步正确', propose.ok && propose.stage === 'proposed' && propose.next === 'show', { stage: propose.stage, next: propose.next, status: propose.status });
    const showPm = await teamTools.legacyProposalAction({ projectName: teamName, role: 'pm', sessionId: pmSession, action: 'show', proposalId });
    expect('show 桥接成功并标记 shown', showPm.ok === true && showPm.stage === 'shown' && showPm.next === 'review', showPm);
    const reviewPm = await teamTools.legacyProposalAction({ projectName: teamName, role: 'pm', sessionId: pmSession, action: 'review', proposalId, verdict: 'approve', comments: 'PM 评审通过' });
    expect('review 桥接成功', reviewPm.ok === true && reviewPm.stage === 'reviewed' && reviewPm.next === 'sign', reviewPm);
    const showProduct = await teamTools.legacyProposalAction({ projectName: teamName, role: 'product', sessionId: sessionOf('product'), action: 'show', proposalId });
    const reviewProduct = await teamTools.legacyProposalAction({ projectName: teamName, role: 'product', sessionId: sessionOf('product'), action: 'review', proposalId, verdict: 'approve', comments: '产品评审通过' });
    expect('第二个评审人 show/review 成功', showProduct.ok === true && reviewProduct.ok === true
      && Array.isArray(reviewProduct.reviews) && reviewProduct.reviews.length >= 2, { show: showProduct.ok, review: reviewProduct.ok });
    const signPm = await teamTools.legacyProposalAction({ projectName: teamName, role: 'pm', sessionId: pmSession, action: 'sign', proposalId, decision: 'approve', note: 'PM 签字通过' });
    expect('sign 桥接成功', signPm.ok === true && signPm.status === 'approved' && signPm.stage === 'signed' && signPm.next === 'apply', signPm);
    const applyPm = await teamTools.legacyProposalAction({ projectName: teamName, role: 'pm', sessionId: pmSession, action: 'apply', proposalId, log: '第九轮旧评审桥提交' });
    const appliedFile = path.join(projectPath, 'legacy', 'review.txt');
    expect('apply 桥接成功', applyPm.ok === true && applyPm.status === 'approved' && applyPm.stage === 'applied'
      && applyPm.proposal && applyPm.proposal.applied === true && Boolean(applyPm.commit && applyPm.commit.id), applyPm);
    expect('apply 真的写入了目标文件', fs.existsSync(appliedFile) && fs.readFileSync(appliedFile, 'utf8') === 'legacy review bridge content\n', appliedFile);
    expect('旧评审桥全程不向 DSH 发 prompt', mock.counters.sessionPrompt === promptsBeforeLegacy, { before: promptsBeforeLegacy, after: mock.counters.sessionPrompt });
    // IPC 镜像：show 一次后，本地 proposals[] 能看到 protocol=legacy 的已应用提案。
    const mirrored = await evaluate('旧评审提案镜像', `
      const r = await window.workbench.proposalLegacy({ projectId: ${js(projectId)}, action: 'show', role: 'pm', sessionId: ${js(pmSession)}, proposalId: ${js(proposalId)} });
      const s = await window.workbench.state();
      const p = s.projects.find((x) => x.id === ${js(projectId)});
      const row = (p.proposals || []).find((x) => x.id === ${js(proposalId)}) || null;
      return JSON.stringify({ ok: r.ok, mirrored: r.mirrored, row, protocol: typeof window.workbench.proposalLegacy });
    `);
    expect('proposal:legacy IPC 暴露并可镜像', mirrored.ok === true && mirrored.protocol === 'function'
      && mirrored.row && mirrored.row.protocol === 'legacy' && mirrored.row.applied === true, mirrored);
    const localReject = await evaluate('本地禁止改旧提案', `
      let error = '';
      try { await window.workbench.proposalApply({ projectId: ${js(projectId)}, proposalId: ${js(proposalId)} }); } catch (e) { error = String(e && e.message || e); }
      return JSON.stringify({ error });
    `);
    expect('本地 proposal:apply 明确返回 LEGACY_PROTOCOL_REQUIRED', /LEGACY_PROTOCOL_REQUIRED/.test(String(localReject.error || '')), localReject.error);
    // 工具缺失：桥接必须明确返回 LEGACY_PROTOCOL_REQUIRED，而不是伪造本地成功。
    const missingTools = teamTools.create({ teamRoot, toolsDir: path.join(testRoot, '第九轮-没有工具') });
    const missing = await missingTools.legacyPropose({ ...legacyInput, action: 'propose' });
    expect('旧工具缺失返回 LEGACY_PROTOCOL_REQUIRED', missing.ok === false && missing.code === 'LEGACY_PROTOCOL_REQUIRED', missing);
    const missingStatus = await missingTools.legacyProposalAction({ ...legacyInput, action: 'show', proposalId: 'P-x' });
    expect('旧工具缺失时 show 也返回 LEGACY_PROTOCOL_REQUIRED', missingStatus.ok === false && missingStatus.code === 'LEGACY_PROTOCOL_REQUIRED', missingStatus);
    report.legacy = {
      proposalId,
      propose: { stage: propose.stage, next: propose.next, status: propose.status },
      show: { stage: showPm.stage, next: showPm.next },
      review: { stage: reviewPm.stage, next: reviewPm.next, reviews: reviewPm.reviews.length },
      sign: { status: signPm.status, stage: signPm.stage, next: signPm.next },
      apply: { status: applyPm.status, stage: applyPm.stage, next: applyPm.next, commitId: applyPm.commit && applyPm.commit.id },
      mirrored: Boolean(mirrored.row && mirrored.row.protocol === 'legacy'),
      localReject: localReject.error,
      missing: missing.code
    };

    // 8) 数据只写 D 盘：仓库、团队根、自测沙盘、旧评审提案目录全在同一个盘。
    const expectedRoot = path.parse(ROOT).root.toLowerCase();
    const stateDir = path.join(teamTools.layout.projectsDir, teamTools.teamSlug(teamName, 60));
    const proposalDir = path.join(stateDir, '提案');
    const driveChecks = [ROOT, teamRoot, testRoot, stateDir, proposalDir, appliedFile, receiptsFile]
      .map((target) => ({ target, drive: path.parse(path.resolve(target)).root.toLowerCase() }));
    report.drive = { expectedRoot, checks: driveChecks };
    expect('仓库与自测沙盘在 D 盘', driveChecks.every((row) => row.drive === expectedRoot), driveChecks);
    expect('旧评审数据在 D 盘', path.parse(appliedFile).root.toLowerCase() === expectedRoot
      && fs.existsSync(path.join(proposalDir, proposalId, '提案.json')), { appliedFile, proposalDir, proposalId });
    report.checks = {
      delivered: true, wake: true, roleSelfRead: true, roleSelfAck: true, shellAckGate: true,
      manualActor: true, sixRoleToPm: true, pmInbox: true, mutual: true, crossProject: true,
      legacyProposeShowReviewSignApply: true, legacyRequired: true, driveD: true
    };
  } catch (error) {
    failures.push('第九轮硬问题自测异常：' + String((error && error.stack) || error).slice(0, 800));
  }
  return { report, failures };
}

/**
 * 第十轮：旧团队工作流唯一真相源的后端闭环。
 * 只跑 mock DSH / 沙盘团队状态；每个动作都通过 preload → IPC 进入，
 * 业务状态落在 <团队>/状态/项目/<slug>/，本地 workbench.json 只做镜像。
 */
/**
 * 自测专用：模拟“升级后的旧 team.mjs”已经有的 req review / owner / workflow 命令。
 * 只给 teamTools.create({ legacyMock }) 注入，生产路径不会启用；真正的旧命令调用
 * 仍走 team.mjs，mock 只补当前旧工具缺失的三条协议命令。
 */
function createWorkflowProtocolMock(tools) {
  const log = [];
  const stateDirOf = (projectName) => {
    let entries = [];
    try { entries = fs.readdirSync(tools.layout.projectsDir, { withFileTypes: true }); } catch { return ''; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(tools.layout.projectsDir, entry.name);
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, '项目.json'), 'utf8').replace(/^\uFEFF/, ''));
        if (String(data.name) === String(projectName)) return dir;
      } catch { /* 不是项目状态目录 */ }
    }
    return '';
  };
  const patchTask = (projectName, requirementId, patch) => {
    const dir = stateDirOf(projectName);
    if (!dir) return null;
    const file = path.join(dir, '任务', String(requirementId) + '.json');
    let task = null;
    try { task = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
    const workflowPatch = patch.workflow && typeof patch.workflow === 'object' ? patch.workflow : {};
    const rest = { ...patch };
    delete rest.workflow;
    task.workflow = {
      ...(task.workflow && typeof task.workflow === 'object' ? task.workflow : {}),
      ...workflowPatch
    };
    Object.assign(task, rest, { updatedAt: new Date().toISOString() });
    fs.writeFileSync(file, JSON.stringify(task, null, 2) + '\n', 'utf8');
    return task;
  };
  return {
    log,
    async run(input) {
      const command = String(input.command || '');
      const at = new Date().toISOString();
      log.push({ at, ...input });
      if (command === 'req review') {
        const review = { verdict: input.verdict, by: 'product', comment: input.comment || '', at, source: 'mock-team.mjs' };
        const task = patchTask(input.projectName, input.requirementId, {
          workflow: { requirementStatus: input.verdict === 'approve' ? 'approved' : 'rejected', productReview: review }
        });
        if (!task) return { ok: false, code: 'REQUIREMENT_NOT_FOUND', message: 'mock 找不到需求任务' };
        return { ok: true, value: { ok: true, requirement: task, review } };
      }
      if (command === 'owner') {
        if (String(input.action || '') === 'accept') {
          const acceptance = { status: input.decision, by: 'Owner', at, opinion: input.opinion || '' };
          const task = patchTask(input.projectName, input.requirementId, { workflow: { ownerAcceptance: acceptance } });
          if (!task) return { ok: false, code: 'REQUIREMENT_NOT_FOUND', message: 'mock 找不到需求任务' };
          return { ok: true, value: { ok: true, requirement: task, acceptance } };
        }
        const ownerReview = { status: input.decision, by: 'Owner', at, opinion: input.opinion || '' };
        const task = patchTask(input.projectName, input.requirementId, { workflow: { ownerReview } });
        if (!task) return { ok: false, code: 'REQUIREMENT_NOT_FOUND', message: 'mock 找不到需求任务' };
        return { ok: true, value: { ok: true, requirement: task, ownerReview } };
      }
      if (command === 'workflow') {
        if (!['iterate', 'terminate'].includes(String(input.action))) {
          return { ok: false, code: 'BAD_ACTION', message: 'mock workflow 只支持 iterate/terminate' };
        }
        const stateRead = tools.readWorkflowState(input.projectName);
        const fromRound = stateRead.ok ? Number(stateRead.state.round || 1) : 1;
        const round = input.action === 'iterate' ? fromRound + 1 : fromRound;
        return { ok: true, value: { ok: true, round, workflow: { round, phase: input.action === 'terminate' ? 'terminated' : 'iteration', action: input.action } } };
      }
      return { ok: false, code: 'LEGACY_PROTOCOL_REQUIRED', message: 'mock 未实现旧命令：' + command };
    }
  };
}

async function selftestRound10RealCommands(realTeamTools, testRoot, evaluate, expect, argvIncludes) {
  const js = (value) => JSON.stringify(value);
  const report = {};
  const readJsonFile = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
  };
  const auditCounts = (requirementId) => {
    const state = readJsonFile(path.join(realTeamTools.layout.projectsDir, realTeamTools.teamSlug(teamName, 60), '工作流.json'));
    const row = state && state.requirements ? state.requirements[requirementId] : null;
    const history = row && Array.isArray(row.history) ? row.history : [];
    const events = state && Array.isArray(state.events) ? state.events : [];
    return {
      productHistory: history.filter((x) => x.action === 'product_review').length,
      ownerHistory: history.filter((x) => x.action === 'owner_review').length,
      acceptHistory: history.filter((x) => x.action === 'owner_accept').length,
      productEvents: events.filter((x) => x.action === 'requirement_review' && String(x.requirementId) === requirementId).length,
      ownerEvents: events.filter((x) => x.action === 'owner_requirement' && String(x.requirementId) === requirementId).length,
      acceptEvents: events.filter((x) => x.action === 'owner_accept' && String(x.requirementId) === requirementId).length,
      iterateEvents: events.filter((x) => x.action === 'iterate').length,
      terminateEvents: events.filter((x) => x.action === 'terminate').length
    };
  };
  const setup = await evaluate('创建真实命令项目', `
    const created = await window.workbench.createProject({ name: '第十轮真实命令', root: ${js(testRoot)} });
    const s = await window.workbench.state();
    const p = s.projects.find((x) => x.id === created.project.id);
    return JSON.stringify({
      projectId: created.project.id,
      path: created.project.path,
      teamName: p.teamName || created.project.name
    });
  `);
  expect('真实命令项目创建成功', Boolean(setup.projectId) && Boolean(setup.teamName), setup);
  if (!setup.projectId || !setup.teamName) return report;
  const teamName = setup.teamName;
  const projectPath = setup.path;
  const autoInfo = fs.readFileSync(path.join(projectPath, '项目信息.md'), 'utf8');
  const autoIron = fs.readFileSync(path.join(projectPath, '项目铁律.md'), 'utf8');
  let teamIron = '';
  try { teamIron = fs.readFileSync(path.join(realTeamTools.layout.root, '项目铁律.md'), 'utf8'); } catch { /* 旧测试根可能没有团队铁律 */ }
  expect('新建项目自动写真实项目信息（无模板占位）',
    !/（待[^）]*）|待填写|待补|TODO|TBD/i.test(autoInfo), autoInfo.slice(0, 120));
  expect('新建项目自动写项目专用铁律（非团队模板）',
    Boolean(autoIron.trim()) && autoIron !== teamIron && !/（待[^）]*）|待填写|待补|TODO|TBD/i.test(autoIron),
    { iron: autoIron.slice(0, 80), equalsTeam: autoIron === teamIron });
  const boot = async (role) => realTeamTools.bootRole(teamName, role, { projectPath });

  for (const role of ['pm', 'product', 'analyst']) {
    const r = await boot(role);
    expect(`真实命令 boot ${role}`, r.ok === true && Boolean(r.bootRead && r.bootRead.complete), r);
  }

  const req = await realTeamTools.createRequirement({
    projectName: teamName, projectPath, role: 'analyst',
    title: '真实命令需求', priority: 'P1',
    acceptance: 'req review / owner / workflow 真实落账'
  });
  const requirementId = req.requirement && req.requirement.id ? String(req.requirement.id) : '';
  expect('真实 req create 成功', req.ok === true && /^R-/.test(requirementId), req);
  if (!requirementId) return report;

  // 需求创建后所有角色都必须重新 boot；产品先读需求，再调真实的 req review。
  await boot('product');
  const review = await realTeamTools.reviewRequirement({
    projectName: teamName, projectPath, role: 'product', requirementId,
    verdict: 'approve', comment: '真实命令产品评审通过'
  });
  expect('真实 req review 正向调用并落账', review.ok === true
    && review.driver === 'team.mjs req review'
    && review.legacy && review.legacy.commandAvailable === true
    && argvIncludes(review.legacy.argv, ['req', 'review', '--boot', '<boot>', '--id', requirementId, '--verdict', 'approve'])
    && argvIncludes(review.legacy.argv, ['--comments', '真实命令产品评审通过'])
    && review.requirement && review.requirement.status === 'approved', review);
  const reviewAudit = auditCounts(requirementId);
  expect('产品评审 history/event 只写一次',
    reviewAudit.productHistory === 1 && reviewAudit.productEvents === 1, reviewAudit);
  expect('产品评审后刷新项目索引', review.projectIndex && review.projectIndex.ok === true, review.projectIndex);

  // 产品评审会更新需求状态行；Owner 决定仍应被允许（评审记录就是证据），
  // 不能因为产品没有对“刚被自己改过的状态行”再 boot 一次而卡死。
  const owner = await realTeamTools.ownerRequirementDecision({
    projectName: teamName, projectPath, role: 'owner', requirementId,
    decision: 'skipped', opinion: '真实命令 Owner 跳过',
    ownerConfirmed: true
  });
  expect('真实 owner 正向调用（评审后无需产品重读）', owner.ok === true
    && owner.driver === 'team.mjs owner'
    && owner.legacy && owner.legacy.commandAvailable === true
    && argvIncludes(owner.legacy.argv, ['owner', '--project', teamName, '--requirement', requirementId, '--decision', 'skipped'])
    && !owner.legacy.argv.includes('--boot')
    && !owner.legacy.argv.includes('--action'), owner);
  const ownerAudit = auditCounts(requirementId);
  expect('Owner 决定 history/event 只写一次',
    ownerAudit.ownerHistory === 1 && ownerAudit.ownerEvents === 1, ownerAudit);
  expect('Owner 决定后刷新项目索引', owner.projectIndex && owner.projectIndex.ok === true, owner.projectIndex);

  // 真实 Owner 验收：先建需求 + 测试任务，测试 done 后走 owner --action accept。
  // 自测专用：直接登记测试任务到工作流（跳过完整开发链），只验证 owner accept 这条真实命令。
  const acceptViaTestTask = async (targetReqId, label) => {
    const pmBoot = await realTeamTools.bootToken(teamName, 'pm', { force: true });
    expect(`${label}拿到 PM 令牌`, pmBoot.ok === true && Boolean(pmBoot.token), pmBoot);
    const testTaskRun = pmBoot.ok ? await realTeamTools._runNode(realTeamTools.layout.teamTool, [
      'task', 'create', '--boot', pmBoot.token,
      '--title', `${targetReqId} ${label}测试`,
      '--priority', 'P1', '--owner', 'tester', '--requirement', targetReqId,
      '--type', 'task', '--acceptance', `${label}测试通过`, '--json'
    ], { timeoutMs: 60000 }) : { ok: false };
    const testTaskId = testTaskRun.ok && testTaskRun.value && testTaskRun.value.task
      ? String(testTaskRun.value.task.id) : '';
    expect(`${label}测试任务创建成功`, Boolean(testTaskId), testTaskRun.value || testTaskRun.message);
    if (!testTaskId) return null;
    const stateRead = realTeamTools.readWorkflowState(teamName);
    const row = stateRead.ok && stateRead.state.requirements ? stateRead.state.requirements[targetReqId] : null;
    if (!row) {
      expect(`${label}需求存在`, false, targetReqId);
      return null;
    }
    row.test = {
      taskId: testTaskId, by: 'pm', at: new Date().toISOString(),
      claimBy: null, claimedAt: null, doneAt: null, evidence: ''
    };
    row.status = 'test';
    stateRead.state.phase = 'test';
    realTeamTools.writeWorkflowState(teamName, stateRead.state);
    await boot('tester');
    const claim = await realTeamTools.claimWorkflowTask({
      projectName: teamName, projectPath, role: 'tester', taskId: testTaskId
    });
    const testDone = await realTeamTools.doneWorkflowTask({
      projectName: teamName, projectPath, role: 'tester', taskId: testTaskId,
      evidence: `PASS ${label}`
    });
    expect(`${label}测试任务 claim/done`, claim.ok === true && testDone.ok === true, {
      claim: claim.code, done: testDone.code
    });
    // 测试 done 会把需求正文/总览同步成 test_done，tester 的旧 boot 按现有闸门作废；
    // Owner 验收前 tester 必须重新读一遍（不绕过闸门）。
    const testerReboot = await boot('tester');
    expect(`${label}测试完成后 tester 重新 boot`,
      testerReboot.ok === true && Boolean(testerReboot.bootRead && testerReboot.bootRead.complete), testerReboot);
    const accept = await realTeamTools.ownerAccept({
      projectName: teamName, projectPath, role: 'owner', requirementId: targetReqId,
      decision: 'accepted', opinion: `${label}通过`,
      ownerConfirmed: true
    });
    expect(`${label} owner --action accept 正向调用`, accept.ok === true
      && accept.requirement && accept.requirement.status === 'accepted'
      && accept.legacy && argvIncludes(accept.legacy.argv, ['--action', 'accept'])
      && argvIncludes(accept.legacy.argv, ['--decision', 'accepted'])
      && accept.requirementTaskDone && accept.requirementTaskDone.ok === true, accept);
    const acceptAudit = auditCounts(targetReqId);
    expect(`${label}验收 history/event 只写一次`,
      acceptAudit.acceptHistory === 1 && acceptAudit.acceptEvents === 1, acceptAudit);
    expect(`${label}验收后刷新项目索引`, accept.projectIndex && accept.projectIndex.ok === true, accept.projectIndex);
    // 索引不能把 需求/评审/、需求/验收/ 的记录算成新需求；需求正文只保留一个状态记录章节。
    let docText = '';
    let docName = '';
    try {
      const reqDir = path.join(projectPath, '需求');
      docName = fs.readdirSync(reqDir).find((name) => name.startsWith(targetReqId + '-') && /\.md$/i.test(name)) || '';
      if (docName) docText = fs.readFileSync(path.join(reqDir, docName), 'utf8');
    } catch { /* 断言会报 */ }
    const indexJson = readJsonFile(path.join(projectPath, '项目索引.json')) || {};
    const indexRows = Array.isArray(indexJson.requirements) ? indexJson.requirements : [];
    const targetRows = indexRows.filter((row) => String(row.id) === String(targetReqId));
    expect(`${label}项目索引不把评审/验收记录算需求`,
      targetRows.length === 1
      && targetRows[0].target === `需求/${docName}`
      && indexRows.every((row) => !String(row.target || '').includes('/评审/') && !String(row.target || '').includes('/验收/')),
      indexRows);
    const statusSections = (docText.match(/^##\s+状态记录/gm) || []).length;
    const acceptedRecords = (docText.match(/^-\s+\S+\s+accepted\s*[：:]/gm) || []).length;
    expect(`${label}需求正文状态记录去重`,
      Boolean(docName) && statusSections === 1 && acceptedRecords === 1,
      { docName, statusSections, acceptedRecords });
    return accept;
  };

  const acceptReq = await realTeamTools.createRequirement({
    projectName: teamName, projectPath, role: 'analyst',
    title: '真实命令验收需求', priority: 'P1',
    acceptance: '测试 done 后 Owner 验收'
  });
  const acceptReqId = acceptReq.requirement && acceptReq.requirement.id ? String(acceptReq.requirement.id) : '';
  expect('真实验收需求创建成功', acceptReq.ok === true && /^R-/.test(acceptReqId), acceptReq);
  let acceptReport = null;
  if (acceptReqId) {
    await boot('product');
    const acceptReview = await realTeamTools.reviewRequirement({
      projectName: teamName, projectPath, role: 'product', requirementId: acceptReqId,
      verdict: 'approve', comment: '真实验收需求产品评审通过'
    });
    const acceptOwner = await realTeamTools.ownerRequirementDecision({
      projectName: teamName, projectPath, role: 'owner', requirementId: acceptReqId,
      decision: 'skipped', opinion: '真实验收 Owner 跳过',
      ownerConfirmed: true
    });
    expect('真实验收前置评审/Owner 通过', acceptReview.ok === true && acceptOwner.ok === true, {
      review: acceptReview.code, owner: acceptOwner.code
    });
    const accepted = await acceptViaTestTask(acceptReqId, '真实验收');
    if (accepted) {
      acceptReport = {
        requirementId: acceptReqId, decision: accepted.decision,
        status: accepted.requirement && accepted.requirement.status,
        argv: accepted.legacy && accepted.legacy.argv,
        taskDone: accepted.requirementTaskDone
      };
    }
  }

  // 迭代前置：第一条需求仍未验收时，真实 workflow iterate 必须被壳的迭代闸门拒绝。
  await boot('pm');
  const blockedIterate = await realTeamTools.iterateWorkflow({
    projectName: teamName, projectPath, role: 'pm', opinion: '不应启动'
  });
  expect('真实 workflow 在需求未收口时拒绝迭代', blockedIterate.ok === false
    && blockedIterate.code === 'ITERATE_BLOCKED', blockedIterate);
  // 把第一条需求也走完真实 Owner 验收，之后才允许进入下一轮。
  const firstAccepted = await acceptViaTestTask(requirementId, '真实首条需求验收');
  expect('真实首条需求验收通过', firstAccepted && firstAccepted.ok === true
    && firstAccepted.requirement && firstAccepted.requirement.status === 'accepted', firstAccepted);

  // 4 位旧需求只有正文时：评审 / Owner / 验收都必须能走通，且索引/正文状态记录不重复。
  const legacyName = teamName + '-旧号验收';
  const legacyPath = path.join(testRoot, '旧号验收');
  fs.mkdirSync(legacyPath, { recursive: true });
  const legacyEnsure = await realTeamTools.ensureProjectReady({ name: legacyName, path: legacyPath }, { name: legacyName });
  expect('旧号验收项目 ensure', legacyEnsure.ok === true, legacyEnsure);
  // ensure 只铺目录；boot 现在会拒绝“待填写/待补”模板，旧号验收项目也必须写真实项目信息/铁律。
  // 这是自测数据准备，不改产品逻辑：先满足 boot 的前置文档闸门，再验证 4 位旧需求流程。
  seedSelftestProjectDocs(legacyPath, legacyName);
  expect('旧号验收项目文档写真实正文（boot 前置）',
    !/（待[^）]*）|待填写|待补|TODO|TBD/i.test(fs.readFileSync(path.join(legacyPath, '项目信息.md'), 'utf8'))
    && !/（待[^）]*）|待填写|待补|TODO|TBD/i.test(fs.readFileSync(path.join(legacyPath, '项目铁律.md'), 'utf8')),
    legacyPath);
  const legacyReviewId = 'R-20200101-0001';
  const legacyAcceptId = 'R-20200101-0002';
  fs.writeFileSync(path.join(legacyPath, '需求', legacyReviewId + '-旧号评审.md'), [
    '# 旧号评审', '', '- 状态：review', '- 优先级：P2', '',
    '## 验收标准', '', '只有正文的 4 位旧需求能评审、Owner 决定。', ''
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(legacyPath, '需求', legacyAcceptId + '-旧号验收.md'), [
    '# 旧号验收', '', '- 状态：review', '- 优先级：P2', '',
    '## 验收标准', '', '只有正文的 4 位旧需求能验收。', ''
  ].join('\n'), 'utf8');
  const legacyProductBoot = await realTeamTools.bootRole(legacyName, 'product');
  const legacyReview = await realTeamTools.reviewRequirement({
    projectName: legacyName, projectPath: legacyPath, role: 'product', requirementId: legacyReviewId,
    verdict: 'approve', comment: '旧号正文评审通过'
  });
  const legacyOwner = await realTeamTools.ownerRequirementDecision({
    projectName: legacyName, projectPath: legacyPath, role: 'owner', requirementId: legacyReviewId,
    decision: 'approved', opinion: '旧号正文 Owner 通过', ownerConfirmed: true
  });
  const legacySnapshot = realTeamTools.readWorkflowSnapshot(legacyName, legacyPath);
  const legacyRow = legacySnapshot.ok ? legacySnapshot.requirements.find((row) => row.id === legacyReviewId) : null;
  expect('4 位旧需求只有正文时可评审/Owner',
    legacyProductBoot.ok === true && legacyReview.ok === true && legacyOwner.ok === true
    && legacyRow && legacyRow.status === 'ready', { boot: legacyProductBoot.code, review: legacyReview.code, owner: legacyOwner.code, row: legacyRow && legacyRow.status });
  expect('4 位旧需求评审/Owner 各只写一次',
    legacyRow && (legacyRow.history || []).filter((row) => row.action === 'product_review').length === 1
    && (legacyRow.history || []).filter((row) => row.action === 'owner_review').length === 1,
    legacyRow && legacyRow.history);
  // 验收前置：真实 team.mjs owner --action accept 会校验产品评审与 Owner 决定。
  // 4 位旧需求不能绕过同一条业务闸门；补齐评审/Owner 后仍只靠正文 + 测试 done 验收。
  const legacyAcceptProductBoot = await realTeamTools.bootRole(legacyName, 'product');
  const legacyAcceptReview = await realTeamTools.reviewRequirement({
    projectName: legacyName, projectPath: legacyPath, role: 'product', requirementId: legacyAcceptId,
    verdict: 'approve', comment: '旧号验收需求评审通过'
  });
  const legacyAcceptOwner = await realTeamTools.ownerRequirementDecision({
    projectName: legacyName, projectPath: legacyPath, role: 'owner', requirementId: legacyAcceptId,
    decision: 'skipped', opinion: '旧号验收 Owner 跳过', ownerConfirmed: true
  });
  expect('4 位旧需求验收前可评审/Owner',
    legacyAcceptProductBoot.ok === true && legacyAcceptReview.ok === true && legacyAcceptOwner.ok === true,
    { boot: legacyAcceptProductBoot.code, review: legacyAcceptReview.code, owner: legacyAcceptOwner.code });
  // 验收：正文需求 + 评审/Owner + 已完成测试任务；测试任务运行行由本测试补。
  const legacyPmToken = await realTeamTools.bootToken(legacyName, 'pm', { force: true });
  const legacyTestTask = legacyPmToken.ok ? await realTeamTools._runNode(realTeamTools.layout.teamTool, [
    'task', 'create', '--boot', legacyPmToken.token,
    '--title', '旧号验收测试', '--priority', 'P2', '--owner', 'tester',
    '--requirement', legacyAcceptId, '--type', 'task', '--acceptance', '旧号验收测试通过', '--json'
  ], { timeoutMs: 60000 }) : { ok: false };
  const legacyTestTaskId = legacyTestTask.ok && legacyTestTask.value && legacyTestTask.value.task
    ? String(legacyTestTask.value.task.id) : '';
  // 自测数据：把测试任务挂到需求行，走真实 doneWorkflowTask 同步 test_done 与需求正文。
  const legacyAcceptWorkflow = realTeamTools.readWorkflowState(legacyName);
  const legacyAcceptWorkflowRow = legacyAcceptWorkflow.ok && legacyAcceptWorkflow.state.requirements
    ? legacyAcceptWorkflow.state.requirements[legacyAcceptId] : null;
  if (legacyAcceptWorkflowRow && legacyTestTaskId) {
    legacyAcceptWorkflowRow.test = {
      taskId: legacyTestTaskId, by: 'pm', at: new Date().toISOString(),
      claimBy: 'tester', claimedAt: null, doneAt: null, evidence: ''
    };
    legacyAcceptWorkflowRow.status = 'test';
    legacyAcceptWorkflow.state.phase = 'test';
    realTeamTools.writeWorkflowState(legacyName, legacyAcceptWorkflow.state);
  }
  const legacyTesterBoot = await realTeamTools.bootRole(legacyName, 'tester');
  const legacyTestDone = legacyTestTaskId && legacyTesterBoot.ok
    ? await realTeamTools.doneWorkflowTask({
      projectName: legacyName, projectPath: legacyPath, role: 'tester',
      taskId: legacyTestTaskId, evidence: 'PASS 旧号验收测试'
    })
    : { ok: false, code: 'TEST_TASK_NOT_DONE' };
  // 测试 done 会重写需求正文；Owner 验收前 tester 必须按现有闸门重新 boot。
  const legacyTesterReboot = legacyTestDone.ok ? await realTeamTools.bootRole(legacyName, 'tester') : { ok: false };
  const legacyAccept = legacyTestDone.ok && legacyTesterReboot.ok ? await realTeamTools.ownerAccept({
    projectName: legacyName, projectPath: legacyPath, role: 'owner', requirementId: legacyAcceptId,
    decision: 'accepted', opinion: '旧号正文验收通过', ownerConfirmed: true
  }) : { ok: false, code: legacyTestDone.code || 'TESTER_REBOOT_REQUIRED' };
  expect('4 位旧需求正文 + 评审/Owner + 测试 done 后可验收',
    legacyAccept.ok === true && legacyAccept.requirement && legacyAccept.requirement.status === 'accepted',
    { task: legacyTestTaskId, review: legacyAcceptReview.code, owner: legacyAcceptOwner.code, done: legacyTestDone.code, reboot: legacyTesterReboot.code, accept: legacyAccept.code });
  const legacyIndex = readJsonFile(path.join(legacyPath, '项目索引.json')) || {};
  const legacyIndexRows = Array.isArray(legacyIndex.requirements) ? legacyIndex.requirements : [];
  expect('旧号项目索引只登记正文需求',
    legacyIndexRows.length === 2
    && legacyIndexRows.every((row) => !String(row.target || '').includes('/评审/') && !String(row.target || '').includes('/验收/')),
    legacyIndexRows);
  const legacyAcceptDoc = (() => {
    try { return fs.readFileSync(path.join(legacyPath, '需求', legacyAcceptId + '-旧号验收.md'), 'utf8'); } catch { return ''; }
  })();
  expect('旧号验收正文状态记录去重',
    (legacyAcceptDoc.match(/^##\s+状态记录/gm) || []).length === 1
    && (legacyAcceptDoc.match(/^-\s+\S+\s+accepted\s*[：:]/gm) || []).length === 1,
    legacyAcceptDoc.slice(-400));

  // 迭代 / 终止：真实 workflow 命令；失败不能一律 LEGACY，命令自己的业务码必须透出。
  await boot('pm');
  const iterate = await realTeamTools.iterateWorkflow({
    projectName: teamName, projectPath, role: 'pm', opinion: '真实命令进入下一轮'
  });
  expect('真实 workflow iterate 正向调用', iterate.ok === true
    && iterate.driver === 'team.mjs workflow' && Number(iterate.round) === 2
    && iterate.legacy && argvIncludes(iterate.legacy.argv, ['workflow', 'iterate', '--boot', '<boot>', '--project', teamName])
    && argvIncludes(iterate.legacy.argv, ['--opinion', '真实命令进入下一轮']), iterate);
  const iterateAudit = auditCounts(requirementId);
  expect('迭代 event 只写一次', iterateAudit.iterateEvents === 1, iterateAudit);

  await boot('pm');
  const terminate = await realTeamTools.terminateWorkflow({
    projectName: teamName, projectPath, role: 'pm', opinion: '真实命令终止'
  });
  expect('真实 workflow terminate 正向调用', terminate.ok === true
    && terminate.snapshot && terminate.snapshot.phase === 'terminated'
    && Array.isArray(terminate.closedTasks)
    && terminate.legacy && argvIncludes(terminate.legacy.argv, ['workflow', 'terminate', '--boot', '<boot>', '--project', teamName]), terminate);
  const terminateAudit = auditCounts(requirementId);
  expect('终止 event 只写一次', terminateAudit.terminateEvents === 1, terminateAudit);

  await boot('pm');
  const terminateAgain = await realTeamTools.terminateWorkflow({
    projectName: teamName, projectPath, role: 'pm', opinion: '重复终止'
  });
  // 真实 team.mjs workflow 已是可执行命令：重复 terminate 是幂等成功（phase 仍 terminated），
  // 不再固定报 WORKFLOW_TERMINATED；只有壳层收口路径才会返回该业务码。两种都必须证明
  // 业务状态仍是 terminated，且绝不能退回 LEGACY_PROTOCOL_REQUIRED。
  const terminateAgainReal = terminateAgain.ok === true
    && terminateAgain.snapshot && terminateAgain.snapshot.phase === 'terminated'
    && terminateAgain.code === 'OK';
  const terminateAgainShell = terminateAgain.ok === false
    && terminateAgain.code === 'WORKFLOW_TERMINATED';
  expect('终止后重复终止：真实命令幂等成功或壳层返回 WORKFLOW_TERMINATED（都不是 LEGACY）',
    terminateAgain.code !== 'LEGACY_PROTOCOL_REQUIRED'
    && (terminateAgainReal || terminateAgainShell), terminateAgain);

  await boot('pm');
  const iterateAfterTerminate = await realTeamTools.iterateWorkflow({
    projectName: teamName, projectPath, role: 'pm', opinion: '终止后迭代'
  });
  expect('终止后迭代返回 WORKFLOW_TERMINATED 而非 LEGACY', iterateAfterTerminate.ok === false
    && iterateAfterTerminate.code === 'WORKFLOW_TERMINATED', iterateAfterTerminate);

  report.project = teamName;
  report.requirementId = requirementId;
  report.review = { driver: review.driver, argv: review.legacy && review.legacy.argv };
  report.owner = { driver: owner.driver, argv: owner.legacy && owner.legacy.argv };
  report.accept = acceptReport;
  report.iterate = { round: iterate.round, argv: iterate.legacy && iterate.legacy.argv };
  report.terminate = {
    phase: terminate.snapshot && terminate.snapshot.phase,
    closedTasks: terminate.closedTasks,
    argv: terminate.legacy && terminate.legacy.argv
  };
  report.failureCodes = { terminateAgain: terminateAgain.code, iterateAfterTerminate: iterateAfterTerminate.code };
  return report;
}

/**
 * 新项目默认写入可用的项目信息/铁律，避免“建完项目第一次 boot 就被模板拦住”。
 * 已有非模板内容不覆盖，PM 后续仍可在项目目录里改写。
 */
function seedProjectDocs(projectPath, teamName, description = '') {
  const infoPath = path.join(projectPath, '项目信息.md');
  const ironPath = path.join(projectPath, '项目铁律.md');
  const placeholder = /[（(]\s*待[^）)\n]{0,24}(?:填|补|完善|补充|确认|定)[^）)\n]*[）)]|待填写|待补|待完善|待补充|TODO|TBD|FIXME/i;
  let info = '';
  try { info = fs.readFileSync(infoPath, 'utf8'); } catch { /* new */ }
  if (!info.trim() || placeholder.test(info)) {
    fs.writeFileSync(infoPath, [
      `# ${teamName} · 项目信息`, '',
      '## 一、目标', '', description || `完成「${teamName}」的可交付 MVP。`, '',
      '## 二、场景', '', '按六角色流程：需求 → 产品评审 → Owner 决定 → PM 派单 → 开发互审 → 测试 → Owner 验收。', '',
      '## 三、交付', '', '- 代码目录：site/', '- 文档：各角色目录', '- 需求：需求/R-*.md', '',
      '## 四、边界', '', '只改本项目目录；出界先申请授权；没有回执 = 没发生。', ''
    ].join('\n'), 'utf8');
  }
  let iron = '';
  try { iron = fs.readFileSync(ironPath, 'utf8'); } catch { /* new */ }
  const globalIron = path.join(ROOT, '团队', '项目铁律.md');
  let globalText = '';
  try { globalText = fs.readFileSync(globalIron, 'utf8'); } catch { /* ignore */ }
  if (!iron.trim() || placeholder.test(iron) || (globalText && iron === globalText)) {
    fs.writeFileSync(ironPath, [
      `# ${teamName} · 项目铁律`, '',
      '1. 只改本项目目录，出界先申请授权。', '2. 不动 DSH_HOME、profiles、插件、外壳。', '3. 不重启 DSH；底层改动必须全员签字。',
      '4. 没有回执 = 没发生；没有签字 = 没批准。', '5. 迭代前必须先把本轮需求验收或终止。', ''
    ].join('\n'), 'utf8');
  }
}

/**
 * 自测沙盘：项目信息必须写成真实正文。
 * boot 现在会拒绝“待填写/待补”模板，测试不能靠默认模板过闸。
 */
function seedSelftestProjectDocs(projectPath, teamName) {
  const info = [
    `# ${teamName} · 项目信息`,
    '',
    '## 一、目标',
    '',
    '验证六角色工作流闭环（D 盘 mock 沙盘，不启动真实 DSH 会话）。',
    '',
    '## 二、场景',
    '',
    '建项目 → 六角色 boot → 需求 → 产品评审 → Owner 决定 → 派单 → 开发互审 → 测试 → 验收 → 迭代/终止。',
    '',
    '## 三、交付',
    '',
    '- 代码目录：site/',
    '- 文档：各角色目录',
    '',
    '## 四、边界',
    '',
    '只写 D 盘自测沙盘，不修改真实项目与旧仓库。',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(projectPath, '项目信息.md'), info, 'utf8');
  // 旧 team.mjs 会拒绝“项目铁律 = 团队默认铁律”；自测必须写成本项目自己的铁律。
  fs.writeFileSync(path.join(projectPath, '项目铁律.md'), [
    `# ${teamName} · 项目铁律`,
    '',
    '1. 只改本项目的 D 盘自测沙盘，出界先申请授权。',
    '2. 不改真实项目、旧仓库、DSH profile 或插件配置。',
    '3. 没有回执 = 没发生；没有签字 = 没批准。',
    '4. 迭代前必须先把本轮需求验收或终止。',
    ''
  ].join('\n'), 'utf8');
  return info;
}

async function selftestRound10(win, testRoot, mock) {
  const failures = [];
  const expect = (name, condition, detail) => {
    if (!condition) failures.push(name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  };
  const argvIncludes = (argv, expected) => {
    const list = Array.isArray(argv) ? argv.map(String) : [];
    const target = Array.isArray(expected) ? expected.map(String) : [];
    if (!target.length || target.length > list.length) return false;
    for (let i = 0; i <= list.length - target.length; i += 1) {
      if (target.every((value, offset) => list[i + offset] === value)) return true;
    }
    return false;
  };
  const js = (value) => JSON.stringify(value);
  const evaluate = async (label, body) => {
    try {
      const raw = await win.webContents.executeJavaScript(`(async()=>{${body}})()`);
      return raw === undefined ? {} : JSON.parse(raw);
    } catch (error) {
      failures.push(label + ' 执行失败：' + String((error && error.message) || error).slice(0, 500));
      return {};
    }
  };
  const report = {};
  // 当前真实旧工具已经实现 req review / owner / workflow；后半段先用注入桩验证
  // “命令存在时全流程可走”，再用真实 team.mjs 做正向断言（见第 6 段）。
  const realTeamTools = teamTools;
  const protocolMock = createWorkflowProtocolMock(realTeamTools);
  teamTools = realTeamTools.create({ teamRoot: realTeamTools.layout.root, legacyMock: protocolMock });
  const teamRoot = teamTools.layout.root;
  // 旧项目 4 位需求号：真实仓库里的 微光作品集 是只读回归样本。
  const legacyProofProject = path.join(ROOT, '项目', '微光作品集');
  if (fs.existsSync(legacyProofProject)) {
    const legacyDocs = realTeamTools.readRequirementDocs(legacyProofProject);
    expect('旧项目 4 位需求号可读（含正文/状态）', legacyDocs.count === 2
      && legacyDocs.list.every((row) => /^R-\d{8}-\d{4}$/.test(row.id))
      && legacyDocs.list.every((row) => row.title && row.status === 'accepted'),
    legacyDocs.list.map((row) => ({ id: row.id, title: row.title, status: row.status })));
  }
  const readJsonFile = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
  };
  const readTextFile = (file) => {
    try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
  };
  const listJson = (dir) => {
    try { return fs.readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { return []; }
  };
  const promptBefore = mock.counters.sessionPrompt;
  try {
    // 1) 项目创建：六角色目录 + 项目信息/铁律/协作准则/项目索引/项目索引.json。
    // 新语义：项目创建就要自动写实项目信息/铁律，不再靠 placeholderDocs 先造模板再补。
    const setup = await evaluate('创建第十轮项目', `
      const created = await window.workbench.createProject({ name: '第十轮闭环', root: ${js(testRoot)} });
      const s = await window.workbench.state();
      const p = s.projects.find((x) => x.id === created.project.id);
      return JSON.stringify({
        projectId: created.project.id,
        path: created.project.path,
        teamName: p.teamName || created.project.name,
        structureOk: Boolean(created.structure && created.structure.ok),
        structure: created.structure || null,
        teamOk: Boolean(created.team && created.team.ok)
      });
    `);
    expect('第十轮项目创建成功并 ensure 团队', Boolean(setup.projectId) && setup.teamOk === true, setup);
    expect('项目创建返回六角色目录/文档结构', setup.structureOk === true
      && setup.structure && Array.isArray(setup.structure.missing) && setup.structure.missing.length === 0, setup.structure);
    const projectId = setup.projectId;
    const projectPath = setup.path;
    const teamName = setup.teamName;
    if (!projectId || !projectPath || !teamName) return { report, failures };
    const roleDirs = Object.values(teamTools.ROLE_DIRS);
    const dirChecks = roleDirs.map((dir) => ({ dir, exists: fs.existsSync(path.join(projectPath, dir)) }));
    expect('六角色目录齐全', dirChecks.every((row) => row.exists), dirChecks);
    const docFiles = ['项目信息.md', '项目铁律.md', '协作准则.md', '项目索引.md', '项目索引.json'];
    const docChecks = docFiles.map((file) => ({ file, exists: fs.existsSync(path.join(projectPath, file)) }));
    expect('项目信息/铁律/索引齐全', docChecks.every((row) => row.exists), docChecks);
    const stateDir = path.join(teamTools.layout.projectsDir, teamTools.teamSlug(teamName, 60));
    expect('旧团队项目状态目录存在', fs.existsSync(path.join(stateDir, '项目.json'))
      && fs.existsSync(path.join(stateDir, '任务')) && fs.existsSync(path.join(stateDir, '提案')), stateDir);
    expect('没有另造 workflow.json', !fs.existsSync(path.join(projectPath, 'workflow.json')));
    // 1.1) 新项目还没有需求/工作流文件时，workflow:state 也必须返回真实 team.mjs 能力；
    //     否则界面会把“能力未知”当成“命令缺失”，建需求/全队 boot 全部禁用。
    const newProjectState = await evaluate('新项目 workflow:state 真实能力', `
      const r = await window.workbench.workflowState({ projectId: ${js(projectId)} });
      return JSON.stringify({
        ok: r.ok, truthSource: r.truthSource, legacy: r.legacy,
        phase: r.phase, requirements: r.requirements, workflow: r.workflow
      });
    `);
    expect('新项目无需求也返回真实 team.mjs 能力', newProjectState.ok === true
      && newProjectState.legacy && newProjectState.legacy.capabilities
      && newProjectState.legacy.capabilities.available === true
      && newProjectState.legacy.capabilities.reqReview === true
      && Array.isArray(newProjectState.legacy.capabilities.missing)
      && newProjectState.legacy.capabilities.missing.length === 0, newProjectState);
    expect('新项目 local-fallback 不再写 legacy:null', newProjectState.legacy !== null
      && newProjectState.legacy.fallback === true, newProjectState.legacy);
    // 1.2) 新项目开箱即用：项目信息/铁律由 workspace + 壳自动写实，
    //      首次 boot 不能再被 PLACEHOLDER_DOC / PROJECT_IRON_TEMPLATE 拒绝。
    const firstBoot = await evaluate('新项目首次 boot', `
      const r = await window.workbench.workflowBoot({ projectId: ${js(projectId)}, role: 'pm' });
      return JSON.stringify({
        ok: Boolean(r.ok), code: r.code || '', message: r.message || '',
        placeholders: r.placeholders || null,
        complete: Boolean(r.bootRead && r.bootRead.complete)
      });
    `);
    const readyInfo = fs.readFileSync(path.join(projectPath, '项目信息.md'), 'utf8');
    const readyIron = fs.readFileSync(path.join(projectPath, '项目铁律.md'), 'utf8');
    expect('新项目首次 boot 不被 PLACEHOLDER_DOC/PROJECT_IRON_TEMPLATE 拒绝',
      firstBoot.ok === true && firstBoot.code !== 'PLACEHOLDER_DOC' && firstBoot.code !== 'PROJECT_IRON_TEMPLATE'
      && firstBoot.complete === true
      && !/（待[^）]*）|待填写|待补|TODO|TBD/i.test(readyInfo)
      && !/（待[^）]*）|待填写|待补|TODO|TBD/i.test(readyIron),
      { boot: firstBoot, info: readyInfo.slice(0, 160), iron: readyIron.slice(0, 160) });
    // 负例仍保留：手工把项目信息写回模板后，boot 必须明确拒绝。
    const infoFile = path.join(projectPath, '项目信息.md');
    fs.writeFileSync(infoFile, '# 模板项目 · 项目信息\n\n## 一、目标\n\n（待项目经理填写）\n', 'utf8');
    const placeholderBoot = await evaluate('占位项目信息 boot 拒绝', `
      const r = await window.workbench.workflowBoot({ projectId: ${js(projectId)}, role: 'pm' });
      return JSON.stringify({
        ok: Boolean(r.ok), code: r.code || '', message: r.message || '',
        placeholders: r.placeholders || null
      });
    `);
    expect('项目信息仍是模板时 boot 被拒绝', placeholderBoot.ok === false
      && placeholderBoot.code === 'PLACEHOLDER_DOC'
      && Array.isArray(placeholderBoot.placeholders) && placeholderBoot.placeholders.length > 0
      && /待[^）]{0,30}(?:填写|补)/.test(String(placeholderBoot.message || '')), placeholderBoot);
    // 生产路径的兜底：模板被写回后，seedProjectDocs 必须能补成可 boot 的正文。
    seedProjectDocs(projectPath, teamName, '回归目标：验证新项目自动写入可 boot 的项目信息/铁律');
    const seededInfo = fs.readFileSync(infoFile, 'utf8');
    const seededBoot = await evaluate('自动补文档后首次 boot', `
      const r = await window.workbench.workflowBoot({ projectId: ${js(projectId)}, role: 'pm' });
      return JSON.stringify({ ok: Boolean(r.ok), code: r.code || '', complete: Boolean(r.bootRead && r.bootRead.complete) });
    `);
    expect('seedProjectDocs 补齐后首次 boot 通过', seededBoot.ok === true && seededBoot.complete === true
      && !/（待[^）]*）|待填写|待补|TODO|TBD/i.test(seededInfo), seededBoot);
    // 项目恢复/显式 ensure 也要能补齐：删掉铁律、一个角色目录和两份索引，ensure 必须重建。
    fs.rmSync(path.join(projectPath, '项目铁律.md'), { force: true });
    fs.rmSync(path.join(projectPath, teamTools.ROLE_DIRS.tester), { recursive: true, force: true });
    fs.rmSync(path.join(projectPath, '项目索引.md'), { force: true });
    fs.rmSync(path.join(projectPath, '项目索引.json'), { force: true });
    const repaired = await evaluate('恢复 ensure 补齐', `
      const r = await window.workbench.teamEnsureProject({ projectId: ${js(projectId)} });
      return JSON.stringify({
        ok: r.ok, ensured: r.ensured, structureOk: r.structureOk,
        missing: r.structure ? r.structure.missing : null,
        repaired: r.structure ? r.structure.repaired : null
      });
    `);
    expect('恢复/ensure 补齐六角色目录与文档索引', repaired.ok === true && repaired.ensured === true
      && repaired.structureOk === true && Array.isArray(repaired.missing) && repaired.missing.length === 0
      && fs.existsSync(path.join(projectPath, '项目铁律.md'))
      && fs.existsSync(path.join(projectPath, teamTools.ROLE_DIRS.tester))
      && fs.existsSync(path.join(projectPath, '项目索引.md'))
      && fs.existsSync(path.join(projectPath, '项目索引.json')), repaired);
    report.structure = { dirs: dirChecks, docs: docChecks, stateDir, repair: repaired };
    // 六角色 boot 前写真实项目信息；默认模板已被上一条负例证明会拦下 boot。
    seedSelftestProjectDocs(projectPath, teamName);
    expect('自测项目信息已写真实正文', !/（待[^）]*）|待填写|待补/.test(
      fs.readFileSync(path.join(projectPath, '项目信息.md'), 'utf8')), path.join(projectPath, '项目信息.md'));

    // 1.5) 创建顺序/回滚：DSH 登记失败必须回滚目录、本地记录和本次旧团队登记，
    //      不能返回 ok:true 的半成品（旧行为是记 pending 继续）。
    const savedDshForRollback = dsh;
    const rollbackName = '第十轮回滚';
    const rollbackPath = path.join(testRoot, rollbackName);
    const rollbackTeamDir = path.join(teamTools.layout.projectsDir, teamTools.teamSlug(rollbackName, 60));
    let rollbackError = null;
    dsh = new DshAdapter('http://127.0.0.1:9');
    try {
      await createProject({ name: rollbackName, root: testRoot });
    } catch (error) {
      rollbackError = error;
    } finally {
      dsh = savedDshForRollback;
    }
    expect('DSH 登记失败时项目创建明确失败', Boolean(rollbackError)
      && /DSH|WORKSPACE/i.test(String(rollbackError.code || rollbackError.message || '')), rollbackError && { code: rollbackError.code, message: rollbackError.message });
    expect('DSH 登记失败回滚项目目录', !fs.existsSync(rollbackPath), rollbackPath);
    expect('DSH 登记失败回滚本地记录', !readStore().projects.some((project) => project.name === rollbackName), readStore().projects.map((project) => project.name));
    expect('DSH 登记失败回滚旧团队登记', !fs.existsSync(rollbackTeamDir), rollbackTeamDir);
    expect('创建失败标记 rolledBack', Boolean(rollbackError && rollbackError.rolledBack === true), rollbackError && rollbackError.rollback);
    report.createRollback = { path: rollbackPath, teamDir: rollbackTeamDir, code: rollbackError && rollbackError.code };

    // 1.6) 本地任务只允许镜像，不能反写旧 任务/；旧任务是唯一业务状态。
    const oldTaskFilesBefore = listJson(path.join(stateDir, '任务')).length;
    const localTask = await evaluate('本地任务只写镜像', `
      const r = await window.workbench.createTask({ projectId: ${js(projectId)}, title: '本地镜像任务', role: 'analyst', priority: 'P3' });
      const s = await window.workbench.state();
      const p = s.projects.find((x) => x.id === ${js(projectId)});
      return JSON.stringify({ ok: Boolean(r.ok), taskId: r.task && r.task.id, localHas: (p.tasks || []).some((t) => t.id === (r.task && r.task.id)) });
    `);
    const oldTaskFilesAfter = listJson(path.join(stateDir, '任务')).length;
    expect('本地任务不反写旧 任务/ 目录', localTask.ok === true && localTask.localHas === true
      && oldTaskFilesAfter === oldTaskFilesBefore, { before: oldTaskFilesBefore, after: oldTaskFilesAfter, localTask });
    if (localTask.taskId) {
      await evaluate('删除本地镜像任务', `
        const r = await window.workbench.deleteTask({ projectId: ${js(projectId)}, taskId: ${js(localTask.taskId)} });
        return JSON.stringify({ ok: Boolean(r.ok) });
      `);
    }

    // 2) 六角色每轮 boot：必读铁律/项目信息/角色卡/项目索引，暴露 bootRead/briefing。
    const boot = await evaluate('六角色 boot', `
      const roles = ['pm','product','analyst','programmer1','programmer2','tester'];
      const out = [];
      for (const role of roles) {
        const r = await window.workbench.workflowBoot({ projectId: ${js(projectId)}, role });
        out.push({
          role,
          ok: Boolean(r.ok),
          code: r.code || '',
          complete: Boolean(r.bootRead && r.bootRead.complete),
          missing: (r.bootRead && r.bootRead.missing) || [],
          docs: r.bootRead ? Object.keys(r.bootRead.docs || {}) : [],
          hashChecks: r.bootRead ? r.bootRead.hashChecks : null,
          legacyTokenFound: Boolean(r.bootRead && r.bootRead.legacyTokenFound),
          briefing: String(r.briefing || ''),
          workflowFile: r.workflowFile || r.workflowWrite && r.workflowWrite.file || ''
        });
      }
      return JSON.stringify(out);
    `);
    expect('六角色 boot 全部成功', Array.isArray(boot) && boot.length === 6 && boot.every((row) => row.ok), boot);
    expect('每个角色 bootRead 完整', Array.isArray(boot) && boot.every((row) => row.complete
      && row.missing.length === 0
      && ['iron', 'projectInfo', 'roleCard', 'projectIndex'].every((key) => row.docs.includes(key))), boot);
    expect('boot 读到旧角色卡并命中令牌哈希', Array.isArray(boot) && boot.every((row) => row.hashChecks
      && row.hashChecks.roleCard === true && row.hashChecks.iron === true && row.hashChecks.projectIndex === true), boot);
    expect('boot 简报包含项目和角色', Array.isArray(boot) && boot.every((row) => row.briefing.includes(teamName) && row.briefing.includes(row.role)), boot.map((row) => row.briefing.slice(0, 80)));
    const briefing = await evaluate('boot 简报状态', `
      const r = await window.workbench.workflowBriefing({ projectId: ${js(projectId)} });
      return JSON.stringify({ ok: r.ok, allBooted: r.allBooted, allComplete: r.allComplete, roles: r.roles });
    `);
    expect('workflowBriefing 暴露六角色 boot 状态', briefing.ok === true && briefing.allBooted === true
      && briefing.allComplete === true && Object.keys(briefing.roles || {}).length === 6, briefing);
    const workflowFile = path.join(stateDir, '工作流.json');
    const bootState = readJsonFile(workflowFile);
    expect('boot 状态写旧 工作流.json', Boolean(bootState && bootState.schema === 2
      && bootState.boots && Object.keys(bootState.boots).length === 6), bootState && { schema: bootState.schema, boots: Object.keys(bootState.boots || {}).length });
    report.boot = { count: boot.length, briefingAll: briefing.allComplete, workflowFile };

    // 3) 需求：产品/分析师创建 → 产品评审 → Owner 跳过 → PM 才能派单。
    const req = await evaluate('分析师建需求', `
      const r = await window.workbench.requirementCreate({
        projectId: ${js(projectId)}, role: 'analyst',
        title: '第十轮需求：旧工作流闭环', priority: 'P1',
        acceptance: '需求/任务/提案/验收都写旧团队状态目录', story: '作为 Owner，我要看到旧状态为唯一真相'
      });
      return JSON.stringify({ ok: r.ok, code: r.code || '', requirement: r.requirement, docFile: r.docFile || '', workflowFile: r.workflowFile || '' });
    `);
    expect('需求分析师用旧 req create 建需求', req.ok === true && req.requirement && /^R-/.test(String(req.requirement.id)), req);
    const requirementId = req.requirement ? String(req.requirement.id) : '';
    expect('需求正文写入旧 需求/ 目录', Boolean(requirementId) && fs.existsSync(req.docFile), req.docFile);
    expect('需求任务写入旧 任务/ 目录', Boolean(requirementId) && fs.existsSync(path.join(stateDir, '任务', requirementId + '.json')), requirementId);
    const requirementDocFile = String(req.docFile || '');
    const overviewFile = path.join(projectPath, '需求', '00-需求总览.md');
    const requirementTaskFile = path.join(stateDir, '任务', requirementId + '.json');
    const statusSyncEvidence = [];
    // 状态同步会改需求正文/总览，旧 boot 的阅读证据按现有闸门作废；
    // 下一步动作前必须由该角色重新 boot 读取新状态（不绕过闸门）。
    const bootRoleForGate = async (label, role) => {
      const r = await evaluate(`${label}：${role} 重新 boot`, `
        const r = await window.workbench.workflowBoot({ projectId: ${js(projectId)}, role: ${js(role)} });
        return JSON.stringify({ ok: Boolean(r.ok), code: r.code || '', complete: Boolean(r.bootRead && r.bootRead.complete) });
      `);
      expect(`${label}：${role} 重新 boot 读齐`, r.ok === true && r.complete === true, r);
      return r;
    };
    const expectRequirementStatus = (label, expected) => {
      const docText = readTextFile(requirementDocFile);
      const overviewText = readTextFile(overviewFile);
      const overviewLine = overviewText.split(/\r?\n/).find((line) => line.includes(`| ${requirementId} |`)) || '';
      const reqTask = readJsonFile(requirementTaskFile);
      expect(`${label}：需求正文状态=${expected}`,
        new RegExp('^- 状态：' + expected + '$', 'm').test(docText),
        { file: requirementDocFile, statusLine: (docText.match(/^- 状态：.*$/m) || [''])[0] });
      expect(`${label}：需求总览状态=${expected}`, overviewLine.includes(`| ${expected} |`), overviewLine);
      expect(`${label}：需求任务 workflow.requirementStatus=${expected}`,
        Boolean(reqTask && reqTask.workflow && reqTask.workflow.requirementStatus === expected),
        reqTask && reqTask.workflow);
      statusSyncEvidence.push({
        label,
        expected,
        docStatusLine: (docText.match(/^- 状态：.*$/m) || [''])[0],
        overviewMatched: overviewLine.includes(`| ${expected} |`),
        requirementTaskStatus: reqTask && reqTask.workflow ? reqTask.workflow.requirementStatus : null
      });
    };
    // 需求评审只允许 product；main 进程不能把“没传 role”默认成 product，PM 也不能自审。
    const pmSelfReview = await evaluate('PM 自审 / 缺省角色评审拒绝', `
      const r = await window.workbench.requirementReview({
        projectId: ${js(projectId)}, requirementId: ${js(requirementId)},
        verdict: 'approve', comment: 'PM 不能自审'
      });
      return JSON.stringify({ ok: r.ok, code: r.code || '', message: r.message || '' });
    `);
    expect('PM / 缺省角色不能自审需求', pmSelfReview.ok === false
      && pmSelfReview.code === 'ROLE_NOT_ALLOWED', pmSelfReview);
    const reviewBeforeRead = await evaluate('未重读就产品评审', `
      const r = await window.workbench.requirementReview({ projectId: ${js(projectId)}, role: 'product', requirementId: ${js(requirementId)}, verdict: 'approve', comment: '未重读' });
      return JSON.stringify({ ok: r.ok, code: r.code || '', message: r.message || '' });
    `);
    expect('需求创建后产品未重新 boot 就评审被拒绝', reviewBeforeRead.ok === false
      && ['RULES_CHANGED', 'BOOT_REQUIRED'].includes(reviewBeforeRead.code), reviewBeforeRead);
    // 2.5) boot 闸门：需求正文/索引/需求总览变化后，上一轮 boot 的阅读证据作废；
    //      没重新读需求的角色不允许评审/派单/开发/测试/验收。
    const staleGate = await evaluate('需求创建后未重读就派单', `
      const r = await window.workbench.requirementDispatch({ projectId: ${js(projectId)}, role: 'pm', requirementId: ${js(requirementId)}, owner: 'programmer1' });
      return JSON.stringify({ ok: r.ok, code: r.code || '', message: r.message || '' });
    `);
    expect('需求创建后旧 boot 失效，未重读禁止派单', staleGate.ok === false
      && ['RULES_CHANGED', 'BOOT_REQUIRED'].includes(staleGate.code), staleGate);
    const reboots = await evaluate('需求后重新 boot', `
      const roles = ['pm','product','analyst','programmer1','programmer2','tester'];
      const out = [];
      for (const role of roles) {
        const r = await window.workbench.workflowBoot({ projectId: ${js(projectId)}, role });
        out.push({ role, ok: Boolean(r.ok), code: r.code || '', complete: Boolean(r.bootRead && r.bootRead.complete) });
      }
      return JSON.stringify(out);
    `);
    expect('需求创建后六角色重新 boot 读齐需求', Array.isArray(reboots) && reboots.length === 6
      && reboots.every((row) => row.ok && row.complete), reboots);
    const earlyDispatch = await evaluate('未评审先派单', `
      const r = await window.workbench.requirementDispatch({ projectId: ${js(projectId)}, role: 'pm', requirementId: ${js(requirementId)}, owner: 'programmer1' });
      return JSON.stringify({ ok: r.ok, code: r.code || '', message: r.message || '' });
    `);
    expect('未评审时 PM 派单被拒绝', earlyDispatch.ok === false && earlyDispatch.code === 'REQUIREMENT_NOT_APPROVED', earlyDispatch);
    const review = await evaluate('产品评审需求', `
      const r = await window.workbench.requirementReview({ projectId: ${js(projectId)}, role: 'product', requirementId: ${js(requirementId)}, verdict: 'approve', comment: '产品评审通过：验收标准可测' });
      return JSON.stringify({
        ok: r.ok, code: r.code || '', requirement: r.requirement, driver: r.driver, legacy: r.legacy,
        ownerReview: r.requirement ? r.requirement.ownerReview : null
      });
    `);
    expect('产品评审通过', review.ok === true && review.requirement && review.requirement.status === 'approved', review);
    expect('产品评审真的调用旧 req review 命令', review.driver === 'team.mjs req review'
      && review.legacy && review.legacy.command === 'req review' && review.legacy.commandAvailable === true, review.legacy);
    expect('产品评审通过后 Owner pending 不写 by/actor', Boolean(review.ownerReview)
      && review.ownerReview.status === 'pending'
      && !review.ownerReview.by && !review.ownerReview.actor, review.ownerReview);
    const afterReviewWorkflow = readJsonFile(path.join(stateDir, '工作流.json'));
    expect('工作流里的 Owner pending 也没有 by/actor', Boolean(afterReviewWorkflow
      && afterReviewWorkflow.requirements && afterReviewWorkflow.requirements[requirementId]
      && afterReviewWorkflow.requirements[requirementId].ownerReview)
      && afterReviewWorkflow.requirements[requirementId].ownerReview.status === 'pending'
      && !afterReviewWorkflow.requirements[requirementId].ownerReview.by
      && !afterReviewWorkflow.requirements[requirementId].ownerReview.actor,
    afterReviewWorkflow && afterReviewWorkflow.requirements && afterReviewWorkflow.requirements[requirementId]
      && afterReviewWorkflow.requirements[requirementId].ownerReview);
    const reviewedTask = readJsonFile(path.join(stateDir, '任务', requirementId + '.json'));
    expect('产品评审结果写回旧任务 workflow', Boolean(reviewedTask && reviewedTask.workflow
      && reviewedTask.workflow.productReview && reviewedTask.workflow.productReview.verdict === 'approve'), reviewedTask && reviewedTask.workflow);
    // Owner 确认码已废弃：决定/验收直接以 role=owner 接受，不再要求 challenge/nonce。
    // owner:challenge / owner:confirm 只返回占位值并标记 deprecated；写操作不再校验令牌。
    const deprecatedChallenge = await evaluate('owner:challenge 已废弃', `
      const r = await window.workbench.ownerChallenge({ projectId: ${js(projectId)}, action: 'owner-decision', requirementId: ${js(requirementId)} });
      return JSON.stringify({ ok: r.ok, code: r.code || '', deprecated: r.deprecated === true, nonce: r.nonce });
    `);
    expect('owner:challenge 保留但标记废弃（返回占位 nonce）',
      deprecatedChallenge.ok === true && deprecatedChallenge.deprecated === true
      && deprecatedChallenge.code === 'OWNER_CHALLENGE_DEPRECATED' && deprecatedChallenge.nonce === '000000', deprecatedChallenge);
    const deprecatedConfirm = await evaluate('owner:confirm 已废弃', `
      const r = await window.workbench.ownerConfirm({ challengeId: 'deprecated-x', nonce: '000000' });
      return JSON.stringify({ ok: r.ok, code: r.code || '', deprecated: r.deprecated === true, hasToken: Boolean(r.confirmToken) });
    `);
    expect('owner:confirm 保留但标记废弃（不再校验 nonce）',
      deprecatedConfirm.ok === true && deprecatedConfirm.deprecated === true
      && deprecatedConfirm.code === 'OWNER_CONFIRM_DEPRECATED' && deprecatedConfirm.hasToken === true, deprecatedConfirm);
    const ownerDirect = await evaluate('Owner 免确认码直接决定', `
      const r = await window.workbench.requirementOwner({ projectId: ${js(projectId)}, role: 'owner', requirementId: ${js(requirementId)}, decision: 'skipped', opinion: '确认码已废弃，直接跳过' });
      return JSON.stringify({ ok: r.ok, code: r.code || '', requirement: r.requirement, ownerNote: r.ownerNote, driver: r.driver });
    `);
    expect('Owner 免确认码直接决定成功（不再要求 challenge/nonce）',
      ownerDirect.ok === true && ownerDirect.requirement && ownerDirect.requirement.status === 'ready', ownerDirect);
    expect('Owner 决定真的调用旧 owner 命令', ownerDirect.driver === 'team.mjs owner', ownerDirect);
    expect('Owner 决定审计记 actor:owner / channel:workbench',
      ownerDirect.requirement && ownerDirect.requirement.ownerReview
      && ownerDirect.requirement.ownerReview.actor === 'owner'
      && ownerDirect.requirement.ownerReview.channel === 'workbench'
      && Boolean(ownerDirect.requirement.ownerReview.at), ownerDirect.requirement && ownerDirect.requirement.ownerReview);
    const ownerBogus = await evaluate('Owner 免确认码仍校验需求存在', `
      const r = await window.workbench.requirementOwner({ projectId: ${js(projectId)}, role: 'owner', requirementId: 'R-99999999-9999', decision: 'skipped' });
      return JSON.stringify({ ok: r.ok, code: r.code || '' });
    `);
    expect('Owner 决定不因缺确认码放行不存在需求',
      ownerBogus.ok === false && ownerBogus.code === 'REQUIREMENT_NOT_FOUND', ownerBogus);
    // 5.1) 迭代闸门负例：本轮需求还是 ready（未验收/未终止）时，不能启动下一轮。
    const pmForIterateGuard = await evaluate('迭代闸门 PM boot', `
      const r = await window.workbench.workflowBoot({ projectId: ${js(projectId)}, role: 'pm' });
      return JSON.stringify({ ok: Boolean(r.ok), code: r.code || '' });
    `);
    expect('迭代负例前 PM boot 成功', pmForIterateGuard.ok === true, pmForIterateGuard);
    const blockedIterate = await evaluate('在办需求时迭代拒绝', `
      const r = await window.workbench.workflowIterate({ projectId: ${js(projectId)}, role: 'pm', opinion: '不应启动' });
      return JSON.stringify({ ok: r.ok, code: r.code || '', message: r.message || '' });
    `);
    expect('还有在办需求时迭代被拒绝', blockedIterate.ok === false
      && blockedIterate.code === 'ITERATE_BLOCKED'
      && /未收口/.test(String(blockedIterate.message || '')), blockedIterate);
    const dispatch = await evaluate('PM 派开发任务', `
      const r = await window.workbench.requirementDispatch({ projectId: ${js(projectId)}, role: 'pm', requirementId: ${js(requirementId)}, owner: 'programmer1' });
      return JSON.stringify({ ok: r.ok, code: r.code || '', task: r.task, requirement: r.requirement, notice: r.notice });
    `);
    expect('产品评审+Owner 放行后 PM 才能派单', dispatch.ok === true && dispatch.task && /^T-/.test(String(dispatch.task.id)), dispatch);
    const devTaskId = dispatch.task ? String(dispatch.task.id) : '';
    expect('开发任务带 requirementId 并归程序员A', Boolean(devTaskId) && dispatch.task.requirementId === requirementId
      && dispatch.task.owner === 'programmer1', dispatch.task);
    expectRequirementStatus('派发开发', 'dev');
    await bootRoleForGate('派发开发后', 'programmer1');
    await bootRoleForGate('派发开发后', 'programmer2');
    await bootRoleForGate('派发开发后', 'pm');
    report.requirement = { requirementId, devTaskId, driver: review.driver };

    // 4) 开发 claim → 提案 → 互审 → PM 签字/apply → done → 测试 → Owner 验收。
    const claim = await evaluate('程序员A claim', `
      const r = await window.workbench.taskClaim({ projectId: ${js(projectId)}, role: 'programmer1', taskId: ${js(devTaskId)} });
      return JSON.stringify({ ok: r.ok, code: r.code || '', task: r.task, requirement: r.requirement });
    `);
    expect('开发 claim 走旧 task claim', claim.ok === true && claim.task && claim.task.status === 'working', claim);
    const submit = await evaluate('开发提交提案', `
      const r = await window.workbench.devSubmit({
        projectId: ${js(projectId)}, role: 'programmer1', taskId: ${js(devTaskId)},
        fileRel: 'site/round10.txt', content: 'round10 v1', title: '第十轮开发提案',
        rationale: '验证 propose → show → review → sign → apply', risk: 'normal'
      });
      return JSON.stringify({ ok: r.ok, code: r.code || '', proposal: r.proposal, grant: r.grant, requirement: r.requirement });
    `);
    expect('开发提案走旧 propose', submit.ok === true && submit.proposal && /^P-/.test(String(submit.proposal.id)), submit);
    const proposalId = submit.proposal ? String(submit.proposal.id) : '';
    expect('提案文件绑定哈希', Boolean(proposalId) && Array.isArray(submit.proposal.files)
      && submit.proposal.files.length === 1 && submit.proposal.files[0].target === 'site/round10.txt', submit.proposal);
    const peer = await evaluate('程序员B 互审', `
      const r = await window.workbench.devReview({ projectId: ${js(projectId)}, role: 'programmer2', requirementId: ${js(requirementId)}, proposalId: ${js(proposalId)}, verdict: 'approve', comment: '互审通过：边界与证据完整' });
      return JSON.stringify({ ok: r.ok, code: r.code || '', proposal: r.proposal, review: r.review, requirement: r.requirement });
    `);
    expect('开发互审走旧 show+review', peer.ok === true && peer.review && peer.review.verdict === 'approve', peer);
    const notDone = await evaluate('互审后先 done', `
      const r = await window.workbench.taskDone({ projectId: ${js(projectId)}, role: 'programmer1', taskId: ${js(devTaskId)}, evidence: 'C-未 apply' });
      return JSON.stringify({ ok: r.ok, code: r.code || '' });
    `);
    expect('提案未 apply 时开发 done 被拒绝', notDone.ok === false && notDone.code === 'PROPOSAL_NOT_APPLIED', notDone);
    const apply = await evaluate('PM 签字 apply', `
      const r = await window.workbench.devApply({ projectId: ${js(projectId)}, role: 'pm', requirementId: ${js(requirementId)}, proposalId: ${js(proposalId)}, log: '第十轮开发提交' });
      return JSON.stringify({ ok: r.ok, code: r.code || '', commitId: r.commitId, requirement: r.requirement });
    `);
    expect('PM 签字 apply 走旧协议', apply.ok === true && /^C-/.test(String(apply.commitId || '')), apply);
    expect('apply 真的写入项目文件', fs.existsSync(path.join(projectPath, 'site', 'round10.txt'))
      && fs.readFileSync(path.join(projectPath, 'site', 'round10.txt'), 'utf8') === 'round10 v1', projectPath);
    // apply 会重写项目索引：上一轮 boot 的索引哈希失效，必须重新 boot 才能继续。
    const rebootsAfterApply = await evaluate('apply 后重新 boot', `
      const roles = ['pm','product','analyst','programmer1','programmer2','tester'];
      const out = [];
      for (const role of roles) {
        const r = await window.workbench.workflowBoot({ projectId: ${js(projectId)}, role });
        out.push({ role, ok: Boolean(r.ok), code: r.code || '', complete: Boolean(r.bootRead && r.bootRead.complete) });
      }
      return JSON.stringify(out);
    `);
    expect('apply 改索引后重新 boot 读齐', Array.isArray(rebootsAfterApply) && rebootsAfterApply.length === 6
      && rebootsAfterApply.every((row) => row.ok && row.complete), rebootsAfterApply);
    const devDone = await evaluate('程序员A done', `
      const r = await window.workbench.taskDone({ projectId: ${js(projectId)}, role: 'programmer1', taskId: ${js(devTaskId)}, evidence: ${js(apply.commitId || 'C-round10')} });
      return JSON.stringify({ ok: r.ok, code: r.code || '', requirement: r.requirement, task: r.task });
    `);
    expect('开发 done 走旧 task done', devDone.ok === true && devDone.requirement && devDone.requirement.status === 'dev_done', devDone);
    expectRequirementStatus('开发完成', 'dev_done');
    await bootRoleForGate('开发完成后', 'pm');
    const testDispatch = await evaluate('PM 派测试', `
      const r = await window.workbench.testDispatch({ projectId: ${js(projectId)}, role: 'pm', requirementId: ${js(requirementId)} });
      return JSON.stringify({ ok: r.ok, code: r.code || '', task: r.task, requirement: r.requirement });
    `);
    expect('开发完成后 PM 才能派测试', testDispatch.ok === true && testDispatch.task && /^T-/.test(String(testDispatch.task.id)), testDispatch);
    expectRequirementStatus('派测试', 'test');
    const testTaskId = testDispatch.task ? String(testDispatch.task.id) : '';
    await bootRoleForGate('派测试后', 'tester');
    const testClaim = await evaluate('测试 claim', `
      const r = await window.workbench.taskClaim({ projectId: ${js(projectId)}, role: 'tester', taskId: ${js(testTaskId)} });
      return JSON.stringify({ ok: r.ok, code: r.code || '', task: r.task, requirement: r.requirement });
    `);
    expect('测试任务只能测试人员 claim', testClaim.ok === true && testClaim.task && testClaim.task.owner === 'tester', testClaim);
    const testDone = await evaluate('测试 done', `
      const r = await window.workbench.taskDone({ projectId: ${js(projectId)}, role: 'tester', taskId: ${js(testTaskId)}, evidence: 'PASS: site/round10.txt 内容与验收一致' });
      return JSON.stringify({ ok: r.ok, code: r.code || '', requirement: r.requirement, task: r.task });
    `);
    expect('测试 done 后进入 Owner 验收', testDone.ok === true && testDone.requirement && testDone.requirement.status === 'test_done', testDone);
    expectRequirementStatus('测试完成', 'test_done');
    await bootRoleForGate('测试完成后', 'tester');
    const accept = await evaluate('Owner 验收', `
      const r = await window.workbench.ownerAccept({ projectId: ${js(projectId)}, role: 'owner', requirementId: ${js(requirementId)}, decision: 'accepted', opinion: '验收通过：证据完整' });
      return JSON.stringify({ ok: r.ok, code: r.code || '', requirement: r.requirement, ownerNote: r.ownerNote, ownerReview: r.ownerReview, requirementTaskDone: r.requirementTaskDone });
    `);
    expect('Owner 验收通过（免确认码，直接 role=owner）', accept.ok === true && accept.requirement && accept.requirement.status === 'accepted', accept);
    expectRequirementStatus('Owner 验收', 'accepted');
    expect('Owner 验收审计记 actor:owner / channel:workbench',
      accept.requirement && accept.requirement.ownerAcceptance
      && accept.requirement.ownerAcceptance.actor === 'owner'
      && accept.requirement.ownerAcceptance.channel === 'workbench'
      && Boolean(accept.requirement.ownerAcceptance.at), accept.requirement && accept.requirement.ownerAcceptance);
    expect('Owner 验收同时关闭旧需求任务', accept.requirementTaskDone && accept.requirementTaskDone.ok === true
      && (readJsonFile(path.join(stateDir, '任务', requirementId + '.json')) || {}).status === 'done', accept.requirementTaskDone);
    const pmMail = path.join(teamTools.layout.mailDir, 'pm', 'new');
    const ownerMails = listJson(pmMail).map((name) => readJsonFile(path.join(pmMail, name))).filter(Boolean);
    expect('Owner 决定进 PM 旧邮箱', ownerMails.some((mail) => mail.type === 'owner-review'
      && String(mail.project) === teamName), ownerMails.map((mail) => ({ type: mail.type, subject: mail.subject, project: mail.project })));
    report.dev = {
      proposalId,
      commitId: apply.commitId,
      peer: peer.review && peer.review.verdict,
      testTaskId,
      accepted: accept.requirement && accept.requirement.status
    };

    // 5) Owner 新需求直接进 PM 下一轮；迭代/终止。
    const ownerReq = await evaluate('Owner 新需求', `
      const r = await window.workbench.requirementOwnerCreate({
        projectId: ${js(projectId)}, title: 'Owner 下一轮需求', priority: 'P2',
        acceptance: '下一轮由 PM 按旧 req create 任务推进'
      });
      return JSON.stringify({ ok: r.ok, code: r.code || '', requirement: r.requirement });
    `);
    expect('Owner 新需求由 PM 代办旧 req create', ownerReq.ok === true && ownerReq.requirement
      && ownerReq.requirement.origin === 'owner' && ownerReq.requirement.queued === true, ownerReq);
    const ownerReqId = ownerReq.requirement ? String(ownerReq.requirement.id) : '';
    expect('Owner 新需求排到下一轮', ownerReq.requirement && Number(ownerReq.requirement.round) >= 2, ownerReq.requirement);
    // Owner 新需求又新增了需求正文/总览/索引：PM 必须重新 boot 才能启动迭代。
    const pmRebootBeforeIterate = await evaluate('Owner 新需求后 PM 重新 boot', `
      const r = await window.workbench.workflowBoot({ projectId: ${js(projectId)}, role: 'pm' });
      return JSON.stringify({ ok: r.ok, code: r.code || '', complete: Boolean(r.bootRead && r.bootRead.complete) });
    `);
    expect('Owner 新需求后 PM 重新 boot 读齐', pmRebootBeforeIterate.ok === true && pmRebootBeforeIterate.complete === true, pmRebootBeforeIterate);
    const next = await evaluate('PM 下一轮清单', `
      const r = await window.workbench.workflowNext({ projectId: ${js(projectId)} });
      return JSON.stringify({ ok: r.ok, code: r.code || '', round: r.round, nextRound: r.nextRound });
    `);
    expect('PM 能看到下一轮需求', next.ok === true && Array.isArray(next.nextRound)
      && next.nextRound.some((row) => row.id === ownerReqId), next);
    const iterate = await evaluate('启动迭代', `
      const r = await window.workbench.workflowIterate({ projectId: ${js(projectId)} });
      return JSON.stringify({ ok: r.ok, code: r.code || '', round: r.round, driver: r.driver, requirement: r.snapshot && r.snapshot.requirements.find((x) => x.id === ${js(ownerReqId)}) });
    `);
    expect('迭代把下一轮需求转正', iterate.ok === true && Number(iterate.round) >= 2
      && iterate.requirement && iterate.requirement.queued === false, iterate);
    expect('迭代真的调用旧 workflow iterate 命令', iterate.driver === 'team.mjs workflow', iterate);
    // 5.2) 迭代后旧 boot 在只读简报里就必须失效，不能等动作被拒才发现。
    const afterIterateBriefing = await evaluate('迭代后 boot 失效简报', `
      const r = await window.workbench.workflowBriefing({ projectId: ${js(projectId)} });
      return JSON.stringify({ ok: r.ok, round: r.round, allComplete: r.allComplete, pm: r.roles && r.roles.pm });
    `);
    expect('迭代后 briefing 明确标记跨轮 boot 失效', afterIterateBriefing.ok === true
      && Number(afterIterateBriefing.round) >= 2
      && afterIterateBriefing.allComplete === false
      && afterIterateBriefing.pm && afterIterateBriefing.pm.roundMismatch === true
      && afterIterateBriefing.pm.complete === false, afterIterateBriefing);
    const afterIterateWorkflow = readJsonFile(workflowFile);
    expect('迭代后旧 boot 落盘失效标记', Boolean(afterIterateWorkflow && afterIterateWorkflow.boots
      && afterIterateWorkflow.boots.pm && afterIterateWorkflow.boots.pm.invalidatedAt), afterIterateWorkflow && afterIterateWorkflow.boots);
    // 迭代换了轮次：上一轮 boot 不能沿用到新轮次，PM 必须重新 boot 才能终止。
    const pmRebootAfterIterate = await evaluate('迭代后 PM 重新 boot', `
      const r = await window.workbench.workflowBoot({ projectId: ${js(projectId)}, role: 'pm' });
      return JSON.stringify({ ok: r.ok, code: r.code || '', complete: Boolean(r.bootRead && r.bootRead.complete) });
    `);
    expect('迭代后 PM 重新 boot', pmRebootAfterIterate.ok === true && pmRebootAfterIterate.complete === true, pmRebootAfterIterate);
    const terminated = await evaluate('终止工作流', `
      const r = await window.workbench.workflowTerminate({ projectId: ${js(projectId)}, opinion: '第十轮验证终止' });
      return JSON.stringify({ ok: r.ok, code: r.code || '', phase: r.snapshot && r.snapshot.phase, driver: r.driver, closedTasks: r.closedTasks, stopped: r.stoppedRequirements });
    `);
    expect('工作流可终止', terminated.ok === true && terminated.phase === 'terminated', terminated);
    expect('终止真的调用旧 workflow terminate 命令', terminated.driver === 'team.mjs workflow', terminated);
    expect('终止同时收口旧任务', Array.isArray(terminated.closedTasks) && terminated.closedTasks.includes(ownerReqId)
      && (readJsonFile(path.join(stateDir, '任务', ownerReqId + '.json')) || {}).status === 'done', terminated);
    const afterTerminate = await evaluate('终止后派单', `
      const r = await window.workbench.requirementDispatch({ projectId: ${js(projectId)}, role: 'pm', requirementId: ${js(ownerReqId)}, owner: 'programmer1' });
      return JSON.stringify({ ok: r.ok, code: r.code || '' });
    `);
    expect('终止后不能继续派单', afterTerminate.ok === false, afterTerminate);
    const afterTerminateCreate = await evaluate('终止后建需求', `
      const r = await window.workbench.requirementCreate({
        projectId: ${js(projectId)}, role: 'analyst', title: '终止后需求', priority: 'P2', acceptance: '不应创建'
      });
      return JSON.stringify({ ok: r.ok, code: r.code || '' });
    `);
    expect('终止后不能再创建需求', afterTerminateCreate.ok === false && afterTerminateCreate.code === 'WORKFLOW_TERMINATED', afterTerminateCreate);

    // 6) 命令闸门：
    //    - mock 已验证“三条命令存在时全流程可走”；
    //    - 真实工具若已实现 req review / owner / workflow，则做正向断言（driver + 脱敏 argv + 落账）；
    //    - 真实工具真缺命令时，用最小桩工具保留 LEGACY_PROTOCOL_REQUIRED 负例，不能伪造成功。
    const protocolCommands = protocolMock.log.map((row) => row.command + (row.action ? ':' + row.action : ''));
    expect('mock 旧命令覆盖评审/Owner/迭代/终止', ['req review', 'owner', 'workflow:iterate', 'workflow:terminate']
      .every((command) => protocolCommands.includes(command)), protocolCommands);
    expect('mock Owner 验收调用 owner --action accept', protocolMock.log.some((row) => row.command === 'owner'
      && row.action === 'accept' && row.decision === 'accepted'), protocolMock.log.filter((row) => row.command === 'owner'));
    const noTools = realTeamTools.create({ teamRoot, toolsDir: path.join(testRoot, '第十轮-没有工具') });
    const missing = await noTools.createRequirement({
      projectName: teamName, projectPath, role: 'analyst',
      title: '缺工具需求', acceptance: '缺工具时必须明确报错'
    });
    expect('缺 team.mjs 时返回 LEGACY_PROTOCOL_REQUIRED', missing.ok === false && missing.code === 'LEGACY_PROTOCOL_REQUIRED', missing);

    const caps = realTeamTools.legacyCapabilities();
    const commandState = {
      workflow: Boolean(caps.commands && caps.commands.workflow),
      owner: Boolean(caps.commands && caps.commands.owner),
      reqReview: Boolean(caps.reqReview)
    };
    report.commands = { available: Boolean(caps.available), ...commandState, missing: caps.missing };

    // 真缺命令的负例：造一个只有 init/boot/req 入口、没有三条命令的桩；
    // 闸门必须在任何状态写入之前返回 LEGACY_PROTOCOL_REQUIRED。
    const stubToolsDir = path.join(testRoot, '第十轮-缺三命令工具');
    fs.mkdirSync(path.join(stubToolsDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(stubToolsDir, 'team.mjs'), [
      "const cmd = process.argv[2] || 'help';",
      'switch (cmd) {',
      "  case 'init': process.exit(0);",
      "  case 'boot': process.exit(0);",
      "  case 'req': process.exit(0);",
      '  default:',
      "    console.log(JSON.stringify({ ok: false, code: 'UNKNOWN' }));",
      '    process.exit(3);',
      '}'
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(stubToolsDir, 'lib', 'ops.mjs'), [
      'export function cmdInit() {}',
      'export function cmdBoot() {}',
      'export function cmdReq() {}'
    ].join('\n'), 'utf8');
    const missingCmdTools = realTeamTools.create({ teamRoot, toolsDir: stubToolsDir });
    const stubCaps = missingCmdTools.legacyCapabilities();
    expect('桩工具能力表判定三条命令缺失', stubCaps.available === true
      && stubCaps.commands.workflow === false && stubCaps.commands.owner === false && stubCaps.reqReview === false
      && stubCaps.missing.includes('workflow') && stubCaps.missing.includes('owner') && stubCaps.missing.includes('req review'), stubCaps);
    const workflowBeforeStrict = fs.readFileSync(workflowFile, 'utf8');
    const strictReview = await missingCmdTools.reviewRequirement({
      projectName: teamName, projectPath, role: 'product', requirementId: ownerReqId,
      verdict: 'approve', comment: '要求旧命令'
    });
    expect('缺 req review 时明确 LEGACY_PROTOCOL_REQUIRED', strictReview.ok === false
      && strictReview.code === 'LEGACY_PROTOCOL_REQUIRED', strictReview);
    const strictOwner = await missingCmdTools.ownerRequirementDecision({
      projectName: teamName, projectPath, role: 'owner', requirementId: ownerReqId,
      decision: 'skipped'
    });
    // owner / workflow 已改为壳层收口（Fast / Full 一致）：缺旧命令不再卡成 LEGACY_PROTOCOL_REQUIRED，
    // 要么壳层成功（shellOwned=true + 明确 code），要么停在业务闸门（状态/轮次/终止后的阶段）上。
    expect('缺 owner 命令时 Owner 决定不被旧命令卡死',
      strictOwner.ok === true || strictOwner.code !== 'LEGACY_PROTOCOL_REQUIRED', strictOwner);
    const strictIterate = await missingCmdTools.iterateWorkflow({
      projectName: teamName, projectPath, role: 'pm'
    });
    expect('缺 workflow 命令时迭代不被旧命令卡死',
      strictIterate.ok === true || strictIterate.code !== 'LEGACY_PROTOCOL_REQUIRED', strictIterate);
    const strictTerminate = await missingCmdTools.terminateWorkflow({
      projectName: teamName, projectPath, role: 'pm', opinion: '不应写入'
    });
    expect('缺 workflow 命令时终止不被旧命令卡死',
      strictTerminate.ok === true || strictTerminate.code !== 'LEGACY_PROTOCOL_REQUIRED', strictTerminate);
    const strictAccept = await missingCmdTools.ownerAccept({
      projectName: teamName, projectPath, role: 'owner', requirementId: ownerReqId,
      decision: 'accepted', opinion: '不应写入'
    });
    expect('缺 owner 命令时验收不被旧命令卡死',
      strictAccept.ok === true || strictAccept.code !== 'LEGACY_PROTOCOL_REQUIRED', strictAccept);
    // 桩工具 boot 不可用：上面四个动作即使放开旧命令闸门，也必须在 boot/业务闸门处失败，
    // 不能出现“没有旧命令却写成功”的假账。
    const strictAllFailed = [strictOwner, strictIterate, strictTerminate, strictAccept].every((row) => row.ok === false);
    if (strictAllFailed) {
      expect('缺命令失败时没有改写工作流.json', fs.readFileSync(workflowFile, 'utf8') === workflowBeforeStrict);
    } else {
      expect('缺命令时壳层成功必须标 shellOwned 且写真实状态', [strictOwner, strictIterate, strictTerminate, strictAccept]
        .filter((row) => row.ok === true)
        .every((row) => row.shellOwned === true && Boolean(row.workflowFile)), [strictOwner, strictIterate, strictTerminate, strictAccept]
        .filter((row) => row.ok === true)
        .map((row) => ({ code: row.code, shellOwned: row.shellOwned })));
    }

    if (commandState.workflow && commandState.owner && commandState.reqReview) {
      const realReport = await selftestRound10RealCommands(realTeamTools, testRoot, evaluate, expect, argvIncludes);
      report.realCommands = realReport;
    } else {
      report.realCommands = { skipped: true, reason: '真实 team.mjs 仍缺命令', missing: caps.missing };
    }

    // 7) 本地库只是镜像：清掉本地 requirements 后，直接读旧 工作流.json 仍有需求。
    const store = readStore();
    const local = store.projects.find((project) => project.id === projectId);
    if (local) {
      local.requirements = [];
      local.workflowMirror = null;
      writeStore(store);
    }
    const legacyTruth = teamTools.readWorkflowSnapshot(teamName, projectPath);
    expect('旧 工作流.json 仍是需求真相', legacyTruth.ok === true
      && legacyTruth.requirements.length >= 2 && legacyTruth.requirements.some((row) => row.id === requirementId), {
      count: legacyTruth.ok ? legacyTruth.requirements.length : -1
    });
    const restoredMirror = await evaluate('从旧状态重建镜像', `
      const r = await window.workbench.workflowState({ projectId: ${js(projectId)} });
      const s = await window.workbench.state();
      const p = s.projects.find((x) => x.id === ${js(projectId)});
      return JSON.stringify({ ok: r.ok, requirements: (p.requirements || []).length, phase: p.phase, file: r.file });
    `);
    expect('状态刷新可从旧状态重建本地镜像', restoredMirror.ok === true && restoredMirror.requirements >= 2, restoredMirror);
    // 4 位旧需求号也必须进工作流扫描，不能只靠 工作流.json/任务 行。
    const legacyReqId = 'R-20200101-0001';
    fs.writeFileSync(path.join(projectPath, '需求', legacyReqId + '-旧号回归.md'), [
      '# 旧号回归', '', '- 状态：review', '', '## 验收标准', '', '4 位需求号能读、能进工作流扫描。', ''
    ].join('\n'), 'utf8');
    const legacyScan = await evaluate('4 位旧需求进入工作流扫描', `
      const r = await window.workbench.workflowState({ projectId: ${js(projectId)} });
      return JSON.stringify({
        ok: r.ok,
        requirements: (r.requirements || []).map((x) => ({ id: x.id, status: x.status, origin: x.origin, title: x.title }))
      });
    `);
    const legacyDocRead = teamTools.readRequirementDocs(projectPath);
    expect('4 位旧需求号可读', legacyDocRead.list.some((row) => row.id === legacyReqId && row.status === 'review'), legacyDocRead.list);
    expect('4 位旧需求进入工作流扫描', legacyScan.ok === true
      && legacyScan.requirements.some((row) => row.id === legacyReqId && row.origin === 'legacy-doc'), legacyScan);
    expect('全程不向 DSH 发 prompt', mock.counters.sessionPrompt === promptBefore, { before: promptBefore, after: mock.counters.sessionPrompt });
    const expectedDrive = path.parse(ROOT).root.toLowerCase();
    const driveTargets = [projectPath, stateDir, path.join(stateDir, '工作流.json'), path.join(projectPath, '需求', requirementId + '-第十轮需求：旧工作流闭环.md')];
    const driveChecks = driveTargets.map((target) => ({ target, drive: path.parse(path.resolve(target)).root.toLowerCase() }));
    expect('工作流状态全在 D 盘', driveChecks.every((row) => row.drive === expectedDrive), driveChecks);
    report.final = {
      phase: terminated.phase,
      legacyRequirements: legacyTruth.ok ? legacyTruth.requirements.length : -1,
      mirroredRequirements: restoredMirror.requirements,
      missingCode: missing.code,
      strictReview: strictReview.code,
      strictOwner: strictOwner.code,
      strictIterate: strictIterate.code,
      strictTerminate: strictTerminate.code,
      strictAccept: strictAccept.code,
      protocolCommands,
      closedTasks: terminated.closedTasks,
      prompts: { before: promptBefore, after: mock.counters.sessionPrompt }
    };
    report.docSync = statusSyncEvidence;
  } catch (error) {
    failures.push('第十轮工作流闭环自测异常：' + String((error && error.stack) || error).slice(0, 1000));
  }
  return { report, failures };
}

async function selftestRound11(win, testRoot, mock) {
  const failures = [];
  const expect = (name, condition, detail) => {
    if (!condition) failures.push(name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  };
  const js = (value) => JSON.stringify(value);
  const evaluate = async (label, body) => {
    try {
      const raw = await win.webContents.executeJavaScript(`(async()=>{${body}})()`);
      return raw === undefined ? {} : JSON.parse(raw);
    } catch (error) {
      failures.push(label + ' 执行失败：' + String((error && error.message) || error).slice(0, 500));
      return {};
    }
  };
  const report = {};
  const promptBefore = mock.counters.sessionPrompt;
  // 第十一轮沿用第十轮的命令桩：req review / owner / workflow 走 mock，其余命令走真实 team.mjs。
  const toolsModule = require('./team-tools');
  const protocolMock = createWorkflowProtocolMock(teamTools);
  teamTools = toolsModule.create({ teamRoot: teamTools.layout.root, legacyMock: protocolMock });
  try {
    const setup = await evaluate('创建第十一轮项目', `
      const created = await window.workbench.createProject({ name: '第十一轮闭环', root: ${js(testRoot)} });
      const s = await window.workbench.state();
      const p = s.projects.find((x) => x.id === created.project.id);
      return JSON.stringify({
        projectId: created.project.id, path: created.project.path,
        teamName: p.teamName || created.project.name, teamOk: Boolean(created.team && created.team.ok)
      });
    `);
    expect('第十一轮项目创建成功并 ensure 团队', Boolean(setup.projectId) && setup.teamOk === true, setup);
    const projectId = setup.projectId;
    const projectPath = setup.path;
    const teamName = setup.teamName;
    if (!projectId || !projectPath || !teamName) return { report, failures };
    seedSelftestProjectDocs(projectPath, teamName);
    const boots = await evaluate('第十一轮六角色 boot', `
      const roles = ['pm','product','analyst','programmer1','programmer2','tester'];
      const out = [];
      for (const role of roles) {
        const r = await window.workbench.workflowBoot({ projectId: ${js(projectId)}, role });
        out.push({ role, ok: Boolean(r.ok), code: r.code || '', complete: Boolean(r.bootRead && r.bootRead.complete) });
      }
      return JSON.stringify(out);
    `);
    expect('第十一轮六角色 boot 成功', Array.isArray(boots) && boots.length === 6 && boots.every((row) => row.ok && row.complete), boots);

    // 1) owner:demand：Owner 只提描述/优先级/验收标准[]；PM 自动 boot 建档 R- 并进入产品评审。
    const demand = await evaluate('owner:demand 提需求', `
      const r = await window.workbench.ownerDemand({
        projectId: ${js(projectId)},
        description: 'Owner 需求：一键导出报告',
        priority: 'P1',
        acceptanceCriteria: ['点击导出生成报告文件', '导出内容与验收标准一致', '失败时给出可读错误']
      });
      return JSON.stringify({
        ok: r.ok, code: r.code || '', requirement: r.requirement, demand: r.demand,
        pmBoot: r.pmBoot, followUp: r.followUp, snapshot: r.snapshot, driver: r.driver
      });
    `);
    expect('owner:demand 由 PM 自动 boot 并建档 R-', demand.ok === true && demand.requirement && /^R-/.test(String(demand.requirement.id))
      && demand.pmBoot && demand.pmBoot.ok === true && demand.pmBoot.complete === true
      && demand.requirement.origin === 'owner', demand);
    const demandReqId = demand.requirement ? String(demand.requirement.id) : '';
    expect('owner:demand 需求直接进入产品评审', Boolean(demandReqId) && demand.requirement.status === 'review'
      && demand.requirement.queued === false
      && demand.snapshot && demand.snapshot.phase === 'requirement_review', demand);
    expect('owner:demand 保留原始验收标准[]', demand.demand && Array.isArray(demand.demand.acceptanceCriteria)
      && demand.demand.acceptanceCriteria.length === 3
      && demand.demand.requirementId === demandReqId, demand.demand);
    expect('owner:demand 记录 PM 跟进责任', Boolean(demand.followUp && demand.followUp.by === 'pm'), demand.followUp);
    // Owner 提需求新增了需求正文/总览/索引：六角色必须重新 boot 后才能评审/派单（boot 闸门兜底）。
    const rebootsAfterDemand = await evaluate('owner:demand 后六角色重读', `
      const roles = ['pm','product','analyst','programmer1','programmer2','tester'];
      const out = [];
      for (const role of roles) {
        const r = await window.workbench.workflowBoot({ projectId: ${js(projectId)}, role });
        out.push({ role, ok: Boolean(r.ok), complete: Boolean(r.bootRead && r.bootRead.complete) });
      }
      return JSON.stringify(out);
    `);
    expect('owner:demand 后六角色重新 boot', Array.isArray(rebootsAfterDemand) && rebootsAfterDemand.length === 6
      && rebootsAfterDemand.every((row) => row.ok && row.complete), rebootsAfterDemand);
    const earlyDispatch = await evaluate('未过评审不能派单', `
      const r = await window.workbench.requirementDispatch({ projectId: ${js(projectId)}, role: 'pm', requirementId: ${js(demandReqId)}, owner: 'programmer1' });
      return JSON.stringify({ ok: r.ok, code: r.code || '' });
    `);
    expect('产品评审未通过不得派单', earlyDispatch.ok === false
      && ['REQUIREMENT_NOT_APPROVED', 'PRODUCT_REVIEW_REQUIRED'].includes(earlyDispatch.code), earlyDispatch);

    // 2) 产品评审 approve → Owner 免确认码直接决定。
    const demandReview = await evaluate('产品评审 owner:demand 需求', `
      const r = await window.workbench.requirementReview({ projectId: ${js(projectId)}, role: 'product', requirementId: ${js(demandReqId)}, verdict: 'approve', comment: '产品评审通过：验收标准可测' });
      return JSON.stringify({ ok: r.ok, code: r.code || '', status: r.requirement && r.requirement.status });
    `);
    expect('owner:demand 需求产品评审通过', demandReview.ok === true && demandReview.status === 'approved', demandReview);
    const demandOwner = await evaluate('Owner 免确认码决定', `
      const r = await window.workbench.requirementOwner({ projectId: ${js(projectId)}, role: 'owner', requirementId: ${js(demandReqId)}, decision: 'approved', opinion: 'Owner 通过' });
      return JSON.stringify({
        ok: r.ok, code: r.code || '', status: r.requirement && r.requirement.status,
        actor: r.requirement && r.requirement.ownerReview && r.requirement.ownerReview.actor,
        channel: r.requirement && r.requirement.ownerReview && r.requirement.ownerReview.channel
      });
    `);
    expect('Owner 免确认码直接决定通过', demandOwner.ok === true && demandOwner.status === 'ready', demandOwner);
    expect('Owner 决定审计 actor:owner / channel:workbench', demandOwner.actor === 'owner' && demandOwner.channel === 'workbench', demandOwner);

    // 3) 第二条需求（分析师 → 评审 → Owner 跳过），凑齐并行派单的两条。
    const req2 = await evaluate('分析师建第二条需求', `
      const r = await window.workbench.requirementCreate({
        projectId: ${js(projectId)}, role: 'analyst', title: '第二条需求：首页性能优化',
        priority: 'P2', acceptance: '首页加载小于 1 秒且不被缓存污染'
      });
      return JSON.stringify({ ok: r.ok, code: r.code || '', id: r.requirement && r.requirement.id });
    `);
    expect('第二条需求创建成功', req2.ok === true && req2.id, req2);
    const req2Id = String(req2.id || '');
    const reboots2 = await evaluate('第二条需求后六角色重读', `
      const roles = ['pm','product','analyst','programmer1','programmer2','tester'];
      const out = [];
      for (const role of roles) {
        const r = await window.workbench.workflowBoot({ projectId: ${js(projectId)}, role });
        out.push({ role, ok: Boolean(r.ok), complete: Boolean(r.bootRead && r.bootRead.complete) });
      }
      return JSON.stringify(out);
    `);
    expect('第二条需求后六角色重新 boot', Array.isArray(reboots2) && reboots2.length === 6
      && reboots2.every((row) => row.ok && row.complete), reboots2);
    const req2Review = await evaluate('第二条需求评审+Owner', `
      const review = await window.workbench.requirementReview({ projectId: ${js(projectId)}, role: 'product', requirementId: ${js(req2Id)}, verdict: 'approve', comment: '评审通过' });
      const owner = await window.workbench.requirementOwner({ projectId: ${js(projectId)}, role: 'owner', requirementId: ${js(req2Id)}, decision: 'skipped', opinion: '跳过' });
      return JSON.stringify({ reviewOk: review.ok, reviewStatus: review.requirement && review.requirement.status, ownerOk: owner.ok, ownerStatus: owner.requirement && owner.requirement.status });
    `);
    expect('第二条需求评审+Owner 通过', req2Review.reviewOk === true && req2Review.ownerOk === true
      && req2Review.ownerStatus === 'ready', req2Review);

    // 4) 并行派单：两个开发任务分别派给程序员 A/B。
    const batch = await evaluate('PM 并行派单 A/B', `
      const r = await window.workbench.requirementDispatchBatch({ projectId: ${js(projectId)}, role: 'pm', items: [
        { requirementId: ${js(demandReqId)}, owner: 'programmer1' },
        { requirementId: ${js(req2Id)}, owner: 'programmer2' }
      ] });
      return JSON.stringify({
        ok: r.ok, code: r.code || '', dispatched: r.dispatched, parallel: r.parallel,
        results: Array.isArray(r.results) ? r.results.map((x) => ({ requirementId: x.requirementId, taskId: x.task && x.task.id, owner: x.task && x.task.owner })) : []
      });
    `);
    expect('并行派单两个开发任务分别归 A/B', batch.ok === true && batch.dispatched === 2
      && batch.parallel === true && batch.results && batch.results.length === 2
      && batch.results[0].owner === 'programmer1' && batch.results[1].owner === 'programmer2'
      && batch.results[0].taskId && batch.results[1].taskId, batch);
    const devTaskA = batch.results[0] ? String(batch.results[0].taskId) : '';
    const devTaskB = batch.results[1] ? String(batch.results[1].taskId) : '';
    const dupBatch = await evaluate('并行派单同人拒绝', `
      const r = await window.workbench.requirementDispatchBatch({ projectId: ${js(projectId)}, role: 'pm', items: [
        { requirementId: ${js(demandReqId)}, owner: 'programmer1' },
        { requirementId: ${js(req2Id)}, owner: 'programmer1' }
      ] });
      return JSON.stringify({ ok: r.ok, code: r.code || '' });
    `);
    expect('并行派单不能重复派给同一程序员', dupBatch.ok === false && dupBatch.code === 'DUPLICATE_DEV_OWNER', dupBatch);
    // 派单会同步两条需求的正文/总览状态，旧 boot 按现有闸门作废；
    // 开发/PM 在下一步动作前重新读需求（不绕过闸门）。
    const rebootsAfterBatch = await evaluate('并行派单后开发/PM 重读', `
      const roles = ['programmer1','programmer2','pm'];
      const out = [];
      for (const role of roles) {
        const r = await window.workbench.workflowBoot({ projectId: ${js(projectId)}, role });
        out.push({ role, ok: Boolean(r.ok), code: r.code || '', complete: Boolean(r.bootRead && r.bootRead.complete) });
      }
      return JSON.stringify(out);
    `);
    expect('并行派单后开发/PM 重新 boot 读齐', Array.isArray(rebootsAfterBatch) && rebootsAfterBatch.length === 3
      && rebootsAfterBatch.every((row) => row.ok && row.complete), rebootsAfterBatch);

    // 5) 双方并行开发：各自 claim/提交，提交时由另一名程序员互审，PM apply 后才能 done。
    const devFlow = await evaluate('并行开发互审', `
      const claimA = await window.workbench.taskClaim({ projectId: ${js(projectId)}, role: 'programmer1', taskId: ${js(devTaskA)} });
      const claimB = await window.workbench.taskClaim({ projectId: ${js(projectId)}, role: 'programmer2', taskId: ${js(devTaskB)} });
      const submitA = await window.workbench.devSubmit({ projectId: ${js(projectId)}, role: 'programmer1', taskId: ${js(devTaskA)}, fileRel: 'site/round11-a.txt', content: 'round11 A', title: 'A 的提案' });
      const selfReview = await window.workbench.devReview({ projectId: ${js(projectId)}, role: 'programmer1', requirementId: ${js(demandReqId)}, proposalId: submitA.proposal && submitA.proposal.id, verdict: 'approve' });
      const peerA = await window.workbench.devReview({ projectId: ${js(projectId)}, role: 'programmer2', requirementId: ${js(demandReqId)}, proposalId: submitA.proposal && submitA.proposal.id, verdict: 'approve', comment: 'B 互审 A 通过' });
      const applyA = await window.workbench.devApply({ projectId: ${js(projectId)}, role: 'pm', requirementId: ${js(demandReqId)}, proposalId: submitA.proposal && submitA.proposal.id, log: 'A 提交' });
      const doneA = await window.workbench.taskDone({ projectId: ${js(projectId)}, role: 'programmer1', taskId: ${js(devTaskA)}, evidence: applyA.commitId || 'C-A' });
      const submitB = await window.workbench.devSubmit({ projectId: ${js(projectId)}, role: 'programmer2', taskId: ${js(devTaskB)}, fileRel: 'site/round11-b.txt', content: 'round11 B', title: 'B 的提案' });
      const peerB = await window.workbench.devReview({ projectId: ${js(projectId)}, role: 'programmer1', requirementId: ${js(req2Id)}, proposalId: submitB.proposal && submitB.proposal.id, verdict: 'approve', comment: 'A 互审 B 通过' });
      const applyB = await window.workbench.devApply({ projectId: ${js(projectId)}, role: 'pm', requirementId: ${js(req2Id)}, proposalId: submitB.proposal && submitB.proposal.id, log: 'B 提交' });
      const doneB = await window.workbench.taskDone({ projectId: ${js(projectId)}, role: 'programmer2', taskId: ${js(devTaskB)}, evidence: applyB.commitId || 'C-B' });
      return JSON.stringify({
        claimA: claimA.ok, claimB: claimB.ok, submitA: submitA.ok,
        selfCode: selfReview.code || '', peerA: peerA.ok, applyA: applyA.ok, doneA: doneA.ok,
        submitB: submitB.ok, peerB: peerB.ok, applyB: applyB.ok, doneB: doneB.ok,
        doneAStatus: doneA.requirement && doneA.requirement.status,
        doneBStatus: doneB.requirement && doneB.requirement.status
      });
    `);
    expect('双方并行开发各自 claim/提交', devFlow.claimA === true && devFlow.claimB === true
      && devFlow.submitA === true && devFlow.submitB === true, devFlow);
    expect('提交时互审：自己不能审自己，另一名程序员审', devFlow.selfCode === 'SELF_REVIEW'
      && devFlow.peerA === true && devFlow.peerB === true, devFlow);
    expect('互审通过 + PM apply 后双方才能 done', devFlow.applyA === true && devFlow.applyB === true
      && devFlow.doneA === true && devFlow.doneB === true
      && devFlow.doneAStatus === 'dev_done' && devFlow.doneBStatus === 'dev_done', devFlow);

    // 6) buildRoleBrief 精准投喂：只读结构化区块，≤800 字；唤醒只发简报 + 四步命令。
    const workflowFile = path.join(teamTools.layout.projectsDir, teamTools.teamSlug(teamName, 60), '工作流.json');
    const fileBefore = fs.readFileSync(workflowFile, 'utf8');
    const pmBrief = teamTools.buildRoleBrief({ name: teamName, path: projectPath }, 'pm', '');
    const analystBrief = teamTools.buildRoleBrief({ name: teamName, path: projectPath }, 'analyst', '');
    const productBrief = teamTools.buildRoleBrief({ name: teamName, path: projectPath }, 'product', '');
    const devBrief = teamTools.buildRoleBrief({ name: teamName, path: projectPath }, 'programmer1', devTaskA);
    const testerBrief = teamTools.buildRoleBrief({ name: teamName, path: projectPath }, 'tester', '');
    expect('角色简报只读且 ≤800 字（pm）', pmBrief.ok === true && pmBrief.chars <= 800
      && /需求清单/.test(pmBrief.text) && pmBrief.truncated === false, pmBrief);
    expect('角色简报（需求 800 字）', analystBrief.ok === true && analystBrief.chars <= 800 && /需求清单/.test(analystBrief.text), analystBrief);
    expect('角色简报（产品 800 字）', productBrief.ok === true && productBrief.chars <= 800 && /需求清单/.test(productBrief.text), productBrief);
    expect('开发简报读到自己的开发任务（1200 上限）', devBrief.ok === true && devBrief.task === devTaskA
      && /开发任务/.test(devBrief.text) && devBrief.chars <= 800 && devBrief.limit === 1200, devBrief);
    expect('测试简报（1000 上限）', testerBrief.ok === true && testerBrief.chars <= 800 && testerBrief.limit === 1000, testerBrief);
    expect('buildRoleBrief 不写任何状态', fs.readFileSync(workflowFile, 'utf8') === fileBefore);
    const wakeDev = teamTools.wakeMessageFor({ projectName: teamName, role: 'programmer1', messageId: 'M-11', subject: '并行派单', task: devTaskA, ackRequired: true });
    expect('唤醒消息只发简报+四步命令（不贴全文/历史）', wakeDev.ok === true
      && /【团队派单 M-11】/.test(wakeDev.text)
      && /1\) boot/.test(wakeDev.text) && /2\) inbox/.test(wakeDev.text)
      && /3\) read/.test(wakeDev.text) && /4\) ack/.test(wakeDev.text)
      && wakeDev.totalChars <= teamTools.ROLE_BRIEF_LIMITS.programmer1, wakeDev);
    const wakeAnalyst = teamTools.wakeMessageFor({ projectName: teamName, role: 'analyst', messageId: 'M-12', subject: '需求通知', task: '', ackRequired: true });
    const wakeTester = teamTools.wakeMessageFor({ projectName: teamName, role: 'tester', messageId: 'M-13', subject: '测试通知', task: '', ackRequired: true });
    expect('唤醒输出上限按角色（需求 800）', wakeAnalyst.ok === true && wakeAnalyst.totalChars <= 800, wakeAnalyst);
    expect('唤醒输出上限按角色（测试 1000）', wakeTester.ok === true && wakeTester.totalChars <= 1000, wakeTester);

    // 7) 迭代期间的新需求入下一轮队列。
    const demand2 = await evaluate('在办期间 owner:demand 排队', `
      const r = await window.workbench.ownerDemand({
        projectId: ${js(projectId)}, description: 'Owner 第二轮需求', priority: 'P2', acceptanceCriteria: ['入下一轮队列']
      });
      return JSON.stringify({ ok: r.ok, code: r.code || '', queued: r.requirement && r.requirement.queued, round: r.requirement && r.requirement.round, phase: r.snapshot && r.snapshot.phase });
    `);
    expect('在办期间的新需求入下一轮队列', demand2.ok === true && demand2.queued === true
      && Number(demand2.round) >= 2, demand2);
    // 收口：PM 重读后终止（终止前 boot 会因新增需求正文失效）。
    const pmReboot = await evaluate('终止前 PM 重读', `
      const r = await window.workbench.workflowBoot({ projectId: ${js(projectId)}, role: 'pm' });
      return JSON.stringify({ ok: Boolean(r.ok), complete: Boolean(r.bootRead && r.bootRead.complete) });
    `);
    expect('终止前 PM 重新 boot', pmReboot.ok === true && pmReboot.complete === true, pmReboot);
    const terminated = await evaluate('第十一轮终止', `
      const r = await window.workbench.workflowTerminate({ projectId: ${js(projectId)}, role: 'pm', opinion: '第十一轮验证终止' });
      return JSON.stringify({ ok: r.ok, code: r.code || '', phase: r.snapshot && r.snapshot.phase });
    `);
    expect('第十一轮可终止收口', terminated.ok === true && terminated.phase === 'terminated', terminated);
    expect('第十一轮全程不向 DSH 发 prompt', mock.counters.sessionPrompt === promptBefore, {
      before: promptBefore, after: mock.counters.sessionPrompt
    });
    const expectedDrive = path.parse(ROOT).root.toLowerCase();
    const driveChecks = [projectPath, workflowFile, path.join(projectPath, '需求')]
      .map((target) => ({ target, drive: path.parse(path.resolve(target)).root.toLowerCase() }));
    expect('第十一轮状态全在 D 盘', driveChecks.every((row) => row.drive === expectedDrive), driveChecks);
    report.final = {
      demandReqId, req2Id, devTaskA, devTaskB,
      dispatched: batch.dispatched,
      briefChars: { pm: pmBrief.chars, analyst: analystBrief.chars, product: productBrief.chars, dev: devBrief.chars, tester: testerBrief.chars },
      wakeChars: { dev: wakeDev.totalChars, analyst: wakeAnalyst.totalChars, tester: wakeTester.totalChars },
      demand2Queued: demand2.queued,
      phase: terminated.phase,
      prompts: { before: promptBefore, after: mock.counters.sessionPrompt }
    };
  } catch (error) {
    failures.push('第十一轮自测异常：' + String((error && error.stack) || error).slice(0, 1000));
  }
  return { report, failures };
}

/**
 * 第十二轮：派单“执行语义”修复回归。
 * - 能力矩阵：真实源码探测、测试 mock、项目快照都识别 inbox/read/ack；
 * - 唤醒词：要求执行正文动作、按角色职责产出、完成后回执；PM→需求分析师明确 req create + 需求/R-*.md；
 * - 精准投喂：仍只带结构化简报 + 四步，不贴正文/历史；
 * - 角色按提示执行 req create：项目 需求/ 真正落 R-*.md（D 盘沙盘）。
 * Owner 一次点击、并行派单、D 盘仍由第十一轮矩阵继续覆盖。
 */
async function selftestRound12(win, testRoot, mock) {
  const failures = [];
  const expect = (name, condition, detail) => {
    if (!condition) failures.push(name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  };
  const js = (value) => JSON.stringify(value);
  const evaluate = async (label, body) => {
    try {
      const raw = await win.webContents.executeJavaScript(`(async()=>{${body}})()`);
      return raw === undefined ? {} : JSON.parse(raw);
    } catch (error) {
      failures.push(label + ' 执行失败：' + String((error && error.message) || error).slice(0, 500));
      return {};
    }
  };
  const report = {};
  const realTools = require('./team-tools');
  const bodySentinel = 'BODY-SENTINEL-12f3a';
  try {
    // 1) 能力矩阵：真实源码探测 + 测试 mock 必须同形，不能一个有一个没有。
    const realCaps = realTools.legacyCapabilities();
    const mockCaps = teamTools.legacyCapabilities();
    report.caps = {
      real: {
        inbox: Boolean(realCaps.commands && realCaps.commands.inbox),
        read: Boolean(realCaps.commands && realCaps.commands.read),
        ack: Boolean(realCaps.commands && realCaps.commands.ack),
        missing: realCaps.missing
      },
      mock: {
        inbox: Boolean(mockCaps.commands && mockCaps.commands.inbox),
        read: Boolean(mockCaps.commands && mockCaps.commands.read),
        ack: Boolean(mockCaps.commands && mockCaps.commands.ack),
        missing: mockCaps.missing
      }
    };
    expect('真实能力矩阵识别 inbox/read/ack', realCaps.available === true
      && report.caps.real.inbox && report.caps.real.read && report.caps.real.ack
      && !realCaps.missing.includes('inbox') && !realCaps.missing.includes('read') && !realCaps.missing.includes('ack'), report.caps.real);
    expect('测试 mock 能力矩阵与真实同形（inbox/read/ack）', mockCaps.mocked === true
      && report.caps.mock.inbox && report.caps.mock.read && report.caps.mock.ack
      && mockCaps.missing.length === 0, report.caps.mock);

    // 2) 建项目 + 六角色会话：真实 team.mjs send 需要两侧会话身份。
    const setup = await evaluate('创建第十二轮项目', `
      const created = await window.workbench.createProject({ name: '第十二轮流程', root: ${js(testRoot)} });
      const provision = await window.workbench.dshProvision({ projectId: created.project.id });
      const s = await window.workbench.state();
      const p = s.projects.find((x) => x.id === created.project.id);
      return JSON.stringify({
        projectId: created.project.id, path: created.project.path,
        teamName: p.teamName || created.project.name,
        sessionCount: provision.mapping ? provision.mapping.sessionCount : -1
      });
    `);
    expect('第十二轮项目创建并建齐六会话', Boolean(setup.projectId) && setup.sessionCount === 6, setup);
    const projectId = setup.projectId;
    const projectPath = setup.path;
    const teamName = setup.teamName;
    if (!projectId || !projectPath || !teamName) return { report, failures };

    const wf = await evaluate('第十二轮能力矩阵快照', `
      const r = await window.workbench.workflowState({ projectId: ${js(projectId)} });
      const caps = r.legacy && r.legacy.capabilities ? r.legacy.capabilities : null;
      return JSON.stringify({
        ok: r.ok, phase: r.phase,
        caps: caps ? {
          file: caps.file,
          inbox: Boolean(caps.commands && caps.commands.inbox),
          read: Boolean(caps.commands && caps.commands.read),
          ack: Boolean(caps.commands && caps.commands.ack),
          missing: caps.missing, optionalMissing: caps.optionalMissing
        } : null
      });
    `);
    expect('项目面板能力矩阵不误报 inbox/read/ack 缺失', wf.ok === true && wf.caps
      && wf.caps.inbox === true && wf.caps.read === true && wf.caps.ack === true
      && !wf.caps.missing.includes('inbox') && !wf.caps.missing.includes('read') && !wf.caps.missing.includes('ack'), wf);
    // 直接渲染一次项目面板的能力矩阵，确认渲染层不会把 inbox/read/ack 画成“缺”。
    const uiCaps = await evaluate('能力矩阵面板渲染', `
      const prev = legacyUi.workflow;
      const caps = {
        available: true,
        file: ${js(wf.caps && wf.caps.file ? wf.caps.file : '')},
        commands: { boot: true, send: true, inbox: true, read: true, ack: true, task: true, req: true,
          propose: true, show: true, review: true, sign: true, apply: true, grant: true, index: true,
          workflow: true, owner: true },
        taskClaim: true, taskDone: true, reqCreate: true, reqReview: true,
        missing: [], optionalMissing: []
      };
      let html = '';
      try {
        legacyUi.workflow = { ok: true, legacy: { source: '工作流.json + 任务/', file: caps.file, capabilities: caps } };
        html = legacyCapabilitiesMarkup();
      } finally {
        legacyUi.workflow = prev;
      }
      const chip = (label) => {
        const m = new RegExp('<code>' + label + '</code>(有|缺)').exec(html);
        return m ? m[1] : '';
      };
      return JSON.stringify({ inbox: chip('inbox'), read: chip('read'), ack: chip('ack') });
    `);
    expect('项目面板能力矩阵显示 inbox/read/ack=有', uiCaps.inbox === '有' && uiCaps.read === '有' && uiCaps.ack === '有', uiCaps);
    report.uiCaps = uiCaps;

    // 3) PM→需求分析师：真实 team.mjs send + mock DSH 唤醒；抓实际 prompt。
    const promptBefore = mock.counters.sessionPrompt;
    const sent = await evaluate('PM→需求分析师派单', `
      const r = await window.workbench.teamSend({
        projectId: ${js(projectId)}, from: 'pm', role: 'analyst',
        subject: '需求立项：一键导出',
        body: '${bodySentinel} 请为「一键导出」建需求：P1，验收标准是导出的报告与页面数据一致；产出需求文档后再回执。'
      });
      return JSON.stringify({ id: r.message.id, source: r.source, wake: r.wake, lockTaken: r.lockTaken });
    `);
    expect('第十二轮派单走真实旧协议并唤醒', sent.source === 'team' && sent.wake && sent.wake.ok === true, sent);
    const wakeRows = mock.prompts.slice(promptBefore).filter((row) => String(row.text || '').includes(String(sent.id || '')));
    const wakeText = wakeRows.length ? String(wakeRows[0].text) : '';
    report.wake = { chars: wakeText.length, text: wakeText.slice(0, 1200) };
    expect('唤醒词要求执行正文动作并产出', /执行消息正文指定的动作/.test(wakeText)
      && /按角色职责产出文件\/需求/.test(wakeText) && /完成后回执结果/.test(wakeText), wakeText.slice(0, 600));
    expect('唤醒词写明只回执不执行视为失败', /只回执不执行视为失败/.test(wakeText), wakeText.slice(0, 600));
    expect('PM→需求分析师唤醒明确 req create', /PM→需求分析师/.test(wakeText) && /req create/.test(wakeText), wakeText.slice(-400));
    expect('PM→需求分析师唤醒明确 需求/R-*.md', /在项目 需求\/ 下产出 R-\*\.md/.test(wakeText), wakeText.slice(-400));
    expect('唤醒仍含四步命令', /1\) boot/.test(wakeText) && /2\) inbox/.test(wakeText)
      && /3\) read/.test(wakeText) && /4\) ack/.test(wakeText)
      && /工作台壳不会代你 ack/.test(wakeText), wakeText.slice(0, 900));
    expect('唤醒不贴派单正文/历史', !wakeText.includes(bodySentinel), wakeText);
    expect('需求分析师唤醒 ≤800 字', wakeText.length <= 800, wakeText.length);

    // 4) 新语义：角色按提示执行 req create；壳层负责把需求落成 需求/R-*.md 并写总览。
    // 新版 team.mjs 的 req create 只建任务行，不再写需求正文；正文/总览由壳层统一生成。
    const demandDoc = await evaluate('需求分析师按新语义建档', `
      const r = await window.workbench.requirementCreate({
        projectId: ${js(projectId)}, role: 'analyst', title: '一键导出', priority: 'P1',
        acceptance: '导出的报告与页面数据一致'
      });
      return JSON.stringify({ ok: r.ok, code: r.code || '', id: r.requirement && r.requirement.id, docFile: r.docFile || '' });
    `);
    const reqId = String(demandDoc.id || '');
    const docAbs = demandDoc.docFile ? path.resolve(String(demandDoc.docFile)) : '';
    const docRel = docAbs ? path.relative(projectPath, docAbs).replace(/\\/g, '/') : '';
    expect('新语义 req create 成功并返回 R 号', demandDoc.ok === true && /^R-\d{8}-\d{6}-[0-9a-z]{4,8}$/i.test(reqId), demandDoc);
    expect('壳层在项目 需求/ 下产出 R-*.md', /^需求[\\/]R-[^\\/]+\.md$/i.test(docRel)
      && Boolean(docAbs) && fs.existsSync(docAbs), { docRel, exists: docAbs ? fs.existsSync(docAbs) : false });
    const overviewFile = path.join(projectPath, '需求', '00-需求总览.md');
    const overviewText = fs.existsSync(overviewFile) ? fs.readFileSync(overviewFile, 'utf8') : '';
    expect('需求总览写入新需求号', Boolean(reqId) && overviewText.includes(reqId), { reqId, overview: overviewText.slice(0, 200) });
    const drive = docAbs ? path.parse(docAbs).root.toLowerCase() : '';
    expect('第十二轮产物落在 D 盘', drive === path.parse(ROOT).root.toLowerCase(), { docAbs, drive });

    // 5) 有了需求正文后再生成一条唤醒：结构化简报仍只带清单，不贴全文/历史。
    const wake2 = teamTools.wakeMessageFor({
      projectName: teamName, role: 'analyst', from: 'pm', messageId: 'M-12-2',
      subject: '需求复盘', task: '', ackRequired: true
    });
    expect('唤醒带结构化简报（需求清单）', wake2.ok === true && wake2.brief
      && /【需求清单】/.test(wake2.text) && wake2.briefChars > 0 && wake2.briefChars <= 800,
      { chars: wake2.briefChars, text: wake2.text.slice(0, 500) });
    expect('唤醒只带简报+四步且不贴正文', wake2.ok === true && wake2.totalChars <= 800
      && /1\) boot/.test(wake2.text) && /4\) ack/.test(wake2.text)
      && !wake2.text.includes(bodySentinel), { chars: wake2.totalChars });

    report.req = { id: reqId, doc: docRel, drive };
    report.final = { wakeChars: wakeText.length, wake2Chars: wake2.totalChars, reqId, docRel };
  } catch (error) {
    failures.push('第十二轮流程修复自测异常：' + String((error && error.stack) || error).slice(0, 1000));
  }
  return { report, failures };
}

/**
 * 第十三轮：团队模式（full/fast）+ Fast 评审链路 + 驳回 Owner 需求投票。
 * 全程 D 盘沙盘 + mock DSH/旧命令，不碰真实项目。
 */
async function selftestRound13(win, testRoot, mock) {
  const failures = [];
  const expect = (name, condition, detail) => {
    if (!condition) failures.push(name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  };
  const js = (value) => JSON.stringify(value);
  const evaluate = async (label, body) => {
    try {
      const raw = await win.webContents.executeJavaScript(`(async()=>{${body}})()`);
      return raw === undefined ? {} : JSON.parse(raw);
    } catch (error) {
      failures.push(label + ' 执行失败：' + String((error && error.message) || error).slice(0, 500));
      return {};
    }
  };
  const report = {};
  // 第十三轮必须跑“新工具”语义：不给 legacyMock，直接让真实 team.mjs 工作。
  // owner/workflow/req review/vote 命令存在时走真实命令；旧工具缺命令时才由壳层收口。
  const toolsModule = require('./team-tools');
  teamTools = toolsModule.create({ teamRoot: teamTools.layout.root });
  const promptBefore = mock.counters.sessionPrompt;
  let promptAfterSetup = promptBefore;
  try {
    // 1) Fast 项目：4 角色目录/会话，product/programmer2 不创建。
    const setup = await evaluate('创建第十三轮 Fast 项目', `
      const created = await window.workbench.createProject({
        name: '第十三轮快速', root: ${js(testRoot)}, teamMode: 'fast'
      });
      const s = await window.workbench.state();
      const p = s.projects.find((x) => x.id === created.project.id);
      const provision = await window.workbench.dshProvision({ projectId: p.id });
      const members = await window.workbench.teamMembers({ projectId: p.id });
      return JSON.stringify({
        projectId: p.id, path: p.path, name: p.name,
        teamMode: p.teamMode, roleIds: p.roleIds,
        provisionCreated: (provision.created || []).length,
        provisionMapping: provision.mapping ? provision.mapping.sessionCount : -1,
        provisionRoleIds: provision.roleIds || [],
        memberRoles: (members.roles || []).map((row) => row.role),
        modes: (s.teamModes || []).map((row) => ({ id: row.id, roles: row.roleIds })),
        defaultMode: s.defaultTeamMode
      });
    `);
    // 建团队会 seed “已就位”；之后的评审/投票/技术评审全程不得再发 prompt。
    promptAfterSetup = mock.counters.sessionPrompt;
    expect('Fast 项目创建并建齐 4 个角色会话',
      Boolean(setup.projectId) && setup.teamMode === 'fast'
      && Array.isArray(setup.roleIds) && setup.roleIds.join(',') === 'pm,analyst,programmer1,tester'
      && setup.provisionCreated === 4 && setup.provisionMapping === 4
      && Array.isArray(setup.memberRoles) && setup.memberRoles.length === 4, setup);
    const projectId = setup.projectId;
    const projectPath = setup.path;
    if (!projectId || !projectPath) return { report, failures };
    expect('默认团队模式是 full', setup.defaultMode === 'full'
      && Array.isArray(setup.modes) && setup.modes.find((row) => row.id === 'full').roles.length === 6, setup.modes);
    const dirs = {
      product: fs.existsSync(path.join(projectPath, '产品')),
      programmer2: fs.existsSync(path.join(projectPath, '程序员B')),
      analyst: fs.existsSync(path.join(projectPath, '需求分析师')),
      programmer1: fs.existsSync(path.join(projectPath, '程序员A')),
      tester: fs.existsSync(path.join(projectPath, '测试人员'))
    };
    expect('Fast 不创建 product/programmer2 目录', dirs.product === false && dirs.programmer2 === false, dirs);
    expect('Fast 创建 analyst/programmer1/tester 目录', dirs.analyst && dirs.programmer1 && dirs.tester, dirs);
    const fastSessions = mock.sessions.filter((session) => session.cwd
      && path.resolve(String(session.cwd)).toLowerCase() === path.resolve(projectPath).toLowerCase());
    const fastTitles = fastSessions.map((session) => String((session.projections && session.projections.values && session.projections.values.title) || ''));
    expect('Fast DSH 只创建 4 个角色会话', fastSessions.length === 4, fastSessions.map((s) => s.sessionId));
    expect('Fast 不创建产品/程序员B会话', !fastTitles.includes('团队·产品设计师') && !fastTitles.includes('团队·高级程序员 B'), fastTitles);

    // 1.1) teamMode 必须由旧工具落盘：项目创建后 项目.json/workspace.json 都是 fast；
    //      切换 full/fast 也只走旧 workspace.mjs 接口，不手写私有格式。
    const readModeFiles = () => {
      const projectFile = path.join(teamTools.layout.projectsDir, teamTools.teamSlug(setup.name, 60), '项目.json');
      const workspaceFile = path.join(projectPath, 'workspace.json');
      let projectJson = null;
      let workspaceJson = null;
      try { projectJson = JSON.parse(fs.readFileSync(projectFile, 'utf8').replace(/^\uFEFF/, '')); } catch { /* 缺失即失败 */ }
      try { workspaceJson = JSON.parse(fs.readFileSync(workspaceFile, 'utf8').replace(/^\uFEFF/, '')); } catch { /* 缺失即失败 */ }
      return {
        projectMode: projectJson ? projectJson.teamMode : '',
        workspaceMode: workspaceJson ? workspaceJson.teamMode : '',
        workspaceRoles: workspaceJson && Array.isArray(workspaceJson.roles) ? workspaceJson.roles.length : -1,
        projectFile,
        workspaceFile
      };
    };
    const fastModeFiles = readModeFiles();
    expect('Fast 创建即写入旧工具 项目.json/workspace.json',
      fastModeFiles.projectMode === 'fast' && fastModeFiles.workspaceMode === 'fast'
      && fastModeFiles.workspaceRoles === 4, fastModeFiles);
    const toFull = await evaluate('切到 Full（只同步团队文件）', `
      const r = await window.workbench.teamEnsureProject({ projectId: ${js(projectId)}, teamMode: 'full' });
      return JSON.stringify({ ok: r.ok, teamMode: r.teamMode, roleIds: r.roleIds });
    `);
    const fullModeFiles = readModeFiles();
    expect('切换 Full 写入旧工具 项目.json/workspace.json',
      toFull.ok === true && toFull.teamMode === 'full'
      && fullModeFiles.projectMode === 'full' && fullModeFiles.workspaceMode === 'full'
      && fullModeFiles.workspaceRoles === 6, { toFull, fullModeFiles });
    const backFast = await evaluate('切回 Fast（只同步团队文件）', `
      const r = await window.workbench.teamEnsureProject({ projectId: ${js(projectId)}, teamMode: 'fast' });
      return JSON.stringify({ ok: r.ok, teamMode: r.teamMode, roleIds: r.roleIds, mapping: r.mapping && r.mapping.sessionCount });
    `);
    const backFastFiles = readModeFiles();
    expect('切回 Fast 写回旧工具且会话映射仍是 4',
      backFast.ok === true && backFast.teamMode === 'fast' && backFast.mapping === 4
      && backFastFiles.projectMode === 'fast' && backFastFiles.workspaceMode === 'fast'
      && backFastFiles.workspaceRoles === 4, { backFast, backFastFiles });

    // 1.2) 恢复/接管 Fast 项目：没有状态库记录时必须读 项目.json.teamMode，
    //      不能被 normalizeTeamMode(undefined)=full 覆盖。
    const restoreName = '恢复快四';
    const restorePath = path.join(testRoot, '恢复快四');
    fs.mkdirSync(restorePath, { recursive: true });
    const restoreSeed = await teamTools.ensureProjectReady(
      { name: restoreName, path: restorePath, teamMode: 'fast' },
      { name: restoreName, teamMode: 'fast', allowExternal: true }
    );
    expect('恢复测试项目由团队工具按 fast 建好', restoreSeed.ok === true && restoreSeed.teamMode === 'fast', restoreSeed);
    const restoreDry = await evaluate('Fast 项目恢复 dry-run', `
      const r = await window.workbench.teamRestore({ name: ${js(restoreName)}, dryRun: true });
      return JSON.stringify({
        ok: r.ok, code: r.code || '', teamMode: r.teamMode,
        roles: r.roles || r.roleIds || [], restore: r.restore
      });
    `);
    const restoreCfg = JSON.parse(fs.readFileSync(
      path.join(teamTools.layout.projectsDir, teamTools.teamSlug(restoreName, 60), '项目.json'), 'utf8'));
    expect('恢复 Fast 项目优先读 项目.json.teamMode，不被默认 full 覆盖',
      restoreDry.ok === true && restoreDry.teamMode === 'fast' && restoreCfg.teamMode === 'fast', { restoreDry, restoreCfg });
    const adoptedFast = await evaluate('接管 Fast 项目', `
      const r = await window.workbench.adoptProject({ path: ${js(restorePath)} });
      return JSON.stringify({
        ok: r.ok, code: r.code || '', id: r.project && r.project.id,
        teamMode: r.project && r.project.teamMode,
        roleIds: r.project && r.project.roleIds
      });
    `);
    const adoptedCfg = JSON.parse(fs.readFileSync(
      path.join(teamTools.layout.projectsDir, teamTools.teamSlug(restoreName, 60), '项目.json'), 'utf8'));
    expect('接管 Fast 项目后 项目.json/本地记录仍为 fast，不补建完整六角色',
      adoptedFast.ok === true && adoptedFast.teamMode === 'fast'
      && Array.isArray(adoptedFast.roleIds) && adoptedFast.roleIds.join(',') === 'pm,analyst,programmer1,tester'
      && adoptedCfg.teamMode === 'fast', { adoptedFast, adoptedCfg });

    // 2) Owner 需求：Fast 由 analyst 评审，Owner 后进入开发技术评审，技术评审通过才 ready。
    const demand = await evaluate('Fast Owner 提需求', `
      const r = await window.workbench.ownerDemand({
        projectId: ${js(projectId)}, description: 'Fast Owner 需求 A',
        priority: 'P1', acceptanceCriteria: ['A1 可测', 'A2 可测']
      });
      return JSON.stringify({ ok: r.ok, code: r.code || '', id: r.requirement && r.requirement.id, status: r.requirement && r.requirement.status });
    `);
    expect('Fast Owner 需求由 PM 建档', demand.ok === true && /^R-/.test(String(demand.id || '')) && demand.status === 'review', demand);
    const reqId = String(demand.id || '');
    const productReview = await evaluate('Fast 产品评审被拒绝', `
      const r = await window.workbench.requirementReview({ projectId: ${js(projectId)}, role: 'product', requirementId: ${js(reqId)}, verdict: 'approve', comment: '产品越权评审' });
      return JSON.stringify({ ok: r.ok, code: r.code || '' });
    `);
    expect('Fast 只有 analyst 能评审', productReview.ok === false && productReview.code === 'ROLE_NOT_ALLOWED', productReview);
    const fastReview = await evaluate('Fast analyst 评审', `
      const boot = await window.workbench.workflowBoot({ projectId: ${js(projectId)}, role: 'analyst' });
      const r = await window.workbench.requirementReview({ projectId: ${js(projectId)}, role: 'analyst', requirementId: ${js(reqId)}, verdict: 'approve', comment: '需求分析师评审通过，验收标准可测。' });
      return JSON.stringify({
        boot: Boolean(boot.ok && boot.bootRead && boot.bootRead.complete),
        ok: r.ok, code: r.code || '', status: r.requirement && r.requirement.status,
        by: r.requirement && r.requirement.productReview && r.requirement.productReview.by,
        reviewRole: r.requirement && r.requirement.reviewRole
      });
    `);
    expect('Fast analyst 评审通过并记录评审人', fastReview.boot === true && fastReview.ok === true
      && fastReview.status === 'approved' && fastReview.by === 'analyst' && fastReview.reviewRole === 'analyst', fastReview);
    const fastOwner = await evaluate('Fast Owner 一次点击', `
      await window.workbench.workflowBoot({ projectId: ${js(projectId)}, role: 'analyst' });
      const r = await window.workbench.requirementOwner({ projectId: ${js(projectId)}, role: 'owner', requirementId: ${js(reqId)}, decision: 'approved', opinion: 'Owner 通过', ownerConfirmed: true });
      return JSON.stringify({
        ok: r.ok, code: r.code || '', status: r.requirement && r.requirement.status,
        driver: r.driver, shellOwned: Boolean(r.legacy && r.legacy.shellOwned),
        commandAvailable: r.legacy && r.legacy.commandAvailable,
        commandImplemented: r.legacy && r.legacy.commandImplemented,
        legacyCommandAvailable: r.legacy && r.legacy.legacyCommandAvailable,
        actor: r.requirement && r.requirement.ownerReview && r.requirement.ownerReview.actor
      });
    `);
    expect('Fast Owner 通过后进入开发技术评审', fastOwner.ok === true && fastOwner.status === 'tech_review', fastOwner);
    // Owner/工作流命令已升级为真实命令：允许真实 team.mjs 成功，也允许旧工具缺命令时的壳层收口，
    // 但两条路径都必须证明“动作可用 + 业务状态进入 tech_review + actor=owner”，不能只改返回值就放行。
    const fastOwnerReal = fastOwner.code === 'OK' && fastOwner.driver === 'team.mjs owner'
      && fastOwner.shellOwned === false && fastOwner.commandImplemented === true
      && fastOwner.legacyCommandAvailable === true;
    const fastOwnerShell = fastOwner.code === 'OWNER_SHELL_OWNED' && fastOwner.driver === 'workbench owner'
      && fastOwner.shellOwned === true && fastOwner.commandImplemented === false
      && fastOwner.legacyCommandAvailable === false;
    expect('Fast Owner 走真实 owner 命令或壳层收口：动作可用且 actor=owner/tech_review 落账',
      fastOwner.ok === true && fastOwner.status === 'tech_review' && fastOwner.actor === 'owner'
      && fastOwner.commandAvailable === true && (fastOwnerReal || fastOwnerShell), fastOwner);
    const fastCaps = await evaluate('Fast 能力矩阵', `
      const r = await window.workbench.workflowState({ projectId: ${js(projectId)} });
      const caps = r.legacy && r.legacy.capabilities;
      return JSON.stringify({
        ok: r.ok, owner: caps && caps.commands && caps.commands.owner,
        workflow: caps && caps.commands && caps.commands.workflow,
        shellOwned: caps && caps.shellOwned,
        shellOwnedActions: caps && caps.shellOwnedActions,
        legacyCommandAvailable: caps && caps.legacyCommandAvailable,
        missing: r.legacy && r.legacy.missingCommands
      });
    `);
    const fastOwnerCapsReal = fastCaps.legacyCommandAvailable && fastCaps.legacyCommandAvailable.owner === true;
    const fastOwnerCapsShell = Array.isArray(fastCaps.shellOwned) && fastCaps.shellOwned.includes('owner');
    expect('Fast UI 能力矩阵 owner 动作可用（真实 owner 命令或壳层收口），且不把可用动作列进 missing',
      fastCaps.ok === true && fastCaps.owner === true
      && Array.isArray(fastCaps.missing) && !fastCaps.missing.includes('owner')
      && (fastOwnerCapsReal || fastOwnerCapsShell), fastCaps);
    const earlyDispatch = await evaluate('Fast 技术评审前不得派单', `
      await window.workbench.workflowBoot({ projectId: ${js(projectId)}, role: 'pm' });
      const r = await window.workbench.requirementDispatch({ projectId: ${js(projectId)}, role: 'pm', requirementId: ${js(reqId)}, owner: 'programmer1' });
      return JSON.stringify({ ok: r.ok, code: r.code || '' });
    `);
    expect('Fast 技术评审前不能派单', earlyDispatch.ok === false
      && ['REQUIREMENT_NOT_APPROVED', 'TECH_REVIEW_REQUIRED'].includes(earlyDispatch.code), earlyDispatch);
    const fastTech = await evaluate('Fast 开发技术评审', `
      await window.workbench.workflowBoot({ projectId: ${js(projectId)}, role: 'programmer1' });
      const r = await window.workbench.requirementTechReview({ projectId: ${js(projectId)}, role: 'programmer1', requirementId: ${js(reqId)}, verdict: 'approve', comment: '实现可行，风险可控。', evidence: 'Fast 技术评审证据' });
      return JSON.stringify({
        ok: r.ok, code: r.code || '', status: r.requirement && r.requirement.status,
        verdict: r.techReview && r.techReview.verdict,
        trId: r.trId || (r.techReview && r.techReview.trId) || '',
        trFile: r.trFile || (r.techReview && r.techReview.trFile) || '',
        commandAvailable: r.legacy && r.legacy.commandAvailable,
        argv: r.legacy && r.legacy.argv
      });
    `);
    expect('Fast 开发技术评审通过 → ready', fastTech.ok === true && fastTech.status === 'ready' && fastTech.verdict === 'approve', fastTech);
    expect('技术评审真实调用 req review --kind tech 且 commandAvailable 为真',
      fastTech.commandAvailable === true && Array.isArray(fastTech.argv)
      && fastTech.argv.includes('--kind') && fastTech.argv.includes('tech'), fastTech);
    const trDir = path.join(teamTools.layout.projectsDir, teamTools.teamSlug(setup.name, 60), '技术评审');
    const trFiles = (() => {
      try { return fs.readdirSync(trDir).filter((name) => /^TR-.*\.json$/.test(name)); } catch { return []; }
    })();
    const trRaw = trFiles.length ? JSON.parse(fs.readFileSync(path.join(trDir, trFiles[0]), 'utf8')) : null;
    expect('技术评审落 技术评审/TR-*.json（kind/role/teamMode 正确）',
      Boolean(trRaw) && trRaw.id === fastTech.trId && trRaw.kind === 'tech'
      && trRaw.role === 'programmer1' && trRaw.teamMode === 'fast'
      && String(trRaw.requirementId) === String(reqId), { trFiles, trRaw, fastTech });

    // 3) 投票驳回 Owner 需求：3 个非 PM 角色一致 reject 才生效。
    const demandB = await evaluate('Fast 第二条 Owner 需求', `
      const r = await window.workbench.ownerDemand({
        projectId: ${js(projectId)}, description: 'Fast Owner 需求 B（投票驳回）',
        priority: 'P2', acceptanceCriteria: ['B1 可测']
      });
      return JSON.stringify({ ok: r.ok, code: r.code || '', id: r.requirement && r.requirement.id, queued: r.requirement && r.requirement.queued });
    `);
    expect('Fast 第二条 Owner 需求建档', demandB.ok === true && /^R-/.test(String(demandB.id || '')), demandB);
    const reqB = String(demandB.id || '');
    const badStart = await evaluate('Fast 非法角色不能发起投票', `
      const r = await window.workbench.voteStart({ projectId: ${js(projectId)}, role: 'owner', requirementId: ${js(reqB)}, reason: 'Owner 越权发起' });
      return JSON.stringify({ ok: r.ok, code: r.code || '' });
    `);
    expect('投票发起人只接受 PM / 旧界面 analyst 入口', badStart.ok === false && badStart.code === 'ROLE_NOT_ALLOWED', badStart);
    const voteStart = await evaluate('Fast analyst 发起投票', `
      const r = await window.workbench.voteStart({
        projectId: ${js(projectId)}, role: 'analyst', requirementId: ${js(reqB)},
        reason: '需求与 Owner 目标不一致', evidence: '验收标准冲突：B1 不可测'
      });
      return JSON.stringify({
        ok: r.ok, code: r.code || '',
        initiator: r.initiator, requestedBy: r.requestedBy,
        stamped: r.initiatorStamped,
        vote: r.vote && { id: r.vote.id, status: r.vote.status, eligible: r.vote.eligibleRoles, counts: r.vote.counts, initiator: r.vote.initiator, initiatorCommand: r.vote.initiatorCommand }
      });
    `);
    const voteId = String(voteStart.vote && voteStart.vote.id || '');
    expect('Fast 投票发起成功（3 个非 PM 角色）', voteStart.ok === true && voteStart.vote
      && voteStart.vote.status === 'open' && voteStart.vote.eligible.join(',') === 'analyst,programmer1,tester'
      && voteStart.vote.counts.reject === 1, voteStart);
    // 发起人归属：工作台的实际发起人是 analyst（V 文件也必须是 analyst，不是执行旧命令的 pm）。
    expect('投票发起人按实际发起人返回 analyst',
      voteStart.vote && voteStart.vote.initiator === 'analyst'
      && voteStart.initiator === 'analyst'
      && voteStart.requestedBy === 'analyst'
      && voteStart.stamped && voteStart.stamped.ok === true, voteStart);
    expect('V 文件保留旧命令执行者（createdByCommand=pm，不伪造）',
      voteStart.vote && voteStart.vote.initiatorCommand === 'pm', voteStart.vote);
    const pmCast = await evaluate('Fast PM 不能投票', `
      const r = await window.workbench.voteCast({ projectId: ${js(projectId)}, role: 'pm', voteId: ${js(voteId)}, verdict: 'reject', reason: 'PM 不参与' });
      return JSON.stringify({ ok: r.ok, code: r.code || '' });
    `);
    expect('PM 被排除在投票之外', pmCast.ok === false && pmCast.code === 'VOTE_PM_EXCLUDED', pmCast);
    const cast1 = await evaluate('Fast programmer1 reject', `
      const r = await window.workbench.voteCast({ projectId: ${js(projectId)}, role: 'programmer1', voteId: ${js(voteId)}, verdict: 'reject', reason: '实现成本过高', evidence: '需要重写数据层' });
      return JSON.stringify({ ok: r.ok, code: r.code || '', status: r.vote && r.vote.status, counts: r.vote && r.vote.counts });
    `);
    expect('差一票时投票仍 open', cast1.ok === true && cast1.status === 'open' && cast1.counts.reject === 2, cast1);
    // DSH 角色直接执行 team.mjs vote cast：不经过工作台 IPC，只写 投票/V-*.json。
    // 随后工作台 vote:status 必须读到同一张票，并把需求收口为 rejected。
    const testerBoot = await teamTools.bootToken(setup.name, 'tester', {});
    let testerCast = null;
    if (testerBoot.ok) {
      const run = await teamTools.runNode(path.join(teamTools.layout.toolRoot, 'team.mjs'), [
        'vote', 'cast', '--boot', testerBoot.token, '--id', voteId,
        '--vote', 'reject', '--comment', '验收标准不可测\n证据：无法构造测试数据', '--json'
      ], { timeoutMs: 60000 });
      testerCast = {
        ok: run.ok && !(run.value && run.value.ok === false),
        code: (run.value && run.value.code) || (run.ok ? 'OK' : 'RUN_FAILED'),
        value: run.value,
        stderr: String(run.stderr || '').slice(-500)
      };
    }
    expect('DSH 角色直接 vote cast 写同一 投票/V-*.json',
      Boolean(testerBoot.ok) && Boolean(testerCast && testerCast.ok
        && testerCast.value && testerCast.value.vote && String(testerCast.value.vote.id) === voteId),
      testerCast || testerBoot);
    const cast2 = await evaluate('工作台读取 DSH 角色的票并收口需求', `
      const r = await window.workbench.voteStatus({ projectId: ${js(projectId)}, requirementId: ${js(reqB)} });
      return JSON.stringify({
        ok: r.ok, code: r.code || '', status: r.vote && r.vote.status,
        counts: r.vote && r.vote.counts,
        casts: r.vote && r.vote.casts,
        req: r.requirement && r.requirement.status,
        reconciled: r.reconciled
      });
    `);
    expect('3/3 一致 reject 驳回 Owner 需求', cast2.ok === true && cast2.status === 'passed'
      && cast2.counts.reject === 3 && cast2.req === 'rejected', cast2);
    const voteStatus = await evaluate('Fast vote:status', `
      const r = await window.workbench.voteStatus({ projectId: ${js(projectId)}, requirementId: ${js(reqB)} });
      return JSON.stringify({
        ok: r.ok, status: r.vote && r.vote.status,
        casts: r.vote && r.vote.casts, reason: r.vote && r.vote.reason, evidence: r.vote && r.vote.evidence
      });
    `);
    expect('投票回放逐角色理由/证据', voteStatus.ok === true && voteStatus.status === 'passed'
      && Array.isArray(voteStatus.casts) && voteStatus.casts.length === 3
      && voteStatus.casts.every((row) => row.reason && row.evidence), voteStatus);

    // 4) 非一致 reject 只能 blocked，不能驳回 Owner 需求。
    const demandC = await evaluate('Fast 第三条 Owner 需求', `
      const r = await window.workbench.ownerDemand({
        projectId: ${js(projectId)}, description: 'Fast Owner 需求 C（投票 blocked）',
        priority: 'P3', acceptanceCriteria: ['C1 可测']
      });
      return JSON.stringify({ ok: r.ok, code: r.code || '', id: r.requirement && r.requirement.id });
    `);
    const reqC = String(demandC.id || '');
    const blocked = await evaluate('Fast 投票非一致 reject', `
      const started = await window.workbench.voteStart({ projectId: ${js(projectId)}, role: 'analyst', requirementId: ${js(reqC)}, reason: '发起 blocked 探针', evidence: 'C 需求证据' });
      const cast = await window.workbench.voteCast({ projectId: ${js(projectId)}, role: 'programmer1', voteId: started.vote && started.vote.id, verdict: 'approve', reason: '我不同意驳回' });
      const cast2 = await window.workbench.voteCast({ projectId: ${js(projectId)}, role: 'tester', voteId: started.vote && started.vote.id, verdict: 'approve', reason: '测试也不想驳回' });
      return JSON.stringify({
        startOk: started.ok, castOk: Boolean(cast.ok && cast2.ok), code: cast2.code || '',
        status: cast2.vote && cast2.vote.status, result: cast2.vote && cast2.vote.result,
        counts: cast2.vote && cast2.vote.counts,
        req: cast2.requirement && cast2.requirement.status
      });
    `);
    expect('非一致 reject 投票 blocked（团队工具 approved）且需求不驳回', blocked.startOk === true && blocked.castOk === true
      && blocked.status === 'blocked' && blocked.result === 'approved'
      && blocked.counts.approve === 2 && blocked.req !== 'rejected', blocked);

    // 5) Full 模式同一套投票 API：除 PM 外 5 个角色，证明 Full/Fast 通用。
    const fullVote = await evaluate('Full 模式投票', `
      const created = await window.workbench.createProject({ name: '第十三轮完整', root: ${js(testRoot)}, teamMode: 'full' });
      const demand = await window.workbench.ownerDemand({
        projectId: created.project.id, description: 'Full Owner 需求（投票）',
        priority: 'P2', acceptanceCriteria: ['Full 投票可测']
      });
      const started = await window.workbench.voteStart({
        projectId: created.project.id, role: 'analyst', requirementId: demand.requirement && demand.requirement.id,
        reason: 'Full 模式投票探针', evidence: 'Full 证据'
      });
      return JSON.stringify({
        ok: started.ok, projectMode: created.project.teamMode,
        eligible: started.vote && started.vote.eligibleRoles,
        counts: started.vote && started.vote.counts
      });
    `);
    expect('Full 投票包含 5 个非 PM 角色', fullVote.ok === true && fullVote.projectMode === 'full'
      && Array.isArray(fullVote.eligible) && fullVote.eligible.join(',') === 'product,analyst,programmer1,programmer2,tester'
      && fullVote.counts && fullVote.counts.eligible === 5, fullVote);

    expect('第十三轮评审/投票/技术评审不向 DSH 发 prompt', mock.counters.sessionPrompt === promptAfterSetup, {
      afterSetup: promptAfterSetup, after: mock.counters.sessionPrompt
    });
    const workflowFile = path.join(teamTools.layout.projectsDir, teamTools.teamSlug(setup.name, 60), '工作流.json');
    const drive = path.parse(path.resolve(workflowFile)).root.toLowerCase();
    expect('第十三轮状态全在 D 盘', drive === path.parse(ROOT).root.toLowerCase(), { workflowFile, drive });
    const workflowRaw = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));
    const fastReqRaw = workflowRaw.requirements && workflowRaw.requirements[reqId];
    expect('技术评审结果写入 工作流.json（trId 与 TR 文件一致）',
      Boolean(fastReqRaw && fastReqRaw.techReview
        && String(fastReqRaw.techReview.trId) === String(fastTech.trId)
        && fastReqRaw.techReview.verdict === 'approve'
        && fastReqRaw.status === 'ready'), fastReqRaw && fastReqRaw.techReview);
    const voteFile = path.join(teamTools.layout.projectsDir, teamTools.teamSlug(setup.name, 60), '投票', voteId + '.json');
    const voteRaw = JSON.parse(fs.readFileSync(voteFile, 'utf8'));
    expect('投票落 投票/V-*.json（closed/rejected/3 人 eligible）',
      Boolean(voteRaw) && voteRaw.id === voteId && voteRaw.kind === 'requirement'
      && voteRaw.status === 'closed' && voteRaw.result === 'rejected'
      && Array.isArray(voteRaw.eligible) && voteRaw.eligible.join(',') === 'analyst,programmer1,tester'
      && voteRaw.votes && Object.keys(voteRaw.votes).length === 3, voteRaw);
    // 发起人归属：V 文件是投票唯一真相，必须写实际发起人 analyst；执行旧命令的是 pm，另存审计。
    expect('V 文件发起人按实际发起人写 analyst（不是 pm）',
      voteRaw.createdBy === 'analyst' && voteRaw.initiator === 'analyst'
      && voteRaw.createdByCommand === 'pm', {
      createdBy: voteRaw.createdBy, initiator: voteRaw.initiator, createdByCommand: voteRaw.createdByCommand
    });
    expect('工作流.json 不复制票数（工作流.json.votes 为空）',
      !workflowRaw.votes || Object.keys(workflowRaw.votes).length === 0, workflowRaw.votes);
    // rejected 视为已收口：构造一个只有 rejected 的状态，iterateGuard 必须放行；
    // 同样构造 review，必须仍然阻塞，证明不是把闸门整体删掉。
    const guardRejected = teamTools.iterateGuard('P0-GUARD', {
      round: 1,
      requirements: { 'R-GUARD-REJECTED': { id: 'R-GUARD-REJECTED', status: 'rejected', round: 1, queued: false } }
    }, { projectPath: path.join(testRoot, 'p0-guard-empty') });
    const guardReview = teamTools.iterateGuard('P0-GUARD', {
      round: 1,
      requirements: { 'R-GUARD-REVIEW': { id: 'R-GUARD-REVIEW', status: 'review', round: 1, queued: false } }
    }, { projectPath: path.join(testRoot, 'p0-guard-empty') });
    expect('rejected 视为已收口，iterateGuard 放行且 review 仍阻塞',
      guardRejected.ok === true && guardReview.ok === false
      && guardReview.code === 'ITERATE_BLOCKED', { guardRejected, guardReview });
    report.final = {
      projectId, reqId, reqB, reqC, voteId,
      fastRoles: setup.roleIds,
      provisionCreated: setup.provisionCreated,
      fastStatus: fastTech.status,
      voteStatus: voteStatus.status,
      blockedStatus: blocked.status,
      workflowFile,
      prompts: { before: promptBefore, after: mock.counters.sessionPrompt }
    };
  } catch (error) {
    failures.push('第十三轮团队模式自测异常：' + String((error && error.stack) || error).slice(0, 1000));
  }
  return { report, failures };
}

function booleanBoardWindow() {
  return Boolean(teamBoardWindow && !teamBoardWindow.isDestroyed());
}

/**
 * 第十四轮：dry-run 只读承诺、Full 模式 owner/workflow 收口、投票发起人归属、驳回后阶段。
 *
 * 与第十轮（mock 旧命令全可用）/第十三轮（Fast 真实命令或壳层收口）互补：这一轮跑真实 team.mjs，
 * owner/workflow 命令存在时走真实命令，缺命令时才壳层收口；dry-run 不写任何状态。
 */
async function selftestRound14(win, testRoot) {
  const failures = [];
  const expect = (name, condition, detail) => {
    if (!condition) failures.push(name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  };
  const js = (value) => JSON.stringify(value);
  const evaluate = async (label, body) => {
    try {
      const raw = await win.webContents.executeJavaScript(`(async()=>{${body}})()`);
      return raw === undefined ? {} : JSON.parse(raw);
    } catch (error) {
      failures.push(label + ' 执行失败：' + String((error && error.message) || error).slice(0, 500));
      return {};
    }
  };
  const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
  const readJson = (file) => { try { return JSON.parse(readText(file)); } catch { return null; } };
  const fileFingerprint = (file) => {
    const text = readText(file);
    return {
      exists: fs.existsSync(file),
      bytes: text.length,
      sha: text ? crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) : ''
    };
  };
  const report = {};
  const storeFile = process.env.AWB_STORE || path.join(SELFTEST_ROOT, 'workbench.json');
  const rosterFile = path.join(teamTools.layout.root, '状态', '团队.json');
  try {
    // 1) team:restore / team:open-project 的 dryRun 必须在 setProjectTeamMode 之前返回：
    //    用 full 项目请求 fast dry-run，磁盘上不能有任何字节变化（状态库/名册/项目.json/workspace.json）。
    const mk = await evaluate('第十四轮建只读项目', `
      const created = await window.workbench.createProject({ name: '第十四轮只读', root: ${js(testRoot)}, teamMode: 'full' });
      const s = await window.workbench.state();
      const p = s.projects.find((x) => x.id === created.project.id);
      return JSON.stringify({
        projectId: p.id, path: p.path, name: p.name, teamName: p.teamName || p.name, teamMode: p.teamMode
      });
    `);
    expect('第十四轮只读项目创建成功（full）', Boolean(mk.projectId) && mk.teamMode === 'full', mk);
    if (!mk.projectId) return { report, failures };
    const stateDir = path.join(teamTools.layout.projectsDir, teamTools.teamSlug(mk.teamName, 60));
    const configFile = path.join(stateDir, '项目.json');
    const workspaceFile = path.join(mk.path, 'workspace.json');
    const before = {
      store: fileFingerprint(storeFile),
      roster: fileFingerprint(rosterFile),
      config: fileFingerprint(configFile),
      workspace: fileFingerprint(workspaceFile)
    };
    const dryRestore = await evaluate('restore dry-run（full → fast 预览）', `
      const r = await window.workbench.teamRestore({ name: ${js(mk.name)}, teamMode: 'fast', dryRun: true });
      return JSON.stringify({
        ok: r.ok, dryRun: r.dryRun, teamMode: r.teamMode, restore: r.restore,
        projectDir: r.projectDir, roles: r.roles || [], plan: Array.isArray(r.plan) ? r.plan.length : -1,
        writes: r.writes || null, mapping: r.mapping || null, reload: r.reload
      });
    `);
    expect('team:restore dry-run 成功并声明只读', dryRestore.ok === true && dryRestore.dryRun === true
      && dryRestore.restore === true && Boolean(dryRestore.projectDir), dryRestore);
    expect('team:restore dry-run 以 fast 预览（不写项目模式）', dryRestore.teamMode === 'fast'
      && Array.isArray(dryRestore.roles) && dryRestore.roles.join(',') === 'pm,analyst,programmer1,tester'
      && dryRestore.plan === 4, dryRestore);
    expect('team:restore dry-run 写面全 false 且不返回映射', dryRestore.writes
      && dryRestore.writes.projectConfig === false && dryRestore.writes.store === false
      && dryRestore.writes.roster === false && dryRestore.mapping === null && dryRestore.reload === false, dryRestore);
    const dryOpen = await evaluate('open-project dry-run（full → fast 预览）', `
      const r = await window.workbench.teamOpenProject({ path: ${js(mk.path)}, teamMode: 'fast', dryRun: true });
      return JSON.stringify({
        ok: r.ok, dryRun: r.dryRun, opened: r.opened, teamMode: r.teamMode, projectDir: r.projectDir,
        roles: r.roles || [], plan: Array.isArray(r.plan) ? r.plan.length : -1,
        writes: r.writes || null, mapping: r.mapping || null, reload: r.reload
      });
    `);
    expect('team:open-project dry-run 成功并声明只读', dryOpen.ok === true && dryOpen.dryRun === true
      && dryOpen.opened === true && Boolean(dryOpen.projectDir), dryOpen);
    expect('team:open-project dry-run 以 fast 预览且写面全 false', dryOpen.teamMode === 'fast'
      && Array.isArray(dryOpen.roles) && dryOpen.roles.join(',') === 'pm,analyst,programmer1,tester'
      && dryOpen.writes && dryOpen.writes.projectConfig === false && dryOpen.writes.store === false
      && dryOpen.writes.roster === false && dryOpen.mapping === null && dryOpen.reload === false, dryOpen);
    const after = {
      store: fileFingerprint(storeFile),
      roster: fileFingerprint(rosterFile),
      config: fileFingerprint(configFile),
      workspace: fileFingerprint(workspaceFile)
    };
    const unchanged = Object.keys(before).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    expect('dry-run 前后状态库/名册/项目.json/workspace.json 一字节未变', unchanged.length === 0, { unchanged, before, after });
    const afterMode = JSON.parse(await win.webContents.executeJavaScript(`(async()=>{
      const s = await window.workbench.state();
      const p = s.projects.find((x) => x.id === ${js(mk.projectId)});
      return JSON.stringify({ teamMode: p && p.teamMode });
    })()`) || '{}');
    const storedMode = JSON.parse(readText(configFile) || '{}').teamMode;
    expect('dry-run 后项目模式仍是 full（状态库/项目.json 一致）',
      afterMode.teamMode === 'full' && storedMode === 'full', { afterMode, storedMode });
    report.dryRun = { unchanged: unchanged.length === 0, restoreMode: dryRestore.teamMode, openMode: dryOpen.teamMode, storedMode };

    // 2) Full 模式 Owner 决定：真实 owner 命令存在时走真实命令；缺命令时才壳层收口（明确 SHELL_OWNED）。
    const full = await evaluate('第十四轮建 Full 项目', `
      const created = await window.workbench.createProject({ name: '第十四轮壳层', root: ${js(testRoot)}, teamMode: 'full' });
      return JSON.stringify({ projectId: created.project.id, path: created.project.path, name: created.project.name });
    `);
    expect('第十四轮 Full 项目创建成功', Boolean(full.projectId), full);
    if (!full.projectId) return { report, failures };
    const bootPm = await evaluate('Full PM boot', `
      const r = await window.workbench.workflowBoot({ projectId: ${js(full.projectId)}, role: 'pm' });
      return JSON.stringify({ ok: Boolean(r.ok), code: r.code || '' });
    `);
    expect('Full 项目 PM boot', bootPm.ok === true, bootPm);
    const req1 = await evaluate('Full 需求创建', `
      const r = await window.workbench.requirementCreate({
        projectId: ${js(full.projectId)}, role: 'analyst', title: 'Full 壳层收口需求',
        priority: 'P1', acceptance: 'Owner 决定/验收/迭代/终止不再被旧命令卡死'
      });
      return JSON.stringify({ ok: r.ok, code: r.code || '', id: r.requirement && r.requirement.id });
    `);
    const req1Id = String(req1.id || '');
    expect('Full 需求创建走旧 req create', req1.ok === true && /^R-/.test(req1Id), req1);
    const bootProduct = await evaluate('Full 产品 boot', `
      const r = await window.workbench.workflowBoot({ projectId: ${js(full.projectId)}, role: 'product' });
      return JSON.stringify({ ok: Boolean(r.ok), code: r.code || '' });
    `);
    expect('Full 项目产品 boot', bootProduct.ok === true, bootProduct);
    const review1 = await evaluate('Full 产品评审通过', `
      const r = await window.workbench.requirementReview({
        projectId: ${js(full.projectId)}, role: 'product', requirementId: ${js(req1Id)},
        verdict: 'approve', comment: '需求评审通过：验收标准可测。'
      });
      return JSON.stringify({ ok: r.ok, code: r.code || '', status: r.requirement && r.requirement.status });
    `);
    expect('Full 产品评审通过走旧 req review', review1.ok === true && review1.status === 'approved', review1);
    await evaluate('Full 评审后产品重新 boot', `
      await window.workbench.workflowBoot({ projectId: ${js(full.projectId)}, role: 'product' });
      return JSON.stringify({ ok: true });
    `);
    const owner1 = await evaluate('Full Owner 决定（真实 owner 命令或壳层收口）', `
      const r = await window.workbench.requirementOwner({
        projectId: ${js(full.projectId)}, role: 'owner', requirementId: ${js(req1Id)},
        decision: 'approved', opinion: 'Owner 通过（第十四轮）', ownerConfirmed: true
      });
      return JSON.stringify({
        ok: r.ok, code: r.code || '', status: r.requirement && r.requirement.status,
        driver: r.driver, shellOwned: Boolean(r.shellOwned),
        legacyCommandStatus: r.legacyCommandStatus,
        commandAvailable: r.legacy && r.legacy.commandAvailable,
        commandImplemented: r.legacy && r.legacy.commandImplemented,
        legacyCommandAvailable: r.legacy && r.legacy.legacyCommandAvailable,
        actor: r.requirement && r.requirement.ownerReview && r.requirement.ownerReview.actor,
        workflowFile: r.workflowFile || '',
        phase: r.snapshot && r.snapshot.phase
      });
    `);
    expect('Full Owner 决定不再被旧 owner 命令卡死', owner1.ok === true && owner1.status === 'ready', owner1);
    // 真实 owner 命令存在时走 team.mjs owner（code=OK）；旧工具缺命令时才是壳层 OWNER_SHELL_OWNED。
    // 两条路径都必须验证业务结果：ready、phase=dispatch、actor=owner、工作流文件真实落盘。
    const owner1Real = owner1.code === 'OK' && owner1.driver === 'team.mjs owner'
      && owner1.shellOwned === false && owner1.legacyCommandStatus === 'AVAILABLE'
      && owner1.commandImplemented === true && owner1.legacyCommandAvailable === true;
    const owner1Shell = owner1.code === 'OWNER_SHELL_OWNED' && owner1.driver === 'workbench owner'
      && owner1.shellOwned === true && owner1.legacyCommandStatus === 'SHELL_OWNED'
      && owner1.commandImplemented === false && owner1.legacyCommandAvailable === false;
    expect('Full Owner 决定走真实 owner 命令或壳层收口：动作可用、actor=owner 且状态落盘',
      owner1.status === 'ready' && owner1.phase === 'dispatch' && owner1.actor === 'owner'
      && owner1.commandAvailable === true && Boolean(owner1.workflowFile)
      && fs.existsSync(owner1.workflowFile) && (owner1Real || owner1Shell), owner1);
    expect('Full Owner 通过后 phase=dispatch', owner1.phase === 'dispatch', owner1.phase);

    // 3) 能力矩阵：真实 owner/workflow 命令存在时如实标为可用；只有旧工具缺命令时
    //    才由壳层收口并写 shellOwnedActions。两种路径都必须把可用动作从 missing 移除。
    const caps = await evaluate('Full 能力矩阵', `
      const r = await window.workbench.workflowState({ projectId: ${js(full.projectId)} });
      const c = r.legacy && r.legacy.capabilities;
      return JSON.stringify({
        ok: r.ok,
        owner: c && c.commands && c.commands.owner,
        workflow: c && c.commands && c.commands.workflow,
        missing: r.legacy && r.legacy.missingCommands,
        shellOwned: c && c.shellOwned,
        shellOwnedActions: c && c.shellOwnedActions,
        legacyCommandAvailable: c && c.legacyCommandAvailable,
        actionSource: c && c.actionSource
      });
    `);
    const capsReal = caps.owner === true && caps.workflow === true
      && Array.isArray(caps.missing) && !caps.missing.includes('owner') && !caps.missing.includes('workflow')
      && (!caps.legacyCommandAvailable || caps.legacyCommandAvailable.owner !== false);
    const capsShell = Array.isArray(caps.shellOwnedActions)
      && ['owner-review', 'owner-accept', 'iterate', 'terminate'].every((action) => caps.shellOwnedActions.includes(action))
      && caps.legacyCommandAvailable && caps.legacyCommandAvailable.owner === false;
    expect('Full 能力矩阵 owner 动作可用且从 missing 移除', caps.ok === true && caps.owner === true
      && Array.isArray(caps.missing) && !caps.missing.includes('owner'), caps);
    expect('Full 能力矩阵 owner/workflow 动作可用（真实命令成功或壳层收口）',
      capsReal || capsShell, caps);
    expect('Full 能力矩阵按真实命令/壳层收口如实标注，不伪造',
      capsReal
        ? caps.workflow === true && caps.missing.length === 0
        : capsShell && caps.missing.includes('workflow'), caps);

    // 4) 被驳回需求：phase 必须回到 requirement_review，不停在 requirement。
    const req2 = await evaluate('Full 第二个需求', `
      const r = await window.workbench.requirementCreate({
        projectId: ${js(full.projectId)}, role: 'analyst', title: 'Full 被驳回需求',
        priority: 'P2', acceptance: '驳回后必须回到需求评审'
      });
      return JSON.stringify({ ok: r.ok, code: r.code || '', id: r.requirement && r.requirement.id });
    `);
    const req2Id = String(req2.id || '');
    await evaluate('Full 第二个需求产品 boot', `
      await window.workbench.workflowBoot({ projectId: ${js(full.projectId)}, role: 'product' });
      return JSON.stringify({ ok: true });
    `);
    const review2 = await evaluate('Full 产品评审驳回', `
      const r = await window.workbench.requirementReview({
        projectId: ${js(full.projectId)}, role: 'product', requirementId: ${js(req2Id)},
        verdict: 'reject', comment: '验收标准不可测，打回重写。'
      });
      return JSON.stringify({ ok: r.ok, code: r.code || '', status: r.requirement && r.requirement.status, phase: r.snapshot && r.snapshot.phase });
    `);
    expect('Full 评审驳回成功并落到 rejected', review2.ok === true && review2.status === 'rejected', review2);
    expect('被驳回需求后 phase=requirement_review（不停 requirement）',
      review2.phase === 'requirement_review', review2.phase);
    const stateAfterReject = await evaluate('驳回后 workflow:state', `
      const r = await window.workbench.workflowState({ projectId: ${js(full.projectId)} });
      return JSON.stringify({ ok: r.ok, phase: r.phase, stage: r.stage, status: (r.requirements || []).find((x) => x.id === ${js(req2Id)})?.status });
    `);
    expect('驳回后快照 phase/stage 与状态库一致', stateAfterReject.ok === true
      && stateAfterReject.phase === 'requirement_review' && stateAfterReject.stage === 'review'
      && stateAfterReject.status === 'rejected', stateAfterReject);

    // 5) Full 模式 iterate / terminate：真实 workflow 命令成功或旧工具缺命令时由壳层推进，
    //    两条路径都必须推进轮次/终止相位并写 工作流.json。
    const iter = await evaluate('第十四轮建迭代项目', `
      const created = await window.workbench.createProject({ name: '第十四轮迭代', root: ${js(testRoot)}, teamMode: 'full' });
      const boot = await window.workbench.workflowBoot({ projectId: created.project.id, role: 'pm' });
      return JSON.stringify({ projectId: created.project.id, name: created.project.name, boot: Boolean(boot.ok), bootCode: boot.code || '' });
    `);
    expect('Full 迭代项目创建并 PM boot', Boolean(iter.projectId) && iter.boot === true, iter);
    const iterate = await evaluate('Full 迭代（真实 workflow 或壳层收口）', `
      const r = await window.workbench.workflowIterate({ projectId: ${js(iter.projectId)}, role: 'pm', opinion: '第十四轮迭代' });
      return JSON.stringify({
        ok: r.ok, code: r.code || '', round: r.round, fromRound: r.fromRound,
        shellOwned: Boolean(r.shellOwned), legacyCommandStatus: r.legacyCommandStatus,
        driver: r.driver, workflowFile: r.workflowFile || '',
        warnings: (r.warnings || []).map((x) => x.code)
      });
    `);
    expect('Full 迭代不再被旧 workflow 命令卡死', iterate.ok === true && Number(iterate.round) === 2, iterate);
    const iterateReal = iterate.code === 'OK' && iterate.driver === 'team.mjs workflow'
      && iterate.shellOwned === false && iterate.legacyCommandStatus === 'AVAILABLE';
    const iterateShell = iterate.code === 'WORKFLOW_SHELL_OWNED' && iterate.driver === 'workbench workflow'
      && iterate.shellOwned === true && iterate.legacyCommandStatus === 'SHELL_OWNED'
      && Array.isArray(iterate.warnings) && iterate.warnings.includes('WORKFLOW_SHELL_OWNED');
    expect('Full 迭代走真实 workflow 命令或壳层收口：轮次=2 且工作流文件落盘',
      Number(iterate.round) === 2 && Boolean(iterate.workflowFile) && fs.existsSync(iterate.workflowFile)
      && (readJson(iterate.workflowFile) || {}).round === 2 && (iterateReal || iterateShell), iterate);
    await evaluate('迭代后 PM 重新 boot', `
      await window.workbench.workflowBoot({ projectId: ${js(iter.projectId)}, role: 'pm' });
      return JSON.stringify({ ok: true });
    `);
    const terminate = await evaluate('Full 终止（真实 workflow 或壳层收口）', `
      const r = await window.workbench.workflowTerminate({ projectId: ${js(iter.projectId)}, role: 'pm', opinion: '第十四轮终止' });
      return JSON.stringify({
        ok: r.ok, code: r.code || '', terminated: r.terminated,
        phase: r.snapshot && r.snapshot.phase, shellOwned: Boolean(r.shellOwned),
        legacyCommandStatus: r.legacyCommandStatus,
        driver: r.driver || '',
        commandImplemented: r.legacy && r.legacy.commandImplemented,
        workflowFile: r.workflowFile || '',
        warnings: (r.warnings || []).map((x) => x.code)
      });
    `);
    expect('Full 终止不再被旧 workflow 命令卡死并真收口', terminate.ok === true
      && terminate.terminated === true && terminate.phase === 'terminated', terminate);
    const terminateReal = terminate.code === 'OK' && terminate.driver === 'team.mjs workflow'
      && terminate.shellOwned === false && terminate.legacyCommandStatus === 'AVAILABLE'
      && terminate.commandImplemented === true;
    const terminateShell = terminate.code === 'WORKFLOW_SHELL_OWNED' && terminate.driver === 'workbench workflow'
      && terminate.shellOwned === true && terminate.legacyCommandStatus === 'SHELL_OWNED'
      && terminate.commandImplemented === false
      && Array.isArray(terminate.warnings) && terminate.warnings.includes('WORKFLOW_SHELL_OWNED');
    expect('Full 终止走真实 workflow 命令或壳层收口：terminated 落盘且不伪造旧命令',
      terminate.phase === 'terminated' && Boolean(terminate.workflowFile)
      && fs.existsSync(terminate.workflowFile)
      && (readJson(terminate.workflowFile) || {}).phase === 'terminated'
      && (terminateReal || terminateShell), terminate);

    report.owner = { code: owner1.code, driver: owner1.driver, status: owner1.status };
    report.caps = { owner: caps.owner, shellOwnedActions: caps.shellOwnedActions, missing: caps.missing };
    report.reject = { phase: review2.phase, status: review2.status };
    report.workflow = { iterateRound: iterate.round, iterateCode: iterate.code, terminateCode: terminate.code, phase: terminate.phase };
  } catch (error) {
    failures.push('第十四轮 dry-run/壳层收口自测异常：' + String((error && error.stack) || error).slice(0, 1000));
  }
  return { report, failures };
}

async function selftest() {
  const testRoot = SELFTEST_ROOT;
  // 清掉上一轮产物（保留本轮 Chromium userdata/tmp）；被遗留工具进程占用时重试，绝不换目录。
  const cleared = clearSelftestSandbox(testRoot);
  if (!cleared.ok) {
    console.error('SELFTEST_FAIL 无法清理上一轮自测目录（可能有遗留团队工具进程占用）：' + String(cleared.error && cleared.error.message || cleared.error));
    app.exit(1);
    return;
  }
  fs.mkdirSync(testRoot, { recursive: true });
  // launch.mjs 会在 <TEAM_ROOT>/工具/team.mjs 调 index；自测把状态根隔离在 .selftest-data，
  // 这里用目录联接（junction）把真实工具链接进去，既隔离状态，又不让索引刷新变成告警。
  try {
    fs.mkdirSync(path.join(testRoot, '团队'), { recursive: true });
    fs.symlinkSync(path.join(ROOT, '团队', '工具'), path.join(testRoot, '团队', '工具'), 'junction');
  } catch { /* 不支持联接时忽略：launch 会以 system/index 告警继续 */ }
  const cleanupRoot = () => {
    try { fs.unlinkSync(path.join(testRoot, '团队', '工具')); } catch { /* 不是联接 */ }
    clearSelftestSandbox(testRoot);
  };
  const teamBefore = selftestTeamSnapshot();
  const failures = [];
  let win = null;
  // 全程用本地 mock DSH：创建项目要绑工作区、启动团队要建 6 个会话，绝不能碰真实 DSH。
  let flowMock = null;
  const savedHome = process.env.DSH_HOME;
  const savedDsh = dsh;
  const closeFlowMock = async () => {
    dsh = savedDsh;
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    if (!flowMock) return;
    try { if (typeof flowMock.server.closeAllConnections === 'function') flowMock.server.closeAllConnections(); } catch { /* ignore */ }
    try { await new Promise((resolve) => flowMock.server.close(resolve)); } catch { /* ignore */ }
    flowMock = null;
  };
  try {
    const flowHome = path.join(testRoot, 'dsh-home-flow');
    fs.mkdirSync(flowHome, { recursive: true });
    fs.writeFileSync(path.join(flowHome, '.credentials.yaml'), 'client-connection/browser-session:\n  secret: ' + 'c'.repeat(43) + '\n', 'utf8');
    process.env.DSH_HOME = flowHome;
    flowMock = await startMockDsh();
    dsh = new DshAdapter('http://127.0.0.1:' + flowMock.port);
    const storeTest = selftestStore();
    console.log('SELFTEST_STORE ' + JSON.stringify({
      checks: storeTest.checks.length,
      failed: storeTest.failures.length,
      failures: storeTest.failures
    }));
    for (const failure of storeTest.failures) failures.push('状态库隔离测试：' + failure);
    win = new BrowserWindow({
      width: 1360, height: 860, show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, webviewTag: true }
    });
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await win.webContents.executeJavaScript(`document.getElementById('dsh-view')?.setAttribute('src','about:blank')`);
    await new Promise((r) => setTimeout(r, 700));
    const result = await win.webContents.executeJavaScript(`(async()=>{
      showDshView(false);
      const state = await window.workbench.state();
      return JSON.stringify({
        version: state.version,
        projects: state.projects.length,
        roles: state.roles.length,
        stages: state.stages.length,
        hasCreate: typeof window.workbench.createProject === 'function',
        hasOwner: typeof window.workbench.ownerDecide === 'function',
        hasTeamApi: typeof window.workbench.teamWorkspaces === 'function'
          && typeof window.workbench.teamEnsureProject === 'function'
          && typeof window.workbench.teamLaunch === 'function'
          && typeof window.workbench.teamBoard === 'function'
          && typeof window.workbench.teamStatus === 'function'
          && typeof window.workbench.teamMembers === 'function'
          && typeof window.workbench.teamRestore === 'function'
          && typeof window.workbench.teamWorkspaceCreate === 'function'
          && typeof window.workbench.teamInbox === 'function'
          && typeof window.workbench.teamRead === 'function'
          && typeof window.workbench.teamComm === 'function'
          && typeof window.workbench.teamReconcile === 'function'
          && typeof window.workbench.proposalLegacy === 'function'
          && typeof window.workbench.workflow === 'function'
          && typeof window.workbench.workflowOwner === 'function',
        hasWorkflowApi: typeof window.workbench.workflowBoot === 'function'
          && typeof window.workbench.workflowBriefing === 'function'
          && typeof window.workbench.workflowState === 'function'
          && typeof window.workbench.requirementCreate === 'function'
          && typeof window.workbench.requirementReview === 'function'
          && typeof window.workbench.requirementOwner === 'function'
          && typeof window.workbench.requirementDispatch === 'function'
          && typeof window.workbench.ownerDemand === 'function'
          && typeof window.workbench.requirementDispatchBatch === 'function'
          && typeof window.workbench.taskClaim === 'function'
          && typeof window.workbench.taskDone === 'function'
          && typeof window.workbench.devSubmit === 'function'
          && typeof window.workbench.devReview === 'function'
          && typeof window.workbench.devApply === 'function'
          && typeof window.workbench.testDispatch === 'function'
          && typeof window.workbench.ownerAccept === 'function',
        teamInitialized: Boolean(state.team && state.team.initialized),
        teamToolExists: Boolean(state.team && state.team.toolExists),
        dsh: state.dsh && state.dsh.configured
      });
    })()`);
    console.log('SELFTEST_STATE ' + result);
    const stateData = JSON.parse(result);
    if (!stateData.hasTeamApi) failures.push('preload 团队 IPC 不完整');
    if (!stateData.hasWorkflowApi) failures.push('preload 工作流闭环 IPC 不完整');
    if (typeof stateData.teamToolExists !== 'boolean') failures.push('state.team 缺失');
    const dshCheck = await win.webContents.executeJavaScript(`(async()=>{const r=await window.workbench.dshStatus();return JSON.stringify(r.status)})()`);
    console.log('SELFTEST_DSH ' + dshCheck);

    // 先只建项目并拿到路径；主进程写好真实项目信息/铁律后再跑团队通信，
    // 否则旧 team.mjs send 会按 PROJECT_INFO_PLACEHOLDER 正确拒绝占位项目。
    const flowSetupRaw = await win.webContents.executeJavaScript(`(async()=>{
      const root = ${JSON.stringify(testRoot)};
      const created = await window.workbench.createProject({ name: '验证项目', root });
      return JSON.stringify({
        id: created.project.id,
        path: created.project.path,
        name: created.project.name,
        teamCreateOk: Boolean(created.team && created.team.ok),
        createWs: created.workspace ? created.workspace.id : ''
      });
    })()`);
    const flowSetup = typeof flowSetupRaw === 'string' ? JSON.parse(flowSetupRaw) : flowSetupRaw;
    seedSelftestProjectDocs(flowSetup.path, flowSetup.name);
    const flow = await win.webContents.executeJavaScript(`(async()=>{
      const p = (await window.workbench.state()).projects.find(x => x.id === ${JSON.stringify(flowSetup.id)});
      const teamCreateOk = ${JSON.stringify(flowSetup.teamCreateOk)};
      const createWs = ${JSON.stringify(flowSetup.createWs)};
      const ws = await window.workbench.teamWorkspaces();
      const wsEntry = (ws.projects || []).find(x => x.path && x.path.toLowerCase() === p.path.toLowerCase());
      const ensured = await window.workbench.teamEnsureProject(p.id);
      const launchDry = await window.workbench.teamLaunch({ projectId: p.id, dryRun: true, roles: 'pm' });
      const launchOffline = await window.workbench.teamLaunch({ projectId: p.id, dryRun: false, roles: 'pm', engineUrl: 'http://127.0.0.1:9' });
      // 启动团队：只建六角色会话；再点一次不应新建任何会话。
      const provision = await window.workbench.dshProvision({ projectId: p.id });
      const provisionAgain = await window.workbench.dshProvision({ projectId: p.id });
      const board = await window.workbench.teamBoard({ projectId: p.id, open: false });
      let s = await window.workbench.state();
      const stageAfterCreate = s.projects.find(x => x.id === p.id).stage;
      await window.workbench.createTask({ projectId: p.id, title: '验证需求', role: 'analyst', priority: 'P1' });
      s = await window.workbench.state();
      const stageAfterTask = s.projects.find(x => x.id === p.id).stage;
      const ownerChallenge = await window.workbench.ownerChallenge({ projectId: p.id, action: 'owner-decision' });
      const ownerConfirm = await window.workbench.ownerConfirm({ challengeId: ownerChallenge.challengeId, nonce: ownerChallenge.nonce });
      await window.workbench.ownerDecide({ projectId: p.id, status: 'approved', opinion: '验证通过', confirmToken: ownerConfirm.confirmToken });
      const ownerChallengeDeprecated = Boolean(ownerChallenge.deprecated === true);
      const ownerConfirmDeprecated = Boolean(ownerConfirm.deprecated === true);
      s = await window.workbench.state();
      const stageAfterApprove = s.projects.find(x => x.id === p.id).stage;
      const tasks = s.projects.find(x => x.id === p.id).tasks;
      for (const t of tasks) await window.workbench.updateTask({ projectId: p.id, taskId: t.id, status: 'done' });
      s = await window.workbench.state();
      const stageAfterDone = s.projects.find(x => x.id === p.id).stage;
      const prop = await window.workbench.proposalCreate({ projectId: p.id, title: '验证提案', author: 'analyst', fileRel: 'site/verify.txt', content: 'verify content' });
      const stageAfterProposal = (await window.workbench.state()).projects.find(x => x.id === p.id).stage;
      const propReview = await window.workbench.proposalReview({ projectId: p.id, proposalId: prop.proposal.id, role: 'product', verdict: 'approve', comment: '验证评审通过' });
      const propSign = await window.workbench.proposalSign({ projectId: p.id, proposalId: prop.proposal.id, decision: 'approved', note: '验证签字' });
      const applied = await window.workbench.proposalApply({ projectId: p.id, proposalId: prop.proposal.id });
      // 看板同步：工作台任务/提案/提交必须出现在旧看板数据源。
      const boardAfter = await window.workbench.teamBoard({ projectId: p.id, open: false });
      const rolled = await window.workbench.proposalRollback({ projectId: p.id, proposalId: prop.proposal.id });
      const files = await window.workbench.filesList(p.id);
      const sent = await window.workbench.teamSend({ projectId: p.id, role: 'analyst', subject: '验证派单', body: '验证回执' });
      const lockState = await window.workbench.state();
      const lockAfterSend = lockState.projects.find(x => x.id === p.id).pendingAck;
      // 旧协议 PM 一次只能派一个：锁没回执前，第二条必须被明确拒绝。
      const secondRejected = await window.workbench.teamSend({ projectId: p.id, role: 'tester', subject: '锁内派单', body: '应被拒绝' })
        .then(() => '', (e) => String(e && e.message || e));
      const acked = await window.workbench.teamAck({ projectId: p.id, messageId: sent.message.id, note: '验证回执通过', allowShellAck: true });
      const lockAfterAck = (await window.workbench.state()).projects.find(x => x.id === p.id).pendingAck;
      // 六角色互发：产品→PM、测试→程序员A，回执必须带收件角色真实会话。
      const toPm = await window.workbench.teamSend({ projectId: p.id, from: 'product', to: 'pm', subject: '角色互发', body: '产品给 PM' });
      const toPmAck = await window.workbench.teamAck({ projectId: p.id, messageId: toPm.message.id, note: 'PM 已收到', allowShellAck: true });
      const toDev = await window.workbench.teamSend({ projectId: p.id, from: 'tester', to: 'programmer1', subject: '角色互发', body: '测试给程序员A' });
      const toDevAck = await window.workbench.teamAck({ projectId: p.id, messageId: toDev.message.id, note: '程序员A 已收到', allowShellAck: true });
      const mappingNow = (await window.workbench.state()).projects.find(x => x.id === p.id).sessions;
      const second = await window.workbench.teamSend({ projectId: p.id, role: 'tester', subject: '验证撤销', body: '验证撤销' });
      const cancelled = await window.workbench.teamCancel({ projectId: p.id });
      const lockAfterCancel = (await window.workbench.state()).projects.find(x => x.id === p.id).pendingAck;
      const deleted = await window.workbench.deleteProjectRecord(p.id);
      const adopted = await window.workbench.adoptProject({ path: p.path });
      const adoptedBefore = adopted.mapping ? adopted.mapping.sessionCount : -1;
      // 删除时归档并清掉旧会话清单：恢复后不能自动带回已归档会话，必须重新建团队。
      const readopted = await window.workbench.dshProvision({ projectId: adopted.project.id });
      const adoptedStatus = await window.workbench.dshTeamStatus(adopted.project.id);
      const wsAfter = await window.workbench.teamWorkspaces();
      const wsProbe = await window.workbench.teamWorkspaces({ probe: true });
      await refresh();
      return JSON.stringify({
        projectId: p.id,
        stageAfterCreate, stageAfterTask, stageAfterApprove, stageAfterDone, stageAfterProposal,
        roles: s.roles.length,
        proposal: propSign.proposal.status,
        reviews: propReview.proposal.reviews.length,
        applied: applied.proposal.applied,
        rolled: rolled.proposal.applied,
        files: files.files.length,
        message: sent.message.id,
        messageSource: sent.message.source,
        lockAfterSend,
        secondRejected,
        lockAfterAck,
        secondSendOk: Boolean(second.ok),
        lockAfterCancel,
        cancelOk: Boolean(cancelled.ok),
        acked: acked.message.ack,
        ackSource: acked.source,
        provisionCreated: (provision.created || []).length,
        provisionMapping: provision.mapping ? provision.mapping.sessionCount : -1,
        provisionAgain: (provisionAgain.created || []).length,
        createWorkspaceId: createWs,
        restored: adopted.project.name,
        adoptedProjectId: adopted.project.id,
        adoptedBefore,
        adoptedMapping: readopted.mapping ? readopted.mapping.sessionCount : -1,
        adoptedExtras: (adoptedStatus.extras || []).length,
        adoptedWorkspaceId: adopted.workspace ? adopted.workspace.id : '',
        deletedArchived: (deleted.sessions && deleted.sessions.archived || []).length,
        deletedRegistrations: (deleted.removed && deleted.removed.registrations || []).length,
        teamCreateOk,
        teamInitialized: ws.initialized,
        teamToolAvailable: Boolean(ws.tool && ws.tool.available),
        teamWsFound: Boolean(wsEntry),
        teamWsExists: Boolean(wsEntry && wsEntry.exists),
        teamWsMeta: Boolean(wsEntry && wsEntry.hasWorkspaceMeta),
        teamEnsureOk: Boolean(ensured.ok && ensured.ensured),
        launchDryOk: Boolean(launchDry.ok && launchDry.dryRun === true),
        launchDryPlan: Array.isArray(launchDry.plan) ? launchDry.plan.length : -1,
        launchDrySessions: Array.isArray(launchDry.sessions) ? launchDry.sessions.length : -1,
        launchIpcOffline: Boolean(launchOffline.ok === false && launchOffline.code === 'DSH_OFFLINE'),
        launchIpcOfflineCode: launchOffline.code || '',
        boardOk: Boolean(board.ok && board.boardExists),
        boardPath: board.boardPath || '',
        boardSummary: board.summary || null,
        boardAfterSummary: boardAfter.summary || null,
        boardAfterSynced: boardAfter.synced || null,
        crossFromPm: toPm.message && toPm.message.from,
        crossToPmAckSource: toPmAck.source,
        crossToPmAckSession: toPmAck.sessionId || '',
        crossToDevSource: toDev.source,
        crossToDevAckSource: toDevAck.source,
        crossToDevAckSession: toDevAck.sessionId || '',
        crossPmSession: mappingNow.pm,
        crossDevSession: mappingNow.programmer1,
        crossAnalystSession: mappingNow.analyst,
        crossAckSessionId: acked.sessionId || '',
        teamIndex: files.files.some(f => f.rel === '项目索引.md'),
        teamRules: files.files.some(f => f.rel === '协作准则.md'),
        teamAdoptOk: Boolean(adopted.team && adopted.team.ok),
        wsAfterTool: Boolean(wsAfter.tool && wsAfter.tool.available),
        wsProbeOk: Boolean(wsProbe.ok && wsProbe.dsh && typeof wsProbe.dsh.online === 'boolean'),
        ownerChallengeDeprecated,
        ownerConfirmDeprecated
      });
    })()`);
    console.log('SELFTEST_FLOW ' + flow);
    const flowData = JSON.parse(flow);
    const flowChecks = [
      ['teamCreateOk', '创建项目时 ensure 团队项目失败'],
      ['teamInitialized', '团队工具未初始化'],
      ['teamToolAvailable', '团队工具缺失'],
      ['teamWsFound', '团队工作区列表找不到项目'],
      ['teamWsExists', '团队工作区目录不可用'],
      ['teamWsMeta', '工作区缺少 workspace.json'],
      ['teamEnsureOk', '显式 ensure 团队项目失败'],
      ['launchDryOk', '团队会话 dry-run 失败'],
      ['boardOk', '团队看板生成失败'],
      ['teamIndex', '项目缺少 项目索引.md'],
      ['teamRules', '项目缺少 协作准则.md'],
      ['teamAdoptOk', '恢复项目时 ensure 团队项目失败'],
      ['wsAfterTool', '团队工具列表不可用'],
      ['wsProbeOk', '团队工作区 probe 失败'],
      ['ownerChallengeDeprecated', 'owner:challenge 未标记废弃'],
      ['ownerConfirmDeprecated', 'owner:confirm 未标记废弃']
    ];
    for (const [key, label] of flowChecks) if (!flowData[key]) failures.push(label);
    // DSH 地址持久化：configure 必须写 dsh.json（自测沙盘内），无效地址给出结构化错误码。
    const dshCfg = JSON.parse(await win.webContents.executeJavaScript(
      `(async()=>JSON.stringify(await window.workbench.dshConfigure(${JSON.stringify('http://127.0.0.1:' + flowMock.port)})))()`
    ));
    const dshCfgFile = path.join(testRoot, 'dsh.json');
    const dshCfgSaved = (() => { try { return JSON.parse(fs.readFileSync(dshCfgFile, 'utf8')); } catch { return null; } })();
    const dshCfgBad = JSON.parse(await win.webContents.executeJavaScript(
      `(async()=>JSON.stringify(await window.workbench.dshConfigure('not a url')))()`
    ));
    console.log('SELFTEST_DSH_CONFIG ' + JSON.stringify({
      ok: dshCfg.ok, persisted: dshCfg.persisted, file: dshCfg.configFile,
      saved: dshCfgSaved && dshCfgSaved.baseUrl, invalidCode: dshCfgBad.code
    }));
    if (!(dshCfg.ok && dshCfg.persisted && dshCfgSaved && /^http:\/\/127\.0\.0\.1:/.test(dshCfgSaved.baseUrl))) {
      failures.push('DSH 地址没有持久化到 dsh.json');
    }
    if (dshCfgBad.code !== 'DSH_URL_INVALID') failures.push('DSH 无效地址错误码不对：' + dshCfgBad.code);
    // 无效 configure 不应覆盖已保存地址。
    dsh = new DshAdapter('http://127.0.0.1:' + flowMock.port);
    if (!/^mock-ws-/.test(String(flowData.createWorkspaceId || ''))) failures.push('创建项目没有绑定 DSH 工作区：' + (flowData.createWorkspaceId || '空'));
    if (flowData.provisionCreated !== 6) failures.push('启动团队应只建 6 个角色会话，实际 ' + flowData.provisionCreated);
    if (flowData.provisionMapping !== 6) failures.push('启动团队后映射应有 6 个角色会话，实际 ' + flowData.provisionMapping);
    if (flowData.provisionAgain !== 0) failures.push('重复启动团队不应新建会话，实际 ' + flowData.provisionAgain);
    const boardAfter = flowData.boardAfterSummary || {};
    // 本地 workbench.json 只做镜像：本地任务/提案不能反写旧看板数据源。
    if (Number(boardAfter.tasks) !== 0 || Number(boardAfter.proposals) !== 0) {
      failures.push('本地任务/提案被反写进旧看板：' + JSON.stringify(boardAfter));
    }
    const mirrorSync = flowData.boardAfterSynced;
    if (!(mirrorSync && mirrorSync.ok === true && mirrorSync.code === 'MIRROR_ONLY'
      && mirrorSync.counts && Number(mirrorSync.counts.tasks) === 0 && Number(mirrorSync.counts.proposals) === 0)) {
      failures.push('看板同步没有声明只读镜像：' + JSON.stringify(mirrorSync));
    }
    if (flowData.stageAfterProposal !== 'review') failures.push('产品评审阶段不可达：' + flowData.stageAfterProposal);
    if (flowData.crossFromPm !== 'product') failures.push('角色→PM 发件人错误：' + flowData.crossFromPm);
    if (flowData.crossToPmAckSource !== 'team' || flowData.crossToPmAckSession !== flowData.crossPmSession) {
      failures.push(`PM 回执身份不对：${flowData.crossToPmAckSource}/${flowData.crossToPmAckSession} != ${flowData.crossPmSession}`);
    }
    if (flowData.crossToDevSource !== 'team' || flowData.crossToDevAckSession !== flowData.crossDevSession) {
      failures.push(`角色互发回执身份不对：${flowData.crossToDevSource}/${flowData.crossToDevAckSession} != ${flowData.crossDevSession}`);
    }
    if (!flowData.crossAckSessionId || flowData.crossAckSessionId !== flowData.crossAnalystSession) {
      failures.push(`派单回执身份不是 analyst 会话：${flowData.crossAckSessionId} != ${flowData.crossAnalystSession}`);
    }
    if (flowData.messageSource !== 'team') failures.push('派单没有走旧团队工具：' + flowData.messageSource);
    if (flowData.lockAfterSend !== flowData.message) failures.push('派单没有置待回执锁');
    if (!/未回执/.test(String(flowData.secondRejected || ''))) failures.push('待回执期间第二次派单没有被拒绝：' + flowData.secondRejected);
    if (flowData.lockAfterAck !== null) failures.push('回执后仍残留 pendingAck');
    if (flowData.ackSource !== 'team') failures.push('回执没有走旧团队工具：' + flowData.ackSource);
    if (!flowData.cancelOk) failures.push('team:cancel 后端接口不可用');
    if (flowData.lockAfterCancel !== null) failures.push('撤销后仍残留 pendingAck');
    if (flowData.adoptedBefore !== 0) failures.push('删除后恢复项目不应自动带回旧会话映射：' + flowData.adoptedBefore);
    if (flowData.adoptedMapping !== 6) failures.push('恢复项目重新建团队后应回填六角色映射：' + flowData.adoptedMapping);
    if (flowData.adoptedExtras !== 0) failures.push('恢复项目工作区出现额外/孤儿会话：' + flowData.adoptedExtras);
    if (flowData.deletedArchived !== 6) failures.push('删除项目没有归档六个 DSH 角色会话：' + flowData.deletedArchived);
    if (!(flowData.deletedRegistrations >= 1)) failures.push('删除项目没有清理团队登记');
    if (flowData.adoptedWorkspaceId !== flowData.createWorkspaceId) failures.push('同名恢复没有复用原 DSH 工作区：' + flowData.adoptedWorkspaceId + ' != ' + flowData.createWorkspaceId);
    if (!flowData.adoptedProjectId || flowData.adoptedProjectId === flowData.projectId) failures.push('恢复项目没有新建独立记录');
    if (flowData.launchDryPlan !== 1) failures.push('dry-run 计划角色数应为 1，实际 ' + flowData.launchDryPlan);
    if (flowData.launchDrySessions !== -1 && flowData.launchDrySessions !== 0) failures.push('dry-run 不应创建会话');
    if (!flowData.launchIpcOffline) failures.push('团队会话 IPC 的 DSH 离线错误码：' + (flowData.launchIpcOfflineCode || '空'));

    // 未初始化 + 中文/空格路径：用独立 TEAM_ROOT 沙盘验证，不动真实团队状态。
    const tempTeamRoot = path.join(testRoot, '团队-未初始化');
    const tempTools = teamTools.create({ teamRoot: tempTeamRoot });
    const tempProjectPath = path.join(testRoot, '中文 路径·验收');
    fs.mkdirSync(tempProjectPath, { recursive: true });
    const tempProject = { name: '中文 路径·验收', path: tempProjectPath };
    const tempInit = await tempTools.ensureInitialized();
    const tempEnsure = await tempTools.ensureProject(tempProject);
    const tempLaunch = await tempTools.launchSessions(tempProject, { dryRun: true, roles: ['pm'] });
    const tempInfo = await tempTools.listWorkspaces();
    console.log('SELFTEST_TEAM_TEMP ' + JSON.stringify({
      init: tempInit.ok, ensure: tempEnsure.ok, name: tempEnsure.name || '',
      launch: tempLaunch.ok, plan: Array.isArray(tempLaunch.plan) ? tempLaunch.plan.length : -1,
      listed: tempInfo.projects.some((item) => item.name === tempEnsure.name)
    }));
    if (!tempInit.ok) failures.push('未初始化团队自动 init 失败：' + (tempInit.code || tempInit.message));
    if (!tempEnsure.ok || !tempEnsure.name) failures.push('中文路径团队项目 ensure 失败：' + (tempEnsure.code || tempEnsure.message));
    if (!tempLaunch.ok || (tempLaunch.plan || []).length !== 1) failures.push('中文路径会话 dry-run 失败');
    if (!tempInfo.ok || !tempInfo.projects.some((item) => item.name === tempEnsure.name)) failures.push('中文路径工作区未出现在列表');

    // DSH 离线：给一个必然连不上的回环端口，要求结构化失败而不是崩溃/卡死。
    const offline = await tempTools.launchSessions(tempProject, { dryRun: false, roles: ['pm'], engineUrl: 'http://127.0.0.1:9' });
    console.log('SELFTEST_TEAM_OFFLINE ' + JSON.stringify({
      ok: offline.ok, code: offline.code || '', sessions: Array.isArray(offline.sessions) ? offline.sessions.length : -1,
      message: String(offline.message || '').slice(0, 160)
    }));
    if (offline.ok) failures.push('DSH 离线时应返回失败');
    else if (offline.code !== 'DSH_OFFLINE') failures.push('DSH 离线错误码不是 DSH_OFFLINE：' + offline.code);

    // 超时 / 目录不存在 / 工具缺失：都要是结构化结果，不能抛异常或卡死。
    const timeoutProbe = await tempTools._runNode(tempTools.layout.teamTool, ['status', '--json'], { timeoutMs: 10 });
    const missingPath = await tempTools.ensureProject({ name: '不存在', path: path.join(testRoot, '不存在的项目') });
    const noTools = teamTools.create({
      teamRoot: path.join(testRoot, '团队-无工具'),
      toolsDir: path.join(testRoot, '没有工具')
    });
    const noToolsResult = await noTools.ensureProject(tempProject);
    console.log('SELFTEST_TEAM_ERRORS ' + JSON.stringify({
      timeout: Boolean(timeoutProbe.timedOut && !timeoutProbe.ok), timeoutCode: timeoutProbe.errorCode || '',
      missing: missingPath.code || '', noTools: noToolsResult.code || ''
    }));
    if (!(timeoutProbe.timedOut && !timeoutProbe.ok)) failures.push('团队工具超时未归一');
    if (missingPath.code !== 'PROJECT_DIR_MISSING') failures.push('项目目录不存在未归一');
    if (noToolsResult.code !== 'TOOL_MISSING') failures.push('团队工具缺失未归一');

    // 旧版 main.js / 团队工具协议兼容、并发幂等、派单锁一致性。
    const compat = await selftestCompat(win, testRoot);
    console.log('SELFTEST_COMPAT ' + JSON.stringify({
      checks: Object.keys(compat.report).length,
      failed: compat.failures.length,
      failures: compat.failures,
      report: compat.report
    }));
    for (const failure of compat.failures) failures.push('兼容与一致性：' + failure);

    // 项目 = workspace、会话 = role、消息/回执走旧团队工具：模型自测（独立 mock）。
    const mappingTest = await selftestMapping(win, testRoot);
    console.log('SELFTEST_MAPPING_RESULT ' + JSON.stringify({
      checks: Object.keys(mappingTest.report).length,
      failed: mappingTest.failures.length,
      failures: mappingTest.failures
    }));
    for (const failure of mappingTest.failures) failures.push('工作台模型：' + failure);

    // 第五轮硬问题：跨项目名册、旧锁残留、文件读取、Owner 工作流、看板浮窗、删除归档。
    const round5 = await selftestRound5(win, testRoot, flowMock);
    console.log('SELFTEST_ROUND5 ' + JSON.stringify({
      checks: Object.keys(round5.report).length,
      failed: round5.failures.length,
      failures: round5.failures,
      report: round5.report
    }));
    for (const failure of round5.failures) failures.push('第五轮硬问题：' + failure);

    // 第六轮硬问题：旧流程 inbox/read + 四步唤醒 + actor 语义、跨项目清单、并发合并、旧锁、删除归档。
    const round6 = await selftestRound6(win, testRoot, flowMock);
    console.log('SELFTEST_ROUND6 ' + JSON.stringify({
      checks: Object.keys(round6.report).length,
      failed: round6.failures.length,
      failures: round6.failures,
      report: round6.report
    }));
    for (const failure of round6.failures) failures.push('第六轮硬问题：' + failure);

    // 第九轮硬问题：六会话通信链、角色自执行回执、壳代跑闸门、旧评审协议桥、跨项目 workspace。
    const round9 = await selftestRound9(win, testRoot, flowMock);
    console.log('SELFTEST_ROUND9 ' + JSON.stringify({
      checks: Object.keys(round9.report).length,
      failed: round9.failures.length,
      failures: round9.failures,
      report: round9.report
    }));
    for (const failure of round9.failures) failures.push('第九轮硬问题：' + failure);

    // 第十轮：旧团队工作流闭环（六角色目录/bootRead/需求评审/派单/开发互审/测试/Owner 验收/迭代/终止）。
    const round10 = await selftestRound10(win, testRoot, flowMock);
    console.log('SELFTEST_ROUND10 ' + JSON.stringify({
      checks: Object.keys(round10.report).length,
      failed: round10.failures.length,
      failures: round10.failures,
      report: round10.report
    }));
    for (const failure of round10.failures) failures.push('第十轮工作流闭环：' + failure);

    // 第十一轮：Owner 免确认码、owner:demand 提需求流、buildRoleBrief 精准投喂、并行派单 A/B。
    const round11 = await selftestRound11(win, testRoot, flowMock);
    console.log('SELFTEST_ROUND11 ' + JSON.stringify({
      checks: Object.keys(round11.report).length,
      failed: round11.failures.length,
      failures: round11.failures,
      report: round11.report
    }));
    for (const failure of round11.failures) failures.push('第十一轮 owner:demand/简报/并行派单：' + failure);

    // 第十二轮：能力矩阵 inbox/read/ack、派单唤醒执行语义、PM→需求分析师 req create + R-*.md。
    const round12 = await selftestRound12(win, testRoot, flowMock);
    console.log('SELFTEST_ROUND12 ' + JSON.stringify({
      checks: Object.keys(round12.report).length,
      failed: round12.failures.length,
      failures: round12.failures,
      report: round12.report
    }));
    for (const failure of round12.failures) failures.push('第十二轮派单执行语义：' + failure);

    // 第十三轮：团队模式 full/fast、Fast 评审/开发技术评审、投票驳回 Owner 需求。
    const round13 = await selftestRound13(win, testRoot, flowMock);
    console.log('SELFTEST_ROUND13 ' + JSON.stringify({
      checks: Object.keys(round13.report).length,
      failed: round13.failures.length,
      failures: round13.failures,
      report: round13.report
    }));
    for (const failure of round13.failures) failures.push('第十三轮团队模式/投票：' + failure);

    // 第十四轮：dry-run 只读承诺、Full 模式 owner/workflow（真实命令或壳层收口）、投票发起人归属、驳回后阶段。
    const round14 = await selftestRound14(win, testRoot);
    console.log('SELFTEST_ROUND14 ' + JSON.stringify({
      checks: Object.keys(round14.report).length,
      failed: round14.failures.length,
      failures: round14.failures,
      report: round14.report
    }));
    for (const failure of round14.failures) failures.push('第十四轮dry-run/壳层收口：' + failure);

    await win.webContents.executeJavaScript(`document.querySelector('[data-tab="flow"]').click()`);
    const tabState = await win.webContents.executeJavaScript(`JSON.stringify({tab:document.querySelector('.tab.active')?.dataset.tab, display:getComputedStyle(document.getElementById('view-flow')).display})`);
    console.log('SELFTEST_TAB ' + tabState);
    await new Promise((r) => setTimeout(r, 250));
    // 自测产物只能写沙盘，不能覆盖仓库根截图（只读 QA 的边界）。
    const artifactDir = path.join(SELFTEST_ROOT, 'artifacts');
    fs.mkdirSync(artifactDir, { recursive: true });
    const img = await win.webContents.capturePage();
    if (!img.isEmpty()) fs.writeFileSync(path.join(artifactDir, 'selftest-flow.png'), img.toPNG());
    await win.webContents.executeJavaScript(`document.querySelector('[data-tab="overview"]').click()`);
    await new Promise((r) => setTimeout(r, 150));
    const overviewImg = await win.webContents.capturePage();
    if (!overviewImg.isEmpty()) fs.writeFileSync(path.join(artifactDir, 'selftest.png'), overviewImg.toPNG());
    console.log('SELFTEST_TEAM_CLEANUP ' + JSON.stringify(selftestTeamCleanup(testRoot, teamBefore)));
    cleanupRoot();
  } catch (error) {
    console.error('SELFTEST_FAIL ' + String(error && error.stack || error));
    try { selftestTeamCleanup(testRoot, teamBefore); } catch { /* ignore */ }
    cleanupRoot();
    try { if (win) win.destroy(); } catch { /* ignore */ }
    await closeFlowMock();
    app.exit(1);
    return;
  }
  if (failures.length) {
    console.error('SELFTEST_FAIL ' + failures.join('；'));
    try { if (win) win.destroy(); } catch { /* ignore */ }
    await closeFlowMock();
    app.exit(1);
    return;
  }
  console.log('SELFTEST_OK');
  win.destroy();
  await closeFlowMock();
  await new Promise((r) => setTimeout(r, 250));
  app.exit(0);
}

function isLocalDshBaseUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    const host = String(url.hostname || '').toLowerCase();
    return ['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0', '[::]'].includes(host);
  } catch { return false; }
}

/**
 * 只有当前地址是本机时才自动发现：
 * - 自测沙盘绝不碰真实 DSH；
 * - 用户显式配置了远程 DSH（非 localhost）时，不擅自改成本机端口。
 * DSH_WEB_URL 只是初始地址/候选提示：它若失效，仍允许发现恢复，避免更新后卡死。
 */
function dshAutoDiscoveryAllowed() {
  if (IS_SELFTEST) return false;
  if (!dsh.baseUrl) return true;
  return isLocalDshBaseUrl(dsh.baseUrl);
}

function dshDiscoverySummary(result) {
  if (!result) return null;
  return {
    at: result.at || null,
    code: result.code || '',
    message: String(result.message || '').slice(0, 400),
    source: result.source || '',
    changed: Boolean(result.changed),
    persisted: Boolean(result.persisted),
    baseUrl: result.baseUrl || dsh.baseUrl,
    previousBaseUrl: result.previousBaseUrl || null,
    candidates: Array.isArray(result.candidates) ? result.candidates.length : 0,
    probes: Array.isArray(result.probes) ? result.probes.length : 0,
    durationMs: result.durationMs || 0
  };
}

/**
 * 发现成功后重载内嵌 DSH WebView：
 * - 优先用渲染进程已有的 #dsh-view 改 src（同时更新 DOM，后续 reload 不会回到旧地址）；
 * - 渲染进程还没就绪时，退回 Electron 的 webview guest webContents.loadURL。
 * 只改 main.js，不要求 renderer 增加新 IPC。
 */
async function reloadDshWebview(baseUrl) {
  const target = String(baseUrl || '');
  if (!target) return { ok: false, code: 'DSH_URL_REQUIRED', message: '没有可加载的 DSH 地址' };
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      const handled = await mainWindow.webContents.executeJavaScript(`(() => {
        const view = document.querySelector('#dsh-view');
        if (!view) return false;
        const target = ${JSON.stringify(target)};
        if (view.getAttribute('src') === target) {
          // 已经在目标地址（或正在加载）时不要 reload；否则会中止当前导航并产生 ERR_ABORTED。
          return true;
        }
        view.setAttribute('src', target);
        return true;
      })()`, true);
      if (handled) return { ok: true, via: 'dom' };
    } catch { /* 页面未加载完时走 guest 兜底 */ }
  }
  const guests = typeof webContents.getAllWebContents === 'function' ? webContents.getAllWebContents() : [];
  const guest = guests.find((contents) => {
    try { return contents.getType() === 'webview' && !contents.isDestroyed(); } catch { return false; }
  });
  if (!guest) {
    return { ok: false, code: 'DSH_WEBVIEW_MISSING', message: '未找到 DSH WebView；下次打开会使用新地址' };
  }
  try {
    await guest.loadURL(target);
    return { ok: true, via: 'webview' };
  } catch (error) {
    return {
      ok: false,
      code: 'DSH_WEBVIEW_RELOAD_FAILED',
      message: 'DSH WebView 重载失败：' + String(error && error.message || error).slice(0, 160)
    };
  }
}

async function adoptDiscoveredDsh(discovery) {
  const baseUrl = normalizeDshBaseUrl(discovery && discovery.baseUrl);
  const previousBaseUrl = dsh.baseUrl;
  const warnings = [];
  if (baseUrl === previousBaseUrl) {
    const status = await dsh.check({ timeoutMs: 5000 });
    return {
      changed: false,
      baseUrl,
      previousBaseUrl,
      persisted: false,
      cookieOk: true,
      webview: { ok: true, via: 'none' },
      status,
      warnings
    };
  }
  dsh = new DshAdapter(baseUrl);
  let persisted = false;
  let persistError = null;
  try {
    persistDshConfig(baseUrl);
    persisted = true;
  } catch (error) {
    persistError = {
      code: 'DSH_CONFIG_WRITE_FAILED',
      message: String(error && error.message || error).slice(0, 200)
    };
    warnings.push(persistError);
  }
  const cookieOk = await installDshCookie();
  if (!cookieOk) {
    warnings.push({ code: 'DSH_COOKIE_FAILED', message: 'DSH 登录 cookie 安装失败；页面可能需要重新登录' });
  }
  const webview = await reloadDshWebview(baseUrl);
  if (!webview.ok) warnings.push({ code: webview.code || 'DSH_WEBVIEW_RELOAD_FAILED', message: webview.message });
  const status = await dsh.check({ timeoutMs: 5000 });
  return {
    changed: true,
    baseUrl,
    previousBaseUrl,
    persisted,
    persistError,
    cookieOk,
    webview,
    status,
    warnings
  };
}

async function runDshDiscovery(reason = 'status') {
  if (dshDiscovery.running) return dshDiscovery.running;
  const task = (async () => {
    const previousBaseUrl = dsh.baseUrl;
    let discovery;
    try {
      discovery = await discoverDshWeb({
        savedBaseUrl: previousBaseUrl,
        timeoutMs: 1200,
        env: process.env
      });
    } catch (error) {
      discovery = {
        ok: false,
        code: 'DSH_DISCOVERY_CRASHED',
        message: '自动发现异常：' + String(error && error.message || error).slice(0, 240),
        baseUrl: '',
        savedBaseUrl: previousBaseUrl,
        candidates: [],
        probes: []
      };
    }
    const at = new Date().toISOString();
    const label = reason === 'manual' ? '手动重新发现' : '自动发现';
    if (!discovery.ok || !discovery.baseUrl) {
      const detail = String(discovery.message || '未找到 DSH Web');
      const message = label + '失败：' + detail
        + (detail.includes('保留原地址') || !previousBaseUrl ? '' : '；保留原地址 ' + previousBaseUrl);
      const result = {
        ...discovery,
        at,
        message,
        changed: false,
        previousBaseUrl,
        persisted: false,
        code: discovery.code || 'DSH_NOT_FOUND'
      };
      dshDiscovery.last = result;
      console.warn('[dsh] ' + message);
      return result;
    }
    let adopted;
    try {
      adopted = await adoptDiscoveredDsh(discovery);
    } catch (error) {
      const message = '发现 DSH 端口但切换失败：' + String(error && error.message || error).slice(0, 240)
        + '；保留原地址 ' + previousBaseUrl;
      const result = {
        ...discovery,
        at,
        message,
        changed: false,
        previousBaseUrl,
        persisted: false,
        code: 'DSH_ADOPT_FAILED',
        error: String(error && error.message || error)
      };
      dshDiscovery.last = result;
      console.error('[dsh] ' + message);
      return result;
    }
    const changed = Boolean(adopted.changed);
    const message = changed
      ? label + ' DSH：' + previousBaseUrl + ' → ' + adopted.baseUrl + (adopted.persisted ? '（已写入 dsh.json）' : '（未能写入 dsh.json）')
      : 'DSH 地址已是最新：' + adopted.baseUrl;
    const result = {
      ...discovery,
      ...adopted,
      at,
      message,
      previousBaseUrl,
      code: changed ? 'DSH_DISCOVERED' : 'DSH_ALREADY_CURRENT'
    };
    dshDiscovery.last = result;
    console.log('[dsh] ' + message + (adopted.webview && adopted.webview.ok ? '；WebView=' + adopted.webview.via : '；WebView 未重载'));
    return result;
  })();
  dshDiscovery.running = task;
  try {
    return await task;
  } finally {
    dshDiscovery.running = null;
  }
}

async function maybeAutoDiscoverDsh(reason = 'status') {
  const manual = reason === 'manual';
  // 自测沙盘绝不访问真实 DSH；手动 IPC 在自测里也只返回跳过，不碰本机端口。
  if (IS_SELFTEST) {
    return {
      skipped: true,
      ok: false,
      code: 'DSH_DISCOVERY_SKIPPED',
      message: '自测模式不自动发现 DSH 端口',
      baseUrl: dsh.baseUrl,
      candidates: [],
      probes: []
    };
  }
  if (!manual && !dshAutoDiscoveryAllowed()) {
    return {
      skipped: true,
      ok: false,
      code: 'DSH_DISCOVERY_SKIPPED',
      message: '当前 DSH 地址不是本机，跳过自动发现',
      baseUrl: dsh.baseUrl,
      candidates: [],
      probes: []
    };
  }
  if (dshDiscovery.running) return dshDiscovery.running;
  const now = Date.now();
  if (!manual && dshDiscovery.last && now - dshDiscovery.at < DSH_DISCOVERY_COOLDOWN_MS) {
    return { ...dshDiscovery.last, skipped: true, code: 'DSH_DISCOVERY_COOLDOWN' };
  }
  if (!manual) dshDiscovery.at = now;
  return runDshDiscovery(reason);
}

async function installDshCookie() {
  try {
    const c = dsh.webCookie();
    await session.defaultSession.cookies.set({
      url: c.url, name: c.name, value: c.value,
      httpOnly: true, secure: false, sameSite: 'lax'
    });
    const stored = await session.defaultSession.cookies.get({ url: c.url, name: c.name });
    return stored.length > 0;
  } catch { return false; }
}

// 单实例：两个窗口同时写 workbench.json / 团队状态会丢更新。自测用独立 userData，不参与锁。
const singleInstanceLock = IS_SELFTEST ? true : app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else if (!IS_SELFTEST) {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(async () => {
  if (!singleInstanceLock) return;
  app.setName(APP_NAME);
  registerIpc();
  await installDshCookie();
  if (IS_SELFTEST) {
    try {
      await selftest();
    } catch (error) {
      console.error('SELFTEST_FAIL ' + String(error && error.stack || error));
      app.exit(1);
    }
    return;
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (IS_SELFTEST) return;
  if (process.platform !== 'darwin') app.quit();
});
