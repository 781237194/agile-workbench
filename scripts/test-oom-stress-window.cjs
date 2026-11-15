#!/usr/bin/env node
'use strict';
/**
 * test-oom-stress-window.cjs —— R-c1ed 卷2 §3.4「CLI 与 import 两条路径逐字段相等」断言
 *
 * 口径（增补卷-c1ed-2 §3.4）：`scripts/oom-stress.cjs --window --json` 与
 * `团队/工具/lib/render-mem-window.mjs`（未 apply 时退回 `src/render-memory.js`）对**同一 atCrash**
 * 的输出必须逐字段相等，脚本里不得复制第二份取数逻辑。
 *
 * 本脚本只读：对真实项目状态目录跑一次 CLI 与一次库调用，比较固定字段集合，不写任何采样文件。
 * 用法：node scripts/test-oom-stress-window.cjs [项目名] [atCrashISO]
 *   · 缺省项目名=工作台改造修复；atCrash 缺省取「当前时刻」（窗口可能不足，属正常，两边都该给同样结论）
 *   · 退出码 0=全部相等；1=有不一致；2=环境问题（项目状态目录不存在/CLI 跑不起来）
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = process.argv[2] || '工作台改造修复';
const AT = process.argv[3] || new Date().toISOString();
const PROJECT_DIR = path.join(ROOT, '团队', '状态', '项目', PROJECT);
const FIELDS = ['code', 'fail', 'pass', 'restorable', 'lines', 'firstAt', 'lastAt', 'coverageSec', 'insufficient', 'readFailed', 'r1', 'r2', 'r3'];

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 400)}`);
}

if (!fs.existsSync(PROJECT_DIR)) {
  console.error(`[PROJECT_STATE_MISSING] 找不到 ${PROJECT_DIR}`);
  process.exit(2);
}

// 路径一：CLI
let cli = null;
try {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'oom-stress.cjs'), '--window', '--project', PROJECT, '--at', AT, '--json'], { encoding: 'utf8', timeout: 60000 });
  cli = JSON.parse(String(out).trim().split(/\r?\n/).filter(Boolean).pop());
} catch (error) {
  const text = String((error && (error.stdout || error.message)) || error);
  console.error(`[CLI_FAILED] ${text.slice(0, 400)}`);
  process.exit(2);
}

// 路径二：库（与 CLI 同源：优先封装，未 apply 退回 src）
let libResult = null;
let via = 'src';
try {
  const wrapper = path.join(ROOT, '团队', '工具', 'lib', 'render-mem-window.mjs');
  if (fs.existsSync(wrapper)) {
    // eslint-disable-next-line global-require
    const mod = require(wrapper);
    libResult = mod.summarizeWindow(mod.readRenderMemoryWindow(PROJECT_DIR, { atCrash: AT, windowSec: 300 }), { atCrash: AT, windowSec: 300 });
    via = 'wrapper';
  }
} catch { libResult = null; }
if (!libResult) {
  const impl = require(path.join(ROOT, 'src', 'render-memory.js'));
  const win = impl.readRenderMemoryWindow(PROJECT_DIR, { atCrash: AT, windowSec: 300 });
  const evaluated = impl.evaluateRecoverable(win, { atCrash: AT, windowSec: 300 });
  const fail = win.code === 'READ_FAILED' || win.code === 'SAMPLING_DISABLED';
  libResult = { ...win, code: win.code, fail, pass: !fail, restorable: evaluated.restorable, r1: evaluated.R1, r2: evaluated.R2, r3: evaluated.R3, cadence: evaluated.cadence, gaps: evaluated.gaps };
  via = 'src';
}

check(`窗口 1：CLI 输出可解析且含固定字段（via=${cli.via}）`, Boolean(cli && typeof cli.code === 'string' && typeof cli.fail === 'boolean'), { keys: Object.keys(cli || {}) });
// 库侧 lines 是原始行数组，CLI 侧是行数（lineCount）——比较前统一成行数
if (Array.isArray(libResult.lines)) libResult = { ...libResult, lines: libResult.lines.length };
const diffs = [];
for (const field of FIELDS) {
  const a = cli[field];
  const b = libResult[field];
  const same = typeof a === 'object' ? JSON.stringify(a) === JSON.stringify(b) : a === b;
  if (!same) diffs.push({ field, cli: a, lib: b });
}
check(`窗口 2：CLI 与库（${via}）${FIELDS.length} 个字段逐字段相等`, diffs.length === 0, diffs);
const cadenceDiffs = [];
for (const field of ['realPoints', 'forced', 'forcedSamples', 'hasForced', 'densityPct', 'denseWarn', 'verdict']) {
  const a = cli.cadence ? cli.cadence[field] : undefined;
  const b = libResult.cadence ? libResult.cadence[field] : undefined;
  if (a !== b) cadenceDiffs.push({ field, cli: a, lib: b });
}
check('窗口 3：cadence 七键逐字段相等', cadenceDiffs.length === 0, cadenceDiffs);
check('窗口 4：gaps 结构一致（四键 {from,to,sec,reason}）',
  JSON.stringify(cli.gaps || []) === JSON.stringify(libResult.gaps || [])
  && (cli.gaps || []).every((gap) => ['from', 'to', 'sec', 'reason'].every((key) => Object.prototype.hasOwnProperty.call(gap, key))),
  { cliGaps: (cli.gaps || []).length, libGaps: (libResult.gaps || []).length });

console.log(`\noom-stress 两路径相等断言：${passed}/${passed + failures.length} PASS（项目=${PROJECT}，atCrash=${AT}，库路径=${via}）`);
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
process.exit(0);
