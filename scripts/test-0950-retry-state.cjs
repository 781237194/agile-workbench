#!/usr/bin/env node
'use strict';
/**
 * test-0950-retry-state.cjs —— B-20261118-085825-0950 回归夹具
 *
 * 缺陷：一次唤醒失败（fetch failed，目标会话忙）→ 60 秒后重试成功，但面板按「最新一条」判 fail，
 * 这 60 秒用户看到闪红。修法：新增 retry（重试中，黄）态——
 *   最新一条 fail 且 now−at < 重试窗口（默认 90s，AWB_SQ_RETRY_WINDOW_MS 可配）且连续失败 <2 → retry；
 *   连续 ≥2 条失败或超窗口 → fail；计数口径不变。
 *
 * 断言（纯函数，注入 now，不碰真实状态）：
 *   A fail(retried) → +60s ok：t1=retry、t2=ok
 *   B fail 无后续：窗口内 retry / 窗口外 fail
 *   C 连续 2 条 fail → 立即 fail
 *   D 旧日志（无 retried 字段）→ 仍按窗口判（窗口内 retry / 窗口外 fail）
 *   E 计数不变：failCount 不因状态变 retry 而减少
 *   F 壳与面板都认 retry（源码静态：summarizeRows 出 retry / STATE_LABEL 有 retry / CSS 黄 / 插件同口径）
 *
 * 跑法：node scripts/test-0950-retry-state.cjs   （AWB_0950_OUT 指定 run.json）
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const Q = require(path.join(ROOT, 'src', 'session-queue.js'));
let pass = 0;
const results = [];
function ok(name, cond, detail) {
  results.push({ name, ok: Boolean(cond) });
  if (cond) { pass += 1; console.log(`PASS  ${name}`); return; }
  console.log(`FAIL  ${name}  ` + JSON.stringify(detail || {}).slice(0, 300)); process.exitCode = 1;
}

const NOW = Date.parse('2026-11-18T09:00:00.000Z');
const T = (deltaSec) => new Date(NOW - deltaSec * 1000).toISOString();
const row = (secAgo, okFlag, extra = {}) => ({ at: T(secAgo), ok: okFlag, ...extra });
const stateOf = (rows, opts = {}) => Q.summarizeRows(rows, { now: NOW, ...opts });

// A：fail(retried=true) → +60s ok
{
  const t1 = stateOf([row(60, false, { retried: true, reason: 'fetch failed' })]);
  ok('A1 fail(retried=true, 60s 前) → 状态 retry（不是 fail）', t1.state === 'retry', { state: t1.state, retryUntilAt: t1.retryUntilAt });
  const t2 = stateOf([row(60, false, { retried: true }), row(1, true)]);
  ok('A2 60s 后重试成功 → 状态 ok', t2.state === 'ok', { state: t2.state });
}

// B：fail 无后续
{
  const inWin = stateOf([row(30, false)]);
  const outWin = stateOf([row(120, false)]);
  ok('B1 窗口内（30s）无重试记录 → retry', inWin.state === 'retry', { state: inWin.state });
  ok('B2 窗口外（120s）→ fail', outWin.state === 'fail', { state: outWin.state });
  const custom = stateOf([row(30, false)], { retryWindowMs: 10000 });
  ok('B3 重试窗口可配（10s）→ 30s 前已超窗 = fail', custom.state === 'fail', { state: custom.state, retryWindowMs: custom.retryWindowMs });
}

// C：连续 2 条 fail → 立即 fail
{
  const c = stateOf([row(10, false, { retried: true }), row(70, false)]);
  ok('C1 连续 2 条 fail（最新一条仍在窗口内）→ fail', c.state === 'fail', { state: c.state, consecutiveFails: c.consecutiveFails });
}

// D：旧日志无 retried 字段
{
  const d1 = stateOf([row(50, false)]);
  const d2 = stateOf([row(600, false)]);
  ok('D1 旧日志（无 retried）窗口内 → retry', d1.state === 'retry', { state: d1.state });
  ok('D2 旧日志（无 retried）窗口外 → fail', d2.state === 'fail', { state: d2.state });
}

// E：计数口径不变
{
  // 失败之间隔着一条成功：最近一条 fail 仍在窗口内、且不构成「连续 2 条」→ 状态 retry，但计数照旧全算。
  const e = stateOf([
    row(30, false, { retried: true }),
    row(70, true),
    row(90, false),
    row(150, false),
    row(300, false, { skipped: true, reason: 'ALREADY_DELIVERED' }),
  ]);
  ok('E1 failCount/skipCount/okCount 与状态解耦（failCount=3、skip=1、ok=1，状态=retry）',
    e.failCount === 3 && e.skipCount === 1 && e.okCount === 1 && e.state === 'retry',
    { state: e.state, failCount: e.failCount, skipCount: e.skipCount, okCount: e.okCount, consecutiveFails: e.consecutiveFails });
}

// F：壳与面板都认 retry（静态）
{
  const panel = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'session-queue-panel.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'style.css'), 'utf8');
  const plugin = fs.readFileSync(path.join(ROOT, 'dsh-plugin', 'pm-workbench-dsh', 'session-queue.js'), 'utf8');
  ok('F1 面板 STATE_LABEL 有 retry 且文案「重试中」', /retry:\s*'重试中/.test(panel), {});
  ok('F2 CSS 有 .sq-state-retry 且为黄色（固定琥珀 #e3b341，不被主题 var(--gold) 覆盖成青色）',
    /\.sq-row \.sq-state-retry\s*\{[^}]*#e3b341/.test(css), {});
  ok('F2b 面板把 retry 显示成中文「重试中」（其余状态仍显示原值，兼容旧断言）',
    /=== 'retry' \? '重试中'/.test(panel), {});
  ok('F3 插件 wakeStateOf 同口径（含 retry + AWB_SQ_RETRY_WINDOW_MS）', /state = 'retry'/.test(plugin) && /AWB_SQ_RETRY_WINDOW_MS/.test(plugin), {});
  ok('F4 面板把 state 值写进 data-sq-state（值=row.state，retry 会原样出现）', /setAttribute\('data-sq-state', '1'\)/.test(panel) && /sq-state-' \+ String\(row\.state/.test(panel), {});
}

const report = { task: 'B-20261118-085825-0950', at: new Date().toISOString(), total: results.length, pass, red: results.length - pass, results };
const outEnv = process.env.AWB_0950_OUT || path.join('_tmp', 'run-0950.json');
const outFile = path.isAbsolute(outEnv) ? outEnv : path.join(ROOT, outEnv);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`\nRETRY_STATE ${JSON.stringify({ total: report.total, pass: report.pass, red: report.red })}`);
console.log('证据：' + outFile);
process.exit(report.red ? 1 : 0);
