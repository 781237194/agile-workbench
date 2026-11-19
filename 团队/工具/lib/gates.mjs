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
import { readRequirementDocVersion, versionGate } from './req-version.mjs';
// b75c：决定「绑的是不是当前正文版本」的唯一判定函数（CJS 单源，壳层 src/team-tools.js 共用同一份）。
import decisionVersion from './decision-version.cjs';
const { decisionMatchesVersion } = decisionVersion;
// B-20261115-123038-2e24：ownerReview 投影单源（旧版决定 → pending + stale:true + staleSha12）。
import { ownerReviewView, ownerReviewStaleOf } from './owner-review-projection.mjs';

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
  // R-d225 F-reopen-4/AC5：返工失效标记必须被 G2 消费——返工时间晚于评审时间则一律要求重评
  // （即使正文没变，也不能静默复用旧评审；门禁只读标记，不清标记，通过后由新记录覆盖）。
  const reopenedAt = String((row && (row.lastReopenAt || row.gateInvalidatedAt)) || '');
  const reviewAt = String(review.ts || review.at || '');
  if (reopenedAt && (!reviewAt || Date.parse(reopenedAt) > Date.parse(reviewAt))) {
    return {
      code: 'REQ_REVIEW_REQUIRED', gate: 'G2', reason: 'reopened', missing: ['返工后需重新评审需求'],
      requirementId: (task && task.id) || (row && row.id) || '', reopenedAt, reviewAt,
      next: '返工后按 gateInvalidatedAt 重跑 req review',
      message: `需求 ${(task && task.id) || ''} 已返工（${reopenedAt}），旧评审（${reviewAt || '无时间'}）不算本轮；请重跑 req review`,
    };
  }
  let current = { hash: '', version: '', change: '' };
  try {
    const doc = readRequirementDocVersion(projectPath, (task && task.id) || (row && row.id) || '');
    current = { hash: String(doc.hash || ''), version: String(doc.version || ''), change: String(doc.change || '') };
  } catch { current = { hash: '', version: '', change: '' }; }
  // R-9a8e：先按三元组（id, version, hash）判——version 变了报「需重评：v旧→v新」，
  // version 未涨而 hash 变了报 VERSION_NOT_BUMPED；legacy 记录（无 version）仍按 hash 判。
  const versionBlock = versionGate({ records: [review], current, gate: 'G2' });
  if (versionBlock) return { ...versionBlock, requirementId: (task && task.id) || (row && row.id) || '' };
  if (recorded && current.hash && recorded !== current.hash) {
    return {
      code: 'REQ_REVIEW_REQUIRED', gate: 'G2', reason: 'stale', missing: ['需求评审针对旧版本'],
      requirementId: task && task.id, recordedHash: recorded, currentHash: current.hash,
      next: '需求正文已变，重跑 req review',
      message: `需求 ${task && task.id} 的评审针对旧版本（${recorded.slice(0, 12)} ≠ ${current.hash.slice(0, 12)}）；请重跑 req review`,
    };
  }
  return null;
}

function latestReview(row, task) {
  const r = row || {};
  const fromTask = task && task.workflow ? task.workflow : {};
  return r.productReview || r.requirementReview || fromTask.productReview || fromTask.requirementReview || (task && task.review) || null;
}

/**
 * 只读投影：给「展示/推进判定」用的 decisions 列表与最新一条。
 * R-75ec 之后 ops/store 不得再直接调 ownerDecisionsOf/gateOwnerDecision（门只走 taskGateOf），
 * 需要读决定链的地方统一用这两个投影。
 */
export function decisionListOf(row) {
  return ownerDecisionsOf(row);
}

export function latestDecisionOf(row) {
  const list = ownerDecisionsOf(row);
  return list.length ? list[list.length - 1] : null;
}

/**
 * B-20261116-105620-630a2e（全仓扫「旧决定当已决定」）：当前正文版本 hash。
 * 取数顺序与渲染层 owner-review-state.currentDocHashOf 同源：RR 绑定 hash 优先，其次行上的 docHash。
 */
export function currentRequirementVersionOf(row) {
  const r = row || {};
  const candidates = [r.requirementHash, r.docHash, r.requirementReview && r.requirementReview.requirementHash];
  for (const candidate of candidates) {
    const value = candidate === undefined || candidate === null ? '' : String(candidate);
    if (value) return value;
  }
  return '';
}

/**
 * B-20261116-105620-630a2e：这笔 Owner 决定是否**针对当前正文版本**。
 * 判据（与渲染层同一口径，但团队工具侧对「无 basis 的历史决定」保守兼容，避免误伤在途需求）：
 *   ① 决定带 basis.requirement.sha256/contentHash 且与当前版本相等 → 有效；
 *   ② 带 hash 但版本不等 → 旧决定（无效）；
 *   ③ 无 hash（11-15 那批历史决定）→ 看 ownerReview 是否仍指向这笔决定：被重置成 pending 说明正文改版需重审 → 无效；
 *      仍是 approved/skipped/rejected 且与决定同状态 → 视为有效（兼容历史，不改旧行为）；
 *      两者都没有 → 无法判断，保持旧行为（true），不制造新的阻断。
 */
export function decisionIsCurrent(decision, row) {
  if (!decision || typeof decision !== 'object') return false;
  const basis = (decision.basis && typeof decision.basis === 'object') ? decision.basis : {};
  const requirement = (basis.requirement && typeof basis.requirement === 'object') ? basis.requirement : {};
  const decidedSha = String(requirement.sha256 || '');
  const decidedContent = String(requirement.contentHash || '');
  const currentSha = currentRequirementVersionOf(row);
  const currentContent = String((row && row.requirementReview && row.requirementReview.contentHash) || (row && row.contentHash) || '');
  // b75c：与壳层同一函数（decision-version.cjs）——contentHash 优先，只差程序维护行不算旧版；
  // contentHash 缺失才回落原始 sha256（旧决定兼容），行为与以前一致。
  const matched = decisionMatchesVersion(decision, { sha256: currentSha, contentHash: currentContent });
  if (matched === true) return true;
  if (matched === false) return false;
  if (decidedSha || decidedContent) return false; // 有 hash 但当前版本未知 → 不能证明是当前版本
  const owner = (row && row.ownerReview && typeof row.ownerReview === 'object') ? row.ownerReview : null;
  const ownerStatus = String((owner && owner.status) || '');
  const decisionStatus = String(decision.status || decision.decision || '');
  if (ownerStatus === 'pending') return false; // 门被重置：旧决定不得当已决定
  if (['approved', 'skipped', 'rejected'].includes(ownerStatus)) return ownerStatus === decisionStatus;
  return true;
}

/** 当前版本有效的最近一条 Owner 决定（旧决定返回 null）。 */
export function currentDecisionOf(row) {
  const latest = latestDecisionOf(row);
  if (!latest) return null;
  return decisionIsCurrent(latest, row) ? latest : null;
}

/**
 * K1②（T-20261119-165257-5203，Owner 已采纳）：编写/设计类任务（`type=task` 的 doc/design）判定——**唯一口径**。
 *
 * 背景：本项目 TASK_TYPES 只有 requirement/task/bug/chore/scenario-bug，写正文、做设计这类活都落在 `type=task`，
 * 一旦挂了 requirementId 就会被 G3（Owner 未落账）自锁 → 今天实际被绊三次（写正文任务结不了单）。
 * 口径：`type==='task'` 且 title/detail 命中编写/设计语义关键词 → 视为 authoring 任务。
 * 用途：①G3 在需求仍处评审阶段时豁免；②G8 不把这类任务算作「子任务证据」；③G4 不对这类任务硬拦（避免自锁）。
 */
export function isAuthoringTask(task) {
  const t = task || {};
  if (String(t.type || '').toLowerCase() !== 'task') return false;
  const text = `${String(t.title || '')}\n${String(t.detail || '')}`;
  return /编写|撰写|文档|设计|正文|评审|分析报告|说明书|规范|方案/.test(text);
}

/** K1②：需求是否仍处「需求评审阶段」——G3 对 authoring 任务的豁免区间。 */
export function isRequirementReviewStage(status) {
  return ['review', 'approved', 'requirement_review'].includes(String(status || ''));
}

/**
 * R-75ec：任务层 Owner 门禁的**唯一判定入口**。
 *
 * 口径（主正文 §七 + 增补卷 §二）：
 *   - 只认 `decisions` 里**最新一条**的 status ∈ approved/skipped/accepted → 通过；proxy 与 Owner 同权。
 *   - 无 `requirementId` → 放行（返回 null，调用方不写审计）。
 *   - 有 `requirementId` 但工作流没有该行（`row` 缺）→ 拒 `TASK_GATE_REQUIREMENT_MISSING`（脏数据不放行）。
 *   - **K1②：编写/设计类任务（type=task 的 doc/design）且需求仍处评审阶段 → 放行**（见 isAuthoringTask）。
 *   - 读失败由调用方判定 fail-closed（调用方传 row=null 且 readFailed=true）。
 *   - 其余一律拒 `TASK_GATE_NOT_APPROVED`，`cause ∈ {missing,pending,rejected}`。
 * 返回 null（放行）或 {code, gateCode, cause, gate, requirementId, taskId, missing, next, message}。
 */
export function taskGateOf({ task, row = null, readFailed = false } = {}) {
  const requirementId = String((task && task.requirementId) || '');
  const taskId = String((task && task.id) || '');
  if (!requirementId) return null;
  // K1②：编写/设计类任务在需求仍处「需求评审」阶段豁免 G3——否则「派分析师写正文 / 产品做设计」
  // 在 Owner 未落账前被自己的需求号自锁（今天实际被绊：写正文任务 task done 报 TASK_GATE_NOT_APPROVED）。
  if (!readFailed && row && isAuthoringTask(task) && isRequirementReviewStage(row.status)) return null;
  const base = { gate: 'G3', gateCode: 'TASK_GATE_NOT_APPROVED', requirementId, taskId, attempted: 'task_gate' };
  if (readFailed) {
    return {
      ...base, code: 'TASK_GATE_NOT_APPROVED', cause: 'missing',
      missing: ['工作流.json 读取失败（fail-closed）'],
      next: '先修 工作流.json（备份后修），读失败不放行',
      message: `任务 ${taskId} 的 Owner 门判定失败：工作流读取异常，按纪律拒绝`,
    };
  }
  if (!row) {
    return {
      ...base, code: 'TASK_GATE_REQUIREMENT_MISSING', gateCode: 'TASK_GATE_REQUIREMENT_MISSING', cause: 'missing',
      missing: ['工作流里没有该需求行'],
      next: '先修工作流行（req register / req review 重建），脏数据不放行',
      message: `任务 ${taskId} 绑的需求 ${requirementId} 在工作流里不存在；按纪律拒绝`,
    };
  }
  // B-20261116-105620：只认「绑当前正文版本」的决定——旧决定不得让新版本开工。
  const latest = currentDecisionOf(row);
  const status = String((latest && (latest.status || latest.decision)) || '');
  const rowStatus = String(row.status || '');
  // B-4226：iteration（返工轮）不是终态——它对任务的拦截只由「最新 Owner 决定是否绑当前正文」决定，
  // 否则产品重评通过、Owner 重批后任务仍被 TASK_GATE_NOT_APPROVED 挡死。terminated/rejected 仍按收口拦。
  const closedBad = ['terminated', 'rejected'].includes(rowStatus);
  if (!closedBad && ['approved', 'skipped', 'accepted'].includes(status)) return null;
  // B-20261117-132015-3b44：区分 stale 与 missing——「有旧版批准但正文已改版」应报 stale（需重评），
  // 只有「从未落过决定」才是 missing。以前两者都报 missing（cause=missing），误导为「Owner 没批过」。
  const ownerReviewStale = ownerReviewStaleOf(row);
  const cause = (status === 'rejected' || closedBad || status === 'terminated')
    ? 'rejected' : (status ? 'pending' : (ownerReviewStale ? 'stale' : 'missing'));
  // B-20261115-123038-2e24：拒绝时把「ownerReview 的上次决定是否绑旧版」一并透出——
  const staleHint = ownerReviewStale
    ? `；ownerReview 上次决定绑旧版正文（${ownerReviewStale.staleSha12 || '无版本凭据'}），需重新评审`
    : '';
  // B-20261117-190411-b75c：失效时必须「可操作」——给差异摘要 + 修复命令示例，不能只说「决定失效」。
  const repair = cause === 'stale' ? {
    summary: `决定绑的正文版本与当前不一致（sha ${ownerReviewStale && ownerReviewStale.staleSha12 ? ownerReviewStale.staleSha12 : '无凭据'} → 当前 ${currentRequirementVersionOf(row).slice(0, 12) || '未知'}）`,
    // 只差程序维护行（## 状态记录 / - 状态：）时 contentHash 相同，本不该拦：先 audit 区分「仅元数据」与「实质改文」。
    auditCommand: `node 团队/工具/team.mjs req audit --project <项目> --requirement ${requirementId}`,
    auditHint: '审计里出现 DOC_CONTENT_DRIFT 且标注「仅元数据差异」= 不该拦，属判定口径问题；实质改文才是真旧版',
    repairCommand: `node 团队/工具/team.mjs req doc repair --project <项目> --requirement ${requirementId} --from-backup <备份文件路径> --reason "恢复正文到决定绑定版本"`,
  } : null;
  return {
    ...base, code: 'TASK_GATE_NOT_APPROVED', cause,
    missing: [cause === 'missing' ? 'Owner 决定未落账' : 'Owner 未通过（' + (status || rowStatus) + '）'],
    next: cause === 'stale'
      ? '先跑 req audit 区分「仅元数据差异」与「实质改文」；实质改文需 Owner/PM 重落决定，或用 req doc repair 恢复正文'
      : '先让需求过 Owner 门（owner confirm / 代管落账），未通过不许开工',
    ...(ownerReviewStale ? { ownerReviewStale } : {}),
    ...(repair ? { repair } : {}),
    message: `需求 ${requirementId} 未过 Owner 门（${cause}）${staleHint}；任务 ${taskId} 不许开工/收工${repair ? `\n差异摘要：${repair.summary}\n排查：${repair.auditCommand}（${repair.auditHint}）\n修复示例：${repair.repairCommand}` : ''}`,
  };
}

/** G3：Owner 已落账（approved/skipped），或明确拒绝（rejected）。 */export function gateOwnerDecision(row) {
  // B-20261115-123038-2e24：ownerReview 投影（旧版决定 → pending + stale），随拒绝结果透出。
  const ownerReviewStale = ownerReviewStaleOf(row);
  const staleFields = ownerReviewStale ? { ownerReviewStale } : {};
  const staleHint = ownerReviewStale
    ? `；ownerReview 上次决定绑旧版正文（${ownerReviewStale.staleSha12 || '无版本凭据'}），需重新评审`
    : '';
  // B-20261116-105620：旧版本的决定不算已决定（详见 decisionIsCurrent）。
  const latest = currentDecisionOf(row);
  if (!latest) {
    return {
      code: 'OWNER_REVIEW_REQUIRED', gate: 'G3', reason: 'missing', missing: ['Owner 决定未落账'],
      next: '让 Owner 在界面/终端确认（owner confirm → owner）',
      ...staleFields,
      message: `需求还没有 Owner 决定（decisions 为空）${staleHint}；先让 Owner 在界面或终端确认`,
    };
  }
  const status = String(latest.status || latest.decision || '');
  if (status === 'rejected') {
    return {
      code: 'OWNER_REVIEW_REQUIRED', gate: 'G3', reason: 'rejected', missing: ['Owner 已打回'],
      next: '打回的需求不能派单；先重走需求评审',
      ...staleFields,
      message: `Owner 已打回该需求${staleHint}，禁止派单；须重走评审并产生新的 Owner 决定`,
    };
  }
  if (!['approved', 'skipped', 'accepted'].includes(status)) {
    return {
      code: 'OWNER_REVIEW_REQUIRED', gate: 'G3', reason: 'pending', missing: [`最新 Owner 决定是 ${status || 'pending'}`],
      next: '等 Owner 决定通过/跳过',
      ...staleFields,
      message: `最新 Owner 决定是 ${status || 'pending'}${staleHint}；先等 Owner 决定`,
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

/**
 * B-20261115-123038-2e24：ownerReview **投影**（只读，不参与 G3 判定，供展示/审计/写路径统一口径）。
 * 真值仍是 decisions[]：currentDecisionOf/taskGateOf 的判定不变；这里只把「ownerReview 应该长什么样」算出来，
 * 避免各处再各写一套（旧版决定 → pending + stale:true + staleSha12，不许静默显示成「从未评审」）。
 */
export function ownerReviewViewOf(row, currentVersion) {
  return ownerReviewView(row, currentVersion);
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
  // R-d225 F-reopen-4/AC5：返工把 trq.verdictStale 置 true 后，旧 testable 结论不得静默复用。
  if (found && found.verdict === 'testable' && found.verdictStale) {
    return {
      code: 'TESTABILITY_REVIEW_REQUIRED', gate: 'G2.5', reason: 'stale',
      missing: ['返工后需重做可测性评审（TR-Q）'], file: found.file, trq: found,
      next: '返工后旧 TR-Q 结论已失效：重跑 req trq 后再开门',
      message: `需求 ${task && task.id} 的 TR-Q 结论因返工已失效（verdictStale）；请重做可测性评审`,
    };
  }
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
    // K1①（T-20261119-165257-5203）：soft/hard 语义统一 —— 本函数只表达「有没有证据」：
    //   soft:true  = 无证据（是否阻断由调用方按 项目.json.gates 决定，auto 只审计、hard 才 gateFail、off 跳过）；
    //   soft:false = 有证据但缺签字/approve（硬缺陷，与配置无关）。
    return { code: mode === 'fast' ? 'TECH_REVIEW_REQUIRED' : 'PRODUCT_DESIGN_REQUIRED', gate: mode === 'fast' ? 'G4f' : 'G4', soft: true, missing: [mode === 'fast' ? '技术评审记录/设计依据' : '产品设计文档'], next: mode === 'fast' ? '先跑 req review --kind tech' : '先提交产品设计并走 propose→review→sign→apply', message: '缺少设计/评审证据（是否阻断由 gates 配置决定）' };
  }
  const tr = task && task.workflow ? task.workflow.techReview : null;
  if (mode === 'fast') {
    if (!tr || String(tr.verdict || '') !== 'approve') {
      return {
        code: 'TECH_REVIEW_REQUIRED', gate: 'G4f', soft: false, missing: ['技术评审 approve'], designFile: evidence.rel,
        next: '先跑 req review --kind tech --verdict approve',
        message: `fast 项目缺少技术评审 approve；先跑 req review --kind tech`,
      };
    }
    return null;
  }
  const design = resolveDesignSignature({ task, state, evidence, commits });
  if (!design) {
    return {
      code: 'PRODUCT_DESIGN_REQUIRED', gate: 'G4', soft: false, missing: ['产品设计评审/签字'], designFile: evidence.rel,
      next: '产品设计需 propose→review→sign→apply；apply 会自动写项目 designReview（也可查提交记录）',
      message: '产品设计已存在但找不到签字证据（项目 designReview / 设计提交记录都没有）；先走设计提交与签字',
    };
  }
  if (design.sha256 && design.sha256 !== evidence.sha256) {
    return {
      code: 'PRODUCT_DESIGN_REQUIRED', gate: 'G4', soft: false, reason: 'stale', missing: ['设计已变但签字针对旧版'],
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

/**
 * G7：测试报告——测试任务 done 前必须有对应报告。
 *
 * B-20261119-194559-1aed（PM 2026-11-19 裁定「改工具」）：
 *   · 带需求绑定的任务只认 **该需求自己的目录** `测试人员/产出/测试报告/<需求id>/v<N>.md`
 *     （文件名只留版本号，取版本号最大的一份），且**正文首行必须写明该需求 id**；
 *   · 无需求绑定的任务沿用历史口径 `测试人员/产出/测试报告-v<N>.md`（按 mtime 取最新一份）；
 *   · 历史报告不改写、不迁移：旧口径文件仍在原处，新口径按目录隔离，互不遮蔽。
 */
/**
 * T-20261119-221909-1914：**场景矩阵软门**（Owner 拍板「先做软门」）。
 *
 * 扫证据报告正文的六类关键词（§H H3 场景矩阵）：入口 / 正常 / 空值或边界 / 失败或异常 / 并发或重复 / 降级或恢复。
 * 语义：**缺项只审计 + advisory，不 fail**（soft:true）；只有 `TEAM_SCENE_ENFORCE=1` 才作为硬门。
 * 返回 null = 六类齐（无需审计）；否则 {code,soft,missing,filled,total}。
 */
export const SCENE_MATRIX_CLASSES = [
  { key: 'entry', label: '入口', re: /入口|触发路径|从哪进|从哪儿进|点进|打开路径/ },
  { key: 'happy', label: '正常', re: /正常|正向|happy\s*path|顺利/ },
  { key: 'edge', label: '空值/边界', re: /空值|边界|为空|空串|0\s*条|零条|超长|极端值/ },
  { key: 'fail', label: '失败/异常', re: /失败|异常|报错|错误码|超时|不可用/ },
  { key: 'concurrent', label: '并发/重复', re: /并发|重复|幂等|连点|重入|二次/ },
  { key: 'degrade', label: '降级/恢复', re: /降级|恢复|回滚|兜底|重试/ },
];

export function sceneMatrixOf(text) {
  const body = String(text || '');
  const filled = [];
  const missing = [];
  for (const cls of SCENE_MATRIX_CLASSES) {
    if (cls.re.test(body)) filled.push(cls.key); else missing.push(cls.key);
  }
  return { filled, missing, total: SCENE_MATRIX_CLASSES.length };
}

export function gateSceneMatrix({ text = '', enforce = null } = {}) {
  const enforced = enforce === null ? String(process.env.TEAM_SCENE_ENFORCE || '') === '1' : Boolean(enforce);
  const m = sceneMatrixOf(text);
  if (!m.missing.length) return null;
  const labels = m.missing.map((k) => (SCENE_MATRIX_CLASSES.find((c) => c.key === k) || {}).label || k);
  return {
    code: 'SCENE_MATRIX_MISSING',
    gate: 'G-scene',
    soft: !enforced,
    enforced,
    missing: m.missing,
    missingLabels: labels,
    filled: m.filled,
    total: m.total,
    message: `场景矩阵缺 ${m.missing.length}/${m.total} 类：${labels.join('、')}（§H H3 六类：入口/正常/空值边界/失败异常/并发重复/降级恢复）`,
    next: '在实现说明里补「场景×结果×证据」表，覆盖缺的类别（软门只提示；下版转硬门）',
  };
}

export function gateTestReport({ projectPath, task, requirementId }) {
  const base = path.join(path.resolve(projectPath), '测试人员', '产出');
  const reqId = String(requirementId || '').trim();
  if (reqId) {
    const relDir = `测试人员/产出/测试报告/${reqId}`;
    const dir = path.join(base, '测试报告', reqId);
    let names = [];
    try { names = fs.readdirSync(dir).filter((name) => /^v\d+\.md$/i.test(name)); } catch { names = []; }
    if (names.length) {
      const rows = names.map((name) => ({
        name,
        version: Number((/^v(\d+)\.md$/i.exec(name) || [])[1] || 0),
        mtime: fs.statSync(path.join(dir, name)).mtimeMs,
      })).sort((a, b) => (b.version - a.version) || (b.mtime - a.mtime));
      const top = rows[0];
      const rel = `${relDir}/${top.name}`;
      const text = readText(path.join(dir, top.name), '');
      const firstLine = String(text.split(/\r?\n/)[0] || '');
      if (!firstLine.includes(reqId)) {
        return {
          code: 'TEST_REPORT_REQUIRED', gate: 'G7', missing: [`报告首行未写明需求 ${reqId}`], file: rel, requirementId: reqId,
          next: `把 ${rel} 首行改成「# 测试报告 · ${reqId} …」再 task done`,
          message: `报告首行没有写明需求 id ${reqId}（首行为：${firstLine.slice(0, 60)}）`,
        };
      }
      if (!/PASS|FAIL|通过|不通过/i.test(text)) {
        return {
          code: 'TEST_REPORT_REQUIRED', gate: 'G7', missing: ['测试报告缺 PASS/FAIL 结论'], file: rel, requirementId: reqId,
          next: '补明确结论后再 task done',
          message: '测试报告没有明确 PASS/FAIL 结论',
        };
      }
      return null;
    }
    // 新口径目录还没报告时，回退历史口径（不改写历史报告；老项目/老任务不被误拦）——
    // 一旦该需求目录里出现 vN.md，就只认它，不再看全局最新那份（消除遮蔽）。
  }
  // 无需求绑定，或该需求的新口径目录里还没有报告：沿用历史口径（测试人员/产出/测试报告-v<N>.md，mtime 最新一份）
  let names = [];
  try { names = fs.readdirSync(base).filter((name) => /^测试报告-v\d+\.md$/i.test(name)); } catch { names = []; }
  if (!names.length) {
    return {
      code: 'TEST_REPORT_REQUIRED', gate: 'G7', soft: true, missing: ['测试报告'], requirementId,
      next: reqId
        ? `补 测试人员/产出/测试报告/${reqId}/v1.md（首行写需求 ${reqId}）或历史口径 测试人员/产出/测试报告-vN.md`
        : '补 测试人员/产出/测试报告-vN.md（含 PASS/FAIL 结论）',
      message: '还没有测试报告（仅审计，不阻断）',
    };
  }
  const rows = names.map((name) => ({ name, mtime: fs.statSync(path.join(base, name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
  const text = readText(path.join(base, rows[0].name), '');
  if (reqId && !text.includes(reqId)) {
    return {
      code: 'TEST_REPORT_REQUIRED', gate: 'G7', missing: [`测试报告未覆盖需求 ${reqId}`], file: `测试人员/产出/${rows[0].name}`, requirementId: reqId,
      next: `改历史报告（不推荐）或新建 测试人员/产出/测试报告/${reqId}/v1.md（首行写需求 id）`,
      message: `历史口径最新报告没有覆盖需求 ${reqId}`,
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
  const open = (tasks || []).filter((task) => task && !statusIsClosed(task.status) && task.type !== 'requirement');
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
 * 任务层终态集合（B-dd67 / B-b894）：done=已完成、accepted=已验收、cancelled=已取消、terminated=已终止。
 * 这四种都不该再占角色名额、也不该再挡需求推进——历史缺陷单验收后仍是 accepted，
 * 被作废/终止的任务是 terminated，若不排除，G5 会让角色永久「忙」、
 * 验收前置会一直报「还有 N 条测试任务没 done」（62b9 现场：B-6029 accepted + T-a588 cancelled）。
 * 只把真在办的（open/working/…）算未闭环；判定按「不在终态集合里」= 未闭环，避免新增状态漏判。
 */
export const CLOSED_TASK_STATUSES = Object.freeze(['done', 'accepted', 'cancelled', 'terminated']);

/** 任务状态是否已闭环（B-b894：唯一口径，ops.mjs 与验收前置都必须用它，不要各写一套数组）。 */
export function statusIsClosed(status) {
  return CLOSED_TASK_STATUSES.includes(String(status || ''));
}

/** 任务是否已闭环（终态仍可扩展，但调用方只关心「还占不占角色」）。 */
export function taskIsClosed(task) {
  return statusIsClosed(task && task.status);
}

/* ── R-20261119-155015-0d97：列表默认视图的唯一实现（task list / req list / inbox / boot 简报共用） ── */

/** §6.2：单次默认上限（三处同源）。 */
export const LIST_DEFAULT_MAX = 50;
/** §6.3：`--limit` 的合法上限。 */
export const LIST_LIMIT_MAX = 2000;

/**
 * §6.3：`--limit` 解析。返回数字 = 合法；返回 `null` = 非法（调用方 fail `BAD_LIMIT`，零副作用）。
 * 缺省/布尔占位（CLI 把裸 `--limit` 解析成 true）回落默认 50，不当作非法。
 */
export function parseListLimit(raw, fallback = LIST_DEFAULT_MAX) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return fallback;
  const text = String(raw).trim();
  if (!text) return fallback;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > LIST_LIMIT_MAX) return null;
  return n;
}

/**
 * §6.3：`--limit` 的「是否显式给出」归一。
 * 返回 `null` = 未给（由 `--all` 决定上限）；数字 = 显式上限；`'BAD'` = 非法。
 */
export function resolveListLimit(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'boolean') return null; // 裸 --limit（CLI 布尔占位）视为未给
  const text = String(raw).trim();
  if (!text) return null;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > LIST_LIMIT_MAX) return 'BAD';
  return n;
}

/**
 * §6.2 / §6.5：列表视图与截断提示行的**唯一生成器**（全仓唯一含「默认隐藏」文案模板的落点）。
 *
 * 入参：
 *  - rows     当前视图的**可见候选行**（默认视图=已按 `!statusIsClosed` 过滤；`--all`/显式过滤=全量或过滤后全量）
 *  - hidden   被默认视图隐藏的条数（任务=闭环数 / inbox=已读 cur 数 / req list=0；显式过滤与 `--all` 时调用方必须传 0）
 *  - all      `--all`：未显式给 `--limit` 时不设上限（§6.3 A 案）
 *  - limit    显式上限（`null`=未给）；`--all --limit N` 时仍以 N 为上限（§6.3「叠加」）
 *  - unit     'task' | 'inbox' | 'req'（只有 task 面在提示里带状态父括号）
 *  - explicit 是否给了显式过滤器（仅用于 `--json.filter` 归因）
 *
 * 返回：`{ rows, total, shown, hidden, truncated, limit, filter, notice }`
 *  - `total = rows.length + hidden`（§6.2「共 N 条」= 当前视图口径的总数，保证 shown + hidden ≤ total）
 *  - `notice` 仅在 `truncated || hidden > 0` 时非空（§6.2 唯一输出条件）
 */
export function applyListView({ rows, hidden = 0, all = false, limit = null, unit = 'task', explicit = false } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const hiddenCount = Math.max(0, Number(hidden) || 0);
  const explicitLimit = (limit === null || limit === undefined) ? null : Math.max(1, Number(limit) || LIST_DEFAULT_MAX);
  const cap = explicitLimit === null ? (all ? Infinity : LIST_DEFAULT_MAX) : explicitLimit;
  const total = list.length + hiddenCount;
  const shown = Math.min(list.length, cap);
  const truncated = list.length > shown;
  const visible = truncated ? list.slice(0, shown) : list;
  const filter = all ? 'all' : (explicit ? 'explicit' : 'default');
  let notice = '';
  if (truncated || hiddenCount > 0) {
    const note = unit === 'task' ? '（done/accepted/cancelled/terminated）' : '';
    const hiddenPart = hiddenCount > 0 ? `；默认隐藏 ${hiddenCount} 条${note}` : '';
    notice = `…（共 ${total} 条${hiddenPart}；已显示前 ${shown} 条。加 --all 看全量，或 --limit <N> 放大本页）`;
  }
  return {
    rows: visible,
    total,
    shown,
    hidden: hiddenCount,
    truncated,
    limit: cap === Infinity ? null : cap,
    filter,
    notice,
  };
}

/** §6.6：待验收(done) 计数行文案（唯一落点）。 */
export function donePendingLine(n) {
  const count = Number(n) || 0;
  return count > 0 ? `待验收(done): ${count}` : '';
}

/**
 * B-4c66：镜像任务识别——需求在 `任务/` 里的镜像行（`type=requirement`，任务 id 与 requirementId 同名）。
 * 它不是「角色在办的活」：随需求行永久存在、状态长期 open，把它算进「角色忙」会让角色永久接不了新活，
 * 路由守护还会每拍判「他还有活」反复唤醒（分析师实测每次唤醒重发约 40 万 token 上下文）。
 */
export function isRequirementMirrorTask(task) {
  if (!task) return false;
  const id = String(task.id || '');
  const reqId = String(task.requirementId || '');
  if (String(task.type || '') === 'requirement') return true;
  return Boolean(id && reqId && id === reqId);
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
    // B-4c66：镜像任务（type=requirement / id===requirementId）不是「在办任务」，不算忙。
    if (isRequirementMirrorTask(task)) return false;
    // B-dd67：done/accepted/cancelled 都是终态，不再算未闭环（accepted 原先被算成忙，角色永久接不了新活）。
    if (taskIsClosed(task)) return false;
    // R-75ec：被 Owner 门冻结（blocked）的任务不占角色——角色已被要求停手，不能再因此挡住新派单。
    if (String(task.status || '') === 'blocked') return false;
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
  // K1③（T-20261119-165257-5203）：**编写/设计类任务不算「子任务证据」**。
  // 场景：需求已 ready（可以派开发），但挂在该需求下的「写正文/做设计」任务已完成未结单（还是 working/open），
  // 旧口径会把它算成 open 子任务 → expected=requirement_review → 需求 ready 被判 G8 跳步，把开发派单挡住。
  // 编写类活本来就不该挂 requirementId（见《流程.md》固化条目），历史数据已挂的按此豁免。
  const kids = (Array.isArray(tasks) ? tasks : []).filter((task) => task
    && String(task.type || '') !== 'requirement'
    && String(task.requirementId || '') === requirementId
    && !isAuthoringTask(task));
  if (!kids.length) return null;
  const open = kids.filter((task) => !statusIsClosed(task.status));
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
