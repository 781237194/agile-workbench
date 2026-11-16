// R-c72a 批3 自检（T-20261116-221117-3f77 返工 4 处 + AC4 采帧口径）
//  ① 未登记 case 必须 BAD_CASE（禁静默回落 click）            —— AC2
//  ③ measure 第三参 visibleChange；click 桶缺字段不计有效样本  —— AC1/AC5
//  ④ data-decision-ready 语义（0→1 / 抛错保持 0 / 重开重计时） —— AC3（探针 probe-decision-ready-v2.cjs）
//  ② 切项目后刷新 #pool-req-list                              —— AC2（静态锚点；真实链路由测试在真窗口复验）
//  AC4 采帧连续 rAF ≥30 帧 + CPU 基线                          —— 静态锚点
// 用法：node scripts/test-c72a-batch3.cjs（不起窗口、不写任何状态文件）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'src', 'renderer', 'app.js');
const CORE = require(path.join(ROOT, 'src', 'renderer', 'ui-perf-core.js'));
const app = fs.readFileSync(APP, 'utf8');

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log('PASS  ' + name); }
  else { fails.push({ name, detail }); console.log('FAIL  ' + name + ' · ' + JSON.stringify(detail)); }
};

// ── 抽取渲染层探针源码段（AWB_UI_PERF 常量 + awbUiPerf* 函数 + window.__uiPerf）
const segStart = app.indexOf('const AWB_UI_PERF = { marks');
const segEnd = app.indexOf('window.__themeLook = function () {');
const SEG = segStart >= 0 && segEnd > segStart ? app.slice(segStart, segEnd) : '';

function harness() {
  let now = 1000;
  const writes = [];
  const win = {
    uiPerfCore: CORE,
    workbench: {
      uiPerfAppend: (line) => { writes.push(JSON.parse(JSON.stringify(line))); return { ok: true, project: '工作台改造修复' }; },
    },
  };
  const performanceStub = { now: () => now };
  const factory = new Function('window', 'performance', 'document',
    SEG + '\nreturn { bucket: awbUiPerfBucket, perf: window.__uiPerf, state: AWB_UI_PERF, cases: AWB_UI_PERF_CASES };');
  const out = factory(win, performanceStub, {});
  out.advance = (ms) => { now += ms; };
  out.writes = writes;
  out.win = win;
  return out;
}
const vcAt = (sample) => {
  const vc = sample && sample.visibleChange;
  return vc ? Number(vc.atMs) : NaN;
};

(async () => {
  check('探针源码段可抽取（AWB_UI_PERF … window.__uiPerf）', SEG.length > 500 && SEG.includes('window.__uiPerf = {'), { segStart, segEnd });

  if (SEG) {
    // ── ① 桶解析：已登记四个，其余一律 null（不再静默回落 click）
    {
      const h = harness();
      check('① 已登记 case 解析正确（click/list/modal/scrollFrame + 前缀名）',
        h.bucket('click') === 'click' && h.bucket('list') === 'list' && h.bucket('modal') === 'modal'
        && h.bucket('scrollFrame') === 'scrollFrame' && h.bucket('click:row-1') === 'click' && h.bucket('list:a') === 'list',
        { cases: h.cases });
      check('① 未登记 case 一律 null（list-update / dialog / scroll / 空串）',
        h.bucket('list-update') === null && h.bucket('dialog') === null && h.bucket('scroll') === null && h.bucket('') === null);
      check('① 源码里已无「alias[key] || "click"」静默回落',
        !/alias\[key\]\s*\|\|\s*"click"/.test(app) && /AWB_UI_PERF_CASES\.indexOf\(key\)\s*>=\s*0\s*\?\s*key\s*:\s*null/.test(app));
    }

    // ── ① report 对未登记 case 返回 BAD_CASE（不落盘、不污染 click 桶）
    {
      const h = harness();
      const r = await h.perf.report('list-update', { project: '工作台改造修复' });
      const r2 = await h.perf.report('', {});
      check('① report(未登记) → {ok:false, code:BAD_CASE}，且 allowed 给出四个桶',
        r && r.ok === false && r.code === 'BAD_CASE' && Array.isArray(r.allowed) && r.allowed.length === 4, r);
      check('① report(空串) → BAD_CASE；未登记 case 不写 jsonl',
        Boolean(r2 && r2.code === 'BAD_CASE') && h.writes.length === 0, { r2, writes: h.writes.length });
    }

    // ── ③ measure：未登记 case 不记样本；click 桶缺 visibleChange 不计有效样本
    {
      const h = harness();
      h.perf.mark('m0');
      const nullRet = h.perf.measure('list-update:m0', 'm0');
      check('③ measure 未登记 case → null 且不记样本',
        nullRet === null && h.state.samples.click.length === 0 && h.state.samples.list.length === 0, { nullRet });
      h.perf.mark('m1');
      h.advance(20);
      const noVc = h.perf.measure('click:m1', 'm1');
      const r = await h.perf.report('click');
      check('③ click 样本缺 visibleChange → 有效样本 0、判 INSUFFICIENT_SAMPLES',
        noVc === 20 && r.line.samples === 0 && r.line.verdict === 'INSUFFICIENT_SAMPLES' && r.validSamples === 0 && r.invalidSamples === 1,
        { noVc, line: r.line, valid: r.validSamples, invalid: r.invalidSamples });
    }

    // ── ③ click 30 个带 visibleChange 的样本：p95 走 atMs、落盘 9 键、有效样本=30
    {
      const h = harness();
      for (let i = 0; i < 30; i += 1) {
        h.perf.mark('c' + i);
        h.advance(20);
        h.perf.measure('click:c' + i, 'c' + i, { selector: '[data-owner-review-dialog]', from: 'absent', to: 'present' });
      }
      const samples = h.perf.samples('click');
      const vcOk = samples.length === 30 && samples.every((s) => s.visibleChange
        && s.visibleChange.selector === '[data-owner-review-dialog]'
        && s.visibleChange.from === 'absent' && s.visibleChange.to === 'present'
        && Number.isInteger(vcAt(s)) && vcAt(s) === 20);
      const r = await h.perf.report('click', { project: '工作台改造修复' });
      const keys = Object.keys(h.writes[0] || {}).sort();
      check('③ 30 个 click 样本都带 visibleChange{selector,from,to,atMs 整数}',
        vcOk, { n: samples.length, first: samples[0] });
      check('③ report 有效样本=30、p95=20（预算 100 → OK）',
        r.line.samples === 30 && r.line.p95 === 20 && r.line.verdict === 'OK' && r.validSamples === 30 && r.invalidSamples === 0, r.line);
      check('③ 落盘行恰好 9 键且 project 由 IPC 回填',
        keys.length === 9 && JSON.stringify(keys) === JSON.stringify(['at', 'budget', 'case', 'p50', 'p95', 'p99', 'project', 'samples', 'verdict'].sort())
        && h.writes[0].project === '工作台改造修复' && h.writes[0].case === 'click', { keys, project: h.writes[0] && h.writes[0].project });
    }

    // ── ③ AC5：时延取 visibleChange.atMs（调用方显式给 atMs 时以它为准）
    {
      const h = harness();
      for (let i = 0; i < 30; i += 1) {
        h.perf.mark('k' + i);
        h.advance(20); // 实测 20ms
        h.perf.measure('click:k' + i, 'k' + i, { selector: '#row', from: 'present', to: 'absent', atMs: 42 });
      }
      const r = await h.perf.report('click');
      check('③ 时延只取样本里的 visibleChange.atMs（30 个 atMs=42 → p95=42）',
        r.line.samples === 30 && r.line.p95 === 42 && r.line.verdict === 'OK', r.line);
    }

    // ── ③ 非 click 桶不要求 visibleChange（list/modal/scrollFrame 仍可计数）
    {
      const h = harness();
      for (let i = 0; i < 30; i += 1) { h.perf.mark('l' + i); h.advance(30); h.perf.measure('list:l' + i, 'l' + i); }
      const r = await h.perf.report('list');
      check('③ list 桶不强制 visibleChange：30 样本 p95=30 判 OK', r.line.samples === 30 && r.line.p95 === 30 && r.line.verdict === 'OK', r.line);
    }

    // ── 降级：没有 uiPerfCore → PROBE_UNAVAILABLE（不静默判 OK）
    {
      const h = harness();
      h.win.uiPerfCore = undefined;
      const r = await h.perf.report('click');
      check('③ 探针不可用 → {ok:false, code:PROBE_UNAVAILABLE}', !!(r && r.ok === false && r.code === 'PROBE_UNAVAILABLE'), r);
    }
  }

  // ── ② 切项目刷新池列表：点击即换（缓存同步渲染/按目标 id 取数），applyState 后再刷新最新数据
  {
    const start = app.indexOf('async function selectWorkspace(projectId) {');
    const seg = start >= 0 ? app.slice(start, app.indexOf('\n}\r\n', start) + 2) : '';
    check('② selectWorkspace 点击即换列表：优先用 byProject 缓存同步渲染、无缓存按目标 id 取数（都不等 selectProject）',
      seg.includes('poolUi.byProject[projectId]') && seg.includes('renderPool()') && seg.includes('refreshPool(projectId)'),
      { seg: seg.slice(0, 300) });
    const aStart = app.indexOf('async function applyState(next) {');
    const aSeg = aStart >= 0 ? app.slice(aStart, app.indexOf('\n}\r\n', aStart) + 2) : '';
    check('② applyState 在池子打开时清 signature 并重取（切项目后列表必须换最新数据）',
      aSeg.includes('if (poolUi.open)') && aSeg.includes("poolUi.signature = ''") && aSeg.includes('void refreshPool()'), { seg: aSeg.slice(0, 240) });
    check('② refreshPool 支持显式 projectId + 取数序号（并发只让最后一次写回）+ 按项目缓存',
      /async function refreshPool\(projectId\)/.test(app) && /poolUi\.fetchSeq \+= 1/.test(app) && /poolUi\.byProject\[pid\] = rows/.test(app));
    check('② 打开池子时预取各项目（prefetchPoolRows）',
      /async function prefetchPoolRows\(\)/.test(app) && /void prefetchPoolRows\(\)/.test(app));
  }

  // ── AC4 采帧口径：连续 rAF ≥30 帧 + CPU 基线 + 帧数不足判 INSUFFICIENT_SAMPLES
  {
    const scroll = fs.readFileSync(path.join(ROOT, 'scripts', 'ui-budget-scroll.cjs'), 'utf8');
    check('AC4 采帧默认 30 步（连续 rAF ≥30 帧）', /const STEPS = Number\(argOf\('--steps', '30'\)\);/.test(scroll));
    check('AC4 帧数 <30 只判 INSUFFICIENT_SAMPLES（不判 OK）',
      /res\.frames >= 30/.test(scroll) && /verdict = 'INSUFFICIENT_SAMPLES'/.test(scroll));
    check('AC4 记录 CPU 占用/systemIdleTime 基线（cpuBaseline）',
      /function cpuSnapshot\(\)/.test(scroll) && /cpuBaseline = cpuBaselineOf\(cpuBefore, cpuAfter\)/.test(scroll) && /idleDeltaMs/.test(scroll));
  }

  // ── ④ data-decision-ready 语义探针（11 项：结构 + 单写者 + 重开重计时 + 抛错保持 0）
  {
    const probe = path.join(ROOT, 'scripts', 'probe-decision-ready.cjs');
    let out = '';
    let ok = false;
    try {
      out = execFileSync(process.execPath, [probe], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
      ok = /11\/11 PASS/.test(out);
    } catch (e) {
      out = String((e.stdout || '') + (e.stderr || ''));
      ok = false;
    }
    check('④ data-decision-ready 探针 11/11 PASS（0→1 / 抛错保持0 / 重开重计时 / 单写者）', ok, out.split(/\r?\n/).slice(-3));
  }

  // ── 既有锚点不回退：__uiPerf 三方法签名（test-ui-perf-core 的静态断言依赖）
  check('既有锚点保持：__uiPerf = {… mark(name) / measure(name, startMark) / async report(caseName',
    /window\.__uiPerf\s*=\s*\{/.test(app) && /mark\(name\)/.test(app) && /measure\(name, startMark\)/.test(app) && /async report\(caseName/.test(app));

  console.log('\nc72a 批3 断言：' + pass + '/' + (pass + fails.length) + ' PASS');
  if (fails.length) { console.log(JSON.stringify(fails, null, 2)); process.exit(1); }
})().catch((e) => {
  console.error('ERR ' + ((e && e.stack) || e));
  process.exit(2);
});
