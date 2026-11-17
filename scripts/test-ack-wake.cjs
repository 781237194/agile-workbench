#!/usr/bin/env node
'use strict';
const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * test-ack-wake.cjs — 回执必须唤醒（Owner 2026-11-16 18:50 要求）
 *
 * 背景：此前 cmdAck 只落盘不唤醒（旧注释「纯回执不唤醒」），
 * 导致「角色回执给 PM，PM 收不到」。本脚本断言：
 *   AC1 普通回执 → 触发一次唤醒（唤醒.jsonl 出现 reason=receipt 行）
 *   AC2 ack --no-wake → 不唤醒（唯一退出阀）
 *   AC3 重复回执（already）→ 不重复唤醒
 *   AC4 唤醒目标 = 原消息发送方（此处为 pm）
 *   另：沙盘根（TEAM_ROOT 指 _tmp）不真发网络，只落留痕 + 文案。
 *
 * 用法：node scripts/test-ack-wake.cjs
 * 退出码：0 全过 / 1 有断言失败 / 2 环境错
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'ack-wake-' + Date.now().toString(36));
const TEAM = path.join(SB, '团队');
const PROJECT = '工作台改造修复';
const PROJ_SRC = path.join(ROOT, '项目', PROJECT);
const TEAM_SRC = path.join(ROOT, '团队');
const TEAM_MJS = path.join(TEAM_SRC, '工具', 'team.mjs');
const WAKE_LOG = path.join(TEAM, '状态', '项目', PROJECT, '唤醒.jsonl');

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log('PASS  ' + name); return; }
  fails.push({ name, detail });
  console.log('FAIL  ' + name + ' · ' + JSON.stringify(detail).slice(0, 400));
};

const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  TEAM_ROOT: TEAM,
  TEAM_PROJECTS_ROOT: path.join(ROOT, '项目'),
  TEAM_WORKBENCH_JSON: path.join(SB, 'workbench.json'),
  TEAM_SELFTEST: '1',
};
delete env.TEAM_ALLOW_SANDBOX_WAKE;

function run(args) {
  try {
    const out = execFileSync(process.execPath, [TEAM_MJS, ...args], { cwd: SB, env, encoding: 'utf8', timeout: 120000 });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String((e.stdout || '') + (e.stderr || '')) };
  }
}

function runJson(args) {
  const r = run([...args, '--json']);
  const text = r.out;
  for (let i = text.lastIndexOf('{'); i >= 0; i = text.lastIndexOf('{', i - 1)) {
    try { return { ...r, json: JSON.parse(text.slice(i)) }; } catch { /* 继续向前找 */ }
  }
  return { ...r, json: null };
}

function boot(role) {
  const r = run(['boot', '--role', role, '--project', PROJECT]);
  const m = /令牌[:：]\s*([0-9a-f]{24})/.exec(r.out);
  return { token: m ? m[1] : '', raw: r };
}

function wakeRows() {
  if (!fs.existsSync(WAKE_LOG)) return [];
  return fs.readFileSync(WAKE_LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}
const receiptRows = () => wakeRows().filter((r) => r.reason === 'receipt');

// ── 沙盘搭建（照 scripts/test-cli-boot-gate.cjs 的 seed 口径）
fs.mkdirSync(path.join(TEAM, '状态', '项目'), { recursive: true });
const teamJson = JSON.parse(fs.readFileSync(path.join(TEAM_SRC, '状态', '团队.json'), 'utf8'));
for (const m of (teamJson.members || [])) delete m.sessionId;
teamJson.activeProjectId = '';
fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(teamJson, null, 2), 'utf8');
for (const rel of ['团队宪法.md', '项目铁律.md', '项目经理/角色卡.md', '测试人员/角色卡.md', '项目经理/文件索引.md', '测试人员/文件索引.md']) {
  const from = path.join(TEAM_SRC, rel);
  if (!fs.existsSync(from)) continue;
  const to = path.join(TEAM, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
fs.cpSync(path.join(TEAM_SRC, '状态', '项目', PROJECT), path.join(TEAM, '状态', '项目', PROJECT), { recursive: true });
try { fs.rmSync(WAKE_LOG, { force: true }); } catch { /* 无则忽略 */ }

const pm = boot('pm');
const tester = boot('tester');
if (!pm.token || !tester.token) {
  console.log('ENV_FAIL boot 未拿到令牌：pm=' + Boolean(pm.token) + ' tester=' + Boolean(tester.token));
  console.log(pm.raw.out.slice(-400));
  process.exit(2);
}

// AC1 普通回执 → 唤醒发送方 pm
const sent = runJson(['send', '--project', PROJECT, '--boot', pm.token, '--to', 'tester', '--subject', 'AC1 普通回执', '--body', '回执后应唤醒 pm']);
const msgId = sent.json && (sent.json.message && sent.json.message.id);
check('AC0 pm→tester 消息已落盘', Boolean(msgId), sent.json || sent.out.slice(-300));

let acked = null;
if (msgId) {
  acked = runJson(['ack', '--project', PROJECT, '--boot', tester.token, '--id', msgId, '--note', 'AC1 回执']);
  const rows = receiptRows();
  check('AC1 回执触发唤醒（reason=receipt）', rows.length === 1, rows);
  check('AC4 唤醒目标是原发送方 pm', rows.length === 1 && rows[0].to === 'pm', rows);
  check('AC1 返回值带 ackWake', Boolean(acked.json && acked.json.ackWake), acked.json && { ackWake: acked.json.ackWake });
  const aw = acked.json && acked.json.ackWake;
  check('AC1 沙盘标记正确（跳过真实网络）', Boolean(aw) && (aw.skipped === 'sandbox_wake_skipped' || aw.skipped === 'SELFTEST'), aw);
}

// AC3 重复回执 → 不重复唤醒
if (msgId) {
  const before = receiptRows().length;
  runJson(['ack', '--project', PROJECT, '--boot', tester.token, '--id', msgId, '--note', 'AC3 重复回执']);
  const after = receiptRows().length;
  check('AC3 重复回执不重复唤醒', after === before, { before, after });
}

// AC2 --no-wake 不唤醒
const sent2 = runJson(['send', '--project', PROJECT, '--boot', pm.token, '--to', 'tester', '--subject', 'AC2 no-wake', '--body', '带 --no-wake 回执不应唤醒']);
const msgId2 = sent2.json && (sent2.json.message && sent2.json.message.id);
if (msgId2) {
  const before = receiptRows().length;
  const acked2 = runJson(['ack', '--project', PROJECT, '--boot', tester.token, '--id', msgId2, '--note', 'AC2 静默回执', '--no-wake']);
  const after = receiptRows().length;
  check('AC2 ack --no-wake 不唤醒', after === before, { before, after, ackWake: acked2.json && acked2.json.ackWake });
}


try { rmSandbox(SB, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

console.log('\nack-wake 断言：' + pass + '/' + (pass + fails.length) + (fails.length ? '（失败 ' + fails.length + '）' : ' PASS'));
process.exit(fails.length ? 1 : 0);
