// 团队工作台 v2 · 业务命令（boot / 消息 / 任务 / 提案 / 评审 / 签字 / 应用 / 索引 / 对账）
import fs from 'node:fs';
import path from 'node:path';
import {
  PATHS, TeamError, fail, nowIso, sha256, hashFile, shortHash, exists, ensureDir, readText, readJson,
  writeText, writeJson, appendLine, readJsonl, readJsonlTolerant, slug, isInside, relPath,
  truncate, randomHex, stamp, asArray, acquireLock, releaseLock, heartbeatLock, lockInfo, listLocks,
  appendEvent, readEventsStrict, verifyEventChain, jsonOut, textOut, hhmmss, safeName,
} from './core.mjs';
import {
  ROLES, ROLE_NAMES, PHASE_PILOT, initTeam, loadTeam, saveTeam, mutateTeam, getMember, activeMembers,
  projectStatePaths, projectIndexPath, loadProject, listProjects, addProject, setActiveProject,
  readDocSet, createBootToken, requireBoot, sendMessage, listInbox, unreadCount, findMessage, readMessage,
  ackMessage, loadReceipts, createTask, loadTask, saveTask, listTasks, claimTask, finishTask,
  setTaskPriority, proposalPaths, newProposal, computeProposalHash, loadProposal, saveProposal,
  listProposals, saveReview, loadReviews, saveSignature, loadSignatures, signatureDigest, commitPath,
  saveCommit, loadCommit, listCommits, loadArtifacts, saveArtifacts, activeGrants, hasGrant,
  addGrant, revokeGrant, loadGrants, addReadReceipt, latestRead,
  projectTeamMode, projectRoleIds, persistProjectTeamMode, projectModeState,
  DEFAULT_BOOT_TTL_MINUTES,
} from './store.mjs';
import { DshClient } from './dsh-session.mjs';
import { renderBoardHtml as renderBoardHtmlV2, renderBoardMd as renderBoardMdV2 } from './board.mjs';
import {
  ROLE_DIRS, OUTPUT_DOCS, OUTPUT_DISCIPLINE, TEAM_MODES, TEAM_MODE_LABELS,
  isTeamMode, normalizeTeamMode, rolesForMode, roleInMode, teamModeDescription,
  requirementReviewer, techReviewers, votersForMode, VOTE_RULE_TEXT,
} from './roles.mjs';
import { ensureProjectStructure, structureReport } from './scaffold.mjs';
import { buildDispatchPrompt } from './dispatch.mjs';
import {
  transitionRequirement, syncWorkflowRow, stampRejected, workflowAction, readWorkflowState,
} from './lifecycle.mjs';
import {
  issueOwnerConfirmation, consumeOwnerConfirmation, ownerConfirmHint,
} from './owner-confirm.mjs';

const RISK_RANK = { normal: 1, sensitive: 2, critical: 3 };
const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

function sessionOf(args) {
  return String(args.session || process.env.DSH_SESSION_ID || 'session-unknown');
}

function tokenOf(args) {
  if (!args.boot) fail('BOOT_REQUIRED', '需要 --boot <启动令牌>；先运行 boot');
  return requireBoot(String(args.boot), {});
}

function bootFor(args, action) {
  const b = tokenOf(args);
  if (args.role && args.role !== b.role) fail('BOOT_ROLE_MISMATCH', `令牌角色 ${b.role} ≠ --role ${args.role}`);
  if (args.project && args.project !== b.project) fail('BOOT_PROJECT_MISMATCH', `令牌项目 ${b.project} ≠ --project ${args.project}`);
  return b;
}

function out(args, human, json) {
  if (args.json) jsonOut(json);
  else textOut(human);
}

function table(rows, cols) {
  if (!rows.length) return '（无）';
  const widths = cols.map((c) => Math.max(c.label.length, ...rows.map((r) => String(r[c.key] ?? '').length)));
  const line = (vals) => vals.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  ');
  return [line(cols.map((c) => c.label)), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(cols.map((c) => r[c.key])))].join('\n');
}

function memberOrFail(team, role) {
  const m = getMember(team, role);
  if (!m) fail('NO_MEMBER', `角色不在团队：${role}`);
  if (m.status !== 'active') fail('MEMBER_INACTIVE', `角色未激活：${role}`);
  return m;
}

function activeRoles(team) {
  return activeMembers(team).map((m) => m.role);
}

/** 当前项目团队模式（没有 activeProject 时按 full）。 */
function activeProjectMode(team) {
  const name = team.activeProject;
  if (!name) return 'full';
  try { return projectTeamMode(loadProject(name)); } catch { return 'full'; }
}

// 评审/签字人按“项目团队模式 ∩ 活跃成员”算：fast 项目里即使团队表还有产品/程序员B，
// 他们也不能 boot，不能被要求评审或签字，否则会卡死 apply。
function proposalActiveRoles(proposal, team) {
  const roles = activeRoles(team);
  try {
    const modeRoles = rolesForMode(projectTeamMode(loadProject(proposal.project)));
    return roles.filter((r) => modeRoles.includes(r));
  } catch {
    return roles;
  }
}

function requiredSets(proposal, team) {
  const roles = proposalActiveRoles(proposal, team);
  const others = roles.filter((r) => r !== proposal.author);
  if (proposal.risk === 'normal') {
    return {
      minReviews: 1,
      reviewers: others,
      signers: proposal.author === 'pm' ? [others[0]].filter(Boolean) : ['pm'],
    };
  }
  return {
    minReviews: Math.max(1, others.length),
    reviewers: others,
    signers: [...roles, 'owner'],
  };
}

function approvedReviews(reviews) {
  return Object.values(reviews || {}).filter((r) => r.verdict === 'approve');
}

function checkApprovals(proposal, team, { forApply = false, stored = false } = {}) {
  const current = requiredSets(proposal, team);
  const req = stored && Array.isArray(proposal.requiredSigners) && proposal.requiredSigners.length
    ? { minReviews: Number(proposal.minReviews || 1), reviewers: proposal.requiredReviewers || current.reviewers, signers: proposal.requiredSigners }
    : current;
  const reviews = loadReviews(proposal.project, proposal.id);
  const sigs = loadSignatures(proposal.project, proposal.id);
  const problems = [];
  const approved = approvedReviews(reviews);
  if (approved.length < req.minReviews) {
    problems.push({ code: 'MISSING_REVIEW', detail: `需要至少 ${req.minReviews} 个非作者批准评审，现有 ${approved.length}` });
  }
  if (forApply && proposal.risk === 'normal' && proposalActiveRoles(proposal, team).length >= 3) {
    const approvedRoles = approved.map((r) => r.role);
    if (approvedRoles.length === 1 && approvedRoles[0] === 'pm' && req.signers.includes('pm')) {
      problems.push({ code: 'NEED_SECOND_REVIEWER', detail: '三人以上团队：PM 不能是唯一评审又唯一签字人，至少再来一名成员评审' });
    }
  }
  for (const role of req.signers) {
    const s = sigs[role];
    if (!s) { problems.push({ code: 'MISSING_SIGNATURE', detail: `缺签字：${role}` }); continue; }
    if (s.decision !== 'approve') problems.push({ code: 'REJECTED_SIGNATURE', detail: `${role} 签字为 ${s.decision}` });
    if (s.proposalHash !== proposal.proposalHash) problems.push({ code: 'STALE_SIGNATURE', detail: `${role} 签字绑定旧提案哈希` });
    const expected = signatureDigest({
      role, proposalId: proposal.id, proposalHash: s.proposalHash, baseHash: s.baseHash,
      newHash: s.newHash, decision: s.decision, ts: s.ts, nonce: s.nonce,
    });
    if (s.sig !== expected) problems.push({ code: 'BAD_SIGNATURE', detail: `${role} 签字摘要不匹配` });
    if (role === 'owner' && s.channel !== 'tty' && !(s.channel === 'selftest' && process.env.TEAM_SELFTEST === '1')) {
      problems.push({ code: 'OWNER_CHANNEL', detail: 'owner 签字必须来自终端批准' });
    }
  }
  return { req, reviews, sigs, problems };
}

function normalizeTarget(project, target) {
  let t = String(target || '').replace(/\\/g, '/').trim();
  if (!t) fail('BAD_TARGET', '目标文件不能为空');
  if (path.isAbsolute(t) || /^[a-zA-Z]:/.test(t) || t.startsWith('/')) fail('BAD_TARGET', `目标必须是项目内相对路径：${target}`);
  t = path.posix.normalize(t);
  if (t === '.' || t === '..' || t.startsWith('../') || t.includes('/../')) fail('BAD_TARGET', `目标越界：${target}`);
  const abs = path.resolve(project.path, t);
  if (!isInside(project.path, abs)) fail('BAD_TARGET', `目标越界：${target}`);
  if (/(^|\/)(node_modules|\.git|\.team|备份|_backup)(\/|$)/i.test(t)) fail('BAD_TARGET', `目标在禁写目录：${t}`);
  return { rel: t, abs };
}

function requiredRisk(project, targetRel) {
  const t = String(targetRel).toLowerCase();
  if (/(^|\/)(\.dsh|profiles|plugins|app\.asar|luanyujia-workbench|shell|dsh_home)(\/|$)/.test(t) || t.includes('dsh_home')) return 'critical';
  if (/(^|\/)(团队|宪法\.md|场景索引\.md|agents\.md|工具|协议|角色|模板|项目索引\.md)(\/|$)/.test(t)) return 'sensitive';
  return 'normal';
}

function parseFiles(args) {
  const specs = asArray(args.file).filter((x) => x !== true).map(String);
  const files = [];
  for (const spec of specs) {
    const i = spec.indexOf('=');
    if (i <= 0) fail('BAD_FILE_SPEC', `--file 格式应为 目标=暂存文件：${spec}`);
    files.push({ target: spec.slice(0, i), staged: spec.slice(i + 1) });
  }
  if (args.target || args.staged) {
    if (!args.target || !args.staged) fail('BAD_FILE_SPEC', '--target 与 --staged 必须同时给');
    files.push({ target: String(args.target), staged: String(args.staged) });
  }
  if (!files.length) fail('NO_FILES', '至少给一个 --file 目标=暂存文件');
  return files;
}

function parseExpect(args) {
  const map = new Map();
  for (const spec of asArray(args.expect).filter((x) => x !== true).map(String)) {
    const i = spec.indexOf('=');
    if (i <= 0) fail('BAD_EXPECT', `--expect 格式应为 目标=哈希：${spec}`);
    map.set(spec.slice(0, i).replace(/\\/g, '/'), spec.slice(i + 1).toLowerCase());
  }
  if (args['expect-base'] && args.target) map.set(String(args.target).replace(/\\/g, '/'), String(args['expect-base']).toLowerCase());
  return map;
}

function resolveStaged(p) {
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  if (!exists(abs)) fail('STAGED_MISSING', `暂存文件不存在：${p}`);
  const st = fs.statSync(abs);
  if (!st.isFile()) fail('STAGED_NOT_FILE', `暂存路径不是文件：${p}`);
  return abs;
}

function notify({ from, to, subject, body, project, task = '', ackRequired = false, type = 'note', sessionId = '' }) {
  const msg = sendMessage({ from, to, subject, body, project, task, ackRequired, type });
  appendEvent({
    role: from, sessionId, action: 'message', project, target: `${from}->${to}`,
    note: truncate(subject, 120), data: { messageId: msg.id, ackRequired },
  });
  return msg;
}

function safeRead(p) {
  try { return fs.readFileSync(p); } catch { return null; }
}

function isBinary(buf) {
  if (!buf) return true;
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function lineDiff(base, next) {
  const a = base.split(/\r?\n/);
  const b = next.split(/\r?\n/);
  const n = a.length;
  const m = b.length;
  if (n * m > 250000) return ['（文件较大，跳过行级 diff；请直接读暂存文件）'];
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { lines.push('  ' + a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push('- ' + a[i]); i++; }
    else { lines.push('+ ' + b[j]); j++; }
    if (lines.length > 160) { lines.push('…（截断）'); break; }
  }
  while (i < n && lines.length <= 160) lines.push('- ' + a[i++]);
  while (j < m && lines.length <= 160) lines.push('+ ' + b[j++]);
  return lines;
}

// ========== init / project ==========

export function cmdInit(args) {
  const { created, team } = initTeam();
  out(args, `团队已初始化：${PATHS.teamRoot}\n新建 ${created.length} 个文件；成员 ${activeRoles(team).join(', ')}；阶段 ${team.phase}`, { ok: true, created, team });
}

function registeredProject(name) {
  return listProjects().find((p) => p.name === name) || null;
}

// --team-mode full|fast：命令行显式传入才算；非法值直接拒绝，不静默落到 full。
function modeFromArgs(args) {
  const raw = args['team-mode'];
  if (raw === undefined) return '';
  if (raw === true) fail('BAD_TEAM_MODE', '--team-mode 需要 full 或 fast');
  const mode = String(raw).trim().toLowerCase();
  if (!isTeamMode(mode)) fail('BAD_TEAM_MODE', `--team-mode 只能是 ${TEAM_MODES.join(' / ')}：${raw}`, { allowed: TEAM_MODES });
  return mode;
}

/**
 * 模式切换只改「项目状态配置 + workspace.json + 结构要求」，不删除已有角色目录、不动会话。
 * - 项目.json 是真相：写 teamMode + roleIds；
 * - workspace.json 是镜像：同步 teamMode + roleIds + roles；
 * - 老项目缺字段时按当前生效模式回填，不把已有 fast 项目误判成 full。
 */
function applyProjectMode(project, mode) {
  return persistProjectTeamMode(project, mode, { syncWorkspace: true });
}

// 建项目/补项目共用：先写模式配置，再落脚手架，最后重建索引，返回可复核的 created/missing。
function scaffoldProject(project, { desc = '', entry = '', by = 'owner', teamMode = '' } = {}) {
  const requested = teamMode ? normalizeTeamMode(teamMode) : projectTeamMode(project);
  const modeSync = applyProjectMode(project, requested);
  const mode = modeSync.teamMode;
  const structure = ensureProjectStructure({
    name: project.name,
    root: project.path,
    desc: desc || project.desc || '',
    overwrite: false,
    teamMode: mode,
  });
  const index = generateIndex(project, { by, sessionId: 'project-scaffold', silent: true });
  return { structure, index, teamMode: mode, modeSync };
}

export function cmdProject(args) {
  const sub = args._[1] || 'list';
  if (sub === 'add' || sub === 'create' || sub === 'ensure') {
    const rawName = String(args.name || (sub === 'ensure' ? loadTeam().activeProject || '' : '')).trim();
    if (!rawName) fail('BAD_NAME', `project ${sub} 需要 --name`);
    let createdBy = args.by || 'owner';
    if (args.boot) {
      const b = bootFor(args, `project ${sub}`);
      if (b.role !== 'pm') fail('NOT_PM', `只有 PM 能 project ${sub}`);
      createdBy = b.role;
    } else if (createdBy !== 'owner') {
      fail('BOOT_REQUIRED', `非 owner 执行 project ${sub} 必须带 --boot`);
    }
    const name = safeName(rawName);
    const teamMode = modeFromArgs(args);
    // 登记文件存在但解析失败时不能当“未登记”重建：那会用默认 full 覆盖已有 fast 真相。
    const stateConfig = projectStatePaths(name).config;
    if (exists(stateConfig) && !registeredProject(name)) {
      fail('BAD_PROJECT_CONFIG', `项目登记文件存在但读不出来：${stateConfig}；先修复或备份，不能按未登记项目重建（否则会把已有 fast 误判成 full）`, { project: name, config: stateConfig });
    }

    if (sub === 'ensure') {
      let project = registeredProject(name);
      if (!project) {
        const dir = args.dir ? path.resolve(String(args.dir)) : path.join(PATHS.projects, name);
        if (!exists(dir)) fail('NO_PROJECT', `项目不存在：${name}；先 project add --name "${name}"`, { project: name, dir });
        project = addProject({ name, dir, desc: args.desc || '', createdBy, entry: args.entry || '', teamMode: teamMode || 'full' }).project;
      } else if (args.dir && path.resolve(String(args.dir)) !== path.resolve(project.path)) {
        fail('PROJECT_PATH_MISMATCH', `项目 ${name} 登记目录 ${project.path} ≠ --dir ${args.dir}`, { project, dir: args.dir });
      }
      const { structure, index, teamMode: mode, modeSync } = scaffoldProject(project, { desc: args.desc, entry: args.entry, by: createdBy, teamMode });
      appendEvent({
        role: createdBy, sessionId: sessionOf(args), action: 'project_ensure', project: name, target: project.path,
        note: `mode=${mode} roleIds=${modeSync.roleIds.join(',')} created=${structure.created.length} missing=${structure.missing.length} workspace=${modeSync.workspace ? (modeSync.workspace.changed ? 'synced' : 'same') : 'off'}`,
        data: { created: structure.created, missing: structure.missing, teamMode: mode, roleIds: modeSync.roleIds, modeBefore: modeSync.before, modeChanged: modeSync.changed, workspace: modeSync.workspace },
      });
      const modeLine = `模式：${TEAM_MODE_LABELS[mode]}｜项目.json teamMode=${mode} roleIds=${modeSync.roleIds.join(',')}｜workspace.json ${modeSync.workspace && modeSync.workspace.changed ? '已同步' : '已一致'}｜不删旧目录/旧会话`;
      const human = structure.ok
        ? `项目结构已补齐：${project.name}（${mode === 'fast' ? '快速四角色' : '完整六角色'}）\n目录：${project.path}\n新建 ${structure.created.length} 项；保留 ${structure.kept.length} 项\n${modeLine}\n索引：${project.index}（${index.files} 个文件）`
        : `项目结构仍不完整：${project.name}（${mode}）\n缺失：${structure.missing.join('、')}\n${modeLine}`;
      out(args, human, { ok: structure.ok, project, structure, index, teamMode: mode, roleIds: modeSync.roleIds, modeSync });
      return;
    }

    // add / create：已登记的项目不重复登记、不覆盖，只补结构；目录不同则明确拒绝。
    const existing = registeredProject(name);
    if (existing) {
      if (args.dir && path.resolve(String(args.dir)) !== path.resolve(existing.path)) {
        fail('PROJECT_EXISTS', `项目已登记且目录不同：${name} → ${existing.path}；要补结构请用 project ensure`, { project: existing });
      }
      const project = loadProject(name);
      const { structure, index, teamMode: mode, modeSync } = scaffoldProject(project, { desc: args.desc, entry: args.entry, by: createdBy, teamMode });
      appendEvent({
        role: createdBy, sessionId: sessionOf(args), action: 'project_scaffold', project: name, target: project.path,
        note: `已有项目补结构 mode=${mode} roleIds=${modeSync.roleIds.join(',')} created=${structure.created.length} missing=${structure.missing.length}`,
        data: { created: structure.created, missing: structure.missing, teamMode: mode, roleIds: modeSync.roleIds, modeBefore: modeSync.before, modeChanged: modeSync.changed, workspace: modeSync.workspace },
      });
      const modeLine = `模式：${TEAM_MODE_LABELS[mode]}｜项目.json teamMode=${mode} roleIds=${modeSync.roleIds.join(',')}｜workspace.json ${modeSync.workspace && modeSync.workspace.changed ? '已同步' : '已一致'}｜不删旧目录/旧会话`;
      const human = structure.ok
        ? `项目已存在，结构已补齐：${project.name}（${mode === 'fast' ? '快速四角色' : '完整六角色'}）\n目录：${project.path}\n新建 ${structure.created.length} 项\n${modeLine}\n索引：${project.index}（${index.files} 个文件）`
        : `项目已存在，但结构仍不完整：${project.name}（${mode}）\n缺失：${structure.missing.join('、')}\n${modeLine}`;
      out(args, human, { ok: structure.ok, existed: true, project, structure, index, teamMode: mode, roleIds: modeSync.roleIds, modeSync });
      return;
    }

    const { project } = addProject({ name, desc: args.desc || '', dir: args.dir || '', createdBy, entry: args.entry || '', teamMode: teamMode || 'full' });
    const { structure, index, teamMode: mode, modeSync } = scaffoldProject(project, { desc: args.desc, entry: args.entry, by: createdBy, teamMode });
    if (!structure.ok) {
      fail('PROJECT_STRUCTURE_INCOMPLETE', `项目已登记但结构不完整：缺少 ${structure.missing.join('、')}`, { project, structure });
    }
    out(args, `项目已建：${project.name}（${mode === 'fast' ? '快速四角色：PM/需求分析师/程序员A/测试人员' : '完整六角色'}）\n目录：${project.path}\n${mode === 'fast' ? '四角色' : '六角色'}目录 + 角色卡 + 文件索引 + 产出/ + 项目信息/铁律/索引/README + 需求池 + _tmp 已就绪（新建 ${structure.created.length} 项）\n模式：项目.json teamMode=${mode} roleIds=${modeSync.roleIds.join(',')}｜workspace.json 已同步\n索引：${project.index}（${index.files} 个文件）`, {
      ok: true, created: true, project, structure, index, teamMode: mode, roleIds: modeSync.roleIds, modeSync,
    });
    return;
  }
  if (sub === 'list') {
    const projects = listProjects();
    const team = loadTeam();
    const rows = projects.map((p) => {
      const mode = projectTeamMode(p);
      const roleIds = projectRoleIds(p);
      const s = structureReport(p.path, { teamMode: mode });
      return {
        name: p.name, active: p.name === team.activeProject ? '*' : '', mode,
        roleIds, roles: roleIds.join(','),
        desc: p.desc, path: p.path,
        structure: s.ok ? 'OK' : `缺 ${s.missing.length}`,
      };
    });
    out(args, `项目（active=${team.activeProject || '无'}）\n` + table(rows, [
      { key: 'name', label: '项目' }, { key: 'active', label: '' }, { key: 'mode', label: '模式' }, { key: 'roles', label: '角色' }, { key: 'structure', label: '结构' }, { key: 'desc', label: '说明' }, { key: 'path', label: '目录' },
    ]), { ok: true, projects, active: team.activeProject, structures: rows.map((r) => ({ name: r.name, teamMode: r.mode, roleIds: r.roleIds, structure: r.structure })) });
    return;
  }
  if (sub === 'use') {
    const b = bootFor(args, 'project use');
    if (b.role !== 'pm') fail('NOT_PM', '只有 PM 能切换当前项目');
    if (!args.name) fail('BAD_NAME', '需要 --name');
    const project = setActiveProject(args.name);
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'project_use', project: project.name, target: project.name, note: '切换当前项目' });
    out(args, `当前项目：${project.name}`, { ok: true, project });
    return;
  }
  if (sub === 'show') {
    const project = loadProject(args.name || loadTeam().activeProject);
    const teamMode = projectTeamMode(project);
    const roleIds = projectRoleIds(project);
    const structure = structureReport(project.path, { teamMode });
    const modeState = projectModeState(project);
    out(args, JSON.stringify({ project, teamMode, roleIds, structure, modeState }, null, 2), { ok: true, project, teamMode, roleIds, structure, modeState });
    return;
  }
  fail('BAD_SUBCOMMAND', `未知 project 子命令：${sub}`);
}

// ========== boot ==========

export function cmdBoot(args) {
  const team = loadTeam();
  const role = String(args.role || '');
  if (!role) fail('BAD_ROLE', '需要 --role');
  const member = memberOrFail(team, role);
  const projectName = String(args.project || team.activeProject || '');
  if (!projectName) fail('NO_PROJECT', '没有当前项目；先 project add / project use');
  const project = loadProject(projectName);
  const docs = readDocSet(role, project);
  const teamMode = docs.teamMode || projectTeamMode(project);
  const sessionId = sessionOf(args);
  const token = createBootToken({ role, project: projectName, sessionId, docs });
  addReadReceipt({ role, sessionId, kind: 'index', project: projectName, proposalId: '', proposalHash: '', baseHash: docs.hashes.projectIndex });
  const records = docs.docs.map((d) => ({
    key: d.key, label: d.label, rel: d.rel, path: d.path, required: d.required,
    exists: d.exists, size: d.size, hash: d.hash, updatedAt: d.updatedAt, excerpt: d.excerpt,
  }));
  const bootRead = {
    role,
    project: projectName,
    teamMode,
    at: nowIso(),
    complete: records.every((d) => d.exists || !d.required),
    order: records.map((d) => `${d.label}(${d.rel || d.path})`),
    docs: records,
    requirements: docs.requirements.list,
    requirementsHash: docs.requirements.hash,
    peers: docs.peers,
    missing: records.filter((d) => !d.exists && d.required).map((d) => d.label),
    receipt: { file: PATHS.reads, kind: 'boot' },
  };
  // read 证据落盘：谁读了哪些文件、需求版本是什么，事后能复核（不是只有口头“读过了”）。
  addReadReceipt({
    role, sessionId, kind: 'boot', project: projectName, proposalId: '', proposalHash: '',
    baseHash: docs.rulesHash,
    docs: docs.readOrder,
    requirementsHash: docs.requirements.hash,
    requirements: docs.requirements.count,
    peers: docs.peers.map((p) => p.rel),
  });
  const unread = listInbox(role, { project: projectName });
  const tasks = listTasks(projectName).filter((t) => t.status !== 'done' && (!t.owner || t.owner === role));
  const proposals = listProposals(projectName).filter((p) => ['proposed', 'reviewing', 'signing'].includes(p.status) && p.author !== role);
  const locks = listLocks().filter((l) => !l.stale);
  const grants = activeGrants(role, projectName);
  appendEvent({
    role, sessionId, action: 'boot', project: projectName, target: role,
    note: `rules=${shortHash(docs.rulesHash)} index=${shortHash(docs.hashes.projectIndex)} req=${docs.requirements.count} unread=${unread.length}`,
    data: {
      rulesHash: docs.rulesHash, docHashes: docs.hashes, token: token.token, unread: unread.length,
      read: {
        docs: docs.readOrder, peers: docs.peers.map((p) => p.rel),
        requirements: docs.requirements.count, requirementsHash: docs.requirements.hash,
      },
    },
  });
  const lines = [];
  const bootTtlMinutes = Number(team.config.bootTtlMinutes || DEFAULT_BOOT_TTL_MINUTES);
  lines.push(`=== 启动简报 · ${ROLE_NAMES[role] || role} · ${projectName} ===`);
  lines.push(`令牌: ${token.token}（${bootTtlMinutes} 分钟 = ${bootTtlMinutes / 60} 小时；本轮所有写操作都要带 --boot）`);
  lines.push(`规则哈希: ${shortHash(docs.rulesHash)} ｜ 索引哈希: ${shortHash(docs.hashes.projectIndex)}`);
  lines.push(`身份: ${member.name}（${role}）｜ 会话: ${sessionId}`);
  lines.push(`团队模式: ${TEAM_MODE_LABELS[teamMode]}（${teamModeDescription(teamMode)}）｜ 角色集: ${rolesForMode(teamMode).join(' / ')}`);
  lines.push(teamMode === 'fast'
    ? '快速模式: 需求评审=需求分析师(req review) ｜ 技术评审记录=程序员A(req review --kind tech) ｜ 投票=vote start/cast/status'
    : '完整模式: 需求评审=产品设计师(req review) ｜ 技术评审记录=产品/程序员A(req review --kind tech) ｜ 投票=vote start/cast/status');
  lines.push(`阶段: ${team.phase} ｜ 活跃成员: ${activeRoles(team).filter((r) => rolesForMode(teamMode).includes(r)).join(', ')}`);
  lines.push(`纪律: 中文思考、中文回复、中文写文档 ｜ 每轮先读项目铁律 ｜ 消息≤${team.config.messageMaxChars}字 ｜ 回执≤${team.config.ackNoteMaxChars}字 ｜ 先读索引再找文件`);
  lines.push('派单闭环: ack=已回执（收到/认领）≠ 已完成；执行正文任务 → 产出写本角色目录（开发代码写 site/**）→ 完成回执 + task done --evidence');
  lines.push(`结构化输出: ${OUTPUT_DISCIPLINE}`);
  const outSpec = OUTPUT_DOCS[role];
  lines.push(outSpec
    ? `输出模板: 团队\\工具\\模板\\角色产出\\${outSpec.file} → 复制到 ${outSpec.dir}/产出/（vN 换版本号，每次实质变更 +1；字段超限即停）`
    : '输出模板: 本角色无 01~04 结构化模板（回执/日志仍按一句话格式）');
  lines.push(`网关提取: team.mjs brief --role ${role} --project "${projectName}" --section <区块> ｜ 他人读你产出只提取区块，不读全文`);
  const evidence = records.filter((d) => d.exists)
    .map((d, i) => `${i + 1}. ${d.label} ${d.rel || d.path} ${shortHash(d.hash, 8)}`);
  lines.push(`已读证据（按顺序，含哈希）: ${evidence.join(' → ')}`);
  const reqIds = docs.requirements.list.map((r) => r.id);
  lines.push(`相关需求: ${docs.requirements.count} 份${reqIds.length ? '（' + reqIds.slice(0, 8).join('、') + '）' : '（暂无 R-*.md）'} ｜ 他人文档索引: ${docs.peers.length} 份`);
  lines.push(`read 回执: ${PATHS.reads}（kind=boot；文件哈希也随令牌落盘）`);
  lines.push(`未读消息: ${unread.length}`);
  for (const m of unread.slice(0, 8)) lines.push(`  [${m.id}] ${m.from}${m.ackRequired ? ' (要回执)' : ''}: ${m.subject}`);
  lines.push(`待办任务: ${tasks.length}`);
  for (const t of tasks.slice(0, 8)) lines.push(`  [${t.id}] ${t.priority} ${t.status} ${t.owner || '-'} ${t.title}`);
  lines.push(`待处理提案: ${proposals.length}`);
  for (const p of proposals.slice(0, 8)) lines.push(`  [${p.id}] ${p.risk} ${p.status} by ${p.author}: ${p.title}`);
  lines.push(`授权: ${grants.length ? grants.map((g) => `${g.actions.join('/')}@${g.project}:${g.scope.join(',')}`).join(' ｜ ') : '（无，需 PM grant）'}`);
  if (locks.length) lines.push(`当前锁: ${locks.map((l) => l.key + '@' + l.role).join(', ')}`);
  lines.push('下一步: 先读 inbox/待审提案；收到派单先 ack，再执行正文任务，产出落盘，完成后发完成回执并 task done；变更走 propose→review→sign→apply。');
  const maxBrief = Number(team.config.bootBriefMaxChars || 2000);
  let briefing = lines.join('\n');
  if (briefing.length > maxBrief) briefing = briefing.slice(0, maxBrief - 22) + '\n…（简报超限截断）';
  if (args.json) jsonOut({
    ok: true, token: token.token, role, project: projectName, teamMode, sessionId, rulesHash: docs.rulesHash,
    bootTtlMinutes,
    docHashes: docs.hashes, read: bootRead, briefing, unread, tasks, proposals, grants,
  });
  else textOut(briefing);
}

// ========== 消息 ==========

function dispatchLockPath(project) {
  return path.join(projectStatePaths(project).dir, '派单锁.json');
}
function readDispatchLock(project) {
  try { return readJson(dispatchLockPath(project)); } catch { return null; }
}
function writeDispatchLock(project, msg) {
  writeJson(dispatchLockPath(project), {
    messageId: msg.id, to: msg.to, task: msg.task || '', subject: msg.subject, ts: msg.ts,
  });
}
function clearDispatchLock(project, messageId) {
  const p = dispatchLockPath(project);
  try {
    const lock = readJson(p);
    if (lock && lock.messageId === messageId) fs.rmSync(p, { force: true });
  } catch { /* ignore */ }
}

export async function cmdSend(args) {
  const b = bootFor(args, 'send');
  const to = String(args.to || '');
  if (!to) fail('BAD_RECIPIENT', '需要 --to');
  let body = String(args.body ?? args.text ?? '');
  if (args['body-file']) body = readText(path.resolve(String(args['body-file'])), '');
  if (!body.trim()) fail('EMPTY_MESSAGE', '需要 --body 或 --body-file');
  // PM 一次只能派一个：上一条要回执的派单未闭环前，禁止继续扇出。
  const pmDispatch = b.role === 'pm' && Boolean(args.ack) && to !== 'pm';
  if (pmDispatch && !args.force) {
    const lock = readDispatchLock(b.project);
    if (lock && lock.messageId) {
      fail('PM_DISPATCH_PENDING', `上一条派单还没回执：${lock.messageId} → ${lock.to}（${lock.subject}）。先等回执，确认后再派下一个。`, { pending: lock });
    }
  }
  // 派单时顺手把任务 owner 定为目标角色，避免任务 owner 为空、角色不知归属。
  if (b.role === 'pm' && args.task) {
    try {
      const task = loadTask(b.project, String(args.task));
      if (task && !task.owner) {
        task.owner = to;
        task.status = task.status || 'open';
        saveTask(b.project, task);
      } else if (task && task.owner && task.owner !== to) {
        fail('TASK_OWNED', `任务 ${task.id} 已归 ${task.owner}，不能派给 ${to}`);
      }
    } catch (e) {
      if (e.code === 'TASK_OWNED') throw e;
    }
  }
  const msg = notify({
    from: b.role, to, subject: args.subject || '(无主题)', body, project: b.project,
    task: args.task || '', ackRequired: Boolean(args.ack), type: args.type || 'note', sessionId: b.sessionId,
  });
  if (pmDispatch) writeDispatchLock(b.project, msg);
  let wake = null;
  const wantWake = (Boolean(args.ack) || Boolean(args.wake)) && !args['no-wake'];
  if (wantWake && !process.env.TEAM_SELFTEST) {
    const target = getMember(loadTeam(), to);
    const sessionId = target && target.sessionId;
    if (!sessionId) {
      wake = { ok: false, why: '目标角色还没有 DSH 会话' };
    } else {
      let engine = args['engine-url'] || process.env.DSH_WEB_URL || '';
      if (!engine) {
        try { engine = readJson(path.join(PATHS.state, '当前工作区.json')).engineUrl || ''; } catch { /* none */ }
      }
      if (!engine) {
        wake = { ok: false, why: '没有 engineUrl；无法唤醒目标会话' };
      } else {
        const projectPath = (() => { try { return loadProject(b.project).path; } catch { return b.project; } })();
        const teamTool = path.join(PATHS.teamRoot, '工具', 'team.mjs');
        let taskTitle = '';
        if (msg.task) {
          try { taskTitle = loadTask(b.project, String(msg.task)).title || ''; } catch { /* 任务不存在也照样派单，正文仍可见 */ }
        }
        const text = buildDispatchPrompt({
          to,
          project: b.project,
          projectPath,
          roleDir: ROLE_DIRS[to] || to,
          codeDir: (to === 'programmer1' || to === 'programmer2') ? 'site' : '',
          messageId: msg.id,
          subject: msg.subject,
          taskId: msg.task || '',
          taskTitle,
          teamTool,
        });
        try {
          const client = new DshClient(engine);
          await client.prompt({ sessionId, text, mode: 'queue' });
          wake = { ok: true, role: to, sessionId };
        } catch (e) {
          wake = { ok: false, why: e.message, code: e.code || '' };
        }
      }
    }
  }
  const suffix = wake ? (wake.ok ? `；已唤醒 ${to}` : `；唤醒失败：${wake.why}`) : '';
  const receiptHint = msg.ackRequired ? '（要回执：ack 只代表已回执，完成要完成回执 + task done --evidence）' : '';
  out(args, `已发送 ${msg.id} → ${to}${receiptHint}${suffix}`, { ok: true, message: msg, wake });
}

export function cmdInbox(args) {
  const b = bootFor(args, 'inbox');
  const msgs = listInbox(b.role, { includeCur: Boolean(args.all), project: b.project });
  const rows = msgs.map((m) => ({ id: m.id, from: m.from, subject: m.subject, ack: m.ackRequired ? '要' : '', box: m.box, ts: hhmmss(m.ts) }));
  out(args, `收件箱（${b.role}，${msgs.length} 条）\n` + table(rows, [
    { key: 'ts', label: '时间' }, { key: 'id', label: '消息' }, { key: 'from', label: '发件' }, { key: 'ack', label: '回执' }, { key: 'box', label: '箱' }, { key: 'subject', label: '主题' },
  ]), { ok: true, messages: msgs });
}

export function cmdRead(args) {
  const b = bootFor(args, 'read');
  if (!args.id) fail('BAD_ID', '需要 --id');
  const { msg, alreadyRead } = readMessage(b.role, String(args.id));
  appendEvent({ role: b.role, sessionId: b.sessionId, action: 'mail_read', project: msg.project, target: msg.id, note: msg.subject });
  out(args, `已读 ${msg.id}：${msg.subject}\n${msg.body}`, { ok: true, message: msg, alreadyRead });
}

export function cmdAck(args) {
  const b = bootFor(args, 'ack');
  if (!args.id) fail('BAD_ID', '需要 --id');
  const r = ackMessage(b.role, String(args.id), args.note || '已收到');
  clearDispatchLock(r.msg.project, String(args.id));
  appendEvent({
    role: b.role, sessionId: b.sessionId, action: 'ack', project: r.msg.project, target: r.msg.id,
    note: r.already ? '重复回执' : truncate(String(args.note || '已收到'), 120), data: { ackId: r.ack.id, receiptMessageId: r.receiptMessage?.id || '' },
  });
  const hint = '（仅表示已收到/已认领，不算完成；完成请执行正文任务并 task done --evidence）';
  out(args, r.already ? `已回执过 ${r.msg.id}（${r.ack.id}）${hint}` : `已回执 ${r.msg.id}（${r.ack.id}）→ 已通知 ${r.msg.from}${hint}`, { ok: true, ...r });
}

// ========== 任务 ==========

export function cmdTask(args) {
  const sub = args._[1] || 'list';
  const b = bootFor(args, 'task');
  if (sub === 'create') {
    if (!['pm', 'product', 'analyst'].includes(b.role)) fail('NOT_PM', '只有 PM / 产品 / 需求分析能建任务');
    const task = createTask({
      project: b.project, title: args.title, detail: args.detail || '', priority: args.priority,
      priorityBy: args['priority-by'] || b.role, createdBy: b.role, owner: args.owner || null, due: args.due || '',
      type: args.type || 'task', requirementId: args.requirement || '', acceptance: args.acceptance || '', story: args.story || '',
    });
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'task_create', project: b.project, target: task.id, note: `${task.priority} ${task.title}`, data: { task } });
    if (task.owner) {
      notify({ from: b.role, to: task.owner, subject: `新任务 ${task.id}`, body: `${task.priority} ${task.title}\n${task.detail}`, project: b.project, task: task.id, ackRequired: true, sessionId: b.sessionId });
    }
    out(args, `已建任务 ${task.id} [${task.priority}] ${task.title}${task.owner ? ' → ' + task.owner : ''}`, { ok: true, task });
    return;
  }
  if (sub === 'list') {
    let tasks = listTasks(b.project);
    if (args.status) tasks = tasks.filter((t) => t.status === args.status);
    if (args.owner) tasks = tasks.filter((t) => t.owner === args.owner);
    if (!args.all) tasks = tasks.filter((t) => t.status !== 'done');
    const rows = tasks.map((t) => ({ id: t.id, p: t.priority, status: t.status, owner: t.owner || '-', title: t.title, due: t.due || '' }));
    out(args, `任务（${b.project}，${tasks.length}）\n` + table(rows, [
      { key: 'p', label: '优先' }, { key: 'id', label: '任务' }, { key: 'status', label: '状态' }, { key: 'owner', label: 'Owner' }, { key: 'due', label: '截止' }, { key: 'title', label: '标题' },
    ]), { ok: true, tasks });
    return;
  }
  if (sub === 'show') {
    if (!args.id) fail('BAD_ID', '需要 --id');
    const task = loadTask(b.project, String(args.id));
    out(args, JSON.stringify(task, null, 2), { ok: true, task });
    return;
  }
  if (sub === 'claim') {
    if (!args.id) fail('BAD_ID', '需要 --id');
    const task = claimTask(b.project, String(args.id), b.role, b.sessionId);
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'task_claim', project: b.project, target: task.id, note: task.title });
    notify({ from: b.role, to: 'pm', subject: `已认领 ${task.id}`, body: `${task.title}\n预计按 ${task.priority} 推进。`, project: b.project, task: task.id, ackRequired: false, sessionId: b.sessionId });
    out(args, `已认领 ${task.id}：${task.title}`, { ok: true, task });
    return;
  }
  if (sub === 'done') {
    if (!args.id) fail('BAD_ID', '需要 --id');
    const task = finishTask(b.project, String(args.id), b.role, args.evidence, args.note || '');
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'task_done', project: b.project, target: task.id, note: truncate(String(args.evidence), 120), data: { evidence: task.evidence } });
    notify({ from: b.role, to: task.createdBy === 'system' ? 'pm' : task.createdBy, subject: `完成回执 ${task.id}`, body: `${task.title}\n证据：${task.evidence}`, project: b.project, task: task.id, ackRequired: true, type: 'receipt', sessionId: b.sessionId });
    out(args, `已完成 ${task.id}，证据：${task.evidence}`, { ok: true, task });
    return;
  }
  if (sub === 'priority') {
    if (b.role !== 'pm' && b.role !== 'product') fail('NOT_PM', '只有 PM / 产品能改优先级');
    if (!args.id || !args.priority) fail('BAD_ARGS', '需要 --id 和 --priority');
    const task = setTaskPriority(b.project, String(args.id), String(args.priority), b.role, args.reason || '');
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'task_priority', project: b.project, target: task.id, note: `${task.priority} ${args.reason || ''}` });
    out(args, `优先级已改：${task.id} → ${task.priority}`, { ok: true, task });
    return;
  }
  if (sub === 'release') {
    if (!args.id) fail('BAD_ID', '需要 --id');
    const task = loadTask(b.project, String(args.id));
    if (b.role !== 'pm' && task.owner !== b.role) fail('NOT_OWNER', '只有 owner 或 PM 能释放');
    task.owner = null; task.status = 'open';
    task._by = b.role; task._action = 'release'; task._note = args.reason || '';
    saveTask(b.project, task);
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'task_release', project: b.project, target: task.id, note: args.reason || '' });
    out(args, `已释放 ${task.id}`, { ok: true, task });
    return;
  }
  fail('BAD_SUBCOMMAND', `未知 task 子命令：${sub}`);
}

// ========== 需求看板 / 先索引后找文件 ==========

export function cmdReq(args) {
  const sub = args._[1] || 'list';
  // 需求评审 / 技术评审记录：fast 由需求分析师评审，full 由产品设计师评审；
  // 技术评审记录在 fast 由程序员A、full 由产品或程序员A记录。PM 不评审。
  if (sub === 'review') return cmdReqReview(args);
  // 被驳回需求的出口：PM 决定进入下一轮或终止；两者都会同步 工作流.json。
  if (sub === 'iterate' || sub === 'terminate') return cmdReqLifecycle(args, sub);
  const b = bootFor(args, 'req');
  if (sub === 'create') {
    if (!['pm', 'product', 'analyst'].includes(b.role)) fail('NOT_PM', '只有 PM / 产品 / 需求分析能建需求');
    const task = createTask({
      project: b.project, title: args.title, detail: args.detail || '', priority: args.priority,
      priorityBy: args['priority-by'] || b.role, createdBy: b.role, owner: args.owner || null, due: args.due || '',
      type: 'requirement', requirementId: '', acceptance: args.acceptance || '', story: args.story || '',
    });
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'req_create', project: b.project, target: task.id, note: `${task.priority} ${task.title}`, data: { task } });
    out(args, `已建需求 ${task.id} [${task.priority}] ${task.title}`, { ok: true, requirement: task });
    return;
  }
  if (sub === 'list') {
    const tasks = listTasks(b.project);
    const reqs = tasks.filter((t) => t.type === 'requirement');
    const children = tasks.filter((t) => t.type !== 'requirement');
    const rows = reqs.map((r) => {
      const kids = children.filter((c) => c.requirementId === r.id);
      return {
        id: r.id, p: r.priority, status: r.status, owner: r.owner || '-', title: r.title,
        review: r.review ? `${r.review.verdict}` : '-',
        tech: r.techReview ? `${r.techReview.verdict}` : '-',
        kids: kids.length, done: kids.filter((k) => k.status === 'done').length, acceptance: r.acceptance || '',
      };
    });
    out(args, `需求看板（${b.project}，${reqs.length} 条）\n` + table(rows, [
      { key: 'p', label: '优先' }, { key: 'id', label: '需求' }, { key: 'status', label: '状态' }, { key: 'review', label: '需求评审' }, { key: 'tech', label: '技术评审' }, { key: 'owner', label: 'Owner' }, { key: 'title', label: '需求' }, { key: 'kids', label: '子任务' }, { key: 'done', label: '完成' },
    ]), { ok: true, requirements: reqs, tasks: children });
    return;
  }
  if (sub === 'show') {
    if (!args.id) fail('BAD_ID', '需要 --id');
    const r = loadTask(b.project, String(args.id));
    const kids = listTasks(b.project).filter((t) => t.requirementId === r.id);
    out(args, JSON.stringify({ requirement: r, tasks: kids }, null, 2), { ok: true, requirement: r, tasks: kids });
    return;
  }
  fail('BAD_SUBCOMMAND', `未知 req 子命令：${sub}`);
}

function reviewRecordDir(projectName, isTech) {
  const p = projectStatePaths(projectName);
  return isTech ? p.techReviews : p.reqReviews;
}

function writeReviewFile(dir, record, title) {
  ensureDir(dir);
  const jsonFile = path.join(dir, record.id + '.json');
  const mdFile = path.join(dir, record.id + '.md');
  writeJson(jsonFile, record);
  const lines = [
    `# ${title} · ${record.requirementId}`,
    '',
    `> 程序生成；JSON 同名文件是真相。中文记录，只对本次需求版本负责。`,
    '',
    `- 评审 id：${record.id}`,
    `- 项目：${record.project}（团队模式 ${record.teamMode}）`,
    `- 需求：${record.requirementId} ${record.title || ''}`,
    ...(record.proposalId ? [`- 提案：${record.proposalId}（proposalHash ${shortHash(record.proposalHash, 16)}）`] : []),
    `- 评审人：${record.role} ｜ 会话：${record.sessionId || '-'}`,
    `- 结论：${record.verdict}`,
    `- 时间：${record.ts}`,
    '',
    '## 意见',
    '',
    record.comments || '（无）',
    '',
  ];
  writeText(mdFile, lines.join('\n'));
  return { dir, jsonFile, mdFile };
}

/**
 * req review：需求评审 / 技术评审记录（--kind requirement|tech）。
 * - 需求评审：full 由产品设计师、fast 由需求分析师执行；PM 一律不评审。
 * - 技术评审：full 由产品/程序员A，fast 由程序员A记录；可绑定提案哈希。
 * 评审记录落 团队/状态/项目/<slug>/{需求评审|技术评审}/，并写任务字段与事件链。
 */
function cmdReqReview(args) {
  const b = bootFor(args, 'req review');
  const kindArg = String(args.kind || args.stage || 'requirement').trim().toLowerCase();
  const isTech = ['tech', 'technical'].includes(kindArg);
  const isReq = ['requirement', 'req'].includes(kindArg);
  if (!isTech && !isReq) fail('BAD_KIND', '--kind 只能是 requirement（需求评审）或 tech（技术评审记录）', { kind: kindArg });
  const project = loadProject(b.project);
  const teamMode = projectTeamMode(project);
  if (isTech) {
    const allowed = techReviewers(teamMode);
    if (!allowed.includes(b.role)) {
      fail('ROLE_NOT_ALLOWED', `技术评审记录只能由 ${allowed.map((r) => ROLE_NAMES[r] || r).join(' / ')} 执行（当前项目模式 ${teamMode}）`, {
        role: b.role, allowed, teamMode,
      });
    }
  } else {
    const reviewer = requirementReviewer(teamMode);
    if (b.role !== reviewer) {
      fail('ROLE_NOT_ALLOWED', `需求评审在 ${teamMode} 模式必须由 ${ROLE_NAMES[reviewer] || reviewer} 执行；PM 与其他角色不能代评`, {
        role: b.role, required: reviewer, teamMode,
      });
    }
  }
  if (!args.id) fail('BAD_ID', '需要 --id R-...');
  const requirementId = String(args.id);
  const task = loadTask(b.project, requirementId);
  if (task.type !== 'requirement') fail('NOT_REQUIREMENT', `${requirementId} 不是需求（type=${task.type}）；需求评审只针对 req create 建的需求`, { id: requirementId, type: task.type });
  const verdict = String(args.verdict || args.decision || '').toLowerCase();
  if (!['approve', 'reject'].includes(verdict)) fail('BAD_VERDICT', '--verdict 必须是 approve / reject');
  const comments = String(args.comments || args.comment || '').trim();
  if (verdict === 'reject' && comments.length < 10) fail('COMMENTS_REQUIRED', '打回必须写至少 10 字理由');
  let proposal = null;
  if (args.proposal) {
    proposal = loadProposal(b.project, String(args.proposal));
    const actual = computeProposalHash(proposal);
    if (actual !== proposal.proposalHash) fail('PROPOSAL_TAMPERED', '提案哈希不符', { expected: proposal.proposalHash, actual });
  }
  const ts = nowIso();
  const record = {
    id: (isTech ? 'TR-' : 'RR-') + stamp() + '-' + randomHex(2),
    kind: isTech ? 'tech' : 'requirement',
    project: b.project,
    teamMode,
    requirementId: task.id,
    title: task.title,
    proposalId: proposal ? proposal.id : '',
    proposalHash: proposal ? proposal.proposalHash : '',
    role: b.role,
    sessionId: b.sessionId,
    verdict,
    comments: truncate(comments, 600),
    ts,
  };
  const dir = reviewRecordDir(b.project, isTech);
  const reviewFiles = writeReviewFile(dir, record, isTech ? '技术评审记录' : '需求评审记录');
  const listKey = isTech ? 'techReviews' : 'reviews';
  const lastKey = isTech ? 'techReview' : 'review';
  task[listKey] = Array.isArray(task[listKey]) ? task[listKey] : [];
  task[listKey] = [...task[listKey], record].slice(-20);
  task[lastKey] = record;
  task.workflow = task.workflow && typeof task.workflow === 'object' ? task.workflow : {};
  task.workflow.reviewedAt = ts;
  task.workflow.reviewedBy = b.role;
  task.workflow.reviewRole = b.role;
  task.workflow.teamMode = teamMode;
  if (isTech) {
    // 与工作台 team-tools.js 的 techReview 同形：派单闸门读 verdict/trId，审计读 tr。
    task.workflow.techReview = {
      verdict,
      by: b.role,
      role: b.role,
      teamMode,
      comment: truncate(comments, 600),
      evidence: '',
      at: ts,
      source: 'team.mjs req review --kind tech',
      trId: record.id,
      trFile: reviewFiles.jsonFile,
      tr: record,
    };
  } else {
    const reviewPayload = {
      verdict,
      by: b.role,
      reviewRole: b.role,
      teamMode,
      comment: truncate(comments, 600),
      at: ts,
      source: 'team.mjs req review',
      command: 'req review',
    };
    // 保留 productReview / requirementReview 两个同形别名：旧界面读前者，新审计读后者。
    task.workflow.productReview = reviewPayload;
    task.workflow.requirementReview = reviewPayload;
  }
  if (verdict === 'reject') {
    stampRejected(task, { source: `${record.kind}_review:${record.id}`, role: b.role, at: ts });
  } else {
    task.workflow.requirementStatus = isTech ? 'ready' : 'approved';
    delete task.workflow.rejectedAt;
    delete task.workflow.rejectedBy;
    delete task.workflow.rejectionSource;
  }
  task.updatedAt = ts;
  task._by = b.role;
  task._action = isTech ? 'tech_review' : 'req_review';
  task._note = `${verdict} ${comments}`.trim();
  saveTask(b.project, task);
  // 评审结果同时写一份工作台可读的工作流行；通过时不强建，驳回时必须留痕。
  // 驳回后流程页应停在“需求评审”，而不是退回“需求”节点。
  const workflowPhase = isTech
    ? (verdict === 'approve' ? 'dispatch' : 'requirement_review')
    : (verdict === 'approve' ? 'owner_review' : 'requirement_review');
  const ownerPending = !isTech && verdict === 'approve';
  const workflowSync = syncWorkflowRow(b.project, task, task.workflow.requirementStatus, {
    reviewedAt: task.workflow.reviewedAt,
    reviewedBy: task.workflow.reviewedBy,
    reviewRole: task.workflow.reviewRole,
    teamMode,
    productReview: task.workflow.productReview,
    requirementReview: task.workflow.requirementReview,
    techReview: task.workflow.techReview,
    ownerReview: ownerPending ? { status: 'pending', at: null, opinion: '' } : undefined,
    rejectedAt: task.workflow.rejectedAt,
    rejectedBy: task.workflow.rejectedBy,
    rejectionSource: task.workflow.rejectionSource,
  }, {
    create: verdict === 'reject',
    action: isTech ? 'tech_review' : 'req_review',
    by: b.role,
    note: comments,
    phase: workflowPhase,
    // 通过时也建档：Owner 决定/验收与工作台快照都要读 工作流.json 的同一需求行，
    // 不能等驳回才创建，否则首次评审通过后 owner 会报 REQUIREMENT_NOT_FOUND。
    create: true,
    statePatch: ownerPending
      ? { ownerReview: { required: true, status: 'pending', kind: 'requirement', at: null, opinion: '' } }
      : null,
  });
  appendEvent({
    role: b.role, sessionId: b.sessionId, action: isTech ? 'tech_review' : 'req_review', project: b.project,
    target: task.id, note: `${verdict} ${truncate(comments, 100)}`,
    data: {
      reviewId: record.id, kind: record.kind, verdict, proposalId: record.proposalId, proposalHash: record.proposalHash,
      teamMode, reviewFile: reviewFiles.jsonFile, workflowFile: workflowSync.file,
    },
  });
  notify({
    from: b.role, to: 'pm',
    subject: `${isTech ? '技术评审' : '需求评审'}${verdict === 'approve' ? '通过' : '打回'} ${task.id}`,
    body: `${task.title}\n${comments || '（无备注）'}\n记录：${record.id}（${record.kind}，${teamMode}）\n文件：${reviewFiles.jsonFile}`,
    project: b.project, task: task.id, ackRequired: true, type: isTech ? 'tech_review' : 'req_review', sessionId: b.sessionId,
  });
  out(args, `${isTech ? '技术评审记录' : '需求评审'}已记录：${task.id} → ${verdict}（${record.id}，${teamMode}）\n记录：${reviewFiles.jsonFile}`,
    {
      ok: true, requirement: task, review: record, kind: record.kind, teamMode,
      reviewFile: reviewFiles.jsonFile, mdFile: reviewFiles.mdFile, workflowFile: workflowSync.file,
      ...(proposal ? { proposal } : {}),
    });
}

/**
 * 被驳回需求的出口：req iterate / req terminate。
 * 只改团队工具任务与 工作流.json 的需求行；不改阶段机里的其它需求。
 */
function cmdReqLifecycle(args, action) {
  const b = bootFor(args, `req ${action}`);
  if (b.role !== 'pm') fail('NOT_PM', `只有 PM 能决定需求 ${action === 'iterate' ? '进入下一轮' : '终止'}`);
  if (!args.id) fail('BAD_ID', '需要 --id R-...');
  const task = loadTask(b.project, String(args.id));
  if (task.type !== 'requirement') {
    fail('NOT_REQUIREMENT', `${task.id} 不是需求（type=${task.type}）；req ${action} 只针对 req create 建的需求`, { id: task.id, type: task.type });
  }
  const reason = String(args.reason || args.comments || args.opinion || '').trim();
  const result = transitionRequirement({
    project: b.project, task, action, role: b.role, sessionId: b.sessionId, reason, force: Boolean(args.force),
  });
  const human = action === 'iterate'
    ? `需求已进入下一轮：${task.id}（第 ${result.requirement.workflow.iterationRound} 轮）\n工作流：${result.workflowFile}`
    : `需求已终止：${task.id}\n关闭子任务 ${result.closedTasks.length} 个\n工作流：${result.workflowFile}`;
  out(args, human, {
    ok: true,
    action,
    requirement: result.requirement,
    workflowFile: result.workflowFile,
    workflow: result.workflow,
    closedTasks: result.closedTasks,
  });
}

// ========== Owner（外部角色 · 无 boot · 本机确认） ==========
// 工作台旧协议的 owner 命令：需求级决定（approved/skipped/rejected）与验收（--action accept）。
// Owner 不属于六角色，没有 boot；用 owner confirm 的一次性 nonce 证明“本机 Owner 已确认”。

const OWNER_TERMINAL = new Set(['accepted', 'terminated']);

/** 需求级决定只认 approved/skipped/rejected；验收只认 accepted/rejected。 */
function normalizeOwnerDecision(action, decision) {
  const raw = String(decision == null ? '' : decision).trim().toLowerCase();
  if (action === 'accept') {
    return ({ accepted: 'accepted', accept: 'accepted', approve: 'accepted', approved: 'accepted', reject: 'rejected', rejected: 'rejected' })[raw] || '';
  }
  return ({ approved: 'approved', approve: 'approved', skipped: 'skipped', skipped_by_owner: 'skipped', rejected: 'rejected', reject: 'rejected' })[raw] || '';
}

function ownerConfirmNonce(args) {
  return String(args['owner-confirm'] || args.ownerConfirm || args.confirm || '').trim();
}

/**
 * Owner 验收前的测试闸门：该需求名下必须有测试任务且全部 done。
 * 只读；不写任何状态。返回 {ok, code, message, mode, taskIds, missing}。
 */
function ownerTestGate(projectName, requirementId) {
  const children = listTasks(projectName).filter((row) => row
    && String(row.id) !== String(requirementId)
    && String(row.requirementId || '') === String(requirementId));
  const testTasks = children.filter((row) => String(row.owner || '') === 'tester'
    || String((row.workflow && row.workflow.stage) || '') === 'test'
    || /测试/.test(String(row.title || '')));
  if (!testTasks.length) {
    return {
      ok: false,
      code: 'TEST_NOT_DONE',
      message: `需求 ${requirementId} 没有测试任务；测试 done 后才能 Owner 验收`,
      requirementId,
      taskIds: [],
    };
  }
  const open = testTasks.filter((row) => String(row.status || '') !== 'done');
  if (open.length) {
    return {
      ok: false,
      code: 'TEST_NOT_DONE',
      message: `需求 ${requirementId} 的测试任务还没完成：${open.map((row) => row.id).join(', ')}`,
      requirementId,
      taskIds: testTasks.map((row) => row.id),
      open: open.map((row) => row.id),
    };
  }
  return { ok: true, mode: 'tasks', taskIds: testTasks.map((row) => row.id) };
}

function cmdOwnerConfirm(args) {
  const projectName = String(args.project || '').trim();
  if (!projectName) fail('BAD_ARGS', '需要 --project <团队项目名>');
  loadProject(projectName);
  const requirementId = String(args.requirement || '').trim();
  if (!requirementId) fail('BAD_ARGS', '需要 --requirement R-...');
  const actionRaw = String(args.action || '').trim().toLowerCase();
  if (actionRaw && actionRaw !== 'accept') {
    fail('BAD_ACTION', '--action 只支持 accept（Owner 验收）', { action: actionRaw, allowed: ['accept'] });
  }
  const decision = normalizeOwnerDecision(actionRaw || 'review', args.decision);
  if (!decision) {
    fail('OWNER_DECISION_INVALID', actionRaw === 'accept'
      ? '验收时 --decision 必须是 accepted 或 rejected'
      : 'Owner 决定必须是 approved / skipped / rejected', {
      decision: String(args.decision || ''),
      allowed: actionRaw === 'accept' ? ['accepted', 'rejected'] : ['approved', 'skipped', 'rejected'],
    });
  }
  const testOwner = Boolean(args['test-owner'] || args.testOwner);
  let channel = 'tty';
  if (testOwner) {
    // --test-owner 只给自测/壳层注入用；生产必须真实终端，不能靠环境变量绕过。
    if (String(process.env.TEAM_SELFTEST || '') !== '1') {
      fail('OWNER_TTY_REQUIRED', '--test-owner 只在 TEAM_SELFTEST=1 的自测里可用；真实终端请直接运行 owner confirm');
    }
    channel = 'test';
  } else if (!process.stdin.isTTY) {
    fail('OWNER_TTY_REQUIRED', 'owner confirm 必须在真实终端运行（当前没有 TTY）；自测请用 --test-owner', { tty: false });
  }
  const ttlMs = args.ttl ? Number(args.ttl) * 1000 : undefined;
  const record = issueOwnerConfirmation({
    project: projectName, requirementId, decision, action: actionRaw, channel, ttlMs,
  });
  out(args, [
    `Owner 确认码已签发 · ${requirementId}（${decision}${actionRaw ? ' / ' + actionRaw : ''}）`,
    `项目：${projectName} ｜ 渠道：${channel} ｜ 过期：${record.expiresAt}`,
    `确认码：${record.nonce}`,
    `下一步：node 团队\\工具\\team.mjs owner --project "${projectName}" --requirement "${requirementId}" --decision "${decision}"${actionRaw ? ' --action accept' : ''} --opinion "..." --owner-confirm ${record.nonce} --json`,
  ].join('\n'), {
    ok: true,
    confirmation: record,
    nonce: record.nonce,
    project: projectName,
    requirementId,
    decision,
    action: actionRaw,
    expiresAt: record.expiresAt,
    channel,
  });
}

/**
 * Owner 决定 / 验收。Owner 是外部角色，没有 boot；必须先有 owner confirm 的一次性确认码。
 * 只写需求任务、工作流.json 与事件链；需求正文/总览由工作台壳层消费返回值后同步。
 */
export async function cmdOwner(args) {
  const sub = String(args._[1] || '').trim().toLowerCase();
  if (sub === 'confirm') { cmdOwnerConfirm(args); return; }
  if (sub) fail('BAD_SUBCOMMAND', `未知 owner 子命令：${sub}（owner 直接执行，确认用 owner confirm）`);

  const projectName = String(args.project || '').trim();
  if (!projectName) fail('BAD_ARGS', '需要 --project <团队项目名>');
  const project = loadProject(projectName);
  const requirementId = String(args.requirement || '').trim();
  if (!requirementId) fail('BAD_ARGS', '需要 --requirement R-...');
  const actionRaw = String(args.action || '').trim().toLowerCase();
  if (actionRaw && actionRaw !== 'accept') {
    fail('BAD_ACTION', '--action 只支持 accept（Owner 验收）', { action: actionRaw, allowed: ['accept'] });
  }
  const decision = normalizeOwnerDecision(actionRaw || 'review', args.decision);
  if (!decision) {
    fail('OWNER_DECISION_INVALID', actionRaw === 'accept'
      ? '验收时 --decision 必须是 accepted 或 rejected'
      : 'Owner 决定必须是 approved / skipped / rejected', {
      decision: String(args.decision || ''),
      allowed: actionRaw === 'accept' ? ['accepted', 'rejected'] : ['approved', 'skipped', 'rejected'],
    });
  }
  if (args.opinion === undefined || args.opinion === null) {
    fail('OPINION_REQUIRED', '需要 --opinion "Owner 意见"（可以为空字符串，但必须显式给出）');
  }
  const opinion = truncate(String(args.opinion || '').trim(), 1000);
  const teamMode = projectTeamMode(project);
  const task = loadTask(projectName, requirementId);
  if (task.type !== 'requirement') {
    fail('NOT_REQUIREMENT', `${requirementId} 不是需求（type=${task.type}），Owner 命令只处理需求`, { id: requirementId, type: task.type });
  }
  const read = readWorkflowState(projectName);
  let row = read.state.requirements[requirementId];
  if (row && OWNER_TERMINAL.has(String(row.status || ''))) {
    fail('REQUIREMENT_STATE_INVALID', `需求 ${requirementId} 已经是 ${row.status}，不能再做 Owner 决定`, {
      requirementId, status: row.status,
    });
  }
  // 产品闸门：Owner 不能跳过需求评审。full=product，fast=analyst，两者都写 productReview 同形字段。
  const review = (task.workflow && (task.workflow.productReview || task.workflow.requirementReview))
    || (row && (row.productReview || row.requirementReview)) || task.review || null;
  if (!review || String(review.verdict || '') !== 'approve') {
    fail('PRODUCT_REVIEW_REQUIRED', `需求 ${requirementId} 还没有需求评审通过，Owner 不能跳过评审闸门`, {
      requirementId,
      review: review || null,
      hint: '先运行 req review --verdict approve --comments "..."',
    });
  }
  let testGate = null;
  if (actionRaw === 'accept') {
    // 验收前 Owner 决定必须已通过/跳过；被 Owner 打回的需求不能直接验收。
    const ownerStatus = String((row && row.ownerReview && row.ownerReview.status) || '');
    if (ownerStatus && !['approved', 'skipped'].includes(ownerStatus)) {
      fail('REQUIREMENT_STATE_INVALID', `需求 ${requirementId} 的 Owner 决定是 ${ownerStatus}，不能验收`, {
        requirementId, ownerReview: row.ownerReview,
      });
    }
    const lifecycleStatus = String((row && row.status) || '');
    if (!['test', 'test_done', 'dev_done'].includes(lifecycleStatus)) {
      fail('REQUIREMENT_STATE_INVALID', `需求 ${requirementId} 当前状态是 ${lifecycleStatus}，测试阶段完成后才能 Owner 验收`, {
        requirementId, status: lifecycleStatus, allowed: ['test', 'test_done', 'dev_done'],
      });
    }
    testGate = ownerTestGate(projectName, requirementId);
    if (!testGate.ok) {
      fail(testGate.code, testGate.message, {
        requirementId, taskIds: testGate.taskIds || [], open: testGate.open || [],
      });
    }
  }

  // 旧项目可能只有任务/正文、没有工作流行：先按任务补一行最小记录（不伪造评审结论）。
  // 正常 req review 已经 create:true，不会走到这里。
  if (!row) {
    const recovered = syncWorkflowRow(projectName, task, String(task.workflow.requirementStatus || 'review'), {
      teamMode,
      ...(task.workflow.productReview ? { productReview: task.workflow.productReview } : {}),
      ...(task.workflow.requirementReview ? { requirementReview: task.workflow.requirementReview } : {}),
      ...(task.workflow.techReview ? { techReview: task.workflow.techReview } : {}),
    }, {
      create: true,
      action: 'owner_recover_row',
      by: 'system',
      note: 'Owner 命令前按任务补建工作流行',
      phase: 'requirement_review',
    });
    row = recovered.state && recovered.state.requirements[requirementId];
  }

  const nonce = ownerConfirmNonce(args);
  const confirmation = consumeOwnerConfirmation({
    nonce, project: projectName, requirementId, decision, action: actionRaw, channel: args.channel ? String(args.channel) : '',
  });
  if (!confirmation) {
    fail('OWNER_CONFIRM_REQUIRED', 'Owner 操作需要本机确认：先运行 owner confirm 签发一次性确认码，再带 --owner-confirm 重试', {
      project: projectName,
      requirementId,
      decision,
      action: actionRaw,
      hint: ownerConfirmHint({ project: projectName, requirementId, decision, action: actionRaw }),
    });
  }

  const at = nowIso();
  const confirmationMeta = {
    channel: confirmation.channel,
    at: confirmation.at,
    nonceHash: confirmation.nonceHash,
    issuedAt: confirmation.issuedAt,
    expiresAt: confirmation.expiresAt,
  };
  const record = {
    status: decision,
    by: 'Owner',
    actor: 'owner',
    at,
    opinion,
    channel: confirmation.channel,
    source: 'team.mjs owner',
    command: actionRaw === 'accept' ? 'owner --action accept' : 'owner',
    confirmation: confirmationMeta,
  };
  task.workflow = task.workflow && typeof task.workflow === 'object' ? task.workflow : {};
  let nextStatus;
  let nextPhase;
  let actionName;
  let eventAction;
  let ownerReview = null;
  let acceptance = null;
  if (actionRaw === 'accept') {
    acceptance = record;
    task.workflow.ownerAcceptance = record;
    if (decision === 'accepted') {
      nextStatus = 'accepted';
      nextPhase = 'accepted';
      task.workflow.requirementStatus = 'accepted';
      delete task.workflow.rejectedAt;
      delete task.workflow.rejectedBy;
      delete task.workflow.rejectionSource;
      task.status = 'done';
      task.doneAt = at;
      task.evidence = truncate(`Owner 验收通过${opinion ? '：' + opinion : ''}`, 500);
    } else {
      nextStatus = 'rejected';
      nextPhase = 'requirement_review';
      stampRejected(task, { source: 'owner_accept', role: 'owner', at });
    }
    actionName = 'owner_accept';
    eventAction = 'owner_accept';
  } else {
    ownerReview = record;
    task.workflow.ownerReview = record;
    if (decision === 'rejected') {
      nextStatus = 'rejected';
      nextPhase = 'requirement_review';
      stampRejected(task, { source: 'owner_review', role: 'owner', at });
    } else if (teamMode === 'fast') {
      // Fast 的 Owner 通过后先进入技术评审，技术评审通过才 ready 可派单。
      nextStatus = 'tech_review';
      nextPhase = 'tech_review';
      task.workflow.requirementStatus = 'tech_review';
    } else {
      nextStatus = 'ready';
      nextPhase = 'dispatch';
      task.workflow.requirementStatus = 'ready';
    }
    actionName = 'owner_requirement';
    eventAction = 'owner_requirement';
  }
  task.updatedAt = at;
  task._by = 'Owner';
  task._action = actionName;
  task._note = truncate(`${decision}${opinion ? '：' + opinion : ''}`, 100);
  saveTask(projectName, task);

  const stateOwnerReview = actionRaw === 'accept'
    ? {
      required: true,
      status: decision === 'accepted' ? 'approved' : 'rejected',
      kind: 'acceptance',
      by: 'Owner',
      actor: 'owner',
      at,
      opinion,
      channel: confirmation.channel,
      confirmation: confirmationMeta,
    }
    : {
      required: true,
      status: decision,
      kind: 'requirement',
      by: 'Owner',
      actor: 'owner',
      at,
      opinion,
      channel: confirmation.channel,
      confirmation: confirmationMeta,
    };
  // note 必须与工作台壳层 pushWorkflowEventOnce 的写法完全一致，否则同一次 Owner
  // 决定会被记成两条事件（壳层已兼容旧命令写过的记录）。
  const eventNote = actionRaw === 'accept'
    ? decision
    : `${decision}${opinion ? '：' + opinion.slice(0, 80) : ''}`;
  const sync = syncWorkflowRow(projectName, task, nextStatus, {
    teamMode,
    ...(ownerReview ? { ownerReview } : {}),
    ...(acceptance ? { acceptance, ownerAcceptance: acceptance } : {}),
  }, {
    create: true,
    action: actionName,
    by: 'Owner',
    note: decision,
    phase: nextPhase,
    statePatch: { ownerReview: stateOwnerReview },
    event: { action: eventAction, role: 'owner', requirementId, note: eventNote },
  });

  appendEvent({
    role: 'owner',
    sessionId: confirmation.channel,
    action: actionName,
    project: projectName,
    target: requirementId,
    note: truncate(`${decision}${opinion ? '：' + opinion : ''}`, 120),
    data: {
      decision,
      action: actionRaw || 'review',
      teamMode,
      confirmation: confirmationMeta,
      ownerReview,
      acceptance,
      workflowFile: sync.file,
      ...(testGate ? { testGate } : {}),
    },
  });
  const label = actionRaw === 'accept' ? '验收' : '决定';
  out(args, [
    `Owner ${label}：${requirementId} → ${decision}（${teamMode}，channel=${confirmation.channel}）`,
    `需求状态：${nextStatus} ｜ 工作流相位：${sync.state ? sync.state.phase : nextPhase}`,
    `工作流：${sync.file}`,
  ].join('\n'), {
    ok: true,
    project: projectName,
    requirementId,
    action: actionRaw || 'review',
    decision,
    teamMode,
    requirement: task,
    ownerReview,
    acceptance,
    testGate,
    confirmation: { ...confirmationMeta, channel: confirmation.channel },
    workflow: sync.state,
    workflowFile: sync.file,
  });
}

/**
 * 工作台旧协议入口：workflow iterate / terminate。
 * 只做两件事：推进轮次（可把被驳回需求转入下一轮）或终止全部未收口需求；
 * 工作流文件与工作台共用，保留工作台其它字段。
 */
export function cmdWorkflow(args) {
  const action = String(args._[1] || '').trim().toLowerCase();
  if (!['iterate', 'terminate'].includes(action)) {
    fail('BAD_ACTION', 'workflow 只支持 iterate / terminate', { action, allowed: ['iterate', 'terminate'] });
  }
  const b = bootFor(args, `workflow ${action}`);
  if (b.role !== 'pm') fail('NOT_PM', '只有 PM 能推进工作流轮次或终止工作流');
  const result = workflowAction({
    project: b.project,
    action,
    role: b.role,
    sessionId: b.sessionId,
    opinion: String(args.opinion || args.reason || ''),
    requirementId: args.requirement ? String(args.requirement) : '',
    force: Boolean(args.force),
  });
  const human = action === 'iterate'
    ? `工作流已进入下一轮：第 ${result.fromRound} 轮 → 第 ${result.round} 轮；转入迭代 ${result.transitioned.length} 条\n工作流：${result.workflowFile}`
    : `工作流已终止：停止 ${result.stopped.length} 条需求；关闭子任务 ${result.closedTasks.length} 个\n工作流：${result.workflowFile}`;
  out(args, human, { ...result, ok: true, project: b.project });
}


export function cmdFind(args) {
  const b = bootFor(args, 'find');
  const project = loadProject(b.project);
  const indexMd = projectIndexPath(project);
  const indexJson = path.join(project.path, '项目索引.json');
  if (!exists(indexMd) || !exists(indexJson)) fail('INDEX_MISSING', '项目索引不存在；先 index', { index: indexMd });
  const currentHash = hashFile(indexMd);
  if (b.projectIndexHash && b.projectIndexHash !== currentHash) {
    fail('INDEX_CHANGED', '索引在 boot 后变了；重新 boot 再找文件', { bootIndex: b.projectIndexHash, current: currentHash });
  }
  addReadReceipt({ role: b.role, sessionId: b.sessionId, kind: 'index_search', project: b.project, proposalId: '', proposalHash: '', baseHash: currentHash });
  const q = String(args.q || args.query || '').trim();
  if (!q) fail('BAD_QUERY', '需要 --q 关键词');
  const data = readJson(indexJson, { files: [] });
  const ql = q.toLowerCase();
  const matches = (data.files || []).filter((f) => String(f.target).toLowerCase().includes(ql));
  appendEvent({ role: b.role, sessionId: b.sessionId, action: 'index_find', project: b.project, target: q, note: `matches=${matches.length}`, data: { q, matches: matches.map((m) => m.target) } });
  out(args, `按索引找到 ${matches.length} 个文件（先读索引，再找文件）\n` + table(matches.slice(0, 50).map((f) => ({ target: f.target, size: f.size, hash: shortHash(f.hash || '', 10) })), [
    { key: 'target', label: '文件' }, { key: 'size', label: '大小' }, { key: 'hash', label: '哈希' },
  ]), { ok: true, query: q, matches });
}

// ========== 提案 / 展示 / 评审 / 签字 / 应用 ==========

export function cmdPropose(args) {
  const b = bootFor(args, 'propose');
  if (!args.task) fail('BAD_TASK', '需要 --task（先 claim 任务）');
  const task = loadTask(b.project, String(args.task));
  if (task.status === 'done') fail('TASK_DONE', `任务已完成：${task.id}`);
  if (task.owner !== b.role) fail('TASK_NOT_OWNER', `任务 owner 是 ${task.owner || '空'}，先 claim 再来提`, { owner: task.owner });
  if (!task.priority) fail('NO_PRIORITY', '任务没有优先级，先让 PM 定优先级');
  const specs = parseFiles(args);
  const expects = parseExpect(args);
  const project = loadProject(b.project);
  const team = loadTeam();
  let risk = String(args.risk || 'normal');
  if (!RISK_RANK[risk]) fail('BAD_RISK', `风险级别必须是 normal/sensitive/critical：${risk}`);
  const stagedFiles = [];
  const proposalIdPreview = 'P-' + stamp();
  const tempDir = path.join(projectStatePaths(b.project).proposals, proposalIdPreview + '-tmp');
  ensureDir(tempDir);
  try {
    let n = 0;
    for (const spec of specs) {
      const { rel, abs } = normalizeTarget(project, spec.target);
      const staged = resolveStaged(spec.staged);
      const st = fs.statSync(staged);
      const isDoc = /\.(md|markdown|txt)$/i.test(rel);
      const max = isDoc
        ? Number(team.config.docMaxBytes || 16384)
        : Number(team.config.codeMaxBytes || 65536);
      if (st.size > max) fail('STAGED_TOO_BIG', `${isDoc ? '文档' : '代码'}超过 ${max} 字节：${staged}`, { size: st.size, max, kind: isDoc ? 'document' : 'code' });
      const minRisk = requiredRisk(project, rel);
      if (RISK_RANK[minRisk] > RISK_RANK[risk]) {
        fail('RISK_TOO_LOW', `目标 ${rel} 至少是 ${minRisk} 风险，不能用 ${risk}`, { target: rel, minRisk, risk });
      }
      const currentHash = exists(abs) ? hashFile(abs) : 'absent';
      const expect = expects.get(rel) || (specs.length === 1 ? String(args['expect-base'] || '').toLowerCase() : '');
      if (!expect) {
        fail('EXPECT_BASE_REQUIRED', `提案前必须声明你读到的版本：--expect ${rel}=${currentHash}`, { target: rel, currentHash });
      }
      if (expect !== currentHash) {
        fail('STALE_BASE', `读过之后文件变了：${rel}`, { target: rel, expected: expect, current: currentHash });
      }
      if (!hasGrant(b.role, 'propose', b.project, rel)) {
        fail('NO_GRANT', `没有 ${b.role} 对 ${rel} 的 propose 授权；让 PM grant`, { target: rel, role: b.role });
      }
      const newHash = hashFile(staged);
      const snapshot = path.join(tempDir, `${++n}-${path.basename(rel)}`);
      fs.copyFileSync(staged, snapshot);
      if (hashFile(snapshot) !== newHash) fail('COPY_BAD', `暂存快照哈希不一致：${rel}`);
      stagedFiles.push({ target: rel, baseHash: currentHash, newHash, size: st.size, staged: snapshot, stagedSha: newHash });
    }
    const fingerprint = (files) => JSON.stringify(files.map((f) => `${f.target}|${f.newHash}`).sort());
    const dup = listProposals(b.project).find((p) => p.author === b.role && p.task === task.id && ['proposed', 'reviewing', 'signing'].includes(p.status) && fingerprint(p.files || []) === fingerprint(stagedFiles));
    if (dup) fail('DUPLICATE_PROPOSAL', `已有相同未闭环提案：${dup.id}`, { proposalId: dup.id });
    // 分配正式提案目录，把临时快照搬进去
    const proposal = newProposal({
      project: b.project, author: b.role, authorSession: b.sessionId, task: task.id,
      title: args.title || task.title, rationale: args.rationale || '', risk, files: [],
    });
    const pdir = proposalPaths(b.project, proposal.id).dir;
    const finalFiles = [];
    let idx = 0;
    for (const f of stagedFiles) {
      const name = `${++idx}-${path.basename(f.target)}`;
      const dst = path.join(pdir, '文件', name);
      fs.copyFileSync(f.staged, dst);
      finalFiles.push({ target: f.target, baseHash: f.baseHash, newHash: f.newHash, size: f.size, staged: `文件/${name}`, stagedSha: f.stagedSha });
    }
    const sets = requiredSets({ ...proposal, risk, author: b.role }, team);
    proposal.files = finalFiles;
    proposal.minReviews = sets.minReviews;
    proposal.requiredSigners = sets.signers;
    proposal.requiredReviewers = sets.reviewers;
    proposal.proposalHash = computeProposalHash(proposal);
    saveProposal(b.project, proposal);
    appendEvent({
      role: b.role, sessionId: b.sessionId, action: 'propose', project: b.project, target: proposal.id,
      note: `${risk} ${proposal.title} files=${finalFiles.length}`, data: { proposalHash: proposal.proposalHash, risk, files: finalFiles.map((f) => f.target) },
    });
    notify({
      from: b.role, to: 'pm', subject: `待审提案 ${proposal.id}`,
      body: `${risk} · ${proposal.title}\n文件：${finalFiles.map((f) => f.target).join(', ')}\n请先 show 再 review/sign。`,
      project: b.project, task: task.id, ackRequired: true, type: 'proposal', sessionId: b.sessionId,
    });
    out(args, `提案已建 ${proposal.id}\n哈希 ${proposal.proposalHash}\n风险 ${risk} ｜ 最少评审 ${proposal.minReviews} ｜ 签字 ${proposal.requiredSigners.join(', ')}\n下一步：PM show → review → sign；apply 前 CAS 必须过`, { ok: true, proposal });
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export function cmdShow(args) {
  const b = bootFor(args, 'show');
  if (!args.proposal) fail('BAD_ID', '需要 --proposal');
  const proposal = loadProposal(b.project, String(args.proposal));
  const actual = computeProposalHash(proposal);
  if (actual !== proposal.proposalHash) fail('PROPOSAL_TAMPERED', '提案 JSON 与哈希不符，拒绝展示', { expected: proposal.proposalHash, actual });
  const project = loadProject(b.project);
  const lines = [];
  lines.push(`=== 提案 ${proposal.id} · ${proposal.risk} · ${proposal.status} ===`);
  lines.push(`标题: ${proposal.title}`);
  lines.push(`作者: ${proposal.author} ｜ 任务: ${proposal.task} ｜ 创建: ${proposal.createdAt}`);
  lines.push(`提案哈希: ${proposal.proposalHash}`);
  lines.push(`理由: ${proposal.rationale || '（未写）'}`);
  lines.push(`文件（${proposal.files.length}）：`);
  for (const f of proposal.files) {
    lines.push(`  - ${f.target}`);
    lines.push(`    base=${f.baseHash}  new=${f.newHash}  size=${f.size}`);
    lines.push(`    暂存: ${path.join(proposalPaths(b.project, proposal.id).dir, f.staged)}`);
    if (args.diff) {
      const nextBuf = safeRead(path.join(proposalPaths(b.project, proposal.id).dir, f.staged));
      const baseBuf = f.baseHash === 'absent' ? Buffer.from('') : safeRead(path.join(project.path, f.target));
      if (!isBinary(nextBuf) && !isBinary(baseBuf)) {
        const d = lineDiff((baseBuf || Buffer.from('')).toString('utf8'), (nextBuf || Buffer.from('')).toString('utf8'));
        lines.push('    --- diff ---');
        for (const l of d) lines.push('    ' + l);
      } else {
        lines.push('    （二进制文件，请直接读暂存文件）');
      }
    }
  }
  const reviews = loadReviews(b.project, proposal.id);
  const sigs = loadSignatures(b.project, proposal.id);
  lines.push(`评审: ${Object.keys(reviews).length ? Object.entries(reviews).map(([r, v]) => `${r}:${v.verdict}`).join(', ') : '（无）'}`);
  lines.push(`签字: ${Object.keys(sigs).length ? Object.entries(sigs).map(([r, v]) => `${r}:${v.decision}`).join(', ') : '（无）'}`);
  addReadReceipt({ role: b.role, sessionId: b.sessionId, kind: 'proposal', project: b.project, proposalId: proposal.id, proposalHash: proposal.proposalHash, baseHash: proposal.files.map((f) => f.baseHash).join(',') });
  appendEvent({ role: b.role, sessionId: b.sessionId, action: 'proposal_show', project: b.project, target: proposal.id, note: `hash=${shortHash(proposal.proposalHash)}`, data: { proposalHash: proposal.proposalHash } });
  out(args, lines.join('\n'), { ok: true, proposal, reviews, signatures: sigs });
}

export function cmdReview(args) {
  const b = bootFor(args, 'review');
  if (!args.proposal) fail('BAD_ID', '需要 --proposal');
  const proposal = loadProposal(b.project, String(args.proposal));
  const actual = computeProposalHash(proposal);
  if (actual !== proposal.proposalHash) fail('PROPOSAL_TAMPERED', '提案哈希不符', { expected: proposal.proposalHash, actual });
  if (proposal.author === b.role) fail('SELF_REVIEW', '不能审自己的提案');
  if (['applied', 'rejected'].includes(proposal.status)) fail('PROPOSAL_CLOSED', `提案已 ${proposal.status}`);
  const team = loadTeam();
  const sets = requiredSets(proposal, team);
  if (!sets.reviewers.includes(b.role)) fail('NOT_REQUIRED_REVIEWER', `${b.role} 不是本提案的评审人（${sets.reviewers.join(', ')}）`);
  const read = latestRead({
    role: b.role, sessionId: b.sessionId, proposalId: proposal.id, proposalHash: proposal.proposalHash,
    maxAgeMs: Number(team.config.reviewReadTtlMinutes || 15) * 60000,
  });
  if (!read) fail('MUST_READ_FIRST', '先运行 show 同一提案（且哈希一致），再 review', { proposal: proposal.id });
  const verdict = String(args.verdict || '').toLowerCase();
  if (!['approve', 'reject'].includes(verdict)) fail('BAD_VERDICT', '--verdict 必须是 approve / reject');
  const comments = String(args.comments || '');
  if (verdict === 'reject' && comments.trim().length < 10) fail('COMMENTS_REQUIRED', '打回必须写至少 10 字理由');
  if (args.priority) {
    if (!['pm', 'product'].includes(b.role)) fail('NOT_PM', '只有 PM / 产品能改优先级');
    setTaskPriority(b.project, proposal.task, String(args.priority), b.role, args['priority-reason'] || '评审时调整');
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'task_priority', project: b.project, target: proposal.task, note: `${args.priority}` });
  }
  const review = {
    proposalId: proposal.id, proposalHash: proposal.proposalHash,
    baseHash: proposal.files.map((f) => f.baseHash).join(','), newHash: proposal.files.map((f) => f.newHash).join(','),
    role: b.role, sessionId: b.sessionId, verdict, comments: truncate(comments, 600), ts: nowIso(),
  };
  saveReview(b.project, proposal.id, b.role, review);
  const reviews = loadReviews(b.project, proposal.id);
  if (verdict === 'reject') proposal.status = 'rejected';
  else if (approvedReviews(reviews).length >= (proposal.minReviews || 1)) proposal.status = 'reviewed';
  else proposal.status = 'reviewing';
  saveProposal(b.project, proposal);
  appendEvent({
    role: b.role, sessionId: b.sessionId, action: 'review', project: b.project, target: proposal.id,
    note: `${verdict} ${truncate(comments, 120)}`, data: { proposalHash: proposal.proposalHash, verdict },
  });
  notify({
    from: b.role, to: proposal.author, subject: `评审${verdict === 'approve' ? '通过' : '打回'} ${proposal.id}`,
    body: `${proposal.title}\n${comments || '（无备注）'}\n当前状态：${proposal.status}`,
    project: b.project, task: proposal.task, ackRequired: true, type: 'review', sessionId: b.sessionId,
  });
  out(args, `评审已记录：${proposal.id} → ${verdict}；提案状态 ${proposal.status}`, { ok: true, review, proposal });
}

export function cmdSign(args) {
  const b = bootFor(args, 'sign');
  if (!args.proposal) fail('BAD_ID', '需要 --proposal');
  const proposal = loadProposal(b.project, String(args.proposal));
  const actual = computeProposalHash(proposal);
  if (actual !== proposal.proposalHash) fail('PROPOSAL_TAMPERED', '提案哈希不符', { expected: proposal.proposalHash, actual });
  if (['applied', 'rejected'].includes(proposal.status)) fail('PROPOSAL_CLOSED', `提案已 ${proposal.status}`);
  const team = loadTeam();
  const sets = requiredSets(proposal, team);
  if (!sets.signers.includes(b.role)) fail('NOT_REQUIRED_SIGNER', `${b.role} 不在签字人（${sets.signers.join(', ')}）`);
  const decision = String(args.decision || 'approve').toLowerCase();
  if (!['approve', 'reject'].includes(decision)) fail('BAD_DECISION', '--decision 必须是 approve / reject');
  const isSelf = proposal.author === b.role;
  if (isSelf) {
    if (proposal.risk === 'normal') fail('SELF_SIGN_FORBIDDEN', 'normal 提案作者不单独签字；由评审 + PM 签');
    if (!args.self) fail('SELF_SIGN_FLAG', '作者签自己的提案需要显式 --self（sensitive/critical 全员签字）');
    if (decision !== 'approve') fail('BAD_DECISION', '作者自签只能 approve');
  } else {
    const reviews = loadReviews(b.project, proposal.id);
    const r = reviews[b.role];
    if (!r || r.verdict !== 'approve' || r.proposalHash !== proposal.proposalHash) {
      fail('REVIEW_REQUIRED', '签字前必须先 review 通过同一哈希的提案', { role: b.role });
    }
  }
  const ts = nowIso();
  const nonce = randomHex(6);
  const baseHash = proposal.files.map((f) => f.baseHash).join(',');
  const newHash = proposal.files.map((f) => f.newHash).join(',');
  const sig = signatureDigest({ role: b.role, proposalId: proposal.id, proposalHash: proposal.proposalHash, baseHash, newHash, decision, ts, nonce });
  const record = {
    role: b.role, proposalId: proposal.id, proposalHash: proposal.proposalHash,
    baseHash, newHash, decision, note: truncate(String(args.note || ''), 300), ts, nonce, sig,
    sessionId: b.sessionId,
  };
  saveSignature(b.project, proposal.id, b.role, record);
  if (decision === 'reject') proposal.status = 'rejected';
  else {
    const sigs = loadSignatures(b.project, proposal.id);
    const all = sets.signers.every((r) => sigs[r] && sigs[r].decision === 'approve');
    proposal.status = all ? 'approved' : 'signing';
  }
  saveProposal(b.project, proposal);
  appendEvent({
    role: b.role, sessionId: b.sessionId, action: 'sign', project: b.project, target: proposal.id,
    note: `${decision} ${truncate(String(args.note || ''), 100)}`, data: { proposalHash: proposal.proposalHash, decision, sig },
  });
  notify({
    from: b.role, to: 'pm', subject: `签字${decision === 'approve' ? '批准' : '拒绝'} ${proposal.id}`,
    body: `${proposal.title}\n${args.note || ''}\n提案状态：${proposal.status}`,
    project: b.project, task: proposal.task, ackRequired: true, type: 'sign', sessionId: b.sessionId,
  });
  out(args, `签字已记录：${proposal.id} / ${b.role} → ${decision}；提案状态 ${proposal.status}`, { ok: true, signature: record, proposal });
}

export function cmdApply(args) {
  const b = bootFor(args, 'apply');
  if (b.role !== 'pm') fail('NOT_PM', '只有 PM 能 apply（执行提交）');
  if (!args.proposal) fail('BAD_ID', '需要 --proposal');
  const project = loadProject(b.project);
  const team = loadTeam();
  const lockKey = `apply:${b.project}`;
  acquireLock(lockKey, { role: b.role, sessionId: b.sessionId, ttlMs: 120000, waitMs: 0, reason: 'apply commit' });
  try {
    const proposal = loadProposal(b.project, String(args.proposal));
    if (proposal.status !== 'approved') fail('NOT_APPROVED', `提案状态是 ${proposal.status}，必须 approved 才能 apply`);
    const actual = computeProposalHash(proposal);
    if (actual !== proposal.proposalHash) fail('PROPOSAL_TAMPERED', '提案哈希不符', { expected: proposal.proposalHash, actual });
    const { req, problems } = checkApprovals(proposal, team, { forApply: true });
    if (problems.length) fail('APPROVALS_INCOMPLETE', '评审/签字不满足，不能 apply', { problems, required: req });
    // CAS：目标当前哈希必须等于提案 baseHash
    const stale = [];
    for (const f of proposal.files) {
      const abs = path.join(project.path, f.target);
      const cur = exists(abs) ? hashFile(abs) : 'absent';
      if (cur !== f.baseHash) stale.push({ target: f.target, expectedBase: f.baseHash, current: cur });
    }
    if (stale.length) {
      proposal.status = 'stale';
      proposal.staleAt = nowIso();
      saveProposal(b.project, proposal);
      appendEvent({
        role: b.role, sessionId: b.sessionId, action: 'apply', project: b.project, target: proposal.id,
        result: 'STALE_BASE', note: '目标已变，提案作废，需重读重提重签', data: { stale, proposalHash: proposal.proposalHash },
      });
      fail('STALE_BASE', '版本栅栏拒绝：目标文件在评审后被改过，提案作废', { stale, proposalId: proposal.id });
    }
    const commitId = `C-${stamp()}-${randomHex(3)}`;
    const backupRoot = path.join(projectStatePaths(b.project).backups, commitId);
    const before = [];
    for (const f of proposal.files) {
      const abs = path.join(project.path, f.target);
      if (!exists(abs)) { before.push({ target: f.target, existed: false, hash: 'absent' }); continue; }
      const bp = path.join(backupRoot, f.target);
      ensureDir(path.dirname(bp));
      fs.copyFileSync(abs, bp);
      const bh = hashFile(bp);
      if (bh !== f.baseHash) fail('BACKUP_MISMATCH', `备份哈希与 baseHash 不一致：${f.target}`, { target: f.target, backup: bh, base: f.baseHash });
      before.push({ target: f.target, existed: true, hash: bh, backup: bp });
    }
    const written = [];
    try {
      for (const f of proposal.files) {
        const staged = path.join(proposalPaths(b.project, proposal.id).dir, f.staged);
        const buf = fs.readFileSync(staged);
        if (sha256(buf) !== f.newHash) fail('STAGED_TAMPERED', `暂存快照被改：${f.target}`, { target: f.target });
        const abs = path.join(project.path, f.target);
        ensureDir(path.dirname(abs));
        const tmp = `${abs}.team-tmp-${process.pid}-${randomHex(2)}`;
        fs.writeFileSync(tmp, buf);
        try { fs.renameSync(tmp, abs); } catch { fs.copyFileSync(tmp, abs); try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
        const after = hashFile(abs);
        if (after !== f.newHash) fail('WRITE_MISMATCH', `写入后哈希不对：${f.target}`, { target: f.target, after, expected: f.newHash });
        written.push({ target: f.target, hash: after });
        if (args['fail-after-backup'] && process.env.TEAM_SELFTEST === '1') {
          throw new TeamError('SELFTEST_FAIL', 'selftest 故意失败（验证回滚）');
        }
      }
    } catch (e) {
      const rollbackProblems = [];
      for (const bf of before) {
        const abs = path.join(project.path, bf.target);
        try {
          if (bf.existed) {
            fs.copyFileSync(bf.backup, abs);
            if (hashFile(abs) !== bf.hash) rollbackProblems.push({ target: bf.target, reason: 'restore hash mismatch' });
          } else if (exists(abs)) {
            fs.unlinkSync(abs);
          }
        } catch (re) {
          rollbackProblems.push({ target: bf.target, reason: re.message });
        }
      }
      appendEvent({
        role: b.role, sessionId: b.sessionId, action: 'rollback', project: b.project, target: proposal.id,
        result: rollbackProblems.length ? 'ROLLBACK_FAILED' : 'ROLLED_BACK',
        note: truncate(e.message, 120), data: { error: e.message, code: e.code || null, rollbackProblems, before },
      });
      if (rollbackProblems.length) fail('ROLLBACK_FAILED', 'apply 失败且回滚不完整，立即停手', { original: e.message, rollbackProblems });
      fail('APPLY_ROLLED_BACK', `apply 失败，已回滚：${e.message}`, { original: e.code || e.message });
    }
    const artifacts = loadArtifacts(b.project);
    const after = [];
    for (const w of written) {
      const prev = artifacts.artifacts[w.target];
      artifacts.artifacts[w.target] = {
        hash: w.hash, size: fs.statSync(path.join(project.path, w.target)).size,
        version: Number(prev?.version || 0) + 1, updatedAt: nowIso(), commitId, owner: proposal.author,
      };
      after.push({ target: w.target, hash: w.hash, version: artifacts.artifacts[w.target].version });
    }
    saveArtifacts(b.project, artifacts);
    const commit = {
      id: commitId, project: b.project, proposalId: proposal.id, proposalHash: proposal.proposalHash,
      task: proposal.task, risk: proposal.risk, author: proposal.author, appliedBy: b.role,
      log: truncate(String(args.log || proposal.rationale || proposal.title || '文件提交'), 160),
      createdAt: nowIso(), before, after, signatures: loadSignatures(b.project, proposal.id), reviews: loadReviews(b.project, proposal.id),
    };
    saveCommit(b.project, commit);
    proposal.status = 'applied';
    proposal.appliedAt = nowIso();
    proposal.appliedBy = b.role;
    proposal.commitId = commitId;
    saveProposal(b.project, proposal);
    appendEvent({
      role: b.role, sessionId: b.sessionId, action: 'apply', project: b.project, target: proposal.id,
      note: `commit=${commitId} files=${written.length}`, data: { commitId, after, proposalHash: proposal.proposalHash },
    });
    const idx = generateIndex(project, { by: b.role, sessionId: b.sessionId, silent: true });
    out(args, `已提交 ${commitId}\n提案 ${proposal.id}：${written.map((w) => w.target).join(', ')}\n备份：${backupRoot}\n索引已更新（${idx.files} 文件）`, { ok: true, commit, index: idx });
  } finally {
    try { releaseLock(lockKey, { role: b.role }); } catch { /* ignore */ }
  }
}

// ========== 授权 ==========

function parseExpiry(v) {
  if (!v) return new Date(Date.now() + 7 * 86400000).toISOString();
  const s = String(v).trim();
  const m = s.match(/^(\d+)([dhm])$/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : 60000;
    return new Date(Date.now() + n * ms).toISOString();
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) fail('BAD_EXPIRY', `看不懂的过期时间：${v}（用 7d / 12h / ISO）`);
  return new Date(t).toISOString();
}

export function cmdGrant(args) {
  const sub = args._[1] || 'add';
  const b = bootFor(args, 'grant');
  if (sub === 'list') {
    const roles = args.role ? [String(args.role)] : activeRoles(loadTeam());
    const rows = [];
    for (const r of roles) {
      for (const g of loadGrants(r).grants || []) {
        if (g.revokedAt) continue;
        rows.push({ role: r, id: g.id, project: g.project, actions: (g.actions || []).join('/'), scope: (g.scope || []).join(','), expires: String(g.expiresAt).slice(0, 10), reason: g.reason });
      }
    }
    out(args, `授权（${rows.length}）\n` + table(rows, [
      { key: 'role', label: '角色' }, { key: 'id', label: '授权' }, { key: 'project', label: '项目' }, { key: 'actions', label: '动作' }, { key: 'scope', label: '范围' }, { key: 'expires', label: '到期' }, { key: 'reason', label: '理由' },
    ]), { ok: true, grants: rows });
    return;
  }
  if (b.role !== 'pm') fail('NOT_PM', '只有 PM 能授权');
  if (sub === 'revoke') {
    if (!args.id || !args.to) fail('BAD_ARGS', '需要 --to 和 --id');
    const g = revokeGrant(String(args.to), String(args.id), b.role, args.reason || '');
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'grant_revoke', project: g.project, target: g.id, note: `${g.role} ${g.reason}` });
    out(args, `已撤销授权 ${g.id}（${g.role}）`, { ok: true, grant: g });
    return;
  }
  if (!args.to) fail('BAD_ARGS', '需要 --to');
  memberOrFail(loadTeam(), String(args.to));
  const actions = String(args.actions || 'propose').split(',').map((s) => s.trim()).filter(Boolean);
  const scopes = (Array.isArray(args.scope) ? args.scope : String(args.scope || '**').split(',')).map((s) => String(s).trim()).filter(Boolean);
  const project = String(args.project || b.project);
  if (!args.reason) fail('REASON_REQUIRED', '授权必须写 --reason（为什么给、给多久）');
  const grant = addGrant({
    role: String(args.to), actions, scope: scopes, project,
    grantedBy: b.role, expiresAt: parseExpiry(args.expires), reason: String(args.reason),
  });
  appendEvent({
    role: b.role, sessionId: b.sessionId, action: 'grant', project, target: grant.id,
    note: `${grant.role} ${actions.join('/')} ${scopes.join(',')}`, data: { grant },
  });
  notify({
    from: b.role, to: grant.role, subject: `授权 ${grant.id}`,
    body: `${actions.join('/')} @ ${project}：${scopes.join(', ')}\n到期：${grant.expiresAt.slice(0, 10)}\n理由：${grant.reason}`,
    project, ackRequired: true, type: 'grant', sessionId: b.sessionId,
  });
  out(args, `已授权 ${grant.id} → ${grant.role}：${actions.join('/')} @ ${scopes.join(', ')}（到期 ${grant.expiresAt.slice(0, 10)}）`, { ok: true, grant });
}

// ========== 索引 ==========

const INDEX_MANUAL_BEGIN = '<!-- 人工说明:BEGIN -->';
const INDEX_MANUAL_END = '<!-- 人工说明:END -->';

function scanProject(project) {
  const skip = new Set(['node_modules', '.git', '.team', '备份', '_backup', 'dist', 'build', '.cache']);
  const files = [];
  function walk(dir, depth) {
    if (depth > 8 || files.length > 2000) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (files.length > 2000) break;
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skip.has(ent.name)) continue;
        walk(abs, depth + 1);
      } else if (ent.isFile()) {
        const rel = relPath(project.path, abs);
        if (rel === (project.index || '项目索引.md') || rel === '项目索引.json') continue;
        const st = fs.statSync(abs);
        let hash = '';
        if (st.size <= 2 * 1024 * 1024) {
          try { hash = hashFile(abs); } catch { hash = ''; }
        }
        files.push({ target: rel, size: st.size, mtime: st.mtime.toISOString(), hash });
      }
    }
  }
  walk(project.path, 0);
  return files.sort((a, b) => a.target.localeCompare(b.target, 'zh-CN'));
}

function publicCommit(c) {
  const copy = JSON.parse(JSON.stringify(c || {}));
  for (const sig of Object.values(copy.signatures || {})) {
    if (sig && typeof sig === 'object') delete sig.sessionId;
  }
  for (const rv of Object.values(copy.reviews || {})) {
    if (rv && typeof rv === 'object') delete rv.sessionId;
  }
  return copy;
}

function fileKindLabel(abs) {
  const ext = path.extname(abs).toLowerCase();
  return ({
    '.md': 'Markdown', '.markdown': 'Markdown', '.txt': '文本', '.json': 'JSON',
    '.js': 'JavaScript', '.mjs': 'ESM', '.cjs': 'CommonJS', '.ts': 'TypeScript',
    '.py': 'Python', '.html': 'HTML', '.css': 'CSS', '.csv': 'CSV',
    '.png': '图片', '.jpg': '图片', '.jpeg': '图片', '.webp': '图片', '.gif': '图片', '.svg': '矢量图',
    '.mp4': '视频', '.mov': '视频', '.pdf': 'PDF', '.zip': '压缩包', '.docx': 'Word', '.xlsx': 'Excel', '.pptx': 'PPT',
  }[ext] || (ext ? ext.slice(1).toUpperCase() : '文件'));
}

function fileSummary(abs, rel) {
  const ext = path.extname(abs).toLowerCase();
  if (['.md', '.markdown', '.txt'].includes(ext)) {
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8').slice(0, 2400).replace(/^\uFEFF/, ''); } catch { return fileKindLabel(abs); }
    const lines = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const heading = lines.find((x) => /^#{1,4}\s+/.test(x));
    if (heading) return truncate(heading.replace(/^#{1,4}\s+/, '').replace(/[*_`]/g, ''), 72);
    const first = lines.find((x) => !x.startsWith('<!--') && !x.startsWith('>') && !x.startsWith('|---'));
    if (first) return truncate(first.replace(/^[-*]\s+/, '').replace(/[*_`]/g, ''), 72);
    return fileKindLabel(abs);
  }
  if (ext === '.json') {
    try {
      const j = JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, ''));
      const keys = j && typeof j === 'object' ? Object.keys(j).slice(0, 4).join('、') : '';
      return keys ? 'JSON：' + keys : 'JSON 数据';
    } catch { return 'JSON'; }
  }
  return fileKindLabel(abs) + (rel ? '' : '');
}

function fileUpdated(abs) {
  try { return fs.statSync(abs).mtime.toISOString().slice(0, 16).replace('T', ' '); } catch { return ''; }
}

function ownerForRel(rel) {
  const top = String(rel).split(/[\\/]/)[0];
  for (const [role, dir] of Object.entries(ROLE_DIRS)) if (dir === top) return role;
  if (top === '需求') return '需求分析师';
  return 'PM';
}

function reqIdOf(rel) {
  const m = /(R-[0-9A-Za-z-]+)/.exec(path.basename(String(rel)));
  return m ? m[1].replace(/-+$/, '') : path.basename(String(rel), path.extname(String(rel)));
}

function writeRoleIndexes(project) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(project.path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
  for (const name of dirs) {
    const dir = path.join(project.path, name);
    const indexPath = path.join(dir, '文件索引.md');
    if (!exists(indexPath) && !exists(path.join(dir, '角色卡.md')) && !exists(path.join(dir, 'README.md'))) continue;
    const rows = [];
    function walk(p, depth) {
      if (depth > 4 || rows.length >= 80) return;
      for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
        if (rows.length >= 80) break;
        if (ent.name.startsWith('.')) continue;
        const abs = path.join(p, ent.name);
        if (ent.isDirectory()) walk(abs, depth + 1);
        else if (ent.isFile() && ent.name !== '文件索引.md') {
          const st = fs.statSync(abs);
          rows.push({
            target: relPath(dir, abs), summary: fileSummary(abs, relPath(dir, abs)),
            size: st.size, updated: fileUpdated(abs), hash: st.size <= 2 * 1024 * 1024 ? shortHash(hashFile(abs), 10) : '(大文件)',
          });
        }
      }
    }
    walk(dir, 0);
    rows.sort((a, b) => a.target.localeCompare(b.target, 'zh-CN'));
    const lines = [
      `# ${name} · 文件索引（目录）`, '',
      `> 自动更新：${nowIso()}。**这是目录，不是正文。** 按任务只读需要的文件。`,
      '> 由目录负责人维护；每次 apply 后自动重建。', '',
      '| 文件 | 摘要/用途 | 大小 | 更新 | 哈希 |', '|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.target} | ${r.summary.replace(/\|/g, '\\|')} | ${r.size} | ${r.updated} | ${r.hash} |`), '',
    ];
    let text = lines.join('\n');
    if (Buffer.byteLength(text, 'utf8') > 8192) text = text.slice(0, 7800) + '\n\n…（索引超限截断；完整文件请按目录继续阅读）\n';
    writeText(indexPath, text);
    out.push(indexPath);
  }
  return out;
}

export function generateIndex(project, { by = 'system', sessionId = 'system', silent = false } = {}) {
  const files = scanProject(project);
  const artifacts = loadArtifacts(project.name).artifacts || {};
  const tasks = listTasks(project.name);
  const commits = listCommits(project.name).slice(-5).reverse();
  let manual = '';
  const oldPath = projectIndexPath(project);
  if (exists(oldPath)) {
    const old = readText(oldPath, '');
    const m = old.match(/<!-- 人工说明:BEGIN -->([\s\S]*?)<!-- 人工说明:END -->/);
    if (m) manual = m[1].trim();
  }
  const rows = files.map((f) => ({
    target: f.target, size: f.size, mtime: f.mtime, hash: f.hash ? shortHash(f.hash, 10) : '(大文件)',
    owner: artifacts[f.target]?.owner || ownerForRel(f.target), version: artifacts[f.target]?.version || '',
  }));
  const done = tasks.filter((t) => t.status === 'done').length;
  const working = tasks.filter((t) => t.status === 'working').length;
  const open = tasks.filter((t) => t.status === 'open').length;
  const lines = [];
  const byRel = new Map(rows.map((r) => [r.target, r]));
  let selfStat = null;
  try { selfStat = fs.statSync(oldPath); } catch { /* first run */ }
  const selfRow = selfStat ? { target: '项目索引.md', size: selfStat.size, mtime: selfStat.mtime.toISOString(), hash: '', owner: 'pm', version: '' } : null;
  const rel = (p) => p.replace(/\\/g, '/');
  const teamMode = projectTeamMode(project);
  const modeRoles = rolesForMode(teamMode);
  const modeLabel = teamMode === 'fast' ? '四角色' : '六角色';
  const required = [
    ['项目铁律.md', '每轮必读：底线、红线、失败即停', 'PM', '每轮'],
    ['项目信息.md', '项目目标、场景、交付、边界、任务分配', 'PM', '接需求/开工前'],
    ['协作准则.md', `${modeLabel}协同、启动顺序、需求与文件规则`, 'PM', '首次/规则变更'],
    ['项目索引.md', '本目录：必读顺序与文件导航', 'PM', '每轮'],
    ['团队会话.md', `${modeLabel}会话 id / 模型（程序生成，不手改）`, '程序', '建团队/换会话后'],
    ['需求/00-需求总览.md', '需求目录：需求 id → 文件 → 状态', '需求分析师', '接需求前'],
  ];
  const roleDirs = Object.entries(ROLE_DIRS)
    .filter(([role]) => modeRoles.includes(role))
    .map(([role, dir]) => {
      const fs0 = rows.filter((r) => r.target.startsWith(dir + '/'));
      return { role, dir, count: fs0.length, index: `${dir}/文件索引.md`, name: ROLE_NAMES[role] || role };
    });
  const reqRows = rows.filter((r) => r.target.startsWith('需求/') && !['需求/00-需求总览.md', '需求/需求模板.md', '需求/README.md', '需求/文件索引.md'].includes(r.target));
  const reqOverview = byRel.get('需求/00-需求总览.md');
  const sizeOf = (r) => r ? `${r.size} B` : '—';
  const updateOf = (r) => r ? String(r.mtime).slice(0, 16).replace('T', ' ') : '—';
  const verOf = (r) => r ? (r.version ? `v${r.version}` : '已登记') : '缺文件';
  const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

  lines.push(`# ${project.name} · 项目索引（目录）`);
  lines.push('');
  lines.push(`> 自动生成：${nowIso()} ｜ 由 \`team.mjs index\` 维护，**这是目录，不是项目介绍或需求正文**。`);
  lines.push(`> 团队模式：${TEAM_MODE_LABELS[teamMode]}（${teamModeDescription(teamMode)}）。`);
  lines.push('> 先读顺序：**项目铁律 → 项目信息 → 本索引 → 角色卡/文件索引 → 任务指定文件**。');
  lines.push('');
  lines.push(INDEX_MANUAL_BEGIN);
  lines.push(manual || '- （PM 临时说明；index 会保留这段，不要在这里写长需求）');
  lines.push(INDEX_MANUAL_END);
  lines.push('');
  lines.push('## 一、必读文件（按顺序）');
  lines.push('');
  lines.push('| 顺序 | 文件 | 作用 | 维护人 | 何时读 | 更新 | 大小 | 状态 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  const requiredVisible = required.filter(([target]) => target !== '团队会话.md' || byRel.has(target));
  requiredVisible.forEach(([target, purpose, owner, when], i) => {
    const r = byRel.get(target) || (target === '项目索引.md' ? selfRow : null);
    lines.push(`| ${i + 1} | [${target}](${rel(target)}) | ${cell(purpose)} | ${owner} | ${when} | ${updateOf(r)} | ${sizeOf(r)} | ${verOf(r)} |`);
  });
  lines.push('');
  lines.push('## 二、目录导航（先看这里再翻文件）');
  lines.push('');
  lines.push('| 目录 | 负责人 | 文件数 | 目录索引 | 什么时候读 |');
  lines.push('|---|---|---|---|---|');
  lines.push(`| [需求/](需求/) | 需求分析师 / PM | ${rows.filter((r) => r.target.startsWith('需求/')).length} | [需求/文件索引.md](需求/文件索引.md) | 接需求、验收、变更 |`);
  for (const d of roleDirs) {
    lines.push(`| [${d.dir}/](${rel(d.dir)}/) | ${d.name} | ${d.count} | [${d.index}](${rel(d.index)}) | 只读任务涉及的文件 |`);
  }
  lines.push('');
  lines.push('## 三、需求目录');
  lines.push('');
  if (!reqOverview) {
    lines.push('（缺少 `需求/00-需求总览.md`；PM 先创建需求目录入口。）');
  } else {
    lines.push('| 需求 id | 文件 | 摘要 | 状态 | 更新 |');
    lines.push('|---|---|---|---|---|');
    for (const r of reqRows.slice(0, 40)) {
      lines.push(`| ${reqIdOf(r.target)} | [${path.basename(r.target)}](${rel(r.target)}) | ${cell(fileSummary(path.join(project.path, r.target), r.target))} | ${verOf(r)} | ${updateOf(r)} |`);
    }
    if (!reqRows.length) lines.push('| — | [00-需求总览.md](需求/00-需求总览.md) | 暂无需求；新需求复制 需求/需求模板.md，另存为 R-...md | 目录 |  |');
  }
  lines.push('');
  lines.push('## 四、当前任务（详情看看板）');
  lines.push('');
  lines.push(`进行中 **${working}** ｜ 待接 **${open}** ｜ 完成 **${done}**`);
  const openTasks = tasks.filter((x) => x.status !== 'done').slice(0, 8);
  if (!openTasks.length) lines.push('（无进行中任务）');
  for (const t of openTasks) lines.push(`- [${t.priority}] ${t.id} ${t.status} ${t.owner || '-'} — ${t.title}`);
  lines.push('');
  lines.push('## 五、最近提交');
  lines.push('');
  if (!commits.length) lines.push('（暂无）');
  for (const c of commits) lines.push(`- ${c.id} ｜ ${String(c.createdAt).slice(0, 19).replace('T', ' ')} ｜ ${c.proposalId} ｜ ${c.after.map((a) => a.target).join(', ')}`);
  lines.push('');
  lines.push('## 六、避雷铁律（每轮必读）');
  lines.push('');
  lines.push('- 每轮先读《项目铁律.md》，再读项目信息/本索引/角色卡；不要凭上一轮记忆开工。');
  lines.push('- 只读任务需要的文件；不要每轮把 `需求/`、角色目录全量读一遍。');
  lines.push('- 一个需求一个 `R-...md`；新需求新建，澄清更新原文件；单文件 ≤ 16KB，超了拆分。');
  lines.push('- 写文件只走 `propose → review → sign → apply`；不直接改目标文件。');
  lines.push('- 没有回执 = 没发生；没有签字 = 没批准；没有 CAS = 不算提交。');
  lines.push('- 只写授权目录，不碰别人文件；密钥/账号/私密内容只记路径。');
  lines.push('- 文件变更多、目录变长时，PM 必须重跑 `team.mjs index`，保持本目录实时。');
  lines.push('');
  lines.push('## 七、维护规则');
  lines.push('');
  lines.push('- 本文件是**目录**：不放需求正文、不放长篇项目介绍；项目介绍在 `项目信息.md`。');
  lines.push('- 每次 apply 自动重建；PM 也可以在内容变更后手工跑 `node 团队\\工具\\team.mjs index --project "' + project.name + '"`。');
  lines.push(`- 文件明细索引：${roleDirs.map((d) => `\`${d.index}\``).join('、')}；需求总览：\`需求/00-需求总览.md\`。`);
  lines.push(`- 索引 JSON：\`${path.join(project.path, '项目索引.json')}\``);
  lines.push('');
  let text = lines.join('\n');
  if (Buffer.byteLength(text, 'utf8') > 16384) text = text.slice(0, 15800) + '\n\n…（根索引超过 16KB 截断；详细文件见各目录《文件索引.md》）\n';
  writeText(oldPath, text);
  writeJson(path.join(project.path, '项目索引.json'), {
    project: project.name, generatedAt: nowIso(), files, tasks: { working, open, done },
    commits: commits.map(publicCommit),
    required: required.map(([target, purpose, owner, when]) => ({ target, purpose, owner, when })),
    roleDirs, requirements: reqRows.map((r) => ({ id: reqIdOf(r.target), target: r.target })),
  });
  const roleIndexes = writeRoleIndexes(project);
  appendEvent({ role: by, sessionId, action: 'index', project: project.name, target: '项目索引.md', note: `files=${files.length} roleIndexes=${roleIndexes.length}`, data: { files: files.length, roleIndexes: roleIndexes.length } });
  if (!silent) textOut(`索引已生成：${oldPath}（${files.length} 文件，${roleIndexes.length} 份目录索引）`);
  return { path: oldPath, files: files.length, rows: rows.length, roleIndexes: roleIndexes.length, requirements: reqRows.length };
}

export function cmdIndex(args) {
  const team = loadTeam();
  const name = String(args.project || team.activeProject || '');
  if (!name) fail('NO_PROJECT', '需要 --project');
  const project = loadProject(name);
  const r = generateIndex(project, { by: args.role || 'system', sessionId: sessionOf(args), silent: false });
  if (args.json) jsonOut({ ok: true, ...r });
}

// ========== 状态 / 对账 / 验证 ==========

function checkDrift(project) {
  const artifacts = loadArtifacts(project.name).artifacts || {};
  const problems = [];
  for (const [rel, a] of Object.entries(artifacts)) {
    const abs = path.join(project.path, rel);
    if (!exists(abs)) { problems.push({ type: 'MISSING', target: rel, expected: a.hash }); continue; }
    const h = hashFile(abs);
    if (h !== a.hash) problems.push({ type: 'DRIFT', target: rel, expected: a.hash, current: h });
  }
  return problems;
}

function pilotCheckData(team) {
  const rawReceipts = loadReceipts().filter((r) => !r.update && r.msgId);
  const receipts = [...new Map(rawReceipts.map((r) => [`${r.msgId}|${r.from}`, r])).values()];
  const projects = listProjects();
  const commits = projects.flatMap((p) => listCommits(p.name));
  const { items: events } = readEventsStrict();
  const stale = events.filter((e) => e.action === 'apply' && e.result === 'STALE_BASE').length;
  const lockBusy = events.filter((e) => e.action === 'lock' && e.result === 'LOCK_BUSY').length;
  const verify = verifyAll();
  const checks = [
    { id: 'receipt', label: '消息回执', ok: receipts.length > 0, detail: `${receipts.length} 条回执` },
    { id: 'proposal', label: '提案闭环（评审+签字+提交）', ok: commits.length > 0, detail: `${commits.length} 次提交` },
    { id: 'stale', label: '陈旧版本被拒（STALE_BASE）', ok: stale > 0, detail: `${stale} 次拒绝` },
    { id: 'lock', label: '锁争用被拒（LOCK_BUSY）', ok: lockBusy > 0, detail: `${lockBusy} 次拒绝` },
    { id: 'verify', label: 'verify 全绿', ok: verify.ok, detail: verify.problems.length ? `${verify.problems.length} 个问题` : '无问题' },
  ];
  return { pass: checks.every((c) => c.ok), checks, team };
}

function renderStatus(team) {
  const projects = listProjects();
  const active = team.activeProject;
  const project = active ? projects.find((p) => p.name === active) : null;
  const tasks = project ? listTasks(project.name) : [];
  const proposals = project ? listProposals(project.name) : [];
  const commits = project ? listCommits(project.name) : [];
  const locks = listLocks();
  const { items: events } = readEventsStrict();
  const pilot = pilotCheckData(team);
  const lines = [];
  lines.push('# 团队看板');
  lines.push('');
  lines.push(`- 更新时间：${nowIso()}`);
  lines.push(`- 阶段：**${team.phase}** ｜ 当前项目：**${active || '未设置'}** ｜ Owner：${team.owner}`);
  lines.push(`- 成员：${activeMembers(team).map((m) => `${m.name}(${m.role})`).join('、')}`);
  lines.push('');
  lines.push('## 一、消息');
  for (const m of activeMembers(team)) lines.push(`- ${m.role} 未读：${unreadCount(m.role, team.activeProject || '')}`);
  lines.push('');
  lines.push('## 二、任务');
  if (!tasks.length) lines.push('（无）');
  for (const t of tasks.filter((x) => x.status !== 'done').slice(0, 20)) lines.push(`- [${t.priority}] ${t.id} ${t.status} ${t.owner || '-'} — ${t.title}`);
  lines.push('');
  lines.push('## 三、提案');
  if (!proposals.length) lines.push('（无）');
  for (const p of proposals.filter((x) => !['applied', 'rejected'].includes(x.status)).slice(0, 20)) lines.push(`- ${p.id} ${p.risk} ${p.status} by ${p.author} — ${p.title}`);
  lines.push('');
  lines.push('## 四、锁');
  if (!locks.length) lines.push('（无）');
  for (const l of locks) lines.push(`- ${l.key} @ ${l.role || l.owner} ${l.stale ? '(stale)' : ''} 到期 ${String(l.expiresAt).slice(11, 19)}`);
  lines.push('');
  lines.push('## 五、试点门槛');
  for (const c of pilot.checks) lines.push(`- ${c.ok ? '✅' : '❌'} ${c.label}：${c.detail}`);
  lines.push(`- 结论：${pilot.pass ? '**通过，可以加人**' : '未通过，先补齐'}`);
  lines.push('');
  lines.push('## 六、最近事件');
  for (const e of events.slice(-10).reverse()) lines.push(`- ${hhmmss(e.ts)} [${e.role}] ${e.action} ${e.target} ${e.result !== 'ok' ? '(' + e.result + ')' : ''} — ${e.note}`);
  lines.push('');
  return { text: lines.join('\n'), data: { team, project, tasks, proposals, commits, locks, pilot, events: events.slice(-20) } };
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function boardData(team, selectedName = '') {
  const projects = listProjects();
  const active = (selectedName ? projects.find((p) => p.name === selectedName) : null)
    || (team.activeProject ? projects.find((p) => p.name === team.activeProject) : null)
    || projects[0] || null;
  const projectName = active?.name || '';
  const project = active || null;
  const tasks = project ? listTasks(projectName) : [];
  const proposals = project ? listProposals(projectName) : [];
  const commits = (project ? listCommits(projectName) : []).map((c) => {
    let rationale = '';
    try { rationale = c.proposalId ? (loadProposal(projectName, c.proposalId)?.rationale || '') : ''; } catch { /* old commit */ }
    return { ...publicCommit(c), log: c.log || rationale || '文件提交' };
  });
  const receiptRows = loadReceipts().filter((r) => !r.update && r.msgId && (!projectName || !r.project || r.project === projectName));
  const receipts = [...new Map(receiptRows.map((r) => [`${r.msgId}|${r.from}`, r])).values()];
  const reviewsByProposal = {};
  for (const p of proposals) reviewsByProposal[p.id] = loadReviews(projectName, p.id);
  const sigsByProposal = {};
  for (const p of proposals) sigsByProposal[p.id] = loadSignatures(projectName, p.id);
  let files = [];
  if (project) {
    const idx = path.join(project.path, '项目索引.json');
    if (exists(idx)) {
      try { files = readJson(idx).files || []; } catch { files = []; }
    }
    if (!files.length) files = scanProject(project);
  }
  const { items: events } = readEventsStrict();
  const staleIds = new Set(events.filter((e) => e.action === 'apply' && e.result === 'STALE_BASE').map((e) => e.target));
  const proposalsView = proposals.map((p) => (staleIds.has(p.id) && p.status === 'approved' ? { ...p, status: 'stale' } : p));
  const artifacts = project ? (loadArtifacts(projectName).artifacts || {}) : {};
  files = files.map((f) => ({
    ...f, owner: artifacts[f.target]?.owner || f.owner || '', version: artifacts[f.target]?.version || '',
    abs: project ? path.join(project.path, f.target) : f.target,
  }));
  const requirementRows = tasks.filter((t) => t.type === 'requirement').map((r) => {
    const kids = tasks.filter((t) => t.requirementId === r.id);
    const done = kids.filter((k) => k.status === 'done').length;
    const working = kids.filter((k) => k.status === 'working').length;
    return { ...r, kids, kidsDone: done, kidsTotal: kids.length, derivedStatus: kids.length ? (done === kids.length ? 'done' : working ? 'working' : 'open') : r.status };
  });
  const memberStats = {};
  for (const m of activeMembers(team)) memberStats[m.role] = { role: m.role, name: m.name, session: m.sessionId ? '当前工作区' : '', sent: 0, reviews: 0, signs: 0, commits: 0, acks: 0 };
  for (const e of events) {
    if (memberStats[e.role]) {
      if (e.action === 'message') memberStats[e.role].sent++;
      if (e.action === 'review') memberStats[e.role].reviews++;
      if (e.action === 'sign') memberStats[e.role].signs++;
      if (e.action === 'apply') memberStats[e.role].commits++;
      if (e.action === 'ack') memberStats[e.role].acks++;
    }
  }
  const pilot = pilotCheckData(team);
  const logs = [
    ...commits.map((c) => ({
      ts: c.createdAt, actor: c.appliedBy || c.author || 'pm', kind: '提交',
      text: c.log || c.proposalId || '提交', target: c.id,
    })),
    ...receipts.map((r) => ({
      ts: r.ts, actor: r.from, kind: '回执',
      text: r.log || r.note || r.msgId || '回执', target: r.msgId,
    })),
  ].sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 120);
  return {
    generatedAt: nowIso(),
    team: { phase: team.phase, owner: team.owner, activeProject: team.activeProject },
    projects: projects.map((p) => ({ name: p.name, path: p.path, current: p.name === team.activeProject, selected: p.name === projectName, dshWorkspaceId: p.dshWorkspaceId || '' })),
    selectedProject: projectName,
    project, tasks, proposals: proposalsView, commits, receipts,
    reviews: reviewsByProposal, signatures: sigsByProposal, files,
    locks: listLocks(), events: [], members: Object.values(memberStats), pilot,
    requirements: requirementRows,
    childTasks: tasks.filter((t) => t.type !== 'requirement'),
    logs,
  };
}

function renderBoardMd(d) {
  const lines = [];
  const req = d.requirements;
  const openTasks = d.childTasks.filter((t) => t.status !== 'done');
  lines.push(`# 团队看板 · ${d.project?.name || '（未选项目）'}`);
  lines.push('');
  lines.push(`> 生成 ${d.generatedAt} ｜ 阶段 ${d.team.phase} ｜ Owner ${d.team.owner} ｜ 成员 ${d.members.length}`);
  lines.push('');
  lines.push('## 一、需求看板');
  lines.push('');
  if (!req.length) lines.push('（暂无需求；用 `req create` 建）');
  else {
    lines.push('| 优先级 | 需求 | 状态 | Owner | 子任务 | 验收标准 |');
    lines.push('|---|---|---|---|---|---|');
    for (const r of req) {
      lines.push(`| ${r.priority} | ${r.id} ${r.title} | ${r.derivedStatus || r.status} | ${r.owner || '-'} | ${r.kidsDone ?? 0}/${r.kidsTotal ?? 0} | ${truncate(r.acceptance || '', 80)} |`);
    }
  }
  lines.push('');
  lines.push('## 二、任务');
  lines.push('');
  if (!openTasks.length) lines.push('（无进行中任务）');
  else {
    lines.push('| 优先级 | 任务 | 状态 | Owner | 需求 | 标题 |');
    lines.push('|---|---|---|---|---|---|');
    for (const t of openTasks.slice(0, 40)) lines.push(`| ${t.priority} | ${t.id} | ${t.status} | ${t.owner || '-'} | ${t.requirementId || '-'} | ${t.title} |`);
  }
  lines.push('');
  lines.push('## 三、提案 · 评审 · 签字');
  lines.push('');
  if (!d.proposals.length) lines.push('（暂无提案）');
  else {
    lines.push('| 提案 | 风险 | 状态 | 作者 | 评审 | 签字 | 提交 |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const p of d.proposals.slice(-40)) {
      const rv = Object.entries(d.reviews[p.id] || {}).map(([r, v]) => `${r}:${v.verdict}`).join(' ');
      const sg = Object.entries(d.signatures[p.id] || {}).map(([r, v]) => `${r}:${v.decision}`).join(' ');
      lines.push(`| ${p.id} ${truncate(p.title, 30)} | ${p.risk} | ${p.status} | ${p.author} | ${rv || '-'} | ${sg || '-'} | ${p.commitId || '-'} |`);
    }
  }
  lines.push('');
  lines.push('## 四、回执（最近 30 条）');
  lines.push('');
  if (!d.receipts.length) lines.push('（暂无回执）');
  else {
    lines.push('| 时间 | 回执人 | 项目 | 消息 | 备注 |');
    lines.push('|---|---|---|---|---|');
    for (const r of d.receipts.filter((x) => !x.update).slice(-30).reverse()) lines.push(`| ${r.ts.slice(0, 19).replace('T', ' ')} | ${r.from} | ${r.project || '-'} | ${r.msgId} | ${truncate(r.note, 60)} |`);
  }
  lines.push('');
  lines.push('## 五、项目文件');
  lines.push('');
  if (!d.files.length) lines.push('（暂无索引；先 `index`）');
  else {
    lines.push('| 文件 | 大小 | 哈希 | 归属 |');
    lines.push('|---|---|---|---|');
    for (const f of d.files.slice(0, 200)) lines.push(`| ${f.target} | ${f.size} | ${shortHash(f.hash || '', 10)} | ${f.owner || ''} |`);
  }
  lines.push('');
  lines.push('## 六、成员');
  lines.push('');
  lines.push('| 角色 | 名称 | 会话 | 发消息 | 评审 | 签字 | 提交 | 回执 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const m of d.members) lines.push(`| ${m.role} | ${m.name} | ${m.session || '-'} | ${m.sent} | ${m.reviews} | ${m.signs} | ${m.commits} | ${m.acks} |`);
  lines.push('');
  lines.push('## 七、试点门槛');
  for (const c of d.pilot.checks) lines.push(`- ${c.ok ? '✅' : '❌'} ${c.label}：${c.detail}`);
  lines.push(`- 结论：${d.pilot.pass ? '**PASS**' : '**FAIL**'}`);
  lines.push('');
  return lines.join('\n');
}

function renderBoardHtml(d) {
  const rowsReq = d.requirements.map((r) => {
    return `<tr><td><span class="pill p-${escHtml(r.priority)}">${escHtml(r.priority)}</span></td><td><b>${escHtml(r.id)}</b><br>${escHtml(r.title)}</td><td>${escHtml(r.derivedStatus || r.status)}</td><td>${escHtml(r.owner || '-')}</td><td>${r.kidsDone ?? 0}/${r.kidsTotal ?? 0}</td><td class="muted">${escHtml(truncate(r.acceptance || '', 140))}</td></tr>`;
  }).join('');
  const rowsTask = d.childTasks.filter((t) => t.status !== 'done').map((t) => `<tr><td><span class="pill p-${escHtml(t.priority)}">${escHtml(t.priority)}</span></td><td><b>${escHtml(t.id)}</b> ${escHtml(t.title)}</td><td>${escHtml(t.status)}</td><td>${escHtml(t.owner || '-')}</td><td>${escHtml(t.requirementId || '-')}</td></tr>`).join('');
  const rowsProp = d.proposals.slice(-40).reverse().map((p) => {
    const rv = Object.entries(d.reviews[p.id] || {}).map(([r, v]) => `<span class="tag ${v.verdict}">${escHtml(r)}:${escHtml(v.verdict)}</span>`).join(' ');
    const sg = Object.entries(d.signatures[p.id] || {}).map(([r, v]) => `<span class="tag ${v.decision}">${escHtml(r)}:${escHtml(v.decision)}</span>`).join(' ');
    return `<tr><td><b>${escHtml(p.id)}</b><br><span class="muted">${escHtml(truncate(p.title, 40))}</span></td><td>${escHtml(p.risk)}</td><td>${escHtml(p.status)}</td><td>${escHtml(p.author)}</td><td>${rv || '<span class="muted">-</span>'}</td><td>${sg || '<span class="muted">-</span>'}</td><td>${escHtml(p.commitId || '-')}</td></tr>`;
  }).join('');
  const rowsAck = d.receipts.filter((x) => !x.update).slice(-30).reverse().map((r) => `<tr><td class="muted">${escHtml(String(r.ts).slice(0, 19).replace('T', ' '))}</td><td>${escHtml(r.from)}</td><td>${escHtml(r.project || '-')}</td><td>${escHtml(r.msgId)}</td><td>${escHtml(truncate(r.note, 100))}</td></tr>`).join('');
  const rowsFile = d.files.slice(0, 300).map((f) => {
    const abs = d.project ? path.join(d.project.path, f.target) : f.target;
    return `<tr><td><a href="file:///${escHtml(abs.replace(/\\/g, '/'))}">${escHtml(f.target)}</a></td><td>${f.size}</td><td class="mono">${escHtml(shortHash(f.hash || '', 12))}</td><td>${escHtml(f.owner || '')}</td></tr>`;
  }).join('');
  const rowsMem = d.members.map((m) => `<tr><td><b>${escHtml(m.role)}</b><br><span class="muted">${escHtml(m.name)}</span></td><td class="mono">${escHtml(m.session || '-')}</td><td>${m.sent}</td><td>${m.reviews}</td><td>${m.signs}</td><td>${m.commits}</td><td>${m.acks}</td></tr>`).join('');
  const pilot = d.pilot.checks.map((c) => `<li>${c.ok ? '✅' : '❌'} <b>${escHtml(c.label)}</b>：${escHtml(c.detail)}</li>`).join('');
  const json = JSON.stringify(d).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>团队看板 · ${escHtml(d.project?.name || '')}</title>
<style>
:root{--bg:#0b0e14;--panel:#121722;--line:#243044;--text:#e6edf7;--muted:#8b9bb4;--accent:#5aa9ff;--ok:#3fb950;--warn:#d29922;--bad:#f85149}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif}
header{padding:22px 28px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:flex-end;gap:20px;flex-wrap:wrap}
h1{margin:0;font-size:22px}h2{font-size:16px;margin:0 0 10px;color:#cfe0f7} .muted{color:var(--muted)} .mono{font-family:Consolas,monospace;font-size:12px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;padding:18px 28px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px}.card b{display:block;font-size:26px;color:var(--accent)}
section{margin:0 28px 22px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;position:sticky;top:0;background:var(--panel)}tr:hover td{background:#172033}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:700}.p-P0{background:#5a1d1d;color:#ffb4b4}.p-P1{background:#4a3a12;color:#ffd48a}.p-P2{background:#12324a;color:#9fd0ff}.p-P3{background:#243044;color:#b8c6dc}
.tag{display:inline-block;padding:1px 7px;border-radius:6px;font-size:12px;margin:1px}.tag.approve{background:#12351d;color:#7ee2a0}.tag.reject{background:#4a1717;color:#ff9a9a}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
ul{margin:0;padding-left:20px}
footer{padding:0 28px 28px;color:var(--muted);font-size:12px}
body{padding-top:42px}
.board-chrome{position:fixed;left:0;right:0;top:0;height:38px;z-index:1000;display:flex;align-items:center;justify-content:space-between;padding:0 8px 0 14px;background:rgba(10,16,27,.86);border-bottom:1px solid var(--line);backdrop-filter:blur(10px);-webkit-app-region:drag}
.board-drag{display:flex;gap:12px;align-items:center;font-size:12px}.board-drag span{color:var(--muted);font-size:11px}
.board-actions{display:flex;gap:4px;-webkit-app-region:no-drag}.board-actions button{width:28px;height:25px;border:1px solid var(--line);border-radius:6px;background:#162033;color:var(--text);cursor:pointer;font:13px/1 sans-serif}.board-actions button:hover{background:#22314d}
body.collapsed .board-content{display:none}
</style></head><body>
<div class="board-chrome"><div class="board-drag"><b>👥 团队看板</b><span>可拖动 / 缩放 / 半透明悬浮</span></div><div class="board-actions"><button data-win="collapse" title="收纳成标题条">—</button><button data-win="zoom-out" title="缩小">－</button><button data-win="zoom-in" title="放大">＋</button><button data-win="maximize" title="最大化/还原">⛶</button><button data-win="close" title="关闭">×</button></div></div>
<div class="board-content">
<header><div><h1>团队看板 · ${escHtml(d.project?.name || '未选项目')}</h1><div class="muted">阶段 ${escHtml(d.team.phase)} ｜ Owner ${escHtml(d.team.owner)} ｜ 生成 ${escHtml(d.generatedAt)}</div></div><div class="muted">先读索引，再找文件 ｜ 中文思考 ｜ 签字绑定哈希</div></header>
<div class="cards">
<div class="card"><span class="muted">需求</span><b>${d.requirements.length}</b></div>
<div class="card"><span class="muted">进行中任务</span><b>${d.childTasks.filter((t) => t.status !== 'done').length}</b></div>
<div class="card"><span class="muted">提案</span><b>${d.proposals.length}</b></div>
<div class="card"><span class="muted">回执</span><b>${d.receipts.filter((x) => !x.update).length}</b></div>
<div class="card"><span class="muted">项目文件</span><b>${d.files.length}</b></div>
<div class="card"><span class="muted">成员</span><b>${d.members.length}</b></div>
</div>
<section><h2>一、需求看板</h2><table><thead><tr><th>优先级</th><th>需求</th><th>状态</th><th>Owner</th><th>子任务</th><th>验收标准</th></tr></thead><tbody>${rowsReq || '<tr><td colspan="6" class="muted">暂无需求；用 req create 建</td></tr>'}</tbody></table></section>
<section><h2>二、进行中任务</h2><table><thead><tr><th>优先级</th><th>任务</th><th>状态</th><th>Owner</th><th>需求</th></tr></thead><tbody>${rowsTask || '<tr><td colspan="5" class="muted">无</td></tr>'}</tbody></table></section>
<section><h2>三、提案 · 评审 · 签字</h2><table><thead><tr><th>提案</th><th>风险</th><th>状态</th><th>作者</th><th>评审</th><th>签字</th><th>提交</th></tr></thead><tbody>${rowsProp || '<tr><td colspan="7" class="muted">暂无提案</td></tr>'}</tbody></table></section>
<section><h2>四、回执（最近 30 条）</h2><table><thead><tr><th>时间</th><th>回执人</th><th>项目</th><th>消息</th><th>备注</th></tr></thead><tbody>${rowsAck || '<tr><td colspan="5" class="muted">暂无回执</td></tr>'}</tbody></table></section>
<section><h2>五、项目文件</h2><table><thead><tr><th>文件</th><th>大小</th><th>哈希</th><th>归属</th></tr></thead><tbody>${rowsFile || '<tr><td colspan="4" class="muted">暂无索引；先 index</td></tr>'}</tbody></table></section>
<section><h2>六、成员</h2><table><thead><tr><th>角色</th><th>会话</th><th>发消息</th><th>评审</th><th>签字</th><th>提交</th><th>回执</th></tr></thead><tbody>${rowsMem}</tbody></table></section>
<section><h2>七、试点门槛</h2><ul>${pilot}</ul></section>
<footer>数据源：团队\\状态\\看板.json ｜ 重新生成：node 团队\\工具\\team.mjs board</footer>
</div>
<script id="team-data" type="application/json">${json}</script>
<script>
(() => {
  const collapse = document.querySelector('[data-win="collapse"]');
  if (collapse) collapse.addEventListener('click', async () => {
    const c = document.body.classList.toggle('collapsed');
    collapse.textContent = c ? '＋' : '—';
    if (window.boardWin) await window.boardWin.control(c ? 'collapse' : 'expand');
  });
  for (const b of document.querySelectorAll('[data-win]:not([data-win="collapse"])')) {
    b.addEventListener('click', () => {
      const action = b.getAttribute('data-win');
      if (window.boardWin) window.boardWin.control(action);
      else if (action === 'close') window.close();
    });
  }
})();
</script>
</body></html>`;
}

export function cmdBoard(args) {
  const team = loadTeam();
  const selected = String(args.project || team.activeProject || '');
  const d = boardData(team, selected);
  const md = renderBoardMdV2(d);
  const html = renderBoardHtmlV2(d);
  const outDir = PATHS.teamRoot;
  writeText(path.join(outDir, '看板.md'), md);
  writeText(path.join(outDir, '看板.html'), html);
  writeJson(path.join(outDir, '状态', '看板.json'), d);
  writeText(PATHS.dashboard, md);
  if (args.json) jsonOut({ ok: true, generatedAt: d.generatedAt, files: [path.join(outDir, '看板.md'), path.join(outDir, '看板.html')], summary: { requirements: d.requirements.length, tasks: d.childTasks.length, proposals: d.proposals.length, receipts: d.receipts.filter((x) => !x.update).length } });
  else textOut(`看板已生成：\n- ${path.join(outDir, '看板.md')}\n- ${path.join(outDir, '看板.html')}\n需求 ${d.requirements.length} ｜ 任务 ${d.childTasks.length} ｜ 提案 ${d.proposals.length} ｜ 回执 ${d.receipts.filter((x) => !x.update).length} ｜ 文件 ${d.files.length}`);
}

export function cmdStatus(args) {
  const team = loadTeam();
  const { text, data } = renderStatus(team);
  writeText(PATHS.dashboard, text);
  if (args.json) jsonOut({ ok: true, ...data, dashboard: PATHS.dashboard });
  else textOut(text);
}

export function cmdReconcile(args) {
  const team = loadTeam();
  const rows = [];
  const issues = [];
  const add = (area, metric, expected, actual, ok, evidence = '') => {
    rows.push({ area, metric, expected, actual, result: ok ? 'PASS' : 'FAIL', evidence });
    if (!ok) issues.push({ area, metric, expected, actual, evidence });
  };
  const chain = verifyEventChain();
  add('事件链', 'seq/prev/hash', '连续且 hash 匹配', `${chain.count} 条 / ${chain.problems.length} 问题`, chain.ok, chain.ok ? 'verifyEventChain' : JSON.stringify(chain.problems.slice(0, 3)));
  const locks = listLocks();
  const staleLocks = locks.filter((l) => l.stale);
  for (const l of staleLocks) {
    try { fs.rmSync(l.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  add('锁', '未过期锁数', '0 stale', `${staleLocks.length} stale / ${locks.length} total`, staleLocks.length === 0, staleLocks.map((l) => l.key).join(','));
  const projects = listProjects();
  const staleIds = new Set(readEventsStrict().items.filter((e) => e.action === 'apply' && e.result === 'STALE_BASE').map((e) => e.target));
  const activeProject = team.activeProject ? projects.find((p) => p.name === team.activeProject) : null;
  for (const p of projects) {
    const tasks = listTasks(p.name);
    const overdue = tasks.filter((t) => t.status !== 'done' && t.due && Date.parse(t.due) < Date.now());
    add('任务', `${p.name} 逾期`, '0', String(overdue.length), overdue.length === 0, overdue.slice(0, 3).map((t) => t.id).join(','));
    const maxAge = Number(team.config.proposalStaleHours || 24) * 3600000;
    const staleProps = listProposals(p.name).filter((pr) => !['applied', 'rejected', 'stale'].includes(pr.status) && !staleIds.has(pr.id) && Date.now() - Date.parse(pr.createdAt) > maxAge);
    add('提案', `${p.name} 超时未闭环`, '0', String(staleProps.length), staleProps.length === 0, staleProps.slice(0, 3).map((x) => x.id).join(','));
    const drift = checkDrift(p);
    add('文件', `${p.name} 哈希漂移`, '0', String(drift.length), drift.length === 0, drift.slice(0, 3).map((x) => x.target).join(','));
    const commits = listCommits(p.name);
    add('提交', `${p.name} 提交数`, '≥0', String(commits.length), true, commits.slice(-1).map((c) => c.id).join(','));
  }
  const receipts = loadReceipts().filter((x) => !x.update);
  add('回执', '回执条数', '≥1（pilot）', String(receipts.length), receipts.length > 0, receipts.slice(-1).map((r) => r.id).join(','));
  for (const m of activeMembers(team)) {
    const expired = (loadGrants(m.role).grants || []).filter((g) => !g.revokedAt && g.expiresAt && Date.parse(g.expiresAt) < Date.now());
    add('授权', `${m.role} 过期授权`, '0', String(expired.length), expired.length === 0, expired.slice(0, 3).map((g) => g.id).join(','));
  }
  const verify = verifyAll();
  add('总体', 'verify', 'PASS', verify.ok ? 'PASS' : `FAIL(${verify.problems.length})`, verify.ok, verify.problems.slice(0, 3).map((x) => x.type).join(','));
  const ackNote = String(args['ack-note'] || '');
  if (ackNote.length > Number(team.config.ackNoteMaxChars || 300)) fail('RECEIPT_TOO_LONG', `对账回执超过 ${team.config.ackNoteMaxChars} 字`);
  const now = nowIso();
  const lines = [];
  lines.push(`# 对账 · ${now.slice(0, 19).replace('T', ' ')}`);
  lines.push('');
  lines.push('| 项目 | 指标 | 期望 | 实测 | 结果 | 证据 |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of rows) lines.push(`| ${r.area} | ${r.metric} | ${r.expected} | ${r.actual} | ${r.result} | ${truncate(r.evidence, 120)} |`);
  lines.push('');
  lines.push('## 对账回执');
  lines.push('');
  const reviewer = activeRoles(team).includes('tester') ? 'tester' : 'pm（代，tester 未入队）';
  lines.push(`- 对账人：pm ｜ 复核人：${reviewer} ｜ 结论：${issues.length ? '有异常，停手处理' : '无异常，通过'}`);
  lines.push(`- 备注：${truncate(ackNote || '（无）', Number(team.config.ackNoteMaxChars || 300))}`);
  lines.push(`- 回执大小：${ackNote.length}/${team.config.ackNoteMaxChars} 字 ｜ 报告上限：${team.config.reconcileReportMaxKB}KB`);
  lines.push('');
  let md = lines.join('\n');
  const maxBytes = Number(team.config.reconcileReportMaxKB || 8) * 1024;
  if (Buffer.byteLength(md, 'utf8') > maxBytes) {
    md = md.slice(0, Math.floor(maxBytes / 3)) + '\n\n…（报告超限截断；完整数据见 对账.json）\n';
  }
  const outFile = activeProject ? path.join(projectStatePaths(activeProject.name).dir, '对账.md') : path.join(PATHS.state, '对账.md');
  writeText(outFile, md);
  if (activeProject) writeJson(projectStatePaths(activeProject.name).reconcile, { updatedAt: now, rows, issues });
  appendEvent({ role: 'system', sessionId: 'reconcile', action: 'reconcile', project: activeProject?.name || '', target: '对账.md', note: `issues=${issues.length} pass=${rows.filter((r) => r.result === 'PASS').length}/${rows.length}`, data: { issues, rows } });
  if (issues.length && args.notify !== false) {
    try {
      sendMessage({ from: 'system', to: 'pm', subject: `对账异常 ${issues.length} 项`, body: issues.slice(0, 8).map((i) => `${i.area}/${i.metric}: ${i.actual}`).join('\n'), project: activeProject?.name || '', ackRequired: true, type: 'reconcile' });
    } catch { /* no pm? ignore */ }
  }
  out(args, md, { ok: issues.length === 0, rows, issues, file: outFile });
}

function activeProjectState(team) {
  if (!team.activeProject) return false;
  try { loadProject(team.activeProject); return true; } catch { return false; }
}

export function verifyAll(projectFilter = null) {
  const problems = [];
  const warnings = [];
  const team = loadTeam();
  const chain = verifyEventChain();
  if (!chain.ok) problems.push({ type: 'EVENT_CHAIN', count: chain.problems.length, details: chain.problems.slice(0, 10) });
  const projects = projectFilter ? [loadProject(projectFilter)] : listProjects();
  for (const p of projects) {
    for (const pr of listProposals(p.name)) {
      if (pr.status !== 'applied') continue;
      const actual = computeProposalHash(pr);
      if (actual !== pr.proposalHash) problems.push({ type: 'PROPOSAL_HASH', project: p.name, proposal: pr.id, expected: pr.proposalHash, actual });
      let commit;
      try { commit = loadCommit(p.name, pr.commitId); } catch (e) { problems.push({ type: 'COMMIT_MISSING', project: p.name, proposal: pr.id, commit: pr.commitId }); continue; }
      // 历史提案只核对“提交记录里的 after 哈希”，当前文件由产物登记表 checkDrift 核对
      for (const f of pr.files) {
        const a = (commit.after || []).find((x) => x.target === f.target);
        if (!a) { problems.push({ type: 'COMMIT_FILE_MISSING', project: p.name, proposal: pr.id, target: f.target }); continue; }
        if (a.hash !== f.newHash) problems.push({ type: 'COMMIT_HASH', project: p.name, proposal: pr.id, target: f.target, expected: f.newHash, commit: a.hash });
      }
      const chk = checkApprovals(pr, team, { forApply: false, stored: true });
      if (chk.problems.length) problems.push({ type: 'APPROVALS', project: p.name, proposal: pr.id, details: chk.problems });
    }
    const drift = checkDrift(p);
    for (const d of drift) problems.push({ type: 'ARTIFACT', project: p.name, ...d });
  }
  for (const l of listLocks()) {
    if (l.stale) warnings.push({ type: 'STALE_LOCK', key: l.key, expiresAt: l.expiresAt });
    if (l.broken) warnings.push({ type: 'BROKEN_LOCK', key: l.key });
  }
  for (const m of activeMembers(team)) {
    for (const g of loadGrants(m.role).grants || []) {
      if (g.revokedAt) continue;
      if (g.expiresAt && Date.parse(g.expiresAt) < Date.now()) warnings.push({ type: 'EXPIRED_GRANT', role: m.role, grant: g.id, expiresAt: g.expiresAt });
    }
  }
  return { ok: problems.length === 0, problems, warnings, projects: projects.length, events: chain.count };
}

export function cmdVerify(args) {
  const r = verifyAll(args.project ? String(args.project) : null);
  const lines = [];
  lines.push(`verify：${r.ok ? '✅ PASS' : '❌ FAIL'}`);
  lines.push(`项目 ${r.projects} 个 ｜ 事件 ${r.events} 条 ｜ 问题 ${r.problems.length} ｜ 警告 ${r.warnings.length}`);
  for (const p of r.problems.slice(0, 30)) lines.push(`  ❌ ${p.type} ${JSON.stringify(p).slice(0, 220)}`);
  for (const w of r.warnings.slice(0, 20)) lines.push(`  ⚠ ${w.type} ${JSON.stringify(w).slice(0, 180)}`);
  if (args.json) jsonOut({ ok: r.ok, ...r });
  else textOut(lines.join('\n'));
  if (!r.ok) process.exitCode = 1;
}

export function cmdLog(args) {
  const { items } = readEventsStrict();
  const n = Number(args.tail || 20);
  let rows = items;
  if (args.project) rows = rows.filter((e) => e.project === args.project);
  rows = rows.slice(-n);
  const lines = rows.map((e) => `${e.ts.slice(0, 19).replace('T', ' ')} [${e.role}] ${e.action} ${e.target} ${e.result !== 'ok' ? '(' + e.result + ')' : ''} — ${e.note}`);
  out(args, lines.join('\n') || '（无事件）', { ok: true, events: rows });
}

// ========== 锁命令 ==========

export function cmdLock(args) {
  const sub = args._[1] || 'status';
  if (sub === 'status') {
    const locks = args.key ? [lockInfo(String(args.key))].filter(Boolean) : listLocks();
    out(args, locks.length ? locks.map((l) => `${l.key} @ ${l.role || l.owner} ${l.stale ? '(stale)' : ''} 到期 ${l.expiresAt}`).join('\n') : '（无锁）', { ok: true, locks });
    return;
  }
  const b = bootFor(args, 'lock');
  if (!args.key) fail('BAD_KEY', '需要 --key');
  const key = String(args.key);
  if (sub === 'acquire') {
    try {
      const owner = acquireLock(key, { role: b.role, sessionId: b.sessionId, ttlMs: Number(args.ttl || 60) * 1000, waitMs: 0, reason: args.reason || '' });
      appendEvent({ role: b.role, sessionId: b.sessionId, action: 'lock', project: b.project, target: key, note: 'acquired', data: { owner } });
      out(args, `已加锁 ${key}（${b.role}，到期 ${owner.expiresAt}）`, { ok: true, lock: owner });
    } catch (e) {
      appendEvent({ role: b.role, sessionId: b.sessionId, action: 'lock', project: b.project, target: key, result: e.code || 'ERROR', note: e.message });
      throw e;
    }
    return;
  }
  if (sub === 'release') {
    const ok = releaseLock(key, { role: b.role });
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'lock', project: b.project, target: key, note: ok ? 'released' : 'not-held' });
    out(args, ok ? `已释放 ${key}` : `锁不存在 ${key}`, { ok: true, released: ok });
    return;
  }
  if (sub === 'heartbeat') {
    const l = heartbeatLock(key, { role: b.role, ttlMs: Number(args.ttl || 60) * 1000 });
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'lock', project: b.project, target: key, note: 'heartbeat' });
    out(args, `已续期 ${key} 到 ${l.expiresAt}`, { ok: true, lock: l });
    return;
  }
  fail('BAD_SUBCOMMAND', `未知 lock 子命令：${sub}`);
}

// ========== owner 终端批准 ==========

export async function cmdOwnerApprove(args) {
  if (!args.proposal) fail('BAD_ID', '需要 --proposal');
  const team = loadTeam();
  const projectName = String(args.project || team.activeProject || '');
  if (!projectName) fail('NO_PROJECT', '需要 --project');
  const proposal = loadProposal(projectName, String(args.proposal));
  const actual = computeProposalHash(proposal);
  if (actual !== proposal.proposalHash) fail('PROPOSAL_TAMPERED', '提案哈希不符');
  let channel = 'tty';
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (process.env.TEAM_SELFTEST === '1' && args['test-owner']) {
      channel = 'selftest';
    } else {
      fail('OWNER_TTY_REQUIRED', 'owner 批准必须在真实终端运行（无 TTY 会被拒绝）。请在 PowerShell 里手动执行本命令。', { hint: `node 团队\\工具\\team.mjs owner-approve --proposal ${proposal.id} --project "${projectName}"` });
    }
  }
  textOut(`=== owner 批准 ===\n提案 ${proposal.id} · ${proposal.risk} · ${proposal.title}\n文件：${proposal.files.map((f) => f.target).join(', ')}\n提案哈希：${proposal.proposalHash}`);
  let answer = '';
  if (channel === 'tty') {
    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    answer = await rl.question(`输入「批准 ${proposal.id}」继续（其它输入=拒绝）：`);
    rl.close();
    if (answer.trim() !== `批准 ${proposal.id}`) fail('OWNER_ABORTED', 'owner 未批准');
  }
  const ts = nowIso();
  const nonce = randomHex(6);
  const baseHash = proposal.files.map((f) => f.baseHash).join(',');
  const newHash = proposal.files.map((f) => f.newHash).join(',');
  const sig = signatureDigest({ role: 'owner', proposalId: proposal.id, proposalHash: proposal.proposalHash, baseHash, newHash, decision: 'approve', ts, nonce });
  const record = {
    role: 'owner', proposalId: proposal.id, proposalHash: proposal.proposalHash, baseHash, newHash,
    decision: 'approve', note: truncate(String(args.note || '终端批准'), 300), ts, nonce, sig, channel, sessionId: channel === 'tty' ? 'tty' : 'selftest',
  };
  saveSignature(projectName, proposal.id, 'owner', record);
  appendEvent({ role: 'owner', sessionId: channel, action: 'owner_approve', project: projectName, target: proposal.id, note: `channel=${channel}`, data: { proposalHash: proposal.proposalHash, channel } });
  out(args, `owner 已批准 ${proposal.id}（channel=${channel}）`, { ok: true, signature: record });
}

// ========== 投票（vote start / cast / status） ==========
// 规则：除 PM 外全体角色参与；PM 只发起/记录，不投票。
// 驳回只有一种情形——除 PM 外全员一致驳回；赞成过半即通过；
// 全部投完既非一致驳回也无过半赞成 = 未形成多数（no_consensus），不冒充通过。
// 文件：团队/状态/项目/<slug>/投票/V-....json（真相）+ 同名 .md（人读），供壳层用 vote status 读取。

function votePaths(projectName) {
  const dir = projectStatePaths(projectName).votes;
  return {
    dir,
    file: (id) => path.join(dir, `${id}.json`),
    md: (id) => path.join(dir, `${id}.md`),
  };
}

function newVoteId(projectName) {
  const p = votePaths(projectName);
  for (let i = 0; i < 20; i++) {
    const id = 'V-' + stamp() + '-' + randomHex(2);
    if (!exists(p.file(id))) return id;
  }
  fail('VOTE_ID_COLLISION', '投票编号生成冲突，请重试');
}

function loadVote(projectName, id) {
  const file = votePaths(projectName).file(String(id));
  const vote = readJson(file, null);
  if (!vote) fail('VOTE_NOT_FOUND', `投票不存在：${id}`, { id, project: projectName, file });
  return vote;
}

function voteTally(vote) {
  const eligible = Array.isArray(vote.eligible) ? vote.eligible : [];
  const votes = vote.votes && typeof vote.votes === 'object' ? vote.votes : {};
  const cast = eligible.filter((r) => votes[r]);
  return {
    eligible,
    cast,
    pending: eligible.filter((r) => !votes[r]),
    approve: cast.filter((r) => votes[r].vote === 'approve'),
    reject: cast.filter((r) => votes[r].vote === 'reject'),
    abstain: cast.filter((r) => votes[r].vote === 'abstain'),
  };
}

function evaluateVote(vote) {
  const t = voteTally(vote);
  const total = t.eligible.length;
  if (!total) return { ...t, result: 'no_consensus', closed: true, reason: '没有可投票角色（除 PM 外）' };
  // 规则一：除 PM 外全员一致驳回才驳回。
  if (t.reject.length === total) return { ...t, result: 'rejected', closed: true, reason: '除 PM 外全员一致驳回' };
  // 规则二：赞成过半即通过。
  const majority = Math.floor(total / 2) + 1;
  if (t.approve.length >= majority) return { ...t, result: 'approved', closed: true, reason: `赞成 ${t.approve.length}/${total} 过半` };
  // 规则三：全部投完仍无结论 = 未形成多数（不是通过，也不是驳回）。
  if (t.cast.length === total) return { ...t, result: 'no_consensus', closed: true, reason: '全部投完：既非全员一致驳回，也未过半赞成' };
  return { ...t, result: 'pending', closed: false, reason: `已投 ${t.cast.length}/${total}` };
}

function voteMarkdown(vote, evaluation) {
  const p = votePaths(vote.project);
  const nameOf = (r) => ROLE_NAMES[r] || r;
  const rows = evaluation.eligible.map((r) => {
    const v = vote.votes && vote.votes[r];
    return `| ${nameOf(r)} | ${v ? v.vote : '（未投）'} | ${v && v.comment ? v.comment.replace(/\|/g, '\\|') : ''} | ${v ? v.at : ''} |`;
  });
  return [
    `# ${vote.id} · ${vote.subject}`,
    '',
    '> 程序生成；同名 JSON 是真相，本文件只做人读镜像。中文记录；投票只对本次投票编号负责。',
    '',
    `- 项目：${vote.project}（团队模式 ${vote.teamMode || 'full'}）`,
    `- 发起人：${nameOf(vote.createdBy)} ｜ 发起时间：${vote.createdAt}`,
    ...(vote.createdByCommand && vote.createdByCommand !== vote.createdBy
      ? [`- 命令执行者：${nameOf(vote.createdByCommand)}（发起归属按实际发起人记录）`]
      : []),
    `- 状态：${vote.status} ｜ 结论：${vote.result}（${vote.resultReason || evaluation.reason}）`,
    `- 参与人：除 PM 外全体角色（${evaluation.eligible.map(nameOf).join('、')}）；PM 不投票`,
    ...(vote.kind ? [`- 类型：${vote.kind}`] : []),
    ...(vote.requirementId ? [`- 关联需求：${vote.requirementId}`] : []),
    ...(vote.proposalId ? [`- 关联提案：${vote.proposalId}（proposalHash ${shortHash(vote.proposalHash, 16)}）`] : []),
    `- 规则：${vote.rule || VOTE_RULE_TEXT}`,
    '',
    '## 票数',
    '',
    '| 角色 | 票 | 意见 | 时间 |',
    '|---|---|---|---|',
    ...rows,
    '',
    `赞成 ${evaluation.approve.length} ｜ 驳回 ${evaluation.reject.length} ｜ 弃权 ${evaluation.abstain.length} ｜ 未投 ${evaluation.pending.length}`,
    '',
    ...(vote.closedAt ? [`关闭时间：${vote.closedAt}`, ''] : []),
  ].join('\n');
}

function saveVote(projectName, vote) {
  const p = votePaths(projectName);
  ensureDir(p.dir);
  const evaluation = evaluateVote(vote);
  vote.status = evaluation.closed ? 'closed' : 'open';
  vote.result = evaluation.result;
  vote.resultReason = evaluation.reason;
  vote.closedAt = evaluation.closed ? (vote.closedAt || nowIso()) : null;
  vote.updatedAt = nowIso();
  writeJson(p.file(vote.id), vote);
  writeText(p.md(vote.id), voteMarkdown(vote, evaluation));
  return { vote, evaluation };
}

function voteStatusText(vote, evaluation) {
  const nameOf = (r) => ROLE_NAMES[r] || r;
  const lines = [`投票 ${vote.id} · ${vote.subject}`];
  lines.push(`状态: ${vote.status} ｜ 结论: ${evaluation.result}（${evaluation.reason}）`);
  lines.push(`参与人（除 PM 外）: ${evaluation.eligible.map(nameOf).join('、') || '（无）'}`);
  lines.push(`赞成 ${evaluation.approve.length} ｜ 驳回 ${evaluation.reject.length} ｜ 弃权 ${evaluation.abstain.length} ｜ 未投 ${evaluation.pending.length}`);
  if (evaluation.pending.length) lines.push(`未投: ${evaluation.pending.map(nameOf).join('、')}`);
  for (const r of evaluation.eligible) {
    const v = vote.votes && vote.votes[r];
    lines.push(`  - ${nameOf(r)}: ${v ? v.vote : '未投'}${v && v.comment ? ' — ' + truncate(v.comment, 80) : ''}`);
  }
  return lines.join('\n');
}

export function cmdVote(args) {
  const sub = args._[1] || 'status';
  if (sub === 'start') {
    const b = bootFor(args, 'vote start');
    // PM 组织投票；需求分析师可以以实际分析师身份发起（V 文件 createdBy 记真实角色）。
    // 其他角色仍不能发起；PM 依旧不投票。
    if (!['pm', 'analyst'].includes(b.role)) {
      fail('ROLE_NOT_ALLOWED', '只有 PM 或需求分析师能发起投票（PM 不投票，只组织与记录）', {
        role: b.role, allowed: ['pm', 'analyst'],
      });
    }
    const subject = String(args.subject || '').trim();
    if (!subject) fail('BAD_ARGS', '需要 --subject 投票事项');
    const project = loadProject(b.project);
    const team = loadTeam();
    const teamMode = projectTeamMode(project);
    const voters = votersForMode(teamMode).filter((r) => {
      const m = getMember(team, r);
      return Boolean(m && m.status === 'active');
    });
    if (!voters.length) {
      fail('NO_VOTERS', `当前项目模式 ${teamMode} 没有可投票的活跃角色（除 PM 外）；先 roster add`, {
        teamMode, roles: rolesForMode(teamMode),
      });
    }
    const kind = String(args.kind || 'other').trim().toLowerCase();
    if (!['requirement', 'change', 'other'].includes(kind)) fail('BAD_KIND', '--kind 只能是 requirement / change / other', { kind });
    let requirementId = '';
    if (args.requirement) {
      const task = loadTask(b.project, String(args.requirement));
      if (task.type !== 'requirement') fail('NOT_REQUIREMENT', `${task.id} 不是需求（type=${task.type}）`, { id: task.id, type: task.type });
      requirementId = task.id;
    }
    let proposal = null;
    if (args.proposal) {
      proposal = loadProposal(b.project, String(args.proposal));
      const actual = computeProposalHash(proposal);
      if (actual !== proposal.proposalHash) fail('PROPOSAL_TAMPERED', '提案哈希不符', { expected: proposal.proposalHash, actual });
    }
    const ts = nowIso();
    const id = newVoteId(b.project);
    const vote = {
      id,
      project: b.project,
      teamMode,
      subject: truncate(subject, 200),
      kind,
      requirementId,
      proposalId: proposal ? proposal.id : '',
      proposalHash: proposal ? proposal.proposalHash : '',
      createdBy: b.role,
      createdByRole: b.role,
      // 与工作台壳层同名字段：发起归属以 createdBy 为准，执行者另存 createdByCommand。
      initiator: b.role,
      sessionId: b.sessionId,
      createdAt: ts,
      updatedAt: ts,
      status: 'open',
      eligible: voters,
      votes: {},
      result: 'pending',
      resultReason: '尚未投票',
      rule: VOTE_RULE_TEXT,
      note: truncate(String(args.note || ''), 300),
    };
    const saved = saveVote(b.project, vote);
    appendEvent({
      role: b.role, sessionId: b.sessionId, action: 'vote_start', project: b.project, target: id,
      note: `${truncate(subject, 100)} by=${b.role} eligible=${voters.join(',')}`,
      data: { voteId: id, subject: vote.subject, kind, requirementId, proposalId: vote.proposalId, eligible: voters, teamMode, createdBy: b.role },
    });
    for (const r of voters) {
      notify({
        from: b.role, to: r, subject: `投票 ${id}`,
        body: `发起人：${ROLE_NAMES[b.role] || b.role}\n${vote.subject}\n请投票：vote cast --boot <T> --id ${id} --vote approve|reject [--comment "..."]\n规则：${VOTE_RULE_TEXT}`,
        project: b.project, task: requirementId, ackRequired: false, type: 'vote', sessionId: b.sessionId,
      });
    }
    out(args, `投票已发起：${id} · ${vote.subject}\n发起人：${ROLE_NAMES[b.role] || b.role}\n参与人（除 PM 外）：${voters.map((r) => ROLE_NAMES[r] || r).join('、')}\n文件：${votePaths(b.project).file(id)}`, {
      ok: true, vote: saved.vote, evaluation: saved.evaluation, teamMode, file: votePaths(b.project).file(id),
    });
    return;
  }
  if (sub === 'cast') {
    const b = bootFor(args, 'vote cast');
    if (!args.id) fail('BAD_ID', '需要 --id V-...');
    const vote = loadVote(b.project, String(args.id));
    if (vote.status === 'closed') fail('VOTE_CLOSED', `投票已关闭：${vote.id}（${vote.result}）`, { voteId: vote.id, result: vote.result });
    if (!Array.isArray(vote.eligible) || !vote.eligible.includes(b.role)) {
      fail('NOT_ELIGIBLE', `${b.role} 不在本次投票参与人里（${(vote.eligible || []).join(', ')}）；PM 不投票`, {
        role: b.role, eligible: vote.eligible || [],
      });
    }
    const choice = String(args.vote || args.choice || '').trim().toLowerCase();
    if (!['approve', 'reject', 'abstain'].includes(choice)) fail('BAD_VOTE', '--vote 必须是 approve / reject / abstain');
    const comment = truncate(String(args.comment || args.comments || ''), 300);
    const prev = vote.votes && vote.votes[b.role];
    vote.votes = vote.votes && typeof vote.votes === 'object' ? vote.votes : {};
    vote.votes[b.role] = {
      vote: choice,
      comment,
      at: nowIso(),
      sessionId: b.sessionId,
      revision: prev ? Number(prev.revision || 1) + 1 : 1,
    };
    const saved = saveVote(b.project, vote);
    appendEvent({
      role: b.role, sessionId: b.sessionId, action: 'vote_cast', project: b.project, target: vote.id,
      note: `${choice} ${truncate(comment, 100)}`,
      data: { voteId: vote.id, choice, result: saved.vote.result, resultReason: saved.vote.resultReason },
    });
    // 需求被投票一致驳回时，同时把 rejected 写进需求任务与 工作流.json，
    // 这样 req iterate / req terminate 和工作台都能看到同一条驳回结论。
    let requirementSync = null;
    if (saved.vote.result === 'rejected' && vote.kind === 'requirement' && vote.requirementId) {
      try {
        const reqTask = loadTask(b.project, vote.requirementId);
        if (reqTask.type === 'requirement') {
          stampRejected(reqTask, { source: `vote:${vote.id}`, role: 'vote', at: saved.vote.closedAt || nowIso() });
          reqTask._by = b.role;
          reqTask._action = 'vote_rejected';
          reqTask._note = `投票 ${vote.id} 除 PM 外全员一致驳回`;
          saveTask(b.project, reqTask);
          const wf = reqTask.workflow;
          const sync = syncWorkflowRow(b.project, reqTask, 'rejected', {
            rejectedAt: wf.rejectedAt,
            rejectedBy: wf.rejectedBy,
            rejectionSource: wf.rejectionSource,
          }, {
            create: true,
            action: 'vote_rejected',
            by: b.role,
            note: String(saved.vote.resultReason || ''),
            phase: 'requirement_review',
          });
          requirementSync = { requirementId: reqTask.id, workflowFile: sync.file };
          appendEvent({
            role: b.role, sessionId: b.sessionId, action: 'vote_reject_requirement', project: b.project,
            target: reqTask.id, note: `投票 ${vote.id} 驳回需求`, data: { voteId: vote.id, requirementId: reqTask.id, workflowFile: sync.file },
          });
        }
      } catch (e) {
        requirementSync = {
          requirementId: vote.requirementId,
          ok: false,
          code: e.code || 'REQUIREMENT_SYNC_FAILED',
          message: e.message,
        };
      }
    }
    // 只把进度同步给 PM（不打扰其他投票人），PM 再用 vote status 看全貌。
    try {
      notify({
        from: b.role, to: 'pm', subject: `投票进度 ${vote.id}`,
        body: `${vote.subject}\n${b.role} 投了 ${choice}${comment ? '：' + comment : ''}\n当前 ${saved.vote.result}（${saved.vote.resultReason}）`,
        project: b.project, task: vote.requirementId || '', ackRequired: false, type: 'vote', sessionId: b.sessionId,
      });
    } catch { /* 进度消息失败不影响投票记录 */ }
    out(args, `已投票：${vote.id} / ${b.role} → ${choice}；当前 ${saved.vote.result}（${saved.vote.resultReason}）`, {
      ok: true, vote: saved.vote, evaluation: saved.evaluation, file: votePaths(b.project).file(vote.id),
      ...(requirementSync ? { requirementSync } : {}),
    });
    return;
  }
  if (sub === 'status') {
    // 只读：壳层可以在没有令牌的情况下查询投票结果。
    const team = loadTeam();
    const projectName = String(args.project || team.activeProject || '').trim();
    if (!projectName) fail('NO_PROJECT', '没有当前项目；先 project add / project use');
    const project = loadProject(projectName);
    const teamMode = projectTeamMode(project);
    if (args.id) {
      const vote = loadVote(projectName, String(args.id));
      const evaluation = evaluateVote(vote);
      out(args, voteStatusText(vote, evaluation), {
        ok: true, vote, evaluation, project: projectName, teamMode, file: votePaths(projectName).file(vote.id),
      });
      return;
    }
    const p = votePaths(projectName);
    let names = [];
    try { names = fs.readdirSync(p.dir); } catch { names = []; }
    let votes = names
      .filter((n) => /^V-.*\.json$/i.test(n))
      .map((n) => readJson(path.join(p.dir, n), null))
      .filter(Boolean);
    if (args.open) votes = votes.filter((v) => v.status !== 'closed');
    votes.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const rows = votes.map((v) => {
      const e = evaluateVote(v);
      return {
        id: v.id, subject: v.subject, status: v.status, result: e.result,
        cast: `${e.cast.length}/${e.eligible.length}`, created: v.createdAt,
      };
    });
    out(args, `投票（${projectName}，${votes.length} 条；模式 ${teamMode}）\n` + table(rows, [
      { key: 'id', label: '投票' }, { key: 'status', label: '状态' }, { key: 'result', label: '结论' }, { key: 'cast', label: '已投' }, { key: 'subject', label: '事项' }, { key: 'created', label: '发起' },
    ]), { ok: true, votes, project: projectName, teamMode });
    return;
  }
  fail('BAD_SUBCOMMAND', `未知 vote 子命令：${sub}（支持 start / cast / status）`);
}

// ========== 团队扩编 ==========

export function cmdRoster(args) {
  const sub = args._[1] || 'list';
  const team = loadTeam();
  const teamMode = activeProjectMode(team);
  const allowedRoles = rolesForMode(teamMode);
  if (sub === 'list') {
    const rows = team.members.map((m) => ({
      role: m.role, name: m.name, status: m.status,
      mode: allowedRoles.includes(m.role) ? '✓' : '—',
      session: m.sessionId || '',
    }));
    out(args, `团队（项目模式 ${teamMode}：${allowedRoles.map((r) => ROLE_NAMES[r] || r).join('、')}；— = 不在当前模式）\n` + table(rows, [
      { key: 'role', label: '角色' }, { key: 'name', label: '名称' }, { key: 'status', label: '状态' }, { key: 'mode', label: '本模式' }, { key: 'session', label: '会话' },
    ]), { ok: true, members: team.members, phase: team.phase, teamMode, roles: allowedRoles });
    return;
  }
  const b = tokenOf(args);
  if (b.role !== 'pm') fail('NOT_PM', '只有 PM 能扩编');
  if (sub === 'add') {
    // 以“令牌所在项目”的模式为准：PM 可以在不切 activeProject 的情况下给别的项目扩编。
    let addMode = teamMode;
    try { addMode = projectTeamMode(loadProject(b.project)); } catch { /* 用当前项目模式兜底 */ }
    const addRoles = rolesForMode(addMode);
    if (team.phase === PHASE_PILOT && !args.force) {
      const pc = pilotCheckData(team);
      if (!pc.pass) fail('PILOT_NOT_PASSED', 'pilot 门槛未过，先跑通回执/签字/陈旧拒绝/锁争用；或 --force 并写理由', { checks: pc.checks });
    }
    const role = String(args.role || '');
    if (!ROLES.includes(role)) fail('BAD_ROLE', `角色必须是 ${ROLES.join('/')}`);
    // 动态角色集：当前项目是 fast 就只允许四角色；要加产品/程序员B 先切 full。
    if (!roleInMode(role, addMode)) {
      fail('ROLE_NOT_IN_MODE', `项目当前是 ${addMode} 模式（${addRoles.map((r) => ROLE_NAMES[r] || r).join('、')}），不能加 ${ROLE_NAMES[role] || role}；先把项目切到 full：project ensure --name "${b.project}" --team-mode full`, {
        role, teamMode: addMode, roles: addRoles,
      });
    }
    if (getMember(team, role)) fail('ROLE_EXISTS', `角色已存在：${role}`);
    const m = { role, name: args.name || ROLE_NAMES[role] || role, status: 'active', joinedAt: nowIso(), sessionId: args.session || '' };
    mutateTeam((t) => { t.members.push(m); return t; });
    const card = path.join(PATHS.roles, `${role}.md`);
    if (!exists(card)) writeText(card, `# ${m.name}\n\n- 职责：${args.duty || '（待补）'}\n- 每轮先 boot。\n`);
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'roster_add', project: b.project, target: role, note: `${m.name} ${args.reason || ''}`, data: { member: m, teamMode: addMode } });
    notify({ from: b.role, to: role, subject: '团队欢迎 / 必读', body: `你是 ${m.name}（团队模式 ${addMode}）。先读 团队宪法、项目铁律、角色卡、项目索引，然后 boot。没有令牌不执行。`, project: b.project, ackRequired: true, type: 'welcome', sessionId: b.sessionId });
    out(args, `已加入 ${m.name}（${role}，项目模式 ${addMode}）。提醒：先读四样，再 boot。`, { ok: true, member: m, teamMode: addMode });
    return;
  }
  if (sub === 'phase') {
    if (!args.set) fail('BAD_ARGS', '需要 --set pilot|team');
    if (!['pilot', 'team'].includes(String(args.set))) fail('BAD_PHASE', '阶段只能是 pilot / team');
    if (args.set === 'team') {
      const pc = pilotCheckData(team);
      if (!pc.pass) fail('PILOT_NOT_PASSED', 'pilot 门槛未过，不能转 team', { checks: pc.checks });
    }
    mutateTeam((t) => { t.phase = String(args.set); return t; });
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'phase', project: b.project, target: String(args.set), note: args.reason || '' });
    out(args, `阶段已切到 ${args.set}`, { ok: true, phase: args.set });
    return;
  }
  fail('BAD_SUBCOMMAND', `未知 roster 子命令：${sub}`);
}

export function cmdPilot(args) {
  const team = loadTeam();
  const pc = pilotCheckData(team);
  const lines = ['# 试点门槛检查', ''];
  for (const c of pc.checks) lines.push(`- ${c.ok ? '✅' : '❌'} ${c.label}：${c.detail}`);
  lines.push('');
  lines.push(pc.pass ? '结论：**PASS**，可以按扩编清单加人。' : '结论：**FAIL**，先补齐上面项。');
  lines.push('');
  lines.push('扩编顺序建议：1) 产品设计师（接优先级/验收）→ 2) 需求分析师 → 3) 架构师。每次只加 1 人，加完重跑一次 1 写 1 审。');
  out(args, lines.join('\n'), { ok: true, ...pc });
}

// ========== doctor ==========

export function cmdDoctor(args) {
  const issues = [];
  const team = loadTeam();
  if (!exists(PATHS.team)) issues.push('团队配置缺失');
  for (const role of activeRoles(team)) {
    if (!exists(path.join(PATHS.roles, `${role}.md`))) issues.push(`角色卡缺失：${role}`);
  }
  for (const f of [PATHS.team, PATHS.events, PATHS.receipts]) {
    if (exists(f)) {
      try { readJson(f); } catch { /* events jsonl not json */ }
    }
  }
  const chain = verifyEventChain();
  if (!chain.ok) issues.push(`事件链问题 ${chain.problems.length}`);
  const locks = listLocks().filter((l) => l.stale);
  if (locks.length) issues.push(`过期锁 ${locks.length}`);
  const pc = pilotCheckData(team);
  out(args, `doctor：${issues.length ? '❌' : '✅'}\n${issues.join('\n')}\n阶段 ${team.phase} ｜ 成员 ${activeRoles(team).join(', ')}\n试点 ${pc.pass ? 'PASS' : 'FAIL'}`, { ok: issues.length === 0, issues, team, pilot: pc });
}
