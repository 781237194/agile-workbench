/**
 * B-20261117-215444-1f8b 夹具：开源导出必须带 团队/skill（六角色 + 索引 + manifest）。
 *
 * 断言：
 *   E1 导出 exit 0（自检通过：白名单/必需文件/无敏感串）；
 *   E2 导出产物含 团队/skill/基础流程/ 六角色 md + 00-索引.md + skill-manifest.json；
 *   E3 导出产物的 manifest sha 与文件一致（下载用户拿到的是同一版）；
 *   E4 package.json files 含 "团队/skill/"（与 DIR_WHITELIST 一致）。
 *
 * 跑法：node scripts/test-1f8b-export-skill.cjs
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
const OUT = path.join(ROOT, '_tmp', 'export-1f8b-fixture');
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
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

let runErr = null;
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'export-open-source.mjs'), '--out', OUT, '--force'], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
} catch (e) { runErr = e; }

check('E1 导出 exit 0（白名单/必需文件/敏感串自检通过）', () => {
  assert.ok(!runErr, `导出失败：${String(runErr && (runErr.stdout || runErr.message)).slice(0, 400)}`);
  return 'exit 0';
});

const SKILL = path.join(OUT, '团队', 'skill', '基础流程');

check('E2 导出含六角色 + 00-索引 + manifest', () => {
  for (const n of [...ROLES.map((r) => `${r}.md`), '00-索引.md', 'skill-manifest.json']) {
    assert.ok(fs.existsSync(path.join(SKILL, n)), `缺 ${n}`);
  }
  return '9 文件';
});

check('E3 导出 manifest 的 sha 与导出文件一致', () => {
  const mf = JSON.parse(fs.readFileSync(path.join(SKILL, 'skill-manifest.json'), 'utf8'));
  for (const [name, expect] of Object.entries(mf.files || {})) {
    assert.strictEqual(sha(path.join(SKILL, name)), expect, `${name} sha 不一致`);
  }
  return `${Object.keys(mf.files).length} 文件一致`;
});

check('E4 package.json files 含 团队/skill/', () => {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok((j.files || []).includes('团队/skill/'), 'package.json files 缺 团队/skill/');
  return 'files 一致';
});

fs.rmSync(OUT, { recursive: true, force: true });
const pass = results.filter((r) => r.ok).length;
console.log(`\nB1F8B_EXPORT_SKILL ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
if (pass !== results.length) process.exit(1);
