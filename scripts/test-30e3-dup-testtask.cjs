#!/usr/bin/env node
'use strict';
/**
 * test-30e3-dup-testtask.cjs —— P2 B-20261119-202738-30e3 夹具（测试任务双建拦截）
 *
 * 缺陷：`route-daemon.mjs → ensureTestTask` 只按「当轮 + owner=tester」去重，不同轮次的未闭环
 * route-daemon 测试任务不拦 → 同需求被建两条测试任务；且当轮里**已闭环**的任务也被当 existing → 该建的建不了。
 *
 * 要求（派单）：①未闭环 route-daemon 测试任务存在则不新建，审计 `route_skip_duplicate`；
 * ②PM 侧建单时提示已有未闭环测试任务；③夹具三场景：已有一条未闭环→不再建 / 已闭环→可建 / 并发两次只建一条。
 *
 * 断言：
 *  A 静态：ensureTestTask 里有 openDup + `route_skip_duplicate`；existing 也排除闭环；ops 有 dupTestTaskHint
 *  B1 已有一条未闭环（不同轮次）→ ensureTestTask 返回 duplicateSkipped=true、路由日志 `route_skip_duplicate`、任务数不变
 *  B2 已闭环 → ensureTestTask 新建一条（reused=false、任务数 +1）
 *  B3 连调两次（模拟并发/二拍）→ 任务数只 +1（第二次命中复用）
 *  B4 PM 侧 `task create --requirement <同一需求>` 返回体带 dupTestTaskHint（提示、不阻断）
 *  C 隔离：真实 团队.json / workbench.json sha256 不变
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const DAEMON_SRC = path.join(ROOT, '团队', '工具', 'lib', 'route-daemon.mjs');
const OPS_SRC = path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs');
const JSON_OUT = process.argv.includes('--json');
const PROJECT = 'b30e3沙盘';
const REQ = 'R-20261119-999998-30e3';

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'b30e3-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench-b30e3.json');
const DATA = path.join(SB, 'data');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');

function env() {
  const { DSH_SESSION_ID, ...base } = process.env;
  return { ...base, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE, AWB_DATA_DIR: DATA, AWB_STORE: STORE, TEAM_SELFTEST: '1' };
}
function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(), timeout: 180000, cwd: SB, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status == null ? 1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function runJson(args) {
  const r = run(args);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}

async function main() {
  let exitCode = 0;
  const realBefore = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
  Object.assign(process.env, env());
  try {
    const daemon = fs.readFileSync(DAEMON_SRC, 'utf8');
    const ops = fs.readFileSync(OPS_SRC, 'utf8');
    check('A1 静态：ensureTestTask 含 openDup + route_skip_duplicate',
      daemon.includes('openDup') && daemon.includes('route_skip_duplicate'), {});
    check('A2 静态：existing 判据也排除闭环（否则该建的建不了）',
      /const existing = \(tasks \|\| \[\]\)\.filter\(\(t\) => String\(t\.requirementId \|\| ''\) === requirementId\s*\n\s*&& String\(t\.owner \|\| ''\) === 'tester'\s*\n\s*&& !statusIsClosed/.test(daemon), {});
    check('A3 静态：ops.mjs 有 dupTestTaskHint 且进返回体', ops.includes('dupTestTaskHint') && /\.\.\.\(dupTestTaskHint \? \{ dupTestTaskHint \} : \{\}\)/.test(ops), {});

    check('S0 沙盘 init', run(['init']).code === 0, {});
    check('S1 沙盘建项目', run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).code === 0, {});
    const ALL = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
    const team = readJson(path.join(TEAM, '状态', '团队.json'), { members: [] });
    team.activeProject = PROJECT;
    team.members = Array.isArray(team.members) ? team.members : [];
    for (const role of ALL) {
      let m = team.members.find((x) => x && x.role === role);
      if (!m) { m = { role, name: role, status: 'active' }; team.members.push(m); }
      m.status = 'active'; m.sessionId = `session-b30e3-${role}`;
    }
    writeJson(path.join(TEAM, '状态', '团队.json'), team);
    const projMeta = readJson(path.join(STATE, '项目.json'), {});
    const projDir = String(projMeta.path || path.join(PROJECTS, PROJECT));
    writeJson(path.join(projDir, '团队会话.json'), { project: PROJECT, teamMode: 'full', workspace: projDir, roles: ALL.map((role) => ({ role, sessionId: `session-b30e3-${role}` })) });
    writeJson(STORE, { projects: [{ id: 'b30e3-p1', name: PROJECT, teamName: PROJECT, path: projDir, sessions: Object.fromEntries(ALL.map((r) => [r, `session-b30e3-${r}`])), workspace: { path: projDir, sessionIds: ALL.map((r) => `session-b30e3-${r}`) } }], activeProjectId: 'b30e3-p1' });
    const pmTok = String(((runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-b30e3-pm', '--json']).json || {}).token) || '');
    check('S2 沙盘 pm boot 成功', Boolean(pmTok), {});

    const mod = await import(`file://${DAEMON_SRC.replace(/\\/g, '/')}`);
    const store = await import(`file://${path.join(ROOT, '团队', '工具', 'lib', 'store.mjs').replace(/\\/g, '/')}`);
    const row = { id: REQ, title: 'b30e3 夹具需求', priority: 'P1', acceptance: 'x', roleIds: ['tester'], deliveryRound: 1, round: 1 };

    /* ── B1 已有一条未闭环（不同轮次）→ 不再建 ──────────────── */
    const baseTask = {
      id: 'T-20261119-999998-30e3a', project: PROJECT, title: '测试：b30e3 夹具需求', type: 'task',
      requirementId: REQ, owner: 'tester', status: 'open', createdBy: 'route-daemon',
      priority: 'P1', workflow: { round: 9 }, createdAt: '2026-11-19T14:00:00.000Z',
    };
    const beforeCount = (store.listTasks(PROJECT) || []).length;
    const r1 = mod.ensureTestTask(PROJECT, row, [baseTask]);
    const afterCount = (store.listTasks(PROJECT) || []).length;
    const routeLog = readLines(mod.routePaths(PROJECT).log);
    check('B1 未有闭环（不同轮次）→ duplicateSkipped=true 且任务数不变',
      r1 && r1.duplicateSkipped === true && afterCount === beforeCount, { r1: r1 && { ok: r1.ok, dup: r1.duplicateSkipped, reused: r1.reused }, beforeCount, afterCount });
    check('B1b 路由日志出现 route_skip_duplicate',
      routeLog.some((r) => r.event === 'route_skip_duplicate' && String(r.requirementId || '') === REQ), { events: routeLog.map((r) => r.event).slice(-5) });

    /* ── B2 已闭环 → 可建 ───────────────────────────────────── */
    const closedTask = { ...baseTask, id: 'T-20261119-999998-30e3b', status: 'accepted' };
    const before2 = (store.listTasks(PROJECT) || []).length;
    const r2 = mod.ensureTestTask(PROJECT, row, [closedTask]);
    const after2 = (store.listTasks(PROJECT) || []).length;
    check('B2 已闭环 → 新建一条（reused=false 且任务数 +1）',
      r2 && r2.reused === false && r2.ok === true && after2 === before2 + 1,
      { r2: r2 && { ok: r2.ok, reused: r2.reused, why: r2.why }, before2, after2 });

    /* ── B3 连调两次只建一条（新需求从零起跑） ───────────────── */
    const REQ2 = 'R-20261119-999997-30e3b';
    const row2 = { ...row, id: REQ2 };
    const tasksFor2 = () => (store.listTasks(PROJECT) || []).filter((t) => String(t.requirementId || '') === REQ2);
    const before3 = tasksFor2().length;
    const r3a = mod.ensureTestTask(PROJECT, row2, tasksFor2());
    const r3b = mod.ensureTestTask(PROJECT, row2, tasksFor2());
    const after3 = tasksFor2().length;
    check('B3 连调两次 → 任务数只 +1（第二次复用/跳过）',
      after3 === before3 + 1 && Boolean(r3a && r3a.ok) && Boolean(r3b && (r3b.reused === true || r3b.duplicateSkipped === true)),
      { before3, after3, a: r3a && { reused: r3a.reused, dup: r3a.duplicateSkipped }, b: r3b && { reused: r3b.reused, dup: r3b.duplicateSkipped } });

    /* ── B4 PM 侧提示（手工 seed 一条未闭环测试任务，不依赖 createTask 的 owner 默认值） ── */
    runJson(['req', 'create', '--boot', pmTok, '--title', 'b30e3 PM 提示需求', '--priority', 'P2', '--acceptance', 'x', '--json']);
    const wfNow = readJson(path.join(STATE, '工作流.json'), { requirements: {} });
    const realReqId = Object.keys(wfNow.requirements || {}).find((k) => String((wfNow.requirements[k] || {}).title || '').includes('b30e3 PM 提示需求')) || '';
    check('B4a 造出真实需求（req create 成功）', Boolean(realReqId), { keys: Object.keys(wfNow.requirements || {}).slice(-3) });
    if (realReqId) {
      const seedTaskId = 'T-20261119-999996-30e3c';
      // 需求正文（G1/文档门）
      const reqDir2 = path.join(String((readJson(path.join(STATE, '项目.json'), {}) || {}).path || path.join(PROJECTS, PROJECT)), '需求');
      fs.mkdirSync(reqDir2, { recursive: true });
      fs.writeFileSync(path.join(reqDir2, `${realReqId}-b30e3.md`), '# ' + realReqId + '\n\n正文占位（夹具）。\n', 'utf8');
      writeJson(path.join(STATE, '任务', `${seedTaskId}.json`), {
        id: seedTaskId, project: PROJECT, title: '测试：b30e3 PM 提示需求', type: 'task',
        requirementId: realReqId, owner: 'tester', status: 'working', createdBy: 'route-daemon',
        priority: 'P1', claimedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
        rev: 1, history: [],
      });
    }
    const created = runJson(['task', 'create', '--boot', pmTok, '--title', 'b30e3 PM 建单提示', '--priority', 'P2', '--type', 'task', '--requirement', realReqId, '--json']);
    const hint = (created.json || {}).dupTestTaskHint;
    check('B4 PM 建单返回 dupTestTaskHint（提示未闭环测试任务，不阻断建单）',
      Boolean(hint) && Number(hint.count) >= 1, { code: created.code, hint, out: `${created.out}${created.err}`.slice(0, 240) });
  } catch (e) {
    check('夹具未抛异常', false, { error: String((e && e.stack) || e).slice(0, 700) });
  } finally {
    const realAfter = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
    check('C 隔离：真实 团队.json / workbench.json 前后 sha256 不变',
      realAfter.team === realBefore.team && realAfter.store === realBefore.store,
      { team: [realBefore.team.slice(0, 12), realAfter.team.slice(0, 12)], store: [realBefore.store.slice(0, 12), realAfter.store.slice(0, 12)] });
    fs.rmSync(SB, { recursive: true, force: true });
    const failed = ROWS.filter((r) => r.ok !== true);
    if (!JSON_OUT) {
      console.log(`\n${ROWS.length - failed.length}/${ROWS.length} PASS${failed.length ? ` · ${failed.length} FAIL` : ''}`);
      if (failed.length) console.log('失败项：' + failed.map((r) => r.name).join(' | '));
    } else {
      console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed.length, failed: failed.map((r) => r.name), rows: ROWS }, null, 2));
    }
    if (failed.length) exitCode = 1;
  }
  process.exit(exitCode);
}
main();
