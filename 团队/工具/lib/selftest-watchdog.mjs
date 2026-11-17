// B-20261118-012138-06b6：selftest 单步超时看门狗（worker_threads）。
//
// 主线程（selftest.mjs）每跑一步把 {at, case, cmd, stdoutTail} 写进 stateFile；
// 本线程每 250–1000ms 轮询一次：超过 timeoutMs 没更新（= 某一步挂死，主线程被阻塞），就
//   ① 打印 STEP_TIMEOUT（当前用例名 + 最后命令 + 输出尾巴）；
//   ② 写「hang 现场」文件（含沙盘路径、当前用例、最后输出）；
//   ③ process.exit(124)（非 0 退出；因为跳过了 finally，沙盘现场会被保留）。
// 本文件只被 selftest 内部使用，不参与正常命令路径。
import fs from 'node:fs';
import path from 'node:path';
import { workerData } from 'node:worker_threads';

const { stateFile = '', hangFile = '', timeoutMs = 120000, sandbox = '' } = workerData || {};
const timeout = Math.max(1000, Number(timeoutMs) || 120000);

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; }
}

function writeHang(payload) {
  try {
    fs.mkdirSync(path.dirname(hangFile), { recursive: true });
    fs.writeFileSync(hangFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch { /* 现场文件写不出也不阻断退出 */ }
}

let lastReportedAt = 0;
setInterval(() => {
  const st = readState();
  const at = Number((st && st.at) || 0);
  if (!at) return;
  if (Date.now() - at <= timeout) return;
  if (lastReportedAt === at) return;
  lastReportedAt = at;
  const payload = {
    at: new Date().toISOString(),
    kind: 'STEP_TIMEOUT',
    case: String((st && st.case) || ''),
    cmd: String((st && st.cmd) || ''),
    stdoutTail: String((st && st.stdoutTail) || '').slice(-2000),
    timeoutMs: timeout,
    sandbox: String(sandbox || ''),
    hint: '单步超时：某个用例/子命令挂死；现场沙盘已保留，可按 cmd 手工复现后清理',
  };
  writeHang(payload);
  // worker 的 console.log 在「主线程被阻塞 + 随后强杀进程」时可能来不及 flush，
  // 用 fs.writeSync(1) 直接同步写主进程 stdout，确保 STEP_TIMEOUT 一定能看到。
  const lines = [
    ``,
    `STEP_TIMEOUT  单步超过 ${timeout}ms 未返回：用例「${payload.case || '?'}」｜最后命令：${payload.cmd || '-'}`,
    ...(payload.stdoutTail ? [`最后输出：${payload.stdoutTail}`] : []),
    `hang 现场：${hangFile}${sandbox ? `（沙盘 ${sandbox}）` : ''}`,
    ``,
  ].join('\n');
  try { fs.writeSync(1, lines + '\n'); } catch { /* ignore */ }
  // 主线程正卡死，无法用 process.exit(124)；在 worker 里 kill 主进程（非 0 退出），现场文件已落盘。
  try { process.kill(process.pid, 'SIGKILL'); } catch { /* 已尽力 */ }
}, Math.max(250, Math.min(1000, Math.floor(timeout / 4))));
