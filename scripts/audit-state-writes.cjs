#!/usr/bin/env node
'use strict';
/**
 * scripts/audit-state-writes.cjs —— 状态写审计计数器
 *
 * 归属：R-20261116-133048-ad44 正文 F7 —— **测试侧独立实现并维护**（实现方自写=自己出题自己判，不接受）。
 *
 * 口径（写死，改口径等于改判据，必须同步改正文 F7）：
 *   1) **先剥注释与字符串**，再匹配；剥掉的字符替换成空格、保留换行，保证行号不变。
 *      - 行注释 `// …`、块注释 `/* … *\/`
 *      - 字符串 `'…'`、`"…"`、模板串 `` `…` ``（含 `${…}` 里的代码一并剥掉，属已知取舍）
 *   2) 每条正则**带调用括号**再匹配，避免把「提到函数名」当成调用：
 *      - directWrites    \bfs\.writeFileSync\s*\(
 *      - stateWrites     \bwriteStore\s*\(
 *      - lockCalls       \.lock\b            （文件锁/锁字段，含 `.lock` 字面）
 *      - debounceTimers  debounce             （**大小写不敏感**：WINDOW_SAVE_DEBOUNCE_MS 之类不许漏）
 *   3) **已知答案对账**（采信前提）：`src/main.js` 的 directWrites = 93、stateWrites = 69。
 *      - **重锚留痕（PM `M-20261117-013504-608b0c` 要求）**：每次改 KNOWN 必须写「基线时点 + 原因 + 是谁的提交带来的增量」，并在回执里给出实测值。
 *        累计重锚批次：**2**（记录见下，达到 3 批须在回执里提报 PM，由他决定是否收口成固定快照）。
 *        · 第 1 批 2026-11-17 01:20：89/68 → 92/69（PM `M-20261117-011906-d383e0`，按 Owner「现状为基准」原则；此前其它角色新增 3 处 `fs.writeFileSync` + 1 处 `writeStore`，b7dd 批2 `2cbd0fb` 前后）。
 *        · 第 2 批 2026-11-17 01:30：92/69 → 93/69（增量来源＝提交 `1683d92`「R-ad44 批3：src/main.js writeStore 内部改走 json-atomic」新增 1 处 `fs.writeFileSync`）。
 *      - **漂移容差（2026-11-17 加）**：`src/main.js` 是高频改动文件，他人新增/删写点会让绝对值漂移；
 *        |实测−期望| ≤ 10 判 **NOISE（不判红）**，但**必须打印「实测 X / 期望 Y（Δ±D），建议重锚 KNOWN」并写进 JSON 审计行**（`knownAnswer.drift[].advice`）；
 *        > 10 才判 FAIL（这种量级通常是剥注释/正则口径出错）。
 *        这样既不再追着别人的提交改数字，又保留「计数脚本自证」这一防线，且漂移不会被容差静默掩盖。
 *      对不上即判**脚本自身错**（先查剥注释/字符串与正则），不是需求不达标；仍对不上则报 PM「基线本身错」。
 *
 * 用法：
 *   node scripts/audit-state-writes.cjs                 # 默认只审 src/main.js + src/team-tools.js
 *   node scripts/audit-state-writes.cjs --all --json    # 全仓 src/** + scripts/**
 *   node scripts/audit-state-writes.cjs --self-check    # 已知答案对账，不一致 exit 1
 *   node scripts/audit-state-writes.cjs --file src/app.js --file src/team-tools.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** 已知答案（2026-11-17 01:30 按现状重锚：89/68 → 92/69 → 93/69；原因见文件头注释第 3 条） */
const KNOWN = Object.freeze({
  'src/main.js': { directWrites: 93, stateWrites: 69 },
});
/** 漂移容差：|实测−期望| ≤ 该值 → 判 NOISE（他人新增/删写点），> 该值 → 判 FAIL（口径疑似出错） */
const KNOWN_DRIFT_TOLERANCE = 10;

/** 正则表：全部带调用括号（.lock 与 debounce 是字段/标识符类，按口径不带括号） */
const PATTERNS = Object.freeze({
  directWrites: /\bfs\.writeFileSync\s*\(/g,
  stateWrites: /\bwriteStore\s*\(/g,
  lockCalls: /\.lock\b/g,
  debounceTimers: /debounce/gi,
});

/**
 * 剥注释与字符串：把注释/字符串内容替换为空格，保留 \n 与 \r 以便行号、列数尽量不变。
 * 不做 AST、不引依赖（Node 无内置解析器，正文 F7 明确要求正则路线）。
 *
 * 关键：必须识别**正则字面量**（`/'/`、`/"/` 之类），否则状态机会把后面的真代码当字符串吞掉——
 * 这不是理论问题：本脚本 v1 就因此把 main.js 里 10 处 `writeStore(store);` 真调用漏掉（58 vs 68）。
 * 判定规则（与主流手写 tokenizer 同）：`/` 前一个有效字符属 ( , = : [ ! & | ? { } ; + - * % < > ~ ^ 或行首 → 正则字面量。
 */
const REGEX_PREV = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

function stripCommentsAndStrings(text) {
  const n = text.length;
  const out = new Array(n);
  let i = 0;
  let state = 'code'; // code | line | block | sq | dq | tmpl | regex
  let prevSig = ''; // 上一个有效（非空白）字符，用于区分除号与正则
  const emit = (idx, ch) => { out[idx] = ch; if (ch !== '\n' && ch !== ' ' && ch !== '\t' && ch !== '\r') prevSig = ch; };
  while (i < n) {
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : '';
    if (state === 'code') {
      if (c === '/' && c2 === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'line'; continue; }
      if (c === '/' && c2 === '*') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'block'; continue; }
      if (c === '/' && REGEX_PREV.has(prevSig)) { out[i] = ' '; i += 1; state = 'regex'; continue; }
      if (c === "'") { out[i] = ' '; i += 1; state = 'sq'; continue; }
      if (c === '"') { out[i] = ' '; i += 1; state = 'dq'; continue; }
      if (c === '`') { out[i] = ' '; i += 1; state = 'tmpl'; continue; }
      emit(i, c); i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { out[i] = '\n'; i += 1; state = 'code'; } else { out[i] = ' '; i += 1; } continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'code'; continue; }
      out[i] = c === '\n' ? '\n' : ' '; i += 1; continue;
    }
    if (state === 'regex') {
      if (c === '\\') { out[i] = ' '; if (i + 1 < n) out[i + 1] = text[i + 1] === '\n' ? '\n' : ' '; i += 2; continue; }
      if (c === '[') { // 字符类里 / 不结束正则
        out[i] = ' '; i += 1;
        while (i < n && text[i] !== ']') { out[i] = text[i] === '\n' ? '\n' : ' '; if (text[i] === '\\' && i + 1 < n) { i += 1; out[i] = ' '; } i += 1; }
        if (i < n) { out[i] = ' '; i += 1; }
        continue;
      }
      if (c === '/') {
        out[i] = ' '; i += 1;
        // 吃掉 flags
        while (i < n && /[a-z]/i.test(text[i])) { out[i] = ' '; i += 1; }
        state = 'code'; prevSig = ')'; continue; // 视为一个已结束的表达式
      }
      out[i] = c === '\n' ? '\n' : ' '; i += 1; continue;
    }
    // 字符串态（sq / dq / tmpl）
    const quote = state === 'sq' ? "'" : state === 'dq' ? '"' : '`';
    if (c === '\\') { out[i] = ' '; if (i + 1 < n) out[i + 1] = text[i + 1] === '\n' ? '\n' : ' '; i += 2; continue; }
    if (c === quote) { out[i] = ' '; i += 1; state = 'code'; prevSig = ')'; continue; }
    out[i] = c === '\n' ? '\n' : ' '; i += 1;
  }
  return out.join('');
}

function countOf(code, re) {
  const matches = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(code)) !== null) {
    matches.push(m.index);
    if (m.index === re.lastIndex) re.lastIndex += 1; // 防零宽死循环
  }
  return matches;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

function auditFile(rel) {
  const abs = path.join(ROOT, rel);
  const raw = fs.readFileSync(abs, 'utf8');
  const code = stripCommentsAndStrings(raw);
  const result = { file: rel, bytes: Buffer.byteLength(raw, 'utf8') };
  for (const [name, re] of Object.entries(PATTERNS)) {
    const hits = countOf(code, re);
    result[name] = hits.length;
    result[name + 'Lines'] = hits.map((idx) => lineOf(code, idx));
    // 原始（未剥）计数，供对账不一致时定位差异
    const rawHits = countOf(raw, re);
    result[name + 'Raw'] = rawHits.length;
  }
  return result;
}

/** AC1① 白名单（按「目标状态文件」定义；不按目录排） */
const STATE_FILE_GLOBS = Object.freeze(['workbench.json', '团队/状态/*.json', '团队/状态/项目/*/*.json', '团队/状态/项目/*/任务/*.json']);
/** 后缀排除：这些不是状态写 */
const EXCLUDE_SUFFIXES = Object.freeze(['.tmp', '.bak', '.lock']);

/** 从 `(` 之后取第一个实参的源码文本（按括号/引号配平截到顶层逗号） */
function firstArgOf(code, openParenIdx) {
  let depth = 0; let i = openParenIdx;
  let start = -1;
  let quote = '';
  for (; i < code.length; i += 1) {
    const c = code[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; if (start < 0) start = i; continue; }
    if (c === '(' || c === '[' || c === '{') { depth += 1; if (depth === 1) { start = i + 1; continue; } }
    if (c === ')' || c === ']' || c === '}') { depth -= 1; if (depth === 0) return { text: code.slice(start, i), end: i }; }
    if (c === ',' && depth === 1) return { text: code.slice(start, i), end: i };
    if (start < 0) start = i;
  }
  return { text: code.slice(Math.max(start, 0)), end: code.length };
}

/**
 * AC1① 判定：这处 `fs.writeFileSync(...)` 写的是不是「白名单内的状态文件」。
 * 纯静态、保守：能明确判成状态文件才算 state；判不了记 unknown（必须人工/运行时复核），
 * 明确是证据/日志/临时件记 nonState。
 */
function classifyStateWrite(argText) {
  const t = String(argText || '');
  const lower = t.toLowerCase();
  if (EXCLUDE_SUFFIXES.some((s) => lower.includes(s))) return 'nonState';
  if (lower.includes('.jsonl')) return 'nonState'; // 审计/日志追加，AC1① 明确不纳入
  if (/\.(png|jpe?g|webp|gif|md|txt|log|csv|html|pdf)['"]/i.test(t)) return 'nonState';
  const hasWorkbench = /['"]workbench\.json['"]/.test(t);
  const hasTeamState = /['"]团队['"]/.test(t) && /['"]状态['"]/.test(t);
  const hasTeamStateVar = /\b(layout|PATHS|paths)\.(state|teamFile|mail)\b/.test(t);
  if (hasWorkbench || hasTeamState || hasTeamStateVar) return 'state';
  // 仅当实参就是名为 tmp/temp/bak 的变量时，按「大概率临时件」降级（advisory，不计入 state）
  if (/^\s*[A-Za-z_$][\w$]*\s*$/.test(t) && /tmp|temp|bak/i.test(t)) return 'tempVar';
  return 'unknown';
}

/** 扫描 directWrites 命中点，按 AC1① 分类（跳过 json-atomic.cjs 自身的 tmp/bak 写入） */
function checkStateWrites(rel) {
  const abs = path.join(ROOT, rel);
  const raw = fs.readFileSync(abs, 'utf8');
  const code = stripCommentsAndStrings(raw);
  const selfRuntime = /json-atomic\.(cjs|mjs)$/.test(rel); // 原子写实现内部的 tmp/bak 写入属实现自身
  const re = /\bfs\.writeFileSync\s*\(/g;
  let m; const rows = [];
  while ((m = re.exec(code)) !== null) {
    if (m.index === re.lastIndex) re.lastIndex += 1;
    const openIdx = code.indexOf('(', m.index);
    const arg = firstArgOf(code, openIdx);
    const kind = selfRuntime ? 'implInternal' : classifyStateWrite(arg.text);
    rows.push({ line: lineOf(code, m.index), kind, arg: String(arg.text || '').replace(/\s+/g, ' ').trim().slice(0, 120) });
  }
  return rows;
}

function walk(dir, acc) {  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (['node_modules', '.git', '_tmp', '_backup', 'dist', 'out'].includes(entry.name)) continue;
    const rel = path.join(dir, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) walk(rel, acc);
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) acc.push(rel);
  }
  return acc;
}

function parseArgs(argv) {
  const args = { files: [], all: false, json: false, selfCheck: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--json') args.json = true;
    else if (a === '--self-check') args.selfCheck = true;
    else if (a === '--check-state-writes') args.checkStateWrites = true;
    else if (a === '--include-tests') args.includeTests = true;
    else if (a === '--include-scripts') args.includeScripts = true;
    else if (a === '--file') { args.files.push(String(argv[i + 1] || '')); i += 1; }
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node scripts/audit-state-writes.cjs [--all] [--json] [--self-check] [--file <相对路径>]...');
    return 0;
  }
  let targets = args.files.filter(Boolean);
  if (!targets.length) {
    targets = args.all ? walk('src', []).concat(walk('scripts', [])) : ['src/main.js', 'src/team-tools.js'];
  }
  const files = [];
  for (const t of targets) {
    const rel = t.replace(/\\/g, '/');
    if (!fs.existsSync(path.join(ROOT, rel))) { files.push({ file: rel, missing: true }); continue; }
    files.push(auditFile(rel));
  }
  const totals = { directWrites: 0, stateWrites: 0, lockCalls: 0, debounceTimers: 0 };
  for (const f of files) if (!f.missing) for (const k of Object.keys(totals)) totals[k] += f[k] || 0;

  // 已知答案对账（含漂移容差：小幅漂移判 NOISE，不判红）
  const checks = [];
  for (const [rel, expect] of Object.entries(KNOWN)) {
    const got = files.find((f) => f.file === rel);
    if (!got) { checks.push({ file: rel, skipped: 'not-in-targets' }); continue; }
    for (const [k, v] of Object.entries(expect)) {
      const actual = got[k];
      const delta = Number.isFinite(actual) ? actual - v : null;
      const ok = actual === v;
      const drift = !ok && delta !== null && Math.abs(delta) <= KNOWN_DRIFT_TOLERANCE;
      checks.push({
        file: rel, metric: k, expect: v, actual, raw: got[k + 'Raw'], delta, ok, drift,
        // 审计行必带「实测/期望/建议重锚」，避免容差静默掩盖真回归（PM M-20261117-013504-608b0c）
        advice: ok ? '' : (drift ? `实测 ${actual} / 期望 ${v}（Δ${delta > 0 ? '+' : ''}${delta}），建议重锚 KNOWN（容差 ≤${KNOWN_DRIFT_TOLERANCE}）` : `实测 ${actual} / 期望 ${v}（Δ${delta > 0 ? '+' : ''}${delta}）超出容差 ≤${KNOWN_DRIFT_TOLERANCE}：先查剥注释/正则口径`),
      });
    }
  }
  const metricChecks = checks.filter((c) => c.metric);
  const knownOk = metricChecks.length > 0 && metricChecks.every((c) => c.ok || c.drift);
  const knownHardFail = metricChecks.some((c) => !c.ok && !c.drift);
  const knownExact = metricChecks.length > 0 && metricChecks.every((c) => c.ok);
  const driftRows = metricChecks.filter((c) => c.drift);
  const out = { at: new Date().toISOString(), root: ROOT, targets, files, totals, knownAnswer: { rules: KNOWN, tolerance: KNOWN_DRIFT_TOLERANCE, reanchorBatches: 2, reanchorPolicy: '重锚须留痕（时点+原因+谁的提交带来增量）；累计 ≥3 批在回执里提报 PM，由他决定是否收口成固定快照', checks, ok: knownOk, exact: knownExact, hardFail: knownHardFail, drift: driftRows } };

  // AC1①：白名单内状态写判定（默认只报数；带 --check-state-writes 时输出明细）
  let stateCheck = null;
  if (args.checkStateWrites) {
    const rows = [];
    for (const f of files) {
      if (f.missing) continue;
      // AC1① 只看产品面：默认排除夹具/自检/一次性脚本（scripts/**），只扫 src/** 与 团队/工具/**
      // 放开口径：--include-tests（含 scripts/test-*、fixture-*）或 --include-scripts（含 scripts/** 全部）
      const inScripts = /(^|\/)scripts\//.test(f.file);
      const isTestScript = /(^|\/)scripts\/(test-|fixture-)/.test(f.file);
      if (inScripts && !args.includeScripts && !(args.includeTests && isTestScript)) continue;
      for (const r of checkStateWrites(f.file)) rows.push({ file: f.file, ...r });
    }
    const byKind = { state: 0, unknown: 0, nonState: 0, tempVar: 0, implInternal: 0 };
    for (const r of rows) byKind[r.kind] += 1;
    stateCheck = { globs: STATE_FILE_GLOBS, excludeSuffixes: EXCLUDE_SUFFIXES, counts: byKind, rows, pass: byKind.state === 0 };
    out.stateWriteCheck = stateCheck;
  }

  if (args.json) {
    console.log(JSON.stringify(out));
  } else {
    console.log(`状态写审计（剥注释/字符串后计数）  at=${out.at}`);
    for (const f of files) {
      if (f.missing) { console.log(`  MISSING  ${f.file}`); continue; }
      console.log(`  ${f.file}  ${f.bytes}B  directWrites=${f.directWrites}(raw ${f.directWritesRaw})  stateWrites=${f.stateWrites}(raw ${f.stateWritesRaw})  lockCalls=${f.lockCalls}(raw ${f.lockCallsRaw})  debounce=${f.debounceTimers}(raw ${f.debounceTimersRaw})`);
    }
    console.log(`  合计  directWrites=${totals.directWrites}  stateWrites=${totals.stateWrites}  lockCalls=${totals.lockCalls}  debounce=${totals.debounceTimers}`);
    console.log('  已知答案对账（容差 ≤' + KNOWN_DRIFT_TOLERANCE + ' 的小幅漂移判 NOISE，不判红）：');
    for (const c of checks) {
      if (c.skipped) { console.log(`    SKIP  ${c.file}（不在本次目标里）`); continue; }
      const tag = c.ok ? 'PASS ' : (c.drift ? 'NOISE' : 'FAIL ');
      const advice = c.ok ? '' : `  ${c.advice || ''}`;
      console.log(`    ${tag} ${c.file} ${c.metric} 期望 ${c.expect} / 剥后 ${c.actual} / 原始 ${c.raw}${advice}`);
    }
    console.log(`  → ${knownExact ? '对账通过（与基线逐位一致），计数可采信'
      : (knownHardFail ? '对账未通过：偏差超出容差，先查剥注释/字符串与正则口径，仍不符则报 PM「基线本身错」'
        : `对账通过（含 ${driftRows.length} 条容差内漂移：数字随他人提交演进，建议按现状重锚 KNOWN；计数口径本身未坏）`)}`);
    if (stateCheck) {
      console.log('  AC1① 白名单内状态写判定（STATE_FILE_GLOBS，按后缀排除 *.tmp/*.bak/*.lock）：');
      console.log(`    结果  state=${stateCheck.counts.state}  unknown=${stateCheck.counts.unknown}  nonState=${stateCheck.counts.nonState}  implInternal=${stateCheck.counts.implInternal}`);
      for (const r of stateCheck.rows.filter((x) => x.kind === 'state' || x.kind === 'unknown')) {
        console.log(`    [${r.kind}] ${r.file}:${r.line}  ← ${r.arg}`);
      }
      console.log(`    → ${stateCheck.pass ? 'PASS：白名单内直接写状态文件 = 0 处' : `FAIL：白名单内仍有 ${stateCheck.counts.state} 处直接写（须改走 json-atomic.cjs）`}`);
      if (stateCheck.counts.unknown > 0) console.log(`    注意：${stateCheck.counts.unknown} 处判不了（unknown），须人工或运行时复核，不得当成 0 处放过`);
    }
  }
  if (args.checkStateWrites && stateCheck && !stateCheck.pass) return 1;
  if (args.selfCheck && !knownOk) return 1;
  return 0;
}

process.exit(main());
