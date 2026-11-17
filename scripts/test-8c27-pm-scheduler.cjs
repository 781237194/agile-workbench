/**
 * T-20261117-203758-8c27 夹具：PM 调度器（只读）8 条断言。
 *
 * 沙盘：_tmp/pm-sched-<pid>/团队/状态/项目/<项目>/ 下造 会话排队/轮次/用量/任务 夹具。
 * 断言：
 *   S1 running 角色 → hold（DSH running）
 *   S2 queued>0 → hold（排队 N 条）
 *   S3 有在办任务（working owner）→ hold
 *   S4 空闲 + 有未认领任务 → dispatchable
 *   S5 空闲 + 无未认领 → standby
 *   S6 roundsSinceArchive ≥ 20 → rotate_first（且原因含「轮次」）
 *   S7 用量 level=warn → rotate_first；running 且 lastAt 远超 staleMs → stale_alert
 *   S8 缺 会话排队.json → 各角色 queueSource=missing 且决策不崩；--json 恰好一行 JSON；**零写入**（沙盘全文件 sha 前后不变）
 *
 * 跑法：node scripts/test-8c27-pm-scheduler.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');

const ROOT = (() => {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, '团队', '工具', 'team.mjs'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('找不到仓库根');
})();
const PROJECT = '沙盘调度';
const SB = path.join(ROOT, '_tmp', `pm-sched-${process.pid}`);
const STATE = path.join(SB, '团队', '状态', '项目', PROJECT);
const SCRIPT = path.join(ROOT, 'scripts', 'pm-scheduler.cjs');
const NOW = '2026-11-17T20:40:00.000Z';

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, error: String((e && e.message) || e) });
    console.log(`FAIL  ${name}\n      ${String((e && e.message) || e).split('\n')[0]}`);
  }
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
function seed({ queue, rounds = {}, usage = {}, tasks = [] }) {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(STATE, '任务'), { recursive: true });
  if (queue) fs.writeFileSync(path.join(STATE, '会话排队.json'), JSON.stringify(queue, null, 2), 'utf8');
  fs.writeFileSync(path.join(STATE, '会话轮次.json'), JSON.stringify(rounds, null, 2), 'utf8');
  if (Object.keys(usage).length) fs.writeFileSync(path.join(STATE, '会话用量.json'), JSON.stringify({ roles: usage }, null, 2), 'utf8');
  tasks.forEach((t, i) => fs.writeFileSync(path.join(STATE, '任务', `t${i}-${t.id}.json`), JSON.stringify(t, null, 2), 'utf8'));
}
function runJson() {
  const out = execFileSync(process.execPath, [SCRIPT, '--root', SB, '--project', PROJECT, '--now', NOW, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  const lines = String(out).trim().split(/\r?\n/).filter(Boolean);
  assert.strictEqual(lines.length, 1, `--json 输出不是一行：${lines.length} 行`);
  return JSON.parse(lines[0]);
}
const snapshot = () => {
  const map = {};
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p); else map[path.relative(SB, p)] = sha(p);
    }
  };
  walk(SB);
  return map;
};

check('S1 running → hold（DSH running）', () => {
  seed({ queue: { roles: { programmer1: { state: 'running', queued: 0, lastAt: NOW } } } });
  const j = runJson();
  assert.strictEqual(j.roles.programmer1.decision, 'hold');
  assert.ok(j.roles.programmer1.reasons.some((x) => /running/.test(x)), JSON.stringify(j.roles.programmer1.reasons));
  return 'hold/running';
});

check('S2 queued>0 → hold（排队 N 条）', () => {
  seed({ queue: { roles: { tester: { state: 'idle', queued: 3, lastAt: NOW } } } });
  const j = runJson();
  assert.strictEqual(j.roles.tester.decision, 'hold');
  assert.strictEqual(j.roles.tester.queued, 3);
  return 'hold/queued=3';
});

check('S3 有在办任务 → hold', () => {
  seed({ queue: {}, tasks: [{ id: 'T-a', owner: 'analyst', status: 'working', type: 'task' }] });
  const j = runJson();
  assert.strictEqual(j.roles.analyst.decision, 'hold');
  assert.ok(j.roles.analyst.openTasks.some((t) => t.id === 'T-a'));
  return 'hold/openTasks';
});

check('S4 空闲 + 未认领任务 → dispatchable', () => {
  seed({ queue: {}, tasks: [{ id: 'T-b', owner: '', status: 'open', type: 'task' }] });
  const j = runJson();
  assert.strictEqual(j.roles.product.decision, 'dispatchable');
  assert.strictEqual(j.unclaimedTasks, 1);
  return 'dispatchable';
});

check('S5 空闲 + 无可派 → standby', () => {
  seed({ queue: {} });
  const j = runJson();
  assert.strictEqual(j.roles.pm.decision, 'standby');
  return 'standby';
});

check('S6 roundsSinceArchive ≥ 20 → rotate_first（原因含轮次）', () => {
  seed({ queue: {}, rounds: { programmer2: { role: 'programmer2', roundsSinceArchive: 21 } } });
  const j = runJson();
  assert.strictEqual(j.roles.programmer2.decision, 'rotate_first');
  assert.ok(j.roles.programmer2.reasons.some((x) => /轮次/.test(x)), JSON.stringify(j.roles.programmer2.reasons));
  return 'rotate_first/轮次';
});

check('S7 用量 warn → rotate_first；running 且 lastAt 过旧 → stale_alert', () => {
  seed({
    queue: { roles: { programmer1: { state: 'running', queued: 0, lastAt: '2026-11-17T19:00:00.000Z' } } },
    usage: { programmer2: { level: 'warn' } },
  });
  const j = runJson();
  assert.strictEqual(j.roles.programmer2.decision, 'rotate_first');
  assert.strictEqual(j.roles.programmer1.decision, 'stale_alert');
  return 'rotate_first/usage + stale_alert';
});

check('S8 缺 会话排队.json → queueSource=missing、不崩；零写入（沙盘 sha 全不变）', () => {
  seed({ queue: null });
  const before = snapshot();
  const j = runJson();
  const after = snapshot();
  assert.strictEqual(j.roles.pm.queueSource, 'missing');
  assert.deepStrictEqual(after, before, '沙盘文件被改写（调度器必须只读）');
  return `queueSource=missing；${Object.keys(before).length} 个文件未变`;
});

fs.rmSync(SB, { recursive: true, force: true });
const pass = results.filter((r) => r.ok).length;
console.log(`\nPM_SCHEDULER ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
if (pass !== results.length) process.exit(1);
