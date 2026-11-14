/**
 * R-20261114-001014-e29f · 工作区残留清理（T-20261114-005845-38f0）
 *
 * 只做三件事，而且只在一处显示：
 *  ① 「额外会话 N 个」——N = 工作区绑定里不属于当前角色集合的会话数（后端单一口径 workspaceSessionState.extras）；
 *     点开看清单（sessionId 后 8 位 / 角色 / 来源 / 建议动作）；
 *  ② 「清理额外会话」——先把将移除清单摆出来，二次确认后才解绑；只解绑，不删 DSH 会话、不改团队名册；
 *  ③ 「清理历史」——读 团队/状态/项目/<项目>/工作区清理.jsonl（append-only），显示时间/移除/保留/执行人。
 *
 * 依赖的壳接口：workspacePlan / workspaceClean / workspaceHistory / dshTeamStatus（preload 已登记）。
 */
(function () {
  'use strict';

  const state = { projectId: '', plan: null, panel: 'closed', history: [], error: '', notice: '', timer: null, busy: false };

  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function api() { return (typeof window !== 'undefined' && window.workbench) ? window.workbench : null; }

  function host() {
    // 只在一处显示：优先侧栏（工作区 tab 的六角色会话块正下方，默认就看得见）；
    // 侧栏没渲染时退回团队台的同区域。两个位置共用同一个 #extra-sessions 节点，不会出现第二份。
    const roleBox = document.getElementById('role-sessions');
    if (roleBox && roleBox.parentNode) return { parent: roleBox.parentNode, before: roleBox.nextSibling };
    const note = document.getElementById('team-live-note');
    if (note && note.parentNode) return { parent: note.parentNode, before: note.nextSibling };
    return null;
  }

  function ensureBox() {
    let box = document.getElementById('extra-sessions');
    if (box) return box;
    const spot = host();
    if (!spot) return null;
    box = el('div', 'extra-sessions');
    box.id = 'extra-sessions';
    box.setAttribute('data-extra-sessions', '1');
    spot.parent.insertBefore(box, spot.before);
    return box;
  }

  async function activeProjectId() {
    const duck = api();
    if (!duck || !duck.state) return '';
    try {
      const store = await duck.state();
      const projects = Array.isArray(store && store.projects) ? store.projects : [];
      const project = projects.find((p) => p.id === (store && store.activeProjectId)) || projects[0] || null;
      return project ? String(project.id) : '';
    } catch { return ''; }
  }

  async function loadPlan() {
    const duck = api();
    if (!duck || !duck.workspacePlan || !state.projectId) return null;
    try {
      const plan = await duck.workspacePlan({ projectId: state.projectId });
      state.plan = plan && plan.ok !== false ? plan : null;
      state.error = plan && plan.ok === false ? String(plan.message || plan.code || '读取工作区绑定失败') : '';
      return state.plan;
    } catch (error) {
      state.plan = null;
      state.error = String((error && error.message) || error || '读取工作区绑定失败');
      return null;
    }
  }

  function render() {
    const box = ensureBox();
    if (!box) return;
    const plan = state.plan;
    box.innerHTML = '';
    if (!plan) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const count = Number(plan.extraCount || 0);
    const head = el('div', 'extra-head');
    const label = el('span', 'extra-label');
    label.setAttribute('data-extra-count', String(count));
    label.textContent = `额外会话 ${count} 个`;
    if (count > 0) label.classList.add('warn');
    head.appendChild(label);
    if (plan.roleSetVerifiable === false) {
      const warn = el('span', 'extra-warn', '名册未读到，按项目映射比');
      head.appendChild(warn);
    }
    const spacer = el('span', 'extra-spacer');
    head.appendChild(spacer);
    const btn = el('button', 'extra-btn', count > 0 ? '查看 / 清理' : '清理历史');
    btn.type = 'button';
    btn.setAttribute('data-extra-toggle', '1');
    btn.addEventListener('click', async () => {
      state.panel = state.panel === 'open' && count > 0 ? 'closed' : 'open';
      if (state.panel === 'open') await loadHistory();
      render();
    });
    head.appendChild(btn);
    box.appendChild(head);

    if (state.error) {
      const err = el('div', 'extra-error', state.error);
      err.setAttribute('data-extra-error', '1');
      box.appendChild(err);
    }
    if (state.notice) {
      const ok = el('div', 'extra-notice', state.notice);
      ok.setAttribute('data-extra-notice', '1');
      box.appendChild(ok);
    }

    if (state.panel === 'open') {
      const panel = el('div', 'extra-panel');
      panel.setAttribute('data-extra-panel', '1');
      if (count > 0) {
        panel.appendChild(el('p', 'extra-p', `将移除 ${count} 个绑定（只解绑，不删除 DSH 会话；当前角色会话不在清单里，不可移除）：`));
        const list = el('ul', 'extra-list');
        (plan.extras || []).forEach((row) => {
          const li = el('li', 'extra-row');
          li.setAttribute('data-extra-session', String(row.sessionId));
          li.appendChild(el('code', 'extra-sid', String(row.short || row.sessionId)));
          li.appendChild(el('span', 'extra-role', row.role ? `角色：${row.role}` : '角色：未记录'));
          li.appendChild(el('span', 'extra-src', `来源：${row.source || '未记录'}`));
          li.appendChild(el('span', 'extra-act', row.action || '解绑（不删除 DSH 会话）'));
          list.appendChild(li);
        });
        panel.appendChild(list);
        const actions = el('div', 'extra-actions');
        const clean = el('button', 'extra-btn primary', `确认清理（移除 ${count} 个）`);
        clean.type = 'button';
        clean.setAttribute('data-extra-clean', '1');
        clean.disabled = state.busy;
        clean.addEventListener('click', () => runClean(plan));
        const cancel = el('button', 'extra-btn', '取消');
        cancel.type = 'button';
        cancel.setAttribute('data-extra-cancel', '1');
        cancel.addEventListener('click', () => { state.panel = 'closed'; render(); });
        actions.appendChild(clean);
        actions.appendChild(cancel);
        panel.appendChild(actions);
      } else {
        panel.appendChild(el('p', 'extra-p', '当前工作区绑定里没有额外会话：角色集合已全部被绑定，也没有多余旧会话。'));
      }
      // 清理历史（append-only，不覆盖）
      const his = el('div', 'extra-history');
      his.setAttribute('data-extra-history', '1');
      his.appendChild(el('b', 'extra-h-title', '清理历史（最近 5 条）'));
      const rows = (state.history || []).slice(-5).reverse();
      if (!rows.length) {
        const empty = el('div', 'extra-h-row muted', '暂无记录');
        empty.setAttribute('data-extra-h-row', '1');
        his.appendChild(empty);
      }
      rows.forEach((row) => {
        const line = el('div', 'extra-h-row', `${fmt(row.at)} · 移除 ${(row.removed || []).length} · 保留 ${(row.kept || []).length} · ${row.by || '未记录'}`);
        line.setAttribute('data-extra-h-row', '1');
        his.appendChild(line);
      });
      panel.appendChild(his);
      box.appendChild(panel);
    }
  }

  function fmt(iso) {
    const t = Date.parse(String(iso || ''));
    if (!Number.isFinite(t)) return String(iso || '时间未记');
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  async function loadHistory() {
    const duck = api();
    if (!duck || !duck.workspaceHistory || !state.projectId) return;
    try {
      const res = await duck.workspaceHistory({ projectId: state.projectId, limit: 20 });
      state.history = res && Array.isArray(res.rows) ? res.rows : [];
    } catch { state.history = []; }
  }

  async function runClean(plan) {
    const duck = api();
    if (!duck || !duck.workspaceClean || state.busy) return;
    state.busy = true;
    state.error = '';
    state.notice = '';
    render();
    try {
      // 把界面这一份待移除清单一起传回：后端会重读团队集合，不一致就 WORKSPACE_CLEAN_CONFLICT 中止。
      const res = await duck.workspaceClean({
        projectId: state.projectId,
        by: 'pm',
        expect: (plan.extras || []).map((row) => row.sessionId),
        confirm: true
      });
      if (!res || res.ok === false) {
        const error = new Error((res && (res.message || res.code)) || '清理失败');
        error.code = String((res && res.code) || '');
        throw error;
      }
      state.notice = res.removedCount
        ? `已清理 ${res.removedCount} 个额外会话（保留 ${res.keptCount} 个；未删除任何 DSH 会话）`
        : '没有需要清理的绑定（removed: []），已记一条清理记录';
    } catch (error) {
      state.error = String((error && error.message) || error || '清理失败');
    } finally {
      state.busy = false;
    }
    await loadPlan();
    await loadHistory();
    render();
    // 让六角色会话块/团队行按新绑定重算（它们各自有自己的刷新入口，这里只触发一次状态刷新）。
    try {
      if (typeof window.refresh === 'function') window.refresh();
      else window.dispatchEvent(new CustomEvent('awb:refresh'));
    } catch { /* 刷新失败不影响清理结果 */ }
  }

  async function refresh() {
    const projectId = await activeProjectId();
    if (!projectId) { state.plan = null; render(); return; }
    if (projectId !== state.projectId) { state.projectId = projectId; state.panel = 'closed'; state.notice = ''; }
    await loadPlan();
    if (state.panel === 'open') await loadHistory();
    render();
  }

  function start() {
    refresh().catch(() => { /* 首次失败不阻塞界面 */ });
    if (state.timer) clearInterval(state.timer);
    // 5 秒跟其它面板同频：绑定被清理/换项目后数字要跟着变，不能停在旧值。
    state.timer = setInterval(() => { refresh().catch(() => { /* ignore */ }); }, 5000);
    window.addEventListener('focus', () => { refresh().catch(() => { /* ignore */ }); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // 供自检/调试读取：当前这一处显示的数字（唯一来源）
  window.__awbExtraSessions = () => ({
    projectId: state.projectId,
    extraCount: state.plan ? Number(state.plan.extraCount || 0) : null,
    extras: state.plan ? (state.plan.extras || []).map((row) => row.sessionId) : [],
    panel: state.panel,
    error: state.error,
    notice: state.notice
  });
  // 自检/其它面板要立即重读时用（不等 5 秒轮询）。
  window.__awbExtraRefresh = () => refresh();
}());
