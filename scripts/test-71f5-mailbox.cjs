'use strict';
const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/** B-71f5 回归：read 与 ack/自动已读并发时不再出现 INTERNAL ENOENT（消息搬移竞态）。 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'b71f5-mailbox');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '邮箱竞态沙盘';
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
    child.on('exit', (code) => {
      let parsed = null;
      const i = String(out).indexOf('{');
      if (i >= 0) { try { parsed = JSON.parse(String(out).slice(i)); } catch { parsed = null; } }
      resolve({ code, parsed, raw: String(out).slice(0, 200) });
    });
  });
}

rmSandbox(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true });
run(['project', 'add', '--name', PROJECT, '--team-mode', 'fast', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm', '--json']);
const dev = run(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-p1', '--json']);

(async () => {
  const N = 8;
  const ids = [];
  for (let i = 0; i < N; i += 1) {
    const sent = run(['send', '--boot', dev.token, '--to', 'pm', '--subject', `并发用例${i}`, '--body', 'x', '--json']);
    ids.push(sent.message.id);
  }
  const outcomes = [];
  for (const id of ids) {
    const [readRes, ackRes] = await Promise.all([
      runAsync(['read', '--boot', pm.token, '--id', id, '--json']),
      runAsync(['ack', '--boot', pm.token, '--id', id, '--json']),
    ]);
    outcomes.push({ id, read: readRes.parsed, ack: ackRes.parsed, raw: `${readRes.raw} | ${ackRes.raw}` });
  }
  const bad = outcomes.filter((o) => {
    const code = String((o.read && o.read.code) || '');
    const msg = String((o.read && o.read.message) || '');
    return code === 'INTERNAL' || /ENOENT/.test(msg) || code === 'MESSAGE_NOT_FOUND';
  });
  check('① 并发 read+ack 无 INTERNAL/ENOENT（8 组）', bad.length === 0, bad.slice(0, 2));
  check('② 至少 7 组 read 成功（允许 ack 先赢的 1 组）', outcomes.filter((o) => o.read && o.read.ok === true).length >= 7, outcomes.filter((o) => o.read && o.read.ok === true).length);

  // ③ 目录被并发清空时 findMessage 不炸（readdir ENOENT 容错）
  const curDir = path.join(TEAM_ROOT, '状态', '邮箱', 'pm', 'cur');
  const newDir = path.join(TEAM_ROOT, '状态', '邮箱', 'pm', 'new');
  fs.rmSync(curDir, { recursive: true, force: true });
  fs.rmSync(newDir, { recursive: true, force: true });
  const gone = await runAsync(['read', '--boot', pm.token, '--id', 'M-不存在', '--json']);
  check('③ 目录不存在时返回明确 MESSAGE_NOT_FOUND（非 INTERNAL）', gone.parsed && gone.parsed.code === 'MESSAGE_NOT_FOUND', gone.parsed && gone.parsed.code);

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nB-71f5 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
  fs.writeFileSync(path.join(SB, 'run-b71f5.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
})();
