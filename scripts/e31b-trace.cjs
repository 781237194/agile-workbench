'use strict';
// R-e31b/T-32a3（只读归因）：连生产壳实例 CDP（端口 9223，target index.html），
// 用 Tracing 抓 30 秒，输出 TOP10 >100ms 长任务的 type / URL:function / duration + 周期性判定。
// 不点击、不 reload、不关闭任何窗口。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argOf('--port', '9223'));
const SECONDS = Number(argOf('--seconds', '30')) || 30;
const OUT = path.resolve(argOf('--out', path.join('_tmp', 'e31b-trace-' + Date.now())));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJson = async (url) => { const r = await fetch(url); return r.json(); };
class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.p = new Map(); this.handlers = []; }
  connect() { return new Promise((res, rej) => { const ws = new WebSocket(this.u); this.ws = ws; ws.onopen = res; ws.onerror = rej; ws.onmessage = (ev) => { let m = null; try { m = JSON.parse(ev.data); } catch { return; } for (const h of this.handlers) { try { h(m); } catch { /* ignore */ } } if (m.id && this.p.has(m.id)) { const q = this.p.get(m.id); this.p.delete(m.id); m.error ? q.reject(new Error(JSON.stringify(m.error))) : q.resolve(m.result); } }; }); }
  send(method, params = {}) { return new Promise((res, rej) => { const id = ++this.id; this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  on(h) { this.handlers.push(h); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200)); return r.result ? r.result.value : undefined; }
}
const classify = (ev, data) => {
  const fn = (data && (data.functionName || data.name || '')) || '';
  const url = (data && (data.url || data.scriptName || '')) || '';
  return { fn: String(fn), url: String(url) };
};
(async () => {
  const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = (list || []).find((t) => t.type === 'page' && /index\.html/i.test(String(t.url || '')));
  if (!page) throw new Error('no index.html target');
  const cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.connect();
  await cdp.send('Runtime.enable');
  const chunks = [];
  let streamHandle = null;
  let complete = false;
  cdp.on((m) => {
    if (m.method === 'Tracing.dataCollected' && m.params && Array.isArray(m.params.value)) chunks.push(JSON.stringify(m.params.value));
    if (m.method === 'Tracing.tracingComplete' && m.params) { streamHandle = m.params.stream || null; complete = true; }
  });
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,v8,disabled-by-default-v8.cpu_profiler',
    transferMode: 'ReturnAsStream',
  });
  const t0 = Date.now();
  await sleep(SECONDS * 1000);
  await cdp.send('Tracing.end');
  for (let i = 0; i < 60 && !complete; i += 1) await sleep(500);
  // 读流（JSON 数组，按块累积）
  if (streamHandle) {
    let eof = false;
    while (!eof) {
      const r = await cdp.send('IO.read', { handle: streamHandle, size: 1024 * 1024 });
      if (r && r.data) chunks.push(r.data);
      if (!r || r.eof) { eof = true; break; }
    }
  }
  const raw = chunks.join('');
  let events = [];
  try { events = JSON.parse(raw); } catch { events = []; }
  if (!Array.isArray(events)) events = Array.isArray(events && events.traceEvents) ? events.traceEvents : [];
  if (!events.length) { try { const arr = JSON.parse('[' + raw.split('\n').filter(Boolean).join(',') + ']'); events = Array.isArray(arr) ? arr : []; } catch { /* ignore */ } }
  if (!Array.isArray(events)) events = [];
  // TOP 长任务：顶层 RunTask（含 devtools.timeline ThreadControllerImpl::RunTask）>100ms
  const X = events.filter((e) => e.ph === 'X' && typeof e.dur === 'number');
  const isTask = (n) => n === 'RunTask' || n === 'ThreadControllerImpl::RunTask' || n === 'CrRendererMain' || n === 'ThreadPoolForegroundWorker';
  const tasks = X.filter((e) => isTask(String(e.name)) && e.dur >= 100000);
  const rows = tasks.map((task) => {
    const from = task.ts; const to = task.ts + task.dur;
    // 只取同一进程/线程内的事件（trace 含 GPU/GC/其它线程，混进来会把 1.5s 的 MinorGC 当成子事件）
    const kids = X.filter((e) => e !== task && e.pid === task.pid && e.tid === task.tid && e.ts >= from && e.ts + e.dur <= to);
    const isGc = (n) => /MinorGC|MajorGC|GCEvent|MarkCompact|Scavenge|V8\.GC/i.test(String(n));
    const nonGc = kids.filter((e) => !isGc(e.name));
    nonGc.sort((a, b) => b.dur - a.dur);
    const top = nonGc[0] || null;
    // 递归找 TimerFire/EventDispatch 里的 FunctionCall（带 url/functionName）
    let fnInfo = null;
    if (top) {
      const stack = [top];
      while (stack.length && !fnInfo) {
        const cur = stack.shift();
        const d = (cur.args && cur.args.data) || {};
        if (d.url || d.functionName) fnInfo = { url: String(d.url || ''), fn: String(d.functionName || d.name || cur.name || '') };
        const childList = kids.filter((e) => e.ts >= cur.ts && e.ts + e.dur <= cur.ts + cur.dur && e !== cur);
        stack.push(...childList.slice(0, 20));
      }
    }
    return {
      startMs: Math.round((task.ts / 1000) * 1000) / 1000,
      tRelMs: Math.round((task.ts - t0 * 1000) / 1000),
      durMs: Math.round(task.dur / 1000),
      taskName: String(task.name),
      type: top ? String(top.name) : '(native-only)',
      fn: fnInfo ? fnInfo.fn : '',
      url: fnInfo ? fnInfo.url.split('/').slice(-2).join('/') : '',
      urlHost: fnInfo && fnInfo.url ? (fnInfo.url.startsWith('file:') ? 'shell-file' : (fnInfo.url.includes('127.0.0.1:55263') ? 'dsh-page' : 'other-url')) : 'native/no-url',
    };
  }).sort((a, b) => b.durMs - a.durMs);
  const top10 = rows.slice(0, 10);
  const byType = {};
  for (const r of rows) byType[r.type] = (byType[r.type] || 0) + 1;
  const byHost = {};
  for (const r of rows) byHost[r.urlHost] = (byHost[r.urlHost] || 0) + 1;
  // 周期性：相邻长任务的间隔中位数 + 是否集中在某类
  const starts = rulesSorted(rows.map((r) => r.tRelMs));
  function rulesSorted(a) { return a.slice().sort((x, y) => x - y); }
  const gaps = [];
  for (let i = 1; i < starts.length; i += 1) gaps.push(starts[i] - starts[i - 1]);
  gaps.sort((a, b) => a - b);
  const medGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  fs.mkdirSync(OUT, { recursive: true });
  const report = {
    at: new Date().toISOString(), port: PORT, seconds: SECONDS, target: { id: page.id, title: page.title, url: page.url },
    longTaskCount: rows.length, byType, byHost, medianGapMs: medGap, top10,
    note: '只读 CDP Tracing（抓 30s）；type 取长任务窗口内最长子事件名（TimerFire/FunctionCall/UpdateLayoutTree/Paint 等）；urlHost 判来源：shell-file=壳代码，dsh-page=DSH 页面，native/no-url=原生/无栈。',
  };
  fs.writeFileSync(path.join(OUT, 'trace-report.json'), JSON.stringify(report, null, 2) + '\n');
  const md = ['# Tracing 归因（30s，target index.html）', '', `- 时间：${report.at}｜长任务（>100ms）数量：**${rows.length}**（30s）｜中位间隔：${medGap}ms`, '', '## TOP10 长任务', '', '| # | type | URL:function | duration | 来源 |', '|---|---|---|---|---|', ...top10.map((r, i) => `| ${i + 1} | ${r.type} | ${r.url || '—'}:${r.fn || '—'} | ${r.durMs}ms | ${r.urlHost} |`), '', '## 聚合', '', `- type：\`${JSON.stringify(byType)}\``, `- 来源：\`${JSON.stringify(byHost)}\``, `- 中位间隔：${medGap}ms（195 次/10min ≈ 3077ms 若全为长任务）`, ''].join('\n');
  fs.writeFileSync(path.join(OUT, 'trace-report.md'), md, 'utf8');
  console.log(md);
  try { cdp.ws.close(); } catch { /* ignore */ }
  process.exit(0);
})().catch((e) => { console.error('FAILED', e && e.stack); process.exit(1); });
