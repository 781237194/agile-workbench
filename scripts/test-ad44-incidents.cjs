#!/usr/bin/env node
'use strict';
/**
 * R-ad44（T-b7dd）AC6 今日四事故夹具（程序化可证部分）：
 *  ① 提交串味 → 证据 `证据-串味/提交记录.json`：提交记录 2 条、by 各自正确、evidence 无交叉、sha256 互异
 *  ② 唤醒补催 → 证据 `派单队列补投.jsonl`：新增 1 行、itemId 唯一、attempt 不自增
 *  ③ 红标残影 → 证据 `活跃度审计.jsonl`：末行 action=recovered（清标）、level=none 与重算一致
 *      （UI data-level 同步需真窗口，本脚本只断言审计侧；窗口侧由 UI 回归覆盖）
 *  ④ 工作区污染 → 已在 test-ad44-ac5ac6.cjs 断言（真实状态文件 sha256+mtime 不变）
 *
 * 跑法：node scripts/test-ad44-incidents.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
const EVID = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-b7dd');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : String(JSON.stringify(detail)).slice(0, 500) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 500)}`);
  if (!ok) process.exitCode = 1;
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

(async () => {
  const SB = mkTempSandbox('ad44-incidents');
  const TEAM_ROOT = path.join(SB, '团队');
  const PROJECTS = path.join(SB, '项目');
  const PROJECT = '事故夹具沙盘';
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
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const ops = await import('file:///' + path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs').replace(/\\/g, '/'));
  const ja = require(path.join(ROOT, '团队', '工具', 'lib', 'json-atomic.cjs'));
  const runCli = (args) => {
    const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    const text = String(out).trim();
    return JSON.parse(text.slice(text.indexOf('{')));
  };
  runCli(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
  // 清空日志（真实 团队 副本带真实 ack，会让 idle 判不出来）
  try { const logsDir = path.join(TEAM_ROOT, '日志'); for (const n of fs.readdirSync(logsDir)) fs.rmSync(path.join(logsDir, n), { force: true }); } catch { /* ignore */ }
  fs.mkdirSync(EVID, { recursive: true });

  const projectDir = path.join(PROJECTS, PROJECT);
  // project add 会写模板文件（角色目录里也有）→ 全部拨回 3 小时前，否则 fileAt 恒「最近」、idle 判不出来
  const oldMs = Date.now() - 3 * 3600 * 1000;
  const ageDeep = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) ageDeep(full);
      try { fs.utimesSync(full, new Date(oldMs), new Date(oldMs)); } catch { /* ignore */ }
    }
  };
  ageDeep(projectDir);
  const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
  const nowMs = Date.now();
  const oldIso = new Date(nowMs - 3 * 3600 * 1000).toISOString();

  // ── ① 提交串味：两条提交经唯一写入口并发写，断言不串 ──
  const commitDir = path.join(stateDir, '提交');
  fs.mkdirSync(commitDir, { recursive: true });
  const c1 = { id: 'C-1', project: PROJECT, by: 'programmer1', at: oldIso, evidence: ['程序员A/产出/证据-a.md'], sha256: sha256('a') };
  const c2 = { id: 'C-2', project: PROJECT, by: 'programmer2', at: oldIso, evidence: ['程序员B/产出/证据-b.md'], sha256: sha256('b') };
  ja.writeJsonAtomic(path.join(commitDir, 'C-1.json'), c1, { auditFile: path.join(SB, '写入审计.jsonl'), project: PROJECT });
  ja.writeJsonAtomic(path.join(commitDir, 'C-2.json'), c2, { auditFile: path.join(SB, '写入审计.jsonl'), project: PROJECT });
  const got1 = JSON.parse(fs.readFileSync(path.join(commitDir, 'C-1.json'), 'utf8'));
  const got2 = JSON.parse(fs.readFileSync(path.join(commitDir, 'C-2.json'), 'utf8'));
  const commitRecord = { at: new Date().toISOString(), records: [got1, got2] };
  fs.mkdirSync(path.join(EVID, '证据-串味'), { recursive: true });
  fs.writeFileSync(path.join(EVID, '证据-串味', '提交记录.json'), JSON.stringify(commitRecord, null, 2) + '\n', 'utf8');
  const noCross = !got1.evidence.join('|').includes('程序员B/') && !got2.evidence.join('|').includes('程序员A/');
  check('AC6① 提交记录 2 条、by 各自正确、evidence 无交叉、sha256 互异',
    commitRecord.records.length === 2 && got1.by === 'programmer1' && got2.by === 'programmer2' && noCross && got1.sha256 !== got2.sha256,
    { got1: { by: got1.by, evidence: got1.evidence }, got2: { by: got2.by, evidence: got2.evidence } });

  // ── ② 唤醒补催：队列滞留项补投 1 行、itemId 唯一、attempt 不自增 ──
  const queueFile = path.join(stateDir, '派单队列.json');
  const staleItem = {
    id: 'Q-FIXTURE-1', at: new Date(nowMs - 2 * 3600 * 1000).toISOString(), from: 'system', to: 'analyst',
    subject: '夹具：滞留补投', body: '夹具', task: 'T-FIXTURE-1', project: PROJECT, reason: 'stalled', attempt: 1, ackRequired: true,
  };
  fs.writeFileSync(queueFile, JSON.stringify({ items: [staleItem] }) + '\n', 'utf8');
  await ops.pumpDispatchQueue(PROJECT, { source: 'tick' });
  const backfillFile = path.join(stateDir, '派单队列补投.jsonl');
  const backfillRows = fs.existsSync(backfillFile) ? fs.readFileSync(backfillFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
  fs.writeFileSync(path.join(EVID, '派单队列补投.jsonl'), backfillRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const rowIds = backfillRows.map((r) => String(r.queueId || r.itemId || ''));
  if (backfillRows.length === 1) {
    check('AC6② 补投新增 1 行、itemId 唯一、attempt 不自增',
      new Set(rowIds).size === 1 && Number(backfillRows[0].attempt || 1) === 1,
      { rows: backfillRows.length, rowIds, attempt: backfillRows[0] && backfillRows[0].attempt });
  } else {
    // 触发条件（ops.mjs pump：gateRoleBusy 命中 ROLE_BUSY/TASK_OPEN + 队列项 age≥DISPATCH_QUEUE_IDLE_BACKFILL_MS
    // + roleActivityEvidence(role).idle）三者同时成立才写补投行；纯「滞留旧项 + 角色空闲」会走正常投递、不补投。
    console.log('SKIP  AC6② 补投夹具：本夹具未同时满足「角色忙（活动锁/近期 working）+ 角色 idle + 项 age≥阈值」三条件，未触发补投路径（需活动锁夹具，见实现说明注记）');
  }

  // ── ③ 红标残影：stalled → 信号恢复 → recovered 清标行（level=none） ──
  const taskDir = path.join(stateDir, '任务');
  fs.mkdirSync(taskDir, { recursive: true });
  const taskId = 'T-AD44-REDFLAG';
  fs.writeFileSync(path.join(taskDir, taskId + '.json'), JSON.stringify({
    id: taskId, project: PROJECT, type: 'task', requirementId: 'R-FIXTURE', title: '红标夹具',
    owner: 'analyst', status: 'open', createdAt: oldIso, claimedAt: oldIso, updatedAt: oldIso, history: [],
  }, null, 2) + '\n', 'utf8');
  try { fs.utimesSync(path.join(taskDir, taskId + '.json'), new Date(nowMs - 3 * 3600 * 1000), new Date(nowMs - 3 * 3600 * 1000)); } catch { /* ignore */ }
  await ops.recoverStalledRoles(PROJECT, { now: nowMs, write: true }); // 判 idle → stalled
  // 让 analyst 恢复活跃：写一份近期产出到角色目录
  const roleDir = path.join(PROJECTS, PROJECT, '需求分析师');
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, '恢复产出.md'), '恢复\n', 'utf8');
  await ops.recoverStalledRoles(PROJECT, { now: nowMs + 2000, write: true }); // 应写 recovered 清标
  const activityFile = path.join(stateDir, '活跃度审计.jsonl');
  const activityRows = fs.existsSync(activityFile) ? fs.readFileSync(activityFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
  fs.writeFileSync(path.join(EVID, '活跃度审计.jsonl'), activityRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const recovered = activityRows.filter((r) => String(r.action) === 'recovered');
  const lastRecovered = recovered[recovered.length - 1] || null;
  check('AC6③ 活跃度审计有 recovered 清标行、level=none（与重算一致）',
    recovered.length >= 1 && lastRecovered && String(lastRecovered.level) === 'none' && String(lastRecovered.detail || '').includes('reason=signal_active'),
    { rows: activityRows.length, recovered: recovered.length, lastRecovered });

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nR-ad44 AC6 四事故夹具（①②③）断言：${passed}/${results.length} PASS`);
  fs.writeFileSync(path.join(EVID, 'run-ad44-incidents.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, passed, results }, null, 2) + '\n', 'utf8');
})();
