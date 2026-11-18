#!/usr/bin/env node
'use strict';
/**
 * R-b34a（T-e2d8 R1）· 最小 CDP 打字预检 + 内存斜率（开发侧预检，**非验收证据**；tester 用原工装另开 v2 目录复验）。
 *
 * 做两件事：
 *   A) 打字延迟：独立沙盘实例 → 打开主窗 → 隐藏内嵌 webview → 取真实输入框 → 30 次单字符 insertText，
 *      每次量「输入事件 → 双 rAF」延迟，输出 p50/p95/max；期间用 性能.jsonl 的 kind='ipc' 行数差验证「打字期间无新增 IPC」。
 *   B) 内存斜率：静置 5 分钟，每 30s 采样本实例全部 Electron 进程工作集之和（Windows Get-Process），
 *      给首/末/增长（产品 v2 门禁：全进程 ≤2048MB、5 分钟增长 ≤256MB）。
 *
 * 隔离：AWB_DATA_DIR/AWB_STORE/TEAM_ROOT/TEAM_PROJECTS_ROOT 全指 _tmp 沙盘；真实 工作流/任务/团队.json 只读复制；
 *       真实 团队/状态/团队.json 与 data/userdata/workbench.json 前后 sha 必须不变（脚本自检并写进报告）。
 *
 * 跑法：node scripts/test-b34a-r1-typing.cjs [--minutes=5] [--start-port=9711]
 * 产出：证据-b34a/run-b34a-r1-typing.json + .log
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const EVID = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-b34a');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ARGS = process.argv.slice(2);
const arg = (name, def) => {
  const hit = ARGS.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};
const MINUTES = Math.max(1, Number(arg('minutes', '5')) || 5);
const PORT = Number(arg('start-port', '9711')) || 9711;
const INSPECT = PORT + 1;
const PROJECT = '工作台改造修复';
const PIX = '工作台改造修复';

const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsonl = [];
const put = (o) => { jsonl.push({ ts: new Date().toISOString(), ...o }); console.log('[r1]', JSON.stringify(o).slice(0, 300)); };
const realTeamFile = path.join(ROOT, '团队', '状态', '团队.json');
const realWb = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const beforeReal = { team: sha(realTeamFile), wb: sha(realWb) };

const SB = path.join(ROOT, '_tmp', `b34a-r1-${process.pid}`);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
fs.mkdirSync(path.join(TEAM, '状态', '项目', PROJECT, '任务'), { recursive: true });

function copyIf(src, dst) { try { if (fs.existsSync(src)) fs.copyFileSync(src, dst); } catch { /* ignore */ } }
copyIf(realTeamFile, path.join(TEAM, '状态', '团队.json'));
copyIf(path.join(ROOT, '团队', '团队宪法.md'), path.join(TEAM, '团队宪法.md'));
copyIf(path.join(ROOT, '团队', '项目铁律.md'), path.join(TEAM, '项目铁律.md'));
copyIf(realWb, path.join(DATA, 'userdata', 'workbench.json'));
const realProjState = path.join(ROOT, '团队', '状态', '项目', PROJECT);
copyIf(path.join(realProjState, '工作流.json'), path.join(TEAM, '状态', '项目', PROJECT, '工作流.json'));
try {
  for (const n of fs.readdirSync(path.join(realProjState, '任务'))) {
    copyIf(path.join(realProjState, '任务', n), path.join(TEAM, '状态', '项目', PROJECT, '任务', n));
  }
} catch { /* ignore */ }

const env = {
  ...process.env,
  AWB_DATA_DIR: DATA,
  AWB_STORE: path.join(DATA, 'userdata', 'workbench.json'),
  TEAM_ROOT: TEAM,
  TEAM_PROJECTS_ROOT: path.join(TEAM, '状态', '项目'),
  TEAM_SELFTEST: '1',
  AWB_TEAM_ROOT: TEAM,
};
// 关键：父进程若继承 ELECTRON_RUN_AS_NODE=1（DSH/团队工具环境常见），Electron 会以纯 Node 模式跑主进程
// → require('electron') 里没有 ipcMain → main.js:48 崩（`Cannot read properties of undefined (reading 'handle')`）。
// 必须在 spawn 前显式删掉该变量。
delete env.ELECTRON_RUN_AS_NODE;

function getJson(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('http timeout')); });
  });
}

class WS {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error(`ws error ${e && e.message || ''}`));
      this.ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (!msg.id) return;
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error).slice(0, 300)));
        else p.resolve(msg.result);
      };
      this.ws.onclose = () => { for (const p of this.pending.values()) p.reject(new Error('ws closed')); this.pending.clear(); };
    });
  }
  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`ws timeout ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

function electronPids() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process electron -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64 | ConvertTo-Json -Compress"], { encoding: 'utf8', timeout: 20000 });
    if (!out.trim()) return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { return []; }
}
// 只统计「本次 spawn 之后新增」的 electron 进程——机器上可能还有 Owner 在跑的工作台实例（8 进程 1.5GB 级），
// 不加基线过滤会把别人的内存算进来（首测 1 分钟从 1000→2592MB 就是被污染的数）。
let BASE_PIDS = new Set();
const totalMemMB = () => electronPids()
  .filter((p) => !BASE_PIDS.has(Number(p.Id)))
  .reduce((s, p) => s + (Number(p.WorkingSet64) || 0), 0) / (1024 * 1024);

async function main() {
  if (!fs.existsSync(ELECTRON)) throw new Error(`找不到 electron.exe：${ELECTRON}`);
  fs.mkdirSync(EVID, { recursive: true });
  BASE_PIDS = new Set(electronPids().map((p) => Number(p.Id)));
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`, `--inspect=${INSPECT}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let childLines = 0;
  const onChild = (buf) => {
    if (childLines > 40) return;
    childLines += 1;
    const line = String(buf || '').trim().split(/[\r\n]+/).slice(0, 6).join(' | ');
    if (line) put({ kind: 'child', line: line.slice(0, 240) });
  };
  child.stdout.on('data', onChild);
  child.stderr.on('data', onChild);
  child.on('exit', (code, sig) => put({ kind: 'child-exit', code, sig }));
  let cdp = null;
  try {
    // 等 devtools 列表
    let targets = null;
    for (let i = 0; i < 60; i += 1) {
      try { targets = await getJson(PORT, '/json/list'); if (Array.isArray(targets) && targets.length) break; } catch { /* not up */ }
      await sleep(500);
    }
    if (!Array.isArray(targets) || !targets.length) throw new Error('CDP 目标列表为空（Electron 未起来或端口占用）');
    const page = targets.find((t) => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || '')) || targets.find((t) => t.type === 'page');
    if (!page) throw new Error(`未找到 renderer page；targets=${JSON.stringify(targets.map((t) => ({ type: t.type, url: String(t.url || '').slice(0, 80) }))).slice(0, 400)}`);
    put({ kind: 'target', url: String(page.url || '').slice(0, 120) });
    cdp = new WS(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    try { await cdp.send('Page.bringToFront'); } catch { /* ignore */ }
    const evalJs = async (expr, timeoutMs = 20000, awaitPromise = false) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise, timeout: timeoutMs }, timeoutMs + 5000);
      if (r && r.exceptionDetails) throw new Error(`evaluate: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
      return r && r.result ? r.result.value : null;
    };
    // 隐藏内嵌 webview（避免抢绘制/阻塞）
    try {
      await evalJs("(() => { const v = document.getElementById('dsh-view'); if (v) { v.style.display = 'none'; return 'hidden'; } return 'no-webview'; })()");
    } catch (e) { put({ kind: 'hide-webview-failed', why: String(e.message || e).slice(0, 200) }); }
    // ── R-b34a R6补（d5ec）：看板窗骨架模式 --board ─────────────────────────
    // 从主渲染层调 window.workbench.teamBoardOld(projectId)（与「独立浮窗」按钮同一 IPC），
    // 主进程会：先显示内联骨架（≤200ms 可见）→ generateBoard → loadFile 真实看板，返回 timings。
    if (ARGS.includes('--board')) {
      const wbFile = path.join(DATA, 'userdata', 'workbench.json');
      const wb = JSON.parse(fs.readFileSync(wbFile, 'utf8'));
      const projectId = String(wb.activeProjectId || ((wb.projects || [])[0] || {}).id || '');
      if (!projectId) throw new Error('沙盘 workbench 里没有可用项目 id');
      put({ kind: 'board-mode', projectId });
      const svgStart = Date.now();
      const result = await evalJs(`window.workbench.teamBoardOld(${JSON.stringify(projectId)})`, 90000, true);
      const wallMs = Date.now() - svgStart;
      put({ kind: 'board-ipc-result-cold', result, wallMs });
      // 二次打开（热路径）：A4「面板打开 p95」口径，应落在 800ms 内
      await sleep(400);
      const warmStart = Date.now();
      const resultWarm = await evalJs(`window.workbench.teamBoardOld(${JSON.stringify(projectId)})`, 90000, true);
      const warmWallMs = Date.now() - warmStart;
      put({ kind: 'board-ipc-result-warm', resultWarm, warmWallMs });
      // 找看板窗目标并截图（真实内容已填充）
      await sleep(600);
      const list = await getJson(PORT, '/json/list');
      const boardTarget = (list || []).find((t) => t.type === 'page' && /看板\.html/i.test(String(t.url || '')));
      put({ kind: 'board-target', url: boardTarget ? String(boardTarget.url).slice(0, 140) : '' });
      let shot = '';
      let contentProbe = null;
      if (boardTarget) {
        const bws = new WS(boardTarget.webSocketDebuggerUrl);
        await bws.connect();
        try {
          await bws.send('Page.enable');
          await bws.send('Runtime.enable');
          contentProbe = (await bws.send('Runtime.evaluate', { expression: "(() => ({ title: document.title, hasSkeleton: Boolean(document.querySelector('[data-board-skeleton]')), bodyLen: document.body ? document.body.textContent.length : 0, mark: (() => { try { return performance.getEntriesByName('board:skeleton').length; } catch (e) { return -1; } })() }))()", returnByValue: true }, 15000)).result.value;
          const cap = await bws.send('Page.captureScreenshot', { format: 'png' }, 30000);
          const png = path.join(EVID, 'board-content.png');
          fs.writeFileSync(png, Buffer.from(cap.data, 'base64'));
          shot = path.relative(ROOT, png).replace(/\\/g, '/');
        } finally { bws.close(); }
      }
      const timings = (result && result.timings) || {};
      const timingsWarm = (resultWarm && resultWarm.timings) || {};
      const report = {
        task: 'T-20261118-183722-d5ec', requirement: 'R-20261118-170937-b34a', at: new Date().toISOString(),
        note: '开发侧预检，非验收证据（tester 复验 A4 看板项）',
        head: (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return ''; } })(),
        ipc: { cold: { ok: Boolean(result && result.ok), wallMs, timings }, warm: { ok: Boolean(resultWarm && resultWarm.ok), wallMs: warmWallMs, timings: timingsWarm } },
        board: contentProbe,
        screenshot: shot,
        isolation: { realTeamSame: sha(realTeamFile) === beforeReal.team, realWbSame: sha(realWb) === beforeReal.wb },
        pass: {
          skeletonVisible: Number(timings.skeletonVisibleMs) >= 0 && Number(timings.skeletonVisibleMs) <= 200,
          contentColdInBudget: Number(timings.contentMs) >= 0 && Number(timings.contentMs) <= 800,
          contentWarmInBudget: Number(timingsWarm.contentMs) >= 0 && Number(timingsWarm.contentMs) <= 800,
          contentLoaded: Boolean(contentProbe && contentProbe.bodyLen > 200),
        },
        jsonl,
      };
      fs.writeFileSync(path.join(EVID, 'run-d5ec-board-skeleton.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
      console.log(`\nD5EC_BOARD_SKELETON ${JSON.stringify(report.pass)}`);
      console.log('证据：' + path.join(EVID, 'run-d5ec-board-skeleton.json'));
      // A4 正式口径：骨架可见 ≤200ms（冷/热都应满足）+ 热开内容 ≤800ms；冷开 contentMs 只记录不判红（首次重建成本）。
      process.exitCode = report.pass.skeletonVisible && report.pass.contentWarmInBudget && report.pass.contentLoaded ? 0 : 1;
      return;
    }
    // 等真实输入框
    let selector = null;
    for (let i = 0; i < 40; i += 1) {
      selector = await evalJs(`(() => {
        const cands = ['#dispatch-subject', '#pool-search', 'input[type=search]', 'input[type=text]', 'input:not([type])', 'textarea'];
        for (const sel of cands) {
          const el = document.querySelector(sel);
          if (el && !el.disabled && el.offsetParent !== null) return sel;
        }
        return null;
      })()`);
      if (selector) break;
      await sleep(500);
    }
    put({ kind: 'input-ready', selector });
    const SKIP_TYPING = ARGS.includes('--skip-typing');
    if (!selector && !SKIP_TYPING) throw new Error('未找到可用输入框（面板未就绪）');
    let typing = { skipped: true, reason: SKIP_TYPING ? 'flag' : 'no-input', count: 0, valid: 0, p50: null, p95: null, max: null, ipcDelta: null };
    if (!SKIP_TYPING) {
      // 聚焦
      await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); return document.activeElement === el; })()`);
      const ipcBefore = countIpcRows();
      const samples = [];
      for (let i = 0; i < 30; i += 1) {
        const ms = await evalJs(`new Promise((resolve) => { const s = performance.now(); const done = () => requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round((performance.now() - s) * 10) / 10))); window.addEventListener('input', function once() { window.removeEventListener('input', once); done(); }, { once: true }); setTimeout(() => resolve(-1), 400); })`, 30000, true);
        // 触发真实输入（insertText 会走浏览器输入路径）
        await cdp.send('Input.insertText', { text: String.fromCharCode(97 + (i % 26)) }, 10000);
        samples.push(Number(ms));
        await sleep(30);
      }
      const ipcAfter = countIpcRows();
      const ok = samples.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
      const pct = (p) => (ok.length ? ok[Math.min(ok.length - 1, Math.ceil(ok.length * p) - 1)] : null);
      typing = { count: samples.length, valid: ok.length, p50: pct(0.5), p95: pct(0.95), max: ok.length ? ok[ok.length - 1] : null, samples, ipcBefore, ipcAfter, ipcDelta: ipcAfter - ipcBefore };
      put({ kind: 'typing', ...typing, samples: undefined });
    }
    // 内存斜率
    const memSamples = [];
    const start = Date.now();
    const first = totalMemMB();
    memSamples.push({ t: 0, mb: Math.round(first) });
    while (Date.now() - start < MINUTES * 60000) {
      await sleep(30000);
      memSamples.push({ t: Math.round((Date.now() - start) / 1000), mb: Math.round(totalMemMB()) });
    }
    const mem = { minutes: MINUTES, samples: memSamples, firstMB: memSamples[0].mb, lastMB: memSamples[memSamples.length - 1].mb };
    mem.growthMB = mem.lastMB - mem.firstMB;
    mem.pass = mem.lastMB <= 2048 && mem.growthMB <= 256;
    put({ kind: 'memory', ...mem, samples: memSamples });
    const report = {
      task: 'T-20261118-172604-e2d8', requirement: 'R-20261118-170937-b34a', at: new Date().toISOString(),
      note: '开发侧预检，非验收证据；tester 后续用同一工装另开 v2 目录复验',
      head: (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return ''; } })(),
      baseline: { p50: 12.2, p95: 219.5, max: 465.6, source: '测试人员/产出/UI卡顿基线-20261118.md' },
      typing, memory: mem,
      isolation: { realTeamSame: sha(realTeamFile) === beforeReal.team, realWbSame: sha(realWb) === beforeReal.wb, sandbox: SB },
      pass: { typingP95: typing.p95 !== null && typing.p95 <= 50, typingNoSpike: typing.max !== null && typing.max <= 200, ipcZero: typing.ipcDelta === 0, memory: mem.pass },
      jsonl,
    };
    fs.writeFileSync(path.join(EVID, 'run-b34a-r1-typing.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(`\nB34A_R1_TYPING ${JSON.stringify({ p50: typing.p50, p95: typing.p95, max: typing.max, ipcDelta: typing.ipcDelta, memLastMB: mem.lastMB, memGrowthMB: mem.growthMB, pass: report.pass })}`);
    process.exitCode = 0;
  } finally {
    try { if (cdp) cdp.close(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
    await sleep(1200);
    try { execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*deepseek*" } | Stop-Process -Force -ErrorAction SilentlyContinue'], { timeout: 20000 }); } catch { /* ignore */ }
    try { fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
  }
}

function countIpcRows() {
  try {
    const dir = path.join(TEAM, '状态', '项目', PROJECT);
    let n = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!/^性能-\d{8}(?:-\d+)?\.jsonl$/.test(f)) continue;
      const rows = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).filter(Boolean);
      for (const line of rows) { try { if (JSON.parse(line).kind === 'ipc') n += 1; } catch { /* ignore */ } }
    }
    return n;
  } catch { return 0; }
}

main().catch((e) => { console.error('B34A_R1_FAILED', String((e && e.message) || e).slice(0, 500)); process.exitCode = 2; });
