/* 评审「打回后复审」纯逻辑（B-20261114-133448-d100）——无 DOM 依赖，Node 可 require。
 *
 * 背景：Owner 在评审里打回需求 → 需求 rejected；分析师改完正文、状态回到 approved 后，
 * 评审弹窗的 isPending 只看 ownerReview.status='rejected' 就直接判 false → 这条永远不再出现在
 * 「待评审 / 需要你评估」里，Owner 看不到修改后的版本，也就无法复审（R-30e2、R-43ad 都踩过）。
 *
 * 本模块把判定收成一处：
 *   - decidedStatusOf(req)：以需求行顶层 decisions[] 的最后一笔为准（与闸门 ownerDecisionsOf 同源），
 *     旧数据回退 ownerReview.status；
 *   - reworkInfo(req)：上次决定是「打回」+ 需求已离开 rejected 状态 + 打回之后有改动 → { isRework:true }；
 *   - isPending(req)：owner 门未决的判定；命中「打回后已修改」时重新算待评审（带复审标记）。
 *
 * 浏览器：index.html 在 owner-review.js 之前引入，挂到 window.OwnerReviewState。
 */
(function (globalScope) {
  'use strict';

  // 与 app.js 的 FLOW_CLOSED_STATUSES / flow-v4.js 的 CLOSED 同一口径（收口态不再进评审队列）。
  const CLOSED_REQ_STATUSES = ['accepted', 'terminated', 'iteration', 'rejected'];
  const REWORK_LABEL = '已修改待复审';

  function textOf(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  /** 取最后一笔 Owner 决定：优先需求行顶层 decisions[]，旧数据回退 ownerReview.decisions。 */
  function latestOwnerDecision(req) {
    const top = (req && Array.isArray(req.decisions)) ? req.decisions.filter(Boolean) : [];
    if (top.length) return top[top.length - 1];
    const owner = (req && req.ownerReview) || {};
    const list = Array.isArray(owner.decisions) ? owner.decisions : [];
    return list.length ? list[list.length - 1] : null;
  }

  /** 归一成 approved / rejected / skipped；没有决定返回 ''。 */
  function decidedStatusOf(req) {
    const latest = latestOwnerDecision(req);
    const fromDecision = textOf(latest && (latest.status || latest.decision));
    if (['approved', 'rejected', 'skipped'].includes(fromDecision)) return fromDecision;
    const fallback = textOf(req && req.ownerReview && req.ownerReview.status);
    return ['approved', 'rejected', 'skipped'].includes(fallback) ? fallback : '';
  }

  /** 打回时间：决定时间 → ownerReview.at → 行上的 rejectedAt。 */
  function rejectedAtOf(req) {
    const latest = latestOwnerDecision(req);
    const candidates = [
      latest && latest.at,
      req && req.ownerReview && req.ownerReview.at,
      req && req.rejectedAt
    ];
    for (const candidate of candidates) {
      const ms = Date.parse(textOf(candidate));
      if (Number.isFinite(ms)) return ms;
    }
    return 0;
  }

  /** 「改完了」的时间：行 updatedAt 与 reviewedAt 取较大者（工具重审/改状态都会刷新这两个）。 */
  function changedAtOf(req) {
    const a = Date.parse(textOf(req && req.updatedAt));
    const b = Date.parse(textOf(req && req.reviewedAt));
    return Math.max(Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0);
  }

  /**
   * 打回后是否已修改（要重新进待评审队列）。
   * 判据（写死）：
   *   1) 最近一笔 Owner 决定必须是 rejected（或 ownerReview.status=rejected）；
   *   2) 需求已离开 rejected 状态，且不在收口态（accepted/terminated/iteration）；
   *   3) 打回之后有改动（updatedAt/reviewedAt 晚于打回时间；容差 1 秒防同秒误判）；
   *      没有打回时间可判（老数据）时按 2) 直接算复审。
   * 返回 { isRework, label, rejectedAt, changedAt, reason }。
   */
  function reworkInfo(req) {
    const owner = decidedStatusOf(req);
    if (owner !== 'rejected') {
      return { isRework: false, label: '', rejectedAt: 0, changedAt: 0, reason: '最近一次决定不是打回' };
    }
    const status = textOf(req && req.status);
    if (CLOSED_REQ_STATUSES.includes(status)) {
      return { isRework: false, label: '', rejectedAt: rejectedAtOf(req), changedAt: changedAtOf(req), reason: '需求已收口（' + status + '）' };
    }
    if (status === 'rejected') {
      return { isRework: false, label: '', rejectedAt: rejectedAtOf(req), changedAt: changedAtOf(req), reason: '还停在打回状态，未见修改' };
    }
    const rejectedAt = rejectedAtOf(req);
    const changedAt = changedAtOf(req);
    if (!rejectedAt) {
      return { isRework: true, label: REWORK_LABEL, rejectedAt: 0, changedAt, reason: '打回后已重新提交（无打回时间可判）' };
    }
    if (changedAt > rejectedAt + 1000) {
      return { isRework: true, label: REWORK_LABEL, rejectedAt, changedAt, reason: '打回后有修改，等待复审' };
    }
    return { isRework: false, label: '', rejectedAt, changedAt, reason: '打回后未见改动' };
  }

  /**
   * Owner 门是否「等你决定」。与旧实现差别只有一处：
   * 上次打回、但已修改并重新提交的需求，重新算待评审（以前这里直接 false，等于永久隐藏）。
   */
  function isPending(req) {
    const status = textOf(req && req.status);
    if (CLOSED_REQ_STATUSES.includes(status)) return false;
    const owner = decidedStatusOf(req);
    if (owner === 'rejected') return reworkInfo(req).isRework;
    if (owner === 'approved' || owner === 'skipped') return false;
    return status === 'approved' || status === 'owner_review';
  }

  const api = {
    CLOSED_REQ_STATUSES,
    REWORK_LABEL,
    latestOwnerDecision,
    decidedStatusOf,
    rejectedAtOf,
    changedAtOf,
    reworkInfo,
    isPending
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (globalScope) globalScope.OwnerReviewState = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
