'use strict';
/**
 * T-6626：真实隔离实例（非 selftest）验证 2s 心跳 + 主进程卡顿日志 + 10 次取令牌延迟。
 * 只 taskkill /PID 自己 child.pid；不改生产。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const BASE = path.join(ROOT, '_tmp', 'boot-watch-' + process.pid + '-' + Date.now());
const DATA = path.join(BASE, 'data');
const TEAM = path.join(BASE, '团队');
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const OUT = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-6626-20261122');
const PORT = 9940 + (process.pid % 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const httpJson = (url) => new Promise((resolve, reject) => { const req = http.get(url, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('timeout'))); });
async function waitPage(ms) { const end = Date.now() + ms; while (Date.now() < end) { try { const list = await httpJson('http://127.0.0.1:' + PORT + '/json/list'); const p = (list || []).find((t) => t.type === 'page' && /index\.html/i.test(String(t.url || ''))); if (p) return p; } catch { /* wait */ } await sleep(500); } return null; }
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(String(e.data)); } catch { return; } if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } }); }
  send(method, params = {}, ms = 30000) { const id = ++this.seq; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, ms); }); }
  async eval(expr, ms = 30000) { try { const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms); return out && out.result ? out.result.value : undefined; } catch (e) { return { __cdperror: String((e && e.message) || e) }; } }
}
fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
fs.mkdirSync(path.join(BASE, 'userdata'), { recursive: true });
fs.copyFileSync(path.join(ROOT, '团队', '状态', '团队.json'), path.join(TEAM, '状态', '团队.json'));
fs.copyFileSync(path.join(ROOT, 'data', 'userdata', 'workbench.json'), STORE);
fs.mkdirSync(OUT, { recursive: true });
const env = {
  ...process.env, AWB_DATA_DIR: DATA, AWB_STORE: STORE, TEAM_WORKBENCH_JSON: STORE,
  TEAM_ROOT: TEAM, AWB_TEAM_ROOT: process.env.AWB_TEAM_ROOT || path.join(ROOT, '团队'),
  AWB_BOOT_INDEX_TEST: '1', AWB_SHOW_INACTIVE: '1', DSH_WEB_URL: 'http://127.0.0.1:1',
};
delete env.TEAM_SELFTEST;
delete env.DSH_SESSION_ID;
const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(BASE, 'userdata')], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: false });
(async () => {
  let code = 1;
  try {
    const page = await waitPage(120000);
    if (!page) throw new Error('no page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    for (let i = 0; i < 100; i += 1) { if ((await cdp.eval('Boolean(window.workbench)')) === true) break; await sleep(300); }
    await sleep(4000);
    const probe = await cdp.eval('window.workbench.bootTokenIndexProbe ? window.workbench.bootTokenIndexProbe({ project: "工作台改造修复", role: "pm", count: 10 }) : { __missing: true }');
    await sleep(3000);
    const hbFile = path.join(DATA, '主进程心跳.json');
    const stallFile = path.join(DATA, '主进程卡顿.jsonl');
    const heartbeat = readJson(hbFile);
    const stalls = fs.existsSync(stallFile) ? fs.readFileSync(stallFile, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) : [];
    const over1s = stalls.filter((r) => Number(r && r.maxDelayMs) > 1000);
    const report = { at: new Date().toISOString(), pid: child.pid, port: PORT, probe, heartbeat, stallRows: stalls.length, over1s: over1s.length, stalls };
    fs.writeFileSync(path.join(OUT, 'boot-index-watch.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(OUT, 'boot-index-watch.log'), JSON.stringify({ pid: child.pid, probe, heartbeat, over1s: over1s.length }) + '\n', 'utf8');
    console.log('BOOT_WATCH ' + JSON.stringify({ pid: child.pid, probeMaxMs: probe && probe.maxMs, tokenFound: probe && probe.tokenFound, heartbeat: Boolean(heartbeat), heartbeatPid: heartbeat && heartbeat.pid, stallRows: stalls.length, over1s: over1s.length }));
    code = (probe && probe.ok === true && Number(probe.maxMs) < 50 && heartbeat && Number(heartbeat.pid) > 0 && over1s.length === 0) ? 0 : 1;
    try { await cdp.send('Browser.close', {}, 2000); } catch { /* ignore */ }
    try { ws.close(); } catch { /* ignore */ }
  } catch (e) { console.error('FAILED ' + String((e && e.stack) || e)); code = 1; }
  finally {
    try { child.kill(); } catch { /* ignore */ }
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
    await sleep(500);
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(code);
  }
})();
