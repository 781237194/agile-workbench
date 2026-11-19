import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 可注入时钟（R-20261119-125935-d1bf §6.4）：所有「时间到点」判定统一走这里。
// AWB_NOW_MS 只影响判定，不改消息时间戳；非法/缺省回落系统时间。
export function readNowMs() {
  const raw = Number(process.env.AWB_NOW_MS || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : Date.now();
}

export function nowIsoMs(ms = readNowMs()) {
  return new Date(Number(ms) || Date.now()).toISOString();
}
