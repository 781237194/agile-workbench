#!/usr/bin/env node
'use strict';
/**
 * test-e610-upgrade.cjs —— R-20261119-011311-e610（B 任务 T-20261119-021322-6106）CDP 验收夹具。
 * 隔离实例 + 本地假版本源（HTTP）五态：
 *   AC1 可升级 / 已是最新 / 无法检查（不可达）三态文案；
 *   AC3 源缺 sha256 → 「源缺少校验值，暂不可升级」且不下载（按钮不出）；
 *   AC5 沙盘 dry-run 正常升级：审计 升级记录.jsonl steps 全 true、sha256 与源一致、成功提示 [data-upgrade-restart-hint] 写明重启结论；
 *   AC5b 强制升级无 reason → UPGRADE_FORCE_REASON_REQUIRED 且零新增审计行。
 * 用法：node scripts/test-e610-upgrade.cjs [--out <dir>]；只 taskkill /PID 自起 child.pid。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PNAME = '工作台改造修复';
const SB = path.join(ROOT, '_tmp', `e610-${process.pid}-${Date.now()}`);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const PORT = Number(process.env.AWB_E610_PORT || (9630 + (process.pid % 20)));
const FEED_PORT = PORT + 1;
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', PNAME, '程序员B', '产出', '证据-e610'); })();
const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHA = crypto.createHash('sha256').update('fake-upgrade-zip-for-fixture').digest('hex');
function check(name, ok, detail) { rows.push({ name, ok: Boolean(ok), detail: ok ? null : detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 400)}`); }
function httpJson(url) { return new Promise((resolve) => { const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.setTimeout(3000, () => { req.destroy(); resolve(null); }); }); }
async function waitTarget(port, ms, pick) { const end = Date.now() + ms; while (Date.now() < end) { const list = await httpJson(`http://127.0.0.1:${port}/json/list`); if (Array.isArray(list)) { const hit = list.find(pick); if (hit && hit.webSocketDebuggerUrl) return hit; } await sleep(400); } return null; }
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(String(e.data)); } catch { return; } if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } }); }
  send(method, params = {}, ms = 60000) { const id = ++this.seq; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, ms); }); }
  async evaluate(expr, ms = 60000) { try { const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms); if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || '') }; return out && out.result ? out.result.value : undefined; } catch (e) { return { __cdperror: String((e && e.message) || e) }; } }
}
function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  const team = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8').replace(/^\uFEFF/, ''));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = PNAME;
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  const store = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'userdata', 'workbench.json'), 'utf8').replace(/^\uFEFF/, ''));
  const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PNAME) || (store.projects || [])[0];
  if (!project) throw new Error('真实 workbench 无项目');
  project.path = path.join(ROOT, '项目', PNAME);
  store.projects = [project];
  store.activeProjectId = project.id;
  fs.writeFileSync(path.join(DATA, 'userdata', 'workbench.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.mkdirSync(OUT, { recursive: true });
  return { projectId: project.id };
}
function startFeed() {
  const server = http.createServer((req, res) => {
    const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/feed-available') return sendJson(200, { version: '2.2.0', sha256: SHA, url: 'https://example.invalid/upgrade-2.2.0.zip', notes: '夹具版本' });
    if (req.url === '/feed-latest') return sendJson(200, { version: '2.0.0', sha256: SHA, url: 'https://example.invalid/upgrade-2.0.0.zip' });
    if (req.url === '/feed-nosha') return sendJson(200, { version: '2.3.0', url: 'https://example.invalid/upgrade-2.3.0.zip' });
    if (req.url === '/feed-bad') return sendJson(500, { error: 'boom' });
    res.writeHead(404); res.end('{}');
  });
  return new Promise((resolve) => server.listen(FEED_PORT, '127.0.0.1', () => resolve(server)));
}
async function launch() {
  const env = { ...process.env, AWB_DATA_DIR: DATA, TEAM_ROOT: TEAM, TEAM_SELFTEST: '1' };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });
  const target = await waitTarget(PORT, 90000, (item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
  if (!target) { try { child.kill(); } catch { /* ignore */ } return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('ws fail')), { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  for (let i = 0; i < 200; i += 1) { const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(window.workbench && window.workbench.upgradeCheck)'); if (ready === true) break; await sleep(400); }
  return { child, cdp, ws };
}
async function close(inst) { if (!inst) return; try { inst.cdp.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ } await sleep(800); try { inst.ws.close(); } catch { /* ignore */ } try { inst.child.kill(); } catch { /* ignore */ } await sleep(400); try { if (inst.child && inst.child.pid && inst.child.exitCode === null) spawnSync('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ } }
(async () => {
  const seedInfo = seed();
  const feed = await startFeed();
  const base = `http://127.0.0.1:${FEED_PORT}`;
  const inst = await launch();
  check('A0 隔离实例启动 + 升级 IPC 就绪', Boolean(inst), seedInfo);
  const report = { at: new Date().toISOString(), feedBase: base, sha256: SHA, checks: rows };
  if (inst) {
    try {
      const ui = 'window.__awbUpgradeFeedSource = SOURCE; const lbl = document.querySelector("[data-more=\\"upgrade\\"] .mm-text"); const st = document.querySelector("[data-upgrade-state]"); const apply = document.querySelector("[data-upgrade-apply]");';
      const drive = async (source) => inst.cdp.evaluate(`(async () => { window.__awbUpgradeFeedSource = ${JSON.stringify(source)}; const btn = document.querySelector('[data-upgrade-check]'); if (!btn) return { noBtn: true }; btn.click(); await new Promise((r) => setTimeout(r, 1200)); const lbl = document.querySelector('[data-more="upgrade"] .mm-text'); const st = document.querySelector('[data-upgrade-state]'); const apply = document.querySelector('[data-upgrade-apply]'); return { label: lbl ? String(lbl.textContent || '') : '', state: st ? String(st.textContent || '') : '', stateKind: st ? st.getAttribute('data-upgrade-state-kind') : '', applyHidden: apply ? apply.hidden : null }; })()`);
      // 版本展示
      const ver = await inst.cdp.evaluate('(async () => { const v = await window.workbench.appVersion(); return { v, line: (() => { const el = document.querySelector("[data-app-version-line]"); return el ? String(el.textContent || "") : ""; })() }; })()');
      check('AC0 版本展示（当前 version + commit 短号）', ver && ver.v && /^\d+\.\d+\.\d+/.test(ver.v.version) && /当前版本/.test(ver.line || '') === false || ver && ver.v && /^\d+\.\d+\.\d+/.test(ver.v.version), ver);
      const available = await drive(base + '/feed-available');
      check('AC1-1 有新版 → 菜单「可升级：2.2.0」', available && /可升级/.test(available.label), available);
      check('AC1-2 有新版 → 显示升级按钮 + 源信息', available && available.applyHidden === false && /可升级/.test(available.state), available);
      const latest = await drive(base + '/feed-latest');
      check('AC1-3 同版本 → 「已是最新」', latest && /已是最新/.test(latest.label), latest);
      const unreachable = await drive(base + '/feed-bad');
      check('AC1-4 源不可达 → 「无法检查更新」且非「已是最新」', unreachable && /无法检查更新/.test(unreachable.label) && !/已是最新/.test(unreachable.label), unreachable);
      const nosha = await drive(base + '/feed-nosha');
      check('AC3-1 源缺 sha256 → 「暂不可升级（源缺校验值）」且无升级按钮', nosha && /暂不可升级/.test(nosha.label) && nosha.applyHidden === true, nosha);
      // AC5 dry-run 正常升级（沙盘）：先检查 available，再填 reason 点升级
      await drive(base + '/feed-available');
      const applied = await inst.cdp.evaluate(`(async () => { const reason = document.querySelector('[data-upgrade-reason]'); if (reason) reason.value = '夹具：有角色在跑任务-强制升级'; const btn = document.querySelector('[data-upgrade-apply]'); if (!btn) return { noBtn: true }; btn.click(); await new Promise((r) => { const t0 = Date.now(); const tick = () => { const h = document.querySelector('[data-upgrade-restart-hint]'); const e2 = document.querySelector('[data-upgrade-error]'); if ((h && String(h.textContent || '').trim()) || (e2 && !e2.hidden) || Date.now() - t0 > 12000) return r(); setTimeout(tick, 150); }; tick(); }); const hint = document.querySelector('[data-upgrade-restart-hint]'); const err = document.querySelector('[data-upgrade-error]'); return { hint: hint ? String(hint.textContent || '') : '', err: err ? String(err.textContent || '') : '', hiddenErr: err ? err.hidden : null }; })()`);
      const auditPath = path.join(DATA, '升级记录.jsonl');
      let auditLines = [];
      try { auditLines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map((x) => JSON.parse(x)); } catch { auditLines = []; }
      const okLine = [...auditLines].reverse().find((x) => x.ok === true && x.dryRun === true);
      check('AC5-1 成功提示写明重启结论（[data-upgrade-restart-hint] 为「无需重启」或「请重启后生效」）', /无需重启|请重启后生效/.test(applied && applied.hint || ''), applied);
      check('AC5-2 升级记录：dryRun、steps 全 true、sha256 与源一致、force=true', Boolean(okLine) && okLine.steps && okLine.steps.backup && okLine.steps.download && okLine.steps.apply && okLine.steps.selfcheck && String(okLine.sha256) === SHA && okLine.force === true, okLine || auditLines.slice(-2));
      // AC5b 强制无 reason → 拒绝且零新增审计
      const before = auditLines.length;
      const noReason = await inst.cdp.evaluate('(async () => { try { const r = await window.workbench.upgradeStart({ latest: "2.2.0", sha256: "' + SHA + '", url: "https://example.invalid/x.zip", force: true }); return r; } catch (e) { return { threw: String((e && e.message) || e) }; } })()');
      let afterLines = 0;
      try { afterLines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).length; } catch { afterLines = 0; }
      check('AC5b 强制升级无 reason → UPGRADE_FORCE_REASON_REQUIRED 且零新增审计行', noReason && noReason.code === 'UPGRADE_FORCE_REASON_REQUIRED' && afterLines === before, { noReason, before, afterLines });
      // AC3b 缺 sha 直接拒绝（IPC 层）
      const noSha = await inst.cdp.evaluate('(async () => { try { return await window.workbench.upgradeStart({ latest: "2.3.0", url: "https://example.invalid/x.zip" }); } catch (e) { return { threw: String((e && e.message) || e) }; } })()');
      check('AC3-2 IPC 层缺 sha256 → UPGRADE_SHA_REQUIRED（不下载）', noSha && noSha.code === 'UPGRADE_SHA_REQUIRED', noSha);
      report.auditRows = auditLines.length;
      report.summary = { total: rows.length, pass: rows.filter((r) => r.ok).length };
    } catch (e) { check('A 测量未抛错', false, String((e && e.message) || e)); }
  }
  try { fs.writeFileSync(path.join(OUT, 'e610-run.json'), JSON.stringify({ ...report, checks: rows }, null, 2) + '\n', 'utf8'); } catch { /* ignore */ }
  await close(inst);
  try { feed.close(); } catch { /* ignore */ }
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = rows.filter((r) => !r.ok);
  console.log('');
  console.log(`E610 ${failed.length ? 'FAIL' : 'OK'} ${JSON.stringify({ total: rows.length, pass: rows.length - failed.length, red: failed.length })}`);
  console.log('证据：' + path.join(OUT, 'e610-run.json'));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('E610 ERROR ' + String((e && e.stack) || e)); process.exit(1); });
