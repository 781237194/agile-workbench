'use strict';
/**
 * test-c437-repro.cjs —— B-20261118-191527-c437 复现：隔离实例 + 真实 DSH webview，跑 6 分钟，
 * 记录「谁关的窗」（[win-close]/[win-closed] 堆栈）、window-all-closed、render/child-process-gone、
 * webview 目标消失时刻、进程数/内存；产出 JSONL + stdout。
 *
 * 用法：node scripts/test-c437-repro.cjs [--seconds 380] [--out <dir>]
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, '项目', '工作台改造修复');
const PNAME = '工作台改造修复';
const SB = path.join(ROOT, '_tmp', `c437-${process.pid}-${Date.now()}`);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const REAL_TEAM_JSON = path.join(ROOT, '团队', '状态', '团队.json');
const PORT = Number(process.env.AWB_C437_PORT || (9520 + (process.pid % 20)));
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(PROJ, '程序员B', '产出', '证据-c437'); })();
const SECONDS = (() => { const i = process.argv.indexOf('--seconds'); return i > 0 && Number(process.argv[i + 1]) > 30 ? Number(process.argv[i + 1]) : 380; })();
const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function httpJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}
function append(row) {
  rows.push(row);
  try { fs.appendFileSync(path.join(OUT, 'repro.jsonl'), JSON.stringify(row) + '\n', 'utf8'); } catch { /* ignore */ }
  console.log('ROW ' + JSON.stringify(row).slice(0, 300));
}
function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态', '项目', PNAME), { recursive: true });
  for (const name of ['团队宪法.md', '项目铁律.md']) { try { fs.copyFileSync(path.join(ROOT, '团队', name), path.join(TEAM, name)); } catch { /* ignore */ } }
  const team = JSON.parse(fs.readFileSync(REAL_TEAM_JSON, 'utf8').replace(/^\uFEFF/, ''));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = PNAME;
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  const store = JSON.parse(fs.readFileSync(REAL_STORE, 'utf8').replace(/^\uFEFF/, ''));
  const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PNAME);
  if (!project) throw new Error('workbench 缺项目');
  store.projects = [project];
  store.activeProjectId = project.id;
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.mkdirSync(OUT, { recursive: true });
}
function procsOf(pid) {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} -or $_.ProcessId -eq ${pid} } | Select-Object ProcessId,Name,ParentProcessId | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const txt = String(r.stdout || '').trim();
    if (!txt) return { count: 0, names: [] };
    const list = JSON.parse(txt);
    const arr = Array.isArray(list) ? list : [list];
    return { count: arr.length, names: arr.map((x) => x.Name) };
  } catch { return { count: null, names: [] }; }
}
(async () => {
  seed();
  fs.writeFileSync(path.join(OUT, 'stdout.log'), '', 'utf8');
  const env = { ...process.env, AWB_DATA_DIR: DATA, TEAM_ROOT: TEAM, TEAM_SELFTEST: '1' };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  const onLine = (buf) => {
    const text = String(buf || '');
    fs.appendFileSync(path.join(OUT, 'stdout.log'), text, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (/win-close|win-closed|window-all-closed|child-process-gone|render-process-gone|crash|shell-|Utility/.test(line)) {
        append({ at: new Date().toISOString(), kind: 'stdout', line: line.slice(0, 600) });
      }
    }
  };
  child.stdout.on('data', onLine);
  child.stderr.on('data', onLine);
  append({ at: new Date().toISOString(), kind: 'start', pid: child.pid, port: PORT, seconds: SECONDS });
  const t0 = Date.now();
  let webviewSeen = false;
  let webviewGoneAt = null;
  for (let i = 0; Date.now() - t0 < SECONDS * 1000; i += 1) {
    await sleep(5000);
    const alive = child.exitCode === null;
    const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
    const targets = Array.isArray(list) ? list : [];
    const wv = targets.find((t) => t && t.type === 'webview');
    const page = targets.find((t) => t && t.type === 'page' && String(t.url || '').includes('renderer/index.html'));
    if (wv) webviewSeen = true;
    if (webviewSeen && !wv && webviewGoneAt === null) webviewGoneAt = Math.round((Date.now() - t0) / 1000);
    const procs = procsOf(child.pid);
    append({
      at: new Date().toISOString(), kind: 'sample', sec: Math.round((Date.now() - t0) / 1000),
      alive, exitCode: child.exitCode, targets: targets.length, webview: wv ? String(wv.url || '').slice(0, 60) : null,
      webviewGoneSec: webviewGoneAt, page: Boolean(page), procs: procs.count, names: procs.names.slice(0, 8),
    });
    if (!alive && i > 1) break;
  }
  const aliveEnd = child.exitCode === null;
  if (aliveEnd) {
    try { child.kill(); } catch { /* ignore */ }
  }
  append({ at: new Date().toISOString(), kind: 'summary', aliveEnd, exitCode: child.exitCode, webviewSeen, webviewGoneSec: webviewGoneAt, seconds: Math.round((Date.now() - t0) / 1000) });
  try {
    if (child.pid && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch { /* ignore */ }
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log('C437_REPRO_DONE ' + JSON.stringify({ rows: rows.length, aliveEnd, webviewGoneSec: webviewGoneAt, out: OUT }));
})().catch((e) => { console.error('C437_REPRO_ERROR ' + String((e && e.stack) || e)); process.exit(1); });
