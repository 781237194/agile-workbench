'use strict';
/**
 * T-20261121-124254-740a：沙盘写盘治理（程序拦，不靠纪律）
 *
 * 能力：
 *  - guard(): 单沙盘根（默认 <repo>/_tmp/sandboxes，或 AWB_SANDBOX_ROOT）；启动前统计体积/文件数，
 *    超 8GB 或 20 万文件直接抛 SANDBOX_LIMIT_EXCEEDED（附 prune 提示）；超限绝不创建新沙盘。
 *  - acquire(name): guard → 过期清扫（mtime>60min，两行审计）→ mkdtemp；返回路径；
 *  - exit/SIGINT/SIGTERM 自动删除（AWB_KEEP_SANDBOX=1 保留并打印路径）；
 *  - pruneStale(): 回收上次强杀残留（审计两行：candidates / done）。
 *
 * 环境变量（测试可注入）：AWB_SANDBOX_ROOT、AWB_SANDBOX_MAX_BYTES、AWB_SANDBOX_MAX_FILES、AWB_SANDBOX_STALE_MS。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULTS = {
  root: process.env.AWB_SANDBOX_ROOT || path.join(ROOT, '_tmp', 'sandboxes'),
  maxBytes: Number(process.env.AWB_SANDBOX_MAX_BYTES) > 0 ? Number(process.env.AWB_SANDBOX_MAX_BYTES) : 8 * 1024 * 1024 * 1024,
  maxFiles: Number(process.env.AWB_SANDBOX_MAX_FILES) > 0 ? Number(process.env.AWB_SANDBOX_MAX_FILES) : 200000,
  staleMs: Number(process.env.AWB_SANDBOX_STALE_MS) > 0 ? Number(process.env.AWB_SANDBOX_STALE_MS) : 60 * 60 * 1000,
};

function auditFile(root) {
  return path.join(root, '..', '沙盘审计.jsonl');
}
function appendAudit(root, row) {
  try {
    const file = auditFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...row }) + String.fromCharCode(10), 'utf8');
  } catch { /* 审计失败不阻断主流程 */ }
}

/** 统计 root 下总体积/文件数（深度优先、不跟随符号链接）。 */
function measure(root) {
  let bytes = 0;
  let files = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { stack.push(full); continue; }
        const st = fs.statSync(full);
        bytes += st.size;
        files += 1;
      } catch { /* 单个失败忽略 */ }
    }
  }
  return { bytes, files };
}

/** 超限即抛错（不创建任何目录）。 */
function guard(options = {}) {
  const root = options.root || DEFAULTS.root;
  const maxBytes = options.maxBytes || DEFAULTS.maxBytes;
  const maxFiles = options.maxFiles || DEFAULTS.maxFiles;
  fs.mkdirSync(root, { recursive: true });
  const { bytes, files } = measure(root);
  const over = bytes > maxBytes || files > maxFiles;
  appendAudit(root, {
    event: 'sandbox_guard',
    ok: !over,
    bytes,
    files,
    maxBytes,
    maxFiles,
    hint: over ? '超限：先执行 node 团队/工具/team.mjs tmp prune --yes（或手动清理 _tmp/sandboxes）' : '',
  });
  if (over) {
    const error = new Error(`沙盘超限：${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB / ${files} 文件（上限 ${(maxBytes / 1024 / 1024 / 1024).toFixed(2)}GB / ${maxFiles}）。先执行 node 团队/工具/team.mjs tmp prune --yes，或设 AWB_KEEP_SANDBOX=1 保留并用 --keep 点名。`);
    error.code = 'SANDBOX_LIMIT_EXCEEDED';
    error.details = { bytes, files, maxBytes, maxFiles };
    throw error;
  }
  return { root, bytes, files };
}

/** 回收上次强杀残留（mtime > staleMs），写两行审计。 */
function pruneStale(options = {}) {
  const root = options.root || DEFAULTS.root;
  const staleMs = options.staleMs || DEFAULTS.staleMs;
  fs.mkdirSync(root, { recursive: true });
  const now = Date.now();
  const candidates = [];
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    try {
      const st = fs.statSync(full);
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs > staleMs) candidates.push(full);
    } catch { /* ignore */ }
  }
  appendAudit(root, { event: 'sandbox_prune', candidates: candidates.map((p) => path.basename(p)), staleMs });
  let removed = 0;
  let failed = 0;
  for (const dir of candidates) {
    try { fs.rmSync(dir, { recursive: true, force: true }); removed += 1; } catch { failed += 1; }
  }
  appendAudit(root, { event: 'sandbox_prune_done', removed, failed });
  return { candidates: candidates.length, removed, failed };
}

const live = new Set();
let installed = false;
function cleanupAll() {
  if (String(process.env.AWB_KEEP_SANDBOX || '') === '1') {
    for (const dir of live) { try { console.log('[sandbox] kept ' + dir); } catch { /* ignore */ } }
    return;
  }
  for (const dir of live) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  live.clear();
}
function installCleanup() {
  if (installed) return;
  installed = true;
  process.on('exit', cleanupAll);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    try { process.on(sig, () => { cleanupAll(); process.exit(sig === 'SIGINT' ? 130 : 143); }); } catch { /* ignore */ }
  }
}

function acquire(name = 'sb', options = {}) {
  const root = options.root || DEFAULTS.root;
  guard({ ...options, root });
  const pruned = pruneStale({ ...options, root });
  installCleanup();
  const dir = fs.mkdtempSync(path.join(root, String(name).replace(/[^\w.-]+/g, '_') + '-'));
  live.add(dir);
  return { dir, pruned };
}

function release(dir) {
  live.delete(dir);
  if (String(process.env.AWB_KEEP_SANDBOX || '') === '1') { try { console.log('[sandbox] kept ' + dir); } catch { /* ignore */ } return; }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

module.exports = { DEFAULTS, measure, guard, pruneStale, acquire, release, cleanupAll, auditFile };
