#!/usr/bin/env node
'use strict';
/**
 * test-bcac-ui-shot.cjs —— R-bcac 设置页「存储位置」真窗口截图 + 断言
 * 1) 隔离实例（沙盘数据/团队/store/TEMP 全指沙盘，屏外 showInactive）
 * 2) 打开菜单「存储位置」面板（window.__awbOpenStoragePanel）
 * 3) 断言面板显示 临时沙盘占用 / 上限 / 上次清理，输入框可编辑，保存/一键清理按钮存在
 * 4) CDP 截图存 证据-bcac-20261121/storage-panel.png
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const guard = require(path.join(__dirname, 'sandbox-guard.cjs'));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '项目/工作台改造修复/程序员B/产出/证据-bcac-20261121');
const PROJECT = '工作台改造修复';
const TEAM = path.join(guard.sandboxTmp(), 'bcacui-' + Date.now() + '-团队');

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.addEventListener('message', (event) => { const msg = JSON.parse(String(event.data)); if (msg.id && this.pending.has(msg.id)) { const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id); if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result); } }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r && r.exceptionDetails) throw new Error('evaluate failed: ' + String((r.exceptionDetails.text || (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '')).slice(0, 300));
    return r && r.result ? r.result.value : undefined;
  }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitTarget(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/list');
      const list = await res.json();
      const page = (list || []).find((t) => t.type === 'page' && /index\.html|renderer/i.test(String(t.url || '')));
      if (page) return page;
    } catch { /* ignore */ }
    await sleep(300);
  }
  return null;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const sb = guard.sandboxTmp();
  const dataDir = path.join(sb, 'bcacui-data');
  const store = path.join(dataDir, 'workbench.json');
  fs.mkdirSync(path.join(dataDir), { recursive: true });
  fs.writeFileSync(store, JSON.stringify({ version: 1, activeProjectId: '', projects: [], ui: {} }, null, 2), 'utf8');
  const port = 9800 + Math.floor(Math.random() * 100);
  const env = {
    ...process.env,
    ...guard.sandboxEnv(),
    AWB_DATA_DIR: dataDir, AWB_STORE: store, AWB_TEAM_ROOT: path.join(sb, 'bcacui-团队'),
    TEAM_ROOT: path.join(sb, 'bcacui-团队'), TEAM_PROJECTS_ROOT: path.join(sb, 'bcacui-项目'),
    TEAM_WORKBENCH_JSON: store, TEAM_SELFTEST: '1',
    AWB_START_HIDDEN: '1', AWB_SHOW_INACTIVE: '1', DSH_WEB_URL: 'http://127.0.0.1:1',
    AWB_BACKGROUND_THROTTLING: '0',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, '--remote-debugging-port=' + port], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  child.stderr.on('data', (d) => { stdout += String(d); });
  let ws = null;
  try {
    const target = await waitTarget(port);
    if (!target) throw new Error('CDP 目标未出现');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.evaluate(`new Promise((r) => { const t0 = Date.now(); const tick = () => { if (window.workbench && document.querySelector('#more-menu')) return r(true); if (Date.now() - t0 > 20000) return r(false); setTimeout(tick, 60); }; tick(); })`);
    await cdp.evaluate(`new Promise((r) => { const t0 = Date.now(); const tick = () => { if (typeof window.__awbOpenStoragePanel === 'function') return r(true); if (Date.now() - t0 > 15000) return r(false); setTimeout(tick, 50); }; tick(); })`);
    await cdp.evaluate(`(async () => { window.__awbOpenStoragePanel(); return true; })()`);
    const info = await cdp.evaluate(`new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const mask = document.querySelector('[data-storage-modal]');
        const summary = mask && mask.querySelector('[data-storage-summary]');
        const text = summary ? String(summary.textContent || '') : '';
        if (mask && text.includes('临时沙盘占用') && text.includes('上限')) {
          const card = mask.querySelector('[data-storage-card]');
          return resolve({
            ok: true,
            text,
            hasDataInput: Boolean(mask.querySelector('[data-storage-data-dir]')),
            hasTmpInput: Boolean(mask.querySelector('[data-storage-tmp-dir]')),
            hasSave: Boolean(mask.querySelector('[data-storage-save]')),
            hasClean: Boolean(mask.querySelector('[data-storage-clean]')),
            rect: card ? card.getBoundingClientRect().toJSON() : null,
          });
        }
        if (Date.now() - t0 > 10000) return resolve({ ok: true, text, timedOut: true });
        setTimeout(tick, 80);
      };
      tick();
    })`);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const pngPath = path.join(OUT, 'storage-panel.png');
    fs.writeFileSync(pngPath, Buffer.from(shot.data, 'base64'));
    const result = { at: new Date().toISOString(), info, pngPath, bytes: fs.statSync(pngPath).size };
    fs.writeFileSync(path.join(OUT, 'ui-shot.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ ok: info.ok, text: info.text, hasInputs: info.hasDataInput && info.hasTmpInput, hasButtons: info.hasSave && info.hasClean, png: pngPath, bytes: result.bytes }));
    process.exitCode = info.ok && info.text.includes('临时沙盘占用') && info.text.includes('上限') && info.hasSave && info.hasClean ? 0 : 1;
  } catch (error) {
    console.error('FAILED ' + String((error && error.message) || error));
    console.error(String(stdout).slice(-1200));
    process.exitCode = 1;
  } finally {
    try { if (ws) ws.close(); } catch { /* ignore */ }
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 20000 }); } catch { /* ignore */ }
    try { fs.rmSync(TEAM, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})();
