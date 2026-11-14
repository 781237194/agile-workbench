// R-db98 v2（星形/并行）纯逻辑单测（不依赖 DOM/Electron）：node scripts/test-flow-graph.cjs
const assert = require('assert');
const path = require('path');

const FlowGraph = require(path.join(__dirname, '..', 'src', 'renderer', 'flow-graph.js'));
const FlowLanes = require(path.join(__dirname, '..', 'src', 'renderer', 'flow-lanes.js'));

const cases = [];
const ok = (name, fn) => {
  try { fn(); cases.push({ name, ok: true }); } catch (e) { cases.push({ name, ok: false, why: String((e && e.message) || e) }); }
};

const wf = {
  phase: 'dev',
  round: 2,
  requirements: [
    { id: 'R-A', title: '需求A', status: 'ready', trq: { verdict: 'testable' }, decisions: [{ status: 'approved', at: '2026-11-13T00:00:00Z' }] },
    { id: 'R-B', title: '需求B', status: 'test_done', trq: { verdict: 'testable' }, decisions: [{ status: 'approved', at: '2026-11-13T00:00:00Z' }] },
    { id: 'R-C', title: '需求C', status: 'approved', trq: { verdict: 'not_testable' }, ownerReview: { status: 'pending' } },
  ],
  tasks: [
    { id: 'T-1', type: 'task', requirementId: 'R-A', status: 'working', owner: 'programmer1' },
  ],
};
const lanes = FlowLanes.rows(wf, { name: '测试项目', id: 't' }, wf.phase);
const nodes = FlowGraph.computeNodes(lanes, wf);
const html = FlowGraph.markup(lanes, wf, FlowLanes.summary(lanes));
const count = (re) => (html.match(re) || []).length;

ok('星形容器 + 9 节点 + 8 环边 + 2 并行 + 2 汇合 + 中心节点', () => {
  assert.strictEqual(count(/data-flow-star="1"/g), 1);
  assert.strictEqual(nodes.length, 9);
  assert.strictEqual(count(/data-fg-node=/g), 9);
  assert.strictEqual(count(/data-fg-edge="/g), 8);
  assert.strictEqual(count(/data-fg-parallel="/g), 2);
  assert.strictEqual(count(/data-fg-merge="/g), 2);
  assert.strictEqual(count(/data-fg-center/g), 1);
  assert.ok(count(/data-fg-edge-label=/g) >= 8);
});

ok('状态：已过=done、在此=current、未到=todo；缺项红标', () => {
  const synthetic = [{ id: 'x', phase: 'dispatch', status: 'ready', done: 0, total: 0, key: 'x' }];
  const byKey = Object.fromEntries(FlowGraph.computeNodes(synthetic, { requirements: [] }).map((n) => [n.key, n]));
  assert.strictEqual(byKey.requirement.status, 'done');
  assert.strictEqual(byKey.dispatch.status, 'current');
  assert.strictEqual(byKey.closure.status, 'todo');
  const real = Object.fromEntries(nodes.map((n) => [n.key, n]));
  assert.strictEqual(real.trq.status, 'missing');
  assert.strictEqual(real.owner.status, 'missing');
  assert.ok(html.includes('data-fg-missing="trq"'));
});

ok('并行通道：两条都在，live 由真实数据判定', () => {
  assert.ok(html.includes('data-fg-parallel="review-dev"'));
  assert.ok(html.includes('data-fg-parallel="test-collect"'));
  // 构造两条通道都同时有在办：评审/开发/测试/收集各一条
  const multi = [
    { id: 'a', phase: 'requirement_review', status: 'review', done: 0, total: 0, key: 'a' },
    { id: 'b', phase: 'dev', status: 'dev', done: 0, total: 0, key: 'b' },
    { id: 'c', phase: 'test', status: 'test', done: 0, total: 0, key: 'c' },
    { id: 'd', phase: 'requirement', status: 'review', done: 0, total: 0, key: 'd' },
  ];
  const liveHtml = FlowGraph.markup(multi, { round: 2, requirements: [] }, { text: '并行中' });
  assert.ok(liveHtml.includes('data-fg-parallel="review-dev" data-parallel-live="1"'));
  assert.ok(liveHtml.includes('data-fg-parallel="test-collect" data-parallel-live="1"'));
  assert.ok(liveHtml.includes('· 并行中'));
});

ok('分叉/汇合条件标注与转义', () => {
  assert.ok(html.includes('分叉：上一轮开发未收口时，下一轮评审并行'));
  assert.ok(html.includes('汇合①'));
  assert.ok(html.includes('汇合②'));
  const bad = FlowGraph.markup(lanes, { requirements: [{ id: '<x>', status: 'review', title: '<bad>' }] }, { text: '<script>' });
  assert.ok(!bad.includes('<script>'));
  assert.ok(bad.includes('&lt;script&gt;'));
});

const failed = cases.filter((c) => !c.ok);
for (const c of cases) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.why ? ' · ' + c.why : ''}`);
console.log(`FLOW-GRAPH-V2 ${cases.length - failed.length}/${cases.length} PASS`);
process.exitCode = failed.length ? 1 : 0;
