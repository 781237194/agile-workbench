#!/usr/bin/env node
'use strict';
/**
 * R-ad44（T-b7dd）并发/冲突/锁/审计回归：AC2 / AC3 / AC4 / AC7 / AC8 / AC10
 *
 * 被测：团队/工具/lib/json-atomic.cjs（唯一写入口）
 * 沙盘：_tmp/ad44-concurrency-<pid>-<ts>/团队/状态/项目/沙盘/（路径含「团队/状态/」，满足 isAllowedPath）
 *
 * AC2  50 个独立子进程对同一文件 updateJsonAtomic → 0 丢失 0 覆盖（count=50）
 * AC3  持锁期间外部改动 → 带旧 prevSha 的写入必须 WRITE_CONFLICT，且磁盘不变
 * AC4  同一文件 watchJson 去抖合并（连续 5 次写 → 回调 ≤2 次，最终数据正确）
 * AC7  注入时钟造 70 秒前锁 → 可接管 stale 锁；5 秒前锁 → WRITE_LOCKED（不误杀）
 * AC8  写入审计每行 8 键
 * AC10 锁不可用 → 结构化错误码（不静默吞）
 *
 * 跑法：node scripts/test-ad44-concurrency.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const JA = path.join(ROOT, '团队', '工具', 'lib', 'json-atomic.cjs');
const { mkTempSandbox, rmSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : String(JSON.stringify(detail)).slice(0, 500) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 500)}`);
  if (!ok) process.exitCode = 1;
}

const SB = mkTempSandbox('ad44-concurrency');
const CASE_DIR = path.join(SB, '团队', '状态', '项目', '沙盘');
fs.mkdirSync(CASE_DIR, { recursive: true });
const auditFile = path.join(SB, '审计.jsonl');
const ja = require(JA);
const opts = { auditFile, project: '沙盘' };

(async () => {
  // ── AC2：50 个独立子进程并发 updateJsonAtomic ──
  const file2 = path.join(CASE_DIR, '并发.json');
  ja.writeJsonAtomic(file2, { count: 0, items: [] }, opts);
  const childCode = `
    const ja = require(${JSON.stringify(JA)});
    ja.updateJsonAtomic(${JSON.stringify(file2)}, (cur) => {
      const count = Number(cur.count || 0) + 1;
      const items = Array.isArray(cur.items) ? cur.items : [];
      items.push(count);
      return { count, items };
    }, { auditFile: ${JSON.stringify(auditFile)}, project: '沙盘' });
  `;
  const children = [];
  for (let i = 0; i < 50; i += 1) {
    children.push(new Promise((resolve) => {
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', childCode], { stdio: 'ignore' });
      child.on('exit', (code) => resolve(code));
    }));
  }
  const codes = await Promise.all(children);
  const final2 = JSON.parse(fs.readFileSync(file2, 'utf8'));
  check('AC2 50 个独立子进程并发 updateJsonAtomic：全部 exit0、count=50、无丢失', codes.every((c) => c === 0) && final2.count === 50 && final2.items.length === 50, { failed: codes.filter((c) => c !== 0).length, count: final2.count, items: final2.items.length });
  check('AC2 写后无 .tmp 残留', !fs.existsSync(file2 + '.tmp'));

  // ── AC3：冲突可检出（持锁期间外部改动 → 旧 prevSha 写入被拒） ──
  const file3 = path.join(CASE_DIR, '冲突.json');
  ja.writeJsonAtomic(file3, { v: 1 }, opts);
  const lock = ja.__internals.acquireLock(file3, opts); // 测试进程持锁
  fs.writeFileSync(file3, JSON.stringify({ v: 'external' }) + '\n', 'utf8'); // 模拟别人绕过写入口改了盘
  ja.__internals.releaseLock(file3);
  let conflict = null;
  try {
    ja.writeJsonAtomic(file3, { v: 2 }, { ...opts, prevSha: lock ? 'deadbeef'.padEnd(64, '0') : '' });
  } catch (error) {
    conflict = error;
  }
  const disk3 = fs.readFileSync(file3, 'utf8');
  check('AC3 外部改动后用旧 prevSha 写入 → WRITE_CONFLICT 且磁盘不变', conflict && conflict.code === 'WRITE_CONFLICT' && disk3.includes('external'), { code: conflict && conflict.code, disk: disk3.slice(0, 40) });

  // ── AC4：watchJson 同文件去抖合并 ──
  const file4 = path.join(CASE_DIR, '订阅.json');
  ja.writeJsonAtomic(file4, { n: 0 }, opts);
  let calls = 0;
  let lastData = null;
  const stop = ja.watchJson(file4, (payload) => { calls += 1; lastData = payload.data; }, { debounceMs: 120 });
  for (let i = 1; i <= 5; i += 1) ja.writeJsonAtomic(file4, { n: i }, opts);
  await new Promise((r) => setTimeout(r, 500));
  try { stop(); } catch { /* 忽略 */ }
  check('AC4 连续 5 次写同一文件 → 回调合并（≤2 次）且最终数据正确', calls >= 1 && calls <= 2 && lastData && Number(lastData.n) === 5, { calls, lastData });

  // ── AC7：锁 stale 接管 / 新鲜锁不误杀（注入时钟） ──
  const file7 = path.join(CASE_DIR, '锁.json');
  ja.writeJsonAtomic(file7, { v: 0 }, opts);
  const lockPath = ja.__internals.lockPathOf(file7);
  // 造 70 秒前的锁
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, at: Date.now() - 70 * 1000, case: 'stale', seq: 1 }), 'utf8');
  let staleOk = false;
  let staleErr = null;
  try { ja.writeJsonAtomic(file7, { v: 1 }, { ...opts, lockTimeoutMs: 3000 }); staleOk = true; } catch (error) { staleErr = error; }
  check('AC7 70 秒前的 stale 锁 → 可接管并写入成功', staleOk && !fs.existsSync(lockPath), { staleOk, code: staleErr && staleErr.code });

  // 造 5 秒前的新鲜锁 → 不可接管
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 888888, at: Date.now() - 5 * 1000, case: 'fresh', seq: 2 }), 'utf8');
  let freshErr = null;
  try { ja.writeJsonAtomic(file7, { v: 2 }, { ...opts, lockTimeoutMs: 250 }); } catch (error) { freshErr = error; }
  try { fs.rmSync(lockPath, { force: true }); } catch { /* 忽略 */ }
  check('AC7 5 秒前的新鲜锁 → WRITE_LOCKED（不误杀他人锁）', freshErr && freshErr.code === 'WRITE_LOCKED', { code: freshErr && freshErr.code });

  // ── AC8：写入审计固定 8 键 ──
  const auditRows = fs.readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const KEY8 = ['at', 'project', 'file', 'case', 'result', 'code', 'prevSha', 'newSha'];
  const badRow = auditRows.find((row) => Object.keys(row).length !== 8 || !KEY8.every((k) => k in row));
  check('AC8 写入审计每行 8 键（at/project/file/case/result/code/prevSha/newSha）', auditRows.length > 0 && !badRow, { rows: auditRows.length, badRow });

  // ── AC10：锁不可用 → 结构化错误码 ──
  check('AC10 锁不可用返回结构化错误（code=WRITE_LOCKED + details.file，不静默）', Boolean(freshErr && freshErr.code === 'WRITE_LOCKED' && freshErr.details && freshErr.details.file), { code: freshErr && freshErr.code, details: freshErr && freshErr.details });

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nR-ad44 并发/锁/审计断言：${passed}/${results.length} PASS`);
  const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-b7dd');
  fs.mkdirSync(evDir, { recursive: true });
  fs.writeFileSync(path.join(evDir, 'run-ad44-concurrency.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, passed, results }, null, 2) + '\n', 'utf8');
  rmSandbox(SB);
})();
