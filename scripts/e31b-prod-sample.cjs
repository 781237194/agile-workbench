'use strict';
// R-e31b AC2 生产采样（只读）：连 PM/生产实例已开的 CDP 端口，target 限 url 含 index.html，
// 每 30s 读 usedJSHeapSize + PerformanceObserver 长任务，10 分钟；不点击、不 reload、不关闭任何窗口。
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
  const meta = { at: new Date().toISOString(), port: PORT, target: { id: page.id, title: page.title, url: page.url }, minutes: MINUTES };
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  await cdp.eval('(() => { window.__e31bProd = { count: 0, max: 0, over50: 0, over100: 0, items: [] }; try { window.__e31bProdObs && window.__e31bProdObs.disconnect(); } catch {} window.__e31bProdObs = new PerformanceObserver((list) => { for (const e of list.getEntries()) { const ms = Math.round(e.duration); const o = window.__e31bProd; o.count += 1; o.max = Math.max(o.max, ms); if (ms > 50) o.over50 += 1; if (ms > 100) { o.over100 += 1; o.items.push(ms); } } }); window.__e31bProdObs.observe({ entryTypes: [String.fromCharCode(108,111,110,103,116,97,115,107)] }); return true; })()');
  const lines = [];
  const deadline = Date.now() + MINUTES * 60000;
  while (Date.now() < deadline) {
    let heap = -1;
    try { heap = await cdp.eval('performance.memory ? performance.memory.usedJSHeapSize : -1'); } catch { /* ignore */ }
    lines.push(JSON.stringify({ at: new Date().toISOString(), tMs: Date.now() - t0, usedJSHeapSize: heap, targetId: page.id, title: page.title }));
    await sleep(30000);
  }
  let gcHeap = -1;
  try { await cdp.send('HeapProfiler.enable'); await cdp.send('HeapProfiler.collectGarbage'); await sleep(800); gcHeap = await cdp.eval('performance.memory ? performance.memory.usedJSHeapSize : -1'); } catch { /* ignore */ }
  const long = await cdp.eval('window.__e31bProd || null').catch(() => null);
  fs.writeFileSync(path.join(OUT, 'heap.jsonl'), lines.join('\n') + '\n');
  const report = { ...meta, samples: lines.length, heapFirst: JSON.parse(lines[0]).usedJSHeapSize, heapLast: JSON.parse(lines[lines.length - 1]).usedJSHeapSize, gcHeap, long };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ out: OUT, samples: lines.length, heapFirst: report.heapFirst, heapLast: report.heapLast, gcHeap, longCount: long && long.count, longMax: long && long.max, over100: long && long.over100 }));
  process.exit(0);
})().catch((e) => { console.error('FAILED', e && e.stack); process.exit(1); });
