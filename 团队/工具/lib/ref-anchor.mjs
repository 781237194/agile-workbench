// 团队工作台 v2 · 补丁式引用（RC-2 / T-20261120-165933-b610）
// 目的：回执/证据/实现说明里的代码引用一律写成「路径#文件sha12:行号(-行号)」，
//       禁止整文件粘贴；本模块提供解析/校验/审计，供 evidence.mjs 与 dispatch.mjs 非阻断接入。
// 代码：REF_BAD_FORMAT / ANCHOR_PATH_OUTSIDE / EVIDENCE_ANCHOR_STALE（不阻断，只记审计）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS, ensureDir } from './core.mjs';
import { resolveAnchorPath } from './anchor.mjs';

/** 路径#sha12 或 路径#sha12:行号 或 路径#sha12:起-止 */
export const REF_RE = /^([^#\s]+)#([0-9a-f]{12})(?::(\d+)(?:-(\d+))?)?$/;
const TOKEN_RE = /[^\s"'`，。；、）(]+#[0-9a-f]{12}(?::\d+(?:-\d+)?)?/g;

export function parseRef(text) {
  const raw = String(text == null ? '' : text).trim();
  const m = REF_RE.exec(raw);
  if (!m) return { ok: false, code: 'REF_BAD_FORMAT', ref: raw };
  const line = m[3] ? Number(m[3]) : null;
  const lineEnd = m[4] ? Number(m[4]) : null;
  if (line !== null && lineEnd !== null && lineEnd < line) return { ok: false, code: 'REF_BAD_FORMAT', ref: raw, why: 'RANGE_REVERSED' };
  return { ok: true, ref: raw, path: m[1], fileSha12: m[2], line, lineEnd };
}

/** 从一段文本里提取所有疑似补丁式引用（去重，保持出现顺序）。 */
export function extractRefs(text) {
  const out = [];
  const seen = new Set();
  const s = String(text == null ? '' : text);
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(s))) {
    const raw = m[0].replace(/[)\]}>，。；、]+$/, '');
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/** 校验一条引用：路径白名单（ANCHOR_PATH_OUTSIDE）、文件 sha12（EVIDENCE_ANCHOR_STALE）、行号范围。 */
export function checkRef(text) {
  const parsed = parseRef(text);
  if (!parsed.ok) return { ok: false, code: parsed.code, ref: parsed.ref, details: parsed };
  const resolved = resolveAnchorPath(parsed.path);
  if (!resolved.ok) {
    return { ok: false, code: 'ANCHOR_PATH_OUTSIDE', ref: parsed.ref, details: { why: resolved.why, path: parsed.path, rel: resolved.rel || '' } };
  }
  if (!fs.existsSync(resolved.abs) || !fs.statSync(resolved.abs).isFile()) {
    return { ok: false, code: 'EVIDENCE_ANCHOR_STALE', ref: parsed.ref, details: { why: 'FILE_MISSING', rel: resolved.rel } };
  }
  let buf;
  try { buf = fs.readFileSync(resolved.abs); } catch (e) {
    return { ok: false, code: 'EVIDENCE_ANCHOR_STALE', ref: parsed.ref, details: { why: 'READ_FAILED', rel: resolved.rel, error: String((e && e.message) || e) } };
  }
  const actualSha12 = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
  if (actualSha12 !== parsed.fileSha12) {
    return { ok: false, code: 'EVIDENCE_ANCHOR_STALE', ref: parsed.ref, details: { why: 'FILE_SHA_MISMATCH', rel: resolved.rel, expected: parsed.fileSha12, actual: actualSha12 } };
  }
  const lineCount = buf.toString('utf8').split(/\r?\n/).length;
  if (parsed.line !== null && (parsed.line < 1 || parsed.line > lineCount || (parsed.lineEnd && (parsed.lineEnd < 1 || parsed.lineEnd > lineCount)))) {
    return { ok: false, code: 'EVIDENCE_ANCHOR_STALE', ref: parsed.ref, details: { why: 'LINE_OUT_OF_RANGE', rel: resolved.rel, line: parsed.line, lineEnd: parsed.lineEnd, lineCount } };
  }
  return { ok: true, code: 'REF_OK', ref: parsed.ref, rel: resolved.rel, line: parsed.line, lineEnd: parsed.lineEnd, fileSha12: actualSha12, lineCount };
}

/** 把引用还原成纯路径（供 evidence 的文件存在性/新鲜度校验复用）。 */
export function stripRefs(text) {
  return String(text == null ? '' : text).replace(TOKEN_RE, (raw) => raw.replace(/#[0-9a-f]{12}(?::\d+(?:-\d+)?)?$/, ''));
}

/** 从证据文本里移除补丁式引用（锚点是引用、不是证据文件本身）。 */
export function dropRefs(text) {
  return String(text == null ? '' : text).replace(TOKEN_RE, ' ');
}

/** 非阻断审计：项目状态目录 锚点校验.jsonl（写失败吞掉，不影响主流程）。 */
export function auditRefs({ project, projectPath, source, refs, taskId = '', messageId = '' }) {
  const rows = [];
  const checkedAt = new Date().toISOString();
  for (const ref of refs || []) {
    const r = checkRef(ref);
    rows.push({ at: checkedAt, source: String(source || ''), taskId: String(taskId || ''), messageId: String(messageId || ''), ref: String(ref || ''), ok: Boolean(r.ok), code: r.code, details: r.details || {} });
  }
  const warnings = rows.filter((r) => !r.ok);
  if (!rows.length) return { checked: 0, warnings: [] };
  try {
    const name = String(project || '').trim();
    // 审计根可注入（夹具用 TEAM_ANCHOR_AUDIT_ROOT 指向沙盘，避免污染真实项目状态）。
    const auditRoot = String(process.env.TEAM_ANCHOR_AUDIT_ROOT || '').trim();
    const dir = projectPath
      ? path.join(auditRoot || PATHS.state, auditRoot ? '' : '项目', name)
      : path.join(auditRoot || PATHS.state, auditRoot ? '' : '项目', name);
    if (name) {
      ensureDir(dir);
      fs.appendFileSync(path.join(dir, '锚点校验.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    }
  } catch { /* 审计失败不阻断 */ }
  return { checked: rows.length, warnings };
}
