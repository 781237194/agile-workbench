#!/usr/bin/env node
'use strict';
/**
 * test-e328-task-create-no-autoclaim.cjs —— P0 修单 K2（T-20261119-165250-e328）夹具
 *
 * 缺陷：`task create --owner X` 建单即 `status=working` + `claimedAt=now`（store.mjs:1438/1441 旧实现），
 * 于是「建单即被计为认领后 N 分钟没动」→ 认领停滞误报（B-196e 建单当天即被误报）。
 *
 * 断言：
 *   K1 建单（带 --owner）→ status=open、claimedAt=null（owner 只作建议承接人）
 *   K2 建单通知 subject 含「待派单」且 body 含「勿开工」/「K2 口径」
 *   K3 「建单 10 秒内目标角色不得 working/claimedAt」：建单后立即 + 1 秒后各查一次仍 open/null
 *   K4 PM `send --ack --task` 派单成功 → 任务转 working、owner=目标、claimedAt 有值；返回 dispatchClaim
 *   K5 已 working 的任务再派单 → dispatchClaim.skipped=not_open，claimedAt 不被覆盖（幂等）
 *   K6 未派单的任务本人 `task claim` 仍可用（open → working）
 *   K7 隔离：真实 团队/状态/团队.json 与 data/userdata/workbench.json sha256 前后不变
 *
 * 用法：node scripts/test-e328-task-create-no-autoclaim.cjs [--json]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const JSON_OUT = process.argv.includes('--json');
const PROJECT = 'k2建单沙盘';
const ROLE = 'programmer2';

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'k2-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench-k2.json');
const DATA = path.join(SB, 'data');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const TASK_DIR = path.join(STATE, '任务');
const MAIL = path.join(TEAM, '状态', '邮箱');
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
const text = (r) => `${r.out || ''}${r.err || ''}`;
const tokenOf = (r) => String((r.json && r.json.token) || '');
const taskOf = (id) => readJson(path.join(TASK_DIR, `${id}.json`), null);
function mailsOf(role) {
  const out = [];
  for (const box of ['new', 'cur']) {
    const dir = path.join(MAIL, role, box);
    try {
      for (const n of fs.readdirSync(dir)) {
        if (!n.endsWith('.json')) continue;
        const row = readJson(path.join(dir, n), null);
        if (row) out.push(row);
      }
    } catch { /* 空箱 */ }
  }
  return out;
}
const sleep = (ms) => { const until = Date.now() + ms; while (Date.now() < until) { /* busy wait（沙盘小睡） */ } };

const realBefore = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
let exitCode = 0;
try {
  if (!fs.existsSync(TOOL)) { console.error('环境错误：找不到 team.mjs'); process.exit(2); }
  check('S0 沙盘 init', run(['init']).code === 0, {});
  check('S1 沙盘建项目', run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).code === 0, {});
  // 六角色名册（init 默认只有 pm/programmer1）
  const ALL = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
  const team = readJson(path.join(TEAM, '状态', '团队.json'), { members: [] });
  team.activeProject = PROJECT;
  team.members = Array.isArray(team.members) ? team.members : [];
  for (const role of ALL) {
    let m = team.members.find((x) => x && x.role === role);
    if (!m) { m = { role, name: role, status: 'active' }; team.members.push(m); }
    m.status = 'active'; m.sessionId = `session-k2-${role}`;
  }
  writeJson(path.join(TEAM, '状态', '团队.json'), team);
  const projMeta = readJson(path.join(STATE, '项目.json'), {});
  const projDir = String(projMeta.path || path.join(PROJECTS, PROJECT));
  writeJson(path.join(projDir, '团队会话.json'), { project: PROJECT, teamMode: 'full', workspace: projDir, roles: ALL.map((role) => ({ role, sessionId: `session-k2-${role}` })) });
  writeJson(STORE, { projects: [{ id: 'k2-p1', name: PROJECT, teamName: PROJECT, path: projDir, sessions: Object.fromEntries(ALL.map((r) => [r, `session-k2-${r}`])), workspace: { path: projDir, sessionIds: ALL.map((r) => `session-k2-${r}`) } }], activeProjectId: 'k2-p1' });
  const pmTok = tokenOf(runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-k2-pm', '--json']));
  const tgtTok = tokenOf(runJson(['boot', '--role', ROLE, '--project', PROJECT, '--session', `session-k2-${ROLE}`, '--json']));
  check('S2 沙盘 pm/目标角色 boot 成功', Boolean(pmTok && tgtTok), {});

  /* ── K1 建单（带 --owner）→ open / claimedAt=null ─────────────── */
  const created = runJson(['task', 'create', '--boot', pmTok, '--title', 'K2 建单不自动认领', '--priority', 'P1',
    '--type', 'task', '--owner', ROLE, '--detail', 'K2 夹具', '--json']);
  const taskId = String(((created.json || {}).task || {}).id || '');
  check('K1a 建单成功（带 --owner）', created.code === 0 && Boolean(taskId), { code: created.code, out: text(created).slice(0, 300) });
  const t1 = taskOf(taskId);
  check('K1b 新建任务 status=open（不是 working）', Boolean(t1) && String(t1.status) === 'open', { task: t1 && { status: t1.status, claimedAt: t1.claimedAt, owner: t1.owner } });
  check('K1c 新建任务 claimedAt=null（不算已认领）', Boolean(t1) && (t1.claimedAt === null || t1.claimedAt === undefined), { claimedAt: t1 && t1.claimedAt });
  check('K1d owner 仍记为建议承接人（保留 --owner 值）', Boolean(t1) && String(t1.owner || '') === ROLE, { owner: t1 && t1.owner });

  /* ── K2 通知文案：待派单，勿开工 ─────────────────────────────── */
  const mail = mailsOf(ROLE).filter((m) => String(m.task || '') === taskId);
  const notice = mail[0] || {};
  check('K2 建单通知 subject 含「待派单」且 body 含「勿开工」/「K2 口径」',
    /待派单/.test(String(notice.subject || '')) && /勿开工/.test(String(notice.body || '')) && /K2 口径/.test(String(notice.body || '')),
    { subject: notice.subject, body: String(notice.body || '').slice(0, 200) });

  /* ── K3 建单 10 秒内不得 working/claimedAt ───────────────────── */
  const t3a = taskOf(taskId);
  sleep(1000);
  const t3b = taskOf(taskId);
  check('K3 建单后立即 + 1 秒后两次查：仍 open / claimedAt=null（10 秒窗口内不会被隐式认领）',
    String(t3a.status) === 'open' && (t3a.claimedAt == null) && String(t3b.status) === 'open' && (t3b.claimedAt == null),
    { immediate: { status: t3a.status, claimedAt: t3a.claimedAt }, after1s: { status: t3b.status, claimedAt: t3b.claimedAt } });

  /* ── K4 派单（send --ack）→ 转 working ───────────────────────── */
  const beforeDispatch = taskOf(taskId);
  const dispatch = runJson(['send', '--boot', pmTok, '--to', ROLE, '--subject', 'K2 派单', '--body', '按 K2 派单口径开工', '--ack', '--task', taskId, '--json']);
  const dj = dispatch.json || {};
  const t4 = taskOf(taskId);
  check('K4a send --ack 派单成功且返回 dispatchClaim（taskId/status=working）',
    dispatch.code === 0 && Boolean(dj.dispatchClaim) && String(dj.dispatchClaim.taskId) === taskId && String(dj.dispatchClaim.status) === 'working',
    { code: dispatch.code, dispatchClaim: dj.dispatchClaim, out: text(dispatch).slice(0, 300) });
  check('K4b 派单后任务转 working 且 claimedAt 有值（派单即认领起点）',
    String(t4.status) === 'working' && Boolean(t4.claimedAt),
    { status: t4.status, claimedAt: t4.claimedAt, before: beforeDispatch && { status: beforeDispatch.status, claimedAt: beforeDispatch.claimedAt } });
  check('K4c 派单后 owner=目标角色', String(t4.owner || '') === ROLE, { owner: t4.owner });

  /* ── K5 已 working 再派单 → not_open，claimedAt 不被覆盖 ─────── */
  // 同角色串行：先让目标回执第一条派单（清 PM_DISPATCH_PENDING 锁），再派同一任务。
  const firstMsgId = String(((dispatch.json || {}).message || {}).id || '');
  const ackFirst = runJson(['ack', '--boot', tgtTok, '--id', firstMsgId, '--note', 'K2 夹具：已回执', '--json']);
  check('K5a 目标回执第一条派单（清同角色串行锁）', ackFirst.code === 0, { code: ackFirst.code, out: text(ackFirst).slice(0, 300) });
  const claimedAtBefore = String(taskOf(taskId).claimedAt || '');
  sleep(1100);
  const dispatch2 = runJson(['send', '--boot', pmTok, '--to', ROLE, '--subject', 'K2 重复派单', '--body', 'x', '--ack', '--task', taskId, '--json']);
  const d2 = (dispatch2.json || {}).dispatchClaim || {};
  check('K5 已 working 的任务再派单：dispatchClaim.skipped=not_open 且 claimedAt 未被覆盖',
    String(d2.skipped || '') === 'not_open' && String(taskOf(taskId).claimedAt || '') === claimedAtBefore,
    { dispatchClaim: d2, claimedAtBefore, after: taskOf(taskId).claimedAt, sendCode: dispatch2.code, sendDispatch: (dispatch2.json || {}).dispatch, sendDemoted: (dispatch2.json || {}).demoted, out: text(dispatch2).slice(0, 300) });

  /* ── K6 未派单任务本人 task claim 仍可用 ─────────────────────── */
  const created2 = runJson(['task', 'create', '--boot', pmTok, '--title', 'K2 claim 路径', '--priority', 'P2', '--type', 'task', '--owner', ROLE, '--json']);
  const taskId2 = String(((created2.json || {}).task || {}).id || '');
  const claim = runJson(['task', 'claim', '--boot', tgtTok, '--id', taskId2, '--json']);
  const t6 = taskOf(taskId2);
  check('K6 未派单任务本人 task claim 仍可用（open → working + claimedAt）',
    claim.code === 0 && String(t6.status) === 'working' && Boolean(t6.claimedAt),
    { code: claim.code, status: t6 && t6.status, claimedAt: t6 && t6.claimedAt, out: text(claim).slice(0, 300) });
} catch (e) {
  check('夹具未抛异常', false, { error: String((e && e.stack) || e) });
} finally {
  const realAfter = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
  check('K7 隔离：真实 团队.json / workbench.json 前后 sha256 不变',
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
