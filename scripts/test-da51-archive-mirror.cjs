#!/usr/bin/env node
'use strict';
/**
 * B-20261118-040828-da51 夹具：session archive 不再把镜像任务算成未闭环。
 *
 * 判据（PM 2026-11-18 04:08 单）：
 *   ① product 名下 3 个 open 镜像任务（req create 自动建）+ 1 个真 open 任务 → archive 报 TASK_OPEN，
 *      且 details.tasks **只列真任务**（3 个镜像 R-* 不出现）；
 *   ② 真任务 done 后（只剩镜像）→ archive 通过（不再 TASK_OPEN）；
 *   ③ 静态：session-archive.mjs / session.mjs 的未闭环判据同时用 statusIsClosed 与 isRequirementMirrorTask。
 *
 * 隔离：TEAM_ROOT 沙盘 + TEAM_SELFTEST=1，不碰真实状态；跑法 node scripts/test-da51-archive-mirror.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const { mkTempSandbox, rmSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
const SB = mkTempSandbox('da51-archive');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = 'da51归档沙盘';
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
    const text = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    let json = null;
    try { json = JSON.parse(text.slice(text.indexOf('{'))); } catch { json = null; }
    return { status: e.status, human: text, json, err: String((e && e.stderr) || '') };
  }
}
const readTask = (proj, id) => JSON.parse(fs.readFileSync(path.join(TEAM_ROOT, '状态', '项目', proj, '任务', `${id}.json`), 'utf8'));
const writeTask = (proj, id, task) => fs.writeFileSync(path.join(TEAM_ROOT, '状态', '项目', proj, '任务', `${id}.json`), JSON.stringify(task, null, 2) + '\n', 'utf8');

function main() {
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

  const add = runCli(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
  if (!add.json || add.json.ok !== true) throw new Error('project add 失败：' + add.human);
  const boot = (role, session) => {
    const r = runCli(['boot', '--role', role, '--project', PROJECT, '--session', session, '--json']);
    return r.json && r.json.token ? r.json.token : '';
  };
  const pmTok = boot('pm', 'da51-pm');
  const productTok = boot('product', 'da51-product');
  // 3 个需求 → 3 个镜像任务（owner=product, status=open）
  const mirrorIds = [];
  for (let i = 1; i <= 3; i += 1) {
    const r = runCli(['req', 'create', '--boot', productTok, '--project', PROJECT, '--title', `da51 需求${i}`, '--priority', 'P2', '--acceptance', 'AC', '--json']);
    const id = r.json && r.json.requirement && r.json.requirement.id;
    if (!id) throw new Error('req create 失败：' + r.human);
    mirrorIds.push(id);
  }
  // 1 个真 open 任务（owner=product）
  const realCreate = runCli(['task', 'create', '--boot', pmTok, '--project', PROJECT, '--type', 'task', '--title', 'da51 真任务', '--priority', 'P2', '--detail', 'x', '--owner', 'product', '--json']);
  const realId = realCreate.json && realCreate.json.task && realCreate.json.task.id;
  if (!realId) throw new Error('task create 失败：' + realCreate.human);

  // ① 有镜像 + 真任务 → TASK_OPEN 且只列真任务
  const a1 = runCli(['session', 'archive', '--role', 'product', '--project', PROJECT, '--boot', pmTok, '--confirm', '--json']);
  const a1j = a1.json || {};
  const listed = ((a1j.details && a1j.details.tasks) || []).map(String);
  check('① 镜像+真任务：archive 报 TASK_OPEN 且 details.tasks 只列真任务（不含 3 个镜像）',
    String(a1j.code) === 'TASK_OPEN' && listed.includes(realId) && !mirrorIds.some((id) => listed.includes(id)),
    { code: a1j.code, listed, realId, mirrorIds, human: String(a1.human || '').slice(0, 300) });

  // ② 真任务 done（只剩镜像）→ archive 通过
  const realTask = readTask(PROJECT, realId);
  realTask.status = 'done';
  realTask.doneAt = new Date().toISOString();
  writeTask(PROJECT, realId, realTask);
  const a2 = runCli(['session', 'archive', '--role', 'product', '--project', PROJECT, '--boot', pmTok, '--confirm', '--json']);
  const a2j = a2.json || {};
  check('② 只剩镜像：archive 不再 TASK_OPEN（放行归档）',
    String(a2j.code) !== 'TASK_OPEN' && a2j.ok !== false,
    { code: a2j.code, ok: a2j.ok, human: String(a2.human || '').slice(0, 300), err: a2.err });

  // ③ 静态：两处未闭环判据都同时排除镜像 + statusIsClosed
  const saSrc = fs.readFileSync(path.join(ROOT, '团队', '工具', 'lib', 'session-archive.mjs'), 'utf8');
  const seSrc = fs.readFileSync(path.join(ROOT, '团队', '工具', 'lib', 'session.mjs'), 'utf8');
  const saLine = /isRequirementMirrorTask\(t\)\s*&&\s*!statusIsClosed/.test(saSrc) ? 'match' : '';
  const seHit = /isRequirementMirrorTask\(t\)\s*&&\s*!statusIsClosed/.test(seSrc);
  check('③ 静态：session-archive / session 未闭环判据均排除镜像且用 statusIsClosed',
    Boolean(saLine) && seHit,
    { saMatch: Boolean(saLine), seHit });

  const realAfter = sha(REAL_TEAM_FILE);
  check('④ 真实 团队.json sha256 不变（沙盘隔离）', Boolean(realBefore) && realBefore === realAfter, { before: realBefore.slice(0, 12), after: realAfter.slice(0, 12) });

  const total = results.length;
  const pass = results.filter((x) => x.ok).length;
  const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-da51');
  fs.mkdirSync(evDir, { recursive: true });
  const evFile = path.join(evDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${total - pass === 0 ? 'green' : 'red'}.json`);
  fs.writeFileSync(evFile, JSON.stringify({ task: 'B-20261118-040828-da51', at: new Date().toISOString(), total, pass, red: total - pass, results }, null, 2) + '\n', 'utf8');
  console.log(`\nDA51_${total - pass === 0 ? 'OK' : 'RED'} ${JSON.stringify({ total, pass, red: total - pass })}`);
  console.log(`证据：${evFile}`);
  if (process.env.AWB_KEEP_SANDBOX !== '1') { try { rmSandbox(SB); } catch { /* ignore */ } }
}

try { main(); } catch (e) { console.error('CRASH', String((e && e.stack) || e)); process.exit(2); }
