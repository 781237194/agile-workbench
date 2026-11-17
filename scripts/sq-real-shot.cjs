#!/usr/bin/env node
'use strict';
/**
 * R-6bc8（T-20261117-123812-37f5）真窗口复验：会话排队面板 + 背压提示（真实数据、隔离实例）。
 *
 * 口径：
 *   · 真窗口：`scripts/run-electron.cjs . --remote-debugging-port=<port>`，CDP 真点 DOM + 截图；
 *   · 数据：**真实**团队状态的只读副本（团队/状态/团队.json、项目/…/唤醒.jsonl 等）进沙盘，
 *     AWB_DATA_DIR / TEAM_ROOT 全部指沙盘 → 面板显示的是真实 唤醒.jsonl（1.6MB、6000+ 行）算出来的四态；
 *   · 真实 团队/状态、真实 data/userdata 只做「sha256+mtime 未变」断言，一个字节都不写；
 *   · 会话排队.json 由 DSH 插件 host half 产生：本机尚未生成时，面板必须走「未接入」降级（不显示 0），
 *     这一条本身就是要验的边界，不当成通过也不当成缺陷。
 *
 * 用法：node scripts/sq-real-shot.cjs
 * 产出：程序员B/产出/证据-37f5/real-shot-*.png + real-model.json + real-shot-result.json
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, '项目', '工作台改造修复');
const PNAME = '工作台改造修复';
const UNIQ = `sq-real-${process.pid}-${Date.now()}`;
const SB = path.join(ROOT, '_tmp', UNIQ);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const REAL_TEAM_JSON = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_WAKE = path.join(ROOT, '团队', '状态', '项目', PNAME, '唤醒.jsonl');
const REAL_SNAPSHOT = path.join(ROOT, '团队', '状态', '会话排队.json');
const PORT = Number(process.env.AWB_SQ_REAL_PORT || (9461 + (process.pid % 30)));
const EVID = process.env.AWB_SQ_REAL_OUT ? path.resolve(process.env.AWB_SQ_REAL_OUT) : path.join(PROJ, '程序员B', '产出', '证据-37f5');

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 400)}`);
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

/** 沙盘：真实团队状态只读副本（团队.json 清空 sessionId 防误唤醒；唤醒.jsonl 原样复制）。 */
function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  const projectState = path.join(TEAM, '状态', '项目', PNAME);
  fs.mkdirSync(projectState, { recursive: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  for (const name of ['团队宪法.md', '项目铁律.md']) {
    try { fs.copyFileSync(path.join(ROOT, '团队', name), path.join(TEAM, name)); } catch { /* 缺文档不影响面板 */ }
  }
  const team = JSON.parse(fs.readFileSync(REAL_TEAM_JSON, 'utf8').replace(/^\uFEFF/, ''));
  for (const member of team.members || []) member.sessionId = '';
  team.activeProject = PNAME;
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  fs.copyFileSync(REAL_WAKE, path.join(projectState, '唤醒.jsonl'));
  for (const name of ['项目.json', '工作流.json', '决策箱.json']) {
    try { fs.copyFileSync(path.join(ROOT, '团队', '状态', '项目', PNAME, name), path.join(projectState, name)); } catch { /* 可选 */ }
  }
  const store = JSON.parse(fs.readFileSync(REAL_STORE, 'utf8').replace(/^\uFEFF/, ''));
  const project = (store.projects || []).find((item) => item && String(item.teamName || item.name || '') === PNAME);
  if (!project) throw new Error(`真实 workbench.json 里没有团队项目 ${PNAME}`);
  project.teamName = PNAME;
  store.projects = [project];
  store.activeProjectId = project.id;
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n', 'utf8');
  return { wakeBytes: fs.statSync(path.join(projectState, '唤醒.jsonl')).size };
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
  // 壳内 webview 是真实 DSH 页：导航 about:blank，避免重绘让截图挂住（只影响本隔离实例）
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
  await sleep(800);
  try {
    if (inst.child && inst.child.pid && inst.child.exitCode === null) {
      spawnSync('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
  } catch { /* ignore */ }
}

/** 把面板滚进可视区：团队台是长抽屉，面板在它的滚动容器里（不是窗口滚动）。 */
async function scrollTo(cdp, selector) {
  return cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    let node = el.parentElement;
    while (node && node !== document.body) {
      const cs = getComputedStyle(node);
      if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 40) {
        const r = el.getBoundingClientRect();
        const nr = node.getBoundingClientRect();
        node.scrollTop += (r.top - nr.top) - 40;
        return { scroller: node.id || String(node.className || ''), scrollTop: Math.round(node.scrollTop), viewportTop: Math.round(el.getBoundingClientRect().top) };
      }
      node = node.parentElement;
    }
    window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - 60));
    return { scroller: 'window', scrollTop: Math.round(window.scrollY), viewportTop: Math.round(el.getBoundingClientRect().top) };
  })()`);
}

async function shot(cdp, file) {
  try {
    await cdp.send('Page.bringToFront', {}, 6000);
    const out = await cdp.send('Page.captureScreenshot', { format: 'png' }, 20000);
    if (!out || !out.data) return false;
    const buf = Buffer.from(out.data, 'base64');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    return buf.length > 4000;
  } catch { return false; }
}

const READ = `(() => {
  const txt = (n) => (n ? String(n.textContent || '').trim() : '');
  const rows = Array.from(document.querySelectorAll('[data-sq-row]')).map((row) => {
    const q = row.querySelector('[data-sq-queued]');
    return {
      role: row.dataset.role || '',
      queued: txt(q),
      known: q ? String(q.getAttribute('data-sq-known') || '') : '',
      state: txt(row.querySelector('[data-sq-state]')),
      fail: txt(row.querySelector('[data-sq-fail-count]')),
      skip: txt(row.querySelector('[data-sq-skip-count]')),
      lastOk: txt(row.querySelector('[data-sq-last-ok]')),
    };
  });
  const panel = document.getElementById('session-queue-panel');
  const banner = document.getElementById('session-queue-banner');
  const hint = document.querySelector('[data-backpressure-hint]');
  return {
    rows,
    degraded: panel ? panel.getAttribute('data-sq-degraded') : '',
    bannerHidden: banner ? banner.hidden : null,
    bannerText: txt(banner),
    hasHint: Boolean(hint),
    hintText: txt(hint),
    meta: txt(document.getElementById('session-queue-meta')),
  };
})()`;

(async () => {
  fs.mkdirSync(EVID, { recursive: true });
  const before = { team: statOf(REAL_TEAM_JSON), wake: statOf(REAL_WAKE), store: statOf(REAL_STORE), snapshot: statOf(REAL_SNAPSHOT) };
  if (before.wake) {
    // 唤醒.jsonl 会被团队实时追加：记一个前缀哈希，只断言「前缀没被改写」
    before.wake.prefixHash = crypto.createHash('sha256').update(fs.readFileSync(REAL_WAKE).subarray(0, before.wake.bytes)).digest('hex');
  }
  const seeded = seed();
  check('沙盘 = 真实唤醒日志只读副本（>100KB，不是夹具）', seeded.wakeBytes > 100 * 1024, { bytes: seeded.wakeBytes });

  const inst = await launch();
  if (!inst) {
    check('真窗口启动（run-electron + CDP）', false, `端口 ${PORT} 未等到 renderer/index.html`);
    fs.writeFileSync(path.join(EVID, 'real-shot-result.json'), JSON.stringify({ results }, null, 2) + '\n', 'utf8');
    process.exit(1);
  }
  const { cdp } = inst;
  try {
    // 打开团队台（面板在抽屉里；抽屉收起时 rect=0，截图会退化成整视口）
    let drawerOpen = false;
    for (let i = 0; i < 6 && !drawerOpen; i += 1) {
      await cdp.evaluate("(() => { const b = document.getElementById('team-pill'); if (b) b.click(); return true; })()");
      await sleep(900);
      drawerOpen = await cdp.evaluate("(() => { const d = document.getElementById('team-drawer'); return Boolean(d && !d.hidden); })()") === true;
    }
    check('团队台抽屉打开（截图能拍到面板）', drawerOpen === true, { drawerOpen });
    await cdp.evaluate("(async () => { if (typeof window.__sqRefresh === 'function') await window.__sqRefresh(); return true; })()");
    await sleep(700);
    let panel = await cdp.evaluate(READ);
    const model = await cdp.evaluate('(() => { try { return JSON.stringify(window.__sqModel()); } catch (e) { return "null"; } })()');
    fs.writeFileSync(path.join(EVID, 'real-model.json'), String(model || 'null'), 'utf8');

    check('真窗口渲染六角色行', Array.isArray(panel.rows) && panel.rows.length === 6, (panel.rows || []).map((r) => r.role));
    const states = (panel.rows || []).map((r) => r.state);
    check('四态取值合法（fail/skip/ok/none）', states.every((s) => ['fail', 'skip', 'ok', 'none'].includes(s)), states);
    const realStateful = (panel.rows || []).filter((r) => r.state !== 'none');
    check('真实唤醒日志算出了非 none 的四态（≥3 个角色有记录）', realStateful.length >= 3,
      (panel.rows || []).map((r) => `${r.role}:${r.state}/f${r.fail}/s${r.skip}`));
    const failRows = (panel.rows || []).filter((r) => Number(r.fail) > 0);
    check('真实数据里失败计数与状态一致（有 fail 计数的角色 state=fail）', failRows.every((r) => r.state === 'fail'),
      failRows.map((r) => `${r.role}:${r.state}/f${r.fail}`));

    // 会话排队.json 由 DSH 插件写；本机尚未生成 → 必须走「未接入」降级，绝不显示 0
    if (!before.snapshot) {
      check('本机无 会话排队.json → 面板降级「未接入」且排队数显示「—」',
        panel.degraded === 'true' && /未接入/.test(panel.bannerText || '') && (panel.rows || []).every((r) => r.queued === '—'),
        { degraded: panel.degraded, bannerText: panel.bannerText, queued: (panel.rows || []).map((r) => r.queued) });
      check('未知不冒充 0：排队数一律不是 "0"', (panel.rows || []).every((r) => r.queued !== '0'), (panel.rows || []).map((r) => r.queued));
    } else {
      check('本机已有 会话排队.json → 面板显示真实排队数（降级原因见 banner）',
        (panel.rows || []).some((r) => Number.isFinite(Number(r.queued))),
        (panel.rows || []).map((r) => `${r.role}:${r.queued}`));
    }

    // 背压：未知排队不得触发提示
    const hintProbe = await cdp.evaluate(`(() => {
      const sel = document.getElementById('dispatch-role');
      if (!sel) return { ok: false };
      sel.value = 'product';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, count: document.querySelectorAll('[data-backpressure-hint]').length };
    })()`);
    check('背压提示只在排队 ≥3 时出现（真实未知排队下不出现）', hintProbe.ok === true && Number(hintProbe.count) === 0, hintProbe);

    // 截图前把壳内 webview 暂时隐藏：<webview> 是独立原生层，会盖住右侧抽屉（只影响本隔离实例的渲染）
    await cdp.evaluate("(() => { const v = document.getElementById('dsh-view'); if (v) { v.dataset.sqPrevDisplay = v.style.display || ''; v.style.display = 'none'; } return true; })()");
    // 抽屉会被周期重绘收掉：每次「打开→确认在视口内→立刻截图」，最多重试 8 轮
    const shotTab = async (file, selector) => {
      for (let i = 0; i < 8; i += 1) {
        await cdp.evaluate("(() => { const d = document.getElementById('team-drawer'); if (d && d.hidden) { const b = document.getElementById('team-pill'); if (b) b.click(); } return true; })()");
        await sleep(220);
        const geo = await scrollTo(cdp, selector);
        if (!geo || !Number.isFinite(geo.viewportTop) || geo.viewportTop < 0) { await sleep(220); continue; }
        const ok = await shot(cdp, file);
        if (ok) return { ok: true, attempt: i + 1, geo };
        await sleep(200);
      }
      return { ok: false };
    };
    const scrolled = await shotTab(path.join(EVID, 'real-shot-panel.png'), '#session-queue-panel');
    const scrolledDispatch = await shotTab(path.join(EVID, 'real-shot-dispatch.png'), '[data-dispatch-entry]');
    await cdp.evaluate("(() => { const v = document.getElementById('dsh-view'); if (v) { v.style.display = v.dataset.sqPrevDisplay || ''; delete v.dataset.sqPrevDisplay; } return true; })()");
    check('真窗口截图（面板 / 派单入口；已隐藏 webview 并确认面板在视口内）',
      scrolled.ok === true && scrolledDispatch.ok === true,
      { panel: scrolled, dispatch: scrolledDispatch });
    panel = await cdp.evaluate(READ);
  } finally {
    await close(inst);
  }

  const after = { team: statOf(REAL_TEAM_JSON), wake: statOf(REAL_WAKE), store: statOf(REAL_STORE), snapshot: statOf(REAL_SNAPSHOT) };
  check('隔离：真实 团队.json sha256+mtime 未变', JSON.stringify(before.team) === JSON.stringify(after.team), { before: (before.team || {}).sha256 });
  // 唤醒.jsonl 是会话活动实时追加的：只要前缀没变（只追加、未改写）就说明我们没碰它
  const prefixSame = (() => {
    if (!before.wake || !after.wake) return !before.wake && !after.wake;
    const n = Math.min(before.wake.bytes, after.wake.bytes);
    const a = crypto.createHash('sha256').update(fs.readFileSync(REAL_WAKE).subarray(0, n)).digest('hex');
    return a === before.wake.prefixHash && after.wake.bytes >= before.wake.bytes;
  })();
  check('隔离：真实 唤醒.jsonl 只被团队自己追加、前缀未变（我们没改写）', prefixSame && after.wake.bytes >= before.wake.bytes,
    { beforeBytes: (before.wake || {}).bytes, afterBytes: (after.wake || {}).bytes, beforePrefix: (before.wake || {}).prefixHash, prefixSame });
  check('隔离：真实 data/userdata/workbench.json 未变', JSON.stringify(before.store) === JSON.stringify(after.store), { before: (before.store || {}).sha256 });
  check('只读：本次复验没有生成真实 团队/状态/会话排队.json', JSON.stringify(before.snapshot) === JSON.stringify(after.snapshot), { existsBefore: Boolean(before.snapshot), existsAfter: Boolean(after.snapshot) });

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(EVID, 'real-shot-result.json'), JSON.stringify({
    at: new Date().toISOString(),
    ok: failed.length === 0,
    total: results.length,
    failed: failed.length,
    sandbox: { data: DATA, team: TEAM, wakeCopiedFrom: REAL_WAKE },
    port: PORT,
    results,
  }, null, 2) + '\n', 'utf8');
  console.log(`\nSQ_REAL_SHOT ${JSON.stringify({ ok: failed.length === 0, total: results.length, failed: failed.length, outDir: EVID })}`);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((error) => {
  console.error('SQ_REAL_SHOT_FATAL ' + String((error && error.stack) || error));
  process.exit(1);
});
