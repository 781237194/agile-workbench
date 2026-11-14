#!/usr/bin/env node
'use strict';
/**
 * B-20261114-133448-7738 · Owner 验收打回自动建缺陷单（回归断言）
 *
 * 全沙盘：新建 _tmp/b7738-sandbox-<时间戳>，TEAM_ROOT / TEAM_PROJECTS_ROOT / TEAM_WORKBENCH_JSON 三隔离，
 * 不读不写真实团队状态。流程：造一条 test_done 需求 → owner confirm（--test-owner）→ owner --action accept --decision rejected
 * → 断言自动建出 type=bug 的缺陷单（绑定需求、标题含需求号与原因摘要、带验收证据要求、打回意见进正文）。
 *
 * 复跑：node scripts/test-accept-reject-bug.cjs
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TEAM = path.join(ROOT, '团队', '工具', 'team.mjs');
const SB = path.join(ROOT, '_tmp', 'b7738-sandbox-' + Date.now().toString(36));
const PROJECT = '沙盘7738';
const RID = 'R-20261114-000001-773a';
const OPINION = '验收打回：引导第 7 步没写“更多→外观”，也缺验收截图；请补齐后重交';

let total = 0;
let failed = 0;
const results = [];
function check(name, ok, detail) {
  total += 1;
  if (!ok) failed += 1;
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' · ' + JSON.stringify(detail)));
}
function nowIso() { return new Date().toISOString(); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8'); }

const env = {
  ...process.env,
  TEAM_ROOT: path.join(SB, '团队'),
  TEAM_PROJECTS_ROOT: path.join(SB, '项目'),
  TEAM_WORKBENCH_JSON: path.join(SB, 'workbench.json'),
  TEAM_SELFTEST: '1',
};
function run(args) {
  return execFileSync(process.execPath, [TEAM, ...args], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}
function runJson(args) {
  const text = run(args);
  const start = text.indexOf('{');
  if (start < 0) return { raw: text };
  try { return JSON.parse(text.slice(start)); } catch { return { raw: text }; }
}

function main() {
  fs.mkdirSync(path.join(SB, '团队'), { recursive: true });
  fs.mkdirSync(path.join(SB, '项目', PROJECT), { recursive: true });
  run(['init']);
  run(['project', 'add', '--name', PROJECT, '--path', path.join(SB, '项目', PROJECT), '--team-mode', 'full']);

  const stateDir = path.join(SB, '团队', '状态', '项目', PROJECT);
  const taskDir = path.join(stateDir, '任务');
  fs.mkdirSync(taskDir, { recursive: true });
  const reqTaskFile = path.join(taskDir, RID + '.json');
  const workflowFile = path.join(stateDir, '工作流.json');
  const at = nowIso();
  writeJson(reqTaskFile, {
    id: RID,
    project: PROJECT,
    type: 'requirement',
    requirementId: '',
    title: '沙盘：验收打回自动建缺陷单',
    detail: '',
    acceptance: 'AC1 验收打回自动建缺陷单；AC2 缺陷单带证据要求；AC3 打回意见进正文；AC4 缺陷池可见',
    story: '',
    priority: 'P1',
    priorityBy: 'pm',
    priorityReason: '',
    owner: 'programmer1',
    status: 'working',
    createdBy: 'pm',
    createdAt: at,
    claimedAt: at,
    due: '',
    doneAt: null,
    evidence: '',
    rev: 1,
    history: [{ ts: at, by: 'pm', action: 'create', note: 'task priority=P1' }],
    workflow: {
      stage: 'test',
      requirementStatus: 'test_done',
      // 沙盘造数：产品评审已通过（否则 Owner 验收被 PRODUCT_REVIEW_REQUIRED 挡住）
      productReview: { verdict: 'approve', by: 'product', at },
    },
    updatedAt: at,
  });
  // 沙盘造数：一条已完成的测试任务（ownerTestGate 要求有 done 的测试任务，否则 TEST_NOT_DONE）
  const testTaskId = 'T-20261114-000002-773b';
  writeJson(path.join(taskDir, testTaskId + '.json'), {
    id: testTaskId,
    project: PROJECT,
    type: 'task',
    requirementId: RID,
    title: '沙盘：测试完成（造数）',
    detail: '沙盘造数：仅为 Owner 验收闸门提供一条 done 的测试任务。',
    acceptance: '',
    priority: 'P1',
    priorityBy: 'pm',
    owner: 'tester',
    status: 'done',
    createdBy: 'pm',
    createdAt: at,
    claimedAt: at,
    doneAt: at,
    due: '',
    evidence: '沙盘造数（测试报告 20/20 PASS）',
    rev: 1,
    history: [{ ts: at, by: 'pm', action: 'create', note: 'task priority=P1' }, { ts: at, by: 'tester', action: 'done', note: '' }],
    workflow: { stage: 'test' },
    updatedAt: at,
  });
  writeJson(workflowFile, {
    version: 1,
    project: PROJECT,
    round: 1,
    phase: 'test',
    requirements: {
      [RID]: {
        id: RID,
        status: 'test_done',
        phase: 'test',
        priority: 'P1',
        round: 1,
        owner: 'programmer1',
        title: '沙盘：验收打回自动建缺陷单',
        updatedAt: at,
        decisions: [],
        productReview: { verdict: 'approve', by: 'product', at },
        ownerReview: { status: 'approved', at, by: 'Owner', actor: 'owner' },
      },
    },
  });

  // 1) owner confirm（沙盘通道：TEAM_SELFTEST=1 + --test-owner）
  const confirm = runJson(['owner', 'confirm', '--project', PROJECT, '--requirement', RID, '--decision', 'rejected', '--action', 'accept', '--opinion', OPINION, '--test-owner', '--json']);
  const nonce = String((confirm && (confirm.nonce || (confirm.record && confirm.record.nonce))) || '');
  check('沙盘：owner confirm 拿到一次性确认码', Boolean(nonce), { nonceLen: nonce.length });

  // 2) 验收打回
  let acceptOut = '';
  try {
    acceptOut = run(['owner', '--project', PROJECT, '--requirement', RID, '--decision', 'rejected', '--action', 'accept', '--opinion', OPINION, '--owner-confirm', nonce, '--json']);
    check('沙盘：验收打回命令执行成功', /"ok"\s*:\s*true|status"\s*:\s*"rejected"/.test(acceptOut) || acceptOut.length > 0, acceptOut.slice(0, 120));
  } catch (error) {
    check('沙盘：验收打回命令执行成功', false, String(error && error.stdout || error.message).slice(0, 400));
    throw error;
  }

  // 3) 断言：自动建出缺陷单
  const files = fs.readdirSync(taskDir).filter((name) => name.endsWith('.json'));
  const tasks = files.map((name) => readJson(path.join(taskDir, name)));
  const bugs = tasks.filter((task) => task.type === 'bug' && String(task.requirementId || '') === RID);
  check('B-7738① 验收打回后自动建出一条 type=bug 缺陷单', bugs.length === 1, bugs.map((bug) => bug.id));
  const bug = bugs[0] || {};
  check('B-7738① 缺陷单绑定需求 id', String(bug.requirementId || '') === RID, bug.requirementId);
  check('B-7738① 标题含需求号 + 打回原因摘要', String(bug.title || '').includes(RID) && /引导第 7 步|更多→外观|验收截图/.test(String(bug.title || '')), bug.title);
  check('B-7738② 缺陷单带验收证据要求（测试报告 + 截图）', /测试报告/.test(String(bug.acceptance || '')) && /截图/.test(String(bug.acceptance || '')), String(bug.acceptance || '').slice(0, 80));
  check('B-7738② 正文写清「缺什么」', /缺什么/.test(String(bug.detail || '')) && /测试报告|截图|证据清单/.test(String(bug.detail || '')), 'detail 含缺失清单');
  check('B-7738③ Owner 打回意见全文进正文', String(bug.detail || '').includes(OPINION), '含原话');
  check('B-7738③ 正文写清「谁修」', /谁修：/.test(String(bug.detail || '')), '含谁修');
  check('缺陷单带复现/期望/实际（缺陷单必填字段）', Boolean(bug.repro) && Boolean(bug.expected) && Boolean(bug.actual), { repro: Boolean(bug.repro), expected: Boolean(bug.expected), actual: Boolean(bug.actual) });
  check('缺陷单带幂等键与来源（workflow.acceptRejectKey / source）', Boolean(bug.workflow && bug.workflow.acceptRejectKey) && bug.workflow.source === 'owner_accept_reject', bug.workflow && { key: bug.workflow.acceptRejectKey, source: bug.workflow.source });

  // 4) 断言：需求被打回 + 需求行挂上缺陷单号
  const workflow = readJson(workflowFile);
  const row = (workflow.requirements || {})[RID] || {};
  check('验收打回后需求状态 = rejected', String(row.status || '') === 'rejected', row.status);
  const reqTask = readJson(reqTaskFile);
  const linked = String((reqTask.workflow && reqTask.workflow.acceptRejectBug && reqTask.workflow.acceptRejectBug.taskId) || '');
  check('需求任务行记录了自动建的缺陷单号', linked === String(bug.id || ''), { linked, bugId: bug.id });

  // 5) 断言：事件留痕（可审计）
  const eventFile = path.join(SB, '团队', '状态', '事件.jsonl');
  const events = fs.existsSync(eventFile) ? fs.readFileSync(eventFile, 'utf8') : '';
  check('事件留痕 accept_reject_bug_created', /accept_reject_bug_created/.test(events), '事件存在');
  check('事件留痕 accept_reject_bug_linked（需求↔缺陷单关联）', /accept_reject_bug_linked/.test(events), '事件存在');

  // 6) 断言：缺陷池可见（池数据源 = workflowState 的 tasks，type=bug + requirementId 就能进池）
  const poolVisible = tasks.some((task) => String(task.type) === 'bug' && String(task.requirementId || '') === RID && String(task.status || '') !== 'done');
  check('缺陷单在缺陷池可见（type=bug + 绑定需求 + 未关闭）', poolVisible, '池数据条件满足');

  const outDir = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-7738');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({
    at: nowIso(), sandbox: SB, requirementId: RID, opinion: OPINION,
    bugTaskId: bug.id || '', bugTitle: bug.title || '', total, failed, results,
  }, null, 2) + '\n', 'utf8');

  console.log('\n合计 ' + total + ' 项，失败 ' + failed + ' 项');
  if (!failed) console.log('ACCEPT_REJECT_BUG_OK');
  process.exit(failed ? 1 : 0);
}

try {
  main();
} catch (error) {
  console.error('沙盘执行失败：', error && (error.stdout || error.message));
  process.exit(2);
}
