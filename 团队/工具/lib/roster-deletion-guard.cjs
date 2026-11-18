'use strict';
/**
 * 97db 持久性守卫（T-20261119-044009-7ded / R1 T-20261119-050705-8a78）：写名册前检查删除墓碑。
 * 命中返回 blocked=true（调用方必须跳过写并审计），未命中 false。
 *
 * 规则（R1）：
 *  - 墓碑文件 = <stateDir>/删除墓碑.json（{teamName, deletedAt, generation, expiresAt?}）；
 *  - 墓碑过期（expiresAt 已过）→ 视为失效并顺手删除（同名重建不再被永久拦）；
 *  - 若 workbench store 里又出现同名且目录存在的活跃项目（重建）→ 墓碑 consumed：删墓碑、放行；
 *  - workbench 路径解析不依赖单一环境变量：显式入参 → AWB_STORE → TEAM_WORKBENCH_JSON →
 *    <teamRoot>/../data/userdata/workbench.json（生产布局兜底）；
 *  - 读库失败时按「墓碑存在即拦截」处理（宁可不写，也不把删除态名册写回）。
 */
const fs = require('node:fs');
const path = require('node:path');

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function resolveWorkbenchFile(explicit, teamRoot) {
  const fromExplicit = String(explicit || '').trim();
  if (fromExplicit) return fromExplicit;
  const fromEnv = String(process.env.AWB_STORE || process.env.TEAM_WORKBENCH_JSON || '').trim();
  if (fromEnv) return fromEnv;
  const root = String(teamRoot || '').trim();
  if (root) return path.join(root, '..', 'data', 'userdata', 'workbench.json');
  return '';
}

function appendGuardAudit(stateDir, row) {
  try { fs.appendFileSync(path.join(String(stateDir), '名册守卫.jsonl'), JSON.stringify(row) + '\n', 'utf8'); } catch { /* 审计失败仍拦截 */ }
}

function deletionTombstoneBlocksRoster({ projectName, stateDir, workbenchFile, teamRoot, now = Date.now() } = {}) {
  const name = String(projectName || '').trim();
  if (!name || !stateDir) return { blocked: false, reason: 'missing-input' };
  const tombFile = path.join(String(stateDir), '删除墓碑.json');
  if (!fs.existsSync(tombFile)) return { blocked: false, reason: 'no-tombstone' };
  const tomb = readJsonSafe(tombFile);
  // R1：墓碑过期 → 失效并清理，不再永久拦截同名重建。
  const expiresAt = tomb && tomb.expiresAt ? Date.parse(String(tomb.expiresAt)) : NaN;
  if (Number.isFinite(expiresAt) && now > expiresAt) {
    try { fs.rmSync(tombFile, { force: true }); } catch { /* ignore */ }
    appendGuardAudit(stateDir, { at: new Date(now).toISOString(), project: name, action: 'tombstone_expired', generation: Number(tomb.generation) || 0 });
    return { blocked: false, reason: 'tombstone-expired', cleaned: true };
  }
  if (!tomb || !tomb.teamName) return { blocked: false, reason: 'bad-tombstone' };
  // R1：重建豁免读真实 store（不依赖单一 env）。语义保持「无状态豁免」：
  // 有同名且目录存在的项目即放行（不删墓碑——墓碑由壳层 rebuild sweep 统一 consumed，
  // 这样并发写者仍能命中同一条墓碑，夹具也保持可重放）。
  const wb = resolveWorkbenchFile(workbenchFile, teamRoot);
  if (wb && fs.existsSync(wb)) {
    const store = readJsonSafe(wb);
    if (store && Array.isArray(store.projects)) {
      const deletedAt = Date.parse(String(tomb.deletedAt || '')) || 0;
      const stillActive = store.projects.some((p) => {
        if (!p || String(p.teamName || p.name) !== name || !p.path || !fs.existsSync(String(p.path))) return false;
        // 有时间的项目：只有「删除之后新建/更新」的才算重建；缺时间戳时按存在即重建（向后兼容）。
        const bornAt = Date.parse(String(p.createdAt || p.updatedAt || '')) || 0;
        return !deletedAt || !bornAt || bornAt > deletedAt;
      });
      if (stillActive) return { blocked: false, reason: 'project-exists' };
    }
  }
  appendGuardAudit(stateDir, {
    at: new Date(now).toISOString(), project: name, action: 'roster_sync_blocked',
    reason: 'deletion-tombstone', generation: Number(tomb.generation) || 0,
  });
  return { blocked: true, reason: 'deletion-tombstone', generation: Number(tomb.generation) || 0 };
}

module.exports = { deletionTombstoneBlocksRoster, resolveWorkbenchFile };