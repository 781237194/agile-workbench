// R-ad44（T-20261116-184335-b7dd）ESM 薄包装：唯一实现在 json-atomic.cjs（CJS）。
// 本文件**不得含实现体**（断言：无 writeFileSync / renameSync / fsync 调用），只转出同一实现。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const impl = require('./json-atomic.cjs');

export const AtomicError = impl.AtomicError;
export const LOCK_STALE_MS = impl.LOCK_STALE_MS;
export const WATCH_DEBOUNCE_MS = impl.WATCH_DEBOUNCE_MS;
export const nowMs = impl.nowMs;
export const sha256 = impl.sha256;
export const isAllowedPath = impl.isAllowedPath;
export const readJsonSafe = impl.readJsonSafe;
export const writeJsonAtomic = impl.writeJsonAtomic;
export const updateJsonAtomic = impl.updateJsonAtomic;
export const watchJson = impl.watchJson;

export default impl;
