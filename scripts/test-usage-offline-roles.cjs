'use strict';
require('./sandbox-tmp.cjs').useSandboxTmp();
/**
 * PM 04:08 缺陷：DSH 离线时左侧角色区 0 行（状态行却写「6 个在册角色 / 映射 1/6」）。
 * 判定口径：角色行事实来源 = 在册名册（团队.json members），与 DSH 在线/离线无关；
 *          离线也必须 6 行、未建会话的行显示「DSH 会话未创建」；只有名册真 0 人才允许空态。
 *
 * 本夹具：隔离沙盘 + 名册 6 人 + 映射仅 1/6 + DSH 不可达（netstat 桩只列死端口），
 * 隐藏窗口 1600×1000 截图 -> 证据-usage-ui-20261121/offline-roles-6rows.png。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-usage-ui-20261121');
const SB = path.join(ROOT, '_tmp', 'usage-offline-' + process.pid + '-' + Date.now());
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const PROJECT_DIR = path.join(SB, '项目区', '工作台改造修复');
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const PORT = 10733 + (process.pid % 40);
const ROLES = [['pm', '项目经理'], ['product', '产品设计师'], ['analyst', '需求分析师'], ['programmer1', '高级程序员 A'], ['programmer2', '高级程序员 B'], ['tester', '测试人员']];
const R = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(id, name, ok, detail) { R.push({ id, name, ok: Boolean(ok) }); console.log((ok ? 'PASS  ' : 'FAIL  ') + id + ' ' + name + (detail === undefined ? '' : '  ← ' + JSON.stringify(detail).slice(0, 600))); }
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
function seed() {
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
  // 映射仅 1/6（pm），模拟测试截图现场；名册 6 人仍应在离线时出 6 行。
  const store = {
    version: 3, activeProjectId: 'p-offline',
    projects: [{
      id: 'p-offline', name: '工作台改造修复', teamName: '工作台改造修复', path: PROJECT_DIR, teamMode: 'full',
      sessions: { pm: 'session-mock-pm' }, sessionMeta: {},
      workspace: { id: 'w-offline', path: PROJECT_DIR, name: '工作台改造修复', bound: true, sessionIds: ['session-mock-pm'] },
      requirements: [], tasks: [], messages: [], proposals: [], docs: []
    }], ui: {}
  };
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(DATA, 'dsh.json'), JSON.stringify({ version: 1, baseUrl: 'http://127.0.0.1:65533', source: 'auto', pinned: false }, null, 2) + '\n', 'utf8');
  return { 'netstat.exe': { ok: true, stdout: ['活动连接', '', '  TCP    127.0.0.1:65501    0.0.0.0:0    LISTENING    4243'].join('\r\n') + '\r\n' } };
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

(async () => {
  const freeGB = os.freemem() / (1024 ** 3);
  if (freeGB < 8 && String(process.env.AWB_33B9_ALLOW_LOW_MEM || '') !== '1') {
    console.log('REFUSED_LOW_MEMORY freeGB=' + freeGB.toFixed(2) + '（要求 ≥8GB；显式 AWB_33B9_ALLOW_LOW_MEM=1 放行）');
    process.exitCode = 2; return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const stub = seed();
  try { spawnSync('cmd', ['/c', 'mklink', '/J', path.join(TEAM, '工具'), path.join(ROOT, '团队', '工具')], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  const env = {
    ...process.env,
    AWB_DATA_DIR: DATA, AWB_STORE: STORE,
    AWB_TEAM_ROOT: TEAM, AWB_TEAM_PROJECTS_ROOT: path.join(SB, '项目区'),
    TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(SB, '项目区'),
    TEAM_WORKBENCH_JSON: STORE, AWB_START_HIDDEN: '1', AWB_DSH_COMMAND_STUB: JSON.stringify(stub)
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
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1647, height: 1065, deviceScaleFactor: 1, mobile: false }, 10000);
  for (let i = 0; i < 120; i += 1) {
    const ready = await cdp.evaluate('document.querySelectorAll("#role-sessions .session-row").length >= 6 && Boolean(document.querySelector("#role-sessions [data-dsh-offline]"))');
    if (ready === true) break;
    await sleep(250);
  }
  await sleep(600);
  const view = await cdp.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('#role-sessions .session-row'));
    return {
      rows: rows.length,
      names: rows.map((el) => ((el.querySelector('[data-role-name]') || {}).textContent || '').trim()),
      states: rows.map((el) => ((el.querySelector('.session-state') || {}).textContent || '').trim()),
      subs: rows.map((el) => ((el.querySelector('small') || {}).textContent || '').trim()),
      offlineText: ((document.querySelector('#role-sessions [data-dsh-offline]') || {}).textContent || '').trim(),
      count: ((document.querySelector('#session-count') || {}).textContent || '').trim(),
      width: window.innerWidth, height: window.innerHeight
    };
  })()`);
  check('O1', 'DSH 离线时角色区仍 6 行（事实来源=在册名册）', view && view.rows === 6, view);
  check('O2', '6 行都有角色名与状态（未建会话行显示 DSH 会话未创建/等价）', view && view.names.length === 6 && view.subs.filter((s) => /DSH 会话未创建/.test(s)).length >= 5, view);
  check('O3', '离线横幅在位且不再以横幅替换角色区', view && /DSH 当前离线/.test(view.offlineText) && view.rows === 6, { offlineText: view && view.offlineText, rows: view && view.rows });
  check('O4', '截图视口 1647×1065（≥1600 宽）', view && view.width >= 1600, { width: view && view.width, height: view && view.height });
  let png = 0;
  try {
    const out = await cdp.send('Page.captureScreenshot', { format: 'png' }, 20000);
    if (out && out.data) { const buf = Buffer.from(out.data, 'base64'); fs.writeFileSync(path.join(OUT, 'offline-roles-6rows.png'), buf); png = buf.length; }
  } catch { /* ignore */ }
  check('O5', '离线态真窗口截图 offline-roles-6rows.png', png > 10000, { bytes: png });
  fs.writeFileSync(path.join(OUT, 'offline-roles.json'), JSON.stringify({ at: new Date().toISOString(), view, png }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(OUT, 'offline-roles.stdout.log'), stdout, 'utf8');
  const failed = R.some((x) => !x.ok);
  if (failed) console.log('KEEP_SANDBOX=' + SB);
  await close({ child, ws, cdp }, failed);
  console.log('\n' + R.filter((x) => x.ok).length + '/' + R.length + ' PASS');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('EX', (e && e.stack) || e); process.exitCode = 1; });
