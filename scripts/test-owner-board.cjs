#!/usr/bin/env node
// B-4baa（R-1cee）静态断言：PM通过/打回标识、来源未记、本轮看板三要素、折叠与全文、双模式评审人。
// 用法：node scripts/test-owner-board.cjs [--json]
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const review = fs.readFileSync(path.join(ROOT, 'src/renderer/owner-review.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src/renderer/style.css'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
const ops = fs.readFileSync(path.join(ROOT, '团队/工具/lib/ops.mjs'), 'utf8');
const team = fs.readFileSync(path.join(ROOT, '团队/工具/team.mjs'), 'utf8');

const checks = [];
const push = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || '' });
const has = (src, text) => src.includes(text);

// ── 一、来源标识（F-R1）────────────────────────────────────
push('标签有【PM通过】', has(review, '【PM通过】'));
push('标签有【PM打回】', has(review, '【PM打回】'));
push('标签有【PM跳过】', has(review, '【PM跳过】'));
push('不再返回【PM评审通过】', !has(review, '【PM评审通过】') && !has(review, '【PM评审打回】'));
push('来源判定用 channel/recordedBy', has(review, "channel === 'proxy' || recordedBy === 'pm'"));
push('不用 decidedBy 判定来源', !/decidedBy/.test(review.slice(review.indexOf('function proxyTagOf'), review.indexOf('function updateBadge'))));
push('旧数据标「来源未记」', has(review, '（来源未记）') && has(review, '【已通过${suffix}】'));
push('Owner 本人标【已通过】/【已打回】', has(review, '【已通过${suffix}】') && has(review, '【已打回${suffix}】'));
push('代管依据可展开', has(review, 'data-or-basis') && has(review, '代管依据'));

// ── 二、本轮看板（F-R2）───────────────────────────────────
push('看板带轮次 data-owner-board-round', has(review, 'data-owner-board-round'));
push('每条有 是什么/怎么做/建议拍板 三要素', has(review, "setAttribute('data-what'") && has(review, "setAttribute('data-how'") && has(review, "setAttribute('data-advice'"));
push('三要素写进可见文本', has(review, '是什么：') && has(review, '怎么做：') && has(review, '建议拍板：'));
push('建议拍板有兜底文案', has(review, '无特别建议，按通过 / 打回即可'));
push('列表摘要 data-or-summary 且 ≤60 字', has(review, 'data-or-summary') && has(review, 'clip60(`${what}；${how}`)'));
push('摘要容器改名避免与列表摘要冲突', has(review, 'data-or-summary-box') && has(review, "querySelector('[data-or-summary-box]')"));
push('详情全文 data-or-detail 不裁切', has(review, 'data-or-detail') && has(review, '详情全文') && has(review, 'fullDetail'));

// ── 三、下拉/折叠（F-R3）──────────────────────────────────
push('默认展示前 5 条', has(review, 'const PREVIEW_ROWS = 5;'));
push('看板展开按钮 data-or-board-more', has(review, 'data-or-board-more'));
push('待评估展开按钮 data-or-eval-more', has(review, 'data-or-eval-more'));
push('折叠用 hidden 保留 DOM', has(review, 'item.hidden = true') && has(review, 'state.boardExpanded') && has(review, 'state.evalExpanded'));
push('展开后切回“收起”', has(review, "'收起'"));
push('CSS 有展开按钮样式', has(css, '.or-more {'));
push('CSS 未对 .or-item 设 line-clamp/ellipsis', !/\.or-item[^{]*\{[^}]*(line-clamp|text-overflow)/.test(css));

// ── 四、双模式评审人（F-R5）──────────────────────────────
push('评审人 data-or-reviewer', has(review, 'data-or-reviewer'));
push('fast 显示分析师、full 显示产品', has(review, "'analyst' : 'product'") && has(review, '评审人：分析师') && has(review, '评审人：产品'));
push('main 的 owner:review-data 返回 teamMode', has(mainSrc, 'teamMode: normalizeTeamMode(project.teamMode)'));
push('CSS 有评审人样式', has(css, '.or-reviewer {'));

// ── 五、看板/工具口径同步 ────────────────────────────────
push('ops.mjs 标签同步新文案', has(ops, '【PM通过】') && has(ops, '【PM打回】') && has(ops, '（来源未记）'));
push('team.mjs 帮助文本同步新文案', has(team, '【PM通过】') && !has(team, '【PM评审通过】'));

const failed = checks.filter((c) => !c.ok);
const report = { checks: checks.length, failed: failed.length, failures: failed, ok: failed.length === 0 };
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  for (const c of checks) console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.name + (c.detail ? ' · ' + c.detail : ''));
  console.log(report.ok ? 'OWNER_BOARD_OK' : 'OWNER_BOARD_FAIL');
}
process.exitCode = report.ok ? 0 : 1;
