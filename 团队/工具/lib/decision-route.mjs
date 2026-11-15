// R-5016 决策收口（工具侧单源）：三入口分流 + 七要素校验 + guard 转投审计 + 漏箱检测 + 计数同源
//
// 口径来源：需求/R-20261115-121354-5016-决策收口自动化.md（15853B / sha256 2cf3d7d1cfa9）
//          需求/增补卷-5016-1.md（4855B / 77383d850f94，TR-Q 六项定稿）
//
// 本文件只做"去哪 / 齐不齐 / 记没记 / 漏没漏"四件事，不产生任何决定：
//   ① routeOwnerAsk(ask)   单点分流（4 条规则，ruleId 可复算，无匹配默认入箱）
//   ② validateAsk(ask)     七要素校验（source/summary/question/options(2–4)/defaultChoice/impact/dueAt）
//   ③ appendRouteAudit()   决策收口.jsonl（9 键；redirect/reject/route/answer/miss）
//   ④ detectMissedAsks()   漏箱检测（阈值分钟可配、时钟可注入）+ 日报 漏箱-YYYYMMDD.md
//   ⑤ ownerPendingCounts() 三入口同源互斥计数（壳层 IPC 只转发这一份）
import fs from 'node:fs';
import path from 'node:path';
import { fail, nowIso, exists, ensureDir, appendLine, readJson, writeText } from './core.mjs';
import { loadProject, projectStatePaths, listTasks, listInbox } from './store.mjs';
import { readWorkflowState } from './lifecycle.mjs';
import { readDecisionBox, decisionBoxPath, addDecision } from './decision-box.mjs';
import { ROLE_NAMES } from './roles.mjs';

export const DECISION_ROUTE_RULE = 'R-5016/v1';
/** 分流目标（写死三选一，界面锚点见增补卷 §二）。 */
export const DECISION_TARGETS = ['decision_box', 'review_dialog', 'accept_list'];
/** 入口锚点（契约值，界面/CLI 都引用这里）。 */
export const DECISION_TARGET_ANCHORS = {
  review_dialog: '#owner-review',
  accept_list: '#accept-list',
  decision_box: '#decision-box-pill',
};
/** 意图词（评审/验收类动作）——只在这里维护一份，CLI/界面/测试都引用。 */
export const REVIEW_INTENT_WORDS = ['通过', '打回', '驳回', '跳过', '批准', '验收', 'approve', 'reject', 'accept', 'skip'];
/** 选项全为这类词 → 判评审动作（F-2 ①）。 */
export const REVIEW_GATE_OPTIONS = new Set(['通过', '打回', '驳回', '跳过', '批准', '验收', '同意', '不同意', 'approve', 'reject', 'accept', 'skip']);
/** 取舍/优先级等决策类 kind（F-2 ③）。 */
export const DECISION_KINDS = ['口径', '取舍', '优先级', '阻塞', '风险', '资源'];
/** 七要素（TR-Q⑥ 统一措辞）。 */
export const ASK_FIELDS = ['source', 'summary', 'question', 'options', 'defaultChoice', 'impact', 'dueAt'];
export const ASK_OPTIONS_MIN = 2;
export const ASK_OPTIONS_MAX = 4;
/** 漏箱"拍板问句"词表（F-7）：只用于**正文/主题文案**的二次确认，不再作为"是不是 Owner 问句"的判据。 */
export const OWNER_ASK_WORDS = ['要不要', '是否', '能否', '怎么办', '怎么选', '继续还是停', '何时', '谁来决定', '拍板', '你定', '请示'];
/**
 * PM 2026-11-15 有条件确认①：漏箱扫描**只认消息类型**，不靠标题猜。
 * `owner_ask` 已登记进 dispatch.mjs 的 WAKE_KIND_LABEL（唯一类型登记表），未登记类型 send 会被 MSG_TYPE_UNKNOWN 拒。
 */
export const OWNER_ASK_MESSAGE_TYPES = ['owner_ask'];
/** 决策收口审计固定 9 键（F-10；含 reason）。 */
export const DECISION_ROUTE_AUDIT_KEYS = ['at', 'actor', 'action', 'askId', 'target', 'ruleId', 'code', 'note', 'reason'];

function clip(text, max) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * F-1 分流器：只按结构化字段判定，返回 {target, ruleId, reason, redirect?}。
 * ask 形状：{kind, question, summary, title, options[], requirementStatus, action}
 * 规则优先级：R-REVIEW-INTENT → R-ACCEPT-STATE → R-DECISION-KIND → R-DEFAULT。
 */
export function routeOwnerAsk(ask = {}) {
  const input = ask && typeof ask === 'object' ? ask : {};
  const text = [input.title, input.summary, input.question].filter(Boolean).join(' ');
  const options = Array.isArray(input.options) ? input.options.map((x) => String(x).trim()).filter(Boolean) : [];
  const status = String(input.requirementStatus || '').trim();
  const action = String(input.action || '').trim();
  // 规则②前置（只对 test_done + 确认/验收 这种组合）：否则「验收」会被规则①的意图词吃掉，
  // accept_list 永远不可达（AC1 要求「test_done 需求确认 → accept_list」）。其余情况仍按 ①→③→④。
  if (status === 'test_done' && (action === '确认' || action === '验收' || /确认|验收/.test(String(input.question || '')))) {
    return {
      target: 'accept_list', ruleId: 'R-ACCEPT-STATE',
      reason: `关联需求已是 test_done，动作是「${action || '确认/验收'}」`,
      redirect: { to: 'accept_list', anchor: DECISION_TARGET_ANCHORS.accept_list },
    };
  }
  const gateHit = REVIEW_INTENT_WORDS.filter((word) => text.toLowerCase().includes(String(word).toLowerCase()));
  const allGate = options.length >= 2 && options.every((row) => REVIEW_GATE_OPTIONS.has(row));
  if (gateHit.length || allGate) {
    return {
      target: 'review_dialog', ruleId: 'R-REVIEW-INTENT',
      reason: gateHit.length
        ? `命中评审/验收意图词：${[...new Set(gateHit)].join('、')}`
        : '选项全是通过/打回类动作',
      redirect: { to: 'review_dialog', anchor: DECISION_TARGET_ANCHORS.review_dialog },
    };
  }
  const kind = String(input.kind || '').trim();
  if (DECISION_KINDS.includes(kind)) {
    return { target: 'decision_box', ruleId: 'R-DECISION-KIND', reason: `kind=${kind} 属取向类拍板` };
  }
  return { target: 'decision_box', ruleId: 'R-DEFAULT', reason: '无匹配规则：默认入箱（宁可多问不可漏问）' };
}

/**
 * F-3 七要素校验：返回 {ok, missing[], ask}；任一失败 **不写任何文件**（调用方先校验后落盘）。
 * 入参接受 CLI 风格（sourceKind/sourceRef、default、due）与结构化（source{kind,ref}、defaultChoice、dueAt）。
 */
export function validateAsk(ask = {}, { now = Date.now() } = {}) {
  const input = ask && typeof ask === 'object' ? ask : {};
  const missing = [];
  const sourceKind = String((input.source && input.source.kind) || input.sourceKind || '').trim();
  const sourceRef = String((input.source && input.source.ref) || input.sourceRef || '').trim();
  if (!sourceKind || !sourceRef) missing.push('source');
  const summary = clip(input.summary, 400);
  if (!summary) missing.push('summary');
  const question = clip(input.question, 400);
  if (!question) missing.push('question');
  const options = (Array.isArray(input.options) ? input.options : String(input.options || '').split(/[,，|]/))
    .map((row) => clip(row, 40)).filter(Boolean);
  if (options.length < ASK_OPTIONS_MIN || options.length > ASK_OPTIONS_MAX) missing.push('options');
  else if (new Set(options).size !== options.length) missing.push('options');
  const defaultChoice = clip(input.defaultChoice || input.default, 40);
  if (!defaultChoice) missing.push('defaultChoice');
  else if (options.length && !options.includes(defaultChoice)) missing.push('defaultChoice');
  const impact = clip(input.impact, 200);
  if (!impact) missing.push('impact');
  const dueAtRaw = String(input.dueAt || input.due || '').trim();
  if (!dueAtRaw) missing.push('dueAt');
  else {
    const dueMs = Date.parse(dueAtRaw);
    if (!Number.isFinite(dueMs)) missing.push('dueAt');
    else if (dueMs < now) {
      // 过期 dueAt 拒收（边界-异常：DECISION_DUE_PASSED，单独码，不算七要素缺项）
      return { ok: false, code: 'DECISION_DUE_PASSED', missing: [], message: `dueAt 已过期：${dueAtRaw}`, ask: null };
    }
  }
  if (missing.length) {
    return {
      ok: false, code: 'DECISION_FIELDS_INCOMPLETE', missing,
      message: `七要素缺项：${missing.join('、')}；一条都不落盘`,
      ask: null,
    };
  }
  return {
    ok: true, code: 'OK', missing: [],
    ask: {
      source: { kind: sourceKind, ref: sourceRef },
      summary, question, options, defaultChoice, impact, dueAt: new Date(Date.parse(dueAtRaw)).toISOString(),
    },
  };
}

/** 决策收口.jsonl（9 键固定；append-only）。 */
export function decisionRouteAuditPath(projectName) {
  return path.join(projectStatePaths(String(projectName)).dir, '决策收口.jsonl');
}

export function appendDecisionRouteAudit(projectName, row = {}) {
  const safe = row && typeof row === 'object' ? row : {};
  const out = {};
  for (const key of DECISION_ROUTE_AUDIT_KEYS) out[key] = Object.prototype.hasOwnProperty.call(safe, key) ? safe[key] : null;
  out.at = out.at || nowIso();
  out.actor = out.actor || 'system';
  out.action = out.action || 'route';
  out.askId = out.askId || null;
  out.target = out.target || null;
  out.ruleId = out.ruleId || null;
  out.code = out.code || null;
  out.note = out.note || '';
  out.reason = out.reason || '';
  const file = decisionRouteAuditPath(projectName);
  try {
    appendLine(file, JSON.stringify(out));
  } catch (e) {
    // 降级：审计不可写 → 拒绝该动作（fail-closed，边界-降级）
    fail('DECISION_AUDIT_UNWRITABLE', `审计不可写：${file}（${e && e.message}）；本次动作已拒绝`, { file }, 2);
  }
  return { file, row: out };
}

export function readDecisionRouteAudit(projectName) {
  const file = decisionRouteAuditPath(projectName);
  if (!exists(file)) return { file, rows: [] };
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    try { rows.push(JSON.parse(text)); } catch { /* 坏行跳过，不阻断读取 */ }
  }
  return { file, rows };
}

/**
 * F-8 三入口同源互斥计数：{decisions, reviews, accepts}。
 * 互斥口径（§七-4）：test_done 未验收 → accepts；评审未决 → reviews；其它待拍板 → decisions。
 * 同一条需求只会落进一个桶（先判 accepts，再判 reviews，最后 decisions 只数决策箱条目）。
 */
export function ownerPendingCounts(projectName) {
  const name = String(projectName || '');
  if (!name) return { ok: false, code: 'BAD_PROJECT', decisions: 0, reviews: 0, accepts: 0 };
  // 决策箱：open 且有来源的条目都算"要 Owner 拍板"；MISS 占位也算（未处理就是待决）。
  let decisions = 0;
  try {
    const box = readDecisionBox(name);
    decisions = (box.box && Array.isArray(box.box.items) ? box.box.items : [])
      .filter((row) => row && String(row.status || '') === 'open').length;
  } catch { decisions = 0; }
  // 工作流：先算 accepts（test_done 未验收），再从 reviews 里剔除命中 accepts 的需求，保证互斥。
  const acceptIds = new Set();
  const reviewIds = new Set();
  try {
    const read = readWorkflowState(name);
    const rows = Object.values((read.state && read.state.requirements) || {});
    for (const row of rows) {
      if (!row) continue;
      const id = String(row.id || '');
      const status = String(row.status || '');
      if (status === 'test_done') { acceptIds.add(id); continue; }
      if (['owner_review', 'review', 'approved', 'tech_review', 'ready', 'dispatched'].includes(status)
        && row.ownerReview && String(row.ownerReview.status || '') === 'pending') {
        if (!acceptIds.has(id)) reviewIds.add(id);
      }
    }
  } catch { /* 工作流读不到 → 两个桶按 0 计，不冒充有值 */ }
  return {
    ok: true, project: name, rule: DECISION_ROUTE_RULE,
    decisions, reviews: reviewIds.size, accepts: acceptIds.size,
    // 互斥审计用（同一条需求不跨桶）
    decisionIds: null,
  };
}

/** 阈值分钟（AWB_DECISION_MISS_MINUTES，默认 30）。 */
export function decisionMissThresholdMinutes() {
  const raw = Number(process.env.AWB_DECISION_MISS_MINUTES);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30;
}

/** 拍板问句判定（词表集中维护）。 */
export function looksLikeOwnerAsk(text) {
  const value = String(text || '');
  if (!value) return [];
  return OWNER_ASK_WORDS.filter((word) => value.includes(word));
}

function missReportPath(projectName, dateText) {
  return path.join(projectStatePaths(String(projectName)).dir, `漏箱-${dateText}.md`);
}

/**
 * 收集 PM 发出的「问 Owner 拍板」消息（已落地消息，跨角色邮箱去重）。
 * PM 2026-11-15 有条件确认①：判据收窄为**消息类型** `owner_ask`（dispatch.mjs 已登记），
 * 不再用「标题含拍板/请示」这类脆弱判据；`criterion` 字段把本次用的判据回传给调用方，便于在报告里写明。
 */
export function collectPmAsks(projectName, { roles = [], types = OWNER_ASK_MESSAGE_TYPES } = {}) {
  const name = String(projectName || '');
  const roleList = roles.length ? roles : Object.keys(ROLE_NAMES);
  const typeSet = new Set((types || OWNER_ASK_MESSAGE_TYPES).map((t) => String(t || '').toLowerCase()));
  const out = [];
  const seen = new Set();
  for (const role of roleList) {
    let inbox = null;
    try { inbox = listInbox(role, { includeCur: true, project: name }); } catch { inbox = null; }
    // listInbox 直接返回消息数组（不是 {messages}）；兼容两种形状，避免又踩一处静默空。
    const messages = Array.isArray(inbox) ? inbox : (inbox && Array.isArray(inbox.messages) ? inbox.messages : []);
    for (const msg of messages) {
      if (!msg || !msg.id) continue;
      if (String(msg.from || '') !== 'pm') continue;
      if (seen.has(msg.id)) continue;
      const type = String(msg.type || '').toLowerCase();
      if (!typeSet.has(type)) continue;
      seen.add(msg.id);
      out.push({
        id: msg.id, to: msg.to, type, ts: Date.parse(String(msg.ts || msg.deliveredAt || '')),
        // 词表只做"文案命中提示"（写进摘要给人看），不参与判定
        hits: looksLikeOwnerAsk(`${msg.subject || ''} ${msg.body || ''}`),
        subject: msg.subject || '', body: String(msg.body || '').slice(0, 200),
      });
    }
  }
  return out;
}

/**
 * F-7 漏箱检测 + F-9 日报：
 * 扫 PM 的"拍板问句"消息，超过阈值（默认 30 分钟）仍没有对应 `source.ref` 的入箱条目 →
 * 补录一条 `D-…-MISS`（missBox:true、ruleId:'R-MISS'），同一 source.ref 只补 1 条；
 * 同时写当日 `漏箱-YYYYMMDD.md`（无漏箱写「当日漏箱 0」）。
 */
export function detectMissedAsks(projectName, { now = Date.now(), minutes = decisionMissThresholdMinutes(), dryRun = false } = {}) {
  const name = String(projectName || '');
  if (!name) return { ok: false, code: 'BAD_PROJECT', missed: [], skipped: [] };
  loadProject(name);
  const thresholdMs = Math.max(0, Number(minutes) || 0) * 60 * 1000;
  const box = readDecisionBox(name);
  const items = box.box && Array.isArray(box.box.items) ? box.box.items : [];
  const knownRefs = new Set(items.map((row) => String((row.source && row.source.ref) || '')).filter(Boolean));
  const misses = items.filter((row) => row && row.missBox === true);
  const candidates = collectPmAsks(name);
  const criterion = 'message.type=owner_ask（登记在 dispatch.mjs WAKE_KIND_LABEL；不看标题/文案）';
  const missed = [];
  const skipped = [];
  for (const msg of candidates) {
    const age = now - (Number.isFinite(msg.ts) ? msg.ts : now);
    if (age < thresholdMs) continue;
    // 先判"已补录过 MISS"（同 source.ref 只补 1 条），再判"已在箱里"，
    // 否则补录产生的 MISS 条目会让第二次扫描报成 already_in_box（TR-Q 会按 already_missed 断言）。
    if (misses.some((row) => row.missBox === true && String((row.source && row.source.ref) || '') === msg.id)) {
      skipped.push({ messageId: msg.id, reason: 'already_missed' });
      continue;
    }
    if (knownRefs.has(msg.id)) { skipped.push({ messageId: msg.id, reason: 'already_in_box' }); continue; }
    if (dryRun) { missed.push({ messageId: msg.id, dryRun: true, hits: msg.hits }); continue; }
    // 补录：直接用现有 addDecision 落一条 missBox 占位（不写任务/工作流）。
    const created = addDecision(name, {
      title: clip(`漏箱补录：${msg.subject || '需 Owner 拍板的问题'}`, 40),
      summary: clip(`PM 在 ${String(new Date(msg.ts).toISOString()).slice(0, 19)} 发出的问句没进决策箱（命中：${msg.hits.join('、')}）`, 120),
      question: clip(`这条需要你拍板吗？原消息 ${msg.id}`, 200),
      options: ['补录进箱', '不需要，已自行处理'],
      source: { kind: 'message', ref: msg.id },
      by: 'system',
      idSuffix: '-MISS',
      extra: { missBox: true, ruleId: 'R-MISS', impact: 'Owner（需要拍板才可推进）', dueAt: null, defaultChoice: '补录进箱', origin: { kind: 'message', ref: msg.id, hitWords: msg.hits.join('、') } },
      skipGuards: true,
    });
    missed.push({ messageId: msg.id, decisionId: created.item.id, hits: msg.hits });
    appendDecisionRouteAudit(name, {
      actor: 'system', action: 'miss', askId: created.item.id, target: 'decision_box', ruleId: 'R-MISS',
      code: 'DECISION_MISS', note: `原消息 ${msg.id}`, reason: msg.hits.join('、'),
    });
  }
  // 日报：当日（按 now 的日期）一行一条；无漏箱写 0。
  const dateText = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
  const allMiss = items.filter((row) => row && row.missBox === true);
  const reportFile = missReportPath(name, dateText);
  const lines = [
    `# 漏箱报告 ${dateText}`,
    '',
    `- 生成：${new Date(now).toISOString()} ｜ 规则：${DECISION_ROUTE_RULE} ｜ 阈值：${minutes} 分钟`,
    `- 当日漏箱：${allMiss.length}`,
    '',
  ];
  if (!allMiss.length) lines.push('当日漏箱 0');
  else {
    lines.push('| 决策条目 | 原消息 | 命中词 | 状态 |');
    lines.push('|---|---|---|---|');
    for (const row of allMiss) {
      lines.push(`| ${row.id} | ${(row.source && row.source.ref) || '-'} | ${(row.origin && row.origin.hitWords) || '-'} | ${row.status} |`);
    }
  }
  if (!dryRun) {
    ensureDir(path.dirname(reportFile));
    writeText(reportFile, lines.join('\n') + '\n');
  }
  return {
    ok: true, project: name, rule: DECISION_ROUTE_RULE, minutes,
    thresholdMs, criterion, candidates: candidates.length, missed, skipped,
    totalMiss: allMiss.length, reportFile, dryRun: Boolean(dryRun),
  };
}
