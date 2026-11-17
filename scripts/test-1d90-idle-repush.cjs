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
  fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
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
  runCli(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
  const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
  const taskDir = path.join(stateDir, '任务');
  const queueFile = path.join(stateDir, '派单队列.json');
  const auditFile = path.join(stateDir, '派单投递审计.jsonl');
  const readQueue = () => { try { return JSON.parse(fs.readFileSync(queueFile, 'utf8')).items || []; } catch { return []; } };
  const readAudit = () => (fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
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

  // ── 第 4 组：过滤码审计（REPUSH_FILTERED_*）每 itemId 每天 ≤1 行 ──
  const filteredAudit = readAudit().filter((row) => String(row.code || '').startsWith('REPUSH_FILTERED_'));
  const perItem = {};
  for (const row of filteredAudit) perItem[String(row.itemId)] = (perItem[String(row.itemId)] || 0) + 1;
  const overLimit = Object.entries(perItem).filter(([, n]) => n > 1);
  check('F 过滤码审计每 itemId 每天 ≤1 行（不刷屏）', overLimit.length === 0, { overLimit, rows: filteredAudit.length });

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nB-1d90 空闲重派生产端断言：${passed}/${results.length} PASS`);
  const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-1d90');
  fs.mkdirSync(evDir, { recursive: true });
  fs.writeFileSync(path.join(evDir, 'run-1d90.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, passed, results }, null, 2) + '\n', 'utf8');
})();
