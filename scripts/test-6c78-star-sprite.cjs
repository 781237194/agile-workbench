'use strict';
// T-20261122-190253-6c78 验证：星光 sprite before/after 真窗口截图 + fps/longtask 对比。
// 用法：node scripts/test-6c78-star-sprite.cjs --tag before|after [--out <dir>]
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const PNAME = '工作台改造修复';
const argOf = (n, d) => { const i = process.argv.indexOf(n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const TAG = argOf('--tag', 'after');
const BASE = path.join(ROOT, '_tmp', `star-${TAG}-${process.pid}`);
const DATA = path.join(BASE, 'data');
const TEAM = path.join(BASE, '团队');
const PORT = 9820 + (process.pid % 25);
const OUT = path.resolve(argOf('--out', path.join(ROOT, '项目', PNAME, '程序员B', '产出', '证据-6c78-20261122', TAG)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJson = (url) => new Promise((resolve) => { const req = http.get(url, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.setTimeout(8000, () => { req.destroy(); resolve(null); }); });
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.p = new Map(); ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(String(e.data)); } catch { return; } if (m.id && this.p.has(m.id)) { const q = this.p.get(m.id); this.p.delete(m.id); m.error ? q.reject(new Error(JSON.stringify(m.error))) : q.resolve(m.result); } }); }
  send(method, params = {}) { return new Promise((res, rej) => { const id = ++this.seq; this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('CDP timeout ' + method)); } }, 30000); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return { __exception: String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '') }; return r.result ? r.result.value : undefined; }
}
async function connect(wsUrl) { const ws = new WebSocket(wsUrl); await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws fail')), { once: true }); }); return new Cdp(ws); }
function seed() {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  const team = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8').replace(/^\uFEFF/, ''));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = PNAME;
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  const store = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'userdata', 'workbench.json'), 'utf8').replace(/^\uFEFF/, ''));
  const project = (store.projects || []).find((p) => String(p.teamName || p.name || '') === PNAME) || (store.projects || [])[0];
  project.path = path.join(ROOT, '项目', PNAME);
  project.teamName = PNAME;
  project.sessions = {};
  project.workspace = { sessionIds: [] };
  store.projects = [project];
  store.activeProjectId = project.id;
  fs.writeFileSync(path.join(DATA, 'userdata', 'workbench.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
}
function saveShot(b64) { fs.mkdirSync(OUT, { recursive: true }); const p = path.join(OUT, `${TAG}-overlay.png`); fs.writeFileSync(p, Buffer.from(String(b64).replace(/^data:image\/png;base64,/, ''), 'base64')); return p; }
(async () => {
  seed();
  const env = { ...process.env, AWB_DATA_DIR: DATA, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(BASE, '项目区'), TEAM_WORKBENCH_JSON: path.join(DATA, 'userdata', 'workbench.json'), AWB_STORE: path.join(DATA, 'userdata', 'workbench.json'), AWB_TEAM_ROOT: TEAM, AWB_TEAM_PROJECTS_ROOT: path.join(BASE, '项目区'), TEAM_SELFTEST: '1', AWB_SHOW_INACTIVE: '1', DSH_WEB_URL: 'http://127.0.0.1:1' };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });
  let list = null;
  try {
    for (let i = 0; i < 120 && !list; i += 1) { await sleep(1000); list = await httpJson(`http://127.0.0.1:${PORT}/json/list`); if (list && !list.some((t) => t.type === 'page' && /index\.html/i.test(String(t.url || '')))) list = null; }
    if (!list) throw new Error('实例未就绪');
    const shellTarget = list.find((t) => t.type === 'page' && /index\.html/i.test(String(t.url || '')));
    const shell = await connect(shellTarget.webSocketDebuggerUrl);
    try { await shell.send('Runtime.enable'); } catch { /* ignore */ }
    for (let i = 0; i < 120; i += 1) { if ((await shell.eval('document.readyState === "complete" && Boolean(window.AWB_FX)')) === true) break; await sleep(500); }
    // 让壳内粒子以 full 档跑起来（AWB_FX.sync 后等两帧）
    await shell.eval('window.AWB_FX && window.AWB_FX.sync && window.AWB_FX.sync(); true');
    await sleep(1800);
    const canvas = await shell.eval('(() => { const c = document.querySelector("#awb-theme-particles"); if (!c) return null; return { url: c.toDataURL("image/png"), w: c.width, h: c.height, particles: Number(c.getAttribute("data-fx-particles")||0) }; })()');
    if (canvas && canvas.url) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, `${TAG}-shell-canvas.png`), Buffer.from(String(canvas.url).replace(/^data:image\/png;base64,/, ''), 'base64')); }
    // fps + longtask（3 秒，壳页面）
    const perf = await shell.eval('(async () => { let n = 0; const lt = []; let obs = null; try { obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push(Math.round(e.duration)); }); obs.observe({ entryTypes: ["longtask"] }); } catch (e) {} const t0 = performance.now(); await new Promise((res) => { function f() { n += 1; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else res(); } requestAnimationFrame(f); }); const ms = performance.now() - t0; if (obs) obs.disconnect(); return { fps: Math.round(n / (ms / 1000) * 10) / 10, longtasks: lt.length, ltMax: lt.length ? Math.max(...lt) : 0 }; })()');
    // 覆盖窗：直接驱动其状态并截图（独立 BrowserWindow 目标）
    const ovTarget = list.find((t) => t.type === 'page' && /fx-overlay/i.test(String(t.url || '')));
    let overlayInfo = null;
    if (ovTarget) {
      const ov = await connect(ovTarget.webSocketDebuggerUrl);
      try { await ov.send('Runtime.enable'); await ov.send('Page.enable'); } catch { /* ignore */ }
      // 覆盖窗页面可能比 target 晚就绪：等到 canvas 与 fxOverlay/诊断取数口至少一个可用再取图。
      let ovReady = false;
      for (let i = 0; i < 60 && !ovReady; i += 1) {
        ovReady = (await ov.eval('document.readyState === "complete" && Boolean(document.getElementById("fx-overlay-canvas")) && (typeof window.__fxOverlayForce === "function" || typeof window.fxOverlay === "object")')) === true;
        if (!ovReady) await sleep(500);
      }
      // 诊断取数口强制一帧 + 单独取 dataURL（同一次 evaluate 里取大字符串会被 CDP 序列化成空对象）。
      // 用壳内真实的 overlayState（colors/count/opacityRange）驱动覆盖窗，保证「覆盖窗 = 连接前壳内」同参数对照。
      const shellOverlay = await shell.eval('window.AWB_FX && typeof window.AWB_FX.overlayState === "function" ? window.AWB_FX.overlayState() : null');
      const parityState = { enabled: true, count: Number(shellOverlay && shellOverlay.count) || 0, colors: (shellOverlay && shellOverlay.colors) || [], opacityRange: (shellOverlay && shellOverlay.opacityRange) || [0.2, 0.45], mode: 'full' };
      const ovForce = await ov.eval(`(() => { const st = ${JSON.stringify(parityState)}; if (typeof window.__fxOverlayForce === "function") return window.__fxOverlayForce(st); try { window.fxOverlay.onState(st); } catch (e) {} return window.__fxOverlayStats ? window.__fxOverlayStats() : null; })()`);
      await sleep(40);
      const ovUrl = await ov.eval('(() => { const c = document.getElementById("fx-overlay-canvas"); return c ? c.toDataURL("image/png") : null; })()');
      const ovSnap = { stats: ovForce, url: typeof ovUrl === 'string' ? ovUrl : null, w: 1647, h: 1070 };
      const ovStats = ovSnap && ovSnap.stats;
      const ovDebug = (!ovSnap || !ovSnap.url) ? JSON.stringify(ovSnap).slice(0, 600) : null;
      if (ovDebug) console.log('OVSNAP_DEBUG', ovDebug);
      let ovCanvasPath = null;
      if (ovSnap && ovSnap.url) { fs.mkdirSync(OUT, { recursive: true }); ovCanvasPath = path.join(OUT, `${TAG}-overlay-canvas.png`); fs.writeFileSync(ovCanvasPath, Buffer.from(String(ovSnap.url).replace(/^data:image\/png;base64,/, ''), 'base64')); }
      const shot = await ov.send('Page.captureScreenshot', { format: 'png', fromSurface: true }).catch(() => null);
      let shotPath = null;
      if (shot && shot.data) shotPath = saveShot(shot.data);
      overlayInfo = { stats: ovStats, screenshot: shotPath, canvas: ovCanvasPath, canvasSize: ovSnap ? { w: ovSnap.w, h: ovSnap.h } : null };
    }
    const facts = await shell.eval('({ head: (window.workbench && window.workbench.appVersion ? window.workbench.appVersion() : null), shellParticles: (window.AWB_FX && window.AWB_FX.sample ? window.AWB_FX.sample().particles : null) })');
    const result = { at: new Date().toISOString(), tag: TAG, port: PORT, shell: { canvas, perf, facts }, overlay: overlayInfo };
    fs.mkdirSync(OUT, { recursive: true });
    // canvas 对象里带大 url，落盘前剔除
    const slim = JSON.parse(JSON.stringify(result)); if (slim.shell && slim.shell.canvas) delete slim.shell.canvas.url;
    fs.writeFileSync(path.join(OUT, `${TAG}-result.json`), JSON.stringify(slim, null, 2) + '\n');
    console.log(JSON.stringify(slim, null, 1));
    try { await shell.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ }
    await sleep(500);
    try { child.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(0);
  } catch (e) {
    console.error('FAILED', e && e.stack);
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(1);
  }
})();
