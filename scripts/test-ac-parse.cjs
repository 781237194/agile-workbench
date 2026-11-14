#!/usr/bin/env node
'use strict';
/**
 * R-5550 · 正文 AC 结构化解析/校验/统计 断言（F-5550-1/2/7）
 *
 * 被测：src/renderer/ac-parse.js（纯逻辑，Node 可 require）+ owner-review.js/main.js/index.html 接线。
 * 复跑：node scripts/test-ac-parse.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const A = require(path.join(ROOT, 'src', 'renderer', 'ac-parse.js'));
const REVIEW = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'owner-review.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

let total = 0;
let failed = 0;
const rows = [];
function check(name, ok, detail) {
  total += 1;
  if (!ok) failed += 1;
  rows.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 400)));
}

const STRUCTURED = [
  '# R-测试 · 评审弹窗 AC 结构化',
  '',
  '## 一、这是什么',
  '',
  '旧章节里也有同名文字： риск 无关。',
  '风险：这是章节里的风险文字，不属于任何 AC。',
  '',
  '## 二、验收标准',
  '',
  '### AC1（列表一眼看全）',
  '- 功能是什么：评审弹窗默认列出全部需求',
  '- 目的：Owner 不用逐条找',
  '- 风险：列表过长时首屏加载变慢',
  '- 风险处理：默认前 5 条折叠，其余按需展开',
  '- 拍板选项：',
  '  - A. 现在做：本轮就能看到全部需求',
  '  - B. 下轮做：本轮先保持现状，风险小',
  '',
  '### AC2（缺项演示）',
  '- 功能是什么：这条故意缺风险处理',
  '- 目的：验证缺项显式提示',
  '- 风险：提示不明显会漏看',
  '- 拍板选项：',
  '  - A. 立即标缺：Owner 能看见缺什么',
  '  - B. 不标缺：口径不符',
  '',
  '## 三、依赖与风险',
  '',
  '风险：块外同名字段，必须忽略',
  '',
].join('\n');

/* ── 一、解析：只认 AC 块内字段 ─────────────────────────────────────── */
const parsed = A.parseAcBlocks(STRUCTURED);
check('解析出 2 条 AC', parsed.acs.length === 2, parsed.acs.map((ac) => ac.id));
check('AC1 标题解析正确', parsed.acs[0].id === 'AC1' && parsed.acs[0].title === '列表一眼看全', parsed.acs[0].title);
check('AC1 四段齐全且值为正文原文', parsed.acs[0].what === '评审弹窗默认列出全部需求' && parsed.acs[0].purpose === 'Owner 不用逐条找'
  && /首屏加载变慢/.test(parsed.acs[0].risk) && /前 5 条折叠/.test(parsed.acs[0].mitigation), { risk: parsed.acs[0].risk, mitigation: parsed.acs[0].mitigation });
check('AC1 选项 2 条且各带后果', parsed.acs[0].options.length === 2 && parsed.acs[0].options.every((o) => o.consequence.length > 0), parsed.acs[0].options);
check('选项键 A/B 且标签正确', parsed.acs[0].options[0].key === 'A' && parsed.acs[0].options[0].label === '现在做', parsed.acs[0].options[0]);

/* ── 二、块外同名文字不得计入（AC7）────────────────────────────────── */
check('章节「依赖与风险」里的「风险：…」没被计入任何 AC', !parsed.acs.some((ac) => /块外同名字段/.test(ac.risk)), parsed.acs.map((ac) => ac.risk));

/* ── 三、校验：缺项清单（AC2/AC3）──────────────────────────────────── */
const validation = A.validateAcs(parsed.acs);
check('校验不通过（AC2 缺风险处理）', validation.ok === false && validation.total === 1, validation.issues);
check('缺项清单含 AC2 + 风险处理', validation.issues[0].acId === 'AC2' && validation.issues[0].missingFields.includes('风险处理'), validation.issues[0]);

const onlyPassFail = A.parseAcBlocks(['### AC1（只有通过打回）', '- 功能是什么：x', '- 目的：y', '- 风险：z', '- 风险处理：w', '- 拍板选项：', '  - A. 通过', '  - B. 打回'].join('\n'));
const pfValidation = A.validateAcs(onlyPassFail.acs);
check('选项缺后果 → 校验不通过（拍板选项-后果）', pfValidation.ok === false && pfValidation.issues[0].missingFields.includes('拍板选项-后果'), pfValidation.issues[0]);

const oneOption = A.parseAcBlocks(['### AC1（只有一个选项）', '- 功能是什么：x', '- 目的：y', '- 风险：z', '- 风险处理：w', '- 拍板选项：', '  - A. 只此一项：后果'].join('\n'));
check('选项只有 1 个 → 校验不通过（拍板选项）', A.validateAcs(oneOption.acs).issues[0].missingFields.includes('拍板选项'), A.validateAcs(oneOption.acs).issues[0]);

/* ── 四、旧正文 / 无块：structured=false（AC6 不报缺）──────────────── */
const oldDoc = ['# 旧需求', '', '## 一、这是什么', '', '就是一段自然语言。', '', '## 二、验收标准', '', '- AC1 打开能看到列表', '- AC2 点一下有反应'].join('\n');
const oldAnalysis = A.analyzeRequirement({ id: 'R-old', docText: oldDoc });
check('旧正文没有 AC 块 → structured=false、issues 为空（不报缺）', oldAnalysis.structured === false && oldAnalysis.issues.length === 0, oldAnalysis.issues);

/* ── 五、正文优先：docText > detail > acceptance ───────────────────── */
const fromDoc = A.analyzeRequirement({ id: 'R-1', docText: STRUCTURED, detail: '无结构 detail' });
check('docText 存在时按正文解析（忽略 detail 噪声）', fromDoc.structured === true && fromDoc.acs.length === 2, fromDoc.acs.length);
const fromDetail = A.analyzeRequirement({ id: 'R-2', detail: STRUCTURED });
check('没有 docText 时退回 detail 文本', fromDetail.structured === true && fromDetail.acs.length === 2);

/* ── 六、重复编号：取首个并记录 ──────────────────────────────────── */
const dup = A.parseAcBlocks(['### AC1（第一次）', '- 功能是什么：a', '### AC1（重复）', '- 功能是什么：b'].join('\n'));
check('AC 编号重复：只取首个并记录 duplicates', dup.acs.length === 1 && dup.acs[0].title === '第一次' && dup.duplicates.includes('AC1'), { acs: dup.acs.length, dup: dup.duplicates });

/* ── 七、看板五要素映射（AC5 / F-5550-4：与弹窗同一解析结果）──────────────── */
const boardRow = { id: 'R-A', __ac: A.analyzeRequirement({ id: 'R-A', docText: STRUCTURED }) };
const board = A.boardFieldsOf(boardRow);
check('看板映射：是什么=功能是什么', board && board.what === '评审弹窗默认列出全部需求', board && board.what);
check('看板映射：怎么做=功能+目的', board && /^功能：评审弹窗默认列出全部需求；目的：Owner 不用逐条找/.test(board.how), board && board.how);
check('看板映射：卡在哪=风险（不是状态文案）', board && /首屏加载变慢/.test(board.blocked), board && board.blocked);
check('看板映射：影响谁=目的', board && board.impact === 'Owner 不用逐条找', board && board.impact);
check('看板映射：建议拍板=逐项选项+后果', board && /A\. 现在做：本轮就能看到全部需求/.test(board.advice) && /B\. 下轮做：/.test(board.advice), board && board.advice);
check('看板映射：旧正文返回 null（保持五要素降级）', A.boardFieldsOf({ id: 'R-old' }) === null && A.boardFieldsOf({ id: 'R-old', __ac: { structured: false, acs: [] } }) === null);

/* ── 八、弹窗维度统计（F-5550-7）─────────────────────────────────── */
const r1 = { id: 'R-A', __ac: A.analyzeRequirement({ id: 'R-A', docText: STRUCTURED }) };
const r2 = { id: 'R-B', __ac: A.analyzeRequirement({ id: 'R-B', docText: oldDoc }) };
const stats = A.missingStats([r1, r2]);
check('缺项统计 total = 实际缺项条数（1）', stats.total === 1 && stats.items.length === 1, stats);
check('统计 items 含 requirementId + acId + missingFields', stats.items[0].requirementId === 'R-A' && stats.items[0].acId === 'AC2' && stats.items[0].missingFields.includes('风险处理'), stats.items[0]);
check('旧正文需求不进缺项统计', !stats.items.some((item) => item.requirementId === 'R-B'));

/* ── 八、接线静态断言 ──────────────────────────────────────────── */
check('owner-review.js：渲染 data-ac-id/what/purpose/risk/mitigation/options', ['data-ac-id', 'data-ac-what', 'data-ac-purpose', 'data-ac-risk', 'data-ac-mitigation', 'data-ac-options']
  .every((attr) => REVIEW.includes(attr)));
check('owner-review.js：弹窗根节点写 data-ac-missing-stats（JSON）', /setAttribute\('data-ac-missing-stats', JSON\.stringify\(acStats\)\)/.test(REVIEW));
check('owner-review.js：旧正文只提示一条（data-ac-structure-hint）', /data-ac-structure-hint/.test(REVIEW) && /部分需求正文未按 AC 结构写/.test(REVIEW));
check('owner-review.js：缺项显式文案「（正文缺：」且不再对结构化缺项拼兜底', /（正文缺：/.test(REVIEW) && /AC 结构但四段/.test(REVIEW));
check('owner-review.js：选项按钮带后果（data-ac-option-key）', /data-ac-option-key/.test(REVIEW));
check('main.js：owner:review-data 附带 docText（带 mtime 缓存）', /attachReviewDocText\(project/.test(MAIN) && /reviewDocCache/.test(MAIN));
check('index.html：ac-parse.js 在 owner-review.js 之前引入', (() => {
  const a = HTML.indexOf('<script src="ac-parse.js">');
  const b = HTML.indexOf('<script src="owner-review.js">');
  return a > 0 && b > 0 && a < b;
})());

const outDir = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-5550');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ at: new Date().toISOString(), total, failed, results: rows }, null, 2) + '\n', 'utf8');
console.log('\n合计 ' + total + ' 项，失败 ' + failed + ' 项');
if (!failed) console.log('AC_PARSE_OK');
process.exit(failed ? 1 : 0);
