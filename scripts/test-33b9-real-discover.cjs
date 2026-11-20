'use strict';
/**
 * B-33b9 真实环境证据（不依赖工作台 UI）：本机真实 DSH 换端口后，发现链从「旧地址失效」
 * 自动跟到当前真实端口并通过 DSH 身份校验（online）。
 *
 * 口径：netstat 监听端口枚举 + 特征校验（非端口文件/非进程名/非全段扫描）；
 *       结果写入 产出/证据-33b9-20261121/real-discover.json。
 */
const fs = require('node:fs');
const path = require('node:path');
const adapter = require(path.resolve(__dirname, '..', 'src', 'dsh-adapter.js'));

(async () => {
  const listeners = await adapter.listWindowsListeners({ timeoutMs: 1000 });
  const ports = (listeners.listeners || []).map((row) => row.port);
  let realPort = 0;
  for (const port of ports.slice(0, 40)) {
    const probe = await adapter.probeDshWeb('http://127.0.0.1:' + port, { timeoutMs: 600 });
    if (probe.ok) { realPort = port; break; }
  }
  if (!realPort) throw new Error('本机没有可识别的 DSH');
  const deadPort = 65533;
  const started = Date.now();
  const discovery = await adapter.discoverDshWeb({
    env: {},
    savedBaseUrl: 'http://127.0.0.1:' + deadPort,
    skipPortFiles: true,
    probeTimeoutMs: 250,
    totalBudgetMs: 1500
  });
  const elapsedMs = Date.now() - started;
  const check = discovery.ok ? await new adapter.DshAdapter(discovery.baseUrl).check({ timeoutMs: 3000 }) : null;
  const out = {
    at: new Date().toISOString(),
    listeners: ports.length,
    realPort,
    deadPort,
    discovery: {
      ok: discovery.ok,
      code: discovery.code,
      baseUrl: discovery.baseUrl,
      source: discovery.source,
      durationMs: discovery.durationMs,
      stats: discovery.stats,
      processDiscovery: discovery.processDiscovery
    },
    check: check ? { online: check.online, code: check.code, sessions: check.sessions, baseUrl: check.baseUrl } : null,
    elapsedMs
  };
  const dir = path.resolve(__dirname, '..', '项目', '工作台改造修复', '程序员A', '产出', '证据-33b9-20261121');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'real-discover.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(out, null, 2));
  const ok = discovery.ok && discovery.baseUrl.endsWith(':' + realPort) && check && check.online && Number(discovery.durationMs) <= 1500;
  console.log(ok ? 'REAL_DISCOVER_PASS' : 'REAL_DISCOVER_FAIL');
  process.exitCode = ok ? 0 : 1;
})().catch((e) => { console.error('EX', (e && e.stack) || e); process.exitCode = 1; });
