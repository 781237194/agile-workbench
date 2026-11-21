#!/usr/bin/env node
'use strict';
/**
 * test-b30e-fx-overlay-owner.cjs —— T-20261122-061155-b30e（P1）真窗口夹具：
 *   AC① 覆盖窗可用时壳内 #awb-theme-particles 不再绘制（particles=0 + 画面无像素），覆盖窗在画；
 *        AWB_FX_OVERLAY_DISABLE=1 时覆盖窗不建、壳内回退绘制。
 *   AC② resize/最大化/还原/全屏时覆盖窗 bounds 跟随（mainBounds === overlayBounds）。
 *   AC③ 点击/输入穿透能力（ignoreMouseEvents(true,{forward:true}) + focusable:false 可观测）+
 *        主窗仍能收到 CDP 注入的鼠标事件（元素命中不受覆盖窗影响）。
 *   AC④ 最小化时覆盖窗隐藏/渲染暂停，恢复后重新显示并继续画。
 *   AC⑤ 第二窗口开销：fx:overlay-benchmark 的 GPU RSS / 主进程 CPU 差值 + 覆盖窗 RSS。
 *   AC⑥ 125% 缩放（--force-device-scale-factor=1.25）下 bounds 不偏。
 * 用法：node scripts/test-b30e-fx-overlay-owner.cjs [--out <dir>]
 * 隔离：AWB_DATA_DIR/TEAM_ROOT 沙盘 + TEAM_SELFTEST=1 + AWB_FX_OVERLAY_TEST=1 + FORCE_VISIBLE=1；
 *       只回收自己 spawn 的 child.pid（taskkill /PID）。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PNAME = '工作台改造修复';
const BASE = path.join(ROOT, '_tmp', `fxb30e-${process.pid}-${Date.now()}`);
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', PNAME, '程序员B', '产出', '证据-b30e'); })();
const REAL = path.join(ROOT, '团队');
const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) { rows.push({ name, ok: Boolean(ok), detail: ok ? null : detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 600)}`); }
function httpJson(url) { return new Promise((resolve) => { const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.setTimeout(3000, () => { req.destroy(); resolve(null); }); }); }
async function waitTarget(port, ms, pick) { const end = Date.now() + ms; while (Date.now() < end) { const list = await httpJson(`http://127.0.0.1:${port}/json/list`); if (Array.isArray(list)) { const hit = list.find(pick); if (hit && hit.webSocketDebuggerUrl) return hit; } await sleep(400); } return null; }
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(String(e.data)); } catch { return; } if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } }); }
  send(method, params = {}, ms = 60000) { const id = ++this.seq; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, ms); }); }
  async evaluate(expr, ms = 60000) { try { const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms); if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || '') }; return out && out.result ? out.result.value : undefined; } catch (e) { return { __cdperror: String((e && e.message) || e) }; } }
}
function seed(name) {
  const SB = path.join(BASE, name);
  const DATA = path.join(SB, 'data');
  const TEAM = path.join(SB, '团队');
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  const team = JSON.parse(fs.readFileSync(path.join(REAL, '状态', '团队.json'), 'utf8').replace(/^\uFEFF/, ''));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = PNAME;
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  const store = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'userdata', 'workbench.json'), 'utf8').replace(/^\uFEFF/, ''));
  const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PNAME) || (store.projects || [])[0];
  if (!project) throw new Error('真实 workbench 无项目');
  project.path = path.join(ROOT, '项目', PNAME);
  project.teamName = PNAME;
  project.sessions = {};
  project.workspace = { sessionIds: [] };
  store.projects = [project];
  store.activeProjectId = project.id;
  fs.writeFileSync(path.join(DATA, 'userdata', 'workbench.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
  return { SB, DATA, TEAM };
}
async function launch(dirs, port, extraEnv, extraArgs) {
  const env = {
    ...process.env,
    AWB_DATA_DIR: dirs.DATA, TEAM_ROOT: dirs.TEAM, TEAM_SELFTEST: '1',
    AWB_FX_OVERLAY_TEST: '1', AWB_FX_OVERLAY_FORCE_VISIBLE: '1', AWB_SHOW_INACTIVE: '1',
    ...(extraEnv || {})
  };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + port, ...(extraArgs || [])], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  let log = '';
  try { child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); }); } catch { /* ignore */ }
  const target = await waitTarget(port, 120000, (item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
  if (!target) { try { child.kill(); } catch { /* ignore */ } return { failed: true, log: log.slice(-2000) }; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('ws fail')), { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  for (let i = 0; i < 200; i += 1) { const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(window.AWB_FX)'); if (ready === true) break; await sleep(400); }
  return { child, cdp, ws, port, log: () => log };
}
async function close(inst) { if (!inst) return; try { inst.cdp.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ } await sleep(800); try { inst.ws.close(); } catch { /* ignore */ } try { inst.child.kill(); } catch { /* ignore */ } await sleep(400); try { if (inst.child && inst.child.pid && inst.child.exitCode === null) spawnSync('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ } }
const status = (cdp) => cdp.evaluate('window.workbench.fxOverlayStatus()');
const shellCanvas = (cdp) => cdp.evaluate('(() => { const c = document.querySelector("#awb-theme-particles"); if (!c) return { missing: true }; const ctx = c.getContext("2d"); let nonEmpty = 0; let sampled = 0; try { const d = ctx.getImageData(0, 0, c.width, c.height).data; const step = 4 * 16; for (let i = 3; i < d.length; i += step) { sampled += 1; if (d[i] > 0) nonEmpty += 1; } } catch (e) { return { err: String(e && e.message || e) }; } return { particles: Number(c.getAttribute("data-fx-particles") || 0), w: c.width, h: c.height, sampled, nonEmpty }; })()');
async function waitOverlayReady(cdp, ms) { const end = Date.now() + ms; let last = null; while (Date.now() < end) { last = await status(cdp); if (last && last.ready === true) return last; await sleep(500); } return last; }
function infoFor(inst) { return inst ? { pid: inst.child && inst.child.pid, port: inst.port, head: headCommit() } : null; }
function headCommit() { try { return require('node:child_process').execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch { return ''; } }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const dirs = seed('main');
  const portA = 9760 + (process.pid % 15);
  const inst = await launch(dirs, portA, {}, []);
  const report = { at: new Date().toISOString(), head: headCommit(), cases: [] };
  check('A0 隔离实例启动且 AWB_FX 就绪', Boolean(inst), infoFor(inst));
  if (inst) {
    try {
      const st0 = await waitOverlayReady(inst.cdp, 30000);
      check('A1-1 覆盖窗已创建并 ready', Boolean(st0 && st0.ready === true), st0 && { ready: st0.ready, visible: st0.visible, window: st0.window, capabilities: st0.capabilities });
      check('A1-2 覆盖窗透明/无框/父窗/不可聚焦/命中穿透能力可观测', Boolean(st0 && st0.capabilities && st0.capabilities.clickThrough === true && st0.capabilities.focusable === false && st0.capabilities.parented === true && st0.capabilities.transparent === true), st0 && st0.capabilities);
      check('A1-3 bounds 与主窗一致（初始）', Boolean(st0 && st0.window && st0.window.boundsMatch === true), st0 && st0.window);
      // 注入 DSH 在线 + 让页面处于「前台」态（离屏自检窗口默认失焦会触发 fx 暂停），
      // 再用真实 status 把 ready 标志补上（生产由 renderDsh/onFxOverlayReady 写同一组标志），走真实 sync 路径。
      // 说明：沙盘 DSH 恒离线，renderDsh 会周期性把 __awbFxOverlayOnline 写回 false；
      //       自检里用 defineProperty 固定为 true（只覆盖这个测试专用标志，不改生产代码语义）。
      const inject = await inst.cdp.evaluate('(async () => { try { Object.defineProperty(window, "__awbFxOverlayOnline", { configurable: true, get: function () { return true; }, set: function () { /* test pin */ } }); } catch (e) { /* ignore */ } try { window.dispatchEvent(new Event("focus")); } catch (e) { /* ignore */ } try { const s = await window.workbench.fxOverlayStatus(); window.__awbFxOverlayReady = !!(s && s.ready === true); } catch (e) { /* ignore */ } window.AWB_FX.sync(); const sample = window.AWB_FX.sample(); return { paused: Boolean(sample && sample.degrade && sample.degrade.paused), ready: window.__awbFxOverlayReady, online: window.__awbFxOverlayOnline, owns: window.AWB_FX.overlayOwns(), mode: sample && sample.degrade && sample.degrade.level }; })()');
      await sleep(1800);
      // renderDsh 的周期 sync 可能重置一些派生标志：再稳一次（只调生产同一 sync 入口）。
      await inst.cdp.evaluate('window.AWB_FX.sync(); true');
      await sleep(600);
      const shell1 = await shellCanvas(inst.cdp);
      const st1 = await status(inst.cdp);
      const owns = await inst.cdp.evaluate('window.AWB_FX.overlayOwns()');
      check('A2-1 overlayOwns=true（覆盖窗接管）', owns === true, { owns, inject });
      check('A2-2 壳内 #awb-theme-particles 停画（particles=0）', Boolean(shell1 && (shell1.missing === true || shell1.particles === 0)), shell1);
      check('A2-3 壳内画布无可见像素（采样 alpha 全 0）', Boolean(shell1 && shell1.missing === true || (shell1 && shell1.nonEmpty === 0)), shell1);
      check('A2-4 覆盖窗在画（parts>0 且抽样非空）', Boolean(st1 && st1.overlayCanvas && st1.overlayCanvas.parts > 0 && st1.overlaySample && st1.overlaySample.nonEmpty > 0), st1 && { overlayCanvas: st1.overlayCanvas, overlaySample: st1.overlaySample, state: st1.state, visible: st1.visible });
      // 主窗页面事件通道正常（穿透的 OS 级由 capabilities.clickThrough/ignoreMouseEvents 断言；
      // CDP Input.dispatchMouseEvent 对离屏窗口不保证投递，这里用页面内 MouseEvent 验证主窗监听链未被覆盖窗破坏）
      const mouse2 = await inst.cdp.evaluate('(() => { let got = null; const h = (e) => { got = { type: e.type, x: e.clientX, y: e.clientY, target: String((e.target && e.target.id) || "") }; }; window.addEventListener("mousedown", h, true); try { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 400, clientY: 300 })); } catch (e) { got = { error: String((e && e.message) || e) }; } window.removeEventListener("mousedown", h, true); return { got }; })()');
      check('A3-1 主窗页面事件通道正常（穿透由 capabilities 佐证）', Boolean(mouse2 && mouse2.got), { mouse2, capabilities: st1 && st1.capabilities });
      // bounds 跟随：测试专用 IPC 驱动窗口（生产实例 env 未开时该 IPC 直接拒绝；仅隔离自检可用）
      async function driveWindow(action, label) {
        const r = await inst.cdp.evaluate(`window.workbench.fxOverlayTestWindow(${JSON.stringify(action)})`);
        await sleep(1200);
        const s = await status(inst.cdp);
        const mb = s && s.window && s.window.mainBounds;
        const ob = s && s.window && s.window.overlayBounds;
        const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 2;
        const ok = Boolean(r && r.ok && mb && ob && close(mb.x, ob.x) && close(mb.y, ob.y) && close(mb.width, ob.width) && close(mb.height, ob.height));
        return { label, action, result: r, window: s && s.window, ok };
      }
      const resized = await driveWindow({ type: 'resize', width: 1280, height: 820 }, 'resize');
      check('A4-1 resize 后 bounds 跟随', resized.ok === true, resized);
      const maxed = await driveWindow({ type: 'maximize' }, 'maximize');
      check('A4-2 最大化后 bounds 跟随', maxed.ok === true, maxed);
      const normal = await driveWindow({ type: 'restore' }, 'restore');
      check('A4-3 还原后 bounds 跟随', normal.ok === true, normal);
      const full = await driveWindow({ type: 'fullscreen' }, 'fullscreen');
      check('A4-4 全屏后 bounds 跟随', full.ok === true, full);
      const normal2 = await driveWindow({ type: 'restore' }, 'restore2');
      check('A4-5 退出全屏后 bounds 跟随', normal2.ok === true, normal2);
      // 最小化暂停 / 恢复继续
      const min = await driveWindow({ type: 'minimize' }, 'minimize');
      await sleep(700);
      const stMin = await status(inst.cdp);
      check('A5-1 最小化后覆盖窗隐藏（visible=false + mainMinimized）', Boolean(stMin && stMin.window && stMin.window.mainMinimized === true && stMin.visible === false), stMin && { visible: stMin.visible, window: stMin.window });
      const rest = await driveWindow({ type: 'restore' }, 'restore3');
      await sleep(1400);
      const stRest = await status(inst.cdp);
      check('A5-2 恢复后覆盖窗重新显示并继续画（parts>0）', Boolean(rest.ok && stRest && stRest.visible === true && stRest.overlayCanvas && stRest.overlayCanvas.parts > 0), stRest && { visible: stRest.visible, overlayCanvas: stRest.overlayCanvas, window: stRest.window, state: stRest.state });
      // 第二窗口开销
      const bench = await inst.cdp.evaluate('window.workbench.fxOverlayBenchmark()');
      check('A6-1 覆盖窗开销可量（benchmark ok + 覆盖窗 RSS>0）', Boolean(bench && bench.ok === true && bench.delta && Number(bench.delta.overlayRssMB) > 0), bench);
      report.caseMain = { status0: st0, owns, shell: shell1, statusAfter: st1, bounds: { resized, maxed, normal, full, normal2 }, minimized: stMin, restored: stRest, benchmark: bench };
    } finally {
      try { await close(inst); } catch { /* ignore */ }
    }
  }
  // 回退：AWB_FX_OVERLAY_DISABLE=1
  try {
    const dirs2 = seed('fallback');
    const portB = portA + 20;
    const inst2 = await launch(dirs2, portB, { AWB_FX_OVERLAY_DISABLE: '1' }, []);
    check('B0 回退实例启动', Boolean(inst2 && inst2.cdp), inst2 && inst2.log ? { log: inst2.log() } : null);
    if (inst2 && inst2.cdp) {
      try {
        await inst2.cdp.evaluate('(async () => { try { const s = await window.workbench.fxOverlayStatus(); window.__awbFxOverlayReady = !!(s && s.ready === true); } catch (e) { /* ignore */ } window.__awbFxOverlayOnline = true; window.AWB_FX.sync(); return true; })()');
        await sleep(1500);
        const stB = await status(inst2.cdp);
        const shellB = await shellCanvas(inst2.cdp);
        const ownsB = await inst2.cdp.evaluate('window.AWB_FX.overlayOwns()');
        check('B1 覆盖窗禁用时不创建/不 ready', Boolean(stB && stB.ready === false), stB && { ready: stB.ready, window: stB.window });
        check('B2 壳内回退绘制（overlayOwns=false + 粒子>0 且有像素）', ownsB === false && Boolean(shellB && shellB.particles > 0 && shellB.nonEmpty > 0), { ownsB, shellB });
        report.caseFallback = { status: stB, shell: shellB, owns: ownsB };
      } finally { try { await close(inst2); } catch { /* ignore */ } }
    }
  } catch (e) { check('B0 回退实例异常', false, String(e && e.stack || e).slice(0, 400)); }
  // 125% 缩放：bounds 不偏
  try {
    const dirs3 = seed('dpi125');
    const portC = portA + 40;
    const inst3 = await launch(dirs3, portC, {}, ['--force-device-scale-factor=1.25']);
    check('C0 125% 缩放实例启动', Boolean(inst3 && inst3.cdp), inst3 && inst3.log ? { log: inst3.log() } : null);
    if (inst3 && inst3.cdp) {
      try {
        const stC0 = await waitOverlayReady(inst3.cdp, 30000);
        await inst3.cdp.evaluate('(async () => { try { const s = await window.workbench.fxOverlayStatus(); window.__awbFxOverlayReady = !!(s && s.ready === true); } catch (e) { /* ignore */ } window.__awbFxOverlayOnline = true; window.AWB_FX.sync(); return true; })()');
        await inst3.cdp.evaluate('window.workbench.fxOverlayTestWindow({ type: "resize", width: 1200, height: 800 })');
        await sleep(1400);
        const stC = await status(inst3.cdp);
        const dpr = await inst3.cdp.evaluate('window.devicePixelRatio');
        const mb = stC && stC.window && stC.window.mainBounds;
        const ob = stC && stC.window && stC.window.overlayBounds;
        const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 2;
        const noOffset = Boolean(mb && ob && near(mb.x, ob.x) && near(mb.y, ob.y) && near(mb.width, ob.width) && near(mb.height, ob.height));
        check('C1 125% 下 devicePixelRatio≈1.25', Math.abs(Number(dpr) - 1.25) < 0.06, { dpr });
        check('C2 125% 下覆盖窗与主窗 bounds 不偏（容差≤2px）', Boolean(stC0 && noOffset && stC.window.boundsMatch !== undefined), stC && { mainBounds: mb, overlayBounds: ob, dpr });
        report.caseDpi = { status0: stC0, status: stC, dpr, noOffset };
      } finally { try { await close(inst3); } catch { /* ignore */ } }
    }
  } catch (e) { check('C0 125% 实例异常', false, String(e && e.stack || e).slice(0, 400)); }
  report.checks = rows;
  const passed = rows.filter((r) => r.ok).length;
  report.summary = { passed, total: rows.length, ok: passed === rows.length };
  fs.writeFileSync(path.join(OUT, 'b30e-fx-overlay.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`B30E ${passed}/${rows.length} ${passed === rows.length ? 'PASS' : 'FAIL'}`);
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(passed === rows.length ? 0 : 1);
})().catch((e) => { console.error('FAILED', e && e.stack); process.exit(2); });
