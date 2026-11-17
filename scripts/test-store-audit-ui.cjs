#!/usr/bin/env node
'use strict';
/**
 * test-store-audit-ui.cjs —— 8be3 端到端：真窗口改一次状态 → 写入审计.jsonl 新增行且 sha 对得上
 *
 * 隔离：AWB_DATA_DIR 独立数据根（预置真实 store 的只读副本）+ TEAM_ROOT 沙盘副本 + TEAM_SELFTEST=1；
 * 触发：CDP 调 window.workbench.uiZoomSet()（该 IPC 会 readStore→改 ui.zoom→writeStore）；
 * 断言：审计文件出现、8 键齐全、sha 是 64 hex、末行 sha/bytes 与当前 store 一致、
 *       没有「无变化」行（prevSha===sha），且真实 data/userdata/workbench.json 的 sha+mtime 未被碰。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PNAME = '工作台改造修复';
const SB = path.join(ROOT, '_tmp', `store-audit-ui-${process.pid}-${Date.now()}`);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const AUDIT = path.join(DATA, 'userdata', '写入审计.jsonl');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const REAL_AUDIT = path.join(ROOT, 'data', 'userdata', '写入审计.jsonl');
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const PORT = Number(process.env.AWB_STORE_AUDIT_PORT || (9471 + (process.pid % 20)));

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + JSON.stringify(detail).slice(0, 300)}`);
}
const statOf = (file) => {
  try { const st = fs.statSync(file); return { sha: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), mtimeMs: st.mtimeMs, bytes: st.size }; }
  catch { return null; }
};
function httpJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
  });
}
async function waitTarget(port, ms, pick) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await httpJson(`http://127.0.0.1:${port}/json/list`);
    if (Array.isArray(list)) { const hit = list.find(pick); if (hit && hit.webSocketDebuggerUrl) return hit; }
    await sleep(400);
  }
  return null;
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); }
    });
  }
  send(method, params = {}, ms = 30000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, ms);
    });
  }
  async evaluate(expr, ms = 30000) {
    try {
      const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, ms);
      if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text).slice(0, 300) };
      return out && out.result ? out.result.value : undefined;
    } catch (e) { return { __cdperror: String((e && e.message) || e) }; }
  }
}

(async () => {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态', '项目', PNAME), { recursive: true });
  const team = JSON.parse(fs.readFileSync(REAL_TEAM, 'utf8').replace(/^\uFEFF/, ''));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = PNAME;
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  const store = JSON.parse(fs.readFileSync(REAL_STORE, 'utf8').replace(/^\uFEFF/, ''));
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n', 'utf8');

  const before = { realStore: statOf(REAL_STORE), realAudit: statOf(REAL_AUDIT), realTeam: statOf(REAL_TEAM) };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], {
    cwd: ROOT, env: { ...process.env, AWB_DATA_DIR: DATA, TEAM_ROOT: TEAM, TEAM_SELFTEST: '1' }, stdio: 'ignore', windowsHide: false,
  });
  const target = await waitTarget(PORT, 90000, (i) => i && i.type === 'page' && String(i.url || '').includes('renderer/index.html'));
  if (!target) { check('真窗口启动', false, `端口 ${PORT} 未等到 renderer`); try { child.kill(); } catch { /* ignore */ } process.exit(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => { ws.addEventListener('open', r, { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  let ready = false;
  for (let i = 0; i < 120; i += 1) {
    ready = await cdp.evaluate('Boolean(window.workbench && window.workbench.uiZoomSet)') === true;
    if (ready) break;
    await sleep(500);
  }
  check('真窗口就绪且暴露 uiZoomSet（会写 workbench.json）', ready === true);
  const z1 = await cdp.evaluate('window.workbench.uiZoomSet(1.1).then((r) => JSON.stringify(r || {})).catch((e) => "ERR:" + e)');
  await sleep(400);
  const z2 = await cdp.evaluate('window.workbench.uiZoomSet(1.2).then((r) => JSON.stringify(r || {})).catch((e) => "ERR:" + e)');
  await sleep(700);
  check('两次 uiZoomSet 都执行（触发两次 store 写）', String(z1).indexOf('ERR:') !== 0 && String(z2).indexOf('ERR:') !== 0, { z1, z2 });

  const rows = (() => {
    try { return fs.readFileSync(AUDIT, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  })();
  const cur = statOf(STORE);
  check('端到端：改一次状态 → 写入审计.jsonl 有行（每次变更至少 1 行）', rows.length >= 1, { rows: rows.length, audit: AUDIT });
  check('每行 8 键齐全且 actor=shell、sha 是 64 hex',
    rows.length > 0 && rows.every((r) => Object.keys(r).sort().join(',') === 'actor,at,bytes,case,file,kind,prevSha,sha'
      && r.actor === 'shell' && /^[0-9a-f]{64}$/.test(r.sha)),
    rows.slice(0, 2));
  const last = rows[rows.length - 1] || {};
  check('末行 sha/bytes 与当前 workbench.json 一致（sha 对得上）',
    Boolean(cur) && last.sha === cur.sha && Number(last.bytes) === Number(cur.bytes),
    { lastSha: String(last.sha).slice(0, 12), curSha: cur && cur.sha.slice(0, 12), lastBytes: last.bytes, curBytes: cur && cur.bytes });
  check('没有「无变化」行（prevSha===sha 不写）', rows.every((r) => !r.prevSha || r.prevSha !== r.sha), rows.map((r) => r.prevSha === r.sha));

  try { cdp.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ }
  await sleep(900);
  try { ws.close(); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
  await sleep(700);
  try { if (child.pid && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }

  const after = { realStore: statOf(REAL_STORE), realAudit: statOf(REAL_AUDIT), realTeam: statOf(REAL_TEAM) };
  check('隔离：真实 data/userdata/workbench.json 与 团队.json 未被碰',
    JSON.stringify(before.realStore) === JSON.stringify(after.realStore) && JSON.stringify(before.realTeam) === JSON.stringify(after.realTeam),
    { store: before.realStore && before.realStore.sha.slice(0, 12) === after.realStore.sha.slice(0, 12), teamSame: JSON.stringify(before.realTeam) === JSON.stringify(after.realTeam) });
  check('隔离：真实 data/userdata 下审计文件未被写（本次只在沙盘数据根写）',
    JSON.stringify(before.realAudit) === JSON.stringify(after.realAudit), { before: before.realAudit, after: after.realAudit });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSTORE_AUDIT_UI ${JSON.stringify({ ok: failed.length === 0, total: results.length, failed: failed.length, rows: rows.length })}`);
  fs.rmSync(SB, { recursive: true, force: true });
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((error) => {
  console.error('STORE_AUDIT_UI_FATAL ' + String((error && error.stack) || error));
  process.exit(1);
});
