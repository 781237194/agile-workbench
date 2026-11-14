/* 节点式全量状态图 · v2（R-db98 返工：星形/放射性 + 并行分支）——纯字符串渲染，无 DOM 依赖。
 * 数据：flow-lanes.js 的 lanes（每条需求当前 phase）+ 工作流行（trq/ownerReview 用于缺项红标）。
 * 布局：中心「本轮/当前阶段」向四周放射 9 个阶段节点；两条并行通道（评审∥开发、测试∥下一轮收集）
 * 各带分叉/汇合点与条件标注；状态色沿用：绿=已过、金=在此、灰=未到、红=缺项。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FlowGraph = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const NODES = [
    { key: 'requirement', label: '需求', hint: '建单/正文', short: '正文/边界齐' },
    { key: 'review', label: '产品评审', hint: '正文+边界', short: '评审通过' },
    { key: 'trq', label: '可测性', hint: 'TR-Q', short: 'TR-Q testable' },
    { key: 'owner', label: 'Owner', hint: '决定落账', short: 'Owner 批准' },
    { key: 'dispatch', label: 'PM派单', hint: '锁+回执', short: '派单/认领' },
    { key: 'dev', label: '开发', hint: '实现/互审', short: '开发完成' },
    { key: 'test', label: '测试', hint: '报告 PASS/FAIL', short: '报告 PASS' },
    { key: 'accept', label: '验收', hint: 'Owner/PM', short: '验收通过' },
    { key: 'closure', label: '迭代/终止', hint: '轮次收口', short: '整轮通过 +1 轮' },
  ];
  // v2 星形布局：中心 (380,260)，9 节点沿椭圆放射（每 40°）。
  const VIEW = { w: 760, h: 520, cx: 380, cy: 260, rx: 262, ry: 182 };
  const ANGLES = [-90, -50, -10, 30, 70, 110, 150, 190, 230];
  const STAGE = {
    idle: 0, requirement: 0,
    requirement_review: 1, product_review: 1, rejected: 1,
    tech_review: 2,
    owner_review: 3,
    dispatch: 4,
    dev: 5, dispatched: 5, dev_done: 5, dev_review: 5,
    test: 6, test_done: 6,
    owner_accept: 7, accepted: 7,
    iteration: 8, terminated: 8,
  };
  const stageOf = (phase) => (STAGE[String(phase || '')] !== undefined ? STAGE[String(phase || '')] : 0);

  /** 节点状态：done/current/todo/missing（与 v1 同口径，便于回归）。 */
  function computeNodes(lanes, wf) {
    const list = Array.isArray(lanes) ? lanes : [];
    const rows = Array.isArray(wf && wf.requirements) ? wf.requirements : [];
    return NODES.map((def, i) => {
      let done = 0; let current = 0; let todo = 0;
      for (const lane of list) {
        const idx = stageOf(lane.phase);
        if (idx > i) done += 1;
        else if (idx === i) current += 1;
        else todo += 1;
      }
      let status = 'todo';
      if (current > 0) status = 'current';
      else if (done > 0) status = 'done';
      const missing = [];
      if (def.key === 'trq') {
        const bad = rows.filter((row) => row && row.trq && String(row.trq.verdict) === 'not_testable');
        if (bad.length) missing.push(`TR-Q 不可测 ${bad.length}`);
      }
      if (def.key === 'owner') {
        const pending = rows.filter((row) => {
          const review = row && row.ownerReview && typeof row.ownerReview === 'object' ? row.ownerReview : null;
          const decisions = Array.isArray(row && row.decisions) ? row.decisions : [];
          return String((row && row.status) || '') === 'approved' && !decisions.length
            && !(review && ['approved', 'skipped', 'rejected'].includes(String(review.status || '')));
        });
        if (pending.length) missing.push(`待 Owner 决定 ${pending.length}`);
      }
      if (missing.length) status = 'missing';
      return {
        ...def, index: i, done, current, todo, status, missing,
        count: `过 ${done} · 在 ${current} · 未 ${todo}`,
      };
    });
  }

  /** 环边状态：两端都已过 → done；起点在此/缺项 → active；否则 pending。 */
  function edgeStatus(nodes, i) {
    const from = nodes[i];
    const to = nodes[i + 1];
    if (from.status === 'done' && to && to.status === 'done') return 'done';
    if (from.status === 'current' || from.status === 'missing') return 'active';
    return 'pending';
  }

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function pointAt(deg, rx = VIEW.rx, ry = VIEW.ry) {
    const a = (deg * Math.PI) / 180;
    return { x: VIEW.cx + rx * Math.cos(a), y: VIEW.cy + ry * Math.sin(a) };
  }
  const fmt = (p) => `${Math.round(p.x * 10) / 10} ${Math.round(p.y * 10) / 10}`;

  /** 环边：从 a 到 b，控制点沿径向向外推 bulge，形成“放射弧”。 */
  function ringPath(a, b, bulge = 26) {
    const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
    const dx = mx - VIEW.cx; const dy = my - VIEW.cy;
    const len = Math.hypot(dx, dy) || 1;
    const cx = mx + (dx / len) * bulge; const cy = my + (dy / len) * bulge;
    return `M ${fmt(a)} Q ${cx} ${cy} ${fmt(b)}`;
  }
  function ringLabelPoint(a, b, bulge = 26, out = 16) {
    const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
    const dx = mx - VIEW.cx; const dy = my - VIEW.cy;
    const len = Math.hypot(dx, dy) || 1;
    const cx = mx + (dx / len) * bulge; const cy = my + (dy / len) * bulge;
    // 二次曲线中点 + 径向外移
    const px = 0.25 * a.x + 0.5 * cx + 0.25 * b.x;
    const py = 0.25 * a.y + 0.5 * cy + 0.25 * b.y;
    return { x: px + (dx / len) * out, y: py + (dy / len) * out };
  }

  /** 外圈并行通道：沿更大的椭圆顺时针采样，形成包住环的弧。 */
  function outerArcPath(fromDeg, toDeg, rx = 356, ry = 276) {
    let a = fromDeg; let b = toDeg;
    while (b <= a) b += 360;
    const steps = Math.max(4, Math.round((b - a) / 14));
    const pts = [];
    for (let i = 0; i <= steps; i += 1) pts.push(pointAt(a + ((b - a) * i) / steps, rx, ry));
    return `M ${pts.map(fmt).join(' L ')}`;
  }
  function outerMid(fromDeg, toDeg, rx = 356, ry = 276) {
    let a = fromDeg; let b = toDeg;
    while (b <= a) b += 360;
    return pointAt((a + b) / 2, rx, ry);
  }

  /** 并行通道：两条真实并行维度 + 分叉/汇合点 + 条件标注。 */
  function parallels(nodes) {
    const byKey = Object.fromEntries(nodes.map((n) => [n.key, n]));
    const liveA = byKey.review.current > 0 && byKey.dev.current > 0;
    const liveB = byKey.test.current > 0 && (byKey.requirement.current + byKey.review.current) > 0;
    return {
      reviewDev: {
        key: 'review-dev', live: liveA,
        from: ANGLES[1], to: ANGLES[5],
        title: '并行①',
        detail: '',
        fork: '分叉：上一轮开发未收口时，下一轮评审并行',
      },
      testCollect: {
        key: 'test-collect', live: liveB,
        from: ANGLES[6], to: ANGLES[0] + 360,
        title: '并行②',
        detail: '',
        fork: '分叉：测试跑的同时收下一轮需求',
      },
    };
  }

  /** 主渲染：星形/放射性 + 并行通道 + 汇合点 + 条件标注。 */
  function markup(lanes, wf, summary) {
    const nodes = computeNodes(lanes, wf);
    const pts = ANGLES.map((deg) => pointAt(deg));
    const par = parallels(nodes);
    const summaryText = summary && summary.text ? summary.text : '暂无进行中的需求';
    const round = Number((wf && wf.round) || 1);
    const phaseLabel = summaryText.split('·')[0].trim() || '进行中';
    const centerCurrent = nodes.filter((n) => n.current > 0).map((n) => `${n.label} ${n.current}`);
    const concurrentStages = nodes.filter((n) => n.current > 0).length;
    const centerText = centerCurrent.length
      ? centerCurrent.slice(0, 3).join(' · ') + (centerCurrent.length > 3 ? ` 等 ${centerCurrent.length} 阶段` : '')
      : '暂无在办';

    const edgeLabels = NODES.map((n) => n.short);
    let edges = '';
    let labels = '';
    for (let i = 0; i < nodes.length - 1; i += 1) {
      const cls = edgeStatus(nodes, i);
      edges += `<path class="fs-edge ${cls}" data-fg-edge="${esc(nodes[i].key)}>${esc(nodes[i + 1].key)}" d="${ringPath(pts[i], pts[i + 1])}" marker-end="url(#fs-arrow-${cls})"></path>`;
      const lp = ringLabelPoint(pts[i], pts[i + 1], 26, 18);
      labels += `<text class="fs-edge-label ${cls}" data-fg-edge-label="${esc(nodes[i].key)}>${esc(nodes[i + 1].key)}" x="${fmt(lp).split(' ')[0]}" y="${fmt(lp).split(' ')[1]}">${esc(edgeLabels[i])}</text>`;
    }

    // 汇合点：开发→测试 汇合①；迭代→需求（轮次门）汇合②
    const m1 = ringLabelPoint(pts[5], pts[6], 26, -18);
    const m2 = { x: (pts[8].x + pts[0].x) / 2, y: (pts[8].y + pts[0].y) / 2 };
    const merges = `
      <g class="fs-merge" data-fg-merge="dev>test" transform="translate(${fmt(m1).split(' ')[0]},${fmt(m1).split(' ')[1]})">
        <rect x="-7" y="-7" width="14" height="14" transform="rotate(45)"></rect><text y="-12">汇合①</text>
      </g>
      <g class="fs-merge" data-fg-merge="closure>requirement" transform="translate(${fmt(m2).split(' ')[0]},${fmt(m2).split(' ')[1]})">
        <rect x="-7" y="-7" width="14" height="14" transform="rotate(45)"></rect><text y="-12">汇合②</text>
      </g>`;

    const parSvg = Object.values(par).map((p) => {
      const d = outerArcPath(p.from, p.to);
      const mid = outerMid(p.from, p.to);
      const start = pointAt(p.from, 356, 276);
      return `<g class="fs-parallel ${p.live ? 'live' : 'dim'}" data-fg-parallel="${esc(p.key)}" data-parallel-live="${p.live ? '1' : '0'}">
        <path class="fs-parallel-path" d="${d}"></path>
        <text class="fs-parallel-title" x="${fmt(mid).split(' ')[0]}" y="${fmt(mid).split(' ')[1]}">${esc(p.title)}${p.live ? ' · 并行中' : ''}</text>
        ${p.detail ? `<text class="fs-parallel-detail" x="${fmt(mid).split(' ')[0]}" y="${Number(fmt(mid).split(' ')[1]) + 14}">${esc(p.detail)}</text>` : ''}
        <text class="fs-fork" x="${fmt(start).split(' ')[0]}" y="${Number(fmt(start).split(' ')[1]) - 8}">${esc(p.fork)}</text>
      </g>`;
    }).join('');

    const legend = `<div class="fs-legend">
      <span class="fs-legend-item" data-fg-legend="parallel-review-dev"><b>并行① 评审 ∥ 开发</b>：分叉条件=上一轮开发未收口时下一轮评审并行；汇合①=开发完成+评审通过 → 测试</span>
      <span class="fs-legend-item" data-fg-legend="parallel-test-collect"><b>并行② 测试 ∥ 下一轮收集</b>：分叉条件=测试跑的同时收下一轮需求；汇合②=测试结果+收集齐 → 轮次门（迭代/终止）</span>
    </div>`;
    const nodeHtml = nodes.map((node, i) => {
      const p = pts[i];
      const miss = node.missing.length
        ? `<em class="fg-miss" data-fg-missing="${esc(node.key)}">缺项：${esc(node.missing.join('、'))}</em>`
        : '';
      return `<div class="fs-node ${node.status}" data-fg-node="${esc(node.key)}" data-fg-status="${node.status}" style="left:${((p.x / VIEW.w) * 100).toFixed(2)}%;top:${((p.y / VIEW.h) * 100).toFixed(2)}%" title="${esc(`${node.label}｜${node.hint}｜${node.count}`)}">
        <i class="fg-dot"></i><b class="fg-label">${esc(node.label)}</b><span class="fg-count">${esc(node.count)}</span>${miss}
      </div>`;
    }).join('');

    return `<div class="flow-star" data-flow-star="1" data-node-count="9" data-parallel-count="2">
      <div class="fs-head">
        <span class="fs-eyebrow">STAR FLOW · 星形/并行全量状态图</span>
        <b class="fs-summary" data-flow-graph-summary>${esc(summaryText)}</b>
        <span class="fs-note">9 节点 · 2 并行通道 · 2 汇合点 · 5 秒刷新 · 绿=已过 金=在此 灰=未到 红=缺项</span>
      </div>
      <div class="fs-stage">
        <svg class="fs-edges" viewBox="0 0 ${VIEW.w} ${VIEW.h}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          <defs>
            ${['done', 'active', 'pending'].map((s) => `<marker id="fs-arrow-${s}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 z" class="fs-arrow ${s}"></path></marker>`).join('')}
          </defs>
          <g class="fs-ring">${edges}${labels}</g>
          <g class="fs-parallels">${parSvg}</g>
          <g class="fs-merges">${merges}</g>
        </svg>
        <div class="fs-center" data-fg-center data-fg-current="${esc(nodes.filter((n) => n.current > 0).map((n) => n.key).join(','))}" data-fg-concurrency="${concurrentStages}">
          <span class="fs-center-eyebrow">本轮 · 第 ${round} 轮</span>
          <b class="fs-center-title">当前阶段</b>
          <span class="fs-center-detail">${esc(centerText)}</span>
          <span class="fs-center-concurrency" data-fg-concurrency-text>并发 ${concurrentStages} 阶段有在办</span>
        </div>
        ${nodeHtml}
      </div>
      ${legend}
    </div>`;
  }

  return { NODES, STAGE, stageOf, computeNodes, edgeStatus, parallelSpec: parallels, markup };
});
