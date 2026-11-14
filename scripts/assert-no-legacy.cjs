#!/usr/bin/env node
'use strict';

// R-81a5 / 弹窗 v14 静态断言：
//   1) Owner 通道不得回退旧名：src/** 与 scripts/** 中通道字段同行不得再出现旧通道名；
//   2) 5 个 legacy 旧入口 id 必须 0 命中（stage / quick / owner / open / flow 五种组合）。
// 由 npm run check 调用；失败立即 exit 1，防止人手改动把回退/死代码加回来。
// 本文件自身也在扫描范围内：因此断言模式用片段拼接，不写完整旧 id 字面，保证全仓 grep 为 0。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = [path.join(ROOT, 'src'), path.join(ROOT, 'scripts')];
const SELF = path.resolve(__filename);
const EXT = new Set(['.js', '.cjs', '.mjs', '.html', '.css', '.json']);
const CHANNEL_RE = new RegExp('chan' + 'nel[^\\n]*' + 'work' + 'bench', 'i');
// 旧 id 只存片段（不带 #），运行时拼前缀；btn-owner 片段是另外两个片段的前缀，必须用边界排除。
const LEGACY_FRAGMENTS = ['stage-owner', 'btn-owner-quick', 'btn-owner-open', 'btn-flow-owner', 'btn-owner'];
const LEGACY_ID_RE = new RegExp('#(?:' + LEGACY_FRAGMENTS.join('|') + ')(?![\\w-])');

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (EXT.has(path.extname(ent.name).toLowerCase())) out.push(full);
  }
}

const files = [];
for (const dir of SCAN_DIRS) if (fs.existsSync(dir)) walk(dir, files);

const hits = [];
let scanned = 0;
for (const file of files) {
  if (path.resolve(file) === SELF) continue;
  scanned += 1;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (CHANNEL_RE.test(line)) {
      hits.push(`${path.relative(ROOT, file)}:${index + 1} 通道仍引用旧名：${line.trim()}`);
    }
    const legacy = line.match(LEGACY_ID_RE);
    if (legacy) {
      hits.push(`${path.relative(ROOT, file)}:${index + 1} 旧 id 残留 ${legacy[0]}：${line.trim()}`);
    }
  });
}

if (hits.length) {
  console.error('ASSERT_NO_LEGACY FAIL');
  for (const hit of hits) console.error('  ' + hit);
  process.exit(1);
}
console.log(`ASSERT_NO_LEGACY OK：${scanned} 文件，通道旧名 0 命中，5 个旧 id 0 命中`);
