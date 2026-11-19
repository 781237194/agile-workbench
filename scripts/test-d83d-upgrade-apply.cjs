#!/usr/bin/env node
'use strict';
/**
 * test-d83d-upgrade-apply.cjs —— B-20261119-133213-d83d（P0：点「立即升级」无反应）真菜单交互夹具。
 * 隔离 Electron 实例 + 本地假版本源；真实菜单路径：#btn-more → [data-more=upgrade] → [data-upgrade-check] → [data-upgrade-apply]。
 * 验收：①点立即升级 ≤1s 出现可见状态（进度/错误/重启提示）；②空 reason 不静默；③需要强制原因时输入框可见并聚焦；
 *       ④结果/错误可见（菜单内 + 全局 toast 计数自增）；⑤菜单保持展开；另含静态断言。
 * 用法：node scripts/test-d83d-upgrade-apply.cjs [--out <dir>]；只 taskkill /PID 自己 spawn 的 child.pid。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PNAME = '工作台改造修复';
const SB = path.join(ROOT, '_tmp', `d83d-${process.pid}-${Date.now()}`);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const PORT = Number(process.env.AWB_D83D_PORT || (9660 + (process.pid % 20)));
const FEED_PORT = PORT + 1;
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', PNAME, '程序员B', '产出', '证据-d83d'); })();
const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHA = crypto.createHash('sha256').update('fake-upgrade-zip-for-d83d').digest('hex');
const OUT_FILE = path.join(OUT, 'd83d-upgrade-apply-run.json');
function check(name, ok, detail) { rows.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' :: ' + String(JSON.stringify(detail)).slice(0, 500))); }
function httpJson(url) { return new Promise((resolve) => { const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.setTimeout(2000, () => { try { req.destroy(); } catch { /* ignore */ } resolve(null); }); }); }
async function waitTarget(port, ms, pick) { const end = Date.now() + ms; while (Date.now() < end) { const list = await httpJson(`http://127.0.0.1:${port}/json/list`); if (Array.isArray(list)) { const hit = list.find(pick); if (hit) return hit; } await sleep(300); } return null; }
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(String(e.data)); } catch { return; } const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); }); }
  send(method, params = {}, ms = 60000) { const id = ++this.seq; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout ' + method)); } }, ms); }); }
  async evaluate(expr, ms = 60000) { const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms); if (out && out.exceptionDetails) throw new Error('page exception: ' + String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text).slice(0, 400)); return out && out.result ? out.result.value : undefined; }
}
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
  store.projects = [project];
  store.activeProjectId = project.id;
  fs.writeFileSync(path.join(DATA, 'userdata', 'workbench.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.mkdirSync(OUT, { recursive: true });
}
function startFeed() {
  const server = http.createServer((req, res) => {
    if (req.url === '/feed-available') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ version: '2.2.0', sha256: SHA, url: 'https://example.invalid/upgrade-2.2.0.zip', notes: '夹具版本' })); return; }
    res.writeHead(404); res.end('{}');
  });
  return new Promise((resolve) => server.listen(FEED_PORT, '127.0.0.1', () => resolve(server)));
}
async function launch() {
  const env = { ...process.env, AWB_DATA_DIR: DATA, TEAM_ROOT: TEAM, TEAM_SELFTEST: '1' };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  const target = await waitTarget(PORT, 90000, (item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
  if (!target) { try { child.kill(); } catch { /* ignore */ } return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('ws fail')), { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  for (let i = 0; i < 200; i += 1) { const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(window.workbench && window.workbench.upgradeCheck)'); if (ready) break; await sleep(150); }
  return { child, cdp, ws };
}
async function close(inst) {
  if (!inst) return;
  try { inst.cdp.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ }
  await sleep(800);
  try { inst.ws.close(); } catch { /* ignore */ }
  try { if (inst.child && inst.child.pid) spawnSync('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
  try { inst.child.kill(); } catch { /* ignore */ }
}
function stateExpr() {
  return `(() => {
    const q = (s) => document.querySelector(s);
    const vis = (el) => Boolean(el && !el.hidden && String(el.textContent || '').trim());
    const p = q('[data-upgrade-progress]');
    const e = q('[data-upgrade-error]');
    const h = q('[data-upgrade-restart-hint]');
    const f = q('[data-upgrade-force]');
    const r = q('[data-upgrade-reason]');
    const box = q('[data-upgrade-menu]');
    const toast = q('#toast');
    return {
      t: performance.now(),
      progressVisible: vis(p), progressText: p ? String(p.textContent || '') : '',
      errorVisible: vis(e), errorText: e ? String(e.textContent || '') : '',
      hintVisible: vis(h), hintText: h ? String(h.textContent || '') : '',
      forceVisible: Boolean(f && !f.hidden),
      reasonFocused: Boolean(r && document.activeElement === r),
      menuOpen: Boolean(box && !box.hidden),
      toastCount: toast ? Number(toast.getAttribute('data-toast-count') || 0) : 0,
    };
  })()`;
}

(async () => {
  seed();
  const feed = await startFeed();
  const base = `http://127.0.0.1:${FEED_PORT}`;
  let inst = null;
  try {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    const fn = (() => { const i = src.indexOf('async function startUpgrade'); return i < 0 ? '' : src.slice(i, i + 4200); })();
    check('B1 startUpgrade 不再对空 reason 提前 return', Boolean(fn) && !/if\s*\(!reason\)\s*\{[^}]*paintUpgrade\(\);\s*return/.test(fn), fn.slice(0, 200));
    check('B2 force 只随 reason 传（不再写死 force:true）', /force:\s*Boolean\(reason\)/.test(fn) && !/force:\s*true/.test(fn), null);
    check('B3 点击即先给可见进度（await 之前设 progress）', /UPGRADE_UI\.progress = '正在准备升级/.test(fn) && fn.indexOf("UPGRADE_UI.progress = '正在准备升级") < fn.indexOf('await window.workbench.upgradeStart'), null);
    check('B4 错误分支同时写菜单错误并 toast', /UPGRADE_UI\.error = '升级失败：'/.test(fn) && /toast\(UPGRADE_UI\.error, 'bad'\)/.test(fn), null);
    check('B5 需要强制原因时展示并聚焦输入框', /UPGRADE_UI\.forceNeeded = true/.test(fn) && /reasonEl\.focus\(\)/.test(src), null);
    check('B6 paintUpgrade 管理 progress 与 force 行显隐', /UPGRADE_UI\.progress/.test(src) && /forceLine\.hidden = UPGRADE_UI\.forceNeeded/.test(src), null);

    inst = await launch();
    check('A0 隔离实例启动 + 升级 IPC 就绪', Boolean(inst), null);
    if (!inst) throw new Error('no instance');
    const cdp = inst.cdp;
    // 1) 真实菜单：打开 more → 升级子菜单 → 检查（本地假源）
    const pre = await cdp.evaluate(`(async () => {
      window.__awbUpgradeFeedSource = ${JSON.stringify(base)} + '/feed-available';
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const more = document.querySelector('#btn-more'); if (more) more.click(); await sleep(150);
      const row = document.querySelector('[data-more="upgrade"]'); if (row) row.click(); await sleep(150);
      const checkBtn = document.querySelector('[data-upgrade-check]'); if (checkBtn) checkBtn.click();
      for (let i = 0; i < 120; i += 1) { const a = document.querySelector('[data-upgrade-apply]'); if (a && !a.hidden) return { applyVisible: true }; await sleep(100); }
      return { applyVisible: false };
    })()`);
    check('A1 真实菜单路径可达「立即升级」（检查到新版本）', Boolean(pre && pre.applyVisible === true), pre);
    // 2) 空 reason 点立即升级：页内 MutationObserver 记录「首次可见反馈」相对点击的耗时（≤1s）
    const auditFile = path.join(TEAM, '状态', '项目', PNAME, '通知审计.jsonl');
    const auditLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
    const auditBefore = auditLines(auditFile);
    await cdp.evaluate(`(() => {
      const seen = {};
      window.__d83dFirst = seen;
      const t0 = performance.now();
      window.__d83dT0 = t0;
      const pick = (sel, name) => {
        const el = document.querySelector(sel);
        if (!el || el.hidden) return;
        if (!String(el.textContent || '').trim()) return;
        if (seen[name] == null) seen[name] = Math.round(performance.now());
      };
      const scan = () => { pick('[data-upgrade-progress]', 'progress'); pick('[data-upgrade-error]', 'error'); pick('[data-upgrade-restart-hint]', 'hint'); };
      const obs = new MutationObserver(scan);
      obs.observe(document.querySelector('#more-menu') || document.body, { subtree: true, attributes: true, childList: true, characterData: true });
      window.__d83dObs = obs;
      scan();
      const a = document.querySelector('[data-upgrade-apply]');
      if (a) a.click();
      return true;
    })()`);
    await sleep(1200);
    const first = await cdp.evaluate(`(() => { const s = window.__d83dFirst || {}; const t0 = window.__d83dT0 || performance.now(); const adj = (v) => (typeof v === 'number' ? Math.round(v - t0) : null); return { progress: adj(s.progress), error: adj(s.error), hint: adj(s.hint) }; })()`);
    const firstT = Math.min(...[first.progress, first.error, first.hint].filter((v) => typeof v === 'number' && Number.isFinite(v)));
    check('A2 点「立即升级」≤1s 出现可见状态（进度/错误/重启提示）', Number.isFinite(firstT) && firstT <= 1000, first);
    // 3) 等升级完成（沙盘 dry-run，安装器最多几十秒）
    let final = null;
    for (let i = 0; i < 120; i += 1) {
      final = await cdp.evaluate(stateExpr());
      if (final.hintVisible || final.errorVisible) break;
      await sleep(250);
    }
    if (!final) final = await cdp.evaluate(stateExpr());
    const auditAfter = auditLines(auditFile);
    check('A3 空 reason 不静默（有可见进度/错误/结果之一）', Boolean(final.progressVisible || final.errorVisible || final.hintVisible), { progress: final.progressText, error: final.errorText, hint: final.hintText });
    const conclusion = final.hintVisible ? 'success' : (final.errorVisible ? 'readable-error' : (final.progressVisible ? 'in-progress' : 'silent'));
    check('A4 结论可归因（success / readable-error / in-progress）', conclusion !== 'silent', { conclusion, hint: final.hintText, error: final.errorText, progress: final.progressText });
    check('A5 全局 toast 有反馈（沙盘 toast 落通知审计行，计行数增量）', auditAfter > auditBefore, { auditBefore, auditAfter });
    check('A6 真菜单交互后子菜单保持展开', final.menuOpen === true, { menuOpen: final.menuOpen });
    check('A7 无强制场景不展示强制原因输入框（或需要时已聚焦）', final.forceVisible === false || final.reasonFocused === true, { forceVisible: final.forceVisible, reasonFocused: final.reasonFocused });
    fs.writeFileSync(OUT_FILE, JSON.stringify({ at: new Date().toISOString(), feed: base, sha256: SHA, conclusion, first, final, checks: rows }, null, 2) + '\n', 'utf8');
  } catch (e) {
    check('运行未抛错', false, String((e && e.stack) || e).slice(0, 600));
  } finally {
    await close(inst);
    try { feed.close(); } catch { /* ignore */ }
    try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(OUT_FILE)) fs.writeFileSync(OUT_FILE, JSON.stringify({ at: new Date().toISOString(), checks: rows }, null, 2) + '\n', 'utf8');
  const failed = rows.filter((r) => !r.ok);
  console.log('\nD83D-UPGRADE-APPLY ' + (failed.length ? 'FAIL' : 'OK') + ' ' + JSON.stringify({ total: rows.length, pass: rows.length - failed.length, red: failed.length }));
  console.log('证据：' + OUT_FILE);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('D83D ERROR ' + String((e && e.stack) || e)); process.exit(1); });
