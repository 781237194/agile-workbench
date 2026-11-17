#!/usr/bin/env node
'use strict';
/**
 * B-20261117-104829-a358 夹具：缺陷单验收「验收人」展示按真实入口区分（PM / 测试 / Owner / PM 代记）。
 *
 * 判据（PM 2026-11-18 单）：
 *   ① PM 直接验收（--as pm）→ 终端显示「（PM，通道 pm）」，落账 by=pm/channel=pm；
 *   ② 测试直接验收（--as tester）→「（测试，通道 test）」，by=tester/channel=test；
 *   ③ Owner 本人（owner --action accept --channel ui）→「（Owner，通道 ui）」，by=owner/channel=ui；
 *   ④ 代管代记分支不变：源码显示文案含「PM 代记」且由 proxyMode 决定（静态断言）；
 *   ⑤ 三种直接入口的落账 by/channel 值不被文案修复影响（逐字段比对）。
 *
 * 隔离：TEAM_ROOT/TEAM_PROJECTS_ROOT/TEAM_SELFTEST=1 + 唯一 _tmp 沙盘；真实 团队.json 零写入。
 * 跑法：node scripts/test-a358-accept-actor.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const { mkTempSandbox, rmSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
const SB = mkTempSandbox('a358');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = 'a358验收沙盘';
const PROJECT_DIR = path.join(PROJECTS, PROJECT);
const REAL_TEAM_FILE = path.join(ROOT, '团队', '状态', '团队.json');
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
const realBefore = sha(REAL_TEAM_FILE);
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  if (!ok) process.exitCode = 1;
}
function run(args) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    return { status: 0, out: String(out), err: '' };
  } catch (e) {
    return { status: e.status == null ? 1 : e.status, out: String((e && e.stdout) || ''), err: String((e && e.stderr) || '') };
  }
}
const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
const readTask = (id) => JSON.parse(fs.readFileSync(path.join(stateDir, '任务', `${id}.json`), 'utf8'));

fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true });
const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
for (const m of team.members || []) m.sessionId = '';
team.activeProject = PROJECT;
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');

run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'a-pm', '--json']).out;
const pmTok = (JSON.parse(pm.slice(pm.indexOf('{'))) || {}).token;
const testerOut = run(['boot', '--role', 'tester', '--project', PROJECT, '--session', 'a-ts', '--json']).out;
const testerTok = (JSON.parse(testerOut.slice(testerOut.indexOf('{'))) || {}).token;
run(['lessons', 'read', '--boot', pmTok, '--project', PROJECT, '--json']);
run(['lessons', 'read', '--boot', testerTok, '--project', PROJECT, '--json']);

// 证据两件套（落项目目录内；报告正文含 PASS 且不含靶词）
fs.mkdirSync(path.join(PROJECT_DIR, '测试人员', '产出'), { recursive: true });
fs.writeFileSync(path.join(PROJECT_DIR, '测试人员', '产出', '报告-a358.md'), '# a358 测试报告\n\n结论：PASS，全部合格。\n', 'utf8');
fs.writeFileSync(path.join(PROJECT_DIR, '测试人员', '产出', '记录-a358.json'), JSON.stringify({ at: new Date().toISOString(), ok: true }) + '\n', 'utf8');
const EV = ['--evidence', '测试人员/产出/报告-a358.md:report', '--evidence', '测试人员/产出/记录-a358.json:record'];

function mkBug(title) {
  const r = run(['task', 'create', '--boot', pmTok, '--project', PROJECT, '--type', 'bug', '--title', title, '--priority', 'P3', '--acceptance', 'AC', '--repro', '复现步骤', '--owner', 'programmer1', '--json']);
  const j = r.out.includes('{') ? JSON.parse(r.out.slice(r.out.indexOf('{'))) : null;
  return j && j.task && j.task.id;
}

// ① PM 直接验收
const bugPm = mkBug('a358-PM直验');
const rPm = run(['task', 'accept', '--task', bugPm, '--boot', pmTok, '--as', 'pm', ...EV, '--opinion', 'PM 直接验收']);
const textPm = rPm.out + rPm.err;
const recPm = readTask(bugPm).acceptanceRecord || {};
check('① PM 直接验收：终端显示「（PM，通道 pm）」（不再印成 Owner）',
  textPm.includes('（PM，通道 pm）') && !textPm.includes('（Owner，通道 pm）'),
  { out: textPm.slice(0, 400) });
check('①b 落账 by=pm / channel=pm 不变', String(recPm.by) === 'pm' && String(recPm.channel) === 'pm', { record: recPm });

// ② 测试直接验收
const bugTs = mkBug('a358-测试直验');
const rTs = run(['task', 'accept', '--task', bugTs, '--boot', testerTok, '--as', 'tester', ...EV, '--opinion', '测试直接验收']);
const textTs = rTs.out + rTs.err;
const recTs = readTask(bugTs).acceptanceRecord || {};
check('② 测试直接验收：终端显示「（测试，通道 test）」',
  textTs.includes('（测试，通道 test）') && !textTs.includes('（Owner，通道 test）'),
  { out: textTs.slice(0, 400) });
check('②b 落账 by=tester / channel=test 不变', String(recTs.by) === 'tester' && String(recTs.channel) === 'test', { record: recTs });

// ③ Owner 本人（缺陷单走 owner 直接分支，channel ui）
const bugOwner = mkBug('a358-Owner直验');
const rOwner = run(['owner', '--project', PROJECT, '--requirement', bugOwner, '--action', 'accept', '--decision', 'accepted', '--channel', 'ui', ...EV, '--opinion', 'Owner 验收']);
const textOwner = rOwner.out + rOwner.err;
const recOwner = readTask(bugOwner).acceptanceRecord || {};
check('③ Owner 本人验收：终端显示「（Owner，通道 ui）」',
  textOwner.includes('（Owner，通道 ui）'),
  { out: textOwner.slice(0, 400), err: rOwner.err.slice(0, 200) });
check('③b 落账 by=owner / channel=ui 不变', String(recOwner.by) === 'owner' && String(recOwner.channel) === 'ui', { record: recOwner });

// ④ 代记分支静态：文案仍由 proxyMode 决定且含「PM 代记」
const opsSrc = fs.readFileSync(path.join(TEAM_ROOT, '工具', 'lib', 'ops.mjs'), 'utf8');
const displayLine = (opsSrc.split(/\r?\n/).find((l) => l.includes('验收${accepted ?') && l.includes('通道')) || '');
check('④ 代管代记分支保留：显示文案由 proxyMode 决定、含「PM 代记」，且按 byRole 区分 PM/测试/Owner',
  displayLine.includes("proxyMode ? 'PM 代记'") && displayLine.includes("byRole === 'pm' ? 'PM'") && displayLine.includes("byRole === 'tester' ? '测试'"),
  { displayLine: displayLine.trim().slice(0, 220) });

// ⑤ 三种入口的落账字段两两不同且与旧值一致
check('⑤ 三种入口落账人互不相同且正确（pm/pm、tester/test、owner/ui）',
  `${recPm.by}/${recPm.channel}` === 'pm/pm' && `${recTs.by}/${recTs.channel}` === 'tester/test' && `${recOwner.by}/${recOwner.channel}` === 'owner/ui',
  { pm: `${recPm.by}/${recPm.channel}`, tester: `${recTs.by}/${recTs.channel}`, owner: `${recOwner.by}/${recOwner.channel}` });

const realAfter = sha(REAL_TEAM_FILE);
check('⑥ 真实 团队.json sha256 不变（沙盘零写入）', Boolean(realBefore) && realBefore === realAfter, { before: realBefore.slice(0, 12), after: realAfter.slice(0, 12) });

const total = results.length;
const pass = results.filter((x) => x.ok).length;
const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-a358');
fs.mkdirSync(evDir, { recursive: true });
const evFile = path.join(evDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${total - pass === 0 ? 'green' : 'red'}.json`);
fs.writeFileSync(evFile, JSON.stringify({ task: 'B-20261117-104829-a358', at: new Date().toISOString(), total, pass, red: total - pass, results }, null, 2) + '\n', 'utf8');
console.log(`\nA358_${total - pass === 0 ? 'OK' : 'RED'} ${JSON.stringify({ total, pass, red: total - pass })}`);
console.log(`证据：${evFile}`);
if (process.env.AWB_KEEP_SANDBOX !== '1') { try { rmSandbox(SB); } catch { /* ignore */ } }
