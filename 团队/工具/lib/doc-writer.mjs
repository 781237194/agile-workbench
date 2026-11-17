// R-c6dc 工具侧：需求正文唯一写入口（doc-writer）+ 并发检测 + 文档登记链 + 审计
//
// 口径来源：需求/R-20261115-131204-c6dc-文档单写者与并发检测.md（12822B / 7bf497559382）
//          需求/增补卷-c6dc-1.md（10757B / fc8c92f27655，TR-Q v2 定稿：audit 契约 / RR 集合成员资格 / 锁阈值与优先级）
//
// 四件事：
//   ① writeRequirementDoc()：唯一写入口（writer 单写者、actor=system 豁免 writer、三值校验、O_EXCL 锁、登记链 prevSha）
//   ② 锁：需求/.doc-write.lock（{pid,at,host,requirementId}），LOCK_STALE_MS=60000，age>=60000 → LOCK_STALE（不自动删）
//   ③ 文档登记.jsonl：append-only，action ∈ baseline|write|freeze|unfreeze|unlock_lock|rollback|reassign
//   ④ auditRequirementDocs()：--json 恰好一行、state 五值、codes 五码、退出码 0/1/2（只报不改）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail, nowIso, sha256, hashFile, exists, ensureDir, appendLine, readJson, writeText } from './core.mjs';
import { loadProject, projectStatePaths } from './store.mjs';
import { readWorkflowState } from './lifecycle.mjs';
import { requirementContentText } from './scaffold.mjs';

export const DOC_REGISTRY_FILE = '文档登记.jsonl';
export const DOC_LOCK_FILE = '.doc-write.lock';
export const DOC_WRITER_DEFAULT = 'analyst';
export const DOC_AUDIT_STATES = ['ok', 'untracked', 'mismatch', 'missing', 'registry_broken'];
export const DOC_AUDIT_CODES = ['DOC_UNTRACKED_WRITE', 'DOC_BINDING_MISMATCH', 'DOC_BINDING_STALE', 'DOC_MISSING', 'REGISTRY_BROKEN', 'DOC_CONTENT_DRIFT'];
export const REGISTRY_ACTIONS = ['baseline', 'write', 'freeze', 'unfreeze', 'unlock_lock', 'unlock_write', 'rollback', 'reassign', 'writer'];
export const REGISTRY_KEYS = ['at', 'requirementId', 'path', 'action', 'sha256', 'bytes', 'writer', 'actor', 'prevSha', 'reason', 'transactionId'];

/** 锁超时阈值（默认 60s；测试可用 AWB_DOC_LOCK_STALE_MS 覆盖，生产不得设置）。 */
export function docLockStaleMs() {
  const raw = Number(process.env.AWB_DOC_LOCK_STALE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60000;
}

export function docRegistryPath(projectName) {
  return path.join(projectStatePaths(String(projectName)).dir, DOC_REGISTRY_FILE);
}

export function docLockPath(projectPath) {
  return path.join(String(projectPath), '需求', DOC_LOCK_FILE);
}

// ---------- 登记文件 ----------

/**
 * 读登记：返回 {ok, file, rows, errors, broken}。
 * `broken` 只表示登记文件本身解析失败（坏行/非法 JSON）——未登记≠登记损坏。
 */
export function readDocRegistry(projectName) {
  const file = docRegistryPath(projectName);
  if (!exists(file)) return { ok: true, file, rows: [], errors: [], broken: false };
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { ok: false, file, rows: [], errors: [{ error: String((e && e.message) || e) }], broken: true };
  }
  const rows = [];
  const errors = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const row = JSON.parse(s);
      if (!row || typeof row !== 'object') throw new Error('不是对象');
      rows.push(row);
    } catch (e) {
      errors.push({ line: s.slice(0, 120), error: String((e && e.message) || e) });
    }
  }
  return { ok: errors.length === 0, file, rows, errors, broken: errors.length > 0 };
}

function normalizeRel(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

/** 该路径最新一条（可指定 action 集合）。 */
export function latestDocRegistryRow(rows, relPath, actions = null) {
  const rel = normalizeRel(relPath);
  const set = actions ? new Set(actions) : null;
  let hit = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || normalizeRel(row.path) !== rel) continue;
    if (set && !set.has(String(row.action || ''))) continue;
    hit = row; // append-only：后面覆盖前面
  }
  return hit;
}

export function appendDocRegistry(projectName, row = {}) {
  const file = docRegistryPath(projectName);
  const out = {};
  for (const key of REGISTRY_KEYS) out[key] = Object.prototype.hasOwnProperty.call(row, key) ? row[key] : null;
  out.at = out.at || nowIso();
  out.action = String(out.action || 'write');
  if (!REGISTRY_ACTIONS.includes(out.action)) {
    fail('REGISTRY_ACTION_INVALID', `登记动作未登记：${out.action}（允许：${REGISTRY_ACTIONS.join('/')}）`, { action: out.action }, 1);
  }
  out.path = normalizeRel(out.path || '');
  out.requirementId = String(out.requirementId || '');
  out.actor = String(out.actor || '');
  out.writer = String(out.writer || '');
  out.reason = out.reason === undefined ? null : out.reason;
  out.transactionId = out.transactionId === undefined ? null : out.transactionId;
  try {
    ensureDir(path.dirname(file));
    appendLine(file, JSON.stringify(out));
  } catch (e) {
    // 降级：登记不可写 → 拒绝写入（fail-closed）
    fail('REGISTRY_UNWRITABLE', `文档登记不可写：${file}（${(e && e.message) || e}）；本次拒绝执行`, { file }, 2);
  }
  return { file, row: out };
}

// ---------- 台账读取（工作流 / RR / TRQ） ----------

function findRequirementTask(projectName, requirementId) {
  const dir = path.join(projectStatePaths(String(projectName)).dir, '任务');
  const file = path.join(dir, `${requirementId}.json`);
  const direct = readJson(file, null);
  if (direct) return direct;
  // 兼容：完整 id 精确优先 → 唯一兼容匹配
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return null; }
  const hits = names.filter((n) => n.startsWith(String(requirementId)));
  if (hits.length === 1) return readJson(path.join(dir, hits[0]), null);
  return null;
}

/** 候选 RR：requirementId 全等（完整 id 优先，唯一兼容匹配，多条 → REQUIREMENT_AMBIGUOUS 不猜）。 */
export function collectRequirementRrs(projectName, requirementId) {
  const dir = path.join(projectStatePaths(String(projectName)).dir, '需求评审');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^RR-.*\.json$/.test(n)); } catch { names = []; }
  const all = [];
  for (const name of names) {
    const row = readJson(path.join(dir, name), null);
    if (!row || !row.id) continue;
    all.push(row);
  }
  const exact = all.filter((row) => String(row.requirementId || '') === String(requirementId));
  if (exact.length) return exact.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  const id = String(requirementId || '').toLowerCase();
  const prefix = all.filter((row) => String(row.requirementId || '').toLowerCase().startsWith(id));
  if (prefix.length > 1) {
    fail('REQUIREMENT_AMBIGUOUS', `需求 ${requirementId} 命中多条评审记录来源：${[...new Set(prefix.map((r) => r.requirementId))].join('、')}`, {
      requirementId, candidates: [...new Set(prefix.map((r) => r.requirementId))],
    });
  }
  if (prefix.length === 1) return prefix.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  // 4 位短号兼容（唯一才认）
  const shortId = String(requirementId).slice(-4).toLowerCase();
  const byShort = all.filter((row) => String(row.requirementId || '').toLowerCase().endsWith('-' + shortId));
  if (byShort.length && new Set(byShort.map((r) => r.requirementId)).size === 1) {
    return byShort.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  }
  return [];
}

function requirementRowOf(projectName, requirementId) {
  try {
    const read = readWorkflowState(projectName);
    const rows = (read.state && read.state.requirements) || {};
    return rows[requirementId] || Object.values(rows).find((r) => r && String(r.id || '') === String(requirementId)) || null;
  } catch { return null; }
}

// ---------- 写入口 ----------

function shaMatches(declared, actual) {
  const d = String(declared || '').trim().toLowerCase();
  const a = String(actual || '').trim().toLowerCase();
  if (!d || !a) return false;
  if (!/^[0-9a-f]{12,64}$/.test(d)) return false;
  return a.startsWith(d) || d === a;
}

function lockInfo(projectPath) {
  const file = docLockPath(projectPath);
  if (!exists(file)) return { file, exists: false };
  const raw = readJson(file, null);
  const at = String((raw && raw.at) || '');
  const ms = Date.parse(at);
  const ageMs = Number.isFinite(ms) ? Date.now() - ms : null;
  return {
    file, exists: true, raw,
    pid: raw && raw.pid, at, ageMs,
    staleMs: docLockStaleMs(),
    stale: Number.isFinite(ageMs) ? ageMs >= docLockStaleMs() : true,
  };
}

function releaseLock(projectPath) {
  try { fs.rmSync(docLockPath(projectPath), { force: true }); } catch { /* ignore */ }
}

/**
 * 唯一写入口。返回值：
 *  {ok:true, code:'OK', path, sha256, bytes, prevSha, baseline:bool}
 *  失败：fail() 抛 TeamError（带 code/reason/details + exitCode 1/2）
 *
 * opts: { projectName, projectPath, requirementId, expectedSha, content, role, actor, reason, transactionId }
 */
export function writeRequirementDoc(opts = {}) {
  const projectName = String(opts.projectName || '').trim();
  const requirementId = String(opts.requirementId || '').trim();
  if (!projectName) fail('PROJECT_REQUIRED', '缺少项目名', {}, 1);
  if (!requirementId) fail('REQUIREMENT_REQUIRED', '需要 --requirement', {}, 1);
  const project = opts.projectPath ? { path: String(opts.projectPath) } : loadProject(projectName);
  const lock = docLockPath(project.path);
  // 文档路径：需求/R-<id>-*.md（完整 id 优先，唯一匹配）
  const reqDir = path.join(project.path, '需求');
  let names = [];
  try { names = fs.readdirSync(reqDir).filter((n) => /^R-.*\.md$/i.test(n)); } catch { names = []; }
  const idLow = requirementId.toLowerCase();
  const exact = names.filter((n) => n.toLowerCase().startsWith(idLow + '-') || n.toLowerCase() === idLow + '.md');
  let docName = exact.length === 1 ? exact[0] : '';
  if (!docName && exact.length > 1) fail('REQUIREMENT_DOC_AMBIGUOUS', `需求 ${requirementId} 命中多份正文：${exact.join('、')}`, { candidates: exact }, 1);
  if (!docName) {
    const prefix = names.filter((n) => n.toLowerCase().startsWith(idLow));
    if (prefix.length === 1) docName = prefix[0];
  }
  if (!docName) fail('DOC_MISSING', `找不到需求正文：需求/R-${requirementId}-*.md`, { requirementId }, 1);
  const abs = path.join(reqDir, docName);
  const rel = '需求/' + docName;
  if (!exists(abs)) fail('DOC_MISSING', `需求正文不存在：${rel}`, { requirementId, path: rel }, 1);

  const role = String(opts.role || '').trim().toLowerCase();
  const actor = String(opts.actor || role || '').trim().toLowerCase();
  const isSystem = actor === 'system';
  const read = readDocRegistry(projectName);
  if (read.broken) fail('REGISTRY_BROKEN', `文档登记损坏（坏行 ${read.errors.length} 行），拒绝一切写入；先修复登记文件`, { file: read.file, errors: read.errors.slice(0, 5) }, 2);

  // 1) 冻结（最优先）：freeze 行，或 legacy 只读且无 freeze 行 → 拒写，不自动清属性
  const freezeRow = latestDocRegistryRow(read.rows, rel, ['freeze', 'unfreeze']);
  if (freezeRow && String(freezeRow.action) === 'freeze') {
    fail('DOC_FROZEN_DENIED', `文档已冻结（${rel}，${freezeRow.at}）：${freezeRow.reason || '未写原因'}；解冻需 PM 带 reason`, {
      requirementId, path: rel, reason: 'frozen', frozenAt: freezeRow.at, frozenBy: freezeRow.actor,
    }, 1);
  }
  if (!freezeRow) {
    let readonly = false;
    try {
      const mode = fs.statSync(abs).mode;
      readonly = (mode & 0o200) === 0;
    } catch { readonly = false; }
    if (readonly) {
      fail('DOC_FROZEN_DENIED', `文档是只读 (legacy 冻结，无 freeze 登记)：${rel}；本工具不会自动清只读，PM 请先登记 freeze 再 unfreeze`, {
        requirementId, path: rel, reason: 'legacy_readonly',
      }, 1);
    }
  }

  // 2) 写者：默认 analyst；actor=system 豁免 writer，但不豁免冻结/并发
  if (!isSystem) {
    const writerRow = latestDocRegistryRow(read.rows, '__writer__', ['writer', 'reassign'])
      || (() => {
        const rows = Array.isArray(read.rows) ? read.rows.filter((r) => String(r.action) === 'writer' || String(r.action) === 'reassign') : [];
        return rows.length ? rows[rows.length - 1] : null;
      })();
    const writer = String((writerRow && writerRow.writer) || DOC_WRITER_DEFAULT);
    if (role !== writer) {
      fail('NON_WRITER_DENIED', `写者不是 ${role}：当前写者=${writer}（需 PM 用 req writer --reassign 改派并留审计）`, {
        role, writer, requirementId, path: rel,
      }, 1);
    }
  }

  // 3) 三值校验：expectedSha === registrySha === diskSha
  const diskSha = hashFile(abs);
  const regRow = latestDocRegistryRow(read.rows, rel, ['baseline', 'write', 'rollback']);
  const registrySha = regRow && regRow.sha256 ? String(regRow.sha256) : null;
  if (!opts.expectedSha) {
    fail('EXPECTED_SHA_REQUIRED', '必须带 --expected-sha（强制乐观锁：写前先读，把读到的 sha 带回来）', { requirementId, path: rel, diskSha }, 1);
  }
  if (!shaMatches(opts.expectedSha, diskSha)) {
    fail('DOC_CONCURRENT_MODIFIED', `正文在你读取之后已被改过（磁盘 ${String(diskSha).slice(0, 12)} ≠ 你的 ${String(opts.expectedSha).slice(0, 12)}），未写入`, {
      requirementId, path: rel, reason: 'hash_mismatch', diskSha, expectedSha: String(opts.expectedSha), registrySha,
    }, 1);
  }
  const baseline = !registrySha;
  if (registrySha && !shaMatches(opts.expectedSha, registrySha)) {
    fail('DOC_CONCURRENT_MODIFIED', `登记与磁盘不一致（登记 ${String(registrySha).slice(0, 12)} ≠ 磁盘 ${String(diskSha).slice(0, 12)}），说明有入口外写入，未写入`, {
      requirementId, path: rel, reason: 'hash_mismatch', diskSha, registrySha, expectedSha: String(opts.expectedSha),
    }, 1);
  }

  // 4) O_EXCL 锁：拿不到 → lock_held / lock_stale（不自动删）
  const pre = lockInfo(project.path);
  if (pre.exists) {
    if (pre.stale) {
      fail('LOCK_STALE', `写锁已超时 ${Math.round((pre.ageMs || 0) / 1000)}s（阈值 ${Math.round(pre.staleMs / 1000)}s，pid=${pre.pid}），未写入；请 PM 用 req unlock-write 清理`, {
        requirementId, path: rel, reason: 'lock_stale', lock: { pid: pre.pid, at: pre.at, ageMs: pre.ageMs },
      }, 1);
    }
    fail('DOC_CONCURRENT_MODIFIED', `写锁被占用（pid=${pre.pid}，已 ${Math.round((pre.ageMs || 0) / 1000)}s），未写入`, {
      requirementId, path: rel, reason: 'lock_held', lock: { pid: pre.pid, at: pre.at, ageMs: pre.ageMs },
    }, 1);
  }
  let lockFd = null;
  try {
    ensureDir(path.dirname(lock));
    lockFd = fs.openSync(lock, 'wx');
    fs.writeSync(lockFd, JSON.stringify({ pid: process.pid, at: nowIso(), host: process.env.COMPUTERNAME || 'local', requirementId }));
    fs.closeSync(lockFd);
    lockFd = null;
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      const again = lockInfo(project.path);
      if (again.stale) {
        fail('LOCK_STALE', `写锁已超时（pid=${again.pid}），未写入；请 PM 用 req unlock-write 清理`, {
          requirementId, path: rel, reason: 'lock_stale', lock: { pid: again.pid, at: again.at, ageMs: again.ageMs },
        }, 1);
      }
      fail('DOC_CONCURRENT_MODIFIED', `写锁被占用（pid=${again.pid}），未写入`, {
        requirementId, path: rel, reason: 'lock_held', lock: { pid: again.pid, at: again.at, ageMs: again.ageMs },
      }, 1);
    }
    releaseLock(project.path);
    fail('LOCK_WRITE_FAILED', `无法创建写锁：${(e && e.message) || e}`, { lock, requirementId }, 2);
  }

  try {
    // 5) 锁内二次复核 diskSha
    const diskSha2 = hashFile(abs);
    if (!shaMatches(opts.expectedSha, diskSha2)) {
      fail('DOC_CONCURRENT_MODIFIED', `拿锁后复核发现正文已被改（${String(diskSha2).slice(0, 12)}），未写入`, {
        requirementId, path: rel, reason: 'hash_mismatch', diskSha: diskSha2, expectedSha: String(opts.expectedSha),
      }, 1);
    }
    const content = String(opts.content === undefined || opts.content === null ? '' : opts.content);
    if (!content.trim()) {
      fail('DOC_EMPTY', '新正文为空，拒绝写入（不建空文件）', { requirementId, path: rel }, 1);
    }
    const at = nowIso();
    const nextSha = sha256(content);
    // baseline 行（无登记文档首写）：记当前磁盘 sha + 当时 rr/trqHash
    if (baseline) {
      const rrs = collectRequirementRrs(projectName, requirementId);
      const currentRr = rrs.length ? rrs[rrs.length - 1] : null;
      const trq = requirementRowOf(projectName, requirementId);
      appendDocRegistry(projectName, {
        at, requirementId, path: rel, action: 'baseline', sha256: diskSha2, bytes: fs.statSync(abs).size,
        writer: isSystem ? DOC_WRITER_DEFAULT : role, actor: actor || role, prevSha: null, reason: '首写补建基线',
        transactionId: opts.transactionId || null,
        rrHash: currentRr ? String(currentRr.requirementHash || '') || null : null,
        trqHash: (trq && trq.trq && (trq.trq.checkHash || trq.trq.requirementHash)) || null,
      });
    }
    // 原子写：tmp + rename（+ .bak）
    const tmp = `${abs}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    fs.writeFileSync(tmp, content, 'utf8');
    try { fs.copyFileSync(abs, `${abs}.bak-${Date.now()}`); } catch { /* 备份失败不阻断 */ }
    fs.renameSync(tmp, abs);
    appendDocRegistry(projectName, {
      at, requirementId, path: rel, action: 'write', sha256: nextSha, bytes: Buffer.byteLength(content, 'utf8'),
      writer: isSystem ? DOC_WRITER_DEFAULT : role, actor: actor || role,
      prevSha: diskSha2, reason: String(opts.reason || ''), transactionId: opts.transactionId || null,
    });
    return { ok: true, code: 'OK', requirementId, path: rel, sha256: nextSha, prevSha: diskSha2, bytes: Buffer.byteLength(content, 'utf8'), at, baseline, writer: isSystem ? 'system' : role };
  } finally {
    releaseLock(project.path);
  }
}

/** PM 清锁：by=pm + reason 非空；锁不存在 → LOCK_NOT_FOUND（幂等，零副作用）。 */
export function unlockDocWrite(opts = {}) {
  const projectName = String(opts.projectName || '').trim();
  const requirementId = String(opts.requirementId || '').trim();
  const by = String(opts.by || '').trim().toLowerCase();
  const reason = String(opts.reason || '').trim();
  if (!projectName) fail('PROJECT_REQUIRED', '缺少项目名', {}, 1);
  if (by !== 'pm') fail('PERMISSION_DENIED', '只有 PM 能清写锁（req unlock-write）', { by }, 1);
  if (!reason) fail('REASON_REQUIRED', '清锁必须带 --reason（为什么清），空原因零副作用拒收', { requirementId }, 1);
  const project = opts.projectPath ? { path: String(opts.projectPath) } : loadProject(projectName);
  const info = lockInfo(project.path);
  if (!info.exists) fail('LOCK_NOT_FOUND', '没有写锁（可能已被释放/清理），未做任何事', { requirementId }, 1);
  try { fs.rmSync(docLockPath(project.path), { force: true }); } catch (e) {
    fail('LOCK_RELEASE_FAILED', `清锁失败：${(e && e.message) || e}`, { requirementId }, 2);
  }
  const at = nowIso();
  const { file } = appendDocRegistry(projectName, {
    at, requirementId, path: info.raw && info.raw.requirementId ? `需求/${info.raw.requirementId}` : '', action: 'unlock_lock',
    sha256: null, bytes: null, writer: '', actor: by, prevSha: null, reason,
    transactionId: null,
  });
  return { ok: true, code: 'OK', requirementId, at, file, lock: { pid: info.pid, at: info.at, ageMs: info.ageMs }, reason, by };
}

/** 登记链自检：逐条比对 prevSha 是否等于上一条 sha256（同 path 内）。 */
export function verifyDocRegistryChain(rows) {
  const last = new Map();
  const breaks = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const rel = normalizeRel(row.path);
    if (!rel) continue;
    const action = String(row.action || '');
    if (['baseline', 'write', 'rollback'].includes(action)) {
      const prev = last.get(rel) || null;
      if (row.prevSha && prev && String(row.prevSha) !== String(prev)) {
        breaks.push({ path: rel, at: row.at, action, prevSha: String(row.prevSha).slice(0, 12), expectedPrev: String(prev).slice(0, 12) });
      }
      if (row.sha256) last.set(rel, String(row.sha256));
    }
    if (action === 'unlock_write' && row.sha256) last.set(rel, String(row.sha256));
  }
  return { ok: breaks.length === 0, breaks };
}

// ---------- 审计（req audit） ----------

function requirementDocsOf(projectPath) {
  const dir = path.join(projectPath, '需求');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^R-.*\.md$/i.test(n)); } catch { names = []; }
  return names.sort().map((name) => {
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    const idMatch = /^(R-\d{8}-\d{4,6}(?:-[0-9a-z]{2,8})?)/i.exec(name);
    return {
      name, abs, rel: '需求/' + name,
      requirementId: idMatch ? idMatch[1] : name.replace(/\.md$/i, ''),
      shortKey: (idMatch ? idMatch[1] : '').slice(-4).toLowerCase(),
      bytes: st.size, mtime: st.mtime.toISOString(), diskSha: hashFile(abs),
    };
  });
}

function supplementsOf(projectPath, shortKey) {
  if (!shortKey) return [];
  const dir = path.join(projectPath, '需求');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { names = []; }
  const out = [];
  for (const name of names) {
    const m = /^增补卷-([0-9a-z]{4})-(\d+)\.md$/i.exec(name);
    if (!m || m[1].toLowerCase() !== shortKey) continue;
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    out.push({ name, abs, rel: '需求/' + name, bytes: st.size, diskSha: hashFile(abs), number: Number(m[2]) });
  }
  return out.sort((a, b) => a.number - b.number);
}

/**
 * 审计：只读，不改任何文件。
 * 返回 {ok, project, generatedAt, requirements[], summary, codes, exitCode}
 */
export function auditRequirementDocs(opts = {}) {
  const projectName = String(opts.projectName || '').trim();
  if (!projectName) fail('PROJECT_REQUIRED', '缺少项目名', {}, 2);
  const project = opts.projectPath ? { path: String(opts.projectPath) } : loadProject(projectName);
  const only = String(opts.requirementId || '').trim();
  const reg = readDocRegistry(projectName);
  const generatedAt = nowIso();
  // 登记损坏：一律 registry_broken，退出码 2
  if (reg.broken) {
    const docs = requirementDocsOf(project.path).filter((d) => !only || d.requirementId === only || d.name.includes(only));
    return {
      ok: false, project: projectName, generatedAt, registryFile: reg.file,
      requirements: docs.map((doc) => ({
        requirementId: doc.requirementId, path: doc.rel, state: 'registry_broken',
        diskSha: doc.diskSha, bytes: doc.bytes, mtime: doc.mtime, registry: null,
        bindings: { currentRrId: null, rrIds: [], matched: 'none', rrHash: null, trqHash: null },
        codes: ['REGISTRY_BROKEN'], supplements: [],
      })),
      summary: { total: docs.length, ok: 0, untracked: 0, mismatch: 0, stale: 0, missing: 0, registry_broken: docs.length },
      codes: ['REGISTRY_BROKEN'], errors: reg.errors.slice(0, 10), exitCode: 2,
    };
  }
  const rows = reg.rows;
  const docs = requirementDocsOf(project.path).filter((d) => !only || d.requirementId === only || d.name.includes(only));
  const requirements = [];
  // 登记里有、磁盘没有的文件 → missing
  const diskRels = new Set(requirementDocsOf(project.path).map((d) => d.rel));
  const missingRows = [];
  const seenMissing = new Set();
  for (const row of rows) {
    const rel = normalizeRel(row.path);
    if (!/^需求\/R-.*\.md$/i.test(rel)) continue;
    if (diskRels.has(rel) || seenMissing.has(rel)) continue;
    if (only && !rel.includes(only)) continue;
    seenMissing.add(rel);
    missingRows.push(row);
  }
  for (const doc of docs) {
    const codes = [];
    const regRow = latestDocRegistryRow(rows, doc.rel, ['baseline', 'write', 'rollback']);
    const registrySha = regRow && regRow.sha256 ? String(regRow.sha256) : null;
    let state = 'ok';
    if (!registrySha) { state = 'untracked'; codes.push('DOC_UNTRACKED_WRITE'); }
    else if (String(registrySha) !== String(doc.diskSha)) { state = 'untracked'; codes.push('DOC_UNTRACKED_WRITE'); }
    // RR 集合成员资格
    const rrs = collectRequirementRrs(projectName, doc.requirementId);
    const currentRr = rrs.length ? rrs[rrs.length - 1] : null;
    const currentHash = currentRr ? String(currentRr.requirementHash || '') : '';
    const oldHashes = rrs.slice(0, -1).map((r) => String(r.requirementHash || '')).filter(Boolean);
    let matched = 'none';
    if (!rrs.length) matched = 'none';
    else if (currentHash && currentHash === doc.diskSha) matched = 'current';
    else if (oldHashes.includes(doc.diskSha)) matched = 'stale';
    else matched = 'none';
    if (matched === 'stale') codes.push('DOC_BINDING_STALE'); // warning：state 保持 ok
    else if (matched === 'none' && rrs.length) {
      codes.push('DOC_BINDING_MISMATCH');
      if (state === 'ok') state = 'mismatch';
    }
    const row = requirementRowOf(projectName, doc.requirementId);
    const trqHash = (row && row.trq && (row.trq.checkHash || row.trq.requirementHash)) || null;
    // b75c 自检：登记 sha 与磁盘 sha 不等时，必须区分「仅元数据差异」与「实质改文」——
    // 程序自己维护 `## 状态记录` / `- 状态：` 只改 sha256、不改 contentHash，这种漂移不影响决定有效性。
    const diskContentHash = (() => {
      try { return sha256(requirementContentText(fs.readFileSync(path.join(project.path, doc.rel), 'utf8'))); } catch { return ''; }
    })();
    const boundContentHash = String((row && row.requirementReview && row.requirementReview.contentHash) || (row && row.contentHash) || '');
    let contentDrift = null;
    if (String(registrySha || '') !== String(doc.diskSha || '')) {
      const metaOnly = Boolean(diskContentHash && boundContentHash && diskContentHash === boundContentHash);
      contentDrift = {
        metaOnly,
        note: metaOnly ? '仅元数据差异，不影响决定有效性' : '实质内容与绑定版本不一致，需要重评或用 req doc repair 恢复',
        boundContentHash: boundContentHash ? boundContentHash.slice(0, 12) : null,
        diskContentHash: diskContentHash ? diskContentHash.slice(0, 12) : null,
      };
      codes.push('DOC_CONTENT_DRIFT');
    }
    // 卷：只比登记，不比 RR
    const supplements = supplementsOf(project.path, doc.shortKey).map((sup) => {
      const supReg = latestDocRegistryRow(rows, sup.rel, ['baseline', 'write', 'rollback']);
      const supRegistrySha = supReg && supReg.sha256 ? String(supReg.sha256) : null;
      const supCodes = [];
      let supState = 'ok';
      if (!supRegistrySha) { supState = 'untracked'; supCodes.push('DOC_UNTRACKED_WRITE'); }
      else if (String(supRegistrySha) !== String(sup.diskSha)) { supState = 'untracked'; supCodes.push('DOC_UNTRACKED_WRITE'); }
      return { path: sup.rel, diskSha: sup.diskSha, bytes: sup.bytes, registrySha: supRegistrySha, state: supState, codes: supCodes };
    });
    for (const sup of supplements) {
      if (sup.state !== 'ok' && state === 'ok') state = 'untracked';
      for (const code of sup.codes) if (!codes.includes(code)) codes.push(code);
    }
    requirements.push({
      requirementId: doc.requirementId,
      path: doc.rel,
      state,
      diskSha: doc.diskSha,
      bytes: doc.bytes,
      mtime: doc.mtime,
      registry: regRow ? { sha256: registrySha, at: regRow.at, action: regRow.action, writer: regRow.writer || '', prevSha: regRow.prevSha || null } : null,
      bindings: {
        currentRrId: currentRr ? String(currentRr.id) : null,
        rrIds: rrs.map((r) => String(r.id)),
        matched, rrHash: currentHash || null, trqHash: trqHash || null,
      },
      codes,
      diskContentHash: diskContentHash || null,
      contentDrift,
      supplements,
    });
  }
  for (const row of missingRows) {
    const rel = normalizeRel(row.path);
    const regRow = latestDocRegistryRow(rows, rel, ['baseline', 'write', 'rollback']);
    requirements.push({
      requirementId: String(row.requirementId || ''), path: rel, state: 'missing',
      diskSha: null, bytes: null, mtime: null,
      registry: regRow ? { sha256: regRow.sha256 || null, at: regRow.at, action: regRow.action, writer: regRow.writer || '', prevSha: regRow.prevSha || null } : null,
      bindings: { currentRrId: null, rrIds: [], matched: 'none', rrHash: null, trqHash: null },
      codes: ['DOC_MISSING'], supplements: [],
    });
  }
  const severity = { missing: 5, registry_broken: 4, untracked: 3, mismatch: 2, ok: 1 };
  const summary = { total: requirements.length, ok: 0, untracked: 0, mismatch: 0, stale: 0, missing: 0, registry_broken: 0 };
  const topCodes = new Set();
  for (const row of requirements) {
    summary[row.state] = (summary[row.state] || 0) + 1;
    for (const code of row.codes || []) topCodes.add(code);
  }
  // b75c：仅元数据漂移（DOC_CONTENT_DRIFT 且 metaOnly）是提示，不算问题、不让 selftest 误红。
  const hasProblem = requirements.some((row) => row.state !== 'ok'
    || (row.codes || []).some((c) => c !== 'DOC_BINDING_STALE' && !(c === 'DOC_CONTENT_DRIFT' && row.contentDrift && row.contentDrift.metaOnly)));
  const exitCode = hasProblem ? 1 : 0;
  return {
    ok: exitCode === 0, project: projectName, generatedAt, registryFile: reg.file,
    requirements: requirements.sort((a, b) => String(a.requirementId).localeCompare(String(b.requirementId))),
    summary, codes: [...topCodes].sort(), exitCode,
    chain: verifyDocRegistryChain(rows),
    severityOrder: Object.keys(severity),
  };
}
