'use strict';
/**
 * lessons.mjs —— 经验教训登记册：解析 / 读记录 / 换人门禁（R-51de 一）
 *
 * 依据：需求/R-20261115-170902-51de-经验教训看板.md（F-1/F-2/F-4/F-5/AC4）+ 增补卷-51de-1.md
 * 边界（写死）：
 *   · 唯一数据源 = 项目根下 `经验教训登记册.md`（只读解析，本模块绝不写该文件）；
 *   · 读记录 append-only 写 `团队/状态/经验教训阅读.jsonl`，同 role+sessionId+fileSha 去重更新 at；
 *   · 门禁只比「该角色最近一条阅读记录的 fileSha」与「当前文件 sha256」，缺失/不等 → LESSONS_UNREAD；
 *   · Owner 通道（channel ∈ {ui,tty} 或 actor=owner）一律豁免，只提示不拦；
 *   · 命中门禁时零副作用（不写任何文件）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** F-2 角色映射（写死，段名 ↔ 角色 id） */
const ROLE_BY_SECTION = {
  项目经理: 'pm',
  产品: 'product',
  需求分析师: 'analyst',
  程序员A: 'programmer1',
  程序员B: 'programmer2',
  测试: 'tester',
};
const SECTION_BY_ROLE = Object.fromEntries(Object.entries(ROLE_BY_SECTION).map(([k, v]) => [v, k]));

const LESSONS_FILE = '经验教训登记册.md';
const READ_LOG = path.join('团队', '状态', '经验教训阅读.jsonl');

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function lessonsPath(projectDir) {
  return path.join(projectDir, LESSONS_FILE);
}

function readLogPath(teamRoot) {
  return path.join(teamRoot, '状态', '经验教训阅读.jsonl');
}

/**
 * F-1 解析器：段=`## <角色名>`；数据行=`^\|\s*2026-`；表头/分隔行忽略；解析不了的行走 parseWarn 不抛。
 * 返回 { sections:[{role,title,rows:[{date,scene,lesson,next,raw}]}], totals, mtime, fileSha, parseWarn, missing, broken }
 */
function parseLessons(mdText, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const result = { sections: [], totals: 0, totalsActive: 0, totalsDeleted: 0, mtime: null, fileSha: null, parseWarn: [], missing: false, broken: false };
  if (typeof mdText !== 'string' || mdText.trim() === '') {
    result.missing = true;
    result.broken = true;
    return result;
  }
  result.fileSha = sha256(mdText);
  const lines = mdText.split(/\r?\n/);
  let current = null;
  let sawKnownSection = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const titleRaw = heading[1].trim();
      const role = ROLE_BY_SECTION[titleRaw] || null;
      if (role) {
        current = { role, title: titleRaw, rows: [] };
        result.sections.push(current);
        sawKnownSection = true;
      } else {
        current = null;
      }
      continue;
    }
    if (!current) continue;
    if (!/^\|\s*2026-/.test(line)) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    // 形如 | 日期 | 场景 | 教训 | 下次怎么做 | → split 后首尾为空串
    const body = cells.slice(1, cells.length - 1);
    if (body.length < 4) {
      result.parseWarn.push({ line: i + 1, reason: 'COLUMNS_LT_4', raw: line });
      continue;
    }
    const [date, scene, lesson, next] = body;
    if (!/^2026-\d{2}-\d{2}$/.test(date)) {
      result.parseWarn.push({ line: i + 1, reason: 'BAD_DATE', raw: line });
      continue;
    }
    // a28a：行尾隐藏注释 `<!-- id:L-YYYYMMDD-<seq> -->`；历史无注释行一律按「无 id」处理（不反推、不补写）
    const idMatch = /<!--\s*id:(L-\d{8}-\d+)\s*-->/.exec(line);
    const deleted = /<!--\s*deleted\s*-->/.test(line);
    current.rows.push({
      date, scene, lesson, next, raw: line,
      id: idMatch ? idMatch[1] : null,
      deleted,
    });
    result.totals += 1;
    if (!deleted) result.totalsActive += 1;
    if (deleted) result.totalsDeleted += 1;
  }
  if (!sawKnownSection) result.broken = true;
  // 缺段不构成损坏（fast 团队可能不在册某些角色），但要在 parseWarn 里留痕
  for (const [section, role] of Object.entries(ROLE_BY_SECTION)) {
    if (!result.sections.some((s) => s.role === role)) result.parseWarn.push({ line: 0, reason: 'MISSING_SECTION', raw: section });
  }
  if (opts.mtime) result.mtime = opts.mtime;
  return result;
}

/** 读文件 + 解析（不抛异常；缺失返回 missing=true） */
function loadLessons(projectDir) {
  const abs = lessonsPath(projectDir);
  try {
    const stat = fs.statSync(abs);
    const text = fs.readFileSync(abs, 'utf8');
    return parseLessons(text, { mtime: stat.mtime.toISOString() });
  } catch {
    return parseLessons('', {});
  }
}

/** F-4 读记录：append 一行；同 role+sessionId+fileSha 已存在 → 只更新 at（不追加行），返回 already_read */
function recordLessonRead(teamRoot, { role, sessionId, fileSha, entries, source }) {
  const abs = readLogPath(teamRoot);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const at = new Date().toISOString();
  const rows = [];
  try {
    for (const line of fs.readFileSync(abs, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* 坏行忽略，不阻断 */ }
    }
  } catch { /* 文件不存在 */ }
  const same = rows.findIndex((row) => row && row.role === role && row.sessionId === sessionId && row.fileSha === fileSha);
  if (same >= 0) {
    rows[same] = { ...rows[same], at, entries: Number(entries) || rows[same].entries || 0, source: source || rows[same].source || 'cli' };
    fs.writeFileSync(abs, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    return { ok: true, alreadyRead: true, action: 'already_read', at, role, fileSha };
  }
  rows.push({ at, role, sessionId, fileSha, entries: Number(entries) || 0, source: source || 'cli' });
  fs.writeFileSync(abs, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  return { ok: true, alreadyRead: false, action: 'recorded', at, role, fileSha };
}

/** 该角色最近一条阅读记录（按 at 倒序取第一条） */
function latestReadRecord(teamRoot, role) {
  const abs = readLogPath(teamRoot);
  let rows = [];
  try {
    rows = fs.readFileSync(abs, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return null; }
  const mine = rows.filter((row) => row && row.role === role).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return mine[0] || null;
}

/**
 * F-5 门禁：比较该角色最近一条阅读记录的 fileSha 与当前文件 sha256。
 * 返回：
 *   { ok:true }                                                  通过
 *   { ok:true, warn:true, code:'LESSONS_FILE_MISSING' }           文件不存在 → **放行**，只提示（B-4875）
 *   { ok:false, code:'LESSONS_UNREAD', staleSha12, currentSha12 } 文件在但该角色没读过当前 sha → 拦
 *   { ok:false, code:'LESSONS_PARSE_BROKEN', parseWarn }           文件在但解析不出角色段 → 拦
 * B-20261116-092803-4875：只有「文件存在但阅读记录 fileSha ≠ 当前 sha」才拦；
 * 新项目/沙盘本来就没有这份登记册，门禁不得因此硬拦 req create/review/派单/验收。
 */
function runLessonGate(role, projectDir, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  // B-20261117-082720-6e7c（同 B-4875 口径）：selftest/沙盘默认豁免经验教训门禁——
  // 沙盘角色从未读过登记册，且自检过程自身会改写登记册（读一次立刻失效），硬拦只会让每次自检先读一次、
  // 并在多轮之间级联红（Electron selftest 第 10-14 轮即此根因）。需要验证门禁本体的测试用
  // TEAM_LESSONS_ENFORCE=1 强制开启（test-lessons-gate.cjs 即如此）。
  const sandbox = String((process.env && process.env.TEAM_SELFTEST) || '') === '1';
  const enforce = String((process.env && process.env.TEAM_LESSONS_ENFORCE) || '') === '1';
  if (sandbox && !enforce) return { ok: true, exempt: true, reason: 'SELFTEST', staleSha12: '', currentSha12: '' };
  const parsed = loadLessons(projectDir);
  // B-20261116-092803-4875：登记册「文件不存在」不再当硬拦（与「文件在但你没读」同档是错的）。
  // 新项目（a28a 之前建的）与沙盘本来就没有这份文件；gate 放行 + warn=true，由 boot 简报/status 给提示。
  if (parsed.missing) {
    return {
      ok: true,
      warn: true,
      missing: true,
      code: 'LESSONS_FILE_MISSING',
      path: lessonsPath(projectDir),
      staleSha12: '',
      currentSha12: '',
      message: `经验教训登记册不存在（${lessonsPath(projectDir)}）：本门禁放行（仅提示），需要时先跑 team.mjs project ensure 生成模板`,
    };
  }
  if (parsed.broken) return { ok: false, code: 'LESSONS_PARSE_BROKEN', message: '经验教训登记册无法解析（缺 `## <角色名>` 段）', parseWarn: parsed.parseWarn.slice(0, 5) };
  const currentSha12 = parsed.fileSha.slice(0, 12);
  const rec = String(opts.teamRoot || '').trim() ? latestReadRecord(opts.teamRoot, role) : null;
  const staleSha12 = rec && rec.fileSha ? String(rec.fileSha).slice(0, 12) : '';
  if (!rec || String(rec.fileSha) !== parsed.fileSha) {
    return {
      ok: false,
      code: 'LESSONS_UNREAD',
      staleSha12,
      currentSha12,
      message: `经验教训登记册（${currentSha12}）还没读过${staleSha12 ? `（上次读的是 ${staleSha12}）` : ''}：先跑 team.mjs lessons read`,
    };
  }
  return { ok: true, staleSha12, currentSha12 };
}

/**
 * Owner 通道豁免（B-20261116-055128-ffe5：豁免不得由调用方自证）。
 * 以前只看 args.channel/args.actor —— 而 args 就是 CLI 实参，任何角色 `--channel ui` 即可绕过 lessons 门禁。
 * 现口径：
 *   ① 可信来源 = 进程注入的 AWB_OWNER_CHANNEL=ui|tty（IPC/终端入口设置，CLI 无法伪造来源）；
 *      或令牌身份 role === 'owner'（boot 令牌校验过的 owner 身份）；
 *   ② 仅当调用方显式声明 channel/actor 但无 AWB_OWNER_CHANNEL 时：不豁免，记审计行（LESSONS_EXEMPT_SELF_CLAIM_DENIED）。
 * `--channel ui` 只是声明，不再等于可信来源。
 */
function isOwnerChannel(args) {
  const src = args && typeof args === 'object' ? args : {};
  const trusted = String(process.env.AWB_OWNER_CHANNEL || '').trim().toLowerCase();
  if (trusted === 'ui' || trusted === 'tty') return true;
  // 令牌身份：extra.role 由 boot 令牌解出（非调用方可自证）
  const role = String(src.role || '').trim().toLowerCase();
  if (role === 'owner') return true;
  const claimed = String(src.channel || src['owner-channel'] || src.actor || '').trim().toLowerCase();
  if (claimed === 'ui' || claimed === 'tty' || claimed === 'owner') {
    // 自证豁免被拒：留痕（不阻断调用方逻辑，但审计可查谁在自证）
    try {
      const audit = path.join(src.teamRoot || process.cwd(), '团队', '状态', '经验教训-自证豁免.jsonl');
      fs.mkdirSync(path.dirname(audit), { recursive: true });
      fs.appendFileSync(audit, JSON.stringify({ at: new Date().toISOString(), role, claimed, note: 'LESSONS_EXEMPT_SELF_CLAIM_DENIED' }) + '\n', 'utf8');
    } catch { /* 审计失败不阻断 */ }
    return false;
  }
  return false;
}

/* ==========================================================================
 * a28a：轮次计数触发 + append / fix / 软删 + 审计（唯一实现）
 * 依据：需求/R-20261116-191847-a28a + 增补卷-a28a-1（§一~§七）+ 增补卷-a28a-2
 * 写死口径：
 *   · 计数文件 `团队/状态/项目/<P>/轮次计数.json` 每角色恰好 5 基础键 + 2 可缺省扩展键；
 *   · 阈值唯一权威 = 项目/<P>/项目.json → config.lessonsTurns（缺省 20，团队共享）；
 *     env 仅在 TEAM_SELFTEST=1 或 AWB_LESSONS_TURNS_FORCE=1 时生效；workbench.json.ui 不读；
 *   · 自增点唯一 = bumpTurns（命令层不得各自加）；失败/幂等/dry-run/只读不计；
 *   · 审计 append-only 固定 7 键；登记册与计数文件各一把 O_EXCL 锁（stale 30s）。
 * ========================================================================== */

const TURNS_FILE = '轮次计数.json';
const AUDIT_REL = path.join('团队', '状态', '经验教训审计.jsonl');
const BROADCAST_REL = path.join('团队', '状态', '经验教训广播.jsonl');
const LOCK_STALE_MS = 30000;
const DEFAULT_TURNS = 20;
const NIGHT_START_HOUR = 22;
const NIGHT_END_HOUR = 8;
const BASE_KEYS = ['turns', 'lastAt', 'sessionId', 'lastNotifiedAt', 'lastNoticeSha', 'lastMaintenanceRounds'];
const EXT_KEYS = ['lastSeenAuditSeq', 'lastSelfWriteAt', 'lastMaintenanceAt'];
const TURN_KEYS = BASE_KEYS.concat(EXT_KEYS);

/** CLI 白名单（7 个 actionType） */
const CLI_ACTIONS = ['send', 'ack', 'task done', 'req review', 'decision answer', 'proxy accept', 'lessons append'];
/** 壳层白名单（3 类动作，对应 4 个 IPC 名） */
const SHELL_ACTIONS = ['owner:decide', 'owner:accept', 'task:accept', 'owner:decision-ack'];
const COUNTED_ACTIONS = CLI_ACTIONS.concat(SHELL_ACTIONS);
/** 只读 / 永不计数的命令（负向断言用） */
const READONLY_ACTIONS = ['read', 'boot', 'status', 'project list', 'lessons read', 'lessons status', 'lessons turns'];

function isCountedAction(actionType) {
  return COUNTED_ACTIONS.indexOf(String(actionType || '').trim()) >= 0;
}

/* ---------- 时间源（AWB_NOW 注入，AC4 唯一注入方式） ---------- */

function parseAwbNow() {
  const raw = String((typeof process !== 'undefined' && process.env && process.env.AWB_NOW) || '').trim();
  if (!raw) {
    const d = new Date();
    return { ok: true, source: 'system', at: d, localHour: d.getHours(), localMinute: d.getMinutes(), literal: null };
  }
  // 必须带时区偏移（Z 或 ±HH:MM）；无偏移或非法 → BAD_TIME_FORMAT 回落系统时间
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(raw);
  const d = m ? new Date(raw) : null;
  if (!m || !d || Number.isNaN(d.getTime())) {
    console.log('[lessons] bad AWB_NOW: ' + raw);
    const sys = new Date();
    return { ok: false, code: 'BAD_TIME_FORMAT', source: 'system', at: sys, localHour: sys.getHours(), localMinute: sys.getMinutes(), literal: null };
  }
  // 本地小时直接取字面量（AWB_NOW 的字面时间即该时区的本地时间）
  return { ok: true, source: 'env', at: d, localHour: Number(m[4]), localMinute: Number(m[5]), literal: raw };
}

function isNightHour(hour) {
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

/** 既有 60 秒 tick 的周期（lessons 不新增独立定时器） */
function lessonsTickMs() {
  const raw = String((typeof process !== 'undefined' && process.env && process.env.AWB_LESSONS_TICK_MS) || '').trim();
  if (!raw) return 60000;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) {
    console.log('[lessons] bad tick: ' + raw);
    return 60000;
  }
  return n;
}

/** 阈值解析：env 仅 SELFTEST/FORCE 时生效；否则项目配置；再否则缺省 20 */
function resolveLessonsTurns(configPath) {
  const envRaw = String((typeof process !== 'undefined' && process.env && process.env.AWB_LESSONS_TURNS) || '').trim();
  const envAllowed = String((process.env && process.env.TEAM_SELFTEST) || '') === '1'
    || String((process.env && process.env.AWB_LESSONS_TURNS_FORCE) || '') === '1';
  if (envAllowed && envRaw) {
    const n = Math.floor(Number(envRaw));
    if (Number.isFinite(n) && n >= 1) return { value: n, source: 'env' };
  }
  if (configPath) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const n = Math.floor(Number(cfg && cfg.config && cfg.config.lessonsTurns));
      if (Number.isFinite(n) && n >= 1) return { value: n, source: 'project' };
    } catch { /* 文件缺失/坏 → 缺省 */ }
  }
  return { value: DEFAULT_TURNS, source: 'default' };
}

/* ---------- 锁与原子写 ---------- */

function withFileLock(targetAbs, fn) {
  const lockAbs = targetAbs + '.lock';
  fs.mkdirSync(path.dirname(lockAbs), { recursive: true });
  const tryAcquire = () => {
    try {
      const fd = fs.openSync(lockAbs, 'wx');
      fs.writeSync(fd, JSON.stringify({ at: new Date().toISOString(), pid: process.pid }));
      fs.closeSync(fd);
      return { ok: true };
    } catch (e) {
      if (e && e.code !== 'EEXIST') return { ok: false, code: 'LESSONS_WRITE_FAILED', error: String((e && e.message) || e) };
      let age = Infinity;
      try { age = Date.now() - fs.statSync(lockAbs).mtimeMs; } catch { age = Infinity; }
      if (age >= LOCK_STALE_MS) {
        try { fs.unlinkSync(lockAbs); } catch { /* ignore */ }
        return { ok: false, stale: true };
      }
      return { ok: false, code: 'LESSONS_CONFLICT', lockHeld: true };
    }
  };
  let r = tryAcquire();
  let tookStale = false;
  if (!r.ok && r.stale) { tookStale = true; r = tryAcquire(); }   // 接管 stale 后只重试一次
  if (!r.ok) return { ok: false, code: r.code || 'LESSONS_CONFLICT', lockHeld: true, tookStale };
  try {
    const v = fn();
    if (v && typeof v === 'object') v.tookStale = tookStale;
    return v;
  } finally {
    try { fs.unlinkSync(lockAbs); } catch { /* ignore */ }
  }
}

function readJsonFile(abs) {
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(abs, 'utf8')) };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, data: null, missing: true };
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------- 轮次计数文件 ---------- */

function turnsPathFor(stateDir) {
  return path.join(stateDir, TURNS_FILE);
}

function normalizeRoleEntry(prev, sessionId, atIso, opts) {
  const src = prev && typeof prev === 'object' ? prev : {};
  const reset = !!(opts && opts.reset);
  const entry = {
    turns: reset ? 0 : (Number.isFinite(Number(src.turns)) ? Math.max(0, Math.floor(Number(src.turns))) : 0),
    lastAt: atIso,
    sessionId: sessionId == null ? '' : String(sessionId),
    lastNotifiedAt: reset || src.lastNotifiedAt == null ? null : String(src.lastNotifiedAt),
    lastNoticeSha: reset || src.lastNoticeSha == null ? null : String(src.lastNoticeSha),
    lastSeenAuditSeq: (!reset && Number.isFinite(Number(src.lastSeenAuditSeq))) ? Math.floor(Number(src.lastSeenAuditSeq)) : null,
    lastSelfWriteAt: (!reset && src.lastSelfWriteAt != null) ? String(src.lastSelfWriteAt) : null,
    // R-cfca：维护提醒幂等键（同一 turns 只发一次）与最近一次发送时间；换人 reset 时清空。
    lastMaintenanceRounds: (!reset && Number.isFinite(Number(src.lastMaintenanceRounds))) ? Math.floor(Number(src.lastMaintenanceRounds)) : null,
    lastMaintenanceAt: (!reset && src.lastMaintenanceAt != null) ? String(src.lastMaintenanceAt) : null,
  };
  return entry;
}

function readTurnsRaw(stateDir) {
  const abs = turnsPathFor(stateDir);
  const r = readJsonFile(abs);
  if (!r.ok) return { ok: false, abs, code: 'LESSONS_TURNS_BROKEN', error: r.error };
  const data = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : { version: 1, roles: {} };
  if (!data.roles || typeof data.roles !== 'object' || Array.isArray(data.roles)) data.roles = {};
  return { ok: true, abs, data, missing: !!r.missing };
}

function writeTurnsRaw(stateDir, data) {
  const abs = turnsPathFor(stateDir);
  return withFileLock(abs, () => {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = abs + '.tmp-' + process.pid + '-' + Date.now();
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, abs);
      return { ok: true, abs };
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      return { ok: false, code: 'LESSONS_WRITE_FAILED', error: String((e && e.message) || e) };
    }
  });
}

/* ---------- 审计（append-only，固定 7 键） ---------- */

function auditPathFor(teamRoot) { return path.join(teamRoot, '状态', '经验教训审计.jsonl'); }

function readAudit(teamRoot) {
  const abs = auditPathFor(teamRoot);
  const rows = [];
  try {
    for (const line of fs.readFileSync(abs, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* 坏行忽略 */ }
    }
  } catch { /* 文件不存在 */ }
  return rows;
}

function auditSeq(teamRoot) {
  try { return fs.readFileSync(auditPathFor(teamRoot), 'utf8').split(/\r?\n/).filter((l) => l.trim()).length; } catch { return 0; }
}

/** 审计写失败 → 调用方回滚并报 LESSONS_AUDIT_FAILED */
function writeAudit(teamRoot, row) {
  const abs = auditPathFor(teamRoot);
  const rec = {
    at: row && row.at ? String(row.at) : new Date().toISOString(),
    role: row && row.role != null ? String(row.role) : '',
    action: row && row.action != null ? String(row.action) : '',
    id: row && row.id != null ? String(row.id) : '',
    before: row && Object.prototype.hasOwnProperty.call(row, 'before') ? row.before : null,
    after: row && Object.prototype.hasOwnProperty.call(row, 'after') ? row.after : null,
    reason: row && row.reason != null ? String(row.reason) : '',
  };
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const before = auditSeq(teamRoot);
    fs.appendFileSync(abs, JSON.stringify(rec) + '\n', 'utf8');
    return { ok: true, at: rec.at, seq: before + 1 };
  } catch (e) {
    return { ok: false, code: 'LESSONS_AUDIT_FAILED', error: String((e && e.message) || e) };
  }
}

/** 审计回滚（仅内部：登记册写失败时把最后一行去掉） */
function rollbackAudit(teamRoot) {
  const abs = auditPathFor(teamRoot);
  try {
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.pop();
    fs.writeFileSync(abs, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
    return { ok: true };
  } catch { return { ok: false }; }
}

/** 「已更正 N 条 / 已删除 N 条」= 审计按 id 去重计数 */
function auditStats(teamRoot) {
  const rows = readAudit(teamRoot);
  const fixed = new Set();
  const deleted = new Set();
  for (const row of rows) {
    if (!row || !row.id) continue;
    if (row.action === 'fix') fixed.add(String(row.id));
    else if (row.action === 'delete') deleted.add(String(row.id));
  }
  return { fixed: fixed.size, deleted: deleted.size, rows: rows.length };
}

/** 已删除条目：恰好 5 键 {id,date,deletedAt,by,text} */
function readDeletedEntries(projectDir, teamRoot) {
  const parsed = loadLessons(projectDir);
  if (parsed.missing || parsed.broken) return [];
  const audits = readAudit(teamRoot);
  const byId = new Map();
  for (const row of audits) {
    if (row && row.action === 'delete' && row.id) byId.set(String(row.id), row);
  }
  const out = [];
  for (const section of parsed.sections) {
    for (const r of section.rows) {
      if (!r.deleted) continue;
      const a = r.id ? byId.get(r.id) : null;
      out.push({
        id: r.id || '',
        date: r.date,
        deletedAt: a ? String(a.at) : '',
        by: a ? String(a.role) : '',
        text: r.lesson,
      });
    }
  }
  return out;
}

/* ---------- 广播 jsonl ---------- */

function broadcastPathFor(teamRoot) { return path.join(teamRoot, '状态', '经验教训广播.jsonl'); }

function writeBroadcast(teamRoot, row) {
  const abs = broadcastPathFor(teamRoot);
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, JSON.stringify(row) + '\n', 'utf8');
    return { ok: true, at: row.at };
  } catch (e) {
    console.log('[lessons] broadcast write failed: ' + String((e && e.message) || e));
    return { ok: false };
  }
}

function readBroadcast(teamRoot) {
  const abs = broadcastPathFor(teamRoot);
  const rows = [];
  try {
    for (const line of fs.readFileSync(abs, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* ignore */ }
    }
  } catch { /* missing */ }
  return rows;
}

/* ---------- 计数自增（唯一自增点） ---------- */

let businessCommitId = null;
const bumpSeen = new Set();

function beginBusinessCommit(id) {
  businessCommitId = String(id || ('c-' + process.pid + '-' + Date.now()));
  return businessCommitId;
}

function currentCommitId() {
  if (!businessCommitId) beginBusinessCommit();
  return businessCommitId;
}

const ROLE_SUFFIX = { pm: '（PM 自己触发不自收，只记 jsonl）' };

/**
 * 计数自增（唯一入口）。必须在主事务**写盘成功之后**调用。
 * 返回 { ok, turns, threshold, source, prompt:{action,reason,...} }
 */
function bumpTurns(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const stateDir = String(o.stateDir || '');
  const teamRoot = String(o.teamRoot || '');
  const role = String(o.role || '');
  const actionType = String(o.actionType || '').trim();
  if (!stateDir || !teamRoot || !role) return { ok: false, code: 'LESSONS_BUMP_BAD_ARGS' };
  if (!isCountedAction(actionType)) return { ok: true, skipped: true, reason: 'not_counted', actionType };
  const commit = String(o.commitId || currentCommitId());
  const dedupeKey = commit + '|' + role + '|' + actionType;
  if (bumpSeen.has(dedupeKey)) return { ok: true, skipped: true, reason: 'duplicate_commit', actionType };
  bumpSeen.add(dedupeKey);

  const now = o.now && o.now.at ? o.now : parseAwbNow();
  const atIso = now.at.toISOString();
  const threshold = resolveLessonsTurns(o.configPath);

  const read = readTurnsRaw(stateDir);
  if (!read.ok) {
    // 计数文件损坏 → 备份后重建为 0 并告警（不阻断主命令）
    try { fs.copyFileSync(read.abs, read.abs + '.broken-' + Date.now()); } catch { /* ignore */ }
    read.data = { version: 1, project: o.projectName || '', roles: {} };
  }
  const data = read.data;
  if (!data.version) data.version = 1;
  if (o.projectName) data.project = String(o.projectName);
  const prev = data.roles[role] || null;
  const sessionChanged = !!prev && String(prev.sessionId || '') !== String(o.sessionId || '');
  const entry = normalizeRoleEntry(prev, o.sessionId, atIso, { reset: sessionChanged });
  entry.turns = (sessionChanged ? 0 : entry.turns) + 1;
  data.roles[role] = entry;

  const wrote = writeTurnsRaw(stateDir, data);
  if (!wrote.ok) {
    console.log('[lessons] turns_bump_failed role=' + role + ' action=' + actionType + ' err=' + (wrote.error || wrote.code));
    return { ok: false, code: 'LESSONS_WRITE_FAILED', softFail: true, turns: entry.turns, threshold: threshold.value };
  }
  if (sessionChanged) {
    writeAudit(teamRoot, { at: atIso, role, action: 'reset', id: '', before: prev ? prev.turns : null, after: 0, reason: 'session_changed' });
  }

  const prompt = promptIfDue({
    stateDir, teamRoot, role, entry, threshold, now, atIso,
    projectName: o.projectName, sendNotice: o.sendNotice, skipCount: false,
    parsed: o.parsed || (o.projectDir ? loadLessons(o.projectDir) : null),
  });
  return {
    ok: true, role, actionType, turns: entry.turns, threshold: threshold.value, thresholdSource: threshold.source,
    sessionChanged, prompt,
  };
}

/**
 * 达阈值判定 + 提示（有变更才发 / 夜间静默 / 沙盘不发 / pm 不自收 / 同轮一次）。
 * 不改 turns 之外的内容由 bumpTurns 负责；本函数只读 entry 并在必要时清零 turns。
 */
function promptIfDue(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const { stateDir, teamRoot, role, entry, threshold, now, atIso } = o;
  if (!entry || !threshold) return { action: 'none' };
  // R-cfca 契约 6.2：严格大于阈值才触发（turns=20 不发、21 才发）。
  if (!(entry.turns > threshold.value)) return { action: 'none', turns: entry.turns, threshold: threshold.value };
  // 幂等键 role + turns：同一 turns 只发一次（不改用「人工注回」验）。
  if (Number(entry.lastMaintenanceRounds) === Number(entry.turns)) return { action: 'none', reason: 'same_round', turns: entry.turns, threshold: threshold.value };

  const parsed = o.parsed || null;
  const auditRows = readAudit(teamRoot);
  const auditCount = auditRows.length;

  // 「有变更才发」：主判据 = 登记册 sha ≠ lastNoticeSha；不可读时退化审计行数
  let changed = false;
  let currentSha = null;
  if (parsed && !parsed.missing && !parsed.broken && parsed.fileSha) {
    currentSha = parsed.fileSha;
    changed = String(currentSha) !== String(entry.lastNoticeSha || '');
  } else {
    changed = auditCount > (Number.isFinite(Number(entry.lastSeenAuditSeq)) ? Number(entry.lastSeenAuditSeq) : 0);
  }

  const finished = (action, reason, extra) => {
    // R-cfca：轮次语义改**累计**（发后不归零）；prompt 时写幂等键 lastMaintenanceRounds。
    entry.lastAt = atIso;
    if (action === 'prompt') {
      entry.lastNotifiedAt = atIso;
      entry.lastMaintenanceRounds = Number(entry.turns) || 0;
      entry.lastMaintenanceAt = atIso;
      if (currentSha) entry.lastNoticeSha = currentSha;
      entry.lastSeenAuditSeq = auditCount;
    }
    const data = readTurnsRaw(stateDir);
    if (data.ok) {
      data.data.roles = data.data.roles || {};
      data.data.roles[role] = entry;
      writeTurnsRaw(stateDir, data.data);
    }
    writeBroadcast(teamRoot, Object.assign({ at: atIso, role, turns: opts.beforeTurns != null ? opts.beforeTurns : entry.turns, action, reason: reason || '' }, extra || {}));
    return Object.assign({ action, reason: reason || '' }, extra || {});
  };

  const beforeTurns = entry.turns;

  if (!changed) {
    // 唯一优先级：① 本角色自上次提醒后写过（含同一时刻，注入时钟下会相等）→ already_recorded；② 否则 no_content
    const lastNotified = entry.lastNotifiedAt ? Date.parse(entry.lastNotifiedAt) : 0;
    const lastSelfWrite = entry.lastSelfWriteAt ? Date.parse(entry.lastSelfWriteAt) : 0;
    const wroteSince = !!entry.lastSelfWriteAt && lastSelfWrite >= lastNotified;
    const reason = wroteSince ? 'already_recorded' : 'no_content';
    return finished('skip', reason, { turns: beforeTurns });
  }

  // 沙盘免打扰：真实邮箱 0 新增，行内记 suppressed='sandbox'
  const sandbox = String((process.env && process.env.TEAM_SELFTEST) || '') === '1';
  if (sandbox) {
    const r = finished('prompt', 'sandbox', { turns: beforeTurns, to: role, delivered: false, suppressed: 'sandbox' });
    return r;
  }

  const sha12 = currentSha ? String(currentSha).slice(0, 12) : '—';
  // R-cfca 6.1：一条消息两问两命令，按 600 字预算写（超长会被 MESSAGE_TOO_LONG 拦）。
  const bodyLines = [
    `【维护提醒】${role} 已完成 ${beforeTurns} 轮动作（阈值 ${threshold.value}），登记册（${sha12}）有更新。这一次一起处理两件事：`,
    '1) skill：要不要把本轮做法建/更新成 skill？要就说明场景与步骤；不要就跑：team.mjs skill skip --reason "已评估"',
    '2) 经验教训：跑 `team.mjs lessons read` 读一遍，再用 `team.mjs lessons append --scene … --lesson … --next …` 记一条。',
    '两个都处理完，提醒才会停；只做一件时，另一件下轮继续提醒（同一轮只发这一条）。',
  ].filter(Boolean);

  let delivered = false;
  let messageId = '';
  let wakeError = '';
  const sendNotice = typeof o.sendNotice === 'function' ? o.sendNotice : null;
  const isPm = role === 'pm';
  if (sendNotice && !isPm) {
    try {
      const sent = sendNotice({
        to: role,
        subject: `维护提醒：skill 与经验教训（第 ${beforeTurns} 轮）`,
        body: bodyLines.join('\n'),
        wake: true,
        senderKind: 'program',
        type: 'maintenance_prompt',
        ackRequired: false,
      });
      if (sent && sent.ok) { delivered = true; messageId = sent.messageId || ''; if (sent.wakeError) wakeError = String(sent.wakeError); }
      else if (sent && sent.error) wakeError = String(sent.error);
    } catch (e) {
      wakeError = String((e && e.message) || e);
    }
  }
  const extra = { turns: beforeTurns, to: isPm ? 'pm' : role, delivered, messageId };
  if (isPm) extra.reason = 'self_no_delivery';
  if (wakeError) extra.wakeError = wakeError;
  const r = finished('prompt', isPm ? 'self_no_delivery' : '', extra);
  return r;
}

/* ---------- append / fix / 软删 ---------- */

function formatDateOnly(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function sectionRange(lines, role) {
  const title = SECTION_BY_ROLE[role];
  if (!title) return null;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (m && m[1].trim() === title) { start = i; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

function maxSeqForToday(lines, dateStr) {
  const re = new RegExp('<!--\\s*id:L-' + dateStr.replace(/-/g, '') + '-(\\d+)\\s*-->', 'g');
  let max = 0;
  for (const line of lines) {
    re.lastIndex = 0;
    let m = re.exec(line);
    while (m) { max = Math.max(max, Number(m[1]) || 0); m = re.exec(line); }
  }
  return max;
}

function readLessonsText(projectDir) {
  const abs = lessonsPath(projectDir);
  try { return { ok: true, abs, text: fs.readFileSync(abs, 'utf8') }; } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, code: 'LESSONS_FILE_MISSING', abs };
    return { ok: false, code: 'LESSONS_FILE_MISSING', abs, error: String((e && e.message) || e) };
  }
}

/**
 * 写登记册（锁内 tmp+rename）。审计先行，登记册写失败则回滚审计行。
 * 返回 { ok, id, before, after } 或 { ok:false, code }
 */
function commitLessonsChange(projectDir, teamRoot, role, action, mutate) {
  const abs = lessonsPath(projectDir);
  return withFileLock(abs, () => {
    const cur = readLessonsText(projectDir);
    if (!cur.ok) return { ok: false, code: cur.code };
    const lines = cur.text.split(/\r?\n/);
    const parsed = parseLessons(cur.text, {});
    if (parsed.broken) return { ok: false, code: 'LESSONS_PARSE_BROKEN' };
    const plan = mutate({ lines, parsed });
    if (!plan || plan.ok === false) return plan || { ok: false, code: 'LESSONS_WRITE_FAILED' };
    const atIso = (plan.at instanceof Date ? plan.at : parseAwbNow().at).toISOString();
    // B-20261117-082019-db25：同内容不重复入册——不写审计、不改文件（文件 sha 自然不变），只返回 skipped 计数。
    if (plan.noop === true) {
      return { ok: true, id: plan.id || '', noop: true, skipped: true, at: atIso, fileSha: sha256(cur.text), before: null, after: plan.after || null };
    }
    // 1) 审计先行
    const audit = writeAudit(teamRoot, { at: atIso, role, action, id: plan.id || '', before: plan.before == null ? null : plan.before, after: plan.after == null ? null : plan.after, reason: plan.reason || '' });
    if (!audit.ok) return { ok: false, code: 'LESSONS_AUDIT_FAILED' };
    // 2) 登记册落盘
    const nextText = plan.lines.join('\n');
    const tmp = abs + '.tmp-' + process.pid + '-' + Date.now();
    try {
      fs.writeFileSync(tmp, nextText, 'utf8');
      fs.renameSync(tmp, abs);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      rollbackAudit(teamRoot);
      return { ok: false, code: 'LESSONS_WRITE_FAILED', error: String((e && e.message) || e) };
    }
    return { ok: true, id: plan.id || '', before: plan.before, after: plan.after, at: atIso, fileSha: sha256(nextText) };
  });
}

/** F6 追加：只写自己段、自动编号 L-YYYYMMDD-<seq> */
function appendLesson(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const role = String(o.role || '');
  const scene = String(o.scene == null ? '' : o.scene).trim();
  const lessonText = String(o.lesson == null ? '' : o.lesson).trim();
  const nextText = String(o.next == null ? '' : o.next).trim();
  if (!scene || !lessonText || !nextText) return { ok: false, code: 'LESSONS_FIELD_REQUIRED' };
  if (!SECTION_BY_ROLE[role]) return { ok: false, code: 'LESSONS_ROLE_FORBIDDEN' };
  return commitLessonsChange(o.projectDir, o.teamRoot, role, 'append', ({ lines }) => {
    const range = sectionRange(lines, role);
    if (!range) return { ok: false, code: 'LESSONS_SECTION_MISSING' };
    const now = parseAwbNow();
    const dateStr = formatDateOnly(now.at);
    // B-20261117-082019-db25：append 前按「规范化文本」去重（同一角色段内 scene/lesson/next 三格规范化后相同即视为重复）。
    // 规范化＝去首尾空白 + 连续空白折叠 + 去掉单元格里转义出来的 \\|，避免「多一个空格就重复入册」。
    const norm = (v) => String(v == null ? '' : v).replace(/\\\|/g, '|').replace(/\s+/g, ' ').trim();
    const wanted = [norm(scene), norm(lessonText), norm(nextText)].join('\u0001');
    for (let i = range.start + 1; i < range.end; i += 1) {
      const line = String(lines[i] || '');
      if (!/^\s*\|/.test(line)) continue;
      const cells = line.split('|').map((c) => c.trim());
      // 表格行：'' | 日期 | 场景 | 教训 | 下一步 | <!-- id:... --> | ''
      if (cells.length < 6) continue;
      const body = cells.slice(2, 5);
      if (body.some((c) => /^-+$/.test(c))) continue; // 表头分隔行
      const existing = body.map(norm).join('\u0001');
      if (existing === wanted) {
        const idMatch = /<!--\s*id:(L-\d{8}-\d+)\s*-->/.exec(line);
        return {
          ok: true, noop: true, id: idMatch ? idMatch[1] : '',
          after: { date: cells[1] || '', scene, lesson: lessonText, next: nextText },
          lines, at: now.at,
        };
      }
    }
    const seq = maxSeqForToday(lines, dateStr) + 1;
    const id = `L-${dateStr.replace(/-/g, '')}-${seq}`;
    const row = `| ${dateStr} | ${scene} | ${lessonText} | ${nextText} | <!-- id:${id} -->`;
    let insertAt = range.end;
    while (insertAt > range.start + 1 && !String(lines[insertAt - 1] || '').trim()) insertAt -= 1;
    lines.splice(insertAt, 0, row);
    return { ok: true, id, before: null, after: { date: dateStr, scene, lesson: lessonText, next: nextText }, lines, at: now.at };
  });
}

/** F7 更正 / 软删（只能动自己段） */
function fixLesson(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const role = String(o.role || '');
  const id = String(o.id || '').trim();
  if (!id) return { ok: false, code: 'LESSONS_ID_REQUIRED' };
  if (!/^L-\d{8}-\d+$/.test(id)) return { ok: false, code: 'LESSONS_ID_INVALID' };
  if (!SECTION_BY_ROLE[role]) return { ok: false, code: 'LESSONS_ROLE_FORBIDDEN' };
  const isDelete = !!o.delete;
  if (isDelete && !String(o.reason == null ? '' : o.reason).trim()) return { ok: false, code: 'LESSONS_REASON_REQUIRED' };
  return commitLessonsChange(o.projectDir, o.teamRoot, role, isDelete ? 'delete' : 'fix', ({ lines, parsed }) => {
    const range = sectionRange(lines, role);
    if (!range) return { ok: false, code: 'LESSONS_SECTION_MISSING' };
    // 找带该 id 的行（历史无 id 行不认）
    let lineNo = -1;
    for (let i = range.start + 1; i < range.end; i += 1) {
      if (new RegExp('<!--\\s*id:' + id + '\\s*-->').test(lines[i])) { lineNo = i; break; }
    }
    if (lineNo < 0) {
      // 全局再找一次：命中别的段 → ROLE_FORBIDDEN（越权），否则 ID_NOT_FOUND
      for (let i = 0; i < lines.length; i += 1) {
        if (new RegExp('<!--\\s*id:' + id + '\\s*-->').test(lines[i])) return { ok: false, code: 'LESSONS_ROLE_FORBIDDEN' };
      }
      return { ok: false, code: 'LESSONS_ID_NOT_FOUND' };
    }
    const cells = lines[lineNo].split('|').map((c) => c.trim());
    const body = cells.slice(1, cells.length - 1);
    const before = { date: body[0] || '', scene: body[1] || '', lesson: body[2] || '', next: body[3] || '' };
    if (isDelete) {
      if (/<!--\s*deleted\s*-->/.test(lines[lineNo])) return { ok: false, code: 'LESSONS_ALREADY_DELETED' };
      lines[lineNo] = lines[lineNo].replace(/\s*$/, '') + ' <!-- deleted -->';
      return { ok: true, id, before, after: before, reason: String(o.reason).trim(), lines, at: parseAwbNow().at };
    }
    const scene = o.scene != null ? String(o.scene).trim() : before.scene;
    const lessonText = o.text != null ? String(o.text).trim() : before.lesson;
    const nextText = o.next != null ? String(o.next).trim() : before.next;
    if (!scene || !lessonText || !nextText) return { ok: false, code: 'LESSONS_FIELD_REQUIRED' };
    const deletedTail = /<!--\s*deleted\s*-->/.test(lines[lineNo]) ? ' <!-- deleted -->' : '';
    lines[lineNo] = `| ${before.date} | ${scene} | ${lessonText} | ${nextText} | <!-- id:${id} -->${deletedTail}`;
    return { ok: true, id, before, after: { date: before.date, scene, lesson: lessonText, next: nextText }, lines, at: parseAwbNow().at };
  });
}

/** 自写后刷新基线（§二.5）：lastNoticeSha = 当前登记册 sha，lastSelfWriteAt = 同一时刻 */
function markSelfWrite(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const stateDir = String(o.stateDir || '');
  const role = String(o.role || '');
  if (!stateDir || !role) return { ok: false };
  const now = o.now && o.now.at ? o.now : parseAwbNow();
  const atIso = now.at.toISOString();
  const parsed = o.fileSha ? { fileSha: o.fileSha } : loadLessons(o.projectDir);
  const data = readTurnsRaw(stateDir);
  if (!data.ok) return { ok: false, code: 'LESSONS_TURNS_BROKEN' };
  const prev = data.data.roles[role] || null;
  const entry = normalizeRoleEntry(prev, o.sessionId, atIso, { reset: false });
  if (prev && Number.isFinite(Number(prev.turns))) entry.turns = Math.max(0, Math.floor(Number(prev.turns)));
  entry.lastNoticeSha = parsed && parsed.fileSha ? parsed.fileSha : (prev ? prev.lastNoticeSha : null);
  entry.lastSelfWriteAt = atIso;
  data.data.roles[role] = entry;
  const wrote = writeTurnsRaw(stateDir, data.data);
  if (!wrote.ok) console.log('[lessons] lessons_mark_failed role=' + role);
  return { ok: wrote.ok, entry };
}

/** 读某角色轮次（含 sessionId 变更即清 0 + 审计 reset） */
function readRoleTurns(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const stateDir = String(o.stateDir || '');
  const role = String(o.role || '');
  const threshold = resolveLessonsTurns(o.configPath);
  const data = readTurnsRaw(stateDir);
  if (!data.ok) return { ok: false, code: 'LESSONS_TURNS_BROKEN', threshold: threshold.value, source: threshold.source };
  const prev = data.data.roles[role] || null;
  if (!prev) return { ok: true, role, entry: null, threshold: threshold.value, source: threshold.source, reset: false };
  const mismatch = String(prev.sessionId || '') !== String(o.sessionId || '');
  if (!mismatch || !o.applyReset) return { ok: true, role, entry: prev, threshold: threshold.value, source: threshold.source, reset: false };
  const atIso = parseAwbNow().at.toISOString();
  const entry = normalizeRoleEntry(prev, o.sessionId, atIso, { reset: true });
  data.data.roles[role] = entry;
  writeTurnsRaw(stateDir, data.data);
  writeAudit(o.teamRoot, { at: atIso, role, action: 'reset', id: '', before: prev.turns, after: 0, reason: 'session_changed' });
  return { ok: true, role, entry, threshold: threshold.value, source: threshold.source, reset: true };
}

/** 全部角色的轮次快照（`lessons turns` / status 末行 / 看板 IPC 共用，同一实现） */
function readAllTurns(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const stateDir = String(o.stateDir || '');
  const threshold = resolveLessonsTurns(o.configPath);
  const data = readTurnsRaw(stateDir);
  const missing = !data.ok || !!data.missing;
  const roles = {};
  const roleIds = Array.isArray(o.roleIds) && o.roleIds.length ? o.roleIds : Object.keys(SECTION_BY_ROLE);
  for (const role of roleIds) {
    const entry = data.ok ? (data.data.roles[role] || null) : null;
    roles[role] = entry ? {
      turns: Number.isFinite(Number(entry.turns)) ? Math.floor(Number(entry.turns)) : null,
      lastAt: entry.lastAt || null,
      lastNotifiedAt: entry.lastNotifiedAt || null,
      lastNoticeSha: entry.lastNoticeSha || null,
      lastSeenAuditSeq: entry.lastSeenAuditSeq == null ? null : entry.lastSeenAuditSeq,
      lastSelfWriteAt: entry.lastSelfWriteAt || null,
      sessionId: entry.sessionId || '',
      // R-cfca 6.7：轮次改累计后，距下次 = 阈值 −（turns − 上次维护轮次）。
      nextInTurns: entry && Number.isFinite(Number(entry.turns))
        ? Math.max(0, threshold.value - (Math.floor(Number(entry.turns)) - (Number.isFinite(Number(entry.lastMaintenanceRounds)) ? Math.floor(Number(entry.lastMaintenanceRounds)) : 0)))
        : null,
    } : null;
  }
  return { ok: true, threshold: threshold.value, source: threshold.source, missing, roles, tickMs: lessonsTickMs() };
}

export {
  ROLE_BY_SECTION,
  SECTION_BY_ROLE,
  LESSONS_FILE,
  READ_LOG,
  parseLessons,
  loadLessons,
  recordLessonRead,
  latestReadRecord,
  runLessonGate,
  isOwnerChannel,
  sha256,
  // a28a
  TURNS_FILE,
  AUDIT_REL,
  BROADCAST_REL,
  LOCK_STALE_MS,
  DEFAULT_TURNS,
  BASE_KEYS,
  EXT_KEYS,
  TURN_KEYS,
  CLI_ACTIONS,
  SHELL_ACTIONS,
  COUNTED_ACTIONS,
  READONLY_ACTIONS,
  isCountedAction,
  parseAwbNow,
  isNightHour,
  lessonsTickMs,
  resolveLessonsTurns,
  withFileLock,
  turnsPathFor,
  readTurnsRaw,
  writeTurnsRaw,
  normalizeRoleEntry,
  auditPathFor,
  readAudit,
  writeAudit,
  rollbackAudit,
  auditStats,
  readDeletedEntries,
  broadcastPathFor,
  writeBroadcast,
  readBroadcast,
  beginBusinessCommit,
  currentCommitId,
  bumpTurns,
  promptIfDue,
  appendLesson,
  fixLesson,
  markSelfWrite,
  readRoleTurns,
  readAllTurns,
};
