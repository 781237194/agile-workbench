#!/usr/bin/env node
'use strict';
/**
 * test-97db-mock-hooks.cjs —— 97db 返工补口 T-20261119-025312-f3aaba 夹具。
 * ①单元：workspace-mock 模块（AWB_DSH_BASE_URL / AWB_WORKSPACE_MOCK=fail|ok|reuse，不设=null 走真实路径）
 * ②集成：隔离实例设 AWB_WORKSPACE_MOCK=fail → window.workbench.teamRestore 返回 ok:false、
 *   code=WORKSPACE_CREATE_FAILED、restoreAudit.missing 含 'workspace'、项目目录写 恢复审计.jsonl（mock:true），
 *   且 workbench 记录不变（半恢复零写入）。
 * 用法：node scripts/test-97db-mock-hooks.cjs [--out <dir>]；只 taskkill /PID 自起 child.pid。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const PNAME = '工作台改造修复';
const SB = path.join(ROOT, '_tmp', `97db-mock-${process.pid}-${Date.now()}`);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const PROJ = path.join(SB, '项目', '沙盘项目');
const PORT = Number(process.env.AWB_97DB_MOCK_PORT || (9680 + (process.pid % 10)));
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', PNAME, '程序员B', '产出', '证据-97db-返工'); })();
const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) { rows.push({ name, ok: Boolean(ok), detail: ok ? null : detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 400)}`); }
function httpJson(url) { return new Promise((resolve) => { const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.setTimeout(3000, () => { req.destroy(); resolve(null); }); }); }
async function waitTarget(port, ms, pick) { const end = Date.now() + ms; while (Date.now() < end) { const list = await httpJson(`http://127.0.0.1:${port}/json/list`); if (Array.isArray(list)) { const hit = list.find(pick); if (hit && hit.webSocketDebuggerUrl) return hit; } await sleep(400); } return null; }
class Cdp { constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(String(e.data)); } catch { return; } if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } }); } send(method, params = {}, ms = 60000) { const id = ++this.seq; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, ms); }); } async evaluate(expr, ms = 90000) { try { const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms); if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || '') }; return out && out.result ? out.result.value : undefined; } catch (e) { return { __cdperror: String((e && e.message) || e) }; } } }
function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(DATA, 'dsh-home'), { recursive: true });
  try { fs.writeFileSync(path.join(DATA, 'dsh-home', '.credentials.json'), '{}', 'utf8'); } catch { /* ignore */ }
  fs.mkdirSync(path.join(TEAM, '状态', '项目', '沙盘项目'), { recursive: true });
  fs.mkdirSync(PROJ, { recursive: true });
  fs.writeFileSync(path.join(PROJ, '项目信息.md'), '# 沙盘项目\n', 'utf8');
  const team = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8').replace(/^\uFEFF/, ''));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = PNAME;
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(TEAM, '状态', '项目', '沙盘项目', '项目.json'), JSON.stringify({ name: '沙盘项目', path: PROJ, teamMode: 'full' }, null, 2) + '\n', 'utf8');
  const store = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'userdata', 'workbench.json'), 'utf8').replace(/^\uFEFF/, ''));
  const project = (store.projects || [])[0];
  project.path = PROJ; project.name = '沙盘项目'; project.teamName = PNAME; project.sessions = {}; project.workspace = { sessionIds: [] };
  store.projects = [project]; store.activeProjectId = project.id;
  fs.writeFileSync(path.join(DATA, 'userdata', 'workbench.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.mkdirSync(OUT, { recursive: true });
  return { projectId: project.id };
}
(async () => {
  const mod = require(path.join(ROOT, 'src', 'workspace-mock.js'));
  // 单元
  const info = mod.workspaceMockOf({ AWB_WORKSPACE_MOCK: 'FAIL', AWB_DSH_BASE_URL: 'http://127.0.0.1:9' });
  check('U1 workspaceMockOf 识别 fail + AWB_DSH_BASE_URL', info.workspaceMock === 'fail' && info.dshBaseUrl === 'http://127.0.0.1:9', info);
  check('U2 fail 结果 ok=false + WORKSPACE_CREATE_FAILED', (() => { const r = mod.mockWorkspaceResult({ mode: 'fail', project: { path: 'x' }, current: null }); return r.ok === false && r.code === 'WORKSPACE_CREATE_FAILED' && r.mock === true; })());
  check('U3 ok 结果 ok=true + created', (() => { const r = mod.mockWorkspaceResult({ mode: 'ok', project: { path: 'x', name: 'P' }, current: null }); return r.ok === true && r.created === true && r.workspace.bound === true; })());
  check('U4 reuse 结果复用当前 workspace id', (() => { const r = mod.mockWorkspaceResult({ mode: 'reuse', project: {}, current: { id: 'ws-1' } }); return r.ok === true && r.workspaceId === 'ws-1' && r.created === false; })());
  check('U5 未设置 env → null（走真实路径）', mod.mockWorkspaceResult({ mode: '', project: {}, current: null }) === null);
  // 集成
  const seedInfo = seed();
  const env = { ...process.env, AWB_DATA_DIR: DATA, TEAM_ROOT: TEAM, TEAM_SELFTEST: '1', AWB_WORKSPACE_MOCK: 'fail', AWB_DSH_BASE_URL: 'http://127.0.0.1:9' };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });
  const target = await waitTarget(PORT, 90000, (item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
  check('U6 隔离实例启动', Boolean(target), seedInfo);
  if (target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
    const cdp = new Cdp(ws); await cdp.send('Runtime.enable');
    for (let i = 0; i < 200; i += 1) { const ok = await cdp.evaluate('document.readyState === "complete" && Boolean(window.workbench && window.workbench.teamRestore)'); if (ok === true) break; await sleep(400); }
    const res = await cdp.evaluate('(async () => { try { return await window.workbench.teamRestore({ name: "沙盘项目" }); } catch (e) { return { threw: String((e && e.message) || e) }; } })()');
    check('U7 mock fail：restore 返回 ok:false + WORKSPACE_CREATE_FAILED', Boolean(res) && res.ok === false && res.code === 'WORKSPACE_CREATE_FAILED', res);
    check('U8 restoreAudit.missing 含 workspace', Boolean(res && res.restoreAudit) && (res.restoreAudit.missing || []).includes('workspace') && res.restoreAudit.stages.workspace === false, res && res.restoreAudit);
    let auditRow = null;
    try { const lines = fs.readFileSync(path.join(PROJ, '恢复审计.jsonl'), 'utf8').trim().split('\n'); auditRow = JSON.parse(lines[lines.length - 1]); } catch { auditRow = null; }
    check('U9 项目目录 恢复审计.jsonl 记录 mock:true + missing=[workspace]', Boolean(auditRow) && auditRow.mock === true && (auditRow.missing || []).includes('workspace'), { mock: auditRow && auditRow.mock, missing: auditRow && auditRow.missing, code: res && res.code });
    let store = null;
    try { store = JSON.parse(fs.readFileSync(path.join(DATA, 'userdata', 'workbench.json'), 'utf8')); } catch { store = null; }
    check('U10 半恢复零写入（workbench 项目记录保持）', Boolean(store) && (store.projects || []).some((p) => p && p.path === PROJ), store && store.projects && store.projects.length);
    try { cdp.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ }
    await sleep(700); try { ws.close(); } catch { /* ignore */ } try { child.kill(); } catch { /* ignore */ } await sleep(300); try { if (child.pid && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  }
  // ② AC4 成功路径 sessions mock（AWB_WORKSPACE_MOCK=ok + AWB_SESSIONS_MOCK=six）：restore 应四段全 true、映射 6/6
  const env2 = { ...env, AWB_WORKSPACE_MOCK: 'ok' };
  const child2 = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + (PORT + 1)], { cwd: ROOT, env: env2, stdio: 'ignore', windowsHide: false });
  const target2 = await waitTarget(PORT + 1, 90000, (item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
  check('U11 AC4 sessions-mock 实例启动', Boolean(target2));
  if (target2) {
    const ws2 = new WebSocket(target2.webSocketDebuggerUrl);
    await new Promise((resolve) => ws2.addEventListener('open', resolve, { once: true }));
    const cdp2 = new Cdp(ws2); await cdp2.send('Runtime.enable');
    for (let i = 0; i < 200; i += 1) { const ok = await cdp2.evaluate('document.readyState === "complete" && Boolean(window.workbench && window.workbench.teamRestore)'); if (ok === true) break; await sleep(400); }
    const res2 = await cdp2.evaluate('(async () => { try { return await window.workbench.teamRestore({ name: "沙盘项目" }); } catch (e) { return { threw: String((e && e.message) || e) }; } })()');
    const auditOk = Boolean(res2 && res2.restoreAudit) && res2.restoreAudit.ok === true && (res2.restoreAudit.missing || []).length === 0;
    check('U12 AC4 ok 路径：restore ok:true + restoreAudit 四段全 true', Boolean(res2) && res2.ok === true && auditOk, res2 && { ok: res2.ok, audit: res2.restoreAudit, code: res2.code, why: res2.why });
    let store2 = null;
    try { store2 = JSON.parse(fs.readFileSync(path.join(DATA, 'userdata', 'workbench.json'), 'utf8')); } catch { store2 = null; }
    const proj2 = store2 && (store2.projects || []).find((p) => p && p.path === PROJ);
    const mapped = proj2 && proj2.sessions ? Object.values(proj2.sessions).filter(Boolean) : [];
    const wsIds = proj2 && proj2.workspace && Array.isArray(proj2.workspace.sessionIds) ? proj2.workspace.sessionIds.filter(Boolean) : [];
    check('U13 AC4 会话映射 6/6（projects[].sessions）', mapped.length === 6, { mapped: mapped.length });
    check('U14 workspace.sessionIds 含 6 个 mock 会话', wsIds.length >= 6, { wsIds: wsIds.length });
    try { cdp2.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ }
    await sleep(700); try { ws2.close(); } catch { /* ignore */ } try { child2.kill(); } catch { /* ignore */ } await sleep(300); try { if (child2.pid && child2.exitCode === null) spawnSync('taskkill', ['/PID', String(child2.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  }
  // ③ AC4 实景口径（tester M-20261119-035018-ec6bda）：workbench 项目记录已删、目录仍在 → 恢复应重建记录并让 sessions 段转绿
  try {
    const wb = JSON.parse(fs.readFileSync(path.join(DATA, 'userdata', 'workbench.json'), 'utf8'));
    wb.projects = (wb.projects || []).filter((x) => !(x && String(x.path || '').toLowerCase() === PROJ.toLowerCase()));
    fs.writeFileSync(path.join(DATA, 'userdata', 'workbench.json'), JSON.stringify(wb, null, 2) + '\n', 'utf8');
  } catch { /* ignore */ }
  const child3 = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + (PORT + 2)], { cwd: ROOT, env: env2, stdio: 'ignore', windowsHide: false });
  const target3 = await waitTarget(PORT + 2, 90000, (item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
  check('U15 记录已删场景实例启动', Boolean(target3));
  if (target3) {
    const ws3 = new WebSocket(target3.webSocketDebuggerUrl);
    await new Promise((resolve) => ws3.addEventListener('open', resolve, { once: true }));
    const cdp3 = new Cdp(ws3); await cdp3.send('Runtime.enable');
    for (let i = 0; i < 200; i += 1) { const ok = await cdp3.evaluate('document.readyState === "complete" && Boolean(window.workbench && window.workbench.teamRestore)'); if (ok === true) break; await sleep(400); }
    const res3 = await cdp3.evaluate('(async () => { try { return await window.workbench.teamRestore({ name: "沙盘项目" }); } catch (e) { return { threw: String((e && e.message) || e) }; } })()');
    const auditOk3 = Boolean(res3 && res3.restoreAudit) && res3.restoreAudit.ok === true && res3.restoreAudit.stages.sessions === true;
    check('U16 记录已删后恢复：ok:true 且四段全 true（含 sessions）', Boolean(res3) && res3.ok === true && auditOk3, res3 && { ok: res3.ok, audit: res3.restoreAudit, code: res3.code, why: res3.why });
    let store3 = null;
    try { store3 = JSON.parse(fs.readFileSync(path.join(DATA, 'userdata', 'workbench.json'), 'utf8')); } catch { store3 = null; }
    const project3 = store3 && (store3.projects || []).find((x) => x && String(x.path || '').toLowerCase() === PROJ.toLowerCase());
    const mapped3 = project3 && project3.sessions ? Object.values(project3.sessions).filter(Boolean) : [];
    check('U17 记录重建 + 会话映射 6/6', Boolean(project3) && mapped3.length === 6, { mapped: mapped3.length, exists: Boolean(project3) });
    try { cdp3.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ }
    await sleep(700); try { ws3.close(); } catch { /* ignore */ } try { child3.kill(); } catch { /* ignore */ } await sleep(300); try { if (child3.pid && child3.exitCode === null) spawnSync('taskkill', ['/PID', String(child3.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  }
  try { fs.writeFileSync(path.join(OUT, 'mock-hooks-run.json'), JSON.stringify({ at: new Date().toISOString(), checks: rows }, null, 2) + '\n', 'utf8'); } catch { /* ignore */ }
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = rows.filter((r) => !r.ok);
  console.log('');
  console.log(`97DB-MOCK ${failed.length ? 'FAIL' : 'OK'} ${JSON.stringify({ total: rows.length, pass: rows.length - failed.length, red: failed.length })}`);
  console.log('证据：' + path.join(OUT, 'mock-hooks-run.json'));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('97DB-MOCK ERROR ' + String((e && e.stack) || e)); process.exit(1); });
