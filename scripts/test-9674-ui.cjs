#!/usr/bin/env node
'use strict';
/**
 * R-9674（T-20261118-133655-05b1）真窗口复验：会话排队面板「最近活动 + 全员摘要」。
 *
 * 覆盖：
 *   AC1 三源优先级（快照 lastEventAt → 唤醒.jsonl → 任务 done → 未知）—— 断言限定 [data-sq-row]
 *   AC2 摘要 ≤24 字（超出补「…」）/ 行内时间 mm-dd hh:mm / title 含 ISO+来源 / [data-sq-last-event] 数量不变
 *   AC3 顶部 [data-sq-summary]：all-idle 文案与 mode、有 running → busy 且含「思考中 mm:ss」
 *   AC5② 团队台第 4 列 data-activity-lastActivity 文本 `<HH:MM> <摘要>`、title 含 ISO
 *   AC5③ 1280 宽团队台无横向滚动
 *   AC5④ 主进程单次「全员最近活动」计算 p95 ≤50ms（10 次）
 *   AC5⑤ 真窗口截图 ≥2（全员空闲 / 有人思考）
 *   AC5⑦ 任务 status→done 后 ≤2s 摘要自动更新（任务/ 目录 fs.watch + 同一推送事件）
 *
 * 隔离：AWB_DATA_DIR + TEAM_ROOT 全指沙盘；真实 data/userdata 与 团队/状态 只做「sha256+mtime 未变」断言。
 * 用法：node scripts/test-9674-ui.cjs
 * 产出：程序员A/产出/证据-9674/（截图 + run-9674-ui.json + 计划日志），目录可用 AWB_9674_OUT 覆盖。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, '项目', '工作台改造修复');
const PNAME = '工作台改造修复';
const SB = path.join(ROOT, '_tmp', `t9674-${process.pid}-${Date.now()}`);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const REAL_TEAM_JSON = path.join(ROOT, '团队', '状态', '团队.json');
const PORT = Number(process.env.AWB_9674_PORT || (9481 + (process.pid % 30)));
const EVID = process.env.AWB_9674_OUT ? path.resolve(process.env.AWB_9674_OUT) : path.join(PROJ, '程序员A', '产出', '证据-9674');
const PROJECT_STATE = path.join(TEAM, '状态', '项目', PNAME);
const TASK_DIR = path.join(PROJECT_STATE, '任务');

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 420)}`);
  if (!ok) process.exitCode = 1;
}
function statOf(file) {
  try {
    const st = fs.statSync(file);
    return { sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), mtimeMs: st.mtimeMs, bytes: st.size };
  } catch { return null; }
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
      if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text).slice(0, 500) };
      return out && out.result ? out.result.value : undefined;
    } catch (e) { return { __cdperror: String((e && e.message) || e) }; }
  }
}

/* ───────── 沙盘夹具（真实团队名册 + 自造三源数据，隔离实例） ───────── */
const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(PROJECT_STATE, { recursive: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  for (const name of ['团队宪法.md', '项目铁律.md']) {
    try { fs.copyFileSync(path.join(ROOT, '团队', name), path.join(TEAM, name)); } catch { /* 缺文档不影响面板 */ }
  }
  const team = JSON.parse(fs.readFileSync(REAL_TEAM_JSON, 'utf8').replace(/^\uFEFF/, ''));
  for (const member of team.members || []) member.sessionId = '';
  team.activeProject = PNAME;
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  // ① 快照：六角色 known/queued=0 → 五态 idle；pm 带 lastEventAt（快照源）
  const snapshotAt = new Date().toISOString();
  const roles = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'].map((role) => ({
    role, known: true, active: false, running: false, queued: 0, byPlacement: { queued: 0, steering: 0, context: 0 },
    sessionId: '', pendingInput: [], lastEventAt: role === 'pm' ? iso(2 * 60 * 1000) : '', lastOkAt: '',
  }));
  fs.writeFileSync(path.join(TEAM, '状态', '会话排队.json'), JSON.stringify({
    schemaVersion: 2, at: snapshotAt, project: PNAME, host: 'fixture', staleMs: 60000, roles,
  }, null, 2) + '\n', 'utf8');
  // ② 唤醒.jsonl：tester 一条 MERGED_PENDING（跳过源）+ 若干干扰行
  const wakeRows = [
    { at: iso(30 * 60 * 1000), to: 'product', ok: true },
    { at: iso(5 * 60 * 1000), to: 'tester', ok: true, skipped: 'MERGED_PENDING', reason: 'merged' },
    { at: iso(4 * 60 * 1000), to: 'product', ok: true, skipped: 'ALREADY_DELIVERED' },
  ];
  fs.writeFileSync(path.join(PROJECT_STATE, '唤醒.jsonl'), wakeRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  // ③ 任务：analyst 一条 done（任务源）；programmer2 初始无 done（= 未知源，后面用来验 AC5⑦）
  fs.mkdirSync(TASK_DIR, { recursive: true });
  const writeTask = (id, row) => fs.writeFileSync(path.join(TASK_DIR, `${id}.json`), JSON.stringify(row, null, 2) + '\n', 'utf8');
  writeTask('T-fixture-analyst-done', {
    id: 'T-fixture-analyst-done', project: PNAME, type: 'task', title: '夹具：分析需求总览并回执', owner: 'analyst',
    status: 'done', doneAt: iso(12 * 60 * 1000), updatedAt: iso(12 * 60 * 1000), createdAt: iso(60 * 60 * 1000),
  });
  writeTask('T-fixture-pm-open', { id: 'T-fixture-pm-open', project: PNAME, type: 'task', title: '夹具：未完成任务', owner: 'pm', status: 'working', doneAt: null, updatedAt: iso(20 * 60 * 1000) });
  // workbench.json：本项目映射到沙盘团队
  const store = JSON.parse(fs.readFileSync(REAL_STORE, 'utf8').replace(/^\uFEFF/, ''));
  const project = (store.projects || []).find((item) => item && String(item.teamName || item.name || '') === PNAME);
  if (!project) throw new Error(`真实 workbench.json 里没有团队项目 ${PNAME}`);
  project.teamName = PNAME;
  store.projects = [project];
  store.activeProjectId = project.id;
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n', 'utf8');
  return { rows: wakeRows.length };
}

async function launch() {
  const env = { ...process.env, AWB_DATA_DIR: DATA, TEAM_ROOT: TEAM, TEAM_SELFTEST: '1' };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], {
    cwd: ROOT, env, stdio: 'ignore', windowsHide: false,
  });
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
  for (let i = 0; i < 160; i += 1) {
    const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(document.getElementById("session-queue-panel"))');
    if (ready === true) break;
    await sleep(500);
  }
  const guest = await waitTarget(PORT, 8000, (item) => item && item.type === 'webview');
  if (guest) {
    try {
      const gws = new WebSocket(guest.webSocketDebuggerUrl);
      await new Promise((resolve) => { gws.addEventListener('open', resolve, { once: true }); setTimeout(resolve, 3000); });
      gws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: 'about:blank' } }));
      await sleep(600);
    } catch { /* webview 关掉不影响断言 */ }
  }
  return { child, cdp, ws };
}
async function close(inst) {
  if (!inst) return;
  try { inst.cdp.send('Browser.close', {}, 4000).catch(() => {}); } catch { /* ignore */ }
  await sleep(900);
  try { inst.ws.close(); } catch { /* ignore */ }
  try { inst.child.kill(); } catch { /* ignore */ }
  await sleep(600);
  try {
    if (inst.child && inst.child.pid && inst.child.exitCode === null) {
      spawnSync('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
  } catch { /* ignore */ }
}
async function scrollTo(cdp, selector) {
  return cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const node = el.parentElement;
    while (node && node !== document.body) {
      const cs = getComputedStyle(node);
      if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 40) {
        const r = el.getBoundingClientRect();
        const nr = node.getBoundingClientRect();
        node.scrollTop += (r.top - nr.top) - 40;
        return { scroller: node.id || String(node.className || ''), scrollTop: Math.round(node.scrollTop) };
      }
      node = node.parentElement;
    }
    window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - 60));
    return { scroller: 'window' };
  })()`);
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
        if (buf.length > 4000) return buf.length;
      }
    } catch { /* 重试 */ }
    await sleep(600);
  }
  return 0;
}

const READ = `(() => {
  const txt = (n) => (n ? String(n.textContent || '').trim() : '');
  const rows = Array.from(document.querySelectorAll('[data-sq-row]')).map((row) => {
    const act = row.querySelector('[data-sq-last-activity]');
    const timeEl = row.querySelector('[data-sq-last-activity-time]');
    return {
      role: row.dataset.role || '',
      actIso: act ? String(act.getAttribute('data-sq-last-activity') || '') : null,
      actText: act ? String(act.getAttribute('data-sq-last-activity-text') || '') : null,
      actSource: act ? String(act.getAttribute('data-sq-last-activity-source') || '') : null,
      actTime: txt(timeEl),
      actTitle: act ? String(act.title || '') : '',
    };
  });
  const summary = document.querySelector('[data-sq-summary]');
  const liveRows = Array.from(document.querySelectorAll('[data-live-row]'));
  return {
    rows,
    summaryText: txt(summary),
    summaryMode: summary ? String(summary.getAttribute('data-sq-summary-mode') || '') : null,
    summaryCached: summary ? String(summary.getAttribute('data-sq-summary-cached') || '') : '',
    lastEventCount: document.querySelectorAll('[data-sq-last-event]').length,
    lastEventInSqRows: Array.from(document.querySelectorAll('[data-sq-row] [data-sq-last-event]')).length,
    liveRowCount: liveRows.length,
    drawerOpen: (() => { const d = document.getElementById('team-drawer'); return Boolean(d && !d.hidden); })(),
  };
})()`;

const TEAM_COL = `(() => {
  const txt = (n) => (n ? String(n.textContent || '').trim() : '');
  const cells = Array.from(document.querySelectorAll('[data-activity-lastActivity]'));
  const heads = Array.from(document.querySelectorAll('[data-activity-head]')).map((n) => n.getAttribute('data-activity-head'));
  const list = document.querySelector('.legacy-team-list');
  return {
    headKeys: heads,
    cellCount: cells.length,
    sample: cells.slice(0, 3).map((c) => ({ text: txt(c), title: String(c.title || ''), w: Math.round(c.getBoundingClientRect().width) })),
    scrollWidth: list ? list.scrollWidth : null,
    clientWidth: list ? list.clientWidth : null,
    docScrollWidth: document.documentElement.scrollWidth,
    docClientWidth: document.documentElement.clientWidth,
  };
})()`;

(async () => {
  fs.mkdirSync(EVID, { recursive: true });
  const before = { team: statOf(REAL_TEAM_JSON), store: statOf(REAL_STORE) };
  const seeded = seed();
  check('沙盘就绪（名册真实副本 + 三源夹具）', seeded.rows >= 3, seeded);

  const inst = await launch();
  if (!inst) {
    check('真窗口启动（run-electron + CDP）', false, `端口 ${PORT} 未等到 renderer/index.html`);
    fs.writeFileSync(path.join(EVID, 'run-9674-ui.json'), JSON.stringify({ results }, null, 2) + '\n', 'utf8');
    process.exit(1);
  }
  const { cdp } = inst;
  try {
    let drawerOpen = false;
    for (let i = 0; i < 8 && !drawerOpen; i += 1) {
      await cdp.evaluate("(() => { const b = document.getElementById('team-pill'); if (b) b.click(); return true; })()");
      await sleep(900);
      drawerOpen = await cdp.evaluate("(() => { const d = document.getElementById('team-drawer'); return Boolean(d && !d.hidden); })()") === true;
    }
    check('团队台抽屉打开（面板与团队台都在同一抽屉）', drawerOpen === true, { drawerOpen });
    // 任务索引是后台分批建的（1024 文件 ≈ 240ms）→ 首次 refresh 后等 1.2 秒再读
    await cdp.evaluate("(async () => { if (typeof window.__sqRefresh === 'function') await window.__sqRefresh(); return true; })()");
    await sleep(1400);
    await cdp.evaluate("(async () => { if (typeof window.__sqRefresh === 'function') await window.__sqRefresh(); return true; })()");
    await sleep(600);
    let ui = await cdp.evaluate(READ);
    const byRole = Object.fromEntries((ui.rows || []).map((r) => [r.role, r]));
    // 落一份模型快照（含 activityMeta：唤醒/任务索引状态），排障与证据都用它
    try {
      const modelJson = await cdp.evaluate('(() => { try { return JSON.stringify(window.__sqModel()); } catch (e) { return "null"; } })()');
      fs.writeFileSync(path.join(EVID, 'run-model.json'), String(modelJson || 'null'), 'utf8');
    } catch { /* 快照失败不影响断言 */ }

    check('AC4① [data-sq-row] 仍恰 6 行、[data-live-row] 恰 6 行', (ui.rows || []).length === 6 && ui.liveRowCount === 6, { sq: (ui.rows || []).length, live: ui.liveRowCount });
    check('AC1① 快照源：pm 行 = lastEventAt 的 ISO + 「会话状态更新」+ source=snapshot',
      Boolean(byRole.pm) && byRole.pm.actSource === 'snapshot' && /会话状态更新/.test(byRole.pm.actText)
      && Math.abs(Date.parse(byRole.pm.actIso) - (NOW - 2 * 60 * 1000)) < 5000,
      byRole.pm);
    check('AC1② 唤醒源：tester 行 = 「唤醒跳过（合并）」+ source=wake',
      Boolean(byRole.tester) && byRole.tester.actSource === 'wake' && byRole.tester.actText === '唤醒跳过（合并）', byRole.tester);
    check('AC1③ 任务源：analyst 行以「任务完成：」开头 + source=task',
      Boolean(byRole.analyst) && byRole.analyst.actSource === 'task' && /^任务完成：/.test(byRole.analyst.actText), byRole.analyst);
    check('AC1④ 三源全空：programmer2 行 = 「未知」+ source=none + data-sq-last-activity 空',
      Boolean(byRole.programmer2) && byRole.programmer2.actSource === 'none' && byRole.programmer2.actText === '未知'
      && String(byRole.programmer2.actIso) === '', byRole.programmer2);
    check('AC2① 摘要 ≤24 字（含省略号时 ≤25）', (ui.rows || []).every((r) => Array.from(String(r.actText || '')).length <= 25),
      (ui.rows || []).map((r) => [r.role, Array.from(String(r.actText || '')).length]));
    check('AC2② 行内时间匹配 mm-dd hh:mm', (ui.rows || []).filter((r) => r.actSource !== 'none').every((r) => /^\d{2}-\d{2} \d{2}:\d{2}$/.test(r.actTime)),
      (ui.rows || []).map((r) => [r.role, r.actTime]));
    check('AC2③ title 含完整 ISO 与来源标识', (ui.rows || []).filter((r) => r.actSource !== 'none')
      .every((r) => r.actTitle.includes(r.actIso) && /来源/.test(r.actTitle)), (ui.rows || []).map((r) => r.actTitle).slice(0, 2));
    check('AC2④ 负例：data-sq-last-event 仍只在 live 行（[data-sq-row] 内 0 命中）',
      ui.lastEventInSqRows === 0 && ui.lastEventCount === ui.liveRowCount, { total: ui.lastEventCount, inSqRows: ui.lastEventInSqRows, live: ui.liveRowCount });
    check('AC3① 全员 idle → mode=all-idle + 全员空闲 · 最近活动：… 文案',
      ui.summaryMode === 'all-idle' && /^全员空闲 · 最近活动：.+ \d{2}:\d{2} .+（\d+ 分钟前）$/.test(ui.summaryText),
      { mode: ui.summaryMode, text: ui.summaryText });
    const shot1 = await shot(cdp, path.join(EVID, '01-全员空闲-最近活动.png'));
    check('AC5⑤ 截图①（全员空闲）落盘且非空白', shot1 > 4000, { bytes: shot1 });

    // ── AC5⑦ 任务 done 后 ≤2s 自动更新（写沙盘 任务/ → 主进程 watch → 同一推送事件 → 面板重绘）──
    const taskFile = path.join(TASK_DIR, 'T-fixture-programmer2-live.json');
    const writeDone = () => fs.writeFileSync(taskFile, JSON.stringify({
      id: 'T-fixture-programmer2-live', project: PNAME, type: 'task', title: '夹具：任务完成后两秒内更新',
      owner: 'programmer2', status: 'done', doneAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8');
    const t0 = Date.now();
    writeDone();
    let elapsed = -1;
    let probe = null;
    for (let i = 0; i < 40; i += 1) {
      await sleep(100);
      probe = await cdp.evaluate(READ);
      const row = (probe.rows || []).find((r) => r.role === 'programmer2');
      if (row && row.actSource === 'task' && /^任务完成：/.test(String(row.actText || ''))) { elapsed = Date.now() - t0; break; }
    }
    check('AC5⑦ 任务 done 后 ≤2000ms 面板摘要自动更新（fs.watch + 同一推送事件，无新增定时器）',
      elapsed > 0 && elapsed <= 2000, { elapsedMs: elapsed, row: (probe && probe.rows || []).find((r) => r.role === 'programmer2') });

    // ── AC3② 有人思考 → mode=busy 且含「思考中 mm:ss」──
    const snapFile = path.join(TEAM, '状态', '会话排队.json');
    const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
    const pmRow = (snap.roles || []).find((r) => r.role === 'pm');
    pmRow.running = true; pmRow.runningSince = new Date(Date.now() - 65 * 1000).toISOString(); pmRow.active = true;
    snap.at = new Date().toISOString();
    fs.writeFileSync(snapFile, JSON.stringify(snap, null, 2) + '\n', 'utf8');
    await sleep(1500);
    await cdp.evaluate("(async () => { if (typeof window.__sqRefresh === 'function') await window.__sqRefresh(); return true; })()");
    await sleep(600);
    ui = await cdp.evaluate(READ);
    check('AC3② 有人 running → mode=busy 且文本含「思考中 mm:ss」',
      ui.summaryMode === 'busy' && /思考中 \d{2}:\d{2}/.test(ui.summaryText), { mode: ui.summaryMode, text: ui.summaryText });
    const shot2 = await shot(cdp, path.join(EVID, '02-有人思考-全员摘要.png'));
    check('AC5⑤ 截图②（有人思考）落盘且非空白', shot2 > 4000, { bytes: shot2 });

    // ── AC5④ 性能：10 次「全员最近活动」模型计算 p95 ≤50ms（真实规模唤醒索引已在内存）──
    const times = await cdp.evaluate(`(async () => {
      const api = window.workbench && window.workbench.teamSessionQueue;
      if (typeof api !== 'function') return null;
      const out = [];
      for (let i = 0; i < 10; i += 1) {
        const t = performance.now();
        const m = await api({});
        out.push({ ms: performance.now() - t, cached: Boolean(m && m.activityMeta && m.activityMeta.cached), metaMs: m && m.activityMeta ? m.activityMeta.ms : null });
      }
      return out;
    })()`);
    // 口径：p95 取「主进程单次计算耗时」activityMeta.ms（§6.5 的预算是计算本身，不含 IPC 序列化与
    // sched advice 子进程等面板其它开销）；IPC 往返耗时另记一笔作参考，不作判据。
    const msList = Array.isArray(times) ? times.map((t) => Number(t.metaMs)).filter((v) => Number.isFinite(v)).sort((a, b) => a - b) : [];
    const p95 = msList.length ? msList[Math.min(msList.length - 1, Math.ceil(0.95 * msList.length) - 1)] : null;
    const rtt = Array.isArray(times) ? times.map((t) => Number(t.ms)).sort((a, b) => a - b) : [];
    const rttP95 = rtt.length ? rtt[Math.min(rtt.length - 1, Math.ceil(0.95 * rtt.length) - 1)] : null;
    check('AC5④ 主进程单次「全员最近活动」计算 p95 ≤50ms（10 次，activityMeta.ms）', p95 != null && p95 <= 50,
      { p95: p95 && Number(p95.toFixed(2)), samples: msList, ipcRttP95: rttP95 && Number(rttP95.toFixed(1)) });
    const metaMs = Array.isArray(times) && times[0] ? times.map((t) => t.metaMs) : [];
    check('AC5④ 主进程自报耗时字段 activityMeta.ms 存在（<50ms）', metaMs.every((v) => Number.isFinite(Number(v)) && Number(v) < 50),
      { metaMs });
    check('AC5④ 未触发 cached 降级（正常通道）', Array.isArray(times) && times.every((t) => t.cached === false), { cached: Array.isArray(times) && times.map((t) => t.cached) });

    // ── AC5① / AC5② / AC5③ 团队台第 4 列（1280 宽无横向滚动）──
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(800);
    const col = await cdp.evaluate(TEAM_COL);
    check('AC5① 团队台活动列 4 列（含 lastActivity）且单元格锚点齐', Array.isArray(col.headKeys) && col.headKeys.length === 4
      && col.headKeys[3] === 'lastActivity' && col.cellCount >= 1, col);
    check('AC5② 单元格文本 = `<HH:MM> <摘要>`（样例匹配 /\\d{2}:\\d{2} .+/）且 title 含 ISO',
      (col.sample || []).some((s) => /^\d{2}:\d{2} .+/.test(s.text) && /\d{4}-\d{2}-\d{2}T/.test(s.title)), col.sample);
    check('AC5③ 1280 宽团队台无横向滚动（scrollWidth ≤ clientWidth+1）',
      col.scrollWidth != null && col.scrollWidth <= col.clientWidth + 1, { scrollWidth: col.scrollWidth, clientWidth: col.clientWidth });
    const colW = (col.sample || []).map((s) => s.w);
    check('AC5③ 最近活动列宽 52–56px', colW.length > 0 && colW.every((w) => w >= 52 && w <= 56), { widths: colW });
    const shot3 = await shot(cdp, path.join(EVID, '03-团队台-最近活动列-1280.png'));
    check('AC5③ 团队台 1280 截图落盘', shot3 > 4000, { bytes: shot3 });
    await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});

    // ── 隔离：真实团队状态 / workbench.json 一个字节都没被写 ──
    const after = { team: statOf(REAL_TEAM_JSON), store: statOf(REAL_STORE) };
    check('隔离：真实 团队/状态/团队.json 未被改写（sha256+mtime 不变）',
      before.team && after.team && before.team.sha256 === after.team.sha256 && before.team.mtimeMs === after.team.mtimeMs, { before: before.team, after: after.team });
    check('隔离：真实 data/userdata/workbench.json 未被改写（sha256+mtime 不变）',
      before.store && after.store && before.store.sha256 === after.store.sha256 && before.store.mtimeMs === after.store.mtimeMs, { before: before.store, after: after.store });
  } catch (e) {
    check('真窗口流程未抛异常', false, String((e && e.stack) || e).slice(0, 500));
  } finally {
    try { inst.cdp.send('Browser.close', {}, 4000).catch(() => {}); } catch { /* ignore */ }
    await sleep(700);
    try { inst.ws.close(); } catch { /* ignore */ }
    try { inst.child.kill(); } catch { /* ignore */ }
    await sleep(400);
    try {
      if (inst.child && inst.child.pid && inst.child.exitCode === null) spawnSync('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch { /* ignore */ }
    fs.rmSync(SB, { recursive: true, force: true });
  }

  const report = { task: 'T-20261118-133655-05b1', requirement: 'R-20261118-131106-9674', at: new Date().toISOString(), total: results.length, pass: results.filter((r) => r.ok).length, red: results.filter((r) => !r.ok).length, results };
  fs.writeFileSync(path.join(EVID, 'run-9674-ui.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  const shots = fs.readdirSync(EVID).filter((n) => n.endsWith('.png')).map((n) => {
    const st = fs.statSync(path.join(EVID, n));
    return { name: n, bytes: st.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(EVID, n))).digest('hex') };
  });
  fs.writeFileSync(path.join(EVID, 'shots.json'), JSON.stringify(shots, null, 2) + '\n', 'utf8');
  console.log(`\nSQ_9674_UI ${JSON.stringify({ total: report.total, pass: report.pass, red: report.red, shots: shots.length })}`);
  console.log('证据：' + path.join(EVID, 'run-9674-ui.json'));
  process.exit(report.red ? 1 : 0);
})();
