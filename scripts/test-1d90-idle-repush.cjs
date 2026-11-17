#!/usr/bin/env node
'use strict';
/**
 * B-20261117-110240-1d90 回归：空闲重派生产端批量灌队列
 *
 * 现场（PM 实测 11:00–11:02）：`派单队列.json` 一度 55 条 Q-STALL，其中 53 条任务已闭环、1 条是
 * programmer1 正在做的任务自身；清队列 50 秒后同一批 itemId 原样回流。
 *
 * 断言（三类夹具 × 连跑 5 拍）：
 *  A 已闭环任务（accepted/done/cancelled）→ 不产生 Q-STALL，也不写 REPUSH_FILTERED_task_closed 以外的东西；
 *  B 镜像任务（type=requirement，id===requirementId）→ 不产生 Q-STALL；
 *  C 角色自身在办任务（owner=role 且 claim 后未 done）→ 不产生 Q-STALL，且该角色因「任务产出 mtime 在动」判 active（不 idle）。
 *  D 清空队列后连跑 5 拍：队列不回流（始终 0 条 Q-STALL）；
 *  E 入队过滤审计每 itemId 每天最多 1 行（不刷屏）。
 *
 * 跑法：node scripts/test-1d90-idle-repush.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : String(JSON.stringify(detail)).slice(0, 500) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 500)}`);
  if (!ok) process.exitCode = 1;
}

(async () => {
  const SB = mkTempSandbox('1d90');
  const TEAM_ROOT = path.join(SB, '团队');
  const PROJECTS = path.join(SB, '项目');
  const PROJECT = '空闲重派生产端沙盘';
  const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
  const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1', TEAM_WORKBENCH_JSON: path.join(SB, 'data', 'userdata', 'workbench.json') };
  fs.mkdirSync(path.join(SB, 'data', 'userdata'), { recursive: true });
  fs.mkdirSync(PROJECTS, { recursive: true });
  // PM 2026-11-17 12:41 确认真因：cpSync 直复制真团队会在其被并发写时撞 tmp+rename 竞态（随机红）。
  // 改为白名单只复制稳定内容（工具/协议/宪法/铁律/团队.json），其余状态、邮箱、启动、会话、路由、日志全部不复制；失败重试 3 次。
  const KEEP_RE = /^团队(\/?$|\/状态\/?$|\/状态\/团队\.json$|\/(工具|协议)(\/|$)|\/(团队宪法\.md|项目铁律\.md)$)/;
  const copyTeam = () => fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => KEEP_RE.test(path.relative(ROOT, src).replace(/\\/g, '/')) });
  let copied = false;
  for (let attempt = 1; attempt <= 3 && !copied; attempt += 1) {
    try { fs.rmSync(TEAM_ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); copyTeam(); copied = true; }
    catch (e) { if (attempt === 3) throw e; await new Promise((r) => setTimeout(r, 200 * attempt)); }
  }
  const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
  const teamData = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  (teamData.members || []).forEach((m) => { m.sessionId = ''; });
  delete teamData.activeProject;
  fs.writeFileSync(teamFile, JSON.stringify(teamData, null, 2) + '\n', 'utf8');
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const ops = await import('file:///' + path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs').replace(/\\/g, '/'));
  const gates = await import('file:///' + path.join(ROOT, '团队', '工具', 'lib', 'gates.mjs').replace(/\\/g, '/'));

  const runCli = (args) => {
    const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    const text = String(out).trim();
    return JSON.parse(text.slice(text.indexOf('{')));
  };
  // 清空沙盘 日志/（团队目录是真实 团队 的副本，日志里带各角色真实 ack → ackAt 会被误当近期信号）
  try {
    const logsDir = path.join(TEAM_ROOT, '日志');
    for (const name of fs.readdirSync(logsDir)) fs.rmSync(path.join(logsDir, name), { force: true });
  } catch { /* 日志目录不存在不影响 */ }
  runCli(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
  const projectDir = path.join(PROJECTS, PROJECT);
  // 项目初始化会写模板文件（角色目录里也有）→ 全部拨回 3 小时前，否则 fileAt 恒「最近」
  const oldMs = Date.now() - 3 * 3600 * 1000;
  const ageDeep = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) ageDeep(full);
      try { fs.utimesSync(full, new Date(oldMs), new Date(oldMs)); } catch { /* 忽略 */ }
    }
  };
  ageDeep(projectDir);
  const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
  const taskDir = path.join(stateDir, '任务');
  const queueFile = path.join(stateDir, '派单队列.json');
  const auditFile = path.join(stateDir, '派单投递审计.jsonl');
  const readQueue = () => { try { return JSON.parse(fs.readFileSync(queueFile, 'utf8')).items || []; } catch { return []; } };
  const readAudit = () => (fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
  const wakeLogFile = path.join(stateDir, '唤醒.jsonl');
  const readWakeRows = () => (fs.existsSync(wakeLogFile)
    ? fs.readFileSync(wakeLogFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : []);
  const stalledWakeCount = (role) => readWakeRows().filter((r) => String(r.to || '') === role && String(r.reason || '') === 'stalled').length;

  const nowMs = Date.now();
  const oldIso = new Date(nowMs - 3 * 60 * 60 * 1000).toISOString(); // 3 小时前：三信号全在窗口外

  const writeTask = (id, patch) => {
    fs.writeFileSync(path.join(taskDir, `${id}.json`), JSON.stringify({
      id, project: PROJECT, type: 'task', requirementId: 'R-1d90-fixture', title: '1d90 夹具',
      owner: 'analyst', status: 'open', createdAt: oldIso, claimedAt: oldIso, updatedAt: oldIso, history: [],
      ...patch,
    }, null, 2) + '\n', 'utf8');
  };

  // ── 夹具 A：已闭环任务 ──
  writeTask('T-1d90-closed-a', { status: 'accepted', acceptedAt: oldIso });
  writeTask('T-1d90-closed-d', { status: 'done', doneAt: oldIso });
  writeTask('T-1d90-closed-c', { status: 'cancelled', cancelledAt: oldIso });
  // ── 夹具 B：镜像任务（id===requirementId）──
  const mirrorId = 'R-1d90-mirror';
  fs.writeFileSync(path.join(taskDir, `${mirrorId}.json`), JSON.stringify({
    id: mirrorId, project: PROJECT, type: 'requirement', requirementId: mirrorId, title: '1d90 镜像夹具',
    owner: 'analyst', status: 'open', createdAt: oldIso, claimedAt: oldIso, updatedAt: oldIso, history: [],
  }, null, 2) + '\n', 'utf8');
  // ── 夹具 C：角色自身在办任务（claim 3 小时前 + 产出文件刚写）──
  const evidenceFile = path.join(stateDir, '产出', 'own-work.txt');
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, '正在写产出\n', 'utf8');
  writeTask('T-1d90-own', {
    status: 'working',
    claimedAt: oldIso,
    evidence: '产出/own-work.txt',
    evidenceFiles: [{ path: '产出/own-work.txt', scope: 'project', kind: 'file' }],
    history: [{ ts: oldIso, by: 'analyst', action: 'claim', note: '' }],
  });

  // 夹具文件刚写进来 → 把任务 JSON 的 mtime 拨回 3 小时前（否则 roleTaskProgressAt 会把「造夹具」当成活跃）
  for (const name of fs.readdirSync(taskDir)) {
    try { fs.utimesSync(path.join(taskDir, name), new Date(nowMs - 3 * 3600 * 1000), new Date(nowMs - 3 * 3600 * 1000)); } catch { /* 忽略 */ }
  }

  // ── 第 1 组：三类夹具连跑 5 拍 → 不产生 Q-STALL ──
  const stallItems = () => readQueue().filter((row) => String(row && row.id || '').startsWith('Q-STALL-'));
  for (let i = 1; i <= 5; i += 1) {
    await ops.recoverStalledRoles(PROJECT, { now: nowMs + i * 30 * 1000, write: true });
  }
  check('A/B/C 三类夹具（已闭环/镜像/自身在办）连跑 5 拍 → 队列 0 条 Q-STALL', stallItems().length === 0, stallItems().map((r) => r.id));
  // 兜底层单测：recoverStalledRoles 的候选已被 scan 过滤，这里直接验证入队函数对三类任务都拒（工作树接口导出于测试）
  const direct = (taskId) => ops.requeueStalledItem(PROJECT, { itemId: 'Q-STALL-analyst-' + taskId, role: 'analyst', taskId, now: nowMs + 5 * 60 * 1000, attempt: 1 });
  const rClosed = direct('T-1d90-closed-a');
  const rMirror = direct('R-1d90-mirror');
  const rOwn = direct('T-1d90-own');
  const codes = [rClosed.skipped, rMirror.skipped, rOwn.skipped];
  check('A/B/C 入队兜底：闭环=task_closed / 镜像=mirror_task / 自身在办=self_claimed，且都不入队',
    codes.join(',') === 'task_closed,mirror_task,self_claimed' && [rClosed, rMirror, rOwn].every((r) => r.enqueued === false), { codes, enqueued: [rClosed.enqueued, rMirror.enqueued, rOwn.enqueued] });

  // ── 第 2 组：清空队列后连跑 5 拍 → 不回流 ──
  fs.writeFileSync(queueFile, JSON.stringify({ items: [] }) + '\n', 'utf8');
  for (let i = 1; i <= 5; i += 1) {
    await ops.recoverStalledRoles(PROJECT, { now: nowMs + (6 + i) * 30 * 1000, write: true });
  }
  check('D 清队列后连跑 5 拍 → 队列不回流（0 条 Q-STALL）', stallItems().length === 0, stallItems().map((r) => r.id));

  // ── 第 3 组：idle 判据要看「在办任务产出 mtime」→ 自身在办角色判 active ──
  const det = ops.detectStalledRoles(PROJECT, { now: nowMs + 5 * 60 * 1000 });
  const analystRow = (det.roles || {}).analyst || {};
  check('E 角色自身在办任务且产出 mtime 在窗口内 → verdict active（不再判 idle）',
    analystRow.verdict === 'active' && analystRow.signals && Boolean(analystRow.signals.progressAt),
    { verdict: analystRow.verdict, signals: analystRow.signals });

  // ── 第 5 组（PM 11:39 收窄版）：wakeAt 廉价信号 —— 近期唤醒成功也算 active ──
  const wakeFile = path.join(stateDir, '唤醒.jsonl');
  const wakeRows = fs.existsSync(wakeFile) ? fs.readFileSync(wakeFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  wakeRows.push({ at: new Date(Date.now() - 60 * 1000).toISOString(), project: PROJECT, to: 'analyst', ok: true, reason: 'wake' });
  fs.writeFileSync(wakeFile, wakeRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const detWake = ops.detectStalledRoles(PROJECT, { now: Date.now() });
  const wakeRow = (detWake.roles || {}).analyst || {};
  check('G 近期唤醒成功（ok=true）→ wakeAt 信号在、verdict active（不判 idle）', wakeRow.verdict === 'active' && wakeRow.signals && Boolean(wakeRow.signals.wakeAt), { verdict: wakeRow.verdict, signals: wakeRow.signals });

  // ── 第 6 组：近期产出文件（fileAt 在窗口内）→ active ──
  const productDir = path.join(projectDir, '产品');
  fs.mkdirSync(productDir, { recursive: true });
  fs.writeFileSync(path.join(productDir, '最新稿.md'), '刚写的稿\n', 'utf8');
  const detOut = ops.detectStalledRoles(PROJECT, { now: Date.now() });
  const outRow = (detOut.roles || {}).product || {};
  check('H 角色目录近期有产出文件 → verdict active（既有 fileAt 信号仍生效）', outRow.verdict === 'active' && outRow.signals && Boolean(outRow.signals.fileAt), { verdict: outRow.verdict, signals: outRow.signals });

  // ── 第 7 组：真 idle 仍要被叫（保留夹具）──
  const testerTask = 'T-1d90-tester-idle';
  writeTask(testerTask, { owner: 'tester', status: 'open' });
  const testerTaskFile = path.join(taskDir, testerTask + '.json');
  try { fs.utimesSync(testerTaskFile, new Date(nowMs - 3 * 3600 * 1000), new Date(nowMs - 3 * 3600 * 1000)); } catch { /* 忽略 */ }
  const detIdle = ops.detectStalledRoles(PROJECT, { now: Date.now() });
  const testerRow = (detIdle.roles || {}).tester || {};
  const idleQueueBefore = readQueue().length;
  await ops.recoverStalledRoles(PROJECT, { now: Date.now() + 1000, write: true });
  const testerQueue = readQueue().filter((row) => String(row && row.id || '').includes('-tester-'));
  check('I 真 idle（无任何近期信号 + 有 open 任务）→ verdict idle 且被重新入队（真 idle 仍被叫）', testerRow.verdict === 'idle' && testerQueue.length === 1, { verdict: testerRow.verdict, queue: testerQueue.map((r) => r.id), before: idleQueueBefore });

  // ── 第 4 组：过滤码审计（REPUSH_FILTERED_*）每 itemId 每天 ≤1 行 ──
  const filteredAudit = readAudit().filter((row) => String(row.code || '').startsWith('REPUSH_FILTERED_'));
  const perItem = {};
  for (const row of filteredAudit) perItem[String(row.itemId)] = (perItem[String(row.itemId)] || 0) + 1;
  const overLimit = Object.entries(perItem).filter(([, n]) => n > 1);
  check('F 过滤码审计每 itemId 每天 ≤1 行（不刷屏）', overLimit.length === 0, { overLimit, rows: filteredAudit.length });


  // ── 第 8 组（B-0868 收口面，PM 2026-11-17 12:06 裁定「选 b 变体」）：只改夹具构造，不改 1d90 判据 ──
  // 1d90 语义：窗口内有进度=active 不重派；窗口内无进度=idle 重派。因此用同一条 working 任务拨产出 mtime 做双向用例。
  const pmOutDir = path.join(projectDir, '产出');
  fs.mkdirSync(pmOutDir, { recursive: true });
  const pmFreshFile = path.join(pmOutDir, 'pm-fresh.txt');
  fs.writeFileSync(pmFreshFile, '近期产出\n', 'utf8'); // 刚写 → 窗口内
  writeTask('T-1d90-pm-working', {
    owner: 'pm', status: 'working', claimedAt: oldIso,
    evidence: '产出/pm-fresh.txt',
    evidenceFiles: [{ path: '产出/pm-fresh.txt', scope: 'project', kind: 'file' }],
    history: [{ ts: oldIso, by: 'pm', action: 'claim', note: '' }],
  });
  const agePmTasks = () => {
    for (const name of fs.readdirSync(taskDir)) {
      if (!/-pm-/.test(name)) continue;
      try { fs.utimesSync(path.join(taskDir, name), new Date(oldMs), new Date(oldMs)); } catch { /* 忽略 */ }
    }
  };
  agePmTasks();
  const pmStallCount = () => readQueue().filter((row) => String(row && row.id || '').startsWith('Q-STALL-pm-')).length;
  const pmQueueBeforeFresh = pmStallCount();
  const detFresh = ops.detectStalledRoles(PROJECT, { now: Date.now() });
  const pmFreshRow = (detFresh.roles || {}).pm || {};
  await ops.recoverStalledRoles(PROJECT, { now: Date.now() + 2000, write: true });
  check('J working + 产出在窗口内 → verdict active 且不重派（反向用例）',
    pmFreshRow.verdict === 'active' && pmStallCount() === pmQueueBeforeFresh,
    { verdict: pmFreshRow.verdict, before: pmQueueBeforeFresh, after: pmStallCount(), signals: pmFreshRow.signals });
  // 同一条 working 任务：把产出 mtime 拨到超窗口 → 应判 idle 并重派入队
  try { fs.utimesSync(pmFreshFile, new Date(oldMs), new Date(oldMs)); } catch { /* 忽略 */ }
  agePmTasks();
  const detStale = ops.detectStalledRoles(PROJECT, { now: Date.now() });
  const pmStaleRow = (detStale.roles || {}).pm || {};
  const pmQueueBeforeStale = pmStallCount();
  await ops.recoverStalledRoles(PROJECT, { now: Date.now() + 4000, write: true });
  // 口径（PM 2026-11-17 12:47 裁定）：入队=派新活、唤醒=催在办的人，两者职责分离——
  // ①self_claimed 保持：角色自己在办的 working 任务**不重新入队**（避免重复派单/灌脏队列）；
  // ②但 working+窗口内无进度仍要叫醒：verdict=idle → wakeStalledRole 唤醒 1 次；
  // ③受 27ca idle-episode 去重约束：同一 episode 再跑多拍仍只 1 条唤醒。
  const pmWakeBefore = stalledWakeCount('pm');
  for (let i = 0; i < 4; i += 1) {
    await ops.recoverStalledRoles(PROJECT, { now: Date.now() + (5 + i) * 30000, write: true });
  }
  const pmWakeAfter = stalledWakeCount('pm');
  check('K working + 产出超窗口 → idle：不入队(self_claimed) 但唤醒 1 条且同 episode 不重复',
    pmStaleRow.verdict === 'idle' && pmStallCount() === pmQueueBeforeStale && pmWakeAfter === 1 && pmWakeBefore === 1,
    { verdict: pmStaleRow.verdict, queueBefore: pmQueueBeforeStale, queueAfter: pmStallCount(), wakeBefore: pmWakeBefore, wakeAfter: pmWakeAfter });

  // 3 accepted + 1 open：accepted 不得进 openTaskIds、不得入队；open 仍算在办
  writeTask('T-1d90-pm-acc-1', { owner: 'pm', status: 'accepted', acceptedAt: oldIso });
  writeTask('T-1d90-pm-acc-2', { owner: 'pm', status: 'accepted', acceptedAt: oldIso });
  writeTask('T-1d90-pm-acc-3', { owner: 'pm', status: 'accepted', acceptedAt: oldIso });
  writeTask('T-1d90-pm-open-1', { owner: 'pm', status: 'open' });
  agePmTasks();
  const detMix = ops.detectStalledRoles(PROJECT, { now: Date.now() });
  const pmMixRow = (detMix.roles || {}).pm || {};
  const pmMixOpen = Array.isArray(pmMixRow.openTaskIds) ? pmMixRow.openTaskIds.slice() : [];
  await ops.recoverStalledRoles(PROJECT, { now: Date.now() + 6000, write: true });
  const pmQueuedTasks = readQueue()
    .filter((row) => String(row && row.id || '').startsWith('Q-STALL-pm-'))
    .map((row) => String(row.task || ''));
  const acceptedLeaked = ['T-1d90-pm-acc-1', 'T-1d90-pm-acc-2', 'T-1d90-pm-acc-3']
    .filter((id) => pmMixOpen.includes(id) || pmQueuedTasks.includes(id));
  check('L 3 accepted + 1 open → openTaskIds 只剩 open、accepted 不入队',
    acceptedLeaked.length === 0 && pmMixOpen.includes('T-1d90-pm-open-1'),
    { openTaskIds: pmMixOpen, queued: pmQueuedTasks, acceptedLeaked });
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nB-1d90 空闲重派生产端断言：${passed}/${results.length} PASS`);
  const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-1d90');
  fs.mkdirSync(evDir, { recursive: true });
  fs.writeFileSync(path.join(evDir, 'run-1d90.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, passed, results }, null, 2) + '\n', 'utf8');
})();
