/**
 * B-20261116-104231-4c6f 自检：派单队列滞留「空闲自动补投」（最小版）。
 *
 * 沙盘：独立 TEAM_ROOT + TEAM_PROJECTS_ROOT + 项目目录，全部在 _tmp/queue-idle/sandbox 下；
 * 覆盖：①空闲+滞留 → 补投一次并留审计；②再泵不重复；③角色有近期文件写入/ack → 不补投；
 *      ④滞留告警正文带活跃度证据（最近提交/文件 mtime/ack/working）。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SB = path.join(ROOT, '_tmp', 'queue-idle');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(TEAM, '状态', '项目');
const PROJ = 'qidle-project';
const STATE = path.join(PROJECTS, PROJ);
const PROJECT_DIR = path.join(SB, '项目', PROJ);

process.env.TEAM_ROOT = TEAM;
process.env.TEAM_PROJECTS_ROOT = PROJECTS;
process.env.TEAM_SELFTEST = '1';
process.env.TEAM_DISPATCH_QUEUE_IDLE_BACKFILL_MS = '60000';
process.env.TEAM_ROLE_IDLE_WINDOW_MS = '600000';
process.env.TEAM_WAKE_RETRY_MS = '0,0,0';

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ` + JSON.stringify(detail || {}).slice(0, 500)); process.exitCode = 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 沙盘 ────────────────────────────────────────────────────────────────
fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
fs.mkdirSync(path.join(STATE, '任务'), { recursive: true });
fs.mkdirSync(path.join(TEAM, '状态', '邮箱', 'pm', 'new'), { recursive: true });
fs.mkdirSync(path.join(TEAM, '状态', '邮箱', 'pm', 'cur'), { recursive: true });
for (const role of ['projectmanager', 'tester', 'programmer1', 'programmer2', 'analyst', 'product']) {
  fs.mkdirSync(path.join(TEAM, '状态', '邮箱', role, 'new'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态', '邮箱', role, 'cur'), { recursive: true });
}
for (const dir of ['项目经理', '测试人员', '程序员A', '程序员B', '需求分析师', '产品']) fs.mkdirSync(path.join(PROJECT_DIR, dir, '产出'), { recursive: true });
fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify({
  version: 2, phase: 'team', activeProject: PROJ,
  members: [
    { role: 'pm', name: '项目经理', status: 'active', sessionId: '' },
    { role: 'analyst', name: '需求分析师', status: 'active', sessionId: '' },
    { role: 'programmer1', name: '程序员A', status: 'active', sessionId: '' },
    { role: 'programmer2', name: '程序员B', status: 'active', sessionId: '' },
    { role: 'tester', name: '测试人员', status: 'active', sessionId: '' },
  ],
  config: { messageMaxChars: 600, ackNoteMaxChars: 300 },
}, null, 2), 'utf8');
fs.writeFileSync(path.join(STATE, '项目.json'), JSON.stringify({ name: PROJ, mode: 'full', path: PROJECT_DIR, teamMode: 'full' }, null, 2), 'utf8');
fs.writeFileSync(path.join(STATE, '工作流.json'), JSON.stringify({ requirements: {} }, null, 2), 'utf8');
fs.writeFileSync(path.join(TEAM, '状态', '回执.jsonl'), '', 'utf8');

const task = (id, owner, status, extra = {}) => ({ id, project: PROJ, type: 'task', title: '沙盘任务 ' + id, owner, status, priority: 'P1', requirementId: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra });
fs.writeFileSync(path.join(STATE, '任务', 'T-qidle-1.json'), JSON.stringify(task('T-qidle-1', 'tester', 'open'), null, 2), 'utf8');
fs.writeFileSync(path.join(STATE, '任务', 'T-qidle-2.json'), JSON.stringify(task('T-qidle-2', 'programmer1', 'open'), null, 2), 'utf8');

const queuePath = path.join(STATE, '派单队列.json');
const backfillPath = path.join(STATE, '派单队列补投.jsonl');
const lockPath = path.join(STATE, '派单锁.json');
const agedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
const writeQueue = (items) => fs.writeFileSync(queuePath, JSON.stringify({ items, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
const readQueue = () => JSON.parse(fs.readFileSync(queuePath, 'utf8'));
const readBackfill = () => (fs.existsSync(backfillPath) ? fs.readFileSync(backfillPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);

const ops = await import('file:///' + path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs').replace(/\\/g, '/'));
ok('S0 ops.mjs 可加载且导出 roleActivityEvidence', typeof ops.roleActivityEvidence === 'function', {});

// ── ① 空闲 + 滞留 → 补投一次 ─────────────────────────────────────────
writeQueue([{ id: 'Q-idle-1', at: agedAt, from: 'pm', to: 'tester', subject: '滞留派单（沙盘）', body: 'x', task: '', ackRequired: true }]);
const idleEv = ops.roleActivityEvidence(PROJ, 'tester');
ok('S1 夹具：tester 判定为空闲（无提交/无文件写入/无 ack/无 working）', idleEv.idle === true, idleEv);
const r1 = await ops.pumpDispatchQueue(PROJ, { role: '' });
ok('S2 滞留 ≥ 阈值 + 角色空闲 → 泵出（补投）', r1 && r1.pumped === true, r1 && { pumped: r1.pumped, reason: r1.reason, idleBackfill: r1.idleBackfill });
ok('S3 结果标记 idleBackfill=true 且带活跃度证据', Boolean(r1 && r1.idleBackfill) && Boolean(r1.evidence && r1.evidence.detail), r1 && { idleBackfill: r1.idleBackfill, evidence: r1.evidence });
const rows1 = readBackfill();
ok('S4 审计落 派单队列补投.jsonl 一行（queueId/to/reason=idle_backfill/evidence）',
  rows1.length === 1 && rows1[0].queueId === 'Q-idle-1' && rows1[0].to === 'tester' && rows1[0].reason === 'idle_backfill' && Boolean(rows1[0].evidence && rows1[0].evidence.detail), rows1);
ok('S5 队列项投递后被移除（不会重复投递）', readQueue().items.length === 0, readQueue());
ok('S6 派单锁已写（下一单继续走正常锁语义）', fs.existsSync(lockPath), { lock: fs.existsSync(lockPath) });
await sleep(300); // 等异步唤醒重试落定

// ── ② 再泵不重复 ─────────────────────────────────────────────────────
const r2 = await ops.pumpDispatchQueue(PROJ, { role: '' });
ok('S7 再泵：队列已空、不产生第二行补投审计', r2 && r2.pumped === false && readBackfill().length === 1, { r2, audits: readBackfill().length });

// ── ③ 角色在动 → 不补投 ─────────────────────────────────────────────
fs.rmSync(lockPath, { force: true }); // 清锁，单独验「角色忙」这条
fs.writeFileSync(path.join(PROJECT_DIR, '程序员A', '产出', '活着.txt'), 'recent write', 'utf8');
writeQueue([{ id: 'Q-busy-1', at: agedAt, from: 'pm', to: 'programmer1', subject: '滞留但角色在动', body: 'y', task: '', ackRequired: true }]);
const busyEv = ops.roleActivityEvidence(PROJ, 'programmer1');
ok('S8 夹具：programmer1 有近期文件写入 → idle=false', busyEv.idle === false, busyEv);
const r3 = await ops.pumpDispatchQueue(PROJ, { role: '' });
ok('S9 角色在动 → 不补投（pumped=false，队列项保留）', r3 && r3.pumped === false && readQueue().items.length === 1 && readBackfill().length === 1, { r3, remaining: readQueue().items.length, audits: readBackfill().length });

// ── ④ 滞留告警带活跃度证据 ───────────────────────────────────────────
writeQueue([
  { id: 'Q-stale-1', at: agedAt, from: 'pm', to: 'programmer1', subject: '滞留告警用例', body: 'z', task: '', ackRequired: true },
]);
const stale = ops.queueStaleCheck(PROJ, { now: Date.now() });
const pmMail = path.join(TEAM, '状态', '邮箱', 'pm', 'new');
const mails = fs.existsSync(pmMail) ? fs.readdirSync(pmMail).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fs.readFileSync(path.join(pmMail, n), 'utf8'))) : [];
const alert = mails.find((m) => /派单队列滞留/.test(String(m.subject || '')));
ok('S10 滞留告警已发（>5 分钟阈值）', Boolean(alert) && stale.alerted >= 1, { alerted: stale.alerted, subject: alert && alert.subject });
ok('S11 告警正文带活跃度证据（最近提交/文件写入/ack/working 四项）', Boolean(alert) && /活跃度证据/.test(String(alert.body || '')) && /文件写入/.test(String(alert.body || '')) && /ack/.test(String(alert.body || '')), alert && String(alert.body || '').slice(0, 300));
ok('S12 告警正文写出「仍在动/空闲」判定', Boolean(alert) && /判定：/.test(String(alert.body || '')), alert && String(alert.body || '').slice(0, 200));

console.log(`\nB-4c6f 断言：${pass} 通过 / ${fail} 失败`);
const evidDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-4c6f');
fs.mkdirSync(evidDir, { recursive: true });
fs.writeFileSync(path.join(evidDir, 'run-4c6f.log'), `pass=${pass} fail=${fail} exit=${process.exitCode || 0}\n`, 'utf8');
process.exit(process.exitCode || 0);
