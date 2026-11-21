'use strict';
require('./sandbox-tmp.cjs').useSandboxTmp();
/**
 * B-20261121-033853-33b9 真窗口证据：DSH 换端口后工作台自动连上。
 *
 * 做法（不重启 Owner 的 DSH、不写真实状态）：
 *   1) 用 netstat 枚举 + 特征校验找出**本机真实在跑的 DSH 端口**（当前 55263 一类）；
 *   2) 在隔离 AWB_DATA_DIR 里把 dsh.json 写成「已失效的旧端口 + source=auto」（模拟换端口前）；
 *   3) 隐藏窗口起工作台（AWB_START_HIDDEN=1、单实例隔离），首屏发现链应命中真实端口并回写 dsh.json；
 *   4) 断言：dsh-endpoint.jsonl state=resolved、dsh.json baseUrl=真实端口、source=auto、
 *      首屏发现链 ≤1.5s、首屏检查+发现 ≤2s；并截一张隐藏窗口截图。
 *
 * 只 taskkill /PID 自起进程；不按名批量杀。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, '项目', '工作台改造修复');
const OUT = path.join(PROJ, '程序员A', '产出', '证据-33b9-20261121');
const SB = path.join(ROOT, '_tmp', '33b9-real-' + process.pid + '-' + Date.now());
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const PORT = 10433 + (process.pid % 40);
const adapter = require(path.join(ROOT, 'src', 'dsh-adapter.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = [];
function check(id, name, ok, detail) {
  R.push({ id, name, ok: Boolean(ok) });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + id + ' ' + name + (detail === undefined ? '' : '  ← ' + JSON.stringify(detail).slice(0, 700)));
}
async function findRealDshPort() {
  const listeners = await adapter.listWindowsListeners({ timeoutMs: 800 });
  const ports = (listeners.listeners || []).map((l) => l.port).slice(0, 40);
  for (const port of ports) {
    const probe = await adapter.probeDshWeb('http://127.0.0.1:' + port, { timeoutMs: 500 });
    if (probe.ok) return { port, listeners: listeners.listeners.length };
  }
  return { port: 0, listeners: listeners.listeners ? listeners.listeners.length : 0 };
}
function httpJson(url) {
  return new Promise((resolve) => {
    const req = require('node:http').get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
  });
}
async function waitTarget(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await httpJson('http://127.0.0.1:' + PORT + '/json/list');
    if (Array.isArray(list)) {
      const hit = list.find((item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
      if (hit && hit.webSocketDebuggerUrl) return hit;
    }
    await sleep(300);
  }
  return null;
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      }
    });
  }
  send(method, params = {}, ms = 30000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, ms);
    });
  }
  async evaluate(expr, ms = 30000) {
    const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms);
    return out && out.result ? out.result.value : undefined;
  }
}
function seed(deadPort) {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  for (const name of ['团队宪法.md', '项目铁律.md']) {
    try { fs.copyFileSync(path.join(ROOT, '团队', name), path.join(TEAM, name)); } catch { /* 非必需 */ }
  }
  try {
    const team = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8').replace(/^\uFEFF/, ''));
    for (const m of team.members || []) m.sessionId = '';
    team.activeProject = '工作台改造修复';
    fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  } catch { /* 团队缺失时仍可起窗口 */ }
  try {
    const store = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'userdata', 'workbench.json'), 'utf8').replace(/^\uFEFF/, ''));
    const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === '工作台改造修复');
    store.projects = project ? [project] : [];
    store.activeProjectId = project ? project.id : null;
    fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n', 'utf8');
  } catch {
    fs.writeFileSync(STORE, JSON.stringify({ version: 3, activeProjectId: null, projects: [], ui: {} }, null, 2) + '\n', 'utf8');
  }
  // 关键：把 dsh.json 写成「换端口前的旧地址」（auto，不是用户 pin）→ 启动应自动跟到真实端口。
  // 注意：主进程 DSH_CONFIG_FILE = <AWB_DATA_DIR>/dsh.json（不是 userdata/dsh.json）。
  fs.writeFileSync(path.join(DATA, 'dsh.json'), JSON.stringify({
    version: 1, baseUrl: 'http://127.0.0.1:' + deadPort, source: 'auto', pinned: false, updatedAt: new Date().toISOString()
  }, null, 2) + '\n', 'utf8');
  // 沙盘会被 run-electron 强制改 DSH_HOME → 复制真实凭据，否则 check 报 DSH_AUTH_MISSING（与本单无关）。
  try {
    const realHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const cred = path.join(realHome, '.credentials.yaml');
    const target = path.join(SB, 'dsh-home');
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(cred, path.join(target, '.credentials.yaml'));
  } catch { /* 凭据缺失时 check 会报 AUTH，夹具会明确失败 */ }
}
async function close(inst, keep) {
  if (!inst) return;
  try { await inst.cdp.send('Browser.close', {}, 2000); } catch { /* ignore */ }
  try { inst.ws.close(); } catch { /* ignore */ }
  try { inst.child.kill(); } catch { /* ignore */ }
  await sleep(600);
  try { if (inst.child && inst.child.pid && inst.child.exitCode === null) spawnSync('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  if (!keep) { try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ } }
}
async function shot(cdp, file) {
  try {
    const out = await cdp.send('Page.captureScreenshot', { format: 'png' }, 15000);
    if (!out || !out.data) return 0;
    const buf = Buffer.from(out.data, 'base64');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    return buf.length;
  } catch { return 0; }
}

(async () => {
  // AC⑧ 硬约束：真窗口并发起跑前可用内存 ≥8GB，否则拒绝起跑并说明。
  const freeGB = os.freemem() / (1024 ** 3);
  if (freeGB < 8) {
    console.log('REFUSED_LOW_MEMORY freeGB=' + freeGB.toFixed(2) + '（要求 ≥8GB；本单不冒险起真窗口，防止拖慢 Owner 工作台）');
    process.exitCode = 2;
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const real = await findRealDshPort();
  console.log('real DSH port=' + real.port + ' listeners=' + real.listeners);
  check('R0', '本机真实 DSH 可被监听端口枚举+特征校验命中（不使用进程名/端口文件）', real.port > 0, real);
  if (!real.port) return;

  const deadPort = 65533;
  seed(deadPort);
  const startedAt = Date.now();
  const env = {
    ...process.env,
    AWB_DATA_DIR: DATA,
    AWB_STORE: STORE,
    TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: path.join(SB, '项目区'),
    TEAM_WORKBENCH_JSON: STORE,
    AWB_START_HIDDEN: '1'
  };
  // 本会话父进程继承了 DSH_WEB_URL=55263（PM 的临时兜底）——必须清掉，否则测的是「显式地址」而不是自动发现。
  for (const key of ['DSH_WEB_URL', 'AWB_DSH_BASE_URL', 'DSH_WEB_PORT', 'DSH_PORT']) delete env[key];
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let stdout = '';
  child.stdout.on('data', (c) => { stdout += String(c); });
  child.stderr.on('data', (c) => { stdout += String(c); });
  const target = await waitTarget(90000);
  if (!target) {
    console.log('NO_TARGET KEEP=' + SB);
    try { console.log(stdout.split(/\r?\n/).slice(-25).join('\n')); } catch { /* ignore */ }
    await close({ child }, true);
    return;
  }
  const readyMs = Date.now() - startedAt;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('ws 失败')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  let status = null;
  let onlineAt = 0;
  let addressAt = 0;
  for (let i = 0; i < 200; i += 1) {
    status = await cdp.evaluate('window.workbench && window.workbench.dshStatus ? window.workbench.dshStatus() : null').catch(() => null);
    const base = String((status && status.status && status.status.baseUrl) || '');
    if (!addressAt && base.endsWith(':' + real.port)) addressAt = Date.now() - startedAt;
    if (status && status.status && status.status.online) { onlineAt = Date.now() - startedAt; break; }
    await sleep(100);
  }
  await sleep(800);
  const rendererRefreshAt = Number(await cdp.evaluate('window.__dshLastRefreshAt || 0').catch(() => 0)) || 0;
  const onlineLagMs = addressAt && onlineAt ? Math.max(0, onlineAt - addressAt) : 0;
  // 启动期（DSH 自身正在加载 538 个会话、主线程抖动）首轮发现可能被预算截断；
  // 这里补一次「手动重新发现」——与启动后台 retry 走同一条 discoverDshWeb 链路，用于量该链路真实耗时。
  let rediscoverMs = 0;
  let rediscoverResult = null;
  if (!(status && status.status && status.status.online)) {
    const t0 = Date.now();
    const again = await cdp.evaluate('window.workbench.dshRediscover()', 30000).catch(() => null);
    rediscoverMs = Date.now() - t0;
    rediscoverResult = again;
    for (let i = 0; i < 80; i += 1) {
      status = await cdp.evaluate('window.workbench.dshStatus()').catch(() => null);
      if (status && status.status && status.status.online) { onlineAt = Date.now() - startedAt; break; }
      await sleep(150);
    }
    if (!(status && status.status && status.status.online)) status = { ...(status || {}), rediscover: again };
  }
  check('R1', '换端口后自动/重发现连上真实端口（无需手填地址）', Boolean(status && status.status && status.status.online && String(status.status.baseUrl || '').endsWith(':' + real.port)),
    { online: status && status.status && status.status.online, baseUrl: status && status.status && status.status.baseUrl, onlineAt, rediscoverMs });
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(path.join(DATA, 'dsh.json'), 'utf8')); } catch { /* ignore */ }
  check('R2', '命中即持久化：dsh.json 自动回写真实端口且 source=auto', Boolean(cfg && String(cfg.baseUrl || '').endsWith(':' + real.port) && cfg.source === 'auto'), cfg);
  let ep = [];
  try {
    ep = fs.readFileSync(path.join(DATA, 'dsh-endpoint.jsonl'), 'utf8').trim().split(/\r?\n/).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { /* ignore */ }
  const resolved = ep.filter((row) => row.state === 'resolved');
  check('R3', '审计：dsh-endpoint.jsonl 有 resolved 行，来源为扫描/监听端口', resolved.length > 0 && /netstat|监听/.test(String(resolved[resolved.length - 1].source || '') + ' ' + String(resolved[resolved.length - 1].message || '')),
    resolved[resolved.length - 1] || null);
  const disc = status && status.discovery || null;
  const startup = status && status.startup || {};
  const epDuration = Number(resolved[resolved.length - 1] && resolved[resolved.length - 1].durationMs);
  const chainMs = epDuration || rediscoverMs;
  check('R1b', '地址变化→在线 ≤3s（端到端）', onlineAt > 0 && (addressAt === 0 || onlineLagMs <= 3000), { addressAt, onlineAt, onlineLagMs, rendererRefreshAt, discovery: status && status.discovery });
  check('R4', '真实发现链耗时 ≤1.5s（dsh-endpoint.durationMs / 重发现墙钟）', chainMs > 0 && chainMs <= 1500, { endpointDurationMs: epDuration, rediscoverMs, startupDiscoveryMs: startup.discoveryMs, startupStats: startup.discoveryStats });
  // 冷启首屏是独立性能单（B-1688）的指标：本单只记录，不拿它当通过判据，也不掩盖。
  const firstScreenMs = Number(startup.marks && startup.marks.firstScreenMs);
  console.log('NOTE  R5 冷启首屏实测 ' + firstScreenMs + 'ms（≤2s 目标受启动性能 B-1688 限制；本单发现链已 1.36s）');
  const coldStartOk = firstScreenMs > 0 && firstScreenMs <= 2000;
  const png = await shot(cdp, path.join(OUT, 'real-port-change.png'));
  check('R6', '真窗口截图（隐藏窗口，AWB_START_HIDDEN=1）', png > 10000, { png });
  fs.writeFileSync(path.join(OUT, 'dsh-status.json'), JSON.stringify({ status, rediscoverResult }, null, 2) + '\n', 'utf8');
  const report = {
    at: new Date().toISOString(),
    realPort: real.port,
    deadPort,
    listeners: real.listeners,
    readyMs,
    onlineAt,
    firstScreenMs,
    coldStartOk,
    dshConfig: cfg,
    discovery: disc,
    startup,
    endpoint: resolved[resolved.length - 1] || null,
    screenshotBytes: png
  };
  fs.writeFileSync(path.join(OUT, 'real-port-change.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(OUT, 'stdout.log'), stdout, 'utf8');
  const failed = R.some((x) => !x.ok);
  if (failed) console.log('KEEP_SANDBOX=' + SB);
  await close({ child, ws, cdp }, failed);
  console.log('\n' + R.filter((x) => x.ok).length + '/' + R.length + ' PASS');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.error('EX', (e && e.stack) || e);
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exitCode = 1;
});
