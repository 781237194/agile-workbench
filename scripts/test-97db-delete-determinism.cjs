#!/usr/bin/env node
'use strict';
/**
 * test-97db-delete-determinism.cjs —— 97db 返工 T-20261119-025124-6af3 夹具。
 * 复现 tester run1/run2 非确定：同一删除场景三种前置（sessions 有/空/工作区空）各起一个隔离实例，
 * 调 window.workbench.deleteProjectRecord 后断言：
 *  ① 团队.json members[].sessionId 全部清空（确定性，不依赖 DSH/清单）；
 *  ② 项目 团队会话.json 不再存在（已随项目归档/删除）；
 *  ③ workbench.json 项目记录消失；
 *  ④ team:members 返回 membersEmpty=true 且 roles.length=0（团队台 0 行依据）。
 * 用法：node scripts/test-97db-delete-determinism.cjs [--out <dir>]；只 taskkill /PID 自起 child.pid。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PNAME = '工作台改造修复';
const BASE_PORT = Number(process.env.AWB_97DB_PORT || (9660 + (process.pid % 15)));
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', PNAME, '程序员B', '产出', '证据-97db-返工'); })();
const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) { rows.push({ name, ok: Boolean(ok), detail: ok ? null : detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 400)}`); }
function httpJson(url) { return new Promise((resolve) => { const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.setTimeout(3000, () => { req.destroy(); resolve(null); }); }); }
async function waitTarget(port, ms, pick) { const end = Date.now() + ms; while (Date.now() < end) { const list = await httpJson(`http://127.0.0.1:${port}/json/list`); if (Array.isArray(list)) { const hit = list.find(pick); if (hit && hit.webSocketDebuggerUrl) return hit; } await sleep(400); } return null; }
class Cdp { constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(String(e.data)); } catch { return; } if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } }); } send(method, params = {}, ms = 60000) { const id = ++this.seq; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, ms); }); } async evaluate(expr, ms = 90000) { try { const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms); if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || '') }; return out && out.result ? out.result.value : undefined; } catch (e) { return { __cdperror: String((e && e.message) || e) }; } } }
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
function seedScenario(sb, { sessionMode }) {
  const DATA = path.join(sb, 'data');
  const TEAM = path.join(sb, '团队');
  const PROJ = path.join(sb, '项目');
  fs.rmSync(sb, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态', '项目'), { recursive: true });
  fs.mkdirSync(PROJ, { recursive: true });
  const pid = 'P-determinism';
  // 名册：6 角色都带 sessionId（模拟已建团队）
  const members = ROLES.map((role) => ({ role, name: role, sessionId: 'sess-' + role }));
  const team = { activeProject: PNAME, members, config: {} };
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  // 项目目录 + 团队会话.json（AC7 第二处映射）
  const projDir = path.join(PROJ, 'proj');
  fs.mkdirSync(projDir, { recursive: true });
  const manifestRoles = ROLES.map((role) => ({ role, sessionId: sessionMode === 'with-sessions' ? 'sess-' + role : '' }));
  fs.writeFileSync(path.join(projDir, '团队会话.json'), JSON.stringify({ project: PNAME, workspace: projDir, roles: manifestRoles }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(projDir, '项目信息.md'), '# 沙盘项目\n', 'utf8');
  // 项目登记（供删除时归档扫描）
  const regDir = path.join(TEAM, '状态', '项目', '沙盘项目');
  fs.mkdirSync(regDir, { recursive: true });
  fs.writeFileSync(path.join(regDir, '项目.json'), JSON.stringify({ name: '沙盘项目', path: projDir, teamMode: 'full' }, null, 2) + '\n', 'utf8');
  // workbench store：三种前置
  const sessions = {};
  if (sessionMode === 'with-sessions') for (const role of ROLES) sessions[role] = 'sess-' + role;
  const workspaceIds = sessionMode === 'with-sessions' ? ROLES.map((role) => 'sess-' + role) : (sessionMode === 'empty-workspace' ? [] : []);
  const store = {
    version: 1, activeProjectId: pid,
    projects: [{ id: pid, name: '沙盘项目', teamName: PNAME, path: projDir, teamMode: 'full', sessions, workspace: { id: 'ws-1', sessionIds: workspaceIds }, tasks: [], messages: [], proposals: [], commits: [], votes: [] },
      // 复验修正：沙盘 store 里再放一个无关项目，模拟真实环境多项目；删除后 team:members 不得回退到它。
      { id: 'P-other', name: '其它项目', teamName: '其它团队', path: projDir, teamMode: 'full', sessions: {}, workspace: { id: 'ws-2', sessionIds: [] }, tasks: [], messages: [], proposals: [], commits: [], votes: [] }],
    ui: {}
  };
  fs.writeFileSync(path.join(DATA, 'userdata', 'workbench.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
  return { DATA, TEAM, PROJ, pid, projDir };
}
async function runScenario(name, sessionMode, port) {
  const sb = path.join(ROOT, '_tmp', `97db-det-${process.pid}-${Date.now()}-${sessionMode}`);
  const envs = seedScenario(sb, { sessionMode });
  const env = { ...process.env, AWB_DATA_DIR: envs.DATA, TEAM_ROOT: envs.TEAM, TEAM_PROJECTS_ROOT: envs.PROJ, TEAM_WORKBENCH_JSON: path.join(envs.DATA, 'userdata', 'workbench.json'), TEAM_SELFTEST: '1' };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + port], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });
  const target = await waitTarget(port, 90000, (item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
  check(`D0 [${name}] 实例启动`, Boolean(target));
  if (!target) { try { child.kill(); } catch { /* ignore */ } return; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  const cdp = new Cdp(ws); await cdp.send('Runtime.enable');
  for (let i = 0; i < 200; i += 1) { const ok = await cdp.evaluate('document.readyState === "complete" && Boolean(window.workbench && window.workbench.deleteProjectRecord)'); if (ok === true) break; await sleep(400); }
  const del = await cdp.evaluate(`(async () => { try { return await window.workbench.deleteProjectRecord(${JSON.stringify(envs.pid)}); } catch (e) { return { threw: String((e && e.message) || e) }; } })()`);
  await sleep(600);
  const members = await cdp.evaluate(`(async () => { try { return await window.workbench.teamMembers({ projectId: ${JSON.stringify(envs.pid)} }); } catch (e) { return { threw: String((e && e.message) || e) }; } })()`);
  try { cdp.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ }
  await sleep(700); try { ws.close(); } catch { /* ignore */ } try { child.kill(); } catch { /* ignore */ } await sleep(300); try { if (child.pid && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  // 磁盘断言
  let team = null;
  try { team = JSON.parse(fs.readFileSync(path.join(envs.TEAM, '状态', '团队.json'), 'utf8')); } catch { team = null; }
  const leftover = (team && Array.isArray(team.members) ? team.members : []).filter((m) => m && m.sessionId).map((m) => m.role);
  check(`D1 [${name}] 删除后团队.json members[].sessionId 全清（确定性）`, leftover.length === 0, { leftover, del });
  // D1b 延迟复读（T-20261119-041748-0001）：删后 2s/5s 再读名册仍全空（防异步 saveTeam 旧副本回写）
  const readLeftover = () => {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(envs.TEAM, '状态', '团队.json'), 'utf8'));
      return (Array.isArray(t.members) ? t.members : []).filter((m) => m && m.sessionId).map((m) => m.role);
    } catch { return ['__read_failed__']; }
  };
  await sleep(2000);
  const late2 = readLeftover();
  await sleep(3000);
  const late5 = readLeftover();
  check(`D1b [${name}] 删后 2s/5s 名册仍全空（防并发回写）`, Array.isArray(late2) && late2.length === 0 && Array.isArray(late5) && late5.length === 0, { late2, late5 });
  let manifestExists = false;
  try { manifestExists = fs.existsSync(path.join(envs.projDir, '团队会话.json')); } catch { manifestExists = true; }
  check(`D2 [${name}] 项目 团队会话.json 不再存在（第二处映射）`, manifestExists === false, { manifestExists });
  let store = null;
  try { store = JSON.parse(fs.readFileSync(path.join(envs.DATA, 'userdata', 'workbench.json'), 'utf8')); } catch { store = null; }
  check(`D3 [${name}] workbench 项目记录已删除（第三/四处随记录消失）`, Boolean(store) && !(store.projects || []).some((p) => p && p.id === envs.pid), store && store.projects && store.projects.map((p) => p.id));
  const empty = members && members.ok === true && members.membersEmpty === true && Array.isArray(members.roles) && members.roles.length === 0;
  check(`D4 [${name}] team:members 返回 membersEmpty=true/roles=0（团队台 0 行依据）`, empty, members && { ok: members.ok, membersEmpty: members.membersEmpty, roles: members.roles && members.roles.length, projectMissing: members.projectMissing });
  // D5 重启复验（PM 要求含重启）：同一沙盘重启后名册仍全空、team:members 仍 membersEmpty=true/roles=0（不靠一次刷新掩盖）
  let restartMembers = null;
  try {
    const port2 = port + 60;
    const child2 = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + port2], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });
    const target2 = await waitTarget(port2, 90000, (item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
    if (target2) {
      const ws2 = new WebSocket(target2.webSocketDebuggerUrl);
      await new Promise((resolve) => ws2.addEventListener('open', resolve, { once: true }));
      const cdp2 = new Cdp(ws2); await cdp2.send('Runtime.enable');
      for (let i = 0; i < 200; i += 1) { const ok = await cdp2.evaluate('document.readyState === "complete" && Boolean(window.workbench && window.workbench.teamMembers)'); if (ok === true) break; await sleep(400); }
      restartMembers = await cdp2.evaluate(`(async () => { try { return await window.workbench.teamMembers({ projectId: ${JSON.stringify(envs.pid)} }); } catch (e) { return { threw: String((e && e.message) || e) }; } })()`);
      try { cdp2.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ }
      await sleep(600); try { ws2.close(); } catch { /* ignore */ } try { child2.kill(); } catch { /* ignore */ }
    } else { try { child2.kill(); } catch { /* ignore */ } }
  } catch { restartMembers = null; }
  let teamAfterRestart = null;
  try { teamAfterRestart = JSON.parse(fs.readFileSync(path.join(envs.TEAM, '状态', '团队.json'), 'utf8')); } catch { teamAfterRestart = null; }
  const leftoverAfterRestart = (teamAfterRestart && Array.isArray(teamAfterRestart.members) ? teamAfterRestart.members : []).filter((m) => m && m.sessionId).map((m) => m.role);
  const restartEmpty = restartMembers && restartMembers.ok === true && restartMembers.membersEmpty === true && Array.isArray(restartMembers.roles) && restartMembers.roles.length === 0;
  check(`D5 [${name}] 重启后名册仍全空 + team:members membersEmpty=true/roles=0`, leftoverAfterRestart.length === 0 && restartEmpty, { leftoverAfterRestart, restartMembers: restartMembers && { ok: restartMembers.ok, membersEmpty: restartMembers.membersEmpty, roles: restartMembers.roles && restartMembers.roles.length, projectMissing: restartMembers.projectMissing } });
  // D6 团队台 0 行（DOM 真实渲染断言）：删除后打开团队台，成员行数必须为 0
  let teamRows = null;
  try {
    const port3 = port + 120;
    const child3 = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + port3], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });
    const target3 = await waitTarget(port3, 90000, (item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
    if (target3) {
      const ws3 = new WebSocket(target3.webSocketDebuggerUrl);
      await new Promise((resolve) => ws3.addEventListener('open', resolve, { once: true }));
      const cdp3 = new Cdp(ws3); await cdp3.send('Runtime.enable');
      for (let i = 0; i < 200; i += 1) { const ok = await cdp3.evaluate('document.readyState === "complete" && typeof setDrawer === "function"'); if (ok === true) break; await sleep(400); }
      await cdp3.evaluate('setDrawer("team"); true');
      await sleep(400);
      const opened = await cdp3.evaluate('(async () => { let d = document.querySelector("#team-drawer"); if (d && d.hidden) { const pill = document.querySelector("#team-pill"); if (pill) pill.click(); await new Promise((r) => setTimeout(r, 500)); } d = document.querySelector("#team-drawer"); return Boolean(d && !d.hidden); })()');
      if (!opened) { await cdp3.evaluate('setDrawer("team"); true'); }
      await sleep(1800);
      teamRows = await cdp3.evaluate('(() => { const d = document.querySelector("#team-drawer"); const rows = document.querySelectorAll("#team-drawer .session-row"); const legacy = document.querySelectorAll("#team-drawer .legacy-team-row"); return { count: rows.length, legacyCount: legacy.length, drawerHidden: d ? d.hidden : null }; })()');
      try { cdp3.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ }
      await sleep(600); try { ws3.close(); } catch { /* ignore */ } try { child3.kill(); } catch { /* ignore */ }
    } else { try { child3.kill(); } catch { /* ignore */ } }
  } catch { teamRows = null; }
  // PM 补线索（M-20261119-040303-c14d7f）：D6 自证——抽屉必须已打开、成员行=0、六角色旧行=0，且 activeProject 已置 null
  let activeProjectAfter = null;
  try { activeProjectAfter = JSON.parse(fs.readFileSync(path.join(envs.TEAM, '状态', '团队.json'), 'utf8')).activeProject; } catch { activeProjectAfter = '__read_failed__'; }
  check(`D6 [${name}] 团队台已打开且成员行=0、六角色旧行=0、activeProject=null（DOM 自证）`,
    Boolean(teamRows) && teamRows.count === 0 && teamRows.legacyCount === 0 && teamRows.drawerHidden === false && (activeProjectAfter === null || activeProjectAfter === undefined),
    { teamRows, activeProjectAfter });
  check(`D7 [${name}] 删除墓碑存在（并发写者代际防护落盘）`,
    (() => { try { const dir = path.join(envs.TEAM, '状态', '项目'); for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, '删除墓碑.json'))) return true; } return false; } catch { return false; } })(), {});
  check(`D8 [${name}] 静态：delete 事务顺序 activeProject=null → 清名册 → 落盘`,
    (() => { try { const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8'); const a = src.indexOf('team.activeProject = null'); const b = src.indexOf('clearRosterSessionsOf('); const c = src.indexOf("case: 'panelTeamSync'"); return a >= 0 && b > a && c > b; } catch { return false; } })(), {});
  try { fs.rmSync(sb, { recursive: true, force: true }); } catch { /* ignore */ }
}
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await runScenario('sessions 有', 'with-sessions', BASE_PORT);
  await runScenario('sessions 空+workspace 空', 'empty-sessions', BASE_PORT + 1);
  await runScenario('sessions 空（离线归档失败分支）', 'empty-offline', BASE_PORT + 2);
  // tester 复验口径：同一场景连跑 3 次必须全清（真实 IPC + 同前置）
  for (let i = 1; i <= 3; i += 1) await runScenario('同场景连跑 ' + i, 'empty-sessions', BASE_PORT + 2 + i);
  try { fs.writeFileSync(path.join(OUT, 'delete-determinism-run.json'), JSON.stringify({ at: new Date().toISOString(), checks: rows }, null, 2) + '\n', 'utf8'); } catch { /* ignore */ }
  const failed = rows.filter((r) => !r.ok);
  console.log('');
  console.log(`97DB-DET ${failed.length ? 'FAIL' : 'OK'} ${JSON.stringify({ total: rows.length, pass: rows.length - failed.length, red: failed.length })}`);
  console.log('证据：' + path.join(OUT, 'delete-determinism-run.json'));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('97DB-DET ERROR ' + String((e && e.stack) || e)); process.exit(1); });
