'use strict';
/**
 * B-20261118-191527-c437（P1 稳定性）：崩溃/W 窗口关闭的**纯判定逻辑**（Node 可测，无 Electron 依赖）。
 *
 * 背景：tester A8 复验与 Owner 19:05 均遇到「webview 加载后 2–3.5 分钟窗口被销毁 / 壳整体退出」，
 * 审计里出现 `child-process-gone processType=Utility reason=crashed exitCode=-1`；另有一次
 * window-all-closed 前无 render/child 崩溃行（分不清「人点 X」还是「崩溃后误退」）。
 *
 * 本模块只做三件事（决策与字段归一，副作用全在 main.js）：
 *  1) decideWindowAllClosed：窗口全关时「复活主窗」还是「正常退出」（崩溃后 2 分钟内、非用户主动关窗、
 *     且复活次数未超限 → 复活；用户主动关窗/无崩溃关联 → 退出）；
 *  2) decideCrashRecovery：崩溃后要不要自动恢复（主窗渲染崩溃 → reload 主窗；webview guest 崩溃 →
 *     通知渲染层重载 dsh-view），带 10 分钟窗口限次，避免崩溃循环刷屏；
 *  3) normalizeCrashFields：把 Electron 的 details 归一成审计字段（processType/serviceName/reason/exitCode），
 *     保证 Utility crashed 这类行不再只剩 kind，不再「吞掉」归因信息。
 */

const REVIVE_MAX_PER_HOUR = 3;
const REVIVE_CRASH_WINDOW_MS = 2 * 60 * 1000;
const RECOVER_WINDOW_MS = 10 * 60 * 1000;
const RECOVER_MAX_PER_WINDOW = 3;
const USER_CLOSE_GUARD_MS = 5000;
/** 毫秒数归一：null/undefined/空串 → null（Number(null)===0，不能只靠 Number.isFinite(Number(v))）。 */
function agoOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 窗口全关决策。
 * @param {{explicitQuit?:boolean, lastUserCloseAgoMs?:number|null, lastCrashAgoMs?:number|null,
 *          revivesInLastHour?:number, keepAlive?:boolean, isHeadlessCheck?:boolean}} input
 * @returns {{action:'revive'|'quit', reason:string}}
 */
function decideWindowAllClosed(input = {}) {
  const explicitQuit = Boolean(input.explicitQuit);
  const lastUserCloseAgoMs = agoOf(input.lastUserCloseAgoMs);
  const lastCrashAgoMs = agoOf(input.lastCrashAgoMs);
  const revives = Number(input.revivesInLastHour) || 0;
  if (input.keepAlive) return { action: 'quit', reason: 'keep-alive-owner' };
  if (input.isHeadlessCheck) return { action: 'quit', reason: 'headless-check' };
  if (explicitQuit) return { action: 'quit', reason: 'explicit-quit' };
  if (lastUserCloseAgoMs !== null && lastUserCloseAgoMs <= USER_CLOSE_GUARD_MS) return { action: 'quit', reason: 'user-close' };
  if (lastCrashAgoMs === null) return { action: 'quit', reason: 'no-crash-context' };
  if (lastCrashAgoMs > REVIVE_CRASH_WINDOW_MS) return { action: 'quit', reason: 'crash-too-old' };
  if (revives >= REVIVE_MAX_PER_HOUR) return { action: 'quit', reason: 'revive-limit' };
  return { action: 'revive', reason: 'crash-adjacent-close' };
}

/**
 * 崩溃恢复决策。
 * @param {{crashKind?:string, isMainWindow?:boolean, recoversInWindow?:number,
 *          lastRecoverAgoMs?:number|null, isWebview?:boolean}} input
 * @returns {{action:'reload-main'|'reload-webview'|'none', reason:string}}
 */
function decideCrashRecovery(input = {}) {
  const kind = String(input.crashKind || '');
  const recovers = Number(input.recoversInWindow) || 0;
  const lastRecoverAgoMs = agoOf(input.lastRecoverAgoMs);
  if (recovers >= RECOVER_MAX_PER_WINDOW) return { action: 'none', reason: 'recover-limit' };
  if (lastRecoverAgoMs !== null && lastRecoverAgoMs < 30 * 1000) return { action: 'none', reason: 'too-soon' };
  if (input.isWebview) return { action: 'reload-webview', reason: 'guest-crash' };
  if (input.isMainWindow) return { action: 'reload-main', reason: 'shell-renderer-crash' };
  if (kind === 'child-process-gone') return { action: 'none', reason: 'child-process-crash-audited' };
  return { action: 'none', reason: 'not-recoverable' };
}

/** 归一 Electron details → 审计字段（任何字段缺失都不抛）。 */
function normalizeCrashFields(details) {
  const info = details && typeof details === 'object' ? details : {};
  const type = String(info.type || info.processType || '');
  const serviceName = String(info.serviceName || info.service || '');
  const processType = serviceName || type || 'unknown';
  return {
    processType,
    serviceName: serviceName || null,
    type: type || null,
    reason: String(info.reason || ''),
    exitCode: info.exitCode === undefined || info.exitCode === null || !Number.isFinite(Number(info.exitCode))
      ? null : Number(info.exitCode),
    crashed: type === 'Utility' || serviceName ? /crashed|gone/i.test(String(info.reason || '')) : Boolean(info.reason),
  };
}

module.exports = {
  REVIVE_MAX_PER_HOUR,
  REVIVE_CRASH_WINDOW_MS,
  RECOVER_WINDOW_MS,
  RECOVER_MAX_PER_WINDOW,
  USER_CLOSE_GUARD_MS,
  decideWindowAllClosed,
  decideCrashRecovery,
  normalizeCrashFields,
};
