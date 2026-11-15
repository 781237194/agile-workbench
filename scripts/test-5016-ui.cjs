'use strict';
/**
 * R-5016 界面侧断言（T-2da7）：三入口数字同源 IPC + 箱内七要素 + 转投提示 + 缺项不展示。
 *
 * 走真窗口（Electron + CDP）：
 * ① owner:pending-counts 返回 decisions=3 / reviews=2 / accepts=1；
 * ② 三锚点 #decision-box-pill / #owner-review-count / #accept-badge 的 data-count 与 IPC 同源同值；
 * ③ 箱内三条可见条目都展示七要素（来源/背景/问题/选项+默认/影响/截止）；
 * ④ 带 redirect 的条目显示「已转投到 X」；
 * ⑤ 缺项条目（缺 impact/dueAt）不渲染；
 * ⑥ 两张截图 + 真实 决策箱.json / workbench.json 隔离不变。
 *
 * 隔离：AWB_DATA_DIR + TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_WORKBENCH_JSON 全指 _tmp/5016-ui；端口 9432。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const REAL_TEAM = path.join(ROOT, '团队');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const PROJECT = '工作台改造修复';
const REAL_BOX = path.join(REAL_TEAM, '状态', '项目', PROJECT, '决策箱.json');
const BASE = path.join(ROOT, '_tmp', '5016-ui');
const SB = path.join(BASE, 'sb');
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const STATE_DIR = path.join(TEAM, '状态', '项目', PROJECT);
const BOX_FILE = path.join(STATE_DIR, '决策箱.json');
const EVID = process.env.AWB_DECISION_UI_OUT
  ? path.resolve(process.env.AWB_DECISION_UI_OUT)
  : path.join(ROOT, '项目', PROJECT, '程序员B', '产出', '证据-5016');
const PORT = Number(process.env.AWB_DECISION_UI_PORT || 9432);
const ITEM_OK = 'D-20261115-999901-uibox';
const ITEM_REDIRECT = 'D-20261115-999903-uibox';
const ITEM_INCOMPLETE = 'D-20261115-999904-uibox';

const results = [];
const notes = [];
const log = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : detail });
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 600)}`;
  log.push(line);
  console.log(line);
  if (!ok) process.exitCode = 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; }
}
function statOf(file) {
  try { const s = fs.statSync(file); return { mtimeMs: s.mtimeMs, bytes: s.size, sha256: sha256File(file) }; } catch { return null; }
}
function readBox() {
  try { return JSON.parse(fs.readFileSync(BOX_FILE, 'utf8')); } catch { return null; }
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
      if (out && out.exceptionDetails) {
        return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text).slice(0, 500) };
      }
      return out && out.result ? out.result.value : undefined;
    } catch (e) { return { __cdperror: String((e && e.message) || e) }; }
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
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  const store = JSON.parse(fs.readFileSync(REAL_STORE, 'utf8'));
  const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PROJECT);
  if (!project) throw new Error(`真实 workbench.json 里没有团队项目 ${PROJECT}`);
  store.projects = [project];
  store.activeProjectId = project.id;
  fs.writeFileSync(path.join(DATA, 'userdata', 'workbench.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
  copyDir(REAL_TEAM, TEAM, (f) => /[\\/]锁([\\/]|$)/.test(f) || /[\\/]邮箱[\\/]/.test(f));
  const teamFile = path.join(TEAM, '状态', '团队.json');
  const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = PROJECT;
  fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
  const startDir = path.join(TEAM, '状态', '启动');
  if (fs.existsSync(startDir)) for (const f of fs.readdirSync(startDir)) if (f.endsWith('.json')) fs.rmSync(path.join(startDir, f), { force: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const nowIso = new Date().toISOString();
  const item = (id, over = {}) => ({
    id, title: '夹具：' + id, summary: '夹具背景：需要 Owner 拍板的一件事', question: '要不要继续做？',
    source: { kind: 'task', ref: 'T-20261115-000001-fixture' }, createdAt: '2026-11-15T00:00:00.000Z', by: 'pm',
    status: 'open', options: ['继续', '停', '先放着'], defaultChoice: '继续', impact: '影响 PM 排期与测试',
    dueAt: '2026-11-16T00:00:00.000Z', readAt: null, answeredAt: null, archivedAt: null, updatedAt: nowIso, ...over,
  });
  fs.writeFileSync(BOX_FILE, JSON.stringify({
    schema: 1, project: PROJECT, updatedAt: '2026-11-15T00:00:00.000Z',
    items: [
      item(ITEM_OK, { title: '夹具：七要素完整（应展示）' }),
      item(ITEM_REDIRECT, { title: '夹具：转投条目（应展示目标）', redirect: { to: 'review_dialog', anchor: '#owner-review', reason: '评审类动作用评审弹窗' } }),
      item('D-20261115-999905-uibox', { title: '夹具：七要素完整二（应展示）' }),
      item(ITEM_INCOMPLETE, { title: '夹具：缺 impact/dueAt（不应展示）', impact: '', dueAt: '', status: 'answered' }),
    ],
  }, null, 2) + '\n', 'utf8');
  // 工作流：2 条 ownerReview pending（reviews=2）+ 1 条 test_done（accepts=1）
  const wf = {
    schema: 2, project: PROJECT, round: 1, phase: 'dev', updatedAt: nowIso,
    requirements: {
      'R-20261115-999901-rev1': { id: 'R-20261115-999901-rev1', title: '评审夹具 1', status: 'owner_review', ownerReview: { status: 'pending' }, createdAt: nowIso },
      'R-20261115-999902-rev2': { id: 'R-20261115-999902-rev2', title: '评审夹具 2', status: 'approved', ownerReview: { status: 'pending' }, createdAt: nowIso },
      'R-20261115-999903-acc1': { id: 'R-20261115-999903-acc1', title: '验收夹具', status: 'test_done', createdAt: nowIso },
    },
  };
  fs.writeFileSync(path.join(STATE_DIR, '工作流.json'), JSON.stringify(wf, null, 2) + '\n', 'utf8');
  return { box: readBox(), store, wf };
}

function launchEnv() {
  return {
    ...process.env,
    AWB_DATA_DIR: DATA,
    TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: path.join(TEAM, '状态', '项目'),
    TEAM_WORKBENCH_JSON: path.join(DATA, 'userdata', 'workbench.json'),
    TEAM_SELFTEST: '1',
  };
}
async function launchElectron(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + port], {
    cwd: ROOT, env: launchEnv(), stdio: 'ignore', windowsHide: false,
  });
  const target = await waitTarget(port, 60000, (x) => x && x.type === 'page' && String(x.url || '').includes('renderer/index.html'));
  if (!target) { try { child.kill(); } catch { /* */ } return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  for (let i = 0; i < 120; i += 1) {
    const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(document.getElementById("decision-box"))');
    if (ready === true) break;
    await sleep(500);
  }
  // 壳内 webview 是真实 DSH 页面：先导航 about:blank，避免截图黑底/挂住（只影响本隔离实例）
  const guest = await waitTarget(port, 6000, (x) => x && x.type === 'webview');
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
      disabled: Boolean(el.disabled)
    };
  })()`);
  if (!geo || geo.missing) return { mode: 'missing', geo };
  if (geo.w > 0 && geo.h > 0 && geo.hitIsTarget) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.x, y: geo.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });
    return { mode: 'mouse', geo };
  }
  await cdp.evaluate(`(function(){ const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return true; })()`);
  return { mode: 'element', geo, reason: geo.w === 0 ? 'rect=0（不可见）' : 'elementFromPoint 未命中' };
}

async function shot(cdp, file) {
  try { await cdp.send('Page.bringToFront', {}, 8000); } catch { /* */ }
  const size = await cdp.evaluate('(function(){ return { w: Math.max(1, Number(window.innerWidth) || 1280), h: Math.max(1, Number(window.innerHeight) || 800) }; })()') || { w: 1280, h: 800 };
  try { await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false }, 8000); } catch { /* */ }
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
        lastErr = '返回没有 data';
      } catch (e) { lastErr = String((e && e.message) || e); }
      await sleep(800);
    }
  } finally {
    try { await cdp.send('Emulation.clearDeviceMetricsOverride', {}, 5000); } catch { /* */ }
  }
  return { ok: false, error: lastErr, file: path.basename(file) };
}

async function openDecisionFloat(cdp) {
  // T-e2a3：右下四行默认收起（只留 #side-float-toggle），先点开容器，否则行元素 rect=0、只能退 element.click()
  const toggle = await realClick(cdp, '#side-float-toggle');
  await sleep(700);
  const floatState = await cdp.evaluate(`(function(){
    const box = document.getElementById('side-float');
    const pill = document.getElementById('decision-box-pill');
    const r = pill ? pill.getBoundingClientRect() : null;
    return {
      expanded: box ? box.getAttribute('data-float-expanded') : '',
      pillW: r ? Math.round(r.width) : 0, pillH: r ? Math.round(r.height) : 0,
    };
  })()`);
  const pill = await realClick(cdp, '#decision-box-pill');
  await sleep(800);
  let state = await cdp.evaluate(`(function(){
    const box = document.getElementById('decision-box');
    const panel = document.getElementById('decision-box-panel');
    return { expanded: box ? box.dataset.state : '', panelHidden: panel ? Boolean(panel.hidden) : true };
  })()`);
  if (!state || state.panelHidden) {
    await cdp.evaluate(`(function(){ setDecisionExpanded(true); return true; })()`);
    await sleep(600);
    state = await cdp.evaluate(`(function(){ const panel = document.getElementById('decision-box-panel'); return { expanded: 'forced', panelHidden: panel ? Boolean(panel.hidden) : true }; })()`);
  }
  // 等列表出第一条（IPC 读盘）
  for (let i = 0; i < 40; i += 1) {
    const count = await cdp.evaluate('document.querySelectorAll("#decision-box-list .decision-row").length');
    if (Number(count) >= 1) break;
    await sleep(300);
  }
  return { toggleMode: toggle.mode, floatState, mode: pill.mode, state };
}

async function boxRowInfo(cdp, id) {
  return cdp.evaluate(`(function(){
    const row = document.querySelector('#decision-box-list .decision-row[data-decision-id=' + JSON.stringify(${JSON.stringify(id)}) + ']');
    if (!row) return { missing: true };
    const badge = row.querySelector('.badge');
    return {
      status: row.getAttribute('data-status') || '', badge: badge ? badge.textContent : '',
      hasDecidedLine: Boolean(row.querySelector('.decision-decided')),
      error: (row.querySelector('[data-decision-error]') || {}).textContent || '',
      choices: Array.from(row.querySelectorAll('.decision-opt')).map((b) => ({ opt: b.getAttribute('data-decision-opt'), selected: b.classList.contains('selected') })),
      submit: Boolean(row.querySelector('[data-decision-submit]')),
    };
  })()`);
}
async function bannerInfo(cdp) {
  return cdp.evaluate(`(function(){
    const el = document.getElementById('decision-error-banner');
    const text = document.getElementById('decision-error-text');
    if (!el) return { missing: true };
    const r = el.getBoundingClientRect();
    const row = document.querySelector('#decision-box-list .decision-row');
    const rr = row ? row.getBoundingClientRect() : null;
    return {
      hidden: Boolean(el.hidden), text: (text ? text.textContent : '').trim(),
      visible: !el.hidden && r.width > 0 && r.height > 0,
      insidePanel: Boolean(el.closest('#decision-box')),
      rowTop: rr ? Math.round(rr.top) : null,
      bannerTop: Math.round(r.top), winH: Math.round(window.innerHeight || 0),
    };
  })()`);
}

async function waitFile(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const box = readBox();
    if (box && pred(box)) return box;
    await sleep(250);
  }
  return readBox();
}

async function countsViaIpc(cdp, payload) {
  const body = JSON.stringify(payload || {});
  return cdp.evaluate(`(async function(){ const wb = window.workbench || {}; if (typeof wb.ownerPendingCounts !== "function") return { ok:false, code:"IPC_MISSING" }; try { return await wb.ownerPendingCounts(${body}); } catch (e) { return { ok:false, code:"IPC_FAILED", message:String((e&&e.message)||e) }; } })()`, 20000);
}
async function anchorsInfo(cdp) {
  return cdp.evaluate(`(function(){
    const read = (id) => { const n = document.getElementById(id); return n ? { text: (n.id === 'decision-box-pill' ? (n.querySelector('#decision-box-count') || n).textContent : n.textContent).trim(), count: n.getAttribute('data-count') } : null; };
    return { decisions: read('decision-box-pill'), reviews: read('owner-review-count'), accepts: read('accept-badge') };
  })()`);
}
async function rowElements(cdp, id) {
  return cdp.evaluate(`(function(){
    const row = document.querySelector('#decision-box-list .decision-row[data-decision-id=' + JSON.stringify(${JSON.stringify(id)}) + ']');
    if (!row) return { missing: true };
    const q = (s) => { const n = row.querySelector(s); return n ? n.textContent.trim() : ''; };
    return {
      text: row.textContent.replace(/\\s+/g, ' ').slice(0, 400),
      source: q('[data-decision-source]'), summary: q('.decision-line:not(.muted):not(.redirect)'),
      question: q('.decision-line.muted:nth-of-type(3)'),
      hasDefault: Boolean(row.querySelector('[data-decision-default]')), hasImpact: Boolean(row.querySelector('[data-decision-impact]')), hasDue: Boolean(row.querySelector('[data-decision-due]')),
      choices: Array.from(row.querySelectorAll('.decision-opt')).map((b) => b.getAttribute('data-decision-opt')),
      redirect: row.querySelector('[data-decision-redirect]') ? row.querySelector('[data-decision-redirect]').getAttribute('data-decision-redirect') : '',
    };
  })()`);
}
async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const realBoxBefore = statOf(REAL_BOX);
  const realStoreBefore = statOf(REAL_STORE);
  const seed = seedSandbox();
  check('沙盘 seed：决策箱 4 条（3 完整 + 1 缺项）、工作流 3 行', Boolean(seed.box && (seed.box.items || []).length === 4 && seed.wf && Object.keys(seed.wf.requirements).length === 3), { items: seed.box && (seed.box.items || []).length });
  check('真实 决策箱.json 基线可读', Boolean(realBoxBefore), realBoxBefore);

  const inst = await launchElectron(PORT);
  check('隔离实例启动 + CDP 连上 renderer', Boolean(inst), PORT);
  const shots = [];
  try {
    if (inst) {
      const cdp = inst.cdp;
      // 等三锚点就绪（owner-review.js 建壳）
      let anchors = null;
      for (let i = 0; i < 60; i += 1) {
        anchors = await anchorsInfo(cdp);
        if (anchors && anchors.reviews && anchors.accepts) break;
        await sleep(500);
      }
      const ipc = await countsViaIpc(cdp, { projectId: seed.store.activeProjectId });
      check('① owner:pending-counts IPC 返回 3/2/1', Boolean(ipc && ipc.ok !== false && Number(ipc.decisions) === 3 && Number(ipc.reviews) === 2 && Number(ipc.accepts) === 1), ipc);
      // 触发一次刷新后读锚点
      await cdp.evaluate('(function(){ if (typeof decisionRefresh === "function") decisionRefresh("test"); return true; })()');
      await sleep(1500);
      anchors = await anchorsInfo(cdp);
      check('② 决策箱胶囊 data-count = IPC decisions(3)', Boolean(anchors && anchors.decisions && anchors.decisions.count === '3'), anchors && anchors.decisions);
      check('② 评审待评估 #owner-review-count = IPC reviews(2)', Boolean(anchors && anchors.reviews && anchors.reviews.count === '2'), anchors && anchors.reviews);
      check('② 验收角标 #accept-badge = IPC accepts(1)', Boolean(anchors && anchors.accepts && anchors.accepts.count === '1'), anchors && anchors.accepts);
      const drawer = await cdp.evaluate('(function(){ const n = document.getElementById("decision-box-drawer-unread"); return n ? { text: n.textContent.trim(), count: n.getAttribute("data-count") } : null; })()');
      check('② 抽屉顶部「待决」= ownerPendingCounts().decisions(3)', Boolean(drawer && drawer.count === '3' && /待决 3/.test(drawer.text || '')), drawer);

      const opened = await openDecisionFloat(cdp);
      check('决策箱浮动组可展开（胶囊可点）', Boolean(opened && opened.state && opened.state.panelHidden === false), opened);
      const rowOk = await rowElements(cdp, ITEM_OK);
      check('③ 完整条目展示七要素（默认/影响/截止齐）', Boolean(rowOk && !rowOk.missing && rowOk.hasDefault && rowOk.hasImpact && rowOk.hasDue && (rowOk.choices || []).length >= 2), rowOk);
      check('③ 条目文本含来源与问题', Boolean(rowOk && /来源：/.test(rowOk.text || '') && /要决定什么：/.test(rowOk.text || '')), rowOk && rowOk.text);
      const rowRedir = await rowElements(cdp, ITEM_REDIRECT);
      check('④ 转投条目显示「已转投到 review_dialog」', Boolean(rowRedir && !rowRedir.missing && rowRedir.redirect === 'review_dialog' && /已转投到/.test(rowRedir.text || '')), rowRedir);
      const rowMissing = await rowElements(cdp, ITEM_INCOMPLETE);
      check('⑤ 缺项条目不在 DOM（不展示）', Boolean(rowMissing && rowMissing.missing === true), rowMissing);
      const rowCount = await cdp.evaluate('document.querySelectorAll("#decision-box-list .decision-row").length');
      check('⑤ 列表只渲染 3 条完整条目', Number(rowCount) === 3, rowCount);
      const hiddenNote = await cdp.evaluate('(function(){ const n = document.querySelector("#decision-box-list [data-decision-hidden]"); return n ? { count: n.getAttribute("data-decision-hidden"), text: n.textContent.trim() } : null; })()');
      check('⑤ 缺项不静默：列表底部提示「另有 1 条历史条目未展示」', Boolean(hiddenNote && hiddenNote.count === '1' && /另有 1 条历史条目/.test(hiddenNote.text || '')), hiddenNote);
      shots.push(await shot(cdp, path.join(EVID, '01-三入口数字与七要素.png')));
      await cdp.evaluate('(function(){ if (typeof setDecisionExpanded === "function") setDecisionExpanded(false); return true; })()');
      await sleep(400);
      shots.push(await shot(cdp, path.join(EVID, '02-收起态三入口数字.png')));
    }
  } finally {
    await closeElectron(inst);
  }

  const realBoxAfter = statOf(REAL_BOX);
  const realStoreAfter = statOf(REAL_STORE);
  check('隔离：真实 决策箱.json 未被改动（sha256+mtime 同）', Boolean(realBoxBefore && realBoxAfter && realBoxBefore.sha256 === realBoxAfter.sha256 && realBoxBefore.mtimeMs === realBoxAfter.mtimeMs), { before: realBoxBefore, after: realBoxAfter });
  check('隔离：真实 workbench.json 未被改动（sha256+mtime 同）', Boolean(realStoreBefore && realStoreAfter && realStoreBefore.sha256 === realStoreAfter.sha256 && realStoreBefore.mtimeMs === realStoreAfter.mtimeMs), { before: realStoreBefore, after: realStoreAfter });

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  const report = { at: new Date().toISOString(), task: 'T-20261115-131211-2da7', port: PORT, pass, fail, results, shots };
  fs.writeFileSync(path.join(EVID, '5016-ui-run.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(EVID, '5016-ui-run.log'), log.join('\n') + '\n', 'utf8');
  console.log(`\n=== R-5016 界面侧断言：${pass} 通过 / ${fail} 失败 ===`);
  for (const r of results) if (!r.ok) console.log('✗ ' + r.name + '  ' + JSON.stringify(r.detail).slice(0, 400));
  console.log('证据：' + EVID);
  if (fail) process.exitCode = 1;
}

main().catch((error) => {
  console.error('脚本异常：' + String((error && error.stack) || error));
  process.exitCode = 1;
});
