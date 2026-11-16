#!/usr/bin/env node
'use strict';
/**
 * test-renderer-load.cjs —— 渲染层「脚本加载冒烟」（PM 2026-11-16 10:19 两条硬规矩之一）
 *
 * 背景（P0）：b6d855a 让 app.js 与 theme-manifest.js 各自在顶层声明 `const THEME_ORDER`，
 * theme-manifest.js 与 review-list-core.js 各自声明 `const api` —— 浏览器里多脚本共用同一个
 * 全局词法作用域，后加载的那份整份 SyntaxError，主界面直接不执行。
 *
 * 这个脚本做的事：
 *  1) 按 index.html 的**文档顺序**取出全部对外脚本 + 内联脚本；
 *  2) 每个文件单独编译（等价 node --check），任何一个语法错都报；
 *  3) **把全部脚本按加载顺序拼成一份再编译** —— 顶层 `const/let/class` 撞名会在这里抛
 *     "Identifier 'X' has already been declared"，等于复现那次 P0；
 *  4) 冲突时额外打印「哪个名字、哪几个文件各自声明」的清单，便于定位。
 *
 * 只编译不执行（不需要 DOM），可安全在 CI/本地跑。
 * 运行：node scripts/test-renderer-load.cjs   退出码 0=全过
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const INDEX = path.join(RENDERER, 'index.html');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 400)}`);
}

if (!fs.existsSync(INDEX)) { console.error('环境错误：找不到 src/renderer/index.html'); process.exit(2); }
// 先剥掉 HTML 注释：注释里出现 <script> 字样时 naive 切分会切错（本次踩过一次）
const html = fs.readFileSync(INDEX, 'utf8').replace(/<!--[\s\S]*?-->/g, '');

/** 按文档顺序取出脚本：{kind:'src'|'inline', file?|code} */
const scripts = [];
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m;
while ((m = re.exec(html)) !== null) {
  const attrs = m[1] || '';
  const body = m[2] || '';
  const srcMatch = /\bsrc\s*=\s*"([^"]+)"/i.exec(attrs);
  if (srcMatch) scripts.push({ kind: 'src', file: srcMatch[1] });
  else if (body.trim()) scripts.push({ kind: 'inline', code: body });
}

check('S1 index.html 里至少解析出 5 个脚本（解析器没空转）', scripts.length >= 5, { count: scripts.length });

// 逐个文件存在性 + 单独编译
const extFiles = scripts.filter((s) => s.kind === 'src').map((s) => s.file);
const missing = extFiles.filter((f) => !fs.existsSync(path.join(RENDERER, f)));
check('S2 外部脚本文件都存在', missing.length === 0, missing);

const perFileErrors = [];
for (const s of scripts) {
  if (s.kind !== 'src') continue;
  const full = path.join(RENDERER, s.file);
  if (!fs.existsSync(full)) continue;
  try {
    new vm.Script(fs.readFileSync(full, 'utf8'), { filename: s.file });
  } catch (error) {
    perFileErrors.push({ file: s.file, message: String(error && error.message || error) });
  }
}
check('S3 每个外部脚本单独可编译（等价 node --check）', perFileErrors.length === 0, perFileErrors);

// 顶层声明撞名清单（先做静态统计，失败时给人话定位）
const DECL_RE = /^(?:const|let|class)\s+([A-Za-z_$][\w$]*)|^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
const owners = new Map(); // name -> [file...]
function collect(label, code) {
  let d;
  DECL_RE.lastIndex = 0;
  while ((d = DECL_RE.exec(code)) !== null) {
    const name = d[1] || d[2];
    // 只统计顶层（行首无缩进）声明：正则已锚定行首
    if (!owners.has(name)) owners.set(name, []);
    const list = owners.get(name);
    if (!list.includes(label)) list.push(label);
  }
}
for (const s of scripts) {
  if (s.kind === 'src') {
    const full = path.join(RENDERER, s.file);
    if (fs.existsSync(full)) collect(s.file, fs.readFileSync(full, 'utf8'));
  } else {
    collect('(inline)', s.code);
  }
}
// const/let 撞名才是 SyntaxError；function 同名只是覆盖（浏览器允许），单列不判红
const lexicalNames = new Set();
for (const s of scripts) {
  const code = s.kind === 'src'
    ? (fs.existsSync(path.join(RENDERER, s.file)) ? fs.readFileSync(path.join(RENDERER, s.file), 'utf8') : '')
    : s.code;
  const label = s.kind === 'src' ? s.file : '(inline)';
  const reLex = /^(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
  let d;
  while ((d = reLex.exec(code)) !== null) lexicalNames.add(`${d[1]}\u0000${label}`);
}
const lexicalOwners = new Map();
for (const key of lexicalNames) {
  const [name, label] = key.split('\u0000');
  if (!lexicalOwners.has(name)) lexicalOwners.set(name, []);
  lexicalOwners.get(name).push(label);
}
const lexicalConflicts = [...lexicalOwners.entries()].filter(([, files]) => files.length > 1);
check('S4 顶层 const/let/class 无跨脚本撞名（P0 复现点）', lexicalConflicts.length === 0,
  lexicalConflicts.map(([name, files]) => `${name} ← ${files.join(' , ')}`));

// 合并编译：真实复现浏览器「共享全局词法作用域」
const combined = scripts.map((s) => {
  if (s.kind === 'inline') return `\n// ---- inline ----\n${s.code}\n`;
  const full = path.join(RENDERER, s.file);
  const code = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
  return `\n// ---- ${s.file} ----\n${code}\n`;
}).join('\n');

let combinedError = null;
let culprit = null;
try {
  new vm.Script(combined, { filename: '<renderer-load-order>' });
} catch (error) {
  combinedError = String(error && error.message || error);
  // 逐个累加，定位「加到哪一个脚本时才编译不过」（给实现者人话）
  let acc = '';
  for (const s of scripts) {
    const label = s.kind === 'src' ? s.file : '(inline)';
    const code = s.kind === 'src'
      ? (fs.existsSync(path.join(RENDERER, s.file)) ? fs.readFileSync(path.join(RENDERER, s.file), 'utf8') : '')
      : s.code;
    acc += `\n// ---- ${label} ----\n${code}\n`;
    try {
      new vm.Script(acc, { filename: '<renderer-load-order>' });
    } catch (e2) {
      culprit = { file: label, message: String(e2 && e2.message || e2) };
      break;
    }
  }
}
check('S5 全部脚本按加载顺序合并后仍可编译（无「已声明」类 SyntaxError）', combinedError === null, { combinedError, culprit });

console.log(`\n脚本加载冒烟：${passed}/${passed + failures.length} PASS（脚本 ${scripts.length} 个，其中外部 ${extFiles.length} 个）`);
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
process.exit(0);
