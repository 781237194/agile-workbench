'use strict';
/**
 * T-18bf 主进程 CPU 调用链抓取：启动隔离实例（真实 team 数据副本 + 真实 DSH 页面，--inspect=9229），
 * Node Inspector Profiler.start 12s → 按 self-time 聚合 TOP5 + 父链；同时记录主进程 RSS/CPU。
 * 不碰生产；只回收自己 spawn 的 child.pid 树。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SANDBOX_BASE = String.fromCharCode(68) + ':\\awb-sandbox';
const SANDBOX = fs.mkdtempSync(path.join(fs.existsSync(SANDBOX_BASE) ? SANDBOX_BASE : os.tmpdir(), '18bf-prof-'));
const DATA = path.join(SANDBOX, 'data');
const TEAM = path.join(SANDBOX, '团队');
const PROJECT = path.join(SANDBOX, '项目区', '工作台改造修复');
const STORE = path.join(DATA, 'workbench.json');
const OUT = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-f01c-20261121');
fs.mkdirSync(OUT, { recursive: true });
const INSPECT_PORT = 9229;
const DEBUG_PORT = 19300 + Math.floor(Math.random() * 80);

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
  const realProjectState = path.join(ROOT, '团队', '状态', '项目', '工作台改造修复');
  if (fs.existsSync(realProjectState)) { try { fs.cpSync(realProjectState, path.join(TEAM, '状态', '项目', '工作台改造修复'), { recursive: true }); } catch { /* ignore */ } }
  // 真实 DSH 凭据副本：只读，让 webview 能连上生产 DSH 页面（不写 DSH_HOME）
  const dshHome = path.join(SANDBOX, 'dsh-home');
  fs.mkdirSync(dshHome, { recursive: true });
  try { if (process.env.USERPROFILE) fs.copyFileSync(path.join(process.env.USERPROFILE, '.dsh', '.credentials.yaml'), path.join(dshHome, '.credentials.yaml')); } catch { /* ignore */ }
  return dshHome;
}
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
    const c = new Cdp(ws);
    ws.addEventListener('message', (ev) => { let m; try { m = JSON.parse(String(ev.data)); } catch { return; } if (m.id && c.pending.has(m.id)) { const p = c.pending.get(m.id); c.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
    return c;
  }
  send(method, params = {}, timeout = 20000) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, timeout); }); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function osCpuSeconds(pid) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).TotalProcessorTime.TotalSeconds`], { encoding: 'utf8', timeout: 8000 }).trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}
const httpJson = (url) => new Promise((resolve, reject) => { const req = http.get(url, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); req.on('error', reject); req.setTimeout(2500, () => req.destroy(new Error('timeout'))); });
let child = null;
const cleanup = () => {
  if (child && child.pid) { try { child.kill(); } catch { /* ignore */ } try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } child = null; }
  if (process.env.AWB_KEEP_SANDBOX === '1') return;
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('exit', cleanup);

function aggregate(profile) {
  const nodes = new Map((profile.nodes || []).map((n) => [n.id, n]));
  const parentOf = new Map();
  for (const n of profile.nodes || []) for (const child of n.children || []) parentOf.set(child, n.id);
  const self = new Map();
  const total = (profile.timeDeltas || []).reduce((a, b) => a + Math.max(0, b), 0);
  const samples = profile.samples || [];
  const deltas = profile.timeDeltas || [];
  for (let i = 0; i < samples.length; i += 1) {
    const id = samples[i];
    const us = Math.max(1, deltas[i] || 1);
    self.set(id, (self.get(id) || 0) + us);
  }
  const labelOf = (id) => { const n = nodes.get(id); const cf = n && n.callFrame; if (!cf) return ''; return `${cf.functionName || '(anon)'}@${String(cf.url || '').split('/').pop()}:${(cf.lineNumber || 0) + 1}`; };
  const chainOf = (id) => { const parts = []; let cur = id; for (let i = 0; i < 8; i += 1) { const p = parentOf.get(cur); if (!p) break; parts.push(labelOf(p)); cur = p; } return parts.join(' < '); };
  const rows = [];
  for (const [id, us] of self.entries()) {
    const n = nodes.get(id); if (!n) continue;
    const cf = n.callFrame || {};
    rows.push({ name: cf.functionName || '(anon)', url: String(cf.url || ''), line: (cf.lineNumber || 0) + 1, selfMs: Math.round((us / 1000) * 10) / 10, parent: chainOf(id) });
  }
  rows.sort((a, b) => b.selfMs - a.selfMs);
  return { durationSec: Math.round((total / 1000000) * 100) / 100, top: rows.slice(0, 8) };
}

(async () => {
  const dshHome = seed();
  const env = {
    ...process.env,
    AWB_TEAM_ROOT: TEAM, AWB_TEAM_PROJECTS_ROOT: path.join(SANDBOX, '项目区'),
    TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(SANDBOX, '项目区'),
    TEAM_WORKBENCH_JSON: STORE, AWB_STORE: STORE, AWB_DATA_DIR: DATA, DSH_HOME: dshHome,
    AWB_SHOW_INACTIVE: '1', AWB_BOARD_PREGEN_MS: '0', AWB_MEM_RECYCLE_MB: '0', TEAM_SELFTEST: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.AWB_PROFILE_NO_DSH === '1') {
    env.AWB_DSH_BASE_URL = 'http://127.0.0.1:1';
    env.DSH_WEB_URL = 'http://127.0.0.1:1';
  }
  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  child = spawn(electron, [ROOT, `--inspect=${INSPECT_PORT}`, `--remote-debugging-port=${DEBUG_PORT}`].concat(process.env.AWB_PROFILE_DISABLE_GPU === '1' ? ['--disable-gpu'] : []), { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  child.stderr.on('data', (d) => { stdout += String(d); });
  let mainInspector = null;
  for (let i = 0; i < 60 && !mainInspector; i += 1) {
    await sleep(500);
    try {
      const list = await httpJson(`http://127.0.0.1:${INSPECT_PORT}/json/list`);
      const hit = (list || []).find((t) => t.webSocketDebuggerUrl);
      if (hit) mainInspector = await Cdp.connect(hit.webSocketDebuggerUrl);
    } catch { /* retry */ }
  }
  if (!mainInspector) throw new Error('main inspector not ready: ' + stdout.slice(-800));
  // 先连壳页面：profile 期间每秒触发一次 team:session-queue，复现面板轮询（生产主 CPU 的主要来源之一）。
  let shell = null;
  for (let i = 0; i < 40 && !shell; i += 1) {
    await sleep(500);
    try {
      const list = await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const page = (list || []).find((t) => t.type === 'page' && /renderer\/index\.html/.test(t.url || ''));
      if (page) { shell = await Cdp.connect(page.webSocketDebuggerUrl); await shell.send('Runtime.enable'); }
    } catch { /* retry */ }
  }
  // 等启动期结束，再采稳态 12s。
  await sleep(10000);
  if (shell && process.env.AWB_PROFILE_HIDE === '1') {
    await shell.send('Runtime.evaluate', { expression: "window.workbench.windowControl('hide')", awaitPromise: true, returnByValue: true }).catch(() => null);
    await sleep(2000);
  }
  // 先取一次接口值，重置 process.cpuUsage 窗口；OS 口径同时取 TotalProcessorTime。
  if (shell) await shell.send('Runtime.evaluate', { expression: 'window.workbench.mainRss()', awaitPromise: true, returnByValue: true }).catch(() => null);
  const osCpuT0 = osCpuSeconds(child.pid);
  const wallT0 = Date.now();
  const noProfiler = process.env.AWB_PROFILE_NO_PROFILER === '1';
  if (!noProfiler) {
    await mainInspector.send('Profiler.enable');
    await mainInspector.send('Profiler.setSamplingInterval', { interval: 1000 });
    await mainInspector.send('Profiler.start');
  }
  if (shell) {
    // 生产面板 5s 轮询；不要 1s 压测，否则会把 CPU 采样放大 5 倍。
    for (let i = 0; i < 3; i += 1) {
      await sleep(5000);
      await shell.send('Runtime.evaluate', { expression: 'window.workbench.teamSessionQueue({})', awaitPromise: true, returnByValue: true }, 20000).catch(() => null);
    }
  } else {
    await sleep(12000);
  }
  const profile = noProfiler ? { profile: { nodes: [], samples: [], timeDeltas: [] } } : await mainInspector.send('Profiler.stop', {}, 60000);
  const agg = aggregate(profile.profile || {});
  // 壳页面取主进程读数
  let mainRss = null;
  try {
    if (shell) {
      const r = await shell.send('Runtime.evaluate', { expression: 'window.workbench.mainRss()', awaitPromise: true, returnByValue: true });
      mainRss = r && r.result ? r.result.value : null;
      const c = await shell.send('Runtime.evaluate', { expression: 'window.workbench.cacheStats()', awaitPromise: true, returnByValue: true });
      mainRss = { ...mainRss, cacheStats: c && c.result ? c.result.value : null };
    }
  } catch { /* ignore */ }
  const osCpuT1 = osCpuSeconds(child.pid);
  const wallSec = (Date.now() - wallT0) / 1000;
  const osCpuPercent = osCpuT0 !== null && osCpuT1 !== null && wallSec > 0 ? Math.round((((osCpuT1 - osCpuT0) / wallSec) * 100) * 100) / 100 : null;
  const result = { ok: true, inspectPort: INSPECT_PORT, debugPort: DEBUG_PORT, mainRss, osCpu: { cpuPercent: osCpuPercent, windowSec: Math.round(wallSec * 100) / 100, pid: child.pid }, profile: agg, stdoutTail: stdout.slice(-1500) };
  fs.writeFileSync(path.join(OUT, 'main-cpu-profile.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ mainRss, durationSec: agg.durationSec, top: agg.top }, null, 2));
  console.log('证据：' + path.join(OUT, 'main-cpu-profile.json'));
  cleanup();
  process.exit(0);
})().catch((e) => {
  try { fs.writeFileSync(path.join(OUT, 'main-cpu-profile-error.json'), JSON.stringify({ error: String((e && e.stack) || e) }, null, 2)); } catch { /* ignore */ }
  console.error('FAILED', e && e.stack);
  cleanup();
  process.exit(1);
});
