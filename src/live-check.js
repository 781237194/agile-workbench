'use strict';
/**
 * R-c9ac 会话实时状态面板自检（--live-check）—— 外壳侧自检入口。
 *
 * 结构照 src/sq-check.js（隔离沙盘 + 真实窗口 + executeJavaScript 读 DOM + 截图 + run.json），
 * 但**用例不复用** sq-check 的（它验投递四态/邮箱归类；本文件验实时状态：五态/秒表/最近事件/排队/推送降级/停滞）。
 *
 * 隔离口径（缺一不可）：
 *   ① 独立数据根 .live-check-data（AWB_LIVE_DATA 可覆盖）：workbench.json / userData / Chromium 缓存都在里面；
 *   ② 自建沙盘 TEAM_ROOT：六角色名册（**不带真实 sessionId**，避免误投递）；
 *   ③ TEAM_SELFTEST=1（由 --live-check 启动链注入）：沙盘不驱动 DSH、不弹通知；
 *   ④ 只写沙盘快照/唤醒日志/状态库，跑完比对真实 store 与真实名册 sha256+mtime 不变。
 *
 * 断言分组（与派单一一对应）：
 *   AC1 结构：section / 六行 / 既有 sq 六行 / 五锚点 / 秒表格式 / 来源行
 *   AC2 五态优先与排队口径：approval > blocked > thinking > queued > idle；只数 placement=queued
 *   AC3 推送：写盘→DOM ≤2000ms（10 次 p95）；静置 5s → degraded + 黄条含「最近成功」；再写回 push
 *   AC4 停滞：stallMs 缺省 600000（9 分不判/11 分判）；stallMs=1000 生效；-5/"abc" 回落且有可见提示；删快照→六行未接入
 *   AC5① 静态：src/renderer/session-queue-panel.js 的 setInterval 恰 2 处且各有 clearInterval 配对
 *   AC5② 静置 60s：team:session-queue（getSnapshot）调用 ≤1（渲染层侧计数；做不到如实 skipped）
 *
 * run.json 落在 AWB_LIVE_OUT（缺省 _tmp/live-check），含每条断言 name/status/detail 与截图路径+sha256。
 * 渲染层未落地时：最多重试 3 次（间隔 60s），仍缺 [data-live-row] → status=blocked，打印 LIVE_CHECK_BLOCKED，退出码 2。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 沙盘名册：六角色 + 固定夹具会话 id（绝不写真实 sessionId）。 */
const ROSTER = [
  { role: 'pm', name: '项目经理', sessionId: 'live-fixture-pm' },
  { role: 'programmer1', name: '高级程序员 A', sessionId: 'live-fixture-p1' },
  { role: 'programmer2', name: '高级程序员 B', sessionId: 'live-fixture-p2' },
  { role: 'product', name: '产品设计师', sessionId: 'live-fixture-product' },
  { role: 'analyst', name: '需求分析师', sessionId: 'live-fixture-analyst' },
  { role: 'tester', name: '测试人员', sessionId: 'live-fixture-tester' },
];

const RETRY_TIMES = Number(process.env.AWB_LIVE_RETRIES || 3);
const RETRY_GAP_MS = Number(process.env.AWB_LIVE_RETRY_GAP_MS || 60000);
const LATENCY_ROUNDS = 10;
const LATENCY_BUDGET_MS = 2000;
const IDLE_SEC = 60;

function sha256Of(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; }
}
function statOf(file) {
  try {
    const st = fs.statSync(file);
    return { exists: true, mtimeMs: st.mtimeMs, size: st.size, sha256: sha256Of(file) };
  } catch { return { exists: false, mtimeMs: 0, size: 0, sha256: '' }; }
}
function writeJson(file, value) {
  // 原子写：tmp → rename（主进程/渲染层可能同时在读，避免半截 JSON）。
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
function writeWake(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 沙盘准备：团队状态根建好 + 状态库缺失时从真实 store 只读复制一份。
 * 强制隔离：teamRoot / storeFile 落在真实 团队/ 或 项目/ 下直接抛错（不许回退真实路径）。
 */
function prepareLiveCheckSandbox(options = {}) {
  const teamRoot = String(options.teamRoot || '');
  const storeFile = String(options.storeFile || '');
  const repoRoot = path.resolve(__dirname, '..');
  const realTeam = path.join(repoRoot, '团队');
  const realProjects = path.join(repoRoot, '项目');
  const under = (p, base) => {
    const rp = path.resolve(p); const rb = path.resolve(base);
    return rp === rb || rp.startsWith(rb + path.sep);
  };
  const notIsolated = [['teamRoot', teamRoot], ['storeFile', storeFile]]
    .filter(([, p]) => p && (under(p, realTeam) || under(p, realProjects))).map(([k]) => k);
  if (!teamRoot || !storeFile || notIsolated.length) {
    const message = `LIVE_CHECK_NOT_ISOLATED 自检拒绝在真实树上运行（缺变量或路径指向真实 团队/ 项目）：${notIsolated.join(',') || 'teamRoot/storeFile 为空'}`;
    console.log(message);
    throw new Error(message);
  }
  fs.mkdirSync(path.join(teamRoot, '状态', '项目'), { recursive: true });
  const fallback = String(options.fallbackStoreFile || '');
  let needSeed = Boolean(storeFile && fallback && fs.existsSync(fallback) && !fs.existsSync(storeFile));
  if (!needSeed && storeFile && fallback && fs.existsSync(fallback) && fs.existsSync(storeFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8').replace(/^\uFEFF/, ''));
      needSeed = !parsed || !Array.isArray(parsed.projects) || !parsed.projects.length;
    } catch { needSeed = true; }
  }
  if (needSeed) {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.copyFileSync(fallback, storeFile);
    console.log('LIVE_CHECK_STORE_SEEDED ' + JSON.stringify({ from: fallback, to: storeFile }));
  }
  // 从真实 store 复制过来的 projects[].path 指向真实项目目录：一律改指沙盘，防止自检写真实树。
  const sandboxProjectDir = String(options.sandboxProjectDir || '');
  if (sandboxProjectDir && storeFile && fs.existsSync(storeFile)) {
    try {
      const store = JSON.parse(fs.readFileSync(storeFile, 'utf8').replace(/^\uFEFF/, ''));
      let changed = false;
      for (const p of (Array.isArray(store.projects) ? store.projects : [])) {
        if (!p || typeof p !== 'object') continue;
        const target = path.join(sandboxProjectDir, String(p.teamName || p.name || 'project'));
        if (String(p.path || '') !== target) { p.path = target; changed = true; }
        if (p.workspacePath !== undefined && String(p.workspacePath) !== target) { p.workspacePath = target; changed = true; }
        if (p.workspace && typeof p.workspace === 'object' && String(p.workspace.path || '') !== target) {
          p.workspace.path = target; changed = true;
        }
        fs.mkdirSync(target, { recursive: true });
      }
      if (changed) {
        fs.writeFileSync(storeFile, JSON.stringify(store, null, 2) + '\n', 'utf8');
        console.log('LIVE_CHECK_STORE_SANDBOXED ' + JSON.stringify({ sandboxProjectDir, storeFile }));
      }
    } catch (e) {
      console.log('LIVE_CHECK_STORE_SANDBOX_FAILED ' + JSON.stringify({ storeFile, why: String((e && e.message) || e) }));
    }
  }
  return { teamRoot, storeFile, sandboxProjectDir };
}

/** 一次读全：六行（state/秒表/最近事件/排队/known/byPlacement/停滞）+ 来源行 + 推送芯片 + 黄条 + 停滞提示。 */
const READ_LIVE = `(() => {
  const txt = (el) => (el ? String(el.textContent || '').replace(/\\s+/g, ' ').trim() : '');
  const attr = (el, name) => (el && el.getAttribute ? String(el.getAttribute(name) || '') : '');
  const rows = Array.from(document.querySelectorAll('[data-live-row]'));
  const rowOf = (row) => {
    const q = (sel) => row.querySelector(sel);
    return {
      role: attr(row, 'data-role'),
      state: attr(row, 'data-live-state'),
      live: txt(q('[data-sq-live]')),
      think: txt(q('[data-sq-think]')),
      lastEvent: txt(q('[data-sq-last-event]')),
      queued: txt(q('[data-live-queued]')),
      known: txt(q('[data-live-known]')),
      byPlacement: attr(q('[data-sq-byplacement]'), 'title') || txt(q('[data-sq-byplacement]')),
      stall: txt(q('[data-sq-stall]')),
      stallText: txt(q('[data-sq-stall-text]')),
      className: String(row.className || ''),
      text: String(row.textContent || '').replace(/\\s+/g, ' ').trim(),
      anchors: {
        live: Boolean(q('[data-sq-live]')), think: Boolean(q('[data-sq-think]')),
        lastEvent: Boolean(q('[data-sq-last-event]')), queued: Boolean(q('[data-live-queued]')),
        known: Boolean(q('[data-live-known]')),
      },
    };
  };
  const banner = document.getElementById('session-queue-banner');
  const panel = document.getElementById('session-queue-panel');
  const pushEl = document.querySelector('[data-sq-push]');
  const hint = document.getElementById('session-live-stall-hint');
  const srcEl = document.querySelector('[data-sq-source]');
  return {
    section: Boolean(document.getElementById('session-live-section')),
    liveRows: rows.length,
    sqRows: document.querySelectorAll('[data-sq-row]').length,
    rows: rows.map(rowOf),
    sourceText: txt(srcEl) || attr(srcEl, 'title'),
    push: attr(pushEl, 'data-sq-push') || txt(pushEl),
    pushText: txt(pushEl),
    panelDegraded: attr(panel, 'data-sq-degraded'),
    panelReason: attr(panel, 'data-sq-reason'),
    banner: {
      exists: Boolean(banner), hidden: banner ? Boolean(banner.hidden) : true,
      visible: Boolean(banner) && !banner.hidden && banner.getBoundingClientRect().width > 0,
      text: txt(banner),
    },
    stallHint: { exists: Boolean(hint), invalid: attr(hint, 'data-sq-stall-invalid'), hidden: hint ? Boolean(hint.hidden) : true, text: txt(hint) },
  };
})()`;

/** 快照 v2 归一：queued/byPlacement 由 queue[] 的真实 placement 计数得出（只数 queued）。 */
function normalizeRole(row, at) {
  const queue = Array.isArray(row.queue) ? row.queue : (row.queue === null ? null : []);
  const byPlacement = queue ? { queued: 0, steering: 0, context: 0 } : null;
  if (queue) {
    for (const item of queue) {
      const place = String((item && item.placement) || 'queued');
      if (byPlacement[place] !== undefined) byPlacement[place] += 1;
    }
  }
  return {
    role: row.role,
    sessionId: row.sessionId || '',
    known: row.known !== false && queue !== null,
    queued: queue ? byPlacement.queued : null,
    byPlacement,
    active: row.active !== false,
    running: row.running === true,
    runningSince: row.running === true ? String(row.runningSince || new Date(at - 65 * 1000).toISOString()) : '',
    pendingInput: Array.isArray(row.pendingInput) ? row.pendingInput : [],
    lastEventAt: row.lastEventAt || '',
    cursor: row.cursor === undefined ? null : row.cursor,
  };
}

async function runLiveCheck(options = {}) {
  const outRoot = String(options.outRoot || process.cwd());
  const outDir = process.env.AWB_LIVE_OUT
    ? path.resolve(process.env.AWB_LIVE_OUT)
    : path.join(outRoot, '_tmp', 'live-check');
  fs.mkdirSync(outDir, { recursive: true });

  const checks = [];
  const add = (group, name, status, detail) => {
    checks.push({ group, name, status, ok: status === 'pass', detail });
    const tag = status === 'pass' ? 'PASS' : (status === 'skip' ? 'SKIP' : 'FAIL');
    console.log(`[${tag}] ${group} ${name}${detail === undefined ? '' : ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)}`);
    return status === 'pass';
  };
  const pass = (group, name, cond, detail) => add(group, name, cond ? 'pass' : 'fail', detail);
  const skip = (group, name, why) => add(group, name, 'skip', { reason: why });

  const app = options.app;
  const teamName = String(options.teamName || '');
  const sandboxTeamRoot = path.resolve(String(options.sandboxTeamRoot || ''));
  const sandboxRoot = path.resolve(String(options.sandboxRoot || ''));
  const storeFile = String(options.storeFile || '');
  const stateDir = path.join(sandboxTeamRoot, '状态');
  const projectDir = teamName ? path.join(stateDir, '项目', teamName) : path.join(stateDir, '项目', '沙盘');
  const rosterFile = path.join(stateDir, '团队.json');
  const snapshotFile = path.join(stateDir, '会话排队.json');
  const wakeFile = path.join(projectDir, '唤醒.jsonl');
  const realWorkbench = path.join(path.resolve(__dirname, '..'), 'data', 'userdata', 'workbench.json');
  const realTeamFile = path.join(outRoot, '团队', '状态', '团队.json');
  const realBefore = { workbench: statOf(realWorkbench), team: statOf(realTeamFile) };

  // ── 沙盘夹具：六角色名册（无真实 sessionId）+ 空唤醒日志
  writeJson(rosterFile, {
    activeProject: teamName || '沙盘',
    members: ROSTER.map((row) => ({ ...row, status: 'active' })),
  });
  writeWake(wakeFile, []);
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const snap = (roles, at) => {
    const t = Number(at) || Date.now();
    return { schema: 2, at: iso(t), project: teamName || '沙盘', staleMs: 120000, roles: roles.map((row) => normalizeRole(row, t)) };
  };
  const baseRoles = () => [
    { role: 'pm', sessionId: 'live-fixture-pm', running: true, pendingInput: [], queue: [], lastEventAt: iso(Date.now() - 30 * 1000) },
    { role: 'programmer1', sessionId: 'live-fixture-p1', running: false, pendingInput: [], queue: [], lastEventAt: iso(Date.now() - 2 * 60 * 1000) },
    { role: 'programmer2', sessionId: 'live-fixture-p2', running: false, pendingInput: [], queue: [], lastEventAt: '' },
    { role: 'product', sessionId: 'live-fixture-product', running: true, pendingInput: [], queue: [], lastEventAt: iso(Date.now() - 5 * 60 * 1000) },
    { role: 'analyst', sessionId: '', known: false, running: false, pendingInput: [], queue: null, lastEventAt: '' },
    { role: 'tester', sessionId: 'live-fixture-tester', running: true, pendingInput: [], lastEventAt: iso(Date.now() - 60 * 1000), queue: [] },
  ];
  writeJson(snapshotFile, snap(baseRoles()));

  // 不调用 disableHardwareAcceleration（GPU 被禁时 capturePage 会超时，属既有坑）。
  options.createWindow();
  const win = options.getWindow();
  await new Promise((resolve) => { if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve); else resolve(); });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await wait(1500);
  const evalJs = (expr) => win.webContents.executeJavaScript(expr, true);
  const read = () => evalJs(READ_LIVE);
  const rowOf = (panel, role) => (panel.rows || []).find((row) => row.role === role) || {};

  const shot = async (name) => {
    try {
      const file = path.join(outDir, name);
      fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
      return { path: file, sha256: sha256Of(file), bytes: fs.statSync(file).size };
    } catch (e) { return { path: '', sha256: '', bytes: 0, error: String((e && e.message) || e) }; }
  };
  // 拍面板专用：藏壳内 webview（独立原生层会盖住抽屉）、把面板滚进抽屉可视区，再截。
  const shotOf = async (name, selector) => {
    const ready = await evalJs(`(async () => {
      const drawer = document.getElementById('session-queue-drawer');
      if (drawer && drawer.hidden) { const b = document.getElementById('btn-session-queue'); if (b) b.click(); }
      const v = document.getElementById('dsh-view');
      if (v) { v.dataset.livePrevDisplay = v.style.display || ''; v.style.display = 'none'; }
      await new Promise((r) => setTimeout(r, 400));
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, why: 'no-element' };
      let node = el.parentElement;
      while (node && node !== document.body) {
        const cs = getComputedStyle(node);
        if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 40) {
          const r = el.getBoundingClientRect();
          const nr = node.getBoundingClientRect();
          node.scrollTop += (r.top - nr.top) - 40;
          break;
        }
        node = node.parentElement;
      }
      await new Promise((r) => setTimeout(r, 350));
      const box = el.getBoundingClientRect();
      return { ok: true, top: Math.round(box.top), height: Math.round(box.height), vh: window.innerHeight };
    })()`);
    const file = await shot(name);
    await evalJs("(() => { const v = document.getElementById('dsh-view'); if (v) { v.style.display = v.dataset.livePrevDisplay || ''; delete v.dataset.livePrevDisplay; } return true; })()");
    return { ...file, ready };
  };
  // DOM 刷新（AC2/AC4 用；AC3 的时延测量**不调**它，只等真实推送/自检）
  const refreshDom = async () => {
    await evalJs(`(async () => {
      try { if (typeof window.__liveRefresh === 'function') { await window.__liveRefresh(); return 'live'; } } catch (e) {}
      try { if (typeof window.__sqRefresh === 'function') { await window.__sqRefresh(); return 'sq'; } } catch (e) {}
      try { const b = document.getElementById('btn-queue-refresh'); if (b) { b.click(); await new Promise((r) => setTimeout(r, 400)); return 'button'; } } catch (e) {}
      return 'none';
    })()`);
    await wait(200);
    return read();
  };

  // ── 渲染层就绪探测（[data-live-row] 由并行渲染层任务落地；未落地时重试 3 次×60s）
  let panel = await read();
  const liveReady = () => Boolean(panel.section) && Number(panel.liveRows) === 6;
  let attempts = 0;
  while (!liveReady() && attempts < RETRY_TIMES) {
    attempts += 1;
    console.log('LIVE_CHECK_WAIT_RENDERER ' + JSON.stringify({ attempt: attempts, gapMs: RETRY_GAP_MS, section: panel.section, liveRows: panel.liveRows }));
    await wait(RETRY_GAP_MS);
    panel = await refreshDom();
  }
  const rendererReady = liveReady();

  // ── AC5① 静态：setInterval 恰 2 处、每个都有 clearInterval 清理（不依赖渲染层运行时）
  const panelSrcFile = path.join(outRoot, 'src', 'renderer', 'session-queue-panel.js');
  const panelSrc = (() => { try { return fs.readFileSync(panelSrcFile, 'utf8'); } catch { return ''; } })();
  const countOf = (src, re) => (src.match(re) || []).length;
  const setIntervalN = countOf(panelSrc, /setInterval\s*\(/g);
  const clearIntervalN = countOf(panelSrc, /clearInterval\s*\(/g);
  pass('AC5', 'AC5① 渲染层 setInterval 恰 2 处且各有 clearInterval 配对', setIntervalN === 2 && clearIntervalN >= setIntervalN,
    { file: panelSrcFile, bytes: Buffer.byteLength(panelSrc), setInterval: setIntervalN, clearInterval: clearIntervalN, rule: 'setInterval==2 且 clearInterval>=2（每个定时器都有清理）' });

  // ── 隔离（无论渲染层是否就绪都要验：自检本身已跑，真实树必须零写入）
  const realAfterEarly = { workbench: statOf(realWorkbench), team: statOf(realTeamFile) };
  const unchangedEarly = (before, after) => (before.exists === after.exists)
    && (!before.exists || (before.sha256 === after.sha256 && before.mtimeMs === after.mtimeMs));
  pass('隔离', '真实 data/userdata/workbench.json 未被改写（sha256+mtime 不变）', unchangedEarly(realBefore.workbench, realAfterEarly.workbench),
    { before: { size: realBefore.workbench.size, sha: String(realBefore.workbench.sha256).slice(0, 16), mtime: realBefore.workbench.mtimeMs }, after: { size: realAfterEarly.workbench.size, sha: String(realAfterEarly.workbench.sha256).slice(0, 16), mtime: realAfterEarly.workbench.mtimeMs } });
  pass('隔离', '真实 团队/状态/团队.json 未被改写（sha256+mtime 不变）', unchangedEarly(realBefore.team, realAfterEarly.team),
    { before: { sha: String(realBefore.team.sha256).slice(0, 16), mtime: realBefore.team.mtimeMs }, after: { sha: String(realAfterEarly.team.sha256).slice(0, 16), mtime: realAfterEarly.team.mtimeMs } });
  pass('隔离', `沙盘路径全部落在本次 live-check 数据根内（${sandboxRoot}）`,
    sandboxTeamRoot.startsWith(sandboxRoot + path.sep) && snapshotFile.startsWith(sandboxRoot + path.sep),
    { sandboxTeamRoot, sandboxRoot });

  if (!rendererReady) {
    add('AC1', '渲染层就绪（#session-live-section + [data-live-row]×6）', 'fail', {
      code: 'RENDERER_NOT_READY', section: panel.section, liveRows: panel.liveRows,
      retried: attempts, gapMs: RETRY_GAP_MS,
      hint: '等待并行渲染层任务落地 data-live-row / #session-live-section 后重跑',
    });
    const blockedShot = await shot('live-blocked-无面板.png');
    const report = {
      task: 'R-c9ac', status: 'blocked', ok: false, at: new Date().toISOString(),
      outDir, rendererReady: false, total: checks.length,
      passed: checks.filter((r) => r.status === 'pass').length,
      failed: checks.filter((r) => r.status === 'fail').length,
      skipped: checks.filter((r) => r.status === 'skip').length,
      checks, screenshots: { blocked: blockedShot },
      sandbox: { teamRoot: sandboxTeamRoot, storeFile, snapshotFile, wakeFile, dataRoot: sandboxRoot },
      note: '渲染层未落地 [data-live-row]/#session-live-section：本入口代码已就绪，等渲染层后重跑',
    };
    fs.writeFileSync(path.join(outDir, 'live-check.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log('LIVE_CHECK_BLOCKED ' + JSON.stringify({ total: report.total, failed: report.failed, outDir, shot: blockedShot.path, sha256: blockedShot.sha256 }));
    app.exit(2);
    return report;
  }

  // 打开抽屉、把面板滚进可视区（截图与后续断言都要它可见）
  await evalJs("(() => { const b = document.getElementById('btn-session-queue'); if (b) b.click(); return true; })()");
  await wait(600);
  await evalJs("(() => { const el = document.getElementById('session-live-section') || document.getElementById('session-queue-panel'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' }); return true; })()");
  await wait(300);
  panel = await refreshDom();

  // ── AC1 结构
  pass('AC1', 'AC1a #session-live-section 存在', panel.section === true, { section: panel.section });
  pass('AC1', 'AC1b [data-live-row] 恰 6 行', panel.liveRows === 6, { liveRows: panel.liveRows });
  pass('AC1', 'AC1c 既有 [data-sq-row] 仍恰 6 行（未被打散）', panel.sqRows === 6, { sqRows: panel.sqRows });
  const rows0 = panel.rows || [];
  const anchorsComplete = rows0.length === 6
    && rows0.every((row) => row.anchors.live && row.anchors.think && row.anchors.lastEvent && row.anchors.queued && row.anchors.known);
  pass('AC1', 'AC1d 每行五锚点齐全（live/think/last-event/queued/known）', anchorsComplete,
    { missing: rows0.filter((row) => !(row.anchors.live && row.anchors.think && row.anchors.lastEvent && row.anchors.queued && row.anchors.known)).map((r) => ({ role: r.role, anchors: r.anchors })) });
  const thinkingRows = rows0.filter((row) => row.state === 'thinking');
  const clockOk = thinkingRows.length > 0 && thinkingRows.every((row) => /^\d{2,}:\d{2}$/.test(row.think));
  pass('AC1', 'AC1e thinking 行秒表匹配 mm:ss', clockOk, { thinking: thinkingRows.map((r) => ({ role: r.role, think: r.think, state: r.state })) });
  const nonThinking = rows0.filter((row) => row.state !== 'thinking');
  pass('AC1', 'AC1f 非 thinking 行秒表为「—」', nonThinking.length > 0 && nonThinking.every((row) => row.think === '—'),
    { rows: nonThinking.map((r) => ({ role: r.role, state: r.state, think: r.think })) });
  pass('AC1', 'AC1g [data-sq-source] 含 runtime=dsh 与 delivery=wake.jsonl',
    /runtime\s*=\s*dsh/.test(panel.sourceText) && /delivery\s*=\s*wake\.jsonl/.test(panel.sourceText),
    { sourceText: String(panel.sourceText || '').slice(0, 200) });
  const ac1Shot = await shotOf('live-ac1-六行与秒表.png', '#session-live-section');

  // ── 接线前置（不满足时 AC3/AC4②③ 必然失败；单独记两条，便于定位是入口问题还是接线问题）
  const wiring = await evalJs(`(async () => {
    const out = { stateHasUi: false, stallMs: null, stateError: '', pushApi: false, modelPush: false, modelHasLive: false };
    try {
      const st = await window.workbench.state();
      out.stateHasUi = Boolean(st && st.ui && typeof st.ui === 'object');
      out.stallMs = st && st.ui && st.ui.sessionQueue ? (st.ui.sessionQueue.stallMs === undefined ? null : st.ui.sessionQueue.stallMs) : null;
    } catch (e) { out.stateError = String((e && e.message) || e); }
    out.pushApi = typeof (window.workbench && window.workbench.onSessionQueueChanged) === 'function';
    try {
      const m = window.__sqModel ? window.__sqModel() : null;
      out.modelPush = Boolean(m && m.push && typeof m.push === 'object');
      out.modelHasLive = Boolean(m && m.live && typeof m.live === 'object');
    } catch (e) { out.modelError = String((e && e.message) || e); }
    return out;
  })()`);
  pass('接线', 'A1 window.workbench.state() 返回 ui（否则 ui.sessionQueue.stallMs 热读恒回落 600000）', wiring.stateHasUi === true, wiring);
  pass('接线', 'A2 推送通道可用（model.push 下发 或 preload onSessionQueueChanged 订阅）', wiring.modelPush === true || wiring.pushApi === true, wiring);

  // ── AC2 五态优先与排队口径
  const setSnap = async (roles) => { writeJson(snapshotFile, snap(roles)); return refreshDom(); };
  {
    const roles = baseRoles().map((row) => (row.role === 'pm' ? { ...row, running: true, pendingInput: [], queue: [] } : row));
    const p = await setSnap(roles);
    const row = rowOf(p, 'pm');
    pass('AC2', 'AC2① running:true → thinking', row.state === 'thinking', { state: row.state, live: row.live, think: row.think });
  }
  {
    const roles = baseRoles().map((row) => (row.role === 'pm' ? { ...row, running: true, pendingInput: ['approval'] } : row));
    const p = await setSnap(roles);
    const row = rowOf(p, 'pm');
    pass('AC2', 'AC2② pendingInput=[approval] 优先于 running → approval', row.state === 'approval', { state: row.state, live: row.live });
  }
  {
    const roles = baseRoles().map((row) => (row.role === 'pm' ? { ...row, running: true, pendingInput: ['question'] } : row));
    const p = await setSnap(roles);
    const row = rowOf(p, 'pm');
    pass('AC2', 'AC2③ pendingInput=[question] → blocked（优先于 running）', row.state === 'blocked', { state: row.state, live: row.live });
  }
  {
    const roles = baseRoles().map((row) => (row.role === 'pm'
      ? { ...row, running: false, pendingInput: [], queue: [{ id: 'a', placement: 'queued' }, { id: 'b', placement: 'queued' }] }
      : row));
    const p = await setSnap(roles);
    const row = rowOf(p, 'pm');
    pass('AC2', 'AC2④ running:false + 排队 2 → queued 且排队列=2', row.state === 'queued' && row.queued === '2', { state: row.state, queued: row.queued });
  }
  {
    const roles = baseRoles().map((row) => (row.role === 'pm' ? { ...row, running: false, pendingInput: [], queue: [] } : row));
    const p = await setSnap(roles);
    const row = rowOf(p, 'pm');
    pass('AC2', 'AC2⑤ 全空 → idle 且排队列=0', row.state === 'idle' && row.queued === '0', { state: row.state, queued: row.queued });
  }
  {
    const roles = baseRoles().map((row) => (row.role === 'pm'
      ? { ...row, running: true, pendingInput: [], queue: [{ id: 'a', placement: 'queued' }, { id: 'b', placement: 'queued' }] }
      : row));
    const p = await setSnap(roles);
    const row = rowOf(p, 'pm');
    pass('AC2', 'AC2⑥ running:true + 排队 2 → thinking 且排队列=2', row.state === 'thinking' && row.queued === '2', { state: row.state, queued: row.queued });
  }
  {
    const roles = baseRoles().map((row) => (row.role === 'tester'
      ? {
        ...row,
        queue: [
          { id: 'q1', placement: 'queued' }, { id: 'q2', placement: 'queued' }, { id: 'q3', placement: 'queued' },
          { id: 's1', placement: 'steering' }, { id: 'c1', placement: 'context' },
        ],
      }
      : row));
    const p = await setSnap(roles);
    const row = rowOf(p, 'tester');
    const byp = String(row.byPlacement || '');
    pass('AC2', 'AC2⑦ 排队只数 placement=queued（3/1/1 → 排队 3，明细 queued=3 steering=1 context=1）',
      row.queued === '3' && /queued=3/.test(byp) && /steering=1/.test(byp) && /context=1/.test(byp),
      { queued: row.queued, byPlacement: byp });
  }
  {
    const roles = baseRoles().map((row) => (row.role === 'tester'
      ? { ...row, queue: [1, 2, 3, 4].map((i) => ({ id: `s${i}`, placement: 'steering' })) }
      : row));
    const p = await setSnap(roles);
    const row = rowOf(p, 'tester');
    pass('AC2', 'AC2⑧ 4 条 steering → 排队列=0 且明细 steering=4', row.queued === '0' && /steering=4/.test(String(row.byPlacement || '')),
      { queued: row.queued, byPlacement: row.byPlacement });
  }
  {
    const roles = baseRoles().map((row) => (row.role === 'analyst' ? { ...row, queue: null, known: false, sessionId: '' } : row));
    const p = await setSnap(roles);
    const row = rowOf(p, 'analyst');
    pass('AC2', 'AC2⑨ queue:null → unknown（未接入）、排队「—」、known=false',
      row.state === 'unknown' && row.queued === '—' && row.known === 'false',
      { state: row.state, queued: row.queued, known: row.known });
  }
  const ac2Shot = await shotOf('live-ac2-五态与排队.png', '#session-live-section');

  // ── AC3① 推送时延：写盘 → DOM state 变化 ≤2000ms（10 次取 p95；**不调刷新入口**）
  // 先做一次「预热」：面板首次挂载/订阅绑定完成前的第一笔写盘不算时延（它测的是接线未就绪，不是推送慢）。
  {
    writeJson(snapshotFile, snap(baseRoles().map((row) => (row.role === 'pm' ? { ...row, running: true, pendingInput: [], queue: [] } : row))));
    const warmT0 = Date.now();
    while (Date.now() - warmT0 < 3000) {
      if (rowOf(await read(), 'pm').state === 'thinking') break;
      await wait(100);
    }
  }
  const latencies = [];
  let flip = false;
  // 前 1 轮只做热身（丢弃）：面板首次收到推送时可能还在绑定订阅，测出来是「接线未就绪」而不是推送慢。
  for (let i = 0; i < LATENCY_ROUNDS + 1; i += 1) {
    flip = !flip;
    const roles = baseRoles().map((row) => (row.role === 'pm' ? { ...row, running: flip, pendingInput: [], queue: [] } : row));
    const beforeState = rowOf(await read(), 'pm').state;
    const t0 = Date.now();
    writeJson(snapshotFile, snap(roles));
    let changedMs = -1;
    while (Date.now() - t0 < 3000) {
      const nowState = rowOf(await read(), 'pm').state;
      if (nowState !== beforeState) { changedMs = Date.now() - t0; break; }
      await wait(80);
    }
    if (i === 0) continue;
    latencies.push(changedMs < 0 ? 3000 : changedMs);
  }
  const sortedLat = [...latencies].sort((a, b) => a - b);
  const p95 = sortedLat[Math.max(0, Math.ceil(0.95 * sortedLat.length) - 1)];
  panel = await read();
  pass('AC3', `AC3① 写盘→[data-sq-live] state 变化 ≤${LATENCY_BUDGET_MS}ms（10 次 p95）`, p95 <= LATENCY_BUDGET_MS,
    { latencies, p95, budget: LATENCY_BUDGET_MS, timeoutMarker: 3000, push: panel.push, pushText: panel.pushText });

  // ── AC3② 降级：用 live-check 专用旋钮把推送通道标成 degraded（等价 watch 不可用），
  //    5s 内 [data-sq-push]=degraded + 黄条可见含「最近成功」；恢复 mode=push 后回 push。
  {
    const beforePush = (await read()).push;
    // 先确保抽屉真的展开（banner 在抽屉内，抽屉 hidden 时 rect=0 → 不能拿宽度判「可见」）。
    await evalJs(`(() => {
      const d = document.getElementById('session-queue-drawer');
      if (d && d.hidden) { const b = document.getElementById('btn-session-queue'); if (b) b.click(); }
      return true;
    })()`);
    const openT0 = Date.now();
    while (Date.now() - openT0 < 2000) {
      const opened = await evalJs(`(() => { const d = document.getElementById('session-queue-drawer'); return Boolean(d) && d.hidden !== true; })()`);
      if (opened) break;
      await wait(100);
    }
    await win.webContents.executeJavaScript('window.workbench.sessionQueuePushMode({ mode: "degraded" })');
    const t0 = Date.now();
    let idlePanel = await read();
    let bannerVisible = Boolean(idlePanel.banner && idlePanel.banner.visible);
    while (Date.now() - t0 < 5000 && (!(bannerVisible) || String(idlePanel.push).toLowerCase() !== 'degraded')) {
      await wait(150);
      idlePanel = await read();
      bannerVisible = Boolean(idlePanel.banner && idlePanel.banner.visible);
    }
    const degradedOk = String(idlePanel.push).toLowerCase() === 'degraded'
      && bannerVisible && /最近成功/.test(idlePanel.banner.text);
    pass('AC3', 'AC3② 通道降级 → 5s 内 [data-sq-push]=degraded 且黄条可见含「最近成功」', degradedOk,
      { push: idlePanel.push, beforePush, elapsedMs: Date.now() - t0, banner: { visible: idlePanel.banner.visible, text: String(idlePanel.banner.text || '').slice(0, 200) } });
    const ac3Shot = await shotOf('live-ac3-降级黄条.png', '#session-queue-banner');
    await win.webContents.executeJavaScript('window.workbench.sessionQueuePushMode({ mode: "push" })');
    writeJson(snapshotFile, snap(baseRoles()));
    const t1 = Date.now();
    let backTo = '';
    while (Date.now() - t1 < 5000) {
      backTo = String((await read()).push || '');
      if (backTo.toLowerCase() === 'push') break;
      await wait(150);
    }
    pass('AC3', 'AC3②b 恢复通道后 5s 内 [data-sq-push] 回 push', backTo.toLowerCase() === 'push', { push: backTo, elapsedMs: Date.now() - t1 });
    panel = await read();
    var ac3File = ac3Shot;
  }

  // ── AC4 停滞（stallMs）：lastEventAt 取自**快照**（不是唤醒日志），阈值热读 ui.sessionQueue.stallMs
  const writeStoreStallMs = (value) => {
    const store = JSON.parse(fs.readFileSync(storeFile, 'utf8').replace(/^\uFEFF/, ''));
    store.ui = store.ui && typeof store.ui === 'object' ? store.ui : {};
    const sq = store.ui.sessionQueue && typeof store.ui.sessionQueue === 'object' ? store.ui.sessionQueue : {};
    if (value === undefined) delete sq.stallMs; else sq.stallMs = value;
    store.ui.sessionQueue = sq;
    writeJson(storeFile, store);
  };
  const snapWithEvents = (events) => snap(baseRoles().map((row) => (Object.prototype.hasOwnProperty.call(events, row.role)
    ? { ...row, lastEventAt: iso(Date.now() - Number(events[row.role])) }
    : { ...row })));
  {
    // ① 缺省 600000：9 分钟不判、11 分钟判
    writeStoreStallMs(undefined);
    writeJson(snapshotFile, snapWithEvents({ pm: 9 * 60 * 1000, tester: 11 * 60 * 1000 }));
    const p = await refreshDom();
    const pm9 = rowOf(p, 'pm');
    pass('AC4', 'AC4① lastEvent=9 分钟前（缺省 stallMs=600000）→ 未停滞', pm9.stall === 'false' && !/停滞/.test(pm9.stallText),
      { pm: { stall: pm9.stall, stallText: pm9.stallText, state: pm9.state } });
    const te11 = rowOf(p, 'tester');
    pass('AC4', 'AC4①b lastEvent=11 分钟前 → 停滞 11 分且 class 命中 stall|warn',
      te11.stall === 'true' && /停滞\s*11\s*分/.test(te11.stallText) && /stall|warn/.test(te11.className),
      { tester: { stall: te11.stall, stallText: te11.stallText, className: te11.className } });
    // ② stallMs=1000 生效：2 秒前的事件就判停滞（热读后 2s 内变 true）
    writeStoreStallMs(1000);
    writeJson(snapshotFile, snapWithEvents({ pm: 2 * 1000, tester: 2 * 1000 }));
    const t0 = Date.now();
    let stalledNow = false;
    const p2a = await refreshDom();
    if (rowOf(p2a, 'pm').stall === 'true') stalledNow = true;
    while (!stalledNow && Date.now() - t0 < 2000) {
      const cur = await read();
      if (rowOf(cur, 'pm').stall === 'true') { stalledNow = true; break; }
      await wait(120);
    }
    pass('AC4', 'AC4② 写 ui.sessionQueue.stallMs=1000 后 2s 内同数据变停滞', stalledNow, { elapsedMs: Date.now() - t0 });
    // ③ 非法值 -5 / "abc" → 回落 600000（不误判）+ 面板可见提示
    for (const bad of [-5, 'abc']) {
      writeStoreStallMs(bad);
      writeJson(snapshotFile, snapWithEvents({ pm: 2 * 1000, tester: 2 * 1000 }));
      const p2 = await refreshDom();
      const pm2 = rowOf(p2, 'pm');
      const hintOk = p2.stallHint.invalid === '1' && !p2.stallHint.hidden && /回退|回落|默认|600000|非法|无效/.test(String(p2.stallHint.text || ''));
      pass('AC4', `AC4③ stallMs=${JSON.stringify(bad)} → 回落 600000（不误判）且面板有可见提示`,
        pm2.stall === 'false' && hintOk,
        { value: bad, pm: { stall: pm2.stall, stallText: pm2.stallText }, hint: { invalid: p2.stallHint.invalid, hidden: p2.stallHint.hidden, text: String(p2.stallHint.text || '').slice(0, 160) } });
    }
    writeStoreStallMs(undefined);
    // ④ 删快照 → 六行未接入、排队「—」、不显示停滞
    try { fs.unlinkSync(snapshotFile); } catch { /* 已删 */ }
    const p3 = await refreshDom();
    const rows3 = p3.rows || [];
    const notConnected = rows3.length === 6 && rows3.every((row) => row.state === 'unknown' && /未接入/.test(row.live));
    const dashQueued = rows3.length === 6 && rows3.every((row) => row.queued === '—');
    const noStall = rows3.every((row) => row.stall !== 'true' && !/停滞/.test(row.stallText));
    pass('AC4', 'AC4④ 删快照 → 六行「未接入」、排队「—」、无停滞', notConnected && dashQueued && noStall,
      { rows: rows3.map((r) => ({ role: r.role, state: r.state, queued: r.queued, stall: r.stall })) });
    var ac4File = await shotOf('live-ac4-未接入.png', '#session-live-section');
  }

  // ── AC5② 静置 60s：getSnapshot 调用 ≤1（主进程计数——渲染层 contextBridge 冻结，不能在页面里打桩）
  {
    const statOf = async () => {
      const raw = await evalJs('window.workbench.liveCheckStats ? window.workbench.liveCheckStats() : null');
      // executeJavaScript 返回 Promise 时 Electron 会等待其 resolve，这里拿到的已是结果对象。
      return raw && typeof raw === 'object' ? raw : null;
    };
    const before = await statOf();
    if (before && Number.isFinite(Number(before.getSnapshotCalls))) {
      const callsBefore = Number(before.getSnapshotCalls);
      const pushBefore = Number(before.pushEvents) || 0;
      const t0 = Date.now();
      await wait(IDLE_SEC * 1000);
      const after = (await statOf()) || {};
      const calls = Number(after.getSnapshotCalls) - callsBefore;
      const pushes = Number(after.pushEvents) - pushBefore;
      pass('AC5', `AC5② 静置 ${IDLE_SEC}s 内 team:session-queue（getSnapshot）调用 ≤1（主进程计数）`, calls <= 1,
        { calls, pushes, seconds: IDLE_SEC, elapsedMs: Date.now() - t0, note: '3 分钟口径由人工复验，自检取 60s 外推' });
    } else {
      skip('AC5', 'AC5② 静置 60s 的 getSnapshot 调用计数', '主进程 live-check 计数不可用（--live-check 未注册 team:live-check-stats）');
    }
  }

  // ── 汇总
  const passed = checks.filter((row) => row.status === 'pass').length;
  const failed = checks.filter((row) => row.status === 'fail').length;
  const skipped = checks.filter((row) => row.status === 'skip').length;
  const screenshots = { ac1: ac1Shot, ac2: ac2Shot, ac3: typeof ac3File === 'object' ? ac3File : null, ac4: typeof ac4File === 'object' ? ac4File : null };
  const report = {
    task: 'R-c9ac', status: failed === 0 ? 'ok' : 'failed', ok: failed === 0,
    at: new Date().toISOString(), outDir, rendererReady: true,
    total: checks.length, passed, failed, skipped,
    checks, screenshots,
    sandbox: { teamRoot: sandboxTeamRoot, storeFile, snapshotFile, wakeFile, dataRoot: sandboxRoot },
    notes: [
      `AC5② 静置用 ${IDLE_SEC}s 外推（3 分钟口径由人工复验）`,
      'AC3① 时延测量不调用任何刷新入口，只等真实推送/降级自检',
    ],
  };
  fs.writeFileSync(path.join(outDir, 'live-check.json'), JSON.stringify(report, null, 2), 'utf8');
  const shots = Object.values(screenshots).filter((item) => item && item.path);
  console.log('LIVE_CHECK_SHOTS ' + JSON.stringify(shots.map((item) => ({ path: item.path, sha256: item.sha256, bytes: item.bytes }))));
  if (report.ok) console.log('SESSION_LIVE_CHECK_OK ' + JSON.stringify({ total: report.total, passed, skipped, outDir }));
  else console.log('SESSION_LIVE_CHECK_FAIL ' + JSON.stringify({ total: report.total, passed, failed, skipped, outDir }));
  app.exit(report.ok ? 0 : 1);
  return report;
}

module.exports = { runLiveCheck, prepareLiveCheckSandbox };
