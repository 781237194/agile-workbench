#!/usr/bin/env node
'use strict';
/**
 * test-1749-anchor.cjs —— P2 T-20261120-015736-1749（R-af15 内容快照锚点）夹具
 *
 * 覆盖正文 §八 的 AC1–AC6 + AC8 的「只读」面；AC7 的四处施工点另见实现说明（本期只做核心 CLI + 证据锚点字段）。
 *
 * 断言分组：
 *   AC1 cite 正常 / 白名单拒绝（_tmp、证据-x、仓库外）/ 沙盘 TEAM_SELFTEST=1 放行 _tmp
 *   AC2 快照一致 matched:'snapshot'
 *   AC3 加 3 行 → fingerprint 且行号 +3
 *   AC4 改锚点行内容 → ANCHOR_STALE（exit 2 + currentFileSha12 + next）
 *   AC5 ①重复行→ANCHOR_AMBIGUOUS（exit 2 + candidates）②删文件→ANCHOR_FILE_MISSING（exit 3）③格式错→ANCHOR_BAD_FORMAT（exit 1）
 *   AC6 归一化：行首空格/行尾 tab 同 lineSha12；CRLF/LF 文件 sha 不同但 fingerprint 命中且行号相同；BOM 首行正常
 *   AC8 anchor 只读：真实 团队/、data/userdata、项目/ 三处 sha256 前后不变
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const JSON_OUT = process.argv.includes('--json');

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const shaFile = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '-'; } };
const shaDir = (dir) => {
  try {
    const out = [];
    const walk = (d, depth) => {
      if (depth > 3) return;
      let names = [];
      try { names = fs.readdirSync(d); } catch { return; }
      for (const n of names.sort()) {
        const p = path.join(d, n);
        let st = null;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p, depth + 1);
        else { try { out.push(`${path.relative(dir, p)}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 8)}`); } catch { /* skip */ } }
      }
    };
    walk(dir, 0);
    return crypto.createHash('sha256').update(out.join('\n')).digest('hex');
  } catch { return '-'; }
};
const lineSha12 = (line) => crypto.createHash('sha256').update(String(line).replace(/^[ \t\r]+/, '').replace(/[ \t\r]+$/, ''), 'utf8').digest('hex').slice(0, 12);

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'b1749-'));
// 夹具文件必须落在仓库根的 _tmp/ 下（正文 6.1 沙盘例外）
const FIX = path.join(ROOT, '_tmp', 'anchor-fixture-1749');
fs.mkdirSync(FIX, { recursive: true });

function run(args, env = {}) {
  const e = { ...process.env, TEAM_SELFTEST: '1', ...env };
  delete e.DSH_SESSION_ID;
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: e, cwd: ROOT, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status == null ? -1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function runJson(args, env = {}) {
  const r = run(args, env);
  const t = `${r.out}${r.err}`;
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}
const relOf = (abs) => path.relative(ROOT, abs).replace(/\\/g, '/');

function main() {
  let exitCode = 0;
  const realTeam = shaDir(path.join(ROOT, '团队', '工具'));
  const realStore = shaFile(path.join(ROOT, 'data', 'userdata', 'workbench.json'));
  const realProjects = shaDir(path.join(ROOT, '项目'));
  try {
    /* ── AC1 cite 正常 ─────────────────────────────────────── */
    const f1 = path.join(FIX, 'cite.md');
    fs.writeFileSync(f1, ['alpha', 'beta', 'gamma', 'delta'].join('\n') + '\n', 'utf8');
    const c1 = runJson(['anchor', 'cite', relOf(f1), '--line', '2', '--json']);
    check('AC1 cite 正常：ok:true、lineNo=2、两段 12 位小写 hex、lineSha12 与独立复算一致',
      Boolean(c1.json) && c1.json.ok === true && c1.json.lineNo === 2
      && /^[0-9a-f]{12}$/.test(String(c1.json.fileSha12)) && /^[0-9a-f]{12}$/.test(String(c1.json.lineSha12))
      && c1.json.lineSha12 === lineSha12('beta') && c1.status === 0,
      { json: c1.json, status: c1.status });

    /* ── AC1 白名单：非沙盘下 _tmp 拒绝 ─────────────────────── */
    const cWl = runJson(['anchor', 'cite', relOf(f1), '--line', '1', '--json'], { TEAM_SELFTEST: '' });
    check('AC1b 非沙盘下 _tmp/ 路径 → ANCHOR_PATH_OUTSIDE（exit 1）',
      cWl.json && cWl.json.code === 'ANCHOR_PATH_OUTSIDE' && cWl.status === 1, { json: cWl.json, status: cWl.status });
    const cOut = runJson(['anchor', 'cite', 'C:/Windows/win.ini', '--line', '1', '--json']);
    check('AC1c 仓库外路径 → ANCHOR_PATH_OUTSIDE', cOut.json && cOut.json.code === 'ANCHOR_PATH_OUTSIDE', { json: cOut.json });

    /* ── AC2 快照一致 ─────────────────────────────────────── */
    const k2 = runJson(['anchor', 'check', String(c1.json.anchor), '--json']);
    check("AC2 未改文件 → matched:'snapshot'、lineNo=2、exit 0",
      k2.json && k2.json.matched === 'snapshot' && k2.json.lineNo === 2 && k2.status === 0, { json: k2.json, status: k2.status });

    /* ── AC3 前插 3 行 → fingerprint + 行号 +3 ─────────────── */
    fs.writeFileSync(f1, ['x1', 'x2', 'x3', 'alpha', 'beta', 'gamma', 'delta'].join('\n') + '\n', 'utf8');
    const k3 = runJson(['anchor', 'check', String(c1.json.anchor), '--json']);
    check("AC3 前插 3 行 → matched:'fingerprint'、lineNo=5、exit 0",
      k3.json && k3.json.matched === 'fingerprint' && k3.json.lineNo === 5 && k3.status === 0, { json: k3.json, status: k3.status });

    /* ── AC4 改内容 → STALE ───────────────────────────────── */
    fs.writeFileSync(f1, ['x1', 'x2', 'x3', 'alpha', 'BETA-CHANGED', 'gamma', 'delta'].join('\n') + '\n', 'utf8');
    const k4 = runJson(['anchor', 'check', String(c1.json.anchor), '--json']);
    check('AC4 锚点行内容被改 → ANCHOR_STALE（exit 2 + currentFileSha12 + next）',
      k4.json && k4.json.code === 'ANCHOR_STALE' && k4.status === 2
      && Boolean((k4.json.details || {}).currentFileSha12) && Boolean((k4.json.details || {}).next),
      { json: k4.json, status: k4.status });

    /* ── AC5 ① 重复行 → AMBIGUOUS ─────────────────────────── */
    const f5 = path.join(FIX, 'dup.md');
    fs.writeFileSync(f5, ['dup-line', 'other', 'dup-line'].join('\n') + '\n', 'utf8');
    const c5 = runJson(['anchor', 'cite', relOf(f5), '--line', '1', '--json']);
    // 先把文件改掉一行，让 fileSha12 变化 → 走指纹分支才会命中两处
    fs.writeFileSync(f5, ['dup-line', 'other', 'xx', 'dup-line'].join('\n') + '\n', 'utf8');
    const k5 = runJson(['anchor', 'check', String(c5.json.anchor), '--json']);
    check('AC5① 同行内容出现两次 → ANCHOR_AMBIGUOUS（exit 2 + candidates 数组）',
      k5.json && k5.json.code === 'ANCHOR_AMBIGUOUS' && k5.status === 2
      && Array.isArray((k5.json.details || {}).candidates) && (k5.json.details.candidates.length >= 2),
      { json: k5.json, status: k5.status });

    /* ── AC5 ② 删文件 → FILE_MISSING ──────────────────────── */
    const f6 = path.join(FIX, 'gone.md');
    fs.writeFileSync(f6, 'one\ntwo\n', 'utf8');
    const c6 = runJson(['anchor', 'cite', relOf(f6), '--line', '1', '--json']);
    fs.rmSync(f6, { force: true });
    const k6 = runJson(['anchor', 'check', String(c6.json.anchor), '--json']);
    check('AC5② 文件被删 → ANCHOR_FILE_MISSING（exit 3）',
      k6.json && k6.json.code === 'ANCHOR_FILE_MISSING' && k6.status === 3, { json: k6.json, status: k6.status });

    /* ── AC5 ③ 格式错 → BAD_FORMAT ────────────────────────── */
    const k7 = runJson(['anchor', 'check', 'no-hash-here', '--json']);
    const k7b = runJson(['anchor', 'check', `${relOf(f1)}#abc:def`, '--json']);
    check('AC5③ 格式非法（无 # / hex 长度错）→ ANCHOR_BAD_FORMAT（exit 1）',
      k7.json && k7.json.code === 'ANCHOR_BAD_FORMAT' && k7.status === 1
      && k7b.json && k7b.json.code === 'ANCHOR_BAD_FORMAT', { k7: k7.json && k7.json.code, k7b: k7b.json && k7b.json.code });

    /* ── AC6 归一化 ───────────────────────────────────────── */
    const fa = path.join(FIX, 'norm-a.md');
    const fb = path.join(FIX, 'norm-b.md');
    fs.writeFileSync(fa, 'HEAD\n  padded line\t\n', 'utf8');
    fs.writeFileSync(fb, 'HEAD\npadded line\n', 'utf8');
    const ca = runJson(['anchor', 'cite', relOf(fa), '--line', '2', '--json']);
    const cb = runJson(['anchor', 'cite', relOf(fb), '--line', '2', '--json']);
    check('AC6a 行首空格+行尾 tab 与 原样 → lineSha12 相同',
      ca.json && cb.json && ca.json.lineSha12 === cb.json.lineSha12,
      { a: ca.json && ca.json.lineSha12, b: cb.json && cb.json.lineSha12 });
    const fc1 = path.join(FIX, 'crlf.md');
    const fc2 = path.join(FIX, 'lf.md');
    fs.writeFileSync(fc1, 'k1\r\nshared line\r\nk3\r\n', 'utf8');
    fs.writeFileSync(fc2, 'k1\nshared line\nk3\n', 'utf8');
    const cc = runJson(['anchor', 'cite', relOf(fc1), '--line', '2', '--json']);
    const kc = runJson(['anchor', 'check', String(cc.json.anchor), '--file', relOf(fc2), '--json']);
    check("AC6b CRLF 与 LF 文件 sha12 不同 → check 走 matched:'fingerprint' 且 lineNo 相同",
      cc.json && kc.json && cc.json.fileSha12 !== runJson(['anchor', 'cite', relOf(fc2), '--line', '2', '--json']).json.fileSha12
      && kc.json.matched === 'fingerprint' && kc.json.lineNo === 2,
      { crlfFile: cc.json && cc.json.fileSha12, matched: kc.json && kc.json.matched, lineNo: kc.json && kc.json.lineNo });
    const fbom = path.join(FIX, 'bom.md');
    fs.writeFileSync(fbom, '\uFEFFfirst-line-after-bom\nsecond\n', 'utf8');
    const cbom = runJson(['anchor', 'cite', relOf(fbom), '--line', '1', '--json']);
    check('AC6c 含 BOM 文件首行 cite 正常（剥 BOM 后取行）',
      cbom.json && cbom.json.ok === true && cbom.json.lineNo === 1, { json: cbom.json });
  } catch (e) {
    check('夹具未抛异常', false, { error: String((e && e.stack) || e).slice(0, 700) });
  } finally {
    try { fs.rmSync(FIX, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
    const afterTeam = shaDir(path.join(ROOT, '团队', '工具'));
    const afterStore = shaFile(path.join(ROOT, 'data', 'userdata', 'workbench.json'));
    const afterProjects = shaDir(path.join(ROOT, '项目'));
    check('AC8 anchor 全程只读：团队/工具、data/userdata/workbench.json、项目/ 三处 sha256 前后不变',
      afterTeam === realTeam && afterStore === realStore && afterProjects === realProjects,
      { team: [realTeam.slice(0, 12), afterTeam.slice(0, 12)], store: [realStore.slice(0, 12), afterStore.slice(0, 12)], projects: [realProjects.slice(0, 12), afterProjects.slice(0, 12)] });
    const failed = ROWS.filter((r) => r.ok !== true);
    if (!JSON_OUT) {
      console.log(`\n${ROWS.length - failed.length}/${ROWS.length} PASS${failed.length ? ` · ${failed.length} FAIL` : ''}`);
      if (failed.length) console.log('失败项：' + failed.map((r) => r.name).join(' | '));
    } else {
      console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed.length, failed: failed.map((r) => r.name), rows: ROWS }, null, 2));
    }
    if (failed.length) exitCode = 1;
  }
  process.exit(exitCode);
}
main();
