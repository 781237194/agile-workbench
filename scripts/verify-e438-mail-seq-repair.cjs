'use strict';
/**
 * 修复验收脚本：R-e438 批②-2 迁移后 P0 回归（read --id / at / seq）
 *  - A3 改为「热文件 seq 连续 1..N」（归档分片保留历史 seq，阅读按 id，不参与 seq 单调判据）
 *  - A9 新增：index.seqMax ≥ 热文件最大 seq，且新追加 seq 将以热文件最大 seq 续接
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const MAIL = path.join(ROOT, '团队', '状态', '邮箱');
const RESULT = [];
function check(id, title, ok, detail) {
  RESULT.push({ id, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${title}${ok ? '' : '  ← ' + String(JSON.stringify(detail === undefined ? '' : detail)).slice(0, 420)}`);
  if (!ok) process.exitCode = 1;
}
function hotMessages(role) {
  const f = path.join(MAIL, role, 'messages.jsonl');
  const out = [];
  try {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r && r.type !== 'event' && r.id) out.push(r); } catch { /* skip */ }
    }
  } catch { /* missing */ }
  return out;
}
(async () => {
  const ms = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'mail-store.mjs')).href);
  const roles = fs.readdirSync(MAIL, { withFileTypes: true }).filter((e) => e.isDirectory())
    .map((e) => e.name).filter((n) => !['_legacy', '归档'].includes(n));
  let totalHot = 0;
  let totalArchive = 0;
  for (const role of roles) {
    const hot = hotMessages(role);
    const all = ms.readAll(MAIL, role);
    const idx = ms.readIndex(ms.pathsFor(MAIL, role));
    const seqs = hot.map((r) => Number(r.seq)).filter(Number.isFinite);
    const contiguous = seqs.length === hot.length && seqs.every((v, i) => v === i + 1);
    const atAll = hot.every((r) => String(r.at || '').trim());
    const cross = all.rows.filter((r) => r.to !== undefined && String(r.to || '') !== role);
    const archived = all.rows.length - hot.length;
    totalHot += hot.length;
    totalArchive += Math.max(0, archived);
    check(`H1-${role}`, `热文件 seq 连续 1..N（${seqs[0] || '-'}..${seqs[seqs.length - 1] || '-'}，N=${hot.length}）`, contiguous, { first: seqs.slice(0, 3), last: seqs.slice(-3) });
    check(`H2-${role}`, `热文件 at 齐备（缺失 ${hot.filter((r) => !String(r.at || '').trim()).length}）`, atAll, {});
    check(`H3-${role}`, `index.seqMax(${idx.seqMax}) ≥ 热文件最大 seq(${seqs[seqs.length - 1] || 0})，续写从 ${(Math.max(idx.seqMax, seqs[seqs.length - 1] || 0) + 1)} 开始`,
      idx.seqMax >= (seqs[seqs.length - 1] || 0) && idx.seqMax >= hot.length, { idx: idx.seqMax, hotMax: seqs[seqs.length - 1] });
    check(`H4-${role}`, '无跨角色串读（jsonl 热 + 归档全部 to===role）', cross.length === 0, { cross: cross.slice(0, 3) });
    check(`H5-${role}`, `stats.messages == readAll 行数（${all.rows.length}），badLines=${all.badLines}`, ms.statsRole(MAIL, role).messages === all.rows.length && all.badLines === 0, { stats: ms.statsRole(MAIL, role).messages, rows: all.rows.length });
  }
  const months = (() => { try { return fs.readdirSync(path.join(MAIL, '归档')).filter((n) => /^\d{4}-\d{2}$/.test(n)); } catch { return []; } })();
  check('H6', `归档按月（${months.join(',')}）且热/归档合计 ${totalHot + totalArchive}`, months.length >= 2, { months, totalHot, totalArchive });
  check('H7', '修复审计：邮箱修复.jsonl 有 mail_seq_reindex', (() => { try { return fs.readFileSync(path.join(MAIL, '邮箱修复.jsonl'), 'utf8').includes('mail_seq_reindex'); } catch { return false; } })(), {});
  console.log(JSON.stringify({ ok: RESULT.every((r) => r.ok), totalHot, totalArchive, roles }, null, 2));
})().catch((e) => { check('E0', '验收脚本未抛异常', false, { error: String((e && e.stack) || e) }); });
