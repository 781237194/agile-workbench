'use strict';
/**
 * 回归：零式 `ZERO_FAIL_RE` 不能把「需求短号尾号 0」当成零值。
 * 背景：短号形如 `3b50` 时，`3b50 不通过` 会被 `0\s*不通过` 误剔成零式 → 判 pass（test-advance-report-gate 偶发红）。
 * 修法：`0` 前加负向断言 `(?<![A-Za-z0-9])`，只认独立 0。
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(detail).slice(0, 160)}`);
  if (!ok) process.exitCode = 1;
}

(async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs')).href);
  const f = mod.failVerdictText;
  const cases = [
    ['3b50 不通过（2 条未过）', true, '短号尾 0 must fail'],
    ['R-20261116-065958-3b50 不通过', true, '完整 id 尾 0 must fail'],
    ['b50 不通过', true, '任意尾 0 前缀 must fail'],
    ['0 失败', false, '独立 0 仍是零式'],
    ['没有 不通过', false, '「没有」仍是零式'],
    ['零失败', false, '「零」仍是零式'],
    ['失败 0 项', false, 'FAIL_ZERO2 仍生效'],
  ];
  for (const [text, expect, why] of cases) check(`${why}：${text}`, f(text) === expect, { got: f(text), expect });
  const pass = results.filter((r) => r.ok).length;
  const evid = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-d06ec');
  fs.mkdirSync(evid, { recursive: true });
  fs.writeFileSync(path.join(evid, 'run-zero-shortkey.log'), results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`).join('\n') + '\n', 'utf8');
  console.log(`\n零式短号回归：${pass}/${results.length} PASS`);
})().catch((e) => { console.error('RUN_FAILED', (e && e.stack) || e); process.exitCode = 1; });
