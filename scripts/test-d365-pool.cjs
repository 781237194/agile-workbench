'use strict';
/** T-d365：真实隔离实例打开需求/缺陷池，验证缺陷池非「加载中」、计数=行数、空态/骨架已清。 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const BASE = path.join(ROOT, '_tmp', 'pool-d365-' + process.pid + '-' + Date.now());
const DATA = path.join(BASE, 'data');
const TEAM = path.join(BASE, '团队');
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const OUT = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-d365-20261122');
const PORT = 10020 + (process.pid % 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJson = (url) => new Promise((resolve, reject) => { const req = http.get(url, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('timeout'))); });
async function waitPage(ms) { const end = Date.now() + ms; while (Date.now() < end) { try { const list = await httpJson('http://127.0.0.1:' + PORT + '/json/list'); const p = (list || []).find((t) => t.type === 'page' && /index\.html/i.test(String(t.url || ''))); if (p) return p; } catch { /* wait */ } await sleep(500); } return null; }
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(String(e.data)); } catch { return; } if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } }); }
  send(method, params = {}, ms = 60000) { const id = ++this.seq; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, ms); }); }
  async eval(expr, ms = 60000) { try { const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms); return out && out.result ? out.result.value : undefined; } catch (e) { return { __cdperror: String((e && e.message) || e) }; } }
}
fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
fs.mkdirSync(path.join(BASE, 'userdata'), { recursive: true });
fs.copyFileSync(path.join(ROOT, '团队', '状态', '团队.json'), path.join(TEAM, '状态', '团队.json'));
const realProjectState = path.join(ROOT, '团队', '状态', '项目', '工作台改造修复');
const sandboxProjectState = path.join(TEAM, '状态', '项目', '工作台改造修复');
if (fs.existsSync(realProjectState)) fs.cpSync(realProjectState, sandboxProjectState, { recursive: true });
if (String(process.env.AWB_D365_EMPTY || '') === '1') {
  const taskDir = path.join(sandboxProjectState, '任务');
  for (const name of fs.readdirSync(taskDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const file = path.join(taskDir, name);
      const row = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (['bug', 'scenario-bug'].includes(String(row.type || '').toLowerCase())) fs.rmSync(file, { force: true });
    } catch { /* ignore */ }
  }
}
const SUFFIX = String(process.env.AWB_D365_EMPTY || '') === '1' ? '-empty' : '';
fs.copyFileSync(path.join(ROOT, 'data', 'userdata', 'workbench.json'), STORE);
fs.mkdirSync(OUT, { recursive: true });
const env = {
  ...process.env, AWB_DATA_DIR: DATA, AWB_STORE: STORE, TEAM_WORKBENCH_JSON: STORE,
  TEAM_ROOT: TEAM, AWB_TEAM_ROOT: process.env.AWB_TEAM_ROOT || path.join(ROOT, '团队'),
  AWB_SHOW_INACTIVE: '1', DSH_WEB_URL: 'http://127.0.0.1:1',
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
    await cdp.send('Page.enable').catch(() => {});
    for (let i = 0; i < 100; i += 1) { if ((await cdp.eval('Boolean(window.workbench && document.querySelector("#btn-pool"))')) === true) break; await sleep(300); }
    await sleep(3000);
    const openTiming = await cdp.eval(`(async () => {
      const t0 = performance.now();
      const b = document.querySelector('#btn-pool');
      if (!b) return { clicked: false, ms: -1 };
      b.click();
      for (let i = 0; i < 120; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
        const n = document.querySelector('#pool-def-n');
        const list = document.querySelector('#pool-def-list');
        if (n && Number(n.textContent) === 0 && list && list.querySelector('.pool-empty')) {
          return { clicked: true, ms: Math.round((performance.now() - t0) * 10) / 10, count: 0, rows: 0, virtual: '' };
        }
        if (n && Number(n.textContent) > 100 && list && list.querySelectorAll('.pool-row').length > 0) {
          return { clicked: true, ms: Math.round((performance.now() - t0) * 10) / 10, count: Number(n.textContent), rows: list.querySelectorAll('.pool-row').length, virtual: list.dataset.defVirtual || '' };
        }
      }
      const n = document.querySelector('#pool-def-n');
      const list = document.querySelector('#pool-def-list');
      return { clicked: true, ms: Math.round((performance.now() - t0) * 10) / 10, count: n ? Number(n.textContent) : -1, rows: list ? list.querySelectorAll('.pool-row').length : -1, timedOut: true };
    })()`);
    const clicked = Boolean(openTiming && openTiming.clicked);
    await sleep(200);
    const wfProbe = await cdp.eval(`(async () => {
      try {
        const wf = await window.workbench.workflowState({});
        const full = await window.workbench.workflow({});
        const tasks = Array.isArray(wf && wf.tasks) ? wf.tasks : [];
        const fullTasks = Array.isArray(full && full.tasks) ? full.tasks : [];
        const types = {};
        const openBugIds = [];
        for (const t of tasks) { const k = String((t && t.type) || '(none)'); types[k] = (types[k] || 0) + 1; if ((k === 'bug' || k === 'scenario-bug') && !['done', 'accepted', 'cancelled', 'terminated'].includes(String((t && t.status) || '').toLowerCase())) openBugIds.push(t.id); }
        return { ok: Boolean(wf && wf.ok !== false), project: wf && wf.project, projectPath: wf && wf.projectPath, teamMode: wf && wf.teamMode, truthSource: wf && wf.truthSource, tasksTotal: wf && wf.tasksTotal, tasksSummary: wf && wf.tasksSummary, counts: wf && wf.counts, fullTasks: fullTasks.length, fullCounts: full && full.counts, keys: wf ? Object.keys(wf).slice(0, 16) : null, tasks: tasks.length, types, openBugIds, sample: tasks.slice(0, 3).map((t) => ({ id: t.id, type: t.type, status: t.status })) };
      } catch (e) { return { error: String((e && e.message) || e) }; }
    })()`);
    const filterProbe = await cdp.eval(`(async () => {
      const defN = document.querySelector('#pool-def-n');
      if (defN && Number(defN.textContent) === 0 && document.querySelector('#pool-def-list .pool-empty')) {
        return { ok: true, empty: true, count: 0, virtualTotal: 0, rows: 0 };
      }
      const defect = document.querySelector('#pool-kinds .pool-kind-chip[data-kind-filter="defect"]');
      if (!defect) return { ok: false, reason: 'no-kind-filter' };
      defect.click();
      await new Promise((r) => setTimeout(r, 250));
      const list = document.querySelector('#pool-def-list');
      const n = document.querySelector('#pool-def-n');
      const virtual = list && list.dataset.defVirtual ? JSON.parse(list.dataset.defVirtual) : null;
      const chips = Array.from(document.querySelectorAll('#pool-kinds .pool-kind-chip')).map((b) => [b.dataset.kindFilter, b.querySelector('i') ? b.querySelector('i').textContent : '', b.classList.contains('on')]);
      const foot = document.querySelector('#pool-foot') ? document.querySelector('#pool-foot').textContent : '';
      const out = { ok: Boolean(n && Number(n.textContent) === 368 && virtual && Number(virtual.total) === 368 && list && list.querySelectorAll('.pool-row').length > 0), count: n ? Number(n.textContent) : -1, virtualTotal: virtual ? virtual.total : null, rows: list ? list.querySelectorAll('.pool-row').length : -1, chips, foot };
      const all = document.querySelector('#pool-kinds .pool-kind-chip[data-kind-filter="all"]');
      if (all) all.click();
      await new Promise((r) => setTimeout(r, 150));
      return out;
    })()`);
    const state = await cdp.eval(`(() => {
      const q = (sel) => document.querySelector(sel);
      const def = q('#pool-def-list');
      const req = q('#pool-req-list');
      return {
        maskOpen: Boolean(q('#pool-mask') && !q('#pool-mask').hidden),
        defRows: def ? def.querySelectorAll('.pool-row').length : -1,
        defVirtual: def ? (def.dataset.defVirtual || '') : '',
        defScrollHeight: def ? def.scrollHeight : -1,
        defN: q('#pool-def-n') ? q('#pool-def-n').textContent : null,
        defSkeleton: def ? def.querySelectorAll('[data-skeleton]').length : -1,
        defEmpty: Boolean(def && def.querySelector('.pool-empty')),
        reqRows: req ? req.querySelectorAll('.pool-row').length : -1,
        reqN: q('#pool-req-n') ? q('#pool-req-n').textContent : null,
        reqSkeleton: req ? req.querySelectorAll('[data-skeleton]').length : -1,
        foot: q('#pool-foot') ? q('#pool-foot').textContent : '',
        text: def ? String(def.innerText || '').slice(0, 160) : ''
      };
    })()`);
    let shot = null;
    try {
      const cap = await cdp.send('Page.captureScreenshot', { format: 'png' }, 15000);
      shot = path.join(OUT, 'pool-open' + SUFFIX + '.png');
      fs.writeFileSync(shot, Buffer.from(cap.data, 'base64'));
    } catch { shot = null; }
    const report = { at: new Date().toISOString(), pid: child.pid, clicked, openTiming, filterProbe, wfProbe, state, shot };
    fs.writeFileSync(path.join(OUT, 'pool-open' + SUFFIX + '.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log('POOL_D365 ' + JSON.stringify({ pid: child.pid, clicked, openTiming, filterProbe, defRows: state && state.defRows, defN: state && state.defN, defSkeleton: state && state.defSkeleton, defEmpty: state && state.defEmpty, reqRows: state && state.reqRows, reqN: state && state.reqN, shot }));
    const ok = Boolean(clicked && filterProbe && filterProbe.ok === true && state && state.maskOpen && state.defSkeleton === 0
      && (state.defRows > 0 || state.defEmpty === true)
      && String(state.defN) === String(state.defVirtual ? (JSON.parse(state.defVirtual).total) : state.defRows));
    code = ok ? 0 : 1;
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
