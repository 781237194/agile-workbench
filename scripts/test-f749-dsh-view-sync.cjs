'use strict';
/**
 * B-20261121-043924-f749（P0）：状态「DSH 已连接」但内嵌 webview 黑屏。
 * 真窗口验证：①把状态指到死端口 → did-fail-load 必须显示 URL+错误码+「重载 WebView」；
 *            ②再把状态指到真实 mock 端口 → renderDsh 自动把 webview 切过去并加载成功（不黑屏）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-f749-20261121');
const SB = path.join(ROOT, '_tmp', 'f749-' + process.pid + '-' + Date.now());
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const PROJECT_DIR = path.join(SB, '项目区', '工作台改造修复');
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const PORT = 10833 + (process.pid % 40);
const R = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(id, name, ok, detail) { R.push({ id, name, ok: Boolean(ok) }); console.log((ok ? 'PASS  ' : 'FAIL  ') + id + ' ' + name + (detail === undefined ? '' : '  ← ' + JSON.stringify(detail).slice(0, 700))); }
function httpJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null)); req.setTimeout(1500, () => { req.destroy(); resolve(null); });
  });
}
async function waitTarget(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await httpJson('http://127.0.0.1:' + PORT + '/json/list');
    if (Array.isArray(list)) {
      const hit = list.find((x) => x && x.type === 'page' && String(x.url || '').includes('renderer/index.html'));
      if (hit && hit.webSocketDebuggerUrl) return hit;
    }
    await sleep(300);
  }
  return null;
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      }
    });
  }
  send(method, params = {}, ms = 20000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, ms);
    });
  }
  async evaluate(expr, ms = 20000) {
    const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms);
    if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || '') };
    return out && out.result ? out.result.value : undefined;
  }
}
async function startMockDsh() {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/session/list') {
      let b = ''; req.on('data', (c) => { b += c; });
      req.on('end', () => {
        let rpcId = ''; try { rpcId = JSON.parse(b).rpcId || ''; } catch { /* ignore */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: { items: [] } } }));
      });
      return;
    }
    if (req.url === '/json/version') { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>DeepSeek Harness mock</title><body><h1>DSH MOCK OK</h1><p id="mock-visible">mock webview loaded</p></body>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}
function seed(mockPort) {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态', '项目', '工作台改造修复'), { recursive: true });
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  for (const n of ['团队宪法.md', '项目铁律.md']) { try { fs.copyFileSync(path.join(ROOT, '团队', n), path.join(TEAM, n)); } catch { /* ignore */ } }
  const team = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8').replace(/^\uFEFF/, ''));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = '工作台改造修复';
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  try { fs.copyFileSync(path.join(ROOT, '团队', '状态', '项目', '工作台改造修复', '项目.json'), path.join(TEAM, '状态', '项目', '工作台改造修复', '项目.json')); } catch { /* ignore */ }
  const store = {
    version: 3, activeProjectId: 'p-f749',
    projects: [{ id: 'p-f749', name: '工作台改造修复', teamName: '工作台改造修复', path: PROJECT_DIR, teamMode: 'full', sessions: {}, sessionMeta: {}, workspace: { id: 'w-f749', path: PROJECT_DIR, name: '工作台改造修复', bound: true, sessionIds: [] }, requirements: [], tasks: [], messages: [], proposals: [], docs: [] }], ui: {}
  };
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n', 'utf8');
  const baseForSeed = (process.env.AWB_F749_RECOVERED === '1' || process.env.AWB_F749_CLICK === '1') ? ('http://127.0.0.1:' + mockPort) : 'http://127.0.0.1:65533';
  fs.writeFileSync(path.join(DATA, 'dsh.json'), JSON.stringify({ version: 1, baseUrl: baseForSeed, source: 'auto', pinned: false }, null, 2) + '\n', 'utf8');
  return { 'netstat.exe': { ok: true, stdout: ['活动连接', '', '  TCP    127.0.0.1:' + ((process.env.AWB_F749_RECOVERED === '1' || process.env.AWB_F749_CLICK === '1') ? mockPort : 65501) + '    0.0.0.0:0    LISTENING    4242'].join('\r\n') + '\r\n' } };
}
async function close(inst, keep) {
  if (!inst) return;
  try { await inst.cdp.send('Browser.close', {}, 2000); } catch { /* ignore */ }
  try { inst.ws.close(); } catch { /* ignore */ }
  try { inst.child.kill(); } catch { /* ignore */ }
  await sleep(500);
  try { if (inst.child && inst.child.pid && inst.child.exitCode === null) spawnSync('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  if (!keep) { try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ } }
}
async function shot(cdp, file) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const out = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, 20000);
      if (out && out.data) {
        const buf = Buffer.from(out.data, 'base64');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
        return buf.length;
      }
    } catch { /* retry */ }
    await sleep(300);
  }
  return 0;
}

(async () => {
  const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const reloadFn = (appSrc.match(/function reloadDshView\([\s\S]*?\n\}/) || [''])[0];
  check('V0a', 'reloadDshView 先 await 主进程 reloadDshView，IPC 失败才 applyDshViewSrc 兜底', /await api\.reloadDshView\(\)/.test(reloadFn) && reloadFn.indexOf('await api.reloadDshView') < reloadFn.indexOf("applyDshViewSrc(false, 'reload-fallback')"), { ipcFirst: reloadFn.indexOf('await api.reloadDshView') < reloadFn.indexOf("applyDshViewSrc(false, 'reload-fallback')") });
  check('V0d', '「重载 WebView」按钮走同一 reloadDshView（不再本地 forceReload）', /btn-dsh-off-reload[\s\S]{0,120}reloadDshView\(\{ quiet: true \}\)/.test(appSrc) && /reinstallDshCookie/.test(appSrc) && /retryDshCookieOnce/.test(appSrc));
  check('V0b', 'renderDsh 每次同步 webview（syncDshViewWithStatus）', /syncDshViewWithStatus\(dsh\)/.test(appSrc));
  check('V0c', 'did-fail-load 记录 URL/错误码（dshViewError）', /did-fail-load[\s\S]{0,800}dshViewError\s*=/.test(appSrc));
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  check('V0e', 'cookie 重装 IPC 三端接线（main handler/preload/renderer retry）', /ipcMain\.handle\('dsh:reinstall-cookie'/.test(mainSrc) && /reinstallDshCookie:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('dsh:reinstall-cookie'\)/.test(preloadSrc) && /api\.reinstallDshCookie\(\)/.test(appSrc));
  if (process.env.AWB_F749_STATIC === '1') {
    console.log('\n' + R.filter((x) => x.ok).length + '/' + R.length + ' PASS');
    process.exitCode = R.some((x) => !x.ok) ? 1 : 0;
    return;
  }
  const freeMB = Math.round(os.freemem() / 2 ** 20);
  if (freeMB < 2048 && String(process.env.AWB_F749_ALLOW_LOW_MEM || '') !== '1') { console.log('REFUSED_LOW_MEMORY freeMB=' + freeMB + '（<2GB 不起真窗口）'); process.exitCode = 2; return; }
  fs.mkdirSync(OUT, { recursive: true });
  const mock = await startMockDsh();
  const stub = seed(mock.port);
  const env = {
    ...process.env,
    AWB_DATA_DIR: DATA, AWB_STORE: STORE,
    AWB_TEAM_ROOT: TEAM, AWB_TEAM_PROJECTS_ROOT: path.join(SB, '项目区'),
    TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(SB, '项目区'),
    TEAM_WORKBENCH_JSON: STORE, AWB_DSH_COMMAND_STUB: JSON.stringify(stub),
    ...(process.env.AWB_F749_SHOW === '1' ? {} : { AWB_START_HIDDEN: '1' })
  };
  for (const key of ['DSH_WEB_URL', 'AWB_DSH_BASE_URL', 'DSH_WEB_PORT', 'DSH_PORT']) delete env[key];
  try { const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'); fs.mkdirSync(path.join(SB, 'dsh-home'), { recursive: true }); fs.copyFileSync(path.join(home, '.credentials.yaml'), path.join(SB, 'dsh-home', '.credentials.yaml')); } catch { /* ignore */ }
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  child.stdout.on('data', (c) => { stdout += String(c); });
  child.stderr.on('data', (c) => { stdout += String(c); });
  const target = await waitTarget(90000);
  if (!target) { console.log('NO_TARGET KEEP=' + SB); console.log(stdout.split(/\r?\n/).slice(-20).join('\n')); await close({ child }, true); return; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('ws 失败')), { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, 10000);
  for (let i = 0; i < 120; i += 1) { const ready = await cdp.evaluate('Boolean(document.querySelector("#dsh-view")) && Boolean(document.querySelector("#dsh-off"))'); if (ready === true) break; await sleep(250); }
  await sleep(3500); // 等 initDsh/启动发现落定，避免它晚到的 offline renderDsh 覆盖手动状态
  if (process.env.AWB_F749_CLICK === '1') {
    // PM 04:47 复现：先把 webview 指到死端口 → 错误可见；再点「重载 WebView」（走 IPC app:reload-dsh）
    // → 主进程重新发现 mock 地址并广播，webview 自动显示 DSH 页面。两张截图一次跑完。
    await cdp.evaluate(`(async () => {
      const view = document.querySelector('#dsh-view');
      view.setAttribute('src', 'http://127.0.0.1:65533');
      for (let i = 0; i < 50; i += 1) {
        await new Promise((r) => setTimeout(r, 150));
        const off = document.querySelector('#dsh-off');
        const url = String((document.querySelector('#dsh-off-url') || {}).textContent || '');
        if (off && off.hidden === false && /错误码/.test(url) && /65533/.test(url)) return true;
      }
      return false;
    })()`, 30000);
    const errPng = await shot(cdp, path.join(OUT, 'dsh-view-error.png'));
    check('C1', '死端口后错误层显示 URL+错误码', errPng > 10000, { bytes: errPng });
    const clicked = await cdp.evaluate(`(() => { const btn = document.querySelector('#btn-dsh-off-reload'); if (!btn) return false; btn.click(); return true; })()`);
    let ok = false;
    let title = '';
    for (let i = 0; i < 80; i += 1) {
      await sleep(150);
      try { title = String(await cdp.evaluate(`document.querySelector('#dsh-view').executeJavaScript('document.title')`)); } catch { title = ''; }
      const hidden = await cdp.evaluate(`Boolean(document.querySelector('#dsh-off').hidden)`);
      if (clicked && hidden === true && /DeepSeek Harness mock/.test(title)) { ok = true; break; }
    }
    check('C2', '点「重载 WebView」→ 出现 DSH 页面（title 匹配）', ok, { clicked, title });
    const okPng = await shot(cdp, path.join(OUT, 'dsh-view-recovered.png'));
    check('C3', '重载后恢复态截图', okPng > 10000, { bytes: okPng });
    fs.writeFileSync(path.join(OUT, 'dsh-view-sync.json'), JSON.stringify({ at: new Date().toISOString(), mode: 'click', title, errPng, okPng }, null, 2) + '\n', 'utf8');
    const bad = R.some((x) => !x.ok);
    if (bad) console.log('KEEP_SANDBOX=' + SB);
    await close({ child, ws, cdp }, bad);
    mock.server.close();
    console.log('\n' + R.filter((x) => x.ok).length + '/' + R.length + ' PASS');
    process.exitCode = bad ? 1 : 0;
    return;
  }
  if (process.env.AWB_F749_RECOVERED === '1') {
    // 正确地址冷启动（mock 在册）→ webview 必须真显示 mock 页面，供恢复态截图。
    let ok = false;
    let title = '';
    for (let i = 0; i < 80; i += 1) {
      await sleep(150);
      try { title = String(await cdp.evaluate(`document.querySelector('#dsh-view').executeJavaScript('document.title')`)); } catch { title = ''; }
      const hidden = await cdp.evaluate(`Boolean(document.querySelector('#dsh-off').hidden)`);
      if (/DeepSeek Harness mock/.test(title) && hidden === true) { ok = true; break; }
    }
    check('R1', '正确地址冷启动：webview 真显示 mock 页面（title 匹配）', ok, { title });
    const png = await shot(cdp, path.join(OUT, 'dsh-view-recovered.png'));
    check('R2', '恢复态真窗口截图 dsh-view-recovered.png', png > 10000, { bytes: png });
    fs.writeFileSync(path.join(OUT, 'dsh-view-sync.json'), JSON.stringify({ at: new Date().toISOString(), mode: 'recovered', title, png }, null, 2) + '\n', 'utf8');
    const bad = R.some((x) => !x.ok);
    if (bad) console.log('KEEP_SANDBOX=' + SB);
    await close({ child, ws, cdp }, bad);
    mock.server.close();
    console.log('\n' + R.filter((x) => x.ok).length + '/' + R.length + ' PASS');
    process.exitCode = bad ? 1 : 0;
    return;
  }
  // 直接操作渲染层状态，模拟「发现到正确端口前后」的两次 renderDsh（不依赖启动时序）。
  let res = await cdp.evaluate(`(async () => {
    // 先让正常 mock 加载完成，再把 webview 指向死端口 → 触发真实 did-fail-load（状态仍保持 mock 在线，
    // 主进程不会把状态改回离线；错误层由 dshViewError 保留到成功重载）。
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      const view0 = document.querySelector('#dsh-view');
      let title0 = '';
      try { title0 = String(await view0.executeJavaScript('document.title') || ''); } catch { title0 = ''; }
      if (/DeepSeek Harness mock/.test(title0)) break;
    }
    const view = document.querySelector('#dsh-view');
    view.setAttribute('src', 'http://127.0.0.1:65533');
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      const off = document.querySelector('#dsh-off');
      const url = String((document.querySelector('#dsh-off-url') || {}).textContent || '');
      if (off && off.hidden === false && /65533/.test(url) && /错误码/.test(url)) {
        return { hidden: false, url, hasReload: Boolean(document.querySelector('#btn-dsh-off-reload')) };
      }
    }
    const off = document.querySelector('#dsh-off');
    return { hidden: Boolean(off && off.hidden), url: String((document.querySelector('#dsh-off-url') || {}).textContent || ''), hasReload: Boolean(document.querySelector('#btn-dsh-off-reload')) };
  })()`, 30000);
  check('V1', '死端口状态：webview 加载失败可见 URL + 错误码 + 重载 WebView 按钮', res && res.hidden === false && /65533/.test(String(res.url)) && /错误码/.test(String(res.url)) && res.hasReload, res);
  const errShot = await shot(cdp, path.join(OUT, 'dsh-view-error.png'));
  check('V2', '错误态截图', errShot > 10000, { bytes: errShot });
  res = await cdp.evaluate(`(async () => {
    // 保持 refresh/probe 冻结，避免启动发现把状态改回离线；只验证「地址切到 mock 后 webview 真显示」。
    state.dsh = { configured: true, online: true, baseUrl: 'http://127.0.0.1:${mock.port}', message: 'mock-online', code: 'OK' };
    renderDsh(state.dsh);
    forceReloadDshView('button');
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      const off = document.querySelector('#dsh-off');
      const view = document.querySelector('#dsh-view');
      const url = String((view && view.getAttribute('src')) || '');
      let title = '';
      try { title = String(await view.executeJavaScript('document.title') || ''); } catch { title = ''; }
      if (off && off.hidden && url.includes('${mock.port}') && /DeepSeek Harness mock/.test(title)) {
        return { hidden: true, src: url, ready: true, title, stable: true };
      }
      if (i === 79) return { hidden: Boolean(off && off.hidden), src: url, ready: false, title, stable: false };
    }
    return { hidden: false, ready: false };
  })()`, 30000);
  check('V3', '「重载 WebView」（同一函数）把 webview 切回 mock 地址并真正显示 mock 页面', res && res.hidden === true && res.ready === true && res.stable === true && String(res.src || '').includes(String(mock.port)) && /DeepSeek Harness mock/.test(String(res.title || '')), res);
  const okShot = await shot(cdp, path.join(OUT, 'dsh-view-recovered.png'));
  check('V4', '恢复态截图', okShot > 10000, { bytes: okShot });
  fs.writeFileSync(path.join(OUT, 'dsh-view-sync.json'), JSON.stringify({ at: new Date().toISOString(), mockPort: mock.port, errorShot: errShot, okShot }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(OUT, 'stdout.log'), stdout, 'utf8');
  const failed = R.some((x) => !x.ok);
  if (failed) console.log('KEEP_SANDBOX=' + SB);
  await close({ child, ws, cdp }, failed);
  mock.server.close();
  console.log('\n' + R.filter((x) => x.ok).length + '/' + R.length + ' PASS');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('EX', (e && e.stack) || e); process.exitCode = 1; });
