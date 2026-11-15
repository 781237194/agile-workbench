// 团队工作台 v2 · 需求正文上限自动治理（R-f9b1 工具侧单源）
//
// 口径来源（只读、不改判据）：
//   需求/R-20261115-105441-f9b1-正文上限自动治理.md（主正文）
//   需求/增补卷-f9b1-1.md（13 键审计 / CLI 与退出码 / 幂等 / 失败注入 / dry-run / 可读性收录）
//
// 职责：
//   - checkDocSize()：LIMIT=16384、HEADROOM=512（触发线 15872）、TARGET=12288 只作目标
//   - 小节搬移三条规则：可搬=变更记录/变更历史/状态记录/历史/论证/附录/评审意见摘录；不可搬优先；「历史」整词
//   - splitRequirementDoc()：可搬小节整段搬进 需求/增补卷-<4位>-<N>.md，正文留头部卷清单 + 末尾指针行
//   - revertRequirementSplit()：卷 sha + 正文 sha 校验 / DOC_FROZEN / 白名单，全部零副作用
//   - 审计 文档拆分.jsonl 固定 13 键；splitId=<需求 id>-<拆分前正文 sha12>（不含 batchId）
//
// 落点（不新增第二套真相）：
//   正文 需求/R-<id>-*.md ｜ 卷 需求/增补卷-<4位>-<N>.md（不带 R- 前缀，避开 REQ_FILE_RE）
//   审计 团队/状态/项目/<项目>/文档拆分.jsonl（append-only）
//   卷内隐藏注释 `<!-- doc-split:… -->` 只记录回滚锚点与行模板（不含卷自身 sha，避免自引用死循环）
import fs from 'node:fs';
import path from 'node:path';
import {
  fail, nowIso, sha256, hashFile, exists, ensureDir, readJson, writeText, appendLine,
  readJsonlTolerant, randomHex,
} from './core.mjs';
import { loadTask, projectStatePaths } from './store.mjs';
import { readWorkflowState } from './lifecycle.mjs';

export const DOC_SPLIT_RULE = 'R-f9b1/v1';
export const DOC_SPLIT_LIMIT = 16384;
export const DOC_SPLIT_HEADROOM = 512;
export const DOC_SPLIT_TARGET = 12288;
/** 触发线：字节 ≥ 15872（= LIMIT - HEADROOM）即 near。 */
export const DOC_SPLIT_TRIGGER = DOC_SPLIT_LIMIT - DOC_SPLIT_HEADROOM;
/** 审计键表固定 13 键（AC5 / 增补卷 §一）；顺序即落盘顺序。 */
export const DOC_SPLIT_AUDIT_KEYS = [
  'at', 'actor', 'project', 'requirementId', 'entry', 'action', 'beforeBytes', 'afterBytes',
  'movedSections', 'supplement', 'rule', 'batchId', 'reason',
];
export const MOVABLE_SECTIONS = ['变更记录', '变更历史', '状态记录', '历史', '论证', '附录', '评审意见摘录'];
export const KEEP_SECTIONS = ['是什么', '为什么', '不定会怎样', '不做什么', '功能点', '场景', '验收标准', '边界', '已定口径', '待确认'];
export const SUPPLEMENT_RE = /^增补卷-([0-9a-z]{4})-(\d+)\.md$/i;

const HEAD_RE = /^>[ \t]*增补卷[：:]/;
const POINTER_RE = /^>[ \t]*增补卷指针[：:]/;
const BYTES_SLOT = '{{bytes}}';
const SHA_SLOT = '{{sha12}}';
const META_PREFIX = '<!-- doc-split:';
const META_SUFFIX = ' -->';

// ---------- 基础 ----------

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function byteLen(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

function eolOf(text) {
  return String(text || '').includes('\r\n') ? '\r\n' : '\n';
}

/** 需求 id 的后 4 位（f9b1 / b28f / 1e93…）：卷名只用它，避开同秒 id 撞名。 */
export function requirementShortKey(requirementId) {
  const id = String(requirementId || '').trim();
  const m = id.match(/([0-9a-zA-Z]{4})$/);
  return m ? m[1].toLowerCase() : id.slice(-4).toLowerCase();
}

export function splitAuditPath(projectName) {
  return path.join(projectStatePaths(String(projectName)).dir, '文档拆分.jsonl');
}

/** 项目 需求/ 下该需求的正文（R-<id>-*.md）；完整 id 优先，其次短 key 唯一匹配。 */
export function requirementDocFile(projectPath, requirementId) {
  const dir = path.join(projectPath, '需求');
  const id = String(requirementId || '').trim().toLowerCase();
  if (!id) return null;
  const all = safeReaddir(dir).filter((n) => /^R-.*\.md$/i.test(n));
  const lower = all.map((n) => ({ n, l: n.toLowerCase() }));
  const exact = lower.filter((x) => x.l.startsWith(id + '-') || x.l === id + '.md').map((x) => x.n);
  let chosen = exact;
  if (!chosen.length) chosen = lower.filter((x) => x.l.startsWith(id)).map((x) => x.n);
  if (!chosen.length) {
    const key = requirementShortKey(id);
    chosen = lower.filter((x) => x.l.includes('-' + key + '-')).map((x) => x.n);
  }
  if (!chosen.length) return null;
  if (chosen.length > 1) {
    fail('REQUIREMENT_DOC_AMBIGUOUS', `需求 ${requirementId} 命中多份正文：${chosen.join('、')}`, { requirementId, files: chosen });
  }
  const abs = path.join(dir, chosen[0]);
  return { name: chosen[0], abs, rel: '需求/' + chosen[0], bytes: fs.statSync(abs).size };
}

/** 该需求的全部增补卷（卷号升序）。 */
export function listSupplements(projectPath, requirementId) {
  const dir = path.join(projectPath, '需求');
  const key = requirementShortKey(requirementId);
  const out = [];
  for (const name of safeReaddir(dir)) {
    const m = SUPPLEMENT_RE.exec(name);
    if (!m || m[1].toLowerCase() !== key) continue;
    const abs = path.join(dir, name);
    let st = null;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    out.push({ name, rel: '需求/' + name, abs, bytes: st.size, sha256: hashFile(abs), number: Number(m[2]), mtime: st.mtime.toISOString() });
  }
  out.sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));
  return out;
}

/** 卷索引：shortKey → 卷行；需求 id ← R-*.md 文件名。索引/文件索引/find 三处同源。 */
export function supplementIndexOf(projectPath) {
  const dir = path.join(projectPath, '需求');
  const names = safeReaddir(dir);
  const reqByKey = new Map();
  for (const name of names) {
    const m = /^R-.*-([0-9a-z]{4})-[^/]*\.md$/i.exec(name);
    if (!m) continue;
    const clean = name.replace(/\.md$/i, '');
    const idx = clean.lastIndexOf('-' + m[1]);
    const requirementId = idx > 0 ? clean.slice(0, idx + 1 + m[1].length) : clean;
    reqByKey.set(m[1].toLowerCase(), requirementId);
  }
  const map = new Map();
  for (const name of names) {
    const m = SUPPLEMENT_RE.exec(name);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const abs = path.join(dir, name);
    let bytes = 0; let sha = '';
    try { bytes = fs.statSync(abs).size; sha = hashFile(abs); } catch { bytes = 0; }
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ name, rel: '需求/' + name, bytes, sha256: sha, number: Number(m[2]), requirementId: reqByKey.get(key) || '' });
  }
  for (const list of map.values()) list.sort((a, b) => a.number - b.number);
  return { root: projectPath, map, reqByKey };
}

// ---------- 白名单 ----------

export function whitelistFile(projectPath) {
  return path.join(projectPath, '需求', '正文超限白名单.json');
}

export function readWhitelist(projectPath) {
  const file = whitelistFile(projectPath);
  if (!exists(file)) return { file, exists: false, ids: [], entries: [], limitBytes: DOC_SPLIT_LIMIT };
  let raw = null;
  try { raw = readJson(file, null); } catch { raw = null; }
  const entries = raw && Array.isArray(raw.entries) ? raw.entries : [];
  const ids = entries.map((e) => String((e && e.id) || '').toLowerCase()).filter(Boolean);
  return { file, exists: true, ids, entries, limitBytes: Number(raw && raw.limitBytes) || DOC_SPLIT_LIMIT };
}

export function isWhitelisted(projectPath, requirementId) {
  const id = String(requirementId || '').toLowerCase();
  if (!id) return false;
  const wl = readWhitelist(projectPath);
  const key = requirementShortKey(id);
  return wl.ids.some((x) => x === id || x.endsWith('-' + key));
}

// ---------- 小节匹配（三条规则） ----------

export function normalizeSectionTitle(title) {
  let t = String(title || '').trim();
  t = t.replace(/^[一二三四五六七八九十百]+[、.．]\s*/, '');
  t = t.replace(/^\d+(?:\.\d+)*[.、．)]\s*/, '');
  return t.trim();
}

/** 可搬判定：不可搬优先 > 整词「历史」 > 混词包含。 */
export function sectionMovability(title) {
  const norm = normalizeSectionTitle(title);
  if (!norm) return { movable: false, why: 'empty' };
  if (KEEP_SECTIONS.some((k) => norm.includes(k))) return { movable: false, why: 'keep' };
  if (MOVABLE_SECTIONS.includes(norm)) return { movable: true, why: 'exact' };
  // 「历史」整词：前后不接中文（「历史遗留处理」不算，「历史」「附录 A 历史」算）。
  if (/(^|[^\u4e00-\u9fa5])历史([^\u4e00-\u9fa5]|$)/.test(norm)) return { movable: true, why: 'wholeword' };
  const hit = MOVABLE_SECTIONS.filter((k) => k !== '历史').find((k) => norm.includes(k));
  if (hit) return { movable: true, why: 'contains:' + hit };
  return { movable: false, why: 'unmatched' };
}

/** 按二级标题（## ）切小节：preamble + sections（逐字，含标题行到下一小节前）。 */
export function parseRequirementSections(text) {
  const src = String(text || '');
  const re = /^##[ \t]+(.+?)[ \t]*$/gm;
  const heads = [];
  let m;
  while ((m = re.exec(src))) heads.push({ title: m[1].trim(), start: m.index });
  const sections = heads.map((h, i) => ({
    title: h.title,
    start: h.start,
    end: i + 1 < heads.length ? heads[i + 1].start : src.length,
    text: src.slice(h.start, i + 1 < heads.length ? heads[i + 1].start : src.length),
  }));
  return { preamble: heads.length ? src.slice(0, heads[0].start) : src, sections, text: src };
}

// ---------- 尺寸 ----------

export function checkDocSize({ bytes = 0, whitelisted = false, candidates = [] } = {}) {
  const level = bytes > DOC_SPLIT_LIMIT ? 'over' : bytes >= DOC_SPLIT_TRIGGER ? 'near' : 'ok';
  return {
    bytes, limit: DOC_SPLIT_LIMIT, headroom: DOC_SPLIT_HEADROOM, target: DOC_SPLIT_TARGET,
    trigger: DOC_SPLIT_TRIGGER, level, whitelisted: Boolean(whitelisted), candidates,
  };
}

export function docSizeReport(projectPath, requirementId) {
  const doc = requirementDocFile(projectPath, requirementId);
  if (!doc) {
    return { ok: true, exists: false, requirementId, level: 'missing', ...checkDocSize({ bytes: 0 }), candidates: [], whitelisted: false };
  }
  const text = fs.readFileSync(doc.abs, 'utf8');
  const parsed = parseRequirementSections(text);
  const candidates = parsed.sections.filter((s) => sectionMovability(s.title).movable).map((s) => s.title);
  const whitelisted = isWhitelisted(projectPath, requirementId);
  const bytes = byteLen(text);
  return {
    ok: true, exists: true, requirementId, rel: doc.rel, abs: doc.abs, sha256: sha256(text),
    sections: parsed.sections.length,
    supplements: listSupplements(projectPath, requirementId).map((s) => ({ name: s.name, bytes: s.bytes, sha256: s.sha256 })),
    ...checkDocSize({ bytes, whitelisted, candidates }),
  };
}

/** 全项目巡检（index 默认入口用，零写入）：只报候选与结论。 */
export function scanRequirementDocs(projectPath) {
  const dir = path.join(projectPath, '需求');
  const rows = [];
  for (const name of safeReaddir(dir)) {
    if (!/^R-.*\.md$/i.test(name)) continue;
    const abs = path.join(dir, name);
    let st = null;
    try { st = fs.statSync(abs); } catch { continue; }
    const requirementId = name.replace(/\.md$/i, '').split('-').slice(0, 4).join('-');
    const text = fs.readFileSync(abs, 'utf8');
    const parsed = parseRequirementSections(text);
    const candidates = parsed.sections.filter((s) => sectionMovability(s.title).movable).map((s) => s.title);
    const whitelisted = isWhitelisted(projectPath, requirementId);
    rows.push({
      requirementId, rel: '需求/' + name, file: abs, sha256: sha256(text), sections: parsed.sections.length,
      split: Boolean(findPointerLine(text)),
      ...checkDocSize({ bytes: st.size, whitelisted, candidates }),
    });
  }
  rows.sort((a, b) => b.bytes - a.bytes);
  return rows;
}

// ---------- 行格式 / 元信息 ----------

export function renderHeadLine(supplementRel, bytes, sha12) {
  return `> 增补卷：\`${supplementRel}\`（${bytes}B/${sha12}）`;
}

export function renderPointerLine(supplementRel, bytes, sha12, titles) {
  return `> 增补卷指针：\`${supplementRel}\`（${bytes}B/sha256 ${sha12}）· 已外置：${titles.join('、')}（正文不重复，逐字留卷）`;
}

function renderSlot(template, { bytes, sha256: sha }) {
  return String(template || '')
    .replace(/\{\{bytes\}\}/g, String(bytes))
    .replace(/\{\{sha12\}\}/g, String(sha || '').slice(0, 12));
}

export function findPointerLine(docText) {
  const lines = String(docText || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const raw = lines[i].replace(/\r$/, '');
    if (!POINTER_RE.test(raw)) continue;
    const m = /`(需求\/[^`]*增补卷-[0-9a-z]{4}-\d+\.md)`/i.exec(raw);
    if (!m) continue;
    return { index: i, line: raw, rel: m[1].replace(/\\/g, '/') };
  }
  return null;
}

export function findHeadLine(docText) {
  const lines = String(docText || '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].replace(/\r$/, '');
    if (/^##[ \t]/.test(raw)) break;
    if (HEAD_RE.test(raw) && /`需求\/[^`]*增补卷-/i.test(raw)) return { index: i, line: raw };
  }
  return null;
}

function insertHeadLine(preamble, headLine) {
  const lines = String(preamble || '').split('\n');
  const found = lines.findIndex((l) => HEAD_RE.test(l.replace(/\r$/, '')));
  if (found >= 0) {
    const before = lines[found];
    const inline = headLine.replace(/^>[ \t]*增补卷[：:][ \t]*/, '');
    const sep = before.includes('；') ? '' : '；';
    lines[found] = before.replace(/\r$/, '') + sep + inline;
    return { text: lines.join('\n'), headBefore: before, headAfter: lines[found] };
  }
  let lastBullet = -1;
  for (let i = 0; i < lines.length; i += 1) if (/^-[ \t]/.test(lines[i].trim())) lastBullet = i;
  let pos = lastBullet >= 0 ? lastBullet + 1 : -1;
  if (pos < 0) {
    const h1 = lines.findIndex((l) => /^#[ \t]/.test(l.trim()));
    pos = h1 >= 0 ? h1 + 1 : 0;
  }
  lines.splice(pos, 0, headLine);
  return { text: lines.join('\n'), headBefore: null, headAfter: headLine };
}

// ---------- 审计（13 键） ----------

export function buildAuditRow(row) {
  const safe = row && typeof row === 'object' ? row : {};
  const out = {};
  for (const key of DOC_SPLIT_AUDIT_KEYS) out[key] = Object.prototype.hasOwnProperty.call(safe, key) ? safe[key] : null;
  out.at = out.at || nowIso();
  out.actor = out.actor || 'system';
  out.project = out.project || '';
  out.requirementId = out.requirementId || '';
  out.entry = out.entry || 'index';
  out.action = out.action || 'skip';
  out.beforeBytes = Number.isFinite(Number(out.beforeBytes)) ? Number(out.beforeBytes) : 0;
  out.afterBytes = Number.isFinite(Number(out.afterBytes)) ? Number(out.afterBytes) : out.beforeBytes;
  out.movedSections = Array.isArray(out.movedSections) ? out.movedSections.map(String) : [];
  out.supplement = out.supplement && typeof out.supplement === 'object' ? out.supplement : null;
  out.rule = out.rule || DOC_SPLIT_RULE;
  out.batchId = String(out.batchId || '');
  out.reason = out.reason === undefined ? null : out.reason;
  return out;
}

export function appendSplitAudit(projectName, row) {
  const file = splitAuditPath(projectName);
  const record = buildAuditRow({ project: projectName, ...row });
  try {
    appendLine(file, JSON.stringify(record));
  } catch (e) {
    const err = new Error(`审计不可写：${file}（${e.message}）；本次拒绝执行且零落账`);
    err.code = 'DOC_SPLIT_AUDIT_UNWRITABLE';
    err.details = { file, cause: e.message };
    err.exitCode = 2;
    throw err;
  }
  return { file, record };
}

export function readSplitAudit(projectName) {
  const file = splitAuditPath(projectName);
  const { items, errors } = readJsonlTolerant(file);
  return { file, rows: items, errors };
}

export function newBatchId(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const text = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${text}-${randomHex(2)}`;
}

// ---------- 卷内元信息 ----------

function escapeMetaJson(obj) {
  return JSON.stringify(obj).replace(/--/g, '-\\u002d');
}

export function parseSplitMeta(text) {
  const m = /<!--\s*doc-split:([\s\S]*?)-->/.exec(String(text || ''));
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/\\u002d/g, '-')); } catch { return null; }
}

// ---------- 冻结判定（增补卷 §十） ----------

function hashIs(value, docSha) {
  const v = String(value || '').toLowerCase();
  return Boolean(v) && v === String(docSha || '').toLowerCase();
}

export function frozenState({ projectName, requirementId, docShas = [] }) {
  const reasons = [];
  const shas = (Array.isArray(docShas) ? docShas : [docShas]).filter(Boolean);
  let row = null;
  try {
    const read = readWorkflowState(projectName);
    const rows = (read.state && read.state.requirements) || {};
    row = rows[requirementId]
      || Object.values(rows).find((r) => r && String(r.id || '').toLowerCase() === String(requirementId).toLowerCase())
      || null;
  } catch { row = null; }
  const hit = (v) => shas.some((s) => hashIs(v, s));
  if (row) {
    if (hit(row.productReview && row.productReview.requirementHash)) reasons.push('productReview');
    if (hit(row.trq && row.trq.requirementHash)) reasons.push('trq');
    const decisions = Array.isArray(row.decisions) ? row.decisions : [];
    if (decisions.some((d) => hit(d && d.requirementHash)
      || hit(d && d.basis && d.basis.requirement && d.basis.requirement.sha256)
      || hit(d && d.contentHash))) reasons.push('decisionHash');
    const terminal = ['accepted', 'rejected', 'approved'];
    if (decisions.some((d) => d && terminal.includes(String(d.decision || d.status || '')))) reasons.push('decisionTerminal');
    if (['accepted', 'test_done', 'dev_done'].includes(String(row.status || '')) && decisions.length) reasons.push('statusTerminal');
  }
  try {
    const task = loadTask(projectName, requirementId);
    for (const listKey of ['reviews', 'techReviews']) {
      const list = Array.isArray(task && task[listKey]) ? task[listKey] : [];
      if (list.some((r) => hit(r && r.requirementHash))) { reasons.push('reviewRecord'); break; }
    }
  } catch { /* 任务不存在不算绑定 */ }
  return { frozen: reasons.length > 0, reasons, row };
}

// ---------- 断链检测（AC13） ----------

/**
 * 主正文 ↔ 卷 自检：指针行在、路径可解析、头部卷清单在、字节/sha12 与实际一致。
 * 不一致给 DOC_SPLIT_LINK_MISSING / SUPPLEMENT_MISSING / SUPPLEMENT_MISMATCH（不静默）。
 */
export function validateSupplementLinks(projectPath, requirementId) {
  const doc = requirementDocFile(projectPath, requirementId);
  if (!doc) return { ok: true, exists: false, problems: [], supplements: [] };
  const text = fs.readFileSync(doc.abs, 'utf8');
  const pointer = findPointerLine(text);
  const head = findHeadLine(text);
  const supplements = listSupplements(projectPath, requirementId);
  if (!supplements.length) {
    // 正文仍指着某个卷，但盘上已经没有 → 断链（不能当「没有卷」静默放行）
    if (pointer) {
      const abs = path.join(projectPath, pointer.rel);
      if (!exists(abs)) {
        return {
          ok: false, exists: true, supplements: [],
          problems: [{ code: 'SUPPLEMENT_MISSING', level: 'block', detail: `正文指向的增补卷不存在：${pointer.rel}` }],
        };
      }
    }
    return { ok: true, exists: true, problems: [], supplements: [] };
  }
  const problems = [];
  if (pointer && !exists(path.join(projectPath, pointer.rel))) {
    problems.push({ code: 'SUPPLEMENT_MISSING', level: 'block', detail: `正文指向的增补卷不存在：${pointer.rel}` });
  }
  // 卷分两类：本工具拆的（卷内有 doc-split 元信息，必须「头部清单 + 末尾指针行」）与历史手工卷（没元信息）。
  // 历史手工卷不强制指针行——否则 f9b1 落地前建档的 11 份手工卷会把老需求评审全挡死（2026-11-15 5550 实测）。
  for (const s of supplements) {
    const abs = path.join(projectPath, s.rel);
    if (!exists(abs)) { problems.push({ code: 'SUPPLEMENT_MISSING', level: 'block', detail: `卷不存在：${s.rel}` }); continue; }
    const meta = parseSplitMeta(fs.readFileSync(abs, 'utf8'));
    const managed = Boolean(meta && meta.splitId);
    const sha12 = s.sha256.slice(0, 12);
    const lines = [pointer && pointer.line, head && head.line].filter(Boolean);
    const line = lines.find((l) => l.includes(s.name));
    if (!line) {
      if (managed) {
        problems.push({ code: 'DOC_SPLIT_LINK_MISSING', level: 'block', detail: `正文未指向本工具拆出的卷 ${s.name}（缺头部清单或末尾指针行）` });
      } else {
        problems.push({
          code: 'DOC_SPLIT_LINK_MISSING', level: 'warn', legacy: true,
          detail: `历史手工增补卷 ${s.name} 在正文里没有指针行（不影响评审；建议补一行「> 增补卷：\`${s.rel}\`」）`,
        });
      }
      continue;
    }
    if (!line.includes(sha12) || !line.includes(`${s.bytes}B`)) {
      problems.push({
        code: 'SUPPLEMENT_MISMATCH', level: managed ? 'block' : 'warn',
        detail: `${s.name} 的字节/sha 与磁盘不一致（应为 ${s.bytes}B/${sha12}）`,
      });
    }
  }
  const blocking = problems.filter((p) => p.level === 'block');
  return {
    ok: blocking.length === 0,
    exists: true,
    problems,
    blocking,
    warnings: problems.filter((p) => p.level === 'warn'),
    supplements: supplements.map((s) => ({ name: s.name, rel: s.rel, bytes: s.bytes, sha256: s.sha256 })),
  };
}

// ---------- 拆分：计划 ----------

function injectFail(step) {
  if (process.env.TEAM_SELFTEST !== '1') return false;
  const want = String(process.env.TEAM_DOC_SPLIT_FAIL_AT || '').trim().toLowerCase();
  if (!want) return false;
  return want.split(',').map((s) => s.trim()).includes(String(step).toLowerCase());
}

function writeAtomicWithBackup(file, text) {
  if (exists(file)) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  writeText(file, text);
}

/**
 * 纯计算一次拆分（不写盘）。返回 {action:'split'|'skip'|'error', ...}。
 * 幂等：正文已有指针且指向现存卷、卷内元信息可解析 → already_split（不生成 N+1）。
 */
export function planDocSplit({ projectPath, requirementId, entry = 'index', actor = 'system', now = nowIso() }) {
  const doc = requirementDocFile(projectPath, requirementId);
  if (!doc) return { action: 'skip', reason: 'doc_missing', requirementId, doc: null, beforeBytes: 0, afterBytes: 0 };
  const text = fs.readFileSync(doc.abs, 'utf8');
  const bytes = byteLen(text);
  const preSha = sha256(text);
  const supplements = listSupplements(projectPath, requirementId);
  const pointer = findPointerLine(text);

  if (pointer) {
    const target = supplements.find((s) => s.rel.replace(/\\/g, '/') === pointer.rel);
    if (target) {
      const meta = parseSplitMeta(fs.readFileSync(target.abs, 'utf8'));
      if (meta && meta.splitId) {
        return {
          action: 'skip', reason: 'already_split', requirementId, doc, beforeBytes: bytes, afterBytes: bytes,
          splitId: meta.splitId, supplement: { name: target.name, rel: target.rel, bytes: target.bytes, sha256: target.sha256 },
          movedSections: Array.isArray(meta.movedSections) ? meta.movedSections : [],
        };
      }
    }
  }
  if (isWhitelisted(projectPath, requirementId)) {
    return { action: 'skip', reason: 'whitelisted', requirementId, doc, beforeBytes: bytes, afterBytes: bytes, splitId: '', supplement: null, movedSections: [] };
  }
  const parsed = parseRequirementSections(text);
  const candidates = parsed.sections.filter((s) => sectionMovability(s.title).movable);
  if (bytes < DOC_SPLIT_TRIGGER) {
    return { action: 'skip', reason: 'doc_ok', requirementId, doc, beforeBytes: bytes, afterBytes: bytes, level: 'ok', splitId: '', supplement: null, movedSections: [] };
  }
  if (!candidates.length) {
    return {
      action: 'error', code: 'DOC_SPLIT_INSUFFICIENT', reason: 'DOC_SPLIT_INSUFFICIENT', requirementId, doc,
      beforeBytes: bytes, afterBytes: bytes, level: bytes > DOC_SPLIT_LIMIT ? 'over' : 'near',
      splitId: '', supplement: null, movedSections: [],
      message: `正文 ${bytes}B 已贴线，但没有可搬小节（变更记录/历史/论证/附录/评审意见摘录）；只能人工压缩或拆需求`,
    };
  }

  const removed = new Set(candidates);
  const kept = parsed.sections.filter((s) => !removed.has(s));
  const keptBody = parsed.preamble + kept.map((s) => s.text).join('');
  const titles = candidates.map((s) => s.title);
  const number = supplements.reduce((max, s) => Math.max(max, s.number), 0) + 1;
  const key = requirementShortKey(requirementId);
  const supplementName = `增补卷-${key}-${number}.md`;
  const supplementRel = '需求/' + supplementName;
  const splitId = `${requirementId}-${preSha.slice(0, 12)}`;
  const inserts = candidates.map((s) => {
    const idx = parsed.sections.indexOf(s);
    let anchor = '';
    for (let i = idx - 1; i >= 0; i -= 1) {
      if (!removed.has(parsed.sections[i])) { anchor = parsed.sections[i].title; break; }
    }
    return { title: s.title, after: anchor };
  });

  const supplementHead = [
    `# 增补卷 · ${requirementId}（自动外置的第 ${number} 卷）`,
    '',
    `> 主正文：\`${doc.rel}\`（拆分前 ${bytes}B / sha256 ${preSha.slice(0, 12)}）`,
    `> 生成：${now} ｜ 规则版本：${DOC_SPLIT_RULE} ｜ 入口：${entry} ｜ 执行：${actor}`,
    `> splitId：${splitId} ｜ 卷号：${number} ｜ 已外置小节：${titles.join('、')}`,
    '> 本卷不是需求正文，不参与 G1 四件套判定；改本卷必须同步主正文头部卷清单与指针行。',
    '',
  ].join('\n');
  // 卷内小节逐字拼接（不能额外补换行，否则并回时会多一行；末尾块按原样保留）
  const supplementBody = candidates.map((s) => s.text).join('');
  // 尾部留白按「不含头部卷清单行」的骨架判定（插入新行不影响骨架末尾字节）。
  const eol = eolOf(keptBody);
  const pad = keptBody.endsWith(eol + eol) ? '' : keptBody.endsWith(eol) ? eol : eol + eol;
  // 模板里只用占位符（{{bytes}}/{{sha12}}），保证卷内容长度与自身 sha 无关（避免自引用）。
  const meta = {
    splitId,
    requirementId,
    requirementShortKey: key,
    doc: doc.rel,
    preSha256: preSha,
    preBytes: bytes,
    supplementName,
    supplementNumber: number,
    entry,
    actor,
    at: now,
    rule: DOC_SPLIT_RULE,
    movedSections: titles,
    inserts,
    headLine: renderHeadLine(supplementRel, BYTES_SLOT, SHA_SLOT),
    tailTemplate: `${pad}${renderPointerLine(supplementRel, BYTES_SLOT, SHA_SLOT, titles)}${eol}`,
  };
  const supplementText = `${supplementHead}${META_PREFIX}${escapeMetaJson(meta)}${META_SUFFIX}\n\n${supplementBody}`;
  const supplementBytes = byteLen(supplementText);
  const supplementSha = sha256(supplementText);
  const sha12 = supplementSha.slice(0, 12);

  const headResult = insertHeadLine(parsed.preamble, renderHeadLine(supplementRel, supplementBytes, sha12));
  const base = headResult.text + kept.map((s) => s.text).join('');
  const tailTemplate = meta.tailTemplate;
  const afterText = base + renderSlot(tailTemplate, { bytes: supplementBytes, sha256: supplementSha });

  return {
    action: 'split',
    requirementId, doc, entry, actor, now, splitId,
    beforeBytes: bytes,
    afterBytes: byteLen(afterText),
    movedSections: titles,
    supplement: { name: supplementName, rel: supplementRel, bytes: supplementBytes, sha256: supplementSha, number },
    level: bytes > DOC_SPLIT_LIMIT ? 'over' : 'near',
    supplementText,
    afterText,
    headBefore: headResult.headBefore,
    headAfter: headResult.headAfter,
    tailTemplate,
    meta,
  };
}

// ---------- 拆分：执行 ----------

/**
 * 执行拆分（卷 → 正文 → 审计；任一步失败回滚并报 DOC_SPLIT_FAILED）。
 * 返回字段与 dry-run / 审计 13 键同源（AC3/AC5 共用一套断言）。
 */
export function splitRequirementDoc(opts) {
  const { projectName, projectPath, requirementId } = opts;
  const batchId = opts.batchId || newBatchId();
  const plan = planDocSplit({ ...opts, entry: opts.entry || 'index' });
  const entry = opts.entry || 'index';
  const actor = opts.actor || 'system';
  const base = {
    ok: plan.action !== 'error',
    project: projectName,
    requirementId,
    entry,
    rule: DOC_SPLIT_RULE,
    batchId,
    splitId: plan.splitId || '',
    movedSections: plan.movedSections || [],
    supplement: plan.supplement || null,
    beforeBytes: plan.beforeBytes || 0,
    afterBytes: plan.afterBytes || 0,
  };
  if (plan.action === 'error') {
    return { ...base, ok: false, action: 'skip', code: plan.code, reason: plan.reason, message: plan.message, wrote: false };
  }
  if (plan.action === 'skip') {
    const skip = { ...base, action: 'skip', reason: plan.reason, afterBytes: plan.beforeBytes || 0, supplement: null, movedSections: [], wrote: false };
    if (!opts.dryRun && opts.writeAudit !== false) {
      appendSplitAudit(projectName, {
        at: nowIso(), actor, project: projectName, requirementId, entry,
        action: 'skip', beforeBytes: skip.beforeBytes, afterBytes: skip.afterBytes,
        movedSections: [], supplement: null, rule: DOC_SPLIT_RULE, batchId, reason: plan.reason,
      });
    }
    return { ...skip, mode: opts.dryRun ? 'dry-run' : 'execute' };
  }
  const warning = plan.afterBytes > DOC_SPLIT_TARGET && plan.afterBytes <= DOC_SPLIT_LIMIT ? 'DOC_NEAR_LIMIT' : null;
  if (opts.dryRun) {
    return { ...base, ok: true, mode: 'dry-run', action: 'split', reason: null, wrote: false, level: plan.level, warning };
  }

  const supplementAbs = path.join(projectPath, plan.supplement.rel);
  const docAbs = plan.doc.abs;
  let backup = null;
  try { backup = exists(docAbs) ? fs.readFileSync(docAbs) : null; } catch { backup = null; }
  let supplementWritten = false;
  try {
    if (injectFail('write_supplement')) throw new Error('注入失败：write_supplement');
    ensureDir(path.dirname(supplementAbs));
    const tmpSup = `${supplementAbs}.tmp-${process.pid}-${randomHex(2)}`;
    fs.writeFileSync(tmpSup, plan.supplementText, 'utf8');
    if (injectFail('rename')) { try { fs.unlinkSync(tmpSup); } catch { /* ignore */ } throw new Error('注入失败：rename'); }
    fs.renameSync(tmpSup, supplementAbs);
    supplementWritten = true;
    if (injectFail('write_tmp')) throw new Error('注入失败：write_tmp');
    if (injectFail('backup')) throw new Error('注入失败：backup');
    writeAtomicWithBackup(docAbs, plan.afterText);
    if (injectFail('audit')) throw new Error('注入失败：audit');
    appendSplitAudit(projectName, {
      at: nowIso(), actor, project: projectName, requirementId, entry,
      action: 'split', beforeBytes: plan.beforeBytes, afterBytes: plan.afterBytes,
      movedSections: plan.movedSections, supplement: { name: plan.supplement.name, bytes: plan.supplement.bytes, sha256: plan.supplement.sha256, splitId: plan.splitId }, rule: DOC_SPLIT_RULE, batchId, reason: null,
    });
  } catch (e) {
    try { if (backup) fs.writeFileSync(docAbs, backup); } catch { /* 恢复失败下面照常报 */ }
    try { if (supplementWritten) fs.unlinkSync(supplementAbs); } catch { /* ignore */ }
    if (e && e.code === 'DOC_SPLIT_AUDIT_UNWRITABLE') throw e;
    return {
      ...base, ok: false, action: 'split', code: 'DOC_SPLIT_FAILED', reason: 'DOC_SPLIT_FAILED',
      message: `拆分失败并已回滚：${e && e.message ? e.message : e}`, wrote: false,
    };
  }
  return {
    ...base, ok: true, mode: 'execute', action: 'split', reason: null, wrote: true,
    level: plan.level, warning, supplementPath: plan.supplement.rel,
  };
}

// ---------- 回滚 ----------

function insertBlocks(docText, inserts, blocks) {
  let text = docText;
  // 同一锚点按原始顺序并回：倒序插入，保证先插入的仍在前面。
  for (let i = inserts.length - 1; i >= 0; i -= 1) {
    const ins = inserts[i];
    const block = blocks[i];
    if (block === undefined) return null;
    const parsed = parseRequirementSections(text);
    let pos;
    if (!ins.after) {
      pos = parsed.sections.length ? parsed.sections[0].start : text.length;
    } else {
      const anchor = parsed.sections.find((s) => s.title === ins.after);
      if (!anchor) return null;
      pos = anchor.end;
    }
    text = text.slice(0, pos) + block + text.slice(pos);
  }
  return text;
}

function removeWholeLine(text, line, eol) {
  const idx = text.indexOf(line);
  if (idx < 0) return null;
  let start = idx;
  let end = idx + line.length;
  if (text.startsWith(eol, end)) end += eol.length;
  else if (text.slice(Math.max(0, start - eol.length), start) === eol) start -= eol.length;
  return text.slice(0, start) + text.slice(end);
}

/**
 * 回滚一次拆分：优先级 WHITELISTED_READONLY > DOC_FROZEN > DOC_SPLIT_CONFLICT（增补卷 §十）。
 */
export function revertRequirementSplit({ projectName, projectPath, requirementId, splitId = '', actor = 'system', dryRun = false, entry = 'index' }) {
  const batchId = newBatchId();
  const base = { ok: true, project: projectName, requirementId, entry, rule: DOC_SPLIT_RULE, batchId, splitId };
  const audit = readSplitAudit(projectName);
  // splitId 只放在 supplement 对象里（顶层固定 13 键，不再加键）。
  const splitIdOf = (r) => (r && r.supplement && r.supplement.splitId) || r.splitId || '';
  if (splitId) {
    const done = audit.rows.filter((r) => r && r.action === 'revert' && splitIdOf(r) === splitId).pop();
    if (done) return { ...base, ok: true, action: 'skip', reason: 'already_reverted', wrote: false, message: `该拆分已回滚（${done.at}）` };
  }
  if (isWhitelisted(projectPath, requirementId)) {
    return { ...base, ok: false, action: 'skip', code: 'WHITELISTED_READONLY', reason: 'WHITELISTED_READONLY', wrote: false, message: '该需求在只读白名单（8f68/b5fc 类），不可拆分也不可回滚' };
  }
  const doc = requirementDocFile(projectPath, requirementId);
  if (!doc) return { ...base, ok: false, action: 'skip', code: 'DOC_MISSING', reason: 'doc_missing', wrote: false, message: `找不到需求正文：${requirementId}` };
  const text = fs.readFileSync(doc.abs, 'utf8');
  const docSha = sha256(text);
  const pointer = findPointerLine(text);
  if (!pointer) {
    // 没指针：如果这条需求最近一次拆分审计就是 revert，按「重复回滚」处理（AC4④）。
    const last = audit.rows.filter((r) => r && r.requirementId === requirementId && ['split', 'revert'].includes(r.action)).pop();
    if (last && last.action === 'revert') {
      return { ...base, ok: true, action: 'skip', reason: 'already_reverted', splitId: splitIdOf(last), wrote: false, message: `该拆分已回滚（${last.at}）` };
    }
    return { ...base, ok: false, action: 'skip', code: 'DOC_SPLIT_CONFLICT', reason: 'no_pointer', wrote: false, message: '正文没有增补卷指针行，无法回滚（可能不是本工具拆的）' };
  }
  const target = listSupplements(projectPath, requirementId).find((s) => s.rel.replace(/\\/g, '/') === pointer.rel);
  if (!target) return { ...base, ok: false, action: 'skip', code: 'SUPPLEMENT_MISSING', reason: 'supplement_missing', wrote: false, message: `指针指向的卷不存在：${pointer.rel}` };
  const meta = parseSplitMeta(fs.readFileSync(target.abs, 'utf8'));
  if (!meta) return { ...base, ok: false, action: 'skip', code: 'DOC_SPLIT_CONFLICT', reason: 'meta_missing', wrote: false, message: `卷内缺少拆分元信息，无法安全回滚：${target.rel}` };
  if (splitId && meta.splitId && String(splitId) !== String(meta.splitId)) {
    return { ...base, ok: false, action: 'skip', code: 'DOC_SPLIT_CONFLICT', reason: 'split_id_mismatch', wrote: false, message: `--split-id ${splitId} 与正文指向的拆分 ${meta.splitId} 不一致` };
  }
  const auditSplit = audit.rows.filter((r) => r && r.action === 'split' && splitIdOf(r) === meta.splitId).pop() || null;

  const frozen = frozenState({ projectName, requirementId, docShas: [docSha, meta.preSha256] });
  if (frozen.frozen) {
    return {
      ...base, ok: false, action: 'skip', code: 'DOC_FROZEN', reason: 'DOC_FROZEN', wrote: false,
      frozen: frozen.reasons, splitId: meta.splitId,
      message: '正文已被评审/可测性/决定绑定，回滚会破坏证据链；需 PM 先解绑再回滚',
    };
  }
  if (auditSplit && auditSplit.supplement && String(auditSplit.supplement.sha256) !== String(target.sha256)) {
    return {
      ...base, ok: false, action: 'skip', code: 'DOC_SPLIT_CONFLICT', reason: 'supplement_sha_mismatch', wrote: false,
      splitId: meta.splitId,
      message: `卷已被改动（审计 ${String(auditSplit.supplement.sha256).slice(0, 12)} ≠ 磁盘 ${target.sha256.slice(0, 12)}），拒绝回滚`,
    };
  }
  const eol = eolOf(text);
  const expectTail = renderSlot(meta.tailTemplate || '', target);
  if (!text.endsWith(expectTail)) {
    return { ...base, ok: false, action: 'skip', code: 'DOC_SPLIT_CONFLICT', reason: 'doc_tail_mismatch', wrote: false, splitId: meta.splitId, message: '正文已被改动（末尾指针行与拆分时不一致），拒绝回滚' };
  }
  let baseText = text.slice(0, text.length - expectTail.length);
  const headLine = renderSlot(meta.headLine || '', target);
  if (headLine) {
    if (!baseText.includes(headLine)) {
      return { ...base, ok: false, action: 'skip', code: 'DOC_SPLIT_CONFLICT', reason: 'doc_head_mismatch', wrote: false, splitId: meta.splitId, message: '正文已被改动（头部卷清单与拆分时不一致），拒绝回滚' };
    }
    if (meta.headBefore) baseText = baseText.replace(headLine, meta.headBefore);
    else baseText = removeWholeLine(baseText, headLine, eol);
    if (baseText === null) return { ...base, ok: false, action: 'skip', code: 'DOC_SPLIT_CONFLICT', reason: 'doc_head_mismatch', wrote: false, splitId: meta.splitId, message: '头部卷清单行删除失败，拒绝回滚' };
  }
  const supParsed = parseRequirementSections(fs.readFileSync(target.abs, 'utf8'));
  const blocks = (meta.movedSections || []).map((title) => {
    const sec = supParsed.sections.find((s) => s.title === title);
    return sec ? sec.text : undefined;
  });
  if (blocks.some((b) => b === undefined)) {
    return { ...base, ok: false, action: 'skip', code: 'DOC_SPLIT_CONFLICT', reason: 'supplement_section_missing', wrote: false, splitId: meta.splitId, message: '卷里找不到拆分时搬走的小节，拒绝回滚' };
  }
  const restored = insertBlocks(baseText, meta.inserts || [], blocks);
  if (restored === null) {
    return { ...base, ok: false, action: 'skip', code: 'DOC_SPLIT_CONFLICT', reason: 'anchor_missing', wrote: false, splitId: meta.splitId, message: '正文缺少回滚锚点小节，拒绝回滚' };
  }
  if (sha256(restored) !== String(meta.preSha256 || '')) {
    return { ...base, ok: false, action: 'skip', code: 'DOC_SPLIT_CONFLICT', reason: 'restore_sha_mismatch', wrote: false, splitId: meta.splitId, message: '并回后正文 sha 与拆分前不一致（内容被改过），拒绝写入' };
  }
  const result = {
    ...base, ok: true, action: 'revert', mode: dryRun ? 'dry-run' : 'execute',
    splitId: meta.splitId, beforeBytes: byteLen(text), afterBytes: byteLen(restored),
    movedSections: meta.movedSections || [],
    supplement: { name: target.name, rel: target.rel, bytes: target.bytes, sha256: target.sha256 },
    restoreSha256: meta.preSha256, wrote: false,
  };
  if (dryRun) return result;
  try {
    if (injectFail('write_tmp')) throw new Error('注入失败：write_tmp');
    writeAtomicWithBackup(doc.abs, restored);
    if (injectFail('rename')) throw new Error('注入失败：rename');
    if (injectFail('write_supplement')) throw new Error('注入失败：delete_supplement');
    fs.unlinkSync(target.abs);
    if (injectFail('audit')) throw new Error('注入失败：audit');
    appendSplitAudit(projectName, {
      at: nowIso(), actor, project: projectName, requirementId, entry,
      action: 'revert', beforeBytes: byteLen(text), afterBytes: byteLen(restored),
      movedSections: meta.movedSections || [], supplement: { name: target.name, bytes: target.bytes, sha256: target.sha256, splitId: meta.splitId },
      rule: DOC_SPLIT_RULE, batchId, reason: null,
    });
  } catch (e) {
    try { writeText(doc.abs, text); } catch { /* ignore */ }
    if (e && e.code === 'DOC_SPLIT_AUDIT_UNWRITABLE') throw e;
    return { ...base, ok: false, action: 'revert', code: 'DOC_SPLIT_FAILED', reason: 'DOC_SPLIT_FAILED', wrote: false, message: `回滚失败并已恢复现场：${e && e.message ? e.message : e}` };
  }
  return { ...result, wrote: true, mode: 'execute' };
}

// ---------- 读者入口（F-7 工具侧） ----------

/** 需求行/任务行的 supplements[]（AC12：工作流 requirements[id].supplements[] 与 任务/R-*.json 同源）。 */
export function supplementRecords(projectPath, requirementId) {
  return listSupplements(projectPath, requirementId).map((s) => {
    const meta = parseSplitMeta(fs.readFileSync(s.abs, 'utf8'));
    return {
      name: s.name,
      path: s.rel,
      bytes: s.bytes,
      sha256: s.sha256,
      createdAt: (meta && meta.at) || s.mtime,
      splitId: (meta && meta.splitId) || '',
    };
  });
}

/** req show 的 supplements[]（可选内联全文）。 */
export function supplementsForShow(projectPath, requirementId, { withContent = false } = {}) {
  return listSupplements(projectPath, requirementId).map((s) => {
    const text = fs.readFileSync(s.abs, 'utf8');
    const meta = parseSplitMeta(text);
    const parsed = parseRequirementSections(text);
    const row = {
      name: s.name,
      path: s.rel,
      bytes: s.bytes,
      sha256: s.sha256,
      sha12: s.sha256.slice(0, 12),
      sections: parsed.sections.map((x) => x.title),
      splitId: (meta && meta.splitId) || '',
      at: (meta && meta.at) || s.mtime,
    };
    if (withContent) {
      if (Buffer.byteLength(text, 'utf8') > 64 * 1024) row.contentPath = s.rel;
      else row.content = text;
    }
    return row;
  });
}

/** 已外置小节 → movedTo（brief --section 用）。 */
export function movedSectionInfo(projectPath, requirementId, sectionTitle) {
  const want = normalizeSectionTitle(sectionTitle);
  for (const s of listSupplements(projectPath, requirementId)) {
    const text = fs.readFileSync(s.abs, 'utf8');
    const parsed = parseRequirementSections(text);
    const hit = parsed.sections.find((x) => normalizeSectionTitle(x.title) === want
      || x.title.includes(sectionTitle) || want.includes(normalizeSectionTitle(x.title)));
    if (hit) {
      const body = hit.text.slice(hit.text.indexOf('\n') + 1).replace(/\s+$/, '');
      return {
        name: s.name, path: s.rel, sha256: s.sha256, sha12: s.sha256.slice(0, 12), bytes: s.bytes,
        section: hit.title, content: body,
      };
    }
  }
  return null;
}

/** 项目内「已外置小节标题 → 卷」索引（brief 找不到节时兜底，也供测试断言）。 */
export function movedSectionIndex(projectPath) {
  const dir = path.join(projectPath, '需求');
  const out = [];
  for (const name of safeReaddir(dir)) {
    if (!SUPPLEMENT_RE.test(name)) continue;
    const abs = path.join(dir, name);
    const text = fs.readFileSync(abs, 'utf8');
    const meta = parseSplitMeta(text);
    let bytes = 0;
    try { bytes = fs.statSync(abs).size; } catch { bytes = 0; }
    const parsed = parseRequirementSections(text);
    for (const sec of parsed.sections) {
      out.push({
        section: sec.title, name, path: '需求/' + name, sha256: sha256(text), bytes,
        requirementId: (meta && meta.requirementId) || '',
      });
    }
  }
  return out;
}

