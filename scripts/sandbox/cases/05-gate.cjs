#!/usr/bin/env node
'use strict';
/**
 * 用例 ⑤：权限与门禁矩阵（G2/G3/TR-Q/代管类命令）——会产生真实评审/决定落账，必须进沙盘
 * 断言三条越权路径都被明确拒绝（零副作用）：
 *   非 PM 读全量角色队列 → QUEUE_FORBIDDEN
 *   非 PM 往 Owner 决策箱放条目 → DECISION_BOX_FORBIDDEN
 *   非评审角色（测试）做需求评审 → ROLE_NOT_ALLOWED
 */
const lib = require('./_lib.cjs');

const checks = new lib.Checks();

function pickRequirementId() {
  const workflow = lib.readJsonSandbox('团队', '状态', '项目', lib.PROJECT, '工作流.json');
  const rows = Object.values((workflow && workflow.requirements) || {});
  const hit = rows.find((row) => ['ready', 'dev', 'dev_review', 'owner_review', 'approved'].includes(String(row.status)));
  return hit ? String(hit.id) : (rows[0] ? String(rows[0].id) : '');
}

const requirementId = pickRequirementId();
checks.add('沙盘工作流里有可操作的需求行', Boolean(requirementId), { requirementId });

const pm = lib.boot('pm');
const coder = lib.boot('programmer2');
const tester = lib.boot('tester');
checks.add('沙盘内 boot pm/programmer2/tester 成功', pm.ok && coder.ok && tester.ok);

if (requirementId && pm.ok && coder.ok && tester.ok) {
  const queues = lib.teamJson(['queues', '--project', lib.PROJECT, '--boot', coder.token, '--all']);
  checks.add('非 PM 读全量角色队列被拒（QUEUE_FORBIDDEN）', queues.ok === false && String(queues.code) === 'QUEUE_FORBIDDEN', { code: queues.code });

  const decision = lib.teamJson(['decision', 'add', '--project', lib.PROJECT, '--boot', coder.token, '--title', '沙盘探针', '--question', '沙盘探针（不应落盘）', '--options', 'A,B', '--source-kind', 'file', '--source-ref', 'docs/测试环境.md']);
  checks.add('非 PM 往决策箱放条目被拒（DECISION_BOX_FORBIDDEN）', decision.ok === false && String(decision.code) === 'DECISION_BOX_FORBIDDEN', { code: decision.code });

  const review = lib.teamJson(['req', 'review', '--project', lib.PROJECT, '--boot', tester.token, '--id', requirementId, '--verdict', 'approve']);
  checks.add('非评审角色做需求评审被拒（ROLE_NOT_ALLOWED）', review.ok === false && String(review.code) === 'ROLE_NOT_ALLOWED', { code: review.code });

  const workflow = lib.readJsonSandbox('团队', '状态', '项目', lib.PROJECT, '工作流.json');
  const allRows = Object.values((workflow && workflow.requirements) || {});
  const acceptTarget = allRows.find((row) => String(row.status) === 'test_done');
  const ownerDecision = acceptTarget
    ? lib.teamJson(['owner', '--project', lib.PROJECT, '--requirement', String(acceptTarget.id), '--decision', 'accepted', '--action', 'accept', '--opinion', '沙盘越权探针'])
    : lib.teamJson(['owner', '--project', lib.PROJECT, '--requirement', requirementId, '--decision', 'approved', '--opinion', '沙盘越权探针']);
  checks.add(
    'Owner 决定不能靠令牌冒充（必须本机确认码；带 --boot 也拿不到 Owner 权限）',
    ownerDecision.ok === false && ['OWNER_CONFIRM_REQUIRED', 'PRODUCT_REVIEW_REQUIRED', 'OWNER_ACTION_REQUIRED'].includes(String(ownerDecision.code)),
    { code: ownerDecision.code, viaAccept: Boolean(acceptTarget) },
  );

  lib.emit({
    ok: checks.ok,
    case: '05-gate',
    category: '⑤权限与门禁',
    queueForbidden: String(queues.code) === 'QUEUE_FORBIDDEN',
    decisionBoxForbidden: String(decision.code) === 'DECISION_BOX_FORBIDDEN',
    reviewRoleDenied: String(review.code) === 'ROLE_NOT_ALLOWED',
    ownerDecisionGated: ownerDecision.ok === false,
    requirementId,
  }, checks);
} else {
  lib.emit({ ok: false, case: '05-gate', category: '⑤权限与门禁', bootFailed: !pm.ok || !coder.ok || !tester.ok, requirementId }, checks);
}
