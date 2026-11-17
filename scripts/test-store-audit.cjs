#!/usr/bin/env node
'use strict';
/**
 * test-store-audit.cjs —— 缺陷 B-20261117-113926-8be3 自检（writeStore 写状态产审计行 / G11）
 *
 * 口径：
 *   ① 每次成功写入追加一行 8 键审计 {at,kind,file,bytes,prevSha,sha,case,actor}，actor=shell；
 *   ② 无变化写入不产行（prevSha===sha）；失败路径不产行（本模块只在成功后被调用）；
 *   ③ append-only：多次写入只追加，不重写历史；坏行/旧行读侧不报错（case 空字符串照读）；
 *   ④ 落地位置＝状态文件同目录的 写入审计.jsonl（workbench.json 在 data/userdata/，不属
 *      json-atomic 的 状态/项目/<项目>/ 审计范围，这正是本单要补的口子）；
 *   ⑤ 接线：main.js 的 writeStore 写前记 prevSha、写后调 appendStoreWriteAudit。
 *
 * 只写 _tmp 沙盘；运行：node scripts/test-store-audit.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const S = require(path.join(ROOT, 'src', 'store-audit.js'));
const SB = path.join(ROOT, '_tmp', `store-audit-${process.pid}`);

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 320)}`);
}
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(SB, { recursive: true });
const storeFile = path.join(SB, 'workbench.json');
const auditFile = S.auditFileForStore(storeFile);

// ── S1 首次写入产一行，8 键齐全、actor=shell
const v1 = '{ "version": 1 }\n';
fs.writeFileSync(storeFile, v1, 'utf8');
const r1 = S.appendStoreWriteAudit({ file: storeFile, bytes: v1.length, prevSha: '', sha: sha(v1), caseName: 'writeStore' });
const rows1 = S.readStoreAudit(auditFile);
check('S1 首次写入产 1 行且 8 键齐全、actor=shell、kind/at 有值',
  r1.written === true && rows1.length === 1
  && Object.keys(rows1[0]).sort().join(',') === 'actor,at,bytes,case,file,kind,prevSha,sha'
  && rows1[0].actor === 'shell' && rows1[0].case === 'writeStore' && rows1[0].kind === 'state-write'
  && rows1[0].file === storeFile && rows1[0].bytes === v1.length && rows1[0].prevSha === '' && Boolean(rows1[0].at),
  { r1, row: rows1[0] });

// ── S2 无变化不写行
const r2 = S.appendStoreWriteAudit({ file: storeFile, bytes: v1.length, prevSha: sha(v1), sha: sha(v1), caseName: 'writeStore' });
check('S2 内容没变（prevSha===sha）→ 不产行',
  r2.written === false && r2.reason === 'unchanged' && S.readStoreAudit(auditFile).length === 1, r2);

// ── S3 变更再来一次 → append-only 第二行，prevSha 指上一版
const v2 = '{ "version": 2 }\n';
fs.writeFileSync(storeFile, v2, 'utf8');
const r3 = S.appendStoreWriteAudit({ file: storeFile, bytes: v2.length, prevSha: sha(v1), sha: sha(v2), caseName: 'writeStore' });
const rows3 = S.readStoreAudit(auditFile);
check('S3 第二次变更追加第 2 行（append-only，不覆盖）且 prevSha=上一版 sha',
  r3.written === true && rows3.length === 2 && rows3[1].prevSha === sha(v1) && rows3[1].sha === sha(v2) && rows3[0].sha === sha(v1),
  rows3.map((r) => ({ prev: r.prevSha.slice(0, 8), sha: r.sha.slice(0, 8) })));

// ── S4 缺 sha（例如写盘前算不出）→ 不写行
const r4 = S.appendStoreWriteAudit({ file: storeFile, bytes: 10, prevSha: '', sha: '', caseName: 'writeStore' });
check('S4 没有 sha 的写入 → 不产行（避免无意义审计）', r4.written === false && r4.reason === 'no-sha', r4);

// ── S5 旧行/坏行读侧兼容
fs.appendFileSync(auditFile, '{"at":"2026-01-01T00:00:00.000Z","case":""}\n这不是 JSON\n', 'utf8');
const rows5 = S.readStoreAudit(auditFile);
check('S5 读侧兼容旧行（case 空、缺字段补空）且坏行跳过不报错',
  rows5.length === 3 && rows5[2].case === '' && rows5[2].bytes === 0 && rows5[2].kind === '', rows5.slice(-1));

// ── S6 审计文件不越界：落在状态文件同目录
check('S6 审计文件＝状态文件同目录的 写入审计.jsonl',
  auditFile === path.join(SB, '写入审计.jsonl') && fs.existsSync(auditFile), { auditFile });

// ── S7 接线：main.js writeStore 写前记 prevSha、写后调 appendStoreWriteAudit
const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
check('S7① writeStore 写前取 prevSha（sha256）', /storeAuditPrev/.test(main) && /prevSha: storeAuditPrev\.sha/.test(main));
check('S7② writeStore 写后调用 appendStoreWriteAudit（无变化不写、失败只 warn）',
  /StoreAudit\.appendStoreWriteAudit\(/.test(main) && /STORE_AUDIT_SKIP/.test(main) && /STORE_AUDIT_FAIL/.test(main));

fs.rmSync(SB, { recursive: true, force: true });
console.log(`\n状态写入审计自检：${passed}/${passed + failures.length} PASS`);
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
process.exit(0);
