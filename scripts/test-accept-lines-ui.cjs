#!/usr/bin/env node
'use strict';
/**
 * B-20261117-190649-d113 真窗口复验：评审弹窗「验收点」逐条换行。
 *
 * 口径（与 scripts/sq-real-shot.cjs 同套路，避免踩过的坑重踩）：
 *   · 真窗口：`scripts/run-electron.cjs . --remote-debugging-port=<port>`，CDP 断言 + 截图；
 *   · 隔离：AWB_DATA_DIR + TEAM_ROOT + TEAM_SELFTEST=1 三件套；真实 团队/状态 与 data/userdata 只做
 *     「sha256+mtime 未变」断言，一个字节都不写；沙盘团队.json 清空 sessionId 防误唤醒；
 *   · 夹具：把两条夹具需求（①-⑦ 条 / 200 字无标点单行）注入沙盘 工作流.json，不改真实文件；
 *   · 根路径自适应：从 __dirname 上溯找含「团队/工具/team.mjs」的仓库根（脚本放 _tmp/ 或证据目录也能跑）。
 *
 * 用法：node scripts/test-accept-lines-ui.cjs
 * 产出（默认 程序员B/产出/证据-d113/，可用 AWB_D113_OUT 覆盖）：
 *   before-after.png（同窗口同宽对比：改前整段一行 / 改后逐条）、dialog.png（弹窗实拍）、run-d113.json
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

function findRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, '团队', '工具', 'team.mjs'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(start, '..');
}
const ROOT = findRoot(__dirname);
const PROJ = path.join(ROOT, '项目', '工作台改造修复');
const PNAME = '工作台改造修复';
const UNIQ = `d113-${process.pid}-${Date.now()}`;
const SB = path.join(ROOT, '_tmp', UNIQ);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const REAL_TEAM_JSON = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_WF = path.join(ROOT, '团队', '状态', '项目', PNAME, '工作流.json');
const PORT = Number(process.env.AWB_D113_PORT || (9501 + (process.pid % 40)));
const EVID = process.env.AWB_D113_OUT ? path.resolve(process.env.AWB_D113_OUT) : path.join(PROJ, '程序员B', '产出', '证据-d113');

const FIX1 = 'R-20261117-190000-d113a';
const ACCEPT_FIX1 = '①验收点一：弹窗逐条换行；②验收点二：文字零丢失；③验收点三：超长行不横向溢出；④验收点四：详情保留换行；⑤验收点五：通过/打回/跳过不受影响；⑥验收点六：意见框内容不变；⑦验收点七：截图 before/after 一致';
const DETAIL_FIX1 = '第一行：这是详情全文的第一行\n第二行：这是第二行（应保留换行）\n第三行：这是第三行';
const FIX2 = 'R-20261117-190001-d113b';
const ACCEPT_FIX2 = '这是一条没有任何标点的超长验收点说明用来验证容器不会出现横向滚动条'.repeat(7);

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
      if (out && out.exceptionDetails) {
        return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text).slice(0, 500) };
      }
      return out && out.result ? out.result.value : undefined;
    } catch (e) { return { __cdperror: String((e && e.message) || e) }; }
  }
}

/** 沙盘：真实团队状态只读副本 + 两条夹具需求（只改沙盘副本）。 */
function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  const projectState = path.join(TEAM, '状态', '项目', PNAME);
  fs.mkdirSync(projectState, { recursive: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  for (const name of ['团队宪法.md', '项目铁律.md']) {
    try { fs.copyFileSync(path.join(ROOT, '团队', name), path.join(TEAM, name)); } catch { /* 缺文档不影响弹窗 */ }
  }
  const team = JSON.parse(fs.readFileSync(REAL_TEAM_JSON, 'utf8').replace(/^\uFEFF/, ''));
  for (const member of team.members || []) member.sessionId = '';   // 防沙盘误唤醒真实会话
  team.activeProject = PNAME;
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');

  const wf = JSON.parse(fs.readFileSync(REAL_WF, 'utf8').replace(/^\uFEFF/, ''));
  const fixture = (id, acceptance, detail) => ({
    id, title: `夹具需求（验收点换行 ${id.slice(-4)}）`, status: 'approved', priority: 'P1',
    acceptance, detail, ownerReview: { status: 'pending', at: null, opinion: '', channel: '', recordedBy: '' },
    decisions: [], requirementReview: {}, trq: {}, round: 1, updatedAt: new Date().toISOString(),
  });
  const fixtures = [fixture(FIX1, ACCEPT_FIX1, DETAIL_FIX1), fixture(FIX2, ACCEPT_FIX2, '短详情')];
  // 真实 工作流.json 的 requirements 是「id → 行」的对象映射（不是数组）；两种形态都兼容，只往沙盘副本里加两条。
  let rowCount = 0;
  if (wf.requirements && typeof wf.requirements === 'object' && !Array.isArray(wf.requirements)) {
    for (const item of fixtures) wf.requirements[item.id] = item;
    rowCount = Object.keys(wf.requirements).length;
  } else {
    const rows = Array.isArray(wf.requirements) ? wf.requirements : [];
    const seen = new Set(rows.map((r) => String(r && r.id)));
    wf.requirements = fixtures.filter((r) => !seen.has(r.id)).concat(rows);
    rowCount = wf.requirements.length;
  }
  fs.writeFileSync(path.join(projectState, '工作流.json'), JSON.stringify(wf, null, 2) + '\n', 'utf8');
  // 验收点/详情读的是「需求镜像任务」(`requirements[id].acceptance = source.acceptance`，见 team-tools.requirementView)，
  // 所以夹具还要在沙盘 任务/ 里放两条镜像任务文件，否则弹窗显示「未记录」。
  const tasksDir = path.join(projectState, '任务');
  fs.mkdirSync(tasksDir, { recursive: true });
  for (const item of fixtures) {
    fs.writeFileSync(path.join(tasksDir, `${item.id}.json`), JSON.stringify({
      id: item.id, type: 'requirement', title: item.title, status: 'open', priority: 'P1',
      acceptance: item.acceptance, detail: item.detail, owner: '', createdBy: 'pm',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8');
  }
  for (const name of ['项目.json', '决策箱.json']) {
    try { fs.copyFileSync(path.join(ROOT, '团队', '状态', '项目', PNAME, name), path.join(projectState, name)); } catch { /* 可选 */ }
  }
  const store = JSON.parse(fs.readFileSync(REAL_STORE, 'utf8').replace(/^\uFEFF/, ''));
  const project = (store.projects || []).find((item) => item && String(item.teamName || item.name || '') === PNAME);
  if (!project) throw new Error(`真实 workbench.json 里没有团队项目 ${PNAME}`);
  project.teamName = PNAME;
  store.projects = [project];
  store.activeProjectId = project.id;
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n', 'utf8');
  return { rows: rowCount, fixtures: fixtures.map((r) => r.id) };
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
    const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(document.getElementById("owner-review-entry"))');
    if (ready === true) break;
    await sleep(500);
  }
  // 壳内 webview 是真实 DSH 页：导航 about:blank（否则独立合成层会盖住弹窗、截图黑底/挂住）
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
async function shotClip(cdp, file, selector) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await cdp.send('Page.bringToFront', {}, 6000);
      const rect = await cdp.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.max(0, r.left + window.scrollX), y: Math.max(0, r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
      if (!rect || !rect.w || rect.w < 40 || !rect.h) return { ok: false, reason: 'rect 无效', rect };
      const out = await cdp.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true,
        clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 },
      }, 20000);
      if (!out || !out.data) { await sleep(400); continue; }
      const buf = Buffer.from(out.data, 'base64');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      if (buf.length > 3000) return { ok: true, bytes: buf.length, rect, attempt };
    } catch (e) { /* 重试 */ }
    await sleep(400);
  }
  return { ok: false };
}

const READ = `(() => {
  const txt = (n) => (n ? String(n.textContent || '') : '');
  const row = document.querySelector('[data-or-accept]');
  const lines = row ? Array.from(row.querySelectorAll('[data-or-accept-line]')) : [];
  const box = row ? row.querySelector('[data-or-accept-lines]') : null;
  const detail = document.querySelector('[data-or-detail]');
  const detailText = document.querySelector('[data-or-detail-text]');
  const card = document.querySelector('.or-card');
  const tops = lines.map((n) => Math.round(n.getBoundingClientRect().top));
  return {
    hasRow: Boolean(row),
    count: lines.length,
    texts: lines.map(txt),
    joined: lines.map(txt).join(''),
    boxOverflow: box ? { scrollWidth: box.scrollWidth, clientWidth: box.clientWidth } : null,
    cardOverflow: card ? { scrollWidth: card.scrollWidth, clientWidth: card.clientWidth } : null,
    tops,
    distinctTops: new Set(tops).size,
    detailWhiteSpace: detailText ? getComputedStyle(detailText).whiteSpace : '',
    detailLines: detailText ? Math.round(detailText.getBoundingClientRect().height / Math.max(1, parseFloat(getComputedStyle(detailText).lineHeight) || 20)) : 0,
    detailText: txt(detailText).slice(0, 200),
    emptyDetail: Boolean(detail),
    selected: (() => { const r = document.querySelector('.or-all-row.selected'); return r ? r.getAttribute('data-or-req') : ''; })(),
  };
})()`;

(async () => {
  fs.mkdirSync(EVID, { recursive: true });
  const before = { team: statOf(REAL_TEAM_JSON), store: statOf(REAL_STORE), wf: statOf(REAL_WF) };
  const seeded = seed();
  check('沙盘注入两条夹具需求（不影响真实工作流）', seeded.rows >= 2, { rows: seeded.rows, fixture: [FIX1, FIX2] });

  const inst = await launch();
  if (!inst) {
    check('真窗口启动（run-electron + CDP）', false, `端口 ${PORT} 未等到 renderer/index.html`);
    fs.writeFileSync(path.join(EVID, 'run-d113.json'), JSON.stringify({ results }, null, 2) + '\n', 'utf8');
    process.exit(1);
  }
  const { cdp } = inst;
  try {
    // 打开评审弹窗：真鼠标点击入口（不是直接调函数）
    let opened = false;
    for (let i = 0; i < 8 && !opened; i += 1) {
      await cdp.evaluate("(() => { const b = document.getElementById('owner-review-entry'); if (b) b.click(); return true; })()");
      await sleep(700);
      opened = await cdp.evaluate("(() => { const d = document.querySelector('[data-owner-review-dialog]'); return Boolean(d && !d.hidden); })()") === true;
    }
    check('评审弹窗打开', opened === true);
    // 选中夹具 1（①-⑦）
    let picked = '';
    for (let i = 0; i < 10; i += 1) {
      const hit = await cdp.evaluate(`(() => { const r = document.querySelector('[data-owner-all-item][data-or-req="${FIX1}"]'); if (!r) return 'missing'; r.click(); return 'clicked'; })()`);
      await sleep(500);
      picked = await cdp.evaluate("(() => { const r = document.querySelector('.or-all-row.selected'); return r ? r.getAttribute('data-or-req') : ''; })()") || '';
      if (hit === 'clicked' && picked === FIX1) break;
    }
    check('夹具 ①-⑦ 行在弹窗里可选中', picked === FIX1, { picked });

    const view = await cdp.evaluate(READ);
    check('验收点拆成 7 行（DOM 行数 = 原文条数）', view.count === 7, { count: view.count });
    check('文字零丢失（各行拼接 === 原文）', view.joined === ACCEPT_FIX1, { bytes: String(view.joined || '').length, expect: ACCEPT_FIX1.length });
    check('每行以对应序号开头（顺序不变）', (view.texts || []).every((t, i) => String(t).startsWith('①②③④⑤⑥⑦'[i])), view.texts);
    check('逐条各占一行（7 个不同 top，不是同一行内折行）', view.distinctTops === 7, { tops: view.tops });
    check('验收点容器无横向溢出', view.boxOverflow && view.boxOverflow.scrollWidth <= view.boxOverflow.clientWidth + 1, view.boxOverflow);
    // 详情全文：pre-wrap 且保留 3 行
    check('详情全文 white-space: pre-wrap', view.detailWhiteSpace === 'pre-wrap', view.detailWhiteSpace);
    check('详情全文按原文换行显示（3 行）', view.detailText === DETAIL_FIX1 && view.detailLines >= 3, { lines: view.detailLines, text: view.detailText });
    check('弹窗整体无横向滚动（超长单行也不撑破）', view.cardOverflow && view.cardOverflow.scrollWidth <= view.cardOverflow.clientWidth + 1, view.cardOverflow);

    // 夹具 2：200+ 字无标点单行
    let picked2 = '';
    for (let i = 0; i < 10; i += 1) {
      await cdp.evaluate(`(() => { const r = document.querySelector('[data-owner-all-item][data-or-req="${FIX2}"]'); if (r) r.click(); return true; })()`);
      await sleep(400);
      picked2 = await cdp.evaluate("(() => { const r = document.querySelector('.or-all-row.selected'); return r ? r.getAttribute('data-or-req') : ''; })()") || '';
      if (picked2 === FIX2) break;
    }
    const view2 = await cdp.evaluate(READ);
    check('超长单行夹具仍只有 1 行（不硬拆碎）', picked2 === FIX2 && view2.count === 1, { picked2, count: view2.count });
    check('超长单行不产生横向滚动', view2.boxOverflow && view2.boxOverflow.scrollWidth <= view2.boxOverflow.clientWidth + 1
      && view2.cardOverflow && view2.cardOverflow.scrollWidth <= view2.cardOverflow.clientWidth + 1, { box: view2.boxOverflow, card: view2.cardOverflow });

    // 回到夹具 1 做 before/after 对比图（同窗口同宽，改前＝旧渲染方式合成，改后＝真实 DOM）
    await cdp.evaluate(`(() => { const r = document.querySelector('[data-owner-all-item][data-or-req="${FIX1}"]'); if (r) r.click(); return true; })()`);
    await sleep(600);
    const built = await cdp.evaluate(`(() => {
      const real = document.querySelector('[data-or-accept]');
      if (!real) return { ok: false };
      const old = document.getElementById('d113-compare');
      if (old) old.remove();
      const box = document.createElement('div');
      box.id = 'd113-compare';
      box.style.cssText = 'position:fixed;left:30px;top:30px;width:860px;background:var(--panel,#1e1e1e);color:var(--text,#efece5);border:2px solid #1f5f8b;border-radius:10px;padding:14px;z-index:99999;font:13px/1.6 inherit;';
      const title = document.createElement('div');
      title.textContent = 'B-20261117-190649-d113 · 评审弹窗「验收点」换行　改前 / 改后（同夹具同宽 860px）';
      title.style.cssText = 'font-weight:700;margin-bottom:6px;';
      box.appendChild(title);
      const label = (t) => { const d = document.createElement('div'); d.textContent = t; d.style.cssText = 'opacity:.72;margin:10px 0 4px;'; return d; };
      box.appendChild(label('改前（旧渲染：acceptance 原文整段塞进一个 span）'));
      const beforeRow = document.createElement('div');
      beforeRow.className = 'or-summary-row';
      beforeRow.setAttribute('data-d113-before', '1');
      const b1 = document.createElement('b'); b1.textContent = '验收点'; beforeRow.appendChild(b1);
      const s1 = document.createElement('span'); s1.textContent = real.querySelector('[data-or-accept-lines]').textContent; beforeRow.appendChild(s1);
      box.appendChild(beforeRow);
      box.appendChild(label('改后（逐条 [data-or-accept-line]，只拆行不改字）'));
      const afterRow = real.cloneNode(true);
      afterRow.setAttribute('data-d113-after', '1');
      box.appendChild(afterRow);
      document.body.appendChild(box);
      return { ok: true, afterLines: afterRow.querySelectorAll('[data-or-accept-line]').length, beforeLines: beforeRow.querySelectorAll('[data-or-accept-line]').length };
    })()`);
    check('对比图构建（改后沿用真实 DOM；改前＝同文本单 span）', built && built.ok === true && built.afterLines === 7 && built.beforeLines === 0, built);
    const shotCompare = await shotClip(cdp, path.join(EVID, 'before-after.png'), '#d113-compare');
    check('before/after 截图落盘', shotCompare.ok === true, shotCompare);
    await cdp.evaluate("(() => { const n = document.getElementById('d113-compare'); if (n) n.remove(); return true; })()");
    const shotDialog = await shotClip(cdp, path.join(EVID, 'dialog.png'), '.or-card');
    check('弹窗实拍落盘', shotDialog.ok === true, shotDialog);
  } finally {
    await close(inst);
  }

  const after = { team: statOf(REAL_TEAM_JSON), store: statOf(REAL_STORE), wf: statOf(REAL_WF) };
  check('隔离：真实 团队.json sha256+mtime 未变', JSON.stringify(before.team) === JSON.stringify(after.team), { before: (before.team || {}).sha256 });
  check('隔离：真实 data/userdata/workbench.json 未变', JSON.stringify(before.store) === JSON.stringify(after.store), { before: (before.store || {}).sha256 });
  // 工作流.json 会被团队（路由守护/其他角色）实时重写，整文件 sha 天然会变；这里验的是**我们没往里注入夹具**：
  // 真实文件里 0 命中夹具 id，真实 任务/ 里 0 个夹具镜像文件。（沙盘副本才带夹具。）
  const realWfText = fs.readFileSync(REAL_WF, 'utf8');
  const realFixtureHits = [FIX1, FIX2].filter((id) => realWfText.includes(id));
  const realTaskHits = [FIX1, FIX2].filter((id) => fs.existsSync(path.join(ROOT, '团队', '状态', '项目', PNAME, '任务', `${id}.json`)));
  check('隔离：真实 工作流.json / 任务 里 0 个夹具（夹具只在沙盘副本）', realFixtureHits.length === 0 && realTaskHits.length === 0,
    { fixtureInWf: realFixtureHits, fixtureInTasks: realTaskHits, wfShaChangedByTeam: JSON.stringify(before.wf) !== JSON.stringify(after.wf) });

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(EVID, 'run-d113.json'), JSON.stringify({
    at: new Date().toISOString(), ok: failed.length === 0, total: results.length, failed: failed.length,
    sandbox: { data: DATA, team: TEAM }, port: PORT, fixtures: { [FIX1]: ACCEPT_FIX1, [FIX2]: ACCEPT_FIX2 }, results,
  }, null, 2) + '\n', 'utf8');
  console.log(`\nACCEPT_LINES_UI ${JSON.stringify({ ok: failed.length === 0, passed: results.length - failed.length, total: results.length, evidence: EVID })}`);
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
})();
