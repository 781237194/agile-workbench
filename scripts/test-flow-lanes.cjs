// 并行泳道纯逻辑单测（R-cbbd · AC19.1/19.2/19.3/19.5/19.7/19.9）
// 运行：node scripts/test-flow-lanes.cjs
const assert = require('node:assert');
const lanes = require('../src/renderer/flow-lanes.js');

let passed = 0;
const ok = (name, fn) => {
  fn();
  passed += 1;
  console.log(`PASS  ${name}`);
};

const task = (id, status, owner, requirementId) => ({ id, type: 'task', status, owner, requirementId });
const req = (id, status, extra = {}) => ({ id, type: 'requirement', status, title: `需求 ${id}`, updatedAt: '2026-11-12T10:00:00.000Z', ...extra });

ok('AC19.2 15 phase → 汇总桶映射固定且全覆盖', () => {
  const expect = {
    idle: 'idle', requirement: 'requirement', requirement_review: 'review', product_review: 'review',
    owner_review: 'owner', tech_review: 'tech', dispatch: 'dev', dev: 'dev', dev_done: 'dev',
    dev_review: 'review', test: 'test', test_done: 'test', owner_accept: 'accept', accepted: 'accept',
    iteration: 'review', terminated: 'terminated',
  };
  for (const [phase, bucket] of Object.entries(expect)) {
    assert.strictEqual(lanes.PHASE_TO_BUCKET[phase], bucket, `phase ${phase} 应映射到 ${bucket}`);
  }
});

ok('AC19.1/19.2 两条需求（验收 + 评审）→ 2 泳道 + 汇总“验收 1 · 评审 1”', () => {
  const wf = {
    requirements: [req('R-A', 'test_done'), req('R-B', 'review')],
    tasks: [task('T-1', 'done', 'tester', 'R-A'), task('T-2', 'done', 'programmer1', 'R-A')],
  };
  const rows = lanes.rows(wf, { id: 'p1', name: '项目' }, '');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].phase, 'owner_accept');
  assert.strictEqual(rows[1].phase, 'requirement_review');
  const sum = lanes.summary(rows);
  assert.strictEqual(sum.text, '验收 1 · 评审 1');
});

ok('AC19.2 四条需求（验收1/评审1/开发2）→ “验收 1 · 评审 1 · 开发 2”', () => {
  const wf = {
    requirements: [req('R-A', 'test_done'), req('R-B', 'dev_review'), req('R-C', 'dev'), req('R-D', 'dispatch')],
    tasks: [],
  };
  const rows = lanes.rows(wf, { id: 'p1', name: '项目' }, '');
  assert.strictEqual(rows.length, 4);
  assert.strictEqual(lanes.summary(rows).text, '验收 1 · 评审 1 · 开发 2');
});

ok('AC19.3 单需求 → 1 泳道、无 0 计数项', () => {
  const wf = { requirements: [req('R-ONLY', 'test')], tasks: [] };
  const rows = lanes.rows(wf, { id: 'p1', name: '项目' }, '');
  assert.strictEqual(rows.length, 1);
  const sum = lanes.summary(rows);
  assert.strictEqual(sum.text, '测试 1');
  assert.ok(!/0/.test(sum.text), '汇总不应出现 0 计数项');
});

ok('AC19.5 同角色跨两泳道有未闭环任务 → 冲突；单泳道不冲突', () => {
  const wf = {
    requirements: [req('R-A', 'dev'), req('R-B', 'dev')],
    tasks: [task('T-1', 'open', 'programmer1', 'R-A'), task('T-2', 'open', 'programmer1', 'R-B')],
  };
  const rows = lanes.rows(wf, { id: 'p1', name: '项目' }, '');
  const c = lanes.conflicts(rows);
  assert.deepStrictEqual(c.programmer1.sort(), ['R-A', 'R-B']);
  const single = lanes.rows({ requirements: [req('R-A', 'dev')], tasks: [task('T-1', 'open', 'programmer1', 'R-A')] }, { id: 'p1', name: '项目' }, '');
  assert.deepStrictEqual(lanes.conflicts(single), {});
});

ok('AC19.7 历史兼容：无需求行 → 单泳道 + 旧数据标注 + fallback 阶段', () => {
  const rows = lanes.rows({ requirements: [], tasks: [task('T-1', 'done', 'programmer1', '')] }, { id: 'p1', name: '旧项目' }, 'dev_done');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].legacy, true);
  assert.ok(rows[0].title.includes('旧数据'));
  assert.strictEqual(rows[0].phase, 'dev_done');
});

ok('需求行同 id 重复 → 按 id 合并为 1 条泳道', () => {
  const rows = lanes.rows({ requirements: [req('R-DUP', 'review'), req('R-DUP', 'dev')], tasks: [] }, { id: 'p1', name: '项目' }, '');
  assert.strictEqual(rows.length, 1);
});

ok('任务按 requirementId 归属；未关联任务不计入需求泳道', () => {
  const wf = {
    requirements: [req('R-A', 'dev')],
    tasks: [task('T-1', 'open', 'programmer1', 'R-A'), task('T-X', 'open', 'programmer1', 'R-OTHER')],
  };
  const rows = lanes.rows(wf, { id: 'p1', name: '项目' }, '');
  assert.strictEqual(rows[0].total, 1);
  assert.strictEqual(rows[0].done, 0);
});

ok('AC19.4 签名：同输入 key 稳定；任务 done 变化 → 该泳道 key 变化、其他泳道不变', () => {
  const base = { requirements: [req('R-A', 'dev'), req('R-B', 'dev')], tasks: [task('T-1', 'open', 'programmer1', 'R-A'), task('T-2', 'open', 'programmer1', 'R-B')] };
  const a1 = lanes.rows(base, { id: 'p1', name: '项目' }, '');
  const a2 = lanes.rows(base, { id: 'p1', name: '项目' }, '');
  assert.deepStrictEqual(a1.map((x) => x.key), a2.map((x) => x.key), '同输入签名必须稳定');
  const afterDone = lanes.rows({ ...base, tasks: [task('T-1', 'done', 'programmer1', 'R-A'), task('T-2', 'open', 'programmer1', 'R-B')] }, { id: 'p1', name: '项目' }, '');
  assert.notStrictEqual(afterDone[0].key, a1[0].key, 'B 泳道（R-A）签名应变化');
  assert.strictEqual(afterDone[1].key, a1[1].key, 'A 泳道（R-B）签名不应变化');
});

ok('终止/未开始不计入活跃汇总，单列', () => {
  const rows = lanes.rows({ requirements: [req('R-T', 'terminated'), req('R-D', 'dev')], tasks: [] }, { id: 'p1', name: '项目' }, '');
  const sum = lanes.summary(rows);
  assert.strictEqual(sum.text, '开发 1');
  assert.ok(sum.inactive.includes('终止 1'));
});

ok('任务证据只前进：需求行 review，但任务有未闭环测试任务 → 阶段升到测试', () => {
  const rows = lanes.rows({ requirements: [req('R-A', 'review')], tasks: [task('T-1', 'open', 'tester', 'R-A')] }, { id: 'p1', name: '项目' }, '');
  assert.strictEqual(rows[0].phase, 'test');
});

ok('需求行 rejected 是合法回退：即使有任务证据也按评审展示', () => {
  const rows = lanes.rows({ requirements: [req('R-A', 'rejected')], tasks: [task('T-1', 'done', 'tester', 'R-A')] }, { id: 'p1', name: '项目' }, '');
  assert.strictEqual(rows[0].phase, 'requirement_review');
});

console.log(`\nFLOW-LANES ${passed}/${passed} PASS`);
