/**
 * R-9db6 v3：Owner 决策箱 CLI（工具侧入口，界面由壳层另做）。
 *
 *   decision add --project P --boot <PM令牌> --title ... --summary ... --question ... \
 *     --options "A,B,其他" --source-kind message|file|requirement --source-ref M-...
 *   decision list --project P [--json]                 # 只读：未读/待决计数与条目
 *   decision read --project P --id D-... [--json]      # Owner 展开（写 readAt，不唤醒）
 *   decision invite --project P --id D-... [--test-owner]   # 签发 Owner 一次性确认码（终端）
 *   decision ack --project P --id D-... --choice A [--opinion "..."] --owner-confirm <码>
 *   decision archive --project P --id D-...
 *   decision stale-check --project P [--json]          # 静默兜底：满足条件才唤醒 PM 一次
 *
 * Owner 身份复用 owner-confirm 的一次性 nonce（不新造第二套令牌）；没有 confirm 码 → OWNER_CONFIRM_REQUIRED。
 */
import fs from 'node:fs';
import { fail, jsonOut, textOut, nowIso } from './core.mjs';
import { loadProject, requireBoot, projectStatePaths } from './store.mjs';
import { ROLE_NAMES } from './roles.mjs';
import { issueOwnerConfirmation, consumeOwnerConfirmation } from './owner-confirm.mjs';
import {
  addDecision, listDecisionBox, markDecisionRead, acknowledgeDecision, archiveDecision,
  decisionBoxPath, decisionReceiptStaleCheck, markDecisionReceiptWoken, rebuildCorruptBox,
  readDecisionBox, DECISION_BOX_FILE,
} from './decision-box.mjs';
import { sendMessage } from './store.mjs';

/**
 * 损坏自愈（F-9db6-9）：发现 决策箱.json 损坏 → 备份重建 → 给 PM 发 type=wake_failed、why=decision_box_corrupt
 * （不新造消息类型）→ 事件里已有 decision_box_rebuilt。返回是否重建过。
 */
function ensureBoxHealthy(projectName) {
  const read = readDecisionBox(projectName);
  if (!read.corrupt) return { rebuilt: false };
  const rebuilt = rebuildCorruptBox(projectName);
  try {
    sendMessage({
      from: 'system', to: 'pm', type: 'wake_failed', project: projectName,
      subject: `决策箱文件损坏已重建（${projectName}）`,
      body: `决策箱.json 无法解析，已备份到 ${rebuilt.backupPath} 并重建空列表（why=decision_box_corrupt）。之前放入的条目需要重新放。`,
      ackRequired: false,
    });
  } catch { /* 告警失败不阻断重建 */ }
  return { rebuilt: true, ...rebuilt };
}

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

export async function cmdDecision(args) {
  const sub = String((args._ && args._[1]) || 'list').toLowerCase();
  const project = String(args.project || '').trim();
  if (sub === 'add') {
    const b = bootOf(args, 'decision add');
    ensureBoxHealthy(project);
    if (b.role !== 'pm') fail('DECISION_BOX_FORBIDDEN', '只有 PM 能把条目放进决策箱', { role: b.role });
    const r = addDecision(project, {
      title: args.title, summary: args.summary, question: args.question,
      options: args.options, source: { kind: args['source-kind'], ref: args['source-ref'] },
      by: b.role,
    });
    out(args, `已放入 ${r.item.id}（${r.item.title}）；候选：${(r.item.options || []).join(' / ')}`, { ok: true, project, by: b.role, ...r });
    return;
  }
  if (sub === 'list') {
    const name = needProject(args);
    loadProject(name);
    ensureBoxHealthy(name);
    const r = listDecisionBox(name, { includeArchived: Boolean(args.all) });
    const lines = [`Owner 决策箱（${name}）：待决 ${r.counts.open} ｜ 未读 ${r.counts.unread} ｜ 已回执 ${r.counts.answered} ｜ 归档 ${r.counts.archived}`];
    if (!r.items.length) lines.push('（暂无待决事项）');
    for (const item of r.items) {
      lines.push(`- ${item.id} [${item.status}${item.readAt ? '·已读' : '·未读'}] ${item.title} ｜ 来源 ${item.source.kind}:${item.source.ref}`);
    }
    out(args, lines.join('\n'), { ok: true, project: name, ...r, file: decisionBoxPath(name) });
    return;
  }
  if (sub === 'read') {
    const name = needProject(args);
    loadProject(name);
    ensureBoxHealthy(name);
    if (!args.id) fail('BAD_ID', '需要 --id D-...');
    const r = markDecisionRead(name, String(args.id));
    const item = r.item;
    out(args, [
      `决策条目 ${item.id}`,
      `标题：${item.title}`,
      `摘要：${item.summary || '(无)'}`,
      `待决：${item.question}`,
      `来源：${item.source.kind} → ${item.source.ref}`,
      `放入时间：${item.createdAt} ｜ 候选：${(item.options || []).join(' / ')}`,
      `回执：${item.receipt && item.receipt.messageId || '(未回执)'}`,
    ].join('\n'), { ok: true, project: name, item });
    return;
  }
  if (sub === 'invite') {
    const name = needProject(args);
    loadProject(name);
    if (!args.id) fail('BAD_ID', '需要 --id D-...');
    const testOwner = Boolean(args['test-owner'] || args.testOwner);
    if (!testOwner && !process.stdout.isTTY) {
      fail('OWNER_CONFIRM_REQUIRED', '签发 Owner 确认码必须在真实终端，或仅测试用 --test-owner（TEAM_SELFTEST=1）', { project: name, id: args.id });
    }
    if (testOwner && process.env.TEAM_SELFTEST !== '1') {
      fail('OWNER_CONFIRM_REQUIRED', '--test-owner 只在 TEAM_SELFTEST=1 的沙盘可用', {});
    }
    const record = issueOwnerConfirmation({
      project: name, requirementId: String(args.id), decision: 'decision_box_ack', channel: testOwner ? 'test' : 'tty',
    });
    out(args, `Owner 确认码（${String(args.id)}，10 分钟内一次性）：${record.nonce}\n回执时带上：--owner-confirm ${record.nonce}`,
      { ok: true, project: name, id: String(args.id), nonce: record.nonce, expiresAt: record.expiresAt });
    return;
  }
  if (sub === 'ack') {
    const name = needProject(args);
    loadProject(name);
    ensureBoxHealthy(name);
    if (!args.id) fail('BAD_ID', '需要 --id D-...');
    const nonce = String(args['owner-confirm'] || '').trim();
    if (!nonce) {
      fail('OWNER_CONFIRM_REQUIRED', 'Owner 回执需要一次性确认码：先运行 decision invite（真实终端）拿到确认码，再带 --owner-confirm', { project: name, id: args.id });
    }
    const consumed = consumeOwnerConfirmation({
      nonce, project: name, requirementId: String(args.id), decision: 'decision_box_ack', channel: String(args.channel || 'tty'),
    });
    if (!consumed) fail('OWNER_CONFIRM_REQUIRED', 'Owner 确认码无效或已过期', { project: name, id: args.id });
    const r = await acknowledgeDecision(name, { id: String(args.id), choice: args.choice, opinion: args.opinion || '' });
    const human = r.idempotent
      ? `条目 ${args.id} 已回执过（messageId=${r.messageId || '-'}），不重复发送`
      : `已回执 ${args.id}：选择 ${r.item.decision.choice}；回执消息 ${r.messageId} → PM（默认静默，不唤醒）`;
    out(args, human, { ok: true, project: name, ...r });
    return;
  }
  if (sub === 'archive') {
    const name = needProject(args);
    loadProject(name);
    ensureBoxHealthy(name);
    if (!args.id) fail('BAD_ID', '需要 --id D-...');
    const r = archiveDecision(name, String(args.id));
    out(args, `已归档 ${r.item.id}（answeredAt=${r.item.answeredAt}）`, { ok: true, project: name, ...r });
    return;
  }
  if (sub === 'stale-check') {
    const name = needProject(args);
    loadProject(name);
    const stale = decisionReceiptStaleCheck(name);
    if (!stale.ok) fail(String(stale.code || 'DECISION_BOX_CORRUPT'), '决策箱损坏，无法检查回执', { project: name });
    if (!stale.needWake) {
      out(args, `未读回执 ${stale.unread} 条，未达兜底条件（阈值 ${stale.threshold} 条或者 ${Math.round(Number(stale.staleMs || 0) / 60000)} 分钟）`,
        { ok: true, project: name, ...stale, woke: false });
      return;
    }
    // 真正唤醒 PM 一次（复用唤醒出口：合并窗口/重试/失败告警），然后重新计数。
    const { wakeMailboxRecipient } = await import('./ops.mjs');
    const wake = await wakeMailboxRecipient(name, 'pm', {
      reason: `decision_receipt_${stale.reason === 'COUNT' ? 'count' : 'stale'}`,
      subject: `Owner 决策箱：${stale.unread} 条回执待读`,
      messageId: (stale.messageIds && stale.messageIds[0]) || '',
    });
    markDecisionReceiptWoken(name, { lastSeq: stale.lastSeq });
    out(args, `已唤醒 PM 一次（原因 ${stale.reason}；未读 ${stale.unread} 条），随后重新计数`,
      { ok: true, project: name, ...stale, woke: true, wake });
    return;
  }
  fail('BAD_ARGS', `未知的 decision 子命令：${sub}（add|list|read|invite|ack|archive|stale-check）`);
}
