(function () {
  'use strict';
  const STATUS_TEXT = { approved: '已通过', rejected: '已打回', skipped: '已先跳过', pending: '等你决定', optional: '等你决定' };
  // B-4baa（R-1cee）：看板与待评估清单默认各展示前 5 条，其余折叠在 DOM 里（不删、不裁切），可展开全部。
  const PREVIEW_ROWS = 5;
  const state = { projectId: '', data: null, selected: '', draft: '', timer: null, skipOpen: false, skipDraft: { analyst: '', product: '', dev: '' }, materials: null, materialsFor: '', boardExpanded: false, evalExpanded: false, suggestions: [], batchSelected: new Set(), batchError: '', reject: null, listFilter: 'all', listOpen: new Set() };
  const KEY_LATER = 'awb.ownerReview.laterUntil';
  const KEY_NO_AUTO = 'awb.ownerReview.noAuto';

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // B-a08e：读决定以需求行顶层 decisions[] 为准（闸门 ownerDecisionsOf 同源）；
  // 旧数据可能只有 ownerReview.decisions 或单个 ownerReview 对象，按序兜底。
  function latestOwnerDecision(req) {
    const top = (req && Array.isArray(req.decisions)) ? req.decisions.filter(Boolean) : [];
    if (top.length) return top[top.length - 1];
    const owner = (req && req.ownerReview) || {};
    const list = Array.isArray(owner.decisions) ? owner.decisions : [];
    return list.length ? list[list.length - 1] : null;
  }
  function decidedStatusOf(req) {
    const latest = latestOwnerDecision(req);
    const fromDecision = String((latest && (latest.status || latest.decision)) || '');
    if (['approved', 'rejected', 'skipped'].includes(fromDecision)) return fromDecision;
    return String((req && req.ownerReview && req.ownerReview.status) || '');
  }
  function statusOf(req) {
    const status = decidedStatusOf(req) || String((req && req.status) || '');
    if (status === 'approved' || status === 'rejected' || status === 'skipped') return status;
    return 'pending';
  }
  function isPending(req) {
    const status = String((req && req.status) || '');
    const owner = decidedStatusOf(req);
    if (['accepted', 'terminated', 'iteration', 'rejected'].includes(status)) return false;
    if (['approved', 'skipped', 'rejected'].includes(owner)) return false;
    return status === 'approved' || status === 'owner_review';
  }
  function pendingRows() {
    const rows = (state.data && Array.isArray(state.data.requirements)) ? state.data.requirements : [];
    return rows.filter(isPending);
  }
  // 「全部交 PM 代管」的覆盖范围（T-69ed）：Owner 门待决定 + 等你验收（test_done）。
  // 之前只覆盖 owner 门两种状态，验收阶段点“全部”会提示“没有待评估的需求”，批量等于空转。
  function rowsAwaitingOwner() {
    const rows = (state.data && Array.isArray(state.data.requirements)) ? state.data.requirements : [];
    return rows.filter((row) => {
      const status = String((row && row.status) || '');
      if (['accepted', 'terminated', 'iteration', 'rejected'].includes(status)) return false;
      const owner = String((row && row.ownerReview && row.ownerReview.status) || '');
      if (['approved', 'skipped', 'rejected'].includes(owner)) return false;
      return isPending(row) || status === 'test_done';
    });
  }
  function dialogEl() { return document.querySelector('[data-owner-review-dialog]'); }

  // 代管徽标挂载点（T-e921）：标题栏末尾会压住【文件夹】，改放 stage-bar【项目面板】左侧；
  // 找不到 stage-bar 才退回标题栏，保证旧布局/测试页也能挂上。
  function proxyHost() {
    const actions = document.querySelector('.stage-actions');
    const board = document.getElementById('btn-board');
    if (actions && board && actions.contains(board)) return { host: actions, before: board };
    const fallback = document.querySelector('#titlebar .titlebar-center') || document.getElementById('titlebar') || document.body;
    return { host: fallback, before: null };
  }
  function mountProxy(proxy) {
    const { host, before } = proxyHost();
    if (before) host.insertBefore(proxy, before); else host.appendChild(proxy);
  }

  function proxyNodes() {
    let proxy = document.querySelector('[data-owner-review-proxy]');
    let end = document.querySelector('[data-owner-review-proxy-end]');
    if (proxy && end) return { proxy, end };
    proxy = el('span', 'owner-review-proxy', 'PM 代管中');
    proxy.setAttribute('data-owner-review-proxy', '1');
    proxy.title = 'PM 代管中：Owner 的决定由 PM 代记';
    end = el('button', 'owner-review-proxy-end', '结束代管');
    end.type = 'button';
    end.setAttribute('data-owner-review-proxy-end', '1');
    end.addEventListener('click', endProxy);
    mountProxy(proxy);
    // 「结束代管」收进弹窗头部，避免挤占标题栏（Owner 实测：标题栏溢出压住窗口按钮）。
    const head = dialogEl() && dialogEl().querySelector('.or-head');
    if (head) head.appendChild(end); else proxy.after(end);
    return { proxy, end };
  }

  function buildShell() {
    if (document.getElementById('owner-review-entry')) return;
    // T-46d9：两个入口固定到标题栏项目面板区域（#tb-owner-entries）；
    // 1280/1680 两宽只缩文字、不遮挡【文件夹】【更多】，不再挂侧栏底部。
    const host = document.getElementById('tb-owner-entries')
      || document.querySelector('#titlebar .titlebar-center')
      || document.getElementById('titlebar')
      || document.body;
    const entry = el('button', 'owner-review-entry tb-entry');
    entry.id = 'owner-review-entry';
    entry.type = 'button';
    entry.setAttribute('data-owner-review-entry', '1');
    entry.title = '我的评审：Owner 待决定的需求与本轮看板';
    entry.innerHTML = '<span class="tb-entry-ico" aria-hidden="true">审</span><span class="tb-entry-text">我的评审</span>';
    const badge = el('span', 'owner-review-badge', '0');
    badge.setAttribute('data-owner-review-badge', '1');
    entry.appendChild(badge);
    entry.addEventListener('click', () => openDialog(true));
    host.appendChild(entry);

    // 我的验收：验收的唯一动作入口（R-d734 F-1）。点击只打开项目面板里那一个 #accept-list，
    // 不新建第二套弹窗；面板内不再有第二个能提交验收的容器。
    const acceptEntry = el('button', 'owner-review-entry tb-entry owner-accept-entry');
    acceptEntry.id = 'tb-entry';
    acceptEntry.type = 'button';
    acceptEntry.setAttribute('data-owner-accept-entry', '1');
    acceptEntry.setAttribute('data-accept-anchor', 'accept-list');
    acceptEntry.title = '我的验收：打开项目面板的验收列表（#accept-list），点通过 / 打回一次落账';
    acceptEntry.innerHTML = '<span class="tb-entry-ico" aria-hidden="true">验</span><span class="tb-entry-text">我的验收</span>';
    const acceptBadge = el('span', 'owner-review-badge', '0');
    acceptBadge.setAttribute('data-owner-accept-badge', '1');
    acceptEntry.appendChild(acceptBadge);
    acceptEntry.addEventListener('click', openAcceptanceEntry);
    host.appendChild(acceptEntry);

    const dialog = el('div', 'owner-review-dialog');
    dialog.id = 'owner-review-dialog';
    dialog.setAttribute('data-owner-review-dialog', '1');
    dialog.hidden = true;
    dialog.innerHTML = [
      '<div class="or-card" role="dialog" aria-modal="true" aria-label="我的评审">',
      '  <div class="or-head"><b>我的评审</b><span><button type="button" class="or-close" data-or-noauto>不再自动弹</button> <button type="button" class="or-close" data-or-close>关闭</button></span></div>',
      '  <div class="or-banner" data-or-banner data-or-error hidden></div>',
      '  <div class="or-body">',
      '    <aside class="or-list" data-or-list></aside>',
      '    <section class="or-main">',
      '      <div class="or-title-row"><div class="or-title" data-or-title>暂时没有等你决定的事</div><span class="or-reviewer" data-or-reviewer hidden></span><button type="button" class="or-back" data-owner-back>← 返回列表</button></div>',
      '      <div class="or-materials" data-or-materials data-owner-material></div>',
      '      <div class="or-summary" data-or-summary-box></div>',
      '      <label class="or-opinion-label">写点意见（可不写）<textarea class="or-opinion" data-or-opinion data-owner-opinion maxlength="1000" placeholder="写点意见（可不写）"></textarea></label>',
      '      <div class="or-skip" data-or-skip-box hidden>',
      '        <label>分析师评估<input data-or-skip-analyst maxlength="300"></label>',
      '        <label>产品评估<input data-or-skip-product maxlength="300"></label>',
      '        <label>开发评估<input data-or-skip-dev maxlength="300"></label>',
      '        <p class="or-hint" data-or-skip-hint>还差分析师/产品/开发的一句评估</p>',
      '        <button type="button" class="or-skip-submit" data-or-skip-submit>提交跳过</button>',
      '      </div>',
      '      <div class="or-actions">',
      '        <button type="button" class="or-ok" data-or-approve>通过</button>',
      '        <button type="button" class="or-reject" data-or-reject>打回</button>',
      '        <button type="button" class="or-skip-btn" data-or-skip>先跳过</button>',
      '        <button type="button" class="or-proxy-all" data-or-proxy-all title="一次给当前等你决定和等你验收的需求开代管；后面每轮保持，随时可结束">全部交 PM 代管</button>',
      '      </div>',
      '    </section>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(dialog);
    // 代管状态（T-e921）：徽标挂 stage-bar「项目面板」旁，不再放标题栏末尾压【文件夹】；
    // 「结束代管」放弹窗头部（Owner 在弹窗里结束）。
    const proxy = el('span', 'owner-review-proxy is-compact', '');
    proxy.setAttribute('data-owner-review-proxy', '1');
    proxy.title = 'PM 代管中（Owner 的决定由 PM 代记，可在弹窗里结束代管）';
    const end = el('button', 'owner-review-proxy-end', '结束代管');
    end.type = 'button';
    end.setAttribute('data-owner-review-proxy-end', '1');
    end.addEventListener('click', endProxy);
    proxy.__endNode = end;
    mountProxy(proxy);
    dialog.querySelector('.or-head').appendChild(end);
    proxy.hidden = true;
    end.hidden = true;
    dialog.querySelector('[data-or-close]').addEventListener('click', closeDialog);
    // R-b417：返回列表——保留当前选中项，只把列表滚回顶部（看板/清单常驻左侧）。
    dialog.querySelector('[data-owner-back]')?.addEventListener('click', () => {
      const list = dialog.querySelector('[data-or-list]');
      if (list) list.scrollTop = 0;
      renderDialog();
    });
    dialog.querySelector('[data-or-noauto]').addEventListener('click', () => {
      sessionStorage.setItem(KEY_NO_AUTO, '1');
      closeDialog();
    });
    dialog.querySelector('[data-or-approve]').addEventListener('click', () => submit('approved'));
    dialog.querySelector('[data-or-reject]').addEventListener('click', () => submit('rejected'));
    dialog.querySelector('[data-or-skip]').addEventListener('click', () => {
      state.skipOpen = !state.skipOpen;
      const box = dialog.querySelector('[data-or-skip-box]');
      box.hidden = !state.skipOpen;
    });
    dialog.querySelector('[data-or-skip-submit]').addEventListener('click', () => submit('skipped'));
    for (const key of ['analyst', 'product', 'dev']) {
      dialog.querySelector(`[data-or-skip-${key}]`).addEventListener('input', (event) => {
        state.skipDraft[key] = event.target.value;
      });
    }
    // T-69ed：代管入口只留「全部交 PM 代管」（本轮/每轮两个按钮已移除，旧 once/always 记录照常读取）。
    dialog.querySelector('[data-or-proxy-all]').addEventListener('click', startProxyAll);
    dialog.querySelector('[data-or-opinion]').addEventListener('input', (event) => { state.draft = event.target.value; });
    dialog.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(); });
    // B-2ed9：卡片点击用事件委托兜底——重渲染/异步刷新后即使原节点被替换，点哪张就选哪张。
    dialog.addEventListener('click', (event) => {
      const card = event.target && event.target.closest ? event.target.closest('[data-or-req]') : null;
      if (!card) return;
      const id = String(card.getAttribute('data-or-req') || '');
      if (id && id !== String(state.selected || '')) selectRequirement(id);
    });
  }

  async function loadData() {
    const api = window.workbench;
    if (!api || !api.state) return;
    let store = null;
    try { store = await api.state(); } catch { return; }
    const project = store && Array.isArray(store.projects) ? (store.projects.find((p) => p.id === store.activeProjectId) || store.projects[0]) : null;
    if (!project) return;
    state.projectId = project.id;
    try {
      const data = await api.ownerReviewData({ projectId: project.id });
      if (data && data.ok) state.data = data;
    } catch { state.data = null; }
    // R-f8e1 B 清单：读 团队/状态/项目/<项目>/需求建议点.json；文件缺失/坏 JSON 只当作“无建议点”，不阻断评审。
    try {
      if (api.ownerSuggestions) {
        const sug = await api.ownerSuggestions({ projectId: project.id });
        state.suggestions = (sug && Array.isArray(sug.items)) ? sug.items : [];
      }
    } catch { state.suggestions = []; }
    // B-20261113-004955-5f62：先取代管记录再算徽标，否则「N 条等你决定」扣不掉已托管的那几条。
    await updateProxyBadge();
    updateBadge();
    if (dialogEl() && !dialogEl().hidden) renderDialog();
    // R-4f99 AC3：验收列表打开时也跟 5 秒轮询刷新（流程图/列表都 ≤6 秒内看到状态变化）。
    const acceptBox = document.getElementById('accept-list');
    if (acceptBox && !acceptBox.hidden) renderAcceptList();
  }

  // 已交 PM 代管的需求 id 集合（只算未结束记录）：徽标、待评估清单、列表标签共用一套口径。
  function proxyIdSet() {
    if (state.proxyIdSet instanceof Set) return state.proxyIdSet;
    return new Set();
  }
  function isProxied(req) {
    const id = String((req && req.id) || '');
    return Boolean(id) && proxyIdSet().has(id);
  }
  // T-a01d / B-4baa：代管落账标识——PM 代落的显示【PM通过】/【PM打回】/【PM跳过】；
  // 代管中还没落账显示【待 PM 评审】；Owner 本人显示【已通过】/【已打回】；
  // 旧数据没有 channel/recordedBy 时显示“来源未记”，不默认成 Owner（R-1cee F-R1/AC1）。
  function proxyTagOf(req) {
    const owner = (req && req.ownerReview) || {};
    const channel = String(owner.channel || '');
    const recordedBy = String(owner.recordedBy || '');
    const status = String(owner.status || '');
    const terminal = ['approved', 'rejected', 'skipped'].includes(status);
    if (channel === 'proxy' || recordedBy === 'pm') {
      if (status === 'approved') return '【PM通过】';
      if (status === 'rejected') return '【PM打回】';
      if (status === 'skipped') return '【PM跳过】';
      return '【待 PM 评审】';
    }
    if (terminal) {
      const suffix = !channel && !recordedBy ? '（来源未记）' : '';
      if (status === 'approved') return `【已通过${suffix}】`;
      if (status === 'rejected') return `【已打回${suffix}】`;
      return `【已跳过${suffix}】`;
    }
    return isProxied(req) ? '【待 PM 评审】' : '';
  }

  function updateBadge() {
    const badge = document.querySelector('[data-owner-review-badge]');
    const acceptBadge = document.querySelector('[data-owner-accept-badge]');
    const rows = pendingRows();
    // B-5f62：被代管覆盖的待评估项不再计入「N 条等你决定」，单独在顶部显示「PM 代管中 M 条」。
    const proxiedCount = rows.filter((row) => isProxied(row)).length;
    const count = Math.max(0, rows.length - proxiedCount);
    // T-46d9：标题栏角标只显示数字（窄宽不撑爆），完整说法放 title。
    if (badge) {
      badge.textContent = String(count);
      badge.classList.toggle('is-zero', count === 0);
      badge.title = count === 0
        ? '没有等你决定的需求'
        : `${count} 条等你决定${proxiedCount ? `；另有 ${proxiedCount} 条已交 PM 代管` : ''}`;
      badge.setAttribute('data-count', String(count));
    }
    // T-46d9：「我的验收」角标 = 本轮 test_done 且未交 PM 代管的需求数。
    const all = (state.data && Array.isArray(state.data.requirements)) ? state.data.requirements : [];
    const acceptRows = all.filter((row) => String((row && row.status) || '') === 'test_done' && !isProxied(row));
    if (acceptBadge) {
      acceptBadge.textContent = String(acceptRows.length);
      acceptBadge.classList.toggle('is-zero', acceptRows.length === 0);
      acceptBadge.title = acceptRows.length
        ? `待你验收 ${acceptRows.length} 条：${acceptRows.slice(0, 3).map((row) => String(row.id || '')).join('、')}${acceptRows.length > 3 ? ' 等' : ''}`
        : '本轮没有待验收需求';
      acceptBadge.setAttribute('data-count', String(acceptRows.length));
    }
    if (count) maybeAutoOpen(count);
  }

  async function updateProxyBadge() {
    if (!state.projectId || !window.workbench || !window.workbench.ownerProxyStatus) return;
    try {
      const r = await window.workbench.ownerProxyStatus({ projectId: state.projectId });
      const active = (r && r.active) || null;
      // 代管落账判定要用：本需求代管中 → decide 传 recordedBy=pm、channel=proxy（R-6f60 AC24.4）。
      state.proxy = active;
      // 列表里给“已代管”的需求打标（重开弹窗也能看到“已托管”）。
      state.proxyRecords = (r && Array.isArray(r.records)) ? r.records.filter((row) => !row.endedAt) : [];
      state.proxyIdSet = new Set(state.proxyRecords.map((row) => String(row.requirementId || '')).filter(Boolean));
      const count = state.proxyIdSet.size;
      if (count) {
        const { proxy, end } = proxyNodes();
        proxy.hidden = false;
        end.hidden = false;
        // B-5f62：顶部不再只给一个圆点，直接写「PM 代管中 M 条」，M = 未结束代管记录覆盖的需求数。
        proxy.textContent = `PM 代管中 ${count} 条`;
        proxy.title = `PM 代管中 ${count} 条：Owner 的决定由 PM 代记，可在弹窗里结束代管`;
        proxy.setAttribute('data-proxy-count', String(count));
        proxy.classList.remove('is-compact');
      } else {
        for (const selector of ['[data-owner-review-proxy]', '[data-owner-review-proxy-end]']) {
          const node = document.querySelector(selector);
          if (node) node.remove();
        }
      }
    } catch { /* ignore */ }
  }

  // Owner 规则（2026-11-13）：弹窗只在“需求评审”与“验收”阶段出现（owner_review 兼容旧流程）。
  function dialogStageAllowed() {
    const stage = String((state.data && state.data.stage) || '');
    return ['requirement_review', 'owner_review', 'owner_accept'].includes(stage);
  }
  function suggestTextOf(row, pending) {
    const status = String((row && row.status) || '');
    if (pending) return '建议拍板：通过 / 打回（右侧材料可先看）';
    if (status === 'review' || status === 'requirement_review') return '建议拍板：先过需求评审，再拍板';
    if (status === 'test_done') return '建议拍板：验收通过 / 打回';
    return '';
  }
  // T-a3e1：看板补两项——「怎么做」（功能点/方案要点）与「建议你拍板的地方」（待确认/风险/取舍），大白话 ≤60 字。
  function howTextOf(row) {
    const detail = String((row && row.detail) || '').replace(/\s+/g, ' ').trim();
    if (detail) {
      const hit = detail.match(/(?:怎么做|功能点|方案要点|实现要点)[：:]\s*([^；;。]{4,60})/);
      if (hit) return clip60(hit[1]);
      return clip60(detail);
    }
    const acceptance = String((row && (row.acceptance || row.acceptanceCriteria)) || '').replace(/\s+/g, ' ').trim();
    if (acceptance) return clip60(`按验收标准落地：${acceptance}`);
    return '按需求正文的功能点实现（正文未写方案要点）';
  }
  function adviceTextOf(row, pending) {
    const detail = String((row && row.detail) || '');
    const hit = detail.match(/(?:待确认|风险|取舍|建议)[：:]\s*([^；;。]{4,60})/);
    if (hit) return clip60(`建议你定：${hit[1]}`);
    if (pending) return '建议你定：通过 / 打回（不定后续派单一直停在这条）';
    // R-1cee F-R2：看板每条至少三行；已处理的需求也给一句兜底，不留空白。
    return '无特别建议，按通过 / 打回即可';
  }
  // 看板只列当前轮需求（T-a3e1）：本轮 = 需求行里最大的 round（工作流只保留当前轮 + 历史行）。
  function currentRoundOf(rows) {
    const rounds = (Array.isArray(rows) ? rows : []).map((row) => Number(row && row.round) || 1);
    return rounds.length ? Math.max(...rounds) : 1;
  }

  // ── B-504a「全部需求」清单（只做展示，不改流程）────────────────────────────────
  // 状态分组：等你决定 / 进行中 / 待验收 / 已收口；筛选只影响这处清单，不改任何落账口径。
  const LIST_BUCKETS = [
    { key: 'pending', label: '等你决定' },
    { key: 'running', label: '进行中' },
    { key: 'test_done', label: '待验收' },
    { key: 'closed', label: '已收口' },
  ];
  const CLOSED_REQ_STATUSES = ['accepted', 'done', 'terminated', 'iteration', 'rejected'];
  function listBucketOf(req) {
    const status = String((req && req.status) || '');
    if (isPending(req)) return 'pending';
    if (status === 'test_done') return 'test_done';
    if (CLOSED_REQ_STATUSES.includes(status)) return 'closed';
    return 'running';
  }
  function listDetailTextOf(req) {
    const body = String((req && (req.detail || req.story || req.acceptance || req.acceptanceCriteria)) || '').replace(/\s+/g, ' ').trim();
    return body;
  }
  // 证据链接：从 evidence 字符串里挑出项目内相对路径（报告/截图/正文），点开走既有的 openMaterial 只读弹层。
  function evidenceLinksOf(req) {
    const raw = String((req && req.evidence) || '');
    const found = raw.match(/[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5\-./\\]*\.(?:md|png|jpe?g|webp|txt|json|cjs)/g) || [];
    const seen = new Set();
    return found
      .map((rel) => rel.replace(/\\/g, '/'))
      .filter((rel) => {
        if (seen.has(rel)) return false;
        seen.add(rel);
        return true;
      })
      .slice(0, 4);
  }
  function renderAllRequirements(list, allRows) {
    const box = el('div', 'or-all');
    box.setAttribute('data-owner-all', '1');
    const head = el('h4', 'or-all-title');
    head.appendChild(el('b', '', '全部需求'));
    head.appendChild(el('span', 'or-muted', `（共 ${allRows.length} 条 · 按状态分组；点一行展开正文、分析师建议与证据）`));
    box.appendChild(head);

    const counts = { all: allRows.length, pending: 0, running: 0, test_done: 0, closed: 0 };
    for (const row of allRows) counts[listBucketOf(row)] = (counts[listBucketOf(row)] || 0) + 1;
    const chips = el('div', 'or-all-filters');
    chips.setAttribute('data-owner-all-filters', '1');
    const filterDefs = [{ key: 'all', label: '全部' }, ...LIST_BUCKETS];
    for (const def of filterDefs) {
      const chip = el('button', 'or-chip', `${def.label}（${counts[def.key] || 0}）`);
      chip.type = 'button';
      chip.setAttribute('data-owner-all-filter', def.key);
      if (state.listFilter === def.key) chip.classList.add('active');
      chip.addEventListener('click', () => { state.listFilter = def.key; renderDialog(); });
      chips.appendChild(chip);
    }
    box.appendChild(chips);

    const active = state.listFilter;
    const visible = allRows.filter((row) => active === 'all' || listBucketOf(row) === active);
    if (!visible.length) box.appendChild(el('p', 'or-empty', '这个分组里暂时没有需求'));
    const groups = active === 'all'
      ? LIST_BUCKETS.map((bucket) => ({ ...bucket, rows: visible.filter((row) => listBucketOf(row) === bucket.key) }))
      : [{ key: active, label: (LIST_BUCKETS.find((b) => b.key === active) || {}).label || active, rows: visible }];
    for (const group of groups) {
      if (!group.rows.length) continue;
      const groupBox = el('div', 'or-all-group');
      groupBox.setAttribute('data-owner-all-group', group.key);
      groupBox.appendChild(el('div', 'or-all-group-title', `${group.label} · ${group.rows.length} 条`));
      for (const req of group.rows) {
        groupBox.appendChild(renderAllRow(req));
      }
      box.appendChild(groupBox);
    }
    list.appendChild(box);
  }

  function renderAllRow(req) {
    const id = String(req.id || '');
    const pending = isPending(req);
    const proxyActive = isProxied(req);
    const what = clip60(humanizeTitle(req.title), 80);
    const blocked = clip60(blockedTextOf(req, pending, proxyActive));
    // 第三要素按需求落地人话说：待决定=通过/打回；待验收=验收通过/打回；其余给"要不要现在动它"。
    const advise = pending ? '建议你拍：通过 / 打回'
      : (String(req.status) === 'test_done' ? '建议你拍：验收通过 / 打回'
        : '建议你拍：先不动（继续按当前状态推进）');
    const open = state.listOpen.has(id);
    const item = el('div', 'or-all-row');
    item.setAttribute('data-owner-all-item', '1');
    item.setAttribute('data-or-req', id);
    item.setAttribute('data-or-status', String(req.status || ''));
    item.setAttribute('data-or-bucket', listBucketOf(req));
    item.setAttribute('data-or-expanded', open ? '1' : '0');
    // 三要素同时挂在行上（便于自检/读屏按行取），文案仍写在行内三行里。
    item.setAttribute('data-what', what);
    item.setAttribute('data-blocked', blocked);
    item.setAttribute('data-advice', advise);
    if (String(id) === state.selected) item.classList.add('selected');
    if (proxyActive) item.setAttribute('data-proxied', '1');
    const headRow = el('button', 'or-all-head');
    headRow.type = 'button';
    headRow.setAttribute('data-owner-all-toggle', '1');
    headRow.setAttribute('data-what', what);
    headRow.setAttribute('data-blocked', blocked);
    headRow.setAttribute('data-advice', advise);
    headRow.innerHTML = `<b>${esc(what)}</b>`
      + `<span class="or-all-k">这是什么</span><span class="or-all-v">${esc(what)}</span>`
      + `<span class="or-all-k">卡在哪</span><span class="or-all-v">${esc(blocked)}</span>`
      + `<span class="or-all-k">建议你拍什么</span><span class="or-all-v">${esc(advise)}</span>`
      + `<em>${esc(open ? '收起' : '展开')}</em>`;
    headRow.addEventListener('click', () => {
      if (state.listOpen.has(id)) state.listOpen.delete(id); else state.listOpen.add(id);
      selectRequirement(id);
    });
    item.appendChild(headRow);

    if (open) {
      const detail = el('div', 'or-all-detail');
      detail.setAttribute('data-owner-all-detail', '1');
      const body = listDetailTextOf(req);
      const bodyRow = el('div', 'or-all-detail-row');
      bodyRow.appendChild(el('b', '', '正文摘要'));
      bodyRow.appendChild(el('span', '', body ? clip60(body, 220) : '未记录（点「打开正文」看分析师原文）'));
      detail.appendChild(bodyRow);
      const adviceRow = el('div', 'or-all-detail-row');
      adviceRow.setAttribute('data-owner-all-advice', '1');
      adviceRow.appendChild(el('b', '', '分析师建议拍板'));
      adviceRow.appendChild(el('span', '', clip60(suggestTextOf(req, pending), 120)));
      detail.appendChild(adviceRow);
      const evidenceRow = el('div', 'or-all-detail-row');
      evidenceRow.setAttribute('data-owner-all-evidence', '1');
      evidenceRow.appendChild(el('b', '', '证据'));
      const links = evidenceLinksOf(req);
      if (!links.length) evidenceRow.appendChild(el('span', 'or-muted', String(req.evidence || '未记录')));
      for (const rel of links) evidenceRow.appendChild(materialLink(rel.split('/').pop() || rel, rel));
      detail.appendChild(evidenceRow);
      const actions = el('div', 'or-all-detail-actions');
      if (String(req.doc || '')) actions.appendChild(materialLink('打开需求正文', String(req.doc)));
      const pick = el('button', 'or-link', '在右侧材料里定位');
      pick.type = 'button';
      pick.addEventListener('click', () => selectRequirement(id));
      actions.appendChild(pick);
      detail.appendChild(actions);
      item.appendChild(detail);
    }
    return item;
  }
  function maybeAutoOpen(count) {
    if (!count) return;
    if (!dialogStageAllowed()) return; // 只在需求评审/验收阶段自动弹，其它阶段不打扰
    const dialog = dialogEl();
    if (!dialog || !dialog.hidden) return;
    if (sessionStorage.getItem(KEY_NO_AUTO) === '1') return;
    const later = Number(sessionStorage.getItem(KEY_LATER) || 0);
    if (later && Date.now() < later) return;
    openDialog(false);
  }

  // 决策失败的人话映射：错误码只放括号里，正文先讲“为什么现在不能过、要做什么”。
  const ERROR_HINTS = {
    TESTABILITY_REVIEW_REQUIRED: '缺可测性评审：先让测试人员把这条需求评成“可测”，再决定。',
    REQ_REVIEW_REQUIRED: '需求还没过评审：先让产品（或分析师）评审通过。',
    PRODUCT_REVIEW_REQUIRED: '需求还没过评审：先让产品（或分析师）评审通过。',
    PRODUCT_DESIGN_REQUIRED: '缺产品设计签字：先让产品提交设计、PM 签字后再派单。',
    TECH_REVIEW_REQUIRED: '缺技术评审：先让程序员A 出技术评审记录。',
    OWNER_REVIEW_REQUIRED: '缺 Owner 决定：这条需求还没走完 Owner 门。',
    OWNER_ACTION_REQUIRED: '代管通道已关闭：请 Owner 本人点通过/打回。',
    PROXY_UNAUTHORIZED: '代管缺少 Owner 授权：先请 Owner 在弹窗里开代管。',
    OWNER_CHANNEL_REQUIRED: '决定通道不对：界面决定必须走 ui 通道。',
    GATE_BYPASS_DENIED: '流程跳步了：这条需求的阶段和它的任务对不上，先补齐前面的步骤。',
    ROLE_NOT_IN_STAGE: '当前阶段还不该派这个角色：先推进到对应阶段。',
    TASK_OPEN: '对方手上还有没交的活：先让他交差，或者换个人。',
    PM_DISPATCH_PENDING: '上一条派单还没回执：等回执或先排队。',
    MEMORY_MISSING: '缺这轮的项目记忆：先写 1 条再完成。',
    NOT_PM: '这一步只有 PM 能做。',
    SELF_SEND: '不能发给自己。',
    // B-b55c：验收状态矛盾与同秒需求歧义，都用能读懂的人话说，不甩错误码。
    WORKFLOW_STATE_CHANGED: '列表里有这一条，但磁盘上的状态已经变了：已按磁盘为准，请刷新列表后再操作。',
    REQUIREMENT_AMBIGUOUS: '这个需求号同时命中多条需求：请用完整需求 id 再操作。',
    TEST_NOT_DONE: '这条需求还没到"测试完成"（test_done），现在不能验收。',
  };
  function humanizeError(err) {
    const raw = String((err && err.message) || err || '');
    const codeMatch = /\[([A-Z][A-Z0-9_]{2,})\]/.exec(raw) || /^([A-Z][A-Z0-9_]{2,})\b/.exec(raw);
    const code = (err && err.code) ? String(err.code) : (codeMatch ? codeMatch[1] : '');
    const hint = ERROR_HINTS[code] || '';
    const detail = raw.replace(/^\[[A-Z0-9_]+\]\s*/, '').trim();
    const title = hint || detail || '现在还不能提交这个决定';
    return { code, title, detail: hint ? detail : '' };
  }
  function showBanner(err) {
    const dialog = dialogEl();
    if (!dialog) return;
    const box = dialog.querySelector('[data-or-banner]') || dialog.querySelector('[data-or-error]');
    if (!box) return;
    const info = humanizeError(err);
    box.innerHTML = '';
    const head = el('div', 'or-banner-title', '⚠ 现在还不能提交');
    box.appendChild(head);
    box.appendChild(el('div', 'or-banner-reason', info.title));
    if (info.detail && info.detail !== info.title) box.appendChild(el('div', 'or-banner-detail', info.detail));
    if (info.code) box.appendChild(el('div', 'or-banner-code', `（错误码 ${info.code}）`));
    box.hidden = false;
    try { box.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
  }
  function hideBanner() {
    const dialog = dialogEl();
    if (!dialog) return;
    for (const sel of ['[data-or-banner]', '[data-or-error]']) {
      const box = dialog.querySelector(sel);
      if (box) box.hidden = true;
    }
  }
  // 成功反馈：绿色提示条，解决“点了像没生效”（2026-11-13 Owner 实测）。
  // B-5f62 补：`.or-head` 在 `.or-card` 里，往 dialog 上 insertBefore(head.nextSibling) 会抛
  // NotFoundError，把成功当失败弹红条（真机验证时抓到）。改成在 head 的父节点上插入，且提示条失败不阻断主流程。
  let noticeTimer = null;
  function showNotice(text) {
    const dialog = dialogEl();
    if (!dialog) return;
    try {
      let box = dialog.querySelector('[data-or-notice]');
      if (!box) {
        box = el('div', 'or-notice');
        box.setAttribute('data-or-notice', '1');
        const head = dialog.querySelector('.or-head');
        const card = (head && head.parentNode) || dialog.querySelector('.or-card') || dialog;
        if (head && head.nextSibling) card.insertBefore(box, head.nextSibling);
        else card.prepend(box);
      }
      box.textContent = text;
      box.hidden = false;
      if (noticeTimer) clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => { box.hidden = true; }, 6000);
    } catch { /* 提示条只是反馈，失败不影响已经成功的操作 */ }
  }
  async function startProxyAll() {
    const rows = rowsAwaitingOwner();
    if (!rows.length) {
      showBanner({ message: '当前没有等你决定或等你验收的需求，不需要批量代管。' });
      return;
    }
    const ids = rows.map((row) => String(row.id));
    try {
      const r = await window.workbench.ownerProxyStart({
        projectId: state.projectId,
        requirementIds: ids,
        scope: 'always',
        actor: 'owner',
        authorization: `Owner 在评审弹窗点击全部交 PM 代管（${ids.length} 条，含等你验收的需求）`,
      });
      if (!r || r.ok === false) throw new Error((r && (r.message || r.code)) || '批量开代管失败');
      // B-5f62：主进程按 requirementIds 逐条写记录后返回 started，这里按实际条数提示。
      const count = (r && Array.isArray(r.started)) ? r.started.length : ids.length;
      hideBanner();
      showNotice(`已开代管 ${count} 条：等你决定和等你验收的都在内；后面每轮保持，随时可结束`);
      await updateProxyBadge();
      updateBadge();
      renderDialog();
    } catch (e) {
      showBanner(e);
    }
  }

  function openDialog() {
    const dialog = dialogEl();
    if (!dialog || !dialog.hidden) return;
    dialog.hidden = false;
    // R-：DSH WebView 是独立合成层，z-index 盖不过它——打开弹窗时直接藏起 webview，关闭再恢复。
    document.body.classList.add('or-webview-hidden');
    if (!state.selected) {
      const pending = pendingRows();
      state.selected = pending.length ? String(pending[0].id) : '';
    }
    renderDialog();
  }

  function closeDialog() {
    const dialog = dialogEl();
    if (!dialog) return;
    dialog.hidden = true;
    document.body.classList.remove('or-webview-hidden');
    if (pendingRows().length) sessionStorage.setItem(KEY_LATER, String(Date.now() + 30 * 60 * 1000));
  }

  // ── R-4f99 双验收入口：顶部【验】打开 #accept-list，验收提交只在这里发生 ─────────────
  // 流程图需求行只留状态徽标 + [data-action="goto-accept"] 跳转（见 flow-v4.js）。
  function acceptRows() {
    const all = (state.data && Array.isArray(state.data.requirements)) ? state.data.requirements : [];
    return all.filter((row) => String((row && row.status) || '') === 'test_done');
  }
  function evidenceTextOf(row) {
    const acc = (row && row.acceptance) || {};
    const list = Array.isArray(acc.evidence) ? acc.evidence : [];
    if (!list.length) return '未挂证据（Owner 验收不强制；PM 代验收必须有报告+截图）';
    return list.map((item) => `${item.kind === 'report' ? '报告' : '截图'}：${item.path}`).join('；');
  }
  // B-b55c：列表与确认同源。列表显示"这份状态来自哪个文件、读于什么时候"，
  // 确认时把界面看到的状态与读盘时间回传，后端按同一份 工作流.json 重新读盘再判。
  function clockOf(iso) {
    const t = Date.parse(String(iso || ''));
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function acceptSource() {
    return (state.data && state.data.source) || {};
  }
  function acceptSourceText() {
    const src = acceptSource();
    const file = String(src.file || '').split(/[\\/]/).filter(Boolean).pop() || '工作流.json';
    const updated = clockOf(src.updatedAt || src.mtime);
    const readAt = clockOf(src.readAt);
    const parts = [`状态来源：${file}`];
    if (updated) parts.push(`更新于 ${updated}`);
    if (readAt) parts.push(`列表读于 ${readAt}`);
    return parts.join(' · ');
  }
  // 回传给确认接口的"界面当时看到的时刻"：后端据此判断列表是否过期，而不是报一个相反状态。
  function acceptExpectedStatus(row) {
    return String((row && row.status) || '');
  }
  function acceptExpectedAt() {
    return String(acceptSource().readAt || '');
  }
  function ensureAcceptList() {
    let box = document.getElementById('accept-list');
    // 与 d734/0a46 协调：若同 id 的容器不是本模块创建的（如项目面板静态 section），先把它的 id 让位，
    // 避免两个 #accept-list 并存、或本模块把别人的容器内容整套覆盖。让位后仍可被旧代码按新 id 找到。
    if (box && box.getAttribute('data-accept-list') !== '1') {
      box.id = 'legacy-accept-list';
      box.setAttribute('data-legacy-accept', '1');
      box = null;
    }
    if (box) return box;
    box = el('div', 'accept-panel');
    box.id = 'accept-list';
    box.setAttribute('data-accept-list', '1');
    box.hidden = true;
    box.innerHTML = ''
      + '<div class="accept-head"><b>我的验收 · 待验收需求</b>'
      + '<span class="accept-sub">验收提交只在这里；流程图只显示状态徽标与「去验收」跳转</span>'
      + '<button type="button" class="accept-close" data-accept-close>关闭</button></div>'
      + '<div class="accept-body" data-accept-body></div>'
      + '<div id="accept-missing-list" class="accept-missing" hidden></div>'
      + '<div class="accept-form" data-accept-form hidden></div>';
    document.body.appendChild(box);
    box.querySelector('[data-accept-close]').addEventListener('click', closeAcceptList);
    return box;
  }
  function closeAcceptList() {
    const box = document.getElementById('accept-list');
    if (box) box.hidden = true;
    document.body.classList.remove('or-webview-hidden');
    if (location.hash === '#accept-list') {
      try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
    }
  }
  function renderAcceptList() {
    const box = ensureAcceptList();
    const body = box.querySelector('[data-accept-body]');
    const rows = acceptRows();
    body.innerHTML = '';
    const form = box.querySelector('[data-accept-form]');
    if (form && form.hidden) { /* 保留已打开的表单 */ }
    if (!rows.length) body.appendChild(el('p', 'accept-empty', '暂无待验收需求（测试完成、状态 test_done 的才会出现在这里）'));
    // B-b55c：把列表的数据来源写在最上面（哪个文件、更新于/读于什么时候），
    // 配一个"刷新列表"：状态矛盾时先重读盘，而不是对着过期行反复点。
    const srcLine = el('div', 'accept-source');
    srcLine.setAttribute('data-accept-source', '1');
    srcLine.appendChild(el('span', 'accept-source-text', acceptSourceText()));
    const refreshBtn = el('button', 'accept-btn link', '刷新列表');
    refreshBtn.type = 'button';
    refreshBtn.setAttribute('data-action', 'accept-refresh');
    refreshBtn.addEventListener('click', async () => {
      await loadData();
      renderAcceptList();
      showNotice('已重新读盘：列表与验收确认现在读同一份 工作流.json');
    });
    srcLine.appendChild(refreshBtn);
    body.appendChild(srcLine);
    rows.forEach((row) => {
      const id = String(row.id || '');
      const item = el('div', 'accept-row');
      item.setAttribute('data-req-id', id);
      item.setAttribute('data-status', String(row.status || ''));
      const info = el('div', 'accept-info');
      info.appendChild(el('b', 'accept-title', clip60(humanizeTitle(row.title || id), 64)));
      info.appendChild(el('span', 'accept-line', `${id} ｜ 状态：待验收 ｜ 测试结论：测试已完成（test_done）`));
      info.appendChild(el('span', 'accept-line', `证据：${evidenceTextOf(row)}`));
      // 每一行也标一次来源时刻：行级状态来自哪次读盘，确认时回传同一时刻。
      info.appendChild(el('span', 'accept-line accept-line-source', `来源：${acceptSource().readAt ? `读盘 ${clockOf(acceptSource().readAt)}` : '未记读盘时间'}`));
      const badge = el('span', 'accept-badge', '待验收');
      badge.setAttribute('data-status', String(row.status || ''));
      info.appendChild(badge);
      item.appendChild(info);
      const actions = el('div', 'accept-actions');
      const ownerBtn = el('button', 'accept-btn', '通过');
      ownerBtn.type = 'button';
      ownerBtn.setAttribute('data-action', 'owner-accept');
      ownerBtn.title = '验收通过：需求出池归档';
      ownerBtn.addEventListener('click', () => ownerAcceptFlow(row, 'accepted'));
      // R-c431：验收行上直接给【打回】，打回必须填原因；打回后需求回到可整改，不再出池。
      const rejectBtn = el('button', 'accept-btn reject', '打回');
      rejectBtn.type = 'button';
      rejectBtn.setAttribute('data-action', 'owner-reject');
      rejectBtn.title = '验收打回：必须写原因，需求回到可整改';
      rejectBtn.addEventListener('click', () => ownerAcceptFlow(row, 'rejected'));
      const pmBtn = el('button', 'accept-btn proxy', '代验收（凭证据）');
      pmBtn.type = 'button';
      pmBtn.setAttribute('data-action', 'pm-accept');
      if (!isProxied(row)) {
        pmBtn.disabled = true;
        pmBtn.title = '该需求没有进行中的代管记录：请 Owner 先开代管，或由 Owner 本人验收';
      }
      pmBtn.addEventListener('click', () => pmAcceptFlow(row));
      const goto = el('button', 'accept-btn link', '在流程图里看');
      goto.type = 'button';
      goto.setAttribute('data-action', 'goto-flow');
      goto.addEventListener('click', () => {
        closeAcceptList();
        if (typeof setFlowPanel === 'function') setFlowPanel(true);
      });
      actions.appendChild(ownerBtn);
      actions.appendChild(rejectBtn);
      actions.appendChild(pmBtn);
      actions.appendChild(goto);
      item.appendChild(actions);
      body.appendChild(item);
    });
  }
  function acceptFormEl() {
    return ensureAcceptList().querySelector('[data-accept-form]');
  }
  function renderMissing(list) {
    // R-d734 AC3：页面里 #missing-list 归「项目面板状态检查」用（带 data-check-path 的文档缺失路径）；
    // 验收证据不合格清单改名 #accept-missing-list，避免两个容器抢同一个 id。
    const box = document.getElementById('accept-missing-list');
    if (!box) return;
    box.innerHTML = '';
    const rows = Array.isArray(list) ? list : [];
    if (!rows.length) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(el('b', '', '证据不合格：'));
    rows.forEach((row) => {
      const line = el('div', 'accept-missing-row');
      line.setAttribute('data-check-path', String(row.path || ''));
      const reason = String(row.reason || '');
      const label = reason === 'REPORT_REQUIRED' ? '缺测试报告（kind=report）'
        : reason === 'SCREENSHOT_REQUIRED' ? '缺截图（kind=screenshot）'
          : reason === 'FILE_NOT_FOUND' ? '文件不存在'
            : reason === 'EMPTY_PATH' ? '路径为空' : reason;
      line.textContent = `${row.path || '（未填）'} ｜ ${label}`;
      box.appendChild(line);
    });
  }
  // Owner 验收：一次确认弹窗（标题 / 测试结论 / 证据 / 影响），防误点。
  function ownerAcceptFlow(row, mode = 'accepted') {
    const rejecting = String(mode) === 'rejected';
    const form = acceptFormEl();
    form.hidden = false;
    form.innerHTML = '';
    form.setAttribute('data-accept-mode', rejecting ? 'rejected' : 'accepted');
    form.appendChild(el('h4', '', `${rejecting ? '确认打回' : '确认验收'}：${clip60(row.title || row.id, 60)}`));
    form.appendChild(el('p', 'accept-p', `需求：${row.id} ｜ 测试结论：测试已完成（test_done）`));
    form.appendChild(el('p', 'accept-p', `证据：${evidenceTextOf(row)}`));
    form.appendChild(el('p', 'accept-warn', rejecting
      ? '打回后该需求回到可整改（不再出池），PM 会收到打回原因。'
      : '验收后该需求出池并归档（已闭环），不会再有“迭代/下一轮”。'));
    const op = el('input', 'accept-input');
    op.setAttribute('data-accept-opinion', '1');
    op.maxLength = 200;
    op.setAttribute('placeholder', rejecting ? '打回原因（必填，至少 1 个字）' : '备注（可空）');
    if (rejecting) op.setAttribute('data-required', '1');
    form.appendChild(op);
    // B-b55c：确认框里也标一次来源，避免"列表和确认看的是两份快照"。
    form.appendChild(el('p', 'accept-p accept-form-source', acceptSourceText()));
    const err = el('p', 'accept-error');
    err.setAttribute('data-accept-error', '1');
    err.hidden = true;
    form.appendChild(err);
    const bar = el('div', 'accept-form-actions');
    const ok = el('button', 'accept-btn', rejecting ? '确认打回' : '确认验收');
    ok.type = 'button';
    ok.setAttribute('data-action', rejecting ? 'owner-reject-confirm' : 'owner-accept-confirm');
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      err.hidden = true;
      const opinion = String(op.value || '').trim();
      // R-c431：打回必须填原因——前端先拦一次，后端 OWNER_OPINION_REQUIRED 再兜一次。
      if (rejecting && !opinion) {
        err.hidden = false;
        err.setAttribute('data-error-code', 'OWNER_OPINION_REQUIRED');
        err.textContent = '打回必须写原因（至少 1 个字），否则不知道要改什么。';
        ok.disabled = false;
        return;
      }
      try {
        const r = await window.workbench.ownerAccept({
          projectId: state.projectId,
          requirementId: String(row.id),
          decision: rejecting ? 'rejected' : 'accepted',
          opinion,
          role: 'owner',
          // 界面看到的状态 + 读盘时刻：后端重新读盘后若不一致，明确说"列表过期"并给出两侧来源，
          // 不再把磁盘的真实状态报成界面看到的相反状态。
          expectedStatus: acceptExpectedStatus(row),
          expectedUpdatedAt: acceptExpectedAt()
        });
        if (!r || r.ok === false) {
          const error = new Error((r && (r.message || r.code)) || '验收失败');
          error.code = String((r && r.code) || '');
          error.source = (r && r.source) || null;
          throw error;
        }
        form.hidden = true;
        renderMissing([]);
        await loadData();
        renderAcceptList();
        showNotice(rejecting
          ? `已打回：${row.id}；需求回到可整改，PM 会收到打回原因`
          : `已验收：${row.id}；流程图 ≤6 秒内更新`);
      } catch (e) {
        err.hidden = false;
        const code = String((e && e.code) || '');
        // 错误码落在 DOM 上：自检/复跑可以直接断言是"列表过期"还是"真没到 test_done"。
        err.setAttribute('data-error-code', code);
        if (code === 'WORKFLOW_STATE_CHANGED') {
          // 后端已经写好"界面 X（读于 T1）/ 磁盘 Y（更新于 T2）+ 来源文件"这句人话。
          err.textContent = String((e && e.message) || '列表与磁盘状态不一致，已按磁盘为准');
          try {
            await loadData();
            renderAcceptList();
            showNotice('列表已按磁盘重读：请按新的状态再操作');
          } catch { /* 刷新失败不掩盖原错误 */ }
        } else {
          // 人话标题 + 后端原始原因（含磁盘状态与来源）：只给标题会丢掉到底哪条状态不对。
          const info = humanizeError(e);
          err.textContent = info.detail && info.detail !== info.title ? info.title + '（' + info.detail + '）' : info.title;
        }
        ok.disabled = false;
      }
    });
    const cancel = el('button', 'accept-btn', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { form.hidden = true; });
    bar.appendChild(ok); bar.appendChild(cancel);
    form.appendChild(bar);
  }
  // PM 代验收：必须带测试报告 + 截图；先校验文件存在与哈希，再提交。
  function pmAcceptFlow(row) {
    const form = acceptFormEl();
    form.hidden = false;
    form.innerHTML = '';
    renderMissing([]);
    form.appendChild(el('h4', '', `PM 代验收：${clip60(row.title || row.id, 60)}`));
    form.appendChild(el('p', 'accept-p', '门槛：测试报告 1 份 + 截图 ≥1 张，提交时必须已存在；没有证据不许点。'));
    const report = el('input', 'accept-input');
    report.setAttribute('data-accept-report', '1');
    report.setAttribute('placeholder', '测试报告路径（相对项目目录，如 测试人员/产出/测试报告-v45.md）');
    form.appendChild(report);
    const shots = el('textarea', 'accept-input');
    shots.setAttribute('data-accept-shots', '1');
    shots.rows = 3;
    shots.setAttribute('placeholder', '截图路径，每行一张（如 程序员A/产出/证据-v56/a.png）');
    form.appendChild(shots);
    const err = el('p', 'accept-error');
    err.setAttribute('data-accept-error', '1');
    err.hidden = true;
    form.appendChild(err);
    const bar = el('div', 'accept-form-actions');
    const ok = el('button', 'accept-btn proxy', '校验并代验收');
    ok.type = 'button';
    ok.setAttribute('data-action', 'pm-accept-submit');
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      err.hidden = true;
      const items = [];
      const reportPath = String(report.value || '').trim();
      const shotPaths = String(shots.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (reportPath) items.push({ path: reportPath, kind: 'report' });
      shotPaths.forEach((p) => items.push({ path: p, kind: 'screenshot' }));
      try {
        const check = await window.workbench.ownerEvidenceCheck({ projectId: state.projectId, items });
        renderMissing(check && check.missing);
        if (!check || check.ok === false) {
          err.hidden = false;
          err.textContent = 'PM 代验收需要测试报告 + 截图，且文件必须存在（缺哪项见上方清单）';
          ok.disabled = false;
          return;
        }
        const evidence = (check.items || []).filter((x) => x.exists).map((x) => ({ path: x.path, sha256: x.sha256, kind: x.kind }));
        const r = await window.workbench.ownerAccept({
          projectId: state.projectId,
          requirementId: String(row.id),
          decision: 'accepted',
          opinion: 'PM 代验收（凭证据）',
          role: 'pm',
          evidence,
          expectedStatus: acceptExpectedStatus(row),
          expectedUpdatedAt: acceptExpectedAt()
        });
        if (!r || r.ok === false) {
          if (r && r.missing) renderMissing(r.missing);
          const error = new Error((r && (r.message || r.code)) || '代验收失败');
          error.code = String((r && r.code) || '');
          throw error;
        }
        form.hidden = true;
        renderMissing([]);
        await loadData();
        renderAcceptList();
        showNotice(`已代验收：${row.id}（channel=proxy，证据 ${evidence.length} 项已留痕）`);
      } catch (e) {
        err.hidden = false;
        const code = String((e && e.code) || '');
        err.setAttribute('data-error-code', code);
        if (code === 'WORKFLOW_STATE_CHANGED') {
          err.textContent = String((e && e.message) || '列表与磁盘状态不一致，已按磁盘为准');
          try {
            await loadData();
            renderAcceptList();
            showNotice('列表已按磁盘重读：请按新的状态再操作');
          } catch { /* 刷新失败不掩盖原错误 */ }
        } else {
          err.textContent = humanizeError(e).title;
        }
        ok.disabled = false;
      }
    });
    const cancel = el('button', 'accept-btn', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { form.hidden = true; renderMissing([]); });
    bar.appendChild(ok); bar.appendChild(cancel);
    form.appendChild(bar);
  }
  /**
   * 我的验收（R-4f99）：顶部【验】是唯一入口，打开 #accept-list（URL 带 #accept-list）。
   * 流程图只留状态徽标 + 「去验收」跳转，点跳转进入同一列表、同一动作。
   */
  function openAcceptanceEntry() {
    const dialog = dialogEl();
    if (dialog && !dialog.hidden) closeDialog();
    document.body.classList.add('or-webview-hidden');
    try { if (location.hash !== '#accept-list') history.replaceState(null, '', '#accept-list'); } catch { /* ignore */ }
    const box = ensureAcceptList();
    box.hidden = false;
    renderAcceptList();
    const form = box.querySelector('[data-accept-form]');
    if (form) form.hidden = true;
    renderMissing([]);
  }
  // 供流程图行内「去验收」跳转调用（flow-v4.js）。
  window.__awbOpenAcceptList = openAcceptanceEntry;
  window.__awbAcceptRowCount = () => acceptRows().length;

  // R-b417（说人话）：看板三问 / 待评估三要素的文案映射与裸代号清洗。
  const BARE_CODE_RE = /\bR-\d{8,}-\w+\b|\bG\d+\b|\bAC\d+(\.\d+)?\b/;
  const IMPACT_ROLE = { pm: '项目经理', product: '产品设计师', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员', owner: '你（Owner）' };
  function clip60(text, max = 60) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  // 把裸代号移到括号里补充：能识别就不算“裸代号”；仍命中由 __awbCheckOwnerCopy 报出来。
  function humanizeTitle(text) {
    const raw = String(text || '').trim();
    if (!raw) return '未记录';
    const codes = [];
    const cleaned = raw.replace(/\b(R-\d{8,}-\w+)\b/g, (m) => { codes.push(m); return ''; }).replace(/\s{2,}/g, ' ').trim();
    if (!cleaned) return `这项需求（${codes.join('、')}）`;
    return codes.length ? `${cleaned}（${codes.join('、')}）` : cleaned;
  }
  function blockedTextOf(row, pending, proxied) {
    const status = String((row && row.status) || '');
    if (proxied) return '已交 PM 代管（你的决定由 PM 代记）';
    if (pending) return '卡在等你决定（Owner 门）';
    const map = {
      approved: '等 Owner 决定后派单', ready: '等 PM 派单', tech_review: '等技术评审',
      dev: '在开发', dispatched: '已派单、在开发', dev_review: '在互审', dev_done: '在等测试',
      test: '在测试', test_done: '等你验收', accepted: '已完成', terminated: '已终止',
      iteration: '在迭代', rejected: '被打回、要返工',
    };
    return map[status] || '进行中';
  }
  function impactTextOf(row) {
    const tasks = (state.data && Array.isArray(state.data.tasks)) ? state.data.tasks : [];
    const owners = [...new Set(tasks.filter((t) => String(t.requirementId || '') === String(row.id || '')).map((t) => String(t.owner || '')).filter(Boolean))];
    if (owners.length) return owners.map((id) => IMPACT_ROLE[id] || id).join('、');
    const direct = String((row && (row.owner || row.assignee)) || '');
    if (direct) return IMPACT_ROLE[direct] || direct;
    return '暂无人接手';
  }
  function evalTripleOf(row) {
    return {
      what: clip60(humanizeTitle(row.title), 80),
      why: clip60('这条需求停在 Owner 门，需要你决定通过、打回还是先跳过', 80),
      risk: clip60('不定会怎样：后续派单、开发、测试都停在这条，项目收不了口', 80),
    };
  }
  // 弹窗可见文本的裸代号检查（括号内、文件路径、代码块不算）。测试与自查都可调。
  window.__awbCheckOwnerCopy = function awbCheckOwnerCopy() {
    const dialog = dialogEl();
    if (!dialog) return { ok: true, hits: [], note: '弹窗未打开' };
    const roots = [dialog.querySelector('[data-owner-board]'), dialog.querySelector('[data-owner-eval]')].filter(Boolean);
    const hits = [];
    for (const root of roots) {
      const text = String(root.innerText || '').replace(/（[^）]*）/g, ' ').replace(/\([^)]*\)/g, ' ');
      for (const line of text.split(/\n+/)) {
        if (!line.trim()) continue;
        if (/(?:[A-Za-z]:[\\/]|\/|\\).*\.(?:md|js|mjs|json)/.test(line)) continue;
        if (BARE_CODE_RE.test(line)) hits.push(line.trim().slice(0, 120));
      }
    }
    return { ok: hits.length === 0, hits };
  };

  function renderDialog() {
    const dialog = dialogEl();
    if (!dialog) return;
    const allRows = (state.data && Array.isArray(state.data.requirements)) ? state.data.requirements.slice() : [];
    // T-a3e1：看板只列当前轮需求；待评估清单仍看全部（跨轮未决的也要能被点）。
    const round = currentRoundOf(allRows);
    const rows = allRows.filter((row) => (Number(row && row.round) || 1) === round);
    rows.sort((a, b) => (isPending(b) ? 1 : 0) - (isPending(a) ? 1 : 0));
    const list = dialog.querySelector('[data-or-list]');
    list.innerHTML = '';
    if (!rows.length) list.appendChild(el('p', 'or-empty', '本轮暂时没有等你决定的事'));
    // B-504a：先给「全部需求」清单（默认全量、按状态分组、可筛选、点行展开详情）；
    // 只做展示，不改变任何提交/落账口径。
    renderAllRequirements(list, allRows);
    // R-f8e1：A/B 双清单（批量评审，含逐条通过/打回）优先展示；
    // 原有「本轮需求看板」保留为只读速览（R-1cee 已验收的特性，不拆）。
    renderBatchSection(list);
    // ① 本轮需求看板（R-1cee F-R2）：每条写清“是什么 / 怎么做 / 建议拍板点 / 卡在哪 / 影响谁”，
    //    代号进括号；默认前 PREVIEW_ROWS 条，其余折叠在 DOM 里（hidden，不删、不裁切），可展开全部。
    const board = el('div', 'or-board');
    board.setAttribute('data-owner-board', '1');
    board.setAttribute('data-owner-board-round', String(round));
    board.appendChild(el('h4', 'or-board-title', `本轮需求（第 ${round} 轮）· 是什么 / 怎么做 / 建议拍板点 / 卡在哪 / 影响谁`));
    const boardInner = el('div', 'or-board-items');
    rows.forEach((req, index) => {
      const pending = isPending(req);
      const proxyActive = isProxied(req);
      const what = clip60(humanizeTitle(req.title));
      const how = clip60(howTextOf(req));
      const advice = clip60(adviceTextOf(req, pending));
      const blocked = clip60(blockedTextOf(req, pending, proxyActive));
      const impact = clip60(impactTextOf(req));
      const owner = (req && req.ownerReview) || {};
      const fullText = String((req && (req.detail || req.story || req.acceptance || req.acceptanceCriteria)) || '').trim();
      const item = el('button', 'or-item or-board-item');
      item.type = 'button';
      item.setAttribute('data-owner-board-item', '1');
      item.setAttribute('data-or-req', String(req.id || ''));
      item.setAttribute('data-what', what);
      item.setAttribute('data-how', how);
      item.setAttribute('data-advice', advice);
      item.setAttribute('data-blocked', blocked);
      item.setAttribute('data-impact', impact);
      item.setAttribute('data-or-summary', clip60(`${what}；${how}`));
      item.setAttribute('data-or-fulltext', fullText.slice(0, 4000));
      if (proxyActive) item.setAttribute('data-proxied', '1');
      const suggest = suggestTextOf(req, pending);
      if (suggest) item.setAttribute('data-suggest', clip60(suggest));
      item.setAttribute('data-id', String(req.id || ''));
      if (String(req.id) === state.selected) item.classList.add('selected');
      const status = pending ? '等你决定' : (STATUS_TEXT[statusOf(req)] || '已处理');
      const proxyTag = proxyTagOf(req);
      const statusText = proxyTag || (proxyActive ? status + ' · 已托管' : status);
      const basis = proxyTag && /PM通过|PM打回|PM跳过|来源未记/.test(proxyTag)
        ? `${String(owner.authorization || owner.proxy || '').trim() || '依据缺失'}${owner.at ? ' · ' + String(owner.at).slice(0, 16).replace('T', ' ') : ''}`
        : '';
      if (basis) item.setAttribute('data-or-basis', basis);
      item.innerHTML = `<b>${esc(clip60(humanizeTitle(req.title), 46))}</b>`
        + `<span class="or-what">是什么：${esc(what)}</span>`
        + `<span class="or-how">怎么做：${esc(how)}</span>`
        + `<span class="or-advice">建议拍板：${esc(advice)}</span>`
        + `<span>卡在哪：${esc(blocked)} ｜ 影响：${esc(impact)}</span>`
        + (suggest ? `<span class="or-suggest">${esc(suggest)}</span>` : '')
        + (basis ? `<span class="or-basis">代管依据：${esc(basis)}</span>` : '')
        + `<em>${esc(statusText)}</em>`;
      item.addEventListener('click', () => selectRequirement(req.id));
      if (index >= PREVIEW_ROWS && !state.boardExpanded) item.hidden = true;
      boardInner.appendChild(item);
    });
    if (rows.length > PREVIEW_ROWS) {
      const more = el('button', 'or-more', state.boardExpanded ? '收起' : `展开全部（${rows.length} 条）`);
      more.type = 'button';
      more.setAttribute('data-or-board-more', '1');
      more.setAttribute('aria-expanded', state.boardExpanded ? 'true' : 'false');
      more.addEventListener('click', () => { state.boardExpanded = !state.boardExpanded; renderDialog(); });
      boardInner.appendChild(more);
    }
    board.appendChild(boardInner);
    list.appendChild(board);
    // ② 待评估清单：只含 Owner 门未决的需求，每条三要素（≤80 字）。
    const evalBox = el('div', 'or-eval');
    evalBox.setAttribute('data-owner-eval', '1');
    evalBox.appendChild(el('h4', 'or-eval-title', '需要你评估 · 是什么 / 为什么需要你定 / 不定会怎样'));
    const evalInner = el('div', 'or-eval-items');
    const pendingRowsList = allRows.filter(isPending);
    // B-5f62：已交 PM 代管的待评估项从「需要你评估」里拿掉，和顶部徽标同一口径。
    const evalRows = pendingRowsList.filter((row) => !isProxied(row));
    const proxiedPending = pendingRowsList.length - evalRows.length;
    if (!evalRows.length) {
      evalInner.appendChild(el('p', 'or-empty', proxiedPending ? '需要你评估的事都已交 PM 代管，不用你逐条点' : '暂无需要你评估的事'));
    }
    if (proxiedPending && evalRows.length) {
      const note = el('p', 'or-muted', `另有 ${proxiedPending} 条已交 PM 代管（下面列表里标「已托管」），不在这里重复占位`);
      note.setAttribute('data-or-proxied-note', '1');
      evalInner.appendChild(note);
    }
    evalRows.forEach((req, index) => {
      const triple = evalTripleOf(req);
      const item = el('button', 'or-item or-eval-item');
      item.type = 'button';
      item.setAttribute('data-owner-eval-item', '1');
      item.setAttribute('data-or-req', String(req.id || ''));
      item.setAttribute('data-eval-what', triple.what);
      item.setAttribute('data-eval-why', triple.why);
      item.setAttribute('data-eval-risk', triple.risk);
      item.setAttribute('data-id', String(req.id || ''));
      if (String(req.id) === state.selected) item.classList.add('selected');
      item.innerHTML = `<b>${esc(triple.what)}</b>`
        + `<span>为什么需要你定：${esc(triple.why)}</span>`
        + `<span>不定会怎样：${esc(triple.risk)}</span>`;
      item.addEventListener('click', () => selectRequirement(req.id));
      if (index >= PREVIEW_ROWS && !state.evalExpanded) item.hidden = true;
      evalInner.appendChild(item);
    });
    if (evalRows.length > PREVIEW_ROWS) {
      const more = el('button', 'or-more', state.evalExpanded ? '收起' : `展开全部（${evalRows.length} 条）`);
      more.type = 'button';
      more.setAttribute('data-or-eval-more', '1');
      more.setAttribute('aria-expanded', state.evalExpanded ? 'true' : 'false');
      more.addEventListener('click', () => { state.evalExpanded = !state.evalExpanded; renderDialog(); });
      evalInner.appendChild(more);
    }
    evalBox.appendChild(evalInner);
    list.appendChild(evalBox);
    const req = rows.find((row) => String(row.id) === state.selected) || null;
    dialog.querySelector('[data-or-title]').textContent = req ? humanizeTitle(`${req.title || ''}（${req.id || ''}）`) : '暂时没有等你决定的事';
    // B-2ed9：同一需求已经落过同状态决定时，对应按钮置灰（禁止重复追加）；不同状态（如打回）仍可点。
    const decidedRow = req ? latestOwnerDecision(req) : null;
    const decidedStatus = String((decidedRow && (decidedRow.status || decidedRow.decision))
      || (req && req.ownerReview && req.ownerReview.status) || '');
    for (const [selector, targetStatus, verb] of [
      ['[data-or-approve]', 'approved', '通过'],
      ['[data-or-reject]', 'rejected', '打回'],
      ['[data-or-skip-submit]', 'skipped', '跳过'],
    ]) {
      const btn = dialog.querySelector(selector);
      if (!btn) continue;
      const done = Boolean(req && decidedRow && decidedStatus === targetStatus);
      btn.disabled = done;
      btn.setAttribute('data-or-decided', done ? '1' : '0');
      btn.title = done ? `已决定：${STATUS_TEXT[targetStatus] || targetStatus}；同一决定不重复落账` : `提交${verb}`;
    }
    // R-1cee F-R5/AC5：双模式同一口径；fast 的需求评审人是分析师，full 是产品。
    const reviewer = dialog.querySelector('[data-or-reviewer]');
    if (reviewer) {
      const fast = String((state.data && state.data.teamMode) || '') === 'fast';
      reviewer.hidden = false;
      reviewer.setAttribute('data-or-reviewer', fast ? 'analyst' : 'product');
      reviewer.textContent = fast ? '评审人：分析师' : '评审人：产品';
    }
    const opinion = dialog.querySelector('[data-or-opinion]');
    if (opinion.value !== state.draft) opinion.value = state.draft;
    const skipBox = dialog.querySelector('[data-or-skip-box]');
    if (skipBox) {
      skipBox.hidden = !state.skipOpen;
      for (const key of ['analyst', 'product', 'dev']) {
        const input = dialog.querySelector(`[data-or-skip-${key}]`);
        if (input && input.value !== state.skipDraft[key]) input.value = state.skipDraft[key];
      }
    }
    hideBanner();
    renderSummary(req);
    loadMaterials(req);
  }

  function selectRequirement(reqId) {
    if (state.selected !== String(reqId)) {
      state.selected = String(reqId);
      state.materials = null;
      state.materialsFor = '';
    }
    renderDialog();
  }

  async function loadMaterials(req) {
    if (!req) { renderMaterials(null); return; }
    const reqId = String(req.id);
    if (state.materialsFor === reqId && state.materials) { renderMaterials(req); return; }
    state.materials = null;
    state.materialsFor = reqId;
    const box = dialogEl().querySelector('[data-or-materials]');
    if (box) box.textContent = '材料加载中…';
    try {
      const data = await window.workbench.ownerReviewData({ projectId: state.projectId, requirementId: reqId });
      if (state.selected !== reqId) return;
      if (data && data.ok) state.materials = data.materials;
    } catch { /* ignore */ }
    if (state.selected === reqId) renderMaterials(req);
  }

  function materialLink(label, rel) {
    const link = el('button', 'or-link', label);
    link.type = 'button';
    link.addEventListener('click', () => openMaterial(rel));
    return link;
  }

  function renderMaterials(req) {
    const box = dialogEl().querySelector('[data-or-materials]');
    box.innerHTML = '';
    if (!req) return;
    const group = el('div', 'or-materials-row');
    group.appendChild(el('span', 'or-label', '该看：'));
    const materials = state.materials || null;
    const groups = (materials && Array.isArray(materials.groups)) ? materials.groups : [];
    if (!groups.length) group.appendChild(el('span', 'or-muted', '未记录'));
    else {
      for (const g of groups) {
        const label = String(g.label || g.key || '材料');
        const items = Array.isArray(g.items) ? g.items : [];
        if (!items.length) { group.appendChild(el('span', 'or-muted', `${label}：未记录`)); continue; }
        for (const item of items.slice(0, 3)) {
          const rel = String(item.rel || (item.versions && item.versions[0] && item.versions[0].rel) || '');
          if (rel) group.appendChild(materialLink(`${label} · ${item.name || rel}`, rel));
        }
      }
    }
    box.appendChild(group);
  }

  function renderSummary(req) {
    const box = dialogEl().querySelector('[data-or-summary-box]');
    box.innerHTML = '';
    box.setAttribute('data-or-selected-id', req ? String(req.id || '') : '');
    if (!req) return;
    // B-2ed9：右侧明确显示“当前选中”，提交前用它和列表选中做一致性校验，避免落到别的需求上。
    const idRow = el('div', 'or-summary-row or-selected-row');
    idRow.setAttribute('data-or-selected-label', '1');
    idRow.appendChild(el('b', '', '当前选中'));
    idRow.appendChild(el('span', '', `${req.id || ''}${req.title ? ' · ' + humanizeTitle(req.title) : ''}`));
    box.appendChild(idRow);
    const acceptance = typeof req.acceptance === 'string' && req.acceptance ? req.acceptance : '未记录';
    const fullDetail = String(req.detail || req.story || '').trim();
    // R-1cee F-R3/AC3：摘要 ≤60 字；全文另起一块（[data-or-detail]），不裁切。
    const detailSummary = clip60(fullDetail || String(req.title || '') || '未记录');
    const blocks = [
      ['需求摘要', detailSummary],
      // B-504a ④：打回前要能直接看到分析师正文与建议——正文摘要与详情全文一直在，这里再显式给一条建议拍板。
      ['分析师建议拍板', clip60(suggestTextOf(req, isPending(req)), 80)],
      ['验收点', acceptance],
      ['方案要点', String((req.designReview && (req.designReview.path || req.designReview.summary)) || '未记录')],
      ['测试结论', String((req.testReport && (req.testReport.verdict || req.testReport.path)) || '未记录')],
    ];
    for (const [label, value] of blocks) {
      const row = el('div', 'or-summary-row');
      row.appendChild(el('b', '', label));
      row.appendChild(el('span', '', value));
      box.appendChild(row);
    }
    if (fullDetail) {
      const detailRow = el('div', 'or-summary-row or-detail-row');
      detailRow.setAttribute('data-or-detail', '1');
      detailRow.appendChild(el('b', '', '详情全文'));
      detailRow.appendChild(el('span', '', fullDetail));
      box.appendChild(detailRow);
    }
  }

  async function openMaterial(rel) {
    const overlay = el('div', 'or-material-overlay');
    const card = el('div', 'or-material-card');
    const head = el('div', 'or-material-head');
    head.appendChild(el('b', '', rel));
    const close = el('button', '', '返回评审');
    close.type = 'button';
    close.addEventListener('click', () => overlay.remove());
    head.appendChild(close);
    const pre = el('pre', 'or-material-pre', '读取中…');
    card.appendChild(head);
    card.appendChild(pre);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    try {
      const r = await window.workbench.ownerMaterial({ projectId: state.projectId, rel });
      pre.textContent = String((r && (r.text || r.content || r.body)) || '未记录或不可读');
    } catch { pre.textContent = '未记录或不可读'; }
  }

  // ── R-f8e1 批量评审：A 本次待审需求 / B 需要你提建议的点 ────────────────
  // 口径：full 只收 status=ready（产品评审后的修改版）；fast 收分析师初版经 TR-Q 通过（open/review + trq.verdict=pass）。
  // 落账只写行级 decisions[]（走 owner:decide 的 applyOwnerDecisionToRequirement），打回另发 type=review_reject 给作者。
  function batchMode() {
    return String((state.data && state.data.teamMode) || 'full') === 'fast' ? 'fast' : 'full';
  }
  function batchCandidates() {
    const mode = batchMode();
    const all = (state.data && Array.isArray(state.data.requirements)) ? state.data.requirements : [];
    return all.filter((row) => {
      const st = String((row && row.status) || '');
      if (mode === 'fast') {
        const verdict = String((row && row.trq && row.trq.verdict) || '');
        return ['open', 'review'].includes(st) && verdict === 'pass';
      }
      return st === 'ready';
    });
  }
  function suggestionItems() {
    return Array.isArray(state.suggestions) ? state.suggestions : [];
  }
  function suggestionsOf(reqId) {
    return suggestionItems().filter((item) => String(item.reqId) === String(reqId));
  }
  function batchBriefOf(row) {
    const text = String((row && (row.detail || row.story || row.acceptance || row.title)) || '').replace(/\s+/g, ' ').trim();
    const first = text.split(/[。；;！!？?]/)[0] || text;
    return clip60(first || String((row && row.title) || ''), 60);
  }
  function batchPendingOf(row) {
    const text = String((row && (row.detail || row.story)) || '').replace(/\s+/g, ' ');
    const m = text.match(/(?:待确认|待定|需要你定|要你定)[：:]\s*([^。；\n]{1,60})/);
    return m ? m[1] : '无待定项';
  }
  function batchDefaultOpinion(row, suggestionRows, note) {
    const picked = suggestionRows.map((s) => `- ${s.text}（${s.id}）`).join('\n');
    return [String(note || '').trim(), picked ? `建议点：\n${picked}` : ''].filter(Boolean).join('\n').slice(0, 1000);
  }
  function renderBatchSection(list) {
    const rows = batchCandidates();
    const mode = batchMode();
    const box = el('div', 'rv-batch');
    box.setAttribute('data-owner-batch', '1');
    box.setAttribute('data-batch-mode', mode);
    const head = el('div', 'rv-batch-head');
    head.appendChild(el('b', '', `批量评审 · A 本次待审需求（${rows.length} 条）`));
    head.appendChild(el('span', 'rv-batch-note', mode === 'fast'
      ? '四人 fast：分析师初版经 TR-Q 通过；每条都未经产品评审'
      : '六人 full：只收产品评审后的修改版（ready）'));
    // 全选通过：仍逐条落 decisions，不写汇总。
    const selectAll = el('label', 'rv-selectall');
    const allCheck = el('input');
    allCheck.type = 'checkbox';
    allCheck.setAttribute('data-batch-select-all', '1');
    allCheck.addEventListener('change', () => {
      state.batchSelected = allCheck.checked ? new Set(rows.map((row) => String(row.id))) : new Set();
      renderDialog();
    });
    selectAll.appendChild(allCheck);
    selectAll.appendChild(document.createTextNode('全选'));
    head.appendChild(selectAll);
    const approveSelected = el('button', 'rv-mini-btn', `提交所选通过（${(state.batchSelected || new Set()).size}）`);
    approveSelected.type = 'button';
    approveSelected.setAttribute('data-action', 'batch-approve-selected');
    approveSelected.disabled = !(state.batchSelected && state.batchSelected.size);
    approveSelected.addEventListener('click', () => submitBatchApproved());
    head.appendChild(approveSelected);
    box.appendChild(head);
    if (!rows.length) box.appendChild(el('p', 'rv-empty', '暂无待审需求（full 需 ready；fast 需初版经 TR-Q 通过）'));
    // 排序：P0 优先 → 有待建议点优先 → 停顿时长（updatedAt 旧）倒序。
    const rank = { P0: 0, P1: 1, P2: 2, P3: 3 };
    rows.sort((a, b) => {
      const pa = rank[String(a.priority || 'P2').toUpperCase()] ?? 9;
      const pb = rank[String(b.priority || 'P2').toUpperCase()] ?? 9;
      if (pa !== pb) return pa - pb;
      const sa = suggestionsOf(a.id).length ? 0 : 1;
      const sb = suggestionsOf(b.id).length ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return String(a.updatedAt || '').localeCompare(String(b.updatedAt || ''));
    });
    const selected = state.batchSelected || new Set();
    const inner = el('div', 'rv-batch-items');
    rows.forEach((row) => {
      const id = String(row.id || '');
      const item = el('div', 'rv-batch-item');
      item.setAttribute('data-req-id', id);
      item.setAttribute('data-brief', batchBriefOf(row));
      item.setAttribute('data-mode', mode);
      const check = el('input', 'rv-batch-check');
      check.type = 'checkbox';
      check.setAttribute('data-batch-check', '1');
      check.checked = selected.has(id);
      check.addEventListener('change', () => {
        if (!state.batchSelected) state.batchSelected = new Set();
        if (check.checked) state.batchSelected.add(id); else state.batchSelected.delete(id);
        renderDialog();
      });
      item.appendChild(check);
      const main = el('div', 'rv-batch-main');
      const title = el('b', 'rv-batch-title', clip60(humanizeTitle(row.title || id), 70));
      main.appendChild(title);
      main.appendChild(el('span', 'rv-batch-line', `${row.kind === 'defect' ? '缺陷' : '需求'} ｜ ${id} ｜ 当前：${STATUS_TEXT[String(row.status || '')] || String(row.status || '')}`));
      main.appendChild(el('span', 'rv-batch-line', `我做了什么：${batchBriefOf(row)}`));
      main.appendChild(el('span', 'rv-batch-line', `要你定什么：${batchPendingOf(row)}`));
      if (mode === 'fast') main.appendChild(el('span', 'rv-batch-tag', '未经产品评审'));
      const sug = suggestionsOf(id);
      if (sug.length) main.appendChild(el('span', 'rv-batch-sug', `有 ${sug.length} 条待你提建议`));
      item.appendChild(main);
      const actions = el('div', 'rv-batch-actions');
      const okBtn = el('button', 'rv-mini-btn ok', '通过');
      okBtn.type = 'button';
      okBtn.setAttribute('data-action', 'batch-approve');
      okBtn.addEventListener('click', () => decideBatchOne(row, 'approved'));
      const noBtn = el('button', 'rv-mini-btn bad', '打回');
      noBtn.type = 'button';
      noBtn.setAttribute('data-action', 'batch-reject');
      noBtn.addEventListener('click', () => { state.reject = { id, reason: '', picks: new Set() }; renderDialog(); });
      actions.appendChild(okBtn);
      actions.appendChild(noBtn);
      item.appendChild(actions);
      inner.appendChild(item);
      // 打回输入区：说明必填（≥10 字）+ 勾选回传建议点。
      if (state.reject && state.reject.id === id) {
        const rej = el('div', 'rv-reject-box');
        rej.setAttribute('data-reject-box', id);
        rej.appendChild(el('p', 'rv-reject-hint', '打回必须写说明（≥10 字，写清哪不行、要怎么改）；勾选的建议点会原样回传给作者。'));
        const ta = el('textarea', 'rv-reject-reason');
        ta.setAttribute('data-reject-reason', '1');
        ta.maxLength = 500;
        ta.value = state.reject.reason || '';
        ta.setAttribute('placeholder', '例：范围太大，先只做 A 表和逐条落账，截图验收下一批');
        ta.addEventListener('input', () => { if (state.reject) state.reject.reason = ta.value; });
        rej.appendChild(ta);
        const picks = el('div', 'rv-reject-picks');
        const sugRows = suggestionsOf(id);
        if (!sugRows.length) picks.appendChild(el('span', 'rv-muted', '这条暂无建议点可回传'));
        sugRows.forEach((s) => {
          const lab = el('label', 'rv-pick');
          const cb = el('input');
          cb.type = 'checkbox';
          cb.setAttribute('data-reject-pick', s.id);
          cb.checked = Boolean(state.reject.picks && state.reject.picks.has(s.id));
          cb.addEventListener('change', () => {
            if (!state.reject) return;
            if (cb.checked) state.reject.picks.add(s.id); else state.reject.picks.delete(s.id);
          });
          lab.appendChild(cb);
          lab.appendChild(document.createTextNode(`${s.text}（${s.id}）`));
          picks.appendChild(lab);
        });
        rej.appendChild(picks);
        const row2 = el('div', 'rv-reject-actions');
        const go = el('button', 'rv-mini-btn bad', '确认打回');
        go.type = 'button';
        go.setAttribute('data-action', 'reject-confirm');
        go.addEventListener('click', () => decideBatchOne(row, 'rejected'));
        const cancel = el('button', 'rv-mini-btn', '取消');
        cancel.type = 'button';
        cancel.addEventListener('click', () => { state.reject = null; renderDialog(); });
        row2.appendChild(go); row2.appendChild(cancel);
        rej.appendChild(row2);
        if (state.batchError) rej.appendChild(el('p', 'rv-batch-error', state.batchError));
        inner.appendChild(rej);
      }
    });
    box.appendChild(inner);
    // B 清单：数据源 需求建议点.json；缺失/空显示“无建议点，可整体通过”。
    const sugBox = el('div', 'rv-sugs');
    sugBox.setAttribute('data-owner-suggest', '1');
    sugBox.appendChild(el('b', '', `B 需要你提建议的点（${suggestionItems().length} 条）`));
    if (!suggestionItems().length) {
      sugBox.appendChild(el('p', 'rv-empty', '无建议点，可整体通过'));
    } else {
      suggestionItems().forEach((s) => {
        const srow = el('button', 'rv-sug');
        srow.type = 'button';
        srow.setAttribute('data-suggestion-id', String(s.id));
        srow.setAttribute('data-req-id', String(s.reqId));
        srow.innerHTML = `<span class="rv-sug-req">${esc(String(s.reqId))}</span>`
          + `<span class="rv-sug-text">${esc(String(s.text || ''))}</span>`
          + `<span class="rv-sug-opt">选项：${esc((s.options || ['接受', '改', '拒']).join(' / '))}</span>`
          + `<span class="rv-sug-risk">不定会怎样：这条需求会一直停在这里</span>`;
        srow.addEventListener('click', () => {
          const target = ((state.data && state.data.requirements) || []).find((row) => String(row.id) === String(s.reqId));
          if (target) selectRequirement(target.id);
        });
        sugBox.appendChild(srow);
      });
    }
    box.appendChild(sugBox);
    list.appendChild(box);
  }

  async function decideBatchOne(row, status) {
    const id = String((row && row.id) || '');
    if (!id) return;
    let opinion = '';
    if (status === 'rejected') {
      const reason = String((state.reject && state.reject.reason) || '').trim();
      if (reason.length < 10) {
        state.batchError = `打回要写说明：至少 10 个字（现在 ${reason.length} 个字）。`;
        renderDialog();
        return;
      }
      const picks = suggestionsOf(id).filter((s) => state.reject && state.reject.picks && state.reject.picks.has(s.id));
      opinion = batchDefaultOpinion(row, picks, reason);
    }
    const proxyActive = Boolean(state.proxy && String(state.proxy.requirementId || '') === id && !state.proxy.endedAt);
    try {
      const r = await window.workbench.ownerDecide({
        projectId: state.projectId,
        requirementId: id,
        status,
        opinion,
        channel: proxyActive ? 'proxy' : 'ui',
        ...(proxyActive ? { recordedBy: 'pm' } : {}),
      });
      if (!r || r.ok === false) throw new Error((r && (r.message || r.code)) || '落账失败');
    } catch (e) {
      state.batchError = humanizeError(e).title;
      renderDialog();
      return;
    }
    state.batchError = '';
    if (status === 'rejected') {
      const to = String((row && (row.createdBy || row.owner)) || '').trim();
      const picks = suggestionsOf(id).filter((s) => state.reject && state.reject.picks && state.reject.picks.has(s.id));
      const reason = String((state.reject && state.reject.reason) || '').trim();
      if (to && window.workbench.ownerRejectNotify) {
        try {
          const note = await window.workbench.ownerRejectNotify({
            projectId: state.projectId,
            requirementId: id,
            to,
            subject: `评审打回：${id}`,
            body: `需求 ${id} 打回。\nOwner 说明：${reason}\n${picks.length ? picks.map((s) => `建议点：${s.text}（${s.id}）`).join('\n') : '未勾选建议点'}`
          });
          if (note && note.ok === false) showNotice(`已打回，但通知作者失败：${note.code || note.message || '未知'}`);
        } catch (e) {
          showNotice(`已打回，但通知作者失败：${humanizeError(e).title}`);
        }
      }
    }
    state.reject = null;
    if (state.batchSelected) state.batchSelected.delete(id);
    await loadData();
    showNotice(status === 'approved' ? `已通过：${id}` : `已打回：${id}`);
    renderDialog();
  }

  async function submitBatchApproved() {
    const ids = Array.from(state.batchSelected || []);
    if (!ids.length) return;
    const rows = ((state.data && state.data.requirements) || []).filter((row) => ids.includes(String(row.id)));
    let ok = 0;
    const fails = [];
    for (const row of rows) {
      try {
        const proxyActive = Boolean(state.proxy && String(state.proxy.requirementId || '') === String(row.id) && !state.proxy.endedAt);
        const r = await window.workbench.ownerDecide({
          projectId: state.projectId,
          requirementId: String(row.id),
          status: 'approved',
          channel: proxyActive ? 'proxy' : 'ui',
          ...(proxyActive ? { recordedBy: 'pm' } : {}),
        });
        if (r && r.ok !== false) ok += 1; else fails.push(String(row.id));
      } catch { fails.push(String(row.id)); }
    }
    state.batchSelected = new Set();
    await loadData();
    renderDialog();
    showNotice(`批量通过 ${ok}/${rows.length}${fails.length ? `；失败：${fails.join('、')}` : ''}`);
  }

  async function submit(status) {
    const dialog = dialogEl();
    if (!dialog || !state.selected) return;
    // B-2ed9：提交前校验“列表选中 = 右侧展示 = 真正要落账的需求”，任何不一致直接拦下，
    // 避免 Owner 以为在点 A、决定却记到 B 上（ea86 被连记 10 条就是这个）。
    const paneId = String((dialog.querySelector('[data-or-summary-box]') || {}).getAttribute
      ? dialog.querySelector('[data-or-summary-box]').getAttribute('data-or-selected-id')
      : '');
    if (!paneId || paneId !== String(state.selected)) {
      showBanner({ message: `选中不一致（列表：${state.selected || '空'}，右侧：${paneId || '空'}）：已阻止提交，请重新点一次需求卡片` });
      return;
    }
    const currentReq = ((state.data && state.data.requirements) || []).find((row) => String(row.id) === paneId) || null;
    const latest = currentReq ? latestOwnerDecision(currentReq) : null;
    const latestStatus = String((latest && (latest.status || latest.decision))
      || (currentReq && currentReq.ownerReview && currentReq.ownerReview.status) || '');
    if (latest && latestStatus === status) {
      showBanner({ message: `这条已经决定了（${STATUS_TEXT[status] || status}），同一决定不重复落账。` });
      return;
    }
    const opinionEl = dialog.querySelector('[data-or-opinion]');
    let opinion = String(opinionEl.value || '').trim();
    if (status === 'rejected' && !opinion) {
      showBanner({ message: '打回要写理由：在“写点意见”里说明哪不行、要怎么改。' });
      return;
    }
    let committee = null;
    let skipChannel = '';
    if (status === 'skipped') {
      // Owner 规则（2026-11-13）：跳过 = 三方共决，开发+产品+分析师各写一句书面意见，多数通过才可跳过。
      const analyst = String(dialog.querySelector('[data-or-skip-analyst]').value || '').trim();
      const product = String(dialog.querySelector('[data-or-skip-product]').value || '').trim();
      const dev = String(dialog.querySelector('[data-or-skip-dev]').value || '').trim();
      if (!analyst || !product || !dev) {
        showBanner({ message: `三方未齐：还差${!analyst ? '分析师' : (!product ? '产品' : '开发')}的书面意见；缺一不得跳过、不得推进。` });
        return;
      }
      const approveCount = [analyst, product, dev].filter((text) => /^(?!.*(?:不同意|不通过|不赞成|不可跳过|反对)).*(?:同意|通过|赞成|可跳过)/.test(text)).length;
      if (approveCount < 2) {
        showBanner({ message: `三方共决未通过：${approveCount}/3 写“同意”，至少 2 方同意才能跳过（当前意见已保留，请补齐后重提）。` });
        return;
      }
      committee = { analyst, product, dev, approveCount, verdict: 'passed', mode: 'committee' };
      skipChannel = 'skip_committee';
      opinion = `${opinion ? opinion + '\n' : ''}【三方共决·跳过 ${approveCount}/3】分析师：${analyst}\n产品：${product}\n开发：${dev}`;
    }
    try {
      // R-6f60：本需求处于代管中时，这次落账是 PM 代记 Owner 已给的决定（channel=proxy）。
      // 代管已结束/未开启时保持本人通道 ui；main.js 会再按代管记录校验，缺授权/已结束会拒。
      const proxyActive = Boolean(
        state.proxy
        && String(state.proxy.requirementId || '') === String(state.selected || '')
        && !state.proxy.endedAt
      );
      const r = await window.workbench.ownerDecide({
        projectId: state.projectId,
        requirementId: state.selected,
        status,
        opinion,
        channel: skipChannel || (proxyActive ? 'proxy' : 'ui'),
        ...(committee ? { committee } : {}),
        ...(proxyActive ? { recordedBy: 'pm' } : {}),
      });
      if (!r || r.ok === false) throw new Error((r && (r.message || r.code)) || '提交失败');
      // B-fe22：成功后必须给反馈——Owner 实测“点完像没生效”，就是因为没有成功提示。
      const title = String(((state.data && state.data.requirements) || []).find((row) => String(row.id) === String(state.selected))?.title || '').trim();
      const label = status === 'approved' ? '已通过' : (status === 'rejected' ? '已打回' : '已先跳过');
      state.draft = '';
      opinionEl.value = '';
      state.skipOpen = false;
      state.skipDraft = { analyst: '', product: '', dev: '' };
      state.materials = null;
      state.materialsFor = '';
      await loadData();
      // 这条已不在待评估里：选中下一条，避免正文停在旧条目上（否则看起来“列表没动”）。
      const next = pendingRows()[0];
      state.selected = next ? String(next.id) : '';
      showNotice(`${label}${title ? '：' + title : ''}；列表已更新`);
      if (!next) closeDialog(); else renderDialog();
    } catch (e) {
      showBanner(e);
    }
  }

  async function endProxy() {
    if (!state.projectId) return;
    try {
      await window.workbench.ownerProxyEnd({ projectId: state.projectId, actor: 'owner' });
      // B-5f62：结束代管后立刻把顶部条数、入口徽标、列表「已托管」一起刷新，不等 5 秒轮询。
      await updateProxyBadge();
      updateBadge();
      renderDialog();
    } catch { /* ignore */ }
  }

  function start() {
    buildShell();
    loadData();
    state.timer = setInterval(loadData, 5000);
    window.addEventListener('focus', loadData);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
