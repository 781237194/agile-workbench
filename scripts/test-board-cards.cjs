#!/usr/bin/env node
'use strict';
/**
 * T-20261117-081947-6ea6（团队看板移除【提案】【提交】【文件】三张数字卡片）真窗口取证。
 *
 * 两个卡片面：
 *  ① 主窗内嵌看板浮窗 #board-panel：
 *     - 顶部小结条 #board-panel-meta（app.js boardCountsMarkup，.board-num 小卡：需求/任务/提交/回执/文件）
 *     - iframe #board-panel-frame 载入 团队/看板.html（board.mjs renderBoardHtml，.card 大卡：需求/进行中任务/提案/回执/项目文件/成员）
 *  ② 独立看板浮窗（team:board-old）直接 loadFile 看板.html，只有 .card 大卡。
 *
 * 隔离：AWB_DATA_DIR + TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_WORKBENCH_JSON 全指 _tmp/board-cards/sb，
 *       真实 data/userdata/workbench.json、团队/状态/团队.json 前后 sha256+mtime 比对不变。
 * 用法：node scripts/test-board-cards.cjs --label before|after [--port 9451]
 * 产出：<out>/<label>-panel.png、<label>-standalone.png、<label>-report.json
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = '工作台改造修复';
const REAL_TEAM = path.join(ROOT, '团队');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const REAL_TEAM_JSON = path.join(REAL_TEAM, '状态', '团队.json');
const BASE = path.join(ROOT, '_tmp', 'board-cards');
const SB = path.join(BASE, 'sb');
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const OUT = path.join(BASE, 'out');

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const LABEL = argOf('--label', 'run');
const PORT = Number(argOf('--port', '9451'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 500)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256File = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
const statOf = (f) => { try { const s = fs.statSync(f); return { bytes: s.size, mtimeMs: Math.round(s.mtimeMs), sha256: sha256File(f) }; } catch { return null; } };

function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name); const d = path.join(dst, ent.name);
    if (filter && filter(s, ent)) continue;
    try {
      if (ent.isDirectory()) copyDir(s, d, filter);
      else if (ent.isFile()) fs.copyFileSync(s, d);
    } catch (e) {
      // 真实团队目录正在被守护进程原子写：临时文件可能在 readdir 后消失，跳过即可（沙盘只需稳定快照）
      if (e && e.code === 'ENOENT') continue;
      throw e;
    }
  }
}

function seedSandbox() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  const store = JSON.parse(fs.readFileSync(REAL_STORE, 'utf8'));
  const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PROJECT);
  if (!project) throw new Error(`真实 workbench.json 里没有团队项目 ${PROJECT}`);
  store.projects = [project];
  store.activeProjectId = project.id;
  fs.writeFileSync(path.join(DATA, 'userdata', 'workbench.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
  // 团队沙盘：排除邮箱（上百 MB）与锁；保留工具/状态/项目（看板数据源）
  copyDir(REAL_TEAM, TEAM, (s) => /[\\/]邮箱([\\/]|$)/.test(s) || /[\\/]锁([\\/]|$)/.test(s));
  const teamFile = path.join(TEAM, '状态', '团队.json');
  const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = '';
  fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
  const startDir = path.join(TEAM, '状态', '启动');
  if (fs.existsSync(startDir)) for (const f of fs.readdirSync(startDir)) if (f.endsWith('.json')) fs.rmSync(path.join(startDir, f), { force: true });
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
  async evaluate(expr, ms = 60000) {
    try {
      const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, ms);
      if (out && out.exceptionDetails) {
        return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text).slice(0, 500) };
      }
      return out && out.result ? out.result.value : undefined;
    } catch (e) { return { __cdperror: String((e && e.message) || e) }; }
  }
}
async function connectTarget(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return { cdp, ws };
}

async function realClick(cdp, selector) {
  const geo = await cdp.evaluate(`(function(){
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { missing: true };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    const hit = (r.width > 0 && r.height > 0) ? document.elementFromPoint(x, y) : null;
    return { x, y, w: Math.round(r.width), h: Math.round(r.height), hitIsTarget: Boolean(hit && (hit === el || el.contains(hit))) };
  })()`);
  if (!geo || geo.missing) return { mode: 'missing', geo };
  if (geo.w > 0 && geo.h > 0 && geo.hitIsTarget) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.x, y: geo.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });
    return { mode: 'mouse', geo };
  }
  await cdp.evaluate(`(function(){ const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return true; })()`);
  return { mode: 'element', geo };
}

async function shot(cdp, file, clip) {
  try { await cdp.send('Page.bringToFront', {}, 8000); } catch { /* */ }
  let lastErr = '';
  for (let i = 0; i < 4; i += 1) {
    try {
      const params = { format: 'png', fromSurface: true, captureBeyondViewport: false };
      if (clip) params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 };
      const r = await cdp.send('Page.captureScreenshot', params, 30000);
      if (r && r.data) {
        const buf = Buffer.from(r.data, 'base64');
        fs.writeFileSync(file, buf);
        return { ok: true, tries: i + 1, bytes: buf.length, file: path.basename(file) };
      }
      lastErr = '返回没有 data';
    } catch (e) { lastErr = String((e && e.message) || e); }
    await sleep(800);
  }
  return { ok: false, error: lastErr, file: path.basename(file) };
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

const CARD_LABELS_JS = `(function(){
  const pick = (sel) => Array.from(document.querySelectorAll(sel)).map((el) => String(el.textContent || '').trim()).filter(Boolean);
  return {
    cardLabels: pick('.cards .card span'),
    cardCount: document.querySelectorAll('.cards .card').length,
    summaryLabels: pick('#pilot-list li'),
    hasProposalsSection: Array.from(document.querySelectorAll('section h2')).some((h) => /提案/.test(h.textContent || '')),
  };
})()`;

const PANEL_LABELS_JS = `(function(){
  const meta = document.getElementById('board-panel-meta');
  const small = Array.from(document.querySelectorAll('#board-panel-meta .board-num')).map((el) => String((el.querySelector('span') || {}).textContent || '').trim());
  const frame = document.getElementById('board-panel-frame');
  let frameCards = { error: 'no-frame-content' };
  try {
    const doc = frame && frame.contentDocument;
    if (doc) {
      frameCards = {
        cardLabels: Array.from(doc.querySelectorAll('.cards .card span')).map((el) => String(el.textContent || '').trim()),
        cardCount: doc.querySelectorAll('.cards .card').length,
        proposalsSection: Array.from(doc.querySelectorAll('section h2')).some((h) => /提案/.test(h.textContent || '')),
      };
    }
  } catch (e) { frameCards = { error: String((e && e.message) || e) }; }
  const pr = document.getElementById('board-panel').getBoundingClientRect();
  const mr = meta ? meta.getBoundingClientRect() : null;
  return {
    panelHidden: Boolean(document.getElementById('board-panel').hidden),
    panelRect: { x: Math.round(pr.x), y: Math.round(pr.y), width: Math.round(pr.width), height: Math.round(pr.height) },
    metaText: meta ? String(meta.textContent || '').slice(0, 300) : '',
    metaRect: mr ? { x: Math.round(mr.x), y: Math.round(mr.y), width: Math.round(mr.width), height: Math.round(mr.height) } : null,
    smallLabels: small,
    framePath: frame ? String(frame.getAttribute('src') || '') : '',
    frameCards,
  };
})()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const realStoreBefore = statOf(REAL_STORE);
  const realTeamJsonBefore = statOf(REAL_TEAM_JSON);
  const boardHtml = path.join(REAL_TEAM, '看板.html');
  const boardHtmlBefore = statOf(boardHtml);

  const t0 = Date.now();
  seedSandbox();
  console.log(`sandbox ready in ${((Date.now() - t0) / 1000).toFixed(1)}s · ${SB}`);

  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT, '--no-wake'], {
    cwd: ROOT, env: launchEnv(), stdio: 'ignore', windowsHide: false,
  });
  let inst = null;
  try {
    const target = await waitTarget(PORT, 90000, (x) => x && x.type === 'page' && String(x.url || '').includes('renderer/index.html'));
    if (!target) throw new Error('主窗页面目标没起来');
    inst = await connectTarget(target);
    const { cdp } = inst;
    for (let i = 0; i < 120; i += 1) {
      const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(document.getElementById("board-launcher"))');
      if (ready === true) break;
      await sleep(500);
    }
    // 壳内 webview 是真实 DSH：先 about:blank，避免截图黑底/挂住（只影响本隔离实例）
    const guest = await waitTarget(PORT, 8000, (x) => x && x.type === 'webview');
    if (guest) {
      try {
        const g = await connectTarget(guest);
        await g.cdp.send('Page.navigate', { url: 'about:blank' }).catch(() => {});
        await sleep(500);
      } catch { /* */ }
    }
    // 展开右下浮动入口组 → 点团队看板
    await realClick(cdp, '#side-float-toggle');
    await sleep(600);
    const openClick = await realClick(cdp, '#board-launcher');
    console.log('open board panel click:', JSON.stringify(openClick.mode));
    // 等待看板生成（team:board 会真跑 team.mjs board，12MB HTML 要几十秒）
    let panel = null;
    const genStart = Date.now();
    for (let i = 0; i < 200; i += 1) {
      panel = await cdp.evaluate(PANEL_LABELS_JS);
      if (panel && !panel.panelHidden && panel.framePath && panel.smallLabels.length >= 1) {
        const fc = panel.frameCards || {};
        if (Array.isArray(fc.cardLabels) && fc.cardLabels.length) break;
      }
      await sleep(700);
    }
    console.log(`panel ready in ${((Date.now() - genStart) / 1000).toFixed(1)}s`);
    const shotPanel = await shot(cdp, path.join(OUT, `${LABEL}-panel.png`), panel && panel.panelRect && panel.panelRect.width > 300 ? panel.panelRect : undefined);
    const shotMain = await shot(cdp, path.join(OUT, `${LABEL}-main.png`));

    // 独立浮窗：点「独立浮窗」按钮，新窗口直接 loadFile 看板.html
    await realClick(cdp, '#board-panel-open');
    const standaloneTarget = await waitTarget(PORT, 120000, (x) => x && x.type === 'page' && /看板\.html/.test(decodeURIComponent(String(x.url || ''))));
    let standalone = null;
    let shotStandalone = null;
    if (standaloneTarget) {
      await sleep(1500);
      standalone = await connectTarget(standaloneTarget);
      for (let i = 0; i < 60; i += 1) {
        const st = await standalone.cdp.evaluate('document.readyState === "complete" && document.querySelectorAll(".cards .card").length');
        if (Number(st) >= 1) break;
        await sleep(500);
      }
      standalone.cards = await standalone.cdp.evaluate(CARD_LABELS_JS);
      const size = await standalone.cdp.evaluate('({w: window.innerWidth, h: window.innerHeight})');
      shotStandalone = await shot(standalone.cdp, path.join(OUT, `${LABEL}-standalone.png`));
      console.log('standalone viewport', JSON.stringify(size), 'shot', JSON.stringify(shotStandalone && shotStandalone.ok));
    } else {
      console.log('standalone window target NOT found');
    }

    const report = {
      label: LABEL,
      generatedAt: new Date().toISOString(),
      boardHtmlPath: boardHtml,
      boardHtmlBefore,
      boardHtmlAfter: statOf(boardHtml),
      panel,
      standaloneCards: standalone ? standalone.cards : null,
      shots: { panel: shotPanel, main: shotMain, standalone: shotStandalone },
      sandbox: { base: SB, data: DATA, team: TEAM },
    };
    fs.writeFileSync(path.join(OUT, `${LABEL}-report.json`), JSON.stringify(report, null, 2) + '\n', 'utf8');

    // ── 断言 ─────────────────────────────────────────────
    check('看板浮窗已打开（#board-panel 可见）', panel && panel.panelHidden === false, panel && panel.panelHidden);
    check('浮窗 top 小结条（.board-num 小卡）≥1', panel && panel.smallLabels.length >= 1, panel && panel.smallLabels);
    check('iframe 内大卡（.cards .card）≥1', panel && panel.frameCards && Array.isArray(panel.frameCards.cardLabels) && panel.frameCards.cardLabels.length >= 1, panel && panel.frameCards);
    check('浮窗截图落盘', shotPanel && shotPanel.ok, shotPanel);
    check('独立浮窗 cards 可读', standalone && standalone.cards && Array.isArray(standalone.cards.cardLabels), standalone && standalone.cards);
    check('独立浮窗截图落盘', shotStandalone && shotStandalone.ok, shotStandalone);
    // 两处卡片 label 合起来：被取消的三个 0 命中，其它 ≥1
    const allLabels = [].concat(
      (panel && Array.isArray(panel.smallLabels) ? panel.smallLabels : []),
      (panel && panel.frameCards && Array.isArray(panel.frameCards.cardLabels) ? panel.frameCards.cardLabels : []),
      (standalone && standalone.cards && Array.isArray(standalone.cards.cardLabels) ? standalone.cards.cardLabels : []),
    );
    const uniq = [...new Set(allLabels)];
    console.log('ALL CARD LABELS:', JSON.stringify(uniq));
    for (const ban of ['提案', '提交', '文件']) {
      const hit = uniq.filter((x) => x === ban);
      check(`label「${ban}」0 命中`, hit.length === 0, { hit, uniq });
    }
    for (const need of ['需求', '进行中任务', '回执', '项目文件', '成员']) {
      const hit = uniq.filter((x) => x === need || x.includes(need));
      check(`label「${need}」≥1`, hit.length >= 1, { uniq });
    }
    // 数据源未被破坏：提案章节仍在（只取消数字卡片，不是删数据/章节）
    if (panel && panel.frameCards) check('看板「三、提案」章节仍在（只取消卡片）', panel.frameCards.proposalsSection === true, panel.frameCards);
    // 隔离：真实状态文件不变
    const realStoreAfter = statOf(REAL_STORE);
    const realTeamJsonAfter = statOf(REAL_TEAM_JSON);
    check('真实 workbench.json 未被写', JSON.stringify(realStoreBefore) === JSON.stringify(realStoreAfter), { before: realStoreBefore, after: realStoreAfter });
    check('真实 团队.json 未被写', JSON.stringify(realTeamJsonBefore) === JSON.stringify(realTeamJsonAfter), { before: realTeamJsonBefore, after: realTeamJsonAfter });
  } catch (e) {
    console.error('FATAL', e && e.stack || e);
    check('harness 无异常', false, String((e && e.message) || e));
  } finally {
    if (inst) { try { await inst.cdp.send('Browser.close', {}, 5000); } catch { /* */ } }
    try { child.kill(); } catch { /* */ }
    await sleep(1500);
  }

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT, `${LABEL}-assertions.json`), JSON.stringify({ results, failed: failed.length, ok: failed.length === 0 }, null, 2) + '\n', 'utf8');
  console.log(failed.length ? `BOARD_CARDS_FAIL ${failed.length}/${results.length}` : `BOARD_CARDS_OK ${results.length}/${results.length}`);
  process.exitCode = failed.length ? 1 : 0;
})();
