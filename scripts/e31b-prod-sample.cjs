'use strict';
// R-e31b AC2 生产采样（只读）：连 PM/生产实例已开的 CDP 端口，target 限 url 含 index.html，
// 每 30s 读 usedJSHeapSize + PerformanceObserver 长任务，10 分钟；不点击、不 reload、不关闭任何窗口。
// T-0f58 补强：记录 instanceStartTime（performance.timeOrigin），每样点校验 timeOrigin/连接，
// 窗口内一旦发现重启（timeOrigin 变 / CDP 断）立即标记 restartDetected 并提前收尾，产出 INVALID 标记，
// report.valid=false（退出码 4），该轮数据不得用于 AC 判定。
// 用法：node scripts/e31b-prod-sample.cjs --port 9223 --minutes 10 --out <dir>
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argOf('--port', '9223'));
const MINUTES = Number(argOf('--minutes', '10')) || 10;
const OUT = path.resolve(argOf('--out', path.join('_tmp', 'e31b-prod-' + Date.now())));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJson = (url) => new Promise((resolve, reject) => { const req = http.get(url, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('timeout'))); });
class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.p = new Map(); }
  connect() { return new Promise((res, rej) => { const ws = new WebSocket(this.u); this.ws = ws; ws.onopen = res; ws.onerror = rej; ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && this.p.has(m.id)) { const q = this.p.get(m.id); this.p.delete(m.id); m.error ? q.reject(new Error(JSON.stringify(m.error))) : q.resolve(m.result); } } catch { /* ignore */ } }; }); }
  send(method, params = {}) { return new Promise((res, rej) => { const id = ++this.id; this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200)); return r.result ? r.result.value : undefined; }
}
(async () => {
  const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = (list || []).find((t) => t.type === 'page' && /index\.html/i.test(String(t.url || '')));
  if (!page) throw new Error('no index.html target on port ' + PORT);
  const cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.connect();
  await cdp.send('Runtime.enable');
  const t0 = Date.now();
  fs.mkdirSync(OUT, { recursive: true });
  // 实例启动时间与「窗口内是否重启」基线：performance.timeOrigin 在渲染进程重启/reload 后会变。
  const base = await cdp.eval('({ timeOrigin: performance.timeOrigin, href: location.href, title: document.title })');
  const instanceStartTime = new Date(Number(base.timeOrigin)).toISOString();
  const meta = { at: new Date().toISOString(), port: PORT, target: { id: page.id, title: page.title, url: page.url }, minutes: MINUTES, instanceStartTime, instanceTimeOrigin: base.timeOrigin };
  let restartDetected = false;
  let restartInfo = null;
  const markRestart = (why, extra) => {
    if (restartDetected) return;
    restartDetected = true;
    restartInfo = { at: new Date().toISOString(), tMs: Date.now() - t0, why, ...extra };
    try { fs.writeFileSync(path.join(OUT, 'restart-detected.json'), JSON.stringify(restartInfo, null, 2) + '\n'); } catch { /* ignore */ }
  };
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  await cdp.eval('(() => { window.__e31bProd = { count: 0, max: 0, over50: 0, over100: 0, items: [] }; try { window.__e31bProdObs && window.__e31bProdObs.disconnect(); } catch {} window.__e31bProdObs = new PerformanceObserver((list) => { for (const e of list.getEntries()) { const ms = Math.round(e.duration); const o = window.__e31bProd; o.count += 1; o.max = Math.max(o.max, ms); if (ms > 50) o.over50 += 1; if (ms > 100) { o.over100 += 1; o.items.push(ms); } } }); window.__e31bProdObs.observe({ entryTypes: [String.fromCharCode(108,111,110,103,116,97,115,107)] }); return true; })()');
  const lines = [];
  // 增量落盘：即使进程被外部终止，也保留已采样本与进度（audit 用）。
  const flush = (final) => {
    try {
      fs.writeFileSync(path.join(OUT, 'heap.jsonl'), lines.join('\n') + '\n');
      const last = lines.length ? JSON.parse(lines[lines.length - 1]).usedJSHeapSize : -1;
      const simple = { at: meta.at, port: PORT, target: meta.target, minutes: MINUTES, instanceStartTime, restartDetected, restartInfo, samples: lines.length, heapFirst: lines.length ? JSON.parse(lines[0]).usedJSHeapSize : -1, heapLast: last, partial: !final };
      fs.writeFileSync(path.join(OUT, 'progress.json'), JSON.stringify(simple, null, 2) + '\n');
    } catch { /* ignore */ }
  };
  const onSignal = () => { flush(false); process.exit(3); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const deadline = Date.now() + MINUTES * 60000;
  while (Date.now() < deadline) {
    let heap = -1;
    let timeOrigin = null;
    try {
      const s = await cdp.eval('({ heap: performance.memory ? performance.memory.usedJSHeapSize : -1, timeOrigin: performance.timeOrigin })');
      heap = s.heap;
      timeOrigin = s.timeOrigin;
    } catch (e) {
      markRestart('cdp-error', { error: String((e && e.message) || e).slice(0, 200) });
      break;
    }
    if (Number(timeOrigin) !== Number(base.timeOrigin)) {
      markRestart('timeOrigin-changed', { oldTimeOrigin: base.timeOrigin, newTimeOrigin: timeOrigin });
      break;
    }
    lines.push(JSON.stringify({ at: new Date().toISOString(), tMs: Date.now() - t0, usedJSHeapSize: heap, timeOrigin, targetId: page.id, title: page.title }));
    flush(false);
    await sleep(30000);
  }
  let gcHeap = -1;
  try { await cdp.send('HeapProfiler.enable'); await cdp.send('HeapProfiler.collectGarbage'); await sleep(800); gcHeap = await cdp.eval('performance.memory ? performance.memory.usedJSHeapSize : -1'); } catch { /* ignore */ }
  const long = await cdp.eval('window.__e31bProd || null').catch(() => null);
  flush(true);
  const expected = Math.max(1, Math.floor((MINUTES * 60000) / 30000));
  const valid = !restartDetected && lines.length >= expected - 1;
  const report = {
    ...meta, samples: lines.length, expectedSamples: expected, valid, restartDetected, restartInfo,
    sampleWindow: { from: meta.at, to: new Date().toISOString() },
    heapFirst: lines.length ? JSON.parse(lines[0]).usedJSHeapSize : -1,
    heapLast: lines.length ? JSON.parse(lines[lines.length - 1]).usedJSHeapSize : -1,
    gcHeap, long
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (!valid) {
    fs.writeFileSync(path.join(OUT, 'INVALID'), `invalid: restartDetected=${restartDetected} samples=${lines.length}/${expected}\n`);
  }
  console.log(JSON.stringify({ out: OUT, valid, restartDetected, restartInfo, samples: lines.length, expectedSamples: expected, instanceStartTime, heapFirst: report.heapFirst, heapLast: report.heapLast, gcHeap, longCount: long && long.count, longMax: long && long.max, over100: long && long.over100 }));
  process.exit(valid ? 0 : 4);
})().catch((e) => { console.error('FAILED', e && e.stack); process.exit(1); });
