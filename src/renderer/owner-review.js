(function () {
  'use strict';
  const STATUS_TEXT = { approved: '已通过', rejected: '已打回', skipped: '已先跳过', pending: '等你决定', optional: '等你决定' };
  // B-4baa（R-1cee）：看板与待评估清单默认各展示前 5 条，其余折叠在 DOM 里（不删、不裁切），可展开全部。
  const PREVIEW_ROWS = 5;
  const state = { projectId: '', data: null, selected: '', draft: '', timer: null, skipOpen: false, skipDraft: { analyst: '', product: '', dev: '' }, materials: null, materialsFor: '', boardExpanded: false, evalExpanded: false, suggestions: [], batchSelected: new Set(), batchError: '', batchResult: null, reject: null, listFilter: 'all', listOpen: new Set(), closedCollapsed: true, proxyAllActive: false, proxyAllRecord: null, proxyAllExpiresAt: '', proxyReadError: '', decisionBox: [] };
  const KEY_LATER = 'awb.ownerReview.laterUntil';
  const KEY_NO_AUTO = 'awb.ownerReview.noAuto';
  // B-d100：打回后复审的判定收在 owner-review-state.js（Node 可单测）；脚本缺失时退回本文件旧逻辑。
  const OR_STATE = (typeof window !== 'undefined' && window.OwnerReviewState) ? window.OwnerReviewState : null;
  // B-1358：验收前置状态（测试任务/测试报告/截图/Owner 决定）判定收在 accept-prereq.js。
  const AP = (typeof window !== 'undefined' && window.AcceptPrereq) ? window.AcceptPrereq : null;
  // R-5550：AC 结构化解析/校验（正文 AC 块 → 卡片；缺项 → 显式标缺 + 统计）。
  const ACP = (typeof window !== 'undefined' && window.AcParse) ? window.AcParse : null;

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
    // B-d100：打回后已修改的需求要重新进待评审队列（旧实现只看 ownerReview.status='rejected' 就永久隐藏）。
    if (OR_STATE) return OR_STATE.isPending(req);
    const status = String((req && req.status) || '');
    const owner = decidedStatusOf(req);
    if (['accepted', 'terminated', 'iteration', 'rejected'].includes(status)) return false;
    if (['approved', 'skipped', 'rejected'].includes(owner)) return false;
    return status === 'approved' || status === 'owner_review';
  }
  /** B-d100：这一条是不是「打回后改完、等你复审」，以及复审标记文案。 */
  function reworkInfoOf(req) {
    if (OR_STATE) return OR_STATE.reworkInfo(req);
    return { isRework: false, label: '' };
  }
  function reworkChipHtml(req) {
    const info = reworkInfoOf(req);
    if (!info.isRework) return '';
    return `<span class="or-rework" data-or-rework="1" title="上次评审被你打回，修改后重新进入评审">${esc(info.label || '已修改待复审')}</span>`;
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
      // B-dee4：Owner 决定一律走派生值（decisions 末条优先）。只读 ownerReview.status 时，
      // 被产品复审重置成 pending 的已通过行会被算进「一键代管覆盖 N 条」，数字虚高、还会被再交出去一次。
      const owner = decidedStatusOf(row);
      if (['approved', 'skipped', 'rejected'].includes(owner)) return false;
      return isPending(row) || status === 'test_done';
    });
  }
  function dialogEl() { return document.querySelector('[data-owner-review-dialog]'); }

  // ── R-b28f：【一键代管】行（唯一挂载点 = 右下 #side-float 容器）────────────────────────
  // 7849 的「全部交 PM 代管」按钮原来在评审弹窗里；b28f 把入口搬到右下浮动组、改名「一键代管」，
  // 点击先弹权限说明再落账。锚点沿用 data-or-proxy-all（不新造 data-action="proxy-once"），
  // 状态唯一真源仍是 ownerProxyStatus()（评审代管.json），这里只做展示与交互，不另存一份状态。
  const PROXY_ROW_SELECTOR = '[data-or-proxy-all]';
  function proxyRowEl() { return document.querySelector(PROXY_ROW_SELECTOR); }
  function proxyRowLabel(row) { return row ? (row.querySelector('[data-proxy-label]') || row) : null; }
  function proxyApiState() {
    const api = window.workbench || {};
    return {
      canStart: typeof api.ownerProxyStart === 'function',
      canStatus: typeof api.ownerProxyStatus === 'function',
      canEnd: typeof api.ownerProxyEnd === 'function',
    };
  }
  function proxyExpiresText(value) {
    const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    return m ? { clock: `${m[4]}:${m[5]}`, full: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` } : null;
  }
  /** missing=壳层没有代管接口；error=读取代管失败；active/idle=正常两态。 */
  function proxyRowState() {
    const api = proxyApiState();
    if (!api.canStart || !api.canStatus) return 'missing';
    if (state.proxyReadError) return 'error';
    return state.proxyAllActive ? 'active' : 'idle';
  }
  /**
   * F-b28f-3 / AC3 / AC7：行态同步（唯一写入口，状态来自 ownerProxyStatus）。
   * idle「一键代管」｜active「代管中 · 到期 HH:MM」+ data-proxy-state=active｜
   * missing 置灰 + title「当前版本没有代管接口」，点击零副作用｜error「代管状态读取失败」+ 重试。
   */
  function syncProxyAllButton() {
    const row = proxyRowEl();
    if (!row) return;
    const label = proxyRowLabel(row);
    const rowState = proxyRowState();
    const expires = proxyExpiresText(state.proxyAllExpiresAt);
    row.setAttribute('data-proxy-state', rowState);
    row.setAttribute('data-proxy-all-state', rowState === 'active' ? 'active' : 'idle');
    row.disabled = rowState === 'missing';
    if (rowState === 'active' && state.proxyAllExpiresAt) row.setAttribute('data-proxy-expires-at', state.proxyAllExpiresAt);
    else row.removeAttribute('data-proxy-expires-at');
    // 7849 自检用 [data-owner-review-proxy-end] 找「结束代管」：搬家后这个锚点就是生效中的这一行
    // （点它 → 二次确认 → ownerProxyEnd，语义一致，所以 7849 断言不必改）。
    if (rowState === 'active') row.setAttribute('data-owner-review-proxy-end', '1');
    else row.removeAttribute('data-owner-review-proxy-end');
    if (rowState !== 'error') row.removeAttribute('data-proxy-retry');
    const modal = proxyModalEl();
    row.setAttribute('aria-expanded', modal && !modal.hidden ? 'true' : 'false');
    if (rowState === 'active') {
      if (label) label.textContent = expires ? `代管中 · 到期 ${expires.clock}` : '代管中';
      row.setAttribute('aria-label', `代管中${expires ? `，到期 ${expires.full}` : ''}；点这里结束代管`);
      row.title = expires ? `一键代管生效中（到期 ${expires.full}）；点这里结束` : '一键代管生效中；点这里结束';
      return;
    }
    if (rowState === 'missing') {
      if (label) label.textContent = '一键代管';
      row.setAttribute('aria-label', '一键代管：当前版本没有代管接口');
      row.title = '当前版本没有代管接口';
      return;
    }
    if (rowState === 'error') {
      if (label) label.textContent = '代管状态读取失败 · 重试';
      row.setAttribute('data-proxy-retry', '1');
      row.setAttribute('aria-label', '代管状态读取失败，点这里重试，不会开启或结束代管');
      row.title = `代管状态读取失败：${state.proxyReadError || '未知原因'}；点这里重试`;
      return;
    }
    if (label) label.textContent = '一键代管';
    row.setAttribute('aria-label', '一键代管：把评审、验收与决策箱回执的拍板权交给 PM（默认 8 小时，随时可结束）');
    row.title = '一键代管：点一下先看权限说明，确认后把评审 / 验收 / 决策箱回执的拍板权交给 PM（默认 8 小时，随时可结束）';
  }

  // 浮动区人话横幅（失败带错误码）：绝对定位在容器上方，不占行位、不影响四行几何。
  let proxyBannerTimer = null;
  function proxyBannerHost() {
    const host = document.getElementById('side-float');
    if (!host) return null;
    let box = host.querySelector('[data-proxy-banner]');
    if (!box) {
      box = el('div', 'side-float-banner');
      box.setAttribute('data-proxy-banner', '1');
      box.setAttribute('role', 'status');
      box.hidden = true;
      host.appendChild(box);
    }
    return box;
  }
  function showProxyBanner(text, kind, code) {
    const box = proxyBannerHost();
    if (!box) {
      if (typeof window.toast === 'function') window.toast(text, kind === 'ok' ? 'ok' : 'bad');
      return;
    }
    box.innerHTML = '';
    box.setAttribute('data-kind', kind === 'ok' ? 'ok' : 'bad');
    box.appendChild(el('b', '', String(text || '')));
    if (code) box.appendChild(el('code', '', String(code)));
    box.hidden = false;
    if (proxyBannerTimer) clearTimeout(proxyBannerTimer);
    proxyBannerTimer = setTimeout(() => { box.hidden = true; }, kind === 'ok' ? 5000 : 12000);
  }
  function hideProxyBanner() {
    const host = document.getElementById('side-float');
    const box = host ? host.querySelector('[data-proxy-banner]') : null;
    if (box) box.hidden = true;
  }

  /**
   * 7849 AC3-补：评审弹窗「决策箱」分区。
   * - 只在 scope=all 代管有效期内渲染（结束/过期 → 整个分区消失，锚点数量 1 → 0）；
   * - 按钮带 data-proxy-decide-entry，点击走 owner:decision-ack 的 proxy 通道；
   * - 已代回执的条目标【PM代管回执】（判据 decision.channel=proxy）。
   */
  function decisionBoxSection() {
    if (!state.proxyAllActive) return null;
    const rows = Array.isArray(state.decisionBox) ? state.decisionBox : [];
    const box = el('div', 'or-decisions');
    box.setAttribute('data-proxy-decide-section', '1');
    const head = el('h4', 'or-eval-title', '决策箱（PM 代回执）');
    head.title = `全部代管生效中：到期 ${String(state.proxyAllExpiresAt || '').slice(0, 19).replace('T', ' ')}；结束代管后本区与代回执按钮立即消失`;
    box.appendChild(head);
    if (!rows.length) {
      box.appendChild(el('p', 'or-empty', '决策箱里暂时没有条目'));
      return box;
    }
    for (const item of rows.slice(0, 12)) {
      const id = String((item && item.id) || '');
      const status = String((item && item.status) || '');
      const proxyAcked = String((item && item.decision && item.decision.channel) || '') === 'proxy';
      const row = el('div', 'or-decision-row');
      row.setAttribute('data-proxy-decision-id', id);
      row.appendChild(el('b', 'or-decision-title', clip60(String((item && item.title) || id), 60)));
      if (proxyAcked) {
        const tag = el('span', 'or-proxy-tag', '【PM代管回执】');
        tag.setAttribute('data-proxy-decision-tag', '1');
        row.appendChild(tag);
      } else if (status === 'open') {
        for (const option of (Array.isArray(item.options) ? item.options : [])) {
          const btn = el('button', 'or-link or-proxy-decide', `代回执：${option}`);
          btn.type = 'button';
          btn.setAttribute('data-proxy-decide-entry', '1');
          btn.setAttribute('data-decision-id', id);
          btn.setAttribute('data-choice', String(option));
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
              const r = await window.workbench.ownerDecisionAck({
                projectId: state.projectId, id, choice: String(option), opinion: '', channel: 'proxy',
              });
              if (!r || r.ok === false) throw new Error((r && (r.message || r.code)) || '代回执失败');
              showNotice(`已代回执 ${id}：${option}（PM 名义落账，不冒充 Owner）`);
              await loadData();
            } catch (e) {
              showBanner(e);
            } finally { btn.disabled = false; }
          });
          row.appendChild(btn);
        }
      } else {
        row.appendChild(el('span', 'or-muted', '（已回执）'));
      }
      box.appendChild(row);
    }
    if (rows.length > 12) box.appendChild(el('p', 'or-muted', `还有 ${rows.length - 12} 条未列出`));
    return box;
  }

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

  // 只读代管徽标（F-b28f-6）：开/关代管按钮全部搬到右下 #side-float【一键代管】行，
  // 弹窗里不再有第二个入口；stage-bar 上的徽标保留不动（T-e921），锚点仍唯一。
  function proxyNodes() {
    let proxy = document.querySelector('[data-owner-review-proxy]');
    if (proxy) return { proxy };
    proxy = el('span', 'owner-review-proxy', 'PM 代管中');
    proxy.setAttribute('data-owner-review-proxy', '1');
    proxy.title = 'PM 代管中：Owner 的决定由 PM 代记';
    mountProxy(proxy);
    return { proxy };
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
    entry.title = '我的评审：Owner 待决定的需求与当前看板';
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
      // F-b28f-6：开/关代管都不在弹窗里了，只留这一行只读说明（开关在右下【一键代管】行）。
      '        <span class="or-proxy-note" data-or-proxy-note title="开代管 / 结束代管都在主界面右下角的【一键代管】行">开/关代管在右下角【一键代管】</span>',
      '      </div>',
      // B-3065 AC2：已决定的行按钮禁用时，把「为什么不能点」写在这里（不只靠 title）。
      '      <p class="or-hint or-lock-reason" data-or-lock-reason hidden></p>',
      '    </section>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(dialog);
    // 代管只读徽标（T-e921）：挂 stage-bar「项目面板」旁，不再放标题栏末尾压【文件夹】。
    // R-b28f：「结束代管」已移出弹窗（改为点右下「代管中 · 到期」行二次确认），此处不再建按钮。
    const proxy = el('span', 'owner-review-proxy is-compact', '');
    proxy.setAttribute('data-owner-review-proxy', '1');
    proxy.title = 'PM 代管中（Owner 的决定由 PM 代记；开/关代管在右下角【一键代管】）';
    mountProxy(proxy);
    proxy.hidden = true;
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
    // R-b28f：开/关代管的唯一入口是右下 #side-float 的【一键代管】行（弹窗里已无按钮）。
    // 绑定放在这里（buildShell 只跑一次），行是 index.html 的静态节点，脚本加载即有。
    bindProxyRow();
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
      // R-5550 AC5：解析结果在**加载时**统一算好（看板与弹窗共用同一份），渲染处不再各自取数。
      if (ACP && state.data && Array.isArray(state.data.requirements)) {
        for (const row of state.data.requirements) row.__ac = ACP.analyzeRequirement(row);
      }
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
    // 7849 AC3-补：代管期内 PM 代回执需要决策箱条目——只在「全部代管生效」时读，省一次 IPC。
    if (state.proxyAllActive && api.teamDecisionBox) {
      try {
        const box = await api.teamDecisionBox({ projectId: project.id });
        state.decisionBox = (box && Array.isArray(box.items)) ? box.items : [];
      } catch { state.decisionBox = []; }
    } else {
      state.decisionBox = [];
    }
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
    if (!id) return false;
    // 7849 AC1：scope=all 是「全项目代管」——非终态需求一律算在代管内（不必逐条有记录）。
    if (state.proxyAllActive) {
      const status = String((req && req.status) || '');
      if (!['accepted', 'terminated', 'rejected'].includes(status)) return true;
    }
    return proxyIdSet().has(id);
  }
  // T-a01d / B-4baa / 7849：代管落账标识——PM 代落的显示【PM代管通过】/【PM代管打回】/【PM代管跳过】/
  // 【PM代管验收】/【PM代管回执】（旧 once/always 记录照读，判定口径 channel/recordedBy 不变）；
  // 代管中还没落账显示【待 PM 评审】；Owner 本人显示【已通过】/【已打回】；
  // 旧数据没有 channel/recordedBy 时显示“来源未记”，不默认成 Owner（R-1cee F-R1/AC1）。
  function proxyTagOf(req) {
    const owner = (req && req.ownerReview) || {};
    const channel = String(owner.channel || '');
    const recordedBy = String(owner.recordedBy || '');
    const status = String(owner.status || '');
    const terminal = ['approved', 'rejected', 'skipped'].includes(status);
    // 7849 AC7：代管验收单独一个标识（验收记录在 acceptanceRecord 上，不在 ownerReview 上）。
    const acceptance = (req && req.acceptanceRecord) || {};
    if (String(acceptance.channel || '') === 'proxy' && String(acceptance.by || '') === 'pm') {
      return String(acceptance.status || '') === 'accepted' ? '【PM代管验收】' : '【PM代管验收·打回】';
    }
    // 7849 F-7849-7：代管落账标识统一成【PM代管通过/打回/跳过】（旧简短字样同步替换成新文案）。
    if (channel === 'proxy' || recordedBy === 'pm') {
      if (status === 'approved') return '【PM代管通过】';
      if (status === 'rejected') return '【PM代管打回】';
      if (status === 'skipped') return '【PM代管跳过】';
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
  // 7849 AC7：代管口径的标识集合（含验收/回执），用于列表「已托管」判定。
  function isProxyTag(tag) {
    return /PM代管(通过|打回|跳过|验收|回执)|PM通过|PM打回|PM跳过|来源未记/.test(String(tag || ''));
  }

  // ── B-3065 批量评审口径（AC1/AC2/AC5）──────────────────────────────────────
  // 只读需求行现有字段，不新造状态：来源判定沿用 R-1cee 的 ownerReview.channel/recordedBy 口径。
  const DECISION_BADGE = { approved: '已通过', rejected: '已打回', skipped: '已跳过' };
  function ownerReviewStatusOf(req) {
    const fromDecision = decidedStatusOf(req);
    if (fromDecision) return fromDecision;
    return String((req && req.ownerReview && req.ownerReview.status) || '');
  }
  function ownerReviewSourceOf(req) {
    const owner = (req && req.ownerReview) || {};
    const latest = latestOwnerDecision(req) || {};
    const channel = String(owner.channel || latest.channel || '').toLowerCase();
    const recordedBy = String(owner.recordedBy || latest.recordedBy || '').toLowerCase();
    if (channel === 'proxy' || recordedBy === 'pm') return 'PM 代记';
    if (channel === 'ui' || channel === 'tty') return '本人';
    return '来源未记';
  }
  // AC5 状态徽标：先看需求行走到哪（已派单/开发中），再看 Owner 决定（已通过/已打回）。
  function statusBadgeOf(req) {
    const status = String((req && req.status) || '');
    if (status === 'accepted') return { text: '已完成', kind: 'ok' };
    if (status === 'terminated') return { text: '已终止', kind: 'bad' };
    if (status === 'iteration') return { text: '迭代中', kind: 'warn' };
    if (status === 'rejected') return { text: '已打回', kind: 'bad' };
    if (status === 'ready') return { text: '已通过', kind: 'ok' };
    if (status === 'dispatched') return { text: '已派单', kind: 'warn' };
    if (['dev', 'dev_review', 'dev_done'].includes(status)) return { text: '开发中', kind: 'info' };
    if (status === 'test') return { text: '测试中', kind: 'info' };
    if (status === 'test_done') return { text: '待验收', kind: 'warn' };
    const owner = ownerReviewStatusOf(req);
    if (DECISION_BADGE[owner]) return { text: DECISION_BADGE[owner], kind: owner === 'approved' ? 'ok' : (owner === 'rejected' ? 'bad' : 'warn') };
    return { text: '等你决定', kind: 'pending' };
  }
  function stageLabelOf(req) {
    const map = {
      ready: '待派单', dispatched: '已派单', dev: '开发中', dev_review: '开发互审', dev_done: '等测试',
      test: '测试中', test_done: '待验收', accepted: '已验收', terminated: '已终止', iteration: '迭代中', rejected: '已打回',
    };
    return map[String((req && req.status) || '')] || '';
  }
  /**
   * AC2：这条还能不能点 Owner 决定。null=可点；否则 {code,text} 说明为什么禁用。
   * 打回后已修改（复审）仍算等你决定；已通过/已跳过/已越门的一律锁定。
   */
  function ownerActionLockOf(req) {
    if (!req) return null;
    if (isPending(req)) return null;
    const decided = ownerReviewStatusOf(req);
    if (!DECISION_BADGE[decided]) return null;
    const source = ownerReviewSourceOf(req);
    const stage = stageLabelOf(req);
    return {
      code: 'OWNER_ALREADY_DECIDED',
      text: `${DECISION_BADGE[decided]}（${source}）${stage ? ' · ' + stage : ''}`,
    };
  }
  function statusBadgeEl(req) {
    const badge = statusBadgeOf(req);
    const node = el('span', 'or-status-badge', badge.text);
    node.setAttribute('data-or-status-badge', '1');
    node.setAttribute('data-badge-kind', badge.kind);
    return node;
  }
  function sourceBadgeEl(req) {
    const node = el('span', 'or-source-badge', ownerReviewSourceOf(req));
    node.setAttribute('data-or-source-badge', '1');
    return node;
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
        : '当前没有待验收需求';
      acceptBadge.setAttribute('data-count', String(acceptRows.length));
    }
    if (count) maybeAutoOpen(count);
  }

  async function updateProxyBadge() {
    if (!state.projectId) return;
    // AC7 降级：壳层没有读接口 → 行由 syncProxyAllButton 置灰（missing），不伪装成未启用/已结束。
    if (!window.workbench || typeof window.workbench.ownerProxyStatus !== 'function') {
      syncProxyAllButton();
      return;
    }
    try {
      const r = await window.workbench.ownerProxyStatus({ projectId: state.projectId });
      // B-20261115-070547-2ed0（R-b28f AC7）：主进程读盘失败会带回 readError（IPC 仍 ok:true），
      // 这里必须当成「读取失败」而不是「没有代管」，否则会显示成未启用。
      if (r && r.readError) {
        const reason = String((r.readError && (r.readError.message || r.readError.code)) || '评审代管.json 读取失败').slice(0, 160);
        state.proxyReadError = reason;
        state.proxy = null;
        state.proxyAllActive = false;
        state.proxyAllRecord = null;
        state.proxyAllExpiresAt = '';
        state.proxyRecords = [];
        state.proxyIdSet = new Set();
        state.proxyCount = 0;
        syncProxyAllButton();
        syncProxyNote();
        return;
      }
      state.proxyReadError = '';
      const active = (r && r.active) || null;
      // 代管落账判定要用：本需求代管中 → decide 传 recordedBy=pm、channel=proxy（R-6f60 AC24.4）。
      state.proxy = active;
      // 列表里给“已代管”的需求打标（重开弹窗也能看到“已托管”）。
      state.proxyRecords = (r && Array.isArray(r.records)) ? r.records.filter((row) => !row.endedAt) : [];
      state.proxyIdSet = new Set(state.proxyRecords.map((row) => String(row.requirementId || '')).filter(Boolean));
      // 7849 AC1：scope=all 是一条全项目记录——只要「未结束 + 未过期」，所有非终态需求都算代管覆盖。
      state.proxyAllActive = Boolean(r && r.allActive);
      state.proxyAllRecord = (r && r.allRecord) || null;
      state.proxyAllExpiresAt = state.proxyAllRecord ? String(state.proxyAllRecord.expiresAt || '') : '';
      let count = state.proxyIdSet.size;
      if (state.proxyAllActive) {
        const rows = (state.data && Array.isArray(state.data.requirements)) ? state.data.requirements : [];
        // B-11ce：同一口径（无 status 行不计入），别再让徽标数字虚高。
        const coveredRows = OR_STATE ? OR_STATE.proxyCoveredRows(rows) : rows.filter((row) => String((row && row.status) || ''));
        count = Math.max(count, coveredRows.length);
      }
      if (count) {
        const { proxy } = proxyNodes();
        proxy.hidden = false;
        // B-5f62：顶部不再只给一个圆点，直接写「PM 代管中 M 条」，M = 未结束代管记录覆盖的需求数。
        proxy.textContent = `PM 代管中 ${count} 条`;
        proxy.title = `PM 代管中 ${count} 条：Owner 的决定由 PM 代记；开/关代管在右下角【一键代管】`;
        proxy.setAttribute('data-proxy-count', String(count));
        // B-a1cf：把「什么时候算出来的」也挂上，排查“看着没更新”时能分辨是旧数据还是没刷新。
        proxy.setAttribute('data-proxy-at', new Date().toISOString());
        proxy.classList.remove('is-compact');
      } else {
        // 只清只读徽标；[data-owner-review-proxy-end] 现在挂在右下【一键代管】行上（不是可删节点）。
        const node = document.querySelector('[data-owner-review-proxy]');
        if (node) node.remove();
      }
      state.proxyCount = count;
      syncProxyAllButton();
      syncProxyNote();
    } catch (e) {
      // AC7：读取代管失败 → 行内「代管状态读取失败」+ 重试，绝不显示成未启用（也不静默）。
      state.proxyReadError = String((e && (e.message || e.code)) || e || '未知原因').slice(0, 160);
      state.proxyAllActive = false;
      state.proxyAllRecord = null;
      state.proxyAllExpiresAt = '';
      state.proxyCount = 0;
      syncProxyAllButton();
      syncProxyNote();
    }
  }

  // Owner 规则（2026-11-13）：弹窗只在“需求评审”与“验收”阶段出现（owner_review 兼容旧流程）。
  function dialogStageAllowed() {
    const stage = String((state.data && state.data.stage) || '');
    return ['requirement_review', 'owner_review', 'owner_accept'].includes(stage);
  }
  function suggestTextOf(row, pending) {
    // B-d1e5：一律走同一套「事实 + 具体动作」生成，不再输出「通过 / 打回」这类空话。
    return adviceTextOf(row, pending);
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
  // B-d1e5（P0）：建议拍板不许再是「建议拍板 / 通过 / 打回」这类空话。
  // 规则（Owner 2026-11-14）：①必须从这条需求的正文字段里提事实，给一句具体动作；
  // ②禁止纯兜底；③真没素材明说让分析师补正文；④≤60 字、大白话、不含代号；⑤逐条不同。
  function plainTextOf(value) {
    return String(value == null ? '' : value)
      .replace(/\b[RDTM]-\d{8,}-\w+\b/gi, '')
      .replace(/\bG\d+\b/gi, '')
      .replace(/\bAC\d+(?:\.\d+)?\b/gi, '')
      .replace(/\b(?:pm|programmer[12]|analyst|product|tester)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function adviceTextOf(row, pending) {
    const rawDetail = String((row && row.detail) || '');
    const rawEvidence = String((row && row.evidence) || '');
    const detail = plainTextOf(rawDetail);
    const acceptance = plainTextOf(row && (row.acceptance || row.acceptanceCriteria));
    const evidence = plainTextOf(rawEvidence);
    const status = String((row && row.status) || '');
    const title = clip60(plainTextOf(row && row.title), 12);
    const tag = title ? `「${title}」` : '';
    const one = (text, max = 14) => clip60(plainTextOf(text), max);

    // R-5550 F-5550-5：有 AC 结构但四段/选项缺 → 显式报缺（不再拼"无素材"兜底句）；
    // 旧正文（无 AC 结构）走后面的五要素降级，不在这里报缺（AC6）。
    const acInfo = row && row.__ac;
    if (ACP && acInfo && acInfo.structured && Array.isArray(acInfo.issues) && acInfo.issues.length) {
      const first = acInfo.issues[0];
      const more = acInfo.issues.length > 1 ? ` 等 ${acInfo.issues.length} 条` : '';
      return clip60(`${first.acId} 正文缺：${(first.missingFields || []).join('、')}${more}（请分析师补结构）`, 90);
    }

    // 0）已收口：直接说到底，不装还等着拍板（加上收口时间，别看起来一样）
    const shortWhen = (value) => {
      const t = String(value || '');
      const m = t.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
      return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : '';
    };
    if (status === 'accepted' || status === 'done') {
      const when = shortWhen((row && row.closedAt) || (row && row.acceptance && row.acceptance.at) || (row && row.updatedAt));
      return clip60(`${tag}${when ? when + ' ' : ''}已验收通过，不用再拍`);
    }
    if (status === 'terminated') {
      const when = shortWhen((row && row.closedAt) || (row && row.updatedAt));
      return clip60(`${tag}${when ? when + ' ' : ''}已终止，不用再拍`);
    }
    if (status === 'iteration') return clip60(`${tag}已转下一次，当前不用拍`);
    if (status === 'rejected') return clip60(`${tag}被打回过、还没返工，建议先让分析师改`);

    // 1）被打回过：把上次理由摆出来
    const decisions = Array.isArray(row && row.decisions) ? row.decisions : [];
    const lastReject = decisions.filter((d) => d && /rejected/.test(String(d.decision || d.action || ''))).pop();
    if (lastReject) {
      const why = one(lastReject.opinion || lastReject.comment || '', 14);
      return clip60(why ? `${tag}上次被打回：${why}，建议先确认改好了` : `${tag}上次被打回过，建议先确认这版改好了`);
    }

    // 2）可测性评审/需求评审没过
    const trq = (row && row.trq) || null;
    if (trq && String(trq.verdict || '') === 'not_testable') return clip60(`${tag}可测性评审判了不可测，建议打回补验收标准`);
    if (status === 'review' || status === 'requirement_review') return clip60(`${tag}还没过需求评审，建议先让产品过审再拍`);

    // 3）验收阶段：拿证据说话（缺什么说缺什么）
    if (status === 'test_done') {
      if (!evidence) return clip60(`${tag}没交测试证据，建议打回补报告和截图`);
      if (!/(报告|测试)/.test(evidence)) return clip60(`${tag}证据里只有零散材料、没有测试报告，建议补报告再验收`);
      if (!/\.(png|jpe?g|webp)/i.test(rawEvidence)) return clip60(`${tag}只有文字证据，建议补张截图再验收`);
      return clip60(`${tag}材料和截图都齐，建议验收通过`);
    }

    // 4）评审阶段：先看验收标准，再看正文取舍点，再看动到哪个模块
    if (!acceptance) return clip60(`${tag}没写验收标准，建议打回补 AC`);
    if (acceptance.length < 8) return clip60(`${tag}验收标准太笼统，建议打回写清怎么算过`);
    const point = detail.match(/(?:待确认|风险|取舍|建议)[：:]\s*([^；;。]{4,52})/);
    if (point) {
      const picked = one(point[1], 18);
      if (picked) return clip60(`${tag}正文有取舍没说清，建议你定：${picked}`);
    }
    const mod = detail.match(/([\u4e00-\u9fa5A-Za-z0-9_]{2,10})(?:模块|页面|接口|弹窗|面板|看板|表单)/);
    if (mod) return clip60(`${tag}动到${mod[1]}，建议先问程序员 A 影响面再拍`);
    // 5）材料里还有别的线索就拿来用，避免所有条目一句话
    const productComment = one((row && row.productReview && (row.productReview.comment || row.productReview.reason)) || '', 14);
    if (productComment) return clip60(`${tag}产品评审提了：${productComment}，建议先确认这点`);
    const rounds = Number((row && row.round) || 1);
    if (rounds > 1) return clip60(`${tag}已经到当前，建议先看这次改了什么再拍`);
    if (pending) return clip60(`${tag}验收标准已写清，建议通过、进开发`);
    if (/待确认/.test(detail)) return clip60(`${tag}正文还有待确认项，建议让分析师先收口`);
    return clip60(`${tag}正文没写方案要点，建议让分析师先补正文`);
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
      // B-77aa（Owner 2026-11-14 14:10）：已收口区太乱、眼痛 —— ①改「最新在前」；②默认折叠，只显「已收口 N 条」。
      if (group.key === 'closed') {
        const timeOf = (row) => Date.parse(String((row && row.closedAt) || (row && row.updatedAt) || '')) || 0;
        group.rows = group.rows.slice().sort((a, b) => timeOf(b) - timeOf(a));
        const collapsed = state.closedCollapsed !== false;
        groupBox.setAttribute('data-owner-closed-collapsed', collapsed ? '1' : '0');
        const titleBtn = el('button', 'or-all-group-title or-closed-toggle',
          `${group.label} · ${group.rows.length} 条${collapsed ? '（已折叠，点开看）' : ''}`);
        titleBtn.type = 'button';
        titleBtn.setAttribute('data-owner-closed-toggle', '1');
        titleBtn.addEventListener('click', () => {
          state.closedCollapsed = !collapsed;
          renderDialog();
        });
        groupBox.appendChild(titleBtn);
        if (!collapsed) for (const req of group.rows) groupBox.appendChild(renderAllRow(req));
        box.appendChild(groupBox);
        continue;
      }
      groupBox.appendChild(el('div', 'or-all-group-title', `${group.label} · ${group.rows.length} 条`));
      for (const req of group.rows) {
        groupBox.appendChild(renderAllRow(req));
      }
      box.appendChild(groupBox);
    }
    list.appendChild(box);
  }

  /**
   * R-5550 F-5550-3：AC 卡片（一条 AC 一张卡）。
   * - 四段全文展示（不 clip60），缺项显式写「（正文缺：<字段>）」并标 missing；
   * - 选项渲染成可点按钮，每项显示后果；不足 2 项显式标缺；
   * - 数据只来自正文（row.__ac 由 ac-parse.js 解析），程序不拼语义。
   */
  function acCardsEl(row) {
    const info = row && row.__ac;
    if (!ACP || !info || !info.structured || !Array.isArray(info.acs) || !info.acs.length) return null;
    const box = el('div', 'or-ac-list');
    box.setAttribute('data-ac-list', '1');
    const issuesOf = (acId) => (info.issues || []).find((item) => String(item.acId) === String(acId)) || null;
    const SEGS = [['功能是什么', 'what'], ['目的', 'purpose'], ['风险', 'risk'], ['风险处理', 'mitigation']];
    for (const ac of info.acs) {
      const issue = issuesOf(ac.id);
      const missing = new Set(issue ? issue.missingFields : []);
      const card = el('div', 'or-ac-card');
      card.setAttribute('data-ac-id', ac.id);
      card.setAttribute('data-ac-what', String(ac.what || ''));
      card.setAttribute('data-ac-purpose', String(ac.purpose || ''));
      card.setAttribute('data-ac-risk', String(ac.risk || ''));
      card.setAttribute('data-ac-mitigation', String(ac.mitigation || ''));
      card.setAttribute('data-ac-options', String((ac.options || []).length));
      if (missing.size) card.setAttribute('data-ac-missing', [...missing].join(','));
      card.appendChild(el('b', 'or-ac-head', `${ac.id}：${ac.title || '（未写标题）'}`));
      for (const [label, key] of SEGS) {
        const line = el('div', 'or-ac-seg' + (missing.has(label) ? ' missing' : ''));
        line.setAttribute('data-ac-field', key);
        line.appendChild(el('span', 'or-ac-k', label + '：'));
        const value = String(ac[key] || '').trim();
        line.appendChild(el('span', 'or-ac-v', value || `（正文缺：${label}）`));
        card.appendChild(line);
      }
      if (missing.has('拍板选项') || !Array.isArray(ac.options) || ac.options.length < 2) {
        const miss = el('div', 'or-ac-seg missing');
        miss.setAttribute('data-ac-field', 'options');
        miss.appendChild(el('span', 'or-ac-v', '（正文缺：拍板选项（至少 2 项、各带后果））'));
        card.appendChild(miss);
      } else {
        const opts = el('div', 'or-ac-options');
        opts.setAttribute('data-ac-options-box', '1');
        for (const option of ac.options) {
          const btn = el('button', 'or-ac-option');
          btn.type = 'button';
          btn.setAttribute('data-ac-option-key', String(option.key || ''));
          btn.innerHTML = `<b>${esc(option.key)}. ${esc(option.label)}</b>`
            + `<span>${esc(option.consequence || '（正文缺：后果）')}</span>`;
          btn.title = option.consequence ? `选「${option.label}」：${option.consequence}` : '正文没写这一项的后果';
          opts.appendChild(btn);
        }
        card.appendChild(opts);
      }
      box.appendChild(card);
    }
    return box;
  }

  function renderAllRow(req) {    const id = String(req.id || '');
    const pending = isPending(req);
    const proxyActive = isProxied(req);
    // R-5550 AC5 / F-5550-4：看板五要素与弹窗同源——同一条需求同一次解析（row.__ac），不再有第二套取数。
    const acBoard = (ACP && !(typeof window !== 'undefined' && window.__AWB_AC_BOARD_OFF)) ? ACP.boardFieldsOf(req) : null;
    const what = acBoard ? clip60(acBoard.what, 80) : clip60(humanizeTitle(req.title), 80);
    const blocked = acBoard ? clip60(acBoard.blocked, 120) : clip60(blockedTextOf(req, pending, proxyActive));
    // B-d1e5：这里以前是三段硬编码（通过/打回、验收通过/打回、先不动），Owner 看到的「清一色」就是它。
    // 现在统一走 adviceTextOf：按这条需求的状态、证据、验收标准、正文取舍点给一句具体动作。
    const advise = acBoard ? clip60(acBoard.advice, 220) : clip60(adviceTextOf(req, pending));
    const open = state.listOpen.has(id);
    const item = el('div', 'or-all-row');
    item.setAttribute('data-owner-all-item', '1');
    item.setAttribute('data-or-req', id);
    item.setAttribute('data-or-status', String(req.status || ''));
    item.setAttribute('data-or-bucket', listBucketOf(req));
    // B-d100：复审标记（打回后改完重新进队列的那条）。首次评审不带这个标记。
    const rework = reworkInfoOf(req);
    if (rework.isRework) item.setAttribute('data-or-rework', '1');
    item.setAttribute('data-or-expanded', open ? '1' : '0');
    // 三要素同时挂在行上（便于自检/读屏按行取），文案仍写在行内三行里。
    item.setAttribute('data-what', what);
    item.setAttribute('data-blocked', blocked);
    item.setAttribute('data-advice', advise);
    if (acBoard) {
      item.setAttribute('data-ac-id', acBoard.acId);
      item.setAttribute('data-how', clip60(acBoard.how, 200));
      item.setAttribute('data-impact', clip60(acBoard.impact, 120));
    }
    if (String(id) === state.selected) item.classList.add('selected');
    if (proxyActive) item.setAttribute('data-proxied', '1');
    const headRow = el('button', 'or-all-head');
    headRow.type = 'button';
    headRow.setAttribute('data-owner-all-toggle', '1');
    headRow.setAttribute('data-what', what);
    headRow.setAttribute('data-blocked', blocked);
    headRow.setAttribute('data-advice', advise);
    if (acBoard) {
      headRow.setAttribute('data-ac-id', acBoard.acId);
      headRow.setAttribute('data-how', clip60(acBoard.how, 200));
      headRow.setAttribute('data-impact', clip60(acBoard.impact, 120));
    }
    headRow.innerHTML = `<b>${esc(what)}</b>` + reworkChipHtml(req)
      + `<span class="or-all-k">这是什么</span><span class="or-all-v">${esc(what)}</span>`
      + `<span class="or-all-k">卡在哪</span><span class="or-all-v">${esc(blocked)}</span>`
      + `<span class="or-all-k">建议你拍什么</span><span class="or-all-v">${esc(advise)}</span>`
      + `<em>${esc(open ? '收起' : '展开')}</em>`;
    headRow.addEventListener('click', () => {
      if (state.listOpen.has(id)) state.listOpen.delete(id); else state.listOpen.add(id);
      selectRequirement(id);
    });
    item.appendChild(headRow);
    // B-3065 AC5：每条需求都带状态徽标 + ownerReview 来源（PM 代记 / 本人 / 来源未记）。
    const metaRow = el('div', 'or-all-meta');
    metaRow.setAttribute('data-or-meta', '1');
    metaRow.appendChild(statusBadgeEl(req));
    metaRow.appendChild(sourceBadgeEl(req));
    item.appendChild(metaRow);

    if (open) {
      const detail = el('div', 'or-all-detail');
      detail.setAttribute('data-owner-all-detail', '1');
      // R-5550 F-5550-3：有 AC 结构 → 逐条 AC 卡片（四段全文 + 选项后果 + 显式缺项）。
      const acBox = acCardsEl(req);
      if (acBox) detail.appendChild(acBox);
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
    MEMORY_MISSING: '缺这次的项目记忆：先写 1 条再完成。',
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
  // ── R-b28f F-b28f-4：权限说明弹窗（点【一键代管】唤起；取消零副作用）────────────────────
  // 「复制说明」要复制的整段话（含三项权限 / 两项风险 / DSH 完全权限指引），便于转给 PM。
  const PROXY_PERMISSION_TEXT = [
    '一键代管 = 把拍板权交给 PM（默认 8 小时，随时可结束）',
    '交出的三项权限：',
    '① 需求评审代记：PM 可代你在需求评审上记「通过 / 打回 / 跳过」，落账标【PM代管通过】等；',
    '② 验收代点：PM 可代你验收，但必须带测试报告与截图，缺证据会被拒（PM_ACCEPT_EVIDENCE_REQUIRED）；',
    '③ 决策箱代答：PM 可代你回执需要拍板的事。',
    '两项风险：',
    '① 默认 8 小时自动到期，随时可结束（到期不弹提醒，右下角那行会回到「一键代管」）；',
    '② 每笔代记都写审计（channel=proxy、recordedBy=pm），可在评审 / 验收列表回溯。',
    '还需你做一件事：在 DSH 输入框左下角把权限切到「完全权限」。工作台壳层改不了 DSH 的权限模式，只给指引；没切也能开代管，但 PM 执行 DSH 动作时可能卡在审批弹窗上。',
  ].join('\n');
  function proxyModalEl() { return document.querySelector('[data-proxy-modal]'); }
  function buildProxyModal() {
    const existing = proxyModalEl();
    if (existing) return existing;
    const mask = el('div', 'proxy-modal-mask');
    mask.setAttribute('data-proxy-modal', '1');
    mask.hidden = true;
    mask.innerHTML = [
      '<div class="proxy-modal-card" role="dialog" aria-modal="true" aria-labelledby="proxy-modal-title" tabindex="-1">',
      '  <header class="proxy-modal-head"><b id="proxy-modal-title" data-proxy-modal-title>一键代管 = 把拍板权交给 PM</b>',
      '    <button type="button" class="proxy-modal-close" data-proxy-modal-close aria-label="关闭">×</button></header>',
      '  <div class="proxy-modal-body" data-proxy-modal-body></div>',
      '  <footer class="proxy-modal-foot">',
      '    <button type="button" class="proxy-modal-copy" data-proxy-copy title="复制这段说明，便于转给 PM">复制说明</button>',
      '    <button type="button" data-proxy-modal-cancel>取消</button>',
      '    <button type="button" class="proxy-modal-confirm" data-proxy-confirm>确认开启代管</button>',
      '  </footer>',
      '</div>',
    ].join('');
    document.body.appendChild(mask);
    // F-b28f-4：Esc / 点遮罩 /「取消」/× 都等于取消——不写任何代管记录、不发成功提示（AC2 零副作用）。
    mask.addEventListener('click', (event) => { if (event.target === mask) closeProxyModal(); });
    mask.querySelector('[data-proxy-modal-close]').addEventListener('click', () => closeProxyModal());
    mask.querySelector('[data-proxy-modal-cancel]').addEventListener('click', () => closeProxyModal());
    mask.querySelector('[data-proxy-confirm]').addEventListener('click', () => {
      if (mask.getAttribute('data-mode') === 'end') confirmProxyEnd();
      else confirmProxyStart();
    });
    mask.querySelector('[data-proxy-copy]').addEventListener('click', copyProxyPermissionText);
    mask.addEventListener('keydown', proxyModalKeydown);
    return mask;
  }
  /** F-b28f-4：焦点陷阱（Tab / Shift+Tab 只在弹窗内循环，Esc 关闭）。 */
  function proxyModalKeydown(event) {
    const mask = proxyModalEl();
    if (!mask || mask.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); closeProxyModal(); return; }
    if (event.key !== 'Tab') return;
    const card = mask.querySelector('.proxy-modal-card');
    if (!card) return;
    const focusables = Array.from(card.querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])'))
      .filter((node) => !node.disabled && node.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!card.contains(document.activeElement)) { event.preventDefault(); first.focus(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  function copyProxyPermissionText() {
    const text = PROXY_PERMISSION_TEXT;
    // 弹窗开着时浮动区横幅在遮罩下面（#side-float 自身是叠层），所以复制结果直接回写在按钮上。
    const btn = document.querySelector('[data-proxy-copy]');
    const done = (ok) => {
      if (btn) {
        btn.textContent = ok ? '已复制' : '复制失败';
        setTimeout(() => { if (btn) btn.textContent = '复制说明'; }, 1800);
      }
      if (!ok) showProxyBanner('复制失败：剪贴板不可用，请手动选中文字复制', 'bad');
    };
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text).then(() => done(true)).catch(() => done(false));
        return;
      }
    } catch { /* 落到下面的兜底 */ }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      done(ok);
    } catch { done(false); }
  }
  /** 评审弹窗若还开着，别把 webview 提前放出来（遮罩会盖不住的合成层问题）。 */
  function restoreWebviewAfterOverlay() {
    const dialog = dialogEl();
    if (dialog && !dialog.hidden) return;
    document.body.classList.remove('or-webview-hidden');
  }
  function openProxyModal(mode) {
    const mask = buildProxyModal();
    const card = mask.querySelector('.proxy-modal-card');
    const titleEl = mask.querySelector('[data-proxy-modal-title]');
    const bodyEl = mask.querySelector('[data-proxy-modal-body]');
    const copyBtn = mask.querySelector('[data-proxy-copy]');
    const cancelBtn = mask.querySelector('[data-proxy-modal-cancel]');
    const confirmBtn = mask.querySelector('[data-proxy-confirm]');
    mask.setAttribute('data-mode', mode);
    if (card) card.setAttribute('data-mode', mode);
    confirmBtn.disabled = false;
    if (mode === 'end') {
      titleEl.textContent = '结束代管？';
      bodyEl.innerHTML = [
        '<p>结束后 PM 立刻不能再代你评审、验收或回执；已经落账的记录不回溯（审计里仍是 <code>channel=proxy</code>、<code>recordedBy=pm</code>）。</p>',
        '<p>下次要托管，再点一次【一键代管】即可，走同一个权限说明弹窗。</p>',
      ].join('');
      copyBtn.hidden = true;
      confirmBtn.textContent = '确认结束代管';
      confirmBtn.classList.add('is-danger');
      confirmBtn.setAttribute('data-proxy-end-confirm', '1');
      confirmBtn.removeAttribute('data-proxy-start-confirm');
    } else {
      titleEl.textContent = '一键代管 = 把拍板权交给 PM';
      bodyEl.innerHTML = [
        '<h4>交出的三项权限</h4>',
        '<ul>',
        '  <li><b>需求评审代记</b>：PM 可代你在需求评审上记「通过 / 打回 / 跳过」，落账标【PM代管通过】等。</li>',
        '  <li><b>验收代点</b>：PM 可代你验收，但必须带测试报告与截图，缺证据会被拒（<code>PM_ACCEPT_EVIDENCE_REQUIRED</code>）。</li>',
        '  <li><b>决策箱代答</b>：PM 可代你回执需要拍板的事。</li>',
        '</ul>',
        '<h4>两项风险</h4>',
        '<ul>',
        '  <li>默认 <b>8 小时</b>自动到期，随时可结束；到期不弹提醒，右下角这行会回到「一键代管」。</li>',
        '  <li>每笔代记都写审计（<code>channel=proxy</code>、<code>recordedBy=pm</code>），可在评审 / 验收列表回溯。</li>',
        '</ul>',
        '<div class="proxy-modal-hint"><b>还需你做一件事</b>：在 DSH 输入框左下角把权限切到「完全权限」。工作台壳层改不了 DSH 的权限模式，只给指引；<b>没切也能开代管</b>，但 PM 执行 DSH 动作时可能卡在审批弹窗上。</div>',
      ].join('');
      copyBtn.hidden = false;
      copyBtn.textContent = '复制说明';
      confirmBtn.textContent = '确认开启代管';
      confirmBtn.classList.remove('is-danger');
      confirmBtn.setAttribute('data-proxy-start-confirm', '1');
      confirmBtn.removeAttribute('data-proxy-end-confirm');
    }
    mask.hidden = false;
    hideProxyBanner();
    document.body.classList.add('or-webview-hidden');
    // 默认焦点在「取消」：误按 Enter 不能把拍板权交出去。
    try { cancelBtn.focus(); } catch { /* ignore */ }
    syncProxyAllButton();
  }
  function closeProxyModal() {
    const mask = proxyModalEl();
    if (!mask || mask.hidden) return;
    mask.hidden = true;
    restoreWebviewAfterOverlay();
    syncProxyAllButton();
    try { proxyRowEl()?.focus(); } catch { /* ignore */ }
  }
  /** 点行：missing 无副作用；error=重试；active=结束二次确认；idle=权限说明。 */
  function proxyRowClick() {
    const rowState = proxyRowState();
    if (rowState === 'missing') return;
    if (rowState === 'error') { retryProxyRead(); return; }
    if (rowState === 'active') { openProxyModal('end'); return; }
    openProxyModal('start');
  }
  async function retryProxyRead() {
    showProxyBanner('正在重读代管状态…', 'ok');
    await loadData();
    syncProxyAllButton();
    if (state.proxyReadError) showProxyBanner(`代管状态还是读不出来：${state.proxyReadError}`, 'bad');
    else hideProxyBanner();
  }
  async function confirmProxyStart() {
    const mask = proxyModalEl();
    const btn = mask ? mask.querySelector('[data-proxy-confirm]') : null;
    if (!btn || btn.disabled) return;
    // F-b28f-边界「并发」：点下立即禁用，防双击开出两条记录。
    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = '开启中…';
    try {
      const result = await startProxyAll();
      // 不论成功/失败都关弹窗：行态由 ownerProxyStatus 真源决定（失败=回 idle + 横幅带错误码）。
      closeProxyModal();
      return result;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldText; }
    }
  }
  async function confirmProxyEnd() {
    const mask = proxyModalEl();
    const btn = mask ? mask.querySelector('[data-proxy-confirm]') : null;
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = '结束中…';
    try {
      const result = await endProxy();
      closeProxyModal();
      if (result && result.ok) showProxyBanner('已结束代管：PM 立刻不能再代你评审 / 验收 / 回执', 'ok');
      return result;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldText; }
    }
  }
  function bindProxyRow() {
    const row = proxyRowEl();
    if (row && row.dataset.bound !== '1') {
      row.dataset.bound = '1';
      row.addEventListener('click', proxyRowClick);
    }
    syncProxyAllButton();
    syncProxyNote();
  }
  /** F-b28f-6：评审弹窗里那一行只读说明（弹窗不再有开/关按钮）。 */
  function syncProxyNote() {
    const note = document.querySelector('[data-or-proxy-note]');
    if (!note) return;
    const covered = Math.max(0, Number(state.proxyCount || 0));
    if (state.proxyAllActive) {
      note.textContent = `PM 代管中 ${covered} 条 · 开/关代管在右下角【一键代管】`;
      note.setAttribute('data-proxy-active', '1');
    } else {
      note.textContent = '开/关代管在右下角【一键代管】';
      note.setAttribute('data-proxy-active', '0');
    }
  }

  async function startProxyAll() {
    // 7849 AC1：一键入口写 scope=all（一条全项目记录，带 expiresAt，覆盖全部非终态需求）。
    // 已生效时再点：幂等——不新建、只更新 updatedAt，后端返回 idempotent=true。
    // B-11ce 更正（PM 2026-11-15 02:35）：根因不是无状态行，而是**弹窗打开时的旧快照**——
    // Owner 连续验收 10+ 条后，state.data 仍是几秒前的，按旧快照算就虚高（25 vs 13）。
    // 所以点代管前**强制重读**一次（loadData），条数与 authorization 都用**即时值**（F-b28f-5 沿用）。
    if (!window.workbench || typeof window.workbench.ownerProxyStart !== 'function') {
      // AC7：没有接口时绝不假装开成功（行本身也会置灰）。
      showProxyBanner('当前版本没有代管接口，不能开启代管（没有写任何记录）', 'bad', '（错误码 PROXY_API_MISSING）');
      return { ok: false, code: 'PROXY_API_MISSING' };
    }
    await loadData();
    const rows = (state.data && Array.isArray(state.data.requirements)) ? state.data.requirements : [];
    const covered = OR_STATE ? OR_STATE.proxyCoveredRows(rows)
      : rows.filter((row) => row && ![ 'accepted', 'terminated', 'rejected' ].includes(String(row.status || '')) && String(row.status || ''));
    if (!covered.length) {
      // 边界「空值」：确认后再判，不静默、也不写半条记录。
      showProxyBanner('当前没有非终态需求，不需要开代管（没有写任何记录）', 'bad');
      return { ok: false, skipped: true };
    }
    const expiresAt = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
    try {
      const r = await window.workbench.ownerProxyStart({
        projectId: state.projectId,
        scope: 'all',
        expiresAt,
        actor: 'owner',
        authorization: `Owner 在右下角【一键代管】确认开启（scope=all，覆盖 ${covered.length} 条非终态需求[${new Date().toLocaleTimeString('zh-CN', { hour12: false })} 即时快照]，到期 ${expiresAt}；含评审 + 决策箱 + 验收）`,
      });
      if (!r || r.ok === false) throw new Error((r && (r.message || r.code)) || '开代管失败');
      hideBanner();
      // B-5f62 / 7849：幂等返回 idempotent=true，提示要说清「本来就生效中」而不是又开了一次。
      if (r.idempotent) showProxyBanner('全部代管已在生效中（幂等：未新建记录，只刷新了更新时间）', 'ok');
      else showProxyBanner(`已开启一键代管：覆盖 ${covered.length} 条非终态需求（到期 ${String((r.active && r.active.expiresAt) || expiresAt).slice(0, 19).replace('T', ' ')}）`, 'ok');
      await updateProxyBadge();
      updateBadge();
      renderDialog();
      return { ok: true, idempotent: Boolean(r.idempotent) };
    } catch (e) {
      // 边界「异常」：弹窗关闭、行回 idle、人话横幅 + 错误码；后端零半条记录（不本地假装成功）。
      const info = humanizeError(e);
      state.proxyAllActive = false;
      state.proxyAllRecord = null;
      state.proxyAllExpiresAt = '';
      syncProxyAllButton();
      showProxyBanner(`开代管失败：${info.title}`, 'bad', info.code ? `（错误码 ${info.code}）` : '');
      return { ok: false, code: info.code, message: info.title };
    }
  }

  function openDialog() {
    const dialog = dialogEl();
    if (!dialog || !dialog.hidden) return;
    dialog.hidden = false;
    // B-77aa 补修（PM 2026-11-14 15:04）：「已收口」区每次打开都要回到折叠态，
    // 否则上次展开过就一直展开（复验实测 collapsed=0 / 47 行）。重置只在这一处写。
    state.closedCollapsed = true;
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
    // R-b28f：一键代管弹窗还开着时不要把 webview 放出来（独立合成层会盖住遮罩）。
    const proxyMask = proxyModalEl();
    if (!proxyMask || proxyMask.hidden) document.body.classList.remove('or-webview-hidden');
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
  /** B-1358：四项前置判定（数据来自 owner:review-data 一次快照：requirements + tasks）。 */
  function prereqOfRow(row) {
    if (!AP) return null;
    const tasks = (state.data && Array.isArray(state.data.tasks)) ? state.data.tasks : [];
    return AP.acceptPrereq(row, tasks);
  }
  /**
   * B-9b05（AC1/AC2/AC5）：按档位取验收前置——owner 档（ui/tty，Owner 本人）= 测试任务 + Owner 决定；
   * proxy 档（PM 代验收）= 再加报告 + 截图。两档都由 accept-prereq.js 的同一个 acceptGate 算，
   * 界面不自己判、原因串取 AP.EVIDENCE_INCOMPLETE_LABEL（与主进程 owner:accept 同一个常量）。
   */
  function gateOfRow(row, channel) {
    if (!AP || typeof AP.acceptGate !== 'function') return null;
    const tasks = (state.data && Array.isArray(state.data.tasks)) ? state.data.tasks : [];
    return AP.acceptGate(row, tasks, { channel: channel || 'ui' });
  }
  /** 证据缺项的统一原因串（AC5）：取 accept-prereq.js 那一个常量拼出来的串，这里不写死文案。 */
  function evidenceIncompleteTextOf(gate) {
    if (!AP) return '';
    if (gate && typeof gate.reasonText === 'string') return gate.reasonText;
    if (typeof AP.evidenceIncompleteText === 'function') return AP.evidenceIncompleteText(gate && gate.evidenceMissing);
    return '';
  }
  /** B-1358：缺失项的去处按钮（测试报告/截图 → 打开材料；测试任务 → 流程图；Owner 决定 → 评审弹窗）。 */
  function acceptGoto(item, row) {
    const key = String((item && item.go) || '');
    if (key === 'test_report' || key === 'shot') {
      if (item && item.path && typeof openMaterial === 'function') { openMaterial(String(item.path)); return; }
      showNotice(`该需求还没挂${key === 'shot' ? '截图' : '测试报告'}：请让测试人员在测试任务证据里补上，再点「刷新列表」`);
      return;
    }
    if (key === 'test_task') {
      closeAcceptList();
      if (typeof setFlowPanel === 'function') setFlowPanel(true);
      return;
    }
    // Owner 决定：直接进评审弹窗并选中该需求（B-d100 的复审标记同一条链路）。
    closeAcceptList();
    const dialog = dialogEl();
    if (dialog && dialog.hidden) openDialog(false);
    state.selected = String(row.id || '');
    renderDialog();
  }
  /** 把「缺项 + 去处」挂到错误行下面；同一去处已存在就不重复加。 */
  function appendMissingLinks(errEl, row) {
    const prereq = prereqOfRow(row);
    if (!errEl || !prereq || prereq.canAccept) return;
    const box = el('span', 'accept-missing-list');
    box.setAttribute('data-accept-missing-list', '1');
    const added = new Set();
    for (const item of prereq.missing) {
      const go = String(item.go || '');
      if (!go || added.has(go)) continue;
      if (errEl.querySelector(`[data-accept-goto="${go}"]`)) { added.add(go); continue; }
      added.add(go);
      const btn = el('button', 'accept-btn link', '去' + item.label);
      btn.type = 'button';
      btn.setAttribute('data-accept-goto', go);
      btn.title = item.reason;
      btn.addEventListener('click', () => acceptGoto(item, row));
      box.appendChild(btn);
    }
    if (added.size) {
      errEl.appendChild(document.createTextNode(' '));
      errEl.appendChild(box);
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
      // B-1358：四项前置状态（测试任务 / 测试报告 / 截图 / Owner 决定）——四项都展示；
      // B-9b05：只有 owner 档两项（测试任务/Owner 决定）才拦【通过】，证据只展示不拦截。
      const prereq = prereqOfRow(row);
      const gate = gateOfRow(row, 'ui');
      if (prereq) {
        const pre = el('span', 'accept-line accept-prereq');
        pre.setAttribute('data-accept-prereq', '1');
        pre.setAttribute('data-accept-can', gate && gate.canAccept ? '1' : '0');
        if (gate) pre.setAttribute('data-accept-proxy-can', gate.canProxy ? '1' : '0');
        for (const check of prereq.checks) {
          const chip = el('span', `accept-pre ${check.ok ? 'ok' : 'bad'}`, `${check.label}${check.ok ? '✓' : '✗'}`);
          chip.setAttribute('data-accept-pre', check.key);
          chip.setAttribute('data-accept-pre-ok', check.ok ? '1' : '0');
          // AC1：证据两项在 owner 档只是提示，不参与拦截——芯片上标明档位归属。
          const gateKey = gate && Array.isArray(gate.requiredKeys) ? gate.requiredKeys.includes(check.key) : true;
          chip.setAttribute('data-accept-pre-gate', gateKey ? 'block' : 'show');
          chip.title = check.reason;
          pre.appendChild(chip);
        }
        info.appendChild(pre);
        // AC5：证据不全只出一条统一原因串（与后端门同一个常量），不写成拦截文案。
        const evidenceText = evidenceIncompleteTextOf(gate);
        if (gate && evidenceText) {
          const tip = el('span', 'accept-line accept-pre-evidence', evidenceText);
          tip.setAttribute('data-accept-evidence-missing', gate.evidenceMissingKeys.join(','));
          info.appendChild(tip);
        }
        // owner 档缺项（测试任务/Owner 决定）才是真拦截；拦截文案不再用旧的四字短语，改为说清缺哪项。
        if (gate && !gate.canAccept) {
          const why = el('span', 'accept-line accept-pre-why', '还不能验收：' + gate.missing.map((item) => item.label).join('、') + ' 没齐（鼠标停在 ✗ 上看原因）');
          why.setAttribute('data-accept-pre-why', '1');
          info.appendChild(why);
        }
      }
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
      if (gate) {
        // AC3：缺证据时【通过】必须可点（Owner 本人验收不强制截图）；只有测试任务/Owner 决定没齐才置灰。
        ownerBtn.setAttribute('data-accept-gate', gate.canAccept ? 'open' : 'blocked');
        if (gate.evidenceMissingKeys.length) {
          ownerBtn.setAttribute('data-accept-evidence-missing', gate.evidenceMissingKeys.join(','));
          ownerBtn.title = gate.reasonText + '（仍可直接验收，点开确认框会列出缺项）';
        }
        if (!gate.canAccept) {
          ownerBtn.disabled = true;
          ownerBtn.setAttribute('data-accept-blocked', gate.missing.map((item) => item.key).join(','));
          ownerBtn.title = '还不能验收：' + gate.missing.map((item) => `${item.label}（${item.reason}）`).join('；');
        }
      }
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
      const proxyGate = gateOfRow(row, 'proxy');
      if (!isProxied(row)) {
        pmBtn.disabled = true;
        pmBtn.title = '该需求没有进行中的代管记录：请 Owner 先开代管，或由 Owner 本人验收';
        pmBtn.setAttribute('data-accept-proxy-blocked', 'no-proxy');
      } else if (proxyGate && !proxyGate.canProxy) {
        // AC2/AC4：代验收仍是两件套——缺证据时禁用并给原因（与后端 PM_ACCEPT_EVIDENCE_REQUIRED 同源）。
        pmBtn.disabled = true;
        pmBtn.setAttribute('data-accept-proxy-blocked', proxyGate.missing.map((item) => item.key).join(','));
        pmBtn.setAttribute('data-accept-proxy-code', proxyGate.code || '');
        pmBtn.title = '代验收需要报告 + 截图：' + proxyGate.proxyBlockedReason;
      } else {
        pmBtn.setAttribute('data-accept-proxy-blocked', '');
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
    // AC3：确认弹窗里把缺项列清楚（人话），但**不拦提交**——Owner 本人验收不强制截图；
    // 缺项说明与后端门同源（accept-prereq.js 的 acceptGate + EVIDENCE_INCOMPLETE_LABEL）。
    const dialogGate = gateOfRow(row, 'ui');
    const dialogEvidenceText = evidenceIncompleteTextOf(dialogGate);
    if (dialogGate && dialogEvidenceText) {
      const box = el('div', 'accept-dialog-missing');
      box.setAttribute('data-accept-dialog-missing', dialogGate.evidenceMissingKeys.join(','));
      box.appendChild(el('b', '', dialogEvidenceText));
      for (const miss of dialogGate.evidenceMissing) {
        const line = el('div', 'accept-dialog-missing-row');
        line.setAttribute('data-accept-dialog-pre', miss.key);
        line.textContent = `${miss.label}：${miss.reason}`;
        box.appendChild(line);
      }
      box.appendChild(el('span', 'accept-dialog-missing-note', '仍可直接验收；只有 PM 代验收才必须补齐这两件。'));
      form.appendChild(box);
    }
    form.appendChild(el('p', 'accept-warn', rejecting
      ? '打回后该需求回到可整改（不再出池），PM 会收到打回原因。'
      : '验收后该需求出池并归档（已闭环），不会再有“迭代/下一次”。'));
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
    // B-53ff：以前点「确认验收」到 IPC 返回之间界面完全没变化（一次 1.5–3 秒），Owner 体感是"点了没反应"。
    // 现在：立刻进入忙碌态（按钮文案 + 进度行 + 计时）、成功后立刻把该行从列表移除，失败才恢复。
    const busy = el('p', 'accept-busy');
    busy.setAttribute('data-accept-busy', '1');
    busy.hidden = true;
    form.appendChild(busy);
    let busyTimer = null;
    const startBusy = () => {
      const startedAt = Date.now();
      busy.hidden = false;
      busy.textContent = (rejecting ? '正在提交打回…' : '正在验收…') + ' 0 秒';
      if (busyTimer) clearInterval(busyTimer);
      busyTimer = setInterval(() => {
        busy.textContent = (rejecting ? '正在提交打回…' : '正在验收…') + ' ' + Math.round((Date.now() - startedAt) / 1000) + ' 秒';
      }, 400);
    };
    const stopBusy = () => {
      if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }
      busy.hidden = true;
    };
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      ok.textContent = rejecting ? '正在打回…' : '正在验收…';
      err.hidden = true;
      startBusy();
      showNotice(rejecting ? `正在打回 ${row.id}…` : `正在验收 ${row.id}…`);
      const opinion = String(op.value || '').trim();
      // R-c431：打回必须填原因——前端先拦一次，后端 OWNER_OPINION_REQUIRED 再兜一次。
      if (rejecting && !opinion) {
        err.hidden = false;
        err.setAttribute('data-error-code', 'OWNER_OPINION_REQUIRED');
        err.textContent = '打回必须写原因（至少 1 个字），否则不知道要改什么。';
        ok.disabled = false;
        ok.textContent = '确认打回';
        stopBusy();
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
        stopBusy();
        // B-53ff：成功后立刻把该行从列表移除（不等下一次 5 秒轮询），
        // 否则 Owner 看到"行还在"，会以为没生效并反复点。
        const goneRow = document.querySelector(`#accept-list .accept-row[data-req-id="${String(row.id).replace(/["\\]/g, '\\$&')}"]`);
        if (goneRow) goneRow.remove();
        renderMissing([]);
        await loadData();
        renderAcceptList();
        showNotice(rejecting
          ? `已打回：${row.id}；需求回到可整改，PM 会收到打回原因`
          : `已验收：${row.id}；流程图 ≤6 秒内更新`);
      } catch (e) {
        stopBusy();
        ok.disabled = false;
        ok.textContent = rejecting ? '确认打回' : '确认验收';
        err.hidden = false;
        const code = String((e && e.code) || '');
        // 错误码落在 DOM 上：自检/复跑可以直接断言是"列表过期"还是"真没到 test_done"。
        err.setAttribute('data-error-code', code);
        // B-53ff：被「上次评审打回」的旧状态挡住时，不只给一句报错——说清怎么办并给直达入口。
        const staleRejected = code === 'REQUIREMENT_STATE_INVALID' && /Owner 决定是 rejected/.test(String((e && e.message) || ''));
        if (staleRejected) {
          err.textContent = `这条上次被评审打回（${row.id}），旧打回状态还没被复审清掉，所以不能验收。`
            + '先点右边「去复审」重新评估通过（或在评审弹窗通过一次），再回来验收即可。';
          err.setAttribute('data-accept-blocked-by', 'stale-owner-reject');
          if (!err.querySelector('[data-action="accept-goto-review"]')) {
            const goto = el('button', 'accept-btn link', '去复审');
            goto.type = 'button';
            goto.setAttribute('data-action', 'accept-goto-review');
            goto.addEventListener('click', () => {
              closeAcceptList();
              const dialog = dialogEl();
              if (dialog && dialog.hidden) openDialog(false);
              state.selected = String(row.id);
              renderDialog();
            });
            err.appendChild(document.createTextNode(' '));
            err.appendChild(goto);
          }
        } else if (code === 'WORKFLOW_STATE_CHANGED') {
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
          // B-1358：错误横幅把「还缺哪几项」和「去哪里补」一起给出来，不只说失败。
          appendMissingLinks(err, row);
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
    // R-5550：AC 结构分析（只解析正文 AC 块；旧正文 structured=false，按旧五要素降级）。
    if (ACP) for (const row of allRows) row.__ac = ACP.analyzeRequirement(row);
    // R-5550 F-5550-7：缺项统计落在弹窗根节点（JSON：total + items[{requirementId,acId,missingFields}]）。
    const acStats = ACP ? ACP.missingStats(allRows) : { total: 0, items: [] };
    dialog.setAttribute('data-ac-missing-stats', JSON.stringify(acStats));
    // T-a3e1：看板只列当前轮需求；待评估清单仍看全部（跨轮未决的也要能被点）。
    const round = currentRoundOf(allRows);
    const rows = allRows.filter((row) => (Number(row && row.round) || 1) === round);
    rows.sort((a, b) => (isPending(b) ? 1 : 0) - (isPending(a) ? 1 : 0));
    const list = dialog.querySelector('[data-or-list]');
    list.innerHTML = '';
    // R-5550 F-5550-6：旧正文只提示一次（全列表一条汇总），绝不逐条报「未按结构写」。
    if (ACP && allRows.some((row) => !(row.__ac && row.__ac.structured))) {
      const hint = el('p', 'or-ac-hint', '部分需求正文未按 AC 结构写，建议补结构后重评');
      hint.setAttribute('data-ac-structure-hint', '1');
      list.appendChild(hint);
    }
    if (!rows.length) list.appendChild(el('p', 'or-empty', '当前暂时没有等你决定的事'));
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
    board.appendChild(el('h4', 'or-board-title', `当前需求 · 是什么 / 怎么做 / 建议拍板点 / 卡在哪 / 影响谁`));
    const boardInner = el('div', 'or-board-items');
    rows.forEach((req, index) => {
      const pending = isPending(req);
      const proxyActive = isProxied(req);
      // R-5550 AC5：看板与弹窗同一解析结果（row.__ac 在 loadData/renderDialog 里统一算），不再另取一套。
      const acBoard = (ACP && !(typeof window !== 'undefined' && window.__AWB_AC_BOARD_OFF)) ? ACP.boardFieldsOf(req) : null;
      const what = acBoard ? clip60(acBoard.what) : clip60(humanizeTitle(req.title));
      const how = acBoard ? clip60(acBoard.how) : clip60(howTextOf(req));
      const advice = acBoard ? clip60(acBoard.advice) : clip60(adviceTextOf(req, pending));
      const blocked = acBoard ? clip60(acBoard.blocked) : clip60(blockedTextOf(req, pending, proxyActive));
      const impact = acBoard ? clip60(acBoard.impact) : clip60(impactTextOf(req));
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
      const basis = isProxyTag(proxyTag)
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
      if (reworkInfoOf(req).isRework) item.setAttribute('data-or-rework', '1');
      if (String(req.id) === state.selected) item.classList.add('selected');
      item.innerHTML = `<b>${esc(triple.what)}</b>` + reworkChipHtml(req)
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
    // 7849 AC3-补：决策箱分区（仅「全部代管」有效期内出现；结束/过期即消失）。
    const decSection = decisionBoxSection();
    if (decSection) list.appendChild(decSection);
    // 7849 AC1：每次重渲染都同步按钮态（否则开/结束代管后按钮文案会停在旧状态）。
    syncProxyAllButton();
    const req = rows.find((row) => String(row.id) === state.selected) || null;
    dialog.querySelector('[data-or-title]').textContent = req ? humanizeTitle(`${req.title || ''}（${req.id || ''}）`) : '暂时没有等你决定的事';
    // B-2ed9 + B-3065 AC2：已决定 / 已离开 Owner 门的行，三个按钮全部 disabled 并写明原因
    // （以前只禁“同状态”那一个，ready+approved 的行还能点打回，点了只撞 DUPLICATE_DECISION → 像没反应）。
    const actionLock = req ? ownerActionLockOf(req) : null;
    const decidedInfo = req && OR_STATE && typeof OR_STATE.decisionOf === 'function' ? OR_STATE.decisionOf(req) : null;
    const decidedRow = decidedInfo ? decidedInfo.latest : (req ? latestOwnerDecision(req) : null);
    const decidedStatus = decidedInfo
      ? decidedInfo.status
      : String((decidedRow && (decidedRow.status || decidedRow.decision))
        || (req && req.ownerReview && req.ownerReview.status) || '');
    for (const [selector, targetStatus, verb] of [
      ['[data-or-approve]', 'approved', '通过'],
      ['[data-or-reject]', 'rejected', '打回'],
      ['[data-or-skip-submit]', 'skipped', '跳过'],
    ]) {
      const btn = dialog.querySelector(selector);
      if (!btn) continue;
      const sameDone = Boolean(req && decidedRow && decidedStatus === targetStatus);
      const disabled = Boolean(actionLock) || sameDone;
      btn.disabled = disabled;
      btn.setAttribute('data-or-decided', disabled ? '1' : '0');
      btn.setAttribute('data-or-lock-code', actionLock ? actionLock.code : '');
      btn.title = actionLock
        ? `已决定：${actionLock.text}；这条不再重复落账`
        : (sameDone ? `已决定：${STATUS_TEXT[targetStatus] || targetStatus}；同一决定不重复落账` : `提交${verb}`);
    }
    const lockReason = dialog.querySelector('[data-or-lock-reason]');
    if (lockReason) {
      lockReason.hidden = !actionLock;
      lockReason.removeAttribute('data-or-lock-code');
      if (actionLock) {
        lockReason.setAttribute('data-or-lock-code', actionLock.code);
        lockReason.textContent = `这条已经决定了：${actionLock.text}；按钮已禁用，失败/重复的提交不会改账。`;
      } else {
        lockReason.textContent = '';
      }
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

  /**
   * R-f9b1（F-7③ / AC10③ / AC12）：材料组里的增补卷。
   * 唯一取数：主进程 ownerMaterials 给组上的 `supplements[]`（kind='supplement' 的条目也在 items 里），
   * 归一化统一走 POOL_CORE.supplementsOf —— 这里不另写一套解析。
   */
  function materialsSupplements(group) {
    if (!group) return [];
    const pool = typeof window !== 'undefined' ? window.POOL_CORE : null;
    if (!pool || typeof pool.supplementsOf !== 'function') return [];
    const declared = Array.isArray(group.supplements) ? group.supplements : [];
    const source = declared.length ? declared : (Array.isArray(group.items) ? group.items : []);
    return pool.supplementsOf({ supplements: source, requirementId: group.requirementId });
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
        // 卷条目与正文条目分开渲染：正文仍按"最多 3 项"收敛，卷必须全数列出（否则被切片吃掉）。
        const docs = items.filter((item) => String((item && item.kind) || '') !== 'supplement');
        const supplements = materialsSupplements(g);
        if (!docs.length && !supplements.length) { group.appendChild(el('span', 'or-muted', `${label}：未记录`)); continue; }
        for (const item of docs.slice(0, 3)) {
          const rel = String(item.rel || (item.versions && item.versions[0] && item.versions[0].rel) || '');
          if (rel) group.appendChild(materialLink(`${label} · ${item.name || rel}`, rel));
        }
        // 增补卷：同一张「需求正文」卡内追加（不另立类目），点开只读看内容。
        for (const s of supplements) {
          const sizeText = (s.bytes === null || s.bytes === undefined) ? '字节未记录' : `${s.bytes} B`;
          const link = materialLink(`${label} · ${s.name}（${sizeText} · sha ${s.sha12 || '—'}）`, s.rel);
          link.classList.add('or-supplement-link');
          link.setAttribute('data-supplement', '1');
          link.setAttribute('data-supplement-open', s.rel);
          link.setAttribute('data-supplement-name', s.name);
          link.setAttribute('data-supplement-bytes', (s.bytes === null || s.bytes === undefined) ? '' : String(s.bytes));
          link.setAttribute('data-supplement-sha', s.sha256 || '');
          link.setAttribute('data-supplement-req', s.requirementId || String((req && req.id) || ''));
          if (s.missing) link.setAttribute('data-supplement-missing', '1');
          group.appendChild(link);
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
    // B-3065 AC5：右侧详情同口径显示状态徽标 + ownerReview 来源。
    const statusRow = el('div', 'or-summary-row or-status-row');
    statusRow.setAttribute('data-or-summary-status', '1');
    statusRow.appendChild(el('b', '', '状态'));
    const statusText = el('span', '', `${statusBadgeOf(req).text} · ${ownerReviewSourceOf(req)}`);
    statusText.setAttribute('data-or-summary-status-text', '1');
    statusRow.appendChild(statusText);
    box.appendChild(statusRow);
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
      if (r && r.ok === false) {
        // 卷被删/改名/超限时明说原因，不静默显示成"未记录"。
        pre.textContent = `读不到这份材料（${r.code || 'MATERIAL_READ_FAILED'}）：${rel}\n${r.message || ''}\n\n`
          + '增补卷被删除或改名时会这样；其余材料照常可读，请让 PM/分析师补卷。';
        return;
      }
      pre.textContent = String((r && (r.text || r.content || r.body)) || '未记录或不可读');
    } catch { pre.textContent = '未记录或不可读'; }
  }

  // ── B-3065 批量评审：A 本次待审需求 / B 需要你提建议的点 ────────────────
  // AC1 唯一口径：只收「ownerReview=pending|rejected 且需求行 status=owner_review」。
  // 旧实现 full 收 status=ready，把 4657/9a8e 两条已 approved（PM 代记/本人）的需求当成待审，
  // 点通过/打回只会撞 DUPLICATE_DECISION；界面又没有失败反馈，Owner 看到的就是“点了没反应”。
  // 落账只写行级 decisions[]（走 owner:decide 的 applyOwnerDecisionToRequirement），打回另发 type=review_reject 给作者。
  function batchMode() {
    return String((state.data && state.data.teamMode) || 'full') === 'fast' ? 'fast' : 'full';
  }
  function batchCandidates() {
    const all = (state.data && Array.isArray(state.data.requirements)) ? state.data.requirements : [];
    return all.filter((row) => {
      // ① 需求行必须停在 Owner 门：ready（已批准待派单）、开发/测试/收口一律不进。
      if (String((row && row.status) || '') !== 'owner_review') return false;
      // ② Owner 门必须还没决：pending / rejected（打回后复审）；approved/skipped 不进。
      const owner = ownerReviewStatusOf(row);
      if (owner && !['pending', 'rejected'].includes(owner)) return false;
      // ③ 打回后没改（OR_STATE 判 isRework=false）不算待复审。
      return OR_STATE ? OR_STATE.isPending(row) : true;
    });
  }
  function rememberBatchResult(ok, fail) {
    state.batchResult = {
      ok: Number(ok) || 0,
      fail: (Array.isArray(fail) ? fail : []).slice(0, 20).map((item) => ({ id: String(item.id || ''), reason: String(item.reason || '未返回原因') })),
      at: new Date().toISOString(),
    };
  }
  function batchFailureReason(err) {
    const info = humanizeError(err);
    return info.code ? `${info.title}（错误码 ${info.code}）` : info.title;
  }
  function batchResultEl() {
    const r = state.batchResult;
    if (!r) return null;
    const ok = Number(r.ok) || 0;
    const fails = Array.isArray(r.fail) ? r.fail : [];
    const box = el('div', 'rv-batch-result');
    box.setAttribute('data-batch-result', '1');
    box.setAttribute('data-batch-success', String(ok));
    box.setAttribute('data-batch-fail', String(fails.length));
    box.appendChild(el('b', '', `批量提交结果：成功 ${ok} 条 / 失败 ${fails.length} 条`));
    if (!fails.length) box.appendChild(el('span', 'rv-batch-result-note', '失败的条目保持原状态，不会改账。'));
    for (const f of fails.slice(0, 6)) {
      const line = el('p', 'rv-batch-error', `失败 ${f.id}：${f.reason}`);
      line.setAttribute('data-batch-fail-id', f.id);
      box.appendChild(line);
    }
    if (fails.length > 6) box.appendChild(el('p', 'rv-batch-error', `另有 ${fails.length - 6} 条失败未展开`));
    return box;
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
      ? '四人 fast：TR-Q 通过后进入 Owner 门才显示；已通过/已派单不再列'
      : '六人 full：只收 Owner 门待决（owner_review + 未决定）；已通过/已派单不再列'));
    // 全选通过：仍逐条落 decisions，不写汇总。
    const selectAll = el('label', 'rv-selectall');
    const allCheck = el('input');
    allCheck.type = 'checkbox';
    allCheck.setAttribute('data-batch-select-all', '1');
    allCheck.disabled = !rows.length;
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
    // AC3：批量提交的结果常驻在批量区（不只靠 6 秒 toast），成功 N / 失败 M + 每条原因。
    const resultBox = batchResultEl();
    if (resultBox) box.appendChild(resultBox);
    if (!rows.length) box.appendChild(el('p', 'rv-empty', '暂无待审需求（只收 owner_review 且 ownerReview=pending/已打回未复审）'));
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
      const badge = statusBadgeOf(row);
      const source = ownerReviewSourceOf(row);
      const lock = ownerActionLockOf(row);
      // AC4：批量行复用「全部需求」行的 .or-all-row 口径（同一套底色/边框/圆角/内边距/字号）。
      const item = el('div', 'or-all-row rv-batch-item');
      item.setAttribute('data-owner-batch-item', '1');
      item.setAttribute('data-req-id', id);
      item.setAttribute('data-brief', batchBriefOf(row));
      item.setAttribute('data-mode', mode);
      item.setAttribute('data-batch-status', badge.text);
      item.setAttribute('data-batch-source', source);
      item.setAttribute('data-batch-locked', lock ? '1' : '0');
      const check = el('input', 'rv-batch-check');
      check.type = 'checkbox';
      check.setAttribute('data-batch-check', '1');
      check.checked = selected.has(id);
      check.disabled = Boolean(lock);
      check.addEventListener('change', () => {
        if (!state.batchSelected) state.batchSelected = new Set();
        if (check.checked) state.batchSelected.add(id); else state.batchSelected.delete(id);
        renderDialog();
      });
      item.appendChild(check);
      const main = el('div', 'rv-batch-main');
      const title = el('b', 'rv-batch-title', clip60(humanizeTitle(row.title || id), 70));
      main.appendChild(title);
      // AC5：状态徽标（已通过/已派单/开发中/等你决定）+ ownerReview 来源（PM 代记/本人/来源未记）。
      const meta = el('span', 'rv-batch-meta');
      meta.appendChild(statusBadgeEl(row));
      meta.appendChild(sourceBadgeEl(row));
      main.appendChild(meta);
      main.appendChild(el('span', 'rv-batch-line', `${row.kind === 'defect' ? '缺陷' : '需求'} ｜ ${id} ｜ 当前：${badge.text}`));
      main.appendChild(el('span', 'rv-batch-line', `我做了什么：${batchBriefOf(row)}`));
      main.appendChild(el('span', 'rv-batch-line', `要你定什么：${batchPendingOf(row)}`));
      if (mode === 'fast') main.appendChild(el('span', 'rv-batch-tag', '未经产品评审'));
      const sug = suggestionsOf(id);
      if (sug.length) main.appendChild(el('span', 'rv-batch-sug', `有 ${sug.length} 条待你提建议`));
      if (lock) {
        // AC2：已决定/已越门的行，按钮禁用并写明原因，不让 Owner 点了没反应。
        const why = el('span', 'rv-batch-error', `这条不能点：${lock.text}`);
        why.setAttribute('data-batch-lock-reason', '1');
        main.appendChild(why);
      }
      item.appendChild(main);
      const actions = el('div', 'rv-batch-actions');
      const okBtn = el('button', 'rv-mini-btn ok', '通过');
      okBtn.type = 'button';
      okBtn.setAttribute('data-action', 'batch-approve');
      okBtn.disabled = Boolean(lock);
      if (lock) okBtn.title = `已决定：${lock.text}；这条不再重复落账`;
      okBtn.addEventListener('click', () => decideBatchOne(row, 'approved'));
      const noBtn = el('button', 'rv-mini-btn bad', '打回');
      noBtn.type = 'button';
      noBtn.setAttribute('data-action', 'batch-reject');
      noBtn.disabled = Boolean(lock);
      if (lock) noBtn.title = `已决定：${lock.text}；这条不再重复落账`;
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
        inner.appendChild(rej);
      }
    });
    box.appendChild(inner);
    // AC2/AC3：任何批量失败都在批量区留人话一行（以前 approve 失败只写 state.batchError，界面不渲染 → 点了没反应）。
    if (state.batchError) {
      const err = el('p', 'rv-batch-error', state.batchError);
      err.setAttribute('data-batch-error', '1');
      box.appendChild(err);
    }
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
    // AC2：已决定/已越门的行直接给出原因，不再发一次注定失败的 owner:decide。
    const lock = ownerActionLockOf(row);
    if (lock) {
      state.batchError = '';
      rememberBatchResult(0, [{ id, reason: lock.text }]);
      renderDialog();
      return;
    }
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
      // AC3：失败要有条目 + 原因（写进批量结果条，6 秒 toast 之外还能回看）。
      state.batchError = '';
      rememberBatchResult(0, [{ id, reason: batchFailureReason(e) }]);
      renderDialog();
      return;
    }
    state.batchError = '';
    rememberBatchResult(1, []);
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
    showNotice(`${status === 'approved' ? '已通过' : '已打回'}：${id}（成功 1 条 / 失败 0 条）`);
    renderDialog();
  }

  async function submitBatchApproved() {
    const ids = Array.from(state.batchSelected || []);
    if (!ids.length) return;
    const all = (state.data && Array.isArray(state.data.requirements)) ? state.data.requirements : [];
    const rows = ids.map((id) => all.find((row) => String(row.id) === String(id))).filter(Boolean);
    const found = new Set(rows.map((row) => String(row.id)));
    let ok = 0;
    const fails = ids.filter((id) => !found.has(String(id)))
      .map((id) => ({ id: String(id), reason: '列表里已找不到这条（可能刚被其他人处理），已跳过' }));
    state.batchError = '';
    for (const row of rows) {
      const id = String(row.id);
      // AC2：已决定的条目不再发一次注定失败的请求，直接计入失败并写原因。
      const lock = ownerActionLockOf(row);
      if (lock) { fails.push({ id, reason: lock.text }); continue; }
      try {
        const proxyActive = Boolean(state.proxy && String(state.proxy.requirementId || '') === id && !state.proxy.endedAt);
        const r = await window.workbench.ownerDecide({
          projectId: state.projectId,
          requirementId: id,
          status: 'approved',
          channel: proxyActive ? 'proxy' : 'ui',
          ...(proxyActive ? { recordedBy: 'pm' } : {}),
        });
        if (r && r.ok !== false) ok += 1;
        else fails.push({ id, reason: String((r && (r.message || r.code)) || '落账返回失败（无原因）') });
      } catch (e) {
        fails.push({ id, reason: batchFailureReason(e) });
      }
    }
    // AC3：成功 N 条 / 失败 M 条 + 每条原因；失败条目由后端拒绝，状态零改动。
    rememberBatchResult(ok, fails);
    state.batchSelected = new Set();
    await loadData();
    renderDialog();
    const brief = fails.length ? `；失败：${fails.slice(0, 3).map((f) => `${f.id}（${f.reason}）`).join('、')}` : '';
    showNotice(`批量通过：成功 ${ok} 条 / 失败 ${fails.length} 条${brief}`);
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

  // F-b28f-3 / S3：结束代管（落 endedAt/endedBy=owner，沿用 owner:proxy-end，actor=owner 硬校验不变）。
  async function endProxy() {
    if (!state.projectId) return { ok: false };
    if (!window.workbench || typeof window.workbench.ownerProxyEnd !== 'function') {
      showProxyBanner('当前版本没有结束代管接口，代管仍然生效中', 'bad', '（错误码 PROXY_END_API_MISSING）');
      return { ok: false, code: 'PROXY_END_API_MISSING' };
    }
    try {
      const r = await window.workbench.ownerProxyEnd({ projectId: state.projectId, actor: 'owner' });
      if (r && r.ok === false) throw new Error((r && (r.message || r.code)) || '结束代管失败');
      // B-5f62：结束代管后立刻把顶部条数、入口徽标、列表「已托管」一起刷新，不等 5 秒轮询。
      await updateProxyBadge();
      updateBadge();
      renderDialog();
      return { ok: !state.proxyAllActive, idempotent: Boolean(r && r.idempotent) };
    } catch (e) {
      const info = humanizeError(e);
      showProxyBanner(`结束代管失败：${info.title}`, 'bad', info.code ? `（错误码 ${info.code}）` : '');
      await updateProxyBadge();
      return { ok: false, code: info.code, message: info.title };
    }
  }

  function start() {
    buildShell();
    loadData();
    state.timer = setInterval(loadData, 5000);
    window.addEventListener('focus', loadData);
    // B-a1cf：评审代管.json 一变主进程就推事件 → 立刻重算徽标（不再只靠 5 秒轮询；
    // 窗口隐藏时浏览器会把定时器降到 1 分钟，看起来就像“代管数不更新”）。
    if (window.workbench && typeof window.workbench.onProxyChanged === 'function') {
      window.workbench.onProxyChanged(() => { updateProxyBadge(); updateBadge(); });
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadData(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
