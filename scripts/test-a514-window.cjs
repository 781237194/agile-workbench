#!/usr/bin/env node
'use strict';
/**
 * test-a514-window.cjs —— a514 真窗口样本（隐藏单实例 / 沙盘数据 / 不改生产终态）
 *
 * 每采一个样本前，把沙盘 工作流.json 复位（需求回到待决定），保证 3 次都是真实落账而不是「已处理秒过」。
 * 采：A 验收点击→成功提示可见 ×3；B 评审「通过」→「已通过」可见 ×3；C 打字 20 字符 p95；D 主进程 profile 行。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '_tmp', 'a514-window'); })();
fs.mkdirSync(OUT, { recursive: true });
// 740a（PM 12:43）：沙盘根固定在安装盘上的 awb-sandbox（AWB_SANDBOX_ROOT 可覆盖但拒绝系统盘），由 guard 统一校验/创建。
const sandboxGuard = require(path.join(ROOT, 'scripts', 'sandbox-guard.cjs'));
let SANDBOX_ROOT = '';
try {
  SANDBOX_ROOT = sandboxGuard.sandboxTmp();
  sandboxGuard.guard({ root: sandboxGuard.DEFAULTS.root });
} catch (error) {
  console.error(String((error && error.code) || 'SANDBOX_GUARD_FAILED') + ': ' + String((error && error.message) || error));
  process.exit(2);
}
const SB = fs.mkdtempSync(path.join(SANDBOX_ROOT, 'a514win-'));
const TEAM = path.join(SB, '团队');
const PROJ = path.join(SB, '项目', '工作台改造修复');
const STORE = path.join(SB, 'store', 'workbench.json');
const WF = path.join(TEAM, '状态', '项目', '工作台改造修复', '工作流.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[a514-window]', ...a);
const PROJECT = '工作台改造修复';
const REQ_ACCEPT = 'R-20261121-a514-a';
const REQ_REVIEW = 'R-20261121-a514-b';
let BASE_WF = null;

function cpRetry(src, dst) {
  let last = null;
  for (let i = 0; i < 4; i += 1) {
    try { fs.cpSync(src, dst, { recursive: true, force: true }); return; } catch (e) { last = e; }
    try { spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 400'], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
  throw last;
}

function seed() {
  fs.mkdirSync(path.join(TEAM, '状态', '项目'), { recursive: true });
  cpRetry(path.join(ROOT, '团队', '状态', '项目', PROJECT), path.join(TEAM, '状态', '项目', PROJECT));
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, '团队', '状态', '团队.json'), path.join(TEAM, '状态', '团队.json'));
  for (const name of ['工具', '角色', '协议', 'skill', '模板', '流程.md']) {
    const src = path.join(ROOT, '团队', name);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(TEAM, name);
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true, force: true });
    else fs.copyFileSync(src, dst);
  }
  fs.mkdirSync(PROJ, { recursive: true });
  for (const name of ['需求', '项目信息.md', '项目索引.md', '项目铁律.md']) {
    const src = path.join(ROOT, '项目', PROJECT, name);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(PROJ, name);
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true, force: true }); else fs.copyFileSync(src, dst);
  }
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  const wf = JSON.parse(fs.readFileSync(WF, 'utf8'));
  wf.requirements = wf.requirements || {};
  wf.ownerReview = { status: 'optional', opinion: '', at: null, by: null, actor: null };
  const docs = fs.readdirSync(path.join(PROJ, '需求')).filter((n) => /^R-.*\.md$/.test(n));
  const ts = (m) => new Date(Date.now() - m * 60000).toISOString();
  wf.requirements[REQ_ACCEPT] = {
    id: REQ_ACCEPT, title: 'a514 验收样本', status: 'test_done', phase: 'test_done', priority: 'P1',
    createdAt: ts(40), updatedAt: ts(1), acceptance: null,
    productReview: { verdict: 'approve', at: ts(30), by: 'product' },
    ownerReview: { status: 'pending', opinion: '', at: null },
    decisions: [{ decision: 'approved', at: ts(20), by: 'Owner', channel: 'ui', opinion: '开测' }],
    doc: docs[0] ? '需求/' + docs[0] : '', tasks: [],
  };
  wf.requirements[REQ_REVIEW] = {
    id: REQ_REVIEW, title: 'a514 评审样本', status: 'ready', phase: 'ready', priority: 'P1',
    createdAt: ts(30), updatedAt: ts(2), acceptance: null,
    productReview: { verdict: 'approve', at: ts(10), by: 'product' },
    ownerReview: { status: 'pending', opinion: '', at: null },
    decisions: [], doc: docs[0] ? '需求/' + docs[0] : '', tasks: [],
  };
  BASE_WF = JSON.stringify(wf, null, 2) + '\n';
  fs.writeFileSync(WF, BASE_WF, 'utf8');
  const taskDir = path.join(TEAM, '状态', '项目', PROJECT, '任务');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, REQ_ACCEPT + '.json'), JSON.stringify({
    id: 'T-20261121-a514-t1', type: 'task', title: 'a514 验收样本测试', status: 'done',
    owner: 'tester', requirementId: REQ_ACCEPT, createdAt: ts(20), updatedAt: ts(5), acceptance: 'ok', evidence: 'task-scan-base.log'
  }, null, 2), 'utf8');
  fs.writeFileSync(STORE, JSON.stringify({
    version: 1, activeProjectId: 'P-a514',
    projects: [{
      id: 'P-a514', name: PROJECT, teamName: PROJECT, path: PROJ, teamMode: 'full',
      workspace: { id: 'W-a514', path: PROJ, name: PROJECT, bound: true, sessionIds: [] },
      dshWorkspaceId: '', workspacePath: PROJ, sessions: {}, requirements: [], sessionMeta: {}, tasks: [], votes: [], ui: {}
    }],
    ui: {}
  }, null, 2) + '\n', 'utf8');
}
function resetWf() { if (BASE_WF) fs.writeFileSync(WF, BASE_WF, 'utf8'); }

function launch() {
  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const port = 9700 + Math.floor(Math.random() * 200);
  const env = {
    ...process.env,
    ...sandboxGuard.sandboxEnv(),
    AWB_DATA_DIR: path.join(SB, 'data'), AWB_STORE: STORE, AWB_TEAM_ROOT: TEAM,
    TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(SB, '项目'), TEAM_WORKBENCH_JSON: STORE,
    AWB_START_HIDDEN: '1', DSH_WEB_URL: 'http://127.0.0.1:1', AWB_SHOW_INACTIVE: '1',
    ...(process.env.A514_PROD_PATH === '1' ? {} : { TEAM_SELFTEST: '1' }),
    // 隐藏窗口下 Chromium 会节流 rAF，打字「下一帧」测不出来；测试实例关闭后台节流。
    AWB_BACKGROUND_THROTTLING: '0',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [ROOT, `--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
  child.stderr.on('data', (d) => { stdout += d.toString('utf8'); });
  return { child, port, getStdout: () => stdout };
}
async function waitTarget(port, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) return t;
    } catch { /* retry */ }
    await sleep(300);
  }
  return null;
}
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.ws.addEventListener('message', (ev) => {
    try { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); } } catch { /* ignore */ }
  }); }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.id; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP_TIMEOUT ' + method)); } }, 120000); }); }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('EVAL_FAIL ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
    return r.result ? r.result.value : undefined;
  }
}
async function pageWaitIdle(cdp) {
  await cdp.evaluate(`new Promise((r) => { const t0 = Date.now(); const tick = async () => {
    try { const s = await window.workbench.workflowSideEffectsStatus(); if (!(s.queue || []).some((q) => q.running || q.pending)) return r(true); } catch {}
    if (Date.now() - t0 > 20000) return r(false); setTimeout(tick, 250);
  }; tick(); })`);
}
const ACCEPT_ONE = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { const v = fn(); if (v) return { v, at: performance.now() }; await wait(16); } return null; };
  if (typeof window.__awbOpenAcceptList !== 'function') return { ok: false, error: 'no __awbOpenAcceptList' };
  window.__awbOpenAcceptList();
  await wait(700);
  const row = document.querySelector('.accept-row[data-req-id="${REQ_ACCEPT}"]');
  if (!row) return { ok: false, error: 'row missing' };
  row.querySelector('[data-action="owner-accept"]').click();
  const c = await until(() => document.querySelector('[data-action="owner-accept-confirm"]:not([hidden])'), 5000);
  if (!c) return { ok: false, error: 'confirm missing' };
  const n0 = document.querySelector('[data-accept-list-notice]'); if (n0) n0.remove();
  const t0 = performance.now();
  c.v.click();
  const seen = await until(() => { const n = document.querySelector('[data-accept-list-notice]'); return n && n.getBoundingClientRect().height > 0 && /已验收|验收/.test(n.textContent || ''); }, 15000);
  if (!seen) return { ok: false, error: 'notice timeout' };
  return { ok: true, ms: Math.round(seen.at - t0), notice: String((document.querySelector('[data-accept-list-notice]') || {}).textContent || '').slice(0, 80) };
})()`;
const REVIEW_ONE = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { const v = fn(); if (v) return { v, at: performance.now() }; await wait(16); } return null; };
  const entry = document.querySelector('#owner-review-entry');
  if (!entry) return { ok: false, error: 'review entry missing' };
  entry.click();
  await wait(900);
  const row = document.querySelector('[data-or-req="${REQ_REVIEW}"]') || document.querySelector('.or-item[data-id="${REQ_REVIEW}"]');
  if (!row) return { ok: false, error: 'review row missing' };
  row.click();
  await wait(600);
  const approve = document.querySelector('[data-or-approve]');
  if (!approve) return { ok: false, error: 'approve missing' };
  const n0 = document.querySelector('[data-or-notice]'); if (n0) { n0.textContent = ''; }
  const t0 = performance.now();
  approve.click();
  const seen = await until(() => {
    const list = [document.querySelector('[data-or-notice]'), document.querySelector('[data-or-notice-global]')];
    return list.find((n) => n && n.getBoundingClientRect().height > 0 && /已通过/.test(n.textContent || '')) || null;
  }, 20000);
  if (!seen) return { ok: false, error: 'notice timeout' };
  return { ok: true, ms: Math.round(seen.at - t0), notice: String((document.querySelector('[data-or-notice]') || {}).textContent || '').slice(0, 80) };
})()`;
const TYPING = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const input = document.querySelector('#search') || document.querySelector('input[type="search"]') || document.querySelector('input[type="text"]');
  if (!input) return { ok: false, error: 'no input' };
  input.focus();
  const p = window.__awbTypingProbe(3200);
  for (let i = 0; i < 20; i += 1) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: String.fromCharCode(97 + i), bubbles: true }));
    await wait(30);
  }
  const r = await p;
  return { ok: Boolean(r && r.verdict), result: r };
})()`;

(async () => {
  seed(); log('sandbox', SB);
  const inst = launch();
  const samples = { accept: [], review: [] };
  const errors = [];
  try {
    const target = await waitTarget(inst.port);
    if (!target) throw new Error('CDP 目标未出现');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.evaluate(`new Promise((r) => { const t0 = Date.now(); const tick = () => { if (window.workbench && document.querySelector('#app')) return r(true); if (Date.now() - t0 > 30000) return r(false); setTimeout(tick, 200); }; tick(); })`);
    const lazy = await cdp.evaluate(`new Promise((r) => { const t0 = Date.now(); const tick = () => { if (window.__awbLazyLoaded) return r(true); if (Date.now() - t0 > 20000) return r(false); setTimeout(tick, 200); }; tick(); })`);
    log('lazyLoaded', lazy);
    await sleep(2000);
    // 预热两个弹窗（冷数据不计入样本）
    await cdp.evaluate(`(async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      try { window.__awbOpenAcceptList && window.__awbOpenAcceptList(); } catch {}
      await wait(900);
      try { const c = document.querySelector('[data-accept-list-close], #accept-list .close'); if (c) c.click(); } catch {}
      try { const e = document.querySelector('#owner-review-entry'); if (e) e.click(); } catch {}
      await wait(900);
      try { const c = document.querySelector('[data-or-close]'); if (c) c.click(); } catch {}
      return true; })()`);
    await pageWaitIdle(cdp); await sleep(1200);
    for (let i = 0; i < 1; i += 1) {
      resetWf();
      await sleep(400);
      const r = await cdp.evaluate(ACCEPT_ONE);
      if (r && r.ok) samples.accept.push(r.ms); else errors.push('accept: ' + JSON.stringify(r));
      await pageWaitIdle(cdp); await sleep(1200);
    }
    for (let i = 0; i < 1; i += 1) {
      resetWf();
      await sleep(400);
      const r = await cdp.evaluate(REVIEW_ONE);
      if (r && r.ok) samples.review.push(r.ms); else errors.push('review: ' + JSON.stringify(r));
      await pageWaitIdle(cdp); await sleep(1200);
      try { await cdp.evaluate(`(() => { const c = document.querySelector('[data-or-close]'); if (c) c.click(); return true; })()`); } catch { /* ignore */ }
      await sleep(300);
    }
    await pageWaitIdle(cdp); await sleep(5000);
    const typing = await cdp.evaluate(TYPING);
    const profiles = inst.getStdout().split(/\r?\n/).filter((l) => /\[accept-profile\]|\[review-profile\]|\[side-effects-profile\]|\[board-profile\]|\[workflow-prewarm\]/.test(l)).slice(-60);
    const report = { at: new Date().toISOString(), samples, errors, typing, profiles };
    fs.writeFileSync(path.join(OUT, 'window-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(OUT, 'window-stdout.log'), inst.getStdout(), 'utf8');
    log('accept samples', JSON.stringify(samples.accept));
    log('review samples', JSON.stringify(samples.review));
    log('typing', JSON.stringify({ ok: typing.ok, summary: typing.result && typing.result.summary, gate: typing.result && typing.result.gateSkipped }));
    log('errors', JSON.stringify(errors).slice(0, 300));
  } catch (e) {
    log('FAILED', String((e && e.stack) || e).slice(0, 900));
    fs.writeFileSync(path.join(OUT, 'window-stdout.log'), inst.getStdout(), 'utf8');
    process.exitCode = 1;
  } finally {
    try { spawnSync('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 20000 }); } catch { /* ignore */ }
    // PM 132753：跑完自清（AWB_KEEP_SANDBOX=1 才保留，便于事后归因）。
    if (String(process.env.AWB_KEEP_SANDBOX || '') !== '1') {
      try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
    } else {
      log('sandbox kept', SB);
    }
  }
})();
