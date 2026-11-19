'use strict';
/**
 * B-20261119-153615-24f0（e6c1 三条观测项收口 · 壳层侧纯逻辑）
 *
 * 两件事各一个纯函数，便于单测与"口径唯一"：
 *
 * 1) 成员数口径（PM 2026-11-19 裁定）
 *    - 「成员数」= **名册行数**（`团队/状态/团队.json → members[]`），归档角色**不移除名册行**；
 *    - 归档只清「会话绑定 / 就绪状态 / boot 记录」（对应 Owner「归档应移除 boot」）；
 *    - 所以：`memberCount` 不因归档变化，`readyCount`（有 sessionId 的 active 成员）会减一。
 *
 * 2) 删当前项目后 activeProject 落点（PM 裁定）
 *    - 统一为「落剩余团队项目；无剩余则 null」；
 *    - 「剩余团队项目」= 状态库里除被删项目外、团队名与被删项目同一的已登记项目；
 *    - 多个剩余时按状态库顺序取第一个（确定性，并在返回值里给 fellTo/pickId）。
 */

function normStatus(value) {
  const s = String(value || '').trim();
  return s || 'active';
}

/**
 * 名册计数（唯一口径）。
 * @param {Array} members 团队.json 的 members[]
 * @returns {{memberCount:number, activeCount:number, readyCount:number, archivedCount:number, unboundActiveCount:number}}
 *   memberCount 名册行数（归档不变）；activeCount status=active 行数；
 *   readyCount active 且 sessionId 非空（= 界面「已就绪」口径）；archivedCount 非 active 行数；
 *   unboundActiveCount active 但无 sessionId（缺会话/待激活）。
 */
function rosterCounts(members) {
  const rows = Array.isArray(members) ? members.filter((m) => m && typeof m === 'object') : [];
  let activeCount = 0;
  let readyCount = 0;
  let archivedCount = 0;
  for (const row of rows) {
    if (normStatus(row.status) === 'active') {
      activeCount += 1;
      if (String(row.sessionId || '').trim()) readyCount += 1;
    } else {
      archivedCount += 1;
    }
  }
  return {
    memberCount: rows.length,
    activeCount,
    readyCount,
    archivedCount,
    unboundActiveCount: Math.max(0, activeCount - readyCount),
  };
}

/**
 * 删当前项目后 activeProject 的落点。
 * @param {object} input
 * @param {string} input.currentActive     当前 团队.json → activeProject
 * @param {string[]} input.deletedNames    被删项目的名/团队名变体（任一命中即视为"当前被删"）
 * @param {Array<{id?:string,name?:string,teamName?:string}>} [input.remainingProjects] 剩余已登记项目（状态库顺序）
 * @returns {{activeProject:string|null, changed:boolean, reason:string, pickId:string}}
 *   reason: untouched（当前 active 不是被删项目）| remaining-team-project | no-remaining
 */
function decideActiveProject(input = {}) {
  const currentActive = String(input.currentActive || '');
  const deletedNames = (Array.isArray(input.deletedNames) ? input.deletedNames : [])
    .map((x) => String(x || '').trim()).filter(Boolean);
  const remaining = Array.isArray(input.remainingProjects) ? input.remainingProjects.filter((p) => p && typeof p === 'object') : [];
  if (!currentActive || !deletedNames.includes(currentActive)) {
    return { activeProject: currentActive || null, changed: false, reason: 'untouched', pickId: '' };
  }
  // 剩余「同一团队成员」的项目：其 团队名（teamName||name）命中被删项目的名/团队名变体。
  const peers = remaining.filter((p) => deletedNames.includes(String(p.teamName || p.name || '').trim()));
  const pick = peers[0];
  if (pick) {
    return {
      activeProject: String(pick.teamName || pick.name || '').trim() || null,
      changed: true,
      reason: 'remaining-team-project',
      pickId: String(pick.id || ''),
    };
  }
  return { activeProject: null, changed: true, reason: 'no-remaining', pickId: '' };
}

module.exports = { rosterCounts, decideActiveProject };
