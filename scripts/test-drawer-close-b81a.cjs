'use strict';
/**
 * B-20261120-231006-b81a 真窗口断面（数据副本 + 隔离实例；只杀自起 PID）
 * D1 三个抽屉的 ×：rect>0、elementFromPoint 命中自身、点击后 hidden=true + mask hidden=true；
 *    会话排队额外断言 #btn-session-queue aria-pressed=false、body 无 drawer-open。
 * D2 项目面板/团队台入口可打开，抽屉内容可见后 × 同样可点关闭。
 * D3 注入「某绑定块初始化抛错」（这里让 bind() 内一处 addEventListener 抛）→ bind 不掐断 refresh，
 *    三个 × 仍可点关闭；window.__bindFailures 记到该失败（含 block/message）。
 * 跑法：node scripts/test-drawer-close-b81a.cjs [--keep]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const KEEP = process.argv.includes('--keep') || process.env.AWB_KEEP_SANDBOX === '1';
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-drawer-b81a-'));
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
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
function seed() {
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  for (const n of fs.readdirSync(path.join(ROOT, 'data', 'userdata'))) if (n.startsWith('workbench.json')) copy(path.join(ROOT, 'data', 'userdata', n), path.join(DATA, 'userdata', n));
  copy(path.join(ROOT, '团队', '状态', '团队.json'), path.join(TEAM, '状态', '团队.json'));
  const projState = path.join(TEAM, '状态', '项目', '工作台改造修复');
  fs.mkdirSync(projState, { recursive: true });
  copy(path.join(ROOT, '团队', '状态', '项目', '工作台改造修复', '项目.json'), path.join(projState, '项目.json'));
  try { cp.execFileSync('cmd', ['/c', 'mklink', '/J', path.join(TEAM, '工具'), path.join(ROOT, '团队', '工具')], { stdio: 'ignore' }); } catch (e) { console.log('JUNCTION_FAIL', String(e.message || e)); }
}
const env = () => ({ ...process.env, AWB_DATA_DIR: DATA, AWB_TEAM_ROOT: TEAM, TEAM_ROOT: TEAM, TEAM_SELFTEST: '1', DSH_WEB_URL: 'http://127.0.0.1:1' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function launch(port) {
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
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r && r.result && r.result.exceptionDetails) return { __exception: true, detail: r.result.exceptionDetails }; return r && r.result && r.result.result ? r.result.result.value : r; };
  return { child, ws, send, evalJs, log: () => log, alive: () => child.exitCode === null };
}
function kill(h) { try { cp.execFileSync('taskkill', ['/PID', String(h.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } try { h.ws.close(); } catch { /* ignore */ } }
function sandboxId() {
  try { return String(fs.readFileSync(path.join(DATA, 'userdata', 'workbench.json'), 'utf8').match(/"id"\s*:\s*"(P-[^"]+)"/)[1]); } catch { return ''; }
}
async function open(h, opener, drawer) {
  await h.evalJs(`document.querySelector(${JSON.stringify(opener)})?.click(); 'ok'`);
  for (let i = 0; i < 25; i += 1) {
    const st = await h.evalJs(`({hidden:(document.querySelector(${JSON.stringify(drawer)})||{}).hidden===true, mask:(document.querySelector('#drawer-mask')||{}).hidden===true})`);
    if (st && st.hidden === false) return st;
    await sleep(200);
  }
  return h.evalJs(`({hidden:(document.querySelector(${JSON.stringify(drawer)})||{}).hidden===true, mask:(document.querySelector('#drawer-mask')||{}).hidden===true})`);
}
async function probeClose(h, opener, drawer, btnSel) {
  return h.evalJs(`(function(){
    const d = document.querySelector(${JSON.stringify(drawer)});
    const b = document.querySelector(${JSON.stringify(btnSel)});
    if (!d || !b) return { missing: true, d: !!d, b: !!b };
    const r = b.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const hitOk = !!hit && (hit === b || b.contains(hit));
    return { w: r.width, h: r.height, hitOk, hitTag: hit ? (hit.tagName + '#' + (hit.id||'')) : null, hiddenBefore: d.hidden === true, maskBefore: (document.querySelector('#drawer-mask')||{}).hidden === true };
  })()`);
}
(async () => {
  seed();
  const projectId = sandboxId();
  let h = await launch(9731 + Math.floor(Math.random() * 150));
  try {
    await sleep(4000);
    const initial = await h.evalJs(`({name:(document.querySelector('#workspace-name')||{}).textContent, failures:(window.__bindFailures||[]).length})`);
    check('D0', `首屏卡片显示项目名（app:state 有数据）+ 无绑定失败`, initial && initial.name && !/未选择/.test(initial.name) && initial.failures === 0, initial);
    // D1 三个抽屉逐个：打开 → 量 rect/命中 → 点 × → 断言关闭
    const cases = [
      ['#btn-board', 'project', '#project-drawer', '#project-drawer [data-close-drawer="project"]'],
      ['#team-pill', 'team', '#team-drawer', '#team-drawer [data-close-drawer="team"]'],
      ['#btn-session-queue', 'session-queue', '#session-queue-drawer', '#session-queue-drawer [data-close-drawer="session-queue"]']
    ];
    for (const [opener, name, drawer, btn] of cases) {
      const opened = await open(h, opener, drawer);
      const m = await probeClose(h, opener, drawer, btn);
      check('D1-' + name, `${name} 抽屉：打开后 × 可点（rect>0、elementFromPoint 命中自身）`, opened && opened.hidden === false && m.w > 0 && m.h > 0 && m.hitOk, { opened, m });
      await h.evalJs(`document.querySelector(${JSON.stringify(btn)})?.click(); 'ok'`);
      await sleep(300);
      const closed = await h.evalJs(`({d:(document.querySelector(${JSON.stringify(drawer)})||{}).hidden===true, mask:(document.querySelector('#drawer-mask')||{}).hidden===true, body:document.body.classList.contains('drawer-open'), pressed:(document.querySelector('#btn-session-queue')||{}).getAttribute?document.querySelector('#btn-session-queue').getAttribute('aria-pressed'):null})`);
      check('D1-' + name + '-close', `${name}：点 × 后 hidden=true 且 mask hidden=true${name === 'session-queue' ? '、aria-pressed=false、body 无 drawer-open' : ''}`,
        closed && closed.d === true && closed.mask === true && (name !== 'session-queue' || (closed.pressed === 'false' && closed.body === false)), closed);
    }
  } finally { kill(h); }
  // D2 注入：某绑定块 addEventListener 抛错 → bind 不掐断 refresh；三个 × 仍可点
  h = await launch(9881 + Math.floor(Math.random() * 100));
  try {
    await h.send('Page.enable', {});
    await h.send('Page.addScriptToEvaluateOnNewDocument', { source: `(function(){
      const orig = EventTarget.prototype.addEventListener;
      let fired = false;
      EventTarget.prototype.addEventListener = function(type, fn, opts) {
        if (!fired && this && this.id === 'workspace-switch') { fired = true; throw new Error('INJECTED_OWNER_REVIEW_INIT_FAILED'); }
        return orig.call(this, type, fn, opts);
      };
    })();` });
    await h.send('Page.reload', { ignoreCache: true });
    await sleep(6000);
    const inj = await h.evalJs(`({name:(document.querySelector('#workspace-name')||{}).textContent, failures:window.__bindFailures||[], mask:(document.querySelector('#drawer-mask')||{}).hidden})`);
    const failHit = Array.isArray(inj.failures) && inj.failures.some((f) => String(f.block || '') === 'bind');
    check('D2-inject', '注入 owner-review 绑定块抛错：bind 记失败（block=bind）但不掐断 refresh（卡片仍有项目名）', Boolean(inj && inj.name && !/未选择/.test(inj.name) && failHit), inj);
    const opened = await open(h, '#btn-session-queue', '#session-queue-drawer');
    const dbg = await h.evalJs(`({btn:document.querySelector('#btn-session-queue')?{bound:document.querySelector('#btn-session-queue').dataset.drawerOpenerBound,pressed:document.querySelector('#btn-session-queue').getAttribute('aria-pressed')}:null, failures:window.__bindFailures, body:document.body.className})`);
    const m = await probeClose(h, '#btn-session-queue', '#session-queue-drawer', '#session-queue-drawer [data-close-drawer="session-queue"]');
    check('D2-close', '注入失败后：会话排队 × 仍可点（rect>0 命中自身）', opened && opened.hidden === false && m.w > 0 && m.hitOk, { opened, m, dbg });
    await h.evalJs(`document.querySelector('#session-queue-drawer [data-close-drawer="session-queue"]')?.click(); 'ok'`);
    await sleep(300);
    const closed = await h.evalJs(`({d:(document.querySelector('#session-queue-drawer')||{}).hidden===true, mask:(document.querySelector('#drawer-mask')||{}).hidden===true})`);
    check('D2-close-ok', '注入失败后：点 × 仍能关闭抽屉', closed && closed.d === true && closed.mask === true, closed);
  } finally { kill(h); }
})().catch((e) => check('EX', '断面未抛异常', false, { error: String((e && e.stack) || e) })).finally(() => {
  if (!KEEP) { try { cp.execFileSync('cmd', ['/c', 'rmdir', path.join(TEAM, '工具')], { stdio: 'ignore' }); } catch { /* ignore */ } try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ } } else { console.log('KEEP_SANDBOX=' + SB); }
  const pass = R.filter((x) => x.ok).length;
  console.log(`\n${pass}/${R.length} PASS`);
});
