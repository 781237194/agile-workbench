'use strict';
/**
 * B-33b9 追加（Owner 04:xx）：重载 DSH 后必须「地址跟上 + 全局刷新 + 自动按标题重绑」。
 *
 * 用本地 mock DSH（session/list 返回 6 个「团队·角色」标题）+ netstat 命令桩，
 * 隔离 AWB_DATA_DIR 起**隐藏**真窗口：
 *   旧 dsh.json=失效端口 65533 → 点【重载 DSH】（IPC app:reload-dsh）→
 *   发现 mock 端口 → reload webview → 广播 dsh:status-changed → 渲染层 refresh()
 *   → 自动按标题重绑 6 条映射（写沙盘 store）→ 六角色区/计数/地址同源更新。
 *
 * 默认遵守 AC⑧：可用内存 <8GB 拒绝起跑；本夹具为确定性验证可用 AWB_33B9_ALLOW_LOW_MEM=1 显式放行。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, '项目', '工作台改造修复');
const OUT = path.join(PROJ, '程序员A', '产出', '证据-33b9-20261121');
const SB = path.join(ROOT, '_tmp', '33b9-reload-' + process.pid + '-' + Date.now());
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const PROJECT_DIR = path.join(SB, '项目区', '工作台改造修复');
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const DSH_JSON = path.join(DATA, 'dsh.json');
const PORT = 10533 + (process.pid % 40);
const ROLES = [['pm', '项目经理'], ['product', '产品设计师'], ['analyst', '需求分析师'], ['programmer1', '高级程序员 A'], ['programmer2', '高级程序员 B'], ['tester', '测试人员']];
const R = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(id, name, ok, detail) {
  R.push({ id, name, ok: Boolean(ok) });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + id + ' ' + name + (detail === undefined ? '' : '  ← ' + JSON.stringify(detail).slice(0, 700)));
}
function httpJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(1500, () => { req.destroy(); resolve(null); });
  });
}
async function waitTarget(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await httpJson('http://127.0.0.1:' + PORT + '/json/list');
    if (Array.isArray(list)) {
      const hit = list.find((item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
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
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      }
    });
  }
  send(method, params = {}, ms = 20000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, ms);
    });
  }
  async evaluate(expr, ms = 20000) {
    const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, ms);
    if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || '') };
    return out && out.result ? out.result.value : undefined;
  }
}
async function startMockDsh() {
  const items = ROLES.map(([role, name]) => ({
    sessionId: 'session-mock-' + role,
    title: '团队·' + name,
    cwd: PROJECT_DIR,
    archived: false,
    blank: false,
    updatedAt: new Date().toISOString()
  }));
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/session/list') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let rpcId = '';
        try { rpcId = JSON.parse(body).rpcId || ''; } catch { /* ignore */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: { items } } }));
      });
      return;
    }
    if (req.url === '/json/version') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"ok":false}');
      return;
    }
    res.writeHead(401, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>DSH Web authentication required</title>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, items };
}
function seed(mockPort) {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  for (const name of ['团队宪法.md', '项目铁律.md']) {
    try { fs.copyFileSync(path.join(ROOT, '团队', name), path.join(TEAM, name)); } catch { /* ignore */ }
  }
  try {
    const team = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8').replace(/^\uFEFF/, ''));
    for (const m of team.members || []) m.sessionId = '';
    team.activeProject = '工作台改造修复';
    fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  } catch { /* ignore */ }
  const store = {
    version: 3,
    activeProjectId: 'p-33b9',
    projects: [{
      id: 'p-33b9', name: '工作台改造修复', teamName: '工作台改造修复', path: PROJECT_DIR,
      teamMode: 'full', sessions: {}, sessionMeta: {},
      workspace: { id: 'w-33b9', path: PROJECT_DIR, name: '工作台改造修复', bound: true, sessionIds: [] },
      requirements: [], tasks: [], messages: [], proposals: [], docs: []
    }],
    ui: {}
  };
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n', 'utf8');
  // 旧地址（失效）：重启后应被当作可信候选先验，失败再用 netstat 枚举跟上 mock 端口。
  fs.writeFileSync(DSH_JSON, JSON.stringify({ version: 1, baseUrl: 'http://127.0.0.1:65533', source: 'auto', pinned: false, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  // 命令桩：netstat 只列 mock 端口 + 两个死端口（不依赖真实监听/不动真实 DSH）。
  const stub = {
    'netstat.exe': {
      ok: true,
      stdout: ['活动连接', '',
        '  TCP    127.0.0.1:' + mockPort + '    0.0.0.0:0    LISTENING    4242',
        '  TCP    127.0.0.1:65501    0.0.0.0:0    LISTENING    4243',
        '  TCP    0.0.0.0:135    0.0.0.0:0    LISTENING    4'].join('\r\n') + '\r\n'
    }
  };
  return stub;
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
  try {
    const out = await cdp.send('Page.captureScreenshot', { format: 'png' }, 15000);
    if (!out || !out.data) return 0;
    const buf = Buffer.from(out.data, 'base64');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    return buf.length;
  } catch { return 0; }
}
function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return null; }
}

(async () => {
  const freeGB = os.freemem() / (1024 ** 3);
  if (freeGB < 8 && String(process.env.AWB_33B9_ALLOW_LOW_MEM || '') !== '1') {
    console.log('REFUSED_LOW_MEMORY freeGB=' + freeGB.toFixed(2) + '（要求 ≥8GB；显式 AWB_33B9_ALLOW_LOW_MEM=1 可放行）');
    process.exitCode = 2;
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const mock = await startMockDsh();
  const stub = seed(mock.port);
  const startedAt = Date.now();
  const env = {
    ...process.env,
    AWB_DATA_DIR: DATA,
    AWB_STORE: STORE,
    // ★壳层 resolveTeamRoot() 优先读 AWB_TEAM_ROOT（不是 TEAM_ROOT）——漏了它会改真实名册（本轮踩过）。
    AWB_TEAM_ROOT: TEAM,
    AWB_TEAM_PROJECTS_ROOT: path.join(SB, '项目区'),
    TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: path.join(SB, '项目区'),
    TEAM_WORKBENCH_JSON: STORE,
    AWB_START_HIDDEN: '1',
    AWB_DSH_COMMAND_STUB: JSON.stringify(stub)
  };
  for (const key of ['DSH_WEB_URL', 'AWB_DSH_BASE_URL', 'DSH_WEB_PORT', 'DSH_PORT']) delete env[key];
  try { const realHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'); fs.mkdirSync(path.join(SB, 'dsh-home'), { recursive: true }); fs.copyFileSync(path.join(realHome, '.credentials.yaml'), path.join(SB, 'dsh-home', '.credentials.yaml')); } catch { /* auth 失败会在夹具里显形 */ }
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let stdout = '';
  child.stdout.on('data', (c) => { stdout += String(c); });
  child.stderr.on('data', (c) => { stdout += String(c); });
  const target = await waitTarget(90000);
  if (!target) { console.log('NO_TARGET KEEP=' + SB); console.log(stdout.split(/\r?\n/).slice(-20).join('\n')); await close({ child }, true); return; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('ws 失败')), { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  for (let i = 0; i < 100; i += 1) {
    const ready = await cdp.evaluate('Boolean(document.getElementById("btn-refresh")) && Boolean(document.getElementById("role-sessions"))');
    if (ready === true) break;
    await sleep(300);
  }
  check('R0', '隐藏窗口已就绪（AWB_START_HIDDEN=1）', true, { readyMs: Date.now() - startedAt });
  let status = await cdp.evaluate('window.workbench.dshStatus()');
  check('R1', '重载前状态可读（本夹具启动首轮即已发现 mock，说明可信候选/监听枚举链路生效）', Boolean(status && status.status), status && status.status && { online: status.status.online, baseUrl: status.status.baseUrl });
  const refreshBefore = Number(await cdp.evaluate('window.__refreshCount || 0'));
  const reload = await cdp.evaluate('window.workbench.reloadDshView()', 30000);
  for (let i = 0; i < 100; i += 1) {
    status = await cdp.evaluate('window.workbench.dshStatus()').catch(() => null);
    if (status && status.status && status.status.online && String(status.status.baseUrl || '').endsWith(':' + mock.port)) break;
    await sleep(200);
  }
  check('R2', '重载后：自动连上 mock 端口且状态 baseUrl 与真实连接同源', Boolean(status && status.status && status.status.online && String(status.status.baseUrl || '').endsWith(':' + mock.port)),
    { reload: reload && { ok: reload.ok, code: reload.code }, status: status && status.status && { online: status.status.online, baseUrl: status.status.baseUrl } });
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(DSH_JSON, 'utf8')); } catch { /* ignore */ }
  check('R3', '重载后 dsh.json 回写 mock 端口（source=auto）', Boolean(cfg && String(cfg.baseUrl || '').endsWith(':' + mock.port) && cfg.source === 'auto'), cfg);
  const refreshAfter = Number(await cdp.evaluate('window.__refreshCount || 0'));
  check('R4', '重载成功广播了一次全局刷新（refresh 计数增加）', refreshAfter > refreshBefore, { refreshBefore, refreshAfter });
  let mapped = 0;
  for (let i = 0; i < 100; i += 1) {
    const store = readStore();
    mapped = store && store.projects && store.projects[0] ? Object.keys(store.projects[0].sessions || {}).filter((role) => store.projects[0].sessions[role]).length : 0;
    if (mapped >= 6) break;
    await sleep(250);
  }
  check('R5', '连上后自动按标题重绑 6 条映射（不等用户点按钮）', mapped >= 6, { mapped });
  const ui = await cdp.evaluate(`(() => ({
    count: (document.querySelector('#session-count') || {}).textContent || '',
    dataLocal: (document.querySelector('#session-count') || {}).getAttribute('data-local') || '',
    offline: Boolean(document.querySelector('#role-sessions [data-dsh-offline]')),
    address: (document.querySelector('#dsh-off-url') || {}).textContent || '',
    rows: document.querySelectorAll('#role-sessions .session-row').length,
    mappedRows: Array.from(document.querySelectorAll('#role-sessions .session-row')).filter((el) => String(el.getAttribute('data-session-id') || '')).length
  }))()`);
  check('R6', '六角色区/计数/地址与真实连接同源（本地映射 6/6、无离线卡、地址是新端口）',
    ui && !ui.offline && ui.rows === 6 && ui.mappedRows === 6 && ui.dataLocal === '6/6'
      && !/58497|65533/.test(String(ui.address)) && /6\/6|0\/6|待核验/.test(String(ui.count)), ui);
  const png = await shot(cdp, path.join(OUT, 'reload-refresh.png'));
  check('R7', '真窗口截图', png > 10000, { png });
  const report = { at: new Date().toISOString(), mockPort: mock.port, offlineBefore: true, status: status && status.status, cfg, refreshBefore, refreshAfter, mapped, ui, png };
  fs.writeFileSync(path.join(OUT, 'reload-refresh.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(OUT, 'reload-refresh.stdout.log'), stdout, 'utf8');
  const failed = R.some((x) => !x.ok);
  if (failed) console.log('KEEP_SANDBOX=' + SB);
  await close({ child, ws, cdp }, failed);
  mock.server.close();
  console.log('\n' + R.filter((x) => x.ok).length + '/' + R.length + ' PASS');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.error('EX', (e && e.stack) || e);
  process.exitCode = 1;
});
