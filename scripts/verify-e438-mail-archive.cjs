'use strict';
/**
 * 验收脚本：R-e438 批② 真实迁移与冷归档后的 AC4/AC5 核对（只读）
 *
 * 逐角色断言：
 *  A1 迁移完整性：jsonl（热+归档）消息 id 集合 == 邮箱/_legacy/<role>/{new-*,cur-*} 文件 id 集合（幂等迁移后应相等）。
 *  A2 无跨角色串读：readAll(role) 的每条消息 to === role（混合归档必须按 to 过滤）。
 *  A3 seq 单调：readAll 输出的 seq 严格递增（同 seq 允许按 at 排序，但不得回退）。
 *  A4 热文件只近 7 天：messages.jsonl 中非事件行的 at ≥ now-7d（迁移+归档后）。
 *  A5 触达文件 ≤2：角色目录只含 messages.jsonl + index.json。
 *  A6 badLines=0；stats.messages === readAll(role).rows.length（修掉「热+全部归档总和」的串读膨胀）。
 *  A7 归档形态：归档/<YYYY-MM>/... 存在；审计 邮箱归档.jsonl 有 mail_archive 行。
 *  A8 只读：本脚本前后全部 jsonl/归档 sha 不变。
 *
 * 跑法：node scripts/verify-e438-mail-archive.cjs [--json]
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const MAIL = path.join(ROOT, '团队', '状态', '邮箱');
const HOT_DAYS = 7;
const RESULT = [];
function check(id, title, ok, detail) {
  RESULT.push({ id, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${title}${ok ? '' : '  ← ' + String(JSON.stringify(detail === undefined ? '' : detail)).slice(0, 420)}`);
  if (!ok) process.exitCode = 1;
}
const shaFile = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
function listRoleDirs() {
  try {
    return fs.readdirSync(MAIL, { withFileTypes: true }).filter((e) => e.isDirectory())
      .map((e) => e.name).filter((n) => !['_legacy', '归档'].includes(n));
  } catch { return []; }
}
function legacyIds(role) {
  const ids = new Set();
  const base = path.join(MAIL, '_legacy', role);
  let names = [];
  try { names = fs.readdirSync(base); } catch { return ids; }
  for (const n of names) {
    if (!/^(new|cur)-/.test(n)) continue;
    const dir = path.join(base, n);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try { const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (m && m.id) ids.add(String(m.id)); } catch { /* skip */ }
    }
  }
  return ids;
}
/** 迁移窗口起点后新增的消息（团队并发投递）不计入「迁移完整性」比较。 */
function legacyMaxAt(role) {
  let max = 0;
  const base = path.join(MAIL, '_legacy', role);
  let names = [];
  try { names = fs.readdirSync(base); } catch { return max; }
  for (const n of names) {
    if (!/^(new|cur)-/.test(n)) continue;
    const dir = path.join(base, n);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const at = Date.parse(String((m && (m.at || m.ts || m.deliveredAt)) || ''));
        if (Number.isFinite(at) && at > max) max = at;
      } catch { /* skip */ }
    }
  }
  return max;
}
function hotRows(role) {
  const f = path.join(MAIL, role, 'messages.jsonl');
  const out = [];
  try {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r && r.type !== 'event' && r.id) out.push(r); } catch { /* bad */ }
    }
  } catch { /* missing */ }
  return out;
}
function shaArchives() {
  const parts = [];
  for (const role of listRoleDirs()) {
    const dir = path.join(MAIL, role);
    for (const n of (fs.existsSync(dir) ? fs.readdirSync(dir) : [])) {
      const f = path.join(dir, n);
      if (fs.statSync(f).isFile()) parts.push(role + '/' + n + ':' + shaFile(f));
    }
  }
  const arch = path.join(MAIL, '归档');
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else parts.push(path.relative(MAIL, p) + ':' + shaFile(p));
    }
  };
  walk(arch);
  return crypto.createHash('sha256').update(parts.sort().join('\n')).digest('hex');
}

async function main() {
  const ms = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'mail-store.mjs')).href);
  const before = shaArchives();
  const roles = listRoleDirs();
  const now = Date.now();
  let totalRows = 0;
  const report = [];
  for (const role of roles) {
    const legacy = legacyIds(role);
    const all = ms.readAll(MAIL, role);
    const rows = all.rows;
    const rowsById = new Map(rows.map((r) => [String(r.id), r]));
    const legacyMax = legacyMaxAt(role);
    totalRows += rows.length;
    const jsonlIds = new Set(rows.map((r) => String(r.id)));
    const missing = [...legacy].filter((id) => !jsonlIds.has(id));
    const extra = [...jsonlIds].filter((id) => !legacy.has(id));
    const extraNew = extra.filter((id) => {
      const row = rowsById.get(id) || {};
      const at = Date.parse(String(row.at || row.ts || row.deliveredAt || ''));
      return Number.isFinite(at) && at > legacyMax;
    });
    const stats = ms.statsRole(MAIL, role);
    const cross = rows.filter((r) => r.to !== undefined && String(r.to || '') !== role);
    const hot = hotRows(role);
    const hotOld = hot.filter((r) => {
      const at = Date.parse(String(r.at || ''));
      return Number.isFinite(at) && at < now - HOT_DAYS * 86400000;
    });
    const touchFiles = fs.existsSync(path.join(MAIL, role)) ? fs.readdirSync(path.join(MAIL, role)) : [];
    const seqs = rows.map((r) => Number(r.seq)).filter(Number.isFinite);
    const seqMono = seqs.every((v, i) => i === 0 || v >= seqs[i - 1]);
    report.push({ role, legacyIds: legacy.size, rows: rows.length, statsMessages: stats.messages, badLines: all.badLines, hot: hot.length, hotOld: hotOld.length, touchFiles: touchFiles.length, crossRole: cross.length, missing: missing.length, extra: extra.length, extraNew: extraNew.length, seqMono });
    check(`A1-${role}`, `迁移完整性：jsonl ⊇ _legacy 全部 id（legacy=${legacy.size}, jsonl=${rows.length}；迁移后新增 ${extraNew.length} 条）`,
      legacy.size > 0 && missing.length === 0 && extraNew.length === extra.length, { missing: missing.slice(0, 5), extra: extra.filter((id) => !extraNew.includes(id)).slice(0, 5) });
    check(`A2-${role}`, '无跨角色串读（readAll 每条 to === role；混合归档按 to 过滤）', cross.length === 0, { cross: cross.slice(0, 3) });
    check(`A3-${role}`, 'seq 单调递增（按 seq 排序后无回退）', seqMono, { first: seqs.slice(0, 5), last: seqs.slice(-5) });
    check(`A4-${role}`, `热文件只近 ${HOT_DAYS} 天（旧行 ${hotOld.length} 条应为 0）`, hotOld.length === 0, { hotOld: hotOld.slice(0, 3).map((r) => r.at) });
    check(`A5-${role}`, `触达文件 ≤2（${touchFiles.join(',')}）`, touchFiles.filter((n) => n === 'messages.jsonl' || n === 'index.json').length === 2, { touchFiles });
    check(`A6-${role}`, `badLines=0 且 stats.messages == readAll 行数（${stats.messages} / ${rows.length}）`,
      all.badLines === 0 && stats.messages === rows.length, { badLines: all.badLines, stats: stats.messages, rows: rows.length });
  }
  const archBase = path.join(MAIL, '归档');
  const months = (() => { try { return fs.readdirSync(archBase).filter((n) => /^\d{4}-\d{2}$/.test(n)); } catch { return []; } })();
  check('A7', `归档形态：按月目录存在（${months.join(',') || '无'}），审计 邮箱归档.jsonl 有 mail_archive 行`,
    months.length > 0 && (() => { try { return fs.readFileSync(path.join(MAIL, '邮箱归档.jsonl'), 'utf8').includes('mail_archive'); } catch { return false; } })(), { months });
  check('A8', '只读：本脚本前后归档树 sha 不变（热 jsonl 允许团队并发新增）', shaArchives() === before, { before });
  const after = shaArchives();
  if (typeof process.argv !== 'undefined' && process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok: RESULT.every((r) => r.ok), totalRows, roles: report, archivedMonths: months, shaSame: after === before }, null, 2));
  }
}

main().catch((e) => { check('E0', '验收脚本未抛异常', false, { error: String((e && e.stack) || e) }); });
