#!/usr/bin/env node
'use strict';
/**
 * B-1358 · 验收列表四项前置状态（测试任务/测试报告/截图/Owner 决定）+ 缺失项去处 断言
 *
 * 被测：src/renderer/accept-prereq.js（纯逻辑，Node 可 require）+ owner-review.js/index.html/main.js 接线。
 * 复跑：node scripts/test-accept-prereq.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const P = require(path.join(ROOT, 'src', 'renderer', 'accept-prereq.js'));
const REVIEW = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'owner-review.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'style.css'), 'utf8');

let total = 0;
let failed = 0;
const rows = [];
function check(name, ok, detail) {
  total += 1;
  if (!ok) failed += 1;
  rows.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' · ' + JSON.stringify(detail)));
}

const baseRow = {
  id: 'R-20261115-000001-aaaa',
  status: 'test_done',
  ownerReview: { status: 'approved', at: '2026-11-14T10:00:00Z' },
  decisions: [{ status: 'approved', at: '2026-11-14T10:00:00Z' }],
  acceptance: { evidence: [{ path: '测试人员/产出/测试报告-v124.md', kind: 'report' }, { path: '证据/截图1.png', kind: 'image' }] },
};
const doneTestTask = {
  id: 'T-1', requirementId: 'R-20261115-000001-aaaa', owner: 'tester', status: 'done', title: '测试', evidence: '测试人员/产出/测试报告-v124.md',
};
const openTestTask = { ...doneTestTask, id: 'T-2', status: 'working' };

/* ── 一、四项全齐 → 可验收 ───────────────────────────────────────────── */
const full = P.acceptPrereq(baseRow, [doneTestTask]);
check('四项全齐：canAccept=true 且 checks 恰好四项', full.canAccept === true && full.checks.length === 4, full.checks.map((c) => c.key));
check('测试任务：done 的测试任务算通过', full.checks.find((c) => c.key === 'test_task').ok === true);
check('测试报告：kind=report 命中', full.checks.find((c) => c.key === 'test_report').ok === true && /测试报告-v124/.test(full.checks.find((c) => c.key === 'test_report').path));
check('截图：kind=image 命中', full.checks.find((c) => c.key === 'shot').ok === true);
check('Owner 决定：approved 算通过', full.checks.find((c) => c.key === 'owner_decision').ok === true);

/* ── 二、分别缺一项 → 不可验收且缺项可点名 ───────────────────────────── */
const noTask = P.acceptPrereq(baseRow, []);
check('没有测试任务 → 不可验收，缺项含「测试任务」', noTask.canAccept === false && noTask.missing.some((m) => m.key === 'test_task'), noTask.missing.map((m) => m.key));
const openTask = P.acceptPrereq(baseRow, [openTestTask]);
check('测试任务未完成 → 不可验收并给任务号', openTask.canAccept === false && /T-2/.test(openTask.checks.find((c) => c.key === 'test_task').reason), openTask.checks.find((c) => c.key === 'test_task').reason);

const noReportRow = { ...baseRow, acceptance: { evidence: [{ path: '证据/截图1.png', kind: 'image' }] }, acceptanceRecord: null };
const noReport = P.acceptPrereq(noReportRow, [doneTestTask]);
check('缺测试报告（但测试任务证据有 .md）→ 仍算有报告', noReport.checks.find((c) => c.key === 'test_report').ok === true, noReport.checks.find((c) => c.key === 'test_report').path);
const noReportAtAll = P.acceptPrereq({ ...baseRow, acceptance: { evidence: [] } }, [{ ...doneTestTask, evidence: '' }]);
check('彻底没有测试报告 → 不可验收', noReportAtAll.canAccept === false && noReportAtAll.missing.some((m) => m.key === 'test_report'), noReportAtAll.missing.map((m) => m.key));

const noShot = P.acceptPrereq({ ...baseRow, acceptance: { evidence: [{ path: '测试人员/产出/测试报告-v124.md', kind: 'report' }] } }, [{ ...doneTestTask, evidence: '' }]);
check('没有截图 → 不可验收且缺项含「截图」', noShot.canAccept === false && noShot.missing.some((m) => m.key === 'shot'), noShot.missing.map((m) => m.key));

/* ── 三、Owner 决定三态 ─────────────────────────────────────────────── */
const rejected = P.acceptPrereq({ ...baseRow, ownerReview: { status: 'rejected' }, decisions: [{ status: 'rejected' }] }, [doneTestTask]);
check('Owner 决定 rejected → 不可验收且原因提「打回」', rejected.canAccept === false && /打回/.test(rejected.checks.find((c) => c.key === 'owner_decision').reason), rejected.checks.find((c) => c.key === 'owner_decision').reason);
const pending = P.acceptPrereq({ ...baseRow, ownerReview: null, decisions: [] }, [doneTestTask]);
check('Owner 决定空（pending）→ 不可验收', pending.canAccept === false && pending.checks.find((c) => c.key === 'owner_decision').ok === false);
const skipped = P.acceptPrereq({ ...baseRow, ownerReview: { status: 'skipped' }, decisions: [{ status: 'skipped' }] }, [doneTestTask]);
check('Owner 决定 skipped → 可验收（与后端门槛一致）', skipped.canAccept === true);

/* ── 四、缺项都可点的去处（go 值）──────────────────────────────────── */
check('缺项带 go：测试报告→test_report、截图→shot、测试任务→test_task、Owner→owner_decision',
  ['test_report', 'shot', 'test_task', 'owner_decision'].every((key) => full.checks.some((c) => c.go === key)), full.checks.map((c) => c.go));
check('每项的 reason 非空（置灰要有原因）', full.checks.every((c) => String(c.reason || '').length > 0));

/* ── 五、证据识别：扩展名兜底（没声明 kind 也认）────────────────────── */
check('证据按扩展名兜底：.png 记截图', P.kindOfEvidence({ path: 'a.png' }) === 'image');
check('证据按扩展名兜底：.md 记报告', P.kindOfEvidence({ path: 'b.md' }) === 'report');
check('acceptanceRecord.testReport 也能当测试报告', P.acceptPrereq({ ...baseRow, acceptance: { evidence: [] }, acceptanceRecord: { testReport: '测试人员/产出/x.md', evidence: [{ path: 'y.png', kind: 'image' }] } }, []).checks.find((c) => c.key === 'test_report').ok === true);
check('任务级测试判定：tester/stage=test/标题含测试 都算', P.isTestTask({ owner: 'tester' }) && P.isTestTask({ workflow: { stage: 'test' } }) && P.isTestTask({ title: '测试收口' }) && !P.isTestTask({ owner: 'programmer1' }));

/* ── 六、接线静态断言 ───────────────────────────────────────────────── */
check('owner-review.js：每行渲染四项 data-accept-pre', /data-accept-pre=|setAttribute\('data-accept-pre'/.test(REVIEW) && /accept-prereq/.test(REVIEW));
check('owner-review.js：前置不齐时【通过】置灰并写 data-accept-blocked', /data-accept-blocked/.test(REVIEW) && /prereq\.canAccept/.test(REVIEW));
check('owner-review.js：错误横幅挂缺失项去处 data-accept-goto', /data-accept-goto/.test(REVIEW) && /appendMissingLinks\(err, row\)/.test(REVIEW));
check('owner-review.js：去处含 报告/截图/测试任务/Owner 决定 四种分支', /key === 'test_report'/.test(REVIEW) && /key === 'shot'/.test(REVIEW) && /key === 'test_task'/.test(REVIEW) && /Owner 决定/.test(REVIEW));
check('index.html：accept-prereq.js 在 owner-review.js 之前引入', (() => {
  const a = HTML.indexOf('<script src="accept-prereq.js">');
  const b = HTML.indexOf('<script src="owner-review.js">');
  return a > 0 && b > 0 && a < b;
})());
check('main.js：owner:review-data 带上 tasks（同一快照，不额外读盘）', /tasks: Array\.isArray\(snapshot\.tasks\)/.test(MAIN));
check('style.css：有前置标记样式 .accept-pre.ok/.bad', /\.accept-pre\.ok/.test(CSS) && /\.accept-pre\.bad/.test(CSS));

/* ── 七、回归：旧证据文案与既有字段不被破坏 ─────────────────────────── */
check('回归：evidenceTextOf 仍存在（旧证据行不受影响）', /function evidenceTextOf/.test(REVIEW));

const outDir = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-1358');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ at: new Date().toISOString(), total, failed, results: rows }, null, 2) + '\n', 'utf8');
console.log('\n合计 ' + total + ' 项，失败 ' + failed + ' 项');
if (!failed) console.log('ACCEPT_PREREQ_OK');
process.exit(failed ? 1 : 0);
