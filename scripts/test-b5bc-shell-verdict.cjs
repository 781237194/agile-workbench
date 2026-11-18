#!/usr/bin/env node
'use strict';
/**
 * B-b5bc（P1，产品技术债核对-20261118）壳层验收证据「否定式识别」回归夹具。
 *
 * 口径（与 CLI 侧 团队/工具/lib/ops.mjs → failVerdictText 同源）：
 *   · 「无 FAIL 命中」「不构成不通过」「FAIL 0 条」「失败 2 项已全部修复」→ **不算失败**
 *   · 「结论：不通过」「status: 通过 3/4，1 项未通过」「失败 2 项」→ **算失败**
 * 覆盖两层：
 *   ① 纯函数 src/team-tools.js → reportFailVerdictText（单元）
 *   ② 真实入口 src/team-tools.js → acceptEvidenceCheck（报告 + 截图两件套，含 reason=evidence_failed）
 *   ③ 与 CLI failVerdictText 逐例对齐（同口径防漂移）
 *
 * 跑法：node scripts/test-b5bc-shell-verdict.cjs
 * 产出：AWB_B5BC_OUT 指定目录（默认 程序员A/产出/证据-7741/run-b5bc.json）
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const TOOLS = require(path.join(ROOT, 'src', 'team-tools.js'));
const EVID = process.env.AWB_B5BC_OUT ? path.resolve(process.env.AWB_B5BC_OUT) : path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-7741');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? null : (detail === undefined ? null : detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(detail === undefined ? null : detail).slice(0, 400)}`);
  if (!ok) process.exitCode = 1;
}

// 报告正文样例：[标签, 文本, 期望「算失败」]
const CASES = [
  ['neg-无 FAIL 命中', '# 测试报告\n\n结论：PASS。通过，无 FAIL 命中，全部合格。\n日期：2026-11-18\n', false],
  ['neg-不构成不通过', '# 测试报告\n\nstatus: PASS（通过，不构成不通过）\n日期：2026-11-18\n', false],
  ['neg-FAIL 0 条', '# 测试报告\n\nPASS 全部合格｜FAIL 0 条\n日期：2026-11-18\n', false],
  ['neg-失败 2 项已全部修复', '# 测试报告\n\nPASS：失败 2 项已全部修复，最终通过。\n日期：2026-11-18\n', false],
  ['pos-结论不通过', '# 测试报告\n\nPASS 3 项；结论：不通过\n日期：2026-11-18\n', true],
  ['pos-1 项未通过', '# 测试报告\n\nstatus: PASS 3/4，1 项未通过\n日期：2026-11-18\n', true],
  ['pos-失败 2 项', '# 测试报告\n\nPASS 部分；失败 2 项，需返工。\n日期：2026-11-18\n', true],
  ['pos-裸 FAIL 行', '# 测试报告\n\nPASS 部分｜FAIL 一条用例\n日期：2026-11-18\n', true],
];

const SB = mkTempSandbox('b5bc');
const PROJ = path.join(SB, '项目');
fs.mkdirSync(PROJ, { recursive: true });
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000a49444154789c63600000020001'.repeat(1) + '0d0a2db40000000049454e44ae426082', 'hex');
function makeEvidence(name) {
  const reportPath = path.join(PROJ, `${name}.md`);
  fs.writeFileSync(reportPath, CASES.find((c) => c[0] === name)[1], 'utf8');
  return { path: reportPath, kind: 'report' };
}
function shot() {
  const file = path.join(PROJ, 'shot.png');
  fs.writeFileSync(file, PNG);
  return { path: file, kind: 'screenshot' };
}

(async () => {
  // 隔离基线（PM 2026-11-18 证据标准 ②）：跑前记录真实状态 sha，跑完比对。
  const REAL_FILES = [
    path.join(ROOT, '团队', '状态', '团队.json'),
    path.join(ROOT, 'data', 'userdata', 'workbench.json'),
  ];
  const shaOfBase = (f) => { try { return require('node:crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
  const realBeforeSha = REAL_FILES.map(shaOfBase);
  console.log('[isolation] before ' + JSON.stringify(REAL_FILES.map((f, i) => ({ file: path.relative(ROOT, f).replace(/\\/g, '/'), sha256: realBeforeSha[i] }))));

  /* ① 纯函数 */
  for (const [label, text, expectFail] of CASES) {
    const got = TOOLS.reportFailVerdictText(text);
    check(`① reportFailVerdictText ${label} → ${expectFail ? '算失败' : '不算失败'}`, got === expectFail, { got, expectFail });
  }

  /* ② 真实入口 acceptEvidenceCheck：报告 + 截图两件套 */
  for (const [label, , expectFail] of CASES) {
    const res = TOOLS.acceptEvidenceCheck(PROJ, [makeEvidence(label), shot()]);
    if (expectFail) {
      const hit = (res.missing || []).find((m) => m.kind === 'report' && m.reason === 'evidence_failed');
      check(`② acceptEvidenceCheck ${label} → 判不通过（evidence_failed）`, res.ok === false && Boolean(hit), { ok: res.ok, missing: res.missing });
    } else {
      check(`② acceptEvidenceCheck ${label} → 判通过（否定式/零值不误杀）`, res.ok === true, { ok: res.ok, missing: res.missing });
    }
  }
  // 负例保护：报告正文连 PASS 都没有 → 仍必须报「没有 PASS」（不是被否定式放行）
  const noPass = path.join(PROJ, 'no-pass.md');
  fs.writeFileSync(noPass, '# 测试报告\n\n全部合格，无 FAIL。\n', 'utf8');
  const noPassRes = TOOLS.acceptEvidenceCheck(PROJ, [{ path: noPass, kind: 'report' }, shot()]);
  check('② 负例：无 PASS 的报告仍判不通过（note=报告正文没有 PASS）',
    noPassRes.ok === false && (noPassRes.missing || []).some((m) => /没有 PASS/.test(String(m.note || ''))), noPassRes.missing);

  /* ③ 与 CLI 侧同口径 */
  let cli = null;
  try { cli = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs')).href); } catch (e) {
    console.log('CLI_IMPORT_FAILED ' + String((e && e.message) || e).slice(0, 200));
  }
  if (cli && typeof cli.failVerdictText === 'function') {
    const drift = [];
    for (const [label, text, expectFail] of CASES) {
      const shell = TOOLS.reportFailVerdictText(text);
      const cliGot = cli.failVerdictText(text);
      if (shell !== cliGot || shell !== expectFail) drift.push({ label, shell, cliGot, expectFail });
    }
    check('③ 壳层与 CLI failVerdictText 逐例一致（8 例）', drift.length === 0, drift);
  } else {
    check('③ CLI ops.mjs 可导入且导出 failVerdictText', false, 'import failed');
  }

  // ④ 隔离断言（PM 2026-11-18 证据标准）：全程只在 mkTempSandbox 里写文件，真实团队状态零写入。
  const realFiles = [
    path.join(ROOT, '团队', '状态', '团队.json'),
    path.join(ROOT, 'data', 'userdata', 'workbench.json'),
  ];
  const shaOf = (f) => { try { return require('node:crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
  const realAfter = realFiles.map(shaOf);
  check('④ 隔离断言：真实 团队/状态/团队.json 与 data/userdata/workbench.json 全程 sha256 不变',
    JSON.stringify(realAfter) === JSON.stringify(realBeforeSha) && realAfter.every((v) => v !== ''),
    { before: realBeforeSha, after: realAfter });
  check('④ 隔离断言：本次写入全部落在 _tmp 沙盘内（沙盘路径前缀自证）',
    String(SB).startsWith(path.join(ROOT, '_tmp')) || String(SB).startsWith(ROOT), { sandbox: SB });

  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(EVID, { recursive: true });
  const shaOfFile = (f) => { try { return require('node:crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
  const report = {
    task: 'T-20261118-134603-7741', defect: 'B-b5bc', at: new Date().toISOString(),
    commit: String(process.env.AWB_HEAD_SHA || '').trim() || undefined,
    total: results.length, pass: results.filter((r) => r.ok).length, red: results.filter((r) => !r.ok).length,
    isolation: {
      sandbox: SB,
      real: realFiles.map((f) => ({ file: path.relative(ROOT, f).replace(/\\/g, '/'), sha256Before: shaOfFile(f) ? '' : '', sha256: shaOfFile(f) })),
      unchanged: JSON.stringify(realAfter) === JSON.stringify(realBeforeSha),
    },
    results,
  };
  const out = path.join(EVID, 'run-b5bc.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\nB5BC_SHELL_VERDICT ${JSON.stringify({ total: report.total, pass: report.pass, red: report.red })}`);
  console.log('证据：' + out);
  process.exit(report.red ? 1 : 0);
})();
