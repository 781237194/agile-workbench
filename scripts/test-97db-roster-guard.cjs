#!/usr/bin/env node
'use strict';
/**
 * test-97db-roster-guard.cjs —— T-20261119-044009-7ded 夹具：名册写前删除墓碑守卫。
 * A) 模块单测：deletionTombstoneBlocksRoster 四态（无墓碑/墓碑拦截/重建项目豁免/审计落盘）；
 * B) 真实接线：沙盘里 require 壳层 team-tools，在「删除墓碑 + 名册已空」下调 syncRoster →
 *    blocked=true、名册没有被写回 sessionId、名册守卫.jsonl 有 roster_sync_blocked 行；
 * C) 静态：main.js 4 处 syncRoster 调用均走 syncRosterGuarded、team-tools 2 处守卫在；
 * D) 「销毁后 6s 延迟回写」模拟：tombstone 存在时无论延迟多久调用 syncRoster 都被拦（用重复调用×3 代表不同时点）。
 * 用法：node scripts/test-97db-roster-guard.cjs [--out <dir>]。
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', `roster-guard-${process.pid}-${Date.now()}`);
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-97db-返工'); })();
const rows = [];
function check(name, ok, detail) { rows.push({ name, ok: Boolean(ok), detail: ok ? null : detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 400)}`); }
const TEAM = path.join(SB, '团队');
const WB = path.join(SB, 'workbench.json');
const PROJECT = '守卫项目';
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify({
    activeProject: PROJECT,
    members: [
      { role: 'pm', sessionId: '' }, { role: 'product', sessionId: '' }, { role: 'analyst', sessionId: '' },
      { role: 'programmer1', sessionId: '' }, { role: 'programmer2', sessionId: '' }, { role: 'tester', sessionId: '' },
    ],
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(WB, JSON.stringify({ projects: [], activeProjectId: null }, null, 2) + '\n', 'utf8');
  process.env.TEAM_ROOT = TEAM;
  process.env.TEAM_WORKBENCH_JSON = WB;
  process.env.TEAM_PROJECTS_ROOT = path.join(SB, '项目');
  const tt = require(path.join(ROOT, 'src', 'team-tools.js'));
  const stateDir = path.join(TEAM, '状态', '项目', tt.teamSlug(PROJECT));
  fs.mkdirSync(stateDir, { recursive: true });
  return { tt, stateDir };
}
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const guard = require(path.join(ROOT, '团队', '工具', 'lib', 'roster-deletion-guard.cjs'));
  // A) 模块单测
  const { tt, stateDir } = seed();
  const noTomb = guard.deletionTombstoneBlocksRoster({ projectName: PROJECT, stateDir, workbenchFile: WB });
  check('A1 无墓碑 → 不拦截', noTomb.blocked === false, noTomb);
  const tombFile = path.join(stateDir, '删除墓碑.json');
  fs.writeFileSync(tombFile, JSON.stringify({ teamName: PROJECT, projectName: PROJECT, deletedAt: new Date().toISOString(), generation: 1700000000000 }) + '\n', 'utf8');
  const blocked = guard.deletionTombstoneBlocksRoster({ projectName: PROJECT, stateDir, workbenchFile: WB });
  check('A2 墓碑命中 → 拦截', blocked.blocked === true && blocked.reason === 'deletion-tombstone', blocked);
  const auditFile = path.join(stateDir, '名册守卫.jsonl');
  const auditRows = (() => { try { return fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } })();
  check('A3 拦截写名册守卫审计行', auditRows.some((r) => r && r.action === 'roster_sync_blocked' && r.reason === 'deletion-tombstone'), auditRows.slice(0, 2));
  // A4 重建项目豁免：workbench 里出现同名活跃项目
  const activeDir = path.join(SB, '项目', PROJECT);
  fs.mkdirSync(activeDir, { recursive: true });
  fs.writeFileSync(WB, JSON.stringify({ projects: [{ id: 'P-recreate', name: PROJECT, teamName: PROJECT, path: activeDir }], activeProjectId: 'P-recreate' }, null, 2) + '\n', 'utf8');
  const recreated = guard.deletionTombstoneBlocksRoster({ projectName: PROJECT, stateDir, workbenchFile: WB });
  check('A4 重建项目存在 → 墓碑不拦截', recreated.blocked === false && recreated.reason === 'project-exists', recreated);
  fs.writeFileSync(WB, JSON.stringify({ projects: [], activeProjectId: null }, null, 2) + '\n', 'utf8');
  // B) 真实接线：team-tools.syncRoster 被拦，名册不写回
  const teamFile = path.join(TEAM, '状态', '团队.json');
  const before = readJson(teamFile);
  const syncResult = tt.syncRoster(PROJECT, { pm: 'sess-new-pm', analyst: 'sess-new-ana' });
  const after = readJson(teamFile);
  const afterSessions = (after.members || []).filter((m) => m && m.sessionId).length;
  check('B1 syncRoster 命中墓碑 → blocked/ROSTER_SYNC_BLOCKED_TOMBSTONE', Boolean(syncResult) && syncResult.blocked === true && syncResult.code === 'ROSTER_SYNC_BLOCKED_TOMBSTONE', syncResult);
  check('B2 名册没有被写回 sessionId（仍全空）', afterSessions === 0 && (before.members || []).filter((m) => m && m.sessionId).length === 0, { afterSessions });
  // C) 「销毁后 6s 延迟回写」模拟：不同时点重复调用仍全拦（含 6 次第 6 次模拟 6s）
  let blockedAll = true;
  for (let i = 1; i <= 6; i += 1) {
    const r = tt.syncRoster(PROJECT, { pm: 'sess-late-' + i });
    if (!r || r.blocked !== true) blockedAll = false;
  }
  check('C1 销毁后多次延迟回写（含 6s 时点）全部被拦', blockedAll, { blockedAll });
  // D) 静态：main.js 4 处走守卫、team-tools 2 处守卫
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const rawCalls = (mainSrc.match(/teamTools\.syncRoster\(teamName, project\.sessions \|\| \{\}\);/g) || []).length;
  const guardedCalls = (mainSrc.match(/syncRosterGuarded\(teamName, project\);/g) || []).length;
  check('D1 main.js syncRoster 全部走 syncRosterGuarded（原调用 0）', rawCalls === 0 && guardedCalls >= 4, { rawCalls, guardedCalls });
  const toolsSrc = fs.readFileSync(path.join(ROOT, 'src', 'team-tools.js'), 'utf8');
  check('D2 team-tools syncRoster/ensureRosterRoles 均有墓碑守卫', (toolsSrc.match(/deletionTombstoneBlocksRoster/g) || []).length >= 2, {});
  const guardSrc = fs.readFileSync(path.join(ROOT, '团队', '工具', 'lib', 'roster-deletion-guard.cjs'), 'utf8');
  check('D3 守卫模块存在 generation/审计字段', guardSrc.includes('generation') && guardSrc.includes('名册守卫.jsonl'), {});
  try { fs.writeFileSync(path.join(OUT, 'roster-guard-run.json'), JSON.stringify({ at: new Date().toISOString(), checks: rows }, null, 2) + '\n', 'utf8'); } catch { /* ignore */ }
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = rows.filter((r) => !r.ok);
  console.log('');
  console.log(`97DB-GUARD ${failed.length ? 'FAIL' : 'OK'} ${JSON.stringify({ total: rows.length, pass: rows.length - failed.length, red: failed.length })}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('97DB-GUARD ERROR ' + String((e && e.stack) || e)); process.exit(1); });
