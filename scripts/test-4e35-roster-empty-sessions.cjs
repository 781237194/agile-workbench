'use strict';
/**
 * T-20261122-035135-4e35 P0：
 * 启动期 sessions 为空/未就绪时，syncRosterSessions 绝不能清空 team.json 的成员 sessionId。
 * 纯 Node 夹具，不需要 Electron；真实状态零写入。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const path = require('node:path');
const REAL_REPO = path.resolve(__dirname, '..');
const REAL_TEAM = path.join(REAL_REPO, '团队', '状态', '团队.json');
// PM 2026-11-22 04:08 铁律：夹具六键必须全指向本轮独立沙盘；跑前/跑后对真实团队.json 算 sha256 并断言不变。
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-4e35-'));
const SANDBOX_TEAM = path.join(SANDBOX, '团队');
const SANDBOX_PROJECTS = path.join(SANDBOX, '项目');
const SANDBOX_DATA = path.join(SANDBOX, 'data');
const SANDBOX_STORE = path.join(SANDBOX, 'workbench.json');
for (const dir of [SANDBOX_TEAM, SANDBOX_PROJECTS, SANDBOX_DATA]) fs.mkdirSync(dir, { recursive: true });
Object.assign(process.env, {
  AWB_TEAM_ROOT: SANDBOX_TEAM,
  AWB_TEAM_PROJECTS_ROOT: SANDBOX_PROJECTS,
  TEAM_ROOT: SANDBOX_TEAM,
  TEAM_PROJECTS_ROOT: SANDBOX_PROJECTS,
  AWB_STORE: SANDBOX_STORE,
  TEAM_WORKBENCH_JSON: SANDBOX_STORE,
  AWB_DATA_DIR: SANDBOX_DATA,
  TEAM_SELFTEST: '1',
});
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ } });
function sha256Of(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return 'MISSING'; }
}
const REAL_TEAM_BEFORE = sha256Of(REAL_TEAM);
const core = require(path.join(REAL_REPO, '团队', '工具', 'lib', 'roster-apply.cjs'));

const ROLE_IDS = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
function makeTeam() {
  return {
    version: 1,
    activeProject: '工作台改造修复',
    members: ROLE_IDS.map((role) => ({ role, name: role, status: 'active', sessionId: `session-${role}-base` })),
  };
}
function sessionsOf(team) {
  return Object.fromEntries(team.members.map((m) => [m.role, String(m.sessionId || '')]));
}
function assertNoClear(team, label) {
  const current = sessionsOf(team);
  for (const role of ROLE_IDS) assert.strictEqual(current[role], `session-${role}-base`, `${label}: ${role} 被清空`);
  assert.strictEqual(ROLE_IDS.filter((r) => current[r]).length, ROLE_IDS.length, `${label}: 名册不是 6/6`);
}
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, pass: false, error: String((error && error.message) || error) }); console.log(`FAIL ${name}: ${results[results.length - 1].error}`); }
}

check('空 sessions 不清名册', () => {
  const team = makeTeam();
  const out = core.syncRosterSessions(team, {}, { roleIds: ROLE_IDS, activeProject: '工作台改造修复' });
  assert.strictEqual(out.changed, 0);
  assert.strictEqual(out.skipped, 'EMPTY_SESSIONS');
  assertNoClear(team, '空 sessions');
});

check('部分 sessions 只更新有值角色、不动其它', () => {
  const team = makeTeam();
  const out = core.syncRosterSessions(team, { pm: 'session-pm-new' }, { roleIds: ROLE_IDS, activeProject: '工作台改造修复' });
  assert.strictEqual(out.changed, 1);
  assert.strictEqual(team.members.find((m) => m.role === 'pm').sessionId, 'session-pm-new');
  assert.strictEqual(team.members.find((m) => m.role === 'product').sessionId, 'session-product-base');
  assert.strictEqual(team.members.find((m) => m.role === 'tester').sessionId, 'session-tester-base');
});

check('非法 id 不覆盖名册', () => {
  const team = makeTeam();
  const out = core.syncRosterSessions(team, { pm: 'not-a-session-id' }, { roleIds: ROLE_IDS, activeProject: '工作台改造修复' });
  assert.strictEqual(out.changed, 0);
  assert.strictEqual(team.members.find((m) => m.role === 'pm').sessionId, 'session-pm-base');
  assert.ok(out.rejected.length >= 1);
});

check('三次重启空来源后仍 6/6', () => {
  for (let i = 0; i < 3; i += 1) {
    const team = makeTeam();
    core.syncRosterSessions(team, {}, { roleIds: ROLE_IDS, activeProject: '工作台改造修复' });
    core.syncRosterSessions(team, { pm: '', product: '', analyst: '', programmer1: '', programmer2: '', tester: '' }, { roleIds: ROLE_IDS, activeProject: '工作台改造修复' });
    assertNoClear(team, `第 ${i + 1} 次重启`);
  }
});

check('空来源 sync 不触发清空审计', () => {
  const audit = [];
  core.setClearAuditHook((row) => audit.push(row));
  const team = makeTeam();
  core.syncRosterSessions(team, {}, { roleIds: ROLE_IDS, activeProject: '工作台改造修复' });
  core.setClearAuditHook(null);
  assert.strictEqual(audit.length, 0);
  assertNoClear(team, '空来源无审计');
});

check('显式清空 applyMemberSession 触发审计（含 stack）', () => {
  const audit = [];
  core.setClearAuditHook((row) => audit.push(row));
  const team = makeTeam();
  core.applyMemberSession(team.members[0], '');
  core.setClearAuditHook(null);
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].role, 'pm');
  assert.match(audit[0].before, /^session-pm-base$/);
  assert.strictEqual(audit[0].after, '');
  assert.ok(Array.isArray(audit[0].stack) && audit[0].stack.length >= 1);
});

check('六键全指向独立沙盘', () => {
  const env = process.env;
  for (const key of ['AWB_TEAM_ROOT', 'AWB_TEAM_PROJECTS_ROOT', 'TEAM_ROOT', 'TEAM_PROJECTS_ROOT', 'AWB_STORE', 'TEAM_WORKBENCH_JSON', 'AWB_DATA_DIR']) {
    const value = String(env[key] || '');
    assert.ok(value.startsWith(SANDBOX), `${key} 未指向沙盘：${value}`);
    assert.ok(!value.startsWith(REAL_REPO), `${key} 指向真实仓库：${value}`);
  }
});

check('真实团队.json 前后 sha256 不变', () => {
  const after = sha256Of(REAL_TEAM);
  console.log(`REAL_TEAM_SHA before=${REAL_TEAM_BEFORE} after=${after}`);
  assert.strictEqual(after, REAL_TEAM_BEFORE);
});

const failed = results.filter((r) => !r.pass);
console.log(`ROSTER_EMPTY_SESSIONS ${results.length - failed.length}/${results.length} PASS`);
if (failed.length) process.exitCode = 1;
