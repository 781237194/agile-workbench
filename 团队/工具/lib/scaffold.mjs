// 团队工作台 v2 · 项目脚手架
// 一个项目 = 按团队模式生成的角色目录（角色卡/文件索引/产出）+ 项目信息/铁律/索引/协作准则/README + 需求池 + 代码目录 + _tmp。
// team-mode=full：六角色目录；team-mode=fast：PM / 需求分析师 / 程序员A / 测试人员 四个目录。
// team.mjs project add|create|ensure 与 workspace.mjs 共用这份模板，避免出现两套项目文档。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS, exists, ensureDir, fail, nowIso, readText, writeText, sha256 } from './core.mjs';
import {
  LIMITS, MODEL_BY_ROLE, ROLE_DIRS, ROLE_NAMES, OUTPUT_DOCS, OUTPUT_DISCIPLINE,
  TEAM_MODE_LABELS, normalizeTeamMode, rolesForMode, teamModeDescription,
  techReviewers, votersForMode, VOTE_RULE_TEXT,
} from './roles.mjs';

export const DEFAULT_IRON = `# 项目铁律（默认版）

1. 中文思考、中文回复、中文写文档；代码标识/命令/路径可英文。
2. 只改本项目目录，出界先申请授权。
3. 不动 DSH_HOME、profiles、插件、外壳。
4. 不重启 DSH；底层改动必须全员签字。
5. 改动前只备份将被写的文件；不整目录备份。
6. 不写密钥、账号、私密内容，只记路径。
7. 每个结论给证据：哈希 / 路径 / 命令输出。
8. 派单必须带任务正文、产出目录、完成标准；ack=已回执（收到/认领），完成回执 + task done 证据=已完成。
9. **面向 Owner/PM 汇报用「人话 + 需求名」**：先说这是什么（需求名/功能名），再说现在到哪了，最后说要不要对方拍板；F-2、B-149a、G2.5 这类内部代号只能放括号里，不许单独出现。Owner 需要回头问“这是什么意思”即视为汇报不合格。
10. **不打断正在跑的任务**：角色会话 running 时不插新单、不改优先级；要插的单先记下，等这一轮收工再发。只有线上故障/数据损坏、或 Owner 明确说「立刻停」才打断；打断后必须由 PM 主动补发「继续原任务」，不靠对方记得。
`;

// ---------- 角色职责（按团队模式区分） ----------

export function roleDuty(role, mode = 'full') {
  const m = normalizeTeamMode(mode);
  if (m === 'fast') {
    const duties = {
      pm: '纯协调/传话：建需求条目与任务、派单、催回执、跟进完成、组织投票（vote start/status）、组织 Owner 决定（owner confirm/owner）与工作流轮次（workflow iterate/terminate）、填写项目信息、更新项目准则和索引；不做产品/架构/需求正文/开发/测试，不替别人写业务文件，不投票。',
      analyst: '需求分析与需求评审：需求拆解、场景拆解、可行性评估、验收标准、需求追踪矩阵，并在 fast 模式执行需求评审（req review）；需要驳回 Owner 需求时可按实际分析师身份发起投票（vote start，createdBy=analyst）；不写业务代码、不替 PM 派单、不替测试下结论。',
      programmer1: '开发（唯一）：只做本职——实现、单测、技术评审记录（req review --kind tech）、写 staged、propose、自测；不写需求、不定优先级、不下测试结论。',
      tester: '独立测试 + 投票：只做本职——测试计划/用例、回归、verify、缺陷闭环、对账复核，并按证据参与团队投票（vote cast）；另有**需求可测性评审（TR-Q）**：需求定稿+需求评审 approve 后、Owner 门之前，逐条判断 AC 可判定/证据形式/边界异常可复现，产出 `测试人员/产出/可测性评审-<需求id>-vN.md`（≤1 页，结论只有 可测/不可测（缺什么））；TR-Q 只评审不执行，不写测试计划/用例、不跑测试、不改需求 AC；不改业务代码、不定需求、不无证据签字。',
    };
    return duties[role] || '';
  }
  return {
    pm: '纯协调/传话：建需求条目与任务、派单、催回执、跟进完成、批复文件、组织 Owner 决定（owner confirm/owner）与工作流轮次（workflow iterate/terminate）、填写项目信息、更新项目准则和索引；不做产品/架构/需求正文/开发/测试，不替别人写业务文件。',
    product: '产品与架构：需求拆解评审、用户故事、流程图/类图、架构方案、竞品优劣势、优先级建议与验收；架构方案由产品主审，PM 复核双签；不写业务代码。',
    analyst: '需求分析：需求拆解与评审、场景拆解、可行性评估、场景缺陷闭环、验收标准、需求追踪矩阵；不写业务代码。',
    programmer1: '开发 A：只做本职——实现、单测、写 staged、propose、互审；不写需求、不定优先级、不下测试结论；不与 B 抢文件。',
    programmer2: '开发 B：只做本职——实现、单测、写 staged、propose、互审；不写需求、不定优先级、不下测试结论；不抢同一文件。',
    tester: '独立测试：只做本职——测试计划/用例、回归、verify、缺陷闭环、对账复核；另有**需求可测性评审（TR-Q）**：需求定稿+需求评审 approve 后、Owner 门之前，逐条判断 AC 可判定/证据形式/边界异常可复现，产出 `测试人员/产出/可测性评审-<需求id>-vN.md`（≤1 页，结论只有 可测/不可测（缺什么））；TR-Q 只评审不执行，不写测试计划/用例、不跑测试、不改需求 AC；不改业务代码、不定需求、不无证据签字。',
  }[role] || '';
}

function roleWriteScope(role) {
  if (role === 'pm') return '只写 `项目经理/` 和根目录《项目信息.md》《项目索引.md》《协作准则.md》；不改其他角色文件。';
  if (role === 'programmer1' || role === 'programmer2') {
    return '**代码写项目根代码目录，默认 `site/**`；不得写进角色目录。** 角色目录只放设计、交接、回执、文件索引和 `产出/`。';
  }
  return `只写 \`${ROLE_DIRS[role]}/\`（含 \`产出/\`）；跨目录只发请求，不直接改。`;
}

// 快速模式专属职责：写进角色卡，让 fast 的评审/技术评审/投票有明确执行人。
function modeDutyLines(role, mode) {
  if (normalizeTeamMode(mode) !== 'fast') return [];
  const lines = ['## 快速模式（fast）专属职责', ''];
  if (role === 'pm') {
    lines.push(
      '- **投票组织**：需要全员决定时 `vote start --boot <T> --subject "..." [--requirement R-...]`；需求分析师也可按实际身份发起（V 文件 `createdBy=analyst`）。用 `vote status --id V-...` 看票数与结论。PM 不投票，只组织与记录。',
      '- **需求评审**：fast 由需求分析师执行（`req review`）；PM 不能代评，也不能用评审结论代替 Owner 决定。',
      `- **投票规则**：${VOTE_RULE_TEXT}。`,
    );
  } else if (role === 'analyst') {
    lines.push(
      '- **需求评审**：fast 没有产品设计师，需求评审由你执行：`req review --boot <T> --id R-... --verdict approve|reject --comments "..."`。',
      '- **投票发起**：需要驳回 Owner 需求时，可用自己的 boot 令牌 `vote start --boot <T> --subject "..." --requirement R-...`；V 文件 `createdBy` 记实际分析师，PM 不投票。',
      '- 评审只对需求正文负责：场景、边界、验收标准、异常与风险；不替 PM 派单、不替测试下结论。',
      '- PM 不评审；其他角色不能用你的令牌代评。',
    );
  } else if (role === 'programmer1') {
    lines.push(
      '- **技术评审记录**：`req review --boot <T> --kind tech --id R-... --verdict approve|reject [--proposal P-...] --comments "..."`。',
      '- 技术评审只记录技术判断（选型/接口/数据/回滚/风险），不替代需求评审与测试报告。',
      `- **投票**：需要全员决定时按证据投票 \`vote cast --boot <T> --id V-... --vote approve|reject\`；规则：${VOTE_RULE_TEXT}。`,
    );
  } else if (role === 'tester') {
    lines.push(
      '- **可测性评审（TR-Q，Owner 门之前）**：需求定稿 + 需求评审 approve → 读需求与 AC → 逐条判断可判定性/证据形式/边界异常可复现 → 产出 `测试人员/产出/可测性评审-<需求id>-vN.md`（≤1 页；结论只有 `testable` / `not_testable` + 缺项清单）；命令 `req trq --boot <T> --id R-... --verdict testable|not_testable [--missing "..."]`。',
      '- **只评审不执行**：TR-Q 不写测试计划/用例、不跑测试、不改需求与 AC；结论不可测只退回需求分析师修订。',
      '- **两职能分开**：TR-Q 在 Owner 门之前；交付验收报告（`测试报告-vN.md` + `证据/`）在测试之后，两份记录的文件、状态、时间都不同。fast 不因没有产品而跳过 TR-Q。',
      '- **闸门**：P0 未 `testable` 时 Owner 门被拒（`TESTABILITY_REVIEW_REQUIRED`）；P1 未做标 optional-missing，不阻门但要在需求行标注。',
      '- **投票**：`vote cast --boot <T> --id V-... --vote approve|reject [--comment "..."]`；只按测试证据投票，没看报告不投赞成。',
      `- **投票规则**：${VOTE_RULE_TEXT}。`,
    );
  }
  lines.push('');
  return lines;
}

/** 子代理边界：只写“可开/不可外包”，避免角色拿子代理绕过回执、评审与签字。 */
export function subagentAllow(role) {
  return ({
    pm: '只读巡检、对账取数、索引/看板摘要、多项目状态汇总',
    product: '竞品/资料检索、用户故事与流程图草案、验收标准草案',
    analyst: '场景枚举、边界/异常清单、需求正文初稿',
    programmer1: '只读代码检索、单测用例草案、构建/静态检查、截图对比',
    programmer2: '只读代码检索、单测用例草案、构建/静态检查、截图对比',
    tester: '独立复现、截图/录屏、对账数据整理',
  })[role] || '只读资料整理';
}

export function subagentDeny(role) {
  return ({
    pm: '派单、签字、验收、Owner 决定',
    product: '最终评审结论、架构取舍、签字',
    analyst: '需求正文定稿、req review、签字',
    programmer1: '写代码、提案、互审结论、apply',
    programmer2: '写代码、提案、互审结论、apply',
    tester: '测试结论、缺陷定级、签字',
  })[role] || '签字、验收、评审结论';
}

/**
 * 测试人员角色卡固定一节：可测性评审（TR-Q）与交付验收两职能分开（R-453c AC16.6）。
 * 六人/四人都生成这一节，fast 不因没有产品而跳过 TR-Q。
 */
function testerTrqSection() {
  return [
    '## 可测性评审（TR-Q）与交付验收（两件事）',
    '',
    '| 职能 | 时机 | 产出 | 闸门 | 不做 |',
    '|---|---|---|---|---|',
    '| 可测性评审 TR-Q | 需求定稿 + 需求评审 approve 之后、Owner 门之前 | `测试人员/产出/可测性评审-<需求id>-vN.md`（≤1 页，结论 `testable` / `not_testable` + 缺项清单） | G2.5：P0 未 `testable` → Owner 门不开（`TESTABILITY_REVIEW_REQUIRED`）；P1 未做标 optional-missing，不阻门 | 不写测试计划/用例、不执行测试、不改需求与 AC |',
    '| 交付验收 | 开发/测试完成之后、Owner 验收之前 | `测试人员/产出/测试报告-vN.md` + `证据/` | G7：报告要覆盖需求，PASS/FAIL 明确 | 不改代码、不代签 |',
    '',
    '- 命令：`req trq --boot <T> --id R-... --verdict testable|not_testable [--missing "缺项"]`；只有测试人员本人能记录，PM 不能代写、子代理不能代评。',
    '- 记录字段：需求 id、依据需求哈希、版本、评审人、时间、结论、缺项、文件路径；同时写工作流行 `trq`。',
    '- 需求修订后旧 TR-Q 失效（需求哈希不一致），必须重做；不追认旧结论。',
    '',
  ].join('\n');
}

export function roleCard(projectName, role, mode = 'full') {
  const m = normalizeTeamMode(mode);
  const model = MODEL_BY_ROLE[role];
  const outSpec = OUTPUT_DOCS[role];
  const outHint = outSpec
    ? `- 输出模板：\`团队\\工具\\模板\\角色产出\\${outSpec.file}\` → 复制到 \`${outSpec.dir}/产出/\`，把 vN 改成版本号（每次实质变更 +1）；字段限长见区块标题，超限即停止（截断并标记），不扩写。\n`
    : `- 本角色无 01~04 结构化模板；回执/评审/日志仍按一句话格式。\n`;
  return `# ${ROLE_NAMES[role] || role} · 角色卡\n\n`
    + `- 项目：${projectName}\n- 角色 id：${role}\n`
    + `- 团队模式：${TEAM_MODE_LABELS[m]}（${teamModeDescription(m)}）\n`
    + `- **语言纪律：中文思考、中文回复、中文写文档；代码标识/命令/路径可英文。**\n`
    + (model ? `- 固定模型：${model.provider}/${model.model}${model.reasoningEffort ? '（推理 ' + model.reasoningEffort + '）' : ''}\n` : '- 模型：使用工作区默认模型\n')
    + `- 写入范围：${roleWriteScope(role)}\n`
    + `- **路径纪律：所有交付文件必须写在当前项目目录内。禁止写 \`%TEMP%\`、桌面或 C 盘根目录。临时文件放项目 \`_tmp/\`，交付前清理。**\n`
    + `- 代码目录以《项目信息.md》的“代码目录”为准；未写时默认 \`site/\`。\n`
    + `- 文件上限：Markdown/TXT ≤ ${LIMITS.docMaxBytes} 字节；代码 ≤ ${LIMITS.codeMaxBytes} 字节。\n\n`
    + `## 职责\n\n${roleDuty(role, m)}\n\n`
    + modeDutyLines(role, m).join('\n')
    + (role === 'tester' ? testerTrqSection() : '')
    + `## 结构化输出（豆包协议）\n\n`
    + `- ${OUTPUT_DISCIPLINE}。\n`
    + `- 输出即结果：本角色交付物就是一份结构化 MD，不写开场白、不总结感想；上游内容只写路径 + 版本号，不重复贴入。\n`
    + outHint
    + `- 他人产出一律用 \`team.mjs brief --role <角色> --project <项目> --section <区块>\` 提取指定区块，禁止全文通读。\n\n`
    + `## 每轮动作\n\n`
    + `0. **每轮第一件事：读根目录《项目铁律.md》（每轮都读，不靠记忆）**；再判断是否有自己的任务。\n`
    + `1. 只有被${role === 'pm' ? 'Owner' : 'PM 按任务'}叫到才启动；先读根《项目信息.md》《项目索引.md》，再读本目录《文件索引.md》《角色卡.md》和《协作准则.md》。\n`
    + `2. 被叫到后先 boot，再回一条确认：角色 id、任务 id、交付物、边界/依赖；随后 **ack 回执（只算已回执，不算完成）**，不能只回确认。\n`
    + `3. **执行消息正文中的任务**；产出写到本角色目录（开发代码写代码目录），不写别人目录；完成后发完成回执（结果+路径+证据）并 \`task done --evidence\`，这才算已完成。\n`
    + `3.5 **每轮在 \`产出/\` 留版本**：${role === 'programmer1' || role === 'programmer2' ? '开发写 `实现说明-vN.md` + `代码快照-vN/`（与 site 同哈希）' : role === 'tester' ? '测试写 `测试报告-vN.md` + `证据/`' : role === 'analyst' ? '需求写 `需求分析-vN.md`（需求正文仍写 需求/R-*.md）' : '产品写 `产品设计-vN.md`'}；版本递增，不覆盖历史。\n`
    + `3.6 **每轮写记忆（R-8514）**：收尾写 1 条 project 记忆（任务 id + 产出路径 + 1–2 行进展）；P0 任务必写，缺失时 task done 会被拒（MEMORY_MISSING）。\n`
    + `3.7 **长期事实只走 key 建议**：约定/决策/踩坑提交 key 建议，待 Owner 在记忆面板确认后生效；密钥/隐私只记路径，不写值。\n`
    + `4. 分析或实现后，先互评与回执；负责人确认后才更新本目录文件与索引。\n`
    + `5. 回执 ≤ ${LIMITS.ackNoteMaxChars} 字，评审意见 ≤ ${LIMITS.reviewCommentMaxChars} 字，不写长文汇报。\n`
    + `6. 所有回执、评审、签字和提交都要能被团队看板查到。\n`
    + `7. 提交/回执只写一句 ≤160 字日志（对象+动作+单号/时间）。\n`
    + `8. **子代理**：可开——${subagentAllow(role)}；不可外包——${subagentDeny(role)}。子代理只回结论 ≤300 字 + 产出路径，过程写文件；主角色复核后才算产出。\n`
    + (role === 'pm'
      ? `\n## 叫醒角色模板\n\n**先完成《项目信息.md》和任务分配，再叫角色；没写清不要叫。**\n\nPM 叫角色时只发这一段（替换占位）：\n\n> 任务 <任务id>；先读 项目信息.md、项目索引.md、你的 文件索引.md 和 角色卡.md；回“角色 id + 任务 id + 交付物 + 边界”确认，并 **ack 回执（只算已回执）**。随后执行本条正文任务，产出写 <本角色目录>；完成后发完成回执 + task done --evidence（才算已完成）。目标文件：<路径>。\n\n发送时带 --ack；**一次只发一个人，发完停，等回执再发下一个。**\n`
      : '');
}

export function roleIndex(role) {
  return `# ${ROLE_DIRS[role] || ROLE_NAMES[role] || role} · 文件索引\n\n`
    + `> 由 ${ROLE_NAMES[role] || role} 在分析、协同、回执确认后更新。其他成员先读本索引，再读具体文件。\n`
    + `> 单文件 ≤ ${LIMITS.docMaxBytes} 字节；索引只列当前有效文件，不堆历史副本。\n\n`
    + `| 文件 | 用途 | 状态 |\n|---|---|---|\n`
    + `| 角色卡.md | 职责、写权限、模型与文件限制 | 有效 |\n`;
}

export function collaborationRules(projectName, mode = 'full') {
  const m = normalizeTeamMode(mode);
  const roles = rolesForMode(m);
  const fast = m === 'fast';
  const roleTable = roles.map((r) => `| ${ROLE_NAMES[r]} | ${ROLE_DIRS[r]}/ | ${roleDuty(r, m)} | ${MODEL_BY_ROLE[r] ? MODEL_BY_ROLE[r].provider + '/' + MODEL_BY_ROLE[r].model : '默认'} |`).join('\n');
  return `# ${projectName} · ${fast ? '四角色' : '六角色'}协作准则\n\n`
    + `> 由项目经理维护；涉及修改先互评、回执，再更新。根索引与准则是项目入口，不是闲聊记录。\n`
    + `> 团队模式：${TEAM_MODE_LABELS[m]}（${teamModeDescription(m)}）；目录、角色卡与结构校验都按本模式生成。\n\n`
    + `- **语言纪律**：所有角色中文思考、中文回复、中文写文档；代码标识、命令、路径可英文。\n`
    + (fast
      ? `- **分工**：PM 建需求/建任务/派单/跟进完成/组织投票；需求分析师负责拆解与需求评审；程序员A 负责实现/单测/技术评审记录；测试人员只验证/对账/签字/投票。\n\n`
      : `- **分工**：PM 建需求/建任务/派单/跟进完成；产品、需求分析师负责拆解与评审；开发只实现/单测/提案，测试只验证/对账/签字。\n\n`)
    + `## 〇、启动顺序（先看这条）\n\n`
    + `- 新建/导入只建**空会话**，禁止给${fast ? '四' : '六'}个人同时发启动卡。\n`
    + `- Owner 先直接向 PM 说：项目目标、使用场景、要交付什么、不做什么；PM 不猜需求。\n`
    + `- **PM 先写《项目信息.md》**（目标/场景/交付/边界/任务分配），再建需求与任务；项目信息没写清前不叫其他角色。\n`
    + `- **PM 一次只能发一个角色**：send --ack 后停手，等对方 ack；未回执不得派下一个。\n`
    + `- 唤醒消息必须带任务 id、任务正文、项目信息/角色卡路径、产出目录、目标文件、完成标准，不重复贴全量职责。\n`
    + `- 角色每轮第一件事先读《项目铁律.md》（每轮都读，不靠上下文记忆），再读《项目信息.md》《项目索引.md》、本目录《文件索引.md》《角色卡.md》。\n`
    + `- 角色被 PM 叫到后先 boot（boot 会读齐铁律/信息/角色卡/索引/需求并返回 read 证据），再回“角色 id + 任务 id + 交付物 + 边界”确认身份，并 ack 回执（只算已回执）。\n`
    + `- **路径纪律**：交付文档写当前项目内对应角色目录；程序员代码写项目根 \`site/**\`。临时文件放项目 \`_tmp/\`，交付前清理。\n\n`
    + `## 〇·二、阶段闸门与回执链\n\n`
    + (fast
      ? `- 快速模式流程（见 \`团队\\流程.md\`）：PM接单 → 需求 → 需求评审（需求分析师 \`req review\`） → **需求可测性评审 TR-Q（测试人员 \`req trq\`）** → 技术评审记录（程序员A \`req review --kind tech\`） → Owner评审（可选） → PM 派开发 → 测试 → 投票（vote） → PM 收口 → 迭代。\n`
      : `- 完整流程见 \`团队\\流程.md\`：PM接单 → 需求 → 产品/架构评审 → **需求可测性评审 TR-Q（测试人员 \`req trq\`）** → Owner评审（可选） → PM 派开发 → A/B 互审/对账 → 测试 → PM 收口 → 迭代。\n`)
    + `- Owner 的任何新需求都直接向 PM 提；PM 必须让 Owner 选择“跳过评审/开始评审”，并记录后才派程序员。\n`
    + `- **PM 一次只发一个 --ack 派单**；派单锁未清不得派下一个；角色必须执行正文任务并把产出写进本角色目录，完成回执 + task done 证据才等于完成；只 ack 算未完成。\n\n`
    + `## 一、${fast ? '四个' : '六个'}角色\n\n`
    + `| 角色 | 目录 | 主要职责 | 模型 |\n|---|---|---|---|\n`
    + roleTable
    + `\n\n`
    + `## 二、主流程（每轮照做）\n\n`
    + `1. **先索引**：每轮先读《项目铁律.md》，再读《项目信息.md》《项目索引.md》、角色目录《文件索引.md》和《角色卡.md》，然后才读任务指定文件。\n`
    + `2. **派单**：PM 先把 Owner 需求写成《项目信息.md》，再建需求/任务；${fast ? '需求分析师给优先级建议，PM 终审' : '产品给优先级建议，PM 终审'}。重要消息要求回执。\n`
    + `3. **认领**：负责人只认领自己的任务，先 read，后 ack（已回执）；执行正文任务、产出落盘、完成回执 + task done 才算完成。\n`
    + (fast
      ? `4. **分析与实现**：需求分析师做需求+需求评审，程序员A 实现并记录技术评审，测试人员独立验证；需要全员决定时走投票（vote）。\n`
      : `4. **分析与实现**：产品做产品+架构，需求做场景/可行性/缺陷闭环，程序员 A/B 分工开发，测试独立验证。\n`)
    + `5. **互评**：normal 至少一名非作者评审 + PM 签字；作者不能审自己。\n`
    + `6. **提交**：只走 propose → show → review → sign → apply。签字绑定 proposalHash + baseHash。\n`
    + `7. **负责人更新**：确认后更新自己目录的产物与《文件索引.md》；PM 在每次 apply 后重新生成根《项目索引.md》。\n`
    + `8. **对账**：PM 跑 reconcile，测试独立 verify 并复核。看板必须能查到回执、评审、签字和提交。\n\n`
    + `## 三、需求文件规则（防上下文爆炸）\n\n`
    + `- 《需求/00-需求总览.md》只是目录：需求 id、文件、优先级、状态、负责人、验收、更新时间；不写需求正文。\n`
    + `- **一个需求一个文件**：\`需求/R-YYYYMMDD-xxxx-标题.md\`；新需求新建，澄清/补充更新原文件。\n`
    + `- 单文件 ≤ 16KB；超了就拆成子需求/子场景，并在总览里保留父子关系。\n\n`
    + `## 四、需求评审 / 技术评审（命令）\n\n`
    + `- 需求评审：\`req review --boot <T> --id R-... --verdict approve|reject --comments "..."\`；${fast ? 'fast 由需求分析师执行' : 'full 由产品设计师执行'}，PM 不评审，其他角色不能代评。\n`
    + `- 技术评审记录：\`req review --boot <T> --kind tech --id R-... [--proposal P-...] --verdict approve|reject --comments "..."\`；执行人：${techReviewers(m).map((r) => ROLE_NAMES[r]).join(' / ')}。\n`
    + `- 评审记录落盘：\`团队\\状态\\项目\\<项目>\\需求评审\\\` 与 \`技术评审\\\`（JSON），同时写任务评审字段与事件链；评审结论只对同一需求版本负责。\n\n`
    + `## 四·二、Owner 决定 / 验收 / 工作流轮次\n\n`
    + `- Owner 是外部角色、没有 boot：先在真实终端 \`owner confirm --project <P> --requirement R-... --decision ...\` 签发一次性确认码，再 \`owner --project <P> --requirement R-... --decision ... --opinion "..." --owner-confirm <确认码>\` 落账。\n`
    + `- Owner 验收：\`owner --action accept --decision accepted|rejected\`；该需求名下测试任务必须全部 done，accepted 才收口需求。\n`
    + `- PM 推进轮次：\`workflow iterate --boot <T> --project <P> --opinion "..."\`；终止：\`workflow terminate --boot <T> --project <P> --opinion "..."\`。两者都写共享 \`工作流.json\`，不另造状态。\n\n`
    + `## 四·三、需求可测性评审（TR-Q）\n\n`
    + `- **时机**：需求定稿 + 需求评审 approve 之后、Owner 门之前；顺序不可跳过。\n`
    + `- **执行人**：测试人员本人；PM 只能派单，不能代评；子代理不能代评。六人、四人都一样，fast 不因没有产品跳过。\n`
    + `- **评什么**：逐条 AC 是否可判定、证据形式是否够、边界/异常是否可复现；不评方案/架构/实现路线。\n`
    + `- **产出**：\`测试人员/产出/可测性评审-<需求id>-vN.md\`（≤1 页）；结论只有“可测（testable）/ 不可测（not_testable，列缺项）”。\n`
    + `- **命令**：\`req trq --boot <T> --id R-... --verdict testable|not_testable [--missing "缺项"]\`，同时写工作流行 \`trq\`。\n`
    + `- **闸门 G2.5**：P0 未 \`testable\` → Owner 门不开（\`TESTABILITY_REVIEW_REQUIRED\`）；P1 未做标 optional-missing，不阻门。\n`
    + `- **只评审不执行**：不写测试计划/用例、不跑测试、不改需求与 AC；不可测只退回需求分析师，修订后旧 TR-Q 失效、必须重做。\n`
    + `- **两职能分开**：TR-Q（Owner 前）与交付验收报告（测试后，\`测试报告-vN.md\` + \`证据/\`）是两份记录，文件/状态/时间不同。\n\n`
    + `## 五、投票（vote）\n\n`
    + `- PM 或需求分析师发起：\`vote start --boot <T> --subject "..." [--kind requirement|change|other] [--requirement R-...] [--proposal P-...]\`；V 文件 \`createdBy\` 记实际发起角色；PM 不投票。\n`
    + `- 参与人：${votersForMode(m).map((r) => ROLE_NAMES[r]).join('、')}（除 PM 外全体）。投票：\`vote cast --boot <T> --id V-... --vote approve|reject [--comment "..."]\`。\n`
    + `- ${VOTE_RULE_TEXT}。\n`
    + `- 投票文件：\`团队\\状态\\项目\\<项目>\\投票\\V-....json\`（真相）+ 同名 \`.md\`（人读）；壳层用 \`vote status --id V-...\` 读取，不读私有状态。\n\n`
    + `## 六、锁与版本栅栏\n\n`
    + `- 锁只防同时写；不能防两个会话抱着旧文件互相点头。\n`
    + `- 提案必须带 baseHash，apply 必须 CAS；目标已变 = STALE_BASE，重读、重提、重审、重签。\n`
    + `- 失败即停：锁冲突、CAS 失败、缺评审、缺签字、校验失败都不许绕过。\n\n`
    + `## 七、文件与 token 上限\n\n`
    + `- 单条消息 ≤ ${LIMITS.messageMaxChars} 字；回执 ≤ ${LIMITS.ackNoteMaxChars} 字；评审意见 ≤ ${LIMITS.reviewCommentMaxChars} 字；boot 简报 ≤ ${LIMITS.bootBriefMaxChars} 字。\n`
    + `- Markdown/TXT 单文件 ≤ ${LIMITS.docMaxBytes} 字节；代码 ≤ ${LIMITS.codeMaxBytes} 字节；角色索引 ≤ ${LIMITS.roleIndexMaxBytes} 字节。\n\n`
    + `## 八、风险与测试\n\n`
    + `- normal：非作者评审 + PM 签字。\n`
    + (fast
      ? `- 技术评审记录：程序员A 记录；需求评审：需求分析师执行；两者都不能替代测试证据。\n`
      : `- 架构/产品方案：产品主审并签字 + PM 复核双签。\n`)
    + `- sensitive/critical：${roles.length} 角色评审与签字 + owner 终端批准；critical 还要备份和回滚演练。\n`
    + `- 测试人员必须独立验证，开发不能自己给自己出测试结论。\n\n`
    + `## 九、提交与回执日志\n\n`
    + `- 每次 apply 带 --log、每次回执带 --note，写**一句话**（建议 ≤160 字）：对象 + 动作 + 单号/时间。\n`;
}

export function projectInfo(projectName, desc = '', mode = 'full') {
  const m = normalizeTeamMode(mode);
  const roles = rolesForMode(m);
  const roleDirs = roles.map((r) => `\`${ROLE_DIRS[r]}/\``).join('、');
  return `# ${projectName} · 项目信息\n\n`
    + `> **由项目经理根据 Owner 需求填写，角色只读。** 没写清前，PM 不叫其他角色。\n`
    + `> 每轮先读《项目铁律.md》，再读本文件，然后读角色卡与项目索引。\n`
    + `> 团队模式：${TEAM_MODE_LABELS[m]}（${teamModeDescription(m)}）。\n\n`
    + `## 一、项目目标\n\n${desc ? desc + '\n' : '（待 PM 填写：这个项目到底要做什么、为什么做）'}\n\n`
    + `## 二、使用场景与用户\n\n（待 PM 填写：谁用、在什么场景用、现有替代方案）\n\n`
    + `## 三、交付物与代码目录\n\n（待 PM 填写：要交付的页面/接口/文档/测试报告）\n\n`
    + `- 代码目录（程序员写这里，默认 \`site/\`）：\`site/\`\n`
    + `- 角色文档目录：${roleDirs}；临时文件放 \`_tmp/\`。\n\n`
    + `## 四、不做什么 / 边界\n\n（待 PM 填写：明确排除项，防止角色自行扩需求）\n\n`
    + `## 五、任务分配\n\n| 任务 id | 角色 | 交付物 | 依赖 | 验收 |\n|---|---|---|---|---|\n| （待填） | | | | |\n\n`
    + `## 六、期限与约束\n\n（待 PM 填写：截止时间、技术/成本/合规约束）\n\n`
    + `## 七、角色确认记录\n\n| 角色 | 已读项目信息 | 已确认角色卡 | 确认时间 |\n|---|---|---|---|\n`
    + roles.map((r) => `| ${ROLE_NAMES[r]} | | | |`).join('\n') + '\n';
}

export function reqOverview(projectName) {
  return `# ${projectName} · 需求总览（目录）\n\n`
    + `> **这是需求目录，不是需求正文。** 一个需求一个 \`R-...md\`；新需求新建文件，澄清/补充更新原文件；单文件 ≤ 16KB。\n\n`
    + `| 需求 id | 文件 | 优先级 | 状态 | 负责人 | 验收 | 更新时间 |\n`
    + `|---|---|---|---|---|---|---|\n`
    + `| （待登记） | | | | | | |\n`;
}

export function reqTemplate(projectName) {
  return `# R-YYYYMMDD-xxxx · 需求标题\n\n`
    + `> 单个需求文件；≤ 16KB。新需求复制本模板另存为 \`R-...md\`，不要把所有需求堆进一个文件。\n\n`
    + `## 场景 / 用户\n\n（谁、在什么场景、要解决什么）\n\n`
    + `## 目标 / 不做什么\n\n（边界；明确排除项）\n\n`
    + `## 验收标准\n\n（可测试、可判定）\n\n`
    + `## 依赖 / 风险\n\n（上下游、数据、权限、时间）\n\n`
    + `## 关联任务\n\n（T-... / 提案 / 文件）\n\n`
    + `## 变更记录\n\n| 时间 | 变更 | 负责人 | 提案/提交 |\n|---|---|---|---|\n`;
}

export function reqPoolReadme(mode = 'full') {
  const m = normalizeTeamMode(mode);
  return `# 需求池\n\n**一个需求一个 R-...md，不要把所有需求堆进一个文件。** ${m === 'fast' ? '需求分析师维护需求正文、验收标准与需求评审；' : '需求分析师维护需求正文与验收标准；产品维护优先级建议；'}PM 维护需求总览和项目索引。\n`;
}

export function rootReadme(projectName, desc = '', mode = 'full') {
  const m = normalizeTeamMode(mode);
  return `# ${projectName}\n\n${desc || `${TEAM_MODE_LABELS[m]}协同项目（团队工作台创建）。`}\n\n`
    + `先读顺序：[项目铁律.md](项目铁律.md) → [项目信息.md](项目信息.md) → [项目索引.md](项目索引.md) → [协作准则.md](协作准则.md) → 各角色目录的 文件索引.md。\n\n`
    + `- 团队模式：${TEAM_MODE_LABELS[m]}（${teamModeDescription(m)}）。\n`
    + `- 代码写 \`site/\`（或项目信息指定目录）；临时文件放 \`_tmp/\`，交付前清理。\n`
    + `- 变更只走 propose → show → review → sign → apply；没有回执 = 没发生。\n`;
}

export function rootIndex(projectName, mode = 'full') {
  const m = normalizeTeamMode(mode);
  const dirs = rolesForMode(m).map((r) => ROLE_DIRS[r]);
  return `# ${projectName} · 项目索引（目录）\n\n`
    + `> 由 \`team.mjs index\` 自动重建；**这是目录，不是项目介绍或需求正文**。\n`
    + `> 先读顺序：项目铁律 → 项目信息 → 项目索引 → 角色卡/文件索引 → 任务指定文件。\n\n`
    + `<!-- 人工说明:BEGIN -->\n`
    + `- 项目信息：[项目信息.md](项目信息.md)（PM 先填，角色后读）\n`
    + `- 项目铁律：[项目铁律.md](项目铁律.md)（每轮必读）\n`
    + `- 协作准则：[协作准则.md](协作准则.md)\n`
    + `- 需求目录：[需求/00-需求总览.md](需求/00-需求总览.md)\n`
    + `- 角色目录：${dirs.map((d) => `${d}/`).join('、')}、需求/\n`
    + `<!-- 人工说明:END -->\n`;
}

export function codeReadme(projectName, mode = 'full') {
  const m = normalizeTeamMode(mode);
  return `# ${projectName} · 代码目录\n\n${m === 'fast' ? '程序员A 的代码写这里' : '程序员 A/B 的代码写这里'}，不写进角色目录。默认入口：index.html / styles.css / main.js。\n`;
}

// ---------- 读取记录（read 证据） ----------

/** 读一个文件并留下证据：绝对路径、相对路径、大小、哈希、更新时间、摘录。缺失就是缺失，不编造。 */
export function readDocRecord(file, rel = '') {
  const record = { key: '', label: '', path: file, rel, exists: false, size: 0, hash: '', updatedAt: '', excerpt: '', required: true };
  if (!file) return record;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return record;
    const buffer = fs.readFileSync(file);
    record.exists = true;
    record.size = stat.size;
    record.updatedAt = stat.mtime.toISOString();
    record.hash = crypto.createHash('sha256').update(buffer).digest('hex');
    record.excerpt = buffer.toString('utf8', 0, Math.min(200, buffer.length)).replace(/\s+/g, ' ').trim();
  } catch { /* 缺失就是缺失 */ }
  return record;
}

// 需求文件名：R-YYYYMMDD-序号-标题.md；序号 4~6 位都收（模板用 4 位，旧工具曾按 6 位）。
const REQ_FILE_RE = /^R-\d{8}-\d{4,6}(?:-[0-9a-f]{2,8})?/i;

/**
 * 需求正文“内容文本”：去掉机器维护的元数据（`- 状态：` 行与 `## 状态记录` 区），
 * 只留标题/场景/验收标准等正文。状态是程序自己改的，不该定期把角色的阅读证据作废。
 */
export function requirementContentText(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const out = [];
  let inStatusSection = false;
  for (const line of lines) {
    if (/^##\s+状态记录/.test(line)) { inStatusSection = true; continue; }
    if (inStatusSection && /^##\s+/.test(line)) inStatusSection = false;
    if (inStatusSection) continue;
    if (/^- 状态：/.test(line)) continue;
    out.push(line.replace(/\s+$/, ''));
  }
  return out.join('\n').trim();
}

/** 项目 需求/ 下的全部 R-*.md：boot 一次读齐并记哈希；新增/改内容后本轮视为过期。 */
export function readRequirementDocs(root) {
  const dir = path.join(root, '需求');
  const list = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { names = []; }
  for (const name of names) {
    if (!/\.md$/i.test(name)) continue;
    const match = name.match(REQ_FILE_RE);
    if (!match) continue;
    const file = path.join(dir, name);
    const record = readDocRecord(file, '需求/' + name);
    if (!record.exists) continue;
    let contentHash = '';
    try { contentHash = sha256(requirementContentText(fs.readFileSync(file, 'utf8'))); } catch { contentHash = ''; }
    list.push({ id: match[0], file: record.path, rel: record.rel, hash: record.hash, contentHash, size: record.size });
  }
  list.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-Hans-CN'));
  const hash = crypto.createHash('sha256').update(JSON.stringify(list.map((row) => [row.rel, row.hash]))).digest('hex');
  const contentHash = crypto.createHash('sha256').update(JSON.stringify(list.map((row) => [row.rel, row.contentHash]))).digest('hex');
  return { list, hash, contentHash, count: list.length };
}

/**
 * boot 必读清单，顺序即协议：团队宪法 → 项目铁律 → 项目信息 → 角色卡 → 项目索引 → 需求总览 → 协作准则。
 * 必读分两层：core=true 的 4 份是核心必读（缺一份 boot 直接 MISSING_DOC）；
 * 其余为按需文档（读得到就带进 read 证据，读不到在简报里列“未读”，不冒充已读）。
 * 第二层“任务相关”由 store.readDocSet 按本人未完成任务动态带入（需求正文 + 上游产出）。
 */
export function bootDocSpecs(root, roleDirName) {
  const base = path.resolve(root);
  const role = roleDirName || '';
  return [
    { key: 'constitution', label: '团队宪法', path: path.join(PATHS.teamRoot, '团队宪法.md'), rel: '团队宪法.md', required: true, core: true },
    { key: 'iron', label: '项目铁律', path: path.join(base, '项目铁律.md'), rel: '项目铁律.md', required: true, core: true },
    { key: 'projectInfo', label: '项目信息', path: path.join(base, '项目信息.md'), rel: '项目信息.md', required: true, core: true },
    { key: 'roleCard', label: '角色卡', path: role ? path.join(base, role, '角色卡.md') : '', rel: role ? `${role}/角色卡.md` : '', required: true, core: true },
    { key: 'roleIndex', label: '角色文件索引', path: role ? path.join(base, role, '文件索引.md') : '', rel: role ? `${role}/文件索引.md` : '', required: false },
    { key: 'projectIndex', label: '项目索引', path: path.join(base, '项目索引.md'), rel: '项目索引.md', required: true },
    { key: 'requirementOverview', label: '需求总览', path: path.join(base, '需求', '00-需求总览.md'), rel: '需求/00-需求总览.md', required: true },
    { key: 'collaboration', label: '协作准则', path: path.join(base, '协作准则.md'), rel: '协作准则.md', required: false },
  ];
}

// ---------- 结构检查 / 补齐 ----------

const ROOT_FILES = [
  ['README.md', (name, desc, mode) => rootReadme(name, desc, mode)],
  ['协作准则.md', (name, desc, mode) => collaborationRules(name, mode)],
  ['项目信息.md', (name, desc, mode) => projectInfo(name, desc, mode)],
  ['项目索引.md', (name, desc, mode) => rootIndex(name, mode)],
];

function requiredPaths(mode = 'full') {
  const out = ['README.md', '项目信息.md', '项目铁律.md', '项目索引.md', '协作准则.md', '需求/00-需求总览.md', '_tmp', 'site', '需求'];
  for (const role of rolesForMode(mode)) {
    const dir = ROLE_DIRS[role];
    out.push(dir, `${dir}/角色卡.md`, `${dir}/文件索引.md`, `${dir}/产出`);
  }
  return out;
}

/** 只读检查：按团队模式检查角色目录 + 项目文档是否齐全；不写任何文件。 */
export function structureReport(root, { teamMode = 'full' } = {}) {
  const m = normalizeTeamMode(teamMode);
  const base = path.resolve(String(root || ''));
  const missing = [];
  for (const rel of requiredPaths(m)) {
    if (!exists(path.join(base, rel.replace(/\//g, path.sep)))) missing.push(rel);
  }
  const docs = {};
  for (const [key, rel] of [['readme', 'README.md'], ['projectInfo', '项目信息.md'], ['iron', '项目铁律.md'], ['index', '项目索引.md'], ['collaboration', '协作准则.md'], ['requirementOverview', '需求/00-需求总览.md']]) {
    docs[key] = readDocRecord(path.join(base, rel), rel);
  }
  return { ok: missing.length === 0, root: base, teamMode: m, roles: rolesForMode(m), missing, docs, checkedAt: nowIso() };
}

/**
 * 补齐项目结构：按团队模式建角色目录 + 角色卡 + 文件索引 + 产出/ + 项目信息/铁律/索引/README/协作准则 + 需求池 + site + _tmp。
 * overwrite=false（默认）只补缺失，绝不动已有内容；overwrite=true 用于 workspace create 重建模板。
 * teamMode 只决定"要建哪些角色目录"；切模式不会删除已有目录（旧目录保留，避免误删内容）。
 */
export function ensureProjectStructure({ name, root, desc = '', overwrite = false, teamMode = 'full' } = {}) {
  const projectName = String(name || '').trim();
  if (!projectName) fail('BAD_NAME', '需要项目名才能建结构');
  const base = path.resolve(String(root || ''));
  if (!base) fail('PROJECT_PATH_REQUIRED', '缺少项目目录');
  const m = normalizeTeamMode(teamMode);
  const created = [];
  const kept = [];
  const relOf = (abs) => path.relative(base, abs).replace(/\\/g, '/');
  const mkdir = (dir) => {
    const rel = relOf(dir);
    if (exists(dir)) return;
    ensureDir(dir);
    created.push(rel ? rel + '/' : dir);
  };
  const put = (file, text) => {
    const rel = relOf(file);
    if (exists(file) && !overwrite) { kept.push(rel); return; }
    writeText(file, text);
    created.push(rel);
  };

  mkdir(base);
  mkdir(path.join(base, '_tmp'));
  mkdir(path.join(base, 'site'));
  mkdir(path.join(base, '需求'));

  for (const [file, template] of ROOT_FILES) put(path.join(base, file), template(projectName, desc, m));

  // 切模式时只改 project.teamMode 不够：协作准则还写着旧模式，角色会按错的口径执行。
  // 这是生成文档，不是 PM/角色正文；模式不一致时留一份 .bak 再按当前模式重写。
  const collab = path.join(base, '协作准则.md');
  if (exists(collab)) {
    const current = readText(collab, '');
    const modeLine = `团队模式：${TEAM_MODE_LABELS[m]}`;
    if (current && !current.includes(modeLine)) {
      try { writeText(`${collab}.bak-${Date.now()}`, current); } catch { /* 备份失败也继续，正文仍可重写 */ }
      writeText(collab, collaborationRules(projectName, m));
      if (!created.includes('协作准则.md（按模式重写）')) created.push('协作准则.md（按模式重写）');
    }
  }

  const teamIron = path.join(PATHS.teamRoot, '项目铁律.md');
  put(path.join(base, '项目铁律.md'), exists(teamIron) ? readText(teamIron, DEFAULT_IRON) : DEFAULT_IRON);

  put(path.join(base, '需求', 'README.md'), reqPoolReadme(m));
  put(path.join(base, '需求', '00-需求总览.md'), reqOverview(projectName));
  put(path.join(base, '需求', '需求模板.md'), reqTemplate(projectName));
  put(path.join(base, '需求', '文件索引.md'), '# 需求 · 文件索引\n\n> 先读索引再读文件。每次评审/回执确认后由需求负责人更新。\n\n| 文件 | 用途 | 状态 |\n|---|---|---|\n| README.md | 需求池维护方式 | 有效 |\n');
  put(path.join(base, 'site', 'README.md'), codeReadme(projectName, m));

  for (const role of rolesForMode(m)) {
    const dir = path.join(base, ROLE_DIRS[role]);
    mkdir(dir);
    mkdir(path.join(dir, '产出'));
    put(path.join(dir, '角色卡.md'), roleCard(projectName, role, m));
    put(path.join(dir, '文件索引.md'), roleIndex(role));
  }

  // 模式与目录一致：当前模式内角色目录齐全；模式外的旧角色目录不删，只标“非当前模式”。
  // 这样 fast 项目不会出现无标注的 产品/程序员B，切回 full 时把标记撤掉即可，不丢任何产出。
  const activeRoleDirs = new Set(rolesForMode(m).map((role) => ROLE_DIRS[role]));
  for (const roleId of Object.keys(ROLE_DIRS)) {
    const dirName = ROLE_DIRS[roleId];
    if (!dirName) continue;
    const dir = path.join(base, dirName);
    if (!exists(dir)) continue;
    const marker = path.join(dir, '非当前模式.md');
    if (activeRoleDirs.has(dirName)) {
      if (exists(marker)) {
        try { fs.rmSync(marker, { force: true }); } catch { /* ignore */ }
      }
      continue;
    }
    const text = `# 非当前模式目录\n\n`
      + `> 本目录对应的角色不在当前团队模式「${TEAM_MODE_LABELS[m]}」内（${teamModeDescription(m)}）。\n`
      + `> 目录、角色卡、产出与文件索引全部保留（不删数据、不换会话），但该角色不再参与当前模式的评审、签字与派单。\n`
      + `> 需要启用时把项目团队模式切回对应模式，再跑一次 project ensure；本文件会自动撤掉。\n`;
    const current = exists(marker) ? readText(marker, '') : '';
    if (current !== text) writeText(marker, text);
    if (!created.includes(`${dirName}/非当前模式.md`)) created.push(`${dirName}/非当前模式.md`);
  }

  const report = structureReport(base, { teamMode: m });
  return {
    ok: report.ok,
    name: projectName,
    root: base,
    teamMode: m,
    roles: rolesForMode(m),
    created,
    kept,
    missing: report.missing,
    docs: report.docs,
    checkedAt: report.checkedAt,
  };
}
