#!/usr/bin/env node
/**
 * 30d8 清理 DSH 死工作区（测试沙盘残留）
 *
 * 背景：UI/沙盘测试拉起工作台/DSH 时若未隔离 DSH_HOME，会把 _tmp 沙盘目录注册进真实
 * `~/.dsh/storages/workspace.json`；沙盘目录被清理后，DSH「工作区」列表一直留着死条目。
 *
 * 口径（写死）：
 *   ① 默认 dry-run：只打印将被删除的条目，零写入；
 *   ② `--yes` 才写：写前把 workspace.json 备份到 `_backup/workspace.json.bak-<ts>`（`--backup-dir` 可覆盖），
 *      再 tmp+rename 原子落盘；
 *   ③ 只删「path 不存在 **且** 位于 `_tmp/` 下」的条目（真死工作区）；其它条目一律不动；
 *   ④ 默认工作区（global.defaultWorkspaceId）若是死条目 → 拒绝删除并报 `DEFAULT_WORKSPACE_DEAD`（交人工处理）；
 *   ⑤ 目录不存在 / JSON 损坏 → 结构化错误码，零写入。
 *
 * 用法：
 *   node scripts/clean-workspaces.cjs                    # dry-run（默认）
 *   node scripts/clean-workspaces.cjs --dead-only        # 同默认语义（显式写法）
 *   node scripts/clean-workspaces.cjs --yes              # 真删（写前备份）
 *   node scripts/clean-workspaces.cjs --home <dir>       # 指定 DSH_HOME（缺省 DSH_HOME || ~/.dsh）
 *   node scripts/clean-workspaces.cjs --json
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');

function argOf(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const jsonOut = process.argv.includes('--json');
const yes = process.argv.includes('--yes');
const deadOnly = process.argv.includes('--dead-only'); // 语义别名：本脚本本来就只处理 _tmp 死条目
const home = path.resolve(argOf('--home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh')));
const file = path.join(home, 'storages', 'workspace.json');
const backupDir = path.resolve(argOf('--backup-dir', path.join(ROOT, '_backup')));

function out(payload, code) {
  if (jsonOut) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  else console.log(payload.message || JSON.stringify(payload));
  process.exit(code === undefined ? 0 : code);
}
function fail(code, message, extra = {}) {
  out({ ok: false, code, message, ...extra }, 1);
}

/** 是否位于 _tmp/ 下（允许 _tmp、_tmp-xxx、_tmp_xxx 这类前缀目录名）。 */
function underTmp(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  return parts.some((seg) => /^_tmp([._-].*)?$/i.test(seg));
}

if (!fs.existsSync(file)) fail('WORKSPACE_STORE_MISSING', `找不到 DSH 工作区注册表：${file}`, { file });
let raw = '';
try {
  raw = fs.readFileSync(file, 'utf8');
} catch (error) {
  fail('WORKSPACE_STORE_UNREADABLE', `读取失败：${String((error && error.message) || error)}`, { file });
}
let data = null;
try {
  data = JSON.parse(raw);
} catch (error) {
  fail('WORKSPACE_STORE_BROKEN', `JSON 解析失败（不写盘）：${String((error && error.message) || error)}`, { file });
}
const tables = (data && data.tables) || {};
const workspaces = tables.workspaces && typeof tables.workspaces === 'object' ? tables.workspaces : {};
const global = (data && data.global) || {};
const ids = Array.isArray(global.workspaceIds) ? global.workspaceIds : Object.keys(workspaces);
const defaultId = String(global.defaultWorkspaceId || '');

const dead = [];
for (const id of ids) {
  const row = workspaces[id];
  if (!row || typeof row !== 'object') continue;
  const p = String(row.path || '');
  if (!p) continue;
  if (fs.existsSync(p)) continue; // 活着的不动
  if (!underTmp(p)) continue; // 只处理 _tmp 沙盘残留
  dead.push({ id, path: p, title: String(row.title || '') });
}
const defaultDead = dead.find((item) => item.id === defaultId) || null;
const removable = defaultDead ? dead.filter((item) => item.id !== defaultId) : dead;

const base = {
  ok: true,
  code: defaultDead ? 'DEFAULT_WORKSPACE_DEAD' : 'OK',
  home,
  file,
  dryRun: !yes,
  deadOnly,
  total: ids.length,
  dead: dead.map(({ id, path: p }) => ({ id, path: p })),
  removable: removable.map(({ id, path: p }) => ({ id, path: p })),
  defaultDead: defaultDead ? { id: defaultDead.id, path: defaultDead.path } : null,
  removed: [],
  backup: '',
};

if (defaultDead) {
  base.message = `默认工作区是死条目（${defaultDead.id} → ${defaultDead.path}），拒绝自动删除；请人工先把默认工作区切到有效项。`;
  out(base, 2);
}
if (!dead.length) {
  base.message = `没有 _tmp 死工作区（共 ${ids.length} 个工作区）`;
  out(base, 0);
}
if (!yes) {
  base.message = `[dry-run] 将删除 ${removable.length} 个 _tmp 死工作区（加 --yes 才写；写前备份到 ${backupDir}）`;
  out(base, 0);
}

// ── 写前备份 ─────────────────────────────────────────────────────────────
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = path.join(backupDir, `workspace.json.bak-${ts}`);
try {
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(file, backupFile);
} catch (error) {
  fail('WORKSPACE_BACKUP_FAILED', `写前备份失败（零写入）：${String((error && error.message) || error)}`, { file, backupDir });
}

// ── 删除 + 原子写 ────────────────────────────────────────────────────────
const removeIds = new Set(removable.map((item) => item.id));
for (const id of removeIds) delete workspaces[id];
data.tables = { ...tables, workspaces };
data.global = { ...global, workspaceIds: ids.filter((id) => !removeIds.has(id)) };
const tmp = `${file}.tmp-${process.pid}`;
try {
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
} catch (error) {
  try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  fail('WORKSPACE_WRITE_FAILED', `写入失败（已备份到 ${backupFile}）：${String((error && error.message) || error)}`, { file, backup: backupFile });
}

base.dryRun = false;
base.removed = [...removeIds];
base.backup = backupFile;
base.message = `已删除 ${removeIds.size} 个 _tmp 死工作区；备份：${backupFile}`;
out(base, 0);
