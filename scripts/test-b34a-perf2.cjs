#!/usr/bin/env node
'use strict';
/**
 * test-b34a-perf2.cjs —— R-b34a 性能二轮（T-20261118-195240-d7a5）渲染侧 CDP 测量。
 *
 * 隔离实例（AWB_DATA_DIR+TEAM_ROOT 沙盘）+ S2 构造态（6 会话 running + 真实 工作流.json 拷贝）：
 *   · 长任务：renderer 内 PerformanceObserver('longtask') 计数（AWBGate.observeLongTasks → window.__b34aLongTasks）；
 *   · 点击→首帧：页面内 click 后双 rAF 的耗时分布；
 *   · 对照：同一实例内先「临时关闭 clickGate」跑 burst（≈修复前），再恢复 clickGate 跑 burst（修复后），
 *     比较 p95 首帧与 longtask 数——避免把环境噪声当优化效果。
 *
 * 用法：node scripts/test-b34a-perf2.cjs [--out <dir>]
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, '项目', '工作台改造修复');
const PNAME = '工作台改造修复';
const SB = path.join(ROOT, '_tmp', `b34a-perf2-${process.pid}-${Date.now()}`);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const REAL_TEAM_JSON = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_WORKFLOW = path.join(ROOT, '团队', '状态', '项目', PNAME, '工作流.json');
const PORT = Number(process.env.AWB_B34A_PERF2_PORT || (9540 + (process.pid % 20)));
const OUT = process.env.AWB_B34A_PERF2_OUT ? path.resolve(process.env.AWB_B34A_PERF2_OUT) : path.join(PROJ, '程序员B', '产出', '证据-perf2');
const PROJECT_STATE = path.join(TEAM, '状态', '项目', PNAME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 420)}`);
}
function httpJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}
async function waitTarget(port, ms, pick) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await httpJson(`http://127.0.0.1:${port}/json/list`);
    if (Array.isArray(list)) { const hit = list.find(pick); if (hit && hit.webSocketDebuggerUrl) return hit; }
    await sleep(400);
  }
  return null;
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); }
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
  async evaluate(expr, ms = 60000) {
    try {
      const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, ms);
      if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || '') };
      return out && out.result ? out.result.value : undefined;
    } catch (e) { return { __cdperror: String((e && e.message) || e) }; }
  }
}
function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(PROJECT_STATE, { recursive: true });
  for (const name of ['团队宪法.md', '项目铁律.md']) { try { fs.copyFileSync(path.join(ROOT, '团队', name), path.join(TEAM, name)); } catch { /* ignore */ } }
  const team = JSON.parse(fs.readFileSync(REAL_TEAM_JSON, 'utf8').replace(/^\uFEFF/, ''));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = PNAME;
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  // S2 构造态：6 会话 running
  const roles = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'].map((role) => ({
    role, known: true, active: true, running: true, queued: 0, byPlacement: { queued: 0, steering: 0, context: 0 },
    sessionId: '', pendingInput: [], lastEventAt: new Date().toISOString(), lastOkAt: new Date().toISOString(), runningSince: new Date(Date.now() - 60000).toISOString(),
  }));
  fs.writeFileSync(path.join(TEAM, '状态', '会话排队.json'), JSON.stringify({ schemaVersion: 2, at: new Date().toISOString(), project: PNAME, host: 'fixture', staleMs: 60000, roles }, null, 2) + '\n', 'utf8');
  const wakeRows = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'].map((to, i) => ({ at: new Date(Date.now() - i * 60000).toISOString(), to, ok: true }));
  fs.writeFileSync(path.join(PROJECT_STATE, '唤醒.jsonl'), wakeRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  // 真实工作流拷贝（评审/池/流程有大列表，贴近 S2）
  try { fs.copyFileSync(REAL_WORKFLOW, path.join(PROJECT_STATE, '工作流.json')); } catch { /* 缺工作流则轻量 */ }
  const store = JSON.parse(fs.readFileSync(REAL_STORE, 'utf8').replace(/^\uFEFF/, ''));
  const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PNAME);
  if (!project) throw new Error('workbench 缺项目');
  store.projects = [project];
  store.activeProjectId = project.id;
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.mkdirSync(OUT, { recursive: true });
  return { workflowBytes: fs.existsSync(path.join(PROJECT_STATE, '工作流.json')) ? fs.statSync(path.join(PROJECT_STATE, '工作流.json')).size : 0 };
}
async function launch() {
  const env = { ...process.env, AWB_DATA_DIR: DATA, TEAM_ROOT: TEAM, TEAM_SELFTEST: '1' };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });
  const target = await waitTarget(PORT, 90000, (item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
  if (!target) { try { child.kill(); } catch { /* ignore */ } return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('ws fail')), { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  for (let i = 0; i < 200; i += 1) {
    const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(window.AWBGate) && Boolean(document.getElementById("owner-review-entry"))');
    if (ready === true) break;
    await sleep(400);
  }
  const guest = await waitTarget(PORT, 6000, (item) => item && item.type === 'webview');
  if (guest) {
    try {
      const gws = new WebSocket(guest.webSocketDebuggerUrl);
      await new Promise((resolve) => { gws.addEventListener('open', resolve, { once: true }); setTimeout(resolve, 2000); });
      gws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: 'about:blank' } }));
      await sleep(400);
    } catch { /* ignore */ }
  }
  return { child, cdp, ws };
}
async function close(inst) {
  if (!inst) return;
  try { inst.cdp.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ }
  await sleep(700);
  try { inst.ws.close(); } catch { /* ignore */ }
  try { inst.child.kill(); } catch { /* ignore */ }
  await sleep(300);
  try { if (inst.child && inst.child.pid && inst.child.exitCode === null) spawnSync('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
}
const BURST = (selExpr, count, gap) => `(async () => {
  const probe = window.__b34aLongTasks || { count: 0, maxMs: 0, recent: [] };
  const gateObj = window.AWBGate || {};
  const stats = gateObj.stats || {};
  const before = { count: probe.count || 0, maxMs: probe.maxMs || 0, skippedInteraction: stats.skippedInteraction || 0, gatedCalls: stats.gatedCalls || 0 };
  const t0 = performance.now();
  const lat = [];
  for (let i = 0; i < ${count}; i += 1) {
    const el = document.querySelector(${JSON.stringify(selExpr)});
    if (!el) break;
    const a = performance.now();
    try { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })); } catch { /* 交互态靠 pointerdown 触发 */ }
    try { el.click(); } catch { /* ignore */ }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    lat.push(performance.now() - a);
    if (${gap} > 0) await new Promise((r) => setTimeout(r, ${gap}));
  }
  const elapsed = performance.now() - t0;
  return { lat, elapsedMs: Math.round(elapsed), longTasksBefore: before.count, longTasksMaxBefore: before.maxMs, longTasksAfter: (probe.count || 0), longTasksMaxAfter: probe.maxMs || 0, supported: probe.supported, skippedInteractionBefore: before.skippedInteraction, skippedInteractionAfter: (window.AWBGate && window.AWBGate.stats ? window.AWBGate.stats.skippedInteraction || 0 : 0), gatedCallsAfter: (window.AWBGate && window.AWBGate.stats ? window.AWBGate.stats.gatedCalls || 0 : 0) };
})()`;
function p95(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const s = list.slice().sort((a, b) => a - b);
  return Math.round(s[Math.max(0, Math.ceil(0.95 * s.length) - 1)] * 10) / 10;
}
(async () => {
  const seedInfo = seed();
  const inst = await launch();
  check('PERF2-0 隔离实例启动（S2 构造态 + 真实 工作流.json）', Boolean(inst), { workflowBytes: seedInfo.workflowBytes, port: PORT });
  const report = { at: new Date().toISOString(), seed: seedInfo, port: PORT, before: null, after: null, gate: null };
  if (inst) {
    try {
      const support = await inst.cdp.evaluate('window.__b34aLongTasks ? {supported: window.__b34aLongTasks.supported} : null');
      check('PERF2-1 longtask 观测可用（PerformanceObserver）', Boolean(support && support.supported), support);
      // Phase A：临时关闭 clickGate（≈修复前），同一入口快速 burst 15 次（60ms 间隔）
      const gateState = await inst.cdp.evaluate(`(() => {
        const api = window.AWBGate || {};
        window.__origClickGate = api.clickGate;
        api.clickGate = () => true; // 模拟修复前：无点击抖动门
        if (window.__b34aLongTasks) { window.__b34aLongTasks.count = 0; window.__b34aLongTasks.maxMs = 0; window.__b34aLongTasks.recent = []; }
        return { patched: true };
      })()`);
      report.gate = gateState;
      report.before = await inst.cdp.evaluate(BURST('#owner-review-entry', 15, 60), 120000);
      check('PERF2-2 修复前 burst 采集完成', Boolean(report.before && Array.isArray(report.before.lat) && report.before.lat.length), { before: report.before && (report.before.lat ? report.before.lat.length : report.before) });
      // Phase B：恢复 clickGate（修复后），burst 同条件
      await inst.cdp.evaluate(`(() => {
        const api = window.AWBGate || {};
        api.clickGate = window.__origClickGate;
        if (window.__b34aLongTasks) { window.__b34aLongTasks.count = 0; window.__b34aLongTasks.maxMs = 0; window.__b34aLongTasks.recent = []; }
        return true;
      })()`);
      report.after = await inst.cdp.evaluate(BURST('#owner-review-entry', 15, 60), 120000);
      check('PERF2-3 修复后 burst 采集完成', Boolean(report.after && Array.isArray(report.after.lat) && report.after.lat.length), { after: report.after && (report.after.lat ? report.after.lat.length : report.after) });
      const beforeP95 = p95(report.before && report.before.lat);
      const afterP95 = p95(report.after && report.after.lat);
      const beforeLT = report.before ? Math.round(((report.before.longTasksAfter - report.before.longTasksBefore) / Math.max(1, report.before.elapsedMs)) * 60000 * 10) / 10 : null;
      const afterLT = report.after ? Math.round(((report.after.longTasksAfter - report.after.longTasksBefore) / Math.max(1, report.after.elapsedMs)) * 60000 * 10) / 10 : null;
      report.compare = { beforeP95: beforeP95, afterP95: afterP95, beforeLongTasksPerMin: beforeLT, afterLongTasksPerMin: afterLT, beforeMaxLongTask: report.before && report.before.longTasksMaxAfter, afterMaxLongTask: report.after && report.after.longTasksMaxAfter };
      check('PERF2-4 修复后点击→首帧 p95 下降', beforeP95 !== null && afterP95 !== null && afterP95 <= beforeP95, report.compare);
      check('PERF2-5 修复后 longtask 次数下降（至多不升高）', beforeLT !== null && afterLT !== null && afterLT <= beforeLT, report.compare);
      check('PERF2-6 A3 目标：修复后点击首帧 p95 ≤100ms', afterP95 !== null && afterP95 <= 100, { afterP95 });
      check('PERF2-7 A9 目标：单次 longtask 无 >1000ms', report.after && Number(report.after.longTasksMaxAfter || 0) <= 1000, { afterMaxLongTask: report.after && report.after.longTasksMaxAfter });
      // PERF2-8：交互/可见性门在连续点击下不退化为直通——真实 pointerdown 连点 3.5s（30 次 ×100ms），
      // 期间 1s 级 tick 应被交互门跳过（skippedInteraction 增长），而不是退化为直通继续跑。
      const gateProbe = await inst.cdp.evaluate(`(async () => {
        const g = window.AWBGate || {};
        const s = g.stats || {};
        const before = { skippedInteraction: s.skippedInteraction || 0, gatedCalls: s.gatedCalls || 0, clickDropped: s.clickDropped || 0 };
        const el = document.querySelector('#flow-launcher');
        for (let i = 0; i < 30; i += 1) {
          if (el) { try { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })); } catch { /* ignore */ } }
          await new Promise((r) => setTimeout(r, 100));
        }
        return { before, after: { skippedInteraction: s.skippedInteraction || 0, gatedCalls: s.gatedCalls || 0, clickDropped: s.clickDropped || 0 } };
      })()`, 30000);
      report.gateStats = gateProbe;
      check('PERF2-8 连续点击下交互门未退化（3.5s 连点时 skippedInteraction 增长，未退化成直通）',
        Boolean(gateProbe && gateProbe.after && Number(gateProbe.after.skippedInteraction) > Number(gateProbe.before.skippedInteraction)), gateProbe);
    } catch (e) {
      check('PERF2 测量未抛错', false, String((e && e.message) || e));
    }
  }
  try { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'run-perf2.json'), JSON.stringify({ ...report, checks: results }, null, 2) + '\n', 'utf8'); } catch { /* ignore */ }
  await close(inst);
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nB34A_PERF2 ${failed.length ? 'FAIL' : 'OK'} ` + JSON.stringify({ total: results.length, pass: results.length - failed.length, red: failed.length }));
  console.log('证据：' + path.join(OUT, 'run-perf2.json'));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('PERF2 ERROR ' + String((e && e.stack) || e)); process.exit(1); });
