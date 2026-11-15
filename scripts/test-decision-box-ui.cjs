'use strict';
/**
 * B-20261115-162904-f6c0（P1）决策箱「回执 PM」真窗口断言：点一次必须真落盘；失败必须顶部红字且不得显示已回。
 *
 * 背景：Owner 16:20-16:26 在决策箱点了回复，真实 团队/状态/项目/工作台改造修复/决策箱.json 零写入；
 *       PM 用同一 decisionAck(channel=proxy) 从 CLI 调能写。说明后端可用，问题在 UI→IPC 段 / 失败不可见。
 *       本轮根因：决策箱自动刷新（fs.watch + 15 秒轮询）会在「点候选」与「点回执」之间重绘整个列表，
 *       选中态与意见被抹掉、提交按钮回到禁用；同时失败只写行内小字（会被下一次刷新吞掉），Owner 看到的就是「点了没反应」。
 *
 * 隔离：AWB_DATA_DIR + TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_WORKBENCH_JSON 全部指 _tmp/decision-box-ui，
 *       真实 data/userdata/workbench.json 与 团队/状态/项目/工作台改造修复/决策箱.json 只读（前后比对 sha256 + mtime 断言未变）。
 * 沙盘：复制真实 团队/（跳过 锁/邮箱），清空 members[].sessionId、activeProject、状态/启动/*.json；
 *       决策箱夹具两条：ITEM_OK（应落盘）、ITEM_BAD（注入未知 id → 必失败）。
 *
 * 用法：node scripts/test-decision-box-ui.cjs        （退出码 0=全绿，1=有红）
 *       端口 9431（可用 AWB_DECISION_UI_PORT 覆盖）；截图/结果落 程序员B/产出/证据-决策箱回执/
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
const BASE = path.join(ROOT, '_tmp', 'decision-box-ui');
const SB = path.join(BASE, 'sb');
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const STATE_DIR = path.join(TEAM, '状态', '项目', PROJECT);
const BOX_FILE = path.join(STATE_DIR, '决策箱.json');
const EVID = process.env.AWB_DECISION_UI_OUT
  ? path.resolve(process.env.AWB_DECISION_UI_OUT)
  : path.join(ROOT, '项目', PROJECT, '程序员B', '产出', '证据-决策箱回执');
const PORT = Number(process.env.AWB_DECISION_UI_PORT || 9431);
const ITEM_OK = 'D-20261115-999901-uibox';
const ITEM_BAD = 'D-20261115-999902-uibox';

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
  copyDir(REAL_TEAM, TEAM, (s) => /[\\/]锁([\\/]|$)/.test(s) || /[\\/]邮箱[\\/]/.test(s));
  const teamFile = path.join(TEAM, '状态', '团队.json');
  const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = '';
  fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
  const startDir = path.join(TEAM, '状态', '启动');
  if (fs.existsSync(startDir)) for (const f of fs.readdirSync(startDir)) if (f.endsWith('.json')) fs.rmSync(path.join(startDir, f), { force: true });
  const nowIso = new Date().toISOString();
  const item = (id, title) => ({
    id, title, summary: '夹具：真窗口点一次回执', question: '是否通过', source: { kind: 'fixture', ref: 'B-20261115-162904-f6c0' },
    createdAt: '2026-11-15T00:00:00.000Z', by: 'pm', status: 'open', options: ['通过', '打回', '其他'],
    readAt: null, answeredAt: null, archivedAt: null, updatedAt: nowIso,
  });
  fs.writeFileSync(BOX_FILE, JSON.stringify({
    schema: 1, project: PROJECT, updatedAt: '2026-11-15T00:00:00.000Z',
    items: [item(ITEM_OK, '夹具：回执应落盘'), item(ITEM_BAD, '夹具：注入失败应红字')],
  }, null, 2) + '\n', 'utf8');
  return { box: readBox(), store };
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

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const realBoxBefore = statOf(REAL_BOX);
  const realStoreBefore = statOf(REAL_STORE);
  const seed = seedSandbox();
  check('沙盘 seed 成功（夹具 2 条：应落盘 / 注入失败）', Boolean(seed.box && (seed.box.items || []).length === 2), seed.box && (seed.box.items || []).length);
  check('真实 决策箱.json 基线可读', Boolean(realBoxBefore), realBoxBefore);

  const inst = await launchElectron(PORT);
  check('隔离实例启动 + CDP 连上 renderer', Boolean(inst), PORT);
  const shots = [];
  try {
    if (inst) {
      const cdp = inst.cdp;
      const fnReady = await cdp.evaluate('typeof loadDecisionBox === "function"');
      check('renderer 暴露 loadDecisionBox（可手动触发刷新）', fnReady === true, String(fnReady));

      const opened = await openDecisionFloat(cdp);
      const rowOk = await boxRowInfo(cdp, ITEM_OK);
      check('浮动组能展开（决策箱胶囊可见，真鼠标可点）', Boolean(opened.floatState && opened.floatState.expanded === '1' && opened.floatState.pillW > 20 && opened.floatState.pillH > 10), opened);
      check('决策箱面板能打开且出现夹具行', !rowOk.missing && opened.state && opened.state.panelHidden === false, { opened, rowOk });
      check('行内有【回执 PM】按钮（不再默认禁用）', Boolean(rowOk && rowOk.submit), rowOk);

      // ① 点候选 → 选中
      await realClick(cdp, `#decision-box-list .decision-row[data-decision-id="${ITEM_OK}"] .decision-opt[data-decision-opt="通过"]`);
      await sleep(500);
      const picked = await boxRowInfo(cdp, ITEM_OK);
      check('点候选后为选中态', Boolean(picked && (picked.choices || []).some((c) => c.opt === '通过' && c.selected)), picked);

      // ② 自动刷新不得抹掉草稿（根因回归：fs.watch + 15 秒轮询会重绘列表）
      await cdp.evaluate('loadDecisionBox()');
      await sleep(1200);
      const afterRefresh = await boxRowInfo(cdp, ITEM_OK);
      check('刷新后已选候选仍保留（草稿不被重绘吞掉）', Boolean(afterRefresh && (afterRefresh.choices || []).some((c) => c.opt === '通过' && c.selected)), afterRefresh);

      // ③ 点一次必须真落盘
      const beforeBox = readBox();
      const submitted = await realClick(cdp, `#decision-box-list .decision-row[data-decision-id="${ITEM_OK}"] [data-decision-submit]`);
      const after = await waitFile((box) => {
        const it = (box.items || []).find((x) => x.id === ITEM_OK);
        return Boolean(it && String(it.status) === 'answered');
      }, 12000);
      const itemAfter = (after.items || []).find((x) => x.id === ITEM_OK) || {};
      check('点一次回执 → 决策箱.json 该条 status=answered', String(itemAfter.status || '') === 'answered', itemAfter);
      check('落盘后 updatedAt 前进', Boolean(after.updatedAt && after.updatedAt !== beforeBox.updatedAt), { before: beforeBox.updatedAt, after: after.updatedAt });
      check('落盘带回执消息 id 与选择', Boolean(itemAfter.receipt && itemAfter.receipt.messageId) && String((itemAfter.decision || {}).choice || '') === '通过', itemAfter.receipt || itemAfter.decision);
      await sleep(1200);
      const rowAfter = await boxRowInfo(cdp, ITEM_OK);
      check('界面行同步为已回执（磁盘驱动）', Boolean(rowAfter && rowAfter.status === 'answered' && /已回执/.test(rowAfter.badge || '')), { rowAfter, submitted });
      shots.push(await shot(cdp, path.join(EVID, '01-回执成功-已落盘.png')));

      // ④ 失败必须顶部红字且不得显示已回（注入未知 id → DECISION_NOT_FOUND）
      await cdp.evaluate('loadDecisionBox()');
      await sleep(900);
      const badRow = await boxRowInfo(cdp, ITEM_BAD);
      check('失败夹具行存在且为待决', Boolean(badRow && !badRow.missing && badRow.status === 'open'), badRow);
      await realClick(cdp, `#decision-box-list .decision-row[data-decision-id="${ITEM_BAD}"] .decision-opt[data-decision-opt="通过"]`);
      await sleep(300);
      await cdp.evaluate(`(function(){
        const row = document.querySelector('#decision-box-list .decision-row[data-decision-id="${ITEM_BAD}"]');
        if (row) row.setAttribute('data-decision-id', 'D-20261115-999902-missing');
        return true;
      })()`);
      await realClick(cdp, `#decision-box-list .decision-row[data-decision-id="D-20261115-999902-missing"] [data-decision-submit]`);
      await sleep(2500);
      const banner = await bannerInfo(cdp);
      check('失败 → 顶部红色横幅可见（不是行内小字）', Boolean(banner && banner.visible && /没提交成功/.test(banner.text || '')), banner);
      check('失败 → 横幅写明错误码（DECISION_NOT_FOUND）', Boolean(banner && /DECISION_NOT_FOUND/.test(banner.text || '')), banner);
      check('失败 → 横幅在决策面板上方（顶部，不在浮层里）', Boolean(banner && banner.visible && banner.insidePanel === false && banner.rowTop !== null && banner.bannerTop < banner.rowTop), banner);
      const badRowAfter = await boxRowInfo(cdp, ITEM_BAD);
      check('失败 → 该行仍是待决（不显示已回执）', Boolean(badRowAfter && badRowAfter.status === 'open' && !/已回执/.test(badRowAfter.badge || '') && badRowAfter.hasDecidedLine === false), badRowAfter);
      const boxNow = readBox();
      const badItem = (boxNow.items || []).find((x) => x.id === ITEM_BAD) || {};
      check('失败 → 磁盘该条仍 open（零副作用）', String(badItem.status || '') === 'open' && !badItem.receipt, badItem);
      shots.push(await shot(cdp, path.join(EVID, '02-回执失败-顶部红字.png')));
    }
  } finally {
    await closeElectron(inst);
  }

  // ⑤ 真实文件隔离：前后 sha256 + mtime 必须一致
  const realBoxAfter = statOf(REAL_BOX);
  const realStoreAfter = statOf(REAL_STORE);
  check('隔离：真实 决策箱.json 未被改动（sha256+mtime 同）', Boolean(realBoxBefore && realBoxAfter && realBoxBefore.sha256 === realBoxAfter.sha256 && realBoxBefore.mtimeMs === realBoxAfter.mtimeMs), { before: realBoxBefore, after: realBoxAfter });
  check('隔离：真实 workbench.json 未被改动（sha256+mtime 同）', Boolean(realStoreBefore && realStoreAfter && realStoreBefore.sha256 === realStoreAfter.sha256 && realStoreBefore.mtimeMs === realStoreAfter.mtimeMs), { before: realStoreBefore, after: realStoreAfter });

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  const report = { at: new Date().toISOString(), task: 'B-20261115-162904-f6c0', port: PORT, pass, fail, results, shots, notes };
  fs.writeFileSync(path.join(EVID, 'decision-box-ui-run.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(EVID, 'decision-box-ui-run.log'), log.join('\n') + '\n', 'utf8');
  console.log(`\n=== 决策箱回执真窗口断言：${pass} 通过 / ${fail} 失败 ===`);
  for (const r of results) if (!r.ok) console.log(`✗ ${r.name}  ${JSON.stringify(r.detail).slice(0, 400)}`);
  console.log('证据：' + EVID);
  if (fail) process.exitCode = 1;
}

main().catch((error) => {
  console.error('脚本异常：' + String((error && error.stack) || error));
  process.exitCode = 1;
});
