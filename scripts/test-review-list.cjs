#!/usr/bin/env node
'use strict';
/**
 * T-20261115-131640-3957 · R-dba4 渲染层纯逻辑断言（四组 / 排序 / AC 逐条 / 四块大白话）
 * 跑法：node scripts/test-review-list.cjs
 */
const RL = require('../src/renderer/review-list-core.js');

let passed = 0;
const failures = [];
function check(id, name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${id}  ${name}`); return; }
  failures.push({ id, name, detail }); console.log(`FAIL  ${id}  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 380)}`);
}
const row = (id, status, extra) => ({ id, status, title: `需求 ${id}`, ...(extra || {}) });

/* 四组映射：全量、不丢行 */
{
  check('G-01', 'approved → 等决定', RL.groupOf(row('a', 'approved')).group === 'pending');
  check('G-02', 'ready/dev_dispatched → 进行中', RL.groupOf(row('b', 'ready')).group === 'running' && RL.groupOf(row('c', 'dispatched')).group === 'running');
  check('G-03', 'dev_done/test → 进行中', RL.groupOf(row('d', 'dev_done')).group === 'running' && RL.groupOf(row('e', 'test')).group === 'running');
  check('G-04', 'test_done → 待验收', RL.groupOf(row('f', 'test_done')).group === 'test_done');
  // B-4226：iteration 是「返工轮进行中」，不再归已收口（否则重评通过后仍被当收口，派单/评审都死结）。
  check('G-05', 'accepted/terminated/rejected → 已收口；iteration → 进行中',
    ['accepted', 'terminated', 'rejected'].every((s) => RL.groupOf(row('g', s)).group === 'closed')
    && RL.groupOf(row('g2', 'iteration')).group === 'running');
  check('G-05b', 'iteration 不落已收口（回归判据：closed 集合不含 iteration）',
    !Array.from(RL.STATUS_GROUP.closed).includes('iteration') && Array.from(RL.STATUS_GROUP.running).includes('iteration'), Array.from(RL.STATUS_GROUP.closed));
  check('G-06', '未列状态落待决定并标 statusUnknown', (() => { const r = RL.groupOf(row('h', 'some_new_state')); return r.group === 'pending' && r.statusUnknown === true; })());
  check('G-07', '空状态也落待决定并标 statusUnknown（不许丢行）', (() => { const r = RL.groupOf(row('i', '')); return r.group === 'pending' && r.statusUnknown === true; })());
  check('G-08', '四组恒定存在（空组也给，count=0）', (() => { const g = RL.groupRows([row('j', 'accepted')]); return g.groups.length === 4 && g.groups.find((x) => x.key === 'pending').count === 0; })());
}

/* 排序：逾期 > 未读 > updatedAt 倒序 > id */
{
  const now = Date.parse('2026-11-15T06:00:00.000Z');
  const rows = [
    row('R-3', 'approved', { updatedAt: '2026-11-15T05:00:00.000Z' }),
    row('R-1', 'approved', { updatedAt: '2026-11-15T04:00:00.000Z', due: '2026-11-14T00:00:00.000Z' }),
    row('R-2', 'approved', { updatedAt: '2026-11-15T05:30:00.000Z', readAt: '2026-11-15T05:31:00.000Z' }),
    row('R-4', 'approved', { updatedAt: '2026-11-15T03:00:00.000Z' })
  ];
  const sorted = RL.sortRows(rows, now).map((r) => r.id);
  check('S-01', '逾期排最前', sorted[0] === 'R-1', sorted);
  check('S-02', '未读优先于已读（同更新时间维度）', sorted.indexOf('R-3') < sorted.indexOf('R-2'), sorted);
  check('S-03', '同为未读时按 updatedAt 倒序（R-3 05:00 在 R-4 03:00 之前）', sorted.indexOf('R-3') < sorted.indexOf('R-4'), sorted);
  const sameTime = RL.sortRows([row('R-b', 'approved', { updatedAt: '2026-11-15T05:00:00.000Z' }), row('R-a', 'approved', { updatedAt: '2026-11-15T05:00:00.000Z' })], now).map((r) => r.id);
  check('S-04', '同时间按 id 字典序', sameTime[0] === 'R-a', sameTime);
  check('S-05', '排序不改入参顺序（纯函数）', rows[0].id === 'R-3');
}

/* AC/功能点/边界逐条：保编号、不合并、不截断 */
{
  const detail = [
    'AC1：Owner 打开弹窗能看到四组需求',
    'AC2：每组内按逾期优先排序',
    'F-1：数据层写入时快照',
    '边界-空值：无 copy 时用正文兜底',
    '这是普通说明行，不该变成条目'
  ].join('\n');
  const items = RL.acItemsOf({ id: 'R-x', title: 't', detail, acceptance: '' });
  check('X-01', 'AC1/AC2 各自独立一条且带编号', items.some((i) => i.id === 'AC1') && items.some((i) => i.id === 'AC2'));
  check('X-02', '功能点 F-1 独立成条', items.some((i) => i.id === 'F-1' && i.kind === '功能点'));
  check('X-03', '边界六类独立成条', items.some((i) => i.kind === '边界'));
  check('X-04', '普通说明行不造条目', items.length === 4, items.map((i) => i.id));
  check('X-05', '长 AC 不截断（保原文）', (() => {
    const long = `AC3：${'很长很长的验收描述'.repeat(20)}`;
    const one = RL.acItemsOf({ id: 'R-y', detail: long });
    return one.length === 1 && one[0].text.length > 100;
  })());
  check('X-06', '同一编号不重复出现', (() => {
    const dup = RL.acItemsOf({ id: 'R-z', detail: 'AC1：第一句\nAC1：第二句' });
    return dup.filter((i) => i.id === 'AC1').length === 1;
  })());
  check('X-07', '正文没有任何条目时给一条兜底（不空着）', (() => {
    const one = RL.acItemsOf({ id: 'R-w', detail: '一段没有编号的说明' });
    return one.length === 1 && one[0].id === 'AC-未编号';
  })());
}

/* 四块大白话：copy 优先 / 缺则兜底并标 missing */
{
  const stored = { what: '持久化的一句人话', how: '', impact: '', advice: '' };
  const blocks = RL.copyBlocksOf({ id: 'R-1', title: '标题兜底', detail: '正文怎么做的' }, stored);
  const byKey = Object.fromEntries(blocks.map((b) => [b.key, b]));
  check('C-01', '有 copy 的块直接用（filledBy=copy）', byKey.what.text === '持久化的一句人话' && byKey.what.filledBy === 'copy' && byKey.what.missing === false);
  check('C-02', '缺的块用正文兜底并标 missing', byKey.how.missing === true && byKey.how.filledBy === 'fallback' && byKey.how.text.includes('正文怎么做的'), byKey.how);
  check('C-03', '连正文都没有 → 显式写「正文缺」且 filledBy=none（不伪造）', (() => {
    const b = RL.copyBlocksOf({ id: 'R-2' }, {})[2];
    return b.filledBy === 'none' && /正文缺/.test(b.text);
  })());
  check('C-04', 'data-copy-missing 只列缺的块', RL.copyMissingAttr(blocks) === 'how,impact,advice', RL.copyMissingAttr(blocks));
  check('C-05', '四块齐全时 data-copy-missing 为空串', RL.copyMissingAttr(RL.copyBlocksOf({ id: 'R-3' }, { what: 'a', how: 'b', impact: 'c', advice: 'd' })) === '');
  check('C-06', '四块标签是大白话', blocks.map((b) => b.label).join('/') === '这是什么/怎么做/影响谁/建议你拍板', blocks.map((b) => b.label));
}

console.log(`\nR-dba4 渲染层断言：${passed}/${passed + failures.length} PASS`);
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
