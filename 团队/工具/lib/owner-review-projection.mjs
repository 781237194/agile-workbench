// B-20261115-123038-2e24：ownerReview 的唯一派生口径（纯函数，零依赖）
//
// 缺陷：`ownerReview.status` 被后续写入重置成 `pending`，与 append-only 的 `decisions[]` 真值不一致。
//   - 2026-11-15 a28a 实测：正文改 hash → `req review` 重落 RR 时把 ownerReview 写成
//     `{"status":"pending","at":null,"opinion":""}`，抹掉了「上次决定绑的是旧版」，界面/门禁看起来像"从未评审"。
//   - 反向也有：验收打回只写项目级 ownerReview，需求行仍留着旧的 approved（fe90）。
//
// 口径（本模块是唯一实现，ops / 闸门 / 渲染层按同一判据）：
//   1) 真值域 = 工作流 requirements 行的**顶层 decisions[]**（append-only）；ownerReview 只是投影。
//   2) 只有「评审类决定」参与投影：status ∈ {approved,rejected,skipped}。
//      `accepted`（验收通过）与明确标了 `--action accept` / kind=acceptance 的验收决定**不写进 ownerReview**
//      （验收后 decisions[-1]=accepted，而 ownerReview 应仍是 approved）。
//   3) 「最新一条」按 `at` 排序（同一秒的配对重复写入按 decisionIndex / 数组原位次兜底），**不假设数组下标即时间序**。
//   4) 决定的版本：`basis.requirement.sha256` / `contentHash`。与当前正文一致 → 该决定有效，投影 status/at 对齐它；
//      绑的是旧版（或旧记录没有版本凭据）→ 投影 `status:'pending'` 且**必须**带 `stale:true` + `staleSha12`
//      （界面因此能显示"待重新评审、上次决定绑旧版"，不许静默显示成"从未评审"）。
//      行上完全没有版本信息时（视图未导出）按"当前"处理，避免把刚落账的决定判过期（B-20261116-122422-8487 同口径）。
//   5) 没有任何评审决定：回退旧单条 ownerReview（历史数据），否则 pending。
//
// 返回结构（ownerReviewView）：
//   { status, at, opinion, channel, recordedBy, source, stale, staleReason, staleSha12, staleStatus, staleAt,
//     staleChannel, decisionIndex, currentSha12, currentVersion, latestReviewDecision, reviewDecisionCount }
//   source ∈ decisions | ownerReview | none；staleReason ∈ version-mismatch | no-basis | ''
//
// ownerReviewRecord(row, currentVersion) 给出可直接落盘的 ownerReview 投影记录（供 req review / 验收落账复用）：
//   - 有效决定 → { status, at, opinion, by, actor, channel, recordedBy, …, stale:false, decisionIndex }
//   - 旧版决定 → { status:'pending', at:null, opinion:'', stale:true, staleReason, staleSha12, staleStatus, staleAt, currentSha12 }
//   - 无决定   → { status:'pending', at:null, opinion:'', stale:false }

export const REVIEW_DECISION_STATUSES = Object.freeze(['approved', 'rejected', 'skipped']);

function textOf(value) {
  return value === null || value === undefined ? '' : String(value);
}

function statusOf(decision) {
  return textOf(decision && (decision.status || decision.decision)).trim();
}

function shortHash(value) {
  const text = textOf(value);
  return text ? text.slice(0, 12) : '';
}

function timeMs(value) {
  const ms = Date.parse(textOf(value));
  return Number.isFinite(ms) ? ms : null;
}

function decisionIndexOf(decision) {
  const index = Number(decision && decision.decisionIndex);
  return Number.isFinite(index) ? index : null;
}

/**
 * 这笔决定是不是**验收类**决定（不得参与 ownerReview 评审投影）。
 * 判据（任一命中即验收类）：status=accepted；kind/action=accept(ance)；command 里带 --action accept；
 * 显式 acceptance=true。历史里验收打回会写成 status=rejected + channel=ui，只靠 status 分不出来，
 * 但带 `command:'owner --action accept'` 的能识别；不带任何标记的旧记录按评审决定兼容（与 2026-11-16 数据一致）。
 */
export function isAcceptanceDecision(decision) {
  if (!decision || typeof decision !== 'object') return false;
  if (statusOf(decision).toLowerCase() === 'accepted') return true;
  if (decision.acceptance === true) return true;
  const kind = textOf(decision.kind).toLowerCase();
  const action = textOf(decision.action).toLowerCase();
  const command = textOf(decision.command).toLowerCase();
  if (kind === 'acceptance' || kind === 'accept') return true;
  if (action === 'accept') return true;
  if (command.includes('--action accept') || command.includes('--action=accept')) return true;
  return false;
}

/**
 * 需求行的决定链（顶层 decisions[] 优先，旧数据回退 ownerReview.decisions），按 at 升序返回。
 * 同一秒的配对重复写入（一条只有 status、一条带 decision 字段）按 decisionIndex 再按原位次稳定排序。
 */
export function ownerDecisionsOf(row) {
  const r = row && typeof row === 'object' ? row : {};
  const top = Array.isArray(r.decisions) ? r.decisions.filter(Boolean) : [];
  const nested = r.ownerReview && Array.isArray(r.ownerReview.decisions) ? r.ownerReview.decisions.filter(Boolean) : [];
  const seen = new Set();
  const merged = [];
  for (const decision of [...top, ...nested]) {
    const key = [textOf(decision.at), statusOf(decision), textOf(decision.channel), textOf(decision.decisionIndex)].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(decision);
  }
  return merged
    .map((decision, index) => ({ decision, index }))
    .sort((a, b) => {
      const am = timeMs(a.decision.at);
      const bm = timeMs(b.decision.at);
      if (am !== null && bm !== null && am !== bm) return am - bm;
      if (am === null && bm !== null) return -1;
      if (am !== null && bm === null) return 1;
      const ai = decisionIndexOf(a.decision);
      const bi = decisionIndexOf(b.decision);
      if (ai !== null && bi !== null && ai !== bi) return ai - bi;
      return a.index - b.index;
    })
    .map((item) => item.decision);
}

/** 评审类决定（approved/rejected/skipped，剔除验收类），按 at 升序。 */
export function reviewDecisionList(row) {
  return ownerDecisionsOf(row).filter((decision) => (
    REVIEW_DECISION_STATUSES.includes(statusOf(decision)) && !isAcceptanceDecision(decision)
  ));
}

/** 最新一条评审类决定（按 at）；没有返回 null。 */
export function latestReviewDecision(row) {
  const list = reviewDecisionList(row);
  return list.length ? list[list.length - 1] : null;
}

/** 决定绑的正文版本：basis.requirement.sha256（优先）/ contentHash；旧记录也读顶层。 */
export function decisionVersionOf(decision) {
  const d = decision && typeof decision === 'object' ? decision : {};
  const basis = d.basis && typeof d.basis === 'object' ? d.basis : {};
  const requirement = basis.requirement && typeof basis.requirement === 'object' ? basis.requirement : {};
  const sha256 = textOf(requirement.sha256 || d.sha256);
  const contentHash = textOf(requirement.contentHash || d.contentHash);
  return { sha256, contentHash, sha12: shortHash(sha256 || contentHash), bound: Boolean(sha256 || contentHash) };
}

/**
 * 行上的当前正文版本：显式入参优先（字符串按 sha256；对象读 sha256/contentHash），
 * 其次行字段（requirementHash/docHash/requirementReview.requirementHash + contentHash）。
 */
export function currentVersionOf(row, explicit) {
  const r = row && typeof row === 'object' ? row : {};
  let sha256 = '';
  let contentHash = '';
  if (typeof explicit === 'string') {
    sha256 = explicit;
  } else if (explicit && typeof explicit === 'object') {
    sha256 = textOf(explicit.sha256);
    contentHash = textOf(explicit.contentHash);
  }
  if (!sha256) sha256 = textOf(r.requirementHash || r.docHash || (r.requirementReview && r.requirementReview.requirementHash));
  if (!contentHash) contentHash = textOf((r.requirementReview && r.requirementReview.contentHash) || r.contentHash);
  return { sha256, contentHash, sha12: shortHash(sha256 || contentHash), known: Boolean(sha256 || contentHash) };
}

/**
 * 这笔决定是否针对当前正文版本：
 *   true        → 决定绑当前版本（或行/入参上完全没有版本信息，无法证明是旧版 → 按当前处理）
 *   false       → 决定明确绑的是别的版本
 * 口径说明（B-2e24 落地时按真实数据校准）：**「没有 basis」不等于「旧版」**。
 *   项目里 88 条有评审决定的需求有 19 条末条决定无 basis（11-15 那批历史记录），
 *   若把「无凭据」一律判 stale，会把 Owner 已通过的旧需求整批打回 pending 并卡住 G3 派单——
 *   这是比原缺陷更大的破坏。所以无凭据按「当前」处理，另给 `noBasis:true` 供界面/审计提示，
 *   只有**明确绑了别的版本**才 stale。
 */
export function decisionVersionState(decision, current) {
  const decided = decisionVersionOf(decision);
  if (!decided.bound) return true;
  const cur = current && typeof current === 'object' && 'known' in current ? current : currentVersionOf(null, current);
  if (!cur.known) return true;
  const decidedHashes = [decided.sha256, decided.contentHash].filter(Boolean);
  const currentHashes = [cur.sha256, cur.contentHash].filter(Boolean);
  return decidedHashes.some((hash) => currentHashes.includes(hash));
}

function normalizeOwnerStatus(value) {
  const status = textOf(value).trim();
  return REVIEW_DECISION_STATUSES.includes(status) ? status : '';
}

/**
 * ownerReview 的唯一投影。
 * @param {object} row                  工作流需求行（requirements[id]）
 * @param {string|object} currentVersion 当前正文版本：sha256 字符串或 {sha256, contentHash}；缺省从 row 推导
 * @returns {object} 见文件头返回结构
 */
export function ownerReviewView(row, currentVersion) {
  const r = row && typeof row === 'object' ? row : {};
  const owner = r.ownerReview && typeof r.ownerReview === 'object' ? r.ownerReview : {};
  const version = currentVersionOf(r, currentVersion);
  const decisions = reviewDecisionList(r);
  const latest = decisions.length ? decisions[decisions.length - 1] : null;
  const base = {
    status: 'pending', at: null, opinion: '', channel: textOf(owner.channel), recordedBy: textOf(owner.recordedBy),
    source: 'none', stale: false, staleReason: '', staleSha12: '', staleStatus: '', staleAt: null, staleChannel: '',
    decisionIndex: null, currentSha12: version.sha12,
    currentVersion: { sha256: version.sha256, contentHash: version.contentHash },
    latestReviewDecision: latest, reviewDecisionCount: decisions.length,
  };
  if (!latest) {
    // 没有 decisions[]：旧单条 ownerReview 作为历史兼容口径原样透出（不迁移、不补账）。
    const legacyStatus = normalizeOwnerStatus(owner.status);
    if (legacyStatus) {
      return { ...base, status: legacyStatus, at: textOf(owner.at) || null, opinion: textOf(owner.opinion), source: 'ownerReview' };
    }
    return base;
  }
  const state = decisionVersionState(latest, version);
  const latestIndex = decisionIndexOf(latest);
  const noBasis = !decisionVersionOf(latest).bound;
  if (state === true) {
    return {
      ...base,
      status: normalizeOwnerStatus(latest.status) || normalizeOwnerStatus(latest.decision) || 'pending',
      at: textOf(latest.at) || null,
      opinion: textOf(latest.opinion || latest.note),
      channel: textOf(latest.channel || owner.channel),
      recordedBy: textOf(latest.recordedBy || owner.recordedBy),
      source: 'decisions',
      decisionIndex: latestIndex,
      // 无凭据只作提示，不改判定（见 decisionVersionState 的口径说明）
      noBasis,
    };
  }
  // 只有旧版决定（或旧记录无版本凭据）：pending + stale（禁止静默显示成「从未评审」）。
  const decided = decisionVersionOf(latest);
  return {
    ...base,
    status: 'pending',
    at: null,
    opinion: '',
    channel: '',
    recordedBy: '',
    source: 'decisions',
    stale: true,
    staleReason: state === 'unknown' ? 'no-basis' : 'version-mismatch',
    staleSha12: decided.sha12,
    staleStatus: normalizeOwnerStatus(latest.status) || normalizeOwnerStatus(latest.decision) || '',
    staleAt: textOf(latest.at) || null,
    staleChannel: textOf(latest.channel),
    staleDecisionIndex: latestIndex,
    decisionIndex: null,
  };
}

/** stale 摘要（没有 stale 返回 null）——闸门错误信息与界面徽标共用。 */
export function ownerReviewStaleOf(row, currentVersion) {
  const view = ownerReviewView(row, currentVersion);
  if (!view.stale) return null;
  return {
    stale: true,
    staleReason: view.staleReason,
    staleSha12: view.staleSha12,
    staleStatus: view.staleStatus,
    staleAt: view.staleAt,
    currentSha12: view.currentSha12,
  };
}

/**
 * 可直接落盘的 ownerReview 投影记录（写路径专用）。
 * 注意：pending/stale 的记录**不带** by/actor（审计里"待办"不能写成 Owner 的记录）。
 */
export function ownerReviewRecord(row, currentVersion) {
  const r = row && typeof row === 'object' ? row : {};
  const owner = r.ownerReview && typeof r.ownerReview === 'object' ? r.ownerReview : {};
  const view = ownerReviewView(r, currentVersion);
  const required = owner.required === undefined ? true : Boolean(owner.required);
  const kind = view.stale ? 'requirement' : (owner.kind && owner.kind !== 'acceptance' ? owner.kind : 'requirement');
  if (view.stale) {
    return {
      required,
      kind,
      status: 'pending',
      at: null,
      opinion: '',
      stale: true,
      staleReason: view.staleReason,
      staleSha12: view.staleSha12,
      staleStatus: view.staleStatus,
      staleAt: view.staleAt,
      staleChannel: view.staleChannel || '',
      ...(view.staleDecisionIndex === null || view.staleDecisionIndex === undefined ? {} : { staleDecisionIndex: view.staleDecisionIndex }),
      ...(view.currentSha12 ? { currentSha12: view.currentSha12 } : {}),
    };
  }
  if (view.source === 'decisions' && view.latestReviewDecision) {
    const decision = view.latestReviewDecision;
    return {
      required,
      kind,
      status: view.status,
      at: view.at,
      opinion: view.opinion,
      by: textOf(decision.by) || (view.recordedBy === 'pm' ? 'PM（代记 Owner 的决定）' : 'Owner'),
      actor: textOf(decision.actor) || (view.recordedBy === 'pm' ? 'pm' : 'owner'),
      channel: view.channel,
      ...(view.recordedBy ? { recordedBy: view.recordedBy } : {}),
      ...(textOf(decision.decidedBy) ? { decidedBy: textOf(decision.decidedBy) } : {}),
      ...(decision.proxy ? { proxy: decision.proxy } : {}),
      ...(textOf(decision.authorization) ? { authorization: textOf(decision.authorization) } : {}),
      ...(decision.confirmation ? { confirmation: decision.confirmation } : {}),
      ...(textOf(decision.reqVersion) ? { reqVersion: textOf(decision.reqVersion) } : {}),
      stale: false,
      derivedFrom: 'decisions',
      ...(view.decisionIndex === null ? {} : { decisionIndex: view.decisionIndex }),
      ...(view.currentSha12 ? { currentSha12: view.currentSha12 } : {}),
    };
  }
  // 无 decisions[]：保留旧单条 ownerReview 状态（历史兼容），否则 pending。
  if (view.source === 'ownerReview') {
    return {
      required,
      kind,
      status: view.status,
      at: view.at,
      opinion: view.opinion,
      ...(view.channel ? { channel: view.channel } : {}),
      ...(view.recordedBy ? { recordedBy: view.recordedBy } : {}),
      stale: false,
      derivedFrom: 'ownerReview',
    };
  }
  return { required, kind, status: 'pending', at: null, opinion: '', stale: false, derivedFrom: 'none' };
}

/** ownerReview 是否「与 decisions[] 派生的投影不一致」（写路径自愈用；只比较状态与 at）。 */
export function ownerReviewDriftOf(row, currentVersion) {
  const owner = row && row.ownerReview && typeof row.ownerReview === 'object' ? row.ownerReview : null;
  if (!owner) return { drifted: true, reason: 'missing' };
  const view = ownerReviewView(row, currentVersion);
  const ownerStatus = textOf(owner.status);
  if (ownerStatus !== view.status) return { drifted: true, reason: `status:${ownerStatus || '(空)'}→${view.status}` };
  const ownerAt = textOf(owner.at);
  const viewAt = textOf(view.at);
  if (viewAt && ownerAt !== viewAt) return { drifted: true, reason: `at:${ownerAt || '(空)'}→${viewAt}` };
  if (view.stale && owner.stale !== true) return { drifted: true, reason: 'stale-flag-missing' };
  if (!view.stale && owner.stale === true) return { drifted: true, reason: 'stale-flag-leftover' };
  return { drifted: false, reason: '' };
}
