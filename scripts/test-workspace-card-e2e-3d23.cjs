'use strict';
/**
 * B-20261120-230447-3d23 真窗口断面（数据副本 + 隔离实例，不碰 Owner 真实工作台）
 * E1 首屏：数据齐备 → 卡片显示「工作台改造修复」+ 六角色会话行（≥6）+ 项目数 2，不出现「未选择工作区」。
 * E2 点击左侧第二个项目卡片 → 卡片/侧栏切到「第二工作区」，沙盘 workbench.json 的 activeProjectId 落盘为该 id。
 * E3 重启实例（同一 data 副本）→ 读回「第二工作区」（写盘+重启保持）。
 * E4 activeProjectId 指向不存在（写入 P-dead）→ 卡片显示 PROJECT_NOT_FOUND，且存储值不被静默清空。
 * 跑法：node scripts/test-workspace-card-e2e-3d23.cjs [--keep]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const KEEP = process.argv.includes('--keep') || process.env.AWB_KEEP_SANDBOX === '1';
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-wc3d23-'));
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const PORT = 9631 + Math.floor(Math.random() * 200);
const R = [];
function check(id, title, ok, detail) {
  R.push({ id, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${title}${ok ? '' : '  ← ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 500)}`);
  if (!ok) process.exitCode = 1;
}
function copy(src, dst) {
  try {
    if (!fs.existsSync(src)) return;
    if (fs.statSync(src).isDirectory()) { fs.mkdirSync(dst, { recursive: true }); for (const n of fs.readdirSync(src)) copy(path.join(src, n), path.join(dst, n)); }
    else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
  } catch (e) { console.log('COPY_FAIL', src, String(e.message || e)); }
}
function seed() {
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  for (const n of fs.readdirSync(path.join(ROOT, 'data', 'userdata'))) if (n.startsWith('workbench.json')) copy(path.join(ROOT, 'data', 'userdata', n), path.join(DATA, 'userdata', n));
  // 只取名册 + 当前项目登记（不复制 21MB 看板/邮箱：C 盘空间紧张，且卡片与会话行不依赖它们）。
  copy(path.join(ROOT, '团队', '状态', '团队.json'), path.join(TEAM, '状态', '团队.json'));
  const projState = path.join(TEAM, '状态', '项目', '工作台改造修复');
  fs.mkdirSync(projState, { recursive: true });
  copy(path.join(ROOT, '团队', '状态', '项目', '工作台改造修复', '项目.json'), path.join(projState, '项目.json'));
  // 工具目录用 junction（只读借真工具；清理时先 rmdir 链接再删沙盘，绝不跟随进真实树）
  try { cp.execFileSync('cmd', ['/c', 'mklink', '/J', path.join(TEAM, '工具'), path.join(ROOT, '团队', '工具')], { stdio: 'ignore' }); } catch (e) { console.log('JUNCTION_FAIL', String(e.message || e)); }
  // 第二个工作区：最小目录 + 项目.json，store 里克隆一条记录（id/name/path 换成新的）
  const store = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  const base = (store.projects || [])[0];
  if (!base) return null;
  const dir = path.join(SB, '第二个工作区');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '项目信息.md'), '# 第二个工作区\n', 'utf8');
  fs.writeFileSync(path.join(dir, '项目.json'), JSON.stringify({ name: '第二工作区', mode: 'six', teamMode: 'full' }, null, 2), 'utf8');
  const second = JSON.parse(JSON.stringify(base));
  second.id = 'P-second-3d23';
  second.name = '第二工作区';
  second.path = dir;
  second.workspacePath = dir;
  second.workspace = { ...(second.workspace || {}), bound: false, id: null, name: null, pending: true, sessionIds: [] };
  second.sessions = [];
  store.projects.push(second);
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2), 'utf8');
  return { base: base.id, second: second.id };
}
const env = () => ({ ...process.env, AWB_DATA_DIR: DATA, AWB_TEAM_ROOT: TEAM, TEAM_ROOT: TEAM, TEAM_SELFTEST: '1', DSH_WEB_URL: 'http://127.0.0.1:1' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function launch() {
  const port = PORT + Math.floor(Math.random() * 100);
  const child = cp.spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', `--remote-debugging-port=${port}`], { cwd: ROOT, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  let target = null;
  for (let i = 0; i < 60; i += 1) {
    await sleep(1000);
    try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); target = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (target) break; } catch { /* wait */ }
  }
  if (!target) throw new Error('CDP 目标未出现：' + log.slice(-500));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(); const exceptions = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(String(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text).slice(0, 300));
  };
  const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r && r.result && r.result.result ? r.result.result.value : r; };
  await send('Runtime.enable', {});
  return { child, ws, send, evalJs, exceptions, log: () => log };
}
async function domNow(h) {
  return h.evalJs(`({
    name: (document.querySelector('#workspace-name')||{}).textContent,
    meta: (document.querySelector('#workspace-meta')||{}).textContent,
    projects: (document.querySelector('#project-count')||{}).textContent,
    rows: document.querySelectorAll('#role-sessions .session-row').length,
    roleHtml: ((document.querySelector('#role-sessions')||{}).innerHTML||'').slice(0, 300),
    teamRows: document.querySelectorAll('#team-session-list .team-session').length,
    warn: (document.querySelector('#workspace-warn')||{}).textContent,
    toast: Array.from(document.querySelectorAll('.toast,[data-toast]')).map(e=>e.textContent).slice(-2)
  })`);
}
function kill(h) { try { cp.execFileSync('taskkill', ['/PID', String(h.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } try { h.ws.close(); } catch { /* ignore */ } }
(async () => {
  const seeded = seed();
  if (!seeded) { check('E0', 'seed 读取真实 workbench 副本成功', false, STORE); return; }
  let h = await launch();
  try {
    await sleep(3500);
    const d1 = await domNow(h);
    const tm = await h.evalJs(`(async()=>{try{const r=await window.workbench.teamMembers({projectId:(state&&state.activeProjectId)||'P-b98f4eb7'});return {ok:r&&r.ok,count:r&&r.count,rows:(r&&r.rows||[]).length,code:r&&r.code};}catch(e){return {error:String(e&&e.message||e)}}})()`);
    check('E1', '首屏数据齐备：显示「工作台改造修复」+ 六角色会话行 ≥6 + 项目数 2，无「未选择工作区」',
      d1.name === '工作台改造修复' && d1.rows >= 6 && !/未选择工作区/.test(d1.name) && String(d1.projects) === '2', { d1, tm, exceptions: h.exceptions, log: h.log().slice(-500) });
    // E2：真实点击左侧第二个项目卡片
    await h.evalJs(`(function(){ const el = document.querySelector('.project-item[data-project="P-second-3d23"]'); if (!el) return 'NO_ITEM'; el.click(); return 'CLICKED'; })()`);
    let d2 = null;
    for (let i = 0; i < 25; i += 1) { await sleep(400); d2 = await domNow(h); if (d2.name === '第二工作区') break; }
    const stored1 = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    check('E2', '点击项目卡片 → 卡片立即切到「第二工作区」且 activeProjectId 已写盘', d2.name === '第二工作区' && stored1.activeProjectId === 'P-second-3d23', { d2, active: stored1.activeProjectId });
  } finally { kill(h); }
  // E3 重启实例读回
  h = await launch();
  try {
    await sleep(3500);
    const d3 = await domNow(h);
    check('E3', '重启后读回「第二工作区」（写盘 activeProjectId 生效）', d3.name === '第二工作区', { d3, exceptions: h.exceptions });
    // E4 指向不存在的项目：写坏 activeProjectId 后刷新页面
    const st = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    st.activeProjectId = 'P-dead-3d23';
    fs.writeFileSync(STORE, JSON.stringify(st, null, 2), 'utf8');
    await h.send('Page.enable', {});
    await h.send('Page.reload', { ignoreCache: true });
    await sleep(5000);
    const d4 = await domNow(h);
    const stored2 = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    check('E4', 'activeProjectId 指向不存在 → 卡片显示 PROJECT_NOT_FOUND（不清空、不静默切走）', /PROJECT_NOT_FOUND/.test(d4.name) && /P-dead-3d23/.test(d4.meta) && stored2.activeProjectId === 'P-dead-3d23', { d4, active: stored2.activeProjectId, warn: d4.warn });
  } finally { kill(h); }
})().catch((e) => check('EX', '断面未抛异常', false, { error: String((e && e.stack) || e) })).finally(() => {
  if (!KEEP) { try { cp.execFileSync('cmd', ['/c', 'rmdir', path.join(TEAM, '工具')], { stdio: 'ignore' }); } catch { /* ignore */ } try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ } } else { console.log('KEEP_SANDBOX=' + SB); }
  const pass = R.filter((x) => x.ok).length;
  console.log(`\n${pass}/${R.length} PASS`);
});
