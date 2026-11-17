/**
 * B-20261117-190411-b75c 夹具：Owner 决定「绑的是不是当前正文版本」——contentHash 优先，缺失才回落 sha256。
 *
 * 复现的真实事故（6bc8）：程序自己往正文追加「## 状态记录」只改原始 sha256，不改内容；
 * 旧实现用原始 sha256 判决定新旧 → 一写状态行就把 Owner 已通过的决定判成旧版 → 验收/派单被挡。
 *
 * 跑法：node scripts/test-b75c-contenthash.cjs
 * 断言：①CLI 侧（gates.decisionIsCurrent）只差维护行=有效；②实质改文=旧版；③旧决定无 contentHash 回落 sha；
 *       ④壳层（src/team-tools.js 导出的 decisionMatchesDocVersion/ownerDecisionStaleness）同口径；⑤两处实现同源（同一 CJS 文件）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = (() => {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, '团队', '工具', 'team.mjs'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('找不到仓库根（含 团队/工具/team.mjs）');
})();

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

const A = 'a'.repeat(64); // 旧正文 sha256
const B = 'b'.repeat(64); // 追加状态行后的正文 sha256（内容不变）
const C1 = 'c'.repeat(64); // 内容哈希 v1
const C2 = 'd'.repeat(64); // 内容哈希 v2（实质改文）

(async () => {
  // ---------- ① CLI 侧 ----------
  const gates = await import(require('node:url').pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'gates.mjs')).href);
  const { decisionIsCurrent } = gates;

  const decision = { status: 'approved', basis: { requirement: { sha256: A, contentHash: C1 } } };
  const rowOnlyStatusChanged = { requirementHash: B, requirementReview: { contentHash: C1 }, ownerReview: { status: 'approved' } };

  check('① CLI：只差程序维护行（sha 变了、contentHash 没变）→ 决定仍有效', () => {
    assert.strictEqual(decisionIsCurrent(decision, rowOnlyStatusChanged), true);
    return 'sha=' + B.slice(0, 6) + ' contentHash 相同';
  });

  check('② CLI：实质改文（contentHash 变了）→ 判定为旧版', () => {
    const row = { requirementHash: B, requirementReview: { contentHash: C2 }, ownerReview: { status: 'approved' } };
    assert.strictEqual(decisionIsCurrent(decision, row), false);
    return 'contentHash c1≠c2';
  });

  check('③ CLI：旧决定无 contentHash → 回落 sha256（等=有效、不等=旧版）', () => {
    const legacy = { status: 'approved', basis: { requirement: { sha256: A } } };
    assert.strictEqual(decisionIsCurrent(legacy, { requirementHash: A, ownerReview: { status: 'approved' } }), true);
    assert.strictEqual(decisionIsCurrent(legacy, { requirementHash: B, ownerReview: { status: 'approved' } }), false);
    return 'legacy 兼容';
  });

  // ---------- ④ 壳层侧 ----------
  const shell = require(path.join(ROOT, 'src', 'team-tools.js'));
  check('④ 壳层：decisionMatchesDocVersion 同口径（维护行=有效、实质改文=旧版）', () => {
    assert.strictEqual(typeof shell.decisionMatchesDocVersion, 'function');
    assert.strictEqual(shell.decisionMatchesDocVersion(decision, { sha256: B, contentHash: C1 }), true);
    assert.strictEqual(shell.decisionMatchesDocVersion(decision, { sha256: B, contentHash: C2 }), false);
    return 'shell 同口径';
  });

  // ---------- ⑤ 同源 ----------
  check('⑤ 两处判定同源：decision-version.cjs 是唯一实现（gates.mjs 与 team-tools.js 都引用它）', () => {
    const core = require(path.join(ROOT, '团队', '工具', 'lib', 'decision-version.cjs'));
    assert.strictEqual(typeof core.decisionMatchesVersion, 'function');
    const gatesSrc = fs.readFileSync(path.join(ROOT, '团队', '工具', 'lib', 'gates.mjs'), 'utf8');
    const shellSrc = fs.readFileSync(path.join(ROOT, 'src', 'team-tools.js'), 'utf8');
    assert.ok(gatesSrc.includes("from './decision-version.cjs'"), 'gates.mjs 未引用 decision-version.cjs');
    assert.ok(shellSrc.includes('decision-version.cjs'), 'team-tools.js 未引用 decision-version.cjs');
    return 'gates.mjs + team-tools.js → decision-version.cjs';
  });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\nB75C_CONTENTHASH ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
  if (pass !== results.length) process.exit(1);
})().catch((e) => {
  console.error('B75C_FIXTURE_ERROR', e && (e.stack || e.message || e));
  process.exit(1);
});
