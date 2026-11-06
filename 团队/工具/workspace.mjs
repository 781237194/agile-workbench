#!/usr/bin/env node
// 新建 DSH 工作区 + 六角色目录/协作准则/索引。
// 用法：node workspace.mjs create --name "项目名" [--root <项目根目录>] [--engine-url http://127.0.0.1:xxxx] [--no-register] [--json]
// 项目文档模板统一在 lib/scaffold.mjs；本文件只负责 DSH 工作区注册、登记与 当前工作区.json。
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, appendEvent, jsonOut, textOut, nowIso, fail, isInside } from './lib/core.mjs';
import { ROLE_DIRS, LIMITS, MODEL_BY_ROLE, TEAM_MODES, isTeamMode, normalizeTeamMode, rolesForMode, roleIdsForMode, TEAM_MODE_LABELS } from './lib/roles.mjs';
import { projectStatePaths, setActiveProject } from './lib/store.mjs';
import { generateIndex } from './lib/ops.mjs';
import { ensureProjectStructure } from './lib/scaffold.mjs';
import { DshClient } from './lib/dsh-session.mjs';

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const n = argv[i + 1];
      if (n !== undefined && !n.startsWith('--')) { out[k] = n; i++; } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

function safeWorkspaceName(v) {
  const name = String(v || '').trim();
  if (!name || name.length > 40 || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') {
    fail('BAD_WORKSPACE_NAME', '工作区名须为 1-40 字，且不含 \\ / : * ? " < > |');
  }
  return name;
}

function ensure(p) { fs.mkdirSync(p, { recursive: true }); }
function write(p, text) { ensure(path.dirname(p)); fs.writeFileSync(p, text, 'utf8'); }
function exists(p) { return fs.existsSync(p); }

// 按团队模式建角色目录 + 角色卡 + 文件索引 + 产出/ + 项目信息/铁律/索引/README/协作准则 + 需求池 + site + _tmp
// 全部由 lib/scaffold.mjs 生成；这里只补 workspace.json（DSH 工作区元数据）。
function scaffold(project, target, workspaceId, { overwrite = true, teamMode = 'full' } = {}) {
  const mode = normalizeTeamMode(teamMode);
  const roleIds = roleIdsForMode(mode);
  const structure = ensureProjectStructure({ name: project, root: target, overwrite, teamMode: mode });
  if (!structure.ok) {
    fail('WORKSPACE_STRUCTURE_INCOMPLETE', `工作区结构不完整：缺少 ${structure.missing.join('、')}`, { path: target, missing: structure.missing });
  }
  const metadata = {
    version: 1,
    name: project,
    path: target,
    teamMode: mode,
    roleIds,
    dshWorkspaceId: workspaceId || null,
    engineUrl: args['engine-url'] || process.env.DSH_WEB_URL || null,
    roles: roleIds.map((role) => ({ role, dir: ROLE_DIRS[role], model: MODEL_BY_ROLE[role] || null })),
    limits: LIMITS,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const metaFile = path.join(target, 'workspace.json');
  if (overwrite || !exists(metaFile)) {
    write(metaFile, JSON.stringify(metadata, null, 2) + '\n');
  } else {
    // ensure 不重建模板，但团队模式是结构口径：显式传 --team-mode 时同步进 workspace.json。
    try {
      const old = JSON.parse(fs.readFileSync(metaFile, 'utf8').replace(/^\uFEFF/, ''));
      const oldRoleIds = Array.isArray(old.roleIds) ? old.roleIds : [];
      const oldRoles = Array.isArray(old.roles) ? old.roles : [];
      // 角色模型可能被工作台按项目改过：保留旧条目里的 model，缺失才用默认。
      const nextRoles = roleIds.map((role) => {
        const prev = oldRoles.find((entry) => entry && entry.role === role);
        return { role, dir: ROLE_DIRS[role], model: (prev && prev.model) || MODEL_BY_ROLE[role] || null };
      });
      const rolesChanged = JSON.stringify(oldRoles) !== JSON.stringify(nextRoles);
      if (old.teamMode !== mode || oldRoleIds.join(',') !== roleIds.join(',') || rolesChanged) {
        old.teamMode = mode;
        old.roleIds = roleIds;
        old.roles = nextRoles;
        old.updatedAt = nowIso();
        write(metaFile, JSON.stringify(old, null, 2) + '\n');
      }
    } catch { /* 老目录 meta 坏了就跳过，下一次 create/ensure 会补 */ }
  }
  return metadata;
}

function registerTeamProject(project, target, workspaceId, teamMode = 'full') {
  const p = projectStatePaths(project);
  for (const d of [p.dir, p.tasks, p.proposals, p.commits, p.backups, p.votes]) ensure(d);
  const mode = normalizeTeamMode(teamMode);
  // 合并旧登记，避免 ensure 丢掉 dshWorkspaceId / desc / createdAt 等已有字段。
  let old = null;
  try { old = JSON.parse(fs.readFileSync(p.config, 'utf8').replace(/^\uFEFF/, '')); } catch { /* 未登记 */ }
  const cfg = {
    ...(old || {}),
    name: project,
    path: target,
    desc: old?.desc || `${TEAM_MODE_LABELS[mode]}协同工作区（徐野风工作台创建）`,
    entry: old?.entry || '项目索引.md',
    index: old?.index || '项目索引.md',
    status: old?.status || 'active',
    teamMode: mode,
    roleIds: roleIdsForMode(mode),
    createdAt: old?.createdAt || nowIso(),
    createdBy: old?.createdBy || 'owner',
    dshWorkspaceId: workspaceId || old?.dshWorkspaceId || null,
  };
  fs.writeFileSync(p.config, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  setActiveProject(project);
  return cfg;
}

const args = parse(process.argv.slice(2));

function workspaceModeOf(target, project) {
  // 真相优先：项目.json（团队工具写）→ workspace.json（工作区镜像）→ full。
  try {
    const cfg = JSON.parse(fs.readFileSync(projectStatePaths(project).config, 'utf8').replace(/^\uFEFF/, ''));
    if (cfg.teamMode) return normalizeTeamMode(cfg.teamMode);
  } catch { /* 未登记 */ }
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(target, 'workspace.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (meta.teamMode) return normalizeTeamMode(meta.teamMode);
  } catch { /* 老目录没有 workspace.json */ }
  return 'full';
}

async function main() {
  const cmd = args._[0] || 'create';
  if (cmd !== 'create' && cmd !== 'ensure') fail('BAD_COMMAND', '支持 workspace.mjs create | ensure');
  const project = safeWorkspaceName(args.name);
  const modeArg = args['team-mode'];
  if (modeArg !== undefined && (modeArg === true || !isTeamMode(modeArg))) {
    fail('BAD_TEAM_MODE', `--team-mode 只能是 ${TEAM_MODES.join(' / ')}：${modeArg === true ? '（缺值）' : modeArg}`, { allowed: TEAM_MODES });
  }
  const explicitMode = modeArg !== undefined ? normalizeTeamMode(modeArg) : '';
  const root = path.resolve(String(args.root || PATHS.projects));
  const allowExternal = Boolean(args['allow-external']);
  if (!allowExternal && !isInside(PATHS.projects, root) && !isInside(PATHS.workspace, root)) {
    fail('WORKSPACE_ROOT_FORBIDDEN', `工作区根目录必须在 ${PATHS.projects} 或 ${PATHS.workspace} 内；外部目录请在界面用“打开项目文件夹”`);
  }
  const target = path.join(root, project);
  const metadataFile = path.join(target, 'workspace.json');
  const noRegister = Boolean(args['no-register']);
  if (args['dry-run']) {
    const teamMode = explicitMode || workspaceModeOf(target, project);
    const plan = {
      ok: true, dryRun: true, name: project, root, target, exists: exists(target),
      teamMode,
      roles: rolesForMode(teamMode).map((role) => ({ role, dir: ROLE_DIRS[role], model: MODEL_BY_ROLE[role] || null })),
      limits: LIMITS,
    };
    if (args.json) jsonOut(plan);
    else textOut(`DRY RUN · ${target} · ${TEAM_MODE_LABELS[teamMode]}`);
    return;
  }
  if (cmd === 'ensure') {
    const target = path.resolve(String(args.path || path.join(root, project)));
    if (!exists(target)) fail('WORKSPACE_NOT_FOUND', `工作区目录不存在：${target}`);
    if (!allowExternal && !isInside(PATHS.workspace, target) && !isInside(PATHS.projects, target)) {
      fail('WORKSPACE_ROOT_FORBIDDEN', `工作区必须在 ${PATHS.workspace} 或 ${PATHS.projects} 内；外部目录请带 --allow-external`);
    }
    let oldId = null;
    try { oldId = JSON.parse(fs.readFileSync(path.join(target, 'workspace.json'), 'utf8').replace(/^\uFEFF/, '')).dshWorkspaceId || null; } catch { /* legacy */ }
    const teamMode = explicitMode || workspaceModeOf(target, project);
    const meta = scaffold(project, target, oldId, { overwrite: false, teamMode });
    const cfg = registerTeamProject(project, target, oldId, teamMode);
    const idx = generateIndex(cfg, { by: 'owner', sessionId: 'workspace-ensure', silent: true });
    if (args.json) jsonOut({ ok: true, ensure: true, teamMode, workspace: meta, project: cfg, index: idx });
    else textOut(`工作区已补齐：${target}（${TEAM_MODE_LABELS[teamMode]}）`);
    return;
  }
  if (cmd !== 'create') fail('BAD_COMMAND', '支持 workspace.mjs create | ensure');
  // 一个工作台 = 一个项目 = 一个目录；已有同名目录/登记只能走“建团队/恢复”，不能重复新建。
  if (exists(target)) {
    fail('WORKSPACE_EXISTS', `同名项目文件夹已存在：${target}。请点「建团队/恢复」选择该项目，不要新建同名工作区。`, { path: target });
  }
  if (exists(path.join(PATHS.state, '项目', project, '项目.json'))) {
    fail('WORKSPACE_EXISTS', `同名项目已登记：${project}。请点「建团队/恢复」恢复它，不要新建同名工作区。`, { project });
  }
  let createdDir = false;
  if (exists(metadataFile)) {
    const old = JSON.parse(fs.readFileSync(metadataFile, 'utf8').replace(/^\uFEFF/, ''));
    const teamMode = explicitMode || normalizeTeamMode(old.teamMode);
    let oldId = old.dshWorkspaceId || null;
    if (!noRegister) {
      try {
        const client = new DshClient(args['engine-url'] || process.env.DSH_WEB_URL || undefined);
        const result = await client.workspaceCreate({ path: target });
        oldId = result.workspace.workspaceId;
        if (old.dshWorkspaceId !== oldId) {
          old.dshWorkspaceId = oldId;
          write(metadataFile, JSON.stringify(old, null, 2) + '\n');
        }
      } catch (e) {
        fail('DSH_WORKSPACE_CREATE_FAILED', `已有目录的 DSH 工作区登记失败：${e.message}`, { code: e.code || '', path: target });
      }
    }
    scaffold(project, target, oldId, { overwrite: false, teamMode });
    const cfg = registerTeamProject(project, target, oldId, teamMode);
    const idx = generateIndex(cfg, { by: 'owner', sessionId: 'workspace', silent: true });
    const current = { ...old, teamMode, dshWorkspaceId: oldId, path: target, reused: true };
    fs.writeFileSync(path.join(PATHS.state, '当前工作区.json'), JSON.stringify(current, null, 2) + '\n', 'utf8');
    if (args.json) jsonOut({ ok: true, created: false, teamMode, workspace: old, project: cfg, currentWorkspace: current, index: idx });
    else textOut(`工作区已存在：${target}（${TEAM_MODE_LABELS[teamMode]}）`);
    return;
  }
  if (exists(target) && fs.readdirSync(target).length > 0) {
    fail('WORKSPACE_EXISTS', `目录已存在且没有 workspace.json，拒绝覆盖：${target}`);
  }
  if (!exists(target)) { ensure(target); createdDir = true; }
  let workspaceId = null;
  let dshCreated = null;
  if (!noRegister) {
    try {
      const client = new DshClient(args['engine-url'] || process.env.DSH_WEB_URL || undefined);
      const result = await client.workspaceCreate({ path: target });
      workspaceId = result.workspace.workspaceId;
      dshCreated = result.created;
    } catch (e) {
      if (createdDir) {
        try { if (fs.readdirSync(target).length === 0) fs.rmdirSync(target); } catch { /* ignore */ }
      }
      fail('DSH_WORKSPACE_CREATE_FAILED', `DSH 工作区注册失败：${e.message}`, { code: e.code || '', path: target });
    }
  }
  const teamMode = explicitMode || 'full';
  const metadata = scaffold(project, target, workspaceId, { overwrite: true, teamMode });
  const cfg = registerTeamProject(project, target, workspaceId, teamMode);
  const idx = generateIndex(cfg, { by: 'owner', sessionId: 'workspace', silent: true });
  const current = { ...metadata, dshCreated, path: target, reused: false };
  fs.writeFileSync(path.join(PATHS.state, '当前工作区.json'), JSON.stringify(current, null, 2) + '\n', 'utf8');
  appendEvent({
    role: 'owner', sessionId: 'workspace', action: 'workspace_create', project,
    target, note: `${teamMode} 角色目录已建 workspaceId=${workspaceId || 'no-register'}`,
    data: { workspaceId, dshCreated, teamMode, roles: rolesForMode(teamMode), limits: LIMITS },
  });
  if (args.json) jsonOut({ ok: true, created: true, teamMode, workspace: metadata, project: cfg, currentWorkspace: current, index: idx });
  else {
    textOut(`工作区已创建：${target}（${TEAM_MODE_LABELS[teamMode]}）`);
    textOut(`DSH workspaceId：${workspaceId || '未注册'}`);
    textOut(`角色目录：${rolesForMode(teamMode).map((r) => ROLE_DIRS[r]).join('、')}；需求池：需求`);
  }
}

main().catch((e) => {
  if (args.json) jsonOut({ ok: false, code: e.code || 'ERROR', message: e.message, details: e.details || {} });
  else process.stderr.write(`[${e.code || 'ERROR'}] ${e.message}\n`);
  process.exit(3);
});
