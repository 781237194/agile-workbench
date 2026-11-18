#!/usr/bin/env node
'use strict';
/**
 * e610 集成夹具（T-20261119-035127-c755）：壳层 app:upgrade-start 真正调用 install.ps1 -Upgrade
 *
 * 覆盖：
 *   E1 upgradeCheck 读 mock 版本源 → available（前置）
 *   E2 真实升级：IPC → 安装器（下载/sha 校验/备份/应用/自检/落账）→ ok/四步/steps/restartHint + 版本号从 1.0.0 变 1.1.0
 *   E3 缺 sha256：IPC 早拒（UPGRADE_SHA_REQUIRED），不产生 installer 记录
 *   E4 sha 不一致：安装器拒（UPGRADE_SHA_MISMATCH），版本不变、记录 steps.download=false
 *   E5 dry-run：只校验不下载，版本不变、记录 dryRun=true
 *   E6 强制升级缺 reason：UPGRADE_FORCE_REASON_REQUIRED
 *   E7 并发：第二次调用返回 UPGRADE_BUSY
 *   E8 记录不重复：一次升级只新增 1 条 source=installer 记录（壳层不再自己写）
 *
 * 跑法：node scripts/test-e610-integration.cjs
 * 隔离：全部在 %TEMP% 沙盘（安装根/数据/团队都指沙盘；AWB_INSTALLER_PS1 + AWB_UPGRADE_INSTALL_DIR + AWB_UPGRADE_FORCE_REAL
 *       仅夹具使用）；只杀自己 spawn 的 child.pid（P0 工装安全）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9987;
const RESULTS = [];
const ok = (c, name, d) => { RESULTS.push({ name, ok: Boolean(c), detail: c ? undefined : d }); console.log((c ? 'PASS' : 'FAIL') + '  ' + name + (c ? '' : ' :: ' + JSON.stringify(d))); if (!c) process.exitCode = 1; };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeFile(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function readUpgradeRows(dataDir) {
  try {
    return fs.readFileSync(path.join(dataDir, '升级记录.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function getJson(p) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 2500 }, (r) => {
      let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    });
    req.on('error', rej); req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}
class WS {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('ws error'));
      this.ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (!m.id) return;
        const p = this.pending.get(m.id); if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error).slice(0, 200))) : p.resolve(m.result);
      };
      this.ws.onclose = () => { for (const p of this.pending.values()) p.reject(new Error('closed')); this.pending.clear(); };
    });
  }
  send(method, params = {}, t = 180000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error('timeout ' + method)); }, t);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); res(v); }, reject: (e) => { clearTimeout(timer); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

(async () => {
  const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'e610-int-'));
  const INSTALL = path.join(SB, 'install');
  const DATA = path.join(SB, 'data');
  const TEAM = path.join(SB, '团队');
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(TEAM, { recursive: true });
  // 沙盘安装根（1.0.0）
  writeFile(path.join(INSTALL, 'package.json'), JSON.stringify({ name: 'pm-workbench', version: '1.0.0' }, null, 2) + '\n');
  fs.copyFileSync(path.join(ROOT, 'install.ps1'), path.join(INSTALL, 'install.ps1'));
  writeFile(path.join(INSTALL, 'start.cmd'), ['@echo off', 'echo [检查] APP_DIR=fake', 'echo [检查] electron 存在', 'exit /b 0', ''].join('\r\n'));
  writeFile(path.join(INSTALL, 'src', 'main.js'), '// v1.0.0\n');
  writeFile(path.join(INSTALL, 'dsh-plugin', 'cordis.patch.yml'), '# v1\n');
  // 新版本 1.1.0 的 zip
  const NEW = path.join(SB, 'newpkg');
  writeFile(path.join(NEW, 'package.json'), JSON.stringify({ name: 'pm-workbench', version: '1.1.0' }, null, 2) + '\n');
  writeFile(path.join(NEW, 'src', 'main.js'), '// v1.1.0\n');
  fs.copyFileSync(path.join(ROOT, 'install.ps1'), path.join(NEW, 'install.ps1'));
  writeFile(path.join(NEW, 'start.cmd'), ['@echo off', 'echo [检查] APP_DIR=fake', 'echo [检查] electron 存在', 'exit /b 0', ''].join('\r\n'));
  writeFile(path.join(NEW, 'dsh-plugin', 'cordis.patch.yml'), '# v1.1\n');
  const zipPath = path.join(SB, 'ok.zip');
  const zipRes = spawnSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path "${NEW}\\*" -DestinationPath "${zipPath}" -Force`], { encoding: 'utf8', timeout: 120000 });
  if (zipRes.status !== 0 || !fs.existsSync(zipPath)) throw new Error('Compress-Archive failed: ' + String(zipRes.stderr || '').slice(0, 200));
  const goodZip = fs.readFileSync(zipPath);
  const goodSha = sha256(goodZip);
  const base = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/ok.zip') { res.writeHead(200, { 'content-type': 'application/zip' }); res.end(goodZip); return; }
      if (req.url === '/feed-ok') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ version: '9.9.9', sha256: goodSha, url: `http://127.0.0.1:${srv.address().port}/ok.zip` })); return; }
      res.writeHead(404); res.end('nope');
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, srv }));
  });

  // 沙盘最小 store
  writeFile(path.join(DATA, 'userdata', 'workbench.json'), JSON.stringify({ version: 1, activeProjectId: '', projects: [], ui: {} }, null, 2) + '\n');
  const env = {
    ...process.env,
    AWB_DATA_DIR: DATA,
    AWB_STORE: path.join(DATA, 'userdata', 'workbench.json'),
    TEAM_ROOT: TEAM,
    AWB_TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: path.join(TEAM, '状态', '项目'),
    TEAM_WORKBENCH_JSON: path.join(DATA, 'userdata', 'workbench.json'),
    TEAM_SELFTEST: '1',
    AWB_BOARD_PREGEN_MS: '0',
    AWB_INSTALLER_PS1: path.join(INSTALL, 'install.ps1'),
    AWB_UPGRADE_INSTALL_DIR: INSTALL,
    AWB_UPGRADE_FORCE_REAL: '1'
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const pid = child.pid;
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  let cdp = null;
  try {
    let list = null;
    for (let i = 0; i < 80; i += 1) {
      try { list = await getJson('/json/list'); if (Array.isArray(list) && list.some((t) => t.type === 'page')) break; } catch { /* wait */ }
      await sleep(400);
    }
    const page = (list || []).find((t) => t.type === 'page' && /renderer[\\/]index\.html/i.test(String(t.url || ''))) || (list || []).find((t) => t.type === 'page');
    if (!page) throw new Error('找不到渲染层页面（CDP）');
    cdp = new WS(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const evalJs = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 240000 });
      if (r && r.exceptionDetails) throw new Error('evaluate: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r && r.result ? r.result.value : null;
    };
    for (let i = 0; i < 60; i += 1) { if (await evalJs('Boolean(window.workbench && window.workbench.upgradeStart)')) break; await sleep(300); }

    // E1 upgradeCheck
    const check = await evalJs(`window.workbench.appVersion ? window.workbench.upgradeCheck({ source: '${base.url}/feed-ok' }) : null`);
    ok(Boolean(check) && (check.state === 'available' || check.code === 'UPGRADE_AVAILABLE'), 'E1 upgradeCheck 读到 mock 版本源 → available', { check });

    // E2 真实升级（IPC → 安装器）
    const before = readUpgradeRows(DATA).length;
    const up = await evalJs(`window.workbench.upgradeStart({ latest: '1.1.0', sha256: '${goodSha}', url: '${base.url}/ok.zip' })`);
    ok(Boolean(up) && up.ok === true, 'E2a IPC 调安装器真实升级成功', { up });
    ok(up && up.steps && up.steps.backup && up.steps.download && up.steps.apply && up.steps.selfcheck, 'E2b 四步全 true（来自安装器记录）', { steps: up && up.steps });
    ok(up && String(up.from) === '1.0.0' && String(up.to) === '1.1.0' && String(up.sha256) === goodSha, 'E2c from/to/sha256 回填正确', { up });
    ok(up && /请重启后生效/.test(String(up.restartHint || '')), 'E2d 重启提示透传（[data-upgrade-restart-hint] 数据源）', { hint: up && up.restartHint });
    ok(readJson(path.join(INSTALL, 'package.json'), {}).version === '1.1.0', 'E2e 沙盘安装根已被安装器升级到 1.1.0', {});
    const rowsAfter = readUpgradeRows(DATA);
    ok(rowsAfter.length === before + 1 && rowsAfter[rowsAfter.length - 1].source === 'installer', 'E2f 只新增 1 条 source=installer 记录（壳层未重复写）', { added: rowsAfter.length - before });

    // E3 缺 sha
    const before3 = readUpgradeRows(DATA).length;
    const noSha = await evalJs(`window.workbench.upgradeStart({ latest: '1.2.0', url: '${base.url}/ok.zip' })`);
    ok(noSha && noSha.code === 'UPGRADE_SHA_REQUIRED', 'E3 缺 sha256 → UPGRADE_SHA_REQUIRED（不调安装器）', { noSha });
    ok(readUpgradeRows(DATA).length === before3, 'E3b 缺 sha 不产生记录', {});

    // E4 sha 不一致
    const bad = await evalJs(`window.workbench.upgradeStart({ latest: '1.2.0', sha256: '${'f'.repeat(64)}', url: '${base.url}/ok.zip' })`);
    ok(bad && bad.ok === false, 'E4a sha 不一致 → ok:false', { bad });
    ok(bad && bad.code === 'UPGRADE_SHA_MISMATCH', 'E4b 错误码来自安装器记录（UPGRADE_SHA_MISMATCH）', { code: bad && bad.code });
    ok(readJson(path.join(INSTALL, 'package.json'), {}).version === '1.1.0', 'E4c 校验失败版本不变', {});

    // E5 dry-run
    const dry = await evalJs(`window.workbench.upgradeStart({ latest: '1.3.0', sha256: '${goodSha}', url: '${base.url}/ok.zip', dryRun: true })`);
    ok(dry && dry.ok === true && dry.dryRun === true, 'E5a dry-run 走安装器 dry-run 且成功', { dry });
    ok(readJson(path.join(INSTALL, 'package.json'), {}).version === '1.1.0', 'E5b dry-run 不改版本', {});

    // E6 强制缺 reason
    const noReason = await evalJs(`window.workbench.upgradeStart({ latest: '1.1.0', sha256: '${goodSha}', url: '${base.url}/ok.zip', force: true })`);
    ok(noReason && noReason.code === 'UPGRADE_FORCE_REASON_REQUIRED', 'E6 强制升级缺 reason 被拒', { noReason });

    // E7 并发 UPGRADE_BUSY
    const busy = await evalJs(`(async () => {
      const a = window.workbench.upgradeStart({ latest: '1.1.0', sha256: '${goodSha}', url: '${base.url}/ok.zip', dryRun: true });
      const b = await window.workbench.upgradeStart({ latest: '1.1.0', sha256: '${goodSha}', url: '${base.url}/ok.zip', dryRun: true });
      const ra = await a;
      return { b, a: ra };
    })()`);
    ok(Boolean(busy) && busy.b && busy.b.code === 'UPGRADE_BUSY', 'E7 升级中第二次调用 → UPGRADE_BUSY', { busy });
  } finally {
    try { fs.writeFileSync(path.join(process.env.AWB_E610_INT_OUT || path.join(os.tmpdir(), 'e610-int.json')), JSON.stringify({ at: new Date().toISOString(), sandbox: SB, results: RESULTS, logTail: log.slice(-1500) }, null, 2) + '\n', 'utf8'); } catch { /* ignore */ }
    console.log('\nE610_INTEGRATION ' + RESULTS.filter((r) => r.ok).length + '/' + RESULTS.length + (RESULTS.every((r) => r.ok) ? ' PASS' : ' FAIL'));
    try { if (cdp) cdp.close(); } catch { /* ignore */ }
    try { if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    try { base.srv.close(); } catch { /* ignore */ }
    if (process.env.AWB_E610_INT_KEEP === '1') console.log('KEEP_SANDBOX ' + SB);
    else { try { fs.rmSync(SB, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* ignore */ } }
  }
})().catch((e) => { console.error('E610_INTEGRATION_FAILED ' + String((e && e.message) || e).slice(0, 400)); process.exitCode = 2; });
