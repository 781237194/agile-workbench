#!/usr/bin/env node
'use strict';
/**
 * test-6c6b-brief-truncate.cjs —— B-20261118-004424-6c6b 回归夹具
 *
 * 缺陷：boot 简报超 2000 字时按尾部截断，把「可选插件 / 记忆降级 / 队列续跑」这类关键行切掉，
 * selftest「记忆插件 off → boot 降级」用例因此红。
 * 修法：关键行上移到核心区；超限时先丢可丢行（任务/提案/未读明细/授权），丢完仍超才尾部截断（标记必留）。
 *
 * 断言：
 *   AC1 沙盘构造 >2000 字简报 → boot 输出仍含 `记忆降级:` 与 `可选插件:`；
 *   AC2 截断行为保留：总长 ≤ 2000、末尾含「…（简报超限截断）」、briefingMeta.dropped>0；
 *   AC3 composeBriefing 单测（不超限原样、超限丢可丢行、核心也超才硬截断、非法输入不抛）；
 *   AC4 极端：可丢行全丢光仍超限 → truncated=true 且仍 ≤2000、标记在末尾。
 *
 * 隔离：mkTempSandbox；复制工作树 团队/（跳过快照锁/邮箱），TEAM_ROOT/TEAM_PROJECTS_ROOT/TEAM_WORKBENCH_JSON 全指向沙盘。
 * 用法：node scripts/test-6c6b-brief-truncate.cjs
 * 退出码：0 全过 / 1 有断言失败 / 2 环境错误
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const SB = mkTempSandbox('6c6b');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const TOOL = path.join(TEAM, '工具', 'team.mjs');
const PROJECT = '简报截断沙盘';
const MARK = '…（简报超限截断）';

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
  return { ...process.env, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE, TEAM_SELFTEST: '1', ...extra };
}
function run(args, extraEnv = {}) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(extraEnv), timeout: 120000, cwd: SB });
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

if (!fs.existsSync(path.join(ROOT, '团队', '工具', 'team.mjs'))) { console.error('环境错误：找不到 team.mjs'); process.exit(2); }

// ── 沙盘：复制工作树 团队/（跳过快照锁与邮箱，避免复制在途文件）
fs.cpSync(path.join(ROOT, '团队'), TEAM, {
  recursive: true,
  filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) && !/[\\/]邮箱([\\/]|$)/.test(src),
});
const teamFile = path.join(TEAM, '状态', '团队.json');
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
for (const m of team.members || []) { m.sessionId = ''; }
team.activeProject = PROJECT;
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
const addProject = runJson(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
check('S0 沙盘项目登记', addProject.code === 0, { code: addProject.code, out: text(addProject).slice(0, 300) });

// ── AC3：composeBriefing 单测（直接 import 沙盘里的 ops.mjs）
process.env.TEAM_ROOT = TEAM;
process.env.TEAM_PROJECTS_ROOT = PROJECTS;
process.env.TEAM_SELFTEST = '1';
(async () => {
  const mod = await import(pathToFileURL(path.join(TEAM, '工具', 'lib', 'ops.mjs')).href);
  const compose = mod.composeBriefing;
  check('AC3① ops.mjs 导出 composeBriefing（可单测）', typeof compose === 'function', typeof compose);

  const keyLines = ['=== 简报 ===', '可选插件: memory:off（非核心，缺了不阻断）', '记忆降级: memory:off —— P0 记忆门降级为 MEMORY_SKIPPED', '队列自动续跑: 已派 M-1 → programmer1'];
  const core = [...keyLines, '必读-核心已读 3/3: 团队宪法 项目信息 角色卡', '下一步: 先读 inbox'];
  const dropLines = ['  [T-1] P1 open pm 任务（长标题）', '  [M-1] pm (要回执): 未读消息（长标题）', '授权: write@项目:全部'];
  const dropSet = new Set([core.length, core.length + 1, core.length + 2]);
  const small = compose(core, new Set(), 2000);
  check('AC3② 不超限：原样返回、无标记、dropped=0',
    small.text === core.join('\n') && small.dropped === 0 && small.truncated === false, small);
  const overDrop = compose(core.concat(dropLines), dropSet, 200);
  check('AC3③ 超限但可丢行够：关键行仍在、丢可丢行、末尾有标记、≤200',
    overDrop.text.length <= 200 && overDrop.text.includes('记忆降级') && overDrop.text.includes('可选插件')
      && overDrop.text.trimEnd().endsWith(MARK) && overDrop.dropped > 0 && overDrop.truncated === false,
    { len: overDrop.text.length, dropped: overDrop.dropped, truncated: overDrop.truncated });
  const hard = compose(core.map((l) => l + 'x'.repeat(80)), new Set(), 200);
  check('AC3④ 核心本身超限：硬截断 truncated=true、≤200、标记在末尾',
    hard.text.length <= 200 && hard.truncated === true && hard.text.trimEnd().endsWith(MARK), { len: hard.text.length, truncated: hard.truncated });
  const weird = compose(['a'], null, undefined);
  check('AC3⑤ 非法入参不抛（droppable=null / maxChars=undefined）', Boolean(weird) && typeof weird.text === 'string', weird);

  // ── AC1/AC2：构造 >2000 字真实简报（长任务标题 + 长消息标题 + 记忆 off）
  const bootPm = runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm-6c6b', '--json']);
  const PM = String((bootPm.json && bootPm.json.token) || '');
  const bootDev = runJson(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-dev-6c6b', '--json']);
  const DEV = String((bootDev.json && bootDev.json.token) || '');
  check('S1 取到 pm / programmer1 令牌', bootPm.code === 0 && bootDev.code === 0 && Boolean(PM) && Boolean(DEV), { pm: bootPm.code, dev: bootDev.code });

  // 造 >2000：需求 + 1 条绑定任务的「增补卷」×6（每行 ~90 字，核心区必留）+ 3 条未读明文（可丢区）
  const reqRes = runJson(['req', 'create', '--boot', PM, '--project', PROJECT, '--title', '简报注入需求', '--priority', 'P1', '--acceptance', 'AC', '--json']);
  const reqId = String((reqRes.json && reqRes.json.requirement && reqRes.json.requirement.id) || '');
  const shortKey = (/([0-9a-z]{4})$/i.exec(reqId) || [])[1] || '';
  check('S2 需求创建成功（取短号）', reqRes.code === 0 && /^R-/.test(reqId) && Boolean(shortKey), { code: reqRes.code, reqId, out: text(reqRes).slice(0, 200) });
  const demandDir = path.join(PROJECTS, PROJECT, '需求');
  fs.mkdirSync(demandDir, { recursive: true });
  for (let i = 1; i <= 6; i += 1) {
    fs.writeFileSync(path.join(demandDir, `增补卷-${shortKey}-${i}.md`), `# 增补卷 ${i}\n${'外置章节'.repeat(20)}\n`, 'utf8');
  }
  const taskRes = runJson(['task', 'create', '--boot', PM, '--project', PROJECT, '--title', '长简报注入任务', '--priority', 'P1', '--owner', 'pm', '--requirement', reqId, '--json']);
  check('S3 绑定需求的任务创建成功', taskRes.code === 0, { code: taskRes.code, out: text(taskRes).slice(0, 300) });
  const longSubject = '长消息标题'.repeat(100); // store 侧按 80 字截断
  const sendRes = [];
  for (let i = 0; i < 3; i += 1) {
    sendRes.push(runJson(['send', '--boot', DEV, '--project', PROJECT, '--to', 'pm', '--subject', `${longSubject}${i}`, '--body', 'x', '--json']));
  }
  check('S4 注入 3 条未读消息成功', sendRes.every((r) => r.code === 0 && r.json && r.json.ok !== false), sendRes.map((r) => ({ code: r.code, out: text(r).slice(0, 160) })));
  const pluginsOff = path.join(SB, 'plugins-off');
  fs.mkdirSync(pluginsOff, { recursive: true });
  const dshOff = path.join(SB, 'dsh-home-off');
  const bootLong = runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm-long', '--json'], {
    TEAM_PLUGINS_HOME: pluginsOff, DSH_HOME: dshOff,
  });
  const briefing = String((bootLong.json && bootLong.json.briefing) || '');
  const meta = (bootLong.json && bootLong.json.briefingMeta) || {};
  check('AC1① briefingMeta 证明原文超限（dropped>0 或 truncated=true）', Number(meta.dropped) > 0 || meta.truncated === true, meta);
  check('AC1② 超限处理后仍含「可选插件:」行', briefing.includes('可选插件:'), { has: briefing.includes('可选插件:') });
  check('AC1③ 超限处理后仍含「记忆降级:」行（记忆插件 off）', briefing.includes('记忆降级:'), { has: briefing.includes('记忆降级:') });
  check('AC2① 总长 ≤ 2000', briefing.length <= 2000, { len: briefing.length });
  check('AC2② 末尾有「…（简报超限截断）」标记', briefing.trimEnd().endsWith(MARK), { tail: briefing.slice(-40) });
  check('AC2③ 确实先丢可丢行（dropped>0）', Number(meta.dropped) > 0, meta);
  const unreadDetailCount = briefing.split('\n').filter((l) => /^\s+\[M-/.test(l)).length;
  check('AC2④ 可丢明细被丢（未读明细行 < 3，或发生硬截断）', unreadDetailCount < 3 || meta.truncated === true, { unreadDetailCount, truncated: meta.truncated });

  const total = passed + failures.length;
  console.log(`\nB-6c6b 断言：${passed}/${total} PASS${failures.length ? `，${failures.length} 待修` : ''}`);
  const evidDir = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-6c6b');
  fs.mkdirSync(evidDir, { recursive: true });
  fs.writeFileSync(path.join(evidDir, 'run-6c6b.json'), JSON.stringify({
    at: new Date().toISOString(), sandbox: SB, project: PROJECT, briefingLen: briefing.length, meta, passed, total, results: records,
  }, null, 2) + '\n', 'utf8');
  if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
  process.exit(0);
})().catch((error) => {
  console.error('RUN_FAILED', (error && error.stack) || error);
  process.exit(1);
});
