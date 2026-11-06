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
 */
export function buildDispatchPrompt({
  to, project, projectPath, roleDir, codeDir = '',
  messageId, subject, taskId = '', taskTitle = '', teamTool,
}) {
  const roleOut = path.join(projectPath, roleDir || '');
  const taskLine = taskId ? `任务：${taskId}${taskTitle ? ' ' + taskTitle : ''}` : '任务：见本条消息正文';
  const outputRule = codeDir
    ? `产出按纪律落盘：代码写 ${path.join(projectPath, codeDir)}（默认 site/**，以《项目信息.md》为准），设计/交接/回执写本角色目录 ${roleOut}；不写别人目录`
    : `产出写到本角色目录：${roleOut}（含 产出/），不写别人目录`;
  const steps = [
    `node "${teamTool}" boot --role ${to} --project "${project}"  # 记下令牌 T`,
    `inbox --boot <T> --all，再 read --boot <T> --id ${messageId}`,
    `ack --boot <T> --id ${messageId} --note "已回执：${taskId || '任务'} + 交付物 + 边界"  # 只表示已收到/已认领，不算完成`,
  ];
  if (taskId) steps.push(`task claim --boot <T> --id ${taskId}`);
  steps.push(`执行消息正文中的任务本身（正文没写清先问 PM，不要自己扩需求）；${outputRule}`);
  steps.push(`完成后先发完成回执：send --boot <T> --to pm --subject "已完成 ${taskId || messageId}" --body "执行结果 + 产出路径 + 证据"`);
  if (taskId) steps.push(`再 task done --boot <T> --id ${taskId} --evidence "产出路径/提交号/验证输出"  # 到这里才算已完成`);
  const numbered = steps.map((s, i) => `${i + 1}) ${s}`).join('\n');
  return `这是派单，不是通知：${messageId}（${subject}）。\n`
    + `${taskLine}\n`
    + `中文思考、中文回复、中文写文档；先读 ${path.join(projectPath, '项目铁律.md')}（每轮都读），再读 项目信息.md / 项目索引.md / 你的 文件索引.md 与 角色卡.md。\n`
    + `按顺序做完，不要只回“收到”：\n${numbered}\n`
    + `完成标准：有产出 + 完成回执 + ${taskId ? 'task done 证据' : '结果说明'}；已回执 ≠ 已完成，只 ack 不算完成。\n`
    + `最后只回一行：已完成/未完成 + 任务 id + 产出路径；不要输出方案，不要巡检全队。`;
}
