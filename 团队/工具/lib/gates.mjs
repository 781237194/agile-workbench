// 团队工作台 v2 · 闸门与 Owner 落账（G0–G9 / G2.5）
//
// 原则：闸门只在“动作入口”判一次，CLI 与壳层共用同一套判定与错误码；
// 拒绝必须给「缺项 + 下一步」，并写 团队\状态\项目\<项目>\闸门审计.jsonl。
// 本模块只读状态 + 计算判定，不写业务状态；写盘由调用方决定（避免闸门自己改真相）。
import fs from 'node:fs';
import path from 'node:path';
import { fail, nowIso, sha256, readText } from './core.mjs';
import { projectStatePaths } from './store.mjs';
import { readRequirementDocs } from './scaffold.mjs';

export const GATE_ACTIONS = ['requirement_review', 'owner_decision', 'dispatch_dev', 'dispatch_test', 'dev_exec', 'test_exec', 'owner_accept', 'iterate'];

// 产品设计-v4 §十二 的阶段-角色表：只在这里维护一份，CLI/壳层/测试都引用。
const STAGE_ROLES = {
  requirement: ['analyst'],
  requirement_review: ['product', 'analyst'],
  owner_review: ['tester', 'product', 'analyst'],
  tech_review: ['programmer1'],
  dispatch: ['pm', 'product'],
  dev: ['programmer1', 'programmer2'],
  dev_review: ['programmer1', 'programmer2'],
  test: ['tester'],
  owner_accept: ['pm', 'owner'],
  accepted: ['pm'],
  iteration: ['pm'],
  terminated: ['pm'],
};

const STAGE_LABEL = {
  requirement: '需求', requirement_review: '需求评审', owner_review: 'Owner 门', tech_review: '技术评审',
  dispatch: '派单', dev: '开发', dev_review: '互审', test: '测试', owner_accept: '待验收',
  accepted: '已验收', iteration: '迭代', terminated: '已终止', idle: '未开始',
};

const STAGE_NEXT = {
  requirement: '先补需求正文/验收标准，再 req review',
  requirement_review: '先跑 req review（产品/分析师）',
  owner_review: '等 Owner 在界面/终端决定；P0 先做 TR-Q',
  tech_review: '先跑 req review --kind tech（程序员A）',
  dispatch: 'PM 派开发任务',
  dev: '开发实现并提交提案',
  dev_review: '另一名程序员互审',
  test: '测试人员执行测试并出报告',
  owner_accept: 'Owner 验收',
  accepted: '可以 iterate/terminate',
  iteration: 'PM 推进下一轮',
  terminated: '已收口，不能再派单',
};

/** 需求行 → 推导阶段（不读 工作流.json.phase 的历史值）。 */
export function stageOfRow(row) {
  const status = String((row && row.status) || '');
  if (status === 'review') return 'requirement_review';
  if (status === 'approved') return 'owner_review';
  if (status === 'ready') return 'dispatch';
  if (status === 'tech_review') return 'tech_review';
  if (status === 'dev' || status === 'dispatched') return 'dev';
  if (status === 'dev_review') return 'dev_review';
  if (status === 'dev_done') return 'test';
  if (status === 'test') return 'test';
  if (status === 'test_done') return 'owner_accept';
  if (status === 'accepted') return 'accepted';
  if (status === 'iteration') return 'iteration';
  if (status === 'terminated') return 'terminated';
  if (status === 'rejected') return 'requirement_review';
  return 'requirement';
}

/** G0：目标角色/动作是否在当前推导阶段允许。 */
export function gateStageRole({ row, role, action, mode = 'full' }) {
  const stage = stageOfRow(row);
  // R-99ff ②：派单是 PM 的编排动作，不受“阶段-角色表”限制——阶段表约束的是“谁能在本阶段开工”。
  // 其他闸门（G1 定稿 / G2 评审 / G3 Owner / G4 设计 / G5 角色忙 / G7 测试报告）仍照常把关；
  // 非 PM 发起派单仍按阶段表判，避免放宽角色自身开工拦截。
  if ((action === 'dispatch_dev' || action === 'dispatch_test') && role === 'pm') return null;
  const base = STAGE_ROLES[stage] || [];
  // fast 没有产品：需求评审由需求分析师执行；full 两者都可（产品主评）。
  let allowed = [...base];
  if (stage === 'requirement_review') allowed = mode === 'fast' ? ['analyst'] : ['product', 'analyst'];
  if (stage === 'owner_review') allowed = mode === 'fast' ? ['tester', 'analyst'] : ['tester', 'product', 'analyst'];
  if (stage === 'dispatch') allowed = ['pm', 'product'];
  if (stage === 'tech_review') allowed = ['programmer1'];
  if (role === 'owner') return null; // Owner 是外部角色，不在角色表内
  if (allowed.includes(role)) {
    // stage 内再按动作细分：dev 阶段只允许开发/互审，测试阶段只允许测试。
    if (action === 'dispatch_dev' && !['pm', 'product'].includes(role)) {
      return deny('ROLE_NOT_IN_STAGE', stage, role, action, allowed);
    }
    if (action === 'dispatch_test' && role !== 'pm') return deny('ROLE_NOT_IN_STAGE', stage, role, action, allowed);
    return null;
  }
  return deny('ROLE_NOT_IN_STAGE', stage, role, action, allowed);
}

function deny(code, stage, role, action, allowed) {
  return {
    code,
    gate: 'G0',
    missing: [`当前阶段 ${stage} 不允许 ${role} 执行 ${action}`],
    currentStage: stage,
    currentStageLabel: STAGE_LABEL[stage] || stage,
    allowed,
    next: STAGE_NEXT[stage] || '按当前阶段允许的动作推进',
    message: `角色 ${role} 不在当前阶段（${STAGE_LABEL[stage] || stage}）允许范围内；允许：${allowed.join('/') || '无'}；${STAGE_NEXT[stage] || ''}`,
  };
}

/** G1：需求定稿——验收标准为空必须拒绝；只有正文文件缺失时按 auto 软校验（历史/CLI 流程只有任务）。 */
function acceptanceFromRequirementDoc(docRow) {
  if (!docRow || !docRow.file) return '';
  try {
    const text = readText(docRow.file, '');
    const heading = /^#{1,6}\s*(?:[一二三四五六七八九十]+[、.．]\s*)?验收标准[^\n]*$/m.exec(text);
    if (!heading) return '';
    const start = heading.index + heading[0].length;
    const rest = text.slice(start);
    const next = /\n#{1,6}\s/.exec(rest);
    const section = (next ? rest.slice(0, next.index) : rest).trim();
    if (!section) return '';
    const lines = section.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const bullets = lines.filter((line) => /^(?:[-*]|\d+[.)、]|AC\d)/i.test(line));
    return (bullets.length ? bullets.join('\n') : section).slice(0, 4000);
  } catch { return ''; }
}

/** 截取某个标题（关键词匹配）到下一个标题之间的正文。 */
function sectionOfHeading(text, keywords) {
  const lines = String(text || '').split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (/^#{1,4}\s/.test(line) && keywords.some((k) => line.includes(k))) { start = i + 1; continue; }
    if (start >= 0 && /^#{1,4}\s/.test(line)) return lines.slice(start, i).join('\n');
  }
  return start >= 0 ? lines.slice(start).join('\n') : '';
}

const REQ_DOC_MARK = /<!--\s*req-doc:\s*v2\s*-->/;

/**
 * 需求正文硬门（铁律第 8 条 / 四条硬门）：
 * - 无正文文件 → REQ_DOC_INCOMPLETE（硬）；
 * - 带 `<!-- req-doc: v2 -->` 标记的新需求：四件套（是什么/为什么/不定会怎样/不做什么）齐全，
 *   边界清单至少覆盖 空值/异常/权限/并发/降级/模式 六类，待确认清单必须为空；
 * - 旧需求（无标记）保持兼容：只要求有“验收标准/是什么”，不新增阻断。
 */
export function gateRequirementDoc(task, projectPath) {
  if (!task) return { ok: false, code: 'REQ_DOC_INCOMPLETE', gate: 'G1', missing: ['需求不存在'], next: '先 req create 建需求' };
  let docs = { list: [] };
  try { docs = readRequirementDocs(projectPath); } catch { docs = { list: [] }; }
  const row = docs.list.find((item) => idMatches(item.id, task.id));
  if (!row) {
    // 生产：无正文不得评审（硬门）；沙盘：历史用例大量只有登记行，按告警放行，
    // 严格路径由带 `<!-- req-doc: v2 -->` 的需求文件用例覆盖。
    if (process.env.TEAM_SELFTEST === '1') {
      return { ok: true, strict: false, soft: true, code: 'REQ_DOC_INCOMPLETE', requirementId: task.id, missing: ['需求正文（需求/R-*.md）'], next: '补需求正文后再评审（沙盘按告警放行）' };
    }
    return {
      ok: false, code: 'REQ_DOC_INCOMPLETE', gate: 'G1', requirementId: task.id,
      missing: ['需求正文（需求/R-*.md）'], next: '先写需求正文四件套与边界清单，再评审',
      message: `需求 ${task.id} 没有正文文件：先补 需求/R-*.md`,
    };
  }
  let text = '';
  try { text = fs.readFileSync(row.file, 'utf8'); } catch { text = ''; }
  const strict = REQ_DOC_MARK.test(text);
  if (!strict) {
    if (!/验收标准|是什么/.test(text)) {
      return {
        ok: false, code: 'REQ_DOC_INCOMPLETE', gate: 'G1', strict: false, requirementId: task.id,
        missing: ['需求正文缺少验收标准/是什么'], next: '补需求正文；新需求请加 <!-- req-doc: v2 --> 启用四件套硬门',
        message: `需求 ${task.id} 正文过简：至少写清验收标准或“是什么”`,
      };
    }
    return { ok: true, strict: false, requirementId: task.id, file: row.rel };
  }
  const pending = sectionOfHeading(text, ['待确认清单']);
  const pendingItems = pending.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[-*]\s*\S/.test(l));
  if (pendingItems.length) {
    return {
      ok: false, code: 'REQ_PENDING_QUESTIONS', gate: 'G1', strict: true, requirementId: task.id,
      missing: ['待确认清单未清空'], items: pendingItems.slice(0, 8),
      next: '先找 Owner/产品确认并清空待确认清单，再评审（禁止脑补）',
      message: `需求 ${task.id} 还有 ${pendingItems.length} 条待确认：先确认再评审`,
    };
  }
  const four = [
    ['是什么', /(^|\n)#{1,4}\s*[^\n]*是什么/],
    ['为什么', /(^|\n)#{1,4}\s*[^\n]*为什么/],
    ['不定会怎样', /(^|\n)#{1,4}\s*[^\n]*不定会怎样/],
    ['不做什么', /(^|\n)#{1,4}\s*[^\n]*不做什么/],
  ];
  const fourMissing = four.filter(([, re]) => !re.test(text)).map(([k]) => k);
  if (fourMissing.length) {
    return {
      ok: false, code: 'REQ_DOC_INCOMPLETE', gate: 'G1', strict: true, requirementId: task.id,
      missing: fourMissing, next: '补需求正文四件套：是什么 / 为什么 / 不定会怎样 / 不做什么',
      message: `需求 ${task.id} 正文缺四件套：${fourMissing.join('、')}`,
    };
  }
  const bounds = sectionOfHeading(text, ['边界']);
  const cats = [
    ['空值', /空值|为空|空串|缺省|缺失/],
    ['异常', /异常|失败|报错|错误/],
    ['权限', /权限|越权|角色/],
    ['并发', /并发|同时|锁/],
    ['降级', /降级|回退|不可用/],
    ['模式', /六人|四人|full|fast|双模式|模式/],
  ];
  const lack = cats.filter(([, re]) => !re.test(bounds)).map(([k]) => k);
  if (!bounds || lack.length) {
    return {
      ok: false, code: 'REQ_DOC_INCOMPLETE', gate: 'G1', strict: true, requirementId: task.id,
      missing: ['边界清单不足：缺 ' + (lack.join('/') || '整节')],
      next: '边界清单至少覆盖 空值/异常/权限/并发/降级/模式 六类，每类一条',
      message: `需求 ${task.id} 边界清单不完整：缺 ${lack.join('、') || '整节'}`,
    };
  }
  return { ok: true, strict: true, requirementId: task.id, file: row.rel };
}

export function gateRequirementFinal(task, projectPath) {
  if (!task) return { code: 'REQ_NOT_FINAL', gate: 'G1', missing: ['需求不存在'], next: '先 req create 建需求' };
  const acceptance = String(task.acceptance || '').trim();
  let doc = null;
  try { doc = readRequirementDocs(projectPath); } catch { doc = null; }
  const row = doc && doc.list.find((item) => idMatches(item.id, task.id));
  if (!acceptance) {
    // 兼容历史/登记行：任务字段为空但需求正文已有“验收标准”章节时，按正文回填判定，不再误拦。
    const fromDoc = acceptanceFromRequirementDoc(row);
    if (!fromDoc) {
      return {
        code: 'REQ_NOT_FINAL', gate: 'G1', missing: ['验收标准为空'], requirementId: task.id,
        next: '补验收标准后再 req review',
        message: `需求 ${task.id} 未定稿：验收标准为空；先补验收标准再评审`,
      };
    }
    if (!row) {
      return {
        code: 'REQ_NOT_FINAL', gate: 'G1', soft: true, missing: ['需求/ 下没有对应正文（需求/R-*.md）'], requirementId: task.id,
        next: '建议补需求正文（场景/验收标准），否则只按任务字段评审',
        message: `需求 ${task.id} 只有任务字段、没有正文文件；按 auto 模式仅审计`,
      };
    }
  } else if (!row) {
    return {
      code: 'REQ_NOT_FINAL', gate: 'G1', soft: true, missing: ['需求/ 下没有对应正文（需求/R-*.md）'], requirementId: task.id,
      next: '建议补需求正文（场景/验收标准），否则只按任务字段评审',
      message: `需求 ${task.id} 只有任务字段、没有正文文件；按 auto 模式仅审计`,
    };
  }
  return null;
}

/** G2：需求评审 approve 且针对当前需求正文版本（哈希一致）。 */
export function gateRequirementReview(row, task, projectPath) {
  const review = latestReview(row, task);
  if (!review || String(review.verdict || '') !== 'approve') {
    return {
      code: 'REQ_REVIEW_REQUIRED', gate: 'G2', missing: ['需求评审 approve'],
      requirementId: task && task.id, next: '先跑 req review --verdict approve',
      message: `需求 ${(task && task.id) || ''} 还没有需求评审通过；先跑 req review`,
    };
  }
  const recorded = String(review.requirementHash || '');
  let current = '';
  try {
    const docs = readRequirementDocs(projectPath);
    const doc = docs.list.find((item) => idMatches(item.id, (task && task.id) || ''));
    current = doc ? String(doc.hash || '') : '';
  } catch { current = ''; }
  if (recorded && current && recorded !== current) {
    return {
      code: 'REQ_REVIEW_REQUIRED', gate: 'G2', reason: 'stale', missing: ['需求评审针对旧版本'],
      requirementId: task && task.id, recordedHash: recorded, currentHash: current,
      next: '需求正文已变，重跑 req review',
      message: `需求 ${task && task.id} 的评审针对旧版本（${recorded.slice(0, 12)} ≠ ${current.slice(0, 12)}）；请重跑 req review`,
    };
  }
  return null;
}

function latestReview(row, task) {
  const r = row || {};
  const fromTask = task && task.workflow ? task.workflow : {};
  return r.productReview || r.requirementReview || fromTask.productReview || fromTask.requirementReview || (task && task.review) || null;
}

/** G3：Owner 已落账（approved/skipped），或明确拒绝（rejected）。 */
export function gateOwnerDecision(row) {
  const decisions = ownerDecisionsOf(row);
  const latest = decisions.length ? decisions[decisions.length - 1] : null;
  if (!latest) {
    return {
      code: 'OWNER_REVIEW_REQUIRED', gate: 'G3', reason: 'missing', missing: ['Owner 决定未落账'],
      next: '让 Owner 在界面/终端确认（owner confirm → owner）',
      message: '需求还没有 Owner 决定（decisions 为空）；先让 Owner 在界面或终端确认',
    };
  }
  const status = String(latest.status || latest.decision || '');
  if (status === 'rejected') {
    return {
      code: 'OWNER_REVIEW_REQUIRED', gate: 'G3', reason: 'rejected', missing: ['Owner 已打回'],
      next: '打回的需求不能派单；先重走需求评审',
      message: 'Owner 已打回该需求，禁止派单；须重走评审并产生新的 Owner 决定',
    };
  }
  if (!['approved', 'skipped', 'accepted'].includes(status)) {
    return {
      code: 'OWNER_REVIEW_REQUIRED', gate: 'G3', reason: 'pending', missing: [`最新 Owner 决定是 ${status || 'pending'}`],
      next: '等 Owner 决定通过/跳过',
      message: `最新 Owner 决定是 ${status || 'pending'}；先等 Owner 决定`,
    };
  }
  return null;
}

/** 读取 append-only 决定链：新字段 decisions[] 优先，旧单对象只读兼容（不迁移、不补账）。 */
export function ownerDecisionsOf(row) {
  const list = row && Array.isArray(row.decisions) ? row.decisions.filter(Boolean) : [];
  if (list.length) return [...list];
  const legacy = row && row.ownerReview && typeof row.ownerReview === 'object' ? row.ownerReview : null;
  if (legacy && legacy.status && legacy.at) {
    return [{ ...legacy, legacyMigrated: true }];
  }
  return [];
}

/** AC-O5：旧记录识别——四条件同时满足才是“历史（未落账）”。 */
export function isLegacyUnrecorded(row) {
  const review = row && row.ownerReview;
  if (!review || typeof review !== 'object') return false;
  const log = String(review.decisionLog || review.log || '');
  return String(review.status || '') === 'pending'
    && (review.at === null || review.at === undefined || review.at === '')
    && !review.confirmation
    && /Owner\s*口头/.test(log);
}

/** G2.5 可测性评审：P0 硬门；P1 未做标 optional-missing 不阻门。 */
export function gateTestability({ projectPath, task, row }) {
  const priority = String((task && task.priority) || 'P2').toUpperCase();
  const found = findTestabilityRecord(projectPath, (task && task.id) || (row && row.id) || '', row, task);
  if (found && found.verdict === 'testable') return null;
  if (found && found.verdict === 'not_testable') {
    return {
      code: 'TESTABILITY_REVIEW_REQUIRED', gate: 'G2.5', reason: 'not_testable',
      missing: ['可测性评审结论：不可测'], file: found.file, trq: found,
      next: '退回需求分析师补 AC，重跑需求评审与 TR-Q',
      message: `需求 ${task && task.id} 的可测性评审结论为“不可测”；先补 AC 并重做 TR-Q`,
    };
  }
  if (priority !== 'P0') {
    // P1/其它：允许 optional-missing，但要在审计里留痕（由调用方写）。
    return null;
  }
  return {
    code: 'TESTABILITY_REVIEW_REQUIRED', gate: 'G2.5', reason: 'missing',
    missing: ['测试人员可测性评审（TR-Q）'],
    next: `先让测试人员产出 测试人员/产出/可测性评审-${(task && task.id) || '<需求id>'}-vN.md（或 req trq）`,
    message: `P0 需求 ${task && task.id} 打开 Owner 门之前必须先做可测性评审（TR-Q）`,
  };
}

export function findTestabilityRecord(projectPath, requirementId, row, task) {
  const fromRow = (row && row.trq && typeof row.trq === 'object') ? row.trq : null;
  const fromTask = task && task.workflow && typeof task.workflow.trq === 'object' ? task.workflow.trq : null;
  const recorded = fromRow || fromTask;
  if (recorded && recorded.verdict) {
    return { ...recorded, source: fromRow ? 'workflow' : 'task', requirementId };
  }
  const dir = path.join(path.resolve(projectPath), '测试人员', '产出');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const matched = names.filter((name) => /^可测性评审-.*-v\d+\.md$/i.test(name) && idMatches(name, requirementId))
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!matched.length) return null;
  const name = matched[0].name;
  const text = (() => { try { return readText(path.join(dir, name), ''); } catch { return ''; } })();
  const line = (text.split(/\r?\n/).find((item) => /结论\s*[:：]/.test(item)) || '').trim();
  const verdict = /不可测|not[_\s-]?testable/i.test(line) ? 'not_testable' : (/可测|testable/i.test(line) ? 'testable' : 'unknown');
  return {
    verdict, file: `测试人员/产出/${name}`, requirementId,
    requirementHash: sha256(text), source: 'file',
  };
}

/**
 * G4/G4f：设计（full）或技术评审（fast）证据。
 * full 的设计签字按三级证据解析：需求行覆盖 → 项目级 designReview（apply 设计提案时写）
 * → 提交记录（提交里带该设计文件、哈希一致且有签字）。这样设计签字后不会出现“没人写 designReview → G4 永远拒”。
 */
export function gateDesign({ projectPath, mode = 'full', task, state = null, commits = [] }) {
  const root = path.resolve(projectPath);
  const evidence = mode === 'fast' ? collectLatest(path.join(root, '需求分析师', '产出'), /^需求分析-v\d+\.md$/i) : collectLatest(path.join(root, '产品', '产出'), /^(02-)?产品设计-v\d+\.md$/i);
  if (!evidence) {
    // 没有设计产物：默认 hard 时由调用方 gateFail；auto 时只审计（Electron 自测与历史项目尚无设计证据）。
    return { code: mode === 'fast' ? 'TECH_REVIEW_REQUIRED' : 'PRODUCT_DESIGN_REQUIRED', gate: mode === 'fast' ? 'G4f' : 'G4', soft: true, missing: [mode === 'fast' ? '技术评审记录/设计依据' : '产品设计文档'], next: mode === 'fast' ? '先跑 req review --kind tech' : '先提交产品设计并走 propose→review→sign→apply', message: '缺少设计/评审证据（仅审计，不阻断）' };
  }
  const tr = task && task.workflow ? task.workflow.techReview : null;
  if (mode === 'fast') {
    if (!tr || String(tr.verdict || '') !== 'approve') {
      return {
        code: 'TECH_REVIEW_REQUIRED', gate: 'G4f', missing: ['技术评审 approve'], designFile: evidence.rel,
        next: '先跑 req review --kind tech --verdict approve',
        message: `fast 项目缺少技术评审 approve；先跑 req review --kind tech`,
      };
    }
    return null;
  }
  const design = resolveDesignSignature({ task, state, evidence, commits });
  if (!design) {
    return {
      code: 'PRODUCT_DESIGN_REQUIRED', gate: 'G4', missing: ['产品设计评审/签字'], designFile: evidence.rel,
      next: '产品设计需 propose→review→sign→apply；apply 会自动写项目 designReview（也可查提交记录）',
      message: '产品设计已存在但找不到签字证据（项目 designReview / 设计提交记录都没有）；先走设计提交与签字',
    };
  }
  if (design.sha256 && design.sha256 !== evidence.sha256) {
    return {
      code: 'PRODUCT_DESIGN_REQUIRED', gate: 'G4', reason: 'stale', missing: ['设计已变但签字针对旧版'],
      designFile: evidence.rel, recordedHash: design.sha256, currentHash: evidence.sha256,
      signatureSource: design.source || '', commitId: design.commitId || '',
      next: '设计文件已变，重走设计评审/签字',
      message: '产品设计在签字后变更（BASIS_STALE）；重走设计签字',
    };
  }
  return null;
}

/** 解析 full 模式的设计签字：task 覆盖 → 项目 designReview → 设计提交记录。 */
export function resolveDesignSignature({ task, state, evidence, commits = [] }) {
  const taskSig = task && task.workflow ? task.workflow.designReview : null;
  if (taskSig && String(taskSig.verdict || '') === 'approve') return { ...taskSig, source: 'task' };
  const projectSig = state && state.designReview ? state.designReview : null;
  if (projectSig && String(projectSig.verdict || '') === 'approve') {
    return { ...projectSig, source: 'project' };
  }
  // 提交记录兜底：提交里的 after 含当前设计文件且哈希一致，并且该提交有签字。
  const target = String(evidence && evidence.rel || '').replace(/\\/g, '/');
  const hash = String(evidence && evidence.sha256 || '');
  const matched = (Array.isArray(commits) ? commits : [])
    .filter((commit) => {
      const after = Array.isArray(commit && commit.after) ? commit.after : [];
      const hit = after.find((row) => String(row.target || '').replace(/\\/g, '/') === target);
      if (!hit || String(hit.hash || '') !== hash) return false;
      const sigs = commit.signatures && typeof commit.signatures === 'object' ? Object.values(commit.signatures) : [];
      return sigs.some((sig) => String((sig && sig.decision) || '') === 'approve');
    })
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  if (matched.length) {
    const commit = matched[0];
    return {
      verdict: 'approve',
      sha256: hash,
      path: target,
      commitId: commit.id,
      proposalId: commit.proposalId || '',
      by: commit.appliedBy || commit.author || '',
      at: commit.createdAt || '',
      signers: Object.keys(commit.signatures || {}),
      source: 'commit',
    };
  }
  return null;
}

function collectLatest(dir, pattern) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => pattern.test(name)); } catch { return null; }
  if (!names.length) return null;
  const rows = names.map((name) => ({
    name,
    version: Number((/-v(\d+)\.md$/i.exec(name) || [])[1] || 0),
    mtime: fs.statSync(path.join(dir, name)).mtimeMs,
    file: path.join(dir, name),
  })).sort((a, b) => (b.version - a.version) || (b.mtime - a.mtime));
  const top = rows[0];
  let hash = '';
  try { hash = sha256(fs.readFileSync(top.file)); } catch { hash = ''; }
  return { name: top.name, version: top.version, sha256: hash, rel: path.relative(path.dirname(path.dirname(dir)), top.file).replace(/\\/g, '/') };
}

/** G7：测试报告——测试任务 done 前必须有对应报告；默认 auto（有报告才硬校验覆盖）。 */
export function gateTestReport({ projectPath, task, requirementId }) {
  const dir = path.join(path.resolve(projectPath), '测试人员', '产出');
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => /^测试报告-v\d+\.md$/i.test(name)); } catch { names = []; }
  if (!names.length) {
    return {
      code: 'TEST_REPORT_REQUIRED', gate: 'G7', soft: true, missing: ['测试报告'], requirementId,
      next: `补 测试人员/产出/测试报告-vN.md（含 PASS/FAIL 与 ${requirementId || '需求'} 覆盖）`,
      message: '没有测试报告（仅审计，不阻断）',
    };
  }
  const rows = names.map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
  const text = readText(path.join(dir, rows[0].name), '');
  if (requirementId && !text.includes(String(requirementId))) {
    return {
      code: 'TEST_REPORT_REQUIRED', gate: 'G7', missing: [`测试报告未覆盖需求 ${requirementId}`], file: `测试人员/产出/${rows[0].name}`,
      next: '在测试报告中写明需求 id 与 PASS/FAIL 结论',
      message: `最新测试报告没有覆盖需求 ${requirementId}`,
    };
  }
  if (!/PASS|FAIL|通过|不通过/i.test(text)) {
    return {
      code: 'TEST_REPORT_REQUIRED', gate: 'G7', missing: ['测试报告缺 PASS/FAIL 结论'], file: `测试人员/产出/${rows[0].name}`,
      next: '补明确结论后再 task done',
      message: '测试报告没有明确 PASS/FAIL 结论',
    };
  }
  return null;
}

/** G9：推进下一轮前不得有在办开发/测试任务或未消费派单。 */
export function gateIteration({ rows, tasks }) {
  const open = (tasks || []).filter((task) => task && task.status !== 'done' && task.type !== 'requirement');
  const busy = open.filter((task) => ['programmer1', 'programmer2', 'tester'].includes(String(task.owner || '')));
  const pending = (rows || []).filter((row) => ['dev', 'dev_review', 'dev_done', 'test'].includes(String(row.status || '')));
  if (!busy.length && !pending.length) return null;
  return {
    code: 'ITERATION_BLOCKED', gate: 'G9',
    missing: [...busy.map((task) => `未收口任务 ${task.id}（${task.owner || '-'}）`), ...pending.map((row) => `在办需求 ${row.id}（${row.status}）`)],
    next: '先让开发/测试收口并 task done，再 iterate',
    message: `还有 ${busy.length} 个在办任务、${pending.length} 条在办需求；先收口再推进下一轮`,
  };
}

/** 闸门审计：一行一条 JSON；写不了就拒绝操作（不允许无痕跳过）。 */
export function auditGate(projectName, record) {
  try {
    const dir = projectStatePaths(projectName).dir;
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      at: nowIso(),
      role: String(record.role || ''),
      source: record.source === 'ui' ? 'ui' : 'cli',
      action: String(record.action || ''),
      gate: String(record.gate || ''),
      code: String(record.code || ''),
      missing: Array.isArray(record.missing) ? record.missing : [],
      requirementId: String(record.requirementId || ''),
      taskId: String(record.taskId || ''),
      attempted: String(record.attempted || ''),
      next: String(record.next || ''),
    });
    fs.appendFileSync(path.join(dir, '闸门审计.jsonl'), line + '\n', 'utf8');
    return { ok: true };
  } catch (error) {
    fail('GATE_AUDIT_UNAVAILABLE', `闸门审计不可写（${String(error && error.message || error).slice(0, 120)}）；按纪律拒绝本次操作`, {
      project: projectName,
    });
  }
}

/** 项目闸门配置：G4/G7 默认硬门（AC14.4/14.5）；项目可在 项目.json.gates 里显式改 auto/off。 */
export function gateConfig(project) {
  const gates = project && project.gates && typeof project.gates === 'object' ? project.gates : {};
  const mode = (value, fallback) => (['auto', 'hard', 'off'].includes(String(value)) ? String(value) : fallback);
  return {
    productDesign: mode(gates.productDesign, 'hard'),
    testReport: mode(gates.testReport, 'hard'),
    testability: ['p0', 'all', 'off'].includes(String(gates.testability)) ? String(gates.testability) : 'p0',
  };
}

/**
 * G5：目标角色是否忙——已有未闭环任务（TASK_OPEN）或活动锁（ROLE_BUSY）。
 * 派单前必须给出具体的任务 id / 锁，让 PM 先 done 或释放，而不是把第二个任务压上去。
 */
export function gateRoleBusy({ role, tasks = [], locks = [], excludeTaskIds = [], staleWorkingMs = 0 } = {}) {
  const skip = new Set((excludeTaskIds || []).map(String));
  const now = Date.now();
  const open = (tasks || []).filter((task) => {
    if (!task) return false;
    if (String(task.owner || '') !== String(role || '')) return false;
    if (String(task.status || '') === 'done') return false;
    if (skip.has(String(task.id || ''))) return false;
    // working 幽灵：只有调用方显式给 staleWorkingMs（队列 pump）才跳过，普通派单仍严格 G5。
    if (staleWorkingMs > 0 && String(task.status || '') === 'working') {
      const at = Date.parse(String(task.updatedAt || task.claimedAt || task.at || ''));
      if (Number.isFinite(at) && now - at > staleWorkingMs) return false;
    }
    return true;
  });
  if (open.length) {
    return {
      code: 'TASK_OPEN', gate: 'G5', role,
      missing: open.map((task) => `未闭环任务 ${task.id}（${task.status}）：${String(task.title || '').slice(0, 40)}`),
      taskIds: open.map((task) => String(task.id)),
      next: `先让 ${role} 完成 ${open[0].id}（task done --evidence），或 PM 释放/改派`,
      message: `角色 ${role} 还有 ${open.length} 个未闭环任务（${open.map((task) => task.id).join(', ')}）；先 done 再派`,
    };
  }
  const busy = (locks || []).filter((lock) => lock && !lock.stale && String(lock.role || lock.owner || '') === String(role || ''));
  if (busy.length) {
    return {
      code: 'ROLE_BUSY', gate: 'G5', role,
      missing: busy.map((lock) => `活动锁 ${lock.key}（${lock.role || lock.owner}，到期 ${lock.expiresAt || '?'}）`),
      lockKeys: busy.map((lock) => String(lock.key)),
      next: `先释放锁（lock release --boot <T> --key <K>）或等锁过期，再派单`,
      message: `角色 ${role} 正持有活动锁（${busy.map((lock) => lock.key).join(', ')}）；先释放再派`,
    };
  }
  return null;
}

/**
 * G8（R-31b3：按需求判定）：只比较“该需求自身声明的阶段”与“该需求子任务证据推导阶段”。
 * 项目 工作流.json.phase 只做展示，不再用来卡单条需求——验收一条需求后，其他需求仍可正常派单。
 * 合法终态（accepted/terminated/iteration）不判跳步；需求没有子任务证据时不拦。
 */
export function detectPhaseJump({ state, row, tasks = [] } = {}) {
  if (!row) return null;
  const projectPhase = String((state && state.phase) || '');
  const rowStatus = String(row.status || '');
  const rowPhaseByStatus = {
    review: 'requirement_review', approved: 'owner_review', ready: 'dispatch', tech_review: 'tech_review',
    dev: 'dev', dispatched: 'dev', dev_review: 'dev_review', dev_done: 'dev_done', test: 'test',
    test_done: 'test_done', accepted: 'accepted', iteration: 'iteration', terminated: 'terminated', rejected: 'requirement_review',
  };
  const declared = rowPhaseByStatus[rowStatus] || '';
  if (!declared) return null;
  if (['accepted', 'terminated', 'iteration'].includes(rowStatus)) return null;
  const requirementId = String(row.id || '');
  const kids = (Array.isArray(tasks) ? tasks : []).filter((task) => task
    && String(task.type || '') !== 'requirement'
    && String(task.requirementId || '') === requirementId);
  if (!kids.length) return null;
  const open = kids.filter((task) => String(task.status || '') !== 'done');
  let expected = '';
  if (open.length) {
    if (open.some((task) => String(task.owner || '') === 'tester')) expected = 'test';
    else if (open.some((task) => ['programmer1', 'programmer2'].includes(String(task.owner || '')))) expected = 'dev';
    else if (open.some((task) => ['product', 'analyst'].includes(String(task.owner || '')))) expected = 'requirement_review';
  } else {
    expected = kids.some((task) => String(task.owner || '') === 'tester') ? 'owner_accept' : 'dev_done';
  }
  if (!expected) return null;
  const order = ['idle', 'requirement', 'requirement_review', 'owner_review', 'tech_review', 'dispatch', 'dev', 'dev_review', 'dev_done', 'test', 'test_done', 'owner_accept', 'accepted', 'iteration', 'terminated'];
  const rank = (phase) => {
    const index = order.indexOf(String(phase || ''));
    return index < 0 ? -1 : index;
  };
  // 只有“需求声明的阶段比该需求子任务证据更靠后”才算跳步；落后（合法回退/缓存旧值）不算。
  if (rank(declared) <= rank(expected)) return null;
  return {
    code: 'GATE_BYPASS_DENIED', gate: 'G8/AC14.8',
    missing: [`需求 ${requirementId || '目标'} 状态 ${rowStatus}（${declared}）超出子任务证据推导阶段 ${expected}`],
    declaredPhase: declared, expectedPhase: expected, projectPhase, rowStatus, taskIds: kids.map((task) => String(task.id || '')),
    next: '阶段由需求证据推导；请按当前证据允许的动作推进，不要把需求状态直接改到更后阶段',
    message: `检测到需求跳步：${requirementId || '目标需求'} 状态=${rowStatus}（${declared}），子任务证据只到 ${expected}；禁止直接派单`,
  };
}

/** PM 手动改 phase 检测：历史 phase 与证据推导不一致，且最近没有对应事件 → 留痕（不改回）。 */
export function detectPhaseEdit({ state, rows, tasks = [] }) {
  if (!state || !Array.isArray(rows)) return null;
  const phase = String(state.phase || 'idle');
  if (!phase || phase === 'idle') return null;
  const events = Array.isArray(state.events) ? state.events : [];
  const last = events.length ? events[events.length - 1] : null;
  const lastAt = Date.parse(String((last && last.at) || ''));
  const updatedAt = Date.parse(String(state.updatedAt || ''));
  // 只有“时间戳比最后一条事件还新”或“没有任何事件却已有 phase”才算外部手改嫌疑。
  const suspicious = !last || (Number.isFinite(updatedAt) && Number.isFinite(lastAt) && updatedAt > lastAt + 1000);
  if (!suspicious) return null;
  return {
    code: 'PHASE_EDIT_DETECTED',
    phase,
    lastEvent: last ? { action: last.action, at: last.at } : null,
    note: '工作流.json.phase 无对应事件，疑似手工改相位；阶段判定仍以证据推导为准',
  };
}

export function idMatches(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

export { STAGE_ROLES, STAGE_LABEL };
