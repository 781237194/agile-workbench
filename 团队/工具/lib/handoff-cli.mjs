/**
 * R-8f68 v3：角色直连流转 CLI（批 1）。
 *
 *   handoff --boot <T> --from analyst|product|programmer1|programmer2|tester --to <角色> \
 *           --task T-... --action review|develop|test|fix|accept [--note "..."] [--why "..."]
 *   handoff accept --boot <T> --task T-...            # 下游接收确认（status=working + handoff_ack）
 *   handoff list [--project P] [--role R] [--json]
 *   handoff prioritize --boot <PM> --task T-... [--to R] [--priority P0]   # PM 插队
 *   handoff done --boot <T> --task T-...              # 从直连队列移除（不写真相）
 *   rule-exception status --project P [--json]        # 铁律 5 例外批准状态（batch1/batch2）
 *   rule-exception invite --project P [--test-owner]  # Owner 批准用一次性确认码
 *   rule-exception approve --project P --owner-confirm <码> [--note "..."]
 */
import { fail, jsonOut, textOut } from './core.mjs';
import { requireBoot, loadProject } from './store.mjs';
import { ROLE_NAMES } from './roles.mjs';
import { issueOwnerConfirmation, consumeOwnerConfirmation } from './owner-confirm.mjs';
import {
  sendHandoff, acceptHandoff, listHandoffQueue, prioritizeHandoff, completeHandoff,
  ruleExceptionStatus, approveRuleException, HANDOFF_ACTIONS,
} from './handoff.mjs';

function out(args, human, json) {
  if (args.json) jsonOut(json);
  else textOut(human);
}

function needProject(args) {
  const name = String(args.project || '').trim();
  if (!name) fail('BAD_PROJECT', '需要 --project');
  return name;
}

function bootOf(args, action) {
  if (!args.boot) fail('BOOT_REQUIRED', `需要 --boot <启动令牌>（${action}）`);
  const b = requireBoot(String(args.boot), {});
  if (args.project && String(args.project) !== String(b.project || '')) fail('BOOT_PROJECT_MISMATCH', `令牌项目 ${b.project} ≠ --project ${args.project}`);
  return b;
}

export async function cmdHandoff(args) {
  const sub = String((args._ && args._[1]) || 'send').toLowerCase();
  if (sub === 'list') {
    const name = needProject(args);
    loadProject(name);
    const r = listHandoffQueue(name, { role: String(args.role || ''), all: Boolean(args.all) });
    const lines = [`直连队列（${name}）：${r.count} 条（上限 ${r.max}）`];
    if (!r.items.length) lines.push('（空）');
    for (const item of r.items) lines.push(`- [${item.priority}] ${item.taskId} ${item.action} ${item.from}→${item.to}`);
    out(args, lines.join('\n'), { ok: true, project: name, ...r });
    return;
  }
  if (sub === 'accept') {
    const b = bootOf(args, 'handoff accept');
    if (!args.task) fail('BAD_ARGS', '需要 --task T-...');
    const r = acceptHandoff(b.project, { taskId: String(args.task), role: b.role });
    out(args, `已接收 ${r.taskId}（${ROLE_NAMES[r.to] || r.to}）：status=${r.status}，已写 handoff_ack`, { ok: true, project: b.project, by: b.role, ...r });
    return;
  }
  if (sub === 'prioritize') {
    const b = bootOf(args, 'handoff prioritize');
    if (b.role !== 'pm') fail('PERMISSION_DENIED', '只有 PM 能插队/改队列优先级', { role: b.role });
    const r = prioritizeHandoff(b.project, { taskId: String(args.task || ''), to: String(args.to || ''), priority: String(args.priority || ''), by: b.role });
    out(args, `已插队：${r.item.taskId} → ${r.item.to}（[${r.item.priority}] 第 ${r.position} 位 / 共 ${r.count}）`, { ok: true, project: b.project, ...r });
    return;
  }
  if (sub === 'done') {
    const b = bootOf(args, 'handoff done');
    const r = completeHandoff(b.project, { taskId: String(args.task || ''), role: b.role });
    out(args, r.removed ? `已从直连队列移除 ${r.taskId}` : `直连队列里没有 ${args.task}（可能已移除）`, { ok: true, project: b.project, ...r });
    return;
  }
  // send（默认）
  const b = bootOf(args, 'handoff');
  if (!args.task) fail('BAD_ARGS', '需要 --task T-...');
  const from = String(args.from || b.role || '').trim();
  // 伪造 from：令牌角色与 --from 不一致直接拒（零写入）
  if (from !== b.role) fail('HANDOFF_FORBIDDEN', `--from ${from} 与令牌角色 ${b.role} 不一致，不能伪造投递方`, { from, role: b.role });
  const action = String(args.action || '').trim().toLowerCase();
  if (!HANDOFF_ACTIONS.includes(action)) fail('HANDOFF_FORBIDDEN', `action 不在流程边表里：${action || '-'}（可用：${HANDOFF_ACTIONS.join('/')}）`, { action });
  const r = sendHandoff(b.project, {
    from, to: String(args.to || ''), taskId: String(args.task), action,
    why: String(args.why || ''), note: String(args.note || ''),
  });
  const human = r.fallback
    ? `直连写队列失败（${r.fallback.code}），已回退 PM 卡点消息 ${r.fallback.messageId}；任务 ${r.taskId} owner 已改为 ${r.to}，未唤醒`
    : `已直连 ${r.taskId} → ${ROLE_NAMES[r.to] || r.to}（action=${r.action}，队列第 ${r.queuePos} 位）；未唤醒（交给路由守护）`;
  out(args, human, { ok: true, project: b.project, ...r });
}

export async function cmdRuleException(args) {
  const sub = String((args._ && args._[1]) || 'status').toLowerCase();
  const project = needProject(args);
  loadProject(project);
  if (sub === 'status') {
    const r = ruleExceptionStatus(project);
    out(args, `铁律 5 例外（${project}）：${r.exemption.status}${r.batch === 'batch2' ? '（批 2 已生效：常规流转不再要求 PM 回执）' : '（批 1：常规流转仍按铁律 5 回执）'}`,
      { ok: true, project, ...r });
    return;
  }
  if (sub === 'invite') {
    const testOwner = Boolean(args['test-owner'] || args.testOwner);
    if (!testOwner && !process.stdout.isTTY) fail('OWNER_CONFIRM_REQUIRED', '签发 Owner 确认码必须在真实终端，或仅测试用 --test-owner', { project });
    if (testOwner && process.env.TEAM_SELFTEST !== '1') fail('OWNER_CONFIRM_REQUIRED', '--test-owner 只在 TEAM_SELFTEST=1 的沙盘可用', {});
    const record = issueOwnerConfirmation({ project, requirementId: '_iron5_exemption', decision: 'rule_exception_approve', channel: testOwner ? 'test' : 'tty' });
    out(args, `Owner 确认码（铁律 5 例外批准，10 分钟一次性）：${record.nonce}`, { ok: true, project, nonce: record.nonce, expiresAt: record.expiresAt });
    return;
  }
  if (sub === 'approve') {
    const nonce = String(args['owner-confirm'] || '').trim();
    if (!nonce) fail('OWNER_CONFIRM_REQUIRED', '批准铁律 5 例外需要 Owner 一次性确认码（rule-exception invite 签发）', { project });
    const consumed = consumeOwnerConfirmation({ nonce, project, requirementId: '_iron5_exemption', decision: 'rule_exception_approve', channel: String(args.channel || 'tty') });
    if (!consumed) fail('OWNER_CONFIRM_REQUIRED', 'Owner 确认码无效或已过期', { project });
    const r = approveRuleException(project, { approvedBy: 'owner', note: String(args.note || '') });
    out(args, `已批准铁律 5 例外（${project}）：批 2 生效`, { ok: true, project, ...r });
    return;
  }
  fail('BAD_ARGS', `未知的 rule-exception 子命令：${sub}（status|invite|approve）`);
}
