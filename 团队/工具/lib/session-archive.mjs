// R-20261112-165247-2e6b · 会话轮次 / 归档 / 违规 / 转录（v5，只读 DSH 会话源，写项目状态）
//
// 文件：
//   团队/状态/项目/<项目>/会话轮次.json          角色轮次（role/roundsSinceArchive/lastTaskIds/lastArchiveAt/updatedAt）
//   团队/状态/项目/<项目>/会话归档/A-<ts>-<角色>.json  9 字段 + rotatedAt/confirmedAt/frozenAt
//   团队/状态/项目/<项目>/违规/记录.jsonl           违规日志（9 字段）
//   团队/状态/项目/<项目>/会话转录/<session>.json    可核查转录（只读源导出，不写 DSH_HOME）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { nowIso, stamp, ensureDir, fail, truncate, acquireLock, releaseLock, listLocks, TeamError } from './core.mjs';
import { loadProject, projectStatePaths, listTasks, sendMessage, loadTeam, saveTeam } from './store.mjs';
import { setMemberSession } from './roster-writer.mjs';
import { PATHS } from './core.mjs';
import { statusIsClosed, isRequirementMirrorTask } from './gates.mjs';
import { writeJsonAtomic } from './json-atomic.mjs';

export const ROUNDS_MAX = 10;
const ARCHIVE_DIR = '会话归档';
const ROUNDS_FILE = '会话轮次.json';
const VIOLATION_DIR = '违规';
const TRANSCRIPT_DIR = '会话转录';

export function sessionStateDir(projectName) {
  return projectStatePaths(projectName).dir;
}
export function roundsFile(projectName) {
  return path.join(sessionStateDir(projectName), ROUNDS_FILE);
}
export function archiveDir(projectName) {
  return path.join(sessionStateDir(projectName), ARCHIVE_DIR);
}
export function violationDir(projectName) {
  return path.join(sessionStateDir(projectName), VIOLATION_DIR);
}
export function transcriptDir(projectName) {
  return path.join(sessionStateDir(projectName), TRANSCRIPT_DIR);
}

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return def; }
}
function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
function randomId(prefix) {
  return `${prefix}-${stamp()}-${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * B-20261119-154518-196e：某个 sessionId **被替换下来的时刻**（ISO）。
 * 来源：项目 `会话轮换/<角色>.json` 与本角色轮换记录（from==sessionId 的那条 at），再退 `会话轮换.jsonl`。
 * 没有记录返回 ''（调用方按「不知道换人时刻」保守处理）。
 */
export function rotationAtForSession(projectName, role, sessionId) {
  const target = String(sessionId || '');
  if (!target) return '';
  const dir = path.join(sessionStateDir(projectName), '会话轮换');
  try {
    const roleRow = readJson(path.join(dir, `${role}.json`), null);
    if (roleRow && String(roleRow.from || '') === target && roleRow.at) return String(roleRow.at);
    // 角色文件可能已被下一次换人覆盖：翻 S-*.json 历史（只看本角色）
    for (const name of fs.readdirSync(dir)) {
      if (!/^S-.*\.json$/i.test(name)) continue;
      const row = readJson(path.join(dir, name), null);
      if (!row || String(row.role || '') !== String(role)) continue;
      if (String(row.from || '') === target && row.at) return String(row.at);
    }
  } catch { /* 没有轮换目录 */ }
  try {
    const ledger = path.join(sessionStateDir(projectName), '会话轮换.jsonl');
    for (const line of fs.readFileSync(ledger, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (String(row.role || '') === String(role) && String(row.from || '') === target && row.at) return String(row.at);
      } catch { /* 跳过坏行 */ }
    }
  } catch { /* 没有账本 */ }
  return '';
}

/**
 * B-196e：这个未闭环任务算不算「(旧)会话 sessionId 自己的活」。
 * 判定顺序（写死）：
 *   ① 任务有 `ownerSessionId` → 精确比（rotate 的 stampTasks 会把它改成新会话，所以换人后余留任务全归新会话）；
 *   ② 没有绑定 → 用认领时间与「会话被替换时刻」比：认领早于替换 → 属旧会话（挡归档）；晚于 → 属新会话（不挡）；
 *   ③ 两条都判不了（无 claimedAt / 无替换时刻）→ **保守算作该会话**（不退化成放开，宁可延后可查）。
 */
export function taskBelongsToSession(task, sessionId, replaceAt = '') {
  const target = String(sessionId || '');
  if (!target) return true;
  const bound = String((task && task.ownerSessionId) || '');
  if (bound) return bound === target;
  const claimMs = Date.parse(String((task && (task.claimedAt || task.createdAt)) || ''));
  const rotMs = Date.parse(String(replaceAt || ''));
  if (Number.isFinite(claimMs) && Number.isFinite(rotMs)) return claimMs < rotMs;
  return true;
}

/** 当前角色会话 id：优先项目团队会话.json，再退团队.json 名册。 */
export function currentSessionOf(projectName, role) {
  const project = loadProject(projectName);
  const candidates = [
    path.join(project.path, '团队会话.json'),
    path.join(sessionStateDir(projectName), '团队会话.json'),
    path.join(sessionStateDir(projectName), '..', '..', '团队.json'),
  ];
  for (const file of candidates) {
    const data = readJson(file, null);
    if (!data) continue;
    const rows = Array.isArray(data.roles) ? data.roles : (Array.isArray(data.members) ? data.members : []);
    const hit = rows.find((r) => String(r.role || '') === role && String(r.sessionId || ''));
    if (hit) return String(hit.sessionId);
  }
  return '';
}

// ---------- 轮次 ----------

export function readRounds(projectName, role) {
  const all = readJson(roundsFile(projectName), {});
  const row = all[role] || {};
  return {
    role,
    roundsSinceArchive: Number(row.roundsSinceArchive || 0),
    lastTaskIds: Array.isArray(row.lastTaskIds) ? row.lastTaskIds : [],
    lastArchiveAt: row.lastArchiveAt || null,
    updatedAt: row.updatedAt || null,
  };
}

export function roundsQuery(projectName, role) {
  if (!role) fail('BAD_ROLE', '需要 --role');
  const project = loadProject(projectName);
  const row = readRounds(projectName, role);
  return { ok: true, project: project.name, ...row, max: ROUNDS_MAX };
}

/** task done 自动 +1：同任务重复 done 只计 1（lastTaskIds 去重）；达 10 归零并自动归档。 */
export function bumpRound(projectName, role, taskId) {
  const lockKey = `rounds:${projectName}:${role}`;
  let locked = false;
  try { acquireLock(lockKey, { role: 'system', ttlMs: 10000, waitMs: 5000, reason: 'round bump' }); locked = true; } catch { /* 拿不到锁就不计数，不阻断 task done */ }
  try {
    const all = readJson(roundsFile(projectName), {});
    const row = all[role] || { role, roundsSinceArchive: 0, lastTaskIds: [], lastArchiveAt: null };
    const ids = Array.isArray(row.lastTaskIds) ? row.lastTaskIds : [];
    if (taskId && ids.includes(String(taskId))) {
      return { role, rounds: Number(row.roundsSinceArchive || 0), duplicated: true, archived: null };
    }
    if (taskId) ids.push(String(taskId));
    row.role = role;
    row.lastTaskIds = ids.slice(-100);
    row.roundsSinceArchive = Number(row.roundsSinceArchive || 0) + 1;
    row.updatedAt = nowIso();
    let archived = null;
    if (row.roundsSinceArchive >= ROUNDS_MAX) {
      row.roundsSinceArchive = 0;
      row.lastArchiveAt = nowIso();
      row.lastTaskIds = [];
      archived = 'triggered';
    }
    all[role] = row;
    writeJson(roundsFile(projectName), all);
    return { role, rounds: row.roundsSinceArchive, duplicated: false, archived };
  } finally {
    if (locked) { try { releaseLock(lockKey, { role: 'system' }); } catch { /* ignore */ } }
  }
}

// ---------- 转录（只读 DSH 会话源） ----------

export function dshHome() {
  const env = String(process.env.DSH_HOME || '').trim();
  if (env) return path.resolve(env);
  return path.join(process.env.USERPROFILE || os.homedir(), '.dsh');
}

export function findSessionLog(sessionId, home = dshHome()) {
  const root = path.join(home, 'sessions');
  if (!fs.existsSync(root)) return null;
  const wanted = `session-${String(sessionId || '').replace(/^session-/, '')}`;
  for (const ws of fs.readdirSync(root)) {
    const dir = path.join(root, ws, wanted);
    for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'transcript.jsonl', 'session.jsonl']) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return { file, ws, dir };
    }
  }
  return null;
}

function decodeSessionLog(file) {
  const buf = fs.readFileSync(file);
  if (file.endsWith('.zstd')) return zlib.zstdDecompressSync(buf).toString('utf8');
  return buf.toString('utf8');
}

/** 导出转录：{session, role, transcript:'ok'|'missing'|'unreadable', turns:[{at,preToolThought,toolCalls[],reply}]}。 */
export function exportTranscript({ sessionId, role = '', home = dshHome() }) {
  const sid = String(sessionId || '');
  if (!sid) fail('BAD_ARGS', '需要 --session（会话 id）');
  const log = findSessionLog(sid, home);
  if (!log) return { ok: true, session: sid, role, transcript: 'missing', turns: [] };
  let text = '';
  try { text = decodeSessionLog(log.file); } catch (e) {
    return { ok: true, session: sid, role, transcript: 'unreadable', why: String((e && e.message) || e), turns: [] };
  }
  const events = text.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const meta = events.find((e) => e && e.type === 'session') || {};
  const turns = [];
  let cur = null;
  for (const e of events) {
    if (!e) continue;
    if (e.type === 'turn/start') {
      cur = { at: new Date(Number(e.time || Date.now())).toISOString(), preToolThought: '', toolCalls: [], reply: '', inputTokens: null };
      turns.push(cur);
      continue;
    }
    if (!cur) continue;
    if (e.type === 'assistant/message' && e.data) {
      const content = Array.isArray(e.data.message && e.data.message.content) ? e.data.message.content : [];
      const reasoning = content.filter((c) => c && c.type === 'reasoning').map((c) => String(c.text || '')).join('\n').trim();
      const texts = content.filter((c) => c && c.type === 'text').map((c) => String(c.text || '')).join('\n').trim();
      const calls = content.filter((c) => c && c.type === 'tool-call');
      if (calls.length && !cur.preToolThought && reasoning) cur.preToolThought = truncate(reasoning, 1000);
      if (texts) cur.reply = truncate(texts, 1000);
      const usage = e.data.usage || {};
      if (cur.inputTokens === null && Number.isFinite(Number(usage.inputTokens))) cur.inputTokens = Number(usage.inputTokens);
      continue;
    }
    if (e.type === 'tool/call' && e.data) {
      cur.toolCalls.push({ name: String(e.data.name || ''), arguments: truncate(String(e.data.arguments || ''), 200) });
    }
  }
  const result = { ok: true, session: sid, role, transcript: 'ok', cwd: String(meta.cwd || ''), turns: turns.slice(-200) };
  return result;
}

/** 导出并落盘到项目状态 会话转录/<session>.json。 */
export function exportTranscriptToProject({ projectName, sessionId, role = '' }) {
  const result = exportTranscript({ sessionId, role });
  if (result.transcript === 'ok') {
    try {
      const file = path.join(transcriptDir(projectName), `${String(sessionId)}.json`);
      writeJson(file, result);
      result.file = file;
    } catch { /* 落盘失败不阻断导出 */ }
  }
  return result;
}

/** 角色最近一轮 inputTokens（archive/usage 用）；无转录返回 null。 */
export function latestInputTokens({ projectName, sessionId }) {
  if (!sessionId) return null;
  const t = exportTranscript({ sessionId });
  if (t.transcript !== 'ok' || !t.turns.length) return null;
  const last = t.turns[t.turns.length - 1];
  return Number.isFinite(Number(last.inputTokens)) ? Number(last.inputTokens) : null;
}

// ---------- 违规（中文可核查） ----------

const CJK_RE = /[\u4e00-\u9fff]/;

/** 找出连续 ≥3 行英文叙述（非空、无中文、≥3 个英文单词）。 */
export function englishRuns(text) {
  const runs = [];
  let cur = [];
  const isEnglish = (line) => {
    const t = String(line || '').trim();
    if (!t || CJK_RE.test(t)) return false;
    const words = t.match(/[A-Za-z][A-Za-z-]{2,}/g) || [];
    return words.length >= 3;
  };
  for (const line of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    if (isEnglish(line)) cur.push(line.trim());
    else { if (cur.length >= 3) runs.push(cur.slice(0, 8)); cur = []; }
  }
  if (cur.length >= 3) runs.push(cur.slice(0, 8));
  return runs;
}

export function listViolations(projectName) {
  const file = path.join(violationDir(projectName), '记录.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function appendViolation(projectName, record) {
  const file = path.join(violationDir(projectName), '记录.jsonl');
  ensureDir(violationDir(projectName));
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}

function notifyPm(projectName, subject, body) {
  try {
    const dir = path.join(sessionStateDir(projectName), '..', '..', '邮箱', 'pm', 'new');
    ensureDir(dir);
    const msg = {
      id: `M-${stamp()}-${crypto.randomBytes(3).toString('hex')}`,
      from: 'tester', to: 'pm', subject, body, project: projectName, task: '', ackRequired: true, type: 'receipt', replyTo: null, ts: nowIso(),
    };
    fs.writeFileSync(path.join(dir, `${msg.id}.json`), JSON.stringify(msg, null, 2) + '\n', 'utf8');
    return msg;
  } catch { return null; }
}

/** 违规审核：连续 3 行英文 → 写 违规/记录.jsonl（9 字段），第 2 次起升级 PM。 */
export function auditOutput({ projectName, role, relFile, byRole = '' }) {
  if (!role) fail('BAD_ROLE', '需要 --role');
  if (!relFile) fail('BAD_ARGS', '需要 --file（项目内相对路径）');
  const project = loadProject(projectName);
  const abs = path.resolve(project.path, String(relFile));
  const rel = path.relative(project.path, abs).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail('PATH_OUTSIDE_PROJECT', `${relFile} 不在项目目录内`);
  if (!fs.existsSync(abs)) fail('FILE_NOT_FOUND', `${rel} 不存在`);
  const text = fs.readFileSync(abs, 'utf8');
  const runs = englishRuns(text);
  if (!runs.length) return { ok: true, violation: false, file: rel, role };
  const prev = listViolations(projectName).filter((v) => v.role === role);
  const escalated = prev.length >= 1;
  const record = {
    id: randomId('V'),
    at: nowIso(),
    role,
    file: rel,
    kind: 'english_run_3plus',
    evidence: truncate(runs[0].join(' / '), 500),
    action: 'returned_for_rewrite',
    escalated,
    escalatedTo: escalated ? 'pm' : null,
  };
  appendViolation(projectName, record);
  let message = null;
  if (escalated) message = notifyPm(projectName, `违规升级：${role} 连续 2 次`, `${rel} 连续 3 行以上英文叙述，已退回重写；请 PM 处置。`);
  return { ok: true, violation: true, record, message, byRole };
}

// ---------- 归档 ----------

export function listArchives(projectName) {
  const dir = archiveDir(projectName);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort().map((n) => readJson(path.join(dir, n), null)).filter(Boolean);
}

function pmDecisionLog(projectPath, role, record, text) {
  try {
    const dir = path.join(projectPath, '项目经理');
    ensureDir(dir);
    const file = path.join(dir, '决策日志.md');
    const line = `\n- ${nowIso()} ｜ ${text}（归档 ${record.id}，角色 ${role}，待 Owner 确认）\n`;
    fs.appendFileSync(file, line, 'utf8');
    return file;
  } catch { return null; }
}

/**
 * 归档：写 会话归档/A-<ts>-<角色>.json（9 字段 + rotatedAt/confirmedAt/frozenAt），轮次归零。
 *
 * R-20261118-131107-28b8：新增显式 `sessionId` 入参（默认仍取 currentSessionOf，老调用语义不变）。
 * 换人后必须按「被替换下来的旧 sessionId」归档——否则按 currentSessionOf 会把刚建的新会话归档掉。
 * `skipTranscript`：沙盘/夹具用（不读 DSH 转录，只写本地记录；inputTokens 记 null 而不是去猜）。
 */
export function archiveSession({ projectName, role, reason = '', self = false, auto = false, operator = 'pm', force = false, sessionId: explicitSessionId = '', skipTranscript = false }) {
  if (!role) fail('BAD_ROLE', '需要 --role');
  const project = loadProject(projectName);
  // B-da51（f73f 回归）：未闭环判据 = 非终态（statusIsClosed）+ 非镜像任务（type=requirement）+ owner 命中。
  // 镜像任务随需求行永久存在、f73f 起还带默认 owner（product/analyst），不能算「角色还有活」，否则归档被永久挡住。
  //
  // B-20261119-154518-196e（P2）：判据必须**按会话**而不是只按角色——
  // 换人后新会话立刻接的新任务曾被算成「旧会话还有活」，旧会话归档重试 3 次即 retry_exhausted 永久失败。
  // 现在：先由 sessionId 推导「它被替换的时刻」，再用 taskBelongsToSession() 只收「属于该会话的活」；
  // 推导不到替换时刻（未换人/无轮换记录）时退化为原角色级判据（老行为不变，不破坏既有夹具）。
  const targetSession = String(explicitSessionId || '').trim() || currentSessionOf(projectName, role);
  const replacedAt = String(rotationAtForSession(projectName, role, targetSession) || '');
  const open = (listTasks(projectName) || []).filter((t) => String(t.owner || '') === role
    && !isRequirementMirrorTask(t) && !statusIsClosed(String(t.status || 'done'))
    && taskBelongsToSession(t, targetSession, replacedAt));
  if (open.length) {
    fail('TASK_OPEN', `角色 ${role} 还有 ${open.length} 个未闭环任务，先 done 再归档`, {
      tasks: open.map((t) => t.id),
      // 可排障：说明本次按「会话」还是「角色」口径判的（B-196e）
      sessionId: targetSession || '',
      replacedAt: replacedAt || '',
      scope: replacedAt ? 'session' : 'role',
    });
  }
  const locks = (listLocks() || []).filter((l) => String(l.role || '') === role && !l.stale);
  if (locks.length) fail('ROLE_BUSY', `角色 ${role} 持活动锁，先释放再归档`, { locks: locks.map((l) => l.key) });
  const sessionId = targetSession;
  // AC18.8：未确认前不得再次 --self —— 该判定必须先于“重复归档”，否则同一会话会被 ALREADY_ARCHIVED 抢先。
  if (self) {
    const pending = listArchives(projectName).find((a) => a.role === 'pm' && a.self === true && !a.confirmedAt);
    if (pending) fail('OWNER_CONFIRM_REQUIRED', `上一次 PM 自归档待 Owner 确认（${pending.id}），确认前不得再次 --self`, { archiveId: pending.id });
  }
  const dup = listArchives(projectName).find((a) => a.role === role && String(a.sessionId || '') === String(sessionId || ''));
  if (dup && !force) fail('ALREADY_ARCHIVED', `该会话已归档：${dup.id}（如需重归档加 --force）`, { archiveId: dup.id });
  // B-20261119-133232-e6c1：归档清理会把名册 sessionId 清空，导致第二次归档看起来像新会话；
  // 这里补「已确认但未换人」的重复归档守卫（rotate 后 rotatedAt 有值即放行），保持 ALREADY_ARCHIVED 语义。
  const pendingUnrotated = listArchives(projectName).find((a) => String(a.role || '') === role && !a.rotatedAt && a.confirmedAt);
  if (pendingUnrotated && !force) fail('ALREADY_ARCHIVED', `该角色已有未换人的归档：${pendingUnrotated.id}（如需重归档加 --force，或先 session rotate）`, { archiveId: pendingUnrotated.id });
  const rounds = readRounds(projectName, role).roundsSinceArchive;
  const inputTokens = skipTranscript ? null : latestInputTokens({ projectName, sessionId });
  const at = nowIso();
  const record = {
    id: `A-${stamp()}-${role}`,
    role,
    sessionId: sessionId || null,
    rounds,
    inputTokens,
    at,
    reason: truncate(reason || (auto ? '轮次达 10 自动归档' : '手动归档'), 300),
    nextSessionId: null,
    operator: operator || 'pm',
    self: Boolean(self),
    rotatedAt: null,
    confirmedAt: self ? null : at,
    frozenAt: at,
    auto: Boolean(auto),
  };
  const file = path.join(archiveDir(projectName), `${record.id}.json`);
  writeJson(file, record);
  // 轮次归零
  const all = readJson(roundsFile(projectName), {});
  const row = all[role] || { role };
  row.roundsSinceArchive = 0;
  row.lastArchiveAt = at;
  row.lastTaskIds = [];
  row.updatedAt = at;
  all[role] = row;
  writeJson(roundsFile(projectName), all);
  const decisionLog = self ? pmDecisionLog(project.path, role, record, 'PM 自归档，待 Owner 在 owner confirm --archive 确认') : null;
  // B-20261119-133232-e6c1：归档角色后必须同步摘掉「该角色仍已就绪」的所有派生状态（名册/boot/项目映射/workbench）。
  const cleanup = clearArchivedRoleState(projectName, role, sessionId, record.id);
  return { ok: true, record, file, decisionLog, project: project.name, cleanup };
}

/** Owner 确认 PM 自归档：写 confirmedAt（值为确认时间）。 */
export function confirmArchive({ projectName, archiveId, by = 'owner' }) {
  if (!archiveId) fail('BAD_ARGS', '需要 --archive <归档 id>');
  const file = path.join(archiveDir(projectName), `${String(archiveId)}.json`);
  if (!fs.existsSync(file)) fail('ARCHIVE_NOT_FOUND', `归档不存在：${archiveId}`, { archiveId });
  const record = readJson(file, null);
  if (!record) fail('ARCHIVE_NOT_FOUND', `归档不可读：${archiveId}`, { archiveId });
  record.confirmedAt = nowIso();
  record.confirmedBy = by;
  writeJson(file, record);
  return { ok: true, record, file };
}

/** rotate 成功后回写 nextSessionId/rotatedAt（找该角色下一跳为空的最近归档）。 */
export function writeBackRotated({ projectName, role, oldSessionId = '', newSessionId = '' }) {
  const archives = listArchives(projectName).filter((a) => a.role === role && !a.nextSessionId);
  const target = archives.find((a) => oldSessionId && a.sessionId === oldSessionId) || archives[archives.length - 1];
  if (!target) return null;
  const file = path.join(archiveDir(projectName), `${target.id}.json`);
  const record = readJson(file, null);
  if (!record) return null;
  record.nextSessionId = newSessionId || null;
  record.rotatedAt = nowIso();
  writeJson(file, record);
  return { ok: true, record, file };
}

/** 省 token 采样：session usage --role --session 输出 firstTurnInputTokens（boot 后、首个 task done 前）。 */
export function firstTurnUsage({ projectName, sessionId, role = '' }) {
  const t = exportTranscript({ sessionId, role });
  const first = t.turns && t.turns[0];
  return {
    ok: true,
    project: projectName,
    role,
    session: String(sessionId || ''),
    transcript: t.transcript,
    firstTurnInputTokens: first && Number.isFinite(Number(first.inputTokens)) ? Number(first.inputTokens) : null,
    sampledAt: nowIso(),
  };
}

/* ───────── R-20261118-131107-28b8：换人成功后自动归档旧会话（失败可见、在途可延后） ─────────
 *
 * 缺口（写稿时基线）：换人只有「换人前的建议」ARCHIVE_REQUIRED（已降为 advice-not-blocker），
 * 换下来的旧会话没人归档；而 archiveSession() 只按 currentSessionOf(role) 取对象——换人后调用会把
 * **刚建的新会话**归档掉。所以本段做四件事：
 *   ① 显式 sessionId 归档（archiveSession 新增入参，默认值不变）；
 *   ② 五态记录（archived / already / deferred / failed / skipped，沙盘另有 stubbed）写 会话归档.jsonl
 *      + 回填 会话轮换/<role>.json 的 archive 段；
 *   ③ 失败可见：审计 + stderr + 给 PM 一条 notice（不阻断已成功的换人）；
 *   ④ 在途 deferred → routeTick 每拍 sweep 补归档，最多 3 次（初始 1 + 重试 2），第 3 次落 failed。
 *
 * 沙盘口径：TEAM_SELFTEST=1 默认只记账（result=stubbed），不写真归档/不读 DSH 转录；
 * `TEAM_ARCHIVE_STUB=0|off` 显式关闭 stub（夹具要拿 archived 时用）。失败注入缝：
 * `AWB_ARCHIVE_FAIL_ONCE=1` / `AWB_ARCHIVE_FAIL_TIMES=n`（只在 TEAM_SELFTEST=1 下生效）。
 */
export const ARCHIVE_LEDGER_NAME = '会话归档.jsonl';
export const ARCHIVE_RETRY_MS = 10 * 60 * 1000;
export const ARCHIVE_MAX_ATTEMPTS = 3;
export const ARCHIVE_SWEEP_LIMIT = 5;
export const ARCHIVE_RESULTS = ['archived', 'already', 'deferred', 'failed', 'skipped', 'stubbed'];

export function archiveLedgerPath(projectName) {
  return path.join(sessionStateDir(projectName), ARCHIVE_LEDGER_NAME);
}

function nowMsOf(now) {
  if (now === null || now === undefined || now === '') return Date.now();
  const ms = typeof now === 'number' ? now : Date.parse(String(now));
  return Number.isFinite(ms) ? ms : Date.now();
}

/** 沙盘 stub：TEAM_SELFTEST=1 默认只记账；TEAM_ARCHIVE_STUB=0/off 显式关闭（夹具要真归档时）。 */
export function archiveStubEnabled() {
  const raw = String(process.env.TEAM_ARCHIVE_STUB == null ? '' : process.env.TEAM_ARCHIVE_STUB).trim().toLowerCase();
  if (['0', 'off', 'false', 'no', 'disable', 'disabled'].includes(raw)) return false;
  return String(process.env.TEAM_SELFTEST || '') === '1';
}

// 失败注入缝：模块级计数（同进程可控制次数；跨进程用 env 每次生效）。
let injectedFailuresLeft = -1;
function takeInjectedArchiveFailure() {
  if (String(process.env.TEAM_SELFTEST || '') !== '1') return false;
  if (injectedFailuresLeft < 0) {
    const times = Number(process.env.AWB_ARCHIVE_FAIL_TIMES || 0);
    injectedFailuresLeft = String(process.env.AWB_ARCHIVE_FAIL_ONCE || '') === '1'
      ? 1
      : (Number.isFinite(times) && times > 0 ? Math.floor(times) : 0);
  }
  if (injectedFailuresLeft > 0) { injectedFailuresLeft -= 1; return true; }
  return false;
}

/** 读 会话归档.jsonl（append-only；坏行计 badLines，不静默丢）。 */
export function readArchiveLedger(projectName) {
  const file = archiveLedgerPath(projectName);
  const rows = [];
  let badLines = 0;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row === 'object') rows.push(row);
        else badLines += 1;
      } catch { badLines += 1; }
    }
  } catch { /* 文件不存在 → 空账本（首行由 append 创建） */ }
  return { rows, badLines, file };
}

export function appendArchiveLedger(projectName, row) {
  const file = archiveLedgerPath(projectName);
  try {
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
    return { ok: true, file };
  } catch (e) {
    return { ok: false, file, why: String((e && e.message) || e) };
  }
}

/**
 * 会话轮换/<role>.json 增/改 archive 段（JSON 原子写）。
 * 只在「这条归档确实属于该轮换记录」时回填（record.to === newSessionId 或 record.from === oldSessionId）——
 * 否则会把更早一次轮换的补归档结果写到**最新一次**记录上（账实不符）。历史轮换的 S-*.json 不动。
 */
export function patchRotationArchive(projectName, role, archive, { newSessionId = '', oldSessionId = '' } = {}) {
  const file = path.join(projectStatePaths(projectName).dir, '会话轮换', `${role}.json`);
  try {
    if (!fs.existsSync(file)) return { ok: false, why: 'rotation_record_missing', file };
    const record = readJson(file, null);
    if (!record) return { ok: false, why: 'rotation_record_broken', file };
    const to = String(record.to || '');
    const from = String(record.from || '');
    const next = String(newSessionId || '');
    const prev = String(oldSessionId || '');
    const matches = (!next && !prev) || (next && to && to === next) || (prev && from && from === prev);
    if (!matches) return { ok: false, why: 'rotation_record_not_matching', file, recordTo: to, newSessionId: next };
    record.archive = archive;
    writeJsonAtomic(file, record, { case: 'archive-record', project: projectName, lockTimeoutMs: 3000 });
    return { ok: true, file };
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e), file };
  }
}

/** 归档失败通知 PM（notice，一条一句话可行动；同一 oldSessionId 只发一次由 finishArchiveRecord 控制）。 */
function notifyArchiveFailed(projectName, row) {
  try {
    const attempts = row.attempts ? `，第 ${row.attempts} 次` : '';
    const body = [
      `角色 ${row.role} 的旧会话 ${row.oldSessionId || '(空)'} 自动归档失败（${row.reason || row.error || '未知原因'}${attempts}）。`,
      `新会话：${row.newSessionId || '(未记录)'}；换人已成功，本次归档失败不阻断换人与派单。`,
      `手动补归档：node 团队\\工具\\team.mjs session archive --project "${projectName}" --role ${row.role} --archive-session ${row.oldSessionId || '<旧会话id>'} --confirm`,
      `账本：团队/状态/项目/${projectName}/${ARCHIVE_LEDGER_NAME}`,
    ].join('\n');
    sendMessage({
      from: 'system', to: 'pm', project: projectName, type: 'notice',
      subject: `旧会话归档失败：${row.role}`, body: truncate(body, 560),
    });
    return true;
  } catch { return false; }   // PM 不可达不阻断归档结果落账
}

/**
 * 唯一落账出口：append 账本 + 回填轮换记录 archive 段 + failed 的 stderr/PM 通知（同 oldSessionId 只通知一次）。
 * 返回 { ok, result, ..., ledgerFile, ledgerWritten, rotationPatch, pmNotified }。
 */
function finishArchiveRecord(projectName, role, row) {
  const record = { ...row };
  // 边界·空值：archived/already 的 archiveId 缺失就写 null（字段恒在，不靠缺键表达）
  if ((record.result === 'archived' || record.result === 'already') && record.archiveId === undefined) record.archiveId = null;
  // 去重通知：先看账本里是否已有同一 oldSessionId 的 failed 行（含本次之前的重试），有就不再惊动 PM。
  const alreadyFailed = record.result === 'failed'
    ? readArchiveLedger(projectName).rows.some((r) => String(r.result || '') === 'failed'
      && String(r.oldSessionId || '') === String(record.oldSessionId || ''))
    : false;
  const appended = appendArchiveLedger(projectName, record);
  const rotationPatch = patchRotationArchive(projectName, role, {
    result: record.result,
    at: record.at,
    ...(record.archiveId ? { archiveId: record.archiveId } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
    ...(record.attempts !== undefined ? { attempts: record.attempts } : {}),
  }, { newSessionId: record.newSessionId, oldSessionId: record.oldSessionId });
  let pmNotified = false;
  if (record.result === 'failed') {
    console.error(`[archive] failed role=${role} old=${record.oldSessionId || '-'} reason=${record.reason || record.error || '-'}`);
    if (!alreadyFailed) pmNotified = notifyArchiveFailed(projectName, record);
  }
  return { ok: record.result !== 'failed', ...record, ledgerFile: appended.file, ledgerWritten: appended.ok, rotationPatch, pmNotified };
}

const ARCHIVE_DEFERRABLE = new Set(['TASK_OPEN', 'ROLE_BUSY']);

/**
 * 换人成功后：用「被替换下来的旧 sessionId」归档（不重新推导；不等于当前名册会话才动手）。
 * 返回五态之一：archived / already / deferred / failed / skipped（沙盘 stub 为 stubbed）。
 * 绝不因归档失败阻断换人（调用方在 rotateRoster 成功之后调用）。
 */
export function archiveRotatedSession({
  projectName, role, oldSessionId = '', newSessionId = '', reason = '',
  source = 'session-rotate', auto = true, now = null, skipTranscript = false,
}) {
  const name = String(projectName || '');
  const roleId = String(role || '');
  if (!name) fail('NO_PROJECT', '需要项目名');
  if (!roleId) fail('BAD_ROLE', '需要角色');
  const atMs = nowMsOf(now);
  const at = new Date(atMs).toISOString();
  const oldId = String(oldSessionId || '').trim();
  const newId = String(newSessionId || '').trim();
  const base = { at, project: name, role: roleId, oldSessionId: oldId, newSessionId: newId, source: String(source || ''), auto: Boolean(auto) };
  const current = (() => { try { return currentSessionOf(name, roleId); } catch { return ''; } })();
  if (!oldId) {
    // 边界·空值：oldSessionId 为空 → skipped/unchanged（detail 里注明是缺 id，不伪造来源）
    return finishArchiveRecord(name, roleId, { ...base, result: 'skipped', reason: 'unchanged', detail: 'missing_old_session' });
  }
  if (current && oldId === current) return finishArchiveRecord(name, roleId, { ...base, result: 'skipped', reason: 'unchanged' });
  if (archiveStubEnabled()) return finishArchiveRecord(name, roleId, { ...base, result: 'stubbed', reason: 'selftest_stub' });
  // 幂等：同一 oldSessionId 只写 1 行 archived，后来的记录只写 already。
  const ledger = readArchiveLedger(name);
  const archivedBefore = ledger.rows.find((r) => String(r.result || '') === 'archived' && String(r.oldSessionId || '') === oldId);
  if (archivedBefore) {
    return finishArchiveRecord(name, roleId, { ...base, result: 'already', reason: 'ledger_archived', archiveId: archivedBefore.archiveId || null });
  }
  const why = String(reason || 'rotate-auto');
  try {
    if (takeInjectedArchiveFailure()) {
      throw new TeamError('ARCHIVE_INJECTED_FAIL', '注入失败（AWB_ARCHIVE_FAIL_ONCE）：归档通道模拟异常', { oldSessionId: oldId, role: roleId });
    }
    const r = archiveSession({ projectName: name, role: roleId, sessionId: oldId, reason: why, auto: Boolean(auto), operator: 'system', skipTranscript: Boolean(skipTranscript) });
    // 边界·降级：转录取不到 → 仍 archived（本地记录有效），reason 记 transcript_missing，不判 failed。
    const transcriptMissing = r.record.inputTokens === null || r.record.inputTokens === undefined;
    return finishArchiveRecord(name, roleId, {
      ...base, result: 'archived', reason: transcriptMissing ? 'transcript_missing' : why,
      ...(transcriptMissing ? { rotateReason: why } : {}),
      archiveId: r.record.id, rounds: r.record.rounds,
    });
  } catch (e) {
    const code = String((e && e.code) || '');
    const details = (e && e.details) || {};
    if (ARCHIVE_DEFERRABLE.has(code)) {
      return finishArchiveRecord(name, roleId, {
        ...base, result: 'deferred', reason: code, attempts: 1,
        tasks: Array.isArray(details.tasks) ? details.tasks.slice(0, 20) : [],
        locks: Array.isArray(details.locks) ? details.locks.slice(0, 20) : [],
        deferredUntil: new Date(atMs + ARCHIVE_RETRY_MS).toISOString(),
      });
    }
    if (code === 'ALREADY_ARCHIVED') {
      return finishArchiveRecord(name, roleId, { ...base, result: 'already', reason: 'already_archived', archiveId: details.archiveId || null });
    }
    return finishArchiveRecord(name, roleId, {
      ...base, result: 'failed', reason: code || 'archive_failed',
      error: truncate(String((e && e.message) || e), 300),
    });
  }
}

/**
 * routeTick 每拍补归档：扫账本里「到期且最新一条是 deferred」的行（按角色去重），单拍最多 5 条。
 * 计数口径写死「3 次失败 = 初始 1 + 重试 2」：attempts 1/2 落 deferred，next=3 落 failed(retry_exhausted)。
 * 异常隔离在调用方的 try 内；本函数自身只做账（单条失败不影响其它条）。
 */
export function sweepDeferredArchives({ projectName, now = Date.now(), limit = ARCHIVE_SWEEP_LIMIT } = {}) {
  const name = String(projectName || '');
  if (!name) fail('NO_PROJECT', '需要项目名');
  const atMs = nowMsOf(now);
  const at = new Date(atMs).toISOString();
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : ARCHIVE_SWEEP_LIMIT;
  const ledger = readArchiveLedger(name);
  // 按角色取「整份账本的**最后一行**」：只有最后一行仍是 deferred 的角色才需要补归档。
  // 不能用「最后一条 deferred」——否则该角色后来已 archived/failed，仍会被当成 deferred 永久重试。
  const latestByRole = new Map();
  for (const row of ledger.rows) {
    const role = String(row.role || '');
    if (!role) continue;
    latestByRole.set(role, row);
  }
  const latestDeferred = new Map([...latestByRole.entries()].filter(([, row]) => String(row.result || '') === 'deferred'));
  const matched = [...latestDeferred.values()]
    .filter((row) => {
      const t = Date.parse(String(row.deferredUntil || ''));
      return Number.isFinite(t) && t <= atMs;
    })
    .sort((a, b) => Date.parse(String(a.at || '')) - Date.parse(String(b.at || '')));
  const due = matched.slice(0, max);
  const results = [];
  for (const prev of due) {
    const role = String(prev.role || '');
    const oldId = String(prev.oldSessionId || '').trim();
    const newId = String(prev.newSessionId || '').trim();
    const attempts = Math.max(1, Number(prev.attempts) || 1) + 1;
    const base = { at, project: name, role, oldSessionId: oldId, newSessionId: newId, source: 'sweep', auto: prev.auto !== false };
    const current = (() => { try { return currentSessionOf(name, role); } catch { return ''; } })();
    if (!oldId || (current && oldId === current)) {
      results.push(finishArchiveRecord(name, role, { ...base, result: 'skipped', reason: !oldId ? 'missing_old_session' : 'unchanged', attempts }));
      continue;
    }
    if (archiveStubEnabled()) {
      results.push(finishArchiveRecord(name, role, { ...base, result: 'stubbed', reason: 'selftest_stub', attempts }));
      continue;
    }
    try {
      if (takeInjectedArchiveFailure()) {
        throw new TeamError('ARCHIVE_INJECTED_FAIL', '注入失败（AWB_ARCHIVE_FAIL_ONCE）：归档通道模拟异常', { oldSessionId: oldId, role });
      }
      const r = archiveSession({ projectName: name, role, sessionId: oldId, reason: String(prev.reason || 'rotate-auto'), auto: prev.auto !== false, operator: 'system', skipTranscript: false });
      const transcriptMissing = r.record.inputTokens === null || r.record.inputTokens === undefined;
      results.push(finishArchiveRecord(name, role, {
        ...base, result: 'archived', reason: transcriptMissing ? 'transcript_missing' : 'retry_ok',
        ...(transcriptMissing ? { rotateReason: 'retry_ok' } : {}),
        archiveId: r.record.id, rounds: r.record.rounds, attempts,
      }));
    } catch (e) {
      const code = String((e && e.code) || '');
      const details = (e && e.details) || {};
      if (ARCHIVE_DEFERRABLE.has(code)) {
        if (attempts >= ARCHIVE_MAX_ATTEMPTS) {
          results.push(finishArchiveRecord(name, role, {
            ...base, result: 'failed', reason: 'retry_exhausted', attempts, error: code,
            tasks: Array.isArray(details.tasks) ? details.tasks.slice(0, 20) : [],
          }));
        } else {
          results.push(finishArchiveRecord(name, role, {
            ...base, result: 'deferred', reason: code, attempts,
            tasks: Array.isArray(details.tasks) ? details.tasks.slice(0, 20) : [],
            deferredUntil: new Date(atMs + ARCHIVE_RETRY_MS).toISOString(),
          }));
        }
        continue;
      }
      if (code === 'ALREADY_ARCHIVED') {
        results.push(finishArchiveRecord(name, role, { ...base, result: 'already', reason: 'already_archived', archiveId: details.archiveId || null, attempts }));
        continue;
      }
      results.push(finishArchiveRecord(name, role, {
        ...base, result: 'failed', reason: code || 'archive_failed', attempts,
        error: truncate(String((e && e.message) || e), 300),
      }));
    }
  }
  return { ok: true, project: name, at, scanned: latestDeferred.size, due: matched.length, picked: due.length, processed: results.length, results };
}

/** 面板用：每个角色最近一次 failed（count=该角色历史 failed 行数）；纯读，不写。
 *  注意：唯一实现在 src/session-queue.js → summarizeArchiveFailures（渲染层只读 model）；本文件不再重复实现，
 *  以免两处口径漂移。 */

/**
 * B-20261119-133232-e6c1：归档角色会话后清理「已就绪」派生状态（每步独立 try，失败记 warnings 不阻断归档）。
 * 清：团队.json members[role].sessionId → ''；项目 团队会话.json roles[role].sessionId → ''；
 * workbench.json projects[].sessions[role] + workspace.sessionIds 去掉该会话；工作流 boots[role] 删除 + 该角色旧 boot 令牌文件删除。
 * 审计：状态/项目/<slug>/归档清理.jsonl 追加一行。
 */
export function clearArchivedRoleState(projectName, role, sessionId, archiveId = '') {
  const project = loadProject(projectName);
  const steps = [];
  const warnings = [];
  const guard = (name, fn) => {
    try { const r = fn(); steps.push({ step: name, ok: true, ...(r && typeof r === 'object' ? r : {}) }); return r; }
    catch (e) { warnings.push({ step: name, code: String((e && e.code) || 'CLEANUP_FAILED'), message: String((e && e.message) || e).slice(0, 200) }); return null; }
  };
  const sid = String(sessionId || '');
  // B-196e 附带修（本次实测事故）：只有「归档的就是名册当前会话」时才清该角色的四处映射；
  // 归档的是**旧会话**（角色已在新会话上）时无条件清映射会把在岗会话打空
  // （实测：补归档 programmer1 旧会话后名册/manifest/workbench 全空 → session check 5/6 → 派单被 SESSION_MAP_INCONSISTENT 挡）。
  // 旧会话归档仍要清「workspace.sessionIds 里的该 sid」与「该 sid 自己的 boot 令牌」，只是不动角色绑定。
  const currentSid = (() => { try { return String(currentSessionOf(projectName, role) || ''); } catch { return ''; } })();
  const archivedIsCurrent = !sid ? !currentSid : (!currentSid || sid === currentSid);
  steps.push({
    step: 'scope', ok: true,
    archivedSessionId: sid, currentSessionId: currentSid,
    clearsRoleBinding: archivedIsCurrent,
    note: archivedIsCurrent ? '归档的是当前会话：清角色四处映射' : '归档的是旧会话：只清该会话残留（不动角色绑定）',
  });
  // 1) 名册：清该角色 sessionId（保留成员本身，另由 97db 删除项目/归档团队处理）
  guard('roster', () => {
    if (!archivedIsCurrent) return { changed: false, skipped: 'archived_session_not_current', archivedSessionId: sid, currentSessionId: currentSid };
    const team = loadTeam();
    const member = (team.members || []).find((m) => String(m.role || '') === String(role || ''));
    if (!member) return { changed: false, why: 'member_missing' };
    const before = String(member.sessionId || '');
    if (!before) return { changed: false, why: 'already_empty' };
    setMemberSession(team, role, '', { bootedAt: '', readAt: '' });
    saveTeam(team);
    return { changed: true, before };
  });
  // 2) 项目映射：团队会话.json roles[role]
  guard('manifest', () => {
    if (!archivedIsCurrent) return { changed: false, skipped: 'archived_session_not_current' };
    const file = path.join(project.path, '团队会话.json');
    if (!fs.existsSync(file)) return { changed: false, why: 'missing' };
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const rows = Array.isArray(data.roles) ? data.roles : [];
    const row = rows.find((x) => String((x && x.role) || '') === String(role || ''));
    if (!row) return { changed: false, why: 'role_missing' };
    const before = String(row.sessionId || '');
    Object.assign(row, { sessionId: '', archivedAt: nowIso() });
    writeJsonAtomic(file, data, { allowedRoots: [project.path] });
    return { changed: Boolean(before), before };
  });
  // 3) workbench.json：projects[].sessions[role] + workspace.sessionIds
  guard('workbench', () => {
    const candidates = [
      String(process.env.AWB_STORE || ''),
      process.env.AWB_DATA_DIR ? path.join(String(process.env.AWB_DATA_DIR), 'userdata', 'workbench.json') : '',
      process.env.DSH_PROFILE_DIR ? path.join(String(process.env.DSH_PROFILE_DIR), 'data', 'userdata', 'workbench.json') : '',
      path.join(PATHS.workspace, 'data', 'userdata', 'workbench.json'),
    ].filter(Boolean);
    const names = [project.name, project.teamName].filter(Boolean).map(String);
    const touched = [];
    for (const file of [...new Set(candidates)]) {
      if (!fs.existsSync(file)) continue;
      const store = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      let changed = false;
      for (const row of (Array.isArray(store.projects) ? store.projects : [])) {
        if (!row) continue;
        const rowName = String(row.teamName || row.name || '');
        const same = String(row.id || '') === String(project.id || '') || names.includes(rowName);
        if (!same) continue;
        // 旧会话归档：只动 workspace.sessionIds 里的该 sid，**不动** sessions[role]（否则在岗会话丢失）
        if (archivedIsCurrent && row.sessions && Object.prototype.hasOwnProperty.call(row.sessions, role)) { delete row.sessions[role]; changed = true; }
        if (row.workspace && Array.isArray(row.workspace.sessionIds)) {
          const next = row.workspace.sessionIds.filter((x) => String(x) !== sid);
          if (next.length !== row.workspace.sessionIds.length) { row.workspace.sessionIds = next; changed = true; }
        }
      }
      if (changed) { writeJsonAtomic(file, store); touched.push(file); }
    }
    return { changed: touched.length > 0, files: touched, skipped: archivedIsCurrent ? '' : 'role_binding_kept' };
  });
  // 4) 工作流 boots[role] + 该角色旧 boot 令牌
  guard('boots', () => {
    const wfFile = path.join(projectStatePaths(projectName).dir, '工作流.json');
    let wfChanged = false;
    if (archivedIsCurrent && fs.existsSync(wfFile)) {
      const wf = JSON.parse(fs.readFileSync(wfFile, 'utf8').replace(/^\uFEFF/, ''));
      if (wf && wf.boots && Object.prototype.hasOwnProperty.call(wf.boots, role)) {
        delete wf.boots[role];
        writeJsonAtomic(wfFile, wf);
        wfChanged = true;
      }
    }
    const removedTokens = [];
    try {
      for (const name of fs.readdirSync(PATHS.boots)) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(PATHS.boots, name);
        try {
          const tok = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
          const sameRole = String(tok.role || '') === String(role || '');
          const sameProject = String(tok.project || '') === String(projectName || '');
          // 旧会话归档：只删「令牌会话 == 被归档会话」的那把，绝不删在岗会话的令牌
          const sameSession = !sid || String(tok.sessionId || '') === sid;
          // pm 令牌保留：自归档待 Owner 确认路径仍需同一令牌二次调用（selftest 契约）。
          if (sameRole && sameProject && sameSession && String(role) !== 'pm') { fs.rmSync(file, { force: true }); removedTokens.push(name); }
        } catch { /* 坏令牌跳过 */ }
      }
    } catch { /* 启动目录不存在 */ }
    return { wfChanged, removedTokens, scope: archivedIsCurrent ? 'role' : 'session' };
  });
  // 5) 审计
  guard('audit', () => {
    const file = path.join(projectStatePaths(projectName).dir, '归档清理.jsonl');
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, JSON.stringify({ at: nowIso(), role, sessionId: sid, archiveId, steps, warnings }) + '\n', 'utf8');
    return { file };
  });
  return { ok: warnings.length === 0, role, sessionId: sid, steps, warnings };
}