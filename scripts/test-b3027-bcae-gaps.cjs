/**
 * B-20261117-212853-3027 夹具：bcae 四项缺项（tester 判红）红转绿。
 *
 * 断言：
 *   P1 公共模板目录 `团队/工具/模板/skill/` 存在且六主题齐全（六角色 md，七段格式）；
 *   P2 正式清单落点 `团队/状态/技能清单.json` 存在，version/approvedBy/files 与 manifest 同源；
 *   P3 `skill verify` 沙盘干净 → exit 0；篡改模板 → exit 1（SKILL_VERIFY_FAILED，含 TAMPERED）；恢复 → 0；
 *   P4 `skill template write --out` 写出 6 个模板且与模板源 sha 相同；再次不带 --force → noop（skipped=6）；
 *   P5 `scripts/skill-check.cjs --write-state` 能派生状态清单且校验仍 OK。
 *
 * 跑法：node scripts/test-b3027-bcae-gaps.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const TPL_DIR = path.join(ROOT, '团队', '工具', '模板', 'skill');
const STATE_FILE = path.join(ROOT, '团队', '状态', '技能清单.json');
const SKILL_DIR = path.join(ROOT, '团队', 'skill', '基础流程');
const SB = path.join(ROOT, '_tmp', `b3027-${process.pid}`);
const SB_TEAM = path.join(SB, '团队');
const SB_PROJECTS = path.join(SB, '项目');
const PROJECT = '沙盘bcae';
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

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
function env() {
  return { ...process.env, TEAM_ROOT: SB_TEAM, TEAM_PROJECTS_ROOT: SB_PROJECTS, TEAM_SELFTEST: '1' };
}
function cli(args) {
  try {
    return { ok: true, out: execFileSync(process.execPath, [path.join(SB_TEAM, '工具', 'team.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: env() }) };
  } catch (e) {
    return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}

check('P1 六主题模板存在（团队/工具/模板/skill/）', () => {
  assert.ok(fs.existsSync(TPL_DIR), '模板目录不存在');
  for (const role of ROLES) {
    const f = path.join(TPL_DIR, `${role}.md`);
    assert.ok(fs.existsSync(f), `缺 ${role}.md`);
    const t = fs.readFileSync(f, 'utf8');
    for (const sec of ['适用场景', '前置条件', '步骤', '判据', '反例', '版本', '换人 / 交接']) {
      assert.ok(t.includes(`## ${sec}`) || new RegExp(`^## ${sec}`, 'm').test(t), `${role}.md 缺「${sec}」`);
    }
  }
  return '6/6 主题';
});

check('P2 正式清单落点 团队/状态/技能清单.json 与 manifest 同源', () => {
  assert.ok(fs.existsSync(STATE_FILE), '状态清单不存在');
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'skill-manifest.json'), 'utf8'));
  assert.strictEqual(state.version, manifest.version);
  assert.strictEqual(state.approvedBy, 'Owner');
  assert.deepStrictEqual(state.files, manifest.files);
  return `version ${state.version} / ${Object.keys(state.files).length} 文件`;
});

// 沙盘
fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(path.join(SB_TEAM, '状态'), { recursive: true });
fs.mkdirSync(SB_PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(SB_TEAM, '工具'), { recursive: true });
fs.cpSync(path.join(ROOT, '团队', 'skill'), path.join(SB_TEAM, 'skill'), { recursive: true });
fs.copyFileSync(STATE_FILE, path.join(SB_TEAM, '状态', '技能清单.json'));
for (const f of ['团队宪法.md', '项目铁律.md']) {
  const src = path.join(ROOT, '团队', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SB_TEAM, f));
}
const team = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8'));
for (const m of team.members || []) { m.sessionId = ''; m.archivedSession = ''; m.replacedBySessionId = ''; m.sessionPrevSessionId = ''; }
delete team.activeProject;
fs.writeFileSync(path.join(SB_TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2));
cli(['project', 'add', '--name', PROJECT, '--team-mode', 'full']);
const boot = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-b3027']);
const token = (String(boot.out).match(/令牌:\s*([0-9a-f]+)/) || [])[1];
assert.ok(token, `沙盘 boot 失败：${boot.out.slice(0, 200)}${boot.err || ''}`);
const sbSkillFile = path.join(SB_TEAM, 'skill', '基础流程', 'programmer1.md');
const original = fs.readFileSync(sbSkillFile);

check('P3 skill verify：干净 exit 0 / 篡改 exit 1（含 TAMPERED）/ 恢复 exit 0', () => {
  const clean = cli(['skill', 'verify', '--role', 'programmer1', '--project', PROJECT, '--boot', token, '--json']);
  assert.ok(clean.ok, `干净校验失败：${clean.out}${clean.err || ''}`);
  assert.strictEqual(JSON.parse(clean.out.trim()).ok, true);
  fs.appendFileSync(sbSkillFile, '\n<!-- tamper -->\n', 'utf8');
  const bad = cli(['skill', 'verify', '--role', 'programmer1', '--project', PROJECT, '--boot', token, '--json']);
  assert.strictEqual(bad.ok, false, '篡改后仍 exit 0');
  assert.ok(/SKILL_VERIFY_FAILED/.test(bad.err + bad.out), `缺 SKILL_VERIFY_FAILED：${bad.out}${bad.err}`);
  assert.ok(/SKILL_TEMPLATE_TAMPERED/.test(bad.err + bad.out), '缺 TAMPERED finding');
  fs.writeFileSync(sbSkillFile, original);
  const again = cli(['skill', 'verify', '--role', 'programmer1', '--project', PROJECT, '--boot', token, '--json']);
  assert.ok(again.ok, '恢复后仍失败');
  return 'ok → 红 → 恢复绿';
});

check('P4 skill template write 写出 6 模板；重复不带 --force 为 noop', () => {
  const outDir = path.join(SB, 'tpl-out');
  const first = cli(['skill', 'template', 'write', '--role', 'programmer1', '--project', PROJECT, '--boot', token, '--out', outDir, '--json']);
  assert.ok(first.ok, `写出失败：${first.out}${first.err || ''}`);
  const j1 = JSON.parse(first.out.trim());
  assert.strictEqual(j1.written.length, 6);
  for (const role of ROLES) assert.strictEqual(sha(path.join(outDir, `${role}.md`)), sha(path.join(TPL_DIR, `${role}.md`)), `${role} 内容不一致`);
  const second = cli(['skill', 'template', 'write', '--role', 'programmer1', '--project', PROJECT, '--boot', token, '--out', outDir, '--json']);
  const j2 = JSON.parse(second.out.trim());
  assert.strictEqual(j2.written.length, 0);
  assert.strictEqual(j2.skipped.length, 6);
  return '6 写出 + 6 跳过';
});

check('P5 skill-check --write-state 可派生状态清单且校验 OK', () => {
  const r = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'skill-check.cjs'), '--root', SB, '--strict-state', '--write-state', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  const j = JSON.parse(String(r).trim().split(/\r?\n/).pop());
  assert.strictEqual(j.ok, true, JSON.stringify(j.findings));
  assert.ok(j.stateWritten && j.stateWritten.ok === true);
  assert.ok(fs.existsSync(path.join(SB_TEAM, '状态', '技能清单.json')));
  return 'derived + ok';
});

fs.rmSync(SB, { recursive: true, force: true });
const pass = results.filter((r) => r.ok).length;
console.log(`\nB3027_BCAE ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
if (pass !== results.length) process.exit(1);
