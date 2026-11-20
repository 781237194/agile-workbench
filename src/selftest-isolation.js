'use strict';
/**
 * 自测模式的团队根隔离（P0：真实根跑 --selftest 反复改写 团队/状态/团队.json）
 *
 * 事故：本机用户级环境变量 `AWB_TEAM_ROOT` 指向真实仓库团队根，而 `--selftest` 只把
 * `TEAM_ROOT` 指进沙盘。`resolveTeamRoot()` 的优先级是 `AWB_TEAM_ROOT > TEAM_ROOT > 仓库`，
 * 于是自测里的 `syncTeamRosterSessions()` 把**真实** 团队.json 整表写回：`activeProject`
 * 变成沙盘项目、六角色 `sessionId` 被清空。
 *
 * 口径（PM M-20261120-142936-df781c ①「强制沙盘根 或 REAL_ROOT_SELFTEST_REFUSED」）：
 * 采用**硬拒**——解析出的团队根不在 SELFTEST_ROOT 内时，`--selftest` 立刻
 * `REAL_ROOT_SELFTEST_REFUSED` 退出（零写入），不再默默把真实根当沙盘用。
 *
 * 纯函数、无 Electron 依赖：夹具可直接 require 做单测。
 */
const path = require('node:path');

function isInsideRoot(root, candidate) {
  const p = path.resolve(root).toLowerCase();
  const c = path.resolve(candidate).toLowerCase();
  return c === p || c.startsWith(p + path.sep);
}

/** 解析出的团队根是否在沙盘内（严格包含，防止 AWB_TEAM_ROOT 指回真实根）。 */
function checkSelftestIsolation({ resolved, selftestRoot }) {
  if (!resolved) return false;
  return isInsideRoot(selftestRoot, resolved);
}

module.exports = { isInsideRoot, checkSelftestIsolation };
