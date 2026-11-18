#!/usr/bin/env node
'use strict';
/**
 * test-b34a-cdp.cjs —— R-b34a R5/R6（T-20261118-182736-ac7f）真窗口 CDP 测量。
 *
 * 隔离实例（AWB_DATA_DIR + TEAM_ROOT 全指沙盘，TEAM_SELFTEST=1），用 CDP 真点击四个面板：
 *   团队台(#team-pill)、会话排队(#btn-session-queue)、需求池(#btn-pool)、评审(#owner-review-entry)
 * 每个面板记录：点击→面板可见、点击→骨架出现（[data-skeleton]）、点击→首条内容出现；另测
 *   · 团队台抽屉程序化滚动 60 帧 rAF 间隔 p95；
 *   · 需求池搜索框连续输入 20 次期间 rAF 间隔 p95；
 * 产出 JSON + 2 张截图到 AWB_B34A_CDP_OUT（默认 程序员B/产出/证据-b34a-r5r6-v2）。
 *
 * 用法：node scripts/test-b34a-cdp.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, '项目', '工作台改造修复');
const PNAME = '工作台改造修复';
const SB = path.join(ROOT, '_tmp', `b34a-cdp-${process.pid}-${Date.now()}`);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const REAL_TEAM_JSON = path.join(ROOT, '团队', '状态', '团队.json');
const PORT = Number(process.env.AWB_B34A_CDP_PORT || (9490 + (process.pid % 20)));
const OUT = process.env.AWB_B34A_CDP_OUT ? path.resolve(process.env.AWB_B34A_CDP_OUT) : path.join(PROJ, '程序员B', '产出', '证据-b34a-r5r6-v2');
const PROJECT_STATE = path.join(TEAM, '状态', '项目', PNAME);
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 400)}`);
  if (!ok) process.exitCode = 1;
}
function httpJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
  });
}
async function waitTarget(port, ms, pick) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await httpJson(`http://127.0.0.1:${port}/json/list`);
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
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      }
    });
  }
  send(method, params = {}, ms = 40000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, ms);
    });
  }
  async evaluate(expr, ms = 40000) {
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
  for (const name of ['团队宪法.md', '项目铁律.md']) {
    try { fs.copyFileSync(path.join(ROOT, '团队', name), path.join(TEAM, name)); } catch { /* 缺文档不影响面板 */ }
  }
  const team = JSON.parse(fs.readFileSync(REAL_TEAM_JSON, 'utf8').replace(/^\uFEFF/, ''));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = PNAME;
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  // 会话排队快照：六角色空闲（骨架/首帧测量不依赖真实快照）
  const roles = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'].map((role) => ({
    role, known: true, active: false, running: false, queued: 0, byPlacement: { queued: 0, steering: 0, context: 0 }, sessionId: '', pendingInput: [], lastEventAt: '', lastOkAt: '',
  }));
  fs.writeFileSync(path.join(TEAM, '状态', '会话排队.json'), JSON.stringify({ schemaVersion: 2, at: new Date().toISOString(), project: PNAME, host: 'fixture', staleMs: 60000, roles }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(PROJECT_STATE, '唤醒.jsonl'), '', 'utf8');
  // 项目面板最小项目状态（评审/池能打开；无数据时只测骨架）
  const store = JSON.parse(fs.readFileSync(REAL_STORE, 'utf8').replace(/^\uFEFF/, ''));
  const project = (store.projects || []).find((item) => item && String(item.teamName || item.name || '') === PNAME);
  if (!project) throw new Error('真实 workbench.json 缺少项目 ' + PNAME);
  project.teamName = PNAME;
  store.projects = [project];
  store.activeProjectId = project.id;
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n', 'utf8');
}
async function launch() {
  const env = { ...process.env, AWB_DATA_DIR: DATA, TEAM_ROOT: TEAM, TEAM_SELFTEST: '1' };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });
  const target = await waitTarget(PORT, 90000, (item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
  if (!target) { try { child.kill(); } catch { /* ignore */ } return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('ws 连接失败')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  for (let i = 0; i < 200; i += 1) {
    const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(document.getElementById("btn-pool")) && Boolean(window.__sqRefresh || document.getElementById("session-queue-panel"))');
    if (ready === true) break;
    await sleep(400);
  }
  const guest = await waitTarget(PORT, 6000, (item) => item && item.type === 'webview');
  if (guest) {
    try {
      const gws = new WebSocket(guest.webSocketDebuggerUrl);
      await new Promise((resolve) => { gws.addEventListener('open', resolve, { once: true }); setTimeout(resolve, 2500); });
      gws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: 'about:blank' } }));
      await sleep(500);
    } catch { /* ignore */ }
  }
  return { child, cdp, ws };
}
async function close(inst) {
  if (!inst) return;
  try { inst.cdp.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ }
  await sleep(800);
  try { inst.ws.close(); } catch { /* ignore */ }
  try { inst.child.kill(); } catch { /* ignore */ }
  await sleep(400);
  try {
    if (inst.child && inst.child.pid && inst.child.exitCode === null) spawnSync('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch { /* ignore */ }
}
async function shot(cdp, file) {
  for (let i = 0; i < 3; i += 1) {
    try {
      await cdp.send('Page.bringToFront', {}, 6000);
      const out = await cdp.send('Page.captureScreenshot', { format: 'png' }, 20000);
      if (out && out.data) {
        const buf = Buffer.from(out.data, 'base64');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
        if (buf.length > 3000) return buf.length;
      }
    } catch { /* retry */ }
    await sleep(500);
  }
  return 0;
}
/** 页面内测量：点击 → 面板可见 / 骨架出现 / 首条内容出现；返回毫秒。 */
async function measurePanel(cdp, clickSel, panelSel, contentSel, label) {
  const expr = `(async () => {
    const t0 = performance.now();
    const btn = document.querySelector(${JSON.stringify(clickSel)});
    if (!btn) return { clicked: false };
    let visibleAt = null; let skeletonAt = null; let contentAt = null;
    const seen = () => {
      const panel = document.querySelector(${JSON.stringify(panelSel)});
      if (panel && !panel.hidden && visibleAt === null) visibleAt = performance.now() - t0;
      const sk = (panel && panel.querySelector) ? panel.querySelector('[data-skeleton]') : document.querySelector('[data-skeleton]');
      if (sk && skeletonAt === null) skeletonAt = performance.now() - t0;
      const ct = document.querySelector(${JSON.stringify(contentSel)});
      if (ct && contentAt === null) contentAt = performance.now() - t0;
    };
    seen();
    btn.click();
    seen();
    for (let i = 0; i < 120; i += 1) {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 16)));
      seen();
      if (visibleAt !== null && contentAt !== null && i > 8) break;
    }
    return { clicked: true, visibleMs: visibleAt, skeletonMs: skeletonAt, contentMs: contentAt };
  })()`;
  const r = await cdp.evaluate(expr, 20000);
  check(`CDP-${label} 点击→面板可见`, Boolean(r && r.clicked), r);
  return r || {};
}
function p95Of(list) {
  if (!list.length) return null;
  const sorted = list.slice().sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] * 100) / 100;
}
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  seed();
  const inst = await launch();
  check('CDP-0 隔离实例已启动（AWB_DATA_DIR+TEAM_ROOT=沙盘）', Boolean(inst), { port: PORT });
  const cdp = inst && inst.cdp;
  const report = { at: new Date().toISOString(), port: PORT, panels: {}, scroll: null, typing: null, screenshots: [] };
  if (cdp) {
    try {
      // 1) 团队台
      const teamRes = await measurePanel(cdp, '#team-pill', '#team-drawer', '#team-drawer [data-skeleton], #team-drawer .drawer-scroll', 'team');
      report.panels.team = teamRes;
      check('CDP-① 团队台：可见 ≤200ms', teamRes.visibleMs !== null && teamRes.visibleMs <= 200, { visibleMs: teamRes.visibleMs, skeletonMs: teamRes.skeletonMs });
      // 团队台滚动帧
      const scrollFrames = await cdp.evaluate(`(async () => {
        const sc = document.querySelector('#team-drawer .drawer-scroll') || document.querySelector('#team-drawer');
        if (!sc) return null;
        const frames = [];
        let last = performance.now();
        for (let i = 0; i < 60; i += 1) {
          await new Promise((r) => requestAnimationFrame(() => { const now = performance.now(); frames.push(now - last); last = now; r(); }));
          sc.scrollTop += 24;
        }
        return frames;
      })()`, 30000);
      if (Array.isArray(scrollFrames)) {
        report.scroll = { frames: scrollFrames.length, p50Ms: p95Of(scrollFrames.map((x) => x)), p95Ms: p95Of(scrollFrames) };
        check('CDP-② 团队台滚动 60 帧：p95 帧间隔 ≤25ms', report.scroll.p95Ms !== null && report.scroll.p95Ms <= 25, report.scroll);
      } else check('CDP-② 团队台滚动采样', false, scrollFrames);
      await shot(cdp, path.join(OUT, 'cdp-01-team-drawer.png'));
      report.screenshots.push('cdp-01-team-drawer.png');
      // 2) 会话排队
      const sqRes = await measurePanel(cdp, '#btn-session-queue', '#session-queue-drawer', '#session-queue-drawer [data-sq-row], #session-queue-drawer [data-skeleton]', 'session-queue');
      report.panels.sessionQueue = sqRes;
      check('CDP-③ 会话排队：可见 ≤200ms', sqRes.visibleMs !== null && sqRes.visibleMs <= 200, { visibleMs: sqRes.visibleMs, skeletonMs: sqRes.skeletonMs });
      await shot(cdp, path.join(OUT, 'cdp-02-session-queue.png'));
      report.screenshots.push('cdp-02-session-queue.png');
      // 3) 需求池
      const poolRes = await measurePanel(cdp, '#btn-pool', '#pool-mask', '#pool-req-list', 'pool');
      report.panels.pool = poolRes;
      check('CDP-④ 需求池：可见 ≤200ms（骨架同步）', poolRes.visibleMs !== null && poolRes.visibleMs <= 200, { visibleMs: poolRes.visibleMs, skeletonMs: poolRes.skeletonMs });
      // 4) 评审
      const reviewRes = await measurePanel(cdp, '#owner-review-entry', '[data-owner-review-dialog]', '[data-owner-review-dialog] [data-or-list]', 'review');
      report.panels.review = reviewRes;
      check('CDP-⑤ 评审弹窗：可见 ≤200ms', reviewRes.visibleMs !== null && reviewRes.visibleMs <= 200, { visibleMs: reviewRes.visibleMs, skeletonMs: reviewRes.skeletonMs });
      await shot(cdp, path.join(OUT, 'cdp-03-review.png'));
      report.screenshots.push('cdp-03-review.png');
      // 5) 交互期（池搜索框连续输入）rAF
      const typingFrames = await cdp.evaluate(`(async () => {
        const input = document.querySelector('#pool-search');
        if (!input) return null;
        input.focus();
        const frames = [];
        let last = performance.now();
        for (let i = 0; i < 20; i += 1) {
          await new Promise((r) => requestAnimationFrame(() => { const now = performance.now(); frames.push(now - last); last = now; r(); }));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
          input.value = String(input.value || '') + 'a';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return frames;
      })()`, 30000);
      if (Array.isArray(typingFrames)) {
        report.typing = { frames: typingFrames.length, p95Ms: p95Of(typingFrames) };
        check('CDP-⑥ 交互期（输入 20 次）rAF p95 ≤25ms', report.typing.p95Ms !== null && report.typing.p95Ms <= 25, report.typing);
      } else check('CDP-⑥ 交互期采样', false, typingFrames);
    } catch (e) {
      check('CDP 测量未抛错', false, String((e && e.message) || e));
    }
  }
  try { fs.writeFileSync(path.join(OUT, 'cdp-r5r6.json'), JSON.stringify({ ...report, checks: results }, null, 2) + '\n', 'utf8'); } catch { /* ignore */ }
  await close(inst);
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`B34A_CDP ${failed.length ? 'FAIL' : 'OK'} ${JSON.stringify({ total: results.length, pass: results.length - failed.length, red: failed.length })}`);
  console.log('证据：' + path.join(OUT, 'cdp-r5r6.json'));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('B34A_CDP ERROR ' + String((e && e.stack) || e)); process.exit(1); });
