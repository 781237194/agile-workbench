#!/usr/bin/env node
'use strict';
/**
 * test-2eb3-role-busy-open.cjs — B-20261120-151452-2eb3（P1）夹具：G5 只统计「真在办」
 *
 * 背景：K2（B-e328）之后 task create 只建单（status=open、claimedAt=null、--owner 只是建议承接人），
 * 旧 G5 把这类未派单积压待办也算占用 → 角色一次只能挂 1 条待办，PM 必须先 park 全部积压才能派单。
 * 口径（本单 AC）：
 *   ② G5 只统计 status=working 或 claimedAt 非空；未派单的 open 待办不占角色；
 *   ③ 保留既有保护：blocked 不占、requirement 镜像任务不占、活动派单锁仍 ROLE_BUSY、working 幽灵（staleWorkingMs）仍可跳；
 *   ⑤ 不改 task create/claim 状态机，只改 gateRoleBusy 的计入条件。
 *
 * 用法：node scripts/test-2eb3-role-busy-open.cjs [--json]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const GATES_SRC = path.join(ROOT, '团队', '工具', 'lib', 'gates.mjs');
const JSON_OUT = process.argv.includes('--json');
const PROJECT = 's2eb3沙盘';
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 800)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 's2eb3-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const DATA = path.join(SB, 'data');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');

function env(extra = {}) {
  const { DSH_SESSION_ID, AWB_TEAM_ROOT, ...base } = process.env;
  return { ...base, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE, AWB_DATA_DIR: DATA, AWB_STORE: STORE, TEAM_SELFTEST: '1', ...extra };
}
function run(args, extra = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(extra), cwd: SB, timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status == null ? 1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function runJson(args, extra = {}) {
  const r = run(args, extra);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}
const text = (r) => `${r.out || ''}${r.err || ''}`;
const tokenOf = (r) => String(((r.json || {}).token) || '');
const codeOf = (r) => String((r.json && r.json.code) || '');

async function main() {
  let exitCode = 0;
  const realBefore = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
  try {
    Object.assign(process.env, env());
    check('S0 沙盘 init', run(['init']).code === 0, {});
    check('S1 沙盘建项目', run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).code === 0, {});
    const team = readJson(path.join(TEAM, '状态', '团队.json'), { members: [] });
    team.activeProject = PROJECT;
    team.members = ROLES.map((role) => ({ role, name: role, status: 'active', sessionId: `session-2eb3-${role}` }));
    writeJson(path.join(TEAM, '状态', '团队.json'), team);
    const projMeta = readJson(path.join(STATE, '项目.json'), {});
    const projDir = String(projMeta.path || path.join(PROJECTS, PROJECT));
    writeJson(path.join(projDir, '团队会话.json'), { project: PROJECT, teamMode: 'full', workspace: projDir, roles: ROLES.map((role) => ({ role, sessionId: `session-2eb3-${role}` })) });
    writeJson(STORE, { projects: [{ id: '2eb3-p1', name: PROJECT, teamName: PROJECT, path: projDir, sessions: Object.fromEntries(ROLES.map((r) => [r, `session-2eb3-${r}`])), workspace: { path: projDir, sessionIds: ROLES.map((r) => `session-2eb3-${r}`) } }], activeProjectId: '2eb3-p1' });
    const pmTok = tokenOf(runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-2eb3-pm', '--json']));
    const devTok = tokenOf(runJson(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 'session-2eb3-programmer1', '--json']));
    check('S2 沙盘 pm/programmer1 boot 成功', Boolean(pmTok && devTok), {});

    const mod = await import(`file://${GATES_SRC.replace(/\\/g, '/')}`);
    const T = (id, extra = {}) => ({ id, owner: 'p1', status: 'open', claimedAt: null, title: id, ...extra });
    const roleP1 = 'p1';

    /* ── ② 未派单 open 不再占用 ── */
    const open3 = [T('T-o1'), T('T-o2'), T('T-o3')];
    check('②a 3 条 open 未派单（claimedAt=null）→ G5 放行（旧口径会 TASK_OPEN）',
      mod.gateRoleBusy({ role: roleP1, tasks: open3, locks: [] }) === null,
      { gate: mod.gateRoleBusy({ role: roleP1, tasks: open3, locks: [] }) });

    const working = T('T-w1', { status: 'working', claimedAt: new Date().toISOString() });
    const gWorking = mod.gateRoleBusy({ role: roleP1, tasks: [...open3, working], locks: [] });
    check('②b 1 条 working + 3 条 open → 仍 TASK_OPEN（working 占角色，open 不计入）',
      gWorking && gWorking.code === 'TASK_OPEN' && gWorking.taskIds.length === 1 && gWorking.taskIds[0] === 'T-w1',
      { gate: gWorking });

    const claimedOpen = T('T-c1', { claimedAt: new Date().toISOString() });   // status=open 但 claimedAt 非空
    const gClaimed = mod.gateRoleBusy({ role: roleP1, tasks: [claimedOpen], locks: [] });
    check('②c status=open 但 claimedAt 非空 → 计入（真在办）', gClaimed && gClaimed.code === 'TASK_OPEN' && gClaimed.taskIds[0] === 'T-c1', { gate: gClaimed });

    check('②d 混合：working 被排除（excludeTaskIds）后只剩 open → 放行（派单自身不计占用）',
      mod.gateRoleBusy({ role: roleP1, tasks: [...open3, working], locks: [], excludeTaskIds: ['T-w1'] }) === null, {});

    /* ── ③ 既有保护不回归 ── */
    const blocked = T('T-b1', { status: 'blocked', claimedAt: new Date().toISOString() });
    check('③a blocked 任务不占角色（即便 claimedAt 非空）',
      mod.gateRoleBusy({ role: roleP1, tasks: [blocked], locks: [] }) === null, {});
    const mirror = { id: 'R-m1', requirementId: 'R-m1', type: 'requirement', owner: roleP1, status: 'working', claimedAt: new Date().toISOString() };
    check('③b requirement 镜像任务不占角色',
      mod.gateRoleBusy({ role: roleP1, tasks: [mirror], locks: [] }) === null, {});
    const lock = { key: 'role:p1', role: roleP1, stale: false, expiresAt: new Date(Date.now() + 60000).toISOString() };
    const gLock = mod.gateRoleBusy({ role: roleP1, tasks: open3, locks: [lock] });
    check('③c 活动派单锁仍算 ROLE_BUSY（open 不再误挡，但锁照旧挡）',
      gLock && gLock.code === 'ROLE_BUSY' && gLock.lockKeys[0] === 'role:p1', { gate: gLock });
    const stale = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const ghost = T('T-g1', { status: 'working', claimedAt: stale, updatedAt: stale });
    check('③d working 幽灵：给了 staleWorkingMs 才跳（普通派单仍严格）',
      mod.gateRoleBusy({ role: roleP1, tasks: [ghost], locks: [] }) !== null
      && mod.gateRoleBusy({ role: roleP1, tasks: [ghost], locks: [], staleWorkingMs: 30 * 60 * 1000 }) === null,
      {});

    /* ── ⑤ 状态机不变：create 仍是 open + claimedAt=null；claim 才 working ── */
    const c1 = runJson(['task', 'create', '--boot', pmTok, '--title', '2eb3 open 1', '--priority', 'P2', '--type', 'task', '--owner', 'programmer1', '--json']);
    const c2 = runJson(['task', 'create', '--boot', pmTok, '--title', '2eb3 open 2', '--priority', 'P2', '--type', 'task', '--owner', 'programmer1', '--json']);
    const c3 = runJson(['task', 'create', '--boot', pmTok, '--title', '2eb3 open 3', '--priority', 'P2', '--type', 'task', '--owner', 'programmer1', '--json']);
    const created = [c1, c2, c3].map((x) => (x.json || {}).task || {});
    check('⑤a task create 仍是 open + claimedAt=null（状态机未被本单改动）',
      created.length === 3 && created.every((t) => String(t.status) === 'open' && !t.claimedAt),
      { created: created.map((t) => ({ id: t.id, status: t.status, claimedAt: t.claimedAt })) });

    const claim = runJson(['task', 'claim', '--boot', devTok, '--id', String(created[0].id || ''), '--json']);
    const claimedRow = readJson(path.join(STATE, '任务', `${created[0].id}.json`), {});
    check('⑤b 本人 claim 后 working + claimedAt 有值（K2 唯一认领入口不变）',
      claim.code === 0 && String(claimedRow.status) === 'working' && Boolean(claimedRow.claimedAt),
      { claimCode: claim.code, row: { status: claimedRow.status, claimedAt: claimedRow.claimedAt } });

    /* ── ②e 模块级再验：真实任务文件读出来的集合里，只有 working 那条计入 ── */
    const realTasks = ['created'].length && [created[0], created[1], created[2]].map((t) => readJson(path.join(STATE, '任务', `${t.id}.json`), {}));
    const gReal = mod.gateRoleBusy({ role: 'programmer1', tasks: realTasks, locks: [] });
    check('②e 真实任务集合：3 open(其中 1 条已 claim→working) → 只报那 1 条',
      gReal && gReal.code === 'TASK_OPEN' && gReal.taskIds.length === 1 && gReal.taskIds[0] === String(created[0].id),
      { gate: gReal });
  } catch (e) {
    check('夹具未抛异常', false, { error: String((e && e.stack) || e) });
  } finally {
    const realAfter = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
    check('C 隔离：真实 团队.json / workbench.json 前后 sha256 不变',
      realAfter.team === realBefore.team && realAfter.store === realBefore.store,
      { team: [realBefore.team.slice(0, 12), realAfter.team.slice(0, 12)] });
    fs.rmSync(SB, { recursive: true, force: true });
    const failed = ROWS.filter((r) => r.ok !== true);
    if (!JSON_OUT) {
      console.log(`\n${ROWS.length - failed.length}/${ROWS.length} PASS${failed.length ? ' · ' + failed.length + ' FAIL' : ''}`);
      if (failed.length) console.log('失败项：' + failed.map((r) => r.name).join(' | '));
    } else {
      console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed.length, failed: failed.map((r) => r.name), rows: ROWS }, null, 2));
    }
    if (failed.length) exitCode = 1;
  }
  process.exit(exitCode);
}
main();
