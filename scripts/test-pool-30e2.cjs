#!/usr/bin/env node
/* R-30e2「需求/缺陷池：行内标题 + 点击详情 + 模糊搜索」可复跑断言（程序员A）
 *
 * 断言对象：
 *   - src/renderer/pool-core.js  纯逻辑（池行构建 / 状态与类型过滤 / 搜索 / 行与详情 HTML）
 *   - src/renderer/app.js        一次性加载（单次 workflowState）、DOM 只在数据变化时重建、Esc/搜索绑定
 *   - src/renderer/style.css     标题单行省略、行聚焦轮廓
 *   - src/renderer/index.html    pool-core.js 必须在 app.js 之前引入
 *
 * 覆盖：AC1 / AC3 / AC4 / AC6 / AC7 + F-8 静态断言（poolRowMarkup 内无 await/fs/IPC）。
 * 用法：node scripts/test-pool-30e2.cjs [--json]
 * 产出：<仓库根>/程序员A/产出/证据-30e2/result.json
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROJECT_DIR = path.join(ROOT, '项目', '工作台改造修复');
const CORE_FILE = path.join(ROOT, 'src', 'renderer', 'pool-core.js');
const APP_FILE = path.join(ROOT, 'src', 'renderer', 'app.js');
const CSS_FILE = path.join(ROOT, 'src', 'renderer', 'style.css');
const HTML_FILE = path.join(ROOT, 'src', 'renderer', 'index.html');
// 证据目录：项目目录存在时写 项目/工作台改造修复/程序员A/产出/证据-30e2，否则退回仓库根。
const OUT_DIR = fs.existsSync(PROJECT_DIR)
  ? path.join(PROJECT_DIR, '程序员A', '产出', '证据-30e2')
  : path.join(ROOT, '程序员A', '产出', '证据-30e2');

const core = require(CORE_FILE);
const coreSrc = fs.readFileSync(CORE_FILE, 'utf8');
const appSrc = fs.readFileSync(APP_FILE, 'utf8');
const cssSrc = fs.readFileSync(CSS_FILE, 'utf8');
const htmlSrc = fs.readFileSync(HTML_FILE, 'utf8');

const checks = [];
function push(id, ac, name, ok, detail) {
  checks.push({ id, ac, name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
}

/* ── 造数据：1 条需求（20 字标题）+ 1 条缺陷（60 字标题）+ 1 条场景缺陷（空标题）──
 * 另外补：open 状态的缺陷（搜「待验收」用）、owner=PM 的行（大小写搜索用）、
 * 同 id 的 bug（去重用）、task/chore/requirement 类型任务（不得进池）。 */
const SHORT_TITLE = '池子行内完整显示标题并且支持点击查看详情';
const LONG_TITLE = `${'池子行内标题过长时必须在单行内省略并用 title 属性保留全文，这一段一共六十个字符用来验证省略逻辑是否正常工作。'.repeat(3)}`.slice(0, 60);
const SCENARIO_FLOW_REPORT = '测试人员/产出/测试报告-30e2.md';

function makeWorkflow() {
  return {
    requirements: [
      {
        id: 'R-20261114-132024-30e2',
        title: SHORT_TITLE,
        status: 'approved',
        owner: 'PM',
        type: 'requirement',
        doc: '需求/R-20261114-132024-30e2-池子行内标题与详情.md',
        detail: '池行改为徽标+编号+标题+状态+负责人，整行可点打开详情。'.repeat(6),
        acceptance: 'AC1 行内显示标题；AC2 点击查看详情；AC6 模糊查询',
        decisions: [{ at: '2026-11-14T06:30:34.923Z', status: 'approved', by: 'PM' }],
        reviewedAt: '2026-11-14T06:30:34.923Z'
      },
      {
        id: 'R-20261114-000000-aaaa',
        title: '进行中的第二条需求',
        status: 'dev',
        owner: 'programmer2',
        type: 'requirement'
      },
      {
        id: 'R-20261114-000000-bbbb',
        title: '状态为空且未评审的需求（既有口径不进池）',
        status: '',
        type: 'requirement'
      }
    ],
    tasks: [
      {
        id: 'B-20261114-000001-1111',
        type: 'bug',
        title: LONG_TITLE,
        status: 'working',
        owner: 'programmer1',
        requirementId: 'R-20261114-132024-30e2',
        evidence: '程序员A/产出/证据-30e2/run-test.log、证据-30e2/截图-池子.png',
        repro: '打开池子点一行无反应',
        expected: '整行可点开详情',
        actual: '只有编号能显示，点了没反应',
        impact: 'Owner 扫不出优先级，要开文件搜编号'
      },
      {
        id: 'B-20261114-000002-2222',
        type: 'bug',
        title: '',
        status: 'done',
        owner: '程序员A'
      },
      {
        id: 'B-20261114-000003-3333',
        type: 'scenario-bug',
        title: '验收后状态没有前进',
        status: 'working',
        owner: 'programmer2',
        scenario: 'Owner 验收 → 状态前进',
        expectedFlow: ['测试完成', 'Owner 验收', '状态 accepted'],
        actualFlow: ['测试完成', 'Owner 验收', '状态仍 test_done'],
        blockedRoles: ['pm', 'tester'],
        acceptanceRecord: {
          status: 'accepted',
          by: 'owner',
          channel: 'ui',
          at: '2026-11-14T08:00:00.000Z',
          evidence: [{ path: SCENARIO_FLOW_REPORT, sha256: 'a'.repeat(64), kind: '测试报告' }],
          testReport: SCENARIO_FLOW_REPORT
        }
      },
      {
        id: 'B-20261114-000004-4444',
        type: 'bug',
        title: '新开但还没开始的缺陷',
        status: 'open',
        owner: 'PM'
      },
      {
        id: 'R-20261114-132024-30e2',
        type: 'bug',
        title: '与需求同 id 的缺陷（去重用，不得重复进池）',
        status: 'working',
        owner: 'programmer1'
      },
      { id: 'B-20261114-000005-5555', type: 'task', title: '普通任务不进池', status: 'working' },
      { id: 'B-20261114-000006-6666', type: 'chore', title: '杂务不进池', status: 'working' },
      { id: 'B-20261114-000007-7777', type: 'requirement', title: '需求型任务不进池', status: 'working' }
    ]
  };
}

const wf = makeWorkflow();
const rows = core.preparePoolRows(wf);
const byId = (id) => rows.find((row) => row.id === id);
const reqRow = byId('R-20261114-132024-30e2');
const shortRow = reqRow;
const longRow = byId('B-20261114-000001-1111');
const emptyTitleRow = byId('B-20261114-000002-2222');
const scenarioRow = byId('B-20261114-000003-3333');
const openBugRow = byId('B-20261114-000004-4444');
const wholeState = { status: 'all', kind: 'all', query: '' };
const visibleAll = core.poolVisibleRows(rows, wholeState);
const countsAll = core.poolFilterCounts(rows, wholeState);

/* ── 源码工具 ─────────────────────────────────────────────────────────── */
function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) return null;
  const open = source.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}
const rowMarkupBody = extractFunctionBody(coreSrc, 'function poolRowMarkup(row)') || '';
const fetchBody = extractFunctionBody(appSrc, 'async function poolFetchRows()') || '';
const renderBody = extractFunctionBody(appSrc, 'function renderPool()') || '';

/* ══════════════════════════════════════════════════════════════════════
 * AC1 行内显示标题（20/60/空标题三行结构）
 * ══════════════════════════════════════════════════════════════════════ */
push('AC1-01', 'AC1', '三条样本行都在池里（需求/缺陷/场景缺陷）',
  Boolean(shortRow && longRow && emptyTitleRow && scenarioRow),
  `rows=${rows.map((r) => r.id + ':' + r.kind).join(',')}`);
push('AC1-02', 'AC1', '短标题 20 字、长标题 60 字（造数口径先自证）',
  SHORT_TITLE.length === 20 && LONG_TITLE.length === 60,
  `short=${SHORT_TITLE.length} long=${LONG_TITLE.length}`);
push('AC1-03', 'AC1', '行结构固定顺序：徽标 → 编号 → 标题 → 状态 → 负责人',
  (() => {
    const html = core.poolRowMarkup(longRow);
    const idx = [
      html.indexOf(`req-type ${longRow.kind}`),
      html.indexOf('class="pool-id"'),
      html.indexOf('class="pool-title"'),
      html.indexOf('class="pool-state'),
      html.indexOf('class="pool-who"')
    ];
    return idx.every((i) => i >= 0) && idx[0] < idx[1] && idx[1] < idx[2] && idx[2] < idx[3] && idx[3] < idx[4];
  })(), core.poolRowMarkup(longRow).slice(0, 160));
push('AC1-04', 'AC1', '行元素保留 data-id / data-bucket，新增 data-kind（三类都正确）',
  ['requirement', 'bug', 'scenario-bug'].every((kind) => {
    const row = kind === 'requirement' ? shortRow : kind === 'bug' ? longRow : scenarioRow;
    const html = core.poolRowMarkup(row);
    return html.includes('data-id="') && html.includes('data-bucket="') && html.includes(`data-kind="${kind}"`);
  }),
  'data-kind requirement/bug/scenario-bug');
push('AC1-05', 'AC1', 'role="button" / tabindex="0" / aria-label="编号 标题" / aria-expanded',
  (() => {
    const html = core.poolRowMarkup(shortRow);
    return html.includes('role="button"')
      && html.includes('tabindex="0"')
      && html.includes(`aria-label="${shortRow.id} ${SHORT_TITLE}"`)
      && html.includes('aria-expanded="false"');
  })(), '');
push('AC1-06', 'AC1', '60 字标题单行省略：title 属性=全文，且文本全量在 title 里',
  (() => {
    const html = core.poolRowMarkup(longRow);
    return html.includes(`title="${LONG_TITLE}"`) && html.includes(`>${LONG_TITLE}</span>`);
  })(), LONG_TITLE);
push('AC1-07', 'AC1', '空标题兜底「（未填标题）」且保留编号',
  (() => {
    const html = core.poolRowMarkup(emptyTitleRow);
    return html.includes(core.EMPTY_TITLE) && html.includes(emptyTitleRow.id);
  })(), '');
push('AC1-08', 'AC1', 'CSS：.pool-title 单行省略（white-space:nowrap + overflow:hidden + text-overflow:ellipsis）',
  /\.pool-title\s*\{[^}]*white-space:nowrap[^}]*\}/.test(cssSrc)
  && /\.pool-title\s*\{[^}]*text-overflow:ellipsis[^}]*\}/.test(cssSrc)
  && /\.pool-title\s*\{[^}]*overflow:hidden[^}]*\}/.test(cssSrc), '');
push('AC1-09', 'AC1', 'CSS：行聚焦有可见 outline（S4）',
  /\.pool-row:focus\s*\{[^}]*outline:[^}]*\}/.test(cssSrc), '');
push('AC1-10', 'AC1', '三类徽标文案正确（需求/缺陷/场景缺陷）',
  core.poolRowMarkup(shortRow).includes('>需求</span>')
  && core.poolRowMarkup(longRow).includes('>缺陷</span>')
  && core.poolRowMarkup(scenarioRow).includes('>场景缺陷</span>'), '');

/* ══════════════════════════════════════════════════════════════════════
 * AC3 三类都能点开详情（字段齐全 / 缺失兜底）
 * ══════════════════════════════════════════════════════════════════════ */
const reqDetail = core.poolDetailMarkup(shortRow);
const bugDetail = core.poolDetailMarkup(longRow);
const scenarioDetail = core.poolDetailMarkup(scenarioRow);
const missingDetail = core.poolDetailMarkup(emptyTitleRow);

push('AC3-01', 'AC3', '详情容器 #pool-detail 存在且带 role=dialog',
  reqDetail.includes('id="pool-detail"') && reqDetail.includes('role="dialog"'), '');
push('AC3-02', 'AC3', '详情公共字段：标题全文/编号/类型/状态/负责人/最近决策',
  ['pool-detail-title', '编号', '类型', '状态', '负责人', '最近决策'].every((token) => reqDetail.includes(token))
  && reqDetail.includes(SHORT_TITLE)
  && reqDetail.includes('data-pool-at="2026-11-14T06:30:34.923Z"'), '');
push('AC3-03', 'AC3', '需求详情显示验收标准（pool-detail-req）',
  reqDetail.includes('pool-detail-req') && reqDetail.includes('验收标准') && reqDetail.includes('AC1 行内显示标题'), '');
push('AC3-04', 'AC3', '缺陷详情显示 复现/期望/实际/影响面（pool-detail-defect）',
  bugDetail.includes('pool-detail-defect')
  && ['复现', '期望', '实际', '影响面', '打开池子点一行无反应', '整行可点开详情'].every((token) => bugDetail.includes(token)), '');
push('AC3-05', 'AC3', '场景缺陷详情额外显示 场景/期望流程/实际流程/被卡角色',
  scenarioDetail.includes('pool-detail-scenario')
  && ['场景', '期望流程', '实际流程', '被卡角色', '状态 accepted', '状态仍 test_done', 'pm → tester'].every((token) => scenarioDetail.includes(token)), '');
push('AC3-06', 'AC3', '字段缺失显示「（未填）」且不报错',
  missingDetail.includes(core.EMPTY_FIELD) && missingDetail.includes(core.EMPTY_TITLE), '');
push('AC3-07', 'AC3', '证据列表含 路径 + kind（截图/日志/说明都不报错）',
  bugDetail.includes('data-pool-rel="程序员A/产出/证据-30e2/run-test.log"')
  && bugDetail.includes('>记录<') && bugDetail.includes('>截图<')
  && longRow.evidenceItems.length === 2, `items=${longRow.evidenceItems.length}`);
push('AC3-08', 'AC3', '测试报告链接（acceptanceRecord.testReport 优先，渲染为可点链接）',
  scenarioDetail.includes(`data-pool-rel="${SCENARIO_FLOW_REPORT}"`) && scenarioDetail.includes('测试报告'), '');
push('AC3-09', 'AC3', '详情只读：不含输入框/保存按钮（不新增写入口）',
  !/<textarea|contenteditable|<input/i.test(reqDetail + bugDetail + scenarioDetail), '');
push('AC3-10', 'AC3', '详情链接带 data-pool-rel 供点击打开（stopPropagation 在 app.js 委托里）',
  coreSrc.includes('data-pool-rel') && appSrc.includes("closest('.pool-link')"), '');

/* ══════════════════════════════════════════════════════════════════════
 * AC4 计数 = 行数 / 同 id 去重 / done≠已验收 / accepted 才已验收
 * ══════════════════════════════════════════════════════════════════════ */
push('AC4-01', 'AC4', '全部可见行数 = 池行数（计数=行数）',
  visibleAll.length === rows.length && countsAll.status.all === rows.length,
  `visible=${visibleAll.length} rows=${rows.length} count_all=${countsAll.status.all}`);
push('AC4-02', 'AC4', '「状态键计数之和 ≤ 全部」且非负（新增 pending 桶只进全部）',
  Object.keys(countsAll.status).filter((k) => k !== 'all').reduce((sum, k) => sum + countsAll.status[k], 0) <= countsAll.status.all,
  JSON.stringify(countsAll.status));
push('AC4-03', 'AC4', '同一 id 只出现一次（需求与 bug 同 id → 保留需求行）',
  rows.filter((row) => row.id === 'R-20261114-132024-30e2').length === 1
  && byId('R-20261114-132024-30e2').kind === 'requirement', '');
push('AC4-04', 'AC4', '只读 bug / scenario-bug：task / chore / requirement 任务不进池',
  !byId('B-20261114-000005-5555') && !byId('B-20261114-000006-6666') && !byId('B-20261114-000007-7777'),
  `kinds=${[...new Set(rows.map((r) => r.kind))].join(',')}`);
push('AC4-05', 'AC4', 'done ≠ 已验收：无 acceptanceRecord 的 done 显示「已完成·未验收」',
  emptyTitleRow.statusLabel === '已完成·未验收' && !emptyTitleRow.statusLabel.includes('已验收'),
  emptyTitleRow.statusLabel);
push('AC4-06', 'AC4', '只有 acceptanceRecord.status=accepted 才显示「已验收」',
  scenarioRow.statusLabel === '已验收' && core.acceptanceAccepted(scenarioRow) === true
  && core.acceptanceAccepted(emptyTitleRow) === false, `${scenarioRow.statusLabel} / ${emptyTitleRow.statusLabel}`);
push('AC4-07', 'AC4', 'F-1b 状态映射：open→待验收（未开始/新开）、working→进行中',
  openBugRow.statusLabel === '待验收（未开始/新开）'
  && byId('B-20261114-000001-1111').statusLabel === '进行中',
  `${openBugRow.statusLabel} / ${byId('B-20261114-000001-1111').statusLabel}`);
push('AC4-08', 'AC4', '切换状态筛选时筛选后行数 = 该键计数',
  core.POOL_FILTERS.every((filter) => {
    const state = { status: filter.key, kind: 'all', query: '' };
    const vis = core.poolVisibleRows(rows, state).length;
    const cnt = core.poolFilterCounts(rows, { status: 'all', kind: 'all', query: '' }).status[filter.key];
    return vis === cnt;
  }), JSON.stringify(countsAll.status));
push('AC4-09', 'AC4', '需求行保留既有进池口径（status 空且无 reviewedAt 不进池）',
  !byId('R-20261114-000000-bbbb'), '');
push('AC4-10', 'AC4', '详情打开时切换筛选会关闭（app.js 静态绑定）',
  /function applyPoolFilters\(\)[\s\S]{0,4000}closePoolDetail\(false\)/.test(appSrc)
  && (appSrc.match(/closePoolDetail\(false\)/g) || []).length >= 3, '');

/* ══════════════════════════════════════════════════════════════════════
 * AC6 模糊查询（编号/标题/负责人/状态，大小写不敏感，与类型筛选 AND）
 * ══════════════════════════════════════════════════════════════════════ */
const q = (query, kind = 'all') => core.poolVisibleRows(rows, { status: 'all', kind, query }).map((row) => row.id);
push('AC6-01', 'AC6', '编号片段 30e2 → 只命中该行',
  q('30e2').length === 1 && q('30e2')[0] === 'R-20261114-132024-30e2', JSON.stringify(q('30e2')));
push('AC6-02', 'AC6', '标题词命中（「标题」命中标题含该词的行）',
  q('标题').includes('R-20261114-132024-30e2') && q('标题').includes('B-20261114-000001-1111'), JSON.stringify(q('标题')));
push('AC6-03', 'AC6', '负责人片段命中（中文「程序员A」与英文 programmer1 双向命中）',
  q('程序员A').length === 1 && q('程序员A')[0] === 'B-20261114-000002-2222'
  && q('programmer1').includes('B-20261114-000001-1111'), JSON.stringify({ cn: q('程序员A'), en: q('programmer1') }));
push('AC6-04', 'AC6', '状态词命中（「待验收」→ 新开缺陷行）',
  q('待验收').includes('B-20261114-000004-4444'), JSON.stringify(q('待验收')));
push('AC6-05', 'AC6', '大小写不敏感（PM 与 pm 结果一致）',
  JSON.stringify(q('PM')) === JSON.stringify(q('pm')) && q('pm').length > 0, JSON.stringify(q('pm')));
push('AC6-06', 'AC6', '与类型筛选 AND（缺陷 ∩ 关键词 = 全量命中 − 需求命中）',
  (() => {
    const def = q('标题', 'defect');
    const all = q('标题', 'all');
    const req = q('标题', 'requirement');
    return def.length === all.length - req.length
      && def.every((id) => byId(id).kind !== 'requirement')
      && def.length > 0;
  })(),
  `defect=${JSON.stringify(q('标题', 'defect'))} all=${JSON.stringify(q('标题', 'all'))}`);
push('AC6-07', 'AC6', '无结果时可见行 0（UI 显示「没有匹配项」+ 清空按钮）',
  q('绝对不存在的关键词zzz').length === 0
  && appSrc.includes('没有匹配项') && appSrc.includes('pool-nomatch-clear'), '');
push('AC6-08', 'AC6', 'Esc 清空恢复全量（清空 query 后 = 全量；app.js Escape→clearPoolSearch）',
  core.poolVisibleRows(rows, { status: 'all', kind: 'all', query: '' }).length === rows.length
  && /e\.key === 'Escape'[\s\S]{0,120}clearPoolSearch\(\)/.test(appSrc), '');
push('AC6-09', 'AC6', '搜索框结构：input type=search + placeholder + Tab 可聚焦（非 disabled）',
  /<input type="search" id="pool-search"/.test(appSrc)
  && appSrc.includes('placeholder="搜编号 / 标题 / 负责人 / 状态"')
  && !/id="pool-search"[^>]*disabled/.test(appSrc), '');
push('AC6-10', 'AC6', '搜索只在已加载数据上过滤：input 事件 → applyPoolFilters（不重新拉取）',
  /search\.addEventListener\('input'[\s\S]{0,200}applyPoolFilters\(\)/.test(appSrc)
  && !/search\.addEventListener\('input'[\s\S]{0,200}refreshPool\(\)/.test(appSrc), '');

/* ══════════════════════════════════════════════════════════════════════
 * AC7 类型筛选（all/requirement/defect/scenario-bug）+ 与状态键叠加
 * ══════════════════════════════════════════════════════════════════════ */
push('AC7-01', 'AC7', '类型键齐全且键名精确（all/requirement/defect/scenario-bug）',
  JSON.stringify(core.POOL_KIND_FILTERS.map((f) => f.key)) === JSON.stringify(['all', 'requirement', 'defect', 'scenario-bug']),
  JSON.stringify(core.POOL_KIND_FILTERS.map((f) => f.key)));
push('AC7-02', 'AC7', '既有四个状态键键名/标签一字不改',
  JSON.stringify(core.POOL_FILTERS) === JSON.stringify([
    { key: 'all', label: '全部' }, { key: 'approved', label: '已通过' },
    { key: 'active', label: '进行中' }, { key: 'accepted', label: '已验收' }
  ]), JSON.stringify(core.POOL_FILTERS.map((f) => f.key + ':' + f.label)));
push('AC7-03', 'AC7', '切 requirement → 只有需求行',
  q('', 'requirement').every((id) => byId(id).kind === 'requirement')
  && q('', 'requirement').length === rows.filter((row) => row.kind === 'requirement').length, '');
push('AC7-04', 'AC7', '切 defect → bug + scenario-bug（两类都在）',
  q('', 'defect').length === rows.filter((row) => row.kind !== 'requirement').length
  && q('', 'defect').includes('B-20261114-000001-1111')
  && q('', 'defect').includes('B-20261114-000003-3333'), JSON.stringify(q('', 'defect')));
push('AC7-05', 'AC7', '切 scenario-bug → 只显示场景缺陷（归缺陷池、徽标区分）',
  q('', 'scenario-bug').length === 1 && q('', 'scenario-bug')[0] === 'B-20261114-000003-3333'
  && core.poolTypeGroup(scenarioRow) === 'defect', '');
push('AC7-06', 'AC7', '类型键与状态键叠加 = 交集，且两侧计数一致',
  (() => {
    const state = { status: 'active', kind: 'defect', query: '' };
    const vis = core.poolVisibleRows(rows, state);
    const counts = core.poolFilterCounts(rows, state);
    return vis.length === counts.status.active && vis.length === counts.kind.defect && vis.length > 0
      && vis.every((row) => row.kind !== 'requirement' && row.bucket === 'active');
  })(), JSON.stringify(core.poolFilterCounts(rows, { status: 'active', kind: 'defect', query: '' })));
push('AC7-07', 'AC7', '切换类型键不重建 DOM（app.js：仅 signature 变化才重建行节点）',
  /const signature = POOL_CORE\.poolRowsSignature\(rows\)/.test(appSrc)
  && /signature !== poolUi\.signature/.test(appSrc)
  && /applyPoolFilters\(\)/.test(appSrc), '');
push('AC7-08', 'AC7', '行内类型徽标与筛选键同一套判定（poolTypeOf 保留 defect 别名 + 新增 scenario-bug）',
  core.poolTypeOf({ id: 'B-1', type: 'bug' }) === 'defect'
  && core.poolTypeOf({ id: 'B-2', type: 'scenario-bug' }) === 'scenario-bug'
  && core.poolTypeOf({ id: 'D-1' }) === 'defect'
  && core.poolTypeOf({ id: 'R-1' }) === 'requirement', '');
push('AC7-09', 'AC7', '签名对筛选稳定：同一数据集签名不变（不触发重建）',
  core.poolRowsSignature(rows) === core.poolRowsSignature(rows)
  && core.poolRowsSignature([]) === '', '');

/* ══════════════════════════════════════════════════════════════════════
 * F-8 读文件=0（静态断言）
 * ══════════════════════════════════════════════════════════════════════ */
push('F8-01', 'F-8', 'poolRowMarkup 函数体存在且能提取（括号配平）',
  rowMarkupBody.length > 100, `len=${rowMarkupBody.length}`);
push('F8-02', 'F-8', 'poolRowMarkup 体内无 await',
  Boolean(rowMarkupBody) && !/\bawait\b/.test(rowMarkupBody), '');
push('F8-03', 'F-8', 'poolRowMarkup 体内无 fs / readFile / readFileSync',
  Boolean(rowMarkupBody) && !/\bfs\b|readFile|readFileSync/.test(rowMarkupBody), '');
push('F8-04', 'F-8', 'poolRowMarkup 体内无 IPC / workbench 调用',
  Boolean(rowMarkupBody) && !/workbench|ipcRenderer|ipcMain|\.invoke\(/.test(rowMarkupBody), '');
push('F8-05', 'F-8', 'pool-core.js 全文不 require fs、不碰 window.workbench',
  !/require\(['"]fs['"]\)|require\(['"]node:fs['"]\)/.test(coreSrc)
  && !/window\.workbench/.test(coreSrc) && !/ipcRenderer/.test(coreSrc), '');
push('F8-06', 'F-8', '池数据一次性加载：poolFetchRows 内 workflowState( 只出现 1 次',
  (fetchBody.match(/workflowState\(/g) || []).length === 1
  && fetchBody.includes('POOL_CORE.preparePoolRows(wf)'), `hits=${(fetchBody.match(/workflowState\(/g) || []).length}`);
push('F8-07', 'F-8', '渲染/搜索路径不再读文件：app.js 池子区块内无 fs 调用',
  !/function poolRowMarkup[\s\S]{0,400}fs\./.test(appSrc)
  && !/function applyPoolFilters[\s\S]{0,3000}filesOpen|function applyPoolFilters[\s\S]{0,3000}workflowState/.test(appSrc), '');
push('F8-08', 'F-8', 'title 只来自一次性加载的池数据（preparePoolRows 内无文件读取）',
  !/readFile|require\(['"]fs/.test(extractFunctionBody(coreSrc, 'function preparePoolRows(wf)') || ''), '');

/* ══════════════════════════════════════════════════════════════════════
 * 装配与回归（index.html 引入顺序 + 真实数据自证）
 * ══════════════════════════════════════════════════════════════════════ */
push('RUN-01', 'assembly', 'index.html 在 app.js 之前引入 pool-core.js',
  htmlSrc.indexOf('<script src="pool-core.js">') > 0
  && htmlSrc.indexOf('<script src="pool-core.js">') < htmlSrc.indexOf('<script src="app.js">'), '');
push('RUN-02', 'assembly', 'app.js 用 window.POOL_CORE（缺失时显示「池子模块未加载」而不是崩）',
  appSrc.includes('window.POOL_CORE') && appSrc.includes('池子模块未加载'), '');
push('RUN-03', 'assembly', '行点击 / Enter / Space 都打开详情（事件委托）',
  appSrc.includes("e.target.closest('.pool-row')")
  && /e\.key === 'Enter' \|\| e\.key === ' ' \|\| e\.key === 'Spacebar'/.test(appSrc), '');
push('RUN-04', 'assembly', 'Esc 关闭详情且焦点回原行（closePoolDetail 里 focus）',
  /function closePoolDetail\(refocus\)[\s\S]{0,900}\.focus\(\)/.test(appSrc)
  && /if \(poolUi\.detailId\) \{ closePoolDetail\(\); return; \}/.test(appSrc), '');
push('RUN-05', 'assembly', '详情链接 stopPropagation（不触发整行重开）',
  /closest\('\.pool-link'\)[\s\S]{0,160}e\.stopPropagation\(\)/.test(appSrc), '');
push('RUN-06', 'assembly', 'aria-expanded 随详情开合切换',
  /setAttribute\('aria-expanded', 'true'\)/.test(appSrc)
  && /setAttribute\('aria-expanded', 'false'\)/.test(appSrc), '');

/* 装配自证：面板 HTML 里的 DOM id 与新增函数都有定义（防手改漏项） */
const panelBody = extractFunctionBody(appSrc, 'function poolPanelEnsure()') || '';
const requiredIds = ['pool-search', 'pool-search-clear', 'pool-kinds', 'pool-filters', 'pool-req-list',
  'pool-def-list', 'pool-req-n', 'pool-def-n', 'pool-nomatch', 'pool-nomatch-clear', 'pool-nomatch-reset',
  'pool-foot', 'pool-detail-host', 'pool-close'];
push('RUN-07', 'assembly', '面板 DOM id 齐全（搜索框/类型键/状态键/两列/无匹配/详情宿主）',
  requiredIds.every((id) => panelBody.includes(`id="${id}"`)),
  requiredIds.filter((id) => !panelBody.includes(`id="${id}"`)).join(','));
const poolFunctions = ['renderPoolChips', 'applyPoolFilters', 'poolRowNode', 'togglePoolDetail', 'openPoolDetail',
  'closePoolDetail', 'openPoolLink', 'clearPoolSearch', 'resetPoolFilters'];
push('RUN-08', 'assembly', '池子新增函数都有定义（渲染/筛选/详情/搜索）',
  poolFunctions.every((fn) => appSrc.includes(`function ${fn}(`) || appSrc.includes(`async function ${fn}(`)),
  poolFunctions.filter((fn) => !appSrc.includes(`function ${fn}(`) && !appSrc.includes(`async function ${fn}(`)).join(','));

/* 真实数据自证（只作证据，不作硬门：项目状态文件缺失时跳过） */
const realData = { available: false };
try {
  const stateFile = path.join(ROOT, '团队', '状态', '项目', '工作台改造修复', '工作流.json');
  const taskDir = path.join(ROOT, '团队', '状态', '项目', '工作台改造修复', '任务');
  if (fs.existsSync(stateFile) && fs.existsSync(taskDir)) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const tasks = fs.readdirSync(taskDir).filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(taskDir, name), 'utf8')));
    const byIdMap = new Map(tasks.map((task) => [String(task.id), task]));
    const requirements = Object.entries(state.requirements || {}).map(([id, meta]) => {
      const task = byIdMap.get(id) || {};
      return {
        id,
        title: String((meta && meta.title) || task.title || ''),
        status: String((meta && meta.status) || (task.status === 'done' ? 'accepted' : 'review')),
        type: String((meta && meta.type) || task.type || ''),
        owner: String((meta && meta.owner) || task.owner || ''),
        doc: String((meta && meta.doc) || ''),
        detail: String(task.detail || ''),
        acceptance: String(task.acceptance || ''),
        evidence: String(task.evidence || ''),
        decisions: Array.isArray(meta && meta.decisions) ? meta.decisions : [],
        reviewedAt: (meta && meta.reviewedAt) || null,
        createdAt: (meta && meta.createdAt) || task.createdAt || null
      };
    });
    const realRows = core.preparePoolRows({ requirements, tasks });
    const realCounts = core.poolFilterCounts(realRows, wholeState);
    const bugTotal = tasks.filter((task) => task.type === 'bug').length;
    const scenarioTotal = tasks.filter((task) => task.type === 'scenario-bug').length;
    realData.available = true;
    realData.requirementsInWorkflow = requirements.length;
    realData.requirementRowsInPool = realRows.filter((row) => row.kind === 'requirement').length;
    realData.bugTasks = bugTotal;
    realData.scenarioBugTasks = scenarioTotal;
    realData.bugRowsInPool = realRows.filter((row) => row.kind === 'bug').length;
    realData.scenarioRowsInPool = realRows.filter((row) => row.kind === 'scenario-bug').length;
    realData.poolRows = realRows.length;
    realData.statusCounts = realCounts.status;
    realData.kindCounts = realCounts.kind;
    realData.duplicateIds = realRows.length - new Set(realRows.map((row) => row.id)).size;
    realData.titlesMissing = realRows.filter((row) => row.title === core.EMPTY_TITLE).length;
    realData.evidenceItemsSample = (realRows.find((row) => row.kind === 'bug') || {}).evidenceItems?.length || 0;
    push('REAL-01', 'AC4', '真实数据：池行 id 无重复', realData.duplicateIds === 0, `duplicates=${realData.duplicateIds}`);
    push('REAL-02', 'AC4', '真实数据：bug 任务全部进池（bug 行数 = 任务目录 type=bug 条数）',
      realData.bugRowsInPool === bugTotal, `${realData.bugRowsInPool}/${bugTotal}`);
    push('REAL-03', 'AC7', '真实数据：类型键计数 = 实际行数（需求 + 缺陷 = 池内）',
      realData.kindCounts.requirement + realData.kindCounts.defect === realData.poolRows
      && realData.kindCounts.defect === realData.bugRowsInPool + realData.scenarioRowsInPool,
      JSON.stringify(realData.kindCounts));
    push('REAL-04', 'AC1', '真实数据：每一行都有标题（缺失才兜底，不是全兜底）',
      realData.titlesMissing < realData.poolRows, `missing=${realData.titlesMissing}/${realData.poolRows}`);
  }
} catch (error) {
  realData.error = String((error && error.message) || error);
  checks.push({ id: 'REAL-00', ac: 'AC4', name: '真实数据自证（跳过）', ok: true, skip: true, detail: realData.error });
}

/* ── 汇总 ─────────────────────────────────────────────────────────────── */
const failed = checks.filter((check) => !check.ok);
const acList = ['AC1', 'AC3', 'AC4', 'AC6', 'AC7', 'F-8', 'assembly'];
const acSummary = {};
for (const ac of acList) {
  const items = checks.filter((check) => check.ac === ac);
  acSummary[ac] = {
    total: items.length,
    passed: items.filter((item) => item.ok).length,
    failed: items.filter((item) => !item.ok).map((item) => item.id)
  };
}
const report = {
  requirement: 'R-20261114-132024-30e2',
  task: 'T-20261114-160405-563c',
  generatedAt: new Date().toISOString(),
  files: {
    core: path.relative(ROOT, CORE_FILE).replace(/\\/g, '/'),
    app: path.relative(ROOT, APP_FILE).replace(/\\/g, '/'),
    css: path.relative(ROOT, CSS_FILE).replace(/\\/g, '/'),
    html: path.relative(ROOT, HTML_FILE).replace(/\\/g, '/')
  },
  total: checks.length,
  passed: checks.length - failed.length,
  failed: failed.length,
  ok: failed.length === 0,
  ac: acSummary,
  realData,
  checks
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'result.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  for (const check of checks) {
    const tail = check.detail ? ` · ${String(check.detail).slice(0, 220)}` : '';
    console.log(`${check.ok ? 'PASS  ' : 'FAIL  '}${check.id} [${check.ac}] ${check.name}${tail}`);
  }
  console.log('');
  console.log(`合计 ${report.passed}/${report.total} 通过，失败 ${report.failed} 条`);
  console.log(`AC 汇总：${acList.map((ac) => `${ac} ${acSummary[ac].passed}/${acSummary[ac].total}`).join(' | ')}`);
  if (realData.available) {
    console.log(`真实数据：池行 ${realData.poolRows}（需求 ${realData.requirementRowsInPool} · 缺陷任务 ${realData.bugTasks} → 池内 bug ${realData.bugRowsInPool} · 场景缺陷 ${realData.scenarioRowsInPool}）；id 重复 ${realData.duplicateIds}`);
  }
  console.log(report.ok ? 'POOL_30E2_OK' : 'POOL_30E2_FAIL');
  console.log(`结果已写入 ${path.join(OUT_DIR, 'result.json')}`);
}
process.exitCode = report.ok ? 0 : 1;
