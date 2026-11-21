'use strict';
/**
 * T-1205（P0）：团队.json 整文件写守卫夹具。
 * 背景：04:35/04:40 两次重启出现 4 次「六成员全空」，名册变更.jsonl 零新行，
 * 说明不是 syncRoster/applyMemberSession，而是某个内存旧快照走整文件 write。
 * 本夹具验证 store.writeTeamFileAtomic：
 *   1) 写前有非空 sessionId、写后全空 → 拒写 ROSTER_CLEAR_BLOCKED，文件不变；
 *   2) 该拒绝写 名册变更.jsonl 的 roster_cleared_blocked（含 stack 前几帧/before/after）；
 *   3) 正常非空写仍允许，并写 roster_write；
 *   4) 只有显式 allowClear 才允许全清。
 * 六键全部指向独立沙盘；前后对真实 团队/状态/团队.json 算 sha256 断言不变。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const REAL_REPO = path.resolve(__dirname, '..');
const REAL_TEAM = path.join(REAL_REPO, '团队', '状态', '团队.json');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-1205-write-'));
const TEAM_ROOT = path.join(SANDBOX, '团队');
const PROJECTS_ROOT = path.join(SANDBOX, '项目');
const DATA_DIR = path.join(SANDBOX, 'data');
const STORE = path.join(SANDBOX, 'workbench.json');
for (const dir of [TEAM_ROOT, path.join(TEAM_ROOT, '状态'), PROJECTS_ROOT, DATA_DIR]) fs.mkdirSync(dir, { recursive: true });
Object.assign(process.env, {
  AWB_TEAM_ROOT: TEAM_ROOT,
  AWB_TEAM_PROJECTS_ROOT: PROJECTS_ROOT,
  TEAM_ROOT,
  TEAM_PROJECTS_ROOT: PROJECTS_ROOT,
  AWB_STORE: STORE,
  TEAM_WORKBENCH_JSON: STORE,
  AWB_DATA_DIR: DATA_DIR,
  TEAM_SELFTEST: '1',
});
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ } });
function sha256Of(file) { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return 'MISSING'; } }
const REAL_BEFORE = sha256Of(REAL_TEAM);
const roles = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
function makeTeam(empty = false) {
  return {
    version: 1, name: '沙盘团队', phase: 'team', activeProject: '工作台改造修复',
    members: roles.map((role) => ({ role, name: role, status: 'active', joinedAt: new Date().toISOString(), sessionId: empty ? '' : `session-${role}-fixed` })),
    config: {},
  };
}
const results = [];
function check(name, fn) {
  try { fn(); results.push(true); console.log(`PASS ${name}`); }
  catch (error) { results.push(false); console.log(`FAIL ${name}: ${String((error && error.message) || error)}`); }
}
const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
const auditFile = path.join(TEAM_ROOT, '状态', '项目', '工作台改造修复', '名册变更.jsonl');
function writeTeam(team) { fs.mkdirSync(path.dirname(teamFile), { recursive: true }); fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8'); }
function auditRows() {
  try { return fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
}

(async () => {
  writeTeam(makeTeam(false));
  const store = await import(require('node:url').pathToFileURL(path.join(REAL_REPO, '团队', '工具', 'lib', 'store.mjs')).href);

  check('写后六角色全空：拒写且文件不变', () => {
    const before = fs.readFileSync(teamFile, 'utf8');
    const cleared = makeTeam(true);
    let code = '';
    try { store.writeTeamFileAtomic(cleared, 'test/clear-all'); } catch (error) { code = String((error && error.code) || ''); }
    assert.strictEqual(code, 'ROSTER_CLEAR_BLOCKED');
    assert.strictEqual(fs.readFileSync(teamFile, 'utf8'), before);
    const rows = auditRows();
    const blocked = rows.find((row) => row.event === 'roster_cleared_blocked');
    assert.ok(blocked, '缺 roster_cleared_blocked 审计');
    assert.strictEqual(blocked.source, 'test/clear-all');
    assert.ok(Array.isArray(blocked.stack) && blocked.stack.length >= 1, '审计缺 stack');
    assert.strictEqual(blocked.before.members.filter((m) => String(m.sessionId || '').trim()).length, 6);
    assert.strictEqual(blocked.after.members.filter((m) => String(m.sessionId || '').trim()).length, 0);
  });

  check('正常更新一个 sessionId：允许写并记 roster_write', () => {
    const next = makeTeam(false);
    next.members.find((m) => m.role === 'pm').sessionId = 'session-pm-new';
    const out = store.writeTeamFileAtomic(next, 'test/update-one');
    assert.ok(out);
    const row = auditRows().filter((r) => r.event === 'roster_write').pop();
    assert.ok(row && row.source === 'test/update-one');
    assert.ok(Array.isArray(row.stack) && row.stack.length >= 1);
    assert.strictEqual(row.beforeCount, 6);
    assert.strictEqual(row.afterCount, 6);
  });

  check('显式 allowClear 才允许全清', () => {
    const cleared = makeTeam(true);
    store.writeTeamFileAtomic(cleared, 'test/allow-clear', { allowClear: true });
    const disk = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
    assert.strictEqual(disk.members.filter((m) => String(m.sessionId || '').trim()).length, 0);
  });

  check('真实团队.json 前后 sha256 不变', () => {
    const after = sha256Of(REAL_TEAM);
    console.log(`REAL_TEAM_SHA before=${REAL_BEFORE} after=${after}`);
    assert.strictEqual(after, REAL_BEFORE);
  });

  const failed = results.filter((v) => !v).length;
  console.log(`TEAM_WRITE_GUARD ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
