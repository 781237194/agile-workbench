#!/usr/bin/env node
'use strict';
/**
 * test-a64f-compact-list.cjs —— R-a64f（T-20261118-095703-d08e）回归夹具
 *
 * 需求：Owner 评审左栏精简成「短号 + 需求名 + 徽标」单行（行高 ≤44px、名称 ellipsis），
 *      顶部搜索按编号/需求名/正文关键词实时过滤（去抖 ≤300ms）、计数「N 条」、空态可读，
 *      组头计数随筛选变化、0 条组头隐藏；既有锚点/属性一个不能少。
 *
 * 断言：
 *   A 行模板不再渲染长文本节点（or-all-k / or-all-v / or-all-meta 在渲染代码里 0 命中）
 *   B 行高 CSS ≤44px、名称单元格 ellipsis、列表滚动容器 ≥620px
 *   C 搜索纯逻辑（从源码 A64F-SEARCH 段抽取执行）：短号 4 位、按编号/名称/关键词匹配、空查询全通过
 *   D 搜索接线：去抖常量 ≤300ms、[data-or-search]/[data-or-count]/[data-or-empty]、组头计数与隐藏
 *   E 既有契约锚点/属性仍在（data-owner-all / data-owner-all-item / data-or-req / data-or-bucket /
 *     data-or-expanded / data-what/blocked/advice/how/impact / data-or-status / data-or-stale / 5 枚筛选 chip）
 *   F 徽标仍设置 data-or-status-badge / data-or-source-badge，且挂在 head 行内
 *
 * 跑法：node scripts/test-a64f-compact-list.cjs        （AWB_A64F_OUT 指定 run.json）
 * 说明：渲染层依赖 DOM，本夹具走「源码静态 + 抽取纯逻辑执行」；真窗口由 --review-check 与截图复核。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const JS_FILE = path.join(ROOT, 'src', 'renderer', 'owner-review.js');
const CSS_FILE = path.join(ROOT, 'src', 'renderer', 'style.css');
const src = fs.readFileSync(JS_FILE, 'utf8');
const css = fs.readFileSync(CSS_FILE, 'utf8');
let pass = 0;
const results = [];
function ok(name, cond, detail) {
  results.push({ name, ok: Boolean(cond), detail: cond ? '' : String(JSON.stringify(detail || {})).slice(0, 300) });
  if (cond) { pass += 1; console.log('PASS  ' + name); return; }
  console.log('FAIL  ' + name + '  ' + JSON.stringify(detail || {}).slice(0, 300)); process.exitCode = 1;
}
const rowSrc = (() => {
  const i = src.indexOf('function renderAllRow(req)');
  const j = src.indexOf('function maybeAutoOpen(', i);
  return i >= 0 && j > i ? src.slice(i, j) : '';
})();

// ── A 行模板精简
ok('A1 renderAllRow 不再渲染 or-all-k / or-all-v 长文本节点',
  rowSrc.length > 0 && !rowSrc.includes('or-all-k') && !rowSrc.includes('or-all-v'), { has: rowSrc.includes('or-all-k') });
ok('A2 renderAllRow 不再创建独立 .or-all-meta 行', !rowSrc.includes("'or-all-meta'") && !rowSrc.includes('data-or-meta'), {});

// ── B CSS 尺寸
ok('B1 行固定单行且折叠态行高 ≤44px', /\.or-all-row\[data-or-expanded="0"\]\s*\{[^}]*max-height:\s*44px/.test(css), {});
ok('B2 head 单行高度 40px（≤44）且不换行', /\.or-all-head\s*\{[^}]*display:\s*flex[^}]*height:\s*40px/.test(css), {});
ok('B3 需求名单行省略（nowrap + ellipsis）', /\.or-all-name\s*\{[^}]*text-overflow:\s*ellipsis/.test(css) && /\.or-all-name\s*\{[^}]*white-space:\s*nowrap/.test(css), {});
ok('B4 列表滚动容器 ≥620px', /\.or-list\s*\{[^}]*min-height:\s*620px/.test(css), {});

// ── C 搜索纯逻辑（源码段抽取执行）
const seg = (() => {
  const i = src.indexOf('/* A64F-SEARCH-BEGIN */');
  const j = src.indexOf('/* A64F-SEARCH-END */');
  return i >= 0 && j > i ? src.slice(i + '/* A64F-SEARCH-BEGIN */'.length, j) : '';
})();
let api = null;
try {
  api = new Function(`${seg}; return { orShortId, orSearchMatches, orSearchTextOf };`)();
} catch (e) { api = null; }
ok('C1 A64F 搜索纯逻辑段可抽取执行', Boolean(api), {});
if (api) {
  ok('C2 短号取 id 尾段后 4 位小写', api.orShortId('R-20261118-083908-a64f') === 'a64f' && api.orShortId('R-1') === '1', {
    a: api.orShortId('R-20261118-083908-a64f'), b: api.orShortId('R-1'),
  });
  const text = api.orSearchTextOf(['R-20261118-083908-a64f', 'a64f', '我的评审左栏精简 + 搜索', '正文关键词：紧凑列表']);
  ok('C3 按编号/短号/需求名/正文关键词命中', api.orSearchMatches(text, '083908') && api.orSearchMatches(text, 'a64f')
    && api.orSearchMatches(text, '左栏精简') && api.orSearchMatches(text, '紧凑列表'), {});
  ok('C4 不匹配返回 false；空查询全部通过；大小写不敏感', api.orSearchMatches(text, '不存在的词') === false
    && api.orSearchMatches(text, '') === true && api.orSearchMatches(text, '   ') === true
    && api.orSearchMatches('ABC 全大写', 'abc') === true, {});
}

// ── D 搜索接线
ok('D1 去抖常量 ≤300ms 且 input 事件走 setTimeout',
  /const SEARCH_DEBOUNCE_MS = (\d+);/.test(src) && Number(RegExp.$1) <= 300 && /addEventListener\('input', orOnSearchInput\)/.test(src), {});
ok('D2 搜索框/计数/空态锚点齐全（[data-or-search] / [data-or-count] / [data-or-empty]）',
  src.includes("setAttribute('data-or-search', '1')") && src.includes("setAttribute('data-or-count', '1')")
  && src.includes("setAttribute('data-or-empty', '1')"), {});
ok('D3 计数文案「N 条」+ 空态可读文案', /`\$\{total\} 条`/.test(src) && /没有匹配的需求/.test(src), {});
ok('D4 组头计数随筛选变化、0 条组头隐藏（data-or-group-title/label + group.hidden）',
  src.includes("setAttribute('data-or-group-title', '1')") && src.includes("setAttribute('data-or-group-label', String(group.label))")
  && /group\.hidden = Boolean\(q\) && shown === 0;/.test(src), {});
ok('D5 行上带搜索文本（编号+短号+需求名+正文摘要+三要素）', src.includes("setAttribute('data-or-search-text'"), {});
ok('D6 搜索条跨重绘复用（只建一次，输入框不失焦）', /let orSearchEls = null;/.test(src) && /if \(orSearchEls\) return orSearchEls;/.test(src), {});

// ── E 既有契约
const contracts = [
  ['data-owner-all', "setAttribute('data-owner-all', '1')"],
  ['data-owner-all-item', "setAttribute('data-owner-all-item', '1')"],
  ['data-or-req', "setAttribute('data-or-req', id)"],
  ['data-or-bucket', "setAttribute('data-or-bucket', listBucketOf(req))"],
  ['data-or-expanded', "setAttribute('data-or-expanded', open ? '1' : '0')"],
  ['data-what', "setAttribute('data-what', what)"],
  ['data-blocked', "setAttribute('data-blocked', blocked)"],
  ['data-advice', "setAttribute('data-advice', adviseFull)"],
  ['data-how', "setAttribute('data-how', clip60(acBoard.how, 200))"],
  ['data-impact', "setAttribute('data-impact', clip60(acBoard.impact, 120))"],
  ['data-or-status', "setAttribute('data-or-status', String(req.status || ''))"],
  ['data-or-stale', "setAttribute('data-or-stale', '1')"],
  ['selectRequirement 点行打开', 'selectRequirement(id)'],
];
const missing = contracts.filter(([name, needle]) => !src.includes(needle)).map(([name]) => name);
ok('E1 既有行锚点/属性全部保留', missing.length === 0, { missing });
ok('E2 5 枚筛选 chip 定义仍在（全部 + 四档）',
  /const filterDefs = \[\{ key: 'all', label: '全部' \}, \.\.\.LIST_FILTERS\.filter\(Boolean\)\];/.test(src)
  && /setAttribute\('data-owner-all-filter', def\.key\)/.test(src), {});
ok('E3 展开详情 data-owner-all-detail 未被误删', src.includes("setAttribute('data-owner-all-detail', '1')"), {});

// ── G 短号 / 需求名取数
ok('G1 行内名称走 humanizeTitle 且带 title（完整名）',
  rowSrc.includes('const rowName = humanizeTitle(req.title);')
  && rowSrc.includes('class="or-all-name" data-or-name="1" title="${esc(rowName)}"'), {});
ok('G2 短号带完整 id 的 title', rowSrc.includes('class="or-all-id" data-or-short-id="1" title="${esc(id)}"'), {});

// ── F 徽标
ok('F1 徽标仍设置 data-or-status-badge / data-or-source-badge',
  src.includes("setAttribute('data-or-status-badge', '1')") && src.includes("setAttribute('data-or-source-badge', '1')"), {});
ok('F2 徽标并入 head 行（renderAllRow 内 headRow.appendChild(statusBadgeEl)）',
  /headRow\.appendChild\(statusBadgeEl\(req\)\)/.test(rowSrc) && /headRow\.appendChild\(sourceBadgeEl\(req\)\)/.test(rowSrc), {});

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const report = {
  task: 'T-20261118-095703-d08e', requirement: 'R-20261118-083908-a64f',
  at: new Date().toISOString(), total: results.length, pass, red: results.length - pass,
  files: { ownerReview: { bytes: fs.statSync(JS_FILE).size, sha256: sha(JS_FILE) }, style: { bytes: fs.statSync(CSS_FILE).size, sha256: sha(CSS_FILE) } },
  results,
};
const outEnv = process.env.AWB_A64F_OUT || path.join('_tmp', 'run-a64f.json');
const outFile = path.isAbsolute(outEnv) ? outEnv : path.join(ROOT, outEnv);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`\nA64F_COMPACT_LIST ${JSON.stringify({ total: report.total, pass: report.pass, red: report.red })}`);
console.log('证据：' + outFile);
process.exit(report.red ? 1 : 0);
