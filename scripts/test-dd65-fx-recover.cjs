#!/usr/bin/env node
'use strict';
/**
 * test-dd65-fx-recover.cjs —— T-20261122-042951-dd65（P1 fx 降级/恢复）真窗口夹具。
 * 覆盖：
 *  A1 配置：fpsMin=40 / windows=3 / recoverWindows=2 / degradeMove=false / healthyFpsMin=55
 *  A2 聚焦可见 → samplingState.allowed=true
 *  A3 失焦（blur → paused）→ allowed=false；自动路径 autoSample 连喂 5 个坏窗 → 全部 skipped、不降级、skippedHidden 计数
 *  A4 切回聚焦（focus）→ allowed=true
 *  A5 自动路径 3 个坏窗 → 仅 particles 降级（move 不随降）、粒子数 0
 *  A6 自动路径 2 个健康窗（fps60/drop0）→ 清降级、lastRecoverAt 写、粒子恢复
 *  A7 再降级后 sync()+resetStats() 不得「假恢复」
 *  A8 resetDegraded() 手动清（诊断/夹具入口）
 *  A9 真实窗「切回自动恢复」：降级 → 失焦 → 回到前台 → 2 健康窗恢复，lastRecoverAt 更新
 * 用法：node scripts/test-dd65-fx-recover.cjs [--out <dir>]
 * 纪律：隔离 AWB_DATA_DIR/TEAM_ROOT 沙盘；只回收自己 spawn 的 child.pid（taskkill /PID）。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PNAME = '工作台改造修复';
const SB = path.join(ROOT, '_tmp', `fxdd65-${process.pid}-${Date.now()}`);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const PORT = Number(process.env.AWB_DD65_PORT || (9650 + (process.pid % 20)));
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', PNAME, '程序员B', '产出', '证据-dd65'); })();
const REAL = path.join(ROOT, '团队');
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
  fs.mkdirSync(OUT, { recursive: true });
  return { projectId: project.id };
}
async function launch() {
  const env = { ...process.env, AWB_DATA_DIR: DATA, TEAM_ROOT: TEAM, TEAM_SELFTEST: '1' };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });
  const target = await waitTarget(PORT, 90000, (item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
  if (!target) { try { child.kill(); } catch { /* ignore */ } return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('ws fail')), { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  for (let i = 0; i < 200; i += 1) { const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(window.AWB_FX)'); if (ready === true) break; await sleep(400); }
  try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, 5000); } catch { /* 旧版本无此域不影响主断言 */ }
  return { child, cdp, ws };
}
async function close(inst) { if (!inst) return; try { inst.cdp.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ } await sleep(800); try { inst.ws.close(); } catch { /* ignore */ } try { inst.child.kill(); } catch { /* ignore */ } await sleep(400); try { if (inst.child && inst.child.pid && inst.child.exitCode === null) spawnSync('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ } }

(async () => {
  const seedInfo = seed();
  const inst = await launch();
  check('A0 隔离实例启动且 AWB_FX 就绪', Boolean(inst), seedInfo);
  const report = { at: new Date().toISOString(), port: PORT, checks: rows };
  if (inst) {
    try {
      // A1 配置值
      const cfg = await inst.cdp.evaluate('window.AWB_FX.config.degrade');
      check('A1-1 配置 fpsMin=40 / windows=3 / recoverWindows=2 / degradeMove=false / healthyFpsMin=55',
        cfg && cfg.fpsMin === 40 && cfg.windows === 3 && cfg.recoverWindows === 2 && cfg.degradeMove === false && cfg.healthyFpsMin === 55, cfg);
      // A2 聚焦可见 → allowed
      const s2 = await inst.cdp.evaluate('window.AWB_FX.samplingState()');
      check('A2-1 聚焦可见时 samplingState.allowed=true', s2 && s2.allowed === true, s2);
      // A3 失焦 → 自动采样跳过、不降级
      await inst.cdp.evaluate('window.dispatchEvent(new Event("blur")); true');
      await sleep(300);
      const s3 = await inst.cdp.evaluate('window.AWB_FX.samplingState()');
      check('A3-1 失焦后 samplingState.allowed=false（paused=true）', s3 && s3.allowed === false && s3.paused === true, s3);
      const skip = await inst.cdp.evaluate('(() => { const before = window.AWB_FX.degraded(); const outs = []; for (let i = 0; i < 5; i += 1) outs.push(window.AWB_FX.autoSample({ fps: 20, dropRate: 50 }, "rolling")); const after = window.AWB_FX.degraded(); return { outs: outs.map((o) => o && o.skipped), steps: after.steps, skippedHidden: after.skippedHidden, before: before.steps }; })()');
      check('A3-2 失焦期间 autoSample 5 次全部 skipped', skip && (skip.outs || []).every((x) => x === true), skip);
      check('A3-3 失焦期间不产生降级（steps 空）', skip && (skip.steps || []).length === 0, skip);
      check('A3-4 skippedHidden 计数增加（≥5）', skip && Number(skip.skippedHidden) >= 5, skip);
      // A4 回到聚焦
      await inst.cdp.evaluate('window.dispatchEvent(new Event("focus")); true');
      await sleep(400);
      const s4 = await inst.cdp.evaluate('window.AWB_FX.samplingState()');
      check('A4-1 切回聚焦后 samplingState.allowed=true', s4 && s4.allowed === true && s4.paused === false, s4);
      // A5 自动路径 3 坏窗 → 仅 particles 降级
      const deg = await inst.cdp.evaluate('(() => { for (let i = 0; i < 3; i += 1) window.AWB_FX.autoSample({ fps: 25, dropRate: 5 }, "rolling"); const d = window.AWB_FX.degraded(); const c = document.querySelector("#fx-layer canvas"); const pc = c ? Number(c.getAttribute("data-fx-particles") || 0) : 0; return { steps: d.steps, active: d.active, particleCount: pc, samples: window.AWB_FX.sample().particles.count }; })()');
      check('A5-1 3 坏窗 → particles 降级（active=true）', deg && deg.active === true && (deg.steps || []).includes('particles'), deg);
      check('A5-2 move 不随 particles 自动降级', deg && !(deg.steps || []).includes('move'), deg);
      check('A5-3 降级后粒子数=0', deg && Number(deg.particleCount) === 0, deg);
      // A6 自动路径 2 健康窗 → 恢复
      const rec = await inst.cdp.evaluate('(() => { for (let i = 0; i < 2; i += 1) window.AWB_FX.autoSample({ fps: 60, dropRate: 0 }, "rolling"); const d = window.AWB_FX.degraded(); const c = document.querySelector("#fx-layer canvas"); return { steps: d.steps, active: d.active, lastRecoverAt: d.lastRecoverAt, lastRecoverReason: d.lastRecoverReason, particleCount: c ? Number(c.getAttribute("data-fx-particles") || 0) : 0, samples: window.AWB_FX.sample().particles.count }; })()');
      check('A6-1 2 健康窗 → 降级清空（steps 空）', rec && rec.active === false && (rec.steps || []).length === 0, rec);
      check('A6-2 lastRecoverAt 写入且 lastRecoverReason 含「已恢复」', rec && Number(rec.lastRecoverAt) > 0 && /已恢复/.test(String(rec.lastRecoverReason || '')), rec);
      check('A6-3 恢复后粒子数 >0', rec && Number(rec.particleCount) > 0 && Number(rec.samples) > 0, rec);
      // A7 再降级后 sync+resetStats 不得假恢复
      const noFalse = await inst.cdp.evaluate('(() => { for (let i = 0; i < 3; i += 1) window.AWB_FX.autoSample({ fps: 25, dropRate: 5 }, "rolling"); window.AWB_FX.sync(); window.AWB_FX.resetStats(); const d = window.AWB_FX.degraded(); return { steps: d.steps, active: d.active }; })()');
      check('A7-1 降级态下 sync()+resetStats() 不假恢复（steps 仍含 particles）', noFalse && noFalse.active === true && (noFalse.steps || []).includes('particles'), noFalse);
      // A8 resetDegraded 手动清
      const reset = await inst.cdp.evaluate('window.AWB_FX.resetDegraded()');
      check('A8-1 resetDegraded() 后 steps 空且粒子恢复', reset && reset.after && reset.after.active === false && (reset.after.steps || []).length === 0, reset && reset.after);
      // A9 真实窗「切回自动恢复」：降级 → 失焦 → 回前台 → 2 健康窗恢复
      const real = await inst.cdp.evaluate('(() => { for (let i = 0; i < 3; i += 1) window.AWB_FX.autoSample({ fps: 25, dropRate: 5 }, "rolling"); const degraded = window.AWB_FX.degraded().steps.slice(); window.dispatchEvent(new Event("blur")); return { degraded: degraded }; })()');
      await sleep(300);
      const focusBack = await inst.cdp.evaluate('window.dispatchEvent(new Event("focus")); new Promise((r) => setTimeout(() => r(true), 300))');
      const back = await inst.cdp.evaluate('(() => { for (let i = 0; i < 2; i += 1) window.AWB_FX.autoSample({ fps: 60, dropRate: 0 }, "rolling"); const d = window.AWB_FX.degraded(); return { steps: d.steps, active: d.active, lastRecoverAt: d.lastRecoverAt }; })()');
      check('A9-1 真实窗：失焦前已降级，回前台后 2 健康窗自动恢复', Boolean(focusBack) && real && (real.degraded || []).includes('particles') && back && back.active === false && (back.steps || []).length === 0 && Number(back.lastRecoverAt) > 0, { real, back });
    } finally {
      try { await close(inst); } catch { /* ignore */ }
    }
  }
  report.checks = rows;
  const passed = rows.filter((r) => r.ok).length;
  report.summary = { passed, total: rows.length, ok: passed === rows.length };
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `dd65-${PORT}.json`), JSON.stringify(report, null, 2) + '\n');
  } catch { /* ignore */ }
  console.log(`DD65 ${passed}/${rows.length} ${passed === rows.length ? 'PASS' : 'FAIL'}`);
  process.exit(passed === rows.length ? 0 : 1);
})().catch((e) => { console.error('FAILED', e && e.stack); process.exit(2); });
