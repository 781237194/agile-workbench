#!/usr/bin/env node
/* R-c72a AC4 · 批2 大列表滚动采帧（真窗口 + 隔离数据根）。
 * 做什么：播种 1200 行沙盘 → 起真实 Electron 窗口（AWB_DATA_DIR + TEAM_ROOT 双隔离）→ 打开需求池
 *        → 对 #pool-req-list 直接赋值 scrollTop（10 步 × 120px，步间等一个 rAF）→ 挂 rAF 链逐帧记间隔
 *        → 输出 {p95, max, dropRate, rows, ...} JSON。
 * 用法：node scripts/ui-budget-scroll.cjs [--base <目录>] [--rows 1200] [--steps 10] [--step-px 120]
 *        [--out <json路径>] [--port 9433]
 * 不改业务逻辑、不写生产 jsonl；Browser.close 用 fire-and-forget（避免静默 exit 0 丢证据）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { seedPool1200 } = require('./fixture-pool-1200.cjs');
const { sandboxEnv, ROOT } = require('./lib/c72a-sandbox.cjs');

function argOf(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const PORT = Number(argOf('--port', '9433'));
const ROWS = Number(argOf('--rows', '1200'));
const STEPS = Number(argOf('--steps', '10'));
const STEP_PX = Number(argOf('--step-px', '120'));
const OUT = path.resolve(argOf('--out', path.join(ROOT, '程序员A', '产出', '证据-c72a-批2', 'scroll-frame-batch2.json')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = ''; res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
  });
}
async function waitTarget(ms, pick) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
    if (Array.isArray(list)) {
      const hit = list.find(pick);
      if (hit && hit.webSocketDebuggerUrl) return hit;
    }
    await sleep(400);
  }
  return null;
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
        return;
      }
      if (m.method) this.events.push(m);
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
  async evaluate(expr, ms = 60000) {
    try {
      const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, ms);
      if (out && out.exceptionDetails) {
        return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text).slice(0, 800) };
      }
      return out && out.result ? out.result.value : undefined;
    } catch (e) { return { __cdperror: String((e && e.message) || e) }; }
  }
}

let spawnedChild = null;
async function launch(seed) {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], {
    cwd: ROOT, env: sandboxEnv(seed), stdio: 'ignore', windowsHide: false,
  });
  spawnedChild = child;
  const target = await waitTarget(60000, (x) => x && x.type === 'page' && String(x.url || '').includes('renderer/index.html'));
  if (!target) { try { child.kill(); } catch { /* */ } return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('ws 打开超时')), 15000);
    ws.addEventListener('open', () => { clearTimeout(timer); res(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); rej(new Error('ws 连接失败')); }, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  // 壳内 webview 是真实 DSH 页面：先导航 about:blank，避免截图/布局被它拖慢（只影响本隔离实例）
  const guest = await waitTarget(6000, (x) => x && x.type === 'webview');
  if (guest) {
    try {
      const gws = new WebSocket(guest.webSocketDebuggerUrl);
      await new Promise((res) => { gws.addEventListener('open', res, { once: true }); setTimeout(res, 3000); });
      gws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: 'about:blank' } }));
      await sleep(600);
    } catch { /* 关掉也不影响断言 */ }
  }
  return { child, cdp, ws };
}

const MEASURE = (steps, stepPx, minFrames) => `(async () => {
  const el = document.querySelector('#pool-req-list');
  if (!el) return { ok: false, code: 'ANCHOR_MISSING', anchor: '#pool-req-list' };
  const rowH = parseInt(el.getAttribute('data-row-height') || '36', 10) || 36;
  const frames = [];
  let last = performance.now();
  let on = true;
  const tick = (t) => { frames.push(t - last); last = t; if (on) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  await raf(); await raf();
  const startTop = el.scrollTop;
  if (${steps} > 0) {
    for (let i = 0; i < ${steps}; i += 1) {
      el.scrollTop = Math.min(el.scrollHeight, startTop + ${stepPx} * (i + 1));
      await raf();
    }
    await raf();
  } else {
    // 空闲基线：不滚动，只等够 ${minFrames} 帧（用于判断「页面本底帧间隔」是否已经超预算）
    while (frames.length < ${minFrames}) await raf();
  }
  on = false;
  const sorted = frames.slice().sort((a, b) => a - b);
  const pick = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null);
  const drops = frames.filter((x) => x > 25).length;
  let virt = null;
  try { virt = el.dataset.virtual ? JSON.parse(el.dataset.virtual) : null; } catch (e) { virt = null; }
  return {
    ok: true,
    rowH: rowH,
    steps: ${steps},
    stepPx: ${stepPx},
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    scrollTop: el.scrollTop,
    startTop: startTop,
    frames: frames.length,
    p95: pick(0.95) === null ? null : Math.round(pick(0.95) * 1000) / 1000,
    max: frames.length ? Math.round(Math.max.apply(null, frames) * 1000) / 1000 : null,
    dropFrames: drops,
    dropRate: frames.length ? Math.round((drops / frames.length) * 10000) / 10000 : null,
    frameList: frames.map((x) => Math.round(x * 10) / 10),
    rows: el.querySelectorAll('.pool-row').length,
    virtual: virt
  };
})()`;

(async () => {
  const HARD_MS = Number(argOf('--hard-timeout-ms', '240000'));
  setTimeout(() => {
    console.error('HARD TIMEOUT ' + HARD_MS + 'ms：强制退出，避免沙盘实例悬住');
    try { if (spawnedChild) spawnedChild.kill(); } catch { /* */ }
    process.exit(3);
  }, HARD_MS);
  const seed = seedPool1200({ rows: ROWS });
  const inst = await launch(seed);
  const out = { at: new Date().toISOString(), project: '工作台改造修复', fixture: 'scripts/fixture-pool-1200.cjs', base: seed.base, port: PORT };
  try {
    if (!inst) { out.ok = false; out.code = 'LAUNCH_FAILED'; }
    else {
      const { cdp, ws } = inst;
      for (let i = 0; i < 120; i += 1) {
        const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(document.getElementById("btn-pool"))');
        if (ready === true) break;
        await sleep(500);
      }
      await cdp.evaluate(`(function(){ const b = document.getElementById('btn-pool'); if (b) b.click(); return true; })()`);
      let rows = 0;
      for (let i = 0; i < 60; i += 1) {
        rows = await cdp.evaluate(`(function(){ const el = document.querySelector('#pool-req-list'); return el ? el.querySelectorAll('.pool-row').length : -1; })()`);
        if (typeof rows === 'number' && rows > 0) break;
        await sleep(500);
      }
      out.poolRowsRendered = rows;
      // 预热：等首屏布局/光栅稳定，避免把开面板的首次绘制算进帧预算（预热期不计入 frames）
      const warm = Number(argOf('--warmup-ms', '2000'));
      await sleep(warm);
      const res = await cdp.evaluate(MEASURE(STEPS, STEP_PX, 15), 120000);
      out.measure = res;
      out.ok = Boolean(res && res.ok === true);
      if (res && res.__exception) out.code = 'PAGE_EXCEPTION';
      // 功能正确性抽查：滚到底 → 最后渲染行必须是全集最后一行；中途窗口首行 = floor(scrollTop/36) 那行
      const verify = await cdp.evaluate(`(async () => {
        const el = document.querySelector('#pool-req-list');
        const ids = (Array.prototype.slice.call(el.querySelectorAll('.pool-row')).map((n) => n.dataset.id)).filter(Boolean);
        const rowH = parseInt(el.getAttribute('data-row-height') || '36', 10) || 36;
        const before = { count: ids.length, first: ids[0] || null, last: ids[ids.length - 1] || null, scrollTop: el.scrollTop };
        el.scrollTop = el.scrollHeight;
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => requestAnimationFrame(r));
        const after = { count: el.querySelectorAll('.pool-row').length, last: (el.querySelector('.pool-row:last-of-type') || {}).dataset, scrollTop: el.scrollTop };
        const lastRow = (function () { const all = el.querySelectorAll('.pool-row'); return all.length ? all[all.length - 1].dataset.id : null; })();
        return { before: before, atBottom: { scrollTop: after.scrollTop, count: after.count, last: lastRow }, rowH: rowH };
      })()`);
      out.verify = verify;
      // 真值：沙盘 1200 行的 id 形如 R-20261116-120000-0001 … -1200
      const pad = (n) => String(n).padStart(4, '0');
      const lastId = 'R-20261116-120000-' + pad(ROWS);
      // 窗口首行 = max(0, floor(scrollTop/rowH) - 10)，+1 换成 1 起的序号
      const buf = 10;
      const rowH = (verify && verify.rowH) || 36;
      const idx0 = Math.max(0, Math.floor((verify.before.scrollTop || 0) / rowH) - buf);
      const firstId = 'R-20261116-120000-' + pad(idx0 + 1);
      if (verify && verify.atBottom) {
        const okLast = verify.atBottom.last === lastId;
        const okFirst = verify.before.first === firstId;
        out.verify.ok = Boolean(okLast && okFirst);
        out.verify.expected = { first: firstId, last: lastId };
        out.verify.got = { first: verify.before.first, last: verify.atBottom.last };
        if (!out.verify.ok) { out.ok = false; out.code = 'VIRTUAL_RANGE_WRONG'; }
      }
      // 判定（AC4：p95 ≤20ms、掉帧率 <5%、可视区 DOM 行数 ≤60）
      if (res && res.ok === true) {
        const bad = [];
        if (!(res.p95 !== null && res.p95 <= 20)) bad.push('p95>20ms');
        if (!(res.dropRate !== null && res.dropRate < 0.05)) bad.push('dropRate>=5%');
        if (!(res.rows <= 60)) bad.push('rows>60');
        out.verdict = bad.length ? 'BUDGET_EXCEEDED' : 'OK';
        out.violations = bad;
      }
      try { ws.close(); } catch { /* */ }
    }
  } finally {
    // fire-and-forget：await Browser.close 会因页面目标关闭而永不 resolve
    try { inst.cdp.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* */ }
    setTimeout(() => { try { inst.child.kill(); } catch { /* */ } }, 800);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
  await sleep(1200);
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok && out.verdict === 'OK' ? 0 : 1);
})().catch((e) => { console.error('ERR ' + ((e && e.stack) || e)); process.exit(2); });