'use strict';
/**
 * render-memory.js —— R-c1ed F-1（渲染内存采样分片 / 保留 / 取数通道）的纯逻辑 + 落盘
 *
 * 口径来源：需求/R-20261115-140436-c1ed（正文 14030B/42a3ba8d）+ 需求/增补卷-c1ed-1.md（9278B/0051d99e）
 *   §2.1 水位采样 `渲染内存-YYYYMMDD.jsonl`，同日溢出切 `-2`/`-3`…；崩溃归档 `渲染崩溃/<ts>/`；保留审计 `渲染保留.jsonl`
 *   §2.2 单分片 5242880B；采样保留 7 天；崩溃归档 30 天且 ≤50 目录；单行不得跨分片
 *   §2.4 只删白名单内路径（渲染内存-*.jsonl / 渲染崩溃/<ts>/），不删当天/近 7 天/正在写的分片
 *   §3.1 readRenderMemoryWindow(projectPath,{atCrash,windowSec=300}) 末分片倒读 + 续读上一分片；只读
 *   §3.2 行字段 {at,pid,type,guestUrl,workingSetMB,cause}；首行 kind:'boot'；降级补 {cause:'interval',intervalMs:5000}
 *   §3.3 R1 连续性 / R2 null 占比 ≤10% / R3 coverageSec ≥295
 *
 * 设计：只依赖 node:fs / node:path；不读不写白名单以外的任何文件。
 */

const fs = require('node:fs');
const path = require('node:path');

const SHARD_MAX_BYTES = 5242880;
const SAMPLE_RETENTION_DAYS = 7;
const CRASH_RETENTION_DAYS = 30;
const CRASH_MAX_DIRS = 50;
const SHARD_RE = /^渲染内存-(\d{8})(?:-(\d+))?\.jsonl$/;
const SAMPLE_FIELDS = ['at', 'pid', 'type', 'guestUrl', 'workingSetMB', 'cause'];

function dateKeyOf(date) {
  const d = date instanceof Date ? date : new Date(date === undefined ? Date.now() : date);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function shardNameOf(dateKey, index) {
  const n = Number(index) || 1;
  return n <= 1 ? `渲染内存-${dateKey}.jsonl` : `渲染内存-${dateKey}-${n}.jsonl`;
}

/** 列出某项目下的采样分片（只认白名单命名），按日期、再按 N 升序。 */
function listShards(projectPath) {
  const dir = String(projectPath || '');
  if (!dir) return [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const rows = [];
  for (const name of names) {
    const m = SHARD_RE.exec(name);
    if (!m) continue;
    rows.push({ name, rel: name, dateKey: m[1], index: Number(m[2] || 1), path: path.join(dir, name) });
  }
  rows.sort((a, b) => (a.dateKey === b.dateKey ? a.index - b.index : a.dateKey.localeCompare(b.dateKey)));
  return rows;
}

function fileBytes(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/** 采样行归一（增补卷-c1ed-3 §三 写死：cause 五值白名单、7 键；卷三已取消 5s 行频降级）。 */
function normalizeSampleLine(row) {
  const src = row && typeof row === 'object' ? row : {};
  const CAUSES = ['boot', 'sample', 'reused', 'degraded', 'recovered'];
  const out = {};
  for (const key of SAMPLE_FIELDS) out[key] = src[key] === undefined ? null : src[key];
  out.at = String(src.at || new Date().toISOString());
  out.pid = src.pid === undefined || src.pid === null ? null : Number(src.pid);
  out.type = String(src.type || 'renderer');
  out.guestUrl = src.guestUrl === undefined ? null : src.guestUrl;
  out.workingSetMB = src.workingSetMB === undefined || src.workingSetMB === null ? null : Number(src.workingSetMB);
  const cause = String(src.cause || 'sample');
  out.cause = CAUSES.includes(cause) ? cause : 'sample';
  if (src.kind) out.kind = String(src.kind);
  // 卷三：复用行必须带 sampledFrom（真实采样时刻）+ staleSec；真采样行 sampledFrom===at。
  if (src.sampledFrom !== undefined && src.sampledFrom !== null) out.sampledFrom = String(src.sampledFrom);
  if (src.staleSec !== undefined && src.staleSec !== null && Number.isFinite(Number(src.staleSec))) out.staleSec = Number(src.staleSec);
  if (out.cause !== 'reused' && !out.sampledFrom && ['boot', 'sample', 'recovered'].includes(out.cause)) out.sampledFrom = out.at;
  // 卷三：degraded 行 sampledFrom=null、workingSetMB=null（正常兜底，不是坏行）
  if (out.cause === 'degraded') { out.sampledFrom = null; out.workingSetMB = null; }
  // 卷四①：进程变化触发的强制真采样行标 forced（不计入密度分母）。
  if (src.forced === true) out.forced = true;
  return out;
}

/** 当前分片缓存（dir|dateKey → {path,index,dateKey}）：避免每拍都 readdir+stat 全目录（实测那是 11ms 级开销）。 */
const shardCache = new Map();

function cachedShards(dir, dateKey) {
  const key = `${dir}|${dateKey}`;
  const hit = shardCache.get(key);
  if (hit && Array.isArray(hit.list)) return hit.list;
  return null;
}

/**
 * 追加一行采样：预判「当前分片字节 + 本行字节 > 5242880」→ 切下一个分片；单行不跨分片。
 * 返回 {file, created, bytes}；写盘失败抛错由调用方降级（fail-open）。
 */
function appendSample(projectPath, row, options = {}) {
  const dir = String(projectPath || '');
  if (!dir) throw new Error('PROJECT_PATH_REQUIRED');
  const dateKey = String(options.dateKey || dateKeyOf(options.at || row && row.at));
  const line = JSON.stringify(normalizeSampleLine(row)) + '\n';
  const lineBytes = Buffer.byteLength(line, 'utf8');
  if (lineBytes > SHARD_MAX_BYTES) throw new Error('SAMPLE_LINE_TOO_LARGE');
  fs.mkdirSync(dir, { recursive: true });
  const cacheKey = `${dir}|${dateKey}`;
  let cached = shardCache.get(cacheKey);
  if (!cached) {
    const shards = listShards(dir).filter((item) => item.dateKey === dateKey);
    const last = shards.length ? shards[shards.length - 1] : null;
    cached = { path: last ? last.path : '', index: last ? last.index : 0, bytes: last ? fileBytes(last.path) : 0 };
    shardCache.set(cacheKey, cached);
  }
  let created = false;
  if (!cached.path || cached.bytes + lineBytes > SHARD_MAX_BYTES) {
    const nextIndex = cached.index ? cached.index + 1 : 1;
    const name = shardNameOf(dateKey, nextIndex);
    cached = { path: path.join(dir, name), index: nextIndex, bytes: fileBytes(path.join(dir, name)) };
    shardCache.set(cacheKey, cached);
    created = true;
  }
  fs.appendFileSync(cached.path, line, 'utf8');
  cached.bytes += lineBytes;
  return { file: cached.path, created, bytes: cached.bytes, lineBytes };
}

/** 测试/清理用：清空分片缓存（外部删了分片后要清，否则会写回旧路径）。 */
function resetShardCache() {
  shardCache.clear();
}

/** 读一个分片（容错：坏行跳过并记 read_failed）。 */
function readShardRows(shard) {
  const out = [];
  let text = '';
  try { text = fs.readFileSync(shard.path, 'utf8'); } catch { return { rows: out, readFailed: true }; }
  let failed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { failed += 1; }
  }
  return { rows: out, readFailed: failed > 0 };
}

/** §3.1 唯一取数通道：从末分片末尾倒读，不足续读上一分片，直到凑够 windowSec 或耗尽。 */
function readRenderMemoryWindow(projectPath, options = {}) {
  const windowSec = Number(options.windowSec) > 0 ? Number(options.windowSec) : 300;
  const atCrashMs = Date.parse(String(options.atCrash || ''));
  const cutoff = Number.isFinite(atCrashMs) ? atCrashMs - windowSec * 1000 : NaN;
  const shards = listShards(projectPath);
  const lines = [];
  const daysRead = [];
  let insufficient = false;
  const enough = () => {
    if (!lines.length) return false;
    const first = Date.parse(String(lines[0].at || ''));
    if (!Number.isFinite(first)) return false;
    return Number.isFinite(cutoff) ? first <= cutoff : true;
  };
  const byDay = [...new Set(shards.map((s) => s.dateKey))].sort().reverse();
  let shardReadFailed = false;
  const shardBadLines = [];
  for (const day of byDay) {
    daysRead.push(day);
    const dayShards = shards.filter((s) => s.dateKey === day).sort((a, b) => b.index - a.index);
    const chunk = [];
    for (const shard of dayShards) {
      const { rows, readFailed: shardBad } = readShardRows(shard);
      if (shardBad) { shardReadFailed = true; shardBadLines.push(shard.name); }
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        const at = Date.parse(String(row && row.at || ''));
        if (Number.isFinite(at) && Number.isFinite(atCrashMs) && at > atCrashMs) continue;
        if (Number.isFinite(at) && Number.isFinite(cutoff) && at < cutoff) continue;
        chunk.push(row);
      }
      const merged = chunk.slice().reverse();
      if (merged.length && Number.isFinite(cutoff)) {
        const firstMs = Date.parse(String(merged[0] && merged[0].at || ''));
        if (Number.isFinite(firstMs) && firstMs <= cutoff) break;
      }
    }
    const ordered = chunk.slice().reverse();
    lines.unshift(...ordered);
    if (enough()) break;
  }
  if (!lines.length) insufficient = true;
  const firstAt = lines.length ? String(lines[0].at || '') : '';
  const lastAt = lines.length ? String(lines[lines.length - 1].at || '') : '';
  const firstMs = Date.parse(firstAt);
  const lastMs = Date.parse(lastAt);
  const coverageSec = Number.isFinite(firstMs) && Number.isFinite(lastMs) ? Math.max(0, Math.round((lastMs - firstMs) / 1000)) : 0;
  const gaps = [];
  for (let i = 1; i < lines.length; i += 1) {
    const prev = Date.parse(String(lines[i - 1].at || ''));
    const cur = Date.parse(String(lines[i].at || ''));
    if (Number.isFinite(prev) && Number.isFinite(cur)) {
      const sec = Math.round((cur - prev) / 1000);
      // 卷2 §四 / 卷3 §六：gaps 统一四键结构 {from,to,sec,reason}
      if (sec > 2) gaps.push({ from: String(lines[i - 1].at || ''), to: String(lines[i].at || ''), sec, reason: sec > 10 ? 'GAP_GT_10S' : 'GAP_GT_2S' });
    }
  }
  if (coverageSec + 1 < windowSec) insufficient = true;
  // ── 卷2 §四 返回矩阵（A/B/C/D），优先级 readFailed > insufficient ──────────────
  const readFailed = shardReadFailed;
  const dir = String(projectPath || '');
  const noShards = shards.length === 0;
  let samplingDisabled = false;
  if (options.forceSamplingDisabled === true) samplingDisabled = true;
  else if (dir) {
    // 卷2 §四 A 行 + 返工单 §六③：24h 内没有任何分片（无分片或最新分片都早于 24h）→ SAMPLING_DISABLED（判 FAIL）。
    try {
      const dirAgeMs = Date.now() - fs.statSync(dir).mtimeMs;
      const newestShardMs = shards.reduce((max, shard) => {
        try { return Math.max(max, fs.statSync(shard.path).mtimeMs); } catch { return max; }
      }, 0);
      const newestMs = Math.max(newestShardMs, 0);
      samplingDisabled = noShards ? dirAgeMs > 24 * 3600 * 1000 : (newestMs > 0 && Date.now() - newestMs > 24 * 3600 * 1000);
    } catch { samplingDisabled = false; }
  }
  // D 行（卷2 §四）NO_PREV_SHARD：窗口不够，且「确实没有前一日分片可续」——
  // 判据=①窗口未凑够；②有数据（不是 A 行）；③盘上不存在早于 atCrash 当天的任何分片；
  //      ④窗口已取到当天最早分片的第一行（说明当天能给的都给了）。
  // 不满足 ③ 时说明还有前日分片可续（那就是别的异常，不能冒充 D 行）。
  const prevShardMissing = (() => {
    if (!insufficient || !lines.length) return false;
    const atCrashDayKey = dateKeyOf(options.atCrash || Date.now());
    const earlier = shards.filter((s) => s.dateKey < atCrashDayKey);
    if (earlier.length) return false;
    const todayShards = shards.filter((s) => s.dateKey === atCrashDayKey).sort((a, b) => a.index - b.index);
    if (!todayShards.length) return false;
    const { rows } = readShardRows(todayShards[0]);
    if (!rows.length) return false;
    const firstInWindow = Date.parse(String(lines[0] && lines[0].at || ''));
    const firstInShard = Date.parse(String(rows[0] && rows[0].at || ''));
    return Number.isFinite(firstInWindow) && Number.isFinite(firstInShard) && firstInWindow <= firstInShard;
  })();
  const code = noShards
    ? (samplingDisabled ? 'SAMPLING_DISABLED' : 'NO_SAMPLE_FILE')
    : (readFailed
      ? (insufficient ? 'READ_FAILED' : 'PARTIAL_SHARD')
      : (insufficient ? (prevShardMissing ? 'NO_PREV_SHARD' : 'SAMPLING_WINDOW_INSUFFICIENT') : 'OK'));
  return {
    lines, firstAt, lastAt, coverageSec, gaps, insufficient, windowSec,
    readFailed, code,
    // 只有 A(无文件)/已停采/双坏(B) 才判 FAIL；C(末片坏但凑满) 与窗口不足都不判 FAIL（卷2 §四）
    fail: code === 'READ_FAILED' || code === 'SAMPLING_DISABLED',
    samplingDisabled,
    prevShardMissing,
    atCrash: String(options.atCrash || ''),
    daysRead, shardsRead: daysRead,
    badLineShards: shardBadLines,
  };
}

/**
 * 可复原判据（增补卷-c1ed-3 §六 写死 + 卷四 三条裁定）：
 *  R1 全行：相邻 at 差 ≤2s；单缺口 ≤10s；累计缺口 ≤30s
 *  R2 分母=全行 − cause='degraded' 行：workingSetMB 非 null 占比 ≥95%（degraded 不判 FAIL）
 *  R3 全行首末：firstAt ≤ atCrash−295s 且 lastAt ≥ atCrash−5s（缺 atCrash 时退化为 coverageSec≥295）
 *  AC3 行数 ≥300（5 分钟窗口）；真点密度 ∈[15%,25%]，越界 → cadence.verdict='SAMPLE_CADENCE_BAD'
 *  卷四①：forced 行（进程变化触发的真采样）不计入密度分母；cadence 给 forced/hasForced
 */
function evaluateRecoverable(win, options = {}) {
  const window = win && typeof win === 'object' ? win : {};
  const lines = Array.isArray(window.lines) ? window.lines : [];
  const windowSec = Number(options.windowSec) > 0 ? Number(options.windowSec) : (Number(window.windowSec) || 300);
  const atCrashMs = Date.parse(String(options.atCrash || window.atCrash || ''));

  // R1：相邻差 ≤2s（全行），单缺口 ≤10s，累计缺口 ≤30s
  const gapRows = [];
  let cumulativeGapSec = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const prev = Date.parse(String(lines[i - 1].at || ''));
    const cur = Date.parse(String(lines[i].at || ''));
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) continue;
    const sec = Math.round((cur - prev) / 1000);
    if (sec > 2) {
      // 卷2 §四：gaps 四键 {from,to,sec,reason}
      gapRows.push({ from: String(lines[i - 1].at || ''), to: String(lines[i].at || ''), sec, reason: sec > 10 ? 'GAP_GT_10S' : 'GAP_GT_2S' });
      // 缺陷 B-cb78：累计缺口必须把**全部**缺口秒数相加（不能只加 >10s 的，否则 4×9s=36s 仍判真 = 假绿）
      cumulativeGapSec += sec;
    }
  }
  const singleGapsOk = gapRows.every((gap) => gap.sec <= 10);
  const r1 = lines.length > 1 && singleGapsOk && cumulativeGapSec <= 30;

  // R2：分母剔除 degraded 行；非 null 占比 ≥95%
  const measured = lines.filter((row) => String(row && row.cause || '') !== 'degraded');
  const nullCount = measured.filter((row) => !row || row.workingSetMB === null || row.workingSetMB === undefined).length;
  const nullRatio = measured.length ? nullCount / measured.length : 1;
  const r2 = measured.length > 0 && nullRatio <= 0.05;

  // R3：用 atCrash 判端点；没给 atCrash 时退化为 coverage 检查
  const firstMs = Date.parse(String(window.firstAt || (lines[0] && lines[0].at) || ''));
  const lastMs = Date.parse(String(window.lastAt || (lines[lines.length - 1] && lines[lines.length - 1].at) || ''));
  let r3;
  if (Number.isFinite(atCrashMs)) {
    r3 = Number.isFinite(firstMs) && Number.isFinite(lastMs)
      && firstMs <= atCrashMs - 295000 && lastMs >= atCrashMs - 5000;
  } else {
    r3 = (Number(window.coverageSec) || 0) >= Math.min(295, Math.max(0, windowSec - 5));
  }

  // 真点密度（卷三 §六 / 卷四①）：真点=sampledFrom===at，排除 boot 与 forced
  // PM 裁 M-20261115-164553-b59b04：forced 行**分子分母都剔除**——密度只在非强制真采样行上算，
  // 否则高 forced 窗口 densityPct 虚高（分子含 forced、分母不含）会把 5 分钟窗口假判红。
  const realPoints = lines.filter((row) => row && row.forced !== true && row.sampledFrom && String(row.sampledFrom) === String(row.at) && String(row.cause || '') !== 'boot').length;
  const forced = lines.filter((row) => row && row.forced === true).length;
  // PM 附注 b（正文本 2a6f086a）：forcedSamples = 因 pid 集合变化或降级恢复而强制真采样的次数，单独给 TR-Q 按环境判断用。
  const forcedSamples = lines.filter((row) => row && (row.forced === true || String(row.cause || '') === 'recovered')).length;
  // 卷四① + 返工单 §六②：forced 行从密度分母剔除，但**不再**给「有 forced 就整窗豁免」的假绿。
  const densityDenominator = lines.filter((row) => row && row.forced !== true && String(row.cause || '') !== 'boot').length;
  const densityPct = densityDenominator ? Math.round((realPoints / densityDenominator) * 1000) / 10 : 0;
  // PM 裁 M-20261115-161256-99f2ac（与 TRQ v4 对齐，取代 154738 的「只判下限」）：
  //   5 分钟窗口（windowSec ≤ 600）：双边 15–25%，越界（<15 或 >25）都判 SAMPLE_CADENCE_BAD；
  //   2 小时窗口（> 600）：只判下限（<15 才 BAD），>25% 只置 cadence.denseWarn=true、verdict 仍 OK。
  const lowerBad = densityPct < 15;
  const upperBad = densityPct > 25;
  const cadenceVerdict = ((windowSec <= 600 ? (lowerBad || upperBad) : lowerBad)) ? 'SAMPLE_CADENCE_BAD' : 'OK';
  const denseWarn = densityPct > 25;

  const cadence = { realPoints, forced, forcedSamples, hasForced: forcedSamples > 0, densityPct, denseWarn, verdict: cadenceVerdict };

  // PM 2026-11-16 裁定（c1ed AC3）：行数判据改为**覆盖率归一**——不再固定 300 行，
  // 而是「窗口覆盖 ≥290s 且行数 ≥ floor(coverageSec×0.98)」（平均行距 ≤1.0204s）。
  // 语义：coverage 不足走 SAMPLING_WINDOW_INSUFFICIENT/R3、不判 AC3；达标但 ratio<0.98 判「采样丢拍 sample_gap」；
  // 采样周期漂移由本条吸收，漏拍仍由 R1（缺口）判。
  const enoughLines = Number(window.coverageSec) >= 290
    && lines.length >= Math.floor(Number(window.coverageSec) * 0.98);
  const baseCode = (() => {
    if (!lines.length) return 'NO_SAMPLE_FILE';
    if (window.readFailed) return 'READ_FAILED';
    if (window.code === 'PARTIAL_SHARD') return 'PARTIAL_SHARD';
    if (Number(window.coverageSec) + 5 < windowSec) return 'SAMPLING_WINDOW_INSUFFICIENT';
    return 'OK';
  })();
  // PM 裁 M-20261115-155734-0e3913（返工单 §七）：restorable = R1∧R2∧R3 全真 **且** 行数达阈值；
  // 它只说明「这份窗口能不能用于复盘」，不参与需求 FAIL 判定（FAIL 只看 fail/code）。
  const restorable = r1 && r2 && r3 && enoughLines;
  return {
    recoverable: restorable,
    restorable,
    R1: r1,
    R2: r2,
    R3: r3,
    gaps: gapRows,
    cumulativeGapSec,
    nullRatio,
    coverageSec: Number(window.coverageSec) || 0,
    realPoints,
    forcedSamples,
    sampleCount: lines.length,
    enoughLines,
    degradedLines: lines.length - measured.length,
    cadence,
    code: restorable && baseCode === 'OK' && cadenceVerdict === 'OK' ? 'OK' : (cadenceVerdict !== 'OK' ? 'SAMPLE_CADENCE_BAD' : baseCode),
  };
}

/**
 * §2.2/§2.4 保留清理：算「该删什么」，不直接删（调用方执行并写 渲染保留.jsonl 审计）。
 * 白名单：采样只认 渲染内存-*.jsonl；崩溃只认 渲染崩溃/<ts>/ 目录。当天分片、近 7 天分片一律保留。
 */
function planRetention(projectPath, options = {}) {
  const dir = String(projectPath || '');
  const nowMs = Number(options.nowMs) > 0 ? Number(options.nowMs) : Date.now();
  const sampleKeepDays = Number(options.sampleKeepDays) >= 0 ? Number(options.sampleKeepDays) : SAMPLE_RETENTION_DAYS;
  const crashKeepDays = Number(options.crashKeepDays) >= 0 ? Number(options.crashKeepDays) : CRASH_RETENTION_DAYS;
  const crashMaxDirs = Number(options.crashMaxDirs) > 0 ? Number(options.crashMaxDirs) : CRASH_MAX_DIRS;
  const todayKey = dateKeyOf(new Date(nowMs));
  const removed = [];
  const kept = [];
  for (const shard of listShards(dir)) {
    if (shard.dateKey === todayKey) { kept.push(shard.rel); continue; }
    const shardMs = Date.parse(`${shard.dateKey.slice(0, 4)}-${shard.dateKey.slice(4, 6)}-${shard.dateKey.slice(6, 8)}T00:00:00`);
    if (!Number.isFinite(shardMs)) { kept.push(shard.rel); continue; }
    const ageDays = Math.floor((nowMs - shardMs) / 86400000);
    if (ageDays >= sampleKeepDays) removed.push(shard.rel);
    else kept.push(shard.rel);
  }
  const crashRoot = path.join(dir, '渲染崩溃');
  let crashDirs = [];
  try {
    crashDirs = fs.readdirSync(crashRoot, { withFileTypes: true })
      .filter((ent) => ent.isDirectory() && /^\d{8}T\d{6}Z?$/.test(ent.name))
      .map((ent) => {
        const ms = Date.parse(`${ent.name.slice(0, 4)}-${ent.name.slice(4, 6)}-${ent.name.slice(6, 8)}T${ent.name.slice(9, 11)}:${ent.name.slice(11, 13)}:${ent.name.slice(13, 15)}Z`);
        return { rel: path.posix.join('渲染崩溃', ent.name), name: ent.name, ms: Number.isFinite(ms) ? ms : 0, path: path.join(crashRoot, ent.name) };
      })
      .sort((a, b) => b.ms - a.ms);
  } catch { crashDirs = []; }
  const crashRemoved = [];
  crashDirs.forEach((item, index) => {
    const ageDays = item.ms ? Math.floor((nowMs - item.ms) / 86400000) : crashKeepDays + 1;
    if (ageDays >= crashKeepDays || index >= crashMaxDirs) crashRemoved.push(item.rel);
  });
  return { removed, crashRemoved, kept, todayKey, sampleKeepDays, crashKeepDays, crashMaxDirs };
}

const api = {
  SHARD_MAX_BYTES,
  SAMPLE_RETENTION_DAYS,
  CRASH_RETENTION_DAYS,
  CRASH_MAX_DIRS,
  SAMPLE_FIELDS,
  dateKeyOf,
  shardNameOf,
  listShards,
  normalizeSampleLine,
  appendSample,
  resetShardCache,
  readShardRows,
  readRenderMemoryWindow,
  evaluateRecoverable,
  planRetention
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.RenderMemory = api;
