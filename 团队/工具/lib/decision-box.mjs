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

/** 写盘：tmp+rename 原子写，并留 .bak-<时间戳>（F-9db6-3）。 */
export function writeDecisionBox(projectName, box) {
  const file = decisionBoxPath(projectName);
  ensureDir(path.dirname(file));
  if (exists(file)) {
    try { fs.copyFileSync(file, `${file}.bak-${Date.now()}`); } catch { /* 备份失败不阻断写盘，但审计会缺一份 */ }
  }
  const next = { schema: 1, project: String(projectName || ''), items: box.items || [], meta: box.meta || {}, updatedAt: nowIso() };
  writeJson(file, next);
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

  return withDecisionBoxLock(projectName, () => {
    const read = readDecisionBox(projectName);
    if (read.corrupt) rebuildCorruptBox(projectName);
    const box = read.corrupt ? emptyBox(projectName) : read.box;
    const dup = box.items.find((row) => String(row.status) === 'open'
      && String((row.source && row.source.ref) || '') === source.ref
      && String(row.question || '').trim() === question);
    if (dup) fail('DECISION_BOX_DUPLICATE', `同来源同问题的条目已在待决：${dup.id}`, { duplicateOf: dup.id, source });
    const id = newDecisionId(projectName, box);
    const at = nowIso();
    const item = {
      id, title, summary, question,
      source, createdAt: at, by: 'pm', status: 'open',
      options, readAt: null, answeredAt: null, archivedAt: null, updatedAt: at,
      decision: null, receipt: { messageId: null, at: null, choice: null, opinion: null },
      receiptSeq: 0,
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
  const items = box.items.filter((row) => includeArchived || String(row.status) !== 'archived');
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
 * Owner 回执（F-9db6-4/8）：只能从 options 里选 + 意见≤500；
 * 发 type=owner_decision_receipt 给 PM（默认静默）；同一 D-id 只发一次（幂等）；发送失败 → RECEIPT_FAILED 且保持 open。
 */
export async function acknowledgeDecision(projectName, input = {}) {
  const id = String(input.id || '').trim();
  const choice = clean(input.choice, 40);
  const opinion = clean(input.opinion, 500);
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
      subject: `Owner 回执 ${item.id}：${choice}`,
      body: [
        `决策箱条目：${item.id}`,
        `标题：${item.title}`,
        `Owner 选择：${choice}`,
        opinion ? `Owner 意见：${opinion}` : 'Owner 意见：（未写）',
        `回执时间：${at}`,
        '点【回执 PM】不等于评审通过/验收；门禁仍走原入口。',
      ].join('\n'),
      replyTo: item.source && item.source.kind === 'message' ? String(item.source.ref) : '',
      ackRequired: false,
    });
  } catch (e) {
    fail('RECEIPT_FAILED', `回执消息发送失败，条目保持待决可重试：${String((e && e.message) || e)}`, { id, code: e && e.code });
  }
  return withDecisionBoxLock(projectName, () => {
    const again = readDecisionBox(projectName);
    const fresh = again.box.items.find((row) => String(row.id) === id);
    if (!fresh) fail('DECISION_NOT_FOUND', `决策箱里没有 ${id}`, { id });
    // 幂等：并发下若已被另一个回执置为 answered，则不再发第二条（上面已发的那条撤回不了，但条目只记一条回执）
    if (String(fresh.status) !== 'open') return { ok: true, idempotent: true, item: fresh, receiptMessage: null, messageId: fresh.receipt && fresh.receipt.messageId };
    const seq = Number((again.box.meta && again.box.meta.receiptSeq) || 0) + 1;
    again.box.meta = { ...(again.box.meta || {}), receiptSeq: seq };
    fresh.status = 'answered';
    fresh.answeredAt = at;
    fresh.updatedAt = at;
    fresh.decision = { choice, opinion, by: 'owner', at };
    fresh.receipt = { messageId: message.id, at, choice, opinion, seq };
    fresh.receiptSeq = seq;
    writeDecisionBox(projectName, again.box);
    return { ok: true, item: fresh, receiptMessage: message, messageId: message.id };
  });
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
