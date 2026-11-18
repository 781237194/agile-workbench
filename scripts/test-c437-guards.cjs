#!/usr/bin/env node
'use strict';
/**
 * test-c437-guards.cjs —— B-20261118-191527-c437（P1 稳定性）夹具：
 *  ①crash-guard 纯判定（window-all-closed 复活 vs 退出 / 崩溃恢复动作 / 崩溃字段归一）；
 *  ②main.js 接线静态断言（审计不吞字段、崩后误退保护、webview 恢复、用户主动关窗识别）。
 *
 * 用法：node scripts/test-c437-guards.cjs [--out <json>]
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : ''; })();
const G = require(path.join(ROOT, 'src', 'crash-guard.js'));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? null : (detail === undefined ? null : detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(detail === undefined ? null : detail).slice(0, 400)}`);
}

/* ── ① window-all-closed 决策 ── */
check('W1 keep-alive（长跑实例）→ 退出不复活', G.decideWindowAllClosed({ keepAlive: true }).action === 'quit');
check('W2 显式 quit → 退出', G.decideWindowAllClosed({ explicitQuit: true }).action === 'quit');
check('W3 用户主动关窗（≤5s）→ 退出', G.decideWindowAllClosed({ lastUserCloseAgoMs: 1200 }).action === 'quit');
check('W4 无崩溃上下文 → 退出（不误复活）', G.decideWindowAllClosed({ lastCrashAgoMs: null }).action === 'quit');
const w5 = G.decideWindowAllClosed({ lastCrashAgoMs: 30 * 1000, revivesInLastHour: 0 });
check('W5 崩溃后 30s 窗口全关 → 复活主窗', w5.action === 'revive' && w5.reason === 'crash-adjacent-close', w5);
check('W6 崩溃已过 5 分钟 → 退出', G.decideWindowAllClosed({ lastCrashAgoMs: 5 * 60 * 1000 }).action === 'quit');
check('W7 1 小时已复活 3 次 → 退出（防复活循环）', G.decideWindowAllClosed({ lastCrashAgoMs: 30 * 1000, revivesInLastHour: 3 }).action === 'quit');
check('W8 headless 自检模式 → 退出', G.decideWindowAllClosed({ isHeadlessCheck: true, lastCrashAgoMs: 1000 }).action === 'quit');

/* ── ② 崩溃恢复决策 ── */
check('R1 主窗渲染崩溃 → reload 主窗',
  G.decideCrashRecovery({ crashKind: 'render-process-gone', isMainWindow: true }).action === 'reload-main');
check('R2 webview guest 崩溃 → 通知重载 dsh-view',
  G.decideCrashRecovery({ crashKind: 'web-contents-render-gone', isWebview: true }).action === 'reload-webview');
check('R3 Utility child-process-gone → 只审计不自动重载（避免重启风暴）',
  G.decideCrashRecovery({ crashKind: 'child-process-gone' }).action === 'none');
check('R4 10 分钟内已恢复 3 次 → 不再恢复', G.decideCrashRecovery({ isWebview: true, recoversInWindow: 3 }).action === 'none');
check('R5 距上次恢复 10s → 不立即重复恢复', G.decideCrashRecovery({ isWebview: true, lastRecoverAgoMs: 10000 }).action === 'none');

/* ── ③ 崩溃字段归一（不得吞掉 Utility crashed 归因） ── */
const f1 = G.normalizeCrashFields({ type: 'Utility', reason: 'crashed', exitCode: -1 });
check('F1 Utility crashed -1 → processType=Utility / reason=crashed / exitCode=-1',
  f1.processType === 'Utility' && f1.reason === 'crashed' && f1.exitCode === -1, f1);
const f2 = G.normalizeCrashFields({ type: 'renderer', reason: 'oom', exitCode: 5, serviceName: 'network.mojom.NetworkService' });
check('F2 serviceName 优先（network service 崩溃可分辨）', f2.processType === 'network.mojom.NetworkService' && f2.serviceName === 'network.mojom.NetworkService', f2);
const f3 = G.normalizeCrashFields(undefined);
check('F3 details 缺失不抛且给 unknown', f3.processType === 'unknown' && f3.exitCode === null, f3);

/* ── ④ main.js 接线（静态） ── */
const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const wired = {
  require: /require\('\.\/crash-guard\.js'\)/.test(src),
  normalize: /CrashGuard\.normalizeCrashFields\(info\)\.processType/.test(src) && /serviceName: CrashGuard\.normalizeCrashFields\(info\)\.serviceName/.test(src),
  recovery: /function scheduleCrashRecovery\(/.test(src) && /scheduleCrashRecovery\(row, info\)/.test(src),
  webviewHook: /handleWebviewCrash\(contents, details\)/.test(src),
  webviewReload: /shell-webview-recovered/.test(src),
  allClosedDecision: /shell-window-all-closed-decision/.test(src) && /CrashGuard\.decideWindowAllClosed\(/.test(src),
  revive: /recordShellAudit\('shell-revive'/.test(src),
  explicitQuit: /explicitQuit = true; boardQuitting = true/.test(src),
  userClose: /lastUserCloseAt = Date.now\(\); target\.close\(\)/.test(src),
  limits: /pruneTimes\(shellReviveTimes/.test(src) && /pruneTimes\(crashRecoverTimes/.test(src),
};
check('S1 main.js 全部接线点存在（require/归一/恢复/复活/显式quit/用户关窗识别/限次）',
  Object.values(wired).every(Boolean), wired);
check('S2 崩溃审计行含 processType + serviceName（Utility 崩溃不再只剩 kind）',
  /serviceName: CrashGuard\.normalizeCrashFields\(info\)\.serviceName/.test(src) && /processType: CrashGuard\.normalizeCrashFields\(info\)\.processType/.test(src), {});
check('S3 window-all-closed 先审计决策再决定（可回查为何退出/复活）',
  src.indexOf("recordShellAudit('shell-window-all-closed', {})") < src.indexOf("shell-window-all-closed-decision"), {});
check('S4 复活上限 3 次/小时、恢复上限 3 次/10 分钟为常量',
  G.REVIVE_MAX_PER_HOUR === 3 && G.RECOVER_MAX_PER_WINDOW === 3 && G.RECOVER_WINDOW_MS === 10 * 60 * 1000, {});

const failed = results.filter((r) => !r.ok);
const payload = { task: 'B-20261118-191527-c437', at: new Date().toISOString(), total: results.length, pass: results.length - failed.length, red: failed.length, ok: failed.length === 0, checks: results };
if (OUT) { try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8'); } catch { /* ignore */ } }
console.log('');
console.log(`C437_GUARDS ${failed.length ? 'FAIL' : 'OK'} ${JSON.stringify({ total: payload.total, pass: payload.pass, red: payload.red })}`);
if (OUT) console.log('证据：' + OUT);
process.exit(failed.length ? 1 : 0);
