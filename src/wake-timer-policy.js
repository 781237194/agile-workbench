'use strict';
/**
 * src/wake-timer-policy.js —— R-d1bf / T-d230《壳层取消定时唤醒》策略唯一出口。
 * 口径（需求 §6.1）：定时器一律不得触发唤醒；唤醒只允许由事件驱动（send/ack/task/评审/需求推进/PM 手动补发）。
 * main.js 用 describePolicy() 写审计；夹具用它断言 timerWakeSites=0、allowTimerWake=false。
 */
const POLICY_VERSION = 'wake-timer-policy/1';

// 定时唤醒总开关：恒 false（禁止改 true 绕过验收）。
const ALLOW_TIMER_WAKE = false;

// 允许触发唤醒的事件清单（§6.2：每条事件恰好一次）。
const EVENT_TRIGGERS = Object.freeze(['send', 'ack', 'task', 'review', 'requirement', 'manual']);

// 壳层定时器唤醒点清单：必须为空；每新增一个都会在夹具里红。
const TIMER_WAKE_SITES = Object.freeze([]);

function canTimerWake() {
  return ALLOW_TIMER_WAKE;
}

function describePolicy() {
  return {
    version: POLICY_VERSION,
    allowTimerWake: ALLOW_TIMER_WAKE,
    timerWakeSites: TIMER_WAKE_SITES.slice(),
    eventTriggers: EVENT_TRIGGERS.slice(),
    deadlineTimer: 'audit-only',
    queuePump: 'event-driven',
    sandbox: 'skipped',
  };
}

function auditTimerWakeAttempt(site) {
  return { at: new Date().toISOString(), site: String(site || ''), allowed: false, code: 'TIMER_WAKE_DISABLED' };
}

module.exports = {
  POLICY_VERSION,
  ALLOW_TIMER_WAKE,
  EVENT_TRIGGERS,
  TIMER_WAKE_SITES,
  canTimerWake,
  describePolicy,
  auditTimerWakeAttempt,
};
