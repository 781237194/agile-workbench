// B-155a / B-a17d：需求「作废登记」的唯一定义处（落点、解析、追加、迁移口径）。
//
// 口径（任务 B-20261115-045103-a17d AC5）：
//   ① 落点固定 = <项目根>/需求/作废登记.jsonl（loadProject(name).path + 需求），
//      绝不落仓库根。旧实现用 projectStatePaths().dir 向上 4 级，会跳出到
//      <仓库根>/需求/ 下，跨项目共用且未 gitignore，污染 git status。
//   ② 每行必须带 project 字段（项目名）：同一个工作台挂多个项目时不得互相串味。
//   ③ 行形态固定：{at, project, requirementId, reason, by, hadWorkflowRow, source}
//   ④ 只追加（append-only）；重复作废由调用方判 ALREADY_VOIDED，不在这里判。
//   ⑤ 作废是「快照层」的输入，不只是登记：src/team-tools.js 的 readWorkflowSnapshot
//      必须读它并把同 id 从需求列表剔除/标 terminated（见 AC1）。
//
// 注意：这个模块只做纯文件读写，不含业务流程（工作流行置 terminated、任务文件收口
// 都在 ops.mjs 里做），以免两处口径分叉。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, appendLine, readJsonlTolerant } from './core.mjs';

export const REGISTRY_DIR = '需求';
export const REGISTRY_FILE = '作废登记.jsonl';

/** 项目根的作废登记文件（唯一合法落点）。 */
export function voidRegistryFile(projectDir) {
  const dir = String(projectDir || '').trim();
  if (!dir) return '';
  return path.join(path.resolve(dir), REGISTRY_DIR, REGISTRY_FILE);
}

/** 历史遗留落点：<仓库根>/需求/作废登记.jsonl（只给迁移脚本用，不参与读取）。 */
export function legacyVoidRegistryFile(teamRoot) {
  const root = String(teamRoot || '').trim();
  if (!root) return '';
  return path.join(path.resolve(root), '..', REGISTRY_DIR, REGISTRY_FILE);
}

function normalizeEntry(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.requirementId || raw.id || raw.requirement || '').trim();
  if (!id) return null;
  return {
    id,
    requirementId: id,
    at: String(raw.at || ''),
    project: String(raw.project || ''),
    reason: String(raw.reason || ''),
    by: String(raw.by || ''),
    hadWorkflowRow: raw.hadWorkflowRow === true,
    source: String(raw.source || 'req_void'),
    line: Number(index || 0),
  };
}

/**
 * 读作废登记。文件不存在 → 空（exists=false），不抛错；坏行只记 errors 不阻断。
 * 返回 {file, exists, count, entries, ids, byId, errors}
 */
export function readVoidRegistry(projectDir) {
  const file = voidRegistryFile(projectDir);
  const out = { file, exists: false, count: 0, entries: [], ids: [], byId: {}, errors: [] };
  if (!file) return out;
  out.exists = fs.existsSync(file);
  if (!out.exists) return out;
  const parsed = readJsonlTolerant(file);
  out.errors = parsed.errors || [];
  let index = 0;
  for (const raw of parsed.items || []) {
    index += 1;
    const entry = normalizeEntry(raw, index);
    if (!entry) { out.errors.push({ line: JSON.stringify(raw).slice(0, 120), error: 'requirementId 缺失' }); continue; }
    // 同一 id 多次作废：保留最后一笔（幂等重试用），ids 去重。
    out.byId[entry.id] = entry;
    out.entries.push(entry);
  }
  out.ids = Object.keys(out.byId);
  out.count = out.entries.length;
  return out;
}

/** 追加一条作废登记（等价于 PM 执行一次 req void 的落盘动作）。 */
export function appendVoidEntry(projectDir, entry) {
  const file = voidRegistryFile(projectDir);
  if (!file) throw new Error('appendVoidEntry 需要项目目录');
  const id = String((entry && (entry.requirementId || entry.id)) || '').trim();
  if (!id) throw new Error('appendVoidEntry 需要 requirementId');
  const row = {
    at: String(entry.at || new Date().toISOString()),
    project: String(entry.project || ''),
    requirementId: id,
    reason: String(entry.reason || ''),
    by: String(entry.by || ''),
    hadWorkflowRow: entry.hadWorkflowRow === true,
    source: String(entry.source || 'req_void'),
  };
  ensureDir(path.dirname(file));
  appendLine(file, JSON.stringify(row));
  return { file, entry: row };
}

/**
 * 把历史遗留的仓库根登记迁移到项目目录（一次性，幂等）。
 * - 只迁移 ids 命中的行（调用方给 ids；缺省迁移全部）；
 * - 已存在于项目登记的 id 跳过（幂等）；
 * - project 字段缺失时按参数补；
 * - dryRun 只算不写。
 */
export function migrateLegacyRegistry({ projectDir, teamRoot = '', ids = null, project = '', dryRun = false } = {}) {
  const target = voidRegistryFile(projectDir);
  const legacy = legacyVoidRegistryFile(teamRoot);
  const report = { legacyFile: legacy, targetFile: target, legacyExists: false, moved: [], skipped: [], remaining: 0, dryRun: Boolean(dryRun) };
  if (!legacy || !fs.existsSync(legacy)) return report;
  report.legacyExists = true;
  const allow = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
  const legacyRows = (readJsonlTolerant(legacy).items || []).map((raw, i) => normalizeEntry(raw, i)).filter(Boolean);
  const current = readVoidRegistry(projectDir);
  const movedLines = new Set();
  for (const row of legacyRows) {
    if (allow && !allow.has(row.id)) continue;
    if (current.byId[row.id]) { report.skipped.push(row.id); movedLines.add(row.line); continue; }
    const entry = { ...row, project: row.project || project, source: row.source || 'migrate_155a' };
    if (!dryRun) appendVoidEntry(projectDir, entry);
    report.moved.push(entry);
    movedLines.add(row.line);
  }
  report.remaining = legacyRows.filter((row) => !movedLines.has(row.line)).length;
  if (!dryRun && report.remaining === 0) {
    // 全部迁走才删旧文件，避免丢数据；删前留 .bak 在本目录（_tmp/备份区由调用方管）。
    try { fs.unlinkSync(legacy); } catch { /* 删不掉就留着，下次兜底 */ }
  }
  return report;
}
