#!/usr/bin/env node
const { rmSandbox, uniqueSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * R-c6dc（T-20261115-145649-732e）断言：需求正文唯一写入口 / 并发检测 / 登记链 / req audit
 *
 * 覆盖：AC1 唯一写者 · AC2 三值校验 · AC3 写入即登记（prevSha 成链）· AC4/AC7 冻结与 legacy 只读
 *       AC8 锁（59s=lock_held / 60s & 61s=LOCK_STALE，且零副作用）· AC9 system 豁免 writer 不豁免冻结
 *       AC-c6dc-1.1 audit --json 契约 · AC-c6dc-1.2 多轮 RR current/stale/mismatch · AC-c6dc-1.4 unlock-write
 *
 * 跑法：node scripts/test-doc-writer.cjs
 * 环境：自建沙盘 项目/工作台改造修复/_tmp/doc-writer-sandbox（TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_SELFTEST=1）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const TEAM_MJS = path.join(REPO, '团队', '工具', 'team.mjs');
const SANDBOX = uniqueSandbox('doc-writer-sandbox', { root: path.join(REPO, '项目', '工作台改造修复') });
const TEAM_ROOT = path.join(SANDBOX, '团队');
const PROJECTS_ROOT = path.join(SANDBOX, '项目');
const PROJECT = '写者沙盘';
const PROJECT_PATH = path.join(PROJECTS_ROOT, PROJECT);
const STATE = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
const REQ_DIR = path.join(PROJECT_PATH, '需求');
const REGISTRY = path.join(STATE, '文档登记.jsonl');
const LOCK = path.join(REQ_DIR, '.doc-write.lock');
const RR_DIR = path.join(STATE, '需求评审');

let pass = 0; let fail = 0;
const failures = []; const results = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; results.push({ name, ok: true }); }
  else { fail += 1; failures.push({ name, detail: String(detail).replace(/\s+/g, ' ').slice(0, 240) }); results.push({ name, ok: false, detail }); }
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const shaFile = (f) => sha(fs.readFileSync(f));
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n', 'utf8'); };
const regRows = () => (fs.existsSync(REGISTRY) ? fs.readFileSync(REGISTRY, 'utf8').split(/\r?\n/).filter(Boolean).map((s) => JSON.parse(s)) : []);
function env(extra = {}) { return { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS_ROOT, TEAM_SELFTEST: '1', ...extra }; }
function run(args, extra = {}) {
  try {
    return {
      code: 0,
      stdout: execFileSync(process.execPath, [TEAM_MJS, ...args], {
        env: env(extra), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}
function runJson(args, extra = {}) { const r = run([...args, '--json'], extra); let j = null; try { j = JSON.parse(r.stdout); } catch { j = null; } return { ...r, json: j }; }

// ---------- 沙盘 ----------
rmSandbox(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '团队'), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, '项目'), { recursive: true });
ok('沙盘 init', /团队已初始化/.test(run(['init']).stdout));
ok('沙盘项目建立', /项目已建/.test(run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).stdout));
let pmToken = (() => { const m = /令牌:\s*([0-9a-f]{24})/.exec(run(['boot', '--role', 'pm', '--project', PROJECT]).stdout); return m ? m[1] : ''; })();
for (const [role, name] of [['analyst', '需求分析师'], ['product', '产品设计师']]) {
  run(['roster', 'add', '--boot', pmToken, '--role', role, '--name', name, '--force']);
  pmToken = (() => { const m = /令牌:\s*([0-9a-f]{24})/.exec(run(['boot', '--role', 'pm', '--project', PROJECT]).stdout); return m ? m[1] : ''; })();
}
const analystToken = /令牌:\s*([0-9a-f]{24})/.exec(run(['boot', '--role', 'analyst', '--project', PROJECT]).stdout)[1];
const productToken = /令牌:\s*([0-9a-f]{24})/.exec(run(['boot', '--role', 'product', '--project', PROJECT]).stdout)[1];
ok('pm/analyst/product 令牌齐', Boolean(pmToken) && Boolean(analystToken) && Boolean(productToken));

const REQ = 'R-20261115-170000-abcd';
fs.mkdirSync(REQ_DIR, { recursive: true });
const docFile = path.join(REQ_DIR, `${REQ}-单写者夹具.md`);
const v1 = '# 夹具需求 v1\n\n## 一、这是什么\n\n第一版。\n';
fs.writeFileSync(docFile, v1, 'utf8');
const v2File = path.join(SANDBOX, 'v2.md');
const v2 = '# 夹具需求 v2\n\n## 一、这是什么\n\n第二版（改了正文）。\n';
fs.writeFileSync(v2File, v2, 'utf8');

// ---------- AC1/AC2/AC3 写者 + 三值 + 登记链 ----------
const nonWriter = runJson(['req', 'write', '--boot', productToken, '--project', PROJECT, '--requirement', REQ, '--file', v2File, '--expected-sha', shaFile(docFile).slice(0, 12)]);
ok('AC1 非写者（product）→ NON_WRITER_DENIED', String(nonWriter.json && nonWriter.json.code) === 'NON_WRITER_DENIED' && nonWriter.code === 1, JSON.stringify(nonWriter.json && nonWriter.json.code));
ok('AC1 被拒后正文未变', shaFile(docFile) === sha(Buffer.from(v1)));
const noSha = runJson(['req', 'write', '--boot', analystToken, '--project', PROJECT, '--requirement', REQ, '--file', v2File]);
ok('AC2 缺 --expected-sha → EXPECTED_SHA_REQUIRED', String(noSha.json && noSha.json.code) === 'EXPECTED_SHA_REQUIRED');
const stale = runJson(['req', 'write', '--boot', analystToken, '--project', PROJECT, '--requirement', REQ, '--file', v2File, '--expected-sha', 'deadbeefdead']);
ok('AC2 三值不符 → DOC_CONCURRENT_MODIFIED(hash_mismatch)', String(stale.json && stale.json.code) === 'DOC_CONCURRENT_MODIFIED' && String(stale.json.details && stale.json.details.reason) === 'hash_mismatch', JSON.stringify(stale.json && stale.json.code));
ok('AC2 失败零副作用（无登记行）', regRows().length === 0, String(regRows().length));
const w1 = runJson(['req', 'write', '--boot', analystToken, '--project', PROJECT, '--requirement', REQ, '--file', v2File, '--expected-sha', shaFile(docFile).slice(0, 12)]);
ok('AC1 写者（analyst）写入成功', w1.code === 0 && w1.json && w1.json.ok === true, (w1.stderr || '').slice(0, 160));
ok('AC3 首写补 baseline + write 两行', (() => { const rows = regRows(); return rows.filter((r) => r.action === 'baseline').length === 1 && rows.filter((r) => r.action === 'write').length === 1; })(), JSON.stringify(regRows().map((r) => r.action)));
const rows1 = regRows();
const baselineRow = rows1.find((r) => r.action === 'baseline');
const writeRow = rows1.find((r) => r.action === 'write');
ok('AC3 baseline.prevSha=null 且记当时磁盘 sha', baselineRow && baselineRow.prevSha === null && String(baselineRow.sha256).startsWith(sha(Buffer.from(v1)).slice(0, 8)), JSON.stringify(baselineRow));
ok('AC3 write.prevSha == baseline.sha256（成链）', Boolean(writeRow && baselineRow && writeRow.prevSha === baselineRow.sha256), JSON.stringify({ prev: writeRow && writeRow.prevSha, base: baselineRow && baselineRow.sha256 }));
ok('AC3 正文已更新', shaFile(docFile) === sha(Buffer.from(v2)));
ok('AC3 登记 13 键？至少必备键齐全', rows1.every((r) => ['at', 'requirementId', 'path', 'action', 'sha256', 'writer', 'actor', 'prevSha', 'reason'].every((k) => k in r)), JSON.stringify(Object.keys(rows1[0] || {})));

// ---------- AC8/AC-c6dc-1.3 锁边界 ----------
function writeLock(ageMs) {
  fs.writeFileSync(LOCK, JSON.stringify({ pid: 999999, at: new Date(Date.now() - ageMs).toISOString(), host: 'test', requirementId: REQ }));
}
const cur = shaFile(docFile).slice(0, 12);
writeLock(59 * 1000);
const lock59 = runJson(['req', 'write', '--boot', analystToken, '--project', PROJECT, '--requirement', REQ, '--file', v2File, '--expected-sha', cur]);
ok('AC8 锁 age=59s → DOC_CONCURRENT_MODIFIED(lock_held)', String(lock59.json && lock59.json.code) === 'DOC_CONCURRENT_MODIFIED' && String(lock59.json.details && lock59.json.details.reason) === 'lock_held', JSON.stringify(lock59.json && lock59.json.code));
ok('AC8 59s 时锁文件仍在、正文未变', fs.existsSync(LOCK) && shaFile(docFile) === sha(Buffer.from(v2)));
for (const [sec, label] of [[60, '60s'], [61, '61s']]) {
  writeLock(sec * 1000);
  const before = regRows().length;
  const r = runJson(['req', 'write', '--boot', analystToken, '--project', PROJECT, '--requirement', REQ, '--file', v2File, '--expected-sha', cur]);
  ok(`AC8/1.3 锁 age=${label} → LOCK_STALE(lock_stale)`, String(r.json && r.json.code) === 'LOCK_STALE' && String(r.json.details && r.json.details.reason) === 'lock_stale', JSON.stringify(r.json && r.json.code));
  ok(`AC8/1.3 ${label} 零副作用且不删锁`, regRows().length === before && fs.existsSync(LOCK) && shaFile(docFile) === sha(Buffer.from(v2)));
}
// ---------- AC-c6dc-1.4 unlock-write ----------
const unlockNoReason = runJson(['req', 'unlock-write', '--boot', pmToken, '--project', PROJECT, '--requirement', REQ]);
ok('1.4 无 --reason → REASON_REQUIRED', String(unlockNoReason.json && unlockNoReason.json.code) === 'REASON_REQUIRED');
const unlockByAnalyst = runJson(['req', 'unlock-write', '--boot', analystToken, '--project', PROJECT, '--requirement', REQ, '--reason', 'x']);
ok('1.4 非 PM → PERMISSION_DENIED', String(unlockByAnalyst.json && unlockByAnalyst.json.code) === 'PERMISSION_DENIED');
const unlock1 = runJson(['req', 'unlock-write', '--boot', pmToken, '--project', PROJECT, '--requirement', REQ, '--reason', '锁超时，PM 清理']);
ok('1.4 PM+reason → 锁删除', unlock1.code === 0 && !fs.existsSync(LOCK), (unlock1.stderr || '').slice(0, 120));
ok('1.4 写 unlock_lock 登记行', regRows().some((r) => r.action === 'unlock_lock' && String(r.reason).includes('PM 清理')), JSON.stringify(regRows().map((r) => r.action)));
const unlock2 = runJson(['req', 'unlock-write', '--boot', pmToken, '--project', PROJECT, '--requirement', REQ, '--reason', '再清一次']);
const unlockRows = regRows().filter((r) => r.action === 'unlock_lock').length;
ok('1.4 重复清锁 → LOCK_NOT_FOUND 且无第二行', String(unlock2.json && unlock2.json.code) === 'LOCK_NOT_FOUND' && unlockRows === 1, `${unlockRows}`);

// ---------- AC4/AC7 冻结与 legacy 只读 ----------
const freeze = runJson(['req', 'freeze', '--boot', pmToken, '--project', PROJECT, '--requirement', REQ, '--reason', '冻结给 Owner 看']);
ok('AC4 PM 冻结成功', freeze.code === 0, (freeze.stderr || '').slice(0, 120));
const frozenWrite = runJson(['req', 'write', '--boot', analystToken, '--project', PROJECT, '--requirement', REQ, '--file', v2File, '--expected-sha', shaFile(docFile).slice(0, 12)]);
ok('AC4 冻结后写者写入 → DOC_FROZEN_DENIED', String(frozenWrite.json && frozenWrite.json.code) === 'DOC_FROZEN_DENIED', JSON.stringify(frozenWrite.json && frozenWrite.json.code));
const frozenSystem = runJson(['req', 'write', '--boot', productToken, '--project', PROJECT, '--requirement', REQ, '--file', v2File, '--expected-sha', shaFile(docFile).slice(0, 12), '--actor', 'system']);
ok('AC9 system 也过不了冻结 → DOC_FROZEN_DENIED', String(frozenSystem.json && frozenSystem.json.code) === 'DOC_FROZEN_DENIED');
const unfreeze = runJson(['req', 'unfreeze', '--boot', pmToken, '--project', PROJECT, '--requirement', REQ, '--reason', '解冻，可以改了']);
ok('AC4 解冻成功且登记 unfreeze', unfreeze.code === 0 && regRows().some((r) => r.action === 'unfreeze'), (unfreeze.stderr || '').slice(0, 120));
const afterUnfreeze = runJson(['req', 'write', '--boot', analystToken, '--project', PROJECT, '--requirement', REQ, '--file', v2File, '--expected-sha', shaFile(docFile).slice(0, 12)]);
ok('AC4 解冻后可写', afterUnfreeze.code === 0 && String(afterUnfreeze.json && afterUnfreeze.json.ok) === 'true', JSON.stringify(afterUnfreeze.json && afterUnfreeze.json.code));
// AC7 legacy 只读（无 freeze 行）：拒写且不清属性
const legacyName = `${REQ}-legacy只读夹具.md`;
// 用另一条需求 id，避免与已解冻的具体文档混；同时造 legacy 只读文件
const REQ2 = 'R-20261115-170001-beef';
const legacyFile = path.join(REQ_DIR, `${REQ2}-legacy只读夹具.md`);
fs.writeFileSync(legacyFile, '# legacy 只读\n\n正文。\n', 'utf8');
fs.chmodSync(legacyFile, 0o444);
const legacySha = shaFile(legacyFile);
const legacyWrite = runJson(['req', 'write', '--boot', analystToken, '--project', PROJECT, '--requirement', REQ2, '--file', v2File, '--expected-sha', legacySha.slice(0, 12)]);
ok('AC7 legacy 只读 → DOC_FROZEN_DENIED(legacy_readonly)', String(legacyWrite.json && legacyWrite.json.code) === 'DOC_FROZEN_DENIED' && String(legacyWrite.json.details && legacyWrite.json.details.reason) === 'legacy_readonly', JSON.stringify(legacyWrite.json && legacyWrite.json.details));
ok('AC7 属性未被自动清、字节未变', ((fs.statSync(legacyFile).mode & 0o200) === 0) && shaFile(legacyFile) === legacySha);
fs.chmodSync(legacyFile, 0o644);

// ---------- AC9 system 豁免 writer（未冻结时）----------
const sysWrite = runJson(['req', 'write', '--boot', productToken, '--project', PROJECT, '--requirement', REQ, '--file', v2File, '--expected-sha', shaFile(docFile).slice(0, 12), '--actor', 'system']);
ok('AC9 actor=system 不受 writer 拦截', sysWrite.code === 0 && String(sysWrite.json && sysWrite.json.ok) === 'true', JSON.stringify(sysWrite.json && sysWrite.json.code));
ok('AC9 登记行 actor=system', regRows().slice(-1)[0] && String(regRows().slice(-1)[0].actor) === 'system', JSON.stringify(regRows().slice(-1)[0] && regRows().slice(-1)[0].actor));

// ---------- AC-c6dc-1.1 audit 契约 ----------
const audit1 = runJson(['req', 'audit', '--project', PROJECT]);
ok('1.1 audit --json stdout 恰好一行 JSON', audit1.code === 1 && audit1.json && /^\{/.test(audit1.stdout.trim()) && audit1.stdout.trim().split(/\r?\n/).length === 1, `lines=${audit1.stdout.trim().split(/\r?\n/).length}`);
ok('1.1 未登记文件 → state=untracked + DOC_UNTRACKED_WRITE', (audit1.json.requirements || []).some((r) => r.state === 'untracked' && (r.codes || []).includes('DOC_UNTRACKED_WRITE')), JSON.stringify((audit1.json.requirements || []).map((r) => [r.requirementId, r.state])));
ok('1.1 退出码 1 且 ok=false', audit1.code === 1 && audit1.json.ok === false);
ok('1.1 state 五值枚举内', (audit1.json.requirements || []).every((r) => ['ok', 'untracked', 'mismatch', 'missing', 'registry_broken'].includes(r.state)), 'bad state');
// B-d548（缺陷单 2026-11-16）：req audit 的**文本路径**曾崩 [INTERNAL] String(...).join is not a function
// （ops.mjs 把已经是数组的 result.codes 先 String() 再 .join()）。此断言守住文本路径不崩且逐条列出。
const auditText = run(['req', 'audit', '--project', PROJECT]);
ok('1.1（B-d548）audit 文本路径不崩：含「需求正文审计」且 stderr 无 INTERNAL',
  auditText.code === 1 && /需求正文审计/.test(String(auditText.stdout || ''))
  && !/\[INTERNAL\]/.test(String(auditText.stderr || '')) && !/is not a function/.test(String(auditText.stderr || '')),
  JSON.stringify({ code: auditText.code, out: String(auditText.stdout || '').slice(0, 120), err: String(auditText.stderr || '').slice(0, 160) }));
ok('1.1（B-d548）audit 文本路径逐条列需求（state/sha 行不吞）',
  String(auditText.stdout || '').split(/\r?\n/).some((l) => /^-\s+R-\d{8}-\d{6}-[0-9a-f]{4}\s+状态\s+\S+\s+sha\s+\S+/.test(l)),
  JSON.stringify(String(auditText.stdout || '').split(/\r?\n/).slice(0, 4)));
// 把 legacy 文件也写一遍（补 baseline+write）后应全部 ok
const legacyReg = runJson(['req', 'write', '--boot', analystToken, '--project', PROJECT, '--requirement', REQ2, '--file', v2File, '--expected-sha', shaFile(legacyFile).slice(0, 12)]);
const audit2 = runJson(['req', 'audit', '--project', PROJECT]);
ok('1.1 全部登记后 → 退出码 0 / ok=true / untracked 0', audit2.code === 0 && audit2.json && audit2.json.ok === true && audit2.json.summary.untracked === 0, JSON.stringify(audit2.json && audit2.json.summary));

// ---------- AC-c6dc-1.2 多轮 RR ----------
fs.mkdirSync(RR_DIR, { recursive: true });
const mkRr = (id, hash, ts, verdict = 'approve') => writeJson(path.join(RR_DIR, `${id}.json`), { id, kind: 'requirement', project: PROJECT, requirementId: REQ, requirementHash: hash, ts, verdict, role: 'product' });
const diskNow = shaFile(docFile);
mkRr('RR-20261115-170100-old1', 'a'.repeat(64), '2026-11-15T09:01:00.000Z');
mkRr('RR-20261115-170200-new1', diskNow, '2026-11-15T09:02:00.000Z');
const auditCur = runJson(['req', 'audit', '--project', PROJECT, '--requirement', REQ]);
const rowCur = (auditCur.json.requirements || []).find((r) => r.requirementId === REQ);
ok('1.2 磁盘 hash=新 RR → matched=current 且无 BINDING 码', rowCur && rowCur.bindings.matched === 'current' && !(rowCur.codes || []).some((c) => c.startsWith('DOC_BINDING')), JSON.stringify(rowCur && rowCur.bindings));
// 把正文改成旧 RR 的 hash（写一个内容使其 sha 等于旧 RR 不现实）→ 用登记/磁盘一致但 RR 指向旧 hash 的方式：改 RR 记录让"当前"=旧 hash
mkRr('RR-20261115-170200-new1', diskNow, '2026-11-15T09:02:00.000Z');
const auditStale = (() => {
  // 构造：磁盘 = 一个"曾出现过"的 hash：直接把旧 RR 的 hash 写成磁盘实值
  const real = shaFile(docFile);
  mkRr('RR-20261115-170100-old1', real, '2026-11-15T09:01:00.000Z');
  mkRr('RR-20261115-170200-new1', 'b'.repeat(64), '2026-11-15T09:02:00.000Z');
  return runJson(['req', 'audit', '--project', PROJECT, '--requirement', REQ]);
})();
const rowStale = (auditStale.json.requirements || []).find((r) => r.requirementId === REQ);
ok('1.2 磁盘 hash=旧 RR → matched=stale + DOC_BINDING_STALE 且 state=ok', rowStale && rowStale.bindings.matched === 'stale' && (rowStale.codes || []).includes('DOC_BINDING_STALE') && rowStale.state === 'ok', JSON.stringify(rowStale && { m: rowStale.bindings.matched, s: rowStale.state, c: rowStale.codes }));
const auditMismatch = (() => {
  mkRr('RR-20261115-170100-old1', 'c'.repeat(64), '2026-11-15T09:01:00.000Z');
  mkRr('RR-20261115-170200-new1', 'd'.repeat(64), '2026-11-15T09:02:00.000Z');
  return runJson(['req', 'audit', '--project', PROJECT, '--requirement', REQ]);
})();
const rowMis = (auditMismatch.json.requirements || []).find((r) => r.requirementId === REQ);
ok('1.2 两边都不等 → matched=none + state=mismatch + 退出码 1', rowMis && rowMis.bindings.matched === 'none' && rowMis.state === 'mismatch' && (rowMis.codes || []).includes('DOC_BINDING_MISMATCH') && auditMismatch.code === 1, JSON.stringify(rowMis && { m: rowMis.bindings.matched, s: rowMis.state }));

// ---------- 登记链自检 + registry_broken ----------
fs.appendFileSync(REGISTRY, '{broken json line\n', 'utf8');
const auditBroken = runJson(['req', 'audit', '--project', PROJECT]);
ok('AC-1.1 登记损坏 → 退出码 2 + state=registry_broken', auditBroken.code === 2 && (auditBroken.json.requirements || []).every((r) => r.state === 'registry_broken'), JSON.stringify({ c: auditBroken.code, s: (auditBroken.json.requirements || []).map((r) => r.state) }));

// ---------- 报告 ----------
const report = { at: new Date().toISOString(), task: 'T-20261115-145649-732e', rule: 'R-c6dc/v1', pass, fail, failures, results };
const outFile = path.join(REPO, '项目', '工作台改造修复', '_tmp', 'doc-writer-run.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`\n=== R-c6dc 工具侧断言：${pass} 通过 / ${fail} 失败 ===`);
for (const f of failures) console.log(`✗ ${f.name}  ${f.detail}`);
console.log(`报告：${outFile}`);
process.exit(fail ? 1 : 0);
