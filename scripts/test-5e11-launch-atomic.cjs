#!/usr/bin/env node
'use strict';
/**
 * test-5e11-launch-atomic.cjs —— B-20261118-163847-5e11 夹具：launch.mjs 的 团队会话.json 必须原子写
 *
 * 背景（B 交叉审计 P2-1/PM 立 P1）：launch.mjs 原用裸 fs.writeFileSync 写 团队会话.json / workspace.json，
 * 而 session.mjs/roster-writer 用 json-atomic 写同一份 团队会话.json → 双写者、两种原子性；崩溃/并发可能留半截 JSON。
 *
 * 断言：
 *   A1 源码：团队会话.json 与 workspace.json 均走 writeJsonAtomic（且无同名裸写）；.md 展示件保留裸写且有注释
 *   A2 writeJsonAtomic 首次写：返回 ok/sha，文件内容与输入一致，无残留 .tmp
 *   A3 二次写：prevSha=首版 sha，.bak 保留首版内容（原子备份语义，崩溃可回滚）
 *   A4 越界路径被拒（BAD_PATH，allowedRoots 之外）
 *   A5 中断注入：先放一个半截 .tmp 再写 → 最终文件合法、旧 .tmp 不影响
 *   A6 隔离：真实 团队/状态/团队.json、data/userdata/workbench.json 前后 sha256 不变
 * 用法：node scripts/test-5e11-launch-atomic.cjs [--json] [--out <json>]
 * 退出码：0 全过 / 1 有断言失败
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const SB = mkTempSandbox('5e11');
const WS = path.join(SB, 'ws');
const OUTSIDE = path.join(SB, 'outside');
const LAUNCH = path.join(ROOT, '团队', '工具', 'launch.mjs');
const ATOMIC = path.join(ROOT, '团队', '工具', 'lib', 'json-atomic.mjs');
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const JSON_OUT = process.argv.includes('--json');
const OUT_ARG = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(String(process.argv[i + 1])) : ''; })();

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 600)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };

(async () => {
  const realBefore = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
  fs.mkdirSync(WS, { recursive: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });

  /* A1 源码静态口径 */
  const src = fs.readFileSync(LAUNCH, 'utf8');
  const manifestLine = src.split(/\r?\n/).find((l) => /团队会话\.json/.test(l) && /writeJsonAtomic|writeFileSync/.test(l)) || '';
  const metaLine = src.split(/\r?\n/).find((l) => /writeJsonAtomic\(metaFile/.test(l)) || '';
  const mdLineIdx = src.split(/\r?\n/).findIndex((l) => /团队会话\.md/.test(l) && /writeFileSync/.test(l));
  const mdLines = src.split(/\r?\n/);
  check('A1a 团队会话.json 走 writeJsonAtomic，且无同名裸写',
    /writeJsonAtomic\(/.test(manifestLine) && !/writeFileSync/.test(manifestLine)
    && !/writeFileSync\(path\.join\(workspace,\s*'团队会话\.json'\)/.test(src),
    { manifestLine });
  check('A1b workspace.json（metaFile）也走 writeJsonAtomic',
    Boolean(metaLine) && !/writeFileSync\(metaFile/.test(src), { metaLine });
  check('A1c 团队会话.md 保留裸写但注明「展示件/非状态」（不参与判定）',
    mdLineIdx >= 0 && /展示件|非状态|不参与/.test(mdLines[mdLineIdx - 1] || ''), { mdLine: mdLines[mdLineIdx] });

  /* A2–A5 json-atomic 行为 */
  const atomic = await import(pathToFileURL(ATOMIC).href);
  const target = path.join(WS, '团队会话.json');
  const v1 = { project: '夹具', generatedAt: 'v1', roles: [{ role: 'pm', sessionId: 's1' }] };
  const r1 = atomic.writeJsonAtomic(target, v1, { case: 'test-5e11', allowedRoots: [WS] });
  check('A2 首次原子写：返回 ok + sha，内容与输入一致，无 .tmp 残留',
    r1 && r1.ok === true && Boolean(r1.sha256) && r1.bytes > 0
    && JSON.stringify(readJson(target, null)) === JSON.stringify(v1)
    && !fs.existsSync(target + '.tmp'),
    { r1, files: fs.readdirSync(WS) });

  const v2 = { ...v1, generatedAt: 'v2' };
  const r2 = atomic.writeJsonAtomic(target, v2, { case: 'test-5e11', allowedRoots: [WS] });
  const bak = readJson(target + '.bak', null);
  check('A3 二次写：prevSha=首版 sha，.bak 保留首版内容（崩溃可回滚）',
    r2 && r2.prevSha === r1.sha256 && JSON.stringify(bak) === JSON.stringify(v1)
    && JSON.stringify(readJson(target, null)) === JSON.stringify(v2),
    { prevSha: r2 && r2.prevSha, firstSha: r1.sha256, bak: bak && bak.generatedAt });

  let badPathErr = null;
  try { atomic.writeJsonAtomic(path.join(OUTSIDE, '团队会话.json'), { x: 1 }); } catch (e) { badPathErr = e; }
  check('A4 allowedRoots 之外的路径被拒（BAD_PATH），不越界写',
    Boolean(badPathErr) && String(badPathErr.code) === 'BAD_PATH' && !fs.existsSync(path.join(OUTSIDE, '团队会话.json')),
    { code: badPathErr && badPathErr.code });

  // A5：模拟「上次写一半崩溃」留下的 .tmp 再写（不应读它，也不应产生半截终态）
  fs.writeFileSync(target + '.tmp', '{"half":', 'utf8');
  const v3 = { ...v1, generatedAt: 'v3' };
  const r3 = atomic.writeJsonAtomic(target, v3, { case: 'test-5e11', allowedRoots: [WS] });
  check('A5 残留半截 .tmp + 再写 → 终态文件合法（无半截 JSON），.tmp 不参与读取',
    r3 && r3.ok === true && JSON.stringify(readJson(target, null)) === JSON.stringify(v3),
    { r3, final: readJson(target, null), files: fs.readdirSync(WS) });

  check('A6 隔离：真实 团队.json / workbench.json 前后 sha256 不变',
    sha(REAL_TEAM) === realBefore.team && sha(REAL_STORE) === realBefore.store,
    { teamSame: sha(REAL_TEAM) === realBefore.team, storeSame: sha(REAL_STORE) === realBefore.store });

  const failed = results.filter((r) => !r.ok);
  const payload = { ok: failed.length === 0, total: results.length, passed: results.length - failed.length, failed: failed.length, sandbox: SB, at: new Date().toISOString(), checks: results };
  if (OUT_ARG) { try { fs.mkdirSync(path.dirname(OUT_ARG), { recursive: true }); fs.writeFileSync(OUT_ARG, JSON.stringify(payload, null, 2) + '\n', 'utf8'); } catch { /* ignore */ } }
  if (JSON_OUT) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log('');
    for (const f of failed) console.log(`FAILED  ${f.name} :: ${String(JSON.stringify(f.detail)).slice(0, 500)}`);
    console.log(`5E11 LAUNCH ATOMIC CHECK ${failed.length ? 'FAIL' : 'OK'} ${results.length - failed.length}/${results.length} PASS`);
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('5E11 CHECK ERROR ' + String((e && e.stack) || e)); process.exit(1); });
