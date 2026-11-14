'use strict';
/** B-a6f9 第二轮：清剩余 18 处用户可见「轮」文案（内部字段不动）。 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const EDITS = {
  'src/renderer/app.js': [
    ['第一轮对话', '首条对话'],
    ['；迭代会让当前 boot 全部作废、在办需求留在旧轮。', '；迭代会让当前 boot 全部作废、在办需求留在旧状态。'],
    [' · 当前轮</h3>', ' · 当前需求</h3>'],
    ["stepTemplate: '第 {n} 轮 / 共 {total} 轮'", "stepTemplate: '第 {n} 步 / 共 {total} 步'"],
    ['把 queued 的 Owner 新需求释放到当前轮', '把 queued 的 Owner 新需求释放为当前需求'],
    ["'当前 · 第 ' + evidence.round + ' 轮'", "'当前 · 需求'"],
    ["'已迭代 · 第 ' + evidence.round + ' 轮'", "'已迭代收口'"],
    ['新一轮从「迭代（下一次）」开始', '新需求从「迭代（收口后）」开始'],
    ['这轮跳过（按推荐）', '本次跳过（按推荐）'],
  ],
  'src/renderer/flow-v4.js': [
    ["'<div class=\"fv4-head\"><b>当前：第 ' + esc(data.round || 1) + ' 轮</b>'", "'<div class=\"fv4-head\"><b>当前需求</b>'"],
    ["('第 ' + g.round + ' 轮 · ' + g.items.length + ' 条')", "('当前需求 · ' + g.items.length + ' 条')"],
    ["('历史（第 ' + g.round + ' 轮）· ' + g.items.length + ' 条')", "('历史收口 · ' + g.items.length + ' 条')"],
  ],
  '团队/工具/lib/session.mjs': [
    ['${r.turns.length} 轮', '${r.turns.length} 段'],
  ],
  '团队/工具/lib/scaffold.mjs': [
    ['等这一轮收工再发', '等这次收工再发'],
    ['不触发新一轮', '不触发新流程'],
  ],
};
let changed = 0;
for (const [rel, pairs] of Object.entries(EDITS)) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  let s = fs.readFileSync(file, 'utf8');
  for (const [from, to] of pairs) {
    if (s.includes(from)) { s = s.split(from).join(to); changed += 1; }
    else console.log(`未命中（跳过）：${rel} :: ${from.slice(0, 40)}`);
  }
  fs.writeFileSync(file, s, 'utf8');
}
console.log(`第二轮替换完成：${changed} 处`);
