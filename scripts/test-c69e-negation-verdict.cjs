'use strict';
const { rmSandbox, uniqueSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * B-20261115-171015-c69e 沙盘断言：报告结论门识别否定句/零值短语。
 *
 * 走真实函数：沙盘复制 团队/ 并把 lib/ops.mjs 换成提案暂存版（不碰工作树），
 * 直接 import readTestReportVerdict，用「测试人员/产出/测试报告-v1.md」不同正文逐例判定。
 *
 * 期望：
 *  ①「通过（不构成不通过）」→ pass
 *  ②「通过，无 FAIL 命中」→ pass
 *  ③「通过；0 失败」→ pass
 *  ④「FAIL 0 条」→ pass
 *  ⑤「结论：不通过」→ fail
 *  ⑥「通过 3/4，1 项未通过」→ fail（残留未否定负例）
 *  ⑦「未发现 FAIL」→ pass
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SB = uniqueSandbox('c69e');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM, '工具', 'team.mjs');
const STAGED = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '提案暂存-c69e', 'ops.mjs');
const PROJECT = 'c69e报告门沙盘';
const env = { ...process.env, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 300)}`);
  if (!ok) process.exitCode = 1;
}
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

rmSandbox(SB, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
fs.copyFileSync(STAGED, path.join(TEAM, '工具', 'lib', 'ops.mjs'));
check('沙盘 ops.mjs = 提案暂存版（不碰工作树）', sha(path.join(TEAM, '工具', 'lib', 'ops.mjs')) === sha(STAGED), { staged: sha(STAGED).slice(0, 16) });

const teamFile = path.join(TEAM, '状态', '团队.json');
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
for (const m of team.members || []) m.sessionId = '';
team.activeProject = PROJECT;
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
execFileSync(process.execPath, [TOOL, 'project', 'add', '--name', PROJECT, '--team-mode', 'fast', '--json'], { cwd: SB, env, encoding: 'utf8' });

const projectDir = path.join(PROJECTS, PROJECT);
const outDir = path.join(projectDir, '测试人员', '产出');
fs.mkdirSync(outDir, { recursive: true });
const REPORT = path.join(outDir, '测试报告-v1.md');
const REQ = 'R-20261116-060000-c69e';
function writeReport(line) {
  fs.writeFileSync(REPORT, `# 测试报告\n\n## ${REQ}\n\n${line}\n`, 'utf8');
}
const task = { requirementId: REQ, evidence: '测试人员/产出/测试报告-v1.md', evidenceFiles: [] };

process.env.TEAM_ROOT = TEAM;
process.env.TEAM_PROJECTS_ROOT = PROJECTS;
process.env.TEAM_SELFTEST = '1';

(async () => {
  const mod = await import(pathToFileURL(path.join(TEAM, '工具', 'lib', 'ops.mjs')).href);
  const verdict = mod.readTestReportVerdict;
  check('暂存版导出 readTestReportVerdict（可单测）', typeof verdict === 'function', typeof verdict);

  const cases = [
    ['status: 通过（不构成不通过）', 'pass', '不构成不通过'],
    ['status: 通过，无 FAIL 命中', 'pass', '无 FAIL'],
    ['status: 通过；0 失败', 'pass', '0 失败'],
    ['status=FAIL 0 条', 'pass', 'FAIL 0 条'],
    ['结论：不通过', 'fail', '真负例不通过'],
    ['status: 通过 3/4，1 项未通过', 'fail', '残留未否定负例'],
    ['结论：未发现 FAIL，全部合格', 'pass', '未发现 FAIL'],
  ];
  for (const [line, expect, label] of cases) {
    writeReport(line);
    const r = verdict(PROJECT, task);
    check(`「${label}」→ ${expect}`, Boolean(r) && r.verdict === expect, { line, got: r && r.verdict, snippet: r && r.snippet });
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\nB-c69e 否定句判定断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
  const evid = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-c69e');
  fs.mkdirSync(evid, { recursive: true });
  fs.writeFileSync(path.join(evid, 'run-c69e.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
  if (!process.env.AWB_KEEP_SANDBOX) {
    try { rmSandbox(SB, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch { /* 清理失败不影响结论 */ }
  }
})().catch((error) => {
  console.error('RUN_FAILED', (error && error.stack) || error);
  process.exitCode = 1;
});
