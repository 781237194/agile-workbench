#!/usr/bin/env node
'use strict';
// R-eca0 F0/F2-F6：桌面取证 CLI（纯 CLI，一次调用一个进程）。
// 唯一原生入口 = src/native/win32-capture（BitBlt 取像素，只读）；本脚本只做鉴权/落盘/审计/限频/清理。
//
// 用法：
//   node scripts/capture-desktop.cjs --boot <令牌> --project <项目> --mode <fullscreen|window> --reason <文本>
//        [--window <标题片段>] [--keep] [--json] [--rect x,y,w,h]
//   node scripts/capture-desktop.cjs --boot <令牌> --project <项目> --clean [--json]
//
// 退出码：0 成功 / 1 判据不满足（禁止、限频、未就绪、抓屏失败）/ 2 环境或参数错误。
// 环境变量：AWB_CAPTURE_DIR（证据目录覆盖，必须以 D:\ 开头）、TEAM_ROOT（团队状态根，沙盘用）。

const fs = require('node:fs');
const path = require('node:path');

const captureLib = require('../src/native/win32-capture.cjs');

const EXIT_OK = 0;
const EXIT_DENIED = 1;
const EXIT_ENV = 2;

const ROLES_ALLOWED = ['pm', 'tester'];
const DEFAULT_CAPTURE_DIR = 'D:\\awb-evidence\\desktop-capture';
const SHELL_CACHE_DIR = null; // 预留：本脚本不缓存任何东西
const AUDIT_FILE = '桌面取证.jsonl';
const LOCK_FILE = '.capture.lock';
const STATE_FILE = '.capture.state.json';
const INFLIGHT_PREFIX = '.capture.inflight.';
const LOCK_STALE_MS = 30000;
const RATE_WINDOW_MS = 1000;
const MAX_INFLIGHT = 8;
const KEEP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const NAME_RE = /^awb-capture-(\d{8})-(\d{6})-(\d{3})\.png$/;
const HEX_RE = /^[0-9a-f]{16,64}$/i;
const PROJECT_RE = /^[^\\/:*?"<>|]+$/;

const EXIT_ENV_CODES = new Set([
  'CAPTURE_REASON_REQUIRED',
  'CAPTURE_MODE_REQUIRED',
  'CAPTURE_MODE_INVALID',
  'CAPTURE_WINDOW_REQUIRED',
  'CAPTURE_ARGS_INVALID',
  'CAPTURE_DIR_FORBIDDEN',
  'CAPTURE_PROJECT_NOT_FOUND',
  'CAPTURE_DISK_FULL',
  'CAPTURE_IO_ERROR',
  'BOOT_REQUIRED',
  'BOOT_INVALID',
  'BOOT_PROJECT_MISMATCH',
]);

// ---------------- 基础工具 ----------------
function nowIso() {
  return new Date().toISOString();
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/** 文件名时间戳：本地时间 awb-capture-<YYYYMMDD-HHmmss-SSS>.png 里的 <YYYYMMDD-HHmmss-SSS> */
function stampName(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}

/** 从文件名解析毫秒时间（本地时区）；非法返回 null */
function stampMsOf(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, ymd, hms, ms] = m;
  const y = Number(ymd.slice(0, 4));
  const mo = Number(ymd.slice(4, 6)) - 1;
  const d = Number(ymd.slice(6, 8));
  const h = Number(hms.slice(0, 2));
  const mi = Number(hms.slice(2, 4));
  const s = Number(hms.slice(4, 6));
  const t = new Date(y, mo, d, h, mi, s, Number(ms)).getTime();
  return Number.isFinite(t) ? t : null;
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function appendAudit(auditPath, row) {
  // 审计固定 6 键，顺序稳定，append-only
  const line = JSON.stringify({
    at: row.at,
    window: row.window,
    reason: row.reason,
    bytes: row.bytes,
    sha256: row.sha256,
    kept: row.kept,
  });
  fs.appendFileSync(auditPath, line + '\n');
}

function readState(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, STATE_FILE), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function writeState(dir, obj) {
  const target = path.join(dir, STATE_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...obj, updatedAt: nowIso() }));
  fs.renameSync(tmp, target);
}

function countInflight(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.startsWith(INFLIGHT_PREFIX)).length;
  } catch {
    return 0;
  }
}

function makeResult({ ok, mode = '', p = '', bytes = 0, sha256 = '', ms = 0, kept = false, code = 'OK', warmupMs = 0, title = '', extra = null }) {
  const out = { ok, mode, path: p, bytes, sha256, ms, kept, code, warmupMs };
  if (title) out.title = title;
  if (extra) Object.assign(out, extra);
  return out;
}

function printResult(result, opts) {
  if (opts.json) {
    // --json：stdout 恰好一行
    process.stdout.write(JSON.stringify({
      ok: result.ok,
      mode: result.mode,
      path: result.path,
      bytes: result.bytes,
      sha256: result.sha256,
      ms: result.ms,
      kept: result.kept,
      code: result.code,
      warmupMs: result.warmupMs,
      ...(result.deleted ? { deleted: result.deleted } : {}),
    }) + '\n');
    return;
  }
  const parts = [
    `ok=${result.ok}`,
    `code=${result.code}`,
    `mode=${result.mode}`,
    `path=${result.path || '-'}`,
    `bytes=${result.bytes}`,
    `sha256=${result.sha256 || '-'}`,
    `ms=${result.ms}`,
    `kept=${result.kept}`,
    `warmupMs=${result.warmupMs}`,
  ];
  if (result.deleted) parts.push(`deleted=${result.deleted.length}`);
  process.stdout.write(parts.join(' ') + '\n');
}

function exitCodeFor(code) {
  if (!code || code === 'OK') return EXIT_OK;
  return EXIT_ENV_CODES.has(code) ? EXIT_ENV : EXIT_DENIED;
}

// ---------------- 参数 ----------------
function parseArgs(argv) {
  const opts = {
    boot: '',
    project: '',
    mode: '',
    reason: '',
    window: '',
    keep: false,
    json: false,
    clean: false,
    help: false,
    rect: null,
  };
  const needValue = new Set(['boot', 'project', 'mode', 'reason', 'window', 'rect']);
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) return { error: `无法识别的参数：${raw}` };
    const body = raw.slice(2);
    const eq = body.indexOf('=');
    const key = eq >= 0 ? body.slice(0, eq) : body;
    let value = eq >= 0 ? body.slice(eq + 1) : null;
    if (needValue.has(key) && value == null) {
      value = argv[i + 1];
      if (value == null || value.startsWith('--')) return { error: `参数 --${key} 缺少值` };
      i += 1;
    }
    switch (key) {
      case 'boot': opts.boot = value; break;
      case 'project': opts.project = value; break;
      case 'mode': opts.mode = value; break;
      case 'reason': opts.reason = value; break;
      case 'window': opts.window = value; break;
      case 'rect': {
        const nums = String(value).split(',').map((n) => Number(n.trim()));
        if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) return { error: '参数 --rect 需要 x,y,w,h 四个数字' };
        opts.rect = nums;
        break;
      }
      case 'keep': opts.keep = true; break;
      case 'json': opts.json = true; break;
      case 'clean': opts.clean = true; break;
      case 'help': case 'h': opts.help = true; break;
      default: return { error: `无法识别的参数：--${key}` };
    }
  }
  return opts;
}

function usage() {
  return [
    'R-eca0 桌面取证 CLI（只读抓屏；仅 PM / 测试人员可用）',
    '',
    '抓屏：',
    '  node scripts/capture-desktop.cjs --boot <令牌> --project <项目> --mode <fullscreen|window> --reason <文本>',
    '       [--window <标题片段>] [--keep] [--json] [--rect x,y,w,h]',
    '清理（>7 天）：',
    '  node scripts/capture-desktop.cjs --boot <令牌> --project <项目> --clean [--json]',
    '',
    '退出码：0 成功 / 1 判据不满足 / 2 环境或参数错误',
    '证据目录：默认 D:\\awb-evidence\\desktop-capture（AWB_CAPTURE_DIR 覆盖，必须以 D:\\ 开头）',
    '审计：团队/状态/项目/<项目>/桌面取证.jsonl（固定 6 键 at/window/reason/bytes/sha256/kept）',
  ].join('\n');
}

// ---------------- 路径 / 鉴权 ----------------
function repoRootDir() {
  return path.resolve(__dirname, '..');
}

function teamRootDir() {
  const env = String(process.env.TEAM_ROOT || '').trim();
  return env ? path.resolve(env) : path.join(repoRootDir(), '团队');
}

function resolveCaptureDir() {
  const raw = String(process.env.AWB_CAPTURE_DIR || '').trim() || DEFAULT_CAPTURE_DIR;
  const forbidden = () => ({ ok: false, code: 'CAPTURE_DIR_FORBIDDEN', dir: raw });
  if (raw.includes('..')) return forbidden();
  if (!/^[dD]:[\\/]/.test(raw)) return forbidden();
  const resolved = path.resolve(raw);
  if (!/^[dD]:[\\/]/.test(resolved)) return forbidden();
  return { ok: true, dir: resolved };
}

function readBootToken(token) {
  if (!token) return { ok: false, code: 'BOOT_REQUIRED' };
  if (!HEX_RE.test(token)) return { ok: false, code: 'BOOT_INVALID' };
  const file = path.join(teamRootDir(), '状态', '启动', `${token}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || !data.role) return { ok: false, code: 'BOOT_INVALID' };
    return { ok: true, role: String(data.role), project: String(data.project || ''), token };
  } catch {
    return { ok: false, code: 'BOOT_INVALID' };
  }
}

function projectStateDirOf(project) {
  return path.join(teamRootDir(), '状态', '项目', project);
}

// ---------------- 限频 / 并发 / 跨进程锁 ----------------
function acquireLock(dir) {
  const lockPath = path.join(dir, LOCK_FILE);
  const writeLock = () => {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: nowIso(), lastSuccessAt: null }));
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    writeLock();
    return { ok: true, path: lockPath };
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      // 陈旧锁（持锁进程崩溃）清理一次后重试
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          writeLock();
          return { ok: true, path: lockPath, stolen: true };
        }
      } catch {
        /* 竞争窗口：按被占用处理 */
      }
      return { ok: false, code: 'CAPTURE_RATE_LIMITED' };
    }
    throw e;
  }
}

function releaseLock(lock) {
  if (!lock || !lock.ok) return;
  try { fs.unlinkSync(lock.path); } catch { /* 已被清理 */ }
}

function markLockSuccess(lock) {
  if (!lock || !lock.ok) return;
  try {
    fs.writeFileSync(lock.path, JSON.stringify({ pid: process.pid, at: nowIso(), lastSuccessAt: Date.now() }));
  } catch { /* 锁文件已被并发清理 */ }
}

// ---------------- 抓屏 ----------------
function windowLabel(res, opts) {
  if (res && res.title) return res.title;
  if (opts.rect) return 'rect';
  return opts.mode === 'fullscreen' ? 'fullscreen' : 'window';
}

async function doCapture(opts, ctx) {
  const result = makeResult({ ok: false, mode: opts.mode, code: 'CAPTURE_ARGS_INVALID' });
  const setFail = (code) => {
    result.ok = false;
    result.code = code;
    return result;
  };

  const dirInfo = resolveCaptureDir();
  if (!dirInfo.ok) return setFail(dirInfo.code);
  const dir = dirInfo.dir;

  try {
    ensureDirSync(dir);
  } catch {
    return setFail('CAPTURE_IO_ERROR');
  }

  // 限频：1 秒内最多 1 次成功（按上次成功时间）
  const state = readState(dir);
  if (state.lastSuccessAt && Date.now() - Number(state.lastSuccessAt) < RATE_WINDOW_MS) {
    return setFail('CAPTURE_RATE_LIMITED');
  }

  // 并发：同时进行中的抓屏进程数 >8 直接拒
  const slot = path.join(dir, `${INFLIGHT_PREFIX}${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  let slotCreated = false;
  try {
    fs.writeFileSync(slot, String(process.pid));
    slotCreated = true;
  } catch {
    return setFail('CAPTURE_IO_ERROR');
  }

  let lock = null;
  let kept = false;
  let outPath = '';
  try {
    if (countInflight(dir) > MAX_INFLIGHT + 1) {
      // +1 是自己这条 slot；>8 个其它进程同时进行时拒绝
      return setFail('CAPTURE_RATE_LIMITED');
    }
    lock = acquireLock(dir);
    if (!lock.ok) return setFail(lock.code);

    // 拿锁后再核一次限频，避免并发窗口内双成功
    const state2 = readState(dir);
    if (state2.lastSuccessAt && Date.now() - Number(state2.lastSuccessAt) < RATE_WINDOW_MS) {
      return setFail('CAPTURE_RATE_LIMITED');
    }

    const outName = `awb-capture-${stampName()}.png`;
    outPath = path.join(dir, outName);
    const res = await captureLib.capture({
      mode: opts.mode,
      window: opts.window || '',
      rect: opts.rect,
      out: outPath,
    });

    if (!res.ok) {
      const code = res.code || 'CAPTURE_UNAVAILABLE';
      const warmupOnly = code === 'CAPTURE_NOT_READY';
      try {
        appendAudit(ctx.auditPath, {
          at: nowIso(),
          window: opts.mode === 'window' ? (opts.window || 'window') : 'fullscreen',
          reason: warmupOnly ? 'warmup' : 'error',
          bytes: '',
          sha256: '',
          kept: false,
        });
      } catch { /* 审计失败不掩盖抓屏失败码 */ }
      result.warmupMs = res.warmupMs || 0;
      result.ms = res.ms || 0;
      return setFail(code);
    }

    result.warmupMs = res.warmupMs || 0;
    result.ms = res.ms || 0;
    result.bytes = res.bytes;
    result.sha256 = res.sha256;
    result.w = res.w;
    result.h = res.h;
    const label = windowLabel(res, opts);

    // 预热审计行（成功/失败都记，AC4 统计不含它）
    try {
      appendAudit(ctx.auditPath, { at: nowIso(), window: label, reason: 'warmup', bytes: '', sha256: '', kept: false });
    } catch { /* 先继续，成功行失败会在下面暴露 */ }

    // 默认即用即删；--keep 保留
    kept = Boolean(opts.keep);
    if (!kept) {
      try {
        fs.unlinkSync(outPath);
      } catch {
        // 删不掉就如实记 kept:true（AC4 要求 kept 与磁盘一致）
        kept = true;
      }
    }

    appendAudit(ctx.auditPath, {
      at: nowIso(),
      window: label,
      reason: opts.reason,
      bytes: res.bytes,
      sha256: res.sha256,
      kept,
    });

    writeState(dir, { lastSuccessAt: Date.now(), lastSha256: res.sha256 });
    markLockSuccess(lock);

    result.ok = true;
    result.code = 'OK';
    result.path = outPath;
    result.kept = kept;
    return result;
  } catch (e) {
    return setFail(/ENOSPC/.test(String(e && e.message)) ? 'CAPTURE_DISK_FULL' : 'CAPTURE_IO_ERROR');
  } finally {
    releaseLock(lock);
    if (slotCreated) { try { fs.unlinkSync(slot); } catch { /* 已清理 */ } }
    if (!result.ok && outPath) {
      try { fs.unlinkSync(outPath); } catch { /* 不落半张图：尽力清理 */ }
    }
  }
}

async function doClean(opts, ctx) {
  const t0 = Date.now();
  const dirInfo = resolveCaptureDir();
  if (!dirInfo.ok) {
    return makeResult({ ok: false, code: dirInfo.code, mode: 'clean' });
  }
  const dir = dirInfo.dir;
  const result = makeResult({ ok: true, mode: 'clean', code: 'OK', p: dir });
  result.deleted = [];
  result.bytes = 0;
  if (!fs.existsSync(dir)) {
    result.ms = Date.now() - t0;
    return result;
  }
  const now = Date.now();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return makeResult({ ok: false, code: 'CAPTURE_IO_ERROR', mode: 'clean' });
  }
  for (const name of names) {
    const ts = stampMsOf(name);
    if (ts == null) continue;
    if (now - ts <= KEEP_DAYS * DAY_MS) continue;
    const full = path.join(dir, name);
    let size = 0;
    try {
      size = fs.statSync(full).size;
      fs.unlinkSync(full);
    } catch {
      continue;
    }
    result.deleted.push(name);
    result.bytes += size;
    try {
      appendAudit(ctx.auditPath, { at: nowIso(), window: name, reason: 'cleanup', bytes: '', sha256: '', kept: false });
    } catch { /* 继续清理其它文件 */ }
  }
  result.ms = Date.now() - t0;
  return result;
}

// ---------------- main ----------------
async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    const result = makeResult({ ok: false, code: 'CAPTURE_ARGS_INVALID' });
    printResult(result, { json: argv.includes('--json') });
    process.stderr.write(`参数错误：${opts.error}\n`);
    return EXIT_ENV;
  }
  if (opts.help) {
    process.stdout.write(usage() + '\n');
    return EXIT_OK;
  }

  // 必填校验（--clean 免 mode/reason）
  if (!opts.boot) return failFast('BOOT_REQUIRED', opts);
  if (!opts.project) {
    const r = makeResult({ ok: false, mode: opts.clean ? 'clean' : opts.mode, code: 'CAPTURE_PROJECT_NOT_FOUND' });
    printResult(r, opts);
    return EXIT_ENV;
  }
  if (!PROJECT_RE.test(opts.project)) return failFast('CAPTURE_ARGS_INVALID', opts);
  if (!opts.clean) {
    if (!opts.mode) return failFast('CAPTURE_MODE_REQUIRED', opts);
    if (!['fullscreen', 'window'].includes(opts.mode)) return failFast('CAPTURE_MODE_INVALID', opts);
    if (opts.mode === 'window' && !opts.window) return failFast('CAPTURE_WINDOW_REQUIRED', opts);
    if (!String(opts.reason || '').trim()) return failFast('CAPTURE_REASON_REQUIRED', opts);
  }

  // 项目状态目录必须存在（审计落点）
  const projectDir = projectStateDirOf(opts.project);
  if (!fs.existsSync(projectDir)) return failFast('CAPTURE_PROJECT_NOT_FOUND', opts);
  const auditPath = path.join(projectDir, AUDIT_FILE);
  const ctx = { project: opts.project, projectDir, auditPath };

  // 鉴权：用 boot 令牌解析角色，仅 pm/tester 放行
  const boot = readBootToken(opts.boot);
  if (!boot.ok) return failFast(boot.code, opts);
  if (boot.project && boot.project !== opts.project) return failFast('BOOT_PROJECT_MISMATCH', opts);
  if (!ROLES_ALLOWED.includes(boot.role)) {
    try {
      appendAudit(auditPath, {
        at: nowIso(),
        window: 'fullscreen',
        reason: 'forbidden',
        bytes: '',
        sha256: '',
        kept: false,
      });
    } catch { /* 审计失败也要拒绝 */ }
    const r = makeResult({ ok: false, mode: opts.clean ? 'clean' : (opts.mode || ''), code: 'CAPTURE_FORBIDDEN' });
    printResult(r, opts);
    process.stderr.write(`拒绝：角色 ${boot.role} 不在白名单（pm/tester）\n`);
    return EXIT_DENIED;
  }

  // 清理入口
  if (opts.clean) {
    const result = await doClean(opts, ctx);
    printResult(result, opts);
    return exitCodeFor(result.code);
  }

  const result = await doCapture(opts, ctx);
  printResult(result, opts);
  if (!result.ok) process.stderr.write(`抓屏失败：${result.code}\n`);
  return exitCodeFor(result.code);
}

function failFast(code, opts) {
  const result = makeResult({ ok: false, mode: opts.clean ? 'clean' : (opts.mode || ''), code });
  printResult(result, opts);
  process.stderr.write(`参数/环境错误：${code}\n`);
  return EXIT_ENV;
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    process.stderr.write(`内部错误：${e && e.message}\n`);
    process.exitCode = EXIT_ENV;
  });

module.exports = { stampName, stampMsOf, resolveCaptureDir, readBootToken, parseArgs };
