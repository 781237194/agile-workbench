#!/usr/bin/env node
'use strict';
/**
 * R-20261118-170937-b34a（T-e2d8 R2）—— 高频大文件的「缓存读取」独立实现（CJS，纯函数 + 注入路径）。
 *
 * 为什么独立：本批只做 R2 里**不依赖 B 的 R3/perf-log**、也**不改 main.js** 的部分（PM 2026-11-18 17:39 裁定）：
 * 把「工作流.json / 唤醒.jsonl / 项目索引.json / 任务目录」这四个热点的**缓存读取**收成一个模块，
 * 底层复用 `src/perf-cache.js` 的 getJsonFile/getTextFile（mtime+size 短路 + 写后失效）。
 * 接线（把 main.js 里的直读换成本模块）等 B 提交后再做，本模块先可独立验证。
 *
 * 契约（需求 §6.2）：
 *   · 命中不读盘；任一变化重读；截断重建；单值超限不缓存；解析失败保留旧值——全部由 perf-cache 保证；
 *   · 唤醒.jsonl 只缓存原文，取「最后 N 行」在内存里切（2.28MB 文件不重复 readFileSync）；
 *   · 任务目录索引：缓存 `{ count, maxMtime, ids }`，判据＝目录 mtime + 文件数（避免全量 readdir 每 IPC 跑）；
 *   · 全部只读，**不写**工作流/任务/需求；不落盘（内存缓存）。
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TAIL_LINES = 200;

function createHotReads({ perfCache, teamRoot, projectStateDir } = {}) {
  const cache = perfCache || require('./perf-cache.js');
  const root = String(teamRoot || '');
  const stateDir = String(projectStateDir || '');
  if (!root || !stateDir) throw new Error('createHotReads 需要 teamRoot 与 projectStateDir');

  const workflowFile = path.join(stateDir, '工作流.json');
  const wakeFile = path.join(stateDir, '唤醒.jsonl');
  const projectIndexFile = path.join(root, '状态', '项目索引.json');
  const tasksDir = path.join(stateDir, '任务');

  /** 工作流.json（1.5MB 级）：缓存解析结果；调用方拿到的对象**只读**（要改就走写路径+invalidate）。 */
  function readWorkflow() {
    const r = cache.getJsonFile(workflowFile);
    return { value: r.value, source: r.source, mtimeMs: r.mtimeMs, size: r.size, rebuilt: r.rebuilt, cached: r.cached, exists: r.source !== 'missing' };
  }

  /** 唤醒.jsonl（2.3MB 级）：缓存原文，返回最后 N 行（解析成对象，坏行跳过）。 */
  function readWakeTail(options = {}) {
    const lines = Number(options.lines) > 0 ? Math.floor(Number(options.lines)) : DEFAULT_TAIL_LINES;
    const r = cache.getTextFile(wakeFile);
    if (!r.value) return { rows: [], total: 0, source: r.source, exists: r.source !== 'missing' };
    const all = r.value.split(/\r?\n/).filter(Boolean);
    const rows = [];
    for (let i = all.length - 1; i >= 0 && rows.length < lines; i -= 1) {
      try { rows.push(JSON.parse(all[i])); } catch { /* 坏行跳过（与面板口径一致） */ }
    }
    rows.reverse();
    return { rows, total: all.length, source: r.source, exists: true, size: r.size };
  }

  /** 项目索引.json：缓存解析结果（不存在→null，不缓存 missing）。 */
  function readProjectIndex() {
    const r = cache.getJsonFile(projectIndexFile);
    return { value: r.value, source: r.source, exists: r.source !== 'missing' };
  }

  /** 任务目录索引：缓存 { count, maxMtime, ids }，判据＝目录 mtime（文件增删会改它）+ 缓存期文件数。 */
  let taskIndexCache = { key: '', value: null };
  function readTaskIndex() {
    let st = null;
    try { st = fs.statSync(tasksDir); } catch { return { count: 0, maxMtime: 0, ids: [], source: 'missing', exists: false }; }
    const key = `${st.mtimeMs}:${st.size}`;
    if (taskIndexCache.key === key && taskIndexCache.value) {
      return { ...taskIndexCache.value, source: 'cache', exists: true };
    }
    let names = [];
    try { names = fs.readdirSync(tasksDir).filter((n) => n.endsWith('.json')); } catch { names = []; }
    const ids = [];
    let maxMtime = 0;
    for (const name of names) {
      ids.push(name.replace(/\.json$/, ''));
      try { const fst = fs.statSync(path.join(tasksDir, name)); if (fst.mtimeMs > maxMtime) maxMtime = fst.mtimeMs; } catch { /* ignore */ }
    }
    const value = { count: ids.length, maxMtime, ids };
    taskIndexCache = { key, value };
    return { ...value, source: 'read', exists: true };
  }

  /** 写路径成功后调：让热点缓存立即失效（工作流/唤醒；任务目录靠自身 mtime key）。 */
  function invalidateAll() {
    let n = 0;
    n += cache.invalidate(workflowFile);
    n += cache.invalidate(wakeFile);
    n += cache.invalidate(projectIndexFile);
    taskIndexCache = { key: '', value: null };
    return n;
  }

  return {
    files: { workflowFile, wakeFile, projectIndexFile, tasksDir },
    readWorkflow,
    readWakeTail,
    readProjectIndex,
    readTaskIndex,
    invalidateAll,
  };
}

module.exports = { createHotReads, DEFAULT_TAIL_LINES };
