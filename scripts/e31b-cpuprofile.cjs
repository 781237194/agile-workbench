'use strict';
// R-e31b/T-32a3（只读）：对生产壳实例 CDP（端口 9223，target index.html）跑 30s V8 CPU Profiler，
// 输出 self-time TOP 函数（url:line）+ 采样数，用于回答「周期性长任务来自壳还是 DSH 页面」。
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argOf('--port', '9223'));
const SECONDS = Number(argOf('--seconds', '30')) || 30;
const OUT = path.resolve(argOf('--out', path.join('_tmp', 'e31b-cpu-' + Date.now())));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.p = new Map(); }
  connect() { return new Promise((res, rej) => { const ws = new WebSocket(this.u); this.ws = ws; ws.onopen = res; ws.onerror = rej; ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && this.p.has(m.id)) { const q = this.p.get(m.id); this.p.delete(m.id); m.error ? q.reject(new Error(JSON.stringify(m.error))) : q.resolve(m.result); } } catch { /* ignore */ } }; }); }
  send(method, params = {}) { return new Promise((res, rej) => { const id = ++this.id; this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200)); return r.result ? r.result.value : undefined; }
}
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = (list || []).find((t) => t.type === 'page' && /index\.html/i.test(String(t.url || '')));
  if (!page) throw new Error('no index.html target');
  const cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.connect();
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
  await cdp.send('Profiler.start');
  const t0 = Date.now();
  await sleep(SECONDS * 1000);
  const { profile } = await cdp.send('Profiler.stop');
  const nodes = profile.nodes || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hit = new Map();
  for (const id of profile.samples || []) hit.set(id, (hit.get(id) || 0) + 1);
  const rows = [];
  for (const [id, count] of hit) {
    const n = byId.get(id); if (!n) continue;
    const cf = n.callFrame || {};
    const url = String(cf.url || '');
    rows.push({
      fn: String(cf.functionName || '(anonymous)'),
      url: url ? url.split('/').slice(-2).join('/') : '',
      line: cf.lineNumber,
      count,
      host: url.startsWith('file:') ? 'shell-file' : (url.includes('127.0.0.1:55263') ? 'dsh-page' : (url ? 'other' : 'native/no-url')),
    });
  }
  const merged = new Map();
  for (const r of rows) { const k = `${r.fn}@${r.url}:${r.line}`; const cur = merged.get(k) || { ...r, count: 0 }; cur.count += r.count; merged.set(k, cur); }
  const top = Array.from(merged.values()).sort((a, b) => b.count - a.count).slice(0, 20);
  const total = (profile.samples || []).length;
  const byHost = {};
  for (const r of rows) byHost[r.host] = (byHost[r.host] || 0) + r.count;
  fs.mkdirSync(OUT, { recursive: true });
  const report = { at: new Date().toISOString(), port: PORT, seconds: SECONDS, target: { id: page.id, title: page.title, url: page.url }, samples: total, byHost, top, note: '30s V8 CPU Profiler；count=1ms 采样命中数；host 由脚本 URL 判断。' };
  fs.writeFileSync(path.join(OUT, 'cpu-report.json'), JSON.stringify(report, null, 2) + '\n');
  const md = ['# CPU Profile 归因（30s，target index.html）', '', `- 时间：${report.at}｜采样数：${total}｜来源分布：\`${JSON.stringify(byHost)}\``, '', '| # | URL:function:line | 采样 | 来源 |', '|---|---|---|---|', ...top.slice(0, 15).map((r, i) => `| ${i + 1} | ${r.url || '—'}:${r.fn}:${r.line} | ${r.count} | ${r.host} |`), ''].join('\n');
  fs.writeFileSync(path.join(OUT, 'cpu-report.md'), md, 'utf8');
  console.log(md);
  try { cdp.ws.close(); } catch { /* ignore */ }
  process.exit(0);
})().catch((e) => { console.error('FAILED', e && e.stack); process.exit(1); });
