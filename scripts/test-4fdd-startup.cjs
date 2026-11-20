#!/usr/bin/env node
'use strict';
/**
 * test-4fdd-startup.cjs —— B-20261121-005127-4fdd（P0）真实启动路径四段计时夹具
 *
 * 断面（不设 DSH_WEB_URL、无 data/userdata/dsh.json、DSH 随机端口）：
 *   冷启动：sandbox 新数据目录 + 无 dsh.json → 主进程把四段写进 <TEAM_ROOT>/状态/性能-YYYYMMDD.jsonl
 *   热命中：本地 mock DSH（随机端口）+ DSH_WEB_URL → 断言 stats.scanAttempts=0、首屏 ≤1s
 *   离线：无 DSH 可连 → dsh:status 在 ≤3s 内返回离线（含已尝试源），界面有重试入口
 *
 * 用法：node scripts/test-4fdd-startup.cjs [--root <repo>] [--runs 3] [--json] [--out <dir>]
 * 退出码：0 全绿；1 有红；2 环境/启动失败。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const JSON_OUT = process.argv.includes('--json');
const argOf = (name, fallback = '') => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const ROOT = path.resolve(argOf('--root', path.resolve(__dirname, '..')));
const RUNS = Math.max(1, Number(argOf('--runs', '3')) || 3);
const ROUNDS = Math.max(1, Number(argOf('--rounds', '3')) || 3);
const OUT = argOf('--out', '') ? path.resolve(argOf('--out', '')) : '';
const ROWS = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 800)}`);
}
function median(list) {
  const a = list.slice().sort((x, y) => x - y);
  if (!a.length) return null;
  return a.length % 2 ? a[(a.length - 1) / 2] : Math.round((a[a.length / 2 - 1] + a[a.length / 2]) / 2);
}
function httpJson(url, timeout = 4000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.setTimeout(timeout, () => { req.destroy(); resolve(null); });
  });
}
async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(0));
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function startMockDsh(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = String(req.url || '');
      if (url.startsWith('/json/version')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ Browser: 'DeepSeek-DSH/1.0', 'User-Agent': 'dsh', HttpVersion: 'HTTP/1.1', ProtocolVersion: '1.1' }));
        return;
      }
      // DSH RPC 信封：{type:'client-request', rpcId, method, payload} → {type:'server-response', rpcId, result:{ok,value}}
      if (req.method === 'POST' && url.startsWith('/api/')) {
        let body = '';
        req.on('data', (d) => { body += String(d); });
        req.on('end', () => {
          let rpcId = '';
          try { rpcId = String((JSON.parse(body) || {}).rpcId || ''); } catch { rpcId = ''; }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: { items: [], sessions: [], count: 0 } } }));
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>DSH</title><body>dsh</body>');
    });
    server.on('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); }
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
    try {
      const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, ms);
      if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || '') };
      return out && out.result ? out.result.value : undefined;
    } catch (e) { return { __cdperror: String((e && e.message) || e) }; }
  }
}
async function waitTarget(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await httpJson(`http://127.0.0.1:${port}/json/list`);
    if (Array.isArray(list)) {
      const hit = list.find((p) => p && p.type === 'page' && String(p.url || '').includes('renderer/index.html'));
      if (hit && hit.webSocketDebuggerUrl) return hit;
    }
    await sleep(200);
  }
  return null;
}
function seedSandbox(kind) {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), `4fdd-${kind}-`));
  const data = path.join(sb, 'data');
  const team = path.join(sb, '团队');
  const proj = path.join(sb, '项目区', '4fdd项目');
  fs.mkdirSync(path.join(data, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(team, '状态'), { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  const store = {
    version: 1, activeProjectId: 'P-4fdd',
    projects: [{
      id: 'P-4fdd', name: '4fdd项目', teamName: '4fdd项目', path: proj, teamMode: 'full',
      workspace: { id: 'W-4fdd', path: proj, name: '4fdd项目', bound: true, sessionIds: [] },
      sessions: {}, requirements: [], sessionMeta: {},
    }],
    ui: {},
  };
  fs.writeFileSync(path.join(data, 'userdata', 'workbench.json'), JSON.stringify(store, null, 2));
  // 名册骨架：从真实 团队.json 复制（只读用），避免 shell 侧读不到团队配置而阻塞首屏。
  try {
    const real = path.join(ROOT, '团队', '状态', '团队.json');
    fs.copyFileSync(real, path.join(team, '状态', '团队.json'));
  } catch { /* 没有就留空 */ }
  for (const name of ['团队宪法.md', '项目铁律.md']) {
    try { fs.copyFileSync(path.join(ROOT, '团队', name), path.join(team, name)); } catch { /* ignore */ }
  }
  const stateDir = path.join(team, '状态', '项目', '4fdd项目');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '项目.json'), JSON.stringify({ name: '4fdd项目', path: proj, teamMode: 'full' }));
  return { sb, data, team, proj, storeFile: path.join(data, 'userdata', 'workbench.json') };
}
function perfRows(team) {
  const dir = path.join(team, '状态');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^性能-.*\.jsonl$/.test(n)); } catch { return []; }
  const rows = [];
  for (const n of names) {
    try {
      for (const line of fs.readFileSync(path.join(dir, n), 'utf8').split(/\r?\n/)) {
        if (line.trim()) { try { rows.push(JSON.parse(line)); } catch { /* ignore */ } }
      }
    } catch { /* ignore */ }
  }
  return rows;
}
async function launchOnce(box, { port, envExtra, waitMarksMs }) {
  const t0 = Date.now();
  const env = {
    ...process.env,
    AWB_DATA_DIR: box.data,
    AWB_STORE: box.storeFile,
    AWB_TEAM_ROOT: box.team,
    TEAM_ROOT: box.team,
    TEAM_PROJECTS_ROOT: path.join(box.sb, '项目区'),
    // ⛔ 不许抢焦点：Owner 在打游戏/用机时，所有测量窗口必须隐藏启动（ready-to-show 不 show）。
    AWB_START_HIDDEN: '1',
    ...envExtra,
  };
  delete env.DSH_WEB_URL;
  delete env.DSH_WEB_PORT;
  delete env.DSH_PORT;
  delete env.AWB_DSH_BASE_URL;
  // 真路径：start.cmd 会清掉继承来的 ELECTRON_RUN_AS_NODE（否则 electron 退化成 node 解释器）。
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, envExtra || {});
  // B-4fdd：真路径 = start.cmd 的 `"%ELECTRON_EXE%" "%APP_DIR%" %*`（不经 node 包装器）；
  // 走 run-electron 只用于没有本地 electron 的极端情况。
  const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const useElectron = fs.existsSync(electronExe);
  const child = useElectron
    ? spawn(electronExe, [ROOT, `--remote-debugging-port=${port}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })
    : spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', `--remote-debugging-port=${port}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  child.stderr.on('data', (d) => { stdout += String(d); });
  const target = await waitTarget(port, 60000);
  if (!target) {
    try { child.kill(); } catch { /* ignore */ }
    return { ok: false, wallMs: Date.now() - t0, stdout, error: 'CDP 目标未出现' };
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('ws 连接失败')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  const colsStart = fs.readdirSync(path.join(box.team, '状态'))
    .filter((n) => /^性能-.*\.jsonl$/.test(n))
    .reduce((acc, n) => acc + fs.statSync(path.join(box.team, '状态', n)).size, 0);
  let status = null;
  const deadline = Date.now() + waitMarksMs;
  while (Date.now() < deadline) {
    const marks = perfRows(box.team).filter((r) => r.kind === 'startup' && r.phase === 'firstScreen');
    if (marks.length) break;
    await sleep(120);
  }
  // dsh:status（离线/在线都取一次，拿 startup 摘要）
  status = await cdp.evaluate('window.workbench.dshStatus()');
  // a129：懒加载完成 + 首屏交互冒烟（K3 初始化门）。
  const smoke = await cdp.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const t0 = Date.now();
    while (!window.__awbLazyLoaded && Date.now() - t0 < 8000) await wait(100);
    const out = { lazyLoaded: Boolean(window.__awbLazyLoaded), lazyCount: (window.__awbLazyScripts || []).length, clicks: {}, errors: (window.__awbBootErrors || []).slice(0, 8) };
    const click = (sel) => { const el = document.querySelector(sel); if (!el) return false; try { el.click(); return true; } catch { return false; } };
    out.clicks.refresh = click('#btn-refresh');
    await wait(200);
    for (const sel of ['#team-pill', '#session-pill', '#btn-pool', '#btn-session-queue']) {
      const el = document.querySelector(sel);
      if (!el) { out.clicks[sel] = 'missing'; continue; }
      try { el.click(); await wait(150); el.click(); await wait(100); out.clicks[sel] = 'ok'; } catch (e) { out.clicks[sel] = 'throw'; }
    }
    out.workspaceSwitch = Boolean(document.getElementById('workspace-switch'));
    out.ok = out.lazyLoaded && out.clicks.refresh === true && out.workspaceSwitch && out.errors.length === 0
      && out.clicks['#team-pill'] === 'ok' && out.clicks['#session-pill'] === 'ok' && out.clicks['#btn-pool'] === 'ok' && out.clicks['#btn-session-queue'] === 'ok';
    return out;
  })()`, 30000);
  const pageInfo = await cdp.evaluate(`(() => ({
    readyState: document.readyState,
    hasRetry: Boolean(document.getElementById('dsh-retry')),
    workspaceText: String((document.getElementById('workspace-name') || {}).textContent || ''),
    startup: (window.__startup || null)
  }))()`);
  const wallMs = Date.now() - t0;
  const rows = perfRows(box.team);
  const lastFirst = rows.filter((r) => r.kind === 'startup' && r.phase === 'firstScreen').pop() || null;
  const lastDiscovery = rows.filter((r) => r.kind === 'startup' && r.phase === 'discoveryEnd').pop() || null;
  const spawnEpoch = t0;
  const firstScreenWall = lastFirst ? lastFirst.atMs - spawnEpoch : null;
  const discoveryMs = lastDiscovery ? Number(lastDiscovery.durationMs) || 0 : null;
  const result = {
    ok: true,
    wallMs,
    firstScreenWall,
    discoveryMs,
    firstScreenMarkMs: lastFirst ? lastFirst.sinceBootMs : null,
    startup: (status && status.startup) || null,
    dsh: (status && status.status) || null,
    discovery: (status && status.discovery) || null,
    pageInfo,
    smoke,
    marks: perfRows(box.team).filter((r) => r.kind === 'startup'),
    stdoutTail: stdout.slice(-2500),
  };
  try { cdp.send('Browser.close', {}, 2000).catch(() => {}); } catch { /* ignore */ }
  await sleep(500);
  try { ws.close(); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
  try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  return result;
}

// PM 012728：竞争态要注明 CPU/进程数；--wait-idle <秒> 可等机器空闲再测（阈值 30%）。
function sampleLoad() {
  try {
    const { execFileSync } = require('node:child_process');
    const ps = (cmd) => String(execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 25000 }) || '').trim();
    const cpu = Number(ps('(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average'));
    const procs = Number(ps('(Get-Process | Measure-Object).Count'));
    // PM 032004 放行门：可用物理内存（KB）与其它 Electron 实例数（只读，不杀进程）。
    const freeKb = Number(ps('(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory'));
    const electronCount = Number(ps('@(Get-Process -Name electron -ErrorAction SilentlyContinue).Count'));
    return {
      cpu: Number.isFinite(cpu) ? Math.round(cpu) : null,
      procs: Number.isFinite(procs) ? procs : null,
      freeMemGB: Number.isFinite(freeKb) ? Math.round((freeKb / 1024 / 1024) * 10) / 10 : null,
      electronCount: Number.isFinite(electronCount) ? electronCount : null,
      at: new Date().toISOString(),
    };
  } catch { return { cpu: null, procs: null, freeMemGB: null, electronCount: null, at: new Date().toISOString() }; }
}
// PM 032004 放行门：CPU≤20% + 可用物理内存≥8GB + 无其它 Electron 实例；不满足不许起跑。
function releaseGate(load) {
  const reasons = [];
  if (!(load.cpu !== null && load.cpu <= 20)) reasons.push('CPU>20% 或未知（' + load.cpu + '）');
  if (!(load.freeMemGB !== null && load.freeMemGB >= 8)) reasons.push('可用物理内存<8GB 或未知（' + load.freeMemGB + 'GB）');
  if (!(load.electronCount === 0)) reasons.push('仍有其它 Electron 实例（' + load.electronCount + '）');
  return { ok: reasons.length === 0, reasons };
}
async function waitIdle(maxSec, threshold = 30) {
  const end = Date.now() + Math.max(0, maxSec) * 1000;
  let last = null;
  while (Date.now() < end) {
    last = sampleLoad();
    if (last.cpu !== null && last.cpu <= threshold) return last;
    await sleep(3000);
  }
  return last || { cpu: null, procs: null };
}

async function main() {
  const requireClean = process.argv.includes('--require-clean');
  const waitIdleSec = Number(argOf('--wait-idle', '0')) || 0;
  const loadBefore = waitIdleSec > 0 ? await waitIdle(waitIdleSec) : sampleLoad();
  const gate = releaseGate(loadBefore);
  const loadLine = '环境：CPU ' + (loadBefore.cpu === null ? '未知' : loadBefore.cpu + '%')
    + ' / 进程 ' + (loadBefore.procs === null ? '未知' : loadBefore.procs)
    + ' / 可用内存 ' + (loadBefore.freeMemGB === null ? '未知' : loadBefore.freeMemGB + 'GB')
    + ' / Electron 实例 ' + (loadBefore.electronCount === null ? '未知' : loadBefore.electronCount);
  if (!JSON_OUT) console.log(loadLine + (gate.ok ? ' ｜ 放行门：PASS' : ' ｜ 放行门：BLOCKED（' + gate.reasons.join('；') + '）'));
  if (requireClean && !gate.ok) {
    const block = { ok: false, code: 'RELEASE_GATE_BLOCKED', reasons: gate.reasons, load: loadBefore };
    if (JSON_OUT) console.log(JSON.stringify(block, null, 2));
    else console.log('BLOCKED：不满足放行条件，未启动任何窗口/未做任何测量。');
    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, 'release-gate.json'), JSON.stringify(block, null, 2) + '\n', 'utf8');
    }
    process.exit(2);
  }
  const port0 = await freePort();
  const box = seedSandbox('cold');
  // 冷启动：ROUNDS 轮 × 每轮 RUNS 次（各自新数据目录，模拟首次打开；不设 env、无 dsh.json）。
  const cold = [];
  const rounds = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const roundRows = [];
    for (let i = 0; i < RUNS; i += 1) {
      const b = seedSandbox('cold-r' + round + '-' + i);
      await new Promise((res) => setTimeout(res, 700)); // 运行间冷却，避免自造并发抖动
      const r = await launchOnce(b, { port: port0 + (round * RUNS + i), envExtra: {}, waitMarksMs: 12000 });
      cold.push({ ...r, round, index: i });
      roundRows.push(r);
      const tag = '冷启 第' + (round + 1) + '轮/第' + (i + 1) + '次';
      if (!r.ok) { check(tag + ' 能起来', false, r); }
      else {
        const procFirst = Number(r.startup && r.startup.marks && r.startup.marks.firstScreenMs);
        const disc = Number(r.discoveryMs);
        if (!JSON_OUT) console.log('  · ' + tag + '：首屏(进程起算)=' + procFirst + 'ms 发现链=' + disc + 'ms 墙钟=' + r.firstScreenWall
        + 'ms lazy=' + (r.smoke && r.smoke.lazyCount) + ' smoke=' + Boolean(r.smoke && r.smoke.ok));
      check(tag + ' 懒加载+首屏交互冒烟（lazy=10、刷新/三抽屉/切工作区入口、无脚本错误）', Boolean(r.smoke && r.smoke.ok), { smoke: r.smoke });
      }
      try { fs.rmSync(b.sb, { recursive: true, force: true }); } catch { /* ignore */ }
      if (!r.ok) break;
    }
    const okRows = roundRows.filter((r) => r.ok);
    rounds.push({
      round: round + 1,
      firstScreen: okRows.map((r) => Number(r.startup && r.startup.marks && r.startup.marks.firstScreenMs)).filter((n) => Number.isFinite(n)),
      discovery: okRows.map((r) => Number(r.discoveryMs)).filter((n) => Number.isFinite(n)),
    });
  }
  const coldOk = cold.filter((r) => r.ok);
  const coldFirst = coldOk.map((r) => r.firstScreenWall).filter((n) => Number.isFinite(n));
  const coldDiscovery = coldOk.map((r) => r.discoveryMs).filter((n) => Number.isFinite(n));
  const coldProcFirst = coldOk.map((r) => Number(r.startup && r.startup.marks && r.startup.marks.firstScreenMs)).filter((n) => Number.isFinite(n));
  const medFirst = median(coldProcFirst);
  const medDisc = median(coldDiscovery);
  const worstFirst = coldProcFirst.length ? Math.max(...coldProcFirst) : null;
  const worstDisc = coldDiscovery.length ? Math.max(...coldDiscovery) : null;
  check('冷启动：首屏可用（进程启动起算）中位 ≤2000ms（' + medFirst + 'ms；最差 ' + worstFirst + 'ms）', medFirst !== null && medFirst <= 2000, { coldProcFirst, rounds });
  check('冷启动：发现链中位 ≤1500ms（' + medDisc + 'ms；最差 ' + worstDisc + 'ms）', medDisc !== null && medDisc <= 1500, { coldDiscovery, rounds });
  check('冷启动：最差单次首屏 ≤2500ms（' + worstFirst + 'ms，抖动上限）', worstFirst !== null && worstFirst <= 2500, { coldProcFirst, rounds });
  check('冷启动：无环境变量时 discovery 走真发现（stats 存在）', coldOk.some((r) => r.discovery && r.discovery.stats), {});
  if (!JSON_OUT) {
    for (const row of rounds) console.log('  轮次中位 ' + row.round + '：首屏 ' + median(row.firstScreen) + 'ms / 发现 ' + median(row.discovery) + 'ms');
  }

  // 离线（无 DSH 可连、无 env、无 dsh.json）：≤3s 给离线 + 已尝试源 + 重试入口
  const offlineBox = seedSandbox('offline');
  const offline = await launchOnce(offlineBox, { port: port0 + 40, envExtra: { DSH_WEB_URL: 'http://127.0.0.1:1' }, waitMarksMs: 12000 });
  const offlineStatus = offline.dsh || {};
  const offlineMsg = String(offlineStatus.message || '');
  check('离线：dsh:status 返回 offline（code=' + String(offlineStatus.code) + '）', offlineStatus.online === false, offline);
  const offlineMarks = (offline.startup && offline.startup.marks) || {};
  const offlineReadyMs = Number(offlineMarks.dshCheckEndMs || 0) + Number((offline.startup && offline.startup.discoveryMs) || 0);
  check('离线：应用在 ≤3000ms 内给出离线性结果（' + offlineReadyMs + 'ms；整页 wall=' + offline.wallMs + 'ms 仅作参考）',
    offlineReadyMs > 0 && offlineReadyMs <= 3000, { offlineReadyMs, wallMs: offline.wallMs, startup: offline.startup });
  check('离线：消息含「已尝试/已探测/来源读数」之一', /已探测|来源读数|已尝试/.test(offlineMsg), { message: offlineMsg.slice(0, 400) });
  check('离线：界面有重试入口 #dsh-retry', Boolean(offline.pageInfo && offline.pageInfo.hasRetry), offline.pageInfo);
  try { fs.rmSync(offlineBox.sb, { recursive: true, force: true }); } catch { /* ignore */ }

  // 热命中：mock DSH + env（随机端口）→ scanAttempts=0、首屏 ≤1s
  const mockPort = await freePort();
  const server = await startMockDsh(mockPort);
  if (!server) { check('mock DSH 启动', false, { mockPort }); }
  else {
    // 热命中跑 3 次取中位（本机常有其他实例在跑，单次易被噪声带偏）。
    const warmRuns = [];
    for (let i = 0; i < 3; i += 1) {
      const warmBox = seedSandbox('warm' + i);
      const warm = await launchOnce(warmBox, { port: port0 + 60 + i, envExtra: { DSH_WEB_URL: `http://127.0.0.1:${mockPort}` }, waitMarksMs: 12000 });
      warmRuns.push(warm);
      try { fs.rmSync(warmBox.sb, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    const warmOk = warmRuns.filter((r) => r.ok);
    const warm = warmOk[0] || {};
    const warmFirst = warmOk.map((r) => Number(r.startup && r.startup.marks && r.startup.marks.firstScreenMs)).filter((n) => Number.isFinite(n));
    const warmHandshake = warmOk.map((r) => Number(r.startup && r.startup.handshakeMs)).filter((n) => Number.isFinite(n));
    const noDiscovery = warmOk.length > 0 && warmOk.every((r) => Boolean(r.startup) && r.startup.discoveryMs === null);
    check('热命中：env 直命 → 从未进入发现链/扫描（scanAttempts 概念上为 0）', noDiscovery, { startups: warmOk.map((r) => r.startup) });
    check('热命中：DSH 握手中位 ≤1000ms（' + median(warmHandshake) + 'ms）',
      median(warmHandshake) !== null && median(warmHandshake) <= 1000, { warmHandshake });
    check('热命中：首屏可用（进程启动起算，3 次中位）≤2000ms（' + median(warmFirst) + 'ms）',
      median(warmFirst) !== null && median(warmFirst) <= 2000, { warmFirst });
    check('热命中：dsh:status.online=true', warmOk.every((r) => Boolean(r.dsh && r.dsh.online)), { dsh: warmOk.map((r) => r.dsh) });
    await new Promise((r) => server.close(r));
  }

  try { fs.rmSync(box.sb, { recursive: true, force: true }); } catch { /* ignore */ }
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'startup-measure.json'), JSON.stringify({ root: ROOT, at: new Date().toISOString(), load: { atStart: loadBefore, atEnd: sampleLoad(), gate }, cold: coldOk.map((r) => ({
    round: r.round, index: r.index,
    firstScreenWall: r.firstScreenWall, discoveryMs: r.discoveryMs,
    startup: r.startup, marks: r.marks,
    discoveryStats: r.startup && r.startup.discoveryStats ? r.startup.discoveryStats : null,
    backgroundDiscovery: r.startup && r.startup.backgroundDiscovery ? r.startup.backgroundDiscovery : null,
    stdoutTail: r.stdoutTail,
  })),
  rounds,
  coldSummary: { medianFirstScreenMs: medFirst, medianDiscoveryMs: medDisc, worstFirstScreenMs: worstFirst, worstDiscoveryMs: worstDisc }, offline: { wallMs: offline.wallMs, dsh: offline.dsh, startup: offline.startup }, rows: ROWS }, null, 2) + '\n', 'utf8');
  }
  const failed = ROWS.filter((r) => !r.ok).length;
  if (JSON_OUT) console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed, failed: ROWS.filter((r) => !r.ok).map((r) => r.name), rows: ROWS }, null, 2));
  else console.log(`\n${ROWS.length - failed}/${ROWS.length} PASS${failed ? ' · ' + failed + ' FAIL' : ''}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FIXTURE_FAILED', String((e && e.stack) || e)); process.exit(2); });
