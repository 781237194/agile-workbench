#!/usr/bin/env node
/* R-c72a AC2（批3 返工）真窗口验证：切项目后 #pool-req-list 必须跟着换数据。
 * 做什么：沙盘播种两个项目（A/B 各 50 行，需求 id 前缀 A0000/B0000 以便区分）→ 起真实 Electron（AWB_DATA_DIR + TEAM_ROOT 双隔离）
 *        → 打开需求池 → 循环 30 次「点侧栏/工作区弹出层的 [data-project]」交替切 A/B → 每次等列表首行 id 变化并记时
 *        → 用 __uiPerf.measure(..., visibleChange{selector,from,to,atMs}) 记样本 → report('list') 落 交互性能.jsonl → 判 p95 ≤100ms。
 * 用法：node scripts/test-c72a-switch.cjs [--base <目录>] [--rows 50] [--out <json>] [--port 9451]
 * 隔离：只写 <base> 沙盘；跑前跑后比对真实 团队/状态/团队.json 的 sha256+mtime（AC8a），并检查沙盘 store 独立生成（AC8b）。
 * 退出码：0 = 全部通过；1 = 断言失败；2 = 环境/IO 错。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { seedTwoProjects } = require('./fixture-two-projects.cjs');
const { seedSandbox, sandboxEnv, makeRequirements, readJson, writeJson, ROOT } = require('./lib/c72a-sandbox.cjs');

function argOf(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const PORT = Number(argOf('--port', '9451'));
const ROWS = Number(argOf('--rows', '50'));
const OUT = path.resolve(argOf('--out', path.join(ROOT, '_tmp', 'c72a-batch3', 'switch-ac2.json')));
const BASE = path.resolve(argOf('--base', path.join(ROOT, '_tmp', 'c72a-batch3', 'two-projects')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REAL_TEAM_FILE = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
function statOf(file) {
  try {
    const buf = fs.readFileSync(file);
    const st = fs.statSync(file);
    return { file, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), mtime: st.mtime.toISOString() };
  } catch { return { file, missing: true }; }
}

function httpJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = ''; res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
  });
}
async function waitTarget(ms, pick) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
    if (Array.isArray(list)) {
      const hit = list.find(pick);
      if (hit && hit.webSocketDebuggerUrl) return hit;
    }
    await sleep(400);
  }
  return null;
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      }
    });
  }
  send(method, params = {}, ms = 60000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, ms);
    });
  }
  async evaluate(expr, ms = 120000) {
    try {
      const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, ms);
      if (out && out.exceptionDetails) {
        return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text).slice(0, 800) };
      }
      return out && out.result ? out.result.value : undefined;
    } catch (e) { return { __cdperror: String((e && e.message) || e) }; }
  }
}

let spawnedChild = null;
async function launch(seed) {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], {
    cwd: ROOT, env: sandboxEnv(seed), stdio: 'ignore', windowsHide: false,
  });
  spawnedChild = child;
  const target = await waitTarget(60000, (x) => x && x.type === 'page' && String(x.url || '').includes('renderer/index.html'));
  if (!target) { try { child.kill(); } catch { /* */ } return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('ws 打开超时')), 15000);
    ws.addEventListener('open', () => { clearTimeout(timer); res(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); rej(new Error('ws 连接失败')); }, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  // 壳内 webview 是真实 DSH 页面：导航 about:blank，避免它干扰本隔离实例的布局/截图
  const guest = await waitTarget(6000, (x) => x && x.type === 'webview');
  if (guest) {
    try {
      const gws = new WebSocket(guest.webSocketDebuggerUrl);
      await new Promise((res) => { gws.addEventListener('open', res, { once: true }); setTimeout(res, 3000); });
      gws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: 'about:blank' } }));
      await sleep(600);
    } catch { /* 关掉也不影响断言 */ }
  }
  return { child, cdp, ws };
}

// 页面内：30 次交替切项目，记「点击 → #pool-req-list 首行 id 变化」的 rAF 后时间
const SWITCH_MEASURE = (aId, bId, N) => `(async () => {
  const items = () => document.querySelectorAll('#workspace-pop-list [data-project]');
  const itemOf = (id) => document.querySelector('#workspace-pop-list [data-project="' + id + '"]');
  const listEl = () => document.getElementById('pool-req-list');
  const firstId = () => { const el = listEl(); const row = el ? el.querySelector('.pool-row') : null; return row ? String(row.getAttribute('data-id') || '') : ''; };
  const rowCount = () => { const el = listEl(); return el ? el.querySelectorAll('.pool-row').length : -1; };
  const waitFrames = (n) => new Promise((r) => { let k = 0; const tick = () => { k += 1; if (k >= n) r(); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  const openPop = async () => {
    if (itemOf('${aId}') || itemOf('${bId}')) return true;
    const btn = document.getElementById('workspace-switch');
    if (!btn) return false;
    btn.click();
    await waitFrames(3);
    return Boolean(itemOf('${aId}') || itemOf('${bId}'));
  };
  if (!listEl()) return { ok: false, code: 'ANCHOR_MISSING', anchor: '#pool-req-list' };
  if (!window.__uiPerf || typeof window.__uiPerf.measure !== 'function') return { ok: false, code: 'PROBE_UNAVAILABLE', anchor: '__uiPerf' };
  const samples = [];
  const diag = [];
  const errors = [];
  window.addEventListener('error', (e) => { if (errors.length < 20) errors.push(String((e && e.message) || e)); });
  window.addEventListener('unhandledrejection', (e) => { if (errors.length < 20) errors.push('rejection:' + String((e && e.reason && e.reason.message) || (e && e.reason) || e)); });
  const curId = () => { const n = document.querySelector('#workspace-pop-list [data-project][aria-current="true"]'); return n ? n.getAttribute('data-project') : ''; };
  const toastText = () => { const n = document.getElementById('toast'); return n ? String(n.textContent || '').slice(0, 160) : ''; };
  let current = (() => { const row = (items() || []).length ? document.querySelector('#workspace-pop-list [data-project][aria-current="true"]') : null; return row ? row.getAttribute('data-project') : ''; })();
  for (let i = 0; i < ${N}; i += 1) {
    const target = current === '${aId}' ? '${bId}' : '${aId}';
    const opened = await openPop();
    const item = itemOf(target);
    if (!opened || !item) { diag.push({ i: i, code: 'NO_ITEM', target: target, opened: opened }); break; }
    const beforeFirst = firstId();
    const beforeN = rowCount();
    window.__uiPerf.mark('sw' + i);
    const t0 = performance.now();
    item.click();
    const res = await new Promise((resolve) => {
      let frames = 0;
      const tick = () => {
        frames += 1;
        const nowFirst = firstId();
        const nowN = rowCount();
        const elapsed = performance.now() - t0;
        if (nowFirst && nowFirst !== beforeFirst && nowN > 0) { resolve({ atMs: elapsed, first: nowFirst, n: nowN, frames: frames }); return; }
        if (elapsed > 3000) { resolve({ timeout: true, first: nowFirst, n: nowN, frames: frames }); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    if (res.timeout) {
      window.__uiPerf.measure('list:sw' + i, 'sw' + i, { selector: '#pool-req-list', from: beforeFirst, to: res.first, atMs: 3000 });
      diag.push({ i: i, code: 'TIMEOUT', target: target, beforeFirst: beforeFirst, after: res.first, beforeN: beforeN, afterN: res.n, cur: curId(), maskHidden: Boolean((document.getElementById('pool-mask') || {}).hidden), toast: toastText() });
      current = target;
      continue;
    }
    window.__uiPerf.measure('list:sw' + i, 'sw' + i, { selector: '#pool-req-list', from: beforeFirst, to: res.first, atMs: Math.round(res.atMs) });
    samples.push({ atMs: Math.round(res.atMs), target: target, before: beforeFirst, after: res.first, frames: res.frames });
    // 采完这一拍再等 state 落定（selectProject 内部 activateWorkspace 约 0.5–0.8s）：下一轮点「当前项目」会走
    // selectWorkspace 的 early-return，不等就会被误判 TIMEOUT。等待时间不计入样本。
    const waitStart = performance.now();
    while (curId() !== target && performance.now() - waitStart < 8000) await waitFrames(2);
    const settleMs = Math.round(performance.now() - waitStart);
    if (curId() !== target) {
      diag.push({ i: i, code: 'STATE_NOT_SETTLED', target: target, cur: curId(), settleMs: settleMs, toast: toastText() });
    }
    current = target;
    await waitFrames(2);
  }
  const report = await window.__uiPerf.report('list', { project: '工作台改造修复' });
  return {
    ok: true,
    samples: samples,
    diag: diag,
    report: report,
    lastFirst: firstId(),
    lastN: rowCount(),
    current: current,
    expandedGroup: (document.getElementById('side-float') || {}).getAttribute ? document.getElementById('side-float').getAttribute('data-float-expanded') : null,
    errors: errors,
    lastCur: curId(),
    lastToast: toastText(),
    maskHidden: Boolean((document.getElementById('pool-mask') || {}).hidden),
  };
})()`;

(async () => {
  const HARD_MS = Number(argOf('--hard-timeout-ms', '300000'));
  setTimeout(() => {
    console.error('HARD TIMEOUT ' + HARD_MS + 'ms：强制退出，避免沙盘实例悬住');
    try { if (spawnedChild) spawnedChild.kill(); } catch { /* */ }
    process.exit(3);
  }, HARD_MS);

  const baseBefore = { team: statOf(REAL_TEAM_FILE), store: statOf(REAL_STORE) };
  // 播种：两项目各 50 行，且需求 id 前缀不同（A0000/B0000）——这样才能看出「列表是否真的换了数据」
  const seed = seedTwoProjects({ base: BASE, rows: ROWS });
  const prefixes = [{ prefix: 'R-20261116-A0000' }, { prefix: 'R-20261116-B0000' }];
  seed.projects.forEach((p, i) => {
    const wfPath = path.join(seed.team, '状态', '项目', p.slug, '工作流.json');
    const wf = readJson(wfPath, null);
    wf.requirements = makeRequirements(ROWS, prefixes[i] || prefixes[0]);
    writeJson(wfPath, wf);
  });
  const idA = seed.projects[0].id;
  const idB = seed.projects[1].id;

  const out = {
    at: new Date().toISOString(),
    project: '工作台改造修复',
    case: 'R-c72a AC2 切项目刷新需求池',
    fixture: 'scripts/fixture-two-projects.cjs + scripts/lib/c72a-sandbox.cjs（A/B 各 50 行，前缀 A0000/B0000）',
    base: seed.base,
    port: PORT,
    projects: seed.projects,
  };
  const inst = await launch(seed);
  try {
    if (!inst) { out.ok = false; out.code = 'LAUNCH_FAILED'; }
    else {
      const { cdp, ws } = inst;
      for (let i = 0; i < 120; i += 1) {
        const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(document.getElementById("btn-pool"))');
        if (ready === true) break;
        await sleep(500);
      }
      // 打开需求池（真实入口）
      await cdp.evaluate(`(function(){ const b = document.getElementById('btn-pool'); if (b) b.click(); return true; })()`);
      let rows = 0;
      for (let i = 0; i < 60; i += 1) {
        rows = await cdp.evaluate(`(function(){ const el = document.querySelector('#pool-req-list'); return el ? el.querySelectorAll('.pool-row').length : -1; })()`);
        if (typeof rows === 'number' && rows > 0) break;
        await sleep(500);
      }
      out.poolRowsRendered = rows;
      await sleep(1500); // 预热：首屏布局/光栅稳定后再采
      if (process.argv.includes('--diag')) {
        // 诊断模式：拆「点击 → state 切换(aria-current)」与「state 切换 → 列表变化」两段耗时，并直接量 IPC
        out.diag = await cdp.evaluate(`(async () => {
          const d = {};
          const raf = () => new Promise((r) => requestAnimationFrame(r));
          const first = () => { const el = document.getElementById('pool-req-list'); const row = el ? el.querySelector('.pool-row') : null; return row ? String(row.getAttribute('data-id') || '') : ''; };
          const cur = () => { const n = document.querySelector('#workspace-pop-list [data-project][aria-current="true"]'); return n ? n.getAttribute('data-project') : ''; };
          let t = performance.now();
          const wf0 = await window.workbench.workflowState({ projectId: '${idB}' });
          d.workflowStateFirstMs = Math.round(performance.now() - t);
          t = performance.now();
          const wf0b = await window.workbench.workflowState({ projectId: '${idB}' });
          d.workflowStateSecondMs = Math.round(performance.now() - t);
          d.workflowStateOk = Boolean(wf0b && wf0b.ok !== false);
          t = performance.now();
          const r1 = await window.workbench.selectProject('${idB}');
          d.selectProjectMs = Math.round(performance.now() - t);
          d.selectProjectOk = Boolean(r1 && r1.state);
          t = performance.now();
          const wf = await window.workbench.workflowState({ projectId: '${idB}' });
          d.workflowStateAfterSwitchMs = Math.round(performance.now() - t);
          d.workflowStateAfterSwitchOk = Boolean(wf && wf.ok !== false);
          await window.workbench.selectProject('${idA}');
          await raf(); await raf();
          const items = document.querySelectorAll('#workspace-pop-list [data-project]');
          d.itemCount = items.length;
          const item = document.querySelector('#workspace-pop-list [data-project="${idB}"]');
          if (item) {
            const beforeFirst = first();
            const t0 = performance.now();
            item.click();
            let stateMs = null;
            let listMs = null;
            const end = performance.now() + 5000;
            while (performance.now() < end) {
              await raf();
              if (stateMs === null && cur() === '${idB}') stateMs = performance.now() - t0;
              if (listMs === null && first() && first() !== beforeFirst) { listMs = performance.now() - t0; break; }
            }
            d.clickToStateMs = stateMs === null ? null : Math.round(stateMs);
            d.clickToListMs = listMs === null ? null : Math.round(listMs);
            d.beforeFirst = beforeFirst;
            d.afterFirst = first();
            d.toast = (document.getElementById('toast') || {}).textContent || '';
          } else d.noItem = true;
          return d;
        })()`, 120000);
        out.ok = Boolean(out.diag && out.diag.clickToListMs !== null);
        out.verdict = out.ok ? 'DIAG' : 'DIAG_FAIL';
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
        console.log(JSON.stringify({ out: OUT, diag: out.diag }, null, 2));
        try { if (inst) inst.cdp.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* */ }
        setTimeout(() => { try { if (inst) inst.child.kill(); } catch { /* */ } process.exit(out.ok ? 0 : 1); }, 800);
        return;
      }
      const N = Number(argOf('--n', '30'));
      const res = await cdp.evaluate(SWITCH_MEASURE(idA, idB, N), 180000);
      out.measure = res;
      const samples = (res && Array.isArray(res.samples)) ? res.samples : [];
      const nums = samples.map((s) => Number(s.atMs)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
      const pick = (q) => (nums.length ? nums[Math.min(nums.length - 1, Math.max(0, Math.ceil(q * nums.length) - 1))] : null);
      out.stat = { n: nums.length, min: nums[0] ?? null, p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: nums.length ? nums[nums.length - 1] : null };
      out.report = res && res.report ? res.report : null;
      out.verdict = 'OK';
      out.violations = [];
      if (!res || res.ok !== true) { out.verdict = 'ENV_FAIL'; out.violations.push('measure:' + JSON.stringify(res && (res.code || res.__exception || res.__cdperror))); }
      else {
        if (nums.length < 30) out.violations.push('samples<30');
        if (!(out.stat.p95 !== null && out.stat.p95 <= 100)) out.violations.push('p95>100ms');
        if (Array.isArray(res.diag) && res.diag.length) out.violations.push('diag:' + res.diag.map((d) => d.code).join(','));
        // 每次切换后首行 id 必须属于目标项目前缀
        for (const s of samples) {
          const want = s.target === idB ? 'R-20261116-B0000-' : 'R-20261116-A0000-';
          if (!String(s.after || '').startsWith(want)) { out.violations.push('firstRowPrefixWrong:' + s.after); break; }
        }
        if (out.report && out.report.line && out.report.line.case === 'list') {
          if (!(out.report.line.samples >= 30)) out.violations.push('jsonl.samples<30');
          if (!(out.report.line.verdict === 'OK')) out.violations.push('jsonl.verdict=' + out.report.line.verdict);
        } else {
          out.violations.push('jsonl.lineMissing');
        }
        if (out.violations.length) out.verdict = 'BUDGET_EXCEEDED';
      }
      out.ok = out.verdict === 'OK';
      try { ws.close(); } catch { /* */ }
    }
  } finally {
    // fire-and-forget：await Browser.close 会因页面目标关闭而永不 resolve
    try { if (inst) inst.cdp.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* */ }
    setTimeout(() => { try { if (inst) inst.child.kill(); } catch { /* */ } }, 800);
  }

  // AC8a：真实 团队/状态/团队.json 跑前跑后不变（隔离硬判据）
  const baseAfter = { team: statOf(REAL_TEAM_FILE), store: statOf(REAL_STORE) };
  out.isolation = {
    teamFileBefore: baseBefore.team,
    teamFileAfter: baseAfter.team,
    teamFileUnchanged: Boolean(baseBefore.team.sha256 && baseAfter.team.sha256
      && baseBefore.team.sha256 === baseAfter.team.sha256
      && baseBefore.team.mtime === baseAfter.team.mtime),
    // AC8b：沙盘有自己独立生成的 store
    sandboxStore: {
      file: path.join(seed.data, 'userdata', 'workbench.json'),
      exists: fs.existsSync(path.join(seed.data, 'userdata', 'workbench.json')),
    },
    // 真实 workbench.json 只作观察、不作判据（Owner 正常实例可能在跑测期间写它）
    realStoreBefore: baseBefore.store,
    realStoreAfter: baseAfter.store,
    realStoreTouched: Boolean(baseBefore.store.sha256 && baseAfter.store.sha256 && baseBefore.store.sha256 !== baseAfter.store.sha256),
  };
  if (!out.isolation.teamFileUnchanged) { out.violations.push('AC8a:团队.json变了'); out.ok = false; out.verdict = 'ENV_FAIL'; }
  if (!out.isolation.sandboxStore.exists) { out.violations.push('AC8b:沙盘store缺失'); out.ok = false; out.verdict = 'ENV_FAIL'; }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
  await sleep(1200);
  console.log(JSON.stringify({ out: OUT, ok: out.ok, verdict: out.verdict, violations: out.violations, stat: out.stat, report: out.report && out.report.line, isolation: { teamFileUnchanged: out.isolation.teamFileUnchanged, sandboxStore: out.isolation.sandboxStore.exists, realStoreTouched: out.isolation.realStoreTouched } }, null, 2));
  process.exit(out.ok ? 0 : 1);
})().catch((e) => {
  console.error('ERR ' + ((e && e.stack) || e));
  process.exit(2);
});
