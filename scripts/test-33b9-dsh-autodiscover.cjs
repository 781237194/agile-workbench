'use strict';
/**
 * B-20261121-033853-33b9（P0 DSH 地址自愈）夹具。
 *
 * 口径：真实 HTTP mock 充当 DSH（401 + dsh 特征），netstat 输出用 AWB_DSH_COMMAND_STUB 注入，
 *       不读真实端口、不写真实 dsh.json（只验证 discoverDshWeb 的返回与 npm 侧守卫文本）。
 * 六类场景：首次 / 正常（上次地址失效）/ 空值（无 DSH 监听）/ 越权（用户 pin 不被覆盖）/
 *          并发重复（两次发现）/ 降级（netstat 不可用→回退 env 旧逻辑）。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const adapter = require(path.join(ROOT, 'src', 'dsh-adapter.js'));

const R = [];
function check(id, name, ok, detail) {
  R.push({ id, name, ok: Boolean(ok) });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + id + ' ' + name + (ok || detail === undefined ? '' : '  ← ' + JSON.stringify(detail).slice(0, 600)));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function netstatLine(port, pid) {
  return '  TCP    127.0.0.1:' + port + '    0.0.0.0:0    LISTENING    ' + pid;
}
function stubFor(ports, opts = {}) {
  if (opts.fail) return { 'netstat.exe': { ok: false, error: 'ENOENT: netstat mock missing' } };
  return {
    'netstat.exe': {
      ok: true,
      stdout: ['活动连接', '', ...ports.map((p, i) => netstatLine(p, 4000 + i))].join('\r\n') + '\r\n'
    }
  };
}

async function startMockDsh() {
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 'x', name: 'DeepSeek Harness' }));
      return;
    }
    res.writeHead(401, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>DSH Web authentication required</title>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

const ORIG = {
  stub: process.env.AWB_DSH_COMMAND_STUB,
  url: process.env.DSH_WEB_URL,
  port: process.env.DSH_WEB_PORT,
  dport: process.env.DSH_PORT
};
function restoreEnv() {
  for (const [key, value] of [['AWB_DSH_COMMAND_STUB', ORIG.stub], ['DSH_WEB_URL', ORIG.url], ['DSH_WEB_PORT', ORIG.port], ['DSH_PORT', ORIG.dport]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

(async () => {
  const mock = await startMockDsh();
  const live = mock.port;
  const dead1 = 65001;
  const dead2 = 65002;

  // D1 首次：没有任何上次地址，netstat 列表里混着死端口 + 真实端口。
  process.env.AWB_DSH_COMMAND_STUB = JSON.stringify(stubFor([dead1, live, dead2]));
  let r = await adapter.discoverDshWeb({ env: {}, savedBaseUrl: '', skipPortFiles: true, skipProcessDiscovery: true, probeTimeoutMs: 400 });
  check('D1', '首次：从 netstat 监听端口命中 DSH（来源 netstat-port）', r.ok && r.code === 'DSH_FOUND' && r.source === 'netstat-port', r);
  check('D1b', '发现链 ≤1.5s、未扫全段（scanAttempts=0）', Number(r.durationMs) <= 1500 && r.stats && r.stats.scanAttempts === 0, { durationMs: r.durationMs, stats: r.stats });
  check('D1c', '监听端口计数与探测数如实（≥3 个候选）', r.stats.listenerCount >= 3 && r.stats.listenerProbes >= 3, r.stats);

  // D2 正常：上次保存地址已失效（死端口），自动跟到新端口并允许回写（shouldPersist=true）。
  r = await adapter.discoverDshWeb({ env: {}, savedBaseUrl: 'http://127.0.0.1:' + dead1, skipPortFiles: true, skipProcessDiscovery: true, probeTimeoutMs: 400 });
  check('D2', '正常：上次地址失效→自动切到新端口且 shouldPersist=true', r.ok && r.baseUrl.endsWith(':' + live) && r.shouldPersist === true, r);
  check('D2b', '过程发现用 netstat pid→端口，不再报「dsh 进程=0 个」',
    r.processDiscovery && r.processDiscovery.identified === true && Array.isArray(r.processDiscovery.ports) && r.processDiscovery.ports[0] === live
      && !/dsh 进程=0 个/.test(String(r.message || '')), r.processDiscovery);

  // D3 空值：监听端口里没有 DSH（401 特征不出现）→ failed + 三段式人话 + 技术明细。
  process.env.AWB_DSH_COMMAND_STUB = JSON.stringify(stubFor([dead1, dead2]));
  r = await adapter.discoverDshWeb({ env: {}, savedBaseUrl: 'http://127.0.0.1:' + dead2, skipPortFiles: true, skipProcessDiscovery: true, probeTimeoutMs: 200 });
  check('D3', '空值：无 DSH 监听→DSH_NOT_FOUND 且不谎报进程=0个',
    !r.ok && r.code === 'DSH_NOT_FOUND' && !/dsh 进程=0 个/.test(String(r.message || '')) && !/dsh 进程=0 个/.test((r.details || []).join('；')),
    { message: r.message, details: r.details });
  check('D3b', '失败人话三段式（≤3 行）+ 技术明细保留',
    Array.isArray(r.diagnosticLines) && r.diagnosticLines.length === 3
      && /已检查 \d+ 个监听端口/.test(r.diagnosticLines[0])
      && /最近一次地址/.test(r.diagnosticLines[1])
      && /下一步/.test(r.diagnosticLines[2])
      && Array.isArray(r.details) && r.details.length >= 2, { lines: r.diagnosticLines, details: r.details });

  // D4 越权：用户 pin（显式配置）活着时直接命中，不会被自动发现替换；pin 死了也不能覆盖 dsh.json。
  process.env.AWB_DSH_COMMAND_STUB = JSON.stringify(stubFor([dead1, live]));
  r = await adapter.discoverDshWeb({ env: {}, explicitBaseUrl: 'http://127.0.0.1:' + live, explicitSource: 'dsh.json 显式配置', savedBaseUrl: 'http://127.0.0.1:' + live, skipPortFiles: true, skipProcessDiscovery: true, probeTimeoutMs: 400 });
  check('D4', '越权：显式 pin 命中即用（source=explicit），不进入自动替换', r.ok && r.source === 'explicit' && r.baseUrl.endsWith(':' + live), r);
  r = await adapter.discoverDshWeb({ env: {}, explicitBaseUrl: 'http://127.0.0.1:' + dead1, explicitSource: 'dsh.json 显式配置', savedBaseUrl: 'http://127.0.0.1:' + dead1, skipPortFiles: true, skipProcessDiscovery: true, probeTimeoutMs: 300 });
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const pinGuard = /const mayPersist = !pinActive && discovery\.shouldPersist !== false;/.test(mainSrc)
    && /DSH_PIN_UNREACHABLE_TEMP_FALLBACK/.test(mainSrc);
  check('D4b', '越权：pin 失效只临时用命中地址，采纳处有「不得覆盖 pin」守卫',
    r.ok && r.code === 'DSH_FOUND_PIN_UNREACHABLE' && pinGuard, { code: r.code, pinGuard });

  // D5 并发重复：两次发现同时跑，都拿到同一地址，不产生重复候选/错误。
  const [r1, r2] = await Promise.all([
    adapter.discoverDshWeb({ env: {}, savedBaseUrl: 'http://127.0.0.1:' + dead2, skipPortFiles: true, skipProcessDiscovery: true, probeTimeoutMs: 400 }),
    adapter.discoverDshWeb({ env: {}, savedBaseUrl: 'http://127.0.0.1:' + dead2, skipPortFiles: true, skipProcessDiscovery: true, probeTimeoutMs: 400 })
  ]);
  check('D5', '并发重复：两次发现都成功且地址一致（无状态互相污染）',
    r1.ok && r2.ok && r1.baseUrl === r2.baseUrl && r1.baseUrl.endsWith(':' + live), { a: r1.baseUrl, b: r2.baseUrl, d1: r1.durationMs, d2: r2.durationMs });

  // D6 降级：netstat 不可用 → 回退旧逻辑（env 端口仍能命中）；全无来源时失败也要写明 netstat 不可用。
  process.env.AWB_DSH_COMMAND_STUB = JSON.stringify(stubFor([], { fail: true }));
  r = await adapter.discoverDshWeb({ env: { DSH_WEB_PORT: String(live) }, savedBaseUrl: '', skipPortFiles: true, skipProcessDiscovery: true, probeTimeoutMs: 400 });
  check('D6', '降级：netstat 不可用→回退 env 端口逻辑仍能命中', r.ok && r.source === 'env-port' && r.baseUrl.endsWith(':' + live), r);
  r = await adapter.discoverDshWeb({ env: {}, savedBaseUrl: '', skipPortFiles: true, skipProcessDiscovery: true, probeTimeoutMs: 200 });
  const degradedText = [r.message, ...(r.details || [])].join('；');
  check('D6b', '降级：netstat 不可用时失败文案写明原因（不静默）',
    !r.ok && /netstat 不可用|netstat 执行失败|监听端口枚举失败/.test(degradedText), { message: r.message, details: r.details });

  // D7 静态：生产路径不再扫全段（includeScan 必须显式为 true 才扫），main 里无 includeScan:true。
  const scanGate = /options\.includeScan === true/.test(fs.readFileSync(path.join(ROOT, 'src', 'dsh-adapter.js'), 'utf8'));
  check('D7', '不再扫 49152–65535 全段：生产默认关闭，仅显式 legacy 开关可开',
    scanGate && !/includeScan:\s*true/.test(mainSrc), { scanGate });

  restoreEnv();
  mock.server.close();
  console.log('\n' + R.filter((x) => x.ok).length + '/' + R.length + ' PASS');
  process.exitCode = R.some((x) => !x.ok) ? 1 : 0;
})().catch((e) => {
  restoreEnv();
  console.error('EX', (e && e.stack) || e);
  process.exitCode = 1;
});
