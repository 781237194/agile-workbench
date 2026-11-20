#!/usr/bin/env node
'use strict';
/**
 * start-guard.cjs —— 启动前「默认实例」快检（B-4fdd，替代 PowerShell 版本）
 *
 * 为什么：PowerShell 自启 1.4-1.9s，tasklist/Get-CimInstance 再 1.5-4.3s，冷启动预算只有 2s。
 * 现口径：main.js 在本机端口上留一个「实例探针」，本脚本只做 connect + 等 AWB 握手（~10ms）；
 * 探针端口写在 <data>/userdata/instance.port（沙箱实例写自己的数据目录，不会误判）。
 *
 * 用法：node scripts/start-guard.cjs --app-dir <安装目录> [--kill]
 * 退出码：0 = 没有默认实例（可启动）；3 = 已有默认实例。
 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const argv = process.argv.slice(2);
const argOf = (name, fallback = '') => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const appDir = path.resolve(argOf('--app-dir', path.resolve(__dirname, '..')));
const kill = argv.includes('--kill');
const portFile = path.join(appDir, 'data', 'userdata', 'instance.port');
const pidFile = path.join(appDir, 'data', 'userdata', 'main.pid');

function readInt(file) {
  try { const n = Number(String(fs.readFileSync(file, 'utf8')).trim()); return Number.isInteger(n) && n > 0 ? n : 0; } catch { return 0; }
}
function probe(port) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch { /* ignore */ } resolve(ok); };
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.setTimeout(500, () => finish(false));
    sock.once('error', () => finish(false));
    sock.once('data', (buf) => finish(String(buf || '').includes('AWB')));
    sock.once('end', () => finish(false));
  });
}

(async () => {
  const port = readInt(portFile);
  const running = port > 0 ? await probe(port) : false;
  if (!running) {
    if (fs.existsSync(portFile)) { try { fs.rmSync(portFile, { force: true }); } catch { /* ignore */ } }
    console.log('[信息] 默认实例：无');
    process.exit(0);
  }
  const pid = readInt(pidFile);
  console.log('[信息] 默认实例：运行中（端口探针 ' + port + (pid ? '，PID ' + pid : '') + '）');
  if (kill) {
    console.log('[清理] 结束默认实例' + (pid ? ' PID ' + pid : '（无 PID 记录，请用任务管理器）'));
    if (pid) { try { process.kill(pid); } catch { /* ignore */ } }
    try { fs.rmSync(portFile, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(pidFile, { force: true }); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 1200);
    return;
  }
  console.log('[实例] 默认实例 ' + (pid ? 'PID ' + pid : '运行中'));
  process.exit(3);
})();
