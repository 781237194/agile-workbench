// 团队工作台 v2 · 派单唤醒模板（单一真相）
// 派单不是通知：唤醒后必须执行正文任务、把产出落盘、完成后回完成回执。
// ack 只代表“已回执/已认领”，task done --evidence 才代表“已完成”。
import path from 'node:path';

// selftest 与模板共用这些固定说法，防止文档、唤醒词、测试三套口径。
export const DISPATCH_MARKERS = {
  execute: '执行消息正文中的任务',
  output: '产出',
  completion: '完成回执',
  distinction: '已回执 ≠ 已完成',
  evidence: 'task done',
};

/**
 * B-20261113-210800-743e：唤醒/回执消息首行归属。
 * 目的：Owner 在 PM 会话里看到的消息必须一眼能分清“这是系统/角色发的，不是 Owner 本人”。
 * 统一格式：【系统消息·非Owner】来自 <角色中文名>（<消息类型>）→ <收件角色> ｜ 项目：<项目>
 */
export const WAKE_KIND_LABEL = {
  dispatch: '派单',
  receipt: '完成回执',
  notice: '通知',
  request: '请求',
  merge: '合并唤醒',
  system: '系统',
  // R-f8e1 F-4：评审打回与问询/答复/升级同表登记；未登记类型发送前必须拒绝（MSG_TYPE_UNKNOWN）。
  question: '问询',
  answer: '答复',
  escalation: '升级',
  review_reject: '评审打回',
  // R-c651 F-c651-3：唤醒重试 3 次仍失败 → 给 PM 的告警消息类型（与 review_reject 同表；未登记发送前拦截）。
  wake_failed: '唤醒失败',
  // R-b5fc F-4：同一 B-* 缺陷重开 ≥2 次时的升级消息（路由守护发出，PM 收）；未登记类型发送前拦截。
  bug_escalation: '缺陷升级',
  // R-9db6：Owner 决策箱回执（默认静默 --no-wake；只在防长期静默兜底时才唤醒 PM）。
  owner_decision_receipt: 'Owner决策回执',
  // R-703f F-1：会话用量到提醒阈值（默认 30 万）时的提醒消息；只提醒，不自动换人。
  session_rotate_warn: '会话轮换提醒',
};

/** 已登记的消息类型（发送前校验；不在表里的 --type 一律 MSG_TYPE_UNKNOWN）。 */
export const REGISTERED_MESSAGE_KINDS = Object.freeze(Object.keys(WAKE_KIND_LABEL));
export function isRegisteredKind(kind) {
  return REGISTERED_MESSAGE_KINDS.includes(String(kind || '').trim().toLowerCase());
}

export function buildWakeHeader({ fromName = '系统', kind = 'notice', toName = '', project = '', merged = 0 } = {}) {
  const who = merged > 0 ? `合并唤醒（${merged} 条）` : String(fromName || '系统');
  const kindText = merged > 0 ? '' : `（${WAKE_KIND_LABEL[kind] || kind || '通知'}）`;
  return `【系统消息·非Owner】来自 ${who}${kindText}→ ${toName || '收件人'} ｜ 项目：${project}`;
}

/** 合并唤醒里逐条标来源，保留主题与消息 id，避免“合起来就不知道谁发的”。 */
export function buildWakeLine({ fromName = '系统', kind = 'notice', toName = '', subject = '', messageId = '' } = {}) {
  return `- 【系统消息·非Owner】来自 ${fromName}（${WAKE_KIND_LABEL[kind] || kind || '通知'}）→ ${toName}：${subject || '（无主题）'}${messageId ? ` ｜ ${messageId}` : ''}`;
}

/**
 * 生成派单唤醒文本。
 * @param {object} p
 * @param {string} p.to 角色 id
 * @param {string} p.project 项目名
 * @param {string} p.projectPath 项目目录
 * @param {string} p.roleDir 本角色目录名（如 程序员A）
 * @param {string} [p.codeDir] 代码目录（开发角色传 site；其他角色留空）
 * @param {string} p.messageId 派单消息 id
 * @param {string} p.subject 派单主题
 * @param {string} [p.taskId] 任务 id
 * @param {string} [p.taskTitle] 任务标题
 * @param {string} p.teamTool team.mjs 绝对路径
 * @param {string[]} [p.readingList] 程序指定的本轮必读文件（相对项目目录）
 */
export function buildDispatchPrompt({
  to, project, projectPath, roleDir, codeDir = '',
  messageId, subject, taskId = '', taskTitle = '', teamTool, readingList = [],
}) {
  const roleOut = path.join(projectPath, roleDir || '');
  const taskLine = taskId ? `任务：${taskId}${taskTitle ? ' ' + taskTitle : ''}` : '任务：见本条消息正文';
  const outputRule = codeDir
    ? `产出按纪律落盘：代码写 ${path.join(projectPath, codeDir)}（默认 site/**，以《项目信息.md》为准）；另在本角色目录 ${roleOut}/产出/ 留 实现说明-vN.md 与 代码快照-vN/（与代码同哈希、版本递增、不覆盖旧版）；不写别人目录`
    : `产出写到本角色目录：${roleOut}（含 产出/，版本递增，不覆盖旧版），不写别人目录`
      + (to === 'analyst' ? `；需求正文仍写项目 需求/R-*.md，同时在 ${roleOut}/产出/ 留 需求分析-vN.md（写清场景/边界/验收/异常）` : '');
  const steps = [
    `node "${teamTool}" boot --role ${to} --project "${project}"  # 记下令牌 T`,
    `inbox --boot <T> --all，再 read --boot <T> --id ${messageId}`,
    `ack --boot <T> --id ${messageId} --note "已回执：${taskId || '任务'} + 交付物 + 边界"  # 只表示已收到/已认领，不算完成`,
  ];
  if (taskId) steps.push(`task claim --boot <T> --id ${taskId}`);
  steps.push(`执行消息正文中的任务本身（正文没写清先问 PM，不要自己扩需求）；${outputRule}`);
  steps.push(`收尾写记忆（R-8514）：project 1 条（任务 id + 产出路径 + 1–2 行进展）；长期约定/决策/踩坑提交 key 建议（仅 Owner 在记忆面板确认后生效）；密钥/隐私只记路径，不写值`);
  steps.push(`完成后先发完成回执：send --boot <T> --to pm --subject "已完成 ${taskId || messageId}" --body "执行结果 + 产出路径 + 证据"  # 回执不是派单，不要带 --ack/--task`);
  if (taskId) steps.push(`再 task done --boot <T> --id ${taskId} --evidence "产出路径/提交号/验证输出"  # 到这里才算已完成（P0 任务缺 project 记忆会被 MEMORY_MISSING 拒绝）`);
  const numbered = steps.map((s, i) => `${i + 1}) ${s}`).join('\n');
  const reading = Array.isArray(readingList) && readingList.length
    ? `\n本轮必读（程序指定，缺一不可）：${readingList.map((rel) => path.join(projectPath, rel)).join('；')}\n`
    : '';
  return `这是派单，不是通知：${messageId}（${subject}）。\n`
    + `${taskLine}\n`
    + `中文思考、中文回复、中文写文档；先读 ${path.join(projectPath, '项目铁律.md')}（每轮都读），再读 项目信息.md / 项目索引.md / 你的 文件索引.md 与 角色卡.md。\n`
    + reading
    + `按顺序做完，不要只回“收到”：\n${numbered}\n`
    + `完成标准：有产出 + 完成回执 + ${taskId ? 'task done 证据' : '结果说明'}；已回执 ≠ 已完成，只 ack 不算完成。\n`
    + `最后只回一行：已完成/未完成 + 任务 id + 产出路径；不要输出方案，不要巡检全队。`;
}

/**
 * 非派单唤醒：只提示“有新消息，去 inbox 读”，绝不生成派单流水线。
 * 完成回执、通知、请求都走这里，避免把“回执”误当成“给自己派单”。
 */
export function buildNoticePrompt({ to, project, messageId, subject, from = '', teamTool = '', body = '' }) {
  const tool = teamTool ? `node "${teamTool}" ` : '';
  // Owner 2026-11-14 08:44：唤醒正文直接带消息内容（subject + body，截断 600 字），不再只给 messageId。
  const excerpt = String(body || '').trim().slice(0, 600);
  return `【团队消息 ${messageId}】${subject}\n`
    + `${from ? from + ' → ' : ''}${to} · 项目：${project}\n`
    + (excerpt ? `正文（已截断 600 字，全文用 read --id ${messageId}）：\n${excerpt}\n` : '')
    + `这条是回复/通知，不是新派单；按需读取并按正常流程回执即可，不必为它新建任务。\n`
    + `请按需读取：${tool}inbox --all，再 read --id ${messageId}；需要回执时只 ack。\n`
    + `只回一行：已读/已回执 + ${messageId}。`;
}
