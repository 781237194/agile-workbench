#!/usr/bin/env node
'use strict';
/**
 * test-d751-roster-sync.cjs —— B-20261121-034044-d751（P0）
 * DSH 离线/会话列表为空/只回一部分时，syncRoster 必须「读不到就什么都不写」；名册不得被清空。
 *
 * 覆盖（AC③④）：
 *  A 核心单源：syncRosterSessions(空 map) 不清空任何 sessionId
 *  B 空 map（DSH 不可达/空列表）→ ROSTER_SYNC_SKIPPED + 团队.json 字节不变 + 审计 syncRoster_skipped{reason:expected:got}
 *  C DSH 只回 2 条 → skipped insufficient_sessions，原 6 个 sessionId 原样保留
 *  D 非法 id → skipped invalid_session_ids，文件不变
 *  E 6 条合法 → 正常写（changed=6、ratio=1），审计 source=team-tools/syncRoster
 *  F 再跑一次同值 → ROSTER_UNCHANGED（不重复写审计）
 *  G 并发两个进程各写 6 条 → 名册最终 6/6 合法、无空值、无坏 JSON
 *  H 真实状态零写入：本夹具只动 `_tmp` 沙盘（退出清理）
 *
 * 用法：node scripts/test-d751-roster-sync.cjs [--json]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');
const CHILD = process.argv.includes('--child');
const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT && !CHILD) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 600)}`);
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];

function seed(root) {
  const state = path.join(root, '状态');
  fs.mkdirSync(state, { recursive: true });
  const team = {
    name: 'd751 沙盘',
    activeProject: '工作台改造修复',
    members: ROLES.map((role) => ({ role, name: role, status: 'active', archived: false, sessionId: 'session-d751-' + role })),
  };
  fs.writeFileSync(path.join(state, '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  return { teamFile: path.join(state, '团队.json'), auditFile: path.join(state, '项目', '工作台改造修复', '名册变更.jsonl') };
}
function readAudit(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

if (CHILD) {
  // 并发子进程：只做一次 syncRoster（6 条合法），退出码 0=ROSTER_SYNCED/UNCHANGED。
  const sb = process.env.D751_SANDBOX;
  process.env.TEAM_ROOT = path.join(sb, '团队');
  process.env.TEAM_PROJECTS_ROOT = path.join(sb, '项目区');
  process.env.AWB_STORE = path.join(sb, 'workbench.json');
  const tools = require(path.join(ROOT, 'src', 'team-tools.js'));
  const sessions = Object.fromEntries(ROLES.map((role) => [role, 'session-d751-' + role]));
  const result = tools.syncRoster('工作台改造修复', sessions);
  process.exit(result && result.ok ? 0 : 1);
}

function moduleSandbox() {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'd751-'));
  // 目录名必须是「团队」：writeJsonAtomic 的允许路径按 `团队/状态/` 字面校验（真实布局同形）。
  const root = path.join(sb, '团队');
  const projects = path.join(sb, '项目区');
  fs.mkdirSync(projects, { recursive: true });
  const files = seed(root);
  process.env.TEAM_ROOT = root;
  process.env.TEAM_PROJECTS_ROOT = projects;
  process.env.AWB_STORE = path.join(sb, 'workbench.json');
  process.env.TEAM_SELFTEST = '1';
  fs.writeFileSync(process.env.AWB_STORE, JSON.stringify({ version: 1, projects: [], ui: {} }), 'utf8');
  const tools = require(path.join(ROOT, 'src', 'team-tools.js'));
  return { sb, root, files, tools };
}

(async () => {
  // A 核心单源：空 map 不清
  const rosterApply = require(path.join(ROOT, '团队', '工具', 'lib', 'roster-apply.cjs'));
  const team = { members: ROLES.map((role) => ({ role, sessionId: 'session-d751-' + role })) };
  const coreOut = rosterApply.syncRosterSessions(team, {}, { roleIds: ROLES });
  check('A 核心：syncRosterSessions(空 map) 不清空任何 sessionId',
    coreOut.changed === 0 && team.members.every((m) => String(m.sessionId || '').startsWith('session-d751-')), { coreOut, members: team.members });

  const { sb, files, tools } = moduleSandbox();
  try {
    check('0 沙盘就绪且真实状态未被引用', files.teamFile.includes(sb) && process.env.TEAM_ROOT.startsWith(sb), { teamFile: files.teamFile });
    const full = Object.fromEntries(ROLES.map((role) => [role, 'session-d751-' + role]));

    // B 空 map
    const beforeB = sha(fs.readFileSync(files.teamFile));
    const rB = tools.syncRoster('工作台改造修复', {});
    const afterB = sha(fs.readFileSync(files.teamFile));
    check('B DSH 空列表 → ROSTER_SYNC_SKIPPED(dsh_empty_or_unreachable) 且团队.json 字节不变',
      rB && rB.skipped === true && rB.code === 'ROSTER_SYNC_SKIPPED' && rB.reason === 'dsh_empty_or_unreachable'
      && rB.expected === 6 && rB.got === 0 && beforeB === afterB,
      { rB, same: beforeB === afterB, expected: 6 });
    const auditB = readAudit(files.auditFile).filter((r) => r.source === 'team-tools/syncRoster_skipped');
    check('B2 审计有 syncRoster_skipped{reason,expected,got}', auditB.length >= 1 && auditB[auditB.length - 1].reason === 'dsh_empty_or_unreachable'
      && auditB[auditB.length - 1].expected === 6 && auditB[auditB.length - 1].got === 0, { auditB });

    // C 只回 2 条
    const beforeC = sha(fs.readFileSync(files.teamFile));
    const rC = tools.syncRoster('工作台改造修复', { pm: full.pm, product: full.product });
    const afterC = sha(fs.readFileSync(files.teamFile));
    check('C DSH 只回 2 条 → skipped insufficient_sessions 且文件不变、6 个原值保留',
      rC && rC.code === 'ROSTER_SYNC_SKIPPED' && rC.reason === 'insufficient_sessions' && rC.got === 2 && beforeC === afterC,
      { rC, same: beforeC === afterC });
    const onDiskC = JSON.parse(fs.readFileSync(files.teamFile, 'utf8'));
    check('C2 6 个 sessionId 仍非空', onDiskC.members.filter((m) => String(m.sessionId || '').trim()).length === 6, { members: onDiskC.members });

    // D 非法 id
    const beforeD = sha(fs.readFileSync(files.teamFile));
    const bad = { ...full, tester: 'not-a-session-id' };
    const rD = tools.syncRoster('工作台改造修复', bad);
    const afterD = sha(fs.readFileSync(files.teamFile));
    check('D 非法 id → skipped invalid_session_ids 且文件不变',
      rD && rD.code === 'ROSTER_SYNC_SKIPPED' && rD.reason === 'invalid_session_ids' && beforeD === afterD, { rD, same: beforeD === afterD });

    // E 6 条合法：先把名册改成不同值，再同步
    const changedTeam = JSON.parse(fs.readFileSync(files.teamFile, 'utf8'));
    changedTeam.members.forEach((m) => { m.sessionId = ''; });
    fs.writeFileSync(files.teamFile, JSON.stringify(changedTeam, null, 2) + '\n', 'utf8');
    const beforeE = sha(fs.readFileSync(files.teamFile));
    const rE = tools.syncRoster('工作台改造修复', full);
    const afterE = sha(fs.readFileSync(files.teamFile));
    const onDiskE = JSON.parse(fs.readFileSync(files.teamFile, 'utf8'));
    check('E 6 条合法 → ROSTER_SYNCED changed=6 ratio=1、落盘 6/6',
      rE && rE.code === 'ROSTER_SYNCED' && rE.changed === 6 && rE.ratio === 1 && beforeE !== afterE
      && onDiskE.members.filter((m) => String(m.sessionId || '').trim()).length === 6, { rE, members: onDiskE.members });
    const auditE = readAudit(files.auditFile).filter((r) => r.source === 'team-tools/syncRoster');
    check('E2 审计 source=team-tools/syncRoster changed=6', auditE.length >= 1 && auditE[auditE.length - 1].changed === 6, { auditE });

    // F 幂等
    const beforeF = sha(fs.readFileSync(files.teamFile));
    const rF = tools.syncRoster('工作台改造修复', full);
    const afterF = sha(fs.readFileSync(files.teamFile));
    check('F 同值重跑 → ROSTER_UNCHANGED 且不写盘', rF && rF.code === 'ROSTER_UNCHANGED' && beforeF === afterF, { rF, same: beforeF === afterF });

    // G 并发两进程
    const runs = [0, 1].map(() => new Promise((resolve) => {
      const child = spawn(process.execPath, [__filename, '--child'], { env: { ...process.env, D751_SANDBOX: sb }, stdio: 'ignore' });
      child.on('close', (code) => resolve(code));
    }));
    const codes = await Promise.all(runs);
    const onDiskG = JSON.parse(fs.readFileSync(files.teamFile, 'utf8'));
    const filledG = onDiskG.members.filter((m) => /^session-/.test(String(m.sessionId || ''))).length;
    check('G 并发两个进程 → 退出码均 0、名册最终 6/6 合法', codes.every((c) => c === 0) && filledG === 6, { codes, filledG, members: onDiskG.members });

    // H 审计中绝不出现空 sessionId 的清空记录
    const allAudit = readAudit(files.auditFile);
    const clearRows = allAudit.filter((r) => Array.isArray(r.cleared) && r.cleared.length > 0);
    check('H 审计无「清空名册」记录（cleared 恒空）', clearRows.length === 0, { clearRows });
  } finally {
    try { fs.rmSync(sb, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const failed = ROWS.filter((r) => !r.ok).length;
  if (JSON_OUT) console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed, failed: ROWS.filter((r) => !r.ok).map((r) => r.name), rows: ROWS }, null, 2));
  else console.log(`\n${ROWS.length - failed}/${ROWS.length} PASS${failed ? ' · ' + failed + ' FAIL' : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FIXTURE_FAILED', String((e && e.stack) || e)); process.exit(2); });
