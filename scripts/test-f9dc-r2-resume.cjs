'use strict';
/**
 * T-20261122-070032-f9dc（R2）：覆盖窗 ready + DSH 在线时，blur→focus→resume
 * 不得重新拉起壳内循环；断言 running=false、canvas 像素 alpha 全 0、particles=0，
 * 且不依赖下一次 sync()。随后 ready=false 时须恢复壳内绘制（降级兜底）。
 * 隔离实例；只 taskkill 自起 child.pid；不改生产。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const PNAME = '工作台改造修复';
const BASE = path.join(ROOT, '_tmp', `f9dc-r2-${process.pid}-${Date.now()}`);
const DATA = path.join(BASE, 'data');
const TEAM = path.join(BASE, '团队');
const PORT = 9820 + (process.pid % 150);
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', PNAME, '程序员A', '产出', '证据-f9dc-20261122'); })();
const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) { rows.push({ name, ok: Boolean(ok), detail: ok ? null : detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 500)}`); }
function httpJson(url) { return new Promise((resolve) => { const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.setTimeout(3000, () => { req.destroy(); resolve(null); }); }); }
async function waitTarget(port, ms, pick) { const end = Date.now() + ms; while (Date.now() < end) { const list = await httpJson(`http://127.0.0.1:${port}/json/list`); if (Array.isArray(list)) { const hit = list.find(pick); if (hit && hit.webSocketDebuggerUrl) return hit; } await sleep(400); } return null; }
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(String(e.data)); } catch { return; } if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } }); }
  send(method, params = {}, ms = 60000) { const id = ++this.seq; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, ms); }); }
  async evaluate(expr, ms = 60000) { try { const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms); if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || '') }; return out && out.result ? out.result.value : undefined; } catch (e) { return { __cdperror: String((e && e.message) || e) }; } }
}
function seed() {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  const team = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8').replace(/^\uFEFF/, ''));
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
}
const canvasState = (cdp) => cdp.evaluate('(() => { const c = document.querySelector("#awb-theme-particles"); if (!c) return { missing: true }; const ctx = c.getContext("2d"); let nonEmpty = 0; let sampled = 0; try { const d = ctx.getImageData(0, 0, c.width, c.height).data; const step = 4 * 16; for (let i = 3; i < d.length; i += step) { sampled += 1; if (d[i] > 0) nonEmpty += 1; } } catch (e) { return { err: String(e && e.message || e) }; } return { particles: Number(c.getAttribute("data-fx-particles") || 0), nonEmpty, sampled, w: c.width, h: c.height }; })()');
const crypto = require('node:crypto');
function sha(file) { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; } }
const REAL_TEAM_JSON = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_WORKBENCH = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const realBefore = { team: sha(REAL_TEAM_JSON), workbench: sha(REAL_WORKBENCH) };
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  seed();
  const env = { ...process.env, AWB_DATA_DIR: DATA, TEAM_ROOT: TEAM, TEAM_SELFTEST: '1', AWB_SHOW_INACTIVE: '1', DSH_WEB_URL: 'http://127.0.0.1:1' };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(BASE, 'userdata-electron')], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });
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
  check('A0 隔离实例启动且 AWB_FX 就绪', Boolean(inst), { port: PORT });
  const report = { at: new Date().toISOString(), head: (() => { try { return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(); } catch { return ''; } })(), rows };
  if (inst) {
    try {
      await inst.cdp.evaluate('(() => { try { window.dispatchEvent(new Event("focus")); } catch (e) {} Object.defineProperty(window, "__awbFxOverlayReady", { configurable: true, get: function () { return true; }, set: function () {} }); Object.defineProperty(window, "__awbFxOverlayOnline", { configurable: true, get: function () { return true; }, set: function () {} }); window.AWB_FX.sync(); return true; })()');
      await sleep(1000);
      const before = await canvasState(inst.cdp);
      const syncState = await inst.cdp.evaluate('(() => { const s = window.AWB_FX.sample(); return { running: Boolean(s.degrade && s.degrade.running), paused: Boolean(s.degrade && s.degrade.paused), shellParticles: s.particles && s.particles.count }; })()');
      check('R2-1 ready+online sync 后壳内停画', before && before.nonEmpty === 0 && syncState.running === false, { before, syncState });
      await inst.cdp.evaluate('window.dispatchEvent(new Event("blur")); true');
      await sleep(400);
      const blurState = await inst.cdp.evaluate('(() => { const s = window.AWB_FX.sample(); return { paused: Boolean(s.degrade && s.degrade.paused), running: Boolean(s.degrade && s.degrade.running) }; })()');
      const resumeNow = await inst.cdp.evaluate('(() => { window.dispatchEvent(new Event("focus")); const s = window.AWB_FX.sample(); return { ready: window.__awbFxOverlayReady === true, online: window.__awbFxOverlayOnline === true, paused: Boolean(s.degrade && s.degrade.paused), running: Boolean(s.degrade && s.degrade.running), shellParticles: s.particles && s.particles.count }; })()');
      await sleep(600);
      const afterCanvas = await canvasState(inst.cdp);
      check('R2-2 blur→focus→resume：running=false（不依赖下一次 sync）', resumeNow && resumeNow.ready === true && resumeNow.online === true && resumeNow.paused === false && resumeNow.running === false, { blurState, resumeNow });
      check('R2-3 blur→focus→resume：canvas alpha 全 0 + particles=0', afterCanvas && afterCanvas.nonEmpty === 0 && afterCanvas.particles === 0, afterCanvas);
      await inst.cdp.evaluate('(() => { Object.defineProperty(window, "__awbFxOverlayReady", { configurable: true, get: function () { return false; }, set: function () {} }); window.AWB_FX.sync(); return true; })()');
      await sleep(800);
      const fallback = await inst.cdp.evaluate('(() => { const s = window.AWB_FX.sample(); return { running: Boolean(s.degrade && s.degrade.running), paused: Boolean(s.degrade && s.degrade.paused), shellParticles: s.particles && s.particles.count }; })()');
      const fallbackCanvas = await canvasState(inst.cdp);
      check('R2-4 ready=false 时壳内恢复绘制（不误伤降级兜底）', fallback.running === true && fallback.shellParticles > 0 && fallbackCanvas.particles > 0, { fallback, fallbackCanvas });
      report.case = { before, syncState, blurState, resumeNow, afterCanvas, fallback, fallbackCanvas };
    } finally { try { inst.cdp.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ } await sleep(800); try { inst.ws.close(); } catch { /* ignore */ } try { child.kill(); } catch { /* ignore */ } await sleep(400); try { if (child && child.pid && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ } }
  }
  report.summary = { pass: rows.filter((r) => r.ok).length, total: rows.length };
  report.realState = { before: realBefore, after: { team: sha(REAL_TEAM_JSON), workbench: sha(REAL_WORKBENCH) } };
  report.summary.pass = rows.filter((r) => r.ok).length;
  check('真实团队.json/workbench.json 零写入', report.realState.before.team === report.realState.after.team && report.realState.before.workbench === report.realState.after.workbench, report.realState);
  report.summary = { pass: rows.filter((r) => r.ok).length, total: rows.length };
  fs.writeFileSync(path.join(OUT, 'f9dc-r2-resume.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`F9DC_R2 ${report.summary.pass}/${report.summary.total} PASS`);
  if (report.summary.pass !== rows.length) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
