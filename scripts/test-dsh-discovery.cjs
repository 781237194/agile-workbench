#!/usr/bin/env node
'use strict';
/**
 * test-dsh-discovery.cjs —— B-20261119-123414-0084（DSH 自动发现双失效 P0）夹具。
 * 纯 Node（不启动 Electron）；用 AWB_DSH_COMMAND_STUB 注入假 powershell/wmic/netstat，
 * 用本地 mock /json/version 服务器验证探测链。真实 DSH 场景只读验证并落证明结果。
 *
 * 场景：
 *  A) wmic 缺失 + 旧 PowerShell 路径不存在，新 System32 路径存在 → 仍 resolved（process-arg）；
 *  B) 进程发现整条失败，但 netstat 有监听 → 用 netstat 端口反查 resolved（netstat-port）；
 *  C) 全部命令 ENOENT → failed 且错误文案含候选路径与「存在=false」（可诊断）；
 *  D) 扫描区间默认 49152–65535（P1-4），candidateSourceLabel 含 netstat 端口；
 *  E) 真实本机 DSH：discover（不带 saved）解析到 process-port，capability.ok=true，且不写 dsh.json/hosts。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-dsh-discovery'); })();
const SB = path.join(os.tmpdir(), `dsh-disc-${process.pid}-${Date.now()}`);
const REAL_SYSTEM_ROOT = process.env.SystemRoot || process.env.windir || (String.fromCharCode(67) + ':\\Windows');
const rows = [];
function check(name, ok, detail) { rows.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 500))); }
function sha(file) { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return '-'; } }
function statSig(file) { try { const s = fs.statSync(file); return s.size + ':' + s.mtimeMs + ':' + sha(file); } catch { return 'MISSING'; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function startMockDsh() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/json/version') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ Browser: 'DeepSeek Harness/2.0.0', 'Protocol-Version': '1.2' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>DeepSeek Harness</title></head><body><meta name="dsh-app"></body></html>');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
function stubEnv(stub) { return JSON.stringify(stub); }
function cleanEnv() { delete process.env.AWB_DSH_COMMAND_STUB; delete process.env.AWB_POWERSHELL_PATH; delete process.env.AWB_WMIC_PATH; delete process.env.AWB_NETSTAT_PATH; delete process.env.DSH_WEB_URL; delete process.env.DSH_WEB_PORT; delete process.env.DSH_PORT; }

(async () => {
  fs.mkdirSync(SB, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  const adapter = require(path.join(ROOT, 'src', 'dsh-adapter.js'));

  // D) 常量与标签（P1-4）
  check('D1 扫描默认区间=ephemeral 49152–65535', adapter.DSH_SCAN_DEFAULT_START === 49152 && adapter.DSH_SCAN_DEFAULT_END === 65535, { start: adapter.DSH_SCAN_DEFAULT_START, end: adapter.DSH_SCAN_DEFAULT_END });
  const scanRange = await adapter.scanLocalPortRange({ start: 1, end: 1, budgetMs: 50, timeoutMs: 20 });
  check('D2 有界扫描 API 可用（区间参数生效）', scanRange && scanRange.ok === true && Array.isArray(scanRange.ports), scanRange);

  // A) 新 PowerShell 路径生效 + wmic 缺失不致命
  cleanEnv();
  const winRoot = path.join(SB, 'win');
  const psNew = path.join(winRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  fs.mkdirSync(path.dirname(psNew), { recursive: true });
  fs.writeFileSync(psNew, 'stub', 'utf8'); // 只用于 exists 诊断，实际命令由 stub 返回
  const mock = await startMockDsh();
  const stubA = {
    'wmic.exe': { ok: false, error: 'ENOENT: wmic 不存在（Win11 24H2 已移除）' },
    'powershell.exe': {
      ok: true,
      stdout: JSON.stringify([{ ProcessId: 4242, ParentProcessId: 1, Name: 'dsh-desktop-host.exe', CommandLine: 'dsh-desktop-host.exe --port ' + mock.port, CreationDate: '2026-11-19T00:00:00Z' }]),
    },
    'netstat.exe': { ok: true, stdout: '' },
  };
  process.env.SystemRoot = winRoot;
  process.env.AWB_DSH_COMMAND_STUB = stubEnv(stubA);
  adapter.resetCommandAttempts();
  const rA = await adapter.discoverDshWeb({ savedBaseUrl: '', includeRange: false, includeScan: false, timeoutMs: 700, processTimeoutMs: 4000 });
  check('A1 wmic 缺失 + 旧 PowerShell 路径不存在 → 仍 resolved', Boolean(rA) && rA.ok === true && rA.state === 'resolved', { ok: rA && rA.ok, code: rA && rA.code, process: rA && rA.process });
  check('A2 来源为 DSH 进程参数端口（新 PowerShell 生效）', Boolean(rA) && rA.source === 'process-arg' && String(rA.baseUrl).includes(':' + mock.port), { source: rA && rA.source, baseUrl: rA && rA.baseUrl });
  const attemptsA = adapter.getCommandAttempts();
  const psAttempt = attemptsA.find((row) => /System32.+WindowsPowerShell.+v1\.0.+powershell\.exe/i.test(row.file));
  check('A3 命令尝试记录含新 System32 PowerShell 路径且存在', Boolean(psAttempt) && psAttempt.exists === true, attemptsA.map((r) => ({ file: r.file, exists: r.exists })).slice(-6));
  const wmicAttempt = attemptsA.find((row) => /wmic\.exe/i.test(row.file));
  check('A4 wmic 缺失被记录且致命性被兜底（不阻断 resolved）', Boolean(wmicAttempt) && rA.ok === true, wmicAttempt);

  // B) 进程发现全失败 → netstat 监听端口反查
  cleanEnv();
  mock.server.close();
  const mockB = await startMockDsh();
  cleanEnv();
  process.env.SystemRoot = path.join(SB, 'empty-win');
  process.env.AWB_DSH_COMMAND_STUB = stubEnv({
    'wmic.exe': { ok: false, error: 'ENOENT: wmic' },
    'powershell.exe': { ok: false, error: 'ENOENT: powershell（候选路径均不存在）' },
    'netstat.exe': { ok: true, stdout: '  TCP    127.0.0.1:' + mockB.port + '    0.0.0.0:0    LISTENING    7777\n' },
  });
  adapter.resetCommandAttempts();
  const rB = await adapter.discoverDshWeb({ savedBaseUrl: '', includeRange: false, includeScan: false, timeoutMs: 700, processTimeoutMs: 4000 });
  check('B1 进程发现失败时用 netstat 监听反查 → resolved（netstat-port）', Boolean(rB) && rB.ok === true && rB.source === 'netstat-port' && String(rB.baseUrl).includes(':' + mockB.port), { ok: rB && rB.ok, source: rB && rB.source, baseUrl: rB && rB.baseUrl, process: rB && rB.process });
  check('B2 netstat 监听列表进入诊断（listenerPorts）', Boolean(rB) && Array.isArray(rB.process && rB.process.listenerPorts) && rB.process.listenerPorts.includes(mockB.port), rB && rB.process ? rB.process.listenerPorts : null);
  mockB.server.close();

  // C) 全 ENOENT → failed 可读诊断（路径+存在性）
  cleanEnv();
  process.env.SystemRoot = path.join(SB, 'empty-win2');
  process.env.AWB_DSH_COMMAND_STUB = stubEnv({
    'wmic.exe': { ok: false, error: 'ENOENT: wmic' },
    'powershell.exe': { ok: false, error: 'ENOENT: powershell' },
    'netstat.exe': { ok: true, stdout: '' },
  });
  adapter.resetCommandAttempts();
  const rC = await adapter.discoverDshWeb({ savedBaseUrl: '', includeRange: false, includeScan: false, timeoutMs: 400, processTimeoutMs: 3000 });
  const msgC = String((rC && rC.message) || '');
  check('C1 全命令失败 → failed（DSH_NOT_FOUND）', Boolean(rC) && rC.ok === false && rC.code === 'DSH_NOT_FOUND', { code: rC && rC.code });
  check('C2 失败文案含候选路径与存在性（诊断可读）', /诊断：/.test(msgC) && /powershell\.exe/.test(msgC) && /存在=false/.test(msgC), msgC.slice(0, 400));
  check('C3 失败文案含 wmic/netstat 可用性信息', /wmic/i.test(msgC) && /netstat/i.test(msgC), msgC.slice(0, 400));

  // E) 真实本机 DSH（只读）：不带 saved 也应解析到 process-port；capability.ok=true；零写入
  cleanEnv();
  process.env.SystemRoot = REAL_SYSTEM_ROOT;
  const dshFile = path.join(ROOT, 'data', 'dsh.json');
  const hostsFile = path.join(REAL_SYSTEM_ROOT, 'System32', 'drivers', 'etc', 'hosts');
  const beforeDsh = statSig(dshFile);
  const beforeHosts = statSig(hostsFile);
  adapter.resetCommandAttempts();
  const real = await adapter.discoverDshWeb({ savedBaseUrl: '', includeRange: false, includeScan: false, timeoutMs: 1200, processTimeoutMs: 8000 });
  let cap = null;
  if (real && real.ok && real.baseUrl) {
    try {
      const { probeDshCapability } = require(path.join(ROOT, 'src', 'dsh-capability.js'));
      const inst = new adapter.DshAdapter(real.baseUrl);
      cap = await probeDshCapability({ adapter: inst, dataDir: '', timeoutMs: 8000 });
    } catch (e) { cap = { ok: false, error: String((e && e.message) || e) }; }
  }
  check('E1 真实本机 DSH 解析成功', Boolean(real) && real.ok === true, { ok: real && real.ok, code: real && real.code, source: real && real.source, baseUrl: real && real.baseUrl, message: String((real && real.message) || '').slice(0, 300) });
  check('E2 真实解析来源为 process-port（净 netstat/进程反查）', Boolean(real) && real.ok === true && real.source === 'process-port', { source: real && real.source, process: real && real.process });
  check('E3 capability.ok=true 且 sessions 可读', Boolean(cap) && cap.ok === true, cap);
  const afterDsh = statSig(dshFile);
  const afterHosts = statSig(hostsFile);
  check('E4 真实 dsh.json / hosts 零写入（sha+mtime 不变）', beforeDsh === afterDsh && beforeHosts === afterHosts, { beforeDsh, afterDsh, beforeHosts, afterHosts });
  const realSummary = { discover: { ok: real && real.ok, state: real && real.state, source: real && real.source, baseUrl: real && real.baseUrl, process: real && real.process, durationMs: real && real.durationMs }, capability: cap && { ok: cap.ok, sessionsCount: cap.sessionsCount, dshVersion: cap.dshVersion, error: cap.error } };
  fs.writeFileSync(path.join(OUT, 'dsh-discovery-run.json'), JSON.stringify({ at: new Date().toISOString(), checks: rows, real: realSummary }, null, 2) + '\n', 'utf8');
  cleanEnv();
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = rows.filter((r) => !r.ok);
  console.log('');
  console.log('DSH-DISCOVERY ' + (failed.length ? 'FAIL' : 'OK') + ' ' + JSON.stringify({ total: rows.length, pass: rows.length - failed.length, red: failed.length }));
  console.log('证据：' + path.join(OUT, 'dsh-discovery-run.json'));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('DSH-DISCOVERY ERROR ' + String((e && e.stack) || e)); process.exit(1); });
