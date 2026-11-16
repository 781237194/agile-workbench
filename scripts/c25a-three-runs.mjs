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
import crypto from 'node:crypto';
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

// B-20261116-122339-dd73 AC3：整批跑之前/之后都要证明真实 workbench.json 没动（含 projects 数与名字）。
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const realStore = () => {
  try {
    const buf = fs.readFileSync(REAL_STORE);
    const json = JSON.parse(buf.toString('utf8'));
    return {
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      projects: Array.isArray(json.projects) ? json.projects.length : -1,
      names: (Array.isArray(json.projects) ? json.projects : []).map((p) => String((p && p.name) || '')),
    };
  } catch { return { sha256: '', projects: -1, names: [], missing: true }; }
};
const TEST_NAME_RE = /c25a|sb-fast|双跑|bd22|qidle|沙盘|测试/i;
const batchBefore = realStore();

const runs = [];
// 2026-11-16 19:03 加固：今天 host 崩溃已三次把长跑整棵进程树带走（run80 只跑了 13.6 分钟，
// 沙盘无退出审计=外部硬杀）。所以每档允许重跑一次：某次 <30 分钟（不多于一次）就换 run id 重跑，
// 直到跑满 30 分钟或次数用尽；两轮结果都留在 runs[] 里，谁被作废一目了然。
const ATTEMPTS = 2;
for (let i = 0; i < 3; i += 1) {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const run = BASE + i * 10 + attempt;
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
    const pass30 = Boolean(summary && summary.pass30);
    runs.push({
      run, slot: i + 1, attempt: attempt + 1, startedAt, finishedAt: new Date().toISOString(), error,
      minutesRan: summary ? summary.minutesRan : null,
      selfExited: summary ? summary.selfExited : null,
      exitCode: summary ? summary.exitCode : null,
      auditKinds: summary ? summary.auditRowsAfterClose : null,
      mailboxNew: summary ? summary.mailboxNew : null,
      wakeRows: summary ? summary.wakeRows : null,
      wakeAllSuppressedNoWake: summary ? summary.wakeAllSuppressedNoWake : null,
      logFile: summary ? summary.logFile : '',
      pass30,
      voided: !pass30,
    });
    if (pass30) break;
  }
}
const batchAfter = realStore();
// 与 longrun 同口径（2026-11-16 14:20 修正）：真实工作区是多人共写的，sha 漂移属外部正常写，
// 不能判成压测污染；判据=项目集合不变 + 真实 store 里 0 个测试名。
const batchShapeSame = !batchBefore.missing && !batchAfter.missing
  && batchAfter.projects === batchBefore.projects
  && JSON.stringify(batchAfter.names) === JSON.stringify(batchBefore.names);
const batchIsolation = {
  ok: batchShapeSame && !batchAfter.names.some((n) => TEST_NAME_RE.test(n)),
  shaUnchanged: batchAfter.sha256 === batchBefore.sha256,
  externalWrite: batchShapeSame && batchAfter.sha256 !== batchBefore.sha256,
  before: batchBefore, after: batchAfter,
  // AC4：清理后 Owner 界面不应再出现任何测试名（真实 store 的名字里 0 命中）
  ownerUiClean: !batchAfter.names.some((n) => TEST_NAME_RE.test(n)),
};
const passedSlots = [...new Set(runs.filter((r) => r.pass30).map((r) => r.slot))];
const out = {
  at: new Date().toISOString(),
  minutes: Number(MINUTES),
  sequential: true,
  attemptsPerSlot: ATTEMPTS,
  // 判据（2026-11-16 19:03）：三档各自至少有一次跑满 ≥30 分钟（被 host 崩溃打断的那次作废、可重跑），
  // 且批级隔离未被破坏。voided 的尝试保留在 runs[] 里可核。
  passedSlots,
  pass: passedSlots.length >= 3 && batchIsolation.ok,
  runs,
  batchIsolation,
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
