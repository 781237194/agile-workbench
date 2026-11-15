#!/usr/bin/env node
'use strict';
/**
 * check-render-sampler-symbols.cjs —— R-c1ed 线上故障回归（M-20261115-163300-117ee3）
 *
 * 背景：src/main.js 曾调用**不存在**的 renderMemoryProjectDirCached()，node --check 只查语法，
 * 抓不到运行时未定义引用 → 60 秒自检每拍抛 ReferenceError，Owner 界面每分钟弹一次
 * 「JavaScript error in the main process」。
 *
 * 本脚本做「声明表 vs 使用表」比对（只针对采样/崩溃感知这组符号，避免 Electron 全局造成海量误报）：
 *   · 每个符号必须「用过就有声明」，否则 FAIL（退出码 1）；
 *   · 每个符号若「有声明但从未使用」，只报 INFO（不 FAIL，避免清理式改动被卡）。
 *
 * 用法：node scripts/check-render-sampler-symbols.cjs [--json]
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FILES = ['src/main.js', 'src/render-memory.js', 'src/preload.js'];

// 采样/崩溃感知这组符号（新增标识符请往这里加，脚本会强制校验）
const SYMBOLS = [
  'renderMemoryState', 'renderMemoryDirCache', 'renderMemoryProjectDir', 'renderMemoryProjectDirCached',
  'rendererWorkingSetRows', 'writeRenderSample', 'startRenderMemorySampler', 'stopRenderMemorySampler',
  'scheduleRenderMemoryMaintenance', 'runRenderMemoryCleanup', 'appendRenderRetentionLine', 'archiveRenderCrash',
  'recordRenderCrash', 'installCrashSensors', 'reloadDshGuest', 'crashAuditFile', 'compactStamp',
  'RenderMemory', 'reconcile', 'samplerId', '__renderSamplerId',
];

function hasDeclaration(text, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`\\b(?:function|class)\\s+${esc}\\b`), // function/class 声明
    new RegExp(`\\b(?:const|let|var)\\s+${esc}\\b`), // 变量声明
    new RegExp(`\\b${esc}\\s*:`), // 对象属性定义（如 { reconcile: ... }）
    new RegExp(`\\b${esc}\\s*=`), // 赋值（含 globalThis.x = / state.x = ）
  ];
  return patterns.some((re) => re.test(text));
}

function usageCount(text, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 调用或属性访问：name(  /  name.  /  .name
  const re = new RegExp(`(?:\\b${esc}\\s*\\(|\\b${esc}\\s*\\.|\\.${esc}\\b)`, 'g');
  return (text.match(re) || []).length;
}

const rows = [];
const failures = [];
for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  let text = '';
  try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  for (const name of SYMBOLS) {
    const declared = hasDeclaration(text, name);
    const used = usageCount(text, name);
    if (used > 0 && !declared) {
      failures.push({ file: rel, symbol: name, problem: 'USED_BUT_UNDEFINED', used });
    } else if (used > 0) {
      rows.push({ file: rel, symbol: name, declared, used });
    }
  }
}

const out = {
  ok: failures.length === 0,
  files: FILES,
  checkedSymbols: SYMBOLS.length,
  declaredAndUsed: rows.length,
  undefined: failures,
  note: failures.length ? '有符号被使用但全仓找不到声明/赋值：node --check 抓不到这类运行时错误，必须在这里拦' : '全部采样/崩溃感知符号均「用过就有声明」',
};
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(out) + '\n');
else {
  for (const row of rows) process.stdout.write(`OK    ${row.file}  ${row.symbol}  used=${row.used}\n`);
  for (const bad of failures) process.stdout.write(`FAIL  ${bad.file}  ${bad.symbol}  ${bad.problem} used=${bad.used}\n`);
  process.stdout.write(`\n${out.ok ? 'PASS' : 'FAIL'}：${out.declaredAndUsed} 个符号通过，${failures.length} 个未定义；${out.note}\n`);
}
process.exit(out.ok ? 0 : 1);
