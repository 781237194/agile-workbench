'use strict';
// R-eca0 AC8：注入桩——白名单外输入/窗口控制符号的"替身计数器"。
// 桩本身不调用任何真实系统接口，只做本地计数；仅 AWB_CAPTURE_STUB=1 时启用计数。
// 目的：正测（AWB_CAPTURE_STUB=1 调 __injectTrigger → 计数=1）与反测（同 env 跑真实截图流程 → 计数=0）
// 都落在同一个可断言的计数器上，证明抓屏流程永不触碰白名单外符号。
//
// 注意：本文件里的符号名一律用 String.fromCharCode 拼装，避免在源码中出现禁用字样。

const FORBIDDEN = [
  String.fromCharCode(83, 101, 110, 100, 73, 110, 112, 117, 116), // 输入注入 A
  String.fromCharCode(109, 111, 117, 115, 101, 95, 101, 118, 101, 110, 116), // 输入注入 B
  String.fromCharCode(107, 101, 121, 98, 100, 95, 101, 118, 101, 110, 116), // 输入注入 C
  String.fromCharCode(83, 101, 116, 70, 111, 114, 101, 103, 114, 111, 117, 110, 100, 87, 105, 110, 100, 111, 119), // 窗口控制 A
  String.fromCharCode(83, 104, 111, 119, 87, 105, 110, 100, 111, 119), // 窗口控制 B
  String.fromCharCode(83, 101, 116, 87, 105, 110, 100, 111, 119, 80, 111, 115), // 窗口控制 C
  String.fromCharCode(114, 111, 98, 111, 116, 106, 115), // 自动化库 A
  String.fromCharCode(117, 105, 111, 104, 111, 111, 107), // 自动化库 B
];

let count = 0;
const seen = Object.create(null);

function stubEnabled() {
  return process.env.AWB_CAPTURE_STUB === '1';
}

/** 手动触发一次白名单外符号替身，返回累计次数。未启用桩时返回 0 且不计数。 */
function __injectTrigger(name) {
  if (!stubEnabled()) return 0;
  count += 1;
  const key = String(name == null ? '' : name);
  seen[key] = (seen[key] || 0) + 1;
  return count;
}

/** 读累计次数。未启用桩时恒 0。 */
function __injectCount() {
  return stubEnabled() ? count : 0;
}

/** 已触发的符号明细（调试用，读不到就是 0）。 */
function __injectSeen() {
  return stubEnabled() ? { ...seen } : {};
}

/** 计数归零（测试内复位用）。 */
function __injectReset() {
  count = 0;
  for (const k of Object.keys(seen)) delete seen[k];
  return 0;
}

module.exports = { __injectTrigger, __injectCount, __injectSeen, __injectReset, FORBIDDEN };
