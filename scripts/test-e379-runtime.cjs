#!/usr/bin/env node
'use strict';
/**
 * e379 运行期验证（T-20261119-015112-968d ②③）：
 * 起**隔离实例**（AWB_DATA_DIR 独立、团队沙盘），用 CDP 验证：
 *   ① window.workbench.dshCapability() 返回 ok 且 data/dsh-capability.json 落盘（ok/method/httpStatus/sessionsCount/at）
 *   ② window.workbench.dshPin() 把当前地址写成 source:user / pinned:true（data/dsh.json）
 * 只杀自己 spawn 的 child.pid（P0 工装安全）；真实 workbench.json / 团队.json 前后 sha256 不变。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const EV = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-e379');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9986;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
const realTeam = path.join(ROOT, '团队', '状态', '团队.json');
const realWb = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const before = { team: sha(realTeam), wb: sha(realWb) };

const SB = path.join(ROOT, '_tmp', `e379-runtime-${process.pid}-${Date.now().toString(36)}`);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const results = [];
const ok = (c, name, d) => { results.push({ name, ok: !!c, detail: c ? undefined : d }); console.log(`${c ? 'PASS' : 'FAIL'}  ${name}${c ? '' : ' :: ' + JSON.stringify(d)}`); if (!c) process.exitCode = 1; };

function copyDir(src, dst, filter) { fs.mkdirSync(dst, { recursive: true }); for (const e of fs.readdirSync(src, { withFileTypes: true })) { const a = path.join(src, e.name); const b = path.join(dst, e.name); if (filter && filter(a)) continue; if (e.isDirectory()) copyDir(a, b, filter); else fs.copyFileSync(a, b); } }
function getJson(p) { return new Promise((res, rej) => { const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 2500 }, (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }); req.on('error', rej); req.on('timeout', () => req.destroy(new Error('timeout'))); }); }
class WS {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  connect() { return new Promise((res, rej) => { this.ws = new WebSocket(this.url); this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error('ws error')); this.ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (!m.id) return; const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error).slice(0, 200))) : p.resolve(m.result); }; this.ws.onclose = () => { for (const p of this.pending.values()) p.reject(new Error('closed')); this.pending.clear(); }; }); }
  send(method, params = {}, t = 60000) { const id = ++this.id; return new Promise((res, rej) => { const timer = setTimeout(() => { this.pending.delete(id); rej(new Error('timeout ' + method)); }, t); this.pending.set(id, { resolve: (v) => { clearTimeout(timer); res(v); }, reject: (e) => { clearTimeout(timer); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function main() {
  fs.mkdirSync(EV, { recursive: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  copyDir(path.join(ROOT, '团队'), TEAM, (p) => /[\\/]邮箱([\\/]|$)/.test(p) || /[\\/]锁([\\/]|$)/.test(p));
  fs.copyFileSync(realWb, path.join(DATA, 'userdata', 'workbench.json'));
  const env = { ...process.env, AWB_DATA_DIR: DATA, AWB_STORE: path.join(DATA, 'userdata', 'workbench.json'), TEAM_ROOT: TEAM, AWB_TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(TEAM, '状态', '项目'), TEAM_SELFTEST: '1', AWB_BOARD_PREGEN_MS: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const pid = child.pid;
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  let cdp = null;
  try {
    let list = null;
    for (let i = 0; i < 60; i += 1) { try { list = await getJson('/json/list'); if (Array.isArray(list) && list.some((t) => t.type === 'page')) break; } catch { /* wait */ } await sleep(400); }
    const page = (list || []).find((t) => t.type === 'page' && /renderer[\\/]index\.html/i.test(String(t.url || ''))) || (list || []).find((t) => t.type === 'page');
    if (!page) throw new Error('找不到渲染层页面（CDP）');
    cdp = new WS(page.webSocketDebuggerUrl); await cdp.connect();
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    const evalJs = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 120000 });
      if (r && r.exceptionDetails) throw new Error('evaluate: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r && r.result ? r.result.value : null;
    };
    for (let i = 0; i < 60; i += 1) { const ready = await evalJs('Boolean(window.workbench && window.workbench.dshCapability)'); if (ready) break; await sleep(300); }
    const cap = await evalJs('window.workbench.dshCapability()');
    ok(cap && cap.ok && cap.record, '① dsh:capability IPC 返回 ok', { cap: JSON.stringify(cap || {}).slice(0, 300) });
    const rec = (cap && cap.record) || {};
    ok(rec.method === 'session/list' && typeof rec.httpStatus !== 'undefined' && Number.isFinite(Number(rec.sessionsCount)) && typeof rec.at === 'string', '② capability 记录字段齐全（method/httpStatus/sessionsCount/at）', rec);
    ok(rec.ok === true && Number(rec.sessionsCount) >= 1, '③ 探针可连本机 DSH 并返回会话数', { sessionsCount: rec.sessionsCount, error: rec.error });
    const capFile = path.join(DATA, 'dsh-capability.json');
    ok(fs.existsSync(capFile), '④ data/dsh-capability.json 已落盘', { capFile });
    if (fs.existsSync(capFile)) {
      const diskRec = JSON.parse(fs.readFileSync(capFile, 'utf8'));
      ok(diskRec.ok === rec.ok && diskRec.sessionsCount === rec.sessionsCount, '⑤ 落盘内容与 IPC 返回一致', { diskRec });
    }
    const pin = await evalJs('window.workbench.dshPin()');
    ok(pin && pin.ok === true && typeof pin.baseUrl === 'string' && pin.baseUrl.length > 0, '⑥ dsh:pin-endpoint 记住当前地址', { pin: JSON.stringify(pin || {}).slice(0, 300) });
    const dshJson = path.join(DATA, 'dsh.json');
    let cfg = null;
    try { cfg = JSON.parse(fs.readFileSync(dshJson, 'utf8')); } catch { cfg = null; }
    ok(!!cfg && cfg.source === 'user' && cfg.pinned === true && String(cfg.baseUrl || '').startsWith('http'), '⑦ dsh.json 写入 source:user / pinned:true', { cfg });
    const status = await evalJs('window.workbench.dshStatus()');
    ok(status && status.status && status.status.online === true, '⑧ dsh:status 仍在线（未破坏既有链路）', { status: JSON.stringify(status || {}).slice(0, 260) });
    ok(/\[dsh-capability\]/.test(log) && /DSH 互通能力：/.test(log), '⑨ 启动日志打印「DSH 互通能力：有/无」', { tail: log.slice(-300) });
  } finally {
    fs.writeFileSync(path.join(EV, 'run-runtime.json'), JSON.stringify({ at: new Date().toISOString(), sandbox: path.relative(ROOT, SB), results, pass: results.every((r) => r.ok), isolation: { realTeamSame: sha(realTeam) === before.team, realWbSame: sha(realWb) === before.wb }, logTail: log.slice(-1200) }, null, 2) + '\n', 'utf8');
    console.log(`\nE379_RUNTIME ${results.filter((r) => r.ok).length}/${results.length} PASS`);
    try { if (cdp) cdp.close(); } catch { /* ignore */ }
    try { if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    if (process.env.AWB_E379_KEEP === '1') console.log('KEEP_SANDBOX ' + SB);
    else { try { fs.rmSync(SB, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 }); } catch { /* ignore */ } }
  }
}
main().catch((e) => { console.error('E379_RUNTIME_FAILED ' + ((e && e.message) || e).slice(0, 300)); process.exitCode = 2; });
