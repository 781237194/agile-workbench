#!/usr/bin/env node
'use strict';
/**
 * T-20261121-124254-740a：证据不得落在沙盘/临时目录。
 * 扫描 项目/<项目>/<角色>/产出/** 文本里的 `_tmp/`、`awb-sandbox/` 路径。
 * 基线机制：历史文档大量引用 _tmp（审计/说明），不要求清零；只拦截「新增」。
 *   node scripts/check-no-sandbox-paths-in-evidence.cjs            # 超基线 exit 1
 *   node scripts/check-no-sandbox-paths-in-evidence.cjs --update-baseline
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const PROJECTS = path.join(ROOT, '项目');
const CURRENT_PROJECT = '工作台改造修复';
// 只看说明/报告类文档：日志/JSON 证据里出现临时路径是审计内容，不是「证据放沙盘」。
const TEXT_EXT = new Set(['.md']);
const PATTERN = /(?:^|[\\/("'`\s])_tmp[\\/]|awb-sandbox[\\/]/;
const hits = [];
function walk(dir, projectName) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, projectName); continue; }
    if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    let text = '';
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    text.split(/\r?\n/).forEach((line, index) => {
      if (PATTERN.test(line)) hits.push({ file: path.relative(ROOT, full), project: projectName, line: index + 1, text: line.trim().slice(0, 200) });
    });
  }
}
if (fs.existsSync(PROJECTS)) {
  for (const proj of fs.readdirSync(PROJECTS, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    for (const role of fs.readdirSync(path.join(PROJECTS, proj.name), { withFileTypes: true })) {
      if (!role.isDirectory()) continue;
      const outDir = path.join(PROJECTS, proj.name, role.name, '产出');
      if (fs.existsSync(outDir)) walk(outDir, proj.name);
    }
  }
}
const currentHits = hits.filter((h) => h.project === CURRENT_PROJECT);
const baselineFile = path.join(ROOT, '发布', '证据沙盘路径基线.json');
if (process.argv.includes('--update-baseline')) {
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
  fs.writeFileSync(baselineFile, JSON.stringify({ baseline: currentHits.length, at: new Date().toISOString(), note: '证据沙盘路径命中基线；只允许下降，新增需说明' }, null, 2) + String.fromCharCode(10), 'utf8');
  console.log('BASELINE_UPDATED ' + currentHits.length);
  process.exit(0);
}
let baseline = null;
try { baseline = Number(JSON.parse(fs.readFileSync(baselineFile, 'utf8')).baseline); } catch { baseline = null; }
if (!currentHits.length) { console.log('NO_SANDBOX_PATHS_IN_EVIDENCE_OK current=0 historical=' + (hits.length)); process.exit(0); }
const over = !Number.isFinite(baseline) || currentHits.length > baseline;
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: !over, check: 'NO_SANDBOX_PATHS_IN_EVIDENCE', currentTotal: currentHits.length, baseline, historicalTotal: hits.length - currentHits.length, currentHits: currentHits.slice(0, 50) }, null, 2));
} else if (over) {
  console.log('NO_SANDBOX_PATHS_IN_EVIDENCE_FAIL current=' + currentHits.length + ' baseline=' + baseline);
  for (const hit of currentHits.slice(0, 20)) console.log(hit.file + ':' + hit.line + '  ' + hit.text);
} else {
  console.log('NO_SANDBOX_PATHS_IN_EVIDENCE_OK current=' + currentHits.length + ' baseline=' + baseline + ' historical=' + (hits.length - currentHits.length) + '（未超基线）');
}
process.exit(over ? 1 : 0);
