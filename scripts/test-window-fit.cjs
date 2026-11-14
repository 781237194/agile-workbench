#!/usr/bin/env node
// B-032c「窗口别超屏」静态断言（程序员B）：
// ①默认 1500×900；②按 workArea 夹取、宽高各留 80；③首次居中；④记住上次尺寸/位置且恢复时再夹取；
// ⑤高 DPI/多屏：用 DIP 的 workArea，按记忆所在显示器夹取；⑥布局自检有 windowFit 与初始窗口截图。
// 用法：node scripts/test-window-fit.cjs [--json]
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');

const checks = [];
const push = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || '' });

// ── 一、纯函数：把 main.js 的窗口计算段取出来直接跑 ─────────────
const startMarker = 'const WINDOW_DEFAULT = { width: 1500, height: 900 };';
const endMarker = 'function createWindow() {';
const start = mainSrc.indexOf(startMarker);
const end = mainSrc.indexOf(endMarker);
const windowBlock = start >= 0 && end > start ? mainSrc.slice(start, end) : '';
let api = null;
if (start >= 0 && end > start) {
  try {
    const block = mainSrc.slice(start, end);
    api = new Function(block + '\nreturn { computeWindowSize, WINDOW_DEFAULT, WINDOW_MIN, WINDOW_MARGIN };')();
  } catch (error) {
    api = null;
    push('窗口计算段可独立执行', false, String((error && error.message) || error));
  }
} else {
  push('窗口计算段可定位', false, `start=${start} end=${end}`);
}
if (api) {
  const { computeWindowSize, WINDOW_DEFAULT, WINDOW_MIN, WINDOW_MARGIN } = api;
  push('默认窗口 1500×900', WINDOW_DEFAULT.width === 1500 && WINDOW_DEFAULT.height === 900, JSON.stringify(WINDOW_DEFAULT));
  push('最小窗口 900×600', WINDOW_MIN.width === 900 && WINDOW_MIN.height === 600, JSON.stringify(WINDOW_MIN));
  push('工作区边距 80', WINDOW_MARGIN === 80, String(WINDOW_MARGIN));

  const fit = (work, desired) => computeWindowSize(work, desired);
  push('1920×1040 工作区：默认 1500×900', JSON.stringify(fit({ width: 1920, height: 1040 })) === JSON.stringify({ width: 1500, height: 900 }), JSON.stringify(fit({ width: 1920, height: 1040 })));
  push('2560×1440@150% 的 DIP 工作区 1706×960：夹到 1500×880', JSON.stringify(fit({ width: 1706, height: 960 })) === JSON.stringify({ width: 1500, height: 880 }), JSON.stringify(fit({ width: 1706, height: 960 })));
  push('1920×1080@125% 的 DIP 工作区 1536×824：夹到 1456×744', JSON.stringify(fit({ width: 1536, height: 824 })) === JSON.stringify({ width: 1456, height: 744 }), JSON.stringify(fit({ width: 1536, height: 824 })));
  push('1366×768 工作区：夹到 1286×688（各留 80）', JSON.stringify(fit({ width: 1366, height: 768 })) === JSON.stringify({ width: 1286, height: 688 }), JSON.stringify(fit({ width: 1366, height: 768 })));
  push('2560×1400 工作区：默认仍 1500×900', JSON.stringify(fit({ width: 2560, height: 1400 })) === JSON.stringify({ width: 1500, height: 900 }), JSON.stringify(fit({ width: 2560, height: 1400 })));
  push('恢复上次 3000×2000：夹到 1840×960', JSON.stringify(fit({ width: 1920, height: 1040 }, { width: 3000, height: 2000 })) === JSON.stringify({ width: 1840, height: 960 }), JSON.stringify(fit({ width: 1920, height: 1040 }, { width: 3000, height: 2000 })));
  push('800×600 小屏：夹到 720×520（不越界）', JSON.stringify(fit({ width: 800, height: 600 })) === JSON.stringify({ width: 720, height: 520 }), JSON.stringify(fit({ width: 800, height: 600 })));
  push('700×500 极小屏：夹到 620×420（低于最小尺寸也不越界）', JSON.stringify(fit({ width: 700, height: 500 })) === JSON.stringify({ width: 620, height: 420 }), JSON.stringify(fit({ width: 700, height: 500 })));
  push('无工作区信息：兜底 1500×900', JSON.stringify(fit(null)) === JSON.stringify({ width: 1500, height: 900 }), JSON.stringify(fit(null)));
  push('工作区 0×0：按兜底算，不产生 0 宽窗口', fit({ width: 0, height: 0 }).width > 0 && fit({ width: 0, height: 0 }).height > 0, JSON.stringify(fit({ width: 0, height: 0 })));
  push('已废弃的 90% 缩放逻辑清零', !/area\.width \* 0\.9/.test(mainSrc) && !/area\.height \* 0\.9/.test(mainSrc));
} else {
  push('窗口纯函数断言可运行', false);
}

// ── 二、main.js 源码口径 ─────────────────────────────────────
push('读取显示器工作区 workArea', /display\.workArea\b/.test(mainSrc));
push('多屏用 getDisplayMatching 定位记忆所在屏', /screen\.getDisplayMatching\(\{ x: pref\.x, y: pref\.y, width: pref\.width, height: pref\.height \}\)/.test(mainSrc));
push('高 DPI 不乘 scaleFactor（窗口计算段只用 DIP）', Boolean(windowBlock) && !/scaleFactor|devicePixelRatio/.test(windowBlock));
push('首次启动居中（x/y 由 workArea 与尺寸算）', /area\.x \+ Math\.round\(\(area\.width - size\.width\) \/ 2\)/.test(mainSrc) && /area\.y \+ Math\.round\(\(area\.height - size\.height\) \/ 2\)/.test(mainSrc));
push('恢复记忆位置时夹回工作区', /bounds\.x = Math\.min\(Math\.max\(saved\.x, area\.x\), area\.x \+ Math\.max\(0, area\.width - size\.width\)\)/.test(mainSrc) && /bounds\.y = Math\.min\(Math\.max\(saved\.y, area\.y\), area\.y \+ Math\.max\(0, area\.height - size\.height\)\)/.test(mainSrc));
push('记忆写在 workbench.json 的 ui.window', /store\.ui = \{ \.\.\.\(store\.ui \|\| \{\}\), window: pref \}/.test(mainSrc));
push('最大化/最小化不覆盖上次正常尺寸', /win\.isMinimized\(\) \|\| win\.isMaximized\(\) \|\| win\.isFullScreen\(\)/.test(mainSrc));
push('拖动/缩放防抖保存', /mainWindow\.on\('resize', scheduleWindowSave\)/.test(mainSrc) && /mainWindow\.on\('move', scheduleWindowSave\)/.test(mainSrc));
push('关闭前补存一次', /mainWindow\.on\('close', \(\) => \{[\s\S]{0,120}saveWindowPref\(mainWindow\)/.test(mainSrc));
push('最小尺寸不超过本次可用窗口，避免顶出屏幕', /minWidth: Math\.min\(WINDOW_MIN\.width, bounds\.width\), minHeight: Math\.min\(WINDOW_MIN\.height, bounds\.height\)/.test(mainSrc));
push('布局自检有 windowFit（fits+centered）', /windowFit/.test(mainSrc) && /fits, centered:/.test(mainSrc));
push('布局自检拍初始窗口截图', /window-initial\.png/.test(mainSrc) && /capturePage\(\)\)\.toPNG\(\)/.test(mainSrc));
push('报告含工作区、缩放比与窗口实测', /workArea: display\.workArea, workAreaSize: display\.workAreaSize, bounds: display\.size, scaleFactor: display\.scaleFactor/.test(mainSrc));

const failed = checks.filter((c) => !c.ok);
const report = { checks: checks.length, failed: failed.length, failures: failed, ok: failed.length === 0 };
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  for (const c of checks) console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.name + (c.detail ? ' · ' + c.detail : ''));
  console.log(report.ok ? 'WINDOW_FIT_OK' : 'WINDOW_FIT_FAIL');
}
process.exitCode = report.ok ? 0 : 1;
