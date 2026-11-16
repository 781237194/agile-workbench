'use strict';
/**
 * c1ed AC3「覆盖率归一」自检（PM 2026-11-16 裁定）：
 *   enoughLines = coverageSec >= 290 && lines >= floor(coverageSec * 0.98)
 * 语义：
 *   - coverage 不足 → 走 SAMPLING_WINDOW_INSUFFICIENT / R3，不判 AC3；
 *   - coverage 达标但行数比 <0.98 → 判「采样丢拍 sample_gap」（restorable=false）；
 *   - 采样周期漂移（1s→略快/略慢）由覆盖率归一吸收，不再要求恰好 300 行。
 */
const path = require('node:path');
const mem = require(path.join(process.cwd(), 'src', 'render-memory.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ` + JSON.stringify(detail || {}).slice(0, 300)); process.exitCode = 1; }
}

const atCrash = '2026-11-16T03:00:00.000Z';
const endMs = Date.parse(atCrash);
// 造 N 行：从 endMs-1s 往前每 stepMs 一行（保证相邻差 ≤2s、无缺口）
function win(rows, stepMs = 1000, coverageSecOverride) {
  const lines = [];
  for (let i = 0; i < rows; i += 1) {
    lines.push({ at: new Date(endMs - i * stepMs).toISOString(), pid: 1, type: 'Tab', workingSetMB: 100 + (i % 5), cause: 'sample', sampledFrom: null });
  }
  const coverageSec = coverageSecOverride === undefined ? ((rows - 1) * stepMs) / 1000 : coverageSecOverride;
  return { lines: lines.reverse(), coverageSec, readFailed: false, code: 'OK' };
}

// ① 覆盖 300s、294 行（ratio=0.98）→ 达标
const r1 = mem.evaluateRecoverable(win(294, 1000, 300), { windowSec: 300, atCrash });
ok('① 覆盖 300s / 294 行（0.98）→ enoughLines=true', r1.enoughLines === true, { enoughLines: r1.enoughLines, rows: r1.lines });

// ② 覆盖 300s、290 行（0.967）→ 丢拍
const r2 = mem.evaluateRecoverable(win(290, 1000, 300), { windowSec: 300, atCrash });
ok('② 覆盖 300s / 290 行（0.967）→ 丢拍：enoughLines=false 且 restorable=false', r2.enoughLines === false && r2.restorable === false, { enoughLines: r2.enoughLines, restorable: r2.restorable });

// ③ 覆盖 250s（不足 290）→ 不判 AC3（走 SAMPLING_WINDOW_INSUFFICIENT/R3 分支）
const r3 = mem.evaluateRecoverable(win(250, 1000, 250), { windowSec: 300, atCrash });
ok('③ 覆盖 250s → enoughLines=false（不足 290 走窗口不足分支）', r3.enoughLines === false, { enoughLines: r3.enoughLines, code: r3.code });

// ④ 采样变快（period 950ms，316 行覆盖 300s）→ 归一后仍达标（旧口径 300 行会误判通过/不足）
const r4 = mem.evaluateRecoverable(win(316, 950, 300), { windowSec: 300, atCrash });
ok('④ 行距 950ms（316 行/300s）→ 归一后达标', r4.enoughLines === true, { enoughLines: r4.enoughLines });

// ⑤ 采样变慢（period 1100ms，273 行覆盖 300s）→ 归一后不足（0.91）
const r5 = mem.evaluateRecoverable(win(273, 1100, 300), { windowSec: 300, atCrash });
ok('⑤ 行距 1100ms（273 行/300s，0.91）→ 判丢拍', r5.enoughLines === false, { enoughLines: r5.enoughLines });

console.log(`\nc1ed AC3 覆盖率归一断言：${pass}/${pass + fail} PASS`);
const fs = require('node:fs');
const evidDir = path.join(process.cwd(), '项目', '工作台改造修复', '程序员B', '产出', '证据-c1ed-ac3');
fs.mkdirSync(evidDir, { recursive: true });
fs.writeFileSync(path.join(evidDir, 'run-ac3.log'), `pass=${pass} fail=${fail} exit=${process.exitCode || 0}\n`, 'utf8');
