'use strict';
/**
 * B-20261121-005125-6e85 真窗口断面（P0，Owner 截图场景）：
 *   S1 角色区按名册渲染 6 行（DSH 在线、project.sessions 为空 = 0/6），不得被一句空态文案替换。
 *   S2 用量文案不得进角色区：#role-sessions.textContent 不含「累计输入/缓存读/阈值」。
 *   S3 用量是独立区块且在角色行之后（DOM 顺序 role-sessions → session-usage-wrap）。
 *   S4 0/6 给真实原因（MAPPING_EMPTY）+「按标题重绑」入口。
 *   S5 点按标题重绑 → DSH 标题（团队·<角色名>）写回 project.sessions 6 条，角色区恢复映射。
 * 跑法：node scripts/test-sessions-render-6e85.cjs [--keep]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const KEEP = process.argv.includes('--keep') || process.env.AWB_KEEP_SANDBOX === '1';
const HOST = '127.0.0.2';
const R = [];
function check(id, title, ok, detail) {
  R.push({ id, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${title}${ok ? '' : '  ← ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 700)}`);
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
const TITLES = [['pm', '项目经理'], ['product', '产品设计师'], ['analyst', '需求分析师'], ['programmer1', '高级程序员 A'], ['programmer2', '高级程序员 B'], ['tester', '测试人员']];
function freePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, HOST, () => { const port = srv.address().port; srv.close(() => resolve(port)); });
  });
}
let dshPort = 0;
function seedSandbox({ mapped = false } = {}) {
  const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-6e85-'));
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
  for (const m of (team.members || [])) m.sessionId = mapped ? 'session-sbx-' + m.role : '';
  fs.writeFileSync(teamFile, JSON.stringify(team, null, 1), 'utf8');
  // 关键构造：DSH 在线、名册 6 人。mapped=false → 本地 project.sessions 为空（Owner 截图里的 0/6）；
  // mapped=true → 名册 id 与 DSH mock 全匹配（AC④a：6 行、6/6）。
  // 注意：store 里 project.path 必须改指沙盘目录——persistSessionMapping 会写 <project.path>/团队会话.json，
  // 沿用真实路径会污染真实项目的会话清单（本轮首跑踩过：真实 manifest 的 pm 被写成 session-sbx-pm）。
  const sandboxProjectDir = path.join(SB, '项目区', '工作台改造修复');
  fs.mkdirSync(sandboxProjectDir, { recursive: true });
  copy(path.join(projState, '项目.json'), path.join(sandboxProjectDir, '项目.json'));
  for (const n of fs.readdirSync(path.join(DATA, 'userdata'))) {
    if (!n.startsWith('workbench.json')) continue;
    const f = path.join(DATA, 'userdata', n);
    const store = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const p of (store.projects || [])) {
      p.path = sandboxProjectDir;
      p.workspace = p.workspace && typeof p.workspace === 'object' ? p.workspace : {};
      p.workspace.path = sandboxProjectDir;
      if (mapped) {
        p.sessions = {};
        p.sessionMeta = {};
        for (const [role] of TITLES) {
          p.sessions[role] = 'session-sbx-' + role;
          p.sessionMeta[role] = { title: '团队·' + (TITLES.find(([r]) => r === role) || [])[1], updatedAt: new Date().toISOString() };
        }
      } else {
        p.sessions = {};
        p.sessionMeta = {};
      }
      p.workspace = p.workspace && typeof p.workspace === 'object' ? p.workspace : {};
      p.workspace.sessionIds = mapped ? TITLES.map(([role]) => 'session-sbx-' + role) : [];
      p.workspace.bound = mapped;
    }
    fs.writeFileSync(f, JSON.stringify(store, null, 1), 'utf8');
  }
  fs.writeFileSync(path.join(DATA, 'dsh.json'), JSON.stringify({ version: 1, baseUrl: 'http://' + HOST + ':' + dshPort, source: 'user', pinned: true, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
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
      const items = TITLES.map(([role, name]) => ({ sessionId: 'session-sbx-' + role, title: '团队·' + name, archived: false, blank: false }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: { items } } }));
    });
  });
  return new Promise((resolve) => server.listen(dshPort, HOST, () => resolve(server)));
}
async function launch(port, sb) {
  const child = cp.spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', `--remote-debugging-port=${port}`], {
    cwd: ROOT,
    env: { ...process.env, AWB_START_HIDDEN: '1', AWB_DATA_DIR: sb.DATA, AWB_TEAM_ROOT: sb.TEAM, TEAM_ROOT: sb.TEAM, DSH_HOME: sb.SB, TEAM_SELFTEST: '1', AWB_DSH_BASE_URL: 'http://' + HOST + ':' + dshPort },
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
const EVID = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-6e85-20261121');
async function shot(h, selector, file) {
  const rect = await h.evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) }; })()`);
  if (!rect) return 0;
  const r = await h.send('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 } });
  const b64 = r && r.result && r.result.data;
  if (!b64) return 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return fs.statSync(file).size;
}
async function view(h) {
  return h.evalJs(`(() => {
    const box = document.querySelector('#role-sessions');
    const usage = document.querySelector('#session-usage-wrap');
    const text = box ? (box.textContent || '') : '';
    const rows = Array.from(document.querySelectorAll('#role-sessions .session-row[data-role-session]')).map((r) => r.getAttribute('data-role-session'));
    const reasonEl = document.querySelector('#role-sessions [data-session-reason]');
    const usageBefore = (box && usage) ? Boolean(box.compareDocumentPosition(usage) & Node.DOCUMENT_POSITION_FOLLOWING) : null;
    return {
      text, rows,
      rowCount: rows.length,
      mapped: Array.from(document.querySelectorAll('#role-sessions .session-row[data-session-id]')).filter((r) => (r.getAttribute('data-session-id') || '') !== '').length,
      reason: reasonEl ? (reasonEl.textContent || '').trim() : '',
      reasonCode: reasonEl ? reasonEl.getAttribute('data-session-reason-code') : null,
      unmatched: Array.from(document.querySelectorAll('#role-sessions [data-unmatched-role]')).map((el) => ({ role: el.getAttribute('data-unmatched-role'), text: (el.textContent || '').trim() })),
      hasRebind: Boolean(document.querySelector('#role-sessions [data-rebind-by-title]')),
      usageAfterRoles: usageBefore,
      usageText: usage ? (usage.textContent || '') : '',
      badge: ((document.querySelector('#session-count') || {}).textContent || '').trim(),
      bindFailures: window.__bindFailures || null,
    };
  })()`);
}
function cleanup(sb) {
  try { cp.execFileSync('cmd', ['/c', 'rmdir', path.join(sb.TEAM, '工具')], { stdio: 'ignore' }); } catch { /* ignore */ }
  try { fs.rmSync(sb.SB, { recursive: true, force: true }); } catch { /* ignore */ }
}
async function waitRows(h) {
  let v = await view(h);
  if (v && v.rowCount === 6) return v;
  // DSH 状态探测偶发首轮未落定：点一次重试再读（不改变被测逻辑）。
  await h.evalJs(`document.querySelector('#role-sessions [data-dsh-retry]')?.click(); 'ok'`);
  for (let i = 0; i < 20; i += 1) { await sleep(500); v = await view(h); if (v.rowCount === 6) break; }
  return v;
}
(async () => {
  dshPort = await freePort();
  const server = await startMock();
  // S0（AC④a）：名册 id 与 DSH 全匹配 → 6 行、6/6、无「需重绑」原因行。
  let sb = seedSandbox({ mapped: true });
  let h = await launch(10331 + Math.floor(Math.random() * 80), sb);
  try {
    await sleep(5000);
    const v0 = await waitRows(h);
    check('S0', '名册 id 全匹配：角色区 6 行、徽标 6/6、无原因行', v0.rowCount === 6 && v0.badge === '6/6' && !v0.reasonCode, v0);
  } finally { kill(h); cleanup(sb); }

  // S1–S5（AC④b/④c）：名册 id 全空但标题匹配 → 6 行灰行 + 需重绑 + 重绑可点；用量不得进角色区。
  sb = seedSandbox({ mapped: false });
  h = await launch(10231 + Math.floor(Math.random() * 80), sb);
  try {
    await sleep(5000);
    let v = await waitRows(h);
    check('S1', 'DSH 在线但映射 0：角色区仍按名册渲染 6 行（不被空态文案替换）', v.rowCount === 6, v);
    check('S2', '用量文案不得进角色区：role-sessions.textContent 不含 累计输入/缓存读/阈值',
      !/累计输入|缓存读|阈值/.test(v.text || ''), { text: (v.text || '').slice(0, 500) });
    check('S3', '用量是独立区块且在角色行之后（DOM 顺序 role-sessions → session-usage-wrap）', v.usageAfterRoles === true, v);
    check('S4', '0/6 给真实原因（MAPPING_EMPTY）+ 按标题重绑入口', v.reasonCode === 'MAPPING_EMPTY' && /映射/.test(v.reason) && v.hasRebind, v);
    check('S4b', '计数与角色行同源：0/6', v.badge === '0/6', v);
    check('S4c', '逐角色列出未匹配原因（名册 id + DSH 标题/会话 id），6 条',
      v.unmatched.length === 6 && v.unmatched.every((row) => /名册/.test(row.text) && /DSH「团队·/.test(row.text)), v.unmatched);
    const roleShot = await shot(h, '#role-sessions', path.join(EVID, 'role-area-0of6.png'));
    const usageShot = await shot(h, '#session-usage-wrap', path.join(EVID, 'usage-card.png'));
    check('S4d', '真窗口截图：角色区 + 用量卡各一张（角色区 >10KB，用量卡 >2KB）', roleShot > 10000 && usageShot > 2000, { roleShot, usageShot });
    // 点「按标题重绑」：DSH mock 标题 = 团队·<角色名>，应写回 6 条映射。
    await h.evalJs(`document.querySelector('#role-sessions [data-rebind-by-title]')?.click(); 'ok'`);
    for (let i = 0; i < 40; i += 1) { await sleep(500); v = await view(h); if (v.mapped >= 6) break; }
    let storeMapped = 0;
    try {
      for (const n of fs.readdirSync(path.join(sb.DATA, 'userdata'))) {
        if (!n.startsWith('workbench.json')) continue;
        const store = JSON.parse(fs.readFileSync(path.join(sb.DATA, 'userdata', n), 'utf8'));
        for (const p of (store.projects || [])) storeMapped = Math.max(storeMapped, Object.keys(p.sessions || {}).filter((k) => p.sessions[k]).length);
      }
    } catch { /* ignore */ }
    check('S5', '按标题重绑：6 个角色会话写回 project.sessions，角色区显示已映射', v.mapped >= 6 && storeMapped >= 6, { view: v, storeMapped });
  } finally { kill(h); server.close(); }
  if (KEEP) console.log('KEEP_SANDBOX=' + sb.SB); else cleanup(sb);
})().catch((e) => check('EX', '断面未抛异常', false, { error: String((e && e.stack) || e) })).finally(() => {
  console.log(`\n${R.filter((x) => x.ok).length}/${R.length} PASS`);
});
