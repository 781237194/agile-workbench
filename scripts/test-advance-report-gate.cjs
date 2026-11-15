#!/usr/bin/env node
/**
 * B-20261115-145830-2ae4 / 62b9 断言：推进前必须读测试报告结论
 *   ① 报告 status=不通过（但任务 evidence 字符串干净）→ 需求停在 dev_done，写 requirement_advance_skipped 带原文片段
 *   ② 报告 status=通过 → 正常推进到 test_done（正向对照，防"一刀切不推进"）
 *   ③ evidence 字符串里写 FAIL → 仍按老规则拦（不回退既有能力）
 *   ④ 递归：recompute-advance 走同一闸门（不能绕过 task done 那条路）
 *
 * 跑法：node scripts/test-advance-report-gate.cjs
 * 环境：自建沙盘 项目/工作台改造修复/_tmp/advance-report-sandbox（TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_SELFTEST=1）
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const TEAM_MJS = path.join(REPO, '团队', '工具', 'team.mjs');
const SANDBOX = path.join(REPO, '项目', '工作台改造修复', '_tmp', 'advance-report-sandbox');
const TEAM_ROOT = path.join(SANDBOX, '团队');
const PROJECTS_ROOT = path.join(SANDBOX, '项目');
const PROJECT = '推进沙盘';
const PROJECT_PATH = path.join(PROJECTS_ROOT, PROJECT);
const STATE = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
const WF = path.join(STATE, '工作流.json');
const EVENTS = path.join(TEAM_ROOT, '状态', '事件.jsonl');
const REPORT_DIR = path.join(PROJECT_PATH, '测试人员', '产出');

let pass = 0; let fail = 0;
const failures = []; const results = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; results.push({ name, ok: true }); }
  else { fail += 1; failures.push({ name, detail: String(detail).replace(/\s+/g, ' ').slice(0, 240) }); results.push({ name, ok: false, detail }); }
}
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n', 'utf8'); };
const events = () => { try { return fs.readFileSync(EVENTS, 'utf8').split(/\r?\n/).filter(Boolean).map((s) => JSON.parse(s)); } catch { return []; } };
function env() { return { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS_ROOT, TEAM_SELFTEST: '1' }; }
function run(args) {
  try { return { code: 0, stdout: execFileSync(process.execPath, [TEAM_MJS, ...args], { env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status == null ? -1 : e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }; }
}
function runJson(args) { const r = run([...args, '--json']); let j = null; try { j = JSON.parse(r.stdout); } catch { j = null; } return { ...r, json: j }; }
const rowOf = (id) => ((readJson(WF, { requirements: {} }).requirements || {})[id] || null);
function writeReport(name, headLine, body = '', reqId = '') {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const file = path.join(REPORT_DIR, name);
  // TEST_REPORT_REQUIRED 门要求「最新测试报告覆盖该需求」→ 报告里必须出现需求 id
  const text = `# 测试报告 · 夹具\n\n- 需求：${reqId || '(未填)'}\n- ${headLine}\n\n${body || '（正文略）'}\n`;
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

// ---------- 沙盘 ----------
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '团队'), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, '项目'), { recursive: true });
ok('沙盘 init', /团队已初始化/.test(run(['init']).stdout));
ok('沙盘项目建立', /项目已建/.test(run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).stdout));
const bootOf = (role) => { const m = /令牌:\s*([0-9a-f]{24})/.exec(run(['boot', '--role', role, '--project', PROJECT]).stdout); return m ? m[1] : ''; };
let pmToken = bootOf('pm');
// 沙盘 init 只有 pm/programmer1；全流程要 tester，用 roster add --force 补名册（沙盘内，无真实会话）
const roster = run(['roster', 'add', '--boot', pmToken, '--role', 'tester', '--name', '测试人员', '--force']);
ok('沙盘名册补 tester', /已加|已加入|roster/.test(roster.stdout), (roster.stdout + roster.stderr).slice(0, 120));
pmToken = bootOf('pm'); // 名册变更会让旧令牌失效
const testerToken = bootOf('tester');
ok('pm/tester boot 拿到令牌', Boolean(pmToken) && Boolean(testerToken), `${Boolean(pmToken)}/${Boolean(testerToken)}`);

// 需求记录（type=requirement）+ 工作流行 status=dev_done、trq=testable
const reqCreate = runJson(['task', 'create', '--boot', pmToken, '--title', '报告闸门夹具需求', '--priority', 'P1', '--type', 'requirement']);
const reqId = reqCreate.json && reqCreate.json.task ? reqCreate.json.task.id : '';
ok('建需求记录', Boolean(reqId), (reqCreate.stderr || '').slice(0, 120));
const now = new Date().toISOString();
writeJson(WF, {
  schema: 2, project: PROJECT, round: 1, phase: 'test', events: [],
  requirements: {
    [reqId]: {
      id: reqId, title: '报告闸门夹具需求', status: 'dev_done', round: 1, deliveryRound: 1,
      trq: { verdict: 'testable', requirementHash: 'x' }, createdAt: now, updatedAt: now, priority: 'P1',
      ownerReview: { status: 'approved' }, decisions: [{ status: 'approved', at: now }],
    },
  },
});

// 测试任务（owner=tester → 完成即触发 advance），evidence 指向报告文件但不写「不通过」
const testTask = runJson(['task', 'create', '--boot', pmToken, '--title', '测试：报告不通过夹具', '--priority', 'P1', '--type', 'task', '--owner', 'tester', '--requirement', reqId]);
const testTaskId = testTask.json && testTask.json.task ? testTask.json.task.id : '';
ok('建测试任务并置 working', Boolean(testTaskId) && String(testTask.json.task.status) === 'working', JSON.stringify(testTask.json && testTask.json.task && testTask.json.task.status));

// ---------- ① 报告说不通过 → 不推进 ----------
writeReport('测试报告-v190.md', 'status=不通过：AC6/AC7 验收入口未实现', '', reqId);
const beforeEvents = events().length;
const done1 = runJson(['task', 'done', '--boot', testerToken, '--id', testTaskId, '--evidence', '测试人员/产出/测试报告-v190.md']);
ok('测试任务 done 本身成功（任务确实完成）', done1.code === 0 && done1.json && done1.json.ok === true, (done1.stderr || done1.stdout).slice(0, 160));
ok('① 需求停在 dev_done（未被推到 test_done）', String((rowOf(reqId) || {}).status || '') === 'dev_done', String((rowOf(reqId) || {}).status));
const skipEvt = events().slice(beforeEvents).find((e) => e.action === 'requirement_advance_skipped' && String(e.target) === reqId);
ok('① 写 requirement_advance_skipped 审计', Boolean(skipEvt), '缺事件');
ok('① 原因是 test_report_not_passed', Boolean(skipEvt && String(skipEvt.data && skipEvt.data.reason) === 'test_report_not_passed'), JSON.stringify(skipEvt && skipEvt.data));
ok('① 审计带匹配原文片段（不通过）', Boolean(skipEvt && /不通过/.test(String(skipEvt.data && skipEvt.data.snippet))), JSON.stringify(skipEvt && skipEvt.data && skipEvt.data.snippet));
ok('① 审计带报告文件路径', Boolean(skipEvt && /测试报告-v190\.md/.test(String(skipEvt.data && skipEvt.data.reportFile))), JSON.stringify(skipEvt && skipEvt.data && skipEvt.data.reportFile));

// ---------- ④ recompute-advance 走同一闸门 ----------
const beforeEvents2 = events().length;
const rec1 = runJson(['task', 'recompute-advance', '--boot', pmToken, '--project', PROJECT, '--requirement', reqId]);
ok('④ recompute-advance 也不推进', String((rowOf(reqId) || {}).status || '') === 'dev_done', String((rowOf(reqId) || {}).status));
ok('④ recompute 留 skipped 审计', events().slice(beforeEvents2).some((e) => e.action === 'requirement_advance_skipped' && String(e.target) === reqId), '缺事件');

// ---------- ② 报告改成通过 → 正常推进 ----------
writeReport('测试报告-v191.md', 'status=通过：AC1-AC7 全 PASS', '- 结论：通过', reqId);
const beforeEvents3 = events().length;
const rec2 = runJson(['task', 'recompute-advance', '--boot', pmToken, '--project', PROJECT, '--requirement', reqId]);
ok('② 报告通过 → 推进到 test_done', String((rowOf(reqId) || {}).status || '') === 'test_done', String((rowOf(reqId) || {}).status));
ok('② 推进后无 skipped 审计（不再误拦）', !events().slice(beforeEvents3).some((e) => e.action === 'requirement_advance_skipped' && String(e.target) === reqId), '出现误拦');

// ---------- ③ evidence 字符串 FAIL 仍拦（不回退既有能力）----------
// 新造一条需求，避免与上一条状态冲突
const req2 = runJson(['task', 'create', '--boot', pmToken, '--title', '报告闸门夹具需求2', '--priority', 'P1', '--type', 'requirement']);
const req2Id = req2.json && req2.json.task ? req2.json.task.id : '';
const wf2 = readJson(WF, { requirements: {} });
wf2.requirements[req2Id] = { id: req2Id, title: '夹具2', status: 'dev_done', round: 1, deliveryRound: 1, trq: { verdict: 'testable' }, createdAt: now, updatedAt: now, priority: 'P1', decisions: [{ status: 'approved', at: now }] };
writeJson(WF, wf2);
writeReport('测试报告-v192.md', 'status=通过', '通过', req2Id);
const t2 = runJson(['task', 'create', '--boot', pmToken, '--title', '测试2', '--priority', 'P1', '--type', 'task', '--owner', 'tester', '--requirement', req2Id]);
const t2Id = t2.json && t2.json.task ? t2.json.task.id : '';
const beforeEvents4 = events().length;
runJson(['task', 'done', '--boot', testerToken, '--id', t2Id, '--evidence', '测试人员/产出/测试报告-v192.md FAIL:AC3 断言红']);
ok('③ evidence 写着 FAIL → 仍不推进', String((rowOf(req2Id) || {}).status || '') === 'dev_done', String((rowOf(req2Id) || {}).status));
ok('③ 原因 test_not_passed（老规则保留）', events().slice(beforeEvents4).some((e) => e.action === 'requirement_advance_skipped' && String(e.target) === req2Id && String(e.data && e.data.reason) === 'test_not_passed'), '缺 test_not_passed');

// ---------- b28f：误推 accepted 的巡检与合规恢复 ----------
const req3 = runJson(['task', 'create', '--boot', pmToken, '--title', '误推 accepted 夹具', '--priority', 'P1', '--type', 'requirement']);
const req3Id = req3.json && req3.json.task ? req3.json.task.id : '';
const wf3 = readJson(WF, { requirements: {} });
wf3.requirements[req3Id] = { id: req3Id, title: '误推 accepted 夹具', status: 'accepted', round: 1, deliveryRound: 1, createdAt: now, updatedAt: now, priority: 'P1', decisions: [] };
writeJson(WF, wf3);
const mis1 = runJson(['req', 'mispushed', '--boot', pmToken, '--project', PROJECT]);
ok('b28f 巡检：accepted 无 accept 决定 → 命中', mis1.code === 0 && (mis1.json.hits || []).some((h) => h.requirementId === req3Id), JSON.stringify(mis1.json && mis1.json.count));
ok('b28f 巡检：给出恢复命令（不含手改 JSON）', Boolean(mis1.json && mis1.json.hits[0] && /req reopen .*--recover-mispushed/.test(String(mis1.json.hits[0].recovery))), JSON.stringify(mis1.json && mis1.json.hits[0] && mis1.json.hits[0].recovery));
const nakedReopen = runJson(['req', 'reopen', '--boot', pmToken, '--project', PROJECT, '--requirement', req3Id, '--reason', '试试不带开关']);
ok('不带 --recover-mispushed → 拒绝（防止误放行正常验收行）', Boolean(nakedReopen.json && nakedReopen.json.code === 'REOPEN_NOT_APPLICABLE'), JSON.stringify(nakedReopen.json && nakedReopen.json.code));
const beforeEvents5 = events().length;
const recover = runJson(['req', 'reopen', '--boot', pmToken, '--project', PROJECT, '--requirement', req3Id, '--reason', '误推 accepted 恢复（无 accept 决定）', '--recover-mispushed']);
ok('--recover-mispushed → 恢复成功（accepted → dev）', recover.code === 0 && String((rowOf(req3Id) || {}).status || '') === 'dev', JSON.stringify(recover.json && recover.json.fromStatus));
ok('恢复写 requirement_recovery_mispushed_accepted 审计', events().slice(beforeEvents5).some((e) => e.action === 'requirement_recovery_mispushed_accepted' && String(e.target) === req3Id), '缺恢复审计');
// 正常验收过的行（有 accept 决定）不得被 --recover-mispushed 拉回
const req4 = runJson(['task', 'create', '--boot', pmToken, '--title', '正常验收夹具', '--priority', 'P1', '--type', 'requirement']);
const req4Id = req4.json && req4.json.task ? req4.json.task.id : '';
const wf4 = readJson(WF, { requirements: {} });
wf4.requirements[req4Id] = { id: req4Id, title: '正常验收夹具', status: 'accepted', round: 1, decisions: [{ status: 'accepted', at: now, channel: 'ui' }], createdAt: now, updatedAt: now, priority: 'P1' };
writeJson(WF, wf4);
const okReopen = runJson(['req', 'reopen', '--boot', pmToken, '--project', PROJECT, '--requirement', req4Id, '--reason', '不应允许', '--recover-mispushed']);
ok('有 accept 决定的行 → --recover-mispushed 仍拒', Boolean(okReopen.json && okReopen.json.code === 'REOPEN_NOT_APPLICABLE'), JSON.stringify(okReopen.json && okReopen.json.code));

// ---------- 跨需求误读（M-20261115-153130-d8df04）：B 的不通过报告不得挡住 A ----------
// 两条需求都在 dev_done；A 报告 v193=通过，B 报告 v194=不通过（版本更大=项目全局最新）。
// 期望：A 正常推到 test_done；B 被自己的报告挡住。旧实现会因"全局最新 v194"把 A 也挡住（假阳性）。
const reqA = runJson(['task', 'create', '--boot', pmToken, '--title', '跨需求A', '--priority', 'P1', '--type', 'requirement']);
const reqAId = reqA.json && reqA.json.task ? reqA.json.task.id : '';
const reqB = runJson(['task', 'create', '--boot', pmToken, '--title', '跨需求B', '--priority', 'P1', '--type', 'requirement']);
const reqBId = reqB.json && reqB.json.task ? reqB.json.task.id : '';
const wfX = readJson(WF, { requirements: {} });
wfX.requirements[reqAId] = { id: reqAId, title: '跨需求A', status: 'dev_done', round: 1, deliveryRound: 1, trq: { verdict: 'testable' }, createdAt: now, updatedAt: now, priority: 'P1', decisions: [{ status: 'approved', at: now }] };
wfX.requirements[reqBId] = { id: reqBId, title: '跨需求B', status: 'dev_done', round: 1, deliveryRound: 1, trq: { verdict: 'testable' }, createdAt: now, updatedAt: now, priority: 'P1', decisions: [{ status: 'approved', at: now }] };
writeJson(WF, wfX);
// 用夹具把两条测试任务直接置 done（绕过 G7 报告门，隔离"推进时读报告"这一段）
const taskDir = path.join(STATE, '任务');
const seedDoneTestTask = (title, requirementId, reportRel) => {
  const created = runJson(['task', 'create', '--boot', pmToken, '--title', title, '--priority', 'P1', '--type', 'task', '--owner', 'tester', '--requirement', requirementId]);
  const id = created.json && created.json.task ? created.json.task.id : '';
  const file = path.join(taskDir, `${id}.json`);
  const row = readJson(file, null);
  if (row) {
    row.status = 'done';
    row.doneAt = new Date().toISOString();
    row.updatedAt = row.doneAt;
    row.evidence = reportRel;
    row.workflow = { ...(row.workflow || {}), stage: 'test', round: 1 };
    writeJson(file, row);
  }
  return id;
};
const fixA = seedDoneTestTask('跨需求A 测试', reqAId, '测试人员/产出/测试报告-v193.md');
const fixB = seedDoneTestTask('跨需求B 测试', reqBId, '测试人员/产出/测试报告-v194.md');
writeReport('测试报告-v193.md', 'status=通过：A 的复验全 PASS', '- 结论：通过', reqAId);
writeReport('测试报告-v194.md', 'status=不通过：B 还有 2 条未过', '- 结论：不通过', reqBId);
const recA = runJson(['task', 'recompute-advance', '--boot', pmToken, '--project', PROJECT, '--requirement', reqAId]);
ok('跨需求：A（报告通过）正常推到 test_done', String((rowOf(reqAId) || {}).status || '') === 'test_done', String((rowOf(reqAId) || {}).status));
ok('跨需求：A 未被 B 的不通过报告挡住（假阳性已修）', recA.code === 0, (recA.stderr || '').slice(0, 160));
const recB = runJson(['task', 'recompute-advance', '--boot', pmToken, '--project', PROJECT, '--requirement', reqBId]);
ok('跨需求：B（自己的报告不通过）仍停在 dev_done', String((rowOf(reqBId) || {}).status || '') === 'dev_done', String((rowOf(reqBId) || {}).status));
ok('跨需求：B 的 skipped 审计仍指向自己的报告', events().some((e) => e.action === 'requirement_advance_skipped' && String(e.target) === reqBId && /v194/.test(String(e.data && e.data.reportFile))), 'B 审计缺 v194');

// ---------- 汇总报告里的「0 失败 / 失败零副作用」不得被当成不通过（v189 同类形态）----------
const reqC = runJson(['task', 'create', '--boot', pmToken, '--title', '汇总报告夹具', '--priority', 'P1', '--type', 'requirement']);
const reqCId = reqC.json && reqC.json.task ? reqC.json.task.id : '';
const wfY = readJson(WF, { requirements: {} });
wfY.requirements[reqCId] = { id: reqCId, title: '汇总报告夹具', status: 'dev_done', round: 1, deliveryRound: 1, trq: { verdict: 'testable' }, createdAt: now, updatedAt: now, priority: 'P1', decisions: [{ status: 'approved', at: now }] };
writeJson(WF, wfY);
seedDoneTestTask('汇总报告夹具 测试', reqCId, '测试人员/产出/测试报告-v195.md');
fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(path.join(REPORT_DIR, '测试报告-v195.md'), [
  '---', 'doc: 04-测试报告', 'version: v195',
  `requirement: ${reqCId}`,
  'status: 全部通过（各单明细见对应分册）',
  '---', '',
  `- 需求：${reqCId}`,
  '- 断言：`node scripts/test-doc-split.cjs` → **77 通过 / 0 失败**',
  '- 覆盖：claim 前置门、失败零副作用与审计',
  '- 结论：**通过**',
  '',
].join('\n'), 'utf8');
const recC = runJson(['task', 'recompute-advance', '--boot', pmToken, '--project', PROJECT, '--requirement', reqCId]);
ok('汇总报告「0 失败/失败零副作用」不误判 → 仍推进到 test_done', String((rowOf(reqCId) || {}).status || '') === 'test_done', String((rowOf(reqCId) || {}).status));

// ---------- 报告 ----------
const report = { at: new Date().toISOString(), task: 'B-20261115-145830-2ae4', pass, fail, failures, results };
const outFile = path.join(REPO, '项目', '工作台改造修复', '_tmp', 'advance-report-run.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`\n=== B-2ae4/62b9 报告结论闸门断言：${pass} 通过 / ${fail} 失败 ===`);
for (const f of failures) console.log(`✗ ${f.name}  ${f.detail}`);
console.log(`报告：${outFile}`);
process.exit(fail ? 1 : 0);
