#!/usr/bin/env node
'use strict';
/**
 * test-renderer-load.cjs —— 渲染层「脚本加载冒烟」（B-20261116-101950-212b）
 *
 * 背景（P0）：b6d855a 让 app.js 与 theme-manifest.js 各自在顶层声明 `const THEME_ORDER`，
 * theme-manifest.js 与 review-list-core.js 各自声明 `const api` —— 浏览器里多脚本共用同一个
 * 全局词法作用域，后加载的那份整份 SyntaxError，主界面直接不执行约 7 分钟。
 *
 * 断言覆盖缺陷单的四条 AC：
 *  · AC1 扫描 src/renderer 全部脚本的顶层 const/let/class/**function** 声明，命中重复名字即失败，
 *        并打印「名字 ← 哪几个文件」（今天正是靠这个定位的，禁止改成只说有几个冲突）；
 *  · AC2 可在 `npm run check`（一键入口）里跑，失败 exit=1；
 *  · AC3 按 index.html 的**文档顺序**模拟声明合并（不是全局去重），并用「按顺序拼接后整体编译」
 *        复现浏览器真实行为；
 *  · AC4 用本次真实撞名（THEME_ORDER / api）当夹具，断言检查器能把它们抓出来（S6）。
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
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 600)}`);
}

if (!fs.existsSync(INDEX)) { console.error('环境错误：找不到 src/renderer/index.html'); process.exit(2); }
// 先剥掉 HTML 注释：注释里出现 script 标签字样时 naive 切分会切错（本次踩过一次）
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

/** 取脚本源码（外部文件读盘，内联直接用） */
function codeOf(s) {
  if (s.kind === 'inline') return s.code;
  const full = path.join(RENDERER, s.file);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
}
const labelOf = (s) => (s.kind === 'inline' ? '(inline)' : s.file);

/**
 * 顶层重复声明检测（AC1 + AC4 共用同一个函数，避免检查器与被检查对象各写一套）
 * @param {{label:string, code:string}[]} files
 * @returns {{lexical:{name:string, files:string[]}[], funcs:{name:string, files:string[]}[]}}
 */
function detectTopLevelDuplicates(files) {
  const lexical = new Map();
  const funcs = new Map();
  for (const f of files) {
    const code = f.code || '';
    const reLex = /^(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
    let d;
    while ((d = reLex.exec(code)) !== null) {
      const name = d[1];
      if (!lexical.has(name)) lexical.set(name, []);
      if (!lexical.get(name).includes(f.label)) lexical.get(name).push(f.label);
    }
    const reFn = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
    while ((d = reFn.exec(code)) !== null) {
      const name = d[1];
      if (!funcs.has(name)) funcs.set(name, []);
      if (!funcs.get(name).includes(f.label)) funcs.get(name).push(f.label);
    }
  }
  const pick = (map) => [...map.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([name, list]) => ({ name, files: list }));
  return { lexical: pick(lexical), funcs: pick(funcs) };
}

/** 人话清单：「名字 ← a.js , b.js」（PM 明确要求保留这一行） */
const explain = (rows) => rows.map((r) => `${r.name} ← ${r.files.join(' , ')}`);

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
    perFileErrors.push({ file: s.file, message: String((error && error.message) || error) });
  }
}
check('S3 每个外部脚本单独可编译（等价 node --check）', perFileErrors.length === 0, perFileErrors);

// AC1 + AC3：按文档顺序模拟合并，扫顶层 const/let/class/function 撞名
const scanned = scripts.map((s) => ({ label: labelOf(s), code: codeOf(s) }));
const dups = detectTopLevelDuplicates(scanned);
check('S4 顶层 const/let/class 跨脚本无撞名（SyntaxError 级，名字 ← 文件清单见 detail）',
  dups.lexical.length === 0, explain(dups.lexical));
check('S4b 顶层 function 声明跨脚本无重名（覆盖不报错但会互相覆盖，同样禁）',
  dups.funcs.length === 0, explain(dups.funcs));

// AC4：用本次真实撞名当夹具，断言检查器真能抓到（防止检查器本身写成空转）
const fixture = [
  { label: 'fixture-app.js', code: 'const THEME_ORDER = [];\nconst api = {};\nfunction shared() {}\n' },
  { label: 'fixture-manifest.js', code: 'const THEME_ORDER = [];\nfunction shared() {}\n' },
  { label: 'fixture-review-list-core.js', code: 'const api = {};\n' },
];
const fixtureDups = detectTopLevelDuplicates(fixture);
const fixtureLexNames = fixtureDups.lexical.map((r) => r.name).sort().join(',');
const fixtureFnNames = fixtureDups.funcs.map((r) => r.name).sort().join(',');
check('S6 夹具能抓到本次真实撞名（THEME_ORDER / api 列清单，名字 ← 文件）',
  fixtureLexNames === 'THEME_ORDER,api'
  && fixtureDups.lexical.every((r) => r.files.length === 2)
  && fixtureFnNames === 'shared',
  { lexical: explain(fixtureDups.lexical), funcs: explain(fixtureDups.funcs) });

// 合并编译：真实复现浏览器「共享全局词法作用域」
const combined = scripts.map((s) => `\n// ---- ${labelOf(s)} ----\n${codeOf(s)}\n`).join('\n');
let combinedError = null;
let culprit = null;
try {
  new vm.Script(combined, { filename: '<renderer-load-order>' });
} catch (error) {
  combinedError = String((error && error.message) || error);
  let acc = '';
  for (const s of scripts) {
    acc += `\n// ---- ${labelOf(s)} ----\n${codeOf(s)}\n`;
    try {
      new vm.Script(acc, { filename: '<renderer-load-order>' });
    } catch (e2) {
      culprit = { file: labelOf(s), message: String((e2 && e2.message) || e2) };
      break;
    }
  }
}
check('S5 全部脚本按加载顺序合并后仍可编译（无「已声明」类 SyntaxError）', combinedError === null, { combinedError, culprit });

console.log(`\n脚本加载冒烟：${passed}/${passed + failures.length} PASS（脚本 ${scripts.length} 个，其中外部 ${extFiles.length} 个）`);
if (failures.length) {
  console.error('撞名清单（名字 ← 文件）：');
  for (const f of failures) if (f.detail) console.error(`  ${JSON.stringify(f.detail)}`);
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}
process.exit(0);
