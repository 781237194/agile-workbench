'use strict';
/**
 * T-171008：净树单实例跑 10 分钟 longtask 归因（不调用 __fxOverlayProbe，避免 getImageData 自造长任务）。
 * 只启动自建 Electron 子进程，结束只 taskkill /PID 自己 child.pid。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const BASE = path.join(ROOT, '_tmp', 'e31b-after-' + process.pid + '-' + Date.now());
const DATA = path.join(BASE, 'data');
const TEAM = path.join(BASE, '团队');
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const OUT = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-171008-20261122', 'after-' + STAMP);
const PORT = 9860 + (process.pid % 80);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJson = (url) => new Promise((resolve, reject) => { const req = http.get(url, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('timeout'))); });
async function waitPage(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const list = await httpJson('http://127.0.0.1:' + PORT + '/json/list');
      const page = (list || []).find((t) => t.type === 'page' && /index\.html/i.test(String(t.url || '')));
      if (page) return page;
    } catch { /* wait */ }
    await sleep(500);
  }
  return null;
}
fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
fs.mkdirSync(path.join(BASE, 'userdata'), { recursive: true });
fs.copyFileSync(path.join(ROOT, '团队', '状态', '团队.json'), path.join(TEAM, '状态', '团队.json'));
fs.copyFileSync(path.join(ROOT, 'data', 'userdata', 'workbench.json'), STORE);
fs.mkdirSync(OUT, { recursive: true });
const env = {
  ...process.env,
  AWB_DATA_DIR: DATA, AWB_STORE: STORE, TEAM_WORKBENCH_JSON: STORE,
  TEAM_ROOT: TEAM, AWB_TEAM_ROOT: process.env.AWB_TEAM_ROOT || path.join(ROOT, '团队'),
  TEAM_SELFTEST: '1', AWB_SHOW_INACTIVE: '1',
  DSH_WEB_URL: 'http://127.0.0.1:1',
};
delete env.AWB_FX_OVERLAY_TEST;
delete env.AWB_FX_OVERLAY_FORCE_VISIBLE;
delete env.DSH_SESSION_ID;
const appLog = path.join(OUT, 'app.log');
const logFd = fs.openSync(appLog, 'a');
const child = spawn(process.execPath, [
  path.join(ROOT, 'scripts', 'run-electron.cjs'), '.',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + path.join(BASE, 'userdata'),
], { cwd: ROOT, env, stdio: ['ignore', logFd, logFd], windowsHide: false });
(async () => {
  let exitCode = 1;
  try {
    const page = await waitPage(120000);
    if (!page) throw new Error('no renderer page on port ' + PORT);
    console.log('APP_READY ' + JSON.stringify({ pid: child.pid, port: PORT, url: page.url }));
    // 与 tester v5 同口径：等启动预热结束（其窗口在 instanceStart 后 30s 才开始）再装探针。
    await sleep(30000);
    const profiler = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'e31b-slow-callback.cjs'),
      '--port', String(PORT), '--minutes', '10', '--out', OUT,
    ], { cwd: ROOT, env, stdio: 'inherit', windowsHide: false });
    const code = await new Promise((resolve) => profiler.on('exit', (c) => resolve(Number(c) || 0)));
    console.log('PROFILER_EXIT ' + code + ' OUT ' + OUT);
    exitCode = code;
  } catch (error) {
    console.error('RUN_FAILED ' + String((error && error.message) || error));
    exitCode = 1;
  } finally {
    try { fs.closeSync(logFd); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
    await sleep(500);
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(exitCode);
  }
})();
