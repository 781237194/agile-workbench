#!/usr/bin/env node
'use strict';
/**
 * test-d751-roster-no-wipe.cjs —— B-20261121-034044-d751（P0）PM 035907 指定夹具
 *
 * 判据：DSH 读不到/只读回一部分时，名册必须「一个字节都不动」；只有拿到完整值才写。
 * ① 空 map（DSH 不可达/空列表）→ 团队.json 字节不变 + 审计 syncRoster_skipped{reason,expected,got}
 * ② 正常 6 条 → 写入并落盘 6/6（changed=6、ratio=1）
 * ③ 只回 2 条 → 其余 4 条原值不动、文件不变
 * ④ store 有值 + DSH 不可达（空 map）→ 团队.json 与 store 都不写不改
 * ⑤ 并发两次（两个进程同值）→ 只有一次成功写盘，审计只有 1 行 changed>0
 * ⑥ 真实状态零写入：真实 团队/状态/团队.json 前后 sha 相同（夹具只碰 _tmp 沙盘）
 * ⑦ 复核补：项目切到四人模式（项目.json.roleIds=4）→ 4 个目标角色写入，2 个非目标角色走显式清理（clearedRoles），不误清其他人
 *
 * 用法：node scripts/test-d751-roster-no-wipe.cjs [--json]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');
const CHILD = process.argv.includes('--child');
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT && !CHILD) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 600)}`);
}
const shaBuf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const shaFile = (file) => { try { return shaBuf(fs.readFileSync(file)); } catch { return 'MISSING'; } };

function seedProject(state, projectName, roleIds) {
  const dir = path.join(state, '项目', projectName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '项目.json'), JSON.stringify({ name: projectName, roleIds }, null, 2) + '\n', 'utf8');
  return path.join(dir, '名册变更.jsonl');
}
function readAudit(file) {
  try { return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

if (CHILD) {
  const sb = process.env.D751_SANDBOX;
  process.env.TEAM_ROOT = path.join(sb, '团队');
  process.env.TEAM_PROJECTS_ROOT = path.join(sb, '项目区');
  process.env.AWB_STORE = path.join(sb, 'store', 'workbench.json');
  process.env.TEAM_SELFTEST = '1';
  const tools = require(path.join(ROOT, 'src', 'team-tools.js'));
  const sessions = Object.fromEntries(ROLES.map((role) => [role, 'session-d751-' + role]));
  const result = tools.syncRoster(process.env.D751_PROJECT, sessions);
  process.exit(result && result.ok ? 0 : 1);
}

function sandbox() {
  const sandboxGuard = require(path.join(ROOT, 'scripts', 'sandbox-guard.cjs'));
  const sb = fs.mkdtempSync(path.join(sandboxGuard.sandboxTmp(), 'd751nowipe-'));
  const root = path.join(sb, '团队');
  const projects = path.join(sb, '项目区');
  const store = path.join(sb, 'store');
  fs.mkdirSync(path.join(root, '状态'), { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(store, { recursive: true });
  const projectName = '工作台改造修复';
  const team = { name: 'd751 沙盘', activeProject: projectName, members: ROLES.map((role) => ({ role, name: role, status: 'active', archived: false, sessionId: 'session-old-' + role })) };
  const teamFile = path.join(root, '状态', '团队.json');
  fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
  const storeFile = path.join(store, 'workbench.json');
  fs.writeFileSync(storeFile, JSON.stringify({ version: 1, projects: [{ id: 'P1', sessions: Object.fromEntries(ROLES.map((role) => [role, 'session-old-' + role])) }], ui: {} }, null, 2) + '\n', 'utf8');
  const auditFile = seedProject(path.join(root, '状态'), projectName, ROLES);
  process.env.TEAM_ROOT = root;
  process.env.TEAM_PROJECTS_ROOT = projects;
  process.env.AWB_STORE = storeFile;
  process.env.TEAM_SELFTEST = '1';
  const tools = require(path.join(ROOT, 'src', 'team-tools.js'));
  return { sb, root, teamFile, storeFile, auditFile, projectName, tools };
}

(async () => {
  const realBefore = shaFile(REAL_TEAM);
  const { sb, teamFile, storeFile, auditFile, projectName, tools } = sandbox();
  const full = Object.fromEntries(ROLES.map((role) => [role, 'session-d751-' + role]));
  try {
    // ① 空 map
    const b1 = shaFile(teamFile);
    const r1 = tools.syncRoster(projectName, {});
    check('① 空 map → ROSTER_SYNC_SKIPPED 且团队.json 字节不变',
      r1 && r1.code === 'ROSTER_SYNC_SKIPPED' && r1.reason === 'dsh_empty_or_unreachable' && shaFile(teamFile) === b1,
      { r1, same: shaFile(teamFile) === b1 });
    const auditSkip = readAudit(auditFile).filter((r) => r.source === 'team-tools/syncRoster_skipped');
    check('①b 审计 syncRoster_skipped{reason,expected,got}', auditSkip.length === 1 && auditSkip[0].expected === 6 && auditSkip[0].got === 0, { auditSkip });

    // ② 正常 6 条
    const r2 = tools.syncRoster(projectName, full);
    const disk2 = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
    check('② 正常 6 条 → ROSTER_SYNCED changed=6 ratio=1，落盘 6/6',
      r2 && r2.code === 'ROSTER_SYNCED' && r2.changed === 6 && r2.ratio === 1
      && disk2.members.filter((m) => String(m.sessionId || '').startsWith('session-d751-')).length === 6,
      { r2, members: disk2.members });

    // ③ 只回 2 条：先把名册改回 old 值，再发部分
    const t3 = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
    t3.members.forEach((m) => { m.sessionId = 'session-old-' + m.role; });
    fs.writeFileSync(teamFile, JSON.stringify(t3, null, 2) + '\n', 'utf8');
    const b3 = shaFile(teamFile);
    const r3 = tools.syncRoster(projectName, { pm: 'session-new-pm', product: 'session-new-product' });
    const disk3 = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
    check('③ 只回 2 条 → insufficient_sessions、文件不变、4 个非返回角色原值保留',
      r3 && r3.code === 'ROSTER_SYNC_SKIPPED' && r3.reason === 'insufficient_sessions' && shaFile(teamFile) === b3
      && ROLES.filter((r) => r !== 'pm' && r !== 'product').every((r) => disk3.members.find((m) => m.role === r).sessionId === 'session-old-' + r),
      { r3, same: shaFile(teamFile) === b3 });

    // ④ store 有值 + DSH 不可达（空 map）
    const t4 = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
    t4.members.forEach((m) => { m.sessionId = 'session-store-' + m.role; });
    fs.writeFileSync(teamFile, JSON.stringify(t4, null, 2) + '\n', 'utf8');
    const b4team = shaFile(teamFile);
    const b4store = shaFile(storeFile);
    const r4 = tools.syncRoster(projectName, {});
    check('④ store 有值 + DSH 不可达 → 团队.json 与 store 都不写不改',
      r4 && r4.code === 'ROSTER_SYNC_SKIPPED' && shaFile(teamFile) === b4team && shaFile(storeFile) === b4store,
      { r4, teamSame: shaFile(teamFile) === b4team, storeSame: shaFile(storeFile) === b4store });

    // ⑤ 并发两次（同值）
    const auditBeforeConcurrent = readAudit(auditFile).filter((r) => r.source === 'team-tools/syncRoster' && r.changed > 0).length;
    const codes = await Promise.all([0, 1].map(() => new Promise((resolve) => {
      const child = spawn(process.execPath, [__filename, '--child'], { env: { ...process.env, D751_SANDBOX: sb, D751_PROJECT: projectName }, stdio: 'ignore' });
      child.on('close', (code) => resolve(code));
    })));
    const auditWrites = readAudit(auditFile).filter((r) => r.source === 'team-tools/syncRoster' && r.changed > 0).length - auditBeforeConcurrent;
    const disk5 = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
    check('⑤ 并发两次 → 均退出 0、只成功写 1 次、最终 6/6',
      codes.every((c) => c === 0) && auditWrites === 1 && disk5.members.every((m) => String(m.sessionId || '').startsWith('session-d751-')),
      { codes, auditWrites, members: disk5.members });

    // ⑦ 项目切到四人模式：目标 4 角色写入，另 2 角色显式清理
    seedProject(path.join(sb, '团队', '状态'), '四人项目', ['pm', 'product', 'programmer1', 'tester']);
    const t7 = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
    t7.members.forEach((m) => { m.sessionId = 'session-old-' + m.role; });
    fs.writeFileSync(teamFile, JSON.stringify(t7, null, 2) + '\n', 'utf8');
    const four = { pm: 'session-new-pm', product: 'session-new-product', programmer1: 'session-new-p1', tester: 'session-new-tester' };
    const r7 = tools.syncRoster('四人项目', four);
    const disk7 = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
    const byRole = Object.fromEntries(disk7.members.map((m) => [m.role, m.sessionId || '']));
    check('⑦ 切四人项目 → 4 个目标角色写入、2 个非目标角色显式清理（clearedRoles）',
      r7 && r7.ok === true && r7.clearedRoles && r7.clearedRoles.length === 2
      && byRole.pm === 'session-new-pm' && byRole.product === 'session-new-product'
      && byRole.programmer1 === 'session-new-p1' && byRole.tester === 'session-new-tester'
      && byRole.analyst === '' && byRole.programmer2 === '',
      { r7, byRole });

    // ⑥ 真实状态零写入
    check('⑥ 真实 团队/状态/团队.json 前后 sha 相同（夹具只在 _tmp 沙盘内）', shaFile(REAL_TEAM) === realBefore, { before: realBefore, after: shaFile(REAL_TEAM) });
  } finally {
    try { fs.rmSync(sb, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const failed = ROWS.filter((r) => !r.ok).length;
  if (JSON_OUT) console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed, failed: ROWS.filter((r) => !r.ok).map((r) => r.name), rows: ROWS }, null, 2));
  else console.log(`\n${ROWS.length - failed}/${ROWS.length} PASS${failed ? ' · ' + failed + ' FAIL' : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FIXTURE_FAILED', String((e && e.stack) || e)); process.exit(2); });
