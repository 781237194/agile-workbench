#!/usr/bin/env node
'use strict';
/**
 * test-c65a-channel-warn.cjs —— R-20261119-011310（c65a）AC5 夹具：未走团队通道告警锚点。
 * 隔离实例（AWB_DATA_DIR+TEAM_ROOT+TEAM_PROJECTS_ROOT+TEAM_WORKBENCH_JSON 四隔离）：
 *  ① 注入 1 条 running 子代理记录 + 空邮箱 → 打开团队台：`#team-drawer [data-channel-warn]` 存在且 hidden=false，文案含「未走团队通道」；
 *  ② 删除子代理记录后重开团队台 → 同一元素仍存在且 hidden=true（不靠删元素）。
 * 用法：node scripts/test-c65a-channel-warn.cjs [--out <dir>]；只 taskkill /PID 自起 child.pid。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const PNAME = '工作台改造修复';
const SB = path.join(ROOT, '_tmp', `c65a-${process.pid}-${Date.now()}`);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const PROJ = path.join(SB, '项目');
const PORT = Number(process.env.AWB_C65A_PORT || (9700 + (process.pid % 10)));
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', PNAME, '程序员B', '产出', '证据-c65a'); })();
const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) { rows.push({ name, ok: Boolean(ok), detail: ok ? null : detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 400)}`); }
function httpJson(url) { return new Promise((resolve) => { const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.setTimeout(3000, () => { req.destroy(); resolve(null); }); }); }
async function waitTarget(port, ms, pick) { const end = Date.now() + ms; while (Date.now() < end) { const list = await httpJson(`http://127.0.0.1:${port}/json/list`); if (Array.isArray(list)) { const hit = list.find(pick); if (hit && hit.webSocketDebuggerUrl) return hit; } await sleep(400); } return null; }
class Cdp { constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(String(e.data)); } catch { return; } if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } }); } send(method, params = {}, ms = 60000) { const id = ++this.seq; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, ms); }); } async evaluate(expr, ms = 60000) { try { const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms); if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || '') }; return out && out.result ? out.result.value : undefined; } catch (e) { return { __cdperror: String((e && e.message) || e) }; } } }
function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态', '项目', PNAME, '子代理'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态', '邮箱', 'pm', 'new'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态', '邮箱', 'pm', 'cur'), { recursive: true });
  fs.mkdirSync(PROJ, { recursive: true });
  const team = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8').replace(/^\uFEFF/, ''));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = PNAME;
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  // 注入 1 条 running 子代理记录（无对应 M-* 消息）
  const rec = { id: 'sub-c65a-1', role: 'pm', status: 'running', startedAt: new Date().toISOString(), purpose: '夹具：子代理活动无 M-*', ttlMinutes: 30 };
  fs.writeFileSync(path.join(TEAM, '状态', '项目', PNAME, '子代理', '记录.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
  const store = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'userdata', 'workbench.json'), 'utf8').replace(/^\uFEFF/, ''));
  const project = (store.projects || [])[0];
  project.id = 'P-c65a'; project.name = '沙盘项目'; project.teamName = PNAME; project.path = PROJ;
  project.sessions = {}; project.workspace = { sessionIds: [] };
  store.projects = [project]; store.activeProjectId = 'P-c65a';
  fs.writeFileSync(path.join(DATA, 'userdata', 'workbench.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.mkdirSync(OUT, { recursive: true });
  return { projectId: 'P-c65a', recFile: path.join(TEAM, '状态', '项目', PNAME, '子代理', '记录.jsonl') };
}
(async () => {
  const seedInfo = seed();
  const env = { ...process.env, AWB_DATA_DIR: DATA, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJ, TEAM_WORKBENCH_JSON: path.join(DATA, 'userdata', 'workbench.json'), TEAM_SELFTEST: '1' };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });
  const target = await waitTarget(PORT, 90000, (item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
  check('W0 隔离实例启动', Boolean(target), seedInfo);
  if (target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
    const cdp = new Cdp(ws); await cdp.send('Runtime.enable');
    for (let i = 0; i < 200; i += 1) { const ok = await cdp.evaluate('document.readyState === "complete" && Boolean(window.workbench && window.workbench.channelWarn) && typeof setDrawer === "function"'); if (ok === true) break; await sleep(400); }
    const openTeam = 'setDrawer("team"); true';
    await cdp.evaluate(openTeam);
    await sleep(1200);
    const warn = await cdp.evaluate('(() => { const b = document.querySelector("#team-drawer [data-channel-warn]"); return b ? { exists: true, hidden: b.hidden, state: b.getAttribute("data-channel-warn-state"), text: String(b.textContent || "").slice(0, 120) } : { exists: false }; })()');
    check('W1 有子代理无 M-*：告警元素存在且 hidden=false', warn && warn.exists && warn.hidden === false, warn);
    check('W2 文案含「未走团队通道」', warn && /未走团队通道/.test(warn.text), warn);
    // 删除子代理记录 → 重开团队台 → 元素仍存在但 hidden=true
    try { fs.unlinkSync(seedInfo.recFile); } catch { /* ignore */ }
    await cdp.evaluate('setDrawer(null); true');
    await sleep(500);
    await cdp.evaluate(openTeam);
    await sleep(1200);
    const idle = await cdp.evaluate('(() => { const b = document.querySelector("#team-drawer [data-channel-warn]"); return b ? { exists: true, hidden: b.hidden, state: b.getAttribute("data-channel-warn-state") } : { exists: false }; })()');
    check('W3 无该状态：元素仍存在且 hidden=true（不靠删元素）', idle && idle.exists && idle.hidden === true, idle);
    try { cdp.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ }
    await sleep(700); try { ws.close(); } catch { /* ignore */ } try { child.kill(); } catch { /* ignore */ } await sleep(300); try { if (child.pid && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  }
  try { fs.writeFileSync(path.join(OUT, 'channel-warn-run.json'), JSON.stringify({ at: new Date().toISOString(), checks: rows }, null, 2) + '\n', 'utf8'); } catch { /* ignore */ }
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = rows.filter((r) => !r.ok);
  console.log('');
  console.log(`C65A-WARN ${failed.length ? 'FAIL' : 'OK'} ${JSON.stringify({ total: rows.length, pass: rows.length - failed.length, red: failed.length })}`);
  console.log('证据：' + path.join(OUT, 'channel-warn-run.json'));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('C65A-WARN ERROR ' + String((e && e.stack) || e)); process.exit(1); });
