#!/usr/bin/env node
'use strict';
/**
 * B-20261118-164055-2a44（P2）：名册 sessionId 写入的**唯一实现**（CJS 版）。
 *
 * 背景（A 卷 v2 补报）：`团队/工具/lib/roster-writer.mjs` 是名册唯一写入口（applyMemberSession /
 * setMemberSession / pushRosterMember），但它是 ESM，Electron 33（Node 20）的 CJS 主进程无法 require(ESM)，
 * 于是壳层（`src/main.js` 两处 + `src/team-tools.js` 同名副本）各自直写 `member.sessionId =`，绕过了：
 *   · 格式校验（session-<字母数字->）
 *   · 旧副本拒绝（session-auto-* 形态 = 08:02 事故形态）
 *   · 审计（名册变更.jsonl）
 *
 * 本文件把这些逻辑收敛成 CJS 单源：
 *   - `roster-writer.mjs` 用 `import ... from './roster-apply.cjs'`（ESM→CJS 合法）后**re-export**，行为不变；
 *   - 壳层 `src/team-tools.js` / `src/main.js` 用 `require()` 调同一份函数。
 * 于是全仓「`.sessionId =`」只剩本文件一处（沙盘测试夹具除外，那里由 assertSandboxStatePath 守卫）。
 */

/** 旧代码副本形态（08:02 事故）：session-auto-<role>-<base36>；与 roster-writer.mjs 原正则**逐字一致**。 */
const LEGACY_SESSION_RE = /^session-auto-[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i;
/** 合法会话 id 形态（与 roster-writer 写前校验一致）。 */
const SESSION_ID_RE = /^session-[A-Za-z0-9-]+$/;

function isLegacySessionId(sessionId) {
  return LEGACY_SESSION_RE.test(String(sessionId || '').trim());
}

/**
 * 写前校验（纯函数）：空值=清空（合法）；旧副本形态拒绝；其它不符合 session-<字母数字-> 的拒绝。
 * 返回 { ok, sessionId, code?, reason? }；ok=false 时调用方必须保持名册原值（零写入）。
 */
function validateSessionId(sessionId) {
  const raw = sessionId === undefined || sessionId === null ? '' : String(sessionId);
  const s = raw.trim();
  if (!s) return { ok: true, sessionId: '', cleared: true };
  if (isLegacySessionId(s)) {
    return { ok: false, code: 'LEGACY_SESSION_ID_REFUSED', reason: '旧代码副本生成的 session-auto-* 形态', sessionId: s };
  }
  if (!SESSION_ID_RE.test(s)) {
    return { ok: false, code: 'SESSION_ID_INVALID', reason: '会话 id 必须形如 session-<字母数字和->', sessionId: s };
  }
  return { ok: true, sessionId: s };
}

/** 给一个 member 对象写 sessionId（可带额外字段）。**唯一的 `.sessionId =` 落点**。 */
function applyMemberSession(member, sessionId, extra = {}) {
  if (!member || typeof member !== 'object') return null;
  member.sessionId = String(sessionId === undefined || sessionId === null ? '' : sessionId);
  for (const [k, v] of Object.entries(extra || {})) {
    if (v !== undefined) member[k] = v;
  }
  return member;
}

/** 名册里按角色写 sessionId（launch / ops / rotate / 壳层同步的统一入口）；角色不存在返回 null。 */
function setMemberSession(team, role, sessionId, extra = {}) {
  const members = Array.isArray(team && team.members) ? team.members : [];
  const member = members.find((m) => m && String(m.role) === String(role)) || null;
  if (!member) return null;
  return applyMemberSession(member, sessionId, extra);
}

/** 新增成员（唯一 `members.push` 落点）。 */
function pushRosterMember(team, member) {
  if (!team || !member) return null;
  if (!Array.isArray(team.members)) team.members = [];
  team.members.push(member);
  return member;
}

/**
 * 把一个项目的 `sessions`（role → sessionId）同步进名册（壳层项目切换/旧协议 ensure 的共同实现）。
 * 语义与旧实现一致：**名册是当前项目快照**——不在 sessions 里的角色一律清空；缺失角色按 roleIds 补入册。
 * 但每个非空 id 先过 validateSessionId：非法/旧副本**保持原值并计入 rejected**（不静默写坏名册）。
 *
 * @returns {{changed:number, rejected:Array<{role:string,code:string,reason:string,sessionId:string}>, added:string[], cleared:string[]}}
 */
function syncRosterSessions(team, sessions, { roleIds = [], roleNames = {}, activeProject = '' } = {}) {
  const out = { changed: 0, rejected: [], added: [], cleared: [] };
  if (!team || !Array.isArray(team.members)) return out;
  const map = sessions && typeof sessions === 'object' ? sessions : {};
  for (const member of team.members) {
    if (!member || !member.role) continue;
    const wanted = map[member.role] ? String(map[member.role]).trim() : '';
    const current = String(member.sessionId || '');
    if (!wanted) {
      // B-d751（P0）：**读不到不清**。壳层在 DSH 不可达/会话列表为空时会把空 map 传进来，
      // 旧实现 `applyMemberSession(member, '')` 直接把名册写空 → 全队 send 被
      // SESSION_MAP_INCONSISTENT 拒死（2026-11-21 03:03 事故）。清理名册只允许走
      // clearRosterSessions（删项目/归档等显式路径），sync 只负责填空与更新。
      continue;
    }
    const v = validateSessionId(wanted);
    if (!v.ok) {
      // 非法值不覆盖名册（保持原值），交给调用方审计/报 PM。
      out.rejected.push({ role: String(member.role), code: v.code, reason: v.reason, sessionId: v.sessionId });
      continue;
    }
    if (current !== v.sessionId) {
      applyMemberSession(member, v.sessionId);
      out.changed += 1;
    }
  }
  for (const role of roleIds) {
    if (!map[role]) continue;
    if (team.members.some((m) => m && String(m.role) === String(role))) continue;
    const v = validateSessionId(map[role]);
    if (!v.ok) { out.rejected.push({ role: String(role), code: v.code, reason: v.reason, sessionId: v.sessionId }); continue; }
    pushRosterMember(team, {
      role: String(role),
      name: roleNames[role] || String(role),
      status: 'active',
      joinedAt: new Date().toISOString(),
      sessionId: v.sessionId,
    });
    out.changed += 1;
    out.added.push(String(role));
  }
  if (activeProject && team.activeProject !== activeProject) { team.activeProject = activeProject; }
  return out;
}

/** 删项目时清名册：只清「属于被删项目的会话」，其它项目当前名册不动。 */
function clearRosterSessions(team, doomedSessions, { activeProject = '' } = {}) {
  const out = { changed: 0, roles: [] };
  if (!team || !Array.isArray(team.members)) return out;
  const doomed = doomedSessions instanceof Set ? doomedSessions : new Set(Array.isArray(doomedSessions) ? doomedSessions.map(String) : []);
  for (const member of team.members) {
    if (!member || !member.sessionId) continue;
    if (!doomed.has(String(member.sessionId))) continue;
    applyMemberSession(member, '');
    out.changed += 1;
    out.roles.push(String(member.role || ''));
  }
  if (activeProject && team.activeProject === activeProject) team.activeProject = null;
  return out;
}

module.exports = {
  LEGACY_SESSION_RE,
  SESSION_ID_RE,
  isLegacySessionId,
  validateSessionId,
  applyMemberSession,
  setMemberSession,
  pushRosterMember,
  syncRosterSessions,
  clearRosterSessions,
};
