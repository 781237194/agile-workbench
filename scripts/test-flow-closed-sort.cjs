#!/usr/bin/env node
'use strict';
/**
 * T-20261114-164536-f9a7 · 流程图「已收口」区按时间倒序（+轮次分组保留）断言
 *
 * 被测：src/renderer/flow-v4.js（纯渲染函数，Node 可 require）与 app.js 给流程行补的 closedAt 字段。
 * 复跑：node scripts/test-flow-closed-sort.cjs
 */
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const FLOW = path.join(ROOT, 'src', 'renderer', 'flow-v4.js');
const APP = path.join(ROOT, 'src', 'renderer', 'app.js');
const FlowV4 = require(FLOW);

let total = 0;
let failed = 0;
const rows = [];
function check(name, ok, detail) {
  total += 1;
  if (!ok) failed += 1;
  rows.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' · ' + JSON.stringify(detail)));
}

function item(id, status, pri, round, closedAt, updatedAt) {
  return { id, title: id, status, pri, round, closedAt, updatedAt };
}
function idsOf(list) { return list.map((x) => x.id); }

/* ── 一、收口时间：closedAt 优先、缺省 updatedAt、解析不出算 0 ───────────────── */
check('closedTimeOf：优先 closedAt', FlowV4.closedTimeOf(item('R-a', 'accepted', 'P1', 1, '2026-11-14T01:00:00Z', '2026-11-01T00:00:00Z')) === Date.parse('2026-11-14T01:00:00Z'));
check('closedTimeOf：无 closedAt 回退 updatedAt', FlowV4.closedTimeOf(item('R-b', 'accepted', 'P1', 1, '', '2026-11-13T05:00:00Z')) === Date.parse('2026-11-13T05:00:00Z'));
check('closedTimeOf：都没有 → 0', FlowV4.closedTimeOf({ id: 'R-c' }) === 0);
check('closedTimeOf：非法时间 → 0（不抛）', FlowV4.closedTimeOf({ id: 'R-d', closedAt: '不是时间' }) === 0);

/* ── 二、已收口组内排序：时间倒序（与优先级无关）────────────────────────────── */
const shut = [
  item('R-OLD-P0', 'accepted', 'P0', 1, '2026-11-10T00:00:00Z'),
  item('R-NEW-P3', 'terminated', 'P3', 1, '2026-11-14T00:00:00Z'),
  item('R-MID-P1', 'rejected', 'P1', 1, '2026-11-12T00:00:00Z')
];
const sorted = FlowV4.sortClosedItems(shut);
check('已收口组内按 closedAt 倒序（P3 最新排在 P0 之前）', JSON.stringify(idsOf(sorted)) === JSON.stringify(['R-NEW-P3', 'R-MID-P1', 'R-OLD-P0']), idsOf(sorted));
check('排序不丢行（长度一致）', sorted.length === shut.length, sorted.length);
check('排序不改入参顺序（无副作用）', idsOf(shut)[0] === 'R-OLD-P0', idsOf(shut));

const mixed = [
  { id: 'R-with-close', status: 'accepted', pri: 'P2', round: 1, closedAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z' },
  { id: 'R-only-updated', status: 'accepted', pri: 'P2', round: 1, updatedAt: '2026-11-13T00:00:00Z' },
  { id: 'R-no-time', status: 'accepted', pri: 'P0', round: 1 }
];
check('缺 closedAt 用 updatedAt；没时间的最靠后', JSON.stringify(idsOf(FlowV4.sortClosedItems(mixed))) === JSON.stringify(['R-only-updated', 'R-with-close', 'R-no-time']), idsOf(FlowV4.sortClosedItems(mixed)));

/* ── 三、轮次分组保留：当前轮在前，往轮在后，组内各自时间倒序 ────────────────── */
const groups = FlowV4.closedGroups([
  item('R2-a', 'accepted', 'P1', 2, '2026-11-12T00:00:00Z'),
  item('R1-old', 'accepted', 'P0', 1, '2026-11-01T00:00:00Z'),
  item('R1-new', 'accepted', 'P3', 1, '2026-11-05T00:00:00Z'),
  item('R2-b', 'accepted', 'P2', 2, '2026-11-13T00:00:00Z')
], 2);
check('轮次分组：当前轮（第 2 轮）排第一', groups[0].round === 2 && groups[0].current === true, groups.map((g) => g.round));
check('轮次分组：组内时间倒序（第 1 轮 new 在 old 前）', JSON.stringify(idsOf(groups[1].items)) === JSON.stringify(['R1-new', 'R1-old']), idsOf(groups[1].items));
check('轮次分组：组内时间倒序（第 2 轮 b 在 a 前）', JSON.stringify(idsOf(groups[0].items)) === JSON.stringify(['R2-b', 'R2-a']), idsOf(groups[0].items));

/* ── 四、两区规则不同：未收口仍按 app.js 给的优先级顺序 ─────────────────────── */
const data = {
  round: 1,
  total: 5,
  open: 3,
  closed: 2,
  items: [
    // app.js 已按 P0→P3 排好（这里故意让 P0 的更新时间更旧，验证未收口区不看时间）
    item('R-open-P0', 'ready', 'P0', 1, '', '2026-11-01T00:00:00Z'),
    item('R-open-P1', 'dev', 'P1', 1, '', '2026-11-14T00:00:00Z'),
    item('R-open-P2', 'test', 'P2', 1, '', '2026-11-13T00:00:00Z'),
    // 已收口两条：一个很新但 P3，一个很旧但 P0
    item('R-shut-P0-old', 'accepted', 'P0', 1, '2026-11-02T00:00:00Z'),
    item('R-shut-P3-new', 'accepted', 'P3', 1, '2026-11-14T00:00:00Z')
  ]
};
const collapsed = FlowV4.renderListHtml(data, { closedOpen: false });
const expanded = FlowV4.renderListHtml(data, { closedOpen: true });

const openOrder = [...collapsed.matchAll(/class="fv4-row[^"]*" type="button" data-id="([^"]+)"/g)].map((m) => m[1]);
check('未收口区仍按优先级顺序（P0→P1→P2）', JSON.stringify(openOrder) === JSON.stringify(['R-open-P0', 'R-open-P1', 'R-open-P2']), openOrder);
check('默认收起：不出已收口的行', !collapsed.includes('R-shut-P0-old') && !collapsed.includes('R-shut-P3-new'), 'collapsed 里没有收口行');
check('折叠按钮文案含「已收口 2 条」且 aria-expanded=false', /已收口 2 条/.test(collapsed) && /aria-expanded="false"/.test(collapsed), '文案/aria 正常');

const closedOrder = [...expanded.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]).filter((id) => id.startsWith('R-shut'));
check('展开后已收口区按时间倒序（P3 新在前、P0 旧在后）', JSON.stringify(closedOrder) === JSON.stringify(['R-shut-P3-new', 'R-shut-P0-old']), closedOrder);
check('展开后仍保留轮次分组标题', /fv4-round-head/.test(expanded), '有轮次头');
check('展开状态 aria-expanded=true', /aria-expanded="true"/.test(expanded), '展开态');
check('两区不混：未收口行不出现在已收口列表容器里', (() => {
  const idx = expanded.indexOf('fv4-list-closed');
  const before = expanded.slice(0, idx);
  const after = expanded.slice(idx);
  return before.includes('R-open-P0') && !after.includes('R-open-P0');
})(), '分区正确');

/* ── 五、app.js 已把 closedAt 传给流程行（否则排序拿不到真时间）────────────── */
const appSrc = fs.readFileSync(APP, 'utf8');
const mapping = appSrc.includes("updatedAt: String(r.updatedAt || ''), closedAt: String(r.closedAt || '')");
check('app.js 流程行映射带 closedAt', mapping);

/* ── 六、回归：既有导出与收口口径没变 ──────────────────────────────────────── */
check('回归：CLOSED 口径仍是五态', JSON.stringify(FlowV4.CLOSED) === JSON.stringify(['accepted', 'done', 'terminated', 'iteration', 'rejected']), FlowV4.CLOSED);
check('回归：render/statusText/stageOf 仍在导出里', typeof FlowV4.render === 'function' && typeof FlowV4.statusText === 'function' && typeof FlowV4.stageOf === 'function');
check('回归：isClosed 覆盖 rejected/terminated', FlowV4.isClosed('rejected') && FlowV4.isClosed('terminated') && !FlowV4.isClosed('test_done'));

const summary = { at: new Date().toISOString(), total, failed, results: rows };
fs.mkdirSync(path.join(__dirname, '..', '项目', '工作台改造修复', '程序员A', '产出', '证据-f9a7'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', '项目', '工作台改造修复', '程序员A', '产出', '证据-f9a7', 'result.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log('\n合计 ' + total + ' 项，失败 ' + failed + ' 项');
if (failed === 0) console.log('FLOW_CLOSED_SORT_OK');
process.exit(failed ? 1 : 0);
