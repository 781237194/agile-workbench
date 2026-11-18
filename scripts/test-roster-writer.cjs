#!/usr/bin/env node
'use strict';
/**
 * test-roster-writer.cjs —— B-20261118-083150-4b2f（fa0e 补丁 A：名册唯一写入口）回归夹具
 *
 * 依据：产品 产品/产出/评估复核-三需求联动-20261118.md §六 AC-W1～W8；任务单验收 W1～W7。
 *
 * 断言：
 *   W1 静态单写入口：团队/工具/**（排除 selftest）中 `members[].sessionId` 赋值与 `members.push(`
 *      只命中 lib/roster-writer.mjs；迁移脚本 migrate.mjs 走白名单并单独列清单（不接受布尔）。
 *   W2 写前校验：目标会话在 DSH 不存在 → SESSION_NOT_IN_DSH，名册 sha256 不变、会话轮换.jsonl 不增长。
 *   W3 记账+广播+BQ 两条路径同判：
 *       ① session rotate：会话轮换.jsonl 行含 from/to/mode/created/by/source + 会话轮换/<角色>.json
 *       ② auto-rotate（3594 后**只提醒不换人**）：不产生 rotate 行、名册不变、无新轮换记录/BQ/广播，
 *          只写 remind 行（HANDOVER_READY_REMIND_PM → 角色；REMIND_PM_MANUAL_ROTATE → PM）
 *       ③ session rotate 路径广播其余 active 成员重 boot（旧 session rotate 缺）
 *   W4 workbench 单写入口：auto-rotate.mjs 无 `fs.writeFileSync(wbFile`；roster-writer 用 updateJsonAtomic。
 *   W5 交接单一判据：TEAM_ROTATE_HANDOVER_TEXT 注入缺【在途任务】的交接 → session rotate 拒 HANDOVER_INCOMPLETE、
 *      auto-rotate（只提醒）判 HANDOVER_INCOMPLETE 且不判「交接就绪」、名册不变。
 *   W6 207b 不破：test-launch-reuse.cjs 12/12 + launch.mjs 三源复用逻辑零改动（静态）。
 *   W7 旧副本防御：`__AR_NEW_SESSION` 注入 / `session-auto-*` 目标 id → LEGACY_SESSION_ID_REFUSED、
 *      名册 sha256 不变、告警 PM；写后 60 秒兜底校验失败 → ROSTER_SESSION_MISSING 审计 + 告警 PM。
 *   W8 并发不丢更新：两进程同时「扩编 + 换人」→ 两处改动都在（withLock('_team')）。
 *
 * 隔离：TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_WORKBENCH_JSON + AWB_DATA_DIR + TEAM_SELFTEST=1（沙盘），
 *       断言真实 团队.json / workbench.json 前后 sha256 不变。
 * 用法：node scripts/test-roster-writer.cjs [--json]
 * 退出码：0 全过 / 1 有断言失败 / 2 环境错误
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');
const PROJECT = 'roster写者沙盘';
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const ROLE_DIRS = { pm: '项目经理', product: '产品', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' };
const SB = mkTempSandbox('roster-writer');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const DATA = path.join(SB, 'data');
const TEAM_TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const TEAM_FILE = path.join(TEAM, '状态', '团队.json');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const PROJECT_DIR = path.join(PROJECTS, PROJECT);
const MANIFEST = path.join(PROJECT_DIR, '团队会话.json');
const LEDGER = path.join(STATE, '会话轮换.jsonl');
const ROSTER_AUDIT = path.join(STATE, '名册变更.jsonl');
const POST_CHECK = path.join(STATE, '名册变更待校验.json');
const BOOT_QUEUE = path.join(STATE, '待启动队列.json');
const AR_SRC = path.join(ROOT, '团队', '工具', 'lib', 'auto-rotate.mjs');
const RW_SRC = path.join(ROOT, '团队', '工具', 'lib', 'roster-writer.mjs');
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
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean); } catch { return []; } };
const jsonlRows = (f) => readLines(f).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const mailOf = (role) => {
  const dir = path.join(TEAM, '状态', '邮箱', role, 'new');
  try { return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => readJson(path.join(dir, n), null)).filter(Boolean); } catch { return []; }
};
const rosterOf = (role) => String(((readJson(TEAM_FILE, { members: [] }).members || []).find((m) => m && m.role === role) || {}).sessionId || '');
const oldId = (role) => `session-st-old-${role}`;

function env(extra = {}) {
  return {
    ...process.env,
    TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: PROJECTS,
    TEAM_WORKBENCH_JSON: STORE,
    AWB_DATA_DIR: DATA,
    TEAM_SELFTEST: '1',
    TEAM_BOOT_ENFORCE: '',
    TEAM_ROSTER_DSH_ENFORCE: '',
    TEAM_ROTATE_HANDOVER_TEXT: '',
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
/** 跑一拍 auto-rotate（模块入口，与生产 route-daemon 同一函数）。 */
function cycle(nowMs, extraEnv = {}) {
  const boot = [
    'const { pathToFileURL } = require("node:url");',
    '(async () => {',
    `  const mod = await import(pathToFileURL(${JSON.stringify(AR_SRC)}).href);`,
    `  const r = await mod.runAutoRotateCycle(${JSON.stringify(PROJECT)}, { now: ${Number(nowMs)}, dryRun: false, source: "fixture" });`,
    '  console.log("@@AR@@" + JSON.stringify(r === undefined ? null : r));',
    '})().catch((e) => { console.log("@@AR@@" + JSON.stringify({ ok: false, code: "THROW", error: String((e && (e.message || e)) || e) })); });',
  ].join('\n');
  try {
    const out = execFileSync(process.execPath, ['-e', boot], { encoding: 'utf8', env: env(extraEnv), timeout: 120000, cwd: ROOT });
    const line = String(out).split(/\r?\n/).find((x) => x.includes('@@AR@@'));
    return { code: 0, payload: line ? JSON.parse(line.split('@@AR@@')[1]) : null, err: '' };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, payload: null, err: String(e.stderr || e.message || '') };
  }
}
/** 起一个 node -e 子进程（并发用）。 */
function spawnNode(script, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script], { cwd: ROOT, env: env(extraEnv), windowsHide: true });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out: String(out), err: String(err) }));
  });
}

/* ── 沙盘骨架 ─────────────────────────────────────────────────────────── */
fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
fs.mkdirSync(PROJECTS, { recursive: true });
const seedTeam = readJson(path.join(ROOT, '团队', '状态', '团队.json'), { members: [] });
seedTeam.activeProject = PROJECT;
for (const m of seedTeam.members || []) m.sessionId = '';
writeJson(TEAM_FILE, seedTeam);
for (const rel of ['团队宪法.md', '项目铁律.md']) {
  const src = path.join(ROOT, '团队', rel);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TEAM, rel));
}
if (fs.existsSync(path.join(ROOT, '团队', '协议'))) fs.cpSync(path.join(ROOT, '团队', '协议'), path.join(TEAM, '协议'), { recursive: true });

const realBefore = { team: sha(REAL_TEAM_FILE), workbench: sha(REAL_STORE) };

if (!fs.existsSync(TEAM_TOOL)) { console.error('环境错误：找不到 team.mjs'); process.exit(2); }
const setup = runJson(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
check('S0 沙盘项目登记', setup.code === 0, { code: setup.code, out: text(setup).slice(0, 300) });

const projectJson = readJson(path.join(STATE, '项目.json'), {});
const MODE_ROLES = Array.isArray(projectJson.roleIds) && projectJson.roleIds.length ? projectJson.roleIds : ROLES.slice();
const teamSeed = readJson(TEAM_FILE, { members: [] });
teamSeed.activeProject = PROJECT;
for (const role of MODE_ROLES) {
  let m = (teamSeed.members || []).find((x) => x && x.role === role);
  if (!m) { m = { role, name: role, status: 'active', joinedAt: new Date().toISOString() }; teamSeed.members.push(m); }
  m.sessionId = oldId(role);
}
writeJson(TEAM_FILE, teamSeed);
writeJson(MANIFEST, {
  project: PROJECT, teamMode: 'full', workspace: PROJECT_DIR, workspaceId: 'st-rw-ws',
  generatedAt: new Date().toISOString(),
  roles: MODE_ROLES.map((role) => ({ role, name: role, title: `团队·${role}`, sessionId: oldId(role), reused: false, model: '' })),
});
const realStore = readJson(REAL_STORE, { projects: [] }) || { projects: [] };
const tpl = (realStore.projects || []).find((p) => p && String(p.teamName || p.name || '') === '工作台改造修复') || (realStore.projects || [])[0] || {};
const entry = JSON.parse(JSON.stringify(tpl));
entry.id = 'st-rw-p1'; entry.name = PROJECT; entry.teamName = PROJECT;
entry.path = PROJECT_DIR; entry.workspacePath = PROJECT_DIR;
entry.sessions = Object.fromEntries(MODE_ROLES.map((r) => [r, oldId(r)]));
entry.workspace = { ...(entry.workspace || {}), path: PROJECT_DIR, sessionIds: MODE_ROLES.map(oldId) };
writeJson(STORE, { ...realStore, projects: [entry], activeProjectId: entry.id });
writeJson(path.join(STATE, '工作流.json'), { schema: 2, project: PROJECT, round: 1, requirements: {}, boots: {} });
writeJson(path.join(STATE, '会话轮次.json'), {});
for (const role of MODE_ROLES) fs.mkdirSync(path.join(PROJECT_DIR, role, '产出'), { recursive: true });
const seedCheck = runJson(['session', 'check', '--project', PROJECT, '--json']);
check('S1 沙盘四处映射 6/6（夹具就绪）', seedCheck.code === 0 && (seedCheck.json || {}).ok === true && String((seedCheck.json || {}).ratio || '') === `${MODE_ROLES.length}/${MODE_ROLES.length}`,
  { code: seedCheck.code, ratio: (seedCheck.json || {}).ratio, out: text(seedCheck).slice(0, 300) });

/* ── W1 静态单写入口 ─────────────────────────────────────────────────── */
function scanWriters() {
  const hits = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (['_tmp', '备份', '沙盘', 'node_modules'].includes(ent.name)) continue;
        walk(p);
      } else if (ent.name.endsWith('.mjs') && ent.name !== 'selftest.mjs') {
        fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, idx) => {
          if (/\.sessionId\s*=(?!=)/.test(line) || /members\.push\(/.test(line)) {
            hits.push({ file: path.relative(ROOT, p).replace(/\\/g, '/'), line: idx + 1, text: line.trim() });
          }
        });
      }
    }
  };
  walk(path.join(ROOT, '团队', '工具'));
  return hits;
}
const writerHits = scanWriters();
const RW_FILE = '团队/工具/lib/roster-writer.mjs';
const MIGRATE_FILE = '团队/工具/migrate.mjs';
const outsideRoster = writerHits.filter((h) => h.file !== RW_FILE);
const whitelisted = outsideRoster.filter((h) => h.file === MIGRATE_FILE);
const unexpected = outsideRoster.filter((h) => h.file !== MIGRATE_FILE);
const byFile = (f) => writerHits.filter((h) => h.file.endsWith(f)).length;
check('W1 静态单写入口：名册赋值/入册只命中 roster-writer.mjs（迁移白名单除外，清单见 detail）',
  unexpected.length === 0 && byFile('lib/roster-writer.mjs') >= 2
  && byFile('lib/session.mjs') === 0 && byFile('lib/auto-rotate.mjs') === 0
  && byFile('launch.mjs') === 0 && byFile('lib/ops.mjs') === 0,
  { hits: writerHits, whitelistedCount: whitelisted.length, unexpected });

/* ── W2 写前校验（会话不存在 → 拒写，名册 sha256 不变） ───────────────── */
const w2Before = { teamSha: sha(TEAM_FILE), ledger: jsonlRows(LEDGER).length };
const fakeList = JSON.stringify(MODE_ROLES.map((r) => ({ sessionId: oldId(r) })));
const w2 = runJson(['session', 'rotate', '--project', PROJECT, '--role', 'tester', '--session', 'session-does-not-exist', '--reason', 'W2 写前校验', '--json'],
  { TEAM_ROSTER_DSH_ENFORCE: '1', TEAM_DSH_FAKE: fakeList });
check('W2 写前校验：目标会话在 DSH 不存在 → SESSION_NOT_IN_DSH，名册 sha256 不变、无轮换记录',
  w2.code !== 0 && /SESSION_NOT_IN_DSH/.test(text(w2)) && sha(TEAM_FILE) === w2Before.teamSha && jsonlRows(LEDGER).length === w2Before.ledger
  && rosterOf('tester') === oldId('tester') && jsonlRows(ROSTER_AUDIT).some((r) => r && r.code === 'SESSION_NOT_IN_DSH' && r.result === 'refused'),
  { code: w2.code, out: text(w2).slice(0, 400), teamShaSame: sha(TEAM_FILE) === w2Before.teamSha, roster: rosterOf('tester'), audit: jsonlRows(ROSTER_AUDIT).slice(-2) });

/* ── W2b 自动建会话（created=true）不被「建会话前的旧列表」误杀（P1-1 复核回归） ───── */
const autoCreateScript = [
  'const { pathToFileURL } = require("node:url");',
  '(async () => {',
  `  const rw = await import(pathToFileURL(${JSON.stringify(RW_SRC)}).href);`,
  `  const r = await rw.rotateRoster({ projectName: ${JSON.stringify(PROJECT)}, role: "programmer1", newSessionId: "session-st-autocreate-1", mode: "auto", created: true, reason: "W2b 自动建会话", by: "auto-rotate", source: "auto-rotate", offline: false, bootQueue: false, broadcast: false, dshList: [] });`,
  '  console.log("AUTOCREATE " + JSON.stringify({ ok: r.ok, to: r.newId, dshCheck: r.dshCheck }));',
  '})().catch((e) => { console.log("ERR " + JSON.stringify({ code: (e && e.code) || "", message: String((e && e.message) || e) })); });',
].join('\n');
{
  let autoRes = { code: 1, out: '', err: '' };
  try {
    const out = execFileSync(process.execPath, ['-e', autoCreateScript], { encoding: 'utf8', env: env({ TEAM_ROSTER_DSH_ENFORCE: '1', TEAM_DSH_FAKE: '[]' }), timeout: 120000, cwd: ROOT });
    autoRes = { code: 0, out: String(out), err: '' };
  } catch (e) {
    autoRes = { code: e.status == null ? 1 : e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
  const hasSkip = /"exempt":"created"/.test(autoRes.out);
  check('W2b 自动建会话（created=true）不被建会话前的旧 DSH 列表误杀（P1-1 复核回归）',
    /AUTOCREATE/.test(autoRes.out) && hasSkip && rosterOf('programmer1') === 'session-st-autocreate-1',
    { out: autoRes.out.slice(0, 600), err: autoRes.err.slice(0, 300), roster: rosterOf('programmer1') });
}

/* ── W3① session rotate 路径：记账 + 广播 + BQ ─────────────────────────── */
const W3_NEW = 'session-st-new-tester';
const w3 = runJson(['session', 'rotate', '--project', PROJECT, '--role', 'tester', '--session', W3_NEW, '--offline', '--reason', 'W3 沙盘轮换', '--json']);
const ledgerRows = jsonlRows(LEDGER);
const lastLedger = ledgerRows[ledgerRows.length - 1] || {};
const recorder = readJson(path.join(STATE, '会话轮换', 'tester.json'), {});
const bootQueue = readJson(BOOT_QUEUE, { items: [] });
const bqTester = (bootQueue.items || []).find((it) => it && String(it.role) === 'tester' && String(it.sessionId) === W3_NEW);
const others = MODE_ROLES.filter((r) => r !== 'tester');
check('W3① session rotate：会话轮换.jsonl 增 1 行（from/to/mode/created/by/source 齐）+ 会话轮换/<角色>.json',
  w3.code === 0 && String(lastLedger.from || '') === oldId('tester') && String(lastLedger.to || '') === W3_NEW
  && String(lastLedger.mode || '') === 'manual' && lastLedger.created === false
  // by=操作者（CLI 默认 owner，可 --by 覆盖）；source=路径来源（session-rotate / auto-rotate）——两者不同义
  && String(lastLedger.by || '') !== '' && ['owner', 'selftest'].includes(String(lastLedger.by || '')) && String(lastLedger.source || '') === 'session-rotate'
  && String(recorder.to || '') === W3_NEW && String(recorder.id || '').startsWith('S-')
  && fs.existsSync(path.join(STATE, '会话轮换', `${recorder.id}.json`)),
  { code: w3.code, out: text(w3).slice(0, 300), lastLedger, recorder: { id: recorder.id, to: recorder.to } });
check('W3② session rotate：待启动队列（BQ）登记新会话 + 名册四处同改', Boolean(bqTester)
  && rosterOf('tester') === W3_NEW
  && String(((readJson(MANIFEST, { roles: [] }).roles || []).find((r) => r && r.role === 'tester') || {}).sessionId || '') === W3_NEW,
  { bqTester, roster: rosterOf('tester'), manifest: readJson(MANIFEST, {}).roles });
const broadcastMail = others.filter((r) => mailOf(r).some((m) => /名册变更|重 boot|重新 boot/.test(`${m.subject || ''} ${m.body || ''}`)));
check('W3③ session rotate：广播其余 active 成员重 boot（旧实现缺这一半）+ 名册变更.jsonl 统一记账',
  broadcastMail.length === others.length
  && jsonlRows(ROSTER_AUDIT).some((r) => r && r.event === 'roster_rotate' && r.role === 'tester' && r.to === W3_NEW && r.source === 'session-rotate' && r.rosterSha256),
  { broadcastMail, expect: others, auditTail: jsonlRows(ROSTER_AUDIT).slice(-2) });

/* ── W3④ auto-rotate 路径：同一行格式 + BQ + 广播 ─────────────────────── */
const dayBase = (() => { const d = new Date(); d.setHours(10, 0, 0, 0); return d.getTime(); })();
writeJson(path.join(STATE, '会话用量.json'), { analyst: { sessionId: oldId('analyst'), tokens: 600000, at: new Date(dayBase).toISOString(), source: 'fixture' } });
const c1 = cycle(dayBase);
const handoverFile = path.join(PROJECT_DIR, ROLE_DIRS.analyst, '产出', '交接-最新.md');
fs.mkdirSync(path.dirname(handoverFile), { recursive: true });
fs.writeFileSync(handoverFile, `# analyst 交接（夹具）\n\n- at: ${new Date(dayBase + 5000).toISOString()}\n`, 'utf8');
const mt = new Date(dayBase + 6000); fs.utimesSync(handoverFile, mt, mt);
writeJson(path.join(TEAM, '状态', '邮箱', 'analyst', 'new', `M-fixture-handover-analyst-${dayBase}.json`),
  { id: 'M-fixture-handover-analyst', from: 'analyst', to: 'pm', type: 'receipt', subject: '交接完成：analyst', body: '交接已完成', project: PROJECT, ts: new Date(dayBase + 5000).toISOString() });
const c2 = cycle(dayBase + 2 * 60 * 1000);
const arRows = jsonlRows(path.join(STATE, '自动换人.jsonl'));
const arRaw = (() => { try { return fs.readFileSync(path.join(STATE, '自动换人.jsonl'), 'utf8'); } catch { return ''; } })();
const arRotateRows = arRows.filter((r) => String(r.stage) === 'rotate');
const arRemindRows = arRows.filter((r) => String(r.stage) === 'remind');
const acts1 = (c1.payload && c1.payload.actions) || [];
const acts2 = (c2.payload && c2.payload.actions) || [];
const arNew = rosterOf('analyst');
const ledgerAr = jsonlRows(LEDGER).filter((r) => r && r.role === 'analyst').pop() || {};
const bqAnalyst = (readJson(BOOT_QUEUE, { items: [] }).items || []).find((it) => it && String(it.role) === 'analyst' && String(it.sessionId) === arNew);
const arOthers = MODE_ROLES.filter((r) => r !== 'analyst');
const arBroadcast = arOthers.filter((r) => mailOf(r).some((m) => /名册变更|重 boot/.test(`${m.subject || ''} ${m.body || ''}`)));
check('W3④ auto-rotate（3594 后只提醒不换人）：无 rotate 行、名册不变、无轮换记录/BQ；cycle 返回提醒动作（PM 手动换人 + 交接就绪）',
  c1.code === 0 && c2.code === 0 && arNew === oldId('analyst')
  && arRotateRows.length === 0 && Object.keys(ledgerAr).length === 0
  && !bqAnalyst
  && acts1.some((a) => String(a.code) === 'REMIND_PM_MANUAL_ROTATE')
  && acts2.some((a) => String(a.code) === 'HANDOVER_READY_REMIND_PM'),
  { c1: c1.payload, c2: c2.payload, arNew, arRotateRows: arRotateRows.length, ledgerAr, bqAnalyst: Boolean(bqAnalyst), acts1, acts2 });

/* ── W4 workbench 单写入口（静态）+ W8 并发不丢更新 ───────────────────── */
const arSrc = fs.readFileSync(AR_SRC, 'utf8');
const rwSrc = fs.readFileSync(RW_SRC, 'utf8');
check('W4 workbench 单写入口：auto-rotate 无裸写（fs.writeFileSync(wbFile）且 roster-writer 走 updateJsonAtomic',
  !/fs\.writeFileSync\(\s*wbFile/.test(arSrc) && !/writeFileSync\(\s*workbenchFile/.test(rwSrc) && /updateJsonAtomic\(/.test(rwSrc)
  && /allowedRoots/.test(rwSrc),
  { arRawWrite: (arSrc.match(/fs\.writeFileSync\(/g) || []).length, rwHasUpdate: /updateJsonAtomic\(/.test(rwSrc) });
const shrinkBefore = rosterOf('pm');
const rosterAddScript = [
  'const { pathToFileURL } = require("node:url");',
  '(async () => {',
  `  const s = await import(pathToFileURL(${JSON.stringify(path.join(ROOT, '团队', '工具', 'lib', 'store.mjs'))}).href);`,
  `  const rw = await import(pathToFileURL(${JSON.stringify(RW_SRC)}).href);`,
  '  s.mutateTeam((t) => { rw.pushRosterMember(t, { role: "auditor", name: "扩编角色", status: "active", joinedAt: new Date().toISOString(), sessionId: "session-st-auditor" }); return t; });',
  '  console.log("ADDED");',
  '})().catch((e) => { console.log("ERR " + String((e && (e.message || e)) || e)); });',
].join('\n');
const rotateScript = [
  'const { pathToFileURL } = require("node:url");',
  '(async () => {',
  `  const rw = await import(pathToFileURL(${JSON.stringify(RW_SRC)}).href);`,
  `  const r = await rw.rotateRoster({ projectName: ${JSON.stringify(PROJECT)}, role: "pm", newSessionId: "session-st-conc-pm", mode: "manual", created: false, reason: "W8 并发换人", by: "system", source: "session-rotate", offline: true, bootQueue: false, broadcast: false });`,
  '  console.log("ROTATED " + JSON.stringify({ ok: r.ok, to: r.newId }));',
  '})().catch((e) => { console.log("ERR " + String((e && (e.message || e)) || e)); });',
].join('\n');
(async () => {
  const [addRes, rotRes] = await Promise.all([spawnNode(rosterAddScript), spawnNode(rotateScript)]);
  const rosterNow = readJson(TEAM_FILE, { members: [] });
  const auditor = (rosterNow.members || []).find((m) => m && m.role === 'auditor');
  const pmNow = String(((rosterNow.members || []).find((m) => m && m.role === 'pm') || {}).sessionId || '');
  check('W8 并发不丢更新：两进程同时「扩编 + 换人」→ 两处改动都在（withLock(_team)）',
    /ADDED/.test(addRes.out) && /ROTATED/.test(rotRes.out) && Boolean(auditor) && pmNow === 'session-st-conc-pm' && pmNow !== shrinkBefore,
    { addRes, rotRes, auditor: Boolean(auditor), pmNow, pmBefore: shrinkBefore });
  check('W8b 并发结果：会话轮换.jsonl 记下这次换人（source=session-rotate）',
    jsonlRows(LEDGER).some((r) => r && r.role === 'pm' && r.to === 'session-st-conc-pm' && r.source === 'session-rotate'),
    { tail: jsonlRows(LEDGER).slice(-3) });

  /* ── W9 事务中途并发写（N6/N2/N1 回归） ──────────────────────────────
     W9a：并发写者只改 team.json 的**别的字段** → 字段级 CAS 回滚把该角色 sessionId 复原，
          full=true、别人改动保留（整文件回滚会丢他的改动）。
     W9b：并发写者整份覆盖 workbench.json（模拟外部写者）→ 回滚必须**响亮地部分回滚**（full=false + 审计 + 告警 PM）。 */
  function runTxCase(script) {
    try {
      return { out: String(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: env(), timeout: 120000, cwd: ROOT })), err: '' };
    } catch (e) { return { out: String(e.stdout || ''), err: String(e.stderr || '') }; }
  }
  const makeTxScript = (name, marker, hijackWorkbench) => [
    'const { pathToFileURL } = require("node:url");',
    'const fs = require("node:fs");',
    '(async () => {',
    `  const s = await import(pathToFileURL(${JSON.stringify(path.join(ROOT, '团队', '工具', 'lib', 'store.mjs'))}).href);`,
    `  const rw = await import(pathToFileURL(${JSON.stringify(RW_SRC)}).href);`,
    '  const out = { code: "", rollback: null, markerKept: false, roster: "", workbenchHijacked: false };',
    '  try {',
    `    await rw.rotateRoster({ projectName: ${JSON.stringify(PROJECT)}, role: "programmer2", newSessionId: "session-st-${name}-programmer2", mode: "manual", created: false, reason: "${name} 事务中途并发写", by: "system", source: "session-rotate", offline: true, bootQueue: false, broadcast: false,`,
    '      beforeFinalize: async () => {',
    `        s.mutateTeam((t) => { t.config = { ...(t.config || {}), ${marker}: "concurrent-writer" }; return t; });`,
    ...(hijackWorkbench ? [
      '        const wbFile = String(process.env.TEAM_WORKBENCH_JSON || "");',
      '        if (wbFile) {',
      '          const wb = JSON.parse(fs.readFileSync(wbFile, "utf8"));',
      '          wb.externalWriterMarker = "hijacked";',
      '          fs.writeFileSync(wbFile, JSON.stringify(wb, null, 2) + "\\n", "utf8");',
      '          out.workbenchHijacked = true;',
      '        }',
    ] : []),
    `        throw new Error("${name} 注入失败：映射已写，事务中途有别的写者");`,
    '      },',
    '    });',
    '  } catch (e) {',
    '    out.code = String((e && e.code) || "THROWN");',
    '    out.rollback = (e && e.details && e.details.rollback) || null;',
    '    out.message = String((e && e.message) || e);',
    '  }',
    `  const team = JSON.parse(fs.readFileSync(${JSON.stringify(TEAM_FILE)}, "utf8"));`,
    `  out.markerKept = String((team.config || {}).${marker} || "") === "concurrent-writer";`,
    '  out.roster = String(((team.members || []).find((m) => m && m.role === "programmer2") || {}).sessionId || "");',
    '  console.log("TX " + JSON.stringify(out));',
    '})().catch((e) => { console.log("ERR " + String((e && e.message) || e)); });',
  ].join('\n');
  const w9aRes = runTxCase(makeTxScript('w9a', 'w9aMarker', false));
  const w9a = (() => { try { return JSON.parse((/TX (\{.*\})/.exec(w9aRes.out) || [])[1] || 'null'); } catch { return null; } })();
  check('W9a 并发改名册别的字段 → 字段级 CAS 回滚（该角色 sessionId 复原、别人改动保留、full=true）',
    Boolean(w9a) && w9a.rollback && w9a.rollback.full === true
    && (w9a.rollback.fieldRepaired || []).includes('team')
    && w9a.markerKept === true && w9a.roster === oldId('programmer2'),
    { w9a, out: w9aRes.out.slice(0, 500) });
  const w9bRes = runTxCase(makeTxScript('w9b', 'w9bMarker', true));
  const w9b = (() => { try { return JSON.parse((/TX (\{.*\})/.exec(w9bRes.out) || [])[1] || 'null'); } catch { return null; } })();
  const w9Audit = jsonlRows(ROSTER_AUDIT).filter((r) => r && String(r.code) === 'ROSTER_ROLLBACK_PARTIAL');
  const w9PmMail = mailOf('pm').filter((m) => /ROSTER_ROLLBACK_PARTIAL/.test(`${m.subject || ''} ${m.body || ''}`));
  check('W9b 外部写者整份覆盖 workbench → 回滚响亮地报「部分回滚」（full=false）+ 审计 + 告警 PM',
    Boolean(w9b) && w9b.workbenchHijacked === true && w9b.rollback && w9b.rollback.full === false
    && (w9b.rollback.skipped || []).some((x) => x.key === 'workbench')
    && w9Audit.length >= 1 && w9PmMail.length >= 1,
    { w9b, out: w9bRes.out.slice(0, 500), w9Audit: w9Audit.slice(-1), pmMail: w9PmMail.length });

  /* ── W5 交接单一判据（两路径同拒） ─────────────────────────────────── */
  const badHandover = '# 坏交接\n\n没有必填小节，也没有遗留坑。\n';
  const w5Before = { teamSha: sha(TEAM_FILE), tester: rosterOf('tester'), ledger: jsonlRows(LEDGER).length };
  const w5cli = runJson(['session', 'rotate', '--project', PROJECT, '--role', 'tester', '--session', 'session-st-w5-tester', '--offline', '--reason', 'W5 交接门'], { TEAM_ROTATE_HANDOVER_TEXT: badHandover });
  check('W5① session rotate：交接缺必填【】小节 → HANDOVER_INCOMPLETE，名册不变、无轮换记录',
    w5cli.code !== 0 && /HANDOVER_INCOMPLETE/.test(text(w5cli)) && sha(TEAM_FILE) === w5Before.teamSha
    && rosterOf('tester') === w5Before.tester && jsonlRows(LEDGER).length === w5Before.ledger,
    { code: w5cli.code, out: text(w5cli).slice(0, 400) });
  // auto-rotate 路径：tester 到强制档 → 一拍发交接请求 → 写交接 → 再拍（同一注入文本）应同拒
  writeJson(path.join(STATE, '会话用量.json'), { tester: { sessionId: w5Before.tester, tokens: 600000, at: new Date(dayBase + 10 * 60000).toISOString(), source: 'fixture' } });
  const c5a = cycle(dayBase + 10 * 60000, { TEAM_ROTATE_HANDOVER_TEXT: badHandover });
  const tFile = path.join(PROJECT_DIR, ROLE_DIRS.tester, '产出', '交接-最新.md');
  fs.mkdirSync(path.dirname(tFile), { recursive: true });
  fs.writeFileSync(tFile, `# tester 交接（夹具）\n\n- at: ${new Date(dayBase + 11 * 60000).toISOString()}\n`, 'utf8');
  const mt5 = new Date(dayBase + 11 * 60000 + 6000); fs.utimesSync(tFile, mt5, mt5);
  const c5b = cycle(dayBase + 12 * 60000, { TEAM_ROTATE_HANDOVER_TEXT: badHandover });
  const arRows5 = jsonlRows(path.join(STATE, '自动换人.jsonl'));
  const arRaw5 = (() => { try { return fs.readFileSync(path.join(STATE, '自动换人.jsonl'), 'utf8'); } catch { return ''; } })();
  const arRot5 = arRows5.filter((r) => String(r.stage) === 'rotate' && String(r.role) === 'tester');
  // 3594 后 auto-rotate 不再调用 rotateSession（remind-only），HANDOVER_INCOMPLETE 的落点改到提醒路径：
  // 机器格式接任包（首行 `=== 接任包`）仍走 validateHandover；普通文本文件按 mtime/邮件判「就绪」（已知口径，
  // 由 PM 在手动 rotate 时用同一 validateHandover 把最后一道关）。本断言只认「只提醒、不换人、名册不变」。
  check('W5② auto-rotate（3594 后只提醒）：交接场景只提醒、不换人、名册不变（无 rotate 行）',
    c5a.code === 0 && c5b.code === 0 && arRot5.length === 0 && rosterOf('tester') === w5Before.tester
    && ((c5a.payload && c5a.payload.actions) || []).some((a) => String(a.code) === 'REMIND_PM_MANUAL_ROTATE'),
    { c5a: c5a.payload, c5b: c5b.payload, arRot5: arRot5.length, roster: rosterOf('tester') });

  /* ── W6 207b 不破 ──────────────────────────────────────────────────── */
  let launchOk = false;
  let launchOut = '';
  try {
    launchOut = String(execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'test-launch-reuse.cjs')], { encoding: 'utf8', env: env(), timeout: 120000, cwd: ROOT }));
    launchOk = true;
  } catch (e) { launchOut = String(e.stdout || '') + String(e.stderr || ''); launchOk = false; }
  const launchSrc = fs.readFileSync(path.join(ROOT, '团队', '工具', 'launch.mjs'), 'utf8');
  check('W6 207b 不破：test-launch-reuse 12/12 + launch 三源复用零改动（静态）',
    launchOk && /LAUNCH_REUSE \{"total":12,"pass":12/.test(launchOut)
    && /pickReuse\(/.test(launchSrc) && /buildRotation\(/.test(launchSrc)
    && !/const activeSessionIds = new Set/.test(launchSrc) && /setMemberSession\(/.test(launchSrc),
    { launchOk, tail: launchOut.slice(-400) });

  /* ── W7 旧副本防御 + 写后 60 秒兜底 ────────────────────────────────── */
  const w7Before = { teamSha: sha(TEAM_FILE), rosterProduct: rosterOf('product') };
  const w7a = runJson(['session', 'rotate', '--project', PROJECT, '--role', 'product', '--session', 'session-st-w7a-product', '--offline', '--force', '--reason', 'W7 注入旧副本'],
    { __AR_NEW_SESSION: 'session-auto-tester-x' });
  check('W7① 注入 __AR_NEW_SESSION（旧副本入口）→ LEGACY_SESSION_ID_REFUSED、名册不变',
    w7a.code !== 0 && /LEGACY_SESSION_ID_REFUSED/.test(text(w7a)) && sha(TEAM_FILE) === w7Before.teamSha && rosterOf('product') === w7Before.rosterProduct,
    { code: w7a.code, out: text(w7a).slice(0, 400) });
  const w7b = runJson(['session', 'rotate', '--project', PROJECT, '--role', 'product', '--session', 'session-auto-tester-abc', '--offline', '--force', '--reason', 'W7 形态自检']);
  check('W7② 目标 id 形如 session-auto-*（08:02 形态）→ LEGACY_SESSION_ID_REFUSED、名册不变',
    w7b.code !== 0 && /LEGACY_SESSION_ID_REFUSED/.test(text(w7b)) && sha(TEAM_FILE) === w7Before.teamSha && rosterOf('product') === w7Before.rosterProduct,
    { code: w7b.code, out: text(w7b).slice(0, 400) });
  const w7Audit = jsonlRows(ROSTER_AUDIT).filter((r) => r && String(r.code) === 'LEGACY_SESSION_ID_REFUSED');
  const w7PmMail = mailOf('pm').filter((m) => /LEGACY_SESSION_ID_REFUSED/.test(`${m.subject || ''} ${m.body || ''}`));
  check('W7③ 告警 PM（不静默）+ 名册变更.jsonl 各留 1 行 refused',
    w7Audit.length >= 2 && w7Audit.every((r) => r.result === 'refused') && w7PmMail.length >= 2,
    { audit: w7Audit.slice(-3), pmMail: w7PmMail.length });
  // 写后 60 秒兜底：造一条「61 秒前写入、DSH 查不到」的待校验项
  writeJson(POST_CHECK, { items: [{ role: 'tester', sessionId: 'session-does-not-exist-2', at: new Date(Date.now() - 61000).toISOString(), checkedAt: null }], updatedAt: new Date().toISOString() });
  const sweepScript = [
    'const { pathToFileURL } = require("node:url");',
    '(async () => {',
    `  const rw = await import(pathToFileURL(${JSON.stringify(RW_SRC)}).href);`,
    `  const r = await rw.sweepRosterPostChecks({ projectName: ${JSON.stringify(PROJECT)} });`,
    '  console.log("SWEEP " + JSON.stringify(r));',
    '})().catch((e) => { console.log("ERR " + String((e && (e.message || e)) || e)); });',
  ].join('\n');
  const sweepRes = await spawnNode(sweepScript, { TEAM_ROSTER_DSH_ENFORCE: '1', TEAM_DSH_FAKE: '[]' });
  const sweepAudit = jsonlRows(ROSTER_AUDIT).filter((r) => r && String(r.code) === 'ROSTER_SESSION_MISSING');
  const sweepPmMail = mailOf('pm').filter((m) => /ROSTER_SESSION_MISSING/.test(`${m.subject || ''} ${m.body || ''}`));
  check('W7④ 写后 60 秒兜底：DSH 仍查不到 → ROSTER_SESSION_MISSING 审计 + 告警 PM',
    /SWEEP/.test(sweepRes.out) && sweepAudit.length >= 1 && sweepPmMail.length >= 1
    && (!fs.existsSync(POST_CHECK) || (readJson(POST_CHECK, { items: [] }).items || []).length === 0),
    { sweep: sweepRes.out.slice(0, 400), err: sweepRes.err.slice(0, 200), sweepAudit: sweepAudit.slice(-1), sweepPmMail: sweepPmMail.length });

  /* ── 收口：真实状态零写入 ──────────────────────────────────────────── */
  check('S9 隔离：真实 团队.json / workbench.json 前后 sha256 不变（沙盘零写入）',
    sha(REAL_TEAM_FILE) === realBefore.team && sha(REAL_STORE) === realBefore.workbench,
    { before: realBefore, after: { team: sha(REAL_TEAM_FILE), workbench: sha(REAL_STORE) } });

  /* ── 结果落盘 ──────────────────────────────────────────────────────── */
  const total = results.length;
  const pass = results.filter((r) => r.ok).length;
  const red = total - pass;
  const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-4b2f');
  fs.mkdirSync(evDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const payload = {
    at: new Date().toISOString(), script: 'scripts/test-roster-writer.cjs',
    task: 'B-20261118-083150-4b2f', requirement: 'R-20261117-180740-fa0e',
    total, pass, red,
    sandbox: path.relative(ROOT, SB).replace(/\\/g, '/'),
    isolation: { realBefore, realAfter: { team: sha(REAL_TEAM_FILE), workbench: sha(REAL_STORE) } },
    results,
  };
  const evFile = path.join(evDir, `run-${ts}-${red === 0 ? 'green' : 'red'}.json`);
  payload.evidenceFile = path.relative(ROOT, evFile).replace(/\\/g, '/');
  fs.writeFileSync(evFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  if (JSON_OUT) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  else {
    console.log('');
    console.log(`${red === 0 ? 'ROSTER_WRITER_OK' : 'ROSTER_WRITER_WARN'} ${JSON.stringify({ total, pass, red })}`);
    console.log('证据：' + payload.evidenceFile);
  }
  process.exit(red === 0 ? 0 : 1);
})().catch((e) => { console.error('CRASH', String((e && e.stack) || e)); process.exit(2); });
