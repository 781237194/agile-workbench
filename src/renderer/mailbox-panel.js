/* R-c4c7（T-20261115-195024-5369）· 团队收件箱实时面板（渲染层）
 *
 * 零轮询：只有
 *   ①面板首次打开 → 一次 mailbox:snapshot（一次性 IPC）
 *   ②主进程 fs.watch 去抖后推来的 mailbox:changed → 直接用推送里的快照渲染
 *   ③窗口重新聚焦且距上次事件 >10s → 允许再拉**一次**快照（计入 refocusReads，面板上可见）
 * 绝无 setInterval / 周期 setTimeout。
 *
 * 只读：没有任何写操作、没有 ack/read 按钮（口径「不含 DSH 运行时队列」写在面板里）。
 */
(function () {
  'use strict';
  var REFOCUS_MS = 10000;
  var state = {
    open: false,
    snapshot: null,
    lastEventAt: 0,
    refocusReads: 0,
    snapshotReads: 0,
    changedEvents: 0,
    subscribed: false,
    lastSource: '',
    error: '',
  };

  function api() {
    var w = (typeof window !== 'undefined' && window.workbench) ? window.workbench : null;
    return w || {};
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function panelEl() { return document.querySelector('#mailbox-panel'); }
  function entryEl() { return document.querySelector('#btn-mailbox'); }
  function fmtClock(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    return m ? (m[4] + ':' + m[5] + ':' + m[6]) : '—';
  }
  function fmtMailItem(item) {
    if (!item) return '';
    var who = item.from ? ('来自 ' + item.from) : '来自 —';
    var subject = String(item.subject || '').slice(0, 40);
    return fmtClock(item.at) + ' ' + who + ' · ' + subject;
  }
  function fmtQueueItem(item) {
    if (!item) return '';
    return [item.priority, item.action, item.taskId].filter(Boolean).join(' · ');
  }

  function panelQuery(selector) {
    var panel = document.querySelector('#mailbox-panel');
    return panel ? panel.querySelector(selector) : null;
  }
  function setText(selector, text) {
    var node = panelQuery(selector);
    if (node) node.textContent = String(text);
  }

  function renderDegraded(snapshot) {
    var bar = panelQuery('[data-mailbox-degraded]');
    if (!bar) return;
    var degraded = Boolean(snapshot && snapshot.degraded);
    bar.hidden = !degraded;
    if (!degraded) { bar.textContent = ''; return; }
    var interval = Math.round((Number(snapshot.fallbackMs) || 30000) / 1000);
    var lastOk = snapshot.lastSuccessAt ? fmtClock(snapshot.lastSuccessAt) : '—';
    var reason = String(snapshot.degradedReason || snapshot.lastError || '').slice(0, 80);
    bar.textContent = '实时更新不可用，已降级为 ' + interval + ' 秒兜底（第 '
      + (Number(snapshot.degradedCount) || 0) + ' 次）｜最近成功 ' + lastOk + (reason ? '｜原因 ' + reason : '');
  }

  function renderRows(snapshot) {
    var host = panelQuery('[data-mailbox-rows]');
    if (!host) return;
    host.textContent = '';
    var roles = (snapshot && snapshot.roles) || {};
    var order = Object.keys(roles);
    for (var i = 0; i < order.length; i += 1) {
      var roleId = order[i];
      var row = roles[roleId] || {};
      var wrap = el('div', 'mailbox-row');
      wrap.setAttribute('data-mailbox-row', '1');
      wrap.setAttribute('data-role', roleId);
      if (row.dirMissing) wrap.setAttribute('data-mailbox-dir-missing', '1');
      var head = el('div', 'mailbox-row-head');
      head.appendChild(el('b', 'mailbox-role', row.roleName || roleId));
      var counts = el('span', 'mailbox-counts');
      counts.appendChild(el('span', '', '邮件 '));
      var mailCount = el('b', '', row.dirMissing ? '—' : String(Number(row.mailNew) || 0));
      mailCount.setAttribute('data-mailbox-mail-count', '1');
      counts.appendChild(mailCount);
      counts.appendChild(el('span', '', ' · 队列 '));
      var queueCount = el('b', '', String(Number(row.queuePending) || 0));
      queueCount.setAttribute('data-mailbox-queue-count', '1');
      counts.appendChild(queueCount);
      head.appendChild(counts);
      wrap.appendChild(head);

      var latest = el('div', 'mailbox-latest');
      latest.setAttribute('data-mailbox-latest', '1');
      // 邮件最新 3 条（只显示 ts/from/subject；不显示 body）
      for (var m = 0; m < (row.mailLatest || []).length; m += 1) {
        latest.appendChild(el('div', 'mailbox-latest-item', fmtMailItem(row.mailLatest[m])));
      }
      // 任务队列最新 3 条
      for (var q = 0; q < (row.queueLatest || []).length; q += 1) {
        latest.appendChild(el('div', 'mailbox-latest-item mailbox-latest-queue', fmtQueueItem(row.queueLatest[q])));
      }
      if (!latest.childNodes.length) latest.appendChild(el('div', 'mailbox-latest-empty', row.dirMissing ? '目录不存在（—）' : '暂无'));
      wrap.appendChild(latest);
      if (row.dirMissing) wrap.title = '该角色邮箱 new 目录不存在（还没有邮件目录）';
      host.appendChild(wrap);
    }
  }

  function render(snapshot) {
    if (!snapshot) return;
    state.snapshot = snapshot;
    var total = panelQuery('[data-mailbox-total]');
    if (total) {
      total.textContent = String(Number(snapshot.total) || 0);
      total.title = '邮件 ' + (snapshot.totals ? snapshot.totals.mail : '—') + ' + 任务队列 ' + (snapshot.totals ? snapshot.totals.queue : '—');
    }
    var busiest = panelQuery('[data-mailbox-busiest]');
    if (busiest) {
      busiest.textContent = snapshot.busiestRole
        ? (snapshot.busiestRole.roleName + ' ' + snapshot.busiestRole.count)
        : '无积压';
    }
    setText('[data-mailbox-updated-at]', fmtClock(snapshot.at));
    renderDegraded(snapshot);
    renderRows(snapshot);
    updateEntry(snapshot);
    updateRefocusNote();
  }

  function updateEntry(snapshot) {
    var entry = entryEl();
    if (!entry) return;
    var value = snapshot ? String(Number(snapshot.total) || 0) : '—';
    entry.textContent = '收件箱 ' + value;
    // 入口按钮只挂自己的锚点：`data-mailbox-total` 是面板内的唯一锚点，挂在按钮上会让全局选择器先命中按钮
    if (snapshot) entry.setAttribute('data-mailbox-entry-total', value);
    else entry.removeAttribute('data-mailbox-entry-total');
  }

  function updateRefocusNote() {
    var note = panelQuery('[data-mailbox-refocus-note]');
    if (!note) return;
    if (!state.refocusReads) { note.hidden = true; note.textContent = ''; return; }
    note.hidden = false;
    note.textContent = '（重新聚焦补读 ' + state.refocusReads + ' 次）';
  }

  function readOnce(reason) {
    var w = api();
    if (typeof w.mailboxSnapshot !== 'function') {
      state.error = '当前版本没有收件箱接口';
      showError();
      return Promise.resolve(null);
    }
    state.snapshotReads += 1;
    return w.mailboxSnapshot({}).then(function (result) {
      var res = result || {};
      if (!res.ok || !res.snapshot) {
        state.error = String(res.message || res.code || '收件箱快照读取失败');
        showError();
        return null;
      }
      state.error = '';
      hideError();
      state.lastSource = String(res.snapshot.source || reason || 'snapshot');
      if (reason === 'refocus') state.refocusReads += 1;
      render(res.snapshot);
      return res.snapshot;
    }).catch(function (error) {
      state.error = String((error && error.message) || error).slice(0, 160);
      showError();
      return null;
    });
  }

  function showError() {
    var box = document.querySelector('[data-mailbox-error]');
    if (!box) return;
    box.hidden = false;
    box.textContent = state.error;
  }
  function hideError() {
    var box = document.querySelector('[data-mailbox-error]');
    if (!box) return;
    box.hidden = true;
    box.textContent = '';
  }

  function subscribe() {
    if (state.subscribed) return;
    var w = api();
    if (typeof w.onMailboxChanged !== 'function') return;
    w.onMailboxChanged(function (snapshot) {
      state.changedEvents += 1;
      state.lastEventAt = Date.now();
      state.lastSource = String((snapshot && snapshot.source) || 'watch');
      if (snapshot) render(snapshot);
    });
    state.subscribed = true;
  }

  function startWatch() {
    var w = api();
    if (typeof w.mailboxWatchStart === 'function') {
      try { w.mailboxWatchStart({}); } catch (error) { /* 主进程会自己兜底 */ }
    }
  }

  function open() {
    var panel = panelEl();
    if (!panel) return;
    panel.hidden = false;
    state.open = true;
    var entry = entryEl();
    if (entry) entry.setAttribute('aria-expanded', 'true');
    subscribe();
    startWatch();
    // 首屏只读一次；之后全靠推送
    readOnce('initial').then(function (snapshot) {
      if (snapshot) state.lastEventAt = Date.now();
    });
  }

  function close() {
    var panel = panelEl();
    if (!panel) return;
    panel.hidden = true;
    state.open = false;
    var entry = entryEl();
    if (entry) entry.setAttribute('aria-expanded', 'false');
  }

  function toggle() {
    if (state.open) close(); else open();
  }

  function onFocus() {
    if (!state.open) return;
    // 只在「距上次事件 >10s」时补读一次（防窗口长时间失焦后停在旧数字），并计数可见
    if (!state.lastEventAt || (Date.now() - state.lastEventAt) > REFOCUS_MS) readOnce('refocus');
  }

  function main() {
    var entry = entryEl();
    if (entry) {
      entry.addEventListener('click', function (event) {
        event.preventDefault();
        toggle();
      });
      entry.setAttribute('aria-expanded', 'false');
    }
    var closeBtn = document.querySelector('#mailbox-close');
    if (closeBtn) closeBtn.addEventListener('click', close);
    var refreshBtn = document.querySelector('#mailbox-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        // 手动刷新＝用户显式动作，一次性快照（不是轮询）
        readOnce('manual');
      });
    }
    window.addEventListener('focus', onFocus);
    // 供自动化/排障读取（只读计数，不含任何写操作）
    window.__mailboxProbe = function () {
      return {
        open: state.open,
        snapshotReads: state.snapshotReads,
        changedEvents: state.changedEvents,
        refocusReads: state.refocusReads,
        lastEventAt: state.lastEventAt,
        lastSource: state.lastSource,
        degraded: Boolean(state.snapshot && state.snapshot.degraded),
        degradedCount: state.snapshot ? Number(state.snapshot.degradedCount) || 0 : 0,
        total: state.snapshot ? state.snapshot.total : null,
        at: state.snapshot ? state.snapshot.at : '',
        error: state.error,
      };
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
  else main();

  window.MailboxPanel = { open: open, close: close, toggle: toggle, render: render, probe: function () { return window.__mailboxProbe(); } };
})();
