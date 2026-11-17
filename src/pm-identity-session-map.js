/**
 * B-20261117-210352-bb6f：PM 身份对齐时同步**第四处**映射 `项目/<项目>/团队会话.json`。
 *
 * 背景：壳层对齐只改 workbench.json（sessions + workspace.sessionIds），但 `checkSessionMap` 要求四处一致：
 *   团队.json 名册 / 团队会话.json roles[] / workbench.sessions / workbench.workspace.sessionIds。
 * 只改后两处 → 换 PM 不重启后新 PM 能 boot、能 task list，但 send 报 SESSION_MAP_INCONSISTENT（能看不能发）。
 *
 * 本模块只做「读 → 改 pm 一行 → tmp+rename 原子写」，不改其它角色、不改 团队.json（名册是真相，只读）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 团队会话.json 的默认路径：项目根（与 session.mjs 的读取口径一致）。 */
function sessionManifestPath(projectPath) {
  return path.join(String(projectPath || ''), '团队会话.json');
}

/**
 * 把 pm 角色的 sessionId 同步到 团队会话.json。
 * @returns {{ok:boolean, changed:boolean, code?:string, file:string, from?:string, to?:string, roles?:number}}
 */
function syncTeamSessionManifest(projectPath, pmSessionId) {
  const file = sessionManifestPath(projectPath);
  const sid = String(pmSessionId || '').trim();
  if (!sid) return { ok: false, changed: false, code: 'PM_SESSION_EMPTY', file };
  if (!fs.existsSync(file)) return { ok: false, changed: false, code: 'SESSION_MANIFEST_MISSING', file };
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: false, changed: false, code: 'SESSION_MANIFEST_INVALID', file }; }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.roles)) {
    return { ok: false, changed: false, code: 'SESSION_MANIFEST_INVALID', file };
  }
  const idx = raw.roles.findIndex((r) => r && String(r.role || '') === 'pm');
  if (idx < 0) return { ok: false, changed: false, code: 'SESSION_MANIFEST_NO_PM', file, roles: raw.roles.length };
  const from = String(raw.roles[idx].sessionId || '');
  if (from === sid) return { ok: true, changed: false, file, from, to: sid, roles: raw.roles.length };
  raw.roles[idx].sessionId = sid;
  raw.generatedAt = new Date().toISOString();
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return { ok: false, changed: false, code: 'SESSION_MANIFEST_UNWRITABLE', file, error: String((e && e.message) || e) };
  }
  return { ok: true, changed: true, file, from, to: sid, roles: raw.roles.length };
}

module.exports = { sessionManifestPath, syncTeamSessionManifest };
