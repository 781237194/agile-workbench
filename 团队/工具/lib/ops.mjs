// 团队工作台 v2 · 业务命令（boot / 消息 / 任务 / 提案 / 评审 / 签字 / 应用 / 索引 / 对账）
import fs from 'node:fs';
import path from 'node:path';
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
} from './store.mjs';
import { DshClient } from './dsh-session.mjs';
import { renderBoardHtml as renderBoardHtmlV2, renderBoardMd as renderBoardMdV2 } from './board.mjs';
import {
  ROLE_DIRS, roleDisplayName, OUTPUT_DOCS, OUTPUT_DISCIPLINE, TEAM_MODES, TEAM_MODE_LABELS,
  isTeamMode, normalizeTeamMode, rolesForMode, roleInMode, teamModeDescription,
  requirementReviewer, techReviewers, votersForMode, VOTE_RULE_TEXT,
} from './roles.mjs';
import { ensureProjectStructure, structureReport, readRequirementDocs } from './scaffold.mjs';
import {
  auditGate, detectPhaseEdit, gateDesign, gateIteration, gateOwnerDecision, gateRequirementFinal, gateRequirementDoc,
  gateRequirementReview, gateStageRole, gateTestReport, gateTestability, gateConfig, ownerDecisionsOf,
  stageOfRow, idMatches, gateRoleBusy, detectPhaseJump,
} from './gates.mjs';
import { buildDispatchPrompt, buildNoticePrompt, buildWakeHeader, buildWakeLine, isRegisteredKind } from './dispatch.mjs';
import { assertNoPendingSubagent, subagentAudit } from './subagent.mjs';
import {
  handoverForBoot, assertSessionMapConsistent, probeRoleSession, nudgeRoleBoot, consumeBootQueue,
} from './session.mjs';
import { validatePmAcceptEvidence, parseEvidenceArg } from './pm-accept-evidence.mjs';
import { detectOptionalPlugins, optionalPluginMarks, pluginStatusLines } from './plugins.mjs';
import { auditHardcodedPaths, pathAuditLines } from './path-audit.mjs';
import { memoryCheck } from './memory-check.mjs';
import { checkEvidenceGate } from './evidence.mjs';
import { bumpRound, archiveSession, confirmArchive, ROUNDS_MAX } from './session-archive.mjs';
import {
  transitionRequirement, syncWorkflowRow, stampRejected, workflowAction, readWorkflowState, writeWorkflowState,
} from './lifecycle.mjs';
import {
  issueOwnerConfirmation, consumeOwnerConfirmation, ownerConfirmHint,
} from './owner-confirm.mjs';
import { activeProxyFor } from './owner-proxy.mjs';

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
  const rowList = ownerDecisionsOf(row);
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
 * task done 后按「任务类型 + 阶段 + 测试结论」推进需求状态（B-b645）：
 * - 只有 type=task 的任务能推进；TR-Q/评审类任务（既不是开发也不是测试）不推进；
 * - 开发类：需求在 ready/dispatched/dev/dev_review（legacy approved 视同 ready），且该需求全部开发任务 done → dev_done；
 * - 测试类：需求在 dev_done/test、TR-Q 为 testable（无 TR-Q 记录按历史兼容放行）、
 *   任务证据没有 FAIL/不通过，且全部测试任务 done → test_done；
 * - 无 Owner decision 且需求还在 owner_review（approved 或更早）时不得越过该门；
 * - 不满足条件只记 requirement_advance_skipped 事件，不改任何状态。
 */
function advanceRequirementAfterTaskDone(projectName, task, role, opts = {}) {
  if (!task || task.type !== 'task') return null; // BUG/chore/需求任务不推进需求状态
  const requirementId = String(task.requirementId || '').trim();
  if (!requirementId) return null;
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
  if (current !== 'iteration' && statusRank(current) <= statusRank('approved') && !ownerDecisionsOf(row).length) {
    return skip('no_owner_decision');
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
    const allDevTasks = listTasks(projectName).filter((rowTask) => rowTask && rowTask.type === 'task'
      && String(rowTask.requirementId || '') === requirementId)
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
          return null; // 老任务没轮次标记：按 legacy 参与收口
        };
        const same = allDevTasks.filter((rowTask) => {
          const r = markedRound(rowTask);
          return r === null || r === devRound;
        });
        return same.length ? same : allDevTasks;
      })()
      : allDevTasks;
    if (devTasks.length && devTasks.every((rowTask) => String(rowTask.status || '') === 'done')) target = 'dev_done';
    // 还有开发任务没 done 时必须留痕，不能静默返回 null：否则现场看起来就是「task done 没推进需求」，
    // 排查只能靠翻文件（2026-11-14 ea86 就被一条遗留 open 旧单卡住，且当时没有任何事件）。
    else if (devTasks.length) {
      const openTasks = devTasks.filter((rowTask) => String(rowTask.status || '') !== 'done').map((rowTask) => `${rowTask.id}:${rowTask.status || 'unknown'}`);
      // 事件 note 直接写出「哪条任务在挡」（reason 里带清单），人看一眼就够，不用再点开 data。
      return skip(`dev_tasks_open(${openTasks.join(',')})`, { openTasks });
    }
  } else {
    // ① 测试类只在 testable 且测试通过时推进。
    if (!['dev_done', 'test'].includes(current)) return skip('stage_not_test');
    const trqVerdict = String((row.trq && row.trq.verdict) || '');
    if (trqVerdict && trqVerdict !== 'testable') return skip('trq_not_testable', { verdict: trqVerdict });
    if (/(?:FAIL|不通过|未通过)/i.test(String(task.evidence || ''))) return skip('test_not_passed');
    const tests = listTasks(projectName).filter((rowTask) => rowTask && rowTask.type === 'task'
      && String(rowTask.requirementId || '') === requirementId)
      .filter((rowTask) => String(rowTask.owner || '') === 'tester'
        || String((rowTask.workflow && rowTask.workflow.stage) || '') === 'test');
    if (tests.length && tests.every((rowTask) => String(rowTask.status || '') === 'done')) target = 'test_done';
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
  if (g2) gateFail(projectName, record, g2);
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
  const g3 = isTrqTask ? null : gateOwnerDecision(row);
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
async function wakeWithGuard({ project, to, msg, isDispatch = false, engineUrl = '', taskRow = null, reason = '', dedupeKey = '' }) {
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
  const inWindow = Number(t.windowStart) > 0 && nowMs - Number(t.windowStart) < WAKE_DEBOUNCE_MS;
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

/**
 * 队列续跑：角色完成后自动取该角色下一条排队派单（send --ack --queue 入队）。
 * 目标角色仍忙（G5）则保留队列并返回 blocked；working 幽灵满 30 分钟不占名额。
 */
export async function pumpDispatchQueue(project, { role = '' } = {}) {
  // B-384e：队列泵不受已过期派单锁影响——先释放过期锁再判角色忙闲。
  const expiredLock = releaseExpiredDispatchLock(project, { source: 'pump' });
  // B-405f ②：目标会话无活性的 pending 锁也在这里清（泵是定时入口，覆盖 PM 不操作的时间段）。
  await releaseInactiveDispatchLock(project, { source: 'pump' });
  const queue = readDispatchQueue(project);
  if (!queue.items.length) return { ok: true, pumped: false, reason: 'EMPTY', remaining: 0 };
  const roleKey = String(role || '');
  // 指定角色：只看它的第一项；role=''（兜底泵）：遍历队列，找第一个“角色已空闲”的项。
  const candidates = roleKey
    ? queue.items.filter((item) => String(item.to) === roleKey).slice(0, 1)
    : queue.items.slice();
  if (!candidates.length) return { ok: true, pumped: false, reason: 'NO_ITEM_FOR_ROLE', remaining: queue.items.length };
  let firstBlocked = null;
  let item = null;
  for (const candidate of candidates) {
    const busy = gateRoleBusy({
      role: String(candidate.to || ''),
      tasks: listTasks(project),
      locks: listLocks().filter((lock) => !lock.stale),
      excludeTaskIds: candidate.task ? [String(candidate.task)] : [],
      staleWorkingMs: STALE_WORKING_MS,
    });
    if (busy) {
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
    return {
      ok: true, pumped: false, reason: e.code || 'TARGET_SESSION_UNREACHABLE',
      blocked: { code: e.code || 'TARGET_SESSION_UNREACHABLE', message: String(e.message || '') },
      item, remaining: readDispatchQueue(project).items.length,
    };
  }
  const msg = notify({
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
  writeDispatchLock(project, msg);
  const wake = await wakeSessionForMessage({ project, to: String(item.to || ''), msg, isDispatch: true });
  removeDispatchQueueItem(project, item.id);
  appendEvent({ role: 'system', action: 'dispatch_pump', project, target: msg.id, note: `queue=${item.id} to=${item.to} task=${item.task || ''}` });
  return { ok: true, pumped: true, item, message: msg, wake, remaining: readDispatchQueue(project).items.length };
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
 * Owner 2026-11-14 09:15：认领后 5 分钟无状态变化 → 告警 PM。
 * 只看 type=task/bug 且 status=working 的任务；阈值 TEAM_CLAIM_STALL_MS（默认 5 分钟，测试可注入）；
 * 同一 taskId+状态 10 分钟内不重复；任务 done/状态变化后自然不再命中。
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
    const age = now - claimedAt;
    if (age < stallMs) continue;
    const key = `${task.id}|${task.status}`;
    const last = Date.parse(String(alerted[key] || ''));
    if (!Number.isNaN(last) && now - last < 10 * 60 * 1000) continue;
    const role = String(task.owner || '');
    const ownerName = ROLE_NAMES[role] || role || '（无 owner）';
    const minutes = Math.round(age / 60000);
    try {
      const msg = sendMessage({
        from: 'system', to: 'pm', type: 'escalation', project: name,
        subject: `认领后 ${minutes} 分钟没动：${task.id}`,
        body: `${ownerName} 认领了 ${task.id}，已经 ${minutes} 分钟没有状态变化。\nrole=${role || '-'}\ntaskId=${task.id}\nclaimedAt=${task.claimedAt || '-'}\n当前状态=working\n请 PM 过问一下（换人/拆任务/确认卡在哪）。`,
        ackRequired: false,
      });
      alerted[key] = nowIso();
      hits.push({ taskId: task.id, role, messageId: msg.id, ageMs: age });
      appendEvent({ role: 'system', sessionId: '', action: 'claim_stall_alert', project: name, target: task.id, note: `role=${role} age=${minutes}min message=${msg.id}` });
    } catch (e) {
      hits.push({ taskId: task.id, role, error: String((e && e.message) || e) });
    }
  }
  try { writeJson(file, { schema: 1, project: name, alerted, updatedAt: nowIso() }); } catch { /* 状态写失败不阻断 */ }
  return { ok: true, stallMs, alerted: hits.length, hits };
}

export async function cmdQueue(args) {
  const sub = String((args._ && args._[1]) || 'pump');
  const project = String(args.project || '');
  if (!project) fail('BAD_PROJECT', '需要 --project');
  if (sub === 'status') {
    const queue = readDispatchQueue(project);
    out(args, `派单队列：${queue.items.length} 条`, { ok: true, project, items: queue.items, remaining: queue.items.length });
    return;
  }
  if (sub !== 'pump') fail('BAD_ARGS', `未知的 queue 子命令：${sub}（用法：queue pump|status --project P）`);
  const result = await pumpQueueSafe(project, 'cli');
  // B-d111：兜底补发上一条窗口内被合并的唤醒（窗口结束必发一次，不靠人再触发）。
  const flushed = await flushPendingWakes(project);
  // Owner 2026-11-14 09:15：认领后 5 分钟无状态变化 → 告警 PM（人话，含 role/taskId/claimedAt/当前状态；同任务同状态 10 分钟去重）。
  let claimStall = null;
  try { claimStall = claimStallCheck(project); } catch (e) { claimStall = { ok: false, why: String((e && e.message) || e) }; }
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
  out(args, `队列泵：${detail}${flushHint}`, { ok: result.ok !== false, ...result, flush: flushed, routeStale, decisionStale, claimStall });
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
    requirementsHash: docs.requirements.hash,
    requirements: docs.requirements.count,
    taskDocs: taskDocs.map((d) => d.rel),
    peers: docs.peers.map((p) => p.rel),
  });
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
      read: {
        docs: docs.readOrder, peers: docs.peers.map((p) => p.rel),
        requirements: docs.requirements.count, requirementsHash: docs.requirements.hash,
      },
    },
  });
  const lines = [];
  const bootTtlMinutes = Number(team.config.bootTtlMinutes || DEFAULT_BOOT_TTL_MINUTES);
  const coreDocs = records.filter((d) => d.core);
  const coreRead = coreDocs.filter((d) => d.exists);
  const coreMissing = coreDocs.filter((d) => !d.exists);
  const optionalDocs = records.filter((d) => !d.core);
  const optionalRead = optionalDocs.filter((d) => d.exists);
  const optionalMissing = optionalDocs.filter((d) => !d.exists);
  lines.push(`=== 启动简报 · ${ROLE_NAMES[role] || role} · ${projectName} ===`);
  lines.push(`令牌: ${token.token}（${bootTtlMinutes} 分钟 = ${bootTtlMinutes / 60} 小时；本轮所有写操作都要带 --boot）｜ 哈希 rules ${shortHash(docs.rulesHash)} / index ${shortHash(docs.hashes.projectIndex)}`);
  lines.push(`身份: ${member.name}（${role}）｜ 会话: ${sessionId}`);
  lines.push(`团队模式: ${TEAM_MODE_LABELS[teamMode]}（${teamModeDescription(teamMode)}）｜ 角色集: ${rolesForMode(teamMode).join(' / ')}`);
  lines.push(teamMode === 'fast'
    ? '快速模式: 需求评审=需求分析师 ｜ 技术评审记录=程序员A ｜ 投票=vote start/cast/status'
    : '完整模式: 需求评审=产品设计师 ｜ 技术评审记录=产品/程序员A ｜ 投票=vote start/cast/status');
  lines.push(`阶段: ${team.phase} ｜ 活跃成员: ${activeRoles(team).filter((r) => rolesForMode(teamMode).includes(r)).join(', ')} ｜ 当前锁: ${locks.length ? locks.map((l) => l.key + '@' + l.role).slice(0, 6).join(', ') : '无'}`);
  lines.push(`纪律: 中文思考、中文回复、中文写文档 ｜ 每轮先读项目铁律 ｜ 消息≤${team.config.messageMaxChars}字 ｜ 回执≤${team.config.ackNoteMaxChars}字 ｜ 先读索引再找文件`);
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
  lines.push(`必读-按需已读: ${optionalRead.length ? optionalRead.map((d) => d.rel || d.path).join(' ') : '（无）'}`);
  if (optionalMissing.length) lines.push(`必读-未读: ${optionalMissing.map((d) => d.rel || d.label).join(' ')}`);
  if (taskDocs.length) {
    lines.push(`必读-任务相关（${taskDocs.length}）: ${taskDocs.map((d) => d.rel).join(' ')}`);
  } else {
    lines.push('必读-任务相关: （无未完成任务；收到派单后按派单里的「本轮必读」补读）');
  }
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
  lines.push('下一步: 先读 inbox/待审提案；收到派单先 ack，再执行正文任务，产出落盘，完成后发完成回执并 task done；变更走 propose→review→sign→apply。');
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
  if (args.json) jsonOut({
    ok: true, token: token.token, role, project: projectName, teamMode, sessionId, rulesHash: docs.rulesHash,
    bootTtlMinutes,
    docHashes: docs.hashes, read: bootRead, briefing, unread, tasks, proposals, grants,
    dispatchQueue: bootPump,
    bootQueue,
    handover: handover ? handover.text : null, handoverMeta: handover,
  });
  else textOut(handover ? `${briefing}\n\n${handover.text}` : briefing);
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

export async function cmdSend(args) {
  const b = bootFor(args, 'send');
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
  // 只有“PM 给其他角色派单”才生成派单唤醒；完成回执、通知、请求都只投递。
  // 收件人是 PM 或任务已完成时，即使带 --task/--ack 也降级为通知，避免让 PM 去执行已完成任务。
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
  const willWake = isDispatch || (Boolean(args.wake) && !args['no-wake']);
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
  if (pmDispatch && !args.force) {
    // B-384e：先清过期锁（10 分钟无人回执自动释放），再判未回执锁。
    releaseExpiredDispatchLock(b.project, { source: 'send' });
    // B-405f ②：目标会话 5 分钟无活性（不存在/0 使用）也释放，避免锁在“从未启动的新会话”上锁死全队。
    releasedLock = await releaseInactiveDispatchLock(b.project, { source: 'send' });
    const lock = readDispatchLock(b.project);
    if (lock && lock.messageId) {
      if (args.queue) {
        const item = enqueueDispatch(b.project, {
          from: b.role, to, subject: args.subject || '(无主题)', body,
          task: String(args.task || ''), project: b.project, ackRequired: Boolean(args.ack),
          sessionId: b.sessionId,
        });
        appendEvent({ role: b.role, sessionId: b.sessionId, action: 'dispatch_queue_add', project: b.project, target: item.id, note: `to=${to} task=${item.task || ''}` });
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
    try {
      const task = loadTask(b.project, String(args.task));
      if (task && !task.owner) {
        task.owner = to;
        task.status = task.status || 'open';
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
  const msg = notify({
    from: b.role, to, subject: args.subject || '(无主题)', body, project: b.project,
    task: args.task || '', ackRequired: Boolean(args.ack), type: msgType, sessionId: b.sessionId,
  });
  if (pmDispatch) writeDispatchLock(b.project, msg, { targetSessionId: targetAlive && targetAlive.probe ? targetAlive.probe.sessionId : '' });
  let wake = null;
  // B-6818（T0）：派单默认唤醒；发往 PM 的消息默认唤醒（完成/回执不再等 PM 轮询）；
  // 其它角色仍要显式 --wake；--no-wake 一律关闭。都走 wakeWithGuard 做 30 秒去抖与失败留痕。
  // Owner 09:10：纯回执（type=receipt）不唤醒；完成回执与 task done 通知按 taskId 只叫一次（见 cmdTask done 的 dedupeKey）。
  const wantWake = !args['no-wake'] && msgType !== 'receipt' && (isDispatch || to === 'pm' || Boolean(args.wake));
  // B-743e：把首行归属随发送结果一起返回，便于自测与排障核对格式。
  const wakeHeader = wantWake && msg ? wakeHeaderFor(msg, to) : '';
  if (wantWake) {
    wake = await wakeWithGuard({
      project: b.project, to, msg, isDispatch,
      engineUrl: String(args['engine-url'] || ''), taskRow,
      reason: isDispatch ? 'dispatch' : (to === 'pm' ? 'to_pm' : 'wake_flag'),
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
  // R-c651 F-c651-1①：读消息必须留「kind=read + messageId」证据——这是“角色真的起来了”的主判据，
  // 也是在场数据里“最后活动（阅读）”的来源；旧协议邮箱 new→cur 仍是已读水位本体。
  try {
    if (!alreadyRead) {
      addReadReceipt({
        role: b.role, sessionId: b.sessionId, kind: 'read', project: String(msg.project || b.project || ''),
        messageId: msg.id, messageIds: [msg.id], source: 'inbox', at: nowIso(),
        proposalId: '', proposalHash: '', baseHash: '',
      });
    }
  } catch { /* 阅读证据写失败不阻断读动作本身 */ }
  appendEvent({ role: b.role, sessionId: b.sessionId, action: 'mail_read', project: msg.project, target: msg.id, note: msg.subject });
  out(args, `已读 ${msg.id}：${msg.subject}\n${msg.body}`, { ok: true, message: msg, alreadyRead });
}

export async function cmdAck(args) {
  const b = bootFor(args, 'ack');
  if (!args.id) fail('BAD_ID', '需要 --id');
  // R-c651 F-c651-2：ack 的唤醒路径也是重试执行者（先消化到期重试）。
  let ackWakeRetry = null;
  try { ackWakeRetry = await processWakeRetries(b.project, { source: 'ack' }); } catch { ackWakeRetry = null; }
  const r = ackMessage(b.role, String(args.id), args.note || '已收到');
  // Owner 2026-11-14 09:10：纯回执（ack/已认领）不唤醒，只落已读存档。
  clearDispatchLock(r.msg.project, String(args.id));
  appendEvent({
    role: b.role, sessionId: b.sessionId, action: 'ack', project: r.msg.project, target: r.msg.id,
    note: r.already ? '重复回执' : truncate(String(args.note || '已收到'), 120), data: { ackId: r.ack.id, receiptMessageId: r.receiptMessage?.id || '' },
  });
  // B-a577：回执也触发一次兜底泵（收了回执说明 PM 锁已释放，队列该接着跑）。
  const ackPump = await pumpQueueSafe(r.msg.project, 'ack');
  const hint = '（仅表示已收到/已认领，不算完成；完成请执行正文任务并 task done --evidence）';
  const pumpHint = ackPump && ackPump.pumped
    ? `\n队列自动续跑：已派 ${ackPump.message && ackPump.message.id} → ${ackPump.item && ackPump.item.to}（task ${(ackPump.item && ackPump.item.task) || '-'}）`
    : (ackPump && ackPump.ok === false ? `\n队列泵失败：${String(ackPump.why || ackPump.code || 'QUEUE_PUMP_FAILED').slice(0, 120)}（队列项已保留）` : '');
  out(args, (r.already ? `已回执过 ${r.msg.id}（${r.ack.id}）${hint}` : `已回执 ${r.msg.id}（${r.ack.id}）→ 已通知 ${r.msg.from}${hint}`) + pumpHint, { ok: true, ...r, dispatchQueue: ackPump });
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
  if (sub === 'create') {
    // R-b5fc F-4：测试人员可直接建 type=bug 的 B-* 缺陷任务（旁路不改需求状态机）；其它任务类型仍限 PM/产品/需求分析。
    const wantType = String(args.type || 'task');
    const canCreate = ['pm', 'product', 'analyst'].includes(b.role) || (b.role === 'tester' && wantType === 'bug');
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
    });
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
    if (!args.all) tasks = tasks.filter((t) => t.status !== 'done');
    const rows = tasks.map((t) => ({ id: t.id, p: t.priority, status: t.status, owner: t.owner || '-', title: t.title, due: t.due || '' }));
    out(args, `任务（${b.project}，${tasks.length}）\n` + table(rows, [
      { key: 'p', label: '优先' }, { key: 'id', label: '任务' }, { key: 'status', label: '状态' }, { key: 'owner', label: 'Owner' }, { key: 'due', label: '截止' }, { key: 'title', label: '标题' },
    ]), { ok: true, tasks });
    return;
  }
  if (sub === 'show') {
    if (!args.id) fail('BAD_ID', '需要 --id');
    const task = loadTask(b.project, String(args.id));
    out(args, JSON.stringify(task, null, 2), { ok: true, task });
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
      const kids = allTasks.filter((row) => row && row.type === 'task' && String(row.requirementId || '') === requirementId);
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
    const task = finishTask(b.project, String(args.id), b.role, args.evidence, args.note || '', {
      evidenceFiles: evidenceGate.files,
      checkedAt: evidenceGate.checkedAt,
      skipped: Boolean(evidenceGate.skipped),
    });
    // B-384e：任务完成即释放与它绑定的派单锁（不必等回执），并记事件。
    const releasedLock = releaseDispatchLockForTask(b.project, task.id, { source: 'task_done' });
    const requirementAdvance = advanceRequirementAfterTaskDone(b.project, task, b.role);
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'task_done', project: b.project, target: task.id, note: truncate(String(args.evidence), 120), data: { evidence: task.evidence } });
    // B-6818（T0）：完成事件自动唤醒收件人（通常是 PM），不等 PM 轮询；30 秒去抖，失败写 唤醒.jsonl。
    const doneTo = task.createdBy === 'system' ? 'pm' : String(task.createdBy || 'pm');
    const doneMsg = notify({ from: b.role, to: doneTo, subject: `完成回执 ${task.id}`, body: clipMessage(`${task.title}\n证据：${task.evidence}`), project: b.project, task: task.id, ackRequired: true, type: 'receipt', sessionId: b.sessionId });
    const doneWake = await wakeWithGuard({ project: b.project, to: doneTo, msg: doneMsg, isDispatch: false, reason: `task_done:${task.id}`, dedupeKey: `task_done:${task.id}` });
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
        const arch = archiveSession({ projectName: b.project, role: String(task.owner || b.role), reason: `轮次达 ${ROUNDS_MAX} 自动归档`, auto: true, operator: 'system' });
        roundInfo.archive = arch.record.id;
      }
    } catch (e) { roundInfo = { error: String((e && e.message) || e) }; }
    const roundHint = roundInfo && !roundInfo.error
      ? `\n轮次：${roundInfo.rounds}/${ROUNDS_MAX}${roundInfo.archived === 'triggered' ? `（已自动归档 ${roundInfo.archive || ''}）` : ''}`
      : '';
    const memoryHint = memoryGate && memoryGate.code === 'MEMORY_ABSENT_WARN'
      ? `\n提醒：项目记忆里没有 ${task.id} 的条目（非 P0 不阻断，下一轮补写）`
      : (memoryGate && memoryGate.code === 'MEMORY_UNKNOWN' ? '\n记忆核查不可用（unknown，按告警处理）'
        : (memoryGate && memoryGate.code === 'MEMORY_SKIPPED' ? `\n记忆降级：${memoryGate.why}` : ''));
    const wakeHint = doneWake && doneWake.ok === false
      ? `\n完成事件唤醒失败：${String(doneWake.why || doneWake.code || '').slice(0, 120)}（已写 唤醒.jsonl）`
      : (doneWake && doneWake.skipped === 'DEBOUNCED' ? `\n完成事件唤醒已去抖（30 秒内已提示过 ${doneTo}）` : '');
    const lockHint = releasedLock ? `\n派单锁已释放：${releasedLock.messageId}（task ${task.id}，不再挡下一个派单）` : '';
    const evidenceHint = evidenceGate && !evidenceGate.skipped
      ? `\n证据门：已核 ${evidenceGate.files.length} 个证据文件（sha256 已记入任务）`
      : (evidenceGate && evidenceGate.skipped ? '\n证据门：沙盘跳过（TEAM_SELFTEST=1）' : '');
    out(args, `已完成 ${task.id}，证据：${task.evidence}${evidenceHint}${requirementAdvance ? `\n需求状态：${requirementAdvance.previous} → ${requirementAdvance.status}（phase=${requirementAdvance.phase}）` : ''}${queueHint}${roundHint}${memoryHint}${wakeHint}${lockHint}`, { ok: true, task, evidenceGate, requirementAdvance, dispatchQueue, tailPump, roundInfo, memory: memoryGate, wake: doneWake, releasedLock });
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

export function cmdReq(args) {
  const sub = args._[1] || 'list';
  // 需求评审 / 技术评审记录：fast 由需求分析师评审，full 由产品设计师评审；
  // 技术评审记录在 fast 由程序员A、full 由产品或程序员A记录。PM 不评审。
  if (sub === 'review') return cmdReqReview(args);
  // 可测性评审（TR-Q）：测试人员本人记录；Owner 门（G2.5）读这份证据。
  if (sub === 'trq') return cmdReqTrq(args);
  // 被驳回需求的出口：PM 决定进入下一轮或终止；两者都会同步 工作流.json。
  if (sub === 'iterate' || sub === 'terminate') return cmdReqLifecycle(args, sub);
  const b = bootFor(args, 'req');
  if (sub === 'create') {
    if (!['pm', 'product', 'analyst'].includes(b.role)) fail('NOT_PM', '只有 PM / 产品 / 需求分析能建需求');
    const task = createTask({
      project: b.project, title: args.title, detail: args.detail || '', priority: args.priority,
      priorityBy: args['priority-by'] || b.role, createdBy: b.role, owner: args.owner || null, due: args.due || '',
      type: 'requirement', requirementId: '', acceptance: args.acceptance || '', story: args.story || '',
    });
    appendEvent({ role: b.role, sessionId: b.sessionId, action: 'req_create', project: b.project, target: task.id, note: `${task.priority} ${task.title}`, data: { task } });
    out(args, `已建需求 ${task.id} [${task.priority}] ${task.title}`, { ok: true, requirement: task });
    return;
  }
  if (sub === 'list') {
    const tasks = listTasks(b.project);
    const reqs = tasks.filter((t) => t.type === 'requirement');
    const children = tasks.filter((t) => t.type !== 'requirement');
    const rows = reqs.map((r) => {
      const kids = children.filter((c) => c.requirementId === r.id);
      return {
        id: r.id, p: r.priority, status: r.status, owner: r.owner || '-', title: r.title,
        review: r.review ? `${r.review.verdict}` : '-',
        tech: r.techReview ? `${r.techReview.verdict}` : '-',
        kids: kids.length, done: kids.filter((k) => k.status === 'done').length, acceptance: r.acceptance || '',
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
    out(args, JSON.stringify({ requirement: r, tasks: kids }, null, 2), { ok: true, requirement: r, tasks: kids });
    return;
  }
  fail('BAD_SUBCOMMAND', `未知 req 子命令：${sub}`);
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
  // 必读闸门：评审人必须在本轮 boot 里读过该需求正文；需求在 boot 后改过就要重新 boot 补读。
  assertRequirementDocsRead(b, project.path, task.id, isTech ? '技术评审' : '需求评审');
  const verdict = String(args.verdict || args.decision || '').toLowerCase();
  if (!['approve', 'reject'].includes(verdict)) fail('BAD_VERDICT', '--verdict 必须是 approve / reject');
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
  const warnings = [];
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
  try {
    const docs = readRequirementDocs(project.path);
    const doc = docs.list.find((row) => idMatches(row.id, task.id));
    requirementHash = doc ? String(doc.hash || '') : '';
    requirementContentHash = doc ? String(doc.contentHash || '') : '';
  } catch { requirementHash = ''; }
  const record = {
    id: (isTech ? 'TR-' : 'RR-') + stamp() + '-' + randomHex(2),
    kind: isTech ? 'tech' : 'requirement',
    project: b.project,
    teamMode,
    requirementId: task.id,
    title: task.title,
    requirementHash,
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
      source: 'team.mjs req review',
      command: 'req review',
    };
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
  let nextStatus;
  let ownerPending = false;
  if (verdict === 'reject') {
    stampRejected(task, { source: `${record.kind}_review:${record.id}`, role: b.role, at: ts });
    nextStatus = 'rejected';
  } else {
    if (isTech) {
      nextStatus = keepForwardStatus(currentStatus === 'rejected' ? 'approved' : currentStatus, 'ready');
    } else {
      // 已有同 basis 的 Owner 批准/跳过：保持/恢复 ready，不把 Owner 决定打回 pending。
      nextStatus = keepForwardStatus(currentStatus, decisionFresh ? 'ready' : 'approved');
      ownerPending = !decisionFresh && statusRank(nextStatus) < statusRank('ready');
    }
    task.workflow.requirementStatus = nextStatus;
    delete task.workflow.rejectedAt;
    delete task.workflow.rejectedBy;
    delete task.workflow.rejectionSource;
  }
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
    ownerReview: ownerPending ? { status: 'pending', at: null, opinion: '' } : undefined,
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
    statePatch: ownerPending
      ? { ownerReview: { required: true, status: 'pending', kind: 'requirement', at: null, opinion: '' } }
      : null,
  });
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
  const record = {
    requirementId: task.id,
    requirementHash: doc.hash,
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
  task.workflow.requirementStatus = task.workflow.requirementStatus || 'review';
  task.updatedAt = at;
  task._by = b.role;
  task._action = 'trq';
  task._note = truncate(`TR-Q ${verdict} v${version}`, 100);
  saveTask(b.project, task);
  const status = String((task.workflow && task.workflow.requirementStatus) || 'review');
  const sync = syncWorkflowRow(b.project, task, status, { trq: record, teamMode: projectTeamMode(project) }, {
    create: true, action: 'trq', by: b.role, note: `TR-Q ${verdict} v${version}`,
  });
  appendEvent({ role: b.role, sessionId: b.sessionId, action: 'trq', project: b.project, target: task.id, note: `${verdict} v${version}`, data: { trq: record } });
  out(args, `已记录可测性评审：${task.id} → ${verdict}（v${version}）\n文件：${path.join(project.path, rel)}\n结论：${verdict}${missing.length ? ' ｜ 缺项：' + missing.join('；') : ''}`, {
    ok: true, requirementId: task.id, trq: record, file: rel, workflowFile: sync.file,
  });
}

/**
 * 被驳回需求的出口：req iterate / req terminate。
 * 只改团队工具任务与 工作流.json 的需求行；不改阶段机里的其它需求。
 */
function cmdReqLifecycle(args, action) {
  const b = bootFor(args, `req ${action}`);
  if (b.role !== 'pm') fail('NOT_PM', `只有 PM 能决定需求 ${action === 'iterate' ? '进入下一轮' : '终止'}`);
  if (!args.id) fail('BAD_ID', '需要 --id R-...');
  const task = loadTask(b.project, String(args.id));
  if (task.type !== 'requirement') {
    fail('NOT_REQUIREMENT', `${task.id} 不是需求（type=${task.type}）；req ${action} 只针对 req create 建的需求`, { id: task.id, type: task.type });
  }
  const reason = String(args.reason || args.comments || args.opinion || '').trim();
  const result = transitionRequirement({
    project: b.project, task, action, role: b.role, sessionId: b.sessionId, reason, force: Boolean(args.force),
  });
  // 终止后未消费的派单必须清掉，避免角色之后再被旧派单唤醒去做已终止需求。
  const queue = action === 'terminate'
    ? clearDispatchQueue(b.project, { reason: 'req_terminate', requirementId: task.id })
    : null;
  const human = action === 'iterate'
    ? `需求已进入下一轮：${task.id}（第 ${result.requirement.workflow.iterationRound} 轮）\n工作流：${result.workflowFile}`
    : `需求已终止：${task.id}\n关闭子任务 ${result.closedTasks.length} 个\n工作流：${result.workflowFile}${queue && queue.count ? `\n清理未消费派单：${queue.count} 条` : ''}`;
  out(args, human, {
    ok: true,
    action,
    requirement: result.requirement,
    workflowFile: result.workflowFile,
    workflow: result.workflow,
    closedTasks: result.closedTasks,
    ...(queue ? { dispatchQueue: queue } : {}),
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
function ownerTestGate(projectName, requirementId) {
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
  const open = testTasks.filter((row) => String(row.status || '') !== 'done');
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
  return { ok: true, mode: 'tasks', taskIds: testTasks.map((row) => row.id) };
}

/**
 * Owner 决定的依据（basis）：需求正文路径+sha256，设计文件路径+版本+sha256。
 * fast 无产品设计，用需求分析 vN 作为设计依据；都没有时留空并在 reason 里写明原因。
 */
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
  const teamMode = projectTeamMode(project);
  const task = loadTask(projectName, requirementId);
  if (task.type !== 'requirement') {
    fail('NOT_REQUIREMENT', `${requirementId} 不是需求（type=${task.type}），Owner 命令只处理需求`, { id: requirementId, type: task.type });
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
    const ownerStatus = String((row && row.ownerReview && row.ownerReview.status) || '');
    if (ownerStatus && !['approved', 'skipped'].includes(ownerStatus)) {
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
    proxyRecord = activeProxyFor(projectName, requirementId);
    if (!proxyRecord) {
      fail('PROXY_UNAUTHORIZED', `需求 ${requirementId} 当前没有未结束的代管授权：先在评审弹窗点「全部交 PM 代管」，或 owner proxy start --scope always`, { project: projectName, requirementId });
    }
    if (!String(proxyRecord.authorization || '').trim()) {
      fail('PROXY_UNAUTHORIZED', '代管记录缺少 Owner 授权来源（authorization），不能代落账', { requirementId, proxy: proxyRecord });
    }
    if (actionRaw === 'accept') {
      // 代管只能代「验收通过」；打回/迭代/终止仍必须 Owner 本人。
      if (String(decision) !== 'accepted') {
        fail('PROXY_ACCEPT_FORBIDDEN', '代管只能代验收通过（accepted）；打回/迭代/终止必须 Owner 本人执行', { decision });
      }
      const items = parseEvidenceArg(args.evidence);
      const verdict = validatePmAcceptEvidence({ items, projectPath: project.path });
      if (!verdict.ok) {
        fail('PM_ACCEPT_EVIDENCE_REQUIRED', 'PM 代验收必须带测试报告 ≥1、截图 ≥1，且文件存在、sha256 可核对', {
          requirementId, missing: verdict.missing, maxItems: 12,
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
  const record = {
    status: decision,
    by: proxyMode ? 'PM（代记 Owner 的决定）' : 'Owner',
    actor: proxyMode ? 'pm' : 'owner',
    at,
    opinion,
    channel,
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
      decidedBy: 'owner',
      signedBy: 'pm',
      testGate: 'pm_signed',
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
      ...(proxyMode ? {
        recordedBy: 'pm',
        ownerAuthorized: true,
        proxy: record.proxy,
      } : {}),
    };
  // note 必须与工作台壳层 pushWorkflowEventOnce 的写法完全一致，否则同一次 Owner
  // 决定会被记成两条事件（壳层已兼容旧命令写过的记录）。
  const eventNote = actionRaw === 'accept'
    ? decision
    : `${decision}${opinion ? '：' + opinion.slice(0, 80) : ''}`;
  const sync = syncWorkflowRow(projectName, task, nextStatus, {
    teamMode,
    decisions,
    ...(ownerReview ? { ownerReview } : {}),
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
  const projectName = String(args.project || '').trim();
  if (!projectName) fail('BAD_ARGS', '需要 --project <团队项目名>');
  const requirementId = String(args.requirement || '').trim();
  if (!requirementId) fail('BAD_ARGS', '需要 --requirement R-...');
  const decision = String(args.decision || '').trim().toLowerCase();
  const actionRaw = String(args.action || '').trim().toLowerCase();
  // T-3422：代管可以代「验收通过」（--action accept + decision=accepted），但打回/迭代/终止仍必须 Owner 本人。
  // 证据校验不在这里做：统一交给 cmdOwner 的 proxyMode 分支（pm-accept-evidence.mjs，写盘前校验、缺项零副作用）。
  if (actionRaw === 'accept' || decision === 'accepted') {
    if (decision !== 'accepted') {
      fail('PROXY_ACCEPT_FORBIDDEN', '代管只能代验收通过（accepted）；打回/迭代/终止必须 Owner 本人执行', { decision });
    }
    if (args.opinion === undefined || args.opinion === null) {
      fail('OPINION_REQUIRED', '需要 --opinion "PM 代记依据/说明"（可以为空字符串，但必须显式给出）');
    }
    const acceptProxy = activeProxyFor(projectName, requirementId);
    if (!acceptProxy) {
      fail('PROXY_UNAUTHORIZED', `需求 ${requirementId} 当前没有未结束的代管授权：先请 Owner 在评审弹窗点「全部交 PM 代管」，或运行 owner proxy start --scope always`, { project: projectName, requirementId });
    }
    if (!String(acceptProxy.authorization || '').trim()) {
      fail('PROXY_UNAUTHORIZED', '代管记录缺少 Owner 授权来源（authorization），不能代落账', { requirementId, proxy: acceptProxy });
    }
    await cmdOwner({ ...args, _: ['owner'], action: 'accept', 'proxy-recorded-by': 'pm' });
    return;
  }
  if (actionRaw === 'iterate' || actionRaw === 'terminate' || decision === 'iterate' || decision === 'terminated') {
    fail('PROXY_ACCEPT_FORBIDDEN', '代管只能代记评审决定（approved/rejected/skipped）与验收通过（accepted）；打回/迭代/终止必须 Owner 本人执行');
  }
  if (!['approved', 'rejected', 'skipped'].includes(decision)) {
    fail('OWNER_DECISION_INVALID', 'PM 代管落账支持 approved / rejected / skipped，以及验收 accepted（配 --action accept + --evidence）', { decision });
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
  if (b.role !== 'pm') fail('NOT_PM', '只有 PM 能推进工作流轮次或终止工作流');
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
    ? `工作流已进入下一轮：第 ${result.fromRound} 轮 → 第 ${result.round} 轮；转入迭代 ${result.transitioned.length} 条\n工作流：${result.workflowFile}`
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
  appendEvent({ role: b.role, sessionId: b.sessionId, action: 'index_find', project: b.project, target: q, note: `matches=${matches.length}`, data: { q, matches: matches.map((m) => m.target) } });
  out(args, `按索引找到 ${matches.length} 个文件（先读索引，再找文件）\n` + table(matches.slice(0, 50).map((f) => ({ target: f.target, size: f.size, hash: shortHash(f.hash || '', 10) })), [
    { key: 'target', label: '文件' }, { key: 'size', label: '大小' }, { key: 'hash', label: '哈希' },
  ]), { ok: true, query: q, matches });
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
          rows.push({
            target: relPath(dir, abs), summary: fileSummary(abs, relPath(dir, abs)),
            size: st.size, updated: fileUpdated(abs), hash: st.size <= 2 * 1024 * 1024 ? shortHash(hashFile(abs), 10) : '(大文件)',
          });
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
    ['项目铁律.md', '每轮必读：底线、红线、失败即停', 'PM', '每轮'],
    ['项目信息.md', '项目目标、场景、交付、边界、任务分配', 'PM', '接需求/开工前'],
    ['协作准则.md', `${modeLabel}协同、启动顺序、需求与文件规则`, 'PM', '首次/规则变更'],
    ['项目索引.md', '本目录：必读顺序与文件导航', 'PM', '每轮'],
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
  lines.push('## 六、避雷铁律（每轮必读）');
  lines.push('');
  lines.push('- 每轮先读《项目铁律.md》，再读项目信息/本索引/角色卡；不要凭上一轮记忆开工。');
  lines.push('- 只读任务需要的文件；不要每轮把 `需求/`、角色目录全量读一遍。');
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
  });
  const roleIndexes = writeRoleIndexes(project);
  appendEvent({ role: by, sessionId, action: 'index', project: project.name, target: '项目索引.md', note: `files=${files.length} roleIndexes=${roleIndexes.length}`, data: { files: files.length, roleIndexes: roleIndexes.length } });
  if (!silent) textOut(`索引已生成：${oldPath}（${files.length} 文件，${roleIndexes.length} 份目录索引）`);
  return { path: oldPath, files: files.length, rows: rows.length, roleIndexes: roleIndexes.length, requirements: reqRows.length };
}

export function cmdIndex(args) {
  const team = loadTeam();
  const name = String(args.project || team.activeProject || '');
  if (!name) fail('NO_PROJECT', '需要 --project');
  const project = loadProject(name);
  const r = generateIndex(project, { by: args.role || 'system', sessionId: sessionOf(args), silent: false });
  // index 也是“重建项目内可见索引”的手动入口：顺手补齐 提案/ 镜像（曾失败/待重建时用它）。
  const mirror = mirrorSafe(name, 'index');
  if (args.json) jsonOut({ ok: true, ...r, proposalMirror: mirror });
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

export function cmdStatus(args) {
  const team = loadTeam();
  const { text, data } = renderStatus(team);
  writeText(PATHS.dashboard, text);
  if (args.json) jsonOut({ ok: true, ...data, dashboard: PATHS.dashboard });
  else textOut(text);
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
    if (!exists(card)) writeText(card, `# ${m.name}\n\n- 职责：${args.duty || '（待补）'}\n- 每轮先 boot。\n`);
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
