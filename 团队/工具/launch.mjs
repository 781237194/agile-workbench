#!/usr/bin/env node
// 一键建团队会话：调 DSH /api/session/create + /api/session/prompt
// 只在本机回环；不打印密钥。默认只建空会话，不烧 token。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PATHS, appendEvent, jsonOut, textOut, nowIso, fail } from './lib/core.mjs';
import { ROLE_NAMES, ROLES, loadTeam, mutateTeam, getMember, projectStatePaths, setActiveProject, loadProject, projectTeamMode } from './lib/store.mjs';
import {
  TEAM_MODES, TEAM_MODE_LABELS, isTeamMode, normalizeTeamMode, rolesForMode, teamModeDescription, MODEL_BY_ROLE,
} from './lib/roles.mjs';
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

function startupText(role, project, workspace, teamMode = 'full') {
  const name = ROLE_NAMES[role] || role;
  const wait = role === 'pm'
    ? '只回一行：“PM 已就位，请老板说项目需求和场景。”'
    : `只回一行：“${name} 已就位，等待 PM 派单。”`;
  const fastDuty = teamMode !== 'fast' ? ''
    : (role === 'analyst' ? '快速模式：需求评审由你执行（req review）；需要驳回 Owner 需求时可用 vote start 按实际分析师身份发起；技术评审记录由程序员A执行；投票用 vote cast。'
      : role === 'programmer1' ? '快速模式：技术评审记录由你执行（req review --kind tech）；投票用 vote cast。'
        : role === 'tester' ? '快速模式：投票用 vote cast；除 PM 外全员一致驳回才驳回，只按证据投票。'
          : role === 'pm' ? '快速模式：需求评审交需求分析师，技术评审记录交程序员A；组织投票用 vote start / vote status，PM 不投票。'
            : '');
  return `你是「${name}」（${role}），工作区 ${workspace}。\n`
    + `团队模式：${TEAM_MODE_LABELS[teamMode]}（${teamModeDescription(teamMode)}）。${fastDuty}\n`
    + `全程中文思考、中文回复、中文写文档。每轮第一件事读 项目铁律.md；本回合只做两件事，不分析、不计划、不总结：\n`
    + `1) 运行 node 团队\\工具\\team.mjs boot --role ${role} --project "${project}"\n`
    + `2) ${wait}\n`
    + '不要建任务、不要写文件、不要输出方案。等老板/PM 下一条明确指令。';
}

const args = parse(process.argv.slice(2));
const project = String(args.project || '');
const defaultProjectDir = path.join(PATHS.projects, project);
const workspace = path.resolve(String(args.workspace || (project && fs.existsSync(defaultProjectDir) ? defaultProjectDir : PATHS.workspace)));
const team = loadTeam();
if (!project) fail('NO_PROJECT', '需要 --project（先 team.mjs project add）');
if (!fs.existsSync(workspace)) fail('NO_WORKSPACE', `工作区目录不存在：${workspace}`);

// 团队模式：显式 --team-mode > 已登记项目 项目.json > 工作区 workspace.json > full。
// 角色集随模式动态变化：fast 只建/只要求 PM、需求分析师、程序员A、测试人员。
const modeArg = args['team-mode'];
if (modeArg !== undefined && (modeArg === true || !isTeamMode(modeArg))) {
  fail('BAD_TEAM_MODE', `--team-mode 只能是 ${TEAM_MODES.join(' / ')}：${modeArg === true ? '（缺值）' : modeArg}`, { allowed: TEAM_MODES });
}
let teamMode = modeArg !== undefined ? normalizeTeamMode(modeArg) : '';
if (!teamMode) {
  try { teamMode = projectTeamMode(loadProject(project)); } catch { /* 项目还没登记 */ }
}
if (!teamMode) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(workspace, 'workspace.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (meta.teamMode) teamMode = normalizeTeamMode(meta.teamMode);
  } catch { /* 老工作区没有 workspace.json */ }
}
teamMode = teamMode || 'full';
const modeRoles = rolesForMode(teamMode);
const roles = String(args.roles || modeRoles.join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);
for (const r of roles) {
  if (!ROLES.includes(r)) fail('BAD_ROLE', `未知角色：${r}`);
  if (!modeRoles.includes(r)) {
    fail('ROLE_NOT_IN_MODE', `项目 ${project} 当前是 ${teamMode} 模式（${modeRoles.join('/')}），不能建 ${r} 会话；要建请先把项目切到 full：project ensure --name "${project}" --team-mode full`, {
      role: r, teamMode, roles: modeRoles,
    });
  }
}
const promptAll = Boolean(args['prompt-all']);
const promptRoles = promptAll ? roles : (args.prompt ? ['pm'].filter((r) => roles.includes(r)) : []);
const noPrompt = Boolean(args['no-prompt']) || promptRoles.length === 0;
const addMembers = Boolean(args['add-members']);
const restoreMode = Boolean(args.restore);
// DSH 左侧工作区会把“从未产生一轮对话”的空白会话隐藏；可选给空白角色发一句就位，
// 让成员真正出现在工作区里。不是开工卡，不要求分析/写文件。
const seedVisible = Boolean(args['seed-visible']);
const dryRun = Boolean(args['dry-run']);
const engineUrl = String(args['engine-url'] || process.env.DSH_WEB_URL || '');

const plan = roles.map((role) => ({
  role,
  title: `团队·${ROLE_NAMES[role] || role}`,
  inRoster: Boolean(getMember(team, role)),
  model: MODEL_BY_ROLE[role] || null,
  prompt: startupText(role, project, workspace, teamMode),
}));

if (dryRun) {
  out({ ok: true, dryRun: true, engineUrl: engineUrl || '(env DSH_WEB_URL)', workspace, project, teamMode, plan, addMembers, noPrompt, promptRoles });
  process.exit(0);
}

// 指定旧目录/非标准工作区时，先按团队模式补齐角色目录、角色卡、项目信息、铁律和索引
const workspaceTool = path.join(PATHS.teamRoot, '工具', 'workspace.mjs');
if (fs.existsSync(workspaceTool)) {
  const relWs = path.relative(PATHS.workspace, workspace);
  const externalWorkspace = !relWs || relWs.startsWith('..') || path.isAbsolute(relWs);
  const ensureArgs = [workspaceTool, 'ensure', '--name', project, '--path', workspace, '--team-mode', teamMode, '--json'];
  if (externalWorkspace) ensureArgs.push('--allow-external');
  if (engineUrl) ensureArgs.push('--engine-url', engineUrl);
  const e = spawnSync(process.execPath, ensureArgs, { encoding: 'utf8', timeout: 60000 });
  if (e.status !== 0) {
    fail('WORKSPACE_ENSURE_FAILED', `工作区文件补齐失败：${(e.stderr || e.stdout || '').slice(-800)}`);
  }
}
if (!fs.existsSync(projectStatePaths(project).config)) fail('NO_PROJECT', `项目不存在：${project}（先 project add）`);

const client = new DshClient(engineUrl || undefined);
const workspaceResult = await client.workspaceCreate({ path: workspace });
const dshWorkspace = workspaceResult.workspace;
const activeSessionIds = new Set(dshWorkspace.sessionIds || []);
// 程序把真实 workspaceId 写回项目元数据，后续恢复不再依赖猜测。
try {
  const metaFile = path.join(workspace, 'workspace.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8').replace(/^\uFEFF/, ''));
  meta.dshWorkspaceId = dshWorkspace.workspaceId;
  meta.updatedAt = nowIso();
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');
} catch { /* 旧目录没有 workspace.json 也继续 */ }
const existingList = await client.list();
// 只复用“已经被这个工作区正式记账”的会话；archived 的历史会话不当作成员。
const existingByTitle = new Map(
  existingList.items
    .filter((s) => activeSessionIds.has(s.sessionId))
    .filter((s) => String(s.cwd || '').toLowerCase() === workspace.toLowerCase() && s.projections?.values?.title)
    .map((s) => [s.projections.values.title, s.sessionId]),
);
const sessions = [];
const errors = [];
for (const p of plan) {
  try {
    const reusedId = existingByTitle.get(p.title);
    let sessionId;
    let reused = false;
    if (reusedId) {
      sessionId = reusedId;
      reused = true;
      // 工作区被归档时，成员可能仍在 sessionIds 里但处于 archived 集合；先恢复再复用。
      try { await client.workspaceUnarchiveSession({ sessionId }); } catch { /* 未归档时可能报错，忽略 */ }
    } else {
      const created = await client.create({ workspaceId: dshWorkspace.workspaceId });
      sessionId = created.sessionId;
    }
    try { await client.rename({ sessionId, title: p.title }); } catch { /* 标题失败不影响 */ }
    let modelSelected = null;
    if (p.model) {
      try {
        modelSelected = await client.selectModel({ sessionId, provider: p.model.provider, model: p.model.model, reasoningEffort: p.model.reasoningEffort });
      } catch (e) {
        errors.push({ role: p.role, stage: 'model', message: e.message, code: e.code || '' });
      }
    }
    let prompted = false;
    if (!noPrompt && promptRoles.includes(p.role)) {
      try {
        await client.prompt({ sessionId, text: p.prompt, mode: 'queue' });
        prompted = true;
      } catch (e) {
        errors.push({ role: p.role, stage: 'prompt', message: e.message, code: e.code || '' });
      }
    }
    sessions.push({ role: p.role, name: ROLE_NAMES[p.role], title: p.title, sessionId, reused, prompted, model: p.model, modelSelected: Boolean(modelSelected) });
  } catch (e) {
    errors.push({ role: p.role, stage: 'create', message: e.message, code: e.code || '' });
  }
}

// 空白会话在 DSH 工作区里不显示成员；按需发一句“已就位”，让成员可见。
const seedResults = [];
if (seedVisible) {
  for (const s of sessions) {
    const info = existingList.items.find((x) => x.sessionId === s.sessionId);
    if (info && info.blank === false) continue;
    try {
      await client.prompt({
        sessionId: s.sessionId,
        text: `你是「${s.name}」。只回复：已就位。不要分析、不要写文件、不要建任务。`,
        mode: 'queue',
      });
      s.seeded = true;
      seedResults.push({ role: s.role, sessionId: s.sessionId, ok: true });
      // 逐个显示：等上一位的 turn 建立后再下一位，避免六个会话同时启动。
      await new Promise((resolve) => setTimeout(resolve, 1200));
    } catch (e) {
      seedResults.push({ role: s.role, sessionId: s.sessionId, ok: false, why: String(e.message || e).slice(-180) });
    }
  }
}

// 程序清理工作区自带的空白占位会话，避免“有工作区、成员为空”。
// 只处理 blank=true 且无标题的会话；不碰有标题/在跑的成员。
const createdSessionIds = new Set(sessions.map((s) => s.sessionId));
const cleanup = [];
try {
  const after = await client.workspaceCreate({ path: workspace });
  for (const sid of (after.workspace.sessionIds || [])) {
    if (createdSessionIds.has(sid)) continue;
    const info = existingList.items.find((x) => x.sessionId === sid);
    if (!info || !info.blank) continue;
    if (info.projections?.values?.title) continue;
    try {
      await client.workspaceArchiveSession({ sessionId: sid, stopActivity: false });
      cleanup.push({ sessionId: sid, action: 'archived_blank' });
    } catch (e) {
      cleanup.push({ sessionId: sid, action: 'archive_failed', why: String(e.message || e).slice(-180) });
    }
  }
} catch (e) {
  cleanup.push({ action: 'workspace_query_failed', why: String(e.message || e).slice(-180) });
}

// 程序写项目级会话清单：每个工作区自己的 sessionId，绝不手抄/不跨项目复用
const sessionManifest = {
  project,
  teamMode,
  workspace,
  workspaceId: dshWorkspace.workspaceId,
  generatedAt: nowIso(),
  roles: sessions.map((s) => ({
    role: s.role, name: s.name, title: s.title, sessionId: s.sessionId,
    reused: s.reused, model: s.model ? `${s.model.provider}/${s.model.model}` : '',
  })),
};
fs.writeFileSync(path.join(workspace, '团队会话.json'), JSON.stringify(sessionManifest, null, 2) + '\n', 'utf8');
const sessionMd = [
  '# 团队会话（程序生成）',
  '',
  '> 由 `launch.mjs` 在每次建团队/换会话时写入；**不要手改**。每个工作区独立，sessionId 不复用其他项目。',
  '',
  `- 项目：${project}`,
  `- 团队模式：${teamMode}（${TEAM_MODE_LABELS[teamMode]}）`,
  `- 工作区：${workspace}`,
  `- workspaceId：${dshWorkspace.workspaceId}`,
  `- 生成时间：${sessionManifest.generatedAt}`,
  '',
  '| 角色 | 会话标题 | sessionId | 新建/复用 | 模型 |',
  '|---|---|---|---|---|',
  ...sessions.map((s) => `| ${s.name} | ${s.title} | \`${s.sessionId}\` | ${s.reused ? '复用' : '新建'} | ${s.model ? s.model.provider + '/' + s.model.model : '—'} |`),
  '',
].join('\n');
fs.writeFileSync(path.join(workspace, '团队会话.md'), sessionMd, 'utf8');
let indexRefreshed = false;
try {
  const ir = spawnSync(process.execPath, [path.join(PATHS.teamRoot, '工具', 'team.mjs'), 'index', '--project', project, '--json'], { encoding: 'utf8', timeout: 60000 });
  indexRefreshed = ir.status === 0;
  if (!indexRefreshed) errors.push({ role: 'system', stage: 'index', message: (ir.stderr || ir.stdout || 'index 失败').slice(-400) });
} catch (e) {
  errors.push({ role: 'system', stage: 'index', message: String(e.message || e).slice(-400) });
}

// 回填已有成员的 sessionId；可选把新角色加进 roster
mutateTeam((t) => {
  for (const s of sessions) {
    const m = t.members.find((x) => x.role === s.role);
    if (m) m.sessionId = s.sessionId;
    else if (addMembers) t.members.push({ role: s.role, name: ROLE_NAMES[s.role] || s.role, status: 'active', joinedAt: nowIso(), sessionId: s.sessionId });
  }
  return t;
});

// 明确选择的工作区：切换 activeProject + 当前工作区，避免“建团队默认当前”
setActiveProject(project);
let wsMeta = {};
try { wsMeta = JSON.parse(fs.readFileSync(path.join(workspace, 'workspace.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { /* legacy workspace */ }
const currentWorkspace = {
  ...wsMeta,
  version: wsMeta.version || 1,
  name: project,
  path: workspace,
  dshWorkspaceId: dshWorkspace.workspaceId,
  engineUrl: engineUrl || wsMeta.engineUrl || null,
  dshCreated: Boolean(workspaceResult.created),
  reused: !workspaceResult.created,
  updatedAt: nowIso(),
};
fs.writeFileSync(path.join(PATHS.state, '当前工作区.json'), JSON.stringify(currentWorkspace, null, 2) + '\n', 'utf8');

const record = { generatedAt: nowIso(), workspace, workspaceId: dshWorkspace.workspaceId, dshWorkspaceCreated: workspaceResult.created, project, teamMode, restoreMode, seedVisible, seedResults, noPrompt, promptRoles, addMembers, sessions, errors, cleanup, indexRefreshed, sessionManifest, currentWorkspace };
const file = path.join(PATHS.state, '会话.json');
fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
appendEvent({
  role: 'owner', sessionId: 'launch', action: 'launch_sessions', project,
  target: roles.join(','), note: `mode=${teamMode} created=${sessions.length} errors=${errors.length} prompt=${!noPrompt} addMembers=${addMembers}`,
  data: { sessions, errors, file, teamMode },
});

if (args.json) jsonOut({ ok: errors.length === 0, ...record, file });
else {
  textOut(`已创建/恢复 ${sessions.length}/${plan.length} 个会话（${TEAM_MODE_LABELS[teamMode]}；${noPrompt ? '空会话，未发启动卡' : '仅唤醒：' + promptRoles.join(',')}）`);
  if (seedResults.length) textOut(`已让 ${seedResults.filter((x) => x.ok).length}/${seedResults.length} 个空白成员显示（发了一句“已就位”）`);
  if (cleanup.length) textOut(`清理占位会话 ${cleanup.filter((x) => x.action === 'archived_blank').length} 个`);
  for (const s of sessions) textOut(`- ${s.title}  ${s.sessionId}${s.prompted ? '  [已启动]' : ''}`);
  if (errors.length) {
    textOut('\n失败：');
    for (const e of errors) textOut(`- ${e.role} ${e.stage}: ${e.message}`);
  }
  textOut(`\n记录：${file}`);
  if (!noPrompt) textOut('提示：默认只唤醒 PM；仅在全队空转演练时才加 --prompt-all。');
}

function out(obj) {
  if (args.json) jsonOut(obj);
  else {
    textOut(`DRY RUN · ${obj.plan.length} 个会话 · ${obj.project} · ${obj.teamMode} · ${obj.workspace}`);
    for (const p of obj.plan) textOut(`- ${p.title}（${p.role}）${p.inRoster ? ' [已在 roster]' : ' [未入 roster]'}`);
    textOut(`engine: ${obj.engineUrl}`);
  }
}
