// 团队工作台 v2 · 核心工具（路径 / 哈希 / 锁 / 事件链 / 日志）
// 设计原则：锁只防同时写；版本靠哈希 CAS；所有状态可复验。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = path.resolve(HERE, '..', '..', '..');
export const TEAM_ROOT = process.env.TEAM_ROOT
  ? path.resolve(process.env.TEAM_ROOT)
  : path.join(WORKSPACE, '团队');
export const PROJECTS_ROOT = process.env.TEAM_PROJECTS_ROOT
  ? path.resolve(process.env.TEAM_PROJECTS_ROOT)
  : path.join(WORKSPACE, '项目');

export const PATHS = {
  teamRoot: TEAM_ROOT,
  workspace: WORKSPACE,
  state: path.join(TEAM_ROOT, '状态'),
  team: path.join(TEAM_ROOT, '状态', '团队.json'),
  events: path.join(TEAM_ROOT, '状态', '事件.jsonl'),
  reads: path.join(TEAM_ROOT, '状态', '阅读.jsonl'),
  receipts: path.join(TEAM_ROOT, '状态', '回执.jsonl'),
  locks: path.join(TEAM_ROOT, '状态', '锁'),
  boots: path.join(TEAM_ROOT, '状态', '启动'),
  mail: path.join(TEAM_ROOT, '状态', '邮箱'),
  grants: path.join(TEAM_ROOT, '状态', '授权'),
  logs: path.join(TEAM_ROOT, '日志'),
  roles: path.join(TEAM_ROOT, '角色'),
  templates: path.join(TEAM_ROOT, '模板'),
  docs: TEAM_ROOT,
  projects: PROJECTS_ROOT,
  projectState: path.join(TEAM_ROOT, '状态', '项目'),
  dashboard: path.join(TEAM_ROOT, '状态', '看板.md'),
};

export class TeamError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TeamError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details = {}) {
  throw new TeamError(code, message, details);
}

export function nowIso() {
  return new Date().toISOString();
}

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function hashFile(file) {
  return sha256(fs.readFileSync(file));
}

export function shortHash(h, n = 12) {
  return String(h || '').slice(0, n);
}

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function readText(p, fallback = null) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== null) return fallback;
    throw e;
  }
}

export function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== null) return fallback;
    if (e instanceof SyntaxError) fail('BAD_JSON', `JSON 解析失败：${p}`, { path: p, cause: e.message });
    throw e;
  }
}

export function writeText(p, text) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, p);
  } catch {
    fs.copyFileSync(tmp, p);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
  return p;
}

export function writeJson(p, obj) {
  return writeText(p, JSON.stringify(obj, null, 2) + '\n');
}

export function appendLine(p, line) {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, line.endsWith('\n') ? line : line + '\n', 'utf8');
}

export function readJsonl(p) {
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s) continue;
    out.push(JSON.parse(s));
  }
  return out;
}

export function readJsonlTolerant(p) {
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { items: [], errors: [] };
    throw e;
  }
  const items = [];
  const errors = [];
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s) continue;
    try { items.push(JSON.parse(s)); } catch (e) { errors.push({ line: s.slice(0, 120), error: e.message }); }
  }
  return { items, errors };
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      let value = true;
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i++;
      }
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        if (!Array.isArray(out[key])) out[key] = [out[key]];
        out[key].push(value);
      } else {
        out[key] = value;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

export function asArray(v) {
  if (v === undefined || v === null || v === false) return [];
  return Array.isArray(v) ? v : [v];
}

export function slug(s, max = 80) {
  const cleaned = String(s).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').replace(/^_+|_+$/g, '');
  const base = cleaned || 'x';
  return base.length <= max ? base : base.slice(0, max - 9) + '-' + sha256(base).slice(0, 8);
}

export function safeName(s) {
  const name = String(s || '').trim();
  if (!name || name === '.' || name === '..') fail('BAD_NAME', '名称不能为空或 . / ..');
  if (/[\\/:*?"<>|]/.test(name)) fail('BAD_NAME', `名称含 Windows 非法字符：${name}`);
  if (name.length > 60) fail('BAD_NAME', '名称超过 60 字符');
  return name;
}

export function isInside(parent, child) {
  const p = path.resolve(parent).toLowerCase();
  const c = path.resolve(child).toLowerCase();
  return c === p || c.startsWith(p + path.sep);
}

export function relPath(parent, child) {
  return path.relative(parent, child).replace(/\\/g, '/');
}

export function globToRegExp(glob) {
  const g = String(glob).replace(/\\/g, '/');
  let re = '^';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$+?.()|{}[]'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  re += '$';
  return new RegExp(re, 'i');
}

export function scopeMatches(scope, rel) {
  const r = String(rel).replace(/\\/g, '/');
  return globToRegExp(scope).test(r);
}

export function truncate(s, n) {
  const str = String(s ?? '');
  return str.length <= n ? str : str.slice(0, n - 1) + '…';
}

export function randomHex(n = 4) {
  return crypto.randomBytes(n).toString('hex');
}

export function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function hhmmss(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '').slice(11, 19);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function dayKey(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------- 锁：目录原子创建；TTL + PID 判活；只防同时写 ----------

function lockDir(key) {
  return path.join(PATHS.locks, slug(key, 90) + '.lock');
}

function pidAlive(pid) {
  if (!pid || Number.isNaN(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function lockIsStale(owner) {
  if (!owner || typeof owner !== 'object') return true;
  const exp = Date.parse(owner.expiresAt || '');
  // CLI 加锁的进程会立刻退出，不能用 PID 判活；锁只认 TTL + 显式释放。
  if (!Number.isNaN(exp) && Date.now() > exp + 5000) return true;
  return false;
}

export function acquireLock(key, opts = {}) {
  ensureDir(PATHS.locks);
  const dir = lockDir(key);
  const ttlMs = Number(opts.ttlMs || 60000);
  const waitMs = Number(opts.waitMs ?? 0);
  const owner = {
    key,
    owner: opts.owner || opts.role || 'unknown',
    role: opts.role || null,
    sessionId: opts.sessionId || null,
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: nowIso(),
    heartbeatAt: nowIso(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    reason: truncate(opts.reason || '', 120),
  };
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(owner, null, 2), 'utf8');
      return owner;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const cur = readJson(path.join(dir, 'owner.json'), null);
      if (lockIsStale(cur)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* race */ }
        continue;
      }
      if (Date.now() >= deadline) {
        fail('LOCK_BUSY', `锁被占用：${key}`, { key, holder: cur, lock: dir });
      }
      sleep(100);
    }
  }
}

export function heartbeatLock(key, opts = {}) {
  const dir = lockDir(key);
  const cur = readJson(path.join(dir, 'owner.json'), null);
  if (!cur) fail('LOCK_MISSING', `锁不存在：${key}`, { key });
  if (opts.role && cur.role !== opts.role) fail('LOCK_NOT_OWNER', `不是锁主：${key}`, { key, holder: cur });
  const ttlMs = Number(opts.ttlMs || 60000);
  cur.heartbeatAt = nowIso();
  cur.expiresAt = new Date(Date.now() + ttlMs).toISOString();
  writeJson(path.join(dir, 'owner.json'), cur);
  return cur;
}

export function releaseLock(key, opts = {}) {
  const dir = lockDir(key);
  const cur = readJson(path.join(dir, 'owner.json'), null);
  if (!cur) return false;
  if (opts.role && cur.role !== opts.role) fail('LOCK_NOT_OWNER', `不是锁主，不能释放：${key}`, { key, holder: cur });
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export function lockInfo(key) {
  const dir = lockDir(key);
  const cur = readJson(path.join(dir, 'owner.json'), null);
  if (!cur) return null;
  return { ...cur, stale: lockIsStale(cur), dir };
}

export function listLocks() {
  if (!exists(PATHS.locks)) return [];
  const out = [];
  for (const name of fs.readdirSync(PATHS.locks)) {
    if (!name.endsWith('.lock')) continue;
    const dir = path.join(PATHS.locks, name);
    const cur = readJson(path.join(dir, 'owner.json'), null);
    out.push(cur ? { ...cur, stale: lockIsStale(cur), dir } : { key: name, broken: true, dir, stale: true });
  }
  return out;
}

export function withLock(key, opts, fn) {
  const owner = acquireLock(key, opts);
  try {
    return fn(owner);
  } finally {
    try { releaseLock(key, { role: opts.role }); } catch { /* keep original error */ }
  }
}

// ---------- 事件链：seq + prev + hash，防悄悄改历史 ----------

export function lastEvent() {
  let text;
  try {
    text = fs.readFileSync(PATHS.events, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const lines = text.split(/\r?\n/).filter((s) => s.trim());
  if (!lines.length) return null;
  return JSON.parse(lines[lines.length - 1]);
}

function makeEventBody(ev, seq, prev) {
  return {
    seq,
    ts: ev.ts || nowIso(),
    actor: ev.actor || ev.role || 'system',
    role: ev.role || 'system',
    sessionId: ev.sessionId || '',
    action: ev.action || 'unknown',
    project: ev.project || '',
    target: ev.target || '',
    result: ev.result || 'ok',
    note: truncate(ev.note || '', Number(ev.noteMax || 300)),
    data: ev.data ?? null,
    prev: prev || 'GENESIS',
  };
}

export function appendEvent(ev) {
  const owner = acquireLock('_events', {
    role: 'system',
    sessionId: 'system',
    ttlMs: 15000,
    waitMs: 5000,
    reason: 'append event',
  });
  try {
    const last = lastEvent();
    const seq = Number(last?.seq || 0) + 1;
    const body = makeEventBody(ev, seq, last?.hash || 'GENESIS');
    const hash = sha256(JSON.stringify(body));
    appendLine(PATHS.events, JSON.stringify({ ...body, hash }));
    appendHumanLog(body);
    return { ...body, hash };
  } finally {
    releaseLock('_events', { role: 'system' });
  }
}

export function readEventsStrict() {
  const { items, errors } = readJsonlTolerant(PATHS.events);
  return { items, errors };
}

export function verifyEventChain() {
  const { items, errors } = readEventsStrict();
  const problems = [];
  for (const e of errors) problems.push({ type: 'BAD_LINE', ...e });
  let prev = 'GENESIS';
  let expected = 1;
  for (const e of items) {
    if (e.seq !== expected) problems.push({ type: 'SEQ', seq: e.seq, expected });
    if (e.prev !== prev) problems.push({ type: 'PREV', seq: e.seq, got: e.prev, expected: prev });
    const body = makeEventBody(e, e.seq, e.prev);
    const hash = sha256(JSON.stringify(body));
    if (hash !== e.hash) problems.push({ type: 'HASH', seq: e.seq, got: e.hash, expected: hash });
    prev = e.hash;
    expected++;
  }
  return { ok: problems.length === 0, count: items.length, problems };
}

export function appendHumanLog(body) {
  const day = dayKey(new Date(body.ts));
  const file = path.join(PATHS.logs, `${day}.md`);
  ensureDir(PATHS.logs);
  if (!exists(file)) {
    fs.writeFileSync(file, `# 团队操作日志 · ${day}\n\n`, 'utf8');
  }
  const line = `- ${hhmmss(body.ts)} [${body.role}] ${body.action} ${body.target ? '· ' + truncate(body.target, 80) : ''} — ${truncate(body.note, 160)}\n`;
  fs.appendFileSync(file, line, 'utf8');
}

export function jsonOut(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

export function textOut(s) {
  process.stdout.write(s.endsWith('\n') ? s : s + '\n');
}
