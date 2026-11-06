// Owner 在流程浮窗里的评审结果 → PM 收件箱（系统消息，不需要角色 boot 令牌）
import { sendMessage } from './lib/store.mjs';

const [project = '', decision = '', opinion = '', roundKey = ''] = process.argv.slice(2);
const label = { approved: '通过', skipped: '跳过评审', rejected: '打回' }[decision] || decision;
const subject = `Owner评审：${label}`;
const body = [
  `本轮 Owner 决定：${label}`,
  roundKey ? `轮次：${roundKey}` : '',
  opinion ? `Owner 意见：${opinion.slice(0, 500)}` : '',
  decision === 'rejected' ? '请回到需求/产品更新，再重新提交 Owner 评审。' : 'PM 可继续派发下一阶段。',
].filter(Boolean).join('\n');

try {
  const m = sendMessage({
    from: 'system', to: 'pm', subject, body, project,
    type: 'owner-review', ackRequired: true,
  });
  console.log(JSON.stringify({ ok: true, message: m }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
}
