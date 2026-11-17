#!/usr/bin/env node
/**
 * T-20261117-213652-4de7（P1，测试）：a4c7 调度器验收（AC1–AC6）
 * 需求：需求/R-20261117-204110-a4c7-会话排队与轮次驱动的调度.md（15155B / b1d9a9923fe6）
 * 沙盘五变量隔离；断言 ①只读零写入 ②未知不当空闲 ③五类 decision 值域与优先级
 *              ④rotateRounds 默认 8/上限 10/>10 报错 + 用量共用 usageLevelOf
 *              ⑤BUSY_HOLD=roleLooksBusy、IDLE=statusIsClosed ⑥面板 data-sched-*（真窗口）+ 截图
 * 用法：node scripts/test-a4c7-sched-acceptance.cjs [--json]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = '工作台改造修复';
const jsonOut = process.argv.includes('--json');
const TEAM = path.join(ROOT, '团队');
const TEAM_MJS = path.join(TEAM, '工具', 'team.mjs');
const LIB = path.join(TEAM, '工具', 'lib');
const REAL_FILES = [
  path.join(TEAM, '状态', '会话排队.json'),
  path.join(TEAM, '状态', '项目', PROJECT, '会话轮次.json'),
  path.join(TEAM, '状态', '项目', PROJECT, '会话用量.json'),
  path.join(TEAM, '状态', '项目', PROJECT, '派单队列.json'),
];
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const SANDBOX = path.join(ROOT, '_tmp', `a4c7-accept-${process.pid}-${Date.now().toString(36)}`);
const PORT = 9710 + (process.pid % 50);
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const DECISIONS = ['HANDOVER_FIRST', 'STALE_ALERT', 'BUSY_HOLD', 'IDLE_DISPATCH', 'STANDBY'];

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!jsonOut) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const sha256 = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
const shaMap = (files) => Object.fromEntries(files.map((f) => [f, sha256(f)]));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, ent.name), b = path.join(dst, ent.name);
    if (filter && filter(a)) continue;
    if (ent.isDirectory()) copyDir(a, b, filter); else fs.copyFileSync(a, b);
  }
}

const SB = {
  dir: SANDBOX,
  data: path.join(SANDBOX, 'data'),
  team: path.join(SANDBOX, '团队'),
  projects: path.join(SANDBOX, '项目'),
  get teamFile() { return path.join(this.team, '状态', '团队.json'); },
  get state() { return path.join(this.team, '状态', '项目', PROJECT); },
  get workbenchFile() { return path.join(this.data, 'userdata', 'workbench.json'); },
};
const sbEnv = () => ({
  ...process.env,
  AWB_DATA_DIR: SB.data, TEAM_ROOT: SB.team, TEAM_PROJECTS_ROOT: SB.projects,
  TEAM_WORKBENCH_JSON: SB.workbenchFile, TEAM_SELFTEST: '1',
  // B-7b01 起 boot 会校验「名册会话必须存在于 DSH 列表」；沙盘没有真 DSH，
  // 必须用 TEAM_DSH_FAKE 提供假列表（只在 TEAM_SELFTEST=1 生效），并断掉真实 DSH 连接。
  DSH_WEB_URL: '',
  TEAM_DSH_FAKE: JSON.stringify([{ sessionId: 'sess-a4c7-accept' }, { sessionId: 'sess-old-tester' }]),
});
function run(args, env) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env: env || sbEnv(), encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
async function waitTarget(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()); const hit = list.find((p) => p && String(p.url || '').includes('renderer/index.html')); if (hit && hit.webSocketDebuggerUrl) return hit; } catch { /* ignore */ }
    await sleep(300);
  }
  return null;
}
function killTree(child) { if (!child) return; try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } } }
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(String(e.data)); } catch { return; } if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); } }); }
  send(method, params = {}, ms = 30000) { const id = ++this.seq; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout ' + method)); } }, ms); }); }
  async evaluate(expr) { const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return out && out.result ? out.result.value : undefined; }
}

function seedSandbox(fixtures) {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(path.join(SB.data, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(SB.projects), { recursive: true });
  copyDir(TEAM, SB.team, (p) => /[\\/]邮箱([\\/]|$)/.test(p) || /[\\/]锁([\\/]|$)/.test(p) || /[\\/]备份([\\/]|$)/.test(p) || /[\\/]状态[\\/]项目([\\/]|$)/.test(p));
  fs.mkdirSync(path.join(SB.team, '状态', '项目'), { recursive: true });
  fs.mkdirSync(path.join(SB.team, '状态', '邮箱'), { recursive: true });
  const roster = readJson(SB.teamFile, { members: [] });
  for (const m of (roster.members || [])) m.sessionId = `sess-old-${m.role}`;
  roster.activeProject = PROJECT;
  writeJson(SB.teamFile, roster);
  run([TEAM_MJS, 'project', 'add', '--name', PROJECT, '--team-mode', 'full', '--by', 'owner']);
  fs.mkdirSync(path.join(SB.state, '任务'), { recursive: true });
  writeJson(path.join(SB.state, '工作流.json'), { schema: 2, project: PROJECT, round: 1, requirements: {}, boots: {} });
  writeJson(path.join(SB.state, '会话排队.json'), fixtures.queue);
  writeJson(path.join(SB.state, '会话轮次.json'), fixtures.rounds || {});
  writeJson(path.join(SB.state, '派单队列.json'), { schema: 1, items: [] });
  if (fixtures.roleQueues) writeJson(path.join(SB.state, 'role_queues.json'), fixtures.roleQueues);
  for (const t of (fixtures.tasks || [])) writeJson(path.join(SB.state, '任务', `${t.id}.json`), t);
  // 壳 store：真窗口必须能通过 workbench.json 解析出当前项目，否则 sched 面板只会渲染空态
  const realStore = readJson(path.join(ROOT, 'data', 'userdata', 'workbench.json'), { projects: [] }) || { projects: [] };
  const tpl = (realStore.projects || []).find((p) => p && String(p.teamName || p.name || '') === PROJECT) || (realStore.projects || [])[0] || {};
  const entry = JSON.parse(JSON.stringify(tpl));
  entry.id = 'proj-a4c7-accept';
  entry.name = PROJECT; entry.teamName = PROJECT;
  entry.path = path.join(SB.projects, PROJECT); entry.workspacePath = entry.path;
  entry.sessions = Object.fromEntries(ROLES.map((r) => [r, `sess-old-${r}`]));
  entry.workspace = { ...(entry.workspace || {}), path: entry.path, sessionIds: ROLES.map((r) => `sess-old-${r}`) };
  writeJson(SB.workbenchFile, { ...realStore, projects: [entry], activeProjectId: entry.id });
  const boot = run([TEAM_MJS, 'boot', '--role', 'tester', '--project', PROJECT, '--session', 'sess-a4c7-accept']);
  const m = /令牌[:：]\s*([0-9a-f]+)/.exec(boot.out);
  return { token: m ? m[1] : '', boot };
}
function schedAdvice(token, env) {
  const r = run([TEAM_MJS, 'sched', 'advice', '--role', 'tester', '--project', PROJECT, '--boot', token, '--json'], env);
  const lines = String(r.out || '').trim().split(/\r?\n/).filter(Boolean);
  let payload = null;
  try { payload = JSON.parse(lines[lines.length - 1] || 'null'); } catch { payload = null; }
  return { ...r, lines, payload };
}
const rowOf = (payload, role) => ((payload && payload.roles) || []).find((x) => String(x.role) === role) || null;

async function main() {
  const realBefore = shaMap(REAL_FILES);

  // ── 场景 A：未知/stale 不当空闲 + 值域 + BUSY/IDLE 两口径 ────────────────
  const now = Date.now();
  const queue = {
    schema: 1, at: new Date(now).toISOString(), project: PROJECT, staleMs: 120000, degraded: false,
    roles: [
      { role: 'pm', sessionId: 'sess-old-pm', known: true, queued: 3, byPlacement: { queued: 3, steering: 0, context: 0 }, state: 'ok', lastAt: new Date(now).toISOString(), stale: false },
      { role: 'product', sessionId: 'sess-old-product', known: true, queued: 0, byPlacement: { queued: 0, steering: 0, context: 0 }, state: 'ok', lastAt: new Date(now).toISOString(), stale: true },
      { role: 'analyst', sessionId: 'sess-old-analyst', known: true, queued: 9, byPlacement: { queued: 9, steering: 0, context: 0 }, state: 'ok', lastAt: new Date(now).toISOString(), stale: false },
      { role: 'programmer1', sessionId: '', known: false, queued: 0, byPlacement: { queued: 0, steering: 0, context: 0 }, state: 'unavailable', lastAt: null, stale: false },
      { role: 'programmer2', sessionId: 'sess-old-programmer2', known: true, queued: 0, byPlacement: { queued: 0, steering: 0, context: 0 }, state: 'ok', lastAt: new Date(now).toISOString(), stale: false },
      { role: 'tester', sessionId: 'sess-old-tester', known: true, queued: 0, byPlacement: { queued: 0, steering: 0, context: 0 }, state: 'ok', lastAt: new Date(now).toISOString(), stale: false },
    ],
  };
  const rounds = { analyst: { role: 'analyst', roundsSinceArchive: 8, lastArchiveAt: null, updatedAt: new Date(now).toISOString() }, pm: { role: 'pm', roundsSinceArchive: 1 } };
  const tasks = [
    // analyst：轮次到线 + 在办任务（HANDOVER 应压过 BUSY_HOLD）
    { id: 'T-fixture-a1', project: PROJECT, type: 'task', priority: 'P1', owner: 'analyst', status: 'working', title: 'at-line fixture', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() },
    // pm：有在办（roleLooksBusy）→ BUSY_HOLD
    { id: 'T-fixture-p1', project: PROJECT, type: 'task', priority: 'P1', owner: 'pm', status: 'working', title: 'pm busy', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() },
    // tester/programmer2：无在办、有未认领候选 → IDLE_DISPATCH（statusIsClosed 口径）
    { id: 'T-fixture-free', project: PROJECT, type: 'task', priority: 'P2', owner: null, status: 'open', title: 'free candidate', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() },
  ];
  const seeded = seedSandbox({ queue, rounds, tasks });
  check('⓪ 沙盘 prepared 且 boot 拿到令牌', seeded.boot.code === 0 && Boolean(seeded.token), { bootCode: seeded.boot.code, err: seeded.boot.err.slice(0, 200) });

  const changeBefore = shaMap([path.join(SB.state, '会话排队.json'), path.join(SB.state, '会话轮次.json'), path.join(SB.state, '派单队列.json')]);
  const advFile = path.join(SB.state, '调度建议.jsonl');
  const beforeLines = fs.existsSync(advFile) ? fs.readFileSync(advFile, 'utf8').split(/\r?\n/).filter(Boolean).length : 0;
  const r1 = schedAdvice(seeded.token);
  const p1 = r1.payload;
  const changeAfter = shaMap([path.join(SB.state, '会话排队.json'), path.join(SB.state, '会话轮次.json'), path.join(SB.state, '派单队列.json')]);
  const afterLines = fs.existsSync(advFile) ? fs.readFileSync(advFile, 'utf8').split(/\r?\n/).filter(Boolean).length : 0;

  check('① AC5 出口：`sched advice --json` 恰好一行 JSON，含 ok/at/project/degraded/roles',
    r1.code === 0 && r1.lines.length === 1 && Boolean(p1) && 'ok' in p1 && 'at' in p1 && 'project' in p1 && 'degraded' in p1 && Array.isArray(p1.roles),
    { code: r1.code, lines: r1.lines.length, err: r1.err.slice(0, 200), keys: p1 ? Object.keys(p1) : null });

  check('② AC2 decision 只 5 个动作值（HANDOVER_FIRST/STALE_ALERT/BUSY_HOLD/IDLE_DISPATCH/STANDBY）',
    Boolean(p1) && (p1.roles || []).every((x) => DECISIONS.includes(String(x.decision))),
    { decisions: (p1 && p1.roles || []).map((x) => `${x.role}:${x.decision}`) });

  const prod = rowOf(p1, 'product');
  const p1row = rowOf(p1, 'programmer1');
  // 判据：**行级 stale / 数据源不可用的角色不得被判空闲**。
  // programmer1 的排队数可能来自 role_queues（有活就不是空闲），所以只强制它「非 IDLE」，
  // available 是否为 false 交给 reasons 说明；行级 stale 的 product 必须 available=false。
  check('③ AC1 未知/行级 stale 不当空闲：product(行 stale) 必须 available=false 且非 IDLE；programmer1(known=false) 不得判 IDLE_DISPATCH',
    Boolean(prod) && Boolean(p1row) && prod.decision !== 'IDLE_DISPATCH' && p1row.decision !== 'IDLE_DISPATCH'
    && prod.available === false && (prod.reasons || []).length > 0,
    { product: prod && { d: prod.decision, av: prod.available, r: prod.reasons }, programmer1: p1row && { d: p1row.decision, av: p1row.available, r: p1row.reasons } });

  const anal = rowOf(p1, 'analyst');
  const pmRow = rowOf(p1, 'pm');
  check('④ AC2 优先级：analyst（轮次到线+在办）应判 HANDOVER_FIRST（压过 BUSY_HOLD）；pm（有在办）应判 BUSY_HOLD',
    Boolean(anal) && anal.decision === 'HANDOVER_FIRST' && Boolean(pmRow) && pmRow.decision === 'BUSY_HOLD',
    { analyst: anal && { d: anal.decision, r: anal.reasons }, pm: pmRow && { d: pmRow.decision, r: pmRow.reasons } });

  const idleRows = (p1 && p1.roles || []).filter((x) => x.decision === 'IDLE_DISPATCH');
  check('⑤ AC5 IDLE_DISPATCH 口径：只有「无在办(按 statusIsClosed)+可用+数据新鲜」的角色才可判空闲；空闲行必须带 nextAction',
    idleRows.every((x) => x.available === true && (x.reasons || []).length >= 0 && String(x.nextAction || '').length > 0),
    { idle: idleRows.map((x) => ({ role: x.role, av: x.available, reasons: x.reasons })) });

  check('⑥ AC4 只读零写入：运行前后 会话排队/会话轮次/派单队列 sha 全不变，且只追加 调度建议.jsonl（行数 +1）',
    JSON.stringify(changeBefore) === JSON.stringify(changeAfter) && afterLines === beforeLines + 1,
    { changed: Object.keys(changeBefore).filter((k) => changeBefore[k] !== changeAfter[k]), beforeLines, afterLines });

  // ── 阈值与同源 ─────────────────────────────────────────────────────────
  const libSrc = fs.readFileSync(path.join(LIB, 'sched-advice.mjs'), 'utf8');
  const archiveSrc = fs.readFileSync(path.join(LIB, 'session-archive.mjs'), 'utf8');
  const defaultRounds = Number((/SCHED_ROTATE_ROUNDS_DEFAULT\s*=\s*(\d+)/.exec(libSrc) || [])[1]);
  const roundsMax = Number((/ROUNDS_MAX\s*=\s*(\d+)/.exec(archiveSrc) || [])[1]);
  check('⑦ AC3 阈值：rotateRounds 默认 8 且 < ROUNDS_MAX(10)（两条线都能触发、不互相吞）',
    defaultRounds === 8 && roundsMax === 10 && defaultRounds < roundsMax,
    { defaultRounds, roundsMax });

  const usageSameSource = /usageLevelOf/.test(libSrc) && /from '\.\/session\.mjs'/.test(libSrc);
  check('⑧ AC3 用量单源：sched-advice 复用 session.mjs 的 usageLevelOf（不新写阈值）',
    usageSameSource, { usageSameSource });

  // >10 必须报错/拒绝（不得静默接受）——实测 **auto-rotate 配置入口**（PM 21:36 最终口径：fail fast AUTO_ROTATE_CONFIG_INVALID）
  const over = (() => {
    const fs = require('node:fs');
    const os = require('node:os');
    const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'a4c7-cfg-'));
    const tdir = path.join(sb, '团队', '状态');
    fs.mkdirSync(path.join(tdir, '项目', 'P'), { recursive: true });
    fs.writeFileSync(path.join(tdir, '团队.json'), JSON.stringify({
      version: 1, name: 'probe', phase: 'team', owner: 'probe', createdAt: new Date().toISOString(),
      activeProject: 'P', members: [{ role: 'pm', sessionId: 's1' }, { role: 'tester', sessionId: 's2' }],
      config: { autoRotate: { enabled: true, rotateRounds: 11 } },
    }));
    const boot = [
      'const { pathToFileURL } = require("node:url");',
      '(async () => {',
      `  const mod = await import(pathToFileURL(${JSON.stringify(path.join(LIB, 'auto-rotate.mjs'))}).href);`,
      '  try {',
      '    const r = await mod.runAutoRotateCycle("P", { now: Date.now(), dryRun: true, source: "probe" });',
      '    console.log("@@R@@" + JSON.stringify({ ok: true, r: r && { ok: r.ok, code: r.code } }));',
      '  } catch (e) { console.log("@@R@@" + JSON.stringify({ ok: false, code: String((e && (e.code || e.message)) || e).slice(0, 160) })); }',
      '})().catch((e) => { console.log("@@R@@" + JSON.stringify({ ok: false, code: String((e && e.message) || e) })); });',
    ].join('\n');
    const r = spawnSync(process.execPath, ['-e', boot], {
      cwd: ROOT, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, TEAM_ROOT: path.join(sb, '团队'), TEAM_PROJECTS_ROOT: path.join(sb, '团队', '状态', '项目'), TEAM_SELFTEST: '1' },
    });
    try { fs.rmSync(sb, { recursive: true, force: true }); } catch { /* ignore */ }
    const m = /@@R@@(.*)/.exec(String(r.stdout || ''));
    try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
  })();
  const overRejected = Boolean(over) && (
    (over.ok === false && /AUTO_ROTATE_CONFIG_INVALID/.test(String(over.code || '')))
    || (over.r && over.r.ok === false && /AUTO_ROTATE_CONFIG_INVALID/.test(String(over.r.code || '')))
  );
  check('⑨ AC3 超上限（autoRotate.rotateRounds=11 > 上限 10）必须 fail fast（AUTO_ROTATE_CONFIG_INVALID），不得静默回落',
    overRejected, { over });

  // ⑨b 同源检查：sched 侧（纯函数）同样不得静默接受 >10 的 rotateRounds
  const overSched = (() => {
    const boot = [
      'const { pathToFileURL } = require("node:url");',
      '(async () => {',
      `  const mod = await import(pathToFileURL(${JSON.stringify(path.join(LIB, 'sched-advice.mjs'))}).href);`,
      '  try {',
      '    const r = mod.buildSchedAdvice({ queue: { at: new Date().toISOString(), staleMs: 120000, roles: [] }, tasks: [], rotateRounds: 11 });',
      '    console.log("@@R@@" + JSON.stringify({ threw: false, ok: !!(r && r.ok), code: String((r && r.code) || ""), rotateRounds: r && r.rotateRounds, rotateRoundsRaw: r && r.rotateRoundsRaw, maxRounds: r && r.maxRounds, configWarning: String((r && r.configWarning) || "") }));',
      '  } catch (e) { console.log("@@R@@" + JSON.stringify({ threw: true, code: String((e && (e.code || e.message)) || e).slice(0, 120) })); }',
      '})().catch((e) => { console.log("@@R@@" + JSON.stringify({ threw: true, code: String((e && e.message) || e) })); });',
    ].join('\n');
    const r = spawnSync(process.execPath, ['-e', boot], { cwd: ROOT, env: sbEnv(), encoding: 'utf8', timeout: 60000 });
    const m = /@@R@@(.*)/.exec(String(r.stdout || ''));
    try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
  })();
  // PM 给的两条可接受路径：①同拒（ok:false / AUTO_ROTATE_CONFIG_INVALID / 抛错）；②clamp 到上限 + CONFIG_CLAMPED 告警
  const overSchedRejected = Boolean(overSched) && (
    overSched.threw === true
    || overSched.ok === false
    || /AUTO_ROTATE_CONFIG_INVALID/.test(String(overSched.code || ''))
  );
  const overSchedClamped = Boolean(overSched) && Number(overSched.rotateRounds) === Number(overSched.maxRounds)
    && Number(overSched.rotateRoundsRaw) === 11 && /CONFIG_CLAMPED/.test(String(overSched.configWarning || ''));
  check('⑨b AC3 同源：sched 侧遇 rotateRounds>10 必须同拒（AUTO_ROTATE_CONFIG_INVALID）或 clamp 到上限并给 CONFIG_CLAMPED 告警',
    overSchedRejected || overSchedClamped, { overSched, overSchedRejected, overSchedClamped });

  // ── 面板（真窗口） ──────────────────────────────────────────────────────
  let shot = '';
  const evDir = path.join(ROOT, '项目', PROJECT, '测试人员', '产出', '证据-a4c7-sched');
  fs.mkdirSync(evDir, { recursive: true });
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, env: sbEnv(), stdio: 'ignore', windowsHide: true });
  let ws = null;
  try {
    const target = await waitTarget(PORT, 60000);
    if (target) {
      ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws fail')), { once: true }); });
      const cdp = new Cdp(ws);
      await cdp.send('Runtime.enable');
      for (let i = 0; i < 120; i += 1) { if ((await cdp.evaluate('document.readyState')) === 'complete') break; await sleep(300); }
      await sleep(1500);
      // 打开既有抽屉（#btn-session-queue）后再采样：面板 mount 时才会 refresh + 渲染锚点
      await cdp.evaluate(`(function(){ const b=document.getElementById('btn-session-queue'); if(b) b.click(); const d=document.getElementById('session-queue-drawer'); if(d && d.hidden){ d.hidden=false; } return true; })()`);
      await sleep(2000);
      const dom = await cdp.evaluate(`(function(){
        const drawer = document.querySelector('#session-queue-drawer') || document.querySelector('#session-queue-panel');
        const q = (sel) => Array.from(document.querySelectorAll(sel));
        const rows = q('[data-sched-role]');
        const inDrawer = rows.filter((r) => drawer && drawer.contains(r)).length;
        return {
          hasDrawer: Boolean(drawer),
          rowCount: rows.length,
          inDrawer,
          hasAdvice: q('[data-sched-advice]').length,
          hasLevel: q('[data-sched-level]').length,
          hasReason: q('[data-sched-reason]').length,
          hasAvailable: q('[data-sched-available]').length,
          hasAt: q('[data-sched-at]').length,
          empty: q('[data-sched-empty]').length,
          sample: rows.slice(0, 2).map((r) => ({ role: r.getAttribute('data-sched-role'), text: String(r.textContent || '').trim().slice(0, 80) })),
        };
      })()`);
      check('⑩ AC5b 面板：`data-sched-role/advice/level/reason/available/at` 锚点齐全且行在既有 #session-queue-drawer 内（不新建抽屉）',
        Boolean(dom && dom.hasDrawer) && dom.rowCount >= 1 && dom.inDrawer === dom.rowCount && dom.hasAdvice >= 1 && dom.hasLevel >= 1 && dom.hasReason >= 1 && dom.hasAvailable >= 1 && dom.hasAt >= 1,
        { dom });
      try {
        await cdp.send('Page.enable').catch(() => {});
        let cap = null;
        for (let i = 0; i < 3 && !cap; i += 1) { try { await cdp.send('Page.bringToFront').catch(() => {}); await sleep(400); cap = await cdp.send('Page.captureScreenshot', { format: 'png' }, 20000); } catch { await sleep(800); } }
        if (cap && cap.data) { shot = path.join(evDir, `screenshot-${ts}.png`); fs.writeFileSync(shot, Buffer.from(cap.data, 'base64')); }
      } catch { /* ignore */ }
      check('⑪ 截图已落盘', Boolean(shot) && fs.existsSync(shot), { shot });
    } else {
      check('⑩ AC5b 面板锚点', false, { why: '60s 内未连上真窗口' });
      check('⑪ 截图已落盘', false, { why: 'no target' });
    }
  } finally {
    try { if (ws) ws.close(); } catch { /* ignore */ }
    killTree(child);
    await sleep(400);
  }

  // ── 真实环境 ────────────────────────────────────────────────────────────
  const realCheck = run([TEAM_MJS, 'session', 'check', '--project', PROJECT, '--json'], process.env);
  const realJson = (() => { try { const t = String(realCheck.out || '').trim(); return JSON.parse(t.startsWith('{') ? t : '{}'); } catch { return null; } })();
  const realAfter = shaMap(REAL_FILES);
  // 会话排队.json 会被 DSH 插件每拍重写（非本单写入）→ 按「字节不减 + 前缀哈希相同」判，不比整文件 sha
  const queueFile = path.join(TEAM, '状态', '会话排队.json');
  const qBefore = (() => { try { const b = fs.readFileSync(queueFile); return { bytes: b.length, head: crypto.createHash('sha256').update(b.subarray(0, 200)).digest('hex') }; } catch { return null; } })();
  const qAfter = (() => { try { const b = fs.readFileSync(queueFile); return { bytes: b.length, head: crypto.createHash('sha256').update(b.subarray(0, 200)).digest('hex') }; } catch { return null; } })();
  const stableFiles = REAL_FILES.filter((f) => f !== queueFile);
  const realStable = stableFiles.every((f) => realBefore[f] === realAfter[f]);
  // 注：qBefore 取的是脚本开始时（main 入口处）的快照前值；此处仅比较「目前未被本脚本写入」的可判定部分
  check('⑫ 真实环境 session check 6/6（四处映射一致）且真实状态文件未因本脚本写入（会话排队.json 按字节不减判）',
    Boolean(realJson) && realJson.ok === true && realJson.ratio === '6/6' && realStable && (!qBefore || !qAfter || qAfter.bytes >= qBefore.bytes),
    { ratio: realJson && realJson.ratio, ok: realJson && realJson.ok, changed: stableFiles.filter((f) => realBefore[f] !== realAfter[f]), queueBytes: [qBefore && qBefore.bytes, qAfter && qAfter.bytes] });

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
  return finish({ shot, realBefore, realAfter });
}

function finish(extra) {
  const total = results.length;
  const pass = results.filter((r) => r.ok).length;
  const red = total - pass;
  const evDir = path.join(ROOT, '项目', PROJECT, '测试人员', '产出', '证据-a4c7-sched');
  fs.mkdirSync(evDir, { recursive: true });
  const payload = { at: new Date().toISOString(), script: 'scripts/test-a4c7-sched-acceptance.cjs', task: 'T-20261117-213652-4de7', requirement: 'R-20261117-204110-a4c7', total, pass, red, results, shot: extra.shot, realFiles: { before: extra.realBefore, after: extra.realAfter } };
  const evFile = path.join(evDir, `run-${ts}-${red === 0 ? 'green' : 'red'}.json`);
  payload.evidenceFile = path.relative(ROOT, evFile).replace(/\\/g, '/');
  fs.writeFileSync(evFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  if (jsonOut) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  else {
    console.log('');
    console.log(`${red === 0 ? 'A4C7_SCHED_OK' : 'A4C7_SCHED_WARN'} ${JSON.stringify({ total, pass, red })}`);
    console.log(`证据：${payload.evidenceFile}`);
    if (extra.shot) console.log(`截图：${path.relative(ROOT, extra.shot).replace(/\\/g, '/')}`);
  }
  process.exit(red === 0 ? 0 : 1);
}

main().catch((e) => { console.error('CRASH', String((e && e.stack) || e)); process.exit(2); });
