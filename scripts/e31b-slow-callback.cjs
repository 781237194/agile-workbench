'use strict';
// R-e31b/T-20261122-061157-27a3：壳渲染进程长任务归因（只读生产采样工装）。
// 做法：PerformanceObserver(longtask) 记每条 >50ms 长任务；同时包装 setTimeout/setInterval/
// requestAnimationFrame/addEventListener 回调，回调执行 >80ms 时记「函数名 + 定义栈 + 运行栈 + 起止时间」，
// 再按时间重叠把长任务映射到慢回调/慢事件，给出 top 慢回调（函数 + 文件:行 + tick 猜测）。
// 用法：node scripts/e31b-slow-callback.cjs --port 9223 --minutes 10 --out <dir>
// 只读：不点击、不 reload、不关闭窗口；撞重启（performance.timeOrigin 变/连接断）自动标 invalid。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argOf('--port', '9223'));
const MINUTES = Number(argOf('--minutes', '10')) || 10;
const SLOW_MS = Number(argOf('--slow-ms', '80')) || 80;
const OUT = path.resolve(argOf('--out', path.join('_tmp', 'e31b-slow-' + Date.now())));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJson = (url) => new Promise((resolve, reject) => { const req = http.get(url, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('timeout'))); });
class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.p = new Map(); }
  connect() { return new Promise((res, rej) => { const ws = new WebSocket(this.u); this.ws = ws; ws.onopen = res; ws.onerror = rej; ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && this.p.has(m.id)) { const q = this.p.get(m.id); this.p.delete(m.id); m.error ? q.reject(new Error(JSON.stringify(m.error))) : q.resolve(m.result); } } catch { /* ignore */ } }; }); }
  send(method, params = {}) { return new Promise((res, rej) => { const id = ++this.id; this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result ? r.result.value : undefined; }
}
const INSTRUMENT = `(() => {
  if (window.__e31bSlow) { try { window.__e31bSlowObs && window.__e31bSlowObs.disconnect(); } catch (e) {} }
  var SLOW_MS = ${SLOW_MS};
  var D = { startedAt: Date.now(), longtasks: [], slow: [], heap: [], sampleAt: performance.now() };
  window.__e31bSlow = D;
  function nowMs() { return Math.round(performance.now() * 10) / 10; }
  function stackOf(skip) { try { var e = new Error(); return String(e.stack || '').split('\\n').slice(skip || 2, (skip || 2) + 6).map(function (s) { return s.trim(); }).join(' | '); } catch (e) { return ''; } }
  try {
    var obs = new PerformanceObserver(function (list) {
      var ents = list.getEntries();
      for (var i = 0; i < ents.length; i += 1) {
        var e = ents[i];
        D.longtasks.push({ name: String(e.name || 'longtask'), start: Math.round(e.startTime * 10) / 10, dur: Math.round(e.duration * 10) / 10, at: Date.now() });
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
    window.__e31bSlowObs = obs;
  } catch (e) { /* longtask 不支持时仍可看慢回调 */ }
  function noteSlow(kind, label, fnName, ms, tStart, defineStack) {
    if (ms < SLOW_MS) return;
    D.slow.push({ kind: kind, label: String(label || ''), fn: String(fnName || '(anon)'), ms: Math.round(ms * 10) / 10, tStart: tStart, tEnd: Math.round((tStart + ms) * 10) / 10, at: Date.now(), runStack: stackOf(4), defineStack: String(defineStack || '') });
  }
  function wrapTimer(key, kind) {
    var orig = window[key];
    if (typeof orig !== 'function') return;
    window[key] = function () {
      var a = Array.prototype.slice.call(arguments);
      var cb = a[0];
      if (typeof cb === 'function') {
        var defStack = stackOf(3);
        var label = key + (kind === 'interval' ? ':' + String(a[1]) : '');
        a[0] = function () {
          var t0 = performance.now();
          try { return cb.apply(this, arguments); } finally { noteSlow(kind, label, cb.name, performance.now() - t0, t0, defStack); }
        };
      }
      return orig.apply(window, a);
    };
  }
  wrapTimer('setTimeout', 'timer');
  wrapTimer('setInterval', 'interval');
  var origRaf = window.requestAnimationFrame;
  if (typeof origRaf === 'function') {
    window.requestAnimationFrame = function (cb) {
      if (typeof cb !== 'function') return origRaf.call(window, cb);
      var defStack = stackOf(3);
      return origRaf.call(window, function (ts) {
        var t0 = performance.now();
        try { return cb(ts); } finally { noteSlow('raf', 'requestAnimationFrame', cb.name, performance.now() - t0, t0, defStack); }
      });
    };
  }
  try {
    var origAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, opts) {
      if (typeof listener !== 'function') return origAdd.call(this, type, listener, opts);
      var defStack = stackOf(3);
      var wrapped = function (ev) {
        var t0 = performance.now();
        try { return listener.call(this, ev); } finally { noteSlow('event', String(type), listener.name, performance.now() - t0, t0, defStack); }
      };
      return origAdd.call(this, type, wrapped, opts);
    };
  } catch (e) { /* ignore */ }
  // 每 30s 记一次堆与长任务累计（用于报告）
  D.timer = setInterval(function () {
    try { D.heap.push({ at: Date.now(), usedJSHeapSize: performance.memory ? performance.memory.usedJSHeapSize : -1, longCount: D.longtasks.length, slowCount: D.slow.length }); } catch (e) { /* ignore */ }
  }, 30000);
  return { ok: true, slowMs: SLOW_MS };
})()`;

/** V8 CPU profile → 按「函数 + 文件:行」聚合自耗时；并按性能时间轴把样本映射进每个长任务窗口。 */
function profileSummary(profile, startPerfMs, longtasks) {
  if (!profile || !Array.isArray(profile.nodes) || !Array.isArray(profile.samples)) return null;
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const deltas = Array.isArray(profile.timeDeltas) ? profile.timeDeltas : [];
  const samples = profile.samples;
  const totals = new Map();
  const lts = (Array.isArray(longtasks) ? longtasks : []).slice().sort((a, b) => Number(a.start) - Number(b.start));
  const byLongtask = lts.map((lt) => ({ start: Number(lt.start), dur: Number(lt.dur), totals: new Map() }));
  let tUs = 0;
  let cursor = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const delta = Number(deltas[i]) || 0;
    tUs += delta;
    const node = nodes.get(samples[i]);
    if (!node) continue;
    const cf = node.callFrame || {};
    const key = `${cf.functionName || '(anon)'}|${cf.url || ''}|${(Number(cf.lineNumber) || 0) + 1}`;
    const acc = totals.get(key) || { fn: cf.functionName || '(anon)', url: String(cf.url || ''), line: (Number(cf.lineNumber) || 0) + 1, selfMs: 0, samples: 0 };
    acc.selfMs += delta / 1000;
    acc.samples += 1;
    totals.set(key, acc);
    const atMs = startPerfMs + tUs / 1000;
    while (cursor < byLongtask.length && byLongtask[cursor].start + byLongtask[cursor].dur < atMs) cursor += 1;
    let j = cursor;
    while (j < byLongtask.length && byLongtask[j].start <= atMs) {
      const lt = byLongtask[j];
      if (atMs >= lt.start && atMs <= lt.start + lt.dur) {
        const a2 = lt.totals.get(key) || { fn: cf.functionName || '(anon)', url: String(cf.url || ''), line: (Number(cf.lineNumber) || 0) + 1, selfMs: 0, samples: 0 };
        a2.selfMs += delta / 1000;
        a2.samples += 1;
        lt.totals.set(key, a2);
      }
      j += 1;
    }
  }
  const round = (v) => Math.round(v * 10) / 10;
  return {
    totalSamples: samples.length,
    durationMs: Math.round(tUs / 1000),
    top: Array.from(totals.values()).sort((a, b) => b.selfMs - a.selfMs).slice(0, 30).map((x) => ({ ...x, selfMs: round(x.selfMs) })),
    byLongtask: byLongtask.map((lt) => ({ start: lt.start, dur: lt.dur, top: Array.from(lt.totals.values()).sort((a, b) => b.selfMs - a.selfMs).slice(0, 12).map((x) => ({ ...x, selfMs: round(x.selfMs) })) })),
  };
}

function aggregate(dump, meta, profiler) {
  const lts = Array.isArray(dump.longtasks) ? dump.longtasks : [];
  const slow = Array.isArray(dump.slow) ? dump.slow : [];
  const topFrame = (s) => {
    const text = String(s || '');
    const frames = text.split('|').map((x) => x.trim()).filter(Boolean);
    const pick = frames.find((x) => /(https?:|file:|app\.js|fx-layer|at )/.test(x)) || frames[0] || '';
    return pick.replace(/^at\s+/, '').slice(0, 180);
  };
  const groups = new Map();
  for (const s of slow) {
    const frame = topFrame(s.runStack);
    const key = `${s.kind}|${s.label}|${s.fn}|${frame}`;
    const g = groups.get(key) || { kind: s.kind, label: s.label, fn: s.fn, frame, count: 0, totalMs: 0, maxMs: 0, samples: [] };
    g.count += 1;
    g.totalMs = Math.round((g.totalMs + Number(s.ms || 0)) * 10) / 10;
    g.maxMs = Math.max(g.maxMs, Number(s.ms || 0));
    if (g.samples.length < 3) g.samples.push({ ms: s.ms, tStart: s.tStart, at: s.at, defineStack: String(s.defineStack || '').split('|').slice(0, 4).join(' | ').slice(0, 300) });
    groups.set(key, g);
  }
  const top = Array.from(groups.values()).sort((a, b) => b.totalMs - a.totalMs).slice(0, 25);
  const overlaps = (lt, s) => Number(s.tStart) < Number(lt.start) + Number(lt.dur) + 1 && Number(s.tEnd) > Number(lt.start) - 1;
  const ltMap = lts.filter((lt) => Number(lt.dur) >= 100).map((lt) => {
    const hits = slow.filter((s) => overlaps(lt, s)).slice(0, 8).map((s) => ({ kind: s.kind, label: s.label, fn: s.fn, ms: s.ms, runStack: String(s.runStack || '').split('|').slice(0, 3).join(' | ').slice(0, 240) }));
    return { start: lt.start, dur: lt.dur, hits };
  });
  const over100 = lts.filter((lt) => Number(lt.dur) >= 100);
  const report = {
    ...meta,
    longtasks: { count: lts.length, over100: over100.length, maxMs: lts.reduce((m, lt) => Math.max(m, Number(lt.dur) || 0), 0), items: lts.filter((lt) => Number(lt.dur) >= 100) },
    slowCallbacks: { count: slow.length, top, byKind: slow.reduce((acc, s) => { acc[s.kind] = (acc[s.kind] || 0) + 1; return acc; }, {}) },
    longtaskAttribution: ltMap,
    heapSamples: Array.isArray(dump.heap) ? dump.heap : [],
    profiler: profiler || null
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'slow-callback-report.json'), JSON.stringify(report, null, 2) + '\n');
  const md = ['# 壳渲染进程长任务归因（T-27a3）', '', `- 窗口：${meta.startedAt} → ${meta.endedAt}｜instanceStartTime=${meta.instanceStartTime}｜valid=${meta.valid}｜restartDetected=${meta.restartDetected}`, '',
    '## 长任务', '', `- 总 ${report.longtasks.count} 条，>100ms ${over100.length} 条，max ${Math.round(report.longtasks.maxMs)}ms`, '',
    '| start(ms) | 时长(ms) | 重叠的慢回调 |', '|---|---|---|',
    ...ltMap.slice(0, 30).map((x) => `| ${x.start} | ${x.dur} | ${x.hits.map((h) => `${h.kind}/${h.label}/${h.fn}(${h.ms}ms)`).join('；') || '—'} |`), '',
    '## Top 慢回调（>80ms）', '', '| kind | label | 函数 | 次数 | 总时长(ms) | max(ms) | 文件:行 |', '|---|---|---|---|---|---|---|',
    ...top.map((g) => `| ${g.kind} | ${g.label} | ${g.fn} | ${g.count} | ${Math.round(g.totalMs)} | ${Math.round(g.maxMs)} | ${g.frame} |`), '',
    ...(profiler && profiler.top ? [
      '## V8 CPU Profile · Top 函数（自耗时汇总）', '', '| 函数 | 文件:行 | 自耗时(ms) | 样本数 |', '|---|---|---|---|',
      ...profiler.top.slice(0, 20).map((x) => `| ${x.fn} | ${x.url ? x.url.replace(/^.*[\\/]/, '') : '?'}:${x.line} | ${x.selfMs} | ${x.samples} |`), '',
      '## 每个 >100ms 长任务窗口内的 Top 函数', '', '| start(ms) | 时长(ms) | Top 函数（文件:行，自耗时） |', '|---|---|---|',
      ...profiler.byLongtask.filter((x) => Number(x.dur) >= 100).map((x) => `| ${x.start} | ${x.dur} | ${(x.top || []).slice(0, 5).map((f) => `${f.fn}(${f.url ? f.url.replace(/^.*[\\/]/, '') : '?'}:${f.line}, ${f.selfMs}ms)`).join('；') || '—'} |`), ''
    ] : ['## V8 CPU Profile', '', '（未采集到 profile）', '']),
    '## 证据', '', '- slow-callback-report.json（longtasks/slowCallbacks/longtaskAttribution/profiler/heapSamples 全量）', ''].join('\n');
  fs.writeFileSync(path.join(OUT, 'slow-callback-report.md'), md + '\n', 'utf8');
  console.log(md);
  console.log(JSON.stringify({ out: OUT, valid: meta.valid, longCount: report.longtasks.count, over100: over100.length, maxMs: Math.round(report.longtasks.maxMs), slowCount: slow.length, top: top.slice(0, 5).map((g) => ({ kind: g.kind, fn: g.fn, count: g.count, totalMs: g.totalMs, frame: g.frame })) }));
}

(async () => {
  const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = (list || []).find((t) => t.type === 'page' && /index\.html/i.test(String(t.url || '')));
  if (!page) throw new Error('no index.html target on port ' + PORT);
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  const t0 = Date.now();
  const base = await cdp.eval('({ timeOrigin: performance.timeOrigin, href: location.href, title: document.title })');
  const meta = { at: new Date().toISOString(), startedAt: new Date().toISOString(), port: PORT, target: { id: page.id, title: page.title, url: page.url }, minutes: MINUTES, slowMs: SLOW_MS, instanceStartTime: new Date(Number(base.timeOrigin)).toISOString(), instanceTimeOrigin: base.timeOrigin };
  const instrument = await cdp.eval(INSTRUMENT);
  // V8 CPU 采样：把长任务里的自耗时精确归到「函数 + 文件:行」（1ms 采样）。
  let profilerStarted = false;
  let profileStartPerf = 0;
  try {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
    await cdp.send('Profiler.start');
    profileStartPerf = Number(await cdp.eval('performance.now()')) || 0;
    profilerStarted = true;
  } catch (e) { profilerStarted = false; }
  let restartDetected = false;
  let restartInfo = null;
  const markRestart = (why, extra) => { if (restartDetected) return; restartDetected = true; restartInfo = { at: new Date().toISOString(), why, ...extra }; };
  const deadline = Date.now() + MINUTES * 60000;
  while (Date.now() < deadline) {
    try {
      const s = await cdp.eval('({ timeOrigin: performance.timeOrigin, heap: performance.memory ? performance.memory.usedJSHeapSize : -1, longCount: window.__e31bSlow ? window.__e31bSlow.longtasks.length : -1, slowCount: window.__e31bSlow ? window.__e31bSlow.slow.length : -1 })');
      if (Number(s.timeOrigin) !== Number(base.timeOrigin)) { markRestart('timeOrigin-changed', { old: base.timeOrigin, next: s.timeOrigin }); break; }
    } catch (e) { markRestart('cdp-error', { error: String((e && e.message) || e).slice(0, 200) }); break; }
    await sleep(30000);
  }
  let dump = null;
  try { dump = await cdp.eval('window.__e31bSlowDump ? window.__e31bSlowDump() : (function(){ if(!window.__e31bSlow) return null; var d = window.__e31bSlow; try { clearInterval(d.timer); } catch(e){} return { startedAt: d.startedAt, longtasks: d.longtasks, slow: d.slow, heap: d.heap }; })()'); } catch (e) { dump = null; }
  if (!dump) dump = { startedAt: null, longtasks: [], slow: [], heap: [] };
  let profiler = null;
  if (profilerStarted) {
    try { const pr = await cdp.send('Profiler.stop'); profiler = profileSummary(pr && pr.profile, profileStartPerf, dump.longtasks); } catch (e) { profiler = null; }
  }
  const endedAt = new Date().toISOString();
  const valid = !restartDetected && Array.isArray(dump.longtasks) && Date.now() - t0 >= MINUTES * 60000 * 0.9;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({ ...meta, instrument, valid, restartDetected, restartInfo, endedAt }, null, 2) + '\n');
  aggregate(dump, { ...meta, endedAt, valid, restartDetected, restartInfo }, profiler);
  process.exit(valid ? 0 : 4);
})().catch((e) => { console.error('FAILED', e && e.stack); process.exit(1); });
