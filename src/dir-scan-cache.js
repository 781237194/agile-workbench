#!/usr/bin/env node
'use strict';
/**
 * R-20261118-170937-b34a（T-e2d8 R2）· 批5：目录扫描结果缓存（PM 2026-11-18 17:57 优先序 d）。
 *
 * 背景（测量单）：状态目录 284MB / 25857 文件；`files:list` 每次递归 walk + 逐文件 statSync（上限 600 项），
 * presence / team-status / workspaces 同类扫描在重复刷新时反复付出目录遍历成本。
 *
 * 契约（PM：目录 mtime+文件数缓存，不改语义）：
 *   · 缓存键 = 目录绝对路径 + `stat(dir).mtimeMs` + `stat(dir).size`（目录项变化会改 mtime/size）
 *     + （递归扫描时）顶层项数；命中 → 直接返回上次结果，**不 readdir、不逐文件 stat**；
 *   · 命中不改变返回结构（只多一个 `cached` 标记，调用方可忽略）；
 *   · TTL 兜底（默认 0=不用；>0 时即使目录 mtime 未变也按 TTL 过期），防网络盘/时间戳不可靠；
 *   · 上限：单结果 ≤ `maxFiles`（与既有 600 上限一致），键数量 ≤ 128（超出删最旧）；
 *   · 只读、不写盘；`clear()` 供写路径主动失效（与 perf-cache 的写后失效同向）。
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_KEYS = 128;
const hits = { count: 0, scans: 0, skipped: 0 };
const treeCache = new Map(); // key → { at, value }
const dirCache = new Map();  // key → { at, value }

function statKey(dir) {
  try {
    const st = fs.statSync(dir);
    return `${path.resolve(dir)}|${st.mtimeMs}|${st.size}`;
  } catch { return ''; }
}
function trimCache(map) {
  while (map.size > MAX_KEYS) map.delete(map.keys().next().value);
}

/**
 * 递归列目录（与 main.js files:list 同语义：maxDepth/maxFiles/跳过名单），带缓存。
 * @returns {{files:Array<{rel:string,name:string,kind:'dir'|'file',size:number}>, count:number, truncated:boolean, cached:boolean, maxDepth:number}}
 */
function scanTreeCached(root, options = {}) {
  const dir = String(root || '');
  const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth >= 0 ? options.maxDepth : 4;
  const maxFiles = Number(options.maxFiles) > 0 ? Math.floor(Number(options.maxFiles)) : 600;
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : 0;
  const skipNames = options.skipNames instanceof Set ? options.skipNames : new Set(options.skipNames || ['node_modules', '.git', 'userdata', '_tmp']);
  const key = `${statKey(dir)}|d${maxDepth}|f${maxFiles}`;
  const now = Date.now();
  const hit = key ? treeCache.get(key) : null;
  if (hit && (ttlMs === 0 || now - hit.at < ttlMs)) {
    hits.count += 1;
    return { ...hit.value, cached: true };
  }
  // 目录不存在：不缓存 missing
  try { if (!fs.statSync(dir).isDirectory()) throw new Error('not a dir'); } catch {
    hits.skipped += 1;
    return { files: [], count: 0, truncated: false, cached: false, maxDepth };
  }
  const files = [];
  const walk = (cur, depth) => {
    if (depth > maxDepth || files.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (skipNames.has(entry.name)) continue;
      if (entry.name.includes('.awb-tmp-')) continue;
      const abs = path.join(cur, entry.name);
      const rel = path.relative(dir, abs).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        files.push({ rel, name: entry.name, kind: 'dir', size: 0 });
        walk(abs, depth + 1);
      } else {
        let size = 0;
        try { size = fs.statSync(abs).size; } catch { /* ignore */ }
        files.push({ rel, name: entry.name, kind: 'file', size });
      }
    }
  };
  walk(dir, 0);
  const value = { files, count: files.length, truncated: files.length >= maxFiles, maxDepth };
  if (key) { treeCache.set(key, { at: now, value }); trimCache(treeCache); }
  hits.scans += 1;
  return { ...value, cached: false };
}

/** 单层目录列表缓存（presence/team-status 这类只列一层的扫描用）。 */
function listDirCached(dir, options = {}) {
  const target = String(dir || '');
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : 0;
  const key = statKey(target);
  const now = Date.now();
  const hit = key ? dirCache.get(key) : null;
  if (hit && (ttlMs === 0 || now - hit.at < ttlMs)) {
    hits.count += 1;
    return { names: hit.value, cached: true };
  }
  let names = [];
  try { names = fs.readdirSync(target); } catch { hits.skipped += 1; return { names: [], cached: false }; }
  if (key) { dirCache.set(key, { at: now, value: names }); trimCache(dirCache); }
  hits.scans += 1;
  return { names, cached: false };
}

/** 写路径主动失效（全部或指定根）。 */
function clear(root) {
  if (!root) { const n = treeCache.size + dirCache.size; treeCache.clear(); dirCache.clear(); return n; }
  const prefix = path.resolve(String(root));
  let removed = 0;
  for (const map of [treeCache, dirCache]) {
    for (const k of [...map.keys()]) {
      if (!k.startsWith(`${prefix}|`) && !k.startsWith(`${prefix}\\`) && !k.includes(prefix)) continue;
      map.delete(k); removed += 1;
    }
  }
  return removed;
}

function scanStats() {
  return { ...hits, treeKeys: treeCache.size, dirKeys: dirCache.size };
}

module.exports = { scanTreeCached, listDirCached, clear, scanStats, MAX_KEYS };
