#!/usr/bin/env node
'use strict';
/**
 * test-7a3b-force-persist.cjs —— 7a3b 补口（AC1⑥ 强制开启重启保持）夹具。
 * 同一沙盘数据目录起 3 次隔离实例：
 *  ① reduced 下点「仍然开启」→ workbench.json ui.fxForce===true + 菜单「已强制开启（重启仍保持）」；
 *  ② 重启后 reduced 下仍 data-fx-force=1 / mode=full / 粒子>0（落盘生效）；
 *  ③ 点「恢复系统默认」→ ui.fxForce===false；再重启 → reduced 下不再强制（mode=reduced）。
 * 用法：node scripts/test-7a3b-force-persist.cjs [--out <dir>]；只 taskkill /PID 自起 child.pid。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PNAME = '工作台改造修复';
const SB = path.join(ROOT, '_tmp', `fxforce-${process.pid}-${Date.now()}`);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const BASE_PORT = Number(process.env.AWB_FXP_PORT || (9640 + (process.pid % 15)));
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', PNAME, '程序员B', '产出', '证据-7a3b-补口'); })();
const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) { rows.push({ name, ok: Boolean(ok), detail: ok ? null : detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 400)}`); }
function httpJson(url) { return new Promise((resolve) => { const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.setTimeout(3000, () => { req.destroy(); resolve(null); }); }); }
async function waitTarget(port, ms, pick) { const end = Date.now() + ms; while (Date.now() < end) { const list = await httpJson(`http://127.0.0.1:${port}/json/list`); if (Array.isArray(list)) { const hit = list.find(pick); if (hit && hit.webSocketDebuggerUrl) return hit; } await sleep(400); } return null; }
class Cdp { constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(String(e.data)); } catch { return; } if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } }); } send(method, params = {}, ms = 60000) { const id = ++this.seq; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, ms); }); } async evaluate(expr, ms = 60000) { try { const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms); if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || '') }; return out && out.result ? out.result.value : undefined; } catch (e) { return { __cdperror: String((e && e.message) || e) }; } } }
function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  const team = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8').replace(/^\uFEFF/, ''));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = PNAME;
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  const store = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'userdata', 'workbench.json'), 'utf8').replace(/^\uFEFF/, ''));
  const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PNAME) || (store.projects || [])[0];
  project.path = path.join(ROOT, '项目', PNAME);
  store.projects = [project]; store.activeProjectId = project.id;
  fs.writeFileSync(path.join(DATA, 'userdata', 'workbench.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.mkdirSync(OUT, { recursive: true });
}
function readStoredForce() {
  try {
    const store = JSON.parse(fs.readFileSync(path.join(DATA, 'userdata', 'workbench.json'), 'utf8').replace(/^\uFEFF/, ''));
    return Boolean(store.ui && store.ui.fxForce);
  } catch { return null; }
}
async function launch(port) {
  const env = { ...process.env, AWB_DATA_DIR: DATA, TEAM_ROOT: TEAM, TEAM_SELFTEST: '1' };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + port], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });
  const target = await waitTarget(port, 90000, (item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
  if (!target) { try { child.kill(); } catch { /* ignore */ } return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('ws fail')), { once: true }); });
  const cdp = new Cdp(ws); await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  for (let i = 0; i < 200; i += 1) { const ok = await cdp.evaluate('document.readyState === "complete" && Boolean(window.AWB_FX)'); if (ok === true) break; await sleep(400); }
  return { child, cdp, ws };
}
async function close(inst) { if (!inst) return; try { inst.cdp.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ } await sleep(900); try { inst.ws.close(); } catch { /* ignore */ } try { inst.child.kill(); } catch { /* ignore */ } await sleep(500); try { if (inst.child && inst.child.pid && inst.child.exitCode === null) spawnSync('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ } }
(async () => {
  seed();
  const report = { at: new Date().toISOString(), checks: rows };
  // ── 第一次启动：点仍然开启 + 落盘
  let inst = await launch(BASE_PORT);
  check('P0 第一次实例启动', Boolean(inst));
  if (inst) {
    await inst.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await inst.cdp.evaluate('window.AWB_FX.sync(); window.__awbPaintEffectMenu(); true');
    await sleep(400);
    const before = await inst.cdp.evaluate('(() => ({ mode: window.AWB_FX.mode().level }))()');
    check('P1 初始 reduced 且未强制', before && before.mode === 'reduced', before);
    const clicked = await inst.cdp.evaluate('(async () => { const b = document.querySelector("[data-fx-force-btn]"); if (!b) return { noBtn: true }; b.click(); await new Promise((r) => setTimeout(r, 1200)); const c = document.querySelector("#fx-layer canvas"); return { attr: document.documentElement.getAttribute("data-fx-force"), mode: window.AWB_FX.mode().level, particles: c ? Number(c.getAttribute("data-fx-particles") || 0) : 0, hintHidden: (() => { const h = document.querySelector("[data-fx-forced-hint]"); return h ? h.hidden : null; })() }; })()');
    check('P2 点仍然开启 → full + 粒子>0 + 强制提示可见', clicked && clicked.attr === '1' && clicked.mode === 'full' && clicked.particles > 0 && clicked.hintHidden === false, clicked);
    check('P3 workbench.json ui.fxForce===true（落盘）', readStoredForce() === true, { stored: readStoredForce() });
    await close(inst); inst = null;
  }
  // ── 第二次启动：重启保持
  inst = await launch(BASE_PORT + 1);
  check('P4 第二次实例启动（同一数据目录）', Boolean(inst));
  if (inst) {
    const persisted = await inst.cdp.evaluate('(() => ({ attr: document.documentElement.getAttribute("data-fx-force"), stored: true }))()');
    check('P5 重启后 data-fx-force=1（启动读取落盘）', persisted && persisted.attr === '1', persisted);
    await inst.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await inst.cdp.evaluate('window.AWB_FX.sync(); true');
    await sleep(600);
    const after = await inst.cdp.evaluate('(async () => { let pc = 0; for (let i = 0; i < 8; i += 1) { await new Promise((r) => setTimeout(r, 250)); const c = document.querySelector("#fx-layer canvas"); pc = c ? Number(c.getAttribute("data-fx-particles") || 0) : 0; if (pc > 0) break; } return { mode: window.AWB_FX.mode().level, reasons: window.AWB_FX.mode().reasons, attr: document.documentElement.getAttribute("data-fx-force"), particles: pc }; })()');
    check('P6 重启后 reduced 系统下仍 full + forced + 粒子>0', after && after.mode === 'full' && (after.reasons || []).some((x) => String(x).includes('forced')) && after.particles > 0, after);
    const cleared = await inst.cdp.evaluate('(async () => { const b = document.querySelector("[data-fx-force-off]"); if (!b) return { noBtn: true }; b.click(); await new Promise((r) => setTimeout(r, 900)); return { attr: document.documentElement.getAttribute("data-fx-force"), mode: window.AWB_FX.mode().level }; })()');
    check('P7 点恢复系统默认 → 移除 data-fx-force 并回到 reduced', cleared && cleared.attr === null && cleared.mode === 'reduced', cleared);
    check('P8 workbench.json ui.fxForce===false（清除落盘）', readStoredForce() === false, { stored: readStoredForce() });
    await close(inst); inst = null;
  }
  // ── 第三次启动：清除后不再强制
  inst = await launch(BASE_PORT + 2);
  if (inst) {
    await inst.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await inst.cdp.evaluate('window.AWB_FX.sync(); true');
    await sleep(400);
    const final = await inst.cdp.evaluate('(() => ({ attr: document.documentElement.getAttribute("data-fx-force"), mode: window.AWB_FX.mode().level }))()');
    check('P9 清除后重启：reduced 系统下不再强制（mode=reduced）', final && final.attr === null && final.mode === 'reduced', final);
    await close(inst); inst = null;
  } else check('P10 第三次实例启动', false);
  try { fs.writeFileSync(path.join(OUT, 'force-persist-run.json'), JSON.stringify({ ...report, checks: rows }, null, 2) + '\n', 'utf8'); } catch { /* ignore */ }
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = rows.filter((r) => !r.ok);
  console.log('');
  console.log(`FXFORCE ${failed.length ? 'FAIL' : 'OK'} ${JSON.stringify({ total: rows.length, pass: rows.length - failed.length, red: failed.length })}`);
  console.log('证据：' + path.join(OUT, 'force-persist-run.json'));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FXFORCE ERROR ' + String((e && e.stack) || e)); process.exit(1); });
