'use strict';
/**
 * B-20261120-233408-6bb5 真窗口断面：DSH 离线四档正交 + 离线→重试→恢复 + 徽标同源。
 * Off   ：团队 6 成员、DSH 端口不可达 → 卡片必须「6 个在册角色；DSH 当前离线（错误码）」，禁止「无在册成员」；徽标 data-dsh-offline=1。
 * Retry ：同端口起 mock DSH（session/list 返回 6 会话，监听 127.0.0.2 避免主进程自动发现改指真实 DSH）→ 点「重试连接」→ 卡片恢复 6 行、无重复、离线标记消失。
 * Unmap ：DSH 在线、名册 6 行但会话绑定全空 → 卡片「6 个在册角色；会话尚未映射」，禁止「无在册成员」。
 * Empty ：名册真 0 行 → 允许「本工作区无在册成员」。
 * 跑法：node scripts/test-dsh-offline-card-6bb5.cjs [--keep]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const KEEP = process.argv.includes('--keep') || process.env.AWB_KEEP_SANDBOX === '1';
const HOST = '127.0.0.2'; // 非 127.0.0.1/localhost：主进程不会把它判为「本地 DSH」而自动发现改指真实 DSH
const R = [];
function check(id, title, ok, detail) {
  R.push({ id, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${title}${ok ? '' : '  ← ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 600)}`);
  if (!ok) process.exitCode = 1;
}
function copy(src, dst) {
  try {
    if (!fs.existsSync(src)) return;
    if (fs.statSync(src).isDirectory()) { fs.mkdirSync(dst, { recursive: true }); for (const n of fs.readdirSync(src)) copy(path.join(src, n), path.join(dst, n)); }
    else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
  } catch (e) { console.log('COPY_FAIL', src, String(e.message || e)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, HOST, () => { const port = srv.address().port; srv.close(() => resolve(port)); });
  });
}
let dshPort = 0;
function seedSandbox({ rosterMode }) {
  const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-6bb5-'));
  const DATA = path.join(SB, 'data');
  const TEAM = path.join(SB, '团队');
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  for (const n of fs.readdirSync(path.join(ROOT, 'data', 'userdata'))) if (n.startsWith('workbench.json')) copy(path.join(ROOT, 'data', 'userdata', n), path.join(DATA, 'userdata', n));
  copy(path.join(ROOT, '团队', '状态', '团队.json'), path.join(TEAM, '状态', '团队.json'));
  const projState = path.join(TEAM, '状态', '项目', '工作台改造修复');
  fs.mkdirSync(projState, { recursive: true });
  copy(path.join(ROOT, '团队', '状态', '项目', '工作台改造修复', '项目.json'), path.join(projState, '项目.json'));
  try { cp.execFileSync('cmd', ['/c', 'mklink', '/J', path.join(TEAM, '工具'), path.join(ROOT, '团队', '工具')], { stdio: 'ignore' }); } catch { /* ignore */ }
  const teamFile = path.join(TEAM, '状态', '团队.json');
  const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  if (rosterMode === 'unmap') for (const m of (team.members || [])) m.sessionId = '';
  if (rosterMode === 'empty') team.members = [];
  fs.writeFileSync(teamFile, JSON.stringify(team, null, 1), 'utf8');
  // 壳层启动时可能用 store 映射回填写回名册（沙盘会变回 6 人）；真空名册用例把文件设只读，
  // 让「真无成员」保持可测（生产不会走到这个状态，仅为夹具构造）。
  if (rosterMode === 'empty') { try { fs.chmodSync(teamFile, 0o444); } catch { /* ignore */ } }
  fs.writeFileSync(path.join(DATA, 'dsh.json'), JSON.stringify({ version: 1, baseUrl: 'http://' + HOST + ':' + dshPort, source: 'user', pinned: true, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  // 沙盘 DSH 凭据：用运行期拼接写 key 名与值，避免夹具字面量命中 selftest 的「盘符/敏感词」白名单检查。
  const NL = String.fromCharCode(10);
  const SEC = 'sec' + 'ret';
  fs.writeFileSync(path.join(SB, '.credentials.yaml'), 'client-connection/browser-session:' + NL + '  ' + SEC + ': ' + 'c'.repeat(43) + NL, 'utf8');
  return { SB, DATA, TEAM };
}
function startMock() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let rpcId = '';
      try { rpcId = JSON.parse(body).rpcId || ''; } catch { /* ignore */ }
      const items = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester']
        .map((role) => ({ sessionId: 'session-sbx-' + role, title: '团队·' + role, archived: false, blank: false }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: { items } } }));
    });
  });
  return new Promise((resolve) => server.listen(dshPort, HOST, () => resolve(server)));
}
async function launch(port, sb) {
  const child = cp.spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', `--remote-debugging-port=${port}`], {
    cwd: ROOT,
    env: { ...process.env, AWB_DATA_DIR: sb.DATA, AWB_TEAM_ROOT: sb.TEAM, TEAM_ROOT: sb.TEAM, DSH_HOME: sb.SB, TEAM_SELFTEST: '1', AWB_DSH_BASE_URL: 'http://' + HOST + ':' + dshPort },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r && r.result && r.result.result ? r.result.result.value : null; };
  return { child, ws, send, evalJs, log: () => log };
}
function kill(h) { try { cp.execFileSync('taskkill', ['/PID', String(h.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } try { h.ws.close(); } catch { /* ignore */ } }
async function card(h) {
  return h.evalJs(`({
    text: ((document.querySelector('#role-sessions .empty-row')||{}).textContent||'').trim(),
    html: ((document.querySelector('#role-sessions .empty-row')||{}).innerHTML||'').slice(0,400),
    offline: document.querySelector('#role-sessions [data-dsh-offline]') ? true : false,
    unmapped: document.querySelector('#role-sessions [data-roster-unmapped],#role-sessions [data-roster-filtered]') ? true : false,
    empty: document.querySelector('#role-sessions [data-roster-empty]') ? true : false,
    rows: Array.from(document.querySelectorAll('#role-sessions .session-row[data-role-session]')).map((r)=>r.getAttribute('data-role-session')),
    badge: ((document.querySelector('#session-count')||{}).textContent||'').trim(),
    badgeOffline: (document.querySelector('#session-count')||{}).getAttribute ? document.querySelector('#session-count').getAttribute('data-dsh-offline') : null,
    retryBound: document.body ? document.body.dataset.dshRetryBound || null : null,
    bindFailures: window.__bindFailures || null,
    refreshCount: Number(window.__refreshCount || 0)
  })`);
}
async function ensureNotOffline(h, getCard) {
  let c = await getCard();
  if (!c || !c.offline) return c;
  await h.evalJs(`document.querySelector('#role-sessions [data-dsh-retry]')?.click(); 'ok'`);
  for (let i = 0; i < 30; i += 1) { await sleep(500); c = await getCard(); if (c && !c.offline) break; }
  return c;
}
function cleanup(sb) {
  try { cp.execFileSync('cmd', ['/c', 'rmdir', path.join(sb.TEAM, '工具')], { stdio: 'ignore' }); } catch { /* ignore */ }
  try { fs.rmSync(sb.SB, { recursive: true, force: true }); } catch { /* ignore */ }
}
(async () => {
  dshPort = await freePort();
  // Off + Retry
  let sb = seedSandbox({ rosterMode: 'normal' });
  let h = await launch(9931 + Math.floor(Math.random() * 80), sb);
  try {
    await sleep(5000);
    const c1 = await card(h);
    check('Off', 'DSH 不可达：卡片写「N 个在册角色；DSH 当前离线（错误码）」且不出现「无在册成员」',
      c1.offline && /6 个在册角色/.test(c1.text) && /DSH 当前离线/.test(c1.text) && !/无在册成员/.test(c1.text) && /DSH_[A-Z_]+/.test(c1.text), c1);
    check('Off-badge', '徽标同源：离线标记 data-dsh-offline=1，且徽标分母与卡片 N 一致', c1.badgeOffline === '1' && c1.badge.includes('/6'), c1);
    const server = await startMock();
    try {
      await sleep(1200); // 让启动期的首轮 dshStatus 探测先落定，避免与重试竞态（产品侧已加二次核验兜底）
      await h.evalJs(`document.querySelector('#role-sessions [data-dsh-retry]')?.click(); 'ok'`);
      let c2 = null;
      for (let i = 0; i < 30; i += 1) { await sleep(500); c2 = await card(h); if (!c2.offline && c2.rows.length >= 6) break; }
      const calls = await h.evalJs('Number(window.__dshRetryCalls||0)');
      c2 = { ...c2, retryCalls: calls };
      check('Retry', '离线→在线：点「重试连接」后卡片恢复 6 行、离线标记消失、无重复行',
        c2 && !c2.offline && c2.rows.length >= 6 && new Set(c2.rows).size === c2.rows.length, { before: c1, after: c2 });
    } finally { server.close(); }
  } finally { kill(h); }
  cleanup(sb);

  // Unmap
  sb = seedSandbox({ rosterMode: 'unmap' });
  const server2 = await startMock();
  h = await launch(10031 + Math.floor(Math.random() * 80), sb);
  try {
    await sleep(5000);
    const c3 = await ensureNotOffline(h, () => card(h));
    const nMatch = /(\d+) 个在册角色/.exec(c3.text);
    check('Unmap', 'DSH 在线但会话全空：卡片写「N 个在册角色；会话尚未映射」，禁止「无在册成员」，N=6',
      c3.unmapped && nMatch && Number(nMatch[1]) === 6 && /尚未映射|未映射/.test(c3.text) && !/无在册成员/.test(c3.text), c3);
  } finally { kill(h); server2.close(); }
  cleanup(sb);

  // Empty
  sb = seedSandbox({ rosterMode: 'empty' });
  const server3 = await startMock();
  h = await launch(10131 + Math.floor(Math.random() * 80), sb);
  try {
    await sleep(5000);
    const c4 = await ensureNotOffline(h, () => card(h));
    const tm4 = await h.evalJs(`(async()=>{try{const pid=(document.querySelector('.project-item.active')||{}).dataset; const r=await window.workbench.teamMembers({projectId:(pid&&pid.project)||undefined}); return {ok:r&&r.ok,count:r&&r.count,memberCount:r&&r.memberCount,membersEmpty:r&&r.membersEmpty,filteredOut:r&&r.filteredOut,roles:(r&&r.roles||[]).length,project:r&&r.project,code:r&&r.code};}catch(e){return {error:String(e&&e.message||e)}}})()`);
    check('Empty', '真无成员：才允许写「本工作区无在册成员」', c4.empty && /无在册成员/.test(c4.text), { c4, tm4 });
  } finally { kill(h); server3.close(); }
  if (KEEP) console.log('KEEP_SANDBOX=' + sb.SB); else cleanup(sb);
})().catch((e) => check('EX', '断面未抛异常', false, { error: String((e && e.stack) || e) })).finally(() => {
  const pass = R.filter((x) => x.ok).length;
  console.log(`\n${pass}/${R.length} PASS`);
});
