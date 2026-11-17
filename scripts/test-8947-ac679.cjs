'use strict';
/**
 * R-8947（关闭特效开关）· AC6 / AC7 / AC9 独立验证（真窗口 + CDP 真点击 + 隔离数据根）
 *
 * 背景：8947 已 test_done，但 v244/v245 只覆盖 AC1–AC5/AC8（--effect-check），
 *       AC6（fps 对比）/ AC7（写盘失败回退）/ AC9（跨窗口一致）缺独立运行时证据。
 *
 * 断言：
 *   AC6 同窗口、tech-dark、zoom100%、静置≥3s，full 与 off 各采 3 个 __themeProbe(3000) 窗口中位数；
 *       六字段（fps/p95FrameMs/dropRate/frames/sampleMs/source）齐 + 提升百分比；
 *       off.fps ≥ full.fps 且 off.dropRate ≤ full.dropRate；source≠themeProbe 或 p95=null 的窗口作废补采（每窗最多 3 次）。
 *   AC7 ①先成功设 off（磁盘/菜单/属性三处）；②workbench.json 只读 → 设 full：直连 IPC 返回 EFFECT_LEVEL_WRITE_FAILED、
 *       [data-effect-error] 含 code 且可见、界面回退 off、磁盘仍 off 且 sha 不变；③恢复可写（含 .bak/.tmp/.lock）再设 full → 成功。
 *   AC9 主窗 + 独立看板窗（team:board-old）+ webview guest 同开，主窗切 off 后 ≤500ms 看板窗/guest 属性也变 off。
 *   隔离：真实 data/userdata/workbench.json、团队/状态/团队.json、团队/看板.html、项目关键文件前后 sha256+mtime 不变。
 *
 * 跑法：node scripts/test-8947-ac679.cjs     （退出码 0=全绿；1=有红）
 * 产物：项目/工作台改造修复/测试人员/产出/证据-8947-ac6-ac7-ac9/（可用 AWB_8947_OUT 覆盖）
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
const REAL_PROJECT = path.join(ROOT, '项目', PROJECT);
const REAL_TEAM_JSON = path.join(REAL_TEAM, '状态', '团队.json');
const REAL_BOARD_HTML = path.join(REAL_TEAM, '看板.html');
const BASE = path.join(ROOT, '_tmp', '8947-ac679');
const SB = path.join(BASE, 'sb');
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const PROJ_DIR = path.join(SB, '项目', PROJECT);
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const EVID = process.env.AWB_8947_OUT
  ? path.resolve(process.env.AWB_8947_OUT)
  : path.join(REAL_PROJECT, '测试人员', '产出', '证据-8947-ac6-ac7-ac9');
const PORT = Number(process.env.AWB_8947_PORT || 9437);

const results = [];
const log = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) {
  const row = { name, ok: Boolean(ok), detail: ok ? (detail === undefined ? '' : detail) : detail };
  results.push(row);
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 700)}`;
  log.push(line);
  console.log(line);
  try { fs.appendFileSync(path.join(ROOT, '_tmp', '8947-ac679-progress.log'), `[${new Date().toISOString()}] ${line.slice(0, 200)}\n`); } catch { /* ignore */ }
  if (!ok) process.exitCode = 1;
}
function shaOf(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; }
}
function statOf(file) {
  try { const s = fs.statSync(file); return { bytes: s.size, mtimeMs: s.mtimeMs, sha256: shaOf(file) }; } catch { return null; }
}

// ── CDP ─────────────────────────────────────────────────────────────
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
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      }
    });
  }
  send(method, params = {}, ms = 60000) {
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
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return { ws, cdp };
}
async function realClick(cdp, selector) {
  const geo = await cdp.evaluate(`(function(){
    var el=document.querySelector(${JSON.stringify(selector)});
    if(!el) return {missing:true};
    el.scrollIntoView({block:'center',inline:'center'});
    var r=el.getBoundingClientRect();
    var x=Math.round(r.x+r.width/2), y=Math.round(r.y+r.height/2);
    var hit=(r.width>0&&r.height>0)?document.elementFromPoint(x,y):null;
    return {x:x,y:y,w:Math.round(r.width),h:Math.round(r.height),hitIsTarget:Boolean(hit&&(hit===el||el.contains(hit))),disabled:Boolean(el.disabled)};
  })()`);
  if (!geo || geo.missing) return { mode: 'missing', geo };
  if (geo.w > 0 && geo.h > 0 && geo.hitIsTarget && !geo.disabled) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.x, y: geo.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });
    return { mode: 'mouse', geo };
  }
  await cdp.evaluate(`(function(){var el=document.querySelector(${JSON.stringify(selector)}); if(el) el.click(); return true;})()`);
  return { mode: 'element', geo };
}
async function shot(cdp, file) {
  try { await cdp.send('Page.bringToFront', {}, 8000); } catch { /* ignore */ }
  let lastErr = '';
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
  return { ok: false, error: lastErr, file: path.basename(file) };
}

// ── 沙盘 seed ───────────────────────────────────────────────────────
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else if (ent.isFile()) {
      try { fs.copyFileSync(s, d); } catch (e) { if (e && e.code !== 'ENOENT') throw e; }
    }
  }
}
function seedSandbox() {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  // store：只保留本项目，项目路径改指沙盘空目录（看板生成只写沙盘，不碰真实项目树）
  const store = JSON.parse(fs.readFileSync(REAL_STORE, 'utf8'));
  const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PROJECT);
  if (!project) throw new Error(`真实 workbench.json 里没有团队项目 ${PROJECT}`);
  fs.mkdirSync(PROJ_DIR, { recursive: true });
  project.path = PROJ_DIR;
  store.projects = [project];
  store.activeProjectId = project.id;
  store.ui = { ...(store.ui || {}), effectLevel: 'full', zoom: 1 };
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n', 'utf8');
  // 团队沙盘：工具 + 顶层 md + 本项目状态（不含邮箱；状态只取本项目，避免 200MB 级复制）
  fs.mkdirSync(path.join(TEAM, '状态', '项目'), { recursive: true });
  copyDir(path.join(REAL_TEAM, '工具'), path.join(TEAM, '工具'));
  for (const ent of fs.readdirSync(REAL_TEAM, { withFileTypes: true })) {
    if (ent.isFile() && /\.md$/i.test(ent.name) && !/^看板\./i.test(ent.name)) {
      fs.copyFileSync(path.join(REAL_TEAM, ent.name), path.join(TEAM, ent.name));
    }
  }
  copyDir(path.join(REAL_TEAM, '状态', '项目', PROJECT), path.join(TEAM, '状态', '项目', PROJECT));
  const team = JSON.parse(fs.readFileSync(REAL_TEAM_JSON, 'utf8'));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = '';
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  return { store, projectId: project.id };
}

function launchEnv() {
  return {
    ...process.env,
    AWB_DATA_DIR: DATA,
    TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: path.join(TEAM, '状态', '项目'),
    TEAM_WORKBENCH_JSON: STORE,
    TEAM_SELFTEST: '1',
    DSH_WEB_URL: '',
  };
}

// ── 页面侧工具 ──────────────────────────────────────────────────────
const EFFECT_STATE_JS = `(function(){
  var menu=document.getElementById('more-menu');
  var err=document.querySelector('#more-menu [data-effect-error]');
  var er=err?err.getBoundingClientRect():null;
  var ban=document.getElementById('effect-error-banner');
  var br=ban?ban.getBoundingClientRect():null;
  var cur=document.querySelector('#more-menu [data-effect-current]');
  var opts=[].map.call(document.querySelectorAll('#more-menu [data-effect-menu] [data-effect-option]'),function(x){return {v:x.getAttribute('data-effect-option'),checked:x.getAttribute('aria-checked')};});
  var st=window.__themeState?window.__themeState():null;
  var s=st&&st.fx&&typeof st.fx.sample==='function'?st.fx.sample():null;
  return {
    attr: document.documentElement.getAttribute('data-effect-level')||'',
    current: cur?cur.textContent:'',
    options: opts,
    menuHidden: menu?Boolean(menu.hidden):true,
    error: err?{hidden:Boolean(err.hidden),text:String(err.textContent||''),w:er?Math.round(er.width):0,h:er?Math.round(er.height):0}:null,
    banner: ban?{hidden:Boolean(ban.hidden),text:String(ban.textContent||''),w:br?Math.round(br.width):0,h:br?Math.round(br.height):0,role:String(ban.getAttribute('role')||'')}:null,
    degrade: s?s.degrade:null,
    perf: s?s.perf:null,
    themeId: st?st.themeId:'',
    source: st?st.source:'',
    effectLevelState: st?st.effectLevel:'',
    dpr: window.devicePixelRatio,
    winW: window.innerWidth,
    winH: window.innerHeight
  };
})()`;

async function readEffect(cdp) { return cdp.evaluate(EFFECT_STATE_JS); }
async function openMore(cdp) {
  await cdp.evaluate(`(function(){var b=document.getElementById('btn-more'); if(b&&document.getElementById('more-menu').hidden) b.click(); return true;})()`);
  await sleep(280);
}
async function openEffectMenu(cdp) {
  await openMore(cdp);
  await cdp.evaluate(`(function(){var e=document.querySelector('#more-menu [data-more="effect"]'); if(e&&document.querySelector('#more-menu [data-effect-menu]').hidden) e.click(); return true;})()`);
  await sleep(320);
}
async function choose(cdp, opt) {
  await openEffectMenu(cdp);
  const clicked = await realClick(cdp, `#more-menu [data-effect-menu] [data-effect-option="${opt}"]`);
  await sleep(900);
  return clicked;
}
async function ensureTheme(cdp, themeId) {
  await openMore(cdp);
  await cdp.evaluate(`(function(){var b=document.querySelector('#more-menu [data-more="theme"]'); if(b&&document.querySelector('#more-menu [data-theme-menu]').hidden) b.click(); return true;})()`);
  await sleep(300);
  await realClick(cdp, `#more-menu [data-theme-menu] [data-theme-id="${themeId}"]`);
  await sleep(600);
  return cdp.evaluate('(function(){var st=window.__themeState?window.__themeState():null;return st?st.themeId:"";})()');
}

// 单窗采样：__themeProbe(3000) → 立即读 sample().perf（source 必须 themeProbe）
async function probeOnce(cdp) {
  return cdp.evaluate(`(function(){
    return window.__themeProbe(3000).then(function(p){
      var st=window.__themeState?window.__themeState():null;
      var s=st&&st.fx&&typeof st.fx.sample==='function'?st.fx.sample():null;
      return { probe:p, perf:s?s.perf:null, degrade:s?s.degrade:null, degraded:st?st.fxDegraded:null, themeId:st?st.themeId:'', winW:window.innerWidth, winH:window.innerHeight, dpr:window.devicePixelRatio };
    });
  })()`, 40000);
}
function probeValid(r) {
  if (!r || r.__exception || r.__cdperror) return false;
  const p = r.perf || {};
  const pr = r.probe || {};
  if (String(p.source || '') !== 'themeProbe') return false;
  if (!Number.isFinite(Number(pr.p95FrameMs))) return false;
  if (!Number.isFinite(Number(p.p95FrameMs))) return false;
  if (Number(pr.frames || 0) < 20) return false;
  return true;
}
async function sample3(cdp, label, notes) {
  const wins = [];
  for (let k = 0; k < 3; k += 1) {
    let got = null; let tries = 0;
    for (let t = 0; t < 3; t += 1) {
      tries += 1;
      const r = await probeOnce(cdp);
      if (probeValid(r)) { got = r; break; }
      notes.push({ label, window: k + 1, try: t + 1, invalid: r && (r.__exception || r.__cdperror || { source: (r.perf || {}).source, p95: (r.perf || {}).p95FrameMs }) });
      await sleep(600);
    }
    if (!got) { wins.push({ invalid: true, tries }); continue; }
    wins.push({
      index: k + 1,
      tries,
      themeId: got.themeId,
      fps: Number(got.perf.fps),
      p95FrameMs: Number(got.perf.p95FrameMs),
      dropRate: Number(got.perf.dropRate),
      frames: Number(got.perf.frames),
      sampleMs: Number(got.perf.sampleMs),
      source: String(got.perf.source || ''),
      memMB: got.perf.memMB == null ? null : Number(got.perf.memMB),
      degrade: got.degrade,
      degraded: got.degraded,
      winW: got.winW, winH: got.winH, dpr: got.dpr,
      at: new Date().toISOString(),
    });
  }
  return wins;
}
function median(values) {
  const xs = values.filter((v) => Number.isFinite(Number(v))).map(Number).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : Math.round(((xs[mid - 1] + xs[mid]) / 2) * 100) / 100;
}

// ── 主流程 ──────────────────────────────────────────────────────────
(async () => {
  fs.mkdirSync(EVID, { recursive: true });
  const realBefore = {
    store: statOf(REAL_STORE),
    teamJson: statOf(REAL_TEAM_JSON),
    boardHtml: statOf(REAL_BOARD_HTML),
    projectInfo: statOf(path.join(REAL_PROJECT, '项目信息.md')),
    projectIron: statOf(path.join(REAL_PROJECT, '项目铁律.md')),
  };
  check('基线可读（真实 store / 团队.json / 看板.html / 项目文档）', Boolean(realBefore.store && realBefore.teamJson && realBefore.projectInfo && realBefore.projectIron), {
    store: realBefore.store && realBefore.store.bytes, teamJson: realBefore.teamJson && realBefore.teamJson.bytes,
  });
  const realStoreJsonBefore = (() => { try { return JSON.parse(fs.readFileSync(REAL_STORE, 'utf8')); } catch { return null; } })();

  const seed = seedSandbox();
  check('沙盘 seed 完成（store 单项目 + 团队工具/状态副本 + 沙盘项目目录）', fs.existsSync(STORE) && fs.existsSync(path.join(TEAM, '工具', 'team.mjs')), { store: shaOf(STORE).slice(0, 12), projectId: seed.projectId });

  let child = null; let inst = null; let boardInst = null; let guestInst = null; let boardTarget = null;
  const notes = [];
  const ac6 = { full: null, off: null, improvementPct: null, medians: {} };
  const ac7 = {};
  const ac9 = {};
  const shots = {};
  try {
    child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], {
      cwd: ROOT, env: launchEnv(), stdio: 'ignore', windowsHide: false,
    });
    const target = await waitTarget(PORT, 90000, (x) => x && x.type === 'page' && String(x.url || '').includes('renderer/index.html'));
    if (!target) throw new Error('主窗页面目标未出现');
    inst = await connect(target);
    const cdp = inst.cdp;
    for (let i = 0; i < 120; i += 1) {
      const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(document.getElementById("more-menu"))');
      if (ready === true) break;
      await sleep(500);
    }
    check('隔离实例启动 + CDP 连上主窗 renderer', true, { port: PORT, dataRoot: DATA });
    // 壳内 webview：先 about:blank（只为截图稳定；AC9 仍验证 type=webview 收到广播）
    const guestTarget = await waitTarget(PORT, 8000, (x) => x && x.type === 'webview');
    if (guestTarget) {
      guestInst = await connect(guestTarget);
      try { await guestInst.cdp.send('Page.navigate', { url: 'about:blank' }, 8000); } catch { /* ignore */ }
      await sleep(600);
    }
    await cdp.send('Page.bringToFront').catch(() => {});

    // ── AC6 ─────────────────────────────────────────────────────
    const themeNow = await ensureTheme(cdp, 'tech-dark');
    const zoomFact = await cdp.evaluate('(function(){try{return window.devicePixelRatio;}catch(e){return null;}})()');
    check('AC6 前置：当前主题 tech-dark、store zoom=1（100%）', themeNow === 'tech-dark' && Number(JSON.parse(fs.readFileSync(STORE, 'utf8')).ui.zoom) === 1, { themeId: themeNow, dpr: zoomFact });

    // 采样协议：静置 ≥3s 后单窗 __themeProbe(3000)。AC6 §十「采样窗口数（默认 3）」属实现自由项，
    // 因本机 full 已贴近刷新率上限、单轮 3 窗的差异落在噪声量级，本轮扩为 5 组交替窗口（full/off 轮流），
    // 同时把「前 3 组」按默认 3 窗协议单独汇总，两个口径都写进证据。
    async function sampleOnce(label) {
      let last = null;
      for (let t = 0; t < 3; t += 1) {
        const r = await probeOnce(cdp);
        if (probeValid(r)) {
          return {
            ok: true, label, tries: t + 1,
            fps: Number(r.perf.fps), p95FrameMs: Number(r.perf.p95FrameMs), dropRate: Number(r.perf.dropRate),
            frames: Number(r.perf.frames), sampleMs: Number(r.perf.sampleMs), source: String(r.perf.source || ''),
            memMB: r.perf.memMB == null ? null : Number(r.perf.memMB),
            degrade: (r.degrade || {}).level || null,
            degraded: r.degraded || null,
            themeId: r.themeId, winW: r.winW, winH: r.winH, dpr: r.dpr,
            at: new Date().toISOString(),
          };
        }
        last = r && (r.__exception || r.__cdperror || { source: (r.perf || {}).source, p95: (r.perf || {}).p95FrameMs, frames: (r.probe || {}).frames });
        notes.push({ label, try: t + 1, invalid: last });
        await sleep(600);
      }
      return { ok: false, label, invalid: last };
    }

    await choose(cdp, 'full');
    await cdp.send('Page.bringToFront').catch(() => {});
    await sleep(3200); // 静置 ≥3s
    await probeOnce(cdp); // 预热窗（丢弃，避免启动期抖动进统计）
    await sleep(500);
    shots.full = await shot(cdp, path.join(EVID, '01-ac6-full.png'));

    const rounds = [];
    for (let i = 0; i < 5; i += 1) {
      const f = await sampleOnce('full');
      await choose(cdp, 'off');
      await sleep(3200);
      const o = await sampleOnce('off');
      if (i === 0) shots.off = await shot(cdp, path.join(EVID, '02-ac6-off.png'));
      await choose(cdp, 'full');
      await sleep(1600);
      rounds.push({ round: i + 1, full: f, off: o });
    }
    const winsOf = (side, list) => list.map((r) => r[side]).filter((w) => w && w.ok);
    const med = (wins, key) => median(wins.map((w) => w[key]));
    const summarize = (wins) => ({
      fps: med(wins, 'fps'), p95FrameMs: med(wins, 'p95FrameMs'), dropRate: med(wins, 'dropRate'),
      frames: med(wins, 'frames'), sampleMs: med(wins, 'sampleMs'), memMB: med(wins, 'memMB'), source: 'themeProbe',
    });
    const fullAll = winsOf('full', rounds); const offAll = winsOf('off', rounds);
    const full3 = winsOf('full', rounds.slice(0, 3)); const off3 = winsOf('off', rounds.slice(0, 3));
    ac6.rounds = rounds;
    ac6.full = fullAll; ac6.off = offAll;
    ac6.mediansAll = { full: summarize(fullAll), off: summarize(offAll) };
    ac6.mediansFirst3 = { full: summarize(full3), off: summarize(off3) };
    const F = ac6.mediansAll.full; const O = ac6.mediansAll.off;
    ac6.improvementPct = Number.isFinite(F.fps) && F.fps > 0 ? Math.round(((O.fps - F.fps) / F.fps) * 10000) / 100 : null;
    ac6.first3ImprovementPct = Number.isFinite(ac6.mediansFirst3.full.fps) && ac6.mediansFirst3.full.fps > 0
      ? Math.round(((ac6.mediansFirst3.off.fps - ac6.mediansFirst3.full.fps) / ac6.mediansFirst3.full.fps) * 10000) / 100 : null;
    ac6.windowContext = {
      full: fullAll.map((w) => ({ winW: w.winW, winH: w.winH, dpr: w.dpr, themeId: w.themeId })),
      off: offAll.map((w) => ({ winW: w.winW, winH: w.winH, dpr: w.dpr, themeId: w.themeId })),
    };
    ac6.validWindows = { full: fullAll.length, off: offAll.length, retries: notes.length };
    ac6.degradeDuring = { full: fullAll.map((w) => w.degrade), off: offAll.map((w) => w.degrade) };
    ac6.refreshCapNote = F.fps >= 120
      ? `full 中位 ${F.fps}fps / p95 ${F.p95FrameMs}ms 已贴近本机刷新率上限（rAF 由显示器 vsync 决定），特效开销落在噪声量级`
      : '';

    check('AC6① 10 个采样窗口全部有效（source=themeProbe、p95 有限、frames≥20；5 组交替）',
      fullAll.length === 5 && offAll.length === 5, { valid: ac6.validWindows, invalid: notes });
    check('AC6② 六字段齐（fps/p95FrameMs/dropRate/frames/sampleMs/source 每窗均给）',
      fullAll.concat(offAll).every((w) => Number.isFinite(w.fps) && Number.isFinite(w.p95FrameMs) && Number.isFinite(w.dropRate) && Number.isFinite(w.frames) && Number.isFinite(w.sampleMs) && w.source === 'themeProbe'),
      ac6.mediansAll);
    check('AC6③ 同窗口同主题同 zoom（全部 tech-dark 且窗口尺寸/DPR 一致）',
      fullAll.length === 5 && offAll.length === 5
      && fullAll.concat(offAll).every((w) => w.themeId === 'tech-dark' && w.winW === fullAll[0].winW && w.winH === fullAll[0].winH && w.dpr === fullAll[0].dpr),
      ac6.windowContext);
    check('AC6④ off.fps ≥ full.fps（5 组中位数）', Number.isFinite(F.fps) && Number.isFinite(O.fps) && O.fps >= F.fps,
      { fullFps: F.fps, offFps: O.fps, improvementPct: ac6.improvementPct, first3: ac6.mediansFirst3, first3ImprovementPct: ac6.first3ImprovementPct, note: ac6.refreshCapNote });
    check('AC6⑤ off.dropRate ≤ full.dropRate（5 组中位数）', Number.isFinite(F.dropRate) && Number.isFinite(O.dropRate) && O.dropRate <= F.dropRate,
      { fullDropRate: F.dropRate, offDropRate: O.dropRate });
    check('AC6⑥ 报告给出提升百分比（不得只写更流畅）', Number.isFinite(ac6.improvementPct), { improvementPct: ac6.improvementPct });
    check('AC6⑦ 默认 3 窗协议对照值已给（前 3 组中位数 + 提升百分比）',
      Number.isFinite(ac6.mediansFirst3.full.fps) && Number.isFinite(ac6.mediansFirst3.off.fps) && Number.isFinite(ac6.first3ImprovementPct),
      { first3: ac6.mediansFirst3, first3ImprovementPct: ac6.first3ImprovementPct });
    fs.writeFileSync(path.join(EVID, 'effects-compare-ac6.json'), JSON.stringify({
      requirement: 'R-20261117-184549-8947',
      ac: 'AC6',
      method: '同窗口/tech-dark/zoom100%/静置≥3s，full 与 off 各采窗口（__themeProbe(3000)）；默认 3 窗 + 本轮扩为 5 组交替（§十 允许窗口数自定义）',
      sixFields: { full: ac6.mediansAll.full, off: ac6.mediansAll.off },
      sixFieldsFirst3: { full: ac6.mediansFirst3.full, off: ac6.mediansFirst3.off },
      improvementPct: ac6.improvementPct,
      first3ImprovementPct: ac6.first3ImprovementPct,
      verdict: { offFpsGeFull: O.fps >= F.fps, offDropRateLeFull: O.dropRate <= F.dropRate },
      refreshCapNote: ac6.refreshCapNote,
      rounds: ac6.rounds,
      invalidRetries: notes,
      degradeDuring: ac6.degradeDuring,
      sampledAt: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8');

    // ── AC7 ─────────────────────────────────────────────────────
    // 前置：AC6 收尾停在 full，这里先按 AC7① 要求「先成功设 off」再进只读用例
    await choose(cdp, 'off');
    await sleep(900);
    const stOff0 = await readEffect(cdp);
    ac7.step1 = { disk: (JSON.parse(fs.readFileSync(STORE, 'utf8')).ui || {}).effectLevel, state: stOff0 };
    check('AC7① 先成功设 off（磁盘 ui.effectLevel=off、菜单选中 off、根属性 off）',
      ac7.step1.disk === 'off' && stOff0.attr === 'off' && stOff0.current === '关闭'
      && (stOff0.options || []).filter((o) => o.checked === 'true').map((o) => o.v).join(',') === 'off',
      ac7.step1);

    const shaOff = shaOf(STORE);
    const mtimeOff = statOf(STORE);
    // 只读（Windows：0o444 → 只读属性）
    fs.chmodSync(STORE, 0o444);
    const roMode = (fs.statSync(STORE).mode & 0o222) === 0;
    check('AC7②-前置 workbench.json 已置只读', roMode, { mode: (fs.statSync(STORE).mode & 0o777).toString(8) });

    const directFail = await cdp.evaluate(`window.workbench.setThemeEffectLevel('full')`);
    ac7.direct = directFail;
    check('AC7②-a 只读下直连 IPC 设 full → ok:false 且 code=EFFECT_LEVEL_WRITE_FAILED',
      Boolean(directFail && directFail.ok === false && directFail.code === 'EFFECT_LEVEL_WRITE_FAILED'), directFail);

    const clickFail = await choose(cdp, 'full');
    await sleep(1200);
    const stFail = await readEffect(cdp);
    const diskAfterFail = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    const menuErrVisible = Boolean(stFail.error && !stFail.error.hidden && stFail.error.w > 0 && stFail.error.h > 0);
    const bannerVisible = Boolean(stFail.banner && !stFail.banner.hidden && stFail.banner.w > 0 && stFail.banner.h > 0);
    ac7.step2 = {
      click: clickFail, state: stFail, disk: (diskAfterFail.ui || {}).effectLevel, shaUnchanged: shaOf(STORE) === shaOff,
      menuErrorVisible: menuErrVisible, bannerVisible, errorVisible: menuErrVisible || bannerVisible,
    };
    shots.error = await shot(cdp, path.join(EVID, '03-ac7-fail-after-click.png'));
    const errText = [String((stFail.error && stFail.error.text) || ''), String((stFail.banner && stFail.banner.text) || '')].filter(Boolean).join(' | ');
    check('AC7②-b 失败后错误文案含 EFFECT_LEVEL_WRITE_FAILED（行内或顶部横幅）', errText.includes('EFFECT_LEVEL_WRITE_FAILED'), { text: errText.slice(0, 240) });
    check('AC7②-c 失败瞬间错误对用户可见（顶部 #effect-error-banner 可见即可；54e3 修复后新增路径）',
      Boolean(menuErrVisible || bannerVisible),
      { menuHidden: stFail.menuHidden, menuErrorVisible: menuErrVisible, bannerVisible, banner: stFail.banner, menuError: stFail.error });
    check('AC7②-d 界面回退到磁盘值 off（属性 off / 文案关闭 / 选中 off，不停在 full 半套）',
      stFail.attr === 'off' && stFail.current === '关闭'
      && (stFail.options || []).filter((o) => o.checked === 'true').map((o) => o.v).join(',') === 'off',
      { attr: stFail.attr, current: stFail.current, options: stFail.options });
    check('AC7②-e 磁盘仍为 off 且 sha256 未变（失败零写入）', (diskAfterFail.ui || {}).effectLevel === 'off' && ac7.step2.shaUnchanged,
      { disk: ac7.step2.disk, shaSame: ac7.step2.shaUnchanged });

    // 重新打开菜单看错误是否仍在（把「可能被菜单收起遮挡」这一事实量化）
    await openEffectMenu(cdp);
    const stReopen = await readEffect(cdp);
    ac7.reopen = { menuHidden: stReopen.menuHidden, error: stReopen.error };
    shots.errorReopen = await shot(cdp, path.join(EVID, '04-ac7-error-after-reopen.png'));

    // ③ 恢复可写（连 .bak/.tmp/.lock 一起，json-atomic 失败会留只读 .bak）
    for (const f of [STORE, STORE + '.bak', STORE + '.tmp', STORE + '.lock']) {
      try { if (fs.existsSync(f)) fs.chmodSync(f, 0o666); } catch { /* ignore */ }
    }
    try { if (fs.existsSync(STORE + '.lock')) fs.rmSync(STORE + '.lock', { force: true }); } catch { /* ignore */ }
    const writable = (fs.statSync(STORE).mode & 0o200) !== 0;
    await choose(cdp, 'full');
    await sleep(1200);
    const stRecover = await readEffect(cdp);
    const diskRecover = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    ac7.step3 = { writable, state: stRecover, disk: (diskRecover.ui || {}).effectLevel };
    check('AC7③ 恢复可写后再设 full → 成功：磁盘 full、属性移除、文案完整、错误（行内+横幅）消失',
      writable && (diskRecover.ui || {}).effectLevel === 'full' && stRecover.attr === '' && stRecover.current === '完整'
      && Boolean(stRecover.error && (stRecover.error.hidden || !String(stRecover.error.text || '').trim()))
      && Boolean(stRecover.banner && (stRecover.banner.hidden || !String(stRecover.banner.text || '').trim())),
      { disk: ac7.step3.disk, attr: stRecover.attr, current: stRecover.current, error: stRecover.error, banner: stRecover.banner });
    fs.writeFileSync(path.join(EVID, 'ac7-readonly.json'), JSON.stringify({
      requirement: 'R-20261117-184549-8947', ac: 'AC7', steps: ac7,
      shots: { afterFail: shots.error, afterReopen: shots.errorReopen },
      statOff: { sha256: shaOff, mtimeMs: mtimeOff && mtimeOff.mtimeMs, bytes: mtimeOff && mtimeOff.bytes },
      at: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8');

    // ── AC9 ─────────────────────────────────────────────────────
    // 打开独立看板窗：走 preload 暴露的 teamBoardOld（与「独立浮窗」按钮同一条 IPC），
    // 但**不先开**主窗看板浮层——浮层 iframe 会同时渲染同一份 12MB 看板页，两个渲染器并发解析
    // 会让 CDP 探针长时间不响应（v2/v3 实测），与本 AC 判定无关。
    const boardOpen = await cdp.evaluate(`window.workbench.teamBoardOld(${JSON.stringify(seed.projectId)})`, 180000);
    boardTarget = await waitTarget(PORT, 120000, (x) => x && x.type === 'page' && /看板\.html/.test(decodeURIComponent(String(x.url || ''))));
    check('AC9-前置 独立看板窗已打开（team:board-old 同一条 IPC，CDP 目标可见）',
      Boolean(boardTarget) && Boolean(boardOpen && boardOpen.ok === true),
      { open: boardOpen && { ok: boardOpen.ok, reused: boardOpen.reused }, url: boardTarget && String(boardTarget.url || '').slice(0, 160) });
    if (boardTarget) {
      // 12MB 看板页在极端情况下会短暂不响应 CDP：连接后用 1+1 短探针确认，失败重连（最多 4 次）
      const connectBoard = async () => {
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          try {
            const cand = await connect(boardTarget);
            const ping = await cand.cdp.evaluate('1+1', 8000);
            if (ping === 2) return cand;
            try { cand.ws.close(); } catch { /* ignore */ }
          } catch { /* retry */ }
          await sleep(1500);
        }
        return null;
      };
      boardInst = await connectBoard();
      check('AC9-前置 看板窗 CDP 可交互（1+1 连接探针通过，含重连）', Boolean(boardInst), { connected: Boolean(boardInst) });
      if (boardInst) {
        for (let i = 0; i < 20; i += 1) {
          const ready = await boardInst.cdp.evaluate('document.readyState === "complete"', 8000);
          if (ready === true) break;
          await sleep(500);
        }
        try { await boardInst.cdp.send('Page.bringToFront', {}, 8000); } catch { /* ignore */ }
        await sleep(1500);
        // 预热一轮：12MB 看板页的首帧/布局抖动不计入 AC9 时延
        await choose(cdp, 'off');
        await sleep(1800);
        await choose(cdp, 'full');
        await sleep(1800);

        // 在看板页安装 MutationObserver：用页内 performance.now() 记录属性变化时刻。
        // 时延 = (mark.at - anchor) - (anchor 取回 → 点击开始 的调度间隙)，与轮询粒度无关。
        const OBSERVER_JS = `(function(){
          if (!window.__awbObserverInstalled) {
            window.__awbMarks = [];
            var mo = new MutationObserver(function(muts){
              for (var i=0;i<muts.length;i+=1){
                if (muts[i].attributeName === 'data-effect-level') {
                  window.__awbMarks.push({ at: performance.now(), v: document.documentElement.getAttribute('data-effect-level')||'' });
                }
              }
            });
            mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-effect-level'] });
            window.__awbObserverInstalled = true;
          }
          window.__awbMarks = [];
          window.__awbAnchor = performance.now();
          return { anchor: window.__awbAnchor, installed: Boolean(window.__awbObserverInstalled), attr: document.documentElement.getAttribute('data-effect-level')||'' };
        })()`;

        const trials = [];
        let guestAfter = ''; let guestAt = null;
        for (let t = 0; t < 3; t += 1) {
          const setup = await boardInst.cdp.evaluate(OBSERVER_JS, 10000);
          const anchorDone = Date.now();
          await openEffectMenu(cdp);
          const clickStart = Date.now();
          const clicked = await realClick(cdp, '#more-menu [data-effect-menu] [data-effect-option="off"]');
          const clickDone = Date.now();
          let mark = null;
          for (let i = 0; i < 60; i += 1) {
            const got = await boardInst.cdp.evaluate('JSON.stringify(window.__awbMarks||[])', 10000);
            if (typeof got === 'string') {
              try {
                const marks = JSON.parse(got);
                const off = marks.find((x) => x && x.v === 'off');
                if (off) { mark = off; break; }
              } catch { /* ignore */ }
            }
            await sleep(60);
          }
          const afterRead = await boardInst.cdp.evaluate("document.documentElement.getAttribute('data-effect-level')||''", 10000);
          if (t === 0 && guestInst) {
            const g0 = Date.now();
            for (let i = 0; i < 100; i += 1) {
              const g = await guestInst.cdp.evaluate("document.documentElement.getAttribute('data-effect-level')||''", 10000);
              if (g === 'off') { guestAfter = 'off'; guestAt = Date.now() - g0; break; }
              await sleep(20);
            }
          }
          const anchor = setup && Number.isFinite(Number(setup.anchor)) ? Number(setup.anchor) : null;
          const rawMs = mark && anchor != null ? Math.round((mark.at - anchor) * 100) / 100 : null;
          const settleMs = anchor != null ? clickStart - anchorDone : null;
          const adjustedMs = rawMs != null && settleMs != null ? Math.round((rawMs - settleMs) * 100) / 100 : null;
          trials.push({
            trial: t + 1,
            before: setup && setup.attr,
            after: (mark && mark.v) || (typeof afterRead === 'string' ? afterRead : null),
            markRawMs: rawMs,
            settleGapMs: settleMs,
            elapsedMs: adjustedMs,
            clickDispatchMs: clickDone - clickStart,
            clickMode: clicked.mode,
            observerInstalled: Boolean(setup && setup.installed),
          });
          if (t < 2) { await choose(cdp, 'full'); await sleep(1800); }
        }
        const elapsedList = trials.map((x) => x.elapsedMs).filter((n) => Number.isFinite(n));
        const stMainOff = await readEffect(cdp);
        ac9.board = {
          trials,
          allOff: trials.length === 3 && trials.every((x) => x.after === 'off'),
          minMs: elapsedList.length ? Math.min(...elapsedList) : null,
          medianMs: median(elapsedList),
          maxMs: elapsedList.length ? Math.max(...elapsedList) : null,
          method: '看板页 MutationObserver（页内 performance.now）；时延=mark-anchor 减去 anchor→点击 的调度间隙',
        };
        ac9.guest = { after: guestAfter, elapsedMs: guestAt, present: Boolean(guestInst) };
        ac9.main = { attr: stMainOff.attr, current: stMainOff.current };
        shots.board = await shot(boardInst.cdp, path.join(EVID, '05-ac9-board-off.png'));
        shots.mainOff = await shot(cdp, path.join(EVID, '06-ac9-main-off.png'));
        check('AC9① 主窗切 off 后看板窗 documentElement data-effect-level=off（3 次均成立）', ac9.board.allOff, ac9.board);
        check('AC9② 看板窗生效时延 ≤500ms（3 次取最大值判；MutationObserver 页内计时）',
          Number.isFinite(ac9.board.maxMs) && ac9.board.maxMs <= 500,
          { minMs: ac9.board.minMs, medianMs: ac9.board.medianMs, maxMs: ac9.board.maxMs, trials: ac9.board.trials });
        check('AC9③ DSH webview guest（type=webview）同样收到广播', Boolean(guestInst) && guestAfter === 'off', ac9.guest);
        // 收尾：主窗设回 full（避免影响后续用例/截图）
        await choose(cdp, 'full');
        await sleep(600);
      }
    }
    fs.writeFileSync(path.join(EVID, 'ac9-cross-window.json'), JSON.stringify({
      requirement: 'R-20261117-184549-8947', ac: 'AC9', board: ac9.board || null, guest: ac9.guest || null, main: ac9.main || null,
      shots, at: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.error('FATAL', (e && e.stack) || e);
    check('harness 无异常', false, String((e && e.message) || e));
  } finally {
    if (inst) { try { inst.cdp.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ } }
    await sleep(1000);
    try { if (child) child.kill(); } catch { /* ignore */ }
    await sleep(1200);
  }

  const realAfter = {
    store: statOf(REAL_STORE),
    teamJson: statOf(REAL_TEAM_JSON),
    boardHtml: statOf(REAL_BOARD_HTML),
    projectInfo: statOf(path.join(REAL_PROJECT, '项目信息.md')),
    projectIron: statOf(path.join(REAL_PROJECT, '项目铁律.md')),
  };
  // 真实 workbench.json 会被 Owner 正在运行的工作台实例持续写（ui.window 等），
  // 所以不能整文件比 sha；按字段判：顶层（除 ui）全同 + ui.effectLevel 全同 = 未污染。
  const readJsonSafe = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const storeAfterJson = readJsonSafe(REAL_STORE);
  const uiChanged = [];
  if (realStoreJsonBefore && storeAfterJson) {
    const b = realStoreJsonBefore.ui || {}; const a = storeAfterJson.ui || {};
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) uiChanged.push(k);
    }
  }
  const topSame = Boolean(realStoreJsonBefore && storeAfterJson
    && JSON.stringify({ ...realStoreJsonBefore, ui: null }) === JSON.stringify({ ...storeAfterJson, ui: null }));
  const effectLevelSame = String(((realStoreJsonBefore || {}).ui || {}).effectLevel || '') === String(((storeAfterJson || {}).ui || {}).effectLevel || '');
  const sandboxStore = readJsonSafe(STORE);
  check('隔离：真实 团队.json / 团队看板.html / 项目文档 前后不变，真实 store 的结构与 ui.effectLevel 未被本用例改写',
    JSON.stringify(realBefore.teamJson) === JSON.stringify(realAfter.teamJson)
    && JSON.stringify(realBefore.boardHtml) === JSON.stringify(realAfter.boardHtml)
    && JSON.stringify(realBefore.projectInfo) === JSON.stringify(realAfter.projectInfo)
    && JSON.stringify(realBefore.projectIron) === JSON.stringify(realAfter.projectIron)
    && topSame && effectLevelSame,
    {
      teamJsonSame: JSON.stringify(realBefore.teamJson) === JSON.stringify(realAfter.teamJson),
      boardHtmlSame: JSON.stringify(realBefore.boardHtml) === JSON.stringify(realAfter.boardHtml),
      projectDocsSame: JSON.stringify(realBefore.projectInfo) === JSON.stringify(realAfter.projectInfo) && JSON.stringify(realBefore.projectIron) === JSON.stringify(realAfter.projectIron),
      storeShaBefore: realBefore.store && realBefore.store.sha256.slice(0, 12),
      storeShaAfter: realAfter.store && realAfter.store.sha256.slice(0, 12),
      topSame, effectLevelSame, uiChanged,
      note: 'Owner 正在运行的工作台会持续写真实 store 的 ui.window 等自身字段（本轮 uiChanged 即此），非本用例写入；本用例实例数据根为沙盘 AWB_DATA_DIR',
    });
  check('隔离：本用例的写盘只落沙盘 store（沙盘 ui.effectLevel 有值，真实 store 同字段未变）',
    Boolean(sandboxStore && sandboxStore.ui) && effectLevelSame,
    { sandboxUi: sandboxStore && sandboxStore.ui, realEffectLevelSame: effectLevelSame });

  const summary = {
    requirement: 'R-20261117-184549-8947',
    at: new Date().toISOString(),
    port: PORT,
    evidenceDir: EVID,
    total: results.length,
    pass: results.filter((r) => r.ok).length,
    red: results.filter((r) => !r.ok).length,
    results,
    ac6, ac7, ac9, shots, sandbox: { base: SB, data: DATA, team: TEAM },
  };
  fs.writeFileSync(path.join(EVID, 'run-8947-ac679.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(EVID, 'run-8947-ac679.log'), log.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(ROOT, '_tmp', '8947-ac679-last.json'), JSON.stringify({ total: summary.total, pass: summary.pass, red: summary.red, evidenceDir: EVID }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\nAC679 ${JSON.stringify({ total: results.length, pass: results.length - failed.length, red: failed.length })}`);
  console.log(failed.length ? 'AC679_CHECK_RED ' + JSON.stringify(failed.map((f) => f.name)) : 'AC679_CHECK_OK');
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exitCode = failed.length ? 1 : 0;
})();
