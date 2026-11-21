#!/usr/bin/env node
'use strict';
/**
 * test-b30e-acceptance.cjs —— T-20261122-061155-b30e 独立验收（对象＝A 的 bd206b5，不修改其代码）。
 *
 * 验的是 A 的实现不变量：「覆盖窗 ready 且 DSH 在线时，壳内 #awb-theme-particles 不绘制」。
 * A 的 bd206b5 只在 sync() 里算一次 overlayOwns 并 stopLoop；本脚本用渲染层可见路径复现：
 *   R1 注入 overlayReady/online=true → sync() 后壳内 particles=0（A 的停画生效）
 *   R2 失焦（blur→pause）→ 聚焦（focus→resume）：A 的 resume 只判 mode!=='off'，不看 overlayOwns，
 *      会把壳内循环重新拉起 → 覆盖窗仍 ready/online 但壳内 particles>0（缺陷复现）
 *   R3 再调 sync() 又停画（证明是「任一 resume/focus 都会重新拉起」的间歇性缺陷，不是一次性）
 *   R4 A 的实现无自检挂载点：IS_SELFTEST 下覆盖窗不创建（ensureFxOverlayWindow `if (IS_SELFTEST) return null`），
 *      fxOverlayBenchmark 拿不到覆盖窗进程 → PM 要求的「隔离实例跑 benchmark」需非 selftest/生产实例
 * 用法：node scripts/test-b30e-acceptance.cjs [--out <dir>]
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PNAME = '工作台改造修复';
const BASE = path.join(ROOT, '_tmp', `b30e-acc-${process.pid}-${Date.now()}`);
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', PNAME, '程序员B', '产出', '证据-b30e-验收'); })();
const REAL = path.join(ROOT, '团队');
const PORT = 9740 + (process.pid % 20);
const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) { rows.push({ name, ok, detail }); const tag = ok === true ? 'PASS' : (ok === 'DEFECT' ? 'DEFECT' : (ok === null ? 'SKIP' : 'FAIL')); console.log(`${tag}  ${name}${ok === true ? '' : ' :: ' + JSON.stringify(detail).slice(0, 700)}`); }
function httpJson(url) { return new Promise((resolve) => { const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.setTimeout(3000, () => { req.destroy(); resolve(null); }); }); }
async function waitTarget(port, ms, pick) { const end = Date.now() + ms; while (Date.now() < end) { const list = await httpJson(`http://127.0.0.1:${port}/json/list`); if (Array.isArray(list)) { const hit = list.find(pick); if (hit && hit.webSocketDebuggerUrl) return hit; } await sleep(400); } return null; }
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(String(e.data)); } catch { return; } if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } }); }
  send(method, params = {}, ms = 60000) { const id = ++this.seq; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, ms); }); }
  async evaluate(expr, ms = 60000) { try { const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms); if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || '') }; return out && out.result ? out.result.value : undefined; } catch (e) { return { __cdperror: String((e && e.message) || e) }; } }
}
function seed() {
  fs.rmSync(BASE, { recursive: true, force: true });
  const DATA = path.join(BASE, 'data');
  const TEAM = path.join(BASE, '团队');
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  const team = JSON.parse(fs.readFileSync(path.join(REAL, '状态', '团队.json'), 'utf8').replace(/^\uFEFF/, ''));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = PNAME;
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  const store = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'userdata', 'workbench.json'), 'utf8').replace(/^\uFEFF/, ''));
  const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PNAME) || (store.projects || [])[0];
  project.path = path.join(ROOT, '项目', PNAME);
  project.teamName = PNAME;
  project.sessions = {};
  project.workspace = { sessionIds: [] };
  store.projects = [project];
  store.activeProjectId = project.id;
  fs.writeFileSync(path.join(DATA, 'userdata', 'workbench.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
  return { DATA, TEAM };
}
const canvasState = (cdp) => cdp.evaluate('(() => { const c = document.querySelector("#awb-theme-particles"); if (!c) return { missing: true }; const ctx = c.getContext("2d"); let nonEmpty = 0; let sampled = 0; try { const d = ctx.getImageData(0, 0, c.width, c.height).data; const step = 4 * 16; for (let i = 3; i < d.length; i += step) { sampled += 1; if (d[i] > 0) nonEmpty += 1; } } catch (e) { return { err: String(e && e.message || e) }; } return { particles: Number(c.getAttribute("data-fx-particles") || 0), sampled, nonEmpty, w: c.width, h: c.height }; })()');
const fxState = (cdp) => cdp.evaluate('(() => { const fx = window.AWB_FX; const s = fx.sample(); return { ready: window.__awbFxOverlayReady === true, online: window.__awbFxOverlayOnline === true, paused: Boolean(s.degrade && s.degrade.paused), mode: s.degrade && s.degrade.level, shellParticles: s.particles && s.particles.count, overlayEnabled: (fx.overlayState ? fx.overlayState().enabled : null), overlayOwnsInCode: typeof fx.overlayOwns === "function" ? fx.overlayOwns() : "A_IMPL_NO_HELPER", running: Boolean(s.degrade && s.degrade.running) }; })()');
function head() { try { return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(); } catch { return ''; } }
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const dirs = seed();
  const env = { ...process.env, AWB_DATA_DIR: dirs.DATA, TEAM_ROOT: dirs.TEAM, TEAM_SELFTEST: '1', AWB_SHOW_INACTIVE: '1', DSH_WEB_URL: 'http://127.0.0.1:1' };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });
  let inst = null;
  try {
    const target = await waitTarget(PORT, 120000, (item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
    if (target) {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('ws fail')), { once: true }); });
      const cdp = new Cdp(ws); inst = { child, cdp, ws };
      await cdp.send('Runtime.enable');
      for (let i = 0; i < 150; i += 1) { if ((await cdp.evaluate('document.readyState === "complete" && Boolean(window.AWB_FX)')) === true) break; await sleep(400); }
    }
  } catch { inst = null; }
  if (!inst) { try { child.kill(); } catch { /* ignore */ } try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ } }
  const report = { at: new Date().toISOString(), head: head(), target: 'A bd206b5 (main.js/fx-layer.js 未修改)', port: PORT };
  check('A0 隔离实例启动且 AWB_FX 就绪', Boolean(inst), { port: PORT });
  if (inst) {
    try {
      // 模拟「覆盖窗 ready + DSH 在线」（A 的 gate 只读这两个标志；本脚本用 defineProperty 固定，避免 renderDsh 周期写回）
      const inject = await inst.cdp.evaluate('(() => { try { Object.defineProperty(window, "__awbFxOverlayReady", { configurable: true, get: function () { return true; }, set: function () {} }); } catch (e) {} try { Object.defineProperty(window, "__awbFxOverlayOnline", { configurable: true, get: function () { return true; }, set: function () {} }); } catch (e) {} window.AWB_FX.sync(); return true; })()');
      await sleep(1000);
      const r1 = await canvasState(inst.cdp);
      const s1 = await fxState(inst.cdp);
      check('R1 覆盖窗 ready+在线时 sync() 后壳内停画（A 的 bd206b5 生效）', Boolean(inject && r1 && r1.particles === 0 && r1.nonEmpty === 0), { r1, s1 });
      // R2：失焦→聚焦（A 的 resume 只判 mode!=off，不看 overlayOwns）
      await inst.cdp.evaluate('window.dispatchEvent(new Event("blur")); true');
      await sleep(400);
      const sBlur = await fxState(inst.cdp);
      const resumeNow = await inst.cdp.evaluate('(() => { window.dispatchEvent(new Event("focus")); const s = window.AWB_FX.sample(); return { ready: window.__awbFxOverlayReady === true, online: window.__awbFxOverlayOnline === true, paused: Boolean(s.degrade && s.degrade.paused), running: Boolean(s.degrade && s.degrade.running), shellParticles: s.particles && s.particles.count }; })()');
      await sleep(500);
      const r2 = await canvasState(inst.cdp);
      const s2 = await fxState(inst.cdp);
      const defect = Boolean(resumeNow && resumeNow.ready === true && resumeNow.online === true && resumeNow.paused === false && resumeNow.running === true);
      check('R2【缺陷】focus/resume 后壳内循环被重新拉起（覆盖窗仍 ready+在线）', defect ? 'DEFECT' : false, { blurState: sBlur, resumeImmediate: resumeNow, after500ms: s2, canvas: r2, note: 'A 的 resume() 只判 mode!=off，未判 overlayOwns；任一 focus/visibility 恢复都会重新 startLoop，直到下一次 sync 才停（间歇性双份绘制）' });
      await inst.cdp.evaluate('window.AWB_FX.sync(); true');
      await sleep(900);
      const r3 = await canvasState(inst.cdp);
      check('R3 再调 sync() 又停画（证明是 focus/resume 绕过，不是一次性）', Boolean(r3 && r3.particles === 0 && r3.nonEmpty === 0), r3);
      // R4 覆盖窗开销 benchmark（PM 要求；A 的实现提供 fx:overlay-benchmark）
      const bench = await inst.cdp.evaluate('window.workbench.fxOverlayBenchmark()');
      check('R4 fxOverlayBenchmark 可量覆盖窗开销（overlay RSS/主进程 CPU/GPU 差值）', Boolean(bench && bench.ok === true && bench.withOverlay && bench.delta && Number(bench.delta.overlayRssMB) >= 0), bench && { delta: bench.delta, withOverlay: { main: bench.withOverlay.main, gpu: bench.withOverlay.gpu, overlay: bench.withOverlay.overlay } });
      // R5 覆盖窗不可用（ready=false）→ 壳内恢复绘制（A 的降级兜底）
      const fallback = await inst.cdp.evaluate('(() => { try { Object.defineProperty(window, "__awbFxOverlayReady", { configurable: true, get: function () { return false; }, set: function () {} }); } catch (e) {} try { window.dispatchEvent(new Event("focus")); } catch (e) {} window.AWB_FX.sync(); const s = window.AWB_FX.sample(); return { running: Boolean(s.degrade && s.degrade.running), paused: Boolean(s.degrade && s.degrade.paused), shellParticles: s.particles && s.particles.count }; })()');
      await sleep(700);
      const r5 = await canvasState(inst.cdp);
      const s5 = await fxState(inst.cdp);
      check('R5 覆盖窗 ready=false 时壳内恢复绘制（降级兜底）', Boolean(fallback && fallback.running === true && fallback.shellParticles > 0), { immediate: fallback, after700ms: s5, canvas: r5 });
      // R6 点击/输入穿透：静态接线（A 的实现未暴露 ignoreMouseEvents 状态，OS 级穿透需真实鼠标/生产验证）
      const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
      const passThrough = /setIgnoreMouseEvents\(true, \{ forward: true \}\)/.test(mainSrc) && /focusable: false/.test(mainSrc);
      check('R6 覆盖窗 ignoreMouseEvents(forward)+focusable:false 静态接线存在（OS 级穿透待真实鼠标/生产验证）', passThrough, { passThrough });
      // R7 bounds/最大化/全屏/最小化/125%：A 的实现未暴露 bounds 取数口，隔离断面无法断言（列为未覆盖，需真实窗口/生产验证）
      check('R7 bounds/最大化/全屏/最小化/125% 断言（未覆盖：A 无 bounds 取数口，需真实窗口/生产验证）', null, { note: 'A 的 fx-overlay-status 只给 metrics/state，无 bounds；本单不改其文件，故未覆盖' });
      report.case = { inject, r1, s1, blur: sBlur, resumeImmediate: resumeNow, resumeAfter: s2, r2, syncAgain: r3, benchmark: bench, fallback, r5, s5, passThrough };
    } finally { try { inst.cdp.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ } await sleep(800); try { inst.ws.close(); } catch { /* ignore */ } try { child.kill(); } catch { /* ignore */ } await sleep(400); try { if (child && child.pid && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ } }
  }
  report.checks = rows;
  const defects = rows.filter((r) => r.ok === 'DEFECT').length;
  const skipped = rows.filter((r) => r.ok === null).length;
  const failed = rows.filter((r) => r.ok !== true && r.ok !== 'DEFECT' && r.ok !== null).length;
  report.summary = { pass: rows.filter((r) => r.ok === true).length, defects, skipped, failed, total: rows.length };
  fs.writeFileSync(path.join(OUT, 'b30e-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`ACCEPTANCE pass=${report.summary.pass} defect=${defects} skipped=${skipped} failed=${failed} total=${rows.length}`);
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(defects > 0 || failed > 0 ? 2 : 0);
})().catch((e) => { console.error('FAILED', e && e.stack); process.exit(1); });
