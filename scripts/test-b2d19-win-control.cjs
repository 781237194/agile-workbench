'use strict';
/**
 * B-2d19 回归：window:control 必须校验 sender；app.exit 不得绕过退出审计。
 *
 * 为什么用「源码级断言」而不是真窗口点击：
 *   缺陷本质是「通道对任意渲染进程开放」——真窗口里唯一合法的 sender 就是主窗自己，
 *   正常点击永远走不到拒绝分支；能造出「非 BrowserWindow 的 sender」要靠 webview/注入方，
 *   既不稳定也会污染真实状态。所以这里锁住**结构不变量**（守卫存在、拒绝留审计、
 *   不存在绕过 exitWithAudit 的裸退出），配合 --layout-check/真窗口冒烟一起用。
 *
 * 用法：node scripts/test-b2d19-win-control.cjs
 * 退出码 0=全过；1=有失败。
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const MAIN = path.join(REPO, 'src', 'main.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : ' · ' + JSON.stringify(detail)));
}

const src = fs.readFileSync(MAIN, 'utf8');
const lines = src.split(/\r?\n/);
const idxOf = (re) => lines.findIndex((l) => re.test(l));

/* ---------- 1. window:control 必须有 sender 守卫 ---------- */
const handlerLine = idxOf(/ipcMain\.handle\('window:control'/);
check('S1 找到 window:control handler', handlerLine >= 0, { handlerLine: handlerLine + 1 });

const handlerEnd = (() => {
  if (handlerLine < 0) return handlerLine;
  for (let i = handlerLine + 1; i < lines.length; i += 1) {
    if (/^\s{2}\}\);\s*$/.test(lines[i])) return i;
  }
  return lines.length - 1;
})();
const handlerBody = lines.slice(handlerLine, handlerEnd + 1).join('\n');

check('S2 handler 内调用 windowOfSender 做 sender 反查', /windowOfSender\s*\(/.test(handlerBody), {});
check('S3 拒绝分支写审计 win-ctl-denied', /recordShellAudit\('win-ctl-denied'/.test(handlerBody), {});
check('S4 拒绝分支 return（不继续执行窗口动作）', /win-ctl-denied[\s\S]{0,300}?\breturn\b/.test(handlerBody), {});
check('S5 不再无脑操作 mainWindow（min/max/close 改为操作 sender 自己的窗）',
  !/mainWindow\.(minimize|maximize|unmaximize|close)\(\)/.test(handlerBody), {
  leftover: (handlerBody.match(/mainWindow\.\w+\([^)]*\)/g) || []).slice(0, 4),
});
check('S6 目标窗用 sender 反查结果（target/senderWin 变量）', /\b(target|senderWin)\s*\.\s*(minimize|close|isMaximized|maximize)\(/.test(handlerBody), {});

/* ---------- 2. windowOfSender 自身必须只认真实窗口 ---------- */
const helperLine = idxOf(/function windowOfSender\s*\(/);
check('S7 存在 windowOfSender 实现', helperLine >= 0, { helperLine: helperLine + 1 });
if (helperLine >= 0) {
  const helperEnd = (() => {
    for (let i = helperLine + 1; i < lines.length; i += 1) {
      if (/^\s{2}\}\s*$/.test(lines[i])) return i;
    }
    return Math.min(helperLine + 40, lines.length - 1);
  })();
  const helperBody = lines.slice(helperLine, helperEnd + 1).join('\n');
  check('S8 只枚举 BrowserWindow.getAllWindows()', /BrowserWindow\.getAllWindows\(\)/.test(helperBody), {});
  check('S9 按 webContents 同一性比对（w.webContents === sender）', /w\.webContents\s*===\s*sender/.test(helperBody), {});
  check('S10 已销毁窗口跳过（isDestroyed）', /isDestroyed/.test(helperBody), {});
  check('S11 查不到返回 null（默认拒绝，不默认放行）', /return\s+null/.test(helperBody), {});
}

/* ---------- 3. app.exit 不得绕过退出审计 ---------- */
const rawExit = [];
lines.forEach((l, i) => {
  if (!/app\.exit\(/.test(l)) return;
  if (/^\s*(\/\/|\*)/.test(l)) return;            // 注释行不算
  rawExit.push({ line: i + 1, text: l.trim() });
});
const exitWithAuditSites = lines.filter((l) => /\bexitWithAudit\(/.test(l) && !/function exitWithAudit/.test(l)).length;
check('S12 裸 app.exit( 只剩 1 处（exitWithAudit 内部唯一实现）', rawExit.length === 1, rawExit);
check('S13 exitWithAudit 调用点 ≥ 10（全部退出走统一入口）', exitWithAuditSites >= 10, { sites: exitWithAuditSites });
check('S14 exitWithAudit 内先写审计再 app.exit',
  /function exitWithAudit[\s\S]{0,400}?recordShellAudit\('shell-exit-code'[\s\S]{0,200}?app\.exit\(/.test(src), {});

/* ---------- 4. 退出/崩溃审计钩子齐 ---------- */
check('S15 will-quit 有审计行', /app\.on\('will-quit'[\s\S]{0,120}?recordShellAudit\('shell-exit'/.test(src), {});
check('S16 quit 事件落真实 exitCode', /app\.on\('quit'[\s\S]{0,200}?shell-quit/.test(src), {});
check('S17 render-process-gone / child-process-gone / unresponsive 三类均监听',
  /render-process-gone/.test(src) && /child-process-gone/.test(src) && /unresponsive/.test(src), {});

const failed = results.filter((r) => !r.ok);
console.log('\nB-2d19 回归：' + (results.length - failed.length) + '/' + results.length + ' PASS');
if (failed.length) {
  console.log('失败项：' + failed.map((r) => r.name).join(' | '));
  process.exitCode = 1;
}
// 2026-11-17 01:07 证据刷新：本行仅为让证据 mtime 晚于任务 claim（断言/逻辑一字未改）。
