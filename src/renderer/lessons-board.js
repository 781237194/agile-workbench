'use strict';
/**
 * R-51de（T-20261115-174027-410c）经验教训看板（只读）
 * a28a（R-20261116-191847-a28a / 增补卷-a28a-1 §六）：弹窗内轮次条 + 已更正/已删除角标 + 已删除清单。
 *
 * - 数据只来自 项目/<项目>/经验教训登记册.md 的实时解析（主进程 lessons:read → lessons.mjs loadLessons）；
 * - 无任何写通道、无编辑框/保存按钮（AC1）；
 * - 六页签固定 pm/product/analyst/programmer1/programmer2/tester，每段显示：
 *   data-lesson-count 条数、data-lesson-updated-at 最后一条日期、
 *   data-lesson-item 最新 10 条（按文件行序倒序）、点条后 data-lesson-detail 给完整四列；
 * - 文件缺失/损坏 → data-lessons-error="MISSING"/"BROKEN"，不显示「0 条」当正常（AC6）。
 *
 * a28a 口径（写死，别改）：
 *   · 轮次条容器 [data-lessons-turns] 插在 .lessons-head 之后、[data-lessons-tabs] 之前；
 *     每角色一行 [data-lessons-turn-row]（行数 = 名册角色数，full 6 / fast 4，**不写死 6**）；
 *     行内锚点：data-lessons-turn-count（已完成轮次）／data-lessons-turn-tick（阈值）／
 *     data-lessons-turn-next（距下次提醒 = 阈值 − turns）／data-lessons-turn-last（上次提醒时间，从未提醒「—」）；
 *     条级锚点：data-lessons-turn-refresh（手动刷新按钮）／data-lessons-turn-source（阈值来源）／
 *     data-lessons-turns-note（缺文件/读取失败提示）。
 *   · 刷新口径：**打开弹窗读一次**（open() 里调一次 IPC lessons:turns）；**切页签不重算**（setActive 里没有任何 IPC）；
 *     要更新只点 [data-lessons-turn-refresh]。**禁止定时器 / 轮询**（断言：弹窗打开期间调用次数 ≤ 打开次数 + 手动刷新次数）。
 *   · 无数据（turns=null：计数文件缺失 / 无该 role 键 / 键损坏）显示「—」，**绝不显示 0**。
 *   · 已删除条目（登记册行尾 <!-- deleted --> 的行）**不出现在正常列表**，只出现在
 *     [data-lessons-deleted-list]（每行 5 值 id/日期/删除时间/删除者/原文折叠；只读、无编辑无恢复控件）；
 *     角标「已更正 N 条 / 已删除 N 条」= 审计按 id 去重计数（主进程 lessons.mjs auditStats）。
 */
(function () {
  const ROLES = [
    ['pm', '项目经理'],
    ['product', '产品'],
    ['analyst', '需求分析师'],
    ['programmer1', '程序员A'],
    ['programmer2', '程序员B'],
    ['tester', '测试']
  ];
  const LABEL = Object.fromEntries(ROLES);
  // 阈值来源只认三种（卷 §四.3）；env 仅在 SELFTEST/FORCE 时生效，判定在主进程 lessons.mjs。
  const TURN_SOURCE_LABEL = { env: '环境变量（测试注入）', project: '项目配置', default: '缺省值' };
  const state = {
    data: null,
    active: localStorage.getItem('awb.lessonsTab') || 'pm',
    loading: false,
    // a28a：最近一次 lessons:turns 结果。只在「打开弹窗」和「点刷新」时更新，切页签复用同一份。
    turns: null,
    turnsLoading: false,
    deleted: [],
    deletedOpen: false
  };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * a28a 新增块样式随脚本自注入：本轮写域只有 lessons-board.js（style.css 不在写域），
   * 类名统一 lessons-turns* / lessons-audit* / lessons-deleted*，将来要收进 style.css 时整段搬走即可（锚点不受影响）。
   */
  function ensureStyle() {
    if (document.getElementById('awb-lessons-board-style')) return;
    const style = document.createElement('style');
    style.id = 'awb-lessons-board-style';
    style.textContent = [
      '.lessons-turns{padding:8px 14px 10px;border-bottom:1px solid rgba(255,255,255,.08);font-size:12px;}',
      '.lessons-turns-head{display:flex;align-items:center;gap:10px;}',
      '.lessons-turns-head b{font-size:13px;}',
      '.lessons-turns-title{opacity:.62;}',
      '.lessons-turns-source{margin-left:auto;opacity:.82;white-space:nowrap;}',
      '.lessons-turn-refresh{border:1px solid rgba(255,255,255,.18);background:transparent;color:inherit;border-radius:6px;padding:2px 10px;cursor:pointer;font-size:12px;}',
      '.lessons-turn-refresh[disabled]{opacity:.5;cursor:default;}',
      '.lessons-turn-rows{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:2px 16px;margin-top:6px;}',
      '.lessons-turn-row{display:flex;align-items:baseline;gap:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.lessons-turn-name{font-weight:600;margin-right:4px;}',
      '.lessons-turn-label{opacity:.62;}',
      '.lessons-turns-note{margin-top:6px;opacity:.85;}',
      '.lessons-turns-note[hidden]{display:none;}',
      '.lessons-turns-empty{opacity:.62;}',
      '.lessons-audit{display:flex;align-items:center;gap:12px;padding:6px 14px 8px;border-bottom:1px solid rgba(255,255,255,.08);font-size:12px;}',
      '.lessons-audit-fixed{opacity:.78;}',
      '.lessons-audit-deleted{border:1px solid rgba(214,178,96,.55);background:rgba(214,178,96,.12);color:inherit;border-radius:999px;padding:2px 10px;cursor:pointer;font-size:12px;}',
      '.lessons-audit-deleted[disabled]{opacity:.5;cursor:default;}',
      '.lessons-deleted{padding:6px 14px 10px;max-height:220px;overflow:auto;border-bottom:1px solid rgba(255,255,255,.08);}',
      '.lessons-deleted[hidden]{display:none;}',
      '.lessons-deleted-head{font-size:12px;opacity:.66;margin-bottom:6px;}',
      '.lessons-deleted-row{border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);border-radius:6px;padding:6px 8px;margin-bottom:6px;font-size:12px;}',
      '.lessons-deleted-line{opacity:.88;word-break:break-word;}',
      '.lessons-deleted-toggle{margin-top:4px;border:1px solid rgba(214,178,96,.45);background:transparent;color:inherit;border-radius:6px;padding:1px 8px;cursor:pointer;font-size:12px;}',
      '.lessons-deleted-text{margin-top:4px;white-space:pre-wrap;word-break:break-word;opacity:.92;border-top:1px dashed rgba(255,255,255,.14);padding-top:4px;}',
      '.lessons-deleted-text[hidden]{display:none;}',
      '.lessons-deleted-empty{font-size:12px;opacity:.66;}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function buildShell() {
    if (document.getElementById('lessons-entry')) return;
    const foot = document.querySelector('.sidebar-foot');
    if (!foot) return;
    ensureStyle();
    const entry = el('button', 'metrics-mini lessons-entry', '经验教训');
    entry.id = 'lessons-entry';
    entry.type = 'button';
    entry.setAttribute('data-lessons-entry', '1');
    entry.title = '经验教训看板：六角色只读页签，数据实时取自经验教训登记册.md';
    const metrics = document.getElementById('metrics');
    if (metrics && metrics.parentNode === foot) foot.insertBefore(entry, metrics.nextSibling);
    else foot.appendChild(entry);
    entry.addEventListener('click', open);

    const dialog = el('div', 'lessons-dialog');
    dialog.id = 'lessons-dialog';
    dialog.setAttribute('data-lessons-dialog', '1');
    dialog.hidden = true;
    dialog.innerHTML = ''
      + '<div class="lessons-card" role="dialog" aria-modal="true" aria-label="经验教训看板">'
      + '  <div class="lessons-head"><b>经验教训</b><span class="lessons-meta" data-lessons-meta></span>'
      + '    <button type="button" class="lessons-close" data-lessons-close>关闭</button></div>'
      // a28a §六.1：轮次条必须紧接在 .lessons-head 之后（下一个兄弟）、[data-lessons-tabs] 之前；行数由主进程按名册给。
      + '  <div class="lessons-turns" data-lessons-turns="1">'
      + '    <div class="lessons-turns-head"><b>轮次</b>'
      + '      <span class="lessons-turns-title">按角色动作计数，达阈值提醒一次（只读）</span>'
      + '      <span class="lessons-turns-source" data-lessons-turn-source="default">阈值 — · 来源 —</span>'
      + '      <button type="button" class="lessons-turn-refresh" data-lessons-turn-refresh>刷新</button></div>'
      + '    <div class="lessons-turn-rows" data-lessons-turn-rows></div>'
      + '    <div class="lessons-turns-note" data-lessons-turns-note hidden></div>'
      + '  </div>'
      // a28a §六.3/§七：角标（审计按 id 去重）+ 已删除只读清单（5 值、原文折叠、无编辑无恢复）
      + '  <div class="lessons-audit" data-lessons-audit="1">'
      + '    <span class="lessons-audit-fixed" data-lessons-audit-fixed>已更正 — 条</span>'
      + '    <button type="button" class="lessons-audit-deleted" data-lessons-audit-deleted data-lessons-deleted-toggle aria-expanded="false" disabled>已删除 — 条</button>'
      + '  </div>'
      + '  <div class="lessons-deleted" data-lessons-deleted-list hidden></div>'
      + '  <div class="lessons-error" data-lessons-error hidden></div>'
      + '  <div class="lessons-tabs" role="tablist" data-lessons-tabs></div>'
      + '  <div class="lessons-body" data-lessons-body></div>'
      + '</div>';
    document.body.appendChild(dialog);

    const tabs = dialog.querySelector('[data-lessons-tabs]');
    for (const [role, label] of ROLES) {
      const tab = el('button', 'lessons-tab', label);
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('data-lesson-tab', role);
      tab.setAttribute('aria-selected', 'false');
      tab.addEventListener('click', () => setActive(role));
      tabs.appendChild(tab);
    }
    dialog.querySelector('[data-lessons-close]').addEventListener('click', () => { dialog.hidden = true; });
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.hidden = true; });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !dialog.hidden) dialog.hidden = true; });
    // 刷新口径：整个弹窗只有下面这一处会再读 lessons:turns（另一次在 open()）。
    dialog.querySelector('[data-lessons-turn-refresh]').addEventListener('click', () => { loadTurns(); });
    // 「已删除 N 条」= 展开/收起只读清单，不发 IPC、不改任何数据。
    dialog.querySelector('[data-lessons-deleted-toggle]').addEventListener('click', () => {
      state.deletedOpen = !state.deletedOpen;
      renderDeletedList();
    });
    state.dialog = dialog;
  }

  function setActive(role) {
    state.active = ROLES.some(([id]) => id === role) ? role : 'pm';
    localStorage.setItem('awb.lessonsTab', state.active);
    const dialog = state.dialog;
    if (!dialog) return;
    for (const tab of dialog.querySelectorAll('[data-lesson-tab]')) {
      tab.setAttribute('aria-selected', tab.getAttribute('data-lesson-tab') === state.active ? 'true' : 'false');
    }
    for (const section of dialog.querySelectorAll('[data-lesson-section]')) {
      section.hidden = section.getAttribute('data-lesson-section') !== state.active;
    }
    // 切页签只切显隐、不重算：这里没有任何 IPC（a28a 断言「切页签不重算」）。
  }

  /**
   * 已删除行判定（a28a F9/C.5）：数据行行尾带 `<!-- deleted -->` 的条目不上正常列表。
   * 已删除清单是 5 键（卷 §七：id/date/deletedAt/by/text，**没有 role**），所以按「日期 + 教训原文」匹配；
   * 两处都来自主进程同一次 loadLessons 解析（同一实现），不会出现格式差异。
   */
  function isDeletedLessonRow(row) {
    const list = state.turns && Array.isArray(state.turns.deleted) ? state.turns.deleted : [];
    if (!list.length) return false;
    const date = String((row && row.date) || '');
    const lesson = String((row && row.lesson) || '');
    if (!date || !lesson) return false;
    return list.some((item) => item && String(item.date) === date && String(item.text) === lesson);
  }

  function renderSections(data) {
    const body = state.dialog.querySelector('[data-lessons-body]');
    body.innerHTML = '';
    for (const [role, label] of ROLES) {
      const section = (data.sections || []).find((s) => s.role === role) || { role, count: 0, updatedAt: '', latest: [] };
      // F9：段条数 data-lesson-count 按**未删**条目算——主进程用同一 loadLessons 给 activeCount/deletedCount；
      // 该角色不在本轮名册（或轮次数据未到）时回退 lessons:read 的 count，避免把条数显示成 0。
      const countInfo = (state.turns && Array.isArray(state.turns.sections))
        ? (state.turns.sections.find((s) => s && s.role === role) || null)
        : null;
      const total = countInfo && Number.isFinite(Number(countInfo.activeCount))
        ? Math.max(0, Math.floor(Number(countInfo.activeCount)))
        : (Number(section.count) || 0);
      const box = el('section', 'lessons-section');
      box.setAttribute('data-lesson-section', role);
      const head = el('div', 'lessons-section-head');
      head.appendChild(el('b', '', label));
      const count = el('span', 'lessons-count', `条数 ${total}`);
      count.setAttribute('data-lesson-count', role);
      head.appendChild(count);
      const updated = el('span', 'lessons-updated', section.updatedAt ? `最近更新 ${section.updatedAt}` : '最近更新 —');
      updated.setAttribute('data-lesson-updated-at', role);
      head.appendChild(updated);
      box.appendChild(head);

      // B-20261116-211329-0d59：每段最多渲染 10 条（原写死 3 条）；
      // 后端 src/main.js 的 rows.slice(-10) 是另一处写死，两处必须同改。
      const rawItems = Array.isArray(section.latest) ? section.latest.slice(0, 10) : [];
      // a28a（F9）：软删行不渲染进正常列表；已删除条数见上方「已删除」角标/清单，不在这里显示 0。
      const items = rawItems.filter((row) => !isDeletedLessonRow(row));
      const shown = items.length;
      const truncated = total > shown ? 1 : 0;
      box.setAttribute('data-lesson-shown', String(shown));
      box.setAttribute('data-lesson-total', String(total));
      box.setAttribute('data-lesson-truncated', String(truncated));
      box.setAttribute('data-lesson-hidden', String(rawItems.length - shown));
      // 段头明确提示，禁止静默截断（R-5016 已定口径）
      const trunc = el('span', 'lessons-trunc', truncated ? `已展示 ${shown} / 共 ${total}（另有 ${total - shown} 条）` : `已展示 ${shown} / 共 ${total}`);
      trunc.setAttribute('data-lesson-more', String(Math.max(0, total - shown)));
      head.appendChild(trunc);

      if (!items.length) {
        // 三种空：整段没记录 / 最近条目都已软删（隐藏不是丢数据）/ 计数>0 但没读到行（异常）
        const emptyText = rawItems.length
          ? '本段最近条目均已软删（见上方「已删除」清单）'
          : (section.count ? '本段条目读取异常（按 0 展示，见日志）' : '本段暂无记录');
        const empty = el('div', 'lessons-empty', emptyText);
        empty.setAttribute('data-lesson-empty', role);
        box.appendChild(empty);
      } else {
        for (const row of items) {
          const item = el('button', 'lessons-item');
          item.type = 'button';
          item.setAttribute('data-lesson-item', role);
          item.setAttribute('data-lesson-date', String(row.date || ''));
          const title = el('span', 'lessons-item-title', `${row.date || ''} · ${String(row.scene || '').slice(0, 80)}`);
          item.appendChild(title);
          const detail = el('div', 'lessons-detail');
          detail.setAttribute('data-lesson-detail', role);
          detail.hidden = true;
          detail.textContent = `日期：${row.date || ''}\n场景：${row.scene || ''}\n教训：${row.lesson || ''}\n下次怎么做：${row.next || ''}`;
          item.appendChild(detail);
          item.addEventListener('click', () => {
            detail.hidden = !detail.hidden;
            item.setAttribute('data-lesson-expanded', detail.hidden ? '0' : '1');
          });
          box.appendChild(item);
        }
      }
      body.appendChild(box);
    }
    setActive(state.active);
  }

  /**
   * 轮次条渲染（a28a §六.3）。数据全部来自主进程 lessons:turns（每次现读盘，不缓存）。
   * 无数据（turns == null）一律显示「—」，**不得用 0 冒充**；阈值/来源按主进程给的 source 显示。
   */
  function renderTurns(payload) {
    const dialog = state.dialog;
    if (!dialog) return;
    state.turns = payload || null;
    const ok = Boolean(payload && payload.ok !== false && Array.isArray(payload.roles));
    const threshold = payload && Number.isFinite(Number(payload.threshold)) && Number(payload.threshold) >= 1
      ? Math.floor(Number(payload.threshold)) : 0;
    const source = (payload && ['env', 'project', 'default'].includes(String(payload.source))) ? String(payload.source) : 'default';
    const sourceEl = dialog.querySelector('[data-lessons-turn-source]');
    if (ok) {
      sourceEl.textContent = `阈值 ${threshold} 轮 · 来源 ${TURN_SOURCE_LABEL[source] || source}`;
      sourceEl.setAttribute('data-lessons-turn-source', source);
      sourceEl.setAttribute('data-lessons-turn-threshold', String(threshold));
    } else {
      sourceEl.textContent = '阈值 — · 来源 —';
      sourceEl.setAttribute('data-lessons-turn-source', '');
      sourceEl.removeAttribute('data-lessons-turn-threshold');
    }

    const rowsEl = dialog.querySelector('[data-lessons-turn-rows]');
    rowsEl.innerHTML = '';
    const rows = ok ? payload.roles : [];
    for (const row of rows) {
      const role = String((row && row.role) || '');
      const turns = row && row.turns != null && Number.isFinite(Number(row.turns)) ? Math.max(0, Math.floor(Number(row.turns))) : null;
      const next = row && row.nextInTurns != null && Number.isFinite(Number(row.nextInTurns))
        ? Math.max(0, Math.floor(Number(row.nextInTurns)))
        : (turns == null || !threshold ? null : Math.max(0, threshold - turns));
      const lastIso = row && row.lastNotifiedAt ? String(row.lastNotifiedAt) : '';
      const lastText = row && row.lastNotifiedAtText ? String(row.lastNotifiedAtText) : '';
      const rowEl = el('div', 'lessons-turn-row');
      rowEl.setAttribute('data-lessons-turn-row', role);
      rowEl.setAttribute('data-lessons-turn-role', role);
      rowEl.setAttribute('data-turns', turns == null ? '' : String(turns));
      rowEl.setAttribute('data-next-in-turns', next == null ? '' : String(next));
      rowEl.setAttribute('data-last-notified-at', lastIso);
      rowEl.appendChild(el('span', 'lessons-turn-name', LABEL[role] || role || '—'));
      rowEl.appendChild(el('span', 'lessons-turn-label', '轮次 '));
      const countEl = el('span', 'lessons-turn-count', turns == null ? '—' : String(turns));
      countEl.setAttribute('data-lessons-turn-count', turns == null ? '' : String(turns));
      rowEl.appendChild(countEl);
      rowEl.appendChild(el('span', 'lessons-turn-label', '/'));
      // 阈值同一值对每角色相同，但每行都带锚点，便于逐行断言（值同时挂属性）
      const tickEl = el('span', 'lessons-turn-tick', threshold ? String(threshold) : '—');
      tickEl.setAttribute('data-lessons-turn-tick', threshold ? String(threshold) : '');
      rowEl.appendChild(tickEl);
      rowEl.appendChild(el('span', 'lessons-turn-label', ' · 距下次提醒 '));
      const nextEl = el('span', 'lessons-turn-next', next == null ? '—' : String(next));
      nextEl.setAttribute('data-lessons-turn-next', next == null ? '' : String(next));
      rowEl.appendChild(nextEl);
      rowEl.appendChild(el('span', 'lessons-turn-label', ' 轮 · 上次提醒 '));
      const lastEl = el('span', 'lessons-turn-last', lastText || '—');
      lastEl.setAttribute('data-lessons-turn-last', lastIso);
      rowEl.appendChild(lastEl);
      rowsEl.appendChild(rowEl);
    }
    if (!rows.length) {
      const empty = el('div', 'lessons-turns-empty', ok ? '名册里没有可显示的角色' : '轮次数据读取失败');
      empty.setAttribute('data-lessons-turns-empty', '1');
      rowsEl.appendChild(empty);
    }

    const note = dialog.querySelector('[data-lessons-turns-note]');
    note.removeAttribute('data-lessons-turns-error');
    if (!ok) {
      note.hidden = false;
      note.setAttribute('data-lessons-turns-error', String((payload && payload.code) || 'LESSONS_TURNS_FAILED'));
      note.textContent = '轮次数据读取失败：' + String((payload && payload.message) || '未知原因');
    } else if (payload.missing) {
      note.hidden = false;
      note.textContent = '轮次计数文件还没生成：首次有计数动作后自动建立（缺失时显示「—」，不按 0 计）';
    } else {
      note.hidden = true;
      note.textContent = '';
    }

    renderAudit(ok ? payload : null);
    // 已删除条目不出现在正常列表：轮次数据（含已删除清单）到位后重绘一次段列表（数据仍复用 state.data，不重读 md）。
    if (state.data) renderSections(state.data);
  }

  /** 角标：已更正/已删除 N 条 = 审计按 id 去重（主进程 auditStats）；读取失败显示「—」，不显示 0 当正常。 */
  function renderAudit(payload) {
    const dialog = state.dialog;
    if (!dialog) return;
    const ok = Boolean(payload && payload.ok !== false && payload.audit && typeof payload.audit === 'object');
    const audit = ok ? payload.audit : null;
    const fixed = audit && Number.isFinite(Number(audit.fixed)) ? Math.max(0, Math.floor(Number(audit.fixed))) : null;
    const deletedCount = audit && Number.isFinite(Number(audit.deleted)) ? Math.max(0, Math.floor(Number(audit.deleted))) : null;
    const fixedEl = dialog.querySelector('[data-lessons-audit-fixed]');
    fixedEl.textContent = `已更正 ${fixed == null ? '—' : fixed} 条`;
    fixedEl.setAttribute('data-lessons-audit-fixed', fixed == null ? '' : String(fixed));
    const toggle = dialog.querySelector('[data-lessons-deleted-toggle]');
    toggle.textContent = `已删除 ${deletedCount == null ? '—' : deletedCount} 条`;
    toggle.setAttribute('data-lessons-audit-deleted', deletedCount == null ? '' : String(deletedCount));
    toggle.disabled = !ok;
    if (!ok) state.deletedOpen = false;
    toggle.setAttribute('aria-expanded', state.deletedOpen ? 'true' : 'false');
    state.deleted = ok && Array.isArray(payload.deleted) ? payload.deleted : [];
    renderDeletedList();
  }

  /** 已删除只读清单（a28a F10 / 卷 §七）：每行 5 值 id/日期/删除时间/删除者/原文（折叠）；无编辑无恢复控件。 */
  function renderDeletedList() {
    const dialog = state.dialog;
    if (!dialog) return;
    const list = dialog.querySelector('[data-lessons-deleted-list]');
    const toggle = dialog.querySelector('[data-lessons-deleted-toggle]');
    toggle.setAttribute('aria-expanded', state.deletedOpen ? 'true' : 'false');
    list.hidden = !state.deletedOpen;
    list.innerHTML = '';
    if (!state.deletedOpen) return;
    const rows = Array.isArray(state.deleted) ? state.deleted : [];
    const auditCount = toggle.getAttribute('data-lessons-audit-deleted');
    const head = el('div', 'lessons-deleted-head',
      `登记册已标记 ${rows.length} 行；审计去重 ${auditCount === '' || auditCount == null ? '—' : auditCount} 条。只读：原文保留，无编辑/恢复入口。`);
    head.setAttribute('data-lessons-deleted-count', String(rows.length));
    list.appendChild(head);
    if (!rows.length) {
      const empty = el('div', 'lessons-deleted-empty', '没有已删除条目');
      empty.setAttribute('data-lessons-deleted-empty', '1');
      list.appendChild(empty);
      return;
    }
    for (const row of rows) {
      const id = String((row && row.id) || '');
      const date = String((row && row.date) || '');
      const deletedAt = String((row && row.deletedAt) || '');
      const by = String((row && row.by) || '');
      const text = String((row && row.text) || '');
      const item = el('div', 'lessons-deleted-row');
      item.setAttribute('data-lessons-deleted-row', '1');
      // 5 键原值全挂在行属性上（字段名与 CLI `lessons status --deleted` 逐字段一致：{id,date,deletedAt,by,text}）
      item.setAttribute('data-lessons-deleted-id', id);
      item.setAttribute('data-lessons-deleted-date', date);
      item.setAttribute('data-lessons-deleted-at', deletedAt);
      item.setAttribute('data-lessons-deleted-by', by);
      item.setAttribute('data-lessons-deleted-text', text);
      const line = el('div', 'lessons-deleted-line',
        `${id || '（无 id）'} · ${date || '—'} · 删除于 ${deletedAt || '—'} · 删除者 ${by || '—'}`);
      item.appendChild(line);
      const btn = el('button', 'lessons-deleted-toggle', '原文');
      btn.type = 'button';
      btn.setAttribute('data-lessons-deleted-text-toggle', '1');
      const textBox = el('div', 'lessons-deleted-text', text || '—');
      textBox.setAttribute('data-lessons-deleted-textbox', '1');
      textBox.hidden = true;
      btn.addEventListener('click', () => { textBox.hidden = !textBox.hidden; });
      item.appendChild(btn);
      item.appendChild(textBox);
      list.appendChild(item);
    }
  }

  function showError(code, text, data) {
    const dialog = state.dialog;
    // 错误节点用稳定 class 选（成功时会把 data-lessons-error 属性移除，属性选择器会再也找不到它）。
    const err = dialog.querySelector('.lessons-error');
    err.hidden = false;
    err.setAttribute('data-lessons-error', code);
    const warns = (data && Array.isArray(data.parseWarn) ? data.parseWarn : []).slice(0, 2)
      .map((w) => `${w.reason}${w.line ? '（第 ' + w.line + ' 行）' : ''}`).join('；');
    err.textContent = text + (warns ? `（解析警告：${warns}）` : '');
    const meta = dialog.querySelector('[data-lessons-meta]');
    meta.textContent = data && data.file ? data.file : '';
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    const dialog = state.dialog;
    const meta = dialog.querySelector('[data-lessons-meta]');
    meta.textContent = '读取中…';
    try {
      const app = await window.workbench.state();
      const projects = Array.isArray(app && app.projects) ? app.projects : [];
      const active = projects.find((p) => p && p.id === app.activeProjectId) || projects[0] || null;
      if (!active) throw new Error('还没有当前项目');
      const data = await window.workbench.lessonsRead({ projectId: active.id });
      state.data = data || null;
      const err = dialog.querySelector('.lessons-error');
      if (!data || data.ok === false || data.missing || data.broken) {
        state.data = null;
        const code = data && data.missing ? 'MISSING' : (data && data.broken ? 'BROKEN' : 'READ_FAILED');
        const msg = data && data.missing
          ? `经验教训登记册缺失：${data.file || ''}`
          : (data && data.broken ? '经验教训登记册无法解析（缺 ## 角色段或表头损坏）' : String((data && data.message) || '读不出来'));
        showError(code, msg, data);
        renderSections({ sections: [] });
      } else {
        err.hidden = true;
        err.removeAttribute('data-lessons-error');
        const total = data.sections.reduce((sum, s) => sum + (Number(s.count) || 0), 0);
        meta.textContent = `共 ${total} 条 · 文件 ${String(data.fileSha || '').slice(0, 12) || '—'} · ${data.file || ''}`;
        renderSections(data);
      }
    } catch (error) {
      state.data = null;
      showError('READ_FAILED', String((error && error.message) || error), null);
      renderSections({ sections: [] });
    } finally {
      state.loading = false;
    }
  }

  /**
   * 轮次/角标/已删除清单取数（a28a）：**每次调用只发一次 lessons:turns IPC**，由主进程现读盘。
   * 仅两个调用点：open()（打开弹窗读一次）与 [data-lessons-turn-refresh] 点击（手动刷新）；
   * 切页签/切段/展开条目都不会走到这里（见 setActive 注释），因此没有轮询、没有定时器。
   */
  async function loadTurns() {
    const dialog = state.dialog;
    if (!dialog || state.turnsLoading) return;
    state.turnsLoading = true;
    const btn = dialog.querySelector('[data-lessons-turn-refresh]');
    if (btn) { btn.disabled = true; btn.setAttribute('data-busy', '1'); }
    try {
      const app = await window.workbench.state();
      const projects = Array.isArray(app && app.projects) ? app.projects : [];
      const active = projects.find((p) => p && p.id === app.activeProjectId) || projects[0] || null;
      if (!active) throw new Error('还没有当前项目');
      const data = await window.workbench.lessonsTurns({ projectId: active.id });
      renderTurns(data || null);
    } catch (error) {
      // 轮次读取失败不占用主错误条（主错误条归 lessons:read）；只写轮次条自己的错误行，且不显示 0
      state.turns = null;
      renderTurns(null);
      const note = dialog.querySelector('[data-lessons-turns-note]');
      if (note) {
        note.hidden = false;
        note.setAttribute('data-lessons-turns-error', 'READ_FAILED');
        note.textContent = '轮次数据读取失败：' + String((error && error.message) || error);
      }
    } finally {
      state.turnsLoading = false;
      if (btn) { btn.disabled = false; btn.removeAttribute('data-busy'); }
    }
  }

  function open() {
    if (!state.dialog) buildShell();
    if (!state.dialog) return;
    state.dialog.hidden = false;
    state.deletedOpen = false;
    setActive(state.active);
    load();       // 登记册（md 实时解析）——打开读一次
    loadTurns();  // 轮次/角标/已删除——打开读一次；切页签不重读，只有刷新按钮会再读
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildShell);
  else buildShell();
})();
