'use strict';
/**
 * R-20261121-124427-bcac：存储位置可配置 + 占用保护（纯 Node，可单测；壳层只做 IPC/对话框）
 *
 * 生效优先级：env(AWB_DATA_DIR/AWB_TMP_ROOT) > 设置（workbench.json.settings.storage）> 默认安装盘。
 * 系统盘保护：resolve 后取 path.parse().root，与 %SystemDrive% 根比较；命中 → STORAGE_SYSTEM_DRIVE_REFUSED，不保存。
 * 上限：8GB / 200000 文件（可被 settings.storage.limits 覆盖）；超限先清 mtime>60min 的沙盘子目录，仍超 → STORAGE_LIMIT_EXCEEDED。
 * 清理：只删 tmpDir 顶层、匹配 `<name>-XXXXXX` 的目录；不删顶层散文件、不递归用户目录。审计写 <dataDir>/存储清理.jsonl。
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const D_DRIVE = String.fromCharCode(68) + ':';
const DEFAULT_ROOT = D_DRIVE + '\\\\awb-sandbox';
const DEFAULT_LIMITS = { maxBytes: 8 * 1024 * 1024 * 1024, maxFiles: 200000, staleMinutes: 60 };
const SANDBOX_DIR_RE = /^[^\\/]+-[A-Za-z0-9]{6,}$/;

function systemDriveRoot() {
  const raw = String(process.env.SystemDrive || 'C:').trim();
  return path.parse(path.resolve(raw + '\\')).root;
}
function isSystemDrivePath(target) {
  try { return path.parse(path.resolve(String(target || ''))).root.toLowerCase() === systemDriveRoot().toLowerCase(); } catch { return false; }
}
function installDriveRoot() { return path.parse(ROOT).root; }
function defaults() {
  return { dataDir: path.join(ROOT, 'data'), tmpDir: DEFAULT_ROOT + '\\tmp', limits: { ...DEFAULT_LIMITS } };
}
function settingsFile(dataDir) { return path.join(dataDir, 'userdata', 'workbench.json'); }
function readStore(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 解析当前生效配置（不写盘）。 */
function resolveStorage({ env = process.env, dataDir = '', storeFile = '' } = {}) {
  const def = defaults();
  let store = null;
  const storePath = storeFile || settingsFile(dataDir || def.dataDir);
  store = readStore(storePath);
  const settings = (store && store.settings && store.settings.storage) || {};
  const resolved = {
    dataDir: String(env.AWB_DATA_DIR || settings.dataDir || def.dataDir),
    tmpDir: String(env.AWB_TMP_ROOT || settings.tmpDir || def.tmpDir),
    limits: { ...def.limits, ...(settings.limits && typeof settings.limits === 'object' ? settings.limits : {}) },
    source: {
      dataDir: env.AWB_DATA_DIR ? 'env' : (settings.dataDir ? 'settings' : 'default'),
      tmpDir: env.AWB_TMP_ROOT ? 'env' : (settings.tmpDir ? 'settings' : 'default'),
    },
  };
  return resolved;
}

/** 校验并持久化设置；失败不保存、不影响旧设置。 */
function saveStorage(input = {}, { dataDir = '', storeFile = '' } = {}) {
  const def = defaults();
  const targetDataDir = String(input.dataDir || '').trim() || def.dataDir;
  const targetTmpDir = String(input.tmpDir || '').trim() || def.tmpDir;
  if (!String(input.dataDir || '').trim() && !String(input.tmpDir || '').trim()) {
    return { ok: false, code: 'STORAGE_PATH_EMPTY', message: '存储位置为空：已回落到默认安装盘路径', echoed: { dataDir: targetDataDir, tmpDir: targetTmpDir } };
  }
  if (isSystemDrivePath(targetTmpDir)) {
    return { ok: false, code: 'STORAGE_SYSTEM_DRIVE_REFUSED', message: '禁止落系统盘（' + systemDriveRoot() + '）：请改到安装盘（' + installDriveRoot() + '）或安装根内路径', path: targetTmpDir };
  }
  const dataFile = storeFile || settingsFile(dataDir || def.dataDir);
  try {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    const store = readStore(dataFile) || { version: 1, projects: [], ui: {} };
    store.settings = store.settings && typeof store.settings === 'object' ? store.settings : {};
    store.settings.storage = {
      ...(store.settings.storage || {}),
      dataDir: targetDataDir,
      tmpDir: targetTmpDir,
      updatedAt: new Date().toISOString(),
      ...(input.limits && typeof input.limits === 'object' ? { limits: { ...(store.settings.storage || {}).limits, ...input.limits } } : {}),
    };
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + String.fromCharCode(10), 'utf8');
    fs.renameSync(tmp, dataFile);
    return { ok: true, code: 'STORAGE_SAVED', settings: store.settings.storage };
  } catch (error) {
    return { ok: false, code: 'STORAGE_SAVE_FAILED', message: String((error && error.message) || error).slice(0, 200) };
  }
}

/** 统计目录体积/文件数/沙盘子目录数（跳过符号链接）。 */
function measureDir(dir) {
  let bytes = 0; let files = 0; let sandboxes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      try {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { if (path.dirname(full) === dir && SANDBOX_DIR_RE.test(entry.name)) sandboxes += 1; stack.push(full); continue; }
        const st = fs.statSync(full);
        bytes += st.size; files += 1;
      } catch { /* 单个失败忽略 */ }
    }
  }
  return { bytes, files, sandboxes };
}

function auditClean(dataDir, row) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(path.join(dataDir, '存储清理.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + String.fromCharCode(10), 'utf8');
  } catch { /* 审计失败不阻断 */ }
}

/** 清理 tmpDir 顶层过期沙盘（或全部），返回释放量并写审计。 */
function cleanSandboxes({ tmpDir, dataDir, minutes = DEFAULT_LIMITS.staleMinutes, all = false, reason = 'prune' } = {}) {
  const root = path.resolve(String(tmpDir || defaults().tmpDir));
  const now = Date.now();
  const removed = []; const failed = []; let freedBytes = 0;
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { names = []; }
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    if (!SANDBOX_DIR_RE.test(entry.name)) continue;
    const full = path.join(root, entry.name);
    try {
      const st = fs.statSync(full);
      const stale = now - st.mtimeMs > minutes * 60000;
      if (!all && !stale) continue;
      const m = measureDir(full);
      fs.rmSync(full, { recursive: true, force: true });
      if (!fs.existsSync(full)) { removed.push(entry.name); freedBytes += m.bytes; }
    } catch { failed.push(entry.name); }
  }
  const row = { root, removed: removed.length, failed: failed.length, freedBytes, reason, minutes: all ? 'all' : minutes, removedNames: removed.slice(0, 50) };
  if (dataDir) auditClean(path.resolve(dataDir), row);
  return { ok: true, ...row, at: new Date().toISOString() };
}

/** 启动前守卫：超限先清过期，仍超拒绝；返回状态（不抛）。 */
function ensureStorageCapacity({ config, dataDir } = {}) {
  const cfg = config || resolveStorage({});
  const tmpDir = path.resolve(cfg.tmpDir);
  const data = dataDir || cfg.dataDir;
  const before = measureDir(tmpDir);
  const limits = cfg.limits || DEFAULT_LIMITS;
  let cleaned = null;
  let after = before;
  if (before.bytes > limits.maxBytes || before.files > limits.maxFiles) {
    cleaned = cleanSandboxes({ tmpDir, dataDir: data, minutes: limits.staleMinutes, reason: 'auto-over-limit' });
    after = measureDir(tmpDir);
  }
  const over = after.bytes > limits.maxBytes || after.files > limits.maxFiles;
  return {
    ok: !over,
    code: over ? 'STORAGE_LIMIT_EXCEEDED' : 'STORAGE_OK',
    tmpDir,
    dataDir: data,
    limits,
    before,
    after,
    cleaned,
    usage: { bytes: after.bytes, files: after.files, sandboxes: after.sandboxes, ratio: limits.maxBytes ? Math.min(1, after.bytes / limits.maxBytes) : 0 },
    message: over ? '临时沙盘超限（' + (after.bytes / 1024 / 1024 / 1024).toFixed(2) + 'GB / ' + after.files + ' 文件）：已清理过期沙盘仍超，请改存储位置或一键清理' : '',
  };
}

/** 设置页/CLI 统一状态。 */
function storageStatus({ config, dataDir } = {}) {
  const cfg = config || resolveStorage({});
  const guard = ensureStorageCapacity({ config: cfg, dataDir });
  let lastCleanup = null;
  try {
    const lines = fs.readFileSync(path.join(cfg.dataDir, '存储清理.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean);
    if (lines.length) lastCleanup = JSON.parse(lines[lines.length - 1]);
  } catch { /* 无审计 */ }
  return { ok: true, settings: cfg, guard, lastCleanup };
}

module.exports = { DEFAULT_ROOT, DEFAULT_LIMITS, SANDBOX_DIR_RE, systemDriveRoot, installDriveRoot, isSystemDrivePath, defaults, resolveStorage, saveStorage, measureDir, cleanSandboxes, ensureStorageCapacity, storageStatus };
