'use strict';
/**
 * R-e438 批②：邮箱单文件 JSONL（追加写 + 尾部读）+ 历史文件冷归档。
 *
 * 落点（需求 §6.2 / PM M-20261120-153415-b105be）：`团队/状态/邮箱/<role>/messages.jsonl`。
 *   - 每行一条消息 `{id,seq,at,from,to,type,subject,body,ackRequired,project,task,msgId,readAt}`；
 *     事件行 `{type:'event',event:'read'|'ack',refSeq,at,by}` 也追加在同一文件（seq 为 null，不计 seqMax）。
 *   - 追加原子性：单行 `fs.appendFileSync`（O_APPEND），一进程一行不拆包；并发由 seq 分配锁 + 单行写保证。
 *   - 读：`readTail` 从文件尾按 64KB 块回读，只解析末 N 行——不整读大文件；`readAll` 供迁移/归档/统计。
 *   - 兼容期：旧 `new/cur/*.json` 仍在时，store 读取回退旧目录；`migrateRole` 导入后把旧目录整体移到
 *     `邮箱/_legacy/<role>/`（不删，可回滚）。
 *   - 冷归档：>7 天的消息按 `at` 月移到 `邮箱/归档/<YYYY-MM>/messages.jsonl`，热文件只留近 7 天；
 *     `index.json{seqMin,seqMax,bytes,archivedMonths[]}`；`--all` 跨归档读取。
 * 本模块无 Electron 依赖，夹具可直接 require。
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_GAP = 64 * 1024;            // 尾读块大小
const HOT_DAYS = 7;                   // 热文件保留天数
const SEQ_LIMIT = 1_000_000;

function pathsFor(mailRoot, role) {
  const dir = path.join(mailRoot, role);
  return {
    role,
    dir,
    jsonl: path.join(dir, 'messages.jsonl'),
    index: path.join(dir, 'index.json'),
    archiveDir: path.join(mailRoot, '归档'),
    legacyDir: path.join(mailRoot, '_legacy', role),
  };
}

function readIndex(p) {
  try {
    const raw = JSON.parse(fs.readFileSync(p.index, 'utf8'));
    return {
      seqMin: Number(raw.seqMin) || 0,
      seqMax: Number(raw.seqMax) || 0,
      bytes: Number(raw.bytes) || 0,
      archivedMonths: Array.isArray(raw.archivedMonths) ? raw.archivedMonths.slice() : [],
      updatedAt: String(raw.updatedAt || ''),
    };
  } catch { return { seqMin: 0, seqMax: 0, bytes: 0, archivedMonths: [], updatedAt: '' }; }
}

function writeIndex(p, idx) {
  try { fs.mkdirSync(p.dir, { recursive: true }); } catch { /* ignore */ }
  const tmp = p.index + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify({ ...idx, updatedAt: new Date().toISOString() }, null, 1) + '\n', 'utf8'); fs.renameSync(tmp, p.index); } catch { /* 并发下索引写失败不阻断追加（读取按 jsonl 为准） */ }
}

/** 追加一条消息；返回 seq。同一角色并发时 seq 可能重复——调用方应容错（读取按 id 去重）。 */
/** 读文件末条消息的 seq（index 丢失/落后时兜底，防止 seq 从 1 重开）。 */
function lastMessageSeq(p) {
  try {
    const st = fs.statSync(p.jsonl);
    const len = Math.min(st.size, 64 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(p.jsonl, 'r');
    try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
    for (const line of buf.toString('utf8').split(/\r?\n/).reverse()) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && r.type !== 'event' && Number.isFinite(Number(r.seq))) return Number(r.seq);
      } catch { /* skip */ }
    }
  } catch { /* missing */ }
  return 0;
}

function appendMessage(mailRoot, role, row) {
  const p = pathsFor(mailRoot, role);
  fs.mkdirSync(p.dir, { recursive: true });
  const idx = readIndex(p);
  // ③ seq 接续：index.seqMax 与文件末行取最大值（防止 index 丢失/迁移后重开导致 1..N 重号）。
  const seq = Math.min(SEQ_LIMIT, Math.max(idx.seqMax || 0, lastMessageSeq(p)) + 1);
  // ② 新追加必须写 at（与迁移行同形；旧消息只有 ts/deliveredAt）。
  const at = String(row.at || row.ts || row.deliveredAt || new Date().toISOString());
  const line = JSON.stringify({ ...row, at, seq }) + '\n';
  fs.appendFileSync(p.jsonl, line, 'utf8');
  idx.seqMin = idx.seqMin || seq;
  idx.seqMax = seq;
  idx.bytes += Buffer.byteLength(line);
  writeIndex(p, idx);
  return seq;
}

function appendEvent(mailRoot, role, evt) {
  const p = pathsFor(mailRoot, role);
  fs.mkdirSync(p.dir, { recursive: true });
  const line = JSON.stringify({ type: 'event', ...evt }) + '\n';
  fs.appendFileSync(p.jsonl, line, 'utf8');
  const idx = readIndex(p);
  idx.bytes += Buffer.byteLength(line);
  writeIndex(p, idx);
  return true;
}

function parseLine(line, bad) {
  const t = String(line || '').trim();
  if (!t) return null;
  try {
    const row = JSON.parse(t);
    return row && typeof row === 'object' ? row : null;
  } catch { if (bad) bad.count += 1; return null; }
}

/** 从文件尾回读最多 limit 条消息（可 afterSeq 只看水位之后），返回按 seq 升序。 */

/** 从 jsonl 读事件行（read/ack），返回 Map: id → {readAt,ackAt}。 */
function collectEvents(mailRoot, role) {
  const p = pathsFor(mailRoot, role);
  const out = new Map();
  if (!fs.existsSync(p.jsonl)) return out;
  for (const line of fs.readFileSync(p.jsonl, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row = null;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || row.type !== 'event') continue;
    const key = String(row.refId || row.id || row.refSeq || '');
    if (!key) continue;
    const cur = out.get(key) || {};
    if (row.event === 'read') cur.readAt = row.at || cur.readAt || '';
    if (row.event === 'ack') cur.ackAt = row.at || cur.ackAt || '';
    out.set(key, cur);
  }
  return out;
}
function readTail(mailRoot, role, { limit = 50, afterSeq = 0, project = '' } = {}) {
  const p = pathsFor(mailRoot, role);
  if (!fs.existsSync(p.jsonl)) return { rows: [], badLines: 0, hitLegacyFallback: true };
  const st = fs.statSync(p.jsonl);
  const limNum = Number(limit);
  const want = Number.isFinite(limNum) ? Math.max(1, Math.min(2000, limNum)) : 50;
  const bad = { count: 0 };
  const rows = [];
  const seen = new Set();
  let end = st.size;
  let raw = '';
  while (end > 0 && rows.length < want) {
    const start = Math.max(0, end - MAX_GAP);
    const len = end - start;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(p.jsonl, 'r');
    try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
    raw = buf.toString('utf8') + raw;
    end = start;
  }
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0 && rows.length < want; i -= 1) {
    const row = parseLine(lines[i], bad);
    if (!row) continue;
    if (row.type === 'event' || !row.id) continue;
    if (afterSeq && Number(row.seq) <= Number(afterSeq)) continue;
    if (project && row.project && String(row.project) !== String(project)) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  const events = collectEvents(mailRoot, role);
  let atFallback = 0;
  const mapped = rows.reverse().map((row) => {
    const ev = events.get(String(row.id)) || (events.get(String(row.seq)) || {});
    const derivedAt = String(row.at || '').trim() ? String(row.at) : atOf(row);
    if (!String(row.at || '').trim() && derivedAt) atFallback += 1;
    return { ...row, at: derivedAt, readAt: String(row.readAt || ev.readAt || ''), ackAt: String(row.ackAt || ev.ackAt || '') };
  });
  return { rows: mapped, badLines: bad.count, atFallback, hitLegacyFallback: false };
}

/** 读该角色全部消息（热文件 + 归档分片），按 seq 升序；供迁移/归档/统计与全量 inbox。 */
function readAll(mailRoot, role, { project = '' } = {}) {
  const p = pathsFor(mailRoot, role);
  const rows = [];
  const seen = new Set();
  const push = (line, bad) => {
    const row = parseLine(line, bad);
    if (!row || row.type === 'event' || !row.id) return;
    if (project && row.project && String(row.project) !== String(project)) return;
    if (seen.has(row.id)) return;
    seen.add(row.id);
    rows.push(row);
  };
  const bad = { count: 0 };
  if (fs.existsSync(p.jsonl)) for (const line of fs.readFileSync(p.jsonl, 'utf8').split(/\r?\n/)) push(line, bad);
  try {
    for (const month of fs.readdirSync(p.archiveDir)) {
      const monthDir = path.join(p.archiveDir, month);
      // 新形态：按月分角色 归档/<YYYY-MM>/<role>/messages.jsonl；
      // 兼容旧形态：团队级混合 归档/<YYYY-MM>/messages.jsonl（必须按 to 过滤，否则 A 角色会读到 B 的归档消息）。
      const perRole = path.join(monthDir, role, 'messages.jsonl');
      if (fs.existsSync(perRole)) for (const line of fs.readFileSync(perRole, 'utf8').split(/\r?\n/)) push(line, bad);
      const mixed = path.join(monthDir, 'messages.jsonl');
      if (fs.existsSync(mixed)) {
        for (const line of fs.readFileSync(mixed, 'utf8').split(/\r?\n/)) {
          const row = parseLine(line, bad);
          if (!row || row.type === 'event' || !row.id) continue;
          if (String(row.to || '') !== String(role)) continue;   // 混合归档必须属于本角色收件箱
          if (project && row.project && String(row.project) !== String(project)) continue;
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          rows.push(row);
        }
      }
    }
  } catch { /* 无归档 */ }
  rows.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0) || String(a.at || '').localeCompare(String(b.at || '')));
  const events = collectEvents(mailRoot, role);
  let atFallback = 0;
  const mapped = rows.map((row) => {
    const ev = events.get(String(row.id)) || (events.get(String(row.seq)) || {});
    const derivedAt = String(row.at || '').trim() ? String(row.at) : atOf(row);
    if (!String(row.at || '').trim() && derivedAt) atFallback += 1;
    return { ...row, at: derivedAt, readAt: String(row.readAt || ev.readAt || ''), ackAt: String(row.ackAt || ev.ackAt || '') };
  });
  return { rows: mapped, badLines: bad.count, atFallback };
}

/** ③ 兜底链：at ?? ts ?? deliveredAt（缺 at 的旧行排序/归档不静默）。 */
function atOf(row) {
  return String((row && (row.at || row.ts || row.deliveredAt)) || '');
}
function monthOf(at) {
  const s = String(at || '');
  const m = /^(\d{4})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}` : '';
}

/** 归档超过 HOT_DAYS 的消息到按月分片；热文件重写为剩余行（tmp+rename）。 */
function archiveCold(mailRoot, role, { now = Date.now(), days = HOT_DAYS, dryRun = false } = {}) {
  const p = pathsFor(mailRoot, role);
  const result = { role, archived: 0, kept: 0, months: [], dryRun: Boolean(dryRun), audit: '' };
  if (!fs.existsSync(p.jsonl)) return result;
  const lines = fs.readFileSync(p.jsonl, 'utf8').split(/\r?\n/);
  const cutoff = now - days * 24 * 3600 * 1000;
  const keep = [];
  const old = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let row = null;
    try { row = JSON.parse(line); } catch { keep.push(line); continue; }
    if (!row || row.type === 'event' || !row.id) { keep.push(line); continue; }
    const at = Date.parse(atOf(row));
    if (!String(row.at || '').trim() && atOf(row)) result.atFallback = (result.atFallback || 0) + 1;
    if (Number.isFinite(at) && at < cutoff) old.push(row); else keep.push(line);
  }
  result.kept = keep.length;
  result.archived = old.length;
  if (!old.length) return result;
  const byMonth = new Map();
  for (const row of old) {
    const m = monthOf(atOf(row)) || monthOf(new Date(now).toISOString()) || 'unknown';
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(row);
  }
  result.months = [...byMonth.keys()].sort();
  if (dryRun) return result;
  fs.mkdirSync(p.dir, { recursive: true });
  for (const [m, rows] of byMonth) {
    // 新归档一律按月分角色落盘：归档/<YYYY-MM>/<role>/messages.jsonl（避免团队级混合文件跨角色串读）。
    const dir = path.join(p.archiveDir, m, role);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'messages.jsonl');
    fs.appendFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  }
  const tmp = p.jsonl + '.tmp';
  fs.writeFileSync(tmp, keep.join('\n') + (keep.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, p.jsonl);
  const idx = readIndex(p);
  idx.archivedMonths = [...new Set([...(idx.archivedMonths || []), ...result.months])].sort();
  idx.bytes = Buffer.byteLength(fs.readFileSync(p.jsonl, 'utf8'));
  writeIndex(p, idx);
  try {
    fs.mkdirSync(mailRoot, { recursive: true });
    fs.appendFileSync(path.join(mailRoot, '邮箱归档.jsonl'), JSON.stringify({ at: new Date().toISOString(), event: 'mail_archive', role, archived: result.archived, kept: result.kept, months: result.months }) + '\n', 'utf8');
    result.audit = '邮箱归档.jsonl';
  } catch { /* 审计失败不阻断归档 */ }
  return result;
}

/** 迁移旧 new/cur/*.json → messages.jsonl，然后整体移入 _legacy/<role>/（不删）。 */
function migrateRole(mailRoot, role, { dryRun = false } = {}) {
  const p = pathsFor(mailRoot, role);
  const result = { role, scanned: 0, imported: 0, skipped: 0, moved: false, dryRun: Boolean(dryRun), errors: [] };
  const existing = new Set(readAll(mailRoot, role).rows.map((r) => String(r.id || '')).filter(Boolean));
  const files = [];
  for (const box of ['new', 'cur']) {
    const dir = path.join(p.dir, box);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      files.push({ box, file: path.join(dir, n), name: n });
    }
  }
  result.scanned = files.length;
  const rows = [];
  for (const f of files) {
    try {
      const msg = JSON.parse(fs.readFileSync(f.file, 'utf8'));
      if (!msg || !msg.id) { result.skipped += 1; continue; }
      if (existing.has(String(msg.id))) { result.skipped += 1; continue; }
      rows.push({ msg, box: f.box, at: String(msg.at || msg.ts || msg.deliveredAt || '') });
    } catch (e) { result.errors.push(String((e && e.message) || e).slice(0, 120)); }
  }
  rows.sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.msg.id).localeCompare(String(b.msg.id)));
  result.imported = rows.length;
  if (dryRun) return result;
  for (const r of rows) {
    // 迁移保留原字段；readAt 已读消息照原样（cur 里的按已读处理）
    appendMessage(mailRoot, role, { ...r.msg, at: String(r.msg.at || r.msg.ts || r.msg.deliveredAt || r.msg.readAt || ''), migratedFrom: r.box === 'cur' ? 'cur' : 'new', deliveredAt: r.msg.deliveredAt || r.msg.at || r.msg.ts || '' });
  }
  try {
    fs.mkdirSync(p.legacyDir, { recursive: true });
    for (const box of ['new', 'cur']) {
      const dir = path.join(p.dir, box);
      if (fs.existsSync(dir)) fs.renameSync(dir, path.join(p.legacyDir, box + '-' + Date.now()));
    }
    result.moved = true;
  } catch (e) { result.errors.push('move_legacy: ' + String((e && e.message) || e).slice(0, 120)); }
  return result;
}


/**
 * 修复历史邮箱：补齐 at、按 (seq, at, id) 重排 seq 1..N、事件 refSeq 同步映射；
 * 写前备份到 邮箱/_legacy/<role>/messages.jsonl.pre-repair-<ts>，写后更新 index 并记 邮箱修复.jsonl。
 */
function repairRole(mailRoot, role, { dryRun = false, now = Date.now() } = {}) {
  const p = pathsFor(mailRoot, role);
  const out = { role, rows: 0, dupSeq: 0, missingAt: 0, events: 0, dryRun: Boolean(dryRun), backup: '', audit: false };
  if (!fs.existsSync(p.jsonl)) return out;
  const messages = [];
  const events = [];
  for (const line of fs.readFileSync(p.jsonl, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row = null;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row) continue;
    if (row.type === 'event') events.push(row); else if (row.id) messages.push(row);
  }
  out.rows = messages.length;
  out.events = events.length;
  out.missingAt = messages.filter((r) => !String(r.at || '').trim()).length;
  out.dupSeq = messages.length - new Set(messages.map((r) => Number(r.seq) || 0)).size;
  messages.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0) || String(a.at || a.ts || '').localeCompare(String(b.at || b.ts || '')) || String(a.id).localeCompare(String(b.id)));
  const seqOf = new Map();
  messages.forEach((r, i) => {
    r.seq = i + 1;
    if (!String(r.at || '').trim()) r.at = String(r.ts || r.deliveredAt || new Date(now).toISOString());
    seqOf.set(String(r.id), r.seq);
  });
  for (const e of events) {
    const ref = String(e.refId || '');
    if (ref && seqOf.has(ref)) e.refSeq = seqOf.get(ref);
  }
  if (dryRun) return out;
  const ts = new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.mkdirSync(p.legacyDir, { recursive: true });
  out.backup = path.join(p.legacyDir, `messages.jsonl.pre-repair-${ts}`);
  fs.copyFileSync(p.jsonl, out.backup);
  const tmp = p.jsonl + '.tmp';
  fs.writeFileSync(tmp, [...messages, ...events].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, p.jsonl);
  const idx = readIndex(p);
  idx.seqMin = messages.length ? 1 : 0;
  idx.seqMax = messages.length;
  idx.bytes = Buffer.byteLength(fs.readFileSync(p.jsonl, 'utf8'));
  writeIndex(p, idx);
  try {
    fs.mkdirSync(mailRoot, { recursive: true });
    fs.appendFileSync(path.join(mailRoot, '邮箱修复.jsonl'), JSON.stringify({ at: new Date(now).toISOString(), event: 'mail_seq_reindex', role, rows: out.rows, dupSeq: out.dupSeq, missingAt: out.missingAt, atFallback: out.missingAt, backup: out.backup }) + '\n', 'utf8');
    out.audit = true;
  } catch { /* 审计失败不阻断 */ }
  return out;
}
function statsRole(mailRoot, role) {
  const p = pathsFor(mailRoot, role);
  const idx = readIndex(p);
  const all = readAll(mailRoot, role);
  let legacyFiles = 0;
  for (const box of ['new', 'cur']) {
    try { legacyFiles += fs.readdirSync(path.join(p.dir, box)).filter((n) => n.endsWith('.json')).length; } catch { /* ignore */ }
  }
  return {
    role, jsonl: fs.existsSync(p.jsonl), seqMin: idx.seqMin, seqMax: idx.seqMax, bytes: idx.bytes,
    messages: all.rows.length, badLines: all.badLines, atFallback: all.atFallback || 0, legacyFiles, archivedMonths: idx.archivedMonths,
  };
}

export {
  pathsFor, readIndex, writeIndex, appendMessage, appendEvent, readTail, readAll,
  archiveCold, migrateRole, statsRole, repairRole, monthOf, HOT_DAYS,
};
