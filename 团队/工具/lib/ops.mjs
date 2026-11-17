// 团队工作台 v2 · 业务命令（boot / 消息 / 任务 / 提案 / 评审 / 签字 / 应用 / 索引 / 对账）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  PATHS, TeamError, fail, nowIso, sha256, hashFile, shortHash, exists, ensureDir, readText, readJson,
  writeText, writeJson, appendLine, readJsonl, readJsonlTolerant, slug, isInside, relPath,
  truncate, randomHex, stamp, asArray, acquireLock, releaseLock, heartbeatLock, lockInfo, listLocks,
  appendEvent, readEventsStrict, verifyEventChain, jsonOut, textOut, hhmmss, safeName,
} from './core.mjs';
import {
  ROLES, ROLE_NAMES, PHASE_PILOT, initTeam, loadTeam, saveTeam, mutateTeam, getMember, activeMembers,
  projectStatePaths, projectIndexPath, loadProject, listProjects, addProject, setActiveProject,
  readDocSet, createBootToken, requireBoot, sendMessage, listInbox, unreadCount, findMessage, readMessage,
  ackMessage, loadReceipts, createTask, loadTask, saveTask, listTasks, claimTask, finishTask,
  setTaskPriority, proposalPaths, newProposal, computeProposalHash, loadProposal, saveProposal,
  listProposals, saveReview, loadReviews, saveSignature, loadSignatures, signatureDigest, commitPath,
  saveCommit, loadCommit, listCommits, loadArtifacts, saveArtifacts, activeGrants, hasGrant,
  syncProposalMirror, syncDevOutput,
  addGrant, revokeGrant, loadGrants, addReadReceipt, latestRead,
  projectTeamMode, projectRoleIds, persistProjectTeamMode, projectModeState,
  DEFAULT_BOOT_TTL_MINUTES,
  // T-20261117-203046-9ff2：PM 关键消息钩子（store 写盘后立即回调这里 → 当场唤醒，不靠队列泵兜底）
  onPmCriticalMessage,
} from './store.mjs';
import { dispatchGateFor, scanClaims, claimSummary, clearClaimFlags, CLAIM_OVERDUE_MIN, CLAIM_STALLED_MIN } from './claim-watch.mjs';
import { DshClient } from './dsh-session.mjs';
import { renderBoardHtml as renderBoardHtmlV2, renderBoardMd as renderBoardMdV2 } from './board.mjs';
import {
  ROLE_DIRS, roleDisplayName, OUTPUT_DOCS, OUTPUT_DISCIPLINE, TEAM_MODES, TEAM_MODE_LABELS,
  isTeamMode, normalizeTeamMode, rolesForMode, roleInMode, teamModeDescription,
  requirementReviewer, techReviewers, votersForMode, VOTE_RULE_TEXT,
} from './roles.mjs';
import { ensureProjectStructure, structureReport, readRequirementDocs, requirementContentText } from './scaffold.mjs';
// T-20261117-184114-4358（R-bcae）：skill 四要素校验 + 30 分钟评估提示（append-only skill评估.jsonl）。
import { validateSkillContent, recordSkillEvaluation, readSkillEvaluations, skillPromptDue, skillPromptLineFor } from './skill.mjs';
// T-20261117-211833-7a30（R-a4c7）：调度建议纯函数（三源 → 五类建议）。
import { buildSchedAdvice } from './sched-advice.mjs';
import {
  auditGate, detectPhaseEdit, gateDesign, gateIteration, gateRequirementFinal, gateRequirementDoc,
  gateRequirementReview, gateStageRole, gateTestReport, gateTestability, gateConfig,
  stageOfRow, idMatches, gateRoleBusy, detectPhaseJump,
  // R-75ec：任务层 Owner 门禁唯一入口与它的只读投影（避免在 ops 里出现第二套判门）。
  taskGateOf, decisionListOf, latestDecisionOf,
  // B-b894：任务闭环状态唯一口径（done/accepted/cancelled/terminated），别再在 ops 里写数组。
  statusIsClosed,
  isRequirementMirrorTask,
} from './gates.mjs';
import * as lessons from './lessons.mjs';
import { buildDispatchPrompt, buildNoticePrompt, buildWakeHeader, buildWakeLine, isRegisteredKind } from './dispatch.mjs';
import { assertNoPendingSubagent, subagentAudit } from './subagent.mjs';
import {
  handoverForBoot, validateHandover, assertSessionMapConsistent, probeRoleSession, nudgeRoleBoot, consumeBootQueue,
} from './session.mjs';
import { validatePmAcceptEvidence, parseEvidenceArg, validateAcceptGates } from './pm-accept-evidence.mjs';
import { detectOptionalPlugins, optionalPluginMarks, pluginStatusLines } from './plugins.mjs';
import { auditHardcodedPaths, pathAuditLines } from './path-audit.mjs';
import { memoryCheck } from './memory-check.mjs';
// R-5b14：每角色默认交接文档（<角色>/产出/交接-最新.md）的只读发现 + 「最新」判定（固定名优先）。
import { handoverBriefLine } from './handover.mjs';
import { checkEvidenceGate } from './evidence.mjs';
import { bumpRound, archiveSession, confirmArchive, ROUNDS_MAX } from './session-archive.mjs';
import {
  transitionRequirement, syncWorkflowRow, stampRejected, workflowAction, readWorkflowState, writeWorkflowState, latestValidOwnerDecision, currentDeliveryRound,
} from './lifecycle.mjs';
import {
  issueOwnerConfirmation, consumeOwnerConfirmation, ownerConfirmHint,
} from './owner-confirm.mjs';
import { activeProxyFor, assertProxyUsable, autoEndProxyForClosedRequirement } from './owner-proxy.mjs';
import { readDecisionBox as readDecisionBoxFile } from './decision-box.mjs';
// B-20261116-062204-89c6：PM 用消息问 Owner 必须标 owner_ask（漏箱扫描只认类型，不再靠标题猜）。
import { looksLikeOwnerAsk, appendDecisionRouteAudit } from './decision-route.mjs';
import {
  voidRegistryFile, legacyVoidRegistryFile, readVoidRegistry, appendVoidEntry,
} from './req-void-registry.mjs';
import { detectLedgerForks, requirementLedger, reopenedAtOf } from './ledger.mjs';
import {
  scenarioConfirmState, applyScenarioTimeout, scenarioConfirmerFor, scenarioTimeoutMs,
} from './scenario-confirm.mjs';
import { readRequirementDocVersion, versionForRecord, versionGate } from './req-version.mjs';
// R-75ec：Owner 决定落账即冻结/解冻（任务层门禁的效果层）。
import { applyOwnerDecisionEffects } from './task-freeze.mjs';
// R-c6dc：需求正文唯一写入口 / 并发检测 / 登记链 / 审计（工具侧单源）
import {
  DOC_WRITER_DEFAULT, docRegistryPath, docLockPath, readDocRegistry, appendDocRegistry,
  writeRequirementDoc, unlockDocWrite, auditRequirementDocs, docLockStaleMs, verifyDocRegistryChain,
} from './doc-writer.mjs';
import {
  DOC_SPLIT_RULE, DOC_SPLIT_LIMIT, DOC_SPLIT_TARGET, DOC_SPLIT_TRIGGER,
  checkDocSize, docSizeReport, scanRequirementDocs, splitRequirementDoc, revertRequirementSplit,
  listSupplements, supplementRecords, supplementsForShow, validateSupplementLinks,
  readSplitAudit, splitAuditPath, requirementShortKey, requirementDocFile, isWhitelisted,
  SUPPLEMENT_RE, supplementIndexOf,
} from './doc-split.mjs';
// B-20261115-123038-2e24：ownerReview 只是 decisions[] 的投影——派生口径单源（ops/闸门/渲染层同判据）。
import {
  ownerReviewView, ownerReviewRecord, ownerReviewDriftOf, ownerReviewStaleOf,
} from './owner-review-projection.mjs';

const RISK_RANK = { normal: 1, sensitive: 2, critical: 3 };
const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** 需求状态只前进：review/rejected < approved < tech_review < ready < 开发/测试 < 验收/终止。 */
const REQUIREMENT_STATUS_RANK = {
  review: 0, rejected: 0, approved: 1, tech_review: 2, ready: 3, dispatched: 4, dev: 5,
  dev_review: 6, dev_done: 7, test: 8, test_done: 9, accepted: 10, iteration: 10, terminated: 11,
};

function statusRank(status) {
  const key = String(status || '');
  return Object.prototype.hasOwnProperty.call(REQUIREMENT_STATUS_RANK, key) ? REQUIREMENT_STATUS_RANK[key] : -1;
}

/** 目标阶段比当前更靠后才推进；重审/重放不会把已经 forward 的需求打回去。 */
function keepForwardStatus(current, target) {
  return statusRank(current) >= statusRank(target) ? String(current) : String(target);
}

/** 合并工作流行与任务里的 decisions：任一侧缺行时仍能识别“已有 Owner 决定”。 */
function ownerDecisionList(row, task) {
  const rowList = decisionListOf(row);
  const taskList = task && task.workflow && Array.isArray(task.workflow.decisions)
    ? task.workflow.decisions.filter(Boolean) : [];
  if (!taskList.length) return rowList;
  if (!rowList.length) return [...taskList];
  const key = (decision) => [decision.decisionIndex, decision.at, decision.status || decision.decision, decision.channel]
    .map((value) => String(value === undefined || value === null ? '' : value)).join('|');
  const seen = new Set(rowList.map(key));
  const merged = [...rowList, ...taskList.filter((decision) => !seen.has(key(decision)))];
  merged.sort((a, b) => {
    const ai = Number(a.decisionIndex);
    const bi = Number(b.decisionIndex);
    if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return ai - bi;
    return String(a.at || '').localeCompare(String(b.at || ''));
  });
  return merged;
}

/** 最近一条 Owner 决定（append-only decisions 的末条）。 */
function latestOwnerDecisionFor(row, task) {
  const list = ownerDecisionList(row, task);
  return list.length ? list[list.length - 1] : null;
}

/* ── R-0dbb F7/F8：Owner 意见的唯一取数与消费门 ──────────────────────────────
 * 落账（机制已有）：Owner 通过/打回时 opinion 逐字进 decisions[]，ownerReview 是 decisions[] 的投影。
 * 三处同源：`team.mjs req list --json`、`req review` 返回体、壳层快照（team-tools.js requirementView）
 *           都只认 decisions[-1].opinion，不截断、不改写、不前端另拼。
 * 消费：未 ack 再评 → OWNER_OPINION_UNREAD 且零写入（门禁在写盘/其它门之前）。
 * 已消费集合：该需求 `history` 中 action='owner_opinion_ack' 行的 opinionSha256 去重集合（append-only）；
 *            `requirementReview.ownerOpinionAck` 只作「最近一次」展示，不作判定依据（requirementReview 会被覆写）。
 */

/** 展示口径：decisions[-1].opinion（原文）+ at + sha256（CLI/req review/壳层同用）。 */
export function ownerOpinionDisplayOf(row) {
  const list = decisionListOf(row);
  const last = list.length ? list[list.length - 1] : null;
  const opinion = last && last.opinion !== undefined && last.opinion !== null ? String(last.opinion) : '';
  return {
    opinion,
    at: String((last && (last.at || last.decidedAt)) || ''),
    status: String((last && (last.status || last.decision)) || ''),
    sha256: opinion ? sha256(opinion) : '',
  };
}

/** 已消费集合：history 里 action='owner_opinion_ack' 的 opinionSha256（去重）。 */
export function ownerOpinionAckSetOf(row) {
  const set = new Set();
  const history = Array.isArray(row && row.history) ? row.history : [];
  for (const entry of history) {
    if (!entry || String(entry.action || '') !== 'owner_opinion_ack') continue;
    const value = String(entry.opinionSha256 || '').trim().toLowerCase();
    if (value) set.add(value);
  }
  return set;
}

/**
 * 消费门判定（纯函数，零写入）：当前有效 Owner 决定的 opinion 非空且未被 ack → { ok:false, code:'OWNER_OPINION_UNREAD' }。
 * 空意见不拦（AC11⑥）；旧数据没有 ownerOpinionAck 一律按未消费处理（降级不静默放行）。
 */
export function ownerOpinionGateFor(row) {
  const latest = latestValidOwnerDecision(row);
  const opinion = latest && latest.opinion !== undefined && latest.opinion !== null ? String(latest.opinion) : '';
  if (!opinion.trim()) {
    return { ok: true, reason: 'EMPTY_OPINION', opinion: '', at: '', sha256: '', consumed: [] };
  }
  const sha = sha256(opinion);
  const consumed = ownerOpinionAckSetOf(row);
  if (consumed.has(sha)) return { ok: true, reason: 'ACKED', opinion, at: String(latest.at || ''), sha256: sha, consumed: [...consumed] };
  return {
    ok: false, code: 'OWNER_OPINION_UNREAD', reason: 'UNREAD',
    opinion, at: String(latest.at || ''), sha256: sha, consumed: [...consumed],
  };
}

/** --owner-opinion-ack 校验：≤300 字，且必须以「采纳：」或「不采纳：」开头（卷 §三 F8）。 */
function normalizeOwnerOpinionAck(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text) return '';
  if (text.length > 300) {
    fail('OWNER_OPINION_ACK_INVALID', `--owner-opinion-ack 最多 300 字（当前 ${text.length} 字）`, { length: text.length, max: 300, wrote: false });
  }
  if (!/^(?:采纳|不采纳)\s*[：:]/.test(text)) {
    fail('OWNER_OPINION_ACK_INVALID', '--owner-opinion-ack 必须以「采纳：」或「不采纳：」开头，写清对 Owner 意见的处置', { sample: '采纳：按建议把颗粒度对齐到 AC 级；不采纳：…说明原因', wrote: false });
  }
  return text;
}

/**
 * 幂等 Owner：同 basis（需求/设计哈希一致）的同一决定已落账时，不要求新 nonce、不再 append，
 * 只把状态/相位同步回决定结果（修“重审把 ready 打回 approved 后只能请 Owner 重签”）。
 */
function idempotentOwnerDecision({ projectName, project, task, row, decision, actionRaw, teamMode }) {
  const latest = latestOwnerDecisionFor(row, task);
  if (!latest) return null;
  const latestStatus = String(latest.status || latest.decision || '');
  const wanted = String(decision || '');
  if (latestStatus !== wanted) return null;
  const basis = buildOwnerBasis(projectName, project, task, teamMode);
  const oldReq = latest.basis && latest.basis.requirement ? String(latest.basis.requirement.sha256 || '') : '';
  const oldReqContent = latest.basis && latest.basis.requirement ? String(latest.basis.requirement.contentHash || '') : '';
  const oldDesign = latest.basis && latest.basis.design ? String(latest.basis.design.sha256 || '') : '';
  // 需求只要内容（去掉状态行）没变，就视为同一 basis；旧记录没有 contentHash 时回退原始哈希。
  const newReqContent = String(basis.requirement.contentHash || '');
  const sameRequirement = Boolean(oldReq || oldReqContent)
    && ([oldReq, oldReqContent].filter(Boolean).some((value) => value === basis.requirement.sha256 || (newReqContent && value === newReqContent)));
  const sameDesign = (!oldDesign && !basis.design.sha256) || (oldDesign && oldDesign === String(basis.design.sha256 || ''));
  if (!sameRequirement || !sameDesign) return null;
  const targetStatus = (() => {
    if (wanted === 'accepted') return 'accepted';
    if (wanted === 'rejected') return 'rejected';
    if (teamMode === 'fast') {
      const tech = task.workflow && task.workflow.techReview;
      return tech && String(tech.verdict || '') === 'approve' ? 'ready' : 'tech_review';
    }
    return 'ready';
  })();
  const currentStatus = String((row && row.status) || (task.workflow && task.workflow.requirementStatus) || 'review');
  const nextStatus = keepForwardStatus(currentStatus, targetStatus);
  return { latest, basis, currentStatus, nextStatus, targetStatus };
}

/** 读工作流里的需求行；没有就返回 null（不创建）。 */
function workflowRowFor(project, requirementId) {
  try {
    const state = readWorkflowState(project).state;
    return (state.requirements && state.requirements[String(requirementId)]) || null;
  } catch { return null; }
}

/**
 * B-2ae4 / 62b9：推进前必须**读测试报告主体结论**，不能只看任务 evidence 字符串。
 * 62b9 的 测试报告-v190.md 首行 status=不通过，但任务 evidence 里没写「不通过」→ 被误推到 test_done。
 *
 * 取报告顺序：①任务 evidenceFiles / evidence 文本里点名的 测试人员/产出/*.md；
 *             ②兜底扫 `测试人员/产出/测试报告-vN.md`，**必须属于本需求**（正文出现需求 id 或 4 位短号），
 *                同一需求内按 -vN 降序取最新。
 * 只看报告头部（前 20 行 + status/结论/判定 行）；命中 不通过/未通过/FAIL/失败 → fail；命中 通过/PASS → pass；否则 unknown。
 *
 * 2026-11-15 缺陷修复（M-20261115-153130-d8df04）：旧实现「兜底取项目全局最新 vN」会把别的需求的报告
 * （v190=62b9 不通过）读进来挡住 b28f（v185=通过）。现在兜底必须先按 requirementId 过滤。
 */
/**
 * 按需求分段的纯函数（M-20261115-161343-6104c7：推进门第三处假阴性）。
 * 背景：G7 报告门只认「最新一份测试报告」，多需求同轮必须合并成一份；
 * 旧判定把整份报告当一条需求扫「不通过」，于是 B 的不通过把 A 判死（v192：b28f 通过 / 62b9 不通过）。
 */
function requirementTokenHit(line, requirementId, shortKey) {
  const text = String(line || '');
  if (!text) return false;
  const full = String(requirementId || '').toLowerCase();
  if (full && text.toLowerCase().includes(full)) return true;
  const key = String(shortKey || '').replace(/[^0-9a-z]/gi, '').toLowerCase();
  if (!key) return false;
  return new RegExp(`(^|[^0-9a-z])${key}([^0-9a-z]|$)`, 'i').test(text);
}

/** 项目里已知的需求 4 位短号（需求/*.md、任务/*.json 文件名 + 报告正文里的完整 id），用于识别「别的需求」。 */
function knownRequirementShortKeys(projectPath, text) {
  const keys = new Set();
  const add = (value) => {
    const m = /R-20\d{6}-\d{6}-([0-9a-z]{4})/i.exec(String(value || ''));
    if (m) keys.add(m[1].toLowerCase());
  };
  for (const dir of ['需求', '任务']) {
    try {
      for (const name of fs.readdirSync(path.join(projectPath, dir))) add(name);
    } catch { /* 目录不存在：只靠报告正文 */ }
  }
  for (const m of String(text || '').matchAll(/R-20\d{6}-\d{6}-([0-9a-z]{4})/gi)) keys.add(m[1].toLowerCase());
  return keys;
}

/** 该条款是否「以别的需求为主语」（如「62b9 不通过（…）」）：必须以需求号开头，防「依据 62b9 的对比」误杀。 */
function clauseStartsWithForeignRequirement(clause, shortKey, knownKeys) {
  // 结论行重建时首条款带「status= / 结论：」前缀（前缀属于整行，不属于某条需求），先剥掉再判断主语
  const lead = String(clause || '').trim()
    .replace(/^[-*>\s`|]+/, '')
    .replace(/^(status|结论|判定|verdict)\s*[=:：|]\s*/i, '');
  const m = /^(?:R-20\d{6}-\d{6}-([0-9a-z]{4})|([0-9a-z]{4}))(?![0-9a-z])/i.exec(lead);
  if (!m) return false;
  const mine = String(shortKey || '').toLowerCase();
  const key = String(m[1] || m[2] || '').toLowerCase();
  if (!key || key === mine) return false;
  return Boolean(m[1]) || knownKeys.has(key);
}

/** 行内按条款裁剪：「status: A 通过；B 不通过」只留 A 那一段（含不带需求号的中性条款）；返回 '' = 整行不属于本需求。 */
function scopeLineToRequirement(line, requirementId, shortKey, knownKeys) {
  const raw = String(line || '');
  if (!raw.trim()) return '';
  const isOurs = (part) => requirementTokenHit(part, requirementId, shortKey);
  const isForeign = (part) => clauseStartsWithForeignRequirement(part, shortKey, knownKeys);
  // 句号也算条款边界：同一行里「A 通过。B 不通过」这类散文并列要能拆开
  const parts = raw.split(/[。；;|]/);
  if (parts.some(isOurs)) {
    // 并列条款里有本需求：只留本需求的条款 + 中性条款（表格里「通过」这类单元格不带需求号）
    return parts.filter((part) => isOurs(part) || !isForeign(part)).join('；').trim();
  }
  if (parts.some(isForeign)) return '';
  return raw.trim();
}

/** 证据串先剔掉路径令牌，只留人工备注——路径名里带 FAIL/不通过 不能当结论（M-20261115-161641-a8f13b 口径统一）。 */
function evidenceNoteText(evidence) {
  return String(evidence || '')
    .replace(/[A-Za-z]:[\\/][^\s，,；;]*/g, ' ')
    .replace(/(?:^|[\s，,；;])[^\s，,；;]*[\\/][^\s，,；;]*/g, ' ')
    .trim();
}

/** A 方案（M-20261115-161641-a8f13b）：按需求号切段——从本需求 id/短号出现处，到下一个 1–2 级标题或别的需求号为止，按整行取范围。 */
function segmentLinesForRequirement(text, requirementId, shortKey, knownKeys) {
  const source = String(text || '');
  if (!source.trim()) return [];
  const lines = source.split(/\r?\n/);
  const lineStarts = [];
  let cursor = 0;
  for (const line of lines) { lineStarts.push(cursor); cursor += line.length + 1; }
  const lineOf = (pos) => {
    for (let i = lines.length - 1; i >= 0; i -= 1) if (lineStarts[i] <= pos) return i;
    return 0;
  };
  const marks = [];
  // 段在下一个 1–2 级标题处收口（与测试记录「到下一个 ## 为止」同口径；### 子标题不收口，避免截断本节结论）
  for (const m of source.matchAll(/(^|\n)#{1,2}[ \t]+\S/g)) marks.push(m.index + (m[1] ? m[1].length : 0));
  // 段在「别的需求号」处收口：完整 id 或项目已知的 4 位短号
  const mineKey = String(shortKey || '').toLowerCase();
  for (const other of knownKeys) {
    if (!other || other === mineKey) continue;
    const re = new RegExp(`R-20\\d{6}-\\d{6}-${other}|(^|[^0-9a-z])${other}(?![0-9a-z])`, 'gi');
    for (const m of source.matchAll(re)) marks.push(m.index + (m[1] ? m[1].length : 0));
  }
  // 本需求号（完整 id + 4 位短号）出现处；短号必须带词边界
  const appears = [];
  const full = String(requirementId || '');
  if (full) {
    const escaped = full.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const m of source.matchAll(new RegExp(escaped, 'gi'))) appears.push(m.index);
  }
  if (mineKey) {
    for (const m of source.matchAll(new RegExp(`(^|[^0-9a-z])${mineKey}(?![0-9a-z])`, 'gi'))) appears.push(m.index + (m[1] ? m[1].length : 0));
  }
  if (!appears.length) return [];
  const markList = marks.filter((pos) => Number.isFinite(pos) && pos > 0).sort((a, b) => a - b);
  const ranges = appears.map((start) => {
    const next = markList.find((pos) => pos > start);
    const from = lineOf(start);
    const to = next === undefined ? lines.length - 1 : lineOf(next);
    return [from, Math.max(from, to)];
  }).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [from, to] of ranges) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  const picked = [];
  for (const [from, to] of merged) for (let i = from; i <= to; i += 1) picked.push(lines[i]);
  return picked;
}

// B-c69e：报告结论关键词不识别否定句（「不构成不通过 / 无 FAIL / 0 失败」被误判 fail）。
// 模块级 helper：判负前先剔除否定短语与零值短语，剩下的文本里出现强否定词才算 fail；
// readTestReportVerdict 与 task done 证据备注校验共用本函数。
const FAIL_STRONG_RE_M = /(不通过|未通过|\bFAIL\b)/i;
const NEGATED_FAIL_RE = /(?:不构成|不算|并非|不是|非|未见|未发现)\s*(?:不通过|未通过|FAIL|失败)/gi;
const ZERO_FAIL_RE = /(?:无|没有|零|(?<![A-Za-z0-9])0)\s*(?:项|个|条|次)?\s*(?:FAIL|失败|不通过|未通过)/gi;
const FAIL_ZERO_RE = /\bFAIL\b\s*(?:数|计数|条|项)?\s*[:：=]?\s*0(?![0-9])/gi;
const FAIL_ZERO2_RE = /(?:失败|不通过|未通过)\s*(?:数|计数|条|项)?\s*[:：=]?\s*0(?![0-9])/gi;
// D-20261116-062141-06ec（Owner 06:43 选 B）：只认「带数字的失败 N 项」——`失败 2 项` / `失败 3 条` 判负，
// 但散文里的「失败零副作用」「失败原因见 §二」不判（没有「数字+量词」），`失败 0 项` 已被上面的零式剔除。
// 之所以不把「失败」加进 FAIL_STRONG_RE：那会让所有提到「失败」二字的散文全被判负（L348-349 注释的原始理由仍成立）。
const FAIL_COUNT_RE = /(?:失败|不通过|未通过)\s*[1-9]\d*\s*(?:项|个|条)/;
// D-06ec 测试注记（tester 06:52）：`失败 2 项已修复` 这类「已处置」不该判负——先剔掉再判 FAIL_COUNT_RE；
// `失败 2 项未修复` 不会被这里剔掉（前缀只认 已/均已/全部/已全部），仍判负。
const FAIL_COUNT_RESOLVED_RE = /(?:失败|不通过|未通过)\s*[1-9]\d*\s*(?:项|个|条)\s*(?:已全部|均已全部|已|均已|全部)?\s*(?:修复|解决|处理|关闭|恢复)/g;
const NEGATED_FAIL_TEST = /(?:不构成|不算|并非|不是|非|未见|未发现)\s*(?:不通过|未通过|FAIL|失败)/i;
const ZERO_FAIL_TEST = /(?:无|没有|零|(?<![A-Za-z0-9])0)\s*(?:项|个|条|次)?\s*(?:FAIL|失败|不通过|未通过)/i;
const FAIL_ZERO_TEST = /\bFAIL\b\s*(?:数|计数|条|项)?\s*[:：=]?\s*0(?![0-9])/i;
const FAIL_ZERO2_TEST = /(?:失败|不通过|未通过)\s*(?:数|计数|条|项)?\s*[:：=]?\s*0(?![0-9])/i;
function hasNegatedFailPhrase(text) {
  const t = String(text || '');
  return NEGATED_FAIL_TEST.test(t) || ZERO_FAIL_TEST.test(t) || FAIL_ZERO_TEST.test(t) || FAIL_ZERO2_TEST.test(t);
}
export function failVerdictText(text) {
  let t = String(text || '');
  t = t.replace(NEGATED_FAIL_RE, '（否定靶词）').replace(ZERO_FAIL_RE, '（零靶词）');
  t = t.replace(FAIL_ZERO_RE, '（零靶词）').replace(FAIL_ZERO2_RE, '（零靶词）');
  t = t.replace(FAIL_COUNT_RESOLVED_RE, '（已处置靶词）');
  return FAIL_STRONG_RE_M.test(t) || FAIL_COUNT_RE.test(t);
}
export function readTestReportVerdict(projectName, task) {
  const requirementId = String((task && task.requirementId) || '').trim();
  const shortKey = requirementId ? requirementId.slice(-4).toLowerCase() : '';
  const reportPaths = [];
  const namedPaths = new Set();
  const pushUnique = (p, taskScoped = false) => {
    const rel = String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
    if (!rel) return;
    if (!/测试人员\/产出\/.+\.md$/i.test(rel) && !/测试报告|测试结论|test-report/i.test(rel)) return;
    if (taskScoped) namedPaths.add(rel);
    if (!reportPaths.includes(rel)) reportPaths.push(rel);
  };
  const evidenceFiles = Array.isArray(task && task.evidenceFiles) ? task.evidenceFiles : [];
  for (const file of evidenceFiles) {
    if (!file) continue;
    if (file.scope === 'workspace') continue;
    pushUnique(file.path || file.rel || file.name, true);
    if (Array.isArray(file.manifest)) for (const item of file.manifest) pushUnique(item && (item.path || item.rel), true);
  }
  const evidenceText = String((task && task.evidence) || '');
  const pathMatches = evidenceText.match(/测试人员[\\/]+产出[\\/]+[^\s，,；;）)】\]]+\.md/gi) || [];
  for (const p of pathMatches) pushUnique(p.replace(/\\/g, '/'), true);
  let projectPath = '';
  try { projectPath = loadProject(projectName).path; } catch { projectPath = ''; }
  if (!projectPath) return { verdict: 'unknown', file: '', snippet: '' };
  // 结论判定只认「结论行」：status/结论/判定/verdict 键值行；头部兜底只认强否定词
  // （不通过/未通过/FAIL），不认裸「失败」——汇总报告里「0 失败 / 失败零副作用」这类数词/散文会被误判成不通过。
  const FAIL_STRONG_RE = /(不通过|未通过|\bFAIL\b)/i;
  const PASS_STRONG_RE = /(\bPASS\b|全部通过|通过)/i;
  const CONCLUSION_RE = /^[\s>*\-`|]*?(status|结论|判定|verdict)\s*[=:：|]\s*(.*)$/i;
  const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
  const failVerdictText = (text) => {
    let t = String(text || '');
    t = t.replace(NEGATED_FAIL_RE, '（否定靶词）').replace(ZERO_FAIL_RE, '（零靶词）');
    t = t.replace(FAIL_ZERO_RE, '（零靶词）').replace(FAIL_ZERO2_RE, '（零靶词）');
    t = t.replace(FAIL_COUNT_RESOLVED_RE, '（已处置靶词）');
    return FAIL_STRONG_RE.test(t) || FAIL_COUNT_RE.test(t);
  };
  // M-20261115-161343-6104c7（第三处假阴性）：一份报告可能同时写多条需求的结论，
  // 旧实现把整份报告当一条需求扫，B 的「不通过」会把 A 判死（v192：b28f 通过 / 62b9 不通过）。
  // 判定前先按需求分段：只扫点名本需求的小节；没有小节才回退报告头，且行内按需求条款裁剪。
  const knownKeys = knownRequirementShortKeys(projectPath, '');
  /** 报告是否属于本需求：正文（前 4KB）出现完整 id 或 4 位短号。 */
  const mentionsRequirement = (abs) => {
    if (!requirementId) return true;
    let head = '';
    try { head = fs.readFileSync(abs, 'utf8').slice(0, 4000).toLowerCase(); } catch { return false; }
    if (head.includes(requirementId.toLowerCase())) return true;
    // 短号必须带边界（-b28f / b28f- / b28f. / （b28f）），避免 4 个字母撞词
    if (shortKey && new RegExp(`(^|[^0-9a-z])${shortKey}([^0-9a-z]|$)`).test(head)) return true;
    return false;
  };
  // 兜底：扫全部 测试报告-vN.md，**只留属于本需求的**，同需求内按 -vN 降序取最新。
  try {
    const dir = path.join(projectPath, '测试人员', '产出');
    const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const reports = names
      .map((name) => ({ name, m: /^测试报告-v(\d+)\.md$/i.exec(name) }))
      .filter((x) => x.m)
      .sort((a, b) => Number(b.m[1]) - Number(a.m[1]));
    for (const item of reports) {
      const rel = path.join('测试人员', '产出', item.name).replace(/\\/g, '/');
      // 跨需求误读修复：只认提到本需求的报告，别的需求的报告一律不参与判定
      if (!mentionsRequirement(path.join(dir, item.name))) continue;
      pushUnique(rel, false);
      break; // 只要同需求最新一份
    }
  } catch { /* 目录不存在就只靠点名的报告 */ }
  // 报告有版本：新报告覆盖旧结论——按 -vN 从大到小排（无版本号排最后），先看最新那份。
  const versionOf = (rel) => {
    const m = /-v(\d+)\.md$/i.exec(rel);
    return m ? Number(m[1]) : 0;
  };
  const ordered = [...reportPaths]
    .filter((rel) => {
      // 任务点名的报告优先信任（taskScoped），其余必须属于本需求
      if (namedPaths.has(rel)) return true;
      return mentionsRequirement(path.join(projectPath, rel));
    })
    .sort((a, b) => versionOf(b) - versionOf(a));
  for (const rel of ordered) {
    const abs = path.join(projectPath, rel);
    if (!fs.existsSync(abs)) continue;
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const keys = new Set([...knownKeys, ...knownRequirementShortKeys(projectPath, text)]);
    // A 方案（M-20261115-161641-a8f13b）：只扫「点名本需求」的段落，段边界见 segmentLinesForRequirement。
    let scanLines = segmentLinesForRequirement(text, requirementId, shortKey, keys);
    if (!scanLines.length) {
      // 报告里没有本需求号：按 PM 口径回退「本需求」字样所在行；再没有就视为不覆盖（不静默判通过）。
      scanLines = text.split(/\r?\n/).filter((line) => /本需求/.test(String(line || '')));
      if (!scanLines.length) continue;
    }
    // ① 先看结论行（status/结论/判定/verdict），同一份报告内「先命中先返回」；
    //    表格行（| 需求号 | 结论 |）含本需求号时也按结论行处理。
    const conclusions = [];
    for (const line of scanLines.slice(0, 300)) {
      const raw = String(line || '');
      const m = CONCLUSION_RE.exec(raw);
      if (m) {
        const part = scopeLineToRequirement(`${m[1]}=${m[2] || ''}`.trim(), requirementId, shortKey, keys);
        if (part) conclusions.push(part);
      } else if (TABLE_ROW_RE.test(raw) && requirementTokenHit(raw, requirementId, shortKey)) {
        const part = scopeLineToRequirement(raw, requirementId, shortKey, keys);
        if (part) conclusions.push(part);
      }
    }
    for (const line of conclusions) {
      if (failVerdictText(line)) return { verdict: 'fail', file: rel, snippet: line.slice(0, 120), requirementId, basis: 'conclusion' };
    }
    for (const line of conclusions) {
      if (hasNegatedFailPhrase(line) || PASS_STRONG_RE.test(line)) return { verdict: 'pass', file: rel, snippet: line.slice(0, 120), requirementId, basis: 'conclusion' };
    }
    // ② 没有结论行时兜底看头部：只认强否定/强肯定，裸「失败」不算（数词/散文会误判）
    for (const line of scanLines.slice(0, 20)) {
      const part = scopeLineToRequirement(line, requirementId, shortKey, keys);
      if (!part) continue;
      if (failVerdictText(part)) return { verdict: 'fail', file: rel, snippet: part.slice(0, 120), requirementId, basis: 'head' };
    }
    for (const line of scanLines.slice(0, 20)) {
      const part = scopeLineToRequirement(line, requirementId, shortKey, keys);
      if (!part) continue;
      if (hasNegatedFailPhrase(part) || PASS_STRONG_RE.test(part)) return { verdict: 'pass', file: rel, snippet: part.slice(0, 120), requirementId, basis: 'head' };
    }
  }
  return { verdict: 'unknown', file: ordered[0] || '', snippet: '', requirementId };
}

/**
 * task done 后按「任务类型 + 阶段 + 测试结论」推进需求状态（B-b645）：
 * - 只有 type=task 的任务能推进；TR-Q/评审类任务（既不是开发也不是测试）不推进；
 * - 开发类：需求在 ready/dispatched/dev/dev_review（legacy approved 视同 ready），且该需求全部开发任务 done → dev_done；
 * - 测试类：需求在 dev_done/test、TR-Q 为 testable（无 TR-Q 记录按历史兼容放行）、
 *   任务证据没有 FAIL/不通过，且全部测试任务 done → test_done；
 * - 无 Owner decision 且需求还在 owner_review（approved 或更早）时不得越过该门；
 * - 不满足条件只记 requirement_advance_skipped 事件，不改任何状态。
 */
function advanceRequirementAfterTaskDone(projectName, task, role, opts = {}) {
  // R-1623 F-1623-1：type=bug 与 type=task 同权参与开发推进；chore/requirement 仍不推进。
  if (!task || !['task', 'bug'].includes(String(task.type || ''))) return null;
  const isBug = String(task.type || '') === 'bug';
  const requirementId = String(task.requirementId || '').trim();
  if (!requirementId) {
    // F-1623-4：没绑定需求的 done 不计入，留痕 no_requirement_binding。
    try {
      appendEvent({
        role, sessionId: '', action: 'requirement_advance_skipped', project: projectName,
        target: '', note: 'no_requirement_binding（任务未绑定需求）',
        data: { taskId: task.id, reason: 'no_requirement_binding' },
      });
    } catch { /* 留痕失败不阻断 task done */ }
    return null;
  }
  // F-1623-5：历史 bug 不回溯——bug 必须晚于 团队.json → advanceRule.legacyBugBefore；配置缺失默认全部不计入。
  if (isBug) {
    let cutoff = '';
    try {
      const team = loadTeam();
      cutoff = String((team && team.config && team.config.advanceRule && team.config.advanceRule.legacyBugBefore) || '');
    } catch { cutoff = ''; }
    const doneAt = String(task.doneAt || task.updatedAt || '');
    const cutoffMs = cutoff ? Date.parse(cutoff) : NaN;
    const doneMs = doneAt ? Date.parse(doneAt) : NaN;
    if (!cutoff || !Number.isFinite(cutoffMs) || !Number.isFinite(doneMs) || doneMs <= cutoffMs) {
      try {
        appendEvent({
          role, sessionId: '', action: 'requirement_advance_skipped', project: projectName,
          target: requirementId, note: `legacy_bug（doneAt=${doneAt || '(空)'} ≤ legacyBugBefore=${cutoff || '(未配置)'}）`,
          data: { taskId: task.id, reason: 'legacy_bug', doneAt, legacyBugBefore: cutoff || '' },
        });
      } catch { /* 留痕失败不阻断 */ }
      return null;
    }
  }
  let reqTask;
  try { reqTask = loadTask(projectName, requirementId); } catch { return null; }
  if (!reqTask || reqTask.type !== 'requirement') return null;
  const row = workflowRowFor(projectName, requirementId) || {};
  const current = String(row.status || (reqTask.workflow && reqTask.workflow.requirementStatus) || 'review');
  // Owner 2026-11-14 09:27：iteration 是“打回重做”轮，不冻结——开发全 done→dev_done，测试全 done→test_done，自动回验收；
  // 不需要 Owner 重批（打回意见/round+1/证据链都保留在原行与 history 里）。
  if (['accepted', 'terminated'].includes(current)) return null;

  const skip = (reason, extra = {}) => {
    try {
      appendEvent({
        role, sessionId: '', action: 'requirement_advance_skipped', project: projectName,
        target: requirementId, note: `${reason}（任务 ${task.id}；当前 ${current}）`,
        data: { taskId: task.id, status: current, stage: String((task.workflow && task.workflow.stage) || ''), reason, ...extra },
      });
    } catch { /* 留痕失败不阻断 task done */ }
    return null;
  };

  // R-1623 F-1623-1 ④：证据必需——evidenceFiles 非空才计入开发完成；
  // 沙盘（证据门 skipped）与历史任务没有 evidenceFiles，但 evidence 文本非空，按“有证据”兼容放行。
  const hasEvidenceFiles = Array.isArray(task.evidenceFiles) && task.evidenceFiles.length > 0;
  const hasEvidenceText = String(task.evidence || '').trim().length > 0;
  if (!hasEvidenceFiles && !hasEvidenceText) return skip('no_evidence');

  const stage = String((task.workflow && task.workflow.stage) || '');
  const owner = String(task.owner || '');
  const isTest = stage === 'test' || (owner === 'tester' && stage !== 'dev');
  const isDev = !isTest && (stage === 'dev' || ['programmer1', 'programmer2'].includes(owner));
  if (!isTest && !isDev) return skip('not_dev_or_test_task');

  // 已在目标之后：静默返回，不刷事件（多任务收口时很常见）。
  // iteration 按“重做轮起点（approved）”计位次：它本身是终态高位次，直接比会被误判“已在目标之后”。
  const currentRankForAdvance = current === 'iteration' ? statusRank('approved') : statusRank(current);
  const cap = isTest ? statusRank('test_done') : statusRank('dev_done');
  if (currentRankForAdvance >= cap) return null;

  // ② 无 Owner decision 不得越过 owner_review 门：还在该门（approved 或更早）时必须有落账决定。
  if (current !== 'iteration' && statusRank(current) <= statusRank('approved') && !decisionListOf(row).length) {
    return skip('owner_gate');
  }

  let target = '';
  if (isDev) {
    // legacy 兼容（2026-11-14 阻塞修复）：早期 Owner 通过后需求行可能停在 approved（没有 dispatched/dispatch 记录），
    // 这类历史需求视同 ready 的开发阶段，只要有 Owner 决定且全部开发任务 done 就允许推 dev_done；新流程不变。
    if (!['ready', 'dispatched', 'dev', 'dev_review', 'approved', 'iteration'].includes(current)) return skip('stage_not_dev');
    // 开发任务可能拆多条：全部开发任务 done 才把需求推进到 dev_done，避免第一条 done 就挡后续派单。
    // 受控校准（2026-11-14 ff86 诊断）：历史遗留的「无 owner 的 open 任务」不是真实派工，
    // 只有显式 --allow-unowned-open 时才把它们排除出阻塞清单，并在事件里记下忽略了哪些任务。
    const ignoreUnowned = Boolean(opts.ignoreUnowned);
    // R-d225 F-reopen-2b：开发任务只认当前轮（旧轮 done 不得把返工后的需求推回 dev_done）。
    const curRoundAdv = Number((row && row.deliveryRound) || 0) || 0;
    const roundOkAdv = (rowTask) => {
      const raw = rowTask && (rowTask.round ?? (rowTask.workflow && rowTask.workflow.round));
      const rr = Number(raw);
      if (!Number.isFinite(rr) || raw === '' || raw === null || raw === undefined) return true;
      return curRoundAdv === 0 || rr === curRoundAdv;
    };
    const allDevTasks = listTasks(projectName).filter((rowTask) => rowTask && ['task', 'bug'].includes(String(rowTask.type || ''))
      && String(rowTask.requirementId || '') === requirementId)
      .filter(roundOkAdv)
      .filter((rowTask) => !(String((rowTask.workflow && rowTask.workflow.stage) || '') === 'test'))
      .filter((rowTask) => !(ignoreUnowned && !String(rowTask.owner || '').trim()))
      .filter((rowTask) => String(rowTask.owner || '') !== 'tester');
    // 重做轮：只让“本轮（含无轮次标记的 legacy 任务）”参与收口，旧轮的 open 遗留不挡本轮。
    const devRound = current === 'iteration' ? Number(row.round || 0) : 0;
    const devTasks = devRound > 0
      ? (() => {
        const markedRound = (rowTask) => {
          const wf = rowTask.workflow || {};
          if (wf.round !== undefined && wf.round !== null && wf.round !== '') return Number(wf.round);
          if (wf.iterationRound !== undefined && wf.iterationRound !== null && wf.iterationRound !== '') return Number(wf.iterationRound);
          return null; // 老任务没阶段标记：按 legacy 参与收口
        };
        const same = allDevTasks.filter((rowTask) => {
          const r = markedRound(rowTask);
          return r === null || r === devRound;
        });
        return same.length ? same : allDevTasks;
      })()
      : allDevTasks;
    if (devTasks.length && devTasks.every((rowTask) => statusIsClosed(rowTask.status))) target = 'dev_done';
    // 还有开发任务没 done 时必须留痕，不能静默返回 null：否则现场看起来就是「task done 没推进需求」，
    // 排查只能靠翻文件（2026-11-14 ea86 就被一条遗留 open 旧单卡住，且当时没有任何事件）。
    else if (devTasks.length) {
      const openTasks = devTasks.filter((rowTask) => !statusIsClosed(rowTask.status)).map((rowTask) => `${rowTask.id}:${rowTask.status || 'unknown'}`);
      // 事件 note 直接写出「哪条任务在挡」（reason 里带清单），人看一眼就够，不用再点开 data。
      return skip(`dev_tasks_open(${openTasks.join(',')})`, { openTasks });
    }
  } else {
    // ① 测试类只在 testable 且测试通过时推进。
    if (!['dev_done', 'test'].includes(current)) return skip('stage_not_test');
    const trqVerdict = String((row.trq && row.trq.verdict) || '');
    if (trqVerdict && trqVerdict !== 'testable') return skip('trq_not_testable', { verdict: trqVerdict });
    // 口径统一（M-20261115-161641-a8f13b）：证据串只作「人工备注」信号，先剔路径令牌再判；
    // 真正的结论以报告正文为准（下面的 readTestReportVerdict）。路径名里带 FAIL/不通过 不再误拦。
    if (failVerdictText(evidenceNoteText(task.evidence))) return skip('test_not_passed');
    // B-2ae4 / 62b9：证据字符串干净不等于测试通过——必须读测试报告主体结论（前 20 行 + status/结论行）。
    // 命中「不通过/未通过/FAIL/失败」→ 不推进，并把匹配到的原文片段写进 requirement_advance_skipped 审计。
    const reportVerdict = readTestReportVerdict(projectName, task);
    if (reportVerdict.verdict === 'fail') {
      return skip('test_report_not_passed', {
        reportFile: reportVerdict.file, snippet: reportVerdict.snippet, reportVerdict: reportVerdict.verdict,
      });
    }
    const tests = listTasks(projectName).filter((rowTask) => rowTask && ['task', 'bug'].includes(String(rowTask.type || ''))
      && String(rowTask.requirementId || '') === requirementId)
      .filter((rowTask) => String(rowTask.owner || '') === 'tester'
        || String((rowTask.workflow && rowTask.workflow.stage) || '') === 'test');
    if (tests.length && tests.every((rowTask) => statusIsClosed(rowTask.status))) target = 'test_done';
  }
  if (!target || currentRankForAdvance >= statusRank(target)) return null;
  const at = nowIso();
  reqTask.workflow = reqTask.workflow && typeof reqTask.workflow === 'object' ? reqTask.workflow : {};
  reqTask.workflow.requirementStatus = target;
  reqTask.updatedAt = at;
  reqTask._by = role;
  reqTask._action = 'task_done_advance';
  reqTask._note = `任务 ${task.id} done`;
  saveTask(projectName, reqTask);
  const phase = target === 'test_done' ? 'test_done' : 'dev_done';
  const sync = syncWorkflowRow(projectName, reqTask, target, {
    reviewedAt: reqTask.workflow.reviewedAt,
    reviewedBy: reqTask.workflow.reviewedBy,
    reviewRole: reqTask.workflow.reviewRole,
    teamMode: reqTask.workflow.teamMode,
  }, {
    create: true,
    action: 'task_done_advance',
    by: role,
    note: `任务 ${task.id} done`,
    phase,
  });
  appendEvent({
    role, sessionId: '', action: 'requirement_advance', project: projectName,
    target: requirementId, note: `${current}→${target}`,
    data: { taskId: task.id, status: target, phase },
  });
  return { requirementId, previous: current, status: target, phase, workflowFile: sync.file };
}

/** 闸门拒绝的统一出口：先写审计（写不了就失败），再抛带「缺项+下一步」的错误码。 */
function gateFail(project, record, gate) {
  auditGate(project, {
    role: record.role,
    source: record.source || 'cli',
    action: record.action || '',
    gate: gate.gate || '',
    code: gate.code,
    missing: gate.missing || [],
    requirementId: gate.requirementId || record.requirementId || '',
    taskId: gate.taskId || record.taskId || '',
    attempted: record.attempted || '',
    next: gate.next || '',
  });
  fail(gate.code, gate.message || gate.code, { ...gate, wrote: false });
}

/** 软闸门（auto 模式）：不阻断，但写审计留痕。 */
function gateWarn(project, record, gate) {
  try {
    auditGate(project, {
      role: record.role,
      source: record.source || 'cli',
      action: record.action || '',
      gate: gate.gate || '',
      code: gate.code,
      missing: gate.missing || [],
      requirementId: gate.requirementId || record.requirementId || '',
      taskId: gate.taskId || record.taskId || '',
      attempted: (record.attempted || '') + '（soft）',
      next: gate.next || '',
    });
  } catch { /* 审计失败时软闸门不阻断主流程 */ }
}

/**
 * 工作台 Electron 自测沙盘：main.js 只在 --selftest 时设置 AWB_STORE（指向沙盘 workbench.json）。
 * 生产路径永远不设这个变量；用 AWB_SELFTEST_ROOT 跑隔离沙盘也能被识别。
 */
function inElectronSelftestSandbox() {
  const store = String(process.env.AWB_STORE || '').trim();
  if (!store) return false;
  return /workbench\.json$/i.test(store) && /[\\/](\.selftest-data|selftest[^\\/]*)[\\/]/i.test(store);
}

/**
 * 派单前的闸门串联：G8 跳步 → G1 定稿 → G2 评审 → G3 Owner 落账 → G5 角色忙 → G0 阶段角色 → G4 设计。
 * 拒绝写审计并带「缺项+下一步」；G4 默认硬门（AC14.4），fast 走 G4f 的 TECH_REVIEW_REQUIRED。
 */
function runDispatchGates({ projectName, requirementId, role, targetRole = '', attempted = 'send --ack', taskId = '', skipRoleBusy = false }) {
  let project = null;
  try { project = loadProject(projectName); } catch { return; }
  let reqTask = null;
  try { reqTask = loadTask(projectName, requirementId); } catch { reqTask = null; }
  const record = { role, action: 'dispatch_dev', requirementId, attempted, taskId };
  if (!reqTask) {
    gateFail(projectName, record, {
      code: 'REQUIREMENT_NOT_FOUND', gate: 'G1', requirementId,
      missing: ['需求任务不存在'], next: '先 req create 建需求', message: `需求 ${requirementId} 不存在，不能派单`,
    });
  }
  const stateRead = readWorkflowState(projectName);
  const row = (stateRead.state && stateRead.state.requirements && stateRead.state.requirements[requirementId])
    || { status: (reqTask.workflow && reqTask.workflow.requirementStatus) || 'ready' };
  const mode = projectTeamMode(project);
  // AC14.8（R-31b3 按需求判定）：只比该需求自身状态与其子任务证据；项目 phase 只做展示。
  const jump = detectPhaseJump({ state: stateRead.state || {}, row, tasks: listTasks(projectName) });
  if (jump) gateFail(projectName, record, jump);
  const g1 = gateRequirementFinal(reqTask, project.path);
  if (g1) {
    if (g1.soft) gateWarn(projectName, record, g1);
    else gateFail(projectName, record, g1);
  }
  const g2 = gateRequirementReview(row, reqTask, project.path);
  if (g2) {
    // R-9a8e AC1：评审针对旧版本/忘涨版被 G2 拦下时，留一条 review_stale_blocked 审计事件。
    if (String(g2.code) === 'VERSION_NOT_BUMPED' || String(g2.reason || '') === 'version_changed' || String(g2.reason || '') === 'stale') {
      try {
        appendEvent({
          role: record.role || 'pm', sessionId: '', action: 'review_stale_blocked', project: projectName,
          target: requirementId,
          note: truncate(String(g2.message || g2.code || ''), 160),
          data: {
            requirementId, gate: String(g2.gate || 'G2'), code: String(g2.code || ''), reason: String(g2.reason || ''),
            recordedVersion: String(g2.recordedVersion || ''), currentVersion: String(g2.currentVersion || ''),
            change: String(g2.change || ''), recordedHash: String(g2.recordedHash || ''), currentHash: String(g2.currentHash || ''),
            attempted: String(record.action || '') || 'dispatch',
          },
        });
      } catch { /* 审计失败不改变门禁结论 */ }
    }
    gateFail(projectName, record, g2);
  }
  // B-29b2 门禁互锁修复：可测性评审（TR-Q）属**需求阶段**，必须在 Owner 决定之前能跑；
  // 派 TR-Q 任务时 G3（Owner 落账）豁免，否则「TR-Q 不可测 → 落不了 Owner 决定」与「无 Owner 决定 → 派不了 TR-Q」互锁。
  // 注意：G2.5（Owner 决定时的可测性门）不动，开发派单仍由 G2.5 拦。
  const targetTask = (() => { try { return taskId ? loadTask(projectName, String(taskId)) : null; } catch { return null; } })();
  const isTrqTask = Boolean(targetTask) && (/TR-Q|可测性评审/i.test(String(targetTask.title || '')) || String(targetTask.type || '').toLowerCase() === 'trq');
  if (isTrqTask) {
    gateWarn(projectName, { ...record, action: 'dispatch_trq' }, {
      code: 'G3_TRQ_EXEMPT', gate: 'G3', requirementId, taskId,
      missing: [], next: 'TR-Q 属需求阶段，允许在 Owner 决定前派给测试人员',
      message: `TR-Q 任务 ${taskId} 豁免 G3（Owner 决定前可派）`,
    });
  }
  // R-75ec：派单与 claim/finish **同源**——都走 taskGateOf；对外 code 保留旧 OWNER_REVIEW_REQUIRED（兼容），
  // 同时带 gateCode/cause，测试按「同 cause + 同 gateCode」断言。
  const g3 = isTrqTask ? null : (() => {
    const gate = taskGateOf({
      task: { id: String(taskId || (reqTask && reqTask.id) || ''), requirementId },
      row: row || null,
    });
    if (!gate) return null;
    return { ...gate, code: 'OWNER_REVIEW_REQUIRED', gateCode: gate.gateCode || gate.code, gate: 'G3' };
  })();
  if (g3) gateFail(projectName, record, g3);
  // G5：目标角色已有未闭环任务/活动锁 → TASK_OPEN / ROLE_BUSY。
  // 排除“本次要派的目标任务”与承载它的需求任务（R-99ff ①：目标自身/已认领不算占用），
  // 只有别的未闭环任务/活动锁才是真冲突。
  // --queue 入队时跳过 G5（角色忙正是排队原因）；真正发派单时再按 G5 判。
  if (targetRole && !skipRoleBusy) {
    const busy = gateRoleBusy({
      role: targetRole,
      tasks: listTasks(projectName),
      locks: listLocks().filter((lock) => !lock.stale),
      excludeTaskIds: [taskId, requirementId].filter(Boolean),
    });
    if (busy) gateFail(projectName, { ...record, action: 'dispatch_dev' }, busy);
  }
  const g0 = gateStageRole({ row: { status: row.status || 'ready' }, role, action: 'dispatch_dev', mode });
  if (g0) gateFail(projectName, record, g0);
  const cfg = gateConfig(project);
  const g4 = gateDesign({
    projectPath: project.path, mode, task: reqTask,
    state: stateRead.state || null,
    commits: (() => { try { return listCommits(projectName); } catch { return []; } })(),
  });
  if (g4) {
    if (cfg.productDesign === 'hard') gateFail(projectName, record, g4);
    gateWarn(projectName, record, g4);
  }
  return row;
}

function sessionOf(args) {
  return String(args.session || process.env.DSH_SESSION_ID || 'session-unknown');
}

function tokenOf(args) {
  if (!args.boot) fail('BOOT_REQUIRED', '需要 --boot <启动令牌>；先运行 boot');
  return requireBoot(String(args.boot), {});
}

function bootFor(args, action) {
  const b = tokenOf(args);
  if (args.role && args.role !== b.role) fail('BOOT_ROLE_MISMATCH', `令牌角色 ${b.role} ≠ --role ${args.role}`);
  if (args.project && args.project !== b.project) fail('BOOT_PROJECT_MISMATCH', `令牌项目 ${b.project} ≠ --project ${args.project}`);
  // R-703f F-4 / AC3②：只认角色当前绑定的会话（团队.json members[].sessionId）。
  // 旧会话再发言要丢弃并留痕，不能让它继续以角色身份落账。
  // 判定要精确：只拦“在轮换记录里被明确写成旧会话（from）”的会话，避免名册滞后把正常会话误伤。
  try {
    const team = loadTeam();
    const member = getMember(team, b.role);
    const currentId = String((member && member.sessionId) || '');
    const bootId = String(b.sessionId || '');
    if (currentId && bootId && bootId !== currentId && isRetiredSession(b.project, b.role, bootId)) {
      appendEvent({
        role: b.role, sessionId: bootId, action: 'session_retired_ignored', project: b.project || '',
        note: `旧会话 ${bootId} ≠ 当前 ${currentId}；动作 ${action} 被丢弃`,
      });
      fail('SESSION_RETIRED_IGNORED', `会话 ${bootId} 已在轮换记录里退役（当前会话 ${currentId}）；旧会话的动作被丢弃，请在新会话执行`, {
        role: b.role, sessionId: bootId, currentSessionId: currentId, action,
      });
    }
  } catch (e) {
    if (e instanceof TeamError) throw e;
    /* 名册/轮换记录读取异常：不在这里扩权拦截 */
  }
  return b;
}

/** 会话是否在 <项目>/会话轮换 里被明确记为某角色的旧会话（from）。 */
function isRetiredSession(projectName, role, sessionId) {
  const name = String(projectName || '');
  const target = String(sessionId || '');
  if (!name || !target) return false;
  try {
    const dir = path.join(projectStatePaths(name).dir, '会话轮换');
    for (const fileName of fs.readdirSync(dir)) {
      if (!fileName.endsWith('.json') || /^S-/.test(fileName)) continue;
      const row = readJson(path.join(dir, fileName));
      if (!row || String(row.role || '') !== String(role)) continue;
      if (String(row.from || '') === target) return true;
    }
  } catch { /* 没有轮换目录就是没退役过 */ }
  return false;
}

function out(args, human, json) {
  if (args.json) jsonOut(json);
  else textOut(human);
}

function table(rows, cols) {
  if (!rows.length) return '（无）';
  const widths = cols.map((c) => Math.max(c.label.length, ...rows.map((r) => String(r[c.key] ?? '').length)));
  const line = (vals) => vals.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  ');
  return [line(cols.map((c) => c.label)), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(cols.map((c) => r[c.key])))].join('\n');
}

function memberOrFail(team, role) {
  const m = getMember(team, role);
  if (!m) fail('NO_MEMBER', `角色不在团队：${role}`);
  if (m.status !== 'active') fail('MEMBER_INACTIVE', `角色未激活：${role}`);
  return m;
}

function activeRoles(team) {
  return activeMembers(team).map((m) => m.role);
}

/** 当前项目团队模式（没有 activeProject 时按 full）。 */
function activeProjectMode(team) {
  const name = team.activeProject;
  if (!name) return 'full';
  try { return projectTeamMode(loadProject(name)); } catch { return 'full'; }
}

// 评审/签字人按“项目团队模式 ∩ 活跃成员”算：fast 项目里即使团队表还有产品/程序员B，
// 他们也不能 boot，不能被要求评审或签字，否则会卡死 apply。
function proposalActiveRoles(proposal, team) {
  const roles = activeRoles(team);
  try {
    const modeRoles = rolesForMode(projectTeamMode(loadProject(proposal.project)));
    return roles.filter((r) => modeRoles.includes(r));
  } catch {
    return roles;
  }
}

function requiredSets(proposal, team) {
  const roles = proposalActiveRoles(proposal, team);
  const others = roles.filter((r) => r !== proposal.author);
  if (proposal.risk === 'normal') {
    return {
      minReviews: 1,
      reviewers: others,
      signers: proposal.author === 'pm' ? [others[0]].filter(Boolean) : ['pm'],
    };
  }
  return {
    minReviews: Math.max(1, others.length),
    reviewers: others,
    signers: [...roles, 'owner'],
  };
}

function approvedReviews(reviews) {
  return Object.values(reviews || {}).filter((r) => r.verdict === 'approve');
}

function checkApprovals(proposal, team, { forApply = false, stored = false } = {}) {
  const current = requiredSets(proposal, team);
  const req = stored && Array.isArray(proposal.requiredSigners) && proposal.requiredSigners.length
    ? { minReviews: Number(proposal.minReviews || 1), reviewers: proposal.requiredReviewers || current.reviewers, signers: proposal.requiredSigners }
    : current;
  const reviews = loadReviews(proposal.project, proposal.id);
  const sigs = loadSignatures(proposal.project, proposal.id);
  const problems = [];
  const approved = approvedReviews(reviews);
  if (approved.length < req.minReviews) {
    problems.push({ code: 'MISSING_REVIEW', detail: `需要至少 ${req.minReviews} 个非作者批准评审，现有 ${approved.length}` });
  }
  if (forApply && proposal.risk === 'normal' && proposalActiveRoles(proposal, team).length >= 3) {
    const approvedRoles = approved.map((r) => r.role);
    if (approvedRoles.length === 1 && approvedRoles[0] === 'pm' && req.signers.includes('pm')) {
      problems.push({ code: 'NEED_SECOND_REVIEWER', detail: '三人以上团队：PM 不能是唯一评审又唯一签字人，至少再来一名成员评审' });
    }
  }
  for (const role of req.signers) {
    const s = sigs[role];
    if (!s) { problems.push({ code: 'MISSING_SIGNATURE', detail: `缺签字：${role}` }); continue; }
    if (s.decision !== 'approve') problems.push({ code: 'REJECTED_SIGNATURE', detail: `${role} 签字为 ${s.decision}` });
    if (s.proposalHash !== proposal.proposalHash) problems.push({ code: 'STALE_SIGNATURE', detail: `${role} 签字绑定旧提案哈希` });
    const expected = signatureDigest({
      role, proposalId: proposal.id, proposalHash: s.proposalHash, baseHash: s.baseHash,
      newHash: s.newHash, decision: s.decision, ts: s.ts, nonce: s.nonce,
    });
    if (s.sig !== expected) problems.push({ code: 'BAD_SIGNATURE', detail: `${role} 签字摘要不匹配` });
    if (role === 'owner' && s.channel !== 'tty' && !(s.channel === 'selftest' && process.env.TEAM_SELFTEST === '1')) {
      problems.push({ code: 'OWNER_CHANNEL', detail: 'owner 签字必须来自终端批准' });
    }
  }
  return { req, reviews, sigs, problems };
}

// 共享层提案允许的三类根目录（相对仓库根，R-3911）。不在清单内一律 PATH_NOT_ALLOWED。
const SHARED_SCOPE_DIRS = ['团队', 'src', 'scripts'];

/** 仓库根：团队根的上一级（真实运行 = agile-workbench；selftest 沙盘 = 临时根），不另读环境变量猜。 */
function repoRoot() {
  return path.dirname(PATHS.teamRoot);
}

/** 目标真实路径是否仍在 root 内；目标不存在时解析最近存在的父目录，防符号链接逃逸。 */
function realInside(root, abs) {
  let cur = abs;
  const tail = [];
  for (let i = 0; i < 30; i += 1) {
    if (fs.existsSync(cur)) {
      let real = cur;
      try { real = fs.realpathSync(cur); } catch { /* 解析失败按原路径 */ }
      return isInside(root, path.join(real, ...tail));
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  return isInside(root, abs);
}

/**
 * 目标路径校验（R-3911）。
 * - scope=project（默认）：只允许当前项目目录内文件；跨项目/项目外 → PROJECT_SCOPE_VIOLATION。
 * - scope=shared：允许 团队/**、src/**、scripts/**（相对仓库根）；越界 → PATH_OUTSIDE_REPO，
 *   允许清单外 → PATH_NOT_ALLOWED；解析真实路径后仍须在仓库根内（防 ../、绝对路径、符号链接）。
 */
function normalizeTarget(project, target, scope = 'project') {
  const kind = scope === 'shared' ? 'shared' : 'project';
  let t = String(target || '').replace(/\\/g, '/').trim();
  if (!t) fail('BAD_TARGET', '目标文件不能为空');
  const outsideCode = kind === 'shared' ? 'PATH_OUTSIDE_REPO' : 'PROJECT_SCOPE_VIOLATION';
  if (path.isAbsolute(t) || /^[a-zA-Z]:/.test(t) || t.startsWith('/')) {
    fail(outsideCode, `目标必须是${kind === 'shared' ? '相对仓库根' : '项目内'}的相对路径：${target}`);
  }
  t = path.posix.normalize(t);
  if (t === '.' || t === '..' || t.startsWith('../') || t.includes('/../')) {
    fail(outsideCode, `目标越界：${target}`);
  }
  if (kind === 'shared') {
    const root = repoRoot();
    if (!SHARED_SCOPE_DIRS.includes(t.split('/')[0])) {
      fail('PATH_NOT_ALLOWED', `共享层只允许 团队/**、src/**、scripts/**：${target}`, { allowed: SHARED_SCOPE_DIRS });
    }
    if (/(^|\/)(node_modules|\.git|\.team|备份|_backup)(\/|$)/i.test(t)) fail('BAD_TARGET', `目标在禁写目录：${t}`);
    const abs = path.resolve(root, t);
    if (!isInside(root, abs) || !realInside(root, abs)) {
      fail('PATH_OUTSIDE_REPO', `目标解析后不在仓库根内：${target}`, { repoRoot: root });
    }
    if (exists(abs) && fs.statSync(abs).isDirectory()) fail('NOT_A_FILE', `目标是目录不是文件：${target}`);
    return { rel: t, abs, scope: 'shared', root };
  }
  if (/(^|\/)(node_modules|\.git|\.team|备份|_backup)(\/|$)/i.test(t)) fail('BAD_TARGET', `目标在禁写目录：${t}`);
  const abs = path.resolve(project.path, t);
  if (!isInside(project.path, abs) || !realInside(project.path, abs)) {
    fail('PROJECT_SCOPE_VIOLATION', `目标越界（项目外/跨项目）：${target}`);
  }
  // 共享层路径误用 project scope：项目里没有 团队/ 目录时，直接指路 --scope shared。
  // src/、scripts/ 是项目内常见代码目录，不在此提醒，避免误伤项目内新增文件。
  if (t.split('/')[0] === '团队' && !exists(path.join(project.path, '团队'))) {
    fail('PROJECT_SCOPE_VIOLATION', `共享层路径请用 --scope shared：${target}`, { hint: 'propose --scope shared --path <相对仓库根路径>' });
  }
  if (exists(abs) && fs.statSync(abs).isDirectory()) fail('NOT_A_FILE', `目标是目录不是文件：${target}`);
  return { rel: t, abs, scope: 'project', root: project.path };
}

function requiredRisk(project, targetRel) {
  const t = String(targetRel).toLowerCase();
  if (/(^|\/)(\.dsh|profiles|plugins|app\.asar|luanyujia-workbench|shell|dsh_home)(\/|$)/.test(t) || t.includes('dsh_home')) return 'critical';
  if (/(^|\/)(团队|宪法\.md|场景索引\.md|agents\.md|工具|协议|角色|模板|项目索引\.md)(\/|$)/.test(t)) return 'sensitive';
  return 'normal';
}

function parseFiles(args) {
  const specs = asArray(args.file).filter((x) => x !== true).map(String);
  const files = [];
  for (const spec of specs) {
    const i = spec.indexOf('=');
    if (i <= 0) fail('BAD_FILE_SPEC', `--file 格式应为 目标=暂存文件：${spec}`);
    files.push({ target: spec.slice(0, i), staged: spec.slice(i + 1) });
  }
  if (args.target || args.staged) {
    if (!args.target || !args.staged) fail('BAD_FILE_SPEC', '--target 与 --staged 必须同时给');
    files.push({ target: String(args.target), staged: String(args.staged) });
  }
  if (!files.length) fail('NO_FILES', '至少给一个 --file 目标=暂存文件');
  return files;
}

function parseExpect(args) {
  const map = new Map();
  for (const spec of asArray(args.expect).filter((x) => x !== true).map(String)) {
    const i = spec.indexOf('=');
    if (i <= 0) fail('BAD_EXPECT', `--expect 格式应为 目标=哈希：${spec}`);
    map.set(spec.slice(0, i).replace(/\\/g, '/'), spec.slice(i + 1).toLowerCase());
  }
  if (args['expect-base'] && args.target) map.set(String(args.target).replace(/\\/g, '/'), String(args['expect-base']).toLowerCase());
  return map;
}

function resolveStaged(p) {
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  if (!exists(abs)) fail('STAGED_MISSING', `暂存文件不存在：${p}`);
  const st = fs.statSync(abs);
  if (!st.isFile()) fail('STAGED_NOT_FILE', `暂存路径不是文件：${p}`);
  return abs;
}

// 派单先落文件：超过 600 字不再截断，而是拒绝并给出可直接照做的文件路径与五要素。
const DISPATCH_FILE_HINT = {
  file: '项目经理/派单/M-YYYYMMDD-HHmm-<slug>.md',
  fields: ['标题', '任务 id', '任务说明文件路径', '3 条要点', '完成标准'],
  tip: '先把任务说明写成项目内文件，派单只发「标题 + 路径 + 3 条要点 + 完成标准」；不截断、不改写、不投半条。',
};

function messageMaxChars() {
  try { return Number(loadTeam().config.messageMaxChars || 600); } catch { return 600; }
}

/** 程序生成的通知正文超限时只截正文，不截状态；截断必须留痕，不静默。 */
function clipMessage(text, max = messageMaxChars(), marker = '\n…（通知正文已截断，全文见记录文件）') {
  const s = String(text || '');
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - marker.length)) + marker;
}

/** 引用校验：--requirement 只能指向真实存在且 type=requirement 的任务，禁止悬空引用。 */
function assertRequirementRef(project, requirementId) {
  const id = String(requirementId || '').trim();
  if (!id) return '';
  let req = null;
  try { req = loadTask(project, id); } catch { req = null; }
  if (!req) {
    fail('REQUIREMENT_NOT_FOUND', `需求不存在：${id}；先 req create 建需求，或不带 --requirement 建独立任务`, {
      requirementId: id, hint: 'node 团队\\工具\\team.mjs req list --boot <T>',
    });
  }
  if (req.type !== 'requirement') {
    fail('REQUIREMENT_NOT_FOUND', `${id} 不是需求（type=${req.type}），不能挂在 --requirement 上`, {
      requirementId: id, type: req.type, hint: '--requirement 只接受 req create 建的需求 id',
    });
  }
  return id;
}

/** 收件箱“型”列：派单 / 回执 / 通知 三型只在 team.mjs 判一次，壳层与界面读同一份 type。 */
function messageKindOf(msg) {
  const type = String((msg && msg.type) || '').toLowerCase();
  if (type === 'dispatch') return '派单';
  if (type === 'receipt') return '回执';
  return '通知';
}

// 角色“working 幽灵”：任务 claimed/working 但超过 30 分钟没有更新，视为会话已空闲。
// 只在队列 pump 时跳过它，避免 G5 被永久堵死；PM 手动派单仍按严格 G5 判。
const STALE_WORKING_MS = 30 * 60 * 1000;

/** 派单队列文件：PM 上一条派单未回执时，`send --ack --queue` 把下一条排到这里。 */
function dispatchQueuePath(project) {
  return path.join(projectStatePaths(project).dir, '派单队列.json');
}

function readDispatchQueue(project) {
  try {
    const data = readJson(dispatchQueuePath(project));
    return data && Array.isArray(data.items) ? data : { items: [] };
  } catch {
    return { items: [] };
  }
}

function writeDispatchQueue(project, data) {
  ensureDir(path.dirname(dispatchQueuePath(project)));
  writeJson(dispatchQueuePath(project), { items: Array.isArray(data.items) ? data.items : [], updatedAt: nowIso() });
}

function enqueueDispatch(project, item) {
  const queue = readDispatchQueue(project);
  const row = { id: `Q-${stamp()}-${randomHex(2)}`, at: nowIso(), ...item };
  queue.items.push(row);
  writeDispatchQueue(project, queue);
  return row;
}

function removeDispatchQueueItem(project, id) {
  const queue = readDispatchQueue(project);
  const before = queue.items.length;
  queue.items = queue.items.filter((row) => String(row.id) !== String(id));
  writeDispatchQueue(project, queue);
  return before - queue.items.length;
}

// B-20261113-040513-6818（T0 自动唤醒）+ B-20261113-044017-d111（去抖吞光修复）：
// 同一目标 30 秒内不重复刷屏，但**窗口内的事件必须合并后补发一次**（不得零条）；
// 同一任务/消息只唤醒一次；成功记 deliveredAt；失败重试一次；都不成时留在 pending 等 60 秒兜底泵。
// Owner 2026-11-14 08:08 定：取消唤醒合并——每条消息立即唤醒，默认窗口 0；仍可用 TEAM_WAKE_DEBOUNCE_MS 调回。
const WAKE_DEBOUNCE_MS = (() => {
  const raw = Number(process.env.TEAM_WAKE_DEBOUNCE_MS);
  if (process.env.TEAM_WAKE_DEBOUNCE_MS === undefined || !Number.isFinite(raw) || raw < 0) return 0;
  return raw;
})();
const WAKE_RETRY_DELAY_MS = 400;
// R-c651 F-c651-2：失败后的重试节奏（默认 5/15/30 秒各一次）；测试可用 TEAM_WAKE_RETRY_MS 覆盖（如 "0,0,0"）。
const WAKE_RETRY_STAGES_MS = (String(process.env.TEAM_WAKE_RETRY_MS || '5000,15000,30000')
  .split(',')
  .map((n) => Number(n))
  .filter((n) => Number.isFinite(n) && n >= 0));
if (!WAKE_RETRY_STAGES_MS.length) WAKE_RETRY_STAGES_MS.push(5000, 15000, 30000);
const WAKE_RETRY_MAX_ATTEMPT = 3;
/** 唤醒队列落盘（team.mjs 一次调用一个进程，内存状态跨命令不生效，必须持久化）。 */
function wakeQueuePath(project) {
  return path.join(projectStatePaths(project).dir, '唤醒队列.json');
}
function readWakeQueue(project) {
  try {
    const data = readJson(wakeQueuePath(project)) || {};
    // 保留 failed / wakeFailedSent 等附加键：readWakeQueue → writeWakeQueue 的往返不能把这些状态洗掉，
    // 否则看板红点（failed）与告警去重（wakeFailedSent）会在下一次泵/唤醒时丢。
    return {
      ...data,
      targets: data && typeof data.targets === 'object' && data.targets ? data.targets : {},
      delivered: data && typeof data.delivered === 'object' && data.delivered ? data.delivered : {},
    };
  } catch { return { targets: {}, delivered: {} }; }
}
function writeWakeQueue(project, data) {
  try {
    // 已送达表只留最近 24 小时，避免文件膨胀。
    const nowMs = Date.now();
    for (const [key, ts] of Object.entries(data.delivered || {})) {
      if (nowMs - Number(ts) > 24 * 60 * 60 * 1000) delete data.delivered[key];
    }
    writeJson(wakeQueuePath(project), data);
  } catch { /* 状态写失败不阻断唤醒主流程 */ }
}
/** 唤醒留痕：成功/失败/合并待发都写一行到 团队/状态/项目/<P>/唤醒.jsonl（写不了不阻断主流程）。
 *  R-c651 schema：`time` 为主时间字段（与 `at` 同值双写兼容旧读者），另带 attempt/why/source/messageIds。 */
function appendWakeLog(project, row) {
  try {
    const file = path.join(projectStatePaths(project).dir, '唤醒.jsonl');
    const at = nowIso();
    appendLine(file, JSON.stringify({ at, time: at, project: String(project || ''), ...row }));
  } catch { /* 留痕失败不影响唤醒主流程 */ }
}
/** 角色 id → 展示名（B-…e5d6：统一走 团队.json，ROLE_NAMES 只兜底；禁止各处硬编码）。 */
function roleCnName(role) {
  try { return roleDisplayName(role); } catch { return ROLE_NAMES[role] || String(role || '系统'); }
}
/** 唤醒首行归属（B-743e）：所有唤醒/回执/合并唤醒都带这一行，Owner 一眼分清不是自己发的。 */
function wakeHeaderFor(msg, target, { merged = 0 } = {}) {
  return buildWakeHeader({
    fromName: roleCnName(msg && msg.from),
    kind: (msg && (msg.type || msg.kind)) || 'notice',
    toName: roleCnName((msg && msg.to) || target),
    project: String((msg && msg.project) || ''),
    merged: Number(merged) || 0,
  });
}
/** 单次真唤醒（含 mock/测试注入）；返回 null 表示沙盘跳过。 */
async function tryWake({ project, target, batch, isDispatch = false, engineUrl = '', taskRow = null }) {
  // 测试注入优先级最高：显式要求“唤醒失败”时必须返回失败，不能被后面的沙盘跳过吞掉。
  if (String(process.env.TEAM_WAKE_TEST_FAIL || '') === '1') {
    return { ok: false, why: 'TEAM_WAKE_TEST_FAIL（测试注入）', code: 'WAKE_TEST_FAIL' };
  }
  const list = Array.isArray(batch) ? batch : [];
  const head = list[0] || {};
  const pseudoMsg = list.length > 1
    ? {
      id: `WAKE-MERGE-${stamp()}`,
      from: 'system',
      to: target,
      type: 'merge',
      merged: list.length,
      subject: `合并唤醒 ${list.length} 条（${new Date(list[0].at).toISOString()} 起）`,
      // B-743e：合并唤醒逐条标来源（角色+类型+收件人+主题+消息 id），不再只写一条 reason。
      body: list.map((item) => buildWakeLine({
        fromName: roleCnName(item.from),
        kind: item.kind,
        toName: roleCnName(item.to || target),
        subject: item.subject || item.reason || '',
        messageId: item.messageId || '',
      })).join('\n'),
      project,
      task: '',
    }
    : {
      id: head.messageId || `WAKE-${stamp()}`,
      from: head.from || 'system',
      to: target,
      type: head.kind || 'notice',
      subject: head.subject || '唤醒提示',
      body: head.body || head.reason || '',
      project,
      task: '',
    };
  if (process.env.TEAM_WAKE_TEST_FAIL === '1') {
    return { ok: false, why: 'TEAM_WAKE_TEST_FAIL（测试注入）', code: 'WAKE_TEST_FAIL' };
  }
  try {
    // B-3c03：沙盘（TEAM_ROOT 非安装默认根）默认不唤起真实会话，避免沙盘事件串到真实角色；
    // 需要沙盘真唤醒时显式 TEAM_ALLOW_SANDBOX_WAKE=1（自测/演示）。
    // 放在这里（伪消息已构造、测试注入已判过）以保持唤醒文案与留痕口径不变，只掐掉真实 DSH 调用。
    {
      const { isSandboxTeamRoot } = await import('./core.mjs');
      if (isSandboxTeamRoot() && String(process.env.TEAM_ALLOW_SANDBOX_WAKE || '') !== '1') {
        // 不真唤醒，但正文与入口语义照旧（自测/排查要能看见唤醒文案）。
        let text = '';
        try {
          const last = batch[batch.length - 1] || {};
          text = buildNoticePrompt({
            to: target, project, messageId: last.messageId || '', subject: last.subject || '',
            from: last.from || '', teamTool: path.join(PATHS.teamRoot, '工具', 'team.mjs'), body: String(last.body || ''),
          });
        } catch { text = ''; }
        return { ok: true, skipped: 'sandbox_wake_skipped', delivered: false, to: target, merged: batch.length, text, reason: '沙盘根不唤醒真实会话' };
      }
    }
    return await wakeSessionForMessage({ project, to: target, msg: pseudoMsg, isDispatch, engineUrl, taskRow });
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e), code: e && e.code };
  }
}
/**
 * 带守卫的唤醒（B-d111 重写）：
 * - 窗口内：合并进 pending，不单独发（留痕 MERGED_PENDING），窗口结束由 flush/下一次唤醒补发一次；
 * - 窗口外：把 pending + 本次合并成一条发出去，成功记 deliveredAt 并清 pending；
 * - 失败：隔 400ms 重试一次；仍失败则把整批放回 pending（windowStart 清 0，下次立即可试）并留痕；
 * - 同一 dedupeKey（任务/消息）只发一次（ALREADY_DELIVERED）。
 */
export async function wakeWithGuard({ project, to, msg, isDispatch = false, engineUrl = '', taskRow = null, reason = '', dedupeKey = '' }) {
  const target = String(to || '');
  if (!target) return { ok: false, why: '缺少唤醒目标' };
  const nowMs = Date.now();
  const state = readWakeQueue(project);
  const key = String(dedupeKey || (msg && msg.id) || reason || '');
  if (key && state.delivered[key]) {
    appendWakeLog(project, { to: target, messageId: (msg && msg.id) || '', ok: true, skipped: 'ALREADY_DELIVERED', dedupeKey: key });
    return { ok: true, skipped: 'ALREADY_DELIVERED', to: target, dedupeKey: key };
  }
  const t = state.targets[target] || { windowStart: 0, pending: [], attempts: 0 };
  const item = { at: nowMs, dedupeKey: key, reason, messageId: (msg && msg.id) || '', subject: (msg && msg.subject) || '', from: (msg && msg.from) || '', kind: (msg && (msg.type || msg.kind)) || 'notice', to: target, body: truncate(String((msg && msg.body) || ''), 600) };
  // B-7d73（Owner 2026-11-17 19:1x 口径）：合并唤醒**仅限 to=pm 且非派单**；
  // 非 PM 的派单一律立即唤醒，绝不 MERGED_PENDING（否则「派了单没人动」）。
  const mergeAllowed = WAKE_DEBOUNCE_MS > 0 && target === 'pm' && !isDispatch;
  const inWindow = mergeAllowed && Number(t.windowStart) > 0 && nowMs - Number(t.windowStart) < WAKE_DEBOUNCE_MS;
  if (inWindow) {
    t.pending = Array.isArray(t.pending) ? t.pending : [];
    t.pending.push(item);
    state.targets[target] = t;
    writeWakeQueue(project, state);
    appendWakeLog(project, { to: target, messageId: item.messageId, messageIds: [item.messageId].filter(Boolean), ok: false, skipped: 'MERGED_PENDING', pending: t.pending.length, deliverAt: new Date(Number(t.windowStart) + WAKE_DEBOUNCE_MS).toISOString(), reason });
    return { ok: true, skipped: 'MERGED_PENDING', to: target, pending: t.pending.length, deliverAt: Number(t.windowStart) + WAKE_DEBOUNCE_MS };
  }
  const batch = (Array.isArray(t.pending) ? t.pending : []).concat([item]);
  t.pending = [];
  t.windowStart = nowMs;
  t.attempts = 0;
  state.targets[target] = t;
  writeWakeQueue(project, state);
  let result = await tryWake({ project, target, batch, isDispatch, engineUrl, taskRow });
  if (result === null) {
    // 沙盘不真唤醒：算已尝试（不写失败，也不留 pending）；同任务的去重键仍登记，便于测试“只发一次”。
    for (const row of batch) {
      if (row.dedupeKey) state.delivered[row.dedupeKey] = Date.now();
    }
    writeWakeQueue(project, state);
    appendWakeLog(project, { to: target, ok: true, skipped: 'SELFTEST', merged: batch.length, reason, messageIds: batch.map((row) => row.messageId).filter(Boolean).slice(0, 5) });
    // Owner 08:44：沙盘也要能断言“唤醒正文带内容”，所以这里照样生成同一份 notice 文本（不发网络请求）。
    let selftestWakeText = '';
    try {
      const last = batch[batch.length - 1] || {};
      selftestWakeText = buildNoticePrompt({
        to: target, project, messageId: last.messageId || '', subject: last.subject || '',
        from: last.from || '', teamTool: path.join(PATHS.teamRoot, '工具', 'team.mjs'), body: String(last.body || ''),
      });
    } catch { selftestWakeText = ''; }
    return { ok: true, skipped: 'SELFTEST', to: target, merged: batch.length, reason, text: selftestWakeText };
  }
  let retried = false;
  if (result.ok !== true) {
    t.attempts = 1;
    state.targets[target] = t;
    writeWakeQueue(project, state);
    await new Promise((resolve) => setTimeout(resolve, WAKE_RETRY_DELAY_MS));
    retried = true;
    result = await tryWake({ project, target, batch, isDispatch, engineUrl, taskRow });
  }
  if (result && result.ok === true) {
    const deliveredAt = nowIso();
    for (const row of batch) {
      if (row.dedupeKey) state.delivered[row.dedupeKey] = Date.now();
    }
    t.pending = [];
    t.attempts = 0;
    state.targets[target] = t;
    writeWakeQueue(project, state);
    appendWakeLog(project, { to: target, ok: true, deliveredAt, merged: batch.length, retried, reason, messageIds: batch.map((row) => row.messageId).filter(Boolean).slice(0, 5) });
    return { ...(result || {}), ok: true, to: target, merged: batch.length, retried, deliveredAt, reason };
  }
  // R-c651 F-c651-2：两次即时尝试都失败 → 进重试队列（默认 5/15/30 秒），attempt/why 落 唤醒.jsonl。
  const why = String((result && (result.why || result.code)) || '未知');
  const messageIds = batch.map((row) => row.messageId).filter(Boolean).slice(0, 5);
  const first = batch[0] || {};
  t.pending = [];
  t.windowStart = 0;
  t.attempts = 1;
  t.retry = {
    attempt: 1,
    dueAt: Date.now() + WAKE_RETRY_STAGES_MS[0],
    messageIds,
    why,
    lastAt: nowIso(),
    subject: first.subject || '重试唤醒',
    kind: first.kind || 'notice',
  };
  state.targets[target] = t;
  writeWakeQueue(project, state);
  appendWakeLog(project, { to: target, ok: false, why, messageIds, pending: 0, reason, source: 'wake', retried, retryScheduled: 1, nextAt: new Date(t.retry.dueAt).toISOString() });
  return { ok: false, to: target, why, code: 'WAKE_FAILED', attempts: retried ? 2 : 1, attempt: 1, retryAt: t.retry.dueAt, messageIds, retried };
}

/**
 * T-20261117-203046-9ff2：注册「PM 关键消息 → 立即唤醒」钩子（模块加载时执行一次）。
 * 为什么放这里而不是改十余处调用点：所有模块（ops/route-daemon/auto-rotate/handoff/decision-box…）都走 store.sendMessage，
 * 在写盘出口统一挂一次，既覆盖现有全部调用点，也自动覆盖以后新增的代码；
 * 队列泵里的 mailbox_digest 退化为「保险」（漏网消息仍有兜底）。
 * 钩子只在 to=pm 且 type 属关键类型时触发；失败只吞（消息已落邮箱，digest 会补）。
 */
let pmCriticalHookRegistered = false;
function registerPmCriticalWakeHook() {
  if (pmCriticalHookRegistered) return;
  pmCriticalHookRegistered = true;
  try {
    onPmCriticalMessage((msg) => {
      let project = String((msg && msg.project) || '');
      if (!project) {
        try { project = String((loadTeam() && loadTeam().activeProject) || ''); } catch { project = ''; }
      }
      if (!project) return null;
      return wakeWithGuard({ project, to: 'pm', msg, isDispatch: false, reason: `pm_critical:${String((msg && msg.type) || 'notice')}` });
    });
  } catch { /* 注册失败时仍有 digest 兜底 */ }
}
registerPmCriticalWakeHook();

/**
 * R-c651 F-c651-2/3：消化到期的唤醒重试（5/15/30 秒各一次，共 3 次后告警）。
 * 执行者：send/ack 的唤醒路径（命令入口调用一次）+ 兜底泵（queue pump 定时器）。
 * 只读队列、失败不抛错；每次尝试写 唤醒.jsonl（attempt/why/source）。
 */
export async function processWakeRetries(project, { source = 'pump', engineUrl = '' } = {}) {
  const state = readWakeQueue(project);
  const now = Date.now();
  const out = { checked: 0, retried: 0, failed: 0, gaveUp: [], skipped: 0 };
  for (const [target, t] of Object.entries(state.targets || {})) {
    const r = t && t.retry;
    if (!r) continue;
    if (Number(r.dueAt) > now) { out.skipped += 1; continue; }
    out.checked += 1;
    const attempt = Number(r.attempt || 1);
    const messageIds = Array.isArray(r.messageIds) ? r.messageIds : [];
    const batch = (messageIds.length ? messageIds : ['']).map((id) => ({
      messageId: id, kind: r.kind || 'notice', from: 'system', to: target,
      subject: r.subject || '重试唤醒', reason: 'wake_retry',
    }));
    let result = null;
    try { result = await tryWake({ project, target, batch, isDispatch: false, engineUrl }); } catch (e) { result = { ok: false, why: String((e && e.message) || e) }; }
    // 沙盘返回 null = 视为已投递（与 wakeWithGuard 同口径），这样重试幂等/自动已读也能测。
    const retryDelivered = result === null || (result && result.ok === true);
    if (retryDelivered) {
      delete t.retry;
      state.targets[target] = t;
      writeWakeQueue(project, state);
      clearWakeFailed(project, target);
      // Owner 08:44：投递成功即自动标已读（失败才保持未读）。
      for (const mid of messageIds) {
        if (!mid) continue;
        try { readMessage(target, String(mid)); } catch { /* 已读失败不阻断 */ }
      }
      appendWakeLog(project, { to: target, ok: true, attempt, messageIds, source, retried: true, deliveredAt: nowIso() });
      out.retried += 1;
      continue;
    }
    const why = String((result && (result.why || result.code)) || '未知');
    if (attempt >= WAKE_RETRY_MAX_ATTEMPT) {
      delete t.retry;
      state.targets[target] = t;
      writeWakeQueue(project, state);
      markWakeFailed(project, target, { messageId: messageIds[0] || (r.messageId || ''), why, attempt });
      appendWakeLog(project, { to: target, ok: false, attempt, why, messageIds, source, retried: true, gaveUp: true });
      out.failed += 1;
      out.gaveUp.push(target);
      continue;
    }
    const nextAttempt = attempt + 1;
    const delay = WAKE_RETRY_STAGES_MS[Math.min(nextAttempt - 1, WAKE_RETRY_STAGES_MS.length - 1)];
    t.retry = { ...r, attempt: nextAttempt, dueAt: now + delay, why, lastAt: nowIso() };
    state.targets[target] = t;
    writeWakeQueue(project, state);
    appendWakeLog(project, { to: target, ok: false, attempt, why, messageIds, source, retried: true, nextAt: new Date(now + delay).toISOString() });
  }
  return out;
}

/** R-c651 F-c651-3：3 次仍失败 → 看板/审计标 wakeFailed + 给 PM 发一次 type=wake_failed（按 messageId 去重）。 */
function markWakeFailed(project, role, { messageId = '', why = '', attempt = 0 } = {}) {
  const at = nowIso();
  try {
    const dir = projectStatePaths(project).dir;
    ensureDir(dir);
    const boardFile = path.join(dir, '看板.json');
    const board = exists(boardFile) ? (readJson(boardFile) || {}) : {};
    board.wakeFailed = { ...(board.wakeFailed || {}), [role]: { at, messageId, why, attempt } };
    board.updatedAt = at;
    writeJson(boardFile, board);
    // 看板实际读取的是团队级 团队/状态/看板.json（layer 文件），这里同步写一份，红点才看得见。
    const globalBoardFile = path.join(PATHS.state, '看板.json');
    const globalBoard = exists(globalBoardFile) ? (readJson(globalBoardFile) || {}) : {};
    globalBoard.wakeFailed = { ...(globalBoard.wakeFailed || {}), [role]: { at, messageId, why, attempt } };
    globalBoard.updatedAt = at;
    writeJson(globalBoardFile, globalBoard);
    appendLine(path.join(dir, '唤醒失败.json'), JSON.stringify({ at, role, messageId, why, attempt }));
  } catch { /* 标记失败不阻断告警 */ }
  // 红点真相落在唤醒队列（工具自己的状态文件）：team.mjs board 每次会整份重写 看板.json，
  // 只写 看板.json 的红点会被下一次生成冲掉，所以队列里的 failed 才是唯一真相，看板只读它。
  try {
    const queue = readWakeQueue(project);
    queue.failed = { ...(queue.failed || {}), [role]: { at, messageId, why, attempt } };
    writeWakeQueue(project, queue);
  } catch { /* 状态写失败不阻断告警 */ }
  try {
    const state = readWakeQueue(project);
    state.wakeFailedSent = state.wakeFailedSent || {};
    const key = String(messageId || `${role}|${at.slice(0, 16)}`);
    if (!state.wakeFailedSent[key]) {
      const msg = sendMessage({
        from: 'system', to: 'pm', type: 'wake_failed', project,
        subject: `唤醒失败：${roleCnName(role)}（${messageId || '无消息 id'}）`,
        body: `角色：${roleCnName(role)}（${role}）\n消息：${messageId || '无'}\n原因：${why || '未知'}\n已重试：${attempt} 次\n最后尝试：${at}`,
        ackRequired: false,
      });
      state.wakeFailedSent[key] = { at, messageId: msg.id, role };
      writeWakeQueue(project, state);
      appendEvent({ role: 'system', sessionId: '', action: 'wake_failed_alert', project, target: msg.id, note: `to=pm role=${role} why=${String(why).slice(0, 60)}` });
    }
  } catch { /* PM 告警失败保留在 唤醒失败.json 审计 */ }
}
/** 唤醒恢复后清看板红点（不动历史审计）。 */
function clearWakeFailed(project, role) {
  // 先清唯一的真相（唤醒队列 failed），否则下一次 board 会把红点又画回来。
  try {
    const queue = readWakeQueue(project);
    if (queue.failed && queue.failed[role]) {
      delete queue.failed[role];
      writeWakeQueue(project, queue);
    }
  } catch { /* ignore */ }
  try {
    const dir = projectStatePaths(project).dir;
    const boardFile = path.join(dir, '看板.json');
    if (!exists(boardFile)) return;
    const board = readJson(boardFile) || {};    if (board.wakeFailed && board.wakeFailed[role]) {
      delete board.wakeFailed[role];
      board.updatedAt = nowIso();
      writeJson(boardFile, board);
    }
    const globalBoardFile = path.join(PATHS.state, '看板.json');
    if (exists(globalBoardFile)) {
      const gb = readJson(globalBoardFile) || {};
      if (gb.wakeFailed && gb.wakeFailed[role]) {
        delete gb.wakeFailed[role];
        gb.updatedAt = nowIso();
        writeJson(globalBoardFile, gb);
      }
    }
  } catch { /* ignore */ }
}

// ==========================================================================
// R-c651 F-c651-4/5：每角色「未读 / 未回执 / 停滞」+ 一键唤醒 + 全部已读
// 口径＝产品《字段对齐与迁移清单-v2》3.1/3.2/3.4 与需求 c651 F-c651-4：
//   未读   = 消息有 deliveredAt（新字段）且没有 readAt；
//   未回执 = ackRequired 且「已读」（有 readAt 或已在 cur 箱）且回执.jsonl 无该 msgId+from 记录；
//   旧协议 box=new 的旧消息按 M7 迁移视为已读，不计未读、不计未回执，只作 legacyUnread 参考列。
// presenceFor 只读，不写任何文件；一键唤醒/批量已读才写。
// ==========================================================================
const STALL_WARN_MIN = 15;
const STALL_BAD_MIN = 30;

function readingRows() {
  try { return readJsonlTolerant(PATHS.reads).items || []; } catch { return []; }
}
function wakeLogRows(project) {
  const file = path.join(projectStatePaths(project).dir, '唤醒.jsonl');
  if (!exists(file)) return [];
  try { return readJsonl(file) || []; } catch { return []; }
}
/** 消息级读状态（M7：没有 deliveredAt 的旧消息按 ts 迁移为已读，避免一上线全红）。 */
function messageReadState(msg, box) {
  const deliveredAt = String(msg.deliveredAt || '');
  const readAt = String(msg.readAt || '');
  return {
    legacy: !deliveredAt,
    unread: Boolean(deliveredAt) && !readAt,
    readEvidence: Boolean(readAt) || box === 'cur',
    deliveredAt: deliveredAt || String(msg.ts || ''),
  };
}
function readProjectMail(role, project) {
  const rows = [];
  for (const box of ['new', 'cur']) {
    const dir = path.join(PATHS.mail, role, box);
    if (!exists(dir)) continue;
    for (const fname of fs.readdirSync(dir)) {
      if (!fname.endsWith('.json')) continue;
      const file = path.join(dir, fname);
      const msg = readJson(file, null);
      if (!msg || !msg.id) continue;
      if (msg.project && String(msg.project) !== project) continue;
      rows.push({ msg, file, box, state: messageReadState(msg, box) });
    }
  }
  return rows;
}

/** 每角色在场数据（只读）：未读/未回执/停滞分钟/最近活动/wakeFailed 红点。 */
export function presenceFor(project, { roles = [] } = {}) {
  const name = String(project || '');
  if (!name) fail('BAD_PROJECT', '需要项目名');
  const team = loadTeam();
  const wanted = (Array.isArray(roles) && roles.length ? roles : activeMembers(team).map((m) => m.role))
    .map((r) => String(r)).filter(Boolean);
  const receipts = (() => { try { return loadReceipts() || []; } catch { return []; } })();
  const acked = new Set(receipts.map((r) => `${r.msgId || r.messageId || ''}|${r.from || ''}`));
  const reads = readingRows();
  const wakes = wakeLogRows(name);
  const queue = (() => { try { return readWakeQueue(name).failed || {}; } catch { return {}; } })();
  let board = {};
  try { board = readJson(path.join(projectStatePaths(name).dir, '看板.json')) || {}; } catch { board = {}; }
  const now = Date.now();
  return wanted.map((role) => {
    const rows = readProjectMail(role, name);
    const unreadRows = rows.filter((row) => row.state.unread);
    const ackPendingRows = rows.filter((row) => row.msg.ackRequired && row.state.readEvidence
      && !acked.has(`${row.msg.id}|${role}`));
    const legacyUnread = rows.filter((row) => row.state.legacy && row.box === 'new').length;
    // 停滞＝该角色最后一次「阅读 / 回执 / 唤醒」到现在；没有证据就是 null，不补造数字。
    const stamps = [];
    for (const r of reads) {
      if (String(r.role || '') !== role) continue;
      if (r.project && String(r.project) !== name) continue;
      stamps.push(r.at || r.ts);
    }
    for (const r of receipts) {
      if (String(r.from || '') !== role) continue;
      if (r.project && String(r.project) !== name) continue;
      stamps.push(r.ts || r.at);
    }
    for (const w of wakes) {
      if (String(w.to || '') !== role) continue;
      stamps.push(w.time || w.at);
    }
    const times = stamps.map((t) => Date.parse(String(t || ''))).filter((n) => Number.isFinite(n));
    const latest = times.length ? Math.max(...times) : 0;
    const stalledMin = times.length ? Math.max(0, Math.round((now - latest) / 60000)) : null;
    const failed = queue[role] || (board.wakeFailed && board.wakeFailed[role]) || null;
    return {
      role,
      unread: unreadRows.length,
      unreadIds: unreadRows.map((row) => row.msg.id).slice(0, 25),
      ackPending: ackPendingRows.length,
      ackPendingIds: ackPendingRows.map((row) => row.msg.id).slice(0, 25),
      legacyUnread,
      stalledMin,
      stalledLevel: stalledMin === null ? 'none' : (stalledMin > STALL_BAD_MIN ? 'bad' : (stalledMin > STALL_WARN_MIN ? 'warn' : 'ok')),
      lastActivityAt: latest ? new Date(latest).toISOString() : '',
      wakeFailed: Boolean(failed),
      wakeFailedAt: String((failed && failed.at) || ''),
      wakeFailedMessageId: String((failed && failed.messageId) || ''),
      wakeFailedReason: String((failed && failed.why) || ''),
      scanned: rows.length,
    };
  });
}

/** 「全部已读」：只对新字段口径下的未读消息补 readAt，并写 阅读.jsonl（kind=read + messageIds）。 */
export function markReadAll(project, role, { actor = 'owner', source = 'ui-mark-read' } = {}) {
  const name = String(project || '');
  if (!name) fail('BAD_PROJECT', '需要项目名');
  const team = loadTeam();
  const member = getMember(team, role);
  if (!member) fail('BAD_ROLE', `角色不在团队：${role}`);
  const now = nowIso();
  const ids = [];
  for (const row of readProjectMail(role, name)) {
    if (!row.state.unread) continue; // 旧消息按 M7 视为已读：不补字段、不动旧协议箱
    writeJson(row.file, { ...row.msg, readAt: now });
    ids.push(row.msg.id);
  }
  if (ids.length) {
    addReadReceipt({
      role, sessionId: String(member.sessionId || ''), kind: 'read', project: name,
      messageIds: ids, messageId: ids[0], source, actor, at: now,
      proposalId: '', proposalHash: '', baseHash: '',
    });
    appendEvent({
      role: actor === 'owner' ? 'owner' : role, sessionId: String(member.sessionId || ''),
      action: 'mail_mark_read', project: name, target: `${ids.length} 条`,
      note: `source=${source} actor=${actor} ids=${ids.slice(0, 5).join(',')}`,
    });
  }
  return { ok: true, role, count: ids.length, messageIds: ids, at: now, source, actor };
}

/** 一键唤醒：先消化到期重试，再走同一个带守卫的唤醒（失败自动排 5/15/30 秒重试）。 */
export async function wakeRole(project, role, { reason = 'ui', from = 'system', engineUrl = '' } = {}) {
  const name = String(project || '');
  if (!name) fail('BAD_PROJECT', '需要项目名');
  const team = loadTeam();
  const member = getMember(team, role);
  if (!member || member.status !== 'active') fail('NO_RECIPIENT', `角色不在团队或未激活：${role}`);
  if (!member.sessionId) fail('SESSION_MISSING', `角色还没有 DSH 会话，无法唤醒：${role}`, { role });
  let retry = null;
  try { retry = await processWakeRetries(name, { source: 'ui', engineUrl }); } catch { retry = null; }
  const wake = await wakeWithGuard({
    project: name, to: role, isDispatch: false, engineUrl,
    msg: { id: `WAKE-UI-${stamp()}`, from, to: role, type: 'notice', subject: '界面一键唤醒', project: name, task: '' },
    reason: `ui:${reason}`,
  });
  return { ok: Boolean(wake && wake.ok === true), role, wake, retry, at: nowIso() };
}

/**
 * B-719f：给“直接写邮箱”的入口（owner-note.mjs 等）用的唤醒出口。
 * 与 cmdSend 同口径：合并窗口 + 失败重试 5/15/30 秒 + 3 次仍失败给 PM 发 wake_failed；
 * 但不做 wakeRole 的前置检查（没有会话时交给 wake_failed 告警，而不是静默 throw），
 * 这样「通知写进邮箱但没人被叫醒」不会再发生。
 */
export async function wakeMailboxRecipient(project, role, { reason = 'mail', subject = '新消息', messageId = '', engineUrl = '' } = {}) {
  const name = String(project || '');
  if (!name) fail('BAD_PROJECT', '需要项目名');
  const target = String(role || '').trim();
  if (!target) fail('BAD_ROLE', '需要收件角色');
  if (target === 'system') return { ok: true, skipped: 'SYSTEM_TARGET', to: target };
  // 用真实消息 id（不是合成 id）：唤醒正文会写“read --id <id>”，合成 id 在邮箱里读不到。
  const id = String(messageId || '').trim() || `WAKE-MAIL-${stamp()}-${randomHex(2)}`;
  const wake = await wakeWithGuard({
    project: name, to: target, isDispatch: false, engineUrl,
    msg: {
      id,
      from: 'system', to: target, type: 'notice',
      subject: String(subject || '新消息').slice(0, 80), project: name, task: '',
    },
    reason: String(reason || 'mail').slice(0, 60),
    dedupeKey: '',
  });
  return { ok: Boolean(wake && wake.ok === true), to: target, messageId: id, wake, at: nowIso() };
}

/**
 * 兜底补发（B-d111）：把窗口已结束、仍留在 pending 的唤醒合并成一条发出去。
 * 由 `queue pump`（工作台 60 秒定时器）与每次 send/task done 的守卫调用，保证「窗口结束必发一次」。
 */
async function flushPendingWakes(project, { engineUrl = '' } = {}) {
  const state = readWakeQueue(project);
  const nowMs = Date.now();
  let flushed = 0;
  let failed = 0;
  for (const [target, t] of Object.entries(state.targets || {})) {
    if (!t || !Array.isArray(t.pending) || !t.pending.length) continue;
    const windowOver = !Number(t.windowStart) || nowMs - Number(t.windowStart) >= WAKE_DEBOUNCE_MS;
    if (!windowOver) continue;
    const batch = t.pending.slice();
    const result = await tryWake({ project, target, batch, isDispatch: false, engineUrl });
    if (result === null) {
      // 沙盘：算已尝试，清 pending；去重键同样登记（与 wakeWithGuard 沙盘分支保持一致）。
      for (const row of batch) if (row.dedupeKey) state.delivered[row.dedupeKey] = Date.now();
      t.pending = [];
      state.targets[target] = t;
      appendWakeLog(project, { to: target, ok: true, skipped: 'SELFTEST', merged: batch.length, source: 'flush' });
      continue;
    }
    if (result && result.ok === true) {
      for (const row of batch) if (row.dedupeKey) state.delivered[row.dedupeKey] = Date.now();
      t.pending = [];
      t.windowStart = Date.now();
      t.attempts = 0;
      state.targets[target] = t;
      flushed += 1;
      appendWakeLog(project, { to: target, ok: true, deliveredAt: nowIso(), merged: batch.length, source: 'flush' });
    } else {
      t.attempts = Number(t.attempts || 0) + 1;
      t.windowStart = 0;
      state.targets[target] = t;
      failed += 1;
      appendWakeLog(project, { to: target, ok: false, why: String((result && (result.why || result.code)) || '未知'), attempts: t.attempts, pending: batch.length, source: 'flush' });
    }
  }
  writeWakeQueue(project, state);
  return { ok: true, flushed, failed };
}

/**
 * 唤醒目标角色会话（派单/通知共用）。
 * selftest 下只返回 null（不真唤醒）；缺会话/缺 engineUrl 时返回可诊断对象，不阻断主流程。
 */
async function wakeSessionForMessage({ project, to, msg, isDispatch = true, engineUrl = '', taskRow = null }) {
  if (process.env.TEAM_SELFTEST) return null;
  const target = getMember(loadTeam(), to);
  const sessionId = target && target.sessionId;
  if (!sessionId) return { ok: false, why: '目标角色还没有 DSH 会话' };
  let engine = String(engineUrl || '') || process.env.DSH_WEB_URL || '';
  if (!engine) {
    try { engine = readJson(path.join(PATHS.state, '当前工作区.json')).engineUrl || ''; } catch { /* none */ }
  }
  if (!engine) return { ok: false, why: '没有 engineUrl；无法唤醒目标会话' };
  const projectPath = (() => { try { return loadProject(project).path; } catch { return project; } })();
  const teamTool = path.join(PATHS.teamRoot, '工具', 'team.mjs');
  let taskTitle = '';
  if (msg.task) {
    try { taskTitle = loadTask(project, String(msg.task)).title || ''; } catch { /* 任务不存在也照样派单，正文仍可见 */ }
  }
  const baseText = isDispatch
    ? buildDispatchPrompt({
      to,
      project,
      projectPath,
      roleDir: ROLE_DIRS[to] || to,
      codeDir: (to === 'programmer1' || to === 'programmer2') ? 'site' : '',
      messageId: msg.id,
      subject: msg.subject,
      taskId: msg.task || '',
      taskTitle,
      teamTool,
      readingList: readingListFor(projectPath, to, taskRow),
    })
    : buildNoticePrompt({
      to, project, messageId: msg.id, subject: msg.subject, from: msg.from || '', teamTool, body: String((msg && msg.body) || ''),
    });
  // B-743e：首行统一归属（系统消息·非Owner·来自谁·什么类型·发给谁），正文前保留原消息 id。
  const header = wakeHeaderFor(msg, to, { merged: Number(msg.merged) || 0 });
  const idLine = msg.id ? `消息 id：${msg.id}` : '';
  const text = `${header}\n${idLine ? idLine + '\n' : ''}${baseText}`;
  try {
    const client = new DshClient(engine);
    await client.prompt({ sessionId, text, mode: 'queue' });
    return { ok: true, role: to, sessionId, kind: isDispatch ? 'dispatch' : 'notice', text };
  } catch (e) {
    return { ok: false, why: e.message, code: e.code || '' };
  }
}

/** 已唤醒的 messageId 集合（读 唤醒.jsonl 的 messageId / messageIds；坏行跳过不抛）。 */
function wokenMessageIdsOf(project) {
  const set = new Set();
  try {
    const file = path.join(projectStatePaths(project).dir, '唤醒.jsonl');
    if (!fs.existsSync(file)) return set;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row = null;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row) continue;
      if (row.messageId) set.add(String(row.messageId));
      if (Array.isArray(row.messageIds)) for (const id of row.messageIds) if (id) set.add(String(id));
    }
  } catch { /* 读不到就当没有已唤醒记录（宁可多唤醒一次也不漏） */ }
  return set;
}

/**
 * B-20261117-201316-1441：PM 邮箱补唤醒（mailbox_digest）。
 *
 * 根因：各模块直接 sendMessage({to:'pm', type:'escalation'|'wake_failed'|'req_review'}) 只写邮箱、不唤醒 PM
 * （今日实测 504 条无对应唤醒）。这里在队列泵每拍兜底：扫 pm/new 里 **age<15 分钟且 messageId 不在唤醒日志** 的消息，
 * 合并成 **1 条** to=pm 唤醒（reason=mailbox_digest，含条数 / 类型分布 / 前 3 条摘要），
 * dedupeKey = `mailbox_digest:<id 列表哈希>`；同 messageId 不重复（第二次调用因已进唤醒日志而不再发）。
 * 只读邮箱 + 写唤醒日志/队列，不发消息、不改邮箱状态。
 */
export async function pmMailboxDigest(project, { now = Date.now(), maxAgeMs = 15 * 60 * 1000, limit = 60, engineUrl = '' } = {}) {
  const name = String(project || '');
  if (!name) return { ok: false, code: 'PROJECT_REQUIRED', message: '需要项目名' };
  let inbox = [];
  try { inbox = listInbox('pm', { project: '' }); } catch { inbox = []; }
  const woken = wokenMessageIdsOf(name);
  // B-3c45（PM 插队修 2026-11-17 20:30）：摘要按 messageId 持久去重。
  // 旧实现只写唤醒日志（日志里是合成 digest id，不含被摘要消息 id），导致同一批消息每拍重复唤醒。
  // 这里落盘 邮箱摘要已通知.json：同一 messageId 24h 内只进摘要一次；已 read（有 readAt）的不再进摘要。
  const notifiedFile = path.join(projectStatePaths(name).dir, '邮箱摘要已通知.json');
  let notified = {};
  try { const raw = readJson(notifiedFile, {}); notified = (raw && typeof raw === 'object' && raw.ids) ? raw.ids : {}; } catch { notified = {}; }
  const pruneBefore = now - 24 * 3600 * 1000;
  for (const [id, entry] of Object.entries(notified)) {
    // B-3c45：台账条目是 { at, messageId, type }，同时兼容上一版直接写 ISO 字符串的形状。
    // 剪枝必须 Date.parse 兜底（只 Number() 会得 NaN → 每拍把有效条目全删掉，去重静默失效）。
    const at = (entry && typeof entry === 'object') ? entry.at : entry;
    const raw = Number(at);
    const t = Number.isFinite(raw) && raw > 0 ? raw : Date.parse(String(at || ''));
    if (!Number.isFinite(t) || t < pruneBefore) delete notified[id];
  }
  const fresh = [];
  for (const msg of inbox) {
    if (!msg || !msg.id) continue;
    const id = String(msg.id);
    if (woken.has(id) || notified[id]) continue;
    if (msg.readAt || msg.ackAt) continue; // 已读/已回执的不再进摘要
    const atMs = Date.parse(String(msg.ts || msg.deliveredAt || ''));
    if (!Number.isFinite(atMs) || now - atMs > maxAgeMs) continue;
    fresh.push(msg);
  }
  if (!fresh.length) return { ok: true, project: name, pending: 0, woken: 0, reason: 'mailbox_digest' };
  fresh.sort((a, b) => Date.parse(String(a.ts || '')) - Date.parse(String(b.ts || '')));
  const picked = fresh.slice(0, limit);
  const byType = {};
  for (const msg of picked) {
    const type = String(msg.type || msg.kind || 'note');
    byType[type] = (byType[type] || 0) + 1;
  }
  const typeText = Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(' / ');
  const head3 = picked.slice(0, 3).map((msg) => `· ${roleCnName(String(msg.from || 'system'))}·${String(msg.type || 'note')}：${truncate(String(msg.subject || '(无主题)'), 60)}`);
  const ids = picked.map((msg) => String(msg.id));
  const body = [
    `PM 邮箱有 ${picked.length} 条未唤醒的消息（窗口 15 分钟）${fresh.length > picked.length ? `，另有 ${fresh.length - picked.length} 条排队下一拍` : ''}。`,
    `类型分布：${typeText || '未知'}`,
    '前几条：',
    ...head3,
    '（这是队列泵的兜底唤醒，避免系统/升级/评审消息只落邮箱不叫人；逐条正文用 team.mjs inbox --all 或 read --id 看。）',
  ].join('\n');
  const wake = await wakeWithGuard({
    project: name,
    to: 'pm',
    isDispatch: false,
    engineUrl,
    reason: 'mailbox_digest',
    // 口径文件第③条：dedupeKey 要稳定（不随 id 列表抖动）。这里用「小时 + 本批第一条 id」：
    // 同一批重跑 key 相同（被 delivered 去重），有新增消息时批首变化 → 仍会叫一次（否则新消息会被吞）。
    dedupeKey: `mailbox_digest:${new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 13).replace(/[-T]/g, '')}:${ids[0]}`,
    msg: {
      // 唤醒日志的 messageIds 取自 msg.id：单条直接用原消息 id（可直接回查），多条把 id 列表写进 id。
      id: ids.length === 1 ? ids[0] : `WAKE-DIGEST-${ids.length}:${ids.join(',')}`,
      from: 'system',
      to: 'pm',
      type: 'notice',
      subject: `PM 邮箱未唤醒消息 ${picked.length} 条（${typeText || '未知'}）`,
      body,
      project: name,
    },
  });
  // 唤醒发出后（ok 或 SELFTEST）把被摘要的 messageId 落盘：{ at, messageId, type }（口径文件第①条），
  // 同一 messageId 24h 内只进摘要一次，这是「重复唤醒」的真正闸门（不靠 dedupeKey）。
  if (wake && (wake.ok === true || wake.skipped === 'SELFTEST')) {
    const at = nowIso();
    for (const msg of picked) {
      notified[String(msg.id)] = { at, messageId: String(msg.id), type: String(msg.type || msg.kind || 'note') };
    }
    try { writeJson(notifiedFile, { updatedAt: at, ids: notified }); } catch { /* 写失败下次仍会去重失败，但不阻断唤醒 */ }
  }
  return { ok: true, project: name, pending: fresh.length, woken: picked.length, messageIds: ids.slice(0, 5), byType, wake };
}

/**
 * 统一入口：给 PM 发消息并立刻唤醒（新代码禁止裸 sendMessage({to:'pm'})）。
 * 迁移期：老调用点未改也能被 pmMailboxDigest 兜底（≤60 秒一次合并唤醒）。
 */
export async function sendToPmWithWake(project, { subject = '', body = '', type = 'notice', engineUrl = '', reason = '' } = {}) {
  const name = String(project || '');
  if (!name) return { ok: false, code: 'PROJECT_REQUIRED' };
  const msg = sendMessage({ from: 'system', to: 'pm', project: name, type, subject, body });
  const wake = await wakeWithGuard({ project: name, to: 'pm', msg, isDispatch: false, engineUrl, reason: reason || `send_to_pm:${type}` });
  return { ok: true, messageId: msg.id, type, wake };
}

/**
 * 队列续跑：角色完成后自动取该角色下一条排队派单（send --ack --queue 入队）。
 * 目标角色仍忙（G5）则保留队列并返回 blocked；working 幽灵满 30 分钟不占名额。
 */
export async function pumpDispatchQueue(project, { role = '', source = 'tick' } = {}) {
  // B-20261117-201316-1441：每拍先兜底补唤醒 PM 邮箱（系统/升级/评审消息只写邮箱不唤醒 → 504 条漏讯）。
  // 失败只记 warning，绝不阻断派单泵。
  let mailboxDigest = null;
  try { mailboxDigest = await pmMailboxDigest(project); } catch (e) { mailboxDigest = { ok: false, why: String((e && e.message) || e).slice(0, 200) }; }
  // R-1dfb：审计第 12 键 source ∈ {deadline,tick}（deadline=到期定时器，tick=60 秒兜底）；非法值按 tick 记。
  const pumpSource = source === 'deadline' ? 'deadline' : 'tick';
  // B-384e：队列泵不受已过期派单锁影响——先释放过期锁再判角色忙闲。
  const expiredLock = releaseExpiredDispatchLock(project, { source: 'pump' });
  // B-405f ②：目标会话无活性的 pending 锁也在这里清（泵是定时入口，覆盖 PM 不操作的时间段）。
  await releaseInactiveDispatchLock(project, { source: 'pump' });
  const queue = readDispatchQueue(project);
  // B-d120（2026-11-17）：已收口任务（done/accepted/cancelled/terminated）的队列条目不得再投递——
  // 历史入队遗留的条目在投递前统一清掉（带审计、不静默），否则每拍都会重投，表现为「永远 pending + delivered 审计翻倍」。
  try {
    const closedTaskIds = new Set(
      listTasks(project).filter((t) => t && statusIsClosed(String(t.status || ''))).map((t) => String(t.id || '')),
    );
    if (closedTaskIds.size) {
      const dropped = queue.items.filter((it) => it && it.task && closedTaskIds.has(String(it.task)));
      if (dropped.length) {
        queue.items = queue.items.filter((it) => !(it && it.task && closedTaskIds.has(String(it.task))));
        writeDispatchQueue(project, queue);
        for (const it of dropped) {
          try {
            appendDeliveryAudit(project, {
              itemId: it.id, to: String(it.to || ''), taskId: String(it.task || ''),
              attempt: Number(it.attempt) || 1, result: 'skipped', code: 'TASK_CLOSED_DROPPED',
              stallMs: 0, messageId: '', wakeOk: false, source: pumpSource,
            });
          } catch { /* 审计失败不阻断清理 */ }
          appendEvent({ role: 'system', action: 'dispatch_queue_dropped_closed', project, target: String(it.id),
            note: `task=${it.task} to=${it.to || ''} code=TASK_CLOSED_DROPPED` });
        }
      }
    }
  } catch { /* 清理失败不阻断泵 */ }
  if (!queue.items.length) return { ok: true, pumped: false, reason: 'EMPTY', remaining: 0 };
  const roleKey = String(role || '');
  // 指定角色：只看它的第一项；role=''（兜底泵）：遍历队列，找第一个“角色已空闲”的项。
  const candidates = roleKey
    ? queue.items.filter((item) => String(item.to) === roleKey).slice(0, 1)
    : queue.items.slice();
  if (!candidates.length) return { ok: true, pumped: false, reason: 'NO_ITEM_FOR_ROLE', remaining: queue.items.length };
  let firstBlocked = null;
  let item = null;
  let idleBackfill = null;
  const pumpNow = Date.now();
  for (const candidate of candidates) {
    const busy = gateRoleBusy({
      role: String(candidate.to || ''),
      tasks: listTasks(project),
      locks: listLocks().filter((lock) => !lock.stale),
      excludeTaskIds: candidate.task ? [String(candidate.task)] : [],
      // R-1dfb F3（忙判定分层）：泵只处理「有队列项等待的角色」——忙上限降为投递 deadline（5 分钟）；
      // 无队列项时的角色忙判定（G5 / runDispatchGates）仍走 STALE_WORKING_MS(30 分钟)，门禁一行不改。
      staleWorkingMs: DISPATCH_QUEUE_IDLE_BACKFILL_MS,
    });
    if (busy) {
      // B-20261116-104231-4c6f：滞留超阈值 + 目标角色确实空闲（无提交/无文件写入/无 ack/无近期 working）
      // → 不再被「角色忙」无限挡住，直接补投（等价 send 唤醒），并留审计。
      const atMs = Date.parse(String(candidate.at || ''));
      const ageMs = Number.isFinite(atMs) ? pumpNow - atMs : -1;
      if (DISPATCH_QUEUE_IDLE_BACKFILL_MS >= 0 && ageMs >= DISPATCH_QUEUE_IDLE_BACKFILL_MS) {
        let evidence = null;
        try { evidence = roleActivityEvidence(project, String(candidate.to || ''), { now: pumpNow }); } catch { evidence = null; }
        if (evidence && evidence.idle) {
          item = candidate;
          idleBackfill = { evidence, ageMs, busyCode: String(busy.code || '') };
          break;
        }
        if (!firstBlocked) firstBlocked = { busy, item: candidate, evidence };
        if (roleKey) break;
        continue;
      }
      if (!firstBlocked) firstBlocked = { busy, item: candidate };
      // 指定角色：保持原语义，立刻返回 blocked；兜底模式：继续找下一个空闲角色。
      if (roleKey) break;
      continue;
    }
    item = candidate;
    break;
  }
  if (!item) {
    const busy = firstBlocked ? firstBlocked.busy : { code: 'QUEUE_BLOCKED', message: '队列项对应角色都忙' };
    const blockedItem = firstBlocked ? firstBlocked.item : candidates[0];
    appendEvent({ role: 'system', action: 'dispatch_queue_blocked', project, target: String(blockedItem.id), note: `${busy.code} ${String(busy.message || '').slice(0, 120)}` });
    return { ok: true, pumped: false, reason: busy.code, blocked: busy, item: blockedItem, remaining: queue.items.length };
  }
  // B-405f ①：泵单前也探活；拉不起来就把队列项原样保留（不丢单、不占锁），留给下次修复后重泵。
  try {
    await ensureDispatchTargetAlive(project, String(item.to || ''));
  } catch (e) {
    appendEvent({
      role: 'system', action: 'dispatch_queue_blocked', project, target: String(item.id),
      note: `${e.code || 'TARGET_UNREACHABLE'} ${String(e.message || '').slice(0, 120)}`,
    });
    // R-1dfb 卷 §三 blocked：探活失败/会话不可用 → 状态 blocked + 12 键审计（队列项原样保留，不丢单）。
    try {
      const blockedCode = String(e.code || 'TARGET_SESSION_UNREACHABLE');
      const prevAttempt = Number((readDeliveryState(project).items[item.id] || {}).attempt) || Number(item.attempt) || 1;
      markDeliveryState(project, item.id, { state: 'blocked', attempt: prevAttempt, lastAt: nowIso(), lastCode: blockedCode });
      const atMs = Date.parse(String(item.at || ''));
      appendDeliveryAudit(project, {
        itemId: item.id, to: String(item.to || ''), taskId: String(item.task || ''), attempt: prevAttempt,
        result: 'blocked', code: blockedCode,
        stallMs: Number.isFinite(atMs) ? Math.max(0, Date.now() - atMs) : 0,
        messageId: '', wakeOk: false, source: pumpSource,
      });
    } catch { /* 状态/审计写失败不阻断重泵 */ }
    return {
      ok: true, pumped: false, reason: e.code || 'TARGET_SESSION_UNREACHABLE',
      blocked: { code: e.code || 'TARGET_SESSION_UNREACHABLE', message: String(e.message || '') },
      item, remaining: readDispatchQueue(project).items.length,
    };
  }
  // B-80bc（2026-11-17）：唤醒失败保留队列项后，到期重投必须复用原消息快照——不再调 notify，
  // 否则每重投一次就往邮箱多塞一条重复消息。未到期则本拍不动它（等下一拍）。
  const wakeRetryDueMs = Date.parse(String(item.wakeRetryAt || ''));
  if (item.wakeMsg && item.wakeMsg.id && Number.isFinite(wakeRetryDueMs) && wakeRetryDueMs > Date.now()) {
    return { ok: true, pumped: false, reason: 'WAKE_RETRY_WAIT', item, remaining: readDispatchQueue(project).items.length };
  }
  const msg = (item.wakeMsg && item.wakeMsg.id) ? item.wakeMsg : notify({
    from: String(item.from || 'pm'),
    to: String(item.to || ''),
    subject: String(item.subject || '(无主题)'),
    body: String(item.body || ''),
    project,
    task: String(item.task || ''),
    ackRequired: true,
    type: 'dispatch',
    sessionId: String(item.sessionId || ''),
  });
  // B-6c50 / B-d3a1（PM 2026-11-17 12:08 批准，12:13 分工归 A）：自动重派**不得写 PM 派单锁**——
  // 以前这里 writeDispatchLock() 会占住 PM 正式派单（实测 10:24:32/10:25:32 两条自动重派 → PM_DISPATCH_PENDING）。
  // 自动通道改为：消息标 source=auto/trigger，投递审计 result=delivered + code=SOURCE_AUTO + source=auto（必须命中枚举）。
  const autoReason = String(item.reason || 'stalled_role');
  msg.source = 'auto';
  msg.trigger = autoReason;
  try {
    appendDeliveryAudit(project, {
      itemId: item.id, to: String(item.to || ''), taskId: String(item.task || ''),
      attempt: Number(item.attempt) || 1, result: 'delivered', code: 'SOURCE_AUTO', // 不扩枚举：用 code/source 区分自动重派
      stallMs: Number.isFinite(Date.parse(String(item.at || ''))) ? Math.max(0, Date.now() - Date.parse(String(item.at || ''))) : 0,
      messageId: String(msg.id || ''), wakeOk: false, source: 'auto',
    });
  } catch (e) {
    // PM 2026-11-17 12:48 改批：审计失败不静默，用 appendEvent 兜底留痕（可查），console.error 同时打。
    console.error('[audit] auto dispatch audit failed: ' + (e && (e.code || e.message) || e));
    try { appendEvent({ role: 'system', action: 'audit_write_failed', project, target: String(item.id || ''), note: `auto dispatch audit failed: ${String((e && (e.code || e.message)) || e).slice(0, 160)}` }); } catch { /* 事件也失败则放弃 */ }
  }
  const wake = await wakeSessionForMessage({ project, to: String(item.to || ''), msg, isDispatch: true });
  // B-80bc（2026-11-17）：唤醒失败**不得静默出队**（缺陷单 §六 根因 2/3/4）。
  // 口径：失败 → 保留队列项 + attempt+1 + 退避重投（复用消息快照，不重复 notify）；
  // 达到 WAKE_RETRY_MAX_ATTEMPT 次仍失败 → 出队转 blocked + 结构化错误码 WAKE_FAILED_MAX_ATTEMPTS + 给 PM 发 wake_failed（不静默）。
  // 沙盘（wakeSessionForMessage 返回 null）按「已跳过、不算失败」记，与既有 wakeFailed 判据同口径。
  const atMs = Date.parse(String(item.at || ''));
  const stallMs = Number.isFinite(atMs) ? Math.max(0, Date.now() - atMs) : 0;
  const prevRow = readDeliveryState(project).items[item.id] || null;
  const prevAttempt = Number((prevRow && prevRow.attempt) || item.attempt) || 1;
  const prevState = String((prevRow && prevRow.state) || '');
  const wakeSkipped = wake === null;
  const wakeOk = wakeSkipped ? true : Boolean(wake && wake.ok === true);
  const wakeCode = wakeOk ? '' : String((wake && (wake.code || wake.why)) || 'WAKE_NOT_OK');
  if (!wakeOk) {
    const role = String(item.to || '');
    const nextAttempt = prevAttempt + 1;
    if (nextAttempt >= WAKE_RETRY_MAX_ATTEMPT) {
      // 重试耗尽：出队 → blocked + 审计 + PM 告警（markWakeFailed 会按 messageId 去重发 type=wake_failed）。
      removeDispatchQueueItem(project, item.id);
      try {
        markDeliveryState(project, item.id, { state: 'blocked', attempt: nextAttempt, lastAt: nowIso(), lastCode: 'WAKE_FAILED_MAX_ATTEMPTS' });
        appendDeliveryAudit(project, {
          itemId: item.id, to: role, taskId: String(item.task || ''), attempt: nextAttempt,
          result: 'blocked', code: 'WAKE_FAILED_MAX_ATTEMPTS', stallMs,
          messageId: String(msg.id || ''), wakeOk: false, source: pumpSource,
        });
      } catch { /* 状态/审计写失败不阻断告警 */ }
      markWakeFailed(project, role, { messageId: String(msg.id || ''), why: wakeCode, attempt: nextAttempt });
      appendEvent({ role: 'system', action: 'dispatch_wake_exhausted', project, target: String(item.id),
        note: `to=${role} attempts=${nextAttempt} code=WAKE_FAILED_MAX_ATTEMPTS why=${wakeCode.slice(0, 60)}` });
      return { ok: false, pumped: true, reason: 'WAKE_FAILED_MAX_ATTEMPTS', item, wakeOk: false, code: wakeCode, attempts: nextAttempt, remaining: readDispatchQueue(project).items.length };
    }
    // 未耗尽：队列项保留 + 写回重投快照与到期时间；本次不外发新消息（复用 msg.id）。
    const delayMs = WAKE_RETRY_STAGES_MS[Math.min(nextAttempt - 1, WAKE_RETRY_STAGES_MS.length - 1)] || 5000;
    try {
      const queue = readDispatchQueue(project);
      const row = queue.items.find((it) => String(it.id) === String(item.id));
      if (row) {
        row.attempt = nextAttempt;
        row.wakeRetryAt = new Date(Date.now() + delayMs).toISOString();
        row.wakeMsg = { id: msg.id, from: msg.from, to: msg.to, subject: msg.subject, body: msg.body, task: msg.task, sessionId: msg.sessionId };
        writeDispatchQueue(project, queue);
      }
      markDeliveryState(project, item.id, { state: 'stalled', attempt: nextAttempt, lastAt: nowIso(), lastCode: wakeCode || 'WAKE_RETRY_SCHEDULED' });
      appendDeliveryAudit(project, {
        itemId: item.id, to: role, taskId: String(item.task || ''), attempt: nextAttempt,
        result: 'retry', code: 'WAKE_RETRY_SCHEDULED', stallMs,
        messageId: String(msg.id || ''), wakeOk: false, source: pumpSource,
      });
      appendEvent({ role: 'system', action: 'dispatch_wake_retry', project, target: String(item.id),
        note: `to=${role} attempt=${nextAttempt} code=${wakeCode.slice(0, 60)} retryInMs=${delayMs}` });
    } catch { /* 写回失败也不阻断（下一拍整队重算） */ }
    return { ok: false, pumped: true, reason: 'WAKE_RETRY_SCHEDULED', item, wakeOk: false, code: wakeCode, attempts: nextAttempt, retryInMs: delayMs, remaining: readDispatchQueue(project).items.length };
  }
  removeDispatchQueueItem(project, item.id);
  appendEvent({ role: 'system', action: 'dispatch_pump', project, target: msg.id, note: `queue=${item.id} to=${item.to} task=${item.task || ''}` });
  // R-1dfb F1/F4：投递成功 → 状态 delivered + 12 键审计（wakeOk 记唤醒是否成功，失败码记 code）。
  try {
    // 到期/阻塞/升级后的再次投递：先留一行 retry（卷 §八 result 枚举；重投不算首次 delivered）。
    if (['stalled', 'blocked', 'upgraded'].includes(prevState)) {
      appendDeliveryAudit(project, {
        itemId: item.id, to: String(item.to || ''), taskId: String(item.task || ''), attempt: prevAttempt,
        result: 'retry', code: prevState === 'blocked' ? 'RETRY_AFTER_BLOCKED'
          : (prevState === 'upgraded' ? 'RETRY_AFTER_UPGRADED' : 'RETRY_AFTER_STALL'),
        stallMs, messageId: '', wakeOk: false, source: pumpSource,
      });
    }
    markDeliveryState(project, item.id, { state: 'delivered', attempt: prevAttempt, lastAt: nowIso(), lastCode: wakeCode });
    appendDeliveryAudit(project, {
      itemId: item.id, to: String(item.to || ''), taskId: String(item.task || ''), attempt: prevAttempt,
      result: 'delivered', code: wakeCode, stallMs,
      messageId: String(msg.id || ''), wakeOk, source: pumpSource,
    });
  } catch { /* 状态/审计写失败不阻断投递 */ }
  // 卷 §十：出队即清该 item 的全部告警 level 键（避免 24 小时去重被旧键长期占用）。
  try { clearQueueAlertLevels(project, item.id); } catch { /* 清标失败不影响投递 */ }
  // B-4c6f：补投留审计（append-only，含活跃度证据；重复投递由「投递成功即移除队列项」天然避免）。
  if (idleBackfill) {
    const row = {
      at: nowIso(),
      queueId: String(item.id || ''),
      to: String(item.to || ''),
      reason: 'idle_backfill',
      ageSec: Math.round(Number(idleBackfill.ageMs || 0) / 1000),
      blockedBy: idleBackfill.busyCode,
      messageId: String(msg.id || ''),
      evidence: idleBackfill.evidence,
    };
    try { appendLine(dispatchQueueBackfillFile(project), JSON.stringify(row)); } catch { /* 审计失败不阻断投递 */ }
    try {
      appendEvent({
        role: 'system', action: 'dispatch_queue_idle_backfill', project, target: String(item.id),
        note: `to=${item.to} age=${row.ageSec}s blockedBy=${row.blockedBy} ${String(idleBackfill.evidence && idleBackfill.evidence.detail || '').slice(0, 160)}`,
      });
    } catch { /* ignore */ }
  }
  return { ok: true, pumped: true, item, message: msg, wake, remaining: readDispatchQueue(project).items.length, idleBackfill: Boolean(idleBackfill), evidence: idleBackfill ? idleBackfill.evidence : null };
}

/**
 * B-20261113-005705-a577：队列死锁修复的「安全泵」。
 * 任何触发方（boot / ack / 工作台 60 秒定时器 / 命令行）都走这里：
 * - 失败不抛出，只返回结构化结果；
 * - 失败原因写事件 dispatch_queue_pump_failed（可留痕、可追溯）；
 * - 队列项只在真正派发成功后才移除，失败/角色忙都原样保留。
 */
async function pumpQueueSafe(project, source = 'timer') {
  // R-c651 F-c651-2/3：兜底泵先消化到期唤醒重试（5/15/30 秒），失败 3 次后由 markWakeFailed 告警。
  let wakeRetry = null;
  try { wakeRetry = await processWakeRetries(project, { source: 'pump' }); } catch { wakeRetry = null; }
  try {
    const result = await pumpDispatchQueue(project, { role: '' });
    const value = result && typeof result === 'object' ? result : { ok: true, pumped: false, reason: 'EMPTY' };
    if (value.ok === false) {
      try {
        appendEvent({ role: 'system', action: 'dispatch_queue_pump_failed', project, target: source, note: String(value.why || value.code || 'QUEUE_PUMP_FAILED').slice(0, 160) });
      } catch { /* 审计写不了也不阻断主流程 */ }
    }
    return { ...value, source, wakeRetry };
  } catch (e) {
    const why = String((e && e.message) || e).slice(0, 200);
    let remaining = -1;
    try { remaining = readDispatchQueue(project).items.length; } catch { remaining = -1; }
    try {
      appendEvent({ role: 'system', action: 'dispatch_queue_pump_failed', project, target: source, note: why });
    } catch { /* ignore */ }
    return { ok: false, code: 'QUEUE_PUMP_FAILED', why, remaining, source, wakeRetry };
  }
}

/**
 * 派单队列命令（B-a577）：`queue pump` 供工作台 60 秒定时器/命令行触发兜底泵；
 * `queue status` 只读队列内容，方便排查“为什么卡住”。
 */
/**
 * B-20261117-205043-0c49：升级告警的「最后活动时间」证据（只读、有界）。
 * 取 max(任务文件 mtime, 任务 updatedAt, 事件.jsonl 里该 role/taskId 的最近一行, 回执.jsonl 里该 role 的最近 ack)。
 * 任一在阈值内 → 角色其实在动，不报「没动」。
 */
const CLAIM_STALL_COOLDOWN_MS = (() => {
  const raw = Number(process.env.TEAM_CLAIM_STALL_COOLDOWN_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60 * 1000;
})();

function tailJsonl(file, limit = 400) {
  try {
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const line of lines.slice(Math.max(0, lines.length - limit))) {
      try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
    }
    return out;
  } catch { return []; }
}

/** 最近活动时间（毫秒）；取不到返回 0（按「无活动」处理，与既有 idle 判据一致）。 */
export function lastActivityAtOf(projectName, { role = '', taskId = '' } = {}) {
  const name = String(projectName || '');
  let latest = 0;
  const bump = (ms) => { if (Number.isFinite(ms) && ms > latest) latest = ms; };
  // ① 任务文件 mtime + updatedAt
  if (taskId) {
    try {
      const f = taskPath(name, taskId);
      const st = fs.statSync(f);
      bump(st.mtimeMs);
      const task = readJson(f, null);
      bump(Date.parse(String((task && (task.updatedAt || task.claimedAt)) || '')));
    } catch { /* 任务文件不存在就靠其它信号 */ }
  }
  // ② 事件.jsonl（appendEvent 写这里）：匹配 role / target / project
  for (const row of tailJsonl(path.join(projectStatePaths(name).dir, '事件.jsonl'))) {
    const hitRole = role && String(row.role || '') === role;
    const hitTask = taskId && String(row.target || '') === taskId;
    const hit = (hitRole || hitTask) && String(row.project || name) === name;
    if (!hit) continue;
    bump(Date.parse(String(row.at || '')));
  }
  // ③ 回执.jsonl / 阅读.jsonl：该角色的最近 ack / boot（会话活着就会有）
  for (const row of tailJsonl(path.join(projectStatePaths(name).dir, '回执.jsonl'), 200)) {
    if (role && String(row.role || row.from || '') === role) bump(Date.parse(String(row.at || '')));
  }
  for (const row of tailJsonl(path.join(projectStatePaths(name).dir, '阅读.jsonl'), 200)) {
    if (role && String(row.role || '') === role) bump(Date.parse(String(row.at || '')));
  }
  return latest;
}

/**
 * Owner 2026-11-14 09:15：认领后 5 分钟无状态变化 → 告警 PM。
 * 只看 type=task/bug 且 status=working 的任务；阈值 TEAM_CLAIM_STALL_MS（默认 5 分钟，测试可注入）；
 * B-0c49：判据从「claim 年龄」改为「最后活动时间」（任务 mtime / 事件 / 回执 / 阅读），
 *         并且同一 taskId+状态 **60 分钟**内只发 1 条（TEAM_CLAIM_STALL_COOLDOWN_MS 可注入），状态跃迁才再发。
 */
export function claimStallCheck(project, { now = Date.now() } = {}) {
  const name = String(project || '');
  if (!name) return { ok: false, code: 'BAD_PROJECT' };
  const stallMs = (() => {
    const raw = Number(process.env.TEAM_CLAIM_STALL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
  })();
  const file = path.join(projectStatePaths(name).dir, '认领停滞.json');
  const state = (() => { try { return readJson(file, {}) || {}; } catch { return {}; } })();
  const alerted = state.alerted && typeof state.alerted === 'object' ? state.alerted : {};
  const hits = [];
  for (const task of listTasks(name)) {
    if (!task || !['task', 'bug'].includes(String(task.type || 'task'))) continue;
    if (String(task.status || '') !== 'working') continue;
    const claimedAt = Date.parse(String(task.claimedAt || task.createdAt || ''));
    if (Number.isNaN(claimedAt)) continue;
    const role = String(task.owner || '');
    // B-0c49①：看「最后活动」而不是「认领多久」——任务文件 mtime / 事件 / 回执 / 阅读 任一在阈值内就算在动。
    const lastActivity = lastActivityAtOf(name, { role, taskId: String(task.id) });
    const idleSince = Math.max(claimedAt, Number.isFinite(lastActivity) ? lastActivity : 0);
    const age = now - idleSince;
    if (age < stallMs) continue;
    // B-0c49②：同一 taskId+状态 60 分钟内只发 1 条（旧实现 10 分钟，分钟数一变就再发一条）。
    const key = `${task.id}|${task.status}`;
    const prev = alerted[key];
    const prevAt = Date.parse(String((prev && typeof prev === 'object') ? prev.at : prev) || '');
    const prevStatus = (prev && typeof prev === 'object') ? String(prev.status || '') : '';
    const stateChanged = prevStatus && prevStatus !== String(task.status || '');
    if (!stateChanged && Number.isFinite(prevAt) && now - prevAt < CLAIM_STALL_COOLDOWN_MS) continue;
    const ownerName = ROLE_NAMES[role] || role || '（无 owner）';
    const minutes = Math.round(age / 60000);
    try {
      const msg = sendMessage({
        from: 'system', to: 'pm', type: 'escalation', project: name,
        subject: `认领后 ${minutes} 分钟没动：${task.id}`,
        body: `${ownerName} 认领了 ${task.id}，最后一次可见活动在 ${minutes} 分钟前（判据：任务文件/事件/回执/阅读 的最新时间）。\nrole=${role || '-'}\ntaskId=${task.id}\nclaimedAt=${task.claimedAt || '-'}\n最后活动=${Number.isFinite(lastActivity) && lastActivity > 0 ? new Date(lastActivity).toISOString() : '无记录'}\n当前状态=working\n请 PM 过问一下（换人/拆任务/确认卡在哪）。`,
        ackRequired: false,
      });
      alerted[key] = { at: nowIso(), status: String(task.status || ''), level: 'claim_stall' };
      hits.push({ taskId: task.id, role, messageId: msg.id, ageMs: age, lastActivity });
      appendEvent({ role: 'system', sessionId: '', action: 'claim_stall_alert', project: name, target: task.id, note: `role=${role} idle=${minutes}min cooldown=${Math.round(CLAIM_STALL_COOLDOWN_MS / 60000)}min message=${msg.id}` });
    } catch (e) {
      hits.push({ taskId: task.id, role, error: String((e && e.message) || e) });
    }
  }
  try { writeJson(file, { schema: 2, project: name, alerted, updatedAt: nowIso() }); } catch { /* 状态写失败不阻断 */ }
  return { ok: true, stallMs, cooldownMs: CLAIM_STALL_COOLDOWN_MS, alerted: hits.length, hits };
}

/**
 * B-bbf6（P1，2026-11-15）：派单队列「吞单」三件套。
 * ① `reconcileDispatchQueueSessions`：换人/rotate 后旧会话的队列项要么改投新会话、要么作废并留审计，不许静默悬挂；
 * ② `queueStaleCheck`：队列项滞留 >5 分钟向 PM 发 escalation（同项 10 分钟去重）——治「锁空着、队列挂着、没人知道」；
 * ③ 锁一释放就补泵一次（releaseDispatchLockForTask 末尾），配合壳层 60 秒定时器，保证 60 秒内必达。
 */
const DISPATCH_QUEUE_STALE_MS = (() => {
  const raw = Number(process.env.TEAM_DISPATCH_QUEUE_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
})();
// 卷 §四：告警去重键统一为 itemId+level，同 item 同 level 24 小时内只发一次
// （去重窗口常量 QUEUE_ALERT_LEVEL_DEDUPE_MS 见下方 1dfb 段；旧 10 分钟常量不再使用）。

function dispatchQueueStaleFile(project) {
  return path.join(projectStatePaths(project).dir, '派单队列滞留.json');
}

/**
 * 队列项滞留告警（R-1dfb：单链三层的**链首 notice**，阈值/文案与人话保留既有行为）。
 * >5 分钟未投递 → PM 收一条 escalation（含 role/queueId/滞留分钟/attempt/三信号多旧/最后回执）。
 * 去重键 itemId+notice（卷 §四；`派单队列滞留.json → alerted[itemId] = {notice: at}`，兼容旧字符串值）。
 * 同一 item+level 24 小时内只发一次；项被投递/作废/恢复后由入口清 alerted。
 */
export function queueStaleCheck(project, { now = Date.now() } = {}) {
  const name = String(project || '');
  if (!name) return { ok: false, code: 'BAD_PROJECT' };
  const nowMs = Number(now) || Date.now();
  const queue = readDispatchQueue(name);
  const hits = [];
  const skipped = { delivered: 0, targetBusy: 0 };
  // B-0c49③：只在「确实没投出去 + 目标角色空闲」时才报滞留——已送达的、以及目标正在 working 的正常排队不报。
  const busyRoles = new Set(listTasks(name)
    .filter((t) => t && String(t.status || '') === 'working' && t.owner)
    .map((t) => String(t.owner)));
  for (const item of queue.items) {
    if (!item || !item.id) continue;
    const at = Date.parse(String(item.at || ''));
    if (!Number.isFinite(at)) continue;
    const age = nowMs - at;
    if (age < DISPATCH_QUEUE_STALE_MS) continue;
    if (item.deliveredAt || item.delivered === true) { skipped.delivered += 1; continue; }
    if (busyRoles.has(String(item.to || ''))) { skipped.targetBusy += 1; continue; }
    const sent = raiseQueueEscalation(name, {
      itemId: String(item.id), to: String(item.to || ''), taskId: String(item.task || ''),
      attempt: Number(item.attempt) || 1, stallMs: age, level: 'notice', now: nowMs,
    });
    if (!sent) continue;
    hits.push({ queueId: item.id, to: String(item.to || ''), minutes: Math.round(age / 60000), level: 'notice', messageId: sent.messageId });
  }
  return { ok: true, staleMs: DISPATCH_QUEUE_STALE_MS, alerted: hits.length, hits, skipped, remaining: queue.items.length };
}

function dispatchQueueArchiveFile(project) {
  return path.join(projectStatePaths(project).dir, '派单队列归档.jsonl');
}

/**
 * B-20261116-104231-4c6f（P0）：派单队列滞留**自动补投**（最小版）。
 * 判据：队列项滞留 ≥ 阈值（默认 5 分钟，TEAM_DISPATCH_QUEUE_IDLE_BACKFILL_MS 可注入）
 *       + 目标角色在最近窗口内（默认 10 分钟，TEAM_ROLE_IDLE_WINDOW_MS）**无提交、无角色目录文件写入、无 ack、无近期 working**
 *       → 视为空闲，允许绕开「角色忙」直接投递（等价 send 唤醒）。
 * 每次补投写 append-only 审计 派单队列补投.jsonl（at/queueId/to/reason=idle_backfill/证据），
 * 队列项在投递成功后由 pumpDispatchQueue 移除，天然不会重复投递。
 */
const DISPATCH_QUEUE_IDLE_BACKFILL_MS = (() => {
  const raw = Number(process.env.TEAM_DISPATCH_QUEUE_IDLE_BACKFILL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5 * 60 * 1000;
})();
const ROLE_IDLE_WINDOW_MS = (() => {
  const raw = Number(process.env.TEAM_ROLE_IDLE_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
})();

function dispatchQueueBackfillFile(project) {
  return path.join(projectStatePaths(project).dir, '派单队列补投.jsonl');
}

/** 角色目录里最近一次文件写入（有界扫描：最多 4000 个文件，跳过 .git/node_modules/_backup）。 */
function roleDirLastFileWrite(projectPath, role) {
  const dirName = ROLE_DIRS[role] || role;
  const base = path.join(String(projectPath || ''), dirName);
  let latest = 0;
  let scanned = 0;
  const walk = (dir, depth) => {
    if (!dir || depth > 4 || scanned > 4000) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (scanned > 4000) return;
      const name = String(entry.name || '');
      if (entry.isDirectory()) {
        if (['.git', 'node_modules', '_backup', '_tmp'].includes(name)) continue;
        walk(path.join(dir, name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned += 1;
      try {
        const stat = fs.statSync(path.join(dir, name));
        if (stat.mtimeMs > latest) latest = stat.mtimeMs;
      } catch { /* 单个文件读不到不影响 */ }
    }
  };
  walk(base, 0);
  return latest ? new Date(latest).toISOString() : '';
}

/**
 * 角色活跃度证据（只读）：最近提交（git log，有界 4s）/ 最近角色目录文件写入 / 最近 ack（回执.jsonl）/ 最近 working 任务更新。
 * idle=true 仅当四项都早于窗口（缺失按「无活动」处理）。
 */
export function roleActivityEvidence(projectName, role, { now = Date.now() } = {}) {
  const name = String(projectName || '');
  const roleKey = String(role || '');
  const evidence = {
    role: roleKey,
    project: name,
    windowMs: ROLE_IDLE_WINDOW_MS,
    lastCommitAt: '',
    lastFileWriteAt: '',
    lastAckAt: '',
    lastWorkingAt: '',
    idle: true,
    detail: '',
  };
  let projectPath = '';
  try { projectPath = String((loadProject(name) || {}).path || ''); } catch { projectPath = ''; }
  // ① 最近提交（git 可读才算；沙盘/无仓库 → 空）。路径按仓库根算，避免 -C 项目目录时 pathspec 相对错位。
  if (projectPath) {
    try {
      const rootProbe = spawnSync('git', ['-C', projectPath, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 4000 });
      const root = String((rootProbe && rootProbe.stdout) || '').trim();
      if (root) {
        const rel = path.relative(root, path.join(projectPath, ROLE_DIRS[roleKey] || roleKey)).replace(/\\/g, '/') || '.';
        const git = spawnSync('git', ['-C', root, 'log', '-1', '--format=%cI', '--', rel], { encoding: 'utf8', timeout: 4000 });
        const out = String((git && git.stdout) || '').trim();
        if (out && !git.error) evidence.lastCommitAt = out;
      }
    } catch { /* 视为无提交证据 */ }
  }
  // ② 最近角色目录文件写入
  try { evidence.lastFileWriteAt = roleDirLastFileWrite(projectPath, roleKey); } catch { evidence.lastFileWriteAt = ''; }
  // ③ 最近 ack（回执.jsonl 里 from=该角色 的最后一条 ts）
  try {
    const parsed = readJsonlTolerant(PATHS.receipts);
    let last = '';
    for (const row of (parsed && Array.isArray(parsed.items) ? parsed.items : [])) {
      if (!row || String(row.from || '') !== roleKey) continue;
      const ts = String(row.ts || '');
      if (ts && ts > last) last = ts;
    }
    evidence.lastAckAt = last;
  } catch { evidence.lastAckAt = ''; }
  // ④ 最近 working 任务更新（有近期 working → 不算空闲）
  try {
    const working = listTasks(name).filter((task) => task && String(task.owner || '') === roleKey && String(task.status || '') === 'working');
    let last = '';
    for (const task of working) {
      const ts = String(task.updatedAt || task.claimedAt || '');
      if (ts && ts > last) last = ts;
    }
    evidence.lastWorkingAt = last;
  } catch { evidence.lastWorkingAt = ''; }
  const cutoff = now - ROLE_IDLE_WINDOW_MS;
  const older = (iso) => {
    const ms = Date.parse(String(iso || ''));
    return !Number.isFinite(ms) || ms < cutoff; // 缺失＝无活动
  };
  evidence.idle = older(evidence.lastCommitAt) && older(evidence.lastFileWriteAt) && older(evidence.lastAckAt) && older(evidence.lastWorkingAt);
  evidence.detail = [
    `提交=${evidence.lastCommitAt || '无'}`,
    `文件写入=${evidence.lastFileWriteAt || '无'}`,
    `ack=${evidence.lastAckAt || '无'}`,
    `working=${evidence.lastWorkingAt || '无'}`,
  ].join('；');
  return evidence;
}

// ============================================================================
// R-20261116-104535-1dfb（P0）派单必达 + 空闲唤醒 + 活跃度看板 —— 团队工具层
// 卷 §三（六态状态机）/§四（单链三层升级）/§五（三信号）/§七（活跃度审计 10 键）
// /§八（投递审计 12 键）/§十三（source 枚举与回执信号唯一化）
// 边界：不改投递语义（归缺陷 B-4c6f / 0a7e5bb）、不改 G1–G5 门禁、不改 runDispatchGates。
// ============================================================================

/** tick 泵周期；沙盘可设 1000 驱动 source=tick（卷 §(六)1）。 */
const AWB_STALL_TICK_MS = (() => {
  const raw = Number(process.env.AWB_STALL_TICK_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60000;
})();
/** escalate / force 两层的时间口径（卷 §(三)2）：默认 15 / 30 分钟，可注入压缩。 */
const AWB_STALL_ESCALATE_MS = (() => {
  const raw = Number(process.env.AWB_STALL_ESCALATE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60 * 1000;
})();
const AWB_STALL_FORCE_MS = (() => {
  const raw = Number(process.env.AWB_STALL_FORCE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60 * 1000;
})();
/** 连续多少次 idle 转红标 + PM 升级（卷 §五 / F6，默认 2）。 */
const AWB_STALL_IDLE_CONSECUTIVE = (() => {
  const raw = Number(process.env.AWB_STALL_IDLE_CONSECUTIVE);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2;
})();
/** 同 item 同 level 24 小时内只发一次（卷 §四；兼容旧字符串值 = notice）。 */
const QUEUE_ALERT_LEVEL_DEDUPE_MS = 24 * 60 * 60 * 1000;
/** 同 itemId 连续唤醒失败升级阈值（卷 §(六)2 唯一的「3 次」计数）。 */
const STALL_WAKE_FAIL_UPGRADE = 3;
/** 角色目录扫描时跳过的目录（卷 §五：_backup/**、_tmp/** 不算活动）。 */
const ACTIVITY_SKIP_DIRS = new Set(['.git', 'node_modules', '_backup', '_tmp']);
/** 投递审计 12 键（卷 §八：键顺序固定，多键/缺键即不合格）。 */
const DELIVERY_AUDIT_KEYS = ['at', 'project', 'itemId', 'to', 'taskId', 'attempt', 'result', 'code', 'stallMs', 'messageId', 'wakeOk', 'source'];
/** 活跃度审计 10 键（卷 §七：键顺序固定）。 */
const ROLE_ACTIVITY_AUDIT_KEYS = ['at', 'project', 'role', 'action', 'verdict', 'idleMs', 'signals', 'wake', 'level', 'detail'];
/** 投递审计 result 枚举（卷 §八）。 */
const DELIVERY_RESULTS = ['delivered', 'blocked', 'timeout', 'retry', 'upgraded', 'forced', 'recovered'];
// B-20261117-104213-ebbc：空闲重派的投递退避（delivered 未回执不再每拍重投）。
const REPUSH_MIN_GAP_MS = 10 * 60 * 1000; // 同一 itemId 两次投递至少间隔 10 分钟
const REPUSH_MAX_ATTEMPT = 3;             // attempt 到 3 次即放弃（只告警一次）
const REPUSH_DAILY_CAP = 5;               // 同一 itemId 每日最多重投 5 次
/** 活跃度审计 action 枚举（卷 §七）。 */
const ROLE_ACTIVITY_ACTIONS = ['stalled', 'woken', 'escalated', 'recovered', 'unknown'];
/** 单链三层（卷 §四）。 */
const QUEUE_ALERT_LEVELS = ['notice', 'escalate', 'force'];

function orderedRow(order, values) {
  const row = {};
  for (const key of order) row[key] = values[key];
  return row;
}

/** 投递状态文件（卷 §三：只读消费方不得改）。 */
export function dispatchDeliveryStateFile(project) {
  return path.join(projectStatePaths(String(project || '')).dir, '派单投递状态.json');
}

/** 投递审计（12 键，append-only）。 */
export function dispatchDeliveryAuditFile(project) {
  return path.join(projectStatePaths(String(project || '')).dir, '派单投递审计.jsonl');
}

/** 角色活跃度审计（10 键，append-only）。 */
export function roleActivityAuditFile(project) {
  return path.join(projectStatePaths(String(project || '')).dir, '活跃度审计.jsonl');
}

function emptyDeliveryItem(attempt = 1) {
  const n = Number(attempt);
  return {
    state: 'queued',
    attempt: Number.isFinite(n) && n > 0 ? Math.floor(n) : 1,
    lastAt: '',
    lastCode: '',
    stalledAt: '',
    upgradedAt: '',
  };
}

/** 读 派单投递状态.json（缺文件/坏文件退化为空表，绝不抛）。 */
export function readDeliveryState(project) {
  const name = String(project || '');
  const file = dispatchDeliveryStateFile(name);
  let data = {};
  try { data = readJson(file) || {}; } catch { data = {}; }
  const rawItems = data && typeof data.items === 'object' && data.items ? data.items : {};
  const items = {};
  for (const [itemId, row] of Object.entries(rawItems)) {
    if (!row || typeof row !== 'object') continue;
    items[String(itemId)] = {
      state: String(row.state || 'queued'),
      attempt: Number(row.attempt) > 0 ? Math.floor(Number(row.attempt)) : 1,
      lastAt: String(row.lastAt || ''),
      lastCode: String(row.lastCode || ''),
      stalledAt: String(row.stalledAt || ''),
      upgradedAt: String(row.upgradedAt || ''),
    };
  }
  return { schema: 1, project: name || String((data && data.project) || ''), items };
}

function writeDeliveryState(project, state) {
  const name = String(project || '');
  const items = {};
  for (const [itemId, row] of Object.entries((state && state.items) || {})) {
    const base = emptyDeliveryItem(row && row.attempt);
    items[String(itemId)] = {
      state: String((row && row.state) || base.state),
      attempt: Number(row && row.attempt) > 0 ? Math.floor(Number(row.attempt)) : base.attempt,
      lastAt: String((row && row.lastAt) || ''),
      lastCode: String((row && row.lastCode) || ''),
      stalledAt: String((row && row.stalledAt) || ''),
      upgradedAt: String((row && row.upgradedAt) || ''),
    };
  }
  writeJson(dispatchDeliveryStateFile(name), { schema: 1, project: name, items });
  return { schema: 1, project: name, items };
}

/** 单条 item 状态打补丁（读-改-写；只用于状态机入口，不用于只读链路）。 */
function markDeliveryState(project, itemId, patch = {}) {
  const name = String(project || '');
  const id = String(itemId || '');
  if (!name || !id) return null;
  const state = readDeliveryState(name);
  const base = emptyDeliveryItem((state.items[id] && state.items[id].attempt) || patch.attempt);
  state.items[id] = { ...base, ...(state.items[id] || {}), ...patch, attempt: Number((state.items[id] && state.items[id].attempt) || patch.attempt || base.attempt) || 1 };
  writeDeliveryState(name, state);
  return state.items[id];
}

/** B-ebbc：统计某 itemId「今天」已写出的重投审计行数（daily cap 判据，只读审计、不改状态结构）。 */
function countRepushToday(project, itemId, nowMs) {
  const day = new Date(Number(nowMs) || Date.now()).toISOString().slice(0, 10);
  let rows = [];
  try { rows = readDeliveryAuditRows(project); } catch { rows = []; }
  return rows.filter((row) => row
    && String(row.itemId || '') === String(itemId || '')
    && String(row.at || '').slice(0, 10) === day
    && String(row.code || '') === 'STALLED_REQUEUE').length;
}

/** B-1d90：入队过滤告警每 itemId 每天只写一行（避免每拍刷审计/唤醒）。 */
function hasRepushFilterAlert(project, itemId, nowMs) {
  const day = new Date(Number(nowMs) || Date.now()).toISOString().slice(0, 10);
  let rows = [];
  try { rows = readDeliveryAuditRows(project); } catch { rows = []; }
  return rows.some((row) => row
    && String(row.itemId || '') === String(itemId || '')
    && String(row.at || '').slice(0, 10) === day
    && String(row.code || '').startsWith('REPUSH_FILTERED_'));
}

/** B-ebbc：attempt 用尽只告警一次——审计里已有同 itemId 的 ATTEMPT_CAP 行就不再写。 */
function hasRepushCapAlert(project, itemId) {
  let rows = [];
  try { rows = readDeliveryAuditRows(project); } catch { rows = []; }
  return rows.some((row) => row && String(row.itemId || '') === String(itemId || '') && String(row.code || '') === 'ATTEMPT_CAP');
}

/** 追加一行 12 键投递审计；result 不在枚举里直接拒写（防止枚举污染）。 */
function appendDeliveryAudit(project, row = {}) {
  const name = String(project || '');
  if (!name) return null;
  const result = String(row.result || '');
  if (!DELIVERY_RESULTS.includes(result)) fail('BAD_DELIVERY_RESULT', `投递审计 result 不在枚举内：${result}`, { allowed: DELIVERY_RESULTS });
  const n = Number(row.attempt);
  const stall = Number(row.stallMs);
  const out = orderedRow(DELIVERY_AUDIT_KEYS, {
    at: String(row.at || nowIso()),
    project: name,
    itemId: String(row.itemId || ''),
    to: String(row.to || ''),
    taskId: String(row.taskId || ''),
    attempt: Number.isFinite(n) && n > 0 ? Math.floor(n) : 1,
    result,
    code: String(row.code || ''),
    stallMs: Number.isFinite(stall) && stall > 0 ? Math.round(stall) : 0,
    messageId: String(row.messageId || ''),
    wakeOk: row.wakeOk === true,
    source: String(row.source || 'tick'),
  });
  try { appendLine(dispatchDeliveryAuditFile(name), JSON.stringify(out)); } catch { /* 审计写失败不阻断主流程 */ }
  return out;
}

function readDeliveryAuditRows(project) {
  try { return readJsonl(dispatchDeliveryAuditFile(project)) || []; } catch { return []; }
}

/** 追加一行 10 键活跃度审计（缺键/多键即不合格 → 这里用固定键序重建）。 */
function appendRoleActivityAudit(project, row = {}) {
  const name = String(project || '');
  if (!name) return null;
  const action = String(row.action || '');
  if (!ROLE_ACTIVITY_ACTIONS.includes(action)) fail('BAD_ACTIVITY_ACTION', `活跃度审计 action 不在枚举内：${action}`, { allowed: ROLE_ACTIVITY_ACTIONS });
  const idleMs = Number(row.idleMs);
  const signals = row.signals && typeof row.signals === 'object' ? row.signals : {};
  const wake = row.wake && typeof row.wake === 'object' ? row.wake : {};
  const out = orderedRow(ROLE_ACTIVITY_AUDIT_KEYS, {
    at: String(row.at || nowIso()),
    project: name,
    role: String(row.role || ''),
    action,
    verdict: String(row.verdict || ''),
    idleMs: Number.isFinite(idleMs) ? Math.round(idleMs) : -1,
    signals: {
      fileAt: String(signals.fileAt || ''),
      ackAt: String(signals.ackAt || ''),
      workingAt: String(signals.workingAt || ''),
    },
    wake: {
      ok: wake.ok === true,
      messageId: String(wake.messageId || ''),
      code: String(wake.code || ''),
    },
    level: QUEUE_ALERT_LEVELS.includes(String(row.level || '')) || String(row.level || '') === 'none' ? String(row.level || 'none') : 'none',
    detail: String(row.detail || ''),
  });
  try { appendLine(roleActivityAuditFile(name), JSON.stringify(out)); } catch { /* 审计写失败不阻断主流程 */ }
  return out;
}

function readRoleActivityAuditRows(project) {
  try { return readJsonl(roleActivityAuditFile(project)) || []; } catch { return []; }
}

// ---------- 三信号（卷 §五：不用 git、不用邮箱口径） ----------

/** 项目内角色目录（不存在返回 ''）。 */
function roleDirOf(project, role) {
  const roleKey = String(role || '');
  if (!roleKey) return '';
  let base = '';
  try { base = String((loadProject(String(project || '')) || {}).path || ''); } catch { base = ''; }
  if (!base) return '';
  return path.join(base, ROLE_DIRS[roleKey] || roleKey);
}

/** 卷 §五文件写入排除项：文件索引.md / 项目索引*.md / *.jsonl / 派单*。 */
function activityFileExcluded(name) {
  const n = String(name || '');
  if (!n) return true;
  if (n === '文件索引.md') return true;
  if (/^项目索引.*\.md$/.test(n)) return true;
  if (/\.jsonl$/i.test(n)) return true;
  if (/^派单/.test(n)) return true;
  return false;
}

/**
 * 角色目录内文件 max mtime（递归 ≤3 层，排除生成物）。AC8 性能优化（R-1dfb）：
 * ① 子目录按**目录 mtime 降序**遍历（最新目录优先），命中「窗口内文件」即提前结束：
 *    idle 判定只需要「有没有窗口内写入」，找到即必为 active（**声音**，不会把在动的角色误判 idle）；
 *    此时回的是「命中时那个窗口内文件」的时间，不保证是全局 max（仅展示列，偏差 ≤ 空闲窗口）；
 *    没命中（真 idle 时）会走完整遍历 → fileAt 为精确 max。
 * ② 每角色扫描上限 ACTIVITY_SCAN_CAP 个文件（达到即停并回 truncated:true，结果里可观测，不静默少扫）。
 */
const ACTIVITY_SCAN_CAP = 1500;
function roleFileWriteScan(project, role, { cutoffMs = 0, cap = ACTIVITY_SCAN_CAP } = {}) {
  const base = roleDirOf(project, role);
  if (!base) return { fileAt: '', scanned: 0, truncated: false, earlyExit: false };
  let latest = 0;
  let scanned = 0;
  let truncated = false;
  let earlyExit = false;
  const walk = (dir, depth) => {
    if (earlyExit || depth > 3 || (cap > 0 && scanned >= cap)) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const subdirs = [];
    for (const entry of entries) {
      const name = String(entry.name || '');
      if (entry.isDirectory()) {
        if (!ACTIVITY_SKIP_DIRS.has(name)) subdirs.push(name);
        continue;
      }
      if (!entry.isFile()) continue;
      if (activityFileExcluded(name)) continue;
      if (cap > 0 && scanned >= cap) { truncated = true; break; }
      scanned += 1;
      try {
        const stat = fs.statSync(path.join(dir, name));
        if (stat.mtimeMs > latest) latest = stat.mtimeMs;
      } catch { /* 单文件读不到不影响 */ }
      // 声音早退：命中窗口内写入 → 该角色必为 active，无需继续扫（只影响展示值精度，不影响判定）。
      if (cutoffMs > 0 && latest >= cutoffMs) { earlyExit = true; return; }
    }
    const subs = [];
    for (const name of subdirs) {
      try { subs.push({ name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs }); } catch { /* 子目录读不到跳过 */ }
    }
    subs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const sub of subs) {
      if (earlyExit) return;
      if (cap > 0 && scanned >= cap) { truncated = true; return; }
      walk(path.join(dir, sub.name), depth + 1);
    }
  };
  walk(base, 0);
  // PM 2026-11-17 10:24 裁定 #5：fileAt 允许「window 内命中即早退」，但必须显式标注来源：
  // window-hit = 在时间窗内命中后提前返回（不是严格最大值）；max = 全量扫描取最大。
  return {
    fileAt: latest ? new Date(latest).toISOString() : '',
    fileAtSource: earlyExit ? 'window-hit' : 'max',
    scanned, truncated, earlyExit,
  };
}

function roleFileWriteAtSource(project, role) {
  try {
    const scan = roleFileWriteScan(project, role);
    return String((scan && scan.fileAtSource) || 'max');
  } catch { return 'max'; }
}

function roleFileWriteAt(project, role) {
  // 升级文案用：不带 cutoff、不限量 → 尽量给精确 max（低频路径，代价可接受）。
  return roleFileWriteScan(project, role, { cutoffMs: 0, cap: 0 }).fileAt;
}

/** 日志文件名（YYYY-MM-DD.md）里的本地日期 + 行内 HH:MM:SS → 毫秒（与 core.hhmmss/dayKey 同口径）。 */
function localLogMs(day, hms) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  const t = /^(\d{2}):(\d{2}):(\d{2})$/.exec(String(hms || ''));
  if (!d || !t) return NaN;
  return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), Number(t[3])).getTime();
}

/** 进程内只读缓存（AC8）：文件签名（mtimeMs+size）没变就不重读；上限 40 个文件，超了整表清空。 */
const ACTIVITY_FILE_CACHE = new Map();
function cachedFileText(file) {
  let sig = '';
  try {
    const st = fs.statSync(file);
    sig = `${st.mtimeMs}|${st.size}`;
  } catch { return null; }
  const hit = ACTIVITY_FILE_CACHE.get(file);
  if (hit && hit.sig === sig) return hit.value;
  let value = null;
  try { value = fs.readFileSync(file, 'utf8'); } catch { return null; }
  if (ACTIVITY_FILE_CACHE.size > 40) ACTIVITY_FILE_CACHE.clear();
  ACTIVITY_FILE_CACHE.set(file, { sig, value });
  return value;
}

/**
 * 回执信号（卷 §十三(二)：唯一来源 = 团队/日志/<date>.md 的 ack 事件行，行首时间取最新一条）。
 * 格式：`- 09:09:10 [programmer1] ack · M-… — …`；`auto` 不算。日期取文件名。
 */
function roleLastAckAt(project, role, { maxDays = 7 } = {}) {
  const roleKey = String(role || '');
  if (!roleKey || roleKey === 'auto') return '';
  let files = [];
  try { files = fs.readdirSync(PATHS.logs).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort().reverse(); } catch { return ''; }
  const escaped = roleKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^- (\\d{2}:\\d{2}:\\d{2}) \\[${escaped}\\] ack · `);
  for (const file of files.slice(0, maxDays)) {
    const day = file.replace(/\.md$/, '');
    const text = cachedFileText(path.join(PATHS.logs, file));
    if (!text) continue;
    let bestMs = 0;
    for (const line of text.split(/\r?\n/)) {
      const m = re.exec(line);
      if (!m) continue;
      const ms = localLogMs(day, m[1]);
      if (Number.isFinite(ms) && ms > bestMs) bestMs = ms;
    }
    // 文件已按日期倒序：命中即该角色最新回执，无需再翻更早的日志。
    if (bestMs) return new Date(bestMs).toISOString();
  }
  return '';
}

/** 近期 working 信号（卷 §五：该角色名下未 done/cancelled 任务的 claimedAt/updatedAt 最大值）。 */
function roleWorkingAt(project, role, tasks = null) {
  const roleKey = String(role || '');
  const rows = Array.isArray(tasks) ? tasks : listTasks(String(project || ''));
  let latest = 0;
  for (const task of rows) {
    if (!task || String(task.owner || '') !== roleKey) continue;
    // B-20261117-102215-d52c：闭环判定统一走 gates.statusIsClosed（accepted/terminated 也算闭环），
    // 禁止再手写 ['done','cancelled'] —— 漏 accepted 会把已验收任务算成未闭环 → 角色被误判 idle → F6 灌脏队列。
    if (statusIsClosed(String(task.status || ''))) continue;
    for (const ts of [task.claimedAt, task.updatedAt]) {
      const ms = Date.parse(String(ts || ''));
      if (Number.isFinite(ms) && ms > latest) latest = ms;
    }
  }
  return latest ? new Date(latest).toISOString() : '';
}

/**
 * B-20261117-110240-1d90：角色「在办任务」的产出 mtime 信号。
 * 只看「10 分钟无文件写入/无回执」会误判：角色 claim 了 working 任务、一直在写产出/证据，
 * 但角色目录里没有新文件时仍被判 idle（1dfb F6 回归，PM 实测 53 条 Q-STALL 里 1 条是角色在办任务自身）。
 * 取角色名下未闭环、非镜像任务的：①任务 JSON 文件 mtime ②evidenceFiles 顶层文件 mtime。
 */
/**
 * B-1d90（PM 11:39 收窄版）：该角色最近一次「唤醒成功（ok=true）」的时间。
 * 廉价信号：角色可能长时间只在写 团队/工具 代码或跑长任务（fileAt 不涨、ack 少），
 * 但刚被成功唤醒过说明它在线；把它计入 active 判据，避免误判 idle 后反复唤醒。
 */
function roleLastWakeOkAt(project, role) {
  const roleKey = String(role || '');
  if (!roleKey) return '';
  let rows = [];
  try { rows = readWakeRowsNewestFirst(String(project || '')); } catch { rows = []; }
  for (const row of rows) {
    if (!row || String(row.to || '') !== roleKey) continue;
    if (row.ok !== true) continue;
    const at = String(row.at || '');
    if (at) return at;
  }
  return '';
}

function roleTaskProgressAt(project, role, tasks = null) {
  const name = String(project || '');
  const roleKey = String(role || '');
  const rows = Array.isArray(tasks) ? tasks : listTasks(name);
  let projectPath = '';
  try { projectPath = String((loadProject(name) || {}).path || ''); } catch { projectPath = ''; }
  let taskDir = '';
  try { taskDir = projectStatePaths(name).tasks; } catch { taskDir = ''; }
  let latest = 0;
  const consider = (file) => {
    if (!file) return;
    try { const st = fs.statSync(file); if (st.mtimeMs > latest) latest = st.mtimeMs; } catch { /* 文件不在不影响判定 */ }
  };
  for (const task of rows) {
    if (!task || String(task.owner || '') !== roleKey) continue;
    if (isRequirementMirrorTask(task) || statusIsClosed(task.status)) continue;
    if (taskDir) consider(path.join(taskDir, `${String(task.id)}.json`));
    const files = Array.isArray(task.evidenceFiles) ? task.evidenceFiles : [];
    for (const file of files) {
      const rel = String((file && (file.path || file.rel || file.name)) || '').replace(/\\/g, '/').trim();
      if (!rel) continue;
      const base = file && file.scope === 'workspace' ? PATHS.workspace : projectPath;
      if (!base) continue;
      consider(path.resolve(String(base), rel));
    }
  }
  return latest ? new Date(latest).toISOString() : '';
}

/**
 * B-1d90：该角色当前是否正 claim 着这条任务（claim 后未 done/release）。
 * 用于空闲重派入队前的兜底：角色自己手上的在办任务不再「重派给它自己」。
 */
function taskClaimedByRole(task, role) {
  const roleKey = String(role || '');
  if (!task || !roleKey) return false;
  if (String(task.status || '') === 'working' && String(task.owner || '') === roleKey) return true;
  const hist = Array.isArray(task.history) ? task.history : [];
  for (let i = hist.length - 1; i >= 0; i -= 1) {
    const row = hist[i] || {};
    const action = String(row.action || '');
    if (action === 'claim' && String(row.by || '') === roleKey) return true;
    if (action === 'done' || action === 'release' || action === 'cancel') return false;
  }
  return false;
}

/**
 * PM 2026-11-17 10:24 裁定 #4：本项目并存两套 idle 判据，禁止合并，但必须标注差异——
 *  a) 本函数（F5 活跃度）用四信号 + window 扫描：fileAt/ackAt/workingAt + progressAt，任一在窗内即 active；
 *  b) detectStalledRoles（F6 空闲唤醒）用三信号 + openTaskIds 过滤：file/ack/working，不含 progressAt；
 *  差异原因：F5 判「这角色是不是刚动过」（含在办任务产出 mtime），F6 判「是否该重派」（只看动作与回执）。
 *  注意 fileAtSource：window-hit 表示命中窗内即早退、不是严格最大值（裁定 #5）。
 */
function roleSignalsOf(project, role, { tasks = null } = {}) {
  return {
    fileAt: roleFileWriteAt(project, role),
    fileAtSource: roleFileWriteAtSource(project, role),
    ackAt: roleLastAckAt(project, role),
    workingAt: roleWorkingAt(project, role, tasks),
  };
}

/** 某个时间比 now 旧多久的人话（升级文案必带，卷 §四）。 */
function agoText(iso, now) {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return '无记录';
  const sec = Math.max(0, Math.round((Number(now) - ms) / 1000));
  if (sec < 90) return `${sec} 秒前`;
  if (sec < 5400) return `${Math.round(sec / 60)} 分钟前`;
  return `${Math.round(sec / 3600)} 小时前`;
}

/** 角色集合：优先项目 roleIds，回退名册 active 成员（与团队台同口径）。 */
function activityRoleIds(project) {
  try {
    const ids = projectRoleIds(loadProject(String(project || '')));
    if (ids.length) return ids.map(String);
  } catch { /* 项目未登记：回退名册 */ }
  try { return activeMembers(loadTeam()).map((m) => String((m && m.role) || '')).filter(Boolean); } catch { return []; }
}

/**
 * 一次扫描算全部角色的三信号（AC8：detectStalledRoles 与 computeRoleActivity 共用，不重复扫目录）。
 * 规则：三源全取不到 → unknown；任一在窗口内 → active；三信号全旧且该角色有未闭环任务 → idle。
 */
function scanActivityRoles(project, { now = Date.now() } = {}) {
  const name = String(project || '');
  const nowMs = Number(now) || Date.now();
  const cutoff = nowMs - ROLE_IDLE_WINDOW_MS;
  const tasks = (() => { try { return listTasks(name); } catch { return []; } })();
  const roles = {};
  for (const role of activityRoleIds(name)) {
    // 带 cutoff 的扫描：命中窗口内写入即早退（verdict 必 active，声音）；真 idle 时走完整遍历给精确 max。
    const scan = roleFileWriteScan(name, role, { cutoffMs: cutoff });
    const signals = {
      fileAt: scan.fileAt,
      ackAt: roleLastAckAt(name, role),
      workingAt: roleWorkingAt(name, role, tasks),
      // B-1d90：在办任务的产出 mtime（任务文件/证据文件）——「人还在写东西」也是活跃信号。
      progressAt: roleTaskProgressAt(name, role, tasks),
      // B-1d90（收窄版）：最近一次唤醒成功（唤醒.jsonl ok=true）——「在线」也算活跃。
      wakeAt: roleLastWakeOkAt(name, role),
    };
    // B-4c66 ②：镜像任务（type=requirement / id===requirementId）不是「在办的活」——否则角色被永久判 idle+有活，
    // 看门狗每拍唤起一次（分析师实测 10:24/10:25/10:26 各一次，reason=stalled）；终态判断统一走 statusIsClosed。
    const openTaskIds = tasks
      .filter((task) => task && String(task.owner || '') === String(role)
        && !isRequirementMirrorTask(task)
        && !statusIsClosed(task.status))
      .map((task) => String(task.id));
    const missingSignals = [];
    if (!signals.fileAt) missingSignals.push('file');
    if (!signals.ackAt) missingSignals.push('ack');
    if (!signals.workingAt) missingSignals.push('working');
    if (!signals.progressAt) missingSignals.push('progress');
    if (!signals.wakeAt) missingSignals.push('wake');
    const times = [signals.fileAt, signals.ackAt, signals.workingAt, signals.progressAt, signals.wakeAt]
      .map((ts) => Date.parse(String(ts || '')))
      .filter((ms) => Number.isFinite(ms));
    const latest = times.length ? Math.max(...times) : NaN;
    let verdict = 'active';
    if (!times.length) verdict = 'unknown'; // 三源全缺：绝不当 idle
    else if (latest >= cutoff) verdict = 'active';
    else if (openTaskIds.length) verdict = 'idle';
    const row = {
      verdict,
      idleMs: Number.isFinite(latest) ? Math.max(0, nowMs - latest) : -1,
      signals,
      missingSignals,
      openTaskIds,
    };
    // 扫描触到文件上限时显式标注（不静默少扫）。
    if (scan.truncated) row.truncated = true;
    roles[role] = row;
  }
  return { nowMs, windowMs: ROLE_IDLE_WINDOW_MS, roles };
}

/**
 * F5 三信号卡住判定（卷 §五 / §十三；只读，不写任何文件）。
 */
export function detectStalledRoles(project, { now = Date.now() } = {}) {
  const name = String(project || '');
  const nowMs = Number(now) || Date.now();
  const scan = scanActivityRoles(name, { now: nowMs });
  return { ok: true, now: nowMs, windowMs: scan.windowMs, project: name, roles: scan.roles };
}

// ---------- 单链三层升级（卷 §四 / §十：一条链、去重键 itemId+level） ----------

function readQueueAlertState(project) {
  const name = String(project || '');
  const file = dispatchQueueStaleFile(name);
  let data = {};
  try { data = readJson(file) || {}; } catch { data = {}; }
  return {
    schema: 1,
    project: name,
    staleMs: DISPATCH_QUEUE_STALE_MS,
    alerted: normalizeQueueAlerted(data && data.alerted),
    updatedAt: String((data && data.updatedAt) || ''),
  };
}

/** 旧结构是 `alerted[itemId] = "<iso>"`（视为 notice）；新结构 `{itemId: {level: at}}`。 */
function normalizeQueueAlerted(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [itemId, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      if (value) out[String(itemId)] = { notice: value };
      continue;
    }
    if (value && typeof value === 'object') {
      const levels = {};
      for (const [level, at] of Object.entries(value)) {
        if (QUEUE_ALERT_LEVELS.includes(level) && typeof at === 'string' && at) levels[level] = at;
      }
      if (Object.keys(levels).length) out[String(itemId)] = levels;
    }
  }
  return out;
}

function writeQueueAlertState(project, state) {
  writeJson(dispatchQueueStaleFile(project), {
    schema: 1,
    project: String(project || ''),
    staleMs: DISPATCH_QUEUE_STALE_MS,
    alerted: normalizeQueueAlerted(state && state.alerted),
    updatedAt: nowIso(),
  });
}

function queueAlertLevelAt(alerted, itemId, level) {
  const row = (alerted && alerted[String(itemId)]) || {};
  const ms = Date.parse(String(row[String(level)] || ''));
  return Number.isFinite(ms) ? ms : 0;
}

/** 出队/恢复：清该 item 的全部 level 键（卷 §十）。 */
function clearQueueAlertLevels(project, itemId) {
  const name = String(project || '');
  const id = String(itemId || '');
  if (!name || !id) return false;
  const state = readQueueAlertState(name);
  if (!state.alerted[id]) return false;
  delete state.alerted[id];
  writeQueueAlertState(name, state);
  return true;
}

/**
 * R-1dfb 热修：升级/告警「检查去重 → 发消息 → 写 alerted」必须原子，
 * 否则多个泵进程（60 秒 tick + CLI pump + 每次 send/ack 顺带泵）同时读到旧状态，
 * 各自判定「没发过」→ 同一条 notice 在数秒内被重复发多次（实测 6 秒 6 条）。
 * 用 O_EXCL 锁文件做「抢占」：抢到的进程才发；抢不到直接跳过（下一轮若仍未发会再抢）。
 */
function dispatchAlertLockFile(project) {
  return path.join(projectStatePaths(project).dir, '派单告警.lock');
}

function acquireDispatchAlertLock(project) {
  const file = dispatchAlertLockFile(project);
  const tryOnce = () => {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } catch { /* 写 pid 失败不影响锁 */ }
      fs.closeSync(fd);
      return true;
    } catch { return false; }
  };
  if (tryOnce()) return { ok: true, file };
  // 陈旧锁（进程崩溃残留）：超过 60 秒视为失效，清一次再抢。
  try {
    const ageMs = Date.now() - fs.statSync(file).mtimeMs;
    if (Number.isFinite(ageMs) && ageMs > 60 * 1000) {
      try { fs.unlinkSync(file); } catch { /* 别人已清 */ }
      if (tryOnce()) return { ok: true, file };
    }
  } catch { /* 锁可能刚被释放 */ }
  return { ok: false, file };
}

function releaseDispatchAlertLock(lock) {
  if (!lock || !lock.ok) return;
  try { fs.unlinkSync(lock.file); } catch { /* 已被清不影响 */ }
}

/**
 * 发一条单链升级消息（notice/escalate/force 共用；去重键 itemId+level，24h 内只发一次）。
 * 文案写死带三样：attempt / 三信号各自多旧 / 最后回执时间（卷 §四）。
 */
function raiseQueueEscalation(project, { itemId, to, taskId = '', attempt = 1, stallMs = 0, level = 'notice', now = Date.now() } = {}) {
  const name = String(project || '');
  const id = String(itemId || '');
  const lv = String(level || '');
  const nowMs = Number(now) || Date.now();
  if (!name || !id || !QUEUE_ALERT_LEVELS.includes(lv)) return null;
  // 原子抢占：抢占失败 = 别的泵进程正在处理这一轮，本进程直接跳过（不重复发）。
  const lock = acquireDispatchAlertLock(name);
  if (!lock.ok) return null;
  try {
    return sendQueueEscalationLocked(name, { id, lv, nowMs, to, taskId, attempt, stallMs });
  } finally {
    releaseDispatchAlertLock(lock);
  }
}

function sendQueueEscalationLocked(name, { id, lv, nowMs, to, taskId = '', attempt = 1, stallMs = 0 }) {
  const state = readQueueAlertState(name);
  const last = queueAlertLevelAt(state.alerted, id, lv);
  if (last && nowMs - last < QUEUE_ALERT_LEVEL_DEDUPE_MS) return null;
  const roleKey = String(to || '');
  const ageMin = Math.max(0, Math.round(Number(stallMs || 0) / 60000));
  const signals = (() => {
    try { return roleSignalsOf(name, roleKey); } catch { return { fileAt: '', ackAt: '', workingAt: '' }; }
  })();
  const roleName = roleCnName(roleKey) || roleKey || '（无目标角色）';
  const subject = lv === 'notice'
    ? `派单队列滞留 ${ageMin} 分钟（notice）：发给${roleName}`
    : `派单队列滞留 ${ageMin} 分钟（${lv}）：发给${roleName}`;
  // 链首 notice 保留既有 B-4c6f 的「活跃度证据 / 判定：仍在动|空闲」段（既有断言与 PM 阅读习惯不破）；
  // 升级层同样带上它，PM 不必再翻别的文件。
  let activityLine = '';
  try {
    const activity = roleActivityEvidence(name, roleKey);
    activityLine = activity
      ? `活跃度证据：${activity.detail}\n判定：${activity.idle ? `空闲（${Math.round(activity.windowMs / 60000)} 分钟内无任何动静）` : '仍在动（不应补投，先看它在做什么）'}`
      : '活跃度证据：读取失败（按「不确定」处理，不自动补投）';
  } catch { activityLine = '活跃度证据：读取失败（按「不确定」处理，不自动补投）'; }
  const body = [
    `${id} 在派单队列里挂了 ${ageMin} 分钟还没投出去（level=${lv}）。`,
    `目标角色：${roleKey || '-'}`,
    `关联任务：${String(taskId || '') || '-'}`,
    `最新 attempt：${Number(attempt) || 1}（同一 attempt 不重复升级）`,
    `三信号：文件写入=${signals.fileAt || '无'}（${agoText(signals.fileAt, nowMs)}）；ack 回执=${signals.ackAt || '无'}（${agoText(signals.ackAt, nowMs)}）；近期 working=${signals.workingAt || '无'}（${agoText(signals.workingAt, nowMs)}）`,
    `最后回执：${signals.ackAt || '无'}`,
    activityLine,
    lv === 'force'
      ? '这是最高级通知（force），仍需 PM 显式决定是否强投；系统不会自动强投。'
      : '请 PM 过问（queue status 看现场 / queue pump 手动泵一次）。',
  ].join('\n');
  try {
    const msg = sendMessage({
      from: 'system', to: 'pm', type: 'escalation', project: name,
      subject: clipMessage(subject, 80), body: clipMessage(body), ackRequired: false,
    });
    state.alerted[id] = { ...(state.alerted[id] || {}), [lv]: nowIso() };
    writeQueueAlertState(name, state);
    appendEvent({
      role: 'system', sessionId: '', action: 'dispatch_queue_stale_alert', project: name,
      target: id, note: `level=${lv} to=${roleKey} attempt=${Number(attempt) || 1} age=${ageMin}min message=${msg.id}`,
    });
    return { itemId: id, level: lv, messageId: msg.id, ageMin, at: nowIso() };
  } catch (e) {
    return null;
  }
}

// ---------- F1/F4：deadline 状态机 + 12 键投递审计（卷 §三 / §八 / §十三） ----------

/**
 * 状态机到期检查（卷 §三；同步、不投递——投递仍由既有泵负责）。
 * 进入条件：队列项滞留 ≥ DISPATCH_QUEUE_IDLE_BACKFILL_MS。
 * 动作：queued → stalled（写 timeout，同一 item+attempt 只写一次）；按滞留时长走单链升级
 *       （notice 由 queueStaleCheck 链首保留，本函数补 escalate/force 并写 upgraded）。
 * source ∈ {deadline,tick}：deadline=到期定时器，tick=60 秒 tick 兜底；写进审计第 12 键。
 */
export function tickDispatchDeadlines(project, { now = Date.now(), source = 'tick' } = {}) {
  const name = String(project || '');
  if (!name) fail('BAD_PROJECT', '需要项目名');
  const src = String(source || '');
  if (src !== 'deadline' && src !== 'tick') {
    fail('BAD_SOURCE', `source 只能是 deadline 或 tick（触发本轮泵的来源）：${src}`, { allowed: ['deadline', 'tick'] });
  }
  const nowMs = Number(now) || Date.now();
  const at = new Date(nowMs).toISOString();
  const queue = readDispatchQueue(name);
  const state = readDeliveryState(name);
  const rows = [];
  const escalated = [];
  const retried = [];
  let checked = 0;
  let dirty = false;
  for (const item of queue.items) {
    if (!item || !item.id) continue;
    checked += 1;
    const itemId = String(item.id);
    const to = String(item.to || '');
    const taskId = String(item.task || '');
    const atMs = Date.parse(String(item.at || ''));
    if (!Number.isFinite(atMs)) continue;
    const stallMs = Math.max(0, nowMs - atMs);
    // T-1dfb 收口前置（PM 2026-11-17 10:17）：任务已闭环（done/accepted/cancelled/terminated）
    // 时该投递项必须就地 blocked，不得再升级/不再交给泵重投——否则已验收任务会被反复派出去。
    // 判定统一 gates.statusIsClosed 单源；任务文件不存在同样视为不可投。
    if (taskId) {
      const boundTask = (() => { try { return loadTask(name, taskId); } catch { return null; } })();
      if (!boundTask || statusIsClosed(boundTask.status)) {
        if (!state.items[itemId]) { state.items[itemId] = { ...emptyDeliveryItem(Number(item.attempt) || 1), lastAt: at }; dirty = true; }
        const curItem = state.items[itemId];
        if (curItem && String(curItem.state || '') !== 'blocked') {
          curItem.state = 'blocked';
          curItem.lastAt = at;
          curItem.lastCode = boundTask ? 'TASK_CLOSED' : 'TASK_MISSING';
          dirty = true;
          appendDeliveryAudit(name, {
            itemId, to, taskId, attempt: Number(curItem.attempt) || 1,
            result: 'blocked', code: curItem.lastCode, stallMs, messageId: '', wakeOk: false, source: src,
          });
          rows.push({ itemId, to, taskId, result: 'blocked', level: '', messageId: '', code: curItem.lastCode });
        }
        continue;
      }
    }
    if (!state.items[itemId]) {
      state.items[itemId] = { ...emptyDeliveryItem(Number(item.attempt) || 1), lastAt: at };
      dirty = true;
    }
    const cur = state.items[itemId];
    const attempt = Number(cur.attempt) || 1;
    if (String(cur.state || '') === 'forced') continue; // forced 是终态：不再参与超时统计
    if (stallMs < DISPATCH_QUEUE_IDLE_BACKFILL_MS) continue;
    // ① 到期：queued → stalled（同一 item+attempt 只写一次 timeout）
    if (!['stalled', 'upgraded'].includes(String(cur.state || ''))) {
      cur.state = 'stalled';
      cur.stalledAt = at;
      cur.lastAt = at;
      cur.lastCode = 'DEADLINE_EXCEEDED';
      dirty = true;
      appendDeliveryAudit(name, {
        itemId, to, taskId, attempt, result: 'timeout', code: 'DEADLINE_EXCEEDED',
        stallMs, messageId: '', wakeOk: false, source: src,
      });
      rows.push({ itemId, to, taskId, result: 'timeout', level: '', messageId: '' });
      // 交给调用方泵（deadline 定时器 / 60 秒 tick）——本函数不投递
      retried.push({ itemId, to, taskId, attempt });
    }
    // ② 单链三层：链首 notice（queueStaleCheck 的既有行为）→ escalate → force
    const levels = ['notice'];
    if (stallMs >= AWB_STALL_ESCALATE_MS) levels.push('escalate');
    if (stallMs >= AWB_STALL_FORCE_MS) levels.push('force');
    for (const level of levels) {
      const sent = raiseQueueEscalation(name, { itemId, to, taskId, attempt, stallMs, level, now: nowMs });
      if (!sent) continue;
      escalated.push({ itemId, level, messageId: sent.messageId });
      if (level === 'notice') continue; // 链首只发通知，不迁移状态、不写投递审计
      rows.push({ itemId, to, taskId, result: 'upgraded', level, messageId: sent.messageId });
      cur.state = 'upgraded';
      cur.upgradedAt = at;
      cur.lastAt = at;
      cur.lastCode = `UPGRADED_${level.toUpperCase()}`;
      dirty = true;
      appendDeliveryAudit(name, {
        itemId, to, taskId, attempt, result: 'upgraded', code: `STALL_${level.toUpperCase()}`,
        stallMs, messageId: sent.messageId, wakeOk: false, source: src,
      });
    }
  }
  if (dirty) writeDeliveryState(name, state);
  return { ok: true, source: src, now: nowMs, checked, rows, escalated, retried };
}

// ---------- F6：idle 角色恢复（重新入队 + 自动唤醒 + 分级 + 恢复清标） ----------

function stalledQueueItemId(role, taskId) {
  return `Q-STALL-${String(role || '')}-${String(taskId || '').replace(/[^\w-]/g, '') || 'NO_TASK'}`;
}

function taskIdFromStalledItemId(itemId) {
  const m = /^Q-STALL-[^-]+-(.+)$/.exec(String(itemId || ''));
  return m ? String(m[1] || '') : '';
}

function lastRoleActivityRow(rows, role) {
  const key = String(role || '');
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row && String(row.role || '') === key) return row;
  }
  return null;
}

function lastRoleAuditAt(rows, role, action) {
  const key = String(role || '');
  let latest = 0;
  for (const row of rows) {
    if (!row || String(row.role || '') !== key) continue;
    if (String(row.action || '') !== String(action || '')) continue;
    const ms = Date.parse(String(row.at || ''));
    if (Number.isFinite(ms) && ms > latest) latest = ms;
  }
  return latest;
}

function itemIdsFromActivityRow(row) {
  const detail = String((row && row.detail) || '');
  const m = /itemIds=([^;]*)/.exec(detail);
  if (!m) return [];
  return String(m[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * 从活跃度审计里读回「上次连续 idle 次数 / 连续唤醒失败次数」（detail 自带计数，跨进程可复算）。
 * 遇到 recovered 行即清零（一轮空闲结束，下一次重新从 1 计）。
 */
function lastIdleEpisodeCounters(rows, role) {
  const key = String(role || '');
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row || String(row.role || '') !== key) continue;
    const action = String(row.action || '');
    if (action === 'recovered') return { consecutive: 0, wakeFailures: 0 };
    if (action !== 'stalled' && action !== 'woken' && action !== 'escalated') continue;
    const detail = String(row.detail || '');
    const c = /consecutive=(\d+)/.exec(detail);
    const w = /wakeFailures=(\d+)/.exec(detail);
    return { consecutive: c ? Number(c[1]) || 0 : 0, wakeFailures: w ? Number(w[1]) || 0 : 0 };
  }
  return { consecutive: 0, wakeFailures: 0 };
}

/** B-27ca：idle episode 状态文件（持久化，重启不重置；verdict 转 active 时清空该角色条目）。 */
function idleEpisodeFile(project) {
  return path.join(projectStatePaths(project).dir, '唤醒-空闲episode.json');
}
function readIdleEpisodes(project) {
  try { return readJson(idleEpisodeFile(project)) || {}; } catch { return {}; }
}
function writeIdleEpisodes(project, data) {
  try { writeJson(idleEpisodeFile(project), data || {}); } catch { /* 状态写失败不影响唤醒判定 */ }
}

/** 空闲角色自动唤醒（走既有唤醒链；失败只记 code，不直接升级）。 */
async function wakeStalledRole(project, role) {
  const name = String(project || '');
  const roleKey = String(role || '');
  const messageId = `WAKE-STALL-${stamp()}-${randomHex(2)}`;
  // B-27ca：同一 idle episode 只唤醒一次。episode 由「首次判 idle 的时间戳」界定并持久化：
  //  - 首次 idle：写入 {startAt} 并正常唤醒；
  //  - 同 episode 再拍：跳过唤醒（返回 skipped=IDLE_EPISODE_DEDUP），只写审计，不重发；
  //  - verdict 转 active 时由 recoverStalledRoles 清空该角色条目 → 下次 idle 是新 episode。
  const episodes = readIdleEpisodes(name);
  const nowIso = new Date().toISOString();
  let episode = episodes[roleKey];
  if (!episode || !episode.startAt) {
    episode = { startAt: nowIso, wokeAt: '', escalatedAt: '' };
    episodes[roleKey] = episode;
    writeIdleEpisodes(name, episodes);
  }
  if (episode.wokeAt) {
    // 同 episode 已唤醒过：只落审计（唤醒日志 + 事件），不再真唤醒。
    try {
      appendEvent({ role: 'system', action: 'wake_skipped', project: name, target: roleKey,
        note: `reason=stalled;skipped=IDLE_EPISODE_DEDUP;episode=${episode.startAt}` });
    } catch { /* 审计失败不阻断 */ }
    return { ok: true, skipped: 'IDLE_EPISODE_DEDUP', episodeStart: episode.startAt, messageId: '', code: '' };
  }
  episode.wokeAt = nowIso;
  episodes[roleKey] = episode;
  writeIdleEpisodes(name, episodes);
  try {
    const wake = await wakeWithGuard({
      project: name, to: roleKey, isDispatch: false,
      msg: {
        id: messageId, from: 'system', to: roleKey, type: 'notice',
        subject: `空闲唤醒：${roleCnName(roleKey)}`, project: name, task: '',
      },
      reason: 'stalled', dedupeKey: `idle-episode:${roleKey}:${episode.startAt}`,
    });
    const ok = Boolean(wake && wake.ok === true);
    return {
      ok,
      messageId: ok ? messageId : '',
      code: ok ? '' : String((wake && (wake.code || wake.why)) || 'WAKE_FAILED'),
    };
  } catch (e) {
    return { ok: false, messageId: '', code: String((e && (e.code || e.message)) || 'WAKE_FAILED') };
  }
}

/**
 * 把 idle 角色的未闭环任务重新入队（幂等键 itemId+attempt：已存在同 id 项或同 attempt 近期已入队 → 不新增、不自增）。
 * 返回 true 表示本次真的新增了队列项。
 */
export function requeueStalledItem(project, { itemId, role, taskId, now, attempt }) {
  const name = String(project || '');
  const id = String(itemId || '');
  const nowMs = Number(now) || Date.now();
  if (!name || !id) return { enqueued: false, skipped: 'bad_args', attempt: 1 };
  const queue = readDispatchQueue(name);
  if (queue.items.some((row) => String((row && row.id) || '') === id)) return { enqueued: false, skipped: 'already_queued', attempt: Math.max(1, Number(attempt) || 1) };
  // B-1d90：入队前再兜一层（生产端批量灌队列的根因）：
  //   ①任务不存在（历史 itemId 残留）②已闭环 ③镜像 ④该角色当前 claim 的正是这条 → 都不入队。
  if (String(taskId || '')) {
    let candidateTask = null;
    try { candidateTask = loadTask(name, String(taskId)); } catch { candidateTask = null; }
    if (!candidateTask) return { enqueued: false, skipped: 'task_missing', attempt: Math.max(1, Number(attempt) || 1) };
    if (statusIsClosed(candidateTask.status)) return { enqueued: false, skipped: 'task_closed', attempt: Math.max(1, Number(attempt) || 1) };
    if (isRequirementMirrorTask(candidateTask)) return { enqueued: false, skipped: 'mirror_task', attempt: Math.max(1, Number(attempt) || 1) };
    if (taskClaimedByRole(candidateTask, role)) return { enqueued: false, skipped: 'self_claimed', attempt: Math.max(1, Number(attempt) || 1) };
  }
  const state = readDeliveryState(name);
  const rec = state.items[id] || null;
  const lastMs = rec ? Date.parse(String(rec.lastAt || '')) : NaN;
  const prevAttempt = Math.max(1, Number(rec && rec.attempt) || Number(attempt) || 1);
  // B-ebbc ②：同一 itemId 的两次重投至少间隔 10 分钟（delivered/stalled/upgraded 一视同仁——
  // 升级后状态变 upgraded，若不按 lastAt 统一去抖仍会每拍重投）。
  if (rec && Number.isFinite(lastMs)) {
    if (nowMs - lastMs < REPUSH_MIN_GAP_MS) return { enqueued: false, skipped: 'repush_backoff', attempt: prevAttempt };
    if (countRepushToday(name, id, nowMs) >= REPUSH_DAILY_CAP) return { enqueued: false, skipped: 'daily_cap', attempt: prevAttempt };
    const nextAttempt = prevAttempt + 1;
    if (nextAttempt >= REPUSH_MAX_ATTEMPT) return { enqueued: false, skipped: 'attempt_cap', attempt: prevAttempt };
    attempt = nextAttempt;
  }
  const at = new Date(nowMs).toISOString();
  const roleName = roleCnName(role) || role;
  const body = [
    `空闲重派：检测到 ${roleName}（${role}）连续 ${Math.max(1, Math.round(ROLE_IDLE_WINDOW_MS / 60000))} 分钟窗口内无文件写入、无回执、无工作更新，但其名下还有未闭环任务。`,
    `任务：${String(taskId || '') || '（未绑定任务）'}`,
    `attempt：${Number(attempt) || 1}（同一 item+attempt 不重复入队，也不自增 attempt）`,
    '请继续推进；若确实卡住，请回执说明卡在哪一步（不改任务状态、不重派他人）。',
  ].join('\n');
  queue.items.push({
    id, at, from: 'system', to: String(role || ''),
    subject: `空闲重派：${roleName} 有未闭环任务`,
    body: clipMessage(body),
    task: String(taskId || ''), project: name, reason: 'stalled',
    attempt: Number(attempt) || 1, ackRequired: true,
  });
  writeDispatchQueue(name, queue);
  return { enqueued: true, skipped: '', attempt: Number(attempt) || 1 };
}

/**
 * F6 stalled 路径（卷 §五 / §(五)）：idle 角色 → 重新入队 + 自动唤醒 + 写活跃度审计 + 分级；
 * 恢复（任一信号进窗口）→ 写 recovered 审计并清标。不改任务状态、不重派他人。
 * write=false 时只算不写（演练）。
 */
export async function recoverStalledRoles(project, { now = Date.now(), write = true } = {}) {
  const name = String(project || '');
  if (!name) fail('BAD_PROJECT', '需要项目名');
  const nowMs = Number(now) || Date.now();
  const at = new Date(nowMs).toISOString();
  const detection = detectStalledRoles(name, { now: nowMs });
  const rows = [];
  const cleared = [];
  const escalated = [];
  const auditRows = readRoleActivityAuditRows(name);
  const state = readDeliveryState(name);
  const alertState = readQueueAlertState(name);
  let stateDirty = false;
  let alertDirty = false;

  // ① 恢复清标：上次判定 stalled/escalated/woken，但现在有信号在窗口内（或三源全缺 → unknown 不动）
  for (const [role, info] of Object.entries(detection.roles || {})) {
    const last = lastRoleActivityRow(auditRows, role);
    if (!last) continue;
    if (!['stalled', 'escalated', 'woken'].includes(String(last.action || ''))) continue;
    if (info.verdict === 'idle' || info.verdict === 'unknown') continue;
    const itemIds = itemIdsFromActivityRow(last);
    if (write) {
      for (const itemId of itemIds) {
        if (alertState.alerted[itemId]) { delete alertState.alerted[itemId]; alertDirty = true; }
        const rec = state.items[itemId];
        const attempt = Number(rec && rec.attempt) || 1;
        if (rec) {
          rec.state = 'delivered';
          rec.lastAt = at;
          rec.lastCode = 'RECOVERED';
          rec.stalledAt = '';
          rec.upgradedAt = '';
          stateDirty = true;
        }
        appendDeliveryAudit(name, {
          itemId, to: role, taskId: taskIdFromStalledItemId(itemId), attempt,
          result: 'recovered', code: '', stallMs: 0, messageId: '', wakeOk: false, source: 'tick',
        });
      }
      appendRoleActivityAudit(name, {
        at, project: name, role, action: 'recovered', verdict: info.verdict, idleMs: info.idleMs,
        signals: info.signals, wake: { ok: false, messageId: '', code: '' }, level: 'none',
        detail: `reason=signal_active;itemIds=${itemIds.join(',')}`,
      });
    }
    // B-27ca：角色恢复活跃 → 结束本 idle episode（下次 idle 是新 episode，可再唤醒一次）。
    const episodesNow = readIdleEpisodes(name);
    if (episodesNow[role]) { delete episodesNow[role]; writeIdleEpisodes(name, episodesNow); }

    cleared.push({ role, itemIds });
  }

  // ② idle 角色：重新入队 + 自动唤醒 + 分级
  for (const [role, info] of Object.entries(detection.roles || {})) {
    if (info.verdict !== 'idle') continue;
    // T-1dfb 收口前置（PM 2026-11-17 10:17）：F6 入队前必须按**当前**任务状态过滤已闭环任务
    // （done/accepted/cancelled/terminated 均算闭环，统一走 gates.statusIsClosed 单源），并去重；
    // 否则同一 tick 会把已验收任务重新灌进队列、并派给角色去做已完成的事。
    const taskStatusById = new Map(listTasks(name).map((task) => [String(task.id), String(task.status || '')]));
    const seenTaskIds = new Set();
    const openTaskIds = (Array.isArray(info.openTaskIds) ? info.openTaskIds : []).filter((taskId) => {
      const id = String(taskId || '');
      if (!id || seenTaskIds.has(id)) return false;
      if (!taskStatusById.has(id)) return false; // 任务已不存在 → 不入队
      if (statusIsClosed(taskStatusById.get(id))) return false; // 已闭环终态 → 不入队
      seenTaskIds.add(id);
      return true;
    });
    // B-20261117-102215-d52c（PM 2026-11-17 10:22）：同一 tick 同一角色入队上限 ≤3，
    // 超出的任务本次丢弃并写活跃度审计（防一次 tick 灌 N 条脏队列；被丢弃的下个 tick 会重新评估）。
    const ENQUEUE_CAP_PER_TICK = 3;
    const droppedTaskIds = openTaskIds.slice(ENQUEUE_CAP_PER_TICK);
    if (droppedTaskIds.length) {
      openTaskIds.length = ENQUEUE_CAP_PER_TICK;
      // 审计走投递审计（活跃度审计 action 有枚举白名单，不能新增 action）：每个被丢弃任务一行 blocked/ENQUEUE_CAP。
      for (const droppedId of droppedTaskIds) {
        appendDeliveryAudit(name, {
          itemId: stalledQueueItemId(role, String(droppedId)), to: role, taskId: String(droppedId), attempt: 1,
          result: 'blocked', code: 'ENQUEUE_CAP', stallMs: Math.max(0, Number(info.idleMs) || 0),
          messageId: '', wakeOk: false, source: 'tick',
        });
      }
    }
    const targetTaskIds = openTaskIds.length ? openTaskIds : [''];
    const attempt = Number(
      (state.items[stalledQueueItemId(role, targetTaskIds[0] || '')] || {}).attempt,
    ) || 1; // attempt 取现值：重投不自增（自增只由「投递成功后再失败」触发）
    const itemIds = targetTaskIds.map((taskId) => stalledQueueItemId(role, taskId));
    const wake = write ? await wakeStalledRole(name, role) : { ok: false, messageId: '', code: 'DRY_RUN' };
    const prevCounters = lastIdleEpisodeCounters(auditRows, role);
    const wakeFailures = wake.ok === true ? 0 : (prevCounters.wakeFailures + (write ? 1 : 0));
    const consecutive = prevCounters.consecutive + 1;
    const level = (consecutive >= AWB_STALL_IDLE_CONSECUTIVE || wakeFailures >= STALL_WAKE_FAIL_UPGRADE) ? 'escalate' : 'notice';
    const requeued = [];
    if (write) {
      for (let i = 0; i < itemIds.length; i += 1) {
        const itemId = itemIds[i];
        const taskId = targetTaskIds[i] || '';
        const repush = requeueStalledItem(name, { itemId, role, taskId, now: nowMs, attempt });
        if (!repush.enqueued) {
          // B-1d90：入队被过滤（任务闭环/镜像/自身在办/任务不存在）→ 每 itemId 每天只记一行，便于核对不刷屏。
          if (['task_closed', 'mirror_task', 'self_claimed', 'task_missing'].includes(String(repush.skipped || '')) && !hasRepushFilterAlert(name, itemId, nowMs)) {
            appendDeliveryAudit(name, {
              itemId, to: role, taskId, attempt: Math.max(1, Number(repush.attempt) || 1), result: 'blocked', code: 'REPUSH_FILTERED_' + String(repush.skipped || '').toUpperCase(),
              stallMs: Math.max(0, Number(info.idleMs) || 0), messageId: '', wakeOk: false, source: 'tick',
            });
          }
          // B-ebbc：attempt 用尽 → 放弃并只告警一次（ATTEMPT_CAP 审计行）；之后静默，不再每拍重投。
          if (repush.skipped === 'attempt_cap' && !hasRepushCapAlert(name, itemId)) {
            appendDeliveryAudit(name, {
              itemId, to: role, taskId, attempt: repush.attempt, result: 'blocked', code: 'ATTEMPT_CAP',
              stallMs: Math.max(0, Number(info.idleMs) || 0), messageId: wake.messageId || '',
              wakeOk: wake.ok === true, source: 'tick',
            });
          }
          continue;
        }
        requeued.push(itemId);
        const effAttempt = Number(repush.attempt) || attempt;
        const rec = state.items[itemId] || null;
        state.items[itemId] = {
          ...emptyDeliveryItem(effAttempt),
          ...(rec || {}),
          state: 'stalled', attempt: effAttempt, lastAt: at, lastCode: 'STALLED', stalledAt: at,
          upgradedAt: String((rec && rec.upgradedAt) || ''),
        };
        stateDirty = true;
        appendDeliveryAudit(name, {
          itemId, to: role, taskId, attempt: effAttempt, result: 'retry', code: 'STALLED_REQUEUE',
          stallMs: Math.max(0, Number(info.idleMs) || 0), messageId: wake.messageId || '',
          wakeOk: wake.ok === true, source: 'tick',
        });
      }
      appendRoleActivityAudit(name, {
        at, project: name, role, action: 'stalled', verdict: 'idle', idleMs: info.idleMs,
        signals: info.signals, wake, level,
        detail: `reason=stalled;itemIds=${itemIds.join(',')};attempt=${attempt};consecutive=${consecutive};wakeFailures=${wakeFailures}`,
      });
      // 卷 §七 action 枚举里的 woken：本轮确实把角色叫醒了 → 另写一行（与 stalled 同轮各一行，
      // stalled=「判定 stalled 并重新入队」，woken=「自动唤醒成功」；唤醒失败只留 stalled 行 + wake.code）。
      if (wake.ok === true) {
        appendRoleActivityAudit(name, {
          at: new Date(nowMs + 1).toISOString(), project: name, role, action: 'woken', verdict: 'idle', idleMs: info.idleMs,
          signals: info.signals, wake, level,
          detail: `reason=woken;wakeMessageId=${wake.messageId || ''};itemIds=${itemIds.join(',')};attempt=${attempt};consecutive=${consecutive};wakeFailures=0`,
        });
      }
    }
    // 连续 2 次 idle → 红标 + PM escalation（30 分钟去重）
    let escalation = null;
    if (level === 'escalate') {
      const lastEscalatedMs = lastRoleAuditAt(auditRows, role, 'escalated');
      const canEscalate = !lastEscalatedMs || nowMs - lastEscalatedMs >= 30 * 60 * 1000;
      if (write && canEscalate) {
        try {
          const msg = sendMessage({
            from: 'system', to: 'pm', type: 'escalation', project: name,
            subject: clipMessage(`角色连续 ${consecutive} 次空闲未动：${roleCnName(role) || role}`, 80),
            body: clipMessage([
              `${roleCnName(role) || role}（${role}）已连续 ${consecutive} 次判定为空闲（窗口 ${Math.round(detection.windowMs / 60000)} 分钟）。`,
              `未闭环任务：${openTaskIds.join(',') || '无'}`,
              `三信号：文件写入=${info.signals.fileAt || '无'}（${agoText(info.signals.fileAt, nowMs)}）；ack 回执=${info.signals.ackAt || '无'}（${agoText(info.signals.ackAt, nowMs)}）；近期 working=${info.signals.workingAt || '无'}（${agoText(info.signals.workingAt, nowMs)}）`,
              `最后回执：${info.signals.ackAt || '无'}`,
              `自动唤醒：ok=${wake.ok === true}${wake.ok === true ? '' : `（${wake.code || '失败'}）`}；已重新入队 ${requeued.length} 项。`,
              '系统不会自动强投；请 PM 决定是否介入（催办/换人/拆任务）。',
            ].join('\n')),
            ackRequired: false,
          });
          escalation = { role, messageId: msg.id, consecutive };
          appendRoleActivityAudit(name, {
            at: nowIso(), project: name, role, action: 'escalated', verdict: 'idle', idleMs: info.idleMs,
            signals: info.signals, wake, level: 'escalate',
            detail: `reason=consecutive_idle;consecutive=${consecutive};wakeFailures=${wakeFailures};itemIds=${itemIds.join(',')}`,
          });
          for (const itemId of itemIds) {
            const rec = state.items[itemId];
            if (!rec) continue;
            rec.state = 'upgraded';
            rec.upgradedAt = at;
            rec.lastAt = at;
            rec.lastCode = 'UPGRADED_IDLE';
            stateDirty = true;
          }
          appendDeliveryAudit(name, {
            itemId: itemIds[0] || '', to: role, taskId: targetTaskIds[0] || '', attempt,
            result: 'upgraded', code: 'STALL_IDLE_CONSECUTIVE', stallMs: Math.max(0, Number(info.idleMs) || 0),
            messageId: msg.id, wakeOk: wake.ok === true, source: 'tick',
          });
          escalated.push(escalation);
        } catch (e) {
          escalation = { role, error: String((e && e.message) || e) };
        }
      }
    }
    rows.push({
      role, verdict: 'idle', action: level === 'escalate' ? 'escalated' : 'stalled',
      itemIds, wake, level,
    });
  }

  if (write && stateDirty) writeDeliveryState(name, state);
  if (write && alertDirty) writeQueueAlertState(name, alertState);
  return { ok: true, now: nowMs, rows, cleared, escalated };
}

/**
 * F7 取数：团队台三列（卷 §六）。
 * commitAt = 提交/*.json 中 author===roleId 的 createdAt 最大值（不是 createdBy/at）；
 * fileAt   = 角色目录内文件 max mtime（同 §五）；
 * wakeAt   = 唤醒.jsonl 中 to===roleId && ok===true 的最后 at；
 * 无值给 '' 并在 unknownReasons 记原因（no-submit-record / no-write-in-window / no-wake-ok）。
 */
export function computeRoleActivity(project, { now = Date.now() } = {}) {
  const name = String(project || '');
  if (!name) fail('BAD_PROJECT', '需要项目名');
  const nowMs = Number(now) || Date.now();
  // AC8：与 detectStalledRoles 共用同一次三源扫描（不再重复扫目录）；提交/唤醒按文件签名做进程内缓存。
  const scan = scanActivityRoles(name, { now: nowMs });
  const commits = readCommitRows(name);
  const wakes = readWakeRowsNewestFirst(name);
  const roles = {};
  for (const [role, info] of Object.entries(scan.roles || {})) {
    const commitAt = latestCommitAt(commits, role);
    const fileAt = String((info.signals || {}).fileAt || '');
    const wakeAt = latestWakeOkAt(wakes, role);
    const unknownReasons = [];
    if (!commitAt) unknownReasons.push('no-submit-record');
    if (!fileAt) unknownReasons.push('no-write-in-window');
    if (!wakeAt) unknownReasons.push('no-wake-ok');
    roles[role] = { commitAt, fileAt, wakeAt, verdict: info.verdict, unknownReasons };
  }
  return { ok: true, readAt: nowIso(), project: name, roles };
}

/** 提交记录（68 份级）：目录签名（mtimeMs+文件数）没变就复用进程内缓存（AC8）。 */
const COMMIT_ROWS_CACHE = new Map();
function readCommitRows(project) {
  const dir = projectStatePaths(String(project || '')).commits;
  let files = [];
  try { files = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  let sig = `${files.length}`;
  try { sig += `|${fs.statSync(dir).mtimeMs}`; } catch { /* 目录 stat 失败就只按文件数判 */ }
  const hit = COMMIT_ROWS_CACHE.get(dir);
  if (hit && hit.sig === sig) return hit.rows;
  const rows = [];
  for (const file of files) {
    try {
      const row = readJson(path.join(dir, file));
      if (row && typeof row === 'object') rows.push(row);
    } catch { /* 单份坏文件跳过 */ }
  }
  COMMIT_ROWS_CACHE.set(dir, { sig, rows });
  return rows;
}

function latestCommitAt(commits, role) {
  const key = String(role || '');
  let latest = '';
  let latestMs = 0;
  for (const row of commits) {
    if (!row || String(row.author || '') !== key) continue;
    const ts = String(row.createdAt || '');
    const ms = Date.parse(ts);
    if (Number.isFinite(ms) && ms > latestMs) { latestMs = ms; latest = ts; }
  }
  return latest;
}

/** 唤醒.jsonl 体积大（数千行）：按文件签名缓存文本与解析结果（AC8）；返回「最新在前」的行。 */
const WAKE_ROWS_CACHE = new Map();
function readWakeRowsNewestFirst(project) {
  const file = path.join(projectStatePaths(String(project || '')).dir, '唤醒.jsonl');
  let sig = '';
  try {
    const st = fs.statSync(file);
    sig = `${st.mtimeMs}|${st.size}`;
  } catch { return []; }
  const hit = WAKE_ROWS_CACHE.get(file);
  if (hit && hit.sig === sig) return hit.rows;
  const text = cachedFileText(file) || '';
  const lines = text.split(/\r?\n/);
  const rows = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const s = String(lines[i] || '').trim();
    if (!s) continue;
    try {
      const row = JSON.parse(s);
      if (row && typeof row === 'object') rows.push(row);
    } catch { /* 坏行跳过 */ }
  }
  WAKE_ROWS_CACHE.set(file, { sig, rows });
  return rows;
}

function latestWakeOkAt(wakeRowsNewestFirst, role) {
  const key = String(role || '');
  for (const row of wakeRowsNewestFirst) {
    if (!row) continue;
    if (String(row.to || '') !== key) continue;
    if (row.ok !== true) continue;
    const ts = String(row.at || row.time || '');
    if (ts) return ts;
  }
  return '';
}

/**
 * 只读入口（CLI）：跑 detectStalledRoles，不写任何审计，返回同构结果（卷 §九 free/idle 夹具）。
 */
export function queueIdleCheck(project, { now = Date.now() } = {}) {
  const name = String(project || '');
  if (!name) fail('BAD_PROJECT', '需要项目名');
  return detectStalledRoles(name, { now });
}


/**
 * 队列项会话对齐（B-bbf6 ③）：换人/rotate 后旧 `sessionId` 的队列项不能永久悬挂。
 * - 发件会话过期但发件角色还有活会话 → 改投新会话（写回队列 + 审计 dispatch_queue_session_rebased）；
 * - 目标角色已不在名册 / 发件角色也没有活会话 → 作废：从队列移除，整条落 派单队列归档.jsonl（可回滚），
 *   审计 dispatch_queue_discarded；绝不静默删除。
 */
export function reconcileDispatchQueueSessions(projectName, { reason = '', by = 'system', dryRun = false } = {}) {
  const name = String(projectName || '');
  if (!name) return { ok: false, code: 'BAD_PROJECT', rebased: [], discarded: [], kept: [] };
  const team = loadTeam();
  const members = Array.isArray(team.members) ? team.members : [];
  const memberOf = (role) => members.find((m) => m && String(m.role || '') === String(role || '')) || null;
  const sessionOf = (role) => {
    const m = memberOf(role);
    return m && m.sessionId && String(m.status || 'active') !== 'inactive' ? String(m.sessionId) : '';
  };
  const liveSessions = new Set(members.map((m) => String((m && m.sessionId) || '')).filter(Boolean));
  const queue = readDispatchQueue(name);
  const rebased = [];
  const discarded = [];
  const kept = [];
  const next = [];
  const now = nowIso();
  for (const item of queue.items) {
    if (!item || typeof item !== 'object') continue;
    const to = String(item.to || '');
    const from = String(item.from || 'pm');
    const targetMember = memberOf(to);
    const senderSession = sessionOf(from);
    const queuedSession = String(item.sessionId || '');
    const staleSession = queuedSession && !liveSessions.has(queuedSession);
    if (!targetMember) {
      // 目标角色已不在名册：作废（留审计 + 归档行）
      discarded.push({ ...item, discardedAt: now, discardedReason: 'target_role_not_in_roster', discardedBy: by });
      continue;
    }
    if (staleSession) {
      if (!senderSession) {
        discarded.push({ ...item, discardedAt: now, discardedReason: 'sender_session_gone', discardedBy: by });
        continue;
      }
      const fixed = { ...item, sessionId: senderSession, rebasedAt: now, rebasedReason: reason || 'session_changed' };
      rebased.push({ id: item.id, to, from, oldSessionId: queuedSession, newSessionId: senderSession });
      next.push(fixed);
      continue;
    }
    kept.push({ id: item.id, to, from });
    next.push(item);
  }
  const changed = rebased.length || discarded.length;
  if (changed && !dryRun) {
    writeDispatchQueue(name, { items: next });
    for (const row of discarded) {
      try { appendLine(dispatchQueueArchiveFile(name), JSON.stringify({ at: now, project: name, action: 'discard', item: row })); } catch { /* 归档失败仍要写事件 */ }
      appendEvent({ role: 'system', sessionId: '', action: 'dispatch_queue_discarded', project: name, target: String(row.id || ''), note: `to=${row.to || ''} reason=${row.discardedReason} by=${by}` });
    }
    for (const row of rebased) {
      appendEvent({ role: 'system', sessionId: '', action: 'dispatch_queue_session_rebased', project: name, target: String(row.id || ''), note: `to=${row.to} old=${String(row.oldSessionId).slice(0, 16)} new=${String(row.newSessionId).slice(0, 16)} reason=${reason || '-'}` });
    }
  }
  return { ok: true, rebased, discarded, kept, changed: Boolean(changed), dryRun, remaining: next.length };
}

/**
 * B-20261116-104830-09117a ④：派单队列「清存量」。
 * 滞留项真正投不出去的原因分三类，prune 只处理「已经不需要投」的那两类：
 *   ① 绑定的任务已闭环（done/cancelled）→ 再投就是重复派单；② 业务已明确作废（PM 指定；本函数只认任务闭环）；
 *   ③ 目标角色不在名册 → 永远投不出。
 * 「角色忙且确实在动」的项**不能**清（那是队列在正常工作，等角色空闲/做完再投）。
 * 默认 dry-run；--apply 才写盘：移除队列项 + 派单队列归档.jsonl 一行（可回滚）+ 事件。
 */
export function pruneDispatchQueue(projectName, { apply = false, reason = 'queue_prune', by = 'pm' } = {}) {
  const name = String(projectName || '');
  if (!name) return { ok: false, code: 'BAD_PROJECT', items: [], kept: [] };
  const queue = readDispatchQueue(name);
  const team = (() => { try { return loadTeam(); } catch { return { members: [] }; } })();
  const roster = new Set((Array.isArray(team.members) ? team.members : []).map((m) => String((m && m.role) || '')));
  const tasks = (() => { try { return new Map(listTasks(name).map((task) => [String(task.id), task])); } catch { return new Map(); } })();
  const items = [];
  const kept = [];
  for (const item of queue.items) {
    if (!item || typeof item !== 'object') continue;
    const taskId = String(item.task || '');
    let why = '';
    if (taskId) {
      const task = tasks.get(taskId);
      if (!task) why = 'task_missing';
      else if (statusIsClosed(String((task && task.status) || ''))) why = 'task_closed';
    }
    if (!why && item.to && roster.size && !roster.has(String(item.to))) why = 'target_not_in_roster';
    if (why) items.push({ id: String(item.id || ''), to: String(item.to || ''), task: taskId, why, subject: String(item.subject || '').slice(0, 60) });
    else kept.push(item);
  }
  const applied = Boolean(apply) && items.length > 0;
  if (applied) {
    writeDispatchQueue(name, { items: kept });
    const at = nowIso();
    for (const row of items) {
      try {
        appendLine(dispatchQueueArchiveFile(name), JSON.stringify({
          at, project: name, action: 'prune', reason, by,
          item: queue.items.find((it) => String(it && it.id) === row.id) || row,
        }));
      } catch { /* 归档失败仍要写事件 */ }
      appendEvent({ role: 'system', sessionId: '', action: 'dispatch_queue_pruned', project: name, target: row.id, note: `to=${row.to} why=${row.why} by=${by}` });
    }
  }
  return { ok: true, project: name, dryRun: !applied, applied, reason, by, items, kept, remaining: applied ? kept.length : queue.items.length };
}

export async function cmdQueue(args) {
  const sub = String((args._ && args._[1]) || 'pump');
  const project = String(args.project || '');
  if (!project) fail('BAD_PROJECT', '需要 --project');
  if (sub === 'idle-check') {
    // R-1dfb 卷 §九：专用只读入口——跑一次 detectStalledRoles 并按 §七 同构输出，**不写任何审计**。
    // 沙盘用 --now 前进时间，压缩 10 分钟等待（不许真等）。
    let nowMs = Date.now();
    if (args.now !== undefined && args.now !== true) {
      const raw = String(args.now).trim();
      const numeric = Number(raw);
      const parsed = Number.isFinite(numeric) && raw !== '' ? numeric : Date.parse(raw);
      if (!Number.isFinite(parsed)) fail('BAD_NOW', `--now 需要 ISO 时间或毫秒时间戳：${raw}`);
      nowMs = parsed;
    }
    const result = queueIdleCheck(project, { now: nowMs });
    const rows = Object.entries(result.roles || {}).map(([role, info]) => ({
      角色: roleCnName(role) || role,
      verdict: info.verdict,
      静止分钟: Number.isFinite(info.idleMs) && info.idleMs >= 0 ? Math.round(info.idleMs / 60000) : '—',
      缺信号: (info.missingSignals || []).join(',') || '—',
      未闭环: (info.openTaskIds || []).length,
    }));
    if (args.json) { process.stdout.write(JSON.stringify(result) + '\n'); return; }
    textOut(`空闲判定（窗口 ${Math.round(result.windowMs / 60000)} 分钟，只读，不写审计）\n` + table(rows, [
      { key: '角色', label: '角色' }, { key: 'verdict', label: '判定' }, { key: '静止分钟', label: '静止(分)' },
      { key: '缺信号', label: '缺信号' }, { key: '未闭环', label: '未闭环任务' },
    ]));
    return;
  }
  if (sub === 'status') {
    const queue = readDispatchQueue(project);
    out(args, `派单队列：${queue.items.length} 条`, { ok: true, project, items: queue.items, remaining: queue.items.length });
    return;
  }
  if (sub === 'reconcile') {
    // B-bbf6：换人/rotate 后旧队列项处置（投给新会话或 discarded + 审计）。
    const recon = reconcileDispatchQueueSessions(project, { reason: String(args.reason || 'manual'), by: String(args.by || 'pm') });
    out(args, `队列会话对齐：改投 ${recon.rebased.length} 条 ｜ 作废 ${recon.discarded.length} 条 ｜ 保留 ${recon.kept.length} 条`,
      { ok: true, project, ...recon });
    return;
  }
  if (sub === 'prune') {
    // B-20261116-104830-09117a ④：清存量口径——队列项绑的任务已 done/cancelled、或目标角色不在名册 → 作废并归档。
    // 默认 dry-run；--apply 才真删。每次写 派单队列归档.jsonl 一行 + 事件，绝不静默删。
    const prune = pruneDispatchQueue(project, {
      apply: Boolean(args.apply), reason: String(args.reason || 'queue_prune'), by: String(args.by || 'pm'),
    });
    out(args, `队列清存量：可作废 ${prune.items.length} 条 ｜ 保留 ${prune.kept.length} 条${prune.applied ? '（已作废）' : '（dry-run，未改动）'}`,
      { ok: true, project, ...prune });
    return;
  }
  if (sub !== 'pump') fail('BAD_ARGS', `未知的 queue 子命令：${sub}（用法：queue pump|status|reconcile|prune|idle-check --project P [--apply] [--now ISO] [--json]）`);
  // B-bbf6：泵之前先对齐会话（换人后旧 sessionId 会让投递永远失败 → 队列静默悬挂）。
  let recon = null;
  try { recon = reconcileDispatchQueueSessions(project, { reason: 'pump', by: 'system' }); } catch (e) { recon = { ok: false, why: String((e && e.message) || e) }; }
  const result = await pumpQueueSafe(project, 'cli');
  // B-d111：兜底补发上一条窗口内被合并的唤醒（窗口结束必发一次，不靠人再触发）。
  const flushed = await flushPendingWakes(project);
  // Owner 2026-11-14 09:15：认领后 5 分钟无状态变化 → 告警 PM（人话，含 role/taskId/claimedAt/当前状态；同任务同状态 10 分钟去重）。
  let claimStall = null;
  try { claimStall = claimStallCheck(project); } catch (e) { claimStall = { ok: false, why: String((e && e.message) || e) }; }
  // B-bbf6：队列项滞留 >5 分钟 → 向 PM 发 escalation（同项 10 分钟去重），治「队列挂着没人知道」。
  let queueStale = null;
  try { queueStale = queueStaleCheck(project); } catch (e) { queueStale = { ok: false, why: String((e && e.message) || e) }; }
  // R-b5fc F-6：壳层每 60 秒调一次 queue pump，顺带检查路由守护心跳——守护挂了也要有人发现，
  // 不能等它自己报警（它已经死了）。停滞 → PM 收 wake_failed（why=daemon_stale），10 分钟去重。
  let routeStale = null;
  try {
    const { routeStaleCheckSafe } = await import('./route-cli.mjs');
    routeStale = routeStaleCheckSafe(project);
  } catch (e) {
    routeStale = { ok: false, why: String((e && e.message) || e) };
  }
  // R-9db6：决策箱回执的防长期静默兜底（未读≥5 或最早超 2 小时 → 唤醒 PM 一次）。
  let decisionStale = null;
  try {
    const { decisionReceiptStaleCheck, markDecisionReceiptWoken } = await import('./decision-box.mjs');
    const stale = decisionReceiptStaleCheck(project);
    if (stale && stale.needWake) {
      const { wakeMailboxRecipient } = await import('./ops.mjs');
      const wake = await wakeMailboxRecipient(project, 'pm', {
        reason: `decision_receipt_${stale.reason === 'COUNT' ? 'count' : 'stale'}`,
        subject: `Owner 决策箱：${stale.unread} 条回执待读`,
        messageId: (stale.messageIds && stale.messageIds[0]) || '',
      });
      markDecisionReceiptWoken(project, { lastSeq: stale.lastSeq });
      decisionStale = { ...stale, woke: true, wake };
    } else {
      decisionStale = stale;
    }
  } catch (e) {
    decisionStale = { ok: false, why: String((e && e.message) || e) };
  }
  const flushHint = flushed.flushed || flushed.failed ? `；补发唤醒 ${flushed.flushed} 条${flushed.failed ? `（失败 ${flushed.failed} 条，留待重试）` : ''}` : '';
  const detail = result.pumped
    ? `已派 ${result.message && result.message.id} → ${result.item && result.item.to}（task ${(result.item && result.item.task) || '-'}）；剩余 ${result.remaining}`
    : `未派（${result.reason || result.code || 'EMPTY'}）；剩余 ${result.remaining ?? 0}`;
  const staleHint = queueStale && queueStale.alerted ? `；滞留告警 ${queueStale.alerted} 条（>${Math.round((queueStale.staleMs || 0) / 60000)} 分钟）` : '';
  const reconHint = recon && recon.changed ? `；会话对齐 改投 ${recon.rebased.length} / 作废 ${recon.discarded.length}` : '';
  out(args, `队列泵：${detail}${flushHint}${staleHint}${reconHint}`, {
    ok: result.ok !== false, ...result, flush: flushed, routeStale, decisionStale, claimStall, queueStale, sessionReconcile: recon,
  });
}

/**
 * 验收/终止时清未消费派单：把角色收件箱 new 里还没读的派单移到 cur（标记已消费），
 * 释放 PM 派单锁，并写 派单清理.jsonl 留痕。只动派单消息，不动回执/通知与历史正文。
 */
function clearDispatchQueue(project, { reason = '', requirementId = '' } = {}) {
  const team = loadTeam();
  const moved = [];
  for (const member of activeMembers(team)) {
    const role = member.role;
    let pending = [];
    try { pending = listInbox(role, { project }); } catch { pending = []; }
    for (const msg of pending) {
      if (String(msg.type || '').toLowerCase() !== 'dispatch') continue;
      if (requirementId && msg.task) {
        try {
          const t = loadTask(project, String(msg.task));
          if (String(t.requirementId || '') !== requirementId) continue;
        } catch { continue; }
      }
      try {
        const read = readMessage(role, msg.id);
        moved.push({ role, messageId: msg.id, task: msg.task || '', subject: (read.msg && read.msg.subject) || msg.subject });
      } catch { /* 已被消费或移动失败：跳过，不制造半条记录 */ }
    }
  }
  let lockCleared = false;
  try {
    const lock = readDispatchLock(project);
    if (lock) { fs.rmSync(dispatchLockPath(project), { force: true }); lockCleared = true; }
  } catch { /* ignore */ }
  // 队列里的未派项也一并清掉：验收/终止后不得再被 pump 唤醒。
  let queueCleared = 0;
  try {
    const queue = readDispatchQueue(project);
    if (queue.items.length) {
      queueCleared = queue.items.length;
      writeDispatchQueue(project, { items: [] });
    }
  } catch { /* ignore */ }
  if (moved.length || lockCleared || queueCleared) {
    const file = path.join(projectStatePaths(project).dir, '派单清理.jsonl');
    appendLine(file, JSON.stringify({ at: nowIso(), action: 'clear_dispatch_queue', reason, requirementId, lockCleared, queueCleared, moved }));
  }
  return { moved, lockCleared, queueCleared, count: moved.length };
}

/**
 * 提案镜像只读派生：写失败不能把 propose/review/sign/apply 的主流程带崩，
 * 团队状态仍是唯一真相；失败只记“镜像待重建”，下次任一动作再重建。
 */
function mirrorSafe(project, action = 'proposal') {
  try {
    const r = syncProposalMirror(project);
    return r || { ok: false, pending: true };
  } catch (e) {
    try {
      appendLine(path.join(projectStatePaths(project).dir, '提案镜像待重建.jsonl'),
        JSON.stringify({ at: nowIso(), action, error: e.message || String(e) }));
    } catch { /* 审计也写不了就只返回错误，不抛 */ }
    return { ok: false, pending: true, error: e.message || String(e) };
  }
}

function notify({ from, to, subject, body, project, task = '', ackRequired = false, type = 'note', sessionId = '' }) {
  const msg = sendMessage({ from, to, subject, body, project, task, ackRequired, type });
  appendEvent({
    role: from, sessionId, action: 'message', project, target: `${from}->${to}`,
    note: truncate(subject, 120), data: { messageId: msg.id, ackRequired },
  });
  return msg;
}

function safeRead(p) {
  try { return fs.readFileSync(p); } catch { return null; }
}

function isBinary(buf) {
  if (!buf) return true;
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function lineDiff(base, next) {
  const a = base.split(/\r?\n/);
  const b = next.split(/\r?\n/);
  const n = a.length;
  const m = b.length;
  if (n * m > 250000) return ['（文件较大，跳过行级 diff；请直接读暂存文件）'];
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { lines.push('  ' + a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push('- ' + a[i]); i++; }
    else { lines.push('+ ' + b[j]); j++; }
    if (lines.length > 160) { lines.push('…（截断）'); break; }
  }
  while (i < n && lines.length <= 160) lines.push('- ' + a[i++]);
  while (j < m && lines.length <= 160) lines.push('+ ' + b[j++]);
  return lines;
}

// ========== init / project ==========

export function cmdInit(args) {
  const { created, team } = initTeam();
  out(args, `团队已初始化：${PATHS.teamRoot}\n新建 ${created.length} 个文件；成员 ${activeRoles(team).join(', ')}；阶段 ${team.phase}`, { ok: true, created, team });
}

function registeredProject(name) {
  return listProjects().find((p) => p.name === name) || null;
}

// --team-mode full|fast：命令行显式传入才算；非法值直接拒绝，不静默落到 full。
function modeFromArgs(args) {
  const raw = args['team-mode'];
  if (raw === undefined) return '';
  if (raw === true) fail('BAD_TEAM_MODE', '--team-mode 需要 full 或 fast');
  const mode = String(raw).trim().toLowerCase();
  if (!isTeamMode(mode)) fail('BAD_TEAM_MODE', `--team-mode 只能是 ${TEAM_MODES.join(' / ')}：${raw}`, { allowed: TEAM_MODES });
  return mode;
}

/**
 * 模式切换只改「项目状态配置 + workspace.json + 结构要求」，不删除已有角色目录、不动会话。
 * - 项目.json 是真相：写 teamMode + roleIds；
 * - workspace.json 是镜像：同步 teamMode + roleIds + roles；
 * - 老项目缺字段时按当前生效模式回填，不把已有 fast 项目误判成 full。
 */
function applyProjectMode(project, mode) {
  return persistProjectTeamMode(project, mode, { syncWorkspace: true });
}

// 建项目/补项目共用：先写模式配置，再落脚手架，最后重建索引，返回可复核的 created/missing。
function scaffoldProject(project, { desc = '', entry = '', by = 'owner', teamMode = '' } = {}) {
  const requested = teamMode ? normalizeTeamMode(teamMode) : projectTeamMode(project);
  const modeSync = applyProjectMode(project, requested);
  const mode = modeSync.teamMode;
  const structure = ensureProjectStructure({
    name: project.name,
    root: project.path,
    desc: desc || project.desc || '',
    overwrite: false,
    teamMode: mode,
  });
  const index = generateIndex(project, { by, sessionId: 'project-scaffold', silent: true });
  return { structure, index, teamMode: mode, modeSync };
}

export function cmdProject(args) {
  const sub = args._[1] || 'list';
  if (sub === 'add' || sub === 'create' || sub === 'ensure') {
    const rawName = String(args.name || (sub === 'ensure' ? loadTeam().activeProject || '' : '')).trim();
    if (!rawName) fail('BAD_NAME', `project ${sub} 需要 --name`);
    let createdBy = args.by || 'owner';
    if (args.boot) {
      const b = bootFor(args, `project ${sub}`);
      if (b.role !== 'pm') fail('NOT_PM', `只有 PM 能 project ${sub}`);
      createdBy = b.role;
    } else if (createdBy !== 'owner') {
      fail('BOOT_REQUIRED', `非 owner 执行 project ${sub} 必须带 --boot`);
    }
    const name = safeName(rawName);
    const teamMode = modeFromArgs(args);
    // 登记文件存在但解析失败时不能当“未登记”重建：那会用默认 full 覆盖已有 fast 真相。
    const stateConfig = projectStatePaths(name).config;
    if (exists(stateConfig) && !registeredProject(name)) {
      fail('BAD_PROJECT_CONFIG', `项目登记文件存在但读不出来：${stateConfig}；先修复或备份，不能按未登记项目重建（否则会把已有 fast 误判成 full）`, { project: name, config: stateConfig });
    }

    if (sub === 'ensure') {
      let project = registeredProject(name);
      if (!project) {
        const dir = args.dir ? path.resolve(String(args.dir)) : path.join(PATHS.projects, name);
        if (!exists(dir)) fail('NO_PROJECT', `项目不存在：${name}；先 project add --name "${name}"`, { project: name, dir });
        project = addProject({ name, dir, desc: args.desc || '', createdBy, entry: args.entry || '', teamMode: teamMode || 'full' }).project;
      } else if (args.dir && path.resolve(String(args.dir)) !== path.resolve(project.path)) {
        fail('PROJECT_PATH_MISMATCH', `项目 ${name} 登记目录 ${project.path} ≠ --dir ${args.dir}`, { project, dir: args.dir });
      }
      const { structure, index, teamMode: mode, modeSync } = scaffoldProject(project, { desc: args.desc, entry: args.entry, by: createdBy, teamMode });
      appendEvent({
        role: createdBy, sessionId: sessionOf(args), action: 'project_ensure', project: name, target: project.path,
        note: `mode=${mode} roleIds=${modeSync.roleIds.join(',')} created=${structure.created.length} missing=${structure.missing.length} workspace=${modeSync.workspace ? (modeSync.workspace.changed ? 'synced' : 'same') : 'off'}`,
        data: { created: structure.created, missing: structure.missing, teamMode: mode, roleIds: modeSync.roleIds, modeBefore: modeSync.before, modeChanged: modeSync.changed, workspace: modeSync.workspace },
      });
      const modeLine = `模式：${TEAM_MODE_LABELS[mode]}｜项目.json teamMode=${mode} roleIds=${modeSync.roleIds.join(',')}｜workspace.json ${modeSync.workspace && modeSync.workspace.changed ? '已同步' : '已一致'}｜不删旧目录/旧会话`;
      const human = structure.ok
        ? `项目结构已补齐：${project.name}（${mode === 'fast' ? '快速四角色' : '完整六角色'}）\n目录：${project.path}\n新建 ${structure.created.length} 项；保留 ${structure.kept.length} 项\n${modeLine}\n索引：${project.index}（${index.files} 个文件）`
        : `项目结构仍不完整：${project.name}（${mode}）\n缺失：${structure.missing.join('、')}\n${modeLine}`;
      out(args, human, { ok: structure.ok, project, structure, index, teamMode: mode, roleIds: modeSync.roleIds, modeSync });
      return;
    }

    // add / create：已登记的项目不重复登记、不覆盖，只补结构；目录不同则明确拒绝。
    const existing = registeredProject(name);
    if (existing) {
      if (args.dir && path.resolve(String(args.dir)) !== path.resolve(existing.path)) {
        fail('PROJECT_EXISTS', `项目已登记且目录不同：${name} → ${existing.path}；要补结构请用 project ensure`, { project: existing });
      }
      const project = loadProject(name);
      const { structure, index, teamMode: mode, modeSync } = scaffoldProject(project, { desc: args.desc, entry: args.entry, by: createdBy, teamMode });
      appendEvent({
        role: createdBy, sessionId: sessionOf(args), action: 'project_scaffold', project: name, target: project.path,
        note: `已有项目补结构 mode=${mode} roleIds=${modeSync.roleIds.join(',')} created=${structure.created.length} missing=${structure.missing.length}`,
        data: { created: structure.created, missing: structure.missing, teamMode: mode, roleIds: modeSync.roleIds, modeBefore: modeSync.before, modeChanged: modeSync.changed, workspace: modeSync.workspace },
      });
      const modeLine = `模式：${TEAM_MODE_LABELS[mode]}｜项目.json teamMode=${mode} roleIds=${modeSync.roleIds.join(',')}｜workspace.json ${modeSync.workspace && modeSync.workspace.changed ? '已同步' : '已一致'}｜不删旧目录/旧会话`;
      const human = structure.ok
        ? `项目已存在，结构已补齐：${project.name}（${mode === 'fast' ? '快速四角色' : '完整六角色'}）\n目录：${project.path}\n新建 ${structure.created.length} 项\n${modeLine}\n索引：${project.index}（${index.files} 个文件）`
        : `项目已存在，但结构仍不完整：${project.name}（${mode}）\n缺失：${structure.missing.join('、')}\n${modeLine}`;
      out(args, human, { ok: structure.ok, existed: true, project, structure, index, teamMode: mode, roleIds: modeSync.roleIds, modeSync });
      return;
    }

    const { project } = addProject({ name, desc: args.desc || '', dir: args.dir || '', createdBy, entry: args.entry || '', teamMode: teamMode || 'full' });
    const { structure, index, teamMode: mode, modeSync } = scaffoldProject(project, { desc: args.desc, entry: args.entry, by: createdBy, teamMode });
    if (!structure.ok) {
      fail('PROJECT_STRUCTURE_INCOMPLETE', `项目已登记但结构不完整：缺少 ${structure.missing.join('、')}`, { project, structure });
    }
    out(args, `项目已建：${project.name}（${mode === 'fast' ? '快速四角色：PM/需求分析师/程序员A/测试人员' : '完整六角色'}）\n目录：${project.path}\n${mode === 'fast' ? '四角色' : '六角色'}目录 + 角色卡 + 文件索引 + 产出/ + 项目信息/铁律/索引/README + 需求池 + _tmp 已就绪（新建 ${structure.created.length} 项）\n模式：项目.json teamMode=${mode} roleIds=${modeSync.roleIds.join(',')}｜workspace.json 已同步\n索引：${project.index}（${index.files} 个文件）`, {
      ok: true, created: true, project, structure, index, teamMode: mode, roleIds: modeSync.roleIds, modeSync,
    });
    return;
  }
  if (sub === 'list') {
    const projects = listProjects();
    const team = loadTeam();
    const rows = projects.map((p) => {
      const mode = projectTeamMode(p);
      const roleIds = projectRoleIds(p);
      const s = structureReport(p.path, { teamMode: mode });
      return {
        name: p.name, active: p.name === team.activeProject ? '*' : '', mode,
        roleIds, roles: roleIds.join(','),
        desc: p.desc, path: p.path,
        structure: s.ok ? 'OK' : `缺 ${s.missing.length}`,
      };
    });
    out(args, `项目（active=${team.activeProject || '无'}）\n` + table(rows, [
      { key: 'name', label: '项目' }, { key: 'active', label: '' }, { key: 'mode', label: '模式' }, { key: 'roles', label: '角色' }, { key: 'structure', label: '结构' }, { key: 'desc', label: '说明' }, { key: 'path', label: '目录' },
    ]), { ok: true, projects, active: team.activeProject, structures: rows.map((r) => ({ name: r.name, teamMode: r.mode, roleIds: r.roleIds, structure: r.structure })) });
    return;
  }
  if (sub === 'use') {
    const b = bootFor(args, 'project use');
    if (b.role !== 'pm') fail('NOT_PM', '只有 PM 能切换当前项目');
    if (!args.name) fail('BAD_NAME', '需要 --name');
    const project = setActiveProject(args.name);
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'project_use', project: project.name, target: project.name, note: '切换当前项目' });
    out(args, `当前项目：${project.name}`, { ok: true, project });
    return;
  }
  if (sub === 'show') {
    const project = loadProject(args.name || loadTeam().activeProject);
    const teamMode = projectTeamMode(project);
    const roleIds = projectRoleIds(project);
    const structure = structureReport(project.path, { teamMode });
    const modeState = projectModeState(project);
    out(args, JSON.stringify({ project, teamMode, roleIds, structure, modeState }, null, 2), { ok: true, project, teamMode, roleIds, structure, modeState });
    return;
  }
  fail('BAD_SUBCOMMAND', `未知 project 子命令：${sub}`);
}

// ========== boot ==========

// B-20261116-134316-c31c：把一次 CLI boot 的阅读证据写进 工作流.json 的 state.boots[role]。
// 字段与壳层 bootRole 同形：{complete, round, at, rulesHash, docs:{key:{hash,exists,rel}}, requirementsHash, source}。
// 只改 boots 一项，其余字段原样写回（tmp+rename 由 core.writeJson 保证原子）。
// B-20261116-135220-5887：读当前轮次（工作流.json → round），boot 记录要带上，回退分支才能判「换轮没重 boot」。
function readWorkflowRound(projectName) {
  try {
    const state = readJson(path.join(projectStatePaths(projectName).dir, '工作流.json'), {}) || {};
    const round = Number(state.round || 1);
    return Number.isFinite(round) && round > 0 ? round : 1;
  } catch {
    return 1;
  }
}

function writeWorkflowBootState(projectName, roleId, records, meta) {
  const file = path.join(projectStatePaths(projectName).dir, '工作流.json');
  const state = readJson(file, {}) || {};
  const next = state && typeof state === 'object' ? state : {};
  next.boots = next.boots && typeof next.boots === 'object' ? next.boots : {};
  const docsMap = {};
  for (const r of records) docsMap[r.key] = { hash: r.hash || '', exists: Boolean(r.exists), rel: r.rel || '' };
  next.boots[roleId] = {
    role: roleId,
    project: projectName,
    at: meta.at,
    round: Number(next.round || 1),
    complete: meta.complete === true,
    docs: docsMap,
    rulesHash: String(meta.rulesHash || ''),
    requirementsHash: String(meta.requirementsHash || ''),
    requirementsContentHash: String(meta.requirementsContentHash || ''),
    source: 'team.mjs boot',
  };
  writeJson(file, next);
  return { ok: true, file, docs: Object.keys(docsMap).length, complete: next.boots[roleId].complete };
}

export async function cmdBoot(args) {
  const team = loadTeam();
  const role = String(args.role || '');
  if (!role) fail('BAD_ROLE', '需要 --role');
  const member = memberOrFail(team, role);
  const projectName = String(args.project || team.activeProject || '');
  if (!projectName) fail('NO_PROJECT', '没有当前项目；先 project add / project use');
  const project = loadProject(projectName);
  const docs = readDocSet(role, project);
  const teamMode = docs.teamMode || projectTeamMode(project);
  const sessionId = sessionOf(args);
  const token = createBootToken({ role, project: projectName, sessionId, docs });
  addReadReceipt({ role, sessionId, kind: 'index', project: projectName, proposalId: '', proposalHash: '', baseHash: docs.hashes.projectIndex });
  const records = docs.docs.map((d) => ({
    key: d.key, label: d.label, rel: d.rel, path: d.path, required: d.required, core: d.core,
    exists: d.exists, size: d.size, hash: d.hash, updatedAt: d.updatedAt, excerpt: d.excerpt,
  }));
  const taskDocs = Array.isArray(docs.taskDocs) ? docs.taskDocs : [];
  const bootRead = {
    role,
    project: projectName,
    teamMode,
    at: nowIso(),
    complete: records.every((d) => d.exists || !d.required),
    order: records.map((d) => `${d.label}(${d.rel || d.path})`),
    docs: records,
    core: records.filter((d) => d.core).map((d) => ({ rel: d.rel || d.path, exists: d.exists, hash: d.hash })),
    unread: records.filter((d) => !d.exists).map((d) => d.rel || d.label),
    requirements: docs.requirements.list,
    requirementsHash: docs.requirements.hash,
    requirementsContentHash: (docs.requirements && (docs.requirements.contentHash || docs.requirements.hash)) || '',
    taskDocs,
    peers: docs.peers,
    missing: records.filter((d) => !d.exists && d.required).map((d) => d.label),
    receipt: { file: PATHS.reads, kind: 'boot' },
  };
  // read 证据落盘：谁读了哪些文件、需求版本是什么，事后能复核（不是只有口头“读过了”）。
  addReadReceipt({
    role, sessionId, kind: 'boot', project: projectName, proposalId: '', proposalHash: '',
    baseHash: docs.rulesHash,
    docs: docs.readOrder,
    // B-20261116-134316-c31c：逐文档哈希也留一份，壳层验收门在 state.boots 缺失时可回退比对（AC2）
    docHashes: Object.fromEntries(records.map((d) => [d.key, { hash: d.hash || '', exists: Boolean(d.exists), rel: d.rel || '' }])),
    // B-20261116-135220-5887：回退路径必须能判轮次与完整度，不能靠壳层假定。
    round: Number(readWorkflowRound(projectName) || 1),
    completed: bootRead.complete === true,
    teamsmithBoot: true,
    requirementsHash: docs.requirements.hash,
    requirements: docs.requirements.count,
    taskDocs: taskDocs.map((d) => d.rel),
    peers: docs.peers.map((p) => p.rel),
  });
  // B-20261116-134316-c31c：CLI boot 必须同步写 工作流.json 的 state.boots——
  // 壳层验收门（src/team-tools.js requireWorkflowBoot）只读 state.boots，而 team.mjs boot 以前只写 阅读.jsonl，
  // 导致 CLI boot 的角色在验收时被永久判「boot 后必读文件已变化」（owner 被卡住）。
  let workflowBootSync = null;
  try {
    workflowBootSync = writeWorkflowBootState(projectName, role, records, {
      at: bootRead.at,
      complete: bootRead.complete,
      rulesHash: docs.rulesHash,
      requirementsHash: bootRead.requirementsHash,
      requirementsContentHash: (docs.requirements && (docs.requirements.contentHash || docs.requirements.hash)) || '',
    });
  } catch (error) {
    workflowBootSync = { ok: false, why: String((error && error.message) || error) };
  }

  // B-405f ③：角色 boot 即消费 rotate 留下的待启动项（闭环：谁被拉起，谁自己销账）。
  let bootQueue = null;
  try { bootQueue = consumeBootQueue(projectName, role, sessionId); } catch (e) { bootQueue = { consumed: 0, why: String((e && e.message) || e) }; }
  const unread = listInbox(role, { project: projectName });
  const tasks = listTasks(projectName).filter((t) => t.status !== 'done' && (!t.owner || t.owner === role));
  const proposals = listProposals(projectName).filter((p) => ['proposed', 'reviewing', 'signing'].includes(p.status) && p.author !== role);
  const locks = listLocks().filter((l) => !l.stale);
  const grants = activeGrants(role, projectName);
  appendEvent({
    role, sessionId, action: 'boot', project: projectName, target: role,
    note: `rules=${shortHash(docs.rulesHash)} index=${shortHash(docs.hashes.projectIndex)} req=${docs.requirements.count} unread=${unread.length}`,
    data: {
      rulesHash: docs.rulesHash, docHashes: docs.hashes, token: token.token, unread: unread.length,
      // B-5989 AC2：自动 boot 的触发归因也写进 boot 事件（由 auto-boot 通过环境变量传入）。
      ...(String(process.env.TEAM_AUTO_BOOT || '') === '1'
        ? { autoBoot: true, autoBootTrigger: String(process.env.TEAM_AUTO_BOOT_TRIGGER || 'stale') }
        : {}),
      read: {
        docs: docs.readOrder, peers: docs.peers.map((p) => p.rel),
        requirements: docs.requirements.count, requirementsHash: docs.requirements.hash,
      },
    },
  });
  const lines = [];
  // R-51de F-5①：boot 简报顶部红条（LESSONS_UNREAD 红条）；只提示、不阻断 boot（AC4④）
  let bootLessonGate = null;
  try { bootLessonGate = lessonGateFor({ project: projectName, role }); } catch { bootLessonGate = null; }
  if (bootLessonGate && !bootLessonGate.ok) {
    lines.push(`⚠️ ${bootLessonGate.code}：经验教训登记册（${bootLessonGate.currentSha12 || '?'}）尚未读过${bootLessonGate.staleSha12 ? `（上次 ${bootLessonGate.staleSha12}）` : ''}；先跑 team.mjs lessons read（不阻断 boot）`);
  }
  const bootTtlMinutes = Number(team.config.bootTtlMinutes || DEFAULT_BOOT_TTL_MINUTES);
  const coreDocs = records.filter((d) => d.core);
  const coreRead = coreDocs.filter((d) => d.exists);
  const coreMissing = coreDocs.filter((d) => !d.exists);
  const optionalDocs = records.filter((d) => !d.core && d.key !== 'handover');
  const optionalRead = optionalDocs.filter((d) => d.exists);
  const optionalMissing = optionalDocs.filter((d) => !d.exists);
  lines.push(`=== 启动简报 · ${ROLE_NAMES[role] || role} · ${projectName} ===`);
  // B-defb（Owner 2026-11-16 06:19）：令牌实际不会过期（store.mjs requireBoot 已取消 BOOT_EXPIRED，
  // expiresAt 只作审计/展示）。旧文案写「480 分钟 = 8 小时」会让 Owner 与 PM 误以为要重 boot——改成不限时。
  lines.push(`令牌: ${token.token}（**不限时**，expiresAt 仅审计展示、不作拒绝依据；当前所有写操作都要带 --boot）｜ 哈希 rules ${shortHash(docs.rulesHash)} / index ${shortHash(docs.hashes.projectIndex)}`);
  lines.push(`身份: ${member.name}（${role}）｜ 会话: ${sessionId}`);
  lines.push(`团队模式: ${TEAM_MODE_LABELS[teamMode]}（${teamModeDescription(teamMode)}）｜ 角色集: ${rolesForMode(teamMode).join(' / ')}`);
  lines.push(teamMode === 'fast'
    ? '快速模式: 需求评审=需求分析师 ｜ 技术评审记录=程序员A ｜ 投票=vote start/cast/status'
    : '完整模式: 需求评审=产品设计师 ｜ 技术评审记录=产品/程序员A ｜ 投票=vote start/cast/status');
  lines.push(`阶段: ${team.phase} ｜ 活跃成员: ${activeRoles(team).filter((r) => rolesForMode(teamMode).includes(r)).join(', ')} ｜ 当前锁: ${locks.length ? locks.map((l) => l.key + '@' + l.role).slice(0, 6).join(', ') : '无'}`);
  lines.push(`纪律: 中文思考、中文回复、中文写文档 ｜ 每轮先读《团队宪法》（唯一最高优先级；项目铁律按需避坑） ｜ 消息≤${team.config.messageMaxChars}字 ｜ 回执≤${team.config.ackNoteMaxChars}字 ｜ 先读索引再找文件`);
  lines.push('派单闭环: ack=已回执（收到/认领）≠ 已完成；执行正文任务 → 产出写本角色目录（开发代码写 site/**）→ 完成回执 + task done --evidence');
  lines.push(`结构化输出: ${OUTPUT_DISCIPLINE}`);
  const outSpec = OUTPUT_DOCS[role];
  lines.push(outSpec
    ? `输出模板: 团队\\工具\\模板\\角色产出\\${outSpec.file} → ${outSpec.dir}/产出/（vN 递增，不覆盖旧版；超限即停）`
    : '输出模板: 本角色无 01~04 结构化模板（回执/日志仍按一句话格式）');
  lines.push(`网关提取: team.mjs brief --role ${role} --project "${projectName}" --section <区块> ｜ 他人读你产出只提取区块，不读全文`);
  // 必读分层：核心 4 份 → 按需文档 → 任务相关；已读/未读都列，核心 4 份永远排在最前、不被截断。
  lines.push(`必读-核心已读 ${coreRead.length}/${coreDocs.length}: ${coreRead.map((d) => d.rel || d.path).join(' ')}`);
  if (coreMissing.length) lines.push(`必读-核心未读（缺文件，先 project ensure）: ${coreMissing.map((d) => d.rel || d.label).join(' ')}`);
  // R-5b14 F-2/F-3：交接文档发现行，位置固定在「必读-按需已读」之前。
  // 有 交接-最新.md → 提示先读；只有历史命名（交接-/接任-/开工交接-/换人交接-）→ 中性提示并给最新一份；
  // 都没有 → 不出任何行（AC3）。handover 本身不列进按需已读/未读两行（同上）。
  try {
    const handoverHint = handoverBriefLine({ projectRoot: project.path, roleDirName: ROLE_DIRS[role] || '' });
    if (handoverHint && handoverHint.line) lines.push(handoverHint.line);
  } catch (e) {
    // 只读发现失败不阻断 boot（边界「异常」行）
    console.warn('[handover] brief line failed:', String((e && e.message) || e));
  }
  lines.push(`必读-按需已读: ${optionalRead.length ? optionalRead.map((d) => d.rel || d.path).join(' ') : '（无）'}`);
  if (optionalMissing.length) lines.push(`必读-未读: ${optionalMissing.map((d) => d.rel || d.label).join(' ')}`);
  // T-20261117-184114-4358（R-bcae）：基础流程 skill 索引——已读/未建都明示，不静默；新 PM 额外提示不可更改。
  try {
    const allDocs = Array.isArray(docs.docs) ? docs.docs : [];
    const skillDoc = allDocs.find((d) => String(d.key || '') === 'skillIndex') || null;
    const skillExists = Boolean(skillDoc && skillDoc.exists !== false && skillDoc.hash);
    if (skillExists) {
      lines.push(`skill: 索引已读 团队/skill/基础流程/00-索引.md（按需读本人 ${role}.md；基础流程为 Owner 批准版本，manifest: skill-manifest.json）`);
    } else {
      lines.push(`skill: 未建 skill（创建路径 团队/skill/基础流程/00-索引.md + 本人 ${role}.md；模板格式见需求 R-bcae）`);
    }
    if (role === 'pm' && skillExists) lines.push('skill 提示: 基础流程 skill 为 Owner 批准版本，不可更改（改版须 Owner 批准 + manifest 归档）。');
  } catch { /* skill 提示失败不阻断 boot */ }
  if (taskDocs.length) {
    lines.push(`必读-任务相关（${taskDocs.length}）: ${taskDocs.map((d) => d.rel).join(' ')}`);
  } else {
    lines.push('必读-任务相关: （无未完成任务；收到派单后按派单里的「当前必读」补读）');
  }
  // R-f9b1 F-7⑧：本角色当前任务所涉需求的增补卷（缺失也写一行；不进必读计数、不阻塞 boot）。
  for (const line of supplementBriefLines(project, tasks)) lines.push(line);
  // T-20261117-184114-4358（R-bcae）第二步：30 分钟 skill 评估提示（同窗口只一次；可 skip 但必须写 reason）。
  try {
    const skillPrompt = skillPromptLineFor(projectName, role);
    if (skillPrompt) lines.push(skillPrompt);
  } catch (e) { console.warn('[skill] prompt line failed:', String((e && e.message) || e)); }
  lines.push(`read 回执: ${PATHS.reads}（kind=boot；需求/任务文档哈希随令牌落盘，评审与派单前复核）`);
  if (bootQueue && bootQueue.consumed) {
    lines.push(`待启动队列: 已消费 ${bootQueue.consumed} 条（${bootQueue.items.map((it) => it.id).join('、')}；轮换后自动拉起）`);
  }
  const reqIds = docs.requirements.list.map((r) => r.id);
  lines.push(`需求池: ${docs.requirements.count} 份${reqIds.length ? '（' + reqIds.slice(0, 6).join('、') + '）' : '（暂无 R-*.md）'} ｜ 他人文档索引: ${docs.peers.length} 份`);
  lines.push(`未读消息: ${unread.length}`);
  for (const m of unread.slice(0, 3)) lines.push(`  [${m.id}] ${m.from}${m.ackRequired ? ' (要回执)' : ''}: ${m.subject}`);
  lines.push(`待办任务: ${tasks.length} ｜ 待处理提案: ${proposals.length}`);
  for (const t of tasks.slice(0, 3)) lines.push(`  [${t.id}] ${t.priority} ${t.status} ${t.owner || '-'} ${t.title}`);
  for (const p of proposals.slice(0, 3)) lines.push(`  [${p.id}] ${p.risk} ${p.status} by ${p.author}: ${p.title}`);
  lines.push(`授权: ${grants.length ? grants.map((g) => `${g.actions.join('/')}@${g.project}:${g.scope.join(',')}`).join(' ｜ ') : '（无，需 PM grant）'}`);
  // 可选插件降级标记：缺插件只标 off，不阻断核心流程（AC21.2/21.3）。
  try {
    const marks = optionalPluginMarks();
    lines.push(`可选插件: ${marks.marks}（非核心，缺了不阻断；详见 docs/可选插件.md）`);
    // R-8b9d：记忆插件 off/error 时把降级口径说清楚，避免角色以为 P0 记忆门还会硬卡或已静默放水。
    if (marks.summary && marks.summary.memory !== 'on') {
      lines.push(`记忆降级: memory:${marks.summary.memory} —— P0 记忆门降级为 MEMORY_SKIPPED（不阻断完成）；启用 dsh-memory-evolve 后恢复强校验（安装见 docs/可选插件.md）`);
    }
  } catch { /* 探测失败不加行，不影响简报 */ }
  lines.push('下一步: 先读 inbox/待审提案；收到派单先 ack，再执行正文任务，产出落盘，完成后发完成回执并 task done；文件变更按现行流程直接提交（提案五步已随宪法修订废止，见宪法第 2 条）。');
  // B-20261113-005705-a577：boot 也触发一次兜底泵——全队空闲时队列不会因为“没有 task done”而永远不派。
  const bootPump = await pumpQueueSafe(projectName, 'boot');
  if (bootPump && bootPump.pumped) {
    lines.push(`队列自动续跑: 已派 ${bootPump.message && bootPump.message.id} → ${bootPump.item && bootPump.item.to}（task ${(bootPump.item && bootPump.item.task) || '-'}）`);
  } else if (bootPump && bootPump.ok === false) {
    lines.push(`队列泵失败: ${String(bootPump.why || bootPump.code || 'QUEUE_PUMP_FAILED').slice(0, 120)}（队列项已保留，下次再试）`);
  }
  const maxBrief = Number(team.config.bootBriefMaxChars || 2000);
  let briefing = lines.join('\n');
  if (briefing.length > maxBrief) {
    // 核心 4 份清单排在最前面，从尾部截断不会丢核心清单。
    briefing = briefing.slice(0, maxBrief - 22) + '\n…（简报超限截断）';
  }
  // 接任包：只有“当前会话正是最近一次轮换进来的新会话”才附加，避免每轮都贴。
  let handover = null;
  try { handover = handoverForBoot(projectName, role, sessionId); } catch { handover = null; }
  // B-3f02（设计口径 v1）：新 PM 激活即注入首条启动包（六项，≤2000 字，超限截断）。
  let startupPackage = null;
  if (String(role) === 'pm' && handover) {
    try {
      const mustRead = (String(handover.text || '').match(/【必读】([^\n]*)/) || [])[1] || '';
      const unreadList = (Array.isArray(unread) ? unread : (unread && Array.isArray(unread.items) ? unread.items : []))
        .slice(0, 3).map((m) => `${m.id} ${String(m.subject || '').slice(0, 24)}`).join('；') || '无';
      const unfinished = (Array.isArray(tasks) ? tasks : []).length;
      const redFlags = (() => { try { return validateHandover(handover.text).redFlags || []; } catch { return []; } })();
      const parts = [
        '=== 项目经理 启动包（自动注入） ===',
        `【1 你是谁】项目经理 ｜ 项目 ${projectName} ｜ 会话 ${sessionId || '(未绑定)'}`,
        `【2 上一任交接包】${String(handover.text || '').replace(/\n/g, ' ⏎ ')}`,
        ...(redFlags.length ? [`【2 标红】${redFlags.join('；')}`] : []),
        `【3 当前局面】阶段 ${currentStatus || 'unknown'} ｜ 未闭环任务 ${unfinished} 条 ｜ 未读 ${Array.isArray(unread) ? unread.length : '—'} 条`,
        `【4 未读邮件摘要】${unreadList}`,
        `【5 必读文档】${mustRead || '项目铁律/项目信息/项目索引/角色卡/文件索引'}`,
        `【6 第一件事】先 boot（node 团队\\工具\\team.mjs boot --role pm --project ${projectName}）再读完交接包，别立刻派单。`,
      ];
      let text = parts.join('\n');
      if (text.length > 2000) text = text.slice(0, 1980) + '\n…（启动包超 2000 字已截断）';
      startupPackage = text;
    } catch { startupPackage = null; }
  }
  if (args.json) jsonOut({
    ok: true, token: token.token, role, project: projectName, teamMode, sessionId, rulesHash: docs.rulesHash,
    bootTtlMinutes,
    docHashes: docs.hashes, read: bootRead, briefing, unread, tasks, proposals, grants,
    dispatchQueue: bootPump,
    bootQueue,
    handover: handover ? handover.text : null, handoverMeta: handover, startupPackage,
  });
  else textOut(startupPackage ? `${startupPackage}\n\n${briefing}` : (handover ? `${briefing}\n\n${handover.text}` : briefing));
}

// ========== 消息 ==========

function dispatchLockPath(project) {
  return path.join(projectStatePaths(project).dir, '派单锁.json');
}
// B-20261113-043841-384e：派单锁 TTL——10 分钟无人回执自动释放，避免一条未回执锁死全队。
const DISPATCH_LOCK_TTL_MS = 10 * 60 * 1000;
function readDispatchLock(project) {
  try { return readJson(dispatchLockPath(project)); } catch { return null; }
}
function writeDispatchLock(project, msg, extra = {}) {
  writeJson(dispatchLockPath(project), {
    messageId: msg.id, to: msg.to, task: msg.task || '', subject: msg.subject, ts: msg.ts,
    expiresAt: new Date(Date.now() + DISPATCH_LOCK_TTL_MS).toISOString(),
    targetSessionId: String(extra.targetSessionId || ''),
  });
}
function clearDispatchLock(project, messageId) {
  const p = dispatchLockPath(project);
  try {
    const lock = readJson(p);
    if (lock && lock.messageId === messageId) fs.rmSync(p, { force: true });
  } catch { /* ignore */ }
}
/** 锁过期即释放并记事件（send / pump 入口都会先跑一次）。返回被释放的锁或 null。 */
function releaseExpiredDispatchLock(project, { source = '' } = {}) {
  const lock = readDispatchLock(project);
  if (!lock || !lock.messageId) return null;
  const expiresAt = Date.parse(String(lock.expiresAt || ''));
  const base = Number.isFinite(expiresAt) ? expiresAt : Date.parse(String(lock.ts || '')) + DISPATCH_LOCK_TTL_MS;
  if (!Number.isFinite(base) || Date.now() < base) return null;
  try { fs.rmSync(dispatchLockPath(project), { force: true }); } catch { /* ignore */ }
  appendEvent({ role: 'system', action: 'dispatch_lock_expired', project, target: lock.messageId, note: `to=${lock.to} task=${lock.task || ''} source=${source}` });
  return lock;
}
/** 任务完成时释放与该任务绑定的派单锁（不传 taskId 时释放任意锁）；记事件。 */
function releaseDispatchLockForTask(project, taskId, { source = '' } = {}) {
  const lock = readDispatchLock(project);
  if (!lock || !lock.messageId) return null;
  if (taskId && String(lock.task || '') !== String(taskId)) return null;
  try { fs.rmSync(dispatchLockPath(project), { force: true }); } catch { /* ignore */ }
  appendEvent({ role: 'system', action: 'dispatch_lock_released', project, target: lock.messageId, note: `task=${taskId} source=${source}` });
  // B-bbf6 ①：锁一释放就补泵一次——不依赖壳层 60 秒定时器是否在跑，保证队列项 60 秒内被投递。
  try { Promise.resolve().then(() => pumpQueueSafe(project, 'lock_released')).catch(() => {}); } catch { /* 泵失败不影响释放 */ }
  return lock;
}

// B-405f ②：pending 锁 + 目标会话活性——5 分钟后目标会话仍不存在/0 使用，自动释放并记事件。
// 背景：rotate 换进来的新会话 usage=0、从未 boot；派给它的单被记 pending，10 分钟 TTL 内全队派单通道被锁死。
const DISPATCH_LOCK_INACTIVE_MS = 5 * 60 * 1000;
async function releaseInactiveDispatchLock(project, { source = '' } = {}) {
  const lock = readDispatchLock(project);
  if (!lock || !lock.messageId) return null;
  const ts = Date.parse(String(lock.ts || ''));
  if (!Number.isFinite(ts)) return null;
  const ageMs = Date.now() - ts;
  if (ageMs < DISPATCH_LOCK_INACTIVE_MS) return null;
  let probe = null;
  try { probe = await probeRoleSession(project, String(lock.to || '')); } catch (e) { probe = { state: 'unknown', why: String((e && e.message) || e) }; }
  if (!probe || !['missing', 'cold', 'no_session'].includes(probe.state)) return null;
  try { fs.rmSync(dispatchLockPath(project), { force: true }); } catch { /* ignore */ }
  appendEvent({
    role: 'system', action: 'dispatch_lock_expired', project, target: lock.messageId,
    note: `reason=target_inactive state=${probe.state} age=${Math.round(ageMs / 1000)}s to=${lock.to} task=${lock.task || ''} source=${source}`,
  });
  return { ...lock, released: true, reason: 'target_inactive', probe };
}

/**
 * B-405f ①：派单前探活。冷会话（存在但 0 使用）/DSH 列表里没有 → 先发启动提示拉起，再派；
 * 拉不起来就明确报错（此时还没写消息、没写锁，零副作用）。DSH 不可达（unknown）不拦，留痕继续。
 */
async function ensureDispatchTargetAlive(project, to, taskRow = null) {
  let probe = null;
  try { probe = await probeRoleSession(project, to); } catch (e) { probe = { role: to, state: 'unknown', why: String((e && e.message) || e) }; }
  if (!probe || probe.state === 'active' || probe.state === 'unknown' || probe.state === 'no_session') {
    // no_session：角色还没配会话（早期项目/沙盘），交给唤醒失败路径明确报错并释放锁，不在派单前硬拦。
    return { probe, warmup: null };
  }
  const warmup = await nudgeRoleBoot({
    projectName: project, role: to, sessionId: probe.sessionId, reason: `dispatch_precheck:${probe.state}`,
  });
  if (!warmup || warmup.ok !== true) {
    // 拉起失败不硬拦：后面的唤醒失败路径会释放派单锁并把原因带回 PM（失败回执明确、不占锁）。
    // 这样 mock/离线环境（会话列表与会话 id 不同源）不会把正常派单挡死。
    appendEvent({
      role: 'system', action: 'dispatch_target_warmup_failed', project, target: probe.sessionId,
      note: `to=${to} state=${probe.state} why=${(warmup && (warmup.why || warmup.code)) || '未知'}`,
    });
    return { probe, warmup: warmup || null, failed: true };
  }
  appendEvent({
    role: 'system', action: 'dispatch_target_warmup', project, target: probe.sessionId,
    note: `to=${to} state=${probe.state} ok=1 skipped=${warmup.skipped || ''}`,
  });
  return { probe, warmup, task: taskRow ? taskRow.id : '' };
}

function latestOutputFile(dir, pattern) {
  try {
    const rows = fs.readdirSync(dir, { withFileTypes: true })
      .filter((ent) => ent.isFile() && pattern.test(ent.name))
      .map((ent) => {
        const full = path.join(dir, ent.name);
        return { name: ent.name, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return rows.length ? rows[0].name : '';
  } catch {
    return '';
  }
}

/** 程序指定的本轮必读：需求正文 + 上游角色最近产出；找不到就不写，不补造。 */
function readingListFor(projectPath, role, task) {
  const out = [];
  const reqDir = path.join(projectPath, '需求');
  let reqFile = '';
  if (task && task.requirementId) {
    const id = String(task.requirementId);
    try {
      reqFile = fs.readdirSync(reqDir)
        .filter((name) => /^R-.*\.md$/i.test(name))
        .find((name) => name.toLowerCase().startsWith(id.toLowerCase())) || '';
    } catch { /* none */ }
  }
  if (!reqFile) reqFile = latestOutputFile(reqDir, /^R-.*\.md$/i);
  if (reqFile) out.push(`需求/${reqFile}`);
  const upstream = role === 'product'
    ? ['需求分析师']
    : (role === 'programmer1' || role === 'programmer2')
      ? ['需求分析师', '产品']
      : role === 'tester'
        ? ['程序员A', '程序员B', '产品']
        : [];
  for (const roleId of upstream) {
    const dirName = ROLE_DIRS[roleId] || roleId;
    const file = latestOutputFile(path.join(projectPath, dirName, '产出'), /\.md$/i);
    if (file) out.push(`${dirName}/产出/${file}`);
  }
  return [...new Set(out)].slice(0, 5);
}

/**
 * 必读闸门：评审/派单前核对“任务关联需求正文”是否在本次 boot 里读过（哈希一致）。
 * 以 boot 令牌里落盘的需求哈希为准：需求在 boot 后改过、或是 boot 之后才出现，都算未读，
 * 必须重新 boot 补读再继续——不静默放行，也不替角色“假装读过”。
 */
function assertRequirementDocsRead(b, projectPath, requirementId, purpose) {
  const id = String(requirementId || '').trim();
  if (!id) return;
  let currentDocs = null;
  try { currentDocs = readRequirementDocs(path.resolve(projectPath)); } catch { currentDocs = null; }
  if (!currentDocs || !Array.isArray(currentDocs.list)) return;
  const lower = id.toLowerCase();
  const row = currentDocs.list.find((r) => String(r.id).toLowerCase() === lower)
    || currentDocs.list.find((r) => String(r.id).toLowerCase().startsWith(lower));
  if (!row) return; // 只有任务、没有正文文件：没有可读对象，不阻塞
  const tokenRows = Array.isArray(b.requirementDocs) ? b.requirementDocs : [];
  const hit = tokenRows.find((r) => String(r.rel) === String(row.rel));
  // 只比内容哈希：`- 状态：`/`## 状态记录` 是程序流转时自己写的，不该把阅读证据作废。
  const before = hit ? String(hit.contentHash || hit.hash || '') : '';
  const currentHash = String(row.contentHash || row.hash || '');
  if (before && before === currentHash) return;
  fail('TASK_DOCS_UNREAD', `${purpose}前必须读本任务的需求正文：${row.rel}${hit ? '（boot 后内容已更新）' : '（boot 时还没有这份）'}；先读该文件，再重新 boot 后继续`, {
    requirementId: id,
    doc: row.rel,
    booted: Boolean(hit),
    bootHash: before,
    currentHash,
    hint: `node 团队\\工具\\team.mjs boot --role ${b.role} --project "${b.project}"`,
  });
}

// Owner 2026-11-17 10:19：彻底删除 --no-wake（发消息/回执一律唤醒）。
// 任何入口（send/ack/wake）只要见到该参数就拒绝：零投递、零状态写入、零唤醒；不提供任何替代静默开关。
function assertNoWakeRemoved(args) {
  if (args && (args['no-wake'] !== undefined || args.noWake !== undefined)) {
    fail('NO_WAKE_REMOVED', '程序已删除静默发送：发消息与回执一律唤醒（不允许 --no-wake）', { flag: '--no-wake', wrote: false });
  }
}

export async function cmdSend(args) {
  assertNoWakeRemoved(args);
  const b = bootFor(args, 'send');
  // R-51de F-5④：派单（--ack --task）前必须读过当前版本经验教训登记册（Owner 通道豁免）
  if (args.ack && args.task) failLessonGate(lessonGateFor(b, args));
  // R-c651 F-c651-2：send 的唤醒路径也是重试执行者——先消化上一批到期重试，再把本次消息发出去，
  // 避免刚排队的重试被本命令立刻再跑一次（同一条消息出现两条 attempt=1）。
  let sendWakeRetry = null;
  try { sendWakeRetry = await processWakeRetries(b.project, { source: 'send' }); } catch { sendWakeRetry = null; }
  const to = String(args.to || '');
  if (!to) fail('BAD_RECIPIENT', '需要 --to');
  if (to === b.role) fail('SELF_SEND', `不能把消息发给自己（${to}）；回执/通知请发给对方角色，派单由 PM 发。`);
  let body = String(args.body ?? args.text ?? '');
  if (args['body-file']) body = readText(path.resolve(String(args['body-file'])), '');
  if (!body.trim()) fail('EMPTY_MESSAGE', '需要 --body 或 --body-file');
  // 派单文件优先：超限在写盘前拒绝，不截断、不改写、不投半条（D3 / R-38da）。
  const bodyMax = messageMaxChars();
  if (body.length > bodyMax) {
    const pmLike = b.role === 'pm' && to !== 'pm';
    fail('MESSAGE_TOO_LONG', `${pmLike ? '派单正文' : '消息正文'} ${body.length} 字，超过 ${bodyMax} 字上限；${DISPATCH_FILE_HINT.tip}`, {
      length: body.length,
      max: bodyMax,
      wrote: false,
      ...DISPATCH_FILE_HINT,
    });
  }
  const explicitType = String(args.type || '').trim().toLowerCase();
  const TYPE_ALIASES = { dispatch: 'dispatch', receipt: 'receipt', notice: 'notice', note: 'notice', request: 'notice' };
  const requestedType = TYPE_ALIASES[explicitType] || (isRegisteredKind(explicitType) ? explicitType : '');
  // R-f8e1 F-4：显式类型必须在 WAKE_KIND_LABEL 登记（question/answer/escalation/review_reject 同表）；
  // 未登记类型拒绝发送，不静默降级成通知。别名（note/request）先归一，再按归一后的名字校验。
  if (explicitType && !requestedType) {
    fail('MSG_TYPE_UNKNOWN', `消息类型 ${explicitType} 未登记：先在 dispatch.mjs 的 WAKE_KIND_LABEL 登记，再发送（禁止静默降级为通知）`, {
      type: explicitType,
      registered: ['dispatch', 'receipt', 'notice', 'request', 'merge', 'system', 'question', 'answer', 'escalation', 'review_reject'],
      wrote: false
    });
  }
  // B-20261116-062204-89c6（AC1/AC3/AC6）：PM 用消息问 Owner 拍板却标成 notice/dispatch → 拒（零写入）。
  // 判据避免误拦：①发给 owner 且命中拍板词 → 拦；②其它收件人仅在「无 task 绑定 + 带问号 + 命中拍板词」时拦，
  // 所以「要不要只是举例」这类派单/说明不会被打死（AC3 反向断言）。
  if (b.role === 'pm' && requestedType !== 'owner_ask') {
    const askText = `${String(args.subject || '')} ${body}`;
    const askHits = looksLikeOwnerAsk(askText);
    const asksOwner = to === 'owner';
    const questionLike = /[？?]/.test(askText);
    if (askHits.length && (asksOwner || (!args.task && questionLike))) {
      try {
        appendDecisionRouteAudit(b.project, {
          actor: 'pm', action: 'rejected_type', askId: null, target: to,
          ruleId: 'R-ASK-TYPE', code: 'OWNER_ASK_REQUIRES_TYPE',
          note: String(args.subject || '').slice(0, 80), reason: askHits.join(','),
        });
      } catch { /* 审计写不了也不能把原命令放过去：下面照样拒 */ }
      fail('OWNER_ASK_REQUIRES_TYPE',
        `PM 问 Owner 的话必须走决策箱：` +
        `node 团队/工具/team.mjs send --project ${b.project} --boot <PM令牌> --to owner --type owner_ask --subject "…" --body "…"` +
        `（命中拍板词：${askHits.join('、')}；也可用 decision add 建条目后再发）`,
        { to, type: requestedType || 'notice', hits: askHits, wrote: false });
    }
  }
  let taskRow = null;
  if (args.task) {
    try { taskRow = loadTask(b.project, String(args.task)); } catch { taskRow = null; }
  }
  // ceba AC5.4：『已完成/已验收』再派都要降级为通知——任务 done 之外，需求已收口也算。
  const taskDone = Boolean(taskRow && taskRow.status === 'done');
  const requirementClosed = (() => {
    const reqId = String(args.requirement || (taskRow && taskRow.requirementId) || '').trim();
    if (!reqId) return false;
    try {
      const wf = readJson(path.join(projectStatePaths(b.project).dir, '工作流.json')) || {};
      const row = (wf.requirements && (wf.requirements[reqId] || Object.values(wf.requirements).find((r) => r && String(r.id) === reqId))) || null;
      const status = String((row && row.status) || '');
      return ['accepted', 'done', 'terminated', 'iteration', 'rejected'].includes(status);
    } catch { return false; }
  })();
  const targetClosed = taskDone || requirementClosed;
  // B-20261117-195929-7d73（R-45c7 AC1）：默认唤醒**必须**开。Owner 2026-11-17 10:19 已明确删除静默开关
  // （`--no-wake` → NO_WAKE_REMOVED，selftest 有断言），所以这里没有「关闭」分支：任何消息类型落盘后一律唤醒。
  const willWake = true;
  // 派单判定：PM 带 --ack 发给非 PM 角色，且目标未收口（完成回执/通知/请求只投递不派单）。
  const autoWanted = b.role === 'pm' && to !== 'pm' && Boolean(args.ack);
  const autoDispatch = autoWanted && !targetClosed;
  const isDispatch = requestedType === 'dispatch' ? autoDispatch : (requestedType ? false : autoDispatch);
  const demoted = (requestedType === 'dispatch' && !isDispatch) || (autoWanted && targetClosed);
  const msgType = requestedType && requestedType !== 'dispatch'
    ? requestedType
    : (isDispatch ? 'dispatch' : 'notice');
  // R-b52b F-7：派单目标只认「项目.json.roleIds」——fast 项目派给 programmer2/product 必须拒，
  // 不能因为全局 团队.json 里还挂着这两个成员就放行（那只是会话绑定，不是项目角色）。
  if (isDispatch) {
    const dispatchRoleIds = projectRoleIds(loadProject(b.project));
    if (!dispatchRoleIds.includes(to)) {
      fail('NO_RECIPIENT', `项目「${b.project}」没有角色 ${to}（roleIds=${dispatchRoleIds.join(' / ')}）；不能派单给不属于该项目的角色`, {
        project: b.project, to, roleIds: dispatchRoleIds, wrote: false
      });
    }
  }
  // 派单前先查必读：PM 没读过（或 boot 后需求又改了）的任务正文，不能直接派给角色。
  if (isDispatch && taskRow && taskRow.requirementId) {
    let projectPath = '';
    try { projectPath = loadProject(b.project).path; } catch { projectPath = ''; }
    if (projectPath) assertRequirementDocsRead(b, projectPath, taskRow.requirementId, '派单');
  }
  // 四处会话映射一致性：派单/唤醒前必须一致（AC17.11），避免叫醒旧会话；不一致给字段与修法。
  // B-7d73：默认唤醒（willWake 已在上面按 --no-wake 判定），这里只做一致性断言。
  if (willWake) assertSessionMapConsistent(b.project, isDispatch ? '派单' : '唤醒');
  // G1/G2/G3/G5/G0/G4：派开发前过需求定稿→评审→Owner 落账→角色忙→阶段角色表→设计签名。
  if (isDispatch && taskRow && taskRow.requirementId) {
    runDispatchGates({
      projectName: b.project, requirementId: String(taskRow.requirementId), role: b.role,
      targetRole: to, attempted: 'send --ack', taskId: String(args.task || ''),
      skipRoleBusy: Boolean(args.queue),
    });
  }
  // PM 一次只能派一个：上一条要回执的派单未闭环前，禁止继续扇出。
  // --queue：不硬拒，把本单排进 派单队列.json，等角色 task done 后自动续跑（R-31b3）。
  let releasedLock = null;
  const pmDispatch = isDispatch && b.role === 'pm';
  // R-bad3 F-bad3-2：派单（含排队派单）前先确保目标角色有有效 boot 令牌；失败不阻塞但返回 pendingBoot。
  // B-5989：trigger 不再写死 stale——按上下文推断 rotate / create / rules_changed / stale 四类。
  const ensureBootForDispatch = async () => {
    if (!isDispatch) return null;
    try {
      const { ensureBooted, findValidBootToken, inferBootTrigger } = await import('./auto-boot.mjs');
      if (findValidBootToken(b.project, to, '')) return null;
      const trigger = inferBootTrigger(b.project, to, String(args.session || ''));
      return ensureBooted({ project: b.project, role: to, trigger, duringTask: String(args.task || '') });
    } catch (e) { return { ok: false, why: String((e && e.message) || e) }; }
  };
  if (pmDispatch && !args.force) {
    // B-384e：先清过期锁（10 分钟无人回执自动释放），再判未回执锁。
    releaseExpiredDispatchLock(b.project, { source: 'send' });
    // B-405f ②：目标会话 5 分钟无活性（不存在/0 使用）也释放，避免锁在“从未启动的新会话”上锁死全队。
    releasedLock = await releaseInactiveDispatchLock(b.project, { source: 'send' });
    const lock = readDispatchLock(b.project);
    if (lock && lock.messageId) {
      if (args.queue) {
        const bootForQueue = await ensureBootForDispatch();
        const item = enqueueDispatch(b.project, {
          from: b.role, to, subject: args.subject || '(无主题)', body,
          task: String(args.task || ''), project: b.project, ackRequired: Boolean(args.ack),
          sessionId: b.sessionId,
        });
        appendEvent({ role: b.role, sessionId: b.sessionId, action: 'dispatch_queue_add', project: b.project, target: item.id, note: `to=${to} task=${item.task || ''}` });
        // R-1dfb 卷 §三：入队即登记 queued 状态（attempt=1），供 tickDispatchDeadlines 到期检查。
        try { markDeliveryState(b.project, item.id, { state: 'queued', attempt: 1, lastAt: nowIso(), lastCode: '' }); } catch { /* 状态写失败不阻断入队 */ }
        out(args, `已入队 ${item.id} → ${to}（上一条派单 ${lock.messageId} 未回执；角色完成后自动续跑）`, {
          ok: true, queued: true, item, pending: lock, queue: readDispatchQueue(b.project),
        });
        return;
      }
      fail('PM_DISPATCH_PENDING', `上一条派单还没回执：${lock.messageId} → ${lock.to}（${lock.subject}）。先等回执，确认后再派下一个；要排队请加 --queue。`, { pending: lock });
    }
  }
  // 派单时顺手把任务 owner 定为目标角色，避免任务 owner 为空、角色不知归属。
  if (pmDispatch && args.task) {
    // T-20261116-124658-303e：认领硬门——同角色名下有未清的「派单超时未认领」时，新单一律拒派（零写入）。
    const claimGate = dispatchGateFor(b.project, to);
    if (!claimGate.ok) fail(claimGate.code, claimGate.message, { taskId: claimGate.taskId, owner: claimGate.owner, ageMin: claimGate.ageMin, level: claimGate.level });
    try {
      const task = loadTask(b.project, String(args.task));
      if (task && !task.owner) {
        task.owner = to;
        task.status = task.status || 'open';
        // 派单即记派单时间 + 必须认领标记；10/30 分钟由 scanClaims 打 claimOverdue / claimStalled。
        task.dispatchedAt = nowIso();
        task.dispatchedBy = b.role;
        task.claimRequired = true;
        saveTask(b.project, task);
      } else if (task && task.owner && task.owner !== to) {
        fail('TASK_OWNED', `任务 ${task.id} 已归 ${task.owner}，不能派给 ${to}`);
      }
    } catch (e) {
      if (e.code === 'TASK_OWNED') throw e;
    }
  }
  // B-405f ①：派单前探活——冷会话先发启动提示拉起，拉不起来就明确报错（不写消息、不占锁）。
  let targetAlive = null;
  if (isDispatch) targetAlive = await ensureDispatchTargetAlive(b.project, to, taskRow);
  // R-bad3 F-bad3-2：派单前先确保目标角色有有效 boot 令牌（缺失/过期才自动 boot），
  // boot 失败不阻塞投递，但标 pendingBoot 并在返回里让 PM 看到卡点。
  const autoBoot = await ensureBootForDispatch();
  const pendingBoot = Boolean(autoBoot && autoBoot.ok === false);
  const msg = notify({
    from: b.role, to, subject: args.subject || '(无主题)', body, project: b.project,
    task: args.task || '', ackRequired: Boolean(args.ack), type: msgType, sessionId: b.sessionId,
  });
  if (pmDispatch) writeDispatchLock(b.project, msg, { targetSessionId: targetAlive && targetAlive.probe ? targetAlive.probe.sessionId : '' });
  let wake = null;
  // B-1e4a（R-45c7，Owner 2026-11-14 13:06）+ B-7d73（2026-11-17 19:59）：默认唤醒=开，任何消息类型
  // （含通知/回执）落盘后都立即唤醒接收方；静默开关已被 Owner 10:19 删除（`--no-wake` 在入口即拒）。
  const wantWake = true;
  // B-743e：把首行归属随发送结果一起返回，便于自测与排障核对格式。
  const wakeHeader = wantWake && msg ? wakeHeaderFor(msg, to) : '';
  if (wantWake) {
    wake = await wakeWithGuard({
      project: b.project, to, msg, isDispatch,
      engineUrl: String(args['engine-url'] || ''), taskRow,
      reason: isDispatch ? 'dispatch' : (to === 'pm' ? 'to_pm' : (args.wake ? 'wake_flag' : 'default')),
    });
  }
  // Owner 2026-11-14 08:44：投递成功即自动标已读（沙盘 SELFTEST 也算送达）；投递失败保持未读，重试由 c651 负责。
  let autoRead = null;
  if (wake && wake.ok === true && (wake.skipped === 'SELFTEST' || wake.deliveredAt || !wake.skipped)) {
    try {
      readMessage(to, msg.id);
      autoRead = { ok: true, messageId: msg.id };
      appendEvent({ role: 'system', sessionId: '', action: 'wake_auto_read', project: b.project, target: msg.id, note: `to=${to}` });
    } catch (e) { autoRead = { ok: false, why: String((e && e.message) || e) }; }
  } else if (wake && wake.ok === false) {
    autoRead = { ok: false, why: 'not_delivered' };
  }
  // B-405f ④：派单唤醒失败不占锁（否则一条没送到的单会锁死全队），失败原因带回给 PM。
  if (isDispatch && wake && wake.ok !== true) {
    const released = releaseDispatchLockForTask(b.project, String(args.task || ''), { source: 'wake_failed' });
    if (released) releasedLock = { ...released, released: true, reason: 'wake_failed' };
    appendEvent({
      role: b.role, sessionId: b.sessionId, action: 'dispatch_wake_failed', project: b.project, target: msg.id,
      note: `to=${to} why=${String(wake.why || wake.code || '')} lockReleased=${released ? '1' : '0'}`,
    });
  }
  const wakeFailed = Boolean(isDispatch && wake && wake.ok !== true);
  const suffix = wake
    ? (wake.ok
      ? (wake.skipped === 'MERGED_PENDING'
        ? `；已合并唤醒（窗口内第 ${wake.pending} 条，最多 30 秒内补发一次，不丢）`
        : (wake.skipped === 'ALREADY_DELIVERED' ? '' : (wake.skipped ? '' : `；已${isDispatch ? '派单' : '提示'} ${to}`)))
      : `；唤醒失败：${wake.why}${wakeFailed
        ? (releasedLock ? '（已留痕；派单锁已释放，修复目标会话后重派）' : '（已留痕；锁未匹配本单，按 TTL 兜底）')
        : '（已留痕，60 秒兜底重试）'}`)
    : '';
  const receiptHint = msg.ackRequired ? '（要回执：ack 只代表已回执，完成要完成回执 + task done --evidence）' : '';
  const demotedHint = demoted
    ? (to === 'pm'
      ? '（收件人是 PM：PM 永不收派单，已降级为通知）'
      : (targetClosed ? `（任务 ${args.task} 已完成/需求已收口：已降级为通知，不再派单）` : '（发送者不是 PM：已降级为通知）'))
    : '';
  const targetHint = targetAlive && targetAlive.probe && targetAlive.warmup
    ? `；目标会话：${targetAlive.probe.state} → ${targetAlive.warmup.ok === true ? '已拉起' : '拉起失败（已留痕，继续尝试唤醒）'}`
    : '';
  out(args, `已发送 ${msg.id} → ${to}${receiptHint}${demotedHint}${suffix}${targetHint}`,
    {
      ok: true, message: msg, wake, dispatch: isDispatch, type: msgType, demoted, taskDone, requirementClosed, targetClosed,
      target: targetAlive && targetAlive.probe
        ? { role: to, state: targetAlive.probe.state, sessionId: targetAlive.probe.sessionId, warmup: targetAlive.warmup }
        : null,
      wakeFailed, releasedLock, wakeHeader, wakeRetry: sendWakeRetry, autoRead,
      ...(pendingBoot ? { pendingBoot: true, autoBoot } : {}),
    });
}

export function cmdInbox(args) {
  const b = bootFor(args, 'inbox');
  // Owner 2026-11-14 08:44：清历史积压——只读盘点后批量标已读，写一条审计。
  if (args['mark-all-read']) {
    const rows = listInbox(b.role, { project: b.project, includeCur: true });
    const unread = rows.filter((m) => !m.readAt);
    let marked = 0;
    for (const m of unread) {
      try { readMessage(b.role, m.id); marked += 1; } catch { /* 单条失败不阻断其余 */ }
    }
    const at = nowIso();
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'inbox_mark_all_read', project: b.project, target: String(marked), note: `role=${b.role} unread=${unread.length} marked=${marked}` });
    try { appendLine(PATHS.reads, JSON.stringify({ at, role: b.role, kind: 'mark-all-read', project: b.project, unread: unread.length, marked, source: 'inbox --mark-all-read' })); } catch { /* 审计失败不阻断 */ }
    out(args, `已批量标已读：${b.role} 盘点未读 ${unread.length} 条，实际标记 ${marked} 条（审计已写）`, { ok: true, role: b.role, unread: unread.length, marked, at });
    return;
  }
  const msgs = listInbox(b.role, { includeCur: Boolean(args.all), project: b.project });
  const rows = msgs.map((m) => ({
    id: m.id, from: m.from, subject: m.subject, kind: messageKindOf(m), ack: m.ackRequired ? '要' : '', box: m.box, ts: hhmmss(m.ts),
  }));
  out(args, `收件箱（${b.role}，${msgs.length} 条）\n` + table(rows, [
    { key: 'ts', label: '时间' }, { key: 'id', label: '消息' }, { key: 'from', label: '发件' }, { key: 'kind', label: '型' }, { key: 'ack', label: '回执' }, { key: 'box', label: '箱' }, { key: 'subject', label: '主题' },
  ]), { ok: true, messages: msgs });
}

export function cmdRead(args) {
  const b = bootFor(args, 'read');
  if (!args.id) fail('BAD_ID', '需要 --id');
  const { msg, alreadyRead } = readMessage(b.role, String(args.id));
  // R-c651 F-c651-1① + B-20261114-152128-44f5：读消息必须留「kind=read + messageId」证据。
  // 唤醒投递会先把消息移进 cur 并写 readAt（alreadyRead=true），以前这里跳过 → 唤醒过的消息永远没有阅读行。
  // 现在：首次读 mode=first（counted=true）；已读/重复读也写 mode=reread（counted=false，不重复计数）。
  let readReceipt = null;
  try {
    const prior = readJsonl(PATHS.reads).filter((row) => row
      && String(row.kind || '') === 'read'
      && String(row.role || '') === b.role
      && String(row.messageId || '') === String(msg.id));
    readReceipt = addReadReceipt({
      role: b.role, sessionId: b.sessionId, kind: 'read', project: String(msg.project || b.project || ''),
      messageId: msg.id, messageIds: [msg.id], source: 'inbox', at: nowIso(),
      proposalId: '', proposalHash: '', baseHash: '',
      mode: prior.length ? 'reread' : 'first',
      counted: prior.length === 0,
      rereadCount: prior.length,
    });
  } catch { /* 阅读证据写失败不阻断读动作本身 */ }
  appendEvent({ role: b.role, sessionId: b.sessionId, action: 'mail_read', project: msg.project, target: msg.id, note: msg.subject });
  out(args, `已读 ${msg.id}：${msg.subject}\n${msg.body}`, {
    ok: true, message: msg, alreadyRead, readReceipt,
    readCounted: Boolean(readReceipt && readReceipt.counted),
  });
}

export async function cmdAck(args) {
  assertNoWakeRemoved(args);
  const b = bootFor(args, 'ack');
  if (!args.id) fail('BAD_ID', '需要 --id');
  // R-c651 F-c651-2：ack 的唤醒路径也是重试执行者（先消化到期重试）。
  let ackWakeRetry = null;
  try { ackWakeRetry = await processWakeRetries(b.project, { source: 'ack' }); } catch { ackWakeRetry = null; }
  const r = ackMessage(b.role, String(args.id), args.note || '已收到');
  // Owner 2026-11-16 18:50（取代 11-14 的「纯回执不唤醒」）：回执落盘后必须唤醒原消息发送方。
  // Owner 2026-11-17 10:19：发消息与回执一律唤醒，无静默开关（--no-wake 已被删除）。
  clearDispatchLock(r.msg.project, String(args.id));
  appendEvent({
    role: b.role, sessionId: b.sessionId, action: 'ack', project: r.msg.project, target: r.msg.id,
    note: r.already ? '重复回执' : truncate(String(args.note || '已收到'), 120), data: { ackId: r.ack.id, receiptMessageId: r.receiptMessage?.id || '', noticeMessageId: r.ack?.noticeMessageId || '' },
  });
  // Owner 2026-11-16 18:50：回执必须唤醒发送方（尤其角色→PM 的回执）——此前 ack 只落盘不唤醒，PM 收不到。
  let ackWake = null;
  const ackWakeTarget = String((r.msg && r.msg.from) || '');
  if (!r.already && ackWakeTarget && ackWakeTarget !== b.role && ackWakeTarget !== 'system') {
    try {
      ackWake = await wakeWithGuard({
        project: r.msg.project, to: ackWakeTarget, msg: r.receiptMessage || r.msg,
        isDispatch: false, reason: 'receipt', dedupeKey: `ack:${r.ack.id}`,
      });
      appendEvent({
        role: b.role, sessionId: b.sessionId, action: 'ack_wake', project: r.msg.project, target: String(args.id),
        note: `to=${ackWakeTarget} ok=${ackWake && ackWake.ok === true ? '1' : '0'} skipped=${String((ackWake && ackWake.skipped) || '')}`,
      });
    } catch (e) { ackWake = { ok: false, why: String((e && e.message) || e) }; }
  }
  // B-a577：回执也触发一次兜底泵（收了回执说明 PM 锁已释放，队列该接着跑）。
  const ackPump = await pumpQueueSafe(r.msg.project, 'ack');
  const hint = '（仅表示已收到/已认领，不算完成；完成请执行正文任务并 task done --evidence）';
  // B-2736：只有真的投出了通知才说"已通知"，避免 CLI 打印假象。
  const ackNotify = r.receiptMessage
    ? `→ 已通知 ${r.msg.from}（${r.receiptMessage.type === 'notice' ? '静默 notice' : '回执消息'} ${r.receiptMessage.id}）`
    : (r.msg.from === 'system' ? '' : '（未发通知：静默消息/无需通知）');
  const pumpHint = ackPump && ackPump.pumped
    ? `\n队列自动续跑：已派 ${ackPump.message && ackPump.message.id} → ${ackPump.item && ackPump.item.to}（task ${(ackPump.item && ackPump.item.task) || '-'}）`
    : (ackPump && ackPump.ok === false ? `\n队列泵失败：${String(ackPump.why || ackPump.code || 'QUEUE_PUMP_FAILED').slice(0, 120)}（队列项已保留）` : '');
  const ackWakeHint = ackWake && ackWake.ok === true
    ? ((ackWake.skipped === 'SELFTEST' || ackWake.skipped === 'sandbox_wake_skipped') ? '；已唤醒(沙盘)' : '；已唤醒')
    : (ackWake ? `；唤醒失败[${String(ackWake.code || ackWake.skipped || 'UNKNOWN')}] ${String(ackWake.why || '').slice(0, 120)}` : '');
  out(args, (r.already ? `已回执过 ${r.msg.id}（${r.ack.id}）${hint}` : `已回执 ${r.msg.id}（${r.ack.id}）${ackNotify}${ackWakeHint}${hint}`) + pumpHint, { ok: true, ...r, ackWake, dispatchQueue: ackPump });
}

/** R-c651 F-c651-4：每角色在场（只读）。工作台团队行/角色卡与测试脚本共用这一份口径。 */
export function cmdPresence(args) {
  const project = String(args.project || '');
  if (!project) fail('BAD_PROJECT', '需要 --project');
  const roles = String(args.role || '').split(',').map((s) => s.trim()).filter(Boolean);
  const rows = presenceFor(project, { roles });
  const view = rows.map((r) => ({
    role: r.role,
    unread: r.unread,
    ackPending: r.ackPending,
    stalled: r.stalledMin === null ? '—' : String(r.stalledMin) + ' 分' + (r.stalledLevel === 'bad' ? '（>30 红）' : (r.stalledLevel === 'warn' ? '（>15 黄）' : '')),
    wake: r.wakeFailed ? '唤醒失败' : '正常',
    legacy: r.legacyUnread,
  }));
  out(args, `团队在场（${project}）\n` + table(view, [
    { key: 'role', label: '角色' }, { key: 'unread', label: '未读' }, { key: 'ackPending', label: '未回执' },
    { key: 'stalled', label: '停滞' }, { key: 'wake', label: '唤醒' }, { key: 'legacy', label: '旧箱未读(参考)' },
  ]), { ok: true, project, rows, stalledWarnMin: STALL_WARN_MIN, stalledBadMin: STALL_BAD_MIN });
}

/** R-c651 F-c651-5：全部已读（批量）。Owner 控制台以 actor=owner 执行；角色本人需带 boot 令牌。 */
export function cmdMarkRead(args) {
  const project = String(args.project || '');
  const role = String(args.role || '').trim();
  if (!project) fail('BAD_PROJECT', '需要 --project');
  if (!role) fail('BAD_ROLE', '需要 --role');
  let actor = String(args.actor || '');
  if (args.boot) {
    const b = bootFor(args, 'mark-read');
    if (b.role !== role) fail('BOOT_ROLE_MISMATCH', `令牌角色 ${b.role} ≠ --role ${role}`);
    actor = actor || b.role;
  }
  if (!actor) actor = 'owner';
  const r = markReadAll(project, role, { actor, source: String(args.source || 'ui-mark-read') });
  out(args, `已读 ${role}：${r.count} 条${r.count ? `（${r.messageIds.slice(0, 5).join(',')}）` : '（没有新口径下的未读）'}`, r);
}

/** R-c651 F-c651-4：一键唤醒（限 PM/Owner 界面入口）。失败自动排 5/15/30 秒重试，3 次后告警 PM。 */
export async function cmdWake(args) {
  assertNoWakeRemoved(args);
  const project = String(args.project || '');
  const role = String(args.role || '').trim();
  if (!project) fail('BAD_PROJECT', '需要 --project');
  if (!role) fail('BAD_ROLE', '需要 --role');
  if (args.boot) bootFor(args, 'wake');
  const r = await wakeRole(project, role, {
    reason: String(args.reason || 'ui'),
    engineUrl: String(args['engine-url'] || ''),
  });
  const why = r.wake ? String(r.wake.why || r.wake.code || r.wake.skipped || '') : '';
  const human = r.ok
    ? `已唤醒 ${role}${why ? `（${why}）` : ''}`
    : `唤醒失败：${why || '未知'}（已排 5/15/30 秒重试；3 次仍失败会给 PM 发 wake_failed 并在看板标红点）`;
  out(args, human, r);
}

// ========== 问询 ask/answer（B-ae9f） ==========
// 角色之间自由问询：不占派单锁、必须由收件人回答；30 分钟未答升级 PM 卡点，看板显示未答数。
const ASK_STORE_FILE = '问询.json';
const ASK_TTL_DEFAULT_MIN = 30;

function askStorePath(project) {
  return path.join(projectStatePaths(project).dir, ASK_STORE_FILE);
}
function readAskStore(project) {
  try {
    const data = readJson(askStorePath(project));
    return { items: data && Array.isArray(data.items) ? data.items : [], updatedAt: (data && data.updatedAt) || '' };
  } catch {
    return { items: [], updatedAt: '' };
  }
}
function writeAskStore(project, store) {
  writeJson(askStorePath(project), { items: Array.isArray(store.items) ? store.items : [], updatedAt: nowIso() });
}
function askTtlMs() {
  const raw = process.env.TEAM_ASK_TTL_MIN;
  const min = raw === undefined || raw === '' ? ASK_TTL_DEFAULT_MIN : Number(raw);
  return Math.max(0, Number.isFinite(min) ? min : ASK_TTL_DEFAULT_MIN) * 60000;
}
/** 未答/超时/已回答计数；只读，status/board 共用。 */
function askSummary(project) {
  const items = readAskStore(project).items;
  const ttl = askTtlMs();
  const open = items.filter((it) => String(it.status || 'open') !== 'answered');
  const escalated = open.filter((it) => it.escalatedAt);
  const overdue = open.filter((it) => {
    if (it.escalatedAt) return false;
    const age = Date.now() - Date.parse(String(it.at || ''));
    return Number.isFinite(age) && age >= ttl;
  });
  return { total: items.length, open: open.length, answered: items.length - open.length, escalated: escalated.length, overdue: overdue.length };
}
/** 超时升级：未答且超过 TTL、还没升级过的问询 → 给 PM 一条卡点消息（每条只升级一次）。 */
async function sweepOverdueAsks(project, { source = '' } = {}) {
  const store = readAskStore(project);
  const ttl = askTtlMs();
  const due = [];
  for (const item of store.items) {
    if (String(item.status || 'open') === 'answered' || item.escalatedAt) continue;
    const age = Date.now() - Date.parse(String(item.at || ''));
    if (!Number.isFinite(age) || age < ttl) continue;
    item.escalatedAt = nowIso();
    due.push(item);
  }
  if (!due.length) return { ok: true, escalated: [], summary: askSummary(project) };
  writeAskStore(project, store);
  for (const item of due) {
    const msg = notify({
      from: 'system', to: 'pm',
      subject: `卡点：问询 ${item.id} 超 ${Math.round(ttl / 60000)} 分钟未答`,
      body: `${item.from} 问 ${item.to} 的问题超过 ${Math.round(ttl / 60000)} 分钟没人回答：\n${String(item.question || '').slice(0, 300)}\n\n原问询 id：${item.id}${item.task ? '（任务 ' + item.task + '）' : ''}\n可以催办，或让原提问人换人再问；不占派单锁。`,
      project, task: String(item.task || ''), ackRequired: true, type: 'escalation', sessionId: '',
    });
    await wakeWithGuard({ project, to: 'pm', msg, isDispatch: false, reason: `ask_escalated:${item.id}`, dedupeKey: `ask_escalated:${item.id}` });
    appendEvent({
      role: 'system', sessionId: '', action: 'ask_escalated', project, target: item.id,
      note: `${item.from}→${item.to} ttl=${Math.round(ttl / 60000)}min source=${source}`,
    });
  }
  return { ok: true, escalated: due, summary: askSummary(project) };
}

export async function cmdAsk(args) {
  const b = bootFor(args, 'ask');
  const sub = String((args._ && args._[1]) || 'create').toLowerCase();
  if (sub === 'check') {
    const rows = await sweepOverdueAsks(b.project, { source: 'manual' });
    out(args, `问询检查：新升级 ${rows.escalated.length} 条 ｜ 未答 ${rows.summary.open} · 已升级 ${rows.summary.escalated} · 已回答 ${rows.summary.answered}`, { ok: true, ...rows });
    return;
  }
  if (sub === 'list') {
    const store = readAskStore(b.project);
    const rows = store.items.map((it) => ({
      id: it.id, from: it.from, to: it.to, status: it.status || 'open',
      age: Math.round((Date.now() - Date.parse(String(it.at || ''))) / 60000) + 'm',
      escalated: it.escalatedAt ? '是' : '', question: String(it.question || '').slice(0, 40),
    }));
    const openOnly = rows.filter((row) => row.status !== 'answered');
    out(args, `问询（${b.project}）：共 ${rows.length} · 未答 ${openOnly.length}\n` + table(args.all ? rows : openOnly, [
      { key: 'id', label: '问询' }, { key: 'from', label: '问' }, { key: 'to', label: '答' }, { key: 'status', label: '状态' }, { key: 'age', label: '已等' }, { key: 'escalated', label: '升级' }, { key: 'question', label: '问题' },
    ]), { ok: true, questions: rows, summary: askSummary(b.project) });
    return;
  }
  if (sub !== 'create') fail('BAD_SUBCOMMAND', `未知 ask 子命令：${sub}（create/list/check）`);
  const to = String(args.to || '');
  if (!to) fail('BAD_TO', '需要 --to <角色>：问谁（如 programmer2 / analyst / pm）');
  if (to === b.role) fail('ASK_SELF', '不能问自己；换一个角色');
  // R-b52b F-7/AC5：收件人只按「项目.json.roleIds」判（不是全局 团队.json）；
  // fast 项目问 product 必须 NO_RECIPIENT + PM 卡点，不得静默成功。
  const askProject = loadProject(b.project);
  const askRoleIds = projectRoleIds(askProject);
  if (!askRoleIds.includes(to)) {
    const hint = `项目「${b.project}」没有角色 ${to}（现有 ${askRoleIds.join(' / ')}）；`
      + (to === 'product' ? 'fast 无产品，建议问 analyst 或 pm；' : '') + '已给 PM 留卡点，不静默成功';
    try {
      notify({
        from: 'system', to: 'pm', type: 'notice', ackRequired: false, sessionId: b.sessionId,
        subject: `互询受阻：${b.project} 无角色 ${to}`,
        body: `${b.role} 想向 ${to} 问询，但该项目 roleIds 不含该角色。${hint}`,
        project: b.project,
      });
    } catch { /* 卡点发不出也照实拒绝 */ }
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'ask_no_recipient', project: b.project, target: to, note: hint });
    fail('NO_RECIPIENT', hint, { project: b.project, to, roleIds: askRoleIds });
  }
  const team = loadTeam();
  const target = getMember(team, to);
  if (!target || target.status !== 'active') fail('NO_RECIPIENT', `收件人不在团队或未激活：${to}`);
  const question = String(args.question || '').trim();
  if (!question) fail('QUESTION_REQUIRED', '需要 --question "问题正文"（写清楚要对方回答什么）');
  if (question.length > 1000) fail('QUESTION_TOO_LONG', `问题 ${question.length} 字，超过 1000 字；先写成项目内文件再发路径`);
  await sweepOverdueAsks(b.project, { source: 'ask' });
  const id = `Q-${stamp()}-${randomHex(3)}`;
  const item = {
    id, project: b.project, from: b.role, to, task: String(args.task || ''), question,
    status: 'open', at: nowIso(), answer: '', answeredAt: null, escalatedAt: null,
  };
  const store = readAskStore(b.project);
  store.items.push(item);
  writeAskStore(b.project, store);
  const msg = notify({
    from: b.role, to, subject: `问询 ${id}：${question.slice(0, 40)}`,
    body: `${question}\n\n—— 来自 ${roleCnName(b.role) || b.role}（不占派单锁）。回答：node 团队\\工具\\team.mjs answer --boot <你的令牌> --id ${id} --answer "…"`,
    project: b.project, task: item.task, ackRequired: true, type: 'question', sessionId: b.sessionId,
  });
  const wake = await wakeWithGuard({ project: b.project, to, msg, isDispatch: false, reason: `ask:${id}`, dedupeKey: `ask:${id}` });
  appendEvent({ role: b.role, sessionId: b.sessionId, action: 'ask', project: b.project, target: id, note: `${b.role}→${to} ${truncate(question, 80)}` });
  out(args, `已问询 ${id} → ${to}（不占派单锁；${Math.round(askTtlMs() / 60000)} 分钟未答升级 PM）${wake && wake.ok ? '；已唤醒' : ''}`, {
    ok: true, question: item, message: msg, wake, summary: askSummary(b.project),
  });
}

export async function cmdAnswer(args) {
  const b = bootFor(args, 'answer');
  const id = String(args.id || '');
  if (!id) fail('BAD_ID', '需要 --id Q-...（见问询消息里的 id）');
  const answer = String(args.answer || '').trim();
  if (!answer) fail('ANSWER_REQUIRED', '需要 --answer "答复正文"（问询必须回，不能空回）');
  if (answer.length > 1000) fail('ANSWER_TOO_LONG', `答复 ${answer.length} 字，超过 1000 字；先写文件再发路径`);
  const store = readAskStore(b.project);
  const item = store.items.find((it) => String(it.id) === id);
  if (!item) fail('QUESTION_NOT_FOUND', `找不到问询：${id}`, { project: b.project, id });
  if (String(item.status || 'open') === 'answered') fail('ALREADY_ANSWERED', `问询 ${id} 已经回答过（${item.answeredAt || ''}）`, { id });
  if (String(item.to) !== b.role) fail('NOT_RECIPIENT', `问询 ${id} 是发给 ${item.to} 的，只有收件人能回答（你是 ${b.role}）`, { id, to: item.to, role: b.role });
  item.status = 'answered';
  item.answer = answer;
  item.answeredAt = nowIso();
  writeAskStore(b.project, store);
  const msg = notify({
    from: b.role, to: item.from, subject: `答复 ${id}`, body: `${answer}\n\n—— 针对问询：${String(item.question || '').slice(0, 200)}`,
    project: b.project, task: String(item.task || ''), ackRequired: false, type: 'answer', sessionId: b.sessionId,
  });
  const wake = await wakeWithGuard({ project: b.project, to: item.from, msg, isDispatch: false, reason: `answer:${id}`, dedupeKey: `answer:${id}` });
  appendEvent({ role: b.role, sessionId: b.sessionId, action: 'answer', project: b.project, target: id, note: `${b.role} answered ${id}` });
  out(args, `已回答 ${id} → ${item.from}（问询关闭）${wake && wake.ok ? '；已唤醒对方' : ''}`, {
    ok: true, question: item, message: msg, wake, summary: askSummary(b.project),
  });
}

// ========== 任务 ==========

export async function cmdTask(args) {
  const sub = args._[1] || 'list';
  const b = bootFor(args, 'task');
  // R-62b9（增补卷-62b9-1 §四 E2，维修模式·PM 授权）：缺陷单按操作者角色直接验收。
  // 用法：team.mjs task accept --project P --task <任务id> --as tester|pm --decision accepted|rejected
  //       --opinion "…" --evidence <报告>:report --evidence <截图>:screenshot --boot <T>
  if (sub === 'accept') {
    const asRole = String(args.as || b.role || '').trim().toLowerCase();
    if (!['pm', 'tester', 'owner'].includes(asRole)) {
      fail('ACCEPT_ROLE_INVALID', `--as 只能是 tester / pm / owner（收到 ${asRole || '(空)'}）`, { as: asRole, allowed: ['tester', 'pm', 'owner'] });
    }
    if (asRole !== String(b.role || '')) {
      fail('ACCEPT_ROLE_MISMATCH', `--as ${asRole} 与 boot 令牌角色 ${b.role} 不一致：验收必须由本人角色的令牌执行`, { as: asRole, bootRole: b.role });
    }
    if (asRole === 'owner') {
      fail('OWNER_VIA_TASK_ACCEPT_FORBIDDEN', 'Owner 验收请走 team.mjs owner --requirement <任务id> --action accept（一次性确认码）', { as: asRole });
    }
    const taskId = String(args.task || args._[2] || '').trim();
    if (!taskId) fail('BAD_ARGS', '需要 --task <任务id>（缺陷单）');
    const task = loadTask(b.project, taskId);
    if (!['bug', 'scenario-bug'].includes(String(task.type || ''))) {
      fail('ACCEPT_NOT_DEFECT', `${taskId} 不是缺陷单（type=${task.type || '(空)'}）：task accept 只处理 bug / scenario-bug`, { taskId, type: task.type || '' });
    }
    const decision = String(args.decision || 'accepted').trim().toLowerCase();
    if (!['accepted', 'rejected'].includes(decision)) {
      fail('ACCEPT_DECISION_INVALID', `--decision 只能是 accepted / rejected（收到 ${decision || '(空)'}）`, { decision, allowed: ['accepted', 'rejected'] });
    }
    if (args.opinion === undefined || args.opinion === null) {
      fail('OPINION_REQUIRED', '需要 --opinion "验收意见"（可以为空字符串，但必须显式给出）');
    }
    const opinion = truncate(String(args.opinion || '').trim(), 300);
    const project = loadProject(b.project);
    acceptDefectTask(args, { project, projectName: b.project, task, decision, opinion, proxyMode: false, asRole });
    return;
  }
  if (sub === 'create') {
    // R-b5fc F-4：测试人员可直接建 type=bug 的 B-* 缺陷任务（旁路不改需求状态机）；其它任务类型仍限 PM/产品/需求分析。
    const wantType = String(args.type || 'task');
    const canCreate = ['pm', 'product', 'analyst'].includes(b.role) || (b.role === 'tester' && (wantType === 'bug' || wantType === 'scenario-bug'));
    if (!canCreate) fail('NOT_PM', '只有 PM / 产品 / 需求分析能建任务（测试人员只能建 type=bug 的缺陷任务）');
    // 长度与引用都在写盘前校验：超限/悬空引用必须零写入，不能“任务已落盘但通知抛错”。
    const detail = String(args.detail || '');
    const detailMax = 2000;
    if (detail.length > detailMax) {
      fail('TASK_DETAIL_TOO_LONG', `任务说明 ${detail.length} 字，超过 ${detailMax} 字上限；先写成项目内文件再派单，不要塞进 detail`, {
        length: detail.length, max: detailMax, ...DISPATCH_FILE_HINT,
      });
    }
    const requirementId = assertRequirementRef(b.project, args.requirement || '');
    const task = createTask({
      project: b.project, title: args.title, detail, priority: args.priority,
      priorityBy: args['priority-by'] || b.role, createdBy: b.role, owner: args.owner || null, due: args.due || '',
      type: wantType, requirementId, acceptance: args.acceptance || '', story: args.story || '',
      // R-43ad：缺陷单/场景缺陷的复现与场景字段（F-43ad-2/4）。
      repro: args.repro || '', expected: args.expected || '', actual: args.actual || '', scenario: args.scenario || '',
      expectedFlow: String(args['expected-flow'] || '').split(/[|,，]/).map((x) => x.trim()).filter(Boolean),
      actualFlow: String(args['actual-flow'] || '').split(/[|,，]/).map((x) => x.trim()).filter(Boolean),
      blockedRoles: String(args['blocked-roles'] || '').split(/[|,，]/).map((x) => x.trim()).filter(Boolean),
    });
    // R-d225 F-reopen-2c：任务轮次自动继承需求当前 deliveryRound（手填 --round 忽略并告警；需求无字段按 1）。
    try {
      let inheritedRound = 1;
      if (requirementId) {
        const wfNow = readWorkflowState(b.project, { fresh: true }).state || {};
        const reqs = wfNow.requirements || {};
        const reqRow = reqs[requirementId] || Object.values(reqs).find((r) => r && String(r.id || '') === requirementId) || null;
        inheritedRound = Number((reqRow && reqRow.deliveryRound) || 0) || 1;
      }
      if (String(args.round || '').trim()) {
        appendEvent({
          role: b.role, sessionId: b.sessionId, action: 'task_round_ignored', project: b.project, target: task.id,
          note: `手填 round=${args.round} 已忽略，按需求 deliveryRound=${inheritedRound}`,
        });
      }
      const created = loadTask(b.project, task.id);
      created.workflow = { ...(created.workflow || {}), round: inheritedRound };
      saveTask(b.project, created);
    } catch { /* 阶段标记失败不阻断建单 */ }
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'task_create', project: b.project, target: task.id, note: `${task.priority} ${task.title}`, data: { task } });
    if (task.owner) {
      notify({ from: b.role, to: task.owner, subject: `新任务 ${task.id}`, body: clipMessage(`${task.priority} ${task.title}\n${task.detail}`), project: b.project, task: task.id, ackRequired: true, sessionId: b.sessionId });
    }
    out(args, `已建任务 ${task.id} [${task.priority}] ${task.title}${task.owner ? ' → ' + task.owner : ''}`, { ok: true, task });
    return;
  }
  if (sub === 'list') {
    let tasks = listTasks(b.project);
    if (args.status) tasks = tasks.filter((t) => t.status === args.status);
    if (args.owner) tasks = tasks.filter((t) => t.owner === args.owner);
    if (args.cancelled) tasks = tasks.filter((t) => String(t.status || '') === 'cancelled');
    if (!args.all) tasks = tasks.filter((t) => t.status !== 'done');
    const rows = tasks.map((t) => ({ id: t.id, p: t.priority, status: t.status, owner: t.owner || '-', title: t.title, due: t.due || '' }));
    out(args, `任务（${b.project}，${tasks.length}）\n` + table(rows, [
      { key: 'p', label: '优先' }, { key: 'id', label: '任务' }, { key: 'status', label: '状态' }, { key: 'owner', label: 'Owner' }, { key: 'due', label: '截止' }, { key: 'title', label: '标题' },
    ]), { ok: true, tasks });
    return;
  }
  // T-20261115-110400-7ac3（Owner 2026-11-15 授权）：僵尸任务/需求镜像逻辑删除 + append-only 审计。
  // 默认只逻辑删（status=cancelled + cancelledAt/By/reason），不物理删文件；--purge 才物理删且须 --confirm。
  if (sub === 'reap') {
    const reason = String(args.reason || '').trim();
    if (!reason) fail('REASON_REQUIRED', 'task reap 必须带 --reason（清什么、依据哪条授权）');
    const purge = Boolean(args.purge);
    if (purge && !args.confirm) fail('CONFIRM_REQUIRED', '物理删除必须 --purge 且带 --confirm 二次确认');
    const ids = asArray(args.ids).map((x) => String(x || '').trim()).filter(Boolean);
    const filter = String(args.filter || '').trim();
    if (!ids.length && !filter) fail('BAD_ARGS', '需要 --ids T-... 或 --filter legacy|mirror|closed-req');
    const all = listTasks(b.project);
    let picked = all;
    if (ids.length) picked = all.filter((t) => ids.includes(String(t.id || '')));
    else if (filter === 'legacy') picked = all.filter((t) => /^T-20261112-/.test(String(t.id || '')));
    else if (filter === 'mirror') picked = all.filter((t) => String(t.type || '') === 'requirement' && /^R-/.test(String(t.id || '')));
    else if (filter === 'closed-req') {
      const wfRead = readWorkflowState(b.project, { fresh: true });
      const wfRows = (wfRead && wfRead.state && wfRead.state.requirements) || {};
      const terminal = new Set(['accepted', 'done', 'terminated', 'iteration', 'rejected']);
      picked = all.filter((t) => terminal.has(String((wfRows[String(t.requirementId || '')] || {}).status || '')));
    } else fail('BAD_FILTER', `--filter 只能是 legacy|mirror|closed-req，收到：${filter}`);
    const at = nowIso();
    const auditPath = path.join(projectStatePaths(b.project).dir, '任务清理.jsonl');
    const rows = [];
    for (const task of picked) {
      const fromStatus = String(task.status || '');
      if (fromStatus === 'cancelled') { rows.push({ id: task.id, action: 'noop', fromStatus, toStatus: 'cancelled' }); continue; }
      const hasEvidence = String(task.evidence || '').trim() || (Array.isArray(task.evidenceFiles) && task.evidenceFiles.length);
      if (purge && hasEvidence) fail('PURGE_REFUSED', `任务 ${task.id} 有证据，拒绝物理删除（只允许逻辑删）`, { taskId: task.id });
      if (purge) {
        let reqClosed = false;
        try {
          const wfRead = readWorkflowState(b.project, { fresh: true });
          const reqRow = (wfRead.state && wfRead.state.requirements || {})[String(task.requirementId || '')] || {};
          reqClosed = ['accepted', 'done', 'terminated', 'iteration', 'rejected'].includes(String(reqRow.status || ''));
        } catch { reqClosed = false; }
        if (!reqClosed) fail('PURGE_REFUSED', `任务 ${task.id} 的父需求未收口，拒绝物理删除`, { taskId: task.id, requirementId: task.requirementId || '' });
        const file = path.join(projectStatePaths(b.project).tasks, `${task.id}.json`);
        try { fs.rmSync(file, { force: true }); } catch (e) { fail('PURGE_FAILED', `删除 ${task.id} 失败：${String(e && e.message || e)}`); }
      } else {
        task.status = 'cancelled';
        task.cancelledAt = at;
        task.cancelledBy = b.role;
        task.cancelReason = truncate(reason, 200);
        saveTask(b.project, task);
      }
      const row = { at, id: task.id, reason: truncate(reason, 200), by: b.role, fromStatus, toStatus: purge ? 'purged' : 'cancelled', physical: purge };
      try { appendLine(auditPath, JSON.stringify(row)); } catch { /* 审计失败不阻断主流程，但下面会提示 */ }
      rows.push({ id: task.id, action: purge ? 'purged' : 'cancelled', fromStatus, toStatus: row.toStatus });
    }
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'task_reap', project: b.project, target: '', note: `filter=${filter || '-'} ids=${ids.join(',') || '-'} ${purge ? 'purge' : 'cancel'} ${rows.length}` });
    const changed = rows.filter((r) => r.action !== 'noop').length;
    const lines = rows.map((r) => '- ' + r.id + '：' + r.fromStatus + ' → ' + r.toStatus + '（' + r.action + '）').join('\n');
    const summary = 'task reap（' + b.project + '）' + (purge ? '物理删除' : '逻辑删除') + '：处理 ' + rows.length + '，变化 ' + changed + '，NOOP ' + (rows.length - changed);
    out(args, summary + '\n' + lines, { ok: true, rows, auditFile: auditPath });
    return;
  }
  if (sub === 'show') {
    // B-20261116-092803-8181：本分支原来直接 JSON.stringify(task)，但该作用域里没有 task → 恒抛 INTERNAL。
    // AC2：先按 id 加载；缺 id 给 BAD_ID，任务不存在由 loadTask 抛 TASK_NOT_FOUND（明确码，不是 INTERNAL）。
    const taskId = String(args.id || args._[2] || '').trim();
    if (!taskId) fail('BAD_ID', 'task show 需要 --id <任务id>（例：task show --project P --boot T --id T-2026...）', { usage: 'task show --id <任务id>' });
    const task = loadTask(b.project, taskId);
    // AC1：--json 时 stdout 恰好一行 JSON（不夹日志、不 pretty），与 req audit 同口径；非 json 走格式化文本。
    if (args.json) process.stdout.write(JSON.stringify({ ok: true, task }) + '\n');
    else textOut(JSON.stringify(task, null, 2));
    return;
  }
  // R-b645 回填（M-20261114-031603-947c03）：按现有任务重算需求应到 dev_done/test_done。
  // 幂等：已到位就什么都不写；推进走同一个 advanceRequirementAfterTaskDone（不碰工作流.json 手改）。
  // 另外把「需求任务本身」的 status 回填成目标状态——旧数据里它一直停在 open，
  // 导致 req list/面板看起来像“没推进”，其实工作流行已经是 dev_done。
  if (sub === 'recompute-advance') {
    const wanted = String(args.requirement || '').split(',').map((s) => s.trim()).filter(Boolean);
    const allTasks = listTasks(b.project);
    const reqIds = wanted.length
      ? wanted
      : allTasks.filter((row) => row && row.type === 'requirement').map((row) => String(row.id));
    const rows = [];
    for (const requirementId of reqIds) {
      const reqTask = (() => { try { return loadTask(b.project, requirementId); } catch { return null; } })();
      if (!reqTask || reqTask.type !== 'requirement') {
        rows.push({ requirement: requirementId, before: '', after: '', basis: '', changed: false, skipped: 'NOT_A_REQUIREMENT' });
        continue;
      }
      const beforeRow = String((workflowRowFor(b.project, requirementId) || {}).status || '');
      const beforeTaskStatus = String(reqTask.status || '');
      const kids = allTasks.filter((row) => row && ['task', 'bug'].includes(String(row.type || '')) && String(row.requirementId || '') === requirementId);
      const isTestTask = (row) => String(row.owner || '') === 'tester' || String((row.workflow && row.workflow.stage) || '') === 'test';
      const isDevTaskRow = (row) => ['programmer1', 'programmer2'].includes(String(row.owner || '')) || String((row.workflow && row.workflow.stage) || '') === 'dev';
      // 触发器选择按需求阶段来（2026-11-14 阻塞修复）：还在开发阶段（含 legacy approved）时优先用“开发任务 done”，
      // 否则测试任务 done 会被选中、而测试推进只认 dev_done/test 阶段，导致 approved 历史需求永远推不动。
      const currentStage = String((workflowRowFor(b.project, requirementId) || {}).status || beforeRow || '');
      const devStage = ['approved', 'ready', 'dispatched', 'dev', 'dev_review', 'iteration'].includes(currentStage);
      // 按轮次挑：需求有 round 时，优先当前轮的任务（旧轮已 done 的任务不能当本轮触发器）。
      const reqRound = Number((workflowRowFor(b.project, requirementId) || {}).round || 0);
      const roundOf = (row) => {
        const wf = row.workflow || {};
        if (wf.round !== undefined && wf.round !== null && wf.round !== '') return Number(wf.round);
        if (wf.iterationRound !== undefined && wf.iterationRound !== null && wf.iterationRound !== '') return Number(wf.iterationRound);
        return null;
      };
      const sameRound = reqRound > 0 ? kids.filter((row) => roundOf(row) === null || roundOf(row) === reqRound) : kids;
      const pick = (list, pred) => list.find((row) => row.status === 'done' && pred(row)) || null;
      const devPool = sameRound.length ? sameRound : kids;
      const trigger = devStage
        ? (pick(devPool, (row) => isDevTaskRow(row))
          || pick(devPool, (row) => !isTestTask(row))
          || pick(devPool, () => true)
          || pick(kids, (row) => isDevTaskRow(row))
          || pick(kids, () => true))
        : (pick(devPool, (row) => isTestTask(row)) || pick(devPool, () => true) || pick(kids, () => true));
      let advance = null;
      // 受控校准入口：--allow-unowned-open 时把“无 owner 的历史 open 任务”排除出阻塞清单（事件里记被忽略的任务）。
      const ignoreUnowned = Boolean(args['allow-unowned-open']);
      const ignoredUnowned = ignoreUnowned
        ? kids.filter((row) => row && !String(row.owner || '').trim() && String(row.status || '') !== 'done').map((row) => String(row.id))
        : [];
      if (trigger) {
        try { advance = advanceRequirementAfterTaskDone(b.project, trigger, b.role, { ignoreUnowned }); } catch { advance = null; }
        if (ignoreUnowned) {
          try {
            appendEvent({
              role: b.role, sessionId: b.sessionId, action: 'requirement_advance_recompute', project: b.project,
              target: requirementId, note: `allow-unowned-open ignored=${ignoredUnowned.join(',') || '-'}`,
              data: { requirementId, ignoredUnowned, trigger: trigger.id },
            });
          } catch { /* 留痕失败不阻断 */ }
        }
      }
      const afterRow = String((workflowRowFor(b.project, requirementId) || {}).status || beforeRow);
      // 需求任务自身的 status 回填（只在目标比当前靠后时写，且不改 open→accepted 这类终态语义）
      let taskStatusFilled = false;
      if (['dev_done', 'test_done'].includes(afterRow) && statusRank(beforeTaskStatus) < statusRank(afterRow)) {
        try {
          const fresh = loadTask(b.project, requirementId);
          fresh.status = afterRow;
          fresh.updatedAt = nowIso();
          fresh.history = Array.isArray(fresh.history) ? fresh.history : [];
          fresh.history.push({ ts: nowIso(), by: b.role, action: 'recompute_advance', note: `按任务重算回填 status=${afterRow}（依据 ${trigger ? trigger.id : '无'}）` });
          saveTask(b.project, fresh);
          taskStatusFilled = true;
        } catch { taskStatusFilled = false; }
      }
      rows.push({
        requirement: requirementId,
        before: beforeRow,
        beforeTaskStatus,
        after: afterRow,
        basis: trigger ? trigger.id : '',
        changed: beforeRow !== afterRow || taskStatusFilled,
        advanced: Boolean(advance && advance.status),
        skipped: advance ? '' : 'NO_ADVANCE',
      });
    }
    const human = [`需求推进重算（${b.project}）：${rows.length} 条`, '', ...rows.map((row) => `${row.requirement}｜${row.before || '(空)'} → ${row.after || '(空)'}｜依据 ${row.basis || '无'}${row.advanced ? '' : '（未推进）'}${row.changed ? '' : '（无变化）'}`)].join('\n');
    out(args, human, { ok: true, project: b.project, rows, changed: rows.filter((row) => row.changed).length });
    return;
  }
  // R-b5fc F-4：缺陷旁路——测试打回 B-* 时 reopenCount+1（history 记 reopen），reopenCount≥2 交给路由守护升级 PM。
  // 只改缺陷任务自己的计数与状态，不碰需求状态机（bug 有独立任务）。
  if (sub === 'confirm-scenario') {
    // R-43ad F-43ad-4：产品（full）/ 分析师（fast）确认「是不是场景缺陷」；确认不是 → 改判 bug（场景字段保留）。
    if (!args.id) fail('BAD_ID', '需要 --id');
    if (!['product', 'analyst', 'pm'].includes(String(b.role))) {
      fail('NOT_CONFIRMER', '只有产品设计师 / 需求分析师（PM 兜底）能确认场景缺陷', { role: b.role });
    }
    const task = loadTask(b.project, String(args.id));
    if (String(task.type || '') !== 'scenario-bug') {
      fail('NOT_SCENARIO_BUG', `${task.id} 不是场景缺陷（type=${task.type}）`, { id: task.id, type: task.type });
    }
    const verdict = String(args.verdict || '').trim().toLowerCase();
    if (!['yes', 'no'].includes(verdict)) fail('BAD_VERDICT', '--verdict 只支持 yes（是场景缺陷）/ no（不是）', { verdict });
    const reason = truncate(String(args.reason || ''), 300);
    const at = nowIso();
    const mode = projectTeamMode(loadProject(b.project));
    task.scenarioConfirm = {
      ...(task.scenarioConfirm || {}),
      status: verdict === 'yes' ? 'confirmed' : 'rejected',
      by: b.role, at, reason,
      confirmer: scenarioConfirmerFor(mode),
      treatAs: verdict === 'yes' ? '' : 'bug',
      ...(verdict === 'no' ? { reclassifiedAt: at } : {}),
    };
    const reclassified = verdict === 'no';
    if (reclassified) task.type = 'bug';   // type 与 bugClass 并存，场景字段原样保留
    task.updatedAt = at;
    task._by = b.role;
    task._action = reclassified ? 'scenario_rejected' : 'scenario_confirmed';
    task._note = truncate(reason || (verdict === 'yes' ? '确认是场景缺陷' : '确认不是场景缺陷，改判 bug'), 200);
    const saved = saveTask(b.project, task);
    appendEvent({
      role: b.role, sessionId: b.sessionId, action: reclassified ? 'scenario_rejected' : 'scenario_confirmed',
      project: b.project, target: saved.id,
      note: truncate(`verdict=${verdict} ${reason}`, 160),
      data: { taskId: saved.id, verdict, reclassified, type: saved.type, scenarioConfirm: saved.scenarioConfirm },
    });
    out(args, [
      `${saved.id} 场景确认：${verdict === 'yes' ? '是场景缺陷（保持 scenario-bug）' : `不是 → 已改判 bug（原因：${reason || '未写'}）`}`,
      `确认人：${b.role} ｜ 时间：${at}`,
    ].join('\n'), { ok: true, task: saved, verdict, reclassified, type: saved.type, scenarioConfirm: saved.scenarioConfirm });
    return;
  }
  if (sub === 'scenario-sweep') {
    // R-43ad F-43ad-4：场景确认超时扫描（守护/PM 都可调）——到点按 bug 先行 + PM 收 SCENARIO_CONFIRM_TIMEOUT 告警。
    const mode = projectTeamMode(loadProject(b.project));
    const now = Date.now();
    const summary = { scanned: 0, timedOut: [], escalated: [], timeoutMs: scenarioTimeoutMs() };
    for (const task of listTasks(b.project)) {
      if (!task || String(task.type || '') !== 'scenario-bug') continue;
      const state = scenarioConfirmState(task, { mode, env: process.env });
      if (!state.pending) continue;
      summary.scanned += 1;
      if (!state.timedOut) continue;
      const applied = applyScenarioTimeout(task, { mode, env: process.env });
      if (!applied.changed) continue;
      const next = applied.task;
      if (!next.scenarioConfirm.escalatedAt) {
        try {
          sendMessage({
            from: 'system', to: 'pm', type: 'escalation', project: b.project,
            subject: `场景确认超时：${next.id}（按 bug 先行）`,
            body: clipMessage(`任务 ${next.id} 的场景确认已超时（${state.timeoutMs}ms，确认人 ${state.confirmer}）。\n按口径先按 bug 推进，不卡开发。\ncode=SCENARIO_CONFIRM_TIMEOUT\n开单时间：${state.requestedAt}\n截止：${state.dueAt}`),
          });
          next.scenarioConfirm.escalatedAt = nowIso();
          summary.escalated.push(next.id);
        } catch { /* 告警发不出去不阻断按 bug 先行 */ }
      }
      next.updatedAt = nowIso();
      next._by = b.role;
      next._action = 'scenario_timeout';
      next._note = '场景确认超时，按 bug 先行';
      saveTask(b.project, next);
      appendEvent({
        role: b.role, sessionId: b.sessionId, action: 'scenario_confirm_timeout', project: b.project, target: next.id,
        note: `code=SCENARIO_CONFIRM_TIMEOUT timeoutMs=${state.timeoutMs}`,
        data: { taskId: next.id, code: 'SCENARIO_CONFIRM_TIMEOUT', timeoutMs: state.timeoutMs, confirmer: state.confirmer },
      });
      summary.timedOut.push(next.id);
    }
    out(args, [
      `场景确认超时扫描：检查 ${summary.scanned} 条在等确认，超时 ${summary.timedOut.length} 条（timeoutMs=${summary.timeoutMs}）`,
      ...(summary.timedOut.length ? [`已按 bug 先行：${summary.timedOut.join(', ')}`] : []),
      ...(summary.escalated.length ? [`已告警 PM（SCENARIO_CONFIRM_TIMEOUT）：${summary.escalated.join(', ')}`] : []),
    ].join('\n'), { ok: true, ...summary });
    return;
  }
  if (sub === 'reopen') {
    if (!args.id) fail('BAD_ID', '需要 --id');
    if (!['tester', 'pm'].includes(b.role)) fail('NOT_OWNER', '只有测试人员（或 PM 兜底）能打回缺陷任务');
    const task = loadTask(b.project, String(args.id));
    if (!String(task.id).startsWith('B-')) fail('NOT_BUG_TASK', `只有 B-* 缺陷任务能 reopen：${task.id}`);
    const reason = truncate(String(args.reason || '').trim(), 300);
    const reopenCount = Number(task.reopenCount || 0) + 1;
    task.reopenCount = reopenCount;
    task.status = task.owner ? 'working' : 'open';
    task.doneAt = null;
    task.evidence = '';
    task._by = b.role;
    task._action = 'reopen';
    task._note = `第 ${reopenCount} 次打回${reason ? '：' + reason : ''}`;
    const saved = saveTask(b.project, task);
    appendEvent({
      role: b.role, sessionId: b.sessionId, action: 'task_reopen', project: b.project, target: saved.id,
      note: `reopenCount=${reopenCount} ${reason}`.slice(0, 200),
    });
    if (saved.owner) {
      notify({
        from: b.role, to: saved.owner, subject: `缺陷打回 ${saved.id}（第 ${reopenCount} 次）`,
        body: clipMessage(`${saved.title}\n打回原因：${reason || '（未写）'}\n修完直接回测试（task done），无需等 PM 中转。`),
        project: b.project, task: saved.id, ackRequired: true, sessionId: b.sessionId,
      });
    }
    out(args, `已打回 ${saved.id}（第 ${reopenCount} 次）→ ${saved.owner || '待认领'}${reopenCount >= 2 ? '；已达升级阈值，路由守护会通知 PM' : ''}`,
      { ok: true, task: saved, reopenCount, escalated: reopenCount >= 2 });
    return;
  }
  if (sub === 'claim') {
    if (!args.id) fail('BAD_ID', '需要 --id');
    const task = claimTask(b.project, String(args.id), b.role, b.sessionId);
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'task_claim', project: b.project, target: task.id, note: task.title });
    notify({ from: b.role, to: 'pm', subject: `已认领 ${task.id}`, body: `${task.title}\n预计按 ${task.priority} 推进。`, project: b.project, task: task.id, ackRequired: false, sessionId: b.sessionId });
    out(args, `已认领 ${task.id}：${task.title}`, { ok: true, task });
    return;
  }
  if (sub === 'done') {
    if (!args.id) fail('BAD_ID', '需要 --id');
    if (!args.evidence) fail('EVIDENCE_REQUIRED', '完成任务必须带 --evidence（提交号/路径/验证输出）');
    // G7：测试任务 done 前要有测试报告；auto 模式没有报告只留痕，有报告则校验覆盖与 PASS/FAIL。
    const preTask = loadTask(b.project, String(args.id));
    if (preTask.status === 'done') fail('TASK_DONE', `任务已完成：${preTask.id}`);
    // G9 证据门（T-20261113-063141-70a9）：--evidence 必须能落到真实文件（存在/非空/mtime 在任务开始后），
    // 代码路径额外比对工作树 sha256 与声明；失败码 EVIDENCE_FILE_MISSING / EVIDENCE_STALE / EVIDENCE_HASH_MISMATCH。
    const evidenceProject = loadProject(b.project);
    const evidenceGate = checkEvidenceGate({
      projectPath: evidenceProject.path,
      task: preTask,
      evidence: String(args.evidence),
      commits: (() => { try { return listCommits(b.project); } catch { return []; } })(),
    });
    const isTestTask = String(preTask.owner || '') === 'tester'
      || String((preTask.workflow && preTask.workflow.stage) || '') === 'test';
    if (isTestTask && preTask.requirementId) {
      let projectObj = null;
      try { projectObj = loadProject(b.project); } catch { projectObj = null; }
      if (projectObj) {
        const g7 = gateTestReport({ projectPath: projectObj.path, task: preTask, requirementId: String(preTask.requirementId) });
        if (g7) {
          const record = { role: b.role, action: 'test_exec', requirementId: String(preTask.requirementId), taskId: preTask.id, attempted: 'task done' };
          // AC14.5：默认硬门；只有工作台 Electron 自测沙盘（A 的夹具尚未生成测试报告）按 soft 留痕。
          const hard = gateConfig(projectObj).testReport === 'hard' && !inElectronSelftestSandbox();
          if (hard) gateFail(b.project, record, g7);
          gateWarn(b.project, record, g7);
        }
      }
    }
    // R-8514：P0 任务 done 前必须有 project 记忆（任务 id + 产出路径 + 1–2 行进展）；
    // 缺失 → MEMORY_MISSING 拒绝完成；非 P0 只告警；记忆库不可读降级 unknown，不默认通过。
    let memoryGate = null;
    try {
      const projectObjForMemory = loadProject(b.project);
      memoryGate = memoryCheck({
        projectPath: projectObjForMemory.path,
        taskId: String(preTask.id),
        role: String(b.role || ''),
        required: String(preTask.priority || '') === 'P0',
      });
      if (memoryGate.required && !memoryGate.found) {
        // 沙盘夹具任务没有记忆库：TEAM_SELFTEST=1 默认只告警；专门用例用 TEAM_MEMORY_ENFORCE=1 验证强卡。
        const enforce = process.env.TEAM_MEMORY_ENFORCE === '1';
        const loose = process.env.TEAM_SELFTEST === '1' && !enforce;
        // R-8b9d：记忆插件关闭时不做硬失败，降级为 MEMORY_SKIPPED（核心流程可跑，给清晰提示）。
        // 显式的 TEAM_MEMORY_ENFORCE=1 优先于插件探测（沙盘强卡用例）；生产不设该变量。
        let memPlugin = 'on';
        try {
          const probe = optionalPluginMarks();
          memPlugin = String((probe.summary && probe.summary.memory) || 'off');
        } catch { memPlugin = 'off'; }
        if (enforce) {
          fail('MEMORY_MISSING', `P0 任务 ${preTask.id} 缺少 project 记忆：先写 1 条（任务 id + 产出路径 + 1–2 行进展）再 task done`, { memory: memoryGate });
        } else if (memPlugin !== 'on') {
          memoryGate.code = 'MEMORY_SKIPPED';
          memoryGate.degraded = true;
          memoryGate.memoryPlugin = memPlugin;
          memoryGate.why = `记忆插件未启用（memory:${memPlugin}）：P0 记忆门降级为 MEMORY_SKIPPED，不阻断完成；启用 dsh-memory-evolve 后恢复强校验（见 docs/可选插件.md）`;
        } else if (loose) {
          memoryGate.code = 'MEMORY_SELFTEST_SKIP';
        } else {
          fail('MEMORY_MISSING', `P0 任务 ${preTask.id} 缺少 project 记忆：先写 1 条（任务 id + 产出路径 + 1–2 行进展）再 task done`, { memory: memoryGate });
        }
      }
    } catch (e) {
      if (e && (e.code === 'MEMORY_MISSING' || e instanceof TeamError)) throw e;
      memoryGate = { ok: true, code: 'MEMORY_UNKNOWN', readable: false, why: String((e && e.message) || e) };
    }
    // R-d225 AC3：测试任务 done 时落 acceptanceRecord.testReportGeneratedAt（报告文件 mtime，ISO8601 UTC）。
    // 只有「报告生成时间 > 需求返工时间」才算本轮；旧报告保留但不计入（跳过推进，留审计）。
    let testReportMeta = null;
    if (isTestTask && preTask.requirementId) {
      try {
        const projObj = loadProject(b.project);
        const outDir = path.join(projObj.path, '测试人员', '产出');
        let newest = null;
        for (const name of fs.readdirSync(outDir)) {
          if (!/^测试报告-v\d+\.md$/.test(name)) continue;
          const file = path.join(outDir, name);
          const st = fs.statSync(file);
          if (!newest || st.mtimeMs > newest.mtimeMs) newest = { file, name, mtimeMs: st.mtimeMs };
        }
        if (newest) {
          const wfNow = readWorkflowState(b.project, { fresh: true }).state || {};
          const reqRow = (wfNow.requirements || {})[preTask.requirementId] || {};
          const reopenedAt = String(reqRow.lastReopenAt || reqRow.gateInvalidatedAt || '');
          const testReportGeneratedAt = new Date(newest.mtimeMs).toISOString();
          const stale = Boolean(reopenedAt) && Date.parse(testReportGeneratedAt) <= Date.parse(reopenedAt);
          testReportMeta = {
            testReport: path.relative(projObj.path, newest.file).replace(/\\/g, '/'),
            testReportGeneratedAt, reopenedAt, stale,
          };
        }
      } catch { testReportMeta = null; }
    }
    const task = finishTask(b.project, String(args.id), b.role, args.evidence, args.note || '', {
      evidenceFiles: evidenceGate.files,
      checkedAt: evidenceGate.checkedAt,
      skipped: Boolean(evidenceGate.skipped),
    });
    // B-384e：任务完成即释放与它绑定的派单锁（不必等回执），并记事件。
    const releasedLock = releaseDispatchLockForTask(b.project, task.id, { source: 'task_done' });
    // R-d225 AC3：报告时间落任务行 acceptanceRecord；旧报告（早于返工）不计本轮、不推进需求。
    if (isTestTask && testReportMeta) {
      task.acceptanceRecord = { ...(task.acceptanceRecord || {}), status: 'done', by: b.role, channel: 'task_done', at: nowIso(), ...testReportMeta };
      task.updatedAt = nowIso();
      saveTask(b.project, task);
    }
    const requirementAdvance = (!testReportMeta || !testReportMeta.stale) ? advanceRequirementAfterTaskDone(b.project, task, b.role) : null;
    if (testReportMeta && testReportMeta.stale) {
      appendEvent({
        role: b.role, sessionId: b.sessionId, action: 'requirement_advance_skipped', project: b.project, target: task.requirementId,
        note: `旧测试报告不计本轮：generatedAt=${testReportMeta.testReportGeneratedAt} ≤ reopenedAt=${testReportMeta.reopenedAt}`,
        data: { taskId: task.id, requirementId: task.requirementId, testReport: testReportMeta.testReport, testReportGeneratedAt: testReportMeta.testReportGeneratedAt, reopenedAt: testReportMeta.reopenedAt },
      });
    }
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'task_done', project: b.project, target: task.id, note: truncate(String(args.evidence), 120), data: { evidence: task.evidence } });
    // B-6818（T0）：完成事件自动唤醒收件人（通常是 PM），不等 PM 轮询；30 秒去抖，失败写 唤醒.jsonl。
    // B-cef3：createdBy 可能不是团队成员（route-daemon / system / 历史角色名）——
    // 直接拿它当收件人会 NO_RECIPIENT，且异常在落库之后抛出 → 表现为「假失败」。
    // 收件人解析：system / 空 / 非本团队成员 → 统一回退 pm（AC1/AC3）。
    const doneWarnings = [];
    let memberRoles = new Set();
    try { memberRoles = new Set(activeMembers(loadTeam()).map((member) => String(member.role || ''))); } catch { memberRoles = new Set(); }
    const createdByRole = String(task.createdBy || '').trim();
    const doneTo = (!createdByRole || createdByRole === 'system' || !memberRoles.has(createdByRole)) ? 'pm' : createdByRole;
    if (createdByRole && createdByRole !== 'system' && createdByRole !== doneTo) {
      doneWarnings.push({ code: 'RECEIPT_RECIPIENT_FALLBACK', message: `createdBy=${createdByRole} 不是团队成员，完成回执回退给 pm`, to: doneTo });
    }
    let doneMsg = null;
    try {
      doneMsg = notify({ from: b.role, to: doneTo, subject: `完成回执 ${task.id}`, body: clipMessage(`${task.title}\n证据：${task.evidence}`), project: b.project, task: task.id, ackRequired: true, type: 'receipt', sessionId: b.sessionId });
    } catch (e) {
      // AC2：通知失败只记 warnings，不影响 task done 的 ok 与退出码（任务/需求已落库）。
      doneWarnings.push({ code: (e && e.code) || 'RECEIPT_NOTIFY_FAILED', message: String((e && e.message) || e).slice(0, 200), to: doneTo });
    }
    let doneWake = null;
    if (doneMsg) {
      try {
        doneWake = await wakeWithGuard({ project: b.project, to: doneTo, msg: doneMsg, isDispatch: false, reason: `task_done:${task.id}`, dedupeKey: `task_done:${task.id}` });
      } catch (e) {
        doneWarnings.push({ code: (e && e.code) || 'RECEIPT_WAKE_FAILED', message: String((e && e.message) || e).slice(0, 200), to: doneTo });
      }
    }
    // R-31b3：完成当前任务后自动续跑同角色的派单队列（避免角色空闲、排队任务还 working）。
    const dispatchQueue = await pumpDispatchQueue(b.project, { role: String(task.owner || b.role) });
    // R-99ff ③：本角色没泵出去时，再兜底泵一次“队列里任意已空闲角色”的一项，
    // 避免角色完成后仍要 PM 人工逐条泵；失败只留痕（dispatch_queue_blocked），不改队列内容。
    let tailPump = null;
    if (!dispatchQueue.pumped) {
      try { tailPump = await pumpDispatchQueue(b.project, { role: '' }); } catch (e) { tailPump = { ok: false, why: String((e && e.message) || e) }; }
    }
    const queueHint = dispatchQueue && dispatchQueue.pumped
      ? `\n队列续跑：已派 ${dispatchQueue.message.id} → ${dispatchQueue.item.to}（task ${dispatchQueue.item.task || '-'}）`
      : (tailPump && tailPump.pumped
        ? `\n队列兜底续跑：已派 ${tailPump.message.id} → ${tailPump.item.to}（task ${tailPump.item.task || '-'}）`
        : (dispatchQueue && dispatchQueue.blocked ? `\n队列保留：${dispatchQueue.reason}` : ''));
    // R-2e6b：轮次 +1（同任务重复 done 只计 1），达 N=10 自动归档并归零。
    let roundInfo = null;
    try {
      roundInfo = bumpRound(b.project, String(task.owner || b.role), task.id);
      if (roundInfo && roundInfo.archived === 'triggered') {
        const arch = archiveSession({ projectName: b.project, role: String(task.owner || b.role), reason: `阶段达 ${ROUNDS_MAX} 自动归档`, auto: true, operator: 'system' });
        roundInfo.archive = arch.record.id;
      }
    } catch (e) { roundInfo = { error: String((e && e.message) || e) }; }
    const roundHint = roundInfo && !roundInfo.error
      ? `\n阶段：${roundInfo.rounds}/${ROUNDS_MAX}${roundInfo.archived === 'triggered' ? `（已自动归档 ${roundInfo.archive || ''}）` : ''}`
      : '';
    const memoryHint = memoryGate && memoryGate.code === 'MEMORY_ABSENT_WARN'
      ? `\n提醒：项目记忆里没有 ${task.id} 的条目（非 P0 不阻断，下一次补写）`
      : (memoryGate && memoryGate.code === 'MEMORY_UNKNOWN' ? '\n记忆核查不可用（unknown，按告警处理）'
        : (memoryGate && memoryGate.code === 'MEMORY_SKIPPED' ? `\n记忆降级：${memoryGate.why}` : ''));
    const wakeHint = doneWake && doneWake.ok === false
      ? `\n完成事件唤醒失败：${String(doneWake.why || doneWake.code || '').slice(0, 120)}（已写 唤醒.jsonl）`
      : (doneWake && doneWake.skipped === 'DEBOUNCED' ? `\n完成事件唤醒已去抖（30 秒内已提示过 ${doneTo}）` : '');
    const warningHint = doneWarnings.length
      ? `\n完成回执警告：${doneWarnings.map((row) => `${row.code}${row.to ? '@' + row.to : ''}`).join('，')}（任务与需求已落库，不影响完成）`
      : '';
    const lockHint = releasedLock ? `\n派单锁已释放：${releasedLock.messageId}（task ${task.id}，不再挡下一个派单）` : '';
    const evidenceHint = evidenceGate && !evidenceGate.skipped
      ? `\n证据门：已核 ${evidenceGate.files.length} 个证据文件（sha256 已记入任务）`
      : (evidenceGate && evidenceGate.skipped ? '\n证据门：沙盘跳过（TEAM_SELFTEST=1）' : '');
    out(args, `已完成 ${task.id}，证据：${task.evidence}${evidenceHint}${requirementAdvance ? `\n需求状态：${requirementAdvance.previous} → ${requirementAdvance.status}（phase=${requirementAdvance.phase}）` : ''}${queueHint}${roundHint}${memoryHint}${wakeHint}${warningHint}${lockHint}`, { ok: true, task, evidenceGate, requirementAdvance, dispatchQueue, tailPump, roundInfo, memory: memoryGate, wake: doneWake, warnings: doneWarnings, receiptTo: doneTo, releasedLock });
    return;
  }
  if (sub === 'priority') {
    if (b.role !== 'pm' && b.role !== 'product') fail('NOT_PM', '只有 PM / 产品能改优先级');
    if (!args.id || !args.priority) fail('BAD_ARGS', '需要 --id 和 --priority');
    const task = setTaskPriority(b.project, String(args.id), String(args.priority), b.role, args.reason || '');
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'task_priority', project: b.project, target: task.id, note: `${task.priority} ${args.reason || ''}` });
    out(args, `优先级已改：${task.id} → ${task.priority}`, { ok: true, task });
    return;
  }
  if (sub === 'release') {
    if (!args.id) fail('BAD_ID', '需要 --id');
    const task = loadTask(b.project, String(args.id));
    if (b.role !== 'pm' && task.owner !== b.role) fail('NOT_OWNER', '只有 owner 或 PM 能释放');
    task.owner = null; task.status = 'open';
    task._by = b.role; task._action = 'release'; task._note = args.reason || '';
    saveTask(b.project, task);
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'task_release', project: b.project, target: task.id, note: args.reason || '' });
    out(args, `已释放 ${task.id}`, { ok: true, task });
    return;
  }
  fail('BAD_SUBCOMMAND', `未知 task 子命令：${sub}`);
}

/**
 * memory check（R-8514）：只读核查 project 记忆（<DSH_HOME>/memories/projects/<workspace-key>/MEMORY.md）。
 * 用法：memory check --task <T> [--role <R>] [--json] [--required]
 * P0 任务缺失 → MEMORY_MISSING 且 exit 1；非 P0 缺失 → MEMORY_ABSENT_WARN（exit 0）。
 */
export function cmdMemory(args) {
  const sub = String((args._ && args._[1]) || 'check').toLowerCase();
  if (sub !== 'check') fail('BAD_SUBCOMMAND', 'memory 只支持 check');
  // 复核-v4 P1-1：--role 是「被抽检角色」、--project 是「抽检项目」，不是身份声明；
  // 只校验令牌本身（有效期/规则哈希），否则 PM/测试无法用一条令牌跨角色抽检（BOOT_ROLE_MISMATCH）。
  const b = tokenOf(args);
  const projectName = String(args.project || b.project);
  const project = loadProject(projectName);
  const roleId = String(args.role || '');
  const roleIds = projectRoleIds(project);
  if (roleId && !roleIds.includes(roleId)) {
    fail('BAD_ROLE', `--role ${roleId} 不在项目角色集内（${roleIds.join(' / ')}）；角色覆盖按精确匹配判定`);
  }
  const taskId = String(args.task || '');
  let required = Boolean(args.required);
  if (taskId) {
    try {
      const task = loadTask(projectName, taskId);
      if (String(task.priority || '') === 'P0') required = true;
    } catch { /* 任务不存在：按 --required 参数判定 */ }
  }
  const result = memoryCheck({ projectPath: project.path, taskId, role: roleId, required });
  // R-8b9d off 侧整改（T-20261114-035413-2148）：记忆插件关闭时 --required 不许再报 MEMORY_MISSING，
  // 改成 required=false + degraded=true + code=MEMORY_SKIPPED，只告警不阻断（插件是可选的）。
  let memoryPlugin = { id: 'memory-evolve', status: 'off', version: '', source: 'detect' };
  try {
    const probe = optionalPluginMarks();
    const rows = (probe.result && Array.isArray(probe.result.plugins)) ? probe.result.plugins : [];
    const row = rows.find((item) => item && item.mode === 'memory') || null;
    memoryPlugin = {
      id: (row && row.id) || 'memory-evolve',
      status: String((probe.summary && probe.summary.memory) || (row && row.status) || 'off'),
      version: String((row && row.version) || ''),
      source: (probe.result && probe.result.root) || '',
    };
  } catch (error) {
    memoryPlugin = { id: 'memory-evolve', status: 'off', version: '', source: '', why: String((error && error.message) || error).slice(0, 120) };
  }
  const pluginOff = memoryPlugin.status !== 'on';
  if (pluginOff) {
    result.required = false;
    result.degraded = true;
    result.code = 'MEMORY_SKIPPED';
    result.memoryPlugin = memoryPlugin;
    result.why = `记忆插件未启用（memory:${memoryPlugin.status}）：required 降级为 false，只告警不阻断（启用后恢复强校验，见 docs/可选插件.md）`;
    result.missing = [...(result.missing || []).filter((line) => !/^记忆库不可读/.test(String(line))), result.why];
  } else {
    result.memoryPlugin = memoryPlugin;
  }
  // R-8b9d：lint 只警告不阻断；--strict 才把警告升级为失败（exit 1 + LINT_WARNINGS）。
  const lint = result.lint || { ok: true, warnings: [], rules: {} };
  const strict = Boolean(args.strict);
  result.strict = strict;
  if (strict && lint.warnings.length) result.code = 'LINT_WARNINGS';
  if (args.json) jsonOut(result);
  else {
    const lines = [
      `记忆核查 · ${result.project}`,
      `任务: ${result.taskId || '（未指定）'} ｜ 角色: ${result.role || '（未指定）'} ｜ 必写: ${result.required ? '是（P0）' : '否'}`,
      `结果: ${result.found ? '✅ 命中' : '❌ 缺失'} ｜ 记忆库: ${result.store.memory}${result.readable ? '' : '（不可读）'}`,
      `记忆插件: ${memoryPlugin.status}${memoryPlugin.version ? ' v' + memoryPlugin.version : ''}${result.degraded ? '（已降级：required=false，不阻断）' : ''}`,
    ];
    if (result.missing.length) lines.push(`缺项: ${result.missing.join('；')}`);
    for (const e of result.entries.slice(0, 5)) lines.push(`  - [${e.hash}] ${e.line.slice(0, 140)}`);
    if (lint.warnings.length) {
      lines.push(`lint（警告级${strict ? '；--strict 已开，本次按失败' : '，不阻断；加 --strict 才失败'}）：${lint.warnings.length} 条（条目≤${lint.rules.maxEntryChars} 字、同任务≤${lint.rules.maxTaskRepeat} 次）`);
      for (const w of lint.warnings.slice(0, 5)) lines.push(`  - ${w.message}`);
    }
    textOut(lines.join('\n'));
  }
  if ((result.required && !result.found) || (strict && lint.warnings.length)) process.exitCode = 1;
  return result;
}

// ========== 需求看板 / 先索引后找文件 ==========

/**
 * R-d225 正式返工入口：`req reopen --project P --requirement R --reason "…"`。
 * dev_done/test_done → dev；deliveryRound+1；写 gateInvalidatedAt/By 与 trq.verdictStale；
 * test_done 时把 done 的 tester 任务回 open 并置新轮；只追加不抹除历史；3 秒内重复点击幂等。
 */
function cmdReqReopen(args) {
  const b = bootFor(args, 'req');
  const projectName = String(args.project || b.project);
  // R-d225 AC4：返工只允许 PM / Owner；需求分析等其他角色一律 PERMISSION_DENIED（零副作用）。
  if (!['pm', 'owner'].includes(String(b.role))) {
    fail('PERMISSION_DENIED', '只有 PM / Owner 能发起需求返工（其他角色一律拒绝）', { role: b.role });
  }
  const requirementId = String(args.requirement || '').trim();
  const reason = String(args.reason || '').trim();
  if (!requirementId) fail('BAD_ARGS', '需要 --requirement R-...');
  if (!reason) fail('REASON_REQUIRED', '返工必须带 --reason（为什么返工），空原因零副作用拒收', { requirementId });
  const stateRead = readWorkflowState(projectName, { fresh: true });
  const wf = stateRead.state || {};
  const requirements = wf.requirements || {};
  const row = requirements[requirementId]
    || Object.values(requirements).find((r) => r && String(r.id || '') === requirementId)
    || null;
  if (!row) {
    let reqTask = null;
    try { reqTask = loadTask(projectName, requirementId); } catch { reqTask = null; }
    if (!reqTask) fail('REQUIREMENT_NOT_FOUND', `需求不存在：${requirementId}`, { requirementId });
    const fromStatus0 = String((reqTask.workflow && reqTask.workflow.requirementStatus) || '');
    // R-d225 AC4：rejected 走 iterate；accepted/terminated 是终态，给专属错误码。
    if (fromStatus0 === 'rejected') {
      fail('REOPEN_USE_ITERATE', `需求 ${requirementId} 当前状态 rejected：返工请走迭代入口（req iterate），reopen 不适用`, { requirementId, status: fromStatus0 });
    }
    if (['accepted', 'terminated'].includes(fromStatus0)) {
      fail('REQUIREMENT_CLOSED', `需求 ${requirementId} 已收口（${fromStatus0}）：终态不得 reopen，要改须另立新需求`, { requirementId, status: fromStatus0 });
    }
    if (!['dev_done', 'test_done'].includes(fromStatus0)) {
      fail('REOPEN_NOT_APPLICABLE', `需求 ${requirementId} 当前状态 ${fromStatus0 || '(空)'} 不适用返工（只支持 dev_done/test_done）`, { requirementId, status: fromStatus0 });
    }
  }
  const fromStatus = String((row && row.status) || '');
  // B-2ae4 / b28f：被误推到 accepted 的行（没有 accept 决定）也需要一条合规恢复命令，不能手改 JSON。
  // 只认显式 --recover-mispushed，且必须"没有任何 accepted 决策"才放行；正常验收过的行仍然拒。
  const acceptedDecisions = (Array.isArray(row.decisions) ? row.decisions : [])
    .filter((d) => d && ['accepted', 'accept'].includes(String(d.status || d.decision || '')));
  const recoverAccepted = fromStatus === 'accepted'
    && Boolean(args['recover-mispushed'])
    && acceptedDecisions.length === 0;
  // R-d225 AC4：rejected → REOPEN_USE_ITERATE；accepted/terminated → REQUIREMENT_CLOSED（都零副作用）。
  if (fromStatus === 'rejected') {
    fail('REOPEN_USE_ITERATE', `需求 ${requirementId} 当前状态 rejected：返工请走迭代入口（req iterate），reopen 不适用`, { requirementId, status: fromStatus });
  }
  if (fromStatus === 'accepted' && !recoverAccepted) {
    fail('REQUIREMENT_CLOSED', `需求 ${requirementId} 已收口（accepted）：终态不得 reopen，要改须另立新需求；若是误推且无 accept 决定，用 --recover-mispushed 恢复`, {
      requirementId, status: fromStatus, acceptedDecisions: acceptedDecisions.length,
    });
  }
  if (fromStatus === 'terminated') {
    fail('REQUIREMENT_CLOSED', `需求 ${requirementId} 已收口（terminated）：终态不得 reopen，要改须另立新需求`, { requirementId, status: fromStatus });
  }
  if (!['dev_done', 'test_done'].includes(fromStatus) && !recoverAccepted) {
    fail('REOPEN_NOT_APPLICABLE', `需求 ${requirementId} 当前状态 ${fromStatus || '(空)'} 不适用返工（只支持 dev_done/test_done）`, {
      requirementId, status: fromStatus, allowed: ['dev_done', 'test_done'],
    });
  }
  // F-reopen-6：3 秒内重复命令视为同一次（幂等，不重复计数）。
  const lastReopenMs = Date.parse(String(row.lastReopenAt || ''));
  if (Number.isFinite(lastReopenMs) && Date.now() - lastReopenMs < 3000) {
    out(args, `返工幂等（3 秒内重复）：${requirementId} 已在当前`, {
      ok: true, idempotent: true, requirementId, deliveryRound: Number(row.deliveryRound || 1), fromStatus,
    });
    return;
  }
  const at = nowIso();
  const prevRound = Number(row.deliveryRound ?? 1) || 1;
  const nextRound = prevRound + 1;
  row.deliveryRound = nextRound;
  row.gateInvalidatedAt = at;
  row.gateInvalidatedBy = 'reopen';
  row.status = 'dev';
  if (row.phase) row.phase = 'dev';
  row.reopenCount = Number(row.reopenCount || 0) + 1;
  row.lastReopenAt = at;
  if (row.trq && typeof row.trq === 'object') row.trq = { ...row.trq, verdictStale: true };
  // test_done 返工：done 的 tester 任务回 open 并置新轮（旧报告不算本轮）。
  const reopenedTasks = [];
  if (fromStatus === 'test_done') {
    for (const t of listTasks(projectName)) {
      if (String(t.requirementId || '') !== requirementId) continue;
      if (String(t.owner || '') !== 'tester' || String(t.status || '') !== 'done') continue;
      t.status = 'open';
      t.doneAt = null;
      t.workflow = { ...(t.workflow || {}), round: nextRound };
      t.reopenedBy = b.role;
      t.reopenedAt = at;
      saveTask(projectName, t);
      reopenedTasks.push(t.id);
    }
  }
  let reqTask = null;
  try { reqTask = loadTask(projectName, requirementId); } catch { reqTask = null; }
  // R-9fbe：历史数据/夹具里可能只有工作流行、没有 任务/R-*.json；旧实现拿 null 直接进
  // syncWorkflowRow → INTERNAL(Cannot read properties of null)，把「正式返工」这条处置入口堵死。
  // 这里按最小字段补一条需求任务文件（不写假结论，只承载 workflow 元数据），再走原逻辑。
  if (!reqTask) {
    reqTask = {
      id: requirementId, project: projectName, type: 'requirement', requirementId: '',
      title: truncate(String(row.title || requirementId), 120),
      detail: '需求行存在但缺需求任务文件：req reopen 时补齐（R-9fbe）',
      acceptance: '', story: '', priority: String(row.priority || 'P2'), priorityBy: b.role, priorityReason: '',
      owner: null, status: 'open', createdBy: b.role, createdAt: at, claimedAt: null, due: '',
      doneAt: null, evidence: '', rev: 0, history: [], workflow: {},
    };
    reqTask._by = b.role;
    reqTask._action = 'req_reopen_stub';
    reqTask._note = truncate(reason, 200);
    saveTask(projectName, reqTask);
  }
  if (reqTask) {
    reqTask.workflow = { ...(reqTask.workflow || {}), requirementStatus: 'dev', deliveryRound: nextRound, gateInvalidatedAt: at };
    reqTask.updatedAt = at;
    reqTask._by = b.role;
    reqTask._action = 'req_reopen';
    reqTask._note = reason;
    saveTask(projectName, reqTask);
  }
  const sync = syncWorkflowRow(projectName, reqTask, 'dev', {
    reviewedAt: reqTask && reqTask.workflow && reqTask.workflow.reviewedAt,
    reviewedBy: reqTask && reqTask.workflow && reqTask.workflow.reviewedBy,
    reviewRole: reqTask && reqTask.workflow && reqTask.workflow.reviewRole,
    teamMode: reqTask && reqTask.workflow && reqTask.workflow.teamMode,
  }, { create: true, action: 'req_reopen', by: b.role, note: reason, phase: 'dev' });
  if (sync && sync.state && sync.state.requirements) {
    const r2 = sync.state.requirements[requirementId] || Object.values(sync.state.requirements).find((r) => r && String(r.id || '') === requirementId);
    if (r2) {
      r2.deliveryRound = nextRound;
      r2.gateInvalidatedAt = at;
      r2.gateInvalidatedBy = 'reopen';
      r2.reopenCount = row.reopenCount;
      r2.lastReopenAt = at;
      if (r2.trq && typeof r2.trq === 'object') r2.trq = { ...r2.trq, verdictStale: true };
      writeWorkflowState(projectName, sync.state);
    }
  }
  appendEvent({
    role: b.role, sessionId: b.sessionId, action: 'requirement_reopened', project: projectName,
    target: requirementId, note: truncate(reason, 160),
    data: { requirementId, role: b.role, reason, count: row.reopenCount, at, fromStatus, toStatus: 'dev', deliveryRound: nextRound, reopenedTasks },
  });
  // B-2ae4：误推 accepted 的恢复必须单独留痕（审计里能查「谁把哪条从假收口拉回来、依据是什么」）。
  if (recoverAccepted) {
    appendEvent({
      role: b.role, sessionId: b.sessionId, action: 'requirement_recovery_mispushed_accepted', project: projectName,
      target: requirementId, note: `accepted → dev（无 accept 决定，--recover-mispushed）`,
      data: {
        requirementId, role: b.role, reason, at, priorStatus: 'accepted',
        acceptedDecisions: acceptedDecisions.length, decisions: (Array.isArray(row.decisions) ? row.decisions : []).length,
        deliveryRound: nextRound,
      },
    });
  }
  out(args, [
    `已返工 ${requirementId}：${fromStatus} → dev（当前，第 ${row.reopenCount} 次返工）`,
    `原因：${reason}`,
    `门禁失效标记：gateInvalidatedAt=${at}；TR-Q 旧结论标 stale`,
    ...(reopenedTasks.length ? [`测试任务回 open：${reopenedTasks.join(', ')}`] : []),
    `工作流：${sync && sync.file ? sync.file : ''}`,
  ].join('\n'), {
    ok: true, requirementId, fromStatus, toStatus: 'dev', deliveryRound: nextRound,
    reopenCount: row.reopenCount, gateInvalidatedAt: at, reopenedTasks, workflowFile: sync && sync.file,
  });
}

/**
 * B-2ae4：只读巡检「被误推到 accepted、但没有任何 accept 决定」的需求行。
 * 不改任何状态；恢复入口固定为 `req reopen --recover-mispushed`（同一处审计，不手改 JSON）。
 */
function cmdReqMispushed(args) {
  const b = bootFor(args, 'req mispushed');
  const projectName = String(args.project || b.project);
  const read = readWorkflowState(projectName);
  const rows = Object.values((read.state && read.state.requirements) || {});
  const hits = [];
  for (const row of rows) {
    if (!row || String(row.status || '') !== 'accepted') continue;
    const acceptedDecisions = (Array.isArray(row.decisions) ? row.decisions : [])
      .filter((d) => d && ['accepted', 'accept'].includes(String(d.status || d.decision || '')));
    if (acceptedDecisions.length) continue;
    const id = String(row.id || '');
    hits.push({
      requirementId: id,
      title: String(row.title || ''),
      decisions: (Array.isArray(row.decisions) ? row.decisions : []).length,
      ownerAcceptance: row.ownerAcceptance || null,
      recovery: `team.mjs req reopen --boot <PM令牌> --project "${projectName}" --requirement ${id} --reason "误推 accepted 恢复（无 accept 决定）" --recover-mispushed`,
    });
  }
  const lines = [`疑似误推 accepted：${hits.length} 条（判据＝status=accepted 且 decisions 里无 accept/accepted）`];
  for (const hit of hits) {
    lines.push(`- ${hit.requirementId} ${hit.title}`);
    lines.push(`  恢复：${hit.recovery}`);
  }
  if (!hits.length) lines.push('（无：所有 accepted 行都有 accept 决定）');
  out(args, lines.join('\n'), { ok: true, project: projectName, file: read.file, count: hits.length, hits, readOnly: true });
}

/** 需求行定位：完整 id 精确优先 → 唯一兼容匹配（同秒撞号时取 Object.values 里 id 全等的那条）。 */
function findRequirementRow(rows, id) {  const table = rows && typeof rows === 'object' ? rows : {};
  const key = String(id || '').trim();
  if (!key) return null;
  if (table[key]) return table[key];
  return Object.values(table).find((r) => r && String(r.id || '') === key) || null;
}

/**
 * B-a17d AC2：批量入口解析。支持三种写法（可混用，按 id 去重）：
 *   --id R-…           单条（老写法，兼容）
 *   --ids "a,b,c"      逗号 / 中文逗号 / 顿号 / 空白分隔
 *   --from-file <file> 每行一个 JSON（{id|requirementId,title,acceptance,priority,reason}）或纯 id
 * 返回 [{id, title, acceptance, priority, reason, source}]
 */
function collectReqSpecs(args) {
  const specs = [];
  const seen = new Set();
  const add = (raw) => {
    if (!raw || typeof raw !== 'object') return;
    const id = String(raw.id || raw.requirementId || raw.requirement || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    specs.push({
      id,
      title: String(raw.title || '').trim(),
      acceptance: String(raw.acceptance || '').trim(),
      priority: String(raw.priority || '').trim(),
      reason: String(raw.reason || '').trim(),
      source: String(raw.source || 'arg'),
    });
  };
  if (args.id) add({ id: args.id });
  if (args.ids) String(args.ids).split(/[,，、;；\s]+/).forEach((id) => add({ id }));
  if (args['from-file']) {
    const file = path.resolve(String(args['from-file']));
    if (!exists(file)) fail('BAD_ID', `--from-file 文件不存在：${file}`, { file });
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('{')) {
        try { add({ ...JSON.parse(line), source: 'file' }); continue; } catch { /* 坏行按纯 id 处理 */ }
      }
      add({ id: line, source: 'file' });
    }
  }
  return specs;
}

/**
 * B-155a：把「只在工作台本地缓存里、工作流没有」的幽灵需求登记进工作流（可评审/派单）。
 * 幂等：已在工作流 → ALREADY_REGISTERED（零副作用）。
 * B-a17d AC2：支持 --ids / --from-file 批量（一条命令处理多条）。
 */
function cmdReqRegister(args) {
  const b = bootFor(args, 'req');
  if (!['pm', 'analyst', 'product'].includes(String(b.role))) {
    fail('PERMISSION_DENIED', '只有 PM / 需求分析 / 产品能登记幽灵需求', { role: b.role });
  }
  const specs = collectReqSpecs(args);
  if (!specs.length) fail('BAD_ID', '需要 --id R-... / --ids a,b / --from-file <文件>');
  if (specs.length > 1) return cmdReqRegisterBatch(args, b, specs);
  const id = specs[0].id;
  if (!/^R-\d{8}-\d{6}-[0-9a-f]{4}$/.test(id)) fail('BAD_ID', '需求 id 形态应为 R-YYYYMMDD-HHMMSS-xxxx', { id });
  const registered = registerOneRequirement(args, b, {
    ...specs[0],
    title: String(args.title || specs[0].title || ''),
    acceptance: String(args.acceptance || specs[0].acceptance || ''),
    priority: String(args.priority || specs[0].priority || ''),
  });
  out(args, `已登记幽灵需求 ${id}（${registered.title}）→ 工作流 status=review\n工作流：${registered.workflowFile || ''}`, registered);
  return null;
}

/** 批量登记：逐条 registerOneRequirement，汇总结果；部分失败不中断。 */
function cmdReqRegisterBatch(args, b, specs) {
  const results = [];
  for (const spec of specs) {
    if (!/^R-\d{8}-\d{6}-[0-9a-f]{4}$/.test(spec.id)) { results.push({ id: spec.id, ok: false, code: 'BAD_ID' }); continue; }
    try { results.push(registerOneRequirement({ json: false }, b, spec)); } catch (e) {
      results.push({ id: spec.id, ok: false, code: e instanceof TeamError ? e.code : 'INTERNAL', message: String((e && e.message) || e) });
    }
  }
  const failed = results.filter((r) => !r.ok && r.code !== 'ALREADY_REGISTERED');
  const okCount = results.length - failed.length;
  if (failed.length) process.exitCode = 1;
  out(args, [
    `批量登记：成功 ${okCount} / ${results.length}，失败 ${failed.length}`,
    ...results.map((r) => `- ${r.id} ${r.ok ? `OK status=${r.status}` : (r.code === 'ALREADY_REGISTERED' ? '已登记（幂等）' : `FAIL ${r.code}`)}`),
  ].join('\n'), { ok: failed.length === 0, batch: true, total: results.length, okCount, failed: failed.length, results });
  return null;
}

/** 单条登记实现（单条模式与批量模式共用）。 */
function registerOneRequirement(args, b, spec) {
  const id = String(spec.id || '').trim();
  if (!id) fail('BAD_ID', '需要 --id R-...');
  if (!/^R-\d{8}-\d{6}-[0-9a-f]{4}$/.test(id)) fail('BAD_ID', '需求 id 形态应为 R-YYYYMMDD-HHMMSS-xxxx', { id });
  const stateRead = readWorkflowState(b.project, { fresh: true });
  const wf = stateRead.state || {};
  const rows = wf.requirements || {};
  const existing = rows[id] || Object.values(rows).find((r) => r && String(r.id || '') === id);
  if (existing) fail('ALREADY_REGISTERED', `需求已在工作流：${id}（status=${existing.status || '?'}）`, { requirementId: id, status: existing.status });
  const title = String(spec.title || args.title || '').trim() || id;
  const at = nowIso();
  let task = null;
  try { task = loadTask(b.project, id); } catch { task = null; }
  if (!task) {
    task = {
      id, project: b.project, type: 'requirement', requirementId: '',
      title: truncate(title, 120), detail: truncate(String(args.detail || '从工作台本地缓存登记（无需求正文）'), 1000),
      acceptance: truncate(String(spec.acceptance || args.acceptance || ''), 1000), story: '',
      priority: String(spec.priority || args.priority || 'P2'), priorityBy: b.role, priorityReason: '',
      owner: null, status: 'open', createdBy: b.role, createdAt: at, claimedAt: null, due: '',
      doneAt: null, evidence: '', rev: 0,
      history: [],
      workflow: { requirementStatus: 'review', registeredFrom: 'cache', registeredAt: at, registeredBy: b.role },
    };
    task._by = b.role; task._action = 'req_register'; task._note = '从本地缓存登记';
    saveTask(b.project, task);
  }
  const sync = syncWorkflowRow(b.project, task, 'review', {
    teamMode: task.workflow && task.workflow.teamMode,
  }, { create: true, action: 'req_register', by: b.role, note: '从本地缓存登记（幽灵需求）', phase: 'review' });
  appendEvent({
    role: b.role, sessionId: b.sessionId, action: 'requirement_registered', project: b.project,
    target: id, note: truncate(title, 120), data: { requirementId: id, from: 'cache', workflowFile: sync && sync.file },
  });
  return { ok: true, requirementId: id, title, status: 'review', workflowFile: sync && sync.file };
}

/**
 * B-155a / B-a17d：把幽灵需求作废。
 *   - 作废登记落 <项目根>/需求/作废登记.jsonl（带 project 字段，AC5）；
 *   - 有工作流行 → status=terminated + gateInvalidatedBy=ghost_void；
 *   - 无工作流行 → 只登记；同时把同 id 的需求任务文件收口（否则快照会把它造回 review）；
 *   - 幂等：工作行已 terminated/accepted 或登记里已有该 id → ALREADY_VOIDED（零副作用）；
 *   - 批量：--ids / --from-file（AC2，一条命令处理多条）。
 */
function cmdReqVoid(args) {
  const b = bootFor(args, 'req');
  if (!['pm', 'analyst', 'product'].includes(String(b.role))) fail('PERMISSION_DENIED', '只有 PM / 需求分析 / 产品能作废幽灵需求', { role: b.role });
  const specs = collectReqSpecs(args);
  if (!specs.length) fail('BAD_ID', '需要 --id R-... / --ids a,b / --from-file <文件>');
  const baseReason = String(args.reason || '').trim();
  if (!baseReason && !specs.some((spec) => spec.reason)) {
    fail('REASON_REQUIRED', '作废必须带 --reason（为什么作废）', { requirementId: specs[0].id });
  }
  const batch = specs.length > 1 || !args.id;
  const project = loadProject(b.project);
  const projectDir = String(project.path || '');
  const registryFile = voidRegistryFile(projectDir);
  const stateRead = readWorkflowState(b.project, { fresh: true });
  const rows = (stateRead.state && stateRead.state.requirements) || {};
  const known = readVoidRegistry(projectDir);
  const results = [];
  let workflowDirty = false;
  for (const spec of specs) {
    const id = String(spec.id || '').trim();
    const reason = spec.reason || baseReason;
    const at = nowIso();
    const row = findRequirementRow(rows, id);
    if (row && ['terminated', 'accepted'].includes(String(row.status || ''))) {
      results.push({ id, ok: false, code: 'ALREADY_VOIDED', status: String(row.status), hadWorkflowRow: true, registry: registryFile });
      continue;
    }
    if (known.byId[id]) {
      results.push({ id, ok: false, code: 'ALREADY_VOIDED', status: 'voided', hadWorkflowRow: Boolean(row), registry: registryFile });
      continue;
    }
    try {
      appendVoidEntry(projectDir, {
        at, project: b.project, requirementId: id, reason: truncate(reason, 300),
        by: b.role, hadWorkflowRow: Boolean(row), source: 'req_void',
      });
    } catch (e) {
      results.push({ id, ok: false, code: 'REGISTRY_WRITE_FAILED', message: String((e && e.message) || e), registry: registryFile });
      continue;
    }
    known.byId[id] = { id, requirementId: id, at, project: b.project, reason, by: b.role, hadWorkflowRow: Boolean(row) };
    if (row) {
      row.status = 'terminated';
      row.gateInvalidatedAt = at;
      row.gateInvalidatedBy = 'ghost_void';
      row.voidReason = truncate(reason, 300);
      row.voidRegistry = registryFile;
      workflowDirty = true;
    }
    // 任务文件收口：不管有没有工作流行都写，避免「作废了但任务文件又把同 id 造回 review」。
    try {
      const task = loadTask(b.project, id);
      task.status = 'done';
      task.doneAt = at;
      task.workflow = {
        ...(task.workflow || {}),
        requirementStatus: 'terminated',
        voided: true,
        voidedAt: at,
        voidReason: truncate(reason, 200),
      };
      task._by = b.role; task._action = 'req_void'; task._note = truncate(reason, 200);
      saveTask(b.project, task);
    } catch { /* 没有任务文件也能作废（快照靠作废登记剔除） */ }
    appendEvent({
      role: b.role, sessionId: b.sessionId, action: 'requirement_voided', project: b.project,
      target: id, note: truncate(reason, 120),
      data: { requirementId: id, hadWorkflowRow: Boolean(row), registry: registryFile, project: b.project, batch: Boolean(batch) },
    });
    results.push({ id, ok: true, code: 'OK', status: row ? 'terminated' : 'voided', hadWorkflowRow: Boolean(row), registry: registryFile });
  }
  if (workflowDirty) writeWorkflowState(b.project, stateRead.state);
  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok && r.code !== 'ALREADY_VOIDED');
  const first = results[0] || {};
  if (!batch) {
    if (!first.ok) {
      if (first.code === 'ALREADY_VOIDED') {
        fail('ALREADY_VOIDED', `需求已作废/已是终态：${first.id}`, { requirementId: first.id, status: first.status, registry: registryFile });
      }
      fail(first.code || 'VOID_FAILED', `作废失败：${first.id}`, { requirementId: first.id, registry: registryFile, message: first.message });
    }
    out(args, `已作废 ${first.id}（${first.status === 'terminated' ? '工作流置 terminated' : '仅登记作废（工作流无此行）'}）\n原因：${truncate(specs[0].reason || baseReason, 300)}\n登记：${registryFile}`, {
      ok: true, requirementId: first.id, status: first.status, registry: registryFile, hadWorkflowRow: first.hadWorkflowRow, results,
    });
    return;
  }
  if (failed.length) process.exitCode = 1;
  out(args, [
    `批量作废：成功 ${succeeded.length} / ${results.length}，失败 ${failed.length}`,
    ...results.map((r) => `- ${r.id} ${r.ok ? `OK status=${r.status}` : (r.code === 'ALREADY_VOIDED' ? '已作废（幂等）' : `FAIL ${r.code}`)}`),
    `登记：${registryFile}`,
  ].join('\n'), {
    ok: failed.length === 0, batch: true, total: results.length, okCount: succeeded.length,
    failed: failed.length, registry: registryFile, results,
  });
}

/** R-9a8e F-rv-3（AC3/AC3b）：stale 需求清单——谁需要重评、卡在哪道门、为什么。 */
function cmdReqStale(args) {
  const b = bootFor(args, 'req');
  const project = loadProject(b.project);
  const projectPath = String(project.path || '');
  const stateRead = readWorkflowState(b.project, { fresh: true });
  const rows = (stateRead.state && stateRead.state.requirements) || {};
  const stale = [];
  const consistent = [];
  const neverReviewed = [];
  for (const [key, row] of Object.entries(rows)) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id || key);
    const status = String(row.status || '');
    if (['accepted', 'done', 'terminated', 'iteration', 'rejected'].includes(status)) continue;
    const doc = readRequirementDocVersion(projectPath, id);
    const review = row.productReview || row.requirementReview || null;
    const reopenedAt = String(row.lastReopenAt || row.gateInvalidatedAt || '');
    const reviewAt = String((review && (review.ts || review.at)) || '');
    if (!review) { neverReviewed.push({ requirementId: id, status }); continue; }
    // 原因优先级（需求正文写死）：reopened > review_stale > trq_missing > owner_gate
    const reasons = [];
    if (reopenedAt && (!reviewAt || Date.parse(reopenedAt) > Date.parse(reviewAt))) reasons.push('reopened');
    const ver = versionGate({ records: [review], current: { hash: doc.hash, version: doc.version, change: doc.change }, gate: 'G2' });
    if (ver) reasons.push('review_stale');
    const trqVerdict = String((row.trq && row.trq.verdict) || '');
    if (String(row.priority || 'P2') === 'P0' && trqVerdict !== 'testable') reasons.push('trq_missing');
    const decisions = decisionListOf(row);
    const last = decisions.length ? decisions[decisions.length - 1] : null;
    const lastStatus = String((last && (last.status || last.decision)) || '');
    if (!['approved', 'skipped', 'accepted'].includes(lastStatus)) reasons.push('owner_gate');
    if (!reasons.length) { consistent.push({ requirementId: id, status, version: doc.version || 'v1(legacy)' }); continue; }
    const reason = reasons[0];
    const gate = reason === 'trq_missing' ? 'TRQ' : (reason === 'owner_gate' ? 'G3_OWNER' : 'G2_REVIEW');
    stale.push({
      requirementId: id, title: truncate(String(row.title || ''), 40), status, reason, reasons, gate,
      currentVersion: doc.version || 'v1(legacy)', change: doc.change || '',
      recordedVersion: String(review.version || ''), reviewAt,
      recordedHash: String(review.requirementHash || '').slice(0, 12), currentHash: String(doc.hash || '').slice(0, 12),
      reopenedAt,
      ...(ver ? { staleCode: String(ver.code || ''), staleMessage: String(ver.message || '') } : {}),
    });
  }
  // 只有任务文件、工作流还没有行的需求：也要在「从未评审」里露出来（AC3 的 neverReviewed 口径）。
  const knownIds = new Set(Object.keys(rows));
  for (const task of listTasks(b.project)) {
    if (!task || String(task.type || '') !== 'requirement') continue;
    const id = String(task.id || '');
    if (!id || knownIds.has(id)) continue;
    if (neverReviewed.some((row) => row.requirementId === id)) continue;
    neverReviewed.push({ requirementId: id, status: String(task.status || ''), noWorkflowRow: true });
  }
  stale.sort((a, c) => String(a.requirementId).localeCompare(String(c.requirementId)));
  out(args, [
    `stale 需求：${stale.length} 条（已一致 ${consistent.length}，从未评审 ${neverReviewed.length}）`,
    ...stale.map((row) => `- ${row.requirementId} ｜ ${row.reason} ｜ 卡门 ${row.gate} ｜ 当前 ${row.currentVersion}${row.change ? `（${row.change}）` : ''}`),
    ...(neverReviewed.length ? [`从未评审：${neverReviewed.map((row) => row.requirementId).join(', ')}`] : []),
  ].join('\n'), {
    ok: true, project: b.project, workflow: stateRead.file || '',
    stale, consistent, neverReviewed,
    counts: { stale: stale.length, consistent: consistent.length, neverReviewed: neverReviewed.length },
    reasons: { reopened: stale.filter((row) => row.reason === 'reopened').length, review_stale: stale.filter((row) => row.reason === 'review_stale').length, trq_missing: stale.filter((row) => row.reason === 'trq_missing').length, owner_gate: stale.filter((row) => row.reason === 'owner_gate').length },
  });
}

/**
 * B-a17d：读作废登记（消费方先看这里，不必自己解析 jsonl）。
 */
function cmdReqVoided(args) {
  const b = bootFor(args, 'req');
  const project = loadProject(b.project);
  const reg = readVoidRegistry(String(project.path || ''));
  out(args, [
    `作废登记：${reg.file}`,
    `存在：${reg.exists ? '是' : '否'} ｜ 条数：${reg.count}`,
    ...reg.entries.map((e) => `- ${e.id} ｜ ${e.at || '(无时间)'} ｜ ${e.by || '-'} ｜ ${truncate(e.reason, 60)}`),
  ].join('\n'), {
    ok: true, project: b.project, registry: reg.file, exists: reg.exists, count: reg.count,
    entries: reg.entries, ids: reg.ids, errors: reg.errors,
  });
}

/**
 * B-a17d AC3：双向同步断言（工作流 ↔ 需求任务文件 ↔ 作废登记）。
 * 违规即 exit 1；无违规返回 ok=true。测试与 PM 巡检共用这一条口径。
 */
function cmdReqSync(args) {
  const b = bootFor(args, 'req');
  const project = loadProject(b.project);
  const projectDir = String(project.path || '');
  const registry = readVoidRegistry(projectDir);
  const legacy = legacyVoidRegistryFile(PATHS.teamRoot);
  const stateRead = readWorkflowState(b.project, { fresh: true });
  const rows = (stateRead.state && stateRead.state.requirements) || {};
  const violations = [];
  const warnings = [];
  if (fs.existsSync(legacy)) {
    violations.push({ rule: 'R0_LEGACY_REGISTRY_ROOT', file: legacy, message: '作废登记还在仓库根（跨项目共用、污染 git status），应迁到项目根 需求/作废登记.jsonl' });
  }
  for (const entry of registry.entries) {
    if (!entry.project) violations.push({ rule: 'R1_REGISTRY_PROJECT_MISSING', id: entry.id, message: '作废登记行缺 project 字段（跨项目无法区分）' });
    else if (String(entry.project) !== String(b.project)) violations.push({ rule: 'R2_REGISTRY_PROJECT_MISMATCH', id: entry.id, project: entry.project, message: '作废登记行属于别的项目' });
    const row = findRequirementRow(rows, entry.id);
    if (row && !['terminated', 'accepted'].includes(String(row.status || ''))) {
      violations.push({ rule: 'R3_VOID_ROW_NOT_TERMINATED', id: entry.id, status: row.status, message: '已作废但工作流行不是 terminated（快照可能仍当它待评审）' });
    }
    try {
      const task = loadTask(b.project, entry.id);
      const voidedInTask = Boolean(task.workflow && task.workflow.voided);
      if (String(task.status || '') !== 'done' || !voidedInTask) {
        violations.push({ rule: 'R4_VOID_TASK_NOT_CLOSED', id: entry.id, taskStatus: task.status, voided: voidedInTask, message: '已作废但需求任务文件没收口（会被快照造回 review）' });
      }
    } catch { /* 没任务文件不是违规 */ }
  }
  // 反向：工作流里没有行的需求（幽灵）必须有出路 —— 已登记的不算，剩余应出现在作废登记里；
  // 这里只核对「任务文件里 type=requirement 且不在工作流」的那批，正文类旧文档不阻断。
  const ghosts = [];
  for (const task of listTasks(b.project)) {
    if (!task || task.type !== 'requirement') continue;
    const id = String(task.id || '');
    if (!id) continue;
    if (findRequirementRow(rows, id)) continue;
    if (registry.byId[id]) continue;
    ghosts.push({ id, title: truncate(task.title, 60), status: String(task.status || '') });
  }
  if (ghosts.length) {
    warnings.push({ rule: 'W1_UNREGISTERED_GHOSTS', count: ghosts.length, ids: ghosts.slice(0, 20).map((g) => g.id), message: '任务文件有、工作流没有、也没作废：面板会显示为需求（未登记标记），需登记或作废' });
  }
  if (registry.errors && registry.errors.length) {
    violations.push({ rule: 'R5_REGISTRY_BAD_LINES', count: registry.errors.length, sample: registry.errors.slice(0, 3), message: '作废登记有坏行' });
  }
  // R6（R-9fbe AC3）：账本分叉——作废登记三向没违规 ≠ 账本一致。
  // 判据在 lib/ledger.mjs（带「重开时间」维度：taskDoneAt < reopenedAt 视为返工在途，不是分叉）。
  const tasksAll = listTasks(b.project);
  const ledger = detectLedgerForks({ requirements: rows, tasks: tasksAll });
  for (const fork of ledger.forks) {
    violations.push({
      rule: 'R6_LEDGER_FORK',
      id: fork.requirementId,
      requirementId: fork.requirementId,
      kind: fork.kind,
      status: fork.status,
      taskId: fork.taskId,
      taskDoneAt: fork.taskDoneAt,
      reopenedAt: fork.reopenedAt,
      message: `需求 ${fork.requirementId}（${fork.status}）的任务账本已完工，工作流没往前走（${fork.kind}）`,
    });
  }
  if (ledger.inFlight.length) {
    warnings.push({
      rule: 'W2_REWORK_IN_FLIGHT',
      count: ledger.inFlight.length,
      items: ledger.inFlight.slice(0, 20),
      message: '有需求在返工在途/任务在办（不是分叉）；面板显示「返工在途」即可，别当分叉处置',
    });
  }
  const payload = {
    ok: violations.length === 0,
    project: b.project,
    projectDir,
    registry: registry.file,
    registryExists: registry.exists,
    registryCount: registry.count,
    registryIds: registry.ids,
    workflowRows: Object.keys(rows).length,
    violations,
    warnings,
    ghosts,
    // R-9fbe：账本分叉只在这里算一次（工具侧唯一口径），壳层/面板按同口径取。
    ledger: { forks: ledger.forks, inFlight: ledger.inFlight, summary: ledger.summary },
  };
  if (violations.length) process.exitCode = 1;
  out(args, [
    `同步检查：${violations.length ? `FAIL（${violations.length} 条违规）` : 'PASS（0 违规）'}`,
    `作废登记：${registry.file}（${registry.exists ? `${registry.count} 条` : '不存在'}）`,
    ...violations.map((v) => `- [${v.rule}] ${v.id || v.file || ''} ${v.message}`),
    ...warnings.map((w) => `- 提醒 [${w.rule}] ${w.count} 条：${w.message}`),
  ].join('\n'), payload);
}

/**
 * T-20261117-184114-4358（R-bcae）第二步：skill 子命令。
 *   skill status [--json]                 看本人最近一次 skill 评估与是否到点（30 分钟）
 *   skill skip --reason "…"               跳过本次提示（reason 必填，append-only 落 skill评估.jsonl）
 *   skill check --file <路径> [--json]     四要素校验（缺项拒收，exit 1）
 */
export function cmdSkill(args) {
  const b = bootFor(args, 'skill');
  const sub = String(args._[1] || 'status');
  if (sub === 'status') {
    const rows = readSkillEvaluations(b.project).filter((r) => String(r.role || '') === b.role);
    const last = rows.length ? rows[rows.length - 1] : null;
    const due = skillPromptDue(b.project, b.role);
    const payload = { ok: true, role: b.role, lastEval: last, due: due.due, dueReason: due.reason, lastAt: due.lastAt, dueInMs: due.dueInMs, total: rows.length };
    out(args, last
      ? `skill 评估：最近一次 ${last.at}（${last.action}${last.reason ? '：' + last.reason : ''}）；${due.due ? '已到 30 分钟，应提示创建/更新' : '未到 30 分钟'}`
      : 'skill 评估：从未记录（首次提示会写一条 prompt）', payload);
    return;
  }
  if (sub === 'skip') {
    const reason = String(args.reason || '').trim();
    if (reason.length < 2) fail('SKILL_SKIP_REASON_REQUIRED', '跳过 skill 提示必须写 --reason（写进 skill评估.jsonl）', {}, 1);
    const row = recordSkillEvaluation(b.project, b.role, { action: 'skip', reason });
    out(args, `已跳过本次 skill 提示（reason=${reason}）`, { ok: true, row });
    return;
  }
  if (sub === 'check') {
    const file = String(args.file || '').trim();
    if (!file) fail('BAD_FILE', '需要 --file <skill 文件路径>', {}, 1);
    const project = loadProject(b.project);
    const abs = path.isAbsolute(file) ? file : path.join(project.path, file);
    if (!exists(abs)) fail('SKILL_FILE_MISSING', `skill 文件不存在：${file}`, { file }, 1);
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { fail('SKILL_FILE_UNREADABLE', `读不了 skill 文件：${(e && e.message) || e}`, { file }, 1); }
    const result = validateSkillContent(text);
    const payload = { ok: result.ok, file, missing: result.missing, elements: ['会重复发生', '明确步骤', '可验证判据', '出错代价高'] };
    if (!result.ok) {
      fail('SKILL_FORMAT_INCOMPLETE', `skill 缺四要素：${result.missing.map((m) => `${m.label}（${m.why}）`).join('；')}；小问题可改记经验教训`, payload, 1);
    }
    out(args, `skill 四要素齐全：${file}`, payload);
    return;
  }
  fail('BAD_ACTION', `skill 只支持 status | skip | check（收到：${sub}）`, {}, 1);
}

/**
 * T-20261117-211833-7a30（R-a4c7）：调度建议（只读）——`team.mjs sched advice [--json] [--rotate-rounds N]`。
 * 三源：会话排队.json（插件快照）/ 会话轮次.json / 任务清单 + role_queues；聚合走纯函数 sched-advice.mjs。
 * 只追加写 项目/<项目>/调度建议.jsonl（append-only）；不派单、不换人、不改任何状态。
 */
export function cmdSched(args) {
  const b = bootFor(args, 'sched');
  const sub = String(args._[1] || 'advice');
  if (sub !== 'advice') fail('BAD_ACTION', `sched 只支持 advice（收到：${sub}）`, {}, 1);
  const project = loadProject(b.project);
  const dir = projectStatePaths(b.project).dir;
  const queueFile = path.join(PATHS.state, '会话排队.json');
  const queueRaw = exists(queueFile) ? readJson(queueFile, null) : null;
  const queue = (() => {
    if (!queueRaw || String(queueRaw.project || '') !== b.project) return null;
    const rolesMap = {};
    for (const row of (Array.isArray(queueRaw.roles) ? queueRaw.roles : [])) {
      if (!row || !row.role) continue;
      rolesMap[String(row.role)] = {
        state: String(row.state || (row.known ? 'ok' : 'unknown')),
        queued: Number(row.queued || 0), running: row.state === 'running',
        lastAt: String(row.lastAt || row.lastOkAt || ''), stale: Boolean(row.stale),
      };
    }
    return { at: String(queueRaw.at || ''), degraded: queueRaw.degraded ? String(queueRaw.degraded) : '', roles: rolesMap };
  })();
  const roundsRaw = readJson(path.join(dir, '会话轮次.json'), null);
  const usageRaw = readJson(path.join(dir, '会话用量.json'), null);
  const usage = usageRaw && typeof usageRaw === 'object' ? usageRaw : null;
  const taskDir = path.join(dir, '任务');
  const taskSourceAvailable = exists(taskDir);
  const tasks = taskSourceAvailable
    ? fs.readdirSync(taskDir).filter((n) => n.endsWith('.json')).map((n) => readJson(path.join(taskDir, n), null)).filter(Boolean)
    : [];
  const roleQueues = readJson(path.join(dir, 'role_queues.json'), null);
  const rotateRounds = Number(args['rotate-rounds'] || 0) > 0 ? Number(args['rotate-rounds']) : undefined;
  const advice = buildSchedAdvice({
    now: Date.now(), project: b.project, rotateRounds, queue, rounds: roundsRaw, usage,
    tasks, taskSourceAvailable, roleQueues,
  });
  // append-only 审计（唯一写盘）
  const logFile = path.join(dir, '调度建议.jsonl');
  try {
    fs.appendFileSync(logFile, JSON.stringify({
      at: advice.at, project: b.project, by: b.role,
      roles: advice.roles.map((r) => ({ role: r.role, decision: r.decision, level: r.level, reasons: r.reasons })),
      degraded: advice.degraded,
    }) + '\n', 'utf8');
  } catch { /* 审计失败不阻断建议输出 */ }
  if (args.json) {
    process.stdout.write(JSON.stringify(advice) + '\n');
    return;
  }
  const lines = [`调度建议（${b.project}，${advice.at}）${advice.degraded ? ' ⚠ 快照不新鲜/降级：不出 IDLE_DISPATCH' : ''}`];
  for (const r of advice.roles) lines.push(`- ${r.role}: ${r.decision}（${r.reasons.join('；')}）→ ${r.nextAction}`);
  lines.push('只读建议：不派单、不换人；写盘仅 调度建议.jsonl（append-only）');
  console.log(lines.join('\n'));
}

export function cmdReq(args) {
  const sub = args._[1] || 'list';
  // R-dba4（工具侧，T-20261115-142650-acfe）：需求行「大白话 copy」写入口（与壳层 requirement:copy-save 同判据）
  if (sub === 'copy') return cmdReqCopy(args);
  // 需求评审 / 技术评审记录：fast 由需求分析师评审，full 由产品设计师评审；
  // 技术评审记录在 fast 由程序员A、full 由产品或程序员A记录。PM 不评审。
  if (sub === 'review') return cmdReqReview(args);
  // 可测性评审（TR-Q）：测试人员本人记录；Owner 门（G2.5）读这份证据。
  if (sub === 'trq') return cmdReqTrq(args);
  // 被驳回需求的出口：PM 决定进入下一轮或终止；两者都会同步 工作流.json。
  if (sub === 'iterate' || sub === 'terminate') return cmdReqLifecycle(args, sub);
  // R-d225：正式返工入口（dev_done/test_done → dev，deliveryRound+1，门禁失效标记）。
  if (sub === 'reopen') return cmdReqReopen(args);
  // B-2ae4：只读巡检——被误推到 accepted 但没有任何 accept 决定的需求行（配套恢复：req reopen --recover-mispushed）。
  if (sub === 'mispushed') return cmdReqMispushed(args);
  // B-155a：幽灵需求登记 / 作废（工作流没有但工作台缓存里有）。
  if (sub === 'register') return cmdReqRegister(args);
  if (sub === 'void') return cmdReqVoid(args);
  // B-a17d：作废登记的消费口与双向同步断言（面板/测试都从这里取口径）。
  if (sub === 'voided') return cmdReqVoided(args);
  if (sub === 'sync') return cmdReqSync(args);
  // R-c6dc：唯一写入口 / 审计 / 冻结解冻 / 清锁（共享层：写需求正文只走这条）
  if (sub === 'write') return cmdReqWrite(args);
  if (sub === 'audit') return cmdReqAudit(args);
  if (sub === 'doc') return cmdReqDoc(args);
  if (sub === 'unlock-write') return cmdReqUnlockWrite(args);
  if (sub === 'freeze' || sub === 'unfreeze') return cmdReqFreeze(args, sub);
  if (sub === 'writer') return cmdReqWriter(args);
  // R-9a8e：stale 需求清单（重评成本与信息不对称的出口）。
  if (sub === 'stale') return cmdReqStale(args);
  const b = bootFor(args, 'req');
  if (sub === 'create') {
    if (!['pm', 'product', 'analyst'].includes(b.role)) fail('NOT_PM', '只有 PM / 产品 / 需求分析能建需求');
    // R-51de F-5②：建需求前必须读过当前版本经验教训登记册（Owner 通道豁免）
    failLessonGate(lessonGateFor(b, args));
    const task = createTask({
      project: b.project, title: args.title, detail: args.detail || '', priority: args.priority,
      priorityBy: args['priority-by'] || b.role, createdBy: b.role, owner: args.owner || null, due: args.due || '',
      type: 'requirement', requirementId: '', acceptance: args.acceptance || '', story: args.story || '',
    });
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'req_create', project: b.project, target: task.id, note: `${task.priority} ${task.title}`, data: { task } });
    // R-f9b1 F-11：create 入口——正文已存在才查（新需求正文通常由分析师随后写）。
    const createdProject = loadProject(b.project);
    const docCheck = docSizeGate(createdProject, task.id, { entry: 'create', role: b.role, noSplit: Boolean(args['no-split']) });
    if (docCheck.after.exists && !docCheck.after.whitelisted && docCheck.after.level === 'over') {
      fail('DOC_TOO_LARGE', `需求 ${task.id} 正文 ${docCheck.after.bytes}B 超过 ${DOC_SPLIT_LIMIT} 字节且拆分不足；先拆需求或人工压缩（需求记录已建）`, {
        requirementId: task.id, bytes: docCheck.after.bytes, taskCreated: true,
        split: docCheck.split ? { action: docCheck.split.action, code: docCheck.split.code, afterBytes: docCheck.split.afterBytes } : null,
      }, 1);
    }
    out(args, `已建需求 ${task.id} [${task.priority}] ${task.title}${docCheck.after.exists ? `（正文 ${docCheck.after.bytes}B/${docCheck.after.level}）` : '（正文待写）'}`, {
      ok: true, requirement: task,
      docSplit: docCheck.after.exists ? {
        entry: 'create', beforeBytes: docCheck.before.bytes, afterBytes: docCheck.after.bytes,
        level: docCheck.after.level, whitelisted: docCheck.after.whitelisted,
        action: docCheck.split ? docCheck.split.action : 'skip',
        reason: docCheck.split ? docCheck.split.reason : null,
        warning: docCheck.after.level === 'near' && docCheck.after.bytes > DOC_SPLIT_TARGET ? 'DOC_NEAR_LIMIT' : null,
      } : null,
    });
    return;
  }
  if (sub === 'list') {
    const tasks = listTasks(b.project);
    const reqs = tasks.filter((t) => t.type === 'requirement');
    const children = tasks.filter((t) => t.type !== 'requirement');
    // R-0dbb F7/AC11②：每行带 Owner 意见原文 + 时间——与 req review / 壳层快照同判据（decisions[-1].opinion）。
    const workflowRows = (() => {
      try { return readWorkflowState(b.project).state.requirements || {}; } catch { return {}; }
    })();
    const rows = reqs.map((r) => {
      const kids = children.filter((c) => c.requirementId === r.id);
      const opinion = ownerOpinionDisplayOf(workflowRows[String(r.id)] || (r.workflow && typeof r.workflow === 'object' ? r.workflow : {}));
      // 同时挂回任务对象：payload.requirements 就是这批对象，--json 里逐行可见。
      r.ownerOpinion = opinion.opinion;
      r.ownerOpinionAt = opinion.at;
      r.ownerOpinionSha256 = opinion.sha256;
      return {
        id: r.id, p: r.priority, status: r.status, owner: r.owner || '-', title: r.title,
        review: r.review ? `${r.review.verdict}` : '-',
        tech: r.techReview ? `${r.techReview.verdict}` : '-',
        kids: kids.length, done: kids.filter((k) => k.status === 'done').length, acceptance: r.acceptance || '',
        ownerOpinion: opinion.opinion, ownerOpinionAt: opinion.at,
      };
    });
    out(args, `需求看板（${b.project}，${reqs.length} 条）\n` + table(rows, [
      { key: 'p', label: '优先' }, { key: 'id', label: '需求' }, { key: 'status', label: '状态' }, { key: 'review', label: '需求评审' }, { key: 'tech', label: '技术评审' }, { key: 'owner', label: 'Owner' }, { key: 'title', label: '需求' }, { key: 'kids', label: '子任务' }, { key: 'done', label: '完成' },
    ]), { ok: true, requirements: reqs, tasks: children });
    return;
  }
  if (sub === 'show') {
    if (!args.id) fail('BAD_ID', '需要 --id');
    const r = loadTask(b.project, String(args.id));
    const kids = listTasks(b.project).filter((t) => t.requirementId === r.id);
    const project = loadProject(b.project);
    // R-f9b1 F-7①：正文外置的小节必须能从 req show 读到；卷缺失直接报错，不返回半份正文。
    const links = validateSupplementLinks(project.path, r.id);
    if (links.problems.some((p) => p.code === 'SUPPLEMENT_MISSING')) {
      fail('SUPPLEMENT_MISSING', `需求 ${r.id} 的增补卷缺失，不返回半份正文`, { requirementId: r.id, problems: links.problems }, 1);
    }
    const supplements = supplementsForShow(project.path, r.id, { withContent: Boolean(args['with-supplement']) });
    const payload = { ok: true, requirement: r, tasks: kids, supplements, links: { ok: links.ok, problems: links.problems } };
    const human = [
      JSON.stringify({ requirement: r, tasks: kids }, null, 2),
      supplements.length
        ? `\n增补卷（${supplements.length}）：\n${supplements.map((s) => `- ${s.name}（${s.bytes}B/sha256 ${s.sha12}）小节：${s.sections.join('、')}`).join('\n')}`
        : '\n增补卷：无',
      ...(links.problems.length ? [`\n链接自检：${links.problems.map((p) => p.code + ' ' + p.detail).join('；')}`] : []),
      ...(Boolean(args['with-supplement']) ? supplements.filter((s) => s.content).map((s) => `\n===== ${s.name} =====\n${s.content}`) : []),
    ].join('\n');
    out(args, human, payload);
    return;
  }
  fail('BAD_SUBCOMMAND', `未知 req 子命令：${sub}`);
}

// ========== R-dba4（工具侧）：需求行大白话 copy ==========

/** copy 四块（写死，口径 R-dba4 §七-2）；与 src/team-tools.js 的 REQUIREMENT_COPY_BLOCKS 保持一致。 */
const REQ_COPY_BLOCKS = ['what', 'how', 'impact', 'advice'];
const REQ_COPY_SOURCES = ['author', 'derived'];
const REQ_COPY_HISTORY_MAX = 20;
const REQ_COPY_BLOCK_MAX = 600;

/** 纯校验（零副作用）：返回 {ok, copy} 或 {ok:false, code, message, fields}。 */
function normalizeReqCopy(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const source = String(input.source === undefined || input.source === '' ? 'author' : input.source).trim().toLowerCase();
  if (!REQ_COPY_SOURCES.includes(source)) {
    return { ok: false, code: 'COPY_SOURCE_INVALID', message: `copy.source 只能是 author / derived：${source || '(空)'}`, fields: ['source'] };
  }
  const copy = {};
  const bad = [];
  for (const key of REQ_COPY_BLOCKS) {
    const value = input[key];
    if (value === undefined || value === null || value === true) { copy[key] = ''; continue; }
    if (typeof value !== 'string') { bad.push(`${key} 必须是字符串`); continue; }
    const text = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (text.length > REQ_COPY_BLOCK_MAX) { bad.push(`${key} 超过 ${REQ_COPY_BLOCK_MAX} 字`); continue; }
    copy[key] = text;
  }
  if (bad.length) return { ok: false, code: 'COPY_FIELD_INVALID', message: `大白话字段不合法：${bad.join('；')}`, fields: bad };
  const known = new Set([...REQ_COPY_BLOCKS, 'source', 'at', 'by']);
  const unknown = Object.keys(input).filter((key) => !known.has(key));
  if (unknown.length) {
    return { ok: false, code: 'COPY_FIELD_UNKNOWN', message: `copy 不接受未登记字段：${unknown.join('、')}（白名单只有 what/how/impact/advice）`, fields: unknown };
  }
  if (REQ_COPY_BLOCKS.every((key) => !copy[key])) {
    return { ok: false, code: 'COPY_EMPTY', message: '四块全空：至少给一块大白话，否则整卡会退回正文兜底' };
  }
  copy.source = source;
  return { ok: true, copy };
}

/** 与 src/team-tools.js → applyRequirementCopyToState 同判据（改一处必须同步改另一处）。 */
function applyReqCopyToRow(row, copy, { by = '', at = '', expectedUpdatedAt = '' } = {}) {
  const current = row && typeof row.copy === 'object' && row.copy && !Array.isArray(row.copy) ? row.copy : null;
  // copy JSON 损坏（被手写成字符串/数组）：视为缺字段展示，原值留档进 copyHistory 再覆盖。
  const brokenCopy = row && row.copy !== undefined && row.copy !== null && !current ? row.copy : null;
  if (expectedUpdatedAt && String(row.updatedAt || '') !== String(expectedUpdatedAt)) {
    return { ok: false, code: 'COPY_CONFLICT', message: `需求在读取之后被改过（磁盘 ${String(row.updatedAt || '').slice(0, 19)} ≠ 预期 ${String(expectedUpdatedAt).slice(0, 19)}），未写入`, current };
  }
  const stampAt = String(at || nowIso());
  const next = { ...copy, at: stampAt, by: String(by || '') };
  const sameBlocks = !brokenCopy && current
    && REQ_COPY_BLOCKS.every((key) => String(current[key] || '') === String(next[key] || ''))
    && String(current.source || '') === String(next.source || '');
  if (sameBlocks) return { ok: true, changed: false, reason: 'SAME_CONTENT', copy: current, at: stampAt };
  const history = Array.isArray(row.copyHistory) ? row.copyHistory.slice() : [];
  if (brokenCopy !== null) {
    const rawText = typeof brokenCopy === 'string' ? brokenCopy : (() => { try { return JSON.stringify(brokenCopy); } catch { return String(brokenCopy); } })();
    history.push({ broken: true, raw: String(rawText).slice(0, REQ_COPY_BLOCK_MAX), replacedAt: stampAt, replacedBy: String(by || '') });
  } else if (current) {
    history.push({ ...current, replacedAt: stampAt, replacedBy: String(by || '') });
  }
  row.copy = next;
  row.copyHistory = history.slice(-REQ_COPY_HISTORY_MAX);
  row.updatedAt = stampAt;
  return { ok: true, changed: true, reason: current ? 'UPDATED' : 'CREATED', copy: next, copyHistory: row.copyHistory, at: stampAt };
}

/**
 * req copy：把四块大白话写进需求行 copy（唯一真相）+ copyHistory（append-only，≤20）。
 * 用法：team.mjs req copy --boot T --requirement R-... --what "…" --how "…" --impact "…" --advice "…"
 *       [--source author|derived] [--by 角色] [--expected-updated-at ISO] [--json]
 */
function cmdReqCopy(args) {
  const b = bootFor(args, 'req copy');
  if (!args.requirement) fail('REQUIREMENT_REQUIRED', '需要 --requirement R-...（大白话必须挂在一条需求上）', {}, 1);
  const requirementId = String(args.requirement);
  const normalized = normalizeReqCopy({
    what: args.what, how: args.how, impact: args.impact, advice: args.advice, source: args.source,
  });
  if (!normalized.ok) fail(normalized.code, normalized.message, { fields: normalized.fields || [], wrote: false }, 1);
  const read = readWorkflowState(b.project);
  if (!read.exists) fail('WORKFLOW_MISSING', `工作流不存在：${read.file}；先 req register 登记需求`, { file: read.file, wrote: false }, 1);
  const rows = (read.state && read.state.requirements) || {};
  const key = Object.keys(rows).find((k) => k === requirementId)
    || Object.keys(rows).find((k) => String((rows[k] && rows[k].id) || '') === requirementId);
  const row = key ? rows[key] : null;
  if (!row) fail('REQUIREMENT_NOT_FOUND', `工作流里没有需求 ${requirementId}；先 req register 登记`, { requirementId, wrote: false }, 1);
  const by = String(args.by || b.role);
  const at = nowIso();
  const decision = applyReqCopyToRow(row, normalized.copy, { by, at, expectedUpdatedAt: String(args['expected-updated-at'] || '') });
  if (!decision.ok) fail(decision.code, decision.message, { requirementId, current: decision.current || null, wrote: false }, 1);
  if (decision.changed) {
    // 写盘沿用 工作流 的原子写（tmp+rename），并按本项目口径加一份 .bak（与 writeStore 一致）。
    try {
      if (read.file && exists(read.file)) fs.copyFileSync(read.file, `${read.file}.bak-${Date.now()}`);
    } catch { /* 备份失败不阻断写盘 */ }
    const write = writeWorkflowState(b.project, read.state);
    appendEvent({
      role: b.role, sessionId: b.sessionId, action: 'req_copy_save', project: b.project, target: requirementId,
      note: `${decision.reason} by ${by}`, data: { requirementId, source: decision.copy.source, changed: true, at },
    });
    const human = `已保存大白话：${requirementId}（${decision.reason}，来源 ${decision.copy.source}）\n工作流：${write.file}\n四块：${REQ_COPY_BLOCKS.map((k) => `${k}=${decision.copy[k] ? '有' : '空'}`).join(' ')}｜copyHistory ${(decision.copyHistory || []).length} 条`;
    out(args, human, { ok: true, changed: true, reason: decision.reason, requirementId, copy: decision.copy, copyHistory: decision.copyHistory || [], file: write.file });
    return;
  }
  out(args, `内容未变（SAME_CONTENT），未写盘：${requirementId}`,
    { ok: true, changed: false, reason: decision.reason, requirementId, copy: decision.copy, file: read.file });
}

// ========== R-c6dc：需求正文唯一写入口 / 审计 / 冻结 / 清锁 ==========

/**
 * req write：唯一写入口（R-c6dc F-1/F-2/F-3）。
 * 用法：team.mjs req write --boot T --requirement R-... (--file <路径>|--stdin) --expected-sha <sha12..64>
 *       [--reason "..."] [--json]
 * 写者默认 analyst；actor=system 豁免 writer 但不豁免冻结/并发；失败一律零副作用。
 */
function cmdReqWrite(args) {
  const b = bootFor(args, 'req write');
  if (!args.requirement) fail('REQUIREMENT_REQUIRED', '需要 --requirement R-...', {}, 1);
  if (!args['expected-sha']) fail('EXPECTED_SHA_REQUIRED', '必须带 --expected-sha（先读正文拿 sha 再写）', {}, 1);
  let content = '';
  if (args.file) {
    const file = path.resolve(String(args.file));
    if (!exists(file)) fail('FILE_NOT_FOUND', `内容文件不存在：${file}`, { file }, 2);
    content = readText(file, '');
  } else if (args.stdin) {
    content = fs.readFileSync(0, 'utf8');
  } else {
    fail('BAD_ARGS', '需要 --file <路径> 或 --stdin 提供新正文', {}, 1);
  }
  const project = loadProject(b.project);
  const result = writeRequirementDoc({
    projectName: b.project,
    projectPath: project.path,
    requirementId: String(args.requirement),
    expectedSha: String(args['expected-sha']),
    content,
    role: b.role,
    actor: String(args.actor || b.role),
    reason: String(args.reason || ''),
    transactionId: String(args['transaction-id'] || ''),
  });
  appendEvent({
    role: b.role, sessionId: b.sessionId, action: 'req_write', project: b.project, target: result.path,
    note: `${result.baseline ? 'baseline+' : ''}write ${String(result.prevSha).slice(0, 12)}→${String(result.sha256).slice(0, 12)} actor=${String(args.actor || b.role)}`,
    data: { requirementId: result.requirementId, path: result.path, prevSha: result.prevSha, sha256: result.sha256, baseline: result.baseline },
  });
  out(args, `已写入 ${result.path}：${String(result.prevSha).slice(0, 12)} → ${String(result.sha256).slice(0, 12)}（${result.bytes}B${result.baseline ? '，已补 baseline 登记' : ''}）`,
    { ok: true, ...result, registry: docRegistryPath(b.project) });
}

/**
 * req audit：只读审计（R-c6dc F-6 / 增补卷 §二）。
 * --json 时 stdout 恰好一行 JSON；退出码 0=全 ok / 1=有发现 / 2=参数错或登记损坏。
 */
function cmdReqAudit(args) {
  const projectName = String(args.project || '').trim();
  if (!projectName) fail('PROJECT_REQUIRED', '需要 --project', {}, 2);
  let result;
  try {
    result = auditRequirementDocs({ projectName, requirementId: String(args.requirement || ''), strict: Boolean(args.strict) });
  } catch (e) {
    if (e && e.exitCode) throw e;
    fail('AUDIT_FAILED', `审计失败：${String((e && e.message) || e)}`, {}, 2);
  }
  if (args.json) {
    // 增补卷 §二：--json 时 stdout **恰好一行 JSON**（不得夹日志），故这里不用 pretty jsonOut。
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    const lines = [`需求正文审计（${projectName}）：${result.summary.total} 条 ｜ ${(result.codes || []).join(' ') || '无问题'}`];
    for (const row of result.requirements) {
      lines.push(`- ${row.requirementId}  状态 ${row.state}  sha ${String(row.diskSha || '(缺)').slice(0, 12)}  ${(row.codes || []).join(' ') || 'ok'}`);
      for (const sup of row.supplements || []) {
        lines.push(`    卷 ${sup.path}  ${sup.state}  sha ${String(sup.diskSha).slice(0, 12)}  ${(sup.codes || []).join(' ') || 'ok'}`);
      }
    }
    if (result.chain && !result.chain.ok) lines.push(`登记链断点：${result.chain.breaks.length} 处`);
    textOut(lines.join('\n'));
  }
  if (result.exitCode) process.exitCode = result.exitCode;
}

/**
 * req doc repair（b75c 口径 §二.3）：备份 → 校验 → 恢复 → append-only 审计。
 *
 * 两种模式：
 *   ① `--from-backup <路径>`：把指定内容的正文写回目标文件（备份当前版本到 需求/_backup/ 后再写）；
 *   ② 不带 --from-backup：只做「登记对齐」——仅当磁盘 contentHash == 绑定 contentHash（纯元数据漂移，
 *      典型是程序自己追加了 `## 状态记录`）才允许；实质改文一律 DOC_DRIFT_REAL 拒绝并提示走 ①。
 *
 * 写盘复用 appendDocRegistry（action='repair'，prevSha 成链），并写 req_doc_repair 事件（who/why/来源）。
 */
function cmdReqDoc(args) {
  const action = String(args._[2] || '').trim();
  if (action !== 'repair') fail('BAD_ACTION', `req doc 只支持 repair（收到：${action || '(空)'}）`, {}, 1);
  const b = bootFor(args, 'req doc repair');
  const requirementId = String(args.requirement || '').trim();
  if (!requirementId) fail('REQUIREMENT_REQUIRED', '需要 --requirement', {}, 1);
  const reason = String(args.reason || '').trim();
  if (reason.length < 4) fail('REASON_REQUIRED', 'repair 必须带 --reason（写入审计）', {}, 1);
  const project = loadProject(b.project);
  const reqDir = path.join(project.path, '需求');
  const names = fs.existsSync(reqDir) ? fs.readdirSync(reqDir).filter((n) => /^R-.*\.md$/i.test(n)) : [];
  const hit = names.find((n) => n.toLowerCase().startsWith(requirementId.toLowerCase() + '-'))
    || names.find((n) => n.toLowerCase().startsWith(requirementId.toLowerCase()));
  if (!hit) fail('DOC_MISSING', `找不到需求正文：${requirementId}`, { requirementId }, 1);
  const rel = '需求/' + hit;
  const abs = path.join(project.path, rel);
  const before = fs.readFileSync(abs);
  const beforeSha = sha256(before);
  const beforeContent = sha256(requirementContentText(before.toString('utf8')));
  const wf = readWorkflowState(b.project, { fresh: true }).state || {};
  const row = (wf.requirements && wf.requirements[requirementId]) || {};
  const boundContent = String((row.requirementReview && row.requirementReview.contentHash) || row.contentHash || '');
  // ① 备份当前正文（只复制将被写的这一个文件，带时间戳）
  const backupDir = path.join(reqDir, '_backup');
  ensureDir(backupDir);
  const stamp = nowIso().replace(/[:.]/g, '-');
  const backupAbs = path.join(backupDir, `${hit}.${stamp}.md`);
  fs.writeFileSync(backupAbs, before);
  const backupRel = path.relative(project.path, backupAbs);
  // ② 目标内容
  const fromBackup = String(args['from-backup'] || '').trim();
  let nextContent = null;
  let source = 'registry-align';
  if (fromBackup) {
    const srcAbs = path.isAbsolute(fromBackup) ? fromBackup : path.join(project.path, fromBackup);
    if (!fs.existsSync(srcAbs)) fail('BACKUP_MISSING', `恢复来源不存在：${fromBackup}`, { file: fromBackup }, 1);
    const raw = fs.readFileSync(srcAbs);
    if (!raw.length) fail('BACKUP_EMPTY', `恢复来源为空：${fromBackup}`, { file: fromBackup }, 1);
    nextContent = raw.toString('utf8');
    source = 'from-backup';
  } else {
    if (!boundContent) {
      fail('DOC_BINDING_UNKNOWN', '没有可用的绑定 contentHash，无法证明只差元数据；请用 --from-backup', { requirementId }, 1);
    }
    if (beforeContent !== boundContent) {
      fail('DOC_DRIFT_REAL', `正文内容与绑定版本不一致（${beforeContent.slice(0, 12)} ≠ ${boundContent.slice(0, 12)}）：这是实质改文；请用 --from-backup 指定要恢复的内容，或由 Owner/PM 重落决定（重评后新决定即绑当前版本）`, {
        requirementId, diskContentHash: beforeContent, boundContentHash: boundContent, hint: 'req doc repair --from-backup <路径> --reason ...',
      }, 1);
    }
  }
  if (nextContent !== null) fs.writeFileSync(abs, nextContent, 'utf8');
  const after = fs.readFileSync(abs);
  const afterSha = sha256(after);
  const afterContent = sha256(requirementContentText(after.toString('utf8')));
  // ③ append-only 登记（prevSha 成链）+ 事件审计
  appendDocRegistry(b.project, {
    at: nowIso(), requirementId, path: rel, action: 'repair', sha256: afterSha, bytes: after.length,
    writer: String(b.role), actor: String(b.role), prevSha: beforeSha, reason, transactionId: null,
  });
  appendEvent({
    role: b.role, sessionId: b.sessionId, action: 'req_doc_repair', project: b.project, target: rel,
    note: `source=${source} ${beforeSha.slice(0, 12)}->${afterSha.slice(0, 12)} reason=${reason.slice(0, 80)}`,
    data: { requirementId, path: rel, source, beforeSha, afterSha, beforeContentHash: beforeContent, afterContentHash: afterContent, backup: backupRel },
  });
  out(args, `已修复 ${rel}（source=${source}，sha ${beforeSha.slice(0, 12)}→${afterSha.slice(0, 12)}，备份 ${backupRel}）`, {
    ok: true, requirementId, path: rel, source, beforeSha, afterSha,
    beforeContentHash: beforeContent, afterContentHash: afterContent, backup: backupRel,
  });
}

/** req unlock-write：PM 清写锁（by=pm + reason 非空；锁不存在 → LOCK_NOT_FOUND 幂等）。 */function cmdReqUnlockWrite(args) {
  const b = bootFor(args, 'req unlock-write');
  if (!['pm', 'owner'].includes(String(b.role))) fail('PERMISSION_DENIED', '只有 PM 能清写锁', { role: b.role }, 1);
  const project = loadProject(b.project);
  const result = unlockDocWrite({
    projectName: b.project, projectPath: project.path,
    requirementId: String(args.requirement || ''),
    by: 'pm', reason: String(args.reason || ''),
  });
  appendEvent({
    role: b.role, sessionId: b.sessionId, action: 'req_unlock_write', project: b.project, target: String(args.requirement || ''),
    note: `lock pid=${result.lock && result.lock.pid} reason=${String(args.reason || '').slice(0, 80)}`,
    data: { requirementId: String(args.requirement || ''), lock: result.lock, reason: String(args.reason || '') },
  });
  out(args, `已清写锁：${String(args.requirement || '')}（pid=${result.lock && result.lock.pid}；已写 unlock_lock 登记）`, { ok: true, ...result });
}

/** req freeze/unfreeze：冻结/解冻只认登记（PM 专属 + reason 非空；legacy 只读不自动清）。 */
function cmdReqFreeze(args, action) {
  const b = bootFor(args, `req ${action}`);
  if (String(b.role) !== 'pm') fail('PERMISSION_DENIED', `只有 PM 能${action === 'freeze' ? '冻结' : '解冻'}需求正文`, { role: b.role }, 1);
  const reason = String(args.reason || '').trim();
  if (!reason) fail('REASON_REQUIRED', `${action === 'freeze' ? '冻结' : '解冻'}必须带 --reason`, {}, 1);
  const project = loadProject(b.project);
  const requirementId = String(args.requirement || '');
  if (!requirementId) fail('REQUIREMENT_REQUIRED', '需要 --requirement', {}, 1);
  // 定位正文（与写入口同口径）
  const reqDir = path.join(project.path, '需求');
  const names = fs.existsSync(reqDir) ? fs.readdirSync(reqDir).filter((n) => /^R-.*\.md$/i.test(n)) : [];
  const hit = names.find((n) => n.toLowerCase().startsWith(requirementId.toLowerCase() + '-'))
    || names.find((n) => n.toLowerCase().startsWith(requirementId.toLowerCase()));
  if (!hit) fail('DOC_MISSING', `找不到需求正文：${requirementId}`, { requirementId }, 1);
  const rel = '需求/' + hit;
  const reg = readDocRegistry(b.project);
  if (reg.broken) fail('REGISTRY_BROKEN', `文档登记损坏（${reg.errors.length} 坏行），先修复登记`, { file: reg.file }, 2);
  const row = {
    at: nowIso(), requirementId, path: rel, action, sha256: null, bytes: null,
    writer: '', actor: 'pm', prevSha: null, reason, transactionId: null,
  };
  const written = appendDocRegistry(b.project, row);
  // 冻结同时设 Windows 只读是附加防线（解冻时只清「有 unfreeze 登记」的残留属性）
  let readonlyTouched = null;
  try {
    if (action === 'freeze') { fs.chmodSync(path.join(project.path, rel), 0o444); readonlyTouched = 'readonly'; }
    else { fs.chmodSync(path.join(project.path, rel), 0o644); readonlyTouched = 'writable'; }
  } catch { readonlyTouched = 'unchanged'; }
  appendEvent({
    role: b.role, sessionId: b.sessionId, action: `req_doc_${action}`, project: b.project, target: rel,
    note: reason.slice(0, 120), data: { requirementId, path: rel, reason },
  });
  out(args, `已${action === 'freeze' ? '冻结' : '解冻'} ${rel}（登记 ${written.file}，${readonlyTouched}）`, { ok: true, requirementId, path: rel, action, file: written.file, reason, readonlyTouched });
}

/** req writer：查看/改派写者（默认 analyst；PM 改派留审计）。 */
function cmdReqWriter(args) {
  const b = bootFor(args, 'req writer');
  const project = loadProject(b.project);
  const reg = readDocRegistry(b.project);
  if (reg.broken) fail('REGISTRY_BROKEN', '文档登记损坏，先修复', { file: reg.file }, 2);
  const rows = (reg.rows || []).filter((r) => ['writer', 'reassign'].includes(String(r.action || '')));
  const current = rows.length ? String(rows[rows.length - 1].writer || DOC_WRITER_DEFAULT) : DOC_WRITER_DEFAULT;
  if (!args.reassign) {
    out(args, `当前写者：${current}（登记 ${rows.length} 条）`, { ok: true, project: b.project, writer: current, file: reg.file, rows });
    return;
  }
  if (String(b.role) !== 'pm') fail('PERMISSION_DENIED', '只有 PM 能改派写者', { role: b.role }, 1);
  const to = String(args.to || '').trim().toLowerCase();
  const reason = String(args.reason || '').trim();
  if (!ROLES[to]) fail('BAD_ROLE', `--to 只能是角色 id：${Object.keys(ROLES).join('/')}`, { to }, 1);
  if (!reason) fail('REASON_REQUIRED', '改派写者必须带 --reason', {}, 1);
  const written = appendDocRegistry(b.project, {
    at: nowIso(), requirementId: String(args.requirement || ''), path: '需求/__writer__', action: 'reassign',
    sha256: null, bytes: null, writer: to, actor: 'pm', prevSha: null, reason, transactionId: null,
  });
  appendEvent({
    role: b.role, sessionId: b.sessionId, action: 'req_doc_writer_reassign', project: b.project, target: to,
    note: `${current} → ${to}：${reason.slice(0, 80)}`, data: { from: current, to, reason },
  });
  out(args, `写者已改派：${current} → ${to}（登记 ${written.file}）`, { ok: true, from: current, to, file: written.file, reason, project: project.name });
}

function reviewRecordDir(projectName, isTech) {
  const p = projectStatePaths(projectName);
  return isTech ? p.techReviews : p.reqReviews;
}

function writeReviewFile(dir, record, title) {
  ensureDir(dir);
  const jsonFile = path.join(dir, record.id + '.json');
  const mdFile = path.join(dir, record.id + '.md');
  writeJson(jsonFile, record);
  const lines = [
    `# ${title} · ${record.requirementId}`,
    '',
    `> 程序生成；JSON 同名文件是真相。中文记录，只对本次需求版本负责。`,
    '',
    `- 评审 id：${record.id}`,
    `- 项目：${record.project}（团队模式 ${record.teamMode}）`,
    `- 需求：${record.requirementId} ${record.title || ''}`,
    ...(record.proposalId ? [`- 提案：${record.proposalId}（proposalHash ${shortHash(record.proposalHash, 16)}）`] : []),
    `- 评审人：${record.role} ｜ 会话：${record.sessionId || '-'}`,
    `- 结论：${record.verdict}`,
    `- 时间：${record.ts}`,
    '',
    '## 意见',
    '',
    record.comments || '（无）',
    '',
  ];
  writeText(mdFile, lines.join('\n'));
  return { dir, jsonFile, mdFile };
}

/**
 * req review：需求评审 / 技术评审记录（--kind requirement|tech）。
 * - 需求评审：full 由产品设计师、fast 由需求分析师执行；PM 一律不评审。
 * - 技术评审：full 由产品/程序员A，fast 由程序员A记录；可绑定提案哈希。
 * 评审记录落 团队/状态/项目/<slug>/{需求评审|技术评审}/，并写任务字段与事件链。
 */
function cmdReqReview(args) {
  const b = bootFor(args, 'req review');
  // R-51de F-5③：需求评审前必须读过当前版本经验教训登记册（Owner 通道豁免）
  failLessonGate(lessonGateFor(b, args));
  const kindArg = String(args.kind || args.stage || 'requirement').trim().toLowerCase();
  const isTech = ['tech', 'technical'].includes(kindArg);
  const isReq = ['requirement', 'req'].includes(kindArg);
  if (!isTech && !isReq) fail('BAD_KIND', '--kind 只能是 requirement（需求评审）或 tech（技术评审记录）', { kind: kindArg });
  const project = loadProject(b.project);
  const teamMode = projectTeamMode(project);
  if (isTech) {
    const allowed = techReviewers(teamMode);
    if (!allowed.includes(b.role)) {
      fail('ROLE_NOT_ALLOWED', `技术评审记录只能由 ${allowed.map((r) => ROLE_NAMES[r] || r).join(' / ')} 执行（当前项目模式 ${teamMode}）`, {
        role: b.role, allowed, teamMode,
      });
    }
  } else {
    const reviewer = requirementReviewer(teamMode);
    if (b.role !== reviewer) {
      fail('ROLE_NOT_ALLOWED', `需求评审在 ${teamMode} 模式必须由 ${ROLE_NAMES[reviewer] || reviewer} 执行；PM 与其他角色不能代评`, {
        role: b.role, required: reviewer, teamMode,
      });
    }
  }
  if (!args.id) fail('BAD_ID', '需要 --id R-...');
  const requirementId = String(args.id);
  const task = loadTask(b.project, requirementId);
  if (task.type !== 'requirement') fail('NOT_REQUIREMENT', `${requirementId} 不是需求（type=${task.type}）；需求评审只针对 req create 建的需求`, { id: requirementId, type: task.type });
  // R-0dbb F8/AC11④⑤：Owner 意见消费门——必须放在写盘与其它门之前，未 ack 时**零写入**。
  // 豁免：意见为空串不拦（AC11⑥）；Owner 通道（ui/tty）自评与 owner 角色不拦；PM 代记的意见同源适用。
  const opinionGateRow = workflowRowFor(b.project, task.id) || {};
  const opinionView = ownerOpinionDisplayOf(opinionGateRow);
  const opinionGate = ownerOpinionGateFor(opinionGateRow);
  let ownerOpinionAck = normalizeOwnerOpinionAck(args['owner-opinion-ack']);
  if (!isTech && opinionGate.code === 'OWNER_OPINION_UNREAD' && !lessons.isOwnerChannel(args)) {
    if (!ownerOpinionAck) {
      fail('OWNER_OPINION_UNREAD', `Owner 对 ${task.id} 的意见还没消费：先读原文，再带 --owner-opinion-ack "采纳：…" / "不采纳：…" 重试`, {
        requirementId: task.id,
        ownerOpinion: opinionGate.opinion,
        ownerOpinionAt: opinionGate.at,
        opinionSha256: opinionGate.sha256,
        consumed: opinionGate.consumed,
        hint: '已消费集合＝工作流行 history 中 action=owner_opinion_ack 的 opinionSha256；同一 sha 只需 ack 一次',
        wrote: false,
      }, 1);
    }
  }
  if (isTech) ownerOpinionAck = ''; // 技术评审不是产品对 Owner 意见的处置入口
  // 必读闸门：评审人必须在本轮 boot 里读过该需求正文；需求在 boot 后改过就要重新 boot 补读。
  assertRequirementDocsRead(b, project.path, task.id, isTech ? '技术评审' : '需求评审');
  const verdict = String(args.verdict || args.decision || '').toLowerCase();
  if (!['approve', 'reject'].includes(verdict)) fail('BAD_VERDICT', '--verdict 必须是 approve / reject');
  // R-f9b1 F-11：三入口之一——review 在 G1 前量尺寸并按需外置；随后校验卷链接可解析（AC13）。
  let reviewDocGate = null;
  let linkWarnings = [];
  if (!isTech) {
    reviewDocGate = docSizeGate(project, task.id, { entry: 'review', role: b.role, noSplit: Boolean(args['no-split']) });
    const afterDoc = reviewDocGate.after;
    if (afterDoc.exists && !afterDoc.whitelisted && afterDoc.level === 'over') {
      fail('DOC_TOO_LARGE', `需求 ${task.id} 正文 ${afterDoc.bytes}B 超过 ${DOC_SPLIT_LIMIT} 字节且拆分不足；先拆需求或人工压缩`, {
        requirementId: task.id, bytes: afterDoc.bytes, split: reviewDocGate.split ? { action: reviewDocGate.split.action, code: reviewDocGate.split.code, afterBytes: reviewDocGate.split.afterBytes } : null, wrote: false,
      }, 1);
    }
    const linkCheck = validateSupplementLinks(project.path, task.id);
    linkWarnings = (linkCheck.warnings || []).slice();
    // 只拦「本工具拆出的卷」断链；历史手工卷缺指针行只作 warning（不挡评审，2026-11-15 5550 实测口径）。
    const blocking = (linkCheck.blocking || linkCheck.problems.filter((p) => p.level !== 'warn'));
    const missingSup = blocking.find((p) => p.code === 'SUPPLEMENT_MISSING');
    if (missingSup) fail('SUPPLEMENT_MISSING', `需求 ${task.id} 增补卷缺失：${missingSup.detail}`, { problems: linkCheck.problems, wrote: false }, 1);
    const broken = blocking.find((p) => p.code === 'DOC_SPLIT_LINK_MISSING' || p.code === 'SUPPLEMENT_MISMATCH');
    if (broken) fail(broken.code, `需求 ${task.id} 卷链接不可解析：${broken.detail}`, { problems: linkCheck.problems, wrote: false }, 1);
  }
  // G1：需求未定稿（验收标准空/无正文）不能评审；G0：阶段-角色表校验。
  if (!isTech) {
    const finalGate = gateRequirementFinal(task, project.path);
    if (finalGate) {
      const record = { role: b.role, action: 'requirement_review', requirementId: task.id, attempted: 'req review' };
      if (finalGate.soft) gateWarn(b.project, record, finalGate);
      else gateFail(b.project, record, finalGate);
    }
    // 四条硬门①/⑤：需求正文四件套 + 边界清单六类 + 待确认清单（无正文硬拒）。
    const docGate = gateRequirementDoc(task, project.path);
    if (docGate && docGate.ok === false) {
      gateFail(b.project, { role: b.role, action: 'requirement_review', requirementId: task.id, attempted: 'req review' }, docGate);
    }
    // 四条硬门④：产品评审必须逐项给边界清单结论（仅对 v2 严格需求生效，旧需求兼容）。
    if (verdict === 'approve' && docGate && docGate.strict) {
      const comments = String(args.comments || '');
      const need = [
        ['空值', /空值|为空|空串|缺省|缺失/],
        ['异常', /异常|失败|报错|错误/],
        ['权限', /权限|越权|角色/],
        ['并发', /并发|同时|锁/],
        ['降级', /降级|回退|不可用/],
        ['模式', /六人|四人|full|fast|双模式|模式/],
      ];
      const lack = need.filter(([, re]) => !re.test(comments)).map(([k]) => k);
      if (lack.length) {
        fail('PRODUCT_CHECKLIST_INCOMPLETE', `产品评审必须逐项给边界结论：缺 ${lack.join('、')}；在 --comments 里按六类各写一句结论`, { requirementId: task.id, missing: lack });
      }
    }
  }
  const rowForStage = workflowRowFor(b.project, task.id) || { status: (task.workflow && task.workflow.requirementStatus) || 'review' };
  // 需求评审不套 G0 阶段表：评审由 G1（定稿）+ G2（评审哈希）管；测试阶段仍允许产品/分析师复审，避免误伤。
  const stageGate = null;
  if (stageGate) {
    gateFail(b.project, { role: b.role, action: 'requirement_review', requirementId: task.id, attempted: isTech ? 'req review --kind tech' : 'req review' }, stageGate);
  }
  // D1：PowerShell 会把中文弯引号 “” 当引号边界，--comments 可能被静默截断；
  // 提供 --comments-file 作为无损入口，并在疑似截断时给告警（只提示，不猜内容）。
  let comments = String(args.comments || args.comment || '').trim();
  let commentsSource = '--comments';
  if (args['comments-file']) {
    comments = readText(path.resolve(String(args['comments-file'])), '').trim();
    commentsSource = '--comments-file';
  }
  const warnings = [...linkWarnings.map((w) => ({ code: w.code, message: w.detail, legacy: Boolean(w.legacy) }))];
  if (commentsSource === '--comments') {
    const raw = String(args.comments || args.comment || '');
    const curly = (raw.match(/[“”]/g) || []).length;
    const corner = (raw.match(/[「」]/g) || []).length;
    if (curly % 2 === 1 || corner % 2 === 1) {
      warnings.push({ code: 'COMMENTS_SUSPECTED_TRUNCATED', message: '评论文本里的中文引号不成对，可能被 PowerShell 截断；请改用 --comments-file 重发，本记录只按收到的内容落盘' });
    }
  }
  // D2：长度校验必须在任何写盘之前；超限零写入（不截断评论、不留半条评审历史）。
  const commentMax = Number(loadTeam().config.reviewCommentMaxChars || 600);
  if (comments.length > commentMax) {
    fail('MESSAGE_TOO_LONG', `评审意见 ${comments.length} 字，超过 ${commentMax} 字上限；本次未写任何评审记录，请压缩或拆成多条`, {
      length: comments.length, max: commentMax, wrote: false, hint: '用 --comments-file 传全文，或把长意见写进项目内文件后引用路径',
    });
  }
  if (verdict === 'reject' && comments.length < 10) fail('COMMENTS_REQUIRED', '打回必须写至少 10 字理由');
  let proposal = null;
  if (args.proposal) {
    proposal = loadProposal(b.project, String(args.proposal));
    const actual = computeProposalHash(proposal);
    if (actual !== proposal.proposalHash) fail('PROPOSAL_TAMPERED', '提案哈希不符', { expected: proposal.proposalHash, actual });
  }
  const ts = nowIso();
  // 评审绑定当前需求正文哈希：G2 用它在派单前判断“评审是不是针对旧版本”。
  let requirementHash = '';
  let requirementContentHash = '';
  let docVersion = { version: '', change: '' };
  try {
    const docs = readRequirementDocs(project.path);
    const doc = docs.list.find((row) => idMatches(row.id, task.id));
    requirementHash = doc ? String(doc.hash || '') : '';
    requirementContentHash = doc ? String(doc.contentHash || '') : '';
    // R-9a8e：三元组里的 version —— 正文有就照抄；旧正文没有则首记 v1 + legacy=true（只写记录，不改正文）。
    docVersion = versionForRecord(readRequirementDocVersion(project.path, task.id));
  } catch { requirementHash = ''; }
  const record = {
    id: (isTech ? 'TR-' : 'RR-') + stamp() + '-' + randomHex(2),
    kind: isTech ? 'tech' : 'requirement',
    project: b.project,
    teamMode,
    requirementId: task.id,
    title: task.title,
    requirementHash,
    // R-9a8e F-rv-2：评审记录绑 (requirementId, version, hash) 三元组；历史只追加不覆盖。
    version: docVersion.version,
    change: docVersion.change,
    legacy: Boolean(docVersion.legacy),
    proposalId: proposal ? proposal.id : '',
    proposalHash: proposal ? proposal.proposalHash : '',
    role: b.role,
    sessionId: b.sessionId,
    verdict,
    comments: truncate(comments, 600),
    commentsSource,
    ts,
  };
  const dir = reviewRecordDir(b.project, isTech);
  const reviewFiles = writeReviewFile(dir, record, isTech ? '技术评审记录' : '需求评审记录');
  const listKey = isTech ? 'techReviews' : 'reviews';
  const lastKey = isTech ? 'techReview' : 'review';
  task[listKey] = Array.isArray(task[listKey]) ? task[listKey] : [];
  task[listKey] = [...task[listKey], record].slice(-20);
  task[lastKey] = record;
  task.workflow = task.workflow && typeof task.workflow === 'object' ? task.workflow : {};
  task.workflow.reviewedAt = ts;
  task.workflow.reviewedBy = b.role;
  task.workflow.reviewRole = b.role;
  task.workflow.teamMode = teamMode;
  if (isTech) {
    // 与工作台 team-tools.js 的 techReview 同形：派单闸门读 verdict/trId，审计读 tr。
    task.workflow.techReview = {
      verdict,
      by: b.role,
      role: b.role,
      teamMode,
      comment: truncate(comments, 600),
      evidence: '',
      at: ts,
      source: 'team.mjs req review --kind tech',
      trId: record.id,
      trFile: reviewFiles.jsonFile,
      tr: record,
    };
  } else {
    const reviewPayload = {
      verdict,
      by: b.role,
      reviewRole: b.role,
      teamMode,
      comment: truncate(comments, 600),
      at: ts,
      requirementHash,
      // R-9a8e F-rv-2：工作流行里的评审视图也要带三元组的 version/change/legacy，
      // 否则 G2 读 row.productReview 时看不到版本，会退回「只比 hash」的旧路径。
      version: record.version,
      change: record.change,
      legacy: Boolean(record.legacy),
      source: 'team.mjs req review',
      command: 'req review',
    };
    // R-0dbb F8：本次显式 ack（--owner-opinion-ack）落 requirementReview（只作「最近一次」展示；判定看 history）。
    if (ownerOpinionAck) {
      reviewPayload.ownerOpinionAck = {
        text: ownerOpinionAck,
        at: ts,
        by: b.role,
        opinionSha256: opinionGate.sha256,
        opinion: opinionGate.opinion,
        opinionAt: opinionGate.at,
      };
    }
    // 保留 productReview / requirementReview 两个同形别名：旧界面读前者，新审计读后者。
    task.workflow.productReview = reviewPayload;
    task.workflow.requirementReview = reviewPayload;
  }
  // 状态只前进：重审不能把已 Owner 批准（ready）或更后阶段的需求打回 approved。
  const beforeRow = workflowRowFor(b.project, task.id) || {};
  const currentStatus = String(beforeRow.status || (task.workflow && task.workflow.requirementStatus) || 'review');
  const latestDecision = latestOwnerDecisionFor(beforeRow, task);
  const decided = Boolean(latestDecision && ['approved', 'skipped'].includes(String(latestDecision.status || '')));
  const decisionBasisHash = latestDecision && latestDecision.basis && latestDecision.basis.requirement
    ? String(latestDecision.basis.requirement.sha256 || '') : '';
  const decisionBasisContentHash = latestDecision && latestDecision.basis && latestDecision.basis.requirement
    ? String(latestDecision.basis.requirement.contentHash || '') : '';
  // 决定依据与当前需求一致才算“未变”：优先内容哈希（状态行不算内容），回退原始哈希。
  const decisionFresh = decided && (
    (decisionBasisHash && (decisionBasisHash === requirementHash || decisionBasisHash === requirementContentHash))
    || (decisionBasisContentHash && requirementContentHash && decisionBasisContentHash === requirementContentHash)
  );
  // B-20261115-123038-2e24：ownerReview 是 decisions[] 的投影，重落 RR（正文改 hash）时**不得**无条件写回
  // pending —— 旧实现把它写成 {"status":"pending","at":null,"opinion":""}，把「上次决定绑旧版」抹掉，
  // 界面/门禁看起来像「从未评审」。这里统一走 owner-review-projection：
  //   · 有绑当前正文的评审决定 → ownerReview = 该决定（status/at 对齐，修 fe90 那类反向不一致）；
  //   · 只有旧版/无版本凭据的决定 → pending 但带 stale:true + staleSha12 + 上次决定状态（不许静默）；
  //   · 没有任何评审决定 → pending（旧行为，只多 stale:false）。
  const reviewProjectionRow = { ...(beforeRow || {}), decisions: ownerDecisionList(beforeRow, task) };
  const reviewProjectionVersion = { sha256: requirementHash, contentHash: requirementContentHash };
  const ownerProjection = isTech ? null : ownerReviewView(reviewProjectionRow, reviewProjectionVersion);
  let nextStatus;
  let ownerPending = false;
  if (verdict === 'reject') {
    stampRejected(task, { source: `${record.kind}_review:${record.id}`, role: b.role, at: ts });
    nextStatus = 'rejected';
  } else {
    if (isTech) {
      nextStatus = keepForwardStatus(['rejected', 'iteration'].includes(currentStatus) ? 'approved' : currentStatus, 'ready');
    } else {
      // 已有同 basis 的 Owner 批准/跳过：保持/恢复 ready，不把 Owner 决定打回 pending。
      // B-4226：iteration（返工轮）在 REQUIREMENT_STATUS_RANK 里是 rank=10 的高位「终态」，直接 keepForwardStatus
      // 会永远停在 iteration——产品按新正文重评 approve 也回不到 approved，派单/任务门全被挡死。
      // 返工轮按「重做轮起点 approved」计位次（与 advanceRequirementAfterTaskDone 的 currentRankForAdvance 同口径）：
      // 重评通过后落 approved（Owner 未重批）/ ready（Owner 已按同一正文批过）。
      const reviewBase = currentStatus === 'iteration' ? 'approved' : currentStatus;
      nextStatus = keepForwardStatus(reviewBase, decisionFresh ? 'ready' : 'approved');
      ownerPending = !decisionFresh && statusRank(nextStatus) < statusRank('ready');
    }
    task.workflow.requirementStatus = nextStatus;
    delete task.workflow.rejectedAt;
    delete task.workflow.rejectedBy;
    delete task.workflow.rejectionSource;
  }
  // B-20261115-123038-2e24：ownerReview 是 decisions[] 的投影，重落 RR（正文改 hash）时**不得**无条件写回
  // pending —— 旧实现把它写成 {"status":"pending","at":null,"opinion":""}，把「上次决定绑旧版」抹掉，
  // 界面/门禁看起来像「从未评审」。这里统一走 owner-review-projection：
  //   · 有绑当前正文的评审决定 → ownerReview = 该决定（status/at 对齐，修 fe90 那类反向不一致）；
  //   · 只有旧版/无版本凭据的决定 → pending 但带 stale:true + staleSha12 + 上次决定状态（不许静默）；
  //   · 没有任何评审决定 → pending（旧行为，只多 stale:false）。
  const ownerReviewWrite = (() => {
    if (isTech) return undefined;
    if (ownerPending) return ownerReviewRecord(reviewProjectionRow, reviewProjectionVersion);
    // 状态仍在 ready/开发/测试：只有「评审决定已绑当前正文、但 ownerReview 被历史写坏」时才自愈回写；
    // 旧版决定不在这里改 ownerReview.status——避免把已过 ready 的行新推进 G3 拦截（是否收紧需产品口径另定）。
    if (ownerProjection && ownerProjection.source === 'decisions' && !ownerProjection.stale) {
      const drift = ownerReviewDriftOf(reviewProjectionRow, reviewProjectionVersion);
      if (drift.drifted) return ownerReviewRecord(reviewProjectionRow, reviewProjectionVersion);
    }
    return undefined;
  })();
  task.updatedAt = ts;
  task._by = b.role;
  task._action = isTech ? 'tech_review' : 'req_review';
  task._note = `${verdict} ${comments}`.trim();
  saveTask(b.project, task);
  // 评审结果同时写一份工作台可读的工作流行；通过时不强建，驳回时必须留痕。
  // 阶段只在状态向前推进时更新；重审处于开发/测试阶段的需求不改 phase，避免整条流回退。
  const phaseByStatus = { approved: 'owner_review', ready: 'dispatch', tech_review: 'tech_review', rejected: 'requirement_review', accepted: 'accepted' };
  const workflowPhase = phaseByStatus[nextStatus] || '';
  const workflowSync = syncWorkflowRow(b.project, task, nextStatus, {
    reviewedAt: task.workflow.reviewedAt,
    reviewedBy: task.workflow.reviewedBy,
    reviewRole: task.workflow.reviewRole,
    teamMode,
    productReview: task.workflow.productReview,
    requirementReview: task.workflow.requirementReview,
    techReview: task.workflow.techReview,
    // B-2e24：不再无条件 { status:'pending' }——写 decisions[] 派生出的投影（旧版决定 → pending+stale）。
    ownerReview: ownerReviewWrite,
    rejectedAt: task.workflow.rejectedAt,
    rejectedBy: task.workflow.rejectedBy,
    rejectionSource: task.workflow.rejectionSource,
  }, {
    create: verdict === 'reject',
    action: isTech ? 'tech_review' : 'req_review',
    by: b.role,
    note: comments,
    phase: workflowPhase,
    // 通过时也建档：Owner 决定/验收与工作台快照都要读 工作流.json 的同一需求行，
    // 不能等驳回才创建，否则首次评审通过后 owner 会报 REQUIREMENT_NOT_FOUND。
    create: true,
    statePatch: ownerReviewWrite
      ? { ownerReview: ownerReviewWrite }
      : null,
  });
  // R-f9b1 AC12：评审入口触发过拆分时，等工作流行建好再把卷挂回需求行/池记录（此前行还不存在）。
  if (reviewDocGate && reviewDocGate.split && reviewDocGate.split.wrote) {
    syncRequirementSupplements(b.project, project.path, task.id);
  }
  // R-0dbb F8：显式 ack 落 append-only 的 history——「已消费集合＝history 中 action=owner_opinion_ack 的
  // opinionSha256 去重集合」的**唯一写入点**。requirementReview.ownerOpinionAck 只是最近一次展示（会被覆写）。
  if (ownerOpinionAck && !isTech) {
    syncWorkflowRow(b.project, task, nextStatus, {}, {
      action: 'owner_opinion_ack',
      by: b.role,
      note: ownerOpinionAck,
      historyExtra: { opinionSha256: opinionGate.sha256, opinion: opinionGate.opinion, opinionAt: opinionGate.at },
    });
  }
  appendEvent({
    role: b.role, sessionId: b.sessionId, action: isTech ? 'tech_review' : 'req_review', project: b.project,
    target: task.id, note: `${verdict} ${truncate(comments, 100)}`,
    data: {
      reviewId: record.id, kind: record.kind, verdict, proposalId: record.proposalId, proposalHash: record.proposalHash,
      teamMode, reviewFile: reviewFiles.jsonFile, workflowFile: workflowSync.file,
    },
  });
  notify({
    from: b.role, to: 'pm',
    subject: `${isTech ? '技术评审' : '需求评审'}${verdict === 'approve' ? '通过' : '打回'} ${task.id}`,
    body: clipMessage(`${task.title}\n${comments || '（无备注）'}\n记录：${record.id}（${record.kind}，${teamMode}）\n文件：${reviewFiles.jsonFile}`),
    project: b.project, task: task.id, ackRequired: true, type: isTech ? 'tech_review' : 'req_review', sessionId: b.sessionId,
  });
  out(args, `${isTech ? '技术评审记录' : '需求评审'}已记录：${task.id} → ${verdict}（${record.id}，${teamMode}）\n记录：${reviewFiles.jsonFile}`,
    {
      ok: true, requirement: task, review: record, kind: record.kind, teamMode,
      reviewFile: reviewFiles.jsonFile, mdFile: reviewFiles.mdFile, workflowFile: workflowSync.file,
      commentsSource, warnings,
      // R-0dbb F7/AC11②：评审返回体与 req list 同口径带 Owner 意见原文/时间（逐字等于 decisions[-1].opinion）。
      ownerOpinion: opinionView.opinion,
      ownerOpinionAt: opinionView.at,
      ...(ownerOpinionAck ? { ownerOpinionAck: { text: ownerOpinionAck, opinionSha256: opinionGate.sha256, at: ts } } : {}),
      ...(reviewDocGate ? {
        docSplit: {
          entry: 'review',
          beforeBytes: reviewDocGate.before.bytes,
          afterBytes: reviewDocGate.after.bytes,
          level: reviewDocGate.after.level,
          whitelisted: reviewDocGate.after.whitelisted,
          action: reviewDocGate.split ? reviewDocGate.split.action : 'skip',
          reason: reviewDocGate.split ? reviewDocGate.split.reason : null,
          warning: reviewDocGate.after.level === 'near' && reviewDocGate.after.bytes > DOC_SPLIT_TARGET ? 'DOC_NEAR_LIMIT' : null,
          supplements: reviewDocGate.after.supplements || [],
        },
      } : {}),
      ...(proposal ? { proposal } : {}),
    });
}

/**
 * TR-Q 可测性评审记录（R-453c / G2.5）：测试人员本人记录，只评 AC 可判定性。
 * 产出 测试人员/产出/可测性评审-<需求id>-vN.md（≤1200 字），同时写任务与工作流行的 trq 字段。
 */
function cmdReqTrq(args) {
  const b = bootFor(args, 'req trq');
  if (b.role !== 'tester') {
    fail('ROLE_NOT_ALLOWED', '可测性评审（TR-Q）必须由测试人员本人记录；PM/产品/开发不能代评', { role: b.role });
  }
  if (!args.id) fail('BAD_ID', '需要 --id R-...');
  const task = loadTask(b.project, String(args.id));
  if (task.type !== 'requirement') {
    fail('NOT_REQUIREMENT', `${task.id} 不是需求（type=${task.type}）；TR-Q 只针对需求`, { id: task.id, type: task.type });
  }
  const rawVerdict = String(args.verdict || args.decision || '').trim().toLowerCase();
  const verdict = ({ testable: 'testable', '可测': 'testable', not_testable: 'not_testable', nottestable: 'not_testable', '不可测': 'not_testable' })[rawVerdict] || '';
  if (!verdict) fail('BAD_VERDICT', '--verdict 只能是 testable / not_testable');
  const project = loadProject(b.project);
  const doc = readRequirementDocs(project.path).list.find((row) => idMatches(row.id, task.id));
  if (!doc) {
    fail('MISSING_DOC', `需求 ${task.id} 没有可读正文（需求/R-*.md），无法做可测性评审`, { requirementId: task.id });
  }
  const outDir = path.join(project.path, '测试人员', '产出');
  ensureDir(outDir);
  const used = fs.readdirSync(outDir)
    .map((name) => new RegExp(`^可测性评审-${task.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-v(\\d+)\\.md$`, 'i').exec(name))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  const version = (used.length ? Math.max(...used) : 0) + 1;
  const rel = `测试人员/产出/可测性评审-${task.id}-v${version}.md`;
  const missing = String(args.missing || args['missing-items'] || '').split(/[；;\n]/).map((s) => s.trim()).filter(Boolean);
  const line = `结论：${verdict}`;
  const text = [
    `# 可测性评审（TR-Q）· ${task.id}`,
    '',
    `- 需求 id：${task.id}`,
    `- 依据需求哈希：${String(doc.hash).slice(0, 16)}（sha256 全量见 JSON 记录）`,
    `- 版本：v${version}`,
    `- 评审人：${b.role}`,
    `- 时间：${nowIso()}`,
    `- 文件：${rel}`,
    '',
    '## 结论',
    '',
    line,
    '',
    '## 缺项清单',
    '',
    missing.length ? missing.map((item) => `- ${item}`).join('\n') : '- （无）',
    '',
    '> 只评 AC 可判定/证据/边界异常可复现，不写测试计划、不替需求改 AC。',
    '',
  ].join('\n');
  if (text.length > 1200) {
    fail('TRQ_TOO_LONG', `TR-Q 一页上限 1200 字，当前 ${text.length} 字；请压缩缺项清单（不夹带测试计划）`, { length: text.length, max: 1200 });
  }
  writeText(path.join(project.path, rel), text);
  const at = nowIso();
  const trqReqVersion = versionForRecord(readRequirementDocVersion(project.path, task.id));
  const record = {
    requirementId: task.id,
    requirementHash: doc.hash,
    // R-9a8e F-rv-2：TR-Q 也绑三元组；reqVersion 是「需求正文版本」（与 TR-Q 自己的 version 分开）。
    reqVersion: trqReqVersion.version,
    reqChange: trqReqVersion.change,
    reqLegacy: Boolean(trqReqVersion.legacy),
    verdict,
    missing,
    file: rel,
    version,
    by: b.role,
    at,
    source: 'team.mjs req trq',
  };
  task.workflow = task.workflow && typeof task.workflow === 'object' ? task.workflow : {};
  task.workflow.trq = record;
  // B-20261117-013308-2a46：镜像任务上的 requirementStatus 是**旧值**（req trq 不改需求状态），
  // 以前直接拿它传给 syncWorkflowRow 会把工作流行从 ready 回退成 approved/review。
  // 这里保存镜像值，但最终落盘只允许「向前」：以工作流行当前 status 为准做 keepForwardStatus。
  const mirrorStatus = String(task.workflow.requirementStatus || 'review');
  task.workflow.requirementStatus = mirrorStatus;
  task.updatedAt = at;
  task._by = b.role;
  task._action = 'trq';
  task._note = truncate(`TR-Q ${verdict} v${version}`, 100);
  saveTask(b.project, task);
  // B-2a46（P1，PM 2026-11-17 01:36 修订口径①）：TR-Q 只写 trq 与 updatedAt，**不回写** requirementStatus。
  // B-20261117-015546-fe6d（P1，J1/J2/J3 三态分开；分析师 2026-11-17 01:55 判据补充；原单 B-6c08 已作废并入 fe6d）：
  //   J1 读到行 → 以 row.status 为准（镜像差异记 trq_status_ignored）；
  //   J2 读成功但行不存在 → 落 review（不得用 mirrorStatus 兜底）；
  //   J3 读抛错 → **不写工作流行**（保持原状态），只写 trq + trq_sync_skipped 审计，下次自然重试。
  let readOutcome = null; // 'ok' | 'missing' | 'failed'
  let currentRowStatus = '';
  let readErrorSummary = '';
  try {
    const readNow = readWorkflowState(b.project);
    const rowNow = readNow && readNow.state && readNow.state.requirements ? readNow.state.requirements[task.id] : null;
    if (rowNow && typeof rowNow === 'object') {
      readOutcome = 'ok';
      currentRowStatus = String(rowNow.status || '');
    } else {
      readOutcome = 'missing';
    }
  } catch (error) {
    readOutcome = 'failed';
    readErrorSummary = String((error && (error.code || error.message)) || error).slice(0, 200);
  }
  let sync = null;
  if (readOutcome === 'failed') {
    // J3：读失败时不碰工作流行（保持原状态不动），只落 trq + 审计；下次 req trq/推进时自然重试。
    try {
      appendEvent({
        role: b.role, sessionId: b.sessionId, action: 'trq_sync_skipped', project: b.project, target: task.id,
        note: `TR-Q 已落任务但未写工作流行（读工作流失败：${readErrorSummary}）；状态保持原样，下次重试`,
        data: { reason: 'read_failed', error: readErrorSummary, trqVerdict: verdict },
      });
    } catch { /* 审计写不了不能阻断 TR-Q 落库 */ }
  } else {
    const status = readOutcome === 'missing' ? 'review' : currentRowStatus;
    if (readOutcome === 'ok' && currentRowStatus && mirrorStatus !== currentRowStatus) {
      try {
        appendEvent({
          role: b.role, sessionId: b.sessionId, action: 'trq_status_ignored', project: b.project, target: task.id,
          note: `TR-Q 不回写需求状态：镜像任务 requirementStatus=${mirrorStatus}，工作流行=${currentRowStatus}（以工作流行为准）`,
          data: { mirrorStatus, currentRowStatus, trqVerdict: verdict },
        });
      } catch { /* 审计写不了不能阻断 TR-Q 落库 */ }
    }
    sync = syncWorkflowRow(b.project, task, status, { trq: record, teamMode: projectTeamMode(project) }, {
      create: true, action: 'trq', by: b.role, note: `TR-Q ${verdict} v${version}`,
    });
  }
  appendEvent({ role: b.role, sessionId: b.sessionId, action: 'trq', project: b.project, target: task.id, note: `${verdict} v${version}`, data: { trq: record } });
  out(args, `已记录可测性评审：${task.id} → ${verdict}（v${version}）\n文件：${path.join(project.path, rel)}\n结论：${verdict}${missing.length ? ' ｜ 缺项：' + missing.join('；') : ''}`, {
    ok: true, requirementId: task.id, trq: record, file: rel, workflowFile: sync ? sync.file : '', readFailed: readOutcome === 'failed',
  });
}

/**
 * 被驳回需求的出口：req iterate / req terminate。
 * 只改团队工具任务与 工作流.json 的需求行；不改阶段机里的其它需求。
 */
function cmdReqLifecycle(args, action) {
  const b = bootFor(args, `req ${action}`);
  if (b.role !== 'pm') fail('NOT_PM', `只有 PM 能决定需求 ${action === 'iterate' ? '进入下一次' : '终止'}`);
  if (!args.id) fail('BAD_ID', '需要 --id R-...');
  const task = loadTask(b.project, String(args.id));
  if (task.type !== 'requirement') {
    fail('NOT_REQUIREMENT', `${task.id} 不是需求（type=${task.type}）；req ${action} 只针对 req create 建的需求`, { id: task.id, type: task.type });
  }
  const reason = String(args.reason || args.comments || args.opinion || '').trim();
  // R-75ec AC9：终止/迭代的冻结必须发生在"关闭子任务"之前——否则子任务先被置 done 就再也冻结不到。
  // 先按动作冻结该需求未完成任务（blocked），syncWorkflowRow 会跳过 blocked 子任务。
  let freezeEffect = null;
  try {
    freezeEffect = applyOwnerDecisionEffects(b.project, task.id, action === 'iterate' ? 'iteration' : 'terminated', {
      row: null, by: b.role, source: 'cli', reason: truncate(reason || '', 200),
    });
  } catch (error) {
    gateWarn(b.project, { role: b.role, action: 'task_freeze', requirementId: task.id, attempted: `req ${action} freeze` }, {
      code: 'TASK_FREEZE_FAILED', gate: 'G3',
      missing: [String((error && error.message) || error).slice(0, 160)],
      next: '用 task show 核对任务状态；必要时补一次 req ' + action,
    });
  }
  const result = transitionRequirement({
    project: b.project, task, action, role: b.role, sessionId: b.sessionId, reason, force: Boolean(args.force),
  });
  // B-37ea：iterate 与 reopen 同口径——写门禁失效标记并推进 deliveryRound，
  // 否则返工后旧 rejected 仍挡验收、同状态决定被判 DUPLICATE_DECISION（2a69 实测）。
  if (action === 'iterate') {
    try {
      const stateNow = readWorkflowState(b.project, { fresh: true }).state || {};
      const reqs = stateNow.requirements || {};
      const row = reqs[task.id] || Object.values(reqs).find((r) => r && String(r.id || '') === task.id) || null;
      if (row) {
        const at = nowIso();
        const iterationRound = Number((result.requirement && result.requirement.workflow && result.requirement.workflow.iterationRound) || row.iterationRound || 0) || 0;
        row.gateInvalidatedAt = at;
        row.gateInvalidatedBy = 'iterate';
        row.iterationRound = iterationRound || row.iterationRound;
        row.deliveryRound = Math.max(Number(row.deliveryRound || 0), Number(row.iterationRound || 0), iterationRound, 1);
        if (row.trq && typeof row.trq === 'object') row.trq = { ...row.trq, verdictStale: true };
        writeWorkflowState(b.project, stateNow);
      }
    } catch { /* 标记失败不阻断 iterate 本身 */ }
  }
  // 终止后未消费的派单必须清掉，避免角色之后再被旧派单唤醒去做已终止需求。
  const queue = action === 'terminate'
    ? clearDispatchQueue(b.project, { reason: 'req_terminate', requirementId: task.id })
    : null;
  const human = action === 'iterate'
    ? `需求已进入下一次：${task.id}（当前）\n工作流：${result.workflowFile}`
    : `需求已终止：${task.id}\n关闭子任务 ${result.closedTasks.length} 个\n工作流：${result.workflowFile}${queue && queue.count ? `\n清理未消费派单：${queue.count} 条` : ''}`;
  out(args, human, {
    ok: true,
    action,
    requirement: result.requirement,
    workflowFile: result.workflowFile,
    workflow: result.workflow,
    closedTasks: result.closedTasks,
    ...(queue ? { dispatchQueue: queue } : {}),
    ...(freezeEffect ? { freezeEffect } : {}),
  });
}

// ========== Owner（外部角色 · 无 boot · 本机确认） ==========
// 工作台旧协议的 owner 命令：需求级决定（approved/skipped/rejected）与验收（--action accept）。
// Owner 不属于六角色，没有 boot；用 owner confirm 的一次性 nonce 证明“本机 Owner 已确认”。

const OWNER_TERMINAL = new Set(['accepted', 'terminated']);

/** 需求级决定只认 approved/skipped/rejected；验收只认 accepted/rejected。 */
function normalizeOwnerDecision(action, decision) {
  const raw = String(decision == null ? '' : decision).trim().toLowerCase();
  if (action === 'accept') {
    return ({ accepted: 'accepted', accept: 'accepted', approve: 'accepted', approved: 'accepted', reject: 'rejected', rejected: 'rejected' })[raw] || '';
  }
  return ({ approved: 'approved', approve: 'approved', skipped: 'skipped', skipped_by_owner: 'skipped', rejected: 'rejected', reject: 'rejected' })[raw] || '';
}

function ownerConfirmNonce(args) {
  return String(args['owner-confirm'] || args.ownerConfirm || args.confirm || '').trim();
}

/**
 * Owner 验收前的测试闸门：该需求名下必须有测试任务且全部 done。
 * 只读；不写任何状态。返回 {ok, code, message, mode, taskIds, missing}。
 */
export function ownerTestGate(projectName, requirementId) {
  const children = listTasks(projectName).filter((row) => row
    && String(row.id) !== String(requirementId)
    && String(row.requirementId || '') === String(requirementId));
  const testTasks = children.filter((row) => String(row.owner || '') === 'tester'
    || String((row.workflow && row.workflow.stage) || '') === 'test'
    || /测试/.test(String(row.title || '')));
  if (!testTasks.length) {
    return {
      ok: false,
      code: 'TEST_NOT_DONE',
      message: `需求 ${requirementId} 没有测试任务；测试 done 后才能 Owner 验收`,
      requirementId,
      taskIds: [],
    };
  }
  const open = testTasks.filter((row) => !statusIsClosed(row.status));
  if (open.length) {
    return {
      ok: false,
      code: 'TEST_NOT_DONE',
      message: `需求 ${requirementId} 的测试任务还没完成：${open.map((row) => row.id).join(', ')}`,
      requirementId,
      taskIds: testTasks.map((row) => row.id),
      open: open.map((row) => row.id),
    };
  }
  // B-20261115-184535-c98e：验收门第二道——需求名下不得有未完成子任务（开发/补单/复测/签章类），
  // 否则需求收口后账本分叉（75 条终态需求里 12 条仍有 open 任务）。保留 TEST_NOT_DONE 语义，两道门分开报码。
  const leftover = children.filter((row) => !statusIsClosed(row.status));
  if (leftover.length) {
    return {
      ok: false,
      code: 'REQ_HAS_OPEN_TASKS',
      message: '需求 ' + requirementId + ' 名下还有未完成任务：' + leftover.map((row) => row.id + ' ' + String(row.title || '').trim()).join('、'),
      requirementId,
      taskIds: leftover.map((row) => row.id),
      open: leftover.map((row) => row.id),
    };
  }
  return { ok: true, mode: 'tasks', taskIds: testTasks.map((row) => row.id) };
}

/**
 * Owner 决定的依据（basis）：需求正文路径+sha256，设计文件路径+版本+sha256。
 * fast 无产品设计，用需求分析 vN 作为设计依据；都没有时留空并在 reason 里写明原因。
 */
/**
 * B-7738（Owner 2026-11-14 报）：验收打回必须自动落一张缺陷单。
 * 以前 Owner 点「打回」只把需求打回（rejected），「为什么打回 / 缺什么 / 谁修」全丢在口头里。
 * 这里统一在建单侧补齐三件事：
 *   1) title = 「验收打回：<需求号> <打回原因摘要>」，type=bug 并绑定 requirementId；
 *   2) acceptance 写死「修复后要交什么」（测试报告 + 截图），detail 里逐条写「缺什么」；
 *   3) Owner 打回意见全文进 detail。
 * 幂等：同一条需求 + 同一打回时刻只建一次（键落在任务的 workflow.acceptRejectKey）。
 * 失败不阻断打回落账：由调用方 try/catch 记事件。
 */
function autoCreateAcceptRejectBug({ projectName, project, requirementId, row, task, opinion, at, decisionIndex }) {
  const reason = String(opinion || '').replace(/\s+/g, ' ').trim();
  const key = `${requirementId}|${at}`;
  const existing = listTasks(projectName).find((item) => item && item.type === 'bug'
    && String((item.workflow && item.workflow.acceptRejectKey) || '') === key);
  if (existing) return { ok: true, reused: true, taskId: existing.id, key };
  const summary = reason ? (reason.length > 40 ? reason.slice(0, 40) + '…' : reason) : '未写打回原因';
  const ownerRole = String((row && row.owner) || (task && task.owner) || '').trim();
  const priority = ['P0', 'P1', 'P2', 'P3'].includes(String((row && row.priority) || '')) ? String(row.priority) : 'P1';
  // 「缺什么」：把验收时该有而没有的证据逐条点名（不猜、不写空话）。
  const missing = [];
  const acceptanceRecord = (row && row.acceptanceRecord) || (task && task.acceptanceRecord) || null;
  const existingEvidence = acceptanceRecord && Array.isArray(acceptanceRecord.evidence) ? acceptanceRecord.evidence : [];
  const hasReport = existingEvidence.some((item) => String(item && item.kind) === 'report')
    || Boolean(acceptanceRecord && acceptanceRecord.testReport);
  const hasShot = existingEvidence.some((item) => String(item && item.kind) === 'image');
  if (!hasReport) missing.push('测试报告（含 PASS、不含 FAIL）');
  if (!hasShot) missing.push('界面截图');
  if (!existingEvidence.length) missing.push('验收记录里的证据清单（acceptanceRecord.evidence 为空）');
  const detail = [
    '【验收打回自动建单】B-7738',
    `需求：${requirementId}`,
    `打回时间：${at}${Number.isInteger(decisionIndex) ? '（决定序号 ' + decisionIndex + '）' : ''}`,
    `打回人：Owner${acceptanceRecord && acceptanceRecord.channel === 'proxy' ? '（PM 代记）' : ''}`,
    '',
    'Owner 打回原话：',
    reason || '（Owner 未写原因——需要 PM 补齐再派）',
    '',
    '缺什么（验收时该有而没有）：',
    ...missing.map((item) => '· ' + item),
    '',
    `谁修：${ownerRole || '待 PM 指派（需求行没有负责人）'}`,
    '修好后怎么交：需求回到 test_done → 缺陷单附测试报告（PASS）+ 截图 → Owner 再验收。',
  ].join('\n');
  const bug = createTask({
    project: projectName,
    title: `验收打回：${requirementId} ${summary}`,
    detail,
    priority,
    priorityBy: 'owner',
    createdBy: 'owner',
    owner: ownerRole || null,
    type: 'bug',
    requirementId,
    acceptance: '修复后必须附：①测试报告（含 PASS、不含 FAIL）②界面截图；两件套齐才算修好，验收时用 --evidence <报告>:report 落 acceptanceRecord。',
    repro: reason || '（Owner 未写复现原因）',
    expected: '修复后需求能重新走到 test_done 并通过 Owner 验收',
    actual: 'Owner 在验收里打回，需求被退回 rejected',
  });
  bug.workflow = {
    ...(bug.workflow && typeof bug.workflow === 'object' ? bug.workflow : {}),
    stage: 'accept_reject',
    acceptRejectKey: key,
    acceptRejectFor: requirementId,
    acceptRejectAt: at,
    source: 'owner_accept_reject',
    missing,
  };
  saveTask(projectName, bug);
  appendEvent({
    role: 'owner', action: 'accept_reject_bug_created', project: projectName,
    target: bug.id, note: truncate(`验收打回自动建缺陷单：${requirementId} → ${bug.id}`, 160),
    data: { requirementId, bugId: bug.id, key, missing, priority, owner: ownerRole || null, createdAt: at },
  });
  return { ok: true, reused: false, taskId: bug.id, key, missing };
}

function buildOwnerBasis(projectName, project, task, teamMode) {
  const base = path.resolve(project.path);
  let requirement = { path: '', sha256: '', contentHash: '' };
  try {
    const docs = readRequirementDocs(base);
    const doc = docs.list.find((row) => idMatches(row.id, task.id));
    if (doc) requirement = { path: doc.rel, sha256: doc.hash, contentHash: doc.contentHash || '' };
  } catch { /* 保持空 */ }
  const pick = (dirRel, pattern) => {
    const dir = path.join(base, dirRel);
    let names = [];
    try { names = fs.readdirSync(dir).filter((name) => pattern.test(name)); } catch { return null; }
    const rows = names.map((name) => ({
      name,
      version: Number((/-v(\d+)\.md$/i.exec(name) || [])[1] || 0),
      mtime: fs.statSync(path.join(dir, name)).mtimeMs,
    })).sort((a, b) => (b.version - a.version) || (b.mtime - a.mtime));
    if (!rows.length) return null;
    const file = path.join(dir, rows[0].name);
    return { path: `${dirRel}/${rows[0].name}`, version: `v${rows[0].version}`, sha256: sha256(fs.readFileSync(file)) };
  };
  const design = teamMode === 'fast'
    ? (pick('需求分析师/产出', /^需求分析-v\d+\.md$/i) || { path: '', version: '', sha256: '', reason: 'fast 无产品设计，暂无可引用的需求分析版本' })
    : (pick('产品/产出', /^(02-)?产品设计-v\d+\.md$/i) || { path: '', version: '', sha256: '', reason: '暂无产品设计文件' });
  return { requirement, design, at: nowIso() };
}

function cmdOwnerConfirm(args) {
  // R-2e6b：Owner 确认 PM 自归档（owner confirm --archive A-...），写 confirmedAt=确认时间。
  if (args.archive) {
    const projectName = String(args.project || '').trim();
    if (!projectName) fail('BAD_ARGS', '需要 --project <团队项目名>');
    loadProject(projectName);
    const r = confirmArchive({ projectName, archiveId: String(args.archive), by: 'owner' });
    out(args, `已确认归档 ${r.record.id}：confirmedAt=${r.record.confirmedAt}`, { ok: true, ...r });
    return;
  }
  const projectName = String(args.project || '').trim();
  if (!projectName) fail('BAD_ARGS', '需要 --project <团队项目名>');
  loadProject(projectName);
  const requirementId = String(args.requirement || '').trim();
  if (!requirementId) fail('BAD_ARGS', '需要 --requirement R-...');
  const actionRaw = String(args.action || '').trim().toLowerCase();
  if (actionRaw && actionRaw !== 'accept') {
    fail('BAD_ACTION', '--action 只支持 accept（Owner 验收）', { action: actionRaw, allowed: ['accept'] });
  }
  const decision = normalizeOwnerDecision(actionRaw || 'review', args.decision);
  if (!decision) {
    fail('OWNER_DECISION_INVALID', actionRaw === 'accept'
      ? '验收时 --decision 必须是 accepted 或 rejected'
      : 'Owner 决定必须是 approved / skipped / rejected', {
      decision: String(args.decision || ''),
      allowed: actionRaw === 'accept' ? ['accepted', 'rejected'] : ['approved', 'skipped', 'rejected'],
    });
  }
  const testOwner = Boolean(args['test-owner'] || args.testOwner);
  const channelArg = String(args.channel || '').trim().toLowerCase();
  let channel = 'tty';
  if (testOwner) {
    // --test-owner 只给自测用；生产必须真实终端，不能靠环境变量绕过。
    if (String(process.env.TEAM_SELFTEST || '') !== '1') {
      fail('OWNER_TTY_REQUIRED', '--test-owner 只在 TEAM_SELFTEST=1 的自测里可用；真实终端请直接运行 owner confirm', {
        hint: 'Owner 界面确认用 --channel ui；终端确认请在真实 TTY 运行',
      });
    }
    channel = 'test';
  } else if (channelArg) {
    if (!['ui', 'tty'].includes(channelArg)) {
      fail('OWNER_CHANNEL_INVALID', `Owner 决定通道只允许 ui / tty（收到 ${channelArg}）；workbench/test 不得用于验收`, {
        channel: channelArg, allowed: ['ui', 'tty'],
      });
    }
    if (channelArg === 'tty' && !process.stdin.isTTY) {
      fail('OWNER_TTY_REQUIRED', '--channel tty 必须在真实终端运行（当前没有 TTY）；界面确认请用 --channel ui', { tty: false });
    }
    channel = channelArg;
  } else if (!process.stdin.isTTY) {
    fail('OWNER_TTY_REQUIRED', 'owner confirm 必须在真实终端运行（当前没有 TTY）；界面确认请加 --channel ui，自测用 --test-owner', {
      tty: false, allowed: ['ui', 'tty'],
    });
  }
  const ttlMs = args.ttl ? Number(args.ttl) * 1000 : undefined;
  const record = issueOwnerConfirmation({
    project: projectName, requirementId, decision, action: actionRaw, channel, ttlMs,
  });
  out(args, [
    `Owner 确认码已签发 · ${requirementId}（${decision}${actionRaw ? ' / ' + actionRaw : ''}）`,
    `项目：${projectName} ｜ 渠道：${channel} ｜ 过期：${record.expiresAt}`,
    `确认码：${record.nonce}`,
    `下一步：node 团队\\工具\\team.mjs owner --project "${projectName}" --requirement "${requirementId}" --decision "${decision}"${actionRaw ? ' --action accept' : ''} --opinion "..." --owner-confirm ${record.nonce} --json`,
  ].join('\n'), {
    ok: true,
    confirmation: record,
    nonce: record.nonce,
    project: projectName,
    requirementId,
    decision,
    action: actionRaw,
    expiresAt: record.expiresAt,
    channel,
  });
}

/**
 * Owner 决定 / 验收。Owner 是外部角色，没有 boot；必须先有 owner confirm 的一次性确认码。
 * 只写需求任务、工作流.json 与事件链；需求正文/总览由工作台壳层消费返回值后同步。
 */
/**
 * R-43ad F-43ad-3 / AC2（T-f203）：缺陷单（bug / scenario-bug）验收。
 * 落点写死任务行：task.acceptanceRecord = {status, by, channel, at, evidence[], testReport}；
 * 不建镜像需求行、不动需求行 decisions[]；`acceptance`（验收标准字符串）原样不改。
 * 门槛与 PM 代验收同码：缺测试报告/证据 → PM_ACCEPT_EVIDENCE_REQUIRED（Owner 通道不放宽）。
 */
function acceptDefectTask(args, { project, projectName, task, decision, opinion, proxyMode, asRole }) {
  const at = nowIso();
  const actor = String(asRole || '').trim().toLowerCase();
  // R-62b9（增补卷-62b9-1 §四 E1/E2）：测试/PM 直接验收缺陷**不要求代管**；owner 走原 ui/tty 通道。
  if (actor && !['pm', 'tester', 'owner'].includes(actor)) {
    fail('ACCEPT_ROLE_INVALID', `缺陷验收操作者只能是 pm / tester / owner（收到 ${actor}）`, { as: actor, allowed: ['pm', 'tester', 'owner'] });
  }
  const channelArg = String(args.channel || '').trim().toLowerCase();
  let channel = 'ui';
  if (proxyMode) {
    channel = 'proxy';
    const reqId = String(task.requirementId || '').trim();
    if (!reqId) fail('PROXY_UNAUTHORIZED', '缺陷单没有绑需求，代管不适用；缺陷验收必须 Owner 本人', { taskId: task.id });
    const proxy = activeProxyFor(projectName, reqId);
    if (!proxy) fail('PROXY_UNAUTHORIZED', `需求 ${reqId} 没有未结束的评审代管，不能代验收缺陷单`, { taskId: task.id, requirementId: reqId });
  } else if (actor === 'pm') {
    channel = 'pm';
  } else if (actor === 'tester') {
    channel = 'test';
  } else if (channelArg) {
    if (!['ui', 'tty'].includes(channelArg)) {
      fail('OWNER_CHANNEL_INVALID', `Owner 验收通道只允许 ui / tty（收到 ${channelArg}）`, { channel: channelArg, allowed: ['ui', 'tty'] });
    }
    if (channelArg === 'tty' && !process.stdin.isTTY) {
      fail('OWNER_TTY_REQUIRED', '--channel tty 必须在真实终端运行；界面确认请用 --channel ui', { tty: false });
    }
    channel = channelArg;
  }
  const items = parseEvidenceArg(args.evidence);
  const verdict = validatePmAcceptEvidence({ items, projectPath: project.path });
  const report = verdict.evidence.find((item) => String(item.kind) === 'report');
  if (!report) {
    fail('PM_ACCEPT_EVIDENCE_REQUIRED', '缺陷单验收必须带测试报告（含 PASS、不含 FAIL）：--evidence <报告>:report', {
      taskId: task.id,
      missing: verdict.missing.length ? verdict.missing : [{ kind: 'report', path: '', reason: 'TEST_REPORT_REQUIRED' }],
    });
  }
  if (verdict.evidence.length < 2) {
    // B-e616：把校验层的逐项原因（FILE_NOT_FOUND / EMPTY_PATH / HASH_MISMATCH / EVIDENCE_OUTSIDE_PROJECT）
    // 一并带出，否则「文件缺失」只能看到笼统的 SECOND_EVIDENCE_REQUIRED，调用方无法定位是哪个文件。
    fail('PM_ACCEPT_EVIDENCE_REQUIRED', '缺陷单验收证据两件套：测试报告 + 至少一件其它证据（截图/记录）', {
      taskId: task.id,
      missing: [{ kind: 'screenshot|record', path: '', reason: 'SECOND_EVIDENCE_REQUIRED' }].concat(verdict.missing),
      given: verdict.evidence.map((item) => `${item.path}#${item.kind}`),
    });
  }
  const accepted = String(decision) === 'accepted';
  // 落账人：代管=pm、PM 直接验收=pm/pm、测试直验=tester/test、其余=owner（§四 三条入口同一字段）
  const byRole = proxyMode ? 'pm' : (actor === 'pm' ? 'pm' : (actor === 'tester' ? 'tester' : 'owner'));
  const record = {
    status: String(decision),
    by: byRole,
    channel,
    at,
    opinion: truncate(opinion, 300),
    evidence: verdict.evidence.map((item) => ({ path: item.path, sha256: item.sha256, kind: item.kind })),
    testReport: String(report.path || ''),
  };
  task.acceptanceRecord = record;
  task.workflow = task.workflow && typeof task.workflow === 'object' ? task.workflow : {};
  task.workflow.acceptanceRecord = record;
  if (accepted) {
    task.status = 'accepted';
    task.acceptedAt = at;
    task.updatedAt = at;
  } else {
    // 打回：reopenCount+1，回开发队列（b5fc 缺陷旁路），证据清空等下轮修完再交。
    task.status = task.owner ? 'working' : 'open';
    task.reopenCount = Number(task.reopenCount || 0) + 1;
    task.reopenedAt = at;
    task.reopenedBy = byRole;
    task.updatedAt = at;
  }
  task._by = byRole;
  task._action = accepted ? 'defect_accept' : 'defect_reject';
  task._note = truncate(opinion || (accepted ? '缺陷单验收通过' : '缺陷单验收打回'), 200);
  const saved = saveTask(projectName, task);
  appendEvent({
    role: byRole, sessionId: sessionOf(args), action: accepted ? 'defect_accepted' : 'defect_rejected',
    project: projectName, target: saved.id,
    note: truncate(`${saved.type} ${accepted ? '验收通过' : '验收打回'}${proxyMode ? '（PM 代记）' : ''}`, 160),
    data: { taskId: saved.id, status: decision, channel, testReport: record.testReport, evidence: record.evidence, reopenCount: saved.reopenCount || 0 },
  });
  out(args, [
    `${saved.id}（${saved.type}）验收${accepted ? '通过' : '打回'}（${proxyMode ? 'PM 代记' : 'Owner'}，通道 ${channel}）`,
    `测试报告：${record.testReport}`,
    `证据 ${record.evidence.length} 件：${record.evidence.map((item) => `${item.kind}:${item.path}`).join('，')}`,
    accepted ? '任务已置 accepted（不再进开发队列）' : `已打回 → ${saved.owner || '待认领'}（reopenCount=${saved.reopenCount}）`,
    `验收标准保持原样：${String(saved.acceptance || '（空）').slice(0, 80)}`,
  ].join('\n'), {
    ok: true, task: saved, acceptanceRecord: record, channel, by: record.by,
    action: accepted ? 'accept' : 'reject', requirementRowsTouched: 0,
  });
}

export async function cmdOwner(args) {
  const sub = String(args._[1] || '').trim().toLowerCase();
  if (sub === 'confirm') { cmdOwnerConfirm(args); return; }
  if (sub) fail('BAD_SUBCOMMAND', `未知 owner 子命令：${sub}（owner 直接执行，确认用 owner confirm）`);
  // PM 代管落账（T-a01d）：由 cmdOwnerProxyDecide 注入 --proxy-recorded-by pm，跳过 confirm nonce、通道固定 proxy。
  const proxyMode = String(args['proxy-recorded-by'] || '').trim() === 'pm';

  const projectName = String(args.project || '').trim();
  if (!projectName) fail('BAD_ARGS', '需要 --project <团队项目名>');
  const project = loadProject(projectName);
  const requirementId = String(args.requirement || '').trim();
  if (!requirementId) fail('BAD_ARGS', '需要 --requirement R-...');
  const actionRaw = String(args.action || '').trim().toLowerCase();
  if (actionRaw && actionRaw !== 'accept') {
    fail('BAD_ACTION', '--action 只支持 accept（Owner 验收）', { action: actionRaw, allowed: ['accept'] });
  }
  const decision = normalizeOwnerDecision(actionRaw || 'review', args.decision);
  if (!decision) {
    fail('OWNER_DECISION_INVALID', actionRaw === 'accept'
      ? '验收时 --decision 必须是 accepted 或 rejected'
      : 'Owner 决定必须是 approved / skipped / rejected', {
      decision: String(args.decision || ''),
      allowed: actionRaw === 'accept' ? ['accepted', 'rejected'] : ['approved', 'skipped', 'rejected'],
    });
  }
  if (args.opinion === undefined || args.opinion === null) {
    fail('OPINION_REQUIRED', '需要 --opinion "Owner 意见"（可以为空字符串，但必须显式给出）');
  }
  const opinion = truncate(String(args.opinion || '').trim(), 1000);
  // 四条硬门③：Owner 跳过必须带分析师/产品/开发三方书面评估（壳层会把三方拼进 --opinion）。
  if (decision === 'skipped') {
    const need = ['分析师', '产品', '开发'];
    const lack = need.filter((name) => !new RegExp(`${name}\\s*[：:]\\s*\\S`).test(opinion));
    if (lack.length) {
      fail('SKIP_ASSESSMENT_REQUIRED', `Owner 跳过必须先有三方书面评估：缺 ${lack.join('、')}；--opinion 按「分析师：… / 产品：… / 开发：…」写`, { missing: lack, requirementId });
    }
  }
  // R-51de F-5⑤（前置）：验收门禁放在 loadTask 之前——未读时优先报 LESSONS_UNREAD，
  // 而不是先被 NOT_REQUIREMENT / PRODUCT_REVIEW_REQUIRED 遮住（tester 注记 2026-11-16）。
  if (actionRaw === 'accept') failLessonGate(lessonGateFor(ownerGateBoot(args, projectName), args));
  const teamMode = projectTeamMode(project);
  const task = loadTask(projectName, requirementId);
  const defectTask = ['bug', 'scenario-bug'].includes(String(task.type || ''));
  if (task.type !== 'requirement' && !defectTask) {
    fail('NOT_REQUIREMENT', `${requirementId} 不是需求（type=${task.type}），Owner 命令只处理需求`, { id: requirementId, type: task.type });
  }
  // R-43ad F-43ad-3 / AC2（T-f203）：缺陷单验收走独立分支——任务行落 acceptanceRecord，
  // 不建镜像需求行、不碰需求行 decisions[]；门槛与 PM 代验收同码（缺测试报告 → PM_ACCEPT_EVIDENCE_REQUIRED）。
  if (defectTask) {
    acceptDefectTask(args, { project, projectName, task, decision, opinion, proxyMode });
    return;
  }
  // B-20261116-105213-bd22：需求验收只能 Owner 本人——代管通道（--proxy-recorded-by pm）一律拒，
  // 这里是第二道保险：即使有别的调用点注入了 proxy 标记，也走不到写盘。
  if (proxyMode && actionRaw === 'accept') {
    fail('PROXY_ACCEPT_FORBIDDEN', '需求验收只能 Owner 本人：代管不得代需求验收（缺陷单验收走 task accept）', { requirementId });
  }
  const read = readWorkflowState(projectName);
  let row = read.state.requirements[requirementId];
  if (row && OWNER_TERMINAL.has(String(row.status || ''))) {
    fail('REQUIREMENT_STATE_INVALID', `需求 ${requirementId} 已经是 ${row.status}，不能再做 Owner 决定`, {
      requirementId, status: row.status,
    });
  }
  // 产品闸门：Owner 不能跳过需求评审。full=product，fast=analyst，两者都写 productReview 同形字段。
  const review = (task.workflow && (task.workflow.productReview || task.workflow.requirementReview))
    || (row && (row.productReview || row.requirementReview)) || task.review || null;
  if (!review || String(review.verdict || '') !== 'approve') {
    fail('PRODUCT_REVIEW_REQUIRED', `需求 ${requirementId} 还没有需求评审通过，Owner 不能跳过评审闸门`, {
      requirementId,
      review: review || null,
      hint: '先运行 req review --verdict approve --comments "..."',
    });
  }
  let testGate = null;
  if (actionRaw === 'accept') {
    // 验收前 Owner 决定必须已通过/跳过；被 Owner 打回的需求不能直接验收。
    // B-96e9：只认“当前有效”的最近一条决定（忽略早于 gateInvalidatedAt 的旧打回），不再只看 legacy ownerReview。
    const latestOwner = latestValidOwnerDecision(row);
    const ownerStatus = String((latestOwner && (latestOwner.status || latestOwner.decision)) || '');
    if (ownerStatus && !['approved', 'skipped', 'accept', 'accepted'].includes(ownerStatus)) {
      fail('REQUIREMENT_STATE_INVALID', `需求 ${requirementId} 的 Owner 决定是 ${ownerStatus}，不能验收`, {
        requirementId, ownerReview: row.ownerReview,
      });
    }
    const lifecycleStatus = String((row && row.status) || '');
    if (!['test', 'test_done', 'dev_done'].includes(lifecycleStatus)) {
      fail('REQUIREMENT_STATE_INVALID', `需求 ${requirementId} 当前状态是 ${lifecycleStatus}，测试阶段完成后才能 Owner 验收`, {
        requirementId, status: lifecycleStatus, allowed: ['test', 'test_done', 'dev_done'],
      });
    }
    // R-b52b F-8：roleIds 不含 tester（无测试角色）时，验收前置从「测试任务 done」改为
    // 「测试报告 + 截图存在且报告 PASS」，并在落账记 signedBy=pm / testGate=pm_signed；证据一件不能少。
    const acceptRoleIds = projectRoleIds(project);
    const noTester = !acceptRoleIds.includes('tester');
    if (noTester) {
      testGate = { ok: true, mode: 'pm_signed', reason: 'roleIds 不含 tester：测试结论由 PM 代签，证据两件套仍必须齐' };
      try {
        appendEvent({
          role: 'pm', sessionId: sessionOf(args), action: 'accept_test_gate_pm_signed', project: projectName,
          target: requirementId, note: `roleIds=${acceptRoleIds.join(',')} 无 tester，验收改判证据两件套`,
        });
      } catch { /* 留痕失败不阻断验收 */ }
    } else {
      testGate = ownerTestGate(projectName, requirementId);
    }
    if (!testGate.ok) {
      fail(testGate.code, testGate.message, {
        requirementId, taskIds: testGate.taskIds || [], open: testGate.open || [],
      });
    }
  }

  // 旧项目可能只有任务/正文、没有工作流行：先按任务补一行最小记录（不伪造评审结论）。
  // 正常 req review 已经 create:true，不会走到这里。
  if (!row) {
    const recovered = syncWorkflowRow(projectName, task, String(task.workflow.requirementStatus || 'review'), {
      teamMode,
      ...(task.workflow.productReview ? { productReview: task.workflow.productReview } : {}),
      ...(task.workflow.requirementReview ? { requirementReview: task.workflow.requirementReview } : {}),
      ...(task.workflow.techReview ? { techReview: task.workflow.techReview } : {}),
    }, {
      create: true,
      action: 'owner_recover_row',
      by: 'system',
      note: 'Owner 命令前按任务补建工作流行',
      phase: 'requirement_review',
    });
    row = recovered.state && recovered.state.requirements[requirementId];
  }

  // 幂等：同一 basis 的同一 Owner 决定已落账 → 不需要新 nonce、不重复 append，只把状态往前同步。
  const idem = args.force ? null : idempotentOwnerDecision({ projectName, project, task, row, decision, actionRaw, teamMode });
  if (idem) {
    const at = nowIso();
    task.workflow = task.workflow && typeof task.workflow === 'object' ? task.workflow : {};
    task.workflow.requirementStatus = idem.nextStatus;
    if (idem.nextStatus === 'accepted') {
      task.status = 'done';
      task.doneAt = task.doneAt || at;
    }
    task.updatedAt = at;
    task._by = 'Owner';
    task._action = 'owner_idempotent';
    task._note = truncate(`${decision}（同 basis 幂等）`, 100);
    saveTask(projectName, task);
    const phaseBy = { ready: 'dispatch', tech_review: 'tech_review', accepted: 'accepted', rejected: 'requirement_review' };
    const sync = syncWorkflowRow(projectName, task, idem.nextStatus, {
      teamMode,
      ...(actionRaw === 'accept' ? {} : { ownerReview: idem.latest }),
    }, {
      create: false,
      action: 'owner_idempotent',
      by: 'Owner',
      note: '同 basis 幂等：不重复落账',
      phase: phaseBy[idem.nextStatus] || '',
    });
    appendEvent({
      role: 'owner', sessionId: 'owner-idempotent', action: 'owner_idempotent', project: projectName,
      target: requirementId, note: `${decision} ${idem.currentStatus}→${idem.nextStatus}`,
      data: { decisionIndex: idem.latest.decisionIndex, nextStatus: idem.nextStatus },
    });
    out(args, [
      `Owner ${actionRaw === 'accept' ? '验收' : '决定'}幂等：${requirementId} → ${decision}（同 basis 已落账，不重复 append）`,
      `需求状态：${idem.currentStatus} → ${idem.nextStatus} ｜ 决定链仍 ${ownerDecisionList(row, task).length} 条`,
      `工作流：${sync.file}`,
    ].join('\n'), {
      ok: true, idempotent: true, project: projectName, requirementId, decision,
      decisions: ownerDecisionList(row, task), basis: idem.basis,
      previousStatus: idem.currentStatus, status: idem.nextStatus, workflowFile: sync.file,
    });
    return;
  }

  const nonce = ownerConfirmNonce(args);
  // AC-O6：显式期望的决定链长度不一致 → 说明有人并发追加过，后写者拒绝（不双写、不覆盖）。
  if (args['expect-decisions'] !== undefined) {
    const expected = Number(args['expect-decisions']);
    const actual = ownerDecisionList(row, task).length;
    if (Number.isFinite(expected) && expected !== actual) {
      fail('OWNER_DECISION_CONFLICT', `Owner 决定链已被并发追加（期望 ${expected} 条，实际 ${actual} 条）；请重开确认后重试`, {
        project: projectName, requirementId, expected, actual,
      });
    }
  }
  // PM 代管落账（T-a01d）：Owner 已授权代管时，PM 代记 Owner 的决定；不走 confirm nonce，通道固定 proxy。
  let proxyRecord = null;
  // B-9400：PM 代验收（与工作台 IPC 对齐）——有效代管 + 证据（共用 pm-accept-evidence.mjs）才可；
  // 证据校验必须在任何写盘之前完成，缺项直接 PM_ACCEPT_EVIDENCE_REQUIRED 且零副作用。
  let proxyAcceptEvidence = null;
  if (proxyMode) {
    // R-7849：代管生命周期（scope=all / expiresAt / 幂等）由 owner-proxy.mjs 统一判定；
    // 过期 → PROXY_EXPIRED，已结束/不存在 → PROXY_UNAUTHORIZED，缺授权 → PROXY_UNAUTHORIZED。
    const rawProxy = activeProxyFor(projectName, requirementId);
    if (actionRaw === 'accept' && !rawProxy) {
      fail('PROXY_ACCEPT_FORBIDDEN', '代管已结束（或未开启），不能代验收；请 Owner 本人验收或重新开启代管', { requirementId });
    }
    proxyRecord = assertProxyUsable(rawProxy, { requirementId });
    if (actionRaw === 'accept') {
      // 代管只能代「验收通过」；打回/迭代/终止仍必须 Owner 本人。
      if (String(decision) !== 'accepted') {
        fail('PROXY_ACCEPT_FORBIDDEN', '代管只能代验收通过（accepted）；打回/迭代/终止必须 Owner 本人执行', { decision });
      }
      const items = parseEvidenceArg(args.evidence);
      const verdict = validatePmAcceptEvidence({ items, projectPath: project.path });
      const gateMissing = verdict.ok
        ? validateAcceptGates({
          evidence: verdict.evidence,
          trqVerdict: String((row && row.trq && row.trq.verdict) || (task.workflow && task.workflow.trq && task.workflow.trq.verdict) || ''),
          requirementStatus: String((row && row.status) || (task.workflow && task.workflow.status) || ''),
        }).missing
        : [];
      if (!verdict.ok || gateMissing.length) {
        const code = !verdict.ok && verdict.code === 'EVIDENCE_OUTSIDE_PROJECT'
          ? 'EVIDENCE_OUTSIDE_PROJECT'
          : 'PM_ACCEPT_EVIDENCE_REQUIRED';
        fail(code, code === 'EVIDENCE_OUTSIDE_PROJECT'
          ? '验收证据必须在项目目录内（项目外路径一律拒收）'
          : 'PM 代验收四门槛：测试报告 ≥1、截图 ≥1、TR-Q=testable、需求 test_done；缺一不可且零副作用', {
          requirementId, missing: [...verdict.missing, ...gateMissing], maxItems: 12,
          gates: ['report', 'screenshot', 'trq', 'status'],
        });
      }
      proxyAcceptEvidence = verdict.evidence;
    }
  }
  // G2.5：只拦“通过/开发”——打回、跳过、验收不受可测性评审限制。
  // Owner 实测：25b7 是 not_testable，连“打回”都被 G2.5 拦住，门把自己锁死了。
  if (actionRaw !== 'accept' && decision === 'approved') {
    const trqGate = gateTestability({ projectPath: project.path, task, row });
    if (trqGate) {
      const hard = String(task.priority || '').toUpperCase() === 'P0' || gateConfig(project).testability === 'all';
      if (hard || trqGate.reason === 'not_testable') {
        gateFail(projectName, { role: 'owner', action: 'owner_decision', requirementId, attempted: 'owner' }, trqGate);
      }
      gateWarn(projectName, { role: 'owner', action: 'owner_decision', requirementId, attempted: 'owner' }, trqGate);
    }
  }
  let confirmation = null;
  if (!proxyMode) {
    const nonce = ownerConfirmNonce(args);
    // AC-O6：显式期望的决定链长度不一致 → 说明有人并发追加过，后写者拒绝（不双写、不覆盖）。
    if (args['expect-decisions'] !== undefined) {
      const expected = Number(args['expect-decisions']);
      const actual = ownerDecisionList(row, task).length;
      if (Number.isFinite(expected) && expected !== actual) {
        fail('OWNER_DECISION_CONFLICT', `Owner 决定链已被并发追加（期望 ${expected} 条，实际 ${actual} 条）；请重开确认后重试`, {
          project: projectName, requirementId, expected, actual,
        });
      }
    }
    confirmation = consumeOwnerConfirmation({
      nonce, project: projectName, requirementId, decision, action: actionRaw, channel: args.channel ? String(args.channel) : '',
    });
    if (!confirmation) {
      fail('OWNER_CONFIRM_REQUIRED', 'Owner 操作需要本机确认：先运行 owner confirm 签发一次性确认码，再带 --owner-confirm 重试', {
        project: projectName,
        requirementId,
        decision,
        action: actionRaw,
        hint: ownerConfirmHint({ project: projectName, requirementId, decision, action: actionRaw }),
      });
    }
  }

  const at = nowIso();
  let channel;
  let testChannel = false;
  let confirmationMeta;
  if (proxyMode) {
    channel = 'proxy';
    confirmationMeta = {
      channel: 'proxy',
      at,
      recordedBy: 'pm',
      proxyScope: String(proxyRecord.scope || ''),
      proxyStartedAt: String(proxyRecord.startedAt || ''),
      authorization: String(proxyRecord.authorization || ''),
    };
  } else {
    // 通道只允许 ui / tty；test 仅 TEAM_SELFTEST=1 且不计入验收；workbench 一律拒绝。
    channel = String(confirmation.channel || '').trim();
    testChannel = channel === 'test';
    if (testChannel && String(process.env.TEAM_SELFTEST || '') !== '1') {
      fail('OWNER_CHANNEL_INVALID', '测试通道（--test-owner）只在 TEAM_SELFTEST=1 的自测里可用；生产必须走 ui 或 tty', { channel });
    }
    if (!['ui', 'tty', 'test'].includes(channel)) {
      fail('OWNER_CHANNEL_INVALID', `Owner 决定通道必须是 ui 或 tty（当前 ${channel || '(空)'}）；workbench/test 不得用于验收`, {
        channel, allowed: ['ui', 'tty'],
      });
    }
    confirmationMeta = {
      channel,
      at: confirmation.at,
      nonceHash: confirmation.nonceHash,
      issuedAt: confirmation.issuedAt,
      expiresAt: confirmation.expiresAt,
      testChannel,
      counted: !testChannel,
    };
  }
  const basis = buildOwnerBasis(projectName, project, task, teamMode);
  if (proxyMode) {
    basis.proxy = {
      scope: String(proxyRecord.scope || ''),
      startedAt: String(proxyRecord.startedAt || ''),
      authorization: String(proxyRecord.authorization || ''),
      recordedBy: 'pm',
    };
  }
  // R-9a8e F-rv-2：Owner 决定也绑 (requirementId, version, hash) 三元组（决定针对哪一版正文）。
  const ownerReqVersion = versionForRecord(readRequirementDocVersion(project.path, requirementId));
  const record = {
    status: decision,
    by: proxyMode ? 'PM（代记 Owner 的决定）' : 'Owner',
    actor: proxyMode ? 'pm' : 'owner',
    at,
    opinion,
    channel,
    reqVersion: ownerReqVersion.version,
    reqChange: ownerReqVersion.change,
    reqLegacy: Boolean(ownerReqVersion.legacy),
    basis,
    counted: proxyMode ? true : !testChannel,
    source: proxyMode ? 'team.mjs owner proxy decide' : 'team.mjs owner',
    command: proxyMode ? 'owner proxy decide' : (actionRaw === 'accept' ? 'owner --action accept' : 'owner'),
    confirmation: confirmationMeta,
    ...(proxyMode ? {
      // 代管代记：Owner 是决定者，PM 只代落账（与工作台 IPC 的 decidedBy=owner 对齐）。
      ...(proxyAcceptEvidence ? { decidedBy: 'owner', evidence: proxyAcceptEvidence } : {}),
      recordedBy: 'pm',
      ownerAuthorized: true,
      proxy: {
        scope: String(proxyRecord.scope || ''),
        startedAt: String(proxyRecord.startedAt || ''),
        authorization: String(proxyRecord.authorization || ''),
      },
    } : {}),
    // R-b52b F-8：无 tester 的验收由 PM 代签测试结论（signedBy 只落 decisions，不新增任务字段）。
    ...(actionRaw === 'accept' && testGate && testGate.mode === 'pm_signed' ? {
      actor: 'pm',
      recordedBy: 'pm',
      decidedBy: 'owner',
      signedBy: 'pm',
      testGate: 'pm_signed',
      channel: 'proxy',
    } : {}),
  };
  // F-O4 / AC-O6：决定 append-only；旧单对象不改写，只作为 decisions[0] 的只读迁移视图。
  const decisions = [...ownerDecisionList(row, task), record];
  record.decisionIndex = decisions.length - 1;
  task.workflow = task.workflow && typeof task.workflow === 'object' ? task.workflow : {};
  let nextStatus;
  let nextPhase;
  let actionName;
  let eventAction;
  let ownerReview = null;
  let acceptance = null;
  if (actionRaw === 'accept') {
    acceptance = record;
    task.workflow.ownerAcceptance = record;
    // R-43ad F-43ad-3 / AC2/AC3：缺陷单（bug/scenario-bug）验收必须带测试报告，并把验收记录落到任务行 acceptanceRecord。
    {
      const defectTask = task && ['bug', 'scenario-bug'].includes(String(task.type || ''));
      if (defectTask) {
        const defectItems = parseEvidenceArg(args.evidence);
        const defectVerdict = validatePmAcceptEvidence({ items: defectItems, projectPath: project.path });
        const reportItem2 = defectVerdict.evidence.find((item) => String(item.kind) === 'report');
        if (!reportItem2) {
          fail('PM_ACCEPT_EVIDENCE_REQUIRED', '缺陷单验收必须带测试报告（含 PASS、不含 FAIL）：--evidence <报告>:report', {
            taskId: task.id, missing: defectVerdict.missing.length ? defectVerdict.missing : [{ kind: 'report', path: '', reason: 'TEST_REPORT_REQUIRED' }],
          });
        }
        const atIso = String(record.at || at || nowIso());
        task.acceptanceRecord = {
          status: String(decision),
          by: proxyMode ? 'pm' : 'owner',
          channel: proxyMode ? 'proxy' : String(args.channel || 'ui'),
          at: atIso,
          evidence: defectVerdict.evidence.map((item) => ({ path: item.path, sha256: item.sha256, kind: item.kind })),
          testReport: String(reportItem2.path || ''),
        };
        task.workflow.acceptanceRecord = task.acceptanceRecord;
      }
    }
    // R-7849：PM 代验收记录落需求行（by=pm、channel=proxy，绝不写 owner）+ 需求收口自动结束代管。
    if (proxyMode) {
      const atIso = String(record.at || at || nowIso());
      const reportItem = (proxyAcceptEvidence || []).find((item) => String(item.kind) === 'report');
      row.acceptanceRecord = {
        status: String(decision),
        by: 'pm',
        channel: 'proxy',
        at: atIso,
        evidence: (proxyAcceptEvidence || []).map((item) => ({ path: item.path, sha256: item.sha256, kind: item.kind })),
        testReport: reportItem ? String(reportItem.path || '') : '',
        basis: {
          proxy: {
            scope: String(proxyRecord.scope || ''),
            startedAt: String(proxyRecord.startedAt || ''),
            authorization: String(proxyRecord.authorization || ''),
          },
        },
      };
      task.workflow.acceptanceRecord = row.acceptanceRecord;
      try { autoEndProxyForClosedRequirement(projectName, requirementId, String(decision)); } catch { /* 占管清理失败不阻断验收落账 */ }
    }
    if (decision === 'accepted') {
      nextStatus = 'accepted';
      nextPhase = 'accepted';
      task.workflow.requirementStatus = 'accepted';
      delete task.workflow.rejectedAt;
      delete task.workflow.rejectedBy;
      delete task.workflow.rejectionSource;
      task.status = 'done';
      task.doneAt = at;
      task.evidence = truncate(`Owner 验收通过${opinion ? '：' + opinion : ''}`, 500);
    } else {
      nextStatus = 'rejected';
      nextPhase = 'requirement_review';
      stampRejected(task, { source: 'owner_accept', role: 'owner', at });
    }
    actionName = 'owner_accept';
    eventAction = 'owner_accept';
  } else {
    ownerReview = record;
    task.workflow.ownerReview = record;
    if (decision === 'rejected') {
      nextStatus = 'rejected';
      nextPhase = 'requirement_review';
      stampRejected(task, { source: 'owner_review', role: 'owner', at });
    } else if (teamMode === 'fast') {
      // Fast 的 Owner 通过后先进入技术评审，技术评审通过才 ready 可派单。
      nextStatus = 'tech_review';
      nextPhase = 'tech_review';
      task.workflow.requirementStatus = 'tech_review';
    } else {
      nextStatus = 'ready';
      nextPhase = 'dispatch';
      task.workflow.requirementStatus = 'ready';
    }
    actionName = 'owner_requirement';
    eventAction = 'owner_requirement';
  }
  task.updatedAt = at;
  task.workflow.decisions = decisions;
  if (ownerReview) task.workflow.ownerReview = record;
  if (acceptance) task.workflow.ownerAcceptance = record;
  task._by = 'Owner';
  task._action = actionName;
  task._note = truncate(`${decision}${opinion ? '：' + opinion : ''}`, 100);
  saveTask(projectName, task);

  // B-7738：验收打回自动建缺陷单（建单失败不阻断打回落账，但必须留痕给 PM）。
  if (actionRaw === 'accept' && decision !== 'accepted') {
    try {
      const created = autoCreateAcceptRejectBug({
        projectName,
        project,
        requirementId,
        row,
        task,
        opinion,
        at: record.at || at,
        decisionIndex: record.decisionIndex,
      });
      task.workflow.acceptRejectBug = {
        taskId: created.taskId,
        reused: Boolean(created.reused),
        key: created.key,
        at: nowIso(),
      };
      saveTask(projectName, task);
      appendEvent({
        role: 'owner',
        action: created.reused ? 'accept_reject_bug_reused' : 'accept_reject_bug_linked',
        project: projectName,
        target: created.taskId,
        note: truncate(`验收打回关联缺陷单 ${created.taskId}`, 160),
        data: { requirementId, bugId: created.taskId, reused: Boolean(created.reused) },
      });
      try {
        notify({
          from: 'owner',
          to: 'pm',
          subject: `验收打回已建缺陷单 ${created.taskId}`,
          body: `需求 ${requirementId} 验收被打回，已自动建缺陷单 ${created.taskId}（缺：${(created.missing || []).join('、') || '见缺陷单正文'}）。请派修，修好后需求再走验收。`,
          project: projectName,
          task: created.taskId,
        });
      } catch { /* 通知失败不影响建单与打回落账 */ }
    } catch (error) {
      appendEvent({
        role: 'owner',
        action: 'accept_reject_bug_failed',
        project: projectName,
        target: requirementId,
        note: truncate('验收打回自动建缺陷单失败：' + String(error && error.message || error), 220),
      });
    }
  }

  const stateOwnerReview = actionRaw === 'accept'
    ? {
      required: true,
      status: decision === 'accepted' ? 'approved' : 'rejected',
      kind: 'acceptance',
      by: 'Owner',
      actor: 'owner',
      at,
      opinion,
      channel,
      confirmation: confirmationMeta,
      // B-2e24：验收落账不产生「评审过期」——显式清掉可能残留的 stale 标记。
      stale: false,
      derivedFrom: 'acceptance',
    }
    : {
      required: true,
      status: decision,
      kind: 'requirement',
      by: record.by,
      actor: record.actor,
      at,
      opinion,
      channel,
      confirmation: confirmationMeta,
      // B-2e24：新决定落账即代表当前版本已评审，清掉上一版留下的 stale 标记。
      stale: false,
      derivedFrom: 'decisions',
      ...(proxyMode ? {
        recordedBy: 'pm',
        ownerAuthorized: true,
        proxy: record.proxy,
      } : {}),
    };
  // B-2e24：验收路径旧实现只写项目级 ownerReview，需求行仍留着过期的 approved/pending（fe90 反向不一致）。
  // 这里按 decisions[] 的**评审类**决定派生行级 ownerReview（验收决定 accepted/--action accept 不写进 ownerReview）。
  const ownerReviewForRow = actionRaw === 'accept'
    ? ownerReviewRecord(
      { ...(row || {}), decisions },
      {
        sha256: String((basis && basis.requirement && basis.requirement.sha256) || ''),
        contentHash: String((basis && basis.requirement && basis.requirement.contentHash) || ''),
      },
    )
    : null;
  // note 必须与工作台壳层 pushWorkflowEventOnce 的写法完全一致，否则同一次 Owner
  // 决定会被记成两条事件（壳层已兼容旧命令写过的记录）。
  const eventNote = actionRaw === 'accept'
    ? decision
    : `${decision}${opinion ? '：' + opinion.slice(0, 80) : ''}`;
  const sync = syncWorkflowRow(projectName, task, nextStatus, {
    teamMode,
    decisions,
    ...(ownerReview ? { ownerReview: { ...ownerReview, stale: false } } : (ownerReviewForRow ? { ownerReview: ownerReviewForRow } : {})),
    ...(acceptance ? { acceptance, ownerAcceptance: acceptance } : {}),
  }, {
    create: true,
    action: actionName,
    by: 'Owner',
    note: decision,
    phase: nextPhase,
    statePatch: { ownerReview: stateOwnerReview, decisions },
    event: { action: eventAction, role: 'owner', requirementId, note: eventNote },
  });
  // 打回是显式回退事件：写审计留痕（阶段由 syncWorkflowRow 回 requirement_review）。
  if (decision === 'rejected') {
    gateWarn(projectName, {
      role: 'owner', action: actionRaw === 'accept' ? 'owner_accept' : 'owner_decision', requirementId, attempted: 'owner rejected',
    }, {
      code: 'OWNER_REJECTED', gate: actionRaw === 'accept' ? 'G3' : 'G3',
      missing: ['Owner 打回；该需求禁止派单直到重走评审'],
      next: '退回需求分析师补 AC，重走 req review 与新的 Owner 决定',
    });
  }

  appendEvent({
    role: 'owner',
    sessionId: channel,
    action: actionName,
    project: projectName,
    target: requirementId,
    note: truncate(`${decision}${opinion ? '：' + opinion : ''}`, 120),
    data: {
      decision,
      action: actionRaw || 'review',
      teamMode,
      confirmation: confirmationMeta,
      ownerReview,
      acceptance,
      workflowFile: sync.file,
      ...(testGate ? { testGate } : {}),
    },
  });
  const label = actionRaw === 'accept' ? '验收' : '决定';
  // R-75ec AC3/AC8：落账的同一写路径立即生效——打回/终止/迭代冻结该需求未完成任务，
  // 通过则解冻；不等下一次 claim/done。
  let freezeEffect = null;
  try {
    freezeEffect = applyOwnerDecisionEffects(projectName, requirementId, decision, {
      row: (sync && sync.state && sync.state.requirements) ? sync.state.requirements[requirementId] : null,
      by: proxyMode ? 'pm' : 'owner',
      source: 'cli',
      reason: truncate(opinion || '', 200),
    });
  } catch (error) {
    // 冻结失败不得静默：留审计，但不回滚已落账的决定（决定本身合法）。
    gateWarn(projectName, { role: proxyMode ? 'pm' : 'owner', action: 'task_freeze', requirementId, attempted: 'freeze after owner decision' }, {
      code: 'TASK_FREEZE_FAILED', gate: 'G3',
      missing: [String((error && error.message) || error).slice(0, 160)],
      next: '用 task show 核对任务状态；必要时手工重跑 req 决定或联系 PM',
    });
  }
  // 验收通过后，PM 未消费的派单不得再唤醒角色（AC5.4：验收/终止后队列为 0）。
  const queue = actionRaw === 'accept' && decision === 'accepted'
    ? clearDispatchQueue(projectName, { reason: 'owner_accepted', requirementId })
    : null;
  out(args, [
    `Owner ${label}：${requirementId} → ${decision}（${teamMode}，channel=${channel}）`,
    `需求状态：${nextStatus} ｜ 工作流相位：${sync.state ? sync.state.phase : nextPhase}`,
    `依据：需求 ${basis.requirement.path || '—'} ${String(basis.requirement.sha256 || '').slice(0, 12)} ｜ 设计 ${basis.design.path || '—'} ${basis.design.version || ''} ${String(basis.design.sha256 || '').slice(0, 12)}`,
    `决定链：${decisions.length} 条（append-only，最新为第 ${decisions.length} 条）`,
    `工作流：${sync.file}`,
    ...(queue && queue.count ? [`清理未消费派单：${queue.count} 条`] : []),
  ].join('\n'), {
    ok: true,
    project: projectName,
    requirementId,
    action: actionRaw || 'review',
    decision,
    teamMode,
    requirement: task,
    ownerReview,
    acceptance,
    decisions,
    basis,
    testGate,
    confirmation: { ...confirmationMeta, channel },
    workflow: sync.state,
    workflowFile: sync.file,
    ...(queue ? { dispatchQueue: queue } : {}),
  });
}

/**
 * PM 代管落账（T-a01d）：Owner 已授权代管时，PM 代记 Owner 的评审决定。
 * 校验：当前存在未结束的代管记录 + 有 Owner 授权来源；落账固定 channel=proxy、recordedBy=pm、basis 带代管授权。
 * 用法：team.mjs owner proxy decide --project P --requirement R-... --decision approved|rejected|skipped --opinion "..."
 *      team.mjs owner proxy decide --project P --requirement R-... --decision accepted --action accept \
 *        --evidence '路径:report' --evidence '图片.png:screenshot' --opinion "..."   # T-3422：代验收（证据缺一即拒）
 * 代管可代记评审决定与「验收通过」；打回/迭代/终止必须 Owner 本人。
 */
export async function cmdOwnerProxyDecide(args) {
  // R-51de F-5⑤（proxy）：PM 代验收前必须读过当前版本经验教训登记册（改用 PM 的阅读记录）
  failLessonGate(lessonGateFor(ownerGateBoot(args, String(args.project || '').trim()), args));
  const projectName = String(args.project || '').trim();
  if (!projectName) fail('BAD_ARGS', '需要 --project <团队项目名>');
  const requirementId = String(args.requirement || '').trim();
  if (!requirementId) fail('BAD_ARGS', '需要 --requirement R-...');
  const decision = String(args.decision || '').trim().toLowerCase();
  const actionRaw = String(args.action || '').trim().toLowerCase();
  // Owner 2026-11-16 10:52 裁定（B-20261116-105213-bd22）：**代管也不许代需求验收**，需求必须 Owner 本人验收。
  // 代管仍可代记评审决定（approved/rejected/skipped）——见下方分支；缺陷单验收不受影响（走 task accept --as pm|tester）。
  if (actionRaw === 'accept' || decision === 'accepted') {
    fail('PROXY_ACCEPT_FORBIDDEN', '需求验收只能 Owner 本人：代管不得代需求验收（评审决定仍可代记；缺陷单验收走 task accept）', {
      project: projectName, requirementId, decision,
    });
  }
  if (actionRaw === 'iterate' || actionRaw === 'terminate' || decision === 'iterate' || decision === 'terminated') {
    fail('PROXY_ACCEPT_FORBIDDEN', '代管只能代记评审决定（approved/rejected/skipped）；打回/迭代/终止/验收必须 Owner 本人执行');
  }
  if (!['approved', 'rejected', 'skipped'].includes(decision)) {
    fail('OWNER_DECISION_INVALID', 'PM 代管落账只支持 approved / rejected / skipped（需求验收与打回/迭代/终止必须 Owner 本人）', { decision });
  }
  if (args.opinion === undefined || args.opinion === null) {
    fail('OPINION_REQUIRED', '需要 --opinion "PM 代记依据/说明"（可以为空字符串，但必须显式给出）');
  }
  const proxy = activeProxyFor(projectName, requirementId);
  if (!proxy) {
    fail('PROXY_UNAUTHORIZED', `需求 ${requirementId} 当前没有未结束的代管授权：先请 Owner 在评审弹窗点「全部交 PM 代管」，或运行 owner proxy start --scope always`, { project: projectName, requirementId });
  }
  if (!String(proxy.authorization || '').trim()) {
    fail('PROXY_UNAUTHORIZED', '代管记录缺少 Owner 授权来源（authorization），不能代落账', { requirementId, proxy });
  }
  await cmdOwner({ ...args, _: ['owner'], 'proxy-recorded-by': 'pm' });
}

/**
 * 看板/列表用的来源标识（R-1cee）：PM 代落 →【PM通过】/【PM打回】/【PM跳过】；
 * Owner 本人 →【已通过】/【已打回】/【已跳过】；旧数据没有 channel/recordedBy →「（来源未记）」；
 * 还没落账但有未结束代管记录 →【待 PM 评审】。不再使用【PM评审通过】文案。
 */
export function ownerProxyLabelOf(ownerReview, activeProxy) {
  const row = ownerReview && typeof ownerReview === 'object' ? ownerReview : null;
  if (!row) return activeProxy ? '【待 PM 评审】' : '';
  const channel = String(row.channel || '');
  const recordedBy = String(row.recordedBy || '');
  const status = String(row.status || '');
  const viaProxy = channel === 'proxy' || recordedBy === 'pm';
  if (viaProxy) {
    if (status === 'approved') return '【PM通过】';
    if (status === 'rejected') return '【PM打回】';
    if (status === 'skipped') return '【PM跳过】';
    return '【待 PM 评审】';
  }
  if (['approved', 'rejected', 'skipped'].includes(status)) {
    const suffix = !channel && !recordedBy ? '（来源未记）' : '';
    if (status === 'approved') return `【已通过${suffix}】`;
    if (status === 'rejected') return `【已打回${suffix}】`;
    return `【已跳过${suffix}】`;
  }
  return activeProxy ? '【待 PM 评审】' : '';
}

/**
 * 工作台旧协议入口：workflow iterate / terminate。
 * 只做两件事：推进轮次（可把被驳回需求转入下一轮）或终止全部未收口需求；
 * 工作流文件与工作台共用，保留工作台其它字段。
 */
export function cmdWorkflow(args) {
  const action = String(args._[1] || '').trim().toLowerCase();
  if (!['iterate', 'terminate'].includes(action)) {
    fail('BAD_ACTION', 'workflow 只支持 iterate / terminate', { action, allowed: ['iterate', 'terminate'] });
  }
  const b = bootFor(args, `workflow ${action}`);
  if (b.role !== 'pm') fail('NOT_PM', '只有 PM 能推进工作流阶段或终止工作流');
  // G9：还有在办开发/测试任务或在办需求时不能推进下一轮（--force 可留痕绕过）。
  if (action === 'iterate') {
    const stateRead = readWorkflowState(b.project);
    const rows = Object.values((stateRead.state && stateRead.state.requirements) || {});
    const g9 = gateIteration({ rows, tasks: listTasks(b.project) });
    if (g9) {
      const record = { role: b.role, action: 'iterate', attempted: 'workflow iterate' };
      if (args.force) gateWarn(b.project, record, g9);
      else gateFail(b.project, record, g9);
    }
  }
  const result = workflowAction({
    project: b.project,
    action,
    role: b.role,
    sessionId: b.sessionId,
    opinion: String(args.opinion || args.reason || ''),
    requirementId: args.requirement ? String(args.requirement) : '',
    force: Boolean(args.force),
  });
  const queue = action === 'terminate'
    ? clearDispatchQueue(b.project, { reason: 'workflow_terminate' })
    : null;
  const human = action === 'iterate'
    ? `工作流已进入下一次：当前 → 当前；转入迭代 ${result.transitioned.length} 条\n工作流：${result.workflowFile}`
    : `工作流已终止：停止 ${result.stopped.length} 条需求；关闭子任务 ${result.closedTasks.length} 个\n工作流：${result.workflowFile}${queue && queue.count ? `\n清理未消费派单：${queue.count} 条` : ''}`;
  out(args, human, { ...result, ok: true, project: b.project, ...(queue ? { dispatchQueue: queue } : {}) });
}


export function cmdFind(args) {
  const b = bootFor(args, 'find');
  const project = loadProject(b.project);
  const indexMd = projectIndexPath(project);
  const indexJson = path.join(project.path, '项目索引.json');
  if (!exists(indexMd) || !exists(indexJson)) fail('INDEX_MISSING', '项目索引不存在；先 index', { index: indexMd });
  const currentHash = hashFile(indexMd);
  if (b.projectIndexHash && b.projectIndexHash !== currentHash) {
    fail('INDEX_CHANGED', '索引在 boot 后变了；重新 boot 再找文件', { bootIndex: b.projectIndexHash, current: currentHash });
  }
  addReadReceipt({ role: b.role, sessionId: b.sessionId, kind: 'index_search', project: b.project, proposalId: '', proposalHash: '', baseHash: currentHash });
  const q = String(args.q || args.query || '').trim();
  if (!q) fail('BAD_QUERY', '需要 --q 关键词');
  const data = readJson(indexJson, { files: [] });
  const ql = q.toLowerCase();
  const matches = (data.files || []).filter((f) => String(f.target).toLowerCase().includes(ql));
  // R-f9b1 AC11：主正文与同 id 增补卷都要能按需求 id 命中（kind 标 supplement）。
  const supRows = supplementIndexRows(project).filter((s) => String(s.rel).toLowerCase().includes(ql)
    || String(s.requirementId).toLowerCase().includes(ql));
  const supMatches = supRows.map((s) => ({
    target: s.rel, name: s.name, kind: 'supplement', requirementId: s.requirementId, size: s.bytes, hash: shortHash(s.sha256, 10),
  }));
  // 审计里有拆分记录但盘上没有卷 → 明确报缺失，不当作「没搜到」
  if (/^R-\d{8}-\d{4,6}(?:-[0-9a-z]{2,8})?/i.test(q)) {
    let audited = [];
    try { audited = readSplitAudit(b.project).rows.filter((r) => r && r.action === 'split' && String(r.requirementId).toLowerCase() === ql); } catch { audited = []; }
    if (audited.length && !listSupplements(project.path, q).length) {
      fail('SUPPLEMENT_MISSING', `需求 ${q} 有 ${audited.length} 条拆分审计记录，但 需求/ 下找不到任何增补卷`, {
        requirementId: q, auditSplits: audited.length, audit: splitAuditPath(b.project),
      }, 1);
    }
  }
  appendEvent({ role: b.role, sessionId: b.sessionId, action: 'index_find', project: b.project, target: q, note: `matches=${matches.length} supplements=${supMatches.length}`, data: { q, matches: matches.map((m) => m.target), supplements: supMatches.map((m) => m.target) } });
  out(args, `按索引找到 ${matches.length} 个文件 + ${supMatches.length} 份增补卷（先读索引，再找文件）\n` + table([
    ...matches.slice(0, 40).map((f) => ({ target: f.target, size: f.size, hash: shortHash(f.hash || '', 10), kind: 'doc' })),
    ...supMatches,
  ].slice(0, 50), [
    { key: 'target', label: '文件' }, { key: 'kind', label: '类型' }, { key: 'size', label: '大小' }, { key: 'hash', label: '哈希' },
  ]), { ok: true, query: q, matches, supplements: supMatches, requirementId: supMatches.length ? supMatches[0].requirementId : '' });
}

// ========== 提案 / 展示 / 评审 / 签字 / 应用 ==========

export function cmdPropose(args) {
  const b = bootFor(args, 'propose');
  if (!args.task) fail('BAD_TASK', '需要 --task（先 claim 任务）');
  const task = loadTask(b.project, String(args.task));
  if (task.status === 'done') fail('TASK_DONE', `任务已完成：${task.id}`);
  if (task.owner !== b.role) fail('TASK_NOT_OWNER', `任务 owner 是 ${task.owner || '空'}，先 claim 再来提`, { owner: task.owner });
  if (!task.priority) fail('NO_PRIORITY', '任务没有优先级，先让 PM 定优先级');
  const specs = parseFiles(args);
  const expects = parseExpect(args);
  const project = loadProject(b.project);
  const team = loadTeam();
  let risk = String(args.risk || 'normal');
  if (!RISK_RANK[risk]) fail('BAD_RISK', `风险级别必须是 normal/sensitive/critical：${risk}`);
  // R-3911：共享层提案 scope=shared；缺省按 project，保持旧行为。
  const scope = String(args.scope || 'project').toLowerCase();
  if (!['project', 'shared'].includes(scope)) fail('BAD_SCOPE', `scope 只能是 project/shared：${args.scope}`, { scope: args.scope });
  const stagedFiles = [];
  const proposalIdPreview = 'P-' + stamp();
  const tempDir = path.join(projectStatePaths(b.project).proposals, proposalIdPreview + '-tmp');
  ensureDir(tempDir);
  try {
    let n = 0;
    for (const spec of specs) {
      const { rel, abs } = normalizeTarget(project, spec.target, scope);
      const staged = resolveStaged(spec.staged);
      const st = fs.statSync(staged);
      const isDoc = /\.(md|markdown|txt)$/i.test(rel);
      const max = isDoc
        ? Number(team.config.docMaxBytes || 16384)
        : Number(team.config.codeMaxBytes || 65536);
      if (st.size > max) fail('STAGED_TOO_BIG', `${isDoc ? '文档' : '代码'}超过 ${max} 字节：${staged}`, { size: st.size, max, kind: isDoc ? 'document' : 'code' });
      const minRisk = requiredRisk(project, rel);
      if (RISK_RANK[minRisk] > RISK_RANK[risk]) {
        fail('RISK_TOO_LOW', `目标 ${rel} 至少是 ${minRisk} 风险，不能用 ${risk}`, { target: rel, minRisk, risk });
      }
      const currentHash = exists(abs) ? hashFile(abs) : 'absent';
      const expect = expects.get(rel) || (specs.length === 1 ? String(args['expect-base'] || '').toLowerCase() : '');
      if (!expect) {
        fail('EXPECT_BASE_REQUIRED', `提案前必须声明你读到的版本：--expect ${rel}=${currentHash}`, { target: rel, currentHash });
      }
      if (expect !== currentHash) {
        fail('STALE_BASE', `读过之后文件变了：${rel}`, { target: rel, expected: expect, current: currentHash });
      }
      if (!hasGrant(b.role, 'propose', b.project, rel)) {
        fail('NO_GRANT', `没有 ${b.role} 对 ${rel} 的 propose 授权；让 PM grant`, { target: rel, role: b.role });
      }
      const newHash = hashFile(staged);
      const snapshot = path.join(tempDir, `${++n}-${path.basename(rel)}`);
      fs.copyFileSync(staged, snapshot);
      if (hashFile(snapshot) !== newHash) fail('COPY_BAD', `暂存快照哈希不一致：${rel}`);
      stagedFiles.push({ target: rel, baseHash: currentHash, newHash, size: st.size, staged: snapshot, stagedSha: newHash });
    }
    const fingerprint = (files) => JSON.stringify(files.map((f) => `${f.target}|${f.newHash}`).sort());
    const dup = listProposals(b.project).find((p) => p.author === b.role && p.task === task.id && ['proposed', 'reviewing', 'signing'].includes(p.status) && fingerprint(p.files || []) === fingerprint(stagedFiles));
    if (dup) fail('DUPLICATE_PROPOSAL', `已有相同未闭环提案：${dup.id}`, { proposalId: dup.id });
    // 分配正式提案目录，把临时快照搬进去
    const proposal = newProposal({
      project: b.project, author: b.role, authorSession: b.sessionId, task: task.id,
      title: args.title || task.title, rationale: args.rationale || '', risk, scope, files: [],
    });
    const pdir = proposalPaths(b.project, proposal.id).dir;
    const finalFiles = [];
    let idx = 0;
    for (const f of stagedFiles) {
      const name = `${++idx}-${path.basename(f.target)}`;
      const dst = path.join(pdir, '文件', name);
      fs.copyFileSync(f.staged, dst);
      finalFiles.push({ target: f.target, baseHash: f.baseHash, newHash: f.newHash, size: f.size, staged: `文件/${name}`, stagedSha: f.stagedSha });
    }
    const sets = requiredSets({ ...proposal, risk, author: b.role }, team);
    proposal.files = finalFiles;
    proposal.minReviews = sets.minReviews;
    proposal.requiredSigners = sets.signers;
    proposal.requiredReviewers = sets.reviewers;
    proposal.proposalHash = computeProposalHash(proposal);
    saveProposal(b.project, proposal);
    appendEvent({
      role: b.role, sessionId: b.sessionId, action: 'propose', project: b.project, target: proposal.id,
      note: `${risk} ${scope} ${proposal.title} files=${finalFiles.length}`, data: { proposalHash: proposal.proposalHash, risk, scope, files: finalFiles.map((f) => f.target) },
    });
    notify({
      from: b.role, to: 'pm', subject: `待审提案 ${proposal.id}`,
      body: `${risk} · ${scope === 'shared' ? '共享层' : '项目内'} · ${proposal.title}\n文件：${finalFiles.map((f) => f.target).join(', ')}\n请先 show 再 review/sign。`,
      project: b.project, task: task.id, ackRequired: true, type: 'proposal', sessionId: b.sessionId,
    });
    out(args, `提案已建 ${proposal.id}\n哈希 ${proposal.proposalHash}\n范围 ${scope}（${scope === 'shared' ? '仓库根：团队/**、src/**、scripts/**' : '项目目录'}）\n风险 ${risk} ｜ 最少评审 ${proposal.minReviews} ｜ 签字 ${proposal.requiredSigners.join(', ')}\n下一步：PM show → review → sign；apply 前 CAS 必须过`, { ok: true, proposal });
    mirrorSafe(b.project, 'propose');
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export function cmdShow(args) {
  const b = bootFor(args, 'show');
  if (!args.proposal) fail('BAD_ID', '需要 --proposal');
  const proposal = loadProposal(b.project, String(args.proposal));
  const actual = computeProposalHash(proposal);
  if (actual !== proposal.proposalHash) fail('PROPOSAL_TAMPERED', '提案 JSON 与哈希不符，拒绝展示', { expected: proposal.proposalHash, actual });
  const project = loadProject(b.project);
  const lines = [];
  lines.push(`=== 提案 ${proposal.id} · ${proposal.risk} · ${proposal.status} ===`);
  lines.push(`标题: ${proposal.title}`);
  lines.push(`作者: ${proposal.author} ｜ 任务: ${proposal.task} ｜ 创建: ${proposal.createdAt}`);
  lines.push(`范围: ${proposal.scope === 'shared' ? 'shared（仓库根：团队/**、src/**、scripts/**）' : 'project（项目目录）'}`);
  lines.push(`提案哈希: ${proposal.proposalHash}`);
  lines.push(`理由: ${proposal.rationale || '（未写）'}`);
  const showRoot = proposal.scope === 'shared' ? repoRoot() : project.path;
  lines.push(`文件（${proposal.files.length}）：`);
  for (const f of proposal.files) {
    lines.push(`  - ${f.target}`);
    lines.push(`    base=${f.baseHash}  new=${f.newHash}  size=${f.size}`);
    lines.push(`    暂存: ${path.join(proposalPaths(b.project, proposal.id).dir, f.staged)}`);
    if (args.diff) {
      const nextBuf = safeRead(path.join(proposalPaths(b.project, proposal.id).dir, f.staged));
      const baseBuf = f.baseHash === 'absent' ? Buffer.from('') : safeRead(path.join(showRoot, f.target));
      if (!isBinary(nextBuf) && !isBinary(baseBuf)) {
        const d = lineDiff((baseBuf || Buffer.from('')).toString('utf8'), (nextBuf || Buffer.from('')).toString('utf8'));
        lines.push('    --- diff ---');
        for (const l of d) lines.push('    ' + l);
      } else {
        lines.push('    （二进制文件，请直接读暂存文件）');
      }
    }
  }
  const reviews = loadReviews(b.project, proposal.id);
  const sigs = loadSignatures(b.project, proposal.id);
  lines.push(`评审: ${Object.keys(reviews).length ? Object.entries(reviews).map(([r, v]) => `${r}:${v.verdict}`).join(', ') : '（无）'}`);
  lines.push(`签字: ${Object.keys(sigs).length ? Object.entries(sigs).map(([r, v]) => `${r}:${v.decision}`).join(', ') : '（无）'}`);
  addReadReceipt({ role: b.role, sessionId: b.sessionId, kind: 'proposal', project: b.project, proposalId: proposal.id, proposalHash: proposal.proposalHash, baseHash: proposal.files.map((f) => f.baseHash).join(',') });
  appendEvent({ role: b.role, sessionId: b.sessionId, action: 'proposal_show', project: b.project, target: proposal.id, note: `hash=${shortHash(proposal.proposalHash)}`, data: { proposalHash: proposal.proposalHash } });
  out(args, lines.join('\n'), { ok: true, proposal, reviews, signatures: sigs });
}

export function cmdReview(args) {
  const b = bootFor(args, 'review');
  if (!args.proposal) fail('BAD_ID', '需要 --proposal');
  const proposal = loadProposal(b.project, String(args.proposal));
  const actual = computeProposalHash(proposal);
  if (actual !== proposal.proposalHash) fail('PROPOSAL_TAMPERED', '提案哈希不符', { expected: proposal.proposalHash, actual });
  if (proposal.author === b.role) fail('SELF_REVIEW', '不能审自己的提案');
  if (['applied', 'rejected'].includes(proposal.status)) fail('PROPOSAL_CLOSED', `提案已 ${proposal.status}`);
  // R-beb3 检查点：作者还有未结束的子代理 → 记录缺失/未复核，评审拒收（没有记录 = 没发生）。
  assertNoPendingSubagent(b.project, proposal.author, { action: 'review' });
  const team = loadTeam();
  const sets = requiredSets(proposal, team);
  if (!sets.reviewers.includes(b.role)) fail('NOT_REQUIRED_REVIEWER', `${b.role} 不是本提案的评审人（${sets.reviewers.join(', ')}）`);
  const read = latestRead({
    role: b.role, sessionId: b.sessionId, proposalId: proposal.id, proposalHash: proposal.proposalHash,
    maxAgeMs: Number(team.config.reviewReadTtlMinutes || 15) * 60000,
  });
  if (!read) fail('MUST_READ_FIRST', '先运行 show 同一提案（且哈希一致），再 review', { proposal: proposal.id });
  const verdict = String(args.verdict || '').toLowerCase();
  if (!['approve', 'reject'].includes(verdict)) fail('BAD_VERDICT', '--verdict 必须是 approve / reject');
  const comments = String(args.comments || '');
  if (verdict === 'reject' && comments.trim().length < 10) fail('COMMENTS_REQUIRED', '打回必须写至少 10 字理由');
  if (args.priority) {
    if (!['pm', 'product'].includes(b.role)) fail('NOT_PM', '只有 PM / 产品能改优先级');
    setTaskPriority(b.project, proposal.task, String(args.priority), b.role, args['priority-reason'] || '评审时调整');
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'task_priority', project: b.project, target: proposal.task, note: `${args.priority}` });
  }
  const review = {
    proposalId: proposal.id, proposalHash: proposal.proposalHash,
    baseHash: proposal.files.map((f) => f.baseHash).join(','), newHash: proposal.files.map((f) => f.newHash).join(','),
    role: b.role, sessionId: b.sessionId, verdict, comments: truncate(comments, 600), ts: nowIso(),
  };
  saveReview(b.project, proposal.id, b.role, review);
  const reviews = loadReviews(b.project, proposal.id);
  if (verdict === 'reject') proposal.status = 'rejected';
  else if (approvedReviews(reviews).length >= (proposal.minReviews || 1)) proposal.status = 'reviewed';
  else proposal.status = 'reviewing';
  saveProposal(b.project, proposal);
  appendEvent({
    role: b.role, sessionId: b.sessionId, action: 'review', project: b.project, target: proposal.id,
    note: `${verdict} ${truncate(comments, 120)}`, data: { proposalHash: proposal.proposalHash, verdict },
  });
  notify({
    from: b.role, to: proposal.author, subject: `评审${verdict === 'approve' ? '通过' : '打回'} ${proposal.id}`,
    body: `${proposal.title}\n${comments || '（无备注）'}\n当前状态：${proposal.status}`,
    project: b.project, task: proposal.task, ackRequired: true, type: 'review', sessionId: b.sessionId,
  });
  out(args, `评审已记录：${proposal.id} → ${verdict}；提案状态 ${proposal.status}`, { ok: true, review, proposal });
  mirrorSafe(b.project, 'review');
}

export function cmdSign(args) {
  const b = bootFor(args, 'sign');
  if (!args.proposal) fail('BAD_ID', '需要 --proposal');
  const proposal = loadProposal(b.project, String(args.proposal));
  const actual = computeProposalHash(proposal);
  if (actual !== proposal.proposalHash) fail('PROPOSAL_TAMPERED', '提案哈希不符', { expected: proposal.proposalHash, actual });
  if (['applied', 'rejected'].includes(proposal.status)) fail('PROPOSAL_CLOSED', `提案已 ${proposal.status}`);
  const team = loadTeam();
  const sets = requiredSets(proposal, team);
  if (!sets.signers.includes(b.role)) fail('NOT_REQUIRED_SIGNER', `${b.role} 不在签字人（${sets.signers.join(', ')}）`);
  const decision = String(args.decision || 'approve').toLowerCase();
  if (!['approve', 'reject'].includes(decision)) fail('BAD_DECISION', '--decision 必须是 approve / reject');
  const isSelf = proposal.author === b.role;
  if (isSelf) {
    if (proposal.risk === 'normal') fail('SELF_SIGN_FORBIDDEN', 'normal 提案作者不单独签字；由评审 + PM 签');
    if (!args.self) fail('SELF_SIGN_FLAG', '作者签自己的提案需要显式 --self（sensitive/critical 全员签字）');
    if (decision !== 'approve') fail('BAD_DECISION', '作者自签只能 approve');
  } else {
    const reviews = loadReviews(b.project, proposal.id);
    const r = reviews[b.role];
    if (!r || r.verdict !== 'approve' || r.proposalHash !== proposal.proposalHash) {
      fail('REVIEW_REQUIRED', '签字前必须先 review 通过同一哈希的提案', { role: b.role });
    }
  }
  const ts = nowIso();
  const nonce = randomHex(6);
  const baseHash = proposal.files.map((f) => f.baseHash).join(',');
  const newHash = proposal.files.map((f) => f.newHash).join(',');
  const sig = signatureDigest({ role: b.role, proposalId: proposal.id, proposalHash: proposal.proposalHash, baseHash, newHash, decision, ts, nonce });
  const record = {
    role: b.role, proposalId: proposal.id, proposalHash: proposal.proposalHash,
    baseHash, newHash, decision, note: truncate(String(args.note || ''), 300), ts, nonce, sig,
    sessionId: b.sessionId,
  };
  saveSignature(b.project, proposal.id, b.role, record);
  if (decision === 'reject') proposal.status = 'rejected';
  else {
    const sigs = loadSignatures(b.project, proposal.id);
    const all = sets.signers.every((r) => sigs[r] && sigs[r].decision === 'approve');
    proposal.status = all ? 'approved' : 'signing';
  }
  saveProposal(b.project, proposal);
  appendEvent({
    role: b.role, sessionId: b.sessionId, action: 'sign', project: b.project, target: proposal.id,
    note: `${decision} ${truncate(String(args.note || ''), 100)}`, data: { proposalHash: proposal.proposalHash, decision, sig },
  });
  notify({
    from: b.role, to: 'pm', subject: `签字${decision === 'approve' ? '批准' : '拒绝'} ${proposal.id}`,
    body: `${proposal.title}\n${args.note || ''}\n提案状态：${proposal.status}`,
    project: b.project, task: proposal.task, ackRequired: true, type: 'sign', sessionId: b.sessionId,
  });
  out(args, `签字已记录：${proposal.id} / ${b.role} → ${decision}；提案状态 ${proposal.status}`, { ok: true, signature: record, proposal });
  mirrorSafe(b.project, 'sign');
}

/**
 * 设计提案 apply 即签字：把签字证据写进 工作流.json.designReview。
 * G4 读它（也认提交记录兜底），避免“设计已经签了，但任务 workflow.designReview 永远没人写”。
 */
function recordDesignSignature(projectName, project, proposal, commit, role) {
  const designRe = /^产品[\\/]产出[\\/](02-)?产品设计-v\d+\.md$/i;
  const after = Array.isArray(commit.after) ? commit.after : [];
  const targetRow = after
    .map((row) => ({ ...row, rel: String(row.target || '').replace(/\\/g, '/') }))
    .find((row) => designRe.test(row.rel));
  if (!targetRow) return null;
  const version = Number((/-v(\d+)\.md$/i.exec(targetRow.rel) || [])[1] || 0);
  const at = nowIso();
  const signature = {
    verdict: 'approve',
    path: targetRow.rel,
    version: `v${version}`,
    sha256: String(targetRow.hash || ''),
    proposalId: proposal.id,
    commitId: commit.id,
    signers: Object.keys(commit.signatures || {}),
    by: proposal.author,
    appliedBy: role,
    at,
    source: 'apply',
  };
  const read = readWorkflowState(projectName);
  const state = read.state || {};
  state.designReview = signature;
  state.events = Array.isArray(state.events) ? state.events : [];
  state.events.push({
    at, project: projectName, action: 'design_signed', role, proposalId: proposal.id,
    note: `${targetRow.rel} ${String(signature.sha256).slice(0, 12)}`,
  });
  if (state.events.length > 300) state.events = state.events.slice(-300);
  writeWorkflowState(projectName, state);
  appendEvent({
    role, sessionId: '', action: 'design_signed', project: projectName, target: proposal.id,
    note: `${targetRow.rel} v${version}`, data: { designReview: signature },
  });
  return signature;
}

export function cmdApply(args) {
  const b = bootFor(args, 'apply');
  if (b.role !== 'pm') fail('NOT_PM', '只有 PM 能 apply（执行提交）');
  if (!args.proposal) fail('BAD_ID', '需要 --proposal');
  const project = loadProject(b.project);
  const team = loadTeam();
  const lockKey = `apply:${b.project}`;
  acquireLock(lockKey, { role: b.role, sessionId: b.sessionId, ttlMs: 120000, waitMs: 0, reason: 'apply commit' });
  try {
    const proposal = loadProposal(b.project, String(args.proposal));
    // R-3911：共享层提案 apply 到仓库根；项目提案仍写项目目录。
    const targetRoot = proposal.scope === 'shared' ? repoRoot() : project.path;
    if (proposal.status !== 'approved') fail('NOT_APPROVED', `提案状态是 ${proposal.status}，必须 approved 才能 apply`);
    // R-beb3 检查点：作者未结束的子代理 = 记录缺失/未复核，apply 拒收。
    assertNoPendingSubagent(b.project, proposal.author, { action: 'apply' });
    const actual = computeProposalHash(proposal);
    if (actual !== proposal.proposalHash) fail('PROPOSAL_TAMPERED', '提案哈希不符', { expected: proposal.proposalHash, actual });
    // R-3911 P1-2：apply 前逐文件复跑路径校验，target 必须仍解析到 targetRoot 下的同一路径。
    // 历史共享层提案（hashVersion<2）scope 未绑定签字，不能靠旧哈希换根写，必须重提重签。
    if (proposal.scope === 'shared' && proposal.hashVersion !== 2) {
      fail('PROPOSAL_SCOPE_UNHASHED', '共享层提案缺少 v2 哈希（scope 未绑定签字），请重新提案/评审/签字后再 apply', { proposalId: proposal.id });
    }
    for (const f of proposal.files) {
      const norm = normalizeTarget(project, f.target, proposal.scope);
      const expect = path.resolve(targetRoot, f.target);
      if (path.resolve(norm.abs) !== expect) {
        fail('PATH_OUTSIDE_REPO', `apply 复校失败：${f.target} 解析到 ${norm.abs}，期望 ${expect}`, {
          target: f.target, resolved: norm.abs, expected: expect, scope: proposal.scope || 'project',
        });
      }
    }
    const { req, problems } = checkApprovals(proposal, team, { forApply: true });
    if (problems.length) fail('APPROVALS_INCOMPLETE', '评审/签字不满足，不能 apply', { problems, required: req });
    // CAS：目标当前哈希必须等于提案 baseHash
    const stale = [];
    for (const f of proposal.files) {
      const abs = path.join(targetRoot, f.target);
      const cur = exists(abs) ? hashFile(abs) : 'absent';
      if (cur !== f.baseHash) stale.push({ target: f.target, expectedBase: f.baseHash, current: cur });
    }
    if (stale.length) {
      proposal.status = 'stale';
      proposal.staleAt = nowIso();
      saveProposal(b.project, proposal);
      appendEvent({
        role: b.role, sessionId: b.sessionId, action: 'apply', project: b.project, target: proposal.id,
        result: 'STALE_BASE', note: '目标已变，提案作废，需重读重提重签', data: { stale, proposalHash: proposal.proposalHash },
      });
      fail('STALE_BASE', '版本栅栏拒绝：目标文件在评审后被改过，提案作废', { stale, proposalId: proposal.id });
    }
    const commitId = `C-${stamp()}-${randomHex(3)}`;
    const backupRoot = path.join(projectStatePaths(b.project).backups, commitId);
    const before = [];
    for (const f of proposal.files) {
      const abs = path.join(targetRoot, f.target);
      if (!exists(abs)) { before.push({ target: f.target, existed: false, hash: 'absent' }); continue; }
      const bp = path.join(backupRoot, f.target);
      ensureDir(path.dirname(bp));
      fs.copyFileSync(abs, bp);
      const bh = hashFile(bp);
      if (bh !== f.baseHash) fail('BACKUP_MISMATCH', `备份哈希与 baseHash 不一致：${f.target}`, { target: f.target, backup: bh, base: f.baseHash });
      before.push({ target: f.target, existed: true, hash: bh, backup: bp });
    }
    const written = [];
    try {
      for (const f of proposal.files) {
        const staged = path.join(proposalPaths(b.project, proposal.id).dir, f.staged);
        const buf = fs.readFileSync(staged);
        if (sha256(buf) !== f.newHash) fail('STAGED_TAMPERED', `暂存快照被改：${f.target}`, { target: f.target });
        const abs = path.join(targetRoot, f.target);
        ensureDir(path.dirname(abs));
        const tmp = `${abs}.team-tmp-${process.pid}-${randomHex(2)}`;
        fs.writeFileSync(tmp, buf);
        try { fs.renameSync(tmp, abs); } catch { fs.copyFileSync(tmp, abs); try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
        const after = hashFile(abs);
        if (after !== f.newHash) fail('WRITE_MISMATCH', `写入后哈希不对：${f.target}`, { target: f.target, after, expected: f.newHash });
        written.push({ target: f.target, hash: after });
        if (args['fail-after-backup'] && process.env.TEAM_SELFTEST === '1') {
          throw new TeamError('SELFTEST_FAIL', 'selftest 故意失败（验证回滚）');
        }
      }
    } catch (e) {
      const rollbackProblems = [];
      for (const bf of before) {
        const abs = path.join(targetRoot, bf.target);
        try {
          if (bf.existed) {
            fs.copyFileSync(bf.backup, abs);
            if (hashFile(abs) !== bf.hash) rollbackProblems.push({ target: bf.target, reason: 'restore hash mismatch' });
          } else if (exists(abs)) {
            fs.unlinkSync(abs);
          }
        } catch (re) {
          rollbackProblems.push({ target: bf.target, reason: re.message });
        }
      }
      appendEvent({
        role: b.role, sessionId: b.sessionId, action: 'rollback', project: b.project, target: proposal.id,
        result: rollbackProblems.length ? 'ROLLBACK_FAILED' : 'ROLLED_BACK',
        note: truncate(e.message, 120), data: { error: e.message, code: e.code || null, rollbackProblems, before },
      });
      if (rollbackProblems.length) fail('ROLLBACK_FAILED', 'apply 失败且回滚不完整，立即停手', { original: e.message, rollbackProblems });
      fail('APPLY_ROLLED_BACK', `apply 失败，已回滚：${e.message}`, { original: e.code || e.message });
    }
    const artifacts = loadArtifacts(b.project);
    const after = [];
    for (const w of written) {
      if (proposal.scope === 'shared') {
        // 共享层文件不属于项目产物：不写项目产物登记表，避免 verify 把“项目里没有该文件”判成漂移。
        after.push({ target: w.target, hash: w.hash, version: 1 });
        continue;
      }
      const prev = artifacts.artifacts[w.target];
      artifacts.artifacts[w.target] = {
        hash: w.hash, size: fs.statSync(path.join(targetRoot, w.target)).size,
        version: Number(prev?.version || 0) + 1, updatedAt: nowIso(), commitId, owner: proposal.author,
      };
      after.push({ target: w.target, hash: w.hash, version: artifacts.artifacts[w.target].version });
    }
    if (proposal.scope !== 'shared') saveArtifacts(b.project, artifacts);
    const commit = {
      id: commitId, project: b.project, proposalId: proposal.id, proposalHash: proposal.proposalHash,
      task: proposal.task, risk: proposal.risk, scope: proposal.scope || 'project', author: proposal.author, appliedBy: b.role,
      log: truncate(String(args.log || proposal.rationale || proposal.title || '文件提交'), 160),
      createdAt: nowIso(), before, after, signatures: loadSignatures(b.project, proposal.id), reviews: loadReviews(b.project, proposal.id),
    };
    saveCommit(b.project, commit);
    // 设计提案 apply 即签字完成：把签字证据写进 工作流.json.designReview，G4 不再“永远没人写”。
    // 共享层提案不是项目设计文件，不写设计签字/开发产出镜像。
    const designSignature = proposal.scope === 'shared' ? null : recordDesignSignature(b.project, project, proposal, commit, b.role);
    // 开发产出快照是派生镜像：失败不能让 apply 半途而废（提交已成事实），只记错误。
    let devOutput = null;
    if (proposal.scope !== 'shared') {
      try {
        devOutput = syncDevOutput(b.project, proposal, commit);
      } catch (e) {
        devOutput = { ok: false, error: e.message || String(e) };
        try {
          appendLine(path.join(projectStatePaths(b.project).dir, '产出快照待重建.jsonl'),
            JSON.stringify({ at: nowIso(), proposal: proposal.id, commit: commitId, error: devOutput.error }));
        } catch { /* ignore */ }
      }
    }
    proposal.status = 'applied';
    proposal.appliedAt = nowIso();
    proposal.appliedBy = b.role;
    proposal.commitId = commitId;
    saveProposal(b.project, proposal);
    appendEvent({
      role: b.role, sessionId: b.sessionId, action: 'apply', project: b.project, target: proposal.id,
      note: `commit=${commitId} files=${written.length}`, data: { commitId, after, proposalHash: proposal.proposalHash },
    });
    const idx = generateIndex(project, { by: b.role, sessionId: b.sessionId, silent: true });
    const mirror = mirrorSafe(b.project, 'apply');
    out(args, `已提交 ${commitId}\n提案 ${proposal.id}：${written.map((w) => w.target).join(', ')}\n备份：${backupRoot}\n索引已更新（${idx.files} 文件）${designSignature ? `\n设计签字已落账：${designSignature.path} ${String(designSignature.sha256).slice(0, 12)}` : ''}${devOutput && devOutput.ok ? `\n开发产出快照：${devOutput.dir}` : ''}${mirror && mirror.pending ? '\n提案镜像待重建（团队状态已落盘）' : ''}`, { ok: true, commit, index: idx, devOutput, designSignature, proposalMirror: mirror });
  } finally {
    try { releaseLock(lockKey, { role: b.role }); } catch { /* ignore */ }
  }
}

// ========== 授权 ==========

function parseExpiry(v) {
  if (!v) return new Date(Date.now() + 7 * 86400000).toISOString();
  const s = String(v).trim();
  const m = s.match(/^(\d+)([dhm])$/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : 60000;
    return new Date(Date.now() + n * ms).toISOString();
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) fail('BAD_EXPIRY', `看不懂的过期时间：${v}（用 7d / 12h / ISO）`);
  return new Date(t).toISOString();
}

export function cmdGrant(args) {
  const sub = args._[1] || 'add';
  const b = bootFor(args, 'grant');
  if (sub === 'list') {
    const roles = args.role ? [String(args.role)] : activeRoles(loadTeam());
    const rows = [];
    for (const r of roles) {
      for (const g of loadGrants(r).grants || []) {
        if (g.revokedAt) continue;
        rows.push({ role: r, id: g.id, project: g.project, actions: (g.actions || []).join('/'), scope: (g.scope || []).join(','), expires: String(g.expiresAt).slice(0, 10), reason: g.reason });
      }
    }
    out(args, `授权（${rows.length}）\n` + table(rows, [
      { key: 'role', label: '角色' }, { key: 'id', label: '授权' }, { key: 'project', label: '项目' }, { key: 'actions', label: '动作' }, { key: 'scope', label: '范围' }, { key: 'expires', label: '到期' }, { key: 'reason', label: '理由' },
    ]), { ok: true, grants: rows });
    return;
  }
  if (b.role !== 'pm') fail('NOT_PM', '只有 PM 能授权');
  if (sub === 'revoke') {
    if (!args.id || !args.to) fail('BAD_ARGS', '需要 --to 和 --id');
    const g = revokeGrant(String(args.to), String(args.id), b.role, args.reason || '');
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'grant_revoke', project: g.project, target: g.id, note: `${g.role} ${g.reason}` });
    out(args, `已撤销授权 ${g.id}（${g.role}）`, { ok: true, grant: g });
    return;
  }
  if (!args.to) fail('BAD_ARGS', '需要 --to');
  memberOrFail(loadTeam(), String(args.to));
  const actions = String(args.actions || 'propose').split(',').map((s) => s.trim()).filter(Boolean);
  const scopes = (Array.isArray(args.scope) ? args.scope : String(args.scope || '**').split(',')).map((s) => String(s).trim()).filter(Boolean);
  const project = String(args.project || b.project);
  if (!args.reason) fail('REASON_REQUIRED', '授权必须写 --reason（为什么给、给多久）');
  const grant = addGrant({
    role: String(args.to), actions, scope: scopes, project,
    grantedBy: b.role, expiresAt: parseExpiry(args.expires), reason: String(args.reason),
  });
  appendEvent({
    role: b.role, sessionId: b.sessionId, action: 'grant', project, target: grant.id,
    note: `${grant.role} ${actions.join('/')} ${scopes.join(',')}`, data: { grant },
  });
  notify({
    from: b.role, to: grant.role, subject: `授权 ${grant.id}`,
    body: `${actions.join('/')} @ ${project}：${scopes.join(', ')}\n到期：${grant.expiresAt.slice(0, 10)}\n理由：${grant.reason}`,
    project, ackRequired: true, type: 'grant', sessionId: b.sessionId,
  });
  out(args, `已授权 ${grant.id} → ${grant.role}：${actions.join('/')} @ ${scopes.join(', ')}（到期 ${grant.expiresAt.slice(0, 10)}）`, { ok: true, grant });
}

// ========== 索引 ==========

const INDEX_MANUAL_BEGIN = '<!-- 人工说明:BEGIN -->';
const INDEX_MANUAL_END = '<!-- 人工说明:END -->';

function scanProject(project) {
  const skip = new Set(['node_modules', '.git', '.team', '备份', '_backup', 'dist', 'build', '.cache']);
  const files = [];
  function walk(dir, depth) {
    if (depth > 8 || files.length > 2000) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (files.length > 2000) break;
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skip.has(ent.name)) continue;
        walk(abs, depth + 1);
      } else if (ent.isFile()) {
        const rel = relPath(project.path, abs);
        if (rel === (project.index || '项目索引.md') || rel === '项目索引.json') continue;
        const st = fs.statSync(abs);
        let hash = '';
        if (st.size <= 2 * 1024 * 1024) {
          try { hash = hashFile(abs); } catch { hash = ''; }
        }
        files.push({ target: rel, size: st.size, mtime: st.mtime.toISOString(), hash });
      }
    }
  }
  walk(project.path, 0);
  return files.sort((a, b) => a.target.localeCompare(b.target, 'zh-CN'));
}

function publicCommit(c) {
  const copy = JSON.parse(JSON.stringify(c || {}));
  for (const sig of Object.values(copy.signatures || {})) {
    if (sig && typeof sig === 'object') delete sig.sessionId;
  }
  for (const rv of Object.values(copy.reviews || {})) {
    if (rv && typeof rv === 'object') delete rv.sessionId;
  }
  return copy;
}

function fileKindLabel(abs) {
  const ext = path.extname(abs).toLowerCase();
  return ({
    '.md': 'Markdown', '.markdown': 'Markdown', '.txt': '文本', '.json': 'JSON',
    '.js': 'JavaScript', '.mjs': 'ESM', '.cjs': 'CommonJS', '.ts': 'TypeScript',
    '.py': 'Python', '.html': 'HTML', '.css': 'CSS', '.csv': 'CSV',
    '.png': '图片', '.jpg': '图片', '.jpeg': '图片', '.webp': '图片', '.gif': '图片', '.svg': '矢量图',
    '.mp4': '视频', '.mov': '视频', '.pdf': 'PDF', '.zip': '压缩包', '.docx': 'Word', '.xlsx': 'Excel', '.pptx': 'PPT',
  }[ext] || (ext ? ext.slice(1).toUpperCase() : '文件'));
}

function fileSummary(abs, rel) {
  const ext = path.extname(abs).toLowerCase();
  if (['.md', '.markdown', '.txt'].includes(ext)) {
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8').slice(0, 2400).replace(/^\uFEFF/, ''); } catch { return fileKindLabel(abs); }
    const lines = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const heading = lines.find((x) => /^#{1,4}\s+/.test(x));
    if (heading) return truncate(heading.replace(/^#{1,4}\s+/, '').replace(/[*_`]/g, ''), 72);
    const first = lines.find((x) => !x.startsWith('<!--') && !x.startsWith('>') && !x.startsWith('|---'));
    if (first) return truncate(first.replace(/^[-*]\s+/, '').replace(/[*_`]/g, ''), 72);
    return fileKindLabel(abs);
  }
  if (ext === '.json') {
    try {
      const j = JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, ''));
      const keys = j && typeof j === 'object' ? Object.keys(j).slice(0, 4).join('、') : '';
      return keys ? 'JSON：' + keys : 'JSON 数据';
    } catch { return 'JSON'; }
  }
  return fileKindLabel(abs) + (rel ? '' : '');
}

function fileUpdated(abs) {
  try { return fs.statSync(abs).mtime.toISOString().slice(0, 16).replace('T', ' '); } catch { return ''; }
}

function ownerForRel(rel) {
  const top = String(rel).split(/[\\/]/)[0];
  for (const [role, dir] of Object.entries(ROLE_DIRS)) if (dir === top) return role;
  if (top === '需求') return '需求分析师';
  return 'PM';
}

function reqIdOf(rel) {
  const m = /(R-[0-9A-Za-z-]+)/.exec(path.basename(String(rel)));
  return m ? m[1].replace(/-+$/, '') : path.basename(String(rel), path.extname(String(rel)));
}

function writeRoleIndexes(project) {
  const out = [];
  let dirs = [];
  let supIndex = null;
  try { supIndex = supplementIndexOf(project.path); } catch { supIndex = null; }
  try { dirs = fs.readdirSync(project.path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
  for (const name of dirs) {
    const dir = path.join(project.path, name);
    const indexPath = path.join(dir, '文件索引.md');
    if (!exists(indexPath) && !exists(path.join(dir, '角色卡.md')) && !exists(path.join(dir, 'README.md'))) continue;
    const rows = [];
    function walk(p, depth) {
      if (depth > 4 || rows.length >= 80) return;
      for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
        if (rows.length >= 80) break;
        if (ent.name.startsWith('.')) continue;
        const abs = path.join(p, ent.name);
        if (ent.isDirectory()) walk(abs, depth + 1);
        else if (ent.isFile() && ent.name !== '文件索引.md') {
          const st = fs.statSync(abs);
          const hash = st.size <= 2 * 1024 * 1024 ? shortHash(hashFile(abs), 10) : '(大文件)';
          // AC10⑥：卷行必须标注所属需求 id（靠 4 位短 key 反查 R-*.md），否则读者不知道卷属于谁。
          const supMatch = SUPPLEMENT_RE.exec(ent.name);
          const summary = supMatch
            ? `需求 ${(supIndex && supIndex.reqByKey.get(supMatch[1].toLowerCase())) || supMatch[1]} 的增补卷 · ${st.size}B · sha256 ${shortHash(hashFile(abs), 12)}`
            : fileSummary(abs, relPath(dir, abs));
          rows.push({ target: relPath(dir, abs), summary, size: st.size, updated: fileUpdated(abs), hash });
        }
      }
    }
    walk(dir, 0);
    rows.sort((a, b) => a.target.localeCompare(b.target, 'zh-CN'));
    const lines = [
      `# ${name} · 文件索引（目录）`, '',
      `> 自动更新：${nowIso()}。**这是目录，不是正文。** 按任务只读需要的文件。`,
      '> 由目录负责人维护；每次 apply 后自动重建。', '',
      '| 文件 | 摘要/用途 | 大小 | 更新 | 哈希 |', '|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.target} | ${r.summary.replace(/\|/g, '\\|')} | ${r.size} | ${r.updated} | ${r.hash} |`), '',
    ];
    let text = lines.join('\n');
    if (Buffer.byteLength(text, 'utf8') > 8192) text = text.slice(0, 7800) + '\n\n…（索引超限截断；完整文件请按目录继续阅读）\n';
    writeText(indexPath, text);
    out.push(indexPath);
  }
  return out;
}

/** 增补卷清单（项目索引 §三 / 项目索引.json / find 三处同源，AC11）。 */
function supplementIndexRows(project) {
  const out = [];
  try {
    const idx = supplementIndexOf(project.path);
    for (const [key, list] of idx.map) {
      for (const s of list) {
        let mtime = '';
        try { mtime = fs.statSync(path.join(project.path, s.rel)).mtime.toISOString(); } catch { mtime = ''; }
        out.push({ requirementId: s.requirementId || key, rel: s.rel, name: s.name, bytes: s.bytes, sha256: s.sha256, mtime });
      }
    }
  } catch { /* 没有卷目录就是空表 */ }
  out.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-Hans-CN'));
  return out;
}

export function generateIndex(project, { by = 'system', sessionId = 'system', silent = false } = {}) {
  const files = scanProject(project);
  const artifacts = loadArtifacts(project.name).artifacts || {};
  const tasks = listTasks(project.name);
  const commits = listCommits(project.name).slice(-5).reverse();
  let manual = '';
  const oldPath = projectIndexPath(project);
  if (exists(oldPath)) {
    const old = readText(oldPath, '');
    const m = old.match(/<!-- 人工说明:BEGIN -->([\s\S]*?)<!-- 人工说明:END -->/);
    if (m) manual = m[1].trim();
  }
  const rows = files.map((f) => ({
    target: f.target, size: f.size, mtime: f.mtime, hash: f.hash ? shortHash(f.hash, 10) : '(大文件)',
    owner: artifacts[f.target]?.owner || ownerForRel(f.target), version: artifacts[f.target]?.version || '',
  }));
  const done = tasks.filter((t) => t.status === 'done').length;
  const working = tasks.filter((t) => t.status === 'working').length;
  const open = tasks.filter((t) => t.status === 'open').length;
  const lines = [];
  const byRel = new Map(rows.map((r) => [r.target, r]));
  let selfStat = null;
  try { selfStat = fs.statSync(oldPath); } catch { /* first run */ }
  const selfRow = selfStat ? { target: '项目索引.md', size: selfStat.size, mtime: selfStat.mtime.toISOString(), hash: '', owner: 'pm', version: '' } : null;
  const rel = (p) => p.replace(/\\/g, '/');
  const teamMode = projectTeamMode(project);
  const modeRoles = rolesForMode(teamMode);
  const modeLabel = teamMode === 'fast' ? '四角色' : '六角色';
  const required = [
    ['项目铁律.md', '按需避坑：底线、红线、失败即停（不必每轮读）', 'PM', '按需'],
    ['项目信息.md', '项目目标、场景、交付、边界、任务分配', 'PM', '接需求/开工前'],
    ['协作准则.md', `${modeLabel}协同、启动顺序、需求与文件规则`, 'PM', '首次/规则变更'],
    ['项目索引.md', '本目录：必读顺序与文件导航', 'PM', '每次'],
    ['团队会话.md', `${modeLabel}会话 id / 模型（程序生成，不手改）`, '程序', '建团队/换会话后'],
    ['需求/00-需求总览.md', '需求目录：需求 id → 文件 → 状态', '需求分析师', '接需求前'],
  ];
  const roleDirs = Object.entries(ROLE_DIRS)
    .filter(([role]) => modeRoles.includes(role))
    .map(([role, dir]) => {
      const fs0 = rows.filter((r) => r.target.startsWith(dir + '/'));
      return { role, dir, count: fs0.length, index: `${dir}/文件索引.md`, name: ROLE_NAMES[role] || role };
    });
  const reqRows = rows.filter((r) => r.target.startsWith('需求/') && !['需求/00-需求总览.md', '需求/需求模板.md', '需求/README.md', '需求/文件索引.md'].includes(r.target));
  const reqOverview = byRel.get('需求/00-需求总览.md');
  const sizeOf = (r) => r ? `${r.size} B` : '—';
  const updateOf = (r) => r ? String(r.mtime).slice(0, 16).replace('T', ' ') : '—';
  const verOf = (r) => r ? (r.version ? `v${r.version}` : '已登记') : '缺文件';
  const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

  lines.push(`# ${project.name} · 项目索引（目录）`);
  lines.push('');
  lines.push(`> 自动生成：${nowIso()} ｜ 由 \`team.mjs index\` 维护，**这是目录，不是项目介绍或需求正文**。`);
  lines.push(`> 团队模式：${TEAM_MODE_LABELS[teamMode]}（${teamModeDescription(teamMode)}）。`);
  lines.push('> 先读顺序：**项目铁律 → 项目信息 → 本索引 → 角色卡/文件索引 → 任务指定文件**。');
  lines.push('');
  lines.push(INDEX_MANUAL_BEGIN);
  lines.push(manual || '- （PM 临时说明；index 会保留这段，不要在这里写长需求）');
  lines.push(INDEX_MANUAL_END);
  lines.push('');
  lines.push('## 一、必读文件（按顺序）');
  lines.push('');
  lines.push('| 顺序 | 文件 | 作用 | 维护人 | 何时读 | 更新 | 大小 | 状态 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  const requiredVisible = required.filter(([target]) => target !== '团队会话.md' || byRel.has(target));
  requiredVisible.forEach(([target, purpose, owner, when], i) => {
    const r = byRel.get(target) || (target === '项目索引.md' ? selfRow : null);
    lines.push(`| ${i + 1} | [${target}](${rel(target)}) | ${cell(purpose)} | ${owner} | ${when} | ${updateOf(r)} | ${sizeOf(r)} | ${verOf(r)} |`);
  });
  lines.push('');
  lines.push('## 二、目录导航（先看这里再翻文件）');
  lines.push('');
  lines.push('| 目录 | 负责人 | 文件数 | 目录索引 | 什么时候读 |');
  lines.push('|---|---|---|---|---|');
  lines.push(`| [需求/](需求/) | 需求分析师 / PM | ${rows.filter((r) => r.target.startsWith('需求/')).length} | [需求/文件索引.md](需求/文件索引.md) | 接需求、验收、变更 |`);
  for (const d of roleDirs) {
    lines.push(`| [${d.dir}/](${rel(d.dir)}/) | ${d.name} | ${d.count} | [${d.index}](${rel(d.index)}) | 只读任务涉及的文件 |`);
  }
  lines.push('');
  lines.push('## 三、需求目录');
  lines.push('');
  if (!reqOverview) {
    lines.push('（缺少 `需求/00-需求总览.md`；PM 先创建需求目录入口。）');
  } else {
    lines.push('| 需求 id | 文件 | 摘要 | 状态 | 更新 |');
    lines.push('|---|---|---|---|---|');
    for (const r of reqRows.slice(0, 40)) {
      lines.push(`| ${reqIdOf(r.target)} | [${path.basename(r.target)}](${rel(r.target)}) | ${cell(fileSummary(path.join(project.path, r.target), r.target))} | ${verOf(r)} | ${updateOf(r)} |`);
    }
    if (!reqRows.length) lines.push('| — | [00-需求总览.md](需求/00-需求总览.md) | 暂无需求；新需求复制 需求/需求模板.md，另存为 R-...md | 目录 |  |');
    // R-f9b1 AC11：增补卷按需求 id 单列一行（与 需求/文件索引.md、find 同源），不计入需求数。
    const supRows = supplementIndexRows(project);
    for (const s of supRows) {
      lines.push(`| ${s.requirementId} | [${path.basename(s.rel)}](${rel(s.rel)}) | 需求 ${s.requirementId} 的增补卷 · ${s.bytes}B · sha256 ${String(s.sha256).slice(0, 12)} | 增补卷 | ${String(s.mtime || '').slice(0, 16).replace('T', ' ')} |`);
    }
    if (supRows.length) lines.push(`> 增补卷 ${supRows.length} 卷（属「需求」分组，不计入需求数 ${reqRows.length}）。`);
  }
  lines.push('');
  lines.push('## 四、当前任务（详情看看板）');
  lines.push('');
  lines.push(`进行中 **${working}** ｜ 待接 **${open}** ｜ 完成 **${done}**`);
  const openTasks = tasks.filter((x) => x.status !== 'done').slice(0, 8);
  if (!openTasks.length) lines.push('（无进行中任务）');
  for (const t of openTasks) lines.push(`- [${t.priority}] ${t.id} ${t.status} ${t.owner || '-'} — ${t.title}`);
  lines.push('');
  lines.push('## 五、最近提交');
  lines.push('');
  if (!commits.length) lines.push('（暂无）');
  for (const c of commits) lines.push(`- ${c.id} ｜ ${String(c.createdAt).slice(0, 19).replace('T', ' ')} ｜ ${c.proposalId} ｜ ${c.after.map((a) => a.target).join(', ')}`);
  lines.push('');
  lines.push('## 六、避雷铁律（按需查，不必每轮读）');
  lines.push('');
  lines.push('- 每次先读《项目铁律.md》，再读项目信息/本索引/角色卡；不要凭上一次记忆开工。');
  lines.push('- 只读任务需要的文件；不要每次把 `需求/`、角色目录全量读一遍。');
  lines.push('- 一个需求一个 `R-...md`；新需求新建，澄清更新原文件；单文件 ≤ 16KB，超了拆分。');
  lines.push('- 写文件只走 `propose → review → sign → apply`；不直接改目标文件。');
  lines.push('- 没有回执 = 没发生；没有签字 = 没批准；没有 CAS = 不算提交。');
  lines.push('- 只写授权目录，不碰别人文件；密钥/账号/私密内容只记路径。');
  lines.push('- 文件变更多、目录变长时，PM 必须重跑 `team.mjs index`，保持本目录实时。');
  lines.push('');
  lines.push('## 七、维护规则');
  lines.push('');
  lines.push('- 本文件是**目录**：不放需求正文、不放长篇项目介绍；项目介绍在 `项目信息.md`。');
  lines.push('- 每次 apply 自动重建；PM 也可以在内容变更后手工跑 `node 团队\\工具\\team.mjs index --project "' + project.name + '"`。');
  lines.push(`- 文件明细索引：${roleDirs.map((d) => `\`${d.index}\``).join('、')}；需求总览：\`需求/00-需求总览.md\`。`);
  lines.push(`- 索引 JSON：\`${path.join(project.path, '项目索引.json')}\``);
  lines.push('');
  let text = lines.join('\n');
  if (Buffer.byteLength(text, 'utf8') > 16384) text = text.slice(0, 15800) + '\n\n…（根索引超过 16KB 截断；详细文件见各目录《文件索引.md》）\n';
  writeText(oldPath, text);
  writeJson(path.join(project.path, '项目索引.json'), {
    project: project.name, generatedAt: nowIso(), files, tasks: { working, open, done },
    commits: commits.map(publicCommit),
    required: required.map(([target, purpose, owner, when]) => ({ target, purpose, owner, when })),
    roleDirs, requirements: reqRows.map((r) => ({ id: reqIdOf(r.target), target: r.target })),
    // R-f9b1：需求正文外置出的增补卷（find/索引共用同一份清单）
    supplements: supplementIndexRows(project),
  });
  const roleIndexes = writeRoleIndexes(project);
  appendEvent({ role: by, sessionId, action: 'index', project: project.name, target: '项目索引.md', note: `files=${files.length} roleIndexes=${roleIndexes.length}`, data: { files: files.length, roleIndexes: roleIndexes.length } });
  if (!silent) textOut(`索引已生成：${oldPath}（${files.length} 文件，${roleIndexes.length} 份目录索引）`);
  return { path: oldPath, files: files.length, rows: rows.length, roleIndexes: roleIndexes.length, requirements: reqRows.length };
}

// ========== R-f9b1 需求正文上限治理（工具侧：三入口 / 拆卷 / 回滚 / 可读性） ==========

/** splitId = <需求 id>-<内容 sha12>：revert 时允许只给 --split-id，这里反推需求 id。 */
function requirementIdOfSplitId(splitId) {
  const s = String(splitId || '');
  const m = /^(R-\d{8}-\d{4,6}(?:-[0-9a-z]{2,8})?)-[0-9a-f]{12}$/i.exec(s);
  return m ? m[1] : '';
}

/**
 * 拆分/回滚后同步「需求行 + 需求池记录」的 supplements[]（AC12）。
 * append-only：回滚时把该条标 retractedAt，不物理删（增补卷 §8.2）。
 */
function syncRequirementSupplements(projectName, projectPath, requirementId) {
  const records = supplementRecords(projectPath, requirementId);
  const now = nowIso();
  const merge = (prev) => {
    const list = Array.isArray(prev) ? prev.slice() : [];
    for (const rec of records) {
      const hit = list.find((x) => x && x.name === rec.name);
      if (hit) {
        hit.bytes = rec.bytes;
        hit.sha256 = rec.sha256;
        hit.path = rec.path;
        hit.splitId = rec.splitId;
        hit.createdAt = hit.createdAt || rec.createdAt;
        delete hit.retractedAt;
      } else {
        list.push({ name: rec.name, path: rec.path, bytes: rec.bytes, sha256: rec.sha256, createdAt: rec.createdAt, splitId: rec.splitId });
      }
    }
    for (const item of list) {
      if (!item || item.retractedAt) continue;
      if (!records.some((r) => r.name === item.name)) item.retractedAt = now;
    }
    return list;
  };
  let workflow = false;
  try {
    const read = readWorkflowState(projectName);
    if (read.exists) {
      const rows = (read.state && read.state.requirements) || {};
      const row = rows[requirementId]
        || Object.values(rows).find((r) => r && String(r.id || '').toLowerCase() === String(requirementId).toLowerCase());
      if (row) {
        row.supplements = merge(row.supplements);
        writeWorkflowState(projectName, read.state);
        workflow = true;
      }
    }
  } catch { /* 工作流写不了不影响拆分本身，池记录仍会尝试 */ }
  try {
    const task = loadTask(projectName, requirementId);
    task.supplements = merge(task.supplements);
    saveTask(projectName, task);
  } catch { /* 池记录缺失不算失败 */ }
  return { records, workflow };
}

/** 单个需求的尺寸体检 + 三入口结论（review/create 共用）。 */
function docSizeGate(project, requirementId, { entry, role, noSplit = false }) {
  const before = docSizeReport(project.path, requirementId);
  const result = { entry, before, split: null, after: before, problems: [] };
  if (!before.exists || before.level === 'ok' || before.whitelisted || noSplit) return result;
  result.split = splitRequirementDoc({ projectName: project.name, projectPath: project.path, requirementId, entry, actor: role });
  result.after = docSizeReport(project.path, requirementId);
  if (result.split && result.split.wrote) {
    // AC11/AC12：拆完立刻同步「需求行 + 池记录」并重建索引，否则索引与卷脱节
    syncRequirementSupplements(project.name, project.path, requirementId);
    try { generateIndex(project, { by: role || 'system', sessionId: 'doc-split', silent: true }); } catch { /* 索引失败不影响拆分 */ }
  }
  if (result.after.exists && (result.after.level === 'over' || result.after.level === 'near')) {
    result.problems.push({
      code: result.split && result.split.code ? result.split.code : (result.after.level === 'over' ? 'DOC_TOO_LARGE' : 'DOC_NEAR_LIMIT'),
      detail: result.after.level === 'over'
        ? `正文 ${result.after.bytes}B 超过 ${DOC_SPLIT_LIMIT} 字节，拆分后仍超限；先压缩或拆需求`
        : `正文 ${result.after.bytes}B 仍在线附近（目标 ${DOC_SPLIT_TARGET}），已按 ${DOC_SPLIT_RULE} 尽量外置`,
      bytes: result.after.bytes,
      level: result.after.level,
    });
  }
  return result;
}

/** boot 简报用：本角色当前任务所涉需求的增补卷（F-7⑧；缺失也写一行，不阻塞 boot）。 */
function supplementBriefLines(project, tasks) {
  const ids = new Set();
  for (const t of tasks) {
    if (!t) continue;
    if (t.type === 'requirement') ids.add(String(t.id));
    if (t.requirementId) ids.add(String(t.requirementId));
  }
  if (!ids.size) return [];
  let auditRows = [];
  try { auditRows = readSplitAudit(project.name).rows; } catch { auditRows = []; }
  const out = [];
  for (const id of ids) {
    const rows = listSupplements(project.path, id);
    if (!rows.length) {
      const had = auditRows.filter((r) => r && r.action === 'split' && r.requirementId === id).length;
      if (had) out.push(`增补卷缺失（SUPPLEMENT_MISSING）：需求 ${id} 有 ${had} 条拆分记录，但 需求/ 下没有卷`);
      continue;
    }
    for (const s of rows) {
      out.push(`增补卷 ${s.name}（${s.bytes}B，sha256 ${s.sha256.slice(0, 12)}）— 需求 ${id} 主正文已外置的章节在此`);
    }
  }
  return out.slice(0, 6);
}

export function cmdIndex(args) {
  const team = loadTeam();
  const name = String(args.project || team.activeProject || '');
  if (!name) fail('NO_PROJECT', '需要 --project');
  const project = loadProject(name);
  const actor = String(args.role || 'system');
  const dryRun = Boolean(args['dry-run']);
  const splitIdArg = String(args['split-id'] || '');
  const wantRevert = Boolean(args.revert);
  const wantSplit = Boolean(args.split);
  const docSplit = { ok: true, rule: DOC_SPLIT_RULE, dryRun, entry: 'index', actions: [] };

  // 1) 回滚：index --revert --split-id <id>
  if (wantRevert) {
    const rid = String(args.requirement || '') || requirementIdOfSplitId(splitIdArg);
    if (!rid) fail('BAD_SPLIT_ID', '需要 --split-id <需求id>-<sha12> 或 --requirement <需求id>', { splitId: splitIdArg }, 1);
    const res = revertRequirementSplit({
      projectName: name, projectPath: project.path, requirementId: rid, splitId: splitIdArg, actor, dryRun, entry: 'index',
    });
    docSplit.actions.push(res);
    docSplit.ok = Boolean(res.ok);
    if (!dryRun && res.wrote) syncRequirementSupplements(name, project.path, rid);
    if (!docSplit.ok && res.code) docSplit.code = res.code;
  }

  // 2) 拆分：index --split（默认只巡检，零写入）
  const docs = scanRequirementDocs(project.path);
  const candidates = docs.filter((d) => !d.whitelisted && (d.level === 'over' || d.level === 'near'));
  docSplit.candidates = candidates.map((d) => ({
    requirementId: d.requirementId, rel: d.rel, bytes: d.bytes, level: d.level,
    movedSections: d.candidates, whitelisted: d.whitelisted,
  }));
  docSplit.summary = {
    total: docs.length,
    over: docs.filter((d) => d.level === 'over').length,
    near: docs.filter((d) => d.level === 'near').length,
    ok: docs.filter((d) => d.level === 'ok').length,
    whitelisted: docs.filter((d) => d.whitelisted).length,
    candidates: candidates.length,
  };
  if (wantSplit) {
    // 覆盖三类：贴线/超限（要拆）、白名单（要落 skip(whitelisted)）、已拆过（要落 skip(already_split) 幂等证据）。
    const targets = docs.filter((d) => d.whitelisted || d.split || d.level !== 'ok');
    for (const row of targets) {
      const res = splitRequirementDoc({
        projectName: name, projectPath: project.path, requirementId: row.requirementId,
        entry: 'index', actor, dryRun,
      });
      docSplit.actions.push(res);
      if (!res.ok) docSplit.ok = false;
      if (!dryRun && res.wrote) syncRequirementSupplements(name, project.path, row.requirementId);
    }
  }

  // 3) 索引重建（拆分后要收录卷，AC11）
  const r = generateIndex(project, { by: actor, sessionId: sessionOf(args), silent: Boolean(args.json) });
  // index 也是“重建项目内可见索引”的手动入口：顺手补齐 提案/ 镜像（曾失败/待重建时用它）。
  const mirror = mirrorSafe(name, 'index');

  if (args.json) {
    jsonOut({ ok: docSplit.ok, ...r, proposalMirror: mirror, docSplit });
  } else {
    const lines = [];
    lines.push(`正文巡检：${docs.length} 份（超限 ${docSplit.summary.over} ｜ 贴线 ${docSplit.summary.near} ｜ 正常 ${docSplit.summary.ok} ｜ 白名单 ${docSplit.summary.whitelisted}）`);
    if (!wantSplit && candidates.length) {
      lines.push('待处理（index 默认零写入；加 --split 执行，--split --dry-run 只看计划）：');
      for (const c of candidates.slice(0, 12)) lines.push(`  ${c.requirementId}  ${c.bytes}B  ${c.level}  可搬：${c.movedSections.join('、') || '（无）'}`);
    }
    for (const a of docSplit.actions) {
      const head = `${a.requirementId}  ${a.action}${a.reason ? '(' + a.reason + ')' : ''}  ${a.beforeBytes}→${a.afterBytes}B`;
      lines.push(`${a.ok ? '✓' : '✗'} ${head}${a.code ? ' ' + a.code : ''}${a.supplement ? ' 卷 ' + (a.supplement.rel || a.supplement.name) : ''}`);
      if (a.message) lines.push(`    ${a.message}`);
    }
    textOut(lines.join('\n'));
  }
  if (!docSplit.ok) process.exitCode = 1;
}

// ========== 状态 / 对账 / 验证 ==========

function checkDrift(project) {
  const artifacts = loadArtifacts(project.name).artifacts || {};
  const problems = [];
  for (const [rel, a] of Object.entries(artifacts)) {
    const abs = path.join(project.path, rel);
    if (!exists(abs)) { problems.push({ type: 'MISSING', target: rel, expected: a.hash }); continue; }
    const h = hashFile(abs);
    if (h !== a.hash) problems.push({ type: 'DRIFT', target: rel, expected: a.hash, current: h });
  }
  return problems;
}

function pilotCheckData(team) {
  const rawReceipts = loadReceipts().filter((r) => !r.update && r.msgId);
  const receipts = [...new Map(rawReceipts.map((r) => [`${r.msgId}|${r.from}`, r])).values()];
  const projects = listProjects();
  const commits = projects.flatMap((p) => listCommits(p.name));
  const { items: events } = readEventsStrict();
  const stale = events.filter((e) => e.action === 'apply' && e.result === 'STALE_BASE').length;
  const lockBusy = events.filter((e) => e.action === 'lock' && e.result === 'LOCK_BUSY').length;
  const verify = verifyAll();
  const checks = [
    { id: 'receipt', label: '消息回执', ok: receipts.length > 0, detail: `${receipts.length} 条回执` },
    { id: 'proposal', label: '提案闭环（评审+签字+提交）', ok: commits.length > 0, detail: `${commits.length} 次提交` },
    { id: 'stale', label: '陈旧版本被拒（STALE_BASE）', ok: stale > 0, detail: `${stale} 次拒绝` },
    { id: 'lock', label: '锁争用被拒（LOCK_BUSY）', ok: lockBusy > 0, detail: `${lockBusy} 次拒绝` },
    { id: 'verify', label: 'verify 全绿', ok: verify.ok, detail: verify.problems.length ? `${verify.problems.length} 个问题` : '无问题' },
  ];
  return { pass: checks.every((c) => c.ok), checks, team };
}

function renderStatus(team) {
  const projects = listProjects();
  const active = team.activeProject;
  const project = active ? projects.find((p) => p.name === active) : null;
  const tasks = project ? listTasks(project.name) : [];
  const proposals = project ? listProposals(project.name) : [];
  const commits = project ? listCommits(project.name) : [];
  const locks = listLocks();
  const { items: events } = readEventsStrict();
  const pilot = pilotCheckData(team);
  const lines = [];
  lines.push('# 团队看板');
  lines.push('');
  lines.push(`- 更新时间：${nowIso()}`);
  lines.push(`- 阶段：**${team.phase}** ｜ 当前项目：**${active || '未设置'}** ｜ Owner：${team.owner}`);
  lines.push(`- 成员：${activeMembers(team).map((m) => `${m.name}(${m.role})`).join('、')}`);
  lines.push('');
  lines.push('## 一、消息');
  for (const m of activeMembers(team)) lines.push(`- ${m.role} 未读：${unreadCount(m.role, team.activeProject || '')}`);
  lines.push('');
  lines.push('## 二、任务');
  if (!tasks.length) lines.push('（无）');
  for (const t of tasks.filter((x) => x.status !== 'done').slice(0, 20)) lines.push(`- [${t.priority}] ${t.id} ${t.status} ${t.owner || '-'} — ${t.title}`);
  lines.push('');
  lines.push('## 三、提案');
  if (!proposals.length) lines.push('（无）');
  for (const p of proposals.filter((x) => !['applied', 'rejected'].includes(x.status)).slice(0, 20)) lines.push(`- ${p.id} ${p.risk} ${p.status} by ${p.author} — ${p.title}`);
  lines.push('');
  lines.push('## 四、锁');
  if (!locks.length) lines.push('（无）');
  for (const l of locks) lines.push(`- ${l.key} @ ${l.role || l.owner} ${l.stale ? '(stale)' : ''} 到期 ${String(l.expiresAt).slice(11, 19)}`);
  lines.push('');
  // 问询（ask/answer）：未答数上板；超时未答的由 ask/answer 触发升级 PM 卡点。
  let questions = null;
  try {
    if (project) questions = askSummary(project.name);
  } catch { questions = null; }
  if (questions && questions.total) {
    lines.push(`- 问询：未答 ${questions.open} ｜ 超时待升级 ${questions.overdue} ｜ 已升级 ${questions.escalated} ｜ 已回答 ${questions.answered}`);
  }
  lines.push('## 五、试点门槛');
  for (const c of pilot.checks) lines.push(`- ${c.ok ? '✅' : '❌'} ${c.label}：${c.detail}`);
  lines.push(`- 结论：${pilot.pass ? '**通过，可以加人**' : '未通过，先补齐'}`);
  lines.push('');
  lines.push('## 六、最近事件');
  for (const e of events.slice(-10).reverse()) lines.push(`- ${hhmmss(e.ts)} [${e.role}] ${e.action} ${e.target} ${e.result !== 'ok' ? '(' + e.result + ')' : ''} — ${e.note}`);
  lines.push('');
  // 可选插件：只读探测；缺插件只标 off，不影响上面任何核心段。
  let plugins = null;
  try {
    plugins = detectOptionalPlugins();
    lines.push(...pluginStatusLines(plugins));
  } catch (error) {
    lines.push('## 可选插件（非核心 · 缺了不阻断）');
    lines.push(`- 探测失败：${String((error && error.message) || error).slice(0, 200)}（按 off 处理，不冒充 on）`);
    lines.push('- 降级标记：memory:off · vision:off · search:off');
  }
  lines.push('');
  return {
    text: lines.join('\n'),
    data: {
      team, project, tasks, proposals, commits, locks, pilot,
      questions,
      // status --json 的插件字段：list 是数组，其余是探测元信息（只读、无密钥）。
      plugins: plugins
        ? { ok: true, root: plugins.root, profile: plugins.profile, sources: plugins.sources, marks: plugins.marks, summary: plugins.summary, list: plugins.plugins }
        : { ok: false, marks: 'memory:off · vision:off · search:off', summary: { memory: 'off', vision: 'off', search: 'off' }, list: [] },
      // T-20261114-035413-2148：调用方（壳层/测试）要能直接读 optionalPlugins.memory.status + version，
      // 不用自己再去 plugins.list 里按 mode 找（旧字段保留，新增这一层按 mode 索引）。
      optionalPlugins: (() => {
        const rows = plugins && Array.isArray(plugins.plugins) ? plugins.plugins : [];
        const out = {};
        for (const mode of ['memory', 'vision', 'search']) {
          const row = rows.find((item) => item && item.mode === mode) || null;
          out[mode] = {
            id: row ? row.id : (mode === 'memory' ? 'memory-evolve' : mode),
            status: row ? String(row.status || 'off') : 'off',
            version: row ? String(row.version || '') : '',
            label: row ? String(row.label || '') : '',
            dataDir: row ? String(row.dataDir || '') : '',
            hint: row ? String(row.hint || '') : '',
          };
        }
        out.ok = Boolean(plugins && plugins.ok);
        out.marks = plugins ? String(plugins.marks || '') : 'memory:off · vision:off · search:off';
        return out;
      })(),
      events: events.slice(-20),
    },
  };
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function boardData(team, selectedName = '') {
  const projects = listProjects();
  const active = (selectedName ? projects.find((p) => p.name === selectedName) : null)
    || (team.activeProject ? projects.find((p) => p.name === team.activeProject) : null)
    || projects[0] || null;
  const projectName = active?.name || '';
  const project = active || null;
  const tasks = project ? listTasks(projectName) : [];
  const proposals = project ? listProposals(projectName) : [];
  const commits = (project ? listCommits(projectName) : []).map((c) => {
    let rationale = '';
    try { rationale = c.proposalId ? (loadProposal(projectName, c.proposalId)?.rationale || '') : ''; } catch { /* old commit */ }
    return { ...publicCommit(c), log: c.log || rationale || '文件提交' };
  });
  const receiptRows = loadReceipts().filter((r) => !r.update && r.msgId && (!projectName || !r.project || r.project === projectName));
  const receipts = [...new Map(receiptRows.map((r) => [`${r.msgId}|${r.from}`, r])).values()];
  const reviewsByProposal = {};
  for (const p of proposals) reviewsByProposal[p.id] = loadReviews(projectName, p.id);
  const sigsByProposal = {};
  for (const p of proposals) sigsByProposal[p.id] = loadSignatures(projectName, p.id);
  let files = [];
  if (project) {
    const idx = path.join(project.path, '项目索引.json');
    if (exists(idx)) {
      try { files = readJson(idx).files || []; } catch { files = []; }
    }
    if (!files.length) files = scanProject(project);
  }
  const { items: events } = readEventsStrict();
  const staleIds = new Set(events.filter((e) => e.action === 'apply' && e.result === 'STALE_BASE').map((e) => e.target));
  const proposalsView = proposals.map((p) => (staleIds.has(p.id) && p.status === 'approved' ? { ...p, status: 'stale' } : p));
  const artifacts = project ? (loadArtifacts(projectName).artifacts || {}) : {};
  files = files.map((f) => ({
    ...f, owner: artifacts[f.target]?.owner || f.owner || '', version: artifacts[f.target]?.version || '',
    abs: project ? path.join(project.path, f.target) : f.target,
  }));
  const requirementRows = tasks.filter((t) => t.type === 'requirement').map((r) => {
    const kids = tasks.filter((t) => t.requirementId === r.id);
    const done = kids.filter((k) => k.status === 'done').length;
    const working = kids.filter((k) => k.status === 'working').length;
    // PM 代管标识（T-a01d）：已由 PM 代落账的看 ownerReview.channel/recordedBy；还没落账但有 active 代管 → 待 PM 评审。
    const ownerReviewRow = (r.workflow && r.workflow.ownerReview) || r.ownerReview || null;
    let ownerProxyLabel = '';
    try {
      ownerProxyLabel = ownerProxyLabelOf(ownerReviewRow, activeProxyFor(projectName, r.id));
    } catch { ownerProxyLabel = ''; }
    return {
      ...r, kids, kidsDone: done, kidsTotal: kids.length,
      derivedStatus: kids.length ? (done === kids.length ? 'done' : working ? 'working' : 'open') : r.status,
      ownerProxyLabel,
    };
  });
  const memberStats = {};
  for (const m of activeMembers(team)) memberStats[m.role] = { role: m.role, name: m.name, session: m.sessionId ? '当前工作区' : '', sent: 0, reviews: 0, signs: 0, commits: 0, acks: 0 };
  for (const e of events) {
    if (memberStats[e.role]) {
      if (e.action === 'message') memberStats[e.role].sent++;
      if (e.action === 'review') memberStats[e.role].reviews++;
      if (e.action === 'sign') memberStats[e.role].signs++;
      if (e.action === 'apply') memberStats[e.role].commits++;
      if (e.action === 'ack') memberStats[e.role].acks++;
    }
  }
  const pilot = pilotCheckData(team);
  // R-c651 F-c651-3：唤醒失败红点的唯一真相在唤醒队列（看板每次重生成会整份覆盖 看板.json）。
  const wakeFailed = (() => { try { return projectName ? (readWakeQueue(projectName).failed || {}) : {}; } catch { return {}; } })();
  const logs = [
    ...commits.map((c) => ({
      ts: c.createdAt, actor: c.appliedBy || c.author || 'pm', kind: '提交',
      text: c.log || c.proposalId || '提交', target: c.id,
    })),
    ...receipts.map((r) => ({
      ts: r.ts, actor: r.from, kind: '回执',
      text: r.log || r.note || r.msgId || '回执', target: r.msgId,
    })),
  ].sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 120);
  // R-9db6 F-9db6-1 / F-9db6-5：Owner 决策箱的看板侧只读视图。
  // 真相仍是 团队/状态/项目/<项目>/决策箱.json；看板只读、不写回执、不改门禁（F-9db6-8）。
  const decisionBox = (() => {
    const empty = { project: projectName, file: '', unread: 0, open: 0, answered: 0, archived: 0, total: 0, corrupt: false, error: '', items: [] };
    if (!projectName) return empty;
    let read;
    try {
      read = readDecisionBoxFile(projectName);
    } catch (e) {
      return { ...empty, corrupt: true, error: String((e && e.message) || e).slice(0, 200) };
    }
    const rows = (read.box && Array.isArray(read.box.items) ? read.box.items : []).filter((x) => x && x.id);
    const openRows = rows.filter((x) => String(x.status || 'open') === 'open');
    // 需求/文件来源在看板窗口里能直接预览：先把绝对路径算好；消息来源在看板窗里没有读取通道。
    const resolveAbs = (src) => {
      const ref = String((src && src.ref) || '').trim();
      const kind = String((src && src.kind) || 'none');
      if (!ref || !project || !project.path) return '';
      try {
        if (kind === 'file') {
          const abs = path.join(project.path, ref);
          return exists(abs) ? abs : '';
        }
        if (kind === 'requirement') {
          const reqDir = path.join(project.path, '需求');
          if (!exists(reqDir)) return '';
          const hit = fs.readdirSync(reqDir).find((n) => n === ref || n.startsWith(`${ref}-`) || n.startsWith(`${ref}.`));
          return hit ? path.join(reqDir, hit) : '';
        }
      } catch { return ''; }
      return '';
    };
    return {
      project: projectName,
      file: String(read.file || ''),
      corrupt: !!read.corrupt,
      error: read.corrupt ? String(read.error || '决策箱读不出来').slice(0, 200) : '',
      unread: openRows.filter((x) => !x.readAt).length,
      open: openRows.length,
      answered: rows.filter((x) => String(x.status) === 'answered').length,
      archived: rows.filter((x) => String(x.status) === 'archived').length,
      total: rows.length,
      items: rows.slice(-50).map((x) => {
        const src = x.source && typeof x.source === 'object' ? x.source : { kind: 'none', ref: '' };
        return {
          id: String(x.id || ''),
          title: String(x.title || ''),
          summary: String(x.summary || ''),
          question: String(x.question || ''),
          status: String(x.status || 'open'),
          createdAt: String(x.createdAt || ''),
          readAt: x.readAt || null,
          answeredAt: x.answeredAt || null,
          options: Array.isArray(x.options) ? x.options.map(String) : [],
          source: { kind: String(src.kind || 'none'), ref: String(src.ref || ''), abs: resolveAbs(src) },
        };
      }),
    };
  })();
  return {
    generatedAt: nowIso(),
    team: { phase: team.phase, owner: team.owner, activeProject: team.activeProject },
    projects: projects.map((p) => ({ name: p.name, path: p.path, current: p.name === team.activeProject, selected: p.name === projectName, dshWorkspaceId: p.dshWorkspaceId || '' })),
    selectedProject: projectName,
    project, tasks, proposals: proposalsView, commits, receipts,
    reviews: reviewsByProposal, signatures: sigsByProposal, files,
    locks: listLocks(), events: [], members: Object.values(memberStats), pilot,
    requirements: requirementRows,
    childTasks: tasks.filter((t) => t.type !== 'requirement'),
    questions: projectName ? askSummary(projectName) : null,
    wakeFailed,
    decisionBox,
    logs,
  };
}

function renderBoardMd(d) {
  const lines = [];
  const req = d.requirements;
  const openTasks = d.childTasks.filter((t) => t.status !== 'done');
  lines.push(`# 团队看板 · ${d.project?.name || '（未选项目）'}`);
  lines.push('');
  lines.push(`> 生成 ${d.generatedAt} ｜ 阶段 ${d.team.phase} ｜ Owner ${d.team.owner} ｜ 成员 ${d.members.length}`);
  if (d.questions && d.questions.total) {
    lines.push(`> 问询：未答 ${d.questions.open} ｜ 超时待升级 ${d.questions.overdue} ｜ 已升级 ${d.questions.escalated} ｜ 已回答 ${d.questions.answered}`);
  }
  lines.push('');
  lines.push('## 一、需求看板');
  lines.push('');
  if (!req.length) lines.push('（暂无需求；用 `req create` 建）');
  else {
    lines.push('| 优先级 | 需求 | 状态 | Owner | 子任务 | 验收标准 |');
    lines.push('|---|---|---|---|---|---|');
    for (const r of req) {
      lines.push(`| ${r.priority} | ${r.id} ${r.title} | ${r.derivedStatus || r.status} | ${r.owner || '-'} | ${r.kidsDone ?? 0}/${r.kidsTotal ?? 0} | ${truncate(r.acceptance || '', 80)} |`);
    }
  }
  lines.push('');
  lines.push('## 二、任务');
  lines.push('');
  if (!openTasks.length) lines.push('（无进行中任务）');
  else {
    lines.push('| 优先级 | 任务 | 状态 | Owner | 需求 | 标题 |');
    lines.push('|---|---|---|---|---|---|');
    for (const t of openTasks.slice(0, 40)) lines.push(`| ${t.priority} | ${t.id} | ${t.status} | ${t.owner || '-'} | ${t.requirementId || '-'} | ${t.title} |`);
  }
  lines.push('');
  lines.push('## 三、提案 · 评审 · 签字');
  lines.push('');
  if (!d.proposals.length) lines.push('（暂无提案）');
  else {
    lines.push('| 提案 | 风险 | 状态 | 作者 | 评审 | 签字 | 提交 |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const p of d.proposals.slice(-40)) {
      const rv = Object.entries(d.reviews[p.id] || {}).map(([r, v]) => `${r}:${v.verdict}`).join(' ');
      const sg = Object.entries(d.signatures[p.id] || {}).map(([r, v]) => `${r}:${v.decision}`).join(' ');
      lines.push(`| ${p.id} ${truncate(p.title, 30)} | ${p.risk} | ${p.status} | ${p.author} | ${rv || '-'} | ${sg || '-'} | ${p.commitId || '-'} |`);
    }
  }
  lines.push('');
  lines.push('## 四、回执（最近 30 条）');
  lines.push('');
  if (!d.receipts.length) lines.push('（暂无回执）');
  else {
    lines.push('| 时间 | 回执人 | 项目 | 消息 | 备注 |');
    lines.push('|---|---|---|---|---|');
    for (const r of d.receipts.filter((x) => !x.update).slice(-30).reverse()) lines.push(`| ${r.ts.slice(0, 19).replace('T', ' ')} | ${r.from} | ${r.project || '-'} | ${r.msgId} | ${truncate(r.note, 60)} |`);
  }
  lines.push('');
  lines.push('## 五、项目文件');
  lines.push('');
  if (!d.files.length) lines.push('（暂无索引；先 `index`）');
  else {
    lines.push('| 文件 | 大小 | 哈希 | 归属 |');
    lines.push('|---|---|---|---|');
    for (const f of d.files.slice(0, 200)) lines.push(`| ${f.target} | ${f.size} | ${shortHash(f.hash || '', 10)} | ${f.owner || ''} |`);
  }
  lines.push('');
  lines.push('## 六、成员');
  lines.push('');
  lines.push('| 角色 | 名称 | 会话 | 发消息 | 评审 | 签字 | 提交 | 回执 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const m of d.members) lines.push(`| ${m.role} | ${m.name} | ${m.session || '-'} | ${m.sent} | ${m.reviews} | ${m.signs} | ${m.commits} | ${m.acks} |`);
  lines.push('');
  lines.push('## 七、试点门槛');
  for (const c of d.pilot.checks) lines.push(`- ${c.ok ? '✅' : '❌'} ${c.label}：${c.detail}`);
  lines.push(`- 结论：${d.pilot.pass ? '**PASS**' : '**FAIL**'}`);
  lines.push('');
  return lines.join('\n');
}

function renderBoardHtml(d) {
  const rowsReq = d.requirements.map((r) => {
    return `<tr><td><span class="pill p-${escHtml(r.priority)}">${escHtml(r.priority)}</span></td><td><b>${escHtml(r.id)}</b><br>${escHtml(r.title)}</td><td>${escHtml(r.derivedStatus || r.status)}</td><td>${escHtml(r.owner || '-')}</td><td>${r.kidsDone ?? 0}/${r.kidsTotal ?? 0}</td><td class="muted">${escHtml(truncate(r.acceptance || '', 140))}</td></tr>`;
  }).join('');
  const rowsTask = d.childTasks.filter((t) => t.status !== 'done').map((t) => `<tr><td><span class="pill p-${escHtml(t.priority)}">${escHtml(t.priority)}</span></td><td><b>${escHtml(t.id)}</b> ${escHtml(t.title)}</td><td>${escHtml(t.status)}</td><td>${escHtml(t.owner || '-')}</td><td>${escHtml(t.requirementId || '-')}</td></tr>`).join('');
  const rowsProp = d.proposals.slice(-40).reverse().map((p) => {
    const rv = Object.entries(d.reviews[p.id] || {}).map(([r, v]) => `<span class="tag ${v.verdict}">${escHtml(r)}:${escHtml(v.verdict)}</span>`).join(' ');
    const sg = Object.entries(d.signatures[p.id] || {}).map(([r, v]) => `<span class="tag ${v.decision}">${escHtml(r)}:${escHtml(v.decision)}</span>`).join(' ');
    return `<tr><td><b>${escHtml(p.id)}</b><br><span class="muted">${escHtml(truncate(p.title, 40))}</span></td><td>${escHtml(p.risk)}</td><td>${escHtml(p.status)}</td><td>${escHtml(p.author)}</td><td>${rv || '<span class="muted">-</span>'}</td><td>${sg || '<span class="muted">-</span>'}</td><td>${escHtml(p.commitId || '-')}</td></tr>`;
  }).join('');
  const rowsAck = d.receipts.filter((x) => !x.update).slice(-30).reverse().map((r) => `<tr><td class="muted">${escHtml(String(r.ts).slice(0, 19).replace('T', ' '))}</td><td>${escHtml(r.from)}</td><td>${escHtml(r.project || '-')}</td><td>${escHtml(r.msgId)}</td><td>${escHtml(truncate(r.note, 100))}</td></tr>`).join('');
  const rowsFile = d.files.slice(0, 300).map((f) => {
    const abs = d.project ? path.join(d.project.path, f.target) : f.target;
    return `<tr><td><a href="file:///${escHtml(abs.replace(/\\/g, '/'))}">${escHtml(f.target)}</a></td><td>${f.size}</td><td class="mono">${escHtml(shortHash(f.hash || '', 12))}</td><td>${escHtml(f.owner || '')}</td></tr>`;
  }).join('');
  const rowsMem = d.members.map((m) => `<tr><td><b>${escHtml(m.role)}</b><br><span class="muted">${escHtml(m.name)}</span></td><td class="mono">${escHtml(m.session || '-')}</td><td>${m.sent}</td><td>${m.reviews}</td><td>${m.signs}</td><td>${m.commits}</td><td>${m.acks}</td></tr>`).join('');
  const pilot = d.pilot.checks.map((c) => `<li>${c.ok ? '✅' : '❌'} <b>${escHtml(c.label)}</b>：${escHtml(c.detail)}</li>`).join('');
  const json = JSON.stringify(d).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>团队看板 · ${escHtml(d.project?.name || '')}</title>
<style>
:root{--bg:#0b0e14;--panel:#121722;--line:#243044;--text:#e6edf7;--muted:#8b9bb4;--accent:#5aa9ff;--ok:#3fb950;--warn:#d29922;--bad:#f85149}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif}
header{padding:22px 28px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:flex-end;gap:20px;flex-wrap:wrap}
h1{margin:0;font-size:22px}h2{font-size:16px;margin:0 0 10px;color:#cfe0f7} .muted{color:var(--muted)} .mono{font-family:Consolas,monospace;font-size:12px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;padding:18px 28px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px}.card b{display:block;font-size:26px;color:var(--accent)}
section{margin:0 28px 22px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;position:sticky;top:0;background:var(--panel)}tr:hover td{background:#172033}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:700}.p-P0{background:#5a1d1d;color:#ffb4b4}.p-P1{background:#4a3a12;color:#ffd48a}.p-P2{background:#12324a;color:#9fd0ff}.p-P3{background:#243044;color:#b8c6dc}
.tag{display:inline-block;padding:1px 7px;border-radius:6px;font-size:12px;margin:1px}.tag.approve{background:#12351d;color:#7ee2a0}.tag.reject{background:#4a1717;color:#ff9a9a}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
ul{margin:0;padding-left:20px}
footer{padding:0 28px 28px;color:var(--muted);font-size:12px}
body{padding-top:42px}
.board-chrome{position:fixed;left:0;right:0;top:0;height:38px;z-index:1000;display:flex;align-items:center;justify-content:space-between;padding:0 8px 0 14px;background:rgba(10,16,27,.86);border-bottom:1px solid var(--line);backdrop-filter:blur(10px);-webkit-app-region:drag}
.board-drag{display:flex;gap:12px;align-items:center;font-size:12px}.board-drag span{color:var(--muted);font-size:11px}
.board-actions{display:flex;gap:4px;-webkit-app-region:no-drag}.board-actions button{width:28px;height:25px;border:1px solid var(--line);border-radius:6px;background:#162033;color:var(--text);cursor:pointer;font:13px/1 sans-serif}.board-actions button:hover{background:#22314d}
body.collapsed .board-content{display:none}
</style></head><body>
<div class="board-chrome"><div class="board-drag"><b>👥 团队看板</b><span>可拖动 / 缩放 / 半透明悬浮</span></div><div class="board-actions"><button data-win="collapse" title="收纳成标题条">—</button><button data-win="zoom-out" title="缩小">－</button><button data-win="zoom-in" title="放大">＋</button><button data-win="maximize" title="最大化/还原">⛶</button><button data-win="close" title="关闭">×</button></div></div>
<div class="board-content">
<header><div><h1>团队看板 · ${escHtml(d.project?.name || '未选项目')}</h1><div class="muted">阶段 ${escHtml(d.team.phase)} ｜ Owner ${escHtml(d.team.owner)} ｜ 生成 ${escHtml(d.generatedAt)}</div></div><div class="muted">先读索引，再找文件 ｜ 中文思考 ｜ 签字绑定哈希</div></header>
<div class="cards">
<div class="card"><span class="muted">需求</span><b>${d.requirements.length}</b></div>
<div class="card"><span class="muted">进行中任务</span><b>${d.childTasks.filter((t) => t.status !== 'done').length}</b></div>
<div class="card"><span class="muted">提案</span><b>${d.proposals.length}</b></div>
<div class="card"><span class="muted">回执</span><b>${d.receipts.filter((x) => !x.update).length}</b></div>
<div class="card"><span class="muted">项目文件</span><b>${d.files.length}</b></div>
<div class="card"><span class="muted">成员</span><b>${d.members.length}</b></div>
</div>
<section><h2>一、需求看板</h2><table><thead><tr><th>优先级</th><th>需求</th><th>状态</th><th>Owner</th><th>子任务</th><th>验收标准</th></tr></thead><tbody>${rowsReq || '<tr><td colspan="6" class="muted">暂无需求；用 req create 建</td></tr>'}</tbody></table></section>
<section><h2>二、进行中任务</h2><table><thead><tr><th>优先级</th><th>任务</th><th>状态</th><th>Owner</th><th>需求</th></tr></thead><tbody>${rowsTask || '<tr><td colspan="5" class="muted">无</td></tr>'}</tbody></table></section>
<section><h2>三、提案 · 评审 · 签字</h2><table><thead><tr><th>提案</th><th>风险</th><th>状态</th><th>作者</th><th>评审</th><th>签字</th><th>提交</th></tr></thead><tbody>${rowsProp || '<tr><td colspan="7" class="muted">暂无提案</td></tr>'}</tbody></table></section>
<section><h2>四、回执（最近 30 条）</h2><table><thead><tr><th>时间</th><th>回执人</th><th>项目</th><th>消息</th><th>备注</th></tr></thead><tbody>${rowsAck || '<tr><td colspan="5" class="muted">暂无回执</td></tr>'}</tbody></table></section>
<section><h2>五、项目文件</h2><table><thead><tr><th>文件</th><th>大小</th><th>哈希</th><th>归属</th></tr></thead><tbody>${rowsFile || '<tr><td colspan="4" class="muted">暂无索引；先 index</td></tr>'}</tbody></table></section>
<section><h2>六、成员</h2><table><thead><tr><th>角色</th><th>会话</th><th>发消息</th><th>评审</th><th>签字</th><th>提交</th><th>回执</th></tr></thead><tbody>${rowsMem}</tbody></table></section>
<section><h2>七、试点门槛</h2><ul>${pilot}</ul></section>
<footer>数据源：团队\\状态\\看板.json ｜ 重新生成：node 团队\\工具\\team.mjs board</footer>
</div>
<script id="team-data" type="application/json">${json}</script>
<script>
(() => {
  const collapse = document.querySelector('[data-win="collapse"]');
  if (collapse) collapse.addEventListener('click', async () => {
    const c = document.body.classList.toggle('collapsed');
    collapse.textContent = c ? '＋' : '—';
    if (window.boardWin) await window.boardWin.control(c ? 'collapse' : 'expand');
  });
  for (const b of document.querySelectorAll('[data-win]:not([data-win="collapse"])')) {
    b.addEventListener('click', () => {
      const action = b.getAttribute('data-win');
      if (window.boardWin) window.boardWin.control(action);
      else if (action === 'close') window.close();
    });
  }
})();
</script>
</body></html>`;
}

export function cmdBoard(args) {
  const team = loadTeam();
  const selected = String(args.project || team.activeProject || '');
  const d = boardData(team, selected);
  const md = renderBoardMdV2(d);
  const html = renderBoardHtmlV2(d);
  const outDir = PATHS.teamRoot;
  writeText(path.join(outDir, '看板.md'), md);
  writeText(path.join(outDir, '看板.html'), html);
  writeJson(path.join(outDir, '状态', '看板.json'), d);
  writeText(PATHS.dashboard, md);
  if (args.json) jsonOut({ ok: true, generatedAt: d.generatedAt, files: [path.join(outDir, '看板.md'), path.join(outDir, '看板.html')], summary: { requirements: d.requirements.length, tasks: d.childTasks.length, proposals: d.proposals.length, receipts: d.receipts.filter((x) => !x.update).length } });
  else textOut(`看板已生成：\n- ${path.join(outDir, '看板.md')}\n- ${path.join(outDir, '看板.html')}\n需求 ${d.requirements.length} ｜ 任务 ${d.childTasks.length} ｜ 提案 ${d.proposals.length} ｜ 回执 ${d.receipts.filter((x) => !x.update).length} ｜ 文件 ${d.files.length}`);
}

export function cmdClaim(args) {
  const sub = String((args._ && args._[1]) || 'scan').toLowerCase();
  if (sub !== 'scan' && sub !== 'status' && sub !== 'clear') fail('CLAIM_SUB_UNKNOWN', 'claim 只支持 scan / status / clear');
  // PM 主动清标（认领门唯一的手工解除路径）：只清打标字段并写 cleared 审计，不改任务状态。
  if (sub === 'clear') {
    const id = String(args.id || '').trim();
    if (!id) fail('BAD_ID', 'claim clear 需要 --id <任务id>');
    const r = clearClaimFlags(String(args.project || ''), id, String(args.reason || 'manual_pm'));
    if (r.ok === false) fail(r.code || 'TASK_NOT_FOUND', `任务 ${id} 不存在`);
    if (args.json) { process.stdout.write(JSON.stringify({ ok: true, sub, id, changed: Boolean(r.changed), level: r.level || '' }) + '\n'); return; }
    textOut(`认领清标：${id} ${r.changed ? '已清（原级别 ' + (r.level || '—') + '）' : '本来就干净'}`);
    return;
  }
  const names = args.project
    ? [String(args.project)]
    : (listProjects() || []).map((p) => p.name || p.id).filter(Boolean);
  const projects = [];
  let scanned = 0; let written = 0; let pending = 0; let overdue = 0; let stalled = 0;
  for (const name of names) {
    const s = scanClaims(name, { write: sub === 'scan' && !args['dry-run'] });
    scanned += s.scanned; written += s.written.length; pending += s.pending;
    overdue += s.overdue.length; stalled += s.stalled.length;
    projects.push({
      project: name, scanned: s.scanned, pending: s.pending,
      overdue: s.overdue, stalled: s.stalled, written: s.written.length, audit: s.audit,
    });
  }
  const summary = `认领门：待认领 ${pending} · 超时 ${overdue} · 升级 ${stalled}`;
  if (args.json) {
    // 验收要求「--json 一行」：这里不走 jsonOut（它 pretty-print 多行），固定单行便于管道/grep。
    process.stdout.write(JSON.stringify({ ok: true, sub, projects: projects.length, scanned, written, pending, overdue, stalled, summary, rows: projects }) + '\n');
    return;
  }
  textOut([`认领扫描：项目 ${projects.length} · 扫描 ${scanned} · 待认领 ${pending} · 超时 ${overdue} · 升级 ${stalled} · 本轮打标 ${written}`, summary].join('\n'));
}

export function cmdStatus(args) {
  const team = loadTeam();
  const { text, data } = renderStatus(team);
  // T-20261116-124658-303e：固定一行汇总，可 grep（「认领门：待认领 N · 超时 N · 升级 N」）。
  const claimLine = claimLineForStatus();
  // a28a F9/AC6③：status 也要能看到各角色轮次（与 lessons turns 同一 readAllTurns 实现）
  const turnsLine = turnsLineForStatus();
  writeText(PATHS.dashboard, text + '\n\n' + claimLine + '\n' + turnsLine + '\n');
  if (args.json) jsonOut({ ok: true, ...data, claimGate: claimLine, lessonsTurns: turnsLine, dashboard: PATHS.dashboard });
  else textOut(text + '\n\n' + claimLine + '\n' + turnsLine);
}

/** a28a：`轮次：pm 3/20 · tester 0/20 …（阈值来源 project）`；无计数文件显示 — */
function turnsLineForStatus() {
  try {
    const team = loadTeam();
    const name = String(team.activeProject || '').trim();
    if (!name) return '轮次：—（无活动项目）';
    const st = projectStatePaths(name);
    const project = loadProject(name);
    const all = lessons.readAllTurns({ stateDir: st.dir, configPath: st.config, roleIds: projectRoleIds(project) });
    const parts = Object.keys(all.roles).map((role) => {
      const row = all.roles[role];
      return `${role} ${row && row.turns != null ? `${row.turns}/${all.threshold}` : '—'}`;
    });
    return `轮次：${parts.join(' · ')}（阈值 ${all.threshold}，来源 ${all.source}）`;
  } catch (e) {
    return '轮次：—（读取失败：' + String((e && e.message) || e).slice(0, 60) + '）';
  }
}

// 跨项目汇总（status 用）：只读，不打标。
function claimLineForStatus() {
  let pending = 0; let overdue = 0; let stalled = 0;
  for (const p of (listProjects() || [])) {
    const name = p.name || p.id;
    if (!name) continue;
    try {
      const s = scanClaims(name, { write: false });
      pending += s.pending; overdue += s.overdue.length; stalled += s.stalled.length;
    } catch { /* 单个项目读失败不影响汇总 */ }
  }
  return `认领门：待认领 ${pending} · 超时 ${overdue} · 升级 ${stalled}`;
}

export function cmdReconcile(args) {
  const team = loadTeam();
  const rows = [];
  const issues = [];
  const add = (area, metric, expected, actual, ok, evidence = '') => {
    rows.push({ area, metric, expected, actual, result: ok ? 'PASS' : 'FAIL', evidence });
    if (!ok) issues.push({ area, metric, expected, actual, evidence });
  };
  const chain = verifyEventChain();
  add('事件链', 'seq/prev/hash', '连续且 hash 匹配', `${chain.count} 条 / ${chain.problems.length} 问题`, chain.ok, chain.ok ? 'verifyEventChain' : JSON.stringify(chain.problems.slice(0, 3)));
  const locks = listLocks();
  const staleLocks = locks.filter((l) => l.stale);
  for (const l of staleLocks) {
    try { fs.rmSync(l.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  add('锁', '未过期锁数', '0 stale', `${staleLocks.length} stale / ${locks.length} total`, staleLocks.length === 0, staleLocks.map((l) => l.key).join(','));
  const projects = listProjects();
  const staleIds = new Set(readEventsStrict().items.filter((e) => e.action === 'apply' && e.result === 'STALE_BASE').map((e) => e.target));
  const activeProject = team.activeProject ? projects.find((p) => p.name === team.activeProject) : null;
  for (const p of projects) {
    const tasks = listTasks(p.name);
    const overdue = tasks.filter((t) => t.status !== 'done' && t.due && Date.parse(t.due) < Date.now());
    add('任务', `${p.name} 逾期`, '0', String(overdue.length), overdue.length === 0, overdue.slice(0, 3).map((t) => t.id).join(','));
    const maxAge = Number(team.config.proposalStaleHours || 24) * 3600000;
    const staleProps = listProposals(p.name).filter((pr) => !['applied', 'rejected', 'stale'].includes(pr.status) && !staleIds.has(pr.id) && Date.now() - Date.parse(pr.createdAt) > maxAge);
    add('提案', `${p.name} 超时未闭环`, '0', String(staleProps.length), staleProps.length === 0, staleProps.slice(0, 3).map((x) => x.id).join(','));
    const drift = checkDrift(p);
    add('文件', `${p.name} 哈希漂移`, '0', String(drift.length), drift.length === 0, drift.slice(0, 3).map((x) => x.target).join(','));
    const commits = listCommits(p.name);
    add('提交', `${p.name} 提交数`, '≥0', String(commits.length), true, commits.slice(-1).map((c) => c.id).join(','));
  }
  const receipts = loadReceipts().filter((x) => !x.update);
  add('回执', '回执条数', '≥1（pilot）', String(receipts.length), receipts.length > 0, receipts.slice(-1).map((r) => r.id).join(','));
  for (const m of activeMembers(team)) {
    const expired = (loadGrants(m.role).grants || []).filter((g) => !g.revokedAt && g.expiresAt && Date.parse(g.expiresAt) < Date.now());
    add('授权', `${m.role} 过期授权`, '0', String(expired.length), expired.length === 0, expired.slice(0, 3).map((g) => g.id).join(','));
  }
  const verify = verifyAll();
  add('总体', 'verify', 'PASS', verify.ok ? 'PASS' : `FAIL(${verify.problems.length})`, verify.ok, verify.problems.slice(0, 3).map((x) => x.type).join(','));
  const ackNote = String(args['ack-note'] || '');
  if (ackNote.length > Number(team.config.ackNoteMaxChars || 300)) fail('RECEIPT_TOO_LONG', `对账回执超过 ${team.config.ackNoteMaxChars} 字`);
  const now = nowIso();
  const lines = [];
  lines.push(`# 对账 · ${now.slice(0, 19).replace('T', ' ')}`);
  lines.push('');
  lines.push('| 项目 | 指标 | 期望 | 实测 | 结果 | 证据 |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of rows) lines.push(`| ${r.area} | ${r.metric} | ${r.expected} | ${r.actual} | ${r.result} | ${truncate(r.evidence, 120)} |`);
  lines.push('');
  lines.push('## 对账回执');
  lines.push('');
  const reviewer = activeRoles(team).includes('tester') ? 'tester' : 'pm（代，tester 未入队）';
  lines.push(`- 对账人：pm ｜ 复核人：${reviewer} ｜ 结论：${issues.length ? '有异常，停手处理' : '无异常，通过'}`);
  lines.push(`- 备注：${truncate(ackNote || '（无）', Number(team.config.ackNoteMaxChars || 300))}`);
  lines.push(`- 回执大小：${ackNote.length}/${team.config.ackNoteMaxChars} 字 ｜ 报告上限：${team.config.reconcileReportMaxKB}KB`);
  lines.push('');
  let md = lines.join('\n');
  const maxBytes = Number(team.config.reconcileReportMaxKB || 8) * 1024;
  if (Buffer.byteLength(md, 'utf8') > maxBytes) {
    md = md.slice(0, Math.floor(maxBytes / 3)) + '\n\n…（报告超限截断；完整数据见 对账.json）\n';
  }
  const outFile = activeProject ? path.join(projectStatePaths(activeProject.name).dir, '对账.md') : path.join(PATHS.state, '对账.md');
  writeText(outFile, md);
  if (activeProject) writeJson(projectStatePaths(activeProject.name).reconcile, { updatedAt: now, rows, issues });
  appendEvent({ role: 'system', sessionId: 'reconcile', action: 'reconcile', project: activeProject?.name || '', target: '对账.md', note: `issues=${issues.length} pass=${rows.filter((r) => r.result === 'PASS').length}/${rows.length}`, data: { issues, rows } });
  if (issues.length && args.notify !== false) {
    try {
      sendMessage({ from: 'system', to: 'pm', subject: `对账异常 ${issues.length} 项`, body: issues.slice(0, 8).map((i) => `${i.area}/${i.metric}: ${i.actual}`).join('\n'), project: activeProject?.name || '', ackRequired: true, type: 'reconcile' });
    } catch { /* no pm? ignore */ }
  }
  out(args, md, { ok: issues.length === 0, rows, issues, file: outFile });
}

function activeProjectState(team) {
  if (!team.activeProject) return false;
  try { loadProject(team.activeProject); return true; } catch { return false; }
}

export function verifyAll(projectFilter = null) {
  const problems = [];
  const warnings = [];
  const team = loadTeam();
  const chain = verifyEventChain();
  if (!chain.ok) problems.push({ type: 'EVENT_CHAIN', count: chain.problems.length, details: chain.problems.slice(0, 10) });
  const projects = projectFilter ? [loadProject(projectFilter)] : listProjects();
  for (const p of projects) {
    for (const pr of listProposals(p.name)) {
      if (pr.status !== 'applied') continue;
      const actual = computeProposalHash(pr);
      if (actual !== pr.proposalHash) problems.push({ type: 'PROPOSAL_HASH', project: p.name, proposal: pr.id, expected: pr.proposalHash, actual });
      let commit;
      try { commit = loadCommit(p.name, pr.commitId); } catch (e) { problems.push({ type: 'COMMIT_MISSING', project: p.name, proposal: pr.id, commit: pr.commitId }); continue; }
      // 历史提案只核对“提交记录里的 after 哈希”，当前文件由产物登记表 checkDrift 核对
      for (const f of pr.files) {
        const a = (commit.after || []).find((x) => x.target === f.target);
        if (!a) { problems.push({ type: 'COMMIT_FILE_MISSING', project: p.name, proposal: pr.id, target: f.target }); continue; }
        if (a.hash !== f.newHash) problems.push({ type: 'COMMIT_HASH', project: p.name, proposal: pr.id, target: f.target, expected: f.newHash, commit: a.hash });
      }
      const chk = checkApprovals(pr, team, { forApply: false, stored: true });
      if (chk.problems.length) problems.push({ type: 'APPROVALS', project: p.name, proposal: pr.id, details: chk.problems });
    }
    const drift = checkDrift(p);
    for (const d of drift) problems.push({ type: 'ARTIFACT', project: p.name, ...d });
    // 子代理：未结束/未复核的记录是“没发生”，验收前要能对账（只警告，不伪造拒收）。
    try {
      const sub = subagentAudit(p.name);
      for (const warning of sub.warnings) warnings.push({ type: warning.code, project: p.name, ...warning });
      for (const row of sub.running) warnings.push({ type: 'SUBAGENT_RUNNING', project: p.name, id: row.id, role: row.role, lockKey: row.lockKey });
    } catch { /* 旧项目没有子代理记录：忽略 */ }
    // 设计签字：项目级 designReview 的哈希应与当前设计文件一致；旧项目靠提交兜底，不阻断。
    try {
      const wf = readWorkflowState(p.name);
      const sig = wf.state && wf.state.designReview;
      if (sig && sig.path) {
        const abs = path.join(path.resolve(p.path), String(sig.path));
        if (!exists(abs)) warnings.push({ type: 'DESIGN_SIGNATURE_FILE_MISSING', project: p.name, path: sig.path });
        else if (sig.sha256 && hashFile(abs) !== sig.sha256) warnings.push({ type: 'DESIGN_SIGNATURE_STALE', project: p.name, path: sig.path, recordedHash: sig.sha256, currentHash: hashFile(abs) });
      }
    } catch { /* 工作流不可读：交给别的问题项 */ }
    // Owner 落账链复核：decisions[] 只增不改；旧单对象只读；打回不得留在可派单状态。
    const stateRead = readWorkflowState(p.name);
    if (stateRead.ok && stateRead.state && stateRead.state.requirements) {
      const phaseEdit = detectPhaseEdit({ state: stateRead.state, rows: Object.values(stateRead.state.requirements) });
      if (phaseEdit) warnings.push({ type: 'PHASE_EDIT', project: p.name, ...phaseEdit });
      for (const [id, row] of Object.entries(stateRead.state.requirements)) {
        const decisions = Array.isArray(row.decisions) ? row.decisions : [];
        const hashes = new Set();
        for (const [index, decision] of decisions.entries()) {
          const digest = sha256(JSON.stringify({ status: decision.status, at: decision.at, channel: decision.channel, basis: decision.basis || null, nonce: decision.confirmation && decision.confirmation.nonceHash }));
          if (hashes.has(digest)) problems.push({ type: 'OWNER_DECISION_DUPLICATE', project: p.name, requirement: id, index, digest: digest.slice(0, 12) });
          hashes.add(digest);
          if (decision.channel && !['ui', 'tty', 'test'].includes(String(decision.channel))) {
            problems.push({ type: 'OWNER_CHANNEL', project: p.name, requirement: id, index, channel: decision.channel });
          }
          if (String(decision.channel) === 'test' && decision.counted !== false) {
            warnings.push({ type: 'OWNER_TEST_CHANNEL', project: p.name, requirement: id, index });
          }
        }
        const latest = decisions.length ? decisions[decisions.length - 1] : null;
        if (latest && String(latest.status) === 'rejected' && ['ready', 'dev', 'test'].includes(String(row.status))) {
          problems.push({ type: 'OWNER_REJECTED_BUT_DISPATCHABLE', project: p.name, requirement: id, status: row.status });
        }
        if (row.ownerReview && row.ownerReview.status === 'pending' && row.ownerReview.at === null && !row.ownerReview.confirmation && /Owner\s*口头/.test(String(row.ownerReview.decisionLog || row.ownerReview.log || ''))) {
          warnings.push({ type: 'OWNER_LEGACY_UNRECORDED', project: p.name, requirement: id });
        }
      }
    }
  }
  for (const l of listLocks()) {
    if (l.stale) warnings.push({ type: 'STALE_LOCK', key: l.key, expiresAt: l.expiresAt });
    if (l.broken) warnings.push({ type: 'BROKEN_LOCK', key: l.key });
  }
  for (const m of activeMembers(team)) {
    for (const g of loadGrants(m.role).grants || []) {
      if (g.revokedAt) continue;
      if (g.expiresAt && Date.parse(g.expiresAt) < Date.now()) warnings.push({ type: 'EXPIRED_GRANT', role: m.role, grant: g.id, expiresAt: g.expiresAt });
    }
  }
  return { ok: problems.length === 0, problems, warnings, projects: projects.length, events: chain.count };
}

export function cmdVerify(args) {
  const r = verifyAll(args.project ? String(args.project) : null);
  const lines = [];
  lines.push(`verify：${r.ok ? '✅ PASS' : '❌ FAIL'}`);
  lines.push(`项目 ${r.projects} 个 ｜ 事件 ${r.events} 条 ｜ 问题 ${r.problems.length} ｜ 警告 ${r.warnings.length}`);
  for (const p of r.problems.slice(0, 30)) lines.push(`  ❌ ${p.type} ${JSON.stringify(p).slice(0, 220)}`);
  for (const w of r.warnings.slice(0, 20)) lines.push(`  ⚠ ${w.type} ${JSON.stringify(w).slice(0, 180)}`);
  if (args.json) jsonOut({ ok: r.ok, ...r });
  else textOut(lines.join('\n'));
  if (!r.ok) process.exitCode = 1;
}

export function cmdLog(args) {
  const { items } = readEventsStrict();
  const n = Number(args.tail || 20);
  let rows = items;
  if (args.project) rows = rows.filter((e) => e.project === args.project);
  rows = rows.slice(-n);
  const lines = rows.map((e) => `${e.ts.slice(0, 19).replace('T', ' ')} [${e.role}] ${e.action} ${e.target} ${e.result !== 'ok' ? '(' + e.result + ')' : ''} — ${e.note}`);
  out(args, lines.join('\n') || '（无事件）', { ok: true, events: rows });
}

// ========== 锁命令 ==========

export function cmdLock(args) {
  const sub = args._[1] || 'status';
  if (sub === 'status') {
    const locks = args.key ? [lockInfo(String(args.key))].filter(Boolean) : listLocks();
    out(args, locks.length ? locks.map((l) => `${l.key} @ ${l.role || l.owner} ${l.stale ? '(stale)' : ''} 到期 ${l.expiresAt}`).join('\n') : '（无锁）', { ok: true, locks });
    return;
  }
  const b = bootFor(args, 'lock');
  if (!args.key) fail('BAD_KEY', '需要 --key');
  const key = String(args.key);
  if (sub === 'acquire') {
    try {
      const owner = acquireLock(key, { role: b.role, sessionId: b.sessionId, ttlMs: Number(args.ttl || 60) * 1000, waitMs: 0, reason: args.reason || '' });
      appendEvent({ role: b.role, sessionId: b.sessionId, action: 'lock', project: b.project, target: key, note: 'acquired', data: { owner } });
      out(args, `已加锁 ${key}（${b.role}，到期 ${owner.expiresAt}）`, { ok: true, lock: owner });
    } catch (e) {
      appendEvent({ role: b.role, sessionId: b.sessionId, action: 'lock', project: b.project, target: key, result: e.code || 'ERROR', note: e.message });
      throw e;
    }
    return;
  }
  if (sub === 'release') {
    const ok = releaseLock(key, { role: b.role });
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'lock', project: b.project, target: key, note: ok ? 'released' : 'not-held' });
    out(args, ok ? `已释放 ${key}` : `锁不存在 ${key}`, { ok: true, released: ok });
    return;
  }
  if (sub === 'heartbeat') {
    const l = heartbeatLock(key, { role: b.role, ttlMs: Number(args.ttl || 60) * 1000 });
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'lock', project: b.project, target: key, note: 'heartbeat' });
    out(args, `已续期 ${key} 到 ${l.expiresAt}`, { ok: true, lock: l });
    return;
  }
  fail('BAD_SUBCOMMAND', `未知 lock 子命令：${sub}`);
}

// ========== owner 终端批准 ==========

export async function cmdOwnerApprove(args) {
  if (!args.proposal) fail('BAD_ID', '需要 --proposal');
  const team = loadTeam();
  const projectName = String(args.project || team.activeProject || '');
  if (!projectName) fail('NO_PROJECT', '需要 --project');
  const proposal = loadProposal(projectName, String(args.proposal));
  const actual = computeProposalHash(proposal);
  if (actual !== proposal.proposalHash) fail('PROPOSAL_TAMPERED', '提案哈希不符');
  let channel = 'tty';
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (process.env.TEAM_SELFTEST === '1' && args['test-owner']) {
      channel = 'selftest';
    } else {
      fail('OWNER_TTY_REQUIRED', 'owner 批准必须在真实终端运行（无 TTY 会被拒绝）。请在 PowerShell 里手动执行本命令。', { hint: `node 团队\\工具\\team.mjs owner-approve --proposal ${proposal.id} --project "${projectName}"` });
    }
  }
  textOut(`=== owner 批准 ===\n提案 ${proposal.id} · ${proposal.risk} · ${proposal.title}\n文件：${proposal.files.map((f) => f.target).join(', ')}\n提案哈希：${proposal.proposalHash}`);
  let answer = '';
  if (channel === 'tty') {
    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    answer = await rl.question(`输入「批准 ${proposal.id}」继续（其它输入=拒绝）：`);
    rl.close();
    if (answer.trim() !== `批准 ${proposal.id}`) fail('OWNER_ABORTED', 'owner 未批准');
  }
  const ts = nowIso();
  const nonce = randomHex(6);
  const baseHash = proposal.files.map((f) => f.baseHash).join(',');
  const newHash = proposal.files.map((f) => f.newHash).join(',');
  const sig = signatureDigest({ role: 'owner', proposalId: proposal.id, proposalHash: proposal.proposalHash, baseHash, newHash, decision: 'approve', ts, nonce });
  const record = {
    role: 'owner', proposalId: proposal.id, proposalHash: proposal.proposalHash, baseHash, newHash,
    decision: 'approve', note: truncate(String(args.note || '终端批准'), 300), ts, nonce, sig, channel, sessionId: channel === 'tty' ? 'tty' : 'selftest',
  };
  saveSignature(projectName, proposal.id, 'owner', record);
  appendEvent({ role: 'owner', sessionId: channel, action: 'owner_approve', project: projectName, target: proposal.id, note: `channel=${channel}`, data: { proposalHash: proposal.proposalHash, channel } });
  out(args, `owner 已批准 ${proposal.id}（channel=${channel}）`, { ok: true, signature: record });
}

// ========== 投票（vote start / cast / status） ==========
// 规则：除 PM 外全体角色参与；PM 只发起/记录，不投票。
// 驳回只有一种情形——除 PM 外全员一致驳回；赞成过半即通过；
// 全部投完既非一致驳回也无过半赞成 = 未形成多数（no_consensus），不冒充通过。
// 文件：团队/状态/项目/<slug>/投票/V-....json（真相）+ 同名 .md（人读），供壳层用 vote status 读取。

function votePaths(projectName) {
  const dir = projectStatePaths(projectName).votes;
  return {
    dir,
    file: (id) => path.join(dir, `${id}.json`),
    md: (id) => path.join(dir, `${id}.md`),
  };
}

function newVoteId(projectName) {
  const p = votePaths(projectName);
  for (let i = 0; i < 20; i++) {
    const id = 'V-' + stamp() + '-' + randomHex(2);
    if (!exists(p.file(id))) return id;
  }
  fail('VOTE_ID_COLLISION', '投票编号生成冲突，请重试');
}

function loadVote(projectName, id) {
  const file = votePaths(projectName).file(String(id));
  const vote = readJson(file, null);
  if (!vote) fail('VOTE_NOT_FOUND', `投票不存在：${id}`, { id, project: projectName, file });
  return vote;
}

function voteTally(vote) {
  const eligible = Array.isArray(vote.eligible) ? vote.eligible : [];
  const votes = vote.votes && typeof vote.votes === 'object' ? vote.votes : {};
  const cast = eligible.filter((r) => votes[r]);
  return {
    eligible,
    cast,
    pending: eligible.filter((r) => !votes[r]),
    approve: cast.filter((r) => votes[r].vote === 'approve'),
    reject: cast.filter((r) => votes[r].vote === 'reject'),
    abstain: cast.filter((r) => votes[r].vote === 'abstain'),
  };
}

function evaluateVote(vote) {
  const t = voteTally(vote);
  const total = t.eligible.length;
  if (!total) return { ...t, result: 'no_consensus', closed: true, reason: '没有可投票角色（除 PM 外）' };
  // 规则一：除 PM 外全员一致驳回才驳回。
  if (t.reject.length === total) return { ...t, result: 'rejected', closed: true, reason: '除 PM 外全员一致驳回' };
  // 规则二：赞成过半即通过。
  const majority = Math.floor(total / 2) + 1;
  if (t.approve.length >= majority) return { ...t, result: 'approved', closed: true, reason: `赞成 ${t.approve.length}/${total} 过半` };
  // 规则三：全部投完仍无结论 = 未形成多数（不是通过，也不是驳回）。
  if (t.cast.length === total) return { ...t, result: 'no_consensus', closed: true, reason: '全部投完：既非全员一致驳回，也未过半赞成' };
  return { ...t, result: 'pending', closed: false, reason: `已投 ${t.cast.length}/${total}` };
}

function voteMarkdown(vote, evaluation) {
  const p = votePaths(vote.project);
  const nameOf = (r) => ROLE_NAMES[r] || r;
  const rows = evaluation.eligible.map((r) => {
    const v = vote.votes && vote.votes[r];
    return `| ${nameOf(r)} | ${v ? v.vote : '（未投）'} | ${v && v.comment ? v.comment.replace(/\|/g, '\\|') : ''} | ${v ? v.at : ''} |`;
  });
  return [
    `# ${vote.id} · ${vote.subject}`,
    '',
    '> 程序生成；同名 JSON 是真相，本文件只做人读镜像。中文记录；投票只对本次投票编号负责。',
    '',
    `- 项目：${vote.project}（团队模式 ${vote.teamMode || 'full'}）`,
    `- 发起人：${nameOf(vote.createdBy)} ｜ 发起时间：${vote.createdAt}`,
    ...(vote.createdByCommand && vote.createdByCommand !== vote.createdBy
      ? [`- 命令执行者：${nameOf(vote.createdByCommand)}（发起归属按实际发起人记录）`]
      : []),
    `- 状态：${vote.status} ｜ 结论：${vote.result}（${vote.resultReason || evaluation.reason}）`,
    `- 参与人：除 PM 外全体角色（${evaluation.eligible.map(nameOf).join('、')}）；PM 不投票`,
    ...(vote.kind ? [`- 类型：${vote.kind}`] : []),
    ...(vote.requirementId ? [`- 关联需求：${vote.requirementId}`] : []),
    ...(vote.proposalId ? [`- 关联提案：${vote.proposalId}（proposalHash ${shortHash(vote.proposalHash, 16)}）`] : []),
    `- 规则：${vote.rule || VOTE_RULE_TEXT}`,
    '',
    '## 票数',
    '',
    '| 角色 | 票 | 意见 | 时间 |',
    '|---|---|---|---|',
    ...rows,
    '',
    `赞成 ${evaluation.approve.length} ｜ 驳回 ${evaluation.reject.length} ｜ 弃权 ${evaluation.abstain.length} ｜ 未投 ${evaluation.pending.length}`,
    '',
    ...(vote.closedAt ? [`关闭时间：${vote.closedAt}`, ''] : []),
  ].join('\n');
}

function saveVote(projectName, vote) {
  const p = votePaths(projectName);
  ensureDir(p.dir);
  const evaluation = evaluateVote(vote);
  vote.status = evaluation.closed ? 'closed' : 'open';
  vote.result = evaluation.result;
  vote.resultReason = evaluation.reason;
  vote.closedAt = evaluation.closed ? (vote.closedAt || nowIso()) : null;
  vote.updatedAt = nowIso();
  writeJson(p.file(vote.id), vote);
  writeText(p.md(vote.id), voteMarkdown(vote, evaluation));
  return { vote, evaluation };
}

function voteStatusText(vote, evaluation) {
  const nameOf = (r) => ROLE_NAMES[r] || r;
  const lines = [`投票 ${vote.id} · ${vote.subject}`];
  lines.push(`状态: ${vote.status} ｜ 结论: ${evaluation.result}（${evaluation.reason}）`);
  lines.push(`参与人（除 PM 外）: ${evaluation.eligible.map(nameOf).join('、') || '（无）'}`);
  lines.push(`赞成 ${evaluation.approve.length} ｜ 驳回 ${evaluation.reject.length} ｜ 弃权 ${evaluation.abstain.length} ｜ 未投 ${evaluation.pending.length}`);
  if (evaluation.pending.length) lines.push(`未投: ${evaluation.pending.map(nameOf).join('、')}`);
  for (const r of evaluation.eligible) {
    const v = vote.votes && vote.votes[r];
    lines.push(`  - ${nameOf(r)}: ${v ? v.vote : '未投'}${v && v.comment ? ' — ' + truncate(v.comment, 80) : ''}`);
  }
  return lines.join('\n');
}

export function cmdVote(args) {
  const sub = args._[1] || 'status';
  if (sub === 'start') {
    const b = bootFor(args, 'vote start');
    // PM 组织投票；需求分析师可以以实际分析师身份发起（V 文件 createdBy 记真实角色）。
    // 其他角色仍不能发起；PM 依旧不投票。
    if (!['pm', 'analyst'].includes(b.role)) {
      fail('ROLE_NOT_ALLOWED', '只有 PM 或需求分析师能发起投票（PM 不投票，只组织与记录）', {
        role: b.role, allowed: ['pm', 'analyst'],
      });
    }
    const subject = String(args.subject || '').trim();
    if (!subject) fail('BAD_ARGS', '需要 --subject 投票事项');
    const project = loadProject(b.project);
    const team = loadTeam();
    const teamMode = projectTeamMode(project);
    const voters = votersForMode(teamMode).filter((r) => {
      const m = getMember(team, r);
      return Boolean(m && m.status === 'active');
    });
    if (!voters.length) {
      fail('NO_VOTERS', `当前项目模式 ${teamMode} 没有可投票的活跃角色（除 PM 外）；先 roster add`, {
        teamMode, roles: rolesForMode(teamMode),
      });
    }
    const kind = String(args.kind || 'other').trim().toLowerCase();
    if (!['requirement', 'change', 'other'].includes(kind)) fail('BAD_KIND', '--kind 只能是 requirement / change / other', { kind });
    let requirementId = '';
    if (args.requirement) {
      const task = loadTask(b.project, String(args.requirement));
      if (task.type !== 'requirement') fail('NOT_REQUIREMENT', `${task.id} 不是需求（type=${task.type}）`, { id: task.id, type: task.type });
      requirementId = task.id;
    }
    let proposal = null;
    if (args.proposal) {
      proposal = loadProposal(b.project, String(args.proposal));
      const actual = computeProposalHash(proposal);
      if (actual !== proposal.proposalHash) fail('PROPOSAL_TAMPERED', '提案哈希不符', { expected: proposal.proposalHash, actual });
    }
    const ts = nowIso();
    const id = newVoteId(b.project);
    const vote = {
      id,
      project: b.project,
      teamMode,
      subject: truncate(subject, 200),
      kind,
      requirementId,
      proposalId: proposal ? proposal.id : '',
      proposalHash: proposal ? proposal.proposalHash : '',
      createdBy: b.role,
      createdByRole: b.role,
      // 与工作台壳层同名字段：发起归属以 createdBy 为准，执行者另存 createdByCommand。
      initiator: b.role,
      sessionId: b.sessionId,
      createdAt: ts,
      updatedAt: ts,
      status: 'open',
      eligible: voters,
      votes: {},
      result: 'pending',
      resultReason: '尚未投票',
      rule: VOTE_RULE_TEXT,
      note: truncate(String(args.note || ''), 300),
    };
    const saved = saveVote(b.project, vote);
    appendEvent({
      role: b.role, sessionId: b.sessionId, action: 'vote_start', project: b.project, target: id,
      note: `${truncate(subject, 100)} by=${b.role} eligible=${voters.join(',')}`,
      data: { voteId: id, subject: vote.subject, kind, requirementId, proposalId: vote.proposalId, eligible: voters, teamMode, createdBy: b.role },
    });
    for (const r of voters) {
      notify({
        from: b.role, to: r, subject: `投票 ${id}`,
        body: `发起人：${ROLE_NAMES[b.role] || b.role}\n${vote.subject}\n请投票：vote cast --boot <T> --id ${id} --vote approve|reject [--comment "..."]\n规则：${VOTE_RULE_TEXT}`,
        project: b.project, task: requirementId, ackRequired: false, type: 'vote', sessionId: b.sessionId,
      });
    }
    out(args, `投票已发起：${id} · ${vote.subject}\n发起人：${ROLE_NAMES[b.role] || b.role}\n参与人（除 PM 外）：${voters.map((r) => ROLE_NAMES[r] || r).join('、')}\n文件：${votePaths(b.project).file(id)}`, {
      ok: true, vote: saved.vote, evaluation: saved.evaluation, teamMode, file: votePaths(b.project).file(id),
    });
    return;
  }
  if (sub === 'cast') {
    const b = bootFor(args, 'vote cast');
    if (!args.id) fail('BAD_ID', '需要 --id V-...');
    const vote = loadVote(b.project, String(args.id));
    if (vote.status === 'closed') fail('VOTE_CLOSED', `投票已关闭：${vote.id}（${vote.result}）`, { voteId: vote.id, result: vote.result });
    if (!Array.isArray(vote.eligible) || !vote.eligible.includes(b.role)) {
      fail('NOT_ELIGIBLE', `${b.role} 不在本次投票参与人里（${(vote.eligible || []).join(', ')}）；PM 不投票`, {
        role: b.role, eligible: vote.eligible || [],
      });
    }
    const choice = String(args.vote || args.choice || '').trim().toLowerCase();
    if (!['approve', 'reject', 'abstain'].includes(choice)) fail('BAD_VOTE', '--vote 必须是 approve / reject / abstain');
    const comment = truncate(String(args.comment || args.comments || ''), 300);
    const prev = vote.votes && vote.votes[b.role];
    vote.votes = vote.votes && typeof vote.votes === 'object' ? vote.votes : {};
    vote.votes[b.role] = {
      vote: choice,
      comment,
      at: nowIso(),
      sessionId: b.sessionId,
      revision: prev ? Number(prev.revision || 1) + 1 : 1,
    };
    const saved = saveVote(b.project, vote);
    appendEvent({
      role: b.role, sessionId: b.sessionId, action: 'vote_cast', project: b.project, target: vote.id,
      note: `${choice} ${truncate(comment, 100)}`,
      data: { voteId: vote.id, choice, result: saved.vote.result, resultReason: saved.vote.resultReason },
    });
    // 需求被投票一致驳回时，同时把 rejected 写进需求任务与 工作流.json，
    // 这样 req iterate / req terminate 和工作台都能看到同一条驳回结论。
    let requirementSync = null;
    if (saved.vote.result === 'rejected' && vote.kind === 'requirement' && vote.requirementId) {
      try {
        const reqTask = loadTask(b.project, vote.requirementId);
        if (reqTask.type === 'requirement') {
          stampRejected(reqTask, { source: `vote:${vote.id}`, role: 'vote', at: saved.vote.closedAt || nowIso() });
          reqTask._by = b.role;
          reqTask._action = 'vote_rejected';
          reqTask._note = `投票 ${vote.id} 除 PM 外全员一致驳回`;
          saveTask(b.project, reqTask);
          const wf = reqTask.workflow;
          const sync = syncWorkflowRow(b.project, reqTask, 'rejected', {
            rejectedAt: wf.rejectedAt,
            rejectedBy: wf.rejectedBy,
            rejectionSource: wf.rejectionSource,
          }, {
            create: true,
            action: 'vote_rejected',
            by: b.role,
            note: String(saved.vote.resultReason || ''),
            phase: 'requirement_review',
          });
          requirementSync = { requirementId: reqTask.id, workflowFile: sync.file };
          appendEvent({
            role: b.role, sessionId: b.sessionId, action: 'vote_reject_requirement', project: b.project,
            target: reqTask.id, note: `投票 ${vote.id} 驳回需求`, data: { voteId: vote.id, requirementId: reqTask.id, workflowFile: sync.file },
          });
        }
      } catch (e) {
        requirementSync = {
          requirementId: vote.requirementId,
          ok: false,
          code: e.code || 'REQUIREMENT_SYNC_FAILED',
          message: e.message,
        };
      }
    }
    // 只把进度同步给 PM（不打扰其他投票人），PM 再用 vote status 看全貌。
    try {
      notify({
        from: b.role, to: 'pm', subject: `投票进度 ${vote.id}`,
        body: `${vote.subject}\n${b.role} 投了 ${choice}${comment ? '：' + comment : ''}\n当前 ${saved.vote.result}（${saved.vote.resultReason}）`,
        project: b.project, task: vote.requirementId || '', ackRequired: false, type: 'vote', sessionId: b.sessionId,
      });
    } catch { /* 进度消息失败不影响投票记录 */ }
    out(args, `已投票：${vote.id} / ${b.role} → ${choice}；当前 ${saved.vote.result}（${saved.vote.resultReason}）`, {
      ok: true, vote: saved.vote, evaluation: saved.evaluation, file: votePaths(b.project).file(vote.id),
      ...(requirementSync ? { requirementSync } : {}),
    });
    return;
  }
  if (sub === 'status') {
    // 只读：壳层可以在没有令牌的情况下查询投票结果。
    const team = loadTeam();
    const projectName = String(args.project || team.activeProject || '').trim();
    if (!projectName) fail('NO_PROJECT', '没有当前项目；先 project add / project use');
    const project = loadProject(projectName);
    const teamMode = projectTeamMode(project);
    if (args.id) {
      const vote = loadVote(projectName, String(args.id));
      const evaluation = evaluateVote(vote);
      out(args, voteStatusText(vote, evaluation), {
        ok: true, vote, evaluation, project: projectName, teamMode, file: votePaths(projectName).file(vote.id),
      });
      return;
    }
    const p = votePaths(projectName);
    let names = [];
    try { names = fs.readdirSync(p.dir); } catch { names = []; }
    let votes = names
      .filter((n) => /^V-.*\.json$/i.test(n))
      .map((n) => readJson(path.join(p.dir, n), null))
      .filter(Boolean);
    if (args.open) votes = votes.filter((v) => v.status !== 'closed');
    votes.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const rows = votes.map((v) => {
      const e = evaluateVote(v);
      return {
        id: v.id, subject: v.subject, status: v.status, result: e.result,
        cast: `${e.cast.length}/${e.eligible.length}`, created: v.createdAt,
      };
    });
    out(args, `投票（${projectName}，${votes.length} 条；模式 ${teamMode}）\n` + table(rows, [
      { key: 'id', label: '投票' }, { key: 'status', label: '状态' }, { key: 'result', label: '结论' }, { key: 'cast', label: '已投' }, { key: 'subject', label: '事项' }, { key: 'created', label: '发起' },
    ]), { ok: true, votes, project: projectName, teamMode });
    return;
  }
  fail('BAD_SUBCOMMAND', `未知 vote 子命令：${sub}（支持 start / cast / status）`);
}

// ========== 团队扩编 ==========

export function cmdRoster(args) {
  const sub = args._[1] || 'list';
  const team = loadTeam();
  const teamMode = activeProjectMode(team);
  const allowedRoles = rolesForMode(teamMode);
  if (sub === 'list') {
    const rows = team.members.map((m) => ({
      role: m.role, name: m.name, status: m.status,
      mode: allowedRoles.includes(m.role) ? '✓' : '—',
      session: m.sessionId || '',
    }));
    out(args, `团队（项目模式 ${teamMode}：${allowedRoles.map((r) => ROLE_NAMES[r] || r).join('、')}；— = 不在当前模式）\n` + table(rows, [
      { key: 'role', label: '角色' }, { key: 'name', label: '名称' }, { key: 'status', label: '状态' }, { key: 'mode', label: '本模式' }, { key: 'session', label: '会话' },
    ]), { ok: true, members: team.members, phase: team.phase, teamMode, roles: allowedRoles });
    return;
  }
  const b = tokenOf(args);
  if (b.role !== 'pm') fail('NOT_PM', '只有 PM 能扩编');
  if (sub === 'add') {
    // 以“令牌所在项目”的模式为准：PM 可以在不切 activeProject 的情况下给别的项目扩编。
    let addMode = teamMode;
    try { addMode = projectTeamMode(loadProject(b.project)); } catch { /* 用当前项目模式兜底 */ }
    const addRoles = rolesForMode(addMode);
    if (team.phase === PHASE_PILOT && !args.force) {
      const pc = pilotCheckData(team);
      if (!pc.pass) fail('PILOT_NOT_PASSED', 'pilot 门槛未过，先跑通回执/签字/陈旧拒绝/锁争用；或 --force 并写理由', { checks: pc.checks });
    }
    const role = String(args.role || '');
    if (!ROLES.includes(role)) fail('BAD_ROLE', `角色必须是 ${ROLES.join('/')}`);
    // 动态角色集：当前项目是 fast 就只允许四角色；要加产品/程序员B 先切 full。
    if (!roleInMode(role, addMode)) {
      fail('ROLE_NOT_IN_MODE', `项目当前是 ${addMode} 模式（${addRoles.map((r) => ROLE_NAMES[r] || r).join('、')}），不能加 ${ROLE_NAMES[role] || role}；先把项目切到 full：project ensure --name "${b.project}" --team-mode full`, {
        role, teamMode: addMode, roles: addRoles,
      });
    }
    if (getMember(team, role)) fail('ROLE_EXISTS', `角色已存在：${role}`);
    const m = { role, name: args.name || ROLE_NAMES[role] || role, status: 'active', joinedAt: nowIso(), sessionId: args.session || '' };
    mutateTeam((t) => { t.members.push(m); return t; });
    const card = path.join(PATHS.roles, `${role}.md`);
    if (!exists(card)) writeText(card, `# ${m.name}\n\n- 职责：${args.duty || '（待补）'}\n- 每次先 boot。\n`);
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'roster_add', project: b.project, target: role, note: `${m.name} ${args.reason || ''}`, data: { member: m, teamMode: addMode } });
    notify({ from: b.role, to: role, subject: '团队欢迎 / 必读', body: `你是 ${m.name}（团队模式 ${addMode}）。先读 团队宪法、项目铁律、角色卡、项目索引，然后 boot。没有令牌不执行。`, project: b.project, ackRequired: true, type: 'welcome', sessionId: b.sessionId });
    out(args, `已加入 ${m.name}（${role}，项目模式 ${addMode}）。提醒：先读四样，再 boot。`, { ok: true, member: m, teamMode: addMode });
    return;
  }
  if (sub === 'phase') {
    if (!args.set) fail('BAD_ARGS', '需要 --set pilot|team');
    if (!['pilot', 'team'].includes(String(args.set))) fail('BAD_PHASE', '阶段只能是 pilot / team');
    if (args.set === 'team') {
      const pc = pilotCheckData(team);
      if (!pc.pass) fail('PILOT_NOT_PASSED', 'pilot 门槛未过，不能转 team', { checks: pc.checks });
    }
    mutateTeam((t) => { t.phase = String(args.set); return t; });
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'phase', project: b.project, target: String(args.set), note: args.reason || '' });
    out(args, `阶段已切到 ${args.set}`, { ok: true, phase: args.set });
    return;
  }
  fail('BAD_SUBCOMMAND', `未知 roster 子命令：${sub}`);
}

export function cmdPilot(args) {
  const team = loadTeam();
  const pc = pilotCheckData(team);
  const lines = ['# 试点门槛检查', ''];
  for (const c of pc.checks) lines.push(`- ${c.ok ? '✅' : '❌'} ${c.label}：${c.detail}`);
  lines.push('');
  lines.push(pc.pass ? '结论：**PASS**，可以按扩编清单加人。' : '结论：**FAIL**，先补齐上面项。');
  lines.push('');
  lines.push('扩编顺序建议：1) 产品设计师（接优先级/验收）→ 2) 需求分析师 → 3) 架构师。每次只加 1 人，加完重跑一次 1 写 1 审。');
  out(args, lines.join('\n'), { ok: true, ...pc });
}

// ========== doctor ==========

export function cmdDoctor(args) {
  const issues = [];
  const team = loadTeam();
  if (!exists(PATHS.team)) issues.push('团队配置缺失');
  for (const role of activeRoles(team)) {
    if (!exists(path.join(PATHS.roles, `${role}.md`))) issues.push(`角色卡缺失：${role}`);
  }
  for (const f of [PATHS.team, PATHS.events, PATHS.receipts]) {
    if (exists(f)) {
      try { readJson(f); } catch { /* events jsonl not json */ }
    }
  }
  const chain = verifyEventChain();
  if (!chain.ok) issues.push(`事件链问题 ${chain.problems.length}`);
  const locks = listLocks().filter((l) => l.stale);
  if (locks.length) issues.push(`过期锁 ${locks.length}`);
  const pc = pilotCheckData(team);
  // 可选插件：error 计入 issues；off 只提示（缺插件不阻断核心，AC21.2/21.3）。
  let pluginCheck = null;
  try {
    pluginCheck = detectOptionalPlugins();
    for (const row of pluginCheck.plugins) {
      if (row.status === 'error') issues.push(`可选插件 ${row.id} 状态 error：${row.hint}`);
    }
  } catch (error) {
    pluginCheck = { ok: false, why: String((error && error.message) || error), plugins: [], sources: {}, marks: 'memory:off · vision:off · search:off' };
  }
  const pluginText = pluginCheck.plugins && pluginCheck.plugins.length
    ? pluginStatusLines(pluginCheck).join('\n')
    : `## 可选插件（非核心 · 缺了不阻断）\n- 探测失败：${String(pluginCheck.why || '').slice(0, 200)}（按 off 处理，不冒充 on）\n- 降级标记：memory:off · vision:off · search:off`;
  // AC21.6：白名单外 0 命中才算通过；与 path-audit 命令同一规则。
  let pathAudit = null;
  try {
    // 默认以工作台根为根（ops.mjs 在 团队/工具/lib → 上三级），不依赖调用者 cwd。
    const workbenchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    pathAudit = auditHardcodedPaths({ root: String(args.root || workbenchRoot) });
    if (!pathAudit.ok) issues.push(`路径白名单外命中 ${pathAudit.outside.length} 处`);
  } catch (error) {
    pathAudit = { ok: false, total: 0, files: 0, whitelisted: 0, outside: [], whitelistSize: 0, why: String((error && error.message) || error) };
    issues.push('路径白名单审计失败：' + String(pathAudit.why).slice(0, 120));
  }
  const pathText = pathAuditLines(pathAudit).join('\n');
  out(args, `doctor：${issues.length ? '❌' : '✅'}\n${issues.join('\n')}\n阶段 ${team.phase} ｜ 成员 ${activeRoles(team).join(', ')}\n试点 ${pc.pass ? 'PASS' : 'FAIL'}\n${pluginText}\n${pathText}`, { ok: issues.length === 0, issues, team, pilot: pc, plugins: pluginCheck, pathAudit });
}


// ─────────────────────────────────────────────────────────────────────────────
// R-51de（一）：经验教训登记册 读记录 + 换人门禁
// 依据 需求/R-20261115-170902-51de-经验教训看板.md F-4/F-5/AC4 + 增补卷-51de-1
// 门禁只比「该角色最近一条阅读记录的 fileSha」与当前文件 sha256；Owner 通道豁免；命中零副作用。
// ─────────────────────────────────────────────────────────────────────────────
function ownerGateBoot(args, projectName) {
  // cmdOwner 的 Owner 通道不强制 boot 令牌；这里给出最小上下文供门禁使用：
  //  · 有 boot 令牌（PM 代管/CLI）→ 用真实角色
  //  · 无令牌（Owner UI/终端）→ role=owner，配合 isOwnerChannel 豁免
  const role = String((args && args.role) || '').trim() || 'owner';
  let sessionId = '';
  try { const b = requireBoot(args); sessionId = b.sessionId || ''; } catch { sessionId = ''; }
  return { project: projectName, role, sessionId };
}

export function lessonGateFor(b, extra = {}) {
  // B-20261116-2150：role==='owner' 也要豁免——ownerGateBoot 在「无 boot 令牌（Owner UI/终端）」
  // 时把 role 兜底成 'owner'，而界面的验收路径并不一定带 --channel ui，
  // 于是门禁拿 role='owner' 去查阅读记录（永不存在）→ 误报 LESSONS_UNREAD 挡住 Owner 验收。
  // 豁免口径与 isOwnerChannel 一致：Owner 通道本就不查该门禁。
  if (lessons.isOwnerChannel(extra) || String((b && b.role) || '').trim().toLowerCase() === 'owner') {
    return { ok: true, exempt: true, reason: 'OWNER_CHANNEL' };
  }
  let projectPath = '';
  try { projectPath = loadProject(b.project).path; } catch { projectPath = ''; }
  if (!projectPath) return { ok: true, exempt: true, reason: 'NO_PROJECT_PATH' };
  return lessons.runLessonGate(b.role, projectPath, { teamRoot: PATHS.teamRoot });
}

export function failLessonGate(gate) {
  if (!gate || gate.ok) return;
  fail(gate.code, gate.message, {
    staleSha12: gate.staleSha12 || '',
    currentSha12: gate.currentSha12 || '',
    parseWarn: gate.parseWarn || undefined,
  });
}

export function cmdLessons(args) {
  const b = bootFor(args, 'lessons');
  const sub = String((args._ && args._[1]) || 'status').toLowerCase();
  const project = loadProject(b.project);
  const projectPath = project.path;
  if (sub === 'read') {
    const parsed = lessons.loadLessons(projectPath);
    if (parsed.missing) fail('LESSONS_FILE_MISSING', `经验教训登记册缺失：${path.join(projectPath, lessons.LESSONS_FILE)}`);
    if (parsed.broken) fail('LESSONS_PARSE_BROKEN', '经验教训登记册无法解析（缺 `## <角色名>` 段）', { parseWarn: parsed.parseWarn.slice(0, 5) });
    const rec = lessons.recordLessonRead(PATHS.teamRoot, {
      role: b.role, sessionId: b.sessionId || '', fileSha: parsed.fileSha, entries: parsed.totals, source: 'cli',
    });
    out(args, rec.alreadyRead
      ? `已读过（同一版本 ${parsed.fileSha.slice(0, 12)}，${parsed.totals} 条）：只更新阅读时间，未追加行`
      : `已记录阅读：${b.role} @ ${parsed.fileSha.slice(0, 12)}，${parsed.totals} 条`, {
      ok: true, action: rec.action, role: b.role, fileSha: parsed.fileSha, entries: parsed.totals, at: rec.at,
    });
    return;
  }
  if (sub === 'status' && args.deleted) {
    // F10 / 卷 §七：已删除条目恰好 5 键（与界面同一实现）
    const rows = lessons.readDeletedEntries(projectPath, PATHS.teamRoot);
    const lines = rows.length
      ? rows.map((r) => `${r.id || '（无 id）'}｜${r.date}｜删除于 ${String(r.deletedAt).slice(0, 19).replace('T', ' ') || '—'}｜${r.by || '—'}｜${r.text}`)
      : ['没有已删除条目'];
    out(args, lines.join('\n'), { ok: true, total: rows.length, deleted: rows });
    return;
  }
  if (sub === 'status') {
    const parsed = lessons.loadLessons(projectPath);
    const rec = lessons.latestReadRecord(PATHS.teamRoot, b.role);
    const gate = lessons.runLessonGate(b.role, projectPath, { teamRoot: PATHS.teamRoot });
    out(args, [
      `经验教训登记册：${parsed.missing ? '缺失' : parsed.broken ? '解析失败' : `${parsed.totals} 条`}`,
      `当前版本 sha12：${parsed.fileSha ? parsed.fileSha.slice(0, 12) : '—'}`,
      `我的最近阅读：${rec ? `${String(rec.at).slice(0, 19)} @ ${String(rec.fileSha).slice(0, 12)}` : '无记录'}`,
      `门禁：${gate.ok ? 'PASS' : gate.code}`,
      statusTurnsLine(b.project, b.role),
    ].join('\n'), { ok: true, parsed: { totals: parsed.totals, fileSha: parsed.fileSha, broken: parsed.broken, missing: parsed.missing }, latest: rec, gate });
    return;
  }
  if (sub === 'turns') {
    // a28a F9：轮次可视（只读；sessionId 不符名册时按 F5 清 0 并写审计 reset）
    const st = projectStatePaths(b.project);
    const roleIds = projectRoleIds(project);
    const team = loadTeam();
    const me = getMember(team, b.role);
    const mine = lessons.readRoleTurns({
      stateDir: st.dir, teamRoot: PATHS.teamRoot, role: b.role,
      sessionId: (me && me.sessionId) || b.sessionId || '',
      configPath: st.config, applyReset: true,
    });
    const all = lessons.readAllTurns({ stateDir: st.dir, configPath: st.config, roleIds });
    const lines = [];
    for (const role of roleIds) {
      const row = all.roles[role];
      const turns = row && row.turns != null ? `${row.turns}/${all.threshold}` : '—';
      const last = row && row.lastNotifiedAt ? String(row.lastNotifiedAt).slice(0, 19).replace('T', ' ') : '—';
      const next = row && row.nextInTurns != null ? `${row.nextInTurns} 轮` : '—';
      lines.push(`${role}: ${turns}｜上次提醒 ${last}｜距下次 ${next}`);
    }
    lines.push(`阈值：${all.threshold}（来源 ${all.source}）｜tick ${all.tickMs}ms｜计数文件${all.missing ? '缺失（按 0 起始）' : '就绪'}`);
    out(args, lines.join('\n'), {
      ok: true, role: b.role, threshold: all.threshold, source: all.source, tickMs: all.tickMs,
      missing: all.missing, roles: all.roles,
      mine: {
        role: b.role,
        turns: mine.ok && mine.entry ? mine.entry.turns : null,
        lastAt: mine.ok && mine.entry ? mine.entry.lastAt : null,
        lastNotifiedAt: mine.ok && mine.entry ? mine.entry.lastNotifiedAt : null,
        lastNoticeSha: mine.ok && mine.entry ? mine.entry.lastNoticeSha : null,
        lastSeenAuditSeq: mine.ok && mine.entry ? mine.entry.lastSeenAuditSeq : null,
        lastSelfWriteAt: mine.ok && mine.entry ? mine.entry.lastSelfWriteAt : null,
        sessionReset: !!(mine.ok && mine.reset),
      },
    });
    return;
  }
  if (sub === 'append') {
    // F6：只写自己段；三字段必填；编号 L-YYYYMMDD-<seq>
    const st = projectStatePaths(b.project);
    const team = loadTeam();
    const me = getMember(team, b.role);
    const r = lessons.appendLesson({
      projectDir: projectPath, teamRoot: PATHS.teamRoot, role: b.role,
      scene: args.scene, lesson: args.lesson, next: args.next,
    });
    if (!r.ok) fail(r.code, lessonsFailText(r.code), { wrote: false, code: r.code });
    // 卷 §二.5：自写后刷新基线（lastNoticeSha / lastSelfWriteAt）
    lessons.markSelfWrite({
      stateDir: st.dir, projectDir: projectPath, role: b.role, fileSha: r.fileSha,
      sessionId: (me && me.sessionId) || b.sessionId || '',
    });
    out(args, `已追加经验教训 ${r.id}（${b.role}）`, { ok: true, id: r.id, before: r.before, after: r.after, fileSha: r.fileSha, wrote: true });
    return;
  }
  if (sub === 'fix') {
    // F7：更正 / 软删（只能动自己段）
    const st = projectStatePaths(b.project);
    const team = loadTeam();
    const me = getMember(team, b.role);
    const r = lessons.fixLesson({
      projectDir: projectPath, teamRoot: PATHS.teamRoot, role: b.role,
      id: args.id, text: args.text, scene: args.scene, next: args.next,
      delete: Boolean(args.delete), reason: args.reason,
    });
    if (!r.ok) fail(r.code, lessonsFailText(r.code), { wrote: false, code: r.code });
    lessons.markSelfWrite({
      stateDir: st.dir, projectDir: projectPath, role: b.role, fileSha: r.fileSha,
      sessionId: (me && me.sessionId) || b.sessionId || '',
    });
    out(args, `${args.delete ? '已软删' : '已更正'} ${r.id}`, { ok: true, id: r.id, before: r.before, after: r.after, fileSha: r.fileSha, wrote: true });
    return;
  }
  if (sub === 'audit') {
    const stats = lessons.auditStats(PATHS.teamRoot);
    out(args, `已更正 ${stats.fixed} 条 / 已删除 ${stats.deleted} 条（审计 ${stats.rows} 行）`, { ok: true, ...stats });
    return;
  }
  fail('BAD_SUB', 'lessons 支持 read / status [--deleted] / turns / append / fix / audit');
}

/** a28a F9：`lessons status` 末行轮次（只读，取自 轮次计数.json 与阈值来源） */
function statusTurnsLine(projectName, role) {
  try {
    const st = projectStatePaths(projectName);
    const project = loadProject(projectName);
    const all = lessons.readAllTurns({ stateDir: st.dir, configPath: st.config, roleIds: projectRoleIds(project) });
    const mine = all.roles[role];
    const mineText = mine && mine.turns != null ? `${mine.turns}/${all.threshold}（距下次 ${mine.nextInTurns} 轮）` : '—';
    const last = mine && mine.lastNotifiedAt ? String(mine.lastNotifiedAt).slice(0, 19).replace('T', ' ') : '—';
    return `轮次：我 ${mineText}｜上次提醒 ${last}｜阈值 ${all.threshold}（${all.source}）`;
  } catch {
    return '轮次：—';
  }
}

/** a28a 错误码 → 人话（零写入原因） */
function lessonsFailText(code) {
  const map = {
    LESSONS_FIELD_REQUIRED: '场景/教训/下次怎么做 三字段必填',
    LESSONS_ID_REQUIRED: '需要 --id L-YYYYMMDD-<seq>',
    LESSONS_ID_INVALID: '--id 格式非法（应形如 L-20261116-1）',
    LESSONS_ID_NOT_FOUND: '该 id 不存在（只认带行内 id 注释的条目，历史无 id 行不认）',
    LESSONS_ID_DUPLICATE: '该 id 重复',
    LESSONS_ROLE_FORBIDDEN: '只能改自己段的条目（Owner 也不得跨角色改）',
    LESSONS_SECTION_MISSING: '登记册缺该角色段',
    LESSONS_FILE_MISSING: '经验教训登记册缺失',
    LESSONS_PARSE_BROKEN: '经验教训登记册无法解析',
    LESSONS_WRITE_FAILED: '写盘失败（不落半条）',
    LESSONS_AUDIT_FAILED: '审计写失败，已回滚本次改动',
    LESSONS_CONFLICT: '并发冲突（另一角色正在写），请稍后重试',
    LESSONS_REASON_REQUIRED: '软删必须给 --reason',
    LESSONS_ALREADY_DELETED: '该条目已软删',
  };
  return map[code] || code;
}

/* ==========================================================================
 * a28a：程序提示（**from=system** / senderKind=program / type=notice / ackRequired=false）
 * 先落箱（sendMessage），再试唤醒；失败只记 wakeError，不重复发。
 * BUG-FIX 2026-11-17（PM 实测）：原写 from='pm'，而消息实际投给**当事人**（to=role）。
 *   当事人 ack 时，ack 唤醒会把「原消息正文」发给 from（本文件 ackWakeTarget = r.msg.from），
 *   于是提醒正文被投进 **PM 会话**却无 PM 邮箱记录（PM 去 ack 会撞 MESSAGE_NOT_FOUND）。
 *   改 from='system'：ack 唤醒的既有守卫 `ackWakeTarget !== 'system'` 直接跳过，源头止血；
 *   语义也更准（程序提醒不是 PM 发的）。to 仍是当事人，唤醒当事人不受影响。
 * ========================================================================== */
const LESSONS_WAKE_QUEUE = [];

/** promptIfDue 的 sendNotice 回调（同步落箱 + 入队唤醒） */
export function sendLessonsProgramNotice({ project, to, subject, body, wake, senderKind, type, ackRequired }) {
  try {
    const msg = sendMessage({
      from: 'system', to, subject, body, project,
      type: type || 'notice',
      ackRequired: Boolean(ackRequired),
      noEcho: true,
    });
    if (wake) LESSONS_WAKE_QUEUE.push({ project, to, msg });
    return { ok: true, messageId: msg.id, delivered: true, senderKind: senderKind || 'program' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 执行排队的唤醒（team.mjs 在 bump 之后 await；失败不抛） */
export async function flushLessonsProgramWakes() {
  const pending = LESSONS_WAKE_QUEUE.splice(0, LESSONS_WAKE_QUEUE.length);
  const results = [];
  for (const item of pending) {
    try {
      const r = await wakeSessionForMessage({ project: item.project, to: item.to, msg: item.msg, isDispatch: false });
      results.push({ to: item.to, messageId: item.msg.id, ok: !!(r && r.ok !== false), wakeError: r && r.error ? String(r.error) : '' });
    } catch (e) {
      results.push({ to: item.to, messageId: item.msg.id, ok: false, wakeError: String((e && e.message) || e) });
    }
  }
  return { ok: true, results };
}

/**
 * a28a：`team.mjs project config --lessons-turns N`
 * 阈值唯一写入口（PM/Owner）；tmp+rename + `.project-config.lock`（O_EXCL，stale 30s）；
 * 写入必须 merge 保留未知键（gates / dshWorkspaceId / roleIds 逐字不变）。
 */
export function cmdProjectConfig(args) {
  const b = bootFor(args, 'project');
  if (!['pm', 'owner'].includes(b.role)) {
    fail('PERMISSION_DENIED', '改阈值只允许 PM/Owner；角色令牌不足', { wrote: false });
  }
  const rawTurns = args['lessons-turns'];
  if (rawTurns == null || String(rawTurns).trim() === '') {
    fail('BAD_ARGS', '需要 --lessons-turns <正整数>', { wrote: false });
  }
  const n = Math.floor(Number(rawTurns));
  if (!Number.isFinite(n) || n < 1) fail('BAD_ARGS', `--lessons-turns 必须是 ≥1 的整数（收到 ${rawTurns}）`, { wrote: false });

  const st = projectStatePaths(b.project);
  const abs = st.config;
  const beforeCfg = readJson(abs, {}) || {};
  const lockRes = lessons.withFileLock(abs, () => {
    // 锁内重读，merge 保留未知键
    const cur = readJson(abs, {}) || {};
    const next = { ...cur, config: { ...((cur && cur.config) || {}), lessonsTurns: n } };
    const tmp = abs + '.tmp-' + process.pid + '-' + Date.now();
    try {
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, abs);
      return { ok: true };
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      return { ok: false, code: 'LESSONS_WRITE_FAILED', error: String((e && e.message) || e) };
    }
  });
  if (!lockRes || !lockRes.ok) {
    const code = (lockRes && lockRes.code) || 'LESSONS_CONFLICT';
    fail(code, lessonsFailText(code), { wrote: false });
  }
  const afterCfg = readJson(abs, {}) || {};
  const resolved = lessons.resolveLessonsTurns(abs);
  out(args, `已设置 lessonsTurns=${n}（项目 ${b.project}）；生效阈值 ${resolved.value}（来源 ${resolved.source}）`, {
    ok: true, wrote: true, project: b.project, lessonsTurns: n,
    before: beforeCfg && beforeCfg.config ? beforeCfg.config.lessonsTurns : null,
    after: afterCfg && afterCfg.config ? afterCfg.config.lessonsTurns : null,
    threshold: resolved.value, source: resolved.source, configPath: abs,
  });
}
