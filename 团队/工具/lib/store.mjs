// 团队工作台 v2 · 持久化层（团队 / 项目 / 令牌 / 消息 / 任务 / 提案 / 授权）
import fs from 'node:fs';
import path from 'node:path';
import {
  PATHS, TeamError, fail, nowIso, sha256, hashFile, exists, ensureDir, readText, readJson,
  writeText, writeJson, appendLine, readJsonl, readJsonlTolerant, slug, safeName, isInside,
  relPath, truncate, randomHex, stamp, acquireLock, releaseLock, withLock, appendEvent,
} from './core.mjs';
import { ROLES, ROLE_DIRS, ROLE_NAMES, LIMITS, MODEL_BY_ROLE, normalizeTeamMode, rolesForMode, roleIdsForMode } from './roles.mjs';
import { DEFAULT_IRON, bootDocSpecs, readDocRecord, readRequirementDocs } from './scaffold.mjs';

// 角色常量单一真相在 roles.mjs；这里重导出，保持旧调用方向不变。
export { ROLES, ROLE_NAMES };
export const PHASE_PILOT = 'pilot';
// boot 令牌只证明“本轮已读齐必读文档”，不是 30 分钟的会话寿命。
// 默认 8 小时覆盖一个完整工作日；旧项目配置的 30 分钟一次性迁移到 480。
export const DEFAULT_BOOT_TTL_MINUTES = 480;
export const LEGACY_BOOT_TTL_MINUTES = 30;

/**
 * 项目团队模式：项目.json 的 teamMode 优先；老项目没有就回退 workspace.json；
 * 都没有按 full 解释（向后兼容：老项目 = 六角色）。
 */
export function projectTeamMode(project) {
  if (!project || typeof project !== 'object') return 'full';
  if (project.teamMode) return normalizeTeamMode(project.teamMode);
  try {
    const meta = readJson(path.join(project.path, 'workspace.json'), null);
    if (meta && meta.teamMode) return normalizeTeamMode(meta.teamMode);
  } catch { /* 老项目没有 workspace.json */ }
  return 'full';
}

/** 模式下的角色集（full 六角色 / fast 四角色）。 */
export function projectRoleSet(project) {
  return rolesForMode(projectTeamMode(project));
}

/** 模式角色 id 列表：项目.json / workspace.json 的 roleIds 都以这里为准。
 *  R-b52b F-7：项目内「有哪些角色」只认 项目.json.roleIds（显式清单优先）；
 *  只有项目还没写过 roleIds 时才回退团队模式（full=6 / fast=4）。这样测试把 tester 从
 *  roleIds 里删掉后，互询/派单/评审/验收的判定会立刻跟着变，不会被模式再补回来。 */
export function projectRoleIds(project) {
  const explicit = Array.isArray(project && project.roleIds)
    ? project.roleIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  if (explicit.length) {
    // ROLES 是角色 id 字符串数组（roles.mjs 单一真相），不是对象数组。
    const kept = explicit.filter((id) => ROLES.includes(id));
    if (kept.length) return kept;
  }
  return projectRoleSet(project);
}

/** 项目目录内的 DSH 工作区元数据路径（workspace.json）。 */
export function workspaceMetaPath(project) {
  return path.join(project.path, 'workspace.json');
}

/** 读 workspace.json；老项目没有或文件坏了都返回 null（回退文件不该让项目读不出来）。 */
export function readWorkspaceMeta(project) {
  try {
    return readJson(workspaceMetaPath(project), null);
  } catch {
    return null;
  }
}

function roleEntries(mode, oldRoles = []) {
  const previous = new Map((Array.isArray(oldRoles) ? oldRoles : [])
    .filter((entry) => entry && entry.role)
    .map((entry) => [entry.role, entry]));
  return rolesForMode(mode).map((role) => ({
    role,
    dir: ROLE_DIRS[role],
    // 角色模型可能被工作台按项目改过：保留旧条目里的 model，缺失才用默认。
    model: (previous.get(role) && previous.get(role).model) || MODEL_BY_ROLE[role] || null,
  }));
}

function sameStringList(list, expected) {
  return Array.isArray(list) && list.length === expected.length && list.every((v, i) => v === expected[i]);
}

function sameRoleEntries(list, expected) {
  if (!Array.isArray(list) || list.length !== expected.length) return false;
  return list.every((entry, i) => entry && entry.role === expected[i].role
    && entry.dir === expected[i].dir
    && JSON.stringify(entry.model || null) === JSON.stringify(expected[i].model || null));
}

/**
 * 同步 workspace.json 的团队模式字段：teamMode / roleIds / roles。
 * 只改这三个键和 updatedAt；dshWorkspaceId、engineUrl、limits、会话等其它键原样保留。
 * 老项目没有 workspace.json 时补一份最小元数据（dshWorkspaceId 取项目登记值或 null）。
 */
export function syncWorkspaceTeamMode(project, mode) {
  const m = normalizeTeamMode(mode);
  const roleIds = roleIdsForMode(m);
  const file = workspaceMetaPath(project);
  const old = readWorkspaceMeta(project);
  const roles = roleEntries(m, old && old.roles);
  const changed = !old
    || old.teamMode !== m
    || !sameStringList(old.roleIds, roleIds)
    || !sameRoleEntries(old.roles, roles);
  if (!changed) {
    return { file, existed: true, created: false, changed: false, teamMode: m, roleIds };
  }
  const meta = old
    ? { ...old }
    : {
      version: 1,
      name: project.name,
      path: project.path,
      dshWorkspaceId: project.dshWorkspaceId || null,
      engineUrl: null,
      limits: LIMITS,
      createdAt: nowIso(),
    };
  meta.name = meta.name || project.name;
  meta.path = meta.path || project.path;
  meta.teamMode = m;
  meta.roleIds = roleIds;
  meta.roles = roles;
  meta.updatedAt = nowIso();
  writeJson(file, meta);
  return { file, existed: Boolean(old), created: !old, changed: true, teamMode: m, roleIds };
}

/**
 * 把团队模式写进项目状态配置（状态/项目/<项目>/项目.json 的 teamMode + roleIds），
 * 并同步项目目录里的 workspace.json。只改模式相关字段：
 * - 不删除旧角色目录（脚手架只补不删，见 scaffold.ensureProjectStructure）
 * - 不动已有会话（团队.json / 会话.json / 团队会话.json 都不在这里写）
 * - 不覆盖其它配置键（dshWorkspaceId、index、entry 等保留）
 * 返回 before/after 与 workspace 同步结果，供命令输出、事件链和自测复核。
 */
export function persistProjectTeamMode(project, mode, { syncWorkspace = true } = {}) {
  const m = normalizeTeamMode(mode);
  const roleIds = roleIdsForMode(m);
  const p = projectStatePaths(project.name);
  const old = readJson(p.config, null);
  const before = old && old.teamMode ? normalizeTeamMode(old.teamMode) : '';
  const beforeRoleIds = Array.isArray(old?.roleIds) ? old.roleIds.slice() : [];
  const changed = !old || before !== m || !sameStringList(beforeRoleIds, roleIds);
  if (changed) {
    const cfg = { ...(old || {}), ...(project || {}) };
    cfg.name = project.name;
    cfg.path = project.path;
    cfg.teamMode = m;
    cfg.roleIds = roleIds;
    writeJson(p.config, cfg);
  }
  project.teamMode = m;
  project.roleIds = roleIds;
  const workspace = syncWorkspace ? syncWorkspaceTeamMode(project, m) : null;
  return { config: p.config, teamMode: m, roleIds, before, beforeRoleIds, changed, workspace };
}

/**
 * 只读核对模式三处是否一致：项目.json（真相）、workspace.json（镜像）、生效模式。
 * 不写任何文件；用于 project show / 自测 / 巡检。workspace.json 缺失按回退兼容处理，不算问题。
 */
export function projectModeState(project) {
  const m = projectTeamMode(project);
  const roleIds = rolesForMode(m);
  const cfgFile = projectStatePaths(project.name).config;
  const cfg = readJson(cfgFile, null) || project;
  const ws = readWorkspaceMeta(project);
  const problems = [];
  const cfgMode = cfg?.teamMode ? normalizeTeamMode(cfg.teamMode) : '';
  const wsMode = ws?.teamMode ? normalizeTeamMode(ws.teamMode) : '';
  if (!cfgMode) problems.push('项目.json 缺 teamMode');
  else if (cfgMode !== m) problems.push(`项目.json teamMode=${cfgMode} ≠ 生效模式 ${m}`);
  if (!sameStringList(cfg?.roleIds, roleIds)) problems.push(`项目.json roleIds 与 ${m} 模式不一致`);
  if (ws) {
    if (wsMode !== m) problems.push(`workspace.json teamMode=${wsMode || '(缺)'} ≠ ${m}`);
    if (!sameStringList(ws.roleIds, roleIds)) problems.push(`workspace.json roleIds 与 ${m} 模式不一致`);
  }
  return {
    project: project.name,
    teamMode: m,
    roleIds,
    config: { file: cfgFile, teamMode: cfgMode, roleIds: Array.isArray(cfg?.roleIds) ? cfg.roleIds : [] },
    workspace: ws
      ? { file: workspaceMetaPath(project), teamMode: wsMode, roleIds: Array.isArray(ws.roleIds) ? ws.roleIds : [], roleCount: Array.isArray(ws.roles) ? ws.roles.length : 0 }
      : null,
    ok: problems.length === 0,
    problems,
  };
}

const DEFAULT_CONSTITUTION = `# 团队宪法（默认版 · 每轮必读）

1. 每轮第一条命令：\`node 团队\\工具\\team.mjs boot --role <角色> --project <项目>\`。
2. 没有有效启动令牌，不许 send / ack / task / propose / review / sign / apply / grant。
3. 先读后审：review 前必须 show 同一提案；评审和签字绑定 proposalHash + baseHash。
4. 版本栅栏：apply 必须 CAS；目标哈希变了就 STALE_BASE，重新读、重新提、重新签。
5. 锁只防同时写，防不了旧版本；锁要 acquire/release，过期视为失效。
6. 任何变更只走 propose → show → review → sign → apply，不允许直接改。
7. 风险：normal=PM 签；sensitive/critical=全员签 + owner 终端批准（critical 还要备份+回滚演练）。
8. 没有回执 = 没发生；消息 ≤600 字；每操作一行事件日志。
9. 只写授权范围；失败即停，不绕过、不硬试。
10. 中文思考、中文回复、中文写文档；代码标识/命令/路径可英文。
11. 派单必须带任务正文、产出目录、完成标准：ack = 已回执（收到/认领），完成回执 + task done 证据 = 已完成，两者不能互相替代。
`;
const DEFAULT_ROLE_CARDS = {
  pm: `# 项目经理（Scrum Master / 总管）

- 中文思考、中文回复、中文写文档：推理、回复、文档、备注、评审、日志一律中文；代码标识可英文。
- 职责：建需求/建任务、派单、跟进回执与完成；统筹/总管/监督/下达指令；拆任务、定优先级（pilot 阶段代行产品）、催回执、对账、签字批准、维护需求看板。
- 完成口径：ack = 已回执；task done 证据 = 已完成；只 ack 不算完成。
- 地盘：团队状态、任务板、授权、索引；不写业务代码。
- 每轮：boot → 看 inbox → 处理待审提案 → task/reconcile → 给成员发消息。
- 禁止：自己审自己的提案；绕过 CAS；替程序员直接改文件。
- 完成定义：任务有 owner、有回执、有证据、有签字；对账无异常。
`,
  product: `# 产品设计师（产品经理）

- 中文思考、中文回复、中文写文档：中文推理、中文用户故事、中文验收口径。
- 职责：需求拆解评审、程序设计、流程图/类图（文字版即可）、用户故事、竞品优劣势、优先级、验收。
- 地盘：产品文档、需求、优先级；不写代码。
- 每轮：boot → inbox → 评估需求/优先级 → 更新看板 → 验收。
- 结构化输出：交付物 = 团队\\工具\\模板\\角色产出\\02-产品设计-vN.md 的实例（YAML 头 + 固定区块 + 列表）；只写自己字段、输出即结果、超限即停。
- 完成定义：优先级有理由，用户故事可验收，竞品结论有证据。
`,
  analyst: `# 需求分析师

- 中文思考、中文回复、中文写文档：中文澄清、中文场景、中文验收标准。
- 职责：需求拆解与评审、需求分析、场景缺陷闭环、需求可行性评估、问题闭环、验收标准、追踪矩阵。
- 地盘：需求文档、验收清单、缺陷记录；不写代码。
- 每轮：boot → inbox → 澄清/拆解/评审 → 更新需求/验收标准 → 关缺陷。
- 结构化输出：交付物 = 团队\\工具\\模板\\角色产出\\01-需求分析-vN.md 的实例（YAML 头 + 固定区块 + 列表）；只写自己字段、输出即结果、超限即停。
- 完成定义：每条需求有验收标准、有优先级、有负责人；缺陷有闭环证据。
`,
  programmer1: `# 高级程序员 A

- 中文思考、中文回复、中文写文档：中文注释、中文提交说明、中文回执。
- 职责：只做本职——按任务实现；先读项目索引再找文件；写 staged 副本；提 proposal；等评审签字后由 PM apply；配合测试。
- 地盘：授权 scope 内的文件（只通过 propose 提交）。
- 每轮：boot → inbox → task claim → 读索引/文件 → propose → 等 review/sign → 看回执。
- 结构化输出：主开发。交付物 = 团队\\工具\\模板\\角色产出\\03-架构设计-vN.md 的实例（YAML 头 + 固定区块 + 列表）；只写自己字段、输出即结果、超限即停。
- 禁止：直接改目标文件；抢别人的锁；绕过 review；失败硬试。
- 完成定义：apply 成功、verify 绿、task done 带 commit id。
`,
  programmer2: `# 高级程序员 B

- 中文思考、中文回复、中文写文档：中文注释、中文提交说明、中文回执。
- 职责：只做本职——与 A 并行开发；负责另一半模块；互相评审；不抢同一文件。
- 地盘：授权 scope 内的文件（只通过 propose 提交）。
- 每轮：boot → inbox → task claim → 读索引/文件 → propose → 审 A 的提案 → 看回执。
- 禁止：直接改目标文件；与 A 同时写同一文件；绕过 review。
- 完成定义：apply 成功、verify 绿、task done 带 commit id。
`,
  tester: `# 测试人员

- 中文思考、中文回复、中文写文档：中文用例、中文缺陷、中文结论。
- 职责：只做本职——测试计划/用例、回归、缺陷闭环、独立验证 verify、对账复核、签字。
- 地盘：测试文档、缺陷记录、验证报告；不改业务代码。
- 每轮：boot → inbox → 读提案/索引 → 跑 verify → 写结论 → 签字。
- 结构化输出：交付物 = 团队\\工具\\模板\\角色产出\\04-测试报告-vN.md 的实例（YAML 头 + 固定区块 + 列表）；只写自己字段、输出即结果、超限即停。
- 禁止：替程序员改代码；只看退出码不看证据；放过未复现的缺陷。
- 完成定义：每个变更有用例/证据；缺陷有复现与关闭记录；对账签字。
`,
};

export function defaultTeam() {
  return {
    version: 1,
    name: '团队工作台',
    phase: PHASE_PILOT,
    owner: '徐野风',
    createdAt: nowIso(),
    activeProject: null,
    members: [
      { role: 'pm', name: ROLE_NAMES.pm, status: 'active', joinedAt: nowIso(), sessionId: '' },
      { role: 'programmer1', name: ROLE_NAMES.programmer1, status: 'active', joinedAt: nowIso(), sessionId: '' },
    ],
    config: {
      bootTtlMinutes: DEFAULT_BOOT_TTL_MINUTES,
      reviewReadTtlMinutes: 15,
      lockTtlSeconds: 60,
      messageMaxChars: 600,
      ackNoteMaxChars: 300,
      reconcileReportMaxKB: 8,
      bootBriefMaxChars: 2000,
      docMaxBytes: 16384,
      codeMaxBytes: 65536,
      maxStagedBytes: 2 * 1024 * 1024,
      proposalStaleHours: 24,
      taskDueWarnHours: 24,
    },
  };
}

export function initTeam() {
  const created = [];
  for (const d of [PATHS.state, PATHS.locks, PATHS.boots, PATHS.mail, PATHS.grants, PATHS.logs, PATHS.roles, PATHS.templates, PATHS.projectState]) {
    ensureDir(d);
  }
  if (!exists(PATHS.team)) {
    writeJson(PATHS.team, defaultTeam());
    created.push(PATHS.team);
  }
  const docs = {
    [path.join(PATHS.teamRoot, '团队宪法.md')]: DEFAULT_CONSTITUTION,
    [path.join(PATHS.teamRoot, '项目铁律.md')]: DEFAULT_IRON,
  };
  for (const [file, text] of Object.entries(docs)) {
    if (!exists(file)) { writeText(file, text); created.push(file); }
  }
  for (const role of ROLES) {
    const file = path.join(PATHS.roles, `${role}.md`);
    if (!exists(file)) { writeText(file, DEFAULT_ROLE_CARDS[role] || `# ${ROLE_NAMES[role] || role}\n`); created.push(file); }
  }
  return { created, team: loadTeam() };
}

/** 迁移前备份到 状态/备份/，并核对备份哈希；只备份团队配置这一个文件。 */
function backupTeamConfig(reason = 'bootTtl') {
  const dir = path.join(PATHS.state, '备份');
  ensureDir(dir);
  const file = path.join(dir, `团队-${reason}-${stamp()}-${randomHex(2)}.json`);
  const sourceHash = hashFile(PATHS.team);
  fs.copyFileSync(PATHS.team, file);
  const backupHash = hashFile(file);
  if (sourceHash !== backupHash) {
    fail('MIGRATION_BACKUP_MISMATCH', `团队配置备份哈希不一致，停止迁移：${file}`, {
      source: PATHS.team, backup: file, sourceHash, backupHash,
    });
  }
  return { file, hash: backupHash, size: fs.statSync(file).size };
}

/**
 * 旧项目 team.json 的 bootTtlMinutes=30 → 480。
 * 幂等：只有当前值仍是旧值 30 时才迁移；迁移过（480 或自定义值）不再备份、不再写。
 * 备份先落盘并核对哈希，再原子写回配置；失败即停，不留下半迁移状态。
 */
export function migrateLegacyBootTtl(team, { file = PATHS.team } = {}) {
  if (!team || typeof team !== 'object') return team;
  if (!team.config || typeof team.config !== 'object') return team;
  if (Number(team.config.bootTtlMinutes) !== LEGACY_BOOT_TTL_MINUTES) return team;
  const backup = backupTeamConfig('bootTtl');
  team.config.bootTtlMinutes = DEFAULT_BOOT_TTL_MINUTES;
  writeJson(file, team);
  const migration = {
    from: LEGACY_BOOT_TTL_MINUTES,
    to: DEFAULT_BOOT_TTL_MINUTES,
    at: nowIso(),
    backup: backup.file,
    backupHash: backup.hash,
  };
  try {
    appendEvent({
      role: 'system', sessionId: 'boot-ttl-migration', action: 'config_migrate',
      target: file, note: `bootTtlMinutes ${migration.from} → ${migration.to}；备份 ${backup.file}`,
      data: migration,
    });
  } catch { /* 迁移已经成功；事件日志失败不把配置回滚成 30 */ }
  return team;
}

export function loadTeam() {
  if (!exists(PATHS.team)) fail('NO_TEAM', `团队未初始化：${PATHS.team}`, { hint: 'node 团队\\工具\\team.mjs init' });
  const team = readJson(PATHS.team);
  if (!team.version || !Array.isArray(team.members)) fail('BAD_TEAM', '团队配置格式不对', { path: PATHS.team });
  return migrateLegacyBootTtl(team);
}

export function saveTeam(team) {
  return writeJson(PATHS.team, team);
}

export function mutateTeam(fn) {
  return withLock('_team', { role: 'system', sessionId: 'system', ttlMs: 15000, waitMs: 5000, reason: 'team config' }, () => {
    const team = loadTeam();
    const next = fn(team) || team;
    saveTeam(next);
    return next;
  });
}

export function getMember(team, role) {
  return (team.members || []).find((m) => m.role === role && m.status !== 'removed') || null;
}

export function activeMembers(team) {
  return (team.members || []).filter((m) => m.status === 'active');
}

export function projectStateDir(projectName) {
  return path.join(PATHS.projectState, slug(projectName, 60));
}

export function projectStatePaths(projectName) {
  const dir = projectStateDir(projectName);
  return {
    dir,
    config: path.join(dir, '项目.json'),
    artifacts: path.join(dir, '产物.json'),
    tasks: path.join(dir, '任务'),
    proposals: path.join(dir, '提案'),
    commits: path.join(dir, '提交'),
    backups: path.join(dir, '备份'),
    votes: path.join(dir, '投票'),
    reqReviews: path.join(dir, '需求评审'),
    techReviews: path.join(dir, '技术评审'),
    reconcile: path.join(dir, '对账.json'),
    reconcileMd: path.join(dir, '对账.md'),
  };
}

export function projectIndexPath(project) {
  return path.join(project.path, project.index || '项目索引.md');
}

export function loadProject(name) {
  const p = projectStatePaths(name);
  if (!exists(p.config)) fail('NO_PROJECT', `项目不存在：${name}`, { hint: `node 团队\\工具\\team.mjs project add --name "${name}"` });
  const project = readJson(p.config);
  if (!exists(project.path)) fail('PROJECT_DIR_MISSING', `项目目录不存在：${project.path}`, { project });
  return project;
}

export function listProjects() {
  if (!exists(PATHS.projectState)) return [];
  const out = [];
  for (const d of fs.readdirSync(PATHS.projectState)) {
    const f = path.join(PATHS.projectState, d, '项目.json');
    if (exists(f)) {
      try { out.push(readJson(f)); } catch { /* skip broken */ }
    }
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
}

export function addProject({ name, desc = '', dir = '', createdBy = 'owner', entry = '', teamMode = 'full' }) {
  const safe = safeName(name);
  const projectDir = dir ? path.resolve(dir) : path.join(PATHS.projects, safe);
  if (!isInside(PATHS.projects, projectDir) && !isInside(PATHS.teamRoot, projectDir)) {
    fail('PROJECT_OUTSIDE', `项目目录必须在工作台项目区或团队区内：${projectDir}`);
  }
  ensureDir(projectDir);
  // 项目文档（README/项目信息/铁律/索引/协作准则/角色目录）由 lib/scaffold.mjs 按团队模式统一补齐，
  // 这里只登记项目与状态目录，避免出现两套模板。
  const p = projectStatePaths(safe);
  ensureDir(p.dir);
  ensureDir(p.tasks);
  ensureDir(p.proposals);
  ensureDir(p.commits);
  ensureDir(p.backups);
  ensureDir(p.votes);
  const mode = normalizeTeamMode(teamMode);
  const project = {
    name: safe,
    path: projectDir,
    desc: desc || '',
    entry: entry || '',
    index: '项目索引.md',
    status: 'active',
    teamMode: mode,
    roleIds: roleIdsForMode(mode),
    createdAt: nowIso(),
    createdBy,
  };
  writeJson(p.config, project);
  const team = mutateTeam((t) => {
    if (!t.activeProject) t.activeProject = safe;
    return t;
  });
  appendEvent({
    role: createdBy === 'owner' ? 'owner' : createdBy,
    sessionId: 'setup',
    action: 'project_add',
    project: safe,
    target: projectDir,
    note: desc || '新建项目',
    data: { project: safe },
  });
  return { project, team };
}

export function setActiveProject(name) {
  const project = loadProject(name);
  mutateTeam((t) => { t.activeProject = project.name; return t; });
  return project;
}

/**
 * 任务相关必读：需求正文 + 按角色的上游产出（只收录当前存在的文件）。
 * 这是“必读分层”的第二层：核心 4 份固定，任务相关按任务/需求动态带入；找不到就不写，不补造。
 */
export function requiredTaskDocs(projectName, role, task) {
  let project = null;
  try { project = loadProject(projectName); } catch { return []; }
  const root = path.resolve(project.path);
  const out = [];
  const seen = new Set();
  const addDoc = (abs, rel) => {
    if (!rel || seen.has(rel)) return;
    const record = readDocRecord(abs, rel);
    if (!record.exists) return;
    seen.add(rel);
    out.push({ rel, hash: record.hash, size: record.size });
  };
  const latestIn = (dir, pattern) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return ''; }
    const rows = names.filter((name) => pattern.test(name))
      .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return rows.length ? rows[0].name : '';
  };
  if (task && task.requirementId) {
    const id = String(task.requirementId).toLowerCase();
    let names = [];
    try { names = fs.readdirSync(path.join(root, '需求')); } catch { names = []; }
    const reqName = names.filter((name) => /^R-.*\.md$/i.test(name))
      .find((name) => name.toLowerCase().startsWith(id));
    if (reqName) addDoc(path.join(root, '需求', reqName), `需求/${reqName}`);
  }
  const upstream = role === 'product'
    ? ['analyst']
    : (role === 'programmer1' || role === 'programmer2')
      ? ['analyst', 'product']
      : role === 'tester'
        ? ['programmer1', 'programmer2', 'product']
        : [];
  for (const roleId of upstream) {
    const dirName = ROLE_DIRS[roleId];
    if (!dirName) continue;
    const dir = path.join(root, dirName, '产出');
    const file = latestIn(dir, /\.md$/i);
    if (file && !/^实现说明-v\d+\.md$/i.test(file)) addDoc(path.join(dir, file), `${dirName}/产出/${file}`);
  }
  return out;
}

/**
 * boot 必读：项目铁律 → 项目信息 → 角色卡（项目内）→ 项目索引 → 需求总览 → 相关需求 → 他人文档索引。
 * 团队宪法在项目文档之前读；全局角色卡不再回退，缺项目文档就 MISSING_DOC（不假成功）。
 * 返回每个文件的路径/大小/哈希/摘录，作为本轮 read 证据；hashes 只覆盖进令牌的规则文档。
 */
export function readDocSet(role, project) {
  const team = loadTeam();
  const member = getMember(team, role);
  if (!member) fail('NO_MEMBER', `角色不在团队：${role}`);
  if (member.status !== 'active') fail('MEMBER_INACTIVE', `角色未激活：${role}`);
  const teamMode = projectTeamMode(project);
  const modeRoles = rolesForMode(teamMode);
  if (!modeRoles.includes(role)) {
    fail('ROLE_NOT_IN_MODE', `角色 ${role} 不在${teamMode === 'fast' ? ' fast 四角色' : ' full 六角色'}模式内；项目 ${project.name} 的团队模式是 ${teamMode}`, {
      role, teamMode, roles: modeRoles,
    });
  }
  const root = path.resolve(project.path);
  const specs = bootDocSpecs(root, ROLE_DIRS[role] || '');
  const records = specs.map((spec) => {
    const record = spec.path ? readDocRecord(spec.path, spec.rel) : readDocRecord('', spec.rel);
    return { ...record, key: spec.key, label: spec.label, required: spec.required !== false, core: Boolean(spec.core) };
  });
  const missing = records.filter((r) => r.required && !r.exists).map((r) => r.label);
  if (missing.length) {
    fail('MISSING_DOC', `boot 必读文件缺失：${missing.join('、')}（项目 ${project.name}）`, {
      project: project.name,
      root,
      missing,
      hint: `node 团队\\工具\\team.mjs project ensure --name "${project.name}"`,
    });
  }
  const files = {};
  const hashes = {};
  for (const record of records) {
    if (!record.exists) continue;
    files[record.key] = record.path;
    hashes[record.key] = record.hash;
  }
  files.teamConfig = PATHS.team;
  hashes.teamConfig = hashFile(PATHS.team);
  const rulesHash = sha256(JSON.stringify({
    constitution: hashes.constitution,
    iron: hashes.iron,
    roleCard: hashes.roleCard,
    teamConfig: hashes.teamConfig,
  }));
  const requirements = readRequirementDocs(root);
  const peers = [];
  for (const other of activeMembers(team)) {
    if (other.role === role) continue;
    // 动态角色集：fast 不要求 product/programmer2，也不把它们算进“他人文档索引”。
    if (!modeRoles.includes(other.role)) continue;
    const dir = ROLE_DIRS[other.role];
    if (!dir) continue;
    const rel = `${dir}/文件索引.md`;
    const record = readDocRecord(path.join(root, dir, '文件索引.md'), rel);
    if (!record.exists) continue;
    peers.push({ role: other.role, label: `${ROLE_NAMES[other.role] || other.role} · 文件索引`, rel, path: record.path, size: record.size, hash: record.hash });
  }
  const readOrder = records.filter((r) => r.exists).map((r) => r.rel || r.path);
  // 第二层必读：只按“本人未完成任务”带需求正文与上游产出；PM 没有 owner 任务时留空，不硬凑。
  const taskDocs = [];
  const seenTaskDoc = new Set();
  for (const task of listTasks(project.name).filter((t) => t.status !== 'done' && t.type !== 'requirement' && t.owner === role).slice(0, 3)) {
    for (const doc of requiredTaskDocs(project.name, role, task)) {
      if (seenTaskDoc.has(doc.rel)) continue;
      seenTaskDoc.add(doc.rel);
      taskDocs.push({ ...doc, task: task.id });
    }
  }
  return { files, hashes, rulesHash, docs: records, requirements, peers, readOrder, taskDocs, team, member, project, teamMode, modeRoles };
}

export function bootTokenPath(token) {
  return path.join(PATHS.boots, `${token}.json`);
}

export function createBootToken({ role, project, sessionId, docs }) {
  const team = loadTeam();
  const token = randomHex(12);
  const now = Date.now();
  const teamMode = docs && docs.teamMode ? docs.teamMode : 'full';
  const data = {
    token,
    role,
    project,
    teamMode,
    sessionId: sessionId || '',
    rulesHash: docs.rulesHash,
    docHashes: docs.hashes,
    projectIndexHash: docs.hashes.projectIndex,
    // read 证据随令牌落盘：谁在什么时候读了哪些文件、哈希多少，事后可复核。
    readOrder: docs.readOrder || [],
    requirementsHash: docs.requirements ? docs.requirements.hash : '',
    requirementsContentHash: docs.requirements ? (docs.requirements.contentHash || docs.requirements.hash) : '',
    requirementsCount: docs.requirements ? docs.requirements.count : 0,
    // 需求正文逐个哈希：评审/派单前用它判断“boot 后需求是否变了”，变了就要求重新 boot 补读。
    // contentHash 忽略程序自己写的状态行/状态记录，状态流转不算“没读”。
    requirementDocs: (docs.requirements && Array.isArray(docs.requirements.list) ? docs.requirements.list : [])
      .map((row) => ({ id: row.id, rel: row.rel, hash: row.hash, contentHash: row.contentHash || row.hash, size: row.size })),
    taskDocs: Array.isArray(docs.taskDocs) ? docs.taskDocs : [],
    peers: (docs.peers || []).map((p) => ({ role: p.role, rel: p.rel, hash: p.hash })),
    createdAt: nowIso(),
    expiresAt: new Date(now + Number(team.config.bootTtlMinutes || DEFAULT_BOOT_TTL_MINUTES) * 60000).toISOString(),
    bootTtlMinutes: Number(team.config.bootTtlMinutes || DEFAULT_BOOT_TTL_MINUTES),
    host: process.env.COMPUTERNAME || '',
  };
  ensureDir(PATHS.boots);
  writeJson(bootTokenPath(token), data);
  return data;
}

export function requireBoot(token, { role, project } = {}) {
  if (!token || token === true) fail('BOOT_REQUIRED', '需要 --boot <启动令牌>；先运行 boot');
  const data = readJson(bootTokenPath(String(token)), null);
  if (!data) fail('BOOT_INVALID', `启动令牌不存在：${token}`);
  // B-b8d0（Owner 05:26 更正）：启动令牌不再按时间过期——BOOT_EXPIRED 不再出现。
  // expiresAt 仍写入作审计/prompt 展示，但**不再作为拒绝依据**；缺令牌仍 BOOT_REQUIRED，规则变更仍 RULES_CHANGED。
  if (role && data.role !== role) fail('BOOT_ROLE_MISMATCH', `令牌角色 ${data.role} ≠ 请求角色 ${role}`);
  if (project && data.project !== project) fail('BOOT_PROJECT_MISMATCH', `令牌项目 ${data.project} ≠ 请求项目 ${project}`);
  const proj = loadProject(data.project);
  const docs = readDocSet(data.role, proj);
  if (data.teamMode && docs.teamMode && data.teamMode !== docs.teamMode) {
    fail('TEAM_MODE_CHANGED', `团队模式已从 ${data.teamMode} 变为 ${docs.teamMode}，旧令牌作废；重新 boot`, {
      token: data.token, expected: data.teamMode, current: docs.teamMode,
    });
  }
  if (docs.rulesHash !== data.rulesHash) {
    fail('RULES_CHANGED', '宪法/铁律/角色卡/成员表已变化，旧令牌作废；重新 boot', {
      token: data.token,
      expected: data.rulesHash,
      current: docs.rulesHash,
    });
  }
  return { ...data, docs, team: docs.team, projectInfo: proj };
}

// ---------- 邮箱：new/cur，收件人单人读写，发件人只写 new ----------

export function mailBoxDir(role, box) {
  return path.join(PATHS.mail, role, box);
}

export function sendMessage(msg) {
  // R-9db6 F-9db6-10②：断消息通道注入（只在测试里设），用于造 RECEIPT_FAILED；生产默认不设。
  if (process.env.TEAM_MESSAGE_SEND_FAIL === '1') {
    fail('MESSAGE_SEND_FAIL', '消息通道被测试注入为失败（TEAM_MESSAGE_SEND_FAIL=1）', { to: msg && msg.to, type: msg && msg.type });
  }
  const team = loadTeam();
  if (msg.from !== 'system' && !getMember(team, msg.from)) fail('NO_SENDER', `发件人不在团队：${msg.from}`);
  const to = getMember(team, msg.to);
  if (!to || to.status !== 'active') fail('NO_RECIPIENT', `收件人不在团队或未激活：${msg.to}`);
  const max = Number(team.config.messageMaxChars || 600);
  const body = String(msg.body || '').trim();
  if (!body) fail('EMPTY_MESSAGE', '消息正文不能为空');
  if (body.length > max) fail('MESSAGE_TOO_LONG', `消息超过 ${max} 字，请拆成多条`, { length: body.length, max });
  const id = `M-${stamp()}-${randomHex(3)}`;
  const record = {
    id,
    from: msg.from,
    to: msg.to,
    subject: truncate(msg.subject || '(无主题)', 80),
    body,
    project: msg.project || '',
    task: msg.task || '',
    ackRequired: Boolean(msg.ackRequired),
    type: msg.type || 'note',
    replyTo: msg.replyTo || '',
    // 收件会话：轮换后新派单必须指向新会话，旧会话不再收到该角色派单（AC17.6/17.7）。
    recipientSessionId: String((to && to.sessionId) || ''),
    ts: nowIso(),
    // R-c651 F-c651-4：投递成功立即写 deliveredAt（未读/未回执都从这一处算，不另建未读表）。
    deliveredAt: nowIso(),
  };
  const box = mailBoxDir(msg.to, 'new');
  ensureDir(box);
  writeJson(path.join(box, `${record.ts.replace(/[:.]/g, '-')}-${id}.json`), record);
  return record;
}

export function listInbox(role, { includeCur = false, project = '' } = {}) {
  const out = [];
  for (const box of includeCur ? ['new', 'cur'] : ['new']) {
    const dir = mailBoxDir(role, box);
    if (!exists(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const msg = readJson(path.join(dir, name));
        if (project && msg.project && msg.project !== project) continue;
        out.push({ ...msg, box });
      } catch { /* skip broken */ }
    }
  }
  return out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

export function unreadCount(role, project = '') {
  return listInbox(role, { project }).length;
}

export function findMessage(role, id) {
  for (const box of ['new', 'cur']) {
    const dir = mailBoxDir(role, box);
    if (!exists(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      const msg = readJson(file, null);
      if (msg && msg.id === id) return { msg, file, box };
    }
  }
  return null;
}

export function readMessage(role, id) {
  const found = findMessage(role, id);
  if (!found) fail('MESSAGE_NOT_FOUND', `消息不存在：${id}`);
  let targetFile = found.file;
  if (found.box === 'new') {
    const dst = path.join(mailBoxDir(role, 'cur'), path.basename(found.file));
    ensureDir(path.dirname(dst));
    try { fs.renameSync(found.file, dst); } catch (e) {
      if (e.code === 'EEXIST') fs.rmSync(found.file, { force: true });
      else throw e;
    }
    targetFile = dst;
  }
  // R-c651 F-c651-4：读取即写 readAt；旧消息没有 readAt 的按 deliveredAt||ts 派生并标 legacyRead（只读兼容，不另建未读表）。
  let msg = found.msg;
  if (!msg.readAt) {
    msg = found.box === 'cur'
      ? { ...msg, readAt: String(msg.deliveredAt || msg.ts || nowIso()), legacyRead: true }
      : { ...msg, readAt: nowIso() };
    try { writeJson(targetFile, msg); } catch { /* 读动作不因写回失败中断 */ }
  }
  return { msg, alreadyRead: found.box === 'cur' };
}

export function loadReceipts() {
  return readJsonl(PATHS.receipts);
}

export function ackMessage(role, id, note) {
  const team = loadTeam();
  const maxNote = Number(team.config.ackNoteMaxChars || 300);
  const rawNote = String(note || '已收到').trim();
  if (rawNote.length > maxNote) fail('RECEIPT_TOO_LONG', `回执超过 ${maxNote} 字（对账回执大小限制）`, { length: rawNote.length, max: maxNote });
  const found = findMessage(role, id);
  if (!found) fail('MESSAGE_NOT_FOUND', `消息不存在：${id}`);
  // 旧会话消息只读不可执行：轮换后归档消息不许再 ack/执行，必须走新会话（AC17.6）。
  if (found.msg.archivedSession) {
    fail('MESSAGE_ARCHIVED', `消息 ${id} 属于已归档旧会话 ${found.msg.archivedSession}，只能读、不能执行；请用新会话 ${found.msg.replacedBySessionId || '(session rotate 后的新会话)'} 重新派单/处理`, {
      messageId: id, archivedSession: found.msg.archivedSession, replacedBySessionId: found.msg.replacedBySessionId || '',
    });
  }
  const existing = loadReceipts().find((r) => r.msgId === id && r.from === role);
  if (existing) return { ack: existing, already: true, msg: found.msg, receiptMessage: null };
  readMessage(role, id);
  // R-c651 F-c651-4：回执补 ackAt（readAt 已由 readMessage 写入；缺 deliveredAt 的旧消息在这里补齐）。
  try {
    const afterRead = findMessage(role, id);
    if (afterRead && afterRead.msg) {
      const stampNow = nowIso();
      writeJson(afterRead.file, {
        ...afterRead.msg,
        deliveredAt: String(afterRead.msg.deliveredAt || afterRead.msg.ts || stampNow),
        readAt: String(afterRead.msg.readAt || stampNow),
        ackAt: stampNow,
      });
    }
  } catch { /* 留痕失败不影响回执生成 */ }
  const ack = {
    id: `A-${stamp()}-${randomHex(3)}`,
    msgId: id,
    from: role,
    to: found.msg.from,
    project: found.msg.project || '',
    note: truncate(rawNote, maxNote),
    log: truncate(rawNote, 160),
    ts: nowIso(),
  };
  appendLine(PATHS.receipts, JSON.stringify(ack));
  let receiptMessage = null;
  // 关键：回执消息不再回执，否则会 回执→回执→回执 无限递归。
  if (found.msg.from !== 'system' && found.msg.type !== 'receipt') {
    receiptMessage = sendMessage({
      from: role,
      to: found.msg.from,
      subject: `回执: ${found.msg.subject}`,
      body: `已回执 ${id}：${ack.note}\n（仅表示收到/认领，不代表完成；完成另发完成回执 + task done）`,
      project: found.msg.project,
      task: found.msg.task,
      type: 'receipt',
      replyTo: id,
      ackRequired: false,
    });
    ack.receiptMessageId = receiptMessage.id;
    // 回写回执消息 id（追加一行更新记录，保持 append-only）
    appendLine(PATHS.receipts, JSON.stringify({ ...ack, update: true, receiptMessageId: receiptMessage.id }));
  }
  return { ack, already: false, msg: found.msg, receiptMessage };
}

// ---------- 任务 ----------

export function taskPath(project, id) {
  return path.join(projectStatePaths(project).tasks, `${id}.json`);
}

export function createTask({ project, title, detail = '', priority, priorityBy, createdBy, owner = null, due = '', type = 'task', requirementId = '', acceptance = '', story = '' }) {
  if (!['P0', 'P1', 'P2', 'P3'].includes(priority)) fail('BAD_PRIORITY', '优先级必须是 P0/P1/P2/P3');
  if (!title) fail('EMPTY_TITLE', '任务标题不能为空');
  if (!['requirement', 'task', 'bug', 'chore'].includes(type)) fail('BAD_TYPE', '类型必须是 requirement/task/bug/chore');
  const id = `${type === 'requirement' ? 'R' : type === 'bug' ? 'B' : 'T'}-${stamp()}-${randomHex(2)}`;
  const task = {
    id,
    project,
    type,
    requirementId: requirementId || '',
    title: truncate(title, 120),
    detail: truncate(detail, 2000),
    acceptance: truncate(acceptance, 1500),
    story: truncate(story, 1500),
    priority,
    priorityBy: priorityBy || createdBy,
    priorityReason: '',
    owner: owner || null,
    status: owner ? 'working' : 'open',
    createdBy,
    createdAt: nowIso(),
    claimedAt: owner ? nowIso() : null,
    due: due || '',
    doneAt: null,
    evidence: '',
    rev: 1,
    history: [{ ts: nowIso(), by: createdBy, action: 'create', note: `${type} priority=${priority}` }],
  };
  ensureDir(path.dirname(taskPath(project, id)));
  writeJson(taskPath(project, id), task);
  return task;
}

export function loadTask(project, id) {
  const f = taskPath(project, id);
  if (!exists(f)) fail('TASK_NOT_FOUND', `任务不存在：${id}`);
  return readJson(f);
}

export function saveTask(project, task) {
  task.rev = Number(task.rev || 0) + 1;
  task.history = Array.isArray(task.history) ? task.history : [];
  task.history.push({ ts: nowIso(), by: task._by || 'system', action: task._action || 'update', note: task._note || '' });
  delete task._by; delete task._action; delete task._note;
  writeJson(taskPath(project, task.id), task);
  return task;
}

export function listTasks(project) {
  const dir = projectStatePaths(project).tasks;
  if (!exists(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try { out.push(readJson(path.join(dir, name))); } catch { /* skip */ }
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function claimTask(project, id, role, sessionId) {
  return withLock(`task:${project}:${id}`, { role, sessionId, ttlMs: 15000, waitMs: 5000, reason: 'claim task' }, () => {
    const task = loadTask(project, id);
    if (task.status === 'done') fail('TASK_DONE', `任务已完成：${id}`);
    if (task.owner && task.owner !== role) fail('TASK_OWNED', `任务已被 ${task.owner} 认领`, { owner: task.owner });
    task.owner = role;
    task.status = 'working';
    task.claimedAt = nowIso();
    task._by = role; task._action = 'claim'; task._note = sessionId || '';
    return saveTask(project, task);
  });
}

export function finishTask(project, id, role, evidence, note = '', extra = {}) {
  return withLock(`task:${project}:${id}`, { role, ttlMs: 15000, waitMs: 5000, reason: 'finish task' }, () => {
    const task = loadTask(project, id);
    if (task.status === 'done') fail('TASK_DONE', `任务已完成：${id}`);
    if (task.owner && task.owner !== role && role !== 'pm') fail('TASK_NOT_OWNER', `只有 owner 或 PM 能完成任务`, { owner: task.owner });
    if (!evidence) fail('EVIDENCE_REQUIRED', '完成任务必须带 --evidence（提交号/路径/验证输出）');
    task.status = 'done';
    task.doneAt = nowIso();
    task.evidence = truncate(evidence, 500);
    // G9 证据门（T-20261113-063141-70a9）：把核过的证据文件（路径/大小/mtime/sha256）写进任务，供复核。
    if (extra && Array.isArray(extra.evidenceFiles) && !extra.skipped) {
      task.evidenceFiles = extra.evidenceFiles;
      task.evidenceCheckedAt = String(extra.checkedAt || nowIso());
    }
    if (note) task.detail = truncate(task.detail + '\n\n完成说明：' + note, 3000);
    task._by = role; task._action = 'done'; task._note = truncate(evidence, 100);
    return saveTask(project, task);
  });
}

export function setTaskPriority(project, id, priority, by, reason = '') {
  if (!['P0', 'P1', 'P2', 'P3'].includes(priority)) fail('BAD_PRIORITY', '优先级必须是 P0/P1/P2/P3');
  return withLock(`task:${project}:${id}`, { role: by, ttlMs: 15000, waitMs: 5000, reason: 'priority' }, () => {
    const task = loadTask(project, id);
    task.priority = priority;
    task.priorityBy = by;
    task.priorityReason = truncate(reason, 300);
    task._by = by; task._action = 'priority'; task._note = `${priority} ${reason}`;
    return saveTask(project, task);
  });
}

// ---------- 提案 / 评审 / 签字 / 提交 ----------

export function proposalPaths(project, id) {
  const dir = path.join(projectStatePaths(project).proposals, id);
  return {
    dir,
    proposal: path.join(dir, '提案.json'),
    files: path.join(dir, '文件'),
    reviews: path.join(dir, '评审'),
    signatures: path.join(dir, '签字'),
  };
}

export function newProposal({ project, author, authorSession, task, title, rationale, risk, scope = 'project', files }) {
  const root = projectStatePaths(project).proposals;
  ensureDir(root);
  let id;
  let dir;
  for (let i = 0; i < 20; i++) {
    id = `P-${stamp()}-${randomHex(3)}`;
    dir = path.join(root, id);
    try { fs.mkdirSync(dir); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  ensureDir(path.join(dir, '文件'));
  ensureDir(path.join(dir, '评审'));
  ensureDir(path.join(dir, '签字'));
  const proposal = {
    id,
    project,
    task,
    author,
    authorSession: authorSession || '',
    title: truncate(title, 160),
    rationale: truncate(rationale, 3000),
    risk,
    // R-3911：提案范围；历史提案没有该字段，读取时按 project 兼容。
    scope: scope === 'shared' ? 'shared' : 'project',
    // R-3911 P1-1：v2 哈希覆盖 scope；历史提案无该字段，按旧算法校验，不强制迁移。
    hashVersion: 2,
    status: 'proposed',
    createdAt: nowIso(),
    files,
    reviews: {},
    signatures: {},
  };
  proposal.proposalHash = computeProposalHash(proposal);
  writeJson(path.join(dir, '提案.json'), proposal);
  return proposal;
}

function canonicalFiles(files) {
  return [...files].map((f) => ({ target: f.target, baseHash: f.baseHash, newHash: f.newHash, size: f.size })).sort((a, b) => a.target.localeCompare(b.target));
}

export function computeProposalHash(p) {
  const payload = {
    id: p.id,
    project: p.project,
    task: p.task,
    author: p.author,
    title: p.title,
    rationale: p.rationale,
    risk: p.risk,
    files: canonicalFiles(p.files || []),
    createdAt: p.createdAt,
  };
  // R-3911 P1-1：v2 哈希纳入 scope，防止“同一份签字复用到换根提案”（project ↔ shared）。
  // 历史提案没有 hashVersion 字段：保持旧算法（不含 scope/hashVersion），不破坏既有 proposalHash/签字链；
  // 新提案由 newProposal 写 hashVersion=2，哈希必然覆盖 hashVersion 与 scope。
  if (p.hashVersion === 2) {
    payload.hashVersion = 2;
    payload.scope = p.scope === 'shared' ? 'shared' : 'project';
  }
  return sha256(JSON.stringify(payload));
}

export function loadProposal(project, id) {
  const p = proposalPaths(project, id);
  if (!exists(p.proposal)) fail('PROPOSAL_NOT_FOUND', `提案不存在：${id}`);
  return readJson(p.proposal);
}

export function saveProposal(project, proposal) {
  const p = proposalPaths(project, proposal.id);
  writeJson(p.proposal, proposal);
  return proposal;
}

export function listProposals(project) {
  const root = projectStatePaths(project).proposals;
  if (!exists(root)) return [];
  const out = [];
  for (const id of fs.readdirSync(root)) {
    const f = path.join(root, id, '提案.json');
    if (!exists(f)) continue;
    try { out.push(readJson(f)); } catch { /* skip */ }
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

const PROPOSAL_STATUS_TEXT = {
  proposed: '已提案', shown: '已展示', reviewed: '已评审', signed: '已签字',
  applied: '已应用', rejected: '已拒绝', review: '评审中', approved: '已批准',
};

/**
 * 项目内的人读提案镜像：<项目>/提案/index.md + <项目>/提案/<P-...>/提案.md。
 * 团队状态里的 提案/ 仍是唯一真相；这里只做只读镜像，让 Owner 不靠 Agent 记忆也能追踪每轮提案。
 */
/**
 * 开发角色的“产出/代码快照-vN/”：apply 后把本次提交的代码复制一份到本角色目录，
 * 并生成 实现说明-vN.md（含任务、提案、提交、哈希）。代码本体仍以 site/** 为准。
 * 这是派生镜像，不参与 CAS；失败不回滚提交，只返回错误给调用方记日志。
 */
export function syncDevOutput(projectName, proposal, commit) {
  const author = String((proposal && proposal.author) || '');
  if (!['programmer1', 'programmer2'].includes(author)) return null;
  const project = loadProject(projectName);
  const roleDir = ROLE_DIRS[author];
  const outRoot = path.join(project.path, roleDir, '产出');
  let version = 1;
  try {
    const used = fs.readdirSync(outRoot)
      .map((name) => /^代码快照-v(\d+)$/.exec(name))
      .filter(Boolean)
      .map((m) => Number(m[1]));
    version = (used.length ? Math.max(...used) : 0) + 1;
  } catch { /* 首次 */ }
  const snapDir = path.join(outRoot, `代码快照-v${version}`);
  ensureDir(snapDir);
  const copied = [];
  for (const row of (commit && Array.isArray(commit.after) ? commit.after : [])) {
    const rel = String(row.target || '').replace(/\\/g, '/');
    if (!/^(site|src|app|public)\//i.test(rel)) continue;
    const from = path.join(project.path, rel);
    if (!exists(from)) continue;
    const to = path.join(snapDir, rel);
    ensureDir(path.dirname(to));
    fs.copyFileSync(from, to);
    copied.push({ target: rel, hash: row.hash || hashFile(from), size: fs.statSync(from).size });
  }
  const note = `# 实现说明 · v${version}\n\n`
    + `- 项目：${projectName}\n- 角色：${author}\n- 任务：${proposal.task || '—'}\n`
    + `- 提案：${proposal.id}（${String(proposal.proposalHash || '').slice(0, 16)}）\n`
    + `- 提交：${commit ? commit.id : '—'}\n- 时间：${nowIso()}\n\n`
    + `## 本次代码快照\n\n| 文件 | 大小 | 哈希 |\n|---|---|---|\n`
    + (copied.map((row) => `| ${row.target} | ${row.size} B | ${String(row.hash).slice(0, 16)} |`).join('\n') || '| （无 site/src 文件） | | |')
    + `\n\n> 代码本体在项目 \`site/**\`（或其他代码目录）；本快照是 apply 后的只读副本，版本递增、不覆盖历史。\n`;
  writeText(path.join(outRoot, `实现说明-v${version}.md`), note);
  return { ok: true, role: author, version, dir: snapDir, files: copied.length };
}

export function syncProposalMirror(projectName) {  let project = null;
  try { project = loadProject(projectName); } catch { return null; }
  if (!project || !project.path) return null;
  const root = path.join(path.resolve(project.path), '提案');
  const proposals = listProposals(projectName);
  const commits = (() => { try { return listCommits(projectName); } catch { return []; } })();
  const rows = [];
  for (const proposal of proposals) {
    const reviews = (() => { try { return loadReviews(projectName, proposal.id); } catch { return {}; } })();
    const signatures = (() => { try { return loadSignatures(projectName, proposal.id); } catch { return {}; } })();
    const commit = commits.find((row) => String(row.proposalId) === String(proposal.id)) || null;
    const status = commit ? 'applied' : String(proposal.status || '');
    const statusText = PROPOSAL_STATUS_TEXT[status] || status || '未记录';
    const fileRows = (Array.isArray(proposal.files) ? proposal.files : [])
      .map((file) => `| ${String(file.target || '').replace(/\|/g, '/')} | ${Number(file.size || 0)} B | ${String(file.newHash || file.contentHash || '').slice(0, 16)} | ${file.baseHash === 'absent' ? '新建' : String(file.baseHash || '').slice(0, 12) || '—'} |`)
      .join('\n');
    const reviewRows = Object.entries(reviews)
      .map(([role, row]) => `- ${role}：${row && row.verdict ? row.verdict : '未记录'}${row && row.comments ? ' · ' + String(row.comments).replace(/\s+/g, ' ').slice(0, 300) : ''}`)
      .join('\n') || '- （暂无评审）';
    const signRows = Object.entries(signatures)
      .map(([role, row]) => `- ${role}：${row && row.decision ? row.decision : '未记录'}${row && row.note ? ' · ' + String(row.note).replace(/\s+/g, ' ').slice(0, 200) : ''}`)
      .join('\n') || '- （暂无签字）';
    const md = `# ${proposal.id} · ${proposal.title || '未命名提案'}\n\n`
      + `- 项目：${projectName}\n`
      + `- 作者：${proposal.author || '—'}｜任务：${proposal.task || '—'}｜风险：${proposal.risk || '—'}\n`
      + `- 状态：${statusText}${commit ? `（提交 ${commit.id}）` : ''}\n`
      + `- 创建：${proposal.createdAt || '—'}｜提案哈希：${String(proposal.proposalHash || '').slice(0, 16)}\n`
      + `- 真相：团队\\状态\\项目\\${projectName}\\提案\\${proposal.id}\\（本文件是只读镜像）\n\n`
      + `## 一、改了什么\n\n${String(proposal.rationale || '（未写理由）').trim()}\n\n`
      + `## 二、文件\n\n| 目标 | 大小 | 新哈希 | 基线 |\n|---|---|---|---|\n${fileRows || '| （无） | | | |'}\n\n`
      + `## 三、评审\n\n${reviewRows}\n\n`
      + `## 四、签字\n\n${signRows}\n\n`
      + `## 五、提交\n\n${commit ? `- ${commit.id} · ${commit.createdAt || ''}${commit.note ? ' · ' + commit.note : ''}` : '- （尚未提交）'}\n`;
    ensureDir(path.join(root, proposal.id));
    writeText(path.join(root, proposal.id, '提案.md'), md);
    const reviewText = Object.entries(reviews).map(([role, row]) => `${role}:${row && row.verdict ? row.verdict : '—'}`).join('；') || '—';
    const signText = Object.entries(signatures).map(([role, row]) => `${role}:${row && row.decision ? row.decision : '—'}`).join('；') || '—';
    rows.push(`| [${proposal.id}](${proposal.id}/提案.md) | ${String(proposal.title || '').replace(/\|/g, '/').slice(0, 40)} | ${proposal.author || '—'} | ${proposal.risk || '—'} | ${statusText} | ${(proposal.files || []).map((f) => f.target).join('<br>') || '—'} | ${reviewText} | ${signText} | ${commit ? commit.id : '—'} | ${proposal.createdAt || '—'} |`);
  }
  // ceba AC6：镜像是团队状态的人读派生。团队状态里已不存在的 P-* 目录必须清掉，
  // 否则会出现「团队状态 0 条提案、项目内却有 提案/index.md + P-* 目录」的不一致（测试就是这么抓到的）。
  const prunedStale = [];
  try {
    const alive = new Set(proposals.map((p) => String(p.id)));
    for (const entry of fs.readdirSync(root)) {
      if (!/^P-/.test(entry) || alive.has(entry)) continue;
      fs.rmSync(path.join(root, entry), { recursive: true, force: true });
      prunedStale.push(entry);
    }
  } catch { /* 目录不存在/权限问题不阻断同步 */ }
  const index = `# 提案记录 · ${projectName}\n\n`
    + `> 由 team.mjs 在 propose/review/sign/apply 后自动生成；**团队状态目录里的 提案/ 是唯一真相**，本目录是给 Owner 看的人读镜像。\n`
    + `> 每轮一个 \`P-...\`；不要手改本目录，改了也不会回写团队状态。\n\n`
    + `共 ${proposals.length} 个提案。\n\n`
    + `| 提案 | 标题 | 作者 | 风险 | 状态 | 目标文件 | 评审 | 签字 | 提交 | 创建 |\n`
    + `|---|---|---|---|---|---|---|---|---|---|\n`
    + (rows.join('\n') || '| （暂无提案） | | | | | | | | | |')
    + '\n';
  ensureDir(root);
  writeText(path.join(root, 'index.md'), index);
  // ceba AC6：把这次清掉的过时镜像目录也带出去，回执/测试可直接核对。
  return { ok: true, dir: root, count: proposals.length, pruned: prunedStale };
}

export function saveReview(project, proposalId, role, review) {
  const p = proposalPaths(project, proposalId);
  ensureDir(p.reviews);
  writeJson(path.join(p.reviews, `${role}.json`), review);
  return review;
}

export function loadReviews(project, proposalId) {
  const p = proposalPaths(project, proposalId);
  const out = {};
  if (!exists(p.reviews)) return out;
  for (const name of fs.readdirSync(p.reviews)) {
    if (!name.endsWith('.json')) continue;
    const role = name.replace(/\.json$/, '');
    out[role] = readJson(path.join(p.reviews, name));
  }
  return out;
}

export function saveSignature(project, proposalId, role, sig) {
  const p = proposalPaths(project, proposalId);
  ensureDir(p.signatures);
  writeJson(path.join(p.signatures, `${role}.json`), sig);
  return sig;
}

export function loadSignatures(project, proposalId) {
  const p = proposalPaths(project, proposalId);
  const out = {};
  if (!exists(p.signatures)) return out;
  for (const name of fs.readdirSync(p.signatures)) {
    if (!name.endsWith('.json')) continue;
    const role = name.replace(/\.json$/, '');
    out[role] = readJson(path.join(p.signatures, name));
  }
  return out;
}

export function signatureDigest({ role, proposalId, proposalHash, baseHash, newHash, decision, ts, nonce }) {
  return sha256([role, proposalId, proposalHash, baseHash, newHash, decision, ts, nonce].join('|'));
}

export function commitPath(project, commitId) {
  return path.join(projectStatePaths(project).commits, `${commitId}.json`);
}

export function saveCommit(project, commit) {
  writeJson(commitPath(project, commit.id), commit);
  return commit;
}

export function loadCommit(project, commitId) {
  const f = commitPath(project, commitId);
  if (!exists(f)) fail('COMMIT_NOT_FOUND', `提交不存在：${commitId}`);
  return readJson(f);
}

export function listCommits(project) {
  const dir = projectStatePaths(project).commits;
  if (!exists(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try { out.push(readJson(path.join(dir, name))); } catch { /* skip */ }
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function loadArtifacts(project) {
  const f = projectStatePaths(project).artifacts;
  if (!exists(f)) return { version: 1, artifacts: {} };
  const data = readJson(f);
  if (!data.artifacts) data.artifacts = {};
  return data;
}

export function saveArtifacts(project, data) {
  writeJson(projectStatePaths(project).artifacts, data);
  return data;
}

// ---------- 授权 ----------

export function grantPath(role) {
  return path.join(PATHS.grants, `${role}.json`);
}

export function loadGrants(role) {
  const f = grantPath(role);
  if (!exists(f)) return { role, grants: [] };
  return readJson(f);
}

export function saveGrants(role, data) {
  writeJson(grantPath(role), data);
  return data;
}

export function activeGrants(role, project = null) {
  const data = loadGrants(role);
  const now = Date.now();
  return (data.grants || []).filter((g) => {
    if (g.revokedAt) return false;
    if (g.expiresAt && Date.parse(g.expiresAt) < now) return false;
    if (project && g.project !== '*' && g.project !== project) return false;
    return true;
  });
}

/**
 * 授权 scope 的 glob → 正则：单遍扫描，避免 `**` 先变 `.*` 再被 `*` 规则二次替换成 `.[^/]*`。
 * 规则：`**` 跨目录、`*` 不跨 `/`、`?` 匹配非 `/` 单字符；其余字符按正则转义。
 */
export function scopeGlobToRegExp(scope) {
  const src = String(scope == null ? '**' : scope).replace(/\\/g, '/');
  let pattern = '';
  for (let index = 0; index < src.length; index += 1) {
    const ch = src[index];
    if (ch === '*') {
      if (src[index + 1] === '*') {
        pattern += '.*';
        index += 1;
      } else {
        pattern += '[^/]*';
      }
    } else if (ch === '?') {
      pattern += '[^/]';
    } else {
      pattern += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + pattern + '$', 'i');
}

export function hasGrant(role, action, project, targetRel) {
  if (role === 'pm' || role === 'owner') return true;
  const grants = activeGrants(role, project);
  return grants.some((g) => {
    const actions = Array.isArray(g.actions) ? g.actions : [g.actions];
    if (!actions.includes(action) && !actions.includes('*')) return false;
    const scopes = Array.isArray(g.scope) ? g.scope : [g.scope || '**'];
    return scopes.some((s) => {
      if (s === '**' || s === '*') return true;
      return scopeGlobToRegExp(s).test(String(targetRel).replace(/\\/g, '/'));
    });
  });
}

export function addGrant({ role, actions, scope, project, grantedBy, expiresAt, reason }) {
  const data = loadGrants(role);
  const grant = {
    id: `G-${stamp()}-${randomHex(2)}`,
    role,
    actions: Array.isArray(actions) ? actions : [actions],
    scope: Array.isArray(scope) ? scope : [scope],
    project,
    grantedBy,
    grantedAt: nowIso(),
    expiresAt,
    reason: truncate(reason, 300),
  };
  data.grants = data.grants || [];
  data.grants.push(grant);
  saveGrants(role, data);
  return grant;
}

export function revokeGrant(role, id, by, reason = '') {
  const data = loadGrants(role);
  const g = (data.grants || []).find((x) => x.id === id);
  if (!g) fail('GRANT_NOT_FOUND', `授权不存在：${id}`);
  g.revokedAt = nowIso();
  g.revokedBy = by;
  g.revokeReason = truncate(reason, 200);
  saveGrants(role, data);
  return g;
}

// ---------- 阅读回执 ----------

export function addReadReceipt(receipt) {
  const owner = acquireLock('_reads', { role: 'system', sessionId: 'system', ttlMs: 10000, waitMs: 5000, reason: 'read receipt' });
  try {
    appendLine(PATHS.reads, JSON.stringify({ ...receipt, ts: receipt.ts || nowIso() }));
  } finally {
    releaseLock('_reads', { role: 'system' });
  }
}

export function latestRead({ role, sessionId, proposalId, proposalHash, maxAgeMs }) {
  const { items } = readJsonlTolerant(PATHS.reads);
  const cutoff = Date.now() - Number(maxAgeMs || 15 * 60000);
  let best = null;
  for (const r of items) {
    if (r.role !== role) continue;
    if (sessionId && r.sessionId && r.sessionId !== sessionId) continue;
    if (proposalId && r.proposalId !== proposalId) continue;
    if (proposalHash && r.proposalHash !== proposalHash) continue;
    const ts = Date.parse(r.ts);
    if (Number.isNaN(ts) || ts < cutoff) continue;
    if (!best || ts > Date.parse(best.ts)) best = r;
  }
  return best;
}

export function projectIndexExists(project) {
  return exists(projectIndexPath(project));
}

export function projectRel(project, abs) {
  return relPath(project.path, abs);
}
