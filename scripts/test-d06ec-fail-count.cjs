'use strict';
const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * D-20261116-062141-06ec（Owner 选 B：只认带数字的「失败 N 项」）断言。
 *
 * 直接 import 沙盘里的 ops.mjs（复制真实 团队/ + 当前工作树 ops），调 failVerdictText：
 *  - 该判负的：失败 2 项 / 失败 3 条 / 失败 12 个 / 结论：不通过 / 1 项未通过 / 有 1 项 FAIL / 失败 2 项但另 3 项通过
 *  - 该放过的：失败 0 项 / 0 失败 / 失败零副作用 / 失败原因见 §二 / 失败项已在 §三 说明 /
 *              不构成不通过 / 无 FAIL 命中 / 未发现 FAIL 全部合格 / 除非失败，否则通过
 *  - 附加：证据备注（task done 路径）也走同一函数，用同表兜底。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'd06ec');
const TEAM = path.join(SB, '团队');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(detail).slice(0, 200)}`);
  if (!ok) process.exitCode = 1;
}
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

rmSandbox(SB, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
fs.mkdirSync(TEAM, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) && !/[\\/]邮箱[\\/]/.test(src) });
const realOps = path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs');
const sbOps = path.join(TEAM, '工具', 'lib', 'ops.mjs');
check('沙盘 ops.mjs = 工作树现值（防止测到旧版）', sha(sbOps) === sha(realOps), { worktree: sha(realOps).slice(0, 16) });

process.env.TEAM_ROOT = TEAM;
process.env.TEAM_PROJECTS_ROOT = path.join(TEAM, '状态', '项目');
process.env.TEAM_SELFTEST = '1';

(async () => {
  const mod = await import(pathToFileURL(sbOps).href);
  check('工作树导出 failVerdictText（可单测）', typeof mod.failVerdictText === 'function', typeof mod.failVerdictText);
  const f = mod.failVerdictText;

  const mustFail = [
    'status: 失败 2 项',
    '失败 3 条',
    '失败 12 个',
    '结论：不通过',
    'status: 通过 3/4，1 项未通过',
    '有 1 项 FAIL',
    '失败 2 项，但另 3 项通过',
    '失败 2 项未修复',
  ];
  for (const line of mustFail) check(`判负：${line}`, f(line) === true, line);

  const mustPass = [
    '失败 0 项',
    '0 失败',
    '失败零副作用',
    '失败原因见 §二',
    '失败项已在 §三 说明',
    '不构成不通过',
    '无 FAIL 命中',
    '未发现 FAIL，全部合格',
    '除非失败，否则通过',
    '通过（26/27）',
    '失败 2 项已修复',
    '失败 2 项已全部修复',
    '失败 2 项已处理',
  ];
  for (const line of mustPass) check(`放过：${line}`, f(line) === false, line);

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\nD-06ec 失败N项断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
  const evid = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-d06ec');
  fs.mkdirSync(evid, { recursive: true });
  fs.writeFileSync(path.join(evid, 'run-d06ec.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(evid, 'run-d06ec.log'), results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`).join('\n') + '\n', 'utf8');
  if (!process.env.AWB_KEEP_SANDBOX) {
    try { rmSandbox(SB, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch { /* ignore */ }
  }
})().catch((e) => { console.error('RUN_FAILED', (e && e.stack) || e); process.exitCode = 1; });
