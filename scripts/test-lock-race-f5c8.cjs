'use strict';
const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/** B-f5c8 回归：read/events 锁目录被并发清理时不再 ENOENT 中断（acquireLock/readJson/appendLine 容错）。 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'b-f5c8');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '锁竞态沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 240)}`);
  if (!ok) process.exitCode = 1;
}
function run(args) {
  const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
  const t = String(out).trim();
  return JSON.parse(t.slice(t.indexOf('{')));
}
function runAsync(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TOOL, ...args], { cwd: SB, env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', () => {
      let parsed = null;
      const i = String(out).indexOf('{');
      if (i >= 0) { try { parsed = JSON.parse(String(out).slice(i)); } catch { parsed = null; } }
      resolve({ parsed, raw: String(out).slice(0, 160) });
    });
  });
}

rmSandbox(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
// 真实 状态/锁 里可能有在途锁，复制时会与并发进程抢文件（ENOENT cp）；沙盘不需要它，直接跳过。
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => !/[\\\\/]锁([\\\\/]|$)/.test(src) });
run(['project', 'add', '--name', PROJECT, '--team-mode', 'fast', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm', '--json']);
const dev = run(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-p1', '--json']);

(async () => {
  // ① 锁目录被删除后，写事件/发送消息仍成功（acquireLock 重建 + appendLine 重建）
  const locksDir = path.join(TEAM_ROOT, '状态', '锁');
  fs.rmSync(locksDir, { recursive: true, force: true });
  const sent = run(['send', '--boot', dev.token, '--to', 'pm', '--subject', '锁目录被删后发送', '--body', 'x', '--no-wake', '--json']);
  check('① 锁目录被删 → send 仍成功（无 ENOENT）', sent.ok === true, sent);
  check('① 锁目录已自动重建', fs.existsSync(locksDir), locksDir);

  // ② 并发：一边反复删锁目录，一边 6 路并发 send；不得出现 INTERNAL/ENOENT
  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push(`并发${i}`);
  const deleter = setInterval(() => { try { fs.rmSync(locksDir, { recursive: true, force: true }); } catch { /* ignore */ } }, 50);
  const outs = await Promise.all(ids.map((s) => runAsync(['send', '--boot', dev.token, '--to', 'pm', '--subject', s, '--body', 'x', '--no-wake', '--json'])));
  clearInterval(deleter);
  const bad = outs.filter((o) => {
    const code = String((o.parsed && o.parsed.code) || '');
    const msg = String((o.parsed && o.parsed.message) || '') + o.raw;
    return code === 'INTERNAL' || /ENOENT/.test(msg);
  });
  check('② 删锁目录并发 6 路 send 无 INTERNAL/ENOENT', bad.length === 0, bad.slice(0, 2).map((b) => b.raw));
  check('② 6 路 send 均返回 ok', outs.every((o) => o.parsed && o.parsed.ok === true), outs.filter((o) => !(o.parsed && o.parsed.ok === true)).length);

  // ③ 事件文件与 3 个派生目录都还能读（readJson/readJsonl ENOENT 容错不破坏正常路径）
  const events = path.join(TEAM_ROOT, '状态', '事件.jsonl');
  check('③ 事件文件存在且非空', fs.existsSync(events) && fs.statSync(events).size > 0, fs.existsSync(events));

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nB-f5c8 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
  fs.writeFileSync(path.join(SB, 'run-b-f5c8.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
})();
