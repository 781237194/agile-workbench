#!/usr/bin/env node
'use strict';
/**
 * 正式入口别名（R-fa0e AC9 / T-20261117-211053-f35b②）：`auto-rotate-check`
 *
 * 需求 §六 写的是 `auto-rotate-check` → 输出 `AUTO_ROTATE_CHECK_OK`；实际断言一直在
 * `scripts/test-auto-rotate-tick.cjs`。本文件是**薄壳**：内部跑同一套断言（同一脚本），
 * 把它作为正式入口暴露给验收/CI，不复制断言、不改需求文案。
 *
 * 跑法：node scripts/auto-rotate-check.cjs [--json]
 * 输出：全绿 `AUTO_ROTATE_CHECK_OK {...}`（exit 0）；有红透传子脚本输出 + exit 1。
 */
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const INNER = path.join(ROOT, 'scripts', 'test-auto-rotate-tick.cjs');
const jsonOut = process.argv.includes('--json');

const r = spawnSync(process.execPath, [INNER], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
const out = String(r.stdout || '');
const err = String(r.stderr || '');
if (!jsonOut) {
  process.stdout.write(out);
  if (err.trim()) process.stderr.write(err);
}
const ok = r.status === 0 && /AUTO_ROTATE_TICK_OK/.test(out);
const summary = (() => {
  const m = out.match(/AUTO_ROTATE_TICK_(?:OK|WARN)\s+(\{[^}]*\})/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
})();
if (jsonOut) {
  process.stdout.write(JSON.stringify({ ok, inner: 'scripts/test-auto-rotate-tick.cjs', exit: r.status, summary }, null, 2) + '\n');
} else {
  console.log('');
  console.log(`${ok ? 'AUTO_ROTATE_CHECK_OK' : 'AUTO_ROTATE_CHECK_FAIL'} ${JSON.stringify({ inner: 'scripts/test-auto-rotate-tick.cjs', ...(summary || {}) })}`);
}
process.exit(ok ? 0 : 1);
