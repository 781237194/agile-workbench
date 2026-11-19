// R-20261119-170815-fefa：角色卡与红线摘要的周期性重读（不靠模型自觉）
//
// 契约（需求正文 v4 §6.1–§6.6 写死）：
//   · rolecardDigest(cardText)：唯一生成器，≤10 行 / ≤600B，只取卡内原文（0 改写），幂等；
//   · 计数文件 `团队/状态/项目/<P>/角色卡重读/<role>.json`
//     = { opsSinceInject, lastInjectAt, lastCardSha12, lastUsageTokens, injections[] }；
//   · 检查点：写操作开始取 n，若 (n+1)%20===0 && n+1>=20 → 本次注入并置 0（同一把锁）；
//   · compact.signal：读到 → 写审计 → 删除文件（消费式）16；
//   · usage 闩锁：仅当 totalTokens > warn 且 lastUsageTokens <= warn（或缺失）才触发一次；
//   · 写操作门：boot 记录的卡 sha ≠ 当前卡 sha → 默认软 ROLECARD_STALE_SOFT，
//     TEAM_ROLECARD_ENFORCE=1 时硬拒 ROLECARD_UNREAD（零写入）；
//   · 审计 append-only `项目/<P>/角色卡重读.jsonl` = {at,role,cardSha12,trigger,shownLines,opsSinceInject}。
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, fail, nowIso, ensureDir, sha256, withLock, readJson, jsonOut, textOut } from './core.mjs';
import { projectStatePaths, loadProject } from './store.mjs';
import { ROLE_DIRS } from './roles.mjs';

export const DIGEST_MAX_LINES = 10;
export const DIGEST_MAX_BYTES = 600;
export const INJECT_EVERY = 20;
/** §6.6：§H 六类关键词（任意出现即可，不要求同行/全含）。 */
export const H_KEYWORDS = ['入口', '正常', '空值', '失败', '并发', '降级'];
const TRUNC_MARK = '…（摘要 10 行上限）';
/** 优先级分桶（§6.1）：数字越小越先取。 */
const PRIORITY_RULES = [
  { rank: 1, re: /写入范围|路径纪律|只写|代码目录/ },
  { rank: 2, re: /优先级|P0|P1|P2|P3/ },
  { rank: 3, re: /禁止|不得|工装安全|绝不|一律不/ },
  { rank: 4, re: /入口|正常|空值|失败|并发|降级/ },
];

const stripMd = (line) => String(line || '')
  .replace(/^\s{0,3}#{1,6}\s*/, '')
  .replace(/^\s*[-*+]\s+/, '')
  .replace(/^\s*\d+[.)]\s+/, '')
  .trim();

/**
 * §6.1 唯一生成器：把角色卡压成 ≤10 行 / ≤600B 的红线摘要。
 * 只读卡内原文（逐行 trim 后原样取），不改写语义；超限从尾部丢并按契约标末行。
 * @param {string} cardText 角色卡全文
 * @returns {{text:string, lines:string[], lineCount:number, bytes:number, sha256:string, keywords:string[], degraded:boolean, empty:boolean, truncated:boolean, sourceLines:number}}
 */
export function rolecardDigest(cardText) {
  const raw = String(cardText || '');
  const all = raw.split(/\r?\n/);
  const sourceLines = all.filter((l) => l.trim()).length;
  if (!raw.trim()) {
    return { text: '', lines: [], lineCount: 0, bytes: 0, sha256: sha256(''), keywords: [], degraded: true, empty: true, truncated: false, sourceLines: 0 };
  }
  // 逐行建候选（保卡内顺序 + 记最高优先级 rank）
  const candidates = [];
  all.forEach((rawLine, idx) => {
    const text = stripMd(rawLine);
    if (!text) return;
    if (/^```/.test(text)) return;
    let rank = 99;
    for (const rule of PRIORITY_RULES) { if (rule.re.test(text)) { rank = Math.min(rank, rule.rank); } }
    candidates.push({ idx, text, rank, isHeading: /^\s{0,3}#{1,6}\s*/.test(rawLine) });
  });
  const keywords = H_KEYWORDS.filter((k) => raw.includes(k));
  // 头部声明行（- 项目 / 语言纪律 / 固定模型 之类）保底：只取首条非标题行，避免挤掉 §H 关键词行
  const header = candidates.filter((c) => !c.isHeading).slice(0, 1).map((c) => c.text);
  // 按 rank 稳排序挑行（同 rank 保持卡内顺序）；**超长行跳过**——单行 >160B 会把 600B 预算吃光，
  // 且单行截断会破坏「逐字取自原文」（AC1③），所以宁可跳过、让短行（含 §H 关键词句）进来。
  const ranked = candidates
    .filter((c) => c.rank <= 4 && c.text.length <= 160)
    .sort((a, b) => (a.rank - b.rank) || (a.idx - b.idx));
  const picked = [];
  const seen = new Set();
  const push = (t) => {
    const v = String(t || '').trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    picked.push(v);
  };
  header.forEach(push);
  // §H 关键词行优先占位（§6.6 / AC1④：摘要须出现 §H 六类关键词）
  const hLine = ranked.find((c) => H_KEYWORDS.some((k) => c.text.includes(k)));
  if (hLine) push(hLine.text);
  for (const c of ranked) { if (picked.length >= DIGEST_MAX_LINES) break; push(c.text); }
  // 兜底：命中不足时按卡内顺序补前若干行（保证非空摘要）
  if (!picked.length) {
    for (const c of candidates) { if (picked.length >= DIGEST_MAX_LINES) break; push(c.text); }
  }
  // ≤10 行 + ≤600B：先裁行数，再按字节裁
  let lines = picked.slice(0, DIGEST_MAX_LINES);
  let truncated = picked.length > lines.length;
  const byteLen = (arr) => Buffer.byteLength(arr.join('\n'), 'utf8');
  while (lines.length > 0 && byteLen(lines) > (DIGEST_MAX_BYTES - Buffer.byteLength(`\n${TRUNC_MARK}`, 'utf8'))) {
    lines = lines.slice(0, -1);
    truncated = true;
  }
  if (truncated) {
    // 末行替换为标记（不挤爆 600B）
    while (lines.length > 0 && byteLen([...lines, TRUNC_MARK]) > DIGEST_MAX_BYTES) lines = lines.slice(0, -1);
    lines = [...lines, TRUNC_MARK];
  }
  const text = lines.join('\n');
  return {
    text,
    lines,
    lineCount: lines.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: sha256(text),
    keywords,
    degraded: !/^\s{0,3}#{1,6}\s/m.test(raw),
    empty: lines.length === 0,
    truncated,
    sourceLines,
  };
}

/* ── 路径 ───────────────────────────────────────────────────────────── */

export function rolecardCounterDir(projectName) {
  return path.join(projectStatePaths(projectName).dir, '角色卡重读');
}
export function rolecardCounterFile(projectName, role) {
  return path.join(rolecardCounterDir(projectName), `${role}.json`);
}
/** compact.signal 的**绝对路径写死**（TR-Q③ / 需求 §6.2）：`团队/状态/角色卡重读/compact.signal`
 *  —— 团队级（压缩事件是会话级、不分项目），与按角色的计数文件 `项目/<P>/角色卡重读/<role>.json` 分开。 */
export function compactSignalFile() {
  return path.join(PATHS.state, '角色卡重读', 'compact.signal');
}
export function rolecardAuditFile(projectName) {
  return path.join(projectStatePaths(projectName).dir, '角色卡重读.jsonl');
}
export function rolecardPathOf(projectName, role) {
  const dir = ROLE_DIRS[role] || role;
  return path.join(loadProject(projectName).path, dir, '角色卡.md');
}

/* ── 读卡 / 摘要（带稳健降级） ─────────────────────────────────────── */

export function readRolecard(projectName, role) {
  const file = rolecardPathOf(projectName, role);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { text = ''; }
  return { file, text, exists: Boolean(text) };
}

/** 组合入口：读卡 + 摘要 + sha12（卡缺失不崩，返回 empty 摘要）。 */
export function rolecardDigestOf(projectName, role) {
  const card = readRolecard(projectName, role);
  const digest = rolecardDigest(card.text);
  return { ...digest, file: card.file, exists: card.exists, cardSha256: card.text ? sha256(card.text) : '', cardSha12: card.text ? sha256(card.text).slice(0, 12) : '' };
}

/* ── 计数（§6.2） ──────────────────────────────────────────────────── */

const COUNTER_LOCK_OPTS = { role: 'system', sessionId: 'system', ttlMs: 15000, waitMs: 8000, reason: 'rolecard counter' };

function readCounter(projectName, role) {
  const file = rolecardCounterFile(projectName, role);
  const data = readJson(file, null);
  const base = {
    opsSinceInject: 0, lastInjectAt: '', lastCardSha12: '', lastUsageTokens: null, injections: [],
  };
  if (!data || typeof data !== 'object') return { ...base, file, corrupt: Boolean(data) };
  return {
    ...base,
    ...data,
    opsSinceInject: Number.isFinite(Number(data.opsSinceInject)) ? Math.max(0, Number(data.opsSinceInject)) : 0,
    injections: Array.isArray(data.injections) ? data.injections.slice(-20) : [],
    file,
  };
}

function writeCounter(projectName, role, data) {
  const file = rolecardCounterFile(projectName, role);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return file;
}

export function appendRolecardAudit(projectName, row) {
  try {
    ensureDir(path.dirname(rolecardAuditFile(projectName)));
    fs.appendFileSync(rolecardAuditFile(projectName), `${JSON.stringify(row)}\n`, 'utf8');
    return true;
  } catch { return false; }
}

/** 消费式读取 compact.signal（读到即删，残留 deleted 标记到返回值）。 */
export function consumeCompactSignal() {
  const file = compactSignalFile();
  if (!fs.existsSync(file)) return null;
  let payload = null;
  try { payload = readJson(file, null); } catch { payload = null; }
  let deleted = false;
  try { fs.rmSync(file, { force: true }); deleted = true; } catch { deleted = false; }
  return { file, payload: payload || { at: nowIso(), source: 'unknown' }, deleted };
}

/**
 * §6.2 判定：写操作**开始**取 n，锁内决定本次是否注入并推进计数。
 * 返回 { n, next, inject, trigger, reasons[], usageArmed }。
 * - trigger: 'round' | 'compact' | 'usage' | ''
 * - 计数写失败只 stderr（不阻断命令，边界·异常）。
 */
export function bumpAndDecide({ projectName, role, usageTokens = null, warnThreshold = null, now = null }) {
  const at = nowIso();
  let out = { n: 0, next: 1, inject: false, trigger: '', reasons: [], counterFile: rolecardCounterFile(projectName, role), usageArmed: false };
  try {
    withLock(`rolecard:${projectName}:${role}`, { ...COUNTER_LOCK_OPTS }, () => {
      const cur = readCounter(projectName, role);
      const n = Number(cur.opsSinceInject) || 0;
      const next = n + 1;
      const reasons = [];
      let trigger = '';
      // ① 轮次检查点（M1）：(n+1)%20===0 && n+1>=20
      const roundHit = (next % INJECT_EVERY === 0) && (next >= INJECT_EVERY);
      if (roundHit) { trigger = 'round'; reasons.push(`round:${next}`); }
      // ② 压缩信号（M3）：读到即消费
      const compact = consumeCompactSignal();
      if (compact) { reasons.push(`compact:${compact.deleted ? 'consumed' : 'delete_failed'}`); if (!trigger) trigger = 'compact'; }
      // ③ usage 闩锁（M5）：仅跨阈值一次
      let usageArmed = false;
      const tokens = Number(usageTokens);
      const warn = Number(warnThreshold);
      const last = cur.lastUsageTokens === null || cur.lastUsageTokens === undefined ? null : Number(cur.lastUsageTokens);
      if (Number.isFinite(tokens) && Number.isFinite(warn) && warn > 0) {
        if (tokens > warn && (last === null || last <= warn)) { usageArmed = true; reasons.push(`usage:${tokens}>${warn}`); if (!trigger) trigger = 'usage'; }
        else if (tokens <= warn && last !== null && last > warn) { reasons.push(`usage_below_warn:${tokens}`); }
      }
      const inject = Boolean(trigger);
      const row = {
        ...cur,
        opsSinceInject: inject ? 0 : next,
        lastUsageTokens: Number.isFinite(tokens) ? tokens : cur.lastUsageTokens,
      };
      writeCounter(projectName, role, row);
      out = { n, next, inject, trigger, reasons, counterFile: cur.file, usageArmed, compact };
    });
    return out;
  } catch (e) {
    // 边界·异常：计数写失败只 stderr，不阻断命令
    try { console.error(`[rolecard] counter update failed: ${String((e && e.message) || e)}`); } catch { /* ignore */ }
    return { ...out, error: String((e && e.message) || e) };
  }
}

/** 注入成功后回写计数（lastInjectAt / lastCardSha12 / injections[]）。 */
export function markInjected({ projectName, role, cardSha12 = '', shownLines = 0, trigger = '', opsSinceInject = 0, now = null }) {
  const at = nowIso();
  try {
    withLock(`rolecard:${projectName}:${role}`, { ...COUNTER_LOCK_OPTS }, () => {
      const cur = readCounter(projectName, role);
      cur.lastInjectAt = at;
      cur.lastCardSha12 = String(cardSha12 || '');
      cur.injections = [...(cur.injections || []), { at, trigger, shownLines, opsSinceInject }].slice(-20);
      writeCounter(projectName, role, cur);
    });
  } catch (e) {
    try { console.error(`[rolecard] markInjected failed: ${String((e && e.message) || e)}`); } catch { /* ignore */ }
  }
  return { at, cardSha12, trigger, shownLines };
}

/** 简报/CLI 用的计数视图（只读）。 */
export function countersOf(projectName, role) {
  const cur = readCounter(projectName, role);
  return {
    opsSinceInject: cur.opsSinceInject,
    lastInjectAt: cur.lastInjectAt,
    lastCardSha12: cur.lastCardSha12,
    lastUsageTokens: cur.lastUsageTokens,
    injections: cur.injections,
    injectionCount: Array.isArray(cur.injections) ? cur.injections.length : 0,
  };
}

/**
 * TR-Q② / 需求 §6.2④：读本角色 usage 与**模块唯一阈值来源**（不写死数字）。
 * - usage 通道：`团队/状态/项目/<P>/会话用量.json`（session.mjs 的 usageFilePath，usage-hook / session usage / manual 都往这写）；
 * - 阈值：`session.mjs → sessionLimitsOf(project).of(role).warn`（pm 60 万 / 其余 30 万，项目可覆盖）。
 * 读不到一律返回 { tokens:null, warn:null } → 调用方只按轮次/压缩触发（降级不静默）。
 */
export async function usageOfRole(projectName, role) {
  let tokens = null;
  let warn = null;
  try {
    const session = await import('./session.mjs');
    const track = session.readSessionUsageTrack(projectName);
    const row = (track.roles || {})[String(role || '')] || null;
    // 注意：`Number(null)===0` —— 无 row 时必须保持 null（否则会把「用量未知」当成 0 并写进闩锁）
    const raw = row ? (row.tokens ?? row.input) : null;
    tokens = raw == null ? null : (Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : null);
    const limits = session.sessionLimitsOf(projectName);
    const lim = limits && typeof limits.of === 'function' ? limits.of(String(role || '')) : null;
    warn = lim && Number.isFinite(Number(lim.warn)) ? Number(lim.warn) : null;
  } catch { /* 依赖不可用 → 降级（只按轮次/压缩） */ }
  return { tokens, warn };
}

/* ── 写操作门（§6.3） ──────────────────────────────────────────────── */

/**
 * boot 记录里的卡 sha12 vs 当前卡 sha12。
 * @returns {{ok:boolean, bootSha12:string, currentSha12:string, stale:boolean, enforce:boolean}}
 */
export function rolecardGateState({ bootDocHashes = null, projectName, role }) {
  const bootSha = String((bootDocHashes && (bootDocHashes.roleCard || {}).hash) || '');
  const cur = rolecardDigestOf(projectName, role);
  const currentSha = String(cur.cardSha256 || '');
  const ok = !bootSha || !currentSha ? true : bootSha === currentSha;
  return {
    ok,
    bootSha12: bootSha ? bootSha.slice(0, 12) : '',
    currentSha12: currentSha ? currentSha.slice(0, 12) : '',
    stale: !ok,
    enforce: String(process.env.TEAM_ROLECARD_ENFORCE || '') === '1',
    digest: cur,
  };
}

/** 硬门（TEAM_ROLECARD_ENFORCE=1）失败时调用：零写入。 */
export function failRolecardUnread({ role, bootSha12, currentSha12, project, commands }) {
  fail('ROLECARD_UNREAD', `角色卡已变（boot 读的是 ${bootSha12 || '(无记录)'}，当前 ${currentSha12}）：先重 boot 读一次当前角色卡再写操作（${(commands || []).join('/')}）；TEAM_ROLECARD_ENFORCE=1 下硬拒、零写入`, {
    role, project,
    bootSha12, currentSha12,
    hint: `node 团队\\工具\\team.mjs boot --role ${role} --project "${project || '<项目>'}"`,
    digestCommand: `node 团队\\工具\\team.mjs rolecard digest --role ${role} --project "${project || '<项目>'}"`,
  });
}

/** 软提示行（默认模式）：把摘要附在返回体/人类文本里。 */
export function rolecardSoftNotice({ role, bootSha12, currentSha12, digest }) {
  const lines = [
    `[rolecard-digest] ROLECARD_STALE_SOFT：角色卡已变（boot 读 ${bootSha12 || '(无记录)'} → 当前 ${currentSha12}），本次按软门放行`,
    `角色卡: sha12 ${currentSha12} ｜ 摘要 ${digest.lineCount} 行`,
    ...digest.lines,
    '下一步：重 boot 读一次当前角色卡（硬门需 TEAM_ROLECARD_ENFORCE=1）',
  ];
  return lines.join('\n');
}

/** 轮次注入文本（AC3①：返回体含 [rolecard-digest]）。 */
export function rolecardInjectNotice({ role, trigger, digest, n = 0, next = 0 }) {
  return [
    `[rolecard-digest] trigger=${trigger || 'round'}（opsSinceInject ${n} → ${next}，第 ${next} 次写操作命中检查点）`,
    `角色卡: sha12 ${digest.cardSha12} ｜ 摘要 ${digest.lineCount} 行 / ${digest.bytes}B`,
    ...digest.lines,
  ].join('\n');
}

/** `team.mjs rolecard digest --role <r> --project <P>`：手动自证（与注入内容逐字一致，AC7④）。 */
export function cmdRolecardDigest(args = {}) {
  const projectName = String(args.project || '').trim();
  const role = String(args.role || '').trim();
  if (!projectName) fail('NO_PROJECT', '需要 --project（或先 project use）');
  if (!role) fail('BAD_ROLE', '需要 --role <角色>');
  const digest = rolecardDigestOf(projectName, role);
  const counters = countersOf(projectName, role);
  const payload = {
    ok: true,
    project: projectName,
    role,
    cardFile: digest.file,
    cardExists: digest.exists,
    cardSha12: digest.cardSha12,
    digestSha256: digest.sha256,
    digestLines: digest.lineCount,
    digestBytes: digest.bytes,
    sourceLines: digest.sourceLines,
    keywords: digest.keywords,
    degraded: digest.degraded,
    empty: digest.empty,
    truncated: digest.truncated,
    injections: counters.injectionCount,
    lastInjectAt: counters.lastInjectAt,
    opsSinceInject: counters.opsSinceInject,
    text: digest.text,
  };
  const human = [
    `角色卡: sha12 ${digest.cardSha12 || '(缺失)'} ｜ 摘要 ${digest.lineCount} 行 / ${digest.bytes}B ｜ 重注入 ${counters.injectionCount} 次${counters.lastInjectAt ? '（最近 ' + counters.lastInjectAt + '）' : ''}`,
    digest.empty ? '（摘要为空：ROLE_CARD_DIGEST_EMPTY）' : digest.text,
  ].join('\n');
  // 只读：不改计数、不写审计（AC6③）
  if (args.json) jsonOut(payload); else textOut(human);
  return payload;
}

export default {
  rolecardDigest, rolecardDigestOf, bumpAndDecide, markInjected, countersOf,
  consumeCompactSignal, rolecardGateState, failRolecardUnread, rolecardSoftNotice, rolecardInjectNotice,
  appendRolecardAudit, rolecardCounterFile, compactSignalFile, rolecardAuditFile, rolecardPathOf,
  DIGEST_MAX_LINES, DIGEST_MAX_BYTES, INJECT_EVERY, H_KEYWORDS,
};
