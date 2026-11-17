'use strict';
const { rmSandbox, uniqueSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * B-20261116-201956-e616 端到端：缺陷单验收（CLI `task accept --as pm`）第二件证据用 .log/.json 的 record。
 *
 * 覆盖：
 *   ① 报告:report + run.log:record → 验收通过，acceptanceRecord.evidence 里 kind 落 record；
 *   ② 报告:report + run.json（省略 :record，按后缀推断）→ 同样通过；
 *   ③ 只有报告一件 → SECOND_EVIDENCE_REQUIRED（未被放宽）；
 *   ④ 记录文件不存在 → PM_ACCEPT_EVIDENCE_REQUIRED + FILE_NOT_FOUND；
 *   ⑤ 需求级代验收严门不回归：validatePmAcceptEvidence 对 report+record 仍缺 screenshot。
 *
 * 沙盘：_tmp/e616-cli/（TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_SELFTEST=1），不碰真实项目。
 * 跑法：node scripts/test-e616-cli.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = uniqueSandbox('e616-cli');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TEAM_TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = 'e616沙盘';
const P_DIR = path.join(PROJECTS, PROJECT);
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail ?? null)).slice(0, 300)}`);
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
// 沙盘名册清空 sessionId，避免任何唤醒/投递落到真实角色（B-3c03 教训）
const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
if (fs.existsSync(teamFile)) {
  const t = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  for (const m of t.members || []) m.sessionId = '';
  fs.writeFileSync(teamFile, JSON.stringify(t, null, 2) + '\n', 'utf8');
}

run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'e616-pm', '--json']);
const tester = run(['boot', '--role', 'tester', '--project', PROJECT, '--session', 'e616-t', '--json']);

// 证据夹具（相对项目根）
const dir = path.join(P_DIR, '测试人员', '产出', '证据-e616');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(P_DIR, '测试人员', '产出', '测试确认-e616.md'), '# 测试确认\n结论：通过（65/65）\n');
fs.writeFileSync(path.join(dir, 'run.log'), 'PASS 65/65\n');
fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ ok: true, pass: 65 }) + '\n');
const REPORT = '测试人员/产出/测试确认-e616.md';
const LOG = '测试人员/产出/证据-e616/run.log';
const JSONF = '测试人员/产出/证据-e616/run.json';
const OPINION = 'e616 沙盘验收：第二件证据为记录文件';

function newBug(title) {
  const r = run(['task', 'create', '--boot', tester.token, '--project', PROJECT, '--title', title, '--priority', 'P1', '--type', 'bug',
    '--acceptance', '第二件证据可用记录文件', '--repro', '跑一遍验收命令', '--expected', '通过', '--actual', '报 SECOND_EVIDENCE_REQUIRED', '--json'], true);
  return r && r.task ? r.task.id : null;
}

// ① 报告 + .log:record
const b1 = newBug('e616 缺陷一：log 记录');
check('① 建缺陷单成功', Boolean(b1), b1);
const a1 = run(['task', 'accept', '--task', b1, '--as', 'pm', '--opinion', OPINION, '--boot', pm.token, '--project', PROJECT,
  '--evidence', `${REPORT}:report`, '--evidence', `${LOG}:record`, '--json'], true);
check('① 报告 + run.log:record → 验收通过', a1.ok === true && a1.action === 'accept', a1.code || a1.raw);
const rec1 = a1 && a1.acceptanceRecord;
check('① acceptanceRecord 两件且第二件 kind=record',
  Boolean(rec1 && Array.isArray(rec1.evidence) && rec1.evidence.length === 2
    && rec1.evidence[0].kind === 'report' && rec1.evidence[1].kind === 'record'
    && rec1.evidence[1].path === LOG), rec1 && rec1.evidence);
check('① 证据带 sha256，testReport 指向报告', Boolean(rec1 && /^[0-9a-f]{64}$/.test(rec1.evidence[1].sha256 || '') && rec1.testReport === REPORT), rec1);

// ② 报告 + .json（不写 kind，按后缀推断）
const b2 = newBug('e616 缺陷二：json 记录');
const a2 = run(['task', 'accept', '--task', b2, '--as', 'pm', '--opinion', OPINION, '--boot', pm.token, '--project', PROJECT,
  '--evidence', `${REPORT}:report`, '--evidence', JSONF, '--json'], true);
check('② 报告 + run.json（省略 kind）→ 验收通过且推断 record',
  a2.ok === true && a2.acceptanceRecord && a2.acceptanceRecord.evidence.some((e) => e.path === JSONF && e.kind === 'record'),
  a2.code || (a2.acceptanceRecord && a2.acceptanceRecord.evidence));

// ③ 只有报告 → 第二件证据仍必须给（未被放宽）
const b3 = newBug('e616 缺陷三：只有报告');
const a3 = run(['task', 'accept', '--task', b3, '--as', 'pm', '--opinion', OPINION, '--boot', pm.token, '--project', PROJECT,
  '--evidence', `${REPORT}:report`, '--json'], true);
check('③ 只有报告 → SECOND_EVIDENCE_REQUIRED', a3.ok === false && (a3.code === 'PM_ACCEPT_EVIDENCE_REQUIRED' || a3.code === 'SECOND_EVIDENCE_REQUIRED')
  && JSON.stringify(a3.missing || a3.details || {}).includes('SECOND_EVIDENCE_REQUIRED'), a3.code || a3.raw);

// ④ 记录文件不存在 → 拒收并给 FILE_NOT_FOUND
const b4 = newBug('e616 缺陷四：记录缺失');
const a4 = run(['task', 'accept', '--task', b4, '--as', 'pm', '--opinion', OPINION, '--boot', pm.token, '--project', PROJECT,
  '--evidence', `${REPORT}:report`, '--evidence', '测试人员/产出/证据-e616/不存在.log:record', '--json'], true);
check('④ 记录不存在 → 拒收且含 FILE_NOT_FOUND', a4.ok === false && JSON.stringify(a4).includes('FILE_NOT_FOUND'), a4.code || a4.raw);

// ⑤ 需求级严门不回归（直接 import 校验函数）
const modUrl = 'file:///' + path.join(TEAM_ROOT, '工具', 'lib', 'pm-accept-evidence.mjs').replace(/\\/g, '/');
const strict = execFileSync(process.execPath, ['-e', `
import('${modUrl}').then((m) => {
  const items = m.parseEvidenceArg('${REPORT}:report,${LOG}:record');
  const v = m.validatePmAcceptEvidence({ items, projectPath: ${JSON.stringify(P_DIR)} });
  console.log(JSON.stringify({ ok: v.ok, missing: v.missing.map((x) => x.reason) }));
});
`], { cwd: SB, env, encoding: 'utf8' }).trim();
check('⑤ 需求级代验收仍要求截图（report+record → SCREENSHOT_REQUIRED）',
  strict.includes('SCREENSHOT_REQUIRED'), strict);

console.log('\n===== ' + (results.every((r) => r.ok) ? 'ALL PASS' : 'FAILED') + ' pass=' + results.filter((r) => r.ok).length + ' fail=' + results.filter((r) => !r.ok).length + ' =====');
try { rmSandbox(SB, { recursive: true, force: true }); } catch { /* ignore */ }
