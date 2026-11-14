'use strict';
/**
 * B-a6f9：清理用户可见的「轮次」文案（内部字段 round/iterationRound 保留）。
 * 口径：只改中文字符串里的“每轮/本轮/第 N 轮/轮次/下一轮/跨轮”，不动英文标识符与代码逻辑。
 * 用法：node scripts/clean-rounds.cjs [--apply]
 * 不带 --apply 只打印将发生的替换与剩余命中（干跑）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  'src/renderer/app.js',
  'src/renderer/owner-review.js',
  'src/renderer/flow-v4.js',
  'src/renderer/flow-graph.js',
  '团队/工具/lib/ops.mjs',
  '团队/工具/lib/board.mjs',
  '团队/工具/lib/session.mjs',
  '团队/工具/lib/scaffold.mjs',
];

// 术语映射（按长串优先，避免“第 N 轮”替换后残留）
const MAP = [
  [/第 \$\{[^}]+\} 轮/g, '当前'],
  [/第 \d+ 轮/g, '当前'],
  [/本轮/g, '当前'],
  [/每轮/g, '每次'],
  [/下一轮/g, '下一次'],
  [/上一轮/g, '上一次'],
  [/跨轮/g, '跨版本'],
  [/轮次/g, '阶段'],
  [/三轮/g, '三步'],
  [/这轮/g, '这次'],
  [/首轮/g, '首次'],
  [/往轮/g, '历史'],
  [/同轮/g, '同批'],
  [/整轮/g, '整体'],
  [/轮询/g, '轮询'], // 轮询是 polling，不是迭代轮次：保留（占位，明确不改）
];
const KEEP = ['轮换', '轮询', '轮转'];

function isComment(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('<!--');
}

const apply = process.argv.includes('--apply');
let totalChanges = 0;
const remaining = [];

for (const rel of TARGETS) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  let changed = 0;
  const outLines = lines.map((line) => {
    if (isComment(line)) return line;
    let next = line;
    for (const [re, rep] of MAP) next = next.replace(re, rep);
    // 保护词：替换后若把 轮换/轮询 弄坏，回滚不了——直接跳过含保护词的整行（保守）
    if (KEEP.some((k) => line.includes(k))) return line;
    if (next !== line) { changed += 1; totalChanges += 1; }
    return next;
  });
  const out = outLines.join('\n');
  if (apply && changed) fs.writeFileSync(file, out, 'utf8');
  // 剩余用户可见命中（非注释、含“轮”、且不是保护词）
  outLines.forEach((line, i) => {
    if (isComment(line)) return;
    if (!line.includes('轮')) return;
    if (KEEP.some((k) => line.includes(k))) return;
    remaining.push({ file: rel, line: i + 1, text: line.trim().slice(0, 120) });
  });
  console.log(`${rel}: ${changed} 行${apply ? '已改' : '将改'}`);
}
console.log(`\n总计${apply ? '已改' : '将改'} ${totalChanges} 行；剩余用户可见“轮”命中 ${remaining.length} 行`);
remaining.slice(0, 40).forEach((r) => console.log(`  ${r.file}:${r.line}  ${r.text}`));
if (!apply) console.log('\n（干跑。加 --apply 真正写入。）');
