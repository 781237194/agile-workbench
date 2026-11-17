#!/usr/bin/env node
'use strict';
/**
 * B-20261117-082720-6e7c 硬回归：回执必须唤醒原消息发送方（Owner 2026-11-16 18:50 死规矩）
 *
 * 判据：
 *   ① A(pm) --ack 派单 → B(programmer1) ack → 返回 ackWake 必须 ok 且 to=A；唤醒.jsonl 有 to=A 且带回执消息 id 的行；
 *      事件流有 action=ack_wake、target=原消息 id 的审计行。
 *   ② --no-wake 才静默：再派一单，B ack --no-wake → 不产生「to=pm 且非 SELFTEST skipped」的唤醒行、ackWake 为 null。
 *   ③ 回执不再回执（回执类消息被 ack 不生成「回执: 回执:」套娃）。
 *
 * 跑法：node scripts/test-ack-wake-6e7c.cjs ｜ 沙盘：mkTempSandbox，TEAM_SELFTEST=1（唤醒走 SELFTEST 分支）
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
const SB = mkTempSandbox('ack-wake-6e7c');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '回执唤醒沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1', TEAM_WORKBENCH_JSON: path.join(SB, 'data', 'userdata', 'workbench.json') };
fs.mkdirSync(path.join(SB, 'data', 'userdata'), { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 320)}`);
  if (!ok) process.exitCode = 1;
}
function run(args, allowFail = false) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    const t = String(out).trim();
    return JSON.parse(t.slice(t.indexOf('{')));
  } catch (e) {
    const text = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    if (allowFail) { try { return JSON.parse(text.slice(text.indexOf('{'))); } catch { return { ok: false, raw: text.slice(0, 240) }; } }
    throw e;
  }
}
const wakeFile = path.join(TEAM_ROOT, '状态', '项目', PROJECT, '唤醒.jsonl');
const eventFile = path.join(TEAM_ROOT, '状态', '事件.jsonl');
const readRows = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
  : []);

fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
// 沙盘双保险（B-3c03 教训）：清空真实 sessionId / activeProject，并把壳层状态指到沙盘，
// 避免唤醒与投递按名册打到真实会话、避免写真实 data/userdata/workbench.json。
const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
const teamData = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
(teamData.members || []).forEach((m) => { m.sessionId = ''; });
delete teamData.activeProject;
fs.writeFileSync(teamFile, JSON.stringify(teamData, null, 2) + '\n', 'utf8');
run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm', '--json']);
const p1 = run(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-p1', '--json']);

// ── ① A 发 --ack → B ack → 必须唤醒 A ──
const m1 = run(['send', '--boot', pm.token, '--to', 'programmer1', '--subject', '首单', '--body', '请执行', '--ack', '--project', PROJECT, '--json'], true);
check('夹具：A(pm) --ack 发单成功', Boolean(m1 && m1.message && m1.message.id), m1);
run(['read', '--boot', p1.token, '--id', m1.message.id, '--project', PROJECT, '--json'], true);
const ack = run(['ack', '--boot', p1.token, '--id', m1.message.id, '--note', '收到', '--project', PROJECT, '--json'], true);
check('① ack 返回 ackWake.ok 且 to=pm（回执必唤醒发送方）', Boolean(ack && ack.ackWake && ack.ackWake.ok === true && ack.ackWake.to === 'pm'), ack && ack.ackWake);
const pmInbox = run(['inbox', '--boot', pm.token, '--all', '--project', PROJECT, '--json'], true);
const receiptMsg = (pmInbox.messages || []).find((m) => m.type === 'receipt');
check('夹具：PM 收到回执消息', Boolean(receiptMsg && receiptMsg.id), receiptMsg && receiptMsg.id);
const wakeRows1 = readRows(wakeFile);
const receiptId = String(receiptMsg && receiptMsg.id || '');
const hitPmWake = wakeRows1.filter((row) => String(row.to || '') === 'pm'
  && (Array.isArray(row.messageIds) ? row.messageIds.map(String) : []).includes(receiptId));
check('① 唤醒.jsonl 有 to=pm 且带回执消息 id 的行', hitPmWake.length >= 1, { receiptId, rows: wakeRows1.slice(-3) });
const ackWakeEvents = readRows(eventFile).filter((row) => String(row.action || '') === 'ack_wake' && String(row.target || '') === String(m1.message.id));
check('① 事件流有 ack_wake 审计行且 target=原消息 id', ackWakeEvents.length >= 1, ackWakeEvents.slice(-2));

// ── ③ 回执不再回执 ──
run(['read', '--boot', pm.token, '--id', receiptMsg.id, '--project', PROJECT, '--json'], true);
run(['ack', '--boot', pm.token, '--id', receiptMsg.id, '--note', '回执已阅', '--project', PROJECT, '--json'], true);
const pmInbox2 = run(['inbox', '--boot', pm.token, '--all', '--project', PROJECT, '--json'], true);
const nested = (pmInbox2.messages || []).filter((m) => String(m.subject || '').startsWith('回执: 回执:'));
check('③ 回执类消息被 ack 不再套娃（无「回执: 回执:」）', nested.length === 0, nested.slice(0, 2));

// ── ② --no-wake 静默分支 ──
const m2 = run(['send', '--boot', pm.token, '--to', 'programmer1', '--subject', '静默单', '--body', '请执行', '--ack', '--project', PROJECT, '--json'], true);
run(['read', '--boot', p1.token, '--id', m2.message.id, '--project', PROJECT, '--json'], true);
const wakeBefore = readRows(wakeFile).length;
const silentAck = run(['ack', '--boot', p1.token, '--id', m2.message.id, '--note', '静默测试', '--no-wake', '--project', PROJECT, '--json'], true);
check('② --no-wake 下 ackWake 为 null（不唤醒）', Boolean(silentAck && silentAck.ackWake == null), silentAck && silentAck.ackWake);
const newRows = readRows(wakeFile).slice(wakeBefore);
const leak = newRows.filter((row) => String(row.to || '') === 'pm' && row.skipped !== 'SELFTEST' && row.skipped !== 'sandbox_wake_skipped');
check('② --no-wake 不产生「to=pm 且非 skipped」唤醒行', leak.length === 0, leak);

const passed = results.filter((r) => r.ok).length;
console.log(`\nB-6e7c 回执必唤醒断言：${passed}/${results.length} PASS`);
const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-6e7c');
fs.mkdirSync(evDir, { recursive: true });
fs.writeFileSync(path.join(evDir, 'run-ack-wake.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, passed, failed: results.length - passed, results }, null, 2) + '\n', 'utf8');
