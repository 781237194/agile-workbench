'use strict';
const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * B-20261114-152128-44f5 回归：read 对已自动已读/已在 cur 的消息也要落 kind=read 阅读行。
 * 跑法：node scripts/test-read-receipt.cjs
 * 隔离：复制 团队/ 到 _tmp/read-receipt-test，TEAM_ROOT/TEAM_PROJECTS_ROOT 指向沙盘，TEAM_SELFTEST=1。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'read-receipt-test');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TEAM_TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '阅读行沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 300)}`);
  if (!ok) process.exitCode = 1;
}
function run(args) {
  const out = execFileSync(process.execPath, [TEAM_TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
  const text = String(out).trim();
  return JSON.parse(text.slice(text.indexOf('{')));
}
const rows = () => {
  const file = path.join(TEAM_ROOT, '状态', '阅读.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};
const readRows = (messageId) => rows().filter((row) => row.kind === 'read' && String(row.messageId) === String(messageId));

// ---------- 沙盘 ----------
rmSandbox(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true });
run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'sbx-pm', '--json']);
const dev = run(['boot', '--role', 'programmer2', '--project', PROJECT, '--session', 'sbx-dev', '--json']);
console.log(`沙盘就绪：${SB}`);

// ① 未读消息（--no-wake 投递，停在 new）→ read 落 1 行 kind=read（mode=first/counted=true）
const m1 = run(['send', '--boot', dev.token, '--to', 'pm', '--subject', '未读用例', '--body', 'x', '--no-wake', '--json']).message;
const r1 = run(['read', '--boot', pm.token, '--id', m1.id, '--json']);
const rows1 = readRows(m1.id);
check('① 未读消息 read 落 1 行 kind=read', rows1.length === 1, rows1.length);
check('① 首读标记 mode=first 且 counted=true', rows1[0] && rows1[0].mode === 'first' && rows1[0].counted === true, rows1[0]);
check('① 阅读行含 messageId/role/at', Boolean(rows1[0] && rows1[0].messageId === m1.id && rows1[0].role === 'pm' && rows1[0].at), rows1[0]);

// ② 已被唤醒投递自动已读（在 cur）的消息 → read 也要落行（mode=reread/counted=false）
const m2 = run(['send', '--boot', dev.token, '--to', 'pm', '--subject', '唤醒用例', '--body', 'x', '--json']).message;
const before2 = readRows(m2.id).length;
const r2 = run(['read', '--boot', pm.token, '--id', m2.id, '--json']);
const rows2 = readRows(m2.id);
check('② 已投递/已读消息 read 也落 kind=read', rows2.length === before2 + 1, { before2, after: rows2.length });
check('② 已读消息 read 也落行（首行 mode=first，alreadyRead=true）', Boolean(r2.alreadyRead) === true && rows2.at(-1) && rows2.at(-1).messageId === m2.id, { alreadyRead: r2.alreadyRead, last: rows2.at(-1) });

// ③ 重复 read 不重复计（计数行仍只有 1 条）
run(['read', '--boot', pm.token, '--id', m1.id, '--json']);
run(['read', '--boot', pm.token, '--id', m2.id, '--json']);
const counted1 = readRows(m1.id).filter((row) => row.counted !== false).length;
const counted2 = readRows(m2.id).filter((row) => row.counted !== false).length;
check('③ 重复 read 后 m1 计数行仍 1 条', counted1 === 1, counted1);
check('③ 唤醒消息 m2 计数行 1 条（重复 read 不再计）', counted2 === 1, counted2);

// ④ CLI 输出带 readCounted，便于断言
check('④ read --json 返回 readReceipt 与 readCounted', Boolean(r1.readReceipt) && r1.readCounted === true && r2.readCounted === true, { r1: r1.readCounted, r2: r2.readCounted });

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\n阅读行断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
fs.writeFileSync(path.join(SB, 'run-read-receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed, failed, results }, null, 2) + '\n', 'utf8');
if (failed) process.exitCode = 1;
