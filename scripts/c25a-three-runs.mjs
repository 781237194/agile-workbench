/**
 * c25a AC3：**连续 3 次 ≥30 分钟**长跑（串行，一次只跑一个实例，避免并行互相干扰）。
 *
 * 为什么串行：并行三条曾在同一秒一起退出（1~3 分钟），无法区分「壳自身问题」与「并发/外部干扰」；
 * 串行 + 每次独立沙盘 + DSH 替身，才是这条缺陷要的可判证据。
 *
 * 输出：项目/工作台改造修复/程序员B/产出/证据-c25a/three-runs.json
 *      每项含：启动/结束时间、运行分钟、是否自退、退出码、审计行、邮箱新增、唤醒行
 * 跑法：node scripts/c25a-three-runs.mjs [--minutes 35] [--base 30]
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
const MINUTES = String(argOf('minutes', '35'));
const BASE = Number(argOf('base', '30'));
const EVID = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-c25a');
fs.mkdirSync(EVID, { recursive: true });

const runs = [];
for (let i = 0; i < 3; i += 1) {
  const run = BASE + i;
  const startedAt = new Date().toISOString();
  let error = '';
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'c25a-longrun.mjs'), '--run', String(run), '--minutes', MINUTES], { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    error = String((e && e.message) || e).slice(0, 300);
  }
  const file = path.join(EVID, `longrun-${run}.json`);
  let summary = null;
  try { summary = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { summary = null; }
  runs.push({
    run, startedAt, finishedAt: new Date().toISOString(), error,
    minutesRan: summary ? summary.minutesRan : null,
    selfExited: summary ? summary.selfExited : null,
    exitCode: summary ? summary.exitCode : null,
    auditKinds: summary ? summary.auditRowsAfterClose : null,
    mailboxNew: summary ? summary.mailboxNew : null,
    wakeRows: summary ? summary.wakeRows : null,
    wakeAllSuppressedNoWake: summary ? summary.wakeAllSuppressedNoWake : null,
    logFile: summary ? summary.logFile : '',
    pass30: Boolean(summary && summary.pass30),
  });
}
const out = {
  at: new Date().toISOString(),
  minutes: Number(MINUTES),
  sequential: true,
  pass: runs.every((r) => r.pass30),
  runs,
  conclusions: runs.map((r) => {
    const mailboxOk = r.mailboxNew === 0;
    const wakeOk = r.wakeRows === 0 || r.wakeAllSuppressedNoWake === true;
    return {
      run: r.run, pass30: r.pass30, mailboxOk, wakeOk,
      note: r.pass30 ? '跑满 ≥30 分钟' : `只跑了 ${r.minutesRan} 分钟（${r.selfExited ? '自行退出' : '异常结束'}）`,
    };
  }),
};
fs.writeFileSync(path.join(EVID, 'three-runs.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log('THREE_RUNS ' + JSON.stringify({ pass: out.pass, runs: runs.map((r) => ({ run: r.run, minutes: r.minutesRan, mailboxNew: r.mailboxNew })) }));
process.exit(out.pass ? 0 : 1);
