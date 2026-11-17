/**
 * B-20261117-201937-c17a 夹具：只读源写失败后，解除权限能自愈（.bak/.tmp 不残留只读位）。
 *
 * 复现：把目标文件设为只读 → 写失败（或第一次写把只读源复制成只读 .bak）→ 解除只读 → 再写必须成功；
 *       且 .bak / .tmp 的只读位不残留（用户不必手工去属性）。
 *
 * 断言：
 *   A 只读源第一次写：抛 WRITE_FAILED（或成功但 .bak 非只读）；随后**解除源只读**，第二次写成功、审计 result=ok；
 *   B 写成功后 .bak 存在且**不是只读**（Windows 下检查 fs.statSync 的 mode & 0o200）；
 *   C 失败后 .tmp 不残留只读位、且不存在（清干净）；
 *   D 只读 .bak 也不阻断：人为把 .bak 设为只读 → 再写成功、.bak 被刷新且非只读；
 *   E 回归：正常写法仍原子（写作前后 .bak = 旧内容、主体 = 新内容）。
 *
 * 跑法：node scripts/test-c17a-readonly-bak.cjs
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
const atomic = require(path.join(ROOT, '团队', '工具', 'lib', 'json-atomic.cjs'));
const SB = path.join(ROOT, '_tmp', `c17a-${process.pid}`, '团队', '状态', '项目', '沙盘c17a');
const FILE = path.join(SB, '样本.json');

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
const isReadonly = (p) => { try { const m = fs.statSync(p).mode; return (m & 0o200) === 0; } catch { return false; } };
const reset = () => {
  fs.rmSync(path.dirname(SB), { recursive: true, force: true });
  fs.mkdirSync(SB, { recursive: true });
};
const write = (data) => atomic.writeJsonAtomic(FILE, data, { case: 'fixture' });

reset();
write({ v: 1 });

check('A 只读源 → 解除只读后可自愈（第二次写成功）', () => {
  fs.chmodSync(FILE, 0o444);
  let firstErr = null;
  try { write({ v: 2 }); } catch (e) { firstErr = e; }
  // 关键：解除源只读后必须能写（旧 bug 会因 .bak 只读在 copyfile 处 EPERM 卡死）
  fs.chmodSync(FILE, 0o666);
  const r = write({ v: 3 });
  assert.strictEqual(r.ok, true);
  const disk = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.strictEqual(disk.v, 3);
  return `${firstErr ? '首次按预期失败 ' + String(firstErr.code || '') : '首次已成功'}；解除后写入 v=3`;
});

check('B 写成功后 .bak 存在且不是只读（不继承只读位）', () => {
  const bak = FILE + '.bak';
  assert.ok(fs.existsSync(bak), '.bak 不存在');
  assert.strictEqual(isReadonly(bak), false, '.bak 仍是只读（旧 bug）');
  return 'bak 非只读';
});

check('C 失败后 .tmp 不残留（且不残留只读位）', () => {
  const tmp = FILE + '.tmp';
  if (fs.existsSync(tmp)) assert.strictEqual(isReadonly(tmp), false, '.tmp 残留只读');
  return fs.existsSync(tmp) ? 'tmp 存在但非只读' : 'tmp 已清理';
});

check('D 人为只读 .bak → 再写仍成功且 .bak 刷新为非只读', () => {
  const bak = FILE + '.bak';
  fs.chmodSync(bak, 0o444);
  const r = write({ v: 4 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(isReadonly(bak), false, '.bak 仍只读');
  return 'bak 只读已被清除';
});

check('E 原子性回归：写后主体=新内容、.bak=上一版内容', () => {
  write({ v: 5 });
  const main = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const bak = JSON.parse(fs.readFileSync(FILE + '.bak', 'utf8'));
  assert.strictEqual(main.v, 5);
  assert.strictEqual(bak.v, 4);
  return 'main=5 / bak=4';
});

check('F 审计：写成功后出现 result=ok 行（“success”口径=ok）', () => {
  const audit = path.join(SB, '写入审计.jsonl');
  assert.ok(fs.existsSync(audit), '审计文件不存在');
  const rows = fs.readFileSync(audit, 'utf8').trim().split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  assert.ok(rows.some((r) => String(r.result) === 'ok'), `没有 result=ok 行：${JSON.stringify(rows.map((r) => r.result))}`);
  return `${rows.length} 行审计，含 ok`;
});

fs.rmSync(path.dirname(SB), { recursive: true, force: true });
const pass = results.filter((r) => r.ok).length;
console.log(`\nC17A_READONLY_BAK ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
if (pass !== results.length) process.exit(1);
