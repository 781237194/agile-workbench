'use strict';
/**
 * Owner 2026-11-21 04:xx：用量卡瘦身 + 角色区优先 + 切角色立即刷新（真窗口截图验收，宽 ≥1600）。
 *
 * 隔离 AWB_DATA_DIR + 六键团队沙盘 + mock DSH + netstat 命令桩，起**隐藏**窗口；
 * 页面用 Emulation 设为 1600×1000 后截图：
 *   ① 上方六角色行 6 行、下方用量卡默认 ≤2 行（无对照表/长文案）；
 *   ② 点「产品设计师」chip，≤2s 标签切到该角色；
 *   ③ 截图 usage-before.png / usage-after.png 存 程序员A/产出/证据-usage-ui-20261121/。
 * 只回收自己 spawn 的 PID；默认遵守 AC⑧ 内存≥8GB（本机可用例外 AWB_33B9_ALLOW_LOW_MEM=1）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const shellMklink = (link, target) => {
  try { spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
};

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-usage-ui-20261121');
const SB = path.join(ROOT, '_tmp', 'usage-ui-' + process.pid + '-' + Date.now());
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const PROJECT_DIR = path.join(SB, '项目区', '工作台改造修复');
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const DSH_JSON = path.join(DATA, 'dsh.json');
const PORT = 10633 + (process.pid % 40);
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
  const items = ROLES.map(([role, name]) => ({ sessionId: 'session-mock-' + role, title: '团队·' + name, cwd: PROJECT_DIR, archived: false, blank: false }));
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
    if (req.url === '/json/version') { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"ok":false}'); return; }
    res.writeHead(401, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>DSH Web authentication required</title>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}
function seed(mockPort) {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态', '项目', '工作台改造修复'), { recursive: true });
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  for (const name of ['团队宪法.md', '项目铁律.md']) {
    try { fs.copyFileSync(path.join(ROOT, '团队', name), path.join(TEAM, name)); } catch { /* ignore */ }
  }
  // session:usage 会动态 import <teamRoot>/工具/lib/session.mjs 取阈值单源；沙盘建 junction。
  try { shellMklink(path.join(TEAM, '工具'), path.join(ROOT, '团队', '工具')); } catch { /* 已存在 */ }
  const team = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8').replace(/^\uFEFF/, ''));
  for (const m of team.members || []) m.sessionId = 'session-mock-' + m.role;
  team.activeProject = '工作台改造修复';
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  try {
    const project = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '项目', '工作台改造修复', '项目.json'), 'utf8').replace(/^\uFEFF/, ''));
    fs.writeFileSync(path.join(TEAM, '状态', '项目', '工作台改造修复', '项目.json'), JSON.stringify(project, null, 2) + '\n', 'utf8');
  } catch { /* 无项目档时用默认阈值 */ }
  const sessions = {};
  const sessionMeta = {};
  for (const [role] of ROLES) { sessions[role] = 'session-mock-' + role; sessionMeta[role] = { title: '团队·' + ROLES.find(([r]) => r === role)[1] }; }
  const store = {
    version: 3,
    activeProjectId: 'p-usage',
    projects: [{
      id: 'p-usage', name: '工作台改造修复', teamName: '工作台改造修复', path: PROJECT_DIR, teamMode: 'full',
      sessions, sessionMeta,
      workspace: { id: 'w-usage', path: PROJECT_DIR, name: '工作台改造修复', bound: true, sessionIds: Object.values(sessions) },
      requirements: [], tasks: [], messages: [], proposals: [], docs: []
    }],
    ui: {}
  };
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.writeFileSync(DSH_JSON, JSON.stringify({ version: 1, baseUrl: 'http://127.0.0.1:65533', source: 'auto', pinned: false }, null, 2) + '\n', 'utf8');
  const now = new Date().toISOString();
  // pm 264.1 万（判定口径=未缓存输入）；product 520 万（warn 档）——点 chip 后标签与数值必须换。
  fs.writeFileSync(path.join(TEAM, '状态', '项目', '工作台改造修复', '会话用量.json'), JSON.stringify({
    pm: { sessionId: 'session-mock-pm', tokens: 2641000, input: 2641000, cacheRead: 0, output: 0, at: now, source: 'manual' },
    product: { sessionId: 'session-mock-product', tokens: 520000, input: 520000, cacheRead: 0, output: 0, at: now, source: 'manual' },
    analyst: { sessionId: 'session-mock-analyst', tokens: 120000, input: 120000, cacheRead: 0, output: 0, at: now, source: 'manual' },
    programmer1: { sessionId: 'session-mock-programmer1', tokens: 80000, input: 80000, cacheRead: 0, output: 0, at: now, source: 'manual' },
    programmer2: { sessionId: 'session-mock-programmer2', tokens: 60000, input: 60000, cacheRead: 0, output: 0, at: now, source: 'manual' },
    tester: { sessionId: 'session-mock-tester', tokens: 40000, input: 40000, cacheRead: 0, output: 0, at: now, source: 'manual' }
  }, null, 2) + '\n', 'utf8');
  return {
    'netstat.exe': {
      ok: true,
      stdout: ['活动连接', '',
        '  TCP    127.0.0.1:' + mockPort + '    0.0.0.0:0    LISTENING    4242',
        '  TCP    127.0.0.1:65501    0.0.0.0:0    LISTENING    4243'].join('\r\n') + '\r\n'
    }
  };
}
async function close(inst, keep) {
  if (!inst) return;
  try { await inst.cdp.send('Browser.close', {}, 2000); } catch { /* ignore */ }
  try { inst.ws.close(); } catch { /* ignore */ }
  try { inst.child.kill(); } catch { /* ignore */ }
  await sleep(500);
  try { if (inst.child && inst.child.pid && inst.child.exitCode === null) spawnSync('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  try { spawnSync('cmd', ['/c', 'rmdir', path.join(TEAM, '工具')], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  if (!keep) { try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ } }
}
async function shot(cdp, file) {
  try {
    const out = await cdp.send('Page.captureScreenshot', { format: 'png' }, 20000);
    if (!out || !out.data) return 0;
    const buf = Buffer.from(out.data, 'base64');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    return buf.length;
  } catch { return 0; }
}

(async () => {
  const freeGB = os.freemem() / (1024 ** 3);
  if (freeGB < 8 && String(process.env.AWB_33B9_ALLOW_LOW_MEM || '') !== '1') {
    console.log('REFUSED_LOW_MEMORY freeGB=' + freeGB.toFixed(2) + '（要求 ≥8GB；显式 AWB_33B9_ALLOW_LOW_MEM=1 放行）');
    process.exitCode = 2;
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const mock = await startMockDsh();
  const stub = seed(mock.port);
  const env = {
    ...process.env,
    AWB_DATA_DIR: DATA, AWB_STORE: STORE,
    AWB_TEAM_ROOT: TEAM, AWB_TEAM_PROJECTS_ROOT: path.join(SB, '项目区'),
    TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(SB, '项目区'),
    TEAM_WORKBENCH_JSON: STORE,
    AWB_START_HIDDEN: '1',
    AWB_DSH_COMMAND_STUB: JSON.stringify(stub)
  };
  for (const key of ['DSH_WEB_URL', 'AWB_DSH_BASE_URL', 'DSH_WEB_PORT', 'DSH_PORT']) delete env[key];
  try { const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'); fs.mkdirSync(path.join(SB, 'dsh-home'), { recursive: true }); fs.copyFileSync(path.join(home, '.credentials.yaml'), path.join(SB, 'dsh-home', '.credentials.yaml')); } catch { /* ignore */ }
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
  await cdp.send('Page.enable');
  // 宽 ≥1600 的验收窗口：不改真实 Window 尺寸，用页面设备指标模拟（截图 1600×1000）。
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, 10000);
  for (let i = 0; i < 120; i += 1) {
    const ready = await cdp.evaluate('document.querySelectorAll("#role-sessions .session-row").length >= 6 && Boolean(document.querySelector("#session-usage [data-usage-label]")) && Boolean((document.querySelector("#session-usage")).getAttribute("data-usage-role"))');
    if (ready === true) break;
    await sleep(250);
  }
  await sleep(500);
  const before = await cdp.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('#role-sessions .session-row'));
    const wrap = document.querySelector('#session-usage-wrap');
    const host = document.querySelector('#session-usage');
    const label = document.querySelector('#session-usage [data-usage-label]');
    const chips = Array.from(document.querySelectorAll('#session-usage [data-usage-role-pick]'));
    const visibleChips = chips.filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    return {
      rows: rows.length,
      rowNames: rows.map((el) => ((el.querySelector('[data-role-name]') || {}).textContent || '').trim()),
      wrapHeight: wrap ? Math.round(wrap.getBoundingClientRect().height) : 0,
      hostHeight: host ? Math.round(host.getBoundingClientRect().height) : 0,
      roleHeight: (document.querySelector('#role-sessions') || {}).getBoundingClientRect ? Math.round(document.querySelector('#role-sessions').getBoundingClientRect().height) : 0,
      label: label ? String(label.textContent || '').trim() : '',
      labelRole: host ? host.getAttribute('data-usage-role') : '',
      chips: visibleChips.length,
      detailHidden: Boolean((document.querySelector('#session-usage [data-usage-detail]') || {}).hidden),
      compareVisible: Boolean(document.querySelector('#session-usage [data-usage-compare]')),
      labelLines: label ? Math.round(label.getBoundingClientRect().height / Math.max(1, parseFloat(getComputedStyle(label).lineHeight || '12'))) : 0
    };
  })()`);
  check('U1', '六角色区 6 行（角色区优先，不被用量卡挤掉）', before && before.rows === 6 && before.roleHeight >= 120, before);
  check('U2', '用量卡默认 ≤2 行：无对照表、明细折叠、卡高 ≤60px', before && before.wrapHeight <= 60 && before.hostHeight <= 55
    && before.detailHidden === true && before.compareVisible === false && before.labelLines <= 1, before);
  check('U3', '用量标签是紧凑摘要（本会话(角色) 数值 / 阈值）', before && /^本会话\([^)]+\)\s/.test(before.label) && /阈值/.test(before.label), { label: before && before.label });
  const shotBefore = await shot(cdp, path.join(OUT, 'usage-before.png'));
  check('U4', '真窗口截图 1（1600 宽：上 6 行角色 + 下用量卡）', shotBefore > 10000, { bytes: shotBefore });
  const clickAt = Date.now();
  const click = await cdp.evaluate(`(() => { const chip = document.querySelector('#session-usage [data-usage-role-pick="product"]'); if (!chip) return 'NO_CHIP'; chip.click(); return 'CLICKED'; })()`);
  let after = null;
  for (let i = 0; i < 20; i += 1) {
    after = await cdp.evaluate(`(() => { const host = document.querySelector('#session-usage'); return { role: host ? host.getAttribute('data-usage-role') : '', label: (document.querySelector('#session-usage [data-usage-label]') || {}).textContent || '' }; })()`);
    if (after && after.role === 'product' && /本会话\(产品设计师\)/.test(String(after.label))) break;
    await sleep(100);
  }
  const elapsed = Date.now() - clickAt;
  check('U5', '点「产品设计师」chip → ≤2s 标签/数值切到该角色', click === 'CLICKED' && after && after.role === 'product' && /本会话\(产品设计师\)/.test(String(after.label)) && elapsed <= 2000, { click, elapsed, after });
  const shotAfter = await shot(cdp, path.join(OUT, 'usage-after.png'));
  check('U6', '真窗口截图 2（切角色后）', shotAfter > 10000, { bytes: shotAfter });
  const report = { at: new Date().toISOString(), before, after, elapsedMs: elapsed, mockPort: mock.port, screenshots: { before: shotBefore, after: shotAfter } };
  fs.writeFileSync(path.join(OUT, 'usage-ui.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(OUT, 'stdout.log'), stdout, 'utf8');
  const failed = R.some((x) => !x.ok);
  if (failed) console.log('KEEP_SANDBOX=' + SB);
  await close({ child, ws, cdp }, failed);
  mock.server.close();
  console.log('\n' + R.filter((x) => x.ok).length + '/' + R.length + ' PASS');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('EX', (e && e.stack) || e); process.exitCode = 1; });
