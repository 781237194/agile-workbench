#!/usr/bin/env node
const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * R-20261116-104535-1dfb（P0）自检：真实活跃度看板取数 —— 三源取值 / 未知态 / 生成物排除 / 5 分钟缓存
 *
 * 覆盖（对照派单 F8 + 正文 AC5 + 增补卷 §五/§六/§十三）：
 *   ① 三源取值逐项与手工构造值相等：
 *        commitAt = 提交/*.json 中 author===<roleId> 的 createdAt 最大值
 *        fileAt   = 角色目录内文件 max mtime（排除 文件索引.md / 项目索引*.md / *.jsonl / _backup/** / _tmp/** / 派单*）
 *        wakeAt   = 唤醒.jsonl 中 to===<roleId> && ok===true 的最后 at
 *   ② 未知态：三源全缺 → verdict=unknown 且 unknownReasons 含 no-submit-record/no-write-in-window/no-wake-ok
 *      （缺哪项给哪项）；unknown 不得被判 idle
 *   ③ 缓存：src/team-tools.js 的 roleActivity(project) 连续两次第二次 cached===true 且 roles 逐字段相等；force:true → cached===false
 *   ④ 生成物刷新不改变「最近文件写入」：只 touch 文件索引.md 与 *.jsonl → fileAt 不变
 *
 * 沙盘：_tmp/1dfb-role-activity-sandbox 下独立 团队/ + 项目/<P>/；TEAM_ROOT/TEAM_PROJECTS_ROOT 指它、TEAM_SELFTEST=1、
 *       名册 sessionId 全空（B-3c03）；GIT_CEILING_DIRECTORIES 指沙盘根（活跃度取数不碰真实仓库 git）。
 *       ⚠ src/team-tools.js 在 require 时读 TEAM_ROOT 定根，因此 env 必须先设、后 require。
 *
 * 跑法：node scripts/test-role-activity.cjs
 * 退出码：0 = 全 PASS；1 = 有 FAIL（日志 ./项目/工作台改造修复/程序员A/产出/证据-1dfb/test-role-activity.log）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SB = path.join(REPO, '_tmp', '1dfb-role-activity-sandbox');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(TEAM, '状态', '项目');
const PROJ = '1dfb-act';
const STATE = path.join(PROJECTS, PROJ);
const PDIR = path.join(SB, '项目', PROJ);
const MAIL = path.join(TEAM, '状态', '邮箱');
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const ROLE_DIRS = { pm: '项目经理', product: '产品', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' };
const ROLE_NAMES = { pm: '项目经理', product: '产品设计师', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' };

// ── env 必须在 require('src/team-tools.js') 之前 ───────────────────────────
process.env.TEAM_ROOT = TEAM;
process.env.TEAM_PROJECTS_ROOT = PROJECTS;
process.env.TEAM_SELFTEST = '1';
process.env.GIT_CEILING_DIRECTORIES = SB;

const outLines = [];
const log = (line) => { outLines.push(String(line)); console.log(String(line)); };
let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; log(`PASS  ${name}`); return true; }
  fail += 1;
  const d = detail === undefined ? '' : JSON.stringify(detail).slice(0, 700);
  failures.push({ name, detail: d });
  log(`FAIL  ${name}  ${d}`);
  return false;
}

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n', 'utf8'); };
const writeFile = (f, text = 'x\n') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text, 'utf8'); };
const touchAt = (f, ms) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'fixture\n', 'utf8'); const d = new Date(ms); fs.utimesSync(f, d, d); };
const statIso = (f) => new Date(fs.statSync(f).mtimeMs).toISOString();

// ── 沙盘 seed ─────────────────────────────────────────────────────────────
rmSandbox(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
fs.mkdirSync(path.join(STATE, '任务'), { recursive: true });
fs.mkdirSync(path.join(STATE, '提交'), { recursive: true });
for (const role of ROLES) {
  fs.mkdirSync(path.join(MAIL, role, 'new'), { recursive: true });
  fs.mkdirSync(path.join(MAIL, role, 'cur'), { recursive: true });
  fs.mkdirSync(path.join(PDIR, ROLE_DIRS[role], '产出'), { recursive: true });
}
writeJson(path.join(TEAM, '状态', '团队.json'), {
  version: 2, phase: 'team', activeProject: PROJ,
  members: ROLES.map((role) => ({ role, name: ROLE_NAMES[role], status: 'active', sessionId: '' })),
  config: { messageMaxChars: 600, ackNoteMaxChars: 300, codeMaxBytes: 65536 },
});
writeJson(path.join(STATE, '项目.json'), { name: PROJ, mode: 'full', path: PDIR, teamMode: 'full', roleIds: ROLES });
writeJson(path.join(STATE, '工作流.json'), { requirements: {} });
fs.writeFileSync(path.join(TEAM, '状态', '回执.jsonl'), '', 'utf8');

// ① 提交记录（作者字段是 author、时间是 createdAt；无 createdBy/at）
const COMMIT1 = NOW - 120000;
const COMMIT2 = NOW - 60000;
writeJson(path.join(STATE, '提交', 'C-1dfb-c1.json'), { id: 'C-1dfb-c1', project: PROJ, author: 'programmer1', createdAt: iso(COMMIT1), before: '', after: '' });
writeJson(path.join(STATE, '提交', 'C-1dfb-c2.json'), { id: 'C-1dfb-c2', project: PROJ, author: 'programmer2', createdAt: iso(COMMIT2), before: '', after: '' });
// ② 角色目录文件（只给 programmer1 一个新点；其它角色留空 → 可断「未知」）
const FILE1 = NOW - 90000;
const file1 = path.join(PDIR, ROLE_DIRS.programmer1, '产出', '说明.md');
touchAt(file1, FILE1);
const EXPECT_FILE_AT = statIso(file1);
// ③ 唤醒.jsonl：programmer1 的最后一条 ok=true 应是较早那条（更晚的 ok=false 不算）
const WAKE1 = NOW - 300000;
const WAKE2 = NOW - 200000;
const WAKE3 = NOW - 100000;
const wakeRows = [
  { at: iso(WAKE1), time: iso(WAKE1), project: PROJ, to: 'programmer1', ok: true, skipped: 'SELFTEST' },
  { at: iso(WAKE2), time: iso(WAKE2), project: PROJ, to: 'programmer1', ok: false, why: '夹具失败行' },
  { at: iso(WAKE3), time: iso(WAKE3), project: PROJ, to: 'tester', ok: true, skipped: 'SELFTEST' },
];
fs.writeFileSync(path.join(STATE, '唤醒.jsonl'), wakeRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
// 角色任务夹具：analyst 有 open 旧任务（让 verdict 有确定值，避免全 unknown 干扰）
writeJson(path.join(STATE, '任务', 'T-1dfb-act-1.json'), {
  id: 'T-1dfb-act-1', project: PROJ, type: 'task', title: '沙盘任务', owner: 'analyst', status: 'open',
  priority: 'P2', requirementId: '', createdAt: iso(NOW - 600000), updatedAt: iso(NOW - 600000),
});

async function main() {
  const opsUrl = 'file:///' + path.join(REPO, '团队', '工具', 'lib', 'ops.mjs').replace(/\\/g, '/');
  const ops = await import(opsUrl);
  ok('S0 ops.mjs 导出 computeRoleActivity', typeof ops.computeRoleActivity === 'function', {});
  if (typeof ops.computeRoleActivity !== 'function') return;

  // ═══════════════ ① 三源取值（逐项与手工构造值相等）═══════════════
  const activity = ops.computeRoleActivity(PROJ, { now: NOW });
  const p1 = (activity.roles || {}).programmer1 || {};
  const p2 = (activity.roles || {}).programmer2 || {};
  const tester = (activity.roles || {}).tester || {};
  ok('① commitAt = 提交/<*.json> 的 author+createdAt 最大值（programmer1）', p1.commitAt === iso(COMMIT1), { got: p1.commitAt, want: iso(COMMIT1) });
  ok('① commitAt 按角色过滤（programmer2 只取自己的提交）', p2.commitAt === iso(COMMIT2), { got: p2.commitAt, want: iso(COMMIT2) });
  ok('① fileAt = 角色目录内文件 max mtime（programmer1）', p1.fileAt === EXPECT_FILE_AT, { got: p1.fileAt, want: EXPECT_FILE_AT });
  ok('① wakeAt = 唤醒.jsonl 中 to===角色 && ok===true 的最后 at（跳过更晚的 ok=false 行）', p1.wakeAt === iso(WAKE1), { got: p1.wakeAt, want: iso(WAKE1) });
  ok('① wakeAt 按角色过滤（tester 取自己的成功行）', tester.wakeAt === iso(WAKE3), { got: tester.wakeAt, want: iso(WAKE3) });
  ok('① 无提交的角色 commitAt 为空串（不猜）', (activity.roles.pm || {}).commitAt === '' && p2.wakeAt === '', { pm: activity.roles.pm, p2wake: p2.wakeAt });

  // ═══════════════ ② 未知态（不得当 idle）═══════════════
  const product = (activity.roles || {}).product || {};
  const expectedAll = ['no-submit-record', 'no-write-in-window', 'no-wake-ok'];
  ok('② 三源全缺 → verdict=unknown', product.verdict === 'unknown', { product });
  ok('② unknownReasons 缺哪项给哪项（三源全缺 → 三条齐全）', JSON.stringify(product.unknownReasons || []) === JSON.stringify(expectedAll), { got: product.unknownReasons, want: expectedAll });
  ok('② unknown 不得被判 idle', product.verdict !== 'idle', { verdict: product.verdict });
  ok('② 部分缺失只报缺的项（tester 只有成功唤醒 → 缺提交/缺写入）', JSON.stringify(tester.unknownReasons || []) === JSON.stringify(['no-submit-record', 'no-write-in-window']), { got: tester.unknownReasons, want: ['no-submit-record', 'no-write-in-window'] });

  // ═══════════════ ③ 排除生成物 / 生成物刷新不改「最近文件写入」═══════════════
  const dir1 = path.join(PDIR, ROLE_DIRS.programmer1);
  touchAt(path.join(dir1, '文件索引.md'), NOW);
  touchAt(path.join(dir1, '项目索引.md'), NOW);
  touchAt(path.join(dir1, '_backup', 'old', 'x.txt'), NOW);
  touchAt(path.join(dir1, '_tmp', 'y.txt'), NOW);
  touchAt(path.join(dir1, '派单投递状态.json'), NOW);
  const afterGenerated = ops.computeRoleActivity(PROJ, { now: NOW });
  ok('③ 生成物（文件索引.md/项目索引.md/_backup/_tmp/派单*）刷新不改变 fileAt', (afterGenerated.roles.programmer1 || {}).fileAt === EXPECT_FILE_AT, { got: (afterGenerated.roles.programmer1 || {}).fileAt, want: EXPECT_FILE_AT });
  // ④ 只 touch 文件索引.md 与某个 *.jsonl → fileAt 不得变（派单明确要求）
  touchAt(path.join(dir1, '审计.jsonl'), NOW);
  const afterTouch = ops.computeRoleActivity(PROJ, { now: NOW });
  ok('④ 只 touch 文件索引.md + *.jsonl → fileAt 不变', (afterTouch.roles.programmer1 || {}).fileAt === EXPECT_FILE_AT, { got: (afterTouch.roles.programmer1 || {}).fileAt, want: EXPECT_FILE_AT });

  // ═══════════════ ④ 缓存（src/team-tools.js 的 roleActivity）═══════════════
  let tt = null;
  try { tt = require(path.join(REPO, 'src', 'team-tools.js')); } catch (e) { tt = null; ok('④ src/team-tools.js 可被纯 node require（TEAM_ROOT 先设）', false, { error: String((e && e.message) || e) }); }
  if (tt && typeof tt.roleActivity === 'function') {
    const r1 = await tt.roleActivity(PROJ);
    const r2 = await tt.roleActivity(PROJ);
    const r3 = await tt.roleActivity(PROJ, { force: true });
    ok('④ roleActivity 返回 ok 且含六角色三源字段', r1 && r1.ok === true && r1.roles && Object.keys(r1.roles).length === ROLES.length, { ok: r1 && r1.ok, roles: r1 && r1.roles && Object.keys(r1.roles) });
    ok('④ 连续调用第二次 cached===true（5 分钟进程内缓存）', r1 && r2 && r1.cached === false && r2.cached === true && r1.ok === true, { r1cached: r1 && r1.cached, r2cached: r2 && r2.cached, r1ok: r1 && r1.ok });
    ok('④ 缓存命中时 roles 与第一次逐字段相等', r1 && r2 && JSON.stringify(r1.roles) === JSON.stringify(r2.roles), { equal: Boolean(r1 && r2 && JSON.stringify(r1.roles) === JSON.stringify(r2.roles)) });
    ok('④ force:true 强制重算 → cached===false', r3 && r3.cached === false && r3.ok === true, { r3cached: r3 && r3.cached, r3ok: r3 && r3.ok });
    const viaIpc = (r1 && r1.roles && (r1.roles.programmer1 || {})) || {};
    ok('④ 壳层 roleActivity 三源值与后端 computeRoleActivity 逐项相等（UI 不自算）', viaIpc.commitAt === iso(COMMIT1) && viaIpc.fileAt === EXPECT_FILE_AT && viaIpc.wakeAt === iso(WAKE1), { viaIpc, want: { commitAt: iso(COMMIT1), fileAt: EXPECT_FILE_AT, wakeAt: iso(WAKE1) } });
  }
}

main()
  .catch((e) => { fail += 1; failures.push({ name: 'UNCAUGHT', detail: String((e && e.stack) || e).slice(0, 400) }); log(`FAIL  UNCAUGHT  ${String((e && e.stack) || e).slice(0, 800)}`); })
  .finally(() => {
    const total = pass + fail;
    const summary = `1dfb 角色活跃度断言：${pass}/${total} PASS`;
    log('');
    log(summary);
    for (const f of failures) log(`  ✗ ${f.name}  ${f.detail}`);
    const evidDir = path.join(REPO, '项目', '工作台改造修复', '程序员A', '产出', '证据-1dfb');
    try {
      fs.mkdirSync(evidDir, { recursive: true });
      fs.writeFileSync(path.join(evidDir, 'test-role-activity.log'), outLines.join('\n') + '\n', 'utf8');
    } catch { /* 证据写失败不影响退出码 */ }
    process.exit(fail ? 1 : 0);
  });
