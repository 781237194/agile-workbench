'use strict';
/**
 * R-e31b / T-20261121-221124-f01c：主进程 RSS 真窗口采样（结构性压缩验收）。
 * 单实例沙盘：启动壳 → 用 app:state/workflow:state 压一遍缓存 → 间隔采样 mem:main-rss 3 次；
 * 不自动回收、不重载；结束只 taskkill 自己 child.pid 树并删沙盘，不碰生产。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SANDBOX_BASE = String.fromCharCode(68) + ':\\awb-sandbox';
const SANDBOX = fs.mkdtempSync(path.join(fs.existsSync(SANDBOX_BASE) ? SANDBOX_BASE : os.tmpdir(), 'f01c-rss-'));
const DATA = path.join(SANDBOX, 'data');
const TEAM = path.join(SANDBOX, '团队');
const PROJECT = path.join(SANDBOX, '项目区', '工作台改造修复');
const STORE = path.join(DATA, 'workbench.json');
const PORT = 19700 + Math.floor(Math.random() * 120);
const OUT = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-f01c-20261121');
fs.mkdirSync(OUT, { recursive: true });

function seed() {
  fs.mkdirSync(path.join(TEAM, '状态', '项目', '工作台改造修复'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '工具'), { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.writeFileSync(path.join(PROJECT, '项目信息.md'), '# 沙盘项目\n', 'utf8');
  const realStore = path.join(ROOT, 'data', 'userdata', 'workbench.json');
  const store = JSON.parse(fs.readFileSync(realStore, 'utf8'));
  for (const pj of store.projects || []) { pj.path = PROJECT; if (pj.workspace) pj.workspace.path = PROJECT; }
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2), 'utf8');
  const realTeam = path.join(ROOT, '团队', '状态', '团队.json');
  if (fs.existsSync(realTeam)) {
    const team = JSON.parse(fs.readFileSync(realTeam, 'utf8'));
    for (const m of team.members || []) m.sessionId = '';
    fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2), 'utf8');
  }
}
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    const c = new Cdp(ws);
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.id && c.pending.has(m.id)) { const p = c.pending.get(m.id); c.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    });
    return c;
  }
  send(method, params = {}, timeout = 15000) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout')); } }, timeout); }); }
  async eval(expr, timeout = 20000) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeout); if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r && r.result ? r.result.value : undefined; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJson = (url) => new Promise((resolve, reject) => { const req = http.get(url, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); req.on('error', reject); req.setTimeout(2500, () => req.destroy(new Error('timeout'))); });
let child = null;
const cleanup = () => {
  if (child && child.pid) {
    try { child.kill(); } catch { /* ignore */ }
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    child = null;
  }
  if (process.env.AWB_KEEP_SANDBOX === '1') return;
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('exit', cleanup);

(async () => {
  seed();
  const env = {
    ...process.env,
    AWB_TEAM_ROOT: TEAM, AWB_TEAM_PROJECTS_ROOT: path.join(SANDBOX, '项目区'),
    TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(SANDBOX, '项目区'),
    TEAM_WORKBENCH_JSON: STORE, AWB_STORE: STORE, AWB_DATA_DIR: DATA,
    AWB_DSH_BASE_URL: 'http://127.0.0.1:1', DSH_WEB_URL: 'http://127.0.0.1:1',
    AWB_SHOW_INACTIVE: '1', AWB_BOARD_PREGEN_MS: '0', AWB_MEM_RECYCLE_MB: '0',
    TEAM_SELFTEST: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.AWB_START_HIDDEN;
  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  child = spawn(electron, [ROOT, `--remote-debugging-port=${PORT}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  child.stderr.on('data', (d) => { stdout += String(d); });
  let shell = null; let target = null;
  for (let i = 0; i < 60 && !shell; i += 1) {
    await sleep(500);
    try {
      const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
      const hit = (list || []).find((t) => t.type === 'page' && /renderer\/index\.html/i.test(String(t.url || '')));
      if (hit) { shell = await Cdp.connect(hit.webSocketDebuggerUrl); target = { id: hit.id, title: hit.title, url: hit.url }; }
    } catch { /* retry */ }
  }
  if (!shell) throw new Error('shell target not ready');
  await shell.send('Runtime.enable');
  await sleep(4000);
  // 压一遍热点缓存（app:state / workflow:state 各 12 次），模拟日常刷新后的常驻对象。
  await shell.eval(`(async () => { for (let i=0;i<12;i+=1){ try{ await window.workbench.state(); } catch{} try{ await window.workbench.workflowState({}); } catch{} } return true; })()`, 60000).catch(() => null);
  const samples = [];
  for (let i = 0; i < 3; i += 1) {
    await sleep(2500);
    const r = await shell.eval('window.workbench.mainRss()');
    samples.push({ n: i + 1, at: new Date().toISOString(), ...r });
    console.log(`采样${i + 1}: rss=${r && r.rssMB}MB heap=${r && r.heapUsedMB}MB`);
  }
  const cacheStats = await shell.eval('window.workbench.cacheStats()').catch(() => null);
  const capsOk = Boolean(cacheStats && cacheStats.ok
    && Number(cacheStats.hotIpc.maxEntryBytes) <= Number(cacheStats.hotIpc.entryCapBytes)
    && Number(cacheStats.hotIpc.bytes) <= Number(cacheStats.hotIpc.totalCapBytes));
  const report = { ok: samples.every((s) => Number(s.rssMB) <= 400) && capsOk, target, samples, cacheStats, hotIpcCaps: { entryMaxKB: 512, totalMaxMB: 8 }, stdoutTail: stdout.slice(-2000) };
  fs.writeFileSync(path.join(OUT, 'main-rss-samples.json'), JSON.stringify(report, null, 2));
  console.log(`\n${report.ok ? 'PASS' : 'FAIL'}  主进程 RSS 3 次采样：` + samples.map((s) => s.rssMB + 'MB').join(' / '));
  console.log('缓存上限：' + (cacheStats ? `hot count=${cacheStats.hotIpc.count} bytes=${cacheStats.hotIpc.bytes} maxEntry=${cacheStats.hotIpc.maxEntryBytes}` : '未取到'));
  console.log('证据：' + path.join(OUT, 'main-rss-samples.json'));
  cleanup();
  process.exit(report.ok ? 0 : 1);
})().catch((error) => {
  try { fs.writeFileSync(path.join(OUT, 'main-rss-samples-error.json'), JSON.stringify({ error: String((error && error.stack) || error) }, null, 2)); } catch { /* ignore */ }
  console.error('FAILED', error && error.stack);
  cleanup();
  process.exit(1);
});
