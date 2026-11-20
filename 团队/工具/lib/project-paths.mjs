// 团队工作台 v2 · 项目级隔离路径（R-d19e 批①）
// 唯一口径：项目级优先、团队级兜底；消费点见需求 需求/R-20261120-021829-d19e §6.2/§6.9。
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, slug } from './core.mjs';

export function projectSlug(project) {
  return slug(String(project || '').trim(), 60);
}

/** `团队/状态/项目/<slug>`（与 store.projectStateDir 同口径）。 */
export function projectStateDirOf(project) {
  return path.join(PATHS.projectState, projectSlug(project));
}

/** 项目级子目录：启动 / 邮箱 / 锁 / owner-confirm / 授权。 */
export function projectSubdir(project, name) {
  return path.join(projectStateDirOf(project), String(name || ''));
}

export function bootTokenDirs(project) {
  return [projectSubdir(project, '启动'), PATHS.boots];
}

export function mailRoleDirs(project, role) {
  return [path.join(projectSubdir(project, '邮箱'), String(role || '')), path.join(PATHS.mail, String(role || ''))];
}

export function ownerConfirmDirs(project) {
  return [projectSubdir(project, 'owner-confirm'), path.join(PATHS.state, 'owner-confirm')];
}

/** 所有已知项目的 slug 目录（含未在名册里的历史目录）。 */
export function projectStateSlugs() {
  try {
    return fs.readdirSync(PATHS.projectState, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name)
      .filter((n) => !['_deleted', '_legacy', '_archive'].includes(n));
  } catch { return []; }
}

/** token → 令牌文件：先团队级（当前写入点），再逐个项目级；找不到返回 ''。 */
export function findBootTokenFile(token) {
  const name = `${String(token || '')}.json`;
  if (!token) return '';
  const teamFile = path.join(PATHS.boots, name);
  if (fs.existsSync(teamFile)) return teamFile;
  for (const s of projectStateSlugs()) {
    const f = path.join(PATHS.projectState, s, '启动', name);
    if (fs.existsSync(f)) return f;
  }
  return '';
}

/** 按项目找令牌文件：项目目录优先、团队级兜底。 */
export function findProjectBootTokenFile(project, token) {
  const name = `${String(token || '')}.json`;
  if (!token) return '';
  const proj = path.join(projectSubdir(project, '启动'), name);
  if (fs.existsSync(proj)) return proj;
  const team = path.join(PATHS.boots, name);
  return fs.existsSync(team) ? team : '';
}
