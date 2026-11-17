/**
 * T-20261117-184114-4358 第二步夹具：boot 必读 skill 索引 + 未建提示 + 新 PM 不可更改提示。
 *
 * 沙盘隔离（TEAM_ROOT / TEAM_PROJECTS_ROOT 指 _tmp），断言：
 *   B1 programmer1 boot → 简报「必读-按需已读」含 团队/skill/基础流程/00-索引.md，且出现 skill 已读行；
 *   B2 boot 后核心必读计数仍 3/3（新增 optional 规格不改变原有分层）；
 *   B3 pm boot → 出现「基础流程 skill 为 Owner 批准版本，不可更改」提示；
 *   B4 沙盘删掉 skill 索引 → analyst boot 仍成功（不阻断），且出现「未建 skill（创建路径 …）」提示；
 *   B5 真实团队 bootDocSpecs 里 skillIndex 指向存在的文件（不依赖沙盘）。
 *
 * 跑法：node scripts/test-bcae-skill-boot.cjs
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
const PROJECT = '沙盘技能';
const SB = path.join(ROOT, '_tmp', `skillboot-${process.pid}`);
const SB_TEAM = path.join(SB, '团队');
const SB_PROJECTS = path.join(SB, '项目');

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
function seed() {
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
}
const TM = () => path.join(SB_TEAM, '工具', 'team.mjs');
function cli(args) {
  const env = { ...process.env, TEAM_ROOT: SB_TEAM, TEAM_PROJECTS_ROOT: SB_PROJECTS, TEAM_SELFTEST: '1' };
  try {
    return { ok: true, out: execFileSync(process.execPath, [TM(), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env }) };
  } catch (e) {
    return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}
const bootOf = (out) => String(out || '');

seed();
cli(['project', 'add', '--name', PROJECT, '--team-mode', 'full']);

check('B1 programmer1 boot → 按需已读含 skill 00-索引.md + skill 已读行', () => {
  const r = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-skill-p1']);
  const text = bootOf(r.out);
  assert.ok(r.ok, text.slice(0, 300));
  assert.ok(text.includes('团队/skill/基础流程/00-索引.md'), '按需已读里没有 skill 索引');
  assert.ok(/skill: 索引已读/.test(text), '缺 skill 已读行');
  return 'skill 行 + 按需已读';
});

check('B2 核心必读计数仍 3/3（新增规格不改变分层）', () => {
  const r = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-skill-p1']);
  assert.ok(/必读-核心已读 3\/3/.test(bootOf(r.out)), bootOf(r.out).split('\n').filter((l) => l.includes('必读-核心')).join(' | '));
  return '3/3';
});

check('B3 pm boot → 出现「Owner 批准版本，不可更改」提示', () => {
  const r = cli(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-skill-pm']);
  const text = bootOf(r.out);
  assert.ok(r.ok, text.slice(0, 300));
  assert.ok(/基础流程 skill 为 Owner 批准版本，不可更改/.test(text), '缺新 PM 不可更改提示');
  return '不可更改提示可见';
});

check('B4 删除 skill 索引 → boot 不阻断且提示「未建 skill」', () => {
  fs.rmSync(path.join(SB_TEAM, 'skill', '基础流程', '00-索引.md'), { force: true });
  const r = cli(['boot', '--role', 'analyst', '--project', PROJECT, '--session', 's-skill-an']);
  const text = bootOf(r.out);
  assert.ok(r.ok, text.slice(0, 300));
  assert.ok(/未建 skill/.test(text), '缺未建 skill 提示');
  assert.ok(/创建路径/.test(text), '缺创建路径提示');
  return '未建提示 + boot 成功';
});

check('B5 真实团队 bootDocSpecs 的 skillIndex 指向存在的文件', () => {
  const scaf = path.join(ROOT, '团队', '工具', 'lib', 'scaffold.mjs');
  const text = fs.readFileSync(scaf, 'utf8');
  assert.ok(text.includes("key: 'skillIndex'"), 'bootDocSpecs 缺 skillIndex');
  assert.ok(fs.existsSync(path.join(ROOT, '团队', 'skill', '基础流程', '00-索引.md')));
  return 'skillIndex 已登记';
});

fs.rmSync(SB, { recursive: true, force: true });
const pass = results.filter((r) => r.ok).length;
console.log(`\nSKILL_BOOT ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
if (pass !== results.length) process.exit(1);
