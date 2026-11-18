#!/usr/bin/env node
'use strict';
/**
 * d5ec（T-6b24）自测：cold 5 轮 + hot（关窗重开，每轮丢首预热）3 次聚合，报中位/max/p95。
 * 用法：node scripts/d5ec-cold5.cjs [--runs=5] [--start-port=9861]
 * 产出：程序员A/产出/证据-b34a/d5ec-cold5-summary.json + 每次 run 的 json/log。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const EV = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-b34a');
const HARNESS = path.join(ROOT, 'scripts', 'test-b34a-r1-typing.cjs');
const REPORT = path.join(EV, 'run-d5ec-board-skeleton.json');
const args = process.argv.slice(2);
const arg = (n, d) => { const hit = args.find((a) => a.startsWith(`--${n}=`)); return hit ? hit.split('=').slice(1).join('=') : d; };
const RUNS = Math.max(1, Number(arg('runs', '5')) || 5);
const START_PORT = Number(arg('start-port', '9861')) || 9861;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const median = (arr) => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : null; };
const max = (arr) => (arr.length ? Math.max(...arr) : null);
const pctl = (arr, p) => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.ceil(a.length * p) - 1)] : null; };

(async () => {
  fs.mkdirSync(EV, { recursive: true });
  const runs = [];
  for (let i = 1; i <= RUNS; i += 1) {
    const port = START_PORT + i * 2;
    const logFile = path.join(EV, `cold5-run-${i}.log`);
    let code = 0;
    try {
      execFileSync(process.execPath, [HARNESS, '--board', `--start-port=${port}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000, encoding: 'buffer' });
    } catch (e) {
      code = e.status == null ? 1 : e.status;
      fs.writeFileSync(logFile, Buffer.concat([e.stdout || Buffer.alloc(0), e.stderr || Buffer.alloc(0)]));
    }
    let rep = null;
    try { rep = JSON.parse(fs.readFileSync(REPORT, 'utf8')); } catch { rep = null; }
    const cold = (rep && rep.ipc && rep.ipc.cold && rep.ipc.cold.timings) || null;
    const reopens = (rep && rep.ipc && rep.ipc.reopen && rep.ipc.reopen.runs) || [];
    const hot = reopens.slice(1).map((r) => r.timings).filter(Boolean);
    runs.push({ run: i, exit: code, cold, hotRuns: hot.length, hotContent: hot.map((t) => t.contentMs), hotSkeleton: hot.map((t) => t.skeletonVisibleMs), head: rep && rep.head });
    try { fs.copyFileSync(REPORT, path.join(EV, `cold5-run-${i}.json`)); } catch { /* ignore */ }
    console.log(`[cold5] run${i} exit=${code} cold=${cold ? `${cold.windowMs}/${cold.skeletonVisibleMs}/${cold.contentMs}` : 'null'}`);
    await sleep(1200);
  }
  const coldSk = runs.map((r) => r.cold && r.cold.skeletonVisibleMs).filter((v) => Number.isFinite(v));
  const coldCt = runs.map((r) => r.cold && r.cold.contentMs).filter((v) => Number.isFinite(v));
  const hotCt = runs.flatMap((r) => r.hotContent).filter((v) => Number.isFinite(v));
  const hotSk = runs.flatMap((r) => r.hotSkeleton).filter((v) => Number.isFinite(v));
  const summary = {
    task: 'T-20261118-184943-6b24', at: new Date().toISOString(), runs: RUNS, head: runs[0] && runs[0].head,
    cold: { samples: runs.map((r) => r.cold), skeletonMedian: median(coldSk), skeletonMax: max(coldSk), contentMedian: median(coldCt), contentMax: max(coldCt), count: coldCt.length },
    hot: { contentSamples: hotCt, skeletonSamples: hotSk, contentP95: pctl(hotCt, 0.95), contentMedian: median(hotCt), skeletonP95: pctl(hotSk, 0.95), count: hotCt.length },
    pass: {
      coldSkeletonMedianUnder300: (median(coldSk) || Infinity) <= 300,
      coldContentMedianUnder5000: (median(coldCt) || Infinity) <= 5000,
      hotContentP95Under800: (pctl(hotCt, 0.95) === null ? false : pctl(hotCt, 0.95) <= 800),
      hotSkeletonP95Under200: (pctl(hotSk, 0.95) === null ? false : pctl(hotSk, 0.95) <= 200),
    },
    rawRuns: runs,
  };
  fs.writeFileSync(path.join(EV, 'd5ec-cold5-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log('[cold5] SUMMARY ' + JSON.stringify({ cold: { skMed: summary.cold.skeletonMedian, skMax: summary.cold.skeletonMax, ctMed: summary.cold.contentMedian, ctMax: summary.cold.contentMax }, hot: { skP95: summary.hot.skeletonP95, ctP95: summary.hot.contentP95, n: summary.hot.count }, pass: summary.pass }));
})();
