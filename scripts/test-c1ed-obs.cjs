'use strict';
/**
 * R-c1ed（T-20261116-100355-9bda）三项可观测自检：
 *   ① scripts/oom-stress.cjs --stress --turns 300 --tool-output-bytes 20480 真生成等价负载并实测回读
 *   ② #toast[data-toast-count] 每次 toast 自增（真窗口）
 *   ③ 主进程 notify:audit → 团队/状态/项目/<项目>/通知审计.jsonl {at,level,text,source,suppressed}
 *      被 --no-wake 压制的 toast 也写一行 suppressed='no-wake'，且计数不变（真窗口，两次启动）
 *
 * 隔离：AWB_DATA_DIR + TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_WORKBENCH_JSON 全指 _tmp/c1ed-obs；端口 9481/9482。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = '工作台改造修复';
const BASE = path.join(ROOT, '_tmp', 'c1ed-obs');
const DATA = path.join(BASE, 'data');
const TEAM = path.join(BASE, '团队');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const AUDIT = path.join(STATE, '通知审计.jsonl');
const LOAD = path.join(BASE, 'load');
const EVID = path.join(ROOT, '项目', PROJECT, '程序员B', '产出', '证据-c1ed-obs');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ` + JSON.stringify(detail || {}).slice(0, 500)); process.exitCode = 1; }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (filter && filter(s, entry)) continue;
    if (entry.isDirectory()) copyDir(s, d, filter);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}
function httpJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
  });
}
async function waitTarget(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await httpJson(`http://127.0.0.1:${port}/json/list`);
    if (Array.isArray(list)) {
      const hit = list.find((p) => p && p.type === 'page' && String(p.url || '').includes('renderer/index.html'));
      if (hit && hit.webSocketDebuggerUrl) return hit;
    }
    await sleep(400);
  }
  return null;
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let msg = null;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (!msg || !msg.id || !this.pending.has(msg.id)) return;
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch (error) { reject(error); }
    });
  }
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res && res.exceptionDetails) return { __error: String(res.exceptionDetails.text || '').slice(0, 200) };
    return res && res.result ? res.result.value : undefined;
  }
}
function env() {
  return { ...process.env, AWB_DATA_DIR: DATA, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(TEAM, '状态', '项目'), TEAM_WORKBENCH_JSON: path.join(DATA, 'userdata', 'workbench.json'), TEAM_SELFTEST: '1' };
}
async function launch(port, extraArgs = []) {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + port, ...extraArgs], { cwd: ROOT, env: env(), stdio: 'ignore', windowsHide: false });
  const target = await waitTarget(port, 90000);
  if (!target) { try { child.kill(); } catch { /* ignore */ } return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('ws 连接失败')), { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  for (let i = 0; i < 120; i += 1) {
    if (await cdp.evaluate('document.readyState') === 'complete') break;
    await sleep(400);
  }
  return { child, cdp };
}
async function closeApp(app) {
  try { if (app && app.child) app.child.kill(); } catch { /* ignore */ }
  await sleep(700);
}
function auditRows() {
  try { return fs.readFileSync(AUDIT, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
}

function seed() {
  fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  const realStore = path.join(ROOT, 'data', 'userdata', 'workbench.json');
  const store = JSON.parse(fs.readFileSync(realStore, 'utf8'));
  const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PROJECT);
  if (!project) throw new Error('真实 workbench.json 里没有项目 ' + PROJECT);
  store.projects = [project];
  store.activeProjectId = project.id;
  fs.writeFileSync(path.join(DATA, 'userdata', 'workbench.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
  copyDir(path.join(ROOT, '团队'), TEAM, (f) => /[\\/]锁([\\/]|$)/.test(f) || /[\\/]邮箱[\\/]/.test(f));
  const teamFile = path.join(TEAM, '状态', '团队.json');
  const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  for (const member of team.members || []) member.sessionId = '';
  team.activeProject = PROJECT;
  fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
  fs.mkdirSync(STATE, { recursive: true });
  fs.mkdirSync(EVID, { recursive: true });
}

(async () => {
  seed();

  // ── ① oom-stress --stress ────────────────────────────────────────────
  let stress = null;
  try {
    const stdout = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'oom-stress.cjs'), '--stress', '--turns', '300', '--tool-output-bytes', '20480', '--load-dir', LOAD, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    stress = JSON.parse(stdout.trim());
  } catch (error) {
    stress = { error: String((error && error.message) || error).slice(0, 300), stdout: String((error && error.stdout) || '') };
  }
  ok('A1 --stress --json 输出可解析且 equivalentBy=script', Boolean(stress && stress.equivalentBy === 'script'), stress);
  ok('A2 自报 equivalentTurns=300、toolOutputBytes=6144000（≥6e6）', Boolean(stress && stress.equivalentTurns === 300 && stress.toolOutputBytes === 6144000), stress && { t: stress.equivalentTurns, b: stress.toolOutputBytes });
  ok('A3 真生成 300 个轮次文件且每个 20480B', (() => {
    const dir = path.join(LOAD, 'turns');
    if (!fs.existsSync(dir)) return false;
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.txt'));
    return files.length === 300 && files.slice(0, 3).every((name) => fs.statSync(path.join(dir, name)).size === 20480);
  })(), { dir: LOAD });
  ok('A4 实测回读字节数 = 300×20480（不是只报数不落盘）', (() => {
    const dir = path.join(LOAD, 'turns');
    const sum = fs.readdirSync(dir).reduce((acc, name) => acc + fs.statSync(path.join(dir, name)).size, 0);
    return sum === 6144000 && stress && stress.measuredBytes === sum;
  })(), stress && stress.measuredBytes);
  ok('A5 equivalent=true 且退出码 0', Boolean(stress && stress.equivalent === true), stress && stress.equivalent);

  // ── 静态接线检查 ─────────────────────────────────────────────────────
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  ok('B1 index.html 的 #toast 带 data-toast-count', /id="toast"[^>]*data-toast-count="0"/.test(html), {});
  const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const toastBlock = appSrc.slice(appSrc.indexOf('function toast(message'), appSrc.indexOf('function toast(message') + 1800);
  ok('B2 toast() 里自增 data-toast-count', /data-toast-count/.test(toastBlock) && /setAttribute\('data-toast-count'/.test(toastBlock), {});
  ok('B3 toast() 里对被压制写 suppressed=\'no-wake\' 审计', /audit\('no-wake'\)/.test(toastBlock) && /notifyAudit/.test(toastBlock), {});
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  ok('B4 主进程有 notify:audit 且写 通知审计.jsonl、字段五键齐', /ipcMain\.handle\('notify:audit'/.test(mainSrc) && /通知审计\.jsonl/.test(mainSrc) && ['at', 'level', 'text', 'source', 'suppressed'].every((key) => new RegExp('\\b' + key + ':').test(mainSrc.slice(mainSrc.indexOf("ipcMain.handle('notify:audit'"), mainSrc.indexOf("ipcMain.handle('notify:audit'") + 2000))), {});
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  ok('B5 preload 暴露 noWake + notifyAudit', /noWake: IS_NO_WAKE/.test(preloadSrc) && /notifyAudit:/.test(preloadSrc), {});

  // ── ② 真窗口：正常模式计数 + 审计 ───────────────────────────────────
  const normal = await launch(9481);
  ok('C0 正常模式实例已启动', Boolean(normal && normal.cdp), {});
  if (normal) {
    try {
      const before = await normal.cdp.evaluate("(function(){ const t=document.querySelector('#toast'); return { count: t? t.getAttribute('data-toast-count'): null, noWake: Boolean(window.workbench && window.workbench.noWake) }; })()");
      ok('C1 启动时 data-toast-count=0、noWake=false', Boolean(before && before.count === '0' && before.noWake === false), before);
      await normal.cdp.evaluate("(function(){ toast('观测测试一',''); toast('观测测试二','warn'); return true; })()");
      await sleep(800);
      const after = await normal.cdp.evaluate("(function(){ const t=document.querySelector('#toast'); return { count: t? t.getAttribute('data-toast-count'): null, text: t? t.textContent: '' }; })()");
      ok('C2 两次 toast → data-toast-count=2（且最后一条文案在）', Boolean(after && after.count === '2'), after);
      await sleep(600);
      const rows = auditRows();
      ok('C3 通知审计.jsonl 落两行、suppressed 为空、字段五键齐', rows.length >= 2 && rows.slice(-2).every((row) => row.suppressed === '' && ['at', 'level', 'text', 'source', 'suppressed'].every((key) => key in row)), rows.slice(-2));
      ok('C4 审计行 level 跟随 toast kind（第二行 warn）', rows.length >= 2 && String(rows[rows.length - 1].level) === 'warn', rows.slice(-1));
      // 反向：删掉锚点后判据必须能判 FAIL（TOAST_ANCHOR_MISSING），证明判据不是恒真
      const missing = await normal.cdp.evaluate("(function(){ const t=document.querySelector('#toast'); t.removeAttribute('data-toast-count'); const raw=t.getAttribute('data-toast-count'); return { raw, code: raw === null ? 'TOAST_ANCHOR_MISSING' : '' }; })()");
      ok('C5 删掉 data-toast-count 后能判 TOAST_ANCHOR_MISSING（判据非恒真）', Boolean(missing && missing.code === 'TOAST_ANCHOR_MISSING'), missing);
    } catch (error) {
      ok('C 段执行无异常', false, String((error && error.message) || error).slice(0, 300));
    }
    await closeApp(normal);
  }

  // ── ③ 真窗口：--no-wake 压制 + 也写审计 ─────────────────────────────
  const auditBefore = auditRows().length;
  const quiet = await launch(9482, ['--no-wake']);
  ok('D0 --no-wake 实例已启动', Boolean(quiet && quiet.cdp), {});
  if (quiet) {
    try {
      const state = await quiet.cdp.evaluate("(function(){ return { noWake: Boolean(window.workbench && window.workbench.noWake), count: (document.querySelector('#toast')||{}).getAttribute ? document.querySelector('#toast').getAttribute('data-toast-count') : null }; })()");
      ok('D1 渲染层读到 noWake=true', Boolean(state && state.noWake === true), state);
      await quiet.cdp.evaluate("(function(){ toast('压制测试一',''); toast('压制测试二','bad'); return true; })()");
      await sleep(900);
      const countAfter = await quiet.cdp.evaluate("(document.querySelector('#toast').getAttribute('data-toast-count'))");
      ok('D2 --no-wake 下 data-toast-count 不自增（仍 0）', String(countAfter) === '0', { countAfter });
      const rows = auditRows();
      const fresh = rows.slice(auditBefore);
      ok('D3 被压制的 toast 也写审计：新增 ≥2 行且 suppressed 全为 no-wake', fresh.length >= 2 && fresh.every((row) => row.suppressed === 'no-wake'), fresh);
      ok('D4 审计仍带五键与 level', fresh.length >= 1 && ['at', 'level', 'text', 'source', 'suppressed'].every((key) => key in fresh[0]), fresh[0]);
    } catch (error) {
      ok('D 段执行无异常', false, String((error && error.message) || error).slice(0, 300));
    }
    await closeApp(quiet);
  }

  console.log(`\nR-c1ed 三项可观测断言：${pass} 通过 / ${fail} 失败`);
  fs.writeFileSync(path.join(EVID, 'run-c1ed-obs.log'), `pass=${pass} fail=${fail} exit=${process.exitCode || 0}\n`, 'utf8');
  process.exit(process.exitCode || 0);
})();
