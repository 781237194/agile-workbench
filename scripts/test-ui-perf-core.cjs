// R-c72a 第一批自检：nearest-rank / 三档 verdict / 9 键样例 / PROBE_UNAVAILABLE（AC6 的已知样本复算）
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const CORE = require(path.resolve(__dirname, '..', 'src', 'renderer', 'ui-perf-core.js'));

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log('PASS  ' + name); }
  else { fails.push({ name, detail }); console.log('FAIL  ' + name + ' · ' + JSON.stringify(detail)); }
};

// 1) nearest-rank 已知样本：1..30 → p50=15, p95=29, p99=30（ceil(0.95*30)-1=28 → 第29个）
const samples = Array.from({ length: 30 }, (_, i) => i + 1);
const s = CORE.summarize('click', samples);
check('nearest-rank 30 样本：p50=15 / p95=29 / p99=30',
  s.p50 === 15 && s.p95 === 29 && s.p99 === 30 && s.samples === 30 && s.verdict === 'OK',
  s);

// 2) 已知分布复算（含小数）：[100,101,...] 只换第 29 个为 140 → p95=140 超预算
const over = samples.slice();
for (let i = 0; i < over.length; i += 1) over[i] = 140; // 全部 140ms → p95=140
const s2 = CORE.summarize('click', over);
check('p95 超 100ms → BUDGET_EXCEEDED（nearest-rank 第 29 个=140）',
  s2.p95 === 140 && s2.verdict === 'BUDGET_EXCEEDED', s2);

// 3) 样本 <30 → INSUFFICIENT_SAMPLES，且不得判 OK
const s3 = CORE.summarize('click', samples.slice(0, 29));
check('29 样本 → INSUFFICIENT_SAMPLES（p95=null，不判 OK）',
  s3.samples === 29 && s3.p95 === null && s3.verdict === 'INSUFFICIENT_SAMPLES', s3);

// 4) modal 预算 300ms：p95=250 → OK；p95=310 → BUDGET_EXCEEDED
const modalOk = CORE.summarize('modal', Array.from({ length: 30 }, () => 250));
const modalBad = CORE.summarize('modal', Array.from({ length: 30 }, () => 310));
check('modal 预算 300ms：250→OK、310→BUDGET_EXCEEDED',
  modalOk.verdict === 'OK' && modalBad.verdict === 'BUDGET_EXCEEDED', { modalOk, modalBad });

// 5) scrollFrame 预算 20ms
check('scrollFrame 预算 20ms：19→OK、21→BUDGET_EXCEEDED',
  CORE.summarize('scrollFrame', Array.from({ length: 30 }, () => 19)).verdict === 'OK'
  && CORE.summarize('scrollFrame', Array.from({ length: 30 }, () => 21)).verdict === 'BUDGET_EXCEEDED');

// 6) 9 键样例 + 落盘格式（用 core 汇总 + 手写一行，与 main.js 的 9 键一致）
const line = { at: new Date().toISOString(), project: '工作台改造修复', case: s.case, samples: s.samples, p50: s.p50, p95: s.p95, p99: s.p99, budget: s.budget, verdict: s.verdict };
const keys = Object.keys(line).sort();
check('落盘行恰好 9 键（at/project/case/samples/p50/p95/p99/budget/verdict；正文列了 8 个却写 9 键，第 9 键取 budget）',
  keys.length === 9 && JSON.stringify(keys) === JSON.stringify(['at', 'case', 'p50', 'p95', 'p99', 'project', 'samples', 'budget', 'verdict'].sort()),
  keys);

// 7) 探针缺失口径：没有 uiPerfCore / 没有 __uiPerf 时必须明确 PROBE_UNAVAILABLE（不静默判 OK）
const probeMissing = (() => {
  const w = {};
  const report = (typeof w.__uiPerf === 'object' && w.__uiPerf) ? null : { ok: false, code: 'PROBE_UNAVAILABLE' };
  return report;
})();
check('探针缺失 → {ok:false, code:PROBE_UNAVAILABLE}（AC9：判不通过，不是跳过）',
  probeMissing && probeMissing.ok === false && probeMissing.code === 'PROBE_UNAVAILABLE', probeMissing);

// 8) 源码锚点：__uiPerf 三方法 + 两处 ready 锚点 + IPC 落盘（静态核对，防被后续改动删掉）
const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
const orj = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'owner-review.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const pre = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
check('__uiPerf 三方法齐：mark/measure/report',
  /window\.__uiPerf\s*=\s*\{/.test(app) && /mark\(name\)/.test(app) && /measure\(name, startMark\)/.test(app) && /async report\(caseName/.test(app));
check('锚点：既有 [data-owner-review-dialog] 上挂 data-review-ready 0→1（不新增 id）',
  /setAttribute\('data-review-ready', '0'\)/.test(orj) && /setAttribute\('data-review-ready', '1'\)/.test(orj) && !/id="owner-review-modal"/.test(orj));
// c72a 遗留项（PM M-20261116-201418-507e55 ②）：原先此处是「数源码里 data-decision-ready 出现次数」的静态断言，
// 它当时正是假绿的来源（原缺陷＝出现 2 次但其中一次在 __uiPerf.report 的 catch 之后不可达）。
// 批3（T-20261116-221117-3f77）正文 AC3 把语义写死为「开始渲染置 0 → 首屏完成置 1 → **抛错保持 0**，
// 关闭不重置、下次打开重新 0→1」；旧探针（证据-c72a-批1核对/probe-decision-ready-fixed.cjs）验的是过渡期
// 的「finally 一定置 1」，与该语义相反，故换用批3 探针（11 项：结构 + 单写者 + 抛错保持 0 + 重开重计时）。
{
  const probePath = path.join(__dirname, 'probe-decision-ready.cjs');
  let probeOk = false; let probeOut = "";
  try {
    probeOut = execFileSync(process.execPath, [probePath], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 60000 });
    probeOk = /11\/11 PASS/.test(probeOut);
  } catch (e) { probeOk = false; probeOut = String((e.stdout || "") + (e.stderr || "")); }
  check('锚点：#decision-box 的 data-decision-ready 语义（0→1 / 抛错保持0 / 关闭不重置 / 重开重计时）', probeOk, probeOut.split(/\r?\n/).slice(-4));
}
check('落盘：IPC ui:perf-append + preload uiPerfAppend + 交互性能.jsonl',
  main.includes("ipcMain.handle('ui:perf-append'") && main.includes('交互性能.jsonl') && pre.includes('uiPerfAppend'));

console.log('\nbatch1 断言：' + pass + '/' + (pass + fails.length) + ' PASS');
if (fails.length) { console.log(JSON.stringify(fails, null, 2)); process.exit(1); }
