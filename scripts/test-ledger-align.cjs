#!/usr/bin/env node
'use strict';
/**
 * R-9fbe / 账本对齐（PM 线索 M-20261115-081755-b83373 · 返工 B-20261115-081703-73eb 收尾）
 *
 * 断言目标（AC：「req sync 0 违规 ⇒ 面板分叉 = 0」）：
 *   ① 面板分叉数只来自 ledger 判据（view.ledgerFork / snapshot.ledger.forks / counts.ledgerForks）；
 *   ② 返工在途（ledgerInFlight）单独渲染「返工在途」，绝不进分叉计数；
 *   ③ 真数据上「壳层快照分叉」与「team.mjs req sync」逐 id 一致 —— req sync 0 违规时面板必须 0 分叉；
 *   ④ 快照缺 ledger 字段才回退旧算法，且自报「旧判据」（不与真源条两个口径同一个数字）。
 *
 * 隔离：沙盘 _tmp/ledger-align-<ts>/团队（复制真实 团队/，清 sessionId/activeProject/启动），
 *      真实 data/userdata 与 团队/状态/团队.json/工作流.json 只读（前后比对 mtime+size 并断言未变）。
 * 证据：项目/工作台改造修复/程序员A/产出/证据-ed7-fix/ledger-align-result.json + ledger-align.log
 * 用法：node scripts/test-ledger-align.cjs       退出码 0=全绿，1=有红，2=脚本自身异常
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'src', 'renderer', 'app.js');
const REAL_TEAM = path.join(ROOT, '团队');
const REAL_STATE = path.join(REAL_TEAM, '状态', '项目', '工作台改造修复');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const TEAM_FILE = path.join(REAL_TEAM, '状态', '团队.json');
const WF_FILE = path.join(REAL_STATE, '工作流.json');
const PROJECT = '工作台改造修复';
const PROJECT_PATH = path.join(ROOT, '项目', PROJECT);
const EVID = path.join(ROOT, '项目', PROJECT, '程序员A', '产出', '证据-ed7-fix');
const REGION_START = '/* #region panel-hints-core';
const REGION_END = '/* #endregion panel-hints-core */';

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const BASE = path.join(ROOT, '_tmp', 'ledger-align-' + stamp);
const TEAM_ROOT = path.join(BASE, '团队');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');

const results = [];
const lines = [];
function log(text) { const line = String(text); lines.push(line); console.log(line); }
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(detail).slice(0, 500)}`);
  if (!ok) process.exitCode = 1;
  return Boolean(ok);
}
const statStamp = (file) => {
  try { const s = fs.statSync(file); return `${s.size}:${Math.round(s.mtimeMs)}`; } catch { return 'missing'; }
};
const ISOLATION = [TEAM_FILE, WF_FILE, REAL_STORE];
const before = ISOLATION.map(statStamp);

// ── 沙盘 ────────────────────────────────────────────────────────────────
log('=== 0. 沙盘（复制真实 团队/，清 sessionId / activeProject / 启动） ===');
fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(BASE, { recursive: true });
fs.cpSync(REAL_TEAM, TEAM_ROOT, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
const teamJson = JSON.parse(fs.readFileSync(path.join(TEAM_ROOT, '状态', '团队.json'), 'utf8'));
for (const member of teamJson.members || []) member.sessionId = '';
teamJson.activeProject = '';
fs.writeFileSync(path.join(TEAM_ROOT, '状态', '团队.json'), JSON.stringify(teamJson, null, 2) + '\n', 'utf8');
const bootDir = path.join(TEAM_ROOT, '状态', '启动');
const clearedBoot = fs.existsSync(bootDir) ? fs.readdirSync(bootDir).filter((f) => f.endsWith('.json')) : [];
for (const file of clearedBoot) fs.rmSync(path.join(bootDir, file), { force: true });
log(`沙盘 = ${BASE}`);
log(`清空 members[].sessionId = ${(teamJson.members || []).length}；清 启动/*.json = ${clearedBoot.length}`);

const toolEnv = { ...process.env, TEAM_ROOT, TEAM_SELFTEST: '1' };
delete toolEnv.TEAM_PROJECTS_ROOT;
function runTool(args) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: BASE, env: toolEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    const text = String(out);
    for (let i = text.lastIndexOf('{'); i >= 0; i = text.lastIndexOf('{', i - 1)) {
      try { return JSON.parse(text.slice(i)); } catch { /* 往前找 JSON 起点 */ }
    }
    return { ok: false, raw: text.slice(0, 300) };
  } catch (error) {
    const text = String((error && error.stdout) || '') + String((error && error.stderr) || '');
    for (let i = text.lastIndexOf('{'); i >= 0; i = text.lastIndexOf('{', i - 1)) {
      try { return JSON.parse(text.slice(i)); } catch { /* 往前找 JSON 起点 */ }
    }
    return { ok: false, raw: text.slice(0, 300) };
  }
}

// ── 抽取面板纯函数段（与 scripts/test-panel-hints.cjs 同一口径） ─────────
const source = fs.readFileSync(APP, 'utf8');
const startAt = source.indexOf(REGION_START);
const endAt = source.indexOf(REGION_END);
if (startAt < 0 || endAt <= startAt) { console.error('抽取失败：找不到 panel-hints-core 标记'); process.exit(2); }
const region = source.slice(startAt, endAt + REGION_END.length);
function extractEsc(text) {
  const marker = 'const esc = (value) =>';
  const from = text.indexOf(marker);
  if (from < 0) return null;
  const to = text.indexOf('}[ch]));', from);
  if (to < 0) return null;
  return text.slice(from, to + '}[ch]));'.length);
}
let api;
try {
  api = vm.runInNewContext(`(function () {\n${region}\n${extractEsc(source) || "const esc = (value) => String(value ?? '');"}\nreturn { ledgerViewFromSnapshot, ledgerMarkupFromView, ledgerForkRow, ledgerRowNote, legacyRequirementLedger };\n})()`, { console, Date, Math, JSON }, { timeout: 5000 });
} catch (error) {
  console.error('抽取段执行失败：', (error && error.stack) || error);
  process.exit(2);
}
const countOf = (markup, attr) => {
  const hit = new RegExp(`${attr}="(\\d+)"`).exec(String(markup || ''));
  return hit ? Number(hit[1]) : null;
};

// ── 1. 真数据：工具侧 req sync ──────────────────────────────────────────
log('\n=== 1. 工具侧 team.mjs req sync（PM 实际跑的那条，沙盘） ===');
const boot = runTool(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-ledger-align', '--json']);
if (!boot || !boot.token) { log('boot 失败：' + JSON.stringify(boot).slice(0, 300)); process.exit(2); }
const sync = runTool(['req', 'sync', '--project', PROJECT, '--boot', String(boot.token), '--json']);
const violations = Array.isArray(sync.violations) ? sync.violations : [];
const syncForks = Array.isArray(sync.ledger && sync.ledger.forks) ? sync.ledger.forks : [];
const syncFlight = Array.isArray(sync.ledger && sync.ledger.inFlight) ? sync.ledger.inFlight : [];
log(`req sync ok(0 违规) = ${Boolean(sync.ok)}；violations = ${violations.length}；warnings = ${(sync.warnings || []).length}`);
log(`工具 ledger.forks = ${syncForks.length}；ledger.inFlight = ${syncFlight.length}；workflowRows = ${sync.workflowRows}`);
for (const w of sync.warnings || []) log(`  提醒 [${w.rule}] count=${w.count}`);

// ── 2. 真数据：壳层快照 + 面板视图 ──────────────────────────────────────
log('\n=== 2. 壳层快照 readWorkflowSnapshot + 面板视图（同沙盘、同一份真源） ===');
process.env.TEAM_ROOT = TEAM_ROOT;
process.env.TEAM_SELFTEST = '1';
delete process.env.TEAM_PROJECTS_ROOT;
const tools = require(path.join(ROOT, 'src', 'team-tools.js'));
const snap = tools.readWorkflowSnapshot(PROJECT, PROJECT_PATH);
if (!snap || snap.ok === false) { log('快照失败：' + JSON.stringify(snap).slice(0, 300)); process.exit(2); }
const reqs = Array.isArray(snap.requirements) ? snap.requirements : [];
const shellForks = Array.isArray(snap.ledger && snap.ledger.forks) ? snap.ledger.forks : [];
const shellFlight = Array.isArray(snap.ledger && snap.ledger.inFlight) ? snap.ledger.inFlight : [];
const view = api.ledgerViewFromSnapshot({
  hasWorkflow: true,
  requirements: reqs,
  ledger: snap.ledger || null,
  counts: snap.counts || null
});
const markup = api.ledgerMarkupFromView(view, {
  statusLabel: (req) => String((req && req.status) || ''),
  actionAvailable: { taskRelease: true, requirementReopen: true },
  actionEnabled: { taskRelease: true, requirementReopen: true },
  projectName: PROJECT
});
const panelCount = countOf(markup, 'data-ledger-count');
const panelFlight = countOf(markup, 'data-ledger-inflight-count');
log(`快照 ledger.forks = ${shellForks.length}；ledger.inFlight = ${shellFlight.length}；counts.ledgerForks = ${snap.counts.ledgerForks}`);
log(`面板视图 source = ${view.source}；count = ${view.count}；渲染 data-ledger-count = ${panelCount}；data-ledger-inflight-count = ${panelFlight}`);
log(`需求行 = ${reqs.length}；任务行 = ${(snap.tasks || []).length}`);

const ids = (list) => list.map((row) => String(row.requirementId || '')).sort();
// ── 3. AC 断言（真数据） ────────────────────────────────────────────────
log('\n=== 3. 真数据断言：两侧同源 + 「req sync 0 违规 ⇒ 面板分叉 0」 ===');
check('真数据：壳层快照分叉 id 集合 与 req sync 完全一致',
  JSON.stringify(ids(shellForks)) === JSON.stringify(ids(syncForks)), { shell: ids(shellForks), tool: ids(syncForks) });
check('真数据：壳层在途 id 集合 与 req sync 完全一致',
  JSON.stringify(ids(shellFlight)) === JSON.stringify(ids(syncFlight)), { shell: ids(shellFlight), tool: ids(syncFlight) });
check('真数据：counts.ledgerForks === req sync 分叉数',
  Number(snap.counts.ledgerForks) === syncForks.length, { counts: snap.counts.ledgerForks, sync: syncForks.length });
check('真数据：每行 ledgerFork 非 null 的条数 === counts.ledgerForks',
  reqs.filter((row) => row && row.ledgerFork).length === Number(snap.counts.ledgerForks));
check('真数据：面板分叉数 === counts.ledgerForks（渲染与快照同数）',
  panelCount === Number(snap.counts.ledgerForks), { panel: panelCount, counts: snap.counts.ledgerForks });
check('真数据：面板来源标 snapshot（不是旧算法回退）', view.source === 'snapshot' && markup.includes('data-ledger-source="snapshot"'), { source: view.source });
// AC 核心：req sync 0 违规 ⇒ 面板分叉 = 0
const acOk = sync.ok ? panelCount === 0 : true;
check('AC「req sync 0 违规 ⇒ 面板分叉 = 0」', acOk, { syncOk: sync.ok, violations: violations.length, panelCount });
check('AC 等价式：req sync 违规为 0 与面板分叉为 0 判定一致',
  Boolean(sync.ok) === (panelCount === 0), { syncOk: Boolean(sync.ok), panelCount });
check('真数据：返工在途 > 0 时仍是 0 分叉（在途不进分叉计数）',
  !(Number(snap.counts.ledgerInFlight) > 0) || panelCount === 0,
  { inFlight: snap.counts.ledgerInFlight, panelCount });
check('真数据：在途有单独的数字出口 data-ledger-inflight-count',
  Number(snap.counts.ledgerInFlight) === 0 || panelFlight === Number(snap.counts.ledgerInFlight),
  { panelFlight, countsInFlight: snap.counts.ledgerInFlight });

// 旧算法误报清零：真数据上任何需求行都不得渲染「工作流未收口」旧判据
const legacyNotes = reqs.map((row) => ({ id: String(row.id || ''), note: api.ledgerRowNote(row) }))
  .filter(({ note }) => note.kind === 'legacy' || String(note.label || '').includes('工作流未收口'));
check('真数据：没有任何需求行渲染旧判据「工作流未收口」（ledgerRowNote 全量扫）',
  legacyNotes.length === 0, { hits: legacyNotes.slice(0, 5) });
const oldAlgoFalse = reqs.filter((row) => {
  const legacy = api.legacyRequirementLedger(row);
  return legacy.staleDone || legacy.staleOpen;
});
log(`（对照）同一份真数据上旧算法会误判 ${oldAlgoFalse.length} 条：${oldAlgoFalse.map((r) => r.id).join(', ') || '无'}`);
check('真数据：旧算法的误报条数 ≠ 面板分叉数时，面板只认 ledger（不跟着误报跑）',
  panelCount === Number(snap.counts.ledgerForks),
  { panelCount, oldAlgo: oldAlgoFalse.length });

// ── 4. 夹具：分叉/在途/回退三态 ─────────────────────────────────────────
log('\n=== 4. 夹具断言（ledger.forks=0 且在途>0 / forks=1 / 缺字段回退） ===');
const fixtureFlight = {
  hasWorkflow: true,
  requirements: [{ id: 'R-FIX-INFLIGHT', status: 'dev', taskStatus: 'done', reopenedAt: '2026-11-14T17:34:20.958Z', ledgerFork: null, ledgerInFlight: 'rework_in_flight' }],
  ledger: { forks: [], inFlight: [{ requirementId: 'R-FIX-INFLIGHT', kind: 'rework_in_flight', status: 'dev', reopenedAt: '2026-11-14T17:34:20.958Z', taskDoneAt: '2026-11-14T05:22:50.560Z' }] },
  counts: { ledgerForks: 0, ledgerInFlight: 1 }
};
const viewFlight = api.ledgerViewFromSnapshot(fixtureFlight);
const markupFlight = api.ledgerMarkupFromView(viewFlight, { statusLabel: (req) => String((req && req.status) || ''), actionAvailable: {} });
check('夹具1：ledger.forks=0 + inFlight>0 → data-ledger-count === 0', countOf(markupFlight, 'data-ledger-count') === 0, { markup: markupFlight.slice(0, 240) });
check('夹具1：不渲染任何分叉行（无 data-ledger-fork=）', !probeAttr(markupFlight, 'data-ledger-fork'), { markup: markupFlight.slice(0, 240) });
check('夹具1：行文案含「返工在途」', markupFlight.includes('返工在途'));
check('夹具1：在途条数单列 data-ledger-inflight-count === 1', countOf(markupFlight, 'data-ledger-inflight-count') === 1);
check('夹具1：卡片小字 kind=inflight 且含「不计分叉」',
  api.ledgerRowNote(fixtureFlight.requirements[0]).kind === 'inflight' && api.ledgerRowNote(fixtureFlight.requirements[0]).label.includes('不计分叉'));

const fixtureFork = {
  hasWorkflow: true,
  requirements: [{ id: 'R-FIX-FORK', status: 'dev', taskStatus: 'done', reopenedAt: '', ledgerFork: { kind: 'dev_ledger_ahead', taskId: 'T-FIX-1', taskDoneAt: '2026-11-15T01:00:00.000Z', reopenedAt: '' }, ledgerInFlight: '' }],
  ledger: { forks: [{ requirementId: 'R-FIX-FORK', status: 'dev', kind: 'dev_ledger_ahead', taskId: 'T-FIX-1', taskDoneAt: '2026-11-15T01:00:00.000Z', reopenedAt: '' }], inFlight: [] },
  counts: { ledgerForks: 1, ledgerInFlight: 0 }
};
const viewFork = api.ledgerViewFromSnapshot(fixtureFork);
const markupFork = api.ledgerMarkupFromView(viewFork, { statusLabel: (req) => String((req && req.status) || ''), actionAvailable: {} });
check('夹具2：ledger.forks=1 → data-ledger-count === 1', countOf(markupFork, 'data-ledger-count') === 1, { markup: markupFork.slice(0, 240) });
check('夹具2：渲染 1 条分叉行（data-ledger-fork=R-FIX-FORK）', probeAttr(markupFork, 'data-ledger-fork') === 'R-FIX-FORK');
check('夹具2：分叉行是 warn（橙）不是 block（红）', markupFork.includes('data-panel-level="warn"') && !markupFork.includes('禁止推进'));
check('夹具2：卡片小字 kind=fork', api.ledgerRowNote(fixtureFork.requirements[0]).kind === 'fork');

const fixtureLegacy = { hasWorkflow: true, requirements: [{ id: 'R-FIX-OLD', status: 'dev', taskStatus: 'done' }], ledger: null, counts: {} };
const viewLegacy = api.ledgerViewFromSnapshot(fixtureLegacy);
const markupLegacy = api.ledgerMarkupFromView(viewLegacy, { statusLabel: (req) => String((req && req.status) || ''), actionAvailable: {} });
check('夹具3：快照缺 ledger 字段 → 回退旧算法且容器标 data-ledger-source="legacy"',
  viewLegacy.source === 'legacy' && markupLegacy.includes('data-ledger-source="legacy"'), { source: viewLegacy.source });
check('夹具3：回退时 UI 明示「旧判据」', markupLegacy.includes('旧算法') || markupLegacy.includes('旧判据'));
check('夹具3：回退时卡片小字也自报「旧判据」', api.ledgerRowNote(fixtureLegacy.requirements[0]).label.includes('旧判据'));

// ── 5. 源码级：分叉计数只来自 ledger 字段 ───────────────────────────────
log('\n=== 5. 源码级断言（src/renderer/app.js） ===');
const viewFn = source.slice(source.indexOf('function ledgerViewFromSnapshot'), source.indexOf('/** 分叉行文案'));
check('源码：分叉只由 ledgerFork / ledger.forks 收集（legacy 只在 !snapshotReady 分支）',
  viewFn.includes("if (req && req.ledgerFork) view.forks.push") && viewFn.includes('if (!snapshotReady)'), { slice: viewFn.slice(0, 160) });
check('源码：在途只进 view.inFlight，不进 view.forks',
  viewFn.includes('view.inFlight.push') && !/view\.forks\.push\([^)]*[iI]nFlight/.test(viewFn));
check('源码：inFlightCount 与 count 分两个字段（不合并）',
  viewFn.includes('view.count = Math.max(view.forks.length') && viewFn.includes('view.inFlightCount = Math.max(view.inFlight.length'));
check('源码：需求卡片不再调旧算法（改 ledgerRowNote）',
  !source.slice(source.indexOf('function legacyRequirementCard'), source.indexOf('function syncLegacyGlobalReqButtons')).includes('legacyRequirementLedger'));
const oldAlgoCalls = source.split('legacyRequirementLedger(').length - 1;
check('源码：旧算法只剩「定义 + 两处回退」（无第三个调用点）', oldAlgoCalls === 3, { calls: oldAlgoCalls });

function probeAttr(markup, attr) {
  const hit = new RegExp(`${attr}="([^"]*)"`).exec(String(markup || ''));
  return hit ? hit[1] : null;
}

// ── 6. 隔离 ────────────────────────────────────────────────────────────
log('\n=== 6. 隔离（真实状态文件未被写） ===');
const after = ISOLATION.map(statStamp);
check('真实 团队/状态/团队.json、工作流.json、data/userdata/workbench.json 未被改动',
  before.every((value, index) => value === after[index]),
  { targets: ISOLATION.map((file, i) => ({ file: path.basename(file), before: before[i], after: after[i] })) });

// ── 落盘 ────────────────────────────────────────────────────────────────
const passed = results.filter((row) => row.ok).length;
const failed = results.length - passed;
log(`\n账本对齐断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
fs.mkdirSync(EVID, { recursive: true });
const report = {
  requirement: 'R-20261115-061249-9fbe',
  clue: 'M-20261115-081755-b83373',
  rework: 'B-20261115-081703-73eb',
  at: new Date().toISOString(),
  app: 'src/renderer/app.js',
  sandbox: BASE,
  real: {
    project: PROJECT,
    path: PROJECT_PATH,
    requirements: reqs.length,
    tasks: (snap.tasks || []).length,
    counts: snap.counts,
    ledger: { forks: shellForks, inFlight: shellFlight }
  },
  reqSync: { ok: sync.ok, violations, warnings: (sync.warnings || []).map((w) => ({ rule: w.rule, count: w.count })), forks: syncForks, inFlight: syncFlight },
  panel: { source: view.source, count: view.count, inFlightCount: view.inFlightCount, renderedCount: panelCount, renderedInFlight: panelFlight },
  oldAlgorithm: { falseForks: oldAlgoFalse.map((row) => row.id), count: oldAlgoFalse.length },
  isolation: { targets: ISOLATION, before, after, ok: before.every((v, i) => v === after[i]) },
  passed, failed, ok: failed === 0, results
};
fs.writeFileSync(path.join(EVID, 'ledger-align-result.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(EVID, 'ledger-align.log'), lines.join('\n') + '\n', 'utf8');
log(`证据：${path.join(EVID, 'ledger-align-result.json')}`);
if (failed) process.exitCode = 1;
