#!/usr/bin/env node
'use strict';
/**
 * B-20261116-134449-f73f 夹具：no_carrier_task 不再被去重吞掉 + route status 显示「无载体 N 条」。
 *
 * 判据（PM 2026-11-18 单；AC2/AC3/AC4）：
 *   ① 无载体需求：连续两拍（状态变 ready、决定再落一条）都向 PM 发 escalation（NO_CARRIER_TASK），**不去重**；
 *   ② `route status --json` 返回 noCarrier.count≥1、requirementIds 含该需求，人类可读输出含「无载体 1 条」；
 *   ③ 有正常载体任务时 planForRow 仍返回 develop（AC4 既有派单路由不受影响）；
 *   ④ 其它 skip（unknown_decision）仍按 10 分钟去重（alert_deduped）——不误伤既有口径。
 *
 * 隔离：TEAM_ROOT 沙盘（不复制真实 邮箱/项目状态）+ TEAM_SELFTEST=1，真实 团队.json 零写入。
 * 跑法：node scripts/test-f73f-no-carrier.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '..');
const { mkTempSandbox, rmSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
const SB = mkTempSandbox('f73f-no-carrier');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = 'f73f无载体沙盘';
const REAL_TEAM_FILE = path.join(ROOT, '团队', '状态', '团队.json');
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
const realBefore = sha(REAL_TEAM_FILE);
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 800)}`);
  if (!ok) process.exitCode = 1;
}
function runCli(args) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    const text = String(out);
    return { status: 0, human: text, json: text.includes('{') ? JSON.parse(text.slice(text.indexOf('{'))) : null };
  } catch (e) {
    return { status: e.status, human: String((e && e.stdout) || ''), json: null, err: String((e && e.stderr) || '') };
  }
}
const mailOf = (role) => {
  const dir = path.join(TEAM_ROOT, '状态', '邮箱', role);
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (name.endsWith('.json')) { try { out.push(JSON.parse(fs.readFileSync(full, 'utf8'))); } catch { /* skip */ } }
    }
  };
  walk(dir);
  return out;
};
const noCarrierMails = (role) => mailOf(role).filter((m) => /NO_CARRIER_TASK/.test(String(m.body || '') + String(m.subject || '')));

async function main() {
  fs.mkdirSync(PROJECTS, { recursive: true });
  fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, {
    recursive: true,
    filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) && !/[\\/]备份([\\/]|$)/.test(src) && !/[\\/]邮箱([\\/]|$)/.test(src) && !/[\\/]状态[\\/]项目([\\/]|$)/.test(src),
  });
  const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
  const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = PROJECT;
  fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
  process.env.TEAM_ROOT = TEAM_ROOT;
  process.env.TEAM_PROJECTS_ROOT = PROJECTS;
  process.env.TEAM_SELFTEST = '1';

  const add = runCli(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
  if (!add.json || add.json.ok !== true) throw new Error('project add 失败：' + add.human + add.err);
  const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
  const taskDir = path.join(stateDir, '任务');
  fs.mkdirSync(taskDir, { recursive: true });
  const iso = (ms) => new Date(ms).toISOString();
  const NOW = Date.now();
  const REQ = 'R-20261118-023000-f73f';
  const wfPath = path.join(stateDir, '工作流.json');
  const writeWf = (row) => fs.writeFileSync(wfPath, JSON.stringify({ schema: 2, round: 1, updatedAt: iso(NOW), requirements: { [REQ]: row } }, null, 2) + '\n', 'utf8');
  const mkRow = (status, decisions) => ({
    id: REQ, title: 'f73f 无载体需求', status, priority: 'P1', deliveryRound: 2,
    trq: { verdict: 'testable' }, decisions, createdAt: iso(NOW - 86400000),
    // approved → ready 的过渡要过 G2（产品评审通过）；夹具用无正文的评审记录（hash 两侧都空 = 不比）
    productReview: { verdict: 'approve', at: iso(NOW - 120000) },
  });
  // 唯一一条镜像任务（type=requirement，无 owner）：route 只当元数据、不认作载体
  fs.writeFileSync(path.join(taskDir, `${REQ}.json`), JSON.stringify({
    id: REQ, project: PROJECT, type: 'requirement', requirementId: '', title: '镜像任务',
    detail: '', acceptance: '', story: '', priority: 'P1', priorityBy: 'pm', priorityReason: '',
    owner: null, status: 'open', createdBy: 'pm', createdAt: iso(NOW - 86400000), claimedAt: null,
    due: '', doneAt: null, evidence: '', rev: 0, history: [], workflow: {},
  }, null, 2) + '\n', 'utf8');

  const mod = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'route-daemon.mjs')).href);
  const { routeTick, planForRow, carrierOf } = mod;
  const D = (n) => [{ status: 'approved', at: iso(NOW - 60000 + n * 1000), opinion: '同意' }];

  // 拍 1：approved 行做基线快照
  writeWf(mkRow('approved', D(0)));
  await routeTick(PROJECT, { now: NOW });
  // 拍 2：状态 approved → ready（产生状态迁移事件）→ 无载体
  writeWf(mkRow('ready', D(0)));
  const tick2 = await routeTick(PROJECT, { now: NOW + 60 * 1000 });
  const mails2 = noCarrierMails('pm');
  // 拍 3/4：ready → approved（审批分支，不告警）→ approved → ready（再造一次同原因事件）→ 仍应再告警
  writeWf(mkRow('approved', D(0)));
  const tick3 = await routeTick(PROJECT, { now: NOW + 2 * 60 * 1000 });
  writeWf(mkRow('ready', D(0)));
  const tick4 = await routeTick(PROJECT, { now: NOW + 3 * 60 * 1000 });
  const mails4 = noCarrierMails('pm');

  check('①a 状态变 ready 后：PM 收到 NO_CARRIER_TASK escalation',
    mails2.length >= 1 && String(mails2[mails2.length - 1].type || '') === 'escalation',
    { count: mails2.length, rows: mails2.map((m) => `${m.type}/${m.subject}`).slice(-2), tick: tick2 && tick2.skips });
  check('①b 10 分钟内连续两拍同原因（ready→approved→ready）每次都再发——no_carrier_task 不去重（AC2）',
    mails4.length === mails2.length + 2
      && ((tick3 && tick3.skips) || []).some((s) => s.why === 'no_carrier_task')
      && ((tick4 && tick4.skips) || []).some((s) => s.why === 'no_carrier_task')
      && ![...((tick3 && tick3.skips) || []), ...((tick4 && tick4.skips) || [])].some((s) => /alert_deduped\(NO_CARRIER_TASK\)/.test(String(s.why || ''))),
    { before: mails2.length, after: mails4.length, tick2: tick2 && tick2.skips, tick3: tick3 && tick3.skips, tick4: tick4 && tick4.skips });
  check('①c routeTick 返回 out.noCarrier 含该需求（单独计数）',
    Boolean(tick4 && Array.isArray(tick4.noCarrier) && tick4.noCarrier.some((r) => r.requirementId === REQ)),
    { noCarrier: tick4 && tick4.noCarrier });

  // ② route status
  const status = runCli(['route', 'status', '--project', PROJECT, '--json']);
  const human = runCli(['route', 'status', '--project', PROJECT]);
  check('②a route status --json：noCarrier.count≥1 且 requirementIds 含需求',
    Boolean(status.json && status.json.noCarrier && Number(status.json.noCarrier.count) >= 1 && status.json.noCarrier.requirementIds.includes(REQ)),
    { status: status.json && status.json.noCarrier, err: status.err });
  check('②b route status 人类可读输出含「无载体 1 条」',
    /无载体\s*1\s*条/.test(String(human.human || '')),
    { human: String(human.human || '').slice(0, 500) });

  // ③ 有正常载体 → 仍走 develop（AC4）
  const carrier = { id: 'T-20261118-023001-carr', type: 'task', owner: 'programmer1', status: 'open', requirementId: REQ, workflow: { round: 2 } };
  const pCarrier = planForRow(mkRow('ready', D(0)), { tasks: [carrier], projectPath: path.join(PROJECTS, PROJECT), mode: 'full' });
  check('③ 有正常载体任务（task+owner=programmer1）→ plan 仍为 develop（AC4）',
    pCarrier.action === 'develop' && carrierOf(REQ, [carrier], mkRow('ready', D(0))) === 'programmer1',
    { plan: pCarrier, carrier: carrierOf(REQ, [carrier], mkRow('ready', D(0))) });

  // ④ 其它 skip 仍去重：预置「1 分钟前已对 unknown_decision 告过警」的状态，再造一次同原因事件
  const NEXT = NOW + 20 * 60 * 1000;
  const statusFile = path.join(stateDir, '守护状态.json');
  const curStatus = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : {};
  curStatus.noTaskAlerts = { ...(curStatus.noTaskAlerts || {}), [`no_task|${REQ}|NO_DISPATCHABLE_TASK`]: new Date(NEXT - 60 * 1000).toISOString() };
  fs.writeFileSync(statusFile, JSON.stringify(curStatus, null, 2) + '\n', 'utf8');
  writeWf(mkRow('approved', [{ status: 'pending', at: iso(NEXT - 5000) }]));
  await routeTick(PROJECT, { now: NEXT });
  writeWf(mkRow('ready', [{ status: 'pending', at: iso(NEXT - 5000) }]));
  const d2 = await routeTick(PROJECT, { now: NEXT + 60 * 1000 });
  const deduped = ((d2 && d2.skips) || []).some((s) => /alert_deduped\(/.test(String(s.why || '')));
  check('④ unknown_decision 在 10 分钟去重窗内仍被去重（alert_deduped）——既有去重口径不误伤',
    deduped, { d2: d2 && d2.skips });

  // ⑤ 隔离
  const realAfter = sha(REAL_TEAM_FILE);
  check('⑤ 真实 团队.json sha256 不变（沙盘零写入）', Boolean(realBefore) && realBefore === realAfter, { before: realBefore.slice(0, 12), after: realAfter.slice(0, 12) });

  const total = results.length;
  const pass = results.filter((x) => x.ok).length;
  const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-f73f');
  fs.mkdirSync(evDir, { recursive: true });
  const evFile = path.join(evDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${total - pass === 0 ? 'green' : 'red'}.json`);
  fs.writeFileSync(evFile, JSON.stringify({ task: 'B-20261116-134449-f73f', at: new Date().toISOString(), total, pass, red: total - pass, results }, null, 2) + '\n', 'utf8');
  console.log(`\nF73F_${total - pass === 0 ? 'OK' : 'RED'} ${JSON.stringify({ total, pass, red: total - pass })}`);
  console.log(`证据：${evFile}`);
  if (process.env.AWB_KEEP_SANDBOX !== '1') { try { rmSandbox(SB); } catch { /* ignore */ } }
}

main().catch((e) => { console.error('CRASH', String((e && e.stack) || e)); process.exit(2); });
