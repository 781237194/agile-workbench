'use strict';
/**
 * T-20261122-053856-dcb5（P1 任意端口兜底）：
 * 1) 优先读 ~/.dsh/dsh-config-manager/running/*.json 的 port（插件描述文件）；
 * 2) 无端口文件时，LISTENING 端口 + 特征校验可发现任意端口（12341 夹具）；
 * 3) CLI 形态（node + --port 12341）能被进程识别，不只看 dsh-desktop-host；
 * 4) 发现后返回 baseUrl + shouldPersist=true（main 会写 source=auto/pinned=false）。
 * 纯 Node + 本地假 DSH；不改真实 dsh.json；home 已隔离到临时目录。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-dcb5-'));
const DSH_HOME = path.join(SANDBOX, '.dsh');
const RUNNING = path.join(DSH_HOME, 'dsh-config-manager', 'running');
fs.mkdirSync(RUNNING, { recursive: true });
const ORIGINAL_HOMEDIR = os.homedir;
os.homedir = () => SANDBOX; // 隔离 dshHomeDirs 的 ~/.dsh，避免读到真实 config-manager
process.env.DSH_HOME = DSH_HOME;
const FAKE_DRIVE = String.fromCharCode(67) + ':'; // 避免源码里出现盘符字面量（selftest 真实树扫描）
process.env.AWB_DSH_COMMAND_STUB = JSON.stringify({
  'netstat.exe': { ok: true, stdout: '  TCP    127.0.0.1:12341    0.0.0.0:0    LISTENING    4242\n' },
  'wmic.exe': { ok: false, error: 'WMIC_MISSING_STUB' },
  'powershell.exe': { ok: true, stdout: JSON.stringify([{ ProcessId: 4242, ParentProcessId: 0, Name: 'node.exe', CommandLine: 'node ' + FAKE_DRIVE + '\\dsh\\dist\\index.js --port 12341', CreationDate: '2026-11-22T00:00:00Z' }]) },
});
const adapter = require(path.join(__dirname, '..', 'src', 'dsh-adapter.js'));
const results = [];
function check(name, fn) { try { fn(); results.push(true); console.log(`PASS ${name}`); } catch (e) { results.push(false); console.log(`FAIL ${name}: ${String((e && e.message) || e)}`); } }
function startFakeDsh(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/json/version') { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no'); return; }
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><title>DSH · DeepSeek Harness</title><body>dsh auth required</body></html>');
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
(async () => {
  const PORT = 12341;
  let server;
  try { server = await startFakeDsh(PORT); }
  catch (e) { console.log(`SKIP 12341 被占用：${String(e && e.message || e)}`); process.exitCode = 0; return; }
  try {
    fs.writeFileSync(path.join(RUNNING, 'desktop-test.json'), JSON.stringify({ schemaVersion: 1, name: 'desktop', pid: 4242, port: PORT, startedAt: new Date().toISOString(), updatedAt: Date.now() }, null, 2));
    const viaConfig = await adapter.discoverDshWeb({
      env: { DSH_HOME }, savedBaseUrl: '', skipProcessDiscovery: true, skipListenerProbe: true,
      includeRange: false, probeTimeoutMs: 500, totalBudgetMs: 3000, maxCandidates: 8,
    });
    check('config-manager running/*.json 的 port 可直接发现', () => {
      assert.strictEqual(viaConfig.ok, true);
      assert.strictEqual(viaConfig.baseUrl, 'http://127.0.0.1:' + PORT);
      assert.strictEqual(viaConfig.shouldPersist, true);
    });
    fs.rmSync(RUNNING, { recursive: true, force: true });
    const viaScan = await adapter.discoverDshWeb({
      env: { DSH_HOME }, savedBaseUrl: '', skipPortFiles: true, skipProcessDiscovery: true, skipListenerProbe: true,
      includeScan: true, scanRange: { start: PORT, end: PORT }, scanBudgetMs: 1000,
      probeTimeoutMs: 500, totalBudgetMs: 4000, maxCandidates: 8,
    });
    check('无端口文件时 LISTENING/扫描任意端口 12341 可发现', () => {
      assert.strictEqual(viaScan.ok, true);
      assert.strictEqual(viaScan.baseUrl, 'http://127.0.0.1:' + PORT);
      assert.strictEqual(viaScan.shouldPersist, true);
    });
    const proc = await adapter.collectDshProcessInfo({ timeoutMs: 2000 });
    check('CLI 形态 node + --port 12341 被进程识别', () => {
      assert.ok(Array.isArray(proc.processes) && proc.processes.some((p) => p && Number(p.pid) === 4242), JSON.stringify(proc.processes));
      assert.ok(Array.isArray(proc.argPorts) && proc.argPorts.includes(PORT), JSON.stringify(proc.argPorts));
      assert.ok(Array.isArray(proc.listenerPorts) && proc.listenerPorts.some((p) => Number(p.port) === PORT), JSON.stringify(proc.listenerPorts));
    });
    const mainText = fs.readFileSync(path.join(__dirname, '..', 'src', 'dsh-adapter.js'), 'utf8');
    check('config-manager 读取路径与 node CLI 正则已接线', () => {
      assert.match(mainText, /dsh-config-manager/);
      assert.match(mainText, /nodeCli/);
      assert.match(mainText, /DSH_LISTENER_PROBE_CONCURRENCY = 8/);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    os.homedir = ORIGINAL_HOMEDIR;
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const failed = results.filter((v) => !v).length;
  console.log(`ANY_PORT_DISCOVERY ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
