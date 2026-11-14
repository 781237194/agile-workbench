/* 验收前置状态（B-20261115-023121-1358）——无 DOM 依赖，Node 可 require。
 *
 * 验收列表每行要能说清「为什么能验 / 为什么不能验」：测试任务、测试报告、截图、Owner 决定四项。
 * 本模块只做判定（全部来自 owner:review-data 一次性快照：需求行 + 任务数组），渲染由 owner-review.js 负责。
 * 判据与后端 owner:accept 的四门槛保持同源：
 *   - 测试任务：该需求下「测试人员/测试阶段/标题含测试」的任务必须全部 done；
 *   - 测试报告：证据里 kind=report，或 acceptanceRecord.testReport，或测试任务证据里的 .md 报告；
 *   - 截图：证据里 kind=image，或 .png/.jpg/.jpeg/.webp；
 *   - Owner 决定：最近一笔决定是 approved/skipped 才算过（rejected/pending 都算没通过）。
 */
(function (globalScope) {
  'use strict';

  const IMAGE_RE = /\.(?:png|jpe?g|webp|gif)$/i;
  const REPORT_RE = /\.(?:md|txt|json|html?)$/i;

  function textOf(value) { return value === null || value === undefined ? '' : String(value); }

  /** 需求行 → 最近一笔 Owner 决定（顶层 decisions 优先，回退 ownerReview.status）。 */
  function ownerDecisionOf(row) {
    const decisions = Array.isArray(row && row.decisions) ? row.decisions.filter(Boolean) : [];
    const last = decisions.length ? decisions[decisions.length - 1] : null;
    const fromDecision = textOf(last && (last.status || last.decision)).toLowerCase();
    if (['approved', 'rejected', 'skipped', 'accepted'].includes(fromDecision)) return fromDecision;
    return textOf(row && row.ownerReview && row.ownerReview.status).toLowerCase();
  }

  function kindOfEvidence(item) {
    const declared = textOf(item && item.kind).toLowerCase();
    if (declared === 'report' || declared === 'image') return declared;
    const rel = textOf(item && (item.path || item.rel));
    if (IMAGE_RE.test(rel)) return 'image';
    if (REPORT_RE.test(rel)) return 'report';
    return declared || 'file';
  }

  function collectEvidence(row, testTasks) {
    const items = [];
    const push = (path, kind) => {
      const rel = textOf(path);
      if (!rel) return;
      if (items.some((item) => item.path === rel)) return;
      items.push({ path: rel, kind: kind || kindOfEvidence({ path: rel }) });
    };
    const acceptance = (row && row.acceptance) || {};
    for (const item of (Array.isArray(acceptance.evidence) ? acceptance.evidence : [])) {
      push(item && (item.path || item.rel), item && item.kind);
    }
    const record = (row && row.acceptanceRecord) || {};
    for (const item of (Array.isArray(record.evidence) ? record.evidence : [])) {
      push(item && (item.path || item.rel), item && item.kind);
    }
    push(record.testReport, 'report');
    for (const task of (testTasks || [])) {
      const evid = textOf(task && task.evidence);
      const found = evid.match(/[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5\-./\\]*\.(?:md|txt|json|html?|png|jpe?g|webp)/gi) || [];
      for (const rel of found) push(rel, '');
    }
    return items;
  }

  function isTestTask(task) {
    const owner = textOf(task && task.owner).toLowerCase();
    const stage = textOf(task && task.workflow && task.workflow.stage).toLowerCase();
    return owner === 'tester' || stage === 'test' || /测试/.test(textOf(task && task.title));
  }

  /**
   * 四项前置状态。
   * @returns {{ checks: Array<{key,label,ok,reason,path,go}>, missing: Array, canAccept: boolean, ownerDecision: string }}
   */
  function acceptPrereq(row, tasks) {
    const tasksOfReq = (Array.isArray(tasks) ? tasks : [])
      .filter((task) => task && String(task.requirementId || '') === String(row && row.id || ''));
    const testTasks = tasksOfReq.filter(isTestTask);
    const openTest = testTasks.filter((task) => String(task.status || '') !== 'done');
    const evidence = collectEvidence(row, testTasks);
    const report = evidence.find((item) => item.kind === 'report') || null;
    const shot = evidence.find((item) => item.kind === 'image') || null;
    const ownerDecision = ownerDecisionOf(row);
    const ownerOk = ['approved', 'skipped'].includes(ownerDecision);
    const checks = [
      {
        key: 'test_task',
        label: '测试任务',
        ok: testTasks.length > 0 && openTest.length === 0,
        reason: testTasks.length === 0
          ? '没有绑定测试任务'
          : (openTest.length ? `还有 ${openTest.length} 条测试任务没 done：${openTest.map((task) => task.id).join('、')}` : `测试任务 ${testTasks.length} 条已完成`),
        path: '',
        go: 'test_task',
      },
      {
        key: 'test_report',
        label: '测试报告',
        ok: Boolean(report),
        reason: report ? report.path : '证据里没有测试报告（.md/txt/json）',
        path: report ? report.path : '',
        go: 'test_report',
      },
      {
        key: 'shot',
        label: '截图',
        ok: Boolean(shot),
        reason: shot ? shot.path : '证据里没有截图（.png/.jpg）',
        path: shot ? shot.path : '',
        go: 'shot',
      },
      {
        key: 'owner_decision',
        label: 'Owner 决定',
        ok: ownerOk,
        reason: ownerOk
          ? (ownerDecision === 'approved' ? '已通过' : '已跳过')
          : (ownerDecision === 'rejected' ? '上次被评审打回（旧状态还没复审清掉）' : '还没在评审里通过'),
        path: '',
        go: 'owner_decision',
      },
    ];
    const missing = checks.filter((check) => !check.ok);
    return { checks, missing, canAccept: missing.length === 0, ownerDecision };
  }

  /** 四态摘要（渲染用）：ok/缺项数。 */
  function prereqSummary(prereq) {
    const p = prereq || { checks: [], missing: [] };
    const okCount = (p.checks || []).filter((check) => check.ok).length;
    return { okCount, total: (p.checks || []).length, ok: okCount === (p.checks || []).length, missingKeys: (p.missing || []).map((item) => item.key) };
  }

  const api = { ownerDecisionOf, kindOfEvidence, collectEvidence, isTestTask, acceptPrereq, prereqSummary };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (globalScope) globalScope.AcceptPrereq = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
