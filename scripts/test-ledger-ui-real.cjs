'use strict';
/**
 * R-9fbe AC2 真窗口断言（B-20261115-081703-73eb 修复后回归）
 *
 * 目的：覆盖「源码级 57 条断言全绿、真窗口点击 0 效果」的缺口——
 *       真鼠标事件 → 点击委托 → ledgerActionRun → IPC → team.mjs 协议命令 → 审计 → 横幅 → 重绘。
 *
 * 隔离：AWB_DATA_DIR + TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_WORKBENCH_JSON 全部指 _tmp/73eb-ui-real，
 *       真实 data/ 与 团队/状态/ 只读（脚本前后比对 mtime/sha256 并断言未变）。
 * 沙盘：复制真实 团队/（跳过 锁/邮箱），清空 members[].sessionId、activeProject、状态/启动/*.json；
 *       PM 令牌用 team.mjs boot 在沙盘里现 boot（不自签、不代签）。
 * 夹具：①dev + 开发任务 done → dev_ledger_ahead（「收口旧任务」）
 *       ②dev_done + 测试任务 done → test_ledger_ahead（「重开需求记录」；req reopen 只认 dev_done/test_done）
 *
 * 用法：node scripts/test-ledger-ui-real.cjs        （退出码 0=全绿，1=有红）
 *       端口 9427；截图/结果落 项目/工作台改造修复/程序员A/产出/证据-ed7-fix/
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
const PROJECT_ID = 'P-b98f4eb7';
const BASE = path.join(ROOT, '_tmp', '73eb-ui-real');
const SB = path.join(BASE, 'sb');
const EVID = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-ed7-fix');
const PORT = 9427;
const RELEASE_REQ = 'R-20261115-999901-fork';
const RELEASE_TASK = 'T-20261115-999901-fork';
const REOPEN_REQ = 'R-20261115-999902-fork';
const REOPEN_TASK = 'T-20261115-999902-fork';

const results = [];
const log = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 700)}`;
  log.push(line); console.log(line);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; }
}
function statStamp(file) { try { const s = fs.statSync(file); return `${s.size}:${s.mtimeMs}`; } catch { return 'missing'; } }

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

function seedSandbox() {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(path.join(SB, 'data', 'userdata'), { recursive: true });
  const store = JSON.parse(fs.readFileSync(REAL_STORE, 'utf8'));
  const real = store.projects.find((p) => p && p.id === PROJECT_ID);
  if (!real) throw new Error(`真实 workbench.json 里没有项目 ${PROJECT_ID}`);
  store.projects = [real]; store.activeProjectId = PROJECT_ID;
  fs.writeFileSync(path.join(SB, 'data', 'userdata', 'workbench.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
  copyDir(REAL_TEAM, path.join(SB, '团队'), (s) => /[\\/]锁([\\/]|$)/.test(s) || /[\\/]邮箱[\\/]/.test(s));
  const teamFile = path.join(SB, '团队', '状态', '团队.json');
  const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = '';
  fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
  const startDir = path.join(SB, '团队', '状态', '启动');
  if (fs.existsSync(startDir)) for (const f of fs.readdirSync(startDir)) if (f.endsWith('.json')) fs.rmSync(path.join(startDir, f), { force: true });
}

/** 夹具：两条真分叉（口径见 程序员B/产出/字段约定-账本分叉-9fbe.md，判据实现 团队/工具/lib/ledger.mjs）。 */
function forkFixture() {
  const stateDir = path.join(SB, '团队', '状态', '项目', PROJECT);
  const wfFile = path.join(stateDir, '工作流.json');
  const wf = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
  wf.requirements = wf.requirements || {};
  const row = (id, title, status) => ({
    id, title, status, round: 1, priority: 'P1', queued: false, createdBy: 'pm',
    createdAt: '2026-11-15T06:00:00.000Z', updatedAt: '2026-11-15T06:00:00.000Z', deliveryRound: 1
  });
  wf.requirements[RELEASE_REQ] = row(RELEASE_REQ, '夹具：分叉-收口旧任务', 'dev');
  wf.requirements[REOPEN_REQ] = row(REOPEN_REQ, '夹具：分叉-重开需求记录', 'dev_done');
  fs.writeFileSync(wfFile, JSON.stringify(wf, null, 2) + '\n', 'utf8');
  const taskDir = path.join(stateDir, '任务');
  fs.mkdirSync(taskDir, { recursive: true });
  const task = (id, reqId, owner) => ({
    id, project: PROJECT, type: 'task', requirementId: reqId,
    title: '夹具任务 ' + id, detail: '分叉夹具', acceptance: '', priority: 'P1',
    owner, status: 'done', createdBy: 'pm',
    createdAt: '2026-11-15T06:00:00.000Z', claimedAt: '2026-11-15T06:00:00.000Z',
    doneAt: '2026-11-15T06:30:00.000Z', evidence: '夹具', rev: 1, history: []
  });
  fs.writeFileSync(path.join(taskDir, RELEASE_TASK + '.json'), JSON.stringify(task(RELEASE_TASK, RELEASE_REQ, 'programmer1'), null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(taskDir, REOPEN_TASK + '.json'), JSON.stringify(task(REOPEN_TASK, REOPEN_REQ, 'tester'), null, 2) + '\n', 'utf8');
}

function toolEnv() {
  return {
    ...process.env,
    TEAM_ROOT: path.join(SB, '团队'),
    TEAM_PROJECTS_ROOT: path.join(SB, '团队', '状态', '项目'),
    TEAM_WORKBENCH_JSON: path.join(SB, 'data', 'userdata', 'workbench.json'),
    TEAM_SELFTEST: '1'
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
function clearBootTokens() {
  const dir = path.join(SB, '团队', '状态', '启动');
  if (!fs.existsSync(dir)) return [];
  const removed = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const f of removed) fs.rmSync(path.join(dir, f), { force: true });
  return removed;
}

function launchEnv() {
  return { ...toolEnv(), AWB_DATA_DIR: path.join(SB, 'data') };
}
async function launchElectron(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + port], {
    cwd: ROOT, env: launchEnv(), stdio: 'ignore', windowsHide: false
  });
  const target = await waitTarget(port, 60000, (x) => x && x.type === 'page' && String(x.url || '').includes('renderer/index.html'));
  if (!target) { try { child.kill(); } catch { /* */ } return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  for (let i = 0; i < 120; i += 1) {
    const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(document.getElementById("btn-board"))');
    if (ready === true) break;
    await sleep(500);
  }
  // 壳内 webview 加载的是真实 DSH 页面：导航到 about:blank，否则截图会黑底/挂住（只影响本隔离实例）
  const guest = await waitTarget(port, 5000, (x) => x && x.type === 'webview');
  if (guest) {
    try {
      const gws = new WebSocket(guest.webSocketDebuggerUrl);
      await new Promise((res) => { gws.addEventListener('open', res, { once: true }); setTimeout(res, 3000); });
      gws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: 'about:blank' } }));
      await sleep(600);
    } catch { /* webview 关掉也不影响断言 */ }
  }
  return { child, cdp, ws };
}
async function closeElectron(inst) {
  if (!inst) return;
  try { await inst.cdp.send('Browser.close', {}, 5000); } catch { /* */ }
  try { inst.child.kill(); } catch { /* */ }
  await sleep(1200);
}

/** 真实鼠标点击：先滚进视野 + elementFromPoint 命中校验；矩形为 0（不可见）才退回 element.click()。 */
async function realClick(cdp, selector) {
  const geo = await cdp.evaluate(`(function(){
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { missing: true };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    const hit = (r.width > 0 && r.height > 0) ? document.elementFromPoint(x, y) : null;
    return {
      x, y, w: Math.round(r.width), h: Math.round(r.height),
      hitIsTarget: Boolean(hit && (hit === el || el.contains(hit))),
      hitTag: hit ? hit.tagName : '', disabled: Boolean(el.disabled)
    };
  })()`);
  if (!geo || geo.missing) return { mode: 'missing', geo };
  if (geo.w > 0 && geo.h > 0 && geo.hitIsTarget) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.x, y: geo.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });
    return { mode: 'mouse', geo, x: geo.x, y: geo.y };
  }
  // 不可见或命中不到（被遮挡）：退回 DOM click，并在结果里如实写明触发方式
  await cdp.evaluate(`(function(){ const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return true; })()`);
  return { mode: 'element', geo, reason: geo.w === 0 ? 'rect=0（不可见）' : 'elementFromPoint 未命中' };
}

/**
 * 截图：沿用 main.js --layout-check 的可用姿势（先 Emulation.setDeviceMetricsOverride，再
 * Page.captureScreenshot + fromSurface/captureBeyondViewport，最后清 override）；
 * 不加 --disable-gpu（会让 captureScreenshot 恒超时），失败重试并记录原因。
 */
async function shot(cdp, file) {
  try { await cdp.send('Page.bringToFront', {}, 8000); } catch { /* 前台化失败也继续试 */ }
  const size = await cdp.evaluate(`(function(){ return { w: Math.max(1, Number(window.innerWidth) || 1280), h: Math.max(1, Number(window.innerHeight) || 800) }; })()`) || { w: 1280, h: 800 };
  try { await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false }, 8000); } catch { /* 覆盖失败就直接截 */ }
  let lastErr = '';
  try {
    for (let i = 0; i < 4; i += 1) {
      try {
        const r = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, 20000);
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

/** 打开项目面板 → 流程页；优先真实鼠标点击入口按钮，失败退回 element.click()（记录触发方式）。 */
async function openFlowTab(cdp) {
  const entry = await realClick(cdp, '#btn-board');
  await sleep(2200);
  let drawerOpen = await cdp.evaluate(`(function(){ const d = document.getElementById('project-drawer'); return Boolean(d && !d.hidden); })()`);
  let drawerMode = entry.mode;
  if (!drawerOpen) {
    await cdp.evaluate(`(function(){ setDrawer('project'); return true; })()`);
    await sleep(1200);
    drawerMode = `${entry.mode}+setDrawer`;
    drawerOpen = await cdp.evaluate(`(function(){ const d = document.getElementById('project-drawer'); return Boolean(d && !d.hidden); })()`);
  }
  const tab = await realClick(cdp, '#tabs .tab[data-tab="flow"]');
  await sleep(2200);
  const flowActive = await cdp.evaluate(`(function(){ const v = document.getElementById('view-flow'); return Boolean(v && v.classList.contains('active')); })()`);
  if (!flowActive) {
    await cdp.evaluate(`(function(){ showTab('flow', { open: true }); return true; })()`);
    await sleep(1500);
  }
  return { drawerOpen, drawerMode, tabMode: tab.mode, flowActive };
}

/** 截图前把面板滚回左上、账本块对齐到顶部（点击时的 scrollIntoView 会横向滚偏）。 */
async function focusLedger(cdp) {
  await cdp.evaluate(`(function(){
    const scroll = document.querySelector('#project-drawer .drawer-scroll');
    if (scroll) scroll.scrollLeft = 0;
    const box = document.getElementById('legacy-flow-ledger');
    if (box && box.scrollIntoView) box.scrollIntoView({ block: 'start', inline: 'start' });
    if (scroll) scroll.scrollLeft = 0;
    return true;
  })()`);
  await sleep(600);
}

/** 账本视图（只读）：分叉行数一律限定在流程页容器内——概览页 #legacy-gate 也有同一份账本块。 */
async function readLedger(cdp) {
  return cdp.evaluate(`(function(){
    const box = document.getElementById('legacy-flow-ledger');
    const rows = box ? [...box.querySelectorAll('[data-ledger-fork]')] : [];
    const banner = document.querySelector('#view-flow [data-ledger-banner], #legacy-flow-ledger [data-ledger-banner]');
    return {
      hasBox: Boolean(box),
      rows: rows.map((n) => ({
        id: n.getAttribute('data-ledger-fork'),
        kind: n.getAttribute('data-ledger-kind'),
        status: n.getAttribute('data-ledger-status'),
        buttons: [...n.querySelectorAll('[data-ledger-action]')].map((b) => ({
          action: b.getAttribute('data-ledger-action'), task: b.getAttribute('data-ledger-task'),
          req: b.getAttribute('data-ledger-req'), disabled: b.disabled
        }))
      })),
      banner: banner ? (banner.textContent || '').trim() : '',
      bannerKind: banner ? banner.getAttribute('data-ledger-banner-kind') : '',
      bannerCode: banner ? banner.getAttribute('data-ledger-code') : '',
      ui: (typeof ledgerActionUi === 'object') ? JSON.parse(JSON.stringify(ledgerActionUi)) : null
    };
  })()`);
}

function auditFile() { return path.join(SB, '团队', '状态', '项目', PROJECT, '账本处置.jsonl'); }
function auditLines() {
  const file = auditFile();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
}
function readTask(id) { return JSON.parse(fs.readFileSync(path.join(SB, '团队', '状态', '项目', PROJECT, '任务', id + '.json'), 'utf8')); }
function readReqRow(id) {
  const wf = JSON.parse(fs.readFileSync(path.join(SB, '团队', '状态', '项目', PROJECT, '工作流.json'), 'utf8'));
  return (wf.requirements || {})[id] || {};
}

(async () => {
  fs.mkdirSync(EVID, { recursive: true });
  const realGuards = {
    store: statStamp(REAL_STORE),
    workflow: sha256File(path.join(REAL_STATE_DIR, '工作流.json')),
    team: sha256File(path.join(REAL_TEAM, '状态', '团队.json')),
    audit: fs.existsSync(path.join(REAL_STATE_DIR, '账本处置.jsonl')) ? sha256File(path.join(REAL_STATE_DIR, '账本处置.jsonl')) : 'missing'
  };

  // ---------- 沙盘 ----------
  seedSandbox();
  forkFixture();
  const startDir = path.join(SB, '团队', '状态', '启动');
  const startEmpty = fs.existsSync(startDir) ? fs.readdirSync(startDir).filter((f) => f.endsWith('.json')).length : 0;
  const membersCleared = (JSON.parse(fs.readFileSync(path.join(SB, '团队', '状态', '团队.json'), 'utf8')).members || []).every((m) => !m.sessionId);
  check('S0 沙盘就绪（团队副本 / members.sessionId 全清 / 状态/启动 令牌清空）',
    startEmpty === 0 && membersCleared, { startTokens: startEmpty, membersCleared });

  const boot1 = bootPm('s-73eb-ui-real-1');
  check('S1 沙盘 PM boot 成功（处置令牌来自团队工具，不自签）', boot1.code === 0 && Boolean(boot1.token), { code: boot1.code, token: Boolean(boot1.token) });

  const trigger = {};
  const shots = [];

  // ---------- 第一实例：失败注入（无 PM 令牌也要「有横幅 + 错误码 + 零副作用」） ----------
  let inst = await launchElectron(PORT);
  try {
    if (!inst) { check('E0 第一实例启动', false); throw new Error('第一实例未起来'); }
    const opened = await openFlowTab(inst.cdp);
    trigger.openDrawer = opened.drawerMode;
    trigger.openTab = opened.tabMode;
    const st0 = await readLedger(inst.cdp);
    check('E0 有 PM 令牌时流程页渲染 2 行分叉且按钮可点',
      Boolean(st0) && st0.hasBox && (st0.rows || []).length === 2 && st0.rows.every((r) => r.buttons.length === 2 && r.buttons.every((b) => b.disabled === false)),
      { rows: (st0 && st0.rows), opening: opened });

    // 注入：清空启动令牌（模拟 PM 没 boot / 令牌被清）
    const removed = clearBootTokens();
    const clickInj = await realClick(inst.cdp, `#legacy-flow-ledger [data-ledger-fork="${RELEASE_REQ}"] [data-ledger-action="task-release"]`);
    trigger.inject = clickInj.mode;
    await sleep(3000);
    const stInj = await readLedger(inst.cdp);
    const codeOk = Boolean(stInj && stInj.bannerCode) && /PM_TOKEN_REQUIRED|LEDGER_ACTION_DISABLED/.test(String(stInj.bannerCode));
    check('D1 无 PM 令牌时点击 → 人话横幅 + 错误码（不只 toast）',
      Boolean(stInj && stInj.banner) && ['bad', 'warn'].includes(String(stInj.bannerKind)) && codeOk,
      { removed, banner: stInj && stInj.banner, kind: stInj && stInj.bannerKind, code: stInj && stInj.bannerCode });
    check('D2 失败注入零副作用（任务仍 done + 审计不新增 + 分叉仍 2 行）',
      readTask(RELEASE_TASK).status === 'done' && auditLines().length === 0 && (stInj.rows || []).length === 2,
      { taskStatus: readTask(RELEASE_TASK).status, auditLines: auditLines().length, rows: (stInj && stInj.rows || []).length });

    const direct = await inst.cdp.evaluate(`(async () => {
      try {
        const r = await window.workbench.ownerLedgerCloseTask({ projectId: '${PROJECT_ID}', requirementId: '${RELEASE_REQ}', taskId: '${RELEASE_TASK}', reason: '回归：无令牌注入' });
        return { ok: r && r.ok, code: r && r.code, message: String((r && r.message) || '').slice(0, 200) };
      } catch (e) { return { error: String((e && e.message) || e) }; }
    })()`, 60000);
    check('D3 清空令牌后直调 IPC → 明确 PM_TOKEN_REQUIRED（不是静默/超时）',
      Boolean(direct) && direct.ok === false && direct.code === 'PM_TOKEN_REQUIRED',
      { direct, taskStatus: readTask(RELEASE_TASK).status, auditLines: auditLines().length });
    trigger.injectDirect = direct && direct.code;
  } finally {
    await closeElectron(inst);
  }

  // ---------- 第二实例：成功路径（收口旧任务 + 重开需求记录） ----------
  const boot2 = bootPm('s-73eb-ui-real-2');
  check('S2 重新 boot PM 令牌（成功路径前置）', boot2.code === 0 && Boolean(boot2.token), { code: boot2.code });
  inst = await launchElectron(PORT);
  try {
    if (!inst) { check('B0 第二实例启动', false); throw new Error('第二实例未起来'); }
    await openFlowTab(inst.cdp);
    const st = await readLedger(inst.cdp);
    check('B0 分叉前：流程页 2 行分叉（dev_ledger_ahead + test_ledger_ahead）',
      Boolean(st) && (st.rows || []).length === 2
      && st.rows.some((r) => r.kind === 'dev_ledger_ahead') && st.rows.some((r) => r.kind === 'test_ledger_ahead'),
      { rows: st && st.rows });
    shots.push(await shot(inst.cdp, path.join(EVID, 'shot-1-forks-before.png')));
    // ① 收口旧任务（真实鼠标点击）
    const click1 = await realClick(inst.cdp, `#legacy-flow-ledger [data-ledger-fork="${RELEASE_REQ}"] [data-ledger-action="task-release"]`);
    trigger.release = click1.mode;
    await sleep(3200);
    const st1 = await readLedger(inst.cdp);
    const audit1 = auditLines();
    const t1 = readTask(RELEASE_TASK);
    check('B1 点「收口旧任务」→ 分叉 2 → 1（重绘后只剩重开那条）',
      Boolean(click1) && click1.mode !== 'missing' && Boolean(st1) && (st1.rows || []).length === 1
      && st1.rows.every((r) => r.id === REOPEN_REQ),
      { trigger: click1, after: st1 && st1.rows });
    check('B2 旧任务被团队工具退回未收口（status done → open）', String(t1.status) !== 'done', { status: t1.status });
    let rec1 = null;
    try { rec1 = JSON.parse(audit1[audit1.length - 1] || '{}'); } catch { rec1 = null; }
    const fields1 = rec1 && ['at', 'action', 'requirementId', 'taskId', 'before', 'after', 'actor', 'channel', 'source', 'result'].every((k) => Object.prototype.hasOwnProperty.call(rec1, k));
    check('B3 账本处置.jsonl 新增 1 行且字段齐全（action/before/after/actor/channel/source/result.ok/bootFile）',
      audit1.length === 1 && fields1 && rec1.action === 'close_old_task' && rec1.requirementId === RELEASE_REQ
      && rec1.actor === 'pm' && rec1.channel === 'ui' && rec1.source === 'team.mjs task release'
      && rec1.before && rec1.before.ledgerForkKind === 'dev_ledger_ahead'
      && rec1.after && !rec1.after.ledgerForkKind
      && rec1.result && rec1.result.ok === true && Boolean(rec1.result.bootFile),
      { lines: audit1.length, record: rec1 && { action: rec1.action, req: rec1.requirementId, task: rec1.taskId, before: rec1.before, after: rec1.after, result: rec1.result } });
    check('B4 成功后写 ok 横幅（含剩余分叉/审计，且 busy 已复位）',
      Boolean(st1 && st1.banner) && String(st1.bannerKind) === 'ok' && /剩余分叉|审计/.test(String(st1.banner))
      && Boolean(st1.ui) && st1.ui.busy === false,
      { banner: st1 && st1.banner, kind: st1 && st1.bannerKind, ui: st1 && st1.ui });
    await focusLedger(inst.cdp);
    shots.push(await shot(inst.cdp, path.join(EVID, 'shot-2-after-release.png')));

    // ② 重开需求记录
    const click2 = await realClick(inst.cdp, `#legacy-flow-ledger [data-ledger-fork="${REOPEN_REQ}"] [data-ledger-action="requirement-reopen"]`);
    trigger.reopen = click2.mode;
    await sleep(3200);
    const st2 = await readLedger(inst.cdp);
    const audit2 = auditLines();
    const row2 = readReqRow(REOPEN_REQ);
    check('C1 点「重开需求记录」→ 分叉 1 → 0', Boolean(click2) && click2.mode !== 'missing' && Boolean(st2) && (st2.rows || []).length === 0,
      { trigger: click2, after: st2 && st2.rows });
    check('C2 需求行写 lastReopenAt / gateInvalidatedAt 且 deliveryRound 轮次 +1',
      Boolean(row2.lastReopenAt) && Number(row2.deliveryRound) >= 2 && Boolean(row2.gateInvalidatedAt) && Number(row2.reopenCount) >= 1,
      { lastReopenAt: row2.lastReopenAt, deliveryRound: row2.deliveryRound, gateInvalidatedAt: row2.gateInvalidatedAt, status: row2.status });
    let rec2 = null;
    try { rec2 = JSON.parse(audit2[audit2.length - 1] || '{}'); } catch { rec2 = null; }
    check('C3 审计再追加 1 行 requirement-reopen（source=team.mjs req reopen，result.ok）',
      audit2.length === 2 && rec2 && rec2.action === 'reopen_requirement' && rec2.requirementId === REOPEN_REQ
      && rec2.source === 'team.mjs req reopen' && rec2.result && rec2.result.ok === true
      && rec2.after && !rec2.after.ledgerForkKind,
      { lines: audit2.length, record: rec2 && { action: rec2.action, req: rec2.requirementId, source: rec2.source, result: rec2.result } });
    check('C4 成功后写 ok 横幅（含需求 id 与审计，busy 已复位）',
      Boolean(st2 && st2.banner) && String(st2.bannerKind) === 'ok' && /重开/.test(String(st2.banner))
      && Boolean(st2.ui) && st2.ui.busy === false,
      { banner: st2 && st2.banner, kind: st2 && st2.bannerKind });
    await focusLedger(inst.cdp);
    shots.push(await shot(inst.cdp, path.join(EVID, 'shot-3-banner.png')));
    check('S3 三张证据截图落盘且不是空图（分叉前 / 点后 / 横幅）',
      shots.length === 3 && shots.every((s) => s && s.ok && Number(s.bytes) > 10000),
      { shots });

    const exec = inst.cdp.exceptions();
    check('E1 全程窗口零未捕获异常（Runtime.exceptionThrown 0）', exec.length === 0, { exceptions: exec.slice(0, 3) });
  } finally {
    await closeElectron(inst);
  }

  // ---------- 隔离：真实 data/团队状态未被写 ----------
  const realAfter = {
    store: statStamp(REAL_STORE),
    workflow: sha256File(path.join(REAL_STATE_DIR, '工作流.json')),
    team: sha256File(path.join(REAL_TEAM, '状态', '团队.json')),
    audit: fs.existsSync(path.join(REAL_STATE_DIR, '账本处置.jsonl')) ? sha256File(path.join(REAL_STATE_DIR, '账本处置.jsonl')) : 'missing'
  };
  check('R1 隔离：真实 workbench.json 尺寸/mtime、团队.json 哈希、真实 账本处置.jsonl 都未被本次复验改动',
    realAfter.store === realGuards.store && realAfter.team === realGuards.team && realAfter.audit === realGuards.audit,
    { storeBefore: realGuards.store, storeAfter: realAfter.store, teamSame: realAfter.team === realGuards.team, auditBefore: realGuards.audit, auditAfter: realAfter.audit });
  // 真实 工作流.json 是活文件（PM/Owner 会话随时在写）；判断越界不看哈希，看「夹具有没有落到真实状态里」。
  const realWfText = fs.existsSync(path.join(REAL_STATE_DIR, '工作流.json')) ? fs.readFileSync(path.join(REAL_STATE_DIR, '工作流.json'), 'utf8') : '';
  const realTaskDir = path.join(REAL_STATE_DIR, '任务');
  const leakedTasks = [RELEASE_TASK, REOPEN_TASK].filter((id) => fs.existsSync(path.join(realTaskDir, id + '.json')));
  check('R2 隔离：夹具需求/任务没有落进真实 团队/状态（真实 工作流.json 只由实时团队活动改写）',
    !realWfText.includes(RELEASE_REQ) && !realWfText.includes(REOPEN_REQ) && leakedTasks.length === 0,
    {
      fixtureInRealWorkflow: realWfText.includes(RELEASE_REQ) || realWfText.includes(REOPEN_REQ),
      leakedTasks,
      // 只回放不断言：真实工作流哈希在复验期间可能被 PM/Owner 会话改写
      realWorkflowHash: { before: realGuards.workflow.slice(0, 12), after: realAfter.workflow.slice(0, 12) }
    });

  // ---------- 收尾：证据落盘 + 自清理沙盘 ----------
  const passed = results.filter((r) => r.ok).length;
  const summary = {
    at: new Date().toISOString(),
    passed, failed: results.length - passed, total: results.length,
    triggers: trigger,
    screenshots: shots,
    auditRecords: (() => { try { return auditLines().map((l) => JSON.parse(l)); } catch { return []; } })(),
    results
  };
  fs.writeFileSync(path.join(EVID, 'real-click-result.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(EVID, 'real-click.log'), log.join('\n') + '\n', 'utf8');
  // 沙盘副本留证（审计文件 + 两条任务 + 工作流行），沙盘本体删除
  try {
    const stateDir = path.join(SB, '团队', '状态', '项目', PROJECT);
    fs.mkdirSync(path.join(EVID, 'sandbox-snapshot'), { recursive: true });
    if (fs.existsSync(auditFile())) fs.copyFileSync(auditFile(), path.join(EVID, 'sandbox-snapshot', '账本处置.jsonl'));
    fs.writeFileSync(path.join(EVID, 'sandbox-snapshot', 'tasks.json'), JSON.stringify({
      [RELEASE_TASK]: readTask(RELEASE_TASK),
      [REOPEN_TASK]: readTask(REOPEN_TASK)
    }, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(EVID, 'sandbox-snapshot', 'requirements.json'), JSON.stringify({
      [RELEASE_REQ]: readReqRow(RELEASE_REQ),
      [REOPEN_REQ]: readReqRow(REOPEN_REQ)
    }, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(EVID, 'sandbox-snapshot', 'stateDir.txt'), stateDir + '\n', 'utf8');
  } catch (e) {
    log.push('证据副本失败：' + String((e && e.message) || e));
  }
  fs.rmSync(BASE, { recursive: true, force: true });

  console.log(`\nR-9fbe 真窗口点击回归：${passed}/${results.length} PASS`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error(e && e.stack || e);
  try {
    fs.mkdirSync(EVID, { recursive: true });
    fs.writeFileSync(path.join(EVID, 'real-click.log'), log.join('\n') + '\n' + 'FATAL: ' + String((e && e.stack) || e) + '\n', 'utf8');
  } catch { /* 证据写不进也不能二次抛 */ }
  // 约定：退出码只 0/1（0=全绿，1=有红或致命错误），沙盘一律自清理。
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 沙盘删不掉不影响退出码 */ }
  process.exit(1);
});
