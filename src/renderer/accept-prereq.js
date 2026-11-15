/* 验收前置状态（B-20261115-023121-1358，两档拆分 B-20261115-115331-9b05）——无 DOM 依赖，Node 可 require。
 *
 * 验收列表每行要能说清「为什么能验 / 为什么不能验」：测试任务、测试报告、截图、Owner 决定四项。
 * 本模块只做判定（全部来自 owner:review-data 一次性快照：需求行 + 任务数组），渲染由 owner-review.js 负责。
 * 两档（acceptGate）：Owner 本人（ui/tty）只判「测试任务 + Owner 决定」，证据只展示不拦截；
 * PM 代验收（proxy）才要求「测试报告 + 截图」两件套。前后端共用本文件，原因串同一常量。
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
    // 后端（team-tools/acceptEvidenceCheck）用 kind=screenshot，旧证据/行内数据用 image：
    // 两套说法都归一到 image，否则「提交了真截图」会被判成没截图。
    if (declared === 'report' || declared === '报告') return 'report';
    if (declared === 'image' || declared === 'screenshot' || declared === '截图') return 'image';
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
      // 一律归一（report / image），避免 kind=screenshot 这类后端说法在界面判定里变成「没有截图」。
      items.push({ path: rel, kind: kindOfEvidence({ path: rel, kind }) });
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
        // B-9b05：把条数也带出来——「没有绑定测试任务」不能当拦截（全 done 在没有测试任务时是空真）。
        count: testTasks.length,
        open: openTest.length,
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

  /* ── 验收前置两档（B-20261115-115331-9b05 / AC1–AC5）─────────────────────────
   *
   * 同一份判定必须被两侧调用，不许前端另写一套：
   *   - main.js（主进程 owner:accept）直接 require 本文件 → acceptGate(...)；
   *   - owner-review.js（渲染层）用 window.AcceptPrereq（index.html 先加载本文件）。
   * 两档：
   *   owner（channel=ui/tty，Owner 本人验收）：只判「测试任务全 done + 最近决定 approved/skipped」；
   *        报告/截图只展示、不拦截（截图前置不再卡 Owner）。
   *   proxy（channel=proxy，PM 代验收）：再加「测试报告≥1 + 截图≥1」两件套；
   *        缺项沿用 PM_ACCEPT_EVIDENCE_REQUIRED 语义与码（与 team-tools 的 acceptEvidenceCheck 同一码）。
   * 原因串唯一来源：EVIDENCE_INCOMPLETE_LABEL（前后端都引用这个常量，禁止各自写死文案）。
   */
  const TIER_OWNER = 'owner';
  const TIER_PROXY = 'proxy';
  // 验收证据缺项的原因串（AC5）：后端门与界面文案必须取同一个字符串。
  const EVIDENCE_INCOMPLETE_LABEL = '证据不全（Owner 可自行验收）';
  const PROXY_EVIDENCE_CODE = 'PM_ACCEPT_EVIDENCE_REQUIRED';
  // owner 档：证据两件不参与拦截；proxy 档：四件全要。
  const OWNER_REQUIRED_KEYS = ['test_task', 'owner_decision'];
  const PROXY_REQUIRED_KEYS = ['test_task', 'owner_decision', 'test_report', 'shot'];
  // 证据类缺项（只影响 proxy 档）与其中文说法；顺序与 AC5 文案一致（先截图后报告）。
  const EVIDENCE_KEY_ORDER = ['shot', 'test_report'];
  const EVIDENCE_KEY_LABELS = { shot: '缺截图', test_report: '缺测试报告' };

  /** 通道 → 档位：proxy 才算代验收；ui/tty/空 一律按 Owner 本人（历史数据不带 channel）。 */
  function acceptTierOf(channel) {
    return textOf(channel).trim().toLowerCase() === 'proxy' ? TIER_PROXY : TIER_OWNER;
  }

  function requiredKeysOf(tier) {
    return tier === TIER_PROXY ? PROXY_REQUIRED_KEYS.slice() : OWNER_REQUIRED_KEYS.slice();
  }

  /** 证据类缺项 → 统一原因串：证据不全（Owner 可自行验收）：缺截图 / 缺测试报告。 */
  function evidenceIncompleteText(evidenceMissing) {
    const keys = (Array.isArray(evidenceMissing) ? evidenceMissing : [])
      .map((item) => String((item && item.key) || ''))
      .filter((key) => EVIDENCE_KEY_LABELS[key]);
    const ordered = EVIDENCE_KEY_ORDER.filter((key) => keys.includes(key));
    if (!ordered.length) return '';
    return `${EVIDENCE_INCOMPLETE_LABEL}：${ordered.map((key) => EVIDENCE_KEY_LABELS[key]).join(' / ')}`;
  }

  /**
   * 验收前置（档位版）。四项 check 与 acceptPrereq 完全同源，只按档位决定「哪些算拦截」。
   * @param {object} row 需求行
   * @param {Array} tasks 任务数组（owner:review-data 同一份快照）
   * @param {{channel?: string, tier?: string}} options channel=ui/tty → owner 档；proxy → proxy 档
   * @returns {{tier, checks, requiredKeys, missing, evidenceMissing, evidenceMissingKeys,
   *            canAccept, canProxy, ownerDecision, reasonText, proxyBlockedReason, code}}
   */
  function acceptGate(row, tasks, options) {
    const opts = options || {};
    const tier = opts.tier === TIER_PROXY ? TIER_PROXY : (opts.tier === TIER_OWNER ? TIER_OWNER : acceptTierOf(opts.channel));
    const base = acceptPrereq(row, tasks);
    const requiredKeys = requiredKeysOf(tier);
    const required = base.checks.filter((check) => requiredKeys.includes(check.key));
    // 「没有绑定测试任务」不拦截（AC1 只要求测试任务全 done；没有任务时是空真，且无 tester 项目走这条）。
    const vacuous = (check) => check.key === 'test_task' && Number(check.count || 0) === 0;
    const missing = required.filter((check) => !check.ok && !vacuous(check));
    const hints = required.filter((check) => !check.ok && vacuous(check));
    const evidenceMissing = base.checks.filter((check) => EVIDENCE_KEY_ORDER.includes(check.key) && !check.ok);
    const canAccept = missing.length === 0;
    // 代验收按钮态：本档没有拦截项、且证据两件齐全才可点（与后端 proxy 档同一判定）。
    const canProxy = missing.length === 0 && evidenceMissing.length === 0;
    const reasonText = evidenceIncompleteText(evidenceMissing);
    const blockerText = missing.map((check) => `${check.label}（${check.reason}）`).join('；');
    return {
      tier,
      checks: base.checks,
      requiredKeys,
      missing,
      hints,
      evidenceMissing,
      evidenceMissingKeys: evidenceMissing.map((check) => check.key),
      canAccept,
      canProxy,
      ownerDecision: base.ownerDecision,
      reasonText,
      // 代验收按钮禁用原因：有证据缺项时用统一原因串，否则说清是哪一项卡住。
      proxyBlockedReason: canProxy ? '' : (reasonText || blockerText),
      // 只有「proxy 档 + 证据缺项」才是证据门失败，沿用 team-tools 的同一码。
      code: (tier === TIER_PROXY && evidenceMissing.length) ? PROXY_EVIDENCE_CODE : '',
      blockerText
    };
  }

  const api = {
    ownerDecisionOf, kindOfEvidence, collectEvidence, isTestTask, acceptPrereq, prereqSummary,
    acceptGate, acceptTierOf, evidenceIncompleteText, requiredKeysOf,
    TIER_OWNER, TIER_PROXY, EVIDENCE_INCOMPLETE_LABEL, PROXY_EVIDENCE_CODE,
    OWNER_REQUIRED_KEYS, PROXY_REQUIRED_KEYS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (globalScope) globalScope.AcceptPrereq = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
