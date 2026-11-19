#!/usr/bin/env node
'use strict';
/**
 * test-0d97-ledger-noise.cjs —— R-20261119-155015-0d97（台账信噪比治理）夹具
 *
 * 覆盖 AC1–AC7（AC8 由本脚本 + selftest + 隔离断言承担）：
 *   AC1 默认只列在办（120 accepted + 120 cancelled + 120 done + 2 open + 1 working → 3 行；待验收(done): 120；提示行要素）
 *   AC2 --all 全量（363 行无提示）、--all --limit 60（60 行 + 提示）
 *   AC3 上限 50（120 open → 50 行 + 提示；--limit 120 → 120 行无提示；非法 --limit → BAD_LIMIT 且零副作用）
 *   AC4 req/inbox 同上限 + hidden 分面（inbox 默认 hidden=cur 数、--all 无提示、--all --limit 50）
 *   AC5 简报与台账同口径 + 三条静态断言（全仓「默认隐藏 」命中文件恰好 1 个且在 helper；ops.mjs 0；task list 分支 import statusIsClosed 无硬编码数组）
 *   AC6 显式过滤不被吃掉（--status accepted / --all / --cancelled / --owner programmer1：过滤后 62 条 → 输出 50 行）
 *   AC7 待验收三态 + scope（analyst=3 / product=1；无 done 两处都不出）
 *
 * 隔离：TEAM_ROOT / TEAM_PROJECTS_ROOT / TEAM_WORKBENCH_JSON / AWB_DATA_DIR 全指临时沙盘 + TEAM_SELFTEST=1。
 * 用法：node scripts/test-0d97-ledger-noise.cjs [--json]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const JSON_OUT = process.argv.includes('--json');
const PROJECT = '0d97-台账沙盘';

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const shaDir = (dir) => {
  try {
    const parts = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else parts.push(`${path.relative(dir, p)}:${sha(p)}`);
      }
    };
    walk(dir);
    return crypto.createHash('sha256').update(parts.sort().join('|')).digest('hex');
  } catch { return '(missing)'; }
};
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), '0d97-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench-0d97.json');
const DATA = path.join(SB, 'data');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const TASK_DIR = path.join(STATE, '任务');
const MAIL = path.join(TEAM, '状态', '邮箱');
const REAL_TEAM_FILE = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');

function env(extra = {}) {
  const { DSH_SESSION_ID, ...base0 } = process.env;
  return {
    ...base0,
    TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: PROJECTS,
    TEAM_WORKBENCH_JSON: STORE,
    AWB_DATA_DIR: DATA,
    AWB_STORE: STORE,
    TEAM_SELFTEST: '1',
    ...extra,
  };
}
function run(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(extraEnv), timeout: 180000, cwd: SB, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status == null ? 1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function runJson(args, extraEnv = {}) {
  const r = run(args, extraEnv);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}
/** 人类文本 + --json 同源：文本断言用返回体，字段断言用 `.json`（一次跑两条命令） */
function runBoth(args, extraEnv = {}) {
  const textRun = run(args, extraEnv);
  const jsonRun = runJson([...args, '--json'], extraEnv);
  return { ...textRun, json: jsonRun.json || null };
}
const text = (r) => `${r.out || ''}${r.err || ''}`;
const tokenOf = (r) => {
  const direct = String((r.json && r.json.token) || '');
  if (direct) return direct;
  const m = /令牌[:：]\s*([0-9a-f]{8,})/i.exec(String(r.out || ''));
  return m ? m[1] : '';
};
/** 人类文本里「表体行数」：任务/需求行以 P0-P3 开头；收件箱行以 HH:MM:SS 开头 */
const bodyLines = (r) => String(r.out || '').split(/\r?\n/).filter((l) => /^P[0-3]\s+/.test(l) || /^\d{2}:\d{2}:\d{2}\s/.test(l));
const hasNotice = (r) => /…（共 \d+ 条/.test(String(r.out || ''));

function seedTask(id, over = {}) {
  const row = {
    id, project: PROJECT, title: `seed ${id}`, detail: '', priority: 'P2', status: 'open',
    type: /^R-/.test(id) ? 'requirement' : 'task', owner: '', createdBy: 'pm',
    createdAt: '2026-11-19T00:00:00.000Z', claimedAt: null, updatedAt: '2026-11-19T00:00:00.000Z',
    history: [], ...over,
  };
  writeJson(path.join(TASK_DIR, `${id}.json`), row);
  return row;
}
function clearTasks() { try { fs.rmSync(TASK_DIR, { recursive: true, force: true }); } catch { /* ignore */ } fs.mkdirSync(TASK_DIR, { recursive: true }); }
function clearMail(role) { try { fs.rmSync(path.join(MAIL, role), { recursive: true, force: true }); } catch { /* ignore */ } }
function seedMail(role, box, n, prefix) {
  const dir = path.join(MAIL, role, box);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i += 1) {
    const id = `M-${prefix}-${String(i).padStart(3, '0')}`;
    writeJson(path.join(dir, `${id}.json`), {
      id, project: PROJECT, from: 'pm', to: role, type: 'notice', subject: `seed ${id}`, body: 'x',
      at: '2026-11-19T00:00:00.000Z', ts: `2026-11-19T00:00:${String(i % 60).padStart(2, '0')}.000Z`, box,
    });
  }
}

const realBefore = { team: sha(REAL_TEAM_FILE), store: sha(REAL_STORE) };
let exitCode = 0;
try {
  if (!fs.existsSync(TOOL)) { console.error('环境错误：找不到 team.mjs'); process.exit(2); }
  check('S0 沙盘 init', run(['init']).code === 0, {});
  check('S1 沙盘建项目', run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).code === 0, {});
  const projMeta = readJson(path.join(STATE, '项目.json'), {});
  const projectDir = String(projMeta.path || path.join(PROJECTS, PROJECT));
  const ALL_ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
  const team = readJson(path.join(TEAM, '状态', '团队.json'), { members: [] });
  team.activeProject = PROJECT;
  team.members = Array.isArray(team.members) ? team.members : [];
  for (const role of ALL_ROLES) {
    // team.mjs init 默认只有 pm/programmer1：六角色必须显式补齐（否则 boot 报 NO_MEMBER）
    let m = team.members.find((x) => x && String(x.role || '') === role);
    if (!m) { m = { role, name: role, title: `团队·${role}`, status: 'active', joinedAt: '2026-11-19T00:00:00.000Z', history: [] }; team.members.push(m); }
    m.status = 'active';
    m.sessionId = `session-0d97-${role}`;
  }
  writeJson(path.join(TEAM, '状态', '团队.json'), team);
  writeJson(path.join(projectDir, '团队会话.json'), {
    project: PROJECT, teamMode: 'full', workspace: projectDir,
    roles: ALL_ROLES.map((role) => ({ role, sessionId: `session-0d97-${role}` })),
  });
  writeJson(STORE, {
    projects: [{
      id: '0d97-p1', name: PROJECT, teamName: PROJECT, path: projectDir,
      sessions: Object.fromEntries(ALL_ROLES.map((role) => [role, `session-0d97-${role}`])),
      workspace: { path: projectDir, sessionIds: ALL_ROLES.map((role) => `session-0d97-${role}`) },
    }],
    activeProjectId: '0d97-p1',
  });

  const pmBoot = runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-0d97-pm', '--json']);
  const analystBoot = runJson(['boot', '--role', 'analyst', '--project', PROJECT, '--session', 'session-0d97-analyst', '--json']);
  const productBoot = runJson(['boot', '--role', 'product', '--project', PROJECT, '--session', 'session-0d97-product', '--json']);
  const pmTok = tokenOf(pmBoot);
  const analystTok = tokenOf(analystBoot);
  const productTok = tokenOf(productBoot);
  check('S2 沙盘 pm/analyst/product boot 成功', Boolean(pmTok && analystTok && productTok), {
    pm: { code: pmBoot.code, out: text(pmBoot).slice(-300) },
    analyst: { code: analystBoot.code, out: text(analystBoot).slice(-300) },
    product: { code: productBoot.code, out: text(productBoot).slice(-300) },
  });

  // ── AC1 + AC5：seed 120 accepted + 120 cancelled + 120 done + 2 open + 1 working ──
  clearTasks();
  for (let i = 0; i < 120; i += 1) seedTask(`T-accepted-${String(i).padStart(3, '0')}`, { status: 'accepted', owner: 'programmer2' });
  for (let i = 0; i < 120; i += 1) seedTask(`T-cancelled-${String(i).padStart(3, '0')}`, { status: 'cancelled', owner: 'programmer2' });
  for (let i = 0; i < 120; i += 1) seedTask(`T-done-${String(i).padStart(3, '0')}`, { status: 'done', owner: 'programmer1' });
  seedTask('T-open-001', { status: 'open', owner: 'programmer1' });
  seedTask('T-open-002', { status: 'open', owner: 'programmer1' });
  seedTask('T-working-001', { status: 'working', owner: 'programmer1', claimedAt: '2026-11-19T00:05:00.000Z' });

  const ac1 = run(['task', 'list', '--boot', pmTok]);
  check('AC1① 默认表体 = 3 行', bodyLines(ac1).length === 3, { rows: bodyLines(ac1).length, out: String(ac1.out).slice(0, 400) });
  check('AC1② 头部含「任务（<项目>，3）」', String(ac1.out).includes(`任务（${PROJECT}，3）`), { head: String(ac1.out).split(/\r?\n/)[0] });
  check('AC1③ 不含历史 id（accepted/cancelled/done）', !/T-accepted|T-cancelled|T-done/.test(String(ac1.out)), {});
  check('AC1④ 含「待验收(done): 120」', String(ac1.out).includes('待验收(done): 120'), {});
  check('AC1⑤ 提示行含 共 363 / 默认隐藏 360（父括号）/ 已显示前 3 / --all / --limit',
    /共 363 条/.test(String(ac1.out)) && /默认隐藏 360 条（done\/accepted\/cancelled\/terminated）/.test(String(ac1.out))
    && /已显示前 3 条/.test(String(ac1.out)) && /--all/.test(String(ac1.out)) && /--limit/.test(String(ac1.out)),
    { tail: String(ac1.out).split(/\r?\n/).slice(-1)[0] });

  // ── AC5③ 静态三条 ──────────────────────────────────────────────────
  const scanFiles = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['_tmp', '备份', '归档'].includes(e.name)) walk(p); }
      else if (e.name.endsWith('.mjs')) scanFiles.push(p);
    }
  })(path.join(ROOT, '团队', '工具'));
  const hiddenHits = scanFiles.filter((f) => fs.readFileSync(f, 'utf8').includes('默认隐藏 '));
  const hitRel = hiddenHits.map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
  check('AC5③i 全仓「默认隐藏 」命中文件恰好 1 个且在 helper（gates.mjs）',
    hiddenHits.length === 1 && hitRel[0].endsWith('lib/gates.mjs'), { hits: hitRel });
  check('AC5③ii ops.mjs 命中 0', !hitRel.some((x) => x.endsWith('lib/ops.mjs')), { hits: hitRel });
  const opsSrc = fs.readFileSync(path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs'), 'utf8');
  // 精确定位 task list 分支：以 helper 调用点为中心取上下文（首个 `if (sub === 'list')` 是 project list，不可用）
  const tlMarker = opsSrc.indexOf('applyListView({ rows: visible');
  const taskListBlock = tlMarker >= 0 ? opsSrc.slice(Math.max(0, tlMarker - 3000), tlMarker + 500) : '';
  check('AC5③iii task list 分支用 statusIsClosed 且无硬编码状态数组',
    Boolean(taskListBlock) && /statusIsClosed\(/.test(taskListBlock) && !/\['done',\s*'accepted'/.test(taskListBlock),
    { found: Boolean(taskListBlock), hasStatusIsClosed: /statusIsClosed\(/.test(taskListBlock) });

  // ── AC2 --all ─────────────────────────────────────────────────────
  const ac2a = run(['task', 'list', '--boot', pmTok, '--all']);
  check('AC2① --all 表体 = 363 行且无提示行', bodyLines(ac2a).length === 363 && !hasNotice(ac2a), { rows: bodyLines(ac2a).length, notice: hasNotice(ac2a) });
  const ac2b = run(['task', 'list', '--boot', pmTok, '--all', '--limit', '60']);
  check('AC2② --all --limit 60 = 60 行 + 提示含 共 363 / 已显示前 60',
    bodyLines(ac2b).length === 60 && /共 363 条/.test(String(ac2b.out)) && /已显示前 60 条/.test(String(ac2b.out)),
    { rows: bodyLines(ac2b).length, tail: String(ac2b.out).split(/\r?\n/).slice(-1)[0] });

  // ── AC3 上限 50 ───────────────────────────────────────────────────
  clearTasks();
  for (let i = 0; i < 120; i += 1) seedTask(`T-open2-${String(i).padStart(3, '0')}`, { status: 'open', owner: 'programmer1' });
  const ac3a = run(['task', 'list', '--boot', pmTok]);
  check('AC3① 120 open → 默认 50 行 + 提示 共 120 / 已显示前 50',
    bodyLines(ac3a).length === 50 && /共 120 条/.test(String(ac3a.out)) && /已显示前 50 条/.test(String(ac3a.out)),
    { rows: bodyLines(ac3a).length, tail: String(ac3a.out).split(/\r?\n/).slice(-1)[0] });
  const ac3b = run(['task', 'list', '--boot', pmTok, '--limit', '120']);
  check('AC3② --limit 120 = 120 行无提示', bodyLines(ac3b).length === 120 && !hasNotice(ac3b), { rows: bodyLines(ac3b).length });
  const tasksShaBefore = shaDir(TASK_DIR);
  const ac3c = run(['task', 'list', '--boot', pmTok, '--limit', '0']);
  const ac3d = run(['task', 'list', '--boot', pmTok, '--limit', 'abc']);
  check('AC3③ 非法 --limit → BAD_LIMIT 且任务目录 sha256 不变',
    /BAD_LIMIT/.test(text(ac3c)) && /BAD_LIMIT/.test(text(ac3d)) && shaDir(TASK_DIR) === tasksShaBefore,
    { c: String(ac3c.err || ac3c.out).slice(0, 200), d: String(ac3d.err || ac3d.out).slice(0, 200) });

  // ── AC4 req list / inbox ─────────────────────────────────────────
  clearTasks();
  for (let i = 0; i < 120; i += 1) seedTask(`R-0d97-req-${String(i).padStart(3, '0')}`, { type: 'requirement', status: 'open', owner: 'analyst' });
  const reqList = runBoth(['req', 'list', '--boot', pmTok]);
  check('AC4① req list = 50 行 + 提示 共 120 / 已显示前 50、无「默认隐藏」分句、无父括号、--json.hidden=0',
    bodyLines(reqList).length === 50 && /共 120 条/.test(String(reqList.out)) && /已显示前 50 条/.test(String(reqList.out))
    && !/默认隐藏/.test(String(reqList.out)) && !/（done\/accepted\/cancelled\/terminated）/.test(String(reqList.out))
    && Number((reqList.json || {}).hidden) === 0,
    { rows: bodyLines(reqList).length, tail: String(reqList.out).split(/\r?\n/).slice(-1)[0], hidden: (reqList.json || {}).hidden });

  clearMail('analyst');
  seedMail('analyst', 'new', 120, 'new');
  const inboxDefault = runBoth(['inbox', '--boot', analystTok]);
  check('AC4② 120 未读 → inbox 50 行 + 提示 共 120',
    bodyLines(inboxDefault).length === 50 && /共 120 条/.test(String(inboxDefault.out)) && /已显示前 50 条/.test(String(inboxDefault.out)),
    { rows: bodyLines(inboxDefault).length, tail: String(inboxDefault.out).split(/\r?\n/).slice(-1)[0] });

  clearMail('analyst');
  seedMail('analyst', 'new', 10, 'n2');
  seedMail('analyst', 'cur', 120, 'c2');
  const inboxAll = runBoth(['inbox', '--boot', analystTok, '--all']);
  check('AC4③ 10 未读 + 120 已读 → inbox --all = 130 行无提示',
    bodyLines(inboxAll).length === 130 && !hasNotice(inboxAll), { rows: bodyLines(inboxAll).length, notice: hasNotice(inboxAll) });
  const inboxAllLimit = runBoth(['inbox', '--boot', analystTok, '--all', '--limit', '50']);
  check('AC4④ inbox --all --limit 50 = 50 行 + 提示 共 130',
    bodyLines(inboxAllLimit).length === 50 && /共 130 条/.test(String(inboxAllLimit.out)),
    { rows: bodyLines(inboxAllLimit).length, tail: String(inboxAllLimit.out).split(/\r?\n/).slice(-1)[0] });
  const inboxDefault2 = runBoth(['inbox', '--boot', analystTok]);
  check('AC4⑤ 10 未读 + 120 已读 → inbox 默认 10 行且仍出提示（hidden=120 > 0）',
    bodyLines(inboxDefault2).length === 10 && hasNotice(inboxDefault2) && Number((inboxDefault2.json || {}).hidden) === 120,
    { rows: bodyLines(inboxDefault2).length, notice: hasNotice(inboxDefault2), hidden: (inboxDefault2.json || {}).hidden });

  // ── AC6 显式过滤 ─────────────────────────────────────────────────
  clearTasks();
  for (let i = 0; i < 60; i += 1) seedTask(`T-a6-acc-p1-${String(i).padStart(3, '0')}`, { status: 'accepted', owner: 'programmer1' });
  seedTask('T-a6-open-p1-1', { status: 'open', owner: 'programmer1' });
  seedTask('T-a6-open-p1-2', { status: 'open', owner: 'programmer1' });
  for (let i = 0; i < 60; i += 1) seedTask(`T-a6-acc-other-${String(i).padStart(3, '0')}`, { status: 'accepted', owner: 'programmer2' });
  seedTask('T-a6-open-other-1', { status: 'open', owner: 'programmer2' });
  for (let i = 0; i < 40; i += 1) seedTask(`T-a6-cancel-${String(i).padStart(3, '0')}`, { status: 'cancelled', owner: 'programmer2' });
  const ac6a = runBoth(['task', 'list', '--boot', pmTok, '--status', 'accepted']);
  check('AC6① --status accepted = 50 行 + 提示 共 120、--json.hidden=0',
    bodyLines(ac6a).length === 50 && /共 120 条/.test(String(ac6a.out)) && Number((ac6a.json || {}).hidden) === 0,
    { rows: bodyLines(ac6a).length, hidden: (ac6a.json || {}).hidden });
  const ac6b = run(['task', 'list', '--boot', pmTok, '--status', 'accepted', '--all']);
  check('AC6② --status accepted --all = 120 行', bodyLines(ac6b).length === 120, { rows: bodyLines(ac6b).length });
  const ac6c = run(['task', 'list', '--boot', pmTok, '--cancelled']);
  check('AC6③ --cancelled = 40 行', bodyLines(ac6c).length === 40, { rows: bodyLines(ac6c).length });
  const ac6d = runBoth(['task', 'list', '--boot', pmTok, '--owner', 'programmer1']);
  check('AC6④ --owner programmer1 → 过滤后 62 条、实际输出 50 行 + 提示 共 62 条',
    bodyLines(ac6d).length === 50 && /共 62 条/.test(String(ac6d.out)) && Number((ac6d.json || {}).total) === 62
    && ((ac6d.json || {}).tasks || []).every((t) => String(t.owner || '') === 'programmer1'),
    { rows: bodyLines(ac6d).length, total: (ac6d.json || {}).total, tail: String(ac6d.out).split(/\r?\n/).slice(-1)[0] });
  const ac6e = run(['task', 'list', '--boot', pmTok, '--owner', 'programmer1', '--all']);
  check('AC6④b --owner programmer1 --all = 62 行', bodyLines(ac6e).length === 62, { rows: bodyLines(ac6e).length });

  // ── AC7 待验收三态 + scope ────────────────────────────────────────
  clearTasks();
  for (let i = 0; i < 120; i += 1) seedTask(`T-a7-done-${String(i).padStart(3, '0')}`, { status: 'done', owner: 'programmer1' });
  const a7List = run(['task', 'list', '--boot', pmTok]);
  check('AC7① seed 120 done → task list 出现「待验收(done): 120」', /待验收\(done\): 120/.test(String(a7List.out)), { tail: String(a7List.out).slice(-200) });
  // AC7③ 精确 scope：5 条 done（2 analyst、2 programmer1、1 无主）
  clearTasks();
  seedTask('T-a7s-1', { status: 'done', owner: 'analyst' });
  seedTask('T-a7s-2', { status: 'done', owner: 'analyst' });
  seedTask('T-a7s-3', { status: 'done', owner: 'programmer1' });
  seedTask('T-a7s-4', { status: 'done', owner: 'programmer1' });
  seedTask('T-a7s-5', { status: 'done', owner: '' });
  const a7List2 = run(['task', 'list', '--boot', pmTok]);
  check('AC7③ task list（全项目）报 5', /待验收\(done\): 5/.test(String(a7List2.out)), { tail: String(a7List2.out).slice(-300) });
  const a7AnalystBoot = run(['boot', '--role', 'analyst', '--project', PROJECT, '--session', 'session-0d97-analyst']);
  const a7ProductBoot = run(['boot', '--role', 'product', '--project', PROJECT, '--session', 'session-0d97-product']);
  check('AC7③ analyst 简报报 3（本人 2 + 无主 1）', /待验收\(done\): 3/.test(String(a7AnalystBoot.out)), { tail: String(a7AnalystBoot.out).slice(-400) });
  check('AC7③ product 简报报 1（本人 0 + 无主 1）', /待验收\(done\): 1/.test(String(a7ProductBoot.out)), { tail: String(a7ProductBoot.out).slice(-400) });
  // AC7② 无 done → 两处都不出现
  clearTasks();
  seedTask('T-a7n-1', { status: 'open', owner: 'analyst' });
  const a7NoDoneList = run(['task', 'list', '--boot', pmTok]);
  const a7NoDoneBoot = run(['boot', '--role', 'analyst', '--project', PROJECT, '--session', 'session-0d97-analyst']);
  check('AC7② 无 done → task list 与简报都不出现「待验收(done)」',
    !/待验收\(done\)/.test(String(a7NoDoneList.out)) && !/待验收\(done\)/.test(String(a7NoDoneBoot.out)),
    { list: /待验收/.test(String(a7NoDoneList.out)), boot: /待验收/.test(String(a7NoDoneBoot.out)) });

  // ── AC5① 简报与台账同口径（同一谓词）─────────────────────────────
  clearTasks();
  for (let i = 0; i < 10; i += 1) seedTask(`T-a5c-${String(i).padStart(3, '0')}`, { status: 'accepted', owner: 'analyst' });
  seedTask('T-a5o-1', { status: 'open', owner: 'analyst' });
  seedTask('T-a5w-1', { status: 'working', owner: 'analyst', claimedAt: '2026-11-19T00:05:00.000Z' });
  const a5Boot = run(['boot', '--role', 'analyst', '--project', PROJECT, '--session', 'session-0d97-analyst']);
  const bootPending = Number((/(?:^|\n)待办任务: (\d+)/.exec(String(a5Boot.out)) || [])[1]);
  const a5List = runJson(['task', 'list', '--boot', analystTok, '--json']);
  check('AC5① 简报「待办任务: N」= 2（analyst 名下 open+working，闭环不计）且 task list 同谓词不列闭环',
    bootPending === 2 && Number((a5List.json || {}).hidden) === 10,
    { bootPending, bootCode: a5Boot.code, bootTail: String(a5Boot.out).slice(-400), listHidden: (a5List.json || {}).hidden });
  void productTok;
} catch (e) {
  check('夹具未抛异常', false, { error: String((e && e.stack) || e) });
} finally {
  const realAfter = { team: sha(REAL_TEAM_FILE), store: sha(REAL_STORE) };
  check('AC8③ 隔离：真实 团队.json / workbench.json 前后 sha256 不变',
    realAfter.team === realBefore.team && realAfter.store === realBefore.store,
    { team: [realBefore.team.slice(0, 12), realAfter.team.slice(0, 12)], store: [realBefore.store.slice(0, 12), realAfter.store.slice(0, 12)] });
  fs.rmSync(SB, { recursive: true, force: true });
  const failed = ROWS.filter((r) => r.ok !== true);
  if (!JSON_OUT) {
    console.log(`\n${ROWS.length - failed.length}/${ROWS.length} PASS${failed.length ? ` · ${failed.length} FAIL` : ''}`);
    if (failed.length) console.log('失败项：' + failed.map((r) => r.name).join(' | '));
  } else {
    console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed.length, failed: failed.map((r) => r.name), rows: ROWS }, null, 2));
  }
  if (failed.length) exitCode = 1;
}
process.exit(exitCode);
