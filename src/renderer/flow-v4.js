/* v4 流程面板（Owner 拍板）：顶部轮次 + 优先级列表 + 点开详情（卡点/冲突/验收人），详情可返回。
 * v56（T-20261113-232708 派单）：默认只显示未收口需求；已验收/终止/关闭（含迭代、驳回）
 * 收进「已收口 X 条」折叠行，点开才显示；已收口区按轮次分组（当前轮在前、往轮在后），
 * 不新增轮次筛选控件；两组都用 P0→P3、同级按更新时间的同一排序。
 * 用法：FlowV4.render(container, data)；data 由 app.js 从工作流构建。
 * 纯渲染，无网络/无存储；5 秒刷新由 app.js 的 renderFlow 重新调用 render（保留当前视图与折叠状态）。
 */
(function () {
  'use strict';
  var STAGES = ['需求', '评审', '开发', '测试', '验收', '迭代'];
  // 已收口口径与 app.js 的 legacyActiveRequirement 保持一致：验收/完成/终止/迭代/驳回都算收口，
  // 不再占用「未收口」列表；迭代（iteration）属本轮收口，下一轮以新需求重新进入。
  var CLOSED = ['accepted', 'done', 'terminated', 'iteration', 'rejected'];
  var stateMap = new WeakMap(); // container -> { view: 'list'|'detail', id, closedOpen }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function priCls(p) { return 'fv4-pri p-' + String(p || 'P2').toLowerCase(); }
  function isClosed(s) { return CLOSED.indexOf(String(s || '')) >= 0; }
  function statusCls(s) {
    if (s === '缺项' || s === 'rejected') return 'bad';
    if (s === '待验收' || s === 'test_done') return 'warn';
    if (s === 'accepted' || s === 'done') return 'ok';
    return 'muted';
  }
  function statusText(s) {
    var m = {
      review: '评审中', approved: '已通过', ready: '可派单', dispatched: '已派单', dev: '开发中',
      dev_review: '开发互审', dev_done: '开发完成', test: '测试中', test_done: '待验收',
      accepted: '已验收', done: '已完成', iteration: '迭代', rejected: '已驳回', terminated: '已终止'
    };
    return m[s] || s || '—';
  }
  function stageOf(s) {
    if (s === 'accepted' || s === 'done') return 4;
    if (s === 'iteration' || s === 'terminated') return 5;
    if (s === 'test' || s === 'test_done') return 3;
    if (s === 'dispatched' || s === 'dev' || s === 'dev_review' || s === 'dev_done') return 2;
    if (s === 'approved' || s === 'ready') return 2;
    return 1;
  }

  function rowHtml(it) {
    var st = stageOf(it.status);
    var closed = isClosed(it.status);
    var steps = STAGES.map(function (s, i) {
      var cls = i < st ? 'done' : i === st ? 'cur' : 'todo';
      return '<i class="fv4-seg ' + cls + '" title="' + s + '"></i>';
    }).join('');
    return '<button class="fv4-row' + (closed ? ' closed' : '') + '" type="button" data-id="' + esc(it.id) + '" data-status="' + esc(it.status) + '">'
      + '<span class="fv4-row-l"><span class="' + priCls(it.pri) + '">' + esc(it.pri || 'P2') + '</span>'
      + '<span class="fv4-id">' + esc(it.id) + '</span><span class="fv4-title">' + esc(it.title || it.name || '') + '</span></span>'
      + '<span class="fv4-row-r"><span class="fv4-bar">' + steps + '</span>'
      + '<span class="fv4-st ' + statusCls(it.status) + '" data-status="' + esc(it.status) + '">' + esc(it.statusText || statusText(it.status)) + '</span>'
      + (it.status === 'test_done'
        ? '<span class="fv4-goto" role="button" tabindex="0" data-action="goto-accept" title="去验收：打开顶部【验】的同一列表">去验收</span>'
        : '')
      + '<span class="fv4-who">' + esc(it.owner || '—') + '</span>'
      + (it.blocker ? '<span class="fv4-flag bad">卡点</span>' : '')
      + ((it.conflicts || []).length ? '<span class="fv4-flag warn">冲突</span>' : '')
      + '</span></button>';
  }

  /** 已收口区按轮次分组（PM 口径 A）：当前轮在前、往轮在后（轮次从新到旧）；
   * 组内仍按 app.js 排好的 P0→P3、同级更新时间顺序展示。 */
  function closedGroups(shut, curRound) {
    var groups = {};
    var order = [];
    shut.forEach(function (it) {
      var r = Number(it.round || curRound || 1);
      if (!groups[r]) { groups[r] = []; order.push(r); }
      groups[r].push(it);
    });
    order.sort(function (a, b) {
      if (a === curRound) return -1;
      if (b === curRound) return 1;
      return b - a;
    });
    return order.map(function (r) {
      return { round: r, items: groups[r], current: r === Number(curRound || 1) };
    });
  }

  function listHtml(data, st) {
    var items = data.items || [];
    var open = [];
    var shut = [];
    items.forEach(function (it) { (isClosed(it.status) ? shut : open).push(it); });
    var openN = data.open != null ? data.open : open.length;
    var shutN = data.closed != null ? data.closed : shut.length;
    var head = '<div class="fv4-head"><b>当前：第 ' + esc(data.round || 1) + ' 轮</b>'
      + '<span class="fv4-sub">共 ' + (data.total || items.length) + ' 条 · 未收口 ' + openN + ' · 已收口 ' + shutN + '</span>'
      + '<span class="fv4-agent">点需求看详情</span></div>';
    var parallel = (data.parallel || []).filter(function (p) { return p.on; });
    var pChips = parallel.length
      ? '<div class="fv4-par">' + parallel.map(function (p) { return '<span class="fv4-par-chip">' + esc(p.label) + ' 并行中</span>'; }).join('') + '</div>'
      : '';
    var rows = open.map(rowHtml).join('');
    var openHtml = rows || (items.length
      ? '<p class="fv4-empty">本轮没有未收口需求，' + shutN + ' 条都已收口</p>'
      : '<p class="fv4-empty">还没有需求</p>');
    var fold = '';
    if (shutN) {
      var on = !!st.closedOpen;
      fold = '<button class="fv4-fold" type="button" data-fold="1" aria-expanded="' + (on ? 'true' : 'false') + '">'
        + '<span class="fv4-fold-caret">' + (on ? '▾' : '▸') + '</span>已收口 ' + shutN + ' 条'
        + '<span class="fv4-fold-hint">' + (on ? '收起' : '展开') + '</span></button>';
      if (on) {
        var curRound = Number(data.round || 1);
        var groupHtml = closedGroups(shut, curRound).map(function (g) {
          var label = g.current ? ('第 ' + g.round + ' 轮 · ' + g.items.length + ' 条')
            : ('往轮（第 ' + g.round + ' 轮）· ' + g.items.length + ' 条');
          return '<div class="fv4-round-head">' + esc(label) + '</div>' + g.items.map(rowHtml).join('');
        }).join('');
        fold += '<div class="fv4-list fv4-list-closed">' + groupHtml + '</div>';
      }
    }
    return head + pChips + '<div class="fv4-list">' + openHtml + '</div>' + fold;
  }

  function detailHtml(data, id) {
    var it = (data.items || []).find(function (x) { return x.id === id; });
    if (!it) return '<p class="fv4-empty">找不到这条需求</p>';
    var st = STAGES[stageOf(it.status)] || '—';
    function field(k, v) { return '<div class="fv4-f"><dt>' + esc(k) + '</dt><dd>' + esc(v == null ? '—' : v) + '</dd></div>'; }
    var blocker = it.blocker
      ? '<section class="fv4-sect bad"><h3>卡点</h3><div class="fv4-kv"><b>原因</b><span>' + esc(it.blocker.reason || it.blocker) + '</span></div>'
        + (it.blocker.since ? '<div class="fv4-kv"><b>已阻塞</b><span>' + esc(it.blocker.since) + '</span></div>' : '')
        + (it.blocker.who ? '<div class="fv4-kv"><b>卡在</b><span>' + esc(it.blocker.who) + '</span></div>' : '') + '</section>'
      : '<section class="fv4-sect"><h3>卡点</h3><div class="fv4-kv"><b>—</b><span>无卡点</span></div></section>';
    var rel = [];
    (it.deps || []).forEach(function (d) { rel.push('<div class="fv4-kv"><b>依赖</b><span><code>' + esc(d.id) + '</code> ' + esc(d.name || '') + (d.reason ? ' · ' + esc(d.reason) : '') + '</span></div>'); });
    (it.conflicts || []).forEach(function (c) { rel.push('<div class="fv4-kv"><b>冲突</b><span><code>' + esc(c.id) + '</code> ' + esc(c.name || '') + (c.reason ? ' · ' + esc(c.reason) : '') + '</span></div>'); });
    var relHtml = '<section class="fv4-sect' + (rel.length ? ' warn' : '') + '"><h3>冲突 / 依赖</h3>'
      + (rel.length ? rel.join('') : '<div class="fv4-kv"><b>—</b><span>无（显式依赖 0 · 人工标注 0）</span></div>') + '</section>';

    return '<div class="fv4-dhead"><span class="' + priCls(it.pri) + '">' + esc(it.pri || 'P2') + '</span>'
      + '<span class="fv4-id">' + esc(it.id) + '</span><b class="fv4-dtitle">' + esc(it.title || it.name || '') + '</b>'
      + '<span class="fv4-st ' + statusCls(it.status) + '">' + esc(it.statusText || statusText(it.status)) + '</span>'
      + '<button class="fv4-back" type="button" data-back="1">← 返回</button></div>'
      + '<div class="fv4-fields">'
      + field('编号', it.id) + field('优先级', it.pri || 'P2') + field('负责人', it.owner || '—')
      + field('状态', it.statusText || statusText(it.status)) + field('当前阶段', st) + field('轮次', '第 ' + (it.round || data.round || 1) + ' 轮')
      + field('是否返工', it.iterationRound ? '是（第 ' + it.iterationRound + ' 次返工）' : '否')
      + field('验收人', it.acceptor || '—') + field('已耗时', it.elapsed || '—')
      + '</div>' + blocker + relHtml
      + '<div class="fv4-foot">详情为只读；点「← 返回」回列表，位置不变。</div>';
  }

  function bind(container, data) {
    container.querySelectorAll('[data-id]').forEach(function (btn) {
      if (btn.dataset.fv4Bound) return;
      btn.dataset.fv4Bound = '1';
      btn.addEventListener('click', function () {
        var st = stateMap.get(container) || { view: 'list', id: null, closedOpen: false };
        st.view = 'detail'; st.id = btn.dataset.id;
        stateMap.set(container, st);
        render(container, data);
      });
    });
    var fold = container.querySelector('[data-fold]');    if (fold && !fold.dataset.fv4Bound) {
      fold.dataset.fv4Bound = '1';
      fold.addEventListener('click', function () {
        var st = stateMap.get(container) || { view: 'list', id: null, closedOpen: false };
        st.closedOpen = !st.closedOpen;
        // 用户主动收起/展开即视为结束「从详情返回、需要定位原行」的锚点；
        // 否则 render 会因 st.id 指向已收口行而把刚收起的折叠区重新展开（实测踩到）。
        st.id = null;
        stateMap.set(container, st);
        render(container, data);
      });
    }
    var back = container.querySelector('[data-back]');
    if (back) back.addEventListener('click', function () {
      var st = stateMap.get(container) || { view: 'list', id: null, closedOpen: false };
      st.view = 'list';
      stateMap.set(container, st);
      render(container, data);
    });
    // R-4f99 F-1：流程图行只做「状态徽标 + 去验收跳转」，不出现任何提交按钮；
    // 跳转打开顶部【验】的同一个 #accept-list，动作只在那边发生。
    container.querySelectorAll('[data-action="goto-accept"]').forEach(function (node) {
      if (node.dataset.fv4GotoBound) return;
      node.dataset.fv4GotoBound = '1';
      function go(ev) {
        if (ev) { ev.preventDefault(); ev.stopPropagation(); }
        if (typeof window.__awbOpenAcceptList === 'function') window.__awbOpenAcceptList();
      }
      node.addEventListener('click', go);
      node.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') go(ev);
      });
    });
  }

  function render(container, data) {
    if (!container) return;
    var st = stateMap.get(container) || { view: 'list', id: null, closedOpen: false };
    if (st.view !== 'detail') st.view = 'list';
    // 返回列表时若目标行在收口区，自动展开，否则高亮找不到行（等于"返回后位置丢了"）。
    if (st.view === 'list' && st.id) {
      var target = (data.items || []).find(function (x) { return x.id === st.id; });
      if (target && isClosed(target.status)) st.closedOpen = true;
    }
    stateMap.set(container, st);
    container.classList.add('fv4');
    container.innerHTML = st.view === 'detail' ? detailHtml(data, st.id) : listHtml(data, st);
    bind(container, data);
    if (st.view === 'list' && st.id) {
      var row = container.querySelector('[data-id="' + st.id + '"]');
      if (row) { row.classList.add('flash'); setTimeout(function () { row.classList.remove('flash'); }, 1800); }
    }
  }

  window.FlowV4 = { render: render, STAGES: STAGES, stageOf: stageOf, statusText: statusText, isClosed: isClosed, CLOSED: CLOSED };
})();
