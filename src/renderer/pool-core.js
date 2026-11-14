/* ============================================================================
 * pool-core.js —— 需求/缺陷池的纯逻辑（R-20261114-132024-30e2）
 *
 * 这里只做三件事：
 *   1) 把一次性加载的 workflowState（需求行 + type 为 bug/scenario-bug 的任务）
 *      整形成统一池行 {id, kind, title, status, owner, bucket, ...}  —— preparePoolRows
 *   2) 对已加载的池行做「状态键 ∩ 类型键 ∩ 搜索」过滤（不读文件、不发 IPC） —— poolVisibleRows
 *   3) 生成行 HTML 与详情 HTML 字符串 —— poolRowMarkup / poolDetailMarkup
 *
 * 约束（F-30e2-1 / F-8）：
 *   - poolRowMarkup 函数体内不得出现 await / 文件读取 / IPC 调用；本文件不加载 fs 模块。
 *   - 标题只能来自池数据一次性加载时带上的字段，逐行读取一律禁止。
 *
 * 兼容：
 *   - 浏览器：index.html 在 app.js 之前引入本文件，挂到 window.POOL_CORE。
 *   - Node  ：断言脚本 scripts/test-pool-30e2.cjs 直接 require 本文件。
 * ========================================================================== */
(function initPoolCore(globalScope) {
  'use strict';

  /* ── 常量：文案与筛选键 ───────────────────────────────────────────────── */

  const EMPTY_TITLE = '（未填标题）';
  const EMPTY_FIELD = '（未填）';
  const EMPTY_OWNER = '—';

  /** 既有四个状态键：键名 / 标签 / 计数语义一字不改（R-30e2 §二、F-4）。 */
  const POOL_FILTERS = [
    { key: 'all', label: '全部' },
    { key: 'approved', label: '已通过' },
    { key: 'active', label: '进行中' },
    { key: 'accepted', label: '已验收' }
  ];

  /** 新增类型键（F-7）：defect 沿用 poolTypeOf 既有别名，bug 与 scenario-bug 都归缺陷池。 */
  const POOL_KIND_FILTERS = [
    { key: 'all', label: '全部类型' },
    { key: 'requirement', label: '需求' },
    { key: 'defect', label: '缺陷' },
    { key: 'scenario-bug', label: '场景缺陷' }
  ];

  /** 行 kind（统一行字段）→ 中文徽标文案。 */
  const KIND_LABEL = {
    requirement: '需求',
    bug: '缺陷',
    'scenario-bug': '场景缺陷'
  };

  /**
   * F-1b 写死的任务状态映射。
   * 注意：done ≠ 已验收；只有 acceptanceRecord.status === 'accepted' 才是「已验收」。
   */
  const TASK_STATUS_LABEL = {
    open: '待验收（未开始/新开）',
    working: '进行中',
    done: '已完成·未验收',
    dev_done: '进行中',
    test_done: '进行中'
  };

  /* ── 小工具 ───────────────────────────────────────────────────────────── */

  function textOf(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\s+/g, ' ').trim();
  }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 按字数截断（只用于详情里「摘要」，不用于行内标题——标题靠 CSS 单行省略）。 */
  function clipText(text, limit) {
    const s = String(text === null || text === undefined ? '' : text);
    const max = Number(limit) > 0 ? Number(limit) : 160;
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }

  /** 数组/分隔符字符串 → 字符串数组（场景缺陷的 expectedFlow/actualFlow/blockedRoles 用）。 */
  function listOf(value) {
    if (Array.isArray(value)) return value.map((item) => textOf(item)).filter(Boolean);
    const s = textOf(value);
    if (!s) return [];
    return s.split(/[、,;；\n]+/).map((item) => textOf(item)).filter(Boolean);
  }

  /** ISO 时间 → 本地「YYYY-MM-DD HH:mm」；解析不了就原样返回。 */
  function formatPoolTime(value) {
    const raw = textOf(value);
    if (!raw) return '';
    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) return raw;
    const pad = (n) => String(n).padStart(2, '0');
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  }

  /* ── 类型判定（沿用 R-3f0d 的 poolTypeOf，只新增 scenario-bug）──────────── */

  /** 需求：默认 requirement；type=defect/bug/缺陷 或 D- 前缀为缺陷；type=scenario-bug 为场景缺陷。 */
  function poolTypeOf(row) {
    const t = String((row && row.type) || '').toLowerCase();
    if (t === 'scenario-bug') return 'scenario-bug';
    if (t === 'defect' || t === 'bug' || t === '缺陷') return 'defect';
    if (/^D-/i.test(String((row && row.id) || ''))) return 'defect';
    return 'requirement';
  }

  /** 统一行的 kind：requirement | bug | scenario-bug（池行 data-kind 用它）。 */
  function kindOf(row) {
    const explicit = String((row && row.kind) || '');
    if (explicit === 'requirement' || explicit === 'bug' || explicit === 'scenario-bug') return explicit;
    const type = poolTypeOf(row);
    if (type === 'scenario-bug') return 'scenario-bug';
    if (type === 'defect') return 'bug';
    return 'requirement';
  }

  /** 两列归属：场景缺陷也归缺陷池（F-1b，不另立第三列）。 */
  function poolTypeGroup(row) {
    return kindOf(row) === 'requirement' ? 'requirement' : 'defect';
  }

  /* ── 状态桶 / 状态标签 ────────────────────────────────────────────────── */

  /** acceptanceRecord.status === 'accepted' 才算验收通过（F-1b / R-43ad F-3）。 */
  function acceptanceAccepted(row) {
    const record = row && row.acceptanceRecord;
    if (!record || typeof record !== 'object') return false;
    return String(record.status || '').toLowerCase() === 'accepted';
  }

  /** 缺陷/场景缺陷任务行：F-1b 写死的状态映射。 */
  function taskStatusLabel(row) {
    if (acceptanceAccepted(row)) return '已验收';
    const status = String((row && row.status) || '').toLowerCase();
    if (TASK_STATUS_LABEL[status]) return TASK_STATUS_LABEL[status];
    if (status === 'accepted') return '已完成·未验收';
    return status ? String((row && row.status) || '') : EMPTY_FIELD;
  }

  /**
   * 池状态桶（与既有四状态键对应）：
   *   需求行：沿用 R-3f0d 的既有判定（accepted/done/iteration → accepted；dispatched/dev/… → active；
   *           approved/ready → approved；其余 other）。
   *   任务行：accepted（验收通过）→ accepted；done（未验收）→ accepted（与既有 poolBucket 的 done 归属一致，
   *           行内标签另示「已完成·未验收」）；working/dev_done/test_done → active；
   *           open（新开）→ pending（不在四个状态键中，只在「全部」下可见）。
   */
  function poolBucket(row) {
    if (kindOf(row) !== 'requirement') {
      if (acceptanceAccepted(row)) return 'accepted';
      const status = String((row && row.status) || '').toLowerCase();
      if (status === 'working' || status === 'dev_done' || status === 'test_done') return 'active';
      if (status === 'done' || status === 'accepted') return 'accepted';
      return 'pending';
    }
    const s = String((row && row.status) || '');
    if (['accepted', 'done', 'iteration'].includes(s)) return 'accepted';
    if (['dispatched', 'dev', 'dev_review', 'test', 'test_done'].includes(s)) return 'active';
    if (['approved', 'ready'].includes(s)) return 'approved';
    if (row && row.reviewedAt) return 'approved';
    return 'other';
  }

  /** 行内状态标签：需求沿用既有语义；任务按 F-1b。 */
  function poolStatusLabel(row) {
    if (kindOf(row) !== 'requirement') return taskStatusLabel(row);
    const b = poolBucket(row);
    return b === 'accepted' ? '已验收' : b === 'active' ? '进行中' : b === 'approved' ? '已通过' : '待评审';
  }

  /**
   * 是否进池：
   *   - 缺陷/场景缺陷任务行：全量进池（F-1b 要求新开缺陷也能看到）；
   *   - 需求行：保留既有口径（bucket 不是 other，或已有 reviewedAt）。
   */
  function poolEntered(row) {
    if (kindOf(row) !== 'requirement') return true;
    return poolBucket(row) !== 'other' || !!(row && row.reviewedAt);
  }

  /* ── 证据 / 测试报告 / 最近决策 ──────────────────────────────────────── */

  const EVIDENCE_EXT = 'md|markdown|txt|json|jsonl|log|csv|cjs|mjs|js|ts|patch|diff|png|jpe?g|gif|webp|svg|zip|pdf|xlsx|docx';

  /** 从一个字符串片段里抠出路径（只认「以路径开头且带已知扩展名」或以 / 结尾的目录）。 */
  function evidencePathFrom(segment) {
    const raw = textOf(segment);
    if (!raw) return '';
    const head = raw.split(/[（(]/)[0].trim();
    if (!head) return '';
    const withExt = head.match(new RegExp(`^(?:[\\w.\\-\\u4e00-\\u9fa5]+/)*[\\w.\\-\\u4e00-\\u9fa5]+\\.(?:${EVIDENCE_EXT})$`, 'i'));
    if (withExt) return withExt[0];
    const dir = head.match(/^(?:[\w.\-\u4e00-\u9fa5]+\/)+$/);
    if (dir) return dir[0];
    return '';
  }

  /** 证据 kind（详情里「路径+kind」的 kind 列）。 */
  function evidenceKindOf(path) {
    const p = String(path || '').toLowerCase();
    if (/\.(png|jpe?g|gif|webp|svg|bmp)$/.test(p)) return '截图';
    if (/\.(md|markdown|txt)$/.test(p)) return '文档';
    if (/\.(json|jsonl|log|csv)$/.test(p)) return '记录';
    if (/\.(cjs|mjs|js|ts|jsx|tsx|py|ps1|cmd|bat|sh)$/.test(p)) return '脚本';
    if (/\.(patch|diff)$/.test(p)) return '补丁';
    if (/\.(zip|7z|tar|gz)$/.test(p)) return '归档';
    if (/\/$/.test(p)) return '目录';
    if (/^c-\d{8}/.test(p)) return '提交';
    return '文件';
  }

  function normalizeEvidenceEntry(entry, index) {
    if (entry && typeof entry === 'object') {
      const path = textOf(entry.path || entry.rel || entry.file || entry.name);
      const kind = textOf(entry.kind) || (path ? evidenceKindOf(path) : '文件');
      const sha256 = textOf(entry.sha256 || entry.hash);
      if (!path) return null;
      return { key: `${path}#${index}`, path, kind, sha256, link: true };
    }
    const segment = textOf(entry);
    if (!segment) return null;
    const path = evidencePathFrom(segment);
    if (path) return { key: `${path}#${index}`, path, kind: evidenceKindOf(path), sha256: '', link: true };
    return { key: `note#${index}`, path: segment, kind: '说明', sha256: '', link: false };
  }

  /**
   * 证据归一：acceptanceRecord.evidence（结构最规范，优先）→ 行级 evidence 数组 / 字符串。
   * 字符串按「、；; 换行」拆段，能抠出路径的当链接，抠不出的按「说明」文本展示，不报错。
   */
  function parseEvidence(raw, acceptanceRecord) {
    const items = [];
    const push = (entry) => {
      const doc = normalizeEvidenceEntry(entry, items.length);
      if (doc) items.push(doc);
    };
    if (acceptanceRecord && Array.isArray(acceptanceRecord.evidence)) {
      for (const entry of acceptanceRecord.evidence) push(entry);
    }
    if (Array.isArray(raw)) {
      for (const entry of raw) push(entry);
    } else if (typeof raw === 'string' && textOf(raw)) {
      for (const segment of String(raw).split(/[、；;\n]+/)) {
        if (textOf(segment)) push(segment);
      }
    }
    const seen = new Set();
    return items.filter((item) => {
      if (seen.has(item.path)) return false;
      seen.add(item.path);
      return true;
    });
  }

  /** 测试报告：acceptanceRecord.testReport 优先，其次证据里带「测试报告 / 测试人员」的路径。 */
  function pickTestReport(row, evidenceItems) {
    const record = row && row.acceptanceRecord;
    if (record && textOf(record.testReport)) return textOf(record.testReport);
    const items = Array.isArray(evidenceItems) ? evidenceItems : [];
    const hit = items.find((item) => item && item.link && (/测试报告/.test(item.path) || /测试人员\/产出/.test(item.path)));
    if (hit) return hit.path;
    const raw = textOf(row && row.evidence);
    if (!raw) return '';
    for (const segment of raw.split(/[、；;\n]+/)) {
      if (!/测试报告/.test(segment)) continue;
      const path = evidencePathFrom(segment);
      if (path) return path;
    }
    return '';
  }

  /** 最近决策时间：decisions[]/ownerReview/acceptanceRecord/各时间戳里最大的 ISO 串。 */
  function lastDecisionAt(row) {
    const times = [];
    const push = (value) => {
      const at = textOf(value);
      if (at) times.push(at);
    };
    if (Array.isArray(row && row.decisions)) {
      for (const decision of row.decisions) {
        if (decision && typeof decision === 'object') push(decision.at);
      }
    }
    if (row) {
      for (const key of ['reviewedAt', 'closedAt', 'doneAt', 'updatedAt', 'createdAt']) push(row[key]);
      if (row.ownerReview && typeof row.ownerReview === 'object') push(row.ownerReview.at);
      if (row.acceptanceRecord && typeof row.acceptanceRecord === 'object') push(row.acceptanceRecord.at);
    }
    times.sort();
    return times.length ? times[times.length - 1] : '';
  }

  /* ── 一次性加载：wf → 统一池行 ───────────────────────────────────────── */

  /** 行标题：row.title → name/summary/概要 → 「（未填标题）」。 */
  function titleOf(row) {
    const source = row && typeof row === 'object' ? row : {};
    return textOf(source.title
      || source.name
      || source.summary
      || source['概要']
      || source.requirementTitle
      || '') || EMPTY_TITLE;
  }

  /** 统一池行：{id, kind, title, status, owner, bucket, ...原始字段}。 */
  function normalizePoolRow(raw, kind) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const id = textOf(source.id);
    const row = {
      ...source,
      id,
      kind,
      type: textOf(source.type) || (kind === 'requirement' ? 'requirement' : kind),
      title: titleOf(source),
      owner: textOf(source.owner || source.ownerRole || source.assignee),
      status: textOf(source.status),
      doc: textOf(source.doc),
      detail: textOf(source.detail || source.story || source.description || ''),
      acceptance: textOf(source.acceptance || source.acceptanceCriteria)
    };
    row.bucket = poolBucket(row);
    row.statusLabel = poolStatusLabel(row);
    row.evidenceItems = parseEvidence(source.evidence, source.acceptanceRecord);
    row.testReport = pickTestReport(source, row.evidenceItems);
    row.lastDecisionAt = lastDecisionAt(source);
    row.searchText = [row.id, row.title, row.owner, row.statusLabel]
      .map((item) => String(item || '').toLowerCase())
      .join(' ');
    return row;
  }

  /**
   * 一次性把 workflowState 整形成池行：
   *   - 需求行：wf.requirements（按既有 poolEntered 口径过滤，保持「不破坏既有计数」）；
   *   - 任务行：只读 type 为 bug / scenario-bug 的任务（不读 task / chore / requirement）；
   *   - 同一 id 只出现一次（需求行优先）。
   * 之后渲染与搜索都用返回的数组，不再读文件、不再发 IPC。
   */
  function preparePoolRows(wf) {
    const requirements = wf && Array.isArray(wf.requirements) ? wf.requirements : [];
    const tasks = wf && Array.isArray(wf.tasks) ? wf.tasks : [];
    const rows = [];
    const seen = new Set();
    for (const item of requirements) {
      const id = textOf(item && item.id);
      if (!id || seen.has(id)) continue;
      const row = normalizePoolRow(item, 'requirement');
      if (!poolEntered(row)) continue;
      seen.add(id);
      rows.push(row);
    }
    for (const item of tasks) {
      const type = String((item && item.type) || '').toLowerCase();
      if (type !== 'bug' && type !== 'scenario-bug') continue;
      const id = textOf(item && item.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push(normalizePoolRow(item, type));
    }
    return rows;
  }

  /* ── 过滤：状态键 ∩ 类型键 ∩ 搜索 ───────────────────────────────────── */

  /** 四字段子串匹配（编号/标题/负责人/状态），不区分大小写。 */
  function matchPoolQuery(row, query) {
    const text = String(query === null || query === undefined ? '' : query).trim().toLowerCase();
    if (!text) return true;
    const haystack = (row && row.searchText) || [row && row.id, row && row.title, row && row.owner, poolStatusLabel(row)]
      .map((item) => String(item || '').toLowerCase()).join(' ');
    return haystack.includes(text);
  }

  function matchPoolKind(row, kind) {
    const key = String(kind || 'all');
    if (key === 'all') return true;
    const group = poolTypeGroup(row);
    if (key === 'requirement') return group === 'requirement';
    if (key === 'defect') return group === 'defect';
    if (key === 'scenario-bug') return kindOf(row) === 'scenario-bug';
    return true;
  }

  function matchPoolStatus(row, status) {
    const key = String(status || 'all');
    if (key === 'all') return true;
    return poolBucket(row) === key;
  }

  /** 可见行：状态键 + 类型键 + 搜索 三重 AND（只在已加载数据上过滤）。 */
  function poolVisibleRows(rows, state) {
    const list = Array.isArray(rows) ? rows : [];
    const next = state && typeof state === 'object' ? state : {};
    return list.filter((row) => matchPoolStatus(row, next.status)
      && matchPoolKind(row, next.kind)
      && matchPoolQuery(row, next.query));
  }

  /**
   * 筛选键计数（F-7「两维 AND 叠加，计数=叠加后条数」）：
   *   - 状态键计数 = 在「当前类型键 ∩ 当前搜索」下的条数；
   *   - 类型键计数 = 在「当前状态键 ∩ 当前搜索」下的条数。
   * 点击任何一个键时，「筛选后行数 = 该键计数」都成立。
   */
  function poolFilterCounts(rows, state) {
    const list = Array.isArray(rows) ? rows : [];
    const next = state && typeof state === 'object' ? state : {};
    const statusCounts = {};
    for (const filter of POOL_FILTERS) statusCounts[filter.key] = 0;
    for (const row of list) {
      if (!matchPoolQuery(row, next.query)) continue;
      if (!matchPoolKind(row, next.kind)) continue;
      statusCounts.all += 1;
      const bucket = poolBucket(row);
      if (Object.prototype.hasOwnProperty.call(statusCounts, bucket) && bucket !== 'all') statusCounts[bucket] += 1;
    }
    const kindCounts = {};
    for (const filter of POOL_KIND_FILTERS) kindCounts[filter.key] = 0;
    for (const row of list) {
      if (!matchPoolQuery(row, next.query)) continue;
      if (!matchPoolStatus(row, next.status)) continue;
      kindCounts.all += 1;
      const group = poolTypeGroup(row);
      if (group === 'defect') {
        kindCounts.defect += 1;
        if (kindOf(row) === 'scenario-bug') kindCounts['scenario-bug'] += 1;
      } else if (group === 'requirement') {
        kindCounts.requirement += 1;
      }
    }
    return { status: statusCounts, kind: kindCounts };
  }

  /** 行集合签名：数据变了才重建行 DOM；纯筛选/搜索不重建。 */
  function poolRowsSignature(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return list.map((row) => [row.id, kindOf(row), row.bucket, row.statusLabel, row.title].join('~')).join('|');
  }

  /* ── 行 HTML（F-30e2-1：徽标 → 编号 → 标题 → 状态 → 负责人）────────── */

  /**
   * 行 HTML。顺序固定：类型徽标 → 编号 → 标题（单行省略、title=全文）→ 状态 → 负责人。
   * 本函数体内**不得**出现 await / fs 读取 / IPC 调用（F-1 / F-8 静态断言）。
   */
  function poolRowMarkup(row) {
    const id = textOf(row && row.id);
    const kind = kindOf(row);
    const typeLabel = KIND_LABEL[kind] || '需求';
    const title = textOf(row && row.title) || EMPTY_TITLE;
    const bucket = poolBucket(row);
    const statusLabel = poolStatusLabel(row);
    const owner = textOf(row && row.owner) || EMPTY_OWNER;
    return `<div class="pool-row kind-${kind}" data-id="${esc(id)}" data-bucket="${bucket}" data-kind="${kind}" role="button" tabindex="0" aria-label="${esc(id)} ${esc(title)}" aria-expanded="false">`
      + `<span class="req-type ${kind}" title="${esc(typeLabel)}">${esc(typeLabel)}</span>`
      + `<span class="pool-id">${esc(id)}</span>`
      + `<span class="pool-title" title="${esc(title)}">${esc(title)}</span>`
      + `<span class="pool-state s-${bucket}">${esc(statusLabel)}</span>`
      + `<span class="pool-who">${esc(owner)}</span>`
      + '</div>';
  }

  /* ── 详情 HTML（F-30e2-2 / F-30e2-3）────────────────────────────────── */

  function fieldMarkup(label, value) {
    const text = textOf(value);
    return `<div class="pool-field"><dt>${esc(label)}</dt><dd>${esc(text || EMPTY_FIELD)}</dd></div>`;
  }

  function listMarkup(label, values) {
    const items = listOf(values);
    return `<div class="pool-field"><dt>${esc(label)}</dt><dd>${items.length ? esc(items.join(' → ')) : empmark()}</dd></div>`;
  }

  function empmark() {
    return `<span class="pool-detail-empty">${EMPTY_FIELD}</span>`;
  }

  /** 详情：需求显示正文/验收标准；缺陷显示复现/期望/实际/影响面；场景缺陷额外显示场景四字段。 */
  function poolDetailMarkup(row) {
    const source = row && typeof row === 'object' ? row : {};
    const kind = kindOf(source);
    const id = textOf(source.id) || EMPTY_FIELD;
    const typeLabel = KIND_LABEL[kind] || '需求';
    const title = textOf(source.title) || EMPTY_TITLE;
    const statusLabel = poolStatusLabel(source);
    const owner = textOf(source.owner) || EMPTY_OWNER;
    const detail = textOf(source.detail);
    const acceptance = textOf(source.acceptance);
    const evidenceItems = Array.isArray(source.evidenceItems) ? source.evidenceItems : parseEvidence(source.evidence, source.acceptanceRecord);
    const report = textOf(source.testReport) || pickTestReport(source, evidenceItems);
    const decisionRaw = textOf(source.lastDecisionAt) || lastDecisionAt(source);

    const detailBody = detail
      ? `<p class="pool-detail-brief">${esc(clipText(detail, 160))}</p>`
        + (detail.length > 160 ? `<details class="pool-detail-more"><summary>展开全文</summary><pre class="pool-detail-full">${esc(detail)}</pre></details>` : '')
      : empmark();

    const requirementSection = kind === 'requirement'
      ? `<section class="pool-detail-sec pool-detail-req"><h5>验收标准</h5><p>${esc(acceptance || EMPTY_FIELD)}</p></section>`
      : `<section class="pool-detail-sec pool-detail-defect"><h5>缺陷字段</h5><dl>
          ${fieldMarkup('复现', source.repro || source.reproduce || source.reproduction)}
          ${fieldMarkup('期望', source.expected)}
          ${fieldMarkup('实际', source.actual)}
          ${fieldMarkup('影响面', source.impact)}
        </dl></section>`
        + (kind === 'scenario-bug'
          ? `<section class="pool-detail-sec pool-detail-scenario"><h5>场景缺陷字段</h5><dl>
              ${fieldMarkup('场景', source.scenario)}
              ${listMarkup('期望流程', source.expectedFlow)}
              ${listMarkup('实际流程', source.actualFlow)}
              ${listMarkup('被卡角色', source.blockedRoles)}
            </dl></section>`
          : '');

    const evidenceList = evidenceItems.length
      ? `<ul class="pool-detail-evidence">${evidenceItems.map((item) => {
        const body = item.link === false
          ? `<span class="pool-ev-text">${esc(item.path)}</span>`
          : `<a href="#" class="pool-link" data-pool-rel="${esc(item.path)}">${esc(item.path)}</a>`;
        return `<li><span class="pool-ev-kind">${esc(item.kind || '文件')}</span>${body}${item.sha256 ? `<span class="pool-ev-sha mono">${esc(String(item.sha256).slice(0, 12))}</span>` : ''}</li>`;
      }).join('')}</ul>`
      : empmark();

    const reportMarkup = report
      ? `<a href="#" class="pool-link pool-report-link" data-pool-rel="${esc(report)}">${esc(report)}</a>`
      : empmark();

    return `<aside id="pool-detail" class="pool-detail" role="dialog" aria-label="${esc(typeLabel)}详情">
      <header class="pool-detail-head">
        <span class="req-type ${kind}" title="${esc(typeLabel)}">${esc(typeLabel)}</span>
        <b class="pool-detail-title">${esc(title)}</b>
        <button type="button" class="pool-detail-close" id="pool-detail-close" aria-label="关闭详情">×</button>
      </header>
      <dl class="pool-detail-meta">
        <div><dt>编号</dt><dd class="mono">${esc(id)}</dd></div>
        <div><dt>类型</dt><dd>${esc(typeLabel)}</dd></div>
        <div><dt>状态</dt><dd>${esc(statusLabel)}</dd></div>
        <div><dt>负责人</dt><dd>${esc(owner)}</dd></div>
        <div><dt>最近决策</dt><dd data-pool-at="${esc(decisionRaw)}">${esc(formatPoolTime(decisionRaw) || EMPTY_FIELD)}</dd></div>
      </dl>
      <section class="pool-detail-sec pool-detail-body"><h5>正文 / 摘要</h5>${detailBody}</section>
      ${requirementSection}
      <section class="pool-detail-sec"><h5>证据（${evidenceItems.length}）</h5>${evidenceList}</section>
      <section class="pool-detail-sec pool-detail-report"><h5>测试报告</h5>${reportMarkup}</section>
      <p class="pool-detail-note">只读详情：编辑仍走各自入口。链接点开用系统程序，文件不存在会就地提示。</p>
    </aside>`;
  }

  /* ── 导出 ─────────────────────────────────────────────────────────────── */

  const api = {
    EMPTY_TITLE,
    EMPTY_FIELD,
    EMPTY_OWNER,
    POOL_FILTERS,
    POOL_KIND_FILTERS,
    KIND_LABEL,
    TASK_STATUS_LABEL,
    esc,
    clipText,
    listOf,
    formatPoolTime,
    poolTypeOf,
    kindOf,
    poolTypeGroup,
    acceptanceAccepted,
    taskStatusLabel,
    poolBucket,
    poolStatusLabel,
    poolEntered,
    parseEvidence,
    evidenceKindOf,
    pickTestReport,
    lastDecisionAt,
    titleOf,
    normalizePoolRow,
    preparePoolRows,
    matchPoolQuery,
    matchPoolKind,
    matchPoolStatus,
    poolVisibleRows,
    poolFilterCounts,
    poolRowsSignature,
    poolRowMarkup,
    poolDetailMarkup
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (globalScope) globalScope.POOL_CORE = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
