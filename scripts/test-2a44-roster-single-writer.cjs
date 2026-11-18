#!/usr/bin/env node
'use strict';
/**
 * B-20261118-164055-2a44（P2）：壳层名册 sessionId 直写绕过 roster-writer —— 修复后夹具。
 *
 * 背景（A 卷 v2 补报）：名册唯一写入口是 `团队/工具/lib/roster-writer.mjs`（applyMemberSession 等），
 * 但它是 ESM，Electron 33（Node 20）的 CJS 主进程无法 require(ESM)，于是壳层各自直写：
 *   `src/main.js:828/8252`、`src/team-tools.js:1019/1026`。修法＝把赋值/入册/写前校验抽到 CJS 单源
 *   `团队/工具/lib/roster-apply.cjs`（roster-writer.mjs 反过来 re-export 它），壳层 require 同一份。
 *
 * 断言：
 *   A1 单源存在：roster-apply.cjs 导出 applyMemberSession/setMemberSession/pushRosterMember/validateSessionId/syncRosterSessions/clearRosterSessions
 *   A2 roster-writer.mjs re-export 的是同一批函数（`===` 同一引用，防复制粘贴漂移）
 *   A3 壳层不再直写：`src/main.js`/`src/team-tools.js` 里 `member.sessionId =` 0 处（注释除外；沙盘测试路径 main.js:19054 已由 PM 裁定不算，本夹具用「排除该行」精确口径）
 *   A4 壳层不再自建入册：`src/main.js`/`src/team-tools.js` 里 `team.members.push(` 0 处（注释除外）
 *   A5 写前校验：非法形态 / 旧副本（session-auto-*）→ 拒绝且名册保持原值（syncRosterSessions 返回 rejected）
 *   A6 旧副本拒绝码＝LEGACY_SESSION_ID_REFUSED；空值=清空（合法）
 *   A7 删项目清名册：只清 doomed 里的会话，别人的不动
 *   A8 审计：appendRosterAudit 在沙盘 TEAM_ROOT 下写 名册变更.jsonl（append-only，含 source/rejected）
 *   A9 main.js / team-tools.js 接线：两处都调用单源函数（grep 断言，防回退）
 *
 * 跑法：node scripts/test-2a44-roster-single-writer.cjs
 * 产出：AWB_2A44_OUT（默认 程序员A/产出/证据-2a44/run-2a44.json）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const EVID = process.env.AWB_2A44_OUT ? path.resolve(process.env.AWB_2A44_OUT) : path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-2a44');
const CORE = path.join(ROOT, '团队', '工具', 'lib', 'roster-apply.cjs');
const WRITER = path.join(ROOT, '团队', '工具', 'lib', 'roster-writer.mjs');
const MAIN = path.join(ROOT, 'src', 'main.js');
const TOOLS = path.join(ROOT, 'src', 'team-tools.js');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 400)}`);
}
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return ''; } };
const readText = (p) => fs.readFileSync(p, 'utf8');
const rosterApply = require(CORE);

/* 隔离基线：本夹具只在 _tmp 沙盘写审计，真实状态零写入 */
const realTeamFile = path.join(ROOT, '团队', '状态', '团队.json');
const realStoreFile = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const beforeReal = { team: sha(realTeamFile), store: sha(realStoreFile) };

const SB = path.join(ROOT, '_tmp', `2a44-${process.pid}-${Date.now().toString(36)}`);
const sbTeam = path.join(SB, '团队');
fs.mkdirSync(path.join(sbTeam, '状态', '项目'), { recursive: true });
fs.writeFileSync(path.join(sbTeam, '状态', '团队.json'), JSON.stringify({ members: [] }, null, 2) + '\n', 'utf8');

/* A1 单源导出 */
{
  const need = ['applyMemberSession', 'setMemberSession', 'pushRosterMember', 'validateSessionId', 'syncRosterSessions', 'clearRosterSessions'];
  const missing = need.filter((k) => typeof rosterApply[k] !== 'function');
  check('A1 roster-apply.cjs 提供全部单源函数', missing.length === 0, { missing });
}

/* A2 roster-writer re-export 同一引用（异步 import ESM） */
(async () => {
  const writer = await import(`file:///${WRITER.replace(/\\/g, '/')}`);
  check('A2 roster-writer.mjs re-export 的是 roster-apply 的同一批函数（===，防复制粘贴漂移）',
    writer.applyMemberSession === rosterApply.applyMemberSession
    && writer.pushRosterMember === rosterApply.pushRosterMember
    && writer.isLegacySessionId === rosterApply.isLegacySessionId
    && writer.validateSessionId === rosterApply.validateSessionId
    && writer.SESSION_ID_RE.source === rosterApply.SESSION_ID_RE.source,
    {
      apply: writer.applyMemberSession === rosterApply.applyMemberSession,
      push: writer.pushRosterMember === rosterApply.pushRosterMember,
      legacy: writer.isLegacySessionId === rosterApply.isLegacySessionId,
      validate: writer.validateSessionId === rosterApply.validateSessionId,
    });

  /* A3/A4 壳层不再直写（按行判定：去掉注释行；沙盘测试路径 main.js:19054 精确排除） */
  const codeLines = (file) => readText(file).split(/\r?\n/)
    .map((text, i) => ({ text, no: i + 1 }))
    .filter(({ text }) => !/^\s*(\/\/|\*|\/\*)/.test(text)); // 去掉整行注释
  const directRosterWrites = [];
  for (const file of [MAIN, TOOLS]) {
    for (const { text, no } of codeLines(file)) {
      if (/member\.sessionId\s*=(?!=)/.test(text)) {
        if (file === MAIN && no === 19054) continue; // PM 裁定：沙盘测试路径（assertSandboxStatePath 守卫）不算
        directRosterWrites.push({ file: path.basename(file), line: no, text: text.trim().slice(0, 90) });
      }
    }
  }
  check('A3 壳层不再直写名册 sessionId（注释与沙盘测试路径除外）', directRosterWrites.length === 0, { hits: directRosterWrites });

  const directPush = [];
  for (const file of [MAIN, TOOLS]) {
    for (const { text, no } of codeLines(file)) {
      if (/members\.push\s*\(/.test(text)) directPush.push({ file: path.basename(file), line: no, text: text.trim().slice(0, 90) });
    }
  }
  check('A4 壳层不再自建入册（team.members.push 0 处）', directPush.length === 0, { hits: directPush });

  /* A9 接线：两处都调单源 */
  check('A9 壳层接线：main.js 调 teamTools.applyRosterFromSessions / clearRosterSessionsOf，team-tools.js 调 rosterApplyCore.syncRosterSessions',
    /applyRosterFromSessions/.test(readText(MAIN)) && /clearRosterSessionsOf/.test(readText(MAIN))
    && /rosterApplyCore\.syncRosterSessions/.test(readText(TOOLS)) && /rosterApplyCore\.pushRosterMember/.test(readText(TOOLS)),
    { mainApply: /applyRosterFromSessions/.test(readText(MAIN)), toolsSync: /rosterApplyCore\.syncRosterSessions/.test(readText(TOOLS)) });

  /* A5/A6 写前校验 */
  {
    const team = { activeProject: 'A', members: [{ role: 'pm', sessionId: 'session-old' }] };
    const r1 = rosterApply.syncRosterSessions(team, { pm: 'session-auto-tester-mwlcwzs8' }, { activeProject: 'A' });
    const r2 = rosterApply.syncRosterSessions(team, { pm: 'bad id with space' }, { activeProject: 'A' });
    const afterRejects = team.members[0].sessionId; // 两次被拒后名册必须仍是原值（下面 r3 会清空，需先取快照）
    const r3 = rosterApply.syncRosterSessions(team, { pm: '' }, { activeProject: 'A' });
    check('A5 非法/旧副本 id 被拒且名册保持原值（不静默写坏）',
      afterRejects === 'session-old'
      && r1.rejected.length === 1 && r1.rejected[0].code === 'LEGACY_SESSION_ID_REFUSED'
      && r2.rejected.length === 1 && r2.rejected[0].code === 'SESSION_ID_INVALID'
      && r1.changed === 0 && r2.changed === 0,
      { r1, r2, afterRejects });
    check('A6 空值=清空（合法）：sessionId 从 session-old 清成空串并计 changed',
      r3.changed === 1 && team.members[0].sessionId === '', { r3, now: team.members[0].sessionId });
    check('A6b validateSessionId 三态：合法/旧副本/坏形态',
      rosterApply.validateSessionId('session-abc-1').ok === true
      && rosterApply.validateSessionId('session-auto-tester-x1').code === 'LEGACY_SESSION_ID_REFUSED'
      && rosterApply.validateSessionId('not-a-session').code === 'SESSION_ID_INVALID',
      {});
  }

  /* A7 删项目清名册只清 doomed */
  {
    const team = { activeProject: 'P1', members: [
      { role: 'pm', sessionId: 'session-a' },
      { role: 'tester', sessionId: 'session-b' },
      { role: 'analyst', sessionId: 'session-c' },
    ] };
    const out = rosterApply.clearRosterSessions(team, new Set(['session-a', 'session-c']), { activeProject: 'P1' });
    check('A7 删项目清名册：只清 doomed（a/c），别人的会话保留、activeProject 清空',
      out.changed === 2
      && team.members[0].sessionId === '' && team.members[1].sessionId === 'session-b' && team.members[2].sessionId === ''
      && team.activeProject === null,
      { out, members: team.members.map((m) => ({ role: m.role, sessionId: m.sessionId })), activeProject: team.activeProject });
  }

  /* A8 审计：appendRosterAudit 落到沙盘 TEAM_ROOT（真实状态零写入） */
  {
    const tools = require(TOOLS);
    const oldRoot = process.env.TEAM_ROOT;
    process.env.TEAM_ROOT = sbTeam;
    let okWrite = false;
    try { okWrite = tools.appendRosterAudit('沙盘项目A', { source: 'test/2a44', rejected: [{ role: 'pm', code: 'LEGACY_SESSION_ID_REFUSED' }] }); }
    finally { if (oldRoot === undefined) delete process.env.TEAM_ROOT; else process.env.TEAM_ROOT = oldRoot; }
    const auditFile = path.join(sbTeam, '状态', '项目', '沙盘项目A', '名册变更.jsonl');
    const rows = fs.existsSync(auditFile) ? readText(auditFile).trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
    check('A8 审计：名册变更.jsonl append-only，行内含 by=shell/项目/来源/拒绝明细',
      okWrite === true && rows.length === 1 && rows[0].by === 'shell' && rows[0].source === 'test/2a44'
      && rows[0].project === '沙盘项目A'
      && Array.isArray(rows[0].rejected) && rows[0].rejected[0].code === 'LEGACY_SESSION_ID_REFUSED',
      { okWrite, rows });
  }

  /* 隔离断言 */
  check('A10 隔离：真实 团队/状态/团队.json 与 data/userdata/workbench.json 前后 sha256 不变',
    sha(realTeamFile) === beforeReal.team && sha(realStoreFile) === beforeReal.store && Boolean(beforeReal.team),
    { before: beforeReal, after: { team: sha(realTeamFile), store: sha(realStoreFile) } });

  try { fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
  fs.mkdirSync(EVID, { recursive: true });
  const report = {
    task: 'B-20261118-164055-2a44', at: new Date().toISOString(),
    total: passed + failures.length, pass: passed, red: failures.length, failures,
  };
  const outFile = path.join(EVID, 'run-2a44.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\nROSTER_SINGLE_WRITER ${failures.length === 0 ? 'OK' : 'FAIL'} ${JSON.stringify({ total: report.total, pass: report.pass, red: report.red })}`);
  console.log('证据：' + outFile);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(1); });
