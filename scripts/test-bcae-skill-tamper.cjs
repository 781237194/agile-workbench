/**
 * T-20261117-184114-4358（R-bcae）第一步夹具：基础流程 skill 清单防篡改。
 *
 * 沙盘：把 团队/skill/基础流程 复制到 _tmp 沙盘根后校验（不动真实目录）。
 * 断言：
 *   S1 干净模板 → SKILL_CHECK_OK，0 finding，exit 0；
 *   S2 篡改任一模板 → SKILL_TEMPLATE_TAMPERED，exit 1；
 *   S3 恢复原内容 → 回绿（篡改判定可逆、不是一次性）；
 *   S4 删一个模板文件 → SKILL_TEMPLATE_MISSING；
 *   S5 新增一个未登记 .md → SKILL_MANIFEST_EXTRA（防绕过改版）；
 *   S6 去掉「## 判据」小节 → SKILL_FORMAT_INVALID；
 *   S7 manifest 去掉 approvedBy → SKILL_MANIFEST_INVALID；
 *   S8 真实 团队/skill/基础流程 未被本脚本改动（sha 前后一致）。
 *
 * 跑法：node scripts/test-bcae-skill-tamper.cjs
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
const REAL_DIR = path.join(ROOT, '团队', 'skill', '基础流程');
const SB = path.join(ROOT, '_tmp', `skill4358-${process.pid}`);
const SB_DIR = path.join(SB, '团队', 'skill', '基础流程');
const CHECK = path.join(ROOT, 'scripts', 'skill-check.cjs');
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
function runCheck() {
  try {
    const out = execFileSync(process.execPath, [CHECK, '--root', SB, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    return { code: 0, json: JSON.parse(out.trim().split(/\r?\n/).pop()) };
  } catch (e) {
    const out = String(e.stdout || '').trim();
    return { code: e.status == null ? 1 : e.status, json: JSON.parse(out.split(/\r?\n/).pop() || '{}') };
  }
}
const seed = () => {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(SB_DIR), { recursive: true });
  fs.cpSync(REAL_DIR, SB_DIR, { recursive: true });
};
const realBefore = (() => {
  const map = {};
  for (const n of fs.readdirSync(REAL_DIR)) map[n] = sha(path.join(REAL_DIR, n));
  return map;
})();

seed();

check('S1 干净模板 → SKILL_CHECK_OK、0 finding、exit 0', () => {
  const r = runCheck();
  assert.strictEqual(r.code, 0, JSON.stringify(r.json.findings));
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.findings.length, 0);
  return 'ok / 0 finding';
});

let tamperedName = '';
let original = '';
check('S2 篡改模板 → SKILL_TEMPLATE_TAMPERED、exit 1', () => {
  tamperedName = fs.readdirSync(SB_DIR).find((n) => /^programmer1\.md$/.test(n));
  assert.ok(tamperedName, '沙盘里没有 programmer1.md');
  const p = path.join(SB_DIR, tamperedName);
  original = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, original.replace('## 判据', '## 判据（被偷偷改了）'), 'utf8');
  const r = runCheck();
  assert.strictEqual(r.code, 1);
  assert.ok(r.json.findings.some((f) => f.code === 'SKILL_TEMPLATE_TAMPERED'), JSON.stringify(r.json.findings));
  return r.json.findings.map((f) => f.code).join(',');
});

check('S3 恢复原内容 → 回绿（可逆）', () => {
  fs.writeFileSync(path.join(SB_DIR, tamperedName), original, 'utf8');
  const r = runCheck();
  assert.strictEqual(r.code, 0, JSON.stringify(r.json.findings));
  return '恢复后 ok';
});

check('S4 删一个模板文件 → SKILL_TEMPLATE_MISSING', () => {
  const victim = fs.readdirSync(SB_DIR).find((n) => /^tester\.md$/.test(n));
  const p = path.join(SB_DIR, victim);
  const backup = fs.readFileSync(p);
  fs.rmSync(p);
  const r = runCheck();
  assert.ok(r.json.findings.some((f) => f.code === 'SKILL_TEMPLATE_MISSING'), JSON.stringify(r.json.findings));
  fs.writeFileSync(p, backup);
  return 'missing 被检出并已恢复';
});

check('S5 新增未登记 .md → SKILL_MANIFEST_EXTRA（防绕过改版）', () => {
  const extra = path.join(SB_DIR, 'hacker.md');
  fs.writeFileSync(extra, '# 偷偷加的 skill\n\n## 适用场景\nx\n', 'utf8');
  const r = runCheck();
  assert.ok(r.json.findings.some((f) => f.code === 'SKILL_MANIFEST_EXTRA'), JSON.stringify(r.json.findings));
  fs.rmSync(extra);
  return 'extra 被检出并已删除';
});

check('S6 去掉「## 判据」小节 → SKILL_FORMAT_INVALID', () => {
  const name = fs.readdirSync(SB_DIR).find((n) => /^pm\.md$/.test(n));
  const p = path.join(SB_DIR, name);
  const backup = fs.readFileSync(p, 'utf8');
  // 先按格式合法改（同时更新 manifest sha），再验证格式检查会红
  const broken = backup.replace(/## 判据[\s\S]*?(?=\n## )/, '');
  fs.writeFileSync(p, broken, 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(SB_DIR, 'skill-manifest.json'), 'utf8'));
  manifest.files[name] = crypto.createHash('sha256').update(broken).digest('hex');
  fs.writeFileSync(path.join(SB_DIR, 'skill-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const r = runCheck();
  assert.ok(r.json.findings.some((f) => f.code === 'SKILL_FORMAT_INVALID'), JSON.stringify(r.json.findings));
  fs.writeFileSync(p, backup, 'utf8');
  seed();
  return 'format 被检出（已重置沙盘）';
});

check('S7 manifest 去掉 approvedBy → SKILL_MANIFEST_INVALID', () => {
  const mf = path.join(SB_DIR, 'skill-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  delete manifest.approvedBy;
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const r = runCheck();
  assert.ok(r.json.findings.some((f) => f.code === 'SKILL_MANIFEST_INVALID'), JSON.stringify(r.json.findings));
  seed();
  return 'manifest invalid 被检出';
});

check('S8 真实 团队/skill/基础流程 未被改动（sha 前后一致）', () => {
  const map = {};
  for (const n of fs.readdirSync(REAL_DIR)) map[n] = sha(path.join(REAL_DIR, n));
  assert.deepStrictEqual(map, realBefore);
  return Object.keys(map).length + ' 个文件未变';
});

fs.rmSync(SB, { recursive: true, force: true });
const pass = results.filter((r) => r.ok).length;
console.log(`\nSKILL_TAMPER ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
if (pass !== results.length) process.exit(1);
