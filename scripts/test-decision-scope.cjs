'use strict';
const { rmSandbox, uniqueSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * R-e717 团队工具侧回归：决策箱范围（F-1）/ 语义（F-1b）/ 文案（F-2）/ 历史兜底（F-5）。
 *
 * 跑法：node scripts/test-decision-scope.cjs
 * 隔离：复制 团队/ 到 _tmp/decision-scope-test，TEAM_ROOT/TEAM_PROJECTS_ROOT 指向沙盘，TEAM_SELFTEST=1。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = uniqueSandbox('decision-scope-test');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TEAM_TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '范围沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(detail).slice(0, 320)}`);
  if (!ok) process.exitCode = 1;
}
function run(args, { allowFail = false } = {}) {
  try {
    const out = execFileSync(process.execPath, [TEAM_TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    return JSON.parse(String(out).trim().slice(String(out).trim().indexOf('{')));
  } catch (e) {
    const text = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    if (allowFail) { try { return JSON.parse(text.slice(text.indexOf('{'))); } catch { return { ok: false, raw: text.slice(0, 200) }; } }
    throw e;
  }
}

// ---------- 沙盘 ----------
rmSandbox(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true });
run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'sbx-pm', '--json']);
const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
const workflowFile = path.join(stateDir, '工作流.json');
const boxFile = path.join(stateDir, '决策箱.json');

// 造需求行：六状态 + 一条收口 accepted（带名字）
const statuses = [
  ['R-20261114-150001-aaaa', 'open'],
  ['R-20261114-150002-bbbb', 'ready'],
  ['R-20261114-150003-cccc', 'approved'],
  ['R-20261114-150004-dddd', 'dispatched'],
  ['R-20261114-150005-eeee', 'dev'],
  ['R-20261114-150006-ffff', 'test_done'],
  ['R-20261114-150007-a1b2', 'accepted'],
  ['R-20261114-150008-b3c4', 'terminated'],
];
const now = new Date().toISOString();
const base = fs.existsSync(workflowFile) ? JSON.parse(fs.readFileSync(workflowFile, 'utf8')) : { schema: 2, project: PROJECT, round: 1, phase: 'requirement', requirements: {}, events: [] };
base.requirements = base.requirements || {};
for (const [id, status] of statuses) {
  base.requirements[id] = { id, status, phase: 'dev', title: id === 'R-20261114-150007-a1b2' ? '决策箱产品级收口' : '' };
}
base.updatedAt = now;
fs.writeFileSync(workflowFile, JSON.stringify(base, null, 2) + '\n', 'utf8');
console.log(`沙盘就绪：${SB}（8 条需求状态）`);

let seq = 0;
const add = (extra) => {
  seq += 1;
  return run([
    'decision', 'add', '--boot', pm.token, '--project', PROJECT,
    '--title', extra.title || '选个方向',
    '--summary', extra.summary || '给 Owner 两个选择',
    '--question', extra.question || ('走哪条路（样本 ' + seq + '）？'),
    '--options', extra.options || '方案A,方案B',
    '--source-kind', extra.kind || 'message',
    '--source-ref', extra.ref || ('M-沙盘-' + seq),
    '--json',
  ], { allowFail: true });
};

// ---------- F-1：六状态全拦 ----------
let scopeBlocked = 0;
for (const [id, status] of statuses.slice(0, 6)) {
  const r = add({ title: '选个方向', kind: 'requirement', ref: id });
  if (r.ok === false && r.code === 'DECISION_SCOPE_FORBIDDEN') scopeBlocked += 1;
  else check(`F-1 状态 ${status} 应拦截`, false, r);
}
check('F-1 六状态（open/ready/approved/dispatched/dev/test_done）全部 DECISION_SCOPE_FORBIDDEN', scopeBlocked === 6, { scopeBlocked });

// ---------- approved 也拦 + 收口后「复盘」放行 ----------
const approved = add({ title: '选个方向', kind: 'requirement', ref: 'R-20261114-150003-cccc' });
check('F-1 approved 也被拦', approved.ok === false && approved.code === 'DECISION_SCOPE_FORBIDDEN', approved);
const closedNoReview = add({ title: '选个方向', kind: 'requirement', ref: 'R-20261114-150007-a1b2' });
check('F-1 已收口但标题不是「复盘」→ 拦', closedNoReview.ok === false && closedNoReview.code === 'DECISION_SCOPE_FORBIDDEN', closedNoReview);
const closedReview = add({ title: '复盘：这单为什么拖这么久', kind: 'requirement', ref: 'R-20261114-150007-a1b2' });
check('F-1 已收口 + 标题「复盘…」→ 放行', closedReview.ok === true, closedReview);

// ---------- F-1b：语义拦截 ----------
const gateOptions = add({ options: '通过,打回' });
check('F-1b 门禁选项（通过/打回）→ DECISION_REVIEW_ACTION_FORBIDDEN', gateOptions.ok === false && gateOptions.code === 'DECISION_REVIEW_ACTION_FORBIDDEN', gateOptions);
const intentWord = add({ title: '这单要不要验收通过' });
check('F-1b 意图词（验收通过）→ DECISION_REVIEW_ACTION_FORBIDDEN', intentWord.ok === false && intentWord.code === 'DECISION_REVIEW_ACTION_FORBIDDEN', intentWord);
const normalOptions = add({ options: '方案A,方案B' });
check('F-1b 负例（方案A/方案B）放行', normalOptions.ok === true, normalOptions);
// v5.1 AC1：正例 question=「方案 A 还是 B」成功；负例 options=[方案A,方案B] 不误拦
const ac1Positive = add({ title: '方案取舍', question: '方案 A 还是 B？', options: '方案A,方案B' });
check('AC1 正例：question=方案 A 还是 B 成功入箱', ac1Positive.ok === true, ac1Positive);
const ac1Negative = add({ title: '选路', options: '方案A,方案B' });
check('AC1 负例：options=[方案A,方案B] 不误拦', ac1Negative.ok === true, ac1Negative);

// ---------- F-2：文案 5 样本 ----------
const samples = [
  ['R-20261114-141252-e717 这个怎么定', 'DECISION_COPY_CODE_NAME'],
  ['B-20261114-141700-d1e5 遗留怎么处理', 'DECISION_COPY_CODE_NAME'],
  ['B 方案和 M 轮哪个对', 'OK'],
  ['XB-20261114-141700-d1e5 不该误伤', 'OK'],
  ['D-20261114-134219 这条怎么办', 'OK'],
];
for (const [title, expect] of samples) {
  const r = add({ title });
  if (expect === 'OK') check(`F-2 样本「${title}」不误伤`, r.ok === true, r);
  else check(`F-2 样本「${title}」→ ${expect}`, r.ok === false && r.code === expect, r);
}
const stageName = add({ title: '这单卡在 test_done 了吗' });
check('F-2 阶段名 test_done → DECISION_COPY_CODE_NAME', stageName.ok === false && stageName.code === 'DECISION_COPY_CODE_NAME', stageName);

// ---------- F-2 历史兜底：直接写一条带代号的历史条目 ----------
const box = fs.existsSync(boxFile) ? JSON.parse(fs.readFileSync(boxFile, 'utf8')) : { items: [] };
box.items.push({
  id: 'D-20261114-150900-h1st', title: '历史：R-20261114-150007-a1b2 的后续', summary: 'D-20260101-000000-dead 之类的未知代号',
  question: '怎么办？', source: { kind: 'message', ref: 'M-旧' }, createdAt: now, by: 'pm', status: 'open',
  options: ['方案A', '方案B'], readAt: null, answeredAt: null, archivedAt: null, updatedAt: now,
  decision: null, receipt: { messageId: null, at: null, choice: null, opinion: null }, receiptSeq: 0,
});
fs.writeFileSync(boxFile, JSON.stringify(box, null, 2) + '\n', 'utf8');
const listed = run(['decision', 'list', '--project', PROJECT, '--all', '--json']);
const hist = (listed.items || []).find((row) => row.id === 'D-20261114-150900-h1st');
check('F-2 历史：已知代号渲染成需求名', Boolean(hist) && hist.title.includes('决策箱产品级收口') && !hist.title.includes('R-20261114-150007-a1b2'), hist && hist.title);
check('F-2 历史：未知代号保留并标「（未识别）」', Boolean(hist) && hist.summary.includes('（未识别）') && hist.summary.includes('D-20260101-000000-dead'), hist && hist.summary);

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\nR-e717 范围/语义/文案断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
fs.writeFileSync(path.join(SB, 'run-decision-scope.json'), JSON.stringify({ at: now, passed, failed, results }, null, 2) + '\n', 'utf8');
if (failed) process.exitCode = 1;
