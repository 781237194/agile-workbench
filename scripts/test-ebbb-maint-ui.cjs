#!/usr/bin/env node
'use strict';
/**
 * test-ebbb-maint-ui.cjs — B-20261120-163528-ebbb（P0）真窗口断面（AC④）
 *
 * 沙盘：隔离实例（AWB_DATA_DIR/AWB_STORE/AWB_TEAM_ROOT/TEAM_ROOT/TEAM_PROJECTS_ROOT）+
 *      假安装树（package.json + start.cmd + src/main.js + 项目/ + data/）+ AWB_MAINT_SANDBOX=1
 *      → 打开「更多」菜单 → 点「一键重置」「彻底卸载」的干跑
 *      → 断言：结果区给出判定(DRY_RUN)+待处理项数、清单非空、文案不含「失败」；
 *             <假安装树>/install-logs/install-<ts>.log 存在且非 0 字节（含 命令/退出码/耗时）。
 *
 * 用法：node scripts/test-ebbb-maint-ui.cjs [--json] [--out <dir>]
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PNAME = '工作台改造修复';
const SB = path.join(ROOT, '_tmp', `ebbb-ui-${process.pid}-${Date.now()}`);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目区');
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const FAKE = path.join(SB, 'fake-root');
const LOGDIR = path.join(FAKE, 'install-logs');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const REAL_TEAM_JSON = path.join(ROOT, '团队', '状态', '团队.json');
const PORT = Number(process.env.AWB_EBBB_PORT || (9620 + (process.pid % 30)));
const JSON_OUT = process.argv.includes('--json');
const OUT = (() => { const i = process.argv.indexOf('--out'); return i >= 0 ? path.resolve(process.argv[i + 1]) : ''; })();
const ROWS = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 600)}`);
}
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
  send(method, params = {}, ms = 40000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, ms);
    });
  }
  async evaluate(expr, ms = 40000) {
    try {
      const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, ms);
      if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || '') };
      return out && out.result ? out.result.value : undefined;
    } catch (e) { return { __cdperror: String((e && e.message) || e) }; }
  }
}

function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  fs.mkdirSync(path.join(PROJECTS, PNAME), { recursive: true });
  fs.mkdirSync(path.join(FAKE, 'src'), { recursive: true });
  fs.mkdirSync(path.join(FAKE, '项目', '演示项目'), { recursive: true });
  fs.mkdirSync(path.join(FAKE, 'data', 'userdata'), { recursive: true });
  fs.writeFileSync(path.join(FAKE, 'package.json'), JSON.stringify({ name: 'pm-workbench', version: '0.0.0-fixture', scripts: { start: 'node scripts/run-electron.cjs .' } }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(FAKE, 'start.cmd'), '@echo off\r\nrem fixture\r\n', 'utf8');
  fs.writeFileSync(path.join(FAKE, 'src', 'main.js'), '// fixture\n', 'utf8');
  fs.writeFileSync(path.join(FAKE, '项目', '演示项目', 'README.md'), 'fixture\n', 'utf8');
  fs.writeFileSync(path.join(FAKE, 'data', 'userdata', 'workbench.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(FAKE, 'data', 'keep.txt'), 'fixture data\n', 'utf8');
  try { fs.symlinkSync(path.join(ROOT, '团队', '工具'), path.join(TEAM, '工具'), 'junction'); } catch { /* ignore */ }
  for (const name of ['团队宪法.md', '项目铁律.md']) { try { fs.copyFileSync(path.join(ROOT, '团队', name), path.join(TEAM, name)); } catch { /* ignore */ } }
  const team = JSON.parse(fs.readFileSync(REAL_TEAM_JSON, 'utf8').replace(/^\uFEFF/, ''));
  team.activeProject = PNAME;
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  fs.mkdirSync(path.join(TEAM, '状态', '项目', PNAME), { recursive: true });
  fs.writeFileSync(path.join(TEAM, '状态', '项目', PNAME, '唤醒.jsonl'), '', 'utf8');
  const store = JSON.parse(fs.readFileSync(REAL_STORE, 'utf8').replace(/^\uFEFF/, ''));
  const project = (store.projects || []).find((item) => item && String(item.teamName || item.name || '') === PNAME);
  if (!project) throw new Error('真实 workbench.json 缺少项目 ' + PNAME);
  project.path = path.join(PROJECTS, PNAME);
  project.workspace = { ...(project.workspace || {}), path: project.path };
  store.projects = [project];
  store.activeProjectId = project.id;
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n', 'utf8');
}
async function launch() {
  const env = {
    ...process.env,
    AWB_DATA_DIR: DATA, AWB_STORE: STORE, AWB_TEAM_ROOT: TEAM, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS,
    AWB_MAINT_SANDBOX: '1', AWB_MAINT_ROOT: FAKE, DSH_WEB_URL: 'http://127.0.0.1:1', AWB_DSH_BASE_URL: 'http://127.0.0.1:1',
  };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });
  const target = await waitTarget(PORT, 90000, (item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
  if (!target) { try { child.kill(); } catch { /* ignore */ } return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('ws 连接失败')), { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  for (let i = 0; i < 120; i += 1) {
    const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(document.getElementById("btn-more"))');
    if (ready === true) break;
    await sleep(400);
  }
  return { child, cdp, ws };
}
async function close(inst) {
  if (!inst) return;
  try { inst.cdp.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ }
  await sleep(900);
  try { inst.ws.close(); } catch { /* ignore */ }
  try { inst.child.kill(); } catch { /* ignore */ }
  try { spawn('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
}
function newestLog() {
  try {
    const files = fs.readdirSync(LOGDIR).filter((n) => /^install-.*\.log$/.test(n)).map((n) => ({ n, p: path.join(LOGDIR, n), st: fs.statSync(path.join(LOGDIR, n)) }));
    if (!files.length) return null;
    files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    const top = files[0];
    return { name: top.n, path: top.p, bytes: top.st.size, count: files.length };
  } catch { return null; }
}

async function main() {
  let inst = null;
  try {
    seed();
    inst = await launch();
    if (!inst) throw new Error('实例未启动（CDP 未就绪）');
    await sleep(2000);
    const openMenu = await inst.cdp.evaluate(`(() => { const b = document.getElementById('btn-more'); if (!b) return 'no-btn'; b.click(); const m = document.getElementById('more-menu'); return m ? (m.hidden ? 'hidden' : 'open') : 'no-menu'; })()`);
    check('S1 「更多」菜单可打开（维护入口可见）', openMenu === 'open', { openMenu });

    for (const mode of ['reset', 'uninstall']) {
      const clicked = await inst.cdp.evaluate(`(async () => {
        const btn = document.querySelector('[data-maint="${mode}"]');
        if (!btn) return { error: 'no-btn' };
        btn.click();
        const box = document.querySelector('[data-maint-result]');
        const list = document.querySelector('[data-maint-list]');
        const started = Date.now();
        while (Date.now() - started < 120000) {
          const txt = box ? String(box.textContent || '') : '';
          if (box && box.hidden === false && txt && !/^\\s*$/.test(txt) && !/干跑…|执行中…/.test(txt) && /干跑|失败|异常/.test(txt)) break;
          await new Promise((r) => setTimeout(r, 300));
        }
        return { result: box ? String(box.textContent || '') : '', list: list ? String(list.textContent || '') : '', listHidden: list ? list.hidden : null };
      })()`, 180000);
      const icon = mode === 'reset' ? '重置' : '卸载';
      const s2ok = Boolean(clicked && typeof clicked.result === 'string'
        && /判定/.test(clicked.result) && /待处理/.test(clicked.result) && !/失败|异常/.test(clicked.result));
      check(`S2[${mode}] ${icon}干跑：结果区给出判定，且文案不含「失败」`, s2ok, clicked);
      check(`S3[${mode}] ${icon}干跑：清单区给出待处理项（非空）`,
        Boolean(clicked && typeof clicked.list === 'string' && clicked.list.trim().length > 0 && clicked.listHidden === false), clicked);
      const log = newestLog();
      check(`S4[${mode}] ${icon}干跑：install-logs 落盘且非 0 字节`,
        Boolean(log && log.bytes > 0), log);
      if (log && log.bytes > 0) {
        const body = fs.readFileSync(log.path, 'utf8');
        check(`S5[${mode}] ${icon}干跑：日志含 命令/工作目录/退出码/耗时/stdout 段`,
          /命令: /.test(body) && /工作目录: /.test(body) && /退出码: /.test(body) && /耗时: /.test(body) && /--- stdout/.test(body) && /--- stderr/.test(body),
          body.slice(0, 300));
        if (!JSON_OUT) console.log(`INFO  ${icon}干跑日志：${log.path}（${log.bytes}B）`);
      }
      if (OUT) {
        fs.mkdirSync(OUT, { recursive: true });
        const shot = await inst.cdp.send('Page.captureScreenshot', { format: 'png' }, 20000).catch(() => null);
        if (shot && shot.data) fs.writeFileSync(path.join(OUT, `ebbb-ui-${mode}.png`), Buffer.from(shot.data, 'base64'));
        fs.writeFileSync(path.join(OUT, `ebbb-ui-${mode}.json`), JSON.stringify({ mode, clicked, log }, null, 2) + '\n', 'utf8');
      }
    }

    /* ── S6 真失败：确认短语不符 → 必须给真实 code + 日志非空（AC③b） ── */
    const failRun = await inst.cdp.evaluate(`(async () => {
      const r = await window.workbench.maintRun({ mode: 'reset', dryRun: false, confirm: '错误短语' });
      return { ok: r && r.ok, code: r && r.code, jsonVerdict: r && r.json && r.json.verdict, jsonCode: r && r.json && r.json.code,
        logFile: r && r.logFile, logBytes: r && r.logBytes, stdoutTail: (r && r.stdoutTail || '').slice(0, 160) };
    })()`, 180000);
    check('S6 真失败（短语不符）：给出真实 code（不是 ?），且不是成功判定',
      Boolean(failRun && failRun.ok === false && String(failRun.code || '') !== '' && String(failRun.code) !== '?'
        && !(failRun.jsonVerdict === 'CLEAN' || failRun.jsonVerdict === 'DRY_RUN')), failRun);
    check('S7 真失败：调用日志仍落盘且非 0 字节',
      Boolean(failRun && failRun.logFile && Number(failRun.logBytes) > 0), failRun);
    if (failRun && failRun.logFile) {
      try {
        const body = fs.readFileSync(failRun.logFile, 'utf8');
        check('S8 真失败日志：记录退出码与 stdout/stderr 段', /退出码: /.test(body) && /--- stdout/.test(body) && /--- stderr/.test(body), body.slice(0, 200));
      } catch (e) { check('S8 真失败日志：可读取', false, String(e && e.message)); }
    }
    if (OUT) fs.writeFileSync(path.join(OUT, 'ebbb-ui-failrun.json'), JSON.stringify(failRun, null, 2) + '\n', 'utf8');
  } catch (e) {
    check('断面未抛异常', false, { error: String((e && e.stack) || e) });
  } finally {
    await close(inst);
    try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const failed = ROWS.filter((r) => !r.ok).length;
  if (JSON_OUT) console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed, failed: ROWS.filter((r) => !r.ok).map((r) => r.name), rows: ROWS }, null, 2));
  else console.log(`\n${ROWS.length - failed}/${ROWS.length} PASS${failed ? ' · ' + failed + ' FAIL' : ''}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FIXTURE_FAILED', String(e && e.stack || e)); process.exit(1); });
