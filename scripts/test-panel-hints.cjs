#!/usr/bin/env node
'use strict';
/**
 * R-9fbe / T-20261115-063058-cda1 断言：面板提示分级（block/warn/info）+ 账本分叉 + boot 口径。
 *
 * 覆盖：
 *   ① 单一分级函数：src/renderer/app.js 的 `panelSeverity` 是渲染层唯一分级入口，
 *      block 白名单以外一律 warn/info；`data-panel-level` 必须渲染到 DOM 上（AC1）。
 *   ② 账本分叉夹具（F-9fbe-7）：
 *        (a) 返工在途（reopen 后 task done）→ 0 分叉（快照 ledgerInFlight=rework_in_flight）
 *        (b) 真分叉（开发任务 done 且工作流未收口）→ 1 分叉 + 处置按钮 / 无命令提示
 *   ③ briefing 不可用（F-9fbe-3 / AC6）：显示「待核验」，**不出现** `0/6`，也不判红。
 *   ④ 源码级断言：
 *        - `禁止推进` 全场只出现一次，且落在 block 常量 PANEL_BLOCK_LABEL 上（warn 分支不得出现）；
 *        - `panelSeverity` / `panelGateState` / `data-panel-level` / `data-ledger-source` 存在。
 *
 * 做法：按 `#region panel-hints-core` 标记从 app.js 抽出纯函数段，在 vm 沙盘里跑夹具；
 * 夹具写独立数据根 `_tmp/panel-hints-<ts>/`，不碰真实 data/ 与 团队/状态/（脚本对比前后 mtime）。
 *
 * 用法：node scripts/test-panel-hints.cjs
 * 退出码：0 全绿；1 有失败；2 脚本自身异常（如标记缺失）。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'src', 'renderer', 'app.js');
const EVIDENCE_DIR = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-cda1');
const REGION_START = '/* #region panel-hints-core';
const REGION_END = '/* #endregion panel-hints-core */';

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const DATA_ROOT = path.join(ROOT, '_tmp', 'panel-hints-' + stamp);
const FIXTURE_DIR = path.join(DATA_ROOT, 'fixtures');

const lines = [];
function log(text) {
  const line = String(text);
  lines.push(line);
  console.log(line);
}

const results = [];
function check(name, ok, detail) {
  const row = { name, ok: Boolean(ok), detail: detail === undefined ? null : detail };
  results.push(row);
  log(`${row.ok ? 'PASS' : 'FAIL'}  ${name}${row.ok ? '' : '  ' + JSON.stringify(row.detail).slice(0, 420)}`);
  if (!row.ok) process.exitCode = 1;
  return row.ok;
}

// ── 隔离证据：真实状态文件 mtime 前后必须不变 ─────────────────────────────
function mtimeOf(target) {
  try { return fs.statSync(target).mtimeMs; } catch { return null; }
}
const ISOLATION_TARGETS = [
  path.join(ROOT, 'data', 'userdata', 'workbench.json'),
  path.join(ROOT, '团队', '状态', '团队.json')
];
const beforeMtime = ISOLATION_TARGETS.map(mtimeOf);

// ── 抽取纯函数段 + esc ───────────────────────────────────────────────────
const source = fs.readFileSync(APP, 'utf8');
const startAt = source.indexOf(REGION_START);
const endAt = source.indexOf(REGION_END);
if (startAt < 0 || endAt < 0 || endAt <= startAt) {
  console.error(`抽取失败：src/renderer/app.js 里找不到 ${REGION_START} / ${REGION_END} 标记`);
  process.exit(2);
}
const region = source.slice(startAt, endAt + REGION_END.length);

function extractEsc(text) {
  const marker = 'const esc = (value) =>';
  const from = text.indexOf(marker);
  if (from < 0) return null;
  const to = text.indexOf('}[ch]));', from);
  if (to < 0) return null;
  return text.slice(from, to + '}[ch]));'.length);
}
const escSource = extractEsc(source);
const harness = `(function () {
${region}
${escSource || "const esc = (value) => String(value ?? '');"}
return {
  panelSeverity, panelLevelLabel, panelLevelClass, panelGateState, panelGateMarkup,
  ledgerViewFromSnapshot, ledgerMarkupFromView, ledgerForkRow,
  bootRowFrom, bootSummaryFrom, bootCountText, bootStatusText,
  PANEL_SEVERITY_BLOCK_CODES, PANEL_BLOCK_LABEL
};
})()`;

let api;
try {
  api = vm.runInNewContext(harness, { console, Date, Math, JSON }, { timeout: 5000 });
} catch (error) {
  console.error('抽取段执行失败：', (error && error.stack) || error);
  process.exit(2);
}

// ── 源码级断言（AC4） ───────────────────────────────────────────────────
log('\n=== 源码级断言（src/renderer/app.js） ===');
check('源码：panelSeverity 存在（单一分级函数）', /function\s+panelSeverity\s*\(/.test(source));
check('源码：panelGateState 存在（全页共用同一份分级结论）', /function\s+panelGateState\s*\(/.test(source));
check('源码：渲染层写 data-panel-level', source.includes('data-panel-level'));
check('源码：账本容器写 data-ledger-source', source.includes('data-ledger-source'));
check('源码：boot 数字唯一显示口用 bootCountText', /function\s+bootCountText\s*\(/.test(source) && source.includes('bootCountText(boot)'));

const blockWord = '禁止推进';
const wordHits = [];
for (let i = source.indexOf(blockWord); i >= 0; i = source.indexOf(blockWord, i + 1)) wordHits.push(i);
check('源码：「禁止推进」全场只出现一次（其它位置一律走 panelLevelLabel）', wordHits.length === 1, { hits: wordHits.length });
const hitWindow = wordHits.length ? source.slice(Math.max(0, wordHits[0] - 900), wordHits[0] + 160) : '';
check('源码：「禁止推进」落在 block 常量 PANEL_BLOCK_LABEL 上', /const\s+PANEL_BLOCK_LABEL\s*=\s*'禁止推进'/.test(hitWindow), { window: hitWindow.slice(0, 200) });
check('源码：该常量紧邻 block 白名单（PANEL_SEVERITY_BLOCK_CODES）', hitWindow.includes('PANEL_SEVERITY_BLOCK_CODES'));
check('源码：warn 分支没有硬编码「禁止推进」',
  !/level\s*===\s*'warn'[^\n]{0,120}禁止推进/.test(source) && !/禁止推进[^\n]{0,80}level\s*===\s*'warn'/.test(source));
check('源码：warn 统一文案「可推进 · 待核验 N 项」', source.includes('可推进 · 待核验 ${n} 项') || source.includes('可推进 · 待核验 ${n} 项'));
check('源码：旧的「旧任务 done · 工作流未收口」误导文案已清除', !source.includes('旧任务 done · 工作流未收口'));
check('源码：旧的 boot X/N 硬拼（boot/已读 ${boot.complete}/${boot.total}）已清除',
  !source.includes('${boot.complete}/${boot.total}') && !source.includes("boot.complete + '/' + boot.total"));

// ── 分级函数本身 ────────────────────────────────────────────────────────
log('\n=== ① 单一分级函数 panelSeverity ===');
const blockCodes = [...api.PANEL_SEVERITY_BLOCK_CODES];
const blockSamples = ['PLACEHOLDER_DOC', 'WORKFLOW_TERMINATED', 'RULES_CHANGED', 'BOOT_REQUIRED',
  'REQUIREMENT_NOT_FOUND', 'PROJECT_DIR_MISSING', 'MISSING_DOC'];
check('block 白名单含 7 个指定错误码', blockSamples.every((code) => blockCodes.includes(code)), { blockCodes });
const severityOf = (topic) => api.panelSeverity(topic);
check('PLACEHOLDER_DOC → block', severityOf({ code: 'PLACEHOLDER_DOC', text: 'x' }).level === 'block');
check('WORKFLOW_TERMINATED → block', severityOf({ code: 'WORKFLOW_TERMINATED', text: 'x' }).level === 'block');
check('未知错误码 → warn（默认不红）', severityOf({ code: 'SOMETHING_NEW', text: 'x' }).level === 'warn');
check('level:info → info（中性灰）', severityOf({ code: 'X', level: 'info', text: 'x' }).level === 'info');
check('topic 自称 level:block 但错误码不在白名单 → 仍 warn（防越权分级）',
  severityOf({ code: 'NOT_IN_WHITELIST', level: 'block', text: 'x' }).level === 'warn');
check('返回值含 level/text/action 三件', (() => {
  const row = severityOf({ code: 'X', text: '文案', action: { kind: 'go', value: 'roles', label: '去 boot' } });
  return row.level && row.text === '文案' && row.action && row.action.kind === 'go';
})());
check('panelLevelLabel：block 返回拦截词，warn 返回「可推进 · 待核验 N 项」', api.panelLevelLabel('block') === api.PANEL_BLOCK_LABEL
  && api.panelLevelLabel('warn', 2) === '可推进 · 待核验 2 项'
  && api.panelLevelLabel('warn', 0).startsWith('可推进'));

// ── 夹具 (a)：返工在途 → 0 分叉 ──────────────────────────────────────────
log('\n=== 夹具 (a) 返工在途（reopen 后 task done）→ 0 分叉 ===');
const R_REWORK = 'R-20261115-300001-a001';
const fixtureRework = {
  hasWorkflow: true,
  requirements: [{
    id: R_REWORK,
    status: 'dev',
    taskStatus: 'done',
    reopenedAt: '2026-11-14T17:34:20.958Z',
    ledgerFork: null,
    ledgerInFlight: 'rework_in_flight'
  }],
  ledger: {
    forks: [],
    inFlight: [{ requirementId: R_REWORK, kind: 'rework_in_flight', status: 'dev', reopenedAt: '2026-11-14T17:34:20.958Z', taskDoneAt: '2026-11-14T05:22:50.560Z' }]
  },
  counts: { ledgerForks: 0, ledgerInFlight: 1 }
};
writeFixture('a-rework-in-flight.json', fixtureRework);
const viewRework = api.ledgerViewFromSnapshot(fixtureRework);
check('(a) 来源是快照（不是旧算法回退）', viewRework.source === 'snapshot', { source: viewRework.source });
check('(a) 分叉计数 = 0', viewRework.count === 0, { count: viewRework.count });
check('(a) 返工在途被计入 inFlight（只提示）', viewRework.inFlightCount === 1, { inFlightCount: viewRework.inFlightCount });
const reworkMarkup = api.ledgerMarkupFromView(viewRework, {
  statusLabel: (req) => String((req && req.status) || ''),
  actionAvailable: { taskRelease: false, requirementReopen: false }
});
check('(a) 不渲染分叉行', !reworkMarkup.includes('data-ledger-fork='), { markup: reworkMarkup.slice(0, 200) });
check('(a) 渲染「不计分叉」在途提示', reworkMarkup.includes('不计分叉') && reworkMarkup.includes('返工在途'));
check('(a) 容器标 data-ledger-source="snapshot"', reworkMarkup.includes('data-ledger-source="snapshot"'));
check('(a) 在途行挂 data-panel-level="info"（中性）', reworkMarkup.includes('data-panel-level="info"'));
check('(a) 在途不写「禁止推进」', !reworkMarkup.includes(api.PANEL_BLOCK_LABEL));

// ── 夹具 (b)：真分叉 → 1 分叉 + 处置入口 ────────────────────────────────
log('\n=== 夹具 (b) 真分叉（开发任务 done、工作流未收口）→ 1 分叉 ===');
const R_FORK = 'R-20261115-300002-a002';
const fixtureFork = {
  hasWorkflow: true,
  requirements: [{
    id: R_FORK,
    status: 'dev',
    taskStatus: 'done',
    reopenedAt: '',
    ledgerFork: { kind: 'dev_ledger_ahead', taskId: 'T-20261115-310002-0002', taskDoneAt: '2026-11-15T01:00:00.000Z', reopenedAt: '' },
    ledgerInFlight: ''
  }],
  ledger: { forks: [{ requirementId: R_FORK, status: 'dev', kind: 'dev_ledger_ahead', taskId: 'T-20261115-310002-0002', taskDoneAt: '2026-11-15T01:00:00.000Z', reopenedAt: '' }], inFlight: [] },
  counts: { ledgerForks: 1, ledgerInFlight: 0 }
};
writeFixture('b-ledger-fork.json', fixtureFork);
const viewFork = api.ledgerViewFromSnapshot(fixtureFork);
check('(b) 来源是快照', viewFork.source === 'snapshot', { source: viewFork.source });
check('(b) 分叉计数 = 1（view.ledgerFork 非 null 才算）', viewFork.count === 1 && viewFork.forks.length === 1, { count: viewFork.count });
const forkNoCmd = api.ledgerMarkupFromView(viewFork, {
  statusLabel: (req) => String((req && req.status) || ''),
  actionAvailable: { taskRelease: false, requirementReopen: false },
  projectName: '工作台改造修复'
});
check('(b) 容器 data-ledger-source="snapshot" data-ledger-count="1"',
  forkNoCmd.includes('data-ledger-source="snapshot"') && forkNoCmd.includes('data-ledger-count="1"'));
check('(b) 分叉行挂 data-panel-level="warn"（橙，不是红）', forkNoCmd.includes('data-panel-level="warn"'));
check('(b) 无后端 IPC 时明确写「本版后端无处置命令」+ 手动 team.mjs 命令',
  forkNoCmd.includes('本版后端无处置命令') && forkNoCmd.includes('team.mjs req reopen') && forkNoCmd.includes('team.mjs task release'));
check('(b) 无后端 IPC 时不出现处置按钮', !forkNoCmd.includes('data-ledger-action='));
const forkWithCmd = api.ledgerMarkupFromView(viewFork, {
  statusLabel: (req) => String((req && req.status) || ''),
  actionAvailable: { taskRelease: true, requirementReopen: true },
  projectName: '工作台改造修复'
});
check('(b) 后端有 IPC 时给出两个处置按钮（收口旧任务 / 重开需求记录）',
  forkWithCmd.includes('收口旧任务') && forkWithCmd.includes('重开需求记录')
  && forkWithCmd.includes('data-ledger-action="task-release"') && forkWithCmd.includes('data-ledger-action="requirement-reopen"'));
check('(b) 分叉行不出现「禁止推进」', !forkNoCmd.includes(api.PANEL_BLOCK_LABEL));

// ── 旧算法回退（快照缺字段时才用） ──────────────────────────────────────
log('\n=== 快照缺 ledger 字段 → 才回退旧算法 ===');
const legacyInput = {
  hasWorkflow: true,
  requirements: [{ id: 'R-OLD-1', status: 'dev', taskStatus: 'done' }],
  ledger: null,
  counts: {}
};
const viewLegacy = api.ledgerViewFromSnapshot(legacyInput);
check('快照缺字段 → source=legacy（容器会标 data-ledger-source="legacy"）', viewLegacy.source === 'legacy', { source: viewLegacy.source });
check('快照缺字段时旧算法仍能给出 1 条（不静默丢分叉）', viewLegacy.count === 1, { count: viewLegacy.count });
check('快照有字段（哪怕 0 分叉）就不回退旧算法', viewRework.source === 'snapshot' && viewFork.source === 'snapshot');

// ── 夹具 (c)：briefing 不可用 → 待核验、不出现 0/6、不判红 ───────────────
log('\n=== 夹具 (c) briefing 不可用 → 「待核验」且不出现 0/6 ===');
const roleIds = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
writeFixture('c-briefing-unavailable.json', { briefing: null, briefingError: { code: 'BRIEFING_FAILED', message: 'workflow:briefing 抛错' }, roleIds });
const summaryUnknown = api.bootSummaryFrom({ briefing: null, roleIds, round: 1, ttlMinutes: 480, now: Date.now() });
check('(c) bootSummary.known === false（没取到 briefing 不冒充已核验）', summaryUnknown.known === false);
check('(c) 数字文案是「待核验」，不是 0/6', api.bootCountText(summaryUnknown) === '待核验', { text: api.bootCountText(summaryUnknown) });
check('(c) N 仍取当前团队角色数（6）', summaryUnknown.total === 6, { total: summaryUnknown.total });
check('(c) 状态文案也是「boot 待核验」', api.bootStatusText(summaryUnknown) === 'boot 待核验');

const gateUnknown = api.panelGateState({
  phase: 'dev',
  hasPreload: true,
  hasDocs: false,
  docPendingRead: false,
  boot: { known: false, error: { code: 'BRIEFING_FAILED', message: '抛错' }, pending: 6, expired: 0, stale: 0, roundMismatch: 0, complete: 0, total: 6, source: 'roster', sourceLabel: '名册 members' },
  ledger: { known: true, source: 'snapshot', count: 0, inFlight: 0 },
  commandGaps: [],
  commandUnknowns: []
});
const gateUnknownHtml = api.panelGateMarkup(gateUnknown);
check('(c) briefing 失败不判 block（不当红项）', gateUnknown.level !== 'block', { level: gateUnknown.level });
check('(c) 显示「boot 待核验」+ 原因', gateUnknownHtml.includes('boot 待核验') && gateUnknownHtml.includes('BRIEFING_FAILED'));
check('(c) 不出现 0/6', !/0\s*\/\s*6/.test(gateUnknownHtml), { html: gateUnknownHtml.slice(0, 300) });
check('(c) 不出现「禁止推进」', !gateUnknownHtml.includes(api.PANEL_BLOCK_LABEL));
check('(c) 根节点 data-panel-level 可断言（info 灰）', /data-panel-level="info"/.test(gateUnknownHtml));
check('(c) 带重试按钮（data-legacy-refresh）', gateUnknownHtml.includes('data-legacy-refresh="1"'));

// ── 四种面板状态（AC1） ─────────────────────────────────────────────────
log('\n=== AC1 四种面板状态：block / warn / info / ok ===');
writeFixture('d-four-states.json', { note: '按 §四 F-9fbe-1 / AC1 构造' });
const baseInput = {
  phase: 'dev',
  hasPreload: true,
  hasDocs: true,
  docPendingRead: false,
  boot: { known: true, error: null, pending: 0, expired: 0, stale: 0, roundMismatch: 0, complete: 6, total: 6, source: 'roster', sourceLabel: '名册 members' },
  ledger: { known: true, source: 'snapshot', count: 0, inFlight: 0 },
  commandGaps: [],
  commandUnknowns: []
};
const gateBlock = api.panelGateState({ ...baseInput, placeholders: ['项目信息.md'] });
const gateWarn = api.panelGateState({ ...baseInput, ledger: { known: true, source: 'snapshot', count: 1, inFlight: 0 } });
const gateInfo = api.panelGateState({ ...baseInput, boot: { ...baseInput.boot, known: false, complete: 0, pending: 6, error: { code: 'BRIEFING_FAILED' } } });
const gateOk = api.panelGateState(baseInput);
check('AC1 真阻塞（项目铁律占位）→ block', gateBlock.level === 'block' && gateBlock.open === false, { level: gateBlock.level });
check('AC1 真阻塞才出现「禁止推进」', api.panelGateMarkup(gateBlock).includes(api.PANEL_BLOCK_LABEL));
check('AC1 提示（账本分叉）→ warn 且写「可推进 · 待核验 N 项」',
  gateWarn.level === 'warn' && gateWarn.title.includes('可推进 · 待核验 1 项') && !api.panelGateMarkup(gateWarn).includes(api.PANEL_BLOCK_LABEL),
  { level: gateWarn.level, title: gateWarn.title });
check('AC1 提示项是橙色并带按钮', /data-panel-level="warn"/.test(api.panelGateMarkup(gateWarn)) && api.panelGateMarkup(gateWarn).includes('data-legacy-ledger="1"'));
check('AC1 中性（briefing 未读）→ info（灰）', gateInfo.level === 'info', { level: gateInfo.level });
check('AC1 正常态 → ok', gateOk.level === 'ok' && gateOk.label.startsWith('可推进'), { level: gateOk.level });
check('AC1 正常态全页搜索「禁止推进」为 0（block 场景才出现）',
  !api.panelGateMarkup(gateOk).includes(api.PANEL_BLOCK_LABEL) && !api.panelGateMarkup(gateWarn).includes(api.PANEL_BLOCK_LABEL));

// ── TTL 只提示、不与红字同屏（AC3） ─────────────────────────────────────
log('\n=== AC3 TTL 只提示、不与红字同屏 ===');
const gateTtl = api.panelGateState({ ...baseInput, boot: { ...baseInput.boot, expired: 2 } });
const ttlHtml = api.panelGateMarkup(gateTtl);
check('TTL 过期 → warn（橙），不是 block', gateTtl.level === 'warn' && !ttlHtml.includes(api.PANEL_BLOCK_LABEL), { level: gateTtl.level });
check('TTL 行带 data-legacy-expired-summary + data-panel-level="warn"',
  ttlHtml.includes('data-legacy-expired-summary="1"') && ttlHtml.includes('data-panel-level="warn"'));
check('TTL 文案写「只提示，不拦推进」', ttlHtml.includes('只提示，不拦推进'));
const gateTtlWithBlock = api.panelGateState({
  ...baseInput,
  placeholders: ['项目信息.md'],
  boot: { ...baseInput.boot, expired: 2 }
});
const ttlBlockHtml = api.panelGateMarkup(gateTtlWithBlock);
check('有 block 时 TTL 提示不出现（不同屏）', gateTtlWithBlock.level === 'block' && !ttlBlockHtml.includes('data-legacy-expired-summary'));

// ── 数字同源 / 不重复（AC3） ────────────────────────────────────────────
log('\n=== AC3 数字唯一出处 ===');
const truthSource = source.slice(source.indexOf('function legacyTruthMarkup'), source.indexOf('function renderTruthStrip'));
check('真源条是 boot X/N 的唯一出处（用 bootCountText）', truthSource.includes('bootCountText(boot)'));
check('真源条是「文档待补 N」的唯一出处（用 readiness.label）', truthSource.includes('readiness.label'));
check('真源条是「账本分叉 N」的唯一出处', truthSource.includes('账本分叉 ${ledger.count}'));
check('真源条把账本来源挂 data-ledger-source', truthSource.includes('data-ledger-source='));
check('真源条把 boot 来源挂 data-boot-source', truthSource.includes('data-boot-source='));
check('真源条把文档缺口数挂 data-missing-doc-count（与 #missing-list 同源）', truthSource.includes('data-missing-doc-count="${readiness.missing.length}"'));
const gateResultSource = source.slice(source.indexOf('function legacyGateResultMarkup'), source.indexOf('function panelBlockReasonText'));
check('gate 结果不再拼 boot X/N（数字只在真源条）', !gateResultSource.includes('bootCountText'));
const ledgerMarkupFn = source.slice(source.indexOf('function legacyLedgerMarkup'), source.indexOf('function legacyRequirementLedger'));
check('账本详情块不再重复「账本分叉 N」大字（只留 data-ledger-count 属性）',
  !ledgerMarkupFn.includes('账本分叉 ${') && !ledgerMarkupFn.includes('账本分叉 ' + '${'));

// ── 隔离证据 + 结果落盘 ─────────────────────────────────────────────────
log('\n=== 隔离 ===');
const afterMtime = ISOLATION_TARGETS.map(mtimeOf);
const isolationOk = beforeMtime.every((value, index) => value === afterMtime[index]);
check('真实 data/userdata 与 团队/状态/团队.json 的 mtime 未被改动（独立数据根 _tmp/panel-hints-*）',
  isolationOk, { targets: ISOLATION_TARGETS.map((p, i) => ({ file: path.basename(p), before: beforeMtime[i], after: afterMtime[i] })) });

const passed = results.filter((row) => row.ok).length;
const failed = results.length - passed;
log(`\nR-9fbe 面板提示分级断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
const report = {
  requirement: 'R-20261115-061249-9fbe',
  task: 'T-20261115-063058-cda1',
  at: new Date().toISOString(),
  app: 'src/renderer/app.js',
  region: 'panel-hints-core',
  dataRoot: DATA_ROOT,
  passed,
  failed,
  ok: failed === 0,
  isolation: { targets: ISOLATION_TARGETS, before: beforeMtime, after: afterMtime, ok: isolationOk },
  results
};
fs.writeFileSync(path.join(EVIDENCE_DIR, 'panel-hints-result.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(EVIDENCE_DIR, 'panel-hints.log'), lines.join('\n') + '\n', 'utf8');
log(`证据：${path.join(EVIDENCE_DIR, 'panel-hints-result.json')}`);
if (failed) process.exitCode = 1;

function writeFixture(name, data) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(path.join(FIXTURE_DIR, name), JSON.stringify(data, null, 2) + '\n', 'utf8');
}
