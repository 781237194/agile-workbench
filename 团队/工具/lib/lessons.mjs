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
  const result = { sections: [], totals: 0, mtime: null, fileSha: null, parseWarn: [], missing: false, broken: false };
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
    current.rows.push({ date, scene, lesson, next, raw: line });
    result.totals += 1;
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
 * 返回 { ok:true } 或 { ok:false, code:'LESSONS_UNREAD'|'LESSONS_FILE_MISSING'|'LESSONS_PARSE_BROKEN', staleSha12, currentSha12 }
 */
function runLessonGate(role, projectDir, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const parsed = loadLessons(projectDir);
  if (parsed.missing) return { ok: false, code: 'LESSONS_FILE_MISSING', message: `经验教训登记册缺失：${lessonsPath(projectDir)}` };
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

/** Owner 通道豁免：channel ∈ {ui,tty} 或 actor=owner → 不检查 */
function isOwnerChannel(args) {
  const src = args && typeof args === 'object' ? args : {};
  const channel = String(src.channel || src['owner-channel'] || '').trim().toLowerCase();
  const actor = String(src.actor || '').trim().toLowerCase();
  return channel === 'ui' || channel === 'tty' || actor === 'owner';
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
};
