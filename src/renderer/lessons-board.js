'use strict';
/**
 * R-51de（T-20261115-174027-410c）经验教训看板（只读）
 *
 * - 数据只来自 项目/<项目>/经验教训登记册.md 的实时解析（主进程 lessons:read → lessons.mjs loadLessons）；
 * - 无任何写通道、无编辑框/保存按钮（AC1）；
 * - 六页签固定 pm/product/analyst/programmer1/programmer2/tester，每段显示：
 *   data-lesson-count 条数、data-lesson-updated-at 最后一条日期、
 *   data-lesson-item 最新 3 条（按文件行序倒序）、点条后 data-lesson-detail 给完整四列；
 * - 文件缺失/损坏 → data-lessons-error="MISSING"/"BROKEN"，不显示「0 条」当正常（AC6）。
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
  const state = { data: null, active: localStorage.getItem('awb.lessonsTab') || 'pm', loading: false };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function buildShell() {
    if (document.getElementById('lessons-entry')) return;
    const foot = document.querySelector('.sidebar-foot');
    if (!foot) return;
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
  }

  function renderSections(data) {
    const body = state.dialog.querySelector('[data-lessons-body]');
    body.innerHTML = '';
    for (const [role, label] of ROLES) {
      const section = (data.sections || []).find((s) => s.role === role) || { role, count: 0, updatedAt: '', latest: [] };
      const box = el('section', 'lessons-section');
      box.setAttribute('data-lesson-section', role);
      const head = el('div', 'lessons-section-head');
      head.appendChild(el('b', '', label));
      const count = el('span', 'lessons-count', `条数 ${Number(section.count) || 0}`);
      count.setAttribute('data-lesson-count', role);
      head.appendChild(count);
      const updated = el('span', 'lessons-updated', section.updatedAt ? `最近更新 ${section.updatedAt}` : '最近更新 —');
      updated.setAttribute('data-lesson-updated-at', role);
      head.appendChild(updated);
      box.appendChild(head);

      // B-20261116-211329-0d59：每段最多渲染 10 条（原写死 3 条）；
      // 后端 src/main.js 的 rows.slice(-3) 是另一处写死，两处必须同改。
      const total = Number(section.count) || 0;
      const items = Array.isArray(section.latest) ? section.latest.slice(0, 10) : [];
      const shown = items.length;
      const truncated = total > shown ? 1 : 0;
      box.setAttribute('data-lesson-shown', String(shown));
      box.setAttribute('data-lesson-total', String(total));
      box.setAttribute('data-lesson-truncated', String(truncated));
      // 段头明确提示，禁止静默截断（R-5016 已定口径）
      const trunc = el('span', 'lessons-trunc', truncated ? `已展示 ${shown} / 共 ${total}（另有 ${total - shown} 条）` : `已展示 ${shown} / 共 ${total}`);
      trunc.setAttribute('data-lesson-more', String(Math.max(0, total - shown)));
      head.appendChild(trunc);

      if (!items.length) {
        const empty = el('div', 'lessons-empty', section.count ? '本段条目读取异常（按 0 展示，见日志）' : '本段暂无记录');
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
      showError('READ_FAILED', String((error && error.message) || error), null);
      renderSections({ sections: [] });
    } finally {
      state.loading = false;
    }
  }

  function open() {
    if (!state.dialog) buildShell();
    if (!state.dialog) return;
    state.dialog.hidden = false;
    setActive(state.active);
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildShell);
  else buildShell();
})();
