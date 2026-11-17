/**
 * T-20261117-215159-ae1e 夹具：bcae AC3（盘点门槛）/ AC4（四条件判定）/ AC8（新 PM 首次 boot 提示 + sessionId 去重）。
 *
 * 断言：
 *   I1 无盘点文件 → SKILL_INVENTORY_REQUIRED；
 *   I2 只写 2 条四列齐全 → 仍 REQUIRED；
 *   I3 写 3 条但 1 条「判据」空 → 仍 REQUIRED（空单元格不计）；
 *   I4 3 条齐全 + 缺四条件参数 → SKILL_CONDITION_ARGS_REQUIRED；
 *   I5 3 条齐全 + testable=false 且无 --reason → SKIP_REASON_REQUIRED；带 reason → skip 且落审计；
 *   I6 3 条齐全 + 四条件全 true → build，生成 <角色>/skill/<kebab>.md（五节）并更新 00-索引.md；
 *   I7 PM 首次 boot（会话 A）含 [data-skill-pm-notice]；同会话二次 boot 不重复；换会话 B 再提示。
 *
 * 跑法：node scripts/test-bcae-ac348.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');

const ROOT = (() => {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, '团队', '工具', 'team.mjs'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('找不到仓库根');
})();
const PROJECT = '沙盘bcae3';
const SB = path.join(ROOT, '_tmp', `rbca348-${process.pid}`);
const SB_TEAM = path.join(SB, '团队');
const SB_PROJECTS = path.join(SB, '项目');
const PROJ_DIR = path.join(SB_PROJECTS, PROJECT);
const OUT_DIR = path.join(PROJ_DIR, '程序员A', '产出');
const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, error: String((e && e.message) || e) });
    console.log(`FAIL  ${name}\n      ${String((e && e.message) || e).split('\n')[0]}`);
  }
}
const env = () => ({ ...process.env, TEAM_ROOT: SB_TEAM, TEAM_PROJECTS_ROOT: SB_PROJECTS, TEAM_SELFTEST: '1' });
function cli(args) {
  try {
    const out = execFileSync(process.execPath, [path.join(SB_TEAM, '工具', 'team.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 180000, env: env() });
    return { ok: true, out: String(out) };
  } catch (e) {
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || ''), status: e.status };
  }
}
const has = (r, s) => r.out.includes(s);

// 沙盘
fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(path.join(SB_TEAM, '状态'), { recursive: true });
fs.mkdirSync(SB_PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(SB_TEAM, '工具'), { recursive: true });
fs.cpSync(path.join(ROOT, '团队', 'skill'), path.join(SB_TEAM, 'skill'), { recursive: true });
for (const f of ['团队宪法.md', '项目铁律.md']) {
  const src = path.join(ROOT, '团队', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SB_TEAM, f));
}
const team = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8'));
for (const m of team.members || []) { m.sessionId = ''; m.archivedSession = ''; m.replacedBySessionId = ''; m.sessionPrevSessionId = ''; }
delete team.activeProject;
fs.writeFileSync(path.join(SB_TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2));
assert.ok(cli(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).ok, '沙盘 project add 失败');
fs.mkdirSync(path.join(OUT_DIR), { recursive: true });
const boot = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-a348-p1']);
const token = (String(boot.out).match(/令牌:\s*([0-9a-f]+)/) || [])[1];
assert.ok(token, `沙盘 boot 失败：${boot.out.slice(0, 300)}`);
const invFile = path.join(OUT_DIR, 'skill盘点-20261117.md');
const row = (a, b, c, d) => `| ${a} | ${b} | ${c} | ${d} |`;
const table = (rows) => ['# skill 盘点', '', '| 触发场景 | 步骤 | 判据 | 反例 |', '|---|---|---|---|', ...rows, ''].join('\n');
const buildArgs = (extra = []) => ['skill', 'build', '--role', 'programmer1', '--project', PROJECT, '--boot', token, '--name', 'sandbox-isolation', ...extra];

check('I1 无盘点 → SKILL_INVENTORY_REQUIRED', () => {
  const r = cli(buildArgs(['--repeatable', 'true', '--steps', 'true', '--testable', 'true', '--costly', 'true']));
  assert.ok(!r.ok && has(r, 'SKILL_INVENTORY_REQUIRED'), r.out.slice(0, 300));
  return 'REQUIRED';
});

check('I2 只写 2 条 → 仍 REQUIRED', () => {
  fs.writeFileSync(invFile, table([row('A', '1. a', 'x', 'y'), row('B', '1. b', 'x', 'y')]), 'utf8');
  const r = cli(buildArgs(['--repeatable', 'true', '--steps', 'true', '--testable', 'true', '--costly', 'true']));
  assert.ok(!r.ok && has(r, 'SKILL_INVENTORY_REQUIRED'), r.out.slice(0, 300));
  return 'REQUIRED（2 条）';
});

check('I3 3 条但 1 条判据为空 → 仍 REQUIRED', () => {
  fs.writeFileSync(invFile, table([row('A', '1. a', 'x', 'y'), row('B', '1. b', '', 'y'), row('C', '1. c', 'x', 'y')]), 'utf8');
  const r = cli(buildArgs(['--repeatable', 'true', '--steps', 'true', '--testable', 'true', '--costly', 'true']));
  assert.ok(!r.ok && has(r, 'SKILL_INVENTORY_REQUIRED'), r.out.slice(0, 300));
  return 'REQUIRED（空单元格）';
});

check('I4 3 条齐全但缺四条件参数 → SKILL_CONDITION_ARGS_REQUIRED', () => {
  fs.writeFileSync(invFile, table([row('A', '1. a', 'x', 'y'), row('B', '1. b', 'x', 'y'), row('C', '1. c', 'x', 'y')]), 'utf8');
  const r = cli(buildArgs(['--repeatable', 'true']));
  assert.ok(!r.ok && has(r, 'SKILL_CONDITION_ARGS_REQUIRED'), r.out.slice(0, 300));
  return 'ARGS_REQUIRED';
});

check('I5 testable=false 无 reason → SKIP_REASON_REQUIRED；带 reason → skip', () => {
  const bad = cli(buildArgs(['--repeatable', 'true', '--steps', 'true', '--testable', 'false', '--costly', 'true']));
  assert.ok(!bad.ok && has(bad, 'SKIP_REASON_REQUIRED'), bad.out.slice(0, 300));
  const good = cli(buildArgs(['--repeatable', 'true', '--steps', 'true', '--testable', 'false', '--costly', 'true', '--reason', '判据不可复跑，先记经验教训']));
  assert.ok(good.ok && /跳过建 skill/.test(good.out), good.out.slice(0, 300));
  const audit = fs.readFileSync(path.join(SB_TEAM, '状态', '项目', PROJECT, '技能提示.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
  assert.ok(audit.some((a) => a.action === 'skip' && /判据不可复跑/.test(a.reason)), JSON.stringify(audit.slice(-2)));
  return 'skip + 审计';
});

check('I6 四条件全 true → build 生成 skill 五节 + 索引', () => {
  const r = cli(buildArgs(['--repeatable', 'true', '--steps', 'true', '--testable', 'true', '--costly', 'true', '--scenario', '沙盘互脏时', '--criteria', '隔离变量断言', '--counter', '污染真实邮箱']));
  assert.ok(r.ok && /已建 skill/.test(r.out), r.out.slice(0, 300));
  const file = path.join(PROJ_DIR, '程序员A', 'skill', 'sandbox-isolation.md');
  assert.ok(fs.existsSync(file), 'skill 文件没生成');
  const text = fs.readFileSync(file, 'utf8');
  for (const sec of ['## 适用场景', '## 步骤', '## 判据', '## 反例', '## 不适用范围']) assert.ok(text.includes(sec), `缺 ${sec}`);
  const idx = fs.readFileSync(path.join(PROJ_DIR, '程序员A', 'skill', '00-索引.md'), 'utf8');
  assert.ok(/sandbox-isolation/.test(idx), '索引未更新');
  return 'build + 五节 + 索引';
});

check('I7 PM 首次 boot 提示（data-skill-pm-notice）；同会话不重复；换会话再提示', () => {
  const pmA1 = cli(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-a348-pmA']);
  assert.ok(typeof pmA1.out === 'string', `pmA1.out 类型异常：${JSON.stringify(pmA1).slice(0, 300)}`);
  assert.ok(has(pmA1, 'data-skill-pm-notice') && /Owner 批准版本，不可更改/.test(pmA1.out), pmA1.out.slice(0, 400));
  const pmA2 = cli(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-a348-pmA']);
  assert.ok(!has(pmA2, 'data-skill-pm-notice'), '同会话二次 boot 仍提示（未去重）');
  const pmB = cli(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-a348-pmB']);
  assert.ok(has(pmB, 'data-skill-pm-notice'), '换会话后未再提示');
  return '首次提示 / 同会话去重 / 换会话再提示';
});

fs.rmSync(SB, { recursive: true, force: true });
const pass = results.filter((r) => r.ok).length;
console.log(`\nBCAE_AC348 ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
if (pass !== results.length) process.exit(1);
