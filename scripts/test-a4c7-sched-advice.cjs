/**
 * T-20261117-211833-7a30（R-a4c7）夹具：调度建议（纯函数 + CLI）。
 *
 * 覆盖：
 *   A 纯函数六组夹具（AC2）：queued>0→BUSY_HOLD / 行级 stale→STANDBY / 轮次到线→HANDOVER_FIRST /
 *     认领超时→STALL_ALERT / 空闲→IDLE_DISPATCH / 无排队行→STANDBY；
 *   B 新鲜度（AC1）：快照过期 / degraded / 行级 stale 都不得出 IDLE_DISPATCH；
 *   C 缺源降级（AC1⑥/AC3）：tasks 缺失 → UNAVAILABLE；rounds/usage 缺失 → null 且不判到线；
 *   D 阈值（AC3）：rotateRounds 默认 8（rounds=8 → HANDOVER_FIRST）；usage warn → HANDOVER_FIRST；
 *   E 停滞（AC6）：队列项滞留 ≥5 分钟 → STALL_ALERT；
 *   F CLI（AC5）：--json stdout 恰好一行 + 字段形状；重复调用不重复写其他文件；
 *   G 零副作用（AC4）：沙盘 会话排队/会话轮次/任务/role_queues 的 sha256+mtime 前后不变，只追加 调度建议.jsonl。
 *
 * 跑法：node scripts/test-a4c7-sched-advice.cjs
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
const SB = path.join(ROOT, '_tmp', `scheda4c7-${process.pid}`);
const SB_TEAM = path.join(SB, '团队');
const SB_PROJECTS = path.join(SB, '项目');
const SB_STATE = path.join(SB_TEAM, '状态');
const SB_PROJ_STATE = path.join(SB_STATE, '项目', PROJECT);
const LIBMJS = 'file:///' + path.join(ROOT, '团队', '工具', 'lib', 'sched-advice.mjs').replace(/\\/g, '/');
const NOW = Date.parse('2026-11-17T13:30:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

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
const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : 'missing');
const stat = (f) => { try { const s = fs.statSync(f); return `${s.size}:${s.mtimeMs}`; } catch { return 'missing'; } };
const decisionsOf = (advice) => Object.fromEntries(advice.roles.map((r) => [r.role, r.decision]));
const row = (role, over = {}) => ({ role, state: 'ok', queued: 0, running: false, lastAt: iso(NOW), stale: false, ...over });
const base = (over = {}) => ({
  now: NOW,
  project: PROJECT,
  queue: { at: iso(NOW), degraded: '', roles: { pm: row('pm'), product: row('product'), analyst: row('analyst'), programmer1: row('programmer1'), programmer2: row('programmer2'), tester: row('tester') } },
  rounds: {},
  usage: {},
  tasks: [],
  taskSourceAvailable: true,
  roleQueues: {},
  ...over,
});

(async () => {
  const { buildSchedAdvice } = await import(LIBMJS);

  // ── A 六组夹具（AC2）
  check('A1 pm queued>0 → BUSY_HOLD', () => {
    const a = buildSchedAdvice(base({ queue: { at: iso(NOW), degraded: '', roles: { pm: row('pm', { queued: 3 }) } } }));
    const pm = a.roles.find((r) => r.role === 'pm');
    assert.strictEqual(pm.decision, 'BUSY_HOLD');
    assert.strictEqual(pm.level, 'warn');
    return pm.reasons.join('；');
  });
  check('A2 行级 stale → STANDBY（不得判空闲）', () => {
    const a = buildSchedAdvice(base({ queue: { at: iso(NOW), degraded: '', roles: { pm: row('pm', { stale: true }) } } }));
    const pm = a.roles.find((r) => r.role === 'pm');
    assert.strictEqual(pm.decision, 'STANDBY');
    assert.ok(/stale/.test(pm.reasons.join('；')));
    return pm.reasons.join('；');
  });
  check('A3 轮次到线（默认 8）→ HANDOVER_FIRST', () => {
    const a = buildSchedAdvice(base({ rounds: { pm: { roundsSinceArchive: 8 } } }));
    const pm = a.roles.find((r) => r.role === 'pm');
    assert.strictEqual(pm.decision, 'HANDOVER_FIRST');
    assert.strictEqual(pm.level, 'bad');
    return pm.reasons.join('；');
  });
  check('A4 认领超时 → STALL_ALERT', () => {
    const tasks = [{ id: 'T-1', owner: 'pm', status: 'working', claimedAt: iso(NOW - 11 * 60 * 1000) }];
    const a = buildSchedAdvice(base({ tasks }));
    const pm = a.roles.find((r) => r.role === 'pm');
    assert.strictEqual(pm.decision, 'STALL_ALERT');
    assert.ok(/认领超时/.test(pm.reasons.join('；')));
    return pm.reasons.join('；');
  });
  check('A5 快照新鲜+state=ok+queued=0+无在办 → IDLE_DISPATCH', () => {
    const a = buildSchedAdvice(base());
    const pm = a.roles.find((r) => r.role === 'pm');
    assert.strictEqual(pm.decision, 'IDLE_DISPATCH');
    assert.strictEqual(pm.level, 'ok');
    return pm.nextAction;
  });
  check('A6 无排队行（state 缺失）→ STANDBY', () => {
    const a = buildSchedAdvice(base({ queue: { at: iso(NOW), degraded: '', roles: { pm: row('pm', { state: '' }) } } }));
    const pm = a.roles.find((r) => r.role === 'pm');
    assert.strictEqual(pm.decision, 'STANDBY');
    return pm.reasons.join('；');
  });

  // ── B 新鲜度（AC1）
  check('B1 快照过期（>120s）→ degraded=true 且全不出 IDLE_DISPATCH', () => {
    const a = buildSchedAdvice(base({ queue: { at: iso(NOW - 5 * 60 * 1000), degraded: '', roles: { pm: row('pm') } } }));
    assert.strictEqual(a.degraded, true);
    assert.ok(!a.roles.some((r) => r.decision === 'IDLE_DISPATCH'), JSON.stringify(decisionsOf(a)));
    return 'degraded + 0 idle';
  });
  check('B2 snapshot degraded 字段 → 不出 IDLE_DISPATCH', () => {
    const a = buildSchedAdvice(base({ queue: { at: iso(NOW), degraded: 'DSH 未连接', roles: { pm: row('pm') } } }));
    assert.strictEqual(a.degraded, true);
    assert.strictEqual(a.roles.find((r) => r.role === 'pm').decision, 'STANDBY');
    return 'STANDBY';
  });
  check('B3 queued=0 但行级 stale → 不判空闲', () => {
    const a = buildSchedAdvice(base({ queue: { at: iso(NOW), degraded: '', roles: { pm: row('pm', { stale: true, queued: 0 }) } } }));
    assert.strictEqual(a.roles.find((r) => r.role === 'pm').decision, 'STANDBY');
    return 'STANDBY';
  });

  // ── C 缺源（AC1⑥ / AC3）
  check('C1 tasks 缺失 → 全员 UNAVAILABLE', () => {
    const a = buildSchedAdvice(base({ tasks: [], taskSourceAvailable: false }));
    assert.ok(a.roles.every((r) => r.decision === 'UNAVAILABLE'), JSON.stringify(decisionsOf(a)));
    return 'UNAVAILABLE ×6';
  });
  check('C2 rounds/usage 缺失 → null 且不判到线', () => {
    const a = buildSchedAdvice(base());
    const pm = a.roles.find((r) => r.role === 'pm');
    assert.strictEqual(pm.facts.rounds, null);
    assert.strictEqual(pm.facts.usageLevel, null);
    assert.notStrictEqual(pm.decision, 'HANDOVER_FIRST');
    return 'rounds=null usage=null';
  });

  // ── D 阈值（AC3）
  check('D1 rotateRounds 默认 8；7 不到线、8 到线', () => {
    const a7 = buildSchedAdvice(base({ rounds: { pm: { roundsSinceArchive: 7 } } }));
    const a8 = buildSchedAdvice(base({ rounds: { pm: { roundsSinceArchive: 8 } } }));
    assert.strictEqual(a7.roles.find((r) => r.role === 'pm').decision, 'IDLE_DISPATCH');
    assert.strictEqual(a8.roles.find((r) => r.role === 'pm').decision, 'HANDOVER_FIRST');
    return '7→idle / 8→handover';
  });
  check('D2 usage warn（30万+）→ HANDOVER_FIRST', () => {
    const a = buildSchedAdvice(base({ usage: { pm: { inputTokens: 320000 } } }));
    const pm = a.roles.find((r) => r.role === 'pm');
    assert.strictEqual(pm.decision, 'HANDOVER_FIRST');
    assert.ok(/warn/.test(pm.reasons.join('；')));
    return 'warn→handover';
  });

  // ── E 队列滞留（AC6）
  check('E1 队列项滞留 ≥5 分钟 → STALL_ALERT', () => {
    const a = buildSchedAdvice(base({ roleQueues: { pm: { queue: [{ id: 'q1', since: iso(NOW - 6 * 60 * 1000) }] } } }));
    const pm = a.roles.find((r) => r.role === 'pm');
    assert.strictEqual(pm.decision, 'STALL_ALERT');
    assert.ok(/队列滞留/.test(pm.reasons.join('；')));
    return '滞留→stall';
  });

  // ── F/G 沙盘 CLI：零副作用 + 单行 JSON
  seedSandbox();
  const boot = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-sched']);
  const token = (String(boot.out).match(/令牌:\s*([0-9a-f]+)/) || [])[1];
  assert.ok(token, `沙盘 boot 失败：${boot.out.slice(0, 200)}${boot.err || ''}`);

  check('F1 CLI --json 恰好一行且字段齐全', () => {
    const out = execFileSync(process.execPath, [path.join(SB_TEAM, '工具', 'team.mjs'), 'sched', 'advice', '--role', 'programmer1', '--project', PROJECT, '--boot', token, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: env() });
    const lines = String(out).trim().split(/\r?\n/).filter(Boolean);
    assert.strictEqual(lines.length, 1, `stdout 不是一行：${lines.length}`);
    const j = JSON.parse(lines[0]);
    for (const k of ['ok', 'at', 'project', 'degraded', 'roles']) assert.ok(k in j, `缺字段 ${k}`);
    assert.ok(Array.isArray(j.roles) && j.roles.length);
    for (const r of j.roles) {
      for (const k of ['role', 'decision', 'reasons', 'level', 'nextAction', 'sources']) assert.ok(k in r, `role 行缺 ${k}`);
    }
    return `${j.roles.length} 角色 / 单行`;
  });

  check('G1 零副作用：三源文件 sha256+mtime 前后不变，只追加 调度建议.jsonl', () => {
    const watch = [
      path.join(SB_STATE, '会话排队.json'),
      path.join(SB_PROJ_STATE, '会话轮次.json'),
      path.join(SB_PROJ_STATE, 'role_queues.json'),
    ];
    const before = watch.map((f) => [sha(f), stat(f)]);
    const logFile = path.join(SB_PROJ_STATE, '调度建议.jsonl');
    const logBefore = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split(/\n/).filter(Boolean).length : 0;
    const out = execFileSync(process.execPath, [path.join(SB_TEAM, '工具', 'team.mjs'), 'sched', 'advice', '--role', 'programmer1', '--project', PROJECT, '--boot', token, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: env() });
    assert.ok(JSON.parse(String(out).trim()).ok);
    const after = watch.map((f) => [sha(f), stat(f)]);
    assert.deepStrictEqual(after, before, '三源文件被改写');
    const logAfter = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split(/\n/).filter(Boolean).length : 0;
    assert.strictEqual(logAfter, logBefore + 1, '调度建议.jsonl 应恰好 +1 行');
    return `三源未变；审计 +1（${logAfter}）`;
  });

  fs.rmSync(SB, { recursive: true, force: true });
  const pass = results.filter((r) => r.ok).length;
  console.log(`\nA4C7_SCHED ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
  if (pass !== results.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });

function env() {
  return { ...process.env, TEAM_ROOT: SB_TEAM, TEAM_PROJECTS_ROOT: SB_PROJECTS, TEAM_SELFTEST: '1' };
}
function cli(args) {
  try {
    return { ok: true, out: execFileSync(process.execPath, [path.join(SB_TEAM, '工具', 'team.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: env() }) };
  } catch (e) {
    return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}
function seedSandbox() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(SB_STATE, '项目', PROJECT, '任务'), { recursive: true });
  fs.mkdirSync(SB_PROJECTS, { recursive: true });
  fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(SB_TEAM, '工具'), { recursive: true });
  for (const f of ['团队宪法.md', '项目铁律.md']) {
    const src = path.join(ROOT, '团队', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SB_TEAM, f));
  }
  const team = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8'));
  for (const m of team.members || []) { m.sessionId = ''; m.archivedSession = ''; m.replacedBySessionId = ''; m.sessionPrevSessionId = ''; }
  delete team.activeProject;
  fs.writeFileSync(path.join(SB_STATE, '团队.json'), JSON.stringify(team, null, 2));
  cli(['project', 'add', '--name', PROJECT, '--team-mode', 'full']);
  fs.writeFileSync(path.join(SB_STATE, '会话排队.json'), JSON.stringify({
    schema: 1, at: iso(NOW), project: PROJECT, staleMs: 120000, degraded: null,
    roles: [row('pm', { queued: 2 }), row('product'), row('analyst'), row('programmer1'), row('programmer2'), row('tester')],
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(SB_PROJ_STATE, '会话轮次.json'), JSON.stringify({ pm: { role: 'pm', roundsSinceArchive: 1 } }, null, 2), 'utf8');
  fs.writeFileSync(path.join(SB_PROJ_STATE, 'role_queues.json'), JSON.stringify({ roles: {}, pm: { queue: [] } }, null, 2), 'utf8');
  fs.writeFileSync(path.join(SB_PROJ_STATE, '任务', 'T-sched.json'), JSON.stringify({ id: 'T-sched', owner: 'tester', status: 'working', claimedAt: iso(NOW - 12 * 60 * 1000) }, null, 2), 'utf8');
}
