'use strict';
/**
 * B-33b9 冷启动 3 次样本（PM 04:04 要求）：每次**新起一个 Node 进程**，
 * 无 env（DSH_WEB_URL/PORT 全不设）、无 saved 地址，只靠「netstat 监听端口 → 特征校验」发现。
 * 输出 source / durationMs / baseUrl / 统计；父进程另记从 spawn 到结果的墙钟（含 Node 启动）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-33b9-20261121');
const adapterPath = path.join(ROOT, 'src', 'dsh-adapter.js');
const childCode = `
const a = require(${JSON.stringify(adapterPath)});
(async () => {
  const t = Date.now();
  const r = await a.discoverDshWeb({ env: {}, savedBaseUrl: '', skipPortFiles: true, skipProcessDiscovery: true, probeTimeoutMs: 250, totalBudgetMs: 1500 });
  process.stdout.write('@@' + JSON.stringify({ code: r.code, ok: r.ok, source: r.source, baseUrl: r.baseUrl, durationMs: r.durationMs, wallMs: Date.now() - t, stats: r.stats }) + '@@');
})().catch((e) => { process.stdout.write('@@' + JSON.stringify({ ok: false, error: String((e && e.message) || e) }) + '@@'); process.exitCode = 1; });
`;
const samples = [];
for (let i = 1; i <= 3; i += 1) {
  const t0 = Date.now();
  const child = spawnSync(process.execPath, ['-e', childCode], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    env: (() => {
      const env = { ...process.env };
      for (const key of ['DSH_WEB_URL', 'AWB_DSH_BASE_URL', 'DSH_WEB_PORT', 'DSH_PORT']) delete env[key];
      return env;
    })(),
    timeout: 20000
  });
  const stdout = String(child.stdout || '');
  const m = /@@([\s\S]*?)@@/.exec(stdout);
  let row = null;
  try { row = m ? JSON.parse(m[1]) : null; } catch { row = null; }
  samples.push({ run: i, spawnWallMs: Date.now() - t0, ...(row || { ok: false, error: String(child.stderr || '').slice(0, 300) }) });
}
const pass = samples.every((row) => row.ok && String(row.baseUrl || '').endsWith(':55263') && Number(row.durationMs) <= 1200);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'coldstart-3.json'), JSON.stringify({ at: new Date().toISOString(), samples, pass }, null, 2) + '\n', 'utf8');
for (const row of samples) {
  console.log('run ' + row.run + ' · source=' + row.source + ' · durationMs=' + row.durationMs + ' · spawnWallMs=' + row.spawnWallMs + ' · baseUrl=' + row.baseUrl
    + ' · ' + JSON.stringify({ listenerMs: row.stats && row.stats.listenerMs, tier1Ms: row.stats && row.stats.listenerTier1Ms, tier1Count: row.stats && row.stats.listenerTier1Count, probes: row.stats && row.stats.listenerProbes }));
}
console.log((pass ? 'COLDSTART_PASS' : 'COLDSTART_FAIL') + ' (3/3 ≤1200ms)');
process.exitCode = pass ? 0 : 1;
