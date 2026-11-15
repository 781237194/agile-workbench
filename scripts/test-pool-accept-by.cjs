#!/usr/bin/env node
'use strict';
/**
 * R-62b9 · 池详情显示验收人（data-accept-by **七值**枚举 + data-accept-at + data-accept-test-gate 副标）
 *
 * 口径来源：增补卷-62b9-1（9815B/96ed87df）§二 七值表 / §五 标签统一 / §六 AC6–AC10。
 * 被测：src/renderer/pool-core.js（纯逻辑，Node 可 require）。
 * 复跑：node scripts/test-pool-accept-by.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'renderer', 'pool-core.js');
const P = require(CORE);

let total = 0;
let failed = 0;
const rows = [];
function check(name, ok, detail) {
  total += 1;
  if (!ok) failed += 1;
  rows.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' · ' + JSON.stringify(detail)));
}

const AT = '2026-11-15T01:30:00.000Z';
const BASIS = { proxy: { scope: 'all', startedAt: AT, authorization: 'Owner 授权' } };

/* ── 一、七值枚举（§二 表：顺序固定、判据自左向右命中即停）─────────────── */
const cases = [
  { name: '① owner：by=owner + channel=ui', row: { acceptanceRecord: { status: 'accepted', by: 'owner', channel: 'ui', at: AT } }, code: 'owner', label: '【Owner 验收】' },
  { name: '① owner：channel=tty 也算本人', row: { acceptanceRecord: { status: 'accepted', by: 'owner', channel: 'tty', at: AT } }, code: 'owner', label: '【Owner 验收】' },
  { name: '② pm_proxy：channel=proxy + recordedBy=pm + basis.proxy 三字段齐', row: { acceptanceRecord: { status: 'accepted', by: 'pm', channel: 'proxy', recordedBy: 'pm', at: AT, basis: BASIS } }, code: 'pm_proxy', label: '【PM代管验收】' },
  { name: '③ pm：PM 直接验收（by=pm + channel=pm，正常路径不是防御态）', row: { acceptanceRecord: { status: 'accepted', by: 'pm', channel: 'pm', at: AT } }, code: 'pm', label: '【PM 验收】' },
  { name: '④ tester：测试直验（by=tester + channel=test）', row: { acceptanceRecord: { status: 'accepted', by: 'tester', channel: 'test', at: AT } }, code: 'tester', label: '【测试验收】' },
  { name: '⑤ auto：自动验收（by=system + channel=auto，不得落 none）', row: { acceptanceRecord: { status: 'accepted', by: 'system', channel: 'auto', at: AT } }, code: 'auto', label: '【自动验收（系统）】' },
  { name: '⑥ pm_incomplete：代管缺 basis.proxy（不冒充）', row: { acceptanceRecord: { status: 'accepted', by: 'pm', channel: 'proxy', recordedBy: 'pm', at: AT } }, code: 'pm_incomplete', label: '【PM代管·记录不完整】' },
  { name: '⑥ pm_incomplete：代管 basis 只有 scope（缺 startedAt/authorization 也算不完整）', row: { acceptanceRecord: { status: 'accepted', channel: 'proxy', recordedBy: 'pm', at: AT, basis: { proxy: { scope: 'all' } } } }, code: 'pm_incomplete', label: '【PM代管·记录不完整】' },
  { name: '⑦ none：未验收（没有验收结论）', row: { status: 'test_done', decisions: [{ status: 'approved', at: AT }] }, code: 'none', label: '（未验收）' },
];
for (const item of cases) {
  const got = P.acceptByOf(item.row);
  check(item.name, got.code === item.code && got.label === item.label, { code: got.code, label: got.label });
}

/* ── 二、AC9 旧记录兼容：by=pm 且 channel 缺失 → pm / 【PM 验收（来源未记）】 */
const legacy = P.acceptByOf({ acceptanceRecord: { status: 'accepted', by: 'pm', at: AT } });
check('AC9 旧记录：by=pm 且 channel 缺失 → code=pm、标签【PM 验收（来源未记）】、不判 none、不冒充 Owner',
  legacy.code === 'pm' && legacy.label === '【PM 验收（来源未记）】', legacy);

/* ── 三、AC8 自动验收可见：实测 by=system+auto 不落 none ───────────────── */
const autoRow = P.acceptByOf({ acceptanceRecord: { status: 'accepted', by: 'system', channel: 'auto', at: AT } });
check('AC8 自动验收：data-accept-by=auto 且标签【自动验收（系统）】（不是「（未验收）」）',
  autoRow.code === 'auto' && autoRow.label === '【自动验收（系统）】', autoRow);

/* ── 四、决定来源：无 acceptanceRecord 时读 decisions[] 末条 ───────────── */
const viaDecision = P.acceptByOf({
  decisions: [
    { status: 'approved', at: '2026-11-14T10:00:00Z' },
    { status: 'accepted', channel: 'proxy', recordedBy: 'pm', decidedBy: 'pm', at: AT, basis: BASIS },
  ],
});
check('decisions 末条 accepted（代管三要素齐）也能判出 pm_proxy', viaDecision.code === 'pm_proxy' && viaDecision.at === AT, viaDecision);

const notAccepted = P.acceptByOf({ decisions: [{ status: 'rejected', channel: 'proxy', decidedBy: 'pm', at: AT }] });
check('末条不是 accepted → 未验收（评审决定不算验收人）', notAccepted.code === 'none', notAccepted);

/* ── 五、pm_signed 只作副标，不参与验收人取值（AC2e）─────────────────── */
const signed = P.acceptByOf({
  acceptanceRecord: { status: 'accepted', by: 'owner', channel: 'ui', at: AT, testGate: 'pm_signed' },
  decisions: [{ status: 'accepted', channel: 'proxy', recordedBy: 'pm', decidedBy: 'owner', at: AT, testGate: 'pm_signed', signedBy: 'pm' }],
});
check('pm_signed：验收人仍按「谁点+渠道」= owner（不被 pm_signed 抢走）', signed.code === 'owner' && signed.testGate === 'pm_signed', signed);
check('pm_signed 不得成为 data-accept-by 的取值（七个 code 里没有它）',
  !Object.keys(P.ACCEPT_BY_LABELS).includes('pm_signed'), Object.keys(P.ACCEPT_BY_LABELS));

/* ── 六、验收时间 ───────────────────────────────────────────────────── */
const withAt = P.acceptByOf({ acceptanceRecord: { status: 'accepted', by: 'owner', channel: 'ui', at: AT } });
check('data-accept-at 取 acceptanceRecord.at', withAt.at === AT, withAt.at);
const fallbackAt = P.acceptByOf({ acceptanceRecord: { status: 'accepted', by: 'owner' }, decisions: [{ status: 'accepted', channel: 'ui', decidedBy: 'owner', at: AT }] });
check('缺 acceptanceRecord.at 时回退 decisions.at', fallbackAt.at === AT, fallbackAt.at);

/* ── 七、AC10 标签一致性：七值 code→label 与 §二 逐字相等 ─────────────── */
const EXPECTED = {
  owner: '【Owner 验收】',
  pm_proxy: '【PM代管验收】',
  pm: '【PM 验收】',
  tester: '【测试验收】',
  auto: '【自动验收（系统）】',
  pm_incomplete: '【PM代管·记录不完整】',
  none: '（未验收）',
};
check('AC10 七值 code→label 映射逐字相等（含顺序无关、恰好 7 个 code）',
  JSON.stringify(Object.keys(P.ACCEPT_BY_LABELS).sort()) === JSON.stringify(Object.keys(EXPECTED).sort())
  && Object.keys(EXPECTED).every((k) => P.ACCEPT_BY_LABELS[k] === EXPECTED[k]), P.ACCEPT_BY_LABELS);

/* ── 八、AC10 三处同源：池详情 / 缺陷池列表行 对同一记录标签完全相同 ──── */
function labelFromMarkup(html, code) {
  const re = new RegExp(`data-accept-by="${code}"[^>]*>([^<]*)<`);
  const m = html.match(re);
  return m ? m[1].trim() : '';
}
const defectRows = [
  { name: 'tester', rec: { status: 'accepted', by: 'tester', channel: 'test', at: AT }, code: 'tester' },
  { name: 'pm', rec: { status: 'accepted', by: 'pm', channel: 'pm', at: AT }, code: 'pm' },
  { name: 'auto', rec: { status: 'accepted', by: 'system', channel: 'auto', at: AT }, code: 'auto' },
  { name: 'owner', rec: { status: 'accepted', by: 'owner', channel: 'ui', at: AT }, code: 'owner' },
];
for (const item of defectRows) {
  const rowHtml = P.poolRowMarkup({ id: 'B-1', kind: 'bug', type: 'bug', title: '缺陷', status: 'done', acceptanceRecord: item.rec });
  const detailHtml = P.poolDetailMarkup({ id: 'B-1', kind: 'bug', type: 'bug', title: '缺陷', status: 'done', acceptanceRecord: item.rec });
  const rowLabel = labelFromMarkup(rowHtml, item.code);
  const detailLabel = labelFromMarkup(detailHtml, item.code);
  // 详情里标签后面跟验收时间（正文要求显示验收时间），所以详情按「标签开头 + 时间」判：
  // 标签本体必须逐字相等，时间只能是紧随其后的 " · <时间>" 尾巴。
  const detailOk = detailLabel === EXPECTED[item.code]
    || detailLabel.startsWith(EXPECTED[item.code] + ' · ');
  check(`AC10 三处同源（${item.name}）：列表行与详情标签逐字相同且等于 §二 标签`,
    Boolean(rowLabel) && rowLabel === detailLabel.split(' · ')[0] && detailOk && rowLabel === EXPECTED[item.code],
    { rowLabel, detailLabel, expect: EXPECTED[item.code] });
}
check('AC10 未验收的缺陷行不挂验收人小字徽标（不新增噪音）',
  !/pool-accept-by/.test(P.poolRowMarkup({ id: 'B-2', kind: 'bug', type: 'bug', title: '未验收缺陷', status: 'done' })), 'none-row');

/* ── 九、详情渲染：三类都出现这一行 + 锚点/副标/时间 ───────────────────── */
function detailOf(row) { return P.poolDetailMarkup(row); }
const ownerDetail = detailOf({ id: 'R-1', kind: 'requirement', title: '需求', acceptanceRecord: { status: 'accepted', by: 'owner', channel: 'ui', at: AT } });
check('需求详情：有「验收人」一行且 data-accept-by=owner + 标签【Owner 验收】',
  /验收人/.test(ownerDetail) && /data-accept-by="owner"/.test(ownerDetail) && ownerDetail.includes('【Owner 验收】'), 'requirement');
const bugDetail = detailOf({ id: 'B-1', kind: 'bug', type: 'bug', title: '缺陷', acceptanceRecord: { status: 'accepted', by: 'pm', channel: 'proxy', recordedBy: 'pm', at: AT, basis: BASIS, testGate: 'pm_signed' } });
check('缺陷详情：data-accept-by=pm_proxy + data-accept-test-gate=pm_signed', /data-accept-by="pm_proxy"/.test(bugDetail) && /data-accept-test-gate="pm_signed"/.test(bugDetail), 'bug');
const scenarioDetail = detailOf({ id: 'B-2', kind: 'scenario-bug', type: 'scenario-bug', title: '场景缺陷', scenario: '并发', acceptanceRecord: { status: 'accepted', by: 'pm', channel: 'proxy', at: AT } });
check('场景缺陷详情：同样有验收人行（pm_incomplete）', /data-accept-by="pm_incomplete"/.test(scenarioDetail), 'scenario-bug');
const noneDetail = detailOf({ id: 'R-2', kind: 'requirement', title: '未验收需求', status: 'test_done' });
check('未验收：显示「（未验收）」且 data-accept-by=none', /data-accept-by="none"/.test(noneDetail) && /（未验收）/.test(noneDetail), 'none');
check('详情带 data-accept-at 锚点', /data-accept-at="2026-11-15T01:30:00.000Z"/.test(ownerDetail), 'at');
check('验收人一行在「最近决策」之后（信息区同组）', ownerDetail.indexOf('最近决策') < ownerDetail.indexOf('验收人'), 'order');

/* ── 十、快照口径：判定函数不读文件、不要 await ──────────────────────── */
const src = fs.readFileSync(CORE, 'utf8');
const fnBody = src.slice(src.indexOf('function acceptByOf'), src.indexOf('function lastDecisionAt'));
check('acceptByOf 体内无 readFile/fs/IPC/await（只用快照）', !/readFile|require\(|await |ipcRenderer|fs\./.test(fnBody), 'pure');

/* ── 十一、回归：既有池断言不回归（模块导出齐全） ────────────────────── */
check('回归：poolRowMarkup / poolDetailMarkup / preparePoolRows 仍在导出里',
  typeof P.poolRowMarkup === 'function' && typeof P.poolDetailMarkup === 'function' && typeof P.preparePoolRows === 'function');
check('回归：preparePoolRows 产出的池行带 accept 字段（加载期一次性算好）', (() => {
  const rowsIn = P.preparePoolRows({ requirements: [{ id: 'R-20261115-000001-aaaa', title: '带验收记录', status: 'accepted', acceptanceRecord: { status: 'accepted', by: 'owner', channel: 'ui', at: AT } }], tasks: [] });
  return Boolean(rowsIn.length && rowsIn[0].accept && rowsIn[0].accept.code === 'owner');
})(), 'row.accept');

const outDir = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-62b9');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ at: new Date().toISOString(), total, failed, results: rows }, null, 2) + '\n', 'utf8');
console.log('\n合计 ' + total + ' 项，失败 ' + failed + ' 项');
if (!failed) console.log('POOL_ACCEPT_BY_OK');
process.exit(failed ? 1 : 0);
