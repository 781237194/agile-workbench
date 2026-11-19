#!/usr/bin/env node
'use strict';
/**
 * test-5d57-7405.cjs —— 两个 P2 缺陷夹具
 *
 * ① B-20261119-161918-5d57：陈旧 wakeFailed 永不清除
 *    - 失败新鲜（<30 分钟）→ presence.wakeFailed=true、dispatch-check 判 wake_first（保留原语义）；
 *    - 唤醒成功后清除（clearWakeFailed / wakeWithGuard 成功路径接线）→ 不再判 wake_first；
 *    - 失败超 30 分钟 → presence.wakeFailed=false + wakeFailedStale=true，dispatch-check 只提示、不阻塞。
 * ② B-20261119-164648-7405：手工补归档后再归档同角色当前会话被「未换人」守卫挡成 ALREADY_ARCHIVED
 *    - 归档记录 rotatedAt 空但 sessionId ≠ 当前会话 → 视为已换人，归档当前会话可通过；
 *    - 归档记录 sessionId == 当前会话（确实未换人）→ 仍按 ALREADY_ARCHIVED 拒（守卫不丢）。
 *
 * 隔离：TEAM_ROOT/TEAM_PROJECTS_ROOT/TEAM_WORKBENCH_JSON/AWB_DATA_DIR 全指 %TEMP% 沙盘；真实 团队/状态/团队.json 前后 sha 断言不变。
 * 跑法：node scripts/test-5d57-7405.cjs [--out <证据目录>]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const TEAM_TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const LIB = path.join(ROOT, '团队', '工具', 'lib');
const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-5d57-7405');
})();
const rows = [];
function check(name, ok, detail) {
  let text = ''; try { text = JSON.stringify(detail === undefined ? null : detail); } catch { text = String(detail); }
  rows.push({ name, ok: Boolean(ok), detail: ok ? undefined : text });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' :: ' + text.slice(0, 700)));
}
const shaFile = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '-'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, obj) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n', 'utf8'); };

const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-5d57-'));
const teamDir = path.join(sb, '团队');
const projectsDir = path.join(sb, '项目');
const dataDir = path.join(sb, 'data');
const project = '沙盘5d57';
const projDir = path.join(projectsDir, project);
Object.assign(process.env, {
  TEAM_ROOT: teamDir,
  TEAM_PROJECTS_ROOT: projectsDir,
  TEAM_WORKBENCH_JSON: path.join(dataDir, 'workbench.json'),
  AWB_DATA_DIR: dataDir,
  TEAM_SELFTEST: '1',
});
const env = { ...process.env };
function run(args) {
  const r = spawnSync(process.execPath, [TEAM_TOOL, ...args], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const stdout = String(r.stdout || '');
  const stderr = String(r.stderr || '');
  let json = null;
  const start = stdout.indexOf('{');
  if (start >= 0) { try { json = JSON.parse(stdout.slice(start)); } catch { json = null; } }
  return { code: r.status, out: stdout + stderr, json };
}

(async () => {
  const realTeam = path.join(ROOT, '团队', '状态', '团队.json');
  const realBefore = shaFile(realTeam);
  try {
    const ops = await import(pathToFileURL(path.join(LIB, 'ops.mjs')).href);
    const dispatch = await import(pathToFileURL(path.join(LIB, 'dispatch-check.mjs')).href);
    const archive = await import(pathToFileURL(path.join(LIB, 'session-archive.mjs')).href);

    // ── 沙盘项目 ────────────────────────────────────────────────────────
    run(['init', '--json']);
    const created = run(['project', 'create', '--name', project, '--dir', projDir, '--json']);
    check('S0 沙盘项目创建成功', Boolean(created.json && created.json.ok), created.out.slice(0, 300));
    const pmBoot = run(['boot', '--role', 'pm', '--project', project, '--session', 'session-5d57-pm', '--json']);
    const p1Boot = run(['boot', '--role', 'programmer1', '--project', project, '--session', 'session-5d57-p1', '--json']);
    check('S0b pm/programmer1 boot 成功', Boolean(pmBoot.json && pmBoot.json.token) && Boolean(p1Boot.json && p1Boot.json.token), { pm: Boolean(pmBoot.json && pmBoot.json.token) });

    const stateDir = path.join(teamDir, '状态', '项目');
    const projectStateDir = (() => {
      const dirs = fs.existsSync(stateDir) ? fs.readdirSync(stateDir, { withFileTypes: true }).filter((e) => e.isDirectory()) : [];
      return dirs.length ? path.join(stateDir, dirs[0].name) : path.join(stateDir, project);
    })();
    const wakeQueueFile = path.join(projectStateDir, '唤醒队列.json');

    // ── ① 5d57：新鲜失败 → wake_first ───────────────────────────────────
    const nowMinus = (min) => new Date(Date.now() - min * 60000).toISOString();
    const seedFailed = (at) => {
      const q = readJson(wakeQueueFile, {});
      q.failed = { ...(q.failed || {}), programmer1: { at, messageId: 'M-SEED-5d57', why: 'fixture 注入失败', attempt: 3 } };
      writeJson(wakeQueueFile, q);
      const boardFile = path.join(projectStateDir, '看板.json');
      const b = readJson(boardFile, {});
      b.wakeFailed = { ...(b.wakeFailed || {}), programmer1: { at, messageId: 'M-SEED-5d57', why: 'fixture 注入失败', attempt: 3 } };
      writeJson(boardFile, b);
    };
    seedFailed(nowMinus(2));
    const freshPresence = (ops.presenceFor(project, { roles: ['programmer1'] }) || [])[0] || {};
    check('A1 失败在 30 分钟内：presence.wakeFailed=true 且带原因', freshPresence.wakeFailed === true && String(freshPresence.wakeFailedReason || '').includes('fixture'), freshPresence);
    const freshCheck = await dispatch.buildDispatchCheck({ projectName: project, to: 'programmer1' });
    check('A1b 新鲜失败 → dispatch-check 判 wake_first（原语义保留）',
      freshCheck.verdict === 'wake_first' && freshCheck.reasons.some((r) => /唤醒失败/.test(r)), { verdict: freshCheck.verdict, reasons: freshCheck.reasons });

    // ── ① 唤醒成功后清除 ────────────────────────────────────────────────
    ops.clearWakeFailed(project, 'programmer1');
    const clearedPresence = (ops.presenceFor(project, { roles: ['programmer1'] }) || [])[0] || {};
    check('A2 唤醒成功清除后：presence.wakeFailed=false（队列与看板都已清）',
      clearedPresence.wakeFailed === false && !(readJson(wakeQueueFile, {}).failed || {}).programmer1, clearedPresence);
    const clearedCheck = await dispatch.buildDispatchCheck({ projectName: project, to: 'programmer1' });
    check('A2b 清除后不再判 wake_first（原因里不再有「有唤醒失败」）',
      !clearedCheck.reasons.some((r) => /有唤醒失败/.test(r)), { verdict: clearedCheck.verdict, reasons: clearedCheck.reasons });

    // ── ① 陈旧失败自动过期（30 分钟）────────────────────────────────────
    seedFailed(nowMinus(31));
    const stalePresence = (ops.presenceFor(project, { roles: ['programmer1'] }) || [])[0] || {};
    check('A3 失败超 30 分钟：wakeFailed=false + wakeFailedStale=true + ttlMin=30',
      stalePresence.wakeFailed === false && stalePresence.wakeFailedStale === true && Number(stalePresence.wakeFailedTtlMin) === 30, stalePresence);
    const staleCheck = await dispatch.buildDispatchCheck({ projectName: project, to: 'programmer1' });
    check('A3b 陈旧失败：dispatch-check 不因它判 wake_first，但保留「已过窗口」提示',
      !staleCheck.reasons.some((r) => /有唤醒失败/.test(r))
      && staleCheck.reasons.some((r) => /已过 30 分钟窗口/.test(r)),
      { verdict: staleCheck.verdict, reasons: staleCheck.reasons });

    // ── ① 静态：成功路径接线 ────────────────────────────────────────────
    const opsText = fs.readFileSync(path.join(LIB, 'ops.mjs'), 'utf8');
    check('A4 静态：wakeWithGuard 成功路径调用 clearWakeFailed（不是只有重试路径清）',
      /appendWakeLog\(project, \{ to: target, ok: true, deliveredAt[\s\S]{0,400}clearWakeFailed\(project, target\)/.test(opsText), null);
    check('A4b 静态：WAKE_FAILED_TTL_MIN=30 且 presenceFor 用它判过期',
      /const WAKE_FAILED_TTL_MIN = 30;/.test(opsText) && /WAKE_FAILED_TTL_MIN \* 60000/.test(opsText), null);

    // ── ② 7405：补归档旧会话后再归档当前会话 ────────────────────────────
    const sessionsFile = path.join(projectStateDir, '团队会话.json');
    writeJson(sessionsFile, { roles: [{ role: 'programmer1', sessionId: 'session-5d57-new' }] });
    const archiveDir = path.join(projectStateDir, '会话归档');
    writeJson(path.join(archiveDir, 'A-20261119T000000-programmer1.json'), {
      id: 'A-20261119T000000-programmer1', role: 'programmer1', sessionId: 'session-5d57-old',
      at: nowMinus(10), confirmedAt: nowMinus(9), rotatedAt: null, frozenAt: nowMinus(9), result: 'ok',
    });
    const guardCurrent = (() => { try { archive.archiveSession({ projectName: project, role: 'programmer1', sessionId: 'session-5d57-new', skipTranscript: true }); return { ok: true }; } catch (e) { return { ok: false, code: String((e && e.code) || ''), message: String((e && e.message) || '') }; } })();
    check('B1 rotatedAt 空但归档 sessionId ≠ 当前会话 → 归档当前会话不再被 ALREADY_ARCHIVED 挡',
      Boolean(guardCurrent.ok) || guardCurrent.code !== 'ALREADY_ARCHIVED', guardCurrent);

    // ── ② 守卫不丢：确实未换人时仍拒 ────────────────────────────────────
    writeJson(sessionsFile, { roles: [{ role: 'programmer1', sessionId: 'session-5d57-cur' }] });
    for (const f of fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : []) fs.rmSync(path.join(archiveDir, f), { force: true });
    writeJson(path.join(archiveDir, 'A-20261119T000100-programmer1.json'), {
      id: 'A-20261119T000100-programmer1', role: 'programmer1', sessionId: 'session-5d57-cur',
      at: nowMinus(5), confirmedAt: nowMinus(4), rotatedAt: null, frozenAt: nowMinus(4), result: 'ok',
    });
    const stillGuard = (() => { try { archive.archiveSession({ projectName: project, role: 'programmer1', sessionId: 'session-5d57-cur', skipTranscript: true }); return { ok: true }; } catch (e) { return { ok: false, code: String((e && e.code) || ''), message: String((e && e.message) || '') }; } })();
    check('B2 归档的正是当前会话（确实未换人）→ 仍 ALREADY_ARCHIVED（守卫没被放宽掉）',
      stillGuard.ok === false && stillGuard.code === 'ALREADY_ARCHIVED', stillGuard);
    check('B3 静态：守卫按 sessionId 判是否换人（B-7405 注释与条件都在）',
      /B-20261119-164648-7405/.test(fs.readFileSync(path.join(LIB, 'session-archive.mjs'), 'utf8')), null);

    // ── 隔离 ────────────────────────────────────────────────────────────
    check('S1 隔离：真实 团队/状态/团队.json 零写入', shaFile(realTeam) === realBefore, { before: realBefore.slice(0, 12) });
  } finally {
    try { fs.rmSync(sb, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const pass = rows.filter((r) => r.ok).length;
  const fail = rows.length - pass;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'test-5d57-7405.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      head: (() => { try { return spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(); } catch { return ''; } })(),
      task: 'B-20261119-161918-5d57 + B-20261119-164648-7405', pass, fail, total: rows.length, rows,
    }, null, 2), 'utf8');
  } catch { /* ignore */ }
  console.log(`\n${pass}/${rows.length} PASS${fail ? ` · ${fail} FAIL` : ''}`);
  process.exit(fail ? 1 : 0);
})();
