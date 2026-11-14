#!/usr/bin/env node
'use strict';
/**
 * R-62b9 · 池详情显示验收人（data-accept-by 五值枚举 + data-accept-at + data-accept-test-gate 副标）
 *
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

/* ── 一、五值枚举 ─────────────────────────────────────────────────────── */
const cases = [
  {
    name: 'owner：Owner 本人验收（by=owner + channel=ui）',
    row: { acceptanceRecord: { status: 'accepted', by: 'owner', channel: 'ui', at: AT } },
    code: 'owner', label: 'Owner（本人）',
  },
  {
    name: 'owner：channel=tty 也算 Owner 本人',
    row: { acceptanceRecord: { status: 'accepted', by: 'owner', channel: 'tty', at: AT } },
    code: 'owner', label: 'Owner（本人）',
  },
  {
    name: 'pm_proxy：PM 代管验收（channel=proxy + recordedBy=pm + basis.proxy）',
    row: { acceptanceRecord: { status: 'accepted', by: 'pm', channel: 'proxy', recordedBy: 'pm', at: AT, basis: { proxy: { scope: 'all', startedAt: AT, authorization: 'Owner 授权' } } } },
    code: 'pm_proxy', label: 'PM（代管）',
  },
  {
    name: 'pm_incomplete：代管验收缺 basis.proxy（不冒充）',
    row: { acceptanceRecord: { status: 'accepted', by: 'pm', channel: 'proxy', recordedBy: 'pm', at: AT } },
    code: 'pm_incomplete', label: 'PM（代管记录缺依据）',
  },
  {
    name: 'pm：PM 非代管防御态（by=pm 但 channel 不是 proxy）',
    row: { acceptanceRecord: { status: 'accepted', by: 'pm', channel: 'ui', at: AT } },
    code: 'pm', label: 'PM',
  },
  {
    name: 'none：未验收（没有验收结论）',
    row: { status: 'test_done', decisions: [{ status: 'approved', at: AT }] },
    code: 'none', label: '（未验收）',
  },
];
for (const item of cases) {
  const got = P.acceptByOf(item.row);
  check(item.name, got.code === item.code && got.label === item.label, { code: got.code, label: got.label });
}

/* ── 二、决定来源：无 acceptanceRecord 时读 decisions[] 末条 ───────────── */
const viaDecision = P.acceptByOf({
  decisions: [
    { status: 'approved', at: '2026-11-14T10:00:00Z' },
    { status: 'accepted', channel: 'proxy', recordedBy: 'pm', decidedBy: 'pm', at: AT, basis: { proxy: { scope: 'all' } } },
  ],
});
check('无 acceptanceRecord：decisions 末条 accepted 也能判出 pm_proxy', viaDecision.code === 'pm_proxy' && viaDecision.at === AT, viaDecision);

const notAccepted = P.acceptByOf({ decisions: [{ status: 'rejected', channel: 'proxy', decidedBy: 'pm', at: AT }] });
check('末条不是 accepted → 未验收（评审决定不算验收人）', notAccepted.code === 'none', notAccepted);

/* ── 三、pm_signed 只作副标，不参与验收人取值 ─────────────────────────── */
const signed = P.acceptByOf({
  acceptanceRecord: { status: 'accepted', by: 'owner', channel: 'ui', at: AT, testGate: 'pm_signed' },
  decisions: [{ status: 'accepted', channel: 'proxy', recordedBy: 'pm', decidedBy: 'owner', at: AT, testGate: 'pm_signed', signedBy: 'pm' }],
});
check('pm_signed：验收人仍按「谁点+渠道」= owner（不被 pm_signed 抢走）', signed.code === 'owner' && signed.testGate === 'pm_signed', signed);
check('pm_signed 只作为 data-accept-test-gate 副标返回', signed.testGate === 'pm_signed');

/* ── 四、验收时间 ───────────────────────────────────────────────────── */
const withAt = P.acceptByOf({ acceptanceRecord: { status: 'accepted', by: 'owner', channel: 'ui', at: AT } });
check('data-accept-at 取 acceptanceRecord.at', withAt.at === AT, withAt.at);
const fallbackAt = P.acceptByOf({ acceptanceRecord: { status: 'accepted', by: 'owner' }, decisions: [{ status: 'accepted', channel: 'ui', decidedBy: 'owner', at: AT }] });
check('缺 acceptanceRecord.at 时回退 decisions.at', fallbackAt.at === AT, fallbackAt.at);

/* ── 五、详情渲染：三类都出现这一行 + 锚点/副标/时间 ───────────────────── */
function detailOf(row) { return P.poolDetailMarkup(row); }
const ownerDetail = detailOf({ id: 'R-1', kind: 'requirement', title: '需求', acceptanceRecord: { status: 'accepted', by: 'owner', channel: 'ui', at: AT } });
check('需求详情：有「验收人」一行且 data-accept-by=owner', /验收人/.test(ownerDetail) && /data-accept-by="owner"/.test(ownerDetail), 'requirement');
const bugDetail = detailOf({ id: 'B-1', kind: 'bug', type: 'bug', title: '缺陷', acceptanceRecord: { status: 'accepted', by: 'pm', channel: 'proxy', recordedBy: 'pm', at: AT, basis: { proxy: { scope: 'all' } }, testGate: 'pm_signed' } });
check('缺陷详情：data-accept-by=pm_proxy + data-accept-test-gate=pm_signed', /data-accept-by="pm_proxy"/.test(bugDetail) && /data-accept-test-gate="pm_signed"/.test(bugDetail), 'bug');
const scenarioDetail = detailOf({ id: 'B-2', kind: 'scenario-bug', type: 'scenario-bug', title: '场景缺陷', scenario: '并发', acceptanceRecord: { status: 'accepted', by: 'pm', channel: 'proxy', at: AT } });
check('场景缺陷详情：同样有验收人行（pm_incomplete）', /data-accept-by="pm_incomplete"/.test(scenarioDetail), 'scenario-bug');
const noneDetail = detailOf({ id: 'R-2', kind: 'requirement', title: '未验收需求', status: 'test_done' });
check('未验收：显示「（未验收）」且 data-accept-by=none', /data-accept-by="none"/.test(noneDetail) && /（未验收）/.test(noneDetail), 'none');
check('详情带 data-accept-at 锚点', /data-accept-at="2026-11-15T01:30:00.000Z"/.test(ownerDetail), 'at');
check('验收人一行在「最近决策」之后（信息区同组）', ownerDetail.indexOf('最近决策') < ownerDetail.indexOf('验收人'), 'order');

/* ── 六、快照口径：判定函数不读文件、不要 await ──────────────────────── */
const src = fs.readFileSync(CORE, 'utf8');
const fnBody = src.slice(src.indexOf('function acceptByOf'), src.indexOf('function lastDecisionAt'));
check('acceptByOf 体内无 readFile/fs/IPC/await（只用快照）', !/readFile|require\(|await |ipcRenderer|fs\./.test(fnBody), 'pure');

/* ── 七、回归：既有池断言不回归（模块导出齐全） ──────────────────────── */
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
