import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * R-703f / B-20261114-045515-9400：PM 代验收证据校验（**唯一实现**）。
 * 工作台 IPC（src/team-tools.js 的 ownerAccept proxy 分支）与 CLI（团队/工具/lib/ops.mjs 的 owner --action accept --proxy）
 * 都调用本模块，禁止各写一套。
 *
 * 规则（与 IPC 现状一致）：
 *  - 最多 12 项；每项 { path|rel, kind: report|screenshot|file, sha256? }
 *  - path 为空 → EMPTY_PATH；文件不存在 → FILE_NOT_FOUND；声明 sha256 与实际不符 → HASH_MISMATCH
 *  - 必须至少有 1 项 kind=report、至少 1 项 kind=screenshot
 *  - 任何缺项都返回 ok=false（调用方据此 PM_ACCEPT_EVIDENCE_REQUIRED，且必须在校验通过后才落盘）
 */
export const PM_ACCEPT_MAX_ITEMS = 12;

export function validatePmAcceptEvidence({ items, projectPath, maxItems = PM_ACCEPT_MAX_ITEMS } = {}) {
  const root = String(projectPath || '').trim();
  const raw = Array.isArray(items) ? items.slice(0, maxItems) : [];
  const missing = [];
  const evidence = [];
  for (const item of raw) {
    const rel = String((item && (item.path || item.rel)) || '').trim();
    const kind = String((item && item.kind) || '').toLowerCase() || 'file';
    const abs = rel ? (path.isAbsolute(rel) ? rel : path.resolve(root || process.cwd(), rel)) : '';
    let exists = false;
    let size = 0;
    let sha256 = '';
    try {
      if (abs && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        exists = true;
        size = fs.statSync(abs).size;
        sha256 = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
      }
    } catch {
      exists = false;
    }
    const claimed = String((item && item.sha256) || '').toLowerCase();
    const outside = Boolean(root && abs && !abs.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep));
    if (!rel) missing.push({ path: '', kind, reason: 'EMPTY_PATH' });
    else if (outside) missing.push({ path: rel, kind, reason: 'EVIDENCE_OUTSIDE_PROJECT', abs });
    else if (!exists) missing.push({ path: rel, kind, reason: 'FILE_NOT_FOUND', abs });
    else if (claimed && claimed !== sha256) missing.push({ path: rel, kind, reason: 'HASH_MISMATCH', sha256, claimed });
    if (rel && exists && !outside) evidence.push({ path: rel, sha256, kind, size });
  }
  if (!evidence.some((row) => row.kind === 'report')) missing.push({ path: '', kind: 'report', reason: 'REPORT_REQUIRED' });
  if (!evidence.some((row) => row.kind === 'screenshot')) missing.push({ path: '', kind: 'screenshot', reason: 'SCREENSHOT_REQUIRED' });
  const outsideHit = missing.some((row) => row.reason === 'EVIDENCE_OUTSIDE_PROJECT');
  return { ok: missing.length === 0, code: missing.length ? (outsideHit ? 'EVIDENCE_OUTSIDE_PROJECT' : 'PM_ACCEPT_EVIDENCE_REQUIRED') : 'OK', evidence, missing };
}

/**
 * R-7849：PM 代验收四门槛（与证据校验配套，缺一返回 missing[kind=report|screenshot|trq|status]）。
 * - report：有 kind=report 且文件校验通过；
 * - screenshot：有 kind=screenshot；
 * - trq：需求 TR-Q 结论必须 testable；
 * - status：需求必须 test_done。
 */
export function validateAcceptGates({ evidence = [], trqVerdict = '', requirementStatus = '' } = {}) {
  const rows = Array.isArray(evidence) ? evidence : [];
  const missing = [];
  if (!rows.some((row) => String((row && row.kind) || '') === 'report')) {
    missing.push({ kind: 'report', path: '', reason: 'TEST_REPORT_REQUIRED' });
  }
  if (!rows.some((row) => String((row && row.kind) || '') === 'screenshot')) {
    missing.push({ kind: 'screenshot', path: '', reason: 'SCREENSHOT_REQUIRED' });
  }
  const verdict = String(trqVerdict || '').trim().toLowerCase();
  // 无 TR-Q 记录按兼容放行（与需求推进规则一致：trq.verdict 缺省不阻推进）；有记录则必须 testable。
  if (verdict && verdict !== 'testable') {
    missing.push({ kind: 'trq', path: '', reason: 'TRQ_NOT_TESTABLE', actual: String(trqVerdict || '') });
  }
  if (String(requirementStatus || '') !== 'test_done') {
    missing.push({ kind: 'status', path: '', reason: 'REQUIREMENT_NOT_TEST_DONE', actual: String(requirementStatus || '') });
  }
  return { ok: missing.length === 0, code: missing.length ? 'PM_ACCEPT_EVIDENCE_REQUIRED' : 'OK', missing };
}

/**
 * CLI 解析：--evidence 支持 JSON 数组字符串，或 `path[:kind]` 单值。
 *
 * B-20261116-201956-e616：kind 白名单补 `record`，并按后缀把「运行记录类」文件推断成 record。
 *   改前只认 report|screenshot|file，且非图片一律推成 report —— 于是 `证据-xxx/run.log:record` 里的
 *   `:record` 不被识别、整串被当成路径 → FILE_NOT_FOUND → 缺陷单验收只剩 1 件证据 → SECOND_EVIDENCE_REQUIRED。
 * 推断口径（显式 kind 永远优先）：
 *   - 图片（png/jpg/jpeg/webp/gif/bmp）→ screenshot
 *   - 运行记录（log/json/jsonl/csv/xml/yaml/yml）→ record
 *   - 其余（含 .md/.txt，保持历史口径）→ report
 * 注意：需求级代验收（validatePmAcceptEvidence）仍要求 report+screenshot 两件；record 只放宽「第二件证据」，
 * 不改那条更严的门（缺陷单验收用 ops.mjs acceptDefectTask 自己的规则：报告 + 任意第二件）。
 */
export const EVIDENCE_KINDS = Object.freeze(['report', 'screenshot', 'record', 'file']);

export function inferEvidenceKind(relPath) {
  const rel = String(relPath || '');
  if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(rel)) return 'screenshot';
  if (/\.(log|json|jsonl|csv|xml|ya?ml)$/i.test(rel)) return 'record';
  return 'report';
}

export function parseEvidenceArg(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const arr = JSON.parse(text);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  return text.split(/[\n,]/).map((part) => part.trim()).filter(Boolean).map((part) => {
    const m = part.match(/^(.*?)(?::(report|screenshot|record|file))?$/);
    const rel = String((m && m[1]) || part).trim();
    let kind = String((m && m[2]) || '').trim().toLowerCase();
    if (!kind) kind = inferEvidenceKind(rel);
    return { path: rel, kind };
  });
}
