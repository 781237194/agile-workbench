/**
 * c25a 长跑「彻底脱离 DSH 进程树」启动器（PM 2026-11-16 19:05 要求）。
 *
 * 为什么不用 spawn(detached)：Windows 上 detached 只换 console/进程组，PPID 仍是我们的进程，
 * host 崩时按「子孙进程」清理照样会被带走（今天已发生两次，run80 只跑 13.6 分钟）。
 * 用 **计划任务** 由 Task Scheduler 拉起（父进程是 svchost/taskhost，不在 DSH 的进程树里），
 * 才能真正做到「host 崩了长跑还在」。
 *
 * 跑法：
 *   node scripts/c25a-sched-launch.mjs --base 200 --minutes 31 [--keep]
 * 行为：
 *   1) schtasks /create /tn awb-c25a-<base> ... /sc once /st 23:59 /f
 *   2) schtasks /run /tn awb-c25a-<base>
 *   3) 打印任务名 + 日志路径 + 由 Task Scheduler 拉起的 node PID/PPID（父进程名一般是 cmd.exe/svchost.exe）
 * 清理：跑完用 --delete 删除任务（或用 schtasks /delete /tn <名> /f）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`)) || '';
  if (hit) return hit.split('=').slice(1).join('=');
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
};
const BASE = String(argOf('base', '200'));
const MINUTES = String(argOf('minutes', '31'));
const TASK = `awb-c25a-${BASE}`;
const LOG_DIR = path.join(ROOT, '_tmp', 'c25a-launch');
fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, `sched-${BASE}.log`);

if (process.argv.includes('--delete')) {
  try { execFileSync('schtasks', ['/delete', '/tn', TASK, '/f'], { stdio: 'inherit' }); } catch { /* ignore */ }
  console.log('DELETED ' + TASK);
  process.exit(0);
}

const cmdLine = `cmd /c cd /d "${ROOT}" && node scripts\\c25a-three-runs.mjs --minutes ${MINUTES} --base ${BASE} >> "${logFile}" 2>&1`;
execFileSync('schtasks', ['/create', '/tn', TASK, '/tr', cmdLine, '/sc', 'once', '/st', '23:59', '/f'], { stdio: 'inherit' });
execFileSync('schtasks', ['/run', '/tn', TASK], { stdio: 'inherit' });

// 等一会儿让进程起来，记录「谁在跑」：PID + PPID + 父进程名（应为 cmd.exe → svchost.exe/taskhost）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(8000);
let procs = [];
try {
  const ps = execFileSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*--base ${BASE}*' } | ForEach-Object { $pp = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $_.ParentProcessId) -ErrorAction SilentlyContinue; [pscustomobject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; parent=($pp.Name); cmd=$_.CommandLine } } | ConvertTo-Json -Compress`], { encoding: 'utf8' });
  procs = JSON.parse(String(ps || '[]').trim() || '[]');
} catch { procs = []; }
if (!Array.isArray(procs)) procs = [procs];

const record = {
  at: new Date().toISOString(),
  task: TASK,
  base: BASE,
  minutes: Number(MINUTES),
  detachedBy: 'schtasks(Task Scheduler)',
  logFile,
  evidenceDir: path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-c25a'),
  startedProcesses: procs.map((p) => ({ pid: p.pid, ppid: p.ppid, parent: p.parent })),
};
fs.writeFileSync(path.join(LOG_DIR, `sched-${BASE}.json`), JSON.stringify(record, null, 2) + '\n', 'utf8');
console.log('SCHED_LAUNCHED ' + JSON.stringify(record));
