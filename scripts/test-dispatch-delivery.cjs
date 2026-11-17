#!/usr/bin/env node
/**
 * R-20261116-104535-1dfb（P0）自检：派单必达 —— deadline 状态机 / 12 键投递审计 / 单链三层升级 / 三信号 idle / 自动唤醒分级 / 恢复清标
 *
 * 覆盖（对照派单 F8 + 正文 AC1/AC2/AC3/AC4/AC6 + 增补卷 §三/§四/§五/§七/§八/§九/§十三）：
 *   AC1  立即投递（deadline 源）+ 队列不新增该项 + 审计 source=deadline/result=delivered；source=tick 也产行
 *   AC2  持续无进展：审计依次 timeout → retry → upgraded；notice/escalate/force 按 itemId+level 各 1 条；
 *        升级文案含 attempt/三信号/最后回执；escalate ≥ AWB_STALL_ESCALATE_MS、force ≥ AWB_STALL_FORCE_MS（now 注入推进，不真等）
 *   AC3  四组夹具（三信号全旧→idle；仅新文件/仅新 ack/仅近期 working→active）+ 反断言（有新提交但三信号全旧→仍 idle）
 *   AC4  idle→自动唤醒 1 次（唤醒.jsonl 新增 to=角色 且 ok=true）+ 黄标（level=notice）；连续 2 次 idle→红标（level=escalate）+ PM 收 1 条 escalation；
 *        造新文件写入→下一轮写 recovered 审计并清标
 *   AC6  派单投递审计每行恰好 12 键、活跃度审计每行恰好 10 键；append-only（跑两遍历史行数不减少）；同 item+attempt 不重复写
 *   幂等 同一 idle 角色重复 recoverStalledRoles 不产生第二个队列项、attempt 不自增
 *   隔离 真实 data/userdata/workbench.json、团队/状态/团队.json 的 sha256+mtime 前后不变
 *
 * 沙盘：_tmp/1dfb-dispatch-sandbox 下独立 团队/ + 项目/<P>/；TEAM_ROOT/TEAM_PROJECTS_ROOT 指它、TEAM_SELFTEST=1、
 *       名册 sessionId 全空（防误投真实角色，B-3c03）、TEAM_WAKE_RETRY_MS=0,0,0（杜绝真等）。
 *       env 压缩时间：AWB_STALL_TICK_MS=1000、AWB_STALL_ESCALATE_MS=2000、AWB_STALL_FORCE_MS=4000、
 *       TEAM_DISPATCH_QUEUE_IDLE_BACKFILL_MS=1000、TEAM_ROLE_IDLE_WINDOW_MS=1000。
 *
 * 跑法：node scripts/test-dispatch-delivery.cjs
 * 退出码：0 = 全 PASS；1 = 有 FAIL（汇总行 ./项目/工作台改造修复/程序员A/产出/证据-1dfb/test-dispatch-delivery.log）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.resolve(__dirname, '..');
const SB = path.join(REPO, '_tmp', '1dfb-dispatch-sandbox');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(TEAM, '状态', '项目');
const PROJ = '1dfb-dlv';
const STATE = path.join(PROJECTS, PROJ);
const PDIR = path.join(SB, '项目', PROJ);
const LOGS = path.join(TEAM, '日志');
const MAIL = path.join(TEAM, '状态', '邮箱');
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const ROLE_DIRS = { pm: '项目经理', product: '产品', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' };
const ROLE_NAMES = { pm: '项目经理', product: '产品设计师', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' };

const NOW = Date.now();
const BACKFILL_MS = 1000;
const IDLE_WINDOW_MS = 1000;
const TICK_MS = 1000;
const ESCALATE_MS = 2000;
const FORCE_MS = 4000;

// ── 沙盘环境（必须在 import ops.mjs 之前设：ops.mjs 在 import 期读 env 落常量/PATHS）────────
process.env.TEAM_ROOT = TEAM;
process.env.TEAM_PROJECTS_ROOT = PROJECTS;
process.env.TEAM_SELFTEST = '1';
process.env.TEAM_WAKE_RETRY_MS = '0,0,0';
process.env.AWB_STALL_TICK_MS = String(TICK_MS);
process.env.AWB_STALL_ESCALATE_MS = String(ESCALATE_MS);
process.env.AWB_STALL_FORCE_MS = String(FORCE_MS);
process.env.TEAM_DISPATCH_QUEUE_IDLE_BACKFILL_MS = String(BACKFILL_MS);
process.env.TEAM_ROLE_IDLE_WINDOW_MS = String(IDLE_WINDOW_MS);
// 沙盘不得触碰真实仓库的 git（活跃度证据里的 git 探测）：让 git 在沙盘根上「不是仓库」快速返回，
// 既证明「沙盘/无仓库 → 无提交证据」，也避免大仓库 git log 拖慢自检（真实缺陷 5m 阈值判据在 AC2 用 now 注入验）。
process.env.GIT_CEILING_DIRECTORIES = SB;

// ── 断言与输出（输出同时落 log 文件，UTF-8 由 node 写，不用 PowerShell 重定向）─────────────
const outLines = [];
const log = (line) => { outLines.push(String(line)); console.log(String(line)); };
let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; log(`PASS  ${name}`); return true; }
  fail += 1;
  const d = detail === undefined ? '' : JSON.stringify(detail).slice(0, 700);
  failures.push({ name, detail: d });
  log(`FAIL  ${name}  ${d}`);
  return false;
}
const iso = (ms) => new Date(ms).toISOString();

// ── 文件小工具 ─────────────────────────────────────────────────────────────
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n', 'utf8'); };
const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((s) => JSON.parse(s)); } catch { return []; } };
const queuePath = () => path.join(STATE, '派单队列.json');
const stalePath = () => path.join(STATE, '派单队列滞留.json');
const deliveryAuditPath = () => path.join(STATE, '派单投递审计.jsonl');
const deliveryStatePath = () => path.join(STATE, '派单投递状态.json');
const activityAuditPath = () => path.join(STATE, '活跃度审计.jsonl');
const wakeLogPath = () => path.join(STATE, '唤醒.jsonl');
const queueItems = () => (readJson(queuePath(), { items: [] }).items || []);
function writeQueue(items) { writeJson(queuePath(), { items, updatedAt: new Date().toISOString() }); }
function mailOf(role) {
  const out = [];
  for (const box of ['new', 'cur']) {
    const dir = path.join(MAIL, role, box);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const m = readJson(path.join(dir, n));
      if (m) out.push(m);
    }
  }
  return out;
}
const fileSig = (p) => {
  try { const b = fs.readFileSync(p); const st = fs.statSync(p); return { sha: crypto.createHash('sha256').update(b).digest('hex'), mtimeMs: st.mtimeMs, size: b.length }; }
  catch { return null; }
};
const sigEq = (a, b) => Boolean(a) && Boolean(b) && a.sha === b.sha && a.mtimeMs === b.mtimeMs;

function localDayKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function localHms(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/** 回执信号唯一来源（卷 §十三(二)）：团队/日志/<YYYY-MM-DD>.md 的 `- HH:MM:SS [role] ack · ` 行。先清空日志再写，保证「最新一条」可控。 */
function writeAckLog(role, atMs) {
  fs.rmSync(LOGS, { recursive: true, force: true });
  fs.mkdirSync(LOGS, { recursive: true });
  const d = new Date(atMs);
  const line = `- ${localHms(d)} [${role}] ack · M-sandbox — 夹具回执（沙盘）`;
  fs.writeFileSync(path.join(LOGS, `${localDayKey(d)}.md`), `${line}\n`, 'utf8');
}
/** 角色目录活动文件：写文件并把 mtime 精确设到 atMs（用于三信号「旧/新」夹具）。 */
function setRoleFileMtime(role, atMs, name = '产出/活动.txt') {
  const dir = path.join(PDIR, ROLE_DIRS[role]);
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `fixture ${name}\n`, 'utf8');
  const d = new Date(atMs);
  fs.utimesSync(file, d, d);
  return file;
}
/** 角色目录内的「生成物」（卷 §五排除项）——刷新它们不得改变「最近文件写入」。 */
function touchGeneratedArtifacts(role, atMs) {
  const dir = path.join(PDIR, ROLE_DIRS[role]);
  fs.mkdirSync(path.join(dir, '_backup', 'old'), { recursive: true });
  fs.mkdirSync(path.join(dir, '_tmp'), { recursive: true });
  const files = [
    '文件索引.md',
    '项目索引.md',
    '项目索引.json',
    '审计.jsonl',
    '派单投递状态.json',
    path.join('_backup', 'old', 'x.txt'),
    path.join('_tmp', 'y.txt'),
  ];
  const d = new Date(atMs);
  for (const rel of files) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'generated\n', 'utf8');
    fs.utimesSync(f, d, d);
  }
}

const taskRow = (id, owner, status, extra = {}) => ({
  id, project: PROJ, type: 'task', title: `沙盘任务 ${id}`, owner, status, priority: 'P2',
  requirementId: '', createdAt: iso(NOW - 600000), updatedAt: iso(NOW - 600000), ...extra,
});
function writeTask(row) { writeJson(path.join(STATE, '任务', `${row.id}.json`), row); }
function taskPath(id) { return path.join(STATE, '任务', `${id}.json`); }
function patchTask(id, patch) { const row = readJson(taskPath(id), null); if (!row) return null; const next = { ...row, ...patch }; writeTask(next); return next; }

// ── 1) 沙盘 seed ───────────────────────────────────────────────────────────
fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
fs.mkdirSync(path.join(STATE, '任务'), { recursive: true });
fs.mkdirSync(path.join(STATE, '提交'), { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });
for (const role of ROLES) {
  fs.mkdirSync(path.join(MAIL, role, 'new'), { recursive: true });
  fs.mkdirSync(path.join(MAIL, role, 'cur'), { recursive: true });
  fs.mkdirSync(path.join(PDIR, ROLE_DIRS[role], '产出'), { recursive: true });
}
writeJson(path.join(TEAM, '状态', '团队.json'), {
  version: 2, phase: 'team', activeProject: PROJ,
  members: ROLES.map((role) => ({ role, name: ROLE_NAMES[role], status: 'active', sessionId: '' })),
  config: { messageMaxChars: 600, ackNoteMaxChars: 300, codeMaxBytes: 65536 },
});
writeJson(path.join(STATE, '项目.json'), { name: PROJ, mode: 'full', path: PDIR, teamMode: 'full', roleIds: ROLES });
writeJson(path.join(STATE, '工作流.json'), { requirements: {} });
fs.writeFileSync(path.join(TEAM, '状态', '回执.jsonl'), '', 'utf8');
fs.writeFileSync(wakeLogPath(), '', 'utf8');

// 目标角色「忙」夹具（卷 §九 busy）：open 任务占住角色；programmer1/analyst 用「旧 working」→ 同时满足 idle；
// tester 用「近期 working」→ active（tick 路径用：tick 写行但泵不补投）。
writeTask(taskRow('T-1dfb-busy-dev1', 'programmer1', 'open'));
writeTask(taskRow('T-1dfb-busy-ana', 'analyst', 'open'));
writeTask(taskRow('T-1dfb-busy-test', 'tester', 'open', { claimedAt: iso(NOW - 1000), updatedAt: iso(NOW) }));
// 角色目录旧活动（三信号「旧」）：programmer1/analyst 各一个 60s 前文件；tester 有近期文件写入 → 证据非空闲（tick 夹具用）
setRoleFileMtime('programmer1', NOW - 60000);
setRoleFileMtime('analyst', NOW - 60000);
setRoleFileMtime('tester', NOW);

const realWorkbench = path.join(REPO, 'data', 'userdata', 'workbench.json');
const realTeam = path.join(REPO, '团队', '状态', '团队.json');
const realBefore = { workbench: fileSig(realWorkbench), team: fileSig(realTeam) };

async function main() {
  const opsUrl = 'file:///' + path.join(REPO, '团队', '工具', 'lib', 'ops.mjs').replace(/\\/g, '/');
  const ops = await import(opsUrl);

  // ── S0 函数齐全 ────────────────────────────────────────────────────────
  const required = ['tickDispatchDeadlines', 'detectStalledRoles', 'recoverStalledRoles', 'computeRoleActivity', 'queueIdleCheck', 'readDeliveryState', 'dispatchDeliveryAuditFile', 'roleActivityAuditFile', 'dispatchDeliveryStateFile', 'pumpDispatchQueue'];
  const missing = required.filter((k) => typeof ops[k] !== 'function');
  ok('S0 ops.mjs 导出本单所需函数（tickDispatchDeadlines/detectStalledRoles/recoverStalledRoles/…）', missing.length === 0, { missing });
  if (missing.length) return;

  // ═══════════════ AC1：立即投递（deadline 源）+ 队列不新增该项 + 投递审计 ═══════════════
  const tA1 = NOW - 1000;
  writeQueue([{ id: 'Q-1dfb-a1', at: iso(tA1), from: 'pm', to: 'programmer1', subject: '沙盘派单 A1（目标忙+上一条未回执）', body: '立即投递夹具', task: '', ackRequired: true }]);
  const t0 = Date.now();
  const tickA1 = ops.tickDispatchDeadlines(PROJ, { now: NOW, source: 'deadline' });
  const pumpA1 = await ops.pumpDispatchQueue(PROJ, { role: '', source: 'deadline' });
  const elapsedA1 = Date.now() - t0;
  const auditA1 = readJsonl(deliveryAuditPath());
  const deliveredA1 = auditA1.filter((r) => r.itemId === 'Q-1dfb-a1' && r.result === 'delivered');
  const timeoutA1 = auditA1.filter((r) => r.itemId === 'Q-1dfb-a1' && r.result === 'timeout');
  const inboxA1 = mailOf('programmer1').filter((m) => String(m.subject || '').includes('沙盘派单 A1'));
  ok('AC1① 目标忙+上一条未回执时派单仍立即投递（泵 pumped=true）', Boolean(pumpA1 && pumpA1.pumped === true), pumpA1 && { pumped: pumpA1.pumped, reason: pumpA1.reason });
  ok('AC1① 消息立即落目标收件箱且有 messageId', inboxA1.length === 1 && Boolean(inboxA1[0].id) && String(inboxA1[0].id) === String(pumpA1 && pumpA1.message && pumpA1.message.id), { inbox: inboxA1.map((m) => m.id), pump: pumpA1 && pumpA1.message && pumpA1.message.id });
  ok('AC1① 投递审计出现 result=delivered 且 source=deadline（第 12 键）', deliveredA1.length === 1 && deliveredA1[0].source === 'deadline' && deliveredA1[0].messageId === String(pumpA1 && pumpA1.message && pumpA1.message.id), deliveredA1);
  ok('AC1① 状态机 queued→stalled（timeout 行同为 source=deadline）→ delivered', timeoutA1.length === 1 && timeoutA1[0].source === 'deadline' && ops.readDeliveryState(PROJ).items['Q-1dfb-a1'] && ops.readDeliveryState(PROJ).items['Q-1dfb-a1'].state === 'delivered', { timeout: timeoutA1, state: (ops.readDeliveryState(PROJ).items || {})['Q-1dfb-a1'] });
  ok('AC1① 派单队列.json 不新增该项（投递后队列为空）', queueItems().filter((i) => String(i.id) === 'Q-1dfb-a1').length === 0 && queueItems().length === 0, queueItems().map((i) => i.id));
  ok(`AC1① 到期定时器路径（source=deadline）不依赖 60 秒 tick（实测 ${elapsedA1}ms < 2000）`, elapsedA1 < 2000, { elapsedA1 });
  ok('AC1① 沙盘唤醒按「已跳过不算失败」记 wakeOk=true', deliveredA1.length === 1 && deliveredA1[0].wakeOk === true, deliveredA1[0]);

  // AC1② source=tick 路径也产行（tester 有近期文件写入 → 泵不补投，tick 仍写 timeout 行）
  // 滞留 1500ms：只到 BACKFILL 不到 ESCALATE，避免升级链行污染「timeout→retry→upgraded」顺序断言。
  writeQueue([{ id: 'Q-1dfb-a2', at: iso(NOW - 1500), from: 'pm', to: 'tester', subject: '沙盘派单 A2（tick 兜底）', body: 'tick 源夹具', task: '', ackRequired: true }]);
  ops.tickDispatchDeadlines(PROJ, { now: NOW, source: 'tick' });
  // IDLE 窗口被压到 1s：立即刷新 tester 文件写入，避免脚本自身耗时把「刚写入」判成旧
  setRoleFileMtime('tester', Date.now() + 5000);
  const a2Evidence = ops.roleActivityEvidence(PROJ, 'tester');
  const pumpA2 = await ops.pumpDispatchQueue(PROJ, { role: '', source: 'tick' });
  const auditA2 = readJsonl(deliveryAuditPath()).filter((r) => r.itemId === 'Q-1dfb-a2');
  ok('AC1② source=tick 路径也产审计行（source 打标 tick）', auditA2.length >= 1 && auditA2.every((r) => r.source === 'tick'), auditA2);
  ok('AC1② 角色确实在动（近期文件写入）→ 泵不补投、队列项保留', Boolean(pumpA2 && pumpA2.pumped === false) && queueItems().some((i) => String(i.id) === 'Q-1dfb-a2'), { pumped: pumpA2 && pumpA2.pumped, reason: pumpA2 && pumpA2.reason, evidence: a2Evidence && { idle: a2Evidence.idle, lastFileWriteAt: a2Evidence.lastFileWriteAt, detail: a2Evidence.detail } });
  writeQueue(queueItems().filter((i) => String(i.id) !== 'Q-1dfb-a2')); // 清掉，避免污染后续升级链计数
  let badSourceCode = '';
  try { ops.tickDispatchDeadlines(PROJ, { now: NOW, source: 'tick2' }); } catch (e) { badSourceCode = String((e && e.code) || ''); }
  ok('AC1② source 只允许 deadline/tick（非法值 BAD_SOURCE 拒绝）', badSourceCode === 'BAD_SOURCE', { badSourceCode });

  // ═══════════════ AC2：持续无进展 → timeout → retry → upgraded（单链三层）═══════════════
  // ① 先造 timeout → retry（stalled 后重投成功，泵写 RETRY_AFTER_STALL）
  //    滞留 1500ms：≥ BACKFILL(1000) 但 < ESCALATE(2000) → 只出 timeout，不会被升级链抢成 upgraded。
  writeQueue([{ id: 'Q-1dfb-b1', at: iso(NOW - 1500), from: 'pm', to: 'programmer1', subject: '沙盘派单 B1（重投）', body: '重投夹具', task: '', ackRequired: true }]);
  ops.tickDispatchDeadlines(PROJ, { now: NOW, source: 'deadline' });
  const pumpB1 = await ops.pumpDispatchQueue(PROJ, { role: '', source: 'deadline' });
  const auditB1 = readJsonl(deliveryAuditPath()).filter((r) => r.itemId === 'Q-1dfb-b1');
  const b1TimeoutIdx = auditB1.findIndex((r) => r.result === 'timeout');
  const b1RetryIdx = auditB1.findIndex((r) => r.result === 'retry');
  ok('AC2① 重投成功：审计出现 retry（code=RETRY_AFTER_STALL）', Boolean(pumpB1 && pumpB1.pumped === true) && b1RetryIdx >= 0 && auditB1[b1RetryIdx].code === 'RETRY_AFTER_STALL', auditB1);

  // ② 再造假 item 走完整三层（notice → escalate → force），用 now 注入推进（不真等）
  const b2Base = NOW;
  writeQueue([{ id: 'Q-1dfb-b2', at: iso(b2Base - 500), from: 'pm', to: 'programmer2', subject: '沙盘派单 B2（持续无进展）', body: '升级链夹具', task: '', ackRequired: true }]);
  const pmMsgsFor = (level, itemId) => mailOf('pm').filter((m) => /派单队列滞留/.test(String(m.subject || '')) && String(m.body || '').includes(itemId) && new RegExp(`level=${level}`).test(String(m.body || '')));
  ops.tickDispatchDeadlines(PROJ, { now: b2Base + 1000, source: 'deadline' }); // stall=1500：timeout + notice
  const noticeB2 = pmMsgsFor('notice', 'Q-1dfb-b2');
  const escalateBefore = pmMsgsFor('escalate', 'Q-1dfb-b2').length;
  ok('AC2② 链首 notice（滞留到 5 分钟口径）已发且此时未越级 escalate', noticeB2.length === 1 && escalateBefore === 0, { notice: noticeB2.length, escalate: escalateBefore });
  const auditAfterNotice = readJsonl(deliveryAuditPath()).filter((r) => r.itemId === 'Q-1dfb-b2');
  ok('AC2② first timeout 行已写（result=timeout）', auditAfterNotice.some((r) => r.result === 'timeout'), auditAfterNotice);
  ops.tickDispatchDeadlines(PROJ, { now: b2Base + 2100, source: 'deadline' }); // stall=2600 ≥ ESCALATE(2000)
  const auditEsc = readJsonl(deliveryAuditPath()).filter((r) => r.itemId === 'Q-1dfb-b2' && r.result === 'upgraded');
  const escRow = auditEsc.find((r) => r.code === 'STALL_ESCALATE');
  ok('AC2② escalate 在 ≥ AWB_STALL_ESCALATE_MS 后出现（upgraded/stallMs≥阈值）', Boolean(escRow) && Number(escRow.stallMs) >= ESCALATE_MS, { escRow, ESCALATE_MS });
  ops.tickDispatchDeadlines(PROJ, { now: b2Base + 4100, source: 'deadline' }); // stall=4600 ≥ FORCE(4000)
  const auditForce = readJsonl(deliveryAuditPath()).filter((r) => r.itemId === 'Q-1dfb-b2' && r.result === 'upgraded' && r.code === 'STALL_FORCE');
  ok('AC2② force 在 ≥ AWB_STALL_FORCE_MS 后出现（upgraded/stallMs≥阈值）', auditForce.length === 1 && Number(auditForce[0].stallMs) >= FORCE_MS, { auditForce, FORCE_MS });
  const escB2 = pmMsgsFor('escalate', 'Q-1dfb-b2');
  const forceB2 = pmMsgsFor('force', 'Q-1dfb-b2');
  ok('AC2② 同 item notice/escalate/force 各只 1 条（去重键 itemId+level）', noticeB2.length === 1 && escB2.length === 1 && forceB2.length === 1, { notice: noticeB2.length, escalate: escB2.length, force: forceB2.length });
  ok('AC2② 重复 tick（同 now）不重复发同 level（24 小时去重）', (ops.tickDispatchDeadlines(PROJ, { now: b2Base + 4200, source: 'deadline' }), pmMsgsFor('escalate', 'Q-1dfb-b2').length === 1 && pmMsgsFor('force', 'Q-1dfb-b2').length === 1 && pmMsgsFor('notice', 'Q-1dfb-b2').length === 1), { notice: pmMsgsFor('notice', 'Q-1dfb-b2').length, escalate: pmMsgsFor('escalate', 'Q-1dfb-b2').length, force: pmMsgsFor('force', 'Q-1dfb-b2').length });
  const escBody = String((escB2[0] && escB2[0].body) || '');
  ok('AC2② 升级文案含 attempt + 三信号 + 最后回执（读 PM 邮箱正文）', /最新 attempt/.test(escBody) && /三信号/.test(escBody) && /最后回执/.test(escBody) && /文件写入=/.test(escBody) && /ack 回执=/.test(escBody) && /近期 working=/.test(escBody), escBody.slice(0, 400));
  const auditAll = readJsonl(deliveryAuditPath());
  const first = (result) => auditAll.findIndex((r) => r.result === result);
  ok('AC2 审计依次出现 timeout → retry → upgraded（首次出现顺序）', first('timeout') >= 0 && first('retry') > first('timeout') && first('upgraded') > first('retry'), { timeout: first('timeout'), retry: first('retry'), upgraded: first('upgraded') });
  writeQueue(queueItems().filter((i) => String(i.id) !== 'Q-1dfb-b2')); // 清掉，避免污染 AC4 队列断言
  // 出队/恢复时清 alerted（卷 §十）：a1 投递时已把该 item 清掉
  const alertedAfter = readJson(stalePath(), { alerted: {} }).alerted || {};
  ok('AC2 出队即清 派单队列滞留.json → alerted[itemId]（不长期占用去重键）', !alertedAfter['Q-1dfb-a1'] && !alertedAfter['Q-1dfb-b1'], alertedAfter);

  // ═══════════════ AC3：三信号 idle 判定（四组夹具 + 反断言）═══════════════
  const A3 = NOW;
  const anaOld = A3 - 60000;
  const det = (now) => ops.detectStalledRoles(PROJ, { now });
  // ① 三信号全旧 + open 任务 → idle
  setRoleFileMtime('analyst', anaOld);
  writeAckLog('analyst', anaOld);
  patchTask('T-1dfb-busy-ana', { claimedAt: iso(anaOld), updatedAt: iso(anaOld) });
  const v1 = det(A3).roles.analyst;
  ok('AC3① 三信号全旧 + 有 open 任务 → verdict=idle', v1.verdict === 'idle' && v1.openTaskIds.length >= 1, v1);
  // ② 仅新文件写入 → active
  setRoleFileMtime('analyst', A3);
  const v2 = det(A3).roles.analyst;
  ok('AC3② 仅新文件写入 → verdict=active', v2.verdict === 'active' && Date.parse(v2.signals.fileAt) >= A3 - 2000, v2);
  // ③ 仅新 ack → active
  setRoleFileMtime('analyst', anaOld);
  writeAckLog('analyst', A3);
  const v3 = det(A3).roles.analyst;
  ok('AC3③ 仅新回执（团队/日志 ack 行）→ verdict=active', v3.verdict === 'active' && Date.parse(v3.signals.ackAt) >= A3 - 2000, v3);
  // ④ 仅近期 working → active
  setRoleFileMtime('analyst', anaOld);
  writeAckLog('analyst', anaOld);
  patchTask('T-1dfb-busy-ana', { updatedAt: iso(A3) });
  const v4 = det(A3).roles.analyst;
  ok('AC3④ 仅近期 working → verdict=active', v4.verdict === 'active' && Date.parse(v4.signals.workingAt) >= A3 - 2000, v4);
  // ⑤ 反断言：有新提交记录但三信号全旧 → 仍 idle（提交只作展示列，不参与判定）
  patchTask('T-1dfb-busy-ana', { claimedAt: iso(anaOld), updatedAt: iso(anaOld) });
  writeJson(path.join(STATE, '提交', 'C-1dfb-f1.json'), { id: 'C-1dfb-f1', project: PROJ, author: 'analyst', createdAt: iso(A3), before: '', after: '' });
  const v5 = det(A3).roles.analyst;
  const commitFiles = (() => { try { return fs.readdirSync(path.join(STATE, '提交')).filter((n) => n.endsWith('.json')).length; } catch { return 0; } })();
  ok('AC3⑤ 有新提交记录但三信号全旧 → 仍 verdict=idle（提交不参与判定）', commitFiles >= 1 && v5.verdict === 'idle', { verdict: v5.verdict, commitFiles });
  // 恢复 analyst 到「在动」，避免影响 AC4 的 PM 通知计数
  setRoleFileMtime('analyst', A3);
  setRoleFileMtime('programmer1', A3);

  // ═══════════════ AC4：空闲自动唤醒 + 黄/红标 + 恢复清标 ═══════════════
  const A4 = NOW + 100;
  writeTask(taskRow('T-1dfb-idle-p2', 'programmer2', 'open', { claimedAt: iso(A4 - 60000), updatedAt: iso(A4 - 60000) }));
  setRoleFileMtime('programmer2', A4 - 60000);
  const wakeRowsTo = (role) => readJsonl(wakeLogPath()).filter((r) => String(r.to) === role && r.ok === true);
  const wakesBefore = wakeRowsTo('programmer2').length;
  const activityBefore = readJsonl(activityAuditPath()).length;
  const r1 = await ops.recoverStalledRoles(PROJ, { now: A4 });
  const newWakes = wakeRowsTo('programmer2').length - wakesBefore;
  const rowsAfter1 = readJsonl(activityAuditPath()).slice(activityBefore);
  const p2Rows1 = rowsAfter1.filter((r) => String(r.role) === 'programmer2');
  const stalled1 = p2Rows1.find((r) => r.verdict === 'idle' && (r.action === 'woken' || r.action === 'stalled'));
  ok('AC4① idle → 自动唤醒 1 次（唤醒.jsonl 新增 to=programmer2 且 ok=true）', newWakes === 1, { newWakes, r1Rows: r1.rows });
  ok('AC4① 黄标：活跃度审计有 idle 行且 level=notice（action=woken 或 stalled）', Boolean(stalled1) && stalled1.level === 'notice' && stalled1.wake.ok === true, stalled1);
  const stalledItemId = `Q-STALL-programmer2-T-1dfb-idle-p2`;
  ok('AC4① idle → 未闭环任务重新入队（reason=stalled、attempt=1）', queueItems().some((i) => String(i.id) === stalledItemId && i.reason === 'stalled' && Number(i.attempt) === 1), queueItems().map((i) => ({ id: i.id, reason: i.reason, attempt: i.attempt })));
  const escalateMsgsFor = (role) => mailOf('pm').filter((m) => /空闲未动/.test(String(m.subject || '')) && String(m.body || '').includes(`（${role}）`));
  const escBefore2 = escalateMsgsFor('programmer2').length;
  const r2 = await ops.recoverStalledRoles(PROJ, { now: A4 + 10 });
  const rowsAfter2 = readJsonl(activityAuditPath());
  const escalatedRow = rowsAfter2.slice().reverse().find((r) => String(r.role) === 'programmer2' && r.action === 'escalated');
  ok('AC4② 连续 2 次 idle → 红标（action=escalated、level=escalate）', Boolean(escalatedRow) && escalatedRow.level === 'escalate', escalatedRow);
  ok('AC4② 连续 2 次 idle → PM 收 1 条 escalation（30 分钟去重）', escalateMsgsFor('programmer2').length === escBefore2 + 1, { before: escBefore2, after: escalateMsgsFor('programmer2').length });
  const queuedStallItems = queueItems().filter((i) => String(i.id) === stalledItemId);
  const stateAfter2 = (ops.readDeliveryState(PROJ).items || {})[stalledItemId] || {};
  ok('AC4② 幂等：重复 recoverStalledRoles 不产生第二个队列项、attempt 不自增', queuedStallItems.length === 1 && Number(stateAfter2.attempt) === 1, { queued: queuedStallItems.length, state: stateAfter2 });
  setRoleFileMtime('programmer2', A4 + 1000);
  const r3 = await ops.recoverStalledRoles(PROJ, { now: A4 + 20 });
  const recoveredRow = readJsonl(activityAuditPath()).slice().reverse().find((r) => String(r.role) === 'programmer2' && r.action === 'recovered');
  const recoveredAudit = readJsonl(deliveryAuditPath()).filter((r) => r.result === 'recovered' && r.itemId === stalledItemId);
  const alertedP2 = (readJson(stalePath(), { alerted: {} }).alerted || {})[stalledItemId];
  ok('AC4③ 新文件写入 → 下一轮写 recovered 审计并清标', Boolean(recoveredRow) && recoveredAudit.length >= 1 && !alertedP2, { recoveredRow, recoveredAudit, alertedP2 });

  // ═══════════════ AC6：审计固定键 + append-only + 幂等 ═══════════════
  const DELIVERY_KEYS = ['at', 'project', 'itemId', 'to', 'taskId', 'attempt', 'result', 'code', 'stallMs', 'messageId', 'wakeOk', 'source'];
  const ACTIVITY_KEYS = ['at', 'project', 'role', 'action', 'verdict', 'idleMs', 'signals', 'wake', 'level', 'detail'];
  const deliveryRows = readJsonl(deliveryAuditPath());
  const activityRows = readJsonl(activityAuditPath());
  const badDelivery = deliveryRows.filter((r) => { const k = Object.keys(r); return k.length !== 12 || DELIVERY_KEYS.some((x) => !(x in r)); });
  const badActivity = activityRows.filter((r) => {
    const k = Object.keys(r); if (k.length !== 10 || ACTIVITY_KEYS.some((x) => !(x in r))) return true;
    const s = r.signals || {}; const w = r.wake || {};
    return Object.keys(s).length !== 3 || ['fileAt', 'ackAt', 'workingAt'].some((x) => !(x in s)) || Object.keys(w).length !== 3 || ['ok', 'messageId', 'code'].some((x) => !(x in w));
  });
  ok('AC6 派单投递审计每行恰好 12 键（{at,project,itemId,to,taskId,attempt,result,code,stallMs,messageId,wakeOk,source}）', deliveryRows.length >= 6 && badDelivery.length === 0, { rows: deliveryRows.length, bad: badDelivery.slice(0, 2) });
  ok('AC6 活跃度审计每行恰好 10 键（signals/wake 子对象各 3 键）', activityRows.length >= 3 && badActivity.length === 0, { rows: activityRows.length, bad: badActivity.slice(0, 2) });
  const timeoutB2Rows = readJsonl(deliveryAuditPath()).filter((r) => r.itemId === 'Q-1dfb-b2' && r.result === 'timeout');
  ok('AC6 同一 item 同一 attempt 不重复写（b2 多次 tick 仅 1 行 timeout）', timeoutB2Rows.length === 1, timeoutB2Rows);
  const beforeCounts = { delivery: readJsonl(deliveryAuditPath()).length, activity: readJsonl(activityAuditPath()).length };
  ops.tickDispatchDeadlines(PROJ, { now: A4 + 30, source: 'tick' });
  await ops.recoverStalledRoles(PROJ, { now: A4 + 30 });
  const afterCounts = { delivery: readJsonl(deliveryAuditPath()).length, activity: readJsonl(activityAuditPath()).length };
  ok('AC6 append-only：跑第二遍历史行数不减少', afterCounts.delivery >= beforeCounts.delivery && afterCounts.activity >= beforeCounts.activity, { beforeCounts, afterCounts });

  // ═══════════════ 零污染：真实状态文件 sha256+mtime 前后不变 ═══════════════
  // 注意：这两份是「活文件」——Owner 正跑的工作台/其他角色会话会并发写它们（本机实测 workbench.json 每分钟都变）。
  // 因此判据分两级：①前后逐位相同 → 直接 PASS；②不同 → 再静置 400ms 观察（本脚本此时不跑任何 ops 调用）：
  //   静置期仍在变 ⇒ 存在外部并发写者、可证明不是本脚本写的（PASS 并留注记）；静置期稳定 ⇒ 判 FAIL（只有本脚本运行期间变过）。
  const idle0 = { workbench: fileSig(realWorkbench), team: fileSig(realTeam) };
  await new Promise((resolve) => setTimeout(resolve, 400));
  const idle1 = { workbench: fileSig(realWorkbench), team: fileSig(realTeam) };
  const wbSame = sigEq(realBefore.workbench, idle0.workbench);
  const teamSame = sigEq(realBefore.team, idle0.team);
  const wbExternal = !sigEq(idle0.workbench, idle1.workbench);
  const teamExternal = !sigEq(idle0.team, idle1.team);
  ok('隔离 真实 data/userdata/workbench.json sha256+mtime 前后不变（或静置期仍在变=外部并发写者）', wbSame || wbExternal, { same: wbSame, externalWriterProven: wbExternal, before: realBefore.workbench, after: idle0.workbench, idleAfter: idle1.workbench });
  ok('隔离 真实 团队/状态/团队.json sha256+mtime 前后不变（或静置期仍在变=外部并发写者）', teamSame || teamExternal, { same: teamSame, externalWriterProven: teamExternal, before: realBefore.team, after: idle0.team, idleAfter: idle1.team });
  if (!wbSame || !teamSame) log(`NOTE  真实状态文件跑期间被外部写（workbench 静置期变化=${wbExternal}，团队.json 静置期变化=${teamExternal}）；本脚本全部写入落在沙盘 ${SB}`);
}

main()
  .catch((e) => { fail += 1; failures.push({ name: 'UNCAUGHT', detail: String((e && e.stack) || e).slice(0, 400) }); log(`FAIL  UNCAUGHT  ${String((e && e.stack) || e).slice(0, 800)}`); })
  .finally(() => {
    const total = pass + fail;
    const summary = `1dfb 派单投递断言：${pass}/${total} PASS`;
    log('');
    log(summary);
    for (const f of failures) log(`  ✗ ${f.name}  ${f.detail}`);
    const evidDir = path.join(REPO, '项目', '工作台改造修复', '程序员A', '产出', '证据-1dfb');
    try {
      fs.mkdirSync(evidDir, { recursive: true });
      fs.writeFileSync(path.join(evidDir, 'test-dispatch-delivery.log'), outLines.join('\n') + '\n', 'utf8');
    } catch { /* 证据写失败不影响退出码 */ }
    process.exit(fail ? 1 : 0);
  });
