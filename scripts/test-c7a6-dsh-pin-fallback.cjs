'use strict';
/**
 * T-20261122-052540-c7a6（P1 DSH 端口变更自愈）：
 * 1) 假 DSH 监听随机端口；旧 pin 地址无人监听 → 发现扫到新端口，返回 DSH_FOUND_PIN_UNREACHABLE；
 * 2) 全程 ≤3 秒（快速回退）；结果 shouldPersist=true（main 会写 dsh.json source=auto/pinned=false）；
 * 3) 静态检查 main：pin 失效写 pinned:false、3 秒内回退、30 秒离线重试；
 * 4) cookie 重签由 main 的 installDshCookie 在 new DshAdapter 后调用（同 authority，静态检查）。
 * 不访问真实 DSH、不写真实 dsh.json。
 */
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const adapter = require(path.join(ROOT, 'src', 'dsh-adapter.js'));
const results = [];
function check(name, fn) { try { fn(); results.push(true); console.log(`PASS ${name}`); } catch (e) { results.push(false); console.log(`FAIL ${name}: ${String(e && e.message || e)}`); } }

function startFakeDsh() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/json/version') { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no'); return; }
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><title>DSH · DeepSeek Harness</title><body>dsh login required</body></html>');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

(async () => {
  const fake = await startFakeDsh();
  try {
    const live = 'http://127.0.0.1:' + fake.port;
    const dead = 'http://127.0.0.1:1';
    const started = Date.now();
    const result = await adapter.discoverDshWeb({
      // 假 DSH 的端口通过 env 暴露（真实环境里对应进程/端口文件/监听端口来源之一）；
      // 旧 pin 仍不可达，验证「pin 只作提示、env 命中即回退」。
      env: { DSH_WEB_URL: live },
      savedBaseUrl: dead,
      explicitBaseUrl: dead,
      explicitSource: 'dsh.json 显式配置',
      skipPortFiles: true,
      skipProcessDiscovery: true,
      skipListenerProbe: true,
      probeTimeoutMs: 500,
      totalBudgetMs: 4000,
      maxCandidates: 8,
    });
    const elapsed = Date.now() - started;
    check('旧 pin 不可达 → 扫到假 DSH 新端口', () => {
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.baseUrl, live);
      assert.strictEqual(result.code, 'DSH_FOUND_PIN_UNREACHABLE');
      assert.strictEqual(result.shouldPersist, true);
    });
    check('快速回退 ≤3 秒', () => { assert.ok(elapsed <= 3000, `elapsed=${elapsed}ms`); });
    const mainText = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    check('pin 失效写 dsh.json pinned:false + 刷新显式配置', () => {
      assert.match(mainText, /pinCleared/);
      assert.match(mainText, /persistDshConfig\(baseUrl, \{ source: 'auto', pinned: false \}\)/);
      assert.match(mainText, /DSH_EXPLICIT = readDshExplicitConfig\(\)/);
    });
    check('离线 30 秒自动重试已接线', () => {
      assert.match(mainText, /scheduleDshOfflineRetry/);
      assert.match(mainText, /}, 30000\)/);
    });
    check('pin 不阻止进程/监听端口作为主发现源', () => {
      const adapterText = fs.readFileSync(path.join(ROOT, 'src', 'dsh-adapter.js'), 'utf8');
      assert.match(adapterText, /dsh-desktop-host/);
      assert.match(adapterText, /collectDshProcessInfo/);
    });
    check('cookie 在切换新 authority 后重签', () => {
      assert.match(mainText, /dsh = new DshAdapter\(baseUrl\);/);
      assert.match(mainText, /await installDshCookie\(\)/);
    });
  } finally {
    await new Promise((resolve) => fake.server.close(resolve));
  }
  const failed = results.filter((v) => !v).length;
  console.log(`DSH_PIN_FALLBACK ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
