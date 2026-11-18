'use strict';
/**
 * B-20261118-080052-207b：launch「启动团队」的**会话复用判定 + 轮换记账**（纯逻辑，Node 可测）。
 *
 * 背景（07:39 事故）：launch 的复用条件只看 workspace.sessionIds，未命中就新建并**直接覆盖名册**——
 * 不写会话轮换记录、不广播、旧会话不标 retired，Owner 以为 PM 自己换人成功，实际需要人工唤醒新会话。
 *
 * 本模块只做两件事（调用方负责 DSH 交互与写盘）：
 *   ① pickReuse：三源复用判定（title + 团队.json 名册 sessionId + 项目映射 团队会话.json roles[]）；
 *   ② buildRotation：新建会话时生成轮换记录（含旧会话 retired 标记）+ 广播清单。
 */

/** 归一化路径（Windows 大小写/斜杠无关） */
function normDir(p) {
  return String(p || '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * 三源复用判定。
 * @param {object} input
 * @param {string} input.role            角色 id
 * @param {string} input.title           角色会话标题（`团队·PM` 这类）
 * @param {string} input.rosterSessionId 团队.json members[role].sessionId
 * @param {string} input.manifestSessionId workspace/团队会话.json roles[role].sessionId
 * @param {Array}  input.sessions        DSH client.list() 的 items（含 sessionId/cwd/archived/projections.values.title）
 * @param {string} input.workspace       目标工作区路径
 * @param {string[]} input.workspaceSessionIds 当前 workspace.sessionIds
 * @returns {{ sessionId:string, source:'roster'|'manifest'|'title'|'none', listed:boolean, archived:boolean, inWorkspace:boolean, cwdMatch:boolean }}
 */
function pickReuse(input = {}) {
  const role = String(input.role || '');
  const title = String(input.title || '');
  const workspace = normDir(input.workspace);
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const wsIds = new Set((Array.isArray(input.workspaceSessionIds) ? input.workspaceSessionIds : []).map(String));
  const byId = new Map();
  for (const s of sessions) {
    if (!s || !s.sessionId) continue;
    byId.set(String(s.sessionId), s);
  }
  const titleOf = (s) => String((s && s.projections && s.projections.values && s.projections.values.title) || '');
  const cwdMatches = (s) => Boolean(s) && Boolean(workspace) && normDir(s.cwd) === workspace;
  const describe = (s) => ({
    sessionId: String(s.sessionId),
    listed: true,
    archived: s.archived === true,
    inWorkspace: wsIds.has(String(s.sessionId)),
    cwdMatch: cwdMatches(s),
  });
  const unusable = (info) => !info || !info.listed || info.archived || !info.cwdMatch;

  // ① 名册（团队.json）——最强的「这就是这个人」凭据：只要在 DSH 存在且 cwd 匹配就复用，
  //    哪怕它不在 workspace.sessionIds（工作区重建/归档后很常见），走 unarchive 或重新加回工作区。
  const rosterId = String(input.rosterSessionId || '').trim();
  if (rosterId) {
    const info = byId.has(rosterId) ? describe(byId.get(rosterId)) : null;
    if (!unusable(info)) return { ...info, source: 'roster' };
  }
  // ② 项目映射（团队会话.json）
  const manifestId = String(input.manifestSessionId || '').trim();
  if (manifestId && manifestId !== rosterId) {
    const info = byId.has(manifestId) ? describe(byId.get(manifestId)) : null;
    if (!unusable(info)) return { ...info, source: 'manifest' };
  }
  // ③ 标题（要求 cwd 匹配 + 未归档；不再要求已在 workspace.sessionIds 里）
  if (title) {
    const hit = sessions.find((s) => s && s.sessionId && titleOf(s) === title && cwdMatches(s) && s.archived !== true);
    if (hit) return { ...describe(hit), source: 'title' };
  }
  return { sessionId: '', source: 'none', listed: false, archived: false, inWorkspace: false, cwdMatch: false, role };
}

/**
 * 生成轮换记录（新建会话且名册/映射原本指向别的会话时必须调用）。
 * @returns null（无需轮换）或 { record, jsonl, broadcasts, retiredSessionId }
 */
function buildRotation(input = {}) {
  const role = String(input.role || '');
  const from = String(input.from || '').trim();
  const to = String(input.to || '').trim();
  if (!to || !from || from === to) return null;
  const at = String(input.at || new Date().toISOString());
  const project = String(input.project || '');
  const id = String(input.recordId || '').trim() || `RO-${at.replace(/[-:TZ.]/g, '').slice(0, 14)}-${role}`;
  const record = {
    id, project, role, from, to, at,
    by: 'launch', reason: String(input.reason || 'launch 未找到可复用会话，新建后替换名册'),
    status: 'active', mode: 'auto', retiredAt: null,
    created: true,
    retiredSession: { sessionId: from, status: 'retired', retiredAt: at },
  };
  const jsonl = {
    at, project, role, from, to,
    by: 'launch', mode: 'auto', created: true,
    reason: record.reason,
    retiredSessionId: from,
  };
  // 广播：该角色本人（去新会话 boot）+ 其余 active 成员（名册变了 → 全员旧令牌失效，必须重 boot）
  const members = Array.isArray(input.members) ? input.members : [];
  const others = members
    .filter((m) => m && m.role !== role && (!m.status || m.status === 'active'))
    .map((m) => String(m.role));
  return {
    record,
    jsonl,
    retiredSessionId: from,
    broadcasts: { role, others },
  };
}

export { pickReuse, buildRotation, normDir };
export default { pickReuse, buildRotation, normDir };
