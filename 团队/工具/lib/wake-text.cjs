'use strict';
/**
 * T-20261117-204902-ca6b：唤醒「通知类」正文的**唯一来源**（团队工具 ESM 与壳层 CJS 共用）。
 *
 * 背景：`团队/工具/lib/dispatch.mjs`（ESM）与 `src/team-tools.js`（CJS）各写了一套「非派单通知」正文，
 * 语义一致但**非逐字一致**（壳内合并一行、无 AC 引用行、无正文件、口吻不同），tester 在 b6f9 复核时发现。
 *
 * 为什么用 .cjs：ESM 可以 `import` CJS（默认导入互操作），CJS 可以直接 `require`；反过来 ESM 不能被 CJS require
 * （Electron 33 = Node 20.18 不支持 require(ESM)）。所以唯一来源放在 CJS 侧，两端都能用。
 *
 * 口径（任一改动都同时影响两端，不再各写一套）：
 *   · 头部：`【团队消息 <id>】<subject>` + `<from> → <to> · 项目：<project>` + AC 引用行；
 *   · 正文：有 body 时截断 600 字并标「全文用 read --id」；
 *   · PM → 角色：按「需要判断/执行」呈现（先执行、纯知悉才回已读、判断不了回需要明确）；
 *   · 其它：回复/通知，不必新建任务。
 */

const AC_LINE = 'AC 引用：见需求正文 §验收标准（路径 + sha256）；version/change 指回需求正文当前版本。';
const BODY_LIMIT = 600;

function buildNoticePrompt({ to, project, messageId, subject, from = '', teamTool = '', body = '' }) {
  const id = String(messageId || '(缺 id)');
  const tool = teamTool ? `node "${teamTool}" ` : '';
  const excerpt = String(body || '').trim().slice(0, BODY_LIMIT);
  const fromText = from ? `${from} → ` : '';
  const head = `【团队消息 ${id}】${subject || ''}\n`
    + `${fromText}${to} · 项目：${project}\n`
    + `${AC_LINE}\n`
    + (excerpt ? `正文（已截断 ${BODY_LIMIT} 字，全文用 read --id ${id}）：\n${excerpt}\n` : '');
  if (from === 'pm' && to !== 'pm') {
    return head
      + '这是 PM 下发给你的消息：先判断——**需要你执行**就立即按正文做、做完发完成回执（不要只回“收到”）；\n'
      + '确属纯知悉（无动作要求）才可只回“已读”。判断不了的，回一行“需要明确”并说明卡点。\n'
      + `请按需读取：${tool}inbox --all，再 read --id ${id}。\n`
      + `最后只回一行：已执行 <做了什么> / 需处理 <卡点> / 已读 + ${id}。`;
  }
  return head
    + '这条是回复/通知，不是新派单；按需读取并按正常流程回执即可，不必为它新建任务。\n'
    + `请按需读取：${tool}inbox --all，再 read --id ${id}；需要回执时只 ack。\n`
    + `只回一行：已读/已回执 + ${id}。`;
}

module.exports = { buildNoticePrompt, AC_LINE, BODY_LIMIT };
