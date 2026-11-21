'use strict';
// R-e31b/T-32a3 补采（只读）：连生产壳实例 CDP（端口 9223，target index.html），
// Tracing 抓 30s，按「主线程顶层长任务」归因：type（timer/scripting/layout/paint/gc/parseHTML/event）+ URL:function + 触发者。
// 不点击、不 reload、不关闭任何窗口。
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argOf('--port', '9223'));
const SECONDS = Number(argOf('--seconds', '30')) || 30;
const OUT = path.resolve(argOf('--out', path.join('_tmp', 'e31b-trace2-' + Date.now())));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.p = new Map(); this.handlers = []; }
  connect() { return new Promise((res, rej) => { const ws = new WebSocket(this.u); this.ws = ws; ws.onopen = res; ws.onerror = rej; ws.onmessage = (ev) => { let m = null; try { m = JSON.parse(ev.data); } catch { return; } for (const h of this.handlers) { try { h(m); } catch { /* ignore */ } } if (m.id && this.p.has(m.id)) { const q = this.p.get(m.id); this.p.delete(m.id); m.error ? q.reject(new Error(JSON.stringify(m.error))) : q.resolve(m.result); } }; }); }
  send(method, params = {}) { return new Promise((res, rej) => { const id = ++this.id; this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  on(h) { this.handlers.push(h); }
}
const classifyCat = (name) => {
  const n = String(name);
  if (/^TimerFire$/.test(n)) return 'timer';
  if (/MinorGC|MajorGC|GCEvent|V8\.GC|MarkCompact|Scavenge/i.test(n)) return 'gc';
  if (/UpdateLayoutTree|^Layout$|LayoutShift|ComputeLayout/i.test(n)) return 'layout';
  if (/Paint|Composite|Raster|GPUTask|Commit/i.test(n)) return 'paint';
  if (/ParseHTML|HTMLParser/i.test(n)) return 'parseHTML';
  if (/FunctionCall|EvaluateScript|v8\.run|ExecuteScript|RunMicrotasks|ProfileCall/i.test(n)) return 'scripting';
  if (/EventDispatch|^dispatchEvent$/.test(n)) return 'event';
  return '';
};
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = (list || []).find((t) => t.type === 'page' && /index\.html/i.test(String(t.url || '')));
  if (!page) throw new Error('no index.html target');
  const cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.connect();
  const chunks = []; let complete = false;
  cdp.on((m) => {
    if (m.method === 'Tracing.dataCollected' && m.params && Array.isArray(m.params.value)) chunks.push(m.params.value);
    if (m.method === 'Tracing.tracingComplete') complete = true;
  });
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,v8,disabled-by-default-v8.cpu_profiler' });
  const t0 = Date.now();
  await sleep(SECONDS * 1000);
  await cdp.send('Tracing.end');
  for (let i = 0; i < 60 && !complete; i += 1) await sleep(500);
  const events = [];
  for (const c of chunks) if (Array.isArray(c)) events.push(...c);
  const raw = JSON.stringify(events).slice(0, 200000);
  console.error('[trace2] events=' + events.length + ' rawLen=' + raw.length + ' head=' + raw.slice(0, 120).replace(/\n/g, ' '));
  const X = events.filter((e) => e.ph === 'X' && typeof e.dur === 'number');
  const isTask = (n) => /RunTask|ThreadControllerImpl::RunTask|CrRendererMain/.test(String(n));
  const threadKey = (e) => `${e.pid}:${e.tid}`;
  const taskThreads = new Map();
  for (const e of X) if (isTask(e.name)) taskThreads.set(threadKey(e), (taskThreads.get(threadKey(e)) || 0) + 1);
  let mainKey = null; let mainN = -1;
  // 优先取 trace 里声明为 CrRendererMain 的线程（渲染主线程），否则退化为 RunTask 最多的线程
  for (const e of events) {
    if (e.ph === 'M' && e.name === 'thread_name' && e.args && String(e.args.name) === 'CrRendererMain') { mainKey = threadKey(e); break; }
  }
  if (!mainKey) { for (const [k, v] of taskThreads) if (v > mainN) { mainN = v; mainKey = k; } }
  const tasks = X.filter((e) => isTask(e.name) && e.dur >= 100000 && threadKey(e) === mainKey);
  // 调试：主线程最长的 X 事件（名称/时长），用于核对顶层任务命名
  try {
    const dbg = X.filter((e) => threadKey(e) === mainKey).sort((a, b) => b.dur - a.dur).slice(0, 12).map((e) => `${String(e.name)}:${Math.round(e.dur / 1000)}ms`);
    console.error('[trace2-main-top] ' + JSON.stringify(dbg));
  } catch { /* ignore */ }
  const rows = tasks.map((task) => {
    const from = task.ts; const to = task.ts + task.dur;
    const kids = X.filter((e) => e !== task && threadKey(e) === mainKey && e.ts >= from && e.ts + e.dur <= to);
    const catDur = {};
    let fnInfo = null; let fnDur = -1;
    for (const e of kids) {
      const cat = classifyCat(e.name);
      if (cat) catDur[cat] = (catDur[cat] || 0) + e.dur;
      const d = (e.args && e.args.data) || {};
      // 取「有 url/functionName 且最长」的事件作为脚本归因（优先 FunctionCall/EvaluateScript）
      if ((d.url || d.functionName) && e.dur > fnDur) { fnDur = e.dur; fnInfo = { url: String(d.url || ''), fn: String(d.functionName || e.name || '') }; }
    }
    let type = 'other'; let best = -1;
    for (const [c, v] of Object.entries(catDur)) if (v > best) { best = v; type = c; }
    // 触发者：TimerFire→timer；EventDispatch→DOM event；ParseHTML→parser；否则按 task 名/空
    let trigger = 'other';
    if ((catDur.timer || 0) > 0 && type === 'timer') trigger = 'timer';
    else if ((catDur.event || 0) > 0) trigger = 'DOM event';
    else if ((catDur.parseHTML || 0) > 0) trigger = 'parser';
    else if (type === 'scripting') trigger = 'script/microtask';
    const fnUrl = fnInfo ? fnInfo.url : '';
    return {
      tRelMs: Math.round((task.ts - t0 * 1000) / 1000),
      durMs: Math.round(task.dur / 1000),
      type,
      trigger,
      fn: fnInfo ? fnInfo.fn : '',
      url: fnUrl ? fnUrl.split('/').slice(-2).join('/') : '',
      host: fnUrl ? (fnUrl.startsWith('file:') ? 'shell-file' : (fnUrl.includes('127.0.0.1:55263') ? 'dsh-page' : 'other-url')) : 'native/no-url',
      cats: Object.fromEntries(Object.entries(catDur).map(([k, v]) => [k, Math.round(v / 1000)])),
    };
  }).sort((a, b) => b.durMs - a.durMs);
  const top10 = rows.slice(0, 10);
  const byType = {}; const byTrigger = {}; const byHost = {};
  for (const r of rows) { byType[r.type] = (byType[r.type] || 0) + 1; byTrigger[r.trigger] = (byTrigger[r.trigger] || 0) + 1; byHost[r.host] = (byHost[r.host] || 0) + 1; }
  const starts = rows.map((r) => r.tRelMs).sort((a, b) => a - b);
  // 主线程高频调用聚合：谁在反复跑（FunctionCall 按 url:function 统计次数与总时长）
  const callAgg = new Map();
  for (const e of X) {
    if (String(e.name) !== 'FunctionCall' || threadKey(e) !== mainKey) continue;
    const d = (e.args && e.args.data) || {};
    const url = String(d.url || ''); const fn = String(d.functionName || '');
    if (!url && !fn) continue;
    const key = `${url ? url.split('/').slice(-2).join('/') : '—'}:${fn || '—'}`;
    const cur = callAgg.get(key) || { key, count: 0, totalMs: 0, maxMs: 0 };
    cur.count += 1; cur.totalMs += e.dur / 1000; cur.maxMs = Math.max(cur.maxMs, e.dur / 1000);
    callAgg.set(key, cur);
  }
  const calls = Array.from(callAgg.values()).sort((a, b) => b.totalMs - a.totalMs).slice(0, 25).map((r) => ({ ...r, totalMs: Math.round(r.totalMs), maxMs: Math.round(r.maxMs) }));
  const gaps = [];
  for (let i = 1; i < starts.length; i += 1) gaps.push(starts[i] - starts[i - 1]);
  gaps.sort((a, b) => a - b);
  fs.mkdirSync(OUT, { recursive: true });
  const report = { at: new Date().toISOString(), port: PORT, seconds: SECONDS, target: { id: page.id, title: page.title, url: page.url }, mainThread: mainKey, longTaskCount: rows.length, byType, byTrigger, byHost, medianGapMs: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null, top10, calls, allRows: rows.slice(0, 60), note: '主线程顶层 RunTask >100ms；type 取窗口内累计时长最大的类别；calls 为主线程 FunctionCall 聚合（谁在反复跑）；Tracing 会放大数量与时长，判据用 prod-10min-post 观察器数据。' };
  fs.writeFileSync(path.join(OUT, 'trace2-report.json'), JSON.stringify(report, null, 2) + '\n');
  const md = [
    '# Tracing 归因 2（30s，target index.html，主线程）', '',
    `- 时间：${report.at}｜主线程：${mainKey}｜>100ms 顶层长任务：**${rows.length}**（Tracing 放大）｜中位间隔：${report.medianGapMs}ms`,
    `- type 聚合：\`${JSON.stringify(byType)}\``,
    `- 触发者聚合：\`${JSON.stringify(byTrigger)}\``,
    `- 来源聚合：\`${JSON.stringify(byHost)}\``, '',
    '## TOP10 长任务（type / URL:function / duration / 触发者）', '',
    '| # | type | URL:function | duration | 触发者 | 类别耗时(ms) |',
    '|---|---|---|---|---|---|',
    ...top10.map((r, i) => `| ${i + 1} | ${r.type} | ${r.url || '—'}:${r.fn || '—'} | ${r.durMs}ms | ${r.trigger} | ${JSON.stringify(r.cats)} |`), '',
    '## 主线程高频 FunctionCall（总时长 TOP15）', '',
    '| URL:function | 次数 | 总时长 | max |',
    '|---|---|---|---|',
    ...calls.slice(0, 15).map((c) => `| ${c.key} | ${c.count} | ${c.totalMs}ms | ${c.maxMs}ms |`), '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'trace2-report.md'), md, 'utf8');
  console.log(md);
  try { cdp.ws.close(); } catch { /* ignore */ }
  process.exit(0);
})().catch((e) => { console.error('FAILED', e && e.stack); process.exit(1); });
