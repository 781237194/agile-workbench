/**
 * R-9db6 v3：Owner 决策箱（团队工具侧）——存储 / ID / 同源去重 / 回执 / 静默兜底 / 异常。
 *
 * 真相：团队/状态/项目/<项目>/决策箱.json（schema 见需求 F-9db6-3）。
 * 只做工具侧：PM 放入、Owner 读与回执、回执消息（默认静默）、未读计数、静默兜底、损坏重建。
 * 门禁不在这里：回执不写 decisions[]、不改需求状态（F-9db6-8）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  PATHS, fail, nowIso, exists, ensureDir, readJson, writeJson, readText, truncate,
  acquireLock, releaseLock, lockInfo, appendEvent, randomHex, sha256,
} from './core.mjs';
import { projectStatePaths, loadProject, sendMessage, findMessage, listInbox } from './store.mjs';
import { writeJsonAtomic } from './json-atomic.mjs';
// R-5016 F-5：guard 转投要写「决策收口.jsonl」；审计实现单源在 decision-route.mjs（只在调用期引用，无初始化期循环依赖）。
import { appendDecisionRouteAudit, DECISION_TARGET_ANCHORS } from './decision-route.mjs';

export const DECISION_BOX_FILE = '决策箱.json';
export const DECISION_ID_RE = /^D-\d{8}-\d{6}-[0-9a-f]{4}$/;
export const DECISION_ID_MAX_TRIES = 10;
export const DEFAULT_RECEIPT_STALE_MS = 7200000; // 2 小时
export const RECEIPT_WAKE_THRESHOLD = 5;
const LOCK_TTL_MS = 10 * 1000;

export function decisionBoxPath(projectName) {
  return path.join(projectStatePaths(String(projectName || '').trim()).dir, DECISION_BOX_FILE);
}

export function emptyBox(projectName) {
  return {
    schema: 1,
    project: String(projectName || ''),
    items: [],
    meta: { receiptSeq: 0, lastWakeAt: '', lastWakeReceiptSeq: 0 },
    updatedAt: nowIso(),
  };
}

function normalizeBox(raw, projectName) {
  const box = raw && typeof raw === 'object' ? raw : {};
  return {
    schema: 1,
    project: String(box.project || projectName || ''),
    items: Array.isArray(box.items) ? box.items.filter((row) => row && row.id) : [],
    meta: {
      receiptSeq: Number((box.meta && box.meta.receiptSeq) || 0),
      lastWakeAt: String((box.meta && box.meta.lastWakeAt) || ''),
      lastWakeReceiptSeq: Number((box.meta && box.meta.lastWakeReceiptSeq) || 0),
    },
    updatedAt: String(box.updatedAt || ''),
    file: box.file,
  };
}

/** 读箱：不存在 → 空箱；损坏 → corrupt=true（由调用方决定备份重建，不在这里静默改文件）。 */
export function readDecisionBox(projectName) {
  const file = decisionBoxPath(projectName);
  if (!exists(file)) return { ok: true, exists: false, corrupt: false, box: emptyBox(projectName), file };
  try {
    const raw = JSON.parse(readText(file, '').replace(/^\uFEFF/, ''));
    if (!raw || typeof raw !== 'object') throw new Error('决策箱不是对象');
    return { ok: true, exists: true, corrupt: false, box: normalizeBox(raw, projectName), file };
  } catch (e) {
    return { ok: false, exists: true, corrupt: true, box: emptyBox(projectName), file, error: String((e && e.message) || e) };
  }
}

// R-ad44 AC5：决策箱写盘也走唯一写入口，并带 case 上下文（审计行 case 与入口一一对应）。
let currentWriteCase = '';
export function withDecisionWriteCase(name, fn) {
  const prev = currentWriteCase;
  currentWriteCase = String(name || '');
  return Promise.resolve().then(fn).finally(() => { currentWriteCase = prev; });
}

/** 写盘：原子写 + .bak-<时间戳>（F-9db6-3）；R-ad44 AC5：改走 json-atomic 唯一写入口（带 case）。 */
export function writeDecisionBox(projectName, box, opts = {}) {
  const file = decisionBoxPath(projectName);
  ensureDir(path.dirname(file));
  if (exists(file)) {
    try { fs.copyFileSync(file, `${file}.bak-${Date.now()}`); } catch { /* 备份失败不阻断写盘，但审计会缺一份 */ }
  }
  const next = { schema: 1, project: String(projectName || ''), items: box.items || [], meta: box.meta || {}, updatedAt: nowIso() };
  const caseName = (opts && opts.case) || currentWriteCase;
  try {
    writeJsonAtomic(file, next, caseName ? { case: caseName } : undefined);
  } catch (error) {
    // R-ad44 AC5：写盘失败不静默——留事件审计后原样抛出（调用方语义不变）。
    try { appendEvent({ role: 'system', action: 'decision_box_write_failed', project: String(projectName || ''), target: file, note: String((error && (error.code || error.message)) || error).slice(0, 200) }); } catch { /* 审计失败不掩盖原始错误 */ }
    throw error;
  }
  return { file, box: next };
}

/**
 * 写锁（TTL 10 秒）：并发写第二个 → DECISION_BOX_CONFLICT（F-9db6-9）。
 */
export function withDecisionBoxLock(projectName, fn) {
  const key = `决策箱-${projectName}`;
  try {
    acquireLock(key, { role: 'system', sessionId: 'decision-box', ttlMs: LOCK_TTL_MS, waitMs: 0, reason: '决策箱写' });
  } catch (e) {
    fail('DECISION_BOX_CONFLICT', '决策箱正被另一个操作写入（单文件锁 10 秒），请稍后重试', { project: projectName, holder: (e && e.details && e.details.holder) || null });
  }
  try {
    return fn();
  } finally {
    try { releaseLock(key, { role: 'system' }); } catch { /* 锁已过期 */ }
  }
}

/** 损坏重建：备份原文件 → 空列表 → 事件 → 返回备份路径（告警由调用方发）。 */
export function rebuildCorruptBox(projectName) {
  const file = decisionBoxPath(projectName);
  const backupPath = `${file}.bak-${Date.now()}`;
  try { if (exists(file)) fs.copyFileSync(file, backupPath); } catch { /* 备份失败仍重建，审计里注明 */ }
  const box = emptyBox(projectName);
  writeDecisionBox(projectName, box);
  try {
    appendEvent({
      role: 'system', sessionId: '', action: 'decision_box_rebuilt', project: projectName,
      target: DECISION_BOX_FILE, note: `backupPath=${backupPath}`, data: { event: 'decision_box_rebuilt', project: projectName, backupPath, at: nowIso() },
    });
  } catch { /* 事件失败不阻断重建 */ }
  return { backupPath, box };
}

function newDecisionId(projectName, box) {
  const stamp = (() => {
    const d = new Date(); const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  })();
  const used = new Set((box.items || []).map((row) => String(row.id)));
  for (let i = 0; i < DECISION_ID_MAX_TRIES; i += 1) {
    const id = `D-${stamp}-${randomHex(2)}`;
    if (!used.has(id)) return id;
  }
  fail('DECISION_BOX_ID_CONFLICT', `同一个 ${stamp} 内连续 ${DECISION_ID_MAX_TRIES} 次都没生成唯一 D-ID，放入失败（零落盘）`, { project: projectName, stamp });
}

const clean = (v, max) => truncate(String(v == null ? '' : v).trim(), max);

function validateSource(source) {
  const kind = String((source && source.kind) || '').trim();
  const ref = String((source && source.ref) || '').trim();
  if (!['message', 'file', 'requirement'].includes(kind) || !ref) {
    fail('DECISION_BOX_BAD_SOURCE', '来源必须是 {kind: message|file|requirement, ref: 非空}', { source });
  }
  return { kind, ref };
}

/**
 * PM 放入一条（F-9db6-2/3/3b）：标题≤40、摘要≤120、待决≤200、options 非空且互不重复；
 * 同 source.ref + 同 question 在 open 态拒绝重复（DECISION_BOX_DUPLICATE，零落盘）。
 */
export function addDecision(projectName, input = {}) {
  const title = clean(input.title, 40);
  const summary = clean(input.summary, 120);
  const question = clean(input.question, 200);
  const options = (Array.isArray(input.options) ? input.options : String(input.options || '').split(/[,，|]/))
    .map((row) => clean(row, 40)).filter(Boolean);
  if (!title) fail('DECISION_BOX_TITLE_REQUIRED', '需要 --title（≤40 字）');
  if (!question) fail('DECISION_BOX_QUESTION_REQUIRED', '需要 --question（≤200 字，写清要 Owner 决定什么）');
  if (options.length < 2) fail('DECISION_BOX_OPTIONS_REQUIRED', '需要 --options（至少两个候选，逗号分隔）', { options });
  if (new Set(options).size !== options.length) fail('DECISION_BOX_OPTIONS_REQUIRED', '候选不能重复', { options });
  const source = validateSource(input.source);
  const by = String(input.by || 'pm');
  // Owner 09:10：需要 Owner 决策的（含验收）由路由守护以 by=system 自动入箱；CLI 仍只允许 PM。
  if (!['pm', 'system'].includes(by)) fail('DECISION_BOX_FORBIDDEN', '只有 PM（或系统）能把条目放进决策箱', { by });
  // R-e717 F-1 / F-1b / F-2：范围（需求未收口拦截）、语义（评审/验收动作拦截）、文案（禁内部代号）。
  // R-5016 F-5：命中不再"裸拒"——保留原拒绝码，同时给 redirect 目标并写「决策收口.jsonl」redirect 审计。
  // skipGuards 只给系统漏箱补录（missBox）用：占位条目本身不是评审动作，不该被语义门挡。
  if (!input.skipGuards) {
    assertDecisionScope(projectName, { source, title });
    assertNotReviewAction({ title, summary, question, options }, { projectName });
    assertDecisionCopyHuman({ title, summary, question });
  }

  return withDecisionBoxLock(projectName, () => {
    const read = readDecisionBox(projectName);
    if (read.corrupt) rebuildCorruptBox(projectName);
    const box = read.corrupt ? emptyBox(projectName) : read.box;
    const dup = box.items.find((row) => String(row.status) === 'open'
      && String((row.source && row.source.ref) || '') === source.ref
      && String(row.question || '').trim() === question);
    if (dup) fail('DECISION_BOX_DUPLICATE', `同来源同问题的条目已在待决：${dup.id}`, { duplicateOf: dup.id, source });
    const id = newDecisionId(projectName, box) + String(input.idSuffix || '');
    const at = nowIso();
    const item = {
      id, title, summary, question,
      source, createdAt: at, by: String(input.by || 'pm'), status: 'open',
      options, readAt: null, answeredAt: null, archivedAt: null, updatedAt: at,
      decision: null, receipt: { messageId: null, at: null, choice: null, opinion: null },
      receiptSeq: 0,
      // R-5016 F-4：入箱新增字段（impact/dueAt/defaultChoice/ruleId/origin/missBox），缺省不写空壳值
      ...(input.extra && typeof input.extra === 'object' ? input.extra : {}),
    };
    box.items.push(item);
    writeDecisionBox(projectName, box);
    return { ok: true, item, file: decisionBoxPath(projectName) };
  });
}

/** 只读列表：open/unread 计数（AC1/AC5 用；UI 由壳层消费同一份）。 */
export function listDecisionBox(projectName, { includeArchived = false } = {}) {
  const read = readDecisionBox(projectName);
  const box = read.box;
  // R-e717 F-2：历史条目渲染时把内部代号换成需求名（认不出的原样保留并标「（未识别）」），只改展示不改存储。
  const items = box.items
    .filter((row) => includeArchived || String(row.status) !== 'archived')
    .map((row) => ({
      ...row,
      title: humanizeDecisionText(projectName, row.title),
      summary: humanizeDecisionText(projectName, row.summary),
      question: humanizeDecisionText(projectName, row.question),
    }));
  const open = items.filter((row) => String(row.status) === 'open');
  const unread = open.filter((row) => !row.readAt);
  return {
    ok: true, corrupt: read.corrupt, project: String(projectName || ''),
    counts: { total: box.items.length, open: open.length, unread: unread.length, answered: box.items.filter((r) => String(r.status) === 'answered').length, archived: box.items.filter((r) => String(r.status) === 'archived').length },
    items, meta: box.meta, file: decisionBoxPath(projectName),
  };
}

/** Owner 展开读一条：写 readAt（不唤醒、不改 status）。 */
export function markDecisionRead(projectName, id) {
  return withDecisionBoxLock(projectName, () => {
    const read = readDecisionBox(projectName);
    if (read.corrupt) fail('DECISION_BOX_CORRUPT', '决策箱文件损坏，请先重建', { file: read.file });
    const item = read.box.items.find((row) => String(row.id) === String(id));
    if (!item) fail('DECISION_NOT_FOUND', `决策箱里没有 ${id}`, { id });
    if (!item.readAt) { item.readAt = nowIso(); item.updatedAt = item.readAt; writeDecisionBox(projectName, read.box); }
    return { ok: true, item };
  });
}

/**
 * 7849 AC3-补：代回执的身份口径。
 * - channel !== 'proxy' → 返回 null（旧 Owner 回执路径一字不改）；
 * - channel === 'proxy' → 必须带三要素：recordedBy='pm'、scope 非空、authorization 非空，
 *   缺一 → PROXY_UNAUTHORIZED（零落账）；返回 basis.proxy，落账时 by/decidedBy 一律 pm。
 */
function normalizeProxyBasis(proxy, channel) {
  if (String(channel || '') !== 'proxy') return null;
  const row = proxy && typeof proxy === 'object' ? proxy : null;
  const recordedBy = String((row && row.recordedBy) || '').trim();
  const scope = String((row && row.scope) || '').trim();
  const authorization = String((row && row.authorization) || '').trim();
  if (!row || recordedBy !== 'pm' || !scope || !authorization) {
    fail('PROXY_UNAUTHORIZED', '代回执必须带代管三要素（recordedBy=pm / scope / authorization），且不得冒充 Owner', {
      channel, recordedBy, scope: scope || null, hasAuthorization: Boolean(authorization),
    });
  }
  return { scope, startedAt: String((row && row.startedAt) || ''), authorization };
}

/**
 * Owner 回执（F-9db6-4/8）：只能从 options 里选 + 意见≤500；
 * 发 type=owner_decision_receipt 给 PM（默认静默）；同一 D-id 只发一次（幂等）；发送失败 → RECEIPT_FAILED 且保持 open。
 */

export async function acknowledgeDecision(projectName, input = {}) {
  const id = String(input.id || '').trim();
  const choice = clean(input.choice, 40);
  const opinion = clean(input.opinion, 500);
  const channel = clean(input.channel, 20) || 'tty';
  const source = clean(input.source, 40) || 'decision_box_ack';
  // 7849 AC3-补：代管期内 PM 代回执（channel=proxy）——必须带代管三要素，绝不冒充 Owner。
  const proxyBasis = normalizeProxyBasis(input.proxy, channel);
  if (!id) fail('DECISION_ID_REQUIRED', '需要 --id D-...');
  const read = readDecisionBox(projectName);
  if (read.corrupt) fail('DECISION_BOX_CORRUPT', '决策箱文件损坏，请先重建', { file: read.file });
  const item = read.box.items.find((row) => String(row.id) === id);
  if (!item) fail('DECISION_NOT_FOUND', `决策箱里没有 ${id}`, { id });
  if (String(item.status) === 'answered' || String(item.status) === 'archived') {
    return { ok: true, idempotent: true, item, receiptMessage: null, messageId: item.receipt && item.receipt.messageId };
  }
  if (!Array.isArray(item.options) || !item.options.includes(choice)) {
    fail('DECISION_CHOICE_INVALID', `回执只能从候选中选：${(item.options || []).join(' / ')}`, { id, choice, options: item.options });
  }
  const at = nowIso();
  // 先发消息（失败则保持 open，可重试；不写 decision）
  let message = null;
  try {
    message = sendMessage({
      from: 'system', to: 'pm', type: 'owner_decision_receipt', project: projectName,
      subject: proxyBasis ? `PM 代管回执 ${item.id}：${choice}` : `Owner 回执 ${item.id}：${choice}`,
      body: [
        `决策箱条目：${item.id}`,
        `标题：${item.title}`,
        `${proxyBasis ? 'PM（代管）选择' : 'Owner 选择'}：${choice}`,
        opinion ? `${proxyBasis ? 'PM（代管）意见' : 'Owner 意见'}：${opinion}` : `${proxyBasis ? 'PM（代管）意见' : 'Owner 意见'}：（未写）`,
        `回执时间：${at}`,
        proxyBasis
          ? `代管依据：scope=${proxyBasis.scope} · authorization=${String(proxyBasis.authorization).slice(0, 80)}`
          : '',
        '点【回执 PM】不等于评审通过/验收；门禁仍走原入口。',
      ].filter(Boolean).join('\n'),
      replyTo: item.source && item.source.kind === 'message' ? String(item.source.ref) : '',
      ackRequired: false,
    });
  } catch (e) {
    fail('RECEIPT_FAILED', `回执消息发送失败，条目保持待决可重试：${String((e && e.message) || e)}`, { id, code: e && e.code });
  }
  const acked = withDecisionBoxLock(projectName, () => {
    const again = readDecisionBox(projectName);
    const fresh = again.box.items.find((row) => String(row.id) === id);
    if (!fresh) fail('DECISION_NOT_FOUND', `决策箱里没有 ${id}`, { id });
    // 幂等：并发下若已被另一个回执置为 answered，则不再发第二条（上面已发的那条撤回不了，但条目只记一条回执）
    if (String(fresh.status) !== 'open') return { ok: true, idempotent: true, item: fresh, receiptMessage: null, messageId: fresh.receipt && fresh.receipt.messageId };
    const seq = Number((again.box.meta && again.box.meta.receiptSeq) || 0) + 1;
    again.box.meta = { ...(again.box.meta || {}), receiptSeq: seq };
    fresh.status = 'answered';
    fresh.answeredAt = at;
    // R-5016 F-6/AC4：答完即归档——archivedAt 非空（status 仍 answered，界面按 archivedAt 判「已收口」）
    fresh.archivedAt = at;
    fresh.updatedAt = at;
    fresh.decision = proxyBasis
      ? {
        choice, opinion, by: 'pm', decidedBy: 'pm', channel: 'proxy', source: 'proxy_ack', at,
        basis: { proxy: { scope: proxyBasis.scope, startedAt: proxyBasis.startedAt, authorization: proxyBasis.authorization, recordedBy: 'pm' } },
      }
      : { choice, opinion, by: 'owner', decidedBy: 'owner', channel, at, source };
    fresh.receipt = { messageId: message.id, at, choice, opinion, seq };
    fresh.receiptSeq = seq;
    fresh.readAt = String(fresh.readAt || at);
    writeDecisionBox(projectName, again.box);
    appendEvent({
      role: proxyBasis ? 'pm' : 'owner',
      sessionId: proxyBasis ? 'proxy' : (channel === 'ui' ? 'ui' : 'tty'),
      action: proxyBasis ? 'decision_box_ack_proxy' : 'decision_box_ack',
      project: projectName, target: id, note: `choice=${choice} channel=${channel} source=${source}`,
      data: {
        id, choice, opinion: truncate(opinion, 160), receiptSeq: seq, messageId: message.id,
        decidedBy: proxyBasis ? 'pm' : 'owner', channel, source,
        ...(proxyBasis ? { basis: { proxy: { scope: proxyBasis.scope, startedAt: proxyBasis.startedAt } } } : {}),
      },
    });
    return { ok: true, item: fresh, receiptMessage: message, messageId: message.id };
  });
  // R-9db6 AC4 / Owner 2026-11-14 新规：Owner 回执消息必须唤醒 PM（以前默认静默）。
  const wake = await wakeDecisionRecipient(projectName, message);
  return { ...acked, wake };
}

/** 回执消息是否仍未被 PM 读（在 pm/new 里就算未读）。 */
function receiptUnread(receiptId) {
  if (!receiptId) return false;
  try {
    const found = findMessage('pm', String(receiptId));
    if (!found) return false;
    return String(found.box || '') === 'new';
  } catch { return false; }
}

/**
 * 静默兜底（F-9db6-4/AC7）：默认不唤醒；未读回执 ≥5 条，或最早一条未读回执超 TEAM_DECISION_RECEIPT_STALE_MS →
 * 返回 needWake=true（只 1 次，随后重新计数）。真正唤醒由 CLI/pump 调 ops.wakeMailboxRecipient 执行。
 */
export function decisionReceiptStaleCheck(projectName, { now = Date.now() } = {}) {
  const staleMs = (() => {
    const raw = Number(process.env.TEAM_DECISION_RECEIPT_STALE_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RECEIPT_STALE_MS;
  })();
  const read = readDecisionBox(projectName);
  if (read.corrupt) return { ok: false, code: 'DECISION_BOX_CORRUPT', needWake: false };
  const box = read.box;
  const meta = box.meta || {};
  const answered = box.items.filter((row) => row.receipt && row.receipt.messageId);
  const unread = answered.filter((row) => receiptUnread(row.receipt.messageId));
  const pending = unread.filter((row) => Number(row.receiptSeq || 0) > Number(meta.lastWakeReceiptSeq || 0));
  if (!pending.length) return { ok: true, needWake: false, reason: 'NO_PENDING', unread: 0, threshold: RECEIPT_WAKE_THRESHOLD, staleMs };
  const oldest = pending.reduce((min, row) => {
    const t = Date.parse(String((row.receipt && row.receipt.at) || row.answeredAt || ''));
    return Number.isNaN(t) ? min : (min === null ? t : Math.min(min, t));
  }, null);
  const byCount = pending.length >= RECEIPT_WAKE_THRESHOLD;
  const byAge = oldest !== null && now - oldest >= staleMs;
  if (!byCount && !byAge) {
    return { ok: true, needWake: false, reason: 'BELOW_THRESHOLD', unread: pending.length, oldestAt: oldest ? new Date(oldest).toISOString() : '', threshold: RECEIPT_WAKE_THRESHOLD, staleMs };
  }
  const lastSeq = Math.max(...pending.map((row) => Number(row.receiptSeq || 0)));
  return {
    ok: true, needWake: true,
    reason: byCount ? 'COUNT' : 'STALE',
    unread: pending.length, oldestAt: oldest ? new Date(oldest).toISOString() : '',
    threshold: RECEIPT_WAKE_THRESHOLD, staleMs, lastSeq,
    messageIds: pending.map((row) => row.receipt.messageId),
  };
}

/** 记一次“已唤醒”（重新计数）。 */
export function markDecisionReceiptWoken(projectName, { lastSeq = 0 } = {}) {
  return withDecisionBoxLock(projectName, () => {
    const read = readDecisionBox(projectName);
    read.box.meta = { ...(read.box.meta || {}), lastWakeAt: nowIso(), lastWakeReceiptSeq: Number(lastSeq) || 0 };
    writeDecisionBox(projectName, read.box);
    return { ok: true, meta: read.box.meta };
  });
}

/** 归档已回执条目（默认保留 90 天；Owner 侧归档入口用）。 */
export function archiveDecision(projectName, id) {
  return withDecisionBoxLock(projectName, () => {
    const read = readDecisionBox(projectName);
    const item = read.box.items.find((row) => String(row.id) === String(id));
    if (!item) fail('DECISION_NOT_FOUND', `决策箱里没有 ${id}`, { id });
    if (String(item.status) !== 'answered') fail('DECISION_NOT_ANSWERED', `只有已回执的条目能归档：${id}`, { id, status: item.status });
    item.status = 'archived';
    item.archivedAt = nowIso();
    item.updatedAt = item.archivedAt;
    writeDecisionBox(projectName, read.box);
    return { ok: true, item };
  });
}

/** PM 未读回执数（看板红点/CLI 用）。 */
export function unreadReceiptCount(projectName) {
  const read = readDecisionBox(projectName);
  if (read.corrupt) return 0;
  return read.box.items.filter((row) => row.receipt && row.receipt.messageId && receiptUnread(row.receipt.messageId)).length;
}

/** 计数快照（IPC 返回给界面刷新用）：open/unread/answered。 */
export function decisionCounts(projectName) {
  try {
    const read = readDecisionBox(projectName);
    if (read.corrupt) return { open: 0, unread: 0, answered: 0 };
    const items = read.box.items || [];
    const open = items.filter((row) => String(row.status) === 'open');
    return {
      open: open.length,
      unread: open.filter((row) => !row.readAt).length,
      answered: items.filter((row) => String(row.status) === 'answered').length,
    };
  } catch { return { open: 0, unread: 0, answered: 0 }; }
}

/** 回执消息发出去以后唤醒 PM（失败不阻断落账，只带回 why）。 */
async function wakeDecisionRecipient(projectName, message) {
  if (!message || !message.id) return null;
  try {
    const { wakeMailboxRecipient } = await import('./ops.mjs');
    return await wakeMailboxRecipient(projectName, 'pm', {
      reason: 'owner_decision_receipt',
      subject: message.subject || 'Owner 决策回执',
      messageId: message.id,
    });
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e) };
  }
}

/**
 * R-9db6 AC4（T-20261114-130838-5dfc）：决策箱「回执 PM」——单条或批量。
 *
 * - 单条：复用 acknowledgeDecision（历史失败码/幂等语义不变），补 channel/source 审计与唤醒；
 * - 批量：先整批校验（存在、未回执、候选合法、同批 id 不重复），任一不满足 → 零副作用失败；
 *   通过后只发 1 条汇总 owner_decision_receipt，再在同一把锁里逐条落账（receiptSeq 逐条 +1）。
 */
export async function acknowledgeDecisions(projectName, input = {}) {
  // R-ad44 AC5：回执写盘统一带 case=decisionAckSend（入口②）
  return withDecisionWriteCase('decisionAckSend', () => acknowledgeDecisionsInner(projectName, input));
}

export async function acknowledgeDecisionsInner(projectName, input = {}) {
  const channel = clean(input.channel, 20) || 'ui';
  const source = clean(input.source, 40) || 'decision_box_ack';
  // 7849 AC3-补：代回执三要素先验（缺一 PROXY_UNAUTHORIZED，零副作用）。
  const proxyBasis = normalizeProxyBasis(input.proxy, channel);
  const proxyArg = proxyBasis ? { proxy: { ...input.proxy, recordedBy: 'pm' } } : {};
  const raw = Array.isArray(input.items) ? input.items : [{ id: input.id, choice: input.choice, opinion: input.opinion }];
  const entries = raw.map((row) => ({
    id: String((row && row.id) || '').trim(),
    choice: clean(row && row.choice, 40),
    opinion: clean(row && row.opinion, 500),
  }));
  if (!entries.length || entries.some((row) => !row.id)) {
    fail('DECISION_ID_REQUIRED', '需要 id（单条给 id/choice，批量给 items[].id）', { count: entries.length });
  }
  if (entries.length === 1) {
    const r = await acknowledgeDecision(projectName, { ...entries[0], channel, source, ...proxyArg });
    return {
      ok: true, project: projectName, batch: false,
      results: [{
        id: entries[0].id,
        status: r.idempotent ? 'already' : 'answered',
        idempotent: Boolean(r.idempotent),
        receiptSeq: r.item && r.item.receiptSeq,
        messageId: r.messageId || '',
      }],
      receiptMessage: r.receiptMessage ? { id: r.receiptMessage.id, to: 'pm' } : null,
      wake: r.wake || null,
      counts: decisionCounts(projectName),
      decidedBy: proxyBasis ? 'pm' : 'owner', channel, at: (r.item && (r.item.answeredAt || nowIso())) || nowIso(),
    };
  }
  // 批量：整批先校验，任一不满足 → 零副作用（不改箱、不发消息、不唤醒）
  const pre = readDecisionBox(projectName);
  if (pre.corrupt) fail('DECISION_BOX_CORRUPT', '决策箱文件损坏，请先重建', { file: pre.file });
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.id)) fail('DECISION_ID_DUPLICATE', `同一次提交里 id 重复：${entry.id}`, { id: entry.id });
    seen.add(entry.id);
    const item = pre.box.items.find((row) => String(row.id) === entry.id);
    if (!item) fail('DECISION_NOT_FOUND', `决策箱里没有 ${entry.id}`, { id: entry.id });
    if (String(item.status) !== 'open') fail('DECISION_ALREADY_ANSWERED', `条目已回执，不能重复提交：${entry.id}`, { id: entry.id, status: item.status });
    if (!Array.isArray(item.options) || !item.options.includes(entry.choice)) {
      fail('DECISION_CHOICE_INVALID', `回执只能从候选中选：${(item.options || []).join(' / ')}`, { id: entry.id, choice: entry.choice, options: item.options });
    }
  }
  const at = nowIso();
  let message = null;
  try {
    message = sendMessage({
      from: 'system', to: 'pm', type: 'owner_decision_receipt', project: projectName,
      subject: proxyBasis ? `PM 代管回执 ${entries.length} 条决策` : `Owner 回执 ${entries.length} 条决策`,
      body: [
        `决策箱回执（共 ${entries.length} 条，${proxyBasis ? 'PM 在代管期内一次提交' : 'Owner 在界面一次提交'}）：`,
        ...entries.map((entry) => `- ${entry.id}｜选择：${entry.choice}｜意见：${entry.opinion || '（未写）'}`),
        `回执时间：${at}`,
        '点【回执 PM】不等于评审通过/验收；门禁仍走原入口。',
      ].join('\n'),
      ackRequired: false,
    });
  } catch (e) {
    fail('RECEIPT_FAILED', `回执消息发送失败，条目保持待决可重试：${String((e && e.message) || e)}`, { code: e && e.code });
  }
  const acked = withDecisionBoxLock(projectName, () => {
    const again = readDecisionBox(projectName);
    if (again.corrupt) fail('DECISION_BOX_CORRUPT', '决策箱文件损坏，请先重建', { file: again.file });
    let seq = Number((again.box.meta && again.box.meta.receiptSeq) || 0);
    const results = [];
    for (const entry of entries) {
      const fresh = again.box.items.find((row) => String(row.id) === entry.id);
      if (!fresh) fail('DECISION_NOT_FOUND', `决策箱里没有 ${entry.id}`, { id: entry.id });
      if (String(fresh.status) !== 'open') {
        results.push({ id: entry.id, status: 'already', idempotent: true });
        continue;
      }
      seq += 1;
      fresh.status = 'answered';
      fresh.answeredAt = at;
      fresh.updatedAt = at;
      fresh.readAt = String(fresh.readAt || at);
      fresh.decision = proxyBasis
        ? {
          choice: entry.choice, opinion: entry.opinion, by: 'pm', decidedBy: 'pm', channel: 'proxy', source: 'proxy_ack', at,
          basis: { proxy: { scope: proxyBasis.scope, startedAt: proxyBasis.startedAt, authorization: proxyBasis.authorization, recordedBy: 'pm' } },
        }
        : { choice: entry.choice, opinion: entry.opinion, by: 'owner', decidedBy: 'owner', channel, at, source };
      fresh.receipt = { messageId: message.id, at, choice: entry.choice, opinion: entry.opinion, seq };
      fresh.receiptSeq = seq;
      results.push({ id: entry.id, status: 'answered', receiptSeq: seq, messageId: message.id });
    }
    again.box.meta = { ...(again.box.meta || {}), receiptSeq: seq };
    writeDecisionBox(projectName, again.box);
    appendEvent({
      role: proxyBasis ? 'pm' : 'owner',
      sessionId: proxyBasis ? 'proxy' : (channel === 'ui' ? 'ui' : 'tty'),
      action: proxyBasis ? 'decision_box_ack_proxy' : 'decision_box_ack',
      project: projectName, target: entries.map((entry) => entry.id).join(','),
      note: `batch=${entries.length} channel=${channel} source=${source}`,
      data: {
        ids: entries.map((entry) => entry.id), messageId: message.id, receiptSeq: seq,
        decidedBy: proxyBasis ? 'pm' : 'owner', channel, source,
        ...(proxyBasis ? { basis: { proxy: { scope: proxyBasis.scope, startedAt: proxyBasis.startedAt } } } : {}),
      },
    });
    return { ok: true, project: projectName, batch: true, results, receiptMessage: { id: message.id, to: 'pm' }, decidedBy: proxyBasis ? 'pm' : 'owner', channel, at };
  });
  const wake = await wakeDecisionRecipient(projectName, message);
  return { ...acked, wake, counts: decisionCounts(projectName) };
}

// ---------- R-e717（团队工具侧）：决策箱范围 / 语义 / 文案 ----------
//
// F-1：来源是「需求」的条目，需求未收口一律拦截（approved 也拦）；唯一放行=收口后复盘（title 以「复盘」开头）。
// F-1b：实质是评审结论/验收动作的条目（意图词或门禁选项）拦截——评审去评审弹窗、验收去顶部【验】。
// F-2：title/summary/question 不得带内部代号/阶段名；历史条目渲染时把代号换成需求名，未知标「（未识别）」。
export const DECISION_CLOSED_STATUSES = ['accepted', 'terminated', 'rejected'];
const DECISION_CLOSED_SET = new Set(DECISION_CLOSED_STATUSES);
const DECISION_CODE_RE = /(?<![A-Za-z0-9])[RBDSM]-\d{8}(?:-\d{6})?-[0-9a-f]{4}(?![A-Za-z0-9])/gi;
const DECISION_STAGE_RE = /\b(?:test_done|dev_done|approved|accepted|owner_review|ready|rejected|terminated)\b/gi;
const DECISION_INTENT_RE = /(通过|打回|驳回|验收|批准|approve|reject|accept)/gi;
const DECISION_GATE_OPTIONS = new Set(['通过', '打回', '驳回', '验收通过', '验收不通过', '同意', '不同意']);

/** 读工作流里的需求行（只读；格式坏了按找不到处理，不让决策箱因此写不出来）。 */
export function findRequirementRow(projectName, requirementId) {
  const id = String(requirementId || '').trim();
  if (!id) return null;
  try {
    const file = path.join(projectStatePaths(projectName).dir, '工作流.json');
    if (!exists(file)) return null;
    const raw = readJson(file, null);
    const reqs = raw && raw.requirements;
    if (!reqs) return null;
    const rows = Array.isArray(reqs) ? reqs : Object.values(reqs);
    return rows.find((row) => row && String(row.id || '') === id) || null;
  } catch { return null; }
}

/** 需求的人话名字：工作流 title/name 优先，其次 需求/ 目录里文档名去掉 id 前缀。 */
export function requirementDisplayName(projectName, requirementId) {
  const id = String(requirementId || '').trim();
  if (!id) return '';
  const row = findRequirementRow(projectName, id);
  const fromRow = row && String(row.title || row.name || '').trim();
  if (fromRow) return fromRow;
  try {
    const project = loadProject(projectName);
    const dir = path.join(String(project.path || ''), '需求');
    const hit = fs.readdirSync(dir).find((name) => name.toLowerCase().startsWith(id.toLowerCase()) && name.endsWith('.md'));
    if (hit) {
      const rest = hit.replace(/\.md$/i, '').slice(id.length).replace(/^[-_]/, '').trim();
      if (rest) return rest;
    }
  } catch { /* 目录不存在/不可读：走"未识别" */ }
  return '';
}

/** F-2 历史兜底：把文案里的代号/简写换成需求名；认不出的原样保留并标「（未识别）」。 */
export function humanizeDecisionText(projectName, text) {
  const src = String(text || '');
  if (!src) return src;
  return src.replace(DECISION_CODE_RE, (token) => {
    const name = requirementDisplayName(projectName, token);
    return name ? name : `${token}（未识别）`;
  });
}

/**
 * R-5016 F-5：guard 命中后不再"裸拒"——保留原拒绝码，同时给出 redirect 目标并写
 * 「决策收口.jsonl」一行 action='redirect'（含原码/目标/时间）。界面/CLI 据此显示「已转投到 X」。
 * 审计不可写时按边界-降级 fail-closed：仍抛原码（redirect 字段保留），但动作不会被放过。
 */
function redirectInsteadOfBareFail(projectName, { code, message, details = {}, target = 'review_dialog', ruleId = 'R-REVIEW-INTENT', reason = '' }) {
  const redirect = { to: target, anchor: DECISION_TARGET_ANCHORS[target] || '', reason, ruleId };
  let auditFile = null;
  let auditError = null;
  try {
    auditFile = appendDecisionRouteAudit(projectName, {
      actor: 'system', action: 'redirect', askId: null, target, ruleId, code,
      note: String(reason || message || '').slice(0, 160), reason: String(reason || ''),
    }).file;
  } catch (e) {
    auditError = String((e && e.message) || e);
  }
  const where = target === 'accept_list' ? '验收列表（#accept-list）' : '评审弹窗（#owner-review）';
  fail(code, `${message}（已转投到${where}）`, {
    ...details, redirect, auditFile: auditFile || null, ...(auditError ? { auditError } : {}), redirected: true,
  });
}

/** F-1：来源需求的条目必须已收口，且只有「复盘…」能进箱。 */
export function assertDecisionScope(projectName, { source, title } = {}) {
  const kind = String((source && source.kind) || '');
  if (kind !== 'requirement') return null;
  const ref = String((source && source.ref) || '').trim();
  const name = String(title || '').trim();
  const row = findRequirementRow(projectName, ref);
  const status = row ? String(row.status || '') : '';
  const gate = (message, details, reason) => redirectInsteadOfBareFail(projectName, {
    code: 'DECISION_SCOPE_FORBIDDEN', message, details, target: 'review_dialog', ruleId: 'R-SCOPE', reason,
  });
  if (!row) {
    gate(`来源需求 ${ref} 不在工作流里（无法确认已收口）；这条在评审/开发/验收流程中，请到对应列表处理`,
      { requirementId: ref, status: '', allowed: false }, `scope:需求不在工作流（${ref}）`);
  }
  if (!DECISION_CLOSED_SET.has(status)) {
    gate(`来源需求 ${ref} 当前状态 ${status || '(无)'}；这条在评审/开发/验收流程中，请到对应列表处理（评审弹窗 / 顶部【验】）；收口后复盘请把标题写成「复盘…」再提交`,
      { requirementId: ref, status, allowed: false }, `scope:需求未收口（${ref} ${status || '无'}）`);
  }
  if (!/^复盘/.test(name)) {
    gate(`来源需求 ${ref} 已收口，但只有标题以「复盘」开头的条目可以进决策箱；其他内容请到需求/评审/验收列表处理`,
      { requirementId: ref, status, allowed: false }, `scope:已收口但标题不是「复盘…」（${ref}）`);
  }
  return { requirementId: ref, status, allowed: true };
}

/**
 * F-1b：评审结论/验收动作不得进决策箱（双保险，对任何来源都生效）。
 * R-5016：命中即转投评审弹窗（保留原码 + redirect + 审计）。
 */
export function assertNotReviewAction({ title, summary, question, options } = {}, { projectName = '' } = {}) {
  const text = [title, summary, question].filter(Boolean).join(' ');
  DECISION_INTENT_RE.lastIndex = 0;
  const hits = [...new Set(String(text).match(DECISION_INTENT_RE) || [])];
  const list = Array.isArray(options) ? options.map((row) => String(row).trim()).filter(Boolean) : [];
  const gateOptions = list.filter((row) => DECISION_GATE_OPTIONS.has(row));
  const allGate = list.length >= 2 && gateOptions.length === list.length;
  if (hits.length || allGate) {
    redirectInsteadOfBareFail(projectName, {
      code: 'DECISION_REVIEW_ACTION_FORBIDDEN',
      message: '这看起来是评审/验收动作：评审请到评审弹窗、验收请到顶部【验】。决策箱只放非评审类的拍板（取舍/优先级/口径/阻塞）',
      details: { hits, options: list, allGate },
      target: 'review_dialog', ruleId: 'R-REVIEW-INTENT',
      reason: hits.length ? `意图词：${hits.join('、')}` : '选项全为通过/打回类',
    });
  }
}

/** F-2：文案里不得带内部代号（完整 id / 四段简写）或阶段名。 */
export function assertDecisionCopyHuman({ title, summary, question } = {}) {
  const fields = { title, summary, question };
  const bad = [];
  for (const [field, value] of Object.entries(fields)) {
    const text = String(value || '');
    if (!text) continue;
    DECISION_CODE_RE.lastIndex = 0;
    DECISION_STAGE_RE.lastIndex = 0;
    const tokens = [...new Set([
      ...(text.match(DECISION_CODE_RE) || []),
      ...(text.match(DECISION_STAGE_RE) || []),
    ])];
    if (tokens.length) bad.push({ field, tokens });
  }
  if (bad.length) {
    fail('DECISION_COPY_CODE_NAME', '文案里带了内部代号/阶段名，请换成需求名或人话（例：把 R-20261114-141252-e717 换成“决策箱产品级收口”）', { hits: bad });
  }
}
