// R-9a8e（T-20261115-012022-df1d）：需求正文「版本 + 变更点」解析与三元组绑定。
//
// 口径：
//   ① 正文显式版本：文件头任意位置出现 `version: vN` / `<!-- req-doc: vN -->` /
//      `（req review，vN）` / `版本：vN` 任一即可；`change:` 取同段一句（≤60 字）。
//   ② 旧正文没有 version → 视为 legacy：门禁仍按 hash 判；首次通过时**只写记录**
//      `version='v1'' + legacy=true`，绝不改正文（AC6 断言正文 sha256 不变）。
//   ③ 绑定三元组：记录里写 {version, requirementHash}，与 requirementId 构成 (id, version, hash)。
//   ④ 门禁两码分开：version 变了 → REQ_REVIEW_REQUIRED(reason=version_changed)，
//      错误信息「需重评：v旧→v新，变更点：…」；version 未变但 hash 变 → VERSION_NOT_BUMPED。
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './core.mjs';
import { readRequirementDocs } from './scaffold.mjs';

const VERSION_PATTERNS = [
  // 注意：`<!-- req-doc: v2 -->` 是「正文格式版本」（严格四件套闸门用），不是内容版本，不参与解析。
  /^\s*(?:>\s*)?version\s*[:：]\s*(v\d+)/im,
  /（\s*req\s*review\s*[，,]\s*(v\d+)\s*）/i,
  /版本\s*[:：]\s*(v\d+)/i,
];

/** 从正文里抠版本号与变更点：{version, change, source}（找不到 version 返回 version='')。 */
export function parseRequirementVersion(text) {
  const raw = String(text || '');
  const head = raw.split(/\r?\n/).slice(0, 40).join('\n');
  for (const pattern of VERSION_PATTERNS) {
    const hit = head.match(pattern);
    if (hit && hit[1]) {
      return { version: String(hit[1]).toLowerCase(), change: parseChange(head), source: 'doc' };
    }
  }
  return { version: '', change: parseChange(head), source: 'none' };
}

function parseChange(text) {
  const line = String(text || '').split(/\r?\n/).find((row) => /^\s*(?:>\s*)?change\s*[:：]/.test(row));
  if (!line) return '';
  return line.replace(/^\s*(?:>\s*)?change\s*[:：]\s*/i, '').trim().slice(0, 60);
}

/** 版本号数值（v3 → 3），无法解析返回 0。 */
export function versionNumber(value) {
  const hit = String(value || '').match(/(\d+)/);
  return hit ? Number(hit[1]) : 0;
}

/** 找需求正文文件（复用 scaffold 的扫描口径），返回 {file, rel, text, hash, version, change}。 */
export function readRequirementDocVersion(projectPath, requirementId) {
  const out = { file: '', rel: '', text: '', hash: '', version: '', change: '' };
  const id = String(requirementId || '').trim();
  if (!projectPath || !id) return out;
  let list = [];
  try { list = readRequirementDocs(projectPath).list || []; } catch { list = []; }
  const doc = list.find((item) => String(item.id || '') === id || String(item.id || '').startsWith(id) || id.startsWith(String(item.id || '')));
  if (!doc) return out;
  const file = path.isAbsolute(String(doc.path || '')) ? String(doc.path) : path.join(projectPath, String(doc.rel || ''));
  out.file = file;
  out.rel = String(doc.rel || '');
  try { out.text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  out.hash = sha256(out.text);
  const parsed = parseRequirementVersion(out.text);
  out.version = parsed.version;
  out.change = parsed.change;
  return out;
}

/**
 * 门禁版本判定（纯函数）：
 *   入参 records = 评审/TR-Q/决定记录数组（按时间正序，取最后一条有效）；
 *   返回 null（一致或无可比）或 {code, reason, ...}。
 */
export function versionGate({ records = [], current = {}, gate = 'G2' } = {}) {
  const list = (Array.isArray(records) ? records : []).filter((row) => row && typeof row === 'object');
  const latest = list[list.length - 1] || null;
  const currentHash = String(current.hash || '');
  const currentVersion = String(current.version || '');
  if (!latest) return null;
  const recVersion = String(latest.version || '');
  const recHash = String(latest.requirementHash || '');
  if (recVersion && currentVersion && recVersion !== currentVersion) {
    return {
      code: 'REQ_REVIEW_REQUIRED', gate, reason: 'version_changed',
      missing: [`需重评：${recVersion}→${currentVersion}`],
      recordedVersion: recVersion, currentVersion,
      change: String(current.change || ''), recordedHash: recHash, currentHash,
      message: `需重评：${recVersion}→${currentVersion}，变更点：${String(current.change || '（正文未写 change）')}`,
    };
  }
  if (recVersion && recHash && currentHash && recHash !== currentHash) {
    // version 未变但 hash 变了（作者改正文忘涨版）→ 专门错误码，不混成 HASH_MISMATCH。
    return {
      code: 'VERSION_NOT_BUMPED', gate, reason: 'hash_changed_version_same',
      missing: ['version 未递增但正文已改（请先补 version 与 change 再重评）'],
      recordedVersion: recVersion || 'v1', currentVersion: currentVersion || 'v1',
      recordedHash: recHash, currentHash,
      next: '在正文头补 version: vN+1 与 change: <一句>，再跑 req review',
      message: `正文已改但 version 没涨（${recVersion || 'v1'}）：请先补 version 与 change 后再重评（VERSION_NOT_BUMPED）`,
    };
  }
  return null;
}

/** 记录里该写什么 version：正文有就用；没有则 legacy 首记 v1（只写记录，不改正文）。 */
export function versionForRecord(current = {}) {
  const docVersion = String(current.version || '');
  if (docVersion) return { version: docVersion, legacy: false, change: String(current.change || '') };
  return { version: 'v1', legacy: true, change: String(current.change || '') };
}
