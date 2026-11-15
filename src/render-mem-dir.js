'use strict';
/**
 * render-mem-dir.js —— R-c1ed 采样目录隔离（缺陷 B-20261115-171218-3fb8，P1）
 *
 * 缺陷：`renderMemoryProjectDir()` 走 `teamProjectStateDir()`，而 `teamProjectsDir()` 优先取
 * `teamTools.layout.teamRoot`（真实仓库 团队 目录），**忽略 TEAM_ROOT / AWB_DATA_DIR**。
 * 后果：测量实例与真实实例共写同一分片 `渲染内存-YYYYMMDD.jsonl`，证据纯度被破坏
 * （今日两次「行数远超拍数」假象的根因）。
 *
 * 本节口径（PM 要求）：①设了 AWB_TEAM_ROOT / TEAM_ROOT 就写到该根下；②未设时行为不变
 * （返回 '' 表示「没有隔离根，交给原有逻辑」）。
 */
const path = require('node:path');

function resolveIsolatedDir(input) {
  const opts = input && typeof input === 'object' ? input : {};
  const envRoot = typeof opts.envRoot === 'string' ? opts.envRoot.trim() : '';
  const projectName = typeof opts.projectName === 'string' ? opts.projectName.trim() : '';
  if (!envRoot || !projectName) return '';
  return path.join(envRoot, '状态', '项目', projectName);
}

module.exports = { resolveIsolatedDir };
