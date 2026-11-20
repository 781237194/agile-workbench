/**
 * rolecard-sync.mjs —— R-bf05（T-20261119-181230-feee）角色卡与六卡模板的版本化同步
 *
 * 口径（需求 v2 `be3eb790`，§7.1–§7.4）：
 *   · 模板正文 = GENERATED_ROLE_CARDS[role] 的**源文本**（未渲染/未替换占位符），由 scaffold.templateSourceOf 提供；
 *   · 卡内标记（H1 下一行）：`<!-- rolecard: template=<role> version=<X.Y.Z> sha12=<12位> generated=<YYYY-MM-DD> -->`；
 *   · 落后判据唯一：无标记 → 落后(version=0)；sha12 ≠ 源文本 sha12 → 落后；相等 → 最新；**不按语义版本比大小**；
 *   · 节按 key 匹配（M3）：显式 `<!-- rolecard-section: <key> -->` / `<!-- rolecard-standard:<key>:begin/end -->` 优先，
 *     否则按标题关键词表（如「场景覆盖」→ scene-coverage）；同义异名只给 `rename` 建议，**不自动改**；
 *   · `--apply` 只两写：新增缺失标准节、替换 `<!-- rolecard-standard:<key>:begin/end -->` 内标准块；
 *     `manual` 段与未标记自定义节**逐字保留**；模板没有的 key → `keep`，不计冲突/落后差异（M2a）；
 *   · 冲突：该节不写、`ok=false` + `partial=true`，其余无冲突节照写；写前备份、锁内读→合并→备份→写→审计。
 *
 * 本模块只做纯逻辑 + 文件操作；CLI 接线在 team.mjs（`rolecard sync`），检测入口见 rolecardStaleOf。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS, exists, ensureDir, fail, nowIso, stamp, withLock, appendLine } from './core.mjs';
import { ROLE_DIRS, ROLE_NAMES, rolesForMode, normalizeTeamMode } from './roles.mjs';
import { loadProject, projectStatePaths } from './store.mjs';
import { templateSourceOf, roleCard } from './scaffold.mjs';

/* ── 常量与路径 ───────────────────────────────────────────────────────── */
export const MARKER_RE = /<!--\s*rolecard:\s*template=([^\s]+)\s+version=(\S+)\s+sha12=([0-9a-f]{6,64})\s+generated=(\d{4}-\d{2}-\d{2})\s*-->/i;
export const SECTION_MARK_RE = /<!--\s*rolecard-section:\s*([A-Za-z0-9_-]+)\s*-->/i;
export const STANDARD_BEGIN_RE = /<!--\s*rolecard-standard:([A-Za-z0-9_-]+):begin\s*-->/i;
export const STANDARD_END_RE = /<!--\s*rolecard-standard:([A-Za-z0-9_-]+):end\s*-->/i;
export const MANUAL_BEGIN_RE = /<!--\s*manual:begin\s*-->/i;
export const MANUAL_END_RE = /<!--\s*manual:end\s*-->/i;
export const MANIFEST_NAME = '角色卡模板版本.json';
export const AUDIT_CHECK = 'rolecard检查.jsonl';
export const AUDIT_SYNC = 'rolecard同步.jsonl';
export const BACKUP_DIR_NAME = '证据-rolecard-sync';
export const LOCK_TTL_MS = 30000;

/** 标题关键词表（M3）：hit → 标准节 key；用于无显式 key 时的同义异名识别。 */
export const SECTION_KEYWORDS = [
  { key: 'scene-coverage', keywords: ['场景覆盖'] },
  { key: 'workflow-align', keywords: ['现行工作流对齐', '工作流对齐'] },
  // 流程.md §D2（Owner 2026-11-20 12:0x）：已存在项目卡靠该 key 识别/增补「子代理使用边界」节。
  // 关键词必须含「使用边界」四字——只写「子代理」会误命中各卡已有的「## 子代理」节。
  { key: 'subagent-boundary', keywords: ['子代理使用边界'] },
];

/** 需求 §7.4 逐字标题（模板标准节；用于 rename 建议与新增标题）。 */
export const STANDARD_TITLES = {
  'scene-coverage': '## 场景覆盖准则（§H，Owner 2026-11-19 强制）',
  'workflow-align': '## 现行工作流对齐（2026-11-18 校准 · 发版基线）',
  // 与 scaffold 模板（gen-role-card-template.cjs → SUBAGENT_BOUNDARY_SECTION）的标题逐字一致。
  'subagent-boundary': '## 子代理使用边界（流程.md §D2）',
};

export function manifestPath() {
  return path.join(PATHS.teamRoot, '工具', '模板', MANIFEST_NAME);
}

export function cardPathOf(project, role) {
  const proj = loadProject(project);
  const dirName = ROLE_DIRS[role] || role;
  return path.join(String(proj.path || ''), dirName, '角色卡.md');
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}
function sha12(text) {
  return sha256(text).slice(0, 12);
}
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/* ── manifest（版本源；缺失/坏 → 降级按源文本 sha12，并给 TEMPLATE_MANIFEST_DRIFT） ── */
export function readManifest() {
  const file = manifestPath();
  if (!exists(file)) return { ok: false, code: 'TEMPLATE_MANIFEST_MISSING', file, roles: {} };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const roles = data && typeof data.roles === 'object' && data.roles ? data.roles : {};
    return { ok: true, file, roles };
  } catch (error) {
    return { ok: false, code: 'TEMPLATE_MANIFEST_UNREADABLE', file, roles: {}, error: String((error && error.message) || error) };
  }
}

/** 模板视图：源文本 + sha + 版本（manifest 有则用之，否则 1.0.0）+ drift 判定。 */
export function templateOf(role) {
  const src = templateSourceOf(role);
  if (src.missing) return { ok: false, code: 'TEMPLATE_MISSING', role };
  const digest = sha256(src.source);
  const manifest = readManifest();
  const row = manifest.roles && manifest.roles[role] ? manifest.roles[role] : null;
  const drift = Boolean(row && row.sha256 && String(row.sha256) !== digest);
  return {
    ok: true,
    role,
    source: src.source,
    sha256: digest,
    sha12: digest.slice(0, 12),
    version: String((row && row.version) || '1.0.0'),
    versionSource: row && row.version ? 'manifest' : 'default',
    fallback: Boolean(src.fallback),
    manifest: { ok: manifest.ok, code: manifest.code || '', path: manifest.file },
    drift,
    driftCode: drift ? 'TEMPLATE_MANIFEST_DRIFT' : '',
  };
}

export function writeManifest({ updatedBy = 'system', roles = null } = {}) {
  const list = Array.isArray(roles) && roles.length ? roles : ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
  const data = { schema: 1, updatedAt: nowIso(), updatedBy: String(updatedBy || 'system'), roles: {} };
  for (const role of list) {
    const t = templateOf(role);
    if (!t.ok) continue;
    const prev = readManifest().roles[role] || {};
    // 源文本变了 → 版本号 +0.0.1（语义版本只做展示，判据永远是 sha12）。
    let version = String(prev.version || '1.0.0');
    if (prev.sha256 && String(prev.sha256) !== t.sha256) {
      const parts = version.split('.').map((n) => Number(n) || 0);
      version = `${parts[0] || 1}.${parts[1] || 0}.${(parts[2] || 0) + 1}`;
    }
    data.roles[role] = { version, sha256: t.sha256, sha12: t.sha12, updatedAt: nowIso(), updatedBy: String(updatedBy || 'system') };
  }
  const file = manifestPath();
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return { ok: true, file, roles: Object.keys(data.roles) };
}

/* ── 卡解析：标记 + 节 ───────────────────────────────────────────────── */
export function cardMarkerOf(text) {
  const m = String(text || '').match(MARKER_RE);
  if (!m) return { exists: false, template: '', version: '0', sha12: '', generated: '' };
  return { exists: true, template: m[1], version: m[2], sha12: m[3], generated: m[4] };
}

export function markerLineOf(role, template) {
  return `<!-- rolecard: template=${role} version=${template.version} sha12=${template.sha12} generated=${todayUtc()} -->`;
}

/** 标题 → key（显式标记优先，其次关键词表，最后 slug）。 */
function keyOfHeading(heading, bodyText) {
  const explicit = String(bodyText || '').match(SECTION_MARK_RE);
  if (explicit) return { key: String(explicit[1]), source: 'marker' };
  const std = String(bodyText || '').match(STANDARD_BEGIN_RE);
  if (std) return { key: String(std[1]), source: 'standard' };
  const title = String(heading || '').replace(/^#+\s*/, '');
  for (const row of SECTION_KEYWORDS) {
    if (row.keywords.some((k) => title.includes(k))) return { key: row.key, source: 'keyword' };
  }
  const slug = title.replace(/^[A-Za-z0-9.\-]+\s+/, '').trim().slice(0, 24)
    .replace(/[^A-Za-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
  return { key: `title:${slug}`, source: 'slug' };
}

/**
 * 解析卡：`{preamble, marker, sections:[{key,title,text,start,end,standard,manual,headingLine}], manualBlocks}`。
 * 节 = 从 `## ` 标题到下一个同级或更高级标题。
 */
/**
 * 扫描 `<!-- rolecard-standard:<key>:begin/end -->` 配对（支持同一行内出现、支持嵌套同类标记、支持行首/行尾）。
 * 返回 `{ key, startLine, endLine, startCol, endCol, closed }` 列表；未闭合的只返回 `closed:false` 不参与归属。
 */
export function blockSpansOf(lines) {
  const stack = [];
  const blocks = [];
  const BEGIN = /<!--\s*rolecard-standard:([A-Za-z0-9_~-]+):begin\s*-->/g;
  const END = /<!--\s*rolecard-standard:([A-Za-z0-9_~-]+):end\s*-->/g;
  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i] || '');
    const marks = [];
    BEGIN.lastIndex = 0;
    let m;
    while ((m = BEGIN.exec(line)) !== null) marks.push({ kind: 'begin', key: m[1], col: m.index });
    END.lastIndex = 0;
    while ((m = END.exec(line)) !== null) marks.push({ kind: 'end', key: m[1], col: m.index });
    marks.sort((a, b) => a.col - b.col);
    for (const mark of marks) {
      if (mark.kind === 'begin') {
        stack.push({ key: mark.key, startLine: i, startCol: mark.col });
        continue;
      }
      // end：从栈顶向下找同 key（嵌套同类标记按 LIFO 配对）。
      let hit = -1;
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        if (stack[k].key === mark.key) { hit = k; break; }
      }
      if (hit < 0) continue; // 孤立 end：不归属、不抛错
      const open = stack[hit];
      stack.splice(hit, 1);
      blocks.push({ key: open.key, startLine: open.startLine, endLine: i, startCol: open.startCol, endCol: mark.col, closed: true });
    }
  }
  for (const open of stack) blocks.push({ key: open.key, startLine: open.startLine, endLine: lines.length - 1, startCol: open.startCol, endCol: -1, closed: false });
  blocks.sort((a, b) => a.startLine - b.startLine || a.startCol - b.startCol);
  return blocks;
}

/** 行 i 是否被某个已闭合 block 覆盖；返回最内层 block（行内起止也算）。 */
function innermostBlockAt(blocks, line) {
  let best = null;
  for (const b of blocks) {
    if (!b.closed) continue;
    if (line < b.startLine || line > b.endLine) continue;
    // 行内起止：同一行既 begin 又 end 时，只有包含标题的行才算（标题在 begin 之后同一行/后续行）。
    if (!best || (b.endLine - b.startLine) <= (best.endLine - best.startLine)) best = b;
  }
  return best;
}

/**
 * 解析卡：节归属**按显式 begin/end 配对**，不按「上一个标题」推断（B-13d7）。
 * - 标题行落在某个已闭合 standard block 内 → 该节 = 整个 block（含 begin/end 行），key=block.key、standard=true；
 * - 标题不在任何 block 内 → 节从标题到下一个「标题或 block 起点」，key 由 `rolecard-section`/关键词/标题 slug 决定；
 * - 没有任何标题的 block → 作为独立节（key=block.key、title=''），仍可被替换/比对。
 */
export function parseCard(text) {
  const src = String(text || '');
  const lines = src.split(/\r?\n/);
  const marker = cardMarkerOf(src);
  const blocks = blockSpansOf(lines);
  const closed = blocks.filter((b) => b.closed);
  const headingIdx = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s+\S/.test(lines[i])) headingIdx.push(i);
  }
  // 每个标题的归属：在内层 block 里就用 block 的 key/跨度；否则普通节。
  const regions = [];
  const usedBlocks = new Set();
  for (const h of headingIdx) {
    const block = innermostBlockAt(closed, h);
    if (block) {
      if (usedBlocks.has(block)) continue; // 同一 block 内多个标题：只取第一个作为该 block 的标题
      usedBlocks.add(block);
      regions.push({ start: block.startLine, end: block.endLine + 1, key: block.key, keySource: 'standard', standard: true, titleLine: h, block });
      continue;
    }
    // 普通节：到下一个标题或下一个未归属 block 起点为止
    const nextHeading = headingIdx.find((x) => x > h);
    const nextBlockStart = closed
      .filter((b) => !usedBlocks.has(b) && b.startLine > h)
      .map((b) => b.startLine)
      .sort((a, b) => a - b)[0];
    let end = lines.length;
    if (nextHeading !== undefined) end = Math.min(end, nextHeading);
    if (nextBlockStart !== undefined) end = Math.min(end, nextBlockStart);
    regions.push({ start: h, end, key: '', keySource: '', standard: false, titleLine: h, block: null });
  }
  // 没有标题的 block：作为独立节（按行序插入）
  for (const b of closed) {
    if (usedBlocks.has(b)) continue;
    usedBlocks.add(b);
    regions.push({ start: b.startLine, end: b.endLine + 1, key: b.key, keySource: 'standard', standard: true, titleLine: -1, block: b });
  }
  regions.sort((a, b) => a.start - b.start);
  // 修正普通节的 end：不能盖住后面的 region 起点
  for (let i = 0; i < regions.length; i += 1) {
    const r = regions[i];
    if (!r.standard && i + 1 < regions.length) r.end = Math.min(r.end, regions[i + 1].start);
  }
  const preambleEnd = regions.length ? regions[0].start : lines.length;
  const preamble = lines.slice(0, preambleEnd).join('\n');
  const sections = [];
  for (const r of regions) {
    const body = lines.slice(r.start, r.end);
    const textBlock = body.join('\n');
    const title = r.titleLine >= 0 ? String(lines[r.titleLine] || '').trim() : '';
    const keyInfo = r.standard ? { key: r.key, source: 'standard' } : keyOfHeading(title, textBlock);
    sections.push({
      key: keyInfo.key,
      keySource: keyInfo.source,
      title,
      text: textBlock,
      lines: body,
      start: r.start,
      end: r.end,
      standard: Boolean(r.standard),
      manual: MANUAL_BEGIN_RE.test(textBlock),
      headingLine: title,
      block: r.block ? { key: r.block.key, startLine: r.block.startLine, endLine: r.block.endLine } : null,
    });
  }
  const seen = new Map();
  for (const sec of sections) {
    const n = (seen.get(sec.key) || 0) + 1;
    seen.set(sec.key, n);
    if (n > 1) sec.key = `${sec.key}~${n}`;
  }
  return { text: src, lines, preamble, marker, sections, blocks, manualBlocks: (src.match(/<!--\s*manual:begin[\s\S]*?<!--\s*manual:end\s*-->/gi) || []).length };
}

/** 模板节：以**渲染后**模板（与新建项目同源）切节——判据 sha 仍用源文本（见 templateOf）。 */
export function templateSections(template, { projectName = '', role = template.role, mode = 'full' } = {}) {
  const rendered = roleCard(projectName || '__project__', role || template.role, normalizeTeamMode(mode));
  const parsed = parseCard(rendered);
  const out = parsed.sections.map((s) => ({ key: s.key, title: s.title, text: s.text }));
  return { sections: out, markerline: parsed.marker };
}

/** 规范化比较：去首尾空行/行尾空格、连续空行折叠为一行、标准标记行忽略。 */
export function normalizeSection(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => !/^<!--\s*rolecard-(standard|section):/i.test(l.trim()));
  const out = [];
  for (const line of lines) {
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n').trim();
}

/* ── 落后检测（唯一入口；三处共用） ───────────────────────────────────── */
/**
 * @returns {{ok:boolean, code?:string, role, stale:boolean, diffCount:number, cardVersion, templateVersion,
 *   cardSha12, templateSha12, templateFallback, drift, reasons:string[], card:{exists,path}}}
 */
export function rolecardStaleOf(project, role, { log = false } = {}) {
  const roleId = String(role || '');
  const t = templateOf(roleId);
  if (!t.ok) return { ok: false, code: t.code, role: roleId, stale: true, diffCount: 0 };
  const cardPath = cardPathOf(project, roleId);
  const cardExists = exists(cardPath);
  const text = cardExists ? fs.readFileSync(cardPath, 'utf8') : '';
  const parsed = parseCard(text);
  const reasons = [];
  let stale;
  let cardVersion;
  let cardSha12;
  let diffCount = 0;
  if (!cardExists) {
    stale = true;
    cardVersion = '';
    cardSha12 = '';
    reasons.push('ROLE_CARD_MISSING');
  } else if (!parsed.marker.exists) {
    stale = true;
    cardVersion = '0';
    cardSha12 = '';
    reasons.push('NO_MARKER');
  } else {
    cardVersion = parsed.marker.version;
    cardSha12 = parsed.marker.sha12;
    stale = String(parsed.marker.sha12) !== String(t.sha12);
    if (stale) reasons.push('SHA12_MISMATCH');
  }
  // 差异处数（M2a：模板缺的节、人工段、未标记节不计）
  const projMeta = (() => { try { const pr = loadProject(project); return { name: String(pr.name || project), mode: String(pr.teamMode || 'full') }; } catch { return { name: String(project), mode: 'full' }; } })();
  const tpl = templateSections(t, { projectName: projMeta.name, role: roleId, mode: projMeta.mode });
  const cardKeys = new Map(parsed.sections.map((s) => [s.key, s]));
  for (const sec of tpl.sections) {
    const hit = cardKeys.get(sec.key);
    if (!hit) { diffCount += 1; continue; }
    if (normalizeSection(hit.text) !== normalizeSection(sec.text)) diffCount += 1;
  }
  if (t.drift) reasons.push('TEMPLATE_MANIFEST_DRIFT');
  if (t.fallback) reasons.push('TEMPLATE_FALLBACK');
  const result = {
    ok: true,
    role: roleId,
    stale,
    diffCount,
    cardVersion,
    templateVersion: t.version,
    cardSha12: cardSha12 || '',
    templateSha12: t.sha12,
    templateFallback: t.fallback,
    drift: t.drift,
    reasons,
    card: { exists: cardExists, path: cardPath, sha256: cardExists ? sha256(text) : '' },
  };
  if (log) {
    try {
      const dir = projectStatePaths(project).dir;
      ensureDir(dir);
      appendLine(path.join(dir, AUDIT_CHECK), JSON.stringify({
        at: nowIso(), action: 'rolecard_stale_check', project, role: roleId,
        stale, diffCount, cardVersion: result.cardVersion, templateVersion: t.version,
        cardSha12: result.cardSha12, templateSha12: t.sha12, reasons,
      }));
    } catch { /* 审计写不了不阻断检测 */ }
  }
  return result;
}

/* ── 合并计划（dry-run 与 apply 共用） ───────────────────────────────── */
/**
 * @returns {{ok, project, role, changes:[{section,action,diffLines,title}], conflicts:[], rename:[], wrote, ...}}
 */
export function planRoleCardSync(project, role) {
  const roleId = String(role || '');
  const t = templateOf(roleId);
  if (!t.ok) fail(t.code, `模板缺失：${roleId}`, { role: roleId, project });
  const cardPath = cardPathOf(project, roleId);
  if (!exists(cardPath)) fail('ROLE_CARD_MISSING', `角色卡不存在：${cardPath}（先 project ensure 补齐）`, { role: roleId, project, cardPath });
  const text = fs.readFileSync(cardPath, 'utf8');
  const parsed = parseCard(text);
  const projMeta = (() => { try { const pr = loadProject(project); return { name: String(pr.name || project), mode: String(pr.teamMode || 'full') }; } catch { return { name: String(project), mode: 'full' }; } })();
  const tpl = templateSections(t, { projectName: projMeta.name, role: roleId, mode: projMeta.mode });
  const cardByKey = new Map(parsed.sections.map((s) => [s.key, s]));
  const tplKeys = new Set(tpl.sections.map((s) => s.key));
  const changes = [];
  const conflicts = [];
  const renames = [];
  const addSections = [];
  const updateSections = [];
  for (const sec of tpl.sections) {
    const hit = cardByKey.get(sec.key);
    if (!hit) {
      changes.push({ section: sec.key, action: 'add', title: sec.title, diffLines: normalizeSection(sec.text).split(/\r?\n/).length });
      addSections.push(sec);
      continue;
    }
    const same = normalizeSection(hit.text) === normalizeSection(sec.text);
    if (same) {
      // 逐字相同（含新建项目刚生成的卡）→ keep，0 差异、不写卡。
      // 受标记段的补齐只在需要写卡时才做（避免「刚建的卡也被判成要更新」，AC1③ 要求 0 差异）。
      changes.push({ section: sec.key, action: 'keep', title: hit.title, diffLines: 0 });
      continue;
    }
    // 不同：人工段 / 未标记自定义节不参与覆盖；同 key 内容不同 → conflict
    if (hit.manual) {
      changes.push({ section: sec.key, action: 'keep', title: hit.title, diffLines: 0, reason: 'manual' });
      continue;
    }
    // M3：同义异名（关键词表匹配且标题不同）→ 只给 rename 建议，不自动改、不算冲突。
    if (hit.keySource === 'keyword' && normalizeSection(hit.headingLine) !== normalizeSection(sec.title)) {
      renames.push({ section: sec.key, from: hit.headingLine, to: STANDARD_TITLES[sec.key] || sec.title });
      changes.push({ section: sec.key, action: 'keep', title: hit.headingLine, diffLines: 0, reason: 'rename-suggested' });
      continue;
    }
    conflicts.push({ section: sec.key, title: hit.title, diffLines: 1, reason: 'CONTENT_DIFF' });
    changes.push({ section: sec.key, action: 'conflict', title: hit.title, diffLines: 1 });
    // 冲突节**不写**（只记录；不加入 updateSections）。
  }
  // 同义异名节（无 key 但标题命中关键词）→ rename 建议，不自动改
  for (const [key, hit] of cardByKey) {
    if (tplKeys.has(key)) continue;
    if (String(key).startsWith('title:')) {
      for (const row of SECTION_KEYWORDS) {
        if (!tplKeys.has(row.key)) continue;
        const tplSec = tpl.sections.find((s) => s.key === row.key);
        if (!tplSec) continue;
        if (row.keywords.some((k) => hit.title.includes(k))) {
          renames.push({ section: row.key, from: hit.title, to: STANDARD_TITLES[row.key] || tplSec.title });
        }
      }
    }
  }
  // 模板没有的 key：keep（M2a，不计 conflict/落后差异）
  for (const sec of parsed.sections) {
    if (tplKeys.has(sec.key)) continue;
    if (changes.some((c) => c.section === sec.key)) continue;
    changes.push({ section: sec.key, action: 'keep', title: sec.title, diffLines: 0, reason: 'not-in-template' });
  }
  return {
    ok: conflicts.length === 0,
    partial: conflicts.length > 0,
    project,
    role: roleId,
    cardPath,
    cardSha256: sha256(text),
    cardVersion: parsed.marker.version || '0',
    cardSha12: parsed.marker.sha12 || '',
    templateVersion: t.version,
    templateSha12: t.sha12,
    stale: !parsed.marker.exists || String(parsed.marker.sha12) !== String(t.sha12),
    templateFallback: t.fallback,
    drift: t.drift,
    template: t,
    changes,
    conflicts,
    renames,
    addSections,
    updateSections,
    wrote: false,
    parsed,
    markerExists: parsed.marker.exists,
  };
}

/** 用受标记段替换/插入；manual 段与未标记自定义节逐字保留。 */
export function buildMergedCard(plan) {
  const parsed = plan.parsed;
  const lines = parsed.lines.slice();
  const rendered = [];
  const begin = (key) => `<!-- rolecard-standard:${key}:begin -->`;
  const end = (key) => `<!-- rolecard-standard:${key}:end -->`;
  // 只剥标题行与尾部空白，**保留标题后的空行**：写入块必须与模板节正文逐字一致，否则二次 sync 会把
  // 「少一个空行」判成 CONTENT_DIFF，永久不收敛（§D2 subagent-boundary 幂等断言 D4 踩到过）。
  const bodyOf = (text) => String(text || '')
    .replace(/^#+\s+[^\n]*\n?/, '')
    .replace(/\s+$/, '');
  const sectionText = (sec) => [begin(sec.key), sec.title, bodyOf(sec.text), end(sec.key)].join('\n');
  // 1) 替换已有的受标记/同 key 节（按 parse 得到的 start/end 行区间倒序重建）
  const replacements = new Map();
  for (const up of plan.updateSections) {
    const hit = parsed.sections.find((s) => s.key === up.key);
    if (!hit) continue;
    if (up.mode === 'marker-only') {
      const body = hit.text;
      if (/<!--\s*rolecard-standard:/.test(body)) continue;
      const title = hit.headingLine;
      const rest = body.split(/\r?\n/).slice(1).join('\n').replace(/\s+$/, '');
      replacements.set(hit.start, { end: hit.end, lines: [begin(hit.key), title, rest, end(hit.key)] });
    } else {
      const tplSec = up;
      const title = hit.headingLine;
      const tplBody = bodyOf(tplSec.text);
      replacements.set(hit.start, { end: hit.end, lines: [begin(hit.key), title, tplBody, end(hit.key)] });
    }
  }
  const order = [...replacements.entries()].sort((a, b) => b[0] - a[0]);
  for (const [start, rep] of order) lines.splice(start, rep.end - start, ...rep.lines);
  // 2) 新增缺失标准节（追加到最后一个 ## 节之后；若无节则在文末）
  let out = lines.join('\n').replace(/\s+$/, '');
  const addedKeys = [];
  for (const sec of plan.addSections) {
    out += '\n\n' + sectionText(sec);
    addedKeys.push(sec.key);
  }
  // 3) 更新/插入标记行（H1 下一行）
  const t = plan.template;
  const marker = markerLineOf(plan.role, t);
  const outLines = out.split(/\r?\n/);
  const existingIdx = outLines.findIndex((l) => MARKER_RE.test(l));
  if (existingIdx >= 0) outLines.splice(existingIdx, 1, marker);
  else {
    const h1 = outLines.findIndex((l) => /^#\s+/.test(l));
    const at = h1 >= 0 ? h1 + 1 : 0;
    outLines.splice(at + 1, 0, '', marker);
  }
  out = outLines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
  return { text: out, addedKeys };
}

/** 执行 apply：锁内读→合并→备份→写→审计。返回 plan 增强版。 */
export function applyRoleCardSync(project, role, { actor = '', actorRole = '' } = {}) {
  const roleId = String(role || '');
  const lockKey = `rolecard:${project}:${roleId}`;
  const lockOpts = { role: 'system', sessionId: String(actor || ''), ttlMs: LOCK_TTL_MS, waitMs: 0, reason: 'rolecard sync apply' };
  return withLock(lockKey, lockOpts, () => {
    const plan = planRoleCardSync(project, roleId);
    if (plan.conflicts.length === 0 && plan.addSections.length === 0 && plan.updateSections.length === 0) {
      return { ...plan, ok: true, partial: false, wrote: false, message: '已是最新（0 差异）', next: '' };
    }
    const merged = buildMergedCard(plan);
    const before = plan.cardSha256;
    const after = sha256(merged.text);
    // 备份（失败即零写入）
    const dir = path.dirname(plan.cardPath);
    const backupDir = path.join(dir, '产出', BACKUP_DIR_NAME, stamp());
    try {
      ensureDir(backupDir);
      fs.copyFileSync(plan.cardPath, path.join(backupDir, '角色卡.md'));
      const backSha = sha256(fs.readFileSync(path.join(backupDir, '角色卡.md')));
      if (backSha !== before) fail('BACKUP_FAILED', `备份 sha 不符：期望 ${before.slice(0, 12)} 实际 ${backSha.slice(0, 12)}`, { role: roleId, project });
    } catch (error) {
      if (error && error.code === 'BACKUP_FAILED') throw error;
      fail('BACKUP_FAILED', `备份失败，已零写入：${String((error && error.message) || error)}`, { role: roleId, project, backupDir });
    }
    try {
      fs.writeFileSync(plan.cardPath, merged.text, 'utf8');
    } catch (error) {
      fail('ROLE_CARD_WRITE_FAILED', `写卡失败：${String((error && error.message) || error)}`, { role: roleId, project, cardPath: plan.cardPath, before, after });
    }
    const written = fs.readFileSync(plan.cardPath, 'utf8');
    if (sha256(written) !== after) {
      // 写后复核失败 → 用备份恢复
      try { fs.copyFileSync(path.join(backupDir, '角色卡.md'), plan.cardPath); } catch { /* 恢复失败如实报 */ }
      fail('ROLE_CARD_WRITE_FAILED', '写后复核 sha 不符，已尝试用备份恢复', { role: roleId, project, before, after, actual: sha256(written) });
    }
    try {
      const stateDir = projectStatePaths(project).dir;
      ensureDir(stateDir);
      appendLine(path.join(stateDir, AUDIT_SYNC), JSON.stringify({
        at: nowIso(), action: 'rolecard_sync_apply', project, role: roleId,
        by: String(actor || ''), byRole: String(actorRole || ''),
        cardVersion: plan.cardVersion, templateVersion: plan.templateVersion,
        beforeSha256: before, afterSha256: after,
        added: merged.addedKeys, updated: plan.updateSections.map((u) => u.key),
        conflicts: plan.conflicts.map((c) => c.section), backupDir,
      }));
    } catch { /* 审计写不了不影响写卡结果 */ }
    return {
      ...plan,
      ok: plan.conflicts.length === 0,
      partial: plan.conflicts.length > 0,
      wrote: true,
      cardSha256: after,
      backup: backupDir,
      addedKeys: merged.addedKeys,
      message: plan.conflicts.length ? '部分完成：有冲突节未写（见 conflicts）' : '已同步（只增补/更新标准节，manual 段未动）',
      next: '请重 boot（只失效本人令牌）',
    };
  });
}

/** 目标角色集合（--all 用；模式内角色）。 */
export function rolesForProject(project) {
  const proj = loadProject(project);
  const mode = normalizeTeamMode(proj.teamMode);
  const roleIds = Array.isArray(proj.roleIds) && proj.roleIds.length ? proj.roleIds : rolesForMode(mode);
  return roleIds.filter((r) => ROLE_DIRS[r]);
}

export function roleLabelOf(role) {
  return ROLE_NAMES[role] || role;
}
