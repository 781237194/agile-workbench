#!/usr/bin/env node
'use strict';
/**
 * Owner 2026-11-18 临时需求：「快速 4 人」团队模式暂不可用——展示但不可点击，并显示标识文字
 * 「【暂不可用，工作台三期工程】」。
 *
 * 断言（静态契约，渲染层无 DOM 依赖可验）：
 *   U1 TEAM_MODES.fast 带 unavailable 文案，且文案逐字一致
 *   U2 卡片渲染时对 unavailable 输出 disabled + aria-disabled="true"（展示但不可点）
 *   U3 卡片渲染带 is-unavailable 类 + data-team-mode-unavailable 锚点（便于脚本/视觉核对）
 *   U4 点击处理器对 disabled/aria-disabled 卡片直接 return（程序化点击也无效）
 *   U5 初始选中态回落：已存 fast 的项目打开弹窗时 picked 回 'full'（避免「不可点却选中」）
 *   U6 完整 6 人模式未受影响：full 无 unavailable 字段、卡片仍可点
 *   U7 CSS 有 .team-mode-card.is-unavailable（opacity + not-allowed）且 hover 不再高亮
 *
 * 跑法：node scripts/test-fast-mode-unavailable.cjs
 * 产出：AWB_FASTMODE_OUT（默认 程序员A/产出/证据-fastmode/run-fastmode.json）
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EVID = process.env.AWB_FASTMODE_OUT ? path.resolve(process.env.AWB_FASTMODE_OUT) : path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-fastmode');
const APP = path.join(ROOT, 'src', 'renderer', 'app.js');
const CSS = path.join(ROOT, 'src', 'renderer', 'style.css');
const app = fs.readFileSync(APP, 'utf8');
const css = fs.readFileSync(CSS, 'utf8');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 300)}`);
}

const TEXT = '【暂不可用，工作台三期工程】';

check('U1 TEAM_MODES.fast 带 unavailable 标识且文案逐字一致',
  /unavailable:\s*'【暂不可用，工作台三期工程】'/.test(app), { want: TEXT });

check('U2 渲染时 unavailable 卡片输出 disabled + aria-disabled=true（展示但不可点）',
  /\$\{off \? ' disabled aria-disabled="true"' : ''\}/.test(app), {});

check('U3 卡片带 is-unavailable 类与 data-team-mode-unavailable 锚点',
  /is-unavailable/.test(app) && /data-team-mode-unavailable="\$\{def\.id\}"/.test(app), {});

check('U4 点击处理器对 disabled / aria-disabled 卡片直接 return（程序化点击也无效）',
  /if \(card\.disabled \|\| card\.getAttribute\('aria-disabled'\) === 'true'\) return;/.test(app), {});

check('U5 已存 fast 的项目打开弹窗时 picked 回落 full（避免不可点却选中）',
  /if \(TEAM_MODES\[picked\] && TEAM_MODES\[picked\]\.unavailable\) picked = 'full';/.test(app), {});

check('U6 完整 6 人（full）未受影响：无 unavailable 字段、选中/可点逻辑不变',
  !/full:\s*\{[\s\S]{0,400}?unavailable:/.test(app) && /aria-pressed="\$\{picked === def\.id && !off \? 'true' : 'false'\}"/.test(app), {});

check('U7 CSS：.team-mode-card.is-unavailable 有 opacity + cursor:not-allowed，hover 不再高亮',
  /\.team-mode-card\.is-unavailable\s*\{[^}]*opacity:\s*\.62[^}]*cursor:\s*not-allowed/.test(css)
  && /\.team-mode-card\.is-unavailable:hover\s*\{[^}]*border-color:\s*var\(--line\)/.test(css), {});

fs.mkdirSync(EVID, { recursive: true });
const report = {
  ownerRequest: '快速 4 人团队：显示但不可点 + 标识【暂不可用，工作台三期工程】', at: new Date().toISOString(),
  total: passed + failures.length, pass: passed, red: failures.length, failures,
  files: { app: path.relative(ROOT, APP).replace(/\\/g, '/'), css: path.relative(ROOT, CSS).replace(/\\/g, '/') },
};
const outFile = path.join(EVID, 'run-fastmode.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`\nFAST_MODE_UNAVAILABLE ${failures.length === 0 ? 'OK' : 'FAIL'} ${JSON.stringify({ total: report.total, pass: report.pass, red: report.red })}`);
console.log('证据：' + outFile);
process.exit(failures.length ? 1 : 0);
