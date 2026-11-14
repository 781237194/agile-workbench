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
    if (!rel) missing.push({ path: '', kind, reason: 'EMPTY_PATH' });
    else if (!exists) missing.push({ path: rel, kind, reason: 'FILE_NOT_FOUND', abs });
    else if (claimed && claimed !== sha256) missing.push({ path: rel, kind, reason: 'HASH_MISMATCH', sha256, claimed });
    if (rel && exists) evidence.push({ path: rel, sha256, kind, size });
  }
  if (!evidence.some((row) => row.kind === 'report')) missing.push({ path: '', kind: 'report', reason: 'REPORT_REQUIRED' });
  if (!evidence.some((row) => row.kind === 'screenshot')) missing.push({ path: '', kind: 'screenshot', reason: 'SCREENSHOT_REQUIRED' });
  return { ok: missing.length === 0, code: missing.length ? 'PM_ACCEPT_EVIDENCE_REQUIRED' : 'OK', evidence, missing };
}

/** CLI 解析：--evidence 支持 JSON 数组字符串，或 `path[:kind]` 单值（kind 缺省按文件名猜 report/screenshot）。 */
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
    const m = part.match(/^(.*?)(?::(report|screenshot|file))?$/);
    const rel = String((m && m[1]) || part).trim();
    let kind = String((m && m[2]) || '').trim();
    if (!kind) kind = /\.(png|jpe?g|webp)$/i.test(rel) ? 'screenshot' : 'report';
    return { path: rel, kind };
  });
}
