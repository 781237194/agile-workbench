'use strict';
// B-47c0 沙盘根唤醒拦截未修好前**暂停跑**（PM 2026-11-17 15:51 处置；本脚本故意走真实唤醒路径验证拦截，
// 拦截失效时会按名册直唤醒真实会话）。修复后：TEAM_3C03_UNPAUSE=1 node scripts/test-3c03-sandboxwake.cjs
if (process.env.TEAM_3C03_UNPAUSE !== '1') {
  console.log('SKIP  test-3c03-sandboxwake：B-47c0（沙盘根唤醒拦截失效）修复前暂停跑；修复后带 TEAM_3C03_UNPAUSE=1 再跑');
  process.exit(0);
}
const { rmSandbox, uniqueSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/** B-3c03 回归：沙盘根（TEAM_ROOT 非安装默认）不唤醒真实会话，但业务返回/文案口径不变。 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = uniqueSandbox('b-3c03');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '唤醒隔离沙盘';
// 不设 TEAM_SELFTEST：走真实唤醒路径，用来验证沙盘根拦截确实生效（不会真连 DSH）。
const baseEnv = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS };
delete baseEnv.TEAM_SELFTEST;
// 污染取证（PM 2026-11-17 15:51 要求）：真实 团队.json 与 唤醒.jsonl 必须前后 sha256+mtime+bytes 不变。
const REAL_TEAM_JSON = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_WAKE_JSONL = path.join(ROOT, '团队', '状态', '项目', '工作台改造修复', '唤醒.jsonl');
const crypto = require('node:crypto');
const statOf = (file) => {
  try { const st = fs.statSync(file); return { sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), mtimeMs: st.mtimeMs, bytes: st.size }; } catch { return null; }
};
const realBefore = { team: statOf(REAL_TEAM_JSON), wake: statOf(REAL_WAKE_JSONL) };
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
// 污染防护（2026-11-17 两次真实 PM 被唤醒后加）：沙盘名册绝不能保留真实 sessionId——
// 一旦「沙盘根拦截」失效（本脚本故意走真实唤醒路径验证它），就会按真实名册把唤醒打进真人会话。
{
  const tf = path.join(TEAM_ROOT, '状态', '团队.json');
  const team = JSON.parse(fs.readFileSync(tf, 'utf8'));
  for (const m of team.members || []) m.sessionId = `sess-sandbox-${String(m.role || 'x')}`;
  delete team.activeProject;
  fs.writeFileSync(tf, JSON.stringify(team, null, 2) + '\n', 'utf8');
}
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

// ④ 污染取证：真实 团队.json 前后不变（sha256+mtime+bytes）
const realTeamAfter = statOf(REAL_TEAM_JSON);
check('④ 真实 团队.json 前后 sha256+mtime+bytes 不变（沙盘名册假 id，未碰真实名册）',
  Boolean(realBefore.team && realTeamAfter && realBefore.team.sha256 === realTeamAfter.sha256 && realBefore.team.mtimeMs === realTeamAfter.mtimeMs && realBefore.team.bytes === realTeamAfter.bytes),
  { before: realBefore.team && { sha: realBefore.team.sha256.slice(0, 12), mtime: realBefore.team.mtimeMs }, after: realTeamAfter && { sha: realTeamAfter.sha256.slice(0, 12), mtime: realTeamAfter.mtimeMs } });
// ⑤ 污染取证：真实 唤醒.jsonl 前后不变（两次真实唤醒污染就是写这个文件/直连真实会话）
const realWakeAfter = statOf(REAL_WAKE_JSONL);
check('⑤ 真实 唤醒.jsonl 前后 sha256+mtime+bytes 不变（没有真实唤醒落账）',
  Boolean(realBefore.wake && realWakeAfter && realBefore.wake.sha256 === realWakeAfter.sha256 && realBefore.wake.mtimeMs === realWakeAfter.mtimeMs && realBefore.wake.bytes === realWakeAfter.bytes),
  { before: realBefore.wake && { sha: realBefore.wake.sha256.slice(0, 12), bytes: realBefore.wake.bytes }, after: realWakeAfter && { sha: realWakeAfter.sha256.slice(0, 12), bytes: realWakeAfter.bytes }, 备注: '真实实例可能同时在写 → 若 mtime 前进需与静置观察区分（本脚本已暂停跑，待 47c0 修后按外部并发写者口径复核）' });

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\nB-3c03 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
fs.writeFileSync(path.join(SB, 'run-b-3c03.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
