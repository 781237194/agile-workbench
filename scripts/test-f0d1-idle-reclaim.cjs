'use strict';
/**
 * R-e31b / T-20261121-221005-f0d1 真窗口断面（单实例沙盘）：
 * 失焦 60s（测试注入 1.5s）+ 内存超阈值 → 只重载 DSH guest；验证：
 *  ①guest 输入草稿保留 ②guest 滚动位置保留 ③壳输入保留（壳未重载）
 *  ④标题栏 mem-badge 回收后 ≤1024MB ⑤主进程 RSS ≤400MB；并输出回收前后数值。
 * 纪律：只 spawn 一个 Electron 实例；结束只 taskkill 自己的 child.pid 树；沙盘删除；不碰生产。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SANDBOX_BASE = String.fromCharCode(68) + ':\\awb-sandbox';
const SANDBOX = fs.mkdtempSync(path.join(fs.existsSync(SANDBOX_BASE) ? SANDBOX_BASE : os.tmpdir(), 'f0d1-idle-'));
const DATA = path.join(SANDBOX, 'data');
const TEAM = path.join(SANDBOX, '团队');
const PROJECT = path.join(SANDBOX, '项目区', '工作台改造修复');
const STORE = path.join(DATA, 'workbench.json');
const DSH_HOME = path.join(SANDBOX, 'dsh-home');
const PORT = 19800 + Math.floor(Math.random() * 150);
const OUT = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-f0d1-20261121');
fs.mkdirSync(OUT, { recursive: true });

let loads = 0;
const MOCK = `<!doctype html><html><head><meta charset="utf-8"><title>Mock DSH</title></head>
<body style="margin:0;height:4000px">
<div style="height:60px;background:#123"></div>
<textarea id="mock-composer" placeholder="输入消息" style="width:500px;height:60px"></textarea>
<div id="mock-scroller" style="height:180px;width:500px;overflow:auto;border:1px solid #555">
  <div style="height:2000px">scroll me</div>
</div>
<div style="height:3000px"></div>
<script>window.__mockLoadAt = Date.now();</script>
</body></html>`;

function seed() {
  fs.mkdirSync(path.join(TEAM, '状态', '项目', '工作台改造修复'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '工具'), { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(DSH_HOME, { recursive: true });
  fs.writeFileSync(path.join(DSH_HOME, '.credentials.yaml'), 'client-connection/browser-session:\n  secret: ' + 'a'.repeat(43) + '\n', 'utf8');
  fs.writeFileSync(path.join(DSH_HOME, 'gui.port'), String(PORT), 'utf8');
  fs.writeFileSync(path.join(PROJECT, '项目信息.md'), '# 沙盘项目\n', 'utf8');
  const realStore = path.join(ROOT, 'data', 'userdata', 'workbench.json');
  const store = JSON.parse(fs.readFileSync(realStore, 'utf8'));
  for (const pj of store.projects || []) { pj.path = PROJECT; if (pj.workspace) pj.workspace.path = PROJECT; }
  store.activeProjectId = (store.projects && store.projects[0] && store.projects[0].id) || store.activeProjectId;
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2), 'utf8');
  const realTeam = path.join(ROOT, '团队', '状态', '团队.json');
  if (fs.existsSync(realTeam)) {
    const team = JSON.parse(fs.readFileSync(realTeam, 'utf8'));
    for (const m of team.members || []) m.sessionId = '';
    fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2), 'utf8');
  }
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    const c = new Cdp(ws);
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.id && c.pending.has(m.id)) { const p = c.pending.get(m.id); c.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    });
    return c;
  }
  send(method, params = {}, timeout = 15000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout ' + method)); } }, timeout);
    });
  }
  async eval(expr, timeout = 15000) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeout);
    if (r && r.exceptionDetails) throw new Error('EVAL ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r && r.result ? r.result.value : undefined;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJson = (url) => new Promise((resolve, reject) => {
  const req = http.get(url, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.setTimeout(2500, () => req.destroy(new Error('timeout')));
});

let child = null;
let server = null;
const killOwn = () => {
  if (!child || !child.pid) return;
  try { child.kill(); } catch { /* ignore */ }
  try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  child = null;
};
const cleanup = () => {
  killOwn();
  try { if (server) server.close(); } catch { /* ignore */ }
  if (process.env.AWB_KEEP_SANDBOX === '1') { console.log('沙盘保留：' + SANDBOX); return; }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('exit', cleanup);

(async () => {
  seed();
  server = http.createServer((req, res) => {
    loads += 1;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(MOCK);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const env = {
    ...process.env,
    AWB_TEAM_ROOT: TEAM, AWB_TEAM_PROJECTS_ROOT: path.join(SANDBOX, '项目区'),
    TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(SANDBOX, '项目区'),
    TEAM_WORKBENCH_JSON: STORE, AWB_STORE: STORE, AWB_DATA_DIR: DATA,
    DSH_HOME, DSH_WEB_URL: `http://127.0.0.1:${PORT}`, AWB_DSH_BASE_URL: `http://127.0.0.1:${PORT}`,
    AWB_SHOW_INACTIVE: '1', AWB_BACKGROUND_THROTTLING: '0',
    AWB_MEM_IDLE_MS: '1500', AWB_MEM_IDLE_RECLAIM_MB: '1',
    AWB_BOARD_PREGEN_MS: '0', AWB_MEM_RECYCLE_MB: '0', TEAM_SELFTEST: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.AWB_START_HIDDEN;
  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  child = spawn(electron, [ROOT, `--remote-debugging-port=${PORT + 1}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let childOut = '';
  child.stdout.on('data', (d) => { childOut += String(d); });
  child.stderr.on('data', (d) => { childOut += String(d); });
  const out = { sandbox: SANDBOX, port: PORT, checks: [], loads: 0 };
  let shell = null; let guest = null; let targetInfo = null;
  for (let i = 0; i < 60 && !(shell && guest); i += 1) {
    await sleep(500);
    try {
      const list = await httpJson(`http://127.0.0.1:${PORT + 1}/json/list`);
      for (const t of list || []) {
        const url = String(t.url || '');
        if (!shell && /renderer\/index\.html/i.test(url)) { shell = await Cdp.connect(t.webSocketDebuggerUrl); targetInfo = { id: t.id, title: t.title, url }; }
        if (!guest && url.includes(`127.0.0.1:${PORT}`)) guest = await Cdp.connect(t.webSocketDebuggerUrl);
      }
    } catch { /* retry */ }
  }
  const check = (name, ok, detail) => { out.checks.push({ name, ok: Boolean(ok), detail }); console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail))); };
  check('壳主窗与 mock guest 均就绪', Boolean(shell && guest), { shell: Boolean(shell), guest: Boolean(guest), loads });
  if (!shell || !guest) throw new Error('targets not ready');
  await shell.send('Runtime.enable'); await guest.send('Runtime.enable');
  await sleep(2500);
  // 等 webview 首次加载完成
  for (let i = 0; i < 20; i += 1) {
    const ready = await guest.eval(`Boolean(document.getElementById('mock-composer'))`).catch(() => false);
    if (ready) break;
    await sleep(300);
  }
  // 设置 guest 输入/滚动 + 壳输入
  await guest.eval(`(() => { const t=document.getElementById('mock-composer'); t.focus(); t.value='草稿-待恢复-123'; t.dispatchEvent(new Event('input',{bubbles:true})); t.setSelectionRange(3,6); const s=document.getElementById('mock-scroller'); s.scrollTop=420; window.scrollTo(0,300); return true; })()`);
  await shell.eval(`(() => { const a=document.getElementById('dispatch-subject'); if(a) a.value='壳输入-draft-456'; return true; })()`);
  // 等第一拍 mem:stats（标题栏 before）
  let badgeBefore = null;
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    const b = await shell.eval(`(() => { const el=document.getElementById('mem-badge'); return el ? String(el.textContent||'') : ''; })()`).catch(() => '');
    if (/内存\s*\d/.test(b)) { badgeBefore = b; break; }
  }
  const rssBefore = await shell.eval(`window.workbench.mainRss()`).catch(() => null);
  // 等待失焦回收（直接轮询主进程状态 IPC）
  let idle = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(500);
    idle = await shell.eval(`window.workbench.memIdleState()`).catch(() => null);
    if (idle && (idle.lastResult || idle.episodeReclaimed)) break;
  }
  await sleep(2500);
  idle = await shell.eval(`window.workbench.memIdleState()`).catch(() => idle);
  // 等回收流程真正结束（guest reload + 恢复最多约 25s），不要在中途读状态
  for (let i = 0; i < 60; i += 1) {
    if (idle && idle.reclaiming === false && idle.lastResult) break;
    await sleep(500);
    idle = await shell.eval(`window.workbench.memIdleState()`).catch(() => idle);
  }
  await sleep(1000);
  const guestAfter = await guest.eval(`(() => { const t=document.getElementById('mock-composer'); const s=document.getElementById('mock-scroller'); return { text: t ? t.value : null, scrollTop: s ? s.scrollTop : null, scrollY: window.scrollY, loads: window.__mockLoadAt || 0, url: location.href }; })()`).catch(() => null);
  const shellAfter = await shell.eval(`(() => { const a=document.getElementById('dispatch-subject'); const b=document.getElementById('mem-badge'); return { input: a ? a.value : null, badge: b ? String(b.textContent||'') : '', mainRss: null }; })()`).catch(() => null);
  const rssAfter = await shell.eval(`window.workbench.mainRss()`).catch(() => null);
  out.idle = idle; out.guestAfter = guestAfter; out.shellAfter = shellAfter; out.badgeBefore = badgeBefore; out.rssBefore = rssBefore; out.rssAfter = rssAfter; out.loads = loads;
  check('① guest 输入草稿保留', guestAfter && guestAfter.text === '草稿-待恢复-123', guestAfter && guestAfter.text);
  check('② guest 滚动位置保留', guestAfter && Number(guestAfter.scrollTop) >= 400 && Number(guestAfter.scrollY) >= 250, guestAfter && { scrollTop: guestAfter.scrollTop, scrollY: guestAfter.scrollY });
  check('③ 壳输入保留（壳未重载）', shellAfter && shellAfter.input === '壳输入-draft-456', shellAfter && shellAfter.input);
  check('guest 确实被重载（mock 请求 ≥2 次）', loads >= 2, { loads });
  const badgeMB = (() => {
    const text = String((shellAfter && shellAfter.badge) || '');
    const m = text.match(/([\d.]+)\s*(GB|MB)/i);
    if (!m) return null;
    return Math.round(Number(m[1]) * (/GB/i.test(m[2]) ? 1024 : 1));
  })();
  check('④ 标题栏回收后 ≤1024MB', badgeMB !== null && badgeMB <= 1024, { badgeBefore, badgeAfter: shellAfter && shellAfter.badge, badgeMB });
  check('⑤ 主进程 RSS ≤400MB', rssAfter && Number(rssAfter.rssMB) <= 400, rssAfter);
  const last = idle && idle.lastResult ? idle.lastResult : null;
  check('⑥ 回收同时清理主进程缓存并 GC', Boolean(last && last.trim && last.trim.ok && last.trim.cleared > 0 && last.trim.gc === true), last && last.trim);
  check('⑦ 回收只动 guest（记录 restore 结果）', Boolean(last && last.restore && (last.restore.restoredComposer || last.restore.restoredScroll)), last && last.restore);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'idle-reclaim-verify.json'), JSON.stringify({ ...out, target: targetInfo, stdoutTail: childOut.slice(-3000) }, null, 2));
  const failed = out.checks.filter((c) => !c.ok).length;
  console.log(`\n${failed ? 'FAILED' : 'PASS'}  ${out.checks.length - failed} PASS / ${failed} FAIL`);
  console.log('证据：' + path.join(OUT, 'idle-reclaim-verify.json'));
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  try { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'idle-reclaim-verify-error.json'), JSON.stringify({ error: String((error && error.stack) || error) }, null, 2)); } catch { /* ignore */ }
  console.error('FAILED', error && error.stack);
  cleanup();
  process.exit(1);
});
