'use strict';
/**
 * R-20261121-124427-bcac：`team.mjs storage show [--json]`
 * 与壳层 `workbench.storageStatus()` 同源口径（只读）：生效配置（env > settings.storage > 默认安装盘）、
 * tmpDir 占用/上限、上次清理。不写任何文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { TeamError } from './core.mjs';
import { jsonOut, textOut } from './core.mjs';

const DEFAULT_LIMITS = { maxBytes: 8 * 1024 * 1024 * 1024, maxFiles: 200000, staleMinutes: 60 };

function resolveRepoRoot() {
  const teamRoot = String(process.env.TEAM_ROOT || '').trim();
  if (teamRoot) return path.dirname(path.resolve(teamRoot));
  return process.cwd();
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function measure(dir) {
  let bytes = 0; let files = 0; let dirs = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      try {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { dirs += 1; stack.push(full); continue; }
        bytes += fs.statSync(full).size; files += 1;
      } catch { /* ignore */ }
    }
  }
  return { bytes, files, dirs };
}
function fmt(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

export function cmdStorage(args = {}) {
  const sub = String((args._ && args._[1]) || 'show').toLowerCase();
  if (sub !== 'show') throw new TeamError('BAD_SUBCOMMAND', `未知 storage 子命令：${sub}（只支持 show）`);
  const repo = resolveRepoRoot();
  const dataDir = String(process.env.AWB_DATA_DIR || path.join(repo, 'data'));
  const storeFile = String(process.env.TEAM_WORKBENCH_JSON || path.join(dataDir, 'userdata', 'workbench.json'));
  const store = readJson(storeFile);
  const settings = (store && store.settings && store.settings.storage) || {};
  const D_DRIVE = String.fromCharCode(68) + ':';
  const defaultTmp = D_DRIVE + '\\awb-sandbox\\tmp';
  const tmpDir = String(process.env.AWB_TMP_ROOT || settings.tmpDir || defaultTmp);
  const limits = { ...DEFAULT_LIMITS, ...(settings.limits && typeof settings.limits === 'object' ? settings.limits : {}) };
  const usage = measure(tmpDir);
  let lastCleanup = null;
  try {
    const audit = path.join(dataDir, '存储清理.jsonl');
    const lines = fs.readFileSync(audit, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    if (lines.length) lastCleanup = JSON.parse(lines[lines.length - 1]);
  } catch { /* 无审计 */ }
  const over = usage.bytes > limits.maxBytes || usage.files > limits.maxFiles;
  const result = {
    ok: !over,
    code: over ? 'STORAGE_LIMIT_EXCEEDED' : 'STORAGE_OK',
    effective: {
      dataDir: { path: dataDir, source: process.env.AWB_DATA_DIR ? 'env' : (settings.dataDir ? 'settings' : 'default') },
      tmpDir: { path: tmpDir, source: process.env.AWB_TMP_ROOT ? 'env' : (settings.tmpDir ? 'settings' : 'default') },
      storeFile,
    },
    usage: { bytes: usage.bytes, files: usage.files, sandboxes: usage.dirs, ratio: limits.maxBytes ? Math.round((usage.bytes / limits.maxBytes) * 1000) / 1000 : 0 },
    limits,
    lastCleanup,
    pendingRestart: false,
    message: over ? '临时沙盘超限：请先清理过期沙盘或改存储位置（设置 → 存储位置）' : '存储正常',
  };
  if (args.json) {
    jsonOut(result);
    return result;
  }
  textOut([
    '存储位置 · ' + (result.ok ? '正常' : '超限'),
    '应用数据目录：' + result.effective.dataDir.path + '（' + result.effective.dataDir.source + '）',
    '临时沙盘目录：' + result.effective.tmpDir.path + '（' + result.effective.tmpDir.source + '）',
    '临时占用：' + fmt(usage.bytes) + ' / ' + fmt(limits.maxBytes) + '（' + usage.files + ' 文件，' + usage.dirs + ' 个沙盘目录）',
    lastCleanup ? ('上次清理：' + String(lastCleanup.at || '') + '，释放 ' + fmt(lastCleanup.freedBytes) + '，删除 ' + Number(lastCleanup.removed || 0) + ' 个') : '上次清理：无记录',
    result.message,
  ].join('\n'));
  return result;
}

export default cmdStorage;
