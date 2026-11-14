// Owner 在流程浮窗里的评审结果 → PM 收件箱（系统消息，不需要角色 boot 令牌）
// B-719f：写盘之后必须唤醒 PM——原来只 sendMessage 落盘，PM 不刷 inbox 就不知道 Owner 已拍板。
import { sendMessage } from './lib/store.mjs';
import { wakeMailboxRecipient } from './lib/ops.mjs';

const [project = '', decision = '', opinion = '', roundKey = ''] = process.argv.slice(2);
const label = { approved: '通过', skipped: '跳过评审', rejected: '打回' }[decision] || decision;
const subject = `Owner评审：${label}`;
const body = [
  `本轮 Owner 决定：${label}`,
  roundKey ? `轮次：${roundKey}` : '',
  opinion ? `Owner 意见：${opinion.slice(0, 500)}` : '',
  decision === 'rejected' ? '请回到需求/产品更新，再重新提交 Owner 评审。' : 'PM 可继续派发下一阶段。',
].filter(Boolean).join('\n');

const out = { ok: true, message: null, wake: null, warning: null };
try {
  out.message = sendMessage({
    from: 'system', to: 'pm', subject, body, project,
    type: 'owner-review', ackRequired: true,
  });
} catch (e) {
  out.ok = false;
  out.error = e.message;
}

if (out.ok) {
  // 邮箱已写入才唤醒：唤醒失败不影响“通知已经落盘”，但要如实回报（调用方记 warning）。
  try {
    out.wake = await wakeMailboxRecipient(project, 'pm', { reason: `owner-review:${decision || ''}`, subject, messageId: out.message.id });
  } catch (e) {
    out.wake = { ok: false, why: String((e && e.message) || e) };
  }
  if (!out.wake || out.wake.ok !== true) {
    out.warning = { code: 'OWNER_NOTE_WAKE_FAILED', message: `PM 通知已写入，但唤醒失败：${(out.wake && (out.wake.why || out.wake.code)) || '未知'}` };
  }
}

console.log(JSON.stringify(out));
