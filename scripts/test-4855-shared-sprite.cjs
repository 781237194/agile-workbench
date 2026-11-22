'use strict';
// T-20261122-195601-4855 验证：壳层与覆盖窗共用 fx-sprite.js（11×11 alpha 网格逐像素同形）
// + 连 DSH 前（壳层 canvas）/ 连上后（覆盖窗 canvas）真窗口对照 + fps/longtask。
// 用法：node scripts/test-4855-shared-sprite.cjs [--tag v1] [--out <dir>]
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const PNAME = '工作台改造修复';
const argOf = (n, d) => { const i = process.argv.indexOf(n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const TAG = argOf('--tag', 'v1');
const BASE = path.join(ROOT, '_tmp', `shared-sprite-${TAG}-${process.pid}`);
const DATA = path.join(BASE, 'data');
const TEAM = path.join(BASE, '团队');
const PORT = 9860 + (process.pid % 25);
const OUT = path.resolve(argOf('--out', path.join(ROOT, '项目', PNAME, '程序员B', '产出', '证据-4855-20261122')));
const COLORS = ['#4fd1ff', 'rgba(255,200,120,0.4)', 'rgba(79,244,255,0.2)'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJson = (url) => new Promise((resolve) => { const req = http.get(url, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.setTimeout(8000, () => { req.destroy(); resolve(null); }); });
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.p = new Map(); ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(String(e.data)); } catch { return; } if (m.id && this.p.has(m.id)) { const h = this.p.get(m.id); this.p.delete(m.id); if (m.error) h.rej(new Error(JSON.stringify(m.error))); else h.res(m.result); } }); }
  send(method, params = {}, timeout = 20000) { return new Promise((res, rej) => { const id = ++this.seq; this.p.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('CDP timeout ' + method)); } }, timeout); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return { __exception: String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '') }; return r.result ? r.result.value : undefined; }
}
async function connect(wsUrl) { const ws = new WebSocket(wsUrl); await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws error'))); }); return new Cdp(ws); }
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
(async () => {
  seed();
  const env = { ...process.env, AWB_DATA_DIR: DATA, AWB_TEAM_ROOT: TEAM, AWB_TEAM_PROJECTS_ROOT: path.join(BASE, '项目区'), AWB_STORE: path.join(DATA, 'userdata', 'workbench.json'), TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(BASE, '项目区'), TEAM_WORKBENCH_JSON: path.join(DATA, 'userdata', 'workbench.json'), TEAM_SELFTEST: '1', DSH_WEB_URL: 'http://127.0.0.1:1', AWB_SHOW_INACTIVE: '1' };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });
  try {
    let list = null;
    for (let i = 0; i < 120 && !list; i += 1) { await sleep(1000); list = await httpJson(`http://127.0.0.1:${PORT}/json/list`); if (list && !list.some((t) => t.type === 'page' && /index\.html/i.test(String(t.url || '')))) list = null; }
    if (!list) throw new Error('实例未就绪');
    const target = (re) => list.find((t) => t.type === 'page' && re.test(String(t.url || '')));
    const shell = await connect(target(/index\.html/i).webSocketDebuggerUrl);
    try { await shell.send('Runtime.enable'); } catch { /* ignore */ }
    for (let i = 0; i < 120; i += 1) { if ((await shell.eval('document.readyState === "complete" && Boolean(window.AWB_FX) && Boolean(window.AWBFxSprite)')) === true) break; await sleep(500); }
    // ① 两边 sprite alpha 网格：同一份 fx-sprite.js，同一组颜色逐像素比较
    const gridExpr = `(() => {
      const C = ${JSON.stringify(COLORS)};
      return { version: (window.AWBFxSprite||{}).VERSION || '', size: (window.AWBFxSprite||{}).SIZE || 0, grids: C.map((c) => window.AWBFxSprite.alphaGrid(c)) };
    })()`;
    const shellGrids = await shell.eval(gridExpr);
    // ② 连 DSH 前：壳层真实 canvas 截图
    await shell.eval('window.AWB_FX && window.AWB_FX.sync && window.AWB_FX.sync(); true');
    await sleep(1800);
    const shellShot = await shell.eval('(() => { const c = document.querySelector("#awb-theme-particles"); return c ? { url: c.toDataURL("image/png"), w: c.width, h: c.height } : null; })()');
    fs.mkdirSync(OUT, { recursive: true });
    if (shellShot && shellShot.url) fs.writeFileSync(path.join(OUT, `${TAG}-preconnect-shell.png`), Buffer.from(String(shellShot.url).replace(/^data:image\/png;base64,/, ''), 'base64'));
    const perf = await shell.eval('(async () => { let n = 0; const lt = []; let obs = null; try { obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push(Math.round(e.duration)); }); obs.observe({ type: "longtask", buffered: false }); } catch (e) { /* ignore */ } const t0 = performance.now(); await new Promise((res) => { function f() { n += 1; if (performance.now() - t0 >= 3000) res(); else requestAnimationFrame(f); } requestAnimationFrame(f); }); if (obs) obs.disconnect(); return { fps: Math.round((n / ((performance.now() - t0) / 1000)) * 10) / 10, longtasks: lt.length, ltMax: lt.length ? Math.max.apply(null, lt) : 0 }; })()');
    const shellFacts = await shell.eval('({ head: (window.workbench && window.workbench.appVersion ? window.workbench.appVersion() : null), particles: (window.AWB_FX && window.AWB_FX.sample ? window.AWB_FX.sample().particles : null) })');
    // ③ 连 DSH 后：覆盖窗 canvas（用壳内真实 overlayState 驱动同一帧）
    const ovTarget = target(/fx-overlay/i);
    let overlay = null;
    let noReseed = null;
    if (ovTarget) {
      const ov = await connect(ovTarget.webSocketDebuggerUrl);
      try { await ov.send('Runtime.enable'); await ov.send('Page.enable'); } catch { /* ignore */ }
      let ready = false;
      for (let i = 0; i < 60 && !ready; i += 1) {
        ready = (await ov.eval('document.readyState === "complete" && Boolean(document.getElementById("fx-overlay-canvas")) && Boolean(window.AWBFxSprite)')) === true;
        if (!ready) await sleep(500);
      }
      const ovGrids = await ov.eval(gridExpr);
      const shellOverlay = await shell.eval('window.AWB_FX && typeof window.AWB_FX.overlayState === "function" ? window.AWB_FX.overlayState() : null');
      const st = { enabled: true, count: Number(shellOverlay && shellOverlay.count) || 0, colors: (shellOverlay && shellOverlay.colors) || [], opacityRange: (shellOverlay && shellOverlay.opacityRange) || [0.2, 0.45], mode: 'full' };
      const stats = await ov.eval(`(() => { const s = ${JSON.stringify(st)}; if (typeof window.__fxOverlayForce === "function") return window.__fxOverlayForce(s); try { window.fxOverlay.onState(s); } catch (e) {} return window.__fxOverlayStats ? window.__fxOverlayStats() : null; })()`);
      await sleep(60);
      const url = await ov.eval('(() => { const c = document.getElementById("fx-overlay-canvas"); return c ? c.toDataURL("image/png") : null; })()');
      let ovPng = null;
      if (typeof url === 'string') { ovPng = path.join(OUT, `${TAG}-connected-overlay.png`); fs.writeFileSync(ovPng, Buffer.from(String(url).replace(/^data:image\/png;base64,/, ''), 'base64')); }
      overlay = { stats, png: ovPng, grids: ovGrids };
      // 同状态反复推送（模拟 renderDsh 每秒轮询 / 主进程重复推送）不得重新 seed，否则粒子全体瞬移。
      const sameState = JSON.stringify(st);
      const seed0 = Number(stats && stats.seedCount) || 0;
      for (let i = 0; i < 4; i += 1) { await ov.eval(`(() => { const s = ${sameState}; if (typeof window.__fxOverlayForce === "function") return window.__fxOverlayForce(s); return null; })()`); await sleep(250); }
      for (let i = 0; i < 3; i += 1) { await shell.eval('window.AWB_FX && window.AWB_FX.notifyOverlay ? window.AWB_FX.notifyOverlay() : null'); await sleep(150); }
      await sleep(400);
      const afterSame = await ov.eval('window.__fxOverlayStats ? window.__fxOverlayStats() : null');
      // 参数真正变化时才允许重新 seed（证明不是把 seed 永久关掉）。
      const changed = Object.assign({}, st, { count: Math.max(1, (Number(st.count) || 1) + 7) });
      await ov.eval(`(() => { const s = ${JSON.stringify(changed)}; if (typeof window.__fxOverlayForce === "function") return window.__fxOverlayForce(s); return null; })()`);
      const afterChange = await ov.eval('window.__fxOverlayStats ? window.__fxOverlayStats() : null');
      noReseed = {
        seed0,
        seedAfterSame: Number(afterSame && afterSame.seedCount) || 0,
        seedAfterChange: Number(afterChange && afterChange.seedCount) || 0,
        noReseedSame: Boolean(afterSame && (Number(afterSame.seedCount) || 0) === seed0),
        reseededOnChange: Boolean(afterChange && (Number(afterChange.seedCount) || 0) === seed0 + 1),
      };
    }
    // ④ 断言
    const gridsEqual = shellGrids && overlay && typeof shellGrids.grids !== 'undefined'
      && JSON.stringify(shellGrids.grids) === JSON.stringify(overlay && overlay.grids && overlay.grids.grids);
    const g0 = shellGrids && shellGrids.grids && shellGrids.grids[0];
    const at = (g, x, y) => (g ? g[y * 11 + x] : -1);
    const shape = g0 ? {
      size: shellGrids.size,
      center: at(g0, 5, 5),
      armTop: at(g0, 5, 0), armBottom: at(g0, 5, 10), armLeft: at(g0, 0, 5), armRight: at(g0, 10, 5),
      corner00: at(g0, 0, 0), corner1010: at(g0, 10, 10),
      nonZero: g0.filter((v) => v > 0).length,
    } : null;
    const checks = [
      { name: '两边页面都加载 fx-sprite.js 同一版本', ok: Boolean(shellGrids && overlay && shellGrids.version && shellGrids.version === overlay.grids.version), detail: shellGrids && shellGrids.version },
      { name: 'alpha 网格尺寸=11×11', ok: Boolean(shape && shape.size === 11 && g0 && g0.length === 121), detail: shape && shape.size },
      { name: '两边 alpha 网格逐像素相同', ok: gridsEqual, detail: gridsEqual ? 'equal' : 'diff' },
      { name: '亮核（中心 > 200）', ok: Boolean(shape && shape.center > 200), detail: shape && shape.center },
      { name: '十字光芒（上下左右尖端 > 20）', ok: Boolean(shape && shape.armTop > 20 && shape.armBottom > 20 && shape.armLeft > 20 && shape.armRight > 20), detail: shape && [shape.armTop, shape.armBottom, shape.armLeft, shape.armRight] },
      { name: '四角透明（非圆点）', ok: Boolean(shape && shape.corner00 === 0 && shape.corner1010 === 0), detail: shape && [shape.corner00, shape.corner1010] },
      { name: '粒子直径在 5–8px', ok: Boolean(shellFacts && shellFacts.particles && shellFacts.particles.minDiameterPx >= 5 && shellFacts.particles.maxDiameterPx <= 8), detail: shellFacts && shellFacts.particles && { min: shellFacts.particles.minDiameterPx, max: shellFacts.particles.maxDiameterPx } },
      { name: '覆盖窗粒子数/直径与壳层同口径', ok: Boolean(overlay && overlay.stats && overlay.stats.count > 0 && overlay.stats.minDiameterPx >= 5 && overlay.stats.maxDiameterPx <= 8), detail: overlay && overlay.stats },
      { name: 'fps ≥ 55 且 longtask max ≤ 120ms（不回归）', ok: Boolean(perf && perf.fps >= 55 && perf.ltMax <= 120), detail: perf },
      { name: '同参数反复推送不重新撒点（不瞬移）', ok: Boolean(noReseed && noReseed.noReseedSame), detail: noReseed },
      { name: '参数变化时才允许重新撒点', ok: Boolean(noReseed && noReseed.reseededOnChange), detail: noReseed && { seed0: noReseed.seed0, afterChange: noReseed.seedAfterChange } },
      { name: '连 DSH 前/后截图均已生成', ok: Boolean(shellShot && overlay && overlay.png), detail: { shell: Boolean(shellShot), overlay: Boolean(overlay && overlay.png) } },
    ];
    const result = { at: new Date().toISOString(), tag: TAG, task: 'T-20261122-195601-4855', port: PORT, shell: { grids: shellGrids, facts: shellFacts, perf, canvas: shellShot ? { w: shellShot.w, h: shellShot.h } : null }, overlay: overlay ? { stats: overlay.stats, grids: overlay.grids, png: overlay.png } : null, checks, pass: checks.filter((c) => c.ok).length, total: checks.length };
    fs.writeFileSync(path.join(OUT, `${TAG}-result.json`), JSON.stringify(result, null, 2) + '\n');
    for (const c of checks) console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + ' :: ' + JSON.stringify(c.detail));
    console.log(`SHARED_SPRITE ${checks.filter((c) => c.ok).length}/${checks.length} ${checks.every((c) => c.ok) ? 'OK' : 'FAIL'}`);
    await shell.send('Browser.close', {}, 3000).catch(() => {});
    await sleep(500);
    try { child.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(checks.every((c) => c.ok) ? 0 : 1);
  } catch (e) {
    console.error('FAILED', e && e.stack);
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(1);
  }
})();
