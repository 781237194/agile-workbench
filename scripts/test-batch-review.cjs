#!/usr/bin/env node
'use strict';
/**
 * B-20261115-111229-3065（P0）批量评审区缺陷回归——沙盘 + 真窗口 CDP。
 *
 * 覆盖 AC1–AC6：
 *   AC1 批量区只列 ownerReview=pending|rejected 且需求行 status=owner_review；
 *       status=ready（已批准待派单）/开发/测试一律不进（真实 4657、9a8e 两条 approved 不再被误列）。
 *   AC2 已决定/已离开 Owner 门的行：通过/打回/跳过按钮 disabled + 人话原因（含来源与阶段）。
 *   AC3 批量提交显示「成功 N 条 / 失败 M 条 + 每条失败原因」，失败条目零写入。
 *   AC4 批量行与「全部需求」行同一套 token/间距/行高（计算样式比对）。
 *   AC5 每条显示状态徽标（已通过/待派单/已派单/开发中）+ ownerReview 来源（PM 代记/本人/来源未记）。
 *   AC6 夹具：1 条 owner_review+pending + 1 条 ready+approved(PM 代记) → 批量区只含 pending，
 *       ready 行按钮 disabled 且带原因；截图落盘。
 *
 * 隔离（三重）：AWB_DATA_DIR + TEAM_ROOT(+TEAM_PROJECTS_ROOT) + TEAM_WORKBENCH_JSON 全指 _tmp/b3065；
 *   真实 data/userdata 与 团队/状态 只读，脚本前后比对哈希/尺寸并断言夹具没有落到真实工作流。
 * 沙盘：复制真实 团队/（跳过 锁/邮箱），清空 状态/启动/*.json、members[].sessionId、activeProject；
 *   沙盘内 team.mjs boot pm（令牌来自团队工具，不自签）。
 * 端口：9437（独立实例，不碰 Owner 正在用的窗口）。
 *
 * 用法：node scripts/test-batch-review.cjs
 * 退出码：0=全绿，1=有红/致命；沙盘自动清理，证据留在 项目/工作台改造修复/程序员A/产出/证据-3065/。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TEAM_TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const REAL_TEAM = path.join(ROOT, '团队');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const REAL_STATE_DIR = path.join(REAL_TEAM, '状态', '项目', '工作台改造修复');
const PROJECT = '工作台改造修复';
const BASE = path.join(ROOT, '_tmp', 'b3065');
const SB = BASE;
const EVID = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-3065');
const PORT = 9437;

const PENDING = 'R-20261115-999901-batch';
const READY = 'R-20261115-999902-batch';
const DEV = 'R-20261115-999903-batch';
const PENDING2 = 'R-20261115-999904-batch';

const results = [];
const log = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 900)}`;
  log.push(line);
  console.log(line);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; }
}
function statStamp(file) { try { const s = fs.statSync(file); return `${s.size}:${s.mtimeMs}`; } catch { return 'missing'; } }
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function getJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.setTimeout(1500, () => { req.destroy(); resolve(null); });
  });
}
async function waitTarget(port, ms, pick) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`);
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
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
        return;
      }
      if (m.method) this.events.push(m);
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
      if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text).slice(0, 500) };
      return out && out.result ? out.result.value : undefined;
    } catch (e) { return { __cdperror: String((e && e.message) || e) }; }
  }
  exceptions() {
    return this.events.filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => String((e.params.exceptionDetails && (e.params.exceptionDetails.text || (e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description))) || '').slice(0, 300))
      .filter((t) => t && !/DevTools|Autofill/i.test(t));
  }
}

function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name); const d = path.join(dst, ent.name);
    if (filter && filter(s, ent)) continue;
    if (ent.isDirectory()) copyDir(s, d, filter);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

const stateDir = () => path.join(SB, '团队', '状态', '项目', PROJECT);
const wfFile = () => path.join(stateDir(), '工作流.json');
const projectDir = () => path.join(SB, '项目', PROJECT);

function findProject(store) {
  const rows = Array.isArray(store && store.projects) ? store.projects : [];
  return rows.find((p) => p && (p.name === PROJECT || p.teamName === PROJECT)) || null;
}

function seedSandbox() {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(path.join(SB, 'data', 'userdata'), { recursive: true });
  const store = readJson(REAL_STORE);
  const real = findProject(store);
  if (!real) throw new Error(`真实 store 里没有项目 ${PROJECT}`);
  // 项目目录也指向沙盘：owner:decide 会跑 team.mjs index 重建 项目索引，绝不能扫/写真实项目目录
  // （真实项目 34 万文件，扫描慢且会改真实文件）。沙盘只放评审需要的几份小文档。
  fs.mkdirSync(path.join(projectDir(), '需求'), { recursive: true });
  for (const rel of ['项目信息.md', '项目铁律.md', '协作准则.md', '团队会话.md',
    '需求/00-需求总览.md', '需求/需求模板.md', '需求/README.md', '需求/文件索引.md']) {
    const src = path.join(ROOT, '项目', PROJECT, rel);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(path.join(projectDir(), rel)), { recursive: true });
      fs.copyFileSync(src, path.join(projectDir(), rel));
    }
  }
  real.path = projectDir();
  store.projects = [real]; store.activeProjectId = real.id;
  fs.writeFileSync(path.join(SB, 'data', 'userdata', 'workbench.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
  // 锁/邮箱不复制：沙盘不 wake、不投递（B-3c03），其余团队状态照搬以保留真实 4657/9a8e 回归样本。
  copyDir(REAL_TEAM, path.join(SB, '团队'), (s) => /[\\/]锁([\\/]|$)/.test(s) || /[\\/]邮箱[\\/]/.test(s));
  const teamFile = path.join(SB, '团队', '状态', '团队.json');
  const team = readJson(teamFile) || { members: [] };
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = '';
  fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
  const startDir = path.join(SB, '团队', '状态', '启动');
  if (fs.existsSync(startDir)) for (const f of fs.readdirSync(startDir)) if (f.endsWith('.json')) fs.rmSync(path.join(startDir, f), { force: true });
  // 代管记录清零：避免真实文件里的未结束记录影响「哪条走 ui / 哪条走 proxy」。
  fs.writeFileSync(path.join(stateDir(), '评审代管.json'), JSON.stringify({ records: [], updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
}

function at(iso) { return String(iso || new Date().toISOString()); }

function requirementRow(id, title, status, ownerReview, decisions) {
  const now = at('2026-11-15T06:00:00.000Z');
  return {
    id, title, status, priority: 'P0', queued: false, round: 1, createdBy: 'pm',
    createdAt: now, updatedAt: now, deliveryRound: 1,
    ownerReview: ownerReview || null,
    decisions: Array.isArray(decisions) ? decisions : [],
    detail: title,
  };
}

function batchFixture() {
  const wf = readJson(wfFile());
  if (!wf) throw new Error('沙盘 工作流.json 不存在');
  wf.requirements = wf.requirements || {};
  wf.requirements[PENDING] = requirementRow(PENDING, '夹具：待 Owner 评审（pending）', 'owner_review',
    { status: 'pending', at: null, opinion: '' }, []);
  wf.requirements[READY] = requirementRow(READY, '夹具：已通过待派单（PM 代记）', 'ready',
    { status: 'approved', channel: 'proxy', recordedBy: 'pm', actor: 'pm', decidedBy: 'owner', by: 'PM（代记 Owner 的决定）', at: '2026-11-15T06:10:00.000Z', opinion: '夹具：PM 代记通过' },
    [{ status: 'approved', decision: 'approved', channel: 'proxy', recordedBy: 'pm', at: '2026-11-15T06:10:00.000Z', round: 1, opinion: '夹具：PM 代记通过' }]);
  wf.requirements[DEV] = requirementRow(DEV, '夹具：开发中（Owner 本人通过）', 'dev',
    { status: 'approved', channel: 'ui', actor: 'owner', decidedBy: 'owner', by: 'Owner', at: '2026-11-15T06:12:00.000Z', opinion: '' },
    [{ status: 'approved', decision: 'approved', channel: 'ui', at: '2026-11-15T06:12:00.000Z', round: 1, opinion: '' }]);
  fs.writeFileSync(wfFile(), JSON.stringify(wf, null, 2) + '\n', 'utf8');
  return wf;
}

function addPending2AndProxy() {
  const wf = readJson(wfFile());
  wf.requirements = wf.requirements || {};
  wf.requirements[PENDING2] = requirementRow(PENDING2, '夹具：待评审 + 失败注入（代理缺授权）', 'owner_review',
    { status: 'pending', at: null, opinion: '' }, []);
  fs.writeFileSync(wfFile(), JSON.stringify(wf, null, 2) + '\n', 'utf8');
  const now = new Date().toISOString();
  // 真实后端失败注入：该条有未结束代管但 authorization 为空 → owner:decide 必回 PROXY_UNAUTHORIZED，零写入。
  fs.writeFileSync(path.join(stateDir(), '评审代管.json'), JSON.stringify({
    records: [{
      requirementId: PENDING2, scope: 'once', startedAt: now, updatedAt: now,
      startedBy: 'owner', authorization: '', recordedBy: 'pm', endedAt: null, endedBy: null,
    }],
    updatedAt: now,
  }, null, 2) + '\n', 'utf8');
}

function toolEnv() {
  return {
    ...process.env,
    TEAM_ROOT: path.join(SB, '团队'),
    TEAM_PROJECTS_ROOT: path.join(SB, '团队', '状态', '项目'),
    TEAM_WORKBENCH_JSON: path.join(SB, 'data', 'userdata', 'workbench.json'),
    TEAM_SELFTEST: '1',
  };
}
function runTool(args, env) {
  const out = spawnSync(process.execPath, [TEAM_TOOL, ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true, env });
  const text = String(out.stdout || '');
  let json = null;
  for (let i = text.lastIndexOf('{'); i >= 0; i = text.lastIndexOf('{', i - 1)) { try { json = JSON.parse(text.slice(i)); break; } catch { /* 继续往前找 JSON 起点 */ } }
  return { code: out.status, json, stderr: String(out.stderr || '').slice(0, 400) };
}
function bootPm(session) {
  const r = runTool(['boot', '--role', 'pm', '--project', PROJECT, '--session', session, '--json'], toolEnv());
  return { code: r.code, token: r.json && r.json.token ? String(r.json.token) : '', stderr: r.stderr };
}
function launchEnv() { return { ...toolEnv(), AWB_DATA_DIR: path.join(SB, 'data') }; }

async function launchElectron(port) {
  const elecLog = [];
  // 截图兜底：不要让窗口因被遮挡进入 backgrounding（否则 Page.captureScreenshot 会恒超时；
  // 真实 PM工作台窗口在前台时踩过这个坑，和 --disable-gpu 那个坑不是一回事）。
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + port,
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], {
    cwd: ROOT, env: launchEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
  });
  child.stdout.on('data', (buf) => elecLog.push('[out] ' + String(buf).slice(0, 4000)));
  child.stderr.on('data', (buf) => elecLog.push('[err] ' + String(buf).slice(0, 4000)));
  const target = await waitTarget(port, 60000, (x) => x && x.type === 'page' && String(x.url || '').includes('renderer/index.html'));
  if (!target) { try { child.kill(); } catch { /* */ } return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true }); });
  const cdp = new Cdp(ws);
  cdp.debugPort = port;
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  for (let i = 0; i < 120; i += 1) {
    const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(document.getElementById("btn-board"))');
    if (ready === true) break;
    await sleep(500);
  }
  // 壳内 webview 加载真实 DSH 页面；导航到 about:blank，否则截图黑底/挂住（只影响本隔离实例）。
  const guest = await waitTarget(port, 5000, (x) => x && x.type === 'webview');
  if (guest) {
    try {
      const gws = new WebSocket(guest.webSocketDebuggerUrl);
      await new Promise((res) => { gws.addEventListener('open', res, { once: true }); setTimeout(res, 3000); });
      gws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: 'about:blank' } }));
      await sleep(600);
      // 截图前再导航一次：壳内 webview 加载真实页面时一重绘，Page.captureScreenshot 会挂住/黑底。
      cdp.guestWs = gws;
    } catch { /* webview 关掉也不影响断言 */ }
  }
  return { child, cdp, ws, elecLog };
}
async function closeElectron(inst) {
  if (!inst) return;
  try { await inst.cdp.send('Browser.close', {}, 5000); } catch { /* */ }
  try { inst.child.kill(); } catch { /* */ }
  await sleep(1200);
}

async function realClick(cdp, selector) {
  const geo = await cdp.evaluate(`(function(){
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { missing: true };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    const hit = (r.width > 0 && r.height > 0) ? document.elementFromPoint(x, y) : null;
    return { x, y, w: Math.round(r.width), h: Math.round(r.height), hitIsTarget: Boolean(hit && (hit === el || el.contains(hit))), disabled: Boolean(el.disabled) };
  })()`);
  if (!geo || geo.missing) return { mode: 'missing', geo };
  if (geo.w > 0 && geo.h > 0 && geo.hitIsTarget) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.x, y: geo.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });
    return { mode: 'mouse', geo, x: geo.x, y: geo.y };
  }
  await cdp.evaluate(`(function(){ const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return true; })()`);
  return { mode: 'element', geo, reason: geo.w === 0 ? 'rect=0（不可见）' : 'elementFromPoint 未命中' };
}

async function shot(cdp, file, clip) {
  try { await cdp.send('Page.bringToFront', {}, 8000); } catch { /* */ }
  try { await cdp.evaluate('new Promise((r) => requestAnimationFrame(() => setTimeout(() => r(1), 120)))', 5000); } catch { /* */ }
  const size = await cdp.evaluate('(function(){ return { w: Math.max(1, Number(window.innerWidth) || 1280), h: Math.max(1, Number(window.innerHeight) || 800) }; })()') || { w: 1280, h: 800 };
  try { await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false }, 8000); } catch { /* */ }
  let lastErr = '';
  try {
    for (let i = 0; i < 4; i += 1) {
      try {
        const params = { format: 'png', fromSurface: true, captureBeyondViewport: false };
        if (clip && clip.width > 1 && clip.height > 1) params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 };
        const r = await cdp.send('Page.captureScreenshot', params, 20000);
        if (r && r.data) {
          const buf = Buffer.from(r.data, 'base64');
          fs.writeFileSync(file, buf);
          return { ok: true, tries: i + 1, bytes: buf.length, file: path.basename(file) };
        }
        lastErr = '返回没有 data：' + JSON.stringify(r || {}).slice(0, 120);
      } catch (e) { lastErr = String((e && e.message) || e); }
      await sleep(800);
    }
  } finally {
    try { await cdp.send('Emulation.clearDeviceMetricsOverride', {}, 5000); } catch { /* */ }
  }
  log.push(`截图失败 ${path.basename(file)}：${lastErr}`);
  return { ok: false, error: lastErr, file: path.basename(file) };
}

async function openReviewDialog(cdp) {
  const open = await cdp.evaluate(`(function(){ const d = document.querySelector('[data-owner-review-dialog]'); return Boolean(d && !d.hidden); })()`);
  if (open === true) return { opened: 'already', mode: 'already' };
  const click = await realClick(cdp, '#owner-review-entry');
  for (let i = 0; i < 30; i += 1) {
    const nowOpen = await cdp.evaluate(`(function(){ const d = document.querySelector('[data-owner-review-dialog]'); return Boolean(d && !d.hidden); })()`);
    if (nowOpen === true) return { opened: 'clicked', mode: click.mode };
    await sleep(400);
  }
  await cdp.evaluate('(function(){ const b = document.getElementById("owner-review-entry"); if (b) b.click(); return true; })()');
  await sleep(1200);
  const fallback = await cdp.evaluate(`(function(){ const d = document.querySelector('[data-owner-review-dialog]'); return Boolean(d && !d.hidden); })()`);
  return { opened: fallback ? 'fallback' : 'failed', mode: click.mode };
}

/** 批量区（只读 DOM）：行 id/徽标/来源/按钮态/结果条。 */
async function readBatch(cdp) {
  return cdp.evaluate(`(function(){
    const box = document.querySelector('[data-owner-batch]');
    if (!box) return { exists: false };
    const rows = [...box.querySelectorAll('[data-owner-batch-item], .rv-batch-item[data-req-id]')].map((n) => {
      const approve = n.querySelector('[data-action="batch-approve"]');
      const reject = n.querySelector('[data-action="batch-reject"]');
      const check = n.querySelector('[data-batch-check]');
      return {
        id: n.getAttribute('data-req-id'),
        badge: n.getAttribute('data-batch-status'),
        source: n.getAttribute('data-batch-source'),
        approveDisabled: approve ? Boolean(approve.disabled) : null,
        rejectDisabled: reject ? Boolean(reject.disabled) : null,
        checkDisabled: check ? Boolean(check.disabled) : null,
        lockReason: (n.querySelector('[data-batch-lock-reason]') || {}).textContent || '',
        text: String(n.innerText || '').replace(/\\s+/g, ' ').slice(0, 300),
      };
    });
    const result = box.querySelector('[data-batch-result]');
    const submit = box.querySelector('[data-action="batch-approve-selected"]');
    return {
      exists: true,
      count: rows.length,
      rows,
      submitDisabled: submit ? Boolean(submit.disabled) : null,
      submitText: submit ? String(submit.textContent || '') : '',
      result: result ? {
        ok: Number(result.getAttribute('data-batch-success')),
        fail: Number(result.getAttribute('data-batch-fail')),
        text: String(result.innerText || '').replace(/\\s+/g, ' ').slice(0, 600),
      } : null,
      boxText: String(box.innerText || '').replace(/\\s+/g, ' ').slice(0, 400),
    };
  })()`);
}

/** 「全部需求」行（只读 DOM）：状态徽标 + 来源。 */
async function readAllRows(cdp) {
  return cdp.evaluate(`(function(){
    return [...document.querySelectorAll('[data-owner-all-item]')].map((n) => ({
      id: n.getAttribute('data-or-req'),
      status: n.getAttribute('data-or-status'),
      badge: (n.querySelector('[data-or-status-badge]') || {}).textContent || '',
      source: (n.querySelector('[data-or-source-badge]') || {}).textContent || '',
    }));
  })()`);
}

/** 右侧详情：锁定原因 + 三个决定按钮状态。 */
async function readDetail(cdp) {
  return cdp.evaluate(`(function(){
    const dialog = document.querySelector('[data-owner-review-dialog]');
    const box = dialog && dialog.querySelector('[data-or-summary-box]');
    const pick = (sel) => dialog ? dialog.querySelector(sel) : null;
    const info = (sel) => { const b = pick(sel); return b ? { disabled: Boolean(b.disabled), title: String(b.title || ''), decided: b.getAttribute('data-or-decided') } : null; };
    const lock = pick('[data-or-lock-reason]');
    return {
      selectedId: box ? box.getAttribute('data-or-selected-id') : '',
      ok: info('[data-or-approve]'),
      reject: info('[data-or-reject]'),
      skip: info('[data-or-skip-submit]'),
      lockHidden: lock ? Boolean(lock.hidden) : null,
      lockText: lock ? String(lock.textContent || '').replace(/\\s+/g, ' ').slice(0, 300) : '',
      lockCode: lock ? lock.getAttribute('data-or-lock-code') : '',
      summaryText: box ? String(box.innerText || '').replace(/\\s+/g, ' ').slice(0, 300) : '',
    };
  })()`);
}

/** AC4：批量行与「全部需求」行的 token/间距/行高计算样式比对。 */
async function readStyleTokens(cdp, readyId) {
  return cdp.evaluate(`(function(){
    const batch = document.querySelector('[data-owner-batch] [data-owner-batch-item]');
    const allRow = document.querySelector('[data-owner-all-item][data-or-req="' + ${JSON.stringify(readyId)} + '"]');
    if (!batch || !allRow) return { missing: true };
    const pick = (root, sel) => root.querySelector(sel);
    const cs = (el) => getComputedStyle(el);
    const b = cs(batch);
    const row = cs(allRow);
    const head = pick(allRow, '.or-all-head');
    const headB = pick(allRow, '.or-all-head b');
    const allV = pick(allRow, '.or-all-v');
    const bt = pick(batch, '.rv-batch-title');
    const bl = pick(batch, '.rv-batch-line');
    return {
      batchBg: b.backgroundColor, rowBg: row.backgroundColor,
      batchRadius: b.borderRadius, rowRadius: row.borderRadius,
      batchPadding: [b.paddingTop, b.paddingRight, b.paddingBottom, b.paddingLeft].join(' '),
      headPadding: head ? [cs(head).paddingTop, cs(head).paddingRight, cs(head).paddingBottom, cs(head).paddingLeft].join(' ') : '',
      batchTitleFont: bt ? cs(bt).fontSize : '', headTitleFont: headB ? cs(headB).fontSize : '',
      batchLineFont: bl ? cs(bl).fontSize : '', allLineFont: allV ? cs(allV).fontSize : '',
      batchBorder: b.borderColor, rowBorder: row.borderColor,
    };
  })()`);
}

function workflow() { return readJson(wfFile()) || {}; }
function reqRow(id) {
  const wf = workflow();
  return (wf.requirements || {})[id] || null;
}
function rowSnapshot(id) {
  const row = reqRow(id);
  if (!row) return null;
  return {
    status: String(row.status || ''),
    ownerReview: row.ownerReview || null,
    decisions: Array.isArray(row.decisions) ? row.decisions : [],
  };
}

async function openReadyDetail(cdp) {
  const click = await realClick(cdp, `[data-owner-all-item][data-or-req="${READY}"] [data-owner-all-toggle]`);
  await sleep(1500);
  return click;
}
async function closeReadyDetail(cdp) {
  // 只读清理：再点一次同一行收回详情，避免影响后续截图（点不到也不影响断言）。
  await cdp.evaluate(`(function(){
    const row = document.querySelector('[data-owner-all-item][data-or-req="${READY}"]');
    const head = row && row.querySelector('[data-owner-all-toggle]');
    if (head) head.click();
    return true;
  })()`);
  await sleep(600);
}

(async () => {
  fs.mkdirSync(EVID, { recursive: true });
  const realGuards = {
    store: statStamp(REAL_STORE),
    storeHash: sha256File(REAL_STORE),
    team: sha256File(path.join(REAL_TEAM, '状态', '团队.json')),
    workflow: sha256File(path.join(REAL_STATE_DIR, '工作流.json')),
  };
  const triggers = {};
  const shots = [];
  const electronLogs = [];

  try {
    // ---------- 沙盘 ----------
    seedSandbox();
    const startDir = path.join(SB, '团队', '状态', '启动');
    const startEmpty = fs.existsSync(startDir) ? fs.readdirSync(startDir).filter((f) => f.endsWith('.json')).length : 0;
    const team = readJson(path.join(SB, '团队', '状态', '团队.json')) || {};
    const membersCleared = (team.members || []).every((m) => !m.sessionId) && !team.activeProject;
    const sandboxStore = readJson(path.join(SB, 'data', 'userdata', 'workbench.json')) || {};
    const projectPathInSandbox = Boolean(sandboxStore.projects && sandboxStore.projects[0] && String(sandboxStore.projects[0].path || '').startsWith(SB));
    check('S0 沙盘就绪（团队副本 / members.sessionId 全清 / 状态/启动 令牌清空 / store 只留本项目且项目目录指向沙盘）',
      startEmpty === 0 && membersCleared && sandboxStore.projects && sandboxStore.projects.length === 1 && projectPathInSandbox,
      { startTokens: startEmpty, membersCleared, projects: (sandboxStore.projects || []).length, projectPathInSandbox });

    const boot = bootPm('s-3065-batch-1');
    check('S1 沙盘内 team.mjs boot pm 成功（令牌来自团队工具，不自签）', boot.code === 0 && Boolean(boot.token), { code: boot.code, token: Boolean(boot.token) });

    const wfBefore = batchFixture();
    const ids = Object.keys(wfBefore.requirements || {});
    const real4657 = ids.find((id) => /-4657$/.test(id)) || '';
    const real9a8e = ids.find((id) => /-9a8e$/.test(id)) || '';
    check('S2 夹具写入 3 条（pending / ready+PM 代记 / dev+本人），真实 4657 与 9a8e 仍在沙盘（回归误列样本）',
      Boolean(reqRow(PENDING)) && Boolean(reqRow(READY)) && Boolean(reqRow(DEV)) && Boolean(real4657) && Boolean(real9a8e),
      { pending: reqRow(PENDING) && reqRow(PENDING).status, ready: reqRow(READY) && reqRow(READY).status, dev: reqRow(DEV) && reqRow(DEV).status, real4657, real9a8e });

    // ---------- 第一实例：AC1/AC2/AC4/AC5/AC6 ----------
    let inst = await launchElectron(PORT);
    try {
      if (!inst) { check('E0 第一实例启动', false); throw new Error('第一实例未起来'); }
      const opened = await openReviewDialog(inst.cdp);
      triggers.openDialog = opened.mode;
      check('E0 「我的评审」弹窗打开（真实入口 #owner-review-entry）', opened.opened !== 'failed', opened);
      if (opened.opened === 'failed') throw new Error('评审弹窗未打开');

      const batch1 = await readBatch(inst.cdp);
      check('A1 批量区存在且只列 1 条待审（AC1 夹具：1 pending + 1 ready）',
        Boolean(batch1 && batch1.exists && batch1.count === 1), { count: batch1 && batch1.count, rows: batch1 && batch1.rows });
      check('A2 批量区唯一那条 = pending 夹具（owner_review + ownerReview=pending）',
        Boolean(batch1 && batch1.rows && batch1.rows[0] && batch1.rows[0].id === PENDING), { rows: batch1 && batch1.rows });
      check('A3 ready 夹具（status=ready + ownerReview=approved）不在批量区（AC1 修复点）',
        Boolean(batch1 && batch1.exists) && !(batch1.rows || []).some((r) => r.id === READY), { ids: (batch1.rows || []).map((r) => r.id) });
      check('A4 真实 4657 / 9a8e 两条已 approved 的需求不再被误列（AC1 回归）',
        Boolean(batch1 && batch1.exists) && !(batch1.rows || []).some((r) => r.id === real4657 || r.id === real9a8e),
        { ids: (batch1.rows || []).map((r) => r.id), real4657, real9a8e });
      const pendingRow = batch1 && (batch1.rows || []).find((r) => r.id === PENDING);
      check('A5 批量行显示状态徽标 + 来源（pending → 等你决定 / 来源未记，AC5）',
        Boolean(pendingRow) && pendingRow.badge === '等你决定' && pendingRow.source === '来源未记',
        { badge: pendingRow && pendingRow.badge, source: pendingRow && pendingRow.source });
      check('A6 pending 行按钮可点（批量提交前不误禁）',
        Boolean(pendingRow) && pendingRow.approveDisabled === false && pendingRow.rejectDisabled === false,
        { approveDisabled: pendingRow && pendingRow.approveDisabled, rejectDisabled: pendingRow && pendingRow.rejectDisabled });

      const allRows1 = await readAllRows(inst.cdp);
      const readyAll = (allRows1 || []).find((r) => r.id === READY);
      const devAll = (allRows1 || []).find((r) => r.id === DEV);
      check('A7 全部需求列表每行有徽标+来源（ready → 已通过 / PM 代记；AC5）',
        Boolean(readyAll) && readyAll.badge === '已通过' && readyAll.source === 'PM 代记',
        { row: readyAll });
      check('A8 全部需求列表每行有徽标+来源（dev → 开发中 / 本人；AC5）',
        Boolean(devAll) && devAll.badge === '开发中' && devAll.source === '本人',
        { row: devAll });

      // 证据截图 1：批量区（裁剪，先截再点行，避免选中边框干扰 AC4 观察）。
      const clip = await inst.cdp.evaluate(`(function(){
        const el = document.querySelector('[data-owner-batch]');
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const x = Math.max(0, Math.floor(r.x) - 8), y = Math.max(0, Math.floor(r.y) - 8);
        return { x, y, width: Math.min(Math.ceil(r.width) + 16, window.innerWidth - x), height: Math.min(Math.ceil(r.height) + 16, window.innerHeight - y) };
      })()`);
      await sleep(500);
      shots.push(await shot(inst.cdp, path.join(EVID, 'shot-1-batch-area.png'), clip));

      // AC2/AC6：ready 行（不在批量区）按钮必须 disabled + 原因。
      const readyClick = await openReadyDetail(inst.cdp);
      triggers.openReadyDetail = readyClick.mode;
      await sleep(1200);
      const detail = await readDetail(inst.cdp);
      check('A9 选中 ready 行 → 通过/打回/跳过三个按钮全部 disabled（AC2/AC6）',
        Boolean(detail) && detail.selectedId === READY && detail.ok && detail.ok.disabled === true
          && detail.reject && detail.reject.disabled === true && detail.skip && detail.skip.disabled === true,
        { detail });
      check('A10 ready 行 disabled 原因含「已通过」+ 来源 + 阶段（AC2/AC6）',
        Boolean(detail) && detail.lockHidden === false
          && /已通过/.test(detail.lockText) && /PM 代记/.test(detail.lockText) && /派单/.test(detail.lockText),
        { lockText: detail && detail.lockText, lockCode: detail && detail.lockCode, titles: detail && [detail.ok && detail.ok.title, detail.reject && detail.reject.title] });

      const styles = await readStyleTokens(inst.cdp, DEV);
      check('A11 批量行与「全部需求」行同一套 token（底色/圆角/边框/内边距，AC4）',
        Boolean(styles) && styles.batchBg === styles.rowBg && styles.batchRadius === styles.rowRadius
          && styles.batchPadding === styles.headPadding && styles.batchBorder === styles.rowBorder,
        styles);
      check('A12 批量行字号与「全部需求」行一致（标题 12.5 / 正文 11，AC4）',
        Boolean(styles) && styles.batchTitleFont === styles.headTitleFont && styles.batchLineFont === styles.allLineFont,
        { batchTitleFont: styles && styles.batchTitleFont, headTitleFont: styles && styles.headTitleFont, batchLineFont: styles && styles.batchLineFont, allLineFont: styles && styles.allLineFont });

      // 证据截图 2：ready 行锁定态（整窗，按钮 disabled + 红色原因可见）。
      shots.push(await shot(inst.cdp, path.join(EVID, 'shot-2-ready-disabled.png')));
      await closeReadyDetail(inst.cdp);
      check('A13 两张证据截图落盘且非空图（批量区 / ready 锁定态）',
        shots.length === 2 && shots.every((s) => s && s.ok && Number(s.bytes) > 8000), { shots });

      const exec1 = inst.cdp.exceptions();
      check('A14 第一实例全程零未捕获异常（Runtime.exceptionThrown 0）', exec1.length === 0, { exceptions: exec1.slice(0, 3) });
    } finally {
      if (inst) electronLogs.push(...inst.elecLog);
      await closeElectron(inst);
    }

    // ---------- 第二实例：AC3（1 条成功 + 1 条真实后端失败） ----------
    addPending2AndProxy();
    const boot2 = bootPm('s-3065-batch-2');
    check('S3 重新 boot PM 令牌 + 追加第 2 条 pending（为批量提交失败注入）',
      boot2.code === 0 && Boolean(boot2.token) && Boolean(reqRow(PENDING2)), { code: boot2.code, token: Boolean(boot2.token), pending2: Boolean(reqRow(PENDING2)) });
    const beforePending2 = rowSnapshot(PENDING2);
    const beforePending = rowSnapshot(PENDING);

    inst = await launchElectron(PORT);
    try {
      if (!inst) { check('B0 第二实例启动', false); throw new Error('第二实例未起来'); }
      const opened = await openReviewDialog(inst.cdp);
      triggers.openDialog2 = opened.mode;
      const batch2 = await readBatch(inst.cdp);
      check('B0 第二实例批量区 2 条待审（pending + pending2），ready 仍不进（AC1）',
        Boolean(batch2 && batch2.exists && batch2.count === 2)
          && (batch2.rows || []).some((r) => r.id === PENDING) && (batch2.rows || []).some((r) => r.id === PENDING2)
          && !(batch2.rows || []).some((r) => r.id === READY),
        { count: batch2 && batch2.count, ids: (batch2.rows || []).map((r) => r.id) });

      // 勾选全选 → 提交所选通过。
      const selAll = await realClick(inst.cdp, '[data-owner-batch] [data-batch-select-all]');
      triggers.selectAll = selAll.mode;
      await sleep(800);
      const afterSelect = await readBatch(inst.cdp);
      check('B1 勾选全选后「提交所选通过（2）」可点（AC3 前置）',
        Boolean(afterSelect) && afterSelect.submitDisabled === false && /2/.test(String(afterSelect.submitText || '')),
        { submitText: afterSelect && afterSelect.submitText, submitDisabled: afterSelect && afterSelect.submitDisabled });
      const submitClick = await realClick(inst.cdp, '[data-owner-batch] [data-action="batch-approve-selected"]');
      triggers.submit = submitClick.mode;
      let result = null;
      let lastSeen = null;
      for (let i = 0; i < 180; i += 1) {
        const now = await readBatch(inst.cdp);
        if (now) lastSeen = now;
        if (now && now.result) { result = now; break; }
        await sleep(500);
      }
      if (!result) log.push('B2 等待批量结果超时，最后状态：' + JSON.stringify({ count: lastSeen && lastSeen.count, submitText: lastSeen && lastSeen.submitText, box: lastSeen && lastSeen.boxText }).slice(0, 800));
      check('B2 批量提交有结果反馈：成功 1 条 / 失败 1 条（AC3）',
        Boolean(result && result.result) && result.result.ok === 1 && result.result.fail === 1,
        { result: result && result.result });
      check('B3 失败原因写明（PROXY_UNAUTHORIZED / 代管缺授权），不是点了没反应（AC3）',
        Boolean(result && result.result) && /代管|PROXY_UNAUTHORIZED|授权/.test(String(result.result.text || '')),
        { text: result && result.result && result.result.text });
      const afterPending = rowSnapshot(PENDING);
      const afterPending2 = rowSnapshot(PENDING2);
      check('B4 成功条目已落账：pending → ready + ownerReview=approved（AC3 成功计数真实）',
        afterPending && afterPending.status === 'ready' && afterPending.ownerReview
          && String(afterPending.ownerReview.status) === 'approved' && String(afterPending.ownerReview.channel) === 'ui',
        { before: beforePending && { status: beforePending.status, owner: beforePending.ownerReview && beforePending.ownerReview.status }, after: afterPending && { status: afterPending.status, owner: afterPending.ownerReview && afterPending.ownerReview.status, channel: afterPending.ownerReview && afterPending.ownerReview.channel } });
      check('B5 失败条目零写入：pending2 仍 owner_review + ownerReview=pending + decisions 不增（AC3）',
        Boolean(afterPending2) && Boolean(beforePending2) && afterPending2.status === beforePending2.status
          && JSON.stringify(afterPending2.ownerReview) === JSON.stringify(beforePending2.ownerReview)
          && afterPending2.decisions.length === beforePending2.decisions.length,
        { before: beforePending2, after: afterPending2 });
      const batchAfter = await readBatch(inst.cdp);
      check('B6 提交后刷新：成功那条移出批量区，只剩失败那条（AC1 + AC3 联动）',
        Boolean(batchAfter && batchAfter.exists && batchAfter.count === 1) && (batchAfter.rows || [])[0].id === PENDING2,
        { ids: batchAfter && (batchAfter.rows || []).map((r) => r.id) });

      const clip2 = await inst.cdp.evaluate(`(function(){
        const el = document.querySelector('[data-owner-batch]');
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const x = Math.max(0, Math.floor(r.x) - 8), y = Math.max(0, Math.floor(r.y) - 8);
        return { x, y, width: Math.min(Math.ceil(r.width) + 16, window.innerWidth - x), height: Math.min(Math.ceil(r.height) + 16, window.innerHeight - y) };
      })()`);
      await sleep(600);
      shots.push(await shot(inst.cdp, path.join(EVID, 'shot-3-batch-result.png'), clip2));
      check('B7 批量结果截图落盘且非空图', Boolean(shots[2] && shots[2].ok && Number(shots[2].bytes) > 8000), { shot: shots[2] });

      const exec2 = inst.cdp.exceptions();
      check('B8 第二实例全程零未捕获异常（Runtime.exceptionThrown 0）', exec2.length === 0, { exceptions: exec2.slice(0, 3) });
    } finally {
      if (inst) electronLogs.push(...inst.elecLog);
      await closeElectron(inst);
    }

    // ---------- 隔离：真实数据未被写 ----------
    const realAfter = {
      store: statStamp(REAL_STORE),
      team: sha256File(path.join(REAL_TEAM, '状态', '团队.json')),
    };
    const realStoreText = fs.existsSync(REAL_STORE) ? fs.readFileSync(REAL_STORE, 'utf8') : '';
    // 真实 workbench.json 是活文件（Owner 正在用的工作台会写窗口状态等），不能拿哈希判隔离；
    // 隔离看「沙盘夹具/沙盘项目路径有没有写进真实 store」。团队.json 不在本次写路径上，哈希必须不变。
    check('R1 隔离：真实 workbench.json 未被写入沙盘夹具/沙盘项目路径，团队.json 哈希未变',
      ![PENDING, READY, DEV, PENDING2].some((id) => realStoreText.includes(id))
        && !realStoreText.includes(SB) && realAfter.team === realGuards.team,
      {
        store: { before: realGuards.store, after: realAfter.store, liveFileNote: 'Owner 工作台会写窗口状态，故只核对内容不含夹具' },
        teamSame: realAfter.team === realGuards.team,
        leaked: [PENDING, READY, DEV, PENDING2].filter((id) => realStoreText.includes(id)),
        sandboxPathInStore: realStoreText.includes(SB),
      });
    const realWfFile = path.join(REAL_STATE_DIR, '工作流.json');
    const realWfText = fs.existsSync(realWfFile) ? fs.readFileSync(realWfFile, 'utf8') : '';
    check('R2 隔离：3 条夹具需求没有落进真实 团队/状态/项目/<项目>/工作流.json',
      ![PENDING, READY, DEV, PENDING2].some((id) => realWfText.includes(id)),
      { leaked: [PENDING, READY, DEV, PENDING2].filter((id) => realWfText.includes(id)) });
  } catch (e) {
    check('FATAL 脚本异常（详情见 batch-review.log）', false, { error: String((e && e.stack) || e).slice(0, 600) });
  } finally {
    // ---------- 收尾：证据落盘 + 沙盘快照 + 自清理 ----------
    try {
      const snapshot = {
        fixtures: Object.fromEntries([PENDING, READY, DEV, PENDING2].map((id) => [id, rowSnapshot(id)])),
      };
      fs.writeFileSync(path.join(EVID, 'sandbox-snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    } catch { /* 快照失败不影响退出码 */ }
    const passed = results.filter((r) => r.ok).length;
    const summary = {
      at: new Date().toISOString(),
      project: PROJECT,
      task: 'B-20261115-111229-3065',
      port: PORT,
      passed, failed: results.length - passed, total: results.length,
      triggers, screenshots: shots,
      fixtures: { PENDING, READY, DEV, PENDING2 },
      results,
    };
    fs.writeFileSync(path.join(EVID, 'batch-review-result.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(EVID, 'batch-review.log'), log.join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(EVID, 'electron.log'), electronLogs.join('\n') + '\n', 'utf8');
    // 调试用：BATCH_KEEP_SANDBOX=1 保留 _tmp/b3065 供排查；默认清理。
    if (process.env.BATCH_KEEP_SANDBOX !== '1') {
      try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 沙盘删不掉不影响退出码 */ }
    } else {
      log.push('BATCH_KEEP_SANDBOX=1：保留沙盘 ' + BASE);
    }
    console.log(`\nBATCH_REVIEW ${passed}/${results.length} PASS`);
    process.exit(passed === results.length ? 0 : 1);
  }
})().catch((e) => {
  console.error(e && e.stack || e);
  try {
    fs.mkdirSync(EVID, { recursive: true });
    fs.writeFileSync(path.join(EVID, 'batch-review.log'), log.join('\n') + '\nFATAL: ' + String((e && e.stack) || e) + '\n', 'utf8');
  } catch { /* */ }
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* */ }
  process.exit(1);
});
