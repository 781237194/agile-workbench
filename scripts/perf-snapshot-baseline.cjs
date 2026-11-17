#!/usr/bin/env node
'use strict';
/**
 * perf-snapshot-baseline.cjs —— 6543 / 02e9 修前基线（只读沙盘副本，绝不碰真实项目状态）
 *
 * 口径（与 PM 冷测一致，便于对表）：
 *   ① 任务目录全量读+parse（readdir + 每个 .json readFileSync + JSON.parse）；
 *   ② 仅 readdir + stat；
 *   ③ readWorkflowState（工作流.json parse）与 readWorkflowSnapshot（工作流 + 任务扫描）；
 *   ④ generateBoard（看板重建，最大嫌疑 ~3.4s）。
 * 全程在 _tmp/perf-6543-<pid> 的副本上跑，真实 团队/状态/项目/<P> 只读复制。
 *
 * 运行：node scripts/perf-snapshot-baseline.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PNAME = '工作台改造修复';
const REAL_STATE = path.join(ROOT, '团队', '状态', '项目', PNAME);
const REAL_PROJECT = path.join(ROOT, '项目', PNAME);
const SB = path.join(ROOT, '_tmp', `perf-6543-${process.pid}`);
const SB_TEAM = path.join(SB, '团队');
const SB_STATE = path.join(SB_TEAM, '状态', '项目', PNAME);
const SB_PROJECT = path.join(SB, '项目', PNAME);

function copyDir(from, to, filter) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (filter && !filter(src, entry)) continue;
    if (entry.isDirectory()) copyDir(src, dst, filter);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}
function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(SB_STATE, { recursive: true });
  fs.mkdirSync(SB_PROJECT, { recursive: true });
  // 团队根骨架（工具需要的 layout 文件）
  for (const name of ['团队宪法.md', '项目铁律.md']) {
    try { fs.copyFileSync(path.join(ROOT, '团队', name), path.join(SB_TEAM, name)); } catch { /* 可缺 */ }
  }
  fs.copyFileSync(path.join(ROOT, '团队', '状态', '团队.json'), path.join(SB_TEAM, '状态', '团队.json'));
  // 项目状态：工作流 + 任务 + 项目.json
  fs.copyFileSync(path.join(REAL_STATE, '工作流.json'), path.join(SB_STATE, '工作流.json'));
  for (const name of ['项目.json', '决策箱.json', 'role_queues.json']) {
    try { fs.copyFileSync(path.join(REAL_STATE, name), path.join(SB_STATE, name)); } catch { /* 可缺 */ }
  }
  copyDir(path.join(REAL_STATE, '任务'), path.join(SB_STATE, '任务'));
  // 项目文档（快照/看板会读需求与索引）
  copyDir(REAL_PROJECT, SB_PROJECT, (_src, entry) => entry.name === '需求' || entry.isFile());
}

const t0 = () => process.hrtime.bigint();
const ms = (a) => Number(process.hrtime.bigint() - a) / 1e6;
function stats(list) {
  const sorted = [...list].sort((a, b) => a - b);
  const avg = list.reduce((s, n) => s + n, 0) / list.length;
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  return { n: list.length, avg: +avg.toFixed(1), p95: +p95.toFixed(1), min: +sorted[0].toFixed(1), max: +sorted[sorted.length - 1].toFixed(1) };
}

(async () => {
  const started = t0();
  seed();
  const seedMs = ms(started);
  const tasksDir = path.join(SB_STATE, '任务');
  const files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
  const TT = require(path.join(ROOT, 'src', 'team-tools.js'));
  const tools = TT.create({ teamRoot: SB_TEAM });

  // ① 任务全量读+parse
  const readAll = [];
  for (let i = 0; i < 5; i += 1) {
    const t = t0();
    for (const f of files) { try { JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8')); } catch { /* 坏文件也计时 */ } }
    readAll.push(ms(t));
  }
  // ② 仅 readdir + stat
  const statOnly = [];
  for (let i = 0; i < 5; i += 1) {
    const t = t0();
    for (const f of fs.readdirSync(tasksDir)) { try { fs.statSync(path.join(tasksDir, f)); } catch { /* ignore */ } }
    statOnly.push(ms(t));
  }
  // ③ readWorkflowState / readWorkflowSnapshot
  const stateTimes = [];
  for (let i = 0; i < 5; i += 1) { const t = t0(); tools.readWorkflowState(PNAME); stateTimes.push(ms(t)); }
  const snapTimes = [];
  for (let i = 0; i < 3; i += 1) { const t = t0(); tools.readWorkflowSnapshot(PNAME, SB_PROJECT); snapTimes.push(ms(t)); }
  // ④ generateBoard
  const boardTimes = [];
  for (let i = 0; i < 2; i += 1) {
    const t = t0();
    try { await tools.generateBoard(PNAME); } catch (error) { console.log('generateBoard error:', String((error && error.message) || error).slice(0, 200)); }
    boardTimes.push(ms(t));
  }

  const report = {
    at: new Date().toISOString(),
    sandbox: { teamRoot: SB_TEAM, projectPath: SB_PROJECT, seedMs: +seedMs.toFixed(1) },
    taskFiles: files.length,
    tasksReadParse: stats(readAll),
    tasksReaddirStat: stats(statOnly),
    readWorkflowState: stats(stateTimes),
    readWorkflowSnapshot: stats(snapTimes),
    generateBoard: stats(boardTimes),
    workflowJsonBytes: fs.statSync(path.join(SB_STATE, '工作流.json')).size,
    boardJsonBytes: (() => { try { return fs.statSync(path.join(SB_STATE, '看板.json')).size; } catch { return 0; } })(),
  };
  console.log('PERF_BASELINE ' + JSON.stringify(report));
  fs.mkdirSync(path.join(ROOT, '_tmp', 'batchB1'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '_tmp', 'batchB1', 'perf-baseline.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
})().catch((error) => {
  console.error('PERF_FATAL ' + String((error && error.stack) || error));
  process.exit(1);
});
