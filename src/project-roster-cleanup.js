'use strict';
/**
 * B-20261119-015113-2443（R-20261119-011311-97db 幽灵团队/恢复项目）
 * 纯逻辑单源：名册四态 + 删除项目四处映射清理计划 + 恢复四段审计。
 * 不读写文件、不依赖 Electron —— 壳层(main.js)与夹具共用同一实现，避免「自检口径与线上行为不一致」。
 */

/** 四态（需求 6.2）：ok 已绑定 / pending 待激活 / stale 已失效 / missing 缺会话。 */
const MEMBER_STATES = ['ok', 'pending', 'stale', 'missing'];

/**
 * 单个角色四态判定。入参：
 *  - rosterSession：团队.json → members[].sessionId（名册唯一真相）
 *  - projectSession：workbench.json → projects[].sessions[role]（项目映射）
 *  - workspaceSession：projects[].workspace.sessionIds 是否包含该会话
 * 规则（需求 §6.1）：名册与项目映射都没有 → stale（成员已归档/从不存在）；
 * 名册有但项目映射无 → pending（待激活/待绑定）；名册无但项目映射有 → missing（缺名册会话）；
 * 两边都有且一致（可选在工作区里）→ ok；两边都有但不一致 → pending（等重新对齐/核验）。
 */
function memberStateOf({ rosterSession, projectSession, workspaceSession } = {}) {
  const roster = String(rosterSession || '').trim();
  const mapped = String(projectSession || '').trim();
  if (!roster && !mapped) return 'stale';
  if (!roster) return 'missing';
  if (!mapped) return 'pending';
  if (roster !== mapped) return 'pending';
  if (workspaceSession === false) return 'pending';
  return 'ok';
}

/**
 * 删除项目时的「四处映射同事务清理」计划（纯函数，不落盘）：
 *  ① 团队.json → members[].sessionId（按本项目会话集合清空，不动其他项目的成员）
 *  ② 项目目录/<P>/团队会话.json（由壳层删除文件，本函数只给会话集合）
 *  ③ workbench.json → projects[].sessions（记录整体删除，由壳层做）
 *  ④ projects[].workspace.sessionIds（记录整体删除，由壳层做）
 * 返回 { team, clearedMembers, clearedRoles, workspaceSessionIds, missing }：
 *  - team 是**新对象**（原对象不改，便于失败回滚）；
 *  - clearedMembers = 被清空的角色 id 列表；clearedRoles = 项目会话清单里的角色（供审计）；
 *  - missing = 无法确认的段（当前实现只要 team/project 缺失才报，供审计 missing[]）。
 */
function planProjectCleanup({ team, project, manifestRoles } = {}) {
  const missing = [];
  const baseTeam = team && Array.isArray(team.members) ? JSON.parse(JSON.stringify(team)) : null;
  if (!baseTeam) missing.push('team');
  const projectSessions = (project && project.sessions) || {};
  const workspaceSessionIds = Array.isArray(project && project.workspace && project.workspace.sessionIds)
    ? project.workspace.sessionIds.map(String).filter(Boolean)
    : [];
  const manifestSessionIds = (Array.isArray(manifestRoles) ? manifestRoles : [])
    .map((row) => String((row && row.sessionId) || '').trim())
    .filter(Boolean);
  const doomed = new Set([...Object.values(projectSessions).map(String).filter(Boolean), ...workspaceSessionIds, ...manifestSessionIds]);
  const clearedMembers = [];
  if (baseTeam) {
    for (const member of baseTeam.members) {
      if (!member || !member.sessionId) continue;
      if (!doomed.has(String(member.sessionId))) continue;
      member.sessionId = '';
      // 保留成员记录本身（角色卡/身份仍在），只清会话绑定；归档标记供界面显示失效态。
      if (member.status !== 'removed') member.archived = true;
      clearedMembers.push(String(member.role || ''));
    }
  }
  const clearedRoles = Object.keys(projectSessions).map(String);
  return { team: baseTeam, clearedMembers, clearedRoles, workspaceSessionIds, doomsSessions: [...doomed], missing };
}

/**
 * 删除项目时把「清理会话集合」确定性扩大（97db 返工 T-20261119-025124-6af3）：
 * 若删除后不再有其它项目引用同一团队名（peersSameTeam 为空），则把名册里**全部 sessionId**
 * 并入 doomed 集合 —— 这样不论 project.sessions 是否为空、DSH 是否离线、团队会话清单是否存在，
 * 名册都能被确定清空（run1 清 / run2 不清的非确定结果即由此消除）。
 * 返回 { doomed:Set, expanded:boolean, added:string[] }；不修改入参。
 */
function expandDoomedForDeletedTeam({ team, doomedSessions, peersSameTeam } = {}) {
  const doomed = new Set(doomedSessions instanceof Set ? [...doomedSessions].map(String) : (Array.isArray(doomedSessions) ? doomedSessions.map(String) : []));
  const peers = Array.isArray(peersSameTeam) ? peersSameTeam.filter(Boolean) : [];
  const added = [];
  if (peers.length === 0 && team && Array.isArray(team.members)) {
    for (const member of team.members) {
      const sid = member && member.sessionId ? String(member.sessionId) : '';
      if (sid && !doomed.has(sid)) { doomed.add(sid); added.push(sid); }
    }
  }
  return { doomed, expanded: added.length > 0 || peers.length === 0, added };
}

/** 删除后四处映射是否真的归零（AC7 用：夹具与壳层可复用）。 */
function verifyProjectCleanup({ team, project = null, manifestRoles = [] } = {}) {
  const problems = [];
  const members = team && Array.isArray(team.members) ? team.members : [];
  const doomed = new Set([
    ...Object.values((project && project.sessions) || {}).map(String).filter(Boolean),
    ...(Array.isArray(project && project.workspace && project.workspace.sessionIds) ? project.workspace.sessionIds.map(String) : []),
    ...(Array.isArray(manifestRoles) ? manifestRoles : []).map((row) => String((row && row.sessionId) || '')).filter(Boolean)
  ]);
  const leftovers = members.filter((m) => m && m.sessionId && doomed.has(String(m.sessionId))).map((m) => String(m.role || ''));
  if (leftovers.length) problems.push('members:' + leftovers.join(','));
  if (project) {
    const mapped = Object.entries(project.sessions || {}).filter(([, sid]) => sid);
    if (mapped.length) problems.push('sessions:' + mapped.map(([role]) => role).join(','));
    const ws = (project.workspace && Array.isArray(project.workspace.sessionIds) ? project.workspace.sessionIds : []).filter(Boolean);
    if (ws.length) problems.push('workspace:' + ws.length);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * 恢复项目四段审计（需求 §6.3/§6.4）：record 项目记录 / workspace 工作区 / sessions 会话映射 / ui 面板可见。
 * 入参是各段的真实结果（boolean 或 {ok}），返回 {stages, ok, missing[]}。
 */
function buildRestoreAudit(input = {}) {
  const stageOf = (value) => {
    if (value === true) return true;
    if (value && typeof value === 'object' && ('ok' in value)) return Boolean(value.ok);
    return false;
  };
  const stages = {
    record: stageOf(input.record),
    workspace: stageOf(input.workspace),
    sessions: stageOf(input.sessions),
    ui: stageOf(input.ui)
  };
  const missing = Object.keys(stages).filter((key) => !stages[key]);
  return { stages, ok: missing.length === 0, missing };
}

module.exports = { MEMBER_STATES, memberStateOf, planProjectCleanup, expandDoomedForDeletedTeam, verifyProjectCleanup, buildRestoreAudit };
