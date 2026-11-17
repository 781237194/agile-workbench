'use strict';
/**
 * tmp-prune.mjs —— 测试沙盘治理（B-20261117-140928-b51b）：`team.mjs tmp prune`
 *
 * 背景：`_tmp/` 累积 700+ 残留沙盘目录（Owner 在工作区里看到「测试项目」），
 * 原因是不少脚本用固定名沙盘且退出不清理。这里给一个统一、可回查的清理入口。
 *
 * 写死口径：
 *   · 默认 **dry-run**，只有 `--yes` 才真删；`--dry-run` 与 `--yes` 互斥。
 *   · 只处理 `_tmp` **顶层子目录**；根下的文件/脚本（*.cjs/*.mjs/日志/JSON 等）一律不碰。
 *   · 「未修改超过 N 分钟」按 **递归最新 mtime** 判定（默认 60 分钟，`--minutes` 可调）：
 *     长跑脚本在沙盘里持续写文件时，即使顶层目录 mtime 旧也不会被误删；
 *     扫描超过深度/条数上限（怀疑异常巨大目录）时按「保留」处理，宁可不删。
 *   · `--keep name1,name2,prefix-*` 白名单（精确名 / 末尾 * 前缀）。
 *   · 删除前先把候选清单与计数 **append** 到 `团队/状态/项目/<项目>/沙盘清理.jsonl`（append-only，可回查）。
 *   · `--root` 可指定别的目录（夹具/排障用）；默认 `<工作台根>/_tmp`。
 *
 * 不做的事：不删 `_tmp` 根文件；不递归处理 `_tmp` 下更深层的子目录（只删顶层目录就整棵删掉）；不清理真实项目目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, WORKSPACE, fail, nowIso, readJson, appendLine, jsonOut, textOut } from './core.mjs';

const DEFAULT_MINUTES = 60;
const SCAN_DEPTH = 6;
const MAX_SCAN_ENTRIES = 50000;
const LIST_LIMIT = 60;

function parseKeep(raw) {
  const out = [];
  for (const part of String(raw || '').split(/[,，\s]+/)) {
    const v = part.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

function keepMatches(name, patterns) {
  for (const p of patterns) {
    if (p === name) return true;
    if (p.endsWith('*') && name.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}

/** 递归最新 mtime（深度/条数有上限；超限返回 truncated=true，调用方按保留处理）。 */
function newestMtimeMs(dir) {
  let newest = 0;
  let entries = 0;
  let truncated = false;
  const walk = (d, depth) => {
    if (truncated) return;
    let stat = null;
    try { stat = fs.statSync(d); } catch { return; }
    if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    if (depth >= SCAN_DEPTH) return;
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of list) {
      entries += 1;
      if (entries > MAX_SCAN_ENTRIES) { truncated = true; return; }
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p, depth + 1);
      else {
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs > newest) newest = st.mtimeMs;
        } catch { /* 并发删除/权限问题：忽略单个文件 */ }
      }
    }
  };
  walk(dir, 0);
  return { newestMs: newest, entries, truncated };
}

function removeTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String((error && (error.code || error.message)) || error) };
  }
}

function auditPathOf(projectName) {
  return path.join(PATHS.state, '项目', String(projectName || '未知项目'), '沙盘清理.jsonl');
}

function activeProjectName() {
  try {
    const team = readJson(PATHS.team, null);
    return String((team && team.activeProject) || '').trim();
  } catch { return ''; }
}

/** 列出/清理沙盘目录；返回结构化结果，供夹具与文本输出共用。 */
export function pruneSandboxes(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const root = path.resolve(String(opts.root || path.join(WORKSPACE, '_tmp')));
  if (!fs.existsSync(root)) fail('TMP_ROOT_MISSING', `沙盘根不存在：${root}`, { root });
  const statRoot = fs.statSync(root);
  if (!statRoot.isDirectory()) fail('TMP_ROOT_INVALID', `沙盘根不是目录：${root}`, { root });
  const minutes = opts.minutes === undefined || opts.minutes === null || opts.minutes === ''
    ? DEFAULT_MINUTES
    : Number(opts.minutes);
  if (!Number.isFinite(minutes) || minutes < 0) fail('BAD_ARGS', '--minutes 需要非负数字（默认 60）', { minutes: opts.minutes });
  const keep = Array.isArray(opts.keep) ? opts.keep.map(String) : parseKeep(opts.keep);
  const yes = Boolean(opts.yes);
  if (yes && opts.dryRun) fail('BAD_ARGS', '--dry-run 与 --yes 互斥：默认就是 dry-run，确认删除请只加 --yes');
  const dryRun = !yes;
  const projectName = String(opts.project || '').trim() || activeProjectName() || '未知项目';

  const entries = fs.readdirSync(root, { withFileTypes: true });
  const dirNames = [];
  const fileNames = [];
  for (const ent of entries) {
    if (ent.isDirectory()) dirNames.push(ent.name);
    else fileNames.push(ent.name); // 根下文件（脚本/日志/JSON）永不删除
  }

  const now = Date.now();
  const thresholdMs = minutes * 60000;
  const candidates = [];
  const kept = [];
  for (const name of dirNames) {
    const p = path.join(root, name);
    let lst = null;
    try { lst = fs.lstatSync(p); } catch { kept.push({ name, reason: 'VANISHED' }); continue; }
    if (lst.isSymbolicLink()) { kept.push({ name, reason: 'SYMLINK' }); continue; }
    if (keepMatches(name, keep)) { kept.push({ name, reason: 'KEEP' }); continue; }
    const scan = newestMtimeMs(p);
    if (scan.truncated) { kept.push({ name, reason: 'SCAN_TRUNCATED' }); continue; }
    const ageMs = now - scan.newestMs;
    if (ageMs < thresholdMs) {
      kept.push({ name, reason: `RECENT(${Math.max(0, Math.round(ageMs / 60000))}m)` });
      continue;
    }
    candidates.push({ name, newest: new Date(scan.newestMs).toISOString(), ageMinutes: Math.round(ageMs / 60000) });
  }

  const result = {
    ok: true,
    root,
    minutes,
    keep,
    dryRun,
    project: projectName,
    before: { dirs: dirNames.length, files: fileNames.length },
    candidates: candidates.map((c) => c.name),
    candidateDetails: candidates,
    kept,
    removed: [],
    failed: [],
    after: { dirs: dirNames.length },
    audit: auditPathOf(projectName),
  };

  if (dryRun) return result;

  // 删除前先写审计（append-only）——先写后删，崩溃也能回查本次意图。
  const auditFile = result.audit;
  try {
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    appendLine(auditFile, JSON.stringify({
      at: nowIso(),
      by: String(opts.by || 'cli'),
      action: 'tmp_prune',
      root,
      minutes,
      keep,
      beforeDirs: result.before.dirs,
      candidateCount: candidates.length,
      candidates: candidates.map((c) => c.name),
    }));
  } catch (error) {
    fail('AUDIT_WRITE_FAILED', `清理审计写不进去（未删除任何目录）：${String((error && error.message) || error)}`, { audit: auditFile });
  }

  for (const name of result.candidates) {
    const r = removeTree(path.join(root, name));
    if (r.ok) result.removed.push(name);
    else result.failed.push({ name, error: r.error });
  }
  try { result.after.dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).length; } catch { result.after.dirs = 0; }
  // 结果也回写一行（append-only），便于事后核对「删了哪些、失败哪些」。
  try {
    appendLine(auditFile, JSON.stringify({
      at: nowIso(),
      by: String(opts.by || 'cli'),
      action: 'tmp_prune_done',
      root,
      removedCount: result.removed.length,
      removed: result.removed,
      failed: result.failed,
      afterDirs: result.after.dirs,
    }));
  } catch { /* 审计失败不掩盖已删除事实，文本输出仍会显示 */ }
  return result;
}

function listText(names, limit = LIST_LIMIT) {
  if (!names.length) return '（无）';
  const head = names.slice(0, limit).join(', ');
  return names.length > limit ? `${head} …（共 ${names.length}）` : head;
}

export function cmdTmp(args) {
  const sub = String((args._ && args._[1]) || 'status').toLowerCase();
  if (sub !== 'prune') {
    fail('BAD_ARGS', 'tmp 只支持 prune：team.mjs tmp prune [--root <目录>] [--minutes 60] [--keep a,b] [--yes] [--json]');
  }
  const result = pruneSandboxes({
    root: args.root ? String(args.root) : '',
    minutes: args.minutes === undefined ? '' : args.minutes,
    keep: args.keep ? String(args.keep) : '',
    dryRun: Boolean(args['dry-run']),
    yes: Boolean(args.yes),
    project: args.project ? String(args.project) : '',
    by: String(args.by || 'cli'),
  });
  const lines = [];
  lines.push(`沙盘清理 · ${result.root} ｜ 阈值 ${result.minutes} 分钟 ｜ 模式：${result.dryRun ? 'dry-run（未删除）' : '执行删除'}`);
  lines.push(`顶层目录 ${result.before.dirs} 个 ｜ 根下文件 ${result.before.files} 个（根下脚本/文件一律不删）｜ 候选删除 ${result.candidates.length} ｜ 保留 ${result.kept.length}`);
  const reasons = new Map();
  for (const k of result.kept) {
    const r = String(k.reason).replace(/\(.*\)$/, '');
    reasons.set(r, (reasons.get(r) || 0) + 1);
  }
  if (reasons.size) lines.push(`保留原因：${[...reasons.entries()].map(([r, n]) => `${r} ${n}`).join(' ｜ ')}`);
  lines.push(`候选清单：${listText(result.candidates)}`);
  if (result.dryRun) {
    lines.push(`未删除任何目录；确认后加 --yes 执行（删除前把清单写入审计：${result.audit}）`);
  } else {
    lines.push(`已删除 ${result.removed.length} 个顶层目录${result.failed.length ? `（失败 ${result.failed.length}：${result.failed.slice(0, 5).map((f) => `${f.name}=${f.error}`).join('、')}）` : ''}`);
    lines.push(`清理后顶层目录 ${result.after.dirs} 个 ｜ 审计：${result.audit}（先写清单、后写结果两行）`);
  }
  if (args.json) jsonOut(result);
  else textOut(lines.join('\n'));
}
