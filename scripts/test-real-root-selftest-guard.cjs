'use strict';
/**
 * 夹具：真实根禁止 --selftest 写 团队.json（P0，2026-11-20 14:18 事故）
 *
 * 事故：用户级 `AWB_TEAM_ROOT` 指向真实仓库时，`--selftest` 只把 `TEAM_ROOT` 指进沙盘；
 * `resolveTeamRoot()` 的 AWB_TEAM_ROOT 优先级更高 → 自测里的 `syncTeamRosterSessions()`
 * 把真实 `团队/状态/团队.json` 整表写回（activeProject 变沙盘项目、六角色 sessionId 清空）。
 *
 * 口径（PM M-20261120-142936-df781c ①「强制沙盘根 或 REAL_ROOT_SELFTEST_REFUSED」）：
 * 硬拒——解析出的团队根不在 SELFTEST_ROOT 内时，`--selftest` 立刻 `REAL_ROOT_SELFTEST_REFUSED`
 * 退出（零写入），真实根不再被当沙盘。
 *
 * 本夹具（按 PM ②「证明跑完真实 团队.json sha 不变」用**真实根**跑）：
 *   U1–U4  `src/selftest-isolation.js` 单测
 *   S1–S3  静态接线（守卫 + REAL_ROOT_SELFTEST_REFUSED + roster_mirror_rewrite 审计）
 *   I1–I5  AWB_TEAM_ROOT=真实仓库团队根，连跑两次 `--selftest`：每次 exit=1 + 硬拒文案、
 *          真实 团队.json sha 不变、沙盘无团队状态（零写入）、总耗时 < 3 分钟
 *
 * 安全：跑前把真实 团队.json 备份到进程内存；万一 sha 变了立即写回并判失败（本夹具自身不制造残留）。
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
const REAL_TEAM_FILE = path.join(ROOT, '团队', '状态', '团队.json');
const sandbox = fs.mkdtempSync(path.join(path.dirname(ROOT), '_selftest-guard-'));
// 安全网：真实 团队.json 备份（万一守卫失效，跑完立刻写回并判失败）
const realBackup = fs.readFileSync(REAL_TEAM_FILE);
const realBefore = sha(realBackup);

try {
  /* ── U：隔离模块单测 ─────────────────────────────────────── */
  {
    check('U1', '模块导出 checkSelftestIsolation/isInsideRoot（纯函数、无 Electron 依赖）',
      typeof iso.checkSelftestIsolation === 'function' && typeof iso.isInsideRoot === 'function', Object.keys(iso));
    check('U2', '包含判定：沙盘内路径通过、真实团队根被拒',
      iso.checkSelftestIsolation({ resolved: path.join(sandbox, '团队'), selftestRoot: sandbox }) === true
      && iso.checkSelftestIsolation({ resolved: path.join(ROOT, '团队'), selftestRoot: sandbox }) === false, { sandbox });
    check('U3', '包含判定大小写不敏感（Windows 盘符/大小写）', iso.isInsideRoot(sandbox, path.join(sandbox, '团队').toUpperCase()) === true, {});
    check('U4', '空 resolved 判失败（宁可拒绝）', iso.checkSelftestIsolation({ resolved: '', selftestRoot: sandbox }) === false, {});
  }

  /* ── S：静态接线 ─────────────────────────────────────────── */
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    check('S1', "main.js 的 IS_SELFTEST 分支调 checkSelftestIsolation（解析出的根必须在 SELFTEST_ROOT 内）",
      /require\('\.\/selftest-isolation'\)/.test(src) && /checkSelftestIsolation\(\{\s*resolved:\s*selftestResolvedRoot/.test(src), {});
    check('S2', 'main.js 有 REAL_ROOT_SELFTEST_REFUSED 硬拒（process.exit(1)，零写入）',
      /REAL_ROOT_SELFTEST_REFUSED/.test(src) && /process\.exit\(1\)/.test(src), {});
    check('S3', '团队.json 整表写回留 roster_mirror_rewrite 审计（syncTeamRosterSessions）',
      /roster_mirror_rewrite/.test(src) && /syncTeamRosterSessions'/.test(src), {});
  }

  /* ── I：真实根连跑两次（应快速硬拒） ─────────────────────── */
  const env = { ...process.env };
  env.AWB_TEAM_ROOT = path.join(ROOT, '团队');
  env.TEAM_ROOT = path.join(ROOT, '团队');
  env.TEAM_PROJECTS_ROOT = path.join(ROOT, '项目');
  env.AWB_SELFTEST_ROOT = sandbox;
  env.AWB_DATA_DIR = path.join(sandbox, 'data');
  delete env.TEAM_SELFTEST;

  const perRun = [];
  for (let run = 1; run <= RUNS; run += 1) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--selftest'], {
      cwd: ROOT, env, encoding: 'utf8', timeout: TIMEOUT, maxBuffer: 64 * 1024 * 1024,
    });
    const elapsedMs = Date.now() - t0;
    const out = String(r.stdout || '') + String(r.stderr || '');
    const after = shaFile(REAL_TEAM_FILE);
    perRun.push({ run, code: r.status, signal: r.signal, elapsedMs, refused: /REAL_ROOT_SELFTEST_REFUSED/.test(out), after });
    check(`I${run}a`, `第 ${run} 次 --selftest（AWB_TEAM_ROOT=真实团队根）：exit=1 且输出 REAL_ROOT_SELFTEST_REFUSED`,
      r.status === 1 && /REAL_ROOT_SELFTEST_REFUSED/.test(out), { code: r.status, signal: r.signal, refused: perRun[run - 1].refused });
    check(`I${run}b`, `第 ${run} 次 --selftest 后：真实 团队.json sha 不变（禁写真实根）`,
      after === realBefore, { before: realBefore, after, elapsedMs });
  }
  check('I3', '零写入：沙盘目录里没有 团队/状态/团队.json（拒绝发生在任何写盘之前）',
    !fs.existsSync(path.join(sandbox, '团队', '状态', '团队.json')), { sandbox });
  check('I4', '连跑结束：真实 团队.json 仍逐字节不变', shaFile(REAL_TEAM_FILE) === realBefore, { before: realBefore, after: shaFile(REAL_TEAM_FILE) });
  const totalMs = perRun.reduce((a, x) => a + x.elapsedMs, 0);
  check(`I5 连跑 ${RUNS} 次总耗时 ${totalMs}ms（<180000 = 3 分钟内连跑两次）`, totalMs < 180000, perRun.map((x) => x.elapsedMs));
  console.log('SELFTEST_GUARD_RUNS ' + JSON.stringify({ runs: perRun, totalMs }));
} finally {
  // 安全网：真实 团队.json 若被任何路径改动 → 写回备份（并已在上面判 FAIL）
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
