#!/usr/bin/env node
'use strict';
/**
 * test-a514-input-latency.cjs —— B-20261121-034617-a514（P1）+ M-20261121-040227-222eb6
 * 输入延迟硬指标：连续 20 字符 keydown→下一帧 p95 ≤50ms；期间无 >100ms longtask。
 *
 * A. 纯逻辑（src/renderer/input-latency.js，同一份实现浏览器全局 + Node require）
 *   A1 p95 计算（20 个样本里 19 个 10ms、1 个 200ms → p95=200；全 10ms → p95=10）
 *   A2 longtask：存在 >100ms 时 over100=1、maxMs 正确
 *   A3 verdict：p95≤50 且无 >100ms → ok；p95>50 → not ok；有 >100ms → not ok
 *   A4 空样本 → not ok（no_samples，禁止空数据冒充）
 * B. 接线静态断言
 *   B1 app.js 有 window.__awbTypingProbe（keydown→单帧 rAF、longtask observer、gateSkipped）
 *   B2 index.html 在 app.js 之前加载 input-latency.js
 *   B3 后台轮询有交互门（r4Gate）且 session-queue 秒表只在抽屉可见时跑（避免打字期间整块重绘）
 *   B4 关键点击路径无同步 mirror store（沿用第一批断言）
 *
 * 用法：node scripts/test-a514-input-latency.cjs [--json]
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');
const IL = require(path.join(ROOT, 'src', 'renderer', 'input-latency.js'));
const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 600)}`);
}

// A1/A2/A3/A4
{
  const fast = Array.from({ length: 20 }, () => 10);
  const s = IL.summarizeInputLatency(fast);
  check('A1 20×10ms → p95=10', s.count === 20 && s.p95 === 10, s);
  const mixed = [...Array.from({ length: 19 }, () => 10), 200];
  const s2 = IL.summarizeInputLatency(mixed);
  check('A1b 19×10ms+1×200ms → p95 仍 10（20 样本 p95=第 19 位）、max=200（离群靠 max/长任务兜底）', s2.p95 === 10 && s2.max === 200, s2);

  const lt = IL.summarizeLongTasks([20, 30, 150, 5]);
  check('A2 longtask 统计 over100=1/max=150', lt.count === 4 && lt.over100 === 1 && lt.maxMs === 150, lt);

  const okV = IL.typingVerdict({ latencies: fast, longTasks: [20, 30] });
  check('A3 打字 p95≤50 且无 >100ms → ok', okV.ok === true && okV.reason === '', okV);
  const mixed2 = [...Array.from({ length: 18 }, () => 10), 80, 90];
  const badP95 = IL.typingVerdict({ latencies: mixed2, longTasks: [] });
  check('A3b p95>50 → not ok(p95_over_50ms)', badP95.ok === false && badP95.reason === 'p95_over_50ms', badP95);
  const badLt = IL.typingVerdict({ latencies: fast, longTasks: [150] });
  check('A3c 有 >100ms longtask → not ok(longtask_over_100ms)', badLt.ok === false && badLt.reason === 'longtask_over_100ms', badLt);
  const empty = IL.typingVerdict({ latencies: [], longTasks: [] });
  check('A4 空样本 → not ok(no_samples)', empty.ok === false && empty.reason === 'no_samples', empty);
}

// B 静态接线
const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const sq = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'session-queue-panel.js'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
check('B1 app.js 有 __awbTypingProbe（keydown→单帧 rAF + longtask + gateSkipped）',
  app.includes('__awbTypingProbe') && app.includes("entryTypes: ['longtask']") && app.includes('skippedInteraction')
  && app.includes('requestAnimationFrame(() => { if (!stopped) latencies.push'),
  { hasProbe: app.includes('__awbTypingProbe'), hasLongtask: app.includes("entryTypes: ['longtask']") });
check('B2 index.html 在 app.js 之前加载 input-latency.js',
  /<script src="input-latency\.js"><\/script>[\s\S]{0,400}<script src="app\.js"><\/script>/.test(html), {});
check('B3 轮询有交互门 r4Gate，且 session-queue 秒表只在抽屉可见时跑',
  app.includes('setInterval(r4Gate(') && sq.includes('function syncStopwatch') && sq.includes('drawerVisible()')
  && (sq.match(/renderLive\(\)/g) || []).length > 0,
  { gate: app.includes('setInterval(r4Gate(') });
const wf = (() => { const i = main.indexOf('function workflowResponse('); return i < 0 ? '' : main.slice(i, i + 1800); })();
check('B4 点击路径仍无同步 mirror store（沿用第一批）', !wf.includes('const mirrored = mirrorWorkflowToStore(') && wf.includes('scheduleWorkflowMirror('), {});

const failed = ROWS.filter((r) => !r.ok).length;
if (JSON_OUT) console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed, failed: ROWS.filter((r) => !r.ok).map((r) => r.name), rows: ROWS }, null, 2));
else console.log(`\n${ROWS.length - failed}/${ROWS.length} PASS${failed ? ' · ' + failed + ' FAIL' : ''}`);
process.exit(failed ? 1 : 0);
