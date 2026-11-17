'use strict';
/**
 * B-20261117-113926-8be3：壳层状态写入（writeStore → workbench.json）补审计行（AD44 AC6/G11 延伸面）。
 *
 * 为什么另起一份：`团队/工具/lib/json-atomic.cjs` 的 appendAudit 只在路径命中
 * `状态/项目/<项目>/`（或显式给 projectDir/auditFile）时才落 写入审计.jsonl；
 * workbench.json 在 `data/userdata/` 下 → 原来一条审计都没有。
 *
 * 口径（与本单要求逐条对齐）：
 *   ① 字段固定 8 键：{ at, kind, file, bytes, prevSha, sha, case, actor }，actor=shell；
 *   ② **失败/无变化不写行**（prevSha===sha 且 bytes 相同即视为无变化）；
 *   ③ append-only、appendFileSync，写完才返回；写审计失败不抛（不阻断主写入）；
 *   ④ 读侧兼容旧行：缺字段/空 case 的行不报错（readStoreAudit 只做字段归一）。
 */

const fs = require('node:fs');
const path = require('node:path');

const AUDIT_FILE_NAME = '写入审计.jsonl';
const ACTOR = 'shell';

function auditFileForStore(storeFile) {
  return path.join(path.dirname(String(storeFile || '')), AUDIT_FILE_NAME);
}

/** 组装一行审计（固定 8 键，顺序固定便于人看/对比）。 */
function buildStoreAuditLine(input = {}) {
  return {
    at: String(input.at || new Date().toISOString()),
    kind: String(input.kind || 'state-write'),
    file: String(input.file || ''),
    bytes: Number.isFinite(Number(input.bytes)) ? Number(input.bytes) : 0,
    prevSha: String(input.prevSha || ''),
    sha: String(input.sha || ''),
    case: String(input.caseName || input.case || ''),
    actor: String(input.actor || ACTOR),
  };
}

/**
 * 追加一行审计；无变化（sha 与 prevSha 相同且 bytes 未变）或缺少 sha 时不写。
 * @returns {{written:boolean, reason:string, line?:object}}
 */
function appendStoreWriteAudit(input = {}) {
  const line = buildStoreAuditLine(input);
  if (!line.sha) return { written: false, reason: 'no-sha' };
  const unchanged = Boolean(line.prevSha) && line.prevSha === line.sha;
  if (unchanged) return { written: false, reason: 'unchanged', line };
  const auditFile = String(input.auditFile || '') || auditFileForStore(input.file);
  try {
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.appendFileSync(auditFile, JSON.stringify(line) + '\n', 'utf8');
    return { written: true, reason: 'ok', line, auditFile };
  } catch (error) {
    // 审计写失败不阻断业务写入，但要把原因带回给调用方（可记 console）
    return { written: false, reason: 'append-failed', message: String((error && error.message) || error).slice(0, 200), line, auditFile };
  }
}

/** 读审计（兼容旧行：缺字段补空、case 空字符串照读）。 */
function readStoreAudit(auditFile) {
  let text = '';
  try { text = fs.readFileSync(String(auditFile || ''), 'utf8'); } catch { return []; }
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const body = raw.trim();
    if (!body) continue;
    try {
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object') continue;
      rows.push({
        at: String(parsed.at || ''),
        kind: String(parsed.kind || ''),
        file: String(parsed.file || ''),
        bytes: Number.isFinite(Number(parsed.bytes)) ? Number(parsed.bytes) : 0,
        prevSha: String(parsed.prevSha || ''),
        sha: String(parsed.sha || ''),
        case: String(parsed.case || ''),
        actor: String(parsed.actor || ''),
      });
    } catch { /* 坏行跳过，不报错 */ }
  }
  return rows;
}

module.exports = {
  AUDIT_FILE_NAME,
  ACTOR,
  auditFileForStore,
  buildStoreAuditLine,
  appendStoreWriteAudit,
  readStoreAudit,
};
