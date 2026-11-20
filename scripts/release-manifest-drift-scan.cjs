#!/usr/bin/env node
'use strict';
/**
 * release-manifest-drift-scan.cjs —— R-20261120-183412-5099（发版四渠道同源）版本/清单漂移扫描 · 正式版
 *
 * 为什么要有它：版本号、插件版本映射、install.ps1 的 $relatives 白名单、升级包清单原先分散在多处手写，
 * 自检只比较「关键字是否存在」，无法发现「多出一份第二定义/漏改一处字面量」。本脚本把整套口径做成
 * 可运行基线：扫描 5 组模式 → 输出 JSON → 与基线比对，只有「基线内」的命中才允许存在。
 *
 * 唯一清单来源：`scripts/upgrade-package-manifest.cjs`（本脚本只**读取**，不复制第二份清单）。
 *
 * 5 组模式（每条注明抓什么漂移）：
 *   plugin-literal        抓 app↔plugin 版本字面量（2.2.x 等）；出现新字面量 = 版本双轨散落
 *   mapping-formula       抓 MINOR+1 这类映射算式；出现第二份 = 映射实现散落（单源违规）
 *   plugin-version-read   抓 pluginVersion 读取点；只允许读取，不允许据此重算映射
 *   relatives-copy        抓 install.ps1 的 $relatives 复制块与夹具读取；必须与清单逐项相等
 *   manifest-definition   抓 UPGRADE_TREE/UPGRADE_FILES/NEVER_PACKAGE 定义与 $relatives；新增定义来源即漂移
 *
 * 用法：
 *   node scripts/release-manifest-drift-scan.cjs --json
 *   node scripts/release-manifest-drift-scan.cjs --emit-baseline 发布/版本漂移基线.json
 *   node scripts/release-manifest-drift-scan.cjs --baseline 发布/版本漂移基线.json --json
 *   node scripts/release-manifest-drift-scan.cjs --baseline <file> --strict
 *   node scripts/release-manifest-drift-scan.cjs --root <repo> --pretty
 *
 * 退出码：0 = 与基线一致（或未给基线）；1 = 出现未登记命中 / strict 下基线条目消失；2 = 参数或基线读取错误。
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

const PATTERNS = [
  { id: 'plugin-literal', re: /2\.2\.\d+/, why: '抓 app↔plugin 版本字面量（2.2.13 这类）：版本双轨与安装链接文案漂移都在这里' },
  { id: 'mapping-formula', re: /MINOR\+1|minor\s*\+\s*1/, why: '抓版本映射算式（app.PATCH+1 → plugin.MINOR+1）：出现第二份即映射实现散落' },
  { id: 'plugin-version-read', re: /pluginVersion/, why: '抓 pluginVersion 读取点：只允许读取，不允许据此重算映射' },
  { id: 'relatives-copy', re: /\$relatives/, why: '抓 install.ps1 白名单复制块与其消费/夹具读取：必须与清单逐项相等' },
  { id: 'manifest-definition', re: /(UPGRADE_TREE|UPGRADE_FILES|NEVER_PACKAGE)/, why: '抓清单定义（UPGRADE_TREE/UPGRADE_FILES/NEVER_PACKAGE）：新增定义来源即漂移' },
];

// 扫描根与排除域（增补卷-5099-1 §6.8）：只扫代码/脚本/安装器/插件，不扫沙盘、证据、快照与项目数据。
const DEFAULT_ROOTS = ['install.ps1', 'scripts', 'src', 'dsh-plugin', '团队/工具/lib'];
const INCLUDE_EXT = ['.cjs', '.mjs', '.js', '.ps1', '.json', '.yml', '.md'];
const EXCLUDE_SEGMENTS = ['_tmp', '证据-', '代码快照-', 'sandbox', 'node_modules', '测试人员/产出', '团队/skill/归档', '项目/'];

function argOf(args, name, fallback = '') {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const argv = process.argv.slice(2);
const root = path.resolve(argOf(argv, '--root', REPO_ROOT));
const baselinePath = argOf(argv, '--baseline', '');
const emitPath = argOf(argv, '--emit-baseline', '');
const asJson = argv.includes('--json');
const pretty = argv.includes('--pretty');

function excluded(rel) {
  const p = rel.replace(/\\/g, '/');
  return EXCLUDE_SEGMENTS.some((s) => p === s || p.startsWith(s + '/') || p.includes('/' + s));
}
function walk(abs, out) {
  let st;
  try { st = fs.statSync(abs); } catch { return; }
  if (st.isFile()) { if (INCLUDE_EXT.includes(path.extname(abs))) out.push(abs); return; }
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (excluded(rel)) continue;
    walk(full, out);
  }
}

const files = [];
for (const relRoot of DEFAULT_ROOTS) walk(path.join(root, relRoot), files);

const hits = [];
for (const abs of files) {
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  if (excluded(rel)) continue;
  let text = '';
  try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  text.split(/\r?\n/).forEach((lineText, index) => {
    for (const pattern of PATTERNS) {
      if (pattern.re.test(lineText)) {
        hits.push({ file: rel, line: index + 1, pattern: pattern.id, text: lineText.trim().slice(0, 200) });
      }
    }
  });
}

const perPattern = {};
for (const pattern of PATTERNS) perPattern[pattern.id] = hits.filter((h) => h.pattern === pattern.id).length;
const report = {
  at: new Date().toISOString(),
  root,
  roots: DEFAULT_ROOTS,
  include: INCLUDE_EXT,
  exclude: EXCLUDE_SEGMENTS,
  patterns: PATTERNS.map((p) => ({ id: p.id, re: String(p.re), why: p.why })),
  counts: {
    byLine: hits.length,
    byFile: new Set(hits.map((h) => h.file)).size,
    byDedup: new Set(hits.map((h) => h.file + ':' + h.line)).size,
    perPattern,
  },
  hits,
};
const keyOf = (h) => h.file + ':' + h.line + ':' + h.pattern;

if (emitPath) {
  const target = path.resolve(emitPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', 'utf8');
}

if (!baselinePath) {
  if (asJson) console.log(JSON.stringify(report, null, pretty ? 2 : 0));
  else {
    console.log(`DRIFT_SCAN byLine=${report.counts.byLine} byFile=${report.counts.byFile} byDedup=${report.counts.byDedup}`);
    console.log('perPattern=' + JSON.stringify(perPattern));
    for (const hit of hits) console.log(`  ${hit.file}:${hit.line} [${hit.pattern}] ${hit.text}`);
  }
  process.exit(0);
}

let base;
try { base = JSON.parse(fs.readFileSync(path.resolve(baselinePath), 'utf8')); } catch (error) {
  console.error('BASELINE_READ_FAILED: ' + String((error && error.message) || error));
  process.exit(2);
}
const known = new Set((base.hits || []).map(keyOf));
const now = new Set(hits.map(keyOf));
const strict = argv.includes('--strict');
const extra = hits.filter((h) => !known.has(keyOf(h)));
const missing = strict ? (base.hits || []).filter((h) => !now.has(keyOf(h))) : [];
report.drift = { baseline: path.resolve(baselinePath), mode: strict ? 'strict' : 'subset', extra, missing };
const bad = extra.length + missing.length;
if (asJson) console.log(JSON.stringify(report, null, pretty ? 2 : 0));
else {
  console.log(`DRIFT_SCAN ${bad ? 'DRIFT' : 'OK'}  byLine=${report.counts.byLine} byFile=${report.counts.byFile} byDedup=${report.counts.byDedup} extra=${extra.length} missing=${missing.length} mode=${strict ? 'strict' : 'subset'}`);
  for (const hit of extra) console.log(`  + ${hit.file}:${hit.line} [${hit.pattern}] ${hit.text}`);
  for (const hit of missing) console.log(`  - ${hit.file}:${hit.line} [${hit.pattern}]（基线有、现在没有）`);
}
process.exit(bad ? 1 : 0);
