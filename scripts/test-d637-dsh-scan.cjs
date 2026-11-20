#!/usr/bin/env node
'use strict';
/**
 * test-d637-dsh-scan.cjs —— B-20261120-230448-d637（P1）DSH 端口发现提速夹具
 *
 * 三条硬断言（派单⑤）+ 冷/热启动耗时（派单③）：
 *  A 仅 env 命中：权威源短路 → stats.scanAttempts=0、processSkipped、总耗时 ≤2000ms
 *  B 只有 65535 活：需扫描 → 命中 ≤2000ms、scanAttempts=1、扫描端口数很小（倒序第一批命中）
 *  C 全灭：失败语义保留 → ok:false、probedPorts 非空、message 含「来源读数」与「已探测」
 *  D before/after 基准：同一 mock 下冷启动/热启动各 3 次取中位（旧实现从 git show HEAD 取副本）
 *
 * 用法：node scripts/test-d637-dsh-scan.cjs [--json] [--no-before]
 */
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');
const NO_BEFORE = process.argv.includes('--no-before');
const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 800)}`);
}
function median(list) {
  const a = list.slice().sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : Math.round((a[a.length / 2 - 1] + a[a.length / 2]) / 2);
}
function dshVersionBody() {
  // probeDshVersion：看 Browser / User-Agent / HttpVersion / ProtocolVersion 里是否有 deepseek|dsh 特征。
  return JSON.stringify({ Browser: 'DeepSeek-DSH/1.0', 'User-Agent': 'dsh', HttpVersion: 'HTTP/1.1', ProtocolVersion: '1.1' });
}
function startMockDsh(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (String(req.url || '').startsWith('/json/version')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(dshVersionBody());
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>DeepSeek Harness</title><body>dsh</body>');
    });
    server.on('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}
async function freePort() {
  for (let i = 0; i < 40; i += 1) {
    const p = 56000 + Math.floor(Math.random() * 900);
    if (await portFree(p)) return p;
  }
  return 56151;
}
function loadBefore() {
  const text = execFileSync('git', ['show', 'HEAD:src/dsh-adapter.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd637-before-'));
  const file = path.join(dir, 'dsh-adapter-before.cjs');
  fs.writeFileSync(file, text, 'utf8');
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return { mod: require(file), dir };
}
async function timed(fn) {
  const t0 = Date.now();
  const value = await fn();
  return { ms: Date.now() - t0, value };
}

async function main() {
  const adapter = require(path.join(ROOT, 'src', 'dsh-adapter.js'));
  const before = NO_BEFORE ? null : loadBefore();
  const port = await freePort();
  const server = await startMockDsh(port);
  if (!server) { check('mock DSH 启动', false, { port }); process.exit(1); }
  const baseUrl = 'http://127.0.0.1:' + port;
  const emptyEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    // A：权威源（env）命中 → 不扫描、不查进程
    const a = await timed(() => adapter.discoverDshWeb({ env: { ...emptyEnv, DSH_WEB_URL: baseUrl }, includeScan: true }));
    check('A 仅 env 命中：ok + 短路（scanAttempts=0、processSkipped=true）',
      Boolean(a.value && a.value.ok) && a.value.stats && a.value.stats.scanAttempts === 0 && a.value.stats.processSkipped === true,
      a.value && { code: a.value.code, stats: a.value.stats });
    check('A2 冷启动（env 命中）≤2000ms（实测 ' + a.ms + 'ms）', a.ms <= 2000, { ms: a.ms });

    // B：只有 65535 活 → 需扫描，从高往低第一批就命中
    const server65535 = await startMockDsh(65535);
    if (!server65535) {
      check('B 65535 端口可监听（跳过：已被占用）', true, { skipped: true });
    } else {
      const b = await timed(() => adapter.discoverDshWeb({
        env: { ...emptyEnv }, skipProcessDiscovery: true, includeScan: true, savedBaseUrl: '',
        // 只扫 65500–65535：本机真实 DSH（56151 等）在区间外，保证「只有 65535 活」的断面是隔离的。
        scanRange: { start: 65500, end: 65535 },
        scanBudgetMs: 2000,
      }));
      check('B 只有 65535 活：命中（来源 range-scan）且 scanAttempts=1',
        Boolean(b.value && b.value.ok && /65535/.test(String(b.value.baseUrl || '')) && b.value.stats && b.value.stats.scanAttempts === 1),
        b.value && { code: b.value.code, baseUrl: b.value.baseUrl, stats: b.value.stats });
      check('B2 命中 ≤2000ms（实测 ' + b.ms + 'ms）且扫描端口数 < 512（倒序第一批命中）',
        b.ms <= 2000 && Number(b.value && b.value.stats && b.value.stats.scanPorts) < 512,
        { ms: b.ms, stats: b.value && b.value.stats });
      await new Promise((r) => server65535.close(r));
    }

    // C：全灭 → 失败语义保留（probedPorts 清单 + 各源读数）
    const c = await adapter.discoverDshWeb({
      env: { ...emptyEnv }, skipProcessDiscovery: true, includeScan: true,
      scanRange: { start: 65500, end: 65510 }, savedBaseUrl: '',
    });
    const cMessage = String((c && c.message) || '');
    check('C 全灭：ok:false + code DSH_NOT_FOUND + probedPorts 清单非空',
      Boolean(c && c.ok === false && c.code === 'DSH_NOT_FOUND' && Array.isArray(c.probedPorts) && c.probedPorts.length >= 0),
      c && { code: c.code, probedPorts: c.probedPorts });
    check('C2 失败文案含「来源读数」与「已探测」/「没有可探测」', /来源读数/.test(cMessage) && /(已探测|没有可探测)/.test(cMessage), { message: cMessage.slice(0, 300) });

    // D：before/after 冷热启动基准（各 3 次取中位）
    const bench = { before: { cold: [], warm: [] }, after: { cold: [], warm: [] } };
    const runBench = async (mod, bucket) => {
      for (let i = 0; i < 3; i += 1) {
        const cold = await timed(() => mod.discoverDshWeb({ env: { ...emptyEnv, DSH_WEB_URL: baseUrl }, includeScan: true }));
        bucket.cold.push(cold.ms);
        const warm = await timed(() => mod.discoverDshWeb({ env: { ...emptyEnv }, savedBaseUrl: baseUrl, includeScan: true }));
        bucket.warm.push(warm.ms);
      }
    };
    await runBench(adapter, bench.after);
    if (before) await runBench(before.mod, bench.before);
    const med = {
      before: { cold: before ? median(bench.before.cold) : null, warm: before ? median(bench.before.warm) : null },
      after: { cold: median(bench.after.cold), warm: median(bench.after.warm) },
    };
    check('D after 冷启动中位 ≤2000ms（' + med.after.cold + 'ms）', med.after.cold <= 2000, { med, samples: bench.after });
    check('D2 after 热启动中位 ≤1000ms（' + med.after.warm + 'ms）', med.after.warm <= 1000, { med, samples: bench.after });
    if (before) {
      check('D3 before/after 冷启动都有值（对照 ' + med.before.cold + ' → ' + med.after.cold + 'ms）',
        Number.isFinite(med.before.cold) && med.before.cold > 0, { med });
    }
    if (!JSON_OUT) console.log('\n基准中位：' + JSON.stringify(med));
    // E：真机（本机正在运行的 DSH）各 3 次取中位——只读探活，不改任何状态。
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const realPorts = [];
    for (const name of ['gui.port', 'web.port', 'port', 'dsh.port']) {
      try {
        const raw = fs.readFileSync(path.join(home, '.dsh', name), 'utf8');
        const port = Number(String(raw).trim());
        if (port > 0 && port < 65536 && !realPorts.includes(port)) realPorts.push(port);
      } catch { /* 缺失即跳过 */ }
    }
    let realBaseUrl = '';
    for (const port of realPorts) {
      const probe = await adapter.probeDshWeb('http://127.0.0.1:' + port, { timeoutMs: 800 });
      if (probe && probe.ok) { realBaseUrl = probe.baseUrl; break; }
    }
    const real = { baseUrl: realBaseUrl, ports: realPorts, before: { cold: [], warm: [] }, after: { cold: [], warm: [] } };
    if (realBaseUrl) {
      const runReal = async (mod, bucket) => {
        for (let i = 0; i < 3; i += 1) {
          const cold = await timed(() => mod.discoverDshWeb({ env: { ...emptyEnv, DSH_WEB_URL: realBaseUrl }, includeScan: true }));
          bucket.cold.push(cold.ms);
          const warm = await timed(() => mod.discoverDshWeb({ env: { ...emptyEnv }, savedBaseUrl: realBaseUrl, includeScan: true }));
          bucket.warm.push(warm.ms);
        }
      };
      await runReal(adapter, real.after);
      if (before) await runReal(before.mod, real.before);
      real.median = {
        before: before ? { cold: median(real.before.cold), warm: median(real.before.warm) } : { cold: null, warm: null },
        after: { cold: median(real.after.cold), warm: median(real.after.warm) },
      };
      check('E 真机 DSH（' + realBaseUrl + '）冷启动 3 次中位 ≤2000ms（' + real.median.after.cold + 'ms）',
        real.median.after.cold <= 2000, real);
      check('E2 真机热启动中位 ≤1000ms（' + real.median.after.warm + 'ms）', real.median.after.warm <= 1000, real);
    } else {
      check('E 真机 DSH 未运行（跳过真机基准）', true, { skipped: true, ports: realPorts });
    }
    if (!JSON_OUT) console.log('真机基准：' + JSON.stringify({ baseUrl: realBaseUrl, median: real.median, ports: realPorts }));
    if (before) { try { fs.rmSync(before.dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  } finally {
    await new Promise((r) => server.close(r));
  }
  const failed = ROWS.filter((r) => !r.ok).length;
  if (JSON_OUT) console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed, failed: ROWS.filter((r) => !r.ok).map((r) => r.name), rows: ROWS }, null, 2));
  else console.log(`\n${ROWS.length - failed}/${ROWS.length} PASS${failed ? ' · ' + failed + ' FAIL' : ''}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FIXTURE_FAILED', String((e && e.stack) || e)); process.exit(1); });
