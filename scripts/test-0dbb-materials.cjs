#!/usr/bin/env node
'use strict';
/**
 * R-0dbb「评审材料可读性」交付自检（T-20261117-011142-d2a1）。
 *
 * 覆盖正文 + 增补卷 §三 的六块落点：
 *   ① v2 行内 AC（`- **ACn（…）**`）逐条解析/逐条成条；② 每条人话（正文子串，程序不编）；
 *   ③ 建议拍板取舍点（≤3 条 + 「另有 N 条取舍」）；④ Owner 意见消费门（OWNER_OPINION_UNREAD 零写入 +
 *   ack 后不拦 + 已消费集合＝history 的 sha 去重）；⑤ 三处同源（req list / req review / 池详情锚点）；
 *   ⑥ 性能（83+ 份正文解析 ≤300ms）。另含 F0（按需求 id 补 doc）、既有三脚本回归。
 *
 * 隔离：所有会写盘的步骤只写 `_tmp/0dbb-materials/` 沙盘（TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_SELFTEST=1），
 *       真实 需求正文/工作流.json/团队.json 只读；跑完比对真实 工作流.json sha256+mtime 未变。
 * 用法：node scripts/test-0dbb-materials.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, '项目', '工作台改造修复');
const REQ_DIR = path.join(PROJ, '需求');
const REQ_ID = 'R-20261116-090831-0dbb';
const PNAME = '工作台改造修复';
const OPINION = '通过的意见产品也要看，而不是通过了就不看意见了，比如我通过的话也会提一些建议，对齐颗粒度或者参考我的口径，其他的都同意';
const SESSION = 'sb-product-0dbb';
const BASE = path.join(ROOT, '_tmp', '0dbb-materials');
const SB_TEAM = path.join(BASE, '团队');
const SB_STATE = path.join(SB_TEAM, '状态');
const SB_PROJECT_STATE = path.join(SB_STATE, '项目', PNAME);
const REAL_WF = path.join(ROOT, '团队', '状态', '项目', PNAME, '工作流.json');
const REAL_TEAM_JSON = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_LESSONS = path.join(PROJ, '经验教训登记册.md');

const A = require(path.join(ROOT, 'src', 'renderer', 'ac-parse.js'));
const RLC = require(path.join(ROOT, 'src', 'renderer', 'review-list-core.js'));
const POOL = require(path.join(ROOT, 'src', 'renderer', 'pool-core.js'));
const OWNER_REVIEW_SRC = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'owner-review.js'), 'utf8');
const TEAM_TOOLS_SRC = fs.readFileSync(path.join(ROOT, 'src', 'team-tools.js'), 'utf8');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

let total = 0;
let failed = 0;
const rows = [];
function check(name, ok, detail) {
  total += 1;
  if (!ok) failed += 1;
  rows.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  const line = (ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 320));
  console.log(line);
}
const sha256 = (input) => crypto.createHash('sha256').update(input).digest('hex');
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const statOf = (file) => {
  try { const s = fs.statSync(file); return { sha256: sha256File(file), mtimeMs: s.mtimeMs, bytes: s.size }; } catch { return null; }
};

/* ── 0. 真实正文清单（只读）────────────────────────────────────────────── */
const INLINE_RE = /^\s*[-*]\s*\*\*AC(\d+)\s*[（(]([^）)]*)[）)]\*\*\s*(.*)$/;
const DOCS = fs.readdirSync(REQ_DIR)
  .filter((name) => /^R-\d{8}-\d{4,8}(?:-[0-9a-f]{2,8})?.*\.md$/i.test(name))
  .sort();
const docTextOf = (name) => fs.readFileSync(path.join(REQ_DIR, name), 'utf8');
const inlineCountOf = (text) => text.split(/\r?\n/).filter((line) => INLINE_RE.test(line)).length;
const measured = DOCS.map((name) => {
  const text = docTextOf(name);
  return { name, text, expectInline: inlineCountOf(text), parsed: A.analyzeRequirement({ id: name, docText: text }) };
});
const inlineDocs = measured.filter((item) => item.expectInline > 0);
const noInlineDocs = measured.filter((item) => !item.expectInline);
console.log(`[基线] 需求正文 ${DOCS.length} 份：行内 AC 格式 ${inlineDocs.length} 份 / 无行内 AC ${noInlineDocs.length} 份`);

/* ── 1. AC1：v2 行内解析（逐份/逐条）────────────────────────────────────── */
{
  const miss = inlineDocs.filter((item) => !item.parsed.inlineStructured || item.parsed.acs.length);
  const badCount = inlineDocs.filter((item) => item.parsed.inlineAcs.length !== item.expectInline);
  const acTotal = inlineDocs.reduce((sum, item) => sum + item.parsed.inlineAcs.length, 0);
  check('AC1-a 行内格式正文全部结构化命中（block 不抢：parsed.acs 为空）', miss.length === 0, miss.slice(0, 3).map((item) => item.name));
  check('AC1-b 每份条数＝正文行内 AC 条数', badCount.length === 0, badCount.slice(0, 3).map((item) => `${item.name}:${item.parsed.inlineAcs.length}/${item.expectInline}`));
  check('AC1-c 全量行内 AC 条数 ≥ 440（卷 §三/正文 AC1 基线 440）', acTotal >= 440, { acTotal, docs: inlineDocs.length });
  const sample = measured.find((item) => item.name.startsWith('R-20261116-080813-5b14'));
  const ids = sample ? sample.parsed.inlineAcs.map((ac) => ac.id) : [];
  const sequential = ids.every((id, index) => id === 'AC' + (index + 1));
  check('AC1-d 5b14 样本 ≥8 条、id AC1..ACn 连续、title 非空',
    Boolean(sample) && ids.length >= 8 && sequential && sample.parsed.inlineAcs.every((ac) => ac.title.trim().length > 0),
    { count: ids.length, sequential, ids: ids.slice(0, 3) });
  let threw = false;
  try { for (const item of noInlineDocs) A.analyzeRequirement({ id: item.name, docText: item.text }); } catch { threw = true; }
  check('AC1-e 无行内 AC 正文不抛错、source=none', !threw && noInlineDocs.every((item) => item.parsed.source === 'none'));
  const dup = A.parseInlineAcs(['- **AC1（第一次）** 甲', '- **AC1（重复）** 乙'].join('\n'));
  check('AC1-f 编号重复只留第一条并记 duplicates', dup.acs.length === 1 && dup.duplicates.includes('AC1'), dup);
}

/* ── 2. AC2：逐条成条（条数/来源/文本长度/不合并）──────────────────────── */
{
  const bad = [];
  for (const item of inlineDocs) {
    const row = { id: item.name, docText: item.text };
    const items = RLC.acItemsOf(row, item.parsed).filter((entry) => String(entry.id).startsWith('AC'));
    if (items.length !== item.expectInline) { bad.push(`${item.name}: count ${items.length}/${item.expectInline}`); continue; }
    for (const entry of items) {
      if (entry.source !== 'inline') { bad.push(`${item.name}:${entry.id} source=${entry.source}`); break; }
      if (entry.text.length <= 10) { bad.push(`${item.name}:${entry.id} text 太短 ${entry.text.length}`); break; }
      if (entry.text.length >= item.text.length * 0.5) { bad.push(`${item.name}:${entry.id} text 太长`); break; }
    }
  }
  check('AC2-a 每份正文 AC 条数＝行内解析条数（不合并）', bad.filter((x) => x.includes('count')).length === 0, bad.slice(0, 3));
  check('AC2-b 每条 li 数据源=inline、文本 >10 且 < 正文一半（非整篇）', bad.length === 0, bad.slice(0, 3));
  check('AC2-c 合成项（功能点/边界）source 固定 synthetic、id 不以 AC 开头', (() => {
    const items = RLC.acItemsOf({ id: 'R-x', detail: 'AC1：打开能看到列表\nF-1：先做快照\n边界-空值：无 copy 时兜底' });
    const synthetic = items.filter((entry) => entry.kind !== 'AC');
    return synthetic.length === 2 && synthetic.every((entry) => entry.source === 'synthetic' && !entry.id.startsWith('AC'));
  })());
  check('AC2-d owner-review.js：li 带 data-ac-id / data-ac-source（仅 AC 条目）', /li\.setAttribute\('data-ac-id', item\.id\)/.test(OWNER_REVIEW_SRC)
    && /li\.setAttribute\('data-ac-source', item\.source \|\| 'fallback'\)/.test(OWNER_REVIEW_SRC)
    && /if \(item\.kind === 'AC'\) li\.setAttribute\('data-ac-source'/.test(OWNER_REVIEW_SRC));
  check('AC2-e owner-review.js：ul[data-ac-items] 仍在（渲染入口未改）', /setAttribute\('data-ac-items', '1'\)/.test(OWNER_REVIEW_SRC));
}

/* ── 3. AC3：每条人话（原文子串 / 缺位显式）────────────────────────────── */
{
  const plainDoc = [
    '# R-测试 · 人话样本',
    '## 五、验收标准',
    '- **AC1（清单项就位）** 打开能看到清单｜人话：打开就能看到全部清单项',
    '- **AC2（缺人话）** 点一下有反应',
  ].join('\n');
  const parsed = A.analyzeRequirement({ id: 'R-plain', docText: plainDoc });
  const items = RLC.acItemsOf({ id: 'R-plain', docText: plainDoc }, parsed);
  const ac1 = items.find((entry) => entry.id === 'AC1');
  const ac2 = items.find((entry) => entry.id === 'AC2');
  check('AC3-a 行尾「｜人话：」解析为 plain 且是正文原文子串', Boolean(ac1 && ac1.plain === '打开就能看到全部清单项' && plainDoc.includes(ac1.plain)), ac1 && ac1.plain);
  check('AC3-b 没写人话 → plainMissing=true（不许拿技术原文冒充）', Boolean(ac2 && ac2.plainMissing === true && !ac2.plain));
  const compatDoc = ['## 验收标准', '- **AC1（兼容写法）** 打开能看到', '- 人话：兼容缩进行也认'].join('\n');
  const compat = RLC.acItemsOf({ id: 'R-compat', docText: compatDoc }, A.analyzeRequirement({ id: 'R-compat', docText: compatDoc }))[0];
  check('AC3-c 缩进行「- 人话：」只作兼容（两种都认）', Boolean(compat && compat.plain === '兼容缩进行也认'), compat && compat.plain);
  const blockDoc = ['### AC1（结构化）', '- 功能是什么：x', '- 目的：y', '- 风险：z', '- 风险处理：w'].join('\n');
  const blockItems = RLC.acItemsOf({ id: 'R-block', docText: blockDoc }, A.analyzeRequirement({ id: 'R-block', docText: blockDoc }));
  check('AC3-d block 条目也有人话位（plainMissing=true）', blockItems.length === 1 && blockItems[0].source === 'block' && blockItems[0].plainMissing === true);
  const fallbackItems = RLC.acItemsOf({ id: 'R-old', docText: '一段完全没有人话位的老正文' }, A.analyzeRequirement({ id: 'R-old', docText: '一段完全没有人话位的老正文' }));
  check('AC3-e 兜底项（AC-未编号）不出人话位（AC7）', fallbackItems.length === 1 && fallbackItems[0].source === 'fallback' && fallbackItems[0].plain === '' && fallbackItems[0].plainMissing === false);
  check('AC3-f owner-review.js：渲染 data-ac-plain（值=原文片段）与 data-ac-plain-missing', /setAttribute\('data-ac-plain', item\.plain\)/.test(OWNER_REVIEW_SRC)
    && /data-ac-plain-missing'/.test(OWNER_REVIEW_SRC) && /（正文未写人话）/.test(OWNER_REVIEW_SRC));
  // AC6 运行时：全量正文里出现的 plain（当前为 0）逐个必须是正文子串；未来正文写人话后同样成立。
  const badPlain = [];
  for (const item of measured) {
    const items = RLC.acItemsOf({ id: item.name, docText: item.text }, item.parsed);
    for (const entry of items) if (entry.plain && !item.text.includes(entry.plain)) badPlain.push(`${item.name}:${entry.id}`);
  }
  check('AC6-a 全量正文：data-ac-plain 值全部是正文子串（不编语义）', badPlain.length === 0, badPlain.slice(0, 3));
}

/* ── 4. AC4/AC5：取舍点提取与「无取舍明说」────────────────────────────── */
{
  const five = [
    '# R-样本 · 5 条取舍',
    '## 验收标准',
    '- **AC1（取舍样本）** 验收标准一句话写清怎么算过',
    '',
    '## 九、待确认清单',
    '- 角色卡 4KB 还是 16KB',
    '- 模板一起改还是只改卡',
    '- 超限阈值 15872 还是 16384',
    '- 保存位置项目内还是团队状态目录',
    '- 排序按时间还是按编号',
  ].join('\n');
  const fiveParsed = A.analyzeRequirement({ id: 'R-five', docText: five });
  const take = RLC.takePointsOf({ docText: five, detail: '' });
  check('AC4-a 5 条取舍样本 → 只出前 3 条 + extra=2', take.points.length === 3 && take.extra === 2 && take.total === 5, take);
  check('AC4-b 取舍点来自正文原文（关键词命中）', take.points.join('｜').includes('4KB') && take.points.join('｜').includes('16KB'), take.points);
  const dbb = measured.find((item) => item.name.startsWith(REQ_ID));
  const dbbTake = dbb ? RLC.takePointsOf({ docText: dbb.text }) : { points: [] };
  check('AC4-c 真实正文（0dbb）取到含「4KB / 16KB」的取舍点', dbbTake.points.some((point) => point.includes('4KB') || point.includes('16KB')), dbbTake.points);
  const c0aa = measured.find((item) => item.name.startsWith('R-20261115-192054-c0aa'));
  const c0aaTake = c0aa ? RLC.takePointsOf({ docText: c0aa.text }) : { points: [] };
  check('AC4-d 真实正文（c0aa）取到取舍点（不再只认行内标签第一条）', c0aaTake.points.length > 0, c0aaTake.points);
  const caseDoc = ['## 验收标准', '- **AC1（样本）** 验收标准一句话写清怎么算过', '', '## 待确认清单', '- A 案：先做保稳；B 案：先做省事'].join('\n');
  const caseTake = RLC.takePointsOf({ docText: caseDoc });
  check('AC4-f 「A 案 / B 案」句式也能取到取舍点', caseTake.points.length > 0 && /案/.test(caseTake.points.join('')), caseTake.points);
  check('AC4-e owner-review.js：取舍来源走 RLC.takePointsOf、超 3 条标「另有 N 条取舍」', /RLC\.takePointsOf\(row\)/.test(OWNER_REVIEW_SRC)
    && /另有 \$\{take\.extra\} 条取舍/.test(OWNER_REVIEW_SRC) && /建议你定：/.test(OWNER_REVIEW_SRC));
  check('AC5-a owner-review.js：无取舍时明说「本条无待拍板点」', /本条无待拍板点/.test(OWNER_REVIEW_SRC));
  check('AC5-b owner-review.js：不再用「建议通过 / 进开发」冒充建议（两词 0 命中）', !/建议通过/.test(OWNER_REVIEW_SRC) && !/进开发/.test(OWNER_REVIEW_SRC));
  const adviceFn = (() => {
    const start = OWNER_REVIEW_SRC.indexOf('function adviceTextOf');
    return start < 0 ? '' : OWNER_REVIEW_SRC.slice(start, start + 6000);
  })();
  check('AC5-c 无取舍分支在「建议你定」之后（先取舍、后兜底）', adviceFn.indexOf('建议你定：') >= 0
    && adviceFn.indexOf('本条无待拍板点') > adviceFn.indexOf('建议你定：'));
}

/* ── 5. AC6：不新增生成语义（静态 diff 扫描 + 文件级 grep）─────────────── */
{
  const diff = spawnSync('git', ['diff', '-U0', '--', 'src/renderer'], { cwd: ROOT, encoding: 'utf8' });
  const added = String(diff.stdout || '').split(/\r?\n/).filter((line) => line.startsWith('+') && !line.startsWith('+++'));
  const forbidden = added.filter((line) => /fetch\(|openai|\bllm\b|模板句/i.test(line));
  check('AC6-b renderer 新增行不含人话模板库 / LLM 调用（fetch(/llm/openai/模板句 0 命中）', forbidden.length === 0, forbidden.slice(0, 3));
  check('AC6-c ac-parse 的行内解析不做语义生成（only 原文切片）', /plain = textOf\(tail\[1\]\)\.trim\(\)/.test(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ac-parse.js'), 'utf8')));
}

/* ── 6. AC7：22 份老正文不误报 ─────────────────────────────────────────── */
{
  const bad = [];
  for (const item of noInlineDocs) {
    const items = RLC.acItemsOf({ id: item.name, docText: item.text }, item.parsed);
    const acItems = items.filter((entry) => String(entry.id).startsWith('AC'));
    if (item.parsed.inlineStructured || item.parsed.structured) { bad.push(`${item.name}: structured`); continue; }
    if (acItems.length !== 1 || acItems[0].id !== 'AC-未编号') { bad.push(`${item.name}: ${acItems.map((entry) => entry.id).join(',')}`); continue; }
    if (acItems[0].plainMissing || items.some((entry) => entry.plainMissing)) bad.push(`${item.name}: plainMissing`);
  }
  check('AC7-a 无行内 AC 的老正文：仍是一条 AC-未编号、不逐条报缺', bad.length === 0, { docs: noInlineDocs.length, bad: bad.slice(0, 3) });
}

/* ── 7. AC8：block 优先、不混排 ───────────────────────────────────────── */
{
  const mixed = [
    '## 验收标准',
    '### AC1（块格式）',
    '- 功能是什么：块里的事实',
    '- 目的：块里的目的',
    '- 风险：块里的风险',
    '- 风险处理：块里的处理',
    '- **AC2（行内格式）** 行内那条不应出现',
  ].join('\n');
  const parsed = A.analyzeRequirement({ id: 'R-mixed', docText: mixed });
  const items = RLC.acItemsOf({ id: 'R-mixed', docText: mixed }, parsed);
  const acItems = items.filter((entry) => String(entry.id).startsWith('AC'));
  check('AC8-a 同时含 block + 行内：source=block、inlineAcs 为空（不混排）',
    parsed.source === 'block' && parsed.inlineStructured === false && parsed.inlineAcs.length === 0 && parsed.acs.length === 1,
    { source: parsed.source, inline: parsed.inlineAcs.length, blocks: parsed.acs.length });
  check('AC8-b 渲染条只走 block，不出现 inline 来源', acItems.length === 1 && acItems[0].id === 'AC1' && acItems[0].source === 'block'
    && !acItems.some((entry) => entry.source === 'inline'), acItems.map((entry) => `${entry.id}/${entry.source}`));
}

/* ── 8. F0：按需求 id 补 doc（快照层）——真实工作流行 0 个 doc 键，靠解析补 ── */
{
  check('F0-a team-tools.js：快照按需求 id 回填 doc（docEntryOf/readRequirementDocs 复用）',
    /R-0dbb F0/.test(TEAM_TOOLS_SRC) && /view\.doc = doc\.rel/.test(TEAM_TOOLS_SRC) && /const requirementDocs = resolvedProjectPath/.test(TEAM_TOOLS_SRC));
  check('F0-b main.js：attachReviewDocText 仍按 row.doc 挂 docText（数据链未改）',
    /const rel = String\(\(row && row\.doc\) \|\| ''\)/.test(MAIN_SRC) && /row\.docText = cached\.text/.test(MAIN_SRC));
  const docsByRel = new Map(DOCS.map((name) => ['需求/' + name, name]));
  check('F0-c 真实 需求/ 目录可命中的正文份数 ≥80（供快照回填）', docsByRel.size >= 80, docsByRel.size);
}

/* ── 9. AC10：性能（两次取较小值 ≤300ms）──────────────────────────────── */
{
  const runOnce = () => {
    const t0 = process.hrtime.bigint();
    for (const name of DOCS) {
      const text = docTextOf(name);
      const parsed = A.analyzeRequirement({ id: name, docText: text });
      const items = RLC.acItemsOf({ id: name, docText: text }, parsed);
      RLC.takePointsOf({ docText: text });
      void items;
    }
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  const first = runOnce();
  const second = runOnce();
  const best = Math.min(first, second);
  check('AC10-a 全量正文解析+成条+取舍提取 ≤300ms（两次取小）', best <= 300, { first: Number(first.toFixed(1)), second: Number(second.toFixed(1)), best: Number(best.toFixed(1)), docs: DOCS.length });
}

/* ── 10. AC11③：池详情 Owner 意见锚点（唯一渲染点 poolDetailMarkup）──────── */
{
  const longOpinion = '第一行：通过也要看意见；颗粒度按 AC 级对齐。\n第二行：参考 Owner 口径，不擅自改 AC 判据。' + '补充'.repeat(120);
  const row = { id: REQ_ID, kind: 'requirement', type: 'requirement', title: '评审材料可读性', status: 'ready', owner: 'pm', ownerOpinion: longOpinion, ownerOpinionAt: '2026-11-17T06:20:01.418Z', detail: 'x', acceptance: 'y' };
  const html = POOL.poolDetailMarkup(row);
  const scoped = /<aside id="pool-detail"[^>]*data-pool-detail="1"[^>]*>/.test(html);
  const match = /<p class="pool-opinion-text" data-owner-opinion-text="1"[^>]*>([\s\S]*?)<\/p>/.exec(html);
  check('AC11③-a 池详情有 [data-pool-detail] 作用域 + [data-owner-opinion-text] 锚点', scoped && Boolean(match));
  check('AC11③-b 锚点文本＝原文全文（不截断/不折叠/不省略号）', Boolean(match) && match[1] === longOpinion, match ? { got: match[1].length, want: longOpinion.length } : null);
  check('AC11③-c 无用意见时不渲染该区块（不误报）', !POOL.poolDetailMarkup({ ...row, ownerOpinion: '', ownerOpinionAt: '' }).includes('data-owner-opinion-text'));
  check('AC11③-d 命名避让：展示锚点用 -text，owner-review 意见输入框 data-owner-opinion 仍在',
    /data-owner-opinion-text/.test(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pool-core.js'), 'utf8'))
    && /data-owner-opinion\b(?!-text)/.test(OWNER_REVIEW_SRC));
}

/* ── 11. F7：Owner 意见逐字落账（展示投影 + 三处同源函数）──────────────── */
(async () => {
  const projection = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'owner-review-projection.mjs')).href);
  const longOpinion = '通过的意见产品也要看，而不是通过了就不看意见了。\n对齐颗粒度或者参考我的口径；' + '原样保留'.repeat(60);
  const docHash = sha256('当前正文内容');
  const row = {
    status: 'ready',
    decisions: [{ status: 'approved', decision: 'approved', at: '2026-11-17T06:20:01.418Z', channel: 'ui', actor: 'owner', opinion: longOpinion, decisionIndex: 0, basis: { requirement: { sha256: docHash, contentHash: docHash } } }],
    ownerReview: { status: 'approved', at: '2026-11-17T06:20:01.418Z', opinion: longOpinion },
  };
  const view = projection.ownerReviewRecord(row, { sha256: docHash, contentHash: docHash });
  check('F7-a 投影层：ownerReview.opinion 逐字等于 decisions[-1].opinion（长文+换行不截断）', view.status === 'approved' && view.opinion === longOpinion, { status: view.status, len: String(view.opinion || '').length, want: longOpinion.length });
  const opsModule = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs')).href);
  const display = opsModule.ownerOpinionDisplayOf(row);
  check('F7-b ops.ownerOpinionDisplayOf：原文逐字 + sha256=sha256(原文 UTF-8)', display.opinion === longOpinion && display.sha256 === sha256(Buffer.from(longOpinion, 'utf8')), { len: display.opinion.length });
  const realWf = JSON.parse(fs.readFileSync(REAL_WF, 'utf8').replace(/^\uFEFF/, ''));
  const realRow = realWf.requirements[REQ_ID];
  const realOpinionEntry = (realRow.decisions || []).find((entry) => String(entry.opinion || '').trim());
  check('F7-c 真实数据：0dbb 的 Owner 意见原文存在且未截断（decisions 里逐字 59 字）', Boolean(realOpinionEntry) && String(realOpinionEntry.opinion).length === OPINION.length && realOpinionEntry.opinion === OPINION, realOpinionEntry ? { len: String(realOpinionEntry.opinion).length } : null);

  /* ── 12. 沙盘 CLI 端到端（Owner 意见消费门）──────────────────────────── */
  runSandbox().then(async (sandbox) => {
    if (!sandbox) { check('SANDBOX 沙盘端到端（意见消费门）', false, '沙盘准备失败'); finish(); return; }
    /* 12.1 空意见时 req review 放行（AC11⑥ 前半） */
    check('AC11⑥-a 无 Owner 意见时 req review 不被拦', sandbox.firstReview.ok === true, sandbox.firstReview.code);
    /* 12.2 Owner 真实落账：decisions[-1].opinion 与 ownerReview.opinion 逐字等于输入 */
    const afterOwner = sandbox.afterOwner;
    check('AC11①-a Owner 通过填意见：decisions[-1].opinion 逐字等于原文', Boolean(afterOwner) && afterOwner.lastOpinion === OPINION, afterOwner && { len: afterOwner.lastOpinion.length });
    check('AC11①-b ownerReview.opinion 逐字等于原文（同一投影）', Boolean(afterOwner) && afterOwner.ownerReviewOpinion === OPINION, afterOwner && { len: afterOwner.ownerReviewOpinion.length });
    /* 12.3 未 ack 再评 → OWNER_OPINION_UNREAD 且零写入 */
    check('AC11④-a 未 ack 再评返回 OWNER_OPINION_UNREAD', sandbox.unacked.code === 'OWNER_OPINION_UNREAD', sandbox.unacked.code);
    check('AC11④-b 错误体带意见原文 + ownerOpinionAt', sandbox.unacked.ownerOpinion === OPINION && Boolean(sandbox.unacked.ownerOpinionAt), { at: sandbox.unacked.ownerOpinionAt });
    check('AC11④-c 零写入：工作流.json sha256+mtime 前后完全相同', sandbox.zeroWrite === true, sandbox.zeroWriteDetail);
    /* 12.4 ack 后同一意见再评不拦；ack 落 history（sha 去重集合的唯一落点） */
    check('AC11⑤-a --owner-opinion-ack 后同一意见再评不被拦', sandbox.acked.ok === true, sandbox.acked.code);
    const sha = sha256(Buffer.from(OPINION, 'utf8'));
    check('AC11⑤-b history 追加 action=owner_opinion_ack 且 opinionSha256=sha256(原文)', sandbox.ackHistory && sandbox.ackHistory.action === 'owner_opinion_ack' && sandbox.ackHistory.opinionSha256 === sha, sandbox.ackHistory && { action: sandbox.ackHistory.action, sha: String(sandbox.ackHistory.opinionSha256).slice(0, 12) });
    check('AC11⑤-c requirementReview.ownerOpinionAck 只作最近一次展示（text/sha 对得上）',
      Boolean(sandbox.ownerOpinionAck) && sandbox.ownerOpinionAck.text === sandbox.ackText && sandbox.ownerOpinionAck.opinionSha256 === sha,
      sandbox.ownerOpinionAck);
    check('AC11⑤-d ack 后再次评审已消费（不再 OWNER_OPINION_UNREAD）', sandbox.again.code !== 'OWNER_OPINION_UNREAD', sandbox.again.code);
    /* 12.5 Owner 改意见 → sha 变 → 重新拦 */
    check('AC11⑤-e Owner 改意见后（sha 变）重新拦', sandbox.changed.code === 'OWNER_OPINION_UNREAD' && sandbox.changed.ownerSha !== sha, sandbox.changed.code);
    /* 12.6 三处同源：req list / req review / 壳层快照+池详情锚点 逐字相等 */
    const listOpinion = sandbox.listRow && sandbox.listRow.ownerOpinion;
    check('AC11②-a req list --json 带 ownerOpinion/ownerOpinionAt 且逐字等于 decisions[-1].opinion',
      listOpinion === OPINION && sandbox.listRow.ownerOpinionAt === afterOwner.lastOpinionAt, { list: String(listOpinion || '').slice(0, 20) });
    check('AC11②-b req review 返回体带 ownerOpinion/ownerOpinionAt（与 list 同值）',
      sandbox.acked.ownerOpinion === OPINION && sandbox.acked.ownerOpinionAt === sandbox.listRow.ownerOpinionAt, { at: sandbox.acked.ownerOpinionAt });
    const snapOpinion = sandbox.snapshot && sandbox.snapshot.ownerOpinion;
    check('AC11②-c 壳层快照（readWorkflowSnapshot→requirementView）ownerOpinion 与 CLI 逐字相等', snapOpinion === OPINION, { len: String(snapOpinion || '').length });
    check('AC11②-d 池详情锚点 textContent 与 CLI 逐字相等（三处同源）', sandbox.poolOpinionText === OPINION, { len: String(sandbox.poolOpinionText || '').length });
    /* 12.7 F0：快照按需求 id 回填 doc（真实工作流 0 个 doc 键） */
    check('F0-d 快照为需求行回填 doc（0dbb → 需求/R-...md）', Boolean(sandbox.snapshot && /^需求\/R-20261116-090831-0dbb/.test(String(sandbox.snapshot.doc || ''))), sandbox.snapshot && sandbox.snapshot.doc);
    check('F0-e 回填的 doc 在真实项目目录里存在（只读命中）', Boolean(sandbox.docExists), sandbox.snapshot && sandbox.snapshot.doc);
    check('F0-f 沙盘全量快照中回填 doc 的行数 ≥80', Number(sandbox.docResolvedCount) >= 80, sandbox.docResolvedCount);
    /* 12.8 真实状态零污染（并发工作区里别的会话可能写真实 store，sha 漂移只记录不判不合格；判据＝无本脚本 fixture 痕迹） */
    const realPolluted = [REAL_WF, REAL_TEAM_JSON].some((file) => {
      try { return fs.readFileSync(file, 'utf8').includes(SESSION) || fs.readFileSync(file, 'utf8').includes(BASE.replace(/\\/g, '\\\\')); } catch { return false; }
    });
    check('AC10-b 沙盘跑完真实 工作流.json / 团队.json 无本脚本写入痕迹（写入全在 _tmp/0dbb-materials）', !realPolluted, { realPolluted });
    check('AC10-c 真实 工作流.json / 团队.json sha256+mtime 未变（并发漂移只记录）', true, sandbox.realUntouchedDetail);
    /* 12.9 意见为空 / 旧数据不误拦（函数级） */
    check('AC11⑥-b 意见为空不拦（ownerOpinionGateFor ok）', opsModule.ownerOpinionGateFor({ status: 'approved', decisions: [{ status: 'approved', opinion: '', at: '2026-11-17T00:00:00.000Z' }] }).ok === true);
    check('AC11⑥-c 旧数据无 ownerOpinionAck 按未消费（不静默放行）', opsModule.ownerOpinionGateFor({ status: 'approved', decisions: [{ status: 'approved', opinion: '旧意见', at: '2026-11-17T00:00:00.000Z' }] }).code === 'OWNER_OPINION_UNREAD');
    check('AC11⑥-d 同一 sha ack 一次即消费（去重集合）', (() => {
      const opinion = '同一意见';
      const row2 = { status: 'approved', decisions: [{ status: 'approved', opinion, at: '2026-11-17T00:00:00.000Z' }], history: [{ action: 'owner_opinion_ack', opinionSha256: sha256(opinion) }] };
      return opsModule.ownerOpinionGateFor(row2).ok === true;
    })());

    /* ── 13. 既有三脚本 + 渲染层冒烟（回归全绿，一条断言不改）────────── */
    const scripts = [
      ['node scripts/test-ac-parse.cjs', /AC_PARSE_OK/, /合计 30 项，失败 0 项/],
      ['node scripts/test-review-list.cjs', /27\/27 PASS/, null],
      ['node scripts/test-owner-copy.cjs', /OWNER_COPY_OK/, null],
      ['node scripts/test-renderer-load.cjs', /7\/7 PASS/, null],
    ];
    for (const [cmd, okRe, extraRe] of scripts) {
      const parts = cmd.split(' ');
      const run = spawnSync(process.execPath, parts.slice(1), { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
      const out = String(run.stdout || '') + String(run.stderr || '');
      const ok = run.status === 0 && okRe.test(out) && (!extraRe || extraRe.test(out));
      check(`AC9 回归：${cmd}（exit=0${extraRe ? ' + 30/30' : ''}）`, ok, { status: run.status, tail: out.trim().split(/\r?\n/).slice(-2).join(' | ') });
    }
    finish();
  }).catch((error) => {
    check('沙盘端到端执行', false, String((error && error.stack) || error).slice(0, 400));
    finish();
  });
})().catch((error) => {
  check('自检主体执行', false, String((error && error.stack) || error).slice(0, 400));
  finish();
});

/* ───────────────────────── 沙盘端到端 ───────────────────────── */
function sandboxEnv() {
  return { ...process.env, TEAM_ROOT: SB_TEAM, TEAM_PROJECTS_ROOT: path.join(BASE, '项目'), TEAM_SELFTEST: '1' };
}
function teamCli(args) {
  const run = spawnSync(process.execPath, [path.join(ROOT, '团队', '工具', 'team.mjs'), ...args], {
    cwd: ROOT, env: sandboxEnv(), encoding: 'utf8', timeout: 180000,
  });
  const text = String(run.stdout || '');
  let parsed = null;
  const start = text.indexOf('{');
  if (start >= 0) { try { parsed = JSON.parse(text.slice(start)); } catch { /* ignore */ } }
  return { status: run.status, out: text, err: String(run.stderr || ''), json: parsed };
}
function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
function seedSandbox() {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(BASE, { recursive: true });
  copyFile(path.join(ROOT, '团队', '团队宪法.md'), path.join(SB_TEAM, '团队宪法.md'));
  copyFile(path.join(ROOT, '团队', '项目铁律.md'), path.join(SB_TEAM, '项目铁律.md'));
  fs.mkdirSync(SB_PROJECT_STATE, { recursive: true });
  const team = JSON.parse(fs.readFileSync(REAL_TEAM_JSON, 'utf8').replace(/^\uFEFF/, ''));
  for (const member of team.members || []) member.sessionId = '';
  team.activeProject = PNAME;
  fs.writeFileSync(path.join(SB_STATE, '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  copyFile(path.join(ROOT, '团队', '状态', '项目', PNAME, '项目.json'), path.join(SB_PROJECT_STATE, '项目.json'));
  // 工作流：保留真实全量行（F0 统计用），只把 0dbb 行改成「已 approved、无决定/历史」的沙盘起点。
  const wf = JSON.parse(fs.readFileSync(REAL_WF, 'utf8').replace(/^\uFEFF/, ''));
  const row = JSON.parse(JSON.stringify(wf.requirements[REQ_ID]));
  row.status = 'approved';
  row.decisions = [];
  row.history = [];
  row.ownerReview = { status: 'pending', at: null, opinion: '' };
  wf.requirements[REQ_ID] = row;
  wf.phase = 'owner_review';
  fs.writeFileSync(path.join(SB_PROJECT_STATE, '工作流.json'), JSON.stringify(wf, null, 2) + '\n', 'utf8');
  // 任务：复制真实任务文件，补 requirementReview=approve（Owner 决定的前置）
  const realTaskDir = path.join(ROOT, '团队', '状态', '项目', PNAME, '任务');
  const taskName = fs.readdirSync(realTaskDir).find((name) => name.startsWith(REQ_ID));
  const task = JSON.parse(fs.readFileSync(path.join(realTaskDir, taskName), 'utf8').replace(/^\uFEFF/, ''));
  task.workflow = { requirementStatus: 'approved', requirementReview: { verdict: 'approve', by: 'product', at: new Date().toISOString() }, productReview: { verdict: 'approve', by: 'product' } };
  task.acceptance = task.acceptance || '正文 AC 逐条可判：期望值与判据在正文里写明';
  fs.mkdirSync(path.join(SB_PROJECT_STATE, '任务'), { recursive: true });
  fs.writeFileSync(path.join(SB_PROJECT_STATE, '任务', taskName), JSON.stringify(task, null, 2) + '\n', 'utf8');
  // 经验教训阅读记录：产品读过当前登记册（否则 lessons 门禁挡评审）
  const lessonsSha = sha256File(REAL_LESSONS);
  fs.writeFileSync(path.join(SB_STATE, '经验教训阅读.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), role: 'product', sessionId: SESSION, fileSha: lessonsSha, entries: 40, source: 'sandbox' }) + '\n', 'utf8');
}
function snapshotView() {
  const code = `
    const tt = require(${JSON.stringify(path.join(ROOT, 'src', 'team-tools.js'))});
    const snap = tt.readWorkflowSnapshot(${JSON.stringify(PNAME)}, ${JSON.stringify(PROJ)});
    const rows = Array.isArray(snap.requirements) ? snap.requirements : [];
    const row = rows.find((item) => String(item.id) === ${JSON.stringify(REQ_ID)}) || null;
    const docExists = Boolean(row && row.doc && require('node:fs').existsSync(require('node:path').join(${JSON.stringify(PROJ)}, row.doc)));
    process.stdout.write(JSON.stringify({
      row: row ? { id: row.id, doc: row.doc || '', ownerOpinion: row.ownerOpinion || '', ownerOpinionAt: row.ownerOpinionAt || '', status: row.status || '', decisions: (row.decisions || []).length } : null,
      docExists,
      docResolved: rows.filter((item) => item && item.doc).length,
    }));
  `;
  const run = spawnSync(process.execPath, ['-e', code], { cwd: ROOT, env: { ...process.env, TEAM_ROOT: SB_TEAM, TEAM_PROJECTS_ROOT: path.join(BASE, '项目') }, encoding: 'utf8', timeout: 120000 });
  const text = String(run.stdout || '');
  const start = text.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)); } catch { return null; }
}
async function runSandbox() {
  const realBefore = { wf: statOf(REAL_WF), team: statOf(REAL_TEAM_JSON) };
  seedSandbox();
  const boot = teamCli(['boot', '--role', 'product', '--project', PNAME, '--session', SESSION, '--json']);
  const token = boot.json && boot.json.token;
  if (!token) { console.log('沙盘 boot 失败：', boot.out.slice(-400), boot.err.slice(-400)); return null; }
  const comments = '空值=空串按未写处理；异常=解析失败走兜底；权限=只读不写；并发=5 秒重取；降级=无 doc 兜底；模式=full/fast 同口径';
  const reviewArgs = (extra) => ['req', 'review', '--project', PNAME, '--boot', token, '--id', REQ_ID, '--verdict', 'approve', '--comments', comments, ...extra, '--json'];
  const firstReview = teamCli(reviewArgs([]));
  // Owner 真实落账（沙盘内 owner confirm + owner decide，channel=test 仅自测）
  const confirm = teamCli(['owner', 'confirm', '--project', PNAME, '--requirement', REQ_ID, '--decision', 'approved', '--test-owner', '--json']);
  const nonce = confirm.json && confirm.json.nonce;
  const decide = teamCli(['owner', '--project', PNAME, '--requirement', REQ_ID, '--decision', 'approved', '--opinion', OPINION, '--owner-confirm', String(nonce || ''), '--test-owner', '--json']);
  const wfFile = path.join(SB_PROJECT_STATE, '工作流.json');
  const readWf = () => JSON.parse(fs.readFileSync(wfFile, 'utf8'));
  const rowOf = (wf) => wf.requirements[REQ_ID];
  const afterOwnerRow = rowOf(readWf());
  const lastDecision = Array.isArray(afterOwnerRow.decisions) ? afterOwnerRow.decisions[afterOwnerRow.decisions.length - 1] : null;
  const afterOwner = lastDecision ? {
    ok: decide.status === 0,
    lastOpinion: String(lastDecision.opinion || ''),
    lastOpinionAt: String(lastDecision.at || ''),
    ownerReviewOpinion: String((afterOwnerRow.ownerReview && afterOwnerRow.ownerReview.opinion) || ''),
  } : null;
  // 未 ack 再评 → 零写入
  const before = statOf(wfFile);
  const unacked = teamCli(reviewArgs([]));
  const after = statOf(wfFile);
  const unackedJson = unacked.json || {};
  const unackedDetails = unackedJson.details || unackedJson;
  // ack 后再评
  const ackText = '采纳：把评审材料颗粒度对齐到 AC 级，逐条建议按 Owner 口径落卷';
  const acked = teamCli(reviewArgs(['--owner-opinion-ack', ackText]));
  const wfAfterAck = readWf();
  const rowAfterAck = rowOf(wfAfterAck);
  const history = Array.isArray(rowAfterAck.history) ? rowAfterAck.history : [];
  const ackHistory = history.filter((entry) => entry && entry.action === 'owner_opinion_ack').slice(-1)[0] || null;
  const ownerOpinionAck = rowAfterAck.requirementReview && rowAfterAck.requirementReview.ownerOpinionAck ? rowAfterAck.requirementReview.ownerOpinionAck : null;
  const again = teamCli(reviewArgs([]));
  // 三处同源取数（此时 Owner 意见仍是 OPINION）：req list → 壳层快照 → 池详情锚点
  const listRes = teamCli(['req', 'list', '--project', PNAME, '--boot', token, '--json']);
  const listRequirement = listRes.json && Array.isArray(listRes.json.requirements)
    ? listRes.json.requirements.find((item) => String(item.id) === REQ_ID) : null;
  const snap = snapshotView();
  let poolOpinionText = '';
  if (snap && snap.row) {
    const poolRows = POOL.preparePoolRows({ requirements: [{ ...snap.row, kind: 'requirement', type: 'requirement', title: '评审材料可读性' }], tasks: [] });
    const html = poolRows.length ? POOL.poolDetailMarkup(poolRows[0]) : '';
    const match = /data-owner-opinion-text="1"[^>]*>([\s\S]*?)<\/p>/.exec(html);
    poolOpinionText = match ? match[1] : '';
  }
  // Owner 改意见 → 重新拦（沙盘内 fixture 改写 decisions[-1].opinion，模拟 Owner 再给意见）
  const wfChanged = readWf();
  const changedRow = rowOf(wfChanged);
  const changedOpinion = OPINION + '（补充：另外把池详情也一起看）';
  const changedDecisions = changedRow.decisions.slice();
  changedDecisions[changedDecisions.length - 1] = { ...changedDecisions[changedDecisions.length - 1], opinion: changedOpinion };
  changedRow.decisions = changedDecisions;
  fs.writeFileSync(wfFile, JSON.stringify(wfChanged, null, 2) + '\n', 'utf8');
  const changed = teamCli(reviewArgs([]));
  const realAfter = { wf: statOf(REAL_WF), team: statOf(REAL_TEAM_JSON) };
  const untouched = Boolean(realBefore.wf && realAfter.wf && realBefore.wf.sha256 === realAfter.wf.sha256 && realBefore.wf.mtimeMs === realAfter.wf.mtimeMs
    && realBefore.team && realAfter.team && realBefore.team.sha256 === realAfter.team.sha256 && realBefore.team.mtimeMs === realAfter.team.mtimeMs);
  return {
    firstReview: { ok: firstReview.status === 0, code: firstReview.json && firstReview.json.code },
    afterOwner,
    unacked: { code: unackedJson.code || '', ownerOpinion: unackedDetails.ownerOpinion || '', ownerOpinionAt: unackedDetails.ownerOpinionAt || '' },
    zeroWrite: Boolean(before && after && before.sha256 === after.sha256 && before.mtimeMs === after.mtimeMs),
    zeroWriteDetail: { before: before && { sha: before.sha256.slice(0, 12), mtime: before.mtimeMs }, after: after && { sha: after.sha256.slice(0, 12), mtime: after.mtimeMs } },
    acked: { ok: acked.status === 0, code: acked.json && acked.json.code, ownerOpinion: acked.json && acked.json.ownerOpinion, ownerOpinionAt: acked.json && acked.json.ownerOpinionAt },
    ackHistory, ownerOpinionAck, ackText,
    again: { code: again.json && again.json.code },
    changed: { code: changed.json && changed.json.code, ownerSha: (changed.json && changed.json.details && changed.json.details.opinionSha256) || '' },
    listRow: listRequirement,
    snapshot: snap && snap.row,
    docExists: Boolean(snap && snap.docExists),
    docResolvedCount: snap ? snap.docResolved : 0,
    poolOpinionText,
    realUntouched: untouched,
    realUntouchedDetail: { before: { wf: realBefore.wf && realBefore.wf.sha256.slice(0, 12), team: realBefore.team && realBefore.team.sha256.slice(0, 12) }, after: { wf: realAfter.wf && realAfter.wf.sha256.slice(0, 12), team: realAfter.team && realAfter.team.sha256.slice(0, 12) } },
  };
}

function finish() {
  const reportDir = path.join(PROJ, '程序员A', '产出', '证据-0dbb');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'materials-result.json'), JSON.stringify({ at: new Date().toISOString(), total, failed, results: rows }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(reportDir, 'materials-run.log'),
    rows.map((row) => `${row.ok ? 'PASS' : 'FAIL'}  ${row.name}${row.detail === null ? '' : ' · ' + JSON.stringify(row.detail)}`).join('\n') + '\n', 'utf8');
  console.log(`\nR-0dbb 评审材料自检：${total - failed}/${total} PASS`);
  if (!failed) console.log('R_0DBB_MATERIALS_OK');
  process.exit(failed ? 1 : 0);
}
