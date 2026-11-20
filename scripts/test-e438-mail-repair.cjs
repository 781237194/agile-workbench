'use strict';
/**
 * 夹具：R-e438 批②-2 迁移后 P0 回归修复（PM M-20261120-164130-42d678 ④）
 *
 * 场景：迁移 20 条历史消息 + 追加 1 条新写入（不带 at、seq 若 index 丢失会重号），然后：
 *  R1 逐条 findMessage/readMessage 命中（read/ack/mark-read 同源入口）；
 *  R2 新追加行必须有 at；
 *  R3 修复（repairRole）后 seq 严格 1..21 单调、at 齐备、事件 refSeq 映射到新 seq；
 *  R4 修复幂等：第二次 repair 不变（rows/seq 一致）；
 *  R5 备份文件存在（_legacy/<role>/messages.jsonl.pre-repair-*）且审计 邮箱修复.jsonl 有 mail_seq_reindex。
 *
 * 跑法：node scripts/test-e438-mail-repair.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const MAIL_STORE = path.join(ROOT, '团队', '工具', 'lib', 'mail-store.mjs');
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-repair-'));
const MAIL = path.join(SB, '邮箱');
const ROLE = 'programmer1';
const RESULT = [];
function check(id, title, ok, detail) {
  RESULT.push({ id, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${title}${ok ? '' : '  ← ' + String(JSON.stringify(detail === undefined ? '' : detail)).slice(0, 420)}`);
  if (!ok) process.exitCode = 1;
}

(async () => {
  const ms = await import(pathToFileURL(MAIL_STORE).href);
  const dir = path.join(MAIL, ROLE);
  // 20 条历史（模拟迁移前 legacy 文件）
  fs.mkdirSync(path.join(dir, 'new'), { recursive: true });
  for (let i = 0; i < 20; i += 1) {
    const at = new Date(Date.UTC(2026, 10, 20, 1, i)).toISOString();
    const msg = { id: `M-hist-${i}`, from: 'pm', to: ROLE, subject: `历史 ${i}`, body: 'x', project: 'p', task: '', ackRequired: i % 2 === 0, type: 'dispatch', ts: at, deliveredAt: at };
    fs.writeFileSync(path.join(dir, 'new', `${i}-M-hist-${i}.json`), JSON.stringify(msg, null, 1), 'utf8');
  }
  const mig = ms.migrateRole(MAIL, ROLE, { dryRun: false });
  check('R0', `迁移 20 条（导入 ${mig.imported}）`, mig.imported === 20, { mig });

  // 新写入 1 条：不带 at（sendMessage 记录形态）
  const seqNew = ms.appendMessage(MAIL, ROLE, { id: 'M-new-1', from: 'pm', to: ROLE, subject: '新消息', body: 'y', project: 'p', task: '', ackRequired: false, type: 'note', ts: new Date().toISOString(), deliveredAt: new Date().toISOString() });
  const lines = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const newRow = lines.find((r) => r.id === 'M-new-1');
  check('R2', `新追加行写 at 且 seq 接续（seq=${seqNew} > 迁移段最大 20）`, Boolean(newRow && newRow.at) && seqNew === 21, { newRow, seqNew });

  // R1：逐条命中（read/ack/mark-read 的 id→消息入口同源 readAll/readTail）
  const allIds = new Set(ms.readAll(MAIL, ROLE).rows.map((r) => String(r.id)));
  const tailIds = new Set(ms.readTail(MAIL, ROLE, { limit: 200 }).rows.map((r) => String(r.id)));
  let missAll = 0;
  let missTail = 0;
  for (let i = 0; i < 20; i += 1) {
    if (!allIds.has(`M-hist-${i}`)) missAll += 1;
    if (!tailIds.has(`M-hist-${i}`)) missTail += 1;
  }
  if (!allIds.has('M-new-1')) missAll += 1;
  if (!tailIds.has('M-new-1')) missTail += 1;
  check('R1', '迁移段 + 新写入段逐条按 id 命中（readAll 21/21、readTail 21/21）', missAll === 0 && missTail === 0, { missAll, missTail });
  const eventsBefore = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8').split(/\r?\n/).filter((l) => /"type":"event"/.test(l)).length;

  // R3：修复
  const rep = ms.repairRole(MAIL, ROLE);
  const rows = ms.readAll(MAIL, ROLE).rows;
  const seqs = rows.map((r) => Number(r.seq));
  const mono = seqs.every((v, i) => i === 0 || v === seqs[i - 1] + 1);
  const atAll = rows.every((r) => String(r.at || '').trim());
  const content = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const evs = content.filter((r) => r.type === 'event');
  const evRefsOk = evs.every((e) => {
    const id = String(e.refId || '');
    if (!id) return true;
    const row = rows.find((r) => String(r.id) === id);
    return !row || Number(e.refSeq) === Number(row.seq);
  });
  check('R3', '修复后 seq 严格 1..21、at 齐备、事件 refSeq 映射到新 seq',
    rep.rows === 21 && mono && seqs[0] === 1 && seqs[seqs.length - 1] === 21 && atAll && evRefsOk && eventsBefore === evs.length, { rep, seqs: [seqs[0], seqs[seqs.length - 1]], atAll, evRefsOk, eventsBefore, evCount: evs.length });

  // R4：幂等
  const rep2 = ms.repairRole(MAIL, ROLE);
  const rows2 = ms.readAll(MAIL, ROLE).rows;
  check('R4', '二次修复幂等（rows 21，seq 集合不变）', rep2.rows === rows2.length && rows2.map((r) => r.seq).join(',') === seqs.join(','), { rep2 });

  // R5：备份 + 审计
  const legacy = path.join(MAIL, '_legacy', ROLE);
  const backups = fs.existsSync(legacy) ? fs.readdirSync(legacy).filter((n) => n.startsWith('messages.jsonl.pre-repair-')) : [];
  const audit = (() => { try { return fs.readFileSync(path.join(MAIL, '邮箱修复.jsonl'), 'utf8').includes('mail_seq_reindex'); } catch { return false; } })();
  check('R5', '备份文件存在（pre-repair）且 邮箱修复.jsonl 有 mail_seq_reindex 审计', backups.length >= 1 && audit, { backups, audit });
})().catch((e) => { check('E0', '夹具未抛异常', false, { error: String((e && e.stack) || e) }); }).finally(() => {
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
});

process.on('exit', () => {
  const pass = RESULT.filter((r) => r.ok).length;
  console.log(`\n${pass}/${RESULT.length} PASS`);
  if (pass !== RESULT.length) process.exitCode = 1;
});
