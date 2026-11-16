'use strict';
/**
 * render-mem-window.mjs —— R-c1ed AC3 取数入口（增补卷-c1ed-2 §3.1 / c1ed-3 §六 / c1ed-4 三条裁定）
 *
 * 设计：**不复制算法**。仓库根 `src/render-memory.js` 是唯一实现（卷2 §3.4「CLI 与兜底必须同一实现」），
 * 本模块只做两件事：①按卷2 §三/§四 归一返回字段与 code；②补 summarizeWindow() 的 R1/R2/R3 + cadence 视图。
 *
 * 归一后的 code 白名单（卷2 §四 + 卷3 §六 + 卷4③）：
 *   NO_SAMPLE_FILE | READ_FAILED | PARTIAL_SHARD | NO_PREV_SHARD | SAMPLING_DISABLED
 *   | SAMPLING_WINDOW_INSUFFICIENT | SAMPLE_CADENCE_BAD | OK
 * 优先级：readFailed > insufficient（卷2 §四）；密度判定走 cadence.verdict（5 分钟双边 15–25%、2 小时只判下限），
 * 不抛异常（卷4③）；**ok 字段已于 M-20261115-165442-e543b4 移除**——判定以 fail + restorable 为准，不再造第二套判据。
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// 仓库根 = 团队/工具/lib/../../../（与 src/render-memory.js 共用同一份取数实现）
const impl = require('../../../src/render-memory.js');

export const SHARD_MAX_BYTES = impl.SHARD_MAX_BYTES;
export const SAMPLE_RETENTION_DAYS = impl.SAMPLE_RETENTION_DAYS;
export const CRASH_RETENTION_DAYS = impl.CRASH_RETENTION_DAYS;
export const CRASH_MAX_DIRS = impl.CRASH_MAX_DIRS;

const CODES = ['NO_SAMPLE_FILE', 'READ_FAILED', 'PARTIAL_SHARD', 'NO_PREV_SHARD', 'SAMPLING_DISABLED', 'SAMPLING_WINDOW_INSUFFICIENT', 'SAMPLE_CADENCE_BAD', 'OK'];

/** 卷2 §3.1：唯一取数通道（末分片倒读 + 续读上一分片）；返回字段按卷2 §三固定集合。 */
export function readRenderMemoryWindow(projectPath, options = {}) {
  const win = impl.readRenderMemoryWindow(projectPath, options);
  const code = CODES.includes(String(win.code || '')) ? String(win.code) : (win.lines && win.lines.length ? 'OK' : 'NO_SAMPLE_FILE');
  return {
    lines: Array.isArray(win.lines) ? win.lines : [],
    firstAt: win.firstAt || null,
    lastAt: win.lastAt || null,
    coverageSec: Number(win.coverageSec) || 0,
    gaps: Array.isArray(win.gaps) ? win.gaps : [],
    insufficient: Boolean(win.insufficient),
    readFailed: Boolean(win.readFailed),
    code,
    windowSec: Number(win.windowSec) || (Number(options.windowSec) > 0 ? Number(options.windowSec) : 300),
    atCrash: win.atCrash || String(options.atCrash || ''),
  };
}

/**
 * 卷3 §六 + 卷4③：R1/R2/R3、真点密度与 cadence 汇总。
 * 返回 {pass, fail, code, lines, firstAt, lastAt, coverageSec, insufficient, readFailed, r1, r2, r3, restorable,
 *       gaps, nullRatio, samplePoints, sampleCount, degradedLines, cadence:{realPoints,forced,hasForced,densityPct,verdict}}
 */
export function summarizeWindow(win, options = {}) {
  const result = win && typeof win === 'object' ? win : {};
  const lines = Array.isArray(result.lines) ? result.lines : [];
  const evaluated = impl.evaluateRecoverable(result, options);
  const readFailed = Boolean(result.readFailed);
  const insufficient = Boolean(result.insufficient);
  // code 以「取数层给的」为准（它最清楚是 A/B/C/D 哪一格）；只有缺省时才用判据层补。
  const code = CODES.includes(String(result.code || '')) ? String(result.code) : (CODES.includes(String(evaluated.code || '')) ? String(evaluated.code) : 'NO_SAMPLE_FILE');
  // cadence：底层已给出完整对象（含 verdict），这里只做「窗口口径复核」——
  // PM 裁 M-20261115-161256-99f2ac（与 TRQ v4 对齐）：5 分钟窗口（windowSec ≤ 600）双边 15–25%，
  // 越界都判 SAMPLE_CADENCE_BAD；2 小时窗口（> 600）只判下限，>25% 只置 denseWarn 不改 verdict。
  const effectiveWindowSec = Number(options.windowSec) > 0 ? Number(options.windowSec) : (Number(result.windowSec) || 300);
  const baseCadence = evaluated.cadence && typeof evaluated.cadence === 'object'
    ? evaluated.cadence
    : { realPoints: evaluated.realPoints || 0, forced: 0, forcedSamples: 0, hasForced: false, densityPct: 0, denseWarn: false, verdict: 'SAMPLE_CADENCE_BAD' };
  const densityPct = Number(baseCadence.densityPct) || 0;
  const denseWarn = densityPct > 25;
  const lowerBad = densityPct < 15;
  const upperBad = densityPct > 25;
  // 与底层逐字同一表达式（PM 裁 M-20261115-161518-3157ce 的三行原样）
  const verdict = ((effectiveWindowSec <= 600 ? (lowerBad || upperBad) : lowerBad)) ? 'SAMPLE_CADENCE_BAD' : 'OK';
  const cadence = { ...baseCadence, densityPct, denseWarn, verdict };
  const restorable = Boolean(evaluated.restorable);
  // PM 裁 M-20261115-155719-f90c04：pass/fail 与 restorable 分家。
  //   fail = 真失败：READ_FAILED / SAMPLING_DISABLED（卷二 §四 B 行与 24h 无分片）
  //        或「有数据但密度不达标」（<15%），后者仅在 A/C/D 以外的正常窗口才有意义。
  //   A（NO_SAMPLE_FILE）、C（PARTIAL_SHARD）、D（NO_PREV_SHARD）、窗口不足：**不判 FAIL**。
  const noDataCodes = ['NO_SAMPLE_FILE', 'PARTIAL_SHARD', 'NO_PREV_SHARD', 'SAMPLING_WINDOW_INSUFFICIENT'];
  const cadenceBad = cadence.verdict === 'SAMPLE_CADENCE_BAD' && !noDataCodes.includes(code);
  const fail = code === 'READ_FAILED' || code === 'SAMPLING_DISABLED' || cadenceBad;
  return {
    pass: !fail,
    fail,
    code,
    lines: lines.length,
    firstAt: result.firstAt || null,
    lastAt: result.lastAt || null,
    coverageSec: Number(result.coverageSec) || 0,
    insufficient,
    readFailed,
    r1: Boolean(evaluated.R1),
    r2: Boolean(evaluated.R2),
    r3: Boolean(evaluated.R3),
    restorable,
    gaps: Array.isArray(evaluated.gaps) ? evaluated.gaps : [],
    nullRatio: evaluated.nullRatio,
    samplePoints: Number(evaluated.realPoints) || 0,
    sampleCount: lines.length,
    degradedLines: Number(evaluated.degradedLines) || 0,
    cadence,
  };
}

export default { readRenderMemoryWindow, summarizeWindow };
