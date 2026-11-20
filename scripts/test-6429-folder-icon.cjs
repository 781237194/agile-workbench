#!/usr/bin/env node
'use strict';
/**
 * test-6429-folder-icon.cjs —— B-20261120-165015-6429（P3）顶部「文件夹」按钮纯图标 + 不被右侧遮挡（真窗口 CDP）
 *
 * 断言（1280/1440/1720/1920 四个视口宽度，逐个）：
 *  A 按钮是纯图标：可见文本为空、只有 14×14 svg；title/aria-label 保留
 *  B 不被遮挡：#btn-folder-top 右边界 ≤ .titlebar-right 左边界 − 4px
 *  C 完整在视口内：0 ≤ left 且 right ≤ 视口宽
 *  D 可点击：elementFromPoint(按钮中心) 命中的就是按钮本身或其后代
 * 另存四张截图（before/after 用 --tag 区分）。
 *
 * 用法：node scripts/test-6429-folder-icon.cjs [--json] [--tag before|after] [--out <dir>]
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', `6429-${process.pid}-${Date.now()}`);
const DATA = path.join(SB, 'data');
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const PROJECT_DIR = path.join(SB, '项目区', '工作台改造修复');
const PORT = Number(process.env.AWB_6429_PORT || (9700 + (process.pid % 30)));
const JSON_OUT = process.argv.includes('--json');
const TAG = (() => { const i = process.argv.indexOf('--tag'); return i >= 0 ? String(process.argv[i + 1] || '') : ''; })();
const OUT = (() => { const i = process.argv.indexOf('--out'); return i >= 0 ? path.resolve(process.argv[i + 1]) : ''; })();
const WIDTHS = [1280, 1440, 1720, 1920];
const ROWS = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
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
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  const project = {
    id: 'P-6429', name: '工作台改造修复', path: PROJECT_DIR, teamName: '工作台改造修复', teamMode: 'full',
    workspace: { id: 'W-6429', path: PROJECT_DIR, name: '工作台改造修复', bound: true, sessionIds: [] },
    sessions: { pm: 'session-6429-pm', product: 'session-6429-product', analyst: 'session-6429-analyst', programmer1: 'session-6429-p1', programmer2: 'session-6429-p2', tester: 'session-6429-tester' },
    requirements: [], sessionMeta: {},
  };
  fs.writeFileSync(STORE, JSON.stringify({ version: 1, activeProjectId: project.id, projects: [project], ui: {} }, null, 2) + '\n', 'utf8');
}
async function launch() {
  const env = {
    ...process.env,
    AWB_DATA_DIR: DATA, AWB_STORE: STORE, AWB_TEAM_ROOT: path.join(SB, '团队'), TEAM_ROOT: path.join(SB, '团队'),
    TEAM_PROJECTS_ROOT: path.join(SB, '项目区'), TEAM_SELFTEST: '1',
    DSH_WEB_URL: 'http://127.0.0.1:1', AWB_DSH_BASE_URL: 'http://127.0.0.1:1',
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
    const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(document.getElementById("btn-folder-top"))');
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

async function main() {
  let inst = null;
  const evidence = { at: new Date().toISOString(), tag: TAG, widths: {} };
  try {
    seed();
    inst = await launch();
    if (!inst) throw new Error('实例未启动（CDP 未就绪）');
    await sleep(1500);
    for (const width of WIDTHS) {
      await inst.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(500);
      const m = await inst.cdp.evaluate(`(() => {
        const btn = document.getElementById('btn-folder-top');
        const right = document.querySelector('.titlebar-right');
        if (!btn || !right) return { error: 'missing', btn: Boolean(btn), right: Boolean(right) };
        const b = btn.getBoundingClientRect();
        const r = right.getBoundingClientRect();
        const text = String(btn.innerText || '').trim();
        const svg = btn.querySelector('svg');
        const s = svg ? svg.getBoundingClientRect() : null;
        const cx = Math.round(b.left + b.width / 2), cy = Math.round(b.top + b.height / 2);
        const hit = document.elementFromPoint(cx, cy);
        return {
          viewport: window.innerWidth,
          btn: { left: +b.left.toFixed(1), right: +b.right.toFixed(1), width: +b.width.toFixed(1), height: +b.height.toFixed(1) },
          right: { left: +r.left.toFixed(1), right: +r.right.toFixed(1) },
          gap: +(r.left - b.right).toFixed(1),
          text, title: btn.getAttribute('title') || '', ariaLabel: btn.getAttribute('aria-label') || '',
          svg: s ? { w: +s.width.toFixed(1), h: +s.height.toFixed(1) } : null,
          hitIsBtn: Boolean(hit && (hit === btn || btn.contains(hit))),
          hitTag: hit ? String(hit.tagName || '') : '',
        };
      })()`);
      evidence.widths[width] = m;
      if (!m || m.error) { check(`${width}px 标题栏元素存在`, false, m); continue; }
      check(`${width}px A 纯图标：可见文本为空、svg 14×14、title/aria-label 保留`,
        m.text === '' && Boolean(m.svg) && m.svg.w === 14 && m.svg.h === 14 && Boolean(m.title) && Boolean(m.ariaLabel), m);
      check(`${width}px B 不被遮挡：按钮右边界 +4px ≤ 右组左边界（实测 gap=${m.gap}）`,
        m.gap >= 4, m);
      check(`${width}px C 完整在视口内（left=${m.btn.left}, right=${m.btn.right}, vw=${m.viewport}）`,
        m.btn.left >= 0 && m.btn.right <= m.viewport, m);
      check(`${width}px D 可点击：按钮中心命中的是自己`, m.hitIsBtn === true, m);
      if (OUT) {
        const shot = await inst.cdp.send('Page.captureScreenshot', { format: 'png' }, 20000).catch(() => null);
        if (shot && shot.data) fs.writeFileSync(path.join(OUT, `6429-${TAG || 'shot'}-${width}.png`), Buffer.from(shot.data, 'base64'));
      }
    }
  } catch (e) {
    check('断面未抛异常', false, { error: String((e && e.stack) || e) });
  } finally {
    await close(inst);
    try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, `6429-${TAG || 'shot'}.json`), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    }
  }
  const failed = ROWS.filter((r) => !r.ok).length;
  if (JSON_OUT) console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed, failed: ROWS.filter((r) => !r.ok).map((r) => r.name), rows: ROWS }, null, 2));
  else console.log(`\n${ROWS.length - failed}/${ROWS.length} PASS${failed ? ' · ' + failed + ' FAIL' : ''}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FIXTURE_FAILED', String((e && e.stack) || e)); process.exit(1); });
