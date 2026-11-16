/**
 * c25a 长跑启动器：**把长跑从父进程彻底摘出去**（PM 2026-11-16 19:05 要求）。
 *
 * 背景：今天 DSH host 崩了两次，每次都把长跑的整棵进程树带走（run80 只跑 13.6 分钟），
 * 因为长跑是 DSH → pwsh → node → electron 的子孙。这里用 spawn(detached:true) + unref，
 * 让子进程成为**独立进程组/会话**（Windows 上是独立 console），父进程（本脚本）立即退出；
 * 之后无论谁死，长跑都不受影响。
 *
 * 跑法：
 *   node scripts/c25a-launch.mjs --base 200 --minutes 31 [--detached]
 * 输出：把子进程 PID 打到 stdout（一行 JSON），便于事后核对「谁在跑」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`)) || '';
  if (hit) return hit.split('=').slice(1).join('=');
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
};
const BASE = String(argOf('base', '200'));
const MINUTES = String(argOf('minutes', '31'));
const EVID = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-c25a');
const LOG_DIR = path.join(ROOT, '_tmp', 'c25a-launch');
fs.mkdirSync(LOG_DIR, { recursive: true });

const outLog = path.join(LOG_DIR, `launch-${BASE}.log`);
const out = fs.openSync(outLog, 'a');
const child = spawn(
  process.execPath,
  [path.join(ROOT, 'scripts', 'c25a-three-runs.mjs'), '--minutes', MINUTES, '--base', BASE],
  { cwd: ROOT, detached: true, stdio: ['ignore', out, out], windowsHide: true },
);
child.unref();

const record = {
  at: new Date().toISOString(),
  launcherPid: process.pid,
  childPid: child.pid,
  base: BASE,
  minutes: Number(MINUTES),
  detached: true,
  outLog,
  evidenceDir: EVID,
};
fs.writeFileSync(path.join(LOG_DIR, `launch-${BASE}.json`), JSON.stringify(record, null, 2) + '\n', 'utf8');
console.log('LAUNCHED ' + JSON.stringify(record));
process.exit(0);
