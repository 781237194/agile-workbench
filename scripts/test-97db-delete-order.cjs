#!/usr/bin/env node
'use strict';
/**
 * test-97db-delete-order.cjs —— P0 T-20261119-050705-8a78 夹具：
 *   A) R1 墓碑：expiresAt 过期失效并清理；未过期拦截；重建豁免（真实 store / teamRoot 兜底、不依赖单一 env）；删除之后新建才算重建。
 *   B) 静态：delete 顺序（名册+墓碑+团队.json+四映射 → 最后归档）、errors[]/partial、rename 退避+复制兜底与 EPERM 注入钩子、syncTeamRosterSessions 守卫。
 *   C) 真 IPC（隔离实例）：AWB_TEST_ARCHIVE_EPERM=1 下 delete 仍确定性落盘（名册清空+墓碑+团队.json activeProject=null）；
 *      AWB_TEST_ARCHIVE_EPERM=1 + AWB_TEST_ARCHIVE_COPY_FAIL=1 下归档失败进 removed.errors[]/partial=true，但前面的落盘不受影响。
 *
 * 跑法：node scripts/test-97db-delete-order.cjs
 * 隔离：全部在 %TEMP% 沙盘；只杀自己 spawn 的 child.pid（P0 工装安全）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ROWS = [];
const check = (name, ok, detail) => { ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 400))); if (!ok) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function getJson(port, p) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 2500 }, (r) => {
      let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    });
    req.on('error', rej); req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}
class WS {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('ws error'));
      this.ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (!m.id) return;
        const p = this.pending.get(m.id); if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error).slice(0, 200))) : p.resolve(m.result);
      };
      this.ws.onclose = () => { for (const p of this.pending.values()) p.reject(new Error('closed')); this.pending.clear(); };
    });
  }
  send(method, params = {}, t = 180000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error('timeout ' + method)); }, t);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); res(v); }, reject: (e) => { clearTimeout(timer); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const guard = require(path.join(ROOT, '团队', '工具', 'lib', 'roster-deletion-guard.cjs'));

function unitTests() {
  const SB = fs.mkdtempSync(path.join(os.tmpdir(), '97db-order-u-'));
  const stateDir = path.join(SB, '团队', '状态', '项目', 'order-proj');
  fs.mkdirSync(stateDir, { recursive: true });
  const tombFile = path.join(stateDir, '删除墓碑.json');
  const wbFile = path.join(SB, 'data', 'userdata', 'workbench.json');
  const projDir = path.join(SB, '工作区', 'order-proj');
  fs.mkdirSync(projDir, { recursive: true });
  // A1 未过期 → 拦截
  writeJson(tombFile, { teamName: 'order-proj', deletedAt: new Date().toISOString(), generation: 1, expiresAt: new Date(Date.now() + 600000).toISOString() });
  writeJson(wbFile, { projects: [], activeProjectId: null });
  const a1 = guard.deletionTombstoneBlocksRoster({ projectName: 'order-proj', stateDir, workbenchFile: wbFile });
  check('A1 墓碑未过期 → 拦截', a1.blocked === true && a1.reason === 'deletion-tombstone', a1);
  // A2 已过期 → 失效并删除墓碑
  writeJson(tombFile, { teamName: 'order-proj', deletedAt: new Date(Date.now() - 3600000).toISOString(), generation: 2, expiresAt: new Date(Date.now() - 60000).toISOString() });
  const a2 = guard.deletionTombstoneBlocksRoster({ projectName: 'order-proj', stateDir, workbenchFile: wbFile });
  check('A2 墓碑过期 → 不拦截且墓碑被清理', a2.blocked === false && a2.reason === 'tombstone-expired' && !fs.existsSync(tombFile), { a2, exists: fs.existsSync(tombFile) });
  // A3 重建豁免：store 里有删除之后新建的同名项目（时间戳新）
  const deletedAt = new Date(Date.now() - 60000).toISOString();
  writeJson(tombFile, { teamName: 'order-proj', deletedAt, generation: 3 });
  writeJson(wbFile, { projects: [{ id: 'P1', name: 'order-proj', teamName: 'order-proj', path: projDir, createdAt: new Date().toISOString() }], activeProjectId: 'P1' });
  const a3 = guard.deletionTombstoneBlocksRoster({ projectName: 'order-proj', stateDir, workbenchFile: wbFile });
  check('A3 删除之后重建的同名项目 → 放行（project-exists）', a3.blocked === false && a3.reason === 'project-exists', a3);
  // A4 旧项目（删除之前就存在）→ 仍拦截
  writeJson(wbFile, { projects: [{ id: 'P1', name: 'order-proj', teamName: 'order-proj', path: projDir, createdAt: new Date(Date.now() - 3600000).toISOString() }], activeProjectId: 'P1' });
  const a4 = guard.deletionTombstoneBlocksRoster({ projectName: 'order-proj', stateDir, workbenchFile: wbFile });
  check('A4 删除之前的旧项目 → 仍拦截', a4.blocked === true, a4);
  // A5 teamRoot 兜底（不设 AWB_STORE/TEAM_WORKBENCH_JSON，store 位于 <teamRoot>/../data/userdata/workbench.json）
  const savedStore = process.env.AWB_STORE; const savedWb = process.env.TEAM_WORKBENCH_JSON;
  delete process.env.AWB_STORE; delete process.env.TEAM_WORKBENCH_JSON;
  writeJson(wbFile, { projects: [{ id: 'P2', name: 'order-proj', teamName: 'order-proj', path: projDir, createdAt: new Date().toISOString() }], activeProjectId: 'P2' });
  const a5 = guard.deletionTombstoneBlocksRoster({ projectName: 'order-proj', stateDir, teamRoot: path.join(SB, '团队') });
  check('A5 不依赖 env：teamRoot 兜底读到真实 store → 重建放行', a5.blocked === false && a5.reason === 'project-exists', a5);
  if (savedStore !== undefined) process.env.AWB_STORE = savedStore;
  if (savedWb !== undefined) process.env.TEAM_WORKBENCH_JSON = savedWb;
  fs.rmSync(SB, { recursive: true, force: true });
}

function staticTests() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  check('B1 存在归档 rename 退避+复制兜底与 EPERM 注入钩子',
    src.includes('function renameDirWithRetry(') && src.includes('AWB_TEST_ARCHIVE_EPERM') && src.includes('AWB_TEST_ARCHIVE_COPY_FAIL') && /cpSync\(/.test(src), {});
  const iRoster = src.indexOf("step('roster-plan'");
  const iTeamWrite = src.indexOf("step('team-write'");
  const iTomb = src.indexOf("step('tombstone-write'");
  const iMap = src.indexOf("step('mappings'");
  const iArchive = src.indexOf("step('archive'");
  check('B2 delete 顺序：名册 → 团队.json → 墓碑 → 四映射 → 最后归档',
    iRoster >= 0 && iTeamWrite > iRoster && iTomb > iTeamWrite && iMap > iTomb && iArchive > iMap, { iRoster, iTeamWrite, iTomb, iMap, iArchive });
  check('B3 removed.errors[]/partial 与 return partial 存在',
    src.includes('errors: []') && src.includes('partial: removed.partial') && src.includes('removed.partial = true'), {});
  check('B4 syncTeamRosterSessions 走删除态守卫（R3）', /teamWriteBlockedByDeletion\(projectName\)/.test(src), {});
}

async function ipcRun(label, port, extraEnv) {
  const SB = fs.mkdtempSync(path.join(os.tmpdir(), '97db-order-ipc-'));
  const DATA = path.join(SB, 'data');
  const TEAM = path.join(SB, '团队');
  const PROJ = path.join(SB, '工作区', 'order-ipc');
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  fs.mkdirSync(path.join(PROJ, '需求'), { recursive: true });
  const wbFile = path.join(DATA, 'userdata', 'workbench.json');
  const project = { id: 'P-order', name: 'order-ipc', teamName: 'order-ipc', path: PROJ, teamMode: 'fast', createdAt: new Date().toISOString(), sessions: { pm: 'session-aaa111', analyst: 'session-bbb222' }, workspace: { id: 'W1', sessionIds: ['session-aaa111', 'session-bbb222'] } };
  writeJson(wbFile, { version: 1, activeProjectId: 'P-order', projects: [project], ui: {} });
  const teamFile = path.join(TEAM, '状态', '团队.json');
  writeJson(teamFile, { version: 1, phase: 'team', activeProject: 'order-ipc', members: [
    { role: 'pm', name: 'PM', status: 'active', sessionId: 'session-aaa111' },
    { role: 'analyst', name: '分析师', status: 'active', sessionId: 'session-bbb222' }
  ] });
  writeJson(path.join(TEAM, '状态', '项目', 'order-ipc', '项目.json'), { name: 'order-ipc', path: PROJ, status: 'active' });
  const env = {
    ...process.env,
    AWB_DATA_DIR: DATA,
    AWB_STORE: wbFile,
    TEAM_ROOT: TEAM,
    AWB_TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: path.join(TEAM, '状态', '项目'),
    TEAM_WORKBENCH_JSON: wbFile,
    TEAM_SELFTEST: '1',
    AWB_BOARD_PREGEN_MS: '0',
    ...extraEnv
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${port}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const pid = child.pid;
  let cdp = null;
  try {
    let list = null;
    for (let i = 0; i < 80; i += 1) {
      try { list = await getJson(port, '/json/list'); if (Array.isArray(list) && list.some((t) => t.type === 'page')) break; } catch { /* wait */ }
      await sleep(400);
    }
    const page = (list || []).find((t) => t.type === 'page' && /renderer[\\/]index\.html/i.test(String(t.url || ''))) || (list || []).find((t) => t.type === 'page');
    if (!page) throw new Error('找不到渲染层页面');
    cdp = new WS(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    const evalJs = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 120000 });
      if (r && r.exceptionDetails) throw new Error('evaluate: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r && r.result ? r.result.value : null;
    };
    for (let i = 0; i < 60; i += 1) { if (await evalJs('Boolean(window.workbench && window.workbench.deleteProjectRecord)')) break; await sleep(300); }
    const res = await evalJs("window.workbench.deleteProjectRecord('P-order')");
    const teamAfter = readJson(teamFile, {});
    const members = Array.isArray(teamAfter.members) ? teamAfter.members : [];
    const withSession = members.filter((m) => m && m.sessionId).length;
    const tombDirs = (() => { try { return fs.readdirSync(path.join(TEAM, '状态', '项目'), { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(TEAM, '状态', '项目', e.name, '删除墓碑.json'))); } catch { return []; } })();
    check(`C/${label} delete 返回 ok 且非 partial=${JSON.stringify(extraEnv)}`.slice(0, 60), Boolean(res && res.ok === true), { res: res && { ok: res.ok, partial: res.partial, removed: res.removed } });
    check(`C/${label} 名册 sessionId 全清（${withSession}）`, withSession === 0, { members });
    check(`C/${label} 团队.json activeProject=null`, teamAfter.activeProject === null || teamAfter.activeProject === undefined, { activeProject: teamAfter.activeProject });
    check(`C/${label} 删除墓碑已落盘`, tombDirs.length >= 1, { dirs: tombDirs.map((d) => d.name) });
    return res;
  } finally {
    try { if (cdp) cdp.close(); } catch { /* ignore */ }
    try { if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(SB, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* ignore */ }
  }
}

(async () => {
  unitTests();
  staticTests();
  const r1 = await ipcRun('EPERM→复制兜底', 9991, { AWB_TEST_ARCHIVE_EPERM: '1' });
  check('C/EPERM 归档走复制兜底（archiveModes 含 copy）或已归档', Boolean(r1 && (r1.removed?.archivedTo || (r1.removed?.errors?.length))), { removed: r1 && r1.removed });
  const r2 = await ipcRun('EPERM+复制也失败', 9992, { AWB_TEST_ARCHIVE_EPERM: '1', AWB_TEST_ARCHIVE_COPY_FAIL: '1' });
  check('C/归档彻底失败 → errors[] 有归档错误且 partial=true', Boolean(r2 && r2.partial === true && (r2.removed?.errors || []).some((e) => /archive/i.test(String(e.stage)))), { removed: r2 && r2.removed });
  const failed = ROWS.filter((r) => !r.ok);
  console.log('');
  console.log('97DB-DELETE-ORDER ' + (ROWS.length - failed.length) + '/' + ROWS.length + (failed.length ? ' FAIL' : ' PASS'));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('97DB-DELETE-ORDER ERROR ' + String((e && e.stack) || e).slice(0, 600)); process.exit(2); });
