#!/usr/bin/env node
'use strict';
/**
 * test-24f0-observability.cjs —— B-20261119-153615-24f0（e6c1 三条观测项收口 · 壳层侧）
 *
 * 覆盖三条：
 *  ① 死通道 `team:roster-changed` 已删除（main 不再发；preload 从未订阅；夹具改成反向断言，防止加回）。
 *  ② 成员数口径（PM 2026-11-19 裁定）：成员数 = 名册行数；归档只清会话绑定/就绪状态、**名册行保留**
 *     → `team:members` 同时给 `memberCount`（名册行）与 `readyCount`（有会话的 active 成员），归档/删项目使
 *     `readyCount` 下降而 `memberCount` 不变。
 *  ③ 删当前项目后 activeProject 统一为「落剩余团队项目；无剩余则 null」（`src/roster-observability.js`）。
 *
 * 用法：
 *   node scripts/test-24f0-observability.cjs              # 单元 + 静态（快）
 *   node scripts/test-24f0-observability.cjs --electron    # 追加真实壳层（CDP：team:members 计数 + 两次删项目）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WANT_ELECTRON = process.argv.includes('--electron');
const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return i > 0 && process.argv[i + 1]
    ? path.resolve(process.argv[i + 1])
    : path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-24f0');
})();

const rows = [];
const skipped = [];
function check(name, ok, detail) {
  let text = '';
  try { text = JSON.stringify(detail === undefined ? null : detail); } catch { text = String(detail); }
  rows.push({ name, ok: Boolean(ok), detail: ok ? undefined : text });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' :: ' + text.slice(0, 700)));
}
function skip(name, detail) { skipped.push({ name, detail: String(detail || '') }); console.log('SKIP  ' + name + ' :: ' + String(detail || '')); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function read(rel) { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; } }

const lib = require(path.join(ROOT, 'src', 'roster-observability.js'));
const mainSrc = read('src/main.js');
const preloadSrc = read('src/preload.js');
const e6c1Src = read('scripts/test-e6c1-archive-cleanup.cjs');

const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const TEAM_NAME = '同团队';
const membersFull = () => ROLES.map((role) => ({ role, name: role, status: 'active', sessionId: 'sess-' + role }));

// ── U 单元：成员数口径 ────────────────────────────────────────────────────
(function unit() {
  const full = lib.rosterCounts(membersFull());
  check('U1 六人齐全：memberCount=6 / readyCount=6 / archivedCount=0',
    full.memberCount === 6 && full.activeCount === 6 && full.readyCount === 6 && full.archivedCount === 0 && full.unboundActiveCount === 0, full);

  // PM ②：归档只清「会话绑定」，名册行保留 → memberCount 不变、readyCount 减一
  const clearedOne = lib.rosterCounts(membersFull().map((m) => (m.role === 'tester' ? { ...m, sessionId: '' } : m)));
  check('U2 归档只清会话绑定（行保留）：memberCount 仍 6、readyCount=5、unboundActiveCount=1',
    clearedOne.memberCount === 6 && clearedOne.readyCount === 5 && clearedOne.unboundActiveCount === 1 && clearedOne.activeCount === 6, clearedOne);

  // 另一种归档形态（status 置非 active）：行仍在，activeCount/readyCount 减一
  const archivedOne = lib.rosterCounts(membersFull().map((m) => (m.role === 'tester' ? { ...m, status: 'archived', sessionId: '' } : m)));
  check('U3 status=archived 形态：memberCount 仍 6、activeCount=5、archivedCount=1、readyCount=5',
    archivedOne.memberCount === 6 && archivedOne.activeCount === 5 && archivedOne.archivedCount === 1 && archivedOne.readyCount === 5, archivedOne);

  const empty = lib.rosterCounts(null);
  check('U4 空名册：全部计数为 0（不抛错）',
    empty.memberCount === 0 && empty.readyCount === 0 && empty.archivedCount === 0, empty);

  // ── U5–U9 删项目后 activeProject 落点 ──
  const p1 = { id: 'P-1', name: '项目A', teamName: TEAM_NAME };
  const p2 = { id: 'P-2', name: '项目B', teamName: TEAM_NAME };
  const other = { id: 'P-3', name: '别家项目', teamName: '别的团队' };
  const untouched = lib.decideActiveProject({ currentActive: '别的项目', deletedNames: ['项目A', TEAM_NAME], remainingProjects: [p1] });
  check('U5 当前 active 不是被删项目 → 不动（untouched）', untouched.activeProject === '别的项目' && untouched.changed === false && untouched.reason === 'untouched', untouched);

  const noRemaining = lib.decideActiveProject({ currentActive: TEAM_NAME, deletedNames: ['项目A', TEAM_NAME], remainingProjects: [] });
  check('U6 无剩余团队项目 → null（no-remaining）', noRemaining.activeProject === null && noRemaining.changed === true && noRemaining.reason === 'no-remaining', noRemaining);

  const fallback = lib.decideActiveProject({ currentActive: TEAM_NAME, deletedNames: ['项目A', TEAM_NAME], remainingProjects: [p2] });
  check('U7 有剩余同团队项目 → 落到它（remaining-team-project，pickId=P-2）',
    fallback.activeProject === TEAM_NAME && fallback.changed === true && fallback.reason === 'remaining-team-project' && fallback.pickId === 'P-2', fallback);

  const otherTeamOnly = lib.decideActiveProject({ currentActive: TEAM_NAME, deletedNames: ['项目A', TEAM_NAME], remainingProjects: [other] });
  check('U8 只剩别的团队项目 → 不接管，落 null', otherTeamOnly.activeProject === null && otherTeamOnly.reason === 'no-remaining', otherTeamOnly);

  const emptyActive = lib.decideActiveProject({ currentActive: '', deletedNames: ['项目A'], remainingProjects: [p2] });
  check('U9 原本没有 activeProject → null 且不标记 changed', emptyActive.activeProject === null && emptyActive.changed === false, emptyActive);
})();

// ── S 静态接线 ────────────────────────────────────────────────────────────
check('S1 死通道 team:roster-changed 在 src 里已无发送点（B-24f0 删除）',
  !/team:roster-changed['"]\s*,/.test(mainSrc) && !/team:roster-changed/.test(preloadSrc), {
    mainHits: (mainSrc.match(/team:roster-changed/g) || []).length, preloadHits: (preloadSrc.match(/team:roster-changed/g) || []).length
  });
check('S2 delete-record 仍广播 session-queue-changed(reason=project-deleted)（重绘不丢）',
  /team:session-queue-changed', \{ reason: 'project-deleted'/.test(mainSrc), null);
check('S3 夹具改成反向断言：e6c1 的 B2 断言「不再有该通道的发送调用」',
  e6c1Src.includes('B2 delete-record 不再发死通道') && e6c1Src.includes('rosterChangedSender') && e6c1Src.includes('team:roster-changed'), null);
check('S4 main.js 接线纯逻辑模块：require + rosterCounts + decideActiveProject',
  /require\('\.\/roster-observability\.js'\)/.test(mainSrc)
  && /rosterObservability\.rosterCounts\(/.test(mainSrc)
  && /rosterObservability\.decideActiveProject\(/.test(mainSrc), null);
check('S5 team:members 返回体带名册口径计数（memberCount/activeCount/readyCount/archivedCount/unboundActiveCount）',
  ['memberCount: rosterCountsNow.memberCount', 'readyCount: rosterCountsNow.readyCount', 'archivedCount: rosterCountsNow.archivedCount', 'unboundActiveCount: rosterCountsNow.unboundActiveCount'].every((t) => mainSrc.includes(t)), null);
check('S6 删项目时记录观测字段（activeProjectReason / activeProjectPickId），便于事后回查',
  /removed\.activeProjectReason = next\.reason/.test(mainSrc) && /removed\.activeProjectPickId/.test(mainSrc), null);

// ── E 真实壳层（--electron）───────────────────────────────────────────────
async function connect(port) {
  const list = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
      let body = '';
      res.on('data', (d) => { body += String(d); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('cdp list timeout')));
  });
  const targets = Array.isArray(list) ? list : [];
  const target = targets.find((t) => t && t.webSocketDebuggerUrl && t.type === 'page' && /renderer[\\/]index\.html/.test(String(t.url || '')))
    || targets.find((t) => t && t.webSocketDebuggerUrl && t.type === 'page');
  if (!target) throw new Error('no page target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('ws open failed')); });
  const evaluate = (expr, ms = 60000) => new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e6);
    const timer = setTimeout(() => reject(new Error('evaluate timeout')), ms);
    const onMsg = (ev) => {
      let msg = null;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (!msg || msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMsg);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  return { evaluate, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}

function seed(sb) {
  const DATA = path.join(sb, 'data');
  const TEAM = path.join(sb, '团队');
  const PROJ = path.join(sb, '项目');
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态', '项目', TEAM_NAME), { recursive: true });
  const projDirA = path.join(PROJ, 'project-a');
  const projDirB = path.join(PROJ, 'project-b');
  fs.mkdirSync(projDirA, { recursive: true });
  fs.mkdirSync(projDirB, { recursive: true });
  // 名册：pm..programmer2 有会话；tester 只有行、无会话（模拟"归档只清会话绑定、行保留"后的形态）
  const members = ROLES.map((role) => ({ role, name: role, status: 'active', sessionId: role === 'tester' ? '' : 'sess-' + role }));
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify({ activeProject: TEAM_NAME, members, config: {} }, null, 2) + '\n', 'utf8');
  for (const dir of [projDirA, projDirB]) {
    fs.writeFileSync(path.join(dir, '团队会话.json'), JSON.stringify({ project: TEAM_NAME, workspace: dir, roles: members.map((m) => ({ role: m.role, sessionId: m.sessionId })) }, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, '项目信息.md'), '# 沙盘项目\n', 'utf8');
  }
  fs.writeFileSync(path.join(TEAM, '状态', '项目', TEAM_NAME, '项目.json'), JSON.stringify({ name: TEAM_NAME, path: projDirA, teamMode: 'full' }, null, 2) + '\n', 'utf8');
  const mk = (id, name, dir, ws) => ({ id, name, teamName: TEAM_NAME, path: dir, teamMode: 'full', sessions: {}, workspace: { id: ws, sessionIds: [] }, tasks: [], messages: [], proposals: [], commits: [], votes: [] });
  const store = { version: 1, activeProjectId: 'P-1', projects: [mk('P-1', '项目A', projDirA, 'ws-1'), mk('P-2', '项目B', projDirB, 'ws-2')], ui: {} };
  fs.writeFileSync(path.join(DATA, 'userdata', 'workbench.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
  return { DATA, TEAM, PROJ, projDirA, projDirB };
}

async function runElectron() {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'b24f0-'));
  let child = null;
  let cdp = null;
  try {
    const envs = seed(sb);
    const port = 19771 + Math.floor(Math.random() * 200);
    const env = {
      ...process.env,
      AWB_DATA_DIR: envs.DATA,
      TEAM_ROOT: envs.TEAM,
      TEAM_PROJECTS_ROOT: envs.PROJ,
      TEAM_WORKBENCH_JSON: path.join(envs.DATA, 'userdata', 'workbench.json'),
      TEAM_SELFTEST: '1',
      AWB_START_HIDDEN: '1',
      AWB_ROUTE_DAEMON: 'off',
    };
    child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + port], {
      cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += String(c || ''); });
    child.stderr.on('data', (c) => { out += String(c || ''); });
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try { cdp = await connect(port); break; } catch { await sleep(500); }
    }
    check('E0 真实壳层启动（CDP 可连）', Boolean(cdp), out.slice(-400));
    if (!cdp) return;
    for (let i = 0; i < 120; i += 1) {
      const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(window.workbench && window.workbench.teamMembers)');
      if (ready === true) break;
      await sleep(400);
    }
    const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
    const teamFile = path.join(envs.TEAM, '状态', '团队.json');
    const storeFile = path.join(envs.DATA, 'userdata', 'workbench.json');

    // E1 成员数口径（IPC 真实返回）
    const before = await cdp.evaluate(`(async () => { try { return await window.workbench.teamMembers({ projectId: 'P-2' }); } catch (e) { return { threw: String((e && e.message) || e) }; } })()`);
    check('E1 team:members 名册口径：memberCount=6（含无会话行）/ readyCount=5 / unboundActiveCount=1',
      Boolean(before) && before.memberCount === 6 && before.readyCount === 5 && before.unboundActiveCount === 1,
      { memberCount: before && before.memberCount, readyCount: before && before.readyCount, unboundActiveCount: before && before.unboundActiveCount, threw: before && before.threw });

    // E2 删当前项目（P-1）→ activeProject 落「剩余同团队项目」（值仍为 同团队，但要有 reason/pickId 证据）
    const del1 = await cdp.evaluate(`(async () => { try { return await window.workbench.deleteProjectRecord('P-1'); } catch (e) { return { threw: String((e && e.message) || e) }; } })()`);
    // 删除涉及归档/落盘，等一拍再读盘
    await sleep(1200);
    const teamAfter1 = readJson(teamFile);
    const storeAfter1 = readJson(storeFile);
    check('E2 删 P-1 后 activeProject 落剩余同团队项目（reason=remaining-team-project、pickId=P-2）',
      Boolean(del1 && del1.ok) && Boolean(teamAfter1) && String(teamAfter1.activeProject || '') === TEAM_NAME
      && Boolean(del1.removed) && del1.removed.activeProjectReason === 'remaining-team-project' && del1.removed.activeProjectPickId === 'P-2',
      { ok: del1 && del1.ok, activeProject: teamAfter1 && teamAfter1.activeProject, removed: del1 && del1.removed && { reason: del1.removed.activeProjectReason, pick: del1.removed.activeProjectPickId, cleared: del1.removed.activeProjectCleared }, threw: del1 && del1.threw });
    check('E3 删 P-1 后状态库 activeProjectId 指向剩余项目 P-2',
      Boolean(storeAfter1) && String(storeAfter1.activeProjectId || '') === 'P-2' && !(storeAfter1.projects || []).some((p) => p && p.id === 'P-1'),
      { activeProjectId: storeAfter1 && storeAfter1.activeProjectId, ids: storeAfter1 && (storeAfter1.projects || []).map((p) => p.id) });

    // E4 名册行保留（成员数不减）：删项目清的是会话绑定，不是名册行。
    // 注意：删除后主窗可能重载（CDP 目标会失效），这里重连再取，取不到就按 400ms 重试。
    let after = null;
    for (let i = 0; i < 15 && !(after && typeof after.memberCount === 'number'); i += 1) {
      try { if (cdp) cdp.close(); } catch { /* ignore */ }
      try { cdp = await connect(port); } catch { cdp = null; }
      if (cdp) {
        const ret = await cdp.evaluate(`(async () => { try { return await window.workbench.teamMembers({ projectId: 'P-2' }); } catch (e) { return { threw: String((e && e.message) || e) }; } })()`);
        after = ret && typeof ret === 'object' ? ret : null;
      }
      if (after && typeof after.memberCount === 'number') break;
      await sleep(400);
    }
    check('E4 删项目后名册行保留：memberCount 仍 6（readyCount 允许下降）',
      Boolean(after) && after.memberCount === 6, { memberCount: after && after.memberCount, readyCount: after && after.readyCount, threw: after && after.threw });

    // E5 删最后一个项目 → activeProject=null（无剩余）
    const del2 = await cdp.evaluate(`(async () => { try { return await window.workbench.deleteProjectRecord('P-2'); } catch (e) { return { threw: String((e && e.message) || e) }; } })()`);
    await sleep(1200);
    const teamAfter2 = readJson(teamFile);
    const storeAfter2 = readJson(storeFile);
    check('E5 删最后一个项目后 activeProject 统一为 null（reason=no-remaining）',
      Boolean(del2 && del2.ok) && Boolean(teamAfter2) && (teamAfter2.activeProject === null || teamAfter2.activeProject === undefined)
      && Boolean(del2.removed) && del2.removed.activeProjectReason === 'no-remaining',
      { ok: del2 && del2.ok, activeProject: teamAfter2 && teamAfter2.activeProject, reason: del2 && del2.removed && del2.removed.activeProjectReason, threw: del2 && del2.threw });
    check('E6 删最后一个项目后状态库 activeProjectId 为 null', Boolean(storeAfter2) && (storeAfter2.activeProjectId === null || storeAfter2.activeProjectId === undefined),
      { activeProjectId: storeAfter2 && storeAfter2.activeProjectId });
  } finally {
    try { if (cdp) cdp.close(); } catch { /* ignore */ }
    try { if (child && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
    try { await sleep(150); if (child) child.kill(); } catch { /* ignore */ }
    try { fs.rmSync(sb, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

(async () => {
  if (WANT_ELECTRON) await runElectron();
  else skip('E0–E6 真实壳层（--electron）', '本次未加 --electron');
  const pass = rows.filter((r) => r.ok).length;
  const fail = rows.length - pass;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'test-24f0-observability.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      head: (() => { try { return spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(); } catch { return ''; } })(),
      task: 'B-20261119-153615-24f0', electron: WANT_ELECTRON,
      pass, fail, total: rows.length, skipped: skipped.length, rows, skippedRows: skipped,
    }, null, 2), 'utf8');
  } catch { /* ignore */ }
  console.log(`\n${pass}/${rows.length} PASS${fail ? ` · ${fail} FAIL` : ''}`);
  process.exit(fail ? 1 : 0);
})();
