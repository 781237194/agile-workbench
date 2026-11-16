#!/usr/bin/env node
'use strict';
/**
 * R-ad44 AC1②（T-b7dd）：杀进程注入 + 锁 stale 接管 回归
 *
 * 判据（需求正文 AC1②）：
 *   沙盘脚本 fork 子进程执行单次写，父进程轮询到 `<file>.tmp` 出现后 child.kill("SIGKILL")；
 *   预期后态：①目标文件 sha256 等于写前值；②`.tmp` 残留存在、下次成功写后消失；
 *            ③锁接管：AWB_NOW_MS 注入把锁 age 设为 >60000ms 后按 LOCK_STALE 接管并写审计 stale。
 *
 * 跑法：node scripts/test-json-kill.cjs
 * 沙盘：scripts/lib/sandbox-dir.cjs 的 mkTempSandbox（唯一临时目录 + 退出清理）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
const jsonAtomic = require(path.join(ROOT, '团队', '工具', 'lib', 'json-atomic.cjs'));

const SB = mkTempSandbox('json-kill');
// 放在「团队/状态/项目/<项目>/」下：既命中 AC1① 白名单，也命中审计落点（写入审计.jsonl 按项目目录落）
const STATE_DIR = path.join(SB, '团队', '状态', '项目', 'AC1杀进程沙盘');
fs.mkdirSync(STATE_DIR, { recursive: true });
const TARGET = path.join(STATE_DIR, '杀进程目标.json');
const AUDIT = path.join(STATE_DIR, '写入审计.jsonl');
const LOCK = TARGET + '.lock';
const TMP = TARGET + '.tmp';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 320)}`);
  if (!ok) process.exitCode = 1;
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// ── 0) 写前基线：先落一版已知内容 ──
jsonAtomic.writeJsonAtomic(TARGET, { v: 0, pad: 'x'.repeat(1000) }, { case: 'kill-baseline' });
const shaBefore = sha(TARGET);
check('基线：目标文件存在且已记录 sha', fs.existsSync(TARGET) && shaBefore.length === 64, { shaBefore: shaBefore.slice(0, 12) });

// ── 1) fork 子进程做「大 payload 单次原子写」，父进程在 .tmp 出现时 SIGKILL ──
const childScript = path.join(SB, 'writer-child.cjs');
fs.writeFileSync(childScript, `
const jsonAtomic = require(${JSON.stringify(path.join(ROOT, '团队', '工具', 'lib', 'json-atomic.cjs'))});
const payload = { v: 1, pad: 'y'.repeat(60 * 1024 * 1024) }; // 60MB，写入窗口足够父进程抓到 .tmp
try {
  jsonAtomic.writeJsonAtomic(${JSON.stringify(TARGET)}, payload, { case: 'kill-child' });
  console.log('CHILD_DONE');
} catch (error) {
  console.log('CHILD_ERROR ' + String((error && error.code) || error));
}
`, 'utf8');

const child = fork(childScript, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
let killed = false;
let sawTmp = false;
const deadline = Date.now() + 60000;
const poll = setInterval(() => {
  if (!sawTmp && fs.existsSync(TMP)) {
    sawTmp = true;
    try { killed = child.kill('SIGKILL'); } catch { killed = false; }
    clearInterval(poll);
  } else if (Date.now() > deadline) {
    clearInterval(poll);
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
}, 4);
child.on('exit', () => {
  clearInterval(poll);
  setTimeout(finish, 200);
});

function finish() {
  clearTimeout(watchdog);
  check('子进程写盘期间出现 <file>.tmp 并被 SIGKILL', sawTmp === true && killed === true, { sawTmp, killed });
  // ① 杀进程后目标文件仍是写前值（原子 rename 之前不会截断）
  check('① 目标文件 sha256 等于写前值（未被半截内容覆盖）', fs.existsSync(TARGET) && sha(TARGET) === shaBefore, { now: fs.existsSync(TARGET) ? sha(TARGET).slice(0, 12) : null, before: shaBefore.slice(0, 12) });
  // ② .tmp 残留存在
  check('② .tmp 残留存在（崩溃现场可诊断）', fs.existsSync(TMP), { tmp: fs.existsSync(TMP) });
  // ③ 锁文件残留（子进程被 KILL，未 release）
  check('③ 锁文件 .lock 残留且含 pid/at/case/seq', fs.existsSync(LOCK) && (() => {
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
      return Boolean(lock && lock.pid && lock.at && Object.prototype.hasOwnProperty.call(lock, 'case') && Number(lock.seq) >= 1);
    } catch { return false; }
  })(), { lock: fs.existsSync(LOCK) });

  // ── 2) AWB_NOW_MS 注入造「70 秒前锁」→ 下次写入按 LOCK_STALE 接管，并写审计 stale ──
  const realNow = Date.now();
  process.env.AWB_NOW_MS = String(realNow + 70000);
  let takeoverOk = false;
  let takeoverError = null;
  try {
    jsonAtomic.writeJsonAtomic(TARGET, { v: 2, pad: 'z'.repeat(1000) }, { case: 'kill-takeover' });
    takeoverOk = true;
  } catch (error) {
    takeoverError = String((error && error.code) || error);
  }
  delete process.env.AWB_NOW_MS;
  check('④ 70 秒旧锁被 LOCK_STALE 接管并写入成功', takeoverOk === true && !takeoverError, { takeoverOk, takeoverError });
  check('⑤ 成功写后 .tmp 消失', !fs.existsSync(TMP), { tmp: fs.existsSync(TMP) });
  check('⑥ 成功写后目标文件更新为 v2', (() => { try { return JSON.parse(fs.readFileSync(TARGET, 'utf8')).v === 2; } catch { return false; } })());
  const auditRows = fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const staleRows = auditRows.filter((r) => r.result === 'stale' && r.code === 'LOCK_STALE');
  check('⑦ 审计出现 result=stale / code=LOCK_STALE 行（且 8 键）', staleRows.length >= 1 && Object.keys(staleRows[0]).length === 8, { stale: staleRows.length, keys: staleRows[0] ? Object.keys(staleRows[0]).length : 0 });
  const okRows = auditRows.filter((r) => r.result === 'ok');
  check('⑧ 审计有 result=ok 行（接管后写入留痕）', okRows.length >= 2, { ok: okRows.length });
  // ⑨ 无孤儿：SIGKILL 后子进程 PID 必须已消失（否则会污染后续测试/真实环境）
  let orphanAlive = false;
  try { process.kill(child.pid, 0); orphanAlive = true; } catch { orphanAlive = false; }
  check('⑨ 无孤儿进程：写子进程 PID 已回收', orphanAlive === false, { pid: child.pid, orphanAlive });

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nAC1② 杀进程注入断言：${passed}/${results.length} PASS`);
  if (passed !== results.length) process.exitCode = 1;
}

// 兜底：若子进程提前失败（比如 payload 内存不足），55 秒后仍会 kill 子进程；
// 正常 finish 后必须 clearTimeout，否则进程会白等 55 秒（PM 2026-11-17 02:48：注意别留孤儿/长尾）。
const watchdog = setTimeout(() => { if (!sawTmp) { try { child.kill('SIGKILL'); } catch { /* ignore */ } clearInterval(poll); } }, 55000);
watchdog.unref();
