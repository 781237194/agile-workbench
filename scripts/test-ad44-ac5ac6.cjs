#!/usr/bin/env node
'use strict';
/**
 * R-ad44（T-b7dd）AC5/AC6 可程序化部分回归：
 *
 * AC5（多窗口单写者）——测试进程内可证的三条：
 *  ① `src/renderer/**` 里 `fs.writeFile` 0 命中（渲染层不直写盘）；
 *  ② 锁文件体含 `seq` 且每次成功获取单调递增；
 *  ③ 同目标文件的审计 `newSha` 成链：第 i 行 prevSha === 第 i-1 行 newSha，0 断点（不以外层 at 判）；
 *  真窗口点击两处入口（owner:decide / decisionAckSend）由 UI 回归覆盖，本脚本只断言「case 标签可落审计」。
 * AC6（今日四事故）——可程序化的两条：
 *  ④ 工作区污染：真实 workbench.json / 团队.json 的 sha256+mtime 前后不变，审计 3 行全落沙盘根。
 *  AC6①-③（提交串味/补催/红标残影）需要各自的业务夹具与真窗口，另脚本覆盖。
 *
 * 跑法：node scripts/test-ad44-ac5ac6.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const JA = path.join(ROOT, '团队', '工具', 'lib', 'json-atomic.cjs');
const { mkTempSandbox, rmSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : String(JSON.stringify(detail)).slice(0, 500) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 500)}`);
  if (!ok) process.exitCode = 1;
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const fileSig = (file) => { try { const st = fs.statSync(file); return `${st.mtimeMs}|${sha(fs.readFileSync(file))}`; } catch { return ''; } };

const SB = mkTempSandbox('ad44-ac5ac6');
const CASE_DIR = path.join(SB, '团队', '状态', '项目', '沙盘');
fs.mkdirSync(CASE_DIR, { recursive: true });
const auditFile = path.join(SB, '写入审计.jsonl');
const ja = require(JA);

// ── AC5①：渲染层不直写盘（静态） ──
const rendererDir = path.join(ROOT, 'src', 'renderer');
const rendererHits = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!/\.(js|cjs|mjs)$/.test(entry.name)) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (/fs\.writeFile(?:Sync)?\s*\(/.test(text)) rendererHits.push(path.relative(ROOT, full));
  }
};
walk(rendererDir);
check('AC5① src/renderer/** 里 fs.writeFile 0 命中（渲染层不直写盘）', rendererHits.length === 0, rendererHits);

// ── AC5②：锁文件含 seq 且单调递增 ──
const fileLock = path.join(CASE_DIR, '锁序.json');
ja.writeJsonAtomic(fileLock, { n: 0 }, { auditFile, project: '沙盘' });
const lockBodies = [];
for (let i = 1; i <= 3; i += 1) {
  const body = ja.__internals.acquireLock(fileLock, { auditFile, project: '沙盘' });
  lockBodies.push(body);
  ja.__internals.releaseLock(fileLock);
}
const seqs = lockBodies.map((b) => Number(b && b.seq));
check('AC5② 锁文件体 {pid,at,case,seq} 且 seq 单调递增',
  lockBodies.every((b) => b && typeof b.pid === 'number' && 'at' in b && 'case' in b && typeof b.seq === 'number')
  && seqs.every((v, i) => i === 0 || v > seqs[i - 1]),
  { seqs, bodies: lockBodies.length });

// ── AC5③：审计 newSha 成链（case 与入口一一对应） ──
const fileChain = path.join(CASE_DIR, '链.json');
ja.writeJsonAtomic(fileChain, { v: 1 }, { auditFile, project: '沙盘', case: 'owner:decide' });
ja.writeJsonAtomic(fileChain, { v: 2 }, { auditFile, project: '沙盘', case: 'owner:decide' });
ja.writeJsonAtomic(fileChain, { v: 3 }, { auditFile, project: '沙盘', case: 'decisionAckSend' });
const rows = fs.readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const chainRows = rows.filter((row) => String(row.file) === fileChain && String(row.result) === 'ok');
let breaks = 0;
for (let i = 1; i < chainRows.length; i += 1) {
  if (String(chainRows[i].prevSha || '') !== String(chainRows[i - 1].newSha || '')) breaks += 1;
}
const cases = new Set(chainRows.map((row) => String(row.case || '')));
check('AC5③ 同文件写入审计 newSha 成链（0 断点）且 case 与两处入口一一对应',
  chainRows.length === 3 && breaks === 0 && cases.has('owner:decide') && cases.has('decisionAckSend'),
  { rows: chainRows.length, breaks, cases: [...cases] });

// ── AC6④：工作区污染隔离（真实文件 sha256+mtime 前后不变；审计只落沙盘根） ──
const realStore = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const realTeam = path.join(ROOT, '团队', '状态', '团队.json');
const beforeStore = fileSig(realStore);
const beforeTeam = fileSig(realTeam);
const fileIso = path.join(CASE_DIR, '隔离.json');
for (let i = 0; i < 3; i += 1) ja.writeJsonAtomic(fileIso, { i }, { auditFile, project: '沙盘' });
const auditRowsAll = fs.readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const isoRows = auditRowsAll.filter((row) => String(row.file) === fileIso);
const allInSandbox = isoRows.every((row) => path.resolve(String(row.file)).startsWith(path.resolve(SB)));
check('AC6④ 真实 workbench.json / 团队.json 的 sha256+mtime 前后不变', beforeStore === fileSig(realStore) && beforeTeam === fileSig(realTeam),
  { store: [beforeStore.slice(0, 24), fileSig(realStore).slice(0, 24)], team: [beforeTeam.slice(0, 24), fileSig(realTeam).slice(0, 24)] });
check('AC6④ 3 行审计全落沙盘根（无一条指向真实状态目录）', isoRows.length === 3 && allInSandbox,
  { rows: isoRows.length, files: isoRows.map((r) => path.relative(ROOT, String(r.file))) });

const passed = results.filter((r) => r.ok).length;
console.log(`\nR-ad44 AC5/AC6（程序化部分）断言：${passed}/${results.length} PASS`);
const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-b7dd');
fs.mkdirSync(evDir, { recursive: true });
fs.writeFileSync(path.join(evDir, 'run-ad44-ac5ac6.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, passed, results }, null, 2) + '\n', 'utf8');
rmSandbox(SB);
