'use strict';
/**
 * 97db 持久性守卫（T-20261119-044009-7ded）：写名册前检查删除墓碑。
 * 命中返回 true（调用方必须跳过写并审计），未命中 false。
 *
 * 规则：
 *  - 墓碑文件 = <stateDir>/删除墓碑.json（{teamName, deletedAt, generation}）；
 *  - 若 workbench store 里又出现同名且目录存在的活跃项目（重建），墓碑不生效；
 *  - 读库失败时按「墓碑存在即拦截」处理（宁可不写，也不把删除态名册写回）。
 */
const fs = require('node:fs');
const path = require('node:path');

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function deletionTombstoneBlocksRoster({ projectName, stateDir, workbenchFile, now = Date.now() } = {}) {
  const name = String(projectName || '').trim();
  if (!name || !stateDir) return { blocked: false, reason: 'missing-input' };
  const tombFile = path.join(String(stateDir), '删除墓碑.json');
  if (!fs.existsSync(tombFile)) return { blocked: false, reason: 'no-tombstone' };
  const tomb = readJsonSafe(tombFile);
  if (!tomb || !tomb.teamName) return { blocked: false, reason: 'bad-tombstone' };
  if (workbenchFile) {
    const store = readJsonSafe(workbenchFile);
    if (store && Array.isArray(store.projects)) {
      const stillActive = store.projects.some((p) => p && String(p.teamName || p.name) === name && p.path && fs.existsSync(String(p.path)));
      if (stillActive) return { blocked: false, reason: 'project-exists' };
    }
  }
  try {
    fs.appendFileSync(path.join(String(stateDir), '名册守卫.jsonl'), JSON.stringify({
      at: new Date(now).toISOString(), project: name, action: 'roster_sync_blocked',
      reason: 'deletion-tombstone', generation: Number(tomb.generation) || 0,
    }) + '\n', 'utf8');
  } catch { /* 审计失败仍拦截 */ }
  return { blocked: true, reason: 'deletion-tombstone', generation: Number(tomb.generation) || 0 };
}

module.exports = { deletionTombstoneBlocksRoster };
