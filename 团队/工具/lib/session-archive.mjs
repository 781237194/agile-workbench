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
import { nowIso, stamp, ensureDir, fail, truncate, acquireLock, releaseLock, listLocks } from './core.mjs';
import { loadProject, projectStatePaths, listTasks } from './store.mjs';

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

/** 归档：写 会话归档/A-<ts>-<角色>.json（9 字段 + rotatedAt/confirmedAt/frozenAt），轮次归零。 */
export function archiveSession({ projectName, role, reason = '', self = false, auto = false, operator = 'pm', force = false }) {
  if (!role) fail('BAD_ROLE', '需要 --role');
  const project = loadProject(projectName);
  const open = (listTasks(projectName) || []).filter((t) => String(t.owner || '') === role && String(t.status) !== 'done');
  if (open.length) fail('TASK_OPEN', `角色 ${role} 还有 ${open.length} 个未闭环任务，先 done 再归档`, { tasks: open.map((t) => t.id) });
  const locks = (listLocks() || []).filter((l) => String(l.role || '') === role && !l.stale);
  if (locks.length) fail('ROLE_BUSY', `角色 ${role} 持活动锁，先释放再归档`, { locks: locks.map((l) => l.key) });
  const sessionId = currentSessionOf(projectName, role);
  // AC18.8：未确认前不得再次 --self —— 该判定必须先于“重复归档”，否则同一会话会被 ALREADY_ARCHIVED 抢先。
  if (self) {
    const pending = listArchives(projectName).find((a) => a.role === 'pm' && a.self === true && !a.confirmedAt);
    if (pending) fail('OWNER_CONFIRM_REQUIRED', `上一次 PM 自归档待 Owner 确认（${pending.id}），确认前不得再次 --self`, { archiveId: pending.id });
  }
  const dup = listArchives(projectName).find((a) => a.role === role && String(a.sessionId || '') === String(sessionId || ''));
  if (dup && !force) fail('ALREADY_ARCHIVED', `该会话已归档：${dup.id}（如需重归档加 --force）`, { archiveId: dup.id });
  const rounds = readRounds(projectName, role).roundsSinceArchive;
  const inputTokens = latestInputTokens({ projectName, sessionId });
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
  return { ok: true, record, file, decisionLog, project: project.name };
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
