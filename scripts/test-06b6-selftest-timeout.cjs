#!/usr/bin/env node
'use strict';
/**
 * B-20261118-012138-06b6 夹具：team.mjs selftest 单步超时（不再无限等）。
 *
 * 判据（PM 2026-11-18 03:49 口径）：
 *   ① 用例级超时 120s，超时标 `STEP_TIMEOUT` 并打印当前用例名 + 最后输出；
 *   ② 子进程 spawn 加 timeout + 强杀（SIGKILL），防孤儿/僵尸导致父进程永等；
 *   ③ 超时保留沙盘现场并落一行「hang 现场」；
 *   ④ 暴露 `--step-timeout <ms>`；
 *   ⑤ 注入永不返回的用例 → 到点退出且码非 0（124）；超时后无残留 node 进程。
 *
 * 说明：**不跑 full selftest**（PM 口径）。「正常 176/176」由 PM/A 复跑；本夹具验证注入路径与看门狗本体。
 *
 * 跑法：node scripts/test-06b6-selftest-timeout.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const TEAM_MJS = path.join(ROOT, '团队', '工具', 'team.mjs');
const SELFTEST_MJS = path.join(ROOT, '团队', '工具', 'lib', 'selftest.mjs');
const WORKER_MJS = path.join(ROOT, '团队', '工具', 'lib', 'selftest-watchdog.mjs');
const SB = path.join(ROOT, '_tmp', `06b6-${process.pid}-${Date.now().toString(36)}`);
const TMP = path.join(SB, 'tmp');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 800)}`);
  if (!ok) process.exitCode = 1;
}
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
function nodeProcessesWith(fragment) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${fragment}*' } | Select-Object -ExpandProperty ProcessId`],
    { encoding: 'utf8', timeout: 30000 });
    return String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}
/** 起一个 selftest 子进程，带 hang 注入；返回 {code, stdout, stderr, ms}。 */
function runSelftestWithHang({ hangAt, stepTimeout, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [TEAM_MJS, 'selftest', '--tmp', TMP, '--step-timeout', String(stepTimeout)], {
      cwd: ROOT,
      env: { ...process.env, TEAM_SELFTEST_HANG_AT: String(hangAt), TEAM_SELFTEST: '1' },
      windowsHide: true,
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(killTimer); resolve({ code, signal, stdout, stderr, ms: Date.now() - started }); });
  });
}

(async () => {
  fs.mkdirSync(SB, { recursive: true });

  // ① 静态锚点：超时/看门狗/CLI 参数都在
  const stSrc = readText(SELFTEST_MJS);
  const teamSrc = readText(TEAM_MJS);
  check('① 静态：selftest 有 STEP_TIMEOUT/看门狗/hang 现场，CLI 暴露 --step-timeout',
    /const STEP_TIMEOUT =/.test(stSrc) && /STEP_TIMEOUT/.test(stSrc) && /hang现场\.json/.test(stSrc)
      && /selftest-watchdog\.mjs/.test(stSrc) && /killSignal: 'SIGKILL'/.test(stSrc)
      && /args\['step-timeout'\]/.test(teamSrc) && /stepTimeout/.test(teamSrc) && fs.existsSync(WORKER_MJS),
    { hasStepTimeout: /const STEP_TIMEOUT =/.test(stSrc), hasWorkerRef: /selftest-watchdog\.mjs/.test(stSrc), cliArg: /args\['step-timeout'\]/.test(teamSrc), workerExists: fs.existsSync(WORKER_MJS) });

  // ② 注入挂死 → 到点退出、码非 0、输出 STEP_TIMEOUT + 用例名 + hang 现场
  const hangAt = 3;
  const stepTimeout = 1500;
  const run = await runSelftestWithHang({ hangAt, stepTimeout, timeoutMs: 60000 });
  const out = run.stdout + run.stderr;
  const m = /hang 现场[:：]\s*(.+)/.exec(out);
  const hangFile = m ? String(m[1]).replace(/\s*（沙盘.*$/, '').trim() : '';
  const hang = hangFile && fs.existsSync(hangFile) ? JSON.parse(fs.readFileSync(hangFile, 'utf8')) : null;
  check('② 注入永不返回 → 到点退出且码非 0（watchdog 强杀；不是无限等）',
    run.code !== 0 && run.code !== null && run.ms < 60000 && out.includes('STEP_TIMEOUT'),
    { code: run.code, signal: run.signal, ms: run.ms, tail: out.slice(-600) });
  check('②b 输出含当前用例名（注入挂死用例）与最后输出提示',
    out.includes('注入挂死用例') && /最后输出/.test(out),
    { tail: out.slice(-500) });
  check('②c hang 现场已落盘：kind=STEP_TIMEOUT + case + cmd + 沙盘路径存在',
    Boolean(hang) && hang.kind === 'STEP_TIMEOUT' && String(hang.case || '').includes('注入挂死')
      && Boolean(String(hang.cmd || '').trim())
      && Boolean(hang.sandbox) && fs.existsSync(String(hang.sandbox)),
    { hangFile, hang });
  check('②d 沙盘现场被保留（未走 finally 清理）',
    Boolean(hang) && fs.existsSync(path.join(String(hang.sandbox), '团队', '状态', '团队.json')),
    { sandbox: hang && hang.sandbox });

  // ③ 无残留 node 进程（挂着该沙盘路径的）
  const leftovers = nodeProcessesWith(path.basename(SB)).concat(nodeProcessesWith('team-selftest-'));
  check('③ 超时退出后无残留 node 进程（防孤儿/僵尸）', leftovers.length === 0, { leftovers });

  // ④ 参数兜底：--step-timeout 非数字 → 不应崩（静态：team.mjs 有 Number.isFinite 兜底）
  check('④ `--step-timeout` 非法值有兜底（Number.isFinite → 默认 120000）',
    /Number\.isFinite\(rawStep\)/.test(teamSrc) && /rawStep > 0 \? rawStep : 120000/.test(teamSrc),
    { hasFallback: /Number\.isFinite\(rawStep\)/.test(teamSrc) });

  // ⑤ 清理本夹具自己的沙盘（hang 现场那份保留在报告里，另建目录避免误删）
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }

  const total = results.length;
  const pass = results.filter((x) => x.ok).length;
  const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-06b6');
  fs.mkdirSync(evDir, { recursive: true });
  const evFile = path.join(evDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${total - pass === 0 ? 'green' : 'red'}.json`);
  fs.writeFileSync(evFile, JSON.stringify({ task: 'B-20261118-012138-06b6', at: new Date().toISOString(), total, pass, red: total - pass, results, hang: hang ? { case: hang.case, timeoutMs: hang.timeoutMs, sandbox: hang.sandbox, cmd: hang.cmd } : null }, null, 2) + '\n', 'utf8');
  console.log(`\nB06B6_${total - pass === 0 ? 'OK' : 'RED'} ${JSON.stringify({ total, pass, red: total - pass })}`);
  console.log(`证据：${evFile}`);
})();
