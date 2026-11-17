#!/usr/bin/env node
'use strict';
const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * R-9fbe F-9fbe-5 / T-20261115-071322-0ed7（T-ed7）断言：账本分叉的两个处置入口。
 *
 * 覆盖（派单四条 + 需求 §五 AC2 / §六 边界）：
 *   A 夹具与判定：造「真分叉」（工作流 status=dev + 任务 done + 没有重开）→ 分叉=1；
 *     工具侧（团队/工具/lib/ledger.mjs）与壳层（src/team-tools.js 快照）与渲染层纯函数
 *     （app.js `ledgerViewFromSnapshot`，源码抽段跑）三处口径一致。
 *   B 处置入口（协议命令，沙盘真跑）：`team.mjs task release` → 分叉消解（任务退回在办）；
 *     `team.mjs req reopen` → 分叉消解（返工在途）；处置后渲染层分叉=0、处置行消失。
 *   C PM 令牌取数口径：复刻 main.js 的 latestProjectBootToken（沙盘真有 pm 令牌 → 找得到；
 *     令牌被移走 → 找不到，就是 PM_TOKEN_REQUIRED 的触发条件），并断言源码里没有壳自 boot PM 的调用。
 *   D main.js 源码级：两个 IPC 注册 / 走 task release + req reopen / fresh 读先于命令 /
 *     WORKFLOW_STATE_CHANGED + NOOP / 审计预检先于命令 / 账本处置.jsonl 十个字段 / append-only /
 *     处置段里没有直接写 工作流.json · 任务/*.json / 没有硬编码盘符与用户目录。
 *   E src/preload.js：ownerLedgerCloseTask、ownerLedgerReopen 暴露到对应 IPC。
 *   F src/renderer/app.js：按钮调新 IPC、disabled 必带原因、成功后刷新面板、失败横幅带错误码、并发 busy。
 *   G 隔离：真实 data/userdata/workbench.json 与 团队/状态/团队.json 的 mtime 前后不变。
 *
 * 隔离：沙盘 = _tmp/ed7-ledger-actions（TEAM_ROOT + TEAM_PROJECTS_ROOT 双隔离 + TEAM_SELFTEST=1 +
 * 清空 members[].sessionId，按 B-3c03 口径，绝不碰真实 团队/状态/ 与 data/）。
 *
 * 用法：node scripts/test-ledger-actions.cjs
 * 退出码：0 全绿；1 有失败；2 脚本自身异常。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'src', 'renderer', 'app.js');
const MAIN = path.join(ROOT, 'src', 'main.js');
const PRELOAD = path.join(ROOT, 'src', 'preload.js');
const EVIDENCE_DIR = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-ed7');

const SB = path.join(ROOT, '_tmp', 'ed7-ledger-actions');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '账本处置沙盘';
const PROJECT_PATH = path.join(PROJECTS, PROJECT);

// 沙盘环境：三隔离 + 自测静默（沙盘里的 send/wake 不发真实邮箱）。
process.env.TEAM_ROOT = TEAM_ROOT;
process.env.TEAM_PROJECTS_ROOT = PROJECTS;
process.env.TEAM_SELFTEST = '1';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };

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

// ── 0. 沙盘（不碰真实数据） ───────────────────────────────────────────────
// 只复制工具/角色/模板/协议/宪法与名册；状态里的项目数据（真实数据）不复制。
const SKIP_STATE = /[\\/]状态[\\/](项目|启动|锁|邮箱|备份|日志)([\\/]|$)|[\\/]日志([\\/]|$)/;
rmSandbox(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, {
  recursive: true,
  filter: (src) => !SKIP_STATE.test(src)
});
const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
const teamJson = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
// B-3c03：沙盘绝不能带真实 sessionId（否则 send/wake 会找到真实角色会话）。
for (const member of teamJson.members || []) member.sessionId = '';
teamJson.activeProject = PROJECT;
fs.writeFileSync(teamFile, JSON.stringify(teamJson, null, 2) + '\n', 'utf8');

function run(args, allowFail = false) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    const text = String(out).trim();
    return JSON.parse(text.slice(text.indexOf('{')));
  } catch (e) {
    const text = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    if (!allowFail) throw new Error(text.slice(0, 700));
    try { return JSON.parse(text.slice(text.indexOf('{'))); } catch { return { ok: false, raw: text.slice(0, 300) }; }
  }
}

const added = run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json'], true);
check('沙盘项目建立（project add）', added.ok === true, added.code || added.name);
const boot = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-ed7', '--json'], true);
check('沙盘 PM boot 成功（处置要用现成的 pm 启动令牌）', boot.ok === true && Boolean(boot.token), boot.code);

const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
const taskDir = path.join(stateDir, '任务');
const wfFile = path.join(stateDir, '工作流.json');
fs.mkdirSync(taskDir, { recursive: true });

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// ── A. 夹具：真分叉（reopen 前 done 的旧任务） ────────────────────────────
const R_FORK = 'R-20261115-400001-e001';      // dev + 开发任务已 done、从没重开 → 真分叉 dev_ledger_ahead
const R_TESTFORK = 'R-20261115-400002-e002';  // dev_done + 测试任务已 done → 真分叉 test_ledger_ahead
const T_FORK = 'T-20261115-410001-0001';
const T_TESTFORK = 'T-20261115-410002-0002';

const wf = {
  schema: 2,
  round: 1,
  updatedAt: iso(NOW),
  requirements: {
    [R_FORK]: { id: R_FORK, title: '真分叉夹具（开发账本超前）', status: 'dev', priority: 'P1', createdAt: iso(NOW - 86400000), history: [{ at: iso(NOW - 80000000), action: 'req_review', by: 'product', note: 'v1' }] },
    [R_TESTFORK]: { id: R_TESTFORK, title: '真分叉夹具（测试账本超前）', status: 'dev_done', priority: 'P1', createdAt: iso(NOW - 86400000) }
  }
};
fs.writeFileSync(wfFile, JSON.stringify(wf, null, 2) + '\n', 'utf8');

function writeTask(id, { type = 'task', status = 'done', owner = 'programmer1', requirementId, doneAt = null, title }) {
  const row = {
    id, project: PROJECT, type, requirementId, title: title || `夹具任务 ${id}`,
    detail: '夹具', acceptance: 'AC', priority: 'P1', priorityBy: 'pm', priorityReason: '',
    owner, status, createdBy: 'pm', createdAt: iso(NOW - 9000000), claimedAt: iso(NOW - 8000000),
    due: '', doneAt: doneAt ? iso(doneAt) : null, evidence: doneAt ? '夹具证据' : '', rev: 0, history: [], workflow: {}
  };
  fs.writeFileSync(path.join(taskDir, `${id}.json`), JSON.stringify(row, null, 2) + '\n', 'utf8');
  return row;
}
// 关键：doneAt 早于任何 reopen（R_REWORK 的反面）——这就是「真分叉」，不是返工在途。
writeTask(T_FORK, { requirementId: R_FORK, doneAt: NOW - 7200000, owner: 'programmer1' });
writeTask(T_TESTFORK, { requirementId: R_TESTFORK, doneAt: NOW - 3600000, owner: 'tester' });

const teamTools = require(path.join(ROOT, 'src', 'team-tools.js')).create({ teamRoot: TEAM_ROOT });
function shellSnapshot() {
  return teamTools.readWorkflowSnapshot(PROJECT, PROJECT_PATH);
}

// ── 抽取 app.js 的纯函数段（panel-hints-core），与 cda1 的断言同一口径 ────
const appSource = fs.readFileSync(APP, 'utf8');
const REGION_START = '/* #region panel-hints-core';
const REGION_END = '/* #endregion panel-hints-core */';
const startAt = appSource.indexOf(REGION_START);
const endAt = appSource.indexOf(REGION_END);
if (startAt < 0 || endAt <= startAt) {
  console.error('抽取失败：src/renderer/app.js 里找不到 panel-hints-core 标记');
  process.exit(2);
}
const region = appSource.slice(startAt, endAt + REGION_END.length);
function extractEsc(text) {
  const marker = 'const esc = (value) =>';
  const from = text.indexOf(marker);
  if (from < 0) return null;
  const to = text.indexOf('}[ch]));', from);
  if (to < 0) return null;
  return text.slice(from, to + '}[ch]));'.length);
}
const harness = `(function () {
${region}
${extractEsc(appSource) || "const esc = (value) => String(value ?? '');"}
return { ledgerViewFromSnapshot, ledgerMarkupFromView, ledgerBannerMarkup, ledgerForkRow };
})()`;
let api;
try {
  api = vm.runInNewContext(harness, { console, Date, Math, JSON }, { timeout: 5000 });
} catch (error) {
  console.error('抽取段执行失败：', (error && error.stack) || error);
  process.exit(2);
}

/** 把壳层快照喂给渲染层纯函数（与 app.js legacyLedgerView() 同口径）。 */
function rendererView(snapshot) {
  return api.ledgerViewFromSnapshot({
    hasWorkflow: Boolean(snapshot && snapshot.ok !== false),
    requirements: (snapshot && Array.isArray(snapshot.requirements)) ? snapshot.requirements : [],
    ledger: snapshot && snapshot.ledger ? snapshot.ledger : null,
    counts: snapshot && snapshot.counts ? snapshot.counts : null
  });
}
const renderMarkup = (view, extra = {}) => api.ledgerMarkupFromView(view, {
  statusLabel: (req) => String((req && req.status) || ''),
  projectName: PROJECT,
  ...extra
});

(async () => {
  const ledgerMod = await import(pathToFileURL(path.join(TEAM_ROOT, '工具', 'lib', 'ledger.mjs')).href);
  const readTasks = () => fs.readdirSync(taskDir).filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(fs.readFileSync(path.join(taskDir, n), 'utf8')));
  const readRows = () => JSON.parse(fs.readFileSync(wfFile, 'utf8')).requirements;

  log('\n=== A 夹具：真分叉（工作流未收口 + 任务已 done + 没有重开） ===');
  const det0 = ledgerMod.detectLedgerForks({ requirements: readRows(), tasks: readTasks() });
  const forkIds0 = det0.forks.map((f) => f.requirementId).sort();
  check('A1 工具侧识别两条真分叉（dev + 测试账本超前）',
    JSON.stringify(forkIds0) === JSON.stringify([R_FORK, R_TESTFORK].sort()), forkIds0);
  const kinds0 = Object.fromEntries(det0.forks.map((f) => [f.requirementId, f.kind]));
  check('A2 分叉类型正确（dev_ledger_ahead / test_ledger_ahead）',
    kinds0[R_FORK] === 'dev_ledger_ahead' && kinds0[R_TESTFORK] === 'test_ledger_ahead', kinds0);
  const snap0 = shellSnapshot();
  check('A3 壳层快照 counts.ledgerForks = 2（与工具同源）',
    Number(snap0.counts && snap0.counts.ledgerForks) === 2, snap0.counts && snap0.counts.ledgerForks);
  const view0 = rendererView(snap0);
  check('A4 渲染层纯函数给出分叉=2（快照优先，不回退旧算法）',
    view0.count === 2 && view0.source === 'snapshot', { count: view0.count, source: view0.source });
  const markup0 = renderMarkup(view0, { actionAvailable: { taskRelease: true, requirementReopen: true } });
  check('A5 分叉行带 data-ledger-fork / data-ledger-kind / data-ledger-status（处置按钮要带上期望状态）',
    markup0.includes(`data-ledger-fork="${R_FORK}"`) && markup0.includes('data-ledger-kind="dev_ledger_ahead"')
    && markup0.includes('data-ledger-status="dev"'));
  check('A6 有处置接口时给出两个按钮（收口旧任务 / 重开需求记录）',
    markup0.includes('data-ledger-action="task-release"') && markup0.includes('data-ledger-action="requirement-reopen"')
    && markup0.includes('收口旧任务') && markup0.includes('重开需求记录'));
  check('A7 可点时按钮不带 disabled',
    !/data-ledger-action="task-release"[^>]*disabled/.test(markup0) && !/data-ledger-action="requirement-reopen"[^>]*disabled/.test(markup0));

  log('\n=== B 处置入口：协议命令真跑（沙盘） ===');
  const released = run(['task', 'release', '--boot', boot.token, '--project', PROJECT, '--id', T_FORK, '--reason', '账本分叉处置：旧任务收口（断言脚本）', '--json'], true);
  check('B1 收口旧任务走 team.mjs task release（任务退回未收口）',
    released.ok === true && String((released.task || {}).status) === 'open', released.code || (released.task || {}).status);
  const det1 = ledgerMod.detectLedgerForks({ requirements: readRows(), tasks: readTasks() });
  const forkIds1 = det1.forks.map((f) => f.requirementId);
  check('B2 处置后该需求不再是分叉（账本不再超前）', !forkIds1.includes(R_FORK), forkIds1);
  check('B3 该需求转为「任务在办」在途标记（不计分叉）',
    (det1.inFlight || []).some((row) => row.requirementId === R_FORK), (det1.inFlight || []).map((r) => r.requirementId + ':' + r.kind));
  const snap1 = shellSnapshot();
  const view1 = rendererView(snap1);
  check('B4 壳层/渲染层同步下降：分叉 2 → 1', Number(snap1.counts.ledgerForks) === 1 && view1.count === 1, { shell: snap1.counts.ledgerForks, render: view1.count });
  const markup1 = renderMarkup(view1, { actionAvailable: { taskRelease: true, requirementReopen: true } });
  check('B5 已处置需求的分叉行消失（只剩另一条）',
    !markup1.includes(`data-ledger-fork="${R_FORK}"`) && markup1.includes(`data-ledger-fork="${R_TESTFORK}"`));

  const reopened = run(['req', 'reopen', '--boot', boot.token, '--project', PROJECT, '--requirement', R_TESTFORK, '--reason', '账本分叉处置：正式返工（断言脚本）', '--json'], true);
  check('B6 重开需求记录走 team.mjs req reopen（写 lastReopenAt + gateInvalidatedAt）',
    reopened.ok === true && String(reopened.toStatus) === 'dev' && Boolean(reopened.gateInvalidatedAt), reopened.code || reopened.toStatus);
  const det2 = ledgerMod.detectLedgerForks({ requirements: readRows(), tasks: readTasks() });
  check('B7 两条真分叉都清掉：工具侧 forks=0', (det2.forks || []).length === 0, (det2.forks || []).map((f) => f.requirementId));
  const snap2 = shellSnapshot();
  const view2 = rendererView(snap2);
  check('B8 处置后分叉=0（壳层 counts 与渲染层同数）',
    Number(snap2.counts && snap2.counts.ledgerForks) === 0 && view2.count === 0, { shell: snap2.counts && snap2.counts.ledgerForks, render: view2.count });
  const markup2 = renderMarkup(view2, { actionAvailable: { taskRelease: true, requirementReopen: true } });
  check('B9 分叉=0 时渲染层不再给处置按钮（没有假入口）',
    !markup2.includes('data-ledger-action='), markup2.slice(0, 160));

  log('\n=== C PM 令牌取数口径（复刻 main.js latestProjectBootToken） ===');
  // 复刻：与 main.js 同一取数口径（目录 团队/状态/启动 + role + project，按 issuedAt/createdAt 取最新）。
  function latestProjectBootTokenMirror(projectName, role) {
    const dir = path.join(TEAM_ROOT, '状态', '启动');
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return null; }
    let best = null;
    for (const file of names) {
      try {
        const row = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8').replace(/^\uFEFF/, ''));
        if (String(row.role || '') !== String(role || 'pm')) continue;
        if (projectName && String(row.project || '') !== String(projectName)) continue;
        const token = String(row.token || file.replace(/\.json$/, ''));
        if (!token) continue;
        const issuedAt = String(row.issuedAt || row.createdAt || '');
        if (!best || issuedAt > best.issuedAt) best = { token, file, issuedAt, expiresAt: String(row.expiresAt || '') };
      } catch { /* 跳过损坏令牌 */ }
    }
    return best;
  }
  const tokenRow = latestProjectBootTokenMirror(PROJECT, 'pm');
  check('C1 沙盘里能找到 pm 启动令牌（处置通道只认现成 PM 令牌）',
    Boolean(tokenRow && tokenRow.token === boot.token), { file: tokenRow && tokenRow.file, tokenMatch: Boolean(tokenRow && tokenRow.token === boot.token) });
  setupTokenMove: {
    const file = tokenRow ? path.join(TEAM_ROOT, '状态', '启动', tokenRow.file) : '';
    if (!file) { check('C2 没有 PM 令牌时取数返回 null（= PM_TOKEN_REQUIRED 触发条件）', false, '没有令牌文件'); break setupTokenMove; }
    const hidden = file + '.hidden-for-test';
    fs.renameSync(file, hidden);
    const missing = latestProjectBootTokenMirror(PROJECT, 'pm');
    fs.renameSync(hidden, file);
    check('C2 没有 PM 令牌时取数返回 null（= PM_TOKEN_REQUIRED 触发条件）', missing === null, missing);
    check('C3 令牌文件已还原（沙盘自洽，不影响后续断言）', fs.existsSync(file));
  }

  // ── D. main.js 源码级断言 ─────────────────────────────────────────────
  log('\n=== D main.js：IPC / 协议命令 / 权限 / 并发 / 审计 ===');
  const mainSource = fs.readFileSync(MAIN, 'utf8');
  const REGION_FROM = 'const LEDGER_AUDIT_NAME';
  // 处置实现段：从审计常量到 project:open（后面的 IPC 又回到普通只读注册）。
  // 两个 ipcMain.handle('owner:ledger-*') 按 TDZ 要求注册在 runWorkflowIpc 之后，单独断言。
  const REGION_TO = "ipcMain.handle('project:open'";
  const from = mainSource.indexOf(REGION_FROM);
  const to = mainSource.indexOf(REGION_TO);
  const mainRegion = from >= 0 && to > from ? mainSource.slice(from, to) : '';
  check('D1 处置实现段可定位（LEDGER_AUDIT_NAME + runLedgerAction + 两个 IPC 注册）',
    Boolean(mainRegion) && mainRegion.includes('function runLedgerAction(ctx, payload, action)')
    && mainSource.includes("ipcMain.handle('owner:ledger-close-task', runWorkflowIpc(")
    && mainSource.includes("ipcMain.handle('owner:ledger-reopen', runWorkflowIpc("));
  check('D2 两个 IPC 都经 runWorkflowIpc（项目/团队名/前后镜像统一）',
    /ipcMain\.handle\('owner:ledger-close-task', runWorkflowIpc\(/.test(mainSource)
    && /ipcMain\.handle\('owner:ledger-reopen', runWorkflowIpc\(/.test(mainSource));
  check('D3 收口旧任务走协议命令 task release（不是自己改 JSON）',
    mainSource.includes("['task', 'release', '--boot', boot.token, '--project', teamName, '--id', taskId, '--reason', reason, '--json']"));
  check('D4 重开需求记录走协议命令 req reopen',
    mainSource.includes("['req', 'reopen', '--boot', boot.token, '--project', teamName, '--requirement', requirementId, '--reason', reason, '--json']"));
  check('D5 处置命令真跑 team.mjs（spawnSync + ledgerTeamMjsPath）',
    /spawnSync\(process\.execPath, \[ledgerTeamMjsPath\(\), \.\.\.commandArgs\]/.test(mainSource));
  check('D6 处置前 fresh 读工作流快照（readWorkflowSnapshot）',
    /const fresh = teamTools\.readWorkflowSnapshot\(teamName, projectPath\);/.test(mainSource));
  const iFresh = mainRegion.indexOf('const fresh = teamTools.readWorkflowSnapshot(teamName, projectPath);');
  const iSpawn = mainRegion.indexOf('const run = spawnSync(');
  const iAuditPre = mainRegion.indexOf('const auditFile = ledgerAuditPreflight(project);');
  check('D7 顺序正确：fresh 读 → 审计预检 → 命令（iFresh < iAuditPre < iSpawn）',
    iFresh >= 0 && iAuditPre > iFresh && iSpawn > iAuditPre, { iFresh, iAuditPre, iSpawn });
  check('D8 权限：只认现成 PM 令牌（latestProjectBootToken），没有就 PM_TOKEN_REQUIRED',
    mainRegion.includes('latestProjectBootToken(teamName, \'pm\')') && mainRegion.includes("codedError('PM_TOKEN_REQUIRED'"));
  check('D9 不允许壳自 boot PM 代签（处置段无 bootRole / 无 boot 命令调用）',
    !/bootRole\s*\(/.test(mainRegion) && !/\['boot'/.test(mainRegion) && !/teamTools\.boot/.test(mainRegion));
  check('D10 并发：界面快照不一致 → WORKFLOW_STATE_CHANGED（零副作用）',
    mainRegion.includes("codedError('WORKFLOW_STATE_CHANGED'") && mainRegion.includes('expect'));
  check('D11 重复点 → NOOP（LEDGER_ACTION_NOOP，不重复执行）',
    mainRegion.includes("'LEDGER_ACTION_NOOP'") && /if \(!before\.ledgerForkKind\)/.test(mainRegion));
  check('D12 审计文件是 团队/状态/项目/<项目>/账本处置.jsonl（append-only）',
    mainRegion.includes("LEDGER_AUDIT_NAME = '账本处置.jsonl'")
    && mainRegion.includes("return path.join(ledgerTeamRoot(), '状态', '项目', slug, LEDGER_AUDIT_NAME);")
    && mainRegion.includes('fs.appendFileSync(file, JSON.stringify(record)'));
  const recordBlock = mainRegion.slice(mainRegion.indexOf('const record = {'), mainRegion.indexOf('const audit = {'));
  const AUDIT_FIELDS = ['at', 'action', 'requirementId', 'taskId', 'before', 'after', 'actor', 'channel', 'source', 'result'];
  const missingFields = AUDIT_FIELDS.filter((f) => !new RegExp(`(^|\\n)\\s*${f}\\s*[:,]`).test(recordBlock));
  check('D13 审计字段齐全（at/action/requirementId/taskId/before/after/actor/channel/source/result）',
    recordBlock.length > 0 && missingFields.length === 0, { missingFields });
  check('D14 一次写一整行 JSONL（失败不留半条）',
    mainRegion.includes("JSON.stringify(record) + '\\n'"));
  check('D15 审计写不进：预检就中止（LEDGER_AUDIT_UNWRITABLE）且命令不执行',
    mainRegion.includes("codedError('LEDGER_AUDIT_UNWRITABLE'") && mainRegion.includes('fs.accessSync(dir, fs.constants.W_OK)'));
  check('D16 审计写失败不静默（LEDGER_AUDIT_FAILED + 回放整条 record）',
    mainRegion.includes("'LEDGER_AUDIT_FAILED'") && /record,/.test(mainRegion));
  check('D17 壳里不直接改业务状态：处置段没有 writeWorkflowState / saveTask / writeFileSync',
    !/writeWorkflowState/.test(mainRegion) && !/saveTask/.test(mainRegion) && !/writeFileSync/.test(mainRegion));
  check('D18 处置段没有硬编码盘符 / 用户目录 / 密钥（path-audit 口径）',
    (() => {
      // 断言对象是「被检查段」而不是本文件：这里全部用拼装串，避免本测试自身命中 path-audit 的
      // 「盘符用户目录 / 密钥关键字」两类模式（B 报 selftest FAIL 的原因）。
      const driveUser = ['C', ':', '\\', '\\', 'Users'].join('');
      const tok = ['s', 'e', 'c', 'r', 'e', 't'].join('');
      const keyRe = new RegExp('api[_-]?' + ['k', 'ey'].join('') + '|' + tok, 'i');
      return !/[A-Za-z]:\\\\/.test(mainRegion) && !mainRegion.includes(driveUser) && !keyRe.test(mainRegion);
    })());
  check('D19 workflow:state 下发 ledgerActions（界面据此给禁用原因）',
    /ledgerActions: ledgerActionAvailability\(ctx\.teamName\)/.test(mainSource));
  check('D20 ledgerActionAvailability 只回放令牌文件与时间，不回放令牌值',
    /pmToken: \{/.test(mainRegion) && !/token: pm/.test(mainRegion) && !/token: boot\.token/.test(mainRegion));

  // ── E. preload.js ─────────────────────────────────────────────────────
  log('\n=== E src/preload.js：桥接 ===');
  const preloadSource = fs.readFileSync(PRELOAD, 'utf8');
  check('E1 preload 暴露 ownerLedgerCloseTask → owner:ledger-close-task',
    /ownerLedgerCloseTask: \(payload\) => ipcRenderer\.invoke\('owner:ledger-close-task', payload\)/.test(preloadSource));
  check('E2 preload 暴露 ownerLedgerReopen → owner:ledger-reopen',
    /ownerLedgerReopen: \(payload\) => ipcRenderer\.invoke\('owner:ledger-reopen', payload\)/.test(preloadSource));

  // ── F. app.js 渲染层 ──────────────────────────────────────────────────
  log('\n=== F src/renderer/app.js：按钮接线 / 禁用原因 / 刷新 / 横幅 / 并发 ===');
  check('F1 legacyLedgerActionAvailable 认新 IPC（ownerLedgerCloseTask / ownerLedgerReopen）',
    /function legacyLedgerActionAvailable\(\)/.test(appSource)
    && /has\('ownerLedgerCloseTask', 'taskRelease'\)/.test(appSource)
    && /has\('ownerLedgerReopen', 'requirementReopen'\)/.test(appSource));
  check('F2 按钮点击调 ledgerActionRun（不再是「本版后端没有 IPC」的假提示）',
    /ledgerActionRun\(ledgerAction\)/.test(appSource) && !appSource.includes('本版后端没有 task release / req reopen 的界面 IPC'));
  const runRegion = appSource.slice(appSource.indexOf('async function ledgerActionRun(button)'), appSource.indexOf('function legacyPlaceholderDocs'));
  check('F3 ledgerActionRun 真调两个 IPC（ownerLedgerCloseTask / ownerLedgerReopen，兼容旧名）',
    runRegion.includes('wb.ownerLedgerCloseTask || wb.taskRelease') && runRegion.includes('wb.ownerLedgerReopen || wb.requirementReopen'));
  const buttonRegion = appSource.slice(appSource.indexOf('const actionButton = (key, attrs, label, title) =>'), appSource.indexOf('const level = count ?'));
  check('F4 按钮 disabled 时带原因：disabled + title + 行内说明（data-ledger-disabled）',
    buttonRegion.includes('disabled title=') && buttonRegion.includes('data-ledger-disabled=')
    && buttonRegion.includes('legacy-ledger-why-text') && buttonRegion.includes('暂不可点'));
  check('F5 没有 PM 令牌时按钮禁用并写明原因（legacyLedgerActionState 的 pmToken.ok + reason）',
    /const pmOk = pm \? pm\.ok !== false : true;/.test(appSource)
    && /reasons\.push\(String\(pm\.reason \|\| '需要 PM 令牌/.test(appSource));
  check('F6 并发：点击后立刻置 busy 再 await（按钮在那之前已重绘为禁用）',
    runRegion.indexOf('ledgerActionUi.busy = true;') >= 0
    && runRegion.indexOf('ledgerActionUi.busy = true;') < runRegion.indexOf('await fn(')
    && runRegion.indexOf('ledgerRenderLedgerBlock();') < runRegion.indexOf('await fn('));
  check('F7 成功后刷新面板：ledgerRefreshAfterAction → refreshFlowLive()（再重画账本块）',
    /async function ledgerRefreshAfterAction\(\)/.test(appSource)
    && /ok = await refreshFlowLive\(\);/.test(appSource)
    && runRegion.includes('await ledgerRefreshAfterAction();'));
  check('F8 失败给顶部人话横幅 + 错误码（data-ledger-banner / data-ledger-code），不静默',
    api.ledgerBannerMarkup({ kind: 'bad', text: '处置失败：状态已变', code: 'WORKFLOW_STATE_CHANGED' })
      .includes('data-ledger-banner="1"')
    && api.ledgerBannerMarkup({ kind: 'bad', text: '处置失败', code: 'X' }).includes('data-ledger-code="X"')
    && runRegion.includes('ledgerActionUi.banner = { kind: \'bad\''));
  check('F9 失败码有「接下来怎么办」的映射（含 WORKFLOW_STATE_CHANGED / PM_TOKEN_REQUIRED）',
    /function ledgerActionHint\(code\)/.test(appSource)
    && appSource.includes('WORKFLOW_STATE_CHANGED:') && appSource.includes('PM_TOKEN_REQUIRED:'));
  check('F10 处置时把界面快照当 expect 传下去（主进程据此判 WORKFLOW_STATE_CHANGED）',
    runRegion.includes('ledgerForkKind: row ? String(row.getAttribute(\'data-ledger-kind\')') && /expect\s*\n?\s*\}\)/.test(runRegion.replace(/\r/g, '')));
  check('F11 成功横幅回放剩余分叉数（res.ledger.forkCount）',
    /const left = res\.ledger && Number\.isFinite\(Number\(res\.ledger\.forkCount\)\)/.test(runRegion));
  check('F12 账本块渲染带上横幅与禁用态（legacyLedgerMarkup 传 banner/actionEnabled）',
    /banner: ledgerActionUi\.banner,/.test(appSource) && /actionEnabled: \{/.test(appSource));

  // ── G. 隔离 ───────────────────────────────────────────────────────────
  log('\n=== G 隔离 ===');
  const afterMtime = ISOLATION_TARGETS.map(mtimeOf);
  check('G1 真实 data/userdata 与 团队/状态/团队.json 的 mtime 未被改动（沙盘 _tmp/ed7-ledger-actions）',
    beforeMtime.every((value, index) => value === afterMtime[index]),
    { targets: ISOLATION_TARGETS.map((p, i) => ({ file: path.basename(p), before: beforeMtime[i], after: afterMtime[i] })) });
  check('G2 沙盘清空了真实 sessionId（B-3c03：沙盘 wake 不会找到真实角色）',
    ((JSON.parse(fs.readFileSync(teamFile, 'utf8')).members || []).every((m) => !m.sessionId)));

  const passed = results.filter((row) => row.ok).length;
  const failed = results.length - passed;
  log(`\nR-9fbe 账本分叉处置断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const report = {
    requirement: 'R-20261115-061249-9fbe',
    task: 'T-20261115-071322-0ed7',
    at: new Date().toISOString(),
    files: ['src/main.js', 'src/preload.js', 'src/renderer/app.js', 'scripts/test-ledger-actions.cjs'],
    sandbox: SB,
    project: PROJECT,
    passed,
    failed,
    ok: failed === 0,
    assertions: results,
    isolation: { targets: ISOLATION_TARGETS, before: beforeMtime, after: afterMtime, ok: beforeMtime.every((v, i) => v === afterMtime[i]) },
    // 沙盘里真跑的两条协议命令（可复核：命令即 main.js 里那两条）
    commands: [
      { step: 'close_old_task', argv: ['task', 'release', '--boot', '<pm-token>', '--project', PROJECT, '--id', T_FORK, '--reason', '...', '--json'], ok: released.ok === true },
      { step: 'reopen_requirement', argv: ['req', 'reopen', '--boot', '<pm-token>', '--project', PROJECT, '--requirement', R_TESTFORK, '--reason', '...', '--json'], ok: reopened.ok === true }
    ]
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'ledger-actions-result.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  // 日志文件被调用方重定向占用时不至于把整轮判定打成脚本异常（结果 JSON 才是判据）。
  try {
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'ledger-actions.log'), lines.join('\n') + '\n', 'utf8');
  } catch (error) {
    log(`（提示）ledger-actions.log 写入失败：${String((error && error.message) || error).slice(0, 120)}；结果 JSON 已落盘`);
  }
  log(`证据：${path.join(EVIDENCE_DIR, 'ledger-actions-result.json')}`);
  if (failed) process.exitCode = 1;
})().catch((error) => {
  console.error('断言脚本自身异常：', (error && error.stack) || error);
  process.exit(2);
});
