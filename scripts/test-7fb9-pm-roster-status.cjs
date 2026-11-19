#!/usr/bin/env node
'use strict';
/**
 * test-7fb9-pm-roster-status.cjs —— B-20261119-133233-7fb9（P1）：
 * 左侧六角色里「项目经理」永显「已绑定（会话待激活）·待激活」，其他角色「已就绪」。
 *
 * 根因：main.js 的 PM 身份对齐在**正常分支**恒发 state='pending_activation'（只要 pm 有 sessionId），
 * 渲染层又只给 PM 行加 [data-role-bound-session]/[data-role-binding-state] 并写「待激活」。
 * 修法：正常分支只发 ok；六角色状态统一由 team:members 的 memberStateOf 四态判定，PM 行与其他行同口径。
 *
 * 夹具：隔离 Electron + 沙盘团队/状态；①口径一致：PM 行状态文本必须与其他五角色相同（已就绪），且全页无「待激活」；
 *       ②真正待激活/缺会话：把沙盘名册 pm sessionId 清空 → PM 行必须显示可读原因（未就绪（缺会话）），不静默。
 * 用法：node scripts/test-7fb9-pm-roster-status.cjs [--out <dir>]；只 taskkill /PID 自己 spawn 的 child.pid。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PNAME = '工作台改造修复';
const SB = path.join(ROOT, '_tmp', `7fb9-${process.pid}-${Date.now()}`);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const PORT = Number(process.env.AWB_7FB9_PORT || (9690 + (process.pid % 20)));
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', PNAME, '程序员B', '产出', '证据-7fb9'); })();
const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) { rows.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' :: ' + String(JSON.stringify(detail)).slice(0, 500))); }
function httpJson(url) { return new Promise((resolve) => { const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.setTimeout(2000, () => { try { req.destroy(); } catch { /* ignore */ } resolve(null); }); }); }
async function waitTarget(port, ms, pick) { const end = Date.now() + ms; while (Date.now() < end) { const list = await httpJson(`http://127.0.0.1:${port}/json/list`); if (Array.isArray(list)) { const hit = list.find(pick); if (hit) return hit; } await sleep(300); } return null; }
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(String(e.data)); } catch { return; } const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); }); }
  send(method, params = {}, ms = 60000) { const id = ++this.seq; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout ' + method)); } }, ms); }); }
  async evaluate(expr, ms = 60000) { const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms); if (out && out.exceptionDetails) throw new Error('page exception: ' + String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text).slice(0, 400)); return out && out.result ? out.result.value : undefined; }
}
function seed(clearPmSession) {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  const team = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8').replace(/^\uFEFF/, ''));
  team.activeProject = PNAME;
  for (const m of team.members || []) { if (!m.sessionId) m.sessionId = 'session-fixture-' + String(m.role || 'x'); }
  if (clearPmSession) { const pm = (team.members || []).find((m) => String(m.role || '') === 'pm'); if (pm) pm.sessionId = ''; }
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  const store = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'userdata', 'workbench.json'), 'utf8').replace(/^\uFEFF/, ''));
  const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PNAME) || (store.projects || [])[0];
  project.path = path.join(ROOT, '项目', PNAME);
  // 项目映射沿用真实 workbench（与名册一致）；缺 PM 场景只清名册、保留项目映射，才能命中 memberStateOf=missing。
  if (!clearPmSession) {
    const sessions = {};
    const wsIds = [];
    for (const m of team.members || []) {
      const sid = String(m.sessionId || '');
      if (sid) { sessions[String(m.role)] = sid; wsIds.push(sid); }
    }
    project.sessions = sessions;
    project.workspace = { ...(project.workspace || {}), sessionIds: wsIds };
  }
  store.projects = [project];
  store.activeProjectId = project.id;
  fs.writeFileSync(path.join(DATA, 'userdata', 'workbench.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.mkdirSync(OUT, { recursive: true });
}
async function launch() {
  const env = { ...process.env, AWB_DATA_DIR: DATA, TEAM_ROOT: TEAM, TEAM_SELFTEST: '1' };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  const target = await waitTarget(PORT, 90000, (item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
  if (!target) { try { child.kill(); } catch { /* ignore */ } return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('ws fail')), { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  for (let i = 0; i < 200; i += 1) { const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(window.workbench && window.workbench.teamMembers)'); if (ready) break; await sleep(150); }
  // 等六行渲染
  for (let i = 0; i < 100; i += 1) { const n = await cdp.evaluate('document.querySelectorAll(".session-row[data-role-session]").length'); if (Number(n) >= 6) break; await sleep(150); }
  return { child, cdp, ws };
}
async function close(inst) {
  if (!inst) return;
  try { inst.cdp.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ }
  await sleep(800);
  try { inst.ws.close(); } catch { /* ignore */ }
  try { if (inst.child && inst.child.pid) spawnSync('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
  try { inst.child.kill(); } catch { /* ignore */ }
}
const READ_EXPR = `(() => {
  const rows = [...document.querySelectorAll('.session-row[data-role-session]')].map((row) => {
    const st = row.querySelector('.session-state');
    return {
      role: row.getAttribute('data-role-session'),
      state: st ? String(st.textContent || '').trim() : '',
      stateTitle: st ? String(st.title || '') : '',
      extra: [...row.querySelectorAll('[data-role-binding-state],[data-role-bound-session]')].map((el) => String(el.textContent || '').trim()).filter(Boolean),
    };
  });
  const pendingVisible = [...document.querySelectorAll('.session-row [data-role-binding-state]')].some((el) => !el.hidden && String(el.textContent || '').trim() === '待激活');
  return { rows, pendingVisible };
})()`;

(async () => {
  let inst = null;
  try {
    // 静态：正常分支不再发 pending_activation；PM 行不再有专属「待激活」锚点
    const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    check('S1 main.js 正常分支不再发 pending_activation（PM 有绑定≠待激活）', !/pmSid \? 'pending_activation' : 'ok'/.test(mainSrc), null);
    check('S2 正常分支 sendPmIdentityState 状态固定 ok', /sendPmIdentityState\(\{ state: 'ok', code: 'OK'/.test(mainSrc), null);
    check('S3 渲染层不再给 PM 行单独插 [data-role-bound-session]/[data-role-binding-state]', !/role\.id === 'pm' \? '<span data-role-bound-session/.test(appSrc), null);

    // ① 正常态：PM 行与其他角色同口径（已就绪），全页无「待激活」
    seed(false);
    inst = await launch();
    check('A0 隔离实例启动 + 六行渲染', Boolean(inst), null);
    if (inst) {
      const s = await inst.cdp.evaluate(READ_EXPR);
      const pm = (s.rows || []).find((r) => r.role === 'pm') || {};
      const others = (s.rows || []).filter((r) => r.role !== 'pm');
      check('A1 六角色行数=6 且含 PM', (s.rows || []).length === 6 && Boolean(pm.role), s.rows);
      check('A2 PM 行不再出现「待激活」专属文案（与其他角色同源）', Boolean(pm.state) && !/待激活/.test(pm.state) && others.length === 5 && others.every((r) => r.state === pm.state), { pm: pm.state, others: others.map((r) => r.role + ':' + r.state) });
      check('A3 PM 与其他五角色状态口径一致（同文案）', others.length === 5 && others.every((r) => r.state === pm.state), { pm: pm.state, others: others.map((r) => r.role + ':' + r.state) });
      check('A4 全页无可见「待激活」标记', s.pendingVisible === false, { pendingVisible: s.pendingVisible });
      check('A5 PM 行无专属 binding 文案残留', Array.isArray(pm.extra) && pm.extra.length === 0, { extra: pm.extra });
    }
    await close(inst); inst = null;

    // ② 真正待激活/缺会话：清空名册 pm sessionId（项目映射还在）→ PM 行显示可读原因
    seed(true);
    inst = await launch();
    if (!inst) throw new Error('second instance failed');
    const t = await inst.cdp.evaluate(READ_EXPR);
    const pm2 = (t.rows || []).find((r) => r.role === 'pm') || {};
    check('B1 名册缺 PM 会话时 PM 行≠已就绪（不静默）', pm2.state && pm2.state !== '已就绪', pm2);
    check('B2 PM 行给出可读原因（未就绪（缺会话）且 title 说明名册无成员会话）', pm2.state === '未就绪（缺会话）' && /名册无该成员会话/.test(String(pm2.stateTitle || '')), pm2);
    const others2 = (t.rows || []).filter((r) => r.role !== 'pm');
    check('B3 其他五角色不受影响（彼此同口径，且都不是 PM 专属待激活）', others2.length === 5 && others2.every((r) => r.state === others2[0].state) && others2.every((r) => !/待激活/.test(r.state)), others2.map((r) => r.role + ':' + r.state));
    fs.writeFileSync(path.join(OUT, '7fb9-pm-roster-status-run.json'), JSON.stringify({ at: new Date().toISOString(), normal: rows.slice(3), checks: rows }, null, 2) + '\n', 'utf8');
  } catch (e) {
    check('运行未抛错', false, String((e && e.stack) || e).slice(0, 600));
  } finally {
    await close(inst);
    try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(path.join(OUT, '7fb9-pm-roster-status-run.json'))) fs.writeFileSync(path.join(OUT, '7fb9-pm-roster-status-run.json'), JSON.stringify({ at: new Date().toISOString(), checks: rows }, null, 2) + '\n', 'utf8');
  const failed = rows.filter((r) => !r.ok);
  console.log('\n7FB9-PM-ROSTER ' + (failed.length ? 'FAIL' : 'OK') + ' ' + JSON.stringify({ total: rows.length, pass: rows.length - failed.length, red: failed.length }));
  console.log('证据：' + path.join(OUT, '7fb9-pm-roster-status-run.json'));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('7FB9 ERROR ' + String((e && e.stack) || e)); process.exit(1); });
