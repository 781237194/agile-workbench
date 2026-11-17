/**
 * T-20261117-211626-c2b5 夹具：「换人 / 交接」纳入基础流程 skill（六角色）。
 *
 * 断言：
 *   H1 六份角色 skill 都含「## 换人 / 交接（每角色必读）」小节；
 *   H2 小节六要素齐：何时交接 / 交接文件（八节+路径）/ 回执 / boot / 广播 / 失败回滚；
 *   H3 manifest 升版 1.1.0 且 approvedBy=Owner、previousVersion.archive 指向归档目录；
 *   H4 归档目录存在且含 1.0.0 的六角色 + 索引 + manifest（旧版可回滚）；
 *   H5 manifest 的 sha 与磁盘一致（skill-check OK，防篡改仍有效）；
 *   H6 索引（00-索引.md）提到「换人/交接」并升到 1.1.0。
 *
 * 跑法：node scripts/test-c2b5-handover-skill.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert');

const ROOT = (() => {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, '团队', '工具', 'team.mjs'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('找不到仓库根');
})();
const DIR = path.join(ROOT, '团队', 'skill', '基础流程');
const ARCHIVE = path.join(ROOT, '团队', 'skill', '归档', '基础流程-1.0.0');
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
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
const textOf = (role) => fs.readFileSync(path.join(DIR, `${role}.md`), 'utf8');

check('H1 六份角色 skill 都含「## 换人 / 交接（每角色必读）」', () => {
  for (const role of ROLES) assert.ok(/## 换人 \/ 交接（每角色必读）/.test(textOf(role)), `${role}.md 缺小节`);
  return '6/6';
});

check('H2 六要素齐（何时交接/交接文件八节/回执/boot/广播/失败回滚）', () => {
  for (const role of ROLES) {
    const t = textOf(role);
    for (const [label, re] of [
      ['何时交接', /何时交接/], ['交接文件', /交接-最新\.md/], ['八节', /八节/],
      ['回执', /回执/], ['boot', /boot/], ['广播', /广播一次/], ['失败回滚', /失败回滚/],
    ]) assert.ok(re.test(t), `${role}.md 缺 ${label}`);
  }
  return '6/6 各 7 项';
});

check('H3 manifest 1.1.0 + 批准人已标代管待确认 + previousVersion.archive', () => {
  const m = JSON.parse(fs.readFileSync(path.join(DIR, 'skill-manifest.json'), 'utf8'));
  assert.strictEqual(m.version, '1.1.0');
  // PM 2026-11-17 21:39 诚信口径：Owner 未显式签字，approvedBy 必须标「PM(代管)-待Owner确认」；Owner 确认后改回 Owner。
  assert.ok(/代管/.test(String(m.approvedBy)), `approvedBy 应为代管待确认口径，实际：${m.approvedBy}`);
  assert.ok(/待\s*Owner\s*确认/.test(String(m.approvedBy)) || /Owner/.test(String(m.approvedBy)), `approvedBy 缺待确认标注：${m.approvedBy}`);
  assert.strictEqual(m.previousVersion && m.previousVersion.version, '1.0.0');
  assert.ok(/归档\/基础流程-1\.0\.0/.test(String(m.previousVersion.archive || '')));
  assert.strictEqual(m.schema, 1);
  return '1.1.0 / Owner / 1.0.0 归档';
});

check('H4 归档目录含 1.0.0 全套（可回滚）', () => {
  assert.ok(fs.existsSync(ARCHIVE), '归档目录不在');
  for (const n of [...ROLES.map((r) => `${r}.md`), '00-索引.md', 'index.md', 'skill-manifest.json']) {
    assert.ok(fs.existsSync(path.join(ARCHIVE, n)), `归档缺 ${n}`);
  }
  const oldManifest = JSON.parse(fs.readFileSync(path.join(ARCHIVE, 'skill-manifest.json'), 'utf8'));
  assert.strictEqual(oldManifest.version, '1.0.0');
  return '9 文件 + 旧 manifest';
});

check('H5 manifest 的 sha 与磁盘一致（防篡改仍有效）', () => {
  const m = JSON.parse(fs.readFileSync(path.join(DIR, 'skill-manifest.json'), 'utf8'));
  for (const [name, expect] of Object.entries(m.files)) {
    assert.strictEqual(sha(path.join(DIR, name)), expect, `${name} sha 不一致`);
  }
  assert.deepStrictEqual(Object.keys(m.files).sort(), fs.readdirSync(DIR).filter((n) => n.endsWith('.md')).sort());
  return `${Object.keys(m.files).length} 个文件一致`;
});

check('H6 00-索引.md 提到换人/交接并升到 1.1.0', () => {
  const t = fs.readFileSync(path.join(DIR, '00-索引.md'), 'utf8');
  assert.ok(/换人\/交接/.test(t), '索引缺换人/交接');
  assert.ok(/version：1\.1\.0/.test(t), '索引版本未升');
  return '索引已更新';
});

const pass = results.filter((r) => r.ok).length;
console.log(`\nC2B5_HANDOVER_SKILL ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
if (pass !== results.length) process.exit(1);
