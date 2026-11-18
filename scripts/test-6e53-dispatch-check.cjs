#!/usr/bin/env node
'use strict';
/**
 * test-6e53-dispatch-check.cjs —— T-20261118-091644-6e53（派单前置检查程序门）夹具
 *
 * 覆盖：
 *   A. dispatch-check 六类场景 verdict：queued=1 / pendingInput / running(120s) / running(900s) /
 *      快照 stale（降级 go_degraded，绝不给 go）/ 派单锁（blocked）；另加「未 boot → blocked」与「干净 → go」。
 *   B. 程序门：未检查 → DISPATCH_PRECHECK_REQUIRED（零写入）；verdict=wait → DISPATCH_BLOCKED_BY_STATE；
 *      --force --reason 放行 + 审计 forced:true；--force 无 reason → DISPATCH_FORCE_REASON_REQUIRED；
 *      非派单 notice 不受限；verdict=go 后正常派单；沙盘豁免（不加 ENFORCE）不拦。
 *   C. 审计：派单前置检查.jsonl 每次调用一行，含 {at,by,to,verdict,reasons,snapshotAt,snapshotStale}。
 *
 * 隔离：TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_WORKBENCH_JSON + AWB_DATA_DIR + TEAM_SELFTEST=1 + TEAM_DSH_FAKE
 *       + TEAM_DISPATCH_PRECHECK_ENFORCE=1；断言真实 团队.json / workbench.json 前后 sha 不变。
 * 用法：node scripts/test-6e53-dispatch-check.cjs [--json]
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');
const PROJECT = '前置检查沙盘';
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const SB = mkTempSandbox('dispatch-check');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const DATA = path.join(SB, 'data');
const TEAM_TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const TEAM_FILE = path.join(TEAM, '状态', '团队.json');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const PROJECT_DIR = path.join(PROJECTS, PROJECT);
const MANIFEST = path.join(PROJECT_DIR, '团队会话.json');
const SNAPSHOT = path.join(TEAM, '状态', '会话排队.json');
const LOCK = path.join(STATE, '派单锁.json');
const AUDIT = path.join(STATE, '派单前置检查.jsonl');
const WAKE_LOG = path.join(STATE, '唤醒.jsonl');
const QUEUE_FILE = path.join(STATE, '派单队列.json');
const REAL_TEAM_FILE = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const jsonlRows = (f) => { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const mailCount = (role) => {
  let n = 0;
  for (const box of ['new', 'cur']) {
    try { n += fs.readdirSync(path.join(TEAM, '状态', '邮箱', role, box)).filter((x) => x.endsWith('.json')).length; } catch { /* 无箱 */ }
  }
  return n;
};
const seedId = (role) => `session-dc-${role}`;
const oldId = seedId;

const realBefore = { team: sha(REAL_TEAM_FILE), workbench: sha(REAL_STORE) };

/* ── 沙盘骨架 ─────────────────────────────────────────────────────────── */
function env(extra = {}) {
  return {
    ...process.env,
    TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: PROJECTS,
    TEAM_WORKBENCH_JSON: STORE,
    AWB_DATA_DIR: DATA,
    TEAM_SELFTEST: '1',
    TEAM_DISPATCH_PRECHECK_ENFORCE: '1',
    TEAM_DSH_FAKE: JSON.stringify(ROLES.map((r) => ({ sessionId: seedId(r) }))),
    ...extra,
  };
}
function run(args, extraEnv = {}) {
  try {
    const out = execFileSync(process.execPath, [TEAM_TOOL, ...args], { encoding: 'utf8', env: env(extraEnv), timeout: 120000, cwd: SB });
    return { code: 0, out: String(out), err: '' };
  } catch (error) {
    return { code: error.status == null ? 1 : error.status, out: String(error.stdout || ''), err: String(error.stderr || '') };
  }
}
const text = (r) => String(r.out || '') + String(r.err || '');
function runJson(args, extraEnv = {}) {
  const r = run(args, extraEnv);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}
/** 子进程内跑（用于断言"零副作用"时也能拿到 code + 错误码）。 */
function codeOf(r) {
  const m = /\[([A-Z][A-Z0-9_]+)\]/.exec(text(r)) || /"code"\s*:\s*"([A-Z0-9_]+)"/.exec(text(r));
  return m ? m[1] : '';
}

/* 沙盘初始化 */
fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
fs.mkdirSync(PROJECTS, { recursive: true });
const seedTeam = readJson(path.join(ROOT, '团队', '状态', '团队.json'), { members: [] });
seedTeam.activeProject = PROJECT;
for (const m of seedTeam.members || []) m.sessionId = seedId(m.role);
writeJson(TEAM_FILE, seedTeam);
for (const rel of ['团队宪法.md', '项目铁律.md']) {
  const src = path.join(ROOT, '团队', rel);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TEAM, rel));
}
if (fs.existsSync(path.join(ROOT, '团队', '协议'))) fs.cpSync(path.join(ROOT, '团队', '协议'), path.join(TEAM, '协议'), { recursive: true });

const setup = runJson(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
check('S0 沙盘项目登记', setup.code === 0, { code: setup.code, out: text(setup).slice(0, 300) });
const projectJson = readJson(path.join(STATE, '项目.json'), {});
const MODE_ROLES = Array.isArray(projectJson.roleIds) && projectJson.roleIds.length ? projectJson.roleIds : ROLES.slice();
const teamSeed = readJson(TEAM_FILE, { members: [] });
teamSeed.activeProject = PROJECT;
for (const role of MODE_ROLES) {
  let m = (teamSeed.members || []).find((x) => x && x.role === role);
  if (!m) { m = { role, name: role, status: 'active', joinedAt: new Date().toISOString() }; teamSeed.members.push(m); }
  m.sessionId = seedId(role);
}
writeJson(TEAM_FILE, teamSeed);
writeJson(MANIFEST, {
  project: PROJECT, teamMode: 'full', workspace: PROJECT_DIR, workspaceId: 'dc-ws',
  generatedAt: new Date().toISOString(),
  roles: MODE_ROLES.map((role) => ({ role, name: role, title: `团队·${role}`, sessionId: seedId(role), reused: false, model: '' })),
});
const realStore = readJson(REAL_STORE, { projects: [] }) || { projects: [] };
const tpl = (realStore.projects || []).find((p) => p && String(p.teamName || p.name || '') === '工作台改造修复') || (realStore.projects || [])[0] || {};
const entry = JSON.parse(JSON.stringify(tpl));
entry.id = 'dc-p1'; entry.name = PROJECT; entry.teamName = PROJECT;
entry.path = PROJECT_DIR; entry.workspacePath = PROJECT_DIR;
entry.sessions = Object.fromEntries(MODE_ROLES.map((r) => [r, seedId(r)]));
entry.workspace = { ...(entry.workspace || {}), path: PROJECT_DIR, sessionIds: MODE_ROLES.map(seedId) };
writeJson(STORE, { ...realStore, projects: [entry], activeProjectId: entry.id });
writeJson(path.join(STATE, '工作流.json'), { schema: 2, project: PROJECT, round: 1, requirements: {}, boots: {} });
for (const role of MODE_ROLES) fs.mkdirSync(path.join(PROJECT_DIR, role, '产出'), { recursive: true });

/* 令牌：pm / programmer1 / programmer2 / tester 各 boot 一个；analyst 故意不 boot（未 boot 场景） */
const tokenOf = {};
for (const role of ['pm', 'programmer1', 'programmer2', 'tester']) {
  const r = runJson(['boot', '--role', role, '--project', PROJECT, '--session', seedId(role), '--json']);
  const m = /"token"\s*:\s*"([0-9a-f]+)"/.exec(text(r));
  tokenOf[role] = m ? m[1] : '';
  if (!tokenOf[role]) check(`S1 ${role} boot 取令牌`, false, { out: text(r).slice(0, 300) });
}
const PM = tokenOf.pm;
check('S1 沙盘令牌就绪（pm/programmer1/programmer2/tester；analyst 故意不 boot）',
  Boolean(PM && tokenOf.programmer1 && tokenOf.programmer2 && tokenOf.tester), { got: Object.keys(tokenOf).filter((k) => tokenOf[k]) });
const mapCheck = runJson(['session', 'check', '--project', PROJECT, '--json']);
check('S2 沙盘四处映射 6/6', (mapCheck.json || {}).ok === true, { ratio: (mapCheck.json || {}).ratio });

/* ── 工具：写快照 / 唤醒日志 / 派单锁 / 任务 ──────────────────────────── */
function writeSnapshot(roleRows, { atMs = Date.now(), staleMs = 120000 } = {}) {
  const rows = ROLES.map((role) => {
    const custom = (roleRows || {})[role] || {};
    return {
      role, sessionId: seedId(role), known: true, queued: 0,
      byPlacement: { queued: 0, steering: 0, context: 0 },
      state: 'ok', lastOkAt: new Date(atMs).toISOString(), lastAt: new Date(atMs).toISOString(), stale: false,
      // c9ac v2 字段（默认全给；要测缺字段时传 v2:false）
      running: false, pendingInput: [], runningSince: null,
      ...custom,
    };
  });
  const body = { schema: 1, at: new Date(atMs).toISOString(), project: PROJECT, teamRoot: TEAM, resolveSource: 'config', staleMs, degraded: null, roles: rows.filter((r) => r && r.role) };
  writeJson(SNAPSHOT, body);
  return body;
}
function v1Snapshot(roleRows, { atMs = Date.now(), staleMs = 120000 } = {}) {
  const rows = ROLES.map((role) => {
    const custom = (roleRows || {})[role] || {};
    const base = { role, sessionId: seedId(role), known: true, queued: 0, byPlacement: { queued: 0, steering: 0, context: 0 }, state: 'ok', lastOkAt: new Date(atMs).toISOString(), lastAt: new Date(atMs).toISOString(), stale: false };
    return { ...base, ...custom };
  });
  writeJson(SNAPSHOT, { schema: 1, at: new Date(atMs).toISOString(), project: PROJECT, staleMs, roles: rows });
}
function writeWake(role, atMs, { ok = true } = {}) {
  fs.mkdirSync(path.dirname(WAKE_LOG), { recursive: true });
  const row = { at: new Date(atMs).toISOString(), time: new Date(atMs).toISOString(), project: PROJECT, to: role, ok, reason: 'fixture' };
  fs.appendFileSync(WAKE_LOG, JSON.stringify(row) + '\n', 'utf8');
}
function clearLock() { try { fs.rmSync(LOCK, { force: true }); } catch { /* ignore */ } }
function writeLock(role) {
  writeJson(LOCK, { messageId: 'M-fixture-lock', to: role, task: '', subject: '夹具派单锁', ts: new Date().toISOString(), expiresAt: new Date(Date.now() + 10 * 60000).toISOString(), targetSessionId: seedId(role) });
}
function clearMail(role) { try { fs.rmSync(path.join(TEAM, '状态', '邮箱', role, 'new'), { recursive: true, force: true }); } catch { /* ignore */ } }
function makeTask(id, owner = '') {
  const t = { id, project: PROJECT, type: 'task', priority: 'P2', title: `夹具任务 ${id}`, status: 'open', owner, createdAt: new Date().toISOString() };
  writeJson(path.join(STATE, '任务', `${id}.json`), t);
  return t;
}
const checkTo = (role, extra = [], extraEnv = {}) => runJson(['dispatch-check', '--boot', PM, '--project', PROJECT, '--to', role, ...extra, '--json'], extraEnv);

/* ── A. 六类场景 verdict ──────────────────────────────────────────────── */
const now = Date.now();
clearLock();

writeSnapshot({ programmer2: { queued: 2, byPlacement: { queued: 2, steering: 0, context: 0 } } }, { atMs: now });
writeWake('programmer2', now - 60000);
{
  const r = checkTo('programmer2');
  check('A1 queued=2 → queue', r.code === 0 && (r.json || {}).verdict === 'queue' && ((r.json || {}).numbers || {}).queued === 2,
    { verdict: (r.json || {}).verdict, numbers: (r.json || {}).numbers, out: text(r).slice(0, 300) });
}
writeSnapshot({ programmer2: { pendingInput: ['approval'] } }, { atMs: now });
{
  const r = checkTo('programmer2');
  check('A2 pendingInput=[approval] → queue', (r.json || {}).verdict === 'queue' && ((r.json || {}).numbers || {}).pendingInputCount === 1,
    { verdict: (r.json || {}).verdict, numbers: (r.json || {}).numbers });
}
writeSnapshot({ programmer2: { running: true, runningSince: new Date(now - 120000).toISOString() } }, { atMs: now });
{
  const r = checkTo('programmer2');
  const think = ((r.json || {}).numbers || {}).thinkSec;
  check('A3 running 120s（<600s）→ wait', (r.json || {}).verdict === 'wait' && Number.isFinite(think) && think >= 110 && think <= 180,
    { verdict: (r.json || {}).verdict, thinkSec: think });
}
writeSnapshot({ programmer2: { running: true, runningSince: new Date(now - 900000).toISOString() } }, { atMs: now });
{
  const r = checkTo('programmer2');
  check('A4 running 900s（≥600s）→ wake_first', (r.json || {}).verdict === 'wake_first', { verdict: (r.json || {}).verdict, reasons: (r.json || {}).reasons });
}
// stale 快照 + presence 空闲 + 无任务 → go_degraded（绝不给 go）
v1Snapshot({}, { atMs: now - 300000 });
{
  const r = checkTo('programmer2');
  const j = r.json || {};
  check('A5 快照 stale（v1 缺 v2 字段）→ degraded + go_degraded（不得为 go）',
    j.verdict === 'go_degraded' && Boolean(j.degraded) && j.snapshotStale === true,
    { verdict: j.verdict, degraded: j.degraded, snapshotStale: j.snapshotStale });
}
// stale + 有任务 → 不得 go/go_degraded（wake_first）
v1Snapshot({}, { atMs: now - 300000 });
makeTask('T-dc-stale-work', 'programmer1');
{
  const r = checkTo('programmer1');
  check('A5b 快照 stale + 名下有 open 任务 → 不得 go_degraded（判 wake_first）',
    ['wake_first', 'queue', 'wait', 'blocked'].includes((r.json || {}).verdict) && (r.json || {}).verdict !== 'go_degraded',
    { verdict: (r.json || {}).verdict, reasons: (r.json || {}).reasons });
}
writeSnapshot({}, { atMs: now });
writeLock('tester');
{
  const r = checkTo('tester');
  check('A6 派单锁指向该角色 → blocked（lockBy 可见）', (r.json || {}).verdict === 'blocked' && ((r.json || {}).numbers || {}).lockBy === 'tester',
    { verdict: (r.json || {}).verdict, numbers: (r.json || {}).numbers });
}
clearLock();
{
  const r = checkTo('analyst');   // analyst 未 boot
  check('A7 目标未 boot → blocked', (r.json || {}).verdict === 'blocked' && ((r.json || {}).numbers || {}).booted === false,
    { verdict: (r.json || {}).verdict, numbers: (r.json || {}).numbers });
}
writeSnapshot({}, { atMs: now });
clearLock();
writeWake('programmer2', now - 60000);
{
  const r = checkTo('programmer2');
  check('A8 干净状态（新鲜快照/v2 齐/无锁/已 boot/近期唤醒）→ go', (r.json || {}).verdict === 'go' && !(r.json || {}).degraded,
    { verdict: (r.json || {}).verdict, reasons: (r.json || {}).reasons, degraded: (r.json || {}).degraded });
}
// --require：非 go 时退出非 0
writeSnapshot({ programmer2: { queued: 1 } }, { atMs: now });
{
  const r = checkTo('programmer2', ['--require']);
  check('A9 --require + verdict=queue → 退出非 0 DISPATCH_CHECK_NOT_GO', r.code !== 0 && codeOf(r) === 'DISPATCH_CHECK_NOT_GO', { code: r.code, err: text(r).slice(0, 300) });
}
// 审计行字段
{
  const rows = jsonlRows(AUDIT);
  const last = rows[rows.length - 1] || {};
  check('A10 审计：每次调用一行，含 {at,by,to,verdict,reasons,snapshotAt,snapshotStale}',
    rows.length >= 9 && last.to === 'programmer2' && String(last.at || '') && Array.isArray(last.reasons) && 'snapshotAt' in last && 'snapshotStale' in last,
    { rows: rows.length, last });
}

/* ── B. 程序门 ────────────────────────────────────────────────────────── */
const T1 = 'T-dc-gate-1';
makeTask(T1);
for (const r of ['programmer1', 'programmer2']) clearMail(r);
clearLock();
try { fs.rmSync(QUEUE_FILE, { force: true }); } catch { /* ignore */ }
// G1 要的是「最近 10 分钟内没有该角色的检查记录」——把前面的场景审计清掉，避免被 A5b 的 programmer1 结果命中
try { fs.rmSync(AUDIT, { force: true }); } catch { /* ignore */ }
writeSnapshot({ programmer1: { queued: 1 } }, { atMs: now });   // 任何状态都行：G1 要的是「没有检查记录」
{
  const before = { mail: mailCount('programmer1'), lock: readJson(LOCK, null), task: readJson(path.join(STATE, '任务', `${T1}.json`), null), audits: jsonlRows(AUDIT).length };
  const r = run(['send', '--boot', PM, '--project', PROJECT, '--to', 'programmer1', '--ack', '--task', T1, '--subject', 'G1 未检查', '--body', '夹具：未跑 dispatch-check 直接派单']);
  const after = { mail: mailCount('programmer1'), lock: readJson(LOCK, null), task: readJson(path.join(STATE, '任务', `${T1}.json`), null), audits: jsonlRows(AUDIT).length };
  check('G1 未跑 dispatch-check → DISPATCH_PRECHECK_REQUIRED 且零写入（邮件/锁/任务/审计都不动）',
    r.code !== 0 && codeOf(r) === 'DISPATCH_PRECHECK_REQUIRED'
    && after.mail === before.mail && JSON.stringify(after.lock) === JSON.stringify(before.lock)
    && JSON.stringify(after.task) === JSON.stringify(before.task) && after.audits === before.audits,
    { code: r.code, err: text(r).slice(0, 400), before, after });
}
// G2：verdict=wait → DISPATCH_BLOCKED_BY_STATE（零写入）
writeSnapshot({ programmer1: { running: true, runningSince: new Date(Date.now() - 120000).toISOString() } }, { atMs: Date.now() });
{
  const c1 = checkTo('programmer1');
  const before = { mail: mailCount('programmer1'), lock: readJson(LOCK, null), task: readJson(path.join(STATE, '任务', `${T1}.json`), null) };
  const r = run(['send', '--boot', PM, '--project', PROJECT, '--to', 'programmer1', '--ack', '--task', T1, '--subject', 'G2 wait', '--body', '夹具：verdict=wait 时派单']);
  const after = { mail: mailCount('programmer1'), lock: readJson(LOCK, null), task: readJson(path.join(STATE, '任务', `${T1}.json`), null) };
  check('G2 最新检查 verdict=wait → DISPATCH_BLOCKED_BY_STATE（带 reasons）且零写入',
    c1.json.verdict === 'wait' && r.code !== 0 && codeOf(r) === 'DISPATCH_BLOCKED_BY_STATE' && /wait/.test(text(r))
    && after.mail === before.mail && JSON.stringify(after.lock) === JSON.stringify(before.lock) && JSON.stringify(after.task) === JSON.stringify(before.task),
    { verdict: c1.json.verdict, code: r.code, err: text(r).slice(0, 400), before, after });
}
// G3：--force --reason 放行 + 审计 forced:true
{
  const r = run(['send', '--boot', PM, '--project', PROJECT, '--to', 'programmer1', '--ack', '--task', T1, '--subject', 'G3 force', '--body', '夹具：强制派单留痕', '--force', '--reason', '夹具验证强制通道']);
  const forced = jsonlRows(AUDIT).filter((x) => x && x.forced === true).pop() || {};
  check('G3 --force --reason 放行 + 审计记 forced:true（含 forcedReason）',
    r.code === 0 && /已发送/.test(text(r)) && forced.to === 'programmer1' && String(forced.forcedReason || '').includes('夹具'),
    { code: r.code, out: text(r).slice(0, 400), forced });
}
// G4：--force 无 reason → DISPATCH_FORCE_REASON_REQUIRED（零写入）
const T2 = 'T-dc-gate-2';
makeTask(T2);
clearLock();
{
  writeSnapshot({ programmer1: { running: true, runningSince: new Date(Date.now() - 120000).toISOString() } }, { atMs: Date.now() });
  checkTo('programmer1');
  const before = { mail: mailCount('programmer1'), task: readJson(path.join(STATE, '任务', `${T2}.json`), null) };
  const r = run(['send', '--boot', PM, '--project', PROJECT, '--to', 'programmer1', '--ack', '--task', T2, '--subject', 'G4 force 无 reason', '--body', '夹具：force 但没 reason', '--force']);
  const after = { mail: mailCount('programmer1'), task: readJson(path.join(STATE, '任务', `${T2}.json`), null) };
  check('G4 --force 但无 --reason → DISPATCH_FORCE_REASON_REQUIRED 且零写入',
    r.code !== 0 && codeOf(r) === 'DISPATCH_FORCE_REASON_REQUIRED' && after.mail === before.mail && JSON.stringify(after.task) === JSON.stringify(before.task),
    { code: r.code, err: text(r).slice(0, 300) });
}
// G5：非派单 notice 不受限（即使 verdict=wait）
{
  const before = mailCount('programmer1');
  const r = run(['send', '--boot', PM, '--project', PROJECT, '--to', 'programmer1', '--subject', 'G5 notice', '--body', '夹具：通知不该被派单门拦']);
  check('G5 非派单 notice 不受程序门限制', r.code === 0 && mailCount('programmer1') === before + 1, { code: r.code, out: text(r).slice(0, 300) });
}
// G6：verdict=go 后正常派单（走门通过路径）
const T3 = 'T-dc-gate-3';
makeTask(T3);
clearLock();
writeSnapshot({}, { atMs: Date.now() });
writeWake('programmer2', Date.now() - 60000);
{
  const c = checkTo('programmer2');
  const r = runJson(['send', '--boot', PM, '--project', PROJECT, '--to', 'programmer2', '--ack', '--task', T3, '--subject', 'G6 go', '--body', '夹具：verdict=go 正常派单', '--json']);
  check('G6 最新检查 verdict=go → 正常派单（JSON 返回 dispatchPrecheck.check.verdict=go）',
    c.json.verdict === 'go' && r.code === 0 && ((r.json || {}).dispatchPrecheck || {}).check !== undefined
    && String((((r.json || {}).dispatchPrecheck || {}).check || {}).verdict || '') === 'go',
    { verdict: c.json.verdict, code: r.code, dispatchPrecheck: (r.json || {}).dispatchPrecheck, out: text(r).slice(0, 400) });
}
// G7：沙盘豁免（不加 ENFORCE）→ 不拦
{
  const T4 = 'T-dc-gate-4';
  makeTask(T4);
  clearLock();
  writeSnapshot({ programmer2: { queued: 3 } }, { atMs: Date.now() });
  try { fs.rmSync(AUDIT, { force: true }); } catch { /* 清审计：确保没有该角色记录 */ }
  const r = run(['send', '--boot', PM, '--project', PROJECT, '--to', 'programmer2', '--ack', '--task', T4, '--subject', 'G7 豁免', '--body', '夹具：沙盘未开 ENFORCE 不拦'],
    { TEAM_DISPATCH_PRECHECK_ENFORCE: '' });
  check('G7 沙盘默认豁免（TEAM_SELFTEST=1 且未开 ENFORCE）不拦（与既有门同一套路）', r.code === 0 && /已发送/.test(text(r)), { code: r.code, out: text(r).slice(0, 300) });
}

/* ── 收口：真实状态零写入 ─────────────────────────────────────────────── */
check('S9 隔离：真实 团队.json / workbench.json 前后 sha256 不变',
  sha(REAL_TEAM_FILE) === realBefore.team && sha(REAL_STORE) === realBefore.workbench,
  { before: realBefore, after: { team: sha(REAL_TEAM_FILE), workbench: sha(REAL_STORE) } });

const total = results.length;
const pass = results.filter((r) => r.ok).length;
const red = total - pass;
const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-6e53');
fs.mkdirSync(evDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const payload = {
  at: new Date().toISOString(), script: 'scripts/test-6e53-dispatch-check.cjs',
  task: 'T-20261118-091644-6e53', requirement: '',
  total, pass, red, sandbox: path.relative(ROOT, SB).replace(/\\/g, '/'),
  isolation: { realBefore, realAfter: { team: sha(REAL_TEAM_FILE), workbench: sha(REAL_STORE) } },
  results,
};
const evFile = path.join(evDir, `run-${ts}-${red === 0 ? 'green' : 'red'}.json`);
payload.evidenceFile = path.relative(ROOT, evFile).replace(/\\/g, '/');
fs.writeFileSync(evFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
if (JSON_OUT) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
else {
  console.log('');
  console.log(`${red === 0 ? 'DISPATCH_CHECK_OK' : 'DISPATCH_CHECK_WARN'} ${JSON.stringify({ total, pass, red })}`);
  console.log('证据：' + payload.evidenceFile);
}
process.exit(red === 0 ? 0 : 1);
