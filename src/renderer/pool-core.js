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

  /** R-4657：缺陷证据 kind 推断（与 scripts/auto-accept.cjs 的扩展名口径一致）。 */
  const REPORT_PATH_RE = /\.(md|markdown|txt|log)$/i;
  const IMAGE_PATH_RE = /\.(png|jpe?g|webp)$/i;
  const DEFAULT_RETRACT_HOURS = 24;

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

  /* ── Owner 决定派生（B-dee4）────────────────────────────────────────────── */

  /**
   * Owner 决定状态：decisions[] 末条优先，其次 ownerReview.status。
   * 与 owner-review-state.js 的 decisionOf 同口径；该模块在本文件之后加载（index.html 743 vs 746），
   * 所以这里按调用时惰性取 window.OwnerReviewState，取不到就用本文件内同口径兜底，保证 Node 单测可用。
   */
  function ownerDecisionStatusOf(row) {
    const state = (globalScope && globalScope.OwnerReviewState) || null;
    if (state && typeof state.decidedStatusOf === 'function') return String(state.decidedStatusOf(row) || '');
    const top = (row && Array.isArray(row.decisions)) ? row.decisions.filter(Boolean) : [];
    const owner = (row && row.ownerReview) || {};
    const legacy = Array.isArray(owner.decisions) ? owner.decisions : [];
    const latest = top.length ? top[top.length - 1] : (legacy.length ? legacy[legacy.length - 1] : null);
    const pick = (value) => {
      const text = String(value === null || value === undefined ? '' : value);
      return ['approved', 'rejected', 'skipped'].includes(text) ? text : '';
    };
    return pick(latest && (latest.status || latest.decision)) || pick(owner.status);
  }

  /* ── 状态桶 / 状态标签 ────────────────────────────────────────────────── */

  /** acceptanceRecord.status === 'accepted' 才算验收通过（F-1b / R-43ad F-3）。 */
  function acceptanceAccepted(row) {
    const record = row && row.acceptanceRecord;
    if (!record || typeof record !== 'object') return false;
    return String(record.status || '').toLowerCase() === 'accepted';
  }

  /* ── R-4657：任务级自动验收状态（缺陷池行属性 / 撤回入口） ───────────── */

  /**
   * data-accept-state：accepted | pending | retracted（只对缺陷/场景缺陷任务行有效）。
   * 判定仍以 acceptanceRecord.status 为准（accepted 才「已验收」；retracted 只是作废自动记录）。
   */
  function acceptStateOf(row) {
    if (kindOf(row) === 'requirement') return '';
    const record = row && row.acceptanceRecord;
    if (!record || typeof record !== 'object') return 'pending';
    const status = String(record.status || '').toLowerCase();
    if (status === 'accepted') return 'accepted';
    if (status === 'retracted') return 'retracted';
    return 'pending';
  }

  /** 自动验收文案：已验收 / 未验收 / 已撤回（与 data-accept-state 同源）。 */
  function acceptStateLabel(row) {
    const state = acceptStateOf(row);
    if (state === 'accepted') return '已验收';
    if (state === 'retracted') return '已撤回';
    return state === 'pending' ? '未验收' : '';
  }

  /**
   * data-accept-missing：report | screenshot | none。
   * 只看任务快照（evidenceFiles 扩展名/scope/kind），不读文件、不发 IPC；
   * 取 F-4657-2 顺序里的第一个缺件（缺报告优先于缺截图）。
   */
  function acceptMissingOf(row) {
    if (kindOf(row) === 'requirement') return '';
    const state = acceptStateOf(row);
    if (state !== 'pending') return 'none';
    const files = Array.isArray(row && row.evidenceFiles) ? row.evidenceFiles : [];
    let hasReport = false;
    let hasScreenshot = false;
    let hasOpaqueDir = false;
    for (const item of files) {
      if (!item || typeof item !== 'object') continue;
      const kind = String(item.kind || '').toLowerCase();
      const filePath = String(item.path || item.rel || '');
      if (kind === 'dir' || kind === 'directory' || /[\\/]$/.test(filePath)) hasOpaqueDir = true;
      if (kind === 'report' || REPORT_PATH_RE.test(filePath)) hasReport = true;
      if (kind === 'screenshot' || IMAGE_PATH_RE.test(filePath)) hasScreenshot = true;
    }
    // 目录内容前端不可读：交给主进程/自动化判定，不冒充缺件。
    if (hasOpaqueDir) return 'none';
    if (!hasReport) return 'report';
    if (!hasScreenshot) return 'screenshot';
    return 'none';
  }

  /** 撤回窗口（默认 24h，可被主进程 workflowState.autoAccept.retractHours 覆盖）。 */
  function retractAllowed(row, options) {
    if (acceptStateOf(row) !== 'accepted') return false;
    const record = row && row.acceptanceRecord;
    const acceptedAt = Date.parse(String((record && record.at) || ''));
    if (!Number.isFinite(acceptedAt)) return false;
    const opts = options && typeof options === 'object' ? options : {};
    const rawHours = opts.retractHours !== undefined && opts.retractHours !== null
      ? opts.retractHours
      : (row && row.retractHours);
    const hours = Number(rawHours);
    const windowHours = Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_RETRACT_HOURS;
    const nowMs = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
    return nowMs - acceptedAt <= windowHours * 3600 * 1000;
  }

  /** 缺陷/场景缺陷任务行：F-1b 写死的状态映射；R-4657 撤回后显示「已撤回」。 */
  function taskStatusLabel(row) {
    const record = row && row.acceptanceRecord;
    if (record && String(record.status || '').toLowerCase() === 'retracted') return '已撤回';
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
    // B-dee4（AC2）：dev_done 属「进行中」——以前漏在映射外被当成 other 丢出池，
    // 导致「已通过、开发完了待测试」的需求在池里看不见。
    if (['dispatched', 'dev', 'dev_review', 'dev_done', 'test', 'test_done'].includes(s)) return 'active';
    if (['approved', 'ready'].includes(s)) return 'approved';
    if (row && row.reviewedAt) return 'approved';
    // B-dee4（AC1/AC2）：Owner 已通过/已跳过的行，即使 status 还停在 review/owner_review/tech_review
    // 这类「已评审、未派单」的写法，也必须进池并显示「已通过」，不能因为 ownerReview 被重置成
    // pending 就当成 other 丢掉（5c19 就是这么从池里消失的）。
    const decided = ownerDecisionStatusOf(row);
    if (decided === 'approved' || decided === 'skipped') return 'approved';
    return 'other';
  }

  /** 行内状态标签：需求沿用既有语义；任务按 F-1b。
   *  B-a17d：未登记（只有需求任务文件、工作流没有行）显示「未登记」，已作废显示「已作废」。 */
  function poolStatusLabel(row) {
    if (kindOf(row) !== 'requirement') return taskStatusLabel(row);
    if (row && row.voided === true) return '已作废';
    if (row && row.unregistered === true) return '未登记';
    const b = poolBucket(row);
    return b === 'accepted' ? '已验收' : b === 'active' ? '进行中' : b === 'approved' ? '已通过' : '待评审';
  }

  /**
   * 是否进池：
   *   - 缺陷/场景缺陷任务行：全量进池（F-1b 要求新开缺陷也能看到）；
   *   - 需求行：保留既有口径（bucket 不是 other，或已有 reviewedAt）；
   *   - 未登记需求（B-a17d）：必须进池，否则 Owner 看不到也就没法一键登记/作废。
   */
  function poolEntered(row) {
    if (kindOf(row) !== 'requirement') return true;
    if (row && (row.unregistered === true || row.voided === true)) return true;
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

  /* ── 验收人（R-62b9 F-accby-1/2/3）──────────────────────────────────── */

  /**
   * 验收人七值枚举（增补卷-62b9-1 §二，顺序固定、判据自左向右命中即停、不按标签反推）：
   *   1 owner         by=owner  且 channel∈{ui,tty}                        → 【Owner 验收】
   *   2 pm_proxy      channel=proxy 且 recordedBy=pm 且 basis.proxy 三字段齐 → 【PM代管验收】
   *   3 pm            by=pm     且 channel=pm                              → 【PM 验收】
   *   4 tester        by=tester 且 channel=test                            → 【测试验收】
   *   5 auto          by=system 且 channel=auto                            → 【自动验收（系统）】
   *   6 pm_incomplete channel=proxy 但缺 basis.proxy / recordedBy          → 【PM代管·记录不完整】
   *   7 none          无 accepted 记录                                     → （未验收）
   * 兼容：旧记录 by=pm 且 channel 缺失 → code=pm、【PM 验收（来源未记）】（不冒充 Owner、不判 none）。
   * 副标 testGate=pm_signed 只回传给 data-accept-test-gate，**不参与**验收人取值。
   */
  const ACCEPT_BY_LABELS = {
    owner: '【Owner 验收】',
    pm_proxy: '【PM代管验收】',
    pm: '【PM 验收】',
    tester: '【测试验收】',
    auto: '【自动验收（系统）】',
    pm_incomplete: '【PM代管·记录不完整】',
    none: '（未验收）'
  };
  const ACCEPT_BY_PM_LEGACY = '【PM 验收（来源未记）】';

  function acceptByOf(row) {
    const source = row && typeof row === 'object' ? row : {};
    const record = source.acceptanceRecord && typeof source.acceptanceRecord === 'object' ? source.acceptanceRecord : null;
    const decisions = Array.isArray(source.decisions) ? source.decisions.filter(Boolean) : [];
    const last = decisions.length ? decisions[decisions.length - 1] : null;
    const decided = String((last && (last.status || last.decision)) || '').toLowerCase();
    const recordStatus = String((record && record.status) || '').toLowerCase();
    const accepted = recordStatus === 'accepted' || decided === 'accepted';
    const at = textOf((record && record.at) || (last && last.at) || '');
    const testGate = textOf((record && record.testGate) || (last && last.testGate) || '');
    const make = (code, legacy) => ({ code, label: legacy || ACCEPT_BY_LABELS[code] || ACCEPT_BY_LABELS.none, at, testGate });
    if (!accepted) return make('none');
    const channel = textOf((record && record.channel) || (last && last.channel) || '').toLowerCase();
    const by = textOf((record && record.by) || (last && (last.decidedBy || last.actor || last.by)) || '').toLowerCase();
    const recordedBy = textOf((record && record.recordedBy) || (last && last.recordedBy) || '').toLowerCase();
    const proxyBasis = ((record && record.basis) || (last && last.basis) || {}).proxy || null;
    const basisComplete = Boolean(proxyBasis
      && textOf(proxyBasis.scope).trim()
      && textOf(proxyBasis.startedAt).trim()
      && textOf(proxyBasis.authorization).trim());
    // ① Owner 本人
    if (by === 'owner' && (channel === 'ui' || channel === 'tty')) return make('owner');
    // ② PM 代管（三要素齐）
    if (channel === 'proxy' && recordedBy === 'pm' && basisComplete) return make('pm_proxy');
    // ③ PM 直接验收（正常路径，不是防御态）
    if (by === 'pm' && channel === 'pm') return make('pm');
    // ①-兼容：旧记录 by=pm 但 channel 缺失 → 仍是 pm（来源未记）
    if (by === 'pm' && !channel) return make('pm', ACCEPT_BY_PM_LEGACY);
    // ④ 测试验收
    if (by === 'tester' && channel === 'test') return make('tester');
    // ⑤ 自动验收（4657：by=system + channel=auto，不得落 none）
    if (by === 'system' && channel === 'auto') return make('auto');
    // ⑥ 代管记录不完整（防御分支）
    if (channel === 'proxy') return make('pm_incomplete');
    // ⑦ 其它组合：认不出人就不冒充（保留 by 供详情提示，但取值仍是 none）
    return make('none');
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
  function normalizePoolRow(raw, kind, options) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const id = textOf(source.id);
    const opts = options && typeof options === 'object' ? options : {};
    const hours = Number(opts.retractHours);
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
      acceptance: textOf(source.acceptance || source.acceptanceCriteria),
      retractHours: Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_RETRACT_HOURS
    };
    row.bucket = poolBucket(row);
    row.statusLabel = poolStatusLabel(row);
    row.acceptState = acceptStateOf(row);
    row.acceptMissing = acceptMissingOf(row);
    row.evidenceItems = parseEvidence(source.evidence, source.acceptanceRecord);
    row.testReport = pickTestReport(source, row.evidenceItems);
    row.lastDecisionAt = lastDecisionAt(source);
    row.accept = acceptByOf(source);
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
    // R-4657：撤回窗口可由主进程 workflowState.autoAccept.retractHours 覆盖（默认 24h）。
    const retractHoursRaw = Number(wf && wf.autoAccept && wf.autoAccept.retractHours);
    const options = { retractHours: Number.isFinite(retractHoursRaw) ? retractHoursRaw : DEFAULT_RETRACT_HOURS };
    for (const item of requirements) {
      const id = textOf(item && item.id);
      if (!id || seen.has(id)) continue;
      const row = normalizePoolRow(item, 'requirement', options);
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
      rows.push(normalizePoolRow(item, type, options));
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

  /** 行集合签名：数据变了才重建行 DOM；纯筛选/搜索不重建。
   *  B-a17d：未登记/已作废标记也算数据（否则标记变了不重建）。 */
  function poolRowsSignature(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return list.map((row) => [row.id, kindOf(row), row.bucket, row.statusLabel, row.title,
      row.unregistered === true ? 'U' : '', row.voided === true ? 'V' : '',
      acceptStateOf(row), acceptMissingOf(row), retractAllowed(row) ? 'R' : ''].join('~')).join('|');
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
    // B-a17d：未登记 / 已作废标记（只由快照字段驱动，行内不读文件、不发 IPC）。
    const ghost = row && row.unregistered === true
      ? `<span class="req-ghost" title="工作流里没有这条需求，推不动：请一键登记或作废">未登记</span>` : '';
    const voided = row && row.voided === true
      ? `<span class="req-ghost voided" title="${esc(textOf(row.voidedReason) || '已作废')}">已作废</span>` : '';
    // R-4657：缺陷行带自动验收状态/缺件；仅 accepted 且未超窗才出撤回按钮（只由快照驱动）。
    const isDefect = kind !== 'requirement';
    const acceptState = isDefect ? acceptStateOf(row) : '';
    const acceptMissing = isDefect ? acceptMissingOf(row) : '';
    const acceptAttrs = isDefect
      ? ` data-accept-state="${esc(acceptState)}" data-accept-missing="${esc(acceptMissing)}"`
      : '';
    const retract = isDefect && acceptState === 'accepted' && retractAllowed(row)
      ? `<button type="button" class="pool-retract" data-bug-retract="${esc(id)}" title="撤回这条自动验收（窗口内可撤回）" aria-label="撤回自动验收 ${esc(id)}">撤回</button>`
      : '';
    // R-62b9（增补卷-62b9-1 §五）：缺陷池列表在状态徽标旁加同源「验收人」小字徽标，
    // 文案与池详情逐字一致（都来自 acceptByOf，三处同源、不新增数字统计）。
    const acceptBy = isDefect ? acceptByOf(row) : null;
    const acceptByBadge = isDefect && acceptBy && acceptBy.code !== 'none'
      ? `<span class="pool-accept-by" data-accept-by="${esc(acceptBy.code)}" title="验收人（与池详情同源）">${esc(acceptBy.label)}</span>`
      : '';
    return `<div class="pool-row kind-${kind}" data-id="${esc(id)}" data-bucket="${bucket}" data-kind="${kind}"${ghost ? ' data-unregistered="1"' : ''}${voided ? ' data-voided="1"' : ''}${acceptAttrs} role="button" tabindex="0" aria-label="${esc(id)} ${esc(title)}" aria-expanded="false">`
      + `<span class="req-type ${kind}" title="${esc(typeLabel)}">${esc(typeLabel)}</span>`
      + `<span class="pool-id">${esc(id)}</span>`
      + `<span class="pool-title" title="${esc(title)}">${esc(title)}</span>`
      + ghost + voided
      + `<span class="pool-state s-${bucket}">${esc(statusLabel)}</span>`
      + acceptByBadge
      + `<span class="pool-who">${esc(owner)}</span>`
      + retract
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

  /* ── 增补卷（R-f9b1 可读性，F-7⑤⑥）────────────────────────────────────
   * 数据来源：工作流需求行 `supplements[]`（工具侧拆分时写入，每项 name/bytes/sha256，可带 path/rel）。
   * 约定未落地 / 该需求没拆过卷 / 字段坏了，一律 `[]`（安全降级：详情里不出现 data-supplement 区块，不报错）。
   * **卷字段的唯一归一化入口**：app.js（池详情/面板/查看器）与 owner-review.js（评审材料卡）都调这里，
   * 禁止在别处再解析一遍 supplements —— scripts/test-supplement-ui.cjs 有源码级单源断言。
   */
  const SUPPLEMENT_NAME_RE = /增补卷-[0-9A-Za-z_-]+\.md/;

  function supplementNameOf(item) {
    const raw = typeof item === 'string' ? item : (item && (item.name || item.file || item.rel || item.path));
    const text = textOf(raw).replace(/\\/g, '/');
    if (!text) return '';
    const hit = text.match(SUPPLEMENT_NAME_RE);
    if (hit) return hit[0];
    return '';
  }

  function supplementBytesOf(item) {
    if (!item || typeof item !== 'object') return null;
    const raw = item.bytes !== undefined ? item.bytes : (item.size !== undefined ? item.size : item.byteLength);
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function supplementShaOf(item) {
    if (!item || typeof item !== 'object') return '';
    return String(item.sha256 || item.sha || '').replace(/[^0-9a-f]/gi, '').toLowerCase().slice(0, 64);
  }

  /** 一条卷 → {name, bytes, sha256, sha12, rel, requirementId, missing}；认不出卷名返回 null。 */
  function normalizeSupplement(item, requirementId) {
    const name = supplementNameOf(item);
    if (!name) return null;
    const bytes = supplementBytesOf(item);
    const sha256 = supplementShaOf(item);
    const rawRel = textOf(item && (item.rel || item.path)) || ('需求/' + name);
    const rel = rawRel.replace(/\\/g, '/').replace(/^\.\//, '');
    return {
      name,
      bytes,
      sha256,
      sha12: sha256 ? sha256.slice(0, 12) : '',
      rel,
      requirementId: textOf(requirementId) || textOf(item && (item.requirementId || item.reqId)),
      missing: Boolean(item && (item.missing === true || item.unreadable === true))
    };
  }

  /**
   * 行/数组 → 卷清单。接受三种输入：需求行（读 `.supplements`）、裸数组、材料组条目数组。
   * 有 `kind` 且不是 `supplement` 的条目（正文/报告）不会被当成卷。
   */
  function supplementsOf(source) {
    const list = Array.isArray(source) ? source
      : (source && Array.isArray(source.supplements) ? source.supplements : []);
    const reqId = textOf(source && source.id) || textOf(source && source.requirementId);
    const out = [];
    const seen = new Set();
    for (const item of list) {
      if (!item) continue;
      // T-cb02：卷条目 kind 统一为 appendix，老数据仍写 supplement → 两个都认。
      if (item && typeof item === 'object' && item.kind && !['supplement', 'appendix'].includes(String(item.kind))) continue;
      const row = normalizeSupplement(item, reqId);
      if (!row) continue;
      const key = row.rel + '|' + row.name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
    return out;
  }

  function supplementSizeLabel(bytes) {
    const n = Number(bytes);
    if (bytes === null || bytes === undefined || !Number.isFinite(n) || n < 0) return '字节未记录';
    return String(n) + ' B';
  }

  function supplementMetaLabel(row) {
    return supplementSizeLabel(row && row.bytes) + ' · ' + (row && row.sha12 ? 'sha256 ' + row.sha12 : 'sha 未记录');
  }

  function supplementOpenAttrs(row) {
    const bytes = row && row.bytes !== null && row.bytes !== undefined && Number.isFinite(Number(row.bytes))
      ? String(Number(row.bytes)) : '';
    return ` data-supplement-open="${esc(row.rel)}"`
      + ` data-supplement-name="${esc(row.name)}"`
      + ` data-supplement-bytes="${bytes}"`
      + ` data-supplement-sha="${esc(row.sha256 || '')}"`
      + ` data-supplement-req="${esc(row.requirementId || '')}"`
      + (row.missing ? ' data-supplement-missing="1"' : '');
  }

  /** 需求池详情里的「增补卷」区块：有卷才渲染；无卷返回 ''（不报错、不占位）。 */
  function supplementSectionMarkup(source) {
    const rows = supplementsOf(source);
    if (!rows.length) return '';
    const id = textOf(source && source.id) || rows[0].requirementId || '';
    const items = rows.map((row) => `<li class="pool-supplement-row" data-supplement-item="${esc(row.name)}">`
      + `<button type="button" class="pool-link pool-supplement-open"${supplementOpenAttrs(row)} title="${esc(row.rel)}">${esc(row.name)}</button>`
      + `<span class="pool-supplement-meta">${esc(supplementMetaLabel(row))}</span>`
      + (row.missing ? '<span class="pool-supplement-warn">缺失</span>' : '')
      + '</li>').join('');
    return `<section class="pool-detail-sec pool-detail-supplement" data-supplement="1" data-supplement-count="${rows.length}" data-supplement-req="${esc(id)}">`
      + `<h5>增补卷（${rows.length}）· 只读 · 不纳入必读</h5>`
      + `<ul class="pool-supplement-list">${items}</ul>`
      + '<p class="pool-supplement-note">16KB 拆分产物：点卷名只读打开，不改主正文。</p></section>';
  }

  /**
   * 主正文**头部**卷清单解析（工具侧拆分时写在标题下方，例如：
   *   > 增补卷：`需求/增补卷-f9b1-1.md`（12637B/4b9137ffe2da）
   * 或 `- 增补卷-xxxx-1.md — 12637 字节 — sha256 4b9137ffe2da`。
   * 只看文档头部（首个 `## ` 小节之前的 80 行）：正文中部的说明/表格不会被误当清单。
   * 没有清单 → `[]`（界面不显示、不报错）。
   */
  const SUPPLEMENT_HEAD_BYTES_RE = /(\d{2,9})\s*(?:B|b|字节)/;
  const SUPPLEMENT_HEAD_SHA_RE = /(?<![0-9a-f])([0-9a-f]{12,64})(?![0-9a-f])/gi;

  function supplementHeaderEntries(text) {
    const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    if (!raw || raw.indexOf('增补卷-') < 0) return [];
    const lines = raw.split('\n').slice(0, 80);
    const out = [];
    const seen = new Set();
    for (const line of lines) {
      if (/^##\s+\S/.test(line)) break; // 头部结束：以下属正文小节
      if (line.indexOf('增补卷-') < 0) continue;
      const names = line.match(new RegExp(SUPPLEMENT_NAME_RE.source, 'g')) || [];
      for (const name of names) {
        if (seen.has(name)) continue;
        let bytes = null;
        let sha256 = '';
        const segments = line.split(name);
        const tail = segments.length > 1 ? segments.slice(1).join(name) : '';
        const bytesHit = tail.match(SUPPLEMENT_HEAD_BYTES_RE) || line.match(SUPPLEMENT_HEAD_BYTES_RE);
        if (bytesHit) bytes = Number(bytesHit[1]);
        SUPPLEMENT_HEAD_SHA_RE.lastIndex = 0;
        let shaHit = SUPPLEMENT_HEAD_SHA_RE.exec(tail || line);
        while (shaHit && bytes !== null && String(bytes) === shaHit[1]) {
          shaHit = SUPPLEMENT_HEAD_SHA_RE.exec(tail || line);
        }
        if (shaHit) sha256 = String(shaHit[1]).toLowerCase();
        // 只认带「字节 + sha」的清单行：正文里顺手提到的卷名（如规范说明）不算头部清单。
        if (bytes === null && !sha256) continue;
        const pathHit = line.match(/`([^`]*增补卷-[^`]*\.md)`/);
        const rel = pathHit ? String(pathHit[1]).replace(/\\/g, '/') : ('需求/' + name);
        seen.add(name);
        out.push({ name, rel, bytes, sha256, sha12: sha256 ? sha256.slice(0, 12) : '' });
      }
    }
    return out;
  }

  /** 头部卷清单渲染（主正文一打开就能看到卷）；没有清单返回 ''。 */
  function supplementHeaderMarkup(text, options) {
    const rows = supplementHeaderEntries(text);
    if (!rows.length) return '';
    const title = (options && options.title) || '增补卷清单（正文头部）';
    const chips = rows.map((row) => `<button type="button" class="legacy-supplement-chip"${supplementOpenAttrs(row)} title="${esc(row.rel)}">`
      + `${esc(row.name)}<span>${esc(supplementMetaLabel(row))}</span></button>`).join('');
    return `<div class="legacy-supplement-head" data-supplement="1" data-supplement-source="doc-header" data-supplement-count="${rows.length}">`
      + `<b>${esc(title)} · ${rows.length}</b>`
      + `<div class="legacy-supplement-chips">${chips}</div>`
      + '<p class="legacy-supplement-hint">卷不纳入必读，只读查看，不改正文。</p></div>';
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
    // R-62b9：三类（需求/缺陷/场景缺陷）共用这一行「验收人」，只读快照、不读文件。
    const accept = acceptByOf(source);

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

    // R-0dbb F7/AC11③：Owner 通过（或打回）时写的意见必须能在池详情里读到**原文全文**。
    // 取数只有一条路：快照行上的 ownerOpinion / ownerOpinionAt（team-tools.js requirementView 从
    // decisions[-1] 派生，与 CLI `req list --json` 同判据）——渲染层不自己再算一遍、不前端拼。
    // 锚点用 `data-owner-opinion-text`：`data-owner-opinion` 已被 owner-review.js 的意见输入框占用
    // 且 scripts/test-owner-copy.cjs 断言其必须存在，不能复用。文本不截断、不加 line-clamp/省略号。
    const opinionText = source.ownerOpinion === null || source.ownerOpinion === undefined ? '' : String(source.ownerOpinion);
    const opinionAt = source.ownerOpinionAt === null || source.ownerOpinionAt === undefined ? '' : String(source.ownerOpinionAt);
    const opinionSection = opinionText.trim()
      ? `<section class="pool-detail-sec pool-detail-owner-opinion"><h5>Owner 意见（原文）</h5>`
        + `<p class="pool-opinion-text" data-owner-opinion-text="1" data-owner-opinion-at="${esc(opinionAt)}">${esc(opinionText)}</p>`
        + (opinionAt ? `<p class="pool-opinion-at">${esc(formatPoolTime(opinionAt))}</p>` : '')
        + '</section>'
      : '';

    return `<aside id="pool-detail" class="pool-detail" data-pool-detail="1" role="dialog" aria-label="${esc(typeLabel)}详情">
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
        <div><dt>验收人</dt><dd data-accept-by="${esc(accept.code)}" data-accept-at="${esc(accept.at)}"${accept.testGate ? ` data-accept-test-gate="${esc(accept.testGate)}"` : ''}>${esc(accept.label)}${accept.testGate === 'pm_signed' ? ' · 测试结论 PM 代签' : ''}${accept.at ? ' · ' + esc(formatPoolTime(accept.at)) : ''}</dd></div>
      </dl>
      ${opinionSection}
      <section class="pool-detail-sec pool-detail-body"><h5>正文 / 摘要</h5>${detailBody}</section>
      ${requirementSection}
      ${supplementSectionMarkup(source)}
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
    acceptStateOf,
    acceptStateLabel,
    acceptMissingOf,
    retractAllowed,
    taskStatusLabel,
    ownerDecisionStatusOf,
    poolBucket,
    poolStatusLabel,
    poolEntered,
    parseEvidence,
    evidenceKindOf,
    pickTestReport,
    lastDecisionAt,
    acceptByOf,
    ACCEPT_BY_LABELS,
    ACCEPT_BY_PM_LEGACY,
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
    poolDetailMarkup,
    // R-f9b1：增补卷字段的唯一归一化/渲染入口（app.js、owner-review.js 共用）。
    supplementsOf,
    supplementSectionMarkup,
    supplementHeaderEntries,
    supplementHeaderMarkup,
    supplementSizeLabel,
    supplementMetaLabel,
    supplementOpenAttrs
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (globalScope) globalScope.POOL_CORE = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
