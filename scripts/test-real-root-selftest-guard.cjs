'use strict';
/**
 * 夹具：真实根禁止 --selftest（P0 B-20261120-142335-ba8e，PM 14:39 追加「继承污染」）
 *
 * 事故：宿主用户级 env `AWB_TEAM_ROOT`（以及 TEAM_ROOT/AWB_STORE/AWB_DATA_DIR）会被 Electron 子进程继承；
 * `resolveTeamRoot()` 的 AWB_TEAM_ROOT 优先级高于 `--selftest` 注入的 TEAM_ROOT → 自测
 * `syncTeamRosterSessions()` 把真实 `团队/状态/团队.json` 整表写回（activeProject/sessionId 被沙盘覆盖）。
 *
 * 口径（PM M-20261120-142936-df781c ①「强制沙盘根 或 REAL_ROOT_SELFTEST_REFUSED」+ 14:39 继承污染）：
 * 硬拒——解析出的团队根不在 SELFTEST_ROOT 内时立刻 `REAL_ROOT_SELFTEST_REFUSED`（零写入）；
 * 硬拒文案带 `inherited`（四个键里指向真实仓库的项），便于运维定位。
 *
 * 夹具（用真实根跑，按 PM ②「证明跑完真实 团队.json 与 workbench.json sha 不变」）：
 *   U1–U5  隔离模块单测（包含判定/大小写/空值/继承污染识别）
 *   S1–S4  静态接线（守卫、硬拒、写回审计、AWB_DATA_DIR 改道）
 *   I1–I6  AWB_TEAM_ROOT/TEAM_ROOT/AWB_STORE/AWB_DATA_DIR 全指真实根，连跑两次 --selftest：
 *          每次 exit=1 + 硬拒 + inherited 含四项、真实 团队.json/workbench.json sha 不变、
 *          沙盘零写入、总耗时 <3 分钟
 *
 * 安全：跑前备份真实 团队.json；若被任何路径改动 → 写回备份并判失败（本夹具自身不留残留）。
 * 跑法：node scripts/test-real-root-selftest-guard.cjs [--runs 2] [--timeout-ms 120000]
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const RUNS = Math.max(1, Number(argOf('--runs', '2')) || 2);
const TIMEOUT = Math.max(30000, Number(argOf('--timeout-ms', '120000')) || 120000);
const RESULT = [];
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const shaFile = (f) => { try { return sha(fs.readFileSync(f)); } catch { return '(missing)'; } };
function check(id, title, ok, detail) {
  RESULT.push({ id, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${title}${ok ? '' : '  ← ' + String(JSON.stringify(detail === undefined ? '' : detail)).slice(0, 400)}`);
  if (!ok) process.exitCode = 1;
}

const iso = require(path.join(ROOT, 'src', 'selftest-isolation.js'));
const REAL_TEAM_ROOT = path.join(ROOT, '团队');
const REAL_TEAM_FILE = path.join(REAL_TEAM_ROOT, '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const REAL_DATA = path.join(ROOT, 'data');
const sandbox = fs.mkdtempSync(path.join(path.dirname(ROOT), '_selftest-guard-'));
const realBackup = fs.readFileSync(REAL_TEAM_FILE);
const realBefore = sha(realBackup);
const storeBefore = shaFile(REAL_STORE);

try {
  /* ── U：隔离模块单测 ─────────────────────────────────────── */
  {
    check('U1', '模块导出 checkSelftestIsolation/isInsideRoot/inheritedRealRoots（纯函数、无 Electron 依赖）',
      ['checkSelftestIsolation', 'isInsideRoot', 'inheritedRealRoots'].every((k) => typeof iso[k] === 'function'), Object.keys(iso));
    check('U2', '包含判定：沙盘内路径通过、真实团队根被拒',
      iso.checkSelftestIsolation({ resolved: path.join(sandbox, '团队'), selftestRoot: sandbox }) === true
      && iso.checkSelftestIsolation({ resolved: REAL_TEAM_ROOT, selftestRoot: sandbox }) === false, { sandbox });
    check('U3', '包含判定大小写不敏感（Windows 盘符/大小写）', iso.isInsideRoot(sandbox, path.join(sandbox, '团队').toUpperCase()) === true, {});
    check('U4', '空 resolved 判失败（宁可拒绝）', iso.checkSelftestIsolation({ resolved: '', selftestRoot: sandbox }) === false, {});
    const list = iso.inheritedRealRoots(
      { AWB_TEAM_ROOT: REAL_TEAM_ROOT, TEAM_ROOT: REAL_TEAM_ROOT, AWB_STORE: REAL_STORE, AWB_DATA_DIR: REAL_DATA },
      { realTeamRoot: REAL_TEAM_ROOT, realStore: REAL_STORE, realDataDir: REAL_DATA },
    );
    check('U5', '继承污染识别：四个键全指真实根时全部命中；沙盘 env 不命中',
      list.length === 4 && list.some((x) => x.startsWith('AWB_TEAM_ROOT=')) && list.some((x) => x.startsWith('AWB_DATA_DIR='))
      && iso.inheritedRealRoots({ AWB_TEAM_ROOT: path.join(sandbox, '团队') }, { realTeamRoot: REAL_TEAM_ROOT, realStore: REAL_STORE, realDataDir: REAL_DATA }).length === 0,
      { list });
  }

  /* ── S：静态接线 ─────────────────────────────────────────── */
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    check('S1', "main.js 的 IS_SELFTEST 分支调 checkSelftestIsolation（解析出的根必须在 SELFTEST_ROOT 内）",
      /require\('\.\/selftest-isolation'\)/.test(src) && /checkSelftestIsolation\(\{\s*resolved:\s*selftestResolvedRoot/.test(src), {});
    check('S2', 'main.js 有 REAL_ROOT_SELFTEST_REFUSED 硬拒（process.exit(1)，零写入）+ inherited 清单',
      /REAL_ROOT_SELFTEST_REFUSED/.test(src) && /process\.exit\(1\)/.test(src) && /inherited:\s*selftestInherited/.test(src), {});
    check('S3', '团队.json 整表写回留 roster_mirror_rewrite 审计（syncTeamRosterSessions）',
      /roster_mirror_rewrite/.test(src) && /syncTeamRosterSessions'/.test(src), {});
    check('S4', '自测把 AWB_DATA_DIR 也指进沙盘（防宿主继承真实 data/）',
      /process\.env\.AWB_DATA_DIR = SELFTEST_ROOT/.test(src), {});
  }

  /* ── I：继承污染 + 真实根连跑两次（应快速硬拒） ───────────── */
  const env = { ...process.env };
  env.AWB_TEAM_ROOT = REAL_TEAM_ROOT;
  env.TEAM_ROOT = REAL_TEAM_ROOT;
  env.AWB_STORE = REAL_STORE;
  env.AWB_DATA_DIR = REAL_DATA;
  env.AWB_SELFTEST_ROOT = sandbox;
  delete env.TEAM_SELFTEST;

  const perRun = [];
  for (let run = 1; run <= RUNS; run += 1) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--selftest'], {
      cwd: ROOT, env, encoding: 'utf8', timeout: TIMEOUT, maxBuffer: 64 * 1024 * 1024,
    });
    const elapsedMs = Date.now() - t0;
    const out = String(r.stdout || '') + String(r.stderr || '');
    const inheritedOk = ['AWB_TEAM_ROOT=', 'TEAM_ROOT=', 'AWB_STORE=', 'AWB_DATA_DIR='].every((k) => new RegExp('inherited[^\\]]*' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(out));
    perRun.push({ run, code: r.status, signal: r.signal, elapsedMs, refused: /REAL_ROOT_SELFTEST_REFUSED/.test(out), inheritedOk });
    check(`I${run}a`, `第 ${run} 次 --selftest：exit=1 + REAL_ROOT_SELFTEST_REFUSED + inherited 含四键`,
      r.status === 1 && /REAL_ROOT_SELFTEST_REFUSED/.test(out) && inheritedOk, { code: r.status, refused: perRun[run - 1].refused, inheritedOk });
    check(`I${run}b`, `第 ${run} 次 --selftest 后：真实 团队.json 与 workbench.json sha 均不变`,
      shaFile(REAL_TEAM_FILE) === realBefore && shaFile(REAL_STORE) === storeBefore,
      { teamBefore: realBefore, teamAfter: shaFile(REAL_TEAM_FILE), storeBefore, storeAfter: shaFile(REAL_STORE) });
  }
  check('I3', '零写入：沙盘目录里没有 团队/状态/团队.json（拒绝发生在任何写盘之前）',
    !fs.existsSync(path.join(sandbox, '团队', '状态', '团队.json')), { sandbox });
  check('I4', '连跑结束：真实 团队.json / workbench.json 仍逐字节不变',
    shaFile(REAL_TEAM_FILE) === realBefore && shaFile(REAL_STORE) === storeBefore, {});
  const totalMs = perRun.reduce((a, x) => a + x.elapsedMs, 0);
  check(`I5 连跑 ${RUNS} 次总耗时 ${totalMs}ms（<180000 = 3 分钟内连跑两次）`, totalMs < 180000, perRun.map((x) => x.elapsedMs));
  console.log('SELFTEST_GUARD_RUNS ' + JSON.stringify({ runs: perRun, totalMs }));
} finally {
  try {
    const now = fs.readFileSync(REAL_TEAM_FILE);
    if (sha(now) !== realBefore) {
      fs.writeFileSync(REAL_TEAM_FILE, realBackup);
      console.error('GUARD_SAFETY_RESTORE 真实 团队.json 被改动，已写回备份');
    }
  } catch { /* ignore */ }
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
}
const pass = RESULT.filter((x) => x.ok).length;
console.log(`\n${pass}/${RESULT.length} PASS`);
if (pass !== RESULT.length) process.exitCode = 1;
