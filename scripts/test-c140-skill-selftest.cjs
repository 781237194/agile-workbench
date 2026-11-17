/**
 * B-20261117-214842-d138（bcae AC10）夹具：`team.mjs skill check --selftest` 自检入口。
 *
 * 断言：
 *   S1 入口可跑：exit 0，stdout 含 SKILL_CHECK_OK；
 *   S2 --json 输出 {ok:true, entry:'skill check --selftest', checks[]}，checks 覆盖 AC1–AC8（≥8 条且全 PASS）；
 *   S3 零写入真实状态：真实 团队/状态/团队.json 与 团队/工具/模板/skill/ 六份模板 sha256 前后一致；
 *   S4 自检失败路径可观测：沙盘里把模板目录临时改名再跑（用 --root 不存在场景改测 verify 的 SKILL_TEMPLATE_DIR_MISSING 返回码）→ 不静默。
 *
 * 跑法：node scripts/test-c140-skill-selftest.cjs
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
function run(args) {
  try {
    return { ok: true, out: execFileSync(process.execPath, [path.join(ROOT, '团队', '工具', 'team.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 240000 }) };
  } catch (e) {
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || ''), status: e.status };
  }
}
const watchReal = () => ({
  teamJson: sha(path.join(ROOT, '团队', '状态', '团队.json')),
  state: fs.existsSync(path.join(ROOT, '团队', '状态', '技能清单.json')) ? sha(path.join(ROOT, '团队', '状态', '技能清单.json')) : 'missing',
  templates: Object.fromEntries(ROLES.map((r) => [r, sha(path.join(ROOT, '团队', '工具', '模板', 'skill', `${r}.md`))])),
});

const before = watchReal();
const out = run(['skill', 'check', '--role', 'programmer1', '--project', '工作台改造修复', '--selftest']);

check('S1 入口可跑：exit 0 且输出 SKILL_CHECK_OK', () => {
  assert.ok(out.ok, out.out.slice(0, 400));
  assert.ok(/SKILL_CHECK_OK/.test(out.out), out.out.slice(0, 400));
  return 'SKILL_CHECK_OK';
});

check('S2 checks 覆盖 AC1–AC8 且全 PASS', () => {
  const idx = out.out.indexOf('{');
  const j = JSON.parse(out.out.slice(idx, out.out.indexOf('\n-') > 0 ? out.out.indexOf('\n-') : undefined));
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.entry, 'skill check --selftest');
  assert.ok(Array.isArray(j.checks) && j.checks.length >= 8, `checks=${j.checks && j.checks.length}`);
  assert.ok(j.checks.every((c) => c.ok === true), JSON.stringify(j.checks.filter((c) => !c.ok)));
  for (const ac of ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'AC7', 'AC8']) {
    assert.ok(j.checks.some((c) => String(c.ac).startsWith(ac)), `缺 ${ac}`);
  }
  return `${j.checks.length} 条全 PASS`;
});

check('S3 零写入：真实 团队.json / 技能清单 / 六模板 sha 前后一致', () => {
  const after = watchReal();
  assert.deepStrictEqual(after, before, '真实状态被改写');
  return 'real state unchanged';
});

check('S4 失败路径可观测：不存在的 root 下 verify 返回目录缺失码而非静默', () => {
  const lib = path.join(ROOT, '团队', '工具', 'lib', 'skill-manifest.mjs');
  const script = `import { verifySkillSet } from ${JSON.stringify('file:///' + lib.replace(/\\/g, '/'))}; const r = verifySkillSet({ root: ${JSON.stringify(path.join(ROOT, '_tmp', 'no-such-root-xyz'))} }); console.log(JSON.stringify({ ok: r.ok, codes: r.findings.map(f => f.code) }));`;
  const o = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  const j = JSON.parse(o.trim());
  assert.strictEqual(j.ok, false);
  assert.ok(j.codes.includes('SKILL_TEMPLATE_MISSING'), JSON.stringify(j.codes));
  return j.codes.join(',');
});

const pass = results.filter((r) => r.ok).length;
console.log(`\nC140_SKILL_SELFTEST ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
if (pass !== results.length) process.exit(1);
