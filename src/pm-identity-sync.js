/**
 * R-fd42 / T-20261117-183920-5d98 第一步：PM 身份对齐的**纯判定核心**（CJS，无副作用）。
 *
 * 口径（需求正文 AC1 + 任务 detail）：
 *   - 名册是唯一真相：`团队/状态/团队.json → members[role=pm].sessionId`；
 *   - 换 PM（rotate/reassign/手工改名册）后，壳层要把 `workbench.json → projects[].workspace.sessionIds`
 *     对齐到名册；写 workbench 必须走 ad44 原子写入器（writeStore）+ 审计，**不触发 rulesHash**；
 *   - 失败可见：workbench 读不出来 → `WB_UNREADABLE` 且**不改写**；写失败 → 「待写入」并 60 秒重试一次；
 *     DSH 不可用 → 「待激活」。
 *
 * 本文件只做「算出该不该写、该写什么、审计行长什么样」，不碰文件系统；
 * 接线层（启动 / 60s / webview did-finish-load 三时机）在壳层调用本模块，并只用 writeStore 落盘。
 */
'use strict';

/** 冻结 7 键审计 schema（与任务 detail 一致，改字段必须同步 AC）。 */
const PM_IDENTITY_AUDIT_KEYS = ['at', 'action', 'project', 'role', 'fromSessionId', 'toSessionId', 'result'];

/** 名册 → PM 会话（唯一真相）。team 可以是对象或 JSON 文本。 */
function readRosterPm(team) {
  let obj = team;
  if (typeof team === 'string') {
    try { obj = JSON.parse(team); } catch { return { ok: false, code: 'ROSTER_UNREADABLE', sessionId: '', name: '' }; }
  }
  if (!obj || typeof obj !== 'object') return { ok: false, code: 'ROSTER_UNREADABLE', sessionId: '', name: '' };
  const members = Array.isArray(obj.members) ? obj.members : [];
  const pm = members.find((m) => String((m && m.role) || '') === 'pm') || null;
  if (!pm) return { ok: false, code: 'ROSTER_NO_PM', sessionId: '', name: '' };
  const sessionId = String(pm.sessionId || '').trim();
  if (!sessionId) return { ok: false, code: 'ROSTER_PM_NO_SESSION', sessionId: '', name: String(pm.name || '') };
  return { ok: true, code: 'OK', sessionId, name: String(pm.name || '') };
}

/** 解析 workbench（对象或 JSON 文本）；坏 JSON → WB_UNREADABLE（调用方据此不改写）。 */
function readWorkbench(workbench) {
  if (workbench && typeof workbench === 'object') return { ok: true, data: workbench };
  if (typeof workbench === 'string') {
    try { return { ok: true, data: JSON.parse(workbench) }; } catch { return { ok: false, code: 'WB_UNREADABLE', data: null }; }
  }
  return { ok: false, code: 'WB_UNREADABLE', data: null };
}

function findProject(workbench, { projectId = '', projectName = '' } = {}) {
  const list = Array.isArray(workbench && workbench.projects) ? workbench.projects : [];
  const id = String(projectId || '');
  const name = String(projectName || '');
  if (id) {
    const byId = list.find((p) => String((p && p.id) || '') === id);
    if (byId) return byId;
  }
  if (name) {
    const byName = list.find((p) => String((p && p.name) || '') === name);
    if (byName) return byName;
  }
  return null;
}

/**
 * 算出 PM 身份对齐计划（纯函数、幂等）。
 * 返回：
 *   { status: 'aligned'|'no_change'|'unreadable'|'no_roster'|'no_project'|'no_workspace', code, message,
 *     targetSessionIds, audit }
 * 约定：只有 status==='aligned' 才需要调用方落盘（并写 audit）；'no_change' 不写盘、不写审计。
 */
function planPmIdentitySync({ team = null, workbench = null, projectId = '', projectName = '', at = '' } = {}) {
  const now = String(at || new Date().toISOString());
  const wb = readWorkbench(workbench);
  if (!wb.ok) {
    return { status: 'unreadable', code: 'WB_UNREADABLE', message: 'workbench.json 读不出来：不改写，界面显示「待写入」', targetSessionIds: null, audit: null };
  }
  const roster = readRosterPm(team);
  if (!roster.ok) {
    return { status: 'no_roster', code: roster.code, message: `名册里拿不到 PM 会话（${roster.code}）：不改写`, targetSessionIds: null, audit: null };
  }
  const project = findProject(wb.data, { projectId, projectName });
  if (!project) {
    return { status: 'no_project', code: 'WB_NO_PROJECT', message: 'workbench 里没有该项目：不改写', targetSessionIds: null, audit: null };
  }
  const workspace = (project.workspace && typeof project.workspace === 'object') ? project.workspace : null;
  if (!workspace || !Array.isArray(workspace.sessionIds)) {
    return { status: 'no_workspace', code: 'WB_NO_WORKSPACE', message: '该项目没有 workspace.sessionIds：不改写', targetSessionIds: null, audit: null };
  }
  const current = workspace.sessionIds.map(String);
  const pmSid = roster.sessionId;
  if (current.includes(pmSid)) {
    return { status: 'no_change', code: 'OK', message: '工作区绑定已包含名册 PM 会话', targetSessionIds: current, audit: null };
  }
  const targetSessionIds = [...new Set([...current, pmSid])];
  const audit = {
    at: now,
    action: 'pm_identity_sync',
    project: String(project.name || project.id || projectName || ''),
    role: 'pm',
    fromSessionId: '', // 名册换人前后的旧 PM 会话不一定留在工作区里，留空表示「名册声明新增」
    toSessionId: pmSid,
    result: 'aligned',
  };
  return { status: 'aligned', code: 'OK', message: `工作区绑定缺少名册 PM 会话，补入 ${pmSid.slice(0, 12)}`, targetSessionIds, audit };
}

/** 按计划生成新的 workbench 对象（不改入参）；返回 {changed, workbench, audit}。 */
function applyPmIdentitySync(workbench, plan, { projectId = '', projectName = '' } = {}) {
  const wb = readWorkbench(workbench);
  if (!wb.ok) return { changed: false, workbench: null, audit: null, code: 'WB_UNREADABLE' };
  if (!plan || plan.status !== 'aligned' || !Array.isArray(plan.targetSessionIds)) {
    return { changed: false, workbench: wb.data, audit: null, code: String((plan && plan.code) || 'NO_CHANGE') };
  }
  const data = JSON.parse(JSON.stringify(wb.data));
  const project = findProject(data, { projectId, projectName });
  if (!project || !project.workspace) return { changed: false, workbench: data, audit: null, code: 'WB_NO_PROJECT' };
  project.workspace.sessionIds = plan.targetSessionIds.slice();
  project.workspace.updatedAt = String((plan.audit && plan.audit.at) || new Date().toISOString());
  return { changed: true, workbench: data, audit: plan.audit, code: 'OK' };
}

/** 校验审计行只含冻结的 7 键（接线层写审计前调用；多余键视为实现漂移）。 */
function validateAuditRow(row) {
  const keys = Object.keys(row || {}).sort();
  const expected = PM_IDENTITY_AUDIT_KEYS.slice().sort();
  if (keys.join(',') !== expected.join(',')) {
    return { ok: false, code: 'AUDIT_SCHEMA_MISMATCH', expected, actual: keys };
  }
  if (String(row.action) !== 'pm_identity_sync') return { ok: false, code: 'AUDIT_ACTION_INVALID', actual: String(row.action) };
  return { ok: true, code: 'OK' };
}

module.exports = {
  PM_IDENTITY_AUDIT_KEYS,
  readRosterPm,
  readWorkbench,
  findProject,
  planPmIdentitySync,
  applyPmIdentitySync,
  validateAuditRow,
};
