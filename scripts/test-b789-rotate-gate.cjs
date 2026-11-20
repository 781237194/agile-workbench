'use strict';
/**
 * 夹具：R-b789 · PM 换人门禁口径四项（B-20261120-…-b789 实施）
 *
 *   (a) 执行者自身豁免（只跳②、只跳自己）           → 组 A
 *   (c) Owner 通道文案删除（静态）                    → 组 X
 *   (d) 可排障字段（remainingSec/skippedSelf 等）      → 组 R/C
 *   (e') 会话排队快照陈旧=保守拒绝                     → 组 S
 *   零副作用（拒绝零写入 / dry-run 零写入）             → 组 C2
 *
 * 隔离：mkdtemp 沙盘 + TEAM_ROOT/TEAM_PROJECTS_ROOT/TEAM_WORKBENCH_JSON/AWB_DATA_DIR + TEAM_SELFTEST=1；
 *      实际状态只读；child 进程 import session.mjs（PATHS 在 import 时解析，必须子进程）。
 * 跑法：node scripts/test-b789-rotate-gate.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SESSION_SRC = path.join(ROOT, '团队', '工具', 'lib', 'session.mjs');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const PROJECT = 'b789-沙盘';
const MARK = '@@b789@@';
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-b789-'));
const TEAM = path.join(SB, '团队');
const STATE = path.join(TEAM, '状态');
const MAIL = path.join(STATE, '邮箱');
const PROJDIR = path.join(STATE, '项目', PROJECT);
const TASKDIR = path.join(PROJDIR, '任务');
const RESULTS = [];
function check(id, title, ok, detail) {
  RESULTS.push({ id, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${title}${ok ? '' : '  ← ' + String(JSON.stringify(detail === undefined ? '' : detail)).slice(0, 320)}`);
  if (!ok) process.exitCode = 1;
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const env = () => ({ ...process.env, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(SB, '项目'), TEAM_WORKBENCH_JSON: path.join(SB, 'workbench.json'), AWB_DATA_DIR: path.join(SB, 'data'), TEAM_SELFTEST: '1' });
function seedTeam() {
  fs.mkdirSync(STATE, { recursive: true });
  const members = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'].map((role) => ({ role, name: role, status: 'active', sessionId: `session-b789-${role}` }));
  fs.writeFileSync(path.join(STATE, '团队.json'), JSON.stringify({ version: 1, name: 'b789 沙盘', phase: 'team', activeProject: PROJECT, members, config: {} }, null, 2) + '\n', 'utf8');
}
function writeQueue({ at, staleMs = 120000, degraded = null, roles = [] }) {
  fs.mkdirSync(STATE, { recursive: true });
  const row = { schema: 2, project: PROJECT, degraded, roles };
  if (at !== undefined) row.at = at;
  if (staleMs !== null) row.staleMs = staleMs;
  fs.writeFileSync(path.join(STATE, '会话排队.json'), JSON.stringify(row, null, 2) + '\n', 'utf8');
}
const freshQueue = (roles = []) => writeQueue({ at: new Date().toISOString(), roles });
function childProbe(opts = {}) {
  // opts.now 可注入：边界用例要「ageMs 恰好等于容差」，不能靠墙钟抖动
  const payload = JSON.stringify({ project: PROJECT, minutes: 15, actorRole: opts.actorRole || '', actorSessionId: opts.actorSessionId || '' });
  const code = `
const { pathToFileURL } = require('node:url');
(async () => {
  const mod = await import(${JSON.stringify(pathToFileURL(SESSION_SRC).href)});
  const g = mod.pmRotateIdleState(${JSON.stringify(PROJECT)}, ${JSON.stringify({ minutes: 15, ...opts })});
  process.stdout.write(${JSON.stringify(MARK)} + JSON.stringify(g) + '\\n');
})().catch((e) => process.stdout.write(${JSON.stringify(MARK)} + JSON.stringify({ error: String((e && e.stack) || e) }) + '\\n'));
`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: env(), cwd: SB, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  const line = String(r.stdout || '').split(/\r?\n/).find((l) => l.startsWith(MARK)) || '';
  let data = null; if (line) { try { data = JSON.parse(line.slice(MARK.length)); } catch { data = null; } }
  return { status: r.status, data, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), payload };
}
function cli(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(), cwd: SB, timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  let json = null; try { json = JSON.parse(String(r.stdout || '')); } catch { json = null; }
  return { status: r.status, json, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), text: String(r.stdout || '') + String(r.stderr || '') };
}
function mailCounts() {
  let n = 0;
  for (const box of ['new', 'cur']) { try { n += fs.readdirSync(path.join(MAIL, box)).length; } catch { /* 缺目录 */ } }
  return n;
}

try {
  seedTeam();
  fs.mkdirSync(TASKDIR, { recursive: true });

  /* ── 组 S：快照可用性（e'） ─────────────────────────────── */
  {
    try { fs.rmSync(path.join(STATE, '会话排队.json'), { force: true }); } catch { /* ignore */ }
    const p = childProbe();
    check('S1', '快照缺失 → snapshot_missing、ok:false、保守拒绝（roles 全 busy）',
      Boolean(p.data) && p.data.ok === false && p.data.code === 'snapshot_missing'
      && p.data.degraded && p.data.degraded.code === 'snapshot_missing'
      && Object.values(p.data.roles || {}).every((r) => r.idle === false && r.reasons.length >= 1), p.data && { code: p.data.code, degraded: p.data.degraded });

    fs.writeFileSync(path.join(STATE, '会话排队.json'), '{bad json', 'utf8');
    const p2 = childProbe();
    check('S2', '快照坏 JSON → snapshot_unreadable 且保守拒绝', Boolean(p2.data) && p2.data.ok === false && p2.data.code === 'snapshot_unreadable', p2.data && { code: p2.data.code });

    writeQueue({ staleMs: 120000, roles: [] });   // 无 at
    const p3 = childProbe();
    check('S3', '快照 at 缺失 → snapshot_unreadable 且保守拒绝', Boolean(p3.data) && p3.data.ok === false && p3.data.code === 'snapshot_unreadable', p3.data && { code: p3.data.code });

    const now4 = Date.now();
    writeQueue({ at: new Date(now4 - 300000).toISOString(), staleMs: 120000, roles: [] });
    const p4 = childProbe({ now: now4 });
    check('S4', 'at 龄 300s > 容差 240s → snapshot_stale，degraded 带 ageMs/staleMs/snapshotMaxAgeMs',
      Boolean(p4.data) && p4.data.ok === false && p4.data.code === 'snapshot_stale'
      && p4.data.degraded && p4.data.degraded.ageMs >= 300000 && p4.data.degraded.snapshotMaxAgeMs === 240000, p4.data && p4.data.degraded);

    const now5 = Date.now();
    writeQueue({ at: new Date(now5 - 240000).toISOString(), staleMs: 120000, roles: [] });
    const p5 = childProbe({ now: now5 });
    check('S5', '边界 ageMs===snapshotMaxAgeMs(240s) → 不判陈旧（degraded:null，按原判放行）', Boolean(p5.data) && p5.data.ok === true && p5.data.degraded === null, p5.data && { ok: p5.data.ok, degraded: p5.data.degraded, code: p5.data.code });

    const now6 = Date.now();
    writeQueue({ at: new Date(now6 - 150000).toISOString(), staleMs: 120000, roles: [] });
    const p6 = childProbe({ now: now6 });
    check('S6', 'at 龄 150s（≤150s 保护）→ 不得判 snapshot_stale', Boolean(p6.data) && p6.data.ok === true && !p6.data.code, p6.data && { ok: p6.data.ok, code: p6.data.code });

    writeQueue({ at: new Date().toISOString(), staleMs: 120000, degraded: 'plugin_not_reporting', roles: [] });
    const p7 = childProbe();
    check('S7', '快照自带 degraded 非空 → snapshot_reported 且拒', Boolean(p7.data) && p7.data.ok === false && p7.data.code === 'snapshot_reported', p7.data && { code: p7.data.code });

    writeQueue({ at: new Date().toISOString(), staleMs: null, roles: [] });
    const p8 = childProbe();
    check('S8', 'staleMs 缺失 → 回落 120000（容差 240s）', Boolean(p8.data) && p8.data.ok === true && p8.data.degraded === null, p8.data && { ok: p8.data.ok });
  }

  /* ── 组 A：执行者自身豁免（a） ───────────────────────────── */
  {
    freshQueue([{ role: 'pm', sessionId: 'session-b789-pm', running: true, pendingInput: [] }]);
    const a1 = childProbe({ actorRole: 'pm', actorSessionId: 'session-b789-pm' });
    check('A1', 'pm running 且 pm.sessionId==actorSessionId → 跳②、skippedSelf:true、pm idle=true',
      Boolean(a1.data) && a1.data.roles.pm.idle === true && a1.data.roles.pm.skippedSelf === true && a1.data.ok === true,
      a1.data && { pm: a1.data.roles && a1.data.roles.pm });

    const a2 = childProbe({ actorRole: 'product', actorSessionId: 'session-b789-product' });
    check('A2', 'pm running 且 actor=product（sessionId 不等于 pm）→ 不豁免、pm idle=false',
      Boolean(a2.data) && a2.data.roles.pm.idle === false && /有正在跑的会话/.test((a2.data.roles.pm.reasons || []).join('')),
      a2.data && { pm: a2.data.roles && a2.data.roles.pm });

    const a3 = childProbe({ actorRole: 'selftest', actorSessionId: '' });
    check('A3', 'actorSessionId 空 → 不豁免（selftest 与旧夹具口径不变）', Boolean(a3.data) && a3.data.roles.pm.idle === false && a3.data.roles.pm.skippedSelf === false, a3.data && { pm: a3.data.roles && a3.data.roles.pm });

    fs.writeFileSync(path.join(TASKDIR, 'T-b789-working.json'), JSON.stringify({ id: 'T-b789-working', type: 'task', title: 'working', owner: 'pm', status: 'working', priority: 'P2', createdAt: new Date().toISOString(), claimedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
    const a4 = childProbe({ actorRole: 'pm', actorSessionId: 'session-b789-pm' });
    check('A4', '只跳②：pm 自身 running 命中但名下有 working 任务 → 仍拒（reasons 含 working 任务）',
      Boolean(a4.data) && a4.data.roles.pm.idle === false && /working 任务/.test((a4.data.roles.pm.reasons || []).join('')) && a4.data.roles.pm.skippedSelf === true,
      a4.data && { pm: a4.data.roles && a4.data.roles.pm });
    fs.rmSync(path.join(TASKDIR, 'T-b789-working.json'), { force: true });

    freshQueue([{ role: 'product', sessionId: 'session-b789-product', running: true, pendingInput: [] }]);
    const a5 = childProbe({ actorRole: 'product', actorSessionId: 'session-b789-product' });
    check('A5', 'product 自身 running 且 actor=product → 豁免②、skippedSelf:true、门通过', Boolean(a5.data) && a5.data.ok === true && a5.data.roles.product.idle === true && a5.data.roles.product.skippedSelf === true, a5.data && { product: a5.data.roles && a5.data.roles.product });
  }

  /* ── 组 R：remainingSec 精确到秒（d） ────────────────────── */
  {
    freshQueue([]);
    fs.mkdirSync(path.join(MAIL, 'product', 'new'), { recursive: true });
    const n = 14 * 60 + 59;
    const ts = new Date(Date.now() - n * 1000).toISOString();
    fs.writeFileSync(path.join(MAIL, 'product', 'new', `${ts.replace(/[:.]/g, '-')}-M-b789-1.json`), JSON.stringify({ id: 'M-b789-1', from: 'pm', to: 'product', ts, at: ts, type: 'notice', subject: 's', body: 'b', project: PROJECT }, null, 2) + '\n', 'utf8');
    const r1 = childProbe();
    const pm = (r1.data && r1.data.roles && r1.data.roles.pm) || {};
    check('R1', '14 分 59 秒 → remainingSec 精确到秒且落在 1..899（不得凑成 900），remainingMin 保留',
      Boolean(r1.data) && pm.idle === false && Number.isInteger(pm.remainingSec) && pm.remainingSec >= 1 && pm.remainingSec <= 899
      && pm.remainingSec === 1 && typeof pm.remainingMin === 'number', { pm });
    fs.rmSync(path.join(MAIL, 'product'), { recursive: true, force: true });
  }

  /* ── 组 C：CLI 拒绝详情 + 零副作用（d/零副作用） ─────────── */
  {
    freshQueue([{ role: 'pm', sessionId: 'session-b789-pm', running: true, pendingInput: [] }]);
    const before = { team: sha(path.join(STATE, '团队.json')), rot: sha(path.join(PROJDIR, '会话轮换.jsonl')), roster: sha(path.join(PROJDIR, '名册变更.jsonl')), bq: sha(path.join(PROJDIR, '待启动队列.json')), mail: mailCounts() };
    const c1 = cli(['session', 'rotate', '--role', 'pm', '--dry-run', '--json']);
    const d = (c1.json && c1.json.details) || {};
    const busy = Array.isArray(d.busy) ? d.busy : [];
    check('C1', 'CLI 拒绝（WAIT_BOTH_IDLE）：details 含 actorRole/actorSessionId/degraded/busy[].remainingSec/skippedSelf；next 不含「Owner 通道」；文案不含 Owner 豁免',
      c1.status !== 0 && c1.json && c1.json.code === 'WAIT_BOTH_IDLE'
      && Object.prototype.hasOwnProperty.call(d, 'actorRole') && Object.prototype.hasOwnProperty.call(d, 'actorSessionId')
      && Object.prototype.hasOwnProperty.call(d, 'degraded')
      && busy.length >= 1 && busy.every((b) => Object.prototype.hasOwnProperty.call(b, 'remainingSec') && Object.prototype.hasOwnProperty.call(b, 'skippedSelf'))
      && !/Owner 通道/.test(String(d.next || '')) && !/Owner/.test(String(c1.json.message || '')),
      { code: c1.json && c1.json.code, details: d, message: c1.json && c1.json.message });

    const after = { team: sha(path.join(STATE, '团队.json')), rot: sha(path.join(PROJDIR, '会话轮换.jsonl')), roster: sha(path.join(PROJDIR, '名册变更.jsonl')), bq: sha(path.join(PROJDIR, '待启动队列.json')), mail: mailCounts() };
    check('C2', '拒绝零副作用：团队.json/会话轮换/名册变更/BQ/邮箱计数前后不变',
      JSON.stringify(before) === JSON.stringify(after), { before, after });
  }

  /* ── 组 X：AC2 静态（Owner 文案删除 + 不新增 owner 分支） ── */
  {
    const src = fs.readFileSync(SESSION_SRC, 'utf8');
    check('X1', 'session.mjs 无「Owner 通道不设此门」「或由 Owner 直接指令换人」', !src.includes('Owner 通道不设此门') && !src.includes('或由 Owner 直接指令换人'), {});
    check('X2', '未新增 actorRole===owner 跳过分支（rotateAllowed 不变）', !/actorRole\s*===\s*'owner'/.test(src) && /export function rotateAllowed\(tokenRole, targetRole\)/.test(src), {});
    // PM 2026-11-20 13:40 补充口径：--json 放行体 idleGate 也要带 actorRole/actorSessionId/skippedSelf/remainingSec。
    check('X3', 'idleGate(JSON) 含 actorRole/actorSessionId/skippedSelf/remainingSec',
      /idleGateJson/.test(src) && /remainingSec:\s*Math\.max\(0,\s*\.\.\.Object\.values\(idleGate\.roles\)/.test(src)
      && /skippedSelf:\s*Object\.entries\(idleGate\.roles\)/.test(src), {});
  }
} catch (e) {
  check('E0', '夹具未抛异常', false, { error: String((e && e.stack) || e) });
} finally {
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
}
const pass = RESULTS.filter((r) => r.ok).length;
console.log(`\n${pass}/${RESULTS.length} PASS`);
if (pass !== RESULTS.length) process.exitCode = 1;
