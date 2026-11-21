'use strict';
/**
 * T-1205（P0）：启动期删除墓碑清扫的保守判定。
 *
 * 背景：`applyDeletionTombstonesOnStartup` 会扫所有墓碑；旧实现不看墓碑属于哪个团队，
 * 遇到旧项目的墓碑就会清空**当前全局名册**。实测重启后 16–21 秒出现 4 秒全空、随后被
 * 同步恢复，正是这条延迟路径。
 *
 * 规则（保守优先）：
 * - store 未就绪/无项目：不清（等下一次启动或人工）；
 * - 名册当前 activeProject 与墓碑团队不一致：不清（墓碑属于旧团队，绝不能动当前名册）；
 * - store 里仍有同名项目记录：不清（项目仍在，消费墓碑即可）；
 * - 其它：允许清（仅删除最后一个团队时才会走到）。
 */
function tombstoneClearDecision({ tombstoneTeam, teamActiveProject, storeProjects, storeReady } = {}) {
  const tomb = String(tombstoneTeam || '').trim();
  if (!tomb) return { allow: false, reason: 'empty-team' };
  if (!storeReady || !Array.isArray(storeProjects) || storeProjects.length === 0) {
    return { allow: false, reason: 'store-not-ready' };
  }
  const active = String(teamActiveProject || '').trim();
  if (active && active !== tomb) return { allow: false, reason: 'not-active-team' };
  const sameTeam = storeProjects.some((project) => project && String(project.teamName || project.name || '') === tomb);
  if (sameTeam) return { allow: false, reason: 'project-exists' };
  return { allow: true, reason: 'deleted-team' };
}

module.exports = { tombstoneClearDecision };
