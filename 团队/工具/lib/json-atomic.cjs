'use strict';
/**
 * json-atomic.cjs —— R-ad44（T-20261116-184335-b7dd）唯一 JSON 写入口（CommonJS 实现体）
 *
 * 为什么是 CJS：Node 20 / Electron 33 **不支持 require(ESM)**；唯一实现必须是 .cjs，
 * ESM 侧只能 createRequire 薄包装（团队/工具/lib/json-atomic.mjs），不得写第二份实现。
 *
 * 契约（正文 AC1/AC2/AC3/AC4/AC5/AC7/AC8）：
 *   writeJsonAtomic(file, data, opts)        单次写：<file>.tmp → fsync → <file>.bak → rename，锁内可选 prevSha 校验
 *   updateJsonAtomic(file, mutateFn, opts)   锁内读 → mutate → 校验 prevSha → 原子替换（AC2 50 并发走这条）
 *   readJsonSafe(file)                       读盘；坏 JSON 判 CORRUPT 并从 .bak 恢复（返回 restored）
 *   watchJson(file, cb, opts)                按「文件」订阅、300ms 尾部去抖、同文件多订阅共享 watcher + 引用计数
 *   acquireLock/releaseLock（内部导出供测试）  锁文件 <file>.lock = {pid,at,case,seq}；LOCK_STALE_MS=60000
 *
 * 审计：<项目状态目录>/写入审计.jsonl 固定 8 键 {at,project,file,case,result,code,prevSha,newSha}，append-only。
 * 注入时钟：AWB_NOW_MS（数字）优先，否则 Date.now()——AC7 靠它造 70 秒前锁，不真等。
 * 错误：抛 AtomicError{code}，code ∈ BAD_PATH / WRITE_LOCKED / LOCK_STALE / WRITE_CONFLICT / CORRUPT / READONLY / WRITE_FAILED；
 *       禁止静默吞错；失败必清 tmp，原文件不变。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const LOCK_STALE_MS = 60000;
const WATCH_DEBOUNCE_MS = 300;
const AUDIT_FILE = '写入审计.jsonl';

class AtomicError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.code = code;
    this.details = details || {};
  }
}

function nowMs() {
  const injected = Number(process.env.AWB_NOW_MS || 0);
  return Number.isFinite(injected) && injected > 0 ? injected : Date.now();
}
function nowIso() { return new Date(nowMs()).toISOString(); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function shaOfFile(file) {
  try { return sha256(fs.readFileSync(file)); } catch { return null; }
}
/** 清只读位（Windows 下 chmod 0o666 = 去掉只读属性）；不存在/无权限时静默忽略。 */
function clearReadonly(target) {
  if (!target) return;
  try { fs.chmodSync(target, 0o666); } catch { /* 不存在或无法改：忽略 */ }
}

/**
 * B-20261117-201937-c17a：备份目标文件到 .bak。
 * 旧实现直接 copyFileSync：源文件只读时，Windows 会连目标一起复制成只读 → 用户解除原文件权限后，
 * 下一次写仍因 .bak 只读在 copyfile 处 EPERM，恢复路径被卡死、无法自愈。
 * 现在：写前清 .bak 只读 → 复制 → **再清一次 .bak 只读**；copyfile 被拒时清源只读位重试，仍失败退化为字节复制。
 */
function safeCopyBackup(file, bak) {
  clearReadonly(bak);
  try {
    fs.copyFileSync(file, bak);
  } catch {
    clearReadonly(file);
    try {
      fs.copyFileSync(file, bak);
    } catch {
      fs.writeFileSync(bak, fs.readFileSync(file));
    }
  }
  clearReadonly(bak); // 关键：.bak 绝不继承只读位，否则解除权限后仍 EPERM
}

function atomicWriteRaw(file, buf) {
  const tmp = file + '.tmp';
  try {
    clearReadonly(tmp);
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const bak = file + '.bak';
    if (fs.existsSync(file)) safeCopyBackup(file, bak);
    fs.renameSync(tmp, file);
  } catch (error) {
    try { if (fs.existsSync(tmp)) { clearReadonly(tmp); fs.rmSync(tmp, { force: true }); } } catch { /* 清理失败不掩盖原错误 */ }
    throw new AtomicError('WRITE_FAILED', `写失败：${file}（${(error && error.message) || error}）`, { file });
  }
}

/* ── 路径白名单（AC1①/边界·权限）：只允许项目状态 / 团队状态 / workbench.json ── */
function isAllowedPath(file, opts) {
  const abs = path.resolve(String(file || ''));
  if (!file) return false;
  const extraRoots = Array.isArray(opts && opts.allowedRoots) ? opts.allowedRoots.map((p) => path.resolve(p)) : [];
  if (extraRoots.some((root) => abs === root || abs.startsWith(root + path.sep))) return true;
  const base = path.basename(abs);
  if (base === 'workbench.json') return true;
  // 显式例外：项目根 项目索引.json（team-tools 的索引同步落点；它不是团队状态目录，但确属状态性写入）
  if (base === '项目索引.json') return true;
  const norm = abs.replace(/\\/g, '/');
  return norm.includes('/团队/状态/') || norm.includes('/状态/项目/');
}
function assertPath(file, opts) {
  if (!file || typeof file !== 'string') throw new AtomicError('BAD_PATH', '空路径：必须给目标 JSON 文件', { file: String(file || '') });
  if (!isAllowedPath(file, opts)) throw new AtomicError('BAD_PATH', `越界写入被拒：${file}（只允许项目状态/团队状态/workbench.json）`, { file });
}

/* ── 审计（AC8：固定 8 键） ── */
function deriveProject(file) {
  const norm = path.resolve(file).replace(/\\/g, '/');
  const m = /\/状态\/项目\/([^/]+)\//.exec(norm);
  return m ? m[1] : '';
}
function auditPathFor(file, opts) {
  if (opts && opts.auditFile) return opts.auditFile;
  if (opts && opts.projectDir) return path.join(opts.projectDir, AUDIT_FILE);
  const norm = path.resolve(file).replace(/\\/g, '/');
  const m = /^(.*\/状态\/项目\/[^/]+)\//.exec(norm);
  return m ? path.join(m[1], AUDIT_FILE) : '';
}
function appendAudit(file, opts, row) {
  const auditFile = auditPathFor(file, opts);
  if (!auditFile) return;
  const project = (opts && opts.project) || deriveProject(file);
  const line = {
    at: nowIso(),
    project: String(project || ''),
    file: String(file || ''),
    case: String((opts && opts.case) || ''),
    result: String((row && row.result) || 'ok'),
    code: String((row && row.code) || ''),
    prevSha: row && row.prevSha != null ? String(row.prevSha) : '',
    newSha: row && row.newSha != null ? String(row.newSha) : '',
  };
  try {
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.appendFileSync(auditFile, JSON.stringify(line) + '\n', 'utf8');
  } catch { /* 审计写失败不阻断业务，但不能影响返回 */ }
}

/* ── 锁（AC2/AC5/AC7）：<file>.lock = {pid,at,case,seq}；LOCK_STALE_MS=60000 ── */
let seqCounter = 0;
function lockPathOf(file) { return file + '.lock'; }
function readLock(file) {
  try { return JSON.parse(fs.readFileSync(lockPathOf(file), 'utf8')); } catch { return null; }
}
function acquireLock(file, opts) {
  const lockFile = lockPathOf(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fs.openSync(lockFile, 'wx');
    seqCounter += 1;
    const body = { pid: process.pid, at: nowMs(), case: String((opts && opts.case) || ''), seq: seqCounter };
    try { fs.writeSync(fd, JSON.stringify(body)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return body;
  } catch (error) {
    if (!error || error.code !== 'EEXIST') {
      throw new AtomicError('WRITE_LOCKED', `取锁失败（${file}）：${(error && error.message) || error}`, { file });
    }
  }
  // 已被占：判断是否过期（可接管）
  const held = readLock(file);
  const age = held && Number(held.at) ? nowMs() - Number(held.at) : null;
  if (age !== null && age >= LOCK_STALE_MS) {
    const stale = { ...(held || {}), staleAgeMs: age, stalePid: held && held.pid };
    try { fs.rmSync(lockFile, { force: true }); } catch { /* 接管失败下面重试会抛 */ }
    try {
      const fd = fs.openSync(lockFile, 'wx');
      seqCounter += 1;
      const body = { pid: process.pid, at: nowMs(), case: String((opts && opts.case) || ''), seq: seqCounter, staleTakeoverFrom: stale.stalePid, staleAgeMs: age };
      try { fs.writeSync(fd, JSON.stringify(body)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      appendAudit(file, opts, { result: 'stale', code: 'LOCK_STALE', prevSha: shaOfFile(file), newSha: '' });
      return body;
    } catch (error) {
      throw new AtomicError('WRITE_LOCKED', `接管过期锁失败（${file}）：${(error && error.message) || error}`, { file });
    }
  }
  throw new AtomicError('WRITE_LOCKED', `文件被占用（${file}；锁 age=${age === null ? '未知' : Math.round(age) + 'ms'}，<${LOCK_STALE_MS}ms 不接管）`, {
    file, lock: held, ageMs: age,
  });
}
/** 同步小睡（不加异步链路，保持 API 同步）。 */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Math.floor(ms))); } catch { /* 环境不支持就忙等极短 */ }
}

/** 取锁（带重试）：AC2 的 50 个并发写者需要排队，而不是一次失败就丢。
 * 预算用**真实时间**（Date.now）+ 次数上限，不用 AWB_NOW_MS——注入时钟是给「锁年龄」用的常量，
 * 若拿它算重试预算会因时钟不前进而死循环（首版实测踩过：审计被刷到 1.4MB）。
 * 失败只写 1 条 locked 审计（不是每次重试都写）。 */
function acquireLockWithRetry(file, opts) {
  const timeoutMs = Number((opts && opts.lockTimeoutMs) || 15000);
  const maxAttempts = Number((opts && opts.maxLockAttempts) || 2000);
  const startedReal = Date.now();
  let attempt = 0;
  for (;;) {
    try { return acquireLock(file, opts); }
    catch (error) {
      if (!error || error.code !== 'WRITE_LOCKED') throw error;
      attempt += 1;
      if (attempt >= maxAttempts || Date.now() - startedReal >= timeoutMs) {
        appendAudit(file, opts, { result: 'locked', code: 'WRITE_LOCKED', prevSha: shaOfFile(file), newSha: '' });
        throw new AtomicError('WRITE_LOCKED', `等锁超时（${timeoutMs}ms / ${attempt} 次）：${file}`, { file, attempts: attempt });
      }
      sleepSync(4 + Math.min(40, attempt * 2) + Math.floor(Math.random() * 8));
    }
  }
}

function releaseLock(file) {
  try { fs.rmSync(lockPathOf(file), { force: true }); } catch { /* 释放失败不报错 */ }
}

/* ── 读（AC1/边界·异常：半行判 CORRUPT，从 .bak 恢复并告警） ── */
function readJsonSafe(file) {
  const raw = (() => { try { return fs.readFileSync(file); } catch { return null; } })();
  if (!raw) return { ok: true, exists: false, data: null, sha256: null, bytes: 0, restored: false };
  const sha = sha256(raw);
  try {
    return { ok: true, exists: true, data: JSON.parse(String(raw)), sha256: sha, bytes: raw.length, restored: false };
  } catch (error) {
    const bak = file + '.bak';
    const bakRaw = (() => { try { return fs.readFileSync(bak); } catch { return null; } })();
    if (bakRaw) {
      try {
        const data = JSON.parse(String(bakRaw));
        atomicWriteRaw(file, bakRaw);
        return { ok: true, exists: true, data, sha256: sha256(bakRaw), bytes: bakRaw.length, restored: true, corruptSha: sha };
      } catch { /* 备份也坏，往下判 CORRUPT */ }
    }
    return { ok: false, code: 'CORRUPT', exists: true, data: null, sha256: sha, bytes: raw.length, restored: false, message: (error && error.message) || String(error) };
  }
}

/** 锁外单次写：调用方自己保证互斥（writeJsonAtomic 内部会取锁；内部函数不取锁）。 */
function teamRosterNonEmptyCount(data) {
  const members = Array.isArray(data && data.members) ? data.members : [];
  return members.filter((m) => m && String(m.sessionId || '').trim()).length;
}

/** T-1205（P0）：团队.json 的整文件写唯一硬保险（所有 writeJsonAtomic/updateJsonAtomic 都经过这里）。 */
function assertTeamRosterNotCleared(file, data, opts) {
  if (path.basename(String(file || '')) !== '团队.json') return;
  if (opts && opts.allowRosterClear === true) return;
  let before = null;
  try { before = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 首建/坏文件按 0 */ }
  const beforeCount = teamRosterNonEmptyCount(before);
  const afterCount = teamRosterNonEmptyCount(data);
  if (beforeCount > 0 && afterCount === 0) {
    const project = String((opts && opts.project) || (data && data.activeProject) || (before && before.activeProject) || '');
    const row = {
      at: nowIso(),
      event: 'roster_cleared_blocked',
      by: 'json-atomic',
      source: String((opts && opts.case) || 'jsonAtomic.writeJsonAtomic'),
      case: String((opts && opts.case) || ''),
      stack: String(new Error().stack || '').split('\n').slice(1, 6),
      project,
      before,
      after: data,
      code: 'ROSTER_CLEAR_BLOCKED',
    };
    try {
      const dir = project ? path.join(path.dirname(file), '项目', project) : path.dirname(file);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, '名册变更.jsonl'), JSON.stringify(row) + '\n', 'utf8');
    } catch { /* 审计失败不掩盖拒写 */ }
    appendAudit(file, opts, { result: 'blocked', code: 'ROSTER_CLEAR_BLOCKED', prevSha: shaOfFile(file), newSha: '' });
    throw new AtomicError('ROSTER_CLEAR_BLOCKED', `拒写 ${path.basename(file)}：写前 ${beforeCount} 个非空 sessionId，写后 0 个（case=${row.case || '(空)'}）；已记 名册变更.jsonl`, {
      file, case: row.case, beforeCount, afterCount, project,
    });
  }
}

function writeJsonAtomicRaw(file, data, opts) {
  assertPath(file, opts);
  assertTeamRosterNotCleared(file, data, opts);
  const buf = Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf8');
  const prevSha = shaOfFile(file);
  const prev = (opts && opts.prevSha !== undefined && opts.prevSha !== null) ? String(opts.prevSha) : null;
  if (prev !== null && prev !== '' && prev !== prevSha) {
    appendAudit(file, opts, { result: 'conflict', code: 'WRITE_CONFLICT', prevSha, newSha: '' });
    throw new AtomicError('WRITE_CONFLICT', `版本冲突：期望 prevSha=${prev.slice(0, 12)}，磁盘现值=${(prevSha || '(不存在)').slice(0, 12)}（${file}）`, {
      file, expected: prev, current: prevSha,
    });
  }
  atomicWriteRaw(file, buf);
  const newSha = sha256(buf);
  appendAudit(file, opts, { result: 'ok', code: '', prevSha: prevSha || '', newSha });
  return { ok: true, file, prevSha: prevSha || '', sha256: newSha, bytes: buf.length };
}

/** 单次写（取锁 → prevSha 校验 → tmp/fsync/bak/rename）。 */
function writeJsonAtomic(file, data, opts) {
  acquireLockWithRetry(file, opts);
  try { return writeJsonAtomicRaw(file, data, opts); } finally { releaseLock(file); }
}

/** 锁内读-改-写（AC2）：调用方不得在锁外做这个循环。 */
function updateJsonAtomic(file, mutateFn, opts) {
  if (typeof mutateFn !== 'function') throw new AtomicError('BAD_MUTATE', 'updateJsonAtomic 需要 mutateFn');
  acquireLockWithRetry(file, opts);
  try {
    const current = readJsonSafe(file);
    if (current.ok === false) throw new AtomicError('CORRUPT', `读盘失败（${file}）：${current.message || 'CORRUPT'}`, { file });
    const base = current.exists && current.data && typeof current.data === 'object' ? current.data : {};
    const next = mutateFn(base, { sha256: current.sha256, exists: current.exists });
    if (!next || typeof next !== 'object') throw new AtomicError('BAD_MUTATE', 'mutateFn 必须返回对象', { file });
    const expected = opts && opts.prevSha !== undefined ? opts.prevSha : (current.exists ? current.sha256 : '');
    return writeJsonAtomicRaw(file, next, { ...(opts || {}), prevSha: expected });
  } finally { releaseLock(file); }
}

/* ── 事件合并（AC4）：按文件订阅、300ms 尾部去抖、同文件共享 watcher + 引用计数 ── */
const watchers = new Map(); // file -> { watcher, timer, subscribers:Set, debounceMs }
function watchJson(file, cb, opts) {
  if (typeof cb !== 'function') throw new AtomicError('BAD_CALLBACK', 'watchJson 需要回调');
  const abs = path.resolve(String(file || ''));
  const debounceMs = Number((opts && opts.debounceMs) || WATCH_DEBOUNCE_MS);
  let entry = watchers.get(abs);
  if (!entry) {
    entry = { watcher: null, timer: null, subscribers: new Set(), debounceMs };
    const fire = () => {
      entry.timer = null;
      const info = readJsonSafe(abs);
      const payload = { file: abs, at: nowIso(), sha256: info.sha256, data: info.data };
      for (const fn of Array.from(entry.subscribers)) { try { fn(payload); } catch { /* 单个订阅异常不影响其它订阅 */ } }
    };
    entry.watcher = fs.watch(path.dirname(abs), { persistent: false }, (_event, name) => {
      if (name && path.resolve(path.dirname(abs), String(name)) !== abs) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(fire, entry.debounceMs);
      if (entry.timer.unref) entry.timer.unref();
    });
    entry.watcher.unref && entry.watcher.unref();
    watchers.set(abs, entry);
  }
  entry.subscribers.add(cb);
  return function unsubscribe() {
    entry.subscribers.delete(cb);
    if (entry.subscribers.size) return;
    if (entry.timer) clearTimeout(entry.timer);
    try { entry.watcher.close(); } catch { /* */ }
    watchers.delete(abs);
  };
}

module.exports = {
  AtomicError,
  LOCK_STALE_MS,
  WATCH_DEBOUNCE_MS,
  nowMs,
  sha256,
  isAllowedPath,
  readJsonSafe,
  writeJsonAtomic,
  updateJsonAtomic,
  watchJson,
  // 供测试用的内部入口（生产代码只应使用上面五个公开函数）
  __internals: { acquireLock, acquireLockWithRetry, releaseLock, readLock, lockPathOf, auditPathFor, appendAudit, writeJsonAtomicRaw, atomicWriteRaw },
};
