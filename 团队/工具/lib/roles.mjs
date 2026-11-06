// 团队工作台 v2 · 角色常量（团队角色 / 团队模式 / 项目目录 / 模型 / 文件上限）
// 单一真相：store / ops / scaffold / workspace 都从这里取，避免三份 ROLE_DIRS 漂移。
export const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];

// ---------- 团队模式：full（六角色）/ fast（四角色） ----------
// full：PM / 产品设计师 / 需求分析师 / 程序员A / 程序员B / 测试人员
// fast：PM / 需求分析师 / 程序员A / 测试人员（没有产品、没有程序员B）
// 目录与角色卡按模式生成；老项目没有 teamMode 字段一律按 full 解释，保持向后兼容。
export const TEAM_MODES = ['full', 'fast'];
export const DEFAULT_TEAM_MODE = 'full';
export const TEAM_MODE_LABELS = {
  full: '完整六角色',
  fast: '快速四角色',
};
export const TEAM_MODE_ROLES = {
  full: ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'],
  fast: ['pm', 'analyst', 'programmer1', 'tester'],
};
export const TEAM_MODE_DESCRIPTIONS = {
  full: '六角色：PM / 产品设计师 / 需求分析师 / 程序员A / 程序员B / 测试人员',
  fast: '四角色：PM / 需求分析师 / 程序员A / 测试人员（无产品、无程序员B）',
};

// 需求评审 reviewer：full 由产品设计师评审；fast 由需求分析师评审（没有产品角色）。
// 技术评审属于技术判断：full 由产品/程序员A记录，fast 由程序员A记录；PM 一律不评审。
export const REVIEW_POLICY = {
  full: {
    requirementReviewer: 'product',
    requirementReviewerLabel: '产品设计师',
    techReviewers: ['product', 'programmer1'],
  },
  fast: {
    requirementReviewer: 'analyst',
    requirementReviewerLabel: '需求分析师',
    techReviewers: ['programmer1'],
  },
};

// 投票规则（vote）：利害相关的是除 PM 外的全体角色；PM 只组织、记录，不投票。
// 驳回只有一种情形：除 PM 外全员一致驳回（一致驳回）。赞成过半即通过；
// 全部投完既非一致驳回、也没有过半赞成 = 未形成多数（no_consensus），不冒充通过。
export const VOTE_RULE_TEXT = '除 PM 外全员一致驳回才驳回；赞成过半即通过；全部投完既非一致驳回也无过半赞成 = 未形成多数（no_consensus）';

export function isTeamMode(mode) {
  return TEAM_MODES.includes(String(mode || '').trim().toLowerCase());
}

export function normalizeTeamMode(mode) {
  const m = String(mode || '').trim().toLowerCase();
  return TEAM_MODES.includes(m) ? m : DEFAULT_TEAM_MODE;
}

export function rolesForMode(mode) {
  return TEAM_MODE_ROLES[normalizeTeamMode(mode)].slice();
}

/**
 * 模式的角色 id 列表：写进 项目.json.roleIds 与 workspace.json.roleIds，
 * 与 rolesForMode 同源（模式决定角色集，不允许另存一份手写名单）。
 */
export function roleIdsForMode(mode) {
  return rolesForMode(mode);
}

export function roleInMode(role, mode) {
  return rolesForMode(mode).includes(role);
}

export function teamModeDescription(mode) {
  return TEAM_MODE_DESCRIPTIONS[normalizeTeamMode(mode)];
}

export function reviewPolicyFor(mode) {
  return REVIEW_POLICY[normalizeTeamMode(mode)];
}

/** 需求评审人（单个角色 id）：full=product，fast=analyst。 */
export function requirementReviewer(mode) {
  return reviewPolicyFor(mode).requirementReviewer;
}

/** 技术评审记录人：full=[product, programmer1]，fast=[programmer1]。 */
export function techReviewers(mode) {
  return reviewPolicyFor(mode).techReviewers.slice();
}

/** 投票参与人 = 当前模式全部角色 - PM（owner 是外部角色，没有 boot，不投票）。 */
export function votersForMode(mode) {
  return rolesForMode(mode).filter((role) => role !== 'pm');
}

// 展示名与项目目录名是两件事：展示名用于卡片标题，目录名用于落盘。
export const ROLE_NAMES = {
  pm: '项目经理',
  product: '产品设计师',
  analyst: '需求分析师',
  programmer1: '高级程序员 A',
  programmer2: '高级程序员 B',
  tester: '测试人员',
};

export const ROLE_DIRS = {
  pm: '项目经理',
  product: '产品',
  analyst: '需求分析师',
  programmer1: '程序员A',
  programmer2: '程序员B',
  tester: '测试人员',
};

export const LIMITS = {
  messageMaxChars: 600,
  ackNoteMaxChars: 300,
  reviewCommentMaxChars: 600,
  bootBriefMaxChars: 2000,
  docMaxBytes: 16384,
  codeMaxBytes: 65536,
  roleIndexMaxBytes: 8192,
};

// 结构化输出（豆包协议）：角色产出四纪律，角色卡 / boot 简报 / 模板共用同一句。
export const OUTPUT_DISCIPLINE = '只读自己需要区块 ｜ 只写自己负责字段 ｜ 输出即结果 ｜ 超过上限即停止';

// 角色 → 编号化 MD 产出（YAML 头 + 固定二级区块 + 列表 + 字段限长）。
// brief 命令（只读）按这份表从项目里提取区块，供壳层精准投喂；模板文件在 工具/模板/角色产出/。
export const OUTPUT_DOCS = {
  analyst: {
    code: '01', file: '01-需求分析-vN.md', title: '01-需求分析', label: '需求分析师',
    dir: ROLE_DIRS.analyst,
    fileRe: /^01-需求分析-v\d+\.md$/i,
    sections: ['一、场景与用户', '二、目标与价值', '三、边界与不做', '四、功能点清单', '五、验收标准', '六、异常与约束', '七、依赖与风险', '八、追踪矩阵', '九、变更记录'],
  },
  product: {
    code: '02', file: '02-产品设计-vN.md', title: '02-产品设计', label: '产品设计师',
    dir: ROLE_DIRS.product,
    fileRe: /^02-产品设计-v\d+\.md$/i,
    sections: ['一、上游引用', '二、用户故事', '三、页面与流程', '四、数据与状态', '五、架构要点', '六、优先级与竞品', '七、验收口径', '八、风险与回滚', '九、变更记录'],
  },
  programmer1: {
    code: '03', file: '03-架构设计-vN.md', title: '03-架构设计', label: '主开发（程序员A）',
    dir: ROLE_DIRS.programmer1,
    fileRe: /^03-架构设计-v\d+\.md$/i,
    sections: ['一、上游引用', '二、技术选型', '三、模块划分', '四、目录与文件结构', '五、接口与数据契约', '六、关键流程', '七、失败与回滚', '八、风险与依赖', '九、变更记录'],
  },
  tester: {
    code: '04', file: '04-测试报告-vN.md', title: '04-测试报告', label: '测试人员',
    dir: ROLE_DIRS.tester,
    fileRe: /^04-测试报告-v\d+\.md$/i,
    sections: ['一、测试范围', '二、环境与命令', '三、用例与结果', '四、缺陷', '五、验证与证据', '六、结论', '七、对账复核', '八、变更记录'],
  },
};

export function outputDocFor(role) {
  return OUTPUT_DOCS[role] || null;
}

export const DEFAULT_MODEL = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' };
export const MODEL_BY_ROLE = Object.fromEntries(ROLES.map((role) => [role, DEFAULT_MODEL]));

export function roleDir(role) {
  return ROLE_DIRS[role] || '';
}

export function roleLabel(role) {
  return ROLE_NAMES[role] || role;
}
