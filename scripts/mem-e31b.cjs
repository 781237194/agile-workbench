'use strict';
// R-e31b 堆内存采样：壳主窗渲染进程（target url 含 index.html）+ 长任务/点击测量。
// 只读真实数据副本：工作流.json/团队.json/workbench.json 复制进沙盘；项目目录只读引用（不写）。
// 用法：node scripts/mem-e31b.cjs --minutes 1 --out _tmp/mem-e31b-baseline [--keep]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const MINUTES = Number(argOf('--minutes', '1')) || 1;
const OUT = path.resolve(ROOT, argOf('--out', path.join('_tmp', 'mem-e31b-' + Date.now().toString(36))));
const KEEP = args.includes('--keep');
const PROJECT = String(argOf('--project', '工作台改造修复'));
const PORT = Number(argOf('--port', String(19000 + Math.floor(Math.random() * 900))));
const STORE_FILE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const REAL_TEAM = path.join(ROOT, '团队');
const REAL_STATUS = path.join(REAL_TEAM, '状态');
const SANDBOX = fs.mkdtempSync(path.join(fs.existsSync(String.fromCharCode(68) + ':\\awb-sandbox') ? String.fromCharCode(68) + ':\\awb-sandbox' : os.tmpdir(), 'e31b-mem-'));
const TEAM = path.join(SANDBOX, '团队');
const DATA = path.join(SANDBOX, '数据');
const wbFile = path.join(DATA, 'workbench.json');
const seed = () => {
  fs.mkdirSync(path.join(TEAM, '状态', '项目', PROJECT), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '工具'), { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  // 工作流：真实副本（决定任务/需求条数）
  const wfSrc = path.join(REAL_STATUS, '项目', PROJECT, '工作流.json');
  if (fs.existsSync(wfSrc)) fs.copyFileSync(wfSrc, path.join(TEAM, '状态', '项目', PROJECT, '工作流.json'));
  // 任务目录：摘要/分页必须读真实任务文件（1372 条），只读复制
  const taskSrc = path.join(REAL_STATUS, '项目', PROJECT, '任务');
  if (fs.existsSync(taskSrc)) fs.cpSync(taskSrc, path.join(TEAM, '状态', '项目', PROJECT, '任务'), { recursive: true });
  // 任务目录（1405 个任务文件，任务摘要来源）+ 需求正文（只读，供快照补卷）
  for (const sub of ['任务', '需求', '提案']) {
    const src = path.join(REAL_STATUS, '项目', PROJECT, sub);
    if (!fs.existsSync(src)) continue;
    try { fs.cpSync(src, path.join(TEAM, '状态', '项目', PROJECT, sub), { recursive: true }); } catch { /* ignore */ }
  }
  // 邮箱：真实副本（消息分页/comm 对账的数据源；20k 文件）
  const mailSrc = path.join(REAL_STATUS, '邮箱');
  if (fs.existsSync(mailSrc)) { try { fs.cpSync(mailSrc, path.join(TEAM, '状态', '邮箱'), { recursive: true }); } catch { /* ignore */ } }
  const roleSrc = path.join(REAL_TEAM, '角色');
  if (fs.existsSync(roleSrc)) { try { fs.cpSync(roleSrc, path.join(TEAM, '角色'), { recursive: true }); } catch { /* ignore */ } }
  // 团队.json：真实副本，清 sessionId（避免 SESSION_REPLACED 类噪声）
  const teamSrc = path.join(REAL_STATUS, '团队.json');
  if (fs.existsSync(teamSrc)) {
    const team = JSON.parse(fs.readFileSync(teamSrc, 'utf8'));
    for (const m of team.members || []) m.sessionId = '';
    fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2));
  }
  // workbench：真实副本，路径改到真实项目目录（只读引用）
  const store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  for (const pj of store.projects || []) {
    if (String(pj.name) === PROJECT || String(pj.teamName) === PROJECT) {
      pj.path = path.join(ROOT, '项目', PROJECT);
      // 合成 5594 条消息（含 body），验证 messages:page 分页与 app:state 只下发最近 50 条。
      pj.messages = Array.from({ length: 5594 }, (_, i) => ({
        id: 'M-SBX-' + String(i).padStart(6, '0'),
        from: i % 2 ? 'pm' : 'programmer1',
        to: 'programmer1',
        subject: '沙盘消息 ' + i,
        body: 'body-'.repeat(160),
        at: new Date(Date.UTC(2026, 10, 20, 0, 0, i)).toISOString(),
        read: i % 3 === 0,
        ackRequired: i % 7 === 0,
      }));
    }
  }
  store.activeProjectId = (store.projects || []).find((pj) => String(pj.name) === PROJECT || String(pj.teamName) === PROJECT)?.id || store.activeProjectId;
  fs.writeFileSync(wbFile, JSON.stringify(store, null, 2));
};
seed();
const env = {
  ...process.env,
  AWB_TEAM_ROOT: TEAM,
  AWB_TEAM_PROJECTS_ROOT: path.join(SANDBOX, '项目'),
  TEAM_ROOT: TEAM,
  TEAM_PROJECTS_ROOT: path.join(SANDBOX, '项目'),
  TEAM_WORKBENCH_JSON: wbFile,
  AWB_STORE: wbFile,
  AWB_DATA_DIR: DATA,
  TEAM_SELFTEST: '1',
  AWB_SHOW_INACTIVE: '1',
  DSH_WEB_URL: 'http://127.0.0.1:1',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.AWB_IPC_COALESCE_MS;
const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const child = spawn(electron, [ROOT, `--remote-debugging-port=${PORT}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
// 纪律：只回收自己 spawn 的 PID 树（Windows child.kill 不保证收子进程）。
const killOwnChild = () => {
  try { child.kill(); } catch { /* ignore */ }
  try { require('node:child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
};
let stdout = '';
child.stdout.on('data', (d) => { stdout += String(d); });
child.stderr.on('data', (d) => { stdout += String(d); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJson = (url) => new Promise((resolve, reject) => {
  const req = require('node:http').get(url, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.setTimeout(3000, () => { req.destroy(new Error('timeout')); });
});
class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url); this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
      ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } } catch { /* ignore */ } };
    });
  }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.id; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('EVAL ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result ? r.result.value : undefined; }
}
(async () => {
  const lines = [];
  let cdp = null; let targetInfo = null;
  const t0 = Date.now();
  for (let i = 0; i < 60 && !cdp; i += 1) {
    await sleep(500);
    try {
      const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
      const pages = (list || []).filter((t) => t.type === 'page' && /index\.html/i.test(String(t.url || '')));
      if (pages.length) {
        targetInfo = { id: pages[0].id, title: pages[0].title, url: pages[0].url, ws: pages[0].webSocketDebuggerUrl };
        cdp = new Cdp(targetInfo.ws); await cdp.connect();
      }
    } catch { /* retry */ }
  }
  if (!cdp) { console.error('CDP target index.html 未就绪'); killOwnChild(); process.exit(2); }
  await cdp.send('Runtime.enable');
  await sleep(4000);
  const meta = await cdp.eval(`(() => ({ count: (window.workbench && window.workbench.__state ? 1 : 1), heap: performance.memory ? performance.memory.usedJSHeapSize : -1 }))()`);
  // E31B_CONTRACTS：三契约实测（阶段均在壳主窗渲染进程内）
  let contracts = null;
  try {
    contracts = await cdp.eval(`(async () => {
      const api = window.workbench;
      if (!api) return { ok: false, error: 'no workbench api' };
      const st = await api.state();
      const pid = st && st.activeProjectId;
      const t = await api.tasksSummary({ projectId: pid, limit: 5 });
      const tFirst = t && t.ok && t.items && t.items[0] ? t.items[0] : null;
      const m = await api.messagesPage({ projectId: pid, limit: 50, offset: 0 });
      const mTail = await api.messagesPage({ projectId: pid, limit: 50, offset: (m && m.total) || 0 });
      const fRoot = await api.filesList({ projectId: pid, dir: '', limit: 500 });
      const fSrc = await api.filesList({ projectId: pid, dir: 'src', limit: 5 });
      const fOut = await api.filesList({ projectId: pid, dir: '..', limit: 5 });
      const pageIds = [];
      for (let i = 0; i < 5; i += 1) { const p = await api.messagesPage({ projectId: pid, limit: 50, offset: i * 50 }); for (const it of (p && p.items) || []) pageIds.push(it.id); }
      return {
        tasks: t && t.ok ? { count: t.items.length, total: t.total, keys: tFirst ? Object.keys(tFirst) : [], bytes: tFirst ? JSON.stringify(tFirst).length : 0 } : t,
        messages: m && m.ok ? { count: m.items.length, total: m.total, hasBody: !!(m.items[0] && Object.prototype.hasOwnProperty.call(m.items[0], 'body')), keys: m.items[0] ? Object.keys(m.items[0]) : [] } : m,
        messagesTail: mTail && mTail.ok ? { count: mTail.items.length, total: mTail.total } : mTail,
        filesRoot: fRoot && fRoot.ok ? { count: fRoot.items.length, truncated: fRoot.truncated, hasRecursion: fRoot.items.some((it) => String(it.rel || '').includes('/')), keys: fRoot.items[0] ? Object.keys(fRoot.items[0]) : [] } : fRoot,
        filesSrc: fSrc && fSrc.ok ? { count: fSrc.items.length, dir: fSrc.dir } : fSrc,
        filesOutside: fOut && fOut.ok === false ? { code: fOut.code } : { code: 'NOT_REJECTED', raw: fOut },
        pages5: { ids: pageIds.length, unique: new Set(pageIds).size },
      };
    })()`);
  } catch (e) { contracts = { error: String(e && e.message || e).slice(0, 300) }; }
  // E31B_PANELS：隐藏面板懒渲染证据（T-0f58）：打开前后 DOM 数 / flow 行数 / 板面板 / 图片缓存上限
  let panels = null;
  try {
    panels = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const count = () => ({
        nodes: document.getElementsByTagName(String.fromCharCode(42)).length,
        heap: performance.memory ? performance.memory.usedJSHeapSize : -1,
        flowPanelHidden: Boolean(document.querySelector('#flow-panel') && document.querySelector('#flow-panel').hidden),
        flowBoardRows: document.querySelectorAll('#flow-board *').length,
        boardPanelHidden: Boolean(document.querySelector('#board-panel') && document.querySelector('#board-panel').hidden),
        boardPanelNodes: document.querySelectorAll('#board-panel *').length,
        reviewDialogNodes: document.querySelectorAll('[data-owner-review-dialog] *').length,
      });
      const before = count();
      const flowBtn = document.querySelector('[data-tab="flow"]');
      if (flowBtn) flowBtn.click();
      await wait(900);
      const afterFlow = count();
      const boardBtn = document.querySelector('#board-launcher');
      if (boardBtn) boardBtn.click();
      await wait(900);
      const afterBoard = count();
      const cache = (typeof window.__awbImageCacheStats === 'function') ? window.__awbImageCacheStats() : null;
      return { before, afterFlow, afterBoard, imageCache: cache };
    })()`);
  } catch (e) { panels = { error: String(e && e.message || e).slice(0, 300) }; }
  // E31B_CLICKS：20 次点击→可见（任务行/文件页/翻页三入口能点哪个点哪个）
  let clicks = null;
  try {
    clicks = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const pick = () => {
        const cands = [document.querySelector('.task-row [data-task-status]'), document.querySelector('[data-tab="files"]'), document.querySelector('#files-list [data-file-rel]'), document.querySelector('#btn-pool')];
        return cands.find((el) => el && el.getBoundingClientRect().height > 0) || null;
      };
      const samples = [];
      for (let i = 0; i < 20; i += 1) {
        const el = pick();
        if (!el) return { ok: false, error: 'no clickable', samples };
        const t0 = performance.now();
        el.click();
        await Promise.race([raf2(), wait(150)]);
        samples.push(Math.round(performance.now() - t0));
        await wait(60);
      }
      samples.sort((a, b) => a - b);
      return { ok: true, samples, p95: samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))] };
    })()`);
  } catch (e) { clicks = { error: String(e && e.message || e).slice(0, 300) }; }
  // 长任务观察器（复用需求 §十 允许入口）
  await cdp.eval(`(() => { window.__e31bLong = { count: 0, maxMs: 0, over50: 0, over100: 0, items: [] }; try { new PerformanceObserver((list) => { for (const e of list.getEntries()) { const ms = Math.round(e.duration); const o = window.__e31bLong; o.count += 1; o.maxMs = Math.max(o.maxMs, ms); if (ms > 50) o.over50 += 1; if (ms > 100) { o.over100 += 1; o.items.push(ms); } } }).observe({ entryTypes: ['longtask'] }); } catch {} return true; })()`);
  const samples = [];
  const deadline = Date.now() + MINUTES * 60000;
  let lastClick = null;
  while (Date.now() < deadline) {
    let heap = -1; let counts = null;
    try {
      counts = await cdp.eval(`(() => { const s = window.__awbState || null; return { heap: performance.memory ? performance.memory.usedJSHeapSize : -1, targets: (window.__e31bLong && window.__e31bLong.count) || 0 }; })()`);
      heap = counts && counts.heap;
    } catch { /* ignore */ }
    samples.push({ at: new Date().toISOString(), tMs: Date.now() - t0, usedJSHeapSize: heap });
    await sleep(30000);
  }
  // GC 后堆
  let gcHeap = -1;
  try { await cdp.send('HeapProfiler.enable'); await cdp.send('HeapProfiler.collectGarbage'); await sleep(800); gcHeap = await cdp.eval('performance.memory ? performance.memory.usedJSHeapSize : -1'); } catch { /* ignore */ }
  const long = await cdp.eval('window.__e31bLong || null').catch(() => null);
  const counts = await cdp.eval(`(() => { const st = window.__awbState || null; const p = st && st.projects && st.projects[0]; return { hasState: Boolean(st), tasks: p ? (p.tasks || []).length : -1, messages: p ? (p.messages || []).length : -1, requirements: p ? (p.requirements || []).length : -1, projects: st ? (st.projects || []).length : -1 }; })()`).catch(() => null);
  const report = { at: new Date().toISOString(), minutes: MINUTES, target: targetInfo, meta, samples, gcHeap, long, counts, contracts, panels, clicks, root: ROOT, sandbox: SANDBOX, stdoutTail: stdout.slice(-2000) };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'heap.jsonl'), samples.map((s) => JSON.stringify({ ...s, targetId: targetInfo.id, title: targetInfo.title })).join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out: OUT, target: targetInfo.url, samples: samples.length, first: samples[0] && samples[0].usedJSHeapSize, last: samples[samples.length - 1] && samples[samples.length - 1].usedJSHeapSize, gcHeap, long, counts, contracts, clicks }));
  killOwnChild();
  try { await cdp.send('Browser.close'); } catch { /* ignore */ }
  await sleep(800);
  if (!KEEP) { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ } }
  process.exit(0);
})().catch((e) => { console.error('FAILED', e && e.stack); killOwnChild(); process.exit(1); });
