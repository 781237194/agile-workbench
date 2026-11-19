#!/usr/bin/env node
'use strict';
/**
 * test-e6c1-archive-cleanup.cjs —— B-20261119-133232-e6c1 夹具（沙盘，真实 state 零写入）
 *   路径A 归档角色会话：session archive 后名册 sessionId / 项目 团队会话.json / workbench.projects[].sessions
 *        / 工作流 boots / 该角色旧 boot 令牌 全部同步清除；pm 令牌仍有效；归档记录与清理审计落盘。
 *   路径B 删除工作区：静态断言 project:delete-record 在 writeStore 后广播 session-queue/roster 变更（渲染同步）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TEAM = path.join(ROOT, '团队');
const TOOL = path.join(TEAM, '工具', 'team.mjs');
const ROWS = [];
const check = (name, ok, detail) => {
  ROWS.push({ name, ok: Boolean(ok) });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 500)));
  if (!ok) process.exitCode = 1;
};

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'e6c1-'));
const TEAM_ROOT = path.join(SB, '团队');
const PROJ_ROOT = path.join(SB, '项目');
const AWB_STORE = path.join(SB, 'data', 'userdata', 'workbench.json');
fs.mkdirSync(path.join(AWB_STORE, '..'), { recursive: true });
fs.mkdirSync(PROJ_ROOT, { recursive: true });
const env = { TEAM_ROOT, AWB_TEAM_ROOT: TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJ_ROOT, TEAM_SELFTEST: '1', AWB_DATA_DIR: path.join(SB, 'data'), AWB_STORE };
const project = 'e6c1-归档';
const run = (args) => {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 180000 });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
};
const runJson = (args) => {
  const r = run(args);
  try { return { ...r, json: JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1)) }; } catch { return { ...r, json: null }; }
};
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); };

try {
  check('S0 init', run(['init']).code === 0, {});
  check('S1 project add', run(['project', 'add', '--name', project, '--team-mode', 'full']).code === 0, {});

  const stateDir = path.join(TEAM_ROOT, '状态', '项目', project);
  const projectsDir = path.join(PROJ_ROOT, project);
  const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
  const projMeta0 = readJson(path.join(stateDir, '项目.json')) || {};
  const manifestFile = path.join(String(projMeta0.path || projectsDir), '团队会话.json');
  const wfFile = path.join(stateDir, '工作流.json');
  const sid = 'session-e6c1-test-1';

  // 种子：名册 + 项目映射 + workbench + 工作流 boot
  const team = readJson(teamFile) || { members: [] };
  const member = (team.members || []).find((m) => String(m.role || '') === 'programmer1');
  if (member) { member.sessionId = sid; member.bootedAt = new Date().toISOString(); }
  writeJson(teamFile, team);
  writeJson(manifestFile, { version: 1, project, workspacePath: projectsDir, roles: [{ role: 'programmer1', sessionId: sid }, { role: 'pm', sessionId: 'session-pm-e6c1' }] });
  const projMeta = readJson(path.join(stateDir, '项目.json')) || {};
  writeJson(AWB_STORE, { version: 1, activeProjectId: projMeta.id || 'P-e6c1', projects: [{ id: projMeta.id || 'P-e6c1', name: projMeta.name || project, teamName: projMeta.teamName || project, path: projectsDir, sessions: { programmer1: sid, pm: 'session-pm-e6c1' }, workspace: { sessionIds: [sid, 'session-pm-e6c1'] } }] });
  const wf = readJson(wfFile) || {};
  wf.boots = { ...(wf.boots || {}), programmer1: { at: new Date().toISOString(), sessionId: sid }, pm: { at: new Date().toISOString(), sessionId: 'session-pm-e6c1' } };
  writeJson(wfFile, wf);

  // 种子落盘后再 boot：团队.json 变更会使旧令牌 RULES_CHANGED。
  const tokenOf = (r) => {
    const direct = String((r.json && (r.json.token || (r.json.boot && r.json.boot.token))) || '');
    if (direct) return direct;
    const m = /令牌[:：]\s*([0-9a-f]{8,})/i.exec(String(r.out || ''));
    return m ? m[1] : '';
  };
  const pm = runJson(['boot', '--role', 'pm', '--project', project]);
  const dev = runJson(['boot', '--role', 'programmer1', '--project', project]);
  const pmTok = tokenOf(pm);
  const devTok = tokenOf(dev);
  check('S2 双角色 boot 成功（种子后）', Boolean(pmTok && devTok), { pm: pm.code, dev: dev.code, pmOut: pm.out.slice(-200), devOut: dev.out.slice(-200) });

  // 归档 programmer1
  const arch = runJson(['session', 'archive', '--boot', pmTok, '--role', 'programmer1', '--confirm', '--reason', 'e6c1 夹具', '--json']);
  check('A1 session archive 成功', arch.code === 0 && arch.json && arch.json.ok === true, { code: arch.code, json: arch.json, err: arch.err.slice(-300) });

  const teamAfter = readJson(teamFile) || {};
  const memberAfter = (teamAfter.members || []).find((m) => String(m.role || '') === 'programmer1');
  check('A2 名册 sessionId 已清（不再是已就绪）', Boolean(memberAfter) && String(memberAfter.sessionId || '') === '', { memberAfter });
  const manifestAfter = readJson(manifestFile) || {};
  const devRow = (manifestAfter.roles || []).find((r) => String((r && r.role) || '') === 'programmer1');
  check('A3 团队会话.json 该角色 sessionId 已清', Boolean(devRow) && String(devRow.sessionId || '') === '', { devRow, manifestFile, cleanup: arch.json && arch.json.cleanup });
  const storeAfter = readJson(AWB_STORE) || {};
  const projRow = (storeAfter.projects || [])[0] || {};
  check('A4 workbench projects[].sessions 已移除角色', !projRow.sessions || !Object.prototype.hasOwnProperty.call(projRow.sessions, 'programmer1'), { sessions: projRow.sessions });
  check('A5 workbench workspace.sessionIds 已剔除旧会话', !projRow.workspace || !Array.isArray(projRow.workspace.sessionIds) || !projRow.workspace.sessionIds.includes(sid), { workspace: projRow.workspace });
  const wfAfter = readJson(wfFile) || {};
  check('A6 工作流 boots 该角色已移除', !wfAfter.boots || !Object.prototype.hasOwnProperty.call(wfAfter.boots, 'programmer1'), { boots: wfAfter.boots });
  const oldBoot = run(['inbox', '--boot', devTok, '--all', '--json']);
  check('A7 该角色旧 boot 令牌已失效（boot 移除）', oldBoot.code !== 0 || /BOOT_INVALID|BOOT_REQUIRED/.test(oldBoot.out + oldBoot.err), { code: oldBoot.code, out: oldBoot.out.slice(-200) });
  const pmReboot = runJson(['boot', '--role', 'pm', '--project', project]);
  const pmTok2 = tokenOf(pmReboot);
  const pmStill = pmTok2 ? run(['inbox', '--boot', pmTok2, '--all', '--json']) : { code: 1, out: '', err: '' };
  check('A8 成员表变更后重新 boot pm 可继续用（旧令牌 RULES_CHANGED 属预期）', pmReboot.code === 0 && pmStill.code === 0, { reboot: pmReboot.code, inbox: pmStill.code });
  const cleanupLog = path.join(stateDir, '归档清理.jsonl');
  const cleanupRows = fs.existsSync(cleanupLog) ? fs.readFileSync(cleanupLog, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  const lastCleanup = cleanupRows.length ? JSON.parse(cleanupRows[cleanupRows.length - 1]) : null;
  const stepNames = lastCleanup && Array.isArray(lastCleanup.steps) ? lastCleanup.steps.map((s) => s.step) : [];
  check('A9 归档清理审计落盘且覆盖 roster/workbench/boots', cleanupRows.length >= 1 && ['roster', 'workbench', 'boots'].every((n) => stepNames.includes(n)), { rows: cleanupRows.length, steps: stepNames, warnings: lastCleanup && lastCleanup.warnings });
  const archiveDir = path.join(stateDir, '会话归档');
  const archiveFiles = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).filter((f) => f.startsWith('A-')) : [];
  check('A10 归档记录已落盘', archiveFiles.length >= 1, { archiveFiles });

  // 路径B：删除工作区后的渲染同步（静态接线）
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const deleteIdx = mainSrc.indexOf("ipcMain.handle('project:delete-record'");
  const sendIdx = mainSrc.indexOf("team:session-queue-changed', { reason: 'project-deleted'", deleteIdx);
  check('B1 delete-record 后广播 session-queue 变更', deleteIdx >= 0 && sendIdx > deleteIdx, { deleteIdx, sendIdx });
  // B-24f0（PM 裁定）：`team:roster-changed` 曾是死通道（main 发、preload 无 on、渲染层无订阅），
  // 已删除——这里改成「反向断言」：src 里不得再有该通道的发送调用（注释里提到它不算），
  // 防止以后又加回一条「夹具绿但没效果」的通道。
  const rosterChangedSender = /send\(\s*['"]team:roster-changed['"]/.test(mainSrc);
  check('B2 delete-record 不再发死通道 team:roster-changed（B-24f0 删除；重绘统一走 session-queue-changed）',
    deleteIdx >= 0 && !rosterChangedSender, { deleteIdx, rosterChangedSender });
  check('B3 广播位于 writeStore 之后（新状态已落盘）', sendIdx > mainSrc.indexOf('writeStore(fresh)', deleteIdx), {});
} finally {
  fs.rmSync(SB, { recursive: true, force: true });
}

const failed = ROWS.filter((r) => !r.ok);
console.log('');
console.log('E6C1-ARCHIVE-CLEANUP ' + (ROWS.length - failed.length) + '/' + ROWS.length + (failed.length ? ' FAIL' : ' PASS'));
process.exit(failed.length ? 1 : 0);
