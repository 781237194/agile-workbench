#!/usr/bin/env node
'use strict';
/**
 * test-b51b-tmp-prune.cjs —— B-20261117-140928-b51b 回归夹具（`team.mjs tmp prune`）
 *
 * 断言：
 *   AC1 默认 dry-run：只列候选、不删、不写审计；`--dry-run` 与 `--yes` 互斥；
 *   AC2 --yes 才真删：只删「递归最新 mtime 超过 N 分钟」的顶层目录；root 下文件永不删；
 *       `--keep`（精确名 + 末尾 * 前缀）保留；长跑沙盘（顶层旧、内有新文件）保留；
 *   AC3 删除前写审计 `团队/状态/项目/<项目>/沙盘清理.jsonl`（意图行 + 结果行两行，append-only）；
 *   AC4 参数校验：--minutes 非数字 → BAD_ARGS；--root 不存在 → TMP_ROOT_MISSING；
 *   AC5 幂等：再跑一次 --yes，removed 为空（没有可删项）。
 *
 * 隔离：mkTempSandbox 唯一目录；FAKE_ROOT 是自己造的假 _tmp，绝不动真实 `_tmp/`。
 * 用法：node scripts/test-b51b-tmp-prune.cjs
 * 退出码：0 全过 / 1 有断言失败 / 2 环境错误
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const SB = mkTempSandbox('b51b');
const TEAM = path.join(SB, '团队');
const FAKE = path.join(SB, 'fake_tmp');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const PROJECT = '沙盘清理夹具';

let passed = 0;
const failures = [];
const records = [];
function check(name, ok, detail) {
  records.push({ name, ok, detail: ok ? '' : detail });
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 300)}`);
}
function env() {
  return {
    ...process.env,
    TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: path.join(SB, '项目'),
    TEAM_WORKBENCH_JSON: path.join(SB, 'workbench.json'),
    TEAM_SELFTEST: '1',
  };
}
function run(args) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(), timeout: 60000, cwd: SB });
    return { code: 0, out: String(out), err: '' };
  } catch (error) {
    return { code: error.status == null ? 1 : error.status, out: String(error.stdout || ''), err: String(error.stderr || '') };
  }
}
function runJson(args) {
  const r = run(args);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}
const text = (r) => String(r.out || '') + String(r.err || '');

if (!fs.existsSync(TOOL)) { console.error('环境错误：找不到 team.mjs'); process.exit(2); }

// ── 假 _tmp 夹具：6 个目录（3 过期 / 1 顶层旧但内有新文件 / 1 新 / 1 keep）
fs.mkdirSync(path.join(TEAM, '状态', '项目', PROJECT), { recursive: true });
fs.mkdirSync(FAKE, { recursive: true });
const now = Date.now();
const OLD = (now - 2 * 60 * 60 * 1000) / 1000; // 2 小时前（秒）
function mkdir(name, mtimeSec) {
  const p = path.join(FAKE, name);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'payload.txt'), `${name}\n`, 'utf8');
  if (mtimeSec) { fs.utimesSync(path.join(p, 'payload.txt'), mtimeSec, mtimeSec); fs.utimesSync(p, mtimeSec, mtimeSec); }
  return p;
}
const oldDir = mkdir('old-dir', OLD);
const oldEmpty = path.join(FAKE, 'old-empty');
fs.mkdirSync(oldEmpty, { recursive: true });
fs.utimesSync(oldEmpty, OLD, OLD);
const oldNestedFresh = mkdir('old-nested-fresh', OLD);
fs.writeFileSync(path.join(oldNestedFresh, 'fresh.txt'), 'recent\n', 'utf8'); // 子文件新鲜 → 整目录视为活跃
const freshDir = mkdir('fresh-dir', Math.floor(now / 1000));
const keepOld = mkdir('keepme', OLD);
const globOld = mkdir('glob-keep-old', OLD);
const rootScript = path.join(FAKE, 'script.cjs');
fs.writeFileSync(rootScript, '// root script must survive\n', 'utf8');

const beforeDirs = fs.readdirSync(FAKE, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
check('S0 假 _tmp 夹具就绪（6 个顶层目录 + 1 个根下脚本）', beforeDirs === 6 && fs.existsSync(rootScript), { beforeDirs });

// ── AC1：默认 dry-run
const dry = runJson(['tmp', 'prune', '--root', FAKE, '--project', PROJECT, '--json']);
const dryCandidates = (dry.json && dry.json.candidates) || [];
check('AC1① 默认 dry-run 正常返回（dryRun=true）', dry.code === 0 && dry.json && dry.json.dryRun === true, { code: dry.code, out: text(dry).slice(0, 300) });
check('AC1② 候选=4 个过期目录（old-dir / old-empty / keepme / glob-keep-old）',
  dryCandidates.length === 4 && dryCandidates.includes('old-dir') && dryCandidates.includes('old-empty') && dryCandidates.includes('keepme') && dryCandidates.includes('glob-keep-old'),
  { dryCandidates });
check('AC1③ 长跑沙盘（顶层旧但内有新文件）与新目录都不在候选',
  !dryCandidates.includes('old-nested-fresh') && !dryCandidates.includes('fresh-dir'), { dryCandidates });
check('AC1④ dry-run 不删除任何目录', fs.readdirSync(FAKE, { withFileTypes: true }).filter((e) => e.isDirectory()).length === 6, null);
check('AC1⑤ dry-run 不写审计文件（只读）', !fs.existsSync(path.join(TEAM, '状态', '项目', PROJECT, '沙盘清理.jsonl')), null);
const conflict = run(['tmp', 'prune', '--root', FAKE, '--project', PROJECT, '--yes', '--dry-run', '--json']);
check('AC1⑥ --yes 与 --dry-run 互斥 → BAD_ARGS', conflict.code !== 0 && /BAD_ARGS/.test(text(conflict)), { code: conflict.code, out: text(conflict).slice(0, 200) });

// ── AC2/AC3：--yes 真删 + --keep
const yes = runJson(['tmp', 'prune', '--root', FAKE, '--project', PROJECT, '--yes', '--keep', 'keepme,glob-*', '--json']);
check('AC2① --yes 正常返回（dryRun=false）', yes.code === 0 && yes.json && yes.json.dryRun === false, { code: yes.code, out: text(yes).slice(0, 300) });
const removed = (yes.json && yes.json.removed) || [];
check('AC2② 只删过期项：old-dir / old-empty', removed.length === 2 && removed.includes('old-dir') && removed.includes('old-empty'), { removed });
check('AC2③ --keep 精确名 + 前缀通配都保留', fs.existsSync(keepOld) && fs.existsSync(globOld), { keepme: fs.existsSync(keepOld), glob: fs.existsSync(globOld) });
check('AC2④ 长跑沙盘 / 新目录保留', fs.existsSync(oldNestedFresh) && fs.existsSync(freshDir), { nested: fs.existsSync(oldNestedFresh), fresh: fs.existsSync(freshDir) });
check('AC2⑤ 根下脚本文件未被删', fs.existsSync(rootScript), null);
const afterDirs = fs.readdirSync(FAKE, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
check('AC2⑥ 清理后顶层目录数 6 → 4', beforeDirs === 6 && afterDirs === 4, { afterDirs });
const auditFile = path.join(TEAM, '状态', '项目', PROJECT, '沙盘清理.jsonl');
const auditRows = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
check('AC3① 审计文件存在且至少两行（意图行 + 结果行）', auditRows.length >= 2, { rows: auditRows.length });
const intent = auditRows.find((r) => r.action === 'tmp_prune') || {};
const doneRow = auditRows.find((r) => r.action === 'tmp_prune_done') || {};
check('AC3② 意图行含候选清单与阈值/保留项（删前写）',
  Array.isArray(intent.candidates) && intent.candidates.length === 2 && intent.candidates.includes('old-dir') && Number(intent.minutes) === 60 && Array.isArray(intent.keep) && intent.keep.includes('keepme'),
  { intent: { candidates: intent.candidates, minutes: intent.minutes, keep: intent.keep } });
check('AC3③ 结果行含 removed / failed / afterDirs',
  Array.isArray(doneRow.removed) && doneRow.removed.length === 2 && Array.isArray(doneRow.failed) && Number(doneRow.afterDirs) === 4,
  { done: doneRow });

// ── AC5：幂等（同一组参数再跑一次没有可删项）
const yesAgain = runJson(['tmp', 'prune', '--root', FAKE, '--project', PROJECT, '--yes', '--keep', 'keepme,glob-*', '--json']);
check('AC5 幂等：再跑 --yes removed=0', yesAgain.code === 0 && Array.isArray(yesAgain.json && yesAgain.json.removed) && yesAgain.json.removed.length === 0, { removed: yesAgain.json && yesAgain.json.removed });

// ── AC4：参数校验
const badMinutes = run(['tmp', 'prune', '--root', FAKE, '--minutes', 'abc', '--json']);
check('AC4① --minutes 非数字 → BAD_ARGS', badMinutes.code !== 0 && /BAD_ARGS/.test(text(badMinutes)), { code: badMinutes.code, out: text(badMinutes).slice(0, 200) });
const missingRoot = run(['tmp', 'prune', '--root', path.join(SB, 'no-such-root'), '--json']);
check('AC4② --root 不存在 → TMP_ROOT_MISSING', missingRoot.code !== 0 && /TMP_ROOT_MISSING/.test(text(missingRoot)), { code: missingRoot.code, out: text(missingRoot).slice(0, 200) });

const total = passed + failures.length;
console.log(`\nB-b51b tmp prune 断言：${passed}/${total} PASS${failures.length ? `，${failures.length} 待修` : ''}`);
const evidDir = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-b51b');
fs.mkdirSync(evidDir, { recursive: true });
fs.writeFileSync(path.join(evidDir, 'run-b51b.json'), JSON.stringify({ at: new Date().toISOString(), sandbox: SB, project: PROJECT, passed, total, results: records }, null, 2) + '\n', 'utf8');
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
process.exit(0);
