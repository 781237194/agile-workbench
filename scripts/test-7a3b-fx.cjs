#!/usr/bin/env node
'use strict';
/**
 * test-7a3b-fx.cjs —— R-20261119-011256-7a3b（B 任务 T-20261119-021321-51a4）CDP 验收夹具。
 * 隔离实例（AWB_DATA_DIR + TEAM_ROOT 沙盘）真窗口断言：
 *  AC1 真实态（reduced 下 [data-fx-real-mode]=reduced + 提示行含「减少动画」+ 点「仍然开启」→ full 且粒子>0）
 *  AC2 强制入口（菜单 data-fx-force=1 / AWB_FX_FORCE_MOTION=1 两种运行时 + 源码含 ?motion=1）
 *  AC3 自采样降级真接线（evaluateDegrade 两坏窗 → degraded.steps 含 particles；__themeProbe 调用数=0）
 *  AC4 降级可恢复（两坏窗→12 健康窗 → degraded 清空 + 诊断日志含「已恢复」）
 *  AC5 fx.jsonl 自证（≥5 行且字段 {ts,mode,reasons,particles,canvasDisplay}）
 *  AC6 不谎报（AWB_FX 缺失 → __awbThemeEffects() mode=off+fxUnavailable、菜单文案「特效层未加载」）
 * 用法：node scripts/test-7a3b-fx.cjs [--out <dir>]；只 taskkill /PID 自起 child.pid。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PNAME = '工作台改造修复';
const SB = path.join(ROOT, '_tmp', `fx7a3b-${process.pid}-${Date.now()}`);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const PORT = Number(process.env.AWB_FX_PORT || (9610 + (process.pid % 20)));
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', PNAME, '程序员B', '产出', '证据-7a3b'); })();
const REAL = path.join(ROOT, '团队');
const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) { rows.push({ name, ok: Boolean(ok), detail: ok ? null : detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 400)}`); }
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
      // AC1：reduced 真实态
      await inst.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await inst.cdp.evaluate('window.AWB_FX && window.AWB_FX.sync(); window.__awbPaintEffectMenu && window.__awbPaintEffectMenu(); true');
      await sleep(400);
      const reduced = await inst.cdp.evaluate('(() => { const m = window.AWB_FX.mode(); const box = document.querySelector("[data-fx-real-mode]"); const hint = document.querySelector("[data-fx-reduced-hint]"); const label = document.querySelector("[data-more=\\"effect\\"] [data-effect-current]"); return { mode: m.level, reasons: m.reasons, realAttr: box ? box.getAttribute("data-fx-real-mode") : null, hintHidden: hint ? hint.hidden : null, hintText: hint ? String(hint.textContent || "") : "", label: label ? String(label.textContent || "") : "" }; })()');
      check('AC1-1 reduced 下 AWB_FX.mode()=reduced', reduced && reduced.mode === 'reduced', reduced);
      check('AC1-2 [data-fx-real-mode]="reduced"', reduced && reduced.realAttr === 'reduced', reduced);
      check('AC1-3 提示行存在且未隐藏、含「减少动画」', reduced && reduced.hintHidden === false && /减少动画/.test(reduced.hintText), reduced);
      check('AC1-4 菜单不再谎报（label 非纯「完整」）', reduced && reduced.label && reduced.label !== '完整', reduced);
      // AC1-5 点「仍然开启」
      const forced = await inst.cdp.evaluate('(async () => { const btn = document.querySelector("[data-fx-force-btn]"); if (!btn) return { noBtn: true }; btn.click(); await new Promise((r) => setTimeout(r, 1500)); const m = window.AWB_FX.mode(); const c = document.querySelector("#fx-layer canvas"); const pc = c ? Number(c.getAttribute("data-fx-particles") || 0) : 0; return { attr: document.documentElement.getAttribute("data-fx-force"), mode: m.level, reasons: m.reasons, particleCount: pc }; })()');
      check('AC1-5 点「仍然开启」→ data-fx-force=1、mode=full、forced', forced && forced.attr === '1' && forced.mode === 'full' && (forced.reasons || []).some((r) => String(r).includes('forced')), forced);
      check('AC1-6 强制后粒子数 >0', forced && Number(forced.particleCount) > 0, forced);
      // AC2：AWB_FX_FORCE_MOTION 入口
      const forcedEnv = await inst.cdp.evaluate('(() => { document.documentElement.removeAttribute("data-fx-force"); window.AWB_FX_FORCE_MOTION = "1"; window.AWB_FX.sync(); const m = window.AWB_FX.mode(); return { mode: m.level, reasons: m.reasons }; })()');
      check('AC2-1 AWB_FX_FORCE_MOTION=1 同样强制 full', forcedEnv && forcedEnv.mode === 'full' && (forcedEnv.reasons || []).some((r) => String(r).includes('forced')), forcedEnv);
      const srcHasMotion = await inst.cdp.evaluate('(async () => { const t = await (await fetch(location.href)).text().catch(() => ""); return true; })()');
      // ?motion=1 用源码静态断言（页面脚本已打包为 app.js，直接读磁盘更可靠）
      const fxSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'fx-layer.js'), 'utf8');
      check('AC2-2 源码支持 ?motion=1（第三入口）', /get\('motion'\) === '1'/.test(fxSrc));
      // AC3：自采样降级（不调用 __themeProbe）
      const degrade = await inst.cdp.evaluate('(() => { window.__probeCount = 0; const orig = window.__themeProbe; window.__themeProbe = function () { window.__probeCount += 1; return orig && orig.apply(null, arguments); }; window.AWB_FX.evaluateDegrade({ fps: 40, dropRate: 3, frames: 120, sampleMs: 2000 }, "rolling"); window.AWB_FX.evaluateDegrade({ fps: 40, dropRate: 3, frames: 120, sampleMs: 2000 }, "rolling"); const d = window.AWB_FX.degraded(); return { steps: d.steps, active: d.active, probeCount: window.__probeCount }; })()');
      check('AC3-1 两坏窗口 → degraded.steps 含 particles', degrade && (degrade.steps || []).includes('particles'), degrade);
      check('AC3-2 全程未调用 __themeProbe', degrade && degrade.probeCount === 0, degrade);
      // AC4：健康窗口恢复
      const recovered = await inst.cdp.evaluate('(async () => { for (let i = 0; i < 12; i += 1) window.AWB_FX.evaluateDegrade({ fps: 60, dropRate: 0, frames: 120, sampleMs: 2000 }, "rolling"); await new Promise((r) => setTimeout(r, 500)); const d = window.AWB_FX.degraded(); let diag = []; try { diag = window.AWB_FX.diag().rows; } catch (e) {} const recoveredRows = diag.filter((r) => r && (r.reason === "已恢复" || r.action === "recover")); const c = document.querySelector("#fx-layer canvas"); const pc = c ? Number(c.getAttribute("data-fx-particles") || 0) : 0; return { steps: d.steps, active: d.active, recoveredRows: recoveredRows.length, particleCount: pc }; })()');
      check('AC4-1 连续健康窗后降级恢复（steps 空）', recovered && (recovered.steps || []).length === 0 && recovered.active === false, recovered);
      check('AC4-2 诊断日志出现「已恢复」', recovered && recovered.recoveredRows > 0, recovered);
      check('AC4-3 恢复后粒子数 >0', recovered && Number(recovered.particleCount) > 0, recovered);
      // AC5：fx.jsonl
      await inst.cdp.evaluate('(async () => { for (let i = 0; i < 5; i += 1) { window.AWB_FX.sync(); await new Promise((r) => setTimeout(r, 120)); } return true; })()');
      await sleep(600);
      const fxFile = path.join(DATA, 'fx.jsonl');
      let lines = 0; let last = null;
      try { const txt = fs.readFileSync(fxFile, 'utf8').trim().split('\n').filter(Boolean); lines = txt.length; last = JSON.parse(txt[txt.length - 1]); } catch { lines = 0; }
      check('AC5-1 data/fx.jsonl 有 ≥5 行', lines >= 5, { lines, file: fxFile });
      check('AC5-2 字段齐 {ts,mode,reasons,particles,canvasDisplay}', Boolean(last) && ['ts', 'mode', 'reasons', 'particles', 'canvasDisplay'].every((k) => k in last), last);
      // AC6：AWB_FX 缺失不谎报
      const noFx = await inst.cdp.evaluate('(() => { window.AWB_FX = null; let r = null; try { r = window.__awbThemeEffects(); } catch (e) { r = { threw: String(e && e.message || e) }; } try { window.__awbPaintEffectMenu(); } catch (e) {} const label = document.querySelector("[data-more=\\"effect\\"] [data-effect-current]"); const box = document.querySelector("[data-fx-real-mode]"); return { effects: r, label: label ? String(label.textContent || "") : "", realAttr: box ? box.getAttribute("data-fx-real-mode") : null }; })()');
      check('AC6-1 AWB_FX 缺失时 effects.mode=off 且不谎报 particles', noFx && noFx.effects && noFx.effects.mode === 'off' && noFx.effects.particles === false && noFx.effects.fxUnavailable === true, noFx);
      check('AC6-2 菜单显示「特效层未加载」', noFx && noFx.label === '特效层未加载', noFx);
      report.summary = { total: rows.length, pass: rows.filter((r) => r.ok).length };
    } catch (e) { check('A 测量未抛错', false, String((e && e.message) || e)); }
  }
  try { fs.writeFileSync(path.join(OUT, 'fx7a3b-run.json'), JSON.stringify({ ...report, checks: rows }, null, 2) + '\n', 'utf8'); } catch { /* ignore */ }
  await close(inst);
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = rows.filter((r) => !r.ok);
  console.log('');
  console.log(`FX7A3B ${failed.length ? 'FAIL' : 'OK'} ${JSON.stringify({ total: rows.length, pass: rows.length - failed.length, red: failed.length })}`);
  console.log('证据：' + path.join(OUT, 'fx7a3b-run.json'));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FX7A3B ERROR ' + String((e && e.stack) || e)); process.exit(1); });
