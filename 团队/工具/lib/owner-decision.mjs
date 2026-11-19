// B-20261119-212037-d8b8：Owner 决定通知的**单一实现（数据层）**——文案 / 去重键 / 审计，全部只此一份。
//
// 为什么抽出来：原来这套逻辑嵌在壳层 `src/team-tools.js → ownerRequirementDecision` 里，
// 而 legacy 协议（`team.mjs owner`）直接走 CLI **绕过了壳层** → 决定落账后不发 PM 通知（tester 真窗口发现）。
// 现在：文案/去重/审计只在本模块；**执行体**（sendMessage + 唤醒）在 `ops.mjs → runOwnerDecisionNotify`，
// 壳层改为调 `team.mjs owner-notify`（同一执行体），legacy 在 cmdOwner 落账后也调同一个函数 → 两协议单一实现。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, nowIso } from './core.mjs';
import { projectStatePaths } from './store.mjs';

/** 去重窗口：同 project+requirement+round 5 分钟内只发 1 条（两协议共用）。 */
export const OWNER_DECISION_NOTIFY_DEDUPE_MS = 5 * 60 * 1000;

/** 审计文件名（两协议同写这一份）。 */
export const OWNER_DECISION_AUDIT_NAME = 'owner决定通知.jsonl';

export function ownerDecisionAuditFile(projectName) {
  try { return path.join(projectStatePaths(projectName).dir, OWNER_DECISION_AUDIT_NAME); } catch { return ''; }
}

/** 去重键（唯一口径）：project|requirement|round。 */
export function ownerDecisionNotifyKey({ projectName, requirementId, round }) {
  return `${String(projectName || '')}|${String(requirementId || '')}|${Number(round) || 1}`;
}

/** 决定 → 中文标签（唯一文案来源）。 */
export function ownerDecisionLabel(status) {
  const s = String(status || '');
  if (s === 'approved') return '通过';
  if (s === 'skipped') return '跳过';
  if (s === 'rejected') return '打回';
  if (s === 'accepted') return '验收通过';
  return s || '决定';
}

/**
 * 通知内容（唯一文案）：subject ≤80、body ≤600（团队消息硬上限）。
 * 必含：需求 id / 决定 / 轮次 / 时间 / 通道 / 意见 / 下一步。
 */
export function ownerDecisionPayload({ requirementId, status, round = 1, opinion = '', at = '', channel = 'ui' }) {
  const label = ownerDecisionLabel(status);
  const subject = `Owner 已${label}需求 ${requirementId}`.slice(0, 80);
  const nextLine = String(status) === 'rejected'
    ? '下一步：需求已打回，等返工后重新评审。'
    : (String(status) === 'skipped' ? '下一步：已跳过 Owner 决定，由你判断是否继续。' : '下一步：需求已放行，可按当前模式派单（fast→tech_review / full→ready）。');
  const body = [
    `需求：${requirementId}`,
    `决定：${label}（${status}）｜ 轮次：${Number(round) || 1} ｜ 时间：${at || nowIso()} ｜ 通道：${channel || 'ui'}`,
    opinion ? `意见：${String(opinion).slice(0, 200)}` : '意见：（无）',
    nextLine,
  ].join('\n').slice(0, 600);
  return { subject, body, label };
}

/** 追加审计行（append-only，失败返回 false 不抛）。 */
export function appendOwnerDecisionAudit(projectName, row) {
  try {
    const f = ownerDecisionAuditFile(projectName);
    if (!f) return false;
    ensureDir(path.dirname(f));
    fs.appendFileSync(f, `${JSON.stringify(row)}\n`, 'utf8');
    return true;
  } catch { return false; }
}

/** 从审计文件回读「该 key 最近一次成功通知」的时间（跨进程去重兜底，只读最后 200 行）。 */
export function lastOwnerDecisionNotifiedAt(projectName, key) {
  try {
    const f = ownerDecisionAuditFile(projectName);
    if (!f || !fs.existsSync(f)) return 0;
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).slice(-200);
    let last = 0;
    for (const line of lines) {
      let row = null;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || row.key !== key || row.action !== 'owner_decision_notified') continue;
      const ms = Date.parse(String(row.at || ''));
      if (Number.isFinite(ms) && ms > last) last = ms;
    }
    return last;
  } catch { return 0; }
}

/** 内存去重表（同进程内连点更快；跨进程靠审计回读）。 */
const seen = new Map();
export function ownerDecisionNotifyMemoGet(key) { return seen.get(key) || 0; }
export function ownerDecisionNotifyMemoSet(key, ms) { seen.set(key, Number(ms) || Date.now()); }
