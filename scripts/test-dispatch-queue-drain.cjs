#!/usr/bin/env node
/**
 * B-20261117-151857-d120（测试侧，先红后绿）：派单队列「已收口任务仍停在 pending」沙箱复现
 *
 * 背景（PM 2026-11-17 18:5x 实测）：`团队/状态/项目/<P>/role_queues.json` 里派单队列条目永远 pending，
 * 含今天已经 done/accepted 的任务（9436/9b2a/02e9/8cfd 等）→ 角色「就绪」但派单链路认为仍有大量在办。
 *
 * 本脚本（只写 scripts/ 与证据，不碰 lib/src）：
 *   1) 沙盘隔离（AWB_DATA_DIR + TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_WORKBENCH_JSON + TEAM_SELFTEST=1）；
 *   2) 造 3 条 pending 派单队列条目 + 对应 tasks：1 open / 1 done / 1 cancelled；
 *   3) 跑「一拍」：队列泵（ops.pumpQueueSafe）+ 角色队列导出（route-queues.writeRoleQueues）——等价路由守护一拍；
 *   4) 断言 ①已收口（done/cancelled）任务不得再以 pending 出现在 role_queues
 *          ②open 且已投递的条目有 deliveredAt/attempt（派单投递状态.json）
 *          ③第二拍幂等（不重复投递、队列不回流、导出稳定）
 *          ④真实 role_queues.json / 团队.json 前后 sha256 不变（隔离）。
 *
 * 用法：node scripts/test-dispatch-queue-drain.cjs [--json]
 * 输出：全绿 `QUEUE_DRAIN_OK {...}`（exit 0）；当前缺陷未修时 `QUEUE_DRAIN_WARN {...}`（exit 1，逐条结果照实记）
 * 证据：项目/工作台改造修复/测试人员/产出/证据-d120-repro/run-<ts>-<red|green>.json（每次新增，不覆盖旧证据）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = '工作台改造修复';
const jsonOut = process.argv.includes('--json');
const REAL_TEAM = path.join(ROOT, '团队');
const REAL_PROJECT_STATE = path.join(REAL_TEAM, '状态', '项目', PROJECT);
const REAL_FILES = {
  roleQueues: path.join(REAL_PROJECT_STATE, 'role_queues.json'),
  teamJson: path.join(REAL_TEAM, '状态', '团队.json'),
};

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const SB = path.join(ROOT, '_tmp', `d120-drain-${process.pid}-${Date.now().toString(36)}`);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const PROJ_STATE = path.join(TEAM, '状态', '项目', PROJECT);
const TASKS_DIR = path.join(PROJ_STATE, '任务');
process.env.AWB_DATA_DIR = DATA;
process.env.TEAM_ROOT = TEAM;
process.env.TEAM_PROJECTS_ROOT = path.join(TEAM, '状态', '项目');
process.env.TEAM_WORKBENCH_JSON = path.join(DATA, 'userdata', 'workbench.json');
process.env.TEAM_SELFTEST = '1';
process.env.TEAM_WAKE_DEBOUNCE_MS = '0';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!jsonOut) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 600)}`);
  return Boolean(ok);
}
function sha256(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; }
}
function snap(files) {
  return Object.fromEntries(Object.entries(files).map(([k, f]) => [k, { file: f, sha256: sha256(f), bytes: (() => { try { return fs.statSync(f).size; } catch { return -1; } })() }]));
}
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, ent.name); const b = path.join(dst, ent.name);
    if (ent.isDirectory()) { if (!/[\\/]邮箱([\\/]|$)/.test(a) && !/[\\/]锁([\\/]|$)/.test(a) && !/[\\/]备份([\\/]|$)/.test(a)) copyDir(a, b); }
    else fs.copyFileSync(a, b);
  }
}
function writeJson(f, data) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n', 'utf8'); }
function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }

const T = {
  open: 'B-20261117-991001-d120open',
  done: 'B-20261117-991002-d120done',
  cancelled: 'B-20261117-991003-d120cancel',
};
const Q = 'Q-d120-';
const nowIso = new Date().toISOString();

function seed() {
  fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  copyDir(REAL_TEAM, TEAM);
  // 名册改假会话 id（沙盘绝不带真实 sessionId，且 TEAM_SELFTEST=1 双保险）+ 稳定当前项目
  const teamFile = path.join(TEAM, '状态', '团队.json');
  const team = readJson(teamFile, {});
  for (const m of (Array.isArray(team.members) ? team.members : [])) m.sessionId = `sess-${m.role}`;
  team.activeProject = PROJECT;
  writeJson(teamFile, team);
  // 清沙盘里的真实项目派生/任务，避免真实数据干扰 role_queues 生成
  fs.rmSync(TASKS_DIR, { recursive: true, force: true });
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  for (const f of ['role_queues.json', '派单队列.json', '派单投递状态.json', '派单投递审计.jsonl', '派单队列归档.jsonl']) {
    fs.rmSync(path.join(PROJ_STATE, f), { force: true });
  }
  // 工作流只留空 requirements：本次只测「任务级队列条目」
  writeJson(path.join(PROJ_STATE, '工作流.json'), { schema: 2, project: PROJECT, round: 1, updatedAt: nowIso, requirements: {} });
  // 3 条任务：open / done / cancelled
  for (const [id, status, owner] of [[T.open, 'open', 'programmer1'], [T.done, 'done', 'programmer2'], [T.cancelled, 'cancelled', 'analyst']]) {
    writeJson(path.join(TASKS_DIR, `${id}.json`), {
      id, project: PROJECT, type: 'bug', priority: 'P2', owner, status,
      title: `d120 夹具：${status}`, createdAt: nowIso, updatedAt: nowIso,
      ...(status === 'done' ? { doneAt: nowIso } : {}),
    });
  }
  // 3 条 pending 派单队列条目
  const items = [
    [Q + 'open', 'programmer1', T.open], [Q + 'done', 'programmer2', T.done], [Q + 'cancel', 'analyst', T.cancelled],
  ].map(([id, to, task]) => ({ id, at: nowIso, from: 'pm', to, task, subject: `d120 夹具派单 ${id}`, body: `夹具正文 ${id}`, status: 'pending', attempt: 1 }));
  writeJson(path.join(PROJ_STATE, '派单队列.json'), { items, updatedAt: nowIso });
}

function queueOf(file) { return readJson(file, { items: [] }).items || []; }
function roleQueueRows(payload) {
  const rows = [];
  for (const [role, v] of Object.entries((payload && payload.roles) || {})) {
    for (const row of (v && v.queue) || []) rows.push({ role, ...row });
  }
  return rows;
}
function deliveredRows(auditFile) {
  if (!fs.existsSync(auditFile)) return [];
  return fs.readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((row) => row && row.result === 'delivered');
}

async function main() {
  seed();
  const before = snap(REAL_FILES);
  const ops = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs')).href);
  const rq = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'route-queues.mjs')).href);

  const tick = async (label) => {
    // ops.mjs 只导出 pumpDispatchQueue（pumpQueueSafe 是内部包装，未导出）；直接调用单拍泵。
    const pump = await ops.pumpDispatchQueue(PROJECT, { role: '', source: 'tick' });
    const exported = rq.writeRoleQueues(PROJECT);
    const payload = readJson(path.join(PROJ_STATE, 'role_queues.json'), null);
    return { pump, exported, payload };
  };

  // ── 第 1 拍 ─────────────────────────────────────────────────────────────
  const first = await tick('1');
  const queueAfter1 = queueOf(path.join(PROJ_STATE, '派单队列.json'));
  const delivery = readJson(path.join(PROJ_STATE, '派单投递状态.json'), { items: {} });
  const rows1 = roleQueueRows(first.payload);
  const closedIds = new Set([T.done, T.cancelled]);
  const closedPendingRows = rows1.filter((row) => closedIds.has(String(row.taskId)) && String(row.status) === 'pending');
  const openDelivery = delivery.items && delivery.items[Q + 'open'] ? delivery.items[Q + 'open'] : null;

  check('① 已收口任务（done/cancelled）不得再以 pending 出现在 role_queues',
    closedPendingRows.length === 0,
    { bug: 'role_queues 仍含已收口任务的 pending 行', offenders: closedPendingRows.map((r) => ({ role: r.role, taskId: r.taskId, status: r.status })), closedTaskIds: [...closedIds] });
  check('② open 且已投递条目有 delivered 状态（state=delivered / lastAt / attempt≥1）',
    Boolean(openDelivery) && String(openDelivery.state) === 'delivered' && Boolean(openDelivery.lastAt) && Number(openDelivery.attempt) >= 1,
    { openDelivery, deliveryFile: path.join(PROJ_STATE, '派单投递状态.json') });
  check('② 已投递的 open 条目已出队（派单队列不残留 pending）',
    !queueAfter1.some((item) => String(item.id) === Q + 'open'), { queueAfter1: queueAfter1.map((i) => i.id) });

  // ── 第 2 拍（幂等）──────────────────────────────────────────────────────
  const auditFile = path.join(PROJ_STATE, '派单投递审计.jsonl');
  const delivered1 = deliveredRows(auditFile).length;
  const queueIds1 = queueAfter1.map((i) => String(i.id)).sort().join(',');
  const rows1Ids = rows1.map((r) => `${r.role}|${r.taskId}|${r.status}`).sort().join(',');
  const second = await tick('2');
  const queueAfter2 = queueOf(path.join(PROJ_STATE, '派单队列.json'));
  const delivery2 = readJson(path.join(PROJ_STATE, '派单投递状态.json'), { items: {} });
  const openDelivery2 = delivery2.items && delivery2.items[Q + 'open'] ? delivery2.items[Q + 'open'] : null;
  const rows2 = roleQueueRows(second.payload);
  const delivered2 = deliveredRows(auditFile).length;
  check('③ 第二拍幂等：派单队列不回流、不重复投递（delivered 审计行不增加）',
    queueAfter2.map((i) => String(i.id)).sort().join(',') === queueIds1 && delivered2 === delivered1,
    { queueIds1, queueAfter2: queueAfter2.map((i) => i.id), delivered1, delivered2 });
  check('③ 第二拍幂等：投递状态不重写（attempt/lastAt 同第一拍）',
    Boolean(openDelivery && openDelivery2) && Number(openDelivery2.attempt) === Number(openDelivery.attempt) && String(openDelivery2.lastAt) === String(openDelivery.lastAt),
    { first: openDelivery, second: openDelivery2 });
  check('③ 第二拍幂等：role_queues 行集合稳定',
    rows2.map((r) => `${r.role}|${r.taskId}|${r.status}`).sort().join(',') === rows1Ids,
    { before: rows1Ids, after: rows2.map((r) => `${r.role}|${r.taskId}|${r.status}`).sort().join(',') });

  // ── 隔离 ────────────────────────────────────────────────────────────────
  const after = snap(REAL_FILES);
  const unchanged = Object.keys(before).filter((k) => before[k].sha256 === after[k].sha256 && before[k].sha256 !== '');
  check('④ 真实 role_queues.json / 团队.json 前后 sha256 不变（沙盘未写真实）',
    unchanged.length === Object.keys(before).length,
    { before, after });

  const total = results.length;
  const pass = results.filter((r) => r.ok).length;
  const red = total - pass;
  const payload = {
    at: new Date().toISOString(),
    script: 'scripts/test-dispatch-queue-drain.cjs',
    sandbox: SB,
    project: PROJECT,
    fixture: { tasks: T, queue: [Q + 'open', Q + 'done', Q + 'cancel'], statuses: { open: 'open', done: 'done', cancelled: 'cancelled' } },
    total, pass, red,
    results,
    evidence: {
      queueAfter1: queueAfter1.map((i) => ({ id: i.id, to: i.to, task: i.task })),
      deliveryOpen: openDelivery,
      roleQueueRows1: rows1.map((r) => ({ role: r.role, taskId: r.taskId, status: r.status, action: r.action })),
      pump1: { ok: first.pump.ok, pumped: first.pump.pumped, reason: first.pump.reason || '' },
      export1: { ok: first.exported && first.exported.ok, file: first.exported && first.exported.file },
      pump2: { ok: second.pump.ok, pumped: second.pump.pumped, reason: second.pump.reason || '' },
      realFiles: { before, after },
    },
  };
  const evDir = path.join(ROOT, '项目', PROJECT, '测试人员', '产出', '证据-d120-repro');
  fs.mkdirSync(evDir, { recursive: true });
  const evFile = path.join(evDir, `run-${ts}-${red === 0 ? 'green' : 'red'}.json`);
  fs.writeFileSync(evFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  payload.evidenceFile = evFile;

  if (jsonOut) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  else {
    console.log('');
    console.log(`${red === 0 ? 'QUEUE_DRAIN_OK' : 'QUEUE_DRAIN_WARN'} ${JSON.stringify({ total, pass, red })}`);
    console.log(`证据：${path.relative(ROOT, evFile)}`);
  }
  // 红=缺陷复现成功（当前状态），脚本仍在红态退出 1，便于 CI 区分；修复后应绿退出 0。
  process.exit(red === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('CRASH', String((e && e.stack) || e));
  process.exit(2);
}).finally(() => {
  try { fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
});
