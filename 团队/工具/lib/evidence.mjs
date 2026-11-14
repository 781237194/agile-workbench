// 团队工作台 v2 · 证据门（T-20261113-063141-70a9）
// 目的：task done --evidence 必须能落到真实文件，防“只回执不产出”“报告改了但主树没变”。
// 规则：
// 1) 解析证据里的相对路径 → 文件/目录必须存在、非空，mtime 不早于任务开始；sha256 记进任务（evidenceFiles）。
// 2) 代码路径（src/**、团队/**）工作树 sha256 必须与“声明”一致：证据内 sha256（12~64 位十六进制）
//    或任务开始后的提交记录 after[].hash；两者都没有时只记哈希、不判失败。
// 3) 失败码：EVIDENCE_FILE_MISSING / EVIDENCE_STALE / EVIDENCE_HASH_MISMATCH，均不得 done。
// 沙盘（TEAM_SELFTEST=1）默认跳过；证据门专门用例用 TEAM_EVIDENCE_ENFORCE=1 强制打开。
import fs from 'node:fs';
import path from 'node:path';
import { fail, nowIso, hashFile, sha256, isInside, relPath, WORKSPACE } from './core.mjs';

const CODE_PREFIXES = ['src/', '团队/'];
const START_TOLERANCE_MS = 2000; // 文件系统 mtime 精度容差（同秒写入不算陈旧）
const HASH_WINDOW = 100; // 证据里 sha256 只认紧跟在路径后的这一段距离
const MAX_REFS = 20;
const MAX_DIR_FILES = 200;

// 证据正文分词：空白与中文/英文标点都当分隔符；括号里的尺寸/哈希因此不会粘到路径上。
const TOKEN_RE = /[^\s，。；、,;!?！？【】《》「」『』“”‘’（）()]+/gu;
const EDGE_LEAD = /^[<>"'`[\]{}]+/;
const EDGE_TAIL = /[<>"'`[\]{},;。，；：！？…·]+$/;

function gateSkipped() {
  return process.env.TEAM_SELFTEST === '1' && process.env.TEAM_EVIDENCE_ENFORCE !== '1';
}

/** 标准布局：<工作台>/项目/<项目名>；工作台根 = 上两级。非标准布局回落到核心 WORKSPACE。 */
export function workspaceRootOf(projectPath) {
  const abs = path.resolve(projectPath);
  if (path.basename(path.dirname(abs)) === '项目') return path.dirname(path.dirname(abs));
  return WORKSPACE;
}

function cleanToken(raw) {
  let t = String(raw || '').trim();
  t = t.replace(EDGE_LEAD, '').replace(EDGE_TAIL, '');
  // 允许证据写“ops.mjs:1517-1562”“app.js#L10-20”这类行号后缀，解析前剥掉。
  t = t.replace(/#L\d+(?:-\d+)?$/i, '');
  t = t.replace(/(?<![A-Za-z]):\d+(?:-\d+)?$/, '');
  return t;
}

function normalizeRef(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function looksLikePath(token) {
  if (!token || token.length > 260) return false;
  if (!/[\\/]/.test(token)) return false; // 只认带目录的相对路径，避免把 main.js/ops.mjs 这类简写误判
  if (/^\d+(?:[\\/]\d+)+$/.test(token)) return false; // 10/10、1280/1680 这类比例/尺寸不是路径
  if (/^(?:https?|file):/i.test(token)) return false;
  if (/^\/\//.test(token)) return false;
  if (/[*?]/.test(token)) return false;
  if (token.includes('…')) return false; // 缩写路径无法复核
  return true;
}

function scanRefs(evidence) {
  const text = String(evidence || '');
  const refs = [];
  const seen = new Set();
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text))) {
    const raw = m[0];
    const token = cleanToken(raw);
    if (!looksLikePath(token)) continue;
    const ref = normalizeRef(token);
    const key = ref.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ ref, raw, index: m.index, end: m.index + raw.length });
    if (refs.length >= MAX_REFS) break;
  }
  return refs;
}

function scanHashes(evidence) {
  const text = String(evidence || '');
  const out = [];
  const seen = new Set();
  const re = /([0-9a-fA-F]{64})|(?:sha256|sha-256|SHA256|哈希|hash)\s*[:：=]?\s*([0-9a-fA-F]{12,63})/g;
  let m;
  while ((m = re.exec(text))) {
    const value = String(m[1] || m[2] || '').toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({ value, index: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** 证据里紧随该路径（中间不夹别的路径）的 sha256 才算它的声明。 */
function declaredFromEvidence(ref, refs, hashes) {
  for (const h of hashes) {
    if (h.index < ref.end) continue;
    if (h.index - ref.end > HASH_WINDOW) break;
    const between = refs.some((r) => r !== ref && r.index > ref.index && r.index < h.index);
    if (between) break;
    return { value: h.value, source: 'evidence' };
  }
  return null;
}

/** 任务开始后的提交记录里，同一目标文件的 after 哈希也算声明（前后 1 秒容差）。 */
function declaredFromCommit(relWs, commits, startMs) {
  let found = null;
  for (const c of commits || []) {
    const at = Date.parse(String((c && c.createdAt) || ''));
    if (!at || at + 1000 < startMs) continue;
    const after = Array.isArray(c.after) ? c.after : [];
    const hit = after.find((f) => normalizeRef(f && f.target) === relWs);
    if (hit && hit.hash) found = { value: String(hit.hash).toLowerCase(), source: `commit:${c.id}` };
  }
  return found;
}

function resolveRef(ref, { projectPath, workspaceRoot }) {
  const rel = normalizeRef(ref);
  const candidates = [];
  if (path.isAbsolute(rel)) {
    candidates.push(path.resolve(rel));
  } else {
    candidates.push(path.resolve(projectPath, rel));
    candidates.push(path.resolve(workspaceRoot, rel));
  }
  for (const abs of candidates) {
    if (!isInside(projectPath, abs) && !isInside(workspaceRoot, abs)) continue;
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

function fileFacts(abs) {
  const st = fs.statSync(abs);
  return {
    kind: 'file',
    size: st.size,
    mtimeMs: st.mtimeMs,
    mtime: new Date(st.mtimeMs).toISOString(),
    sha256: hashFile(abs),
  };
}

function dirFacts(abs) {
  const collected = [];
  const walk = (dir, depth) => {
    if (depth > 6 || collected.length >= MAX_DIR_FILES) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p, depth + 1);
      else if (ent.isFile()) collected.push(p);
    }
  };
  walk(abs, 0);
  const rows = collected.map((p) => {
    const st = fs.statSync(p);
    return { rel: relPath(abs, p), size: st.size, mtimeMs: st.mtimeMs, sha256: hashFile(p) };
  }).sort((a, b) => a.rel.localeCompare(b.rel));
  const newest = rows.length ? Math.max(...rows.map((r) => r.mtimeMs)) : 0;
  return {
    kind: 'dir',
    fileCount: rows.length,
    size: rows.reduce((s, r) => s + r.size, 0),
    mtimeMs: newest,
    mtime: newest ? new Date(newest).toISOString() : '',
    sha256: sha256(rows.map((r) => `${r.rel}:${r.sha256}`).join('\n')),
  };
}

function hashMatches(declared, computed) {
  const want = String(declared || '').toLowerCase();
  if (!want) return true;
  return want.length >= 64 ? computed === want : computed.startsWith(want);
}

/**
 * 校验 task done 的证据。失败直接抛 TeamError（调用方不要先落状态）。
 * 返回 { ok, skipped, code, checkedAt, files, taskStart }；
 * files 写入任务 JSON 的 evidenceFiles，字段：path/scope/kind/size/mtime/sha256（+declared/declaredSource）。
 */
export function checkEvidenceGate({ projectPath, task, evidence, commits = [] }) {
  const checkedAt = nowIso();
  if (gateSkipped()) return { ok: true, skipped: true, code: 'EVIDENCE_SELFTEST_SKIP', checkedAt, files: [] };

  const taskId = String((task && task.id) || '');
  const startAt = String((task && (task.claimedAt || task.createdAt)) || '');
  const startMs = Date.parse(startAt) || 0;
  const text = String(evidence || '').trim();
  const refs = scanRefs(text);
  const baseDetails = { taskId, evidence: text.slice(0, 200), refs: refs.map((r) => r.ref) };

  if (!refs.length) {
    fail('EVIDENCE_FILE_MISSING', '证据里没有可校验的相对路径：请写清产出文件（如 程序员A/产出/实现说明-v43.md）再 task done', baseDetails);
  }

  const workspaceRoot = workspaceRootOf(projectPath);
  const hashes = scanHashes(text);
  const files = [];

  for (const ref of refs) {
    const abs = resolveRef(ref.ref, { projectPath, workspaceRoot });
    if (!abs) {
      fail('EVIDENCE_FILE_MISSING', `证据文件不存在（或不在项目/工作台内）：${ref.ref}`, { ...baseDetails, ref: ref.ref, projectPath, workspaceRoot });
    }
    const isDir = ref.ref.endsWith('/') || fs.statSync(abs).isDirectory();
    const facts = isDir ? dirFacts(abs) : fileFacts(abs);
    const scope = isInside(projectPath, abs) ? 'project' : 'workspace';
    const relWs = relPath(workspaceRoot, abs).replace(/\\/g, '/');

    if (!isDir && facts.size === 0) {
      fail('EVIDENCE_FILE_MISSING', `证据文件是空文件（0 字节）：${ref.ref}`, { ...baseDetails, ref: ref.ref });
    }
    if (isDir && facts.fileCount === 0) {
      fail('EVIDENCE_FILE_MISSING', `证据目录里没有文件：${ref.ref}`, { ...baseDetails, ref: ref.ref });
    }
    if (startMs && facts.mtimeMs + START_TOLERANCE_MS < startMs) {
      fail('EVIDENCE_STALE', `证据文件早于任务开始（疑似旧文件顶替）：${ref.ref}，mtime=${facts.mtime}，任务开始=${startAt}`, {
        ...baseDetails, ref: ref.ref, mtime: facts.mtime, taskStart: startAt,
      });
    }

    const entry = {
      path: ref.ref,
      scope,
      kind: facts.kind,
      size: facts.size,
      mtime: facts.mtime,
      sha256: facts.sha256,
      ...(isDir ? { fileCount: facts.fileCount } : {}),
    };

    // 代码路径：工作树哈希必须与声明一致（证据内 sha256 优先，其次任务开始后的提交记录）。
    if (facts.kind === 'file' && CODE_PREFIXES.some((p) => relWs.startsWith(p))) {
      const declared = declaredFromEvidence(ref, refs, hashes) || declaredFromCommit(relWs, commits, startMs);
      if (declared && !hashMatches(declared.value, facts.sha256)) {
        fail('EVIDENCE_HASH_MISMATCH', `代码文件工作树哈希与声明不一致：${ref.ref}（声明 ${declared.value.slice(0, 12)}…，实际 ${facts.sha256.slice(0, 12)}…）`, {
          ...baseDetails, ref: ref.ref, declared: declared.value, declaredSource: declared.source, actual: facts.sha256,
        });
      }
      if (declared) {
        entry.declared = declared.value;
        entry.declaredSource = declared.source;
      }
    }

    files.push(entry);
  }

  return { ok: true, skipped: false, code: 'EVIDENCE_OK', checkedAt, files, taskStart: startAt };
}
