#!/usr/bin/env node
/**
 * B-20261115-134716-2dd3（P0）自测：DSH 渲染进程 OOM 的壳层防护三件事
 *   ①内存阈值告警（一次性、带去抖、人话文案带数字）②自动回收核对（阈值/速率/冷却三条件 + 真调回收）
 *   ③崩溃归因落盘（渲染崩溃.jsonl 追加 attribution，只读已有采样/回收记录，不新起采样）
 *
 * 断言形态：**静态 + 行为双断言**。
 *   静态：读 src/main.js / src/mem-policy.js 源码锚点（告警文件名、阈值单源、alertActive 去抖、
 *         崩溃行 attribution 八字段、采样器接线、界面通道、探针接线与隔离）。
 *   行为：用隔离数据根（AWB_B2DD3_DATA）起真实 Electron 实例跑 --b2dd3-check 两个模式：
 *         real      = AWB_MEM_RECYCLE_MB=1（mem-policy 固定阈值测试模式）→ 真实采样跨阈值只写 1 行、
 *                     继续真采样不刷行、手动回收一次、崩溃归因能读「近 10 分钟回收次数」；
 *         synthetic = 不设固定阈值，用 mem-policy 当前阈值驱动同一个 evaluateMemAlert：
 *                     超限 1 行 / 持续超限不刷行 / 回落 1 行 recovered / 再超限重新 1 行 /
 *                     超过 mem-policy 硬上限 kind=hard-cap；并验证无采样时归因写 null 且 attributionUnavailable=true。
 *   回归：spawn `node scripts/test-mem-policy.cjs` → 必须 exit 0 且 34/34（阈值策略不许被本改动破坏）。
 *
 * 隔离：两个实例的 data/userData、AWB_STORE、TEAM_ROOT 全落在 _tmp 沙盘；断言真实 团队/ 没有新增/改动
 *       `内存告警.jsonl`（本缺陷是新增文件，真实目录本来 0 个）。
 *
 * 跑法：node scripts/test-b2dd3-mem-alert.cjs [--no-electron]
 * 退出码：0 = 全部通过；1 = 有失败。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const NO_ELECTRON = process.argv.includes('--no-electron');
const SB = path.join(ROOT, '_tmp', 'b2dd3-mem-alert-' + process.pid + '-' + Date.now());
const RUN_ELECTRON = path.join(ROOT, 'scripts', 'run-electron.cjs');
const PROJECT_STATE_REL = path.join('团队', '状态', '项目', 'b2dd3-mem-alert');

const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const policySrc = fs.readFileSync(path.join(ROOT, 'src', 'mem-policy.js'), 'utf8');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail) {
  const row = { name, ok: Boolean(ok), detail: detail === undefined ? null : detail };
  if (row.ok) {
    pass += 1;
    console.log('PASS  ' + name);
  } else {
    fail += 1;
    failures.push(row);
    console.log('FAIL  ' + name + '  ' + JSON.stringify(detail === undefined ? null : detail).slice(0, 700));
  }
  return row.ok;
}
function sliceBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) return '';
  const end = endMarker ? src.indexOf(endMarker, start + startMarker.length) : -1;
  return src.slice(start, end > start ? end : src.length);
}
// 静态断言只看代码、不看注释（注释里会写「不新增 setInterval」这种反例说明）。
function stripComments(src) {
  return String(src || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}
function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function listRealAlertFiles() {
  const out = [];
  const projectsDir = path.join(ROOT, '团队', '状态', '项目');
  let entries = [];
  try { entries = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(projectsDir, entry.name, '内存告警.jsonl');
    try {
      const stat = fs.statSync(file);
      out.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch { /* 文件不存在就是没碰过 */ }
  }
  return out;
}
function tailText(file, lines) {
  try {
    const all = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    return all.slice(-(lines || 8)).join('\n');
  } catch { return ''; }
}
function runProbe(label, extraEnv) {
  const dataRoot = path.join(SB, label);
  const outDir = path.join(SB, label + '-out');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'userdata'), { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const logFile = path.join(SB, label + '.log');
  const fd = fs.openSync(logFile, 'w');
  const env = {
    ...process.env,
    AWB_DATA_DIR: dataRoot,
    AWB_B2DD3_DATA: dataRoot,
    AWB_B2DD3_OUT: outDir,
    AWB_START_HIDDEN: '1',
    ...extraEnv,
  };
  // 注意：不要传 piped stdio（Windows 沙箱可能 EPERM）；日志直接写文件描述符。
  const res = spawnSync(process.execPath, [RUN_ELECTRON, '.', '--b2dd3-check'], {
    cwd: ROOT, env, stdio: ['ignore', fd, fd], timeout: 240000, windowsHide: true,
  });
  fs.closeSync(fd);
  return {
    label, dataRoot, outDir, logFile,
    status: res.status, signal: res.signal, error: res.error ? String(res.error.message || res.error) : '',
    reportFile: path.join(outDir, 'b2dd3-check.json'),
    alertFile: path.join(dataRoot, PROJECT_STATE_REL, '内存告警.jsonl'),
    crashFile: path.join(dataRoot, PROJECT_STATE_REL, '渲染崩溃.jsonl'),
  };
}

console.log('=== B-2dd3 自测：静态断言（src/main.js / src/mem-policy.js）===');
const alertBlock = sliceBetween(mainSrc, "/* ── B-20261115-134716-2dd3（P0）：内存阈值告警", 'let memSampler = null;');
const evalBlock = sliceBetween(mainSrc, 'function evaluateMemAlert(', 'async function sampleRendererMem');
const builderBlock = sliceBetween(mainSrc, 'function buildCrashAttribution(', 'function recordRenderCrash(');
const crashBlock = sliceBetween(mainSrc, 'function recordRenderCrash(', 'function recordShellAudit(');
const samplerBlock = sliceBetween(mainSrc, 'function startRenderMemorySampler(', 'function stopRenderMemorySampler(');
const probeBlock = sliceBetween(mainSrc, 'async function runB2dd3Check(', '\napp.whenReady()');

check('S01 告警审计文件叫 内存告警.jsonl，且与采样同源目录（renderMemoryProjectDir）',
  alertBlock.includes("'内存告警.jsonl'") && sliceBetween(alertBlock, 'function memAlertFile()', 'function memAlertKindOf').includes('renderMemoryProjectDir()'),
  { hasFile: alertBlock.includes("'内存告警.jsonl'") });
check('S02 告警阈值取自 mem-policy（memThresholdMB()，不是 main.js 新常量）',
  /const thresholdMB = memThresholdMB\(\);/.test(evalBlock) && !/const\s+[A-Z_]*THRESHOLD[A-Z_]*\s*=\s*\d/.test(alertBlock),
  { evalHasCall: /const thresholdMB = memThresholdMB\(\);/.test(evalBlock) });
check('S03 硬上限 kind 也取自 mem-policy（memPolicy.MAX_THRESHOLD_MB），无第二套数字阈值',
  sliceBetween(alertBlock, 'function memAlertKindOf(', 'function memAlertTop(').includes('memPolicy.MAX_THRESHOLD_MB')
  && !/\b(?:1843|3072)\b/.test(alertBlock + evalBlock),
  { hasPolicyMax: alertBlock.includes('memPolicy.MAX_THRESHOLD_MB') });
check('S04 去抖判据是 alertActive 布尔状态机（超限中分支 / 回落分支都在）',
  /if \(!memAlertState\.alertActive\)/.test(evalBlock) && /if \(memAlertState\.alertActive\)/.test(evalBlock) && /alertActive: false/.test(alertBlock),
  { hasActive: evalBlock.includes('alertActive') });
check('S05 告警代码不新增 setInterval/setTimeout（不自己起定时器）',
  !/setInterval|setTimeout/.test(stripComments(alertBlock)) && !/setInterval|setTimeout/.test(stripComments(evalBlock)),
  { alertBlockTimer: /setInterval|setTimeout/.test(stripComments(alertBlock)) });
check('S06 同一次超限只写一行：evaluateMemAlert 只有 2 处 append（超限一次 + 回落一次）',
  (evalBlock.match(/appendMemAlertLine\(/g) || []).length === 2,
  { appends: (evalBlock.match(/appendMemAlertLine\(/g) || []).length });
check('S07 告警行字段：at/kind/totalMB/thresholdMB/top[{pid,type,workingSetMB}]/source=sampler',
  /const row = \{ at, kind, totalMB, thresholdMB, top: memAlertTop\(it\.rows\), source: 'sampler' \};/.test(evalBlock)
  && /pid: row\.pid === undefined \? null : row\.pid, type: String\(row\.type \|\| 'renderer'\), workingSetMB: Number\(row\.workingSetMB\)/.test(alertBlock),
  { hasRow: evalBlock.includes('top: memAlertTop(it.rows)') });
check('S08 回落写 kind=recovered（带 totalMB/thresholdMB/peakMB/activeMs）',
  /kind: 'recovered', totalMB, thresholdMB, source: 'sampler'/.test(evalBlock)
  && evalBlock.includes('peakMB:') && evalBlock.includes('activeMs:'),
  { hasRecovered: evalBlock.includes("kind: 'recovered'") });
check('S09 界面提示复用 app:render-crash 通道（不新增样式体系）且已推送',
  evalBlock.includes("mainWindow.webContents.send('app:render-crash', banner)") && evalBlock.includes('bannerSent = true'),
  { sendsCrashChannel: evalBlock.includes("mainWindow.webContents.send('app:render-crash', banner)") });
check('S10 人话文案必须带「当前 MB / 阈值 MB / 建议动作」（禁止无数字文案）',
  evalBlock.includes('`渲染进程总内存 ${totalMB}MB 已达阈值 ${thresholdMB}MB') && /建议立即回收或减少会话/.test(evalBlock)
  && evalBlock.includes("advice: '立即回收 / 减少会话'"),
  { hasTemplate: evalBlock.includes('已达阈值 ${thresholdMB}MB') });
check('S11 采样器接线：每拍用本拍 total 评估告警（复用采样，不新增采样/定时器）',
  samplerBlock.includes('evaluateMemAlert({ totalMB: row.workingSetMB, rows: renderMemoryState.lastRows, at });'),
  { hasHook: samplerBlock.includes('evaluateMemAlert(') });
check('S12 采样器把最近真采样投影到模块状态（归因只读它，不在崩溃时新采样）',
  samplerBlock.includes('renderMemoryState.lastRealAt = at;')
  && samplerBlock.includes('renderMemoryState.lastWorkingSetMB = totalMB;')
  && samplerBlock.includes('renderMemoryState.lastRows = rows;')
  && samplerBlock.includes('renderMemoryState.lineAtMs.push(lineMs);'),
  { hasProjection: samplerBlock.includes('renderMemoryState.lastWorkingSetMB = totalMB;') });
check('S13 渲染崩溃.jsonl 同一行追加 attribution + attributionUnavailable（同一次崩溃仍只写一行）',
  /attribution: attribution\.attribution,/.test(crashBlock) && /attributionUnavailable: attribution\.attributionUnavailable,/.test(crashBlock)
  && (crashBlock.match(/fs\.appendFileSync\(file,/g) || []).length === 1,
  { hasAttribution: /attribution: attribution\.attribution,/.test(crashBlock) });
check('S14 归因八字段齐全（totalMB/thresholdMB/exceededThreshold/topConsumers/recycleCountLast10Min/lastRecycleAt/samplerLinesLast5Min/samplerLastAt）',
  ['totalMB:', 'thresholdMB:', 'exceededThreshold:', 'topConsumers,', 'recycleCountLast10Min:', 'lastRecycleAt:', 'samplerLinesLast5Min:', 'samplerLastAt,']
    .every((key) => builderBlock.includes(key)),
  { missing: ['totalMB:', 'thresholdMB:', 'exceededThreshold:', 'topConsumers,', 'recycleCountLast10Min:', 'lastRecycleAt:', 'samplerLinesLast5Min:', 'samplerLastAt,'].filter((key) => !builderBlock.includes(key)) });
check('S15 归因不新起采样（builder 里不调 getAppMetrics / sampleRendererMem / currentRendererMemoryMB）',
  !/(getAppMetrics|sampleRendererMem|currentRendererMemoryMB|getProcessMemoryInfo)\s*\(/.test(builderBlock),
  { hasSampleCall: /(getAppMetrics|sampleRendererMem|currentRendererMemoryMB)\s*\(/.test(builderBlock) });
check('S16 取不到就写 null + attributionUnavailable=true（不许编数字）',
  builderBlock.includes('const attributionUnavailable = lastMB === null || !samplerLastAt;')
  && builderBlock.includes('totalMB: lastMB'),
  { hasFlag: builderBlock.includes('const attributionUnavailable') });
check('S17 已有自动回收三条件仍在：超阈值 + 速率>200 + 距上次>10 分钟，且真调回收函数',
  /memPolicy\.shouldAutoRecycle\(/.test(mainSrc) && /if \(!decision\.auto\) return;/.test(mainSrc)
  && /memState\.lastAutoAt = now;/.test(mainSrc) && /recycleRenderer\(\s*`全部渲染进程内存/.test(mainSrc)
  && /thresholdMB, rateMBPerMin,/.test(mainSrc),
  { hasDecision: /memPolicy\.shouldAutoRecycle\(/.test(mainSrc) });
check('S18 mem-policy 阈值/速率/冷却公式未被本改动改坏（单源仍在 mem-policy.js）',
  policySrc.includes('const MAX_THRESHOLD_MB = 3 * MB;') && policySrc.includes('const AUTO_RATE_MB_PER_MIN = 200;')
  && policySrc.includes('const AUTO_COOLDOWN_MS = 10 * 60 * 1000;') && policySrc.includes('const REPEAT_GUARD_MS = 60 * 1000;')
  && policySrc.includes('baseline * 2.5'),
  { policyBytes: Buffer.byteLength(policySrc) });
check('S19 自检探针接线：--b2dd3-check + 独立数据根 + 沙盘 store/团队状态',
  mainSrc.includes("'--b2dd3-check'") && mainSrc.includes('async function runB2dd3Check')
  && /await runB2dd3Check\(\);/.test(mainSrc) && /IS_B2DD3_CHECK \? B2DD3_DATA/.test(mainSrc)
  && /if \(IS_B2DD3_CHECK\) \{\s*\n\s*process\.env\.AWB_STORE = path\.join\(B2DD3_DATA, 'workbench\.json'\);/.test(mainSrc)
  && /process\.env\.TEAM_ROOT = path\.join\(B2DD3_DATA, '团队'\);/.test(mainSrc),
  { hasFlag: mainSrc.includes("'--b2dd3-check'"), hasProbe: mainSrc.includes('async function runB2dd3Check') });
check('S20 探针覆盖：真实采样跨阈值/不刷行/回收归因/合成回落与 hard-cap（行为自查在探针内）',
  probeBlock.includes('真实采样跨阈值') && probeBlock.includes('持续超限期间不重复刷行')
  && probeBlock.includes('回落') && probeBlock.includes("kind === 'hard-cap'")
  && probeBlock.includes('无采样时归因写 null'),
  { probeBytes: Buffer.byteLength(probeBlock) });

console.log('\n=== B-2dd3 自测：回归（mem-policy 34 断言）===');
if (!NO_ELECTRON) {
  const mp = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'test-mem-policy.cjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 90000, windowsHide: true,
  });
  const passCount = (String(mp.stdout || '').match(/^PASS/gm) || []).length;
  check('R01 node scripts/test-mem-policy.cjs exit=0 且 34/34 PASS（策略回归）',
    mp.status === 0 && passCount === 34 && /MEM_POLICY_OK/.test(String(mp.stdout || '')),
    { status: mp.status, passCount, tail: String(mp.stdout || '').trim().split(/\r?\n/).slice(-3) });
}

let real = null;
let synth = null;
if (!NO_ELECTRON) {
  console.log('\n=== B-2dd3 自测：行为（隔离 Electron 实例）===');
  fs.mkdirSync(SB, { recursive: true });
  const realAlertBefore = listRealAlertFiles();
  real = runProbe('real', { AWB_B2DD3_MODE: 'real', AWB_MEM_RECYCLE_MB: '1' });
  const realReport = readJson(real.reportFile);
  check('B01 real：进程退出码 0（探针自检全过才退 0）', real.status === 0,
    { status: real.status, signal: real.signal, error: real.error, logTail: tailText(real.logFile, 10) });
  check('B02 real：探针报告 ok=true 且无失败项',
    Boolean(realReport) && realReport.ok === true && realReport.failed === 0,
    realReport ? { ok: realReport.ok, failed: realReport.failed, failures: realReport.failures } : { report: 'missing', logTail: tailText(real.logFile, 12) });
  check('B03 real：探针报告全部子项 PASS（含真实采样/不刷行/回收归因）',
    Boolean(realReport) && Array.isArray(realReport.checks) && realReport.checks.length >= 10 && realReport.checks.every((row) => row.pass === true),
    realReport ? { total: realReport.total, failed: realReport.failed } : null);
  check('B04 real：探针记录的数据根在沙盘内（不碰真实 data / 团队）',
    Boolean(realReport) && String(realReport.dataRoot || '').startsWith(SB) && String(realReport.teamRoot || '').startsWith(SB)
    && String(realReport.alertFile || '').startsWith(SB) && String(realReport.crashFile || '').startsWith(SB),
    realReport ? { dataRoot: realReport.dataRoot, teamRoot: realReport.teamRoot, alertFile: realReport.alertFile } : null);

  const realAlertRows = readJsonl(real.alertFile);
  const realThresholdRows = realAlertRows.filter((row) => row.kind === 'threshold' || row.kind === 'hard-cap');
  const realRow = realThresholdRows[0] || {};
  check('B05 real：真实采样跨阈值只写 1 行、超限期间 0 行 recovered（去抖）',
    realThresholdRows.length === 1 && realAlertRows.filter((row) => row.kind === 'recovered').length === 0,
    { kinds: realAlertRows.map((row) => row.kind), rows: realAlertRows.length });
  check('B06 real：告警行字段齐全（at 可解析 / totalMB>0 / thresholdMB=1=mem-policy 固定阈值 / source=sampler）',
    typeof realRow.at === 'string' && !Number.isNaN(Date.parse(realRow.at))
    && Number(realRow.totalMB) > 0 && Number(realRow.thresholdMB) === 1 && String(realRow.source) === 'sampler',
    realRow);
  check('B07 real：top 是逐进程占用（pid/type/workingSetMB，至少 1 项）',
    Array.isArray(realRow.top) && realRow.top.length >= 1
    && realRow.top.every((item) => item && 'pid' in item && 'type' in item && Number.isFinite(Number(item.workingSetMB))),
    realRow.top);

  const realCrashRows = readJsonl(real.crashFile);
  const realCrash = realCrashRows.find((row) => row.kind === 'b2dd3-attribution') || {};
  const realAttr = realCrash.attribution || null;
  check('B08 real：崩溃行带 attribution（8 键齐全）且 attributionUnavailable=false',
    Boolean(realAttr)
    && ['totalMB', 'thresholdMB', 'exceededThreshold', 'topConsumers', 'recycleCountLast10Min', 'lastRecycleAt', 'samplerLinesLast5Min', 'samplerLastAt'].every((key) => key in realAttr)
    && realCrash.attributionUnavailable === false,
    { attribution: realAttr, attributionUnavailable: realCrash.attributionUnavailable });
  check('B09 real：归因是「当时内存多少、谁占的」（totalMB>0 / thresholdMB=1 / exceededThreshold=true / topConsumers≥1）',
    Boolean(realAttr) && Number(realAttr.totalMB) > 0 && Number(realAttr.thresholdMB) === 1 && realAttr.exceededThreshold === true
    && Array.isArray(realAttr.topConsumers) && realAttr.topConsumers.length >= 1
    && realAttr.topConsumers.every((item) => item && 'pid' in item && 'type' in item && Number.isFinite(Number(item.workingSetMB))),
    realAttr);
  check('B10 real：归因是「之前回收过几次」（自动+手动 recycleCountLast10Min≥2、lastRecycleAt 可解析、samplerLinesLast5Min≥1）',
    Boolean(realAttr) && Number(realAttr.recycleCountLast10Min) >= 2
    && typeof realAttr.lastRecycleAt === 'string' && !Number.isNaN(Date.parse(realAttr.lastRecycleAt))
    && Number(realAttr.samplerLinesLast5Min) >= 1
    && typeof realAttr.samplerLastAt === 'string' && !Number.isNaN(Date.parse(realAttr.samplerLastAt)),
    realAttr);
  check('B11 real：崩溃行原有字段仍在（append-only 增强，不删旧字段）',
    typeof realCrash.at === 'string' && String(realCrash.kind) === 'b2dd3-attribution'
    && Number(realCrash.memoryMB) > 0 && 'processType' in realCrash && 'reason' in realCrash && 'exitCode' in realCrash && 'project' in realCrash,
    { at: realCrash.at, kind: realCrash.kind, memoryMB: realCrash.memoryMB });

  synth = runProbe('synthetic', { AWB_B2DD3_MODE: 'synthetic' });
  const synthReport = readJson(synth.reportFile);
  check('B12 synthetic：进程退出码 0 且探针报告 ok=true', synth.status === 0 && Boolean(synthReport) && synthReport.ok === true,
    { status: synth.status, ok: synthReport && synthReport.ok, failures: synthReport && synthReport.failures, logTail: tailText(synth.logFile, 10) });
  const synthAlertRows = readJsonl(synth.alertFile);
  const synthThreshold = synthAlertRows.filter((row) => row.kind === 'threshold').length;
  const synthRecovered = synthAlertRows.filter((row) => row.kind === 'recovered').length;
  const synthHardcap = synthAlertRows.filter((row) => row.kind === 'hard-cap').length;
  check('B13 synthetic：超限 2 行（两次超限）/ 回落 3 行 / hard-cap 1 行 —— 每次状态转换恰好 1 行',
    synthThreshold === 2 && synthRecovered === 3 && synthHardcap === 1,
    { threshold: synthThreshold, recovered: synthRecovered, hardcap: synthHardcap, kinds: synthAlertRows.map((row) => row.kind) });
  check('B14 synthetic：顺序=超限→回落→再超限→回落→hard-cap→回落（去抖状态机正确）',
    synthAlertRows.map((row) => row.kind).join(',') === 'threshold,recovered,threshold,recovered,hard-cap,recovered',
    { order: synthAlertRows.map((row) => row.kind).join(',') });
  const synthFirst = synthAlertRows[0] || {};
  check('B15 synthetic：阈值来自 mem-policy（无固定阈值 → MIN_THRESHOLD_MB=1843），阈值行 totalMB>阈值、回落行 totalMB<阈值',
    Number(synthFirst.thresholdMB) === 1843
    && synthAlertRows.filter((row) => row.kind === 'threshold' || row.kind === 'hard-cap').every((row) => Number(row.totalMB) > Number(row.thresholdMB))
    && synthAlertRows.filter((row) => row.kind === 'recovered').every((row) => Number(row.totalMB) < Number(row.thresholdMB)),
    { thresholdMB: synthFirst.thresholdMB, rows: synthAlertRows });
  check('B16 synthetic：每行字段齐全（at/kind/totalMB/thresholdMB/source；超限/hard-cap 带 top）',
    synthAlertRows.length === 6 && synthAlertRows.every((row) => typeof row.at === 'string' && !Number.isNaN(Date.parse(row.at))
      && ['threshold', 'hard-cap', 'recovered'].includes(String(row.kind))
      && Number(row.totalMB) > 0 && Number(row.thresholdMB) > 0 && String(row.source) === 'sampler'
      && (row.kind === 'recovered' ? true : (Array.isArray(row.top) && row.top.length >= 1))),
    synthAlertRows);
  const synthCrashRows = readJsonl(synth.crashFile);
  const synthCrash = synthCrashRows.find((row) => row.kind === 'b2dd3-attribution') || {};
  const synthAttr = synthCrash.attribution || null;
  check('B17 synthetic：崩溃归因仍读真实采样（totalMB>0 / exceededThreshold=false / samplerLastAt 可解析）',
    Boolean(synthAttr) && Number(synthAttr.totalMB) > 0 && synthAttr.exceededThreshold === false
    && Number(synthAttr.thresholdMB) === 1843
    && typeof synthAttr.samplerLastAt === 'string' && !Number.isNaN(Date.parse(synthAttr.samplerLastAt))
    && synthCrash.attributionUnavailable === false,
    { attribution: synthAttr });
  const unavailableCheck = Boolean(synthReport) && Array.isArray(synthReport.checks)
    ? synthReport.checks.find((row) => String(row.name || '').includes('无采样时归因写 null'))
    : null;
  check('B18 synthetic：无采样时归因写 null + attributionUnavailable=true（不编数字，探针内断言通过）',
    Boolean(unavailableCheck) && unavailableCheck.pass === true, unavailableCheck);

  const realAlertAfter = listRealAlertFiles();
  check('B19 隔离：行为测试前后真实 团队/ 的 内存告警.jsonl 集合完全一致（没往真实状态写）',
    JSON.stringify(realAlertAfter) === JSON.stringify(realAlertBefore),
    { before: realAlertBefore, after: realAlertAfter });
}
if (NO_ELECTRON) console.log('（--no-electron：跳过行为与回归断言）');

const total = pass + fail;
console.log(`\nB2DD3_MEM_ALERT ${fail === 0 ? 'OK' : 'FAIL'}  ${pass}/${total} 通过${fail ? '，失败 ' + fail : ''}`);
if (real || synth) {
  console.log('证据目录：' + SB);
  if (real) console.log('  real     alert=' + real.alertFile + ' crash=' + real.crashFile + ' report=' + real.reportFile);
  if (synth) console.log('  synthetic alert=' + synth.alertFile + ' crash=' + synth.crashFile + ' report=' + synth.reportFile);
}
if (fail) {
  console.log('失败项：');
  for (const row of failures) console.log(' - ' + row.name + ' ' + JSON.stringify(row.detail === undefined ? null : row.detail).slice(0, 500));
}
process.exitCode = fail === 0 ? 0 : 1;
