/* 并行泳道纯逻辑（R-cbbd）——无 DOM 依赖，可被 node 单测 require。
 * 浏览器：<script src="flow-lanes.js"></script> 必须先于 app.js，挂到 window.FlowLanes。
 * 数据只来自 工作流.json 需求行 + 任务；不读 phase 单值当展示真相。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FlowLanes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // AC19.2：15 phase → 汇总桶固定映射。新增/改名 phase 必须同步本表，未映射的单列，不猜。
  const BUCKETS = [
    { key: 'requirement', label: '需求', phases: ['requirement'] },
    { key: 'review', label: '评审', phases: ['requirement_review', 'product_review', 'dev_review', 'iteration'] },
    { key: 'owner', label: 'Owner', phases: ['owner_review'] },
    { key: 'tech', label: '技术', phases: ['tech_review'] },
    { key: 'dev', label: '开发', phases: ['dispatch', 'dev', 'dev_done'] },
    { key: 'test', label: '测试', phases: ['test', 'test_done'] },
    { key: 'accept', label: '验收', phases: ['owner_accept', 'accepted'] },
    { key: 'idle', label: '未开始', phases: ['idle'], inactive: true },
    { key: 'terminated', label: '终止', phases: ['terminated'], inactive: true },
  ];
  const PHASE_TO_BUCKET = (function () {
    const map = {};
    for (const bucket of BUCKETS) for (const phase of bucket.phases) map[phase] = bucket.key;
    return map;
  })();
  // 泳道内七步轨道：只做“走到哪”的定位，不复制旧流程图节点语义。
  const TRACK = ['需求', '评审', 'Owner', '技术', '开发', '测试', '验收'];
  const STAGE_OF_PHASE = {
    requirement: 0,
    requirement_review: 1, product_review: 1, dev_review: 1, iteration: 1,
    owner_review: 2,
    tech_review: 3,
    dispatch: 4, dev: 4, dev_done: 4,
    test: 5, test_done: 5,
    owner_accept: 6, accepted: 6,
    terminated: 7, idle: -1,
  };
  const STATUS_PHASE = {
    review: 'requirement_review', approved: 'owner_review', ready: 'dispatch', dispatch: 'dispatch',
    tech_review: 'tech_review', dev: 'dev', dispatched: 'dev', dev_done: 'dev_done',
    dev_review: 'dev_review', test: 'test', test_done: 'owner_accept',
    accepted: 'accepted', iteration: 'iteration', terminated: 'terminated',
    rejected: 'requirement_review',
  };
  // 与 app.js 的 FLOW_PHASE_RANK 同序：只用于“只前进不回退”。
  const PHASE_RANK = {
    idle: 0, requirement: 1, requirement_review: 2, owner_review: 3, tech_review: 4,
    dispatch: 5, dev: 6, dev_done: 7, dev_review: 8, test: 9, test_done: 10,
    owner_accept: 11, accepted: 12, iteration: 13, terminated: 14,
  };
  const rank = (phase) => (PHASE_RANK[String(phase || '')] !== undefined ? PHASE_RANK[String(phase)] : 0);

  /** 单需求阶段：需求行状态 + 任务证据，只前进不回退；rejected/terminated/iteration 是合法回退/终态。 */
  function lanePhase(row, kidTasks) {
    const status = String((row && row.status) || '');
    const kids = Array.isArray(kidTasks) ? kidTasks : [];
    if (status === 'terminated') return 'terminated';
    if (status === 'iteration') return 'iteration';
    if (status === 'rejected') return 'requirement_review';
    let phase = STATUS_PHASE[status] || 'requirement';
    const open = kids.filter((task) => String(task.status || '') !== 'done');
    const hasTester = kids.some((task) => String(task.owner || '') === 'tester');
    const hasDev = kids.some((task) => ['programmer1', 'programmer2'].includes(String(task.owner || '')));
    if (kids.length && !open.length) {
      if (hasTester) phase = rank(phase) > rank('owner_accept') ? phase : 'owner_accept';
      else if (hasDev) phase = rank(phase) > rank('dev_done') ? phase : 'dev_done';
    } else if (open.length) {
      if (open.some((task) => String(task.owner || '') === 'tester')) phase = rank(phase) > rank('test') ? phase : 'test';
      else if (open.some((task) => ['programmer1', 'programmer2'].includes(String(task.owner || '')))) phase = rank(phase) > rank('dev') ? phase : 'dev';
      else if (open.some((task) => ['product', 'analyst'].includes(String(task.owner || '')))) phase = rank(phase) > rank('requirement_review') ? phase : 'requirement_review';
    }
    return phase;
  }

  /** 泳道数据：需求行按 id 去重、任务按 requirementId 归属；无需求行降级单泳道并标 legacy。 */
  function rows(wf, project, fallbackPhase) {
    const state = wf && typeof wf === 'object' ? wf : {};
    const requirements = Array.isArray(state.requirements) ? state.requirements : [];
    const tasks = Array.isArray(state.tasks) ? state.tasks : [];
    const lanes = [];
    const seen = new Set();
    for (const row of requirements) {
      const id = String((row && row.id) || '').trim();
      if (!id || seen.has(id)) continue; // 同一需求两条泳道 → 按 id 合并
      seen.add(id);
      const kids = tasks.filter((task) => task && task.type !== 'requirement' && String(task.requirementId || '') === id);
      const done = kids.filter((task) => String(task.status || '') === 'done').length;
      const phase = lanePhase(row, kids);
      const updatedAt = String((row && row.updatedAt) || '');
      lanes.push({
        id,
        title: String((row && row.title) || id),
        phase,
        bucket: PHASE_TO_BUCKET[phase] || 'unmapped',
        status: String((row && row.status) || ''),
        priority: String((row && row.priority) || ''),
        done,
        total: kids.length,
        updatedAt,
        tasks: kids,
        legacy: false,
        key: `${id}|${phase}|${done}/${kids.length}|${updatedAt}`,
      });
    }
    if (!lanes.length) {
      const phase = String(fallbackPhase || state.phase || 'idle');
      const done = tasks.filter((task) => String(task.status || '') === 'done').length;
      lanes.push({
        id: '__legacy__',
        title: `${(project && project.name) || '当前项目'}（旧数据）`,
        phase,
        bucket: PHASE_TO_BUCKET[phase] || 'idle',
        status: '', priority: '', done, total: tasks.length,
        updatedAt: String(state.updatedAt || ''), tasks, legacy: true,
        key: `__legacy__|${phase}|${done}/${tasks.length}|${state.updatedAt || ''}`,
      });
    }
    return lanes;
  }

  /** 冲突：同一角色在 ≥2 条泳道都有未闭环任务 → 提示“跨泳道并行”，不阻断。 */
  function conflicts(lanes) {
    const byOwner = new Map();
    for (const lane of Array.isArray(lanes) ? lanes : []) {
      for (const task of lane.tasks || []) {
        if (String(task.status || '') === 'done') continue;
        const owner = String(task.owner || '');
        if (!owner) continue;
        if (!byOwner.has(owner)) byOwner.set(owner, new Set());
        byOwner.get(owner).add(lane.id);
      }
    }
    const out = {};
    for (const [owner, laneIds] of byOwner) if (laneIds.size > 1) out[owner] = [...laneIds];
    return out;
  }

  /** 项目级并行汇总：按需求当前阶段计数（每条只计 1 次；0 项不显示；终止/未开始单列）。
   * 展示顺序：验收桶置顶（Owner 最关心“有东西等我验收”），其余按流程顺序（AC19.2/19.8 示例）。 */
  function summary(lanes) {
    const counts = {};
    for (const lane of Array.isArray(lanes) ? lanes : []) counts[lane.bucket] = (counts[lane.bucket] || 0) + 1;
    const labelOf = (key) => {
      const bucket = BUCKETS.find((b) => b.key === key);
      return bucket ? bucket.label : '未映射';
    };
    const flowOrder = BUCKETS.filter((b) => !b.inactive && b.key !== 'accept').map((b) => b.key);
    const order = ['accept', ...flowOrder];
    const active = order.filter((key) => counts[key]).map((key) => `${labelOf(key)} ${counts[key]}`);
    const inactive = BUCKETS.filter((b) => b.inactive && counts[b.key]).map((b) => `${b.label} ${counts[b.key]}`);
    if (counts.unmapped) active.push(`未映射 ${counts.unmapped}`);
    return { text: active.join(' · ') || '暂无进行中的需求', inactive: inactive.join(' · '), counts };
  }

  // ---------- 渲染（纯字符串，不碰 DOM；app.js 与截图预览共用同一份标注） ----------
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const ROLE_NAMES = {
    pm: '项目经理', product: '产品设计师', analyst: '需求分析师',
    programmer1: '高级程序员 A', programmer2: '高级程序员 B', tester: '测试人员', owner: 'Owner',
  };
  const PHASE_LABEL = {
    idle: '未开始', requirement: '需求', requirement_review: '需求评审', product_review: '需求评审',
    owner_review: 'Owner 闸门', tech_review: '技术评审', dispatch: '待派单', dev: '开发中',
    dev_done: '开发完成', dev_review: '互审', test: '测试中', test_done: '测试完成',
    owner_accept: '待 Owner 验收', accepted: '已验收', iteration: '下一轮', terminated: '已终止',
  };
  const bucketLabel = (key) => {
    const bucket = BUCKETS.find((b) => b.key === key);
    return bucket ? bucket.label : '未映射';
  };

  /** 泳道内部（会随签名变化被替换的部分）。 */
  function innerMarkup(lane, conflictMap) {
    const stageIdx = STAGE_OF_PHASE[lane.phase] !== undefined ? STAGE_OF_PHASE[lane.phase] : -1;
    const track = TRACK.map((name, i) => {
      let cls = 'lane-step';
      if (lane.phase !== 'terminated' && stageIdx >= 0 && i < stageIdx) cls += ' done';
      else if (i === stageIdx) cls += ' current';
      return `<span class="${cls}" data-lane-step="${esc(name)}">${esc(name)}</span>`;
    }).join('');
    const conflictOwners = Object.entries(conflictMap || {})
      .filter(([, ids]) => ids.includes(lane.id))
      .map(([owner, ids]) => `${ROLE_NAMES[owner] || owner}（${ids.length} 条泳道）`);
    const conflictNote = conflictOwners.length
      ? `<span class="lane-conflict-note" data-lane-conflict="${esc(conflictOwners.join('、'))}">跨泳道并行：${esc(conflictOwners.join('、'))}</span>`
      : '';
    const legacyNote = lane.legacy ? '<span class="lane-legacy-note">旧数据仅汇总（无需求行）</span>' : '';
    return `<div class="flow-lane-track" data-lane-track>${track}</div>
    <div class="flow-lane-foot">
      <span class="lane-phase" data-lane-phase-label="${esc(lane.phase)}">${esc(PHASE_LABEL[lane.phase] || lane.phase)}</span>
      <span class="lane-stage-hint">${esc(bucketLabel(lane.bucket))}</span>
      <span class="lane-count">任务 ${lane.done}/${lane.total}</span>
      ${lane.status ? `<span class="lane-status">状态 ${esc(lane.status)}</span>` : ''}
      ${conflictNote}${legacyNote}
    </div>`;
  }

  /** 单条泳道（article 外壳保留，内部随签名替换；便于 MutationObserver 只观察变化泳道）。 */
  function markup(lane, conflictMap) {
    const conflict = Object.values(conflictMap || {}).some((ids) => ids.includes(lane.id));
    return `<article class="flow-lane${conflict ? ' conflict' : ''}" data-lane-id="${esc(lane.id)}" data-lane-key="${esc(lane.key)}" data-lane-phase="${esc(lane.phase)}" data-lane-bucket="${esc(lane.bucket)}">
    <header class="flow-lane-head">
      <span class="flow-lane-id">${esc(lane.id)}</span>
      <b class="flow-lane-title" title="${esc(lane.title)}">${esc(lane.title)}</b>
      <span class="flow-lane-badge">${esc(bucketLabel(lane.bucket))}</span>
    </header>
    <div class="flow-lane-inner">${innerMarkup(lane, conflictMap)}</div>
  </article>`;
  }

  /** 容器（头部汇总 + 全部泳道）：仅在泳道集合变化时整体重建。 */
  function containerMarkup(lanes, sum, conflictMap) {
    return `<div class="flow-lanes-head">
      <span class="flow-lanes-eyebrow">PARALLEL · 并行泳道</span>
      <b class="flow-lanes-summary" data-flow-lanes-summary>${esc(sum.text)}</b>
      <span class="flow-lanes-inactive" data-flow-lanes-inactive>${esc(sum.inactive)}</span>
      <span class="flow-lanes-note">每条需求一条泳道 · 只重绘变化泳道</span>
    </div>
    <div class="flow-lanes-body">${lanes.map((lane) => markup(lane, conflictMap)).join('')}</div>`;
  }

  return { BUCKETS, PHASE_TO_BUCKET, TRACK, STAGE_OF_PHASE, STATUS_PHASE, PHASE_RANK, lanePhase, rows, conflicts, summary, innerMarkup, markup, containerMarkup };
});
