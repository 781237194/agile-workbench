#!/usr/bin/env node
'use strict';
/**
 * test-cdd0-rotate-boot-gate.cjs —— B-20261118-001244-cdd0 回归夹具
 *
 * 缺陷：`session rotate` 不校验启动令牌——任意角色/空令牌都能换任意角色会话（实测空令牌把 tester
 * session-582fdd5f 换成 session-001cffa9）。根因：session.mjs cmdSession 只有 archive 分支调 requireBoot，
 * rotate 分支没有。
 *
 * 断言（AC1-AC4）：
 *   AC1 空/bogus 令牌 rotate → BOOT_REQUIRED / BOOT_INVALID，且零副作用（团队.json / 会话轮换记录 /
 *       收件箱归档 / workbench 全不变）；
 *   AC2 非 pm/owner 令牌（tester）→ PERMISSION_DENIED，零副作用；
 *   AC3 真 pm 令牌 rotate 成功、四处映射 6/6、记录落盘；随后 bogus 再试仍被拒且映射不变；
 *   AC4 有 pm 令牌时 --dry-run 仍零写入。
 *
 * 隔离：mkTempSandbox；TEAM_ROOT / TEAM_PROJECTS_ROOT / TEAM_WORKBENCH_JSON 全指向沙盘；
 *       TEAM_SELFTEST=1（不驱动 DSH）+ TEAM_BOOT_ENFORCE=1（沙盘默认豁免门禁，本夹具要验门禁本体）。
 *       另用「清空 TEAM_SELFTEST」的两次调用证明生产环境（无沙盘变量）同样被拦（这两次都在写盘前失败，不碰沙盘外状态）。
 *
 * 用法：node scripts/test-cdd0-rotate-boot-gate.cjs
 * 退出码：0 全过 / 1 有断言失败 / 2 环境错误
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const SB = mkTempSandbox('cdd0');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const TEAM_TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const PROJECT = 'rotate门禁沙盘';

let passed = 0;
const failures = [];
const records = [];
function check(name, ok, detail) {
  records.push({ name, ok, detail: ok ? '' : detail });
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 300)}`);
}
function env(extra = {}) {
  return {
    ...process.env,
    TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: PROJECTS,
    TEAM_WORKBENCH_JSON: STORE,
    TEAM_SELFTEST: '1',
    TEAM_BOOT_ENFORCE: '1',
    ...extra,
  };
}
function run(args, extraEnv = {}) {
  try {
    const out = execFileSync(process.execPath, [TEAM_TOOL, ...args], { encoding: 'utf8', env: env(extraEnv), timeout: 120000, cwd: SB });
    return { code: 0, out: String(out), err: '' };
  } catch (error) {
    return { code: error.status == null ? 1 : error.status, out: String(error.stdout || ''), err: String(error.stderr || '') };
  }
}
function runJson(args, extraEnv = {}) {
  const r = run(args, extraEnv);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}
const text = (r) => String(r.out || '') + String(r.err || '');
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : '(missing)');

/** 递归快照：只收文件（rel → sha），用于「零副作用」断言。 */
function snapshot(root) {
  const map = {};
  const walk = (dir, depth) => {
    if (depth > 8 || !fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p, depth + 1);
      else if (ent.isFile()) map[path.relative(SB, p).replace(/\\/g, '/')] = sha(p);
    }
  };
  walk(root, 0);
  return map;
}
function diffSnapshot(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed = [];
  for (const k of keys) if (a[k] !== b[k]) changed.push(`${k}${a[k] ? '' : '(新增)'}${b[k] ? '' : '(删除)'}`);
  return changed;
}
function readWorkbench() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return null; }
}

if (!fs.existsSync(TEAM_TOOL)) { console.error('环境错误：找不到 team.mjs'); process.exit(2); }

// ── 沙盘骨架
fs.mkdirSync(PROJECTS, { recursive: true });
fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
const teamSrc = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8'));
for (const m of teamSrc.members || []) { m.sessionId = ''; }
teamSrc.activeProject = PROJECT;
fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(teamSrc, null, 2) + '\n', 'utf8');
for (const rel of ['团队宪法.md', '项目铁律.md']) {
  const src = path.join(ROOT, '团队', rel);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TEAM, rel));
}
const protoSrc = path.join(ROOT, '团队', '协议');
if (fs.existsSync(protoSrc)) fs.cpSync(protoSrc, path.join(TEAM, '协议'), { recursive: true });
fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(TEAM, '工具'), { recursive: true });

const addProject = runJson(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
check('S0 沙盘项目登记', addProject.code === 0, { code: addProject.code, out: text(addProject).slice(0, 300) });

const stateDir = path.join(TEAM, '状态', '项目', PROJECT);
const teamFile = path.join(TEAM, '状态', '团队.json');
const projectFile = path.join(stateDir, '项目.json');
const manifestFile = path.join(PROJECTS, PROJECT, '团队会话.json');
const rotateDir = path.join(stateDir, '会话轮换');

// ── 预置「四处映射一致 6/6」夹具（团队.json / 团队会话.json / workbench.sessions / workspace.sessionIds）
const projJson = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
const sessRoles = Array.isArray(projJson.roleIds) && projJson.roleIds.length ? projJson.roleIds : ['pm', 'analyst', 'programmer1', 'programmer2'];
const oldId = (role) => `session-st-old-${role}`;
const seedTeam = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
seedTeam.activeProject = PROJECT;
for (const role of sessRoles) {
  let m = (seedTeam.members || []).find((x) => x && x.role === role);
  if (!m) { m = { role, name: role, status: 'active', joinedAt: new Date().toISOString() }; seedTeam.members.push(m); }
  m.sessionId = oldId(role);
}
fs.writeFileSync(teamFile, JSON.stringify(seedTeam, null, 2) + '\n', 'utf8');
fs.writeFileSync(manifestFile, JSON.stringify({
  project: PROJECT, teamMode: 'full', workspace: path.join(PROJECTS, PROJECT), workspaceId: 'st-cdd0-ws',
  generatedAt: new Date().toISOString(),
  roles: sessRoles.map((role) => ({ role, name: role, title: `团队·${role}`, sessionId: oldId(role), reused: false, model: '' })),
}, null, 2) + '\n', 'utf8');
fs.writeFileSync(STORE, JSON.stringify({
  version: 1,
  activeProjectId: 'st-cdd0-p1',
  projects: [{
    id: 'st-cdd0-p1', name: PROJECT, path: path.join(PROJECTS, PROJECT), teamMode: 'full',
    sessions: Object.fromEntries(sessRoles.map((r) => [r, oldId(r)])),
    workspace: { sessionIds: sessRoles.map((r) => oldId(r)) },
  }],
}, null, 2) + '\n', 'utf8');
const check0 = runJson(['session', 'check', '--project', PROJECT, '--json']);
check('S2 预置四处映射一致 6/6', check0.code === 0 && String((check0.json && check0.json.ratio) || '') === '6/6', { code: check0.code, ratio: check0.json && check0.json.ratio, rows: check0.json && check0.json.rows });

// ── AC1：空 / 空白 / bogus 令牌 → BOOT_REQUIRED / BOOT_INVALID，零副作用
const before1 = snapshot(path.join(TEAM, '状态'));
const emptyBoot = run(['session', 'rotate', '--project', PROJECT, '--role', 'tester', '--session', 's-should-not-land', '--offline', '--reason', '空令牌']);
check('AC1① rotate 不带 --boot → BOOT_REQUIRED', emptyBoot.code !== 0 && /BOOT_REQUIRED/.test(text(emptyBoot)), { code: emptyBoot.code, out: text(emptyBoot).slice(0, 300) });
const blankBoot = run(['session', 'rotate', '--project', PROJECT, '--role', 'tester', '--session', 's-should-not-land', '--offline', '--boot', '   ']);
check('AC1② rotate --boot 空白 → BOOT_REQUIRED', blankBoot.code !== 0 && /BOOT_REQUIRED/.test(text(blankBoot)), { code: blankBoot.code, out: text(blankBoot).slice(0, 300) });
const bogusBoot = run(['session', 'rotate', '--project', PROJECT, '--role', 'tester', '--session', 's-should-not-land', '--offline', '--boot', 'bogus123']);
check('AC1③ rotate --boot bogus123 → BOOT_INVALID', bogusBoot.code !== 0 && /BOOT_INVALID/.test(text(bogusBoot)), { code: bogusBoot.code, out: text(bogusBoot).slice(0, 300) });
const after1 = snapshot(path.join(TEAM, '状态'));
const drift1 = diffSnapshot(before1, after1);
check('AC1④ 三次拒收零副作用（团队.json / 轮换记录 / 邮箱 / 工作流全不变）', drift1.length === 0, { drift: drift1.slice(0, 10) });
check('AC1⑤ 未生成会话轮换记录', !fs.existsSync(path.join(rotateDir, 'tester.json')), null);

// AC1⑥：生产口径（清空 TEAM_SELFTEST，无沙盘变量）同样被拦（两次都在写盘前失败）
const prodEmpty = run(['session', 'rotate', '--project', PROJECT, '--role', 'tester', '--session', 's-x', '--offline'], { TEAM_SELFTEST: '', TEAM_BOOT_ENFORCE: '' });
check('AC1⑥ 生产口径（无 TEAM_SELFTEST）无令牌 → BOOT_REQUIRED', prodEmpty.code !== 0 && /BOOT_REQUIRED/.test(text(prodEmpty)), { code: prodEmpty.code, out: text(prodEmpty).slice(0, 300) });
const prodBogus = run(['session', 'rotate', '--project', PROJECT, '--role', 'tester', '--session', 's-x', '--offline', '--boot', 'bogus999'], { TEAM_SELFTEST: '', TEAM_BOOT_ENFORCE: '' });
check('AC1⑦ 生产口径 bogus 令牌 → BOOT_INVALID', prodBogus.code !== 0 && /BOOT_INVALID/.test(text(prodBogus)), { code: prodBogus.code, out: text(prodBogus).slice(0, 300) });

// ── 取 pm 与 tester 令牌
const bootPm = runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm-cdd0', '--json']);
const bootTe = runJson(['boot', '--role', 'tester', '--project', PROJECT, '--session', 's-te-cdd0', '--json']);
const PM = String((bootPm.json && bootPm.json.token) || '');
const TE = String((bootTe.json && bootTe.json.token) || '');
check('S1 取到 pm / tester 令牌', bootPm.code === 0 && bootTe.code === 0 && Boolean(PM) && Boolean(TE), { pm: bootPm.code, te: bootTe.code });

// ── AC2：非 pm/owner 令牌 → PERMISSION_DENIED，零副作用
const before2 = snapshot(path.join(TEAM, '状态'));
const testerRotate = runJson(['session', 'rotate', '--boot', TE, '--project', PROJECT, '--role', 'tester', '--session', 's-by-tester', '--offline', '--json']);
const after2 = snapshot(path.join(TEAM, '状态'));
const drift2 = diffSnapshot(before2, after2);
check('AC2① tester 令牌 rotate → PERMISSION_DENIED', testerRotate.code !== 0 && /PERMISSION_DENIED/.test(text(testerRotate)), { code: testerRotate.code, out: text(testerRotate).slice(0, 300) });
check('AC2② 拒收零副作用', drift2.length === 0, { drift: drift2.slice(0, 10) });
check('AC2③ 错误详情带令牌角色（tokenRole=tester）', /tokenRole/.test(text(testerRotate)), { out: text(testerRotate).slice(0, 300) });

// ── AC4：pm 令牌 + --dry-run → 正常预演、零写入
const before3 = snapshot(path.join(TEAM, '状态'));
const dryRun = runJson(['session', 'rotate', '--boot', PM, '--project', PROJECT, '--role', 'tester', '--session', 's-dry', '--offline', '--dry-run', '--json']);
const after3 = snapshot(path.join(TEAM, '状态'));
const drift3 = diffSnapshot(before3, after3);
check('AC4① pm 令牌 + --dry-run 正常返回 dryRun=true', dryRun.code === 0 && dryRun.json && dryRun.json.dryRun === true, { code: dryRun.code, out: text(dryRun).slice(0, 300) });
check('AC4② --dry-run 零写入', drift3.length === 0, { drift: drift3.slice(0, 10) });

// ── AC3：真 pm 令牌 rotate 成功，四处映射切换 + 6/6 + 记录落盘
const NEW_SID = 'session-st-cdd0-new';
const rot = runJson(['session', 'rotate', '--boot', PM, '--project', PROJECT, '--role', 'tester', '--session', NEW_SID, '--offline', '--reason', 'cdd0 沙盘轮换', '--json']);
check('AC3① pm 令牌 rotate 成功', rot.code === 0 && rot.json && rot.json.ok === true, { code: rot.code, out: text(rot).slice(0, 400) });
const rotRecord = rot.json && rot.json.record ? rot.json.record : (rot.json || {});
check('AC3② 返回目标会话 = 新 id', String(rotRecord.to || '') === NEW_SID, { to: rotRecord.to });
check('AC3③ 一致性 6/6', String((rotRecord.consistency && rotRecord.consistency.ratio) || '') === '6/6', { consistency: rotRecord.consistency });
const teamAfter = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
const testerMember = (teamAfter.members || []).find((m) => m.role === 'tester') || {};
check('AC3④ 团队.json 名册 tester 指向新会话', String(testerMember.sessionId || '') === NEW_SID, { teamTester: testerMember.sessionId });
const manifestAfter = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const manifestTester = (manifestAfter.roles || []).find((r) => r && r.role === 'tester') || {};
check('AC3⑤ 团队会话.json 映射指向新会话', String(manifestTester.sessionId || '') === NEW_SID, { manifest: manifestTester.sessionId });
const wb = readWorkbench();
const wbProj = wb && (wb.projects || []).find((p) => p && (p.name === PROJECT || String(p.path || '').endsWith(PROJECT)));
check('AC3⑥ workbench projects[].sessions 指向新会话', Boolean(wbProj) && String((wbProj.sessions || {}).tester || '') === NEW_SID, { wb: wbProj && wbProj.sessions });
check('AC3⑦ workbench projects[].workspace.sessionIds 含新会话', Boolean(wbProj && wbProj.workspace && (wbProj.workspace.sessionIds || []).includes(NEW_SID)), { ids: wbProj && wbProj.workspace && wbProj.workspace.sessionIds });
const recFile = path.join(rotateDir, 'tester.json');
const rec = fs.existsSync(recFile) ? JSON.parse(fs.readFileSync(recFile, 'utf8')) : null;
check('AC3⑧ 会话轮换记录落盘（to=新会话）', Boolean(rec) && String(rec.to || '') === NEW_SID, { rec: rec && { from: rec.from, to: rec.to } });

// 成功后再用 bogus 试 → 仍被拒且映射不变（防「先成功一次就绕过」）
const before4 = snapshot(path.join(TEAM, '状态'));
const bogusAfter = run(['session', 'rotate', '--project', PROJECT, '--role', 'tester', '--session', 's-overwrite-attempt', '--offline', '--boot', 'bogus456']);
const after4 = snapshot(path.join(TEAM, '状态'));
check('AC3⑨ 成功后再用 bogus 令牌 → 仍 BOOT_INVALID', bogusAfter.code !== 0 && /BOOT_INVALID/.test(text(bogusAfter)), { code: bogusAfter.code, out: text(bogusAfter).slice(0, 300) });
const drift4 = diffSnapshot(before4, after4);
check('AC3⑩ 该拒收零副作用（映射仍指向上次成功的新会话）', drift4.length === 0
  && String(((JSON.parse(fs.readFileSync(manifestFile, 'utf8')).roles || []).find((r) => r && r.role === 'tester') || {}).sessionId || '') === NEW_SID,
  { drift: drift4.slice(0, 10) });

const total = passed + failures.length;
console.log(`\nB-cdd0 断言：${passed}/${total} PASS${failures.length ? `，${failures.length} 待修` : ''}`);
const evidDir = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-cdd0');
fs.mkdirSync(evidDir, { recursive: true });
fs.writeFileSync(path.join(evidDir, 'run-cdd0.json'), JSON.stringify({ at: new Date().toISOString(), sandbox: SB, project: PROJECT, passed, total, results: records }, null, 2) + '\n', 'utf8');
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
process.exit(0);
