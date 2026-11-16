#!/usr/bin/env node
'use strict';
/**
 * oom-stress.cjs —— R-c1ed 取数/清理 CLI（增补卷-c1ed-2 §3.2、卷三/卷四）
 *
 * 用法：
 *   node scripts/oom-stress.cjs --window --project <项目名> --at <ISO> [--window-sec 300] [--json]
 *   node scripts/oom-stress.cjs --clean  --project <项目名> [--json]
 *   node scripts/oom-stress.cjs --summary --project <项目名> [--json]   （AC2 斜率，尚未实现）
 *   node scripts/oom-stress.cjs --stress --turns 300 --tool-output-bytes 20480 [--load-dir <目录>] [--dry-run] [--json]
 *        └ 卷2 §2.5 的 script 等价口径：真生成 300 轮 × 20KB 工具输出（≥6e6B）并实测回读字节数
 *
 * 口径（PM 裁 M-20261115-155719-f90c04 / M-20261115-161017-febd02）：
 *   · 退出码按 `fail` 映射，**不再用旧的 ok**：0 = fail=false；1 = fail=true；2 = 参数/IO 错误。
 *   · --json 时 stdout 恰好一行 JSON，字段固定（见窗口结果 spread）。
 *   · 取数实现与 团队/工具/lib/render-mem-window.mjs 同源：模块存在就用模块；
 *     提案未 apply 前退回仓库根 src/render-memory.js（同一份实现，禁止在本脚本复制算法）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROJECT_STATE_BASE = path.join(ROOT, '团队', '状态', '项目');

function argValue(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? String(process.argv[i + 1]) : '';
}
const has = (name) => process.argv.includes('--' + name);

function failExit(code, message, extra) {
  const payload = { ok: false, code, message, ...(extra || {}) };
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.stderr.write(`[${code}] ${message}\n`);
  process.exit(2);
}

function projectStateDir(projectName) {
  const dir = path.join(PROJECT_STATE_BASE, projectName);
  try { if (fs.statSync(dir).isDirectory()) return dir; } catch { /* 下面报错 */ }
  return '';
}

function loadWindowImpl() {
  // 优先用卷2 §3.1 指定的模块；未 apply 时退回同一份实现（src/render-memory.js）。
  const modulePath = path.join(ROOT, '团队', '工具', 'lib', 'render-mem-window.mjs');
  try {
    if (fs.statSync(modulePath).isFile()) return { via: 'module', load: () => import('file://' + modulePath.replace(/\\/g, '/')) };
  } catch { /* 未 apply，走兜底 */ }
  return { via: 'src-fallback', load: () => Promise.resolve(require(path.join(ROOT, 'src', 'render-memory.js'))) };
}

async function cmdWindow() {
  const projectName = argValue('project');
  const atCrash = argValue('at');
  const windowSec = Number(argValue('window-sec') || 300);
  if (!projectName) failExit('BAD_ARGS', '需要 --project <项目名>');
  if (!atCrash || !Number.isFinite(Date.parse(atCrash))) failExit('BAD_ARGS', '需要 --at <ISO 时刻>（如 2026-11-15T08:00:00.000Z）');
  const dir = projectStateDir(projectName);
  if (!dir) failExit('PROJECT_STATE_MISSING', `找不到项目状态目录：${dir}`);
  const impl = loadWindowImpl();
  let mod = null;
  try { mod = await impl.load(); } catch (error) { failExit('IMPL_LOAD_FAILED', String((error && error.message) || error)); }
  let result = null;
  try {
    if (typeof mod.summarizeWindow === 'function' && typeof mod.readRenderMemoryWindow === 'function') {
      const win = mod.readRenderMemoryWindow(dir, { atCrash, windowSec });
      if (win && win.__exception) throw new Error(win.__exception);
      const winObj = win && win.lines ? win : { ...(win || {}), lines: (win && win.lines) || [] };
      result = mod.summarizeWindow(winObj, { atCrash, windowSec });
    } else {
      const win = mod.readRenderMemoryWindow(dir, { atCrash, windowSec });
      const evaluated = mod.evaluateRecoverable(win, { atCrash, windowSec });
      const fail = win.code === 'READ_FAILED' || win.code === 'SAMPLING_DISABLED';
      result = { ok: !fail, pass: !fail, fail, code: win.code, ...win, r1: evaluated.R1, r2: evaluated.R2, r3: evaluated.R3, restorable: evaluated.restorable, cadence: evaluated.cadence, via: impl.via };
    }
  } catch (error) {
    failExit('WINDOW_READ_FAILED', String((error && error.message) || error).slice(0, 300));
  }
  const out = {
    via: impl.via,
    code: result.code,
    fail: Boolean(result.fail),
    pass: Boolean(result.pass === undefined ? !result.fail : result.pass),
    restorable: Boolean(result.restorable),
    // lines 是**行数**（库返回的是数组，取 length；不要 Number(array) → NaN→0）
    lines: Array.isArray(result.lines) ? result.lines.length : (Number(result.lines) || 0),
    firstAt: result.firstAt || null,
    lastAt: result.lastAt || null,
    coverageSec: Number(result.coverageSec) || 0,
    insufficient: Boolean(result.insufficient),
    readFailed: Boolean(result.readFailed),
    r1: Boolean(result.r1),
    r2: Boolean(result.r2),
    r3: Boolean(result.r3),
    cadence: result.cadence || null,
    gaps: Array.isArray(result.gaps) ? result.gaps : [],
  };
  if (has('json')) process.stdout.write(JSON.stringify(out) + '\n');
  else {
    process.stdout.write([
      `窗口：${out.code}（fail=${out.fail} pass=${out.pass} restorable=${out.restorable}）via ${out.via}`,
      `行数 ${out.lines}｜覆盖 ${out.coverageSec}s｜insufficient=${out.insufficient} readFailed=${out.readFailed} R1/R2/R3=${out.r1}/${out.r2}/${out.r3}`,
      `cadence=${JSON.stringify(out.cadence)}`,
    ].join('\n') + '\n');
  }
  process.exit(out.fail ? 1 : 0);
}

function cmdClean() {
  const projectName = argValue('project');
  if (!projectName) failExit('BAD_ARGS', '需要 --project <项目名>');
  const dir = projectStateDir(projectName);
  if (!dir) failExit('PROJECT_STATE_MISSING', `找不到项目状态目录：${dir}`);
  const impl = require(path.join(ROOT, 'src', 'render-memory.js'));
  const plan = impl.planRetention(dir);
  const removed = [];
  let bytesFreed = 0;
  for (const rel of plan.removed || []) {
    const abs = path.join(dir, rel);
    if (!/^渲染内存-\d{8}(-\d+)?\.jsonl$/.test(path.basename(abs))) continue;
    try { bytesFreed += fs.statSync(abs).size; fs.unlinkSync(abs); removed.push(rel); } catch { /* 单个失败不影响其它 */ }
  }
  for (const rel of plan.crashRemoved || []) {
    const abs = path.join(dir, rel);
    if (!/^渲染崩溃[\\/]\d{8}T\d{6}Z?$/.test(rel)) continue;
    try { fs.rmSync(abs, { recursive: true, force: true }); removed.push(rel); } catch { /* 同上 */ }
  }
  const nextDue = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const line = { at: new Date().toISOString(), action: 'clean', kept: (plan.kept || []).length, removed, bytesFreed, nextDue, note: 'oom-stress --clean' };
  try { fs.appendFileSync(path.join(dir, '渲染保留.jsonl'), JSON.stringify(line) + '\n', 'utf8'); } catch { /* 审计写不进不阻断清理结果上报 */ }
  const out = { ok: true, code: 'OK', fail: false, project: projectName, kept: line.kept, removed, bytesFreed, nextDue };
  process.stdout.write((has('json') ? JSON.stringify(out) : `清理完成：removed=${removed.length} bytesFreed=${bytesFreed} kept=${line.kept}`) + '\n');
  process.exit(0);
}

function cmdSummary() {
  failExit('SUMMARY_NOT_IMPLEMENTED', 'AC2 斜率（口径A+OLS+双校验）尚未实现，等取数入口 apply 后补；本命令目前不产出假数据');
}

/**
 * R-c1ed 卷2 §2.5「等价 ≥300 轮」的 script 口径：
 *   --turns 300 --tool-output-bytes 20480  → 真生成等价负载（每轮一个固定字节的工具输出块），
 *   自报 equivalentTurns / toolOutputBytes（默认 300×20480 = 6,144,000B ≥ 6e6），并**实测回读**字节数。
 * 输出（--json 时恰好一行）：{ok, mode, equivalentBy:'script', equivalentTurns, toolOutputBytes,
 *   toolOutputBytesPerTurn, files, dir, measuredBytes, equivalent}
 */
function cmdStress() {
  const num = (name, fallback) => {
    const raw = argValue(name);
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  };
  const turns = num('turns', 300);
  const bytesPerTurn = num('tool-output-bytes', 20480);
  const dryRun = has('dry-run');
  const dirArg = argValue('load-dir');
  const loadDir = dirArg ? path.resolve(dirArg) : path.join(ROOT, '_tmp', 'oom-stress-load');
  const total = turns * bytesPerTurn;
  let measuredBytes = 0;
  if (!dryRun) {
    try {
      fs.rmSync(loadDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      fs.mkdirSync(path.join(loadDir, 'turns'), { recursive: true });
      // 每轮 1 个工具输出块：内容可读、字节数精确到 --tool-output-bytes
      const unit = 'TOOL_OUTPUT turn payload ';
      const line = unit + 'x'.repeat(100) + '\n';
      const block = Buffer.from(line.repeat(Math.max(1, Math.ceil(bytesPerTurn / line.length))).slice(0, bytesPerTurn), 'utf8');
      for (let i = 1; i <= turns; i += 1) {
        const file = path.join(loadDir, 'turns', `turn-${String(i).padStart(4, '0')}.txt`);
        fs.writeFileSync(file, block);
        measuredBytes += fs.statSync(file).size;
      }
      fs.writeFileSync(path.join(loadDir, 'manifest.json'), JSON.stringify({
        at: new Date().toISOString(),
        equivalentBy: 'script',
        equivalentTurns: turns,
        toolOutputBytes: total,
        toolOutputBytesPerTurn: bytesPerTurn,
        files: turns,
        measuredBytes,
      }, null, 2) + '\n', 'utf8');
    } catch (error) {
      failExit('LOAD_GEN_FAILED', String((error && error.message) || error).slice(0, 300), { dir: loadDir });
    }
  }
  const equivalent = turns >= 300 && total >= 6e6 && (dryRun || measuredBytes === total);
  const out = {
    ok: !dryRun ? measuredBytes === total : true,
    mode: 'stress',
    equivalentBy: 'script',
    equivalentTurns: turns,
    toolOutputBytes: total,
    toolOutputBytesPerTurn: bytesPerTurn,
    files: dryRun ? 0 : turns,
    dir: dryRun ? '' : loadDir,
    measuredBytes: dryRun ? 0 : measuredBytes,
    dryRun,
    equivalent,
  };
  if (has('json')) process.stdout.write(JSON.stringify(out) + '\n');
  else {
    process.stdout.write([
      `等价负载已生成：turns=${turns} bytes/turn=${bytesPerTurn} 合计 ${total}B（实测 ${measuredBytes}B）`,
      `equivalentBy=script｜equivalentTurns=${turns}｜toolOutputBytes=${total}｜equivalent=${equivalent}`,
      `目录：${out.dir || '(dry-run 未落盘)'}`,
    ].join('\n') + '\n');
  }
  process.exit(equivalent ? 0 : 1);
}

(async () => {
  if (has('window')) return cmdWindow();
  if (has('clean')) return cmdClean();
  if (has('summary')) return cmdSummary();
  if (has('stress')) return cmdStress();
  failExit('BAD_ARGS', '需要 --window / --clean / --summary / --stress 之一');
})().catch((error) => failExit('CLI_CRASHED', String((error && error.stack) || error).slice(0, 400)));
