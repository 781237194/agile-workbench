#!/usr/bin/env node
'use strict';
/**
 * test-28b8-archive.cjs —— R-20261118-131107-28b8「换人成功后自动归档原角色会话」回归夹具
 *
 * 覆盖（对应正文 AC1–AC4；AC5 由本脚本自身 + selftest/--sq-check 承担）：
 *   AC1 换人后自动归档 + 记录：沙盘 session rotate（TEAM_ARCHIVE_STUB=0 关闭 stub）
 *       → ① 会话轮换/<role>.json 的 archive.result === 'archived'；
 *          ② 会话归档.jsonl 新增 1 行且字段齐（at/role/oldSessionId/newSessionId/result/reason）；
 *          ③ oldSessionId = 换人前 id、newSessionId = 换人后 id；④ 本地归档记录 会话归档/A-*.json 存在。
 *   AC2 失败可见、不阻断：注入归档失败（AWB_ARCHIVE_FAIL_ONCE=1）
 *       → ① 换人仍成功（名册新 id 生效、退出码 0）；② 账本有 failed 行；
 *          ③ PM 恰好收到 1 条 notice（标题含「归档失败」）；④ 面板 model rows[].archiveFailed / archiveFailures 有值；
 *          ⑤ 会话轮换/<role>.json 的 archive.result === 'failed'。
 *   AC3 在途 deferred → sweep 补归档（≤3 次）：
 *       ① 有在办任务时换人 → deferred 且带 tasks[] 与 deferredUntil（at+10 分钟）、attempts=1；
 *       ② 任务 done 后把时钟推到 deferredUntil 再跑一拍 → archived（attempts=2）；
 *       ③ 持续在途：attempts 1/2 落 deferred、第 2 次重试 next=3 落 failed(retry_exhausted, attempts=3)，
 *          同一 oldSessionId 恰好 1 条 PM 通知，账本不出现 attempts>3；
 *       ④ 单拍最多处理 5 条。
 *   AC4 不误归档当前会话 / 沙盘 / 不改名册：
 *       ① oldSessionId===currentSessionOf(role) → skipped/unchanged 且无新 A-*.json；
 *       ② TEAM_SELFTEST=1（默认）→ stubbed，不写 A-*.json；
 *       ③ 归档前后 团队.json 名册 sha256 不变；
 *       ④ 真实 团队/状态/项目/工作台改造修复/会话归档.jsonl 不存在、真实 团队.json/workbench.json sha 不变。
 *
 * 隔离：mkTempSandbox + TEAM_ROOT/TEAM_PROJECTS_ROOT/TEAM_WORKBENCH_JSON/AWB_DATA_DIR 全指沙盘 + TEAM_SELFTEST=1。
 * 用法：node scripts/test-28b8-archive.cjs [--json] [--out _tmp/28b8-run.json]
 * 退出码：0 全过 / 1 有断言失败 / 2 环境错误
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const PROJECT = '28b8归档沙盘';
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const ROLE_DIRS = { pm: '项目经理', product: '产品', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' };
const JSON_OUT = process.argv.includes('--json');
const OUT_ARG = (() => {
  const i = process.argv.indexOf('--out');
  return i > 0 && process.argv[i + 1] ? path.resolve(String(process.argv[i + 1])) : '';
})();

const SB = mkTempSandbox('28b8');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const DATA = path.join(SB, 'data');
const TEAM_TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const SESSION_MJS = path.join(ROOT, '团队', '工具', 'lib', 'session.mjs');
const AUTO_ROTATE_MJS = path.join(ROOT, '团队', '工具', 'lib', 'auto-rotate.mjs');
const ROUTE_MJS = path.join(ROOT, '团队', '工具', 'lib', 'route-daemon.mjs');
const ARCHIVE_MJS = path.join(ROOT, '团队', '工具', 'lib', 'session-archive.mjs');
const TEAM_FILE = path.join(TEAM, '状态', '团队.json');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const PROJECT_DIR = path.join(PROJECTS, PROJECT);
const TASK_DIR = path.join(STATE, '任务');
const LEDGER = path.join(STATE, '会话归档.jsonl');
const ROT_DIR = path.join(STATE, '会话轮换');
const ARCHIVE_DIR = path.join(STATE, '会话归档');
const REAL_LEDGER = path.join(ROOT, '团队', '状态', '项目', '工作台改造修复', '会话归档.jsonl');
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');

// 沙盘环境必须在 import 团队/团队模块之前设好（core.mjs 的 PATHS 是 import 时求值）。
Object.assign(process.env, {
  TEAM_ROOT: TEAM,
  TEAM_PROJECTS_ROOT: PROJECTS,
  TEAM_WORKBENCH_JSON: STORE,
  AWB_DATA_DIR: DATA,
  TEAM_SELFTEST: '1',
});

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const jsonlRows = (f) => {
  try {
    return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};
const oldId = (role) => `session-28b8-old-${role}`;
const newId = (role) => `session-28b8-new-${role}`;
const rosterOf = (role) => String(((readJson(TEAM_FILE, { members: [] }).members || []).find((m) => m && m.role === role) || {}).sessionId || '');
const archiveFiles = () => { try { return fs.readdirSync(ARCHIVE_DIR).filter((n) => n.endsWith('.json')); } catch { return []; } };
const mailOf = (role) => {
  const dir = path.join(TEAM, '状态', '邮箱', role, 'new');
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
      .map((n) => readJson(path.join(dir, n), null)).filter(Boolean);
  } catch { return []; }
};
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
function runJson(args, extraEnv = {}) {
  const r = run(args, extraEnv);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}
const textOf = (r) => String(r.out || '') + String(r.err || '');

const HANDOVER_TEXT = [
  '=== 接任包 · 28b8 夹具 ===',
  '',
  '【在途任务】无（夹具）',
  '【未闭环事项】无（夹具）',
  '【最近决策】无（夹具）',
  '【建议下一步】换人并归档旧会话',
  '【遗留问题与坑】无已知坑',
  '',
].join('\n');

async function main() {
  if (!fs.existsSync(TEAM_TOOL)) { console.error('环境错误：找不到 team.mjs'); process.exit(2); }

  /* ── 沙盘骨架 ───────────────────────────────────────────────────────── */
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  fs.mkdirSync(PROJECTS, { recursive: true });
  const seedTeam = readJson(path.join(ROOT, '团队', '状态', '团队.json'), { members: [] });
  seedTeam.activeProject = PROJECT;
  for (const m of seedTeam.members || []) { m.sessionId = ''; m.status = 'active'; }
  writeJson(TEAM_FILE, seedTeam);
  for (const rel of ['团队宪法.md', '项目铁律.md']) {
    const src = path.join(ROOT, '团队', rel);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TEAM, rel));
  }
  if (fs.existsSync(path.join(ROOT, '团队', '协议'))) fs.cpSync(path.join(ROOT, '团队', '协议'), path.join(TEAM, '协议'), { recursive: true });

  const realBefore = { team: sha(REAL_TEAM), store: sha(REAL_STORE), ledgerExists: fs.existsSync(REAL_LEDGER) };

  const setup = runJson(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
  check('S0 沙盘项目登记（full 六角色）', setup.code === 0, { code: setup.code, out: textOf(setup).slice(0, 300) });
  if (setup.code !== 0) { summary(); return; }

  const projectJson = readJson(path.join(STATE, '项目.json'), {});
  const MODE_ROLES = Array.isArray(projectJson.roleIds) && projectJson.roleIds.length ? projectJson.roleIds : ROLES.slice();
  // 四处映射齐全（沙盘自洽；团队.json 是活跃项目镜像）
  const teamSeed = readJson(TEAM_FILE, { members: [] });
  teamSeed.activeProject = PROJECT;
  for (const role of MODE_ROLES) {
    let m = (teamSeed.members || []).find((x) => x && x.role === role);
    if (!m) { m = { role, name: role, status: 'active', joinedAt: new Date().toISOString() }; teamSeed.members.push(m); }
    m.sessionId = oldId(role);
    m.status = 'active';
  }
  writeJson(TEAM_FILE, teamSeed);
  writeJson(path.join(PROJECT_DIR, '团队会话.json'), {
    project: PROJECT, teamMode: 'full', workspace: PROJECT_DIR, workspaceId: '28b8-ws',
    generatedAt: new Date().toISOString(),
    roles: MODE_ROLES.map((role) => ({ role, name: role, title: `团队·${role}`, sessionId: oldId(role), reused: false, model: '' })),
  });
  const realStore = readJson(REAL_STORE, { projects: [] }) || { projects: [] };
  const tpl = (realStore.projects || []).find((p) => p && String(p.teamName || p.name || '') === '工作台改造修复') || (realStore.projects || [])[0] || {};
  const entry = JSON.parse(JSON.stringify(tpl));
  entry.id = '28b8-p1'; entry.name = PROJECT; entry.teamName = PROJECT;
  entry.path = PROJECT_DIR; entry.workspacePath = PROJECT_DIR;
  entry.sessions = Object.fromEntries(MODE_ROLES.map((r) => [r, oldId(r)]));
  entry.workspace = { ...(entry.workspace || {}), path: PROJECT_DIR, sessionIds: MODE_ROLES.map(oldId) };
  writeJson(STORE, { ...realStore, projects: [entry], activeProjectId: entry.id });
  writeJson(path.join(STATE, '工作流.json'), { schema: 2, project: PROJECT, round: 1, requirements: {}, boots: {} });
  writeJson(path.join(STATE, '会话轮次.json'), {});
  for (const role of MODE_ROLES) fs.mkdirSync(path.join(PROJECT_DIR, ROLE_DIRS[role] || role, '产出'), { recursive: true });

  const seedCheck = runJson(['session', 'check', '--project', PROJECT, '--json']);
  check('S1 沙盘四处映射齐全（夹具就绪）',
    seedCheck.code === 0 && (seedCheck.json || {}).ok === true
    && String((seedCheck.json || {}).ratio || '') === `${MODE_ROLES.length}/${MODE_ROLES.length}`,
    { code: seedCheck.code, ratio: (seedCheck.json || {}).ratio, out: textOf(seedCheck).slice(0, 300) });

  const archiveMod = await import(pathToFileURL(ARCHIVE_MJS).href);
  const SessionQueue = require(path.join(ROOT, 'src', 'session-queue.js'));

  /* ── AC1：换人后自动归档（stub 关闭 → 真归档） ─────────────────────── */
  const ac1 = runJson(['session', 'rotate', '--project', PROJECT, '--role', 'analyst', '--session', newId('analyst'), '--offline', '--reason', '28b8 AC1 换人后归档', '--json'],
    { TEAM_ARCHIVE_STUB: '0', TEAM_ROTATE_HANDOVER_TEXT: HANDOVER_TEXT });
  const ac1Outcome = (ac1.json && (ac1.json.archiveOutcome || ac1.json.archive)) || null;
  const rotAnalyst = readJson(path.join(ROT_DIR, 'analyst.json'), {});
  const rowsAfterAc1 = jsonlRows(LEDGER);
  const ac1Row = rowsAfterAc1.filter((r) => r && r.role === 'analyst' && String(r.result) === 'archived').pop() || null;
  const ac1File = archiveFiles().map((n) => readJson(path.join(ARCHIVE_DIR, n), null)).filter(Boolean).find((r) => String(r.sessionId || '') === oldId('analyst')) || null;
  check('AC1 换人成功（sandbox rotate 退出码 0、名册指向新会话、返回 archiveOutcome=archived）',
    ac1.code === 0 && rosterOf('analyst') === newId('analyst') && Boolean(ac1Outcome) && ac1Outcome.result === 'archived',
    { code: ac1.code, roster: rosterOf('analyst'), outcome: ac1Outcome, out: textOf(ac1).slice(0, 300) });
  check('AC1① 会话轮换/analyst.json 的 archive.result === archived',
    (rotAnalyst.archive || {}).result === 'archived',
    { archive: rotAnalyst.archive });
  check('AC1② 会话归档.jsonl 新增 1 行且字段齐（at/role/oldSessionId/newSessionId/result/reason）',
    Boolean(ac1Row) && Boolean(ac1Row.at) && ac1Row.role === 'analyst'
    && ac1Row.oldSessionId === oldId('analyst') && ac1Row.newSessionId === newId('analyst')
    && ac1Row.result === 'archived' && Boolean(ac1Row.reason) && 'archiveId' in ac1Row,
    { row: ac1Row });
  check('AC1⑤ 边界·降级：沙盘旧会话在 DSH 不存在 → 仍 archived，reason=transcript_missing（不判 failed）',
    Boolean(ac1Row) && ac1Row.result === 'archived' && ac1Row.reason === 'transcript_missing',
    { row: ac1Row && { result: ac1Row.result, reason: ac1Row.reason, rotateReason: ac1Row.rotateReason } });
  check('AC1③ oldSessionId=换人前 id、newSessionId=换人后 id（逐位比对）',
    Boolean(ac1Row) && ac1Row.oldSessionId === oldId('analyst') && ac1Row.newSessionId === rosterOf('analyst'),
    { row: ac1Row, roster: rosterOf('analyst') });
  check('AC1④ 本地归档记录 会话归档/A-*.json 以旧 sessionId 落盘（不是新会话）',
    Boolean(ac1File) && String(ac1File.sessionId) === oldId('analyst'),
    { file: ac1File && { id: ac1File.id, sessionId: ac1File.sessionId } });

  /* ── AC2：归档失败可见、不阻断换人 ─────────────────────────────────── */
  const ac2 = runJson(['session', 'rotate', '--project', PROJECT, '--role', 'tester', '--session', newId('tester'), '--offline', '--reason', '28b8 AC2 归档失败注入', '--json'],
    { TEAM_ARCHIVE_STUB: '0', AWB_ARCHIVE_FAIL_ONCE: '1', TEAM_ROTATE_HANDOVER_TEXT: HANDOVER_TEXT });
  const ac2Outcome = (ac2.json && (ac2.json.archiveOutcome || ac2.json.archive)) || null;
  const rowsAfterAc2 = jsonlRows(LEDGER);
  const ac2Fail = rowsAfterAc2.filter((r) => r && r.role === 'tester' && String(r.result) === 'failed').pop() || null;
  const rotTester = readJson(path.join(ROT_DIR, 'tester.json'), {});
  const pmNotices = mailOf('pm').filter((m) => String(m.subject || '').includes('归档失败') && String(m.type) === 'notice');
  const modelAc2 = SessionQueue.buildPanelModel({
    roles: MODE_ROLES, roleNames: {}, archiveRows: rowsAfterAc2, wakeRows: [], autoRotateRows: [], now: Date.now(),
  });
  const testerModelRow = (modelAc2.rows || []).find((r) => r.role === 'tester') || {};
  const panelSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'session-queue-panel.js'), 'utf8');
  check('AC2① 换人仍成功（注入归档失败后名册仍指向新会话、退出码 0、archiveOutcome=failed）',
    ac2.code === 0 && rosterOf('tester') === newId('tester')
    && Boolean(ac2Outcome) && ac2Outcome.result === 'failed',
    { code: ac2.code, roster: rosterOf('tester'), outcome: ac2Outcome, out: textOf(ac2).slice(0, 400) });
  check('AC2② 会话归档.jsonl 有 failed 行（reason=ARCHIVE_INJECTED_FAIL）',
    Boolean(ac2Fail) && /ARCHIVE_INJECTED_FAIL/.test(String(ac2Fail.reason || '')),
    { row: ac2Fail });
  check('AC2③ PM 恰好收到 1 条归档失败通知（type=notice，标题含「归档失败」）',
    pmNotices.length === 1,
    { count: pmNotices.length, subjects: pmNotices.map((m) => m.subject) });
  check('AC2④ 面板 model：rows[tester].archiveFailed=true + archiveFailures.total≥1（值来自账本、渲染层只读 model）',
    testerModelRow.archiveFailed === true && Boolean(testerModelRow.archiveFailedReason)
    && modelAc2.archiveFailures && Number(modelAc2.archiveFailures.total) >= 1
    && Boolean((modelAc2.archiveFailures.byRole || {}).tester),
    { row: testerModelRow && { archiveFailed: testerModelRow.archiveFailed, reason: testerModelRow.archiveFailedReason }, archiveFailures: modelAc2.archiveFailures });
  check('AC2④b 渲染层只读 model 写黄点：源码含 data-sq-archive-failed 与 sq-archive-dot（不读盘）',
    /data-sq-archive-failed/.test(panelSrc) && /sq-archive-dot/.test(panelSrc) && !/readFileSync|require\('node:fs'\)/.test(panelSrc),
    { hasAttr: /data-sq-archive-failed/.test(panelSrc), hasDot: /sq-archive-dot/.test(panelSrc) });
  check('AC2⑤ 会话轮换/tester.json 的 archive.result === failed',
    (rotTester.archive || {}).result === 'failed',
    { archive: rotTester.archive });

  /* ── AC3：deferred → sweep 补归档（≤3 次） ─────────────────────────── */
  // ① 有在办任务时换人（真实 CLI 链路）→ 归档必须落 deferred（TASK_OPEN），不阻断换人
  const openTaskId = 'T-28b8-open-1';
  writeJson(path.join(TASK_DIR, `${openTaskId}.json`), {
    id: openTaskId, project: PROJECT, type: 'bug', priority: 'P2', status: 'working',
    owner: 'programmer1', title: '夹具：有在办任务时换人（归档应延后）', createdAt: new Date().toISOString(),
  });
  const teamShaBeforeArchive = sha(TEAM_FILE);
  const ac3a = runJson(['session', 'rotate', '--project', PROJECT, '--role', 'programmer1', '--session', newId('programmer1'), '--offline', '--reason', '28b8 AC3 在途换人', '--json'],
    { TEAM_ARCHIVE_STUB: '0', TEAM_ROTATE_HANDOVER_TEXT: HANDOVER_TEXT });
  void teamShaBeforeArchive;
  const d1 = (ac3a.json && (ac3a.json.archiveOutcome || ac3a.json.archive)) || null;
  check('AC3① 有在办任务时换人 → deferred，带 tasks[] 与 deferredUntil（at+10 分钟）、attempts=1',
    ac3a.code === 0 && rosterOf('programmer1') === newId('programmer1')
    && Boolean(d1) && d1.result === 'deferred' && Number(d1.attempts) === 1
    && Array.isArray(d1.tasks) && d1.tasks.includes(openTaskId)
    && Date.parse(d1.deferredUntil) - Date.parse(d1.at) === 10 * 60 * 1000,
    { outcome: d1, code: ac3a.code, roster: rosterOf('programmer1') });
  check('AC3①b deferred 同时回填 会话轮换/programmer1.json 的 archive 段（result/attempts）',
    (readJson(path.join(ROT_DIR, 'programmer1.json'), {}).archive || {}).result === 'deferred'
    && Number((readJson(path.join(ROT_DIR, 'programmer1.json'), {}).archive || {}).attempts) === 1,
    { archive: readJson(path.join(ROT_DIR, 'programmer1.json'), {}).archive });

  // ② 任务闭环后把时钟推到 deferredUntil 再跑一拍 → archived（attempts=2）
  process.env.TEAM_ARCHIVE_STUB = '0';   // 本进程内 sweep 也要真归档（沙盘默认 stub 会只记账）
  const task1 = readJson(path.join(TASK_DIR, `${openTaskId}.json`), {});
  task1.status = 'done';
  task1.doneAt = new Date().toISOString();
  writeJson(path.join(TASK_DIR, `${openTaskId}.json`), task1);
  const sweepAt1 = Date.parse(d1.deferredUntil) + 1000;
  const s1 = archiveMod.sweepDeferredArchives({ projectName: PROJECT, now: sweepAt1, limit: 5 });
  const sweepArchived = (s1.results || []).find((r) => r.role === 'programmer1') || null;
  const p1Archive = archiveFiles().map((n) => readJson(path.join(ARCHIVE_DIR, n), null)).filter(Boolean).find((r) => String(r.sessionId || '') === oldId('programmer1')) || null;
  const rotProg1 = readJson(path.join(ROT_DIR, 'programmer1.json'), {});
  check('AC3② 任务 done 后推进时钟触发 1 拍 → archived（attempts=2），A-*.json 以旧会话落盘、轮换记录 archive 段回填',
    Boolean(sweepArchived) && sweepArchived.result === 'archived' && Number(sweepArchived.attempts) === 2
    && Boolean(p1Archive) && (rotProg1.archive || {}).result === 'archived',
    { swept: sweepArchived, archiveFile: p1Archive && { id: p1Archive.id, sessionId: p1Archive.sessionId }, rotateArchive: rotProg1.archive });

  // ③ 持续在途：初始 1 → 重试 2（仍 deferred）→ next=3 落 failed
  const open2 = 'T-28b8-open-2';
  writeJson(path.join(TASK_DIR, `${open2}.json`), {
    id: open2, project: PROJECT, type: 'bug', priority: 'P2', status: 'working',
    owner: 'programmer2', title: '夹具：持续在途（重试到 3 次落 failed）', createdAt: new Date().toISOString(),
  });
  const ac3b = runJson(['session', 'rotate', '--project', PROJECT, '--role', 'programmer2', '--session', newId('programmer2'), '--offline', '--reason', '28b8 AC3 持续在途', '--json'],
    { TEAM_ARCHIVE_STUB: '0', TEAM_ROTATE_HANDOVER_TEXT: HANDOVER_TEXT });
  const d2 = (ac3b.json && (ac3b.json.archiveOutcome || ac3b.json.archive)) || null;
  const retry2 = archiveMod.sweepDeferredArchives({ projectName: PROJECT, now: Date.parse(d2.deferredUntil) + 1000, limit: 5 });
  const retry2Row = (retry2.results || []).find((r) => r.role === 'programmer2') || null;
  const nextDue = retry2Row && retry2Row.deferredUntil ? Date.parse(retry2Row.deferredUntil) : 0;
  const retry3 = archiveMod.sweepDeferredArchives({ projectName: PROJECT, now: nextDue + 1000, limit: 5 });
  const retry3Row = (retry3.results || []).find((r) => r.role === 'programmer2') || null;
  const rowsP2 = jsonlRows(LEDGER).filter((r) => r && r.role === 'programmer2' && String(r.oldSessionId) === oldId('programmer2'));
  const failedP2 = rowsP2.filter((r) => String(r.result) === 'failed');
  const pmNoteP2 = mailOf('pm').filter((m) => String(m.body || '').includes(oldId('programmer2')) && String(m.subject || '').includes('归档失败'));
  check('AC3③ 计数口径：初始 1 → 重试 2（仍 deferred）→ next=3 写 failed（reason=retry_exhausted、attempts=3）',
    Boolean(d2) && d2.result === 'deferred' && Number(d2.attempts) === 1
    && Boolean(retry2Row) && retry2Row.result === 'deferred' && Number(retry2Row.attempts) === 2
    && Boolean(retry3Row) && retry3Row.result === 'failed' && String(retry3Row.reason) === 'retry_exhausted' && Number(retry3Row.attempts) === 3,
    { d2: d2 && `${d2.result}#${d2.attempts}`, retry2: retry2Row && `${retry2Row.result}#${retry2Row.attempts}`, retry3: retry3Row && `${retry3Row.result}#${retry3Row.attempts}` });
  check('AC3③b 账本不出现 attempts>3；attempts 序列为 1,2,3；同一 oldSessionId 恰好 1 条 failed 行',
    rowsP2.every((r) => !(Number(r.attempts) > 3))
    && failedP2.length === 1
    && rowsP2.map((r) => Number(r.attempts)).join(',') === '1,2,3',
    { rows: rowsP2.map((r) => `${r.result}#${r.attempts}`), failed: failedP2.length });
  check('AC3③c 同一 oldSessionId 恰好 1 条 PM 归档失败通知（不重复惊动）',
    pmNoteP2.length === 1,
    { count: pmNoteP2.length, subjects: pmNoteP2.map((m) => m.subject) });

  // ④ 单拍上限 5 条（6 条到期 → 只处理 5 条，剩 1 条留到下一拍）
  const limitBase = Date.now();
  for (const role of MODE_ROLES) {
    archiveMod.appendArchiveLedger(PROJECT, {
      at: new Date(limitBase).toISOString(), project: PROJECT, role,
      oldSessionId: `session-28b8-limit-${role}`, newSessionId: `session-28b8-limitnew-${role}`,
      result: 'deferred', reason: 'TASK_OPEN', attempts: 1, tasks: ['T-fixture'],
      deferredUntil: new Date(limitBase - 1000).toISOString(), source: 'fixture', auto: true,
    });
  }
  const limitSweep = archiveMod.sweepDeferredArchives({ projectName: PROJECT, now: limitBase + 1000, limit: 5 });
  const remainingDeferred = (() => {
    const latest = new Map();
    for (const r of jsonlRows(LEDGER)) {
      const role = String(r.role || '');
      if (!role) continue;
      latest.set(role, r);            // 按角色取账本最后一行；只有它仍是 deferred 才算「留到下一拍」
    }
    return [...latest.values()].filter((r) => String(r.result) === 'deferred'
      && Date.parse(String(r.deferredUntil || '')) <= limitBase + 1000).length;
  })();
  check('AC3④ 单拍最多处理 5 条（6 条到期 → processed=5，剩 1 条 deferred 留到下一拍）',
    Number(limitSweep.processed) === 5 && Number(limitSweep.due) === 6 && remainingDeferred === 1,
    { processed: limitSweep.processed, due: limitSweep.due, remainingDeferred });

  /* ── AC4：不误归档当前会话 / 沙盘 stub ─────────────────────────────── */
  // 模拟 product 已换人：名册 + 项目团队会话清单都指向 current-product
  //（currentSessionOf 优先读 <项目>/团队会话.json，只改 团队.json 会读不到）
  const teamNow = readJson(TEAM_FILE, { members: [] });
  for (const m of teamNow.members || []) if (m && m.role === 'product') m.sessionId = 'session-28b8-current-product';
  writeJson(TEAM_FILE, teamNow);
  const manifestNow = readJson(path.join(PROJECT_DIR, '团队会话.json'), { roles: [] });
  for (const r of manifestNow.roles || []) if (r && r.role === 'product') r.sessionId = 'session-28b8-current-product';
  writeJson(path.join(PROJECT_DIR, '团队会话.json'), manifestNow);

  const filesBefore = archiveFiles().length;
  const teamShaBeforeSkip = sha(TEAM_FILE);
  const skipOut = archiveMod.archiveRotatedSession({
    projectName: PROJECT, role: 'product', oldSessionId: 'session-28b8-current-product', newSessionId: 'session-28b8-other-product', now: limitBase,
  });
  check('AC4① oldSessionId === currentSessionOf(role) → skipped/unchanged，且无新 A-*.json',
    skipOut.result === 'skipped' && skipOut.reason === 'unchanged' && archiveFiles().length === filesBefore,
    { outcome: skipOut, before: filesBefore, after: archiveFiles().length });
  check('AC4③ 归档前后 团队.json 名册 sha256 不变（归档不改名册）',
    sha(TEAM_FILE) === teamShaBeforeSkip, {});

  // 沙盘默认 stub（TEAM_SELFTEST=1）：只记账不真归档
  delete process.env.TEAM_ARCHIVE_STUB;
  const filesBeforeStub = archiveFiles().length;
  const stubOut = archiveMod.archiveRotatedSession({
    projectName: PROJECT, role: 'product', oldSessionId: oldId('product'), newSessionId: 'session-28b8-stub-product', now: limitBase,
  });
  check('AC4② TEAM_SELFTEST=1（默认）→ stubbed，不写 A-*.json（真实 会话归档/ 目录前后无新增）',
    stubOut.result === 'stubbed' && stubOut.reason === 'selftest_stub' && archiveFiles().length === filesBeforeStub,
    { outcome: stubOut, before: filesBeforeStub, after: archiveFiles().length });

  /* ── 老调用不回归：不传 sessionId 仍取 currentSessionOf ─────────────── */
  const legacy = archiveMod.archiveSession({ projectName: PROJECT, role: 'analyst', reason: 'legacy-call', skipTranscript: true });
  check('AC1′ 老调用不回归：archiveSession 不传 sessionId 仍按 currentSessionOf 归档',
    Boolean(legacy && legacy.record) && String(legacy.record.sessionId) === rosterOf('analyst'),
    { record: legacy && { id: legacy.record.id, sessionId: legacy.record.sessionId }, current: rosterOf('analyst') });

  /* ── 接线：三条调用链都在（静态锚点；运行时行为已由上面 AC1/AC3 覆盖） ── */
  const sessionSrc = fs.readFileSync(SESSION_MJS, 'utf8');
  const autoSrc = fs.readFileSync(AUTO_ROTATE_MJS, 'utf8');
  const routeSrc = fs.readFileSync(ROUTE_MJS, 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  check('接线① session rotate 成功后调 archiveRotatedSession（source=session-rotate）',
    /archiveRotatedSession\(\{/.test(sessionSrc) && /source: 'session-rotate'/.test(sessionSrc),
    { hit: /archiveRotatedSession\(\{/.test(sessionSrc) });
  check('接线② auto-rotate 成功后调 archiveRotatedSession + 审计 stage=archive / ARCHIVE_<RESULT>',
    /archiveRotatedSession\(\{/.test(autoSrc) && /stage: 'archive'/.test(autoSrc) && /ARCHIVE_\$\{/.test(autoSrc),
    { call: /archiveRotatedSession\(\{/.test(autoSrc), stage: /stage: 'archive'/.test(autoSrc), code: /ARCHIVE_\$\{/.test(autoSrc) });
  check('接线③ routeTick 每拍调 sweepDeferredArchives（异常隔离在 try 内）',
    /sweepDeferredArchives\(\{ projectName: name, now, limit: 5 \}\)/.test(routeSrc),
    { hit: /sweepDeferredArchives\(/.test(routeSrc) });
  check('接线④ 主进程 team:session-queue 读 会话归档.jsonl 并传 archiveRows 给 model（不新增轮询）',
    /readArchiveLogCached/.test(mainSrc) && /archiveRows/.test(mainSrc) && /会话归档\.jsonl/.test(mainSrc),
    { cache: /readArchiveLogCached/.test(mainSrc), rows: /archiveRows/.test(mainSrc) });

  /* ── 真实树零写入 ──────────────────────────────────────────────────── */
  check('隔离：真实 团队/状态/项目/工作台改造修复/会话归档.jsonl 不存在（沙盘不写真实树）',
    !fs.existsSync(REAL_LEDGER) && realBefore.ledgerExists === false,
    { exists: fs.existsSync(REAL_LEDGER), existedBefore: realBefore.ledgerExists });
  check('隔离：真实 团队.json / workbench.json 前后 sha256 不变',
    sha(REAL_TEAM) === realBefore.team && sha(REAL_STORE) === realBefore.store,
    { teamSame: sha(REAL_TEAM) === realBefore.team, storeSame: sha(REAL_STORE) === realBefore.store });

  summary();
}

function summary() {
  const failed = results.filter((r) => !r.ok);
  // 证据落点：账本 sha256 + archived 行 + 轮换记录 archive 段（AC5② 要求「贴 sha256」）
  const artifacts = {};
  try {
    const buf = fs.readFileSync(LEDGER);
    artifacts.ledgerFile = LEDGER;
    artifacts.ledgerBytes = buf.length;
    artifacts.ledgerSha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const rows = jsonlRows(LEDGER);
    artifacts.ledgerRows = rows.length;
    artifacts.archivedRows = rows.filter((r) => String(r.result) === 'archived')
      .map((r) => ({ at: r.at, role: r.role, oldSessionId: r.oldSessionId, newSessionId: r.newSessionId, result: r.result, reason: r.reason, archiveId: r.archiveId, attempts: r.attempts }));
    artifacts.rotateArchives = (() => {
      try {
        return fs.readdirSync(ROT_DIR).filter((n) => n.endsWith('.json') && !n.startsWith('S-'))
          .map((n) => ({ role: n.replace(/\.json$/, ''), archive: (readJson(path.join(ROT_DIR, n), {}).archive || null) }));
      } catch { return []; }
    })();
  } catch { /* 证据采集失败不影响结论 */ }
  const payload = {
    ok: failed.length === 0,
    project: PROJECT,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    sandbox: SB,
    at: new Date().toISOString(),
    artifacts,
    checks: results,
  };
  if (OUT_ARG) {
    try { fs.mkdirSync(path.dirname(OUT_ARG), { recursive: true }); fs.writeFileSync(OUT_ARG, JSON.stringify(payload, null, 2) + '\n', 'utf8'); } catch { /* 证据落盘失败不改变结论 */ }
  }
  if (JSON_OUT) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log('');
    for (const f of failed) console.log(`FAILED  ${f.name} :: ${String(JSON.stringify(f.detail)).slice(0, 500)}`);
    console.log(`28b8 ARCHIVE CHECK ${failed.length ? 'FAIL' : 'OK'} ${results.length - failed.length}/${results.length} PASS`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('28b8 ARCHIVE CHECK ERROR ' + String((e && e.stack) || e));
  process.exit(1);
});
