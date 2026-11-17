'use strict';
const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/** B-3c03 回归：沙盘根（TEAM_ROOT 非安装默认）不唤醒真实会话，但业务返回/文案口径不变。 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'b-3c03');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '唤醒隔离沙盘';
// 不设 TEAM_SELFTEST：走真实唤醒路径，用来验证沙盘根拦截确实生效（不会真连 DSH）。
const baseEnv = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS };
delete baseEnv.TEAM_SELFTEST;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 260)}`);
  if (!ok) process.exitCode = 1;
}
function run(args, env = baseEnv) {
  const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
  const t = String(out).trim();
  return JSON.parse(t.slice(t.indexOf('{')));
}

rmSandbox(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
run(['project', 'add', '--name', PROJECT, '--team-mode', 'fast', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm', '--json']);
const dev = run(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-p1', '--json']);

// ① 沙盘默认：不真唤醒，返回 skipped + delivered=false，但正文/业务返回照旧
const sent = run(['send', '--boot', dev.token, '--to', 'pm', '--subject', '沙盘唤醒隔离-标题', '--body', '沙盘正文-END', '--json']);
check('① 沙盘 send 业务成功', sent.ok === true, { ok: sent.ok, code: sent.code });
const wake = sent.wake || {};
check('① wake.skipped=sandbox_wake_skipped 且 delivered=false', wake.skipped === 'sandbox_wake_skipped' && wake.delivered === false, wake);
check('① 唤醒文案仍带 subject/body（上层可展示）', String(wake.text || '').includes('沙盘唤醒隔离-标题') && String(wake.text || '').includes('沙盘正文-END'), String(wake.text || '').slice(0, 120));

// ② 显式 TEAM_ALLOW_SANDBOX_WAKE=1 时不再走跳过分支
const forced = run(['send', '--boot', dev.token, '--to', 'pm', '--subject', '显式允许-标题', '--body', 'x', '--json'], { ...baseEnv, TEAM_ALLOW_SANDBOX_WAKE: '1' });
const forcedWake = forced.wake || {};
check('② TEAM_ALLOW_SANDBOX_WAKE=1 → 不再标记 sandbox 跳过', forcedWake.skipped !== 'sandbox_wake_skipped', { skipped: forcedWake.skipped, ok: forcedWake.ok, code: forcedWake.code });

// ③ 测试注入优先级：TEAM_WAKE_TEST_FAIL=1 仍返回失败（不被沙盘跳过吞掉）
const injected = run(['send', '--boot', dev.token, '--to', 'pm', '--subject', '注入失败', '--body', 'x', '--json'], { ...baseEnv, TEAM_WAKE_TEST_FAIL: '1' });
const injWake = injected.wake || {};
check('③ TEAM_WAKE_TEST_FAIL 优先，仍返回 WAKE_TEST_FAIL', String(injWake.code || '') === 'WAKE_TEST_FAIL' || String(injWake.why || '').includes('TEAM_WAKE_TEST_FAIL'), injWake);

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\nB-3c03 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
fs.writeFileSync(path.join(SB, 'run-b-3c03.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
