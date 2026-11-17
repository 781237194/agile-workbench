'use strict';
const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * B-20261117-013308-2a46 回归：req trq 落库不得用镜像任务的旧 requirementStatus 把工作流行回退
 *
 * 根因：cmdReqTrq 以前取 task.workflow.requirementStatus（镜像任务旧值）传给 syncWorkflowRow，
 * 工作流行已 ready 时会被回退成 approved/review。修法：以工作流行当前 status 为准 + keepForwardStatus。
 *
 * 跑法：node scripts/test-b2a46-trq-status.cjs
 * 沙盘：_tmp/b2a46-trq（TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_SELFTEST=1，每次重建）
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
// B-20261116-055303-07b6：沙盘统一入口（唯一临时目录 + 退出清理）
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
// B-20261116-055303-07b6：沙盘改**唯一临时目录**（固定 _tmp/ 目录并发跑会互相 rm/重建 → EPERM/ENOTEMPTY/MODULE_NOT_FOUND）。
// 每次运行一个新目录 + 退出清理；报告件路径不动。
const SB = mkTempSandbox('b2a46-trq');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TEAM_TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = 'TRQ状态沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 300)}`);
  if (!ok) process.exitCode = 1;
}
function run(args, allowFail = false) {
  try {
    const out = execFileSync(process.execPath, [TEAM_TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    const t = String(out).trim();
    return JSON.parse(t.slice(t.indexOf('{')));
  } catch (e) {
    const text = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    if (allowFail) { try { return JSON.parse(text.slice(text.indexOf('{'))); } catch { return { ok: false, raw: text.slice(0, 300) }; } }
    throw e;
  }
}

rmSandbox(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true });
// 沙盘团队名册清 sessionId，避免误唤醒真实角色
const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
for (const m of team.members || []) m.sessionId = '';
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');

run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm', '--json']);
const tester = run(['boot', '--role', 'tester', '--project', PROJECT, '--session', 's-tester', '--json']);

const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
const wfFile = path.join(stateDir, '工作流.json');
const taskDir = path.join(stateDir, '任务');
const readWf = () => JSON.parse(fs.readFileSync(wfFile, 'utf8'));
const rowOf = (id) => (readWf().requirements || {})[id] || {};

// 建需求前先满足 lessons 门禁（沙盘同样要读登记册；B-4875 将把 selftest/沙盘豁免写成验收项）
run(['lessons', 'read', '--boot', pm.token, '--project', PROJECT, '--json'], true);
// 建需求（req create 失败时给出可诊断信息）
const created = run(['req', 'create', '--boot', pm.token, '--project', PROJECT, '--title', 'TRQ 状态回归', '--priority', 'P0', '--acceptance', 'AC1 可测', '--json'], true);
const reqId = created && created.requirement && created.requirement.id;
check('夹具：req create 成功', Boolean(reqId), created);
if (!reqId) {
  console.log('\n沙盘初始化失败，退出');
  process.exit(1);
}

// 夹具：TR-Q 需要需求正文（需求/R-*.md）；req create 只建任务行，不建正文，这里补一份最小正文
const projectDir = path.join(PROJECTS, PROJECT);
const reqDocDir = path.join(projectDir, '需求');
fs.mkdirSync(reqDocDir, { recursive: true });
const reqDocFile = path.join(reqDocDir, `${reqId}-TRQ状态回归.md`);
fs.writeFileSync(reqDocFile, [
  `# B-2a46 夹具需求 ${reqId}`,
  '',
  '## 一、要做什么',
  '',
  '验证 req trq 落库不会把工作流行状态回退。',
  '',
  '## 二、验收标准',
  '',
  '- AC1 工作流行 status 保持 ready。',
  '',
].join('\n'), 'utf8');
check('夹具：需求正文已写入（MISSING_DOC 不再挡）', fs.existsSync(reqDocFile), reqDocFile);

// 夹具：工作流行推进到 ready，同时把镜像任务上的 requirementStatus 写成旧值 approved
function setRowAndMirror(rowStatus, mirrorStatus) {
  const wf = readWf();
  wf.requirements = wf.requirements || {};
  wf.requirements[reqId] = { ...(wf.requirements[reqId] || {}), id: reqId, status: rowStatus, round: 1 };
  fs.writeFileSync(wfFile, JSON.stringify(wf, null, 2) + '\n', 'utf8');
  const tf = path.join(taskDir, `${reqId}.json`);
  const task = JSON.parse(fs.readFileSync(tf, 'utf8'));
  task.workflow = task.workflow && typeof task.workflow === 'object' ? task.workflow : {};
  task.workflow.requirementStatus = mirrorStatus;
  fs.writeFileSync(tf, JSON.stringify(task, null, 2) + '\n', 'utf8');
}

setRowAndMirror('ready', 'approved');

// 正例：ready + 镜像旧值 approved → TR-Q 落库后仍是 ready（不得回退）
const trq1 = run(['req', 'trq', '--boot', tester.token, '--project', PROJECT, '--id', reqId, '--verdict', 'testable', '--json'], true);
check('① req trq testable 落库成功', trq1.ok === true, trq1);
check('② 工作流行 status 仍为 ready（B-2a46：不回退成 approved）', rowOf(reqId).status === 'ready', { status: rowOf(reqId).status, trq: trq1.trq && trq1.trq.verdict });
check('③ 工作流行记录 trq=testable', Boolean(rowOf(reqId).trq) && rowOf(reqId).trq.verdict === 'testable', rowOf(reqId).trq);

// 口径①：镜像值即使比工作流行更靠后（dev_done），TR-Q 也**不得**拿它推进/回退需求状态
setRowAndMirror('ready', 'dev_done');
const trq2 = run(['req', 'trq', '--boot', tester.token, '--project', PROJECT, '--id', reqId, '--verdict', 'testable', '--json'], true);
check('④ 再次 req trq 成功', trq2.ok === true, trq2);
check('⑤ 镜像值更靠后（dev_done）也不推进 → 仍是 ready（TR-Q 不回写 requirementStatus）', rowOf(reqId).status === 'ready', { status: rowOf(reqId).status });
// 审计：镜像值与工作流不一致时必须留痕（不静默丢弃镜像值）
const eventsFile = path.join(TEAM_ROOT, '状态', '事件.jsonl');
const events = fs.existsSync(eventsFile)
  ? fs.readFileSync(eventsFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];
const ignored = events.filter((e) => e.action === 'trq_status_ignored' && String(e.target) === reqId);
const ignoredDev = ignored.find((e) => String(e.data && e.data.mirrorStatus) === 'dev_done');
check('⑤b 不一致时记 trq_status_ignored 审计（mirror=dev_done/current=ready）', Boolean(ignoredDev) && String(ignoredDev.data.currentRowStatus) === 'ready', ignoredDev || ignored[0] || null);

// ── B-6c08 J2：读成功但**行不存在** → 落 review（不得用 mirrorStatus 兜底）──
{
  const wf = readWf();
  delete wf.requirements[reqId];
  fs.writeFileSync(wfFile, JSON.stringify(wf, null, 2) + '\n', 'utf8');
  // 镜像故意设成明显不同的值，若实现用 mirror 兜底会被断言抓到
  const tf = path.join(taskDir, `${reqId}.json`);
  const task2 = JSON.parse(fs.readFileSync(tf, 'utf8'));
  task2.workflow = task2.workflow && typeof task2.workflow === 'object' ? task2.workflow : {};
  task2.workflow.requirementStatus = 'dev_done';
  fs.writeFileSync(tf, JSON.stringify(task2, null, 2) + '\n', 'utf8');
  const trqJ2 = run(['req', 'trq', '--boot', tester.token, '--project', PROJECT, '--id', reqId, '--verdict', 'testable', '--json'], true);
  check('J2 行不存在时 req trq 仍成功', trqJ2.ok === true, trqJ2);
  check('J2 行不存在 → 建行落 review（不用镜像 dev_done 兜底）', rowOf(reqId).status === 'review', { status: rowOf(reqId).status });
}

// ── B-6c08 J3：读工作流**抛错** → 不写工作流行（状态保持原样），只落 trq + trq_sync_skipped 审计 ──
{
  // PM 01:55 判据明确要求：「桩注入读抛错后原 ready 仍 ready」——先把流行置回 ready，再制造读失败。
  setRowAndMirror('ready', 'review');
  const beforeStatus = rowOf(reqId).status;
  const fileBackup = wfFile + '.j3-backup';
  fs.renameSync(wfFile, fileBackup);
  fs.mkdirSync(wfFile, { recursive: true }); // 同名目录 → 读抛错（EISDIR / 解析失败）
  let trqJ3 = null;
  try {
    trqJ3 = run(['req', 'trq', '--boot', tester.token, '--project', PROJECT, '--id', reqId, '--verdict', 'testable', '--json'], true);
  } finally {
    fs.rmdirSync(wfFile);
    fs.renameSync(fileBackup, wfFile);
  }
  check('J3 读工作流抛错时 req trq 仍成功（不阻断 TR-Q 落库）', trqJ3 && trqJ3.ok === true, trqJ3);
  check('J3 读失败 → 工作流行状态逐位不变（不回退/不覆盖）', rowOf(reqId).status === beforeStatus, { before: beforeStatus, after: rowOf(reqId).status });
  check('J3 读失败 → 返回 readFailed=true 且 workflowFile 为空', Boolean(trqJ3 && trqJ3.readFailed === true && trqJ3.workflowFile === ''), trqJ3 && { readFailed: trqJ3.readFailed, workflowFile: trqJ3.workflowFile });
  const eventsNow = fs.existsSync(eventsFile)
    ? fs.readFileSync(eventsFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const skipped = eventsNow.filter((e) => e.action === 'trq_sync_skipped' && String(e.target) === reqId);
  check('J3 读失败 → 记 trq_sync_skipped{reason:read_failed}', skipped.length >= 1 && String(skipped[0].data && skipped[0].data.reason) === 'read_failed', skipped[0] || null);
}

// 边界：工作流行缺失时退回镜像值（create:true 建行，不报错）
setRowAndMirror('test_done', 'review');
const trq3 = run(['req', 'trq', '--boot', tester.token, '--project', PROJECT, '--id', reqId, '--verdict', 'not_testable', '--missing', 'AC2 无落点', '--json'], true);
check('⑥ 第三次 req trq 仍成功', trq3.ok === true, trq3);
check('⑦ not_testable 落库但不改需求状态（仍 test_done）', rowOf(reqId).status === 'test_done' && Boolean(rowOf(reqId).trq) && rowOf(reqId).trq.verdict === 'not_testable', { status: rowOf(reqId).status, trq: rowOf(reqId).trq && rowOf(reqId).trq.verdict });

const summary = { at: new Date().toISOString(), total: results.length, failed: results.filter((r) => !r.ok).length, results };
// B-20261117-015546-fe6d：J2/J3 结果落独立证据目录，不覆盖已验收的 证据-2a46/run-2a46.json
// （PM 2026-11-17 01:46 证据覆盖警告：已验收件不得原地重写）。
const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-fe6d');
fs.mkdirSync(evDir, { recursive: true });
fs.writeFileSync(path.join(evDir, 'run-j2j3.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log(`\nB-2a46 断言：${summary.total - summary.failed}/${summary.total} PASS`);
