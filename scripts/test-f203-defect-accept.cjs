'use strict';
/**
 * T-20261115-014633 → T-f203 断言：R-43ad 三处已知缺口（tools 侧）。
 *   ① 缺陷单验收入口（AC2/AC3）：owner accept 缺陷单 → 任务行 acceptanceRecord（报告+第二件证据），
 *      不建镜像需求行、acceptance 字符串原样；缺报告 → PM_ACCEPT_EVIDENCE_REQUIRED。
 *   ② 场景缺陷确认超时（AC3）：TEAM_SCENARIO_CONFIRM_TIMEOUT_MS=1000 → 1 秒后按 bug 先行 +
 *      PM 收 SCENARIO_CONFIRM_TIMEOUT 告警；确认 yes/no 两条路径。
 *   ③ 三类计数（AC4）：需求/缺陷/场景缺陷各 1 条 → 池内计数 1/1/1（pool-core 同一套键）。
 *
 * 沙盘：_tmp/f203（TEAM_ROOT + TEAM_PROJECTS_ROOT 双隔离 + TEAM_SELFTEST=1 + 清空 sessionId）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'f203');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '缺陷单沙盘';
const TIMEOUT_MS = '1000';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1', TEAM_SCENARIO_CONFIRM_TIMEOUT_MS: TIMEOUT_MS };
process.env.TEAM_ROOT = TEAM_ROOT;
process.env.TEAM_PROJECTS_ROOT = PROJECTS;
process.env.TEAM_SELFTEST = '1';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 360)}`);
  if (!ok) process.exitCode = 1;
}
function run(args, allowFail = false) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    const text = String(out).trim();
    return { status: 0, json: JSON.parse(text.slice(text.indexOf('{'))) };
  } catch (e) {
    const stdout = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    try { return { status: e.status, json: JSON.parse(stdout.slice(stdout.indexOf('{'))) }; } catch { return { status: e.status, json: null, raw: stdout.slice(0, 300) }; }
  }
}

fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
for (const member of team.members || []) member.sessionId = '';
team.activeProject = PROJECT;
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');

run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-f203-pm', '--json']).json.token;
const tester = run(['boot', '--role', 'tester', '--project', PROJECT, '--session', 's-f203-t', '--json']).json.token;
const product = run(['boot', '--role', 'product', '--project', PROJECT, '--session', 's-f203-pd', '--json']).json.token;
if (!pm || !tester || !product) { console.error('boot 失败'); process.exit(2); }

const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
const taskDir = path.join(stateDir, '任务');
// 证据必须落在项目目录内（EVIDENCE_OUTSIDE_PROJECT 会拒），所以写进沙盘项目副本的「产出/夹具」
const projectDir = path.join(PROJECTS, PROJECT);
const evidenceDir = path.join(projectDir, '产出', '夹具-f203');
const reportFile = path.join(evidenceDir, '测试报告-f203.md');
const shotFile = path.join(evidenceDir, '截图-f203.png');
const reportRel = '产出/夹具-f203/测试报告-f203.md';
const shotRel = '产出/夹具-f203/截图-f203.png';
fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(reportFile, '# 测试报告（夹具）\n\n结论：PASS\n\n- 用例 1 PASS\n- 无 FAIL\n', 'utf8');
fs.writeFileSync(shotFile, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex'));

// ── ① 缺陷单验收（AC2/AC3）─────────────────────────────────────────────
const bug = run(['task', 'create', '--boot', tester, '--project', PROJECT, '--type', 'bug', '--title', '缺陷夹具：按钮点击无反应', '--priority', 'P1',
  '--acceptance', '按钮点击后 1 秒内出现结果，且无报错', '--repro', '打开页面 → 点按钮 → 无反应', '--detail', '夹具', '--json'], true);
check('① 测试人员能建缺陷单（缺 acceptance 拒建已由 store 保证）', bug.json && bug.json.ok === true, bug.json && bug.json.code);
const bugId = bug.json && bug.json.task && bug.json.task.id;
const bugBefore = JSON.parse(fs.readFileSync(path.join(taskDir, `${bugId}.json`), 'utf8'));
check('① 缺陷单带 acceptance 原串、无 acceptanceRecord',
  String(bugBefore.acceptance || '') === '按钮点击后 1 秒内出现结果，且无报错' && !bugBefore.acceptanceRecord, { acceptance: bugBefore.acceptance });

const acceptNoEvidence = run(['owner', '--boot', pm, '--project', PROJECT, '--requirement', bugId, '--action', 'accept', '--decision', 'accepted', '--opinion', '', '--json'], true);
check('① 缺陷单验收缺报告 → PM_ACCEPT_EVIDENCE_REQUIRED（不再 NOT_REQUIREMENT）',
  acceptNoEvidence.json && acceptNoEvidence.json.ok === false && acceptNoEvidence.json.code === 'PM_ACCEPT_EVIDENCE_REQUIRED', acceptNoEvidence.json && acceptNoEvidence.json.code);
const acceptOnlyReport = run(['owner', '--boot', pm, '--project', PROJECT, '--requirement', bugId, '--action', 'accept', '--decision', 'accepted', '--opinion', '', '--evidence', reportRel + ':report', '--json'], true);
check('① 只有报告、缺第二件证据 → PM_ACCEPT_EVIDENCE_REQUIRED',
  acceptOnlyReport.json && acceptOnlyReport.json.ok === false && acceptOnlyReport.json.code === 'PM_ACCEPT_EVIDENCE_REQUIRED', acceptOnlyReport.json && acceptOnlyReport.json.code);
const accepted = run(['owner', '--boot', pm, '--project', PROJECT, '--requirement', bugId, '--action', 'accept', '--decision', 'accepted', '--opinion', '通过', '--evidence', reportRel + ':report', '--evidence', shotRel + ':screenshot', '--json'], true);
check('① 报告+截图 → 验收成功', accepted.json && accepted.json.ok === true, accepted.json && (accepted.json.code || accepted.json.message));
const bugAfter = JSON.parse(fs.readFileSync(path.join(taskDir, `${bugId}.json`), 'utf8'));
check('① 任务行 acceptanceRecord 含 status/by/channel/at/evidence/testReport',
  Boolean(bugAfter.acceptanceRecord) && bugAfter.acceptanceRecord.status === 'accepted' && bugAfter.acceptanceRecord.by === 'owner'
  && bugAfter.acceptanceRecord.channel === 'ui' && Boolean(bugAfter.acceptanceRecord.at)
  && Array.isArray(bugAfter.acceptanceRecord.evidence) && bugAfter.acceptanceRecord.evidence.length === 2
  && String(bugAfter.acceptanceRecord.testReport).includes('测试报告-f203'),
  bugAfter.acceptanceRecord);
check('① 任务置 accepted、acceptance 原串未被改写',
  bugAfter.status === 'accepted' && String(bugAfter.acceptance) === String(bugBefore.acceptance), { status: bugAfter.status });
const wfFile = path.join(stateDir, '工作流.json');
const wfAfterAccept = fs.existsSync(wfFile) ? JSON.parse(fs.readFileSync(wfFile, 'utf8')) : { requirements: {} };
check('① 不建镜像需求行（工作流 requirements 里没有该缺陷 id）',
  !(wfAfterAccept.requirements || {})[bugId], Object.keys(wfAfterAccept.requirements || {}).length);

// ── ② 场景缺陷确认超时（AC3）────────────────────────────────────────────
const sb1 = run(['task', 'create', '--boot', tester, '--project', PROJECT, '--type', 'scenario-bug', '--title', '场景缺陷夹具：提交后不回列表', '--priority', 'P1',
  '--acceptance', '提交后 1 秒内回到列表且条数 +1', '--repro', '提交 → 停在详情页', '--scenario', '订单/提交后返回', '--detail', '夹具', '--json'], true);
const sbId = sb1.json && sb1.json.task && sb1.json.task.id;
check('② 场景缺陷建单带 scenarioConfirm.pending', (() => {
  if (!sbId) return false;
  const row = JSON.parse(fs.readFileSync(path.join(taskDir, `${sbId}.json`), 'utf8'));
  return Boolean(row.scenarioConfirm) && row.scenarioConfirm.status === 'pending'
    && row.scenarioConfirm.confirmer === 'product' && Number(row.scenarioConfirm.timeoutMs) === Number(TIMEOUT_MS);
})(), sb1.json && sb1.json.code);

// route-daemon.mjs 是 ESM，本脚本是 CJS：用子进程探针调用（避免顶层 await）。
const ROUTE_URL = require('node:url').pathToFileURL(path.join(TEAM_ROOT, '工具', 'lib', 'route-daemon.mjs')).href;
function planForBugTaskOf(taskFileName) {
  const abs = path.join(taskDir, taskFileName).replace(/\\/g, '/');
  const code = [
    `import { planForBugTask } from '${ROUTE_URL}';`,
    "import fs from 'node:fs';",
    `const row = JSON.parse(fs.readFileSync('${abs}', 'utf8'));`,
    'console.log(JSON.stringify(planForBugTask(row) || null));',
  ].join('\n');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: SB, env, encoding: 'utf8' });
  const text = String(out).trim();
  return JSON.parse(text.slice(text.indexOf('{')));
}
const sbRow = JSON.parse(fs.readFileSync(path.join(taskDir, `${sbId}.json`), 'utf8'));
const planPending = planForBugTaskOf(`${sbId}.json`);
check('② 待确认时路由叫产品确认（action=confirm_scenario）',
  planPending && planPending.action === 'confirm_scenario' && planPending.role === 'product', planPending);

const confirmYesTask = 'B-20261115-400002-yes1';
fs.writeFileSync(path.join(taskDir, `${confirmYesTask}.json`), JSON.stringify({ ...sbRow, id: confirmYesTask, title: '确认是场景缺陷夹具' }, null, 2) + '\n', 'utf8');
// 等过注入的 1 秒超时再扫描（同步等待，不引第三方依赖）
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1400);
const sweep1 = run(['task', 'scenario-sweep', '--boot', pm, '--project', PROJECT, '--json'], true);
check('② 超时扫描：到点按 bug 先行（status=timeout，treatAs=bug）',
  sweep1.json && sweep1.json.ok === true && (sweep1.json.timedOut || []).includes(sbId), sweep1.json);
const sbAfterTimeout = JSON.parse(fs.readFileSync(path.join(taskDir, `${sbId}.json`), 'utf8'));
check('② 超时后 type 不变（仍是 scenario-bug，按 bug 先行只体现在 treatAs）',
  sbAfterTimeout.type === 'scenario-bug' && sbAfterTimeout.scenarioConfirm.treatAs === 'bug'
  && sbAfterTimeout.scenarioConfirm.status === 'timeout' && Boolean(sbAfterTimeout.scenarioConfirm.escalatedAt),
  sbAfterTimeout.scenarioConfirm);
const planTimedOut = planForBugTaskOf(`${sbId}.json`);
check('② 超时后不再等确认（不再叫 confirm_scenario；没 owner 就提示 PM 派单，有 owner 就 fix）',
  planTimedOut && planTimedOut.action !== 'confirm_scenario'
  && (planTimedOut.action === 'fix' || planTimedOut.skip === 'bug_without_owner'), planTimedOut);
const pmMail = fs.readdirSync(path.join(TEAM_ROOT, '状态', '邮箱', 'pm', 'new')).map((n) => JSON.parse(fs.readFileSync(path.join(TEAM_ROOT, '状态', '邮箱', 'pm', 'new', n), 'utf8')));
check('② PM 收到 SCENARIO_CONFIRM_TIMEOUT 告警（type=escalation）',
  pmMail.some((m) => String(m.body || '').includes('SCENARIO_CONFIRM_TIMEOUT') && String(m.type || '') === 'escalation'),
  pmMail.slice(-3).map((m) => ({ type: m.type, subject: m.subject })));
const confirmNo = run(['task', 'confirm-scenario', '--boot', product, '--project', PROJECT, '--id', sbId, '--verdict', 'no', '--reason', '不是场景缺陷，是普通缺陷', '--json'], true);
check('② 确认不是 → 改判 bug（type=bug，场景字段保留）',
  confirmNo.json && confirmNo.json.ok === true && confirmNo.json.type === 'bug'
  && confirmNo.json.task.scenarioConfirm.status === 'rejected' && String(confirmNo.json.task.scenario || '').includes('订单/提交后返回'),
  confirmNo.json && { type: confirmNo.json.type, confirm: confirmNo.json.task && confirmNo.json.task.scenarioConfirm });
const confirmYes = run(['task', 'confirm-scenario', '--boot', product, '--project', PROJECT, '--id', confirmYesTask, '--verdict', 'yes', '--reason', '确认是场景缺陷', '--json'], true);
check('② 确认是 → 保持 scenario-bug（status=confirmed）',
  confirmYes.json && confirmYes.json.ok === true && confirmYes.json.type === 'scenario-bug'
  && confirmYes.json.task.scenarioConfirm.status === 'confirmed', confirmYes.json && confirmYes.json.type);

// ── ③ 三类计数（AC4）────────────────────────────────────────────────────
run(['req', 'create', '--boot', pm, '--project', PROJECT, '--title', '需求夹具：计数用', '--priority', 'P2', '--acceptance', 'AC', '--json'], true);
run(['task', 'create', '--boot', pm, '--project', PROJECT, '--type', 'task', '--title', '普通任务夹具', '--priority', 'P2', '--detail', '夹具', '--json'], true);
const tools = require(path.join(ROOT, 'src', 'team-tools.js')).create({ teamRoot: TEAM_ROOT });
const POOL_CORE = require(path.join(ROOT, 'src', 'renderer', 'pool-core.js'));
const snap = tools.readWorkflowSnapshot(PROJECT, path.join(PROJECTS, PROJECT));
const poolRows = POOL_CORE.preparePoolRows(snap);
const counts = POOL_CORE.poolFilterCounts(poolRows, { status: 'all', kind: 'all', query: '' });
check('③ 池内三类键齐全（all/requirement/defect/scenario-bug）',
  ['all', 'requirement', 'defect', 'scenario-bug'].every((key) => Object.prototype.hasOwnProperty.call(counts.kind, key)), counts.kind);
check('③ 三类计数：需求 1 / 缺陷组 3（1 原缺陷 + 1 改判 + 1 场景）/ 场景缺陷 1（共 4 行）',
  counts.kind.requirement === 1 && counts.kind.defect === 3 && counts.kind['scenario-bug'] === 1 && counts.kind.all === 4, counts.kind);
check('③ 场景缺陷同时算在缺陷组里（defect ⊇ scenario-bug，与 poolTypeGroup 同口径）',
  counts.kind.defect >= counts.kind['scenario-bug']
  && counts.kind.all === counts.kind.requirement + counts.kind.defect, counts.kind);

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\nT-f203 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
fs.writeFileSync(path.join(SB, 'run-f203.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
