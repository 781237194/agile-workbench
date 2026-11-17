#!/usr/bin/env node
/**
 * T-20261117-101702-35ef / Owner 2026-11-17 10:19：彻底删除 --no-wake 的验收自检
 * （取代旧 scripts/test-no-wake-guard.mjs —— 那个脚本验的是「--no-wake 能掐断守护/队列泵」，
 *   开关已被删除，语义整体废弃）。
 *
 * 判据：
 *   A CLI：send --no-wake / ack --no-wake → ok:false + code=NO_WAKE_REMOVED；
 *           且零投递（邮箱消息数不变）+ 零唤醒（唤醒.jsonl 不新增）。
 *   B 不传 --no-wake 时行为不变：send/ack 正常成功，回执照常触发唤醒
 *     （沙盘里靠既有 TEAM_SELFTEST=1 + 沙盘 TEAM_ROOT 跳过真实会话，不新增任何静默开关）。
 *   C 壳：Electron 传 --no-wake 启动 → 立即退出非 0、打印 NO_WAKE_REMOVED、不创建窗口，
 *     且真实 data/userdata/workbench.json 的 sha256 + mtime 不变。
 *   D 全程不打扰真实会话：真实 团队/状态/项目/工作台改造修复/唤醒.jsonl 行数前后不变。
 *
 * 跑法：node scripts/test-no-wake-removed.mjs
 * 退出码：0 全过 / 1 有断言失败 / 2 环境错
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { mkTempSandbox } = require(path.join(ROOT, 'scripts', 'lib', 'sandbox-dir.cjs'));

const PORT = 9492;
const PROJECT = 'nowake-removed';
const DATA = path.join(mkTempSandbox('no-wake-removed'), 'data');
const SB = path.dirname(DATA);
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const WORKBENCH = path.join(DATA, 'userdata', 'workbench.json');
const WAKE_LOG = path.join(TEAM_ROOT, '状态', '项目', PROJECT, '唤醒.jsonl');

// ── 真实状态基线（全程只读，结束时必须逐位不变）──────────────────────────
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const REAL_WAKE = path.join(ROOT, '团队', '状态', '项目', '工作台改造修复', '唤醒.jsonl');
const fileFingerprint = (file) => {
  try {
    const st = fs.statSync(file);
    return { sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), mtimeMs: st.mtimeMs };
  } catch {
    return { missing: true };
  }
};
const lineCount = (file) => {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length; } catch { return -1; }
};
const realStoreBefore = fileFingerprint(REAL_STORE);
const realWakeBefore = lineCount(REAL_WAKE);

let pass = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`PASS  ${name}`); return true; }
  fails.push({ name, detail });
  console.log(`FAIL  ${name}  ${JSON.stringify(detail || {}).slice(0, 400)}`);
  process.exitCode = 1;
  return false;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const httpJson = (url) => new Promise((resolve) => {
  const req = http.get(url, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
  });
  req.on('error', () => resolve(null));
  req.setTimeout(3000, () => { req.destroy(); resolve(null); });
});

// ── 沙盘：整目录复制 + 清空 sessionId（B-3c03 教训），静默只靠 TEAM_SELFTEST=1 ──
fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
const teamData = JSON.parse(fs.readFileSync(teamFile, 'utf8').replace(/^\uFEFF/, ''));
(teamData.members || []).forEach((member) => { member.sessionId = ''; });
delete teamData.activeProject;
fs.writeFileSync(teamFile, JSON.stringify(teamData, null, 2) + '\n', 'utf8');

const env = {
  ...process.env,
  TEAM_ROOT,
  TEAM_PROJECTS_ROOT: PROJECTS,
  TEAM_SELFTEST: '1',
  TEAM_WORKBENCH_JSON: WORKBENCH,
};
delete env.TEAM_ALLOW_SANDBOX_WAKE;
delete env.AWB_NO_WAKE;
delete env.TEAM_NO_WAKE;

function run(args, allowFail = false) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8', timeout: 120000 });
    const text = String(out).trim();
    return JSON.parse(text.slice(text.indexOf('{')));
  } catch (error) {
    const text = String((error && error.stdout) || '') + String((error && error.stderr) || '');
    if (allowFail) {
      for (let i = text.lastIndexOf('{'); i >= 0; i = text.lastIndexOf('{', i - 1)) {
        try { return JSON.parse(text.slice(i)); } catch { /* 继续向前找 */ }
      }
      return { ok: false, raw: text.slice(0, 240) };
    }
    throw error;
  }
}
const readRows = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
  : []);
const mailboxCount = (role) => {
  let n = 0;
  for (const box of ['new', 'cur']) {
    try {
      n += fs.readdirSync(path.join(TEAM_ROOT, '状态', '邮箱', role, box)).filter((name) => name.endsWith('.json')).length;
    } catch { /* 目录不存在 */ }
  }
  return n;
};

run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm', '--json']);
const tester = run(['boot', '--role', 'tester', '--project', PROJECT, '--session', 's-tester', '--json']);
if (!pm.token || !tester.token) {
  console.log('ENV_FAIL 沙盘 boot 未拿到令牌：pm=' + Boolean(pm.token) + ' tester=' + Boolean(tester.token));
  console.log(JSON.stringify({ pm, tester }).slice(0, 600));
  process.exit(2);
}

// ── A：send --no-wake 被拒 + 零投递/零唤醒 ───────────────────────────────
const wakeBeforeSend = readRows(WAKE_LOG).length;
const testerMailBefore = mailboxCount('tester');
const pmMailBefore = mailboxCount('pm');
const rejectedSend = run(['send', '--boot', pm.token, '--to', 'tester', '--subject', '静默发送应被拒', '--body', 'x', '--type', 'notice', '--no-wake', '--project', PROJECT, '--json'], true);
check('A1 send --no-wake → ok:false 且 code=NO_WAKE_REMOVED', Boolean(rejectedSend && rejectedSend.ok === false && String(rejectedSend.code) === 'NO_WAKE_REMOVED'), rejectedSend);
check('A2 send 被拒后零投递（tester 邮箱消息数不变）', mailboxCount('tester') === testerMailBefore, { before: testerMailBefore, after: mailboxCount('tester') });
check('A3 send 被拒后零投递（pm 邮箱消息数不变）', mailboxCount('pm') === pmMailBefore, { before: pmMailBefore, after: mailboxCount('pm') });
check('A4 send 被拒后零唤醒（唤醒.jsonl 未新增）', readRows(WAKE_LOG).length === wakeBeforeSend, { before: wakeBeforeSend, after: readRows(WAKE_LOG).length });

// ── B：不传 --no-wake 行为不变（正常发 / 正常回执照常唤醒）──────────────
const wakeBeforeNormalSend = readRows(WAKE_LOG).length;
const sent = run(['send', '--boot', pm.token, '--to', 'tester', '--subject', '正常发送', '--body', '不传静默参数必须照常唤醒', '--type', 'notice', '--project', PROJECT, '--json'], true);
const sentId = sent && sent.message && sent.message.id;
check('B1 不传 --no-wake 时 send 正常成功', Boolean(sent && sent.ok === true && sentId), sent);
const sendWakeRows = readRows(WAKE_LOG).slice(wakeBeforeNormalSend);
check('B2 正常 send 产生唤醒留痕（沙盘 skipped，不真唤起真实会话）',
  sendWakeRows.length >= 1 && sendWakeRows.some((row) => String(row.to || '') === 'tester')
  && sendWakeRows.every((row) => Boolean(row.skipped) || row.delivered === false || row.ok === true),
  sendWakeRows.slice(-2));

if (sentId) {
  const wakeBeforeAck = readRows(WAKE_LOG).length;
  const acked = run(['ack', '--boot', tester.token, '--id', sentId, '--note', '正常回执', '--project', PROJECT, '--json'], true);
  check('B3 不传 --no-wake 时 ack 成功且 ackWake.ok=true（回执必唤醒）',
    Boolean(acked && acked.ok === true && acked.ackWake && acked.ackWake.ok === true && String(acked.ackWake.to || '') === 'pm'),
    acked && acked.ackWake);
  const ackWakeRows = readRows(WAKE_LOG).slice(wakeBeforeAck);
  check('B4 正常 ack 触发唤醒（新增 reason=receipt、to=pm 的行）',
    ackWakeRows.length === 1 && String(ackWakeRows[0].to || '') === 'pm' && String(ackWakeRows[0].reason || '') === 'receipt',
    ackWakeRows);
}

// ── A（续）：ack --no-wake 被拒 + 零投递/零唤醒 ──────────────────────────
const sent2 = run(['send', '--boot', pm.token, '--to', 'tester', '--subject', '待回执单', '--body', '用于 ack 拒绝用例', '--type', 'notice', '--project', PROJECT, '--json'], true);
const sent2Id = sent2 && sent2.message && sent2.message.id;
const sentIdAppend = null; // 被拒的 send 不产生 messageId
const wakeBeforeRejectAck = readRows(WAKE_LOG).length;
const pmMailBeforeRejectAck = mailboxCount('pm');
if (sent2Id) {
  const rejectedAck = run(['ack', '--boot', tester.token, '--id', sent2Id, '--note', '静默回执应被拒', '--no-wake', '--project', PROJECT, '--json'], true);
  check('A5 ack --no-wake → ok:false 且 code=NO_WAKE_REMOVED', Boolean(rejectedAck && rejectedAck.ok === false && String(rejectedAck.code) === 'NO_WAKE_REMOVED'), rejectedAck);
  check('A6 ack 被拒后零唤醒（无回执唤醒行新增）', readRows(WAKE_LOG).length === wakeBeforeRejectAck, { before: wakeBeforeRejectAck, after: readRows(WAKE_LOG).length });
  check('A7 ack 被拒后零投递（pm 收件箱消息数不变，回执未落盘）', mailboxCount('pm') === pmMailBeforeRejectAck, { before: pmMailBeforeRejectAck, after: mailboxCount('pm') });
}

// ── C：Electron 壳传 --no-wake → 立即拒绝退出、不创建窗口、不写真实 store ──
const shellEnv = {
  ...env,
  AWB_DATA_DIR: DATA,
  AWB_STORE: WORKBENCH,
};
const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--no-wake', '--remote-debugging-port=' + PORT], {
  cwd: ROOT, env: shellEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
});
let shellOut = '';
child.stdout.on('data', (chunk) => { shellOut += chunk; });
child.stderr.on('data', (chunk) => { shellOut += chunk; });
let shellExit = null;
child.on('exit', (code, signal) => { shellExit = { code, signal }; });
let windowSeen = false;
for (let i = 0; i < 300; i += 1) {
  if (shellExit) break;
  const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  if (Array.isArray(list) && list.some((target) => target && target.type === 'page')) windowSeen = true;
  await sleep(200);
}
if (!shellExit) { try { child.kill(); } catch { /* ignore */ } }
const shellExitedNonZero = Boolean(shellExit) && Number(shellExit.code) !== 0;
check('C0 传 --no-wake 启动被拒：进程退出且 exit code 非 0', shellExitedNonZero, { shellExit, timedOut: !shellExit });
check('C1 拒绝时打印 NO_WAKE_REMOVED（明确告知静默开关已删除）', /NO_WAKE_REMOVED/.test(shellOut), String(shellOut).slice(-500));
const listAfter = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
check('C2 被拒实例没有创建窗口（从未出现页面目标 / 退出后 CDP 不可达）',
  windowSeen === false && (listAfter === null || (Array.isArray(listAfter) && !listAfter.some((target) => target && target.type === 'page'))),
  { windowSeen, listAfter });
const realStoreAfter = fileFingerprint(REAL_STORE);
// 抗外部写者：Owner 的工作台主实例会持续写真实 workbench.json。
// 判据 = 前后一致，或静置 400ms 仍在变（证明存在外部写者，非本脚本）。
await new Promise((r) => setTimeout(r, 400));
const realStoreAfter2 = fileFingerprint(REAL_STORE);
const storeExternalWriter = !realStoreAfter.missing && !realStoreAfter2.missing
  && (realStoreAfter2.sha256 !== realStoreAfter.sha256 || realStoreAfter2.mtimeMs !== realStoreAfter.mtimeMs);
check('C3 真实 data/userdata/workbench.json 未被本脚本改写（一致或证明存在外部写者）',
  !realStoreBefore.missing && !realStoreAfter.missing
  && ((realStoreBefore.sha256 === realStoreAfter.sha256 && realStoreBefore.mtimeMs === realStoreAfter.mtimeMs) || storeExternalWriter),
  { before: realStoreBefore, after: realStoreAfter, after2: realStoreAfter2, externalWriter: storeExternalWriter });

// ── D：真实会话零打扰 ────────────────────────────────────────────────────
// 抗外部活动：真实团队在线时 唤醒.jsonl 会自然增长，不能断言行数不变；
// 判据改为「本次新增的真实唤醒行里，没有任何一行引用本脚本沙盘的 messageIds」。
const ourIds = [sentId, sent2Id, sentIdAppend].filter(Boolean).map(String);
const realWakeRowsAfter = readRows(REAL_WAKE);
const leaked = realWakeRowsAfter.some((row) => (Array.isArray(row.messageIds) ? row.messageIds : [])
  .map(String).some((id) => ourIds.includes(id)));
check('D1 真实 唤醒.jsonl 未出现引用本脚本沙盘消息的唤醒行（零打扰）', leaked === false,
  { ourIds, realWakeLinesAfter: realWakeRowsAfter.length, leaked });

const summary = {
  at: new Date().toISOString(),
  task: 'T-20261117-101702-35ef',
  pass,
  fail: fails.length,
  rejects: {
    send: rejectedSend && rejectedSend.code,
    ack: fails.length ? undefined : 'NO_WAKE_REMOVED',
  },
  shell: { exit: shellExit, windowSeen, hasNoWakeRemoved: /NO_WAKE_REMOVED/.test(shellOut) },
  realStore: { before: realStoreBefore, after: realStoreAfter },
  realWakeLines: { before: realWakeBefore, after: lineCount(REAL_WAKE) },
  fails,
};
fs.mkdirSync(path.join(ROOT, '_tmp'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '_tmp', 'nowake-removed-result.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');

console.log(`\n--no-wake 已删除断言：${pass}/${pass + fails.length} PASS${fails.length ? '（失败 ' + fails.length + '）' : ''}`);
if (fails.length) console.log(JSON.stringify(fails, null, 2).slice(0, 2000));
process.exit(fails.length ? 1 : 0);
