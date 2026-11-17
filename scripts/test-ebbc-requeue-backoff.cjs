#!/usr/bin/env node
'use strict';
/**
 * B-20261117-104213-ebbc 回归：空闲重派无限重投（沙盘，时间可注入）
 *
 * 三条验收：
 *  A 夹具「已验收任务 + 镜像任务」→ recoverStalledRoles 连跑 5 拍：不重投（投递审计新增 0 行、队列 0 项）；
 *  B 夹具「真 open 未回执任务」→ 首拍投递 1 行；10 分钟内再跑 4 拍仍 0 新增（去抖）；
 *     +11 分钟那一拍允许重投且 attempt 由 1 → 2；
 *  C attempt 用尽（下一跳 >=3）→ 放弃、不重投，只写 1 行 ATTEMPT_CAP 告警；再跑一拍不重复告警。
 *
 * 跑法：node scripts/test-ebbc-requeue-backoff.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : String(JSON.stringify(detail)).slice(0, 400) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 400)}`);
  if (!ok) process.exitCode = 1;
}

(async () => {
  const SB = mkTempSandbox('ebbc');
  const TEAM_ROOT = path.join(SB, '团队');
  const PROJECTS = path.join(SB, '项目');
  const PROJECT = '空闲重派沙盘';
  const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
  const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1', TEAM_WORKBENCH_JSON: path.join(SB, 'data', 'userdata', 'workbench.json') };
  fs.mkdirSync(path.join(SB, 'data', 'userdata'), { recursive: true });
  fs.mkdirSync(PROJECTS, { recursive: true });
  fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
  const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
  const teamData = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  (teamData.members || []).forEach((m) => { m.sessionId = ''; });
  delete teamData.activeProject;
  fs.writeFileSync(teamFile, JSON.stringify(teamData, null, 2) + '\n', 'utf8');
  // PATHS 在 import 时按 env 计算 → 必须先设 env 再 import ops.mjs
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const opsUrl = new URL('file:///' + path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs').replace(/\\/g, '/')).href;
  const ops = await import(opsUrl);

  const runCli = (args) => {
    const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    const text = String(out).trim();
    return JSON.parse(text.slice(text.indexOf('{')));
  };
  runCli(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
  const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
  const auditFile = path.join(stateDir, '派单投递审计.jsonl');
  const queueFile = path.join(stateDir, '派单队列.json');
  const readAudit = () => (fs.existsSync(auditFile)
    ? fs.readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : []);
  const readQueue = () => { try { return JSON.parse(fs.readFileSync(queueFile, 'utf8')).items || []; } catch { return []; } };
  const baseMs = Date.parse('2026-11-20T00:00:00.000Z'); // 远离「复制来的真实信号时间」，保证沙盘角色被判 idle
  const oldIso = new Date(baseMs - 3 * 60 * 60 * 1000).toISOString(); // 3 小时前 → 三信号全在窗口外

  const writeTask = (id, patch) => {
    fs.writeFileSync(path.join(stateDir, '任务', `${id}.json`), JSON.stringify({
      id, project: PROJECT, type: 'task', requirementId: 'R-20261117-000000-ebbc',
      title: 'ebbc 夹具', owner: 'analyst', status: 'open',
      createdAt: oldIso, claimedAt: oldIso, updatedAt: oldIso, history: [],
      ...patch,
    }, null, 2) + '\n', 'utf8');
  };

  // ── A：已验收任务 + 镜像任务 → 不应重投 ──
  writeTask('T-20261117-000001-ebbc', { status: 'accepted', acceptedAt: oldIso });
  const mirrorId = 'R-20261117-000000-ebbc';
  fs.writeFileSync(path.join(stateDir, '任务', `${mirrorId}.json`), JSON.stringify({
    id: mirrorId, project: PROJECT, type: 'requirement', requirementId: mirrorId,
    title: 'ebbc 镜像夹具', owner: 'analyst', status: 'open',
    createdAt: oldIso, claimedAt: oldIso, updatedAt: oldIso, history: [],
  }, null, 2) + '\n', 'utf8');
  const aBefore = readAudit().length;
  for (let i = 1; i <= 5; i += 1) {
    await ops.recoverStalledRoles(PROJECT, { now: baseMs + i * 1000, write: true });
  }
  const aAfter = readAudit();
  check('A 已验收+镜像：5 拍不重投（投递审计新增 0 行、队列 0 项）',
    aAfter.length === aBefore && readQueue().length === 0, { added: aAfter.length - aBefore, queue: readQueue().length });

  // ── B：真 open 未回执 → 10 分钟内不重投；+11 分钟允许重投且 attempt 递增 ──
  const realTaskId = 'T-20261117-000002-ebbc';
  writeTask(realTaskId, { status: 'open' }); // B-1d90：working=角色自身在办会被过滤，重投退避用例用 unclaimed open
  const itemId = `Q-STALL-analyst-${realTaskId}`;
  const stateFile = path.join(stateDir, '派单投递状态.json');
  const seedDelivered = (attempt, lastIso) => fs.writeFileSync(stateFile, JSON.stringify({
    schema: 1, project: PROJECT, items: { [itemId]: { state: 'delivered', attempt, lastAt: lastIso, lastCode: '', stalledAt: '', upgradedAt: '' } },
  }, null, 2) + '\n', 'utf8');
  const allRowsOfItem = () => readAudit().filter((r) => String(r.itemId) === itemId);
  // 「投递行」= 重投入队行（STALLED_REQUEUE）与投递审计行；升级/告警行（STALL_IDLE_CONSECUTIVE 等）另算，不算投递
  const rowsOfItem = () => allRowsOfItem().filter((r) => String(r.code || '') === 'STALLED_REQUEUE' || String(r.result || '') === 'delivered');
  seedDelivered(1, new Date(baseMs).toISOString());
  const beforeB = rowsOfItem().length;
  for (let i = 1; i <= 4; i += 1) {
    await ops.recoverStalledRoles(PROJECT, { now: baseMs + i * 60 * 1000, write: true });
  }
    check('B 已投递未回执 + 10 分钟内 4 拍：不重投（该 itemId 审计新增 0 行）', rowsOfItem().length === beforeB, { added: rowsOfItem().length - beforeB });
  // 重新播种 delivered(lastAt=base)：升级路径每拍会刷新 lastAt，这里只验「距上次投递 ≥10 分钟即允许重投」
  seedDelivered(1, new Date(baseMs).toISOString());
  await ops.recoverStalledRoles(PROJECT, { now: baseMs + 11 * 60 * 1000, write: true });
  const requeued = rowsOfItem().filter((r) => r.code === 'STALLED_REQUEUE');
  check('B +11 分钟允许重投且 attempt 递增到 2', requeued.length === 1 && Number(requeued[0].attempt) === 2, requeued.map((r) => ({ attempt: r.attempt, code: r.code })));
  check('B 5 拍内该 itemId 新增行 ≤2', rowsOfItem().length - beforeB <= 2, { added: rowsOfItem().length - beforeB });

  // ── C：attempt 用尽 → 放弃 + 只告警一次 ──
  // C 段前清空队列（B 段重投已入队一次、未 pump；否则 C 段会在 already_queued 处短路，验不到 attempt_cap）
  fs.writeFileSync(queueFile, JSON.stringify({ items: [] }) + '\n', 'utf8');
  seedDelivered(2, new Date(baseMs + 11 * 60 * 1000).toISOString());
  const capBase = allRowsOfItem().filter((r) => r.code === 'ATTEMPT_CAP').length;
  await ops.recoverStalledRoles(PROJECT, { now: baseMs + 22 * 60 * 1000, write: true });
  const capRows = () => allRowsOfItem().filter((r) => r.code === 'ATTEMPT_CAP');
  check('C attempt 用尽：不重投，写 1 行 ATTEMPT_CAP（result=blocked）',
    readQueue().length === 0 && capRows().length === capBase + 1 && String(capRows()[0].result) === 'blocked', { queue: readQueue().length, cap: capRows() });
  await ops.recoverStalledRoles(PROJECT, { now: baseMs + 33 * 60 * 1000, write: true });
  check('C 再跑一拍：不重复告警（ATTEMPT_CAP 仍 1 行）', capRows().length === capBase + 1, { cap: capRows().length });
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nB-ebbc 重投退避断言：${passed}/${results.length} PASS`);
  const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-ebbc');
  fs.mkdirSync(evDir, { recursive: true });
  fs.writeFileSync(path.join(evDir, 'run-ebbc.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, passed, results }, null, 2) + '\n', 'utf8');
})();
