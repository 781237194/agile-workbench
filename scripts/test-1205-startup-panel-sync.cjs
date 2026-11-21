'use strict';
/**
 * T-1205（P0，PM 2026-11-22 05:05 新证据）：
 * 重启后 16–21 秒出现 4 秒名册全空，随后恢复；要求：
 *  1) 拦截审计出现 roster_cleared_blocked 且带 case；
 *  2) 夹具模拟「启动后延后 20 秒触发一次 panelTeamSync」，断言名册 6/6 不变；
 *  3) 周期性 panelTeamSync 写前重新读盘/合并，不允许内存旧对象整文件覆盖。
 * 本夹具为纯 Node；六键全指独立沙盘；真实团队.json 前后 sha256 断言不变。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const REAL_REPO = path.resolve(__dirname, '..');
const REAL_TEAM = path.join(REAL_REPO, '团队', '状态', '团队.json');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-1205-startup-'));
const SANDBOX_TEAM = path.join(SANDBOX, '团队');
const SANDBOX_PROJECTS = path.join(SANDBOX, '项目');
const SANDBOX_DATA = path.join(SANDBOX, 'data');
const SANDBOX_STORE = path.join(SANDBOX, 'workbench.json');
for (const dir of [SANDBOX_TEAM, path.join(SANDBOX_TEAM, '状态'), SANDBOX_PROJECTS, SANDBOX_DATA]) fs.mkdirSync(dir, { recursive: true });
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
const teamFile = path.join(SANDBOX_TEAM, '状态', '团队.json');
const auditFile = path.join(SANDBOX_TEAM, '状态', '项目', '工作台改造修复', '名册变更.jsonl');
function writeTeam(team) { fs.mkdirSync(path.dirname(teamFile), { recursive: true }); fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8'); }
function auditRows() { try { return fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } }
const results = [];
function check(name, fn) { try { fn(); results.push(true); console.log(`PASS ${name}`); } catch (error) { results.push(false); console.log(`FAIL ${name}: ${String((error && error.message) || error)}`); } }

(async () => {
  const guard = await import(require('node:url').pathToFileURL(path.join(REAL_REPO, 'src', 'roster-startup-guard.js')).href);
  const jsonAtomic = await import(require('node:url').pathToFileURL(path.join(REAL_REPO, '团队', '工具', 'lib', 'json-atomic.mjs')).href);

  check('旧团队墓碑不清当前 activeProject 名册', () => {
    const d = guard.tombstoneClearDecision({ tombstoneTeam: '旧团队', teamActiveProject: '工作台改造修复', storeProjects: [{ teamName: '工作台改造修复' }], storeReady: true });
    assert.strictEqual(d.allow, false);
    assert.strictEqual(d.reason, 'not-active-team');
  });
  check('同名项目仍在 → 只消费墓碑不清名册', () => {
    const d = guard.tombstoneClearDecision({ tombstoneTeam: '工作台改造修复', teamActiveProject: '工作台改造修复', storeProjects: [{ teamName: '工作台改造修复' }], storeReady: true });
    assert.strictEqual(d.allow, false);
    assert.strictEqual(d.reason, 'project-exists');
  });
  check('store 未就绪 → 不清', () => {
    const d = guard.tombstoneClearDecision({ tombstoneTeam: '旧团队', teamActiveProject: '工作台改造修复', storeProjects: [], storeReady: false });
    assert.strictEqual(d.allow, false);
    assert.strictEqual(d.reason, 'store-not-ready');
  });
  check('真删除最后一个团队才允许清', () => {
    const d = guard.tombstoneClearDecision({ tombstoneTeam: '工作台改造修复', teamActiveProject: '', storeProjects: [{ teamName: '别的项目' }], storeReady: true });
    assert.strictEqual(d.allow, true);
  });

  // 启动后延后 20 秒：模拟旧快照触发 panelTeamSync 写盘；写前必须被 jsonAtomic 守卫拦住。
  writeTeam(makeTeam(false));
  await new Promise((resolve) => setTimeout(resolve, 20000));
  check('启动后 20 秒旧快照 panelTeamSync 被拒且名册 6/6', () => {
    const stale = makeTeam(true);
    let code = '';
    try { jsonAtomic.writeJsonAtomic(teamFile, stale, { case: 'panelTeamSync' }); } catch (error) { code = String((error && error.code) || ''); }
    assert.strictEqual(code, 'ROSTER_CLEAR_BLOCKED');
    const disk = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
    assert.strictEqual(disk.members.filter((m) => String(m.sessionId || '').trim()).length, 6);
    const row = auditRows().find((r) => r.event === 'roster_cleared_blocked' && r.case === 'panelTeamSync');
    assert.ok(row, '缺 case=panelTeamSync 的 roster_cleared_blocked');
    assert.ok(Array.isArray(row.stack) && row.stack.length >= 1, '缺 stack');
  });

  check('真实团队.json 前后 sha256 不变', () => {
    const after = sha256Of(REAL_TEAM);
    console.log(`REAL_TEAM_SHA before=${REAL_BEFORE} after=${after}`);
    assert.strictEqual(after, REAL_BEFORE);
  });

  const failed = results.filter((v) => !v).length;
  console.log(`STARTUP_PANEL_SYNC ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
