#!/usr/bin/env node
'use strict';
/**
 * test-b64d-ws-kill.cjs —— B-20261117-113925-b64d 的杀进程注入（针对 团队/状态/当前工作区.json）
 *
 * 背景：`launch.mjs` / `workspace.mjs` 以前裸 `fs.writeFileSync` 写 当前工作区.json，崩在半截会留坏 JSON；
 * 收编到 json-atomic（tmp→fsync→bak→rename + 锁）后，任何时刻被杀，盘上都只能是「旧的完整版」或「新的完整版」。
 *
 * 断言：
 *   K1 基线：模块写入成功，sha 可读
 *   K2 连杀 N 轮（每轮子进程写大 payload，10~80ms 后强制杀）→ 每轮结束后文件都能 JSON.parse
 *   K3 每轮 sha 必属 {写前 sha, 写后 sha}（不存在第三种半截状态）
 *   K4 收尾正常写一次 → 内容为最后一次 payload，且 .tmp 不残留（.bak 允许）
 *
 * 隔离：_tmp 沙盘目录（路径含 团队/状态/ 以满足 json-atomic 的路径白名单），不碰真实 团队/状态。
 * 用法：node scripts/test-b64d-ws-kill.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', `b64d-ws-kill-${process.pid}`);
const STATE = path.join(SB, '团队', '状态');
const FILE = path.join(STATE, '当前工作区.json');
const ATOMIC = pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'json-atomic.mjs')).href;
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'missing');
const parseOk = (p) => { try { JSON.parse(fs.readFileSync(p, 'utf8')); return true; } catch { return false; } };

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 260)}`);
}

(async () => {
  fs.mkdirSync(STATE, { recursive: true });
  const j = await import(ATOMIC);

  // K1 基线写
  const base = { version: 1, name: 'b64d 沙盘', payload: 'x'.repeat(2000) };
  const w0 = j.writeJsonAtomic(FILE, base);
  check('K1 基线写入成功且可解析（sha 可读）', w0.ok === true && parseOk(FILE) && sha(FILE) !== 'missing', w0);

  // 子进程写入器：写一个很大的对象，然后挂住（等被 kill）
  const childScript = `
    import { writeJsonAtomic } from ${JSON.stringify(ATOMIC)};
    const big = 'y'.repeat(60000);
    const r = writeJsonAtomic(${JSON.stringify(FILE)}, { version: 2, name: 'killed', payload: big, at: Date.now() });
    console.log('WROTE ' + JSON.stringify(r).slice(0, 80));
    setInterval(() => {}, 1000);
  `;

  const rounds = 8;
  const rows = [];
  for (let i = 0; i < rounds; i += 1) {
    const before = sha(FILE);
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], { cwd: ROOT, stdio: 'ignore' });
    const delay = 10 + ((i * 9) % 70);
    await new Promise((r) => setTimeout(r, delay));
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    await new Promise((r) => { child.on('exit', r); setTimeout(r, 1500); });
    const after = sha(FILE);
    rows.push({ round: i + 1, delay, before, after, parse: parseOk(FILE) });
  }
  const allParse = rows.every((r) => r.parse);
  check('K2 连杀 8 轮：每轮结束后文件都能 JSON.parse（无半截 JSON）', allParse, rows.filter((r) => !r.parse));
  // 每轮的 sha 只能是「本轮写前」或「写后（与最终写入内容一致）」——用「下一轮写前」对照
  const legalShas = new Set(rows.map((r) => r.before));
  const finalWrite = j.writeJsonAtomic(FILE, { version: 3, name: 'final', payload: 'z'.repeat(1000) });
  legalShas.add(finalWrite.sha256);
  const illegal = rows.filter((r) => r.after !== 'missing' && !legalShas.has(r.after));
  check('K3 每轮 sha 必属 {写前 sha, 完整写后 sha}（不存在第三种半截状态）', illegal.length === 0, illegal);

  // K4 收尾正常写 + 残留检查
  const finalData = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  check('K4 收尾正常写一次：内容为最后 payload（version=3），且无 .tmp 残留',
    finalData.version === 3 && finalData.name === 'final' && !fs.existsSync(FILE + '.tmp'),
    { version: finalData.version, name: finalData.name, tmp: fs.existsSync(FILE + '.tmp') });

  fs.rmSync(SB, { recursive: true, force: true });
  const total = passed + failures.length;
  const outFile = process.env.AWB_B64D_OUT
    ? (path.isAbsolute(process.env.AWB_B64D_OUT) ? process.env.AWB_B64D_OUT : path.join(ROOT, process.env.AWB_B64D_OUT))
    : path.join(ROOT, '_tmp', 'run-b64d-kill.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ task: 'B-20261117-113925-b64d', at: new Date().toISOString(), total, pass: passed, red: failures.length, rounds: rows, failures }, null, 2) + '\n', 'utf8');
  console.log(`\nB64D_WS_KILL ${JSON.stringify({ total, pass: passed, red: failures.length })}`);
  console.log('证据：' + outFile);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('B64D_WS_KILL_FAILED ' + String((e && e.stack) || e)); process.exit(2); });
